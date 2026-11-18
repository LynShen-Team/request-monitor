// Package upstream finds the city of each Channel's upstream server (spec OS-B5). Only the city
// is stored; the host name and its address stay in memory.
package upstream

import (
	"context"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"opsscreen/internal/config"
	"opsscreen/internal/gateway"
	"opsscreen/internal/geo"
	"opsscreen/internal/store"
)

// Locator assigns an upstream site to every route.
type Locator struct {
	store     *store.Store
	geo       geo.Resolver
	overrides []config.Upstream
	// LookupHost resolves a host name; tests replace it.
	LookupHost func(ctx context.Context, host string) ([]netip.Addr, error)
	now        func() time.Time

	resolved map[string]resolution
}

type resolution struct {
	at   time.Time
	site store.Site
	ok   bool
}

func New(st *store.Store, resolver geo.Resolver, overrides []config.Upstream) *Locator {
	return &Locator{
		store:     st,
		geo:       resolver,
		overrides: overrides,
		now:       time.Now,
		resolved:  map[string]resolution{},
		LookupHost: func(ctx context.Context, host string) ([]netip.Addr, error) {
			ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		},
	}
}

// hostOf extracts the host of a Channel base URL, lower case, without port.
func hostOf(baseURL string) string {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return ""
	}
	if !strings.Contains(baseURL, "://") {
		baseURL = "https://" + baseURL
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

func (l *Locator) override(host string) (config.Upstream, bool) {
	best, found := config.Upstream{}, false
	for _, o := range l.overrides {
		pattern := strings.ToLower(strings.TrimSpace(o.Host))
		match := pattern == host || (strings.HasPrefix(pattern, ".") && strings.HasSuffix(host, pattern))
		if match && (!found || len(pattern) > len(best.Host)) {
			best, found = o, true
		}
	}
	return best, found
}

// locate returns the site of a host. A host is resolved at most once a day.
func (l *Locator) locate(ctx context.Context, host string) (store.Site, bool) {
	if host == "" {
		return store.Site{}, false
	}
	override, hasOverride := l.override(host)
	if hasOverride && override.Hidden {
		return store.Site{}, false
	}
	if hasOverride && override.Name != "" {
		return store.Site{
			Key:     "manual\x1f" + override.Name + "\x1f" + override.Region,
			Name:    override.Name,
			Region:  override.Region,
			Lat:     override.Lat,
			Lon:     override.Lon,
			Anycast: override.Anycast,
		}, true
	}
	anycast := hasOverride && override.Anycast
	if cached, ok := l.resolved[host]; ok && l.now().Sub(cached.at) < 24*time.Hour {
		return cached.site, cached.ok
	}
	site, ok := l.resolve(ctx, host, anycast)
	l.resolved[host] = resolution{at: l.now(), site: site, ok: ok}
	return site, ok
}

func (l *Locator) resolve(ctx context.Context, host string, anycast bool) (store.Site, bool) {
	var addrs []netip.Addr
	if addr, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{addr}
	} else if found, err := l.LookupHost(ctx, host); err == nil {
		addrs = found
	}
	for _, addr := range addrs {
		place, ok := l.geo.Lookup(addr.Unmap())
		if !ok {
			continue
		}
		name := place.City
		region := place.Country
		switch {
		case name != "" && place.Province != "" && place.Province != name:
			region = place.Country + " · " + place.Province
		case name == "" && place.Province != "":
			name = place.Province
		case name == "":
			name, region = place.Country, ""
		}
		key := place.CountryCode + "\x1f" + place.Province + "\x1f" + place.City
		if anycast {
			key += "\x1fanycast"
		}
		return store.Site{Key: key, Name: name, Region: region, Lat: place.Lat, Lon: place.Lon, Anycast: anycast}, true
	}
	return store.Site{}, false
}

// Apply stores the site of every listed Channel. A Channel whose place is unknown gets no site
// and draws no dispatch arc.
func (l *Locator) Apply(ctx context.Context, channels []gateway.Channel) error {
	routes, err := l.store.Routes()
	if err != nil {
		return err
	}
	current := map[store.RouteKey]store.Route{}
	for _, r := range routes {
		current[store.RouteKey{Group: r.GroupKey, Channel: r.ChannelKey}] = r
	}
	for _, c := range channels {
		route, ok := current[store.RouteKey{Group: c.GroupKey, Channel: c.ChannelKey}]
		if !ok {
			continue
		}
		var siteID int64
		if site, found := l.locate(ctx, hostOf(c.BaseURL)); found {
			if siteID, err = l.store.EnsureSite(site); err != nil {
				return err
			}
		}
		if siteID != route.Site {
			if err := l.store.SetRouteSite(route.ID, siteID); err != nil {
				return err
			}
		}
	}
	return nil
}
