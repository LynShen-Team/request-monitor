package screen

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/LynShen-Team/request-monitor/internal/gateway"
	"github.com/LynShen-Team/request-monitor/internal/hist"
	"github.com/LynShen-Team/request-monitor/internal/store"
)

// Windows of the replay (spec OS-D4): fine buckets per step, and steps per window.
var windows = map[string]struct{ per, count int64 }{
	"24h": {1, 288},
	"7d":  {6, 336},
	"30d": {24, 360},
}

// ValidWindow reports whether name is a replay window.
func ValidWindow(name string) bool { _, ok := windows[name]; return ok }

const (
	maxModels  = 14
	otherModel = "其他模型"
)

// Options configure the builder.
type Options struct {
	// Gateway is where the gateway itself is, for the map.
	Gateway Site
	// MinClients is the number of distinct clients a region needs in a day to be shown
	// (spec OS-B3). A region below it counts toward its parent.
	MinClients int
	// MaxAge is how long a built answer may be served although the rollups changed since.
	MaxAge time.Duration
	// Now replaces the clock; tests set it.
	Now func() time.Time
}

// Service answers topology and replay requests from the store.
type Service struct {
	store *store.Store
	opts  Options
	// generation changes when the rollups changed.
	generation func() uint64
	now        func() time.Time

	mu       sync.Mutex
	snapshot *snapshot
}

