import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";
import SiBox from "@icons-pack/react-simple-icons/icons/SiBox";
import SiDropbox from "@icons-pack/react-simple-icons/icons/SiDropbox";
import SiGoogledrive from "@icons-pack/react-simple-icons/icons/SiGoogledrive";
import { ArrowRight, ChevronDown, ChevronRight, FileText, Search, Trash2 } from "../ui/icons.tsx";
import { useWorkspace } from "../lib/workspace.tsx";
import { navigate } from "../lib/router.ts";
import { Tabs } from "../ui/Tabs.tsx";
import { SearchPanel } from "../components/SearchPanel.tsx";
import { Button } from "../ui/Button.tsx";
import { useAuth } from "../lib/auth.tsx";
import { repositories, importRepositoryFile } from "../lib/api.ts";

type ProviderId = "imanage" | "netdocuments" | "onedrive" | "dropbox" | "google_drive" | "sharepoint" | "box";
interface Provider { id: ProviderId; name: string; description: string; connected: boolean; accountName: string | null; connectedAt: string | null }
interface RemoteFile { id: string; name: string; mimeType: string; folder: boolean; parentId?: string; driveId?: string; imported?: boolean }

const MOCK_PROVIDERS: Provider[] = [
  { id: "imanage", name: "iManage", description: "Legal documents and matter workspaces", connected: false, accountName: null, connectedAt: null },
  { id: "netdocuments", name: "NetDocuments", description: "Documents organized by workspace and matter", connected: false, accountName: null, connectedAt: null },
  { id: "onedrive", name: "OneDrive", description: "Personal and shared work files", connected: false, accountName: null, connectedAt: null },
  { id: "dropbox", name: "Dropbox", description: "Files and folders from your Dropbox", connected: false, accountName: null, connectedAt: null },
  { id: "google_drive", name: "Google Drive", description: "Docs, PDFs, Word files, and shared drives", connected: false, accountName: null, connectedAt: null },
  { id: "sharepoint", name: "SharePoint", description: "Team sites and document libraries", connected: false, accountName: null, connectedAt: null },
  { id: "box", name: "Box", description: "Secure files and folders from Box", connected: false, accountName: null, connectedAt: null },
];

function ProviderLogo({ provider }: { provider: ProviderId }) {
  if (provider === "google_drive") return <SiGoogledrive size={27} title="Google Drive" />;
  if (provider === "dropbox") return <SiDropbox size={27} title="Dropbox" />;
  if (provider === "box") return <SiBox size={28} title="Box" />;
  if (provider === "onedrive") return <svg viewBox="0 0 40 32" width="31" height="27" role="img" aria-label="OneDrive"><path fill="#0364B8" d="M15.6 8.3A10.4 10.4 0 0 1 34.8 13a8.2 8.2 0 0 1-1.3 16.3H13.2a8.2 8.2 0 0 1-1-16.3 10.4 10.4 0 0 1 3.4-4.7Z"/><path fill="#1490DF" d="M3 19.4a8.1 8.1 0 0 1 13.8-5.8L25 22l-4.9 7.3h-9A8.1 8.1 0 0 1 3 19.4Z"/><path fill="#28A8EA" d="m12.6 29.3 7-10.5 10.7 7.4a4.6 4.6 0 0 1-2.6 3.1Z"/></svg>;
  if (provider === "sharepoint") return <svg viewBox="0 0 40 36" width="30" height="28" role="img" aria-label="SharePoint"><circle cx="25.7" cy="9" r="7" fill="#03787C"/><circle cx="25.7" cy="27" r="7" fill="#038387"/><circle cx="12" cy="18" r="11" fill="#036C70"/><path fill="#fff" d="M10.4 11.4h3.4c3.3 0 5.1 1.6 5.1 4.1 0 1.6-.8 2.8-2.2 3.4 1.8.5 2.8 1.7 2.8 3.5 0 2.8-2 4.5-5.5 4.5h-3.6Zm3.2 6.5c1.4 0 2.1-.7 2.1-1.9s-.7-1.8-2.1-1.8h-.3v3.7Zm.4 6.4c1.6 0 2.4-.7 2.4-2s-.8-2-2.4-2h-.7v4Z"/></svg>;
  if (provider === "netdocuments") return <svg viewBox="0 0 40 40" width="29" height="29" role="img" aria-label="NetDocuments"><rect x="2" y="2" width="36" height="36" rx="9" fill="#0B4B8A"/><path d="M11 29V11h4l10 11V11h4v18h-4L15 18v11z" fill="white"/></svg>;
  return <svg viewBox="0 0 40 40" width="29" height="29" role="img" aria-label="iManage"><rect x="2" y="2" width="36" height="36" rx="9" fill="#123D5A"/><path d="M13 12h5v17h-5zm2.5-5a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6m8.2 10.2h4.7v2.1c.9-1.6 2.3-2.5 4.2-2.5v4.8c-2.8-.2-4.2 1.2-4.2 4V29h-4.7z" fill="white"/></svg>;
}

