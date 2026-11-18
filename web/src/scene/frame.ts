import { DEG, millerY, wrapLon } from "../core/geo";

/**
 * Where the two views look. It is derived from the nodes, so that a gateway anywhere on Earth,
 * with upstreams and users on any continent, is in the picture without a setting.
 */

/** World units per radian of the flat map; the globe has radius 1. */
export const FLAT_S = 0.55;
/** Vertical field of view of the camera, in degrees. */
export const FOV = 30;
/** The flat camera looks at a point this far (world units, negative = north) from the frame's latitude. */
export const FLAT_TARGET_Z = -0.07;
/** Default tilt of the flat camera above the map, in degrees. */
export const FLAT_PITCH = 56;
/** The flat map shows this share of the scene area's height above its centre line (the rest is below). */
export const FLAT_CENTRE_Y = 0.62;
/** Widest and narrowest longitude span that the flat map fits between the side panels. */
const SPAN_MAX = 300;
const SPAN_MIN = 80;
/** Cosine of 66°: a site this far from the point under the globe's camera is still on the visible side. */
const SITE_IN_SIGHT = 0.407;

export interface Frame {
  /** Longitude at the centre of the flat map, and the latitude at its depth origin. */
  lon: number;
  lat: number;
  /** Where the globe's camera stands. */
  camLon: number;
  camLat: number;
}

/** Before any node is known. */
export const START_FRAME: Frame = { lon: 176, lat: 31, camLon: 176, camLat: 43 };

export interface FramePoint {
  lon: number;
  lat: number;
  kind: "gateway" | "upstream" | "origin";
}

type V3 = [number, number, number];

