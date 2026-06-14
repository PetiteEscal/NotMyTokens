#!/usr/bin/env node
/**
 * Builds index.json — the search index the gallery and MCP server read.
 *
 * Walks artifacts/<id>/meta.json, validates the basics, and emits a single
 * index.json at the repo root. Run via `npm run build:index` (or in CI on
 * every push to the default branch).
 */
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS_DIR = join(ROOT, "artifacts");
const OUT = join(ROOT, "index.json");

const REQUIRED = ["id", "name", "type", "version", "description", "tags", "entry", "files"];
const TYPES = new Set(["component", "snippet", "prompt", "template", "dataset", "skill"]);

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  const entries = await readdir(ARTIFACTS_DIR);
  const artifacts = [];
  const errors = [];

  for (const folder of entries.sort()) {
    const dir = join(ARTIFACTS_DIR, folder);
    if (!(await isDir(dir))) continue;

    const metaPath = join(dir, "meta.json");
    let meta;
    try {
      meta = JSON.parse(await readFile(metaPath, "utf8"));
    } catch (err) {
      errors.push(`${folder}: cannot read/parse meta.json (${err.message})`);
      continue;
    }

    for (const field of REQUIRED) {
      if (meta[field] === undefined) errors.push(`${folder}: missing required field "${field}"`);
    }
    if (meta.id !== folder) errors.push(`${folder}: id "${meta.id}" must match folder name`);
    if (!TYPES.has(meta.type)) errors.push(`${folder}: invalid type "${meta.type}"`);

    // Verify referenced files exist.
    for (const file of meta.files ?? []) {
      if (!(await fileExists(join(dir, file)))) {
        errors.push(`${folder}: file "${file}" listed in meta.json does not exist`);
      }
    }
    if (meta.entry && !(meta.files ?? []).includes(meta.entry)) {
      errors.push(`${folder}: entry "${meta.entry}" is not listed in files`);
    }

    artifacts.push({ ...meta, path: `artifacts/${folder}` });
  }

  if (errors.length) {
    console.error("Index build failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    count: artifacts.length,
    artifacts,
  };

  await writeFile(OUT, JSON.stringify(index, null, 2) + "\n");
  console.log(`Wrote ${OUT} with ${artifacts.length} artifact(s).`);
}

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
