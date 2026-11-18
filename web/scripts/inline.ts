// Inlines the script and stylesheet of dist-single/index.html into the HTML file itself, so the
// preview opens from disk with no server.
// Usage: bun scripts/inline.ts [--config <config.json>] [--sample <sample.json>] [--out <file.html>]
// The config file follows ScreenConfig (src/core/config.ts). A logo given as a file path, relative
// to the config file, is embedded as a data URI. --sample replaces the built-in synthetic sample
// with the given file (the PreviewData shape of src/preview/sim.ts) in this one output file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";

const dist = join(import.meta.dir, "..", "dist-single");
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const configPath = option("--config");
const samplePath = option("--sample");
const out = option("--out") ?? join(dist, "request-monitor.html");

let html = readFileSync(join(dist, "index.html"), "utf8");
const read = (href: string) => readFileSync(join(dist, href.replace(/^\.?\//, "")), "utf8");

html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_tag, href: string) => `<style>${read(href)}</style>`);
// A literal "</script" inside the bundle would end the inline script element early.
const safe = (code: string) => code.replace(/<\/script/gi, "<\\/script");
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_tag, src: string) => `<script type="module">${safe(read(src))}</script>`);
html = html.replace(/<link rel="icon"[^>]*>/g, "");
if (/(src|href)="\.?\/assets\//.test(html)) throw new Error("an asset reference is left in the HTML");

if (configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { title?: unknown; logo?: Record<string, string> };
  if (typeof config.title === "string" && config.title.trim() !== "") {
    const title = config.title.trim().slice(0, 40).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  }
  const types: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
  for (const key of ["day", "night"]) {
    const value = config.logo?.[key];
    if (!value || /^(https?:|data:)/i.test(value)) continue;
    const file = isAbsolute(value) ? value : join(dirname(configPath), value);
    const type = types[extname(file).toLowerCase()];
    if (!existsSync(file) || !type) throw new Error(`logo.${key}: ${file} is missing or not an SVG, PNG, or WebP file`);
    config.logo![key] = `data:${type};base64,${readFileSync(file).toString("base64")}`;
  }
  const tag = `<script>window.__OPS_CONFIG__=${safe(JSON.stringify(config)).replace(/</g, "\\u003c")};</script>`;
  if (!html.includes("</head>")) throw new Error("no </head> to put the config before");
  html = html.replace("</head>", `${tag}</head>`);
}
if (samplePath) {
  const sample = JSON.stringify(JSON.parse(readFileSync(samplePath, "utf8")));
  const tag = `<script>window.__OPS_SAMPLE__=${safe(sample).replace(/</g, "\\u003c")};</script>`;
  if (!html.includes("</head>")) throw new Error("no </head> to put the sample before");
  html = html.replace("</head>", `${tag}</head>`);
}
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KiB)${configPath ? ` with ${configPath}` : ""}${samplePath ? ` and sample ${samplePath}` : ""}`);
