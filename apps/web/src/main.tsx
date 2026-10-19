import { lazy, StrictMode, Suspense } from "react";
import { MotionConfig } from "motion/react";
import { createRoot } from "react-dom/client";
import { onCLS, onINP, onLCP } from "web-vitals";
import { SettingsProvider } from "./lib/settings.tsx";
import { AuthProvider } from "./lib/auth.tsx";
import "./index.css";

const App = lazy(() => import("./App.tsx"));
const VideoPage = lazy(() => import("./routes/VideoPage.tsx"));
const videoPage = window.location.pathname.replace(/\/+$/, "") === "/video";

function reportVital(name:"CLS"|"INP"|"LCP",value:number) {
  void fetch("/api/telemetry/vitals",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,value}),keepalive:true}).catch(()=>undefined);
}
onCLS(({value})=>reportVital("CLS",value));
onINP(({value})=>reportVital("INP",value));
onLCP(({value})=>reportVital("LCP",value));

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
