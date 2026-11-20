import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TermLinkSignalingServer } from '../../apps/signaling-server/src/index';
import { RoomEngine } from '../../packages/room-engine/src/index';
import { generateLocalIdentity } from '../../packages/identity/src/index';
import { TermLink } from '../../packages/sdk/src/index';

test('Security: rate limiting blocks rapid 2-digit code enumeration attempts', () => {
  const engine = new RoomEngine({ rateLimitMaxAttempts: 5, rateLimitWindowMs: 60_000 });
  for (let i = 0; i < 5; i++) {
    engine.lookupByCode(`0${i}`, 'attacker-ip');
  }
  assert.throws(() => engine.lookupByCode('06', 'attacker-ip'), /Too many room discovery/i);
});

test('Security: expired, revoked, and used one-time invite tokens are rejected', () => {
  const engine = new RoomEngine();
  const host = generateLocalIdentity('HOST');
  const guest1 = generateLocalIdentity('GUEST-1');
  const guest2 = generateLocalIdentity('GUEST-2');

  const { room } = engine.createRoom({
    ownerPeerId: 'host1',
    ownerIdentity: host.publicIdentity,
    roomName: 'Private Vault',
    publicQuickConnect: false,
  });

  // Public 2-digit discovery must NOT return private room
  assert.equal(engine.lookupByCode(room.code, 'scanner').length, 0);

  // One-time invite succeeds once, fails second time
  const oneTime = engine.createInvite({
    roomId: room.roomId,
    actorPeerId: 'host1',
    role: 'viewer',
    oneTime: true,
    expiresInMs: 60_000,
  });

  const first = engine.requestJoin({
    clientKey: 'g1',
    peerId: 'p1',
    identity: guest1.publicIdentity,
    inviteToken: oneTime.token,
  });
  assert.equal(first.status, 'joined');

  assert.throws(
    () =>
      engine.requestJoin({
        clientKey: 'g2',
        peerId: 'p2',
        identity: guest2.publicIdentity,
        inviteToken: oneTime.token,
      }),
    /already been used/i
  );

  // Revoked invite is rejected
  const revocable = engine.createInvite({
    roomId: room.roomId,
    actorPeerId: 'host1',
    role: 'collaborator',
  });
  engine.revokeInvite(room.roomId, 'host1', revocable.token);
  assert.throws(
    () =>
      engine.requestJoin({
        clientKey: 'g2',
        peerId: 'p2',
        identity: guest2.publicIdentity,
        inviteToken: revocable.token,
      }),
    /revoked/i
  );
});

test('Security: unauthorized peer rejected by host over live signaling server & command proposal never auto-executes', async () => {
  const server = http.createServer();
  const signaling = new TermLinkSignalingServer(server, { wsPath: '/ws' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `ws://127.0.0.1:${port}/ws`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termlink-sec-'));
  const host = new TermLink({ deviceName: 'HOST', signalingServer: url, storageDir: path.join(tmp, 'h') });
  const intruder = new TermLink({ deviceName: 'UNKNOWN-PC', signalingServer: url, storageDir: path.join(tmp, 'i') });
  const peer = new TermLink({ deviceName: 'TRUSTED-PEER', signalingServer: url, storageDir: path.join(tmp, 'p') });

  try {
    await host.initialize();
    const roomHost = await host.createRoom({ roomName: 'Secure Lab', requireHostApproval: true });

    roomHost.on('joinRequest', (req) => {
      if (req.identity.deviceName === 'UNKNOWN-PC') {
        roomHost.rejectJoin(req.requestId, 'Unrecognized fingerprint');
      } else {
        roomHost.approveJoin(req.requestId, 'collaborator');
      }
    });

    await intruder.initialize();
    await assert.rejects(
      () => intruder.joinRoom(roomHost.code),
      /Unrecognized fingerprint/i
    );

    // Command proposal check: flagged dangerous, never auto-executed
    await peer.initialize();
    const hostSawPeer = new Promise<void>((resolve) => {
      roomHost.once('peerJoined', () => resolve());
    });
    const roomPeer = await peer.joinRoom(roomHost.code);
    await hostSawPeer;

    const proposalReceived = new Promise<{ dangerous: boolean; command: string }>((resolve) => {
      roomPeer.once('commandProposal', (prop) => {
        prop.respond('rejected');
        resolve({ dangerous: prop.risk.dangerous, command: prop.command });
      });
    });

    roomHost.proposeCommand('TRUSTED-PEER', 'rm -rf /tmp/nonexistent-test');
    const prop = await proposalReceived;
    assert.equal(prop.dangerous, true);
    assert.equal(prop.command, 'rm -rf /tmp/nonexistent-test');
  } finally {
    await host.disconnect();
    await intruder.disconnect();
    await peer.disconnect();
    await signaling.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
