import crypto from 'node:crypto';
import {
  TermLinkError,
  type ConnectionMode,
  type PeerPublicIdentity,
  type PeerRole,
  type RoomMember,
  type TerminalAccessMode,
} from '../../core/src/index';
import {
  DEFAULT_ROOM_POLICY,
  canModifyTargetRole,
  canPerformAction,
  canRemovePeer,
  type RoomPermissionPolicy,
} from '../../permissions/src/index';
import {
  isValidTwoDigitCode,
  type InviteRecord,
  type PendingJoinRequest,
  type RoomCandidate,
  type RoomInfo,
} from '../../protocol/src/index';

interface StoredRoom {
  roomId: string;
  code: string;
  roomName: string;
  ownerPeerId: string;
  publicQuickConnect: boolean;
  requireHostApproval: boolean;
  passwordHash: string | null;
  passwordSalt: string | null;
  maxPeers: number;
  codeExpiresAt: number;
  createdAt: number;
  policy: RoomPermissionPolicy;
  members: Map<string, RoomMember>;
  pendingRequests: Map<string, PendingJoinRequest>;
  invites: Map<string, InviteRecord>;
  reconnectTokens: Map<string, { deviceId: string; role: PeerRole; expiresAt: number }>;
}

interface RateBucket {
  timestamps: number[];
}

export interface RoomEngineOptions {
  publicBaseUrl?: string;
  codeTtlMs?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxAttempts?: number;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export class RoomEngine {
  private readonly rooms = new Map<string, StoredRoom>();
  private readonly codeIndex = new Map<string, Set<string>>();
  private readonly inviteIndex = new Map<string, string>(); // token -> roomId
  private readonly rateBuckets = new Map<string, RateBucket>();

  private publicBaseUrl: string;
  private readonly codeTtlMs: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateLimitMaxAttempts: number;

  constructor(options: RoomEngineOptions = {}) {
    this.publicBaseUrl = (options.publicBaseUrl || 'http://localhost:3000').replace(/\/$/, '');
    this.codeTtlMs = options.codeTtlMs ?? 30 * 60 * 1000;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;
    this.rateLimitMaxAttempts = options.rateLimitMaxAttempts ?? 12;
  }

  setPublicBaseUrl(url: string): void {
    this.publicBaseUrl = url.replace(/\/$/, '');
  }

  checkRateLimit(clientKey: string): void {
    const now = Date.now();
    const bucket = this.rateBuckets.get(clientKey) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < this.rateLimitWindowMs);
    if (bucket.timestamps.length >= this.rateLimitMaxAttempts) {
      throw new TermLinkError(
        'RATE_LIMITED',
        'Too many room discovery or join attempts. Wait briefly before retrying.'
      );
    }
    bucket.timestamps.push(now);
    this.rateBuckets.set(clientKey, bucket);
  }

  /**
   * Picks a cryptographically random 2-digit code (00-99), strongly preferring
   * unused codes while gracefully supporting collision resolution when busy.
   */
  private allocateTwoDigitCode(preferredCode?: string): string {
    if (preferredCode && isValidTwoDigitCode(preferredCode)) {
      return preferredCode;
    }

    const unused: string[] = [];
    for (let i = 0; i < 100; i++) {
      const code = i.toString().padStart(2, '0');
      const set = this.codeIndex.get(code);
      if (!set || set.size === 0) {
        unused.push(code);
      }
    }

    if (unused.length > 0) {
      const idx = crypto.randomInt(0, unused.length);
      return unused[idx];
    }

    // All 100 codes occupied: pick a random code — collision resolution handles disambiguation safely
    return crypto.randomInt(0, 100).toString().padStart(2, '0');
  }

  private indexCode(code: string, roomId: string): void {
    let set = this.codeIndex.get(code);
    if (!set) {
      set = new Set();
      this.codeIndex.set(code, set);
    }
    set.add(roomId);
  }

  private unindexCode(code: string, roomId: string): void {
    const set = this.codeIndex.get(code);
    if (!set) return;
    set.delete(roomId);
    if (set.size === 0) {
      this.codeIndex.delete(code);
    }
  }

