import type { Capabilities, LiveEvent, LiveSource, Topology } from "../core/model";

/**
 * Reader of the service's live events (`GET api/live`, docs/spec-service.md OS-SR6) for the page
 * (docs/spec-screen.md OS-N9). It asks the service in the background, keeps the events sorted by
 * time, and hands each one to the screen when the page's live clock reaches it.
 */

/** The answer of `api/live` (OS-SR6). */
export interface LiveAnswer {
  version: string;
  now: number;
  pollMs: number;
  delayMs: number;
  cursor: string;
  reset: boolean;
  events: LiveEvent[];
}

/** The service refused the request: the visitor must sign in, or live mode is off (OS-N9.7, OS-N9.8). */
export class LiveRefused extends Error {
  readonly reason: "login_required" | "live_unavailable";
  constructor(reason: "login_required" | "live_unavailable") {
    super(reason);
    this.reason = reason;
  }
}

/** What the reader needs from the rest of the network source. Tests pass stand-ins. */
export interface LiveDeps {
  /** Asks `api/live`, with `after` when given. Rejects with `LiveRefused` or any other error. */
  fetchLive(after: string | null): Promise<unknown>;
  /** The topology version the page holds now. */
  version(): string;
  /** Fetches the topology and the role again (OS-N3); resolves once the page holds them. */
  refreshTopology(): Promise<void>;
  /** The visitor must sign in first (OS-N8.1). */
  loginRequired(): void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export const RETRY_MS = 5_000;
export const DEFAULT_POLL_MS = 2_000;
/** A later answer moves the live clock only when it disagrees with the kept offset by more than this. */
export const RESYNC_MS = 1_000;
const MAX_ROUNDS = 3;

const STATUSES = new Set(["success", "error", "client_gone"]);
const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Keeps the well-formed events of an answer; anything else is dropped. */
export function liveEvents(raw: unknown): LiveEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveEvent[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (!item || typeof item !== "object" || !num(item.id) || !num(item.t)) continue;
    const { id, t } = item;
    if (item.type === "start" && typeof item.origin === "string" && typeof item.model === "string") out.push({ type: "start", id, t, origin: item.origin, model: item.model });
    else if (item.type === "route" && num(item.route) && item.route >= 0) out.push({ type: "route", id, t, route: item.route });
    else if (item.type === "ttfb" && num(item.ttfbMs)) out.push({ type: "ttfb", id, t, ttfbMs: item.ttfbMs });
    else if (item.type === "end" && typeof item.status === "string" && STATUSES.has(item.status) && num(item.durationMs)) {
      const end: LiveEvent = { type: "end", id, t, status: item.status as "success" | "error" | "client_gone", ttfbMs: num(item.ttfbMs) ? item.ttfbMs : null, durationMs: item.durationMs };
      if (typeof item.errorCode === "string" && item.errorCode !== "") end.errorCode = item.errorCode;
      out.push(end);
    }
  }
  return out;
}

/** Reads a body as a live answer, or returns null when it is not one (OS-N9.6). */
export function parseLiveAnswer(body: unknown): LiveAnswer | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.version !== "string" || !num(b.now) || typeof b.cursor !== "string" || !Array.isArray(b.events)) return null;
  const pollMs = num(b.pollMs) && b.pollMs > 0 ? Math.max(500, Math.min(60_000, b.pollMs)) : DEFAULT_POLL_MS;
  const delayMs = num(b.delayMs) && b.delayMs >= 0 ? b.delayMs : 0;
  return { version: b.version, now: b.now, pollMs, delayMs, cursor: b.cursor, reset: b.reset === true, events: liveEvents(b.events) };
}

export class NetLive implements LiveSource {
  readonly topology: Topology;
  readonly baseline24h: { total: number; errors: number };
  capabilities: Capabilities;
  onReset?: () => void;

  private readonly deps: LiveDeps;
  /** Events not applied yet, in the order of `t` (service clock). */
  private pending: LiveEvent[] = [];
  private cursor: string | null = null;
  /** Page clock minus service live clock; null until the first answer has been applied. */
  private skew: number | null = null;
  /** `now - delayMs` of the last answer, taken at the next poll. */
  private anchor: { at: number; force: boolean } | null = null;
  private resetPending = false;
  /** Counts the times the live events were dropped; an answer to an older request is not applied. */
  private generation = 0;
  private failed = false;
  private started = false;
  private stopped = false;
  private timer: unknown = null;

