// Package ingest turns the gateway's request log into the service's rollups.
//
// Its one operation is "compute the rollups of a time range again from the gateway and replace
// them". Backfill applies it to past days; the follow loop applies it to the last minutes. A
// gateway may write the row of a request long after the request began (LynShen writes it at the
// end, stamped with the start time), so a cursor that only moves forward would miss rows; a
// replaced range cannot miss or double-count one.
package ingest

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"log/slog"
	"net/netip"
	"strings"
	"sync/atomic"
	"time"

	"request-monitor/internal/gateway"
	"request-monitor/internal/geo"
	"request-monitor/internal/hist"
	"request-monitor/internal/store"
)

// Options tune the ingestor.
type Options struct {
	// BackfillDays is how many past days are read on first start.
	BackfillDays int
	// Lookback is how far back the follow loop recomputes. A request that runs longer than this
	// is counted only if its row appears before its start time leaves the window.
	Lookback time.Duration
	// Interval is the pause between two follow passes.
	Interval time.Duration
	// RetentionDays is how long rollups are kept.
	RetentionDays int
	// Now replaces the clock; tests set it.
	Now func() time.Time
}

// Ingestor reads one gateway into one store.
type Ingestor struct {
	adapter gateway.Adapter
	store   *store.Store
	geo     geo.Resolver
	opts    Options
	log     *slog.Logger
	now     func() time.Time
	// OnChannels, when set, is called with the gateway's Channels each time they were read.
	OnChannels func(ctx context.Context, channels []gateway.Channel)

	routes   map[store.RouteKey]int64
	places   map[netip.Addr]int64 // address -> region id (0: unknown); cleared on every pass
	salts    map[int][]byte
	gen      atomic.Uint64
	backfill atomic.Bool
}

