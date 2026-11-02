import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const apiProxy = { target: "http://127.0.0.1:8949", changeOrigin: false };

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/v1": apiProxy,
      "/api": apiProxy,
      "/docs": apiProxy,
      "/openapi.json": apiProxy,
      "/redoc": apiProxy,
    },
  },
});
