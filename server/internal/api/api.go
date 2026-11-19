// Package api is the HTTP surface of the service: the front end and four read-only JSON
// endpoints. Every answer is already reduced to what the visitor may see.
package api

import (
	"compress/gzip"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/LynShen-Team/request-monitor/internal/config"
	"github.com/LynShen-Team/request-monitor/internal/gateway"
	"github.com/LynShen-Team/request-monitor/internal/geo"
	"github.com/LynShen-Team/request-monitor/internal/identity"
	"github.com/LynShen-Team/request-monitor/internal/screen"
)

// Server serves the screen.
type Server struct {
	cfg         *config.Config
	screen      *screen.Service
	identity    *identity.Service
	live        *screen.Live
	caps        gateway.Capabilities
	kind        string
	attribution *geo.Attribution
	geoReady    bool
	backfilling func() bool
	web         fs.FS
	log         *slog.Logger
	mux         *http.ServeMux
	// The Content-Security-Policy of every response, and of the embed page (spec OS-SH7).
	policy      string
	embedPolicy string
}

// policyWith is the Content-Security-Policy of the service with the given frame-ancestors.
func policyWith(ancestors string) string {
	return "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors " + ancestors + "; base-uri 'none'; form-action 'none'"
}

// Options are the parts the server is built from.
type Options struct {
	Config *config.Config
	Screen *screen.Service
	// Identity finds the visitor's role; nil means every visitor is a guest.
	Identity *identity.Service
	// Live answers live events; nil means the service has no live mode.
	Live        *screen.Live
	Adapter     gateway.Adapter
	Geo         geo.Resolver
	GeoReady    bool
	Backfilling func() bool
	Web         fs.FS
	Log         *slog.Logger
}

func New(o Options) *Server {
	s := &Server{
		cfg:         o.Config,
		screen:      o.Screen,
		identity:    o.Identity,
		live:        o.Live,
		caps:        o.Adapter.Capabilities(),
		kind:        o.Adapter.Kind(),
		attribution: o.Geo.Attribution(),
		geoReady:    o.GeoReady,
		backfilling: o.Backfilling,
		web:         o.Web,
		log:         o.Log,
		mux:         http.NewServeMux(),
		policy:      policyWith("'none'"),
		embedPolicy: policyWith("'none'"),
	}
	// The origins were checked when the configuration was read.
	var ancestors []string
	for _, ancestor := range s.cfg.Embed.Ancestors {
		if origin, err := config.Origin(ancestor); err == nil {
			ancestors = append(ancestors, origin)
		}
	}
	if len(ancestors) > 0 {
		s.embedPolicy = policyWith(strings.Join(ancestors, " "))
	}
	// Without a geo database no region can be shown, whatever the gateway records.
	s.caps.Origin = s.caps.Origin && s.geoReady
	if s.live == nil {
		s.caps.Live = "none"
	}
	s.mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	s.mux.HandleFunc("/api/identity", s.json(false, s.whoami))
	s.mux.HandleFunc("/api/config", s.json(false, s.screenConfig))
	s.mux.HandleFunc("/api/meta", s.json(true, s.meta))
	s.mux.HandleFunc("/api/topology", s.json(true, s.topology))
	s.mux.HandleFunc("/api/replay", s.json(true, s.replay))
	s.mux.HandleFunc("/api/live", s.json(true, s.liveEvents))
	s.mux.HandleFunc("/brand/logo-day", s.logo(o.Config.Screen.LogoDayFile, o.Config.Screen.LogoNightFile))
	s.mux.HandleFunc("/brand/logo-night", s.logo(o.Config.Screen.LogoNightFile, o.Config.Screen.LogoDayFile))
	s.mux.HandleFunc("/", s.static)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	// Only the embed page may be framed, and only by the pages of embed.ancestors.
	if r.URL.Path == "/embed" || r.URL.Path == "/embed/" {
		h.Set("Content-Security-Policy", s.embedPolicy)
	} else {
		h.Set("Content-Security-Policy", s.policy)
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mux.ServeHTTP(w, r)
}

// visitor decides who is looking, which view they receive, and whether they may open the screen
// at all (spec section 12). The role comes from the gateway session of the request; nothing the
// page states about itself is read. `dev.viewer = "admin"` skips identification for local work
// and is honoured on a loopback listener only.
func (s *Server) visitor(r *http.Request) (identity.Role, screen.Viewer, bool) {
	if s.cfg.Dev.Viewer == "admin" && s.cfg.Loopback() {
		return identity.Admin, screen.Admin, true
	}
	switch s.identity.Identify(r) {
	case identity.Admin:
		return identity.Admin, screen.Admin, true
	case identity.User:
		return identity.User, screen.Restricted, true
	}
	return identity.Guest, screen.Restricted, s.cfg.GuestsAllowed()
}

type apiError struct {
	status int
	code   string
}

func (e *apiError) Error() string { return e.code }

// json wraps an endpoint. A gated endpoint is refused to a visitor who must sign in first.
func (s *Server) json(gated bool, handler func(r *http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		// The answer depends on the visitor's session, and no page of another origin may read it.
		w.Header().Set("Vary", "Cookie, Authorization")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		var value any
		var err error
		if _, _, allowed := s.visitor(r); gated && !allowed {
			err = &apiError{http.StatusUnauthorized, "login_required"}
		} else {
			value, err = handler(r)
		}
		if err != nil {
			status, code := http.StatusInternalServerError, "internal_error"
			if e, ok := err.(*apiError); ok {
				status, code = e.status, e.code
			} else {
				s.log.Error("request failed", "path", r.URL.Path, "error", err)
			}
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
			return
		}
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Cookie, Authorization, Accept-Encoding")
			zw := gzip.NewWriter(w)
			defer zw.Close()
			_ = json.NewEncoder(zw).Encode(value)
			return
		}
		_ = json.NewEncoder(w).Encode(value)
	}
}

