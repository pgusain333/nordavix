import type { Config } from "tailwindcss"

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        fav: { DEFAULT: "#16a34a", light: "#dcfce7", text: "#15803d" },
        unfav: { DEFAULT: "#dc2626", light: "#fee2e2", text: "#b91c1c" },
        material: { DEFAULT: "#92400e", light: "#fef3c7" },
        nav: {
          bg: "#0a0f1e",
          border: "#1e293b",
          active: "#1e3a5f",
          text: "#94a3b8",
          "text-active": "#f8fafc",
          "text-hover": "#e2e8f0",
        },
        // Marketing palette
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
        },
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "'Fira Code'", "ui-monospace", "monospace"],
      },
      animation: {
        "float-up": "float-up 4s ease-in-out infinite",
        "float-down": "float-down 4s ease-in-out infinite",
        "blob": "blob 12s ease-in-out infinite",
        "blob-delay": "blob 12s ease-in-out 4s infinite",
        "glow-pulse": "glow-pulse 2.5s ease-in-out infinite",
        "flow-dash": "flow-dash 2s linear infinite",
        "spin-slow": "spin-slow 20s linear infinite",
        "fade-in-up": "fade-in-up 0.7s ease-out forwards",
        "marquee": "marquee 30s linear infinite",
        "type-cursor": "type-cursor 1s step-end infinite",
      },
      keyframes: {
        "float-up": {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-14px)" },
        },
        "float-down": {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(14px)" },
        },
        blob: {
          "0%, 100%": { transform: "translate(0px, 0px) scale(1)" },
          "33%": { transform: "translate(40px, -60px) scale(1.15)" },
          "66%": { transform: "translate(-30px, 30px) scale(0.9)" },
        },
        "glow-pulse": {
          "0%, 100%": { opacity: "0.5", transform: "scale(1)" },
          "50%": { opacity: "1", transform: "scale(1.05)" },
        },
        "flow-dash": {
          "0%": { strokeDashoffset: "120" },
          "100%": { strokeDashoffset: "-120" },
        },
        "spin-slow": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "marquee": {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "type-cursor": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config
