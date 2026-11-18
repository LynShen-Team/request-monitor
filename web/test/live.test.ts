// Unit tests of the live reader (docs/spec-screen.md OS-N9). Run with `bun test`.
import { describe, expect, test } from "bun:test";
import type { Capabilities, LiveEvent, Topology } from "../src/core/model";
import { LiveRefused, NetLive, RETRY_MS, liveEvents, parseLiveAnswer, type LiveDeps } from "../src/net/live";

const topology: Topology = { gateway: { id: "gw", name: "G", region: "R", lat: 0, lon: 0 }, upstreams: [], origins: [], routes: [] };
const caps: Capabilities = { live: "replayed", origin: true, errors: true, durationPrecisionMs: 1 };

type Reply = unknown | Error | (() => unknown);

/** A stand-in for the network and the timers that the test drives step by step. */
function harness(options: { version?: string; capabilities?: Capabilities } = {}) {
  const replies: Reply[] = [];
  const asked: Array<string | null> = [];
  const timers: Array<{ run: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  const state = { version: options.version ?? "v1", refreshes: 0, logins: 0, onRefresh: () => {} };
  const deps: LiveDeps = {
    fetchLive: async (after) => {
      asked.push(after);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("no reply queued");
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? (reply as () => unknown)() : reply;
    },
    version: () => state.version,
    refreshTopology: async () => {
      state.refreshes++;
      state.onRefresh();
    },
    loginRequired: () => {
      state.logins++;
    },
    setTimer: (run, ms) => {
      const id = nextId++;
      timers.push({ run, ms, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const live = new NetLive({ topology, baseline24h: { total: 0, errors: 0 } }, options.capabilities ?? caps, deps);
  let resets = 0;
  live.onReset = () => resets++;
  /** Runs the next timer and lets its request settle. Returns the delay it was set with. */
  const step = async () => {
    const timer = timers.shift();
    if (!timer) throw new Error("no timer is set");
    timer.run();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return timer.ms;
  };
  return { live, deps, replies, asked, timers, state, step, resets: () => resets };
}

const answer = (fields: Partial<{ version: string; now: number; pollMs: number; delayMs: number; cursor: string; reset: boolean; events: LiveEvent[] }>) => ({
  version: "v1",
  now: 100_000,
  pollMs: 2000,
  delayMs: 3500,
  cursor: "e.1",
  reset: false,
  events: [],
  ...fields,
});

const lifecycle = (id: number, t: number, route = 0): LiveEvent[] => [
  { type: "start", id, t, origin: "o1", model: "m" },
  { type: "route", id, t, route },
  { type: "ttfb", id, t: t + 300, ttfbMs: 300 },
  { type: "end", id, t: t + 1000, status: "success", ttfbMs: 300, durationMs: 1000 },
];

describe("NetLive", () => {
  test("first answer: warm-up history at once, later events when the live clock reaches them", async () => {
    const h = harness();
    // Service live clock at the answer: 100000 - 3500 = 96500.
    h.replies.push(answer({ reset: true, events: [...lifecycle(2, 96_000), ...lifecycle(1, 90_000), ...lifecycle(3, 97_000)] }));
    expect(h.live.poll(5_000)).toEqual([]);
    expect(h.live.ready).toBe(false);
    expect(h.asked).toEqual([]);
    await h.step();
    expect(h.asked).toEqual([null]);
    expect(h.live.ready).toBe(true);
    // Page clock 5000 maps to service live clock 96500: skew = 5000 - 96500.
    const first = h.live.poll(5_000);
    expect(h.resets()).toBe(1);
    const skew = 5_000 - 96_500;
    // Sorted by t across lifecycles; start before route at the same t.
    expect(first.map((e) => `${e.type}${e.id}@${e.t - skew}`)).toEqual(["start1@90000", "route1@90000", "ttfb1@90300", "end1@91000", "start2@96000", "route2@96000", "ttfb2@96300"]);
    expect(h.live.poll(5_200)).toEqual([]);
    expect(h.live.poll(5_500).map((e) => `${e.type}${e.id}`)).toEqual(["end2", "start3", "route3"]);
    expect(h.live.poll(6_500).map((e) => `${e.type}${e.id}`)).toEqual(["ttfb3", "end3"]);
  });

  test("cadence: waits pollMs, then asks with the cursor", async () => {
    const h = harness();
    h.replies.push(answer({ reset: true, cursor: "e.5", pollMs: 1500 }), answer({ cursor: "e.9", pollMs: 10 }), answer({ cursor: "e.9", pollMs: 99_999_999 }));
    h.live.start();
    await h.step();
    expect(h.timers.map((t) => t.ms)).toEqual([1500]);
    await h.step();
    expect(h.asked).toEqual([null, "e.5"]);
    // pollMs is kept between 0.5 s and 60 s.
    expect(h.timers.map((t) => t.ms)).toEqual([500]);
    await h.step();
    expect(h.timers.map((t) => t.ms)).toEqual([60_000]);
    expect(h.asked).toEqual([null, "e.5", "e.9"]);
  });

  test("a later reset drops what was not applied and tells the screen first", async () => {
    const h = harness();
    h.replies.push(answer({ reset: true, events: lifecycle(1, 99_000) }), answer({ reset: true, now: 101_000, events: lifecycle(7, 96_000) }));
    h.live.start();
    await h.step();
    h.live.poll(0);
    expect(h.resets()).toBe(1);
    await h.step();
    const after = h.live.poll(0);
    expect(h.resets()).toBe(2);
    // Lifecycle 1 lay in the future and was dropped; lifecycle 7 is history of the new answer.
    expect(after.every((e) => e.id === 7)).toBe(true);
    expect(after.length).toBe(4);
  });

  test("another topology version: fetch the topology, then ask again without a cursor", async () => {
    const h = harness();
    h.replies.push(answer({ reset: true, cursor: "e.3" }), answer({ version: "v2", cursor: "e.4", events: lifecycle(9, 96_000) }), answer({ version: "v2", reset: true, cursor: "f.1", events: lifecycle(10, 95_000) }));
    h.state.onRefresh = () => {
      h.state.version = "v2";
    };
    h.live.start();
    await h.step();
    h.live.poll(0);
    await h.step();
    expect(h.state.refreshes).toBe(1);
    expect(h.asked).toEqual([null, "e.3", null]);
    const events = h.live.poll(0);
    // The events of the answer with the old version are never applied.
    expect(events.map((e) => e.id)).toEqual([10, 10, 10, 10]);
    expect(h.resets()).toBe(2);
  });

  test("a topology change while a request runs discards its answer", async () => {
    const h = harness();
    h.replies.push(answer({ reset: true, cursor: "e.3" }));
    h.replies.push(() => {
      // A replay answer brought a newer topology meanwhile.
      h.live.restart();
      return answer({ cursor: "e.4", events: lifecycle(5, 96_000) });
    });
    h.replies.push(answer({ reset: true, cursor: "g.1", events: lifecycle(6, 95_000) }));
    h.live.start();
    await h.step();
    h.live.poll(0);
    await h.step();
    expect(h.asked).toEqual([null, "e.3", null]);
    expect(h.live.poll(0).map((e) => e.id)).toEqual([6, 6, 6, 6]);
  });

  test("the topology keeps changing: the request counts as failed", async () => {
    const h = harness();
    h.replies.push(answer({ version: "v9" }), answer({ version: "v9" }), answer({ version: "v9" }));
    h.live.start();
    expect(await h.step()).toBe(0);
    expect(h.state.refreshes).toBe(3);
    expect(h.live.stale).toBe(true);
    expect(h.timers.map((t) => t.ms)).toEqual([RETRY_MS]);
  });

  test("a failed request: stale, retry after 5 s with the same cursor, clear on the next answer", async () => {
    const h = harness();
    h.replies.push(answer({ reset: true, cursor: "e.2" }), new Error("network"), { not: "a live answer" }, answer({ cursor: "e.3" }));
    h.live.start();
    await h.step();
    expect(h.live.stale).toBe(false);
    await h.step();
    expect(h.live.stale).toBe(true);
    expect(h.timers.map((t) => t.ms)).toEqual([RETRY_MS]);
    await h.step();
    expect(h.live.stale).toBe(true);
    await h.step();
    expect(h.live.stale).toBe(false);
    expect(h.asked).toEqual([null, "e.2", "e.2", "e.2"]);
  });

  test("live_unavailable: stop asking and report live as none", async () => {
    const h = harness();
    h.replies.push(answer({ reset: true, events: lifecycle(1, 99_000) }), new LiveRefused("live_unavailable"));
    h.live.start();
    await h.step();
    await h.step();
    expect(h.live.capabilities.live).toBe("none");
    expect(h.timers.length).toBe(0);
    expect(h.live.poll(1e12)).toEqual([]);
  });

  test("login_required: stop asking and ask the page for a sign-in", async () => {
    const h = harness();
    h.replies.push(new LiveRefused("login_required"));
    h.live.start();
    await h.step();
    expect(h.state.logins).toBe(1);
    expect(h.timers.length).toBe(0);
  });

  test("close stops reading", async () => {
    const h = harness();
    h.replies.push(answer({ reset: true }));
    h.live.start();
    h.live.close();
    expect(h.timers.length).toBe(0);
    expect(h.asked).toEqual([]);
  });

  test("no live mode: never asks", () => {
    const h = harness({ capabilities: { ...caps, live: "none" } });
    expect(h.live.poll(0)).toEqual([]);
    expect(h.timers.length).toBe(0);
    expect(h.live.ready).toBe(true);
  });

  test("the live clock moves only when an answer disagrees by more than 1 s", async () => {
    const h = harness();
    h.replies.push(answer({ reset: true, now: 100_000 }), answer({ now: 102_500, events: lifecycle(1, 98_900) }), answer({ now: 110_000, events: lifecycle(2, 106_000) }));
    h.live.start();
    await h.step();
    h.live.poll(0); // skew = 0 - 96500
    await h.step();
    // At page time 2000 the service live clock would be 98500 by the kept skew; the answer says
    // 99000 (500 ms apart), so the kept skew stays and t=98900 is not due yet.
    expect(h.live.poll(2_000)).toEqual([]);
    expect(h.live.poll(2_400).map((e) => e.type)).toEqual(["start", "route"]);
    await h.step();
    // The next answer says 106500 at page time 3000: 7 s off, so the clock moves.
    const due = h.live.poll(3_000);
    expect(due.map((e) => `${e.type}${e.id}`)).toEqual(["ttfb1", "end1", "start2", "route2", "ttfb2"]);
    expect(due[2]!.t).toBe(3_000 - 500);
  });
});

describe("parsing", () => {
  test("malformed events are dropped, good ones kept", () => {
    const events = liveEvents([
      { type: "start", id: 1, t: 1, origin: "", model: "m" },
      { type: "start", id: 2, t: 1, model: "m" },
      { type: "route", id: 1, t: 2, route: -1 },
      { type: "route", id: 1, t: 2, route: 3 },
      { type: "end", id: 1, t: 3, status: "weird", durationMs: 1 },
      { type: "end", id: 1, t: 3, status: "error", durationMs: 5, ttfbMs: null, errorCode: "503" },
      null,
      "x",
    ]);
    expect(events).toEqual([
      { type: "start", id: 1, t: 1, origin: "", model: "m" },
      { type: "route", id: 1, t: 2, route: 3 },
      { type: "end", id: 1, t: 3, status: "error", ttfbMs: null, durationMs: 5, errorCode: "503" },
    ]);
  });

  test("an answer needs version, now, cursor, and events", () => {
    expect(parseLiveAnswer(null)).toBeNull();
    expect(parseLiveAnswer({ version: "v", now: 1, cursor: "c" })).toBeNull();
    expect(parseLiveAnswer({ version: "v", now: 1, cursor: "c", events: [], pollMs: "x" })?.pollMs).toBe(2000);
  });
});
