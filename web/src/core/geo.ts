import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import type { MultiPolygon, Polygon } from "geojson";

export const DEG = Math.PI / 180;

/** Longitude difference wrapped to (-180, 180]. */
export function wrapLon(delta: number): number {
  let d = ((((delta + 180) % 360) + 360) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}

export function millerY(lat: number): number {
  return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * lat * DEG));
}

/** Land polygons as rings of [lon, lat]; the first ring of a polygon is its outline, the rest are holes. */
export type LandPolygons = Array<Array<Array<[number, number]>>>;

/**
 * Loads the land outline (Natural Earth 1:50m, coastlines only). The screen draws no country or
 * province border, so it makes no statement about any boundary.
 */
export async function loadLand(): Promise<LandPolygons> {
  const topology = (await import("world-atlas/land-50m.json")).default as unknown as Topology;
  const land = feature(topology, topology.objects.land!) as unknown as {
    features?: Array<{ geometry: MultiPolygon | Polygon }>;
    geometry?: MultiPolygon | Polygon;
  };
  const geometries = land.features ? land.features.map((f) => f.geometry) : [land.geometry!];
  const polygons: LandPolygons = [];
  for (const geometry of geometries) {
    const list = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of list) polygons.push(polygon.map((ring) => ring.map((p) => [p[0]!, p[1]!] as [number, number])));
  }
  return polygons;
}

/**
 * Paints the land into an equirectangular data texture (north at the top, 180°W at the left):
 * red = land fill, green = coastline, blue = a soft band around the coastline. The scene shader
 * turns the channels into theme colours.
 */
export function paintLand(polygons: LandPolygons, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const y = (lat: number) => ((90 - lat) / 180) * height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  // A ring that crosses the antimeridian jumps from +180 to -180 in the source. Its longitudes
  // are made continuous here, and such a polygon is drawn again one world to the east and west,
  // so both halves land inside the texture.
  const shapes = polygons.map((polygon) => {
    let min = Infinity;
    let max = -Infinity;
    const rings = polygon.map((ring) => {
      let lon = ring[0]![0];
      return ring.map((p, i) => {
        if (i > 0) lon += wrapLon(p[0] - ring[i - 1]![0]);
        min = Math.min(min, lon);
        max = Math.max(max, lon);
        return [lon, p[1], p[0]] as [number, number, number];
      });
    });
    const shifts = [0];
    if (min < -180) shifts.push(360);
    if (max > 180) shifts.push(-360);
    return { rings, shifts };
  });
  const each = (draw: (ring: Array<[number, number, number]>, x: (lon: number) => number) => void) => {
    for (const shape of shapes) {
      for (const shift of shape.shifts) {
        const x = (lon: number) => ((lon + shift + 180) / 360) * width;
        for (const ring of shape.rings) draw(ring, x);
      }
    }
  };

  ctx.fillStyle = "rgb(255,0,0)";
  for (const shape of shapes) {
    for (const shift of shape.shifts) {
      const x = (lon: number) => ((lon + shift + 180) / 360) * width;
      ctx.beginPath();
      for (const ring of shape.rings) {
        ring.forEach((p, i) => (i === 0 ? ctx.moveTo(x(p[0]), y(p[1])) : ctx.lineTo(x(p[0]), y(p[1]))));
        ctx.closePath();
      }
      ctx.fill("evenodd");
    }
  }

  // Edges that the source added where it cut a polygon at the antimeridian, and the edge that
  // closes Antarctica along the south pole, are not coast and must not be stroked.
  const seam = (a: [number, number, number], b: [number, number, number]) => (Math.abs(a[2]) > 179.9 && Math.abs(b[2]) > 179.9) || (a[1] < -89.5 && b[1] < -89.5);
  const stroke = (lineWidth: number, style: string) => {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = style;
    ctx.beginPath();
    each((ring, x) => {
      let pen = false;
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1]!;
        const b = ring[i]!;
        if (seam(a, b)) {
          pen = false;
          continue;
        }
        if (!pen) ctx.moveTo(x(a[0]), y(a[1]));
        ctx.lineTo(x(b[0]), y(b[1]));
        pen = true;
      }
    });
    ctx.stroke();
  };
  const k = width / 4096;
  ctx.globalCompositeOperation = "lighter";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  stroke(13 * k, "rgba(0,0,255,0.09)");
  stroke(7 * k, "rgba(0,0,255,0.16)");
  stroke(3.4 * k, "rgba(0,0,255,0.3)");
  stroke(1.7 * k, "rgb(0,255,0)");
  return canvas;
}
