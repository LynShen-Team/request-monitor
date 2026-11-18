/**
 * A colour theme: CSS variables for the panels and hex colours for the WebGL scene. The palette
 * is a neutral ground, one blue accent, a teal for dispatch, and green, amber, and red for status.
 */
export interface Theme {
  id: "night" | "day";
  /** A light ground: the scene blends normally instead of additively. */
  light: boolean;
  css: Record<string, string>;
  scene: {
    bg: number;
    ocean: number;
    land: number;
    /** Coastline and graticule: a glow on the dark theme, an ink line on the light one. */
    coast: number;
    rim: number;
    atmosphere: number;
    /**
     * Request arcs (user to gateway) and dispatch arcs (gateway to upstream). Each pair passes the
     * dataviz palette validator on its surface (colour-vision separation, lightness band, contrast).
     */
    in: number;
    out: number;
    ok: number;
    err: number;
    gone: number;
    gateway: number;
  };
}

export const NIGHT: Theme = {
  id: "night",
  light: false,
  css: {
    "--bg": "#0a0a0a",
    "--panel": "rgba(18, 18, 18, 0.74)",
    "--panel-solid": "#141414",
    "--line": "rgba(255, 255, 255, 0.10)",
    "--line-soft": "rgba(255, 255, 255, 0.06)",
    "--line-strong": "rgba(255, 255, 255, 0.24)",
    "--fill": "rgba(255, 255, 255, 0.08)",
    "--text": "#ededed",
    "--text-2": "#a3a3a3",
    "--text-3": "#737373",
    "--accent": "#3b82f6",
    "--accent-2": "#14a89a",
    "--ok": "#4ade80",
    "--warn": "#f9d361",
    "--err": "#f87171",
  },
  scene: { bg: 0x0a0a0a, ocean: 0x07090e, land: 0x131924, coast: 0x2f6fd8, rim: 0x3b82f6, atmosphere: 0x2f74ee, in: 0x3b82f6, out: 0x14a89a, ok: 0x4ade80, err: 0xf87171, gone: 0xf9d361, gateway: 0xffffff },
};

export const DAY: Theme = {
  id: "day",
  light: true,
  css: {
    "--bg": "#f4f6f9",
    "--panel": "rgba(255, 255, 255, 0.86)",
    "--panel-solid": "#ffffff",
    "--line": "rgba(15, 23, 42, 0.10)",
    "--line-soft": "rgba(15, 23, 42, 0.06)",
    "--line-strong": "rgba(15, 23, 42, 0.26)",
    "--fill": "rgba(15, 23, 42, 0.06)",
    "--text": "#171717",
    "--text-2": "#5c5f66",
    "--text-3": "#8b8f97",
    "--accent": "#1a6ef4",
    "--accent-2": "#0d9488",
    "--ok": "#15803d",
    "--warn": "#b45309",
    "--err": "#dc2626",
  },
  scene: { bg: 0xf4f6f9, ocean: 0xcbdbf2, land: 0xfcfdfe, coast: 0x7d92b6, rim: 0x4f86ea, atmosphere: 0x6b9cf2, in: 0x1a6ef4, out: 0x0d9488, ok: 0x16a34a, err: 0xdc2626, gone: 0xd97706, gateway: 0x1a6ef4 },
};
