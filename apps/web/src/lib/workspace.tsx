import { selectorFor, type Target } from "@clause/engine";
import { toast as sonner } from "sonner";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type ApiError, type Change, type CiReport, type Doc, type DocResult, type DocSummary, type Evidence, type Hit, type Preview, type RequestCreate, type RequestPatch, type RequestStatus, type SearchPage, type WorkRequest } from "./api.ts";
import { navigate, useRoute } from "./router.ts";
import type { Range } from "./segments.ts";
import { useSettings } from "./settings.tsx";

export interface Staged {
  id: number;
  target: Target;
  replacement: string;
  start: number;
  end: number;
  text: string;
}

export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "valid"; data: Preview }
  | { status: "invalid"; error: ApiError };

export type CiState = { status: "idle" } | { status: "loading" } | { status: "done"; report: CiReport } | { status: "error"; message: string };

export interface Toast {
  tone: "info" | "pass" | "fail";
}

interface Workspace {
  docs: DocSummary[];
  docsStatus: { kind: "loading" | "error" | "ready"; message?: string };
  doc: Doc | null;
  /** True while the route names a document that has not finished loading. */
  opening: boolean;
  selection: { start: number; end: number } | null;
  setSelection: (s: { start: number; end: number } | null) => void;
  staged: Staged[];
  preview: PreviewState;
  redline: boolean;
  setRedline: (v: boolean) => void;
  hits: Range[];
  setSearchPage: (p: SearchPage | null) => void;
  conflict: { currentVersion?: number | undefined } | null;
  applying: boolean;
  refreshKey: number;
  /** Bumps whenever the document's saved requirements change, so lists and reports can refresh. */
  rulesKey: number;
  bumpRules: () => void;
  ci: CiState;
  goal: string;
  setGoal: (g: string) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
  openDoc: (id: string) => Promise<void>;
  refreshDocs: () => Promise<DocSummary[]>;
  stage: (replacement: string) => void;
  removeStaged: (id: number) => void;
  clearStaged: () => void;
  apply: () => Promise<void>;
  reload: () => Promise<void>;
  stageSuggested: (items: Omit<Staged, "id">[], ci?: CiReport | null) => void;
  restore: (toVersion: number) => Promise<void>;
  create: (title: string, content: string) => Promise<string | null>;
  runCi: () => Promise<void>;
  showEvidence: (e: Evidence) => void;
  pickHit: (result: DocResult, hit: Hit) => void;
  protect: (text: string) => Promise<void>;
  /** The text a CLAUSE CI report was judged against on the "after" side. */
  proposedText: string;
  requests: WorkRequest[];
  requestsStatus: { kind: "loading" | "error" | "ready"; message?: string };
  refreshRequests: () => Promise<void>;
  createRequest: (input: RequestCreate) => Promise<WorkRequest | null>;
  /** Optimistic: the board moves immediately and snaps back with a message if the server refuses. */
  patchRequest: (id: string, patch: RequestPatch) => Promise<void>;
  removeRequest: (id: string) => Promise<void>;
  /** Id of the request whose Clause CI audit is running. */
  checkingRequest: string | null;
  checkRequest: (id: string) => Promise<void>;
  /** The "New request" dialog; `status` preselects the column it was opened from. */
  newRequest: { open: boolean; status?: RequestStatus; documentId?: string };
  setNewRequest: (v: { open: boolean; status?: RequestStatus; documentId?: string }) => void;
  /** The "New document" dialog lives in the shell; anything can ask for it. */
  newDocOpen: boolean;
  setNewDocOpen: (v: boolean) => void;
}

const Ctx = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return v;
}

const toChanges = (staged: Staged[]): Change[] => staged.map((s) => ({ operation: "replace" as const, target: s.target, replacement: s.replacement }));

