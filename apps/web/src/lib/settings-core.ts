/** Per-browser preferences. Pure (no React, no DOM) so it can be tested; the hook lives in settings.tsx. */
export interface Settings {
  dateFormat: "locale" | "iso" | "us" | "eu";
  /** Show the AI tab (suggestions). Hiding it changes the screen only; the server route is unaffected. */
  aiTab: boolean;
  /** `strict` is sent to /changes/check: a semantic PASS needs every judge to be at least 80% sure. */
  strictness: "balanced" | "strict";
  confirmApply: boolean;
  showHash: boolean;
  /** Switch to the redline view automatically once a staged change validates. */
  autoRedline: boolean;
}

export const DEFAULTS: Settings = { dateFormat: "locale", aiTab: true, strictness: "balanced", confirmApply: false, showHash: false, autoRedline: false };

export const STORAGE_KEY = "clause.settings.v1";

const CHOICES = {
  dateFormat: ["locale", "iso", "us", "eu"],
  strictness: ["balanced", "strict"],
} as const;

/** Accepts anything (corrupt JSON, an old shape, a hand-edited value) and returns valid settings; bad fields fall back to defaults. */
export function parseSettings(raw: string | null | undefined): Settings {
  let obj: Record<string, unknown> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
  } catch {
    /* fall through to defaults */
  }
  const pick = <K extends keyof typeof CHOICES>(k: K): Settings[K] => ((CHOICES[k] as readonly unknown[]).includes(obj[k]) ? (obj[k] as Settings[K]) : DEFAULTS[k]);
  const flag = (k: "aiTab" | "confirmApply" | "showHash" | "autoRedline") => (typeof obj[k] === "boolean" ? (obj[k] as boolean) : DEFAULTS[k]);
  return {
    dateFormat: pick("dateFormat"),
    strictness: pick("strictness"),
    aiTab: flag("aiTab"),
    confirmApply: flag("confirmApply"),
    showHash: flag("showHash"),
    autoRedline: flag("autoRedline"),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Formats an ISO timestamp for display. Invalid input is returned as-is rather than shown as "Invalid Date". */
export function formatDate(iso: string, format: Settings["dateFormat"]): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  switch (format) {
    case "iso": return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
    case "us": return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${time}`;
    case "eu": return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${time}`;
    default: return d.toLocaleString();
  }
}
