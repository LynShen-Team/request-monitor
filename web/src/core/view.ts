/** What the engine needs from a map renderer. Times are milliseconds on the engine clock. */

export type ViewMode = "2d" | "3d";
export type ArcKind = "in" | "out";
export type Tone = "in" | "out" | "ok" | "err" | "gone";
export type NodeKind = "gateway" | "upstream" | "origin";

export interface MapNode {
  id: string;
  kind: NodeKind;
  lon: number;
  lat: number;
  name: string;
  sub?: string;
}

export interface AggregateFlow {
  from: string;
  to: string;
  kind: ArcKind;
  /** 0..1, relative to the heaviest flow of the same kind. */
  weight: number;
  /** 0..1 share of failed requests on this flow. */
  errShare: number;
}

export interface NodeMeta {
  /** 0..1 relative volume; drives the beam height. */
  value?: number;
  /** 0..1 success rate; drives the colour of an upstream. */
  health?: number;
  sub?: string;
}

export interface FlowView {
  setNodes(defs: MapNode[]): void;
  setView(view: ViewMode, now: number): void;
  snapView(view: ViewMode): void;
  setAggregateMode(on: boolean): void;
  setAggregate(flows: AggregateFlow[]): void;
  setNodeMeta(id: string, meta: NodeMeta): void;
  /** Starts a comet along an arc and returns its arrival time. */
  comet(from: string, to: string, kind: ArcKind, tone: Tone, now: number, durMs: number, reverse?: boolean, size?: number): number;
  hold(from: string, to: string, kind: ArcKind, delta: number): void;
  inflight(id: string, delta: number): void;
  pulse(id: string, tone: Tone, now: number, size?: number): void;
  tag(id: string, text: string, tone: Tone, now: number): void;
  draw(now: number): void;
}
