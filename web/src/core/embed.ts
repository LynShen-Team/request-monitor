/** The embed page (docs/spec-screen.md OS-E1): a frame in another site's page. */

export type Lang = "zh" | "zh-TW" | "en" | "ja";

/** The language of the page that embeds the screen (`?lang=`); Simplified Chinese otherwise. */
export function embedLang(value: string | null): Lang {
  if (value === "zh-TW" || value === "en" || value === "ja") return value;
  return "zh";
}

/** Design-pixel size of the embed page: 1000 × 560 is 1, within 0.8 to 1.6. The same rule as `.is-embed` in styles.css. */
export function embedUi(width: number, height: number): number {
  return Math.max(0.8, Math.min(1.6, Math.min(width / 1000, height / 560)));
}
