// Unit tests of how a drag turns the views (docs/spec-screen.md OS-M2c). Run with `bun test`.
import { describe, expect, test } from "bun:test";
import { FLAT_PITCH_MAX, FLAT_PITCH_MIN, GLOBE_LAT_LIMIT, HOME_MS, Homing, IDLE_MS, START_POSE, START_TURN, atStart, globeLat, homeward, swingFlat, turnAt, turnGlobe, type Pose, type Turn } from "../src/scene/orbit";

/** Drags `total` pixels across in steps of `step`, as a pointer does. */
function drag(turn: Turn, total: number, step: number, move: (turn: Turn, dx: number) => Turn): Turn {
  for (let done = 0; Math.abs(done) < Math.abs(total); done += step) turn = move(turn, step);
  return turn;
}

describe("globe", () => {
  test("goes all the way round, and further, in both directions", () => {
    const seen = new Set<number>();
    let turn = START_TURN;
    // 0.2 degree per pixel: 1800 px is one turn. Three turns to the west, step by step.
    for (let i = 0; i < 3 * 1800; i += 10) {
      turn = turnGlobe(turn, 10, 0, 40);
      seen.add(Math.floor(turn.lon / 10));
      expect(turn.lon).toBeGreaterThan(-180);
      expect(turn.lon).toBeLessThanOrEqual(180);
    }
    // Every 10 degree sector was passed: nothing held the globe back.
    expect(seen.size).toBeGreaterThanOrEqual(36);
    expect(turn.lon).toBeCloseTo(0, 6);
    turn = drag(turn, -1800 * 5 - 450, -15, (t, dx) => turnGlobe(t, dx, 0, 40));
    expect(turn.lon).toBeCloseTo(90, 6);
  });

  test("a half turn shows the far side", () => {
    const turn = turnGlobe(START_TURN, -900, 0, 40);
    expect(Math.abs(turn.lon)).toBeCloseTo(180, 6);
  });

  test("the camera latitude stays within the limit and never passes a pole", () => {
    for (const camLat of [-55, 0, 43, 60]) {
      let turn = drag(START_TURN, 5000, 25, (t, dy) => turnGlobe(t, 0, dy, camLat));
      expect(globeLat(camLat, turn.lat)).toBe(GLOBE_LAT_LIMIT);
      // A drag past the limit is not stored up: the way back starts at once.
      turn = turnGlobe(turn, 0, -10, camLat);
      expect(globeLat(camLat, turn.lat)).toBeCloseTo(GLOBE_LAT_LIMIT - 1.6, 6);
      turn = drag(turn, -5000, -25, (t, dy) => turnGlobe(t, 0, dy, camLat));
      expect(globeLat(camLat, turn.lat)).toBe(-GLOBE_LAT_LIMIT);
    }
  });

  test("the limit holds when the frame moves after the drag", () => {
    const turn = drag(START_TURN, 5000, 25, (t, dy) => turnGlobe(t, 0, dy, 10));
    expect(globeLat(60, turn.lat)).toBe(GLOBE_LAT_LIMIT);
  });

  test("a drag over the globe leaves the flat camera alone", () => {
    const turn = turnGlobe(START_TURN, 300, 40, 40);
    expect(turn.yaw).toBe(START_TURN.yaw);
    expect(turn.pitch).toBe(START_TURN.pitch);
  });
});

describe("flat map", () => {
  test("the camera swings all the way round the map", () => {
    let turn = START_TURN;
    const seen = new Set<number>();
    // 0.16 degree per pixel: 2250 px is one turn.
    for (let i = 0; i < 2 * 2250; i += 9) {
      turn = swingFlat(turn, 9, 0);
      seen.add(Math.floor(turn.yaw / 10));
      expect(Math.abs(turn.yaw)).toBeLessThanOrEqual(180);
    }
    expect(seen.size).toBeGreaterThanOrEqual(36);
    expect(turn.yaw).toBeCloseTo(0, 6);
  });

  test("the tilt stays from 26 to 80 degrees", () => {
    expect(drag(START_TURN, 4000, 20, (t, dy) => swingFlat(t, 0, dy)).pitch).toBe(FLAT_PITCH_MAX);
    expect(drag(START_TURN, -4000, -20, (t, dy) => swingFlat(t, 0, dy)).pitch).toBe(FLAT_PITCH_MIN);
  });

  test("a drag over the map leaves the globe alone", () => {
    const turn = swingFlat(START_TURN, 300, 40);
    expect(turn.lon).toBe(0);
    expect(turn.lat).toBe(0);
  });
});

