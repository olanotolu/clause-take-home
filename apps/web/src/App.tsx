import { SettingsView } from "./components/Settings/SettingsView.tsx";
import { Shell } from "./components/Shell.tsx";
import { useRoute } from "./lib/router.ts";
import { useWorkspace, WorkspaceProvider } from "./lib/workspace.tsx";
import { DocumentView } from "./routes/DocumentView.tsx";
import { DocumentsView } from "./routes/DocumentsView.tsx";
import { WorkspaceView } from "./routes/WorkspaceView.tsx";
import { PlaybooksView } from "./routes/PlaybooksView.tsx";
import { ActivityView } from "./routes/ActivityView.tsx";
import { RequestDialog } from "./components/RequestDialog.tsx";
import { TemplatesView } from "./routes/TemplatesView.tsx";

function Routes() {
  const route = useRoute();
  const ws = useWorkspace();
  // Switching areas is a frequent action, so the motion is only a short lift; the document keeps its own key per tab.
  const key = route.name === "doc" ? `doc-${route.id}` : route.name;
  return (
    <div key={key} className="fade-up h-full">
      {route.name === "home" && <WorkspaceView />}
      {route.name === "documents" && <DocumentsView onNew={() => ws.setNewDocOpen(true)} />}
      {route.name === "playbooks" && <PlaybooksView id={route.id} />}
      {route.name === "activity" && <ActivityView />}
      {route.name === "doc" && <DocumentView id={route.id} tab={route.tab} />}
      {route.name === "templates" && <TemplatesView />}
      {route.name === "settings" && <SettingsView />}
      <RequestDialog />
    </div>
  );
}

export default function App() {
  return (
    <WorkspaceProvider>
      <Shell>
        <Routes />
      </Shell>
    </WorkspaceProvider>
  );
}
