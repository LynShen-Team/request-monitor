package lynshen_test

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"request-monitor/internal/gateway"
	"request-monitor/internal/gateway/lynshen"
	"request-monitor/internal/testenv"
)

func TestLiveRequestsOnDemoFile(t *testing.T) {
	fixture := demo(t)
	writer, err := sql.Open("sqlite", "file:"+fixture)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	checkLive(t, "sqlite://"+fixture, writer, "?")
}

func TestLiveRequestsOnPostgres(t *testing.T) {
	dsn := testenv.PostgresDSN()
	if dsn == "" {
		t.Skip("REQUEST_MONITOR_TEST_PG_DSN is not set")
	}
	scoped := testenv.LoadPostgres(t, demo(t), dsn)
	writer, err := sql.Open("pgx", scoped)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	checkLive(t, scoped, writer, "$1")
}

// checkLive reads the demo through LiveRequests, then makes the database refuse the statement
// that lists failed attempts and checks that the adapter goes on without them.
func checkLive(t *testing.T, dsn string, writer *sql.DB, placeholder string) {
	t.Helper()
	ctx := context.Background()
	adapter, err := lynshen.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer adapter.Close()
	channels, err := adapter.Channels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	groupOf := map[string]string{}
	for _, c := range channels {
		groupOf[c.ChannelKey] = c.GroupKey
	}
	from, to := testenv.Now.Add(-72*time.Hour), testenv.Now.Add(time.Hour)

	var plain int
	if err := adapter.Requests(ctx, from, to, func(*gateway.Request) error { plain++; return nil }); err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	var withAttempts, attemptsOnErrors int
	read := func() int {
		n := 0
		err := adapter.LiveRequests(ctx, from, to, func(r *gateway.Request) error {
			n++
			if r.ID == "" {
				t.Fatal("a request without an identity")
			}
			ids[r.ID] = true
			if len(r.Attempts) > 0 {
				withAttempts++
				if r.Status == gateway.StatusError {
					attemptsOnErrors++
				}
			}
			for _, attempt := range r.Attempts {
				// An attempt names a Channel of the same Group and its duration, nothing else.
				if r.Route == nil || groupOf[attempt.Route.ChannelKey] == "" || attempt.Route.GroupKey != r.Route.GroupKey || attempt.DurationMs <= 0 {
					t.Fatalf("attempt %+v of a request served by %+v", attempt, r.Route)
				}
				if r.Status != gateway.StatusError && attempt.Route.ChannelKey == r.Route.ChannelKey {
					t.Fatalf("the serving Channel %q is listed as a failed attempt", r.Route.ChannelKey)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := read(); n != plain || len(ids) != plain || plain == 0 {
		t.Fatalf("the live read gave %d requests with %d identities, the plain read %d", n, len(ids), plain)
	}
	if withAttempts == 0 || attemptsOnErrors == 0 || withAttempts > plain/10 {
		t.Fatalf("%d of %d requests have failed attempts (%d of them ended in an error)", withAttempts, plain, attemptsOnErrors)
	}
	if adapter.AttemptsUnavailable() {
		t.Fatal("the adapter gave up the failed attempts although the database listed them")
	}

	// A row whose text is not JSON makes the database refuse the statement.
	query := strings.ReplaceAll(`UPDATE request_logs SET tried_providers_json = 'not json {' WHERE id = ?`, "?", placeholder)
	if _, err := writer.Exec(query, "req-00000007"); err != nil {
		t.Fatal(err)
	}
	// The read that meets the refusal starts over without the attempts, so it may hand over the
	// rows it had already read a second time; every request is still there.
	if n := read(); n < plain || len(ids) != plain {
		t.Fatalf("the read that met the refusal gave %d requests, want every one of %d", n, plain)
	}
	if !adapter.AttemptsUnavailable() {
		t.Fatal("the adapter did not note that failed attempts are unavailable")
	}
	// From then on the adapter reads without them.
	withAttempts = 0
	if n := read(); n != plain || withAttempts != 0 {
		t.Fatalf("after the refusal: %d requests (want %d), %d still carry attempts", n, plain, withAttempts)
	}
}
