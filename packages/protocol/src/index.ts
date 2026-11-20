import type {
  ConnectionMode,
  PeerPublicIdentity,
  PeerRole,
  RoomMember,
  TerminalAccessMode,
} from '../../core/src/index';
import type { RoomPermissionPolicy } from '../../permissions/src/index';

export const MAX_SIGNALING_MESSAGE_BYTES = 256 * 1024; // 256 KiB hard ceiling per control frame
export const FILE_CHUNK_SIZE = 64 * 1024; // 64 KiB streaming chunk size

export function isValidTwoDigitCode(code: string): boolean {
  return typeof code === 'string' && /^[0-9]{2}$/.test(code);
}

export type ParsedJoinTarget =
  | { kind: 'code'; code: string; signalingBaseUrl?: string }
  | { kind: 'invite'; token: string; signalingBaseUrl?: string }
  | { kind: 'invalid'; reason: string };

/**
 * Parses a user-supplied join target:
 * - "47"
 * - "https://example.com/join/47"
 * - "http://localhost:3000/join/47"
 * - "https://example.com/invite/TOKEN"
 * - "termlink://join/47"
 * - "termlink://invite/TOKEN"
 */
export function parseJoinTarget(rawInput: string): ParsedJoinTarget {
  const input = rawInput.trim();
  if (!input) {
    return { kind: 'invalid', reason: 'Join target cannot be empty.' };
  }

  if (isValidTwoDigitCode(input)) {
    return { kind: 'code', code: input };
  }

  try {
    const normalized = input.startsWith('termlink://')
      ? input.replace(/^termlink:\/\//i, 'https://termlink.local/')
      : input;
    const url = new URL(normalized);
    const segments = url.pathname.split('/').filter(Boolean);
    const baseOrigin = input.startsWith('termlink://') ? undefined : url.origin;

    if (segments.length === 2 && segments[0] === 'join' && isValidTwoDigitCode(segments[1])) {
      return { kind: 'code', code: segments[1], signalingBaseUrl: baseOrigin };
    }

    if (segments.length === 2 && segments[0] === 'invite' && /^[A-Za-z0-9_-]{16,128}$/.test(segments[1])) {
      return { kind: 'invite', token: segments[1], signalingBaseUrl: baseOrigin };
    }

    return { kind: 'invalid', reason: 'Unrecognized join link format. Expected /join/NN or /invite/TOKEN.' };
  } catch {
    if (/^[A-Za-z0-9_-]{24,128}$/.test(input)) {
      return { kind: 'invite', token: input };
    }
    return {
      kind: 'invalid',
      reason: 'Expected a 2-digit room code (00-99), an invite token, or a join URL.',
    };
  }
}

export interface RoomCandidate {
  roomId: string;
  code: string;
  roomName: string;
  hostName: string;
  hostPlatform: string;
  hostFingerprintShort: string;
  memberCount: number;
  maxPeers: number;
  requiresPassword: boolean;
  requiresApproval: boolean;
  createdAt: number;
}

export interface InviteRecord {
  token: string;
  roomId: string;
  createdBy: string;
  role: PeerRole;
  oneTime: boolean;
  usedCount: number;
  maxUses: number | null;
  expiresAt: number;
  revoked: boolean;
  url: string;
}

export interface RoomInfo {
  roomId: string;
  code: string;
  roomName: string;
  ownerPeerId: string;
  publicQuickConnect: boolean;
  requireHostApproval: boolean;
  hasPassword: boolean;
  maxPeers: number;
  codeExpiresAt: number;
  createdAt: number;
  policy: RoomPermissionPolicy;
  joinUrl: string;
  members: RoomMember[];
}

export interface PendingJoinRequest {
  requestId: string;
  roomId: string;
  peerId: string;
  identity: PeerPublicIdentity;
  requestedAt: number;
  viaInviteToken: boolean;
}

export interface EncryptedEnvelope {
  senderPeerId: string;
  recipientPeerId: string | 'group';
  iv: string; // base64url 12-byte IV
  ciphertext: string; // base64url AES-256-GCM ciphertext
  authTag: string; // base64url 16-byte tag
  signature: string; // base64url Ed25519 signature over iv|ciphertext|authTag
  timestamp: number;
  e2ee: boolean;
}

// Application-level payloads sent over Direct P2P or E2EE Relay
export type PeerDataPayload =
  | {
      kind: 'chat:group';
      messageId: string;
      text: string;
      senderName: string;
      senderPeerId: string;
      timestamp: number;
    }
  | {
      kind: 'chat:private';
      messageId: string;
      toPeerId: string;
      text: string;
      senderName: string;
      senderPeerId: string;
      timestamp: number;
    }
  | {
      kind: 'chat:ack';
      messageId: string;
      receivedAt: number;
    }
  | {
      kind: 'file:offer';
      transferId: string;
      filename: string;
      size: number;
      sha256: string;
      chunkSize: number;
      totalChunks: number;
      target: 'group' | string;
      allowPeerAssist: boolean;
      senderName: string;
    }
  | {
      kind: 'file:response';
      transferId: string;
      accepted: boolean;
      resumeFromChunk?: number;
      reason?: string;
    }
  | {
      kind: 'file:chunk';
      transferId: string;
      chunkIndex: number;
      totalChunks: number;
      sha256: string;
      dataBase64: string;
    }
  | {
      kind: 'file:chunk_ack';
      transferId: string;
      chunkIndex: number;
      ok: boolean;
    }
  | {
      kind: 'file:control';
      transferId: string;
      action: 'pause' | 'resume' | 'cancel';
    }
  | {
      kind: 'file:complete';
      transferId: string;
      verified: boolean;
      sha256: string;
      error?: string;
    }
  | {
      kind: 'command:proposal';
      proposalId: string;
      command: string;
      description?: string;
      senderName: string;
      senderPeerId: string;
      timestamp: number;
    }
  | {
      kind: 'command:decision';
      proposalId: string;
      decision: 'accepted' | 'rejected' | 'edited';
      editedCommand?: string;
      responderName: string;
      timestamp: number;
    }
  | {
      kind: 'terminal:state';
      sessionId: string;
      sessionName: string;
      ownerPeerId: string;
      ownerName: string;
      active: boolean;
      locked: boolean;
      shell: string;
      permissions: Record<string, TerminalAccessMode>;
    }
  | {
      kind: 'terminal:output';
      sessionId: string;
      data: string;
      seq: number;
      timestamp: number;
    }
  | {
      kind: 'terminal:input';
      sessionId: string;
      data: string;
    };

// Future-ready Peer-Assisted Group File Distribution Protocol Module
export interface PeerAssistedManifest {
  transferId: string;
  originPeerId: string;
  fileSha256: string;
  totalChunks: number;
  chunkSize: number;
  redistributionAuthorized: boolean; // Must be explicitly enabled by original sender/host
  authorizedSeeders: string[];
  chunkAvailability: Record<string, number[]>; // peerId -> verified chunk indices
}

export function selectPeerAssistChunkSource(
  manifest: PeerAssistedManifest,
  chunkIndex: number,
  requesterPeerId: string
): string | null {
  if (!manifest.redistributionAuthorized) {
    return manifest.originPeerId;
  }
  // Prefer an authorized peer seeder that has the verified chunk (to offload origin host)
  for (const seederId of manifest.authorizedSeeders) {
    if (seederId === requesterPeerId || seederId === manifest.originPeerId) continue;
    const chunks = manifest.chunkAvailability[seederId];
    if (chunks && chunks.includes(chunkIndex)) {
      return seederId;
    }
  }
  return manifest.originPeerId;
}

// Client -> Signaling Server messages
export type ClientSignalingMessage =
  | { type: 'hello'; identity: PeerPublicIdentity; directEndpoint?: { host: string; port: number } }
  | {
      type: 'room:create';
      roomName: string;
      requireHostApproval?: boolean;
      publicQuickConnect?: boolean;
      password?: string;
      maxPeers?: number;
      preferredCode?: string;
      policy?: Partial<RoomPermissionPolicy>;
    }
  | { type: 'room:lookup'; code: string }
  | {
      type: 'room:join';
      code?: string;
      roomId?: string;
      inviteToken?: string;
      password?: string;
      reconnectToken?: string;
    }
  | { type: 'room:approve'; requestId: string; approved: boolean; role?: PeerRole; reason?: string }
  | { type: 'room:leave' }
  | { type: 'room:close' }
  | { type: 'room:rotate_code' }
  | {
      type: 'room:update_settings';
      publicQuickConnect?: boolean;
      requireHostApproval?: boolean;
      password?: string | null;
      policy?: Partial<RoomPermissionPolicy>;
    }
  | { type: 'room:create_invite'; role?: PeerRole; oneTime?: boolean; expiresInMs?: number }
  | { type: 'room:revoke_invite'; token: string }
  | { type: 'room:kick'; targetPeerId: string; reason?: string }
  | { type: 'room:set_role'; targetPeerId: string; role: PeerRole }
  | { type: 'room:transfer_ownership'; targetPeerId: string }
  | { type: 'room:set_terminal_access'; targetPeerId: string; access: TerminalAccessMode }
  | { type: 'room:report_connection'; targetPeerId: string; mode: ConnectionMode; latencyMs?: number }
  | {
      type: 'signal:webrtc';
      targetPeerId: string;
      signalType: 'offer' | 'answer' | 'ice-candidate' | 'direct-tcp-endpoint';
      payload: unknown;
    }
  | {
      type: 'relay:payload';
      targetPeerId: string | 'group';
      envelope: EncryptedEnvelope;
    }
  | { type: 'ping'; ts: number };

// Signaling Server -> Client messages
export type ServerSignalingMessage =
  | { type: 'welcome'; peerId: string; serverVersion: string; publicBaseUrl: string; stunServers: string[]; hasTurn: boolean }
  | { type: 'room:created'; room: RoomInfo; reconnectToken: string }
  | { type: 'room:candidates'; code: string; candidates: RoomCandidate[] }
  | { type: 'room:pending'; roomId: string; roomName: string; hostName: string; hostFingerprint: string }
  | { type: 'room:join_request'; request: PendingJoinRequest }
  | { type: 'room:joined'; room: RoomInfo; reconnectToken: string; directEndpoints: Record<string, { host: string; port: number }> }
  | { type: 'room:rejected'; reason: string }
  | { type: 'room:updated'; room: RoomInfo }
  | { type: 'room:peer_joined'; member: RoomMember; directEndpoint?: { host: string; port: number } }
  | { type: 'room:peer_left'; peerId: string; deviceName: string; reason: string }
  | { type: 'room:closed'; reason: string }
  | { type: 'room:invite_created'; invite: InviteRecord }
  | { type: 'room:invite_revoked'; token: string }
  | { type: 'signal:webrtc'; fromPeerId: string; signalType: 'offer' | 'answer' | 'ice-candidate' | 'direct-tcp-endpoint'; payload: unknown }
  | { type: 'relay:payload'; fromPeerId: string; envelope: EncryptedEnvelope }
  | { type: 'pong'; ts: number; serverTs: number }
  | { type: 'error'; code: string; message: string };

const ALLOWED_CLIENT_TYPES = new Set<string>([
  'hello',
  'room:create',
  'room:lookup',
  'room:join',
  'room:approve',
  'room:leave',
  'room:close',
  'room:rotate_code',
  'room:update_settings',
  'room:create_invite',
  'room:revoke_invite',
  'room:kick',
  'room:set_role',
  'room:transfer_ownership',
  'room:set_terminal_access',
  'room:report_connection',
  'signal:webrtc',
  'relay:payload',
  'ping',
]);

export function validateClientSignalingMessage(raw: string): { ok: true; message: ClientSignalingMessage } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Message must be a JSON string.' };
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_SIGNALING_MESSAGE_BYTES) {
    return { ok: false, error: `Message exceeds ${MAX_SIGNALING_MESSAGE_BYTES} byte limit.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Malformed JSON payload.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Payload must be a JSON object.' };
  }

  const msg = parsed as Record<string, unknown>;
  if (typeof msg.type !== 'string' || !ALLOWED_CLIENT_TYPES.has(msg.type)) {
    return { ok: false, error: `Unsupported message type: ${String(msg.type)}` };
  }

  if (msg.type === 'hello') {
    const id = msg.identity as Record<string, unknown> | undefined;
    if (
      !id ||
      typeof id.deviceId !== 'string' ||
      typeof id.deviceName !== 'string' ||
      typeof id.signingPublicKey !== 'string' ||
      typeof id.dhPublicKey !== 'string' ||
      typeof id.fingerprint !== 'string'
    ) {
      return { ok: false, error: 'Invalid peer identity in hello handshake.' };
    }
  }

  if (msg.type === 'room:lookup' && !isValidTwoDigitCode(String(msg.code ?? ''))) {
    return { ok: false, error: 'Room code must be exactly 2 digits (00-99).' };
  }

  if (msg.type === 'room:create') {
    if (typeof msg.roomName !== 'string' || msg.roomName.trim().length === 0 || msg.roomName.length > 64) {
      return { ok: false, error: 'roomName must be 1 to 64 characters.' };
    }
    if (msg.preferredCode !== undefined && !isValidTwoDigitCode(String(msg.preferredCode))) {
      return { ok: false, error: 'preferredCode must be 2 digits (00-99).' };
    }
  }

  if (msg.type === 'relay:payload') {
    const env = msg.envelope as Record<string, unknown> | undefined;
    if (!env || typeof env.iv !== 'string' || typeof env.ciphertext !== 'string' || typeof env.authTag !== 'string') {
      return { ok: false, error: 'Invalid encrypted relay envelope.' };
    }
  }

  return { ok: true, message: parsed as ClientSignalingMessage };
}
