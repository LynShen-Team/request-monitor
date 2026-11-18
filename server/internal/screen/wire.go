// Package screen builds what a browser receives: the topology and the replay buckets of the data
// contract (web/src/core/model.ts), already reduced to what the viewer may see.
package screen

// The types below mirror web/src/core/model.ts field for field.

type Site struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Region string  `json:"region"`
	Lat    float64 `json:"lat"`
	Lon    float64 `json:"lon"`
}

type UpstreamSite struct {
	Site
	Anycast  bool `json:"anycast,omitempty"`
	Channels int  `json:"channels"`
}

type RouteInfo struct {
	Group      string  `json:"group"`
	Channel    string  `json:"channel"`
	Upstream   *string `json:"upstream"`
	Restricted bool    `json:"restricted"`
}

type Topology struct {
	Gateway   Site           `json:"gateway"`
	Upstreams []UpstreamSite `json:"upstreams"`
	Origins   []Site         `json:"origins"`
	Routes    []RouteInfo    `json:"routes"`
}

type ReplayBucket struct {
	T0      int64   `json:"t0"`
	Total   int64   `json:"total"`
	Errors  int64   `json:"errors"`
	TTFBP50 float64 `json:"ttfbP50"`
	// Routes holds packed triples: route index (-1 = rejected at the gateway), requests, errors.
	Routes  []int64 `json:"routes"`
	Origins []int64 `json:"origins"`
	Models  []int64 `json:"models"`
}

type ReplayData struct {
	Window  string         `json:"window"`
	Start   int64          `json:"start"`
	End     int64          `json:"end"`
	StepMs  int64          `json:"stepMs"`
	Models  []string       `json:"models"`
	Buckets []ReplayBucket `json:"buckets"`
}

// Baseline is the request and error count of the 24 hours before now.
type Baseline struct {
	Total  int64 `json:"total"`
	Errors int64 `json:"errors"`
}

// Viewer is the class of a visitor. An admin sees every route; everyone else sees a restricted
// Group as its name alone (spec OS-D3a).
type Viewer int

const (
	// Restricted is the zero value: a visitor that was not identified is never treated as admin.
	Restricted Viewer = iota
	Admin
)
