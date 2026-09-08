import { createHash } from 'node:crypto';
import { parseLiteralConfig, readPrivateConfig } from './literal-config.mjs';

// Each mapping is shared by parsing, migration and the public Chinese template.
export const deploymentFields = [
  ['DSH_PUBLIC_URL', 'publicUrl', 'string', '对外访问地址。不带路径或末尾斜杠；本机默认为 http://127.0.0.1:7902，公网部署填写自己的地址。'],
  ['DSH_PUBLIC_ORIGIN', 'publicOrigin', 'string', '认证请求来源。留空沿用 DSH_PUBLIC_URL；认证启用时必须与实际浏览器来源一致。'],
  ['DSH_TRUSTED_HOSTS', 'trustedHosts', 'array', '官方控制台信任主机，JSON数组，例如 ["dsh.example.com"]。公网访问需配置；不带协议或路径，不使用通配符。'],
  ['DSH_BIND_HOST', 'host', 'string', '非容器宿主监听地址，默认 127.0.0.1。源码Compose仍使用回环监听，公网通过反向代理访问。'],
  ['DSH_PORT', 'port', 'integer', '监听端口，默认7902，范围1到65535；自定义后同时核对访问URL。'],
  ['DSH_PROFILE', 'profile', 'string', '官方profile，默认web。已有站点切换需要迁移，不能当成无损改名。'],
  ['DSH_PLUGINS', 'plugins', 'array', '候选插件ID的JSON数组。源码首次部署默认 ["auth","example"]；独立归档留空沿用清单；[]表示空选集。'],
  ['DSH_MODE', 'mode', 'string', 'release或development。独立管理器及有配置的启动默认release；源码容器部署只使用release。'],
  ['DSH_HOST_MODE', 'hostMode', 'string', 'owned或external。独立同步默认external，需要原管理者停服证据；start由管理器拥有宿主。'],
  ['DSH_DATA_DIR', 'dataRoot', 'string', '持久数据根，默认.local/data。已有目录必须沿用或正式迁移，不能删除排错。'],
  ['DSH_HOME', 'home', 'string', 'DSH数据目录，默认数据根下dsh-home。含凭据、账号与会话；沿用旧站点已解析路径。'],
  ['DSH_WORKSPACE', 'workspace', 'string', '工作目录，默认数据根下workspace。相对路径以显式项目root为基准。'],
  ['DSH_AUTH_URL_FILE', 'authUrlFile', 'string', '官方控制台认证地址输出，默认数据根下dsh-web-auth-url.txt。此文件含令牌，勿公开。'],
  ['DSH_DEPLOY_ARTIFACTS', 'artifacts', 'string', '管理器产物目录，默认.local/artifacts；源码构建记录与备份始终位于仓库.local/artifacts/source-release-*。不得与持久数据重叠或通过clean删除。'],
  ['DSH_HARNESS_ROOT', 'harnessRoot', 'string', '非容器运行的官方源码根，需提前准备独立依赖。与已安装CLI来源按原优先级选择，不自动下载。'],
  ['DSH_CLI_JS', 'dshCliJs', 'string', '非容器运行的已安装官方CLI JavaScript入口；独立交付按实际安装位置填写。'],
  ['DSH_CLI', 'dshCli', 'string', '非容器官方CLI可执行文件；未指定其他宿主来源时默认从PATH使用dsh。'],
  ['DSH_PATCHES', 'patches', 'array', '额外官方patch文件路径的JSON数组，默认[]。模型路由和默认模型复用官方设置；API Key不会自动创建路由。'],
  ['DSH_INSTANCES', 'instances', 'object', '按插件ID组织的文件引用，支持settingsFile/runtimeConfig/configRevision。业务参数仍由插件自己的配置维护。'],
  ['DSH_OFFLINE', 'offline', 'boolean', '是否离线安装，true/false，默认false。须预先准备完整依赖闭包，仅填写true不代表已具备离线能力。'],
  ['DSH_STORE_DIR', 'storeDir', 'string', '独立安装的pnpm store位置；留空沿用包管理器默认，容器使用受管数据根。'],
  ['DSH_CACHE_DIR', 'cacheDir', 'string', '独立安装的包缓存位置；留空沿用默认。'],
  ['DSH_OFFLINE_STORE_DIR', 'offlineStore', 'string', '已准备的离线store输入目录；容器只读挂载，不修改源。'],
  ['DSH_OFFLINE_CACHE_DIR', 'offlineCache', 'string', '已准备的离线cache输入目录；容器只读挂载，不修改源。'],
  ['DSH_COMPOSE_PROJECT', 'composeProject', 'string', 'Compose项目名，默认dsh-plugins。每站点独占，已有站点不得随意更换。'],
  ['DSH_CONTAINER_UID', 'containerUid', 'integer', '容器非root用户ID，通用默认1000；自动新站点按平台初始化，macOS采用当前非root用户；显式配置保留，不自动递归修改已有属主。'],
  ['DSH_CONTAINER_GID', 'containerGid', 'integer', '容器非root用户组ID，通用默认1000；自动新站点按平台初始化，macOS采用当前用户组；显式配置保留，须能访问运行输入与数据。'],
  ['DSH_HOST_IMAGE', 'hostImage', 'string', '可选预构建宿主镜像，必须为不可变仓库@sha256摘要；留空按源码部署流程构建/复用。'],
  ['DSH_PUBLISH_IMAGE', 'publishImage', 'string', '可选部署镜像推送目标：仓库主机/项目/镜像，不含tag。留空仅使用本机镜像。'],
  ['DSH_CONTAINER_IMAGE', 'containerImage', 'string', '仅独立apply-compose输入：不可变镜像ID或仓库摘要。源码一键构建自动生成，必须留空。'],
  ['DSH_MANIFEST', 'manifest', 'string', '仅独立归档消费：发布清单路径。源码一键构建自动生成，必须留空。'],
  ['DSH_BASE_URL', 'baseUrl', 'string', '独立健康验收的宿主地址；留空沿用相应启动入口的原默认行为。'],
];

