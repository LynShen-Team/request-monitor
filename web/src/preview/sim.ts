import type { FlowStatus, LiveEvent, LiveSource, ReplayBucket, ReplayData, ReplaySource, ReplayWindow, Site, Topology } from "../core/model";

/**
 * Preview data source. Everything it shows is synthetic: the gateway, Groups, Channels, traffic
 * (`sample.ts`), and the user regions below. It sends no request.
 */

export interface RawRoute {
  g: string;
  c: string;
  /** Account class of the Group: standard, enterprise, agent, or private. */
  cls: string;
  up: string | null;
  c24: number;
  c7: number;
  c30: number;
  ttfb: number;
  dur: number;
}

export interface PreviewData {
  hourStart: number;
  hourCount: number;
  gateway: Site;
  upstreams: Array<Site & { anycast?: boolean }>;
  routes: RawRoute[];
  models: string[];
  pairModels: string[];
  pairs: number[];
  hours: { total: number[]; ok: number[]; err: number[]; gone: number[]; ttfb: number[]; dur: number[]; ips: number[] };
  routeHours: number[];
  modelHours: number[];
  f5: { start: number; total: number[]; err: number[]; ttfb: number[] };
  windows: Record<string, { total: number; ok: number; err: number; gone: number }>;
}

interface Origin extends Site {
  weight: number;
  tz: number;
}

const o = (id: string, name: string, region: string, lat: number, lon: number, weight: number, tz = 8): Origin => ({ id, name, region, lat, lon, weight, tz });

/** Synthetic user regions (city level). The weights are invented. */
const ORIGINS: Origin[] = [
  o("bj", "北京", "中国", 39.9, 116.4, 13),
  o("sh", "上海", "中国", 31.23, 121.47, 12),
  o("sz", "深圳", "中国 · 广东", 22.54, 114.06, 10),
  o("hz", "杭州", "中国 · 浙江", 30.27, 120.15, 8),
  o("gz", "广州", "中国 · 广东", 23.13, 113.26, 6.5),
  o("cd", "成都", "中国 · 四川", 30.57, 104.07, 5.5),
  o("hk", "香港", "中国", 22.32, 114.17, 4.5),
  o("nj", "南京", "中国 · 江苏", 32.06, 118.8, 4),
  o("wh", "武汉", "中国 · 湖北", 30.59, 114.31, 3.6),
  o("tyo", "东京", "日本", 35.68, 139.69, 3.4, 9),
  o("sin", "新加坡", "新加坡", 1.35, 103.82, 3.2),
  o("xa", "西安", "中国 · 陕西", 34.34, 108.94, 2.8),
  o("su", "苏州", "中国 · 江苏", 31.3, 120.59, 2.6),
  o("cq", "重庆", "中国", 29.56, 106.55, 2.4),
  o("la", "洛杉矶", "美国 · 加州", 34.05, -118.24, 2.2, -8),
  o("cs", "长沙", "中国 · 湖南", 28.23, 112.94, 2),
  o("zz", "郑州", "中国 · 河南", 34.75, 113.63, 1.8),
  o("hf", "合肥", "中国 · 安徽", 31.82, 117.23, 1.8),
  o("xm", "厦门", "中国 · 福建", 24.48, 118.09, 1.6),
  o("sj", "圣何塞", "美国 · 加州", 37.34, -121.89, 1.6, -8),
  o("qd", "青岛", "中国 · 山东", 36.07, 120.38, 1.4),
  o("tj", "天津", "中国", 39.13, 117.2, 1.4),
  o("jn", "济南", "中国 · 山东", 36.65, 117.12, 1.2),
  o("tp", "台北", "中国 · 台湾", 25.03, 121.56, 1.2),
  o("sel", "首尔", "韩国", 37.57, 126.98, 1.2, 9),
  o("fz", "福州", "中国 · 福建", 26.07, 119.3, 1.1),
  o("sy", "沈阳", "中国 · 辽宁", 41.8, 123.43, 1),
  o("fra", "法兰克福", "德国", 50.11, 8.68, 0.9, 1),
  o("km", "昆明", "中国 · 云南", 25.04, 102.71, 0.8),
  o("sea", "西雅图", "美国 · 华盛顿州", 47.61, -122.33, 0.8, -8),
  o("heb", "哈尔滨", "中国 · 黑龙江", 45.8, 126.53, 0.7),
  o("syd", "悉尼", "澳大利亚", -33.87, 151.21, 0.5, 10),
  o("yvr", "温哥华", "加拿大", 49.28, -123.12, 0.5, -8),
  o("lz", "兰州", "中国 · 甘肃", 36.06, 103.83, 0.4),
  o("urc", "乌鲁木齐", "中国 · 新疆", 43.83, 87.62, 0.4),
];

