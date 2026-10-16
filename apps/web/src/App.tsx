import { SettingsView } from "./components/Settings/SettingsView.tsx";
import { Shell } from "./components/Shell.tsx";
import { useRoute } from "./lib/router.ts";
import { useWorkspace, WorkspaceProvider } from "./lib/workspace.tsx";
import { DocumentView } from "./routes/DocumentView.tsx";
import { HomeView } from "./routes/HomeView.tsx";
import { TemplatesView } from "./routes/TemplatesView.tsx";

function Routes() {
  const route = useRoute();
  const ws = useWorkspace();
  return (
    <>
      {route.name === "home" && <HomeView onNew={() => ws.setNewDocOpen(true)} />}
      {route.name === "doc" && <DocumentView id={route.id} tab={route.tab} />}
      {route.name === "templates" && <TemplatesView />}
      {route.name === "settings" && <SettingsView />}
    </>
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
