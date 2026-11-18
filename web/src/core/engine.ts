import type { Capabilities, FlowStatus, LiveEvent, LiveSource, ReplayData, ReplaySource, ReplayWindow, Topology, Viewer } from "./model";
import { formatSeconds } from "./format";
import type { AggregateFlow, FlowView, MapNode, Tone, ViewMode } from "./view";

export interface RankRow {
  key: string;
  name: string;
  count: number;
  share: number;
}

export interface RouteRow extends RankRow {
  group: string;
  /** Empty when the viewer may see the Group only. */
  channel: string;
  site: string;
  restricted: boolean;
  okRate: number;
  ttfbP50: number;
  /** Clock time of the newest dispatch to this route (live mode), for the row highlight. */
  lastAt: number;
}

export interface TickerRow {
  id: number;
  t: number;
  origin: string;
  site: string;
  route: string;
  model: string;
  status: FlowStatus | "pending";
  ttfbMs: number | null;
  durationMs: number | null;
  errorCode?: string;
  failover: boolean;
  restricted: boolean;
}

/** A feed row as the engine keeps it; names are resolved for the current viewer in the snapshot. */
interface FeedEntry extends Omit<TickerRow, "route" | "site" | "restricted"> {
  routeIndex: number | null;
}

/** A finished request in a node's detail view. */
export interface RecentRow {
  t: number;
  origin: string;
  route: string;
  model: string;
  status: FlowStatus;
  durationMs: number;
  errorCode?: string;
}

/** What the screen knows about one place on the map, for the range the screen is showing. */
export interface NodeDetail {
  id: string;
  kind: "gateway" | "upstream" | "origin";
  name: string;
  region: string;
  note?: string;
  /** The range the figures cover, in the page's words. */
  scope: string;
  requests: number;
  /** Share of all requests of the range. */
  share: number;
  /** Null when the range holds no outcome for this node (a user region in replay). */
  okRate: number | null;
  ttfbP50: number | null;
  /** Requests in flight now; null in replay. */
  inflight: number | null;
  models: RankRow[];
  routes: RouteRow[];
  origins: RankRow[];
  sites: RankRow[];
  /** Newest first; empty in replay. */
  recent: RecentRow[];
  /** Requests over time: one value per minute of the last 30 (live), or per bucket (replay). */
  trend: number[];
  /** True when the breakdown by model and by Channel does not exist for this node in this range. */
  noBreakdown: boolean;
}

export interface Snapshot {
  ready: boolean;
  mode: "live" | "replay";
  window: ReplayWindow;
  view: ViewMode;
  viewer: Viewer;
  caps: Capabilities;
  /** True when the newest request for data failed and the screen shows what it had. */
  stale: boolean;
  /** Time the header shows: now in live mode, the playhead in replay. */
  clock: number;
  playing: boolean;
  speed: number;
  wholeWindow: boolean;
  kpi: {
    rps: number;
    rpsPeak: number;
    successRate: number;
    errors: number;
    ttfbP50: number;
    ttfbP95: number;
    inflight: number;
    total: number;
    failover: number;
  };
  spark: { rps: number[]; ttfb: number[]; ok: number[] };
  models: RankRow[];
  routes: RouteRow[];
  origins: RankRow[];
  sites: RankRow[];
  groups: RankRow[];
  ticker: TickerRow[];
  timeline: { start: number; stepMs: number; total: number[]; errors: number[]; cursor: number; live: boolean };
  range: { from: number; to: number };
}

interface Flight {
  origin: string;
  model: string;
  t0: number;
  route: number | null;
  site: string | null;
  failover: boolean;
  /** Clock time when the inbound comet reaches the gateway. */
  arriveAt: number;
  /** Clock time when the dispatch comet reaches the upstream. */
  dispatchAt: number;
  animated: boolean;
}

interface Done {
  t: number;
  model: string;
  route: number | null;
  origin: string;
  status: FlowStatus;
  ttfbMs: number | null;
  durationMs: number;
  errorCode?: string;
}

const LIVE_HISTORY_MS = 30 * 60_000;
const LIVE_BAR_MS = 10_000;
const PANEL_WINDOW_MS = 15 * 60_000;
const KPI_WINDOW_MS = 5 * 60_000;
const SNAPSHOT_MS = 250;
const REPLAY_SNAPSHOT_MS = 100;
/** A full replay window plays in this many seconds at speed 1. */
const REPLAY_SECONDS = 60;
const IN_MS = 1500;
/** The origin row of requests with no shown region (OS-D6). */
const UNPLACED_KEY = "~none";
const UNPLACED_NAME = "未归入地区";
const OUT_MS = 1050;

export const EMPTY_SNAPSHOT: Snapshot = {
  ready: false,
  mode: "live",
  window: "24h",
  view: "2d",
  viewer: "admin",
  caps: { live: "realtime", origin: true, errors: true, durationPrecisionMs: 1 },
  stale: false,
  clock: 0,
  playing: true,
  speed: 1,
  wholeWindow: false,
  kpi: { rps: 0, rpsPeak: 0, successRate: 1, errors: 0, ttfbP50: 0, ttfbP95: 0, inflight: 0, total: 0, failover: 0 },
  spark: { rps: [], ttfb: [], ok: [] },
  models: [],
  routes: [],
  origins: [],
  sites: [],
  groups: [],
  ticker: [],
  timeline: { start: 0, stepMs: LIVE_BAR_MS, total: [], errors: [], cursor: 0, live: true },
  range: { from: 0, to: 0 },
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function topRows(counts: Map<string, number>, names: (key: string) => string, limit: number): RankRow[] {
  let total = 0;
  for (const value of counts.values()) total += value;
  return [...counts.entries()]
    .filter((entry) => entry[1] >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, name: names(key), count, share: total > 0 ? count / total : 0 }));
}

/**
 * Drives the screen: turns source events into map animation and rolling metrics (live), or
 * steps a playhead through aggregated buckets (replay). `tick(now)` is the only time input.
 */