const HOUR = 3_600_000;
const FIVE_MIN = 300_000;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Share of each origin at a moment: its weight times a local-time activity curve. */
function originShares(t: number): number[] {
  const utcHour = (t / HOUR) % 24;
  const raw = ORIGINS.map((origin) => {
    const local = (utcHour + origin.tz + 24) % 24;
    const day = 0.5 - 0.5 * Math.cos(((local - 4.5) / 24) * 2 * Math.PI);
    return origin.weight * (0.22 + 0.78 * day ** 1.3);
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / sum);
}

export function buildTopology(data: PreviewData): Topology {
  const channels = new Map<string, number>();
  for (const route of data.routes) if (route.up) channels.set(route.up, (channels.get(route.up) ?? 0) + 1);
  return {
    gateway: data.gateway,
    upstreams: data.upstreams.map((site) => ({ ...site, channels: channels.get(site.id) ?? 0 })),
    origins: ORIGINS.map(({ id, name, region, lat, lon }) => ({ id, name, region, lat, lon })),
    // Standard and enterprise Groups show their Channels to everyone; the others to admins only.
    routes: data.routes.map((route) => ({ group: route.g, channel: route.c, upstream: route.up, restricted: route.cls !== "standard" && route.cls !== "enterprise" })),
  };
}

interface HourRoutes {
  route: number[];
  count: number[];
  err: number[];
}

function indexRouteHours(data: PreviewData): Map<number, HourRoutes> {
  const map = new Map<number, HourRoutes>();
  const rows = data.routeHours;
  for (let i = 0; i < rows.length; i += 5) {
    const hour = rows[i]!;
    let entry = map.get(hour);
    if (!entry) map.set(hour, (entry = { route: [], count: [], err: [] }));
    entry.route.push(rows[i + 1]!);
    entry.count.push(rows[i + 2]!);
    entry.err.push(rows[i + 3]!);
  }
  return map;
}

function indexModelHours(data: PreviewData): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const rows = data.modelHours;
  for (let i = 0; i < rows.length; i += 3) {
    let entry = map.get(rows[i]!);
    if (!entry) map.set(rows[i]!, (entry = new Array<number>(data.models.length).fill(0)));
    entry[rows[i + 1]!] = rows[i + 2]!;
  }
  return map;
}

const modelLabel = (name: string) => (name === "~other" ? "其他模型" : name);

export class PreviewReplay implements ReplaySource {
  private readonly routeHours: Map<number, HourRoutes>;
  private readonly modelHours: Map<number, number[]>;

  private readonly data: PreviewData;

  constructor(data: PreviewData) {
    this.data = data;
    this.routeHours = indexRouteHours(data);
    this.modelHours = indexModelHours(data);
  }

  async load(window: ReplayWindow): Promise<ReplayData> {
    const data = this.data;
    // The newest 5-minute bucket and the newest hour are partial; both are left out.
    const lastFive = data.f5.start + data.f5.total.length - 1;
    const buckets: ReplayBucket[] = [];
    let stepMs: number;
    if (window === "30d") {
      stepMs = 2 * HOUR;
      const count = Math.floor((data.hourCount - 1) / 2);
      const first = data.hourCount - 1 - count * 2;
      for (let i = 0; i < count; i++) {
        const h = first + i * 2;
        const total = data.hours.total[h]! + data.hours.total[h + 1]!;
        const errors = data.hours.err[h]! + data.hours.err[h + 1]!;
        const ttfb = (data.hours.ttfb[h]! * data.hours.total[h]! + data.hours.ttfb[h + 1]! * data.hours.total[h + 1]!) / Math.max(1, total);
        buckets.push(this.bucket((data.hourStart + h) * HOUR, stepMs, total, errors, ttfb, [h, h + 1]));
      }
    } else {
      const per = window === "24h" ? 1 : 6;
      const count = window === "24h" ? 288 : 336;
      stepMs = per * FIVE_MIN;
      const first = lastFive - count * per;
      for (let i = 0; i < count; i++) {
        let total = 0;
        let errors = 0;
        let ttfb = 0;
        for (let j = 0; j < per; j++) {
          const k = first + i * per + j - data.f5.start;
          total += data.f5.total[k] ?? 0;
          errors += data.f5.err[k] ?? 0;
          ttfb += (data.f5.ttfb[k] ?? 0) * (data.f5.total[k] ?? 0);
        }
        const t0 = (first + i * per) * FIVE_MIN;
        const hour = Math.floor(t0 / HOUR) - data.hourStart;
        buckets.push(this.bucket(t0, stepMs, total, errors, ttfb / Math.max(1, total), [hour]));
      }
    }
    return {
      window,
      start: buckets[0]!.t0,
      end: buckets[buckets.length - 1]!.t0 + stepMs,
      stepMs,
      models: data.models.map(modelLabel),
      buckets,
    };
  }

