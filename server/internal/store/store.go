// Package store is the service's own database: 5-minute rollups and the small dictionaries they
// refer to. It holds counts only. No client address, user, key, payload, or upstream host name is
// ever written here (spec OS-B3, OS-B4).
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"request-monitor/internal/gateway"
	"request-monitor/internal/geo"
	"request-monitor/internal/hist"
)

// FileName is the store's file in the data directory (spec OS-SS1). LegacyFileName is the name it
// had before the project was renamed (spec OS-B9).
const (
	FileName       = "request-monitor.db"
	LegacyFileName = "opsscreen.db"
)

// PathIn returns the store's file in dataDir: FileName, or LegacyFileName when only the legacy file
// exists, so that a data directory written before the rename keeps its rollups.
func PathIn(dataDir string) string {
	path := filepath.Join(dataDir, FileName)
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		return path
	}
	legacy := filepath.Join(dataDir, LegacyFileName)
	if _, err := os.Stat(legacy); err == nil {
		return legacy
	}
	return path
}

// BucketSeconds is the rollup step.
const BucketSeconds = 300

// Region levels.
const (
	LevelCountry  = 0
	LevelProvince = 1
	LevelCity     = 2
)

// RejectedRoute is the route id of requests the gateway rejected before it selected a Channel.
const RejectedRoute int64 = 0

