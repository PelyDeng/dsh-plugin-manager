/** Render a server-scope Nginx gateway fragment without changing the running web server. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Substitute the validated loopback port; no host filesystem paths enter the fragment. */
export function renderConsoleGateway(port) {
  if (!/^[1-9][0-9]{0,4}$/u.test(String(port)) || Number(port) > 65535) throw new Error('DSH port must be between 1 and 65535');
  return readFileSync(new URL('../../deploy/config/console-gateway.conf.template', import.meta.url), 'utf8').replaceAll('__DSH_PORT__', String(port));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [port, destination, ...extra] = process.argv.slice(2);
  if (!port || !destination || extra.length) throw new Error('Usage: node render-console-gateway.mjs <loopback-port> <output-file>');
  writeFileSync(destination, renderConsoleGateway(port), { flag: 'wx', mode: 0o600 });
}
