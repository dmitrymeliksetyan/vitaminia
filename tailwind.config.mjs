import theme from "./src/config/theme.mjs";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx}"],
  theme: {
    extend: {
      colors: {
        text: theme.colors.text,
        "text-secondary": theme.colors["text-secondary"],
        border: theme.colors.border,
        severity: {
          low: theme.colors["severity-low"],
          medium: theme.colors["severity-medium"],
          high: theme.colors["severity-high"]
        }
      },
      spacing: { ...theme.spacing },
      borderRadius: { ...theme.radii },
      fontSize: { ...theme.typography.fontSize },
      fontFamily: { sans: [theme.typography.fontFamily.sans] },
      boxShadow: { ...theme.shadows },
      maxWidth: { ...theme.containers }
    }
  },
  plugins: []
};
