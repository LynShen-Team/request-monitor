// Package lynshen reads a LynShen gateway: the tables request_logs, monoize_providers, and
// monoize_groups of its PostgreSQL database. It issues SELECT statements only, each inside a
// read-only transaction.
package lynshen

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"opsscreen/internal/gateway"
)

// Adapter implements gateway.Adapter for LynShen.
type Adapter struct {
	db *sql.DB
	// postgres is false only for the SQLite fixture used by tests and by `opsscreen devseed`.
	postgres bool

	mu     sync.Mutex
	groups map[string]string // provider id -> group id, refreshed by Channels
}

// Open connects to the gateway database. dsn is `postgres://…` (or `postgresql://…`) in every
// real deployment. `sqlite://<path>` opens a fixture file that has the same three tables; it
// exists for tests and local demos, because LynShen itself runs on PostgreSQL only.
func Open(dsn string) (*Adapter, error) {
	a := &Adapter{groups: map[string]string{}}
	var err error
	switch {
	case strings.HasPrefix(dsn, "postgres://"), strings.HasPrefix(dsn, "postgresql://"):
		a.postgres = true
		a.db, err = sql.Open("pgx", dsn)
	case strings.HasPrefix(dsn, "sqlite://"):
		a.db, err = sql.Open("sqlite", "file:"+strings.TrimPrefix(dsn, "sqlite://")+"?mode=ro&_pragma=busy_timeout(5000)")
	default:
		return nil, fmt.Errorf("lynshen: the gateway DSN must start with postgres:// or postgresql://")
	}
	if err != nil {
		return nil, fmt.Errorf("lynshen: open: %w", err)
	}
	a.db.SetMaxOpenConns(2)
	a.db.SetConnMaxIdleTime(5 * time.Minute)
	return a, nil
}

func (a *Adapter) Kind() string { return "lynshen" }

func (a *Adapter) Capabilities() gateway.Capabilities {
	// Live is "none" until the live step is built (spec OS-B2b).
	return gateway.Capabilities{Live: "none", Origin: true, Errors: true, DurationPrecisionMs: 1}
}

func (a *Adapter) Close() error { return a.db.Close() }

// begin opens a read-only transaction. On PostgreSQL the server itself then refuses any write,
// whatever the privileges of the account, and a statement may run for at most 60 s.
func (a *Adapter) begin(ctx context.Context) (*sql.Tx, error) {
	if !a.postgres {
		return a.db.BeginTx(ctx, nil)
	}
	tx, err := a.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "SET LOCAL statement_timeout = '60s'"); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	return tx, nil
}