describe("view switch", () => {
  const same = (a: number, b: number) => expect(Math.abs(((a - b + 540) % 360) - 180)).toBeLessThan(1e-9);

  test("each view is turned by its own turn when it is on screen", () => {
    const turned: Turn = { lon: 120, lat: 20, yaw: -150, pitch: 40 };
    same(turnAt(turned, 0), 120);
    same(turnAt(turned, 1), -150);
  });

  test("during a switch the turn goes the short way, steadily, by at most half a turn", () => {
    for (const [lon, yaw] of [[180, -170], [120, -150], [-170, 170], [0, 180], [90, 90], [10, -10]] as const) {
      const turned: Turn = { lon, lat: 0, yaw, pitch: 56 };
      const way = Math.abs(((yaw - lon + 540) % 360) - 180);
      let travelled = 0;
      for (let i = 1; i <= 100; i++) {
        const step = Math.abs(((turnAt(turned, i / 100) - turnAt(turned, (i - 1) / 100) + 540) % 360) - 180);
        // Even steps: no part of the switch turns faster than another.
        expect(step).toBeCloseTo(way / 100, 9);
        travelled += step;
      }
      expect(travelled).toBeCloseTo(way, 9);
      expect(travelled).toBeLessThanOrEqual(180);
    }
  });

  test("untouched views switch as before", () => {
    expect(turnAt(START_TURN, 0)).toBe(0);
    expect(turnAt(START_TURN, 0.5)).toBe(0);
    expect(turnAt(START_TURN, 1)).toBe(0);
  });
});

describe("return when left alone (OS-M2c.6)", () => {
  const FRAME = 1000 / 30;
  const turned: Pose = { turn: { lon: -170, lat: -30, yaw: 180, pitch: 70 }, zoom: 0.7 };

  /** Runs the scene's frames from `from` to `to` (ms), the viewer's pose held by `pose`. */
  function run(homing: Homing, pose: Pose, from: number, to: number, seen?: Pose[]): Pose {
    for (let now = from; now <= to; now += FRAME) {
      pose = homing.step(now, pose);
      seen?.push(pose);
    }
    return pose;
  }

  test("goes straight back the short way, and reaches the start exactly", () => {
    expect(homeward(turned, 0)).toEqual(turned);
    const half = homeward(turned, 0.5);
    // -170 goes up through -85 to 0, never across 180.
    expect(half.turn.lon).toBeCloseTo(-85, 9);
    expect(half.turn.lat).toBeCloseTo(-15, 9);
    expect(half.turn.yaw).toBeCloseTo(90, 9);
    expect(half.turn.pitch).toBeCloseTo((70 + START_TURN.pitch) / 2, 9);
    expect(half.zoom).toBeCloseTo(Math.sqrt(0.7), 9);
    expect(homeward(turned, 1)).toBe(START_POSE);
    expect(atStart(START_POSE)).toBe(true);
    expect(atStart(turned)).toBe(false);
    expect(atStart({ turn: START_TURN, zoom: 1.2 })).toBe(false);
  });

  test("waits the idle time after the last use, then eases back in time", () => {
    const homing = new Homing();
    homing.step(0, turned);
    const seen: Pose[] = [];
    let pose = run(homing, turned, FRAME, IDLE_MS - FRAME, seen);
    expect(pose).toEqual(turned);
    pose = run(homing, pose, IDLE_MS, IDLE_MS + HOME_MS + FRAME, seen);
    expect(pose).toBe(START_POSE);
    // Each frame moves the same way, no faster than 1.5 times the mean pace (plus rounding).
    const mean = (170 * FRAME) / HOME_MS;
    for (let i = 1; i < seen.length; i++) {
      const step = seen[i]!.turn.lon - seen[i - 1]!.turn.lon;
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(1.5 * mean + 1e-9);
    }
    // At the start it stays there.
    expect(run(homing, pose, IDLE_MS + HOME_MS + 2 * FRAME, 3 * IDLE_MS)).toBe(START_POSE);
  });

  test("any use starts the wait again", () => {
    const homing = new Homing();
    homing.step(0, turned);
    let pose = run(homing, turned, FRAME, IDLE_MS - 10_000);
    homing.use();
    pose = run(homing, pose, IDLE_MS - 10_000 + FRAME, 2 * IDLE_MS - 20_000);
    expect(pose).toEqual(turned);
    pose = run(homing, pose, 2 * IDLE_MS - 20_000 + FRAME, 2 * IDLE_MS + HOME_MS);
    expect(pose).toBe(START_POSE);
  });

  test("a use on the way stops the return where it is", () => {
    const homing = new Homing();
    homing.step(0, turned);
    let pose = run(homing, turned, FRAME, IDLE_MS + HOME_MS / 2);
    expect(pose.turn.lon).toBeGreaterThan(-170);
    expect(pose.turn.lon).toBeLessThan(0);
    homing.use();
    const held = pose;
    pose = run(homing, pose, IDLE_MS + HOME_MS / 2 + FRAME, 2 * IDLE_MS);
    expect(pose).toEqual(held);
    // Left alone again, it goes the rest of the way.
    pose = run(homing, pose, 2 * IDLE_MS + FRAME, 3 * IDLE_MS);
    expect(pose).toBe(START_POSE);
  });

  test("an untouched view never moves", () => {
    const homing = new Homing();
    expect(run(homing, START_POSE, 0, 3 * IDLE_MS)).toBe(START_POSE);
  });
});
