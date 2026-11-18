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
	}
	for want, text := range cases {
		if _, err := Load(write(t, text)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("config %q: error %v, want one that mentions %q", text, err, want)
		}
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
