import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // The bot process serves the build under /admin/.
  base: "/admin/",
  plugins: [react()],
  server: {
    // `npm run dev --prefix web` talks to a bot running locally on port 3000.
    proxy: { "/admin/api": "http://localhost:3000", "/admin/login": "http://localhost:3000" },
  },
});
