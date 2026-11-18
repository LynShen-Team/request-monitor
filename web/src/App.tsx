import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Globe, Map as MapIcon, Maximize, Minimize, Moon, Sun, SunMoon } from "lucide-react";
import { DEFAULT_CONFIG, type ScreenConfig } from "./core/config";
import { EMPTY_SNAPSHOT, OpsEngine } from "./core/engine";
import { loadLand } from "./core/geo";
import { ROLE_LABEL, viewerOf, type Role } from "./core/identity";
import type { ReplayWindow } from "./core/model";
import type { ViewMode } from "./core/view";
import { PreviewConfig } from "./preview/config";
import { PreviewIdentity } from "./preview/identity";
import { PreviewLive, PreviewReplay, loadPreviewData } from "./preview/sim";
import { NodePanel, NodeTip } from "./ui/inspect";
import { Scene3D } from "./scene/scene";
import { useAppearance } from "./ui/appearance";
import { FeedPanel, Legend, RankPanel, RoutePanel, SummaryPanel, ThroughputPanel } from "./ui/panels";
import { Timeline } from "./ui/timeline";

type Range = "live" | ReplayWindow;
const RANGES: Array<{ id: Range; label: string }> = [
  { id: "live", label: "实时" },
  { id: "24h", label: "24 小时" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
];

const zone = { timeZone: "Asia/Shanghai", hour12: false } as const;
const clockSeconds = new Intl.DateTimeFormat("zh-CN", { ...zone, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const clockMinutes = new Intl.DateTimeFormat("zh-CN", { ...zone, hour: "2-digit", minute: "2-digit" });
const clockDate = new Intl.DateTimeFormat("zh-CN", { ...zone, month: "long", day: "numeric", weekday: "short" });

const noSubscribe = () => () => undefined;

declare global {
  interface Window {
    /** Frame-stepping hook of `?clock=manual` (screenshots and recordings). */
    __opsScreen?: { advance: (ms: number) => void; engine: OpsEngine; scene: Scene3D };
  }
}

/**
 * Gateway ops screen, PREVIEW build: a full-viewport scene (globe or flat map), live metrics and
 * a 24 h / 7 d / 30 d replay. It reads sample data (`preview/`) and sends no request.
 */
export default function App() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene3D | null>(null);
  const [engine, setEngine] = useState<OpsEngine | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const manual = params.get("clock") === "manual";
  const initialView: ViewMode = params.get("view") === "2d" ? "2d" : "3d";
  // Null until the identity source has answered; the screen shows nothing role-dependent before.
  const [role, setRole] = useState<Role | null>(null);
  const [config, setConfig] = useState<ScreenConfig>(DEFAULT_CONFIG);
  // The map node under the pointer and the node whose detail card is open.
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { theme, mode, hours, cycleMode } = useAppearance(params, manual ? Number(params.get("t")) || Date.now() : null);
  const snap = useSyncExternalStore(engine?.subscribe ?? noSubscribe, engine ? engine.getSnapshot : () => EMPTY_SNAPSHOT);
  const view = engine ? snap.view : initialView;

  useEffect(() => {
    const root = rootRef.current!;
    const scene = new Scene3D(canvasRef.current!, overlayRef.current!, theme);
    sceneRef.current = scene;
    scene.onLabel = (id, event) => {
      if (event === "enter") setHoverId(id);
      else if (event === "leave") setHoverId((current) => (current === id ? null : current));
      else setSelectedId((current) => (current === id ? null : id));
    };
    let disposed = false;
    let frame = 0;
    const layout = () => {
      const bounds = root.getBoundingClientRect();
      const center = centerRef.current!.getBoundingClientRect();
      // The same rule as --px in styles.css.
      const ui = Math.max(0.62, Math.min(2.4, Math.min(bounds.width / 1920, bounds.height / 860)));
      scene.resize(bounds.width, bounds.height, Math.min(2, window.devicePixelRatio || 1), { x: center.left - bounds.left, y: center.top - bounds.top, w: center.width, h: center.height }, ui);
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(root);
    let virtualNow = Number(params.get("t")) || Date.now();

    void (async () => {
      const [land, data, identified, loaded] = await Promise.all([loadLand(), loadPreviewData(virtualNow), new PreviewIdentity(params).identify(), new PreviewConfig().load()]);
      if (disposed) return;
      setRole(identified);
      setConfig(loaded);
      scene.setLand(land);
      const rate = Math.max(0.1, Math.min(50, Number(params.get("rate")) || 1));
      const created = new OpsEngine(scene, new PreviewLive(data, manual ? virtualNow : Date.now(), rate), new PreviewReplay(data));
      created.snapView(initialView);
      created.setViewer(viewerOf(identified));
      const range = params.get("range");
      if (range === "24h" || range === "7d" || range === "30d") created.setReplay(range);
      setEngine(created);
      if (manual) {
        window.__opsScreen = {
          engine: created,
          scene,
          advance: (ms) => {
            virtualNow += ms;
            created.tick(virtualNow);
          },
        };
        created.tick(virtualNow);
        return;
      }
      const loop = () => {
        created.tick(Date.now());
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
      delete window.__opsScreen;
    };
    // The scene is created once; a theme change is applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual, params, initialView]);

  useEffect(() => {
    sceneRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    sceneRef.current?.setFocus(hoverId, selectedId);
  }, [hoverId, selectedId]);

  useEffect(() => {
    // A trackpad pinch reaches the page as a ctrl+wheel event (Chrome, Firefox) or as gesture
    // events (Safari), and by default zooms the whole page. Here it zooms the scene only, and
    // the panels keep their size. A plain scroll zooms when the pointer is over the scene.
    const root = rootRef.current!;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        sceneRef.current?.zoom(event.deltaY * 9);
      } else if (event.target === canvasRef.current) {
        event.preventDefault();
        sceneRef.current?.zoom(event.deltaY);
      }
    };
    let lastScale = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const scale = (event as Event & { scale?: number }).scale ?? 1;
      sceneRef.current?.zoom(-Math.log(scale / lastScale) / 0.0012);
      lastScale = scale;
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("gesturestart", onGestureStart);
    root.addEventListener("gesturechange", onGestureChange);
    return () => {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("gesturestart", onGestureStart);
      root.removeEventListener("gesturechange", onGestureChange);
    };
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const range: Range = snap.mode === "live" ? "live" : snap.window;
  const selectRange = (next: Range) => {
    if (!engine) return;
    if (next === "live") engine.setLive();
    else engine.setReplay(next);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };

  useEffect(() => {
    if (!engine) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") setSelectedId(null);
      else if (event.key === " ") {
        event.preventDefault();
        engine.togglePlay();
      } else if (event.key === "1") engine.setLive();
      else if (event.key === "2") engine.setReplay("24h");
      else if (event.key === "3") engine.setReplay("7d");
      else if (event.key === "4") engine.setReplay("30d");
      else if (event.key === "d" || event.key === "D") engine.setView(engine.getSnapshot().view === "2d" ? "3d" : "2d");
      else if (event.key === "l" || event.key === "L") cycleMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, cycleMode]);

  const modeLabel = mode === "auto" ? "自动" : mode === "day" ? "白天" : "夜间";
  const clockText = (hour: number) => `${Math.floor(hour)}:${String(Math.round((hour % 1) * 60)).padStart(2, "0")}`;
  const modeTitle = mode === "auto" ? `自动：${clockText(hours[0])} 到 ${clockText(hours[1])} 为白天，其余为夜间。点击切换` : `固定为${modeLabel}。点击切换`;
  // A press that moves less than 4 px is a click on the map; a longer one turns the scene.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const hoverDetail = useMemo(() => (engine && hoverId && hoverId !== selectedId ? engine.detail(hoverId, snap.clock) : null), [engine, hoverId, selectedId, snap]);
  const selectedDetail = useMemo(() => (engine && selectedId ? engine.detail(selectedId, snap.clock) : null), [engine, selectedId, snap]);
  const live = snap.mode === "live";
  const scope = live ? "近 15 分钟" : snap.wholeWindow ? "整个时间窗" : "当前时段";

  return (
    <div ref={rootRef} className={`ops${manual ? " is-manual" : ""}`} style={theme.css as CSSProperties} data-theme={theme.id}>
      <canvas
        ref={canvasRef}
        className="scene"
        style={hoverId ? { cursor: "pointer" } : undefined}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const press = drag.current;
          if (!press) {
            setHoverId(sceneRef.current?.pick(event.clientX - rect.left, event.clientY - rect.top) ?? null);
            return;
          }
          const dx = event.clientX - press.x;
          const dy = event.clientY - press.y;
          if (!press.moved && Math.hypot(dx, dy) < 4) return;
          press.moved = true;
          setHoverId(null);
          sceneRef.current?.orbit(dx, dy);
          press.x = event.clientX;
          press.y = event.clientY;
        }}
        onPointerUp={(event) => {
          const press = drag.current;
          drag.current = null;
          if (!press || press.moved) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const id = sceneRef.current?.pick(event.clientX - rect.left, event.clientY - rect.top) ?? null;
          setSelectedId((current) => (id === current ? null : id));
        }}
        onPointerLeave={() => setHoverId(null)}
      />
      <div className="scene-shade" />
      <div ref={overlayRef} className="scene-overlay" />

      <header className="top">
        <div className="brand">
          {config.logo ? (
            <>
              <img className="brand-logo" src={theme.light ? config.logo.day : config.logo.night} alt="" />
              <span className="brand-sep" />
            </>
          ) : null}
          <span className="brand-title">{config.title}</span>
          {config.note ? <span className="brand-note">{config.note}</span> : null}
          {role ? (
            <span className="who" title={role === "admin" ? "身份由网关登录状态自动识别：可查看全部分组和渠道" : "身份由网关登录状态自动识别：受限分组只显示分组名"}>
              {ROLE_LABEL[role]}
            </span>
          ) : null}
        </div>
        <div className="seg" role="group" aria-label="时间范围">
          {RANGES.map((item) => (
            <button key={item.id} type="button" aria-pressed={range === item.id} onClick={() => selectRange(item.id)}>
              {item.id === "live" ? <span className="live-dot" /> : null}
              {item.label}
            </button>
          ))}
        </div>
        <div className="top-right">
          <div className="seg" role="group" aria-label="地图视图">
            <button type="button" aria-pressed={view === "3d"} onClick={() => engine?.setView("3d")}>
              <Globe />
              地球
            </button>
            <button type="button" aria-pressed={view === "2d"} onClick={() => engine?.setView("2d")}>
              <MapIcon />
              平面
            </button>
          </div>
          <button type="button" className="btn" onClick={cycleMode} aria-label={`明暗：${modeLabel}，点击切换`} title={modeTitle}>
            {mode === "auto" ? <SunMoon /> : mode === "day" ? <Sun /> : <Moon />}
            {modeLabel}
          </button>
          <button type="button" className="btn" onClick={toggleFullscreen} aria-label={fullscreen ? "退出全屏" : "全屏"} title={fullscreen ? "退出全屏" : "全屏"}>
            {fullscreen ? <Minimize /> : <Maximize />}
          </button>
          <div className="clock">
            <b>{live ? clockSeconds.format(snap.clock || Date.now()) : clockMinutes.format(snap.clock)}</b>
            <span>
              {live ? "" : "回溯时刻 · "}
              {clockDate.format(snap.clock || Date.now())}
            </span>
          </div>
        </div>
      </header>

      <aside className="col is-left">
        <ThroughputPanel snap={snap} />
        <RankPanel title="模型" hint={scope} rows={snap.models} ready={snap.ready} limit={9} mono />
        <RankPanel title="来源地区" hint={config.note ? `${config.note}，城市级` : "城市级"} rows={snap.origins} ready={snap.ready} limit={9} />
      </aside>

      <aside className="col is-right">
        <RoutePanel snap={snap} />
        {/* The detail of a selected map node takes the place of the lower card, so it never covers the map. */}
        {selectedDetail ? <NodePanel detail={selectedDetail} onClose={() => setSelectedId(null)} /> : live ? <FeedPanel snap={snap} /> : <SummaryPanel snap={snap} />}
      </aside>

      <div ref={centerRef} className="center" />
      {sceneRef.current && hoverDetail ? <NodeTip scene={sceneRef.current} detail={hoverDetail} /> : null}
      <Legend live={live} attribution={config.attribution} />
      <Timeline snap={snap} engine={engine} />
      {engine ? null : <div className="boot">正在加载</div>}
    </div>
  );
}
