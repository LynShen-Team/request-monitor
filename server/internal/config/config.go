// Package config reads the service's settings from a TOML file and the environment.
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Config is the whole configuration. See config.example.toml for every key.
type Config struct {
	// Listen is the address the service listens on.
	Listen string `toml:"listen"`
	// DataDir holds the service's own database.
	DataDir string `toml:"data_dir"`
	// Timezone decides where a day begins; days matter for the distinct-client rule.
	Timezone string `toml:"timezone"`
	// WebDir serves the front end from a directory instead of the files built into the binary.
	WebDir string `toml:"web_dir"`

	Gateway  Gateway    `toml:"gateway"`
	Access   Access     `toml:"access"`
	Geo      Geo        `toml:"geo"`
	Ingest   Ingest     `toml:"ingest"`
	Live     Live       `toml:"live"`
	Embed    Embed      `toml:"embed"`
	Screen   Screen     `toml:"screen"`
	Upstream []Upstream `toml:"upstream"`
	Dev      Dev        `toml:"dev"`

	// LegacyEnv lists the legacy environment variables this configuration was read from (spec
	// OS-B9), so that the service can warn about them.
	LegacyEnv []string `toml:"-"`
}

// The environment variables the service reads. Each has a legacy name from before the project was
// renamed (spec OS-B9); the legacy name is read only when the current one is unset or empty.
const (
	EnvGatewayDSN       = "REQUEST_MONITOR_GATEWAY_DSN"
	EnvListen           = "REQUEST_MONITOR_LISTEN"
	LegacyEnvGatewayDSN = "OPSSCREEN_GATEWAY_DSN"
	LegacyEnvListen     = "OPSSCREEN_LISTEN"
)

// env returns the value of the variable name, or else of legacy, and whether it came from legacy.
func env(name, legacy string) (string, bool) {
	if v := os.Getenv(name); v != "" {
		return v, false
	}
	if v := os.Getenv(legacy); v != "" {
		return v, true
	}
	return "", false
}

type Gateway struct {
	// Kind is the adapter: "lynshen" (the only one built so far).
	Kind string `toml:"kind"`
	// DSN is the read-only connection string of the gateway database. The environment variable
	// REQUEST_MONITOR_GATEWAY_DSN (or its legacy name OPSSCREEN_GATEWAY_DSN) overrides it, so the
	// secret need not be in the file.
	DSN string `toml:"dsn"`
	// APIURL is the base URL of the gateway's own HTTP API. The service asks it who a visitor is
	// (spec section 12). Empty: every visitor is a guest.
	APIURL string `toml:"api_url"`
	// Where the gateway itself is, for the map.
	Name   string  `toml:"name"`
	Region string  `toml:"region"`
	Lat    float64 `toml:"lat"`
	Lon    float64 `toml:"lon"`
}

// Access is the guest setting (spec OS-SN5).
type Access struct {
	// Guests is false when a visitor who is not signed in to the gateway must not open the
	// screen. Not set: guests may open it and receive the restricted view.
	Guests *bool `toml:"guests"`
	// LoginURL is where such a visitor is sent to sign in.
	LoginURL string `toml:"login_url"`
}

type Geo struct {
	// MMDB is a MaxMind-format city database (DB-IP City Lite or GeoLite2-City).
	MMDB string `toml:"mmdb"`
	// Table is an optional CSV of networks (cidr,country_code,country,province,city,lat,lon)
	// that is asked before the database.
	Table string `toml:"table"`
	// Language is the preferred language of place names.
	Language string `toml:"language"`
	// MinClients is the number of distinct clients a region needs in a day to be shown.
	MinClients int `toml:"min_clients"`
}

// Live is live mode by replay (spec section 13).
type Live struct {
	// Enabled is false to turn live mode off. Not set: on.
	Enabled *bool `toml:"enabled"`
	// IntervalSeconds is the pause between two reads of recent requests.
	IntervalSeconds int `toml:"interval_seconds"`
	// WindowMinutes is how far back each read looks; a request that runs longer is not shown live.
	WindowMinutes int `toml:"window_minutes"`
}

