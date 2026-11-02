import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/v1": "http://127.0.0.1:8949",
      "/api": "http://127.0.0.1:8949",
      "/docs": "http://127.0.0.1:8949",
      "/openapi.json": "http://127.0.0.1:8949",
      "/redoc": "http://127.0.0.1:8949",
    },
  },
});
