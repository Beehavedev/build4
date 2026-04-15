import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/app/",
  root: ".",
  build: {
    outDir: "dist",
  },
  server: {
    port: 5173,
  },
});
