package api_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/LynShen-Team/request-monitor/internal/api"
	"github.com/LynShen-Team/request-monitor/internal/config"
	"github.com/LynShen-Team/request-monitor/internal/devseed"
	"github.com/LynShen-Team/request-monitor/internal/gateway/lynshen"
	"github.com/LynShen-Team/request-monitor/internal/identity"
	"github.com/LynShen-Team/request-monitor/internal/screen"
	"github.com/LynShen-Team/request-monitor/internal/testenv"
	"github.com/LynShen-Team/request-monitor/internal/webui"
)

func TestLiveEndpoint(t *testing.T) {
	env := testenv.New(t, testenv.Options{Days: 2, PerDay: 6000, BackfillDays: 1})
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	live := screen.NewLive(env.Adapter, env.Store, env.Geo, env.Screen, screen.LiveOptions{Now: func() time.Time { return testenv.Now }}, quiet)
	if err := live.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	gateway := fakeGateway(t)
	verifier, err := lynshen.NewVerifier(gateway.URL)
	if err != nil {
		t.Fatal(err)
	}
	build := func(cfg *config.Config, withLive bool) *api.Server {
		cfg.Listen = "127.0.0.1:8787"
		cfg.Geo.MinClients = 3
		options := api.Options{Config: cfg, Screen: env.Screen, Identity: identity.New(verifier), Adapter: env.Adapter, Geo: env.Geo, GeoReady: true, Backfilling: env.Ingest.Backfilling, Web: webui.Dist(), Log: quiet}
		if withLive {
			options.Live = live
		}
		return api.New(options)
	}
	type answer struct {
		Version string
		Now     int64
		PollMs  int64 `json:"pollMs"`
		DelayMs int64 `json:"delayMs"`
		Cursor  string
		Reset   *bool
		Events  []map[string]any
	}
	read := func(s *api.Server, path string, headers map[string]string) (int, answer, string) {
		response, body := get(t, s, "GET", path, headers)
		var a answer
		_ = json.Unmarshal([]byte(body), &a)
		return response.StatusCode, a, body
	}
	version := func(s *api.Server, headers map[string]string) string {
		_, body := get(t, s, "GET", "/api/topology", headers)
		var topology struct{ Version string }
		_ = json.Unmarshal([]byte(body), &topology)
		return topology.Version
	}
	admin := map[string]string{"Cookie": "monoize_session=session-admin"}
	s := build(&config.Config{}, true)

	// A first request is the warm-up; the next one continues from its cursor.
	status, first, body := read(s, "/api/live", admin)
	if status != 200 || first.Reset == nil || !*first.Reset || len(first.Events) == 0 || first.Cursor == "" || first.PollMs != 2000 || first.DelayMs != 3500 || first.Now != testenv.Now.UnixMilli() {
		t.Fatalf("warm-up: %d %+v", status, first)
	}
	if first.Version != version(s, admin) {
		t.Fatal("the live answer of an admin carries another version than the admin's topology")
	}
	for _, name := range devseed.RestrictedChannelNames() {
		if strings.Contains(body, name) {
			t.Fatalf("a live answer contains the Channel name %q", name)
		}
	}
	for _, event := range first.Events {
		switch event["type"] {
		case "start":
			if _, ok := event["origin"].(string); !ok {
				t.Fatalf("a start event without an origin string: %v", event)
			}
		case "end":
			if _, present := event["ttfbMs"]; !present {
				t.Fatalf("an end event must carry ttfbMs, null when not recorded: %v", event)
			}
		}
	}
	status, next, _ := read(s, "/api/live?after="+first.Cursor, admin)
	if status != 200 || next.Reset == nil || *next.Reset || len(next.Events) != 0 {
		t.Fatalf("after the cursor: %d %+v", status, next)
	}
	// A guest receives the same lifecycles with the restricted topology's version.
	_, guest, _ := read(s, "/api/live", nil)
	if guest.Version == first.Version || guest.Version != version(s, nil) {
		t.Fatalf("guest version %q, admin version %q", guest.Version, first.Version)
	}
	starts := func(a answer) (n int) {
		for _, event := range a.Events {
			if event["type"] == "start" {
				n++
			}
		}
		return n
	}
	if starts(guest) != starts(first) || starts(first) == 0 {
		t.Fatalf("a guest sees %d lifecycles, an admin %d", starts(guest), starts(first))
	}

	var meta struct{ Capabilities struct{ Live string } }
	_, body = get(t, s, "GET", "/api/meta", nil)
	if _ = json.Unmarshal([]byte(body), &meta); meta.Capabilities.Live != "replayed" {
		t.Fatalf("capabilities.live = %q, want replayed", meta.Capabilities.Live)
	}

	// A guest who must sign in first is refused.
	no := false
	closed := build(&config.Config{Access: config.Access{Guests: &no}}, true)
	if status, _, body := read(closed, "/api/live", nil); status != http.StatusUnauthorized || !strings.Contains(body, "login_required") {
		t.Fatalf("live for a guest who must sign in: %d %s", status, body)
	}
	if status, _, _ := read(closed, "/api/live", admin); status != 200 {
		t.Fatalf("live for an admin: %d", status)
	}

	// A service without live mode says so.
	off := build(&config.Config{}, false)
	if status, _, body := read(off, "/api/live", admin); status != http.StatusNotFound || !strings.Contains(body, "live_unavailable") {
		t.Fatalf("live when it is off: %d %s", status, body)
	}
	_, body = get(t, off, "GET", "/api/meta", nil)
	if _ = json.Unmarshal([]byte(body), &meta); meta.Capabilities.Live != "none" {
		t.Fatalf("capabilities.live = %q when live is off, want none", meta.Capabilities.Live)
	}
}