const DEMO_FILES: Record<ProviderId, RemoteFile[]> = {
  imanage: [{ id: "im-1", name: "Mutual NDA - Redwood.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", folder: false }, { id: "im-2", name: "Services Agreement.pdf", mimeType: "application/pdf", folder: false }, { id: "im-3", name: "Matter correspondence.txt", mimeType: "text/plain", folder: false }],
  netdocuments: [{ id: "nd-1", name: "Vendor MSA - Northstar.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", folder: false }, { id: "nd-2", name: "Data Processing Addendum.pdf", mimeType: "application/pdf", folder: false }, { id: "nd-3", name: "Negotiation notes.txt", mimeType: "text/plain", folder: false }],
  onedrive: [{ id: "od-1", name: "Employment Agreement.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", folder: false }, { id: "od-2", name: "Board Consent.pdf", mimeType: "application/pdf", folder: false }, { id: "od-3", name: "Project Atlas", mimeType: "folder", folder: true }],
  dropbox: [{ id: "db-1", name: "Consulting Agreement.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", folder: false }, { id: "db-2", name: "Privacy Policy.pdf", mimeType: "application/pdf", folder: false }, { id: "db-3", name: "Contract templates", mimeType: "folder", folder: true }],
  google_drive: [{ id: "gd-1", name: "Mutual NDA - Acme Corp", mimeType: "application/vnd.google-apps.document", folder: false }, { id: "gd-2", name: "Order Form.pdf", mimeType: "application/pdf", folder: false }, { id: "gd-3", name: "Supplier Terms.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", folder: false }],
  sharepoint: [{ id: "sp-1", name: "Commercial", mimeType: "drive", folder: true }, { id: "sp-2", name: "Legal Operations", mimeType: "drive", folder: true }],
  box: [{ id: "bx-1", name: "Software License Agreement.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", folder: false }, { id: "bx-2", name: "Security Exhibit.pdf", mimeType: "application/pdf", folder: false }, { id: "bx-3", name: "Shared matters", mimeType: "folder", folder: true }],
};

function demoContent(file: RemoteFile, provider: ProviderId): string {
  const type = file.name.toLowerCase().endsWith(".pdf") ? "PDF" : file.name.toLowerCase().endsWith(".txt") ? "text file" : "Word document";
  return `${file.name}\n\nDEMO IMPORT — ${provider.replaceAll("_", " ")}\n\nThis sample ${type} was imported into CLAUSE to demonstrate the repository import flow. In a connected workspace, the extracted source text appears here for search and review.\n\nSample clause: Each party will protect the other party’s Confidential Information using reasonable safeguards and will use it only to perform its obligations under the agreement.`;
}

