import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import theme from "../src/config/theme.mjs";

const outPath = fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url));

function flatten(prefix, obj, lines) {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      flatten(`${prefix}-${key}`, value, lines);
    } else {
      lines.push(`  --${prefix}-${key}: ${value};`);
    }
  }
}

const lines = [];
flatten("color", theme.colors, lines);
flatten("space", theme.spacing, lines);
flatten("radius", theme.radii, lines);
flatten("font-size", theme.typography.fontSize, lines);
flatten("line-height", theme.typography.lineHeight, lines);
flatten("font-weight", theme.typography.fontWeight, lines);
flatten("shadow", theme.shadows, lines);
flatten("container", theme.containers, lines);

const css = `/* Сгенерировано автоматически из src/config/theme.mjs — не редактировать руками. */\n:root {\n${lines.join("\n")}\n  --font-family-sans: ${theme.typography.fontFamily.sans};\n}\n`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, css, "utf-8");
console.log(`tokens.css generated: ${lines.length} variables`);