func New(st *store.Store, opts Options, generation func() uint64) *Service {
	if opts.MinClients < 1 {
		opts.MinClients = 3
	}
	if opts.MaxAge <= 0 {
		opts.MaxAge = 20 * time.Second
	}
	if opts.Gateway.ID == "" {
		opts.Gateway.ID = "gw"
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{store: st, opts: opts, generation: generation, now: opts.Now}
}

// View is everything one class of viewer receives.
type View struct {
	Version  string
	Topology Topology
	Baseline Baseline
	Replay   map[string]*ReplayData

	// routeIndex maps a stored route id to its index in Topology.Routes, and originID a stored
	// region id to its id in Topology.Origins; live events are rendered with them.
	routeIndex map[int64]int
	originID   map[int64]string
}

type snapshot struct {
	generation uint64
	builtAt    time.Time
	views      [2]*View
}

// View returns the current answer for a viewer, building it when the rollups changed.
func (s *Service) View(ctx context.Context, viewer Viewer) (*View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	gen := s.generation()
	now := s.now()
	if snap := s.snapshot; snap != nil {
		age := now.Sub(snap.builtAt)
		// Rollups change every follow pass; an answer a few seconds old is still served, so a
		// burst of requests costs one build.
		if (snap.generation == gen && age < 10*time.Minute) || age < s.opts.MaxAge {
			return snap.views[viewer], nil
		}
	}
	snap, err := s.build(ctx, now)
	if err != nil {
		return nil, err
	}
	snap.generation = gen
	s.snapshot = snap
	return snap.views[viewer], nil
}

type routeCount struct {
	route  int64
	status gateway.Status
	n      int64
}

type idCount struct{ id, n int64 }

// fine is one 5-minute bucket as loaded from the store.
type fine struct {
	routes  []routeCount
	origins []idCount // region id after the publish rule
	models  []idCount
	ttfb    *hist.H
}

func (s *Service) build(ctx context.Context, now time.Time) (*snapshot, error) {
	// The bucket that contains now is partial and is left out.
	end := store.Bucket(now)
	start := end
	for _, w := range windows {
		if first := end - end%w.per - w.per*w.count; first < start {
			start = first
		}
	}
	buckets := make([]fine, end-start)

	routes, err := s.store.Routes()
	if err != nil {
		return nil, err
	}
	sites, err := s.store.Sites()
	if err != nil {
		return nil, err
	}
	regions, err := s.store.Regions()
	if err != nil {
		return nil, err
	}
	modelNames, err := s.store.Models()
	if err != nil {
		return nil, err
	}

	if err := s.store.EachRoute(ctx, start, end, func(bucket, route int64, status gateway.Status, n int64) {
		f := &buckets[bucket-start]
		f.routes = append(f.routes, routeCount{route, status, n})
	}); err != nil {
		return nil, err
	}
	modelTotal := map[int64]int64{}
	if err := s.store.EachModel(ctx, start, end, func(bucket, model, n int64) {
		f := &buckets[bucket-start]
		f.models = append(f.models, idCount{model, n})
		modelTotal[model] += n
	}); err != nil {
		return nil, err
	}
	if err := s.store.EachTTFB(ctx, start, end, func(bucket, _ int64, h *hist.H) {
		f := &buckets[bucket-start]
		if f.ttfb == nil {
			f.ttfb = &hist.H{}
		}
		f.ttfb.Merge(h)
	}); err != nil {
		return nil, err
	}

	// Origins: every count is moved to the region that may be shown for its day.
	type rawOrigin struct{ bucket, region, n int64 }
	var raw []rawOrigin
	if err := s.store.EachOrigin(ctx, start, end, func(bucket, region, n int64) {
		raw = append(raw, rawOrigin{bucket, region, n})
	}); err != nil {
		return nil, err
	}
	publish, err := s.publisher(regions)
	if err != nil {
		return nil, err
	}
	originTotal := map[int64]int64{}
	// A province or a country is drawn at the mean position of ALL its requests of the range,
	// weighted by count. Using every request, not only those of the cities that were folded into
	// it, keeps the position from pointing at one small city.
	type centroid struct{ lat, lon, w float64 }
	centroids := map[int64]*centroid{}
	for _, row := range raw {
		src := regions[row.region]
		for id, hops := src.Parent, 0; id != 0 && hops < 3; id, hops = regions[id].Parent, hops+1 {
			c := centroids[id]
			if c == nil {
				c = &centroid{}
				centroids[id] = c
			}
			c.lat += src.Lat * float64(row.n)
			c.lon += src.Lon * float64(row.n)
			c.w += float64(row.n)
		}
		day := s.store.Day(store.BucketStart(row.bucket))
		target, err := publish(day, row.region)
		if err != nil {
			return nil, err
		}
		if target == 0 {
			continue
		}
		f := &buckets[row.bucket-start]
		f.origins = append(f.origins, idCount{target, row.n})
		originTotal[target] += row.n
	}

	// Origin list, in the order in which the service first saw the regions, so that an origin
	// keeps its place while others come and go (spec OS-SV5); the same for every viewer.
	originIDs := make([]int64, 0, len(originTotal))
	for id := range originTotal {
		originIDs = append(originIDs, id)
	}
	sort.Slice(originIDs, func(i, j int) bool { return originIDs[i] < originIDs[j] })
	originIndex := make(map[int64]int, len(originIDs))
	originID := make(map[int64]string, len(originIDs))
	origins := make([]Site, 0, len(originIDs))
	for i, id := range originIDs {
		originIndex[id] = i
		originID[id] = "r" + strconv.FormatInt(id, 10)
		region := regions[id]
		site := Site{ID: "r" + strconv.FormatInt(id, 10), Name: region.Name, Region: regionLabel(regions, region), Lat: region.Lat, Lon: region.Lon}
		if c := centroids[id]; c != nil && c.w > 0 && region.Level != store.LevelCity {
			site.Lat, site.Lon = c.lat/c.w, c.lon/c.w
		}
		origins = append(origins, site)
	}

	// Model list: the busiest models of the whole range, then one entry for all the others.
	modelIDs := make([]int64, 0, len(modelTotal))
	for id := range modelTotal {
		modelIDs = append(modelIDs, id)
	}
	sort.Slice(modelIDs, func(i, j int) bool {
		if modelTotal[modelIDs[i]] != modelTotal[modelIDs[j]] {
			return modelTotal[modelIDs[i]] > modelTotal[modelIDs[j]]
		}
		return modelIDs[i] < modelIDs[j]
	})
	modelIndex := make(map[int64]int, len(modelIDs))
	var models []string
	for i, id := range modelIDs {
		if i < maxModels {
			modelIndex[id] = i
			models = append(models, modelNames[id])
		} else {
			modelIndex[id] = maxModels
		}
	}
	if len(modelIDs) > maxModels {
		models = append(models, otherModel)
	}
	if models == nil {
		models = []string{}
	}

	snap := &snapshot{builtAt: now}
	for _, viewer := range []Viewer{Restricted, Admin} {
		topology, routeIndex := s.topology(viewer, routes, sites, origins)
		view := &View{Topology: topology, Replay: map[string]*ReplayData{}, routeIndex: routeIndex, originID: originID}
		for name, w := range windows {
			first := end - end%w.per - w.per*w.count
			data := &ReplayData{
				Window:  name,
				Start:   store.BucketStart(first).UnixMilli(),
				End:     store.BucketStart(first + w.per*w.count).UnixMilli(),
				StepMs:  w.per * store.BucketSeconds * 1000,
				Models:  models,
				Buckets: make([]ReplayBucket, w.count),
			}
			for i := int64(0); i < w.count; i++ {
				data.Buckets[i] = mergeBuckets(buckets[first+i*w.per-start:first+(i+1)*w.per-start], store.BucketStart(first+i*w.per).UnixMilli(), routeIndex, originIndex, len(origins), modelIndex, len(models))
			}
			view.Replay[name] = data
		}
		for _, b := range view.Replay["24h"].Buckets {
			view.Baseline.Total += b.Total
			view.Baseline.Errors += b.Errors
		}
		version, err := versionOf(topology)
		if err != nil {
			return nil, err
		}
		view.Version = version
		snap.views[viewer] = view
	}
	return snap, nil
}

// versionOf names what the indices and ids of a topology mean (spec OS-SH4): the routes in order,
// the ids of the upstream sites, and the ids of the origins in order. A coordinate or a channel
// count is not part of it, so a page keeps its topology while those drift.
func versionOf(topology Topology) (string, error) {
	identity := struct {
		Routes    []RouteInfo
		Upstreams []string
		Origins   []string
	}{Routes: topology.Routes}
	for _, site := range topology.Upstreams {
		identity.Upstreams = append(identity.Upstreams, site.ID)
	}
	for _, origin := range topology.Origins {
		identity.Origins = append(identity.Origins, origin.ID)
	}
	encoded, err := json.Marshal(identity)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:8]), nil
}

