/** Data contract of the ops screen. The preview fills it from sample data; production fills it from the API. */

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

export interface LiveSource {
  readonly topology: Topology;
  /** Requests of the 24 hours before the screen opened; the live counter adds to it. */
  readonly baseline24h: { total: number; errors: number };
  /** Every event with `t <= now` not returned before, in time order. The first call returns warm-up history. */
  poll(now: number): LiveEvent[];
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
  load(window: ReplayWindow): Promise<ReplayData>;
}
