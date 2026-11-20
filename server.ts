import http from 'node:http';
import { TermLinkSignalingServer } from './apps/signaling-server/src/index';
import { TERMLINK_VERSION } from './packages/core/src/index';

const PORT = Number(process.env.PORT || 3000);
const publicBaseUrl = (process.env.TERMLINK_PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', publicBaseUrl);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'termlink-signaling',
        version: TERMLINK_VERSION,
        stats: signaling.engine.getStats(),
      })
    );
    return;
  }

  const joinMatch = url.pathname.match(/^\/join\/([0-9]{2})$/);
  if (joinMatch) {
    const code = joinMatch[1];
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      [
        `TermLink Room Code: ${code}`,
        '',
        'Join from your terminal:',
        `  npx @2we/tl ${code}`,
        `  tl ${code}`,
        `  tl join ${publicBaseUrl}/join/${code}`,
        '',
        `Signaling endpoint: ${publicBaseUrl.replace(/^http/, 'ws')}/ws`,
      ].join('\n') + '\n'
    );
    return;
  }

  const inviteMatch = url.pathname.match(/^\/invite\/([A-Za-z0-9_-]{16,128})$/);
  if (inviteMatch) {
    const token = inviteMatch[1];
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      [
        'TermLink Secure Invitation',
        '',
        'Join from your terminal:',
        `  npx @2we/tl join ${publicBaseUrl}/invite/${token}`,
        `  tl join ${publicBaseUrl}/invite/${token}`,
        '',
        `Signaling endpoint: ${publicBaseUrl.replace(/^http/, 'ws')}/ws`,
      ].join('\n') + '\n'
    );
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    [
      `TermLink Signaling Server v${TERMLINK_VERSION}`,
      `WebSocket signaling: ${publicBaseUrl.replace(/^http/, 'ws')}/ws`,
      `Health check:        ${publicBaseUrl}/health`,
      '',
      'Instant run (npx):',
      '  npx @2we/tl',
      '  npx @2we/tl 47',
      '',
      'Global install:',
      '  npm install -g @2we/tl',
      '  tl create',
      '  tl 47',
    ].join('\n') + '\n'
  );
});

const signaling = new TermLinkSignalingServer(httpServer, {
  publicBaseUrl,
  wsPath: '/ws',
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`TermLink Signaling Server v${TERMLINK_VERSION} listening on ws://0.0.0.0:${PORT}/ws`);
});
