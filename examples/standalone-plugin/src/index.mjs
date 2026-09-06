/** A public, non-sensitive endpoint on the official DSH WebServer. */
export const name = 'independent-example';
export const inject = ['webServer'];

/** Mount the endpoint for exactly this plugin's lifetime. */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/independent-example/ready',
    handler(_request, response) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
    },
  }));
}
