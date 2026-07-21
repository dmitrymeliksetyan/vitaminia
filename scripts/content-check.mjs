#!/usr/bin/env node
/**
 * npm run content:check
 *
 * Validates the MEDIZIN Content Registry before any new content is created.
 * Exits with a non-zero code if a critical (P0-level) problem is found, so it
 * can be wired into CI later. Intended to be run by a human or an AI assistant
 * BEFORE writing a new symptom/page — this is the enforcement mechanism for
 * "new content must not be created before an automatic Content Registry check".
 *
 * The actual validation algorithm lives in src/lib/content-registry/validate.mjs
 * and is shared verbatim with the admin UI's "Проверить контент" button
 * (Этап 1.5) — this file only builds the registry (Node/fs) and formats the
 * result for the terminal.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "vitaminia-shared/content-registry/content-registry-lib.mjs";
import { validateRegistry } from "vitaminia-shared/content-registry/validate.mjs";
import { buildQueue } from "../src/lib/content-registry/queue.mjs";

// Этап "Выделение AI Worker в отдельный независимый сервис" — buildRegistry()
// теперь требует явный rootDir (см. vitaminia-shared/README.md — параметризация
// нужна, чтобы одна и та же функция одинаково работала и из SSR (свой корень),
// и из Worker'а (свой локальный git-чекаут сайта)).
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";

function err(msg) {
  return `${RED}ERROR:${RESET} ${msg}`;
}
function warn(msg) {
  return `${YELLOW}WARNING:${RESET} ${msg}`;
}

function main() {
  const { items, problems: parseProblems } = buildRegistry(ROOT);
  const { criticalErrors, warnings, totalItems, linkGraph } = validateRegistry(items, parseProblems);
  const queue = buildQueue(items, parseProblems);

  const liveSymptoms = items.filter((i) => i.contentType === "symptom" && !i.retired && i.status !== "draft");
  const orphanPages = linkGraph.orphanIds.length;
  const brokenLinks = [...linkGraph.byId.values()].reduce(
    (n, node) => n + node.brokenOutgoing.filter((b) => b.reason === "not_found" || b.reason === "retired_no_redirect" || b.reason === "draft").length,
    0
  );
  const queueItems = queue.p0.length + queue.p1.length + queue.p2.length + queue.p3.length;

  console.log(`${BOLD}MEDIZIN content:check${RESET}`);
  console.log(`Registry items: ${totalItems}`);
  console.log(`Live symptoms: ${liveSymptoms.length}`);
  console.log(`Critical errors: ${criticalErrors.length}`);
  console.log(`Warnings: ${warnings.length}`);
  console.log(`Orphan pages: ${orphanPages}`);
  console.log(`Broken links: ${brokenLinks}`);
  // Технический backlog P0-P3 (validation + hand-maintained items). Новые
  // "идеи контента" (workingTitle/причина/приоритет, п.9-11 ТЗ) хранятся в
  // Supabase (content_ideas) и видны только в /admin/content — сборка
  // content:check работает офлайн и намеренно не обращается к сети/БД.
  console.log(`Queue items (P0-P3): ${queueItems}\n`);

  if (criticalErrors.length === 0) {
    console.log(`${GREEN}No critical errors.${RESET}`);
  } else {
    console.log(`${BOLD}${criticalErrors.length} critical error(s):${RESET}\n`);
    for (const e of criticalErrors) console.log(err(e.msg) + "\n");
  }

  if (warnings.length > 0) {
    console.log(`${BOLD}${warnings.length} warning(s):${RESET}\n`);
    for (const w of warnings) console.log(warn(w.msg));
  }

  if (criticalErrors.length > 0) {
    console.log(`\n${RED}${BOLD}content:check FAILED${RESET} — fix the errors above before creating/publishing content.`);
    process.exit(1);
  } else {
    console.log(`\n${GREEN}${BOLD}content:check OK${RESET}`);
    process.exit(0);
  }
}

main();
