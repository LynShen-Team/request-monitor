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

func TestLoad(t *testing.T) {
	t.Setenv("OPSSCREEN_GATEWAY_DSN", "")
	t.Setenv("OPSSCREEN_LISTEN", "")
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
	t.Setenv("OPSSCREEN_GATEWAY_DSN", "postgres://env@h/db")
	cfg, err = Load(write(t, "listen = \"[::1]:9000\"\n[dev]\nviewer = \"admin\"\n"))
	if err != nil || cfg.Gateway.DSN != "postgres://env@h/db" {
		t.Fatalf("environment DSN: %v", err)
	}
}

func TestExampleFileLoads(t *testing.T) {
	t.Setenv("OPSSCREEN_GATEWAY_DSN", "")
	t.Setenv("OPSSCREEN_LISTEN", "")
	if _, err := Load("../../config.example.toml"); err != nil {
		t.Fatalf("config.example.toml does not load: %v", err)
	}
}