  createRoom(params: {
    ownerPeerId: string;
    ownerIdentity: PeerPublicIdentity;
    roomName: string;
    requireHostApproval?: boolean;
    publicQuickConnect?: boolean;
    password?: string;
    maxPeers?: number;
    preferredCode?: string;
    policy?: Partial<RoomPermissionPolicy>;
  }): { room: RoomInfo; reconnectToken: string } {
    const roomId = `rm_${crypto.randomBytes(10).toString('hex')}`;
    const code = this.allocateTwoDigitCode(params.preferredCode);
    const now = Date.now();
    const maxPeers = Math.min(50, Math.max(2, params.maxPeers ?? 8));

    let passwordSalt: string | null = null;
    let passwordHash: string | null = null;
    if (params.password && params.password.length > 0) {
      passwordSalt = crypto.randomBytes(16).toString('hex');
      passwordHash = hashPassword(params.password, passwordSalt);
    }

    const ownerMember: RoomMember = {
      peerId: params.ownerPeerId,
      identity: params.ownerIdentity,
      role: 'owner',
      connectionMode: 'local_network',
      joinedAt: now,
      trusted: true,
      terminalAccess: 'interactive',
    };

    const reconnectToken = crypto.randomBytes(24).toString('base64url');
    const stored: StoredRoom = {
      roomId,
      code,
      roomName: params.roomName.trim().slice(0, 64) || `${params.ownerIdentity.deviceName} Room`,
      ownerPeerId: params.ownerPeerId,
      publicQuickConnect: params.publicQuickConnect ?? true,
      requireHostApproval: params.requireHostApproval ?? false,
      passwordHash,
      passwordSalt,
      maxPeers,
      codeExpiresAt: now + this.codeTtlMs,
      createdAt: now,
      policy: {
        ...DEFAULT_ROOM_POLICY,
        ...(params.policy || {}),
      },
      members: new Map([[params.ownerPeerId, ownerMember]]),
      pendingRequests: new Map(),
      invites: new Map(),
      reconnectTokens: new Map([
        [
          reconnectToken,
          {
            deviceId: params.ownerIdentity.deviceId,
            role: 'owner',
            expiresAt: now + 24 * 60 * 60 * 1000,
          },
        ],
      ]),
    };

    this.rooms.set(roomId, stored);
    this.indexCode(code, roomId);

    return { room: this.toRoomInfo(stored), reconnectToken };
  }

  /**
   * Looks up rooms by 2-digit code, returning limited metadata so users can
   * confirm host identity or disambiguate code collisions without exposing private rooms.
   */
  lookupByCode(code: string, clientKey: string): RoomCandidate[] {
    this.checkRateLimit(clientKey);
    if (!isValidTwoDigitCode(code)) {
      throw new TermLinkError('INVALID_CODE', 'Room code must be two digits between 00 and 99.');
    }

    const ids = this.codeIndex.get(code);
    if (!ids || ids.size === 0) return [];

    const now = Date.now();
    const candidates: RoomCandidate[] = [];
    for (const roomId of ids) {
      const room = this.rooms.get(roomId);
      if (!room) continue;
      if (!room.publicQuickConnect) continue;
      if (now > room.codeExpiresAt) continue;

      const owner = room.members.get(room.ownerPeerId);
      candidates.push({
        roomId: room.roomId,
        code: room.code,
        roomName: room.roomName,
        hostName: owner?.identity.deviceName ?? 'Unknown Host',
        hostPlatform: owner?.identity.platform ?? 'unknown',
        hostFingerprintShort: owner?.identity.fingerprint.slice(0, 17) ?? 'UNKNOWN',
        memberCount: room.members.size,
        maxPeers: room.maxPeers,
        requiresPassword: Boolean(room.passwordHash),
        requiresApproval: room.requireHostApproval,
        createdAt: room.createdAt,
      });
    }
    return candidates;
  }

