const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

export function formatCount(value: number): string {
  return integer.format(Math.round(value));
}

export function formatSeconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/** Counts of 100,000 and more in units of 万 or 亿, for narrow slots. */
export function formatCompact(value: number): string {
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (value >= 1e5) return `${(value / 1e4).toFixed(1)} 万`;
  return formatCount(value);
}
