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
 * The horizontal turns in use at `morph` (0: globe, 1: flat map). During a view switch the turn of
 * the view being left winds back to zero and that of the view being entered winds out from zero,
 * so the camera never has to cross the scene from one side of it to the other.
 */
export function turnsAt(turn: Turn, morph: number): { lon: number; yaw: number } {
  return { lon: turn.lon * (1 - morph), yaw: turn.yaw * morph };
}