  constructor(answer: { topology: Topology; baseline24h: { total: number; errors: number } }, capabilities: Capabilities, deps: LiveDeps) {
    this.topology = answer.topology;
    this.baseline24h = answer.baseline24h;
    this.capabilities = capabilities;
    this.deps = deps;
  }

  /**
   * Starts reading, unless the service has no live mode. The first poll calls it, so that reading
   * starts once the screen that applies the events (and the topology changes they bring) exists.
   */
  start() {
    if (this.started || this.stopped || this.capabilities.live === "none") return;
    this.started = true;
    this.timer = this.deps.setTimer(() => void this.step(), 0);
  }

  /** Stops reading for good (OS-N9.9). */
  close() {
    this.stopped = true;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  /** False until the first answer has been applied (OS-N9.5). */
  get ready(): boolean {
    return this.capabilities.live === "none" || this.skew !== null || this.anchor !== null;
  }

  /** True while the last request failed (OS-N9.6). */
  get stale(): boolean {
    return this.failed;
  }

  /**
   * Drops the live events: the topology they refer to was replaced (OS-N9.4). The next request has
   * no cursor, and its answer replaces everything the screen built from the old events.
   */
  restart() {
    this.generation++;
    this.cursor = null;
    this.pending = [];
    this.resetPending = true;
  }

  poll(now: number): LiveEvent[] {
    if (!this.started) this.start();
    if (this.anchor) {
      const skew = now - this.anchor.at;
      if (this.skew === null || this.anchor.force || Math.abs(skew - this.skew) > RESYNC_MS) this.skew = skew;
      this.anchor = null;
    }
    if (this.resetPending && this.skew !== null) {
      this.resetPending = false;
      this.onReset?.();
    }
    if (this.skew === null || this.pending.length === 0) return [];
    const until = now - this.skew;
    let n = 0;
    while (n < this.pending.length && this.pending[n]!.t <= until) n++;
    if (n === 0) return [];
    const skew = this.skew;
    return this.pending.splice(0, n).map((event) => ({ ...event, t: event.t + skew }));
  }

  private async step() {
    this.timer = null;
    if (this.stopped) return;
    let wait = RETRY_MS;
    try {
      wait = await this.read();
      this.failed = false;
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof LiveRefused) {
        this.stopped = true;
        if (error.reason === "live_unavailable") {
          this.pending = [];
          this.capabilities = { ...this.capabilities, live: "none" };
        } else {
          this.deps.loginRequired();
        }
        return;
      }
      this.failed = true;
    }
    if (!this.stopped) this.timer = this.deps.setTimer(() => void this.step(), wait);
  }

  /** One request, and as many more as a topology change needs. Returns the wait before the next. */
  private async read(): Promise<number> {
    for (let round = 0; ; round++) {
      if (round === MAX_ROUNDS) throw new Error("the topology kept changing while live events were read");
      const generation = this.generation;
      const answer = parseLiveAnswer(await this.deps.fetchLive(this.cursor));
      if (this.stopped) return 0;
      if (!answer) throw new Error("api/live: not a live answer");
      if (answer.version !== this.deps.version()) {
        await this.deps.refreshTopology();
        // A refresh that found no change still leaves events of another version: ask from scratch.
        if (this.generation === generation) this.restart();
        continue;
      }
      // The topology changed while the request ran (a replay answer brought it): ask from scratch.
      if (this.generation !== generation) continue;
      this.apply(answer);
      return answer.pollMs;
    }
  }

  private apply(answer: LiveAnswer) {
    // A first answer without a cursor is always a reset; so is one after a restart.
    const reset = answer.reset || this.cursor === null;
    if (reset) {
      this.pending = [];
      this.resetPending = true;
    }
    this.anchor = { at: answer.now - answer.delayMs, force: reset };
    this.cursor = answer.cursor;
    if (answer.events.length === 0) return;
    // A stable sort: events with the same `t` keep the order of the answer (start before route).
    this.pending = this.pending.concat(answer.events).sort((a, b) => a.t - b.t);
  }
}
