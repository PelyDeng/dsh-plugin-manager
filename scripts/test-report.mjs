/** 在独立目录串联现有打包、真实宿主测试及报告交付，不执行站点部署。 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPnpm } from '../packages/plugin-manager/src/pnpm.mjs';

function run(args, root, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`测试流程停止，退出码 ${result.status ?? result.signal}；保留本次产物及诊断。`);
}

try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(`用法：bash test-report.sh [--cli <已构建的官方CLI路径>]
打包 auth/example → 真实官方宿主与本地模型替身测试 → 生成带验证记录的交付目录。
需要 Node.js ^22.19.0 或 >=24、框架锁定的 pnpm、tar 和已构建的官方 DSH CLI。
CLI 默认 deepseek-harness/apps/cli/lib/bin.js，也可沿用 DSH_TEST_CLI；相对路径以仓库根目录为准。
每次产物位于 .local/artifacts/test-report-*/，测试数据位于 .local/data/acceptance/。
默认回环端口18951，可用 EXAMPLE_TEST_PORT 指定；并行运行需不同端口。
不加载站点 env.conf、不部署、不测试其他业务插件或真实模型。详见 packages/plugin-manager/VERIFICATION.md。`);
  } else {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i].slice(2);
      if (!['--root', '--cli'].includes(args[i]) || Object.hasOwn(options, name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`无效或重复参数：${args[i]}。`);
      options[name] = args[i + 1];
    }
    if (!options.root) throw new Error('需要显式 --root；请使用仓库根 test-report.sh。');
    const root = resolve(options.root);
    const cli = resolve(root, options.cli ?? process.env.DSH_TEST_CLI ?? 'deepseek-harness/apps/cli/lib/bin.js');
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!(major === 22 && minor >= 19 || major >= 24)) throw new Error('需要 Node.js ^22.19.0 或 >=24。');
    if (!existsSync(cli)) throw new Error('缺少已构建的官方 DSH CLI。请先按官方说明在 deepseek-harness 内使用其锁定的 pnpm 安装并构建（pnpm install --frozen-lockfile && pnpm run build），或用 --cli 指定已有 CLI；本脚本不下载或构建宿主。');
    run([cli, '--version'], root);
    runPnpm(['--version'], root);
    const artifacts = join(root, '.local/artifacts');
    mkdirSync(artifacts, { recursive: true });
    const operation = mkdtempSync(join(artifacts, 'test-report-'));
    const candidate = join(operation, 'candidate'), report = join(operation, 'report.json'), delivery = join(operation, 'delivery');
    console.log(`本次测试目录：${operation}\n范围：auth/example；真实宿主、本地模型替身。`);
    runPnpm(['install', '--frozen-lockfile'], root);
    run([join(root, 'scripts/package-plugins.mjs'), '--root', root, '--plugins', 'auth,example', '--output', candidate], root);
    run([join(root, 'plugins/dsh-example/tests/host-smoke.mjs'), candidate, '--report', report], root, { ...process.env, DSH_TEST_CLI: cli });
    run([join(root, 'packages/plugin-manager/src/cli.mjs'), 'compose-release', '--root', root, '--manifest', join(candidate, 'manifest.json'), '--verification-report', report, '--output', delivery], root);
    console.log(`测试及报告交付完成。\n报告：${report}\n交付目录：${delivery}\n请交付此目录；再次打包产生的其他归档不自动继承本次验证。`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
