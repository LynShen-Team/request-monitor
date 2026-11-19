package api_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/LynShen-Team/request-monitor/internal/api"
	"github.com/LynShen-Team/request-monitor/internal/config"
	"github.com/LynShen-Team/request-monitor/internal/devseed"
	"github.com/LynShen-Team/request-monitor/internal/testenv"
	"github.com/LynShen-Team/request-monitor/internal/webui"
)

func server(env *testenv.Env, cfg *config.Config) *api.Server {
	cfg.Geo.MinClients = 3
	return api.New(api.Options{
		Config:      cfg,
		Screen:      env.Screen,
		Adapter:     env.Adapter,
		Geo:         env.Geo,
		GeoReady:    true,
		Backfilling: env.Ingest.Backfilling,
		Web:         webui.Dist(),
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
}

// roleOf reads the role of an /api/identity answer.
func roleOf(t *testing.T, body string) string {
	t.Helper()
	var answer struct {
		Role    string
		Allowed *bool
	}
	if err := json.Unmarshal([]byte(body), &answer); err != nil || answer.Allowed == nil {
		t.Fatalf("identity answer %q: %v", body, err)
	}
	return answer.Role
}

func get(t *testing.T, s *api.Server, method, path string, headers map[string]string) (*http.Response, string) {
	t.Helper()
	request := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		request.Header.Set(k, v)
	}
	recorder := httptest.NewRecorder()
	s.ServeHTTP(recorder, request)
	response := recorder.Result()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, string(body)
}

func TestAPI(t *testing.T) {
	env := testenv.New(t, testenv.Options{Days: 2, PerDay: 6000, BackfillDays: 1})
	guest := server(env, &config.Config{Listen: "127.0.0.1:8787"})

	response, body := get(t, guest, "GET", "/api/identity", nil)
	if response.StatusCode != 200 || roleOf(t, body) != "guest" {
		t.Fatalf("identity: %d %s", response.StatusCode, body)
	}
	if response.Header.Get("Cache-Control") != "no-store" || !strings.Contains(response.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") || response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers: %v", response.Header)
	}
	// Nothing the browser sends raises the role.
	_, body = get(t, guest, "GET", "/api/identity?role=admin&as=admin", map[string]string{"X-Role": "admin", "Authorization": "Bearer admin", "Cookie": "role=admin"})
	if roleOf(t, body) != "guest" {
		t.Fatalf("a browser raised its own role: %s", body)
	}

	response, body = get(t, guest, "GET", "/api/replay?window=1y", nil)
	if response.StatusCode != 400 || !strings.Contains(body, "invalid_window") {
		t.Fatalf("invalid window: %d %s", response.StatusCode, body)
	}
	if response, _ = get(t, guest, "POST", "/api/topology", nil); response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", response.StatusCode)
	}

	var topology struct {
		Version  string
		Topology struct {
			Routes []struct {
				Group, Channel string
				Upstream       *string
				Restricted     bool
			}
		}
	}
	_, body = get(t, guest, "GET", "/api/topology", nil)
	if err := json.Unmarshal([]byte(body), &topology); err != nil || topology.Version == "" || len(topology.Topology.Routes) == 0 {
		t.Fatalf("topology: %v %s", err, body)
	}
	_, replay := get(t, guest, "GET", "/api/replay?window=24h", nil)
	var replayAnswer struct {
		Version string
		Data    struct{ Buckets []json.RawMessage }
	}
	if err := json.Unmarshal([]byte(replay), &replayAnswer); err != nil || replayAnswer.Version != topology.Version || len(replayAnswer.Data.Buckets) != 288 {
		t.Fatalf("replay: %v, version %q vs %q, %d buckets", err, replayAnswer.Version, topology.Version, len(replayAnswer.Data.Buckets))
	}
	for _, name := range devseed.RestrictedChannelNames() {
		if strings.Contains(body, name) || strings.Contains(replay, name) {
			t.Errorf("a guest received the restricted Channel %q", name)
		}
	}

	// dev.viewer = admin on a loopback listener serves the admin view.
	admin := server(env, &config.Config{Listen: "127.0.0.1:8787", Dev: config.Dev{Viewer: "admin"}})
	_, body = get(t, admin, "GET", "/api/identity", nil)
	if roleOf(t, body) != "admin" {
		t.Fatalf("dev admin identity: %s", body)
	}
	_, body = get(t, admin, "GET", "/api/topology", nil)
	if !strings.Contains(body, devseed.RestrictedChannelNames()[0]) {
		t.Fatal("the admin view lacks a restricted Channel")
	}
	// The same setting on a public listener is not honoured even if validation was skipped.
	exposed := server(env, &config.Config{Listen: "0.0.0.0:8787", Dev: config.Dev{Viewer: "admin"}})
	if _, body = get(t, exposed, "GET", "/api/identity", nil); roleOf(t, body) != "guest" {
		t.Fatalf("dev admin on a public listener: %s", body)
	}

	var meta struct {
		Gateway      string
		Capabilities struct {
			Live                string
			Origin, Errors      bool
			DurationPrecisionMs int
		}
		MinClients  int
		Backfilling bool
	}
	_, body = get(t, guest, "GET", "/api/meta", nil)
	if err := json.Unmarshal([]byte(body), &meta); err != nil || meta.Gateway != "lynshen" || meta.Capabilities.Live != "none" || !meta.Capabilities.Origin || !meta.Capabilities.Errors || meta.Capabilities.DurationPrecisionMs != 1 || meta.MinClients != 3 || meta.Backfilling {
		t.Fatalf("meta: %v %s", err, body)
	}
	_, body = get(t, guest, "GET", "/api/config", nil)
	if strings.TrimSpace(body) != `{"title":"Request Monitor"}` {
		t.Fatalf("config: %s", body)
	}

	// gzip when asked.
	response, _ = get(t, guest, "GET", "/api/replay?window=30d", map[string]string{"Accept-Encoding": "gzip"})
	if response.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("the replay answer is not compressed")
	}
	// An unknown path serves the page; an unknown API path does not.
	if response, body = get(t, guest, "GET", "/some/page", nil); response.StatusCode != 200 || !strings.Contains(body, "<html") {
		t.Fatalf("page fallback: %d", response.StatusCode)
	}
	if response, _ = get(t, guest, "GET", "/api/nothing", nil); response.StatusCode != 404 {
		t.Fatalf("unknown API path: %d", response.StatusCode)
	}
}