func New(adapter gateway.Adapter, st *store.Store, resolver geo.Resolver, opts Options, log *slog.Logger) *Ingestor {
	if opts.BackfillDays <= 0 {
		opts.BackfillDays = 30
	}
	if opts.Lookback <= 0 {
		opts.Lookback = 90 * time.Minute
	}
	if opts.Interval <= 0 {
		opts.Interval = 30 * time.Second
	}
	if opts.RetentionDays < opts.BackfillDays+5 {
		opts.RetentionDays = opts.BackfillDays + 5
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Ingestor{adapter: adapter, store: st, geo: resolver, opts: opts, log: log, now: opts.Now, salts: map[int][]byte{}}
}

// Generation changes whenever the rollups changed; readers use it to drop cached answers.
func (in *Ingestor) Generation() uint64 { return in.gen.Load() }

// Backfilling reports whether the first read of past days is still running.
func (in *Ingestor) Backfilling() bool { return in.backfill.Load() }

// SyncChannels stores the gateway's current Channels and returns them.
func (in *Ingestor) SyncChannels(ctx context.Context) ([]gateway.Channel, error) {
	channels, err := in.adapter.Channels(ctx)
	if err != nil {
		return nil, err
	}
	routes, err := in.store.SyncRoutes(channels)
	if err != nil {
		return nil, err
	}
	in.routes = routes
	if in.OnChannels != nil {
		in.OnChannels(ctx, channels)
	}
	in.gen.Add(1)
	return channels, nil
}

func (in *Ingestor) routeOf(ref *gateway.RouteRef) int64 {
	if ref == nil {
		return store.RejectedRoute
	}
	if id, ok := in.routes[store.RouteKey{Group: ref.GroupKey, Channel: ref.ChannelKey}]; ok {
		return id
	}
	return in.routes[store.UnknownRouteKey]
}

// fingerprint is a keyed hash of a client address. The key is random per day and deleted when
// the day is finalized, so a fingerprint cannot be turned back into an address.
func fingerprint(salt []byte, addr netip.Addr) int64 {
	mac := hmac.New(sha256.New, salt)
	mac.Write(addr.AsSlice())
	return int64(binary.BigEndian.Uint64(mac.Sum(nil)[:8]))
}

func (in *Ingestor) salt(day int) ([]byte, error) {
	if salt, ok := in.salts[day]; ok {
		return salt, nil
	}
	salt, err := in.store.Salt(day)
	if err != nil {
		return nil, err
	}
	in.salts[day] = salt
	return salt, nil
}

// Recompute replaces the rollups of [from, to) with what the gateway holds now. from and to are
// rounded outward to bucket boundaries.
func (in *Ingestor) Recompute(ctx context.Context, from, to time.Time) (int64, error) {
	if in.routes == nil {
		if _, err := in.SyncChannels(ctx); err != nil {
			return 0, err
		}
	}
	fromBucket := store.Bucket(from)
	toBucket := store.Bucket(to.Add(store.BucketSeconds*time.Second - time.Nanosecond))
	from, to = store.BucketStart(fromBucket), store.BucketStart(toBucket)
	agg := store.NewAggregate()
	in.places = map[netip.Addr]int64{}
	var count int64
	err := in.adapter.Requests(ctx, from, to, func(req *gateway.Request) error {
		count++
		bucket := store.Bucket(req.Start)
		route := in.routeOf(req.Route)
		agg.Route[store.RouteCell{Bucket: bucket, Route: route, Status: req.Status}]++

		model := strings.TrimSpace(req.Model)
		if model == "" {
			model = "-"
		}
		modelID, err := in.store.EnsureModel(model)
		if err != nil {
			return err
		}
		agg.Model[store.ModelCell{Bucket: bucket, Model: modelID}]++

		if req.HasTTFB && req.Status == gateway.StatusSuccess {
			cell := store.TTFBCell{Bucket: bucket, Route: route}
			h := agg.TTFB[cell]
			if h == nil {
				h = &hist.H{}
				agg.TTFB[cell] = h
			}
			h.Add(req.TTFBMs)
		}

		addr, ok := geo.ParseAddr(req.ClientIP)
		if !ok {
			return nil
		}
		region, known := in.places[addr]
		if !known {
			if place, found := in.geo.Lookup(addr); found {
				if region, err = in.store.EnsureRegion(place); err != nil {
					return err
				}
			}
			in.places[addr] = region
		}
		if region == 0 {
			return nil
		}
		agg.Origin[store.OriginCell{Bucket: bucket, Region: region}]++
		day := in.store.Day(req.Start)
		salt, err := in.salt(day)
		if err != nil {
			return err
		}
		cell := store.ClientCell{Day: day, Region: region}
		set := agg.Clients[cell]
		if set == nil {
			set = map[int64]struct{}{}
			agg.Clients[cell] = set
		}
		set[fingerprint(salt, addr)] = struct{}{}
		return nil
	})
	in.places = nil
	if err != nil {
		return 0, fmt.Errorf("ingest: read %s to %s: %w", from.Format(time.RFC3339), to.Format(time.RFC3339), err)
	}
	if err := in.store.ReplaceRange(fromBucket, toBucket, agg); err != nil {
		return 0, err
	}
	in.gen.Add(1)
	return count, nil
}

func doneKey(day int) string { return fmt.Sprintf("done:%d", day) }

// finalizeAfter is how long after the end of a day its client counts become final: no follow
// pass reaches back into the day any more.
func (in *Ingestor) finalizeAfter() time.Duration { return in.opts.Lookback + 10*time.Minute }

// Backfill reads every past day of the window that has not been read yet, oldest first. A day
// that is long over is finalized at once; the others are left to the follow loop.
func (in *Ingestor) Backfill(ctx context.Context) error {
	in.backfill.Store(true)
	defer in.backfill.Store(false)
	now := in.now()
	today := in.store.Day(now)
	todayStart, _ := in.store.DayRange(today)
	for back := in.opts.BackfillDays; back >= 1; back-- {
		day := in.store.Day(todayStart.AddDate(0, 0, -back))
		if _, done, err := in.store.Meta(doneKey(day)); err != nil {
			return err
		} else if done {
			continue
		}
		start, end := in.store.DayRange(day)
		if err := in.store.ResetDay(day); err != nil {
			return err
		}
		delete(in.salts, day)
		n, err := in.Recompute(ctx, start, end)
		if err != nil {
			return err
		}
		if now.After(end.Add(in.finalizeAfter())) {
			if err := in.store.FinalizeDay(day); err != nil {
				return err
			}
			delete(in.salts, day)
		}
		if err := in.store.SetMeta(doneKey(day), "1"); err != nil {
			return err
		}
		in.gen.Add(1)
		in.log.Info("backfilled a day", "day", day, "requests", n)
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	// Today so far.
	if _, err := in.Recompute(ctx, todayStart, now); err != nil {
		return err
	}
	return nil
}

// FollowOnce recomputes the lookback window, finalizes days that are over, and prunes old rows.
func (in *Ingestor) FollowOnce(ctx context.Context) error {
	now := in.now()
	if _, err := in.Recompute(ctx, now.Add(-in.opts.Lookback), now); err != nil {
		return err
	}
	today := in.store.Day(now)
	for day, checked := in.store.PrevDay(today), 0; checked < 3; day, checked = in.store.PrevDay(day), checked+1 {
		final, err := in.store.DayFinal(day)
		if err != nil {
			return err
		}
		if final {
			break
		}
		_, end := in.store.DayRange(day)
		if now.After(end.Add(in.finalizeAfter())) {
			if err := in.store.FinalizeDay(day); err != nil {
				return err
			}
			delete(in.salts, day)
			// The day is complete: a restart need not read it again.
			if err := in.store.SetMeta(doneKey(day), "1"); err != nil {
				return err
			}
			in.gen.Add(1)
		}
	}
	todayStart, _ := in.store.DayRange(today)
	keepFrom := todayStart.AddDate(0, 0, -in.opts.RetentionDays)
	return in.store.Prune(store.Bucket(keepFrom), in.store.Day(keepFrom))
}

// Run backfills, then follows until ctx ends. A failed pass is logged and tried again; the
// service keeps serving what it has.
func (in *Ingestor) Run(ctx context.Context) {
	for {
		if _, err := in.SyncChannels(ctx); err != nil {
			in.log.Error("cannot read the gateway's channels; retrying", "error", err)
		} else if err := in.Backfill(ctx); err != nil {
			in.log.Error("backfill failed; retrying", "error", err)
		} else {
			break
		}
		if !sleep(ctx, in.opts.Interval) {
			return
		}
	}
	lastChannels := in.now()
	for sleep(ctx, in.opts.Interval) {
		if in.now().Sub(lastChannels) >= 5*time.Minute {
			if _, err := in.SyncChannels(ctx); err != nil {
				in.log.Error("cannot read the gateway's channels", "error", err)
			}
			lastChannels = in.now()
		}
		if err := in.FollowOnce(ctx); err != nil {
			in.log.Error("follow pass failed", "error", err)
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
