/** Convert explicitly selected legacy registry settings; retain every original file. */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImageConfig } from './host-image.mjs';

/** Create host-image.conf without executing shell settings or deleting migration sources. */
export function migrateConfig(root) {
  const destination = resolve(root, 'deploy/config/host-image.conf');
  const candidates = ['deploy/config/registry.conf', 'deploy/registry.conf'].map(path => resolve(root, path));
  const existing = candidates.filter(existsSync);
  if (!existing.length) return { migrated: false, retained: 0, ignoredFields: [] };
  for (const path of [...existing, ...(existsSync(destination) ? [destination] : [])]) {
    if (!lstatSync(path).isFile()) throw new Error('Configuration migration only accepts regular files.');
  }
  const content = readFileSync(existing[0], 'utf8');
  if (existing.some(path => readFileSync(path, 'utf8') !== content)) throw new Error('Legacy registry configurations conflict; all sources were retained.');
  const defaults = loadImageConfig(root);
  const selected = { ...defaults };
  const ignoredFields = [];
  for (const [index, raw] of content.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error(`Legacy configuration line ${index + 1} is not a literal assignment; sources retained.`);
    if (!Object.hasOwn(defaults, match[1])) { ignoredFields.push(match[1]); continue; }
    let value = match[2].trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error(`Invalid quoted configuration on line ${index + 1}.`); }
      if (typeof value !== 'string') throw new Error(`Expected a string on line ${index + 1}.`);
    } else if (/^'.*'$/u.test(value)) value = value.slice(1, -1);
    selected[match[1]] = value;
  }
  selected.HARBOR_ENABLED = selected.REGISTRY_HOST ? 'true' : 'false';
  const output = `${Object.entries(selected).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')}\n`;
  if (existsSync(destination)) {
    if (readFileSync(destination, 'utf8') !== output) throw new Error('Host configuration conflicts with migration result; both files were retained.');
    return { migrated: false, destination, retained: existing.length, ignoredFields: [...new Set(ignoredFields)] };
  }
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, output, { flag: 'wx', mode: 0o600 });
  try { loadImageConfig(root, temporary); renameSync(temporary, destination); }
  catch (error) { rmSync(temporary); throw error; }
  return { migrated: true, destination, retained: existing.length, ignoredFields: [...new Set(ignoredFields)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node deploy/scripts/migrate-config.mjs [repository-root]');
  const root = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  console.log(JSON.stringify(migrateConfig(root), null, 2));
}