/** A CI report describes ONE exact combination: document, version, edit batch, requirements. Any change makes it stale. */
export const batchKey = (docId: string, version: number, items: { target: Target; replacement: string }[], rulesKey: number): string =>
  JSON.stringify([docId, version, rulesKey, items.map((s) => [s.target, s.replacement])]);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const route = useRoute();
  const { settings } = useSettings();
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [docsStatus, setDocsStatus] = useState<Workspace["docsStatus"]>({ kind: "loading" });
  const [doc, setDoc] = useState<Doc | null>(null);
  const [opening, setOpening] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [redline, setRedline] = useState(false);
  const [searchPage, setSearchPage] = useState<SearchPage | null>(null);
  const [conflict, setConflict] = useState<{ currentVersion?: number | undefined } | null>(null);
  const [applying, setApplying] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [rulesKey, setRulesKey] = useState(0);
  const [ciRaw, setCiRaw] = useState<{ key: string; state: CiState } | null>(null);
  const [goal, setGoal] = useState("");
  const [newDocOpen, setNewDocOpen] = useState(false);
  const [requests, setRequests] = useState<WorkRequest[]>([]);
  const [requestsStatus, setRequestsStatus] = useState<Workspace["requestsStatus"]>({ kind: "loading" });
  const [checkingRequest, setCheckingRequest] = useState<string | null>(null);
  const [newRequest, setNewRequest] = useState<Workspace["newRequest"]>({ open: false });
  const nextId = useRef(1);

  // sonner owns stacking, timing, swipe-to-dismiss and the aria-live region; failures stay a little longer than successes.
  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    if (tone === "pass") sonner.success(text, { duration: 5000 });
    else if (tone === "fail") sonner.error(text, { duration: 8000 });
    else sonner(text, { duration: 5000 });
  }, []);

  const refreshDocs = useCallback(async () => {
    const r = await api.list();
    if (r.ok) {
      setDocs(r.data.items);
      setDocsStatus({ kind: "ready" });
      return r.data.items;
    }
    setDocsStatus({ kind: "error", message: r.error.error });
    return [];
  }, []);

  const openDoc = useCallback(async (id: string) => {
    setOpening(true);
    const r = await api.get(id);
    setOpening(false);
    if (!r.ok) {
      toast(r.status === 404 ? "That document no longer exists." : r.error.error, "fail");
      navigate({ name: "home" });
      return;
    }
    setDoc(r.data);
    setSelection(null);
    setStaged([]);
    setConflict(null);
    setPreview({ status: "idle" });
    setRedline(false);
    setGoal("");
  }, [toast]);

  const refreshRequests = useCallback(async () => {
    const r = await api.requests();
    if (r.ok) {
      setRequests(r.data.items);
      setRequestsStatus({ kind: "ready" });
    } else setRequestsStatus({ kind: "error", message: r.error.error });
  }, []);

  useEffect(() => void refreshDocs(), [refreshDocs]);
  useEffect(() => void refreshRequests(), [refreshRequests]);

  const createRequest = useCallback(async (input: RequestCreate) => {
    const r = await api.createRequest(input);
    if (!r.ok) {
      toast(r.error.error, "fail");
      return null;
    }
    setRequests((cur) => [r.data, ...cur]);
    return r.data;
  }, [toast]);

  const patchRequest = useCallback(async (id: string, patch: RequestPatch) => {
    let before: WorkRequest | undefined;
    setRequests((cur) => cur.map((x) => (x.id === id ? ((before = x), { ...x, ...patch, updatedAt: new Date().toISOString() }) : x)));
    const r = await api.patchRequest(id, patch);
    if (r.ok) setRequests((cur) => cur.map((x) => (x.id === id ? r.data : x)));
    else {
      if (before) setRequests((cur) => cur.map((x) => (x.id === id ? before! : x)));
      toast(r.error.error, "fail");
    }
  }, [toast]);

  const removeRequest = useCallback(async (id: string) => {
    const r = await api.deleteRequest(id);
    if (!r.ok) return toast(r.error.error, "fail");
    setRequests((cur) => cur.filter((x) => x.id !== id));
    toast("Request deleted. The document and its history are untouched.");
  }, [toast]);

  const checkRequest = useCallback(async (id: string) => {
    setCheckingRequest(id);
    const r = await api.checkRequest(id);
    setCheckingRequest(null);
    if (!r.ok) return toast(r.error.error, "fail");
    setRequests((cur) => cur.map((x) => (x.id === id ? r.data.request : x)));
    const ci = r.data.request.ci;
    if (ci) toast(ci.attention === 0 ? `All ${ci.total} requirement${ci.total === 1 ? "" : "s"} hold in v${ci.version}.` : `${ci.attention} of ${ci.total} requirement${ci.total === 1 ? "" : "s"} need attention${r.data.moved ? "; moved to Needs review" : ""}.`, ci.attention === 0 ? "pass" : "fail");
  }, [toast]);

  // The route is the source of truth for which document is open.
  const routeDocId = route.name === "doc" ? route.id : null;
  useEffect(() => {
    if (routeDocId && routeDocId !== doc?.id) void openDoc(routeDocId);
  }, [routeDocId, doc?.id, openDoc]);

  // Validate the staged batch against the version on screen: the same engine call PATCH uses.
  const previewSeq = useRef(0);
  useEffect(() => {
    if (!doc || staged.length === 0) return setPreview({ status: "idle" });
    const mine = ++previewSeq.current;
    setPreview({ status: "loading" });
    void api.preview(doc.id, doc.version, toChanges(staged)).then((r) => {
      if (mine !== previewSeq.current) return;
      if (r.ok) setPreview({ status: "valid", data: r.data });
      else {
        setPreview({ status: "invalid", error: r.error });
        if (r.error.type === "VERSION_CONFLICT" || r.error.type === "PRECONDITION_FAILED") setConflict({ currentVersion: r.error.details?.currentVersion });
      }
    });
  }, [doc, staged]);

  useEffect(() => {
    if (settings.autoRedline && preview.status === "valid") setRedline(true);
  }, [preview, settings.autoRedline]);

  // The report only counts while it still describes what is on screen.
  const currentKey = doc ? batchKey(doc.id, doc.version, staged, rulesKey) : "";
  const ci: CiState = ciRaw && ciRaw.key === currentKey ? ciRaw.state : { status: "idle" };

  const runCi = useCallback(async () => {
    if (!doc) return;
    const key = batchKey(doc.id, doc.version, staged, rulesKey);
    setCiRaw({ key, state: { status: "loading" } });
    const r = await api.check(doc.id, doc.version, toChanges(staged), goal.trim() || undefined, settings.strictness);
    setCiRaw((cur) => (cur && cur.key !== key ? cur : { key, state: r.ok ? { status: "done", report: r.data } : { status: "error", message: r.error.error } }));
  }, [doc, staged, rulesKey, goal, settings.strictness]);

  const showEvidence = useCallback((e: Evidence) => setSelection({ start: e.start, end: e.end }), []);

  const hits: Range[] = useMemo(() => {
    const r = searchPage?.results.find((x) => x.documentId === doc?.id);
    if (!r || r.version !== doc?.version) return [];
    return r.hits.flatMap((h) => (h.start !== undefined && h.end !== undefined ? [{ start: h.start, end: h.end, kind: "hit" as const }] : []));
  }, [searchPage, doc]);

  const pickHit = useCallback((result: DocResult, hit: Hit) => {
    void (async () => {
      if (result.documentId !== doc?.id) {
        navigate({ name: "doc", id: result.documentId, tab: "edit" });
        await openDoc(result.documentId);
      } else {
        navigate({ name: "doc", id: result.documentId, tab: "edit" });
      }
      if (hit.start !== undefined && hit.end !== undefined) setSelection({ start: hit.start, end: hit.end });
    })();
  }, [doc?.id, openDoc]);

  const stage = useCallback((replacement: string) => {
    if (!doc || !selection) return;
    const text = doc.content.slice(selection.start, selection.end);
    setStaged((s) => [...s, { id: nextId.current++, target: selectorFor(doc.content, selection.start, selection.end), replacement, ...selection, text }]);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [doc, selection]);

  const apply = useCallback(async () => {
    if (!doc || staged.length === 0) return;
    if (settings.confirmApply && !window.confirm(`Apply ${staged.length} change${staged.length === 1 ? "" : "s"} as a new version of “${doc.title}”? Earlier versions are kept.`)) return;
    setApplying(true);
    const r = await api.apply(doc.id, doc.version, toChanges(staged));
    setApplying(false);
    if (r.ok) {
      setDoc({ ...doc, content: r.data.content, version: r.data.version, contentHash: r.data.afterHash });
      setStaged([]);
      setSelection(null);
      setRedline(false);
      toast(`Applied: v${r.data.previousVersion} → v${r.data.version} · sha256 ${r.data.afterHash.slice(0, 10)}…`, "pass");
      setRefreshKey((k) => k + 1);
      void refreshDocs();
    } else if (r.error.type === "VERSION_CONFLICT" || r.error.type === "PRECONDITION_FAILED") {
      setConflict({ currentVersion: r.error.details?.currentVersion });
    } else {
      setPreview({ status: "invalid", error: r.error });
    }
  }, [doc, staged, settings.confirmApply, toast, refreshDocs]);

  const reload = useCallback(async () => {
    if (!doc) return;
    const r = await api.get(doc.id);
    if (!r.ok) return toast(r.error.error, "fail");
    setDoc(r.data); // staged changes are kept; the effect above re-validates them
    setConflict(null);
    setRefreshKey((k) => k + 1);
    void refreshDocs();
  }, [doc, toast, refreshDocs]);

  const stageSuggested = useCallback((items: Omit<Staged, "id">[], suggestionCi?: CiReport | null) => {
    if (doc && suggestionCi && staged.length === 0) {
      // The proposal was already checked as exactly this batch; show that report instead of making the user re-run it.
      setCiRaw({ key: batchKey(doc.id, doc.version, items, rulesKey), state: { status: "done", report: suggestionCi } });
    }
    setStaged((s) => [...s, ...items.map((i) => ({ ...i, id: nextId.current++ }))]);
  }, [doc, staged.length, rulesKey]);

  const restore = useCallback(async (toVersion: number) => {
    if (!doc) return;
    const r = await api.revert(doc.id, doc.version, toVersion);
    if (r.ok) {
      if (r.data.changed) {
        setDoc({ ...doc, content: r.data.content, version: r.data.version, contentHash: r.data.afterHash });
        setSelection(null);
        setRedline(false);
        toast(`Restored the text of v${toVersion} as v${r.data.version}. Nothing was deleted.`, "pass");
        setRefreshKey((k) => k + 1);
        void refreshDocs();
      } else {
        toast(`The document already has the text of v${toVersion}; no new version was created.`);
      }
    } else if (r.error.type === "VERSION_CONFLICT" || r.error.type === "PRECONDITION_FAILED") {
      setConflict({ currentVersion: r.error.details?.currentVersion });
      navigate({ name: "doc", id: doc.id, tab: "edit" });
    } else {
      toast(r.error.error, "fail");
    }
  }, [doc, toast, refreshDocs]);

  const create = useCallback(async (title: string, content: string) => {
    const r = await api.create(title, content);
    if (!r.ok) {
      toast(r.error.error, "fail");
      return null;
    }
    await refreshDocs();
    navigate({ name: "doc", id: r.data.id, tab: "edit" });
    return r.data.id;
  }, [toast, refreshDocs]);

  const protect = useCallback(async (text: string) => {
    if (!doc) return;
    const r = await api.addRequirement(doc.id, "unchanged", text);
    if (!r.ok) return toast(r.error.error, "fail");
    setRulesKey((k) => k + 1);
    toast("Protected: this passage must survive every edit. It is now a requirement.", "pass");
  }, [doc, toast]);

  const proposedText = preview.status === "valid" ? preview.data.proposedContent : (doc?.content ?? "");

  const value: Workspace = {
    docs, docsStatus, doc, opening, selection, setSelection, staged, preview, redline, setRedline, hits, setSearchPage, conflict, applying,
    refreshKey, rulesKey, bumpRules: () => setRulesKey((k) => k + 1), ci, goal, setGoal, toast, openDoc, refreshDocs, stage,
    removeStaged: (id) => setStaged((s) => s.filter((x) => x.id !== id)), clearStaged: () => setStaged([]), apply, reload, stageSuggested, restore,
    create, runCi, showEvidence, pickHit, protect, proposedText, newDocOpen, setNewDocOpen,
    requests, requestsStatus, refreshRequests, createRequest, patchRequest, removeRequest, checkingRequest, checkRequest, newRequest, setNewRequest,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
