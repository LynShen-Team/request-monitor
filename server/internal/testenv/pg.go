package testenv

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// PostgresDSN is the database that tests may fill, or "" when none is offered. It is named by
// REQUEST_MONITOR_TEST_PG_DSN, or by its legacy name OPSSCREEN_TEST_PG_DSN (spec OS-ST2, OS-B9).
func PostgresDSN() string {
	if v := os.Getenv("REQUEST_MONITOR_TEST_PG_DSN"); v != "" {
		return v
	}
	return os.Getenv("OPSSCREEN_TEST_PG_DSN")
}

// The three tables of the gateway that the adapter reads, with the column types the gateway's
// own schema gives them (text ids, bigint milliseconds, integer flags).
const postgresSchema = `
CREATE TABLE monoize_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0, user_selectable INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 1, account_class TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE monoize_providers (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, public_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL,
  channel_public_name TEXT NOT NULL, channel_base_url TEXT NOT NULL,
  channel_enabled INTEGER NOT NULL DEFAULT 1, channel_proxy_url TEXT);
CREATE TABLE request_logs (
  id TEXT PRIMARY KEY, request_id TEXT, user_id TEXT NOT NULL, api_key_id TEXT, model TEXT NOT NULL,
  provider_id TEXT, channel_id TEXT, is_stream INTEGER NOT NULL, status TEXT NOT NULL,
  error_code TEXT, error_message TEXT, duration_ms BIGINT, ttfb_ms BIGINT, request_ip TEXT,
  request_kind TEXT, created_at TEXT NOT NULL, created_at_unix_ms BIGINT, tried_providers_json TEXT);
CREATE INDEX request_logs_time ON request_logs (created_at_unix_ms);
`

var copies = []struct {
	table   string
	columns string
	n       int
}{
	{"monoize_groups", "id, name, account_class, sort_order", 4},
	{"monoize_providers", "id, group_id, name, public_name, channel_id, channel_name, channel_public_name, channel_base_url", 8},
	{"request_logs", "id, request_id, user_id, api_key_id, model, provider_id, channel_id, is_stream, status, error_code, error_message, duration_ms, ttfb_ms, request_ip, request_kind, created_at, created_at_unix_ms, tried_providers_json", 18},
}

// LoadPostgres copies a demo gateway file into a fresh schema of the PostgreSQL database dsn and
// returns a DSN whose search path is that schema. The schema is dropped when the test ends.
func LoadPostgres(t testing.TB, fixture, dsn string) string {
	t.Helper()
	random := make([]byte, 6)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := "request_monitor_test_" + hex.EncodeToString(random)
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	scoped := parsed.String()

	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`)
		_ = admin.Close()
	})

	pg, err := sql.Open("pgx", scoped)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err := pg.Exec(postgresSchema); err != nil {
		t.Fatal(err)
	}
	source, err := sql.Open("sqlite", "file:"+fixture+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	tx, err := pg.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, c := range copies {
		rows, err := source.Query(`SELECT ` + c.columns + ` FROM ` + c.table)
		if err != nil {
			t.Fatal(err)
		}
		placeholders := ""
		for i := 1; i <= c.n; i++ {
			if i > 1 {
				placeholders += ", "
			}
			placeholders += "$" + itoa(i)
		}
		insert, err := tx.Prepare(`INSERT INTO ` + c.table + ` (` + c.columns + `) VALUES (` + placeholders + `)`)
		if err != nil {
			t.Fatal(err)
		}
		values := make([]any, c.n)
		pointers := make([]any, c.n)
		for i := range values {
			pointers[i] = &values[i]
		}
		for rows.Next() {
			if err := rows.Scan(pointers...); err != nil {
				t.Fatal(err)
			}
			if _, err := insert.Exec(values...); err != nil {
				t.Fatal(err)
			}
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		insert.Close()
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return scoped
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}
