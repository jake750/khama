import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/**
 * الخط المضمّن بصيغة woff2 فقط (T-103): Fontsource يضيف woff احتياطًا للمتصفحات القديمة،
 * وكل محرّكات Tauri (WebView2، WebKit) تقرأ woff2، فالاحتياط ~300KB لا يُحمَّل أبدًا.
 */
const woff2Only = {
  name: "woff2-only",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (id.includes("@fontsource") && id.endsWith(".css")) return code.replace(/,\s*url\([^)]+\.woff\) format\('woff'\)/g, "");
  },
};

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), woff2Only],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
