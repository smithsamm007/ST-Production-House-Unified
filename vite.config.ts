import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Two runtimes, one origin contract:
//   * `npm start` (node server.js) is the unified production runtime — it serves
//     the built console from dist/ AND the /api routes on port 3000.
//   * `npm run dev` is the Vite dev server with hot reload on port 5173 and
//     proxies /api/* to the control plane, so browser code only ever talks to
//     its own origin and never hardcodes a backend port.
//
// The vendor split below is main's existing chunking (react/react-dom/icons kept
// out of the screen chunks); the per-screen `React.lazy` imports live in
// src/App.tsx.
const API_ORIGIN = "http://127.0.0.1:3000";
const apiProxy = {
  "/api": { target: API_ORIGIN, changeOrigin: false },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    proxy: apiProxy,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          icons: ["lucide-react"],
        },
      },
    },
  },
});