const schema = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS route (
  id INTEGER PRIMARY KEY,
  gkey TEXT NOT NULL, ckey TEXT NOT NULL,
  gname TEXT NOT NULL, cname TEXT NOT NULL,
  restricted INTEGER NOT NULL,
  site INTEGER NOT NULL DEFAULT 0,
  UNIQUE (gkey, ckey)
);
CREATE TABLE IF NOT EXISTS site (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, region TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL,
  anycast INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS region (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  level INTEGER NOT NULL,
  name TEXT NOT NULL,
  parent INTEGER NOT NULL DEFAULT 0,
  lat REAL NOT NULL, lon REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS model (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS rollup_route (
  bucket INTEGER NOT NULL, route INTEGER NOT NULL, status INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (bucket, route, status)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rollup_origin (
  bucket INTEGER NOT NULL, region INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (bucket, region)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rollup_model (
  bucket INTEGER NOT NULL, model INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (bucket, model)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rollup_ttfb (
  bucket INTEGER NOT NULL, route INTEGER NOT NULL, bins BLOB NOT NULL,
  PRIMARY KEY (bucket, route)
) WITHOUT ROWID;
-- One row per day, finest region, and client fingerprint. A fingerprint is a keyed hash of the
-- client address with a key that is random per day and deleted with the rows when the day is
-- finalized, so it cannot be turned back into an address or followed across days.
CREATE TABLE IF NOT EXISTS client_seen (
  day INTEGER NOT NULL, region INTEGER NOT NULL, client INTEGER NOT NULL,
  PRIMARY KEY (day, region, client)
) WITHOUT ROWID;
-- Distinct clients per finalized day and region, at every level.
CREATE TABLE IF NOT EXISTS region_day (
  day INTEGER NOT NULL, region INTEGER NOT NULL, clients INTEGER NOT NULL,
  PRIMARY KEY (day, region)
) WITHOUT ROWID;
`

// Store is the service's SQLite database.
type Store struct {
	db  *sql.DB
	loc *time.Location

	// dictionaries guards the two maps: the ingest and the live reader both add entries.
	dictionaries sync.Mutex
	regionIDs    map[string]int64
	modelIDs     map[string]int64
}

// Open opens (and creates) the database file. loc decides where a day begins.
func Open(path string, loc *time.Location) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(10000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, fmt.Errorf("store: open: %w", err)
	}
	// One connection: SQLite has one writer, and readers here are short.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: schema: %w", err)
	}
	s := &Store{db: db, loc: loc, regionIDs: map[string]int64{}, modelIDs: map[string]int64{}}
	if err := s.loadDictionaries(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Location is the time zone in which days are counted.
func (s *Store) Location() *time.Location { return s.loc }

// Bucket is the rollup bucket that holds t.
func Bucket(t time.Time) int64 { return t.Unix() / BucketSeconds }

// BucketStart is the first instant of a bucket.
func BucketStart(bucket int64) time.Time { return time.Unix(bucket*BucketSeconds, 0) }

// Day is the calendar day of t in the store's time zone, as yyyymmdd.
func (s *Store) Day(t time.Time) int {
	y, m, d := t.In(s.loc).Date()
	return y*10000 + int(m)*100 + d
}

// DayRange is [first instant of day, first instant of the next day).
func (s *Store) DayRange(day int) (time.Time, time.Time) {
	start := time.Date(day/10000, time.Month(day/100%100), day%100, 0, 0, 0, 0, s.loc)
	return start, start.AddDate(0, 0, 1)
}

// PrevDay is the day before day.
func (s *Store) PrevDay(day int) int {
	start, _ := s.DayRange(day)
	return s.Day(start.AddDate(0, 0, -1))
}

func (s *Store) loadDictionaries() error {
	rows, err := s.db.Query(`SELECT key, id FROM region`)
	if err != nil {
		return fmt.Errorf("store: regions: %w", err)
	}
	for rows.Next() {
		var key string
		var id int64
		if err := rows.Scan(&key, &id); err != nil {
			rows.Close()
			return err
		}
		s.regionIDs[key] = id
	}
	rows.Close()
	rows, err = s.db.Query(`SELECT name, id FROM model`)
	if err != nil {
		return fmt.Errorf("store: models: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var id int64
		if err := rows.Scan(&name, &id); err != nil {
			return err
		}
		s.modelIDs[name] = id
	}
	return rows.Err()
}

// ---- meta ----

func (s *Store) Meta(key string) (string, bool, error) {
	var v string
	err := s.db.QueryRow(`SELECT v FROM meta WHERE k = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v, err == nil, err
}

func (s *Store) SetMeta(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, key, value)
	return err
}

func (s *Store) deleteMeta(tx *sql.Tx, key string) error {
	_, err := tx.Exec(`DELETE FROM meta WHERE k = ?`, key)
	return err
}

// ---- dictionaries ----

const keySep = "\x1f"

func (s *Store) ensureRegionRow(key string, level int, name string, parent int64, lat, lon float64) (int64, error) {
	s.dictionaries.Lock()
	defer s.dictionaries.Unlock()
	if id, ok := s.regionIDs[key]; ok {
		return id, nil
	}
	res, err := s.db.Exec(`INSERT INTO region (key, level, name, parent, lat, lon) VALUES (?, ?, ?, ?, ?, ?)`, key, level, name, parent, lat, lon)
	if err != nil {
		return 0, fmt.Errorf("store: region: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	s.regionIDs[key] = id
	return id, nil
}

// EnsureRegion returns the id of the finest region of place, creating the country, province, and
// city rows that do not exist yet.
func (s *Store) EnsureRegion(place geo.Place) (int64, error) {
	countryKey := place.CountryCode
	id, err := s.ensureRegionRow(countryKey, LevelCountry, place.Country, 0, place.Lat, place.Lon)
	if err != nil {
		return 0, err
	}
	if place.Province != "" {
		id, err = s.ensureRegionRow(countryKey+keySep+place.Province, LevelProvince, place.Province, id, place.Lat, place.Lon)
		if err != nil {
			return 0, err
		}
	}
	if place.City != "" {
		id, err = s.ensureRegionRow(countryKey+keySep+place.Province+keySep+place.City, LevelCity, place.City, id, place.Lat, place.Lon)
		if err != nil {
			return 0, err
		}
	}
	return id, nil
}

// EnsureModel returns the id of a model name.
func (s *Store) EnsureModel(name string) (int64, error) {
	s.dictionaries.Lock()
	defer s.dictionaries.Unlock()
	if id, ok := s.modelIDs[name]; ok {
		return id, nil
	}
	res, err := s.db.Exec(`INSERT INTO model (name) VALUES (?)`, name)
	if err != nil {
		return 0, fmt.Errorf("store: model: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	s.modelIDs[name] = id
	return id, nil
}

// Route is one Group · Channel pair the service has seen.
type Route struct {
	ID          int64
	GroupKey    string
	ChannelKey  string
	GroupName   string
	ChannelName string
	Restricted  bool
	// Site is the upstream site id, or 0 when the place of the Channel is unknown.
	Site int64
}

// RouteKey identifies a route by the gateway's keys.
type RouteKey struct{ Group, Channel string }

// UnknownRouteKey collects requests served by a Channel that the gateway no longer lists. Its
// name is all the service can say about them, and it is restricted, because nothing is known
// about the Group it belonged to.
var UnknownRouteKey = RouteKey{Group: "", Channel: ""}

// SyncRoutes stores the gateway's current Channels and returns the route id of each. A route that
// the gateway no longer lists keeps its row, so old rollups still have a name.
func (s *Store) SyncRoutes(channels []gateway.Channel) (map[RouteKey]int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	upsert := `INSERT INTO route (gkey, ckey, gname, cname, restricted) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (gkey, ckey) DO UPDATE SET gname = excluded.gname, cname = excluded.cname, restricted = excluded.restricted`
	if _, err := tx.Exec(`INSERT INTO route (gkey, ckey, gname, cname, restricted) VALUES ('', '', '其他', '已下线的渠道', 1)
ON CONFLICT (gkey, ckey) DO NOTHING`); err != nil {
		return nil, fmt.Errorf("store: routes: %w", err)
	}
	for _, c := range channels {
		if _, err := tx.Exec(upsert, c.GroupKey, c.ChannelKey, c.GroupName, c.ChannelName, boolInt(c.Restricted)); err != nil {
			return nil, fmt.Errorf("store: routes: %w", err)
		}
	}
	rows, err := tx.Query(`SELECT id, gkey, ckey FROM route`)
	if err != nil {
		return nil, err
	}
	ids := map[RouteKey]int64{}
	for rows.Next() {
		var id int64
		var key RouteKey
		if err := rows.Scan(&id, &key.Group, &key.Channel); err != nil {
			rows.Close()
			return nil, err
		}
		ids[key] = id
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, tx.Commit()
}

// Routes lists every route, oldest first.
func (s *Store) Routes() ([]Route, error) {
	rows, err := s.db.Query(`SELECT id, gkey, ckey, gname, cname, restricted, site FROM route ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Route
	for rows.Next() {
		var r Route
		var restricted int
		if err := rows.Scan(&r.ID, &r.GroupKey, &r.ChannelKey, &r.GroupName, &r.ChannelName, &restricted, &r.Site); err != nil {
			return nil, err
		}
		r.Restricted = restricted != 0
		out = append(out, r)
	}
	return out, rows.Err()
}

// Site is a place where upstream servers are.
type Site struct {
	ID       int64
	Key      string
	Name     string
	Region   string
	Lat, Lon float64
	Anycast  bool
}

// EnsureSite returns the id of the site with this key, creating or updating it.
func (s *Store) EnsureSite(site Site) (int64, error) {
	_, err := s.db.Exec(`INSERT INTO site (key, name, region, lat, lon, anycast) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, region = excluded.region, lat = excluded.lat, lon = excluded.lon, anycast = excluded.anycast`,
		site.Key, site.Name, site.Region, site.Lat, site.Lon, boolInt(site.Anycast))
	if err != nil {
		return 0, fmt.Errorf("store: site: %w", err)
	}
	var id int64
	err = s.db.QueryRow(`SELECT id FROM site WHERE key = ?`, site.Key).Scan(&id)
	return id, err
}

// SetRouteSite records where a route's upstream is; site 0 means unknown.
func (s *Store) SetRouteSite(route, site int64) error {
	_, err := s.db.Exec(`UPDATE route SET site = ? WHERE id = ?`, site, route)
	return err
}

// Sites lists every site by id.
func (s *Store) Sites() (map[int64]Site, error) {
	rows, err := s.db.Query(`SELECT id, key, name, region, lat, lon, anycast FROM site`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]Site{}
	for rows.Next() {
		var site Site
		var anycast int
		if err := rows.Scan(&site.ID, &site.Key, &site.Name, &site.Region, &site.Lat, &site.Lon, &anycast); err != nil {
			return nil, err
		}
		site.Anycast = anycast != 0
		out[site.ID] = site
	}
	return out, rows.Err()
}

// Region is a country, a province, or a city.
type Region struct {
	ID       int64
	Level    int
	Name     string
	Parent   int64
	Lat, Lon float64
}

// Regions lists every region by id.
func (s *Store) Regions() (map[int64]Region, error) {
	rows, err := s.db.Query(`SELECT id, level, name, parent, lat, lon FROM region`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]Region{}
	for rows.Next() {
		var r Region
		if err := rows.Scan(&r.ID, &r.Level, &r.Name, &r.Parent, &r.Lat, &r.Lon); err != nil {
			return nil, err
		}
		out[r.ID] = r
	}
	return out, rows.Err()
}

// Models lists every model name by id.
func (s *Store) Models() (map[int64]string, error) {
	rows, err := s.db.Query(`SELECT id, name FROM model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

// ---- rollups ----

type RouteCell struct {
	Bucket, Route int64
	Status        gateway.Status
}
type OriginCell struct{ Bucket, Region int64 }
type ModelCell struct{ Bucket, Model int64 }
type TTFBCell struct{ Bucket, Route int64 }
type ClientCell struct {
	Day    int
	Region int64
}

// Aggregate is everything the service keeps of the requests of one time range.
type Aggregate struct {
	Route   map[RouteCell]int64
	Origin  map[OriginCell]int64
	Model   map[ModelCell]int64
	TTFB    map[TTFBCell]*hist.H
	Clients map[ClientCell]map[int64]struct{}
}

func NewAggregate() *Aggregate {
	return &Aggregate{
		Route:   map[RouteCell]int64{},
		Origin:  map[OriginCell]int64{},
		Model:   map[ModelCell]int64{},
		TTFB:    map[TTFBCell]*hist.H{},
		Clients: map[ClientCell]map[int64]struct{}{},
	}
}

// ReplaceRange makes the rollups of buckets [from, to) equal to agg, in one transaction, so a
// range can be computed again at any time without counting a request twice. Client fingerprints
// are a set and are only added; those of a finalized day are ignored.
func (s *Store) ReplaceRange(from, to int64, agg *Aggregate) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, table := range []string{"rollup_route", "rollup_origin", "rollup_model", "rollup_ttfb"} {
		if _, err := tx.Exec(`DELETE FROM `+table+` WHERE bucket >= ? AND bucket < ?`, from, to); err != nil {
			return fmt.Errorf("store: replace %s: %w", table, err)
		}
	}
	insert := func(query string) (*sql.Stmt, error) { return tx.Prepare(query) }
	routeStmt, err := insert(`INSERT INTO rollup_route (bucket, route, status, n) VALUES (?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer routeStmt.Close()
	for cell, n := range agg.Route {
		if _, err := routeStmt.Exec(cell.Bucket, cell.Route, int(cell.Status), n); err != nil {
			return fmt.Errorf("store: replace route: %w", err)
		}
	}
	originStmt, err := insert(`INSERT INTO rollup_origin (bucket, region, n) VALUES (?, ?, ?)`)
	if err != nil {
		return err
	}
	defer originStmt.Close()
	for cell, n := range agg.Origin {
		if _, err := originStmt.Exec(cell.Bucket, cell.Region, n); err != nil {
			return fmt.Errorf("store: replace origin: %w", err)
		}
	}
	modelStmt, err := insert(`INSERT INTO rollup_model (bucket, model, n) VALUES (?, ?, ?)`)
	if err != nil {
		return err
	}
	defer modelStmt.Close()
	for cell, n := range agg.Model {
		if _, err := modelStmt.Exec(cell.Bucket, cell.Model, n); err != nil {
			return fmt.Errorf("store: replace model: %w", err)
		}
	}
	ttfbStmt, err := insert(`INSERT INTO rollup_ttfb (bucket, route, bins) VALUES (?, ?, ?)`)
	if err != nil {
		return err
	}
	defer ttfbStmt.Close()
	for cell, h := range agg.TTFB {
		if _, err := ttfbStmt.Exec(cell.Bucket, cell.Route, h.Encode()); err != nil {
			return fmt.Errorf("store: replace ttfb: %w", err)
		}
	}
	clientStmt, err := insert(`INSERT OR IGNORE INTO client_seen (day, region, client) VALUES (?, ?, ?)`)
	if err != nil {
		return err
	}
	defer clientStmt.Close()
	final := map[int]bool{}
	for cell, clients := range agg.Clients {
		isFinal, known := final[cell.Day]
		if !known {
			var one int
			err := tx.QueryRow(`SELECT 1 FROM meta WHERE k = ?`, finalKey(cell.Day)).Scan(&one)
			isFinal = err == nil
			final[cell.Day] = isFinal
		}
		if isFinal {
			continue
		}
		for client := range clients {
			if _, err := clientStmt.Exec(cell.Day, cell.Region, client); err != nil {
				return fmt.Errorf("store: replace clients: %w", err)
			}
		}
	}
	return tx.Commit()
}

// Prune deletes rollups older than bucket and the per-day client counts older than day.
func (s *Store) Prune(bucket int64, day int) error {
	for _, table := range []string{"rollup_route", "rollup_origin", "rollup_model", "rollup_ttfb"} {
		if _, err := s.db.Exec(`DELETE FROM `+table+` WHERE bucket < ?`, bucket); err != nil {
			return err
		}
	}
	if _, err := s.db.Exec(`DELETE FROM region_day WHERE day < ?`, day); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM client_seen WHERE day < ?`, day)
	return err
}

// EachRoute calls fn for every route rollup row of buckets [from, to).
func (s *Store) EachRoute(ctx context.Context, from, to int64, fn func(bucket, route int64, status gateway.Status, n int64)) error {
	rows, err := s.db.QueryContext(ctx, `SELECT bucket, route, status, n FROM rollup_route WHERE bucket >= ? AND bucket < ?`, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var bucket, route, n int64
		var status int
		if err := rows.Scan(&bucket, &route, &status, &n); err != nil {
			return err
		}
		fn(bucket, route, gateway.Status(status), n)
	}
	return rows.Err()
}

// EachOrigin calls fn for every origin rollup row of buckets [from, to).
func (s *Store) EachOrigin(ctx context.Context, from, to int64, fn func(bucket, region, n int64)) error {
	return s.each3(ctx, `SELECT bucket, region, n FROM rollup_origin WHERE bucket >= ? AND bucket < ?`, from, to, fn)
}

// EachModel calls fn for every model rollup row of buckets [from, to).
func (s *Store) EachModel(ctx context.Context, from, to int64, fn func(bucket, model, n int64)) error {
	return s.each3(ctx, `SELECT bucket, model, n FROM rollup_model WHERE bucket >= ? AND bucket < ?`, from, to, fn)
}

func (s *Store) each3(ctx context.Context, query string, from, to int64, fn func(a, b, c int64)) error {
	rows, err := s.db.QueryContext(ctx, query, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var a, b, c int64
		if err := rows.Scan(&a, &b, &c); err != nil {
			return err
		}
		fn(a, b, c)
	}
	return rows.Err()
}

// EachTTFB calls fn for every TTFB histogram of buckets [from, to).
func (s *Store) EachTTFB(ctx context.Context, from, to int64, fn func(bucket, route int64, h *hist.H)) error {
	rows, err := s.db.QueryContext(ctx, `SELECT bucket, route, bins FROM rollup_ttfb WHERE bucket >= ? AND bucket < ?`, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var bucket, route int64
		var bins []byte
		if err := rows.Scan(&bucket, &route, &bins); err != nil {
			return err
		}
		h, err := hist.Decode(bins)
		if err != nil {
			return err
		}
		fn(bucket, route, h)
	}
	return rows.Err()
}

// ---- distinct clients per day ----

func saltKey(day int) string  { return "salt:" + strconv.Itoa(day) }
func finalKey(day int) string { return "final:" + strconv.Itoa(day) }

// Salt returns the random key of a day's client fingerprints, creating it on first use.
func (s *Store) Salt(day int) ([]byte, error) {
	if v, ok, err := s.Meta(saltKey(day)); err != nil {
		return nil, err
	} else if ok {
		return hex.DecodeString(v)
	}
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	return salt, s.SetMeta(saltKey(day), hex.EncodeToString(salt))
}

// DayFinal reports whether a day's client counts are final.
func (s *Store) DayFinal(day int) (bool, error) {
	_, ok, err := s.Meta(finalKey(day))
	return ok, err
}

// ResetDay forgets a day's client counts, so that the day can be computed again from the gateway.
func (s *Store) ResetDay(day int) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, query := range []string{`DELETE FROM client_seen WHERE day = ?`, `DELETE FROM region_day WHERE day = ?`} {
		if _, err := tx.Exec(query, day); err != nil {
			return err
		}
	}
	if err := s.deleteMeta(tx, finalKey(day)); err != nil {
		return err
	}
	if err := s.deleteMeta(tx, saltKey(day)); err != nil {
		return err
	}
	return tx.Commit()
}

// ClientCounts returns the number of distinct clients of a day per region, at every level: a
// client counts once for its city, once for the province of that city, and once for the country.
func (s *Store) ClientCounts(day int) (map[int64]int, error) {
	if final, err := s.DayFinal(day); err != nil {
		return nil, err
	} else if final {
		rows, err := s.db.Query(`SELECT region, clients FROM region_day WHERE day = ?`, day)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := map[int64]int{}
		for rows.Next() {
			var region int64
			var clients int
			if err := rows.Scan(&region, &clients); err != nil {
				return nil, err
			}
			out[region] = clients
		}
		return out, rows.Err()
	}
	return s.countClients(s.db, day)
}

type querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func (s *Store) countClients(q querier, day int) (map[int64]int, error) {
	regions, err := s.Regions()
	if err != nil {
		return nil, err
	}
	rows, err := q.Query(`SELECT region, client FROM client_seen WHERE day = ?`, day)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sets := map[int64]map[int64]struct{}{}
	for rows.Next() {
		var region, client int64
		if err := rows.Scan(&region, &client); err != nil {
			return nil, err
		}
		for id, hops := region, 0; id != 0 && hops < 4; id, hops = regions[id].Parent, hops+1 {
			set := sets[id]
			if set == nil {
				set = map[int64]struct{}{}
				sets[id] = set
			}
			set[client] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make(map[int64]int, len(sets))
	for id, set := range sets {
		out[id] = len(set)
	}
	return out, nil
}

// FinalizeDay stores a day's distinct-client counts and deletes its fingerprints and their key.
func (s *Store) FinalizeDay(day int) error {
	counts, err := s.countClients(s.db, day)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM region_day WHERE day = ?`, day); err != nil {
		return err
	}
	for region, clients := range counts {
		if _, err := tx.Exec(`INSERT INTO region_day (day, region, clients) VALUES (?, ?, ?)`, day, region, clients); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM client_seen WHERE day = ?`, day); err != nil {
		return err
	}
	if err := s.deleteMeta(tx, saltKey(day)); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO meta (k, v) VALUES (?, '1') ON CONFLICT (k) DO UPDATE SET v = '1'`, finalKey(day)); err != nil {
		return err
	}
	return tx.Commit()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
