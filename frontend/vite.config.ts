import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/Vision-Zero_Post-crash-Care/",
  plugins: [react()],
  server: { port: 5173 },
});
