/** Copy this JavaScript package's runtime entry into its published directory. */
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
copyFileSync(new URL('./src/index.mjs', import.meta.url), new URL('./dist/index.mjs', import.meta.url));