// mergeBuckets sums fine buckets into one replay bucket, with indices of one viewer's topology.
func mergeBuckets(parts []fine, t0 int64, routeIndex map[int64]int, originIndex map[int64]int, originCount int, modelIndex map[int64]int, modelCount int) ReplayBucket {
	out := ReplayBucket{T0: t0, Origins: make([]int64, originCount), Models: make([]int64, modelCount)}
	type pair struct{ n, errors int64 }
	perRoute := map[int]*pair{}
	var merged hist.H
	for i := range parts {
		f := &parts[i]
		for _, row := range f.routes {
			out.Total += row.n
			index, ok := routeIndex[row.route]
			if !ok {
				// A route that is not in this topology cannot be named; its requests still count
				// in the totals.
				if row.status == gateway.StatusError {
					out.Errors += row.n
				}
				continue
			}
			p := perRoute[index]
			if p == nil {
				p = &pair{}
				perRoute[index] = p
			}
			p.n += row.n
			if row.status == gateway.StatusError {
				p.errors += row.n
				out.Errors += row.n
			}
		}
		for _, row := range f.origins {
			out.Origins[originIndex[row.id]] += row.n
		}
		for _, row := range f.models {
			out.Models[modelIndex[row.id]] += row.n
		}
		if f.ttfb != nil {
			merged.Merge(f.ttfb)
		}
	}
	indices := make([]int, 0, len(perRoute))
	for index := range perRoute {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	out.Routes = make([]int64, 0, len(indices)*3)
	for _, index := range indices {
		out.Routes = append(out.Routes, int64(index), perRoute[index].n, perRoute[index].errors)
	}
	out.TTFBP50 = float64(int64(merged.Quantile(0.5) + 0.5))
	return out
}

// topology builds the route and upstream lists of one viewer and maps each stored route id to its
// index. For a restricted viewer every restricted Group is one route that carries the Group name
// only: no Channel name, no Channel key, and no upstream site leave the service for it, and a
// site that only restricted routes use is not listed at all.
func (s *Service) topology(viewer Viewer, routes []store.Route, sites map[int64]store.Site, origins []Site) (Topology, map[int64]int) {
	topology := Topology{Gateway: s.opts.Gateway, Upstreams: []UpstreamSite{}, Origins: origins, Routes: []RouteInfo{}}
	routeIndex := map[int64]int{store.RejectedRoute: -1}
	siteChannels := map[int64]int{}
	mergedGroup := map[string]int{}
	for _, route := range routes {
		if viewer != Admin && route.Restricted {
			index, ok := mergedGroup[route.GroupKey]
			if !ok {
				index = len(topology.Routes)
				mergedGroup[route.GroupKey] = index
				topology.Routes = append(topology.Routes, RouteInfo{Group: route.GroupName, Channel: "", Upstream: nil, Restricted: true})
			}
			routeIndex[route.ID] = index
			continue
		}
		info := RouteInfo{Group: route.GroupName, Channel: route.ChannelName, Restricted: route.Restricted}
		if _, ok := sites[route.Site]; ok && route.Site != 0 {
			id := siteID(route.Site)
			info.Upstream = &id
			siteChannels[route.Site]++
		}
		routeIndex[route.ID] = len(topology.Routes)
		topology.Routes = append(topology.Routes, info)
	}
	siteIDs := make([]int64, 0, len(siteChannels))
	for id := range siteChannels {
		siteIDs = append(siteIDs, id)
	}
	sort.Slice(siteIDs, func(i, j int) bool { return siteIDs[i] < siteIDs[j] })
	for _, id := range siteIDs {
		site := sites[id]
		topology.Upstreams = append(topology.Upstreams, UpstreamSite{
			Site:     Site{ID: siteID(id), Name: site.Name, Region: site.Region, Lat: site.Lat, Lon: site.Lon},
			Anycast:  site.Anycast,
			Channels: siteChannels[id],
		})
	}
	return topology, routeIndex
}

func siteID(id int64) string { return "s" + strconv.FormatInt(id, 10) }

// regionLabel is the line under a region's name: the country, and the province for a city.
func regionLabel(regions map[int64]store.Region, region store.Region) string {
	var parts []string
	for id, hops := region.Parent, 0; id != 0 && hops < 3; id, hops = regions[id].Parent, hops+1 {
		parts = append([]string{regions[id].Name}, parts...)
	}
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	default:
		return fmt.Sprintf("%s · %s", parts[0], parts[len(parts)-1])
	}
}