// bind turns `?` placeholders into `$1`, `$2`, … for PostgreSQL.
func (a *Adapter) bind(query string) string {
	if !a.postgres {
		return query
	}
	var b strings.Builder
	n := 0
	for _, r := range query {
		if r == '?' {
			n++
			fmt.Fprintf(&b, "$%d", n)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

const channelsQuery = `
SELECT p.id, p.group_id, COALESCE(g.name, ''), p.public_name, p.channel_public_name,
       p.channel_base_url, COALESCE(g.account_class, '')
FROM monoize_providers p
LEFT JOIN monoize_groups g ON g.id = p.group_id`

// Channels lists every Provider with its Group. A Provider row embeds its Channel
// (request-logs.spec.md RL-MIG-2), so one Provider is one Group · Channel pair.
func (a *Adapter) Channels(ctx context.Context) ([]gateway.Channel, error) {
	tx, err := a.begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("lynshen: channels: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, channelsQuery)
	if err != nil {
		return nil, fmt.Errorf("lynshen: channels: %w", err)
	}
	defer rows.Close()
	var out []gateway.Channel
	groups := map[string]string{}
	for rows.Next() {
		var id, groupID, groupName, publicName, channelPublicName, baseURL, class string
		if err := rows.Scan(&id, &groupID, &groupName, &publicName, &channelPublicName, &baseURL, &class); err != nil {
			return nil, fmt.Errorf("lynshen: channels: %w", err)
		}
		groups[id] = groupID
		out = append(out, gateway.Channel{
			GroupKey:    groupID,
			GroupName:   firstNonEmpty(groupName, "-"),
			ChannelKey:  id,
			ChannelName: firstNonEmpty(publicName, channelPublicName, "-"),
			BaseURL:     baseURL,
			// groups-registry.spec.md GR-E1: the class is standard, enterprise, private, or agent.
			// Only standard and enterprise Groups show their Channels to everyone; an unknown or
			// missing class is restricted.
			Restricted: class != "standard" && class != "enterprise",
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("lynshen: channels: %w", err)
	}
	a.mu.Lock()
	a.groups = groups
	a.mu.Unlock()
	return out, nil
}

// The row is written when the request ends, but created_at_unix_ms is the time it began
// (request-logs.spec.md RL1c-1). Health probes of the gateway itself are left out (RL-API15).
// Legacy rows without created_at_unix_ms are not read.
const requestsQuery = `
SELECT created_at_unix_ms, COALESCE(request_ip, ''), model, COALESCE(provider_id, ''), status,
       ttfb_ms, duration_ms, COALESCE(error_code, '')
FROM request_logs
WHERE created_at_unix_ms >= ? AND created_at_unix_ms < ?
  AND (request_kind IS NULL OR request_kind <> 'active_probe_connectivity')`

func (a *Adapter) Requests(ctx context.Context, from, to time.Time, fn func(*gateway.Request) error) error {
	a.mu.Lock()
	groups := a.groups
	a.mu.Unlock()
	tx, err := a.begin(ctx)
	if err != nil {
		return fmt.Errorf("lynshen: requests: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, a.bind(requestsQuery), from.UnixMilli(), to.UnixMilli())
	if err != nil {
		return fmt.Errorf("lynshen: requests: %w", err)
	}
	defer rows.Close()
	var req gateway.Request
	var route gateway.RouteRef
	for rows.Next() {
		var startMs int64
		var ip, model, provider, status, errorCode string
		var ttfb, duration sql.NullInt64
		if err := rows.Scan(&startMs, &ip, &model, &provider, &status, &ttfb, &duration, &errorCode); err != nil {
			return fmt.Errorf("lynshen: requests: %w", err)
		}
		req = gateway.Request{Start: time.UnixMilli(startMs), ClientIP: ip, Model: model, ErrorCode: errorCode}
		switch status {
		case "success":
			req.Status = gateway.StatusSuccess
		case "error":
			req.Status = gateway.StatusError
		case "client_gone":
			req.Status = gateway.StatusClientGone
		default:
			// "pending" is never persisted (RL1a); any other value is not a terminal state.
			continue
		}
		if provider != "" {
			route = gateway.RouteRef{GroupKey: groups[provider], ChannelKey: provider}
			req.Route = &route
		}
		if ttfb.Valid && ttfb.Int64 >= 0 {
			req.TTFBMs, req.HasTTFB = ttfb.Int64, true
		}
		if duration.Valid && duration.Int64 >= 0 {
			req.DurationMs = duration.Int64
		}
		if err := fn(&req); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("lynshen: requests: %w", err)
	}
	return nil
}

// CountByBucket returns, straight from the gateway, the number of requests per 5-minute bucket,
// Provider, and status in [from, to). The reconcile command compares it with the service's own
// rollups.
func (a *Adapter) CountByBucket(ctx context.Context, from, to time.Time, fn func(bucket int64, provider, status string, n int64) error) error {
	tx, err := a.begin(ctx)
	if err != nil {
		return fmt.Errorf("lynshen: count: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	query := `
SELECT created_at_unix_ms / 300000, COALESCE(provider_id, ''), status, COUNT(*)
FROM request_logs
WHERE created_at_unix_ms >= ? AND created_at_unix_ms < ?
  AND (request_kind IS NULL OR request_kind <> 'active_probe_connectivity')
GROUP BY 1, 2, 3`
	rows, err := tx.QueryContext(ctx, a.bind(query), from.UnixMilli(), to.UnixMilli())
	if err != nil {
		return fmt.Errorf("lynshen: count: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var bucket, n int64
		var provider, status string
		if err := rows.Scan(&bucket, &provider, &status, &n); err != nil {
			return fmt.Errorf("lynshen: count: %w", err)
		}
		if err := fn(bucket, provider, status, n); err != nil {
			return err
		}
	}
	return rows.Err()
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}
