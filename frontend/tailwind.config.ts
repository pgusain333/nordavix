import type { Config } from "tailwindcss"

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Nordavix design tokens ───────────────────────────────────────────
        ink: {
          DEFAULT: "#0E1112",
          50:  "#F7F5F0",   // cream — bg, card fill
          100: "#EDECEA",   // border default
          200: "#D4D2CE",   // border strong / dividers
          400: "#8C8B88",   // muted text, placeholder
          600: "#4A4946",   // secondary text
          900: "#0E1112",
        },
        cream: "#F7F5F0",
        green: {
          DEFAULT: "#3E8F66",
          light:   "#5BB089",
          50:      "#EEF7F2",
          100:     "#C8E8D5",
          500:     "#3E8F66",
          600:     "#2E7A55",
        },
        // ── Variance semantics ────────────────────────────────────────────────
        fav:      { DEFAULT: "#16a34a", light: "#dcfce7", text: "#15803d" },
        unfav:    { DEFAULT: "#dc2626", light: "#fee2e2", text: "#b91c1c" },
        material: { DEFAULT: "#92400e", light: "#fef3c7" },
        // ── App shell navigation (white / light) ──────────────────────────────
        nav: {
          bg:            "#FFFFFF",
          border:        "#EDECEA",
          active:        "#F0F0EE",
          text:          "#6B6966",
          "text-active": "#0E1112",
          "text-hover":  "#0E1112",
        },
        // ── Marketing palette (homepage) ──────────────────────────────────────
        brand: {
          50:  "#eff6ff",
          100: "#dbeafe",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
        },
      },
      fontFamily: {
        sans: ["'Space Grotesk'", "Inter", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "'Fira Code'", "ui-monospace", "monospace"],
      },
      boxShadow: {
        card:        "0 1px 3px rgba(14,17,18,0.08), 0 1px 2px rgba(14,17,18,0.04)",
        "card-hover":"0 4px 12px rgba(14,17,18,0.10), 0 1px 3px rgba(14,17,18,0.06)",
        modal:       "0 20px 60px rgba(14,17,18,0.18), 0 4px 16px rgba(14,17,18,0.08)",
      },
      animation: {
        "float-up": "float-up 4s ease-in-out infinite",
        "float-down": "float-down 4s ease-in-out infinite",
        "blob": "blob 12s ease-in-out infinite",
        "blob-delay": "blob 12s ease-in-out 4s infinite",
        "glow-pulse": "glow-pulse 2.5s ease-in-out infinite",
        "flow-dash": "flow-dash 2s linear infinite",
        "spin-slow":   "spin-slow 20s linear infinite",
        "fade-in-up":  "fade-in-up 0.7s ease-out forwards",
        "marquee":     "marquee 30s linear infinite",
        "type-cursor": "type-cursor 1s step-end infinite",
        "slide-in":    "slide-in 0.25s ease-out forwards",
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
          "50%":      { opacity: "0" },
        },
        "slide-in": {
          "0%":   { opacity: "0", transform: "translateX(-8px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config
