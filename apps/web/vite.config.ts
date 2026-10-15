import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const API = process.env.CLAUSE_API ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@clause/engine": fileURLToPath(new URL("../../packages/core/src/browser.ts", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": { target: API, rewrite: (p) => p.replace(/^\/api/, "") } } },
});
