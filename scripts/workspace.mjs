/** Build shared packages and run the explicitly selected plugin tasks. */
import { fileURLToPath } from 'node:url';
import { main, runPnpm } from '../packages/plugin-manager/src/run-plugin-task.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [action, ...args] = process.argv.slice(2);
try {
  if (!['build', 'check'].includes(action)) throw new Error('任务必须是 build 或 check。');
  if (!args.includes('--plugins')) args.push('--plugins', 'all');
  runPnpm(['--filter', '@dsh-plugin-manager/plugin-manager', 'build'], root);
  if (action === 'check') runPnpm(['--filter', '@dsh-plugin-manager/plugin-kit', 'check'], root);
  await main([action, ...args, '--root', root]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
