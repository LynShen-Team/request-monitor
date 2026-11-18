import { parseConfig, type ConfigSource, type ScreenConfig } from "../core/config";
import { LoginRequired, type Role } from "../core/identity";
import type { Capabilities, ReplayData, ReplaySource, ReplayWindow, Topology } from "../core/model";
import { LiveRefused, NetLive } from "./live";

/**
 * Data source that reads the Request Monitor service (docs/spec-service.md section 9). Paths are
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

type Baseline = { total: number; errors: number };

/** The service answered `401 login_required`: this visitor may not open the screen (OS-SN5). */
class Denied extends Error {}

/** Any other answer that is not 2xx, with the `error` code of its body when it has one. */
class HttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(path: string, status: number, code: string | null) {
    super(`${path}: HTTP ${status}${code ? ` ${code}` : ""}`);
    this.status = status;
    this.code = code;
  }
}

async function get<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, document.baseURI), { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (response.status === 401 && body?.error === "login_required") throw new Denied(path);
      throw new HttpError(path, response.status, typeof body?.error === "string" ? body.error : null);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** `api/live`, with the two refusals that the reader handles itself (OS-N9.7, OS-N9.8). */
async function fetchLive(after: string | null): Promise<unknown> {
  try {
    return await get<unknown>(after === null ? "api/live" : `api/live?after=${encodeURIComponent(after)}`);
  } catch (error) {
    if (error instanceof Denied) throw new LiveRefused("login_required");
    if (error instanceof HttpError && error.status === 404 && error.code === "live_unavailable") throw new LiveRefused("live_unavailable");
    throw error;
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

/**
 * What the replay and the live reader share: the topology version that the indices of their
 * answers refer to (OS-SH4), and the page's handlers for a new role and for a required sign-in.
 */
export class NetSession {
  version: string;
  /** The visitor's role now. Called when the topology version changed: a new role is one cause. */
  onRole?: (role: Role) => void;
  /** The service asks for a sign-in: the session ended and the deployment lets no guest in. */
  onLoginRequired?: () => void;
  private readonly listeners: Array<(topology: Topology, baseline24h: Baseline) => void> = [];
  private refreshing: Promise<void> | null = null;

  constructor(version: string) {
    this.version = version;
  }

  /** Called with every newer topology. */
  listen(listener: (topology: Topology, baseline24h: Baseline) => void) {
    this.listeners.push(listener);
  }

  /** Fetches the topology and the role again (OS-N3). Calls at the same time share one fetch. */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const [next, identity] = await Promise.all([get<TopologyAnswer>("api/topology"), identify()]);
        const changed = next.version !== this.version;
        this.version = next.version;
        // The role first: the page reads a topology with the viewer it belongs to.
        if (identity.allowed !== null) this.onRole?.(identity.role);
        if (changed) for (const listener of this.listeners) listener(next.topology, next.baseline24h);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

export class NetReplay implements ReplaySource {
  onTopology?: (topology: Topology, baseline24h: Baseline) => void;
  private readonly session: NetSession;

  constructor(session: NetSession) {
    this.session = session;
    session.listen((topology, baseline24h) => this.onTopology?.(topology, baseline24h));
  }

  async load(window: ReplayWindow): Promise<ReplayData> {
    try {
      let answer = await get<{ version: string; data: ReplayData }>(`api/replay?window=${window}`);
      // The indices of a replay refer to one topology version (OS-SH4): on a change the topology
      // is fetched first, and the replay again if the topology moved on once more in between.
      for (let attempt = 0; attempt < 3 && answer.version !== this.session.version; attempt++) {
        await this.session.refresh();
        if (this.session.version !== answer.version) answer = await get<{ version: string; data: ReplayData }>(`api/replay?window=${window}`);
      }
      if (answer.version !== this.session.version) throw new Error("the topology kept changing while the replay was loaded");
      return answer.data;
    } catch (error) {
      if (error instanceof Denied) this.session.onLoginRequired?.();
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
  session: NetSession;
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
    const [meta, topology] = await Promise.all([get<Meta>("api/meta"), get<TopologyAnswer>("api/topology")]);
    const session = new NetSession(topology.version);
    const replay = new NetReplay(session);
    const live = new NetLive(topology, meta.capabilities, {
      fetchLive,
      version: () => session.version,
      refreshTopology: () =>
        session.refresh().catch((error: unknown) => {
          throw error instanceof Denied ? new LiveRefused("login_required") : error;
        }),
      loginRequired: () => session.onLoginRequired?.(),
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (timer) => window.clearTimeout(timer as number),
    });
    // A newer topology, whichever answer brought it, makes the live events of the old one useless.
    session.listen(() => live.restart());
    return { meta, live, replay, session, role: identity.role, config };
  } catch (error) {
    throw error instanceof Denied ? gate() : error;
  }
}
