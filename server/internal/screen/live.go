package screen

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"opsscreen/internal/gateway"
	"opsscreen/internal/geo"
	"opsscreen/internal/store"
)

// Live mode by replay (spec section 13): the gateway writes a request's row when the request has
// ended, so the service replays each newly finished request with its recorded durations. The
// screen is later than reality by the duration of the request and never shows one still running.

const (
	// liveLag covers the gateway's write delay and one read interval (OS-SR2).
	liveLag = 6 * time.Second
	// liveHistory is what a page receives when it starts (OS-SR6.2).
	liveHistory = 30 * time.Minute
	// liveKeep is how long a finished lifecycle stays in the buffer (OS-SR5).
	liveKeep = 35 * time.Minute
	// liveFirstRead is the range of the first read after a start (OS-SR5).
	liveFirstRead = 45 * time.Minute
	liveMax       = 50000
	// liveMargin is how much later than the service's poll interval a page may be (OS-SR6.5).
	liveMargin = 1500 * time.Millisecond
)

// LiveOptions tune the live reader.
type LiveOptions struct {
	// Interval is the pause between two reads of the gateway.
	Interval time.Duration
	// Window is how far back each read looks for requests it has not seen.
	Window time.Duration
	// Now replaces the clock; tests set it.
	Now func() time.Time
}

type liveRoute struct {
	route int64 // stored route id
	at    int64 // milliseconds after the replay start
}

// lifecycle is one replayed request in the service's own terms; it is rendered for a viewer when
// a page asks.
type lifecycle struct {
	seq      uint64
	id       int64
	start    int64 // replay start, Unix milliseconds
	finest   int64 // finest region of the client address, 0 when unknown
	day      int   // day of the request, for the distinct-client rule
	region   int64 // region shown under that rule, 0 when none
	model    string
	routes   []liveRoute
	hasTTFB  bool
	ttfb     int64
	duration int64
	status   gateway.Status
	code     string
}

// Live reads newly finished requests and answers the page's live requests.
type Live struct {
	reader gateway.LiveReader
	store  *store.Store
	geo    geo.Resolver
	screen *Service
	opts   LiveOptions
	log    *slog.Logger

	// State of the reading goroutine.
	seen      map[string]int64 // row identity -> start of the request, Unix milliseconds
	routes    map[store.RouteKey]int64
	publish   func(day int, region int64) (int64, error)
	refreshed time.Time
	primed    bool
	degraded  bool
	lastError time.Time

	mu      sync.Mutex
	epoch   string
	lastSeq uint64
	lastID  int64
	buffer  []lifecycle // in the order of seq
}

// NewLive returns a live reader for a gateway whose adapter can list recent requests.
func NewLive(reader gateway.LiveReader, st *store.Store, resolver geo.Resolver, screen *Service, opts LiveOptions, log *slog.Logger) *Live {
	if opts.Interval <= 0 {
		opts.Interval = 2 * time.Second
	}
	if opts.Window <= 0 {
		opts.Window = 15 * time.Minute
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	random := make([]byte, 6)
	_, _ = rand.Read(random)
	return &Live{reader: reader, store: st, geo: resolver, screen: screen, opts: opts, log: log, seen: map[string]int64{}, epoch: hex.EncodeToString(random)}
}

// Run reads until ctx ends. A failed read is logged at most once a minute and tried again.
func (l *Live) Run(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if err := l.Poll(ctx); err != nil && ctx.Err() == nil {
			if now := l.opts.Now(); now.Sub(l.lastError) >= time.Minute {
				l.lastError = now
				l.log.Error("cannot read recent requests for live mode", "error", err)
			}
		}
		timer.Reset(l.opts.Interval)
	}
}

// refresh loads what the reader needs from the store: the route ids and the distinct-client
// rule. Both change slowly, so they are loaded every 30 s.
func (l *Live) refresh(now time.Time) error {
	// While the store has no routes yet (the ingest has not read the gateway's Channels), every
	// read looks again, so live mode starts as soon as they are there.
	if len(l.routes) > 0 && now.Sub(l.refreshed) < 30*time.Second && !now.Before(l.refreshed) {
		return nil
	}
	routes, err := l.store.Routes()
	if err != nil {
		return err
	}
	ids := make(map[store.RouteKey]int64, len(routes))
	for _, r := range routes {
		ids[store.RouteKey{Group: r.GroupKey, Channel: r.ChannelKey}] = r.ID
	}
	regions, err := l.store.Regions()
	if err != nil {
		return err
	}
	publish, err := l.screen.publisher(regions)
	if err != nil {
		return err
	}
	l.routes, l.publish, l.refreshed = ids, publish, now
	// The rule's answer for a request can change while it is in the buffer, for example when the
	// ingest has counted today's clients; lifecycles are judged again with every refresh.
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := range l.buffer {
		l.buffer[i].region = l.shown(l.buffer[i].day, l.buffer[i].finest)
	}
	return nil
}

