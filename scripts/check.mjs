#!/usr/bin/env node
/**
 * Repository self-check: every top-level directory that declares
 * `dsh.bundle.patch` is a plugin bundle. This script verifies the manifest
 * shape, that every declared export/file exists, and that locale JSON parses.
 *
 * It never imports plugin code, so it cannot start a plugin by accident.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED = new Set(['node_modules', '.git', '.github', 'scripts', 'docs']);
const problems = [];
const plugins = [];

/** @param {string} file */
async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** @param {string} file @param {string} where */
async function requireFile(file, where) {
  if (!(await isFile(file))) problems.push(`${where}: missing ${path.relative(ROOT, file)}`);
}

/** @param {string} dir */
async function checkPlugin(dir) {
  const where = path.relative(ROOT, dir);
  const manifestPath = path.join(dir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    problems.push(`${where}: package.json does not parse (${error.message})`);
    return;
  }

  const patch = manifest?.dsh?.bundle?.patch;
  if (!patch) return; // not a plugin bundle
  plugins.push(where);

  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@local/')) {
    problems.push(`${where}: package name should start with "@local/"`);
  }
  if (manifest.private !== true) problems.push(`${where}: "private" should be true (these bundles are linked, not published)`);
  if (typeof manifest.version !== 'string') problems.push(`${where}: missing version`);

  const patches = typeof patch === 'string' ? [patch] : patch;
  for (const file of patches) await requireFile(path.join(dir, file), where);

  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target !== 'string' || target.includes('*')) continue;
    await requireFile(path.join(dir, target), `${where} exports.${key}`);
  }

  for (const entry of manifest.files ?? []) {
    if (entry.includes('*')) continue;
    await requireFile(path.join(dir, entry), `${where} files`);
  }

  for (const locale of ['en.json', 'zh.json']) {
    const file = path.join(dir, 'locale', locale);
    if (!(await isFile(file))) continue;
    try {
      const json = JSON.parse(await readFile(file, 'utf8'));
      const title = json?.meta?.title;
      const description = json?.meta?.description;
      if (typeof title !== 'string' || title.length === 0) problems.push(`${where}: locale/${locale} has no meta.title`);
      if (typeof description !== 'string' || description.length === 0) problems.push(`${where}: locale/${locale} has no meta.description`);
    } catch (error) {
      problems.push(`${where}: locale/${locale} does not parse (${error.message})`);
    }
  }
}

const entries = await readdir(ROOT, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory() || IGNORED.has(entry.name)) continue;
  await checkPlugin(path.join(ROOT, entry.name));
}

if (plugins.length === 0) problems.push('no plugin bundles found');
if (problems.length > 0) {
  console.error(`check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`OK: ${plugins.length} plugin bundles`);
for (const plugin of plugins) console.log(`  - ${plugin}`);