// whoami answers the visitor's role and whether they may open the screen (spec OS-SN5).
func (s *Server) whoami(r *http.Request) (any, error) {
	role, _, allowed := s.visitor(r)
	answer := map[string]any{"role": string(role), "allowed": allowed}
	if !allowed && s.cfg.Access.LoginURL != "" {
		answer["loginUrl"] = s.cfg.Access.LoginURL
	}
	return answer, nil
}

// DefaultTitle is the page title when the configuration sets none (spec OS-U5, OS-B9). It matches
// DEFAULT_CONFIG in web/src/core/config.ts.
const DefaultTitle = "Request Monitor"

// screenConfig answers a ScreenConfig of web/src/core/config.ts (spec OS-SH2, OS-SH6).
func (s *Server) screenConfig(_ *http.Request) (any, error) {
	screen := s.cfg.Screen
	out := map[string]any{"title": screen.Title}
	if screen.Title == "" {
		out["title"] = DefaultTitle
	}
	if screen.Note != "" {
		out["note"] = screen.Note
	}
	if screen.LogoDayFile != "" || screen.LogoNightFile != "" {
		out["logo"] = map[string]string{"day": "/brand/logo-day", "night": "/brand/logo-night"}
	}
	if s.attribution != nil {
		out["attribution"] = map[string]string{"text": s.attribution.Text, "url": s.attribution.Href}
	}
	return out, nil
}

func (s *Server) meta(_ *http.Request) (any, error) {
	return map[string]any{
		"gateway":      s.kind,
		"capabilities": s.caps,
		"minClients":   s.cfg.Geo.MinClients,
		"backfilling":  s.backfilling(),
	}, nil
}

func (s *Server) topology(r *http.Request) (any, error) {
	_, viewer, _ := s.visitor(r)
	view, err := s.screen.View(r.Context(), viewer)
	if err != nil {
		return nil, err
	}
	return map[string]any{"version": view.Version, "topology": view.Topology, "baseline24h": view.Baseline}, nil
}

func (s *Server) replay(r *http.Request) (any, error) {
	window := r.URL.Query().Get("window")
	if !screen.ValidWindow(window) {
		return nil, &apiError{http.StatusBadRequest, "invalid_window"}
	}
	_, viewer, _ := s.visitor(r)
	view, err := s.screen.View(r.Context(), viewer)
	if err != nil {
		return nil, err
	}
	return map[string]any{"version": view.Version, "data": view.Replay[window]}, nil
}

// liveEvents answers the live events after a cursor (spec OS-SR6).
func (s *Server) liveEvents(r *http.Request) (any, error) {
	if s.live == nil {
		return nil, &apiError{http.StatusNotFound, "live_unavailable"}
	}
	_, viewer, _ := s.visitor(r)
	return s.live.Answer(r.Context(), viewer, r.URL.Query().Get("after"))
}

// logo serves a configured image file; fallback is used when the first is not set.
func (s *Server) logo(primary, fallback string) http.HandlerFunc {
	name := primary
	if name == "" {
		name = fallback
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if name == "" {
			http.NotFound(w, r)
			return
		}
		file, err := os.Open(name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "max-age=300")
		http.ServeContent(w, r, path.Base(name), info.ModTime(), file)
	}
}

// static serves the front end; a path that is not a file is the page itself.
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if info, err := fs.Stat(s.web, name); err != nil || info.IsDir() {
		name = "index.html"
	}
	if name == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeFileFS(w, r, s.web, name)
}