export class OpsEngine {
  private snapshot: Snapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private topology: Topology;
  private baseline24h: { total: number; errors: number };
  private stale = false;
  private readonly originName = new Map<string, string>();
  private readonly siteName = new Map<string, string>();
  private routeLabel: string[] = [];
  private readonly flights = new Map<number, Flight>();
  private readonly later: Array<{ t: number; run: (now: number) => void }> = [];
  private starts: number[] = [];
  private done: Done[] = [];
  private ticker: FeedEntry[] = [];
  private viewer: Viewer = "admin";
  private readonly routeLastAt = new Map<number, number>();
  private extraTotal = 0;
  private extraErrors = 0;
  private failovers = 0;
  private epoch = 0;
  private lastTick = 0;
  private lastSnapshot = -1e9;
  private lastMeta = -1e9;
  private mode: "live" | "replay" = "live";
  private window: ReplayWindow = "24h";
  private view: ViewMode = "2d";
  private playing = true;
  private speed = 1;
  private wholeWindow = false;
  private replay: ReplayData | null = null;
  private replayLoading: ReplayWindow | null = null;
  private playhead = 0;
  private replayHold = 0;
  private replayRetryAt = 0;
  private started = false;

  private readonly renderer: FlowView;
  private readonly live: LiveSource;
  private readonly replaySource: ReplaySource;

  constructor(renderer: FlowView, live: LiveSource, replaySource: ReplaySource) {
    this.renderer = renderer;
    this.live = live;
    this.replaySource = replaySource;
    this.topology = live.topology;
    this.baseline24h = live.baseline24h;
    this.applyTopology();
    replaySource.onTopology = (topology, baseline24h) => this.setTopology(topology, baseline24h);
    live.onReset = () => this.resetLive();
  }

  /**
   * Drops everything built from the live events (docs/spec-screen.md OS-N9.3): the source is about
   * to deliver events that replace them, the history of the last 30 minutes included.
   */
  private resetLive() {
    if (this.mode === "live") {
      // Release the arcs that the requests in flight hold; in replay mode no request holds one.
      const gw = this.topology.gateway.id;
      for (const flight of this.flights.values()) {
        this.renderer.hold(`o:${flight.origin}`, gw, "in", -1);
        if (flight.site) {
          this.renderer.hold(gw, `up:${flight.site}`, "out", -1);
          this.renderer.inflight(`up:${flight.site}`, -1);
        }
      }
    }
    this.flights.clear();
    this.later.length = 0;
    this.starts = [];
    this.done = [];
    this.ticker = [];
    this.routeLastAt.clear();
    this.extraTotal = 0;
    this.extraErrors = 0;
    this.failovers = 0;
    this.lastSnapshot = -1e9;
    this.lastMeta = -1e9;
  }

  /** Rebuilds the name tables and the map nodes from `this.topology`. */
  private applyTopology() {
    this.originName.clear();
    this.siteName.clear();
    for (const origin of this.topology.origins) this.originName.set(origin.id, origin.name);
    for (const site of this.topology.upstreams) this.siteName.set(site.id, site.name);
    this.routeLabel = this.topology.routes.map((route) => `${route.group} · ${route.channel}`);
    const nodes: MapNode[] = [
      { id: this.topology.gateway.id, kind: "gateway", lon: this.topology.gateway.lon, lat: this.topology.gateway.lat, name: this.topology.gateway.name, sub: this.topology.gateway.region },
      ...this.topology.upstreams.map<MapNode>((site) => ({ id: `up:${site.id}`, kind: "upstream", lon: site.lon, lat: site.lat, name: site.name, sub: "" })),
      ...this.topology.origins.map<MapNode>((site) => ({ id: `o:${site.id}`, kind: "origin", lon: site.lon, lat: site.lat, name: site.name })),
    ];
    this.renderer.setNodes(nodes);
  }

