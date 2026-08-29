import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4311,
    proxy: {
      "/v1": "http://127.0.0.1:4310",
      "/health": "http://127.0.0.1:4310"
    }
  }
});
