import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, test } from 'node:test';
import { createEgressProxy, hostAllowed } from '../src/proxy.mjs';

const closers = [];
after(() => closers.forEach((close) => close()));

// An upstream that answers every connection, standing in for an allowed internet host.
async function upstream() {
  const server = http.createServer((req, res) => res.end(`upstream saw ${req.method} ${req.url} host=${req.headers.host}`));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => server.close());
  return server.address().port;
}

async function startProxy(allowHosts) {
  const upstreamPort = await upstream();
  const dialed = [];
  // Every allowed host "resolves" to the local upstream, so no test touches the network.
  const dial = (host, port) => {
    dialed.push(`${host}:${port}`);
    return net.connect(upstreamPort, '127.0.0.1');
  };
  const proxy = createEgressProxy({ allowHosts, dial });
  const port = await proxy.start();
  closers.push(() => proxy.stop());
  return { proxy, port, dialed };
}

// Sends raw bytes to the proxy and resolves with everything it answers.
function raw(port, text, { thenSend } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    let sentSecond = false;
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => {
      data += chunk;
      if (thenSend && !sentSecond && data.includes('\r\n\r\n')) {
        sentSecond = true;
        socket.write(thenSend);
      }
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    setTimeout(() => socket.destroy(), 1500);
  });
}

test('hostAllowed matches exact names and *.suffix entries, case-insensitively', () => {
  const allow = ['registry.example.org', '*.cdn.example.org'];
  assert.equal(hostAllowed('registry.example.org', allow), true);
  assert.equal(hostAllowed('REGISTRY.example.org', allow), true);
  assert.equal(hostAllowed('a.b.cdn.example.org', allow), true);
  assert.equal(hostAllowed('cdn.example.org', allow), false);
  assert.equal(hostAllowed('registry.example.org.evil.test', allow), false);
  assert.equal(hostAllowed('evilregistry.example.org', allow), false);
  assert.equal(hostAllowed('127.0.0.1', allow), false);
  assert.equal(hostAllowed('', allow), false);
});

test('CONNECT to an allowed host on port 443 is tunnelled', async () => {
  const { port, dialed } = await startProxy(['registry.example.org']);
  const answer = await raw(port, 'CONNECT registry.example.org:443 HTTP/1.1\r\nHost: registry.example.org:443\r\n\r\n', {
    thenSend: 'GET /ping HTTP/1.1\r\nHost: registry.example.org\r\nConnection: close\r\n\r\n',
  });
  assert.match(answer, /^HTTP\/1\.1 200 /);
  assert.match(answer, /upstream saw GET \/ping/);
  assert.deepEqual(dialed, ['registry.example.org:443']);
});

test('CONNECT to any other host is refused and remembered', async () => {
  const { proxy, port, dialed } = await startProxy(['registry.example.org']);
  const answer = await raw(port, 'CONNECT evil.example.net:443 HTTP/1.1\r\nHost: evil.example.net:443\r\n\r\n');
  assert.match(answer, /^HTTP\/1\.1 403 /);
  assert.deepEqual(dialed, []);
  assert.deepEqual([...proxy.denied], ['evil.example.net:443']);
});

test('CONNECT to an allowed host on another port is refused', async () => {
  const { port, dialed } = await startProxy(['registry.example.org']);
  for (const target of ['registry.example.org:22', 'registry.example.org:8950', 'registry.example.org', 'registry.example.org:abc']) {
    assert.match(await raw(port, `CONNECT ${target} HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403 /, target);
  }
  assert.deepEqual(dialed, []);
});

test('a plain HTTP request to an allowed host is forwarded, and refused for any other', async () => {
  const { port, dialed, proxy } = await startProxy(['registry.example.org']);
  const ok = await raw(port, 'GET http://registry.example.org/pkg HTTP/1.1\r\nHost: registry.example.org\r\nConnection: close\r\n\r\n');
  assert.match(ok, /upstream saw GET \/pkg host=registry\.example\.org/);
  assert.deepEqual(dialed, ['registry.example.org:80']);
  const no = await raw(port, 'GET http://evil.example.net/x HTTP/1.1\r\nHost: evil.example.net\r\nConnection: close\r\n\r\n');
  assert.match(no, /^HTTP\/1\.1 403 /);
  const local = await raw(port, 'GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  assert.match(local, /^HTTP\/1\.1 403 /);
  assert.ok(proxy.denied.has('evil.example.net:80'));
});

test('the proxy listens on loopback only and stops cleanly', async () => {
  const { proxy, port } = await startProxy([]);
  assert.equal(proxy.url, `http://127.0.0.1:${port}`);
  await proxy.stop();
  await assert.rejects(() => raw(port, 'CONNECT a:443 HTTP/1.1\r\n\r\n'));
});
