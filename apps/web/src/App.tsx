import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { Shell } from "./components/Shell.tsx";
import { useRoute } from "./lib/router.ts";
import { useWorkspace, WorkspaceProvider } from "./lib/workspace.tsx";
import { RequestDialog } from "./components/RequestDialog.tsx";

// Each area is its own chunk, so the first screen ships only the shell and the view it opens on. The dynamic imports
// are named once here and reused by the idle prefetch below, so navigating later is instant.
const load = {
  workspace: () => import("./routes/WorkspaceView.tsx"),
  documents: () => import("./routes/DocumentsView.tsx"),
  document: () => import("./routes/DocumentView.tsx"),
  playbooks: () => import("./routes/PlaybooksView.tsx"),
  activity: () => import("./routes/ActivityView.tsx"),
  integrations: () => import("./routes/IntegrationsView.tsx"),
  templates: () => import("./routes/TemplatesView.tsx"),
  settings: () => import("./components/Settings/SettingsView.tsx"),
};
function named<M extends Record<string, unknown>, K extends keyof M & string>(importer: () => Promise<M>, name: K) {
  return lazy(() => importer().then((m) => ({ default: m[name] as ComponentType<any> })));
}
const WorkspaceView = named(load.workspace, "WorkspaceView");
const DocumentsView = named(load.documents, "DocumentsView");
const DocumentView = named(load.document, "DocumentView");
const PlaybooksView = named(load.playbooks, "PlaybooksView");
const ActivityView = named(load.activity, "ActivityView");
const IntegrationsView = named(load.integrations, "IntegrationsView");
const TemplatesView = named(load.templates, "TemplatesView");
const SettingsView = named(load.settings, "SettingsView");

function Routes() {
  const route = useRoute();
  const ws = useWorkspace();
  // Switching areas is a frequent action, so the motion is only a short lift; the document keeps its own key per tab.
  const key = route.name === "doc" ? `doc-${route.id}` : route.name;
  return (
    <div key={key} className="fade-up h-full">
      <Suspense fallback={<div className="h-full bg-canvas" aria-busy="true" />}>
      {route.name === "home" && <WorkspaceView />}
      {route.name === "documents" && <DocumentsView onNew={() => ws.setNewDocOpen(true)} />}
      {route.name === "playbooks" && <PlaybooksView id={route.id} />}
      {route.name === "activity" && <ActivityView />}
      {route.name === "integrations" && <IntegrationsView />}
      {route.name === "doc" && <DocumentView id={route.id} tab={route.tab} />}
      {route.name === "templates" && <TemplatesView />}
      {route.name === "settings" && <SettingsView />}
      </Suspense>
      <RequestDialog />
    </div>
  );
}

export default function App() {
  // Once the first screen is up, fetch the other areas in the background.
  useEffect(() => {
    const t = setTimeout(() => { for (const importer of Object.values(load)) void importer(); }, 1500);
    return () => clearTimeout(t);
  }, []);
  return (
    <WorkspaceProvider>
      <Shell>
        <Routes />
      </Shell>
    </WorkspaceProvider>
  );
}