// Only the embed page may be framed, and only by the configured pages (OS-SH7).
func TestEmbedFraming(t *testing.T) {
	env := testenv.New(t, testenv.Options{Days: 1, PerDay: 200, BackfillDays: 1})
	plain := server(env, &config.Config{Listen: "127.0.0.1:8787"})
	framed := server(env, &config.Config{Listen: "127.0.0.1:8787", Embed: config.Embed{Ancestors: []string{"https://www.example.test", "https://Docs.Example.test/"}}})
	policy := func(s *api.Server, path string) string {
		response, _ := get(t, s, "GET", path, nil)
		return response.Header.Get("Content-Security-Policy")
	}
	for _, path := range []string{"/", "/embed", "/embed/", "/api/identity", "/api/live", "/embedded", "/embed/x", "/assets/x.js"} {
		if got := policy(plain, path); !strings.Contains(got, "frame-ancestors 'none';") {
			t.Errorf("no ancestors configured, %s: %s", path, got)
		}
	}
	for _, path := range []string{"/embed", "/embed/", "/embed?lang=en&theme=day"} {
		if got := policy(framed, path); !strings.Contains(got, "frame-ancestors https://www.example.test https://docs.example.test;") || !strings.Contains(got, "script-src 'self';") {
			t.Errorf("embed page %s: %s", path, got)
		}
	}
	for _, path := range []string{"/", "/api/identity", "/api/live", "/embedded", "/embed/x", "/assets/x.js", "/?embed=1"} {
		if got := policy(framed, path); !strings.Contains(got, "frame-ancestors 'none';") {
			t.Errorf("only the embed page may be framed, %s: %s", path, got)
		}
	}
	if response, _ := get(t, framed, "GET", "/embed", nil); response.StatusCode != http.StatusOK {
		t.Fatalf("the embed page is the page itself: %d", response.StatusCode)
	}
}
