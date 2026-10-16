import { useCallback, useSyncExternalStore } from "react";

export type DocTab = "edit" | "ci" | "activity" | "details";
export const DOC_TABS: readonly DocTab[] = ["edit", "ci", "activity", "details"];

export type Route =
  | { name: "home" }
  | { name: "doc"; id: string; tab: DocTab }
  | { name: "templates" }
  | { name: "settings" };

/** Hash routes keep deep links, reload and the back button working with no server routing (Vercel serves one page). */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [head, a, b] = parts;
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
  if (head === "settings") return { name: "settings" };
  return { name: "home" };
}

export function buildRoute(r: Route): string {
  switch (r.name) {
    case "home": return "#/";
    case "templates": return "#/templates";
    case "settings": return "#/settings";
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
