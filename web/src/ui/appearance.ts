import { useEffect, useState } from "react";
import { DAY, NIGHT } from "../scene/theme";

/** `auto` shows the day theme during the day hours of the viewer's own clock, the night theme otherwise. */
export type AppearanceMode = "auto" | "day" | "night";

/** Day runs from 07:00 to 18:00 local time unless `?day=<start>-<end>` (hours) says otherwise. */
const DEFAULT_DAY: [number, number] = [7, 18];
const MODE_KEY = "ops-theme-mode";

function dayHours(params: URLSearchParams): [number, number] {
  const match = /^(\d{1,2}(?:\.\d+)?)-(\d{1,2}(?:\.\d+)?)$/.exec(params.get("day") ?? "");
  if (!match) return DEFAULT_DAY;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start < 24 && end <= 24 && start !== end ? [start, end] : DEFAULT_DAY;
}

function isDay(now: number, [start, end]: [number, number]): boolean {
  const date = new Date(now);
  const hour = date.getHours() + date.getMinutes() / 60;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * The theme in effect and its control. `?theme=auto|day|night` overrides the saved choice.
 * `fixedNow` replaces the wall clock (frame-stepped captures), so the result is reproducible.
 */
export function useAppearance(params: URLSearchParams, fixedNow: number | null) {
  const [mode, setMode] = useState<AppearanceMode>(() => {
    const param = params.get("theme");
    if (param === "day" || param === "night" || param === "auto") return param;
    const saved = localStorage.getItem(MODE_KEY);
    return saved === "day" || saved === "night" ? saved : "auto";
  });
  const [now, setNow] = useState(() => fixedNow ?? Date.now());
  const [hours] = useState(() => dayHours(params));

  useEffect(() => {
    if (fixedNow !== null) return;
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, [fixedNow]);

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  return {
    theme: mode === "day" || (mode === "auto" && isDay(now, hours)) ? DAY : NIGHT,
    mode,
    hours,
    cycleMode: () => setMode((current) => (current === "auto" ? "day" : current === "day" ? "night" : "auto")),
  };
}
