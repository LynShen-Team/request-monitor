import { parseConfig, type ConfigSource, type ScreenConfig } from "../core/config";

declare global {
  interface Window {
    /** Written into the single-file build by `scripts/inline.ts --config <file>`. */
    __OPS_CONFIG__?: unknown;
  }
}

/** Preview config: the defaults, or what the single-file build carries; always marked as sample data. */
export class PreviewConfig implements ConfigSource {
  async load(): Promise<ScreenConfig> {
    return { ...parseConfig(window.__OPS_CONFIG__), note: "样例数据" };
  }
}
