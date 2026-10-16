import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // `npm run dev` forwards /api to the local backend (deno task dev). Set DEV_ORIGIN=http://localhost:5173 in the backend .env.
  server: { proxy: { "/api": "http://localhost:8000" } },
  build: { sourcemap: false },
});
