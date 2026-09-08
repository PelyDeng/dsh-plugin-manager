import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { containerAddress, forwardContainerLoopback } from '../src/container-forward.mjs';

// macOS does not bind unconfigured 127.0.0.2; IPv6 loopback keeps the same-port listener separate.
const forwardAddress = process.platform === 'darwin' ? '::1' : '127.0.0.2';

test('container forwarding requires one non-loopback IPv4 address', () => {
  const lo = [{ family: 'IPv4', internal: true, address: '127.0.0.1' }];
  const eth0 = [{ family: 'IPv4', internal: false, address: '192.0.2.4' }];
  assert.equal(containerAddress({ lo, eth0 }), '192.0.2.4');
  assert.throws(() => containerAddress({ lo }), /唯一/);
  assert.throws(() => containerAddress({ eth0, eth1: [{ ...eth0[0], address: '192.0.2.5' }] }), /唯一/);
});

test('forwarding preserves a large response after the client half-closes its request', async t => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 'x');
  const backend = createServer({ allowHalfOpen: true }, socket => {
    let request = '';
    socket.on('data', data => { request += data; });
    socket.on('end', () => { assert.equal(request, '中文 request'); socket.end(payload); });
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const port = backend.address().port;
  const close = await forwardContainerLoopback(port, forwardAddress);
  t.after(close);
  const client = createConnection({ host: forwardAddress, port });
  const chunks = [];
  client.on('data', data => chunks.push(data));
  client.end('中文 request'); await once(client, 'close');
  assert.deepEqual(Buffer.concat(chunks), payload);
});

test('forwarding keeps bidirectional connections and closes all sockets with its owner', async t => {
  const accepted = new Set();
  const backend = createServer(socket => { accepted.add(socket); socket.on('close', () => accepted.delete(socket)); socket.pipe(socket); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  t.after(() => { for (const socket of accepted) socket.destroy(); backend.close(); });
  const port = backend.address().port;
  const close = await forwardContainerLoopback(port, forwardAddress);
  t.after(close);
  const client = createConnection({ host: forwardAddress, port });
  await once(client, 'connect');
  for (const text of ['stream-1', 'stream-2']) {
    const response = once(client, 'data'); client.write(text);
    assert.equal((await response)[0].toString(), text);
  }
  const disconnected = once(client, 'close');
  await close(); await disconnected;
  await assert.rejects(new Promise((resolve, reject) => { const socket = createConnection({ host: forwardAddress, port }); socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject); }), { code: 'ECONNREFUSED' });
});

test('occupied forward listener rejects without taking ownership of the existing listener', async t => {
  const backend = createServer(); backend.listen(0, forwardAddress); await once(backend, 'listening');
  t.after(() => backend.close());
  await assert.rejects(forwardContainerLoopback(backend.address().port, forwardAddress), { code: 'EADDRINUSE' });
  assert.equal(backend.listening, true);
});
