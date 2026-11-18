// Package devseed writes a demo gateway: a SQLite file with the three LynShen tables the adapter
// reads, filled with invented requests, plus a network table that places the invented client
// addresses in cities, plus a configuration that points the service at both. Everything in it is
// made up. Tests use it too.
package devseed

import (
	"database/sql"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Options size the demo.
type Options struct {
	Days   int
	PerDay int
	Now    time.Time
	Seed   uint64
}

// Marker is written into every column the service must never read or pass on (user, key, error
// detail). Tests search the service's database and answers for it.
const Marker = "SECRET-MARKER"

type city struct {
	cc, country, province, name string
	lat, lon                    float64
	// weight is the share of traffic; clients is the number of distinct client addresses.
	weight  float64
	clients int
}

// Cities of the demo. The last entries have very few clients on purpose: they exercise the rule
// that a region below 3 distinct clients counts toward its province, then its country, and is
// otherwise not shown.
var cities = []city{
	{"CN", "中国", "北京", "北京", 39.90, 116.40, 13, 260},
	{"CN", "中国", "上海", "上海", 31.23, 121.47, 12, 240},
	{"CN", "中国", "广东", "深圳", 22.54, 114.06, 10, 200},
	{"CN", "中国", "浙江", "杭州", 30.27, 120.15, 8, 160},
	{"CN", "中国", "广东", "广州", 23.13, 113.26, 6.5, 130},
	{"CN", "中国", "四川", "成都", 30.57, 104.07, 5.5, 110},
	{"CN", "中国", "江苏", "南京", 32.06, 118.80, 4, 80},
	{"CN", "中国", "湖北", "武汉", 30.59, 114.31, 3.6, 72},
	{"JP", "日本", "东京都", "东京", 35.68, 139.69, 3.4, 68},
	{"SG", "新加坡", "", "新加坡", 1.35, 103.82, 3.2, 64},
	{"CN", "中国", "陕西", "西安", 34.34, 108.94, 2.8, 56},
	{"CN", "中国", "江苏", "苏州", 31.30, 120.59, 2.6, 52},
	{"US", "美国", "加利福尼亚州", "洛杉矶", 34.05, -118.24, 2.2, 44},
	{"CN", "中国", "湖南", "长沙", 28.23, 112.94, 2, 40},
	{"CN", "中国", "福建", "厦门", 24.48, 118.09, 1.6, 32},
	{"KR", "韩国", "首尔特别市", "首尔", 37.57, 126.98, 1.2, 24},
	{"DE", "德国", "黑森州", "法兰克福", 50.11, 8.68, 0.9, 18},
	{"AU", "澳大利亚", "新南威尔士州", "悉尼", -33.87, 151.21, 0.5, 10},
	// Three cities of one province with 1, 1, and 2 clients: only the province can be shown.
	{"CN", "中国", "青海", "西宁", 36.62, 101.78, 0.05, 1},
	{"CN", "中国", "青海", "海东", 36.50, 102.10, 0.05, 1},
	{"CN", "中国", "青海", "格尔木", 36.40, 94.90, 0.08, 2},
	// Two cities of a country without provinces, 2 clients each: only the country can be shown.
	{"BR", "巴西", "", "圣保罗", -23.55, -46.63, 0.08, 2},
	{"BR", "巴西", "", "里约热内卢", -22.91, -43.17, 0.08, 2},
	// One client in a whole country: nothing of it may be shown.
	{"NZ", "新西兰", "奥克兰大区", "奥克兰", -36.85, 174.76, 0.04, 1},
}

// HiddenNames are place names that must never reach a browser; ShownAsGroup are the province and
// the country that stand in for the cities of the last entries of the list above.
var (
	HiddenNames  = []string{"西宁", "海东", "格尔木", "圣保罗", "里约热内卢", "奥克兰", "新西兰", "奥克兰大区"}
	ShownAsGroup = []string{"青海", "巴西"}
)

type group struct{ id, name, class string }

var groups = []group{
	{"g-general", "通用", "standard"},
	{"g-flagship", "旗舰", "standard"},
	{"g-corp", "企业专线", "enterprise"},
	{"g-partner", "合作方甲", "agent"},
	{"g-lab", "内部试验", "private"},
}

type provider struct {
	id, group, name, baseURL string
	weight, errRate          float64
	ttfb, dur                float64
}

// Upstream hosts are literal addresses of the documentation ranges, placed by the network table,
// so the demo resolves no name. One host is an invented name with a fixed place in the
// configuration (an anycast edge); one cannot be placed at all.
var providers = []provider{
	{"p-01", "g-general", "线路一", "https://198.51.100.10/v1", 22, 0.02, 900, 6000},
	{"p-02", "g-general", "线路二", "https://198.51.100.20/v1", 14, 0.04, 1400, 8000},
	{"p-03", "g-general", "备用线路", "https://edge.cdn.invalid/v1", 6, 0.07, 2100, 9000},
	{"p-04", "g-flagship", "直连甲", "https://203.0.113.10/v1", 12, 0.015, 700, 5000},
	{"p-05", "g-flagship", "直连乙", "https://203.0.113.50/v1", 9, 0.03, 1100, 7000},
	{"p-06", "g-corp", "专线东", "https://198.51.100.10/v1", 8, 0.01, 800, 5500},
	{"p-07", "g-corp", "专线西", "https://203.0.113.50/v1", 5, 0.02, 1000, 6500},
	{"p-08", "g-partner", "合作通道一", "https://198.51.100.30/v1", 10, 0.05, 1600, 9000},
	{"p-09", "g-partner", "合作通道二", "https://198.51.100.20/v1", 6, 0.06, 1800, 9500},
	{"p-10", "g-partner", "合作通道三", "https://nowhere.upstream.invalid/v1", 2, 0.10, 2500, 12000},
	{"p-11", "g-lab", "试验线路", "https://198.51.100.30/v1", 4, 0.08, 1500, 8000},
	{"p-12", "g-lab", "试验线路二", "https://203.0.113.10/v1", 2, 0.05, 1200, 7000},
}

// RestrictedChannelNames are the Channel names that only an admin may receive.
func RestrictedChannelNames() []string {
	class := map[string]string{}
	for _, g := range groups {
		class[g.id] = g.class
	}
	var out []string
	for _, p := range providers {
		if c := class[p.group]; c != "standard" && c != "enterprise" {
			out = append(out, p.name)
		}
	}
	return out
}

var models = []struct {
	name   string
	weight float64
}{
	{"gpt-x-large", 20}, {"claude-lyric-4", 18}, {"gemini-nova-pro", 12}, {"gpt-x-mini", 10},
	{"claude-lyric-4-fast", 8}, {"deepthink-r2", 6}, {"qwen-ultra", 5}, {"glm-6", 4},
	{"grok-4-fast", 3.5}, {"gemini-nova-flash", 3}, {"kimi-k3", 2.5}, {"doubao-pro", 2},
	{"mistral-large-3", 1.5}, {"llama-5-70b", 1.2}, {"embed-v4", 1}, {"rerank-v3", 0.6}, {"tts-hd", 0.4},
}

const schema = `
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
  error_code TEXT, error_message TEXT, duration_ms INTEGER, ttfb_ms INTEGER, request_ip TEXT,
  request_kind TEXT, created_at TEXT NOT NULL, created_at_unix_ms INTEGER, tried_providers_json TEXT);
CREATE INDEX request_logs_time ON request_logs (created_at_unix_ms);
`

// GatewayFile, GeoFile, and ConfigFile are the names of the files Generate writes into its
// directory.
const (
	GatewayFile = "gateway.sqlite"
	GeoFile     = "geo.csv"
	ConfigFile  = "config.toml"
)

func pick(r *rand.Rand, weights []float64, total float64) int {
	x := r.Float64() * total
	for i, w := range weights {
		if x -= w; x <= 0 {
			return i
		}
	}
	return len(weights) - 1
}

func lognormal(r *rand.Rand, median, sigma float64) float64 {
	return median * math.Exp(sigma*r.NormFloat64())
}

// clientIP is the address of client number n of a city. City i owns 10.i.0.0/16; every seventh
// client of the second city uses IPv6 instead.
func clientIP(cityIndex, n int) string {
	if cityIndex == 1 && n%7 == 0 {
		return fmt.Sprintf("fd00:1::%x", n+1)
	}
	return fmt.Sprintf("10.%d.%d.%d", cityIndex+1, n/250, n%250+1)
}

// Generate writes the demo into dir, replacing a previous one.
func Generate(dir string, opts Options) error {
	if opts.Days <= 0 {
		opts.Days = 31
	}
	if opts.PerDay <= 0 {
		opts.PerDay = 20000
	}
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	if opts.Seed == 0 {
		opts.Seed = 20261118
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, GatewayFile)
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(path + suffix)
	}
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(OFF)&_pragma=synchronous(OFF)")
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for i, g := range groups {
		if _, err := tx.Exec(`INSERT INTO monoize_groups (id, name, account_class, sort_order) VALUES (?, ?, ?, ?)`, g.id, g.name, g.class, i); err != nil {
			return err
		}
	}
	for _, p := range providers {
		if _, err := tx.Exec(`INSERT INTO monoize_providers (id, group_id, name, public_name, channel_id, channel_name, channel_public_name, channel_base_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			p.id, p.group, "internal "+p.name, p.name, "c-"+p.id, "internal "+p.name, p.name, p.baseURL); err != nil {
			return err
		}
	}

	r := rand.New(rand.NewPCG(opts.Seed, opts.Seed^0x9e3779b97f4a7c15))
	cityWeights := make([]float64, len(cities))
	var cityTotal float64
	for i, c := range cities {
		cityWeights[i] = c.weight
		cityTotal += c.weight
	}
	providerWeights := make([]float64, len(providers))
	var providerTotal float64
	for i, p := range providers {
		providerWeights[i] = p.weight
		providerTotal += p.weight
	}
	modelWeights := make([]float64, len(models))
	var modelTotal float64
	for i, m := range models {
		modelWeights[i] = m.weight
		modelTotal += m.weight
	}
	insert, err := tx.Prepare(`INSERT INTO request_logs (id, request_id, user_id, api_key_id, model, provider_id, channel_id, is_stream, status, error_code, error_message, duration_ms, ttfb_ms, request_ip, request_kind, created_at, created_at_unix_ms, tried_providers_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer insert.Close()

	start := opts.Now.Add(-time.Duration(opts.Days) * 24 * time.Hour)
	total := opts.Days * opts.PerDay
	upstreamErrors := []string{"upstream_error", "upstream_error", "503", "request_timeout", "upstream_stream_decode_failed"}
	rejections := []string{"rate_limit_exceeded", "model_not_found", "no_healthy_upstream"}
	for i := 0; i < total; i++ {
		// A day of traffic follows a cosine: quiet at night, busy in the afternoon (UTC+8).
		var at time.Time
		for {
			at = start.Add(time.Duration(r.Float64() * float64(opts.Now.Sub(start))))
			hour := float64(at.UTC().Hour()+8) + float64(at.UTC().Minute())/60
			activity := 0.25 + 0.75*(0.5-0.5*math.Cos((hour-4.5)/24*2*math.Pi))
			if r.Float64() < activity {
				break
			}
		}
		cityIndex := pick(r, cityWeights, cityTotal)
		ip := clientIP(cityIndex, r.IntN(cities[cityIndex].clients))
		if r.Float64() < 0.01 {
			ip = ""
		}
		model := models[pick(r, modelWeights, modelTotal)].name
		id := fmt.Sprintf("req-%08d", i)
		var providerID, channelID, errorCode, errorMessage any
		var ttfb, duration, tried any
		status := "success"
		stream := 0
		if r.Float64() < 0.006 {
			// Rejected before a Channel was selected.
			status = "error"
			errorCode = rejections[r.IntN(len(rejections))]
			errorMessage = Marker + " rejection detail"
			duration = int64(20 + r.IntN(160))
		} else {
			p := providers[pick(r, providerWeights, providerTotal)]
			providerID, channelID = p.id, "c-"+p.id
			// Some requests fail on another Channel of the same Group first. The gateway keeps
			// the failed attempts with their error text; the service may take the Channel and the
			// duration of an attempt, never the text.
			var failed string
			var failedMs int64
			if r.Float64() < 0.04 {
				for _, other := range providers {
					if other.group == p.group && other.id != p.id {
						failedMs = int64(300 + r.IntN(2500))
						failed = fmt.Sprintf(`{"attempt_number":1,"provider_id":%q,"channel_id":%q,"provider_name":"internal %s","channel_name":"internal %s","error":"%s attempt failed at https://secret-host.example/v1","duration_ms":%d}`,
							other.id, "c-"+other.id, other.name, other.name, Marker, failedMs)
						break
					}
				}
			}
			if r.Float64() < p.errRate {
				status = "error"
				errorCode = upstreamErrors[r.IntN(len(upstreamErrors))]
				errorMessage = Marker + " upstream said no at https://secret-host.example/v1 api_key: sk-" + Marker
				duration = int64(lognormal(r, 1800, 1)) + failedMs + 900
				if failed != "" {
					// Every attempt failed; the last one is on the Channel the row names.
					tried = fmt.Sprintf(`[%s,{"attempt_number":2,"provider_id":%q,"channel_id":%q,"error":"%s last attempt failed","duration_ms":900}]`, failed, p.id, "c-"+p.id, Marker)
				}
			} else {
				if r.Float64() < 0.72 {
					stream = 1
					first := lognormal(r, p.ttfb, 0.75)
					ttfb = int64(first)
					duration = int64(math.Min(240000, first+lognormal(r, p.dur-p.ttfb, 0.95)))
				} else {
					duration = int64(lognormal(r, p.dur, 0.8))
				}
				if r.Float64() < 0.0066 {
					status = "client_gone"
				}
				if failed != "" {
					// The time lost on the failed attempt is part of the request.
					duration = duration.(int64) + failedMs
					if ttfb != nil {
						ttfb = ttfb.(int64) + failedMs
					}
					tried = fmt.Sprintf(`[%s,{"attempt_number":2,"provider_id":%q,"channel_id":%q,"outcome":"served"}]`, failed, p.id, "c-"+p.id)
				}
			}
		}
		if _, err := insert.Exec(id, "rid-"+id, "user-"+Marker, "key-"+Marker, model, providerID, channelID, stream, status, errorCode, errorMessage, duration, ttfb, nullable(ip), nil, at.UTC().Format(time.RFC3339), at.UnixMilli(), tried); err != nil {
			return err
		}
		if i%100 == 0 {
			// The gateway's own health probes must not be counted.
			if _, err := insert.Exec("probe-"+id, "rid-probe-"+id, "_monoize_probe", nil, model, providers[0].id, "c-"+providers[0].id, 0, "success", nil, nil, int64(300), nil, nil, "active_probe_connectivity", at.UTC().Format(time.RFC3339), at.UnixMilli(), nil); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	var table strings.Builder
	table.WriteString("# Invented networks of the demo. Columns: cidr,country_code,country,province,city,lat,lon\n")
	for i, c := range cities {
		fmt.Fprintf(&table, "10.%d.0.0/16,%s,%s,%s,%s,%.2f,%.2f\n", i+1, c.cc, c.country, c.province, c.name, c.lat, c.lon)
	}
	table.WriteString("fd00:1::/32,CN,中国,上海,上海,31.23,121.47\n")
	// Upstream hosts.
	table.WriteString("198.51.100.10/32,JP,日本,东京都,东京,35.68,139.69\n")
	table.WriteString("198.51.100.20/32,DE,德国,黑森州,法兰克福,50.11,8.68\n")
	table.WriteString("198.51.100.30/32,US,美国,弗吉尼亚州,阿什本,39.04,-77.49\n")
	table.WriteString("203.0.113.10/32,SG,新加坡,,新加坡,1.30,103.85\n")
	table.WriteString("203.0.113.50/32,US,美国,俄勒冈州,波特兰,45.52,-122.68\n")
	if err := os.WriteFile(filepath.Join(dir, GeoFile), []byte(table.String()), 0o644); err != nil {
		return err
	}

	config := fmt.Sprintf(`# Demo configuration written by "request-monitor devseed". Every name and number in the demo is invented.
listen = "127.0.0.1:8787"
data_dir = %q
timezone = "Asia/Shanghai"

[gateway]
kind = "lynshen"
# A fixture file with the same tables as a LynShen database. A real deployment uses postgres://…
dsn = %q
name = "新加坡"
region = "新加坡"
lat = 1.35
lon = 103.82

[geo]
table = %q
language = "zh-CN"
min_clients = 3

[ingest]
backfill_days = 30

[dev]
# Local work only: the identity step is not built yet. Refused on a non-loopback listener.
viewer = "admin"

[[upstream]]
host = "edge.cdn.invalid"
anycast = true
name = "圣何塞"
region = "美国 · 加利福尼亚州"
lat = 37.34
lon = -121.89
`, filepath.Join(dir, "data"), "sqlite://"+path, filepath.Join(dir, GeoFile))
	return os.WriteFile(filepath.Join(dir, ConfigFile), []byte(config), 0o644)
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
