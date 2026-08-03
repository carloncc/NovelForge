import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2021",
    chunkSizeWarningLimit: 2048,
  },
  envPrefix: ["VITE_", "TAURI_"],
});
