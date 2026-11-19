// Unit tests of how a drag turns the views (docs/spec-screen.md OS-M2c). Run with `bun test`.
import { describe, expect, test } from "bun:test";
import { FLAT_PITCH_MAX, FLAT_PITCH_MIN, GLOBE_LAT_LIMIT, START_TURN, globeLat, swingFlat, turnAt, turnGlobe, type Turn } from "../src/scene/orbit";

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