  /** Splits a bucket's totals over routes and models in the proportions of its source hours. */
  private bucket(t0: number, stepMs: number, total: number, errors: number, ttfbP50: number, hours: number[]): ReplayBucket {
    const routeCount = new Map<number, number>();
    const routeErr = new Map<number, number>();
    const models = new Array<number>(this.data.models.length).fill(0);
    let hourTotal = 0;
    let hourErr = 0;
    let modelTotal = 0;
    for (const hour of hours) {
      const entry = this.routeHours.get(hour);
      if (entry) {
        for (let i = 0; i < entry.route.length; i++) {
          const r = entry.route[i]!;
          routeCount.set(r, (routeCount.get(r) ?? 0) + entry.count[i]!);
          routeErr.set(r, (routeErr.get(r) ?? 0) + entry.err[i]!);
          hourTotal += entry.count[i]!;
          hourErr += entry.err[i]!;
        }
      }
      const m = this.modelHours.get(hour);
      if (m) for (let i = 0; i < m.length; i++) {
        models[i]! += m[i]!;
        modelTotal += m[i]!;
      }
    }
    const routes: number[] = [];
    const scale = hourTotal > 0 ? total / hourTotal : 0;
    const errScale = hourErr > 0 ? errors / hourErr : 0;
    for (const [route, count] of routeCount) {
      const c = count * scale;
      if (c <= 0) continue;
      routes.push(route, c, Math.min(c, (routeErr.get(route) ?? 0) * errScale));
    }
    const modelScale = modelTotal > 0 ? total / modelTotal : 0;
    const shares = originShares(t0 + stepMs / 2);
    return {
      t0,
      total,
      errors,
      ttfbP50,
      routes,
      origins: shares.map((share) => share * total),
      models: models.map((v) => v * modelScale),
    };
  }
}

interface Pending {
  t: number;
  event: LiveEvent;
}

const GATEWAY_REJECTIONS = ["rate_limit_exceeded", "bound_channel_unavailable", "model_not_found", "no_healthy_upstream"];
const UPSTREAM_ERRORS = ["upstream_error", "upstream_error", "upstream_error", "503", "upstream_stream_decode_failed", "request_timeout"];

/**
 * Generates request lifecycles in real time. The arrival rate at a moment is the measured rate
 * of the same time of day in the sample (5-minute resolution) times `rateScale`.
 */
export class PreviewLive implements LiveSource {
  readonly topology: Topology;
  readonly baseline24h: { total: number; errors: number };
  private readonly random: () => number;
  private readonly queue: Pending[] = [];
  private nextArrival: number;
  private nextId = 1;
  private readonly pairWeights: number[] = [];
  private pairTotal = 0;
  private readonly routeErrRate: number[];
  private burst = 1;
  private burstUntil = 0;

  private readonly data: PreviewData;
  private readonly rateScale: number;

  constructor(data: PreviewData, now: number, rateScale = 1, warmupMs = 30 * 60_000, seed = 20261118) {
    this.data = data;
    this.rateScale = rateScale;
    this.topology = buildTopology(data);
    this.random = mulberry32(seed);
    this.nextArrival = now - warmupMs;
    const day = data.windows["24h"];
    this.baseline24h = { total: day?.total ?? 0, errors: day?.err ?? 0 };
    for (let i = 0; i < data.pairs.length; i += 3) {
      this.pairWeights.push(data.pairs[i + 2]!);
      this.pairTotal += data.pairs[i + 2]!;
    }
    // Error rate per route over the newest 24 sampled hours.
    const count = new Array<number>(data.routes.length).fill(0);
    const err = new Array<number>(data.routes.length).fill(0);
    for (let i = 0; i < data.routeHours.length; i += 5) {
      const route = data.routeHours[i + 1]!;
      if (route < 0 || data.routeHours[i]! < data.hourCount - 25) continue;
      count[route]! += data.routeHours[i + 2]!;
      err[route]! += data.routeHours[i + 3]!;
    }
    this.routeErrRate = count.map((c, i) => (c > 20 ? Math.min(0.4, err[i]! / c) : 0.03));
  }

