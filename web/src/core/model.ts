/** Data contract of Request Monitor. The preview fills it from sample data; production fills it from the API. */

export type FlowStatus = "success" | "error" | "client_gone";
export type ReplayWindow = "24h" | "7d" | "30d";

export interface Site {
  id: string;
  /** City name. */
  name: string;
  /** Country or province. */
  region: string;
  lat: number;
  lon: number;
}

export interface UpstreamSite extends Site {
  /** True when the address is an anycast CDN edge, so the origin server's place is unknown. */
  anycast?: boolean;
  /** Channels whose base URL resolves to this site. */
  channels: number;
}

export interface RouteInfo {
  /** User-facing Group name (`group_label`). */
  group: string;
  /** User-facing Channel name (`channel_label`). */
  channel: string;
  /** Upstream site id, or null when the Channel host has no known place. */
  upstream: string | null;
  /**
   * True when only an admin may see the Channel: every other viewer sees the Group name alone,
   * with all Channels of the Group counted together. Set by the server from the Group's class.
   */
  restricted: boolean;
}

/** Who is looking: an admin, or anyone else (a signed-in user or a visitor). */
export type Viewer = "admin" | "user";

export interface Topology {
  gateway: Site;
  upstreams: UpstreamSite[];
  /** User regions, city level at the finest. */
  origins: Site[];
  routes: RouteInfo[];
}

/**
 * One request lifecycle as the screen sees it. `origin` is a region id resolved by the server;
 * the browser never receives a client address, user, key, or payload.
 */
export type LiveEvent =
  | { type: "start"; id: number; t: number; origin: string; model: string }
  /** A Channel was selected. A second `route` for one id means the earlier attempt failed. */
  | { type: "route"; id: number; t: number; route: number }
  | { type: "ttfb"; id: number; t: number; ttfbMs: number }
  | { type: "end"; id: number; t: number; status: FlowStatus; ttfbMs: number | null; durationMs: number; errorCode?: string };

/** What the gateway records, so that the page can say what is missing instead of showing a guess. */
export interface Capabilities {
  /** `realtime`: events arrive as they happen. `replayed`: a request is shown after it ended. `none`: no live mode. */
  live: "none" | "replayed" | "realtime";
  /** False when requests carry no user region. */
  origin: boolean;
  /** False when the gateway does not log failed requests, so no success rate exists. */
  errors: boolean;
  durationPrecisionMs: number;
}

export interface LiveSource {
  readonly topology: Topology;
  readonly capabilities: Capabilities;
  /** Requests of the 24 hours before the screen opened; the live counter adds to it. */
  readonly baseline24h: { total: number; errors: number };
  /** Every event with `t <= now` not returned before, in time order. The first call returns warm-up history. */
  poll(now: number): LiveEvent[];
  /** False until the source has delivered its first events (docs/spec-screen.md OS-N9.5). Absent: always ready. */
  readonly ready?: boolean;
  /** True while the source cannot read its events and the screen shows what it has (OS-N9.6). */
  readonly stale?: boolean;
  /**
   * Set by the screen. The source calls it from `poll` before it returns events that replace all it
   * returned before (OS-N9.3, OS-N9.4): the screen drops everything it built from them.
   */
  onReset?: () => void;
  /** Stops the source for good (OS-N9.9). */
  close?(): void;
}

export interface ReplayBucket {
  t0: number;
  total: number;
  errors: number;
  ttfbP50: number;
  /** Packed triples: route index (-1 = rejected at the gateway), requests, errors. */
  routes: number[];
  /** Requests per origin, indexed like `Topology.origins`. */
  origins: number[];
  /** Requests per model, indexed like `ReplayData.models`. */
  models: number[];
}

export interface ReplayData {
  window: ReplayWindow;
  start: number;
  end: number;
  stepMs: number;
  models: string[];
  buckets: ReplayBucket[];
}

export interface ReplaySource {
  /** Rejects when the data cannot be fetched; the screen then keeps what it has. */
  load(window: ReplayWindow): Promise<ReplayData>;
  /**
   * Set by the screen. A source whose topology can change calls it before `load` resolves with data
   * that is indexed by a newer topology.
   */
  onTopology?: (topology: Topology, baseline24h: { total: number; errors: number }) => void;
}
