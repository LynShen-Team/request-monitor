// Package testenv builds a whole service on invented data for tests: a demo gateway, the store,
// one backfill, and the screen builder.
package testenv

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/netip"
	"path/filepath"
	"testing"
	"time"

	"opsscreen/internal/devseed"
	"opsscreen/internal/gateway/lynshen"
	"opsscreen/internal/geo"
	"opsscreen/internal/ingest"
	"opsscreen/internal/screen"
	"opsscreen/internal/store"
	"opsscreen/internal/upstream"

	"opsscreen/internal/config"
)

// Now is the fixed present of every test environment.
var Now = time.Date(2026, 11, 18, 9, 7, 30, 0, time.UTC)

// Env is one service on invented data.
type Env struct {
	Dir     string
	Adapter *lynshen.Adapter
	Store   *store.Store
	Geo     geo.Resolver
	Ingest  *ingest.Ingestor
	Screen  *screen.Service
	// StorePath is the service's own database file.
	StorePath string
}

// Options size the environment.
type Options struct {
	Days         int
	PerDay       int
	BackfillDays int
	// Postgres, when set, is a PostgreSQL database: the demo is copied into a fresh schema of it
	// and the adapter reads that instead of the demo file.
	Postgres string
}

// New writes a demo gateway into a temporary directory, backfills it, and returns the parts.
func New(t testing.TB, o Options) *Env {
	t.Helper()
	if o.Days == 0 {
		o.Days = 4
	}
	if o.PerDay == 0 {
		o.PerDay = 20000
	}
	if o.BackfillDays == 0 {
		o.BackfillDays = 3
	}
	dir := t.TempDir()
	if err := devseed.Generate(dir, devseed.Options{Days: o.Days, PerDay: o.PerDay, Now: Now, Seed: 7}); err != nil {
		t.Fatal(err)
	}
	dsn := "sqlite://" + filepath.Join(dir, devseed.GatewayFile)
	if o.Postgres != "" {
		dsn = LoadPostgres(t, filepath.Join(dir, devseed.GatewayFile), o.Postgres)
	}
	adapter, err := lynshen.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adapter.Close() })
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	storePath := filepath.Join(dir, "opsscreen.db")
	st, err := store.Open(storePath, loc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	table, err := geo.OpenTable(filepath.Join(dir, devseed.GeoFile))
	if err != nil {
		t.Fatal(err)
	}
	now := func() time.Time { return Now }
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ing := ingest.New(adapter, st, table, ingest.Options{BackfillDays: o.BackfillDays, Now: now}, log)
	locator := upstream.New(st, table, []config.Upstream{{Host: "edge.cdn.invalid", Anycast: true, Name: "圣何塞", Region: "美国 · 加利福尼亚州", Lat: 37.34, Lon: -121.89}})
	// No name is resolved in tests: a host without a literal address or a fixed place is unknown.
	locator.LookupHost = func(context.Context, string) ([]netip.Addr, error) { return nil, errors.New("no DNS in tests") }
	ctx := context.Background()
	channels, err := ing.SyncChannels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := locator.Apply(ctx, channels); err != nil {
		t.Fatal(err)
	}
	if err := ing.Backfill(ctx); err != nil {
		t.Fatal(err)
	}
	if err := ing.FollowOnce(ctx); err != nil {
		t.Fatal(err)
	}
	scr := screen.New(st, screen.Options{
		Gateway:    screen.Site{ID: "gw", Name: "新加坡", Region: "新加坡", Lat: 1.35, Lon: 103.82},
		MinClients: 3,
		Now:        now,
	}, ing.Generation)
	return &Env{Dir: dir, Adapter: adapter, Store: st, Geo: table, Ingest: ing, Screen: scr, StorePath: storePath}
}
