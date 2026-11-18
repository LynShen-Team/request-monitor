import type { ScreenConfig } from "./core/config";
import type { Role } from "./core/identity";
import type { LiveSource, ReplaySource } from "./core/model";

declare const __OPS_SOURCE__: "preview" | "network";

export interface Sources {
  kind: "preview" | "network";
  live: LiveSource;
  replay: ReplaySource;
  role: Role;
  config: ScreenConfig;
  /** Set by the service while it still reads older history. */
  backfilling: boolean;
  /** Asks the source again whether it still reads older history. */
  checkBackfilling?: () => Promise<boolean>;
  /** Distinct clients a region needs to be shown; null when the source has no such rule. */
  minClients: number | null;
  /** Tells the page when the source reports another role, or asks for a sign-in, after the start. */
  watch?: (handlers: { role: (role: Role) => void; loginRequired: () => void }) => void;
}

/**
 * Which data the page reads is fixed by the build: the single-file preview reads the built-in
 * sample and sends no request; the build that the service serves reads the service. In the
 * latter, `?source=preview` shows the sample instead.
 */
export function sourceKind(params: URLSearchParams): "preview" | "network" {
  return __OPS_SOURCE__ === "network" && params.get("source") !== "preview" ? "network" : "preview";
}

export async function openSources(params: URLSearchParams, now: number): Promise<Sources> {
  if (sourceKind(params) === "network") {
    const { openNetwork, backfilling } = await import("./net/source");
    const net = await openNetwork();
    return {
      kind: "network",
      live: net.live,
      replay: net.replay,
      role: net.role,
      config: net.config,
      backfilling: net.meta.backfilling,
      checkBackfilling: backfilling,
      minClients: net.meta.minClients,
      watch: (handlers) => {
        net.session.onRole = handlers.role;
        net.session.onLoginRequired = handlers.loginRequired;
      },
    };
  }
  const [{ PreviewLive, PreviewReplay, loadPreviewData }, { PreviewIdentity }, { PreviewConfig }] = await Promise.all([import("./preview/sim"), import("./preview/identity"), import("./preview/config")]);
  const data = await loadPreviewData(now);
  const rate = Math.max(0.1, Math.min(50, Number(params.get("rate")) || 1));
  const [role, config] = await Promise.all([new PreviewIdentity(params).identify(), new PreviewConfig().load()]);
  return { kind: "preview", live: new PreviewLive(data, now, rate), replay: new PreviewReplay(data), role, config, backfilling: false, minClients: null };
}
