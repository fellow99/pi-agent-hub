import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "/hub/",
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8443", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          "md-editor": ["md-editor-v3"],
          "element-plus": ["element-plus", "@element-plus/icons-vue"],
          vue: ["vue", "vue-router"],
        },
      },
    },
  },
});
