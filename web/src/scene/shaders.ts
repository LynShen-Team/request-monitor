/** GLSL of the flow scene. Colours are authored in sRGB and written to the framebuffer unchanged. */

/**
 * Shared by arcs and comets: a curve between two sites that is a lifted great circle on the globe
 * and a parabola over the flat map, blended by `uMorph`, expanded to a screen-space ribbon.
 */
const CURVE = /* glsl */ `
uniform float uMorph;
uniform vec2 uRes;
attribute float aT;
attribute float aSide;
attribute vec3 iA;
attribute vec3 iB;
attribute vec3 iAF;
attribute vec3 iBF;
attribute vec4 iShape; // globe lift, flat lift, half width in px, unused

vec3 curve(float t) {
  vec3 na = normalize(iA);
  vec3 nb = normalize(iB);
  float om = acos(clamp(dot(na, nb), -1.0, 1.0));
  vec3 g = om < 0.002 ? mix(iA, iB, t) : (sin((1.0 - t) * om) * iA + sin(t * om) * iB) / sin(om);
  float lift = sin(3.14159265 * t);
  g *= 1.0 + iShape.x * lift;
  vec3 f = mix(iAF, iBF, t);
  f.y += iShape.y * lift;
  return mix(g, f, uMorph);
}

vec4 ribbon(float t, float halfWidth) {
  vec4 c0 = projectionMatrix * modelViewMatrix * vec4(curve(t), 1.0);
  float dt = t < 0.5 ? 0.01 : -0.01;
  vec4 c1 = projectionMatrix * modelViewMatrix * vec4(curve(t + dt), 1.0);
  vec2 s0 = c0.xy / c0.w * uRes * 0.5;
  vec2 s1 = c1.xy / c1.w * uRes * 0.5;
  vec2 dir = s1 - s0;
  float len = length(dir);
  dir = len > 0.0001 ? dir / len : vec2(1.0, 0.0);
  if (dt < 0.0) dir = -dir;
  vec2 nrm = vec2(-dir.y, dir.x);
  c0.xy += nrm * aSide * halfWidth / (uRes * 0.5) * c0.w;
  return c0;
}
`;

export const ARC_VERTEX = /* glsl */ `
${CURVE}
attribute vec3 iColA;
attribute vec3 iColB;
attribute vec4 iLevel; // steady alpha, flow alpha, dash count, phase
varying float vT;
varying float vV;
varying vec3 vCol;
varying vec4 vLevel;
void main() {
  vT = aT;
  vV = aSide;
  vLevel = iLevel;
  vCol = mix(iColA, iColB, aT);
  gl_Position = ribbon(aT, iShape.z);
}
`;

