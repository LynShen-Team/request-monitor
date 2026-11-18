// Command opsscreen serves the ops screen for one LLM gateway.
//
//	opsscreen serve     -config config.toml   run the service
//	opsscreen devseed   -dir demo             write an invented demo gateway and a configuration
//	opsscreen reconcile -config config.toml   compare the rollups with the gateway's own counts
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"opsscreen/internal/api"
	"opsscreen/internal/config"
	"opsscreen/internal/devseed"
	"opsscreen/internal/gateway"
	"opsscreen/internal/gateway/lynshen"
	"opsscreen/internal/geo"
	"opsscreen/internal/ingest"
	"opsscreen/internal/screen"
	"opsscreen/internal/store"
	"opsscreen/internal/upstream"
	"opsscreen/internal/webui"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "devseed":
		err = seed(os.Args[2:])
	case "reconcile":
		err = reconcile(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "opsscreen:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: opsscreen serve|devseed|reconcile [flags]")
}

// parts are the pieces every command that reads a gateway needs.
type parts struct {
	cfg      *config.Config
	store    *store.Store
	adapter  *lynshen.Adapter
	geo      geo.Resolver
	geoReady bool
}

func open(configPath string) (*parts, error) {
	cfg, err := config.Load(configPath)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.DataDir, 0o750); err != nil {
		return nil, err
	}
	st, err := store.Open(filepath.Join(cfg.DataDir, "opsscreen.db"), cfg.Location())
	if err != nil {
		return nil, err
	}
	var chain geo.Chain
	if cfg.Geo.Table != "" {
		table, err := geo.OpenTable(cfg.Geo.Table)
		if err != nil {
			return nil, err
		}
		chain = append(chain, table)
	}
	if cfg.Geo.MMDB != "" {
		db, err := geo.OpenMMDB(cfg.Geo.MMDB, cfg.Geo.Language)
		if err != nil {
			return nil, err
		}
		chain = append(chain, db)
	}
	adapter, err := lynshen.Open(cfg.Gateway.DSN)
	if err != nil {
		return nil, err
	}
	return &parts{cfg: cfg, store: st, adapter: adapter, geo: chain, geoReady: len(chain) > 0}, nil
}

func (p *parts) close() {
	_ = p.adapter.Close()
	_ = p.geo.Close()
	_ = p.store.Close()
}

func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	configPath := flags.String("config", "config.toml", "configuration file")
	_ = flags.Parse(args)
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	p, err := open(*configPath)
	if err != nil {
		return err
	}
	defer p.close()
	cfg := p.cfg
	if !p.geoReady {
		log.Warn("no geo database is configured (geo.mmdb or geo.table): the screen will show no user regions and no upstream cities")
	}
	if cfg.Dev.Viewer == "admin" {
		log.Warn("dev.viewer = admin: every visitor of this loopback listener sees the admin view")
	}

	ing := ingest.New(p.adapter, p.store, p.geo, ingest.Options{
		BackfillDays: cfg.Ingest.BackfillDays,
		Lookback:     time.Duration(cfg.Ingest.LookbackMinutes) * time.Minute,
		Interval:     time.Duration(cfg.Ingest.IntervalSeconds) * time.Second,
	}, log)
	locator := upstream.New(p.store, p.geo, cfg.Upstream)
	ing.OnChannels = func(ctx context.Context, channels []gateway.Channel) {
		if err := locator.Apply(ctx, channels); err != nil {
			log.Error("cannot place the upstream sites", "error", err)
		}
	}
	scr := screen.New(p.store, screen.Options{
		Gateway:    screen.Site{ID: "gw", Name: cfg.Gateway.Name, Region: cfg.Gateway.Region, Lat: cfg.Gateway.Lat, Lon: cfg.Gateway.Lon},
		MinClients: cfg.Geo.MinClients,
	}, ing.Generation)

	var web fs.FS = webui.Dist()
	if cfg.WebDir != "" {
		web = os.DirFS(cfg.WebDir)
	}
	handler := api.New(api.Options{Config: cfg, Screen: scr, Adapter: p.adapter, Geo: p.geo, GeoReady: p.geoReady, Backfilling: ing.Backfilling, Web: web, Log: log})
	server := &http.Server{Addr: cfg.Listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go ing.Run(ctx)
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Info("listening", "address", cfg.Listen, "gateway", p.adapter.Kind())
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func seed(args []string) error {
	flags := flag.NewFlagSet("devseed", flag.ExitOnError)
	dir := flags.String("dir", "demo", "directory to write the demo into")
	days := flags.Int("days", 31, "days of invented requests")
	perDay := flags.Int("per-day", 20000, "invented requests per day")
	_ = flags.Parse(args)
	abs, err := filepath.Abs(*dir)
	if err != nil {
		return err
	}
	if err := devseed.Generate(abs, devseed.Options{Days: *days, PerDay: *perDay}); err != nil {
		return err
	}
	fmt.Printf("wrote an invented demo gateway to %s\nrun: opsscreen serve -config %s\n", abs, filepath.Join(abs, devseed.ConfigFile))
	return nil
}

// reconcile checks the rollups against the gateway: for every 5-minute bucket, Provider, and
// status of the chosen days it compares the gateway's own COUNT(*) with the stored count.
func reconcile(args []string) error {
	flags := flag.NewFlagSet("reconcile", flag.ExitOnError)
	configPath := flags.String("config", "config.toml", "configuration file")
	days := flags.Int("days", 30, "how many past days to compare")
	_ = flags.Parse(args)
	p, err := open(*configPath)
	if err != nil {
		return err
	}
	defer p.close()
	ctx := context.Background()
	// The newest part of the log may still receive rows of requests that have not ended; compare
	// up to the start of the lookback window.
	end := time.Now().Add(-time.Duration(p.cfg.Ingest.LookbackMinutes) * time.Minute)
	endBucket := store.Bucket(end)
	startBucket := endBucket - int64(*days)*86400/store.BucketSeconds
	result, err := ingest.Reconcile(ctx, p.adapter, p.store, startBucket, endBucket)
	if err != nil {
		return err
	}
	fmt.Printf("range: %s to %s\n", store.BucketStart(startBucket).Format(time.RFC3339), store.BucketStart(endBucket).Format(time.RFC3339))
	fmt.Printf("gateway requests: %d\nrollup requests:  %d\ncells compared:   %d\ncells that differ: %d\n", result.GatewayTotal, result.RollupTotal, result.Cells, result.Different)
	if result.Different > 0 || result.GatewayTotal != result.RollupTotal {
		return errors.New("the rollups do not match the gateway")
	}
	fmt.Println("the rollups match the gateway")
	return nil
}
