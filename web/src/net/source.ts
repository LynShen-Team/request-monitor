import { parseConfig, type ConfigSource, type ScreenConfig } from "../core/config";
import type { IdentitySource, Role } from "../core/identity";
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

async function get<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, document.baseURI), { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export class NetIdentity implements IdentitySource {
  /** A visitor the service could not be asked about is a guest. */
  async identify(): Promise<Role> {
    try {
      const { role } = await get<{ role: unknown }>("api/identity");
      return role === "admin" || role === "user" ? role : "guest";
    } catch {
      return "guest";
    }
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
  private version: string;

  constructor(version: string) {
    this.version = version;
  }

  async load(window: ReplayWindow): Promise<ReplayData> {
    let answer = await get<{ version: string; data: ReplayData }>(`api/replay?window=${window}`);
    // The indices of a replay refer to one topology version (OS-SH4): on a change the topology
    // is fetched first, and the replay again if the topology moved on once more in between.
    for (let attempt = 0; attempt < 3 && answer.version !== this.version; attempt++) {
      const next = await get<TopologyAnswer>("api/topology");
      this.version = next.version;
      this.onTopology?.(next.topology, next.baseline24h);
      if (next.version !== answer.version) answer = await get<{ version: string; data: ReplayData }>(`api/replay?window=${window}`);
    }
    if (answer.version !== this.version) throw new Error("the topology kept changing while the replay was loaded");
    return answer.data;
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

/** Asks the service for everything the screen needs to start. Rejects when the service does not answer. */
export async function openNetwork(): Promise<NetSources> {
  const [meta, topology, role, config] = await Promise.all([get<Meta>("api/meta"), get<TopologyAnswer>("api/topology"), new NetIdentity().identify(), new NetConfig().load()]);
  return { meta, live: new NetLive(topology, meta.capabilities), replay: new NetReplay(topology.version), role, config };
}
