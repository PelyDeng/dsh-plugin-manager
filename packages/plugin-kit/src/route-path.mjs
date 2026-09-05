/** Canonical non-root plugin namespace, shared by metadata and HTTP registration. */
export function isPluginPath(path) {
  return typeof path === 'string' && /^\/[A-Za-z0-9_~./-]+$/.test(path)
    && !path.endsWith('/') && !path.includes('//')
    && !path.split('/').some(part => part === '.' || part === '..');
}
