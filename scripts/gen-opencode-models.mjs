#!/usr/bin/env node
/**
 * Genera src/agents/opencode-models.generated.ts con la lista real de
 * `opencode models`. Uso: pnpm gen:models
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(root, "src", "agents", "opencode-models.generated.ts");

execFile("opencode", ["models"], { timeout: 30_000 }, async (error, stdout) => {
  const models = String(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[\w.-]+\/[\w._-]+$/.test(line))
    .sort();

  if (!error && models.length === 0) {
    console.error("gen:models: `opencode models` no devolvió modelos.");
    process.exit(1);
  }

  const list = error ? [] : models.map((model) => `  '${model}',`).join("\n");

  const content = `/* eslint-disable */
// Generado por \`pnpm gen:models\` — no editar a mano.
export const OPENCODE_MODELS = [
${list}
] as const;

export type KnownOpenCodeModel = (typeof OPENCODE_MODELS)[number];

/** Autocomplete con los modelos conocidos; acepta cualquier string. */
export type OpenCodeModel = KnownOpenCodeModel | (string & {});
`;

  await writeFile(target, content, "utf8");
  console.log(
    `gen:models: ${error ? "sin CLI, lista vacía" : `${models.length} modelos`} → ${path.relative(root, target)}`,
  );
});
