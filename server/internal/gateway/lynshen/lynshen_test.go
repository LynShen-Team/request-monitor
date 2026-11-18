package lynshen_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"request-monitor/internal/devseed"
	"request-monitor/internal/gateway"
	"request-monitor/internal/gateway/lynshen"
	"request-monitor/internal/testenv"
)

func demo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := devseed.Generate(dir, devseed.Options{Days: 2, PerDay: 5000, Now: testenv.Now, Seed: 11}); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, devseed.GatewayFile)
}

func TestOnDemoFile(t *testing.T) {
	fixture := demo(t)
	check(t, fixture, "sqlite://"+fixture)
}

func TestOnPostgres(t *testing.T) {
	dsn := testenv.PostgresDSN()
	if dsn == "" {
		t.Skip("REQUEST_MONITOR_TEST_PG_DSN is not set")
	}
	fixture := demo(t)
	scoped := testenv.LoadPostgres(t, fixture, dsn)
	adapter := check(t, fixture, scoped)

	// The transaction of every read is READ ONLY: PostgreSQL itself refuses a write.
	ctx := context.Background()
	tx, err := adapter.BeginForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(ctx, `DELETE FROM request_logs`)
	if err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("a write inside the adapter's transaction was not refused: %v", err)
	}
}

func TestRejectsOtherDSN(t *testing.T) {
	if _, err := lynshen.Open("mysql://u@h/db"); err == nil {
		t.Fatal("a DSN that is not PostgreSQL was accepted")
	}
}

// check compares what the adapter at dsn returns with what the demo file holds.
func check(t *testing.T, fixture, dsn string) *lynshen.Adapter {
	t.Helper()
	ctx := context.Background()
	adapter, err := lynshen.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adapter.Close() })
	source, err := sql.Open("sqlite", "file:"+fixture+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()

	channels, err := adapter.Channels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var restricted []string
	groupOf := map[string]string{}
	for _, c := range channels {
		if strings.HasPrefix(c.ChannelName, "internal") || c.GroupName == "" || c.GroupKey == "" || c.BaseURL == "" {
			t.Errorf("channel %+v: wrong name, group, or base URL", c)
		}
		if c.Restricted {
			restricted = append(restricted, c.ChannelName)
		}
		groupOf[c.ChannelKey] = c.GroupKey
	}
	want := devseed.RestrictedChannelNames()
	sort.Strings(restricted)
	sort.Strings(want)
	if len(channels) != 12 || strings.Join(restricted, ",") != strings.Join(want, ",") {
		t.Fatalf("%d channels, restricted %v, want 12 and %v", len(channels), restricted, want)
	}

	type tally struct{ total, success, failed, gone, rejected, withTTFB, withIP int64 }
	var expected tally
	err = source.QueryRow(`SELECT COUNT(*), SUM(status = 'success'), SUM(status = 'error'), SUM(status = 'client_gone'),
SUM(provider_id IS NULL), SUM(ttfb_ms IS NOT NULL), SUM(request_ip IS NOT NULL)
FROM request_logs WHERE request_kind IS NULL`).Scan(&expected.total, &expected.success, &expected.failed, &expected.gone, &expected.rejected, &expected.withTTFB, &expected.withIP)
	if err != nil {
		t.Fatal(err)
	}
	var probes int64
	if err := source.QueryRow(`SELECT COUNT(*) FROM request_logs WHERE request_kind = 'active_probe_connectivity'`).Scan(&probes); err != nil || probes == 0 {
		t.Fatalf("the demo has no probe rows to leave out (%v)", err)
	}

	from, to := testenv.Now.Add(-72*time.Hour), testenv.Now.Add(time.Hour)
	var got tally
	err = adapter.Requests(ctx, from, to, func(r *gateway.Request) error {
		got.total++
		switch r.Status {
		case gateway.StatusSuccess:
			got.success++
		case gateway.StatusError:
			got.failed++
		case gateway.StatusClientGone:
			got.gone++
		}
		if r.Route == nil {
			got.rejected++
		} else if r.Route.GroupKey != groupOf[r.Route.ChannelKey] || r.Route.GroupKey == "" {
			t.Fatalf("request served by %q carries the group %q", r.Route.ChannelKey, r.Route.GroupKey)
		}
		if r.HasTTFB {
			got.withTTFB++
		}
		if r.ClientIP != "" {
			got.withIP++
		}
		if r.Model == "" || r.Start.Before(from) || !r.Start.Before(to) {
			t.Fatalf("request with model %q at %s is outside the range", r.Model, r.Start)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != expected || got.total == 0 || got.gone == 0 || got.rejected == 0 {
		t.Fatalf("requests: got %+v, the demo file holds %+v", got, expected)
	}

	// The range is half-open and the aggregate query agrees with the row reader.
	middle := testenv.Now.Add(-20 * time.Hour)
	var first, second, counted int64
	count := func(n *int64) func(*gateway.Request) error {
		return func(*gateway.Request) error { *n++; return nil }
	}
	if err := adapter.Requests(ctx, from, middle, count(&first)); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Requests(ctx, middle, to, count(&second)); err != nil {
		t.Fatal(err)
	}
	if err := adapter.CountByBucket(ctx, from, to, func(_ int64, _, _ string, n int64) error { counted += n; return nil }); err != nil {
		t.Fatal(err)
	}
	if first+second != got.total || counted != got.total || first == 0 || second == 0 {
		t.Fatalf("two half ranges give %d + %d, the aggregate %d, the whole %d", first, second, counted, got.total)
	}
	return adapter
}
