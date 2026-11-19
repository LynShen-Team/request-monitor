import * as THREE from "three";
import { DEG, millerY, paintLand, wrapLon, type LandPolygons } from "../core/geo";
import type { AggregateFlow, ArcKind, FlowView, MapNode, NodeMeta, Tone, ViewMode } from "../core/view";
import {
  AIR_FRAGMENT,
  AIR_VERTEX,
  ARC_FRAGMENT,
  ARC_VERTEX,
  COMET_FRAGMENT,
  COMET_VERTEX,
  HEAD_FRAGMENT,
  HEAD_VERTEX,
  SURFACE_FRAGMENT,
  SURFACE_VERTEX,
} from "./shaders";
import { FLAT_CENTRE_Y, FLAT_S, FLAT_TARGET_Z, FOV, START_FRAME, fitFlat, frameFor, type FlatFit, type Frame, type FramePoint } from "./frame";
import { START_TURN, globeLat, swingFlat, turnGlobe, turnsAt, type Turn } from "./orbit";
import type { Theme } from "./theme";

// Colours are authored in sRGB and blended as such, so a hex value looks the same here and in CSS.
THREE.ColorManagement.enabled = false;

export interface SafeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The map's mesh reaches this many degrees past its east and west edges. */
const MESH_EXTRA = 90;
/** Over this many degrees before its east and west ends the map fades out. */
const END_FADE = 30;
const MAX_ZOOM = 1.7;
const MORPH_MS = 1500;
const MAX_ARCS = 224;
const MAX_COMETS = 700;
const ARC_SEGMENTS = 96;
const COMET_SEGMENTS = 22;
const SURFACE = 1.004;
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

/** Colour of an upstream site by its success share; the dispatch colour when that is unknown. */
function siteTone(health: number | null): Tone {
  return health === null ? "out" : health >= 0.95 ? "ok" : health >= 0.8 ? "gone" : "err";
}

function globePoint(lon: number, lat: number, out: THREE.Vector3, radius = 1): THREE.Vector3 {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const c = Math.cos(phi) * radius;
  return out.set(c * Math.sin(lambda), Math.sin(phi) * radius, c * Math.cos(lambda));
}


function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function texture(size: number, paint: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  paint(canvas.getContext("2d")!, size);
  const map = new THREE.CanvasTexture(canvas);
  map.anisotropy = 4;
  return map;
}

interface SNode {
  def: MapNode;
  /** Shown position (an upstream may be moved off its real place so that glyphs do not overlap). */
  lon: number;
  lat: number;
  g: THREE.Vector3;
  f: THREE.Vector3;
  n: THREE.Vector3;
  trueG: THREE.Vector3;
  trueF: THREE.Vector3;
  pos: THREE.Vector3;
  up: THREE.Vector3;
  facing: number;
  sx: number;
  sy: number;
  activity: number;
  value: number;
  valueTarget: number;
  /** Null: the source records no failures, so the site has no health colour. */
  health: number | null;
  inflight: number;
  sub: string;
  /** An upstream in the gateway's own data centre: drawn as a ring around the gateway, with no arc. */
  colo: boolean;
  tags: Array<{ t0: number; tone: Tone; text: string }>;
  dot: THREE.Sprite;
  ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
  label: Label | null;
}

interface Label {
  el: HTMLDivElement;
  title: HTMLElement | null;
  sub: HTMLElement | null;
  tagEls: HTMLDivElement[];
  line: SVGPathElement | null;
  w: number;
  h: number;
  dirty: boolean;
  x: number;
  y: number;
  shown: number;
  text: string;
}

interface SArc {
  key: string;
  slot: number;
  from: SNode;
  to: SNode;
  kind: ArcKind;
  liftG: number;
  liftF: number;
  omega: number;
  hold: number;
  heat: number;
  recent: number;
  weight: number;
  weightTarget: number;
  errShare: number;
  emit: number;
  seed: number;
}

interface Comet {
  arc: SArc;
  t0: number;
  dur: number;
  tone: Tone;
  reverse: boolean;
  size: number;
}

interface Pulse {
  node: SNode;
  t0: number;
  tone: Tone;
  size: number;
}

/**
 * WebGL renderer of the flow map. One scene is shown either on a globe or on a tilted flat map
 * ("sand table"); every land dot, node, arc and comet has a position in both and a view switch
 * blends between them. All time input is the caller's clock, so frames can be stepped.
 */
