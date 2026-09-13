/**
 * 本地页面回归工装：起静态服务、桩掉接口、用无头 Chromium 量尺寸。
 *
 * 插件的页面代码是浏览器原生模块，没有 jsdom 能覆盖的执行环境；仓库里的做法一向是
 * 「读源码抽函数 + 替身」。这条命令补上缺的一环：真的把页面跑起来，在几个视口宽度下
 * 量它。
 *
 * 用法（`<页面目录>` 默认是 `<插件根>/web`）：
 *
 *   node scripts/web-page-probe.mjs --root plugins/dsh-auth --prefix /auth \
 *     --stub fixtures/auth-api.json --probe tests/page-probe.js --widths 1150,860,640
 *
 * 工作原理：静态服务把 `<页面目录>` 挂在 `--prefix` 下，未命中的请求按 `--stub` 的 JSON
 * 回应（缺桩会返回 404，方便看出漏了什么）；HTML 里注入一段脚本，在 `--settle` 毫秒后
 * 执行 `--probe` 给出的表达式，把结果写进标题栏；Chromium 用 `--dump-dom` 输出整页，
 * 这里再把标题栏里的 JSON 取出来。整个过程不需要任何 npm 依赖。
 *
 * 没有可用的 Chromium 时不会假装通过：默认打印「跳过」并以 0 退出（本地/CI 都可能没有
 * 浏览器），加 `--require-browser` 则视为失败。
 */
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const USAGE = [
  '用法：node scripts/web-page-probe.mjs --root <插件根> [选项]',
  '',
  '  --root <目录>        插件根目录（必填；`--dir` 未给时用它的 web/）',
  '  --dir <目录>         页面目录，默认 <root>/web',
  '  --prefix </路径>     页面挂载前缀，默认 /（auth 页面用 /auth）',
  '  --page <路径>        要打开的页面，默认 <prefix>/（即 index.html）',
  '  --stub <文件.json>   未命中文件的请求按它回应：路径 → 响应体，或 {status, headers, body}',
  '  --probe <文件.js>    注入页面的表达式源码，结果写进标题栏；不传则只报告页面是否可打开',
  '  --widths <列表>      视口宽度，逗号分隔，默认 1150,860,640',
  '  --height <像素>      视口高度，默认 1600',
  '  --settle <毫秒>      注入脚本执行前的等待，默认 500',
  '  --budget <毫秒>      Chromium 虚拟时间预算，默认 4000',
  '  --browser <路径>     指定 Chromium；默认依次找 CHROME_PATH、Playwright 缓存、PATH',
  '  --require-browser    找不到浏览器时以失败退出',
  '  --json               只输出 JSON（给脚本用）',
  '  --help               打印这段用法',
].join('\n');

function parse(argv) {
  const options = { widths: '1150,860,640', height: '1600', settle: '500', budget: '4000' };
  const flags = new Set(['require-browser', 'json', 'help']);
  while (argv.length) {
    const key = argv.shift();
    if (!key.startsWith('--')) throw new Error(`未知参数：${key}`);
    const name = key.slice(2);
    if (flags.has(name)) { options[name] = true; continue; }
    const value = argv.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} 需要一个值。`);
    options[name] = value;
  }
  return options;
}

/** 找一个能用的 Chromium：显式路径 → CHROME_PATH → Playwright 缓存 → PATH → macOS 应用。 */
export function findBrowser(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const caches = [
    process.env.USERPROFILE && join(process.env.USERPROFILE, 'AppData/Local/ms-playwright'),
    process.env.HOME && join(process.env.HOME, '.cache/ms-playwright'),
    process.env.HOME && join(process.env.HOME, 'Library/Caches/ms-playwright'),
  ].filter(Boolean);
  const relative = [['chrome-win64', 'chrome.exe'], ['chrome-linux', 'chrome'], ['chrome-mac', 'Chromium.app/Contents/MacOS/Chromium'], ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'], ['chrome-headless-shell-linux64', 'chrome-headless-shell']];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    const versions = readdirSync(cache).filter(name => name.startsWith('chromium-')).sort().reverse();
    for (const version of versions) for (const parts of relative) {
      const candidate = join(cache, version, ...parts);
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' }); return name; }
    catch { /* 换下一个 */ }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(mac) ? mac : null;
}

/** 静态目录 + 桩接口。返回 { close, origin }。 */
function serve({ directory, prefix, stub, probe, settle }) {
  const root = resolve(directory);
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!path.startsWith(base + '/') && path !== base) { respond(response, 404, { 'content-type': 'application/json' }, JSON.stringify({ error: '前缀之外', path })); return; }
    const relative = path === base ? 'index.html' : path.slice(base.length + 1);
    const file = resolve(root, relative === '' ? 'index.html' : relative);
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      const entry = stub?.[path];
      if (entry === undefined) { respond(response, 404, { 'content-type': 'application/json' }, JSON.stringify({ error: '缺少桩', path })); return; }
      const { status = 200, headers = {}, body } = entry !== null && typeof entry === 'object' && 'body' in entry ? entry : { body: entry };
      respond(response, status, { 'content-type': 'application/json; charset=utf-8', ...headers }, typeof body === 'string' ? body : JSON.stringify(body ?? null));
      return;
    }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const bytes = readFileSync(file);
    if (type.startsWith('text/html') && probe !== undefined) {
      const injected = inject(bytes.toString('utf8'), probe, settle);
      respond(response, 200, { 'content-type': type }, injected);
      return;
    }
    respond(response, 200, { 'content-type': type }, bytes);
  });
  return new Promise(resolve_ => server.listen(0, '127.0.0.1', () => resolve_({ close: () => server.close(), origin: `http://127.0.0.1:${server.address().port}` })));
}

