/** Bridge a container address to the official host's loopback listener without changing HTTP. */
import { createConnection, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';

export function containerAddress(interfaces = networkInterfaces()) {
  const addresses = [...new Set(Object.values(interfaces).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => item.address))];
  if (addresses.length !== 1) throw new Error('容器回环转发需要唯一的非回环 IPv4 地址。');
  return addresses[0];
}

/** The caller owns the listener and every accepted connection through the returned close function. */
export async function forwardContainerLoopback(port, address = containerAddress()) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('容器回环转发端口无效。');
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, socket => {
    const upstream = createConnection({ host: '127.0.0.1', port, allowHalfOpen: true });
    for (const [source, peer] of [[socket, upstream], [upstream, socket]]) {
      sockets.add(source);
      source.on('error', () => peer.destroy());
      source.once('close', () => {
        sockets.delete(source);
        // Preserve a normal half-close until the peer has flushed its response.
        if (!source.readableEnded) peer.destroy();
      });
    }
    socket.pipe(upstream); upstream.pipe(socket);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, address, resolve); });
  let closed;
  return () => closed ??= new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  });
}