export const imageFields = [
  ['HARBOR_ENABLED', 'false', '是否使用Harbor镜像分流，true/false，默认false。'],
  ['ALLOW_UPSTREAM', 'true', 'Harbor明确缺少镜像时是否允许上游回退，默认true；认证、网络和TLS错误不能回退。'],
  ['REGISTRY_HOST', '', '可选镜像仓库主机，可带端口，不带协议或路径。启用Harbor时必填。'],
  ['BASE_PROJECT', 'library', '镜像仓库基础镜像项目，默认library。'],
  ['APP_PROJECT', 'dsh', '宿主与工具链镜像项目，默认dsh。'],
  ['IMAGE_NAME', 'dsh-host', '宿主镜像名称，默认dsh-host，不含仓库、项目或tag。'],
  ['REGISTRY_USERNAME', '', '私密：仓库登录用户名；需要认证时与密码成对填写，匿名访问留空。'],
  ['REGISTRY_PASSWORD', '', '私密：仓库登录密码；仅用于临时Docker登录，不传给业务宿主、不写入镜像或命令参数。'],
  ['DSH_SOURCE_BASE_IMAGE', 'docker.io/library/node:24-bookworm-slim', '官方源码构建基础镜像；默认docker.io/library/node:24-bookworm-slim。'],
  ['DSH_DEBIAN_MIRROR', 'http://deb.debian.org', 'Debian软件源地址，默认http://deb.debian.org，可按网络情况设置镜像源。'],
  ['DSH_IMAGE_PLATFORM', 'linux/amd64', '容器构建平台：linux/amd64或linux/arm64，通用默认linux/amd64；自动新站点按Docker引擎初始化，显式配置保留。'],
];
export const imageDefaults = Object.fromEntries(imageFields.map(([key, value]) => [key, value]));
export const credentialFields = [
  ['DEEPSEEK_API_KEY', '私密：官方DeepSeek API Key。非空时文件优先、网页只读；留空不添加覆盖，沿用官方已有凭据。'],
  ['ZHIPU_API_KEY', '私密：智谱API Key。非空时文件优先、网页只读；留空不添加覆盖。还需在官方DSH配置相应模型路由。'],
];
export const frameworkKeys = new Set([...deploymentFields, ...imageFields, ...credentialFields].map(([key]) => key));

/** Public, fixed source-site defaults; derived paths and entry-specific choices stay unset. */
export const publicDeploymentDefaults = {
  publicUrl: 'http://127.0.0.1:7902', host: '127.0.0.1', port: 7902, profile: 'web', plugins: ['auth', 'example'],
  mode: 'release', dataRoot: '.local/data', artifacts: '.local/artifacts', dshCli: 'dsh', patches: [], instances: {},
  offline: false, composeProject: 'dsh-plugins', containerUid: 1000, containerGid: 1000,
};

