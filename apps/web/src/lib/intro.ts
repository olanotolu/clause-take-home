const KEY = "clause-intro-seen";

export function introSeen(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function markIntroSeen(): void {
  try { localStorage.setItem(KEY, "1"); } catch { /* private window: it simply shows again next time */ }
}

/**
 * The intro appears on a first visit to the bare address only. Any deep link (a document, a request, settings) and any
 * unrecognised hash goes straight to what was asked for, and `#/welcome` replays it on demand.
 */
export function shouldShowIntro(hash: string, seen: boolean): boolean {
  if (hash === "#/welcome") return true;
  return !seen && (hash === "" || hash === "#" || hash === "#/");
}
