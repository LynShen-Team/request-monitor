package screen_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"sort"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/LynShen-Team/request-monitor/internal/devseed"
	"github.com/LynShen-Team/request-monitor/internal/gateway/lynshen"
	"github.com/LynShen-Team/request-monitor/internal/screen"
	"github.com/LynShen-Team/request-monitor/internal/store"
	"github.com/LynShen-Team/request-monitor/internal/testenv"
)

// liveEvent is any event of web/src/core/model.ts.
type liveEvent struct {
	Type       string
	ID         int64
	T          int64
	Origin     *string
	Model      string
	Route      *int
	TTFBMs     *int64 `json:"ttfbMs"`
	Status     string
	DurationMs *int64 `json:"durationMs"`
	ErrorCode  string `json:"errorCode"`
}

type liveAnswer struct {
	Version string
	Now     int64
	PollMs  int64 `json:"pollMs"`
	DelayMs int64 `json:"delayMs"`
	Cursor  string
	Reset   bool
	Events  []liveEvent
}

// ask calls Answer and reads it back the way a page would, from JSON.
func ask(t *testing.T, live *screen.Live, viewer screen.Viewer, after string) (liveAnswer, []byte) {
	t.Helper()
	answer, err := live.Answer(context.Background(), viewer, after)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	var parsed liveAnswer
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed, raw
}

// lifecycles groups the events of an answer by request and checks the shape of each lifecycle
// (docs/spec-screen.md OS-D2) against the viewer's topology.
func lifecycles(t *testing.T, answer liveAnswer, topology screen.Topology) [][]liveEvent {
	t.Helper()
	origins := map[string]bool{"": true}
	for _, origin := range topology.Origins {
		origins[origin.ID] = true
	}
	var order []int64
	byID := map[int64][]liveEvent{}
	for _, event := range answer.Events {
		if _, ok := byID[event.ID]; !ok {
			order = append(order, event.ID)
		}
		byID[event.ID] = append(byID[event.ID], event)
	}
	out := make([][]liveEvent, 0, len(order))
	for _, id := range order {
		events := byID[id]
		first, last := events[0], events[len(events)-1]
		if first.Type != "start" || last.Type != "end" || first.Origin == nil || !origins[*first.Origin] || first.Model == "" {
			t.Fatalf("lifecycle %d: starts with %+v and ends with %+v", id, first, last)
		}
		if last.DurationMs == nil || last.T-first.T != *last.DurationMs || (last.Status != "success" && last.Status != "error" && last.Status != "client_gone") {
			t.Fatalf("lifecycle %d: end %+v after a start at %d", id, last, first.T)
		}
		if (last.Status == "error") != (last.ErrorCode != "") {
			t.Fatalf("lifecycle %d: status %q with error code %q", id, last.Status, last.ErrorCode)
		}
		var ttfb *liveEvent
		var lastRoute int64
		for i := 1; i < len(events)-1; i++ {
			event := events[i]
			if event.T < first.T || event.T > last.T {
				t.Fatalf("lifecycle %d: %s event at %d is outside %d..%d", id, event.Type, event.T, first.T, last.T)
			}
			switch event.Type {
			case "route":
				if event.Route == nil || *event.Route < 0 || *event.Route >= len(topology.Routes) {
					t.Fatalf("lifecycle %d: route %v is not in the topology", id, event.Route)
				}
				if ttfb != nil || event.T < lastRoute {
					t.Fatalf("lifecycle %d: a route event after the ttfb event or before an earlier route", id)
				}
				lastRoute = event.T
			case "ttfb":
				if ttfb != nil || event.TTFBMs == nil || event.T-first.T != *event.TTFBMs || event.T < lastRoute {
					t.Fatalf("lifecycle %d: ttfb event %+v", id, event)
				}
				ttfb = &events[i]
			default:
				t.Fatalf("lifecycle %d: a %q event in the middle", id, event.Type)
			}
		}
		if (ttfb == nil) != (last.TTFBMs == nil) || (ttfb != nil && *ttfb.TTFBMs != *last.TTFBMs) {
			t.Fatalf("lifecycle %d: the end event's ttfbMs does not match the ttfb event", id)
		}
		out = append(out, events)
	}
	return out
}

func routesOf(events []liveEvent) []int {
	var out []int
	for _, event := range events {
		if event.Type == "route" {
			out = append(out, *event.Route)
		}
	}
	return out
}

