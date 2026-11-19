import { wrapLon } from "../core/geo";
import { FLAT_PITCH } from "./frame";

/**
 * How a pointer drag turns the two views (docs/spec-screen.md OS-M2c). A horizontal turn has no
 * limit and is kept from −180 to 180 degrees, so it does not grow however often the scene goes
 * round; a vertical one is limited.
 */

/** The globe's camera stays within this many degrees of the equator, so it never passes over a pole. */
export const GLOBE_LAT_LIMIT = 75;
/** Tilt of the flat camera above the map, in degrees. */
export const FLAT_PITCH_MIN = 26;
export const FLAT_PITCH_MAX = 80;
/** Degrees per CSS pixel of drag. */
const GLOBE_LON_PER_PX = 0.2;
const GLOBE_LAT_PER_PX = 0.16;
const FLAT_PER_PX = 0.16;

export interface Turn {
  /** Globe: degrees of longitude and of latitude that the drag adds to the frame's camera. */
  lon: number;
  lat: number;
  /** Flat map: turn of the camera around the point it looks at (0: from the south), and its tilt. */
  yaw: number;
  pitch: number;
}

export const START_TURN: Turn = { lon: 0, lat: 0, yaw: 0, pitch: FLAT_PITCH };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Latitude of the globe's camera for the frame's camera latitude and the drag's latitude. */
export function globeLat(camLat: number, lat: number): number {
  return clamp(camLat + lat, -GLOBE_LAT_LIMIT, GLOBE_LAT_LIMIT);
}

/**
 * A drag over the globe. `camLat` is the frame's camera latitude: the latitude kept is what the
 * limit lets the camera reach from there, so a drag past the limit is not stored up.
 */
export function turnGlobe(turn: Turn, dx: number, dy: number, camLat: number): Turn {
  return { ...turn, lon: wrapLon(turn.lon - dx * GLOBE_LON_PER_PX), lat: globeLat(camLat, turn.lat + dy * GLOBE_LAT_PER_PX) - camLat };
}

/** A drag over the flat map: the camera swings around the point it looks at and tilts. */
export function swingFlat(turn: Turn, dx: number, dy: number): Turn {
  return { ...turn, yaw: wrapLon(turn.yaw - dx * FLAT_PER_PX), pitch: clamp(turn.pitch + dy * FLAT_PER_PX, FLAT_PITCH_MIN, FLAT_PITCH_MAX) };
}

/**
 * How far the camera is turned about the vertical axis at `morph` (0: globe, 1: flat map), in
 * degrees: the globe's turn on the globe, the map's over the map, and during a view switch the
 * short way from one to the other. The camera's path of a switch between the default views is
 * turned by this angle, so a switch between turned views is that same switch seen from another
 * side: it never passes nearer to the axis, and the angle adds at most half a turn on the way.
 */
export function turnAt(turn: Turn, morph: number): number {
  return turn.lon + wrapLon(turn.yaw - turn.lon) * morph;
}

/** Nobody has used the page for this long: the view goes back to where it starts (OS-M2c.6). */
export const IDLE_MS = 180_000;
/** How long the way back takes. */
export const HOME_MS = 5000;

/** What the viewer can change of the camera: the turns of both views and the zoom factor. */
export interface Pose {
  turn: Turn;
  zoom: number;
}

export const START_POSE: Pose = { turn: START_TURN, zoom: 1 };

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export function atStart(pose: Pose): boolean {
  const { turn } = pose;
  return near(turn.lon, 0) && near(turn.lat, 0) && near(turn.yaw, 0) && near(turn.pitch, START_TURN.pitch) && near(pose.zoom, 1);
}

/**
 * The pose `share` (0..1) of the way from `from` back to the start. The angles were kept from
 * −180 to 180, so going straight to 0 is the short way round; the zoom goes evenly in scale.
 */
export function homeward(from: Pose, share: number): Pose {
  if (share >= 1) return START_POSE;
  const keep = 1 - share;
  const { turn } = from;
  return {
    turn: { lon: turn.lon * keep, lat: turn.lat * keep, yaw: turn.yaw * keep, pitch: START_TURN.pitch + (turn.pitch - START_TURN.pitch) * keep },
    zoom: from.zoom ** keep,
  };
}

/**
 * The return to the start when the page is left alone: `use()` on every use of the page (a press,
 * a pointer move, a wheel, a key), `step()` once per frame with the scene's clock. IDLE_MS after
 * the last use the pose eases back over HOME_MS; a use on the way stops it where it is.
 */
export class Homing {
  private used = true;
  private usedAt = 0;
  private from: Pose | null = null;
  private fromAt = 0;

  use() {
    this.used = true;
  }

  /** The pose to draw at `now`, given the pose as the viewer left it. */
  step(now: number, pose: Pose): Pose {
    if (this.used) {
      this.used = false;
      this.usedAt = now;
      this.from = null;
      return pose;
    }
    if (this.from === null) {
      if (now - this.usedAt < IDLE_MS || atStart(pose)) return pose;
      this.from = pose;
      this.fromAt = now;
    }
    const from = this.from;
    const t = Math.min(1, (now - this.fromAt) / HOME_MS);
    if (t >= 1) this.from = null;
    // Eased at both ends: it starts and stops gently, at most 1.5 times its mean pace.
    return homeward(from, t * t * (3 - 2 * t));
  }
}
