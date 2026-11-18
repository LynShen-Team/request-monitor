// Package gateway declares what the service needs from one LLM gateway. Each supported gateway
// has one adapter that implements Adapter by reading the gateway; an adapter never writes.
package gateway

import (
	"context"
	"time"
)

// Status is the terminal state of one request (spec OS-D2).
type Status int

const (
	StatusSuccess Status = iota
	StatusError
	StatusClientGone
)

// RouteRef names the Group and Channel that served a request, by the gateway's own stable keys.
type RouteRef struct {
	GroupKey   string
	ChannelKey string
}

// Request is one finished request as the gateway logged it. It is used inside the service only:
// ClientIP is resolved to a region and dropped, and nothing but aggregates reaches the store.
type Request struct {
	// Start is the wall-clock time at which the gateway began to process the request.
	Start    time.Time
	ClientIP string
	Model    string
	// Route is nil when the gateway rejected the request before it selected a Channel.
	Route      *RouteRef
	Status     Status
	TTFBMs     int64
	HasTTFB    bool
	DurationMs int64
	ErrorCode  string

	// ID and Attempts are filled by LiveReader.LiveRequests only.
	//
	// ID is an identity of the gateway's log row. It is kept in memory for a few minutes, to tell
	// a new request from one already seen; it is never stored and never sent to a browser.
	ID string
	// Attempts are the failed attempts that preceded the Channel that served the request.
	Attempts []Attempt
}

// Attempt is one failed attempt of a request on a Channel.
type Attempt struct {
	Route      RouteRef
	DurationMs int64
}

// Channel is one Group · Channel pair of the gateway's current configuration.
type Channel struct {
	GroupKey    string
	GroupName   string
	ChannelKey  string
	ChannelName string
	// BaseURL is the upstream address. It stays inside the service; only the city it resolves to
	// is ever shown.
	BaseURL string
	// Restricted routes are shown to admins only; everyone else sees the Group name alone
	// (spec OS-D3a).
	Restricted bool
}

// Capabilities says what this gateway records, so the screen can label what is missing instead
// of showing a made-up value (spec OS-B2c).
type Capabilities struct {
	// Live is "realtime" (an event stream), "replayed" (rows replayed after the request ended),
	// or "none" (not connected yet).
	Live string `json:"live"`
	// Origin is false when the gateway does not record the client address of every request.
	Origin bool `json:"origin"`
	// Errors is false when the gateway does not log failed requests.
	Errors bool `json:"errors"`
	// DurationPrecisionMs is the resolution of recorded durations (1 or 1000).
	DurationPrecisionMs int `json:"durationPrecisionMs"`
}

// LiveReader is an adapter whose gateway can be shown in live mode by replay (spec section 13).
type LiveReader interface {
	// LiveRequests is Requests with ID and Attempts filled. It may call fn twice for one request;
	// the caller tells them apart by ID.
	LiveRequests(ctx context.Context, from, to time.Time, fn func(*Request) error) error
}

// Adapter reads one gateway.
type Adapter interface {
	// Kind is the adapter name: "lynshen", "sub2api", or "new-api".
	Kind() string
	Capabilities() Capabilities
	// Channels lists the current Group · Channel pairs.
	Channels(ctx context.Context) ([]Channel, error)
	// Requests calls fn for every finished request whose Start lies in [from, to), in any order.
	// The Request passed to fn is reused between calls.
	Requests(ctx context.Context, from, to time.Time, fn func(*Request) error) error
	Close() error
}
