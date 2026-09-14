/**
 * 镜像层数报数：只记录事实，不设阈值、不做熔断。
 *
 * 源码路径默认以上一次部署的镜像为基底继续叠加，层数会随发布次数增长；真正的治理是
 * 固定一个可验证的稳定基底，阈值只是预警。要让阈值有依据，先得拿到本机实际的数字：
 * `RootFS.Layers` 长度、驱动与引擎版本，以及基底与最终镜像各自新增了多少层。
 * 因此本模块只返回计数与身份，不比较、不拒绝。
 */
export function layerReport(info, { driver = null, engine = null, base = null } = {}) {
  const layers = Array.isArray(info?.RootFS?.Layers) ? info.RootFS.Layers.length : null;
  const added = base === null || layers === null ? null : layers - base;
  return {
    layers,
    added,
    history: Array.isArray(info?.History) ? info.History.length : null,
    driver,
    engine,
  };
}

/** 一次发布里的层数对比：基底实际是多少、本次镜像加了多少。 */
export function formatLayerReport({ base, image, driver, engine }) {
  const parts = [];
  if (base?.layers !== null && base?.layers !== undefined) parts.push(`基底 ${base.layers} 层`);
  if (image?.layers !== null && image?.layers !== undefined) {
    parts.push(`本次镜像 ${image.layers} 层${image.added === null ? '' : `（本次新增 ${image.added}）`}`);
  }
  if (driver) parts.push(`驱动 ${driver}`);
  if (engine) parts.push(`引擎 ${engine}`);
  return parts.join('；');
}
