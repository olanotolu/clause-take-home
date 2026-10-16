import { lazy, StrictMode, Suspense } from "react";
import { MotionConfig } from "motion/react";
import { createRoot } from "react-dom/client";
import { SettingsProvider } from "./lib/settings.tsx";
import { AuthProvider } from "./lib/auth.tsx";
import "./index.css";

const App = lazy(() => import("./App.tsx"));
const VideoPage = lazy(() => import("./routes/VideoPage.tsx"));
const videoPage = window.location.pathname.replace(/\/+$/, "") === "/video";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <Suspense fallback={<div role="status" className="grid min-h-dvh place-items-center bg-canvas text-muted">Loading CLAUSE…</div>}>
        {videoPage ? <VideoPage /> : (
          <AuthProvider>
            <SettingsProvider>
              <App />
            </SettingsProvider>
          </AuthProvider>
        )}
      </Suspense>
    </MotionConfig>
  </StrictMode>,
);
