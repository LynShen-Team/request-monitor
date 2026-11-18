import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Pause, Play } from "lucide-react";
import type { OpsEngine, Snapshot } from "../core/engine";
import { formatCount } from "../core/format";

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const zone = { timeZone: "Asia/Shanghai", hour12: false } as const;
const hourMinute = new Intl.DateTimeFormat("zh-CN", { ...zone, hour: "2-digit", minute: "2-digit" });
const hourMinuteSecond = new Intl.DateTimeFormat("zh-CN", { ...zone, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const monthDay = new Intl.DateTimeFormat("zh-CN", { ...zone, month: "numeric", day: "numeric" });
const dayTime = new Intl.DateTimeFormat("zh-CN", { ...zone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const WINDOW_LABEL = { "24h": "近 24 小时", "7d": "近 7 天", "30d": "近 30 天" } as const;
const SPEEDS = [1, 2, 4];

function tickStep(spanMs: number): { step: number; format: (t: number) => string } {
  const hour = 3_600_000;
  if (spanMs <= hour) return { step: 5 * 60_000, format: (t) => hourMinute.format(t) };
  if (spanMs <= 26 * hour) return { step: 3 * hour, format: (t) => hourMinute.format(t) };
  if (spanMs <= 8 * 24 * hour) return { step: 24 * hour, format: (t) => monthDay.format(t) };
  return { step: 5 * 24 * hour, format: (t) => monthDay.format(t) };
}

function draw(canvas: HTMLCanvasElement, snap: Snapshot, hover: number | null) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const style = getComputedStyle(canvas);
  const color = (name: string) => style.getPropertyValue(name).trim();
  const accent = color("--accent");
  const err = color("--err");
  const line = color("--line");
  const text2 = color("--text-2");
  const text3 = color("--text-3");
  const text = color("--text");
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const u = rect.height / 72;
  const { total, errors, cursor, live, start, stepMs } = snap.timeline;
  const n = total.length;
  if (n === 0) return;
  const axis = 17 * u;
  const top = 4 * u;
  const h = rect.height - axis - top;
  const w = rect.width;
  const slot = w / n;
  const gap = slot > 3 ? 1 : 0;
  const barWidth = Math.max(1, slot - gap);
  const radius = Math.min(2, barWidth / 2);
  let max = 1;
  for (const v of total) if (v > max) max = v;

  ctx.fillStyle = line;
  ctx.fillRect(0, top + h, w, 1);
  const playedTo = live ? n : cursor * n;
  for (let i = 0; i < n; i++) {
    const value = total[i]!;
    if (value <= 0) continue;
    const bh = Math.max(1.5, (value / max) * h);
    const x = i * slot;
    const played = i < playedTo;
    ctx.globalAlpha = (played ? 1 : 0.4) * (hover !== null && hover !== i ? 0.7 : 1);
    ctx.fillStyle = played ? accent : text3;
    ctx.beginPath();
    ctx.roundRect(x, top + h - bh, barWidth, bh, [radius, radius, 0, 0]);
    ctx.fill();
    const failed = errors[i]!;
    if (failed > 0) {
      const eh = Math.max(1.5, Math.min(bh, (failed / value) * bh));
      ctx.fillStyle = err;
      ctx.beginPath();
      ctx.roundRect(x, top + h - bh, barWidth, eh, [radius, radius, 0, 0]);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  const span = n * stepMs;
  const { step, format } = tickStep(span);
  ctx.font = `${11 * u}px "Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
  ctx.textBaseline = "alphabetic";
  const first = Math.ceil((start + SHANGHAI_OFFSET_MS) / step) * step - SHANGHAI_OFFSET_MS;
  for (let t = first; t < start + span; t += step) {
    const x = ((t - start) / span) * w;
    if (x < 18 * u || x > w - 30 * u) continue;
    ctx.fillStyle = text3;
    ctx.textAlign = "center";
    ctx.fillText(format(t), x, rect.height - 2 * u);
  }
  if (live) {
    ctx.textAlign = "right";
    ctx.fillStyle = text2;
    ctx.fillText("现在", w, rect.height - 2 * u);
  } else if (!snap.wholeWindow) {
    const x = Math.max(1, Math.min(w - 1, cursor * w));
    ctx.fillStyle = text;
    ctx.fillRect(x - 0.75, 0, 1.5, top + h);
  }
}

export function Timeline({ snap, engine }: { snap: Snapshot; engine: OpsEngine | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<{ index: number; x: number } | null>(null);
  const live = snap.mode === "live";
  const { total, errors, start, stepMs } = snap.timeline;
  const hoverIndex = hover && hover.index < total.length ? hover.index : null;

  useEffect(() => {
    if (canvasRef.current) draw(canvasRef.current, snap, hoverIndex);
  }, [snap, hoverIndex]);

  const locate = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(0.9999, (event.clientX - rect.left) / rect.width));
    return { fraction, x: event.clientX - rect.left, index: Math.floor(fraction * Math.max(1, total.length)) };
  };

  const rangeTotal = snap.kpi.rps * ((snap.range.to - snap.range.from) / 1000);
  let liveTotal = 0;
  for (const v of total) liveTotal += v;
  const tipFrom = hoverIndex !== null ? start + hoverIndex * stepMs : 0;

  return (
    <footer className="card timeline">
      <div className="card-head">
        {live ? null : (
          <button type="button" className="play" onClick={() => engine?.togglePlay()} aria-label={snap.playing ? "暂停" : "播放"}>
            {snap.playing ? <Pause /> : <Play />}
          </button>
        )}
        <h3>{live ? "近 30 分钟请求量" : `回溯 · ${WINDOW_LABEL[snap.window]}`}</h3>
        {live ? null : (
          <>
            <div className="seg is-small" role="group" aria-label="回放速度">
              {SPEEDS.map((speed) => (
                <button key={speed} type="button" className="num" aria-pressed={snap.speed === speed} onClick={() => engine?.setSpeed(speed)}>
                  {speed}×
                </button>
              ))}
            </div>
            <div className="seg is-small" role="group" aria-label="聚合范围">
              <button type="button" aria-pressed={!snap.wholeWindow} onClick={() => engine?.setWholeWindow(false)}>
                按时间回放
              </button>
              <button type="button" aria-pressed={snap.wholeWindow} onClick={() => engine?.setWholeWindow(true)}>
                整窗聚合
              </button>
            </div>
          </>
        )}
        <div className="timeline-read">
          {!snap.ready ? null : live ? (
            <>
              每格 10 秒 · 共 <b>{formatCount(liveTotal)}</b> 次
            </>
          ) : (
            <>
              <b>
                {dayTime.format(snap.range.from)} – {snap.wholeWindow ? dayTime.format(snap.range.to) : hourMinute.format(snap.range.to)}
              </b>
              {" · "}
              <b>{formatCount(rangeTotal)}</b> 次 · 成功率 <b>{(snap.kpi.successRate * 100).toFixed(1)}%</b>
            </>
          )}
        </div>
      </div>
      <div className={`timeline-canvas${live ? "" : " is-seek"}`}>
        <canvas
          ref={canvasRef}
          onPointerDown={(event) => {
            if (live || !engine) return;
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            engine.seek(locate(event).fraction);
          }}
          onPointerMove={(event) => {
            const at = locate(event);
            setHover({ index: at.index, x: at.x });
            if (dragging.current && engine) engine.seek(at.fraction);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerLeave={() => setHover(null)}
        />
        {hover && hoverIndex !== null ? (
          <div className="tip" style={{ left: hover.x }}>
            <div className="muted num">
              {live ? `${hourMinuteSecond.format(tipFrom)} 起 10 秒` : `${dayTime.format(tipFrom)} – ${hourMinute.format(tipFrom + stepMs)}`}
            </div>
            <div>
              请求 <b>{formatCount(total[hoverIndex] ?? 0)}</b> · 失败 <b>{formatCount(errors[hoverIndex] ?? 0)}</b>
            </div>
          </div>
        ) : null}
      </div>
    </footer>
  );
}
