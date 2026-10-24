import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api and /uploads are forwarded to the FastAPI backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
      "/uploads": "http://localhost:8000",
    },
  },
});
