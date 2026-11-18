import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Globe, Map as MapIcon, Maximize, Minimize, Moon, Sun, SunMoon } from "lucide-react";
import { DEFAULT_CONFIG, type ScreenConfig } from "./core/config";
import { EMPTY_SNAPSHOT, OpsEngine } from "./core/engine";
import { loadLand } from "./core/geo";
import { LoginRequired, ROLE_LABEL, viewerOf, type Role } from "./core/identity";
import type { ReplayWindow } from "./core/model";
import type { ViewMode } from "./core/view";
import { openSources, type Sources } from "./sources";
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
  const [sources, setSources] = useState<Pick<Sources, "kind" | "backfilling" | "checkBackfilling" | "minClients"> | null>(null);
  // The data source did not answer at start; `attempt` counts the tries.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Set when the data source lets no guest in and the visitor is not signed in to the gateway.
  const [gate, setGate] = useState<{ loginUrl: string | null } | null>(null);
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
    // The view of the address is on screen before any data: a message can be all that is shown.
    scene.snapView(initialView);
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
    let retry = 0;
    let poll = 0;
    let onVisible: (() => void) | null = null;

    void (async () => {
      const land = await loadLand();
      if (disposed) return;
      scene.setLand(land);
      let opened: Sources;
      try {
        opened = await openSources(params, manual ? virtualNow : Date.now());
      } catch (error) {
        if (disposed) return;
        setEngine(null);
        // The map stays on screen behind the message.
        const idle = () => {
          scene.draw(performance.now());
          if (!manual) frame = requestAnimationFrame(idle);
        };
        idle();
        if (error instanceof LoginRequired) {
          // No guest may open this screen: say where to sign in, and open once the visitor has.
          setFailed(false);
          setRole(null);
          setConfig(error.config);
          setGate({ loginUrl: error.loginUrl });
          const recheck = () => {
            void error.recheck().then(
              (allowed) => {
                if (allowed && !disposed) setAttempt((n) => n + 1);
              },
              () => {},
            );
          };
          poll = window.setInterval(recheck, 15_000);
          // The visitor signs in in another tab and comes back: look at once.
          onVisible = () => {
            if (document.visibilityState === "visible") recheck();
          };
          document.addEventListener("visibilitychange", onVisible);
          return;
        }
        // The service did not answer: say so and try again, instead of showing an empty screen.
        setGate(null);
        setFailed(true);
        retry = window.setTimeout(() => setAttempt((n) => n + 1), 10_000);
        return;
      }
      if (disposed) return;
      setFailed(false);
      setGate(null);
      setRole(opened.role);
      setConfig(opened.config);
      setSources({ kind: opened.kind, backfilling: opened.backfilling, checkBackfilling: opened.checkBackfilling, minClients: opened.minClients });
      const created = new OpsEngine(scene, opened.live, opened.replay);
      created.snapView(initialView);
      created.setViewer(viewerOf(opened.role));
      const range = params.get("range");
      if (range === "24h" || range === "7d" || range === "30d") created.setReplay(range);
      // A source with no live mode opens on the newest day.
      else if (opened.live.capabilities.live === "none") created.setReplay("24h");
      setEngine(created);
      opened.watch?.({
        role: (next) => {
          if (disposed) return;
          setRole(next);
          created.setViewer(viewerOf(next));
        },
        // The session ended and no guest is let in: drop what is on screen and ask for a sign-in.
        loginRequired: () => {
          if (disposed) return;
          setEngine(null);
          setAttempt((n) => n + 1);
        },
      });
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
      window.clearTimeout(retry);
      window.clearInterval(poll);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
      delete window.__opsScreen;
    };
    // The scene is created once; a theme change is applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual, params, initialView, attempt]);

  useEffect(() => {
    sceneRef.current?.setTheme(theme);
  }, [theme]);

  // The notice about older history goes away once the service has read it all.
  useEffect(() => {
    const check = sources?.backfilling ? sources.checkBackfilling : undefined;
    if (!check) return;
    const timer = window.setInterval(() => {
      void check().then(
        (still) => {
          if (!still) setSources((current) => (current ? { ...current, backfilling: false } : current));
        },
        () => {},
      );
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [sources]);

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
  // A failed refresh keeps the last data on screen; a window that never loaded has none to keep.
  const notice = snap.stale ? (snap.ready ? "数据服务暂时连不上，显示的是上一次取到的数据。" : "数据服务暂时连不上，正在自动重试。") : sources?.backfilling ? "服务还在读取更早的历史，较早的时间段可能还是空的。" : null;

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
          {RANGES.map((item) => {
            // A source that shows a request only after it ended is labelled as such, never as live.
            const off = item.id === "live" && engine !== null && snap.caps.live === "none";
            const replayed = item.id === "live" && snap.caps.live === "replayed";
            return (
              <button key={item.id} type="button" aria-pressed={engine !== null && range === item.id} disabled={off || engine === null} title={off ? "这个数据服务还没有实时模式" : replayed ? "请求结束后才显示，比实际晚一个请求的时长" : undefined} onClick={() => selectRange(item.id)}>
                {item.id === "live" && !off && engine !== null ? <span className="live-dot" /> : null}
                {replayed ? "准实时" : item.label}
              </button>
            );
          })}
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
        <RankPanel
          title="来源地区"
          hint={sources?.minClients ? `不足 ${sources.minClients} 个客户端的城市并入省份` : config.note ? `${config.note}，城市级` : "城市级"}
          rows={snap.origins}
          ready={snap.ready}
          limit={9}
          missing={engine !== null && !snap.caps.origin ? "这个网关没有记录请求的来源地区。" : undefined}
        />
      </aside>

      <aside className="col is-right">
        <RoutePanel snap={snap} />
        {/* The detail of a selected map node takes the place of the lower card, so it never covers the map. */}
        {selectedDetail ? <NodePanel detail={selectedDetail} errors={snap.caps.errors} onClose={() => setSelectedId(null)} /> : live ? <FeedPanel snap={snap} /> : <SummaryPanel snap={snap} />}
      </aside>

      <div ref={centerRef} className="center" />
      {sceneRef.current && hoverDetail ? <NodeTip scene={sceneRef.current} detail={hoverDetail} /> : null}
      <Legend live={live} errors={snap.caps.errors} attribution={config.attribution} />
      <Timeline snap={snap} engine={engine} />
      {notice ? <div className="notice">{notice}</div> : null}
      {engine ? null : gate ? (
        <div className="boot is-gate">
          <div className="boot-card">
            <div className="boot-title">这块大屏要先登录网关才能看。</div>
            <div className="boot-actions">
              {gate.loginUrl ? (
                <a className="btn" href={gate.loginUrl} target="_blank" rel="noopener noreferrer">
                  去登录
                </a>
              ) : null}
              <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
                我已登录，重新打开
              </button>
            </div>
            <div className="boot-hint">{gate.loginUrl ? "登录后回到这个页面，会自动打开。" : "请在网关控制台登录后回到这个页面，会自动打开。"}</div>
          </div>
        </div>
      ) : failed ? (
        <div className="boot is-failed">
          <div className="boot-card">
            <div className="boot-title">连不上数据服务，10 秒后自动重试。</div>
            <div className="boot-actions">
              <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
                现在重试
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="boot">正在加载</div>
      )}
    </div>
  );
}
