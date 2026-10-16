import { StrictMode } from "react";
import { MotionConfig } from "motion/react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { SettingsProvider } from "./lib/settings.tsx";
import { AuthProvider } from "./lib/auth.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <SettingsProvider>
          <App />
        </SettingsProvider>
      </AuthProvider>
    </MotionConfig>
  </StrictMode>,
);
