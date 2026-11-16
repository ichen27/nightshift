// A small forward proxy the job runs on loopback while a sandboxed command is working.
// The sandbox closes the internet to that command; this proxy is the one way out, and it
// only connects to an allow-list of host names (HTTPS on 443 through CONNECT, plain HTTP
// on 80). Everything else is refused and remembered so the report can name it.
import http from 'node:http';
import net from 'node:net';

export function hostAllowed(host, allowHosts) {
  const name = String(host ?? '').toLowerCase();
  if (name === '') return false;
  return allowHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    return allowed.startsWith('*.') ? name.endsWith(allowed.slice(1)) && name.length > allowed.length - 1 : name === allowed;
  });
}

const REFUSAL = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

export function createEgressProxy({ allowHosts, dial = (host, port) => net.connect(port, host) }) {
  const denied = new Set();
  const open = new Set();
  const track = (socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };

  const server = http.createServer((req, res) => {
    let url = null;
    try {
      url = new URL(req.url);
    } catch {
      // Not an absolute address: someone is talking to the proxy as if it were a website.
    }
    const port = url ? Number(url.port || 80) : null;
    if (!url || url.protocol !== 'http:' || port !== 80 || !hostAllowed(url.hostname, allowHosts)) {
      if (url) denied.add(`${url.hostname}:${port}`);
      res.writeHead(403, { connection: 'close', 'content-length': '0' });
      res.end();
      return;
    }
    const headers = { ...req.headers, connection: 'close' };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const forward = http.request(
      { method: req.method, path: `${url.pathname}${url.search}`, headers, createConnection: () => track(dial(url.hostname, 80)) },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      },
    );
    forward.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { connection: 'close', 'content-length': '0' });
      res.end();
    });
    req.pipe(forward);
  });

  server.on('connect', (req, client, head) => {
    track(client);
    const target = /^([A-Za-z0-9.-]+):(\d+)$/.exec(req.url ?? '');
    if (!target || target[2] !== '443' || !hostAllowed(target[1], allowHosts)) {
      denied.add(String(req.url));
      client.end(REFUSAL);
      return;
    }
    const upstream = track(dial(target[1], 443));
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    client.on('close', () => upstream.destroy());
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  const proxy = {
    denied,
    url: null,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          proxy.url = `http://127.0.0.1:${server.address().port}`;
          resolve(server.address().port);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
  return proxy;
}
