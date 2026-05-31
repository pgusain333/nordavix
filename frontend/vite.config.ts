import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "path"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to the FastAPI backend during local dev
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    // Bump the warning threshold a hair since our largest legitimate
    // chunk (the lazy reconciliations dashboard) sits around 130 KB.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        /**
         * Vendor chunk splitting — keeps the main bundle lean and lets
         * heavy third-party libs cache independently across deploys.
         *
         * Why these groupings:
         *  - vendor-clerk: ~100 KB. Used only inside SignedIn / auth
         *    routes. Splitting it means anonymous marketing visitors
         *    download it only when they actually navigate to /sign-in.
         *  - vendor-framer: ~60 KB. Used across marketing + app
         *    surfaces; not worth lazy-loading per page but pulling
         *    out of main lets the browser cache it across new app
         *    deploys (only the small index chunk rebuilds).
         *  - vendor-query: TanStack Query + Table. Used throughout the
         *    app shell; cache-stable.
         *  - vendor-react: React core + router. Almost never changes
         *    so isolating it gives the longest cache lifetime.
         *  - vendor-lucide: icon set used in 65+ components; small
         *    individually but the cumulative SVG paths add up.
         *
         * react-helmet-async is intentionally NOT split — it's tiny
         * (~20 KB) and used on every page, so the round-trip to fetch
         * a separate chunk costs more than the cache win.
         */
        manualChunks: {
          "vendor-react":   ["react", "react-dom", "react-router-dom"],
          "vendor-clerk":   ["@clerk/clerk-react"],
          "vendor-framer":  ["framer-motion"],
          "vendor-query":   ["@tanstack/react-query", "@tanstack/react-table"],
          "vendor-lucide":  ["lucide-react"],
        },
      },
    },
  },
})
