package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"opsscreen/internal/gateway"
	"opsscreen/internal/geo"
)

func open(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "s.db"), time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func routeTotal(t *testing.T, st *Store, from, to int64) int64 {
	t.Helper()
	var total int64
	if err := st.EachRoute(context.Background(), from, to, func(_, _ int64, _ gateway.Status, n int64) { total += n }); err != nil {
		t.Fatal(err)
	}
	return total
}

func TestReplaceRangeReplaces(t *testing.T) {
	st := open(t)
	agg := NewAggregate()
	agg.Route[RouteCell{Bucket: 10, Route: 1, Status: gateway.StatusSuccess}] = 5
	agg.Route[RouteCell{Bucket: 11, Route: 1, Status: gateway.StatusError}] = 2
	for i := 0; i < 3; i++ {
		if err := st.ReplaceRange(10, 12, agg); err != nil {
			t.Fatal(err)
		}
	}
	if got := routeTotal(t, st, 0, 100); got != 7 {
		t.Fatalf("after three identical passes the total is %d, want 7", got)
	}
	// A pass over part of the range leaves the rest alone.
	part := NewAggregate()
	part.Route[RouteCell{Bucket: 10, Route: 1, Status: gateway.StatusSuccess}] = 1
	if err := st.ReplaceRange(10, 11, part); err != nil {
		t.Fatal(err)
	}
	if got := routeTotal(t, st, 0, 100); got != 3 {
		t.Fatalf("total = %d, want 3", got)
	}
}

func TestClientCountsClimbTheRegions(t *testing.T) {
	st := open(t)
	cityA, err := st.EnsureRegion(geo.Place{CountryCode: "AA", Country: "甲国", Province: "东省", City: "一市"})
	if err != nil {
		t.Fatal(err)
	}
	cityB, _ := st.EnsureRegion(geo.Place{CountryCode: "AA", Country: "甲国", Province: "东省", City: "二市"})
	cityC, _ := st.EnsureRegion(geo.Place{CountryCode: "AA", Country: "甲国", Province: "西省", City: "三市"})
	regions, _ := st.Regions()
	province := regions[cityA].Parent
	country := regions[province].Parent
	if regions[cityB].Parent != province || regions[cityC].Parent == province || regions[regions[cityC].Parent].Parent != country {
		t.Fatal("region parents are wrong")
	}
	const day = 20260102
	agg := NewAggregate()
	agg.Clients[ClientCell{Day: day, Region: cityA}] = map[int64]struct{}{1: {}, 2: {}}
	// Client 2 is also seen in the second city of the same province: one client for the province.
	agg.Clients[ClientCell{Day: day, Region: cityB}] = map[int64]struct{}{2: {}, 3: {}}
	agg.Clients[ClientCell{Day: day, Region: cityC}] = map[int64]struct{}{4: {}}
	if err := st.ReplaceRange(0, 1, agg); err != nil {
		t.Fatal(err)
	}
	check := func(stage string) {
		t.Helper()
		counts, err := st.ClientCounts(day)
		if err != nil {
			t.Fatal(err)
		}
		want := map[int64]int{cityA: 2, cityB: 2, cityC: 1, province: 3, country: 4}
		for region, n := range want {
			if counts[region] != n {
				t.Fatalf("%s: region %d has %d clients, want %d", stage, region, counts[region], n)
			}
		}
	}
	check("open day")
	if _, err := st.Salt(day); err != nil {
		t.Fatal(err)
	}
	if err := st.FinalizeDay(day); err != nil {
		t.Fatal(err)
	}
	check("final day")
	var left int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM client_seen`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("fingerprints of a final day must be deleted, %d left (%v)", left, err)
	}
	if _, ok, _ := st.Meta(saltKey(day)); ok {
		t.Fatal("the key of a final day must be deleted")
	}
	// Fingerprints that arrive for a final day are ignored.
	if err := st.ReplaceRange(0, 1, agg); err != nil {
		t.Fatal(err)
	}
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM client_seen`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("a final day must not take fingerprints again, %d stored", left)
	}
	if err := st.ResetDay(day); err != nil {
		t.Fatal(err)
	}
	if final, _ := st.DayFinal(day); final {
		t.Fatal("a reset day must not be final")
	}
}

func TestDays(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	st, err := Open(filepath.Join(t.TempDir(), "s.db"), loc)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	// 17:30 UTC on 31 December is already 1 January in UTC+8.
	at := time.Date(2026, 12, 31, 17, 30, 0, 0, time.UTC)
	if day := st.Day(at); day != 20270101 {
		t.Fatalf("day = %d, want 20270101", day)
	}
	if prev := st.PrevDay(20270101); prev != 20261231 {
		t.Fatalf("previous day = %d, want 20261231", prev)
	}
	start, end := st.DayRange(20270101)
	if end.Sub(start) != 24*time.Hour || !start.Equal(time.Date(2026, 12, 31, 16, 0, 0, 0, time.UTC)) {
		t.Fatalf("day range = %s to %s", start, end)
	}
}
