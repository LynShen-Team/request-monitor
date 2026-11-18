import { parseConfig, type ConfigSource, type ScreenConfig } from "../core/config";
import { LoginRequired, type Role } from "../core/identity";
import type { Capabilities, LiveEvent, LiveSource, ReplayData, ReplaySource, ReplayWindow, Topology } from "../core/model";

/**
 * Data source that reads the ops screen service (docs/spec-service.md section 9). Paths are
 * relative to the page, so the service can be mounted under any path of a reverse proxy.
 */

export interface Meta {
  gateway: string;
  capabilities: Capabilities;
  /** Distinct clients a region needs in a day to be shown (OS-B3). */
  minClients: number;
  /** True while the service still reads older history: early parts of a window may be empty. */
  backfilling: boolean;
}

interface TopologyAnswer {
  version: string;
  topology: Topology;
  baseline24h: { total: number; errors: number };
}

const TIMEOUT_MS = 15_000;

/** The service answered `401 login_required`: this visitor may not open the screen (OS-SN5). */
class Denied extends Error {}

async function get<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, document.baseURI), { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    if (response.status === 401) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (body?.error === "login_required") throw new Denied(path);
    }
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface Identity {
  role: Role;
  /** Null when the service could not be asked. */
  allowed: boolean | null;
  loginUrl: string | null;
}

/** A sign-in address is used only when it is an http(s) URL: the page makes a link of it. */
function loginAddress(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Who the service says the visitor is. A visitor it could not be asked about is a guest. */
async function identify(): Promise<Identity> {
  try {
    const answer = await get<{ role?: unknown; allowed?: unknown; loginUrl?: unknown }>("api/identity");
    const role = answer.role === "admin" || answer.role === "user" ? answer.role : "guest";
    return { role, allowed: answer.allowed !== false, loginUrl: loginAddress(answer.loginUrl) };
  } catch {
    return { role: "guest", allowed: null, loginUrl: null };
  }
}

export class NetConfig implements ConfigSource {
  async load(): Promise<ScreenConfig> {
    try {
      return parseConfig(await get<unknown>("api/config"));
    } catch {
      return parseConfig(null);
    }
  }
}

/** Topology, baseline, and (once the service has them) live events. */
export class NetLive implements LiveSource {
  readonly topology: Topology;
  readonly baseline24h: { total: number; errors: number };
  readonly capabilities: Capabilities;

  constructor(answer: TopologyAnswer, capabilities: Capabilities) {
    this.topology = answer.topology;
    this.baseline24h = answer.baseline24h;
    this.capabilities = capabilities;
  }

  /** The service sends no live events yet (capabilities.live is `none`). */
  poll(): LiveEvent[] {
    return [];
  }
}

export class NetReplay implements ReplaySource {
  onTopology?: (topology: Topology, baseline24h: { total: number; errors: number }) => void;
  /** The visitor's role now. Called when the topology version changed: a new role is one cause. */
  onRole?: (role: Role) => void;
  /** The service asks for a sign-in: the session ended and the deployment lets no guest in. */
  onLoginRequired?: () => void;
  private version: string;

  constructor(version: string) {
    this.version = version;
  }

  async load(window: ReplayWindow): Promise<ReplayData> {
    try {
      let answer = await get<{ version: string; data: ReplayData }>(`api/replay?window=${window}`);
      // The indices of a replay refer to one topology version (OS-SH4): on a change the topology
      // is fetched first, and the replay again if the topology moved on once more in between.
      for (let attempt = 0; attempt < 3 && answer.version !== this.version; attempt++) {
        const [next, identity] = await Promise.all([get<TopologyAnswer>("api/topology"), identify()]);
        this.version = next.version;
        // The role first: the page reads a topology with the viewer it belongs to.
        if (identity.allowed !== null) this.onRole?.(identity.role);
        this.onTopology?.(next.topology, next.baseline24h);
        if (next.version !== answer.version) answer = await get<{ version: string; data: ReplayData }>(`api/replay?window=${window}`);
      }
      if (answer.version !== this.version) throw new Error("the topology kept changing while the replay was loaded");
      return answer.data;
    } catch (error) {
      if (error instanceof Denied) this.onLoginRequired?.();
      throw error;
    }
  }
}

/** True while the service still reads older history. */
export async function backfilling(): Promise<boolean> {
  return (await get<Meta>("api/meta")).backfilling;
}

export interface NetSources {
  meta: Meta;
  live: NetLive;
  replay: NetReplay;
  role: Role;
  config: ScreenConfig;
}

/**
 * Asks the service for everything the screen needs to start. Rejects with `LoginRequired` when
 * the visitor must sign in first, and with another error when the service does not answer.
 */
export async function openNetwork(): Promise<NetSources> {
  const [identity, config] = await Promise.all([identify(), new NetConfig().load()]);
  const gate = () => new LoginRequired(identity.loginUrl, config, async () => (await identify()).allowed === true);
  if (identity.allowed === false) throw gate();
  try {
    const [answer, topology] = await Promise.all([get<Meta>("api/meta"), get<TopologyAnswer>("api/topology")]);
    // The page has no reader for the service's live events (`api/live`) yet. Until it has one,
    // live mode is off whatever the service offers, so the screen never opens on a view that
    // nothing feeds.
    const meta: Meta = { ...answer, capabilities: { ...answer.capabilities, live: "none" } };
    return { meta, live: new NetLive(topology, meta.capabilities), replay: new NetReplay(topology.version), role: identity.role, config };
  } catch (error) {
    throw error instanceof Denied ? gate() : error;
  }
}
