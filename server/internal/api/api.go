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

	"opsscreen/internal/config"
	"opsscreen/internal/gateway"
	"opsscreen/internal/geo"
	"opsscreen/internal/screen"
)

// Server serves the screen.
type Server struct {
	cfg         *config.Config
	screen      *screen.Service
	caps        gateway.Capabilities
	kind        string
	attribution *geo.Attribution
	geoReady    bool
	backfilling func() bool
	web         fs.FS
	log         *slog.Logger
	mux         *http.ServeMux
}

// Options are the parts the server is built from.
type Options struct {
	Config      *config.Config
	Screen      *screen.Service
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
		caps:        o.Adapter.Capabilities(),
		kind:        o.Adapter.Kind(),
		attribution: o.Geo.Attribution(),
		geoReady:    o.GeoReady,
		backfilling: o.Backfilling,
		web:         o.Web,
		log:         o.Log,
		mux:         http.NewServeMux(),
	}
	// Without a geo database no region can be shown, whatever the gateway records.
	s.caps.Origin = s.caps.Origin && s.geoReady
	s.mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	s.mux.HandleFunc("/api/identity", s.json(s.identity))
	s.mux.HandleFunc("/api/config", s.json(s.screenConfig))
	s.mux.HandleFunc("/api/meta", s.json(s.meta))
	s.mux.HandleFunc("/api/topology", s.json(s.topology))
	s.mux.HandleFunc("/api/replay", s.json(s.replay))
	s.mux.HandleFunc("/brand/logo-day", s.logo(o.Config.Screen.LogoDayFile, o.Config.Screen.LogoNightFile))
	s.mux.HandleFunc("/brand/logo-night", s.logo(o.Config.Screen.LogoNightFile, o.Config.Screen.LogoDayFile))
	s.mux.HandleFunc("/", s.static)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	// The screen is opened in its own tab; embedding it in another page is a later step.
	h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mux.ServeHTTP(w, r)
}

// role decides who is looking. The identity step (spec OS-B6) is not built yet: every visitor is
// a guest. `dev.viewer = "admin"` overrides that for local work and is accepted by the
// configuration only on a loopback listener. Nothing sent by the browser can raise the role.
func (s *Server) role(_ *http.Request) (string, screen.Viewer) {
	if s.cfg.Dev.Viewer == "admin" && s.cfg.Loopback() {
		return "admin", screen.Admin
	}
	return "guest", screen.Restricted
}

type apiError struct {
	status int
	code   string
}

func (e *apiError) Error() string { return e.code }

func (s *Server) json(handler func(r *http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		value, err := handler(r)
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
			w.Header().Add("Vary", "Accept-Encoding")
			zw := gzip.NewWriter(w)
			defer zw.Close()
			_ = json.NewEncoder(zw).Encode(value)
			return
		}
		_ = json.NewEncoder(w).Encode(value)
	}
}

func (s *Server) identity(r *http.Request) (any, error) {
	role, _ := s.role(r)
	return map[string]string{"role": role}, nil
}

// screenConfig answers a ScreenConfig of web/src/core/config.ts (spec OS-SH2, OS-SH6).
func (s *Server) screenConfig(_ *http.Request) (any, error) {
	screen := s.cfg.Screen
	out := map[string]any{"title": screen.Title}
	if screen.Title == "" {
		out["title"] = "数据大屏"
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
	_, viewer := s.role(r)
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
	_, viewer := s.role(r)
	view, err := s.screen.View(r.Context(), viewer)
	if err != nil {
		return nil, err
	}
	return map[string]any{"version": view.Version, "data": view.Replay[window]}, nil
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
