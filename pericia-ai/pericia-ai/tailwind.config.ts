import type { Config } from "tailwindcss";

// Sistema de tokens "Livro-Razão Pericial": paleta sóbria de arquivo judicial
// (papel/pergaminho + tinta/navy + selo de lacre em latão), tipografia serifada
// para identificação de documentos e monoespaçada para valores financeiros.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        parchment: "#F4F2EC",
        "parchment-dim": "#EAE7DC",
        ink: {
          DEFAULT: "#131C31",
          50: "#EEF0F5",
          100: "#D6DBE8",
          300: "#8C97B8",
          500: "#3B476B",
          700: "#1C2740",
          800: "#0F172A",
          900: "#0B0F17",
        },
        brass: {
          DEFAULT: "#D4AF37",
          light: "#E4C878",
          dark: "#C5A059",
        },
        seal: {
          red: "#8C2F2B",
          green: "#2F6F4E",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      borderRadius: {
        none: "0px",
        sm: "2px",
        DEFAULT: "3px",
        md: "4px",
      },
      boxShadow: {
        ledger: "0 1px 0 0 rgba(19,28,49,0.08)",
      },
    },
  },
  plugins: [],
};
export default config;