export function decodeFrameworkConfig(text) {
  const values = parseLiteralConfig(text, frameworkKeys);
  const config = {};
  for (const [key, field, type] of deploymentFields) {
    const raw = values[key];
    if (!raw) continue;
    let value = raw;
    if (type === 'integer') {
      if (!/^[0-9]+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${key} 必须是整数。`);
      value = Number(raw);
    } else if (type === 'boolean') {
      if (!['true', 'false'].includes(raw)) throw new Error(`${key} 必须是true或false。`);
      value = raw === 'true';
    } else if (type === 'array' || type === 'object') {
      try { value = JSON.parse(raw); } catch { throw new Error(`${key} 必须是有效JSON。`); }
      if (type === 'array' ? !Array.isArray(value) : !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} 必须是${type === 'array' ? 'JSON数组' : 'JSON对象'}。`);
    }
    config[field] = value;
  }
  if (config.instances) for (const [id, instance] of Object.entries(config.instances)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(id) || !instance || typeof instance !== 'object' || Array.isArray(instance)
      || Object.keys(instance).some(key => !['settingsFile', 'runtimeConfig', 'configRevision'].includes(key))) throw new Error('DSH_INSTANCES只能包含插件ID及settingsFile/runtimeConfig/configRevision引用，业务配置由插件维护。');
    for (const key of ['settingsFile', 'runtimeConfig']) if (instance[key] !== undefined && (typeof instance[key] !== 'string' || !instance[key].trim())) throw new Error(`DSH_INSTANCES的${key}必须是非空文件路径。`);
    if (instance.configRevision !== undefined && (!Number.isSafeInteger(instance.configRevision) || instance.configRevision < 0)) throw new Error('DSH_INSTANCES的configRevision必须是非负整数。');
  }
  for (const [key, field, type] of deploymentFields) if (type === 'array' && config[field]?.some(value => typeof value !== 'string' || !value.trim())) throw new Error(`${key}必须只包含非空字符串。`);
  if (!config.publicOrigin && config.publicUrl) config.publicOrigin = config.publicUrl;
  const image = { ...imageDefaults };
  for (const [key] of imageFields) if (values[key]) image[key] = values[key];
  const credentials = Object.fromEntries(credentialFields.filter(([key]) => values[key]).map(([key]) => [key, values[key]]));
  return { config, image, credentials };
}

export function readFrameworkConfig(path) {
  const bytes = readPrivateConfig(path);
  return { ...decodeFrameworkConfig(bytes.toString('utf8')), bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Public templates spell out fixed defaults; private rendering preserves the supplied resolved input. */
export function renderFrameworkConfig({ config = {}, image = {}, credentials = {}, privateInput = false } = {}) {
  if (!privateInput) { config = { ...publicDeploymentDefaults, ...config }; image = { ...imageDefaults, ...image }; }
  const lines = [
    privateInput ? '# DSH框架私有运行配置' : '# DSH框架配置入口（公开默认模板）',
    privateInput ? '# 此文件可能含凭据，保存在Git忽略目录；不得提交、公开或复制到镜像。' : '# 固定公开默认值已填写；真实环境配置和凭据保存在Git忽略的.local/env.conf，不在此修改。',
    '# KEY=VALUE是字面量，不执行shell；复杂值用单行JSON，路径相对显式项目root。',
    '# 留空采用该入口默认行为；修改文件后通过正常部署流程备份并受控重启。',
    '# API空值不是删除；若启动环境有同名密钥，官方仍会优先使用且网页只读。',
    '# 注册插件的业务配置各自维护；账号、授权、会话和历史不是此文件的配置。',
    '# 通常只需检查访问地址与所用模型凭据；自动新站点按平台初始化，手工复制模板需核对UID、GID和镜像架构。',
  ];
  const append = (key, comment, value) => {
    lines.push('', `# ${comment}`, `${key}=${value === undefined || value === null || value === '' ? '' : JSON.stringify(value)}`);
  };
  lines.push('', '# 一、常用配置：公网访问时核对地址，只填写需要使用的模型凭据');
  const primary = new Set(['publicUrl', 'publicOrigin', 'trustedHosts']);
  for (const [key, field, , comment] of deploymentFields.filter(([, field]) => primary.has(field))) append(key, comment, config[field]);
  for (const [key, comment] of credentialFields) append(key, comment, credentials[key]);
  lines.push('', '# 二、高级部署配置：固定默认值已填写，派生或按入口选择的字段留空');
  for (const [key, field, , comment] of deploymentFields.filter(([, field]) => !primary.has(field))) append(key, comment, config[field]);
  lines.push('', '# 三、可选镜像仓库与构建环境：公开默认值已填写，仓库凭据始终留空');
  for (const [key, , comment] of imageFields) append(key, comment, image[key]);
  return lines.join('\n') + '\n';
}

/** One exact allowlist protects both repository checks and the example's public source snapshot. */
export function assertPublicFrameworkConfig(text) {
  const values = parseLiteralConfig(text, frameworkKeys);
  const defaults = parseLiteralConfig(renderFrameworkConfig(), frameworkKeys);
  if (Object.keys(values).length !== frameworkKeys.size || [...frameworkKeys].some(key => values[key] !== defaults[key])) {
    throw new Error('公开env.conf只能包含完整受控默认值和空凭据；真实配置必须保存在.local/env.conf，不能进入源码索引。');
  }
}