export const ARC_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uFade;
uniform float uLight;
varying float vT;
varying float vV;
varying vec3 vCol;
varying vec4 vLevel;
void main() {
  float v = abs(vV);
  float core = smoothstep(0.36, 0.0, v);
  float halo = exp(-v * v * 6.5) * 0.4;
  // Dashes travel toward larger t; each has a bright head and a tail behind it.
  float ph = fract(vT * vLevel.z - uTime * 0.4 + vLevel.w);
  float flow = ph < 0.62 ? pow(ph / 0.62, 2.6) : smoothstep(0.76, 0.62, ph);
  float a = (vLevel.x + vLevel.y * flow) * (core + halo);
  a *= smoothstep(0.0, 0.025, vT) * smoothstep(1.0, 0.975, vT) * uFade;
  // On a dark ground the core burns toward white; on a light ground it keeps its colour and the
  // line is drawn stronger, because nothing adds up there.
  vec3 col = mix(vCol, vec3(1.0), core * flow * vLevel.y * 0.3 * (1.0 - uLight));
  gl_FragColor = vec4(col, min(1.0, a * mix(1.0, 2.3, uLight)));
}
`;

export const COMET_VERTEX = /* glsl */ `
${CURVE}
attribute vec4 iHead; // head position, trail length, alpha, reversed
attribute vec3 iCol;
varying float vS;
varying float vV;
varying vec3 vCol;
varying float vA;
void main() {
  float t = clamp(iHead.x - iHead.y * (1.0 - aT), 0.0, 1.0);
  if (iHead.w > 0.5) t = 1.0 - t;
  vS = aT;
  vV = aSide;
  vCol = iCol;
  vA = iHead.z;
  gl_Position = ribbon(t, iShape.z * mix(0.28, 1.0, aT));
}
`;

export const COMET_FRAGMENT = /* glsl */ `
uniform float uFade;
uniform float uLight;
varying float vS;
varying float vV;
varying vec3 vCol;
varying float vA;
void main() {
  float v = abs(vV);
  float core = smoothstep(0.46, 0.0, v);
  float halo = exp(-v * v * 5.0) * 0.5;
  float a = vA * pow(vS, 2.1) * (core + halo) * uFade;
  gl_FragColor = vec4(mix(vCol, vec3(1.0), core * vS * 0.45 * (1.0 - uLight)), min(1.0, a * mix(1.0, 1.7, uLight)));
}
`;

export const HEAD_VERTEX = /* glsl */ `
attribute vec3 aCol;
attribute vec2 aGlow; // size in px, alpha
uniform float uDpr;
varying vec3 vCol;
varying float vA;
void main() {
  vCol = aCol;
  vA = aGlow.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aGlow.x * uDpr;
}
`;

export const HEAD_FRAGMENT = /* glsl */ `
uniform float uLight;
varying vec3 vCol;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float core = smoothstep(0.28, 0.0, d);
  float glow = exp(-d * d * 4.5);
  float a = vA * (glow * 0.8 + core);
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(vCol, vec3(1.0), core * 0.6 * (1.0 - uLight)), a);
}
`;

/**
 * The Earth's surface: one grid that is a sphere in the globe view and a plane in the map view.
 * `position` is the place on the globe, `aFlat` the place on the map; `uv` is equirectangular.
 */
export const SURFACE_VERTEX = /* glsl */ `
attribute vec3 aFlat;
uniform float uMorph;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vFlat;
void main() {
  vec3 p = mix(position, aFlat, uMorph);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * normalize(mix(normalize(position), vec3(0.0, 1.0, 0.0), uMorph)));
  vV = normalize(-mv.xyz);
  vUv = uv;
  vFlat = aFlat;
  gl_Position = projectionMatrix * mv;
}
`;

/** `uMap`: red = land, green = coastline, blue = soft band around the coastline (see paintLand). */
export const SURFACE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uOcean;
uniform vec3 uLand;
uniform vec3 uCoast;
uniform vec3 uRim;
uniform vec3 uFocus;
uniform float uMorph;
uniform float uLight;
uniform float uShade;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vFlat;
float dash(float t) {
  float w = fwidth(t);
  return 1.0 - smoothstep(0.25 - w, 0.25 + w, abs(fract(t) - 0.5));
}
void main() {
  vec3 t = texture2D(uMap, vUv).rgb;
  float land = t.r;
  float globe = 1.0 - uMorph;
  float f = pow(1.0 - max(dot(vN, vV), 0.0), 4.2) * globe;
  vec3 col = mix(mix(uOcean, uRim, f * 0.42), uLand, land);
  // Graticule every 15 degrees, drawn dashed (2.5 degrees on, 2.5 off) in both views. Meridians
  // crowd together at the poles, so they stop short of them.
  vec2 g = vUv * vec2(24.0, 12.0);
  vec2 cover = 1.0 - min(abs(fract(g - 0.5) - 0.5) / fwidth(g) * 0.85, 1.0);
  float grat = max(cover.x * dash(vUv.y * 36.0) * smoothstep(0.93, 0.8, abs(vUv.y * 2.0 - 1.0)), cover.y * dash(vUv.x * 72.0));
  // On a dark ground the coast glows (colour is added); on a light ground it is an ink line.
  float line = clamp(t.g * 0.85 + t.b * 0.34, 0.0, 1.0);
  vec3 dark = col + uCoast * (line + grat * 0.3);
  vec3 light = mix(mix(col, uCoast, grat * 0.45), uCoast, clamp(t.g * 0.9 + t.b * 0.22, 0.0, 1.0));
  col = mix(dark, light, uLight);
  // Soft light from the upper left gives a pale globe its volume; uShade is 0 on dark themes.
  float lit = smoothstep(-0.35, 0.85, dot(vN, normalize(vec3(-0.45, 0.55, 0.7))));
  col *= 1.0 - uShade * (1.0 - lit) * globe;
  // The globe is opaque. On the map the sea is clear, far land fades out, and the far south is cut.
  float far = smoothstep(2.9, 1.5, length(vFlat - uFocus));
  float south = smoothstep(0.1, 0.19, vUv.y);
  float sheet = far * south * max(max(land * mix(0.72, 0.96, uLight), line), grat * mix(0.3, 0.45, uLight));
  gl_FragColor = vec4(col, mix(1.0, sheet, uMorph));
}
`;

const VIEW_VARYINGS = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const AIR_VERTEX = VIEW_VARYINGS;

/** Drawn on the back faces of a larger sphere: full at the globe's limb, zero at the outer edge. */
export const AIR_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
void main() {
  float d = clamp(-dot(vN, vV) / 0.42, 0.0, 1.0);
  gl_FragColor = vec4(uColor, pow(d, 3.2) * uOpacity);
}
`;
