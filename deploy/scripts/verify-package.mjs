import { main } from '../../packages/plugin-manager/src/verify-package.mjs';
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
