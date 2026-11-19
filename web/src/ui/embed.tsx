import { embedLang, type Lang } from "../core/embed";
import type { Snapshot } from "../core/engine";

/**
 * The embed page's figures (docs/spec-screen.md OS-E1): live state, requests per second, success
 * rate, and median time to first token, over the scene. Labelled in the language of the page that
 * embeds it (`?lang=`), since that page's visitors read them.
 */

const TEXT: Record<Lang, { live: string; nearLive: string; replay: string; rps: string; success: string; ttfb: string; seconds: string; gate: string; failed: string }> = {
  zh: { live: "实时", nearLive: "准实时", replay: "近 24 小时", rps: "每秒请求", success: "成功率", ttfb: "首字延迟", seconds: "秒", gate: "登录后可看", failed: "正在重新连接" },
  "zh-TW": { live: "即時", nearLive: "準即時", replay: "近 24 小時", rps: "每秒請求", success: "成功率", ttfb: "首字延遲", seconds: "秒", gate: "登入後可看", failed: "正在重新連線" },
  en: { live: "Live", nearLive: "Near live", replay: "Last 24 hours", rps: "Requests / s", success: "Success", ttfb: "First token", seconds: "s", gate: "Sign in to view", failed: "Reconnecting" },
  ja: { live: "リアルタイム", nearLive: "準リアルタイム", replay: "直近 24 時間", rps: "リクエスト / 秒", success: "成功率", ttfb: "初回トークン", seconds: "秒", gate: "ログインすると表示", failed: "再接続中" },
};

export function EmbedFigures({ snap, lang, state }: { snap: Snapshot; lang: string | null; state: "open" | "gate" | "failed" | "loading" }) {
  const t = TEXT[embedLang(lang)];
  const { kpi } = snap;
  const ready = state === "open" && snap.ready;
  const live = snap.mode === "live";
  const rps = kpi.rps >= 100 ? kpi.rps.toFixed(0) : kpi.rps.toFixed(kpi.rps >= 10 ? 1 : 2);
  const ok = kpi.successRate;
  const scope = state === "gate" ? t.gate : state === "failed" ? t.failed : !live ? t.replay : snap.caps.live === "replayed" ? t.nearLive : t.live;
  return (
    <div className="embed-figures">
      <div className="embed-scope">
        {ready && live ? <span className="live-dot" /> : null}
        {scope}
      </div>
      <div className="embed-figure">
        <div className="embed-label">{t.rps}</div>
        <div className="embed-value num">{ready ? rps : "—"}</div>
      </div>
      {snap.caps.errors ? (
        <div className="embed-figure">
          <div className="embed-label">{t.success}</div>
          <div className="embed-value num">
            {ready ? (ok * 100).toFixed(ok >= 0.9995 ? 0 : 1) : "—"}
            {ready ? <em>%</em> : null}
          </div>
        </div>
      ) : null}
      <div className="embed-figure">
        <div className="embed-label">{t.ttfb}</div>
        <div className="embed-value num">
          {ready && kpi.ttfbP50 > 0 ? (kpi.ttfbP50 / 1000).toFixed(2) : "—"}
          {ready && kpi.ttfbP50 > 0 ? <em>{t.seconds}</em> : null}
        </div>
      </div>
    </div>
  );
}
