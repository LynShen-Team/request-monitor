package api_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"opsscreen/internal/api"
	"opsscreen/internal/config"
	"opsscreen/internal/devseed"
	"opsscreen/internal/gateway/lynshen"
	"opsscreen/internal/identity"
	"opsscreen/internal/testenv"
	"opsscreen/internal/webui"
)

// fakeGateway answers GET /api/dashboard/auth/me like the gateway: a role for a known session
// token, 401 for anything else.
func fakeGateway(t *testing.T) *httptest.Server {
	t.Helper()
	roles := map[string]string{"Bearer session-admin": "super_admin", "Bearer session-user": "user"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, ok := roles[r.Header.Get("Authorization")]
		if r.URL.Path != "/api/dashboard/auth/me" || !ok {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"role": role})
	}))
	t.Cleanup(server.Close)
	return server
}

func identified(t *testing.T, env *testenv.Env, gatewayURL string, cfg *config.Config) *api.Server {
	t.Helper()
	verifier, err := lynshen.NewVerifier(gatewayURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Listen = "127.0.0.1:8787"
	cfg.Geo.MinClients = 3
	return api.New(api.Options{
		Config:      cfg,
		Screen:      env.Screen,
		Identity:    identity.New(verifier),
		Adapter:     env.Adapter,
		Geo:         env.Geo,
		GeoReady:    true,
		Backfilling: env.Ingest.Backfilling,
		Web:         webui.Dist(),
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
}

type who struct {
	Role     string
	Allowed  bool
	LoginURL string `json:"loginUrl"`
}

func whoIs(t *testing.T, s *api.Server, headers map[string]string) who {
	t.Helper()
	_, body := get(t, s, "GET", "/api/identity", headers)
	var answer who
	if err := json.Unmarshal([]byte(body), &answer); err != nil {
		t.Fatalf("identity: %v %s", err, body)
	}
	return answer
}

func TestRoleComesFromTheGatewaySession(t *testing.T) {
	env := testenv.New(t, testenv.Options{Days: 2, PerDay: 6000, BackfillDays: 1})
	gateway := fakeGateway(t)
	s := identified(t, env, gateway.URL, &config.Config{})
	secret := devseed.RestrictedChannelNames()[0]

	admin := map[string]string{"Cookie": "monoize_session=session-admin"}
	user := map[string]string{"Cookie": "theme=night; monoize_session=session-user"}
	stale := map[string]string{"Cookie": "monoize_session=session-expired"}

	if got := whoIs(t, s, admin); got.Role != "admin" || !got.Allowed {
		t.Fatalf("an admin session: %+v", got)
	}
	response, body := get(t, s, "GET", "/api/topology", admin)
	if !strings.Contains(body, secret) {
		t.Fatal("an admin does not receive the restricted Channel names")
	}
	if response.Header.Get("Vary") != "Cookie, Authorization" || response.Header.Get("Cross-Origin-Resource-Policy") != "same-origin" || response.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("headers of an answer: %v", response.Header)
	}
	var adminVersion, userVersion struct{ Version string }
	_ = json.Unmarshal([]byte(body), &adminVersion)

	// A signed-in user, a visitor with a stale session, and a visitor without one all receive the
	// restricted view.
	for label, headers := range map[string]map[string]string{"user": user, "stale session": stale, "no session": nil} {
		_, body := get(t, s, "GET", "/api/topology", headers)
		_, replay := get(t, s, "GET", "/api/replay?window=24h", headers)
		for _, name := range devseed.RestrictedChannelNames() {
			if strings.Contains(body, name) || strings.Contains(replay, name) {
				t.Errorf("%s: received the restricted Channel %q", label, name)
			}
		}
		_ = json.Unmarshal([]byte(body), &userVersion)
		if userVersion.Version == "" || userVersion.Version == adminVersion.Version {
			t.Errorf("%s: the restricted view carries the admin view's version", label)
		}
	}
	if got := whoIs(t, s, user); got.Role != "user" || !got.Allowed {
		t.Fatalf("a user session: %+v", got)
	}
	if got := whoIs(t, s, stale); got.Role != "guest" || !got.Allowed {
		t.Fatalf("a stale session: %+v", got)
	}
	// The same session as a Bearer header.
	if got := whoIs(t, s, map[string]string{"Authorization": "Bearer session-admin"}); got.Role != "admin" {
		t.Fatalf("a Bearer session: %+v", got)
	}
	// Nothing but the session decides: a guest cannot talk itself into a role.
	claim := map[string]string{"X-Role": "admin", "X-Forwarded-User": "admin", "Cookie": "role=admin; monoize_session=session-expired"}
	_, body = get(t, s, "GET", "/api/identity?role=admin&as=admin", claim)
	if roleOf(t, body) != "guest" {
		t.Fatalf("a visitor raised its own role: %s", body)
	}

	// When the gateway cannot be asked, a session that was not seen before is a guest.
	gateway.Close()
	if got := whoIs(t, s, map[string]string{"Authorization": "Bearer session-user"}); got.Role != "user" {
		t.Fatalf("an answer of the last 60 s must still be used: %+v", got)
	}
	down := identified(t, env, gateway.URL, &config.Config{})
	if got := whoIs(t, down, admin); got.Role != "guest" {
		t.Fatalf("with the gateway down an admin session gave %+v, want guest", got)
	}
	_, body = get(t, down, "GET", "/api/topology", admin)
	if strings.Contains(body, secret) {
		t.Fatal("with the gateway down the admin view was served")
	}
}

func TestGuestsCanBeKeptOut(t *testing.T) {
	env := testenv.New(t, testenv.Options{Days: 2, PerDay: 6000, BackfillDays: 1})
	gateway := fakeGateway(t)
	no := false
	s := identified(t, env, gateway.URL, &config.Config{Access: config.Access{Guests: &no, LoginURL: "https://console.example.com/login"}})

	if got := whoIs(t, s, nil); got.Role != "guest" || got.Allowed || got.LoginURL != "https://console.example.com/login" {
		t.Fatalf("a guest who must sign in: %+v", got)
	}
	for _, path := range []string{"/api/topology", "/api/replay?window=24h", "/api/meta"} {
		response, body := get(t, s, "GET", path, map[string]string{"Cookie": "monoize_session=session-expired"})
		if response.StatusCode != http.StatusUnauthorized || !strings.Contains(body, "login_required") || len(body) > 40 {
			t.Errorf("%s for a guest: %d %s", path, response.StatusCode, body)
		}
	}
	// The page and its presentation are served to everyone: the sign-in notice needs them.
	if response, _ := get(t, s, "GET", "/api/config", nil); response.StatusCode != 200 {
		t.Errorf("/api/config for a guest: %d", response.StatusCode)
	}
	if response, _ := get(t, s, "GET", "/", nil); response.StatusCode != 200 {
		t.Errorf("the page for a guest: %d", response.StatusCode)
	}
	// Anyone who is signed in may open the screen; a user still receives the restricted view.
	user := map[string]string{"Cookie": "monoize_session=session-user"}
	if got := whoIs(t, s, user); got.Role != "user" || !got.Allowed || got.LoginURL != "" {
		t.Fatalf("a signed-in user: %+v", got)
	}
	response, body := get(t, s, "GET", "/api/topology", user)
	if response.StatusCode != 200 || strings.Contains(body, devseed.RestrictedChannelNames()[0]) {
		t.Fatalf("topology for a signed-in user: %d", response.StatusCode)
	}
	if response, _ := get(t, s, "GET", "/api/replay?window=7d", map[string]string{"Cookie": "monoize_session=session-admin"}); response.StatusCode != 200 {
		t.Fatalf("replay for an admin: %d", response.StatusCode)
	}
}
