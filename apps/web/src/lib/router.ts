import { useCallback, useSyncExternalStore } from "react";

export type DocTab = "edit" | "ci" | "activity" | "details";
export const DOC_TABS: readonly DocTab[] = ["edit", "ci", "activity", "details"];

export type Route =
  /** The workspace board. `request` names the request whose panel is open. */
  | { name: "home"; request?: string }
  | { name: "documents" }
  | { name: "doc"; id: string; tab: DocTab }
  | { name: "playbooks"; id?: string }
  | { name: "activity" }
  | { name: "integrations" }
  | { name: "templates" }
  | { name: "settings"; section?: "general" | "ai" | "editing" | "security" | "appearance" | "usage" | "planned" };

/** Hash routes keep deep links, reload and the back button working with no server routing (Vercel serves one page). */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("?", 1)[0]!.split("/").filter(Boolean);
  const [head, a, b] = parts;
  const settingsSections = ["general", "ai", "editing", "security", "appearance", "usage", "planned"] as const;
  const section = (value: string | undefined) => settingsSections.find((item) => item === value);
  const decode = (v: string): string | null => {
    try {
      return decodeURIComponent(v);
    } catch {
      return null;
    }
  };
  if (head === "request" && a) {
    const id = decode(a);
    return id === null ? { name: "home" } : { name: "home", request: id };
  }
  if (head === "documents") return { name: "documents" };
  if (head === "activity") return { name: "activity" };
  if (head === "integrations") return { name: "integrations" };
  if (head === "playbooks") {
    const id = a ? decode(a) : null;
    return id ? { name: "playbooks", id } : { name: "playbooks" };
  }
  if (head === "doc" && a) {
    let id: string;
    try {
      id = decodeURIComponent(a);
    } catch {
      return { name: "home" };
    }
    const tab = DOC_TABS.find((t) => t === b) ?? "edit";
    return { name: "doc", id, tab };
  }
  if (head === "templates") return { name: "templates" };
  if (head === "settings") {
    const settingsSection = section(a);
    return settingsSection ? { name: "settings", section: settingsSection } : { name: "settings" };
  }
  // Older settings links use a bare hash, for example /#ai or /#security.
  const legacySection = section(head);
  if (legacySection) return { name: "settings", section: legacySection };
  return { name: "home" };
}

export function buildRoute(r: Route): string {
  switch (r.name) {
    case "home": return r.request ? `#/request/${encodeURIComponent(r.request)}` : "#/";
    case "documents": return "#/documents";
    case "activity": return "#/activity";
    case "integrations": return "#/integrations";
    case "playbooks": return r.id ? `#/playbooks/${encodeURIComponent(r.id)}` : "#/playbooks";
    case "templates": return "#/templates";
    case "settings": return r.section ? `#/settings/${r.section}` : "#/settings";
    case "doc": return `#/doc/${encodeURIComponent(r.id)}/${r.tab}`;
  }
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
const snapshot = () => window.location.hash;

export function navigate(r: Route): void {
  const next = buildRoute(r);
  if (window.location.hash !== next) window.location.hash = next;
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => "");
  return parseRoute(hash);
}

export function useNavigate() {
  return useCallback((r: Route) => navigate(r), []);
}
