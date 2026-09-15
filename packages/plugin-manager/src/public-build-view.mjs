/**
 * 公开构建视图：只含公开输入的隔离工作区。
 *
 * 内置插件的构建不能用部署机上的完整 workspace——私有集成库的 workspace 里还有 external 源码、
 * 私有 vendor 与业务配置，一次根安装会把它们一起带进来，也可能触发它们的脚本。因此把内置构建
 * 放进一个只由**框架公开材料**组成、带匹配锁文件的临时视图里执行。
 *
 * 边界（对应设计的公开目录清单）：
 * - 收录：`packages/`、`plugins/builtin/`、`scripts/`、`deploy/`、`integrations/`、`examples/`、
 *   `doc/`、`.github/` 以及公开根构建文件与模板。
 * - 排除：`plugins/external/`、私有 vendor、业务配置、`.local/`、官方宿主源码。
 * - 视图根的清单、workspace 定义与锁**逐字节**取自公开构建元数据：交付的 `tools/builtin-build/`
 *   或公共检出自身的根文件。视图不再生成或裁剪这些文件，缺材料就直接失败；交付目录必须带一份
 *   匹配的 `input.json`（`writePublicInputRecord` 写入），否则一律拒绝。
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 公开目录与文件：视图只收录这些顶层项。 */
export const publicEntries = ['packages', 'plugins/builtin', 'scripts', 'deploy', 'integrations', 'examples', 'doc', '.github'];
// 根级公开构建文件与模板：含 example 源码索引读取的 env.conf / test-report.sh，
// 以及 LICENSE/NOTICE 这类没有扩展名、靠扩展名过滤会被丢掉的交付材料。
export const publicFiles = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'README.md', 'README.en.md', 'AGENTS.md', 'LICENSE', 'NOTICE', 'env.conf', 'test-report.sh', '.gitattributes', '.npmrc', '.nvmrc', 'tsconfig.base.json'];
/** 公开构建元数据：视图清单、workspace 定义与匹配锁；三者必须来自同一份公共框架输入。 */
export const publicInputFiles = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
/** 交付记录文件名与换行规则：交付物按 Git 规范形式（LF）落盘并记录摘要。 */
export const PUBLIC_INPUT_RECORD = 'input.json';
export const PUBLIC_INPUT_NEWLINE = 'lf';
/** 公开 workspace 允许出现的项目范围：公共包、内置插件，以及公共定义里本来就有的 external 通配。 */
const publicWorkspaceGlobs = new Set(['packages/*', 'plugins/builtin/*', 'plugins/external/*']);
/** 公开输入必须真的声明这两项：任何「没解析出 packages 段」的写法都会得到空集合，只按集合内元素
 *  判断会恒真通过（引号键、YAML 显式键、整段被跳过等），所以缺任一项都按材料不合法拒绝。 */
const requiredWorkspaceGlobs = ['packages/*', 'plugins/builtin/*'];
const ignored = new Set(['node_modules', 'dist', 'coverage', '.local', '.git', '.turbo']);

/**
 * 复制一个公开顶层项；目录递归处理。
 *
 * 这里**不按扩展名过滤**（设计 2.8：公开输入包含文本、二进制资源和模板，不套用 example 源码
 * 索引的「仅文本文件」过滤）。裁剪依据只有两个：运行产物目录（`ignored`）与符号链接。
 */
function copyEntry(source, target) {
  const info = statSync(source);
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) copyEntry(join(source, entry.name), join(target, entry.name));
      else if (entry.isFile()) copyEntry(join(source, entry.name), join(target, entry.name));
    }
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}

/** 按行读取文本，去掉 CRLF 的 `\r`：工作区检出在 Windows 上可能是 CRLF，比较前必须归一。 */
const lines = text => text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));