// shown is the region that may be shown for a request of a day from a finest region.
func (l *Live) shown(day int, finest int64) int64 {
	if finest == 0 {
		return 0
	}
	region, err := l.publish(day, finest)
	if err != nil {
		return 0
	}
	return region
}

// routeOf is the stored route of a Channel; a Channel the service does not know is the route of
// Channels that are no longer listed.
func (l *Live) routeOf(ref *gateway.RouteRef) int64 {
	if id, ok := l.routes[store.RouteKey{Group: ref.GroupKey, Channel: ref.ChannelKey}]; ok {
		return id
	}
	return l.routes[store.UnknownRouteKey]
}

// Poll reads the gateway once and adds a lifecycle for every request it had not seen.
func (l *Live) Poll(ctx context.Context) error {
	now := l.opts.Now()
	if err := l.refresh(now); err != nil {
		return err
	}
	if len(l.routes) == 0 {
		// The ingest has not stored the gateway's Channels yet; nothing can be named.
		return nil
	}
	window := l.opts.Window
	if !l.primed && window < liveFirstRead {
		window = liveFirstRead
	}
	var fresh []lifecycle
	err := l.reader.LiveRequests(ctx, now.Add(-window), now.Add(time.Second), func(r *gateway.Request) error {
		if r.ID == "" {
			return nil
		}
		if _, ok := l.seen[r.ID]; ok {
			return nil
		}
		l.seen[r.ID] = r.Start.UnixMilli()
		fresh = append(fresh, l.build(r, now))
		return nil
	})
	if err != nil {
		return err
	}
	if !l.degraded {
		if d, ok := l.reader.(interface{ AttemptsUnavailable() bool }); ok && d.AttemptsUnavailable() {
			l.degraded = true
			l.log.Warn("the gateway database refused to list failed attempts; live mode shows the serving Channel only")
		}
	}
	l.primed = true
	// A row whose start has left the window is never read again.
	forget := now.Add(-l.opts.Window - 5*time.Minute).UnixMilli()
	for id, start := range l.seen {
		if start < forget {
			delete(l.seen, id)
		}
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	for i := range fresh {
		l.lastSeq++
		l.lastID++
		fresh[i].seq, fresh[i].id = l.lastSeq, l.lastID
	}
	l.buffer = append(l.buffer, fresh...)
	cutoff := now.Add(-liveKeep).UnixMilli()
	drop := 0
	for drop < len(l.buffer) && (l.buffer[drop].start+l.buffer[drop].duration < cutoff || len(l.buffer)-drop > liveMax) {
		drop++
	}
	if drop > 0 {
		l.buffer = append([]lifecycle(nil), l.buffer[drop:]...)
	}
	return nil
}

// build turns a finished request into a lifecycle (spec OS-SR2 to OS-SR4).
func (l *Live) build(r *gateway.Request, now time.Time) lifecycle {
	duration := r.DurationMs
	if duration < 0 {
		duration = 0
	}
	start := r.Start.UnixMilli() + duration + liveLag.Milliseconds()
	// A request found by a later read is replayed from now when its row came late; the first
	// read after a start keeps the recorded spacing of what already happened.
	if l.primed && start < now.UnixMilli() {
		start = now.UnixMilli()
	}
	lc := lifecycle{start: start, model: strings.TrimSpace(r.Model), duration: duration, status: r.Status}
	if lc.model == "" {
		lc.model = "-"
	}
	if r.Status == gateway.StatusError {
		lc.code = r.ErrorCode
	}
	if r.HasTTFB {
		lc.hasTTFB, lc.ttfb = true, min(r.TTFBMs, duration)
	}
	// A Channel is selected before its first byte arrives and before the request ends, whatever
	// the recorded durations of the attempts add up to.
	latest := duration
	if lc.hasTTFB {
		latest = lc.ttfb
	}
	var at, last int64
	tried := false
	for _, attempt := range r.Attempts {
		last, tried = l.routeOf(&attempt.Route), true
		lc.routes = append(lc.routes, liveRoute{route: last, at: min(at, latest)})
		at += attempt.DurationMs
	}
	if r.Route != nil {
		// When every attempt failed, the Channel the row names is the last failed attempt.
		if served := l.routeOf(r.Route); !(tried && served == last && r.Status == gateway.StatusError) {
			lc.routes = append(lc.routes, liveRoute{route: served, at: min(at, latest)})
		}
	}
	if addr, ok := geo.ParseAddr(r.ClientIP); ok {
		if place, found := l.geo.Lookup(addr); found {
			if region, err := l.store.EnsureRegion(place); err == nil {
				lc.finest, lc.day = region, l.store.Day(r.Start)
				lc.region = l.shown(lc.day, lc.finest)
			}
		}
	}
	return lc
}

// The events of web/src/core/model.ts.
type (
	startEvent struct {
		Type   string `json:"type"`
		ID     int64  `json:"id"`
		T      int64  `json:"t"`
		Origin string `json:"origin"`
		Model  string `json:"model"`
	}
	routeEvent struct {
		Type  string `json:"type"`
		ID    int64  `json:"id"`
		T     int64  `json:"t"`
		Route int    `json:"route"`
	}
	ttfbEvent struct {
		Type   string `json:"type"`
		ID     int64  `json:"id"`
		T      int64  `json:"t"`
		TTFBMs int64  `json:"ttfbMs"`
	}
	endEvent struct {
		Type       string `json:"type"`
		ID         int64  `json:"id"`
		T          int64  `json:"t"`
		Status     string `json:"status"`
		TTFBMs     *int64 `json:"ttfbMs"`
		DurationMs int64  `json:"durationMs"`
		ErrorCode  string `json:"errorCode,omitempty"`
	}
)

// LiveAnswer is the answer of GET /api/live (spec OS-SR6).
type LiveAnswer struct {
	Version string `json:"version"`
	Now     int64  `json:"now"`
	PollMs  int64  `json:"pollMs"`
	DelayMs int64  `json:"delayMs"`
	Cursor  string `json:"cursor"`
	Reset   bool   `json:"reset"`
	Events  []any  `json:"events"`
}

var statusName = map[gateway.Status]string{gateway.StatusSuccess: "success", gateway.StatusError: "error", gateway.StatusClientGone: "client_gone"}

// position reads a cursor. It reports false when the service cannot continue from it: it is
// empty or malformed, it is of another run, or the buffer no longer reaches back to it.
func (l *Live) position(cursor string) (uint64, bool) {
	epoch, number, ok := strings.Cut(cursor, ".")
	if !ok || epoch != l.epoch {
		return 0, false
	}
	seq, err := strconv.ParseUint(number, 10, 64)
	if err != nil || seq > l.lastSeq {
		return 0, false
	}
	if len(l.buffer) > 0 && seq+1 < l.buffer[0].seq {
		return 0, false
	}
	if len(l.buffer) == 0 && seq != l.lastSeq {
		return 0, false
	}
	return seq, true
}

// Answer returns the live events for a viewer after a cursor, rendered with the indices and ids
// of that viewer's topology.
func (l *Live) Answer(ctx context.Context, viewer Viewer, after string) (*LiveAnswer, error) {
	view, err := l.screen.View(ctx, viewer)
	if err != nil {
		return nil, err
	}
	now := l.opts.Now().UnixMilli()
	l.mu.Lock()
	defer l.mu.Unlock()
	answer := &LiveAnswer{
		Version: view.Version,
		Now:     now,
		PollMs:  l.opts.Interval.Milliseconds(),
		DelayMs: (l.opts.Interval + liveMargin).Milliseconds(),
		Cursor:  l.epoch + "." + strconv.FormatUint(l.lastSeq, 10),
		Events:  []any{},
	}
	from, ok := l.position(after)
	answer.Reset = !ok
	history := now - liveHistory.Milliseconds()
	for i := range l.buffer {
		lc := &l.buffer[i]
		if answer.Reset {
			if lc.start+lc.duration < history {
				continue
			}
		} else if lc.seq <= from {
			continue
		}
		answer.Events = append(answer.Events, startEvent{Type: "start", ID: lc.id, T: lc.start, Origin: view.originID[lc.region], Model: lc.model})
		for _, hop := range lc.routes {
			// A route that is newer than the viewer's topology cannot be named yet.
			if index, known := view.routeIndex[hop.route]; known && index >= 0 {
				answer.Events = append(answer.Events, routeEvent{Type: "route", ID: lc.id, T: lc.start + hop.at, Route: index})
			}
		}
		end := endEvent{Type: "end", ID: lc.id, T: lc.start + lc.duration, Status: statusName[lc.status], DurationMs: lc.duration, ErrorCode: lc.code}
		if lc.hasTTFB {
			ttfb := lc.ttfb
			end.TTFBMs = &ttfb
			answer.Events = append(answer.Events, ttfbEvent{Type: "ttfb", ID: lc.id, T: lc.start + lc.ttfb, TTFBMs: lc.ttfb})
		}
		answer.Events = append(answer.Events, end)
	}
	return answer, nil
}
