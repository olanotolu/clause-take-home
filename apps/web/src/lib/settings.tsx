import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULTS, parseSettings, STORAGE_KEY, type Settings } from "./settings-core.ts";

interface Ctx {
  settings: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
}

const SettingsContext = createContext<Ctx>({ settings: DEFAULTS, set: () => {}, reset: () => {} });
export const useSettings = () => useContext(SettingsContext);

// Storage can throw (private windows, blocked site data); the app must work without it.
const read = () => {
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULTS;
  }
};
const write = (s: Settings) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* in-memory only */
  }
};

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(read);

  const set = useCallback<Ctx["set"]>((key, value) => setSettings((s) => { const next = { ...s, [key]: value }; write(next); return next; }), []);
  const reset = useCallback(() => { write(DEFAULTS); setSettings(DEFAULTS); }, []);

  const value = useMemo(() => ({ settings, set, reset }), [settings, set, reset]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