  requestJoin(params: {
    clientKey: string;
    peerId: string;
    identity: PeerPublicIdentity;
    code?: string;
    roomId?: string;
    inviteToken?: string;
    password?: string;
    reconnectToken?: string;
  }):
    | { status: 'ambiguous'; candidates: RoomCandidate[] }
    | { status: 'pending'; request: PendingJoinRequest; room: RoomInfo }
    | { status: 'joined'; room: RoomInfo; member: RoomMember; reconnectToken: string } {
    this.checkRateLimit(params.clientKey);

    let room: StoredRoom | undefined;
    let invite: InviteRecord | undefined;

    if (params.inviteToken) {
      const roomId = this.inviteIndex.get(params.inviteToken);
      if (!roomId) {
        throw new TermLinkError('INVALID_INVITE', 'Invitation link is invalid or does not exist.');
      }
      room = this.rooms.get(roomId);
      invite = room?.invites.get(params.inviteToken);
      if (!room || !invite) {
        throw new TermLinkError('INVALID_INVITE', 'Invitation link is no longer valid.');
      }
      if (invite.revoked) {
        throw new TermLinkError('INVITE_REVOKED', 'This invitation link has been revoked by the host.');
      }
      if (Date.now() > invite.expiresAt) {
        throw new TermLinkError('INVITE_EXPIRED', 'This invitation link has expired.');
      }
      if (invite.oneTime && invite.usedCount >= 1) {
        throw new TermLinkError('INVITE_USED', 'This one-time invitation link has already been used.');
      }
      if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
        throw new TermLinkError('INVITE_LIMIT', 'This invitation link has reached its usage limit.');
      }
    } else if (params.roomId) {
      room = this.rooms.get(params.roomId);
      if (!room) {
        throw new TermLinkError('ROOM_NOT_FOUND', 'Room no longer exists.');
      }
      if (!room.publicQuickConnect && !params.reconnectToken) {
        throw new TermLinkError('QUICK_CONNECT_DISABLED', 'Host disabled public quick-connect. Use an invitation link.');
      }
    } else if (params.code) {
      const candidates = this.lookupByCode(params.code, `${params.clientKey}:lookup`);
      if (candidates.length === 0) {
        throw new TermLinkError('ROOM_NOT_FOUND', `No active public room found for code ${params.code}.`);
      }
      if (candidates.length > 1) {
        return { status: 'ambiguous', candidates };
      }
      room = this.rooms.get(candidates[0].roomId);
    }

    if (!room) {
      throw new TermLinkError('ROOM_NOT_FOUND', 'Room not found.');
    }

    if (room.members.size >= room.maxPeers) {
      throw new TermLinkError('ROOM_FULL', `Room has reached its peer limit (${room.maxPeers}).`);
    }

    // Reconnection path for previously authenticated member
    if (params.reconnectToken) {
      const rec = room.reconnectTokens.get(params.reconnectToken);
      if (rec && rec.deviceId === params.identity.deviceId && Date.now() <= rec.expiresAt) {
        const member: RoomMember = {
          peerId: params.peerId,
          identity: params.identity,
          role: rec.role,
          connectionMode: 'connecting',
          joinedAt: Date.now(),
          trusted: true,
          terminalAccess: rec.role === 'owner' ? 'interactive' : 'disabled',
        };
        room.members.set(params.peerId, member);
        if (rec.role === 'owner') {
          room.ownerPeerId = params.peerId;
        }
        return { status: 'joined', room: this.toRoomInfo(room), member, reconnectToken: params.reconnectToken };
      }
    }

    // Password check (unless valid invite bypasses public code password)
    if (room.passwordHash && room.passwordSalt && !invite) {
      if (!params.password || !verifyPassword(params.password, room.passwordSalt, room.passwordHash)) {
        throw new TermLinkError('INVALID_PASSWORD', 'Room password is required or incorrect.');
      }
    }

    // Consume invite usage if present
    if (invite) {
      invite.usedCount += 1;
    }

    const assignedRole: PeerRole = invite?.role ?? 'collaborator';

    if (room.requireHostApproval && !invite) {
      const requestId = `req_${crypto.randomBytes(8).toString('hex')}`;
      const request: PendingJoinRequest = {
        requestId,
        roomId: room.roomId,
        peerId: params.peerId,
        identity: params.identity,
        requestedAt: Date.now(),
        viaInviteToken: false,
      };
      room.pendingRequests.set(requestId, request);
      return { status: 'pending', request, room: this.toRoomInfo(room) };
    }

    const member: RoomMember = {
      peerId: params.peerId,
      identity: params.identity,
      role: assignedRole,
      connectionMode: 'connecting',
      joinedAt: Date.now(),
      trusted: Boolean(invite),
      terminalAccess: 'disabled',
    };
    room.members.set(params.peerId, member);

