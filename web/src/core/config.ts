/** What a deployment may set about how the screen presents itself. Every field is optional. */
export interface ScreenConfig {
  /** Shown in the header. Default: 数据大屏. */
  title: string;
  /** Logo per theme, as a URL or a data URI; drawn left of the title. */
  logo?: { day: string; night: string };
  /** A short note beside the title, for example that the data is a sample. */
  note?: string;
  /** One line at the bottom right of the scene, for example the credit of a data source. */
  attribution?: { text: string; url?: string };
}

export const DEFAULT_CONFIG: ScreenConfig = { title: "数据大屏" };

export interface ConfigSource {
  load(): Promise<ScreenConfig>;
}

const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined);
const link = (value: unknown): string | undefined => {
  const url = text(value, 2000);
  return url && /^https?:\/\//i.test(url) ? url : undefined;
};
const image = (value: unknown): string | undefined => {
  const url = text(value, 400_000);
  return url && /^(https?:\/\/|data:image\/|\.?\/)/i.test(url) ? url : undefined;
};

/** Builds a config from untyped input (a JSON file, a server answer); unknown or bad fields are dropped. */
export function parseConfig(raw: unknown): ScreenConfig {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const logo = (input.logo && typeof input.logo === "object" ? input.logo : {}) as Record<string, unknown>;
  const credit = (input.attribution && typeof input.attribution === "object" ? input.attribution : {}) as Record<string, unknown>;
  const day = image(logo.day);
  const night = image(logo.night) ?? day;
  const creditText = text(credit.text, 80);
  return {
    title: text(input.title, 40) ?? DEFAULT_CONFIG.title,
    logo: day && night ? { day, night } : undefined,
    note: text(input.note, 40),
    attribution: creditText ? { text: creditText, url: link(credit.url) } : undefined,
  };
}
