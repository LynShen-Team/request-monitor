package lynshen_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/LynShen-Team/request-monitor/internal/gateway/lynshen"
	"github.com/LynShen-Team/request-monitor/internal/identity"
)

// fakeGateway stands in for the gateway's GET /api/dashboard/auth/me.
type fakeGateway struct {
	*httptest.Server
	mu   sync.Mutex
	seen []string
}

func newGateway(t *testing.T) *fakeGateway {
	t.Helper()
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"role":"admin"}`))
	}))
	t.Cleanup(elsewhere.Close)
	g := &fakeGateway{}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		g.seen = append(g.seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization")+" cookie="+r.Header.Get("Cookie"))
		g.mu.Unlock()
		if r.URL.Path != "/api/dashboard/auth/me" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") {
		case "tok-admin":
			_, _ = w.Write([]byte(`{"id":"1","username":"a","role":"admin"}`))
		case "tok-super":
			_, _ = w.Write([]byte(`{"role":"super_admin"}`))
		case "tok-user":
			_, _ = w.Write([]byte(`{"role":"user","email_required":true}`))
		case "tok-other":
			_, _ = w.Write([]byte(`{"role":"operator"}`))
		case "tok-norole":
			_, _ = w.Write([]byte(`{"username":"x"}`))
		case "tok-html":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<html>admin</html>`))
		case "tok-500":
			http.Error(w, "boom", http.StatusInternalServerError)
		case "tok-403":
			http.Error(w, `{"error":"email_unverified"}`, http.StatusForbidden)
		case "tok-redirect":
			http.Redirect(w, r, elsewhere.URL, http.StatusFound)
		case "tok-slow":
			time.Sleep(600 * time.Millisecond)
			_, _ = w.Write([]byte(`{"role":"admin"}`))
		default:
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		}
	}))
	t.Cleanup(g.Close)
	return g
}

func TestVerify(t *testing.T) {
	g := newGateway(t)
	v, err := lynshen.NewVerifier(g.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		token    string
		role     identity.Role
		answered bool
	}{
		{"tok-admin", identity.Admin, true},
		{"tok-super", identity.Admin, true},
		{"tok-user", identity.User, true},
		{"tok-other", identity.User, true},
		{"tok-unknown", identity.Guest, true},
		{"tok-403", identity.Guest, true},
		{"tok-norole", identity.Guest, false},
		{"tok-html", identity.Guest, false},
		{"tok-500", identity.Guest, false},
		// A redirect is not followed, even to a place that would say "admin".
		{"tok-redirect", identity.Guest, false},
	}
	for _, c := range cases {
		role, answered := v.Verify(context.Background(), c.token)
		if role != c.role || answered != c.answered {
			t.Errorf("%s: %s answered=%v, want %s answered=%v", c.token, role, answered, c.role, c.answered)
		}
	}
	// A gateway that does not answer in time gives no role.
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if role, answered := v.Verify(ctx, "tok-slow"); role != identity.Guest || answered {
		t.Errorf("a slow gateway: %s answered=%v", role, answered)
	}
	// The gateway receives the token as a Bearer header on the one path, and no cookie.
	g.mu.Lock()
	first := g.seen[0]
	g.mu.Unlock()
	if first != "GET /api/dashboard/auth/me Bearer tok-admin cookie=" {
		t.Fatalf("the gateway received %q", first)
	}
	// A gateway that is not there gives no role.
	g.Close()
	if role, answered := v.Verify(context.Background(), "tok-admin"); role != identity.Guest || answered {
		t.Errorf("a gateway that is down: %s answered=%v", role, answered)
	}
}

func TestCredential(t *testing.T) {
	v, err := lynshen.NewVerifier("http://gateway.invalid")
	if err != nil {
		t.Fatal(err)
	}
	build := func(cookie, authorization string) *http.Request {
		r := httptest.NewRequest("GET", "/api/identity?monoize_session=tok-query&role=admin", nil)
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
		}
		if authorization != "" {
			r.Header.Set("Authorization", authorization)
		}
		r.Header.Set("X-Role", "admin")
		return r
	}
	cases := []struct{ cookie, authorization, want string }{
		{"", "", ""},
		{"monoize_session=tok-a", "", "tok-a"},
		{"theme=dark; monoize_session=tok-a; other=1", "", "tok-a"},
		{"", "Bearer tok-b", "tok-b"},
		{"monoize_session=tok-a", "Bearer tok-b", "tok-a"},
		{"other_session=tok-a", "", ""},
		{"", "Basic dXNlcjpwYXNz", ""},
		{"", "bearer tok-b", ""},
		{"monoize_session=", "", ""},
		{"", "Bearer tok with space", ""},
		{"", "Bearer tok\"quoted", ""},
		{"monoize_session=" + strings.Repeat("a", 600), "", ""},
	}
	for _, c := range cases {
		if got := v.Credential(build(c.cookie, c.authorization)); got != c.want {
			t.Errorf("cookie %q, authorization %q: credential %q, want %q", c.cookie, c.authorization, got, c.want)
		}
	}
}

func TestNewVerifierChecksTheURL(t *testing.T) {
	for _, bad := range []string{"", "gateway:8080", "ftp://gateway/", "/api", "http://"} {
		if _, err := lynshen.NewVerifier(bad); err == nil {
			t.Errorf("the API URL %q was accepted", bad)
		}
	}
}
