import type { PreviewData, RawRoute } from "./sim";

/**
 * Synthetic sample data of the preview: an invented gateway with invented Groups, Channels, and
 * traffic. Nothing here comes from a real deployment. The series is a function of the absolute
 * hour, so two page loads in the same hour show the same history, and it always ends "now".
 */

const HOUR = 3_600_000;
const FIVE_MIN = 300_000;
const HOURS = 721;
const FIVE_MIN_BUCKETS = 2017;
/** The sample audience keeps UTC+8 hours. */
const AUDIENCE_OFFSET_H = 8;
const MEAN_PER_HOUR = 3000;

const GATEWAY = { id: "gw", name: "西雅图", region: "美国 · 华盛顿州", lat: 47.61, lon: -122.33 };
const UPSTREAMS = [
  { id: "sea", name: "西雅图", region: "美国 · 华盛顿州", lat: 47.61, lon: -122.33 },
  { id: "sjc", name: "圣何塞", region: "美国 · 加州", lat: 37.34, lon: -121.89 },
  { id: "tyo", name: "东京", region: "日本", lat: 35.68, lon: 139.69 },
  { id: "sin", name: "新加坡", region: "新加坡", lat: 1.35, lon: 103.82 },
];

interface RouteSeed {
  g: string;
  c: string;
  cls: "standard" | "enterprise" | "agent" | "private";
  up: string;
  ttfb: number;
  dur: number;
  errRate: number;
}

/** Groups 合作方 (agent) and 内部 (private) are restricted: only an admin sees their Channels. */
const ROUTES: RouteSeed[] = [
  { g: "标准", c: "GPT 主力", cls: "standard", up: "sjc", ttfb: 1700, dur: 9000, errRate: 0.012 },
  { g: "标准", c: "Claude 主力", cls: "standard", up: "sjc", ttfb: 2500, dur: 5200, errRate: 0.01 },
  { g: "标准", c: "国产模型", cls: "standard", up: "tyo", ttfb: 3900, dur: 6200, errRate: 0.02 },
  { g: "标准", c: "Gemini", cls: "standard", up: "sin", ttfb: 5200, dur: 9800, errRate: 0.05 },
  { g: "企业", c: "专线 A", cls: "enterprise", up: "sea", ttfb: 3000, dur: 7600, errRate: 0.006 },
  { g: "企业", c: "专线 B", cls: "enterprise", up: "tyo", ttfb: 3400, dur: 8000, errRate: 0.008 },
  { g: "合作方", c: "通道一", cls: "agent", up: "tyo", ttfb: 3600, dur: 4500, errRate: 0.015 },
  { g: "合作方", c: "通道二", cls: "agent", up: "sin", ttfb: 4400, dur: 7900, errRate: 0.03 },
  { g: "内部", c: "自测", cls: "private", up: "sea", ttfb: 4200, dur: 10500, errRate: 0.004 },
];

/** Model, route index, weight. A route's share of traffic is the sum of its weights. */
const PAIRS: Array<[string, number, number]> = [
  ["deepseek-chat", 2, 14],
  ["deepseek-chat", 6, 9],
  ["deepseek-chat", 8, 2],
  ["gpt-4o", 0, 14],
  ["gpt-4o", 4, 5],
  ["claude-3-5-sonnet", 1, 11],
  ["claude-3-5-sonnet", 4, 4],
  ["claude-3-5-sonnet", 5, 3],
  ["gpt-4o-mini", 0, 8],
  ["gpt-4o-mini", 7, 3],
  ["glm-4-flash", 2, 5],
  ["glm-4-flash", 6, 3],
  ["claude-3-5-haiku", 1, 4],
  ["claude-3-5-haiku", 8, 2],
  ["gemini-1.5-flash", 3, 4],
  ["gemini-1.5-flash", 7, 2],
  ["deepseek-reasoner", 2, 3],
  ["qwen-plus", 2, 2],
  ["qwen-plus", 5, 2],
];

/** Outages, in hours before now: a route fails at `errRate` and answers slower. */
const INCIDENTS: Array<{ route: number; from: number; to: number; errRate: number }> = [
  { route: 2, from: 412, to: 405, errRate: 0.38 },
  { route: 3, from: 203, to: 190, errRate: 0.6 },
  { route: 6, from: 97, to: 94, errRate: 0.55 },
  { route: 0, from: 30, to: 29, errRate: 0.22 },
];