// Embed is who may show the embed page in a frame (spec OS-SH7, docs/spec-screen.md OS-E1).
type Embed struct {
	// Ancestors are the origins (scheme://host[:port]) of the pages that may frame /embed.
	// Empty: no page may; every other page of the screen may never be framed.
	Ancestors []string `toml:"ancestors"`
}

type Ingest struct {
	BackfillDays    int `toml:"backfill_days"`
	LookbackMinutes int `toml:"lookback_minutes"`
	IntervalSeconds int `toml:"interval_seconds"`
}

// Screen is how the page presents itself (web/src/core/config.ts). The project carries no mark of
// its own; a deployment adds one here.
type Screen struct {
	// Title is shown in the header. Empty: the page's default title.
	Title string `toml:"title"`
	// Note is a short text beside the title.
	Note string `toml:"note"`
	// LogoDayFile and LogoNightFile are image files drawn left of the title on the day and the
	// night theme. With only one of them set, it is used on both themes.
	LogoDayFile   string `toml:"logo_day_file"`
	LogoNightFile string `toml:"logo_night_file"`
}

// Upstream fixes the place of the Channels whose base URL host matches Host. Without an entry the
// service resolves the host and looks its address up in the geo database once a day.
type Upstream struct {
	// Host is an exact host name, or a suffix that starts with a dot (".example.com").
	Host string `toml:"host"`
	// Hidden draws no upstream site for these Channels.
	Hidden bool `toml:"hidden"`
	// Anycast marks an address of a CDN edge: the place of the origin server is unknown.
	Anycast bool    `toml:"anycast"`
	Name    string  `toml:"name"`
	Region  string  `toml:"region"`
	Lat     float64 `toml:"lat"`
	Lon     float64 `toml:"lon"`
}

type Dev struct {
	// Viewer is "admin" to treat every visitor as an admin. It exists for local work before the
	// identity step is built, and is refused unless Listen is a loopback address.
	Viewer string `toml:"viewer"`
}

// Load reads path (when not empty), applies environment overrides and defaults, and validates.
func Load(path string) (*Config, error) {
	cfg := &Config{}
	if path != "" {
		meta, err := toml.DecodeFile(path, cfg)
		if err != nil {
			return nil, fmt.Errorf("config: %w", err)
		}
		if undecoded := meta.Undecoded(); len(undecoded) > 0 {
			return nil, fmt.Errorf("config: %s: unknown key %q", path, undecoded[0].String())
		}
	}
	if v, legacy := env(EnvGatewayDSN, LegacyEnvGatewayDSN); v != "" {
		cfg.Gateway.DSN = v
		if legacy {
			cfg.LegacyEnv = append(cfg.LegacyEnv, LegacyEnvGatewayDSN)
		}
	}
	if v, legacy := env(EnvListen, LegacyEnvListen); v != "" {
		cfg.Listen = v
		if legacy {
			cfg.LegacyEnv = append(cfg.LegacyEnv, LegacyEnvListen)
		}
	}
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8787"
	}
	if cfg.DataDir == "" {
		cfg.DataDir = "data"
	}
	if cfg.Timezone == "" {
		cfg.Timezone = "UTC"
	}
	if cfg.Gateway.Kind == "" {
		cfg.Gateway.Kind = "lynshen"
	}
	if cfg.Geo.Language == "" {
		cfg.Geo.Language = "zh-CN"
	}
	if cfg.Geo.MinClients == 0 {
		cfg.Geo.MinClients = 3
	}
	if cfg.Ingest.BackfillDays == 0 {
		cfg.Ingest.BackfillDays = 30
	}
	if cfg.Ingest.LookbackMinutes == 0 {
		cfg.Ingest.LookbackMinutes = 90
	}
	if cfg.Ingest.IntervalSeconds == 0 {
		cfg.Ingest.IntervalSeconds = 30
	}
	if cfg.Live.IntervalSeconds == 0 {
		cfg.Live.IntervalSeconds = 2
	}
	if cfg.Live.WindowMinutes == 0 {
		cfg.Live.WindowMinutes = 15
	}
	return cfg, cfg.validate()
}