function unit(lon: number, lat: number): V3 {
  const c = Math.cos(lat * DEG);
  return [c * Math.sin(lon * DEG), Math.sin(lat * DEG), c * Math.cos(lon * DEG)];
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalize(a: V3): V3 {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** The point at share `t` of the way from `a` to `b`, on the sphere. */
function toward(a: V3, b: V3, t: number): V3 {
  return normalize([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

const lonOf = (a: V3) => Math.atan2(a[0], a[2]) / DEG;
const latOf = (a: V3) => Math.asin(Math.max(-1, Math.min(1, a[1]))) / DEG;

/**
 * True when a globe camera above (camLon, camLat) shows the point well: on the near side, not
 * close to the east or west limb, and above the timeline, which covers the globe's south.
 */
function inView(camLon: number, camLat: number, point: V3): boolean {
  const cam = unit(camLon, camLat);
  // Screen axes of a camera that looks at the Earth's centre with north up.
  const right = normalize([cam[2], 0, -cam[0]]);
  const up: V3 = [cam[1] * right[2] - cam[2] * right[1], cam[2] * right[0] - cam[0] * right[2], cam[0] * right[1] - cam[1] * right[0]];
  const x = dot(point, right);
  const y = dot(point, up);
  return dot(point, cam) >= 0.5 && Math.abs(x) <= 0.66 && y >= -0.35 && y <= 0.8;
}

/**
 * Centre meridian of the flat map: the middle of a span of longitudes that holds every point. The
 * map is cut in the gap between points that lies opposite the globe's camera, so the two views
 * face the same side of the Earth; when the span is then wider than the map shows, in the widest gap.
 */
function mapCentre(points: FramePoint[], camLon: number): number {
  const lons = points.map((p) => ((p.lon % 360) + 360) % 360).sort((a, b) => a - b);
  const gaps = lons.map((lon, i) => ({ from: lon, width: (i + 1 < lons.length ? lons[i + 1]! : lons[0]! + 360) - lon }));
  const back = (((camLon + 180) % 360) + 360) % 360;
  const behind = gaps.find((gap) => ((back - gap.from + 360) % 360) <= gap.width)!;
  const widest = gaps.reduce((a, b) => (b.width > a.width ? b : a));
  const cut = 360 - behind.width <= SPAN_MAX - 6 ? behind : widest;
  return wrapLon(cut.from + cut.width + (360 - cut.width) / 2);
}

/**
 * The frame for a set of key points (the gateway, the upstream sites, the busiest user regions).
 *
 * Globe: the camera stands above the point whose largest distance to a key point is smallest,
 * moved up to a quarter of the way (in longitude and latitude) toward the gateway. When the key
 * points span more of the Earth than one side of a globe shows, it moves further toward the
 * gateway until the gateway is well in view. Flat map: see `mapCentre`; its latitude follows the
 * globe's camera.
 */
export function frameFor(points: FramePoint[]): Frame {
  const gateway = points.find((p) => p.kind === "gateway");
  if (!gateway) return START_FRAME;
  const units = points.map((p) => unit(p.lon, p.lat));
  const home = unit(gateway.lon, gateway.lat);
  const sum = units.reduce<V3>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  // Points that cancel out (two on opposite sides of the Earth) have no mean direction.
  let centre = Math.hypot(sum[0], sum[1], sum[2]) < 1e-3 ? home : normalize(sum);
  // Badoiu and Clarkson: step toward the farthest point, by less each time.
  for (let k = 1; k <= 300; k++) {
    let far = units[0]!;
    for (const p of units) if (dot(p, centre) < dot(far, centre)) far = p;
    centre = toward(centre, far, 1 / (k + 1));
  }
  // The pull toward the gateway is smaller when a quarter would turn an upstream site out of sight.
  const sites = units.filter((_, i) => points[i]!.kind !== "origin");
  const pull = (share: number) => unit(lonOf(centre) + share * wrapLon(gateway.lon - lonOf(centre)), latOf(centre) + share * (gateway.lat - latOf(centre)));
  const share = [0.25, 0.2, 0.15, 0.1, 0.05, 0].find((t) => sites.every((site) => dot(site, pull(t)) >= SITE_IN_SIGHT)) ?? 0.25;
  const pulled = pull(share);
  // Opposite the gateway there is no way "toward" it: start from the gateway itself.
  const from = dot(pulled, home) < -0.9 ? home : pulled;
  let camLon = lonOf(from);
  let camLat = latOf(from);
  for (let step = 0; step <= 50; step++) {
    const cam = toward(from, home, step / 50);
    camLon = lonOf(cam);
    camLat = Math.max(-55, Math.min(60, latOf(cam)));
    if (inView(camLon, camLat, home)) break;
  }
  return { lon: mapCentre(points, camLon), lat: Math.max(-40, Math.min(50, camLat - 12)), camLon, camLat };
}

export interface FlatFit {
  /** Distance of the flat camera from the point it looks at, at zoom 1. */
  reach: number;
  /** Largest zoom factor (zoom out) at which the map still covers the whole canvas width. */
  maxZoom: number;
}

/**
 * How far the flat camera stands back, so that every key point is inside the scene area (the
 * space between the side panels, above the timeline): a user region with its dot, a site with
 * room for its marker and label.
 * Lengths are CSS pixels; `ui` is the interface scale; `meshSpan` is the width of the map's mesh
 * in degrees of longitude.
 */
export function fitFlat(
  frame: Frame,
  points: FramePoint[],
  view: { width: number; height: number; safe: { x: number; y: number; w: number; h: number }; ui: number },
  meshSpan: number,
): FlatFit {
  const tanHalf = Math.tan((FOV * DEG) / 2);
  const focal = view.height / 2 / tanHalf;
  const sinP = Math.sin(FLAT_PITCH * DEG);
  const cosP = Math.cos(FLAT_PITCH * DEG);
  const u = view.ui;
  // Room kept free at the edges of the scene area, per kind: side, above, below (interface units).
  const ROOM = { origin: [0, 12, 8], upstream: [16, 40, 56], gateway: [16, 130, 56] } as const;
  const v0 = millerY(frame.lat);
  // A reach shows `span` world units between the side panels at the depth the camera looks at.
  const reachOf = (degrees: number, width: number) => (degrees * DEG * FLAT_S) / (2 * tanHalf * (width / view.height));
  // Before any node is known: the span of the start frame.
  let reach = points.length === 0 ? reachOf(150, view.safe.w) : 0;
  for (const p of points) {
    const x = Math.abs(wrapLon(p.lon - frame.lon)) * DEG * FLAT_S;
    // South of the point the camera looks at (positive) is nearer to the camera and lower on screen.
    const dz = -(millerY(Math.max(-80, Math.min(84, p.lat))) - v0) * FLAT_S - FLAT_TARGET_Z;
    const [side, above, below] = ROOM[p.kind];
    const half = Math.max(1, view.safe.w / 2 - side * u);
    const room = Math.max(1, dz > 0 ? view.safe.h * (1 - FLAT_CENTRE_Y) - below * u : view.safe.h * FLAT_CENTRE_Y - above * u);
    reach = Math.max(reach, dz * cosP + Math.max((x * focal) / half, (Math.abs(dz) * sinP * focal) / room));
  }
  const widest = Math.min(reachOf(SPAN_MAX, view.safe.w), reachOf(meshSpan - 12, view.width));
  reach = Math.max(reachOf(SPAN_MIN, view.safe.w), Math.min(widest, reach));
  return { reach, maxZoom: Math.max(1, reachOf(meshSpan - 12, view.width) / reach) };
}
