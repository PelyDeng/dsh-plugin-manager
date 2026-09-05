/** Remove disposable package outputs; persistent data and release records are retained. */
import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
for (const group of ['packages', 'plugins']) {
  const root = new URL(`../${group}/`, import.meta.url);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    for (const output of ['dist', 'coverage']) rmSync(fileURLToPath(new URL(`${entry.name}/${output}`, root)), { recursive: true, force: true });
  }
}