    const reconnectToken = crypto.randomBytes(24).toString('base64url');
    room.reconnectTokens.set(reconnectToken, {
      deviceId: params.identity.deviceId,
      role: assignedRole,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    return { status: 'joined', room: this.toRoomInfo(room), member, reconnectToken };
  }

  resolveJoinRequest(params: {
    roomId: string;
    actorPeerId: string;
    requestId: string;
    approved: boolean;
    role?: PeerRole;
  }): {
    approved: boolean;
    request: PendingJoinRequest;
    room: RoomInfo;
    member?: RoomMember;
    reconnectToken?: string;
  } {
    const room = this.requireRoom(params.roomId);
    const actor = this.requireMember(room, params.actorPeerId);
    if (!canPerformAction(actor.role, 'peer:approve', room.policy)) {
      throw new TermLinkError('FORBIDDEN', 'Only the room owner or admins can approve join requests.');
    }

    const request = room.pendingRequests.get(params.requestId);
    if (!request) {
      throw new TermLinkError('REQUEST_NOT_FOUND', 'Join request not found or already resolved.');
    }
    room.pendingRequests.delete(params.requestId);

    if (!params.approved) {
      return { approved: false, request, room: this.toRoomInfo(room) };
    }

    if (room.members.size >= room.maxPeers) {
      throw new TermLinkError('ROOM_FULL', `Room has reached its peer limit (${room.maxPeers}).`);
    }

    const role: PeerRole = params.role && params.role !== 'owner' ? params.role : 'collaborator';
    const member: RoomMember = {
      peerId: request.peerId,
      identity: request.identity,
      role,
      connectionMode: 'connecting',
      joinedAt: Date.now(),
      trusted: true,
      terminalAccess: 'disabled',
    };
    room.members.set(request.peerId, member);

    const reconnectToken = crypto.randomBytes(24).toString('base64url');
    room.reconnectTokens.set(reconnectToken, {
      deviceId: request.identity.deviceId,
      role,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    return {
      approved: true,
      request,
      room: this.toRoomInfo(room),
      member,
      reconnectToken,
    };
  }

  createInvite(params: {
    roomId: string;
    actorPeerId: string;
    role?: PeerRole;
    oneTime?: boolean;
    expiresInMs?: number;
  }): InviteRecord {
    const room = this.requireRoom(params.roomId);
    const actor = this.requireMember(room, params.actorPeerId);
    if (!canPerformAction(actor.role, 'peer:invite', room.policy)) {
      throw new TermLinkError('FORBIDDEN', 'You do not have permission to generate invitations.');
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const role: PeerRole = params.role && params.role !== 'owner' ? params.role : 'collaborator';
    const ttl = Math.min(7 * 24 * 60 * 60 * 1000, Math.max(60_000, params.expiresInMs ?? 60 * 60 * 1000));

    const invite: InviteRecord = {
      token,
      roomId: room.roomId,
      createdBy: actor.peerId,
      role,
      oneTime: Boolean(params.oneTime),
      usedCount: 0,
      maxUses: params.oneTime ? 1 : null,
      expiresAt: Date.now() + ttl,
      revoked: false,
      url: `${this.publicBaseUrl}/invite/${token}`,
    };

    room.invites.set(token, invite);
    this.inviteIndex.set(token, room.roomId);
    return invite;
  }

  revokeInvite(roomId: string, actorPeerId: string, token: string): void {
    const room = this.requireRoom(roomId);
    const actor = this.requireMember(room, actorPeerId);
    if (!canPerformAction(actor.role, 'peer:invite', room.policy)) {
      throw new TermLinkError('FORBIDDEN', 'You do not have permission to revoke invitations.');
    }
    const invite = room.invites.get(token);
    if (!invite) {
      throw new TermLinkError('INVITE_NOT_FOUND', 'Invitation token not found.');
    }
    invite.revoked = true;
  }

  rotateCode(roomId: string, actorPeerId: string): RoomInfo {
    const room = this.requireRoom(roomId);
    const actor = this.requireMember(room, actorPeerId);
    if (!canPerformAction(actor.role, 'room:rotate_code', room.policy)) {
      throw new TermLinkError('FORBIDDEN', 'Only the room owner can rotate the room code.');
    }

    this.unindexCode(room.code, room.roomId);
    room.code = this.allocateTwoDigitCode();
    room.codeExpiresAt = Date.now() + this.codeTtlMs;
    this.indexCode(room.code, room.roomId);
    return this.toRoomInfo(room);
  }

  updateSettings(params: {
    roomId: string;
    actorPeerId: string;
    publicQuickConnect?: boolean;
    requireHostApproval?: boolean;
    password?: string | null;
    policy?: Partial<RoomPermissionPolicy>;
  }): RoomInfo {
    const room = this.requireRoom(params.roomId);
    const actor = this.requireMember(room, params.actorPeerId);
    if (!canPerformAction(actor.role, 'room:settings', room.policy)) {
      throw new TermLinkError('FORBIDDEN', 'Only the room owner can update room settings.');
    }

    if (params.publicQuickConnect !== undefined) {
      room.publicQuickConnect = Boolean(params.publicQuickConnect);
    }
    if (params.requireHostApproval !== undefined) {
      room.requireHostApproval = Boolean(params.requireHostApproval);
    }
    if (params.password === null || params.password === '') {
      room.passwordHash = null;
      room.passwordSalt = null;
    } else if (typeof params.password === 'string') {
      room.passwordSalt = crypto.randomBytes(16).toString('hex');
      room.passwordHash = hashPassword(params.password, room.passwordSalt);
    }
    if (params.policy) {
      room.policy = { ...room.policy, ...params.policy };
    }
    return this.toRoomInfo(room);
  }

  setMemberRole(roomId: string, actorPeerId: string, targetPeerId: string, newRole: PeerRole): RoomInfo {
    const room = this.requireRoom(roomId);
    const actor = this.requireMember(room, actorPeerId);
    const target = this.requireMember(room, targetPeerId);

    if (!canModifyTargetRole(actor.role, target.role, newRole)) {
      throw new TermLinkError('FORBIDDEN', 'You do not have permission to assign this role.');
    }

    target.role = newRole;
    if (newRole === 'guest' || newRole === 'viewer') {
      target.terminalAccess = newRole === 'guest' ? 'disabled' : target.terminalAccess === 'interactive' ? 'read-only' : target.terminalAccess;
    }
    return this.toRoomInfo(room);
  }

  setTerminalAccess(roomId: string, actorPeerId: string, targetPeerId: string, access: TerminalAccessMode): RoomInfo {
    const room = this.requireRoom(roomId);
    const actor = this.requireMember(room, actorPeerId);
    const target = this.requireMember(room, targetPeerId);

    if (!canPerformAction(actor.role, 'terminal:grant_access', room.policy)) {
      throw new TermLinkError('FORBIDDEN', 'Only the room owner can grant or revoke terminal access.');
    }
    if (target.role === 'guest' && access === 'interactive') {
      throw new TermLinkError('FORBIDDEN', 'Guests cannot be granted interactive terminal execution privileges.');
    }
    if (target.role === 'viewer' && access === 'interactive') {
      throw new TermLinkError('FORBIDDEN', 'Viewers cannot be granted interactive terminal execution privileges.');
    }
    target.terminalAccess = access;
    return this.toRoomInfo(room);
  }

  transferOwnership(roomId: string, actorPeerId: string, targetPeerId: string): RoomInfo {
    const room = this.requireRoom(roomId);
    const actor = this.requireMember(room, actorPeerId);
    const target = this.requireMember(room, targetPeerId);
    if (!canPerformAction(actor.role, 'room:transfer_ownership', room.policy)) {
      throw new TermLinkError('FORBIDDEN', 'Only the current owner can transfer ownership.');
    }
    actor.role = 'admin';
    target.role = 'owner';
    room.ownerPeerId = target.peerId;
    return this.toRoomInfo(room);
  }

  kickPeer(roomId: string, actorPeerId: string, targetPeerId: string): { room: RoomInfo; kicked: RoomMember } {
    const room = this.requireRoom(roomId);
    const actor = this.requireMember(room, actorPeerId);
    const target = this.requireMember(room, targetPeerId);

    if (!canRemovePeer(actor.role, target.role)) {
      throw new TermLinkError('FORBIDDEN', 'Insufficient permission to remove this peer.');
    }

    room.members.delete(targetPeerId);
    // Revoke any reconnect token for kicked device
    for (const [token, rec] of room.reconnectTokens.entries()) {
      if (rec.deviceId === target.identity.deviceId) {
        room.reconnectTokens.delete(token);
      }
    }
    return { room: this.toRoomInfo(room), kicked: target };
  }

  updateConnectionMode(roomId: string, peerId: string, mode: ConnectionMode, latencyMs?: number): RoomInfo | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const member = room.members.get(peerId);
    if (!member) return null;
    member.connectionMode = mode;
    if (latencyMs !== undefined) member.latencyMs = latencyMs;
    return this.toRoomInfo(room);
  }

  removeMemberOnDisconnect(roomId: string, peerId: string): {
    roomClosed: boolean;
    leftMember?: RoomMember;
    room?: RoomInfo;
    newOwnerPeerId?: string;
  } {
    const room = this.rooms.get(roomId);
    if (!room) return { roomClosed: true };

    const leftMember = room.members.get(peerId);
    if (!leftMember) {
      // Also clean any pending join requests by this peer
      for (const [reqId, req] of room.pendingRequests.entries()) {
        if (req.peerId === peerId) room.pendingRequests.delete(reqId);
      }
      return { roomClosed: false, room: this.toRoomInfo(room) };
    }

    room.members.delete(peerId);
    if (room.members.size === 0) {
      this.destroyRoom(room);
      return { roomClosed: true, leftMember };
    }

    let newOwnerPeerId: string | undefined;
    if (room.ownerPeerId === peerId) {
      // Promote highest-ranked remaining peer (admin -> collaborator -> first member)
      const remaining = Array.from(room.members.values()).sort((a, b) => a.joinedAt - b.joinedAt);
      const promoted = remaining.find((m) => m.role === 'admin') ?? remaining[0];
      promoted.role = 'owner';
      room.ownerPeerId = promoted.peerId;
      newOwnerPeerId = promoted.peerId;
    }

    return { roomClosed: false, leftMember, room: this.toRoomInfo(room), newOwnerPeerId };
  }

  closeRoom(roomId: string, actorPeerId: string): void {
    const room = this.requireRoom(roomId);
    const actor = this.requireMember(room, actorPeerId);
    if (!canPerformAction(actor.role, 'room:close', room.policy)) {
      throw new TermLinkError('FORBIDDEN', 'Only the room owner can close the room.');
    }
    this.destroyRoom(room);
  }

  private destroyRoom(room: StoredRoom): void {
    this.unindexCode(room.code, room.roomId);
    for (const token of room.invites.keys()) {
      this.inviteIndex.delete(token);
    }
    this.rooms.delete(room.roomId);
  }

  getRoom(roomId: string): RoomInfo | null {
    const room = this.rooms.get(roomId);
    return room ? this.toRoomInfo(room) : null;
  }

  getMemberIds(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    return room ? Array.from(room.members.keys()) : [];
  }

  getStats(): { activeRooms: number; connectedPeers: number; activeInvites: number } {
    let connectedPeers = 0;
    let activeInvites = 0;
    const now = Date.now();
    for (const r of this.rooms.values()) {
      connectedPeers += r.members.size;
      for (const inv of r.invites.values()) {
        if (!inv.revoked && inv.expiresAt > now) activeInvites++;
      }
    }
    return {
      activeRooms: this.rooms.size,
      connectedPeers,
      activeInvites,
    };
  }

  private requireRoom(roomId: string): StoredRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new TermLinkError('ROOM_NOT_FOUND', 'Room does not exist.');
    return room;
  }

  private requireMember(room: StoredRoom, peerId: string): RoomMember {
    const member = room.members.get(peerId);
    if (!member) throw new TermLinkError('NOT_A_MEMBER', 'Peer is not a member of this room.');
    return member;
  }

  private toRoomInfo(room: StoredRoom): RoomInfo {
    return {
      roomId: room.roomId,
      code: room.code,
      roomName: room.roomName,
      ownerPeerId: room.ownerPeerId,
      publicQuickConnect: room.publicQuickConnect,
      requireHostApproval: room.requireHostApproval,
      hasPassword: Boolean(room.passwordHash),
      maxPeers: room.maxPeers,
      codeExpiresAt: room.codeExpiresAt,
      createdAt: room.createdAt,
      policy: { ...room.policy },
      joinUrl: `${this.publicBaseUrl}/join/${room.code}`,
      members: Array.from(room.members.values()).map((m) => ({ ...m })),
    };
  }
}
