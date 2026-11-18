// Package webui holds the front end that is compiled into the binary.
//
// A plain `go build` embeds a one-line placeholder page, so the module builds from a clean
// checkout. `make build` builds web/, copies web/dist to internal/webui/dist (not committed), and
// compiles with the tag `embedweb`, which embeds that directory instead.
package webui
