import crypto from 'node:crypto';
import type http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  Logger,
  TERMLINK_VERSION,
  TermLinkError,
  type PeerPublicIdentity,
} from '../../../packages/core/src/index';
import {
  validateClientSignalingMessage,
  type ClientSignalingMessage,
  type ServerSignalingMessage,
} from '../../../packages/protocol/src/index';
import { RoomEngine } from '../../../packages/room-engine/src/index';

interface ConnectedPeer {
  peerId: string;
  ws: WebSocket;
  remoteAddress: string;
  identity: PeerPublicIdentity | null;
  directEndpoint?: { host: string; port: number };
  roomId: string | null;
  pendingRoomId: string | null;
}

export interface SignalingServerOptions {
  publicBaseUrl?: string;
  stunServers?: string[];
  hasTurn?: boolean;
  codeTtlMs?: number;
  rateLimitMaxAttempts?: number;
  wsPath?: string;
}

export class TermLinkSignalingServer {
  public readonly engine: RoomEngine;
  private readonly wss: WebSocketServer;
  private readonly peers = new Map<string, ConnectedPeer>();
  private readonly logger = new Logger('signaling-server', 'warn');
  private readonly publicBaseUrl: string;
  private readonly stunServers: string[];
  private readonly hasTurn: boolean;

