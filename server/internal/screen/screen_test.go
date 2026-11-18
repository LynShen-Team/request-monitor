package screen_test

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"opsscreen/internal/devseed"
	"opsscreen/internal/ingest"
	"opsscreen/internal/screen"
	"opsscreen/internal/store"
	"opsscreen/internal/testenv"
)

// Strings that must never be in the store or in an answer: client addresses, upstream hosts, and
// the marker that the demo writes into the user, key, and error-detail columns.
var forbidden = []*regexp.Regexp{
	regexp.MustCompile(`\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`),
	regexp.MustCompile(`fd00:`),
	regexp.MustCompile(`198\.51\.100\.|203\.0\.113\.`),
	regexp.MustCompile(`\.invalid|secret-host`),
	regexp.MustCompile(regexp.QuoteMeta(devseed.Marker)),
	regexp.MustCompile(`internal `),
}

func assertClean(t *testing.T, what string, data []byte) {
	t.Helper()
	for _, re := range forbidden {
		if found := re.Find(data); found != nil {
			t.Errorf("%s contains %q", what, found)
		}
	}
}

func encode(t *testing.T, view *screen.View) string {
	t.Helper()
	data, err := json.Marshal(map[string]any{"topology": view.Topology, "replay": view.Replay, "baseline": view.Baseline})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func backfilledRange(env *testenv.Env) (int64, int64) {
	start, _ := env.Store.DayRange(env.Store.Day(testenv.Now))
	return store.Bucket(start.AddDate(0, 0, -3)), store.Bucket(testenv.Now) + 1
}

func TestEndToEnd(t *testing.T) {
	checkEndToEnd(t, testenv.New(t, testenv.Options{}))
}

// The same checks with the gateway tables in PostgreSQL, which is what a real gateway runs on.
func TestEndToEndPostgres(t *testing.T) {
	dsn := testenv.PostgresDSN()
	if dsn == "" {
		t.Skip("OPSSCREEN_TEST_PG_DSN is not set")
	}
	checkEndToEnd(t, testenv.New(t, testenv.Options{Postgres: dsn}))
}

func checkEndToEnd(t *testing.T, env *testenv.Env) {
	t.Helper()
	ctx := context.Background()

	// The rollups equal the gateway's own counts, cell by cell.
	from, to := backfilledRange(env)
	result, err := ingest.Reconcile(ctx, env.Adapter, env.Store, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if result.GatewayTotal == 0 || result.Different != 0 || result.GatewayTotal != result.RollupTotal {
		t.Fatalf("rollups do not match the gateway: %+v", result)
	}

	admin, err := env.Screen.View(ctx, screen.Admin)
	if err != nil {
		t.Fatal(err)
	}
	restricted, err := env.Screen.View(ctx, screen.Restricted)
	if err != nil {
		t.Fatal(err)
	}

	steps := map[string]struct {
		count int
		step  int64
	}{"24h": {288, 300_000}, "7d": {336, 1_800_000}, "30d": {360, 7_200_000}}
	for name, want := range steps {
		for label, view := range map[string]*screen.View{"admin": admin, "restricted": restricted} {
			data := view.Replay[name]
			if len(data.Buckets) != want.count || data.StepMs != want.step || data.End-data.Start != int64(want.count)*want.step {
				t.Fatalf("%s %s: %d buckets of %d ms from %d to %d", label, name, len(data.Buckets), data.StepMs, data.Start, data.End)
			}
			if data.End > testenv.Now.UnixMilli() {
				t.Fatalf("%s %s: the window ends after the present", label, name)
			}
			var windowTotal int64
			for i, b := range data.Buckets {
				var routes, routeErrors, origins, models int64
				if len(b.Routes)%3 != 0 {
					t.Fatalf("%s %s bucket %d: routes is not a list of triples", label, name, i)
				}
				for j := 0; j < len(b.Routes); j += 3 {
					if index := b.Routes[j]; index < -1 || index >= int64(len(view.Topology.Routes)) {
						t.Fatalf("%s %s bucket %d: route index %d is out of range", label, name, i, index)
					}
					routes += b.Routes[j+1]
					routeErrors += b.Routes[j+2]
				}
				for _, n := range b.Origins {
					origins += n
				}
				for _, n := range b.Models {
					models += n
				}
				if routes != b.Total || routeErrors != b.Errors || models != b.Total || origins > b.Total {
					t.Fatalf("%s %s bucket %d: total %d errors %d, but routes %d/%d, models %d, origins %d", label, name, i, b.Total, b.Errors, routes, routeErrors, models, origins)
				}
				if len(b.Origins) != len(view.Topology.Origins) || len(b.Models) != len(data.Models) {
					t.Fatalf("%s %s bucket %d: origins or models have the wrong length", label, name, i)
				}
				windowTotal += b.Total
			}
			// The window's total equals what the gateway counts for the same range. The service
			// read the last three days only, so a longer window is compared from there on.
			lower := time.UnixMilli(data.Start)
			if first := store.BucketStart(from); first.After(lower) {
				lower = first
			}
			var gateway int64
			if err := env.Adapter.CountByBucket(ctx, lower, time.UnixMilli(data.End), func(_ int64, _, _ string, n int64) error {
				gateway += n
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if windowTotal != gateway || windowTotal == 0 {
				t.Fatalf("%s %s: replay total %d, gateway %d", label, name, windowTotal, gateway)
			}
		}
	}
	if admin.Baseline != restricted.Baseline || admin.Baseline.Total == 0 || admin.Baseline.Errors == 0 {
		t.Fatalf("baselines: admin %+v, restricted %+v", admin.Baseline, restricted.Baseline)
	}
	if median := admin.Replay["24h"].Buckets[200].TTFBP50; median < 300 || median > 4000 {
		t.Fatalf("TTFB median of a busy bucket = %v ms, expected about a second", median)
	}

	// A second pass over the same ranges changes nothing.
	if err := env.Ingest.FollowOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := env.Ingest.Recompute(ctx, store.BucketStart(from), store.BucketStart(from+288)); err != nil {
		t.Fatal(err)
	}
	again, err := ingest.Reconcile(ctx, env.Adapter, env.Store, from, to)
	if err != nil || again != result {
		t.Fatalf("after a second pass: %+v (%v), before: %+v", again, err, result)
	}
}

func TestRestrictedView(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	ctx := context.Background()
	admin, _ := env.Screen.View(ctx, screen.Admin)
	restricted, err := env.Screen.View(ctx, screen.Restricted)
	if err != nil {
		t.Fatal(err)
	}
	adminJSON, restrictedJSON := encode(t, admin), encode(t, restricted)
	for _, name := range devseed.RestrictedChannelNames() {
		if !strings.Contains(adminJSON, name) {
			t.Errorf("the admin view lacks the Channel %q", name)
		}
		if strings.Contains(restrictedJSON, name) {
			t.Errorf("the restricted view contains the restricted Channel %q", name)
		}
	}
	// Each restricted Group is exactly one entry, with no Channel and no upstream.
	merged := map[string]int{}
	for _, route := range restricted.Topology.Routes {
		if !route.Restricted {
			if route.Channel == "" {
				t.Errorf("an open route of %q has no Channel name", route.Group)
			}
			continue
		}
		merged[route.Group]++
		if route.Channel != "" || route.Upstream != nil {
			t.Errorf("the restricted Group %q carries a Channel or an upstream", route.Group)
		}
	}
	for _, group := range []string{"合作方甲", "内部试验"} {
		if merged[group] != 1 {
			t.Errorf("the restricted Group %q has %d entries, want 1", group, merged[group])
		}
	}
	// A site that only restricted routes use is not in the restricted view.
	siteNames := func(view *screen.View) map[string]int {
		out := map[string]int{}
		for _, site := range view.Topology.Upstreams {
			out[site.Name] = site.Channels
		}
		return out
	}
	adminSites, restrictedSites := siteNames(admin), siteNames(restricted)
	if _, ok := adminSites["阿什本"]; !ok {
		t.Fatalf("the admin view lacks the upstream site 阿什本: %v", adminSites)
	}
	if _, ok := restrictedSites["阿什本"]; ok {
		t.Error("the restricted view shows a site that only restricted routes use")
	}
	if adminSites["法兰克福"] != 2 || restrictedSites["法兰克福"] != 1 {
		t.Errorf("channels at 法兰克福: admin %d (want 2), restricted %d (want 1)", adminSites["法兰克福"], restrictedSites["法兰克福"])
	}
	var anycast bool
	for _, site := range admin.Topology.Upstreams {
		if site.Name == "圣何塞" {
			anycast = site.Anycast
		}
	}
	if !anycast {
		t.Error("the configured anycast site is missing or not marked")
	}
	// Totals are the same for everyone.
	for name := range admin.Replay {
		for i := range admin.Replay[name].Buckets {
			a, r := admin.Replay[name].Buckets[i], restricted.Replay[name].Buckets[i]
			if a.Total != r.Total || a.Errors != r.Errors || a.TTFBP50 != r.TTFBP50 {
				t.Fatalf("%s bucket %d differs between the views", name, i)
			}
		}
	}
	if admin.Version == restricted.Version {
		t.Error("two different topologies carry the same version")
	}
}

func TestDistinctClientRule(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	view, err := env.Screen.View(context.Background(), screen.Restricted)
	if err != nil {
		t.Fatal(err)
	}
	shown := map[string]bool{}
	for _, origin := range view.Topology.Origins {
		shown[origin.Name] = true
		if origin.Lat == 0 && origin.Lon == 0 {
			t.Errorf("the origin %q has no position", origin.Name)
		}
	}
	for _, name := range devseed.HiddenNames {
		if shown[name] {
			t.Errorf("%q has fewer than 3 clients and must not be shown", name)
		}
	}
	for _, name := range append([]string{"北京", "深圳", "东京", "新加坡"}, devseed.ShownAsGroup...) {
		if !shown[name] {
			t.Errorf("%q should be shown", name)
		}
	}
	// Nearly every request has a shown region: only requests without an address (1 %) and those
	// of the one hidden country are left out.
	var total, placed int64
	for _, b := range view.Replay["24h"].Buckets {
		total += b.Total
		for _, n := range b.Origins {
			placed += n
		}
	}
	if share := float64(placed) / float64(total); share < 0.97 || share >= 1 {
		t.Fatalf("%.4f of the requests have a shown region, want about 0.99", share)
	}
}

func TestNothingSensitiveIsStoredOrServed(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	ctx := context.Background()
	for label, viewer := range map[string]screen.Viewer{"admin": screen.Admin, "restricted": screen.Restricted} {
		view, err := env.Screen.View(ctx, viewer)
		if err != nil {
			t.Fatal(err)
		}
		assertClean(t, "the "+label+" view", []byte(encode(t, view)))
	}
	for _, suffix := range []string{"", "-wal"} {
		data, err := os.ReadFile(env.StorePath + suffix)
		if err != nil {
			if suffix == "" {
				t.Fatal(err)
			}
			continue
		}
		assertClean(t, "the store file"+suffix, data)
	}
}