func newLive(env *testenv.Env, clock *time.Time) *screen.Live {
	return screen.NewLive(env.Adapter, env.Store, env.Geo, env.Screen, screen.LiveOptions{Now: func() time.Time { return *clock }}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestLiveWarmUp(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	ctx := context.Background()
	clock := testenv.Now
	live := newLive(env, &clock)
	if err := live.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	admin, err := env.Screen.View(ctx, screen.Admin)
	if err != nil {
		t.Fatal(err)
	}
	restricted, _ := env.Screen.View(ctx, screen.Restricted)

	answer, raw := ask(t, live, screen.Admin, "")
	if !answer.Reset || answer.Version != admin.Version || answer.Now != clock.UnixMilli() || answer.PollMs != 2000 || answer.DelayMs != 3500 || answer.Cursor == "" {
		t.Fatalf("answer header: %+v", answer)
	}
	assertClean(t, "the admin live answer", raw)
	all := lifecycles(t, answer, admin.Topology)

	// The warm-up set is every request of the first read whose replay ends within the last 30
	// minutes, each replayed from 6 s after its real end.
	source, err := sql.Open("sqlite", "file:"+filepath.Join(env.Dir, devseed.GatewayFile)+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	now := clock.UnixMilli()
	rows, err := source.Query(`SELECT created_at_unix_ms + COALESCE(duration_ms, 0) + 6000 FROM request_logs
WHERE request_kind IS NULL AND created_at_unix_ms >= ? AND created_at_unix_ms < ?
  AND created_at_unix_ms + 2 * COALESCE(duration_ms, 0) + 6000 >= ?`, now-45*60_000, now+1000, now-30*60_000)
	if err != nil {
		t.Fatal(err)
	}
	var want []int64
	for rows.Next() {
		var start int64
		if err := rows.Scan(&start); err != nil {
			t.Fatal(err)
		}
		want = append(want, start)
	}
	rows.Close()
	got := make([]int64, 0, len(all))
	for _, events := range all {
		got = append(got, events[0].T)
	}
	sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
	if len(want) < 100 || fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("%d lifecycles, the gateway has %d requests for the same range (or their replay starts differ)", len(got), len(want))
	}

	var failovers, unplaced int
	for _, events := range all {
		if len(routesOf(events)) >= 2 {
			failovers++
		}
		if *events[0].Origin == "" {
			unplaced++
		}
	}
	if failovers == 0 {
		t.Error("no lifecycle shows a failed attempt before the serving Channel")
	}
	if unplaced == 0 || unplaced > len(all)/10 {
		t.Errorf("%d of %d lifecycles have no shown region; expected a few", unplaced, len(all))
	}

	// The restricted view: the same lifecycles, with indices of its own topology.
	limited, raw := ask(t, live, screen.Restricted, "")
	assertClean(t, "the restricted live answer", raw)
	if limited.Version != restricted.Version || limited.Version == answer.Version {
		t.Fatalf("restricted version %q, view %q, admin %q", limited.Version, restricted.Version, answer.Version)
	}
	if merged := lifecycles(t, limited, restricted.Topology); len(merged) != len(all) {
		t.Fatalf("the restricted view has %d lifecycles, the admin view %d", len(merged), len(all))
	}

	// Nothing new: an answer after the cursor is empty, and it is not a reset.
	next, _ := ask(t, live, screen.Admin, answer.Cursor)
	if next.Reset || len(next.Events) != 0 || next.Cursor != answer.Cursor {
		t.Fatalf("after the cursor: %+v", next)
	}
	// A cursor the service cannot continue from starts over.
	for _, cursor := range []string{"garbage", "abcdef.3", answer.Cursor + "9999", "." + answer.Cursor} {
		if again, _ := ask(t, live, screen.Admin, cursor); !again.Reset || len(again.Events) != len(answer.Events) {
			t.Errorf("cursor %q: reset=%v with %d events", cursor, again.Reset, len(again.Events))
		}
	}
}

func TestLiveFollowsNewRequests(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	ctx := context.Background()
	clock := testenv.Now
	live := newLive(env, &clock)
	if err := live.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	warm, _ := ask(t, live, screen.Admin, "")

	admin, _ := env.Screen.View(ctx, screen.Admin)
	restricted, _ := env.Screen.View(ctx, screen.Restricted)
	index := func(view *screen.View, group, channel string) int {
		for i, route := range view.Topology.Routes {
			if route.Group == group && route.Channel == channel {
				return i
			}
		}
		t.Fatalf("no route %s · %s", group, channel)
		return -1
	}
	originOf := func(name string) string {
		for _, origin := range admin.Topology.Origins {
			if origin.Name == name {
				return origin.ID
			}
		}
		t.Fatalf("no origin %s", name)
		return ""
	}

	// Four rows appear in the gateway's log.
	writer, err := sql.Open("sqlite", "file:"+filepath.Join(env.Dir, devseed.GatewayFile))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	now := clock.UnixMilli()
	insert := func(id string, start int64, provider any, status string, code any, duration int64, ttfb any, ip any, kind any, tried any) {
		t.Helper()
		_, err := writer.Exec(`INSERT INTO request_logs (id, user_id, model, provider_id, is_stream, status, error_code, duration_ms, ttfb_ms, request_ip, request_kind, created_at, created_at_unix_ms, tried_providers_json)
VALUES (?, 'u', 'test-model', ?, 1, ?, ?, ?, ?, ?, ?, '', ?, ?)`, id, provider, status, code, duration, ttfb, ip, kind, start, tried)
		if err != nil {
			t.Fatal(err)
		}
	}
	// A: ended 2 s ago after one failed attempt on another Channel of its Group.
	insert("new-a", now-5000, "p-01", "success", nil, 3000, 800, "10.1.0.5", nil,
		`[{"provider_id":"p-02","error":"`+devseed.Marker+`","duration_ms":700},{"provider_id":"p-01","outcome":"served"}]`)
	// B: ended 50 s ago, its row came late; every attempt failed, the last on the Channel it names.
	insert("new-b", now-60_000, "p-08", "error", "upstream_error", 10_000, nil, "10.3.0.9", nil,
		`[{"provider_id":"p-09","error":"x","duration_ms":400},{"provider_id":"p-08","error":"y","duration_ms":900}]`)
	// C: rejected before a Channel was selected, from no known address.
	insert("new-c", now-1000, nil, "error", "rate_limit_exceeded", 50, nil, nil, nil, nil)
	// A health probe of the gateway is not a request.
	insert("new-probe", now-1000, "p-01", "success", nil, 300, nil, nil, "active_probe_connectivity", nil)

	clock = clock.Add(2 * time.Second)
	if err := live.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	answer, raw := ask(t, live, screen.Admin, warm.Cursor)
	assertClean(t, "the live answer", raw)
	got := lifecycles(t, answer, admin.Topology)
	if answer.Reset || len(got) != 3 || answer.Cursor == warm.Cursor {
		t.Fatalf("after the cursor: reset=%v, %d lifecycles", answer.Reset, len(got))
	}
	byModel := map[string][]liveEvent{}
	for _, events := range got {
		end := events[len(events)-1]
		byModel[end.Status+"/"+end.ErrorCode] = events
	}
	a, b, c := byModel["success/"], byModel["error/upstream_error"], byModel["error/rate_limit_exceeded"]
	if a == nil || b == nil || c == nil {
		t.Fatalf("lifecycles: %v", byModel)
	}

	// A is replayed from 6 s after its end, which is still ahead of the service's clock.
	startA := now - 5000 + 3000 + 6000
	wantA := []int{index(admin, "通用", "线路二"), index(admin, "通用", "线路一")}
	if a[0].T != startA || *a[0].Origin != originOf("北京") || fmt.Sprint(routesOf(a)) != fmt.Sprint(wantA) || a[1].T != startA || a[2].T != startA+700 {
		t.Fatalf("lifecycle A: %+v, want start %d and routes %v", a, startA, wantA)
	}
	if end := a[len(a)-1]; end.T != startA+3000 || end.TTFBMs == nil || *end.TTFBMs != 800 {
		t.Fatalf("lifecycle A ends with %+v", end)
	}
	// B came late: it is replayed from the moment the service saw it. Its two attempts are two
	// routes; the Channel the row names is not repeated.
	wantB := []int{index(admin, "合作方甲", "合作通道二"), index(admin, "合作方甲", "合作通道一")}
	if b[0].T != clock.UnixMilli() || fmt.Sprint(routesOf(b)) != fmt.Sprint(wantB) || b[2].T != b[0].T+400 || b[len(b)-1].TTFBMs != nil {
		t.Fatalf("lifecycle B: %+v, want start %d and routes %v", b, clock.UnixMilli(), wantB)
	}
	// C has no route and no region.
	if len(c) != 2 || *c[0].Origin != "" {
		t.Fatalf("lifecycle C: %+v", c)
	}

	// The restricted view names B's two Channels by their one Group entry, which has no Channel.
	limited, raw := ask(t, live, screen.Restricted, "")
	assertClean(t, "the restricted live answer", raw)
	group := index(restricted, "合作方甲", "")
	var found bool
	for _, events := range lifecycles(t, limited, restricted.Topology) {
		if end := events[len(events)-1]; end.ErrorCode == "upstream_error" && events[0].T == clock.UnixMilli() {
			found = true
			if routes := routesOf(events); fmt.Sprint(routes) != fmt.Sprint([]int{group, group}) {
				t.Fatalf("restricted routes of B: %v, want the Group entry %d twice", routes, group)
			}
		}
	}
	if !found {
		t.Fatal("the restricted view lacks lifecycle B")
	}

	// A second read of the same rows adds nothing.
	clock = clock.Add(2 * time.Second)
	if err := live.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	if again, _ := ask(t, live, screen.Admin, answer.Cursor); again.Reset || len(again.Events) != 0 {
		t.Fatalf("a second read repeated %d events", len(again.Events))
	}
}

func TestTopologyVersionKeepsWhileCountsChange(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	ctx := context.Background()
	before, err := env.Screen.View(ctx, screen.Admin)
	if err != nil {
		t.Fatal(err)
	}
	// More requests from a city that is already shown move its province's mean position and
	// every count, but no index and no id.
	writer, err := sql.Open("sqlite", "file:"+filepath.Join(env.Dir, devseed.GatewayFile))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	start := testenv.Now.Add(-10 * time.Minute).UnixMilli()
	for i := 0; i < 400; i++ {
		if _, err := writer.Exec(`INSERT INTO request_logs (id, user_id, model, provider_id, is_stream, status, duration_ms, request_ip, created_at, created_at_unix_ms)
VALUES (?, 'u', 'gpt-x-large', 'p-01', 0, 'success', 900, ?, '', ?)`, fmt.Sprintf("more-%d", i), fmt.Sprintf("10.5.0.%d", i%200+1), start+int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := env.Ingest.FollowOnce(ctx); err != nil {
		t.Fatal(err)
	}
	fresh := screen.New(env.Store, screen.Options{Gateway: before.Topology.Gateway, MinClients: 3, Now: func() time.Time { return testenv.Now }}, env.Ingest.Generation)
	after, err := fresh.View(ctx, screen.Admin)
	if err != nil {
		t.Fatal(err)
	}
	if after.Baseline.Total != before.Baseline.Total+400 {
		t.Fatalf("baseline %d, want %d", after.Baseline.Total, before.Baseline.Total+400)
	}
	if after.Version != before.Version {
		t.Fatal("the topology version changed although no index and no id changed")
	}
}

// A service that has just started has not stored the gateway's Channels yet. Live mode reads
// nothing until they are there, and starts with the very next read.
func TestLiveWaitsForChannels(t *testing.T) {
	env := testenv.New(t, testenv.Options{Days: 2, PerDay: 6000, BackfillDays: 1})
	ctx := context.Background()
	empty, err := store.Open(filepath.Join(t.TempDir(), "empty.db"), env.Store.Location())
	if err != nil {
		t.Fatal(err)
	}
	defer empty.Close()
	clock := testenv.Now
	now := func() time.Time { return clock }
	scr := screen.New(empty, screen.Options{MinClients: 3, Now: now}, func() uint64 { return 0 })
	live := screen.NewLive(env.Adapter, empty, env.Geo, scr, screen.LiveOptions{Now: now}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := live.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	if answer, _ := ask(t, live, screen.Admin, ""); len(answer.Events) != 0 {
		t.Fatalf("%d events before any Channel is known", len(answer.Events))
	}
	channels, err := env.Adapter.Channels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := empty.SyncRoutes(channels); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(2 * time.Second)
	if err := live.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	if answer, _ := ask(t, live, screen.Admin, ""); len(answer.Events) == 0 {
		t.Fatal("no events two seconds after the Channels were stored")
	}
}

// A restart keeps the store, so the live reader of the new run finds routes at once, before the
// ingest of that run has read the gateway's Channels. The requests of its first read must still be
// put on their own routes, not on the route of Channels that are no longer listed (spec OS-SL6).
func TestLiveRightAfterRestart(t *testing.T) {
	env := testenv.New(t, testenv.Options{Days: 2, PerDay: 6000, BackfillDays: 1})
	ctx := context.Background()
	// The new run's adapter has not read the Channels yet; the store is the last run's.
	adapter, err := lynshen.Open("sqlite://" + filepath.Join(env.Dir, devseed.GatewayFile))
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	clock := testenv.Now
	live := screen.NewLive(adapter, env.Store, env.Geo, env.Screen, screen.LiveOptions{Now: func() time.Time { return clock }}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := live.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	admin, err := env.Screen.View(ctx, screen.Admin)
	if err != nil {
		t.Fatal(err)
	}
	answer, _ := ask(t, live, screen.Admin, "")
	all := lifecycles(t, answer, admin.Topology)
	if len(all) < 50 {
		t.Fatalf("only %d lifecycles in the first read", len(all))
	}
	unknown, routed := 0, 0
	for _, events := range all {
		for _, index := range routesOf(events) {
			routed++
			if route := admin.Topology.Routes[index]; route.Group == "其他" && route.Channel == "已下线的渠道" {
				unknown++
			}
		}
	}
	if routed == 0 || unknown > 0 {
		t.Fatalf("%d of %d route events of the first read after a restart are on the route of Channels that are no longer listed", unknown, routed)
	}
}