  constructor(httpServer: http.Server, options: SignalingServerOptions = {}) {
    this.publicBaseUrl = (options.publicBaseUrl || 'http://localhost:3000').replace(/\/$/, '');
    this.stunServers = options.stunServers ?? [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
    ];
    this.hasTurn = Boolean(options.hasTurn);

    this.engine = new RoomEngine({
      publicBaseUrl: this.publicBaseUrl,
      codeTtlMs: options.codeTtlMs,
      rateLimitMaxAttempts: options.rateLimitMaxAttempts,
    });

    this.wss = new WebSocketServer({
      server: httpServer,
      path: options.wsPath ?? '/ws',
      maxPayload: 512 * 1024,
    });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const peerId = `peer_${crypto.randomBytes(8).toString('hex')}`;
    const remoteAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      peerId;

    const peer: ConnectedPeer = {
      peerId,
      ws,
      remoteAddress,
      identity: null,
      roomId: null,
      pendingRoomId: null,
    };
    this.peers.set(peerId, peer);

    this.send(peer, {
      type: 'welcome',
      peerId,
      serverVersion: TERMLINK_VERSION,
      publicBaseUrl: this.publicBaseUrl,
      stunServers: this.stunServers,
      hasTurn: this.hasTurn,
    });

    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      const validated = validateClientSignalingMessage(raw);
      if (!validated.ok) {
        this.send(peer, { type: 'error', code: 'INVALID_MESSAGE', message: validated.error });
        return;
      }
      this.handleMessage(peer, validated.message);
    });

    ws.on('close', () => {
      this.handleDisconnect(peer, 'Disconnected');
    });

    ws.on('error', (err) => {
      this.logger.warn('Peer socket error', { peerId, error: err.message });
    });
  }

  private handleMessage(peer: ConnectedPeer, msg: ClientSignalingMessage): void {
    try {
      if (msg.type === 'ping') {
        this.send(peer, { type: 'pong', ts: msg.ts, serverTs: Date.now() });
        return;
      }

      if (msg.type === 'hello') {
        peer.identity = msg.identity;
        peer.directEndpoint = msg.directEndpoint;
        return;
      }

      if (!peer.identity) {
        this.send(peer, {
          type: 'error',
          code: 'HANDSHAKE_REQUIRED',
          message: 'Send a hello message with your cryptographic public identity first.',
        });
        return;
      }

      const clientKey = `${peer.remoteAddress}:${peer.identity.deviceId}`;

      switch (msg.type) {
        case 'room:create': {
          if (peer.roomId) {
            this.leaveCurrentRoom(peer, 'Switched room');
          }
          const { room, reconnectToken } = this.engine.createRoom({
            ownerPeerId: peer.peerId,
            ownerIdentity: peer.identity,
            roomName: msg.roomName,
            requireHostApproval: msg.requireHostApproval,
            publicQuickConnect: msg.publicQuickConnect,
            password: msg.password,
            maxPeers: msg.maxPeers,
            preferredCode: msg.preferredCode,
            policy: msg.policy,
          });
          peer.roomId = room.roomId;
          this.send(peer, { type: 'room:created', room, reconnectToken });
          break;
        }

        case 'room:lookup': {
          const candidates = this.engine.lookupByCode(msg.code, clientKey);
          this.send(peer, { type: 'room:candidates', code: msg.code, candidates });
          break;
        }

        case 'room:join': {
          if (peer.roomId) {
            this.leaveCurrentRoom(peer, 'Joining another room');
          }
          const result = this.engine.requestJoin({
            clientKey,
            peerId: peer.peerId,
            identity: peer.identity,
            code: msg.code,
            roomId: msg.roomId,
            inviteToken: msg.inviteToken,
            password: msg.password,
            reconnectToken: msg.reconnectToken,
          });

          if (result.status === 'ambiguous') {
            this.send(peer, {
              type: 'room:candidates',
              code: msg.code || '',
              candidates: result.candidates,
            });
            return;
          }

          if (result.status === 'pending') {
            peer.pendingRoomId = result.room.roomId;
            const owner = result.room.members.find((m) => m.peerId === result.room.ownerPeerId);
            this.send(peer, {
              type: 'room:pending',
              roomId: result.room.roomId,
              roomName: result.room.roomName,
              hostName: owner?.identity.deviceName ?? 'Host',
              hostFingerprint: owner?.identity.fingerprint ?? '',
            });

            // Notify owner & admins so they can approve or reject
            for (const member of result.room.members) {
              if (member.role === 'owner' || member.role === 'admin') {
                const approver = this.peers.get(member.peerId);
                if (approver) {
                  this.send(approver, { type: 'room:join_request', request: result.request });
                }
              }
            }
            return;
          }

          // Joined immediately (invite / reconnect / approval disabled)
          peer.roomId = result.room.roomId;
          peer.pendingRoomId = null;
          this.send(peer, {
            type: 'room:joined',
            room: result.room,
            reconnectToken: result.reconnectToken,
            directEndpoints: this.collectDirectEndpoints(result.room.roomId, peer.peerId),
          });
          this.broadcastRoom(
            result.room.roomId,
            {
              type: 'room:peer_joined',
              member: result.member,
              directEndpoint: peer.directEndpoint,
            },
            peer.peerId
          );
          this.broadcastRoom(result.room.roomId, { type: 'room:updated', room: result.room }, peer.peerId);
          break;
        }

        case 'room:approve': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'You are not in an active room.');
          const res = this.engine.resolveJoinRequest({
            roomId: peer.roomId,
            actorPeerId: peer.peerId,
            requestId: msg.requestId,
            approved: msg.approved,
            role: msg.role,
          });
          const target = this.peers.get(res.request.peerId);
          if (!res.approved) {
            if (target) {
              target.pendingRoomId = null;
              this.send(target, {
                type: 'room:rejected',
                reason: msg.reason || 'Host rejected your join request.',
              });
            }
            return;
          }
          if (target && res.member && res.reconnectToken) {
            target.roomId = res.room.roomId;
            target.pendingRoomId = null;
            this.send(target, {
              type: 'room:joined',
              room: res.room,
              reconnectToken: res.reconnectToken,
              directEndpoints: this.collectDirectEndpoints(res.room.roomId, target.peerId),
            });
            this.broadcastRoom(
              res.room.roomId,
              {
                type: 'room:peer_joined',
                member: res.member,
                directEndpoint: target.directEndpoint,
              },
              target.peerId
            );
            this.broadcastRoom(res.room.roomId, { type: 'room:updated', room: res.room });
          }
          break;
        }

        case 'room:leave': {
          this.leaveCurrentRoom(peer, 'Left room');
          break;
        }

        case 'room:close': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          const roomId = peer.roomId;
          const memberIds = this.engine.getMemberIds(roomId);
          this.engine.closeRoom(roomId, peer.peerId);
          for (const pid of memberIds) {
            const p = this.peers.get(pid);
            if (p) {
              p.roomId = null;
              this.send(p, { type: 'room:closed', reason: 'Room closed by owner.' });
            }
          }
          break;
        }

        case 'room:rotate_code': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          const room = this.engine.rotateCode(peer.roomId, peer.peerId);
          this.broadcastRoom(peer.roomId, { type: 'room:updated', room });
          break;
        }

        case 'room:update_settings': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          const room = this.engine.updateSettings({
            roomId: peer.roomId,
            actorPeerId: peer.peerId,
            publicQuickConnect: msg.publicQuickConnect,
            requireHostApproval: msg.requireHostApproval,
            password: msg.password,
            policy: msg.policy,
          });
          this.broadcastRoom(peer.roomId, { type: 'room:updated', room });
          break;
        }

        case 'room:create_invite': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          const invite = this.engine.createInvite({
            roomId: peer.roomId,
            actorPeerId: peer.peerId,
            role: msg.role,
            oneTime: msg.oneTime,
            expiresInMs: msg.expiresInMs,
          });
          this.send(peer, { type: 'room:invite_created', invite });
          break;
        }

        case 'room:revoke_invite': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          this.engine.revokeInvite(peer.roomId, peer.peerId, msg.token);
          this.send(peer, { type: 'room:invite_revoked', token: msg.token });
          break;
        }

        case 'room:kick': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          const { room, kicked } = this.engine.kickPeer(peer.roomId, peer.peerId, msg.targetPeerId);
          const kickedSocket = this.peers.get(msg.targetPeerId);
          if (kickedSocket) {
            kickedSocket.roomId = null;
            this.send(kickedSocket, {
              type: 'room:closed',
              reason: msg.reason || 'You were removed from the room by a host or admin.',
            });
          }
          this.broadcastRoom(peer.roomId, {
            type: 'room:peer_left',
            peerId: kicked.peerId,
            deviceName: kicked.identity.deviceName,
            reason: 'Removed by host',
          });
          this.broadcastRoom(peer.roomId, { type: 'room:updated', room });
          break;
        }

        case 'room:set_role': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          const room = this.engine.setMemberRole(peer.roomId, peer.peerId, msg.targetPeerId, msg.role);
          this.broadcastRoom(peer.roomId, { type: 'room:updated', room });
          break;
        }

        case 'room:transfer_ownership': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          const room = this.engine.transferOwnership(peer.roomId, peer.peerId, msg.targetPeerId);
          this.broadcastRoom(peer.roomId, { type: 'room:updated', room });
          break;
        }

        case 'room:set_terminal_access': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          const room = this.engine.setTerminalAccess(peer.roomId, peer.peerId, msg.targetPeerId, msg.access);
          this.broadcastRoom(peer.roomId, { type: 'room:updated', room });
          break;
        }

        case 'room:report_connection': {
          if (!peer.roomId) return;
          const room = this.engine.updateConnectionMode(peer.roomId, peer.peerId, msg.mode, msg.latencyMs);
          if (room) {
            this.broadcastRoom(peer.roomId, { type: 'room:updated', room });
          }
          break;
        }

        case 'signal:webrtc': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          const target = this.peers.get(msg.targetPeerId);
          if (!target || target.roomId !== peer.roomId) return;
          this.send(target, {
            type: 'signal:webrtc',
            fromPeerId: peer.peerId,
            signalType: msg.signalType,
            payload: msg.payload,
          });
          break;
        }

        case 'relay:payload': {
          if (!peer.roomId) throw new TermLinkError('NOT_IN_ROOM', 'Not in a room.');
          // Signaling server NEVER inspects or decrypts E2EE payloads; strictly forwards opaque ciphertext
          if (msg.targetPeerId === 'group') {
            this.broadcastRoom(
              peer.roomId,
              { type: 'relay:payload', fromPeerId: peer.peerId, envelope: msg.envelope },
              peer.peerId
            );
          } else {
            const target = this.peers.get(msg.targetPeerId);
            if (target && target.roomId === peer.roomId) {
              this.send(target, {
                type: 'relay:payload',
                fromPeerId: peer.peerId,
                envelope: msg.envelope,
              });
            }
          }
          break;
        }
      }
    } catch (err) {
      if (err instanceof TermLinkError) {
        this.send(peer, { type: 'error', code: err.code, message: err.message });
      } else {
        this.send(peer, { type: 'error', code: 'INTERNAL_ERROR', message: (err as Error).message });
      }
    }
  }

  private collectDirectEndpoints(roomId: string, excludePeerId: string): Record<string, { host: string; port: number }> {
    const out: Record<string, { host: string; port: number }> = {};
    for (const pid of this.engine.getMemberIds(roomId)) {
      if (pid === excludePeerId) continue;
      const p = this.peers.get(pid);
      if (p?.directEndpoint) {
        out[pid] = p.directEndpoint;
      }
    }
    return out;
  }

  private leaveCurrentRoom(peer: ConnectedPeer, reason: string): void {
    const roomId = peer.roomId || peer.pendingRoomId;
    peer.roomId = null;
    peer.pendingRoomId = null;
    if (!roomId) return;

    const res = this.engine.removeMemberOnDisconnect(roomId, peer.peerId);
    if (!res.roomClosed && res.leftMember && res.room) {
      this.broadcastRoom(roomId, {
        type: 'room:peer_left',
        peerId: res.leftMember.peerId,
        deviceName: res.leftMember.identity.deviceName,
        reason,
      });
      this.broadcastRoom(roomId, { type: 'room:updated', room: res.room });
    }
  }

  private handleDisconnect(peer: ConnectedPeer, reason: string): void {
    this.leaveCurrentRoom(peer, reason);
    this.peers.delete(peer.peerId);
  }

  private send(peer: ConnectedPeer, message: ServerSignalingMessage): void {
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(JSON.stringify(message));
    }
  }

  private broadcastRoom(roomId: string, message: ServerSignalingMessage, excludePeerId?: string): void {
    for (const pid of this.engine.getMemberIds(roomId)) {
      if (pid === excludePeerId) continue;
      const peer = this.peers.get(pid);
      if (peer) this.send(peer, message);
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const peer of this.peers.values()) {
        peer.ws.terminate();
      }
      this.peers.clear();
      this.wss.close(() => resolve());
    });
  }
}
