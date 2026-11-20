import http from 'node:http';
import { TermLinkSignalingServer } from './index';

const port = Number(process.env.PORT || 8787);
const publicBaseUrl = process.env.TERMLINK_PUBLIC_BASE_URL || `http://localhost:${port}`;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'termlink-signaling', stats: signaling.engine.getStats() }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('TermLink Signaling Server is running.\n');
});

const signaling = new TermLinkSignalingServer(server, {
  publicBaseUrl,
  wsPath: '/ws',
});

server.listen(port, '0.0.0.0', () => {
  console.log(`TermLink Signaling Server listening on ws://0.0.0.0:${port}/ws`);
});