export function IntegrationsView() {
  const ws = useWorkspace();
  const auth=useAuth();
  const live=auth.user?.role==="admin";
  const importController=useRef<AbortController|null>(null);
  const [importProgress,setImportProgress]=useState(0);
  useEffect(()=>()=>{importController.current?.abort();},[]);
  const [providerListRef] = useAutoAnimate<HTMLDivElement>({ duration: 220, easing: "ease-out" });
  const [providers, setProviders] = useState<Provider[]>(MOCK_PROVIDERS);
  const [sideTab, setSideTab] = useState<"browse" | "search">("browse");
  const [active, setActive] = useState<ProviderId | null>(null);
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [parentId, setParentId] = useState("");
  const [driveId, setDriveId] = useState("");
  const [crumbs, setCrumbs] = useState<{ name: string; id: string; driveId: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [next, setNext] = useState<string | null>(null);

  useEffect(()=>{
    let current=true;
    if(live) void auth.bearer().then(async(token)=>{if(!token) return;const result=await repositories.list(token);if(current&&result.ok) setProviders(result.data.providers);});
    return ()=>{current=false;};
  },[live,auth.bearer]);

  const loadFiles = async (provider: ProviderId, folder = "", drive = "", append = false, _pageToken = "") => {
    setLoading(true); setError("");
    if(live) {
      const token=await auth.bearer();
      if(!token) {setError("Sign in to browse this repository.");setLoading(false);return;}
      const query=new URLSearchParams({... (folder?{parentId:folder}:{}),...(drive?{driveId:drive}:{}),...(_pageToken?{pageToken:_pageToken}:{})});
      const result=await repositories.files(provider,token,query);
      if(result.ok) {setFiles((current)=>append?[...current,...result.data.files]:result.data.files);setNext(result.data.nextPageToken);}
      else setError(result.error.error);
      setLoading(false);return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    let demoFiles = DEMO_FILES[provider];
    if (provider === "sharepoint" && drive) demoFiles = [{ id: `${drive}-folder`, name: "Active Matters", mimeType: "folder", folder: true }, { id: `${drive}-nda`, name: "SharePoint NDA.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", folder: false }, { id: `${drive}-pdf`, name: "Outside Counsel Guidelines.pdf", mimeType: "application/pdf", folder: false }];
    else if (folder) demoFiles = [{ id: `${folder}-sub`, name: "Supporting documents", mimeType: "folder", folder: true }, { id: `${folder}-txt`, name: "Matter summary.txt", mimeType: "text/plain", folder: false }];
    const files = demoFiles.map((file) => ({ ...file, imported: Boolean(localStorage.getItem(`clause-demo-import:${provider}:${file.id}`)) }));
    setFiles((current) => append ? [...current, ...files] : files);
    setNext(null);
    setLoading(false);
  };

  const openProvider = async (provider: Provider) => {
    setActive(provider.id); setSelected([]); setParentId(""); setDriveId(""); setCrumbs([]); setFiles([]); setNext(null);
    if (provider.connected) await loadFiles(provider.id);
  };
  const connect = async (provider: Provider) => {
    if(live) {const token=await auth.bearer();if(!token) return;const result=await repositories.connect(provider.id,token);if(result.ok) window.location.assign(result.data.url);else setError(result.error.error);return;}
    setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, connected: true, accountName: "demo@acme.example", connectedAt: new Date().toISOString() } : item));
    setActive(provider.id); setSelected([]); setParentId(""); setDriveId(""); setCrumbs([]);
    await loadFiles(provider.id);
    toast.success(`${provider.name} demo connected.`);
  };
  const disconnect = async (provider: Provider) => {
    if(live) {const token=await auth.bearer();if(!token) return;const result=await repositories.disconnect(provider.id,token);if(!result.ok) {setError(result.error.error);return;}}
    setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, connected: false, accountName: null, connectedAt: null } : item));
    if (active === provider.id) { setActive(null); setFiles([]); }
    toast.success(`${provider.name} disconnected.`);
  };
  const enterFolder = async (file: RemoteFile) => {
    if (!active) return;
    if (active === "sharepoint" && file.mimeType === "drive") {
      setDriveId(file.driveId ?? file.id); setParentId(""); setCrumbs([{ name: file.name, id: "", driveId: file.driveId ?? file.id }]); await loadFiles(active, "", file.driveId ?? file.id); return;
    }
    const id = file.id;
    setParentId(id); setCrumbs((c) => [...c, { name: file.name, id, driveId }]); await loadFiles(active, id, driveId);
  };
  const goToCrumb = async (index: number) => {
    if (!active) return;
    const crumb = crumbs[index];
    const folder = crumb?.id ?? "";
    const drive = crumb?.driveId ?? "";
    setCrumbs(crumbs.slice(0, index + 1)); setParentId(folder); setDriveId(drive); await loadFiles(active, folder, drive);
  };
  const importSelected = async () => {
    if (!active) return;
    setBusy(true); setError("");
    if(live) {
      const token=await auth.bearer();
      if(!token) {setBusy(false);return;}
      importController.current?.abort();
      const controller=new AbortController();importController.current=controller;
      try {
        for(const file of files.filter((item)=>selected.includes(item.id)&&!item.folder)) {
          const result=await importRepositoryFile(active,file,token,{signal:controller.signal,onProgress:setImportProgress});
          if(!result.ok) {setError(result.error.error);return;}
          setFiles((current)=>current.map((item)=>item.id===file.id?{...item,imported:true}:item));
        }
        await ws.refreshDocs();setSelected([]);toast.success("Documents imported.");
      } finally {setBusy(false);setImportProgress(0);}
      return;
    }
    const chosen = files.filter((file) => selected.includes(file.id) && !file.folder);
    let imported = 0;
    let alreadyImported = 0;
    for (const file of chosen) {
      if (localStorage.getItem(`clause-demo-import:${active}:${file.id}`)) { alreadyImported++; continue; }
      const documentId = await ws.create(file.name, demoContent(file, active));
      if (documentId) {
        localStorage.setItem(`clause-demo-import:${active}:${file.id}`, documentId);
        imported++;
      }
    }
    if (imported) toast.success(`${imported} ${imported === 1 ? "document" : "documents"} imported.`);
    else if (alreadyImported && !error) toast.info("Those documents were already imported.");
    setFiles((current) => current.map((file) => selected.includes(file.id) ? { ...file, imported: true } : file));
    setSelected([]); setBusy(false);
  };

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <header className="px-8 pb-5 pt-7 max-[640px]:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Workspace</p><h1 className="mt-1 text-2xl font-bold">Integrations</h1></div><span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-xs font-medium text-muted"><span className="size-1.5 rounded-full bg-accent" /> {live?"Connected repositories":"Interactive demo"}</span></div>
        <p className="mt-1 max-w-2xl text-sm text-muted">Bring a document into CLAUSE as searchable text. Your source file stays where it is.</p>
        <p className="mt-2 text-xs text-muted">{live?"Connect a repository and import a document. Large files continue in the background.":"Explore the setup and import flow with sample files. No repository account or sign-in is needed for this demo."}</p>
      </header>
      <div className="grid grid-cols-1 gap-5 px-8 pb-10 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)] max-[640px]:px-4">
        <section aria-label="Document repositories">
          <div ref={providerListRef} className="grid content-start gap-2 sm:grid-cols-2">
          {providers.map((provider) => (
            <motion.article key={provider.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -2 }} transition={{ duration: 0.2, ease: "easeOut" }} className={`rounded-card border bg-paper p-4 transition-colors ${active === provider.id ? "border-accent/50 shadow-soft" : "border-line"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-control bg-white ring-1 ring-line/70"><ProviderLogo provider={provider.id} /></span>
                  <div className="min-w-0"><h2 className="truncate font-semibold">{provider.name}</h2><p className="mt-0.5 text-xs leading-4 text-muted">{provider.description}</p></div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${provider.connected ? "bg-pass-bg text-pass" : "bg-line/60 text-muted"}`}>{provider.connected ? "Demo connected" : "Available"}</span>
              </div>
              {provider.connected && provider.accountName && <p className="mt-3 truncate text-xs text-muted">{provider.accountName}</p>}
              <div className="mt-4 flex items-center gap-2">
                {provider.connected ? <>
                  <Button size="sm" variant="secondary" onClick={() => void openProvider(provider)}>Browse files</Button>
                  <button type="button" onClick={() => void disconnect(provider)} disabled={busy} className="ml-auto inline-flex items-center gap-1 rounded-control px-2 py-1.5 text-xs text-muted hover:bg-line/60 hover:text-fail" aria-label={`Disconnect ${provider.name}`}><Trash2 size={14} /> Disconnect</button>
                </> : <Button size="sm" variant="secondary" disabled={busy} onClick={() => void connect(provider)}>Connect demo<ArrowRight size={14} /></Button>}
              </div>
            </motion.article>
          ))}
          </div>
        </section>

        <section className="flex min-h-72 min-w-0 flex-col overflow-hidden rounded-card border border-line bg-paper" aria-label="Repository browser and search">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div><h2 className="font-semibold">{active ? providers.find((p) => p.id === active)?.name : "Repository preview"}</h2><p className="text-xs text-muted">{active ? (live?"Select documents to import":"Select sample documents to import") : "Connect any repository to preview its files."}</p></div>
            {active && <button type="button" onClick={() => { setActive(null); setFiles([]); }} className="rounded-control px-2 py-1 text-xs text-muted hover:bg-line/60">Close</button>}
          </div>
          <Tabs tabs={[{ id: "browse", label: "Browse", icon: <FileText size={14} aria-hidden /> }, { id: "search", label: "Search", icon: <Search size={14} aria-hidden /> }]} value={sideTab} onChange={setSideTab} label="Integration side panel" idPrefix="integrations-side" className="shrink-0 border-b border-line bg-paper px-2" />
          <div id="integrations-side-panel" role="tabpanel" aria-labelledby={`integrations-side-${sideTab}`} className="flex min-h-0 flex-1 flex-col">
            <AnimatePresence mode="wait" initial={false}>
              {sideTab === "search" ? <motion.div key="integration-search" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.18 }} className="min-h-[430px] flex-1 p-4">
                <SearchPanel refreshKey={ws.refreshKey} seed={null} onResults={ws.setSearchPage} onOpen={(r) => navigate({ name: "doc", id: r.documentId, tab: "edit" })} onPick={ws.pickHit} />
              </motion.div> : <motion.div key="integration-browse" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.18 }} className="flex min-h-0 flex-1 flex-col">
          {!active && <div className="grid min-h-[430px] flex-1 place-items-center p-8 text-center"><div className="max-w-xs"><span className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent"><FileText size={23} aria-hidden /></span><h3 className="mt-4 text-sm font-semibold">Browse a repository</h3><p className="mt-1 text-sm leading-relaxed text-muted">Choose a connector on the left and connect the demo to see sample folders and documents here.</p></div></div>}
          {active && <>
            <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-3 py-2 text-xs text-muted">
              <button type="button" onClick={() => { setCrumbs([]); setParentId(""); void loadFiles(active, "", driveId); }} className="shrink-0 hover:text-ink">{active === "sharepoint" ? "Libraries" : "Files"}</button>
              {crumbs.map((crumb, i) => <span key={crumb.id} className="flex shrink-0 items-center gap-1"><ChevronRight size={12} /><button type="button" onClick={() => void goToCrumb(i)} className="max-w-36 truncate hover:text-ink">{crumb.name}</button></span>)}
            </div>
            {error && <p role="alert" className="mx-3 mt-3 rounded-control bg-fail-bg px-3 py-2 text-xs text-fail">{error}</p>}
            <div className="max-h-[460px] overflow-y-auto p-2">
              {loading && files.length === 0 && <p className="p-4 text-sm text-muted">Loading files…</p>}
              {!loading && files.length === 0 && <p className="p-4 text-sm text-muted">No files in this location.</p>}
              {files.map((file, index) => (
                <motion.div key={file.id} layout initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, delay: Math.min(index * 0.025, 0.18) }} className="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-canvas">
                  {file.folder ? <button type="button" onClick={() => void enterFolder(file)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><span className="grid size-6 place-items-center rounded bg-accent-soft text-accent"><ChevronDown size={13} /></span><span className="truncate text-sm">{file.name}</span><ChevronRight size={14} className="ml-auto shrink-0 text-muted" /></button> : <>
                    <input aria-label={`${file.imported ? "Already imported" : "Select"} ${file.name}`} type="checkbox" checked={selected.includes(file.id)} disabled={file.imported} onChange={(e) => setSelected((s) => e.target.checked ? [...s, file.id] : s.filter((id) => id !== file.id))} />
                    <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
                    {file.imported ? <span className="shrink-0 text-[11px] font-medium text-pass">Imported</span> : <span className="shrink-0 text-[11px] text-muted">{file.mimeType.includes("pdf") ? "PDF" : file.mimeType.includes("word") || file.name.endsWith(".docx") ? "Word" : "Text"}</span>}
                  </>}
                </motion.div>
              ))}
              {next && <button type="button" disabled={loading} onClick={() => void loadFiles(active, parentId, driveId, true, next)} className="w-full py-2 text-xs font-medium text-accent hover:underline">{loading ? "Loading…" : "Load more"}</button>}
            </div>
            <div className="flex items-center justify-between border-t border-line px-4 py-3">
              <span className="text-xs text-muted">{selected.length} selected</span>
              <Button size="sm" variant="primary" disabled={!selected.length || busy} onClick={() => void importSelected()}>{busy ? `Importing… ${live?`${importProgress}%`:""}` : "Import selected"}</Button>
            </div>
          </>}
              </motion.div>}
            </AnimatePresence>
          </div>
        </section>
      </div>
      <div className="px-8 pb-8 text-xs text-muted max-[640px]:px-4">Supported files: Google Docs, .docx, .pdf, and .txt. Imports are one-time text copies; CLAUSE does not write back to repositories.</div>
    </div>
  );
}
