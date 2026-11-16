import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  // 相对路径构建：资源 URL 由 index.html 注入的 <base> 锚定，
  // 同一份产物可同时适配直连（/hub/）与子路径反代（如 /hub-service/hub/）。
  // 注意：vite dev server 会把相对 base 规范为 "/"，开发模式仍走根路径。
  base: "./",
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