  /** Requests per second at `t`, from the same time of day in the newest sampled day. */
  private rate(t: number): number {
    const f5 = this.data.f5;
    const lastFull = f5.start + f5.total.length - 2;
    let bucket = Math.floor(t / FIVE_MIN);
    while (bucket > lastFull) bucket -= 288;
    while (bucket < f5.start) bucket += 288;
    return Math.max(0.05, ((f5.total[bucket - f5.start] ?? 0) / 300) * this.rateScale);
  }

  private lognormal(median: number, sigma: number): number {
    const u = Math.max(1e-9, this.random());
    const v = this.random();
    return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }

  private pick(weights: number[], total: number): number {
    let x = this.random() * total;
    for (let i = 0; i < weights.length; i++) {
      x -= weights[i]!;
      if (x <= 0) return i;
    }
    return weights.length - 1;
  }

  private push(event: LiveEvent) {
    this.queue.push({ t: event.t, event });
  }

  private generate(t: number) {
    const id = this.nextId++;
    const origin = ORIGINS[this.pick(originShares(t), 1)]!.id;
    const pair = this.pick(this.pairWeights, this.pairTotal);
    const model = this.data.pairModels[this.data.pairs[pair * 3]!]!;
    const route = this.data.pairs[pair * 3 + 1]!;
    this.push({ type: "start", id, t, origin, model });

    if (this.random() < 0.006) {
      const errorCode = GATEWAY_REJECTIONS[Math.floor(this.random() * GATEWAY_REJECTIONS.length)]!;
      const durationMs = Math.round(20 + this.random() * 160);
      this.push({ type: "end", id, t: t + durationMs, status: "error", ttfbMs: null, durationMs, errorCode });
      return;
    }

    let at = t + 60 + this.random() * 200;
    if (this.random() < 0.035) {
      // Fail-forward: an attempt on another Channel of the same Group fails first.
      const group = this.data.routes[route]!.g;
      const others = this.data.routes.map((r, i) => (r.g === group && i !== route && r.c24 > 0 ? i : -1)).filter((i) => i >= 0);
      if (others.length > 0) {
        this.push({ type: "route", id, t: at, route: others[Math.floor(this.random() * others.length)]! });
        at += 400 + this.random() * 2600;
      }
    }
    this.push({ type: "route", id, t: at, route });

    const info = this.data.routes[route]!;
    if (this.random() < this.routeErrRate[route]!) {
      const durationMs = Math.round(at - t + this.lognormal(1800, 1));
      const errorCode = UPSTREAM_ERRORS[Math.floor(this.random() * UPSTREAM_ERRORS.length)]!;
      this.push({ type: "end", id, t: t + durationMs, status: "error", ttfbMs: null, durationMs, errorCode });
      return;
    }
    const stream = this.random() < 0.72;
    const ttfbMs = Math.round(at - t + this.lognormal(Math.max(400, info.ttfb || 3000), 0.75));
    const body = this.lognormal(Math.max(600, (info.dur || 7000) - (info.ttfb || 3000)), 0.95);
    const durationMs = Math.round(Math.min(240_000, ttfbMs + body));
    const status: FlowStatus = this.random() < 0.0066 ? "client_gone" : "success";
    if (stream) this.push({ type: "ttfb", id, t: t + ttfbMs, ttfbMs });
    this.push({ type: "end", id, t: t + durationMs, status, ttfbMs: stream ? ttfbMs : null, durationMs });
  }

  poll(now: number): LiveEvent[] {
    while (this.nextArrival <= now) {
      const t = this.nextArrival;
      this.generate(t);
      if (t >= this.burstUntil) {
        // Short-lived load factor, so arrivals cluster the way real traffic does.
        this.burst = Math.exp((this.random() - 0.5) * 1.1);
        this.burstUntil = t + 8000 + this.random() * 20_000;
      }
      const lambda = this.rate(t) * this.burst;
      this.nextArrival = t + (-Math.log(Math.max(1e-9, this.random())) / lambda) * 1000;
    }
    this.queue.sort((a, b) => a.t - b.t);
    let n = 0;
    while (n < this.queue.length && this.queue[n]!.t <= now) n++;
    return this.queue.splice(0, n).map((p) => p.event);
  }
}

/** The sample data, with its time axis ending at `now`. */
export async function loadPreviewData(now: number): Promise<PreviewData> {
  return (await import("./sample")).makeSample(now);
}
