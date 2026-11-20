import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TermLinkSignalingServer } from '../../apps/signaling-server/src/index';
import { computeFileSha256 } from '../../packages/file-transfer/src/index';
import { TermLink } from '../../packages/sdk/src/index';

async function startTestServer(): Promise<{
  url: string;
  server: http.Server;
  signaling: TermLinkSignalingServer;
}> {
  const server = http.createServer();
  const signaling = new TermLinkSignalingServer(server, {
    publicBaseUrl: 'http://127.0.0.1',
    wsPath: '/ws',
    rateLimitMaxAttempts: 50,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    server,
    signaling,
  };
}

test('End-to-end multi-peer lifecycle: create, 2-digit join + approval, 3-peer group, E2EE chat, real SHA-256 file transfer, disconnect, reconnect, and terminal share', async () => {
  const { url, server, signaling } = await startTestServer();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'termlink-int-'));
  const dirA = path.join(tmpRoot, 'peerA');
  const dirB = path.join(tmpRoot, 'peerB');
  const dirC = path.join(tmpRoot, 'peerC');
  const dlB = path.join(tmpRoot, 'downloadsB');

  const clientA = new TermLink({ deviceName: 'AADI-PC', signalingServer: url, storageDir: dirA });
  const clientB = new TermLink({ deviceName: 'RAHUL-LAPTOP', signalingServer: url, storageDir: dirB, fileTransferDirectory: dlB });
  const clientC = new TermLink({ deviceName: 'UBUNTU-VM', signalingServer: url, storageDir: dirC });

  try {
    // Test 1: Computer A creates room with 2-digit code
    await clientA.initialize();
    const roomA = await clientA.createRoom({ roomName: 'DEV TEAM', requireHostApproval: true });
    assert.match(roomA.code, /^[0-9]{2}$/);
    assert.equal(roomA.members.length, 1);

    // Host auto-approves expected peers B and C upon joinRequest
    const pendingRequests: string[] = [];
    roomA.on('joinRequest', (req) => {
      pendingRequests.push(req.identity.deviceName);
      roomA.approveJoin(req.requestId, 'collaborator');
    });

    // Test 2: Computer B joins using 2-digit code and gets approved by Host A
    await clientB.initialize();
    let sawPending = false;
    const roomB = await clientB.joinRoom(roomA.code, {
      onPending: (info) => {
        sawPending = info.roomName === 'DEV TEAM' && info.hostName === 'AADI-PC';
      },
    });
    assert.equal(sawPending, true);
    assert.equal(roomB.code, roomA.code);
    assert.ok(pendingRequests.includes('RAHUL-LAPTOP'));

    // Test 3: Computer C joins same group -> all 3 members visible
    await clientC.initialize();
    const roomC = await clientC.joinRoom(roomA.code);
    const savedReconnectTokenC = roomC.reconnectToken;
    const savedRoomId = roomC.roomId;

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(roomA.members.length, 3);
    assert.equal(roomB.members.length, 3);
    assert.equal(roomC.members.length, 3);

    // Test 4: Messaging — Computer A sends E2EE group message, B and C receive it
    const receivedByB = new Promise<string>((resolve) => {
      roomB.once('message', (m) => resolve(m.text));
    });
    const receivedByC = new Promise<string>((resolve) => {
      roomC.once('message', (m) => resolve(m.text));
    });

    await roomA.sendMessage('Server started on port 3000');
    assert.equal(await receivedByB, 'Server started on port 3000');
    assert.equal(await receivedByC, 'Server started on port 3000');

    // Private message from B to A
    const pmToA = new Promise<string>((resolve) => {
      roomA.once('privateMessage', (m) => resolve(m.text));
    });
    await roomB.sendPrivateMessage('AADI-PC', 'Private hello from Rahul');
    assert.equal(await pmToA, 'Private hello from Rahul');

    // Test 5: Real File Transfer — Computer A sends a 160 KB binary file to Computer B -> verify SHA-256
    const srcFile = path.join(tmpRoot, 'artifact.bin');
    fs.writeFileSync(srcFile, crypto.randomBytes(160 * 1024));
    const originalHash = (await computeFileSha256(srcFile)).sha256;

    const fileCompleteB = new Promise<{ savedPath: string; verified: boolean; sha256: string }>((resolve) => {
      roomB.once('fileComplete', (ev) => resolve(ev));
    });

    roomB.once('fileOffer', (offer) => {
      assert.equal(offer.filename, 'artifact.bin');
      assert.equal(offer.senderName, 'AADI-PC');
      offer.accept(dlB);
    });

    await roomA.sendFile(srcFile, { toPeer: 'RAHUL-LAPTOP' });
    const doneB = await fileCompleteB;
    assert.equal(doneB.verified, true);
    assert.equal(doneB.sha256, originalHash);
    assert.equal(fs.existsSync(doneB.savedPath), true);
    const receivedHash = (await computeFileSha256(doneB.savedPath)).sha256;
    assert.equal(receivedHash, originalHash);

    // Test 6 & 7: Disconnect & Reconnection — Computer C disconnects, group notified, then C reconnects
    const peerLeftPromise = new Promise<string>((resolve) => {
      roomA.once('peerLeft', (ev) => resolve(ev.deviceName));
    });
    await clientC.disconnect();
    assert.equal(await peerLeftPromise, 'UBUNTU-VM');

    const clientCReconnect = new TermLink({ deviceName: 'UBUNTU-VM', signalingServer: url, storageDir: dirC });
    await clientCReconnect.initialize();
    const rejoinedC = await clientCReconnect.joinRoom('', {
      roomId: savedRoomId,
      reconnectToken: savedReconnectTokenC,
    });
    assert.equal(rejoinedC.roomId, savedRoomId);
    assert.equal(rejoinedC.members.length, 3);
    await clientCReconnect.disconnect();

    // Test 8: Real Shared Terminal Session — disabled by default, read-only blocks input, interactive executes
    const termOutputB: string[] = [];
    roomB.on('terminalOutput', (ev) => termOutputB.push(ev.data));

    const term = roomA.startTerminalSession('backend-server', tmpRoot);
    roomA.setTerminalPeerAccess(roomB.localPeerId, 'read-only');

    // Attempt input while read-only -> must be rejected by Host A
    const secWarn = new Promise<string>((resolve) => {
      roomA.once('securityWarning', (w) => resolve(w.reason));
    });
    await new Promise((r) => setTimeout(r, 150));
    roomB.sendTerminalInput('echo SHOULD_NOT_RUN\n');
    const warnMsg = await secWarn;
    assert.match(warnMsg, /unauthorized remote terminal input/i);

    // Grant interactive access -> command executes and streams output to Peer B
    roomA.setTerminalPeerAccess(roomB.localPeerId, 'interactive');
    const cmd = process.platform === 'win32' ? 'Write-Output TERMLINK_LIVE_OK\r\n' : 'echo TERMLINK_LIVE_OK\n';
    roomB.sendTerminalInput(cmd);
    const outputReceived = new Promise<void>((resolve) => {
      const check = () => {
        if (termOutputB.join('').includes('TERMLINK_LIVE_OK')) {
          resolve();
        }
      };
      roomB.on('terminalOutput', check);
      check();
    });
    await Promise.race([outputReceived, new Promise((r) => setTimeout(r, 5000))]);
    assert.ok(termOutputB.join('').includes('TERMLINK_LIVE_OK'));

    // Instant revocation stops further input
    term.revokePeer(roomB.localPeerId, 'RAHUL-LAPTOP');
    assert.equal(term.canPeerInteract(roomB.localPeerId), false);
    roomA.stopTerminalSession();
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    await clientA.disconnect();
    await clientB.disconnect();
    await clientC.disconnect();
    await signaling.close();
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