func (c *Config) validate() error {
	if _, err := time.LoadLocation(c.Timezone); err != nil {
		return fmt.Errorf("config: timezone %q: %w", c.Timezone, err)
	}
	if c.Gateway.Kind != "lynshen" {
		return fmt.Errorf("config: gateway.kind %q is not supported; this build supports \"lynshen\"", c.Gateway.Kind)
	}
	if c.Gateway.DSN == "" {
		return fmt.Errorf("config: gateway.dsn is empty; set it in the file or in %s", EnvGatewayDSN)
	}
	if c.Geo.MinClients < 1 {
		return fmt.Errorf("config: geo.min_clients must be at least 1")
	}
	if c.Ingest.BackfillDays < 1 || c.Ingest.BackfillDays > 90 {
		return fmt.Errorf("config: ingest.backfill_days must be between 1 and 90")
	}
	if c.Live.IntervalSeconds < 1 || c.Live.IntervalSeconds > 60 {
		return fmt.Errorf("config: live.interval_seconds must be between 1 and 60")
	}
	if c.Live.WindowMinutes < 2 || c.Live.WindowMinutes > 120 {
		return fmt.Errorf("config: live.window_minutes must be between 2 and 120")
	}
	for key, value := range map[string]string{"gateway.api_url": c.Gateway.APIURL, "access.login_url": c.Access.LoginURL} {
		if value == "" {
			continue
		}
		if u, err := url.Parse(value); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("config: %s must be an http or https URL", key)
		}
	}
	for _, ancestor := range c.Embed.Ancestors {
		if _, err := Origin(ancestor); err != nil {
			return fmt.Errorf("config: embed.ancestors: %w", err)
		}
	}
	if !c.GuestsAllowed() && c.Gateway.APIURL == "" && c.Dev.Viewer != "admin" {
		return fmt.Errorf("config: access.guests = false needs gateway.api_url: without it nobody can be identified and nobody could open the screen")
	}
	switch c.Dev.Viewer {
	case "", "guest":
	case "admin":
		if !c.Loopback() {
			return fmt.Errorf("config: dev.viewer = \"admin\" is allowed only when listen is a loopback address, not %q", c.Listen)
		}
	default:
		return fmt.Errorf("config: dev.viewer must be \"guest\" or \"admin\"")
	}
	for _, u := range c.Upstream {
		if strings.TrimSpace(u.Host) == "" {
			return fmt.Errorf("config: an [[upstream]] entry has no host")
		}
	}
	return nil
}

// LiveEnabled reports whether live mode is on.
func (c *Config) LiveEnabled() bool { return c.Live.Enabled == nil || *c.Live.Enabled }

// Origin checks that value is one http or https origin with nothing after the host, and returns it
// as scheme://host[:port], the form a Content-Security-Policy source takes.
func Origin(value string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(u.Host, "*; '\"") {
		return "", fmt.Errorf("%q is not one http or https origin (scheme://host[:port])", value)
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), nil
}

// GuestsAllowed reports whether a visitor who is not signed in may open the screen.
func (c *Config) GuestsAllowed() bool { return c.Access.Guests == nil || *c.Access.Guests }

// Loopback reports whether the service listens on a loopback address only.
func (c *Config) Loopback() bool {
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Location is the configured time zone.
func (c *Config) Location() *time.Location {
	loc, err := time.LoadLocation(c.Timezone)
	if err != nil {
		return time.UTC
	}
	return loc
}