export class Scene3D implements FlowView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
  private readonly overlay: HTMLElement;
  private readonly leads: SVGSVGElement;
  private theme: Theme;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private ui = 1;
  private safe: SafeRect = { x: 0, y: 0, w: 1, h: 1 };
  private view: ViewMode = "3d";
  private viewT = 1;
  private viewFrom = 1;
  private viewSwitchAt = -1e9;
  private morph = 0;
  private lastNow = 0;
  private aggregate = false;
  /** What pointer drags have turned, in both views (see `orbit.ts`). */
  private turn: Turn = START_TURN;
  private zoomFactor = 1;
  private frame: Frame = START_FRAME;
  /** The nodes both views must show, and how far back the flat camera stands to show them. */
  private keyPoints: FramePoint[] = [];
  private flat: FlatFit = { reach: 2.5, maxZoom: MAX_ZOOM };
  private random = 0x51f2a9;

  private readonly uMorph = { value: 0 };
  private readonly uRes = { value: new THREE.Vector2(1, 1) };
  private readonly uTime = { value: 0 };
  private readonly uDpr = { value: 1 };
  private readonly uFocus = { value: new THREE.Vector3(0, 0, 0) };
  /** 1 in either view, 0 halfway through a view switch: flows and labels dip out while the land morphs. */
  private readonly uFade = { value: 1 };
  /** 1 on a light theme. */
  private readonly uLight = { value: 0 };
  /** Materials that glow additively on a dark ground and blend normally on a light one. */
  private readonly blended: THREE.Material[] = [];

  private readonly surface: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly air: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly tethers: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly nodeGroup = new THREE.Group();

  private readonly arcGeometry: THREE.InstancedBufferGeometry;
  private readonly arcBuffers: Record<"iA" | "iB" | "iAF" | "iBF" | "iShape" | "iColA" | "iColB" | "iLevel", THREE.InstancedBufferAttribute>;
  private readonly cometGeometry: THREE.InstancedBufferGeometry;
  private readonly cometBuffers: Record<"iA" | "iB" | "iAF" | "iBF" | "iShape" | "iHead" | "iCol", THREE.InstancedBufferAttribute>;
  private readonly headGeometry: THREE.BufferGeometry;
  private readonly headBuffers: Record<"position" | "aCol" | "aGlow", THREE.BufferAttribute>;

  private nodes = new Map<string, SNode>();
  private arcs = new Map<string, SArc>();
  private arcList: SArc[] = [];
  private comets: Comet[] = [];
  private pulses: Pulse[] = [];
  private readonly pulsePool: Array<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>> = [];
  /** Rings that mark the node under the pointer and the selected node. */
  private readonly focusRings: Array<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>> = [];
  private hoverId: string | null = null;
  private selectedId: string | null = null;
  /** Called when the pointer enters or leaves a site label, and when a site label is clicked. */
  onLabel: ((id: string, event: "enter" | "leave" | "click") => void) | null = null;

  private readonly dotMap: THREE.CanvasTexture;
  private readonly ringMap: THREE.CanvasTexture;
  private readonly planeGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly colors: Record<Tone | "gateway", THREE.Color> = {
    in: new THREE.Color(),
    out: new THREE.Color(),
    ok: new THREE.Color(),
    err: new THREE.Color(),
    gone: new THREE.Color(),
    gateway: new THREE.Color(),
  };
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly camGlobe = new THREE.Vector3();
  private readonly camFlat = new THREE.Vector3();
  private readonly camTarget = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, overlay: HTMLElement, theme: Theme) {
    this.overlay = overlay;
    this.theme = theme;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.sortObjects = true;

    this.leads = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.leads.setAttribute("class", "scene-leads");
    overlay.appendChild(this.leads);

    // A disc with a clean edge: site markers are plain dots and rings, not glows.
    this.dotMap = texture(128, (ctx, s) => {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s * 0.46, 0, Math.PI * 2);
      ctx.fill();
    });
    this.ringMap = texture(256, (ctx, s) => {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = s * 0.042;
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s * 0.45, 0, Math.PI * 2);
      ctx.stroke();
    });

    this.air = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 1 } },
        vertexShader: AIR_VERTEX,
        fragmentShader: AIR_FRAGMENT,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.air.renderOrder = -5;
    this.scene.add(this.air);

    const surfaceGeometry = this.buildSurface();
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    this.surface = new THREE.Mesh(
      surfaceGeometry,
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: blank },
          uOcean: { value: new THREE.Color() },
          uLand: { value: new THREE.Color() },
          uCoast: { value: new THREE.Color() },
          uRim: { value: new THREE.Color() },
          uFocus: this.uFocus,
          uMorph: this.uMorph,
          uLight: this.uLight,
          uShade: { value: 0 },
          // Half the width of the map's mesh, and the width over which it fades out before it ends
          // (world units).
          uEnds: { value: new THREE.Vector2((180 + MESH_EXTRA) * DEG * FLAT_S, END_FADE * DEG * FLAT_S) },
        },
        vertexShader: SURFACE_VERTEX,
        fragmentShader: SURFACE_FRAGMENT,
      }),
    );
    this.surface.frustumCulled = false;
    this.scene.add(this.surface);

    this.tethers = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false }));
    this.tethers.frustumCulled = false;
    this.tethers.renderOrder = 3;
    this.scene.add(this.tethers);
    this.scene.add(this.nodeGroup);

    // Arcs and comets: one instanced ribbon each.
    const strip = (segments: number) => {
      const t = new Float32Array((segments + 1) * 2);
      const side = new Float32Array((segments + 1) * 2);
      const index: number[] = [];
      for (let i = 0; i <= segments; i++) {
        t[i * 2] = t[i * 2 + 1] = i / segments;
        side[i * 2] = -1;
        side[i * 2 + 1] = 1;
        if (i < segments) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setAttribute("aT", new THREE.BufferAttribute(t, 1));
      geometry.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
      geometry.setIndex(index);
      geometry.instanceCount = 0;
      return geometry;
    };
    const instanced = (geometry: THREE.InstancedBufferGeometry, name: string, size: number, count: number) => {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
      return attribute;
    };
    this.arcGeometry = strip(ARC_SEGMENTS);
    this.arcBuffers = {
      iA: instanced(this.arcGeometry, "iA", 3, MAX_ARCS),
      iB: instanced(this.arcGeometry, "iB", 3, MAX_ARCS),
      iAF: instanced(this.arcGeometry, "iAF", 3, MAX_ARCS),
      iBF: instanced(this.arcGeometry, "iBF", 3, MAX_ARCS),
      iShape: instanced(this.arcGeometry, "iShape", 4, MAX_ARCS),
      iColA: instanced(this.arcGeometry, "iColA", 3, MAX_ARCS),
      iColB: instanced(this.arcGeometry, "iColB", 3, MAX_ARCS),
      iLevel: instanced(this.arcGeometry, "iLevel", 4, MAX_ARCS),
    };
    const ribbonMaterial = (vertexShader: string, fragmentShader: string) =>
      new THREE.ShaderMaterial({
        uniforms: { uMorph: this.uMorph, uRes: this.uRes, uTime: this.uTime, uFade: this.uFade, uLight: this.uLight },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
    const arcMesh = new THREE.Mesh(this.arcGeometry, ribbonMaterial(ARC_VERTEX, ARC_FRAGMENT));
    arcMesh.frustumCulled = false;
    arcMesh.renderOrder = 5;
    this.scene.add(arcMesh);

    this.cometGeometry = strip(COMET_SEGMENTS);
    this.cometBuffers = {
      iA: instanced(this.cometGeometry, "iA", 3, MAX_COMETS),
      iB: instanced(this.cometGeometry, "iB", 3, MAX_COMETS),
      iAF: instanced(this.cometGeometry, "iAF", 3, MAX_COMETS),
      iBF: instanced(this.cometGeometry, "iBF", 3, MAX_COMETS),
      iShape: instanced(this.cometGeometry, "iShape", 4, MAX_COMETS),
      iHead: instanced(this.cometGeometry, "iHead", 4, MAX_COMETS),
      iCol: instanced(this.cometGeometry, "iCol", 3, MAX_COMETS),
    };
    const cometMesh = new THREE.Mesh(this.cometGeometry, ribbonMaterial(COMET_VERTEX, COMET_FRAGMENT));
    cometMesh.frustumCulled = false;
    cometMesh.renderOrder = 7;
    this.scene.add(cometMesh);

    this.headGeometry = new THREE.BufferGeometry();
    const dynamic = (name: string, size: number) => {
      const attribute = new THREE.BufferAttribute(new Float32Array(MAX_COMETS * size), size);
      attribute.setUsage(THREE.DynamicDrawUsage);
      this.headGeometry.setAttribute(name, attribute);
      return attribute;
    };
    this.headBuffers = { position: dynamic("position", 3), aCol: dynamic("aCol", 3), aGlow: dynamic("aGlow", 2) };
    this.headGeometry.setDrawRange(0, 0);
    const heads = new THREE.Points(
      this.headGeometry,
      new THREE.ShaderMaterial({
        uniforms: { uDpr: this.uDpr, uLight: this.uLight },
        vertexShader: HEAD_VERTEX,
        fragmentShader: HEAD_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    heads.frustumCulled = false;
    heads.renderOrder = 8;
    this.scene.add(heads);

    for (let i = 0; i < 56; i++) {
      const mesh = new THREE.Mesh(this.planeGeometry, new THREE.MeshBasicMaterial({ map: this.ringMap, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      mesh.visible = false;
      mesh.renderOrder = 4;
      this.scene.add(mesh);
      this.pulsePool.push(mesh);
    }

    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(this.planeGeometry, new THREE.MeshBasicMaterial({ map: this.ringMap, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
      mesh.visible = false;
      mesh.renderOrder = 10;
      this.scene.add(mesh);
      this.focusRings.push(mesh);
    }

    this.blended.push(this.air.material, arcMesh.material, cometMesh.material, heads.material, ...this.pulsePool.map((mesh) => mesh.material));
    this.setTheme(theme);
  }

  dispose() {
    this.renderer.dispose();
    this.overlay.replaceChildren();
  }

  private rand(): number {
    this.random = (Math.imul(this.random, 1664525) + 1013904223) >>> 0;
    return this.random / 4294967296;
  }

  // ------------------------------------------------------------------ setup

  setTheme(theme: Theme) {
    this.theme = theme;
    const s = theme.scene;
    this.renderer.setClearColor(s.bg, 1);
    this.colors.in.setHex(s.in);
    this.colors.out.setHex(s.out);
    this.colors.ok.setHex(s.ok);
    this.colors.err.setHex(s.err);
    this.colors.gone.setHex(s.gone);
    this.colors.gateway.setHex(s.gateway);
    const surface = this.surface.material.uniforms;
    (surface.uOcean!.value as THREE.Color).setHex(s.ocean);
    (surface.uLand!.value as THREE.Color).setHex(s.land);
    (surface.uCoast!.value as THREE.Color).setHex(s.coast);
    (surface.uRim!.value as THREE.Color).setHex(s.rim);
    (this.air.material.uniforms.uColor!.value as THREE.Color).setHex(s.atmosphere);
    this.tethers.material.color.setHex(s.coast);
    const light = theme.light === true;
    this.uLight.value = light ? 1 : 0;
    surface.uShade!.value = light ? 0.22 : 0;
    this.applyBlending();
  }

  private applyBlending() {
    const blending = this.theme.light ? THREE.NormalBlending : THREE.AdditiveBlending;
    const set = (material: THREE.Material) => {
      if (material.blending === blending) return;
      material.blending = blending;
      material.needsUpdate = true;
    };
    for (const material of this.blended) set(material);
  }

  setLand(land: LandPolygons) {
    const size = this.renderer.capabilities.maxTextureSize >= 4096 ? 4096 : 2048;
    const map = new THREE.CanvasTexture(paintLand(land, size, size / 2));
    map.wrapS = THREE.RepeatWrapping;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    (this.surface.material.uniforms.uMap!.value as THREE.Texture).dispose();
    this.surface.material.uniforms.uMap!.value = map;
  }

  private flatPoint(lon: number, lat: number, out: THREE.Vector3, y = 0): THREE.Vector3 {
    const clamped = Math.max(-80, Math.min(84, lat));
    return out.set(wrapLon(lon - this.frame.lon) * DEG * FLAT_S, y, -(millerY(clamped) - millerY(this.frame.lat)) * FLAT_S);
  }

  /**
   * The Earth's surface: a lon / lat grid with a place on the globe and a place on the map per
   * vertex. It reaches past the map's east and west edges, so the flat map continues there
   * instead of ending in a straight cut; on the globe those columns lie on top of others.
   */
  private buildSurface(): THREE.BufferGeometry {
    const EXTRA = MESH_EXTRA;
    const STEP = 1.5;
    const cols = Math.round((360 + 2 * EXTRA) / STEP);
    const rows = Math.round(180 / STEP);
    const globe = new Float32Array((cols + 1) * (rows + 1) * 3);
    const flat = new Float32Array((cols + 1) * (rows + 1) * 3);
    const uv = new Float32Array((cols + 1) * (rows + 1) * 2);
    const index: number[] = [];
    const point = new THREE.Vector3();
    const v0 = millerY(this.frame.lat);
    for (let j = 0; j <= rows; j++) {
      const lat = -90 + j * STEP;
      const z = -(millerY(Math.max(-80, Math.min(84, lat))) - v0) * FLAT_S;
      for (let i = 0; i <= cols; i++) {
        const lon = this.frame.lon - 180 - EXTRA + i * STEP;
        const k = j * (cols + 1) + i;
        globePoint(lon, lat, point, 0.999);
        globe.set([point.x, point.y, point.z], k * 3);
        flat.set([(lon - this.frame.lon) * DEG * FLAT_S, 0, z], k * 3);
        uv.set([(lon + 180) / 360, (lat + 90) / 180], k * 2);
        if (i < cols && j < rows) index.push(k, k + 1, k + cols + 2, k, k + cols + 2, k + cols + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(globe, 3));
    geometry.setAttribute("aFlat", new THREE.BufferAttribute(flat, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(index);
    return geometry;
  }

  setNodes(defs: MapNode[]) {
    // The views are framed on the gateway, the upstream sites, and the 12 first user regions:
    // outlying regions further down the list do not pull the view away.
    this.keyPoints = [...defs.filter((def) => def.kind !== "origin"), ...defs.filter((def) => def.kind === "origin").slice(0, 12)].map((def) => ({ lon: def.lon, lat: def.lat, kind: def.kind }));
    const frame = frameFor(this.keyPoints);
    const moved = frame.lon !== this.frame.lon || frame.lat !== this.frame.lat;
    this.frame = frame;
    if (moved) {
      this.surface.geometry.dispose();
      this.surface.geometry = this.buildSurface();
    }
    this.refit();

    this.nodeGroup.clear();
    for (const node of this.nodes.values()) node.label?.el.remove();
    this.leads.replaceChildren();
    const next = new Map<string, SNode>();
    for (const def of defs) {
      const old = this.nodes.get(def.id);
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotMap, depthWrite: false, depthTest: false, transparent: true }));
      dot.renderOrder = 9;
      let ring: SNode["ring"] = null;
      if (def.kind !== "origin") {
        ring = new THREE.Mesh(this.planeGeometry, new THREE.MeshBasicMaterial({ map: this.ringMap, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
        ring.renderOrder = 4;
        this.nodeGroup.add(ring);
      }
      this.nodeGroup.add(dot);
      const trueG = globePoint(def.lon, def.lat, new THREE.Vector3(), SURFACE);
      const node: SNode = {
        def,
        lon: def.lon,
        lat: def.lat,
        g: trueG.clone(),
        f: this.flatPoint(def.lon, def.lat, new THREE.Vector3(), 0.004),
        n: trueG.clone().normalize(),
        trueG,
        trueF: this.flatPoint(def.lon, def.lat, new THREE.Vector3(), 0.004),
        pos: new THREE.Vector3(),
        up: new THREE.Vector3(0, 1, 0),
        facing: 1,
        sx: 0,
        sy: 0,
        activity: old?.activity ?? 0,
        value: old?.value ?? 0,
        valueTarget: old?.valueTarget ?? 0,
        health: old ? old.health : 1,
        inflight: old?.inflight ?? 0,
        sub: old?.sub ?? def.sub ?? "",
        colo: false,
        tags: [],
        dot,
        ring,
        label: null,
      };
      node.label = this.makeLabel(node);
      next.set(def.id, node);
    }
    this.nodes = next;
    this.arcs.clear();
    this.arcList = [];
    this.comets = [];
    this.pulses = [];
    this.declutter();
  }

  resize(width: number, height: number, dpr: number, safe: SafeRect, ui: number) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.ui = ui;
    this.safe = safe;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.uRes.value.set(width * dpr, height * dpr);
    this.uDpr.value = dpr * ui;
    this.camera.aspect = width / height;
    this.leads.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.refit();
  }

  private refit() {
    if (this.width <= 0 || this.height <= 0 || this.safe.w <= 0) return;
    this.flat = fitFlat(this.frame, this.keyPoints, { width: this.width, height: this.height, safe: this.safe, ui: this.ui }, 360 + 2 * MESH_EXTRA);
  }

  setView(view: ViewMode, now: number) {
    if (view === this.view) return;
    this.viewFrom = this.viewT;
    this.view = view;
    this.viewSwitchAt = now;
  }

  snapView(view: ViewMode) {
    this.view = view;
    this.viewT = view === "3d" ? 1 : 0;
    this.viewFrom = this.viewT;
    this.viewSwitchAt = -1e9;
  }

  /**
   * Pointer drag in CSS pixels: turns the globe, or swings the camera over the flat map. Either
   * goes all the way round; the tilt is limited (OS-M2c).
   */
  orbit(dx: number, dy: number) {
    this.turn = this.view === "3d" ? turnGlobe(this.turn, dx, dy, this.frame.camLat) : swingFlat(this.turn, dx, dy);
  }

  /** What drags have turned (read by the browser checks). */
  getTurn(): Turn {
    return this.turn;
  }

  zoom(delta: number) {
    // The flat map does not zoom out past the width of its mesh.
    const max = this.view === "2d" ? Math.min(MAX_ZOOM, this.flat.maxZoom) : MAX_ZOOM;
    this.zoomFactor = Math.max(0.6, Math.min(max, this.zoomFactor * Math.exp(delta * 0.0012)));
  }

  /** The node under a point of the canvas (CSS pixels), or null. The nearest node within reach wins. */
  pick(x: number, y: number): string | null {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const node of this.nodes.values()) {
      if (node.colo || node.facing < 0.3) continue;
      // The reach is larger than the dot: a small target must not need a precise pointer.
      const reach = (node.def.kind === "origin" ? 13 : 20) * Math.max(1, this.ui);
      const distance = Math.hypot(node.sx - x, node.sy - y);
      if (distance <= reach && distance < bestDistance) {
        best = node.def.id;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Where a node is on the canvas now (CSS pixels), and whether it faces the viewer. */
  screenOf(id: string): { x: number; y: number; visible: boolean } | null {
    const node = this.nodes.get(id);
    return node ? { x: node.sx, y: node.sy, visible: node.facing > 0.05 } : null;
  }

  /** Marks the node under the pointer and the selected node; both keep their label visible. */
  setFocus(hoverId: string | null, selectedId: string | null) {
    this.hoverId = hoverId;
    this.selectedId = selectedId;
    for (const node of this.nodes.values()) {
      if (node.def.kind !== "origin" && node.label) node.label.el.classList.toggle("is-selected", node.def.id === selectedId);
    }
  }

  setAggregateMode(on: boolean) {
    if (this.aggregate === on) return;
    this.aggregate = on;
    for (const arc of this.arcList) {
      arc.weightTarget = 0;
      arc.hold = 0;
    }
    for (const node of this.nodes.values()) {
      node.inflight = 0;
      node.tags = [];
    }
    if (on) this.comets = [];
  }

  setAggregate(flows: AggregateFlow[]) {
    for (const arc of this.arcList) arc.weightTarget = 0;
    for (const flow of flows) {
      const arc = this.arc(flow.from, flow.to, flow.kind);
      if (!arc) continue;
      arc.weightTarget = flow.weight;
      arc.errShare = flow.errShare;
    }
  }

  setNodeMeta(id: string, meta: NodeMeta) {
    const node = this.nodes.get(id);
    if (!node) return;
    if (meta.value !== undefined) node.valueTarget = meta.value;
    if (meta.health !== undefined) node.health = meta.health;
    if (meta.sub !== undefined && meta.sub !== node.sub) {
      node.sub = meta.sub;
      if (node.label?.sub) {
        node.label.sub.textContent = meta.sub;
        node.label.dirty = true;
      }
    }
  }

  comet(from: string, to: string, kind: ArcKind, tone: Tone, now: number, durMs: number, reverse = false, size = 1): number {
    const arc = this.arc(from, to, kind);
    if (!arc) return now;
    arc.recent = 1;
    if (this.comets.length < MAX_COMETS) this.comets.push({ arc, t0: now, dur: durMs, tone, reverse, size });
    return now + durMs;
  }

  hold(from: string, to: string, kind: ArcKind, delta: number) {
    const arc = this.arc(from, to, kind);
    if (!arc) return;
    arc.hold = Math.max(0, arc.hold + delta);
    if (delta > 0) arc.recent = 1;
  }

  inflight(id: string, delta: number) {
    const node = this.nodes.get(id);
    if (node) node.inflight = Math.max(0, node.inflight + delta);
  }

  pulse(id: string, tone: Tone, now: number, size = 1) {
    const node = this.nodes.get(id);
    if (!node) return;
    this.pulses.push({ node, t0: now, tone, size });
    if (this.pulses.length > this.pulsePool.length) this.pulses.shift();
    node.activity = Math.min(1.6, node.activity + 0.55);
  }

  tag(id: string, text: string, tone: Tone, now: number) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.tags.unshift({ t0: now, tone, text });
    if (node.tags.length > 2) node.tags.length = 2;
  }

  // ------------------------------------------------------------------ layout

  /**
   * Moves upstream sites apart from the gateway, from each other and from user regions, in
   * degrees, so that co-located sites stay readable. A tether marks the real position.
   */
  private declutter() {
    const gateway = [...this.nodes.values()].find((n) => n.def.kind === "gateway");
    for (const node of this.nodes.values()) {
      if (node.def.kind !== "upstream" || !gateway) continue;
      node.colo = Math.hypot(wrapLon(node.def.lon - gateway.def.lon) * Math.cos(node.def.lat * DEG), node.def.lat - gateway.def.lat) < 1.5;
      if (node.colo) {
        node.lon = gateway.def.lon;
        node.lat = gateway.def.lat;
        node.g.copy(gateway.g);
        node.f.copy(gateway.f);
        node.n.copy(gateway.n);
        if (node.label?.title) node.label.title.textContent = "同机房上游";
        if (node.label) node.label.dirty = true;
      }
    }
    const movable = [...this.nodes.values()].filter((n) => n.def.kind === "upstream" && !n.colo);
    const fixed = [...this.nodes.values()].filter((n) => n.def.kind !== "upstream");
    const pos = movable.map((n, i) => ({ lon: n.def.lon + 0.02 * (i + 1), lat: n.def.lat - 0.01 * (i + 1) }));
    for (let iter = 0; iter < 90; iter++) {
      for (let i = 0; i < movable.length; i++) {
        const p = pos[i]!;
        let fx = wrapLon(movable[i]!.def.lon - p.lon) * 0.03;
        let fy = (movable[i]!.def.lat - p.lat) * 0.03;
        const push = (lon: number, lat: number, sep: number) => {
          let dx = wrapLon(p.lon - lon) * Math.cos(p.lat * DEG);
          let dy = p.lat - lat;
          let d = Math.hypot(dx, dy);
          if (d >= sep) return;
          if (d < 0.05) {
            // Coincident sites leave toward the east and south: inland for the US West coast,
            // open sea for East Asia, away from where the request arcs arrive.
            const angle = (-0.2 - 0.55 * i) * Math.PI * 0.5;
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            d = 1;
          }
          const f = ((sep - d) / sep) * sep * 0.5;
          fx += ((dx / d) * f) / Math.max(0.3, Math.cos(p.lat * DEG));
          fy += (dy / d) * f;
        };
        for (const other of fixed) push(other.def.lon, other.def.lat, other.def.kind === "gateway" ? 7.5 : 3.2);
        for (let j = 0; j < movable.length; j++) if (j !== i) push(pos[j]!.lon, pos[j]!.lat, 6.5);
        p.lon += fx;
        p.lat = Math.max(-60, Math.min(75, p.lat + fy));
      }
    }
    const segments: Array<[SNode, boolean]> = [];
    movable.forEach((node, i) => {
      node.lon = pos[i]!.lon;
      node.lat = pos[i]!.lat;
      globePoint(node.lon, node.lat, node.g, SURFACE);
      this.flatPoint(node.lon, node.lat, node.f, 0.004);
      node.n.copy(node.g).normalize();
      const moved = Math.hypot(wrapLon(node.lon - node.def.lon), node.lat - node.def.lat) > 0.8;
      segments.push([node, moved]);
    });
    const count = segments.filter((s) => s[1]).length;
    this.tethers.geometry.dispose();
    this.tethers.geometry = new THREE.BufferGeometry();
    this.tethers.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    this.tethers.userData.nodes = segments.filter((s) => s[1]).map((s) => s[0]);
    for (const arc of this.arcList) this.writeArcEnds(arc);
  }

  private arc(from: string, to: string, kind: ArcKind): SArc | null {
    const key = `${kind}:${from}>${to}`;
    const found = this.arcs.get(key);
    if (found) return found;
    const a = this.nodes.get(from);
    const b = this.nodes.get(to);
    if (!a || !b || this.arcList.length >= MAX_ARCS) return null;
    const arc: SArc = {
      key,
      slot: this.arcList.length,
      from: a,
      to: b,
      kind,
      liftG: 0,
      liftF: 0,
      omega: 0,
      hold: 0,
      heat: 0,
      recent: 0,
      weight: 0,
      weightTarget: 0,
      errShare: 0,
      emit: hash(key),
      seed: hash(key + "#"),
    };
    this.arcs.set(key, arc);
    this.arcList.push(arc);
    this.writeArcEnds(arc);
    return arc;
  }

  private writeArcEnds(arc: SArc) {
    const a = arc.from;
    const b = arc.to;
    arc.omega = Math.acos(Math.max(-1, Math.min(1, a.n.dot(b.n))));
    // Requests fly high; dispatch stays lower, so the two directions read as two layers.
    arc.liftG = Math.max(0.03, Math.min(0.36, arc.omega * (arc.kind === "in" ? 0.24 : 0.11)));
    const flat = a.f.distanceTo(b.f);
    arc.liftF = Math.max(0.03, Math.min(0.6, flat * (arc.kind === "in" ? 0.34 : 0.16)));
    const i = arc.slot;
    this.arcBuffers.iA.setXYZ(i, a.g.x, a.g.y, a.g.z);
    this.arcBuffers.iB.setXYZ(i, b.g.x, b.g.y, b.g.z);
    this.arcBuffers.iAF.setXYZ(i, a.f.x, a.f.y, a.f.z);
    this.arcBuffers.iBF.setXYZ(i, b.f.x, b.f.y, b.f.z);
    this.arcBuffers.iShape.setXYZW(i, arc.liftG, arc.liftF, 2, 0);
    for (const name of ["iA", "iB", "iAF", "iBF", "iShape"] as const) this.arcBuffers[name].needsUpdate = true;
  }

  /** The same curve as the vertex shader, for comet heads. */
  private curvePoint(arc: SArc, t: number, out: THREE.Vector3): THREE.Vector3 {
    const a = arc.from.g;
    const b = arc.to.g;
    const lift = Math.sin(Math.PI * t);
    if (arc.omega < 0.002) out.copy(a).lerp(b, t);
    else {
      const s = Math.sin(arc.omega);
      const ka = Math.sin((1 - t) * arc.omega) / s;
      const kb = Math.sin(t * arc.omega) / s;
      out.set(ka * a.x + kb * b.x, ka * a.y + kb * b.y, ka * a.z + kb * b.z);
    }
    out.multiplyScalar(1 + arc.liftG * lift);
    if (this.morph > 0) {
      const f = this.tmpC.copy(arc.from.f).lerp(arc.to.f, t);
      f.y += arc.liftF * lift;
      out.lerp(f, this.morph);
    }
    return out;
  }

  // ------------------------------------------------------------------ labels

  private makeLabel(node: SNode): Label {
    const el = document.createElement("div");
    const label: Label = { el, title: null, sub: null, tagEls: [], line: null, w: 0, h: 0, dirty: true, x: 0, y: 0, shown: 0, text: node.def.name };
    if (node.def.kind === "origin") {
      el.className = "lb lb-origin";
      el.textContent = node.def.name;
    } else {
      el.className = `lb lb-major ${node.def.kind === "gateway" ? "lb-gw" : "lb-up"}`;
      const head = document.createElement("div");
      head.className = "lb-head";
      const mark = document.createElement("i");
      mark.className = "lb-mark";
      const title = document.createElement("b");
      title.textContent = node.def.kind === "gateway" ? `网关 · ${node.def.name}` : node.def.name;
      const sub = document.createElement("span");
      sub.className = "lb-sub";
      sub.textContent = node.sub;
      head.append(mark, title, sub);
      head.addEventListener("pointerenter", () => this.onLabel?.(node.def.id, "enter"));
      head.addEventListener("pointerleave", () => this.onLabel?.(node.def.id, "leave"));
      head.addEventListener("click", () => this.onLabel?.(node.def.id, "click"));
      el.append(head);
      label.title = title;
      label.sub = sub;
      if (node.def.kind === "upstream") {
        for (let i = 0; i < 2; i++) {
          const tag = document.createElement("div");
          tag.className = "lb-tag";
          el.append(tag);
          label.tagEls.push(tag);
        }
      }
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      this.leads.appendChild(line);
      label.line = line;
    }
    el.style.opacity = "0";
    this.overlay.appendChild(el);
    return label;
  }

  private layoutLabels(now: number) {
    const u = this.ui;
    const placed: Array<[number, number, number, number]> = [];
    const free = (x: number, y: number, w: number, h: number) => {
      for (const b of placed) if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false;
      return true;
    };
    const majors = [...this.nodes.values()].filter((n) => n.def.kind !== "origin");
    for (const node of majors) {
      const label = node.label!;
      if (label.dirty) {
        const head = label.el.firstElementChild as HTMLElement;
        label.w = head.offsetWidth;
        label.h = head.offsetHeight;
        label.dirty = false;
      }
    }
    // Wanted place: beside the node, east when it fits. Then stacked so that no two overlap.
    const wants = majors
      .filter((n) => n.facing > 0.04)
      .map((node) => {
        const label = node.label!;
        if (node.def.kind === "gateway") {
          const x = Math.max(this.safe.x, Math.min(this.safe.x + this.safe.w + 10 * u - label.w, node.sx - label.w / 2));
          return { node, x, y: node.sy - 78 * u - label.h, west: false, fixed: true };
        }
        const east = node.sx + 30 * u + label.w <= this.safe.x + this.safe.w + 10 * u;
        return { node, x: east ? node.sx + 30 * u : node.sx - 30 * u - label.w, y: node.sy - label.h / 2, west: !east, fixed: false };
      })
      .sort((a, b) => Number(b.fixed) - Number(a.fixed) || a.y - b.y);
    const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const want of wants) {
      const label = want.node.label!;
      // Two lines of dispatch text hang under an upstream label.
      const h = label.h + (want.node.def.kind === "upstream" ? 34 * u : 0);
      let y = want.y;
      for (let guard = 0; guard < 12; guard++) {
        const hit = boxes.find((b) => want.x < b.x + b.w + 8 * u && want.x + label.w + 8 * u > b.x && y < b.y + b.h + 6 * u && y + h + 6 * u > b.y);
        if (!hit) break;
        y = hit.y + hit.h + 7 * u;
      }
      boxes.push({ x: want.x, y, w: label.w, h });
      placed.push([want.x, y, label.w, h]);
      const k = label.shown < 0.05 ? 1 : 0.22;
      label.x += (want.x - label.x) * k;
      label.y += (y - label.y) * k;
    }
    for (const node of majors) {
      const label = node.label!;
      const target = node.facing > 0.04 ? Math.min(1, node.facing * 4) : 0;
      label.shown = target;
      label.el.style.opacity = target.toFixed(3);
      if (target <= 0) {
        label.line?.setAttribute("d", "");
        continue;
      }
      label.el.style.transform = `translate3d(${label.x.toFixed(1)}px,${label.y.toFixed(1)}px,0)`;
      const tone = node.def.kind === "gateway" ? "in" : siteTone(node.health);
      if (label.el.dataset.tone !== tone) label.el.dataset.tone = tone;
      if (label.line) {
        const midY = label.y + label.h / 2;
        const west = label.x + label.w < node.sx;
        const edge = node.def.kind === "gateway" ? node.sx : west ? label.x + label.w + 4 * u : label.x - 4 * u;
        const d =
          node.def.kind === "gateway"
            ? `M${node.sx.toFixed(1)} ${(node.sy - 22 * u).toFixed(1)}L${node.sx.toFixed(1)} ${(label.y + label.h + 4 * u).toFixed(1)}`
            : `M${(node.sx + (west ? -9 : 9) * u).toFixed(1)} ${node.sy.toFixed(1)}L${(node.sx + (west ? -18 : 18) * u).toFixed(1)} ${midY.toFixed(1)}L${edge.toFixed(1)} ${midY.toFixed(1)}`;
        label.line.setAttribute("d", d);
        label.line.style.opacity = (target * 0.7).toFixed(3);
      }
      node.tags = node.tags.filter((tag) => now - tag.t0 < 3400);
      label.tagEls.forEach((el, i) => {
        const tag = node.tags[i];
        if (!tag) {
          if (el.style.opacity !== "0") el.style.opacity = "0";
          return;
        }
        const age = (now - tag.t0) / 3400;
        if (el.textContent !== tag.text) el.textContent = tag.text;
        if (el.dataset.tone !== tag.tone) el.dataset.tone = tag.tone;
        el.style.opacity = (Math.min(1, age * 14) * (1 - age) ** 1.3).toFixed(3);
      });
      placed.push([node.sx - 16 * u, node.sy - 16 * u, 32 * u, 32 * u]);
    }

    const origins = [...this.nodes.values()].filter((n) => n.def.kind === "origin");
    const focused = (node: SNode) => node.def.id === this.hoverId || node.def.id === this.selectedId;
    origins.sort((a, b) => Number(focused(b)) - Number(focused(a)) || b.activity + b.value * 1.4 - (a.activity + a.value * 1.4));
    let shown = 0;
    for (const node of origins) {
      const label = node.label!;
      const strength = (focused(node) ? 1 : Math.min(1, node.activity * 1.3 + node.value * 1.5)) * Math.min(1, node.facing * 4);
      let visible = false;
      if (strength > 0.14 && (shown < 14 || focused(node))) {
        if (label.dirty) {
          label.w = label.el.offsetWidth;
          label.h = label.el.offsetHeight;
          label.dirty = false;
        }
        const options: Array<[number, number]> = [
          [node.sx - 9 * u - label.w, node.sy - label.h / 2],
          [node.sx + 9 * u, node.sy - label.h / 2],
          [node.sx - label.w / 2, node.sy - 10 * u - label.h],
          [node.sx - label.w / 2, node.sy + 10 * u],
        ];
        // A focused label takes its first place even where another label is.
        const spot = options.find((o) => o[0] >= this.safe.x - 6 * u && o[0] + label.w <= this.safe.x + this.safe.w + 6 * u && free(o[0], o[1], label.w, label.h)) ?? (focused(node) ? options[1] : undefined);
        if (spot) {
          placed.push([spot[0], spot[1], label.w, label.h]);
          label.el.style.transform = `translate3d(${spot[0].toFixed(1)}px,${spot[1].toFixed(1)}px,0)`;
          label.el.style.opacity = (0.35 + 0.65 * strength).toFixed(3);
          label.el.classList.toggle("is-focus", focused(node));
          visible = true;
          shown++;
        }
      }
      if (!visible && label.el.style.opacity !== "0") label.el.style.opacity = "0";
    }
  }

  // ------------------------------------------------------------------ frame

  draw(now: number) {
    const dt = Math.max(0, Math.min(120, now - this.lastNow));
    this.lastNow = now;
    const u = this.ui;
    const px = this.dpr * u;

    const target = this.view === "3d" ? 1 : 0;
    this.viewT = this.viewFrom + (target - this.viewFrom) * Math.min(1, (now - this.viewSwitchAt) / MORPH_MS);
    // morph: 0 = globe, 1 = flat map.
    const m = 1 - easeInOut(this.viewT);
    this.morph = m;
    this.uMorph.value = m;
    this.uTime.value = now / 1000;
    const fade = (2 * m - 1) ** 2;
    this.uFade.value = fade;

    // Camera: orbit around the globe, or look down at the map from the south.
    const safe = this.safe;
    // The globe is larger than the scene area and sits low: the timeline covers its south.
    const radiusPx = Math.min(safe.h * 0.61, safe.w * 0.53);
    const tanHalf = Math.tan((FOV * DEG) / 2);
    const zf = Math.min(this.zoomFactor, MAX_ZOOM + (Math.min(MAX_ZOOM, this.flat.maxZoom) - MAX_ZOOM) * m);
    const distance = (1 / Math.sin(Math.atan((radiusPx / (this.height / 2)) * tanHalf))) * zf;
    // The drag's turn, plus a slow drift; during a view switch the turn of the view being left
    // winds back, so the camera does not cross the scene when the far side was on screen.
    const turns = turnsAt(this.turn, m);
    globePoint(this.frame.camLon + turns.lon + Math.sin(now / 23000) * 7, globeLat(this.frame.camLat, this.turn.lat) + Math.sin(now / 31000) * 2.2, this.camGlobe, distance);
    const reach = this.flat.reach * zf;
    const yaw = (turns.yaw + Math.sin(now / 27000) * 5) * DEG;
    const pitch = this.turn.pitch * DEG;
    this.camTarget.set(0, 0, FLAT_TARGET_Z);
    this.camFlat.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(reach).add(this.camTarget);
    this.camera.position.copy(this.camGlobe).lerp(this.camFlat, m);
    this.camera.up.copy(UP);
    this.camera.lookAt(this.tmpA.set(0, 0, 0).lerp(this.camTarget, m));
    const cx = safe.x + safe.w / 2;
    const cy = safe.y + safe.h * (FLAT_CENTRE_Y + 0.01 * (1 - m));
    this.camera.setViewOffset(this.width, this.height, this.width / 2 - cx, this.height / 2 - cy, this.width, this.height);
    this.camera.updateMatrixWorld();
    this.uFocus.value.copy(this.camTarget);

    const globeShow = 1 - m;
    // Opaque on the globe (it hides what is behind the Earth); a clear sheet on the map.
    this.surface.material.transparent = m > 0.001;
    this.surface.material.depthWrite = m <= 0.001;
    this.air.material.uniforms.uOpacity!.value = globeShow * (this.theme.light ? 0.26 : 0.42);
    this.air.visible = globeShow > 0.01;
    // Nodes. Glyph sizes are multiplied by the zoom factor (the camera distance scales with it),
    // so markers keep their size on screen while the map under them zooms.
    const smooth = 1 - Math.exp(-dt / 260);
    const camPos = this.camera.position;
    for (const node of this.nodes.values()) {
      node.activity *= Math.exp(-dt / 2600);
      node.value += (node.valueTarget - node.value) * smooth;
      node.pos.copy(node.g).lerp(node.f, m);
      node.up.copy(node.n).lerp(UP, m).normalize();
      const facing = node.n.dot(this.tmpA.copy(camPos).sub(node.g).normalize());
      this.tmpA.copy(node.pos).project(this.camera);
      node.sx = (this.tmpA.x * 0.5 + 0.5) * this.width;
      node.sy = (-this.tmpA.y * 0.5 + 0.5) * this.height;
      // A point behind the camera (the flat camera turned toward the map's end) projects to a
      // mirrored place on the canvas: such a node is not shown and is no pointer target.
      const ahead = this.tmpA.z < 1;
      node.facing = ahead ? (Math.min(1, Math.max(0, (facing - 0.02) / 0.22)) * (1 - m) + m) * fade : 0;

      const kind = node.def.kind;
      const tone: Tone = kind === "upstream" ? siteTone(node.health) : "in";
      const color = this.colors[tone];
      const act = Math.min(1, node.activity);
      // A site is a dot; the gateway and upstream sites also carry a thin ring. Sizes follow volume.
      const dotSize = (kind === "gateway" ? 0.026 : kind === "upstream" ? 0.014 : 0.007 + 0.011 * Math.sqrt(node.value) + 0.004 * act) * zf;
      node.dot.visible = !node.colo;
      node.dot.position.copy(node.pos);
      node.dot.scale.setScalar(dotSize);
      node.dot.material.color.copy(kind === "gateway" ? this.colors.gateway : color);
      node.dot.material.opacity = node.facing * (kind === "origin" ? 0.6 + 0.4 * Math.min(1, act + node.value) : 1);
      if (node.ring) {
        node.ring.position.copy(node.pos).addScaledVector(node.up, 0.0015);
        node.ring.quaternion.setFromUnitVectors(FORWARD, node.up);
        node.ring.scale.setScalar((kind === "gateway" ? 0.06 : node.colo ? 0.1 : 0.042 + 0.018 * Math.sqrt(node.value)) * zf);
        node.ring.material.color.copy(color);
        node.ring.material.opacity = node.facing * (kind === "gateway" ? 0.7 : 0.9);
      }
    }

    // Focus rings: a neutral ring around the hovered node and a stronger one around the selected.
    [this.hoverId === this.selectedId ? null : this.hoverId, this.selectedId].forEach((id, i) => {
      const mesh = this.focusRings[i]!;
      const node = id ? this.nodes.get(id) : undefined;
      if (!node || node.facing < 0.05) {
        mesh.visible = false;
        return;
      }
      const size = node.def.kind === "origin" ? 0.03 + 0.012 * Math.sqrt(node.value) : node.def.kind === "gateway" ? 0.082 : node.colo ? 0.118 : 0.064 + 0.018 * Math.sqrt(node.value);
      mesh.visible = true;
      mesh.position.copy(node.pos).addScaledVector(node.up, 0.002);
      mesh.quaternion.setFromUnitVectors(FORWARD, node.up);
      mesh.scale.setScalar(size * zf);
      mesh.material.color.setHex(this.theme.light ? 0x171717 : 0xffffff);
      mesh.material.opacity = (i === 1 ? 0.95 : 0.6) * node.facing;
    });

    // Tethers of displaced upstream sites
    const tethered = (this.tethers.userData.nodes as SNode[] | undefined) ?? [];
    this.tethers.visible = tethered.length > 0;
    if (tethered.length > 0) {
      const attribute = this.tethers.geometry.getAttribute("position") as THREE.BufferAttribute;
      tethered.forEach((node, i) => {
        const from = this.tmpA.copy(node.trueG).lerp(node.trueF, m);
        attribute.setXYZ(i * 2, from.x, from.y, from.z);
        attribute.setXYZ(i * 2 + 1, node.pos.x, node.pos.y, node.pos.z);
      });
      attribute.needsUpdate = true;
    }

    // Pulses: rings that grow on the surface.
    this.pulses = this.pulses.filter((pulse) => now - pulse.t0 < 1100);
    this.pulsePool.forEach((mesh, i) => {
      const pulse = this.pulses[i];
      if (!pulse || now < pulse.t0) {
        mesh.visible = false;
        return;
      }
      const p = (now - pulse.t0) / 1100;
      const node = pulse.node;
      const base = node.def.kind === "origin" ? 0.016 : node.def.kind === "gateway" ? 0.06 : node.colo ? 0.1 : 0.045;
      mesh.visible = true;
      mesh.position.copy(node.pos).addScaledVector(node.up, 0.001);
      mesh.quaternion.setFromUnitVectors(FORWARD, node.up);
      mesh.scale.setScalar((base + 0.14 * p * pulse.size * (node.def.kind === "origin" ? 0.6 : 1)) * zf);
      mesh.material.color.copy(this.colors[pulse.tone]);
      mesh.material.opacity = 0.8 * (1 - p) ** 1.7 * node.facing;
    });

    // Arcs
    const level = this.arcBuffers.iLevel;
    const shape = this.arcBuffers.iShape;
    const colA = this.arcBuffers.iColA;
    const colB = this.arcBuffers.iColB;
    const mix = this.tmpA;
    for (const arc of this.arcList) {
      arc.heat += (arc.hold - arc.heat) * smooth;
      arc.weight += (arc.weightTarget - arc.weight) * (1 - Math.exp(-dt / 420));
      arc.recent *= Math.exp(-dt / 30000);
      const i = arc.slot;
      if (arc.from.colo || arc.to.colo) {
        level.setXYZW(i, 0, 0, 1, 0);
        continue;
      }
      const dashes = Math.max(2, Math.round(arc.omega * 9 + 1.5));
      const tone = arc.kind === "in" ? this.colors.in : this.colors.out;
      if (this.aggregate) {
        const w = Math.sqrt(arc.weight);
        const err = arc.kind === "out" ? Math.min(1, arc.errShare * 3.2) : 0;
        level.setXYZW(i, arc.weight > 0.002 ? 0.08 + 0.2 * w : 0.035, 0.55 * w, dashes, arc.seed);
        shape.setZ(i, (1.5 + 2.8 * w) * px);
        mix.set(tone.r, tone.g, tone.b).lerp(this.tmpB.set(this.colors.err.r, this.colors.err.g, this.colors.err.b), err);
        colA.setXYZ(i, mix.x, mix.y, mix.z);
        colB.setXYZ(i, mix.x, mix.y, mix.z);
        arc.emit += (dt / 1000) * (arc.kind === "in" ? 1.5 * arc.weight ** 0.75 : 2.6 * arc.weight ** 0.75);
        while (arc.emit >= 1) {
          arc.emit -= 1;
          if (this.comets.length >= MAX_COMETS - 40) break;
          const failed = arc.kind === "out" && this.rand() < arc.errShare;
          this.comets.push({ arc, t0: now - this.rand() * 120, dur: (arc.kind === "in" ? 1900 : 1400) * (0.85 + this.rand() * 0.4), tone: failed ? "err" : arc.kind === "in" ? "in" : "out", reverse: false, size: 0.75 + 0.35 * w });
        }
      } else {
        const h = arc.heat;
        level.setXYZW(i, 0.05 + 0.11 * Math.min(1, arc.recent) + Math.min(0.26, 0.05 * h), h > 0.02 ? Math.min(0.95, 0.42 + 0.1 * h) : 0, dashes, arc.seed);
        shape.setZ(i, (1.7 + 0.32 * Math.min(h, 8)) * px);
        colA.setXYZ(i, tone.r, tone.g, tone.b);
        colB.setXYZ(i, tone.r, tone.g, tone.b);
      }
    }
    level.needsUpdate = true;
    shape.needsUpdate = true;
    colA.needsUpdate = true;
    colB.needsUpdate = true;
    this.arcGeometry.instanceCount = this.arcList.length;

    // Comets
    const cb = this.cometBuffers;
    const hb = this.headBuffers;
    const keep: Comet[] = [];
    let count = 0;
    for (const comet of this.comets) {
      const raw = (now - comet.t0) / comet.dur;
      if (raw >= 1.14) continue;
      keep.push(comet);
      if (raw < 0 || count >= MAX_COMETS) continue;
      const arc = comet.arc;
      if (arc.from.colo || arc.to.colo) continue;
      const a = arc.from;
      const b = arc.to;
      const eased = raw >= 1 ? 1 : raw < 0.5 ? 2 * raw * raw : 1 - (-2 * raw + 2) ** 2 / 2;
      const fade = raw > 1 ? 1 - (raw - 1) / 0.14 : Math.min(1, raw * 9);
      const color = this.colors[comet.tone];
      cb.iA.setXYZ(count, a.g.x, a.g.y, a.g.z);
      cb.iB.setXYZ(count, b.g.x, b.g.y, b.g.z);
      cb.iAF.setXYZ(count, a.f.x, a.f.y, a.f.z);
      cb.iBF.setXYZ(count, b.f.x, b.f.y, b.f.z);
      cb.iShape.setXYZW(count, arc.liftG, arc.liftF, 2.8 * px * comet.size, 0);
      cb.iHead.setXYZW(count, eased, 0.24, fade, comet.reverse ? 1 : 0);
      cb.iCol.setXYZ(count, color.r, color.g, color.b);
      const head = this.curvePoint(arc, comet.reverse ? 1 - eased : eased, this.tmpA);
      hb.position.setXYZ(count, head.x, head.y, head.z);
      hb.aCol.setXYZ(count, color.r, color.g, color.b);
      // The head hides when it is behind the globe.
      const behind = m < 0.5 && this.hiddenByGlobe(head, camPos);
      hb.aGlow.setXY(count, 13 * comet.size, behind ? 0 : fade * this.uFade.value);
      count++;
    }
    this.comets = keep;
    for (const attribute of Object.values(cb)) attribute.needsUpdate = true;
    for (const attribute of Object.values(hb)) attribute.needsUpdate = true;
    this.cometGeometry.instanceCount = count;
    this.headGeometry.setDrawRange(0, count);

    this.layoutLabels(now);
    this.renderer.render(this.scene, this.camera);
  }

  /** True when the unit sphere blocks the segment from the camera to `point`. */
  private hiddenByGlobe(point: THREE.Vector3, camera: THREE.Vector3): boolean {
    const dir = this.tmpC.copy(point).sub(camera);
    const length = dir.length();
    dir.multiplyScalar(1 / length);
    const b = camera.dot(dir);
    const c = camera.lengthSq() - 0.99;
    const disc = b * b - c;
    if (disc <= 0) return false;
    const near = -b - Math.sqrt(disc);
    return near > 0 && near < length - 0.01;
  }
}