// publisher returns the rule of spec OS-B3: the region that may be shown for a day and a region
// is the region itself when at least MinClients distinct clients used it that day, otherwise the
// nearest ancestor that reaches MinClients, otherwise none (0).
//
// "That day" is a calendar day in the store's time zone. A day that is not over yet would start
// every region at zero each midnight, so until a day is final a region also passes when it
// passed on the day before.
func (s *Service) publisher(regions map[int64]store.Region) (func(day int, region int64) (int64, error), error) {
	counts := map[int]map[int64]int{}
	load := func(day int) (map[int64]int, error) {
		if c, ok := counts[day]; ok {
			return c, nil
		}
		c, err := s.store.ClientCounts(day)
		if err != nil {
			return nil, err
		}
		final, err := s.store.DayFinal(day)
		if err != nil {
			return nil, err
		}
		if !final {
			previous, err := s.store.ClientCounts(s.store.PrevDay(day))
			if err != nil {
				return nil, err
			}
			for region, n := range previous {
				if n > c[region] {
					c[region] = n
				}
			}
		}
		counts[day] = c
		return c, nil
	}
	return func(day int, region int64) (int64, error) {
		c, err := load(day)
		if err != nil {
			return 0, err
		}
		for id, hops := region, 0; id != 0 && hops < 4; id, hops = regions[id].Parent, hops+1 {
			if c[id] >= s.opts.MinClients {
				return id, nil
			}
		}
		return 0, nil
	}, nil
}
