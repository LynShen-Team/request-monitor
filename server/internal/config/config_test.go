package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, text string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// clearEnv empties every environment variable the configuration reads.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{EnvGatewayDSN, EnvListen, LegacyEnvGatewayDSN, LegacyEnvListen} {
		t.Setenv(name, "")
	}
}

func TestLoad(t *testing.T) {
	clearEnv(t)
	cfg, err := Load(write(t, "[gateway]\ndsn = \"postgres://u@h/db\"\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != "127.0.0.1:8787" || cfg.Geo.MinClients != 3 || cfg.Ingest.BackfillDays != 30 || cfg.Ingest.LookbackMinutes != 90 || !cfg.Loopback() {
		t.Fatalf("defaults: %+v", cfg)
	}
	cases := map[string]string{
		"gateway.dsn is empty":   "listen = \"127.0.0.1:1\"\n",
		"unknown key":            "[gateway]\ndsn = \"postgres://u@h/db\"\nsecret = 1\n",
		"loopback":               "listen = \"0.0.0.0:8787\"\n[gateway]\ndsn = \"postgres://u@h/db\"\n[dev]\nviewer = \"admin\"\n",
		"not supported":          "[gateway]\nkind = \"other\"\ndsn = \"postgres://u@h/db\"\n",
		"timezone":               "timezone = \"Nowhere/City\"\n[gateway]\ndsn = \"postgres://u@h/db\"\n",
		"backfill_days":          "[gateway]\ndsn = \"postgres://u@h/db\"\n[ingest]\nbackfill_days = 400\n",
		"dev.viewer must be":     "[gateway]\ndsn = \"postgres://u@h/db\"\n[dev]\nviewer = \"root\"\n",
		"[[upstream]] entry has": "[gateway]\ndsn = \"postgres://u@h/db\"\n[[upstream]]\nname = \"x\"\n",
		"gateway.api_url must":   "[gateway]\ndsn = \"postgres://u@h/db\"\napi_url = \"gateway:8080\"\n",
		"access.login_url must":  "[gateway]\ndsn = \"postgres://u@h/db\"\n[access]\nlogin_url = \"javascript:alert(1)\"\n",
		"live.interval_seconds":  "[gateway]\ndsn = \"postgres://u@h/db\"\n[live]\ninterval_seconds = 600\n",
		"live.window_minutes":    "[gateway]\ndsn = \"postgres://u@h/db\"\n[live]\nwindow_minutes = 1\n",
		"needs gateway.api_url":  "[gateway]\ndsn = \"postgres://u@h/db\"\n[access]\nguests = false\n",
		"embed.ancestors":        "[gateway]\ndsn = \"postgres://u@h/db\"\n[embed]\nancestors = [\"https://www.example.com/home\"]\n",
	}
	// Only one plain origin is an ancestor: no path, wildcard, keyword, or second source.
	for _, bad := range []string{"https://www.example.com/home", "www.example.com", "ftp://example.com", "*", "https://*.example.com", "https://a.example.com 'unsafe-inline'", "https://a.example.com;script-src *", "https://u@a.example.com", "https://a.example.com/?x=1", "'self'"} {
		if _, err := Origin(bad); err == nil {
			t.Errorf("origin %q was accepted", bad)
		}
	}
	for value, want := range map[string]string{"https://www.example.com": "https://www.example.com", " https://WWW.Example.com/ ": "https://www.example.com", "http://127.0.0.1:5173": "http://127.0.0.1:5173"} {
		if got, err := Origin(value); err != nil || got != want {
			t.Errorf("origin %q: %q %v, want %q", value, got, err, want)
		}
	}
	for want, text := range cases {
		if _, err := Load(write(t, text)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("config %q: error %v, want one that mentions %q", text, err, want)
		}
	}
	if !cfg.LiveEnabled() || cfg.Live.IntervalSeconds != 2 || cfg.Live.WindowMinutes != 15 {
		t.Fatalf("live defaults: %+v", cfg.Live)
	}
	// Guests are let in unless the configuration says otherwise.
	if !cfg.GuestsAllowed() {
		t.Fatal("guests must be allowed by default")
	}
	closed, err := Load(write(t, "[gateway]\ndsn = \"postgres://u@h/db\"\napi_url = \"http://127.0.0.1:8080\"\n[access]\nguests = false\nlogin_url = \"https://console.example.com/login\"\n"))
	if err != nil || closed.GuestsAllowed() {
		t.Fatalf("access.guests = false: %v", err)
	}
	// The DSN can come from the environment, and dev admin is accepted on loopback.
	t.Setenv(EnvGatewayDSN, "postgres://env@h/db")
	cfg, err = Load(write(t, "listen = \"[::1]:9000\"\n[dev]\nviewer = \"admin\"\n"))
	if err != nil || cfg.Gateway.DSN != "postgres://env@h/db" || len(cfg.LegacyEnv) != 0 {
		t.Fatalf("environment DSN: %v %+v", err, cfg)
	}
}

// The variables from before the rename still work, and the current names win over them (OS-B9).
func TestLegacyEnv(t *testing.T) {
	clearEnv(t)
	t.Setenv(LegacyEnvGatewayDSN, "postgres://legacy@h/db")
	t.Setenv(LegacyEnvListen, "127.0.0.1:9002")
	cfg, err := Load(write(t, "[gateway]\ndsn = \"postgres://file@h/db\"\n"))
	if err != nil || cfg.Gateway.DSN != "postgres://legacy@h/db" || cfg.Listen != "127.0.0.1:9002" ||
		strings.Join(cfg.LegacyEnv, ",") != LegacyEnvGatewayDSN+","+LegacyEnvListen {
		t.Fatalf("legacy names: %v %+v", err, cfg)
	}
	t.Setenv(EnvGatewayDSN, "postgres://current@h/db")
	t.Setenv(EnvListen, "127.0.0.1:9001")
	cfg, err = Load(write(t, "[gateway]\ndsn = \"postgres://file@h/db\"\n"))
	if err != nil || cfg.Gateway.DSN != "postgres://current@h/db" || cfg.Listen != "127.0.0.1:9001" || len(cfg.LegacyEnv) != 0 {
		t.Fatalf("current names must win: %v %+v", err, cfg)
	}
}

func TestExampleFileLoads(t *testing.T) {
	clearEnv(t)
	if _, err := Load("../../config.example.toml"); err != nil {
		t.Fatalf("config.example.toml does not load: %v", err)
	}
}
