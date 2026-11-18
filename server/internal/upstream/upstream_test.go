package upstream

import (
	"context"
	"errors"
	"net/netip"
	"testing"

	"request-monitor/internal/config"
	"request-monitor/internal/geo"
)

type fakeGeo map[string]geo.Place

func (f fakeGeo) Lookup(addr netip.Addr) (geo.Place, bool) { p, ok := f[addr.String()]; return p, ok }
func (fakeGeo) Attribution() *geo.Attribution              { return nil }
func (fakeGeo) Close() error                               { return nil }

func TestHostOf(t *testing.T) {
	cases := map[string]string{
		"https://API.Example.com:8443/v1": "api.example.com",
		"api.example.com/v1":              "api.example.com",
		"http://192.0.2.7/v1":             "192.0.2.7",
		"https://[2001:db8::1]:443/":      "2001:db8::1",
		"":                                "",
		"  ":                              "",
	}
	for in, want := range cases {
		if got := hostOf(in); got != want {
			t.Errorf("hostOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLocate(t *testing.T) {
	places := fakeGeo{
		"192.0.2.7":  {CountryCode: "JP", Country: "日本", Province: "东京都", City: "东京", Lat: 35.7, Lon: 139.7},
		"192.0.2.99": {CountryCode: "SG", Country: "新加坡", City: "新加坡", Lat: 1.3, Lon: 103.8},
		"192.0.2.50": {CountryCode: "US", Country: "美国", Province: "加利福尼亚州", Lat: 36, Lon: -119},
	}
	lookups := 0
	l := New(nil, places, []config.Upstream{
		{Host: ".cdn.example", Anycast: true},
		{Host: "fixed.example", Name: "某地", Region: "某国", Lat: 1, Lon: 2},
		{Host: "deep.cdn.example", Hidden: true},
	})
	l.LookupHost = func(_ context.Context, host string) ([]netip.Addr, error) {
		lookups++
		switch host {
		case "named.example":
			return []netip.Addr{netip.MustParseAddr("203.0.113.1"), netip.MustParseAddr("192.0.2.99")}, nil
		case "edge.cdn.example":
			return []netip.Addr{netip.MustParseAddr("192.0.2.50")}, nil
		}
		return nil, errors.New("no such host")
	}
	ctx := context.Background()

	if site, ok := l.locate(ctx, "192.0.2.7"); !ok || site.Name != "东京" || site.Region != "日本 · 东京都" || site.Anycast {
		t.Fatalf("literal address: %+v %v", site, ok)
	}
	// The first address the database knows wins; a city-state has no province line.
	if site, ok := l.locate(ctx, "named.example"); !ok || site.Name != "新加坡" || site.Region != "新加坡" {
		t.Fatalf("resolved name: %+v %v", site, ok)
	}
	before := lookups
	l.locate(ctx, "named.example")
	if lookups != before {
		t.Fatal("a host was resolved twice within a day")
	}
	// A suffix entry marks the resolved place as anycast; a place without a city is its province.
	if site, ok := l.locate(ctx, "edge.cdn.example"); !ok || !site.Anycast || site.Name != "加利福尼亚州" || site.Region != "美国" {
		t.Fatalf("anycast: %+v %v", site, ok)
	}
	// The longest matching entry wins.
	if _, ok := l.locate(ctx, "deep.cdn.example"); ok {
		t.Fatal("a hidden host has a site")
	}
	if site, ok := l.locate(ctx, "fixed.example"); !ok || site.Name != "某地" || site.Lat != 1 || site.Lon != 2 {
		t.Fatalf("fixed place: %+v %v", site, ok)
	}
	if _, ok := l.locate(ctx, "unknown.example"); ok {
		t.Fatal("an unresolvable host has a site")
	}
	if _, ok := l.locate(ctx, ""); ok {
		t.Fatal("an empty host has a site")
	}
}
