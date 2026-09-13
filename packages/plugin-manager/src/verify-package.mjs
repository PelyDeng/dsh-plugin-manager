/** Verify package identity, public resources and portable runtime references. */
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { discoverPlugins, privatePackagePath, parseOptions, sourcePlugins } from './plugins.mjs';
import { openArchiveMembers, readArchive } from './state.mjs';

/** Return the verified manifest without leaving extracted files behind. */
export function verifyPackage(plugin, archive) {
  const entries = readArchive(archive, ['-tzf', '-']).toString('utf8').trim().split(/\r?\n/u);
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.startsWith('package/') || entry.includes('\\') || entry.split('/').some(part => part === '..' || part === '.')
      || privatePackagePath(entry) || seen.has(entry)) throw new Error(`发布包包含私密、重复或非法路径：${entry}。`);
    seen.add(entry);
  }
  if (readArchive(archive, ['-tzvf', '-']).toString('utf8').split(/\r?\n/u).some(line => /^[lh]/u.test(line))) {
    throw new Error('发布包不得包含符号链接或硬链接。');
  }
  const members = [...new Set(['package/package.json', ...plugin.verifyFiles.map(file => `package/${file}`)])];
  const missing = members.find(member => !seen.has(member));
  if (missing) throw new Error(`发布包缺少文件：${missing.slice('package/'.length)}。`);
  const packedContents = openArchiveMembers(archive, members);
  try {
    const extract = file => packedContents.read(`package/${file}`);
    const packed = JSON.parse(extract('package.json').toString('utf8'));
    if (packed.name !== plugin.package || packed.version !== plugin.version) throw new Error('发布包的包名或版本与声明不一致。');
    for (const spec of Object.values({ ...packed.dependencies, ...packed.optionalDependencies, ...packed.peerDependencies })) {
      if (typeof spec !== 'string' || /^(?:file:|link:|workspace:|\.\.?\/|\/|[A-Za-z]:)/u.test(spec)) {
        throw new Error('发布包运行依赖不得指向工作区路径。');
      }
    }
    function verifyExport(value) {
      if (typeof value === 'string') {
        if (!value.startsWith('./') || !seen.has(`package/${value.slice(2)}`)) throw new Error(`发布包 exports 引用不存在：${value}。`);
      } else if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) verifyExport(child);
      }
    }
    verifyExport(packed.exports);
    for (const file of plugin.verifyFiles) {
      if (file === 'package.json') continue;
      if (privatePackagePath(file)) throw new Error(`不得校验或读取私密配置：${file}。`);
      extract(file);
    }
    return packed;
  } finally { packedContents.close(); }
}

/** Check the archive against the exact source build before emitting a release manifest. */
export function verifyBuildPackage(root, plugin, archive) {
  const packed = verifyPackage(plugin, archive);
  const sourceRoot = resolve(root, plugin.directory ?? '.');
  const source = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'));
  for (const field of ['deepseekPlugin', 'dsh', 'main', 'exports']) {
    if (JSON.stringify(packed[field]) !== JSON.stringify(source[field])) throw new Error(`发布包 ${field} 与插件声明不一致。`);
  }
  const files = plugin.verifyFiles.filter(file => file !== 'package.json');
  const packedContents = openArchiveMembers(archive, files.map(file => `package/${file}`));
  try {
    for (const file of files) {
      if (!packedContents.read(`package/${file}`).equals(readFileSync(resolve(sourceRoot, file)))) throw new Error(`发布包 ${file} 与本次构建文件不一致。`);
    }
  } finally { packedContents.close(); }
  return packed;
}

export function main(args = process.argv.slice(2)) {
  if (args[0]?.startsWith('--')) {
    const options = parseOptions(args, ['root', 'package', 'archive']);
    if (!options.root || options.package !== '.' || !options.archive) throw new Error('用法：verify-package --root <包根> --package . --archive <tgz>');
    const root = resolve(options.root);
    const [plugin] = sourcePlugins(root, undefined, options.package);
    verifyBuildPackage(root, plugin, resolve(root, options.archive));
    console.log(`发布包已验证：${plugin.id} ${plugin.version}。`);
    return;
  }
  const [sourceDirectory, archive, requestedRoot] = args;
  if (args.length !== 3 || !sourceDirectory || !archive || !requestedRoot) throw new Error('用法：verify-package <插件目录> <tgz> <项目根>');
  const root = resolve(requestedRoot);
  const directory = relative(root, resolve(sourceDirectory)).replaceAll('\\', '/');
  const plugin = discoverPlugins(root).find(candidate => candidate.directory === directory);
  if (!plugin) throw new Error('发布包所属插件未声明元数据。');
  verifyBuildPackage(root, plugin, resolve(archive));
  console.log(`发布包已验证：${plugin.id} ${plugin.version}。`);
}
