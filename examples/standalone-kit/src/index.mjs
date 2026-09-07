/** Protected account identity endpoint; business data ownership stays with its application. */
import { actorKey, createAccess, createPluginHttp, registerPlugin } from '@dsh-plugin-manager/plugin-kit';
export const name = 'independent-access-example';
export const inject = ['webServer'];

/** Register shared authorization and bind the HTTP route to this plugin's lifecycle. */
export function apply(ctx, config) {
  const access = createAccess(ctx, { pluginId: name, mode: config.accessMode, publicOrigin: config.publicOrigin ?? '' });
  const http = createPluginHttp(ctx, { access, routePrefix: '/independent-access-example' });
  registerPlugin(ctx, { id: name, packageName: 'dsh-independent-access-example', version: '0.1.0',
    displayName: '独立鉴权示例', description: '检查当前账号是否获准访问本应用', permissions: [`${name}:access`], tools: [] });
  ctx.effect(() => http.register({ kind: 'exact', path: '/independent-access-example/identity', handler(_request, response, actor) {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ owner: actorKey(actor) }));
  } }));
}
