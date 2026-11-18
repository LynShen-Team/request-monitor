import type { CSSProperties, ReactNode } from "react";
import { Lock } from "lucide-react";
import type { RankRow, RouteRow, Snapshot, TickerRow } from "../core/engine";
import { formatCompact, formatCount, formatSeconds } from "../core/format";

function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function share(value: number): string {
  if (value > 0 && value < 0.001) return "<0.1%";
  return percent(value, value < 0.1 ? 1 : 0);
}

const tone = (value: string) => ({ "--tone": value }) as CSSProperties;
const health = (rate: number) => (rate >= 0.97 ? "var(--ok)" : rate >= 0.9 ? "var(--warn)" : "var(--err)");

export function Card({ title, hint, className, children }: { title?: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <section className={`card${className ? ` ${className}` : ""}`}>
      {title ? (
        <div className="card-head">
          <h3>{title}</h3>
          {hint ? <span className="card-hint">{hint}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A trend line with a light wash under it and the newest point marked. */
function Spark({ values, floor }: { values: number[]; floor?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1e-9);
  const min = floor ?? Math.min(...values);
  const span = Math.max(1e-9, max - min);
  const points = values.map((v, i) => [(i / (values.length - 1)) * 100, 37 - ((v - min) / span) * 33] as const);
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const last = points[points.length - 1]!;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L100 40 L0 40 Z`} fill="var(--accent)" opacity="0.1" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      <path d={`M${last[0]} ${last[1]}h0`} stroke="var(--accent)" strokeWidth="6" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
    </svg>
  );
}

export function ThroughputPanel({ snap }: { snap: Snapshot }) {
  const { kpi, spark } = snap;
  const live = snap.mode === "live";
  const ok = kpi.successRate;
  const rps = kpi.rps >= 100 ? kpi.rps.toFixed(0) : kpi.rps.toFixed(kpi.rps >= 10 ? 1 : 2);
  return (
    <Card>
      <div className="hero">
        <div className="hero-label">{live ? "每秒请求" : snap.wholeWindow ? "平均每秒请求" : "每秒请求（回溯时刻）"}</div>
        <div className="hero-value">
          {snap.ready ? rps : "—"}
          <em>次 / 秒</em>
        </div>
        <div className="hero-sub num">
          {live ? `近 30 分钟峰值 ${kpi.rpsPeak.toFixed(1)}` : `窗口内峰值 ${kpi.rpsPeak.toFixed(1)}`} · {live ? `近 24 小时 ${formatCount(kpi.total)} 次` : `累计 ${formatCount(kpi.total)} 次`}
        </div>
        <Spark values={spark.rps} floor={0} />
      </div>
      <div className="stats">
        <div className="stat">
          <div className="stat-label">
            <i className="dot" style={tone(health(ok))} />
            成功率
          </div>
          <div className="stat-value">
            {(ok * 100).toFixed(ok >= 0.9995 ? 0 : 1)}
            <em>%</em>
          </div>
          <div className="stat-sub num">失败 {formatCount(kpi.errors)} 次</div>
        </div>
        <div className="stat">
          <div className="stat-label">首字延迟（中位）</div>
          <div className="stat-value">
            {kpi.ttfbP50 > 0 ? (kpi.ttfbP50 / 1000).toFixed(2) : "—"}
            <em>秒</em>
          </div>
          <div className="stat-sub num">{live && kpi.ttfbP95 > 0 ? `P95 ${formatSeconds(kpi.ttfbP95)}` : " "}</div>
        </div>
        <div className="stat">
          <div className="stat-label">{live ? "进行中" : "时段请求"}</div>
          <div className="stat-value">{live ? formatCount(kpi.inflight) : formatCompact(kpi.rps * ((snap.range.to - snap.range.from) / 1000))}</div>
          <div className="stat-sub num">{live ? `换渠道 ${formatCount(kpi.failover)} 次` : "次"}</div>
        </div>
      </div>
    </Card>
  );
}

function SkeletonRows({ count, height }: { count: number; height: number }) {
  return (
    <div className="rows">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ height: `calc(${height} * var(--px))`, padding: "calc(8 * var(--px)) 0", flex: "none" }}>
          <div className="skeleton" style={{ height: "100%", width: `${92 - (i % 4) * 11}%` }} />
        </div>
      ))}
    </div>
  );
}

function RankRows({ rows, limit, mono }: { rows: RankRow[]; limit: number; mono?: boolean }) {
  const top = rows[0]?.share ?? 1;
  return (
    <>
      {rows.slice(0, limit).map((row) => (
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

export function RankPanel({ title, hint, rows, ready, limit, mono }: { title: string; hint: string; rows: RankRow[]; ready: boolean; limit: number; mono?: boolean }) {
  return (
    <Card title={title} hint={hint} className="is-grow">
      <div className="card-body">{ready ? <div className="rows"><RankRows rows={rows} limit={limit} mono={mono} /></div> : <SkeletonRows count={limit} height={30} />}</div>
    </Card>
  );
}

export function RoutePanel({ snap }: { snap: Snapshot }) {
  const top = snap.routes[0]?.share ?? 1;
  const live = snap.mode === "live";
  return (
    <Card title="调度去向" hint={`分组 · 渠道，${live ? "近 15 分钟" : snap.wholeWindow ? "整个时间窗" : "当前时段"}`} className="is-shrink">
      <div className="card-body">
        {!snap.ready ? (
          <SkeletonRows count={9} height={44} />
        ) : (
          <div className="rows">
            {snap.routes.map((row: RouteRow) => {
              const flash = live ? Math.max(0, 1 - (snap.clock - row.lastAt) / 1200) : 0;
              return (
                <div className="route" key={row.key}>
                  {flash > 0 ? <div className="route-flash" style={{ opacity: flash }} /> : null}
                  <div className="route-line">
                    <div className="route-name">
                      {row.restricted ? (
                        <>
                          <b>{row.group}</b>
                          <span title="渠道明细仅管理员可见" style={{ display: "inline-flex" }}>
                            <Lock />
                          </span>
                        </>
                      ) : (
                        <b>
                          <span>{row.group} · </span>
                          {row.channel}
                        </b>
                      )}
                      {row.site ? <span className="route-site">{row.site}</span> : null}
                    </div>
                    <span className="num">{share(row.share)}</span>
                  </div>
                  <div className="route-meta">
                    <div className="bar">
                      <i style={{ width: `${Math.max(1, (row.share / top) * 100)}%` }} />
                    </div>
                    <span>
                      {row.okRate < 0.97 ? <i className="dot" style={tone(health(row.okRate))} /> : null}
                      成功 <b>{percent(row.okRate, 1)}</b>
                    </span>
                    {row.ttfbP50 > 0 ? (
                      <span>
                        首字 <b>{formatSeconds(row.ttfbP50)}</b>
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

const clockTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function FeedRow({ row }: { row: TickerRow }) {
  const color = row.status === "success" ? "var(--ok)" : row.status === "error" ? "var(--err)" : row.status === "client_gone" ? "var(--warn)" : "var(--accent-2)";
  const result = row.status === "pending" ? (row.ttfbMs ? "输出中" : "调度中") : row.status === "success" ? formatSeconds(row.durationMs) : row.status === "client_gone" ? "客户端断开" : (row.errorCode ?? "失败");
  return (
    <div className="feed-row">
      <i className={`dot${row.status === "pending" ? " is-ring" : ""}`} style={tone(color)} />
      <div className="feed-main">
        <div>
          {row.route}
          {row.failover ? <span className="muted"> · 已换渠道</span> : null}
        </div>
        <div>
          <span className="num">{clockTime.format(row.t)}</span> · {row.origin}
          {row.site ? ` → ${row.site}` : ""} · <span className="mono">{row.model}</span>
        </div>
      </div>
      <div className="feed-side">
        <span className={row.status === "pending" ? "muted" : undefined}>{result}</span>
        <small>{row.ttfbMs && row.status !== "error" ? `首字 ${formatSeconds(row.ttfbMs)}` : " "}</small>
      </div>
    </div>
  );
}

export function FeedPanel({ snap }: { snap: Snapshot }) {
  return (
    <Card title="实时请求" hint="最新在上" className="is-grow is-floor">
      <div className="card-body">{snap.ready ? <div className="rows">{snap.ticker.map((row) => <FeedRow key={row.id} row={row} />)}</div> : <SkeletonRows count={8} height={38} />}</div>
    </Card>
  );
}

export function SummaryPanel({ snap }: { snap: Snapshot }) {
  const requests = snap.kpi.rps * ((snap.range.to - snap.range.from) / 1000);
  return (
    <Card title={snap.wholeWindow ? "时间窗汇总" : "当前时段"} hint={snap.wholeWindow ? "整个时间窗" : "随时间轴变化"} className="is-grow is-floor">
      <div className="facts">
        <div className="stat">
          <div className="stat-label">请求</div>
          <div className="stat-value">{formatCount(requests)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">
            <i className="dot" style={tone(health(snap.kpi.successRate))} />
            失败
          </div>
          <div className="stat-value">{formatCount(snap.kpi.errors)}</div>
        </div>
      </div>
      <div className="card-body">
        <div className="rows">
          <div className="subhead">上游所在地</div>
          <RankRows rows={snap.sites} limit={4} />
          <div className="subhead">分组</div>
          <RankRows rows={snap.groups} limit={8 - Math.min(4, snap.sites.length)} />
        </div>
      </div>
    </Card>
  );
}

export function Legend({ live, attribution }: { live: boolean; attribution?: { text: string; url?: string } }) {
  return (
    <div className="legend">
      <span>
        <i style={tone("var(--accent)")} />
        用户请求
      </span>
      <span>
        <i style={tone("var(--accent-2)")} />
        调度到上游
      </span>
      {live ? (
        <span>
          <i style={tone("var(--ok)")} />
          成功回传
        </span>
      ) : null}
      <span>
        <i style={tone("var(--err)")} />
        失败
      </span>
      {live ? (
        <span>
          <i style={tone("var(--warn)")} />
          客户端断开
        </span>
      ) : null}
      {attribution ? (
        <span className="credit">
          {attribution.url ? (
            <a href={attribution.url} target="_blank" rel="noreferrer">
              {attribution.text}
            </a>
          ) : (
            <em>{attribution.text}</em>
          )}
        </span>
      ) : null}
    </div>
  );
}