function respond(response, status, headers, body) {
  response.writeHead(status, { 'cache-control': 'no-store', ...headers });
  response.end(body);
}

/** 注入测量脚本：等页面安静下来后执行探针表达式，把结果写进标题栏。 */
function inject(html, probe, settle) {
  const script = `<script type="module">
setTimeout(async () => {
  try {
    const value = await (async () => { ${probe}\n })();
    document.title = 'PROBE:' + JSON.stringify(value ?? null);
  } catch (error) {
    document.title = 'PROBE:' + JSON.stringify({ error: String(error?.message ?? error) });
  }
}, ${Number(settle) || 0});
</script>`;
  return html.includes('</body>') ? html.replace('</body>', `${script}\n</body>`) : `${html}\n${script}`;
}

const decode = text => text.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#39;', "'");

/**
 * 在指定宽度下打开页面并取回探针结果。
 *
 * 必须用异步执行：静态服务就在本进程里，同步等待浏览器会把事件循环卡住，
 * 浏览器拿不到页面、双方一起等下去（原型分成两个进程，所以没暴露这一点）。
 */
async function measure({ browser, url, width, height, budget }) {
  const { stdout } = await runFile(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--virtual-time-budget=${budget}`, '--dump-dom', `--window-size=${width},${height}`, url],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: Number(budget) + 20000 });
  const match = /<title>PROBE:([\s\S]*?)<\/title>/.exec(stdout);
  if (!match) return { error: '页面没有回传探针结果（检查 --probe 是否执行，或页面是否报错）' };
  return JSON.parse(decode(match[1]));
}

export async function probePage(options) {
  const root = options.root && resolve(options.root);
  if (!root) throw new Error('必须指定 --root <插件根>。');
  const directory = resolve(options.dir ?? join(root, 'web'));
  if (!existsSync(directory)) throw new Error(`页面目录不存在：${directory}`);
  const prefix = options.prefix ?? '/';
  const stubPath = options.stub && resolve(options.stub);
  const stub = stubPath ? JSON.parse(readFileSync(stubPath, 'utf8')) : undefined;
  const probe = options.probe ? readFileSync(resolve(options.probe), 'utf8') : undefined;
  const widths = String(options.widths).split(',').map(value => Number(value.trim())).filter(value => Number.isFinite(value) && value > 0);
  if (!widths.length) throw new Error('--widths 至少要有一个正整数。');
  const browser = findBrowser(options.browser);
  if (!browser) return { skipped: true, reason: '没有找到 Chromium：设置 CHROME_PATH、安装 Playwright 浏览器，或用 --browser 指定。' };
  const server = await serve({ directory, prefix, stub, probe, settle: options.settle });
  try {
    const page = options.page ?? `${prefix.endsWith('/') ? prefix : `${prefix}/`}`;
    const results = [];
    for (const width of widths) results.push({ width, value: await measure({ browser, url: `${server.origin}${page}`, width, height: Number(options.height) || 1600, budget: Number(options.budget) || 4000 }) });
    return { browser, results };
  } finally { server.close(); }
}

function main(argv) {
  let options;
  try { options = parse(argv); }
  catch (error) { console.error(`${error.message}\n\n${USAGE}`); process.exitCode = 2; return; }
  if (options.help) { console.log(USAGE); return; }
  probePage(options).then(result => {
    if (result.skipped) {
      console.log(`页面探针跳过：${result.reason}`);
      if (options['require-browser']) { process.exitCode = 1; return; }
      return;
    }
    if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`浏览器：${result.browser}`);
    for (const { width, value } of result.results) console.log(`\n=== 视口 ${width}px ===\n${JSON.stringify(value, null, 2)}`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))) main(process.argv.slice(2));