  /**
   * Replaces the topology (new Channels, sites, or regions). Everything that is indexed by the old
   * one is dropped: requests in flight, the live history, and the loaded replay.
   */
  setTopology(topology: Topology, baseline24h: { total: number; errors: number }) {
    this.topology = topology;
    this.baseline24h = baseline24h;
    this.flights.clear();
    this.later.length = 0;
    this.done = [];
    this.ticker = [];
    this.routeLastAt.clear();
    this.replay = null;
    this.applyTopology();
    this.renderer.setAggregateMode(this.mode === "replay");
    this.lastSnapshot = -1e9;
    this.lastMeta = -1e9;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  // ------------------------------------------------------------------ controls

  /** Sets the first view without the morph. */
  snapView(view: ViewMode) {
    this.view = view;
    this.renderer.snapView(view);
  }

  setViewer(viewer: Viewer) {
    this.viewer = viewer;
    this.lastSnapshot = -1e9;
  }

  /** The name of a route for the current viewer: `Group · Channel`, or the Group alone. */
  private labelOf(route: number): string {
    const info = this.topology.routes[route]!;
    return this.viewer === "user" && info.restricted ? info.group : this.routeLabel[route]!;
  }

  private hidden(route: number): boolean {
    return this.viewer === "user" && this.topology.routes[route]!.restricted;
  }

  /**
   * The upstream site of a route as the current viewer may know it: null for a restricted route
   * seen by a non-admin, so no dispatch arc is drawn for it.
   */
  private siteOf(route: number): string | null {
    const info = this.topology.routes[route];
    return !info || this.hidden(route) ? null : info.upstream;
  }

  /**
   * Merges per-route counters into the rows the current viewer may see: a restricted Group is one
   * row, every other route its own.
   */
  private routeRows(count: Map<number, number>, err: Map<number, number>, ttfb: Map<number, number[]> | null): RouteRow[] {
    const rows = new Map<string, RouteRow & { errors: number; samples: number[] }>();
    let total = 0;
    for (const [index, value] of count) {
      if (index < 0 || value < 0.5) continue;
      const info = this.topology.routes[index]!;
      const merged = this.hidden(index);
      const key = merged ? `g:${info.group}` : String(index);
      total += value;
      let row = rows.get(key);
      if (!row) {
        row = { key, name: this.labelOf(index), group: info.group, channel: merged ? "" : info.channel, site: merged ? "" : info.upstream ? (this.siteName.get(info.upstream) ?? "") : "", restricted: merged, count: 0, share: 0, okRate: 1, ttfbP50: 0, lastAt: 0, errors: 0, samples: [] };
        rows.set(key, row);
      }
      row.count += value;
      row.errors += err.get(index) ?? 0;
      row.lastAt = Math.max(row.lastAt, this.routeLastAt.get(index) ?? 0);
      const samples = ttfb?.get(index);
      if (samples) row.samples.push(...samples);
    }
    return [...rows.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 9)
      .map(({ errors, samples, ...row }) => ({ ...row, share: total > 0 ? row.count / total : 0, okRate: row.count > 0 ? 1 - errors / row.count : 1, ttfbP50: percentile(samples.sort((a, b) => a - b), 0.5) }));
  }

  private feedRows(): TickerRow[] {
    return this.ticker.slice(0, 11).map(({ routeIndex, ...row }) => {
      const info = routeIndex !== null ? this.topology.routes[routeIndex] : undefined;
      const hidden = routeIndex !== null && this.hidden(routeIndex);
      return {
        ...row,
        route: routeIndex !== null ? this.labelOf(routeIndex) : "网关拒绝",
        site: !hidden && info?.upstream ? (this.siteName.get(info.upstream) ?? "") : "",
        restricted: hidden,
      };
    });
  }

  setView(view: ViewMode) {
    this.view = view;
    this.renderer.setView(view, this.lastTick - this.epoch);
    this.lastSnapshot = -1e9;
  }

  setLive() {
    if (this.live.capabilities.live === "none") return;
    this.mode = "live";
    this.renderer.setAggregateMode(false);
    // Arc holds were cleared by the mode switch; re-register the requests still in flight.
    const gw = this.topology.gateway.id;
    for (const flight of this.flights.values()) {
      this.renderer.hold(`o:${flight.origin}`, gw, "in", 1);
      if (flight.site) {
        this.renderer.hold(gw, `up:${flight.site}`, "out", 1);
        this.renderer.inflight(`up:${flight.site}`, 1);
      }
    }
    this.lastSnapshot = -1e9;
    this.lastMeta = -1e9;
  }

  setReplay(window: ReplayWindow) {
    this.mode = "replay";
    this.window = window;
    this.wholeWindow = false;
    this.playing = true;
    this.renderer.setAggregateMode(true);
    this.lastSnapshot = -1e9;
    if (this.replay?.window === window) {
      this.playhead = this.replay.start;
      return;
    }
    this.replay = null;
    // Until the window has loaded the map shows no flows: the figures of the last one are not its own.
    for (const origin of this.topology.origins) this.renderer.setNodeMeta(`o:${origin.id}`, { value: 0 });
    for (const site of this.topology.upstreams) this.renderer.setNodeMeta(`up:${site.id}`, { value: 0, health: this.live.capabilities.errors ? 1 : null, sub: "" });
    this.renderer.setAggregate([]);
    this.loadReplay(window, true);
  }

  /** Fetches a window. `rewind` puts the playhead at its start; a refresh keeps the place. */
  private loadReplay(window: ReplayWindow, rewind: boolean) {
    this.replayLoading = window;
    this.replaySource.load(window).then(
      (data) => {
        if (this.replayLoading !== window) return;
        this.replayLoading = null;
        this.stale = false;
        const old = this.replay;
        this.replay = data;
        if (rewind || !old) this.playhead = data.start;
        else this.playhead = Math.max(data.start, Math.min(data.end - 1, this.playhead));
        this.lastSnapshot = -1e9;
      },
      () => {
        if (this.replayLoading !== window) return;
        this.replayLoading = null;
        this.stale = true;
        this.lastSnapshot = -1e9;
        // Try again later; the screen keeps showing what it has.
        this.replayRetryAt = this.lastTick + 15_000;
      },
    );
  }

  togglePlay() {
    if (this.mode !== "replay" || !this.replay) return;
    if (!this.playing && this.playhead >= this.replay.end - this.replay.stepMs) this.playhead = this.replay.start;
    this.playing = !this.playing;
    this.wholeWindow = false;
    this.lastSnapshot = -1e9;
  }

  setSpeed(speed: number) {
    this.speed = speed;
    this.lastSnapshot = -1e9;
  }

  setWholeWindow(on: boolean) {
    this.wholeWindow = on;
    if (on) this.playing = false;
    this.lastSnapshot = -1e9;
  }

  /** Moves the playhead to a fraction of the replay window. */
  seek(fraction: number) {
    if (this.mode !== "replay" || !this.replay) return;
    const f = Math.max(0, Math.min(0.9999, fraction));
    this.playhead = this.replay.start + f * (this.replay.end - this.replay.start);
    this.wholeWindow = false;
    this.lastSnapshot = -1e9;
  }

  // ------------------------------------------------------------------ frame

  tick(now: number) {
    if (!this.started) {
      this.started = true;
      this.epoch = now - 1000;
      this.lastTick = now;
    }
    const dt = Math.max(0, Math.min(1000, now - this.lastTick));
    this.lastTick = now;
    const rel = now - this.epoch;

    for (const event of this.live.poll(now)) this.onEvent(event, now);
    // The source turned live mode off (OS-D5a): the newest day is the closest view.
    if (this.mode === "live" && this.live.capabilities.live === "none") this.setReplay("24h");
    if (this.later.length > 0) {
      const due = this.later.filter((item) => item.t <= now);
      if (due.length > 0) {
        for (const item of due) this.later.splice(this.later.indexOf(item), 1);
        if (this.mode === "live") for (const item of due) item.run(now);
      }
    }

    if (this.mode === "replay" && !this.replay && this.replayLoading === null && this.replayRetryAt > 0 && now >= this.replayRetryAt) {
      this.replayRetryAt = 0;
      this.loadReplay(this.window, true);
    }
    if (this.mode === "replay" && this.replay) {
      const data = this.replay;
      if (this.playing) {
        if (this.playhead >= data.end - 1) {
          // Rest on the last bucket for a moment, then loop: the screen runs unattended.
          this.replayHold += dt;
          if (this.replayHold > 1800) {
            this.replayHold = 0;
            this.playhead = data.start;
            // Each pass through the window starts from fresh data.
            if (this.replayLoading === null) this.loadReplay(data.window, false);
          }
        } else {
          this.playhead = Math.min(data.end - 1, this.playhead + dt * ((data.end - data.start) / (REPLAY_SECONDS * 1000)) * this.speed);
        }
      }
      if (rel - this.lastMeta >= 100) {
        this.lastMeta = rel;
        this.applyReplayScene(data);
      }
    } else if (this.mode === "live" && rel - this.lastMeta >= 1000) {
      this.lastMeta = rel;
      this.applyLiveMeta(now);
    }

    this.renderer.draw(rel);

    if (rel - this.lastSnapshot >= (this.mode === "replay" ? REPLAY_SNAPSHOT_MS : SNAPSHOT_MS)) {
      this.lastSnapshot = rel;
      if (this.mode === "live") this.snapshot = this.liveSnapshot(now);
      else if (this.replay) this.snapshot = this.replaySnapshot(this.replay);
      // A window that is still loading: the panels show their loading state, not live figures.
      else this.snapshot = { ...EMPTY_SNAPSHOT, mode: "replay", window: this.window, view: this.view, viewer: this.viewer, caps: this.live.capabilities, stale: this.stale, clock: now, playing: this.playing, speed: this.speed };
      for (const listener of this.listeners) listener();
    }
  }

  /** Puts the request's row at the top of the dispatch feed with its newest state. */
  private pushTicker(id: number, flight: Flight, t: number, state: Pick<FeedEntry, "status" | "ttfbMs" | "durationMs" | "errorCode">) {
    const row: FeedEntry = {
      id,
      t,
      origin: this.originName.get(flight.origin) ?? (flight.origin === "" ? UNPLACED_NAME : flight.origin),
      routeIndex: flight.route,
      model: flight.model,
      failover: flight.failover,
      ...state,
    };
    this.ticker = [row, ...this.ticker.filter((r) => r.id !== id)].slice(0, 14);
  }

  private schedule(t: number, run: (now: number) => void) {
    this.later.push({ t, run });
  }

  private onEvent(event: LiveEvent, now: number) {
    const gw = this.topology.gateway.id;
    const rel = (t: number) => t - this.epoch;
    // Warm-up history and events that arrive while replaying update metrics only.
    const animate = this.mode === "live" && now - event.t < 2500;
    const holds = this.mode === "live";

    if (event.type === "start") {
      this.starts.push(event.t);
      const flight: Flight = { origin: event.origin, model: event.model, t0: event.t, route: null, site: null, failover: false, arriveAt: event.t, dispatchAt: event.t, animated: animate };
      this.flights.set(event.id, flight);
      if (holds) this.renderer.hold(`o:${event.origin}`, gw, "in", 1);
      if (animate) {
        this.renderer.pulse(`o:${event.origin}`, "in", rel(now), 0.7);
        flight.arriveAt = this.epoch + this.renderer.comet(`o:${event.origin}`, gw, "in", "in", rel(now), IN_MS);
        this.schedule(flight.arriveAt, (at) => this.renderer.pulse(gw, "in", rel(at), 0.8));
      }
      return;
    }

    const flight = this.flights.get(event.id);
    if (!flight) return;

    if (event.type === "route") {
      const route = this.topology.routes[event.route];
      if (!route) return;
      const label = this.labelOf(event.route);
      if (flight.route !== null) {
        // The earlier attempt failed: mark it and release its arc.
        flight.failover = true;
        this.failovers++;
        const failedSite = flight.site;
        const failedLabel = this.labelOf(flight.route);
        if (failedSite) {
          if (holds) {
            this.renderer.hold(gw, `up:${failedSite}`, "out", -1);
            this.renderer.inflight(`up:${failedSite}`, -1);
          }
          if (animate) {
            this.schedule(Math.max(now, flight.dispatchAt), (at) => {
              this.renderer.pulse(`up:${failedSite}`, "err", rel(at), 1.3);
              this.renderer.tag(`up:${failedSite}`, `${failedLabel} · 失败，换渠道`, "err", rel(at));
              this.renderer.comet(gw, `up:${failedSite}`, "out", "err", rel(at), OUT_MS * 0.8, true, 0.9);
            });
          }
        }
      }
      flight.route = event.route;
      flight.site = this.siteOf(event.route);
      this.routeLastAt.set(event.route, event.t);
      this.pushTicker(event.id, flight, event.t, { status: "pending", ttfbMs: null, durationMs: null });
      if (flight.site) {
        const site = flight.site;
        if (holds) {
          this.renderer.hold(gw, `up:${site}`, "out", 1);
          this.renderer.inflight(`up:${site}`, 1);
        }
        if (animate) {
          const startAt = Math.max(now, flight.arriveAt, flight.failover ? flight.dispatchAt + 350 : 0);
          flight.dispatchAt = startAt + OUT_MS;
          this.schedule(startAt, (at) => this.renderer.comet(gw, `up:${site}`, "out", "out", rel(at), OUT_MS));
          this.schedule(flight.dispatchAt, (at) => {
            this.renderer.pulse(`up:${site}`, "out", rel(at), 0.9);
            this.renderer.tag(`up:${site}`, label, "out", rel(at));
          });
        }
      }
      return;
    }

    if (event.type === "ttfb") {
      const row = this.ticker.find((r) => r.id === event.id);
      if (row) row.ttfbMs = event.ttfbMs;
      if (animate && flight.site) {
        const site = flight.site;
        this.schedule(Math.max(now, flight.dispatchAt), (at) => this.renderer.comet(gw, `up:${site}`, "out", "ok", rel(at), 620, true, 0.7));
      }
      return;
    }

    // end
    this.flights.delete(event.id);
    this.done.push({ t: event.t, model: flight.model, route: flight.route, origin: flight.origin, status: event.status, ttfbMs: event.ttfbMs, durationMs: event.durationMs, errorCode: event.errorCode });
    if (event.t > this.epoch) {
      this.extraTotal++;
      if (event.status === "error") this.extraErrors++;
    }
    const tone: Tone = event.status === "success" ? "ok" : event.status === "error" ? "err" : "gone";
    this.pushTicker(event.id, flight, event.t, { status: event.status, ttfbMs: event.ttfbMs, durationMs: event.durationMs, errorCode: event.errorCode });
    const site = flight.site;
    if (holds) {
      this.renderer.hold(`o:${flight.origin}`, gw, "in", -1);
      if (site) {
        this.renderer.hold(gw, `up:${site}`, "out", -1);
        this.renderer.inflight(`up:${site}`, -1);
      }
    }
    if (animate || (flight.animated && this.mode === "live")) {
      const startAt = Math.max(now, site ? flight.dispatchAt : flight.arriveAt);
      const label = flight.route !== null ? this.labelOf(flight.route) : "";
      if (site) {
        this.schedule(startAt, (at) => {
          this.renderer.pulse(`up:${site}`, tone, rel(at), tone === "err" ? 1.5 : 0.8);
          const outcome = tone === "err" ? (event.errorCode ?? "失败") : tone === "gone" ? "客户端断开" : formatSeconds(event.durationMs);
          this.renderer.tag(`up:${site}`, `${label} · ${outcome}`, tone, rel(at));
          this.renderer.comet(gw, `up:${site}`, "out", tone, rel(at), 640, true, 0.95);
        });
      } else {
        this.schedule(startAt, (at) => this.renderer.pulse(gw, tone, rel(at), 1.4));
      }
      const backAt = startAt + (site ? 640 : 120);
      this.schedule(backAt, (at) => this.renderer.comet(`o:${flight.origin}`, gw, "in", tone, rel(at), 900, true, 0.9));
      this.schedule(backAt + 900, (at) => this.renderer.pulse(`o:${flight.origin}`, tone, rel(at), 0.6));
    }
  }

  // ------------------------------------------------------------------ live

  private applyLiveMeta(now: number) {
    const from = now - PANEL_WINDOW_MS;
    const originCount = new Map<string, number>();
    const siteCount = new Map<string, number>();
    const siteErr = new Map<string, number>();
    for (let i = this.done.length - 1; i >= 0; i--) {
      const d = this.done[i]!;
      if (d.t < from) break;
      originCount.set(d.origin, (originCount.get(d.origin) ?? 0) + 1);
      const site = d.route !== null ? this.siteOf(d.route) : null;
      if (!site) continue;
      siteCount.set(site, (siteCount.get(site) ?? 0) + 1);
      if (d.status === "error") siteErr.set(site, (siteErr.get(site) ?? 0) + 1);
    }
    const maxOrigin = Math.max(1, ...originCount.values());
    for (const origin of this.topology.origins) this.renderer.setNodeMeta(`o:${origin.id}`, { value: (originCount.get(origin.id) ?? 0) / maxOrigin });
    const maxSite = Math.max(1, ...siteCount.values());
    const inflight = new Map<string, number>();
    for (const flight of this.flights.values()) if (flight.site) inflight.set(flight.site, (inflight.get(flight.site) ?? 0) + 1);
    for (const site of this.topology.upstreams) {
      const count = siteCount.get(site.id) ?? 0;
      const busy = inflight.get(site.id) ?? 0;
      this.renderer.setNodeMeta(`up:${site.id}`, {
        value: count / maxSite,
        health: !this.live.capabilities.errors ? null : count > 0 ? 1 - (siteErr.get(site.id) ?? 0) / count : 1,
        sub: busy > 0 ? `在途 ${busy}` : "",
      });
    }
    this.renderer.setNodeMeta(this.topology.gateway.id, { sub: this.topology.gateway.region });
  }

  private liveSnapshot(now: number): Snapshot {
    // No figure until the source has delivered its first events (OS-N2a, OS-N9.5).
    if (this.live.ready === false) return { ...EMPTY_SNAPSHOT, mode: "live", window: this.window, view: this.view, viewer: this.viewer, caps: this.live.capabilities, stale: this.live.stale === true, clock: now, playing: true, speed: this.speed };
    const horizon = now - LIVE_HISTORY_MS;
    if (this.starts.length > 0 && this.starts[0]! < horizon - 60_000) {
      this.starts = this.starts.filter((t) => t >= horizon);
      this.done = this.done.filter((d) => d.t >= horizon);
    }
    const bars = LIVE_HISTORY_MS / LIVE_BAR_MS;
    const end = Math.ceil(now / LIVE_BAR_MS) * LIVE_BAR_MS;
    const start = end - bars * LIVE_BAR_MS;
    const total = new Array<number>(bars).fill(0);
    const errors = new Array<number>(bars).fill(0);
    for (const t of this.starts) {
      const i = Math.floor((t - start) / LIVE_BAR_MS);
      if (i >= 0 && i < bars) total[i]!++;
    }
    const ttfbBar: number[][] = Array.from({ length: bars }, () => []);
    const okBar = new Array<number>(bars).fill(0);
    const doneBar = new Array<number>(bars).fill(0);
    for (const d of this.done) {
      const i = Math.floor((d.t - start) / LIVE_BAR_MS);
      if (i < 0 || i >= bars) continue;
      doneBar[i]!++;
      if (d.status === "error") errors[i]!++;
      else okBar[i]!++;
      if (d.ttfbMs !== null) ttfbBar[i]!.push(d.ttfbMs);
    }

    let recentStarts = 0;
    for (let i = this.starts.length - 1; i >= 0 && this.starts[i]! > now - 10_000; i--) recentStarts++;
    let peak = 0;
    for (let i = 0; i < bars - 1; i++) peak = Math.max(peak, total[i]! / (LIVE_BAR_MS / 1000));

    let ok = 0;
    let err = 0;
    const ttfbs: number[] = [];
    const models = new Map<string, number>();
    const origins = new Map<string, number>();
    const sites = new Map<string, number>();
    const groups = new Map<string, number>();
    const routeCount = new Map<number, number>();
    const routeErr = new Map<number, number>();
    const routeTtfb = new Map<number, number[]>();
    for (let i = this.done.length - 1; i >= 0; i--) {
      const d = this.done[i]!;
      if (d.t < now - PANEL_WINDOW_MS) break;
      models.set(d.model, (models.get(d.model) ?? 0) + 1);
      // A request with no shown region counts toward the unplaced row (OS-D6).
      const originKey = d.origin === "" ? UNPLACED_KEY : d.origin;
      origins.set(originKey, (origins.get(originKey) ?? 0) + 1);
      if (d.route !== null) {
        routeCount.set(d.route, (routeCount.get(d.route) ?? 0) + 1);
        if (d.status === "error") routeErr.set(d.route, (routeErr.get(d.route) ?? 0) + 1);
        if (d.ttfbMs !== null) {
          const list = routeTtfb.get(d.route);
          if (list) list.push(d.ttfbMs);
          else routeTtfb.set(d.route, [d.ttfbMs]);
        }
        const info = this.topology.routes[d.route]!;
        groups.set(info.group, (groups.get(info.group) ?? 0) + 1);
        const at = this.siteOf(d.route);
        if (at) sites.set(at, (sites.get(at) ?? 0) + 1);
      }
      if (d.t >= now - KPI_WINDOW_MS) {
        if (d.status === "error") err++;
        else ok++;
        if (d.ttfbMs !== null) ttfbs.push(d.ttfbMs);
      }
    }
    ttfbs.sort((a, b) => a - b);
    const routes = this.routeRows(routeCount, routeErr, routeTtfb);

    const sparkFrom = bars - 60;
    return {
      ready: true,
      mode: "live",
      window: this.window,
      view: this.view,
      viewer: this.viewer,
      caps: this.live.capabilities,
      stale: this.live.stale === true,
      clock: now,
      playing: true,
      speed: this.speed,
      wholeWindow: false,
      kpi: {
        rps: recentStarts / 10,
        rpsPeak: peak,
        successRate: ok + err > 0 ? ok / (ok + err) : 1,
        errors: err,
        ttfbP50: percentile(ttfbs, 0.5),
        ttfbP95: percentile(ttfbs, 0.95),
        inflight: this.flights.size,
        total: this.baseline24h.total + this.extraTotal,
        failover: this.failovers,
      },
      spark: {
        // Trailing windows (30 s for the rate, 60 s for the others): a 10-second bar holds too few
        // requests for a stable ratio or median.
        rps: this.trail(sparkFrom, bars - 1, 3, (from, to) => {
          let sum = 0;
          for (let i = from; i <= to; i++) sum += total[i]!;
          return sum / ((to - from + 1) * (LIVE_BAR_MS / 1000));
        }),
        ttfb: this.trail(sparkFrom, bars - 1, 6, (from, to) => {
          const merged: number[] = [];
          for (let i = from; i <= to; i++) merged.push(...ttfbBar[i]!);
          return percentile(merged.sort((a, b) => a - b), 0.5);
        }),
        ok: this.trail(sparkFrom, bars - 1, 6, (from, to) => {
          let good = 0;
          let all = 0;
          for (let i = from; i <= to; i++) {
            good += okBar[i]!;
            all += doneBar[i]!;
          }
          return all > 0 ? good / all : 1;
        }),
      },
      models: topRows(models, (key) => key, 10),
      routes,
      origins: topRows(origins, (key) => (key === UNPLACED_KEY ? UNPLACED_NAME : (this.originName.get(key) ?? key)), 10),
      sites: topRows(sites, (key) => this.siteName.get(key) ?? key, 6),
      groups: topRows(groups, (key) => key, 6),
      ticker: this.feedRows(),
      timeline: { start, stepMs: LIVE_BAR_MS, total, errors, cursor: (now - start) / (end - start), live: true },
      range: { from: now - PANEL_WINDOW_MS, to: now },
    };
  }

  private trail(from: number, to: number, width: number, at: (from: number, to: number) => number): number[] {
    const out: number[] = [];
    for (let i = from; i < to; i++) out.push(at(Math.max(0, i - width + 1), i));
    return out;
  }

  // ------------------------------------------------------------------ node detail

  /** Figures of one map node for the range on screen, or null for an unknown id. */
  detail(id: string, now: number): NodeDetail | null {
    const gw = this.topology.gateway;
    const kind = id === gw.id ? "gateway" : id.startsWith("up:") ? "upstream" : id.startsWith("o:") ? "origin" : null;
    if (!kind) return null;
    const key = kind === "gateway" ? id : id.slice(id.indexOf(":") + 1);
    const upstream = kind === "upstream" ? this.topology.upstreams.find((site) => site.id === key) : undefined;
    const place = kind === "gateway" ? gw : kind === "upstream" ? upstream : this.topology.origins.find((site) => site.id === key);
    if (!place) return null;
    const colo = kind === "upstream" && Math.hypot(place.lon - gw.lon, place.lat - gw.lat) < 1.5;
    const note = colo ? "与网关在同一机房" : upstream?.anycast ? "任播地址，实际服务器位置未知" : undefined;
    const base = { id, kind, name: place.name, region: place.region, note } as const;
    const names = { origin: (k: string) => this.originName.get(k) ?? k, site: (k: string) => this.siteName.get(k) ?? k };

    if (this.mode === "replay" && this.replay) {
      const data = this.replay;
      const [from, to] = this.replaySpan(data);
      const sum = this.sumBuckets(data, from, to);
      const scope = this.wholeWindow ? "整个时间窗" : "当前时段";
      // At most 120 points: buckets are merged in equal groups.
      const group = Math.ceil(data.buckets.length / 120);
      const series = (value: (i: number) => number) => {
        const out: number[] = [];
        for (let i = 0; i < data.buckets.length; i += group) {
          let v = 0;
          for (let j = i; j < Math.min(data.buckets.length, i + group); j++) v += value(j);
          out.push(v);
        }
        return out;
      };
      if (kind === "origin") {
        const index = this.topology.origins.findIndex((site) => site.id === key);
        const requests = sum.origins[index] ?? 0;
        return { ...base, scope, requests, share: sum.total > 0 ? requests / sum.total : 0, okRate: null, ttfbP50: null, inflight: null, models: [], routes: [], origins: [], sites: [], recent: [], trend: series((i) => data.buckets[i]!.origins[index] ?? 0), noBreakdown: true };
      }
      const mine = (route: number) => route >= 0 && (kind === "gateway" || this.siteOf(route) === key);
      const count = new Map<number, number>();
      const err = new Map<number, number>();
      let requests = kind === "gateway" ? sum.total : 0;
      let errors = kind === "gateway" ? sum.errors : 0;
      for (const [route, value] of sum.routeCount) {
        if (!mine(route)) continue;
        count.set(route, value);
        err.set(route, sum.routeErr.get(route) ?? 0);
        if (kind !== "gateway") {
          requests += value;
          errors += sum.routeErr.get(route) ?? 0;
        }
      }
      const siteCount = new Map<string, number>();
      for (const [route, value] of sum.routeCount) {
        const at = route >= 0 ? this.siteOf(route) : null;
        if (at) siteCount.set(at, (siteCount.get(at) ?? 0) + value);
      }
      const originCount = new Map<string, number>();
      sum.origins.forEach((value, i) => originCount.set(this.topology.origins[i]!.id, value));
      return {
        ...base,
        scope,
        requests,
        share: sum.total > 0 ? requests / sum.total : 0,
        okRate: this.live.capabilities.errors && requests > 0 ? 1 - errors / requests : null,
        ttfbP50: kind === "gateway" && sum.ttfbP50 > 0 ? sum.ttfbP50 : null,
        inflight: null,
        models: kind === "gateway" ? sum.models.map((value, i) => ({ key: String(i), name: data.models[i]!, count: value, share: sum.total > 0 ? value / sum.total : 0 })).filter((row) => row.count >= 0.5).sort((a, b) => b.count - a.count).slice(0, 5) : [],
        routes: this.routeRows(count, err, null).slice(0, 5),
        origins: kind === "gateway" ? topRows(originCount, names.origin, 5) : [],
        sites: kind === "gateway" ? topRows(siteCount, names.site, 5) : [],
        recent: [],
        trend: series((i) => {
          const bucket = data.buckets[i]!;
          if (kind === "gateway") return bucket.total;
          let v = 0;
          for (let j = 0; j < bucket.routes.length; j += 3) if (mine(bucket.routes[j]!)) v += bucket.routes[j + 1]!;
          return v;
        }),
        noBreakdown: kind !== "gateway",
      };
    }

    const mine = (origin: string, route: number | null) => kind === "gateway" || (kind === "origin" ? origin === key : route !== null && this.siteOf(route) === key);
    const models = new Map<string, number>();
    const origins = new Map<string, number>();
    const sites = new Map<string, number>();
    const count = new Map<number, number>();
    const err = new Map<number, number>();
    const ttfb = new Map<number, number[]>();
    const samples: number[] = [];
    const recent: RecentRow[] = [];
    const trend = new Array<number>(30).fill(0);
    let requests = 0;
    let errors = 0;
    let all = 0;
    for (let i = this.done.length - 1; i >= 0; i--) {
      const d = this.done[i]!;
      const age = now - d.t;
      if (age >= LIVE_HISTORY_MS) break;
      const match = mine(d.origin, d.route);
      if (match && age >= 0) trend[29 - Math.min(29, Math.floor(age / 60_000))]!++;
      if (age >= PANEL_WINDOW_MS) continue;
      all++;
      if (!match) continue;
      requests++;
      if (d.status === "error") errors++;
      if (d.ttfbMs !== null) samples.push(d.ttfbMs);
      models.set(d.model, (models.get(d.model) ?? 0) + 1);
      origins.set(d.origin, (origins.get(d.origin) ?? 0) + 1);
      if (d.route !== null) {
        count.set(d.route, (count.get(d.route) ?? 0) + 1);
        if (d.status === "error") err.set(d.route, (err.get(d.route) ?? 0) + 1);
        if (d.ttfbMs !== null) {
          const list = ttfb.get(d.route);
          if (list) list.push(d.ttfbMs);
          else ttfb.set(d.route, [d.ttfbMs]);
        }
        const at = this.siteOf(d.route);
        if (at) sites.set(at, (sites.get(at) ?? 0) + 1);
      }
      if (recent.length < 6) recent.push({ t: d.t, origin: names.origin(d.origin), route: d.route !== null ? this.labelOf(d.route) : "网关拒绝", model: d.model, status: d.status, durationMs: d.durationMs, errorCode: d.errorCode });
    }
    let inflight = 0;
    for (const flight of this.flights.values()) if (kind === "gateway" || (kind === "origin" ? flight.origin === key : flight.site === key)) inflight++;
    samples.sort((a, b) => a - b);
    return {
      ...base,
      scope: "近 15 分钟",
      requests,
      share: all > 0 ? requests / all : 0,
      okRate: this.live.capabilities.errors && requests > 0 ? 1 - errors / requests : null,
      ttfbP50: samples.length > 0 ? percentile(samples, 0.5) : null,
      inflight,
      models: topRows(models, (k) => k, 5),
      routes: this.routeRows(count, err, ttfb).slice(0, 5),
      origins: kind === "origin" ? [] : topRows(origins, names.origin, 5),
      sites: kind === "upstream" ? [] : topRows(sites, names.site, 5),
      recent,
      trend,
      noBreakdown: false,
    };
  }

  // ------------------------------------------------------------------ replay

  private replayIndex(data: ReplayData): number {
    return Math.max(0, Math.min(data.buckets.length - 1, Math.floor((this.playhead - data.start) / data.stepMs)));
  }

  /** Sums the buckets `[from, to]` into per-origin, per-route and per-model totals. */
  private sumBuckets(data: ReplayData, from: number, to: number) {
    const origins = new Array<number>(this.topology.origins.length).fill(0);
    const models = new Array<number>(data.models.length).fill(0);
    const routeCount = new Map<number, number>();
    const routeErr = new Map<number, number>();
    let total = 0;
    let errors = 0;
    let ttfb = 0;
    for (let i = from; i <= to; i++) {
      const b = data.buckets[i]!;
      total += b.total;
      errors += b.errors;
      ttfb += b.ttfbP50 * b.total;
      for (let j = 0; j < origins.length; j++) origins[j]! += b.origins[j] ?? 0;
      for (let j = 0; j < models.length; j++) models[j]! += b.models[j] ?? 0;
      for (let j = 0; j < b.routes.length; j += 3) {
        const r = b.routes[j]!;
        routeCount.set(r, (routeCount.get(r) ?? 0) + b.routes[j + 1]!);
        routeErr.set(r, (routeErr.get(r) ?? 0) + b.routes[j + 2]!);
      }
    }
    return { origins, models, routeCount, routeErr, total, errors, ttfbP50: total > 0 ? ttfb / total : 0 };
  }

  private replaySpan(data: ReplayData): [number, number] {
    if (this.wholeWindow) return [0, data.buckets.length - 1];
    const index = this.replayIndex(data);
    return [index, index];
  }

  private applyReplayScene(data: ReplayData) {
    const [from, to] = this.replaySpan(data);
    const sum = this.sumBuckets(data, from, to);
    const gw = this.topology.gateway.id;
    const flows: AggregateFlow[] = [];
    // Relative to the busiest bucket of the window, so quiet hours look quiet.
    const scale = this.wholeWindow ? Math.max(1, sum.total) : Math.max(1, ...data.buckets.map((b) => b.total));
    const maxOrigin = Math.max(1e-9, ...sum.origins);
    sum.origins.forEach((count, i) => {
      const id = `o:${this.topology.origins[i]!.id}`;
      const level = (count / maxOrigin) * Math.min(1, (sum.total / scale) * 1.15 + 0.08);
      this.renderer.setNodeMeta(id, { value: level });
      if (count > 0) flows.push({ from: id, to: gw, kind: "in", weight: level, errShare: 0 });
    });
    const siteCount = new Map<string, number>();
    const siteErr = new Map<string, number>();
    for (const [route, count] of sum.routeCount) {
      const site = route >= 0 ? this.siteOf(route) : null;
      if (!site) continue;
      siteCount.set(site, (siteCount.get(site) ?? 0) + count);
      siteErr.set(site, (siteErr.get(site) ?? 0) + (sum.routeErr.get(route) ?? 0));
    }
    const maxSite = Math.max(1e-9, ...siteCount.values());
    for (const site of this.topology.upstreams) {
      // Bucket counts are scaled shares of an hour, so a site can hold a fraction of one request.
      const count = (siteCount.get(site.id) ?? 0) >= 0.5 ? siteCount.get(site.id)! : 0;
      const errShare = count > 0 ? (siteErr.get(site.id) ?? 0) / count : 0;
      const level = (count / maxSite) * Math.min(1, (sum.total / scale) * 1.15 + 0.08);
      this.renderer.setNodeMeta(`up:${site.id}`, {
        value: level,
        health: this.live.capabilities.errors ? 1 - errShare : null,
        sub: count <= 0 ? "" : count / sum.total < 0.001 ? "占 <0.1%" : `占 ${((count / sum.total) * 100).toFixed(count / sum.total < 0.1 ? 1 : 0)}%`,
      });
      if (count > 0) flows.push({ from: gw, to: `up:${site.id}`, kind: "out", weight: level, errShare });
    }
    this.renderer.setAggregate(flows);
  }

  private replaySnapshot(data: ReplayData): Snapshot {
    const index = this.replayIndex(data);
    const [from, to] = this.replaySpan(data);
    const sum = this.sumBuckets(data, from, to);
    const seconds = ((to - from + 1) * data.stepMs) / 1000;
    let cumulative = 0;
    let peak = 0;
    const upTo = this.wholeWindow ? data.buckets.length - 1 : index;
    for (let i = 0; i < data.buckets.length; i++) {
      if (i <= upTo) cumulative += data.buckets[i]!.total;
      peak = Math.max(peak, data.buckets[i]!.total / (data.stepMs / 1000));
    }
    const routes = this.routeRows(sum.routeCount, sum.routeErr, null);
    // Requests that the source places in no region (OS-SV5) are one row of their own, so the
    // shares add up to all requests.
    const placed = sum.origins.reduce((a, b) => a + b, 0);
    const unplaced = sum.total - placed;
    const originRows: RankRow[] = sum.origins.map((count, i) => ({ key: String(i), name: this.topology.origins[i]!.name, count, share: sum.total > 0 ? count / sum.total : 0 })).filter((row) => row.count >= 0.5);
    if (unplaced >= 0.5 && unplaced / Math.max(1, sum.total) >= 0.001) originRows.push({ key: UNPLACED_KEY, name: UNPLACED_NAME, count: unplaced, share: unplaced / sum.total });
    originRows.sort((a, b) => b.count - a.count);
    originRows.length = Math.min(originRows.length, 10);
    const rank = (values: number[], names: (i: number) => string, limit: number): RankRow[] => {
      const total = values.reduce((a, b) => a + b, 0);
      return values
        .map((count, i) => ({ key: String(i), name: names(i), count, share: total > 0 ? count / total : 0 }))
        .filter((row) => row.count >= 0.5)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    };
    const siteCount = new Map<string, number>();
    const groupCount = new Map<string, number>();
    for (const [route, count] of sum.routeCount) {
      const info = route >= 0 ? this.topology.routes[route] : undefined;
      if (!info) continue;
      groupCount.set(info.group, (groupCount.get(info.group) ?? 0) + count);
      const at = this.siteOf(route);
      if (at) siteCount.set(at, (siteCount.get(at) ?? 0) + count);
    }
    const sparkFrom = Math.max(0, upTo - 59);
    const window = data.buckets.slice(sparkFrom, upTo + 1);
    return {
      ready: true,
      mode: "replay",
      window: this.window,
      view: this.view,
      viewer: this.viewer,
      caps: this.live.capabilities,
      stale: this.stale,
      clock: this.wholeWindow ? data.end : this.playhead,
      playing: this.playing,
      speed: this.speed,
      wholeWindow: this.wholeWindow,
      kpi: {
        rps: sum.total / seconds,
        rpsPeak: peak,
        successRate: sum.total > 0 ? 1 - sum.errors / sum.total : 1,
        errors: sum.errors,
        ttfbP50: sum.ttfbP50,
        ttfbP95: 0,
        inflight: 0,
        total: cumulative,
        failover: 0,
      },
      spark: {
        rps: window.map((b) => b.total / (data.stepMs / 1000)),
        ttfb: window.map((b) => b.ttfbP50),
        ok: window.map((b) => (b.total > 0 ? 1 - b.errors / b.total : 1)),
      },
      models: rank(sum.models, (i) => data.models[i]!, 10),
      routes,
      origins: originRows,
      sites: topRows(siteCount, (key) => this.siteName.get(key) ?? key, 6),
      groups: topRows(groupCount, (key) => key, 6),
      ticker: [],
      timeline: {
        start: data.start,
        stepMs: data.stepMs,
        total: data.buckets.map((b) => b.total),
        errors: data.buckets.map((b) => b.errors),
        cursor: this.wholeWindow ? 1 : (this.playhead - data.start) / (data.end - data.start),
        live: false,
      },
      range: { from: data.buckets[from]!.t0, to: data.buckets[to]!.t0 + data.stepMs },
    };
  }
}
