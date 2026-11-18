import { useEffect, useRef, type CSSProperties } from "react";
import { X } from "lucide-react";
import type { NodeDetail, RankRow } from "../core/engine";
import { formatCount, formatSeconds } from "../core/format";
import type { Scene3D } from "../scene/scene";

const KIND = { gateway: "网关", upstream: "上游所在地", origin: "来源地区" } as const;
const clockTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const tone = (value: string) => ({ "--tone": value }) as CSSProperties;
const health = (rate: number) => (rate >= 0.97 ? "var(--ok)" : rate >= 0.9 ? "var(--warn)" : "var(--err)");
const percent = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const share = (value: number) => (value > 0 && value < 0.001 ? "<0.1%" : percent(value, value < 0.1 ? 1 : 0));

/** One line of key figures, shared by the tooltip and the panel header. */
function summary(detail: NodeDetail): string {
  const parts = [`${detail.scope} ${formatCount(detail.requests)} 次`];
  if (detail.okRate !== null) parts.push(`成功率 ${percent(detail.okRate)}`);
  if (detail.inflight !== null && detail.inflight > 0) parts.push(`进行中 ${detail.inflight}`);
  return parts.join(" · ");
}

/**
 * Follows a map node with a short summary while the pointer is on it. The scene moves slowly on
 * its own, so the position is read every frame instead of once.
 */
export function NodeTip({ scene, detail }: { scene: Scene3D; detail: NodeDetail }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const place = () => {
      const el = ref.current;
      const at = scene.screenOf(detail.id);
      if (el && at) {
        const left = at.x > window.innerWidth * 0.6;
        el.style.opacity = at.visible ? "1" : "0";
        el.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0) translate(${left ? "calc(-100% - 16px)" : "16px"}, -50%)`;
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [scene, detail.id]);
  return (
    <div ref={ref} className="node-tip" role="tooltip">
      <div>
        <b>{detail.name}</b> <span className="muted">{KIND[detail.kind]}</span>
      </div>
      <div className="num">{summary(detail)}</div>
      <div className="muted">点击查看详情</div>
    </div>
  );
}

function Trend({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const width = 100 / values.length;
  return (
    <svg className="inspect-trend" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      {values.map((value, i) => {
        const h = value > 0 ? Math.max(1, (value / max) * 23) : 0;
        return <rect key={i} x={i * width} y={24 - h} width={Math.max(0.2, width - (width > 1.4 ? 0.5 : 0))} height={h} fill="var(--accent)" />;
      })}
    </svg>
  );
}

function Ranks({ title, rows, mono }: { title: string; rows: RankRow[]; mono?: boolean }) {
  if (rows.length === 0) return null;
  const top = rows[0]!.share || 1;
  return (
    <>
      <div className="subhead">{title}</div>
      {rows.map((row) => (
        <div className="rank" key={row.key}>
          <span className={`rank-name${mono ? " mono" : ""}`}>{row.name}</span>
          <span className="rank-count">{formatCount(row.count)}</span>
          <span className="rank-share">{share(row.share)}</span>
          <div className="bar">
            <i style={{ width: `${Math.max(1, (row.share / top) * 100)}%` }} />
          </div>
        </div>
      ))}
    </>
  );
}

/** The detail card of the selected map node. */
export function NodePanel({ detail, onClose }: { detail: NodeDetail; onClose: () => void }) {
  const live = detail.inflight !== null;
  return (
    <section className="card inspect is-grow is-floor" aria-label={`${detail.name} 详情`}>
      <div className="inspect-head">
        <div>
          <div className="inspect-kind">
            {KIND[detail.kind]} · {detail.scope}
          </div>
          <h3>
            {detail.name} <span>{detail.region}</span>
          </h3>
        </div>
        <button type="button" className="inspect-close" onClick={onClose} aria-label="关闭详情" title="关闭（Esc）">
          <X />
        </button>
      </div>
      {detail.note ? <div className="inspect-note">{detail.note}</div> : null}
      <div className="stats">
        <div className="stat">
          <div className="stat-label">请求</div>
          <div className="stat-value">{formatCount(detail.requests)}</div>
          <div className="stat-sub num">{live ? `占 ${share(detail.share)}` : "次"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">
            {detail.okRate !== null ? <i className="dot" style={tone(health(detail.okRate))} /> : null}
            成功率
          </div>
          <div className="stat-value">
            {detail.okRate !== null ? (detail.okRate * 100).toFixed(detail.okRate >= 0.9995 ? 0 : 1) : "—"}
            {detail.okRate !== null ? <em>%</em> : null}
          </div>
          <div className="stat-sub num">{detail.ttfbP50 !== null ? `首字 ${formatSeconds(detail.ttfbP50)}` : detail.okRate === null ? "回溯时未统计" : " "}</div>
        </div>
        <div className="stat">
          <div className="stat-label">{live ? "进行中" : "占比"}</div>
          <div className="stat-value">{live ? formatCount(detail.inflight ?? 0) : share(detail.share)}</div>
          <div className="stat-sub">{live ? "此刻" : "占全部请求"}</div>
        </div>
      </div>
      <div className="inspect-body">
        <div className="subhead">{live ? "请求量 · 近 30 分钟，每分钟一格" : "请求量 · 整个时间窗"}</div>
        <Trend values={detail.trend} />
        <Ranks title="模型" rows={detail.models} mono />
        {detail.routes.length > 0 ? (
          <>
            <div className="subhead">分组 · 渠道</div>
            {detail.routes.map((row) => (
              <div className="rank" key={row.key}>
                <span className="rank-name">{row.restricted ? row.group : `${row.group} · ${row.channel}`}</span>
                <span className="rank-count">
                  {row.okRate < 0.97 ? <i className="dot" style={{ ...tone(health(row.okRate)), marginRight: "calc(5 * var(--px))" }} /> : null}
                  成功 {percent(row.okRate)}
                </span>
                <span className="rank-share">{share(row.share)}</span>
                <div className="bar">
                  <i style={{ width: `${Math.max(1, (row.share / (detail.routes[0]!.share || 1)) * 100)}%` }} />
                </div>
              </div>
            ))}
          </>
        ) : null}
        <Ranks title="来源地区" rows={detail.origins} />
        <Ranks title="上游所在地" rows={detail.sites} />
        {detail.noBreakdown ? <div className="inspect-note">{detail.kind === "origin" ? "回溯时只有这个地区的请求数，没有它的模型和渠道明细。" : "回溯时没有这个地点的模型明细。"}</div> : null}
        {detail.recent.length > 0 ? (
          <>
            <div className="subhead">最近完成的请求</div>
            {detail.recent.map((row, i) => (
              <div className="inspect-recent" key={`${row.t}-${i}`}>
                <i className="dot" style={tone(row.status === "success" ? "var(--ok)" : row.status === "error" ? "var(--err)" : "var(--warn)")} />
                <div>
                  <div>{row.route}</div>
                  <div>
                    <span className="num">{clockTime.format(row.t)}</span>
                    {detail.kind === "origin" ? "" : ` · ${row.origin}`} · <span className="mono">{row.model}</span>
                  </div>
                </div>
                <span className="num">{row.status === "success" ? formatSeconds(row.durationMs) : row.status === "client_gone" ? "客户端断开" : (row.errorCode ?? "失败")}</span>
              </div>
            ))}
          </>
        ) : null}
        {detail.requests === 0 && detail.recent.length === 0 ? <div className="inspect-note">这个范围内没有请求。</div> : null}
      </div>
    </section>
  );
}