/** 锁文件 `importers:` 段落里的 workspace 项目名（一层缩进键，值可以同行也可以展开成块）。 */
export function lockImporters(lockText) {
  const importers = new Set();
  let inImporters = false;
  for (const line of lines(lockText)) {
    // 段内的空行不改变状态：pnpm 在 `importers:` 段首与各条目之间都可能留空行。
    if (line === '') continue;
    if (!line.startsWith(' ')) { inImporters = line === 'importers:'; continue; }
    if (!inImporters) continue;
    const match = /^ {2}([^:\s][^:]*?)\s*:(?:\s.*)?$/u.exec(line);
    if (match) importers.add(match[1].replace(/^['"]|['"]$/gu, ''));
  }
  return importers;
}

/** 去掉行尾注释（`#` 需在空白之后，且不在引号内），保留其余内容。 */
function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#' && (index === 0 || /\s/u.test(text[index - 1]))) return text.slice(0, index);
  }
  return text;
}

/**
 * 严格解析 workspace 定义的 `packages:` 段落。
 *
 * 返回 `{ globs, unknown }`：`unknown` 是段内看不懂的结构（行内数组、非列表项等）。调用方必须把
 * `unknown` 当成错误——不能静默跳过，否则一句带注释的 `- '...' # private` 就能把私有路径藏过校验。
 */
export function parseWorkspacePackages(text) {
  const globs = [], unknown = [];
  let inPackages = false;
  // 前导 BOM 必须先剥掉：ECMAScript 的 `\s` 包含 U+FEFF，`\uFEFFpackages:` 会被当成缩进行而在下面
  // 整段跳过，得到一个空集合——白名单判定就成了恒真。pnpm 读 YAML 时同样丢掉 BOM。
  for (const line of lines(text.replace(/^\uFEFF/u, ''))) {
    if (line.trim() === '' || /^\s*#/u.test(line)) continue;
    if (!/^\s/u.test(line)) {
      const match = /^packages\s*:(.*)$/u.exec(line);
      inPackages = Boolean(match);
      // 行内数组（`packages: ['a', 'b']`）不支持：明确拒绝，不当作没有项目。
      if (inPackages && stripComment(match[1]).trim() !== '') unknown.push(line);
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s*-\s*(.*)$/u.exec(line);
    if (!item) { unknown.push(line); continue; }
    const value = stripComment(item[1]).trim();
    const glob = /^(['"])(.*)\1$/u.exec(value)?.[2] ?? value;
    if (glob === '') { unknown.push(line); continue; }
    globs.push(glob);
  }
  return { globs, unknown };
}

/** workspace 定义 `packages:` 段落里列出的项目 glob（供诊断与断言使用）。 */
export function workspaceGlobs(text) {
  return parseWorkspacePackages(text).globs;
}

/**
 * 归一到 Git 规范换行（LF）后再比较：Windows 检出的工作区是 CRLF，而索引与干净检出是 LF。
 *
 * 交付物一律按 LF 落盘并记录 LF 摘要，因此「工作区 CRLF」和「干净检出 LF」都要通过，真正的字节
 * 改动才失败。
 */
export function normalizeNewlines(bytes) {
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8');
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * 交付记录与交付物的一致性核对（唯一实现）。
 *
 * 私有集成环节用 `private-deploy/deliver-public-inputs.mjs` 生成记录，站点侧在含 `plugins/external`
 * 的检出上复用这里：只按内容规则（版本、公开范围、锁覆盖）不足以发现「交付物被手工改过、记录还是
 * 旧的」，所以摘要校验是交付完整性的一部分，而不是只属于仓库门禁。
 */
export function verifyPublicInputRecord(root, directory) {
  const recordPath = resolve(directory, PUBLIC_INPUT_RECORD);
  if (!existsSync(recordPath)) throw new Error(`公开构建元数据缺少交付记录：${recordPath}；请用 private-deploy/deliver-public-inputs.mjs 交付匹配的三个文件。`);
  // 交付物必须是真实目录与普通文件：符号链接会把校验指向另一份材料。
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`交付目录不能是符号链接：${directory}`);
  let record;
  try { record = JSON.parse(readFileSync(recordPath, 'utf8')); }
  catch { throw new Error(`交付记录无法解析：${recordPath}`); }
  if (record?.schemaVersion !== 1) throw new Error(`交付记录版本无法识别：${recordPath}；请重新交付。`);
  if (record.newline !== PUBLIC_INPUT_NEWLINE) throw new Error(`交付记录的换行规则无法识别（需要 ${PUBLIC_INPUT_NEWLINE}）：${recordPath}；请重新交付。`);
  const version = existsSync(resolve(root, 'package.json')) ? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version : undefined;
  if (record.frameworkVersion !== version) throw new Error(`交付的公开构建元数据版本（${record.frameworkVersion}）与框架版本（${version}）不一致：${recordPath}`);
  for (const name of publicInputFiles) {
    const file = resolve(directory, name);
    if (!existsSync(file)) throw new Error(`交付缺少公开构建输入：${name}`);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`交付的公开构建输入必须是普通文件：${name}`);
    const actual = digest(normalizeNewlines(readFileSync(file)));
    if (actual !== record.files?.[name]) throw new Error(`交付的公开构建输入与记录不一致：${name}`);
  }
  return record;
}

/**
 * 写入交付记录（唯一实现）：发行包与私有集成交付共用同一份格式。
 *
 * 记录必须与三件套同时产出——没有记录就等于没有交付：站点侧只要用了独立交付目录就直接拒绝。
 * 摘要在 LF 归一后计算，附带的来源字段（提交、脏文件）由调用方提供，校验方不解读它们。
 */
export function writePublicInputRecord(directory, { version, ...extra } = {}) {
  if (typeof version !== 'string' || !version) throw new Error('交付记录需要框架版本。');
  const files = {};
  for (const name of publicInputFiles) {
    const file = resolve(directory, name);
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error(`交付缺少公开构建输入：${name}`);
    files[name] = digest(normalizeNewlines(readFileSync(file)));
  }
  const record = { schemaVersion: 1, newline: PUBLIC_INPUT_NEWLINE, frameworkVersion: version, ...extra, files };
  writeFileSync(resolve(directory, PUBLIC_INPUT_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * 公开构建输入的一致性核对：三件套齐全、与本次源码同一框架版本、且不含私有 workspace 痕迹。
 *
 * 这些检查只能证明「材料像公共框架的输入」，不能替代交付摘要与「来自同一份公共输入」的交付纪律；
 * 因此交付环节（公共打包与私有集成）必须逐字节复制，而不是在部署机现场生成。
 */
export function assertPublicBuildInputs(source, root) {
  for (const file of publicInputFiles) if (!existsSync(resolve(source, file))) throw new Error(`公开构建输入不完整：${source} 缺少 ${file}。`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')); }
  catch { throw new Error(`公开构建输入的 package.json 无法解析：${resolve(source, 'package.json')}。`); }
  const managerFile = resolve(root, 'packages/plugin-manager/package.json');
  const managerVersion = existsSync(managerFile) ? JSON.parse(readFileSync(managerFile, 'utf8')).version : undefined;
  if (typeof manifest.version !== 'string' || manifest.version !== managerVersion) {
    throw new Error(`公开构建输入与本次源码不是同一份框架版本：输入 ${manifest.version ?? '(缺失)'}，源码 ${managerVersion ?? '(未知)'}；请交付匹配的三个文件。`);
  }
  const workspace = parseWorkspacePackages(readFileSync(resolve(source, 'pnpm-workspace.yaml'), 'utf8'));
  // 看不懂的配置行一律拒绝：静默跳过会让带注释的私有路径绕过校验。
  if (workspace.unknown.length) throw new Error(`公开构建输入的工作区定义含无法识别的配置行：${workspace.unknown.join(' / ')}；请交付公共框架的根定义。`);
  // 正向断言：必须真的解析出公开项目范围。只看「集合里每个元素是否合法」时，空集合会恒真通过。
  for (const required of requiredWorkspaceGlobs) {
    if (!workspace.globs.includes(required)) throw new Error(`公开构建输入的工作区定义缺少 ${required}：${resolve(source, 'pnpm-workspace.yaml')}；请交付公共框架的根定义。`);
  }
  for (const glob of workspace.globs) {
    if (!publicWorkspaceGlobs.has(glob)) throw new Error(`公开构建输入的工作区定义含非公开范围：${glob}；不要使用私有 workspace 现场生成的元数据。`);
  }
  for (const importer of lockImporters(readFileSync(resolve(source, 'pnpm-lock.yaml'), 'utf8'))) {
    if (importer.startsWith('plugins/external/')) throw new Error(`公开构建输入的锁包含私有 workspace 项目：${importer}；请交付公共框架的匹配锁文件。`);
  }
  return manifest;
}

/** 视图内实际存在的 workspace 项目（相对视图根，正斜杠）。 */
function viewImporters(output) {
  const importers = new Set(['.']);
  const group = (container, prefix) => {
    const path = resolve(output, container);
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored.has(entry.name) || entry.name.startsWith('.')) continue;
      if (existsSync(resolve(path, entry.name, 'package.json'))) importers.add(`${prefix}${entry.name}`);
    }
  };
  group('packages', 'packages/');
  group('plugins/builtin', 'plugins/builtin/');
  return importers;
}

/**
 * 构造公开构建视图。
 *
 * 元数据来源（设计 2.8）：
 * - 显式 `inputs`：交付的公开构建元数据目录，逐字节使用；
 * - 未显式给出：先用 `<root>/tools/builtin-build/`；
 * - 都没有时：**只有公共检出**（不含 `plugins/external`）可以退到自身的根元数据——它本身就是
 *   那一份公共输入；含 `plugins/external` 的检出没有交付材料就直接失败，不再现场生成或裁剪。
 */
export function createPublicBuildView({ root, output, inputs } = {}) {
  if (!root || !output) throw new Error('createPublicBuildView 需要 root 与 output。');
  root = resolve(root);
  output = resolve(output);
  if (!existsSync(resolve(root, 'package.json'))) throw new Error('构建视图需要框架根目录的 package.json。');
  const toolInputs = resolve(root, 'tools/builtin-build');
  let source;
  if (inputs !== undefined) {
    source = inputs && resolve(inputs);
    if (!source || !existsSync(source)) throw new Error(`公开构建输入不存在：${source}；请交付匹配的 package.json / pnpm-workspace.yaml / pnpm-lock.yaml。`);
  } else if (existsSync(toolInputs)) {
    source = toolInputs;
  } else if (existsSync(resolve(root, 'plugins/external'))) {
    throw new Error(`缺少公开构建输入 ${toolInputs}：该检出含 plugins/external，不能按现场元数据构造构建视图（设计 2.8）。请在集成环节交付匹配的 package.json / pnpm-workspace.yaml / pnpm-lock.yaml，或改用带 tools/builtin-build/ 的发行包。`);
  } else {
    // 公共检出：它的根元数据就是那一份公开输入，逐字节使用，不生成也不裁剪。
    source = root;
  }
  assertPublicBuildInputs(source, root);
  // 交付完整性：只要元数据来自独立交付目录（发行包的 tools/builtin-build/、私有集成的交付物），就必须
  // 有匹配的记录并逐字节核对。只按内容规则看不出「交付物被改过、记录还是旧的」；反过来，删掉记录不能
  // 成为跳过校验的路径，所以判据是「用了交付目录」而不是「现场有 external 或碰巧留着记录」。
  // 只有公共检出退到自身根元数据（source === root）时没有记录，那时它本身就是那一份公开输入。
  if (source !== root || existsSync(resolve(root, 'plugins/external'))) verifyPublicInputRecord(root, source);
  if (existsSync(output)) rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const included = [];
  // 元数据单独写入，不要先复制检出同名文件再覆盖：Windows 上 cpSync 覆盖已存在文件时，
  // 路径含非 ASCII 字符会失败（libuv 扩展路径的已知怪癖），这里干脆不制造覆盖。
  for (const entry of [...publicEntries, ...publicFiles.filter(name => !publicInputFiles.includes(name))]) {
    const from = resolve(root, entry);
    if (!existsSync(from)) continue;
    copyEntry(from, resolve(output, entry));
    included.push(entry);
  }
  for (const file of publicInputFiles) writeFileSync(resolve(output, file), readFileSync(resolve(source, file)));
  const importers = [...viewImporters(output)];
  const locked = lockImporters(readFileSync(resolve(output, 'pnpm-lock.yaml'), 'utf8'));
  const missing = importers.filter(name => !locked.has(name));
  if (missing.length) throw new Error(`公开构建输入的锁缺少视图项目：${missing.join(', ')}；材料与本次源码不匹配。`);
  return { root: output, included, importers, inputs: source };
}

export function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '');
    if (!['root', 'output', 'inputs'].includes(name)) throw new Error(`未知参数：${args[index]}。`);
    options[name] = args[index + 1];
  }
  console.log(JSON.stringify(createPublicBuildView(options), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