/** Deterministic value in [0, 1) for a pair of integers. */
function noise(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Share of the daily mean at a local hour: quiet before dawn, busy late morning to evening. */
function diurnal(localHour: number): number {
  const morning = Math.exp(-((localHour - 10.5) ** 2) / 8);
  const afternoon = Math.exp(-((localHour - 15.5) ** 2) / 10);
  const evening = Math.exp(-((localHour - 21) ** 2) / 6);
  return 0.28 + 1.05 * morning + 1.15 * afternoon + 0.85 * evening;
}

function loadFactor(hourAbs: number, hoursAgo: number): number {
  const local = (((hourAbs + AUDIENCE_OFFSET_H) % 24) + 24) % 24;
  const day = Math.floor((hourAbs + AUDIENCE_OFFSET_H) / 24);
  // 1970-01-01 was a Thursday: day % 7 of 2 and 3 are Saturday and Sunday.
  const weekend = day % 7 === 2 || day % 7 === 3;
  const growth = 1.22 - 0.22 * (hoursAgo / HOURS);
  return (diurnal(local + 0.5) / 1.28) * (weekend ? 0.74 : 1) * growth * (0.93 + 0.14 * noise(hourAbs, 1));
}

export function makeSample(now: number): PreviewData {
  const lastHour = Math.floor(now / HOUR);
  const hourStart = lastHour - (HOURS - 1);
  const weights = ROUTES.map((_, r) => PAIRS.filter((p) => p[1] === r).reduce((a, p) => a + p[2], 0));
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const models = [...new Set(PAIRS.map((p) => p[0]))];

  const hours = { total: [] as number[], ok: [] as number[], err: [] as number[], gone: [] as number[], ttfb: [] as number[], dur: [] as number[], ips: [] as number[] };
  const routeHours: number[] = [];
  const modelHours: number[] = [];
  const totals = ROUTES.map(() => ({ c24: 0, c7: 0, c30: 0 }));
  const errRateAt: number[] = [];

  for (let h = 0; h < HOURS; h++) {
    const hourAbs = hourStart + h;
    const ago = HOURS - 1 - h;
    // The newest hour is still running: it holds the share of the hour that has passed.
    const elapsed = h === HOURS - 1 ? (now - lastHour * HOUR) / HOUR : 1;
    const volume = MEAN_PER_HOUR * loadFactor(hourAbs, ago) * elapsed;
    let total = 0;
    let errors = 0;
    let ttfbSum = 0;
    let durSum = 0;
    const perModel = new Array<number>(models.length).fill(0);
    ROUTES.forEach((route, r) => {
      const incident = INCIDENTS.find((i) => i.route === r && ago <= i.from && ago >= i.to);
      const count = Math.round(volume * (weights[r]! / weightTotal) * (0.82 + 0.36 * noise(hourAbs, 10 + r)));
      if (count <= 0) return;
      const rate = incident ? incident.errRate : route.errRate * (0.5 + noise(hourAbs, 40 + r));
      const err = Math.min(count, Math.round(count * rate));
      const ttfb = Math.round(route.ttfb * (0.9 + 0.2 * noise(hourAbs, 70 + r)) * (incident ? 1.6 : 1));
      routeHours.push(h, r, count, err, ttfb);
      total += count;
      errors += err;
      ttfbSum += ttfb * count;
      durSum += route.dur * count;
      for (const [model, pr, weight] of PAIRS) if (pr === r) perModel[models.indexOf(model)]! += (count * weight) / weights[r]!;
      if (ago < 24) totals[r]!.c24 += count;
      if (ago < 168) totals[r]!.c7 += count;
      totals[r]!.c30 += count;
    });
    // Requests that the gateway rejects before it selects a Channel.
    const rejected = Math.round(total * 0.006);
    if (rejected > 0) routeHours.push(h, -1, rejected, rejected, 0);
    const all = total + rejected;
    const gone = Math.round(all * 0.006);
    hours.total.push(all);
    hours.err.push(errors + rejected);
    hours.gone.push(gone);
    hours.ok.push(all - errors - rejected - gone);
    hours.ttfb.push(total > 0 ? Math.round(ttfbSum / total) : 0);
    hours.dur.push(total > 0 ? Math.round(durSum / total) : 0);
    hours.ips.push(Math.round(8 + all / 160));
    errRateAt.push(all > 0 ? (errors + rejected) / all : 0);
    perModel.forEach((count, m) => {
      if (count >= 0.5) modelHours.push(h, m, Math.round(count));
    });
  }

  const lastFive = Math.floor(now / FIVE_MIN);
  const f5 = { start: lastFive - (FIVE_MIN_BUCKETS - 1), total: [] as number[], err: [] as number[], ttfb: [] as number[] };
  for (let i = 0; i < FIVE_MIN_BUCKETS; i++) {
    const bucket = f5.start + i;
    const hourAbs = Math.floor((bucket * FIVE_MIN) / HOUR);
    const h = hourAbs - hourStart;
    const elapsed = i === FIVE_MIN_BUCKETS - 1 ? (now - lastFive * FIVE_MIN) / FIVE_MIN : 1;
    const perBucket = (MEAN_PER_HOUR * loadFactor(hourAbs, HOURS - 1 - h)) / 12;
    const total = Math.round(perBucket * (0.86 + 0.28 * noise(bucket, 3)) * elapsed);
    f5.total.push(total);
    f5.err.push(Math.min(total, Math.round(total * (errRateAt[h] ?? 0.015) * (0.6 + 0.8 * noise(bucket, 4)))));
    f5.ttfb.push(Math.round((hours.ttfb[h] ?? 3000) * (0.92 + 0.16 * noise(bucket, 5))));
  }

  const window = (count: number) => {
    const out = { total: 0, ok: 0, err: 0, gone: 0 };
    for (let h = HOURS - 1 - count; h < HOURS - 1; h++) {
      out.total += hours.total[h]!;
      out.ok += hours.ok[h]!;
      out.err += hours.err[h]!;
      out.gone += hours.gone[h]!;
    }
    return out;
  };
  const routes: RawRoute[] = ROUTES.map((route, r) => ({ g: route.g, c: route.c, cls: route.cls, up: route.up, ttfb: route.ttfb, dur: route.dur, ...totals[r]! }));
  const pairs: number[] = [];
  for (const [model, r, weight] of PAIRS) pairs.push(models.indexOf(model), r, weight);

  return {
    hourStart,
    hourCount: HOURS,
    gateway: GATEWAY,
    upstreams: UPSTREAMS,
    routes,
    models,
    pairModels: models,
    pairs,
    hours,
    routeHours,
    modelHours,
    f5,
    windows: { "24h": window(24), "7d": window(168), "30d": window(720) },
  };
}
