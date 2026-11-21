import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import WebSocket from 'ws';
import {
  DEFAULT_CONFIG,
  TermLinkError,
  assessCommandRisk,
  validateConfig,
  type CommandRiskAssessment,
  type ConnectionMode,
  type PeerPublicIdentity,
  type PeerRole,
  type RoomMember,
  type TermLinkConfig,
  type TerminalAccessMode,
} from '../../core/src/index';
import {
  StreamingFileReceiver,
  StreamingFileSender,
  prepareFileOffer,
  type TransferProgress,
} from '../../file-transfer/src/index';
import { IdentityStore, type LocalIdentity } from '../../identity/src/index';
import { DirectP2PTransport, TopologyManager } from '../../networking/src/index';
import {
  parseJoinTarget,
  type ClientSignalingMessage,
  type InviteRecord,
  type PeerDataPayload,
  type PendingJoinRequest,
  type RoomCandidate,
  type RoomInfo,
  type ServerSignalingMessage,
} from '../../protocol/src/index';
import { SharedTerminalSession } from '../../terminal-session/src/index';

export interface IncomingFileOffer {
  transferId: string;
  fromPeerId: string;
  senderName: string;
  filename: string;
  size: number;
  sha256: string;
  totalChunks: number;
  accept: (downloadDir?: string) => void;
  reject: (reason?: string) => void;
}

export interface IncomingCommandProposal {
  proposalId: string;
  fromPeerId: string;
  senderName: string;
  command: string;
  description?: string;
  risk: CommandRiskAssessment;
  timestamp: number;
  respond: (decision: 'accepted' | 'rejected' | 'edited', editedCommand?: string) => void;
}

export class RoomSession extends EventEmitter {
  public roomInfo: RoomInfo;
  public reconnectToken: string;
  public readonly localPeerId: string;
  public readonly topology: TopologyManager;

  private readonly sendSignal: (msg: ClientSignalingMessage) => void;
  private readonly transport: DirectP2PTransport;
  private readonly localIdentity: LocalIdentity;
  private readonly config: TermLinkConfig;

  private readonly activeSenders = new Map<
    string,
    {
      sender: StreamingFileSender;
      filePath: string;
      metadata: Awaited<ReturnType<typeof prepareFileOffer>>;
      targetPeerIds: string[];
      ackWaiters: Map<string, () => void>;
    }
  >();
  private readonly activeReceivers = new Map<string, StreamingFileReceiver>();
  private sharedTerminal: SharedTerminalSession | null = null;
  private remoteTerminalState: {
    sessionId: string;
    sessionName: string;
    ownerPeerId: string;
    ownerName: string;
    active: boolean;
    locked: boolean;
    shell: string;
    permissions: Record<string, TerminalAccessMode>;
  } | null = null;

  constructor(params: {
    roomInfo: RoomInfo;
    reconnectToken: string;
    localPeerId: string;
    sendSignal: (msg: ClientSignalingMessage) => void;
    transport: DirectP2PTransport;
    localIdentity: LocalIdentity;
    config: TermLinkConfig;
  }) {
    super();
    this.roomInfo = params.roomInfo;
    this.reconnectToken = params.reconnectToken;
    this.localPeerId = params.localPeerId;
    this.sendSignal = params.sendSignal;
    this.transport = params.transport;
    this.localIdentity = params.localIdentity;
    this.config = params.config;
    this.topology = new TopologyManager({ maxPeers: params.roomInfo.maxPeers });

    for (const member of params.roomInfo.members) {
      if (member.peerId !== this.localPeerId) {
        this.transport.registerPeerIdentity(member.peerId, member.identity);
      }
    }
  }

  get code(): string {
    return this.roomInfo.code;
  }

  get roomId(): string {
    return this.roomInfo.roomId;
  }

  get members(): RoomMember[] {
    return this.roomInfo.members;
  }

  get joinUrl(): string {
    return this.roomInfo.joinUrl;
  }

  get activeSharedTerminal(): SharedTerminalSession | null {
    return this.sharedTerminal;
  }

  get currentRemoteTerminal(): RoomSession['remoteTerminalState'] {
    return this.remoteTerminalState;
  }

  get localDeviceName(): string {
    return this.localIdentity.publicIdentity.deviceName;
  }

  renameDevice(newName: string): void {
    const clean = newName.trim().slice(0, 64);
    if (!clean) return;
    const oldName = this.localIdentity.publicIdentity.deviceName;
    this.localIdentity.publicIdentity.deviceName = clean;
    const selfMember = this.roomInfo.members.find((m) => m.peerId === this.localPeerId);
    if (selfMember) {
      selfMember.identity.deviceName = clean;
    }
    void this.sendMessage(`* has renamed their device from "${oldName}" to "${clean}"`);
  }

  /** @internal */
  updateRoomInfo(room: RoomInfo): void {
    this.roomInfo = room;
    for (const member of room.members) {
      if (member.peerId !== this.localPeerId) {
        this.transport.registerPeerIdentity(member.peerId, member.identity);
      }
    }
    this.emit('roomUpdated', room);
  }

  approveJoin(requestId: string, role: PeerRole = 'collaborator'): void {
    this.sendSignal({ type: 'room:approve', requestId, approved: true, role });
  }

  rejectJoin(requestId: string, reason?: string): void {
    this.sendSignal({ type: 'room:approve', requestId, approved: false, reason });
  }

  kickPeer(targetPeerId: string, reason?: string): void {
    this.sendSignal({ type: 'room:kick', targetPeerId, reason });
  }

  setPeerRole(targetPeerId: string, role: PeerRole): void {
    this.sendSignal({ type: 'room:set_role', targetPeerId, role });
  }

  transferOwnership(targetPeerId: string): void {
    this.sendSignal({ type: 'room:transfer_ownership', targetPeerId });
  }

  rotateCode(): void {
    this.sendSignal({ type: 'room:rotate_code' });
  }

  createInvite(options: { role?: PeerRole; oneTime?: boolean; expiresInMs?: number } = {}): void {
    this.sendSignal({ type: 'room:create_invite', ...options });
  }

  revokeInvite(token: string): void {
    this.sendSignal({ type: 'room:revoke_invite', token });
  }

  updateSettings(settings: {
    publicQuickConnect?: boolean;
    requireHostApproval?: boolean;
    password?: string | null;
  }): void {
    this.sendSignal({ type: 'room:update_settings', ...settings });
  }

  async sendMessage(text: string): Promise<{ messageId: string; deliveryModes: Record<string, ConnectionMode> }> {
    const clean = text.trim();
    if (!clean) throw new TermLinkError('EMPTY_MESSAGE', 'Cannot send an empty message.');
    const messageId = `msg_${crypto.randomBytes(6).toString('hex')}`;
    const payload: PeerDataPayload = {
      kind: 'chat:group',
      messageId,
      text: clean,
      senderName: this.localIdentity.publicIdentity.deviceName,
      senderPeerId: this.localPeerId,
      timestamp: Date.now(),
    };

    const deliveryModes: Record<string, ConnectionMode> = {};
    for (const member of this.roomInfo.members) {
      if (member.peerId === this.localPeerId) continue;
      deliveryModes[member.peerId] = this.transport.sendToPeer(member.peerId, payload);
    }
    return { messageId, deliveryModes };
  }

  async sendPrivateMessage(targetPeerIdOrName: string, text: string): Promise<{ messageId: string; mode: ConnectionMode }> {
    const target = this.findMember(targetPeerIdOrName);
    if (!target) {
      throw new TermLinkError('PEER_NOT_FOUND', `Peer "${targetPeerIdOrName}" is not in the room.`);
    }
    const messageId = `pm_${crypto.randomBytes(6).toString('hex')}`;
    const payload: PeerDataPayload = {
      kind: 'chat:private',
      messageId,
      toPeerId: target.peerId,
      text: text.trim(),
      senderName: this.localIdentity.publicIdentity.deviceName,
      senderPeerId: this.localPeerId,
      timestamp: Date.now(),
    };
    const mode = this.transport.sendToPeer(target.peerId, payload);
    return { messageId, mode };
  }

  proposeCommand(targetPeerIdOrName: string, command: string, description?: string): string {
    const target = this.findMember(targetPeerIdOrName);
    if (!target) {
      throw new TermLinkError('PEER_NOT_FOUND', `Peer "${targetPeerIdOrName}" is not in the room.`);
    }
    const proposalId = `cmd_${crypto.randomBytes(6).toString('hex')}`;
    this.transport.sendToPeer(target.peerId, {
      kind: 'command:proposal',
      proposalId,
      command,
      description,
      senderName: this.localIdentity.publicIdentity.deviceName,
      senderPeerId: this.localPeerId,
      timestamp: Date.now(),
    });
    return proposalId;
  }

  async sendFile(
    filePath: string,
    options: { toPeer?: string; group?: boolean; allowPeerAssist?: boolean } = {}
  ): Promise<string> {
    const metadata = await prepareFileOffer(filePath, this.config.maxFileSizeBytes);

    let targets: RoomMember[] = [];
    if (options.toPeer) {
      const m = this.findMember(options.toPeer);
      if (!m) throw new TermLinkError('PEER_NOT_FOUND', `Peer "${options.toPeer}" not found.`);
      targets = [m];
    } else {
      targets = this.roomInfo.members.filter((m) => m.peerId !== this.localPeerId);
    }

    if (targets.length === 0) {
      throw new TermLinkError('NO_RECIPIENTS', 'No connected peers available to receive the file.');
    }

    const sender = new StreamingFileSender();
    this.activeSenders.set(metadata.transferId, {
      sender,
      filePath,
      metadata,
      targetPeerIds: targets.map((t) => t.peerId),
      ackWaiters: new Map(),
    });

    for (const peer of targets) {
      this.transport.sendToPeer(peer.peerId, {
        kind: 'file:offer',
        transferId: metadata.transferId,
        filename: metadata.filename,
        size: metadata.size,
        sha256: metadata.sha256,
        chunkSize: metadata.chunkSize,
        totalChunks: metadata.totalChunks,
        target: options.group ? 'group' : peer.peerId,
        allowPeerAssist: Boolean(options.allowPeerAssist),
        senderName: this.localIdentity.publicIdentity.deviceName,
      });
    }

    return metadata.transferId;
  }

  pauseFileTransfer(transferId: string): void {
    const active = this.activeSenders.get(transferId);
    if (!active) return;
    active.sender.pause();
    for (const pid of active.targetPeerIds) {
      this.transport.sendToPeer(pid, { kind: 'file:control', transferId, action: 'pause' });
    }
  }

  resumeFileTransfer(transferId: string): void {
    const active = this.activeSenders.get(transferId);
    if (!active) return;
    active.sender.resume();
    for (const pid of active.targetPeerIds) {
      this.transport.sendToPeer(pid, { kind: 'file:control', transferId, action: 'resume' });
    }
  }

  cancelFileTransfer(transferId: string): void {
    const active = this.activeSenders.get(transferId);
    if (active) {
      active.sender.cancel();
      for (const pid of active.targetPeerIds) {
        this.transport.sendToPeer(pid, { kind: 'file:control', transferId, action: 'cancel' });
      }
      this.activeSenders.delete(transferId);
    }
    const rec = this.activeReceivers.get(transferId);
    if (rec) {
      void rec.abort();
      this.activeReceivers.delete(transferId);
    }
  }

  /**
   * Starts a host-controlled shared terminal session.
   * Disabled by default; never started automatically.
   */
  startTerminalSession(sessionName: string = 'shared-shell', cwd?: string): SharedTerminalSession {
    if (this.roomInfo.ownerPeerId !== this.localPeerId) {
      throw new TermLinkError('FORBIDDEN', 'Only the room owner can start a shared terminal session.');
    }
    if (this.sharedTerminal) {
      this.sharedTerminal.stop();
    }

    const session = new SharedTerminalSession({
      sessionName,
      ownerPeerId: this.localPeerId,
      ownerName: this.localIdentity.publicIdentity.deviceName,
    });

    session.on('output', (ev: { sessionId: string; data: string; seq: number; timestamp: number }) => {
      this.emit('terminalOutput', ev);
      for (const member of this.roomInfo.members) {
        if (member.peerId === this.localPeerId) continue;
        if (session.canPeerView(member.peerId)) {
          this.transport.sendToPeer(member.peerId, {
            kind: 'terminal:output',
            sessionId: ev.sessionId,
            data: ev.data,
            seq: ev.seq,
            timestamp: ev.timestamp,
          });
        }
      }
    });

    session.on('exit', () => {
      this.broadcastTerminalState();
    });

    session.start(cwd);
    this.sharedTerminal = session;
    this.broadcastTerminalState();
    return session;
  }

  setTerminalPeerAccess(targetPeerId: string, access: TerminalAccessMode): void {
    if (!this.sharedTerminal) {
      throw new TermLinkError('NO_TERMINAL_SESSION', 'No active shared terminal session.');
    }
    const member = this.roomInfo.members.find((m) => m.peerId === targetPeerId);
    if (!member) throw new TermLinkError('PEER_NOT_FOUND', 'Peer not found.');

    this.sharedTerminal.setPeerAccess(targetPeerId, member.identity.deviceName, member.role, access);
    this.sendSignal({ type: 'room:set_terminal_access', targetPeerId, access });
    this.broadcastTerminalState();
  }

  lockTerminalSession(locked: boolean): void {
    if (!this.sharedTerminal) return;
    this.sharedTerminal.setLocked(locked);
    this.broadcastTerminalState();
  }

  stopTerminalSession(): void {
    if (!this.sharedTerminal) return;
    this.sharedTerminal.stop();
    this.broadcastTerminalState();
    this.sharedTerminal = null;
  }

  sendTerminalInput(data: string): boolean {
    if (this.sharedTerminal && this.sharedTerminal.getSnapshot().active) {
      return this.sharedTerminal.writeInput(
        this.localPeerId,
        this.localIdentity.publicIdentity.deviceName,
        data
      );
    }
    if (this.remoteTerminalState && this.remoteTerminalState.active) {
      this.transport.sendToPeer(this.remoteTerminalState.ownerPeerId, {
        kind: 'terminal:input',
        sessionId: this.remoteTerminalState.sessionId,
        data,
      });
      return true;
    }
    return false;
  }

  private broadcastTerminalState(): void {
    if (!this.sharedTerminal) return;
    const snap = this.sharedTerminal.getSnapshot();
    const payload: PeerDataPayload = {
      kind: 'terminal:state',
      sessionId: snap.sessionId,
      sessionName: snap.sessionName,
      ownerPeerId: snap.ownerPeerId,
      ownerName: snap.ownerName,
      active: snap.active,
      locked: snap.locked,
      shell: snap.shell,
      permissions: snap.permissions,
    };
    for (const member of this.roomInfo.members) {
      if (member.peerId === this.localPeerId) continue;
      this.transport.sendToPeer(member.peerId, payload);
    }
  }

  /** @internal */
  async handlePeerPayload(fromPeerId: string, payload: PeerDataPayload, mode: ConnectionMode): Promise<void> {
    const senderMember = this.roomInfo.members.find((m) => m.peerId === fromPeerId);

    switch (payload.kind) {
      case 'chat:group': {
        this.emit('message', { ...payload, connectionMode: mode });
        this.transport.sendToPeer(fromPeerId, {
          kind: 'chat:ack',
          messageId: payload.messageId,
          receivedAt: Date.now(),
        });
        break;
      }

      case 'chat:private': {
        this.emit('privateMessage', { ...payload, connectionMode: mode });
        this.transport.sendToPeer(fromPeerId, {
          kind: 'chat:ack',
          messageId: payload.messageId,
          receivedAt: Date.now(),
        });
        break;
      }

      case 'chat:ack': {
        this.emit('messageDelivered', { fromPeerId, ...payload });
        break;
      }

      case 'command:proposal': {
        // NEVER auto-execute received commands. Always surface for explicit review.
        const risk = assessCommandRisk(payload.command);
        const proposal: IncomingCommandProposal = {
          proposalId: payload.proposalId,
          fromPeerId,
          senderName: payload.senderName,
          command: payload.command,
          description: payload.description,
          risk,
          timestamp: payload.timestamp,
          respond: (decision, editedCommand) => {
            this.transport.sendToPeer(fromPeerId, {
              kind: 'command:decision',
              proposalId: payload.proposalId,
              decision,
              editedCommand,
              responderName: this.localIdentity.publicIdentity.deviceName,
              timestamp: Date.now(),
            });
          },
        };
        this.emit('commandProposal', proposal);
        break;
      }

      case 'command:decision': {
        this.emit('commandDecision', { fromPeerId, ...payload });
        break;
      }

      case 'file:offer': {
        if (payload.size > this.config.maxFileSizeBytes) {
          this.transport.sendToPeer(fromPeerId, {
            kind: 'file:response',
            transferId: payload.transferId,
            accepted: false,
            reason: 'File exceeds recipient maximum size limit.',
          });
          return;
        }

        const offer: IncomingFileOffer = {
          transferId: payload.transferId,
          fromPeerId,
          senderName: payload.senderName,
          filename: payload.filename,
          size: payload.size,
          sha256: payload.sha256,
          totalChunks: payload.totalChunks,
          accept: (downloadDir?: string) => {
            try {
              const receiver = new StreamingFileReceiver({
                transferId: payload.transferId,
                filename: payload.filename,
                expectedSize: payload.size,
                expectedSha256: payload.sha256,
                totalChunks: payload.totalChunks,
                downloadDir: downloadDir || this.config.fileTransferDirectory,
              });
              this.activeReceivers.set(payload.transferId, receiver);
              this.transport.sendToPeer(fromPeerId, {
                kind: 'file:response',
                transferId: payload.transferId,
                accepted: true,
                resumeFromChunk: 0,
              });
            } catch (err) {
              this.transport.sendToPeer(fromPeerId, {
                kind: 'file:response',
                transferId: payload.transferId,
                accepted: false,
                reason: (err as Error).message,
              });
            }
          },
          reject: (reason?: string) => {
            this.transport.sendToPeer(fromPeerId, {
              kind: 'file:response',
              transferId: payload.transferId,
              accepted: false,
              reason: reason || 'Rejected by recipient.',
            });
          },
        };

        this.emit('fileOffer', offer);
        break;
      }

      case 'file:response': {
        const active = this.activeSenders.get(payload.transferId);
        if (!active) return;
        if (!payload.accepted) {
          this.emit('fileRejected', {
            transferId: payload.transferId,
            peerId: fromPeerId,
            reason: payload.reason || 'Rejected',
          });
          return;
        }

        // Stream file chunks with backpressure acknowledgement
        void active.sender
          .send({
            filePath: active.filePath,
            metadata: active.metadata,
            startFromChunk: payload.resumeFromChunk ?? 0,
            onChunk: async (chunkIndex, totalChunks, sha256, dataBase64) => {
              const ackKey = `${fromPeerId}:${chunkIndex}`;
              const ackPromise = new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                  if (active.ackWaiters.has(ackKey)) {
                    active.ackWaiters.delete(ackKey);
                    resolve();
                  }
                }, 15_000);
                timer.unref?.();
                active.ackWaiters.set(ackKey, () => {
                  clearTimeout(timer);
                  resolve();
                });
              });

              this.transport.sendToPeer(fromPeerId, {
                kind: 'file:chunk',
                transferId: payload.transferId,
                chunkIndex,
                totalChunks,
                sha256,
                dataBase64,
              });
              await ackPromise;
            },
            onProgress: (progress: TransferProgress) => {
              this.emit('fileProgress', { direction: 'send', peerId: fromPeerId, ...progress });
            },
          })
          .then((res) => {
            if (res.cancelled) {
              this.emit('fileCancelled', { transferId: payload.transferId });
            }
          });
        break;
      }

      case 'file:chunk': {
        const receiver = this.activeReceivers.get(payload.transferId);
        if (!receiver) return;
        try {
          const progress = await receiver.writeChunk(payload.chunkIndex, payload.sha256, payload.dataBase64);
          this.transport.sendToPeer(fromPeerId, {
            kind: 'file:chunk_ack',
            transferId: payload.transferId,
            chunkIndex: payload.chunkIndex,
            ok: true,
          });
          this.emit('fileProgress', { direction: 'receive', peerId: fromPeerId, ...progress });

          if (payload.chunkIndex + 1 >= payload.totalChunks) {
            const result = await receiver.finalize();
            this.activeReceivers.delete(payload.transferId);
            this.transport.sendToPeer(fromPeerId, {
              kind: 'file:complete',
              transferId: payload.transferId,
              verified: result.verified,
              sha256: result.actualSha256,
              error: result.verified ? undefined : 'SHA-256 verification failed',
            });
            this.emit('fileComplete', {
              direction: 'receive',
              transferId: payload.transferId,
              filename: receiver.filename,
              savedPath: result.savedPath,
              verified: result.verified,
              sha256: result.actualSha256,
            });
          }
        } catch (err) {
          await receiver.abort();
          this.activeReceivers.delete(payload.transferId);
          this.transport.sendToPeer(fromPeerId, {
            kind: 'file:complete',
            transferId: payload.transferId,
            verified: false,
            sha256: '',
            error: (err as Error).message,
          });
        }
        break;
      }

      case 'file:chunk_ack': {
        const active = this.activeSenders.get(payload.transferId);
        if (!active) return;
        const ackKey = `${fromPeerId}:${payload.chunkIndex}`;
        const resolver = active.ackWaiters.get(ackKey);
        if (resolver) {
          active.ackWaiters.delete(ackKey);
          resolver();
        }
        break;
      }

      case 'file:control': {
        if (payload.action === 'cancel') {
          const rec = this.activeReceivers.get(payload.transferId);
          if (rec) {
            await rec.abort();
            this.activeReceivers.delete(payload.transferId);
          }
          const active = this.activeSenders.get(payload.transferId);
          if (active) {
            active.sender.cancel();
            this.activeSenders.delete(payload.transferId);
          }
          this.emit('fileCancelled', { transferId: payload.transferId });
        }
        break;
      }

      case 'file:complete': {
        this.activeSenders.delete(payload.transferId);
        this.emit('fileComplete', {
          direction: 'send',
          transferId: payload.transferId,
          peerId: fromPeerId,
          verified: payload.verified,
          sha256: payload.sha256,
          error: payload.error,
        });
        break;
      }

      case 'terminal:state': {
        this.remoteTerminalState = {
          sessionId: payload.sessionId,
          sessionName: payload.sessionName,
          ownerPeerId: payload.ownerPeerId,
          ownerName: payload.ownerName,
          active: payload.active,
          locked: payload.locked,
          shell: payload.shell,
          permissions: payload.permissions,
        };
        this.emit('terminalState', this.remoteTerminalState);
        break;
      }

      case 'terminal:output': {
        this.emit('terminalOutput', {
          sessionId: payload.sessionId,
          data: payload.data,
          seq: payload.seq,
          timestamp: payload.timestamp,
        });
        break;
      }

      case 'terminal:input': {
        if (this.sharedTerminal && this.sharedTerminal.sessionId === payload.sessionId) {
          const accepted = this.sharedTerminal.writeInput(
            fromPeerId,
            senderMember?.identity.deviceName ?? fromPeerId,
            payload.data
          );
          if (!accepted) {
            this.emit('securityWarning', {
              fromPeerId,
              reason: 'Rejected unauthorized remote terminal input attempt.',
            });
          }
        }
        break;
      }
    }
  }

  private findMember(peerIdOrName: string): RoomMember | undefined {
    const q = peerIdOrName.toLowerCase();
    return this.roomInfo.members.find(
      (m) =>
        m.peerId !== this.localPeerId &&
        (m.peerId.toLowerCase() === q || m.identity.deviceName.toLowerCase() === q)
    );
  }

  leave(): void {
    this.stopTerminalSession();
    this.sendSignal({ type: 'room:leave' });
  }

  closeRoom(): void {
    this.stopTerminalSession();
    this.sendSignal({ type: 'room:close' });
  }
}

export interface TermLinkClientOptions extends Partial<TermLinkConfig> {
  storageDir?: string;
  enableDirectTcp?: boolean;
}

export class TermLink extends EventEmitter {
  public readonly config: TermLinkConfig;
  public readonly identityStore: IdentityStore;
  public localIdentity!: LocalIdentity;
  public peerId: string = '';

  private ws: WebSocket | null = null;
  private transport: DirectP2PTransport | null = null;
  private currentRoom: RoomSession | null = null;
  private readonly enableDirectTcp: boolean;
  private initialized = false;

  constructor(options: TermLinkClientOptions = {}) {
    super();
    const validated = validateConfig({ ...DEFAULT_CONFIG, ...options });
    if (!validated.valid) {
      throw new TermLinkError('INVALID_CONFIG', validated.errors.join('; '));
    }
    this.config = validated.config;
    this.identityStore = new IdentityStore(options.storageDir);
    this.enableDirectTcp = options.enableDirectTcp ?? true;
  }

  async initialize(): Promise<PeerPublicIdentity> {
    if (this.initialized && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.localIdentity.publicIdentity;
    }

    this.localIdentity = this.identityStore.loadOrCreate(this.config.deviceName);
    this.transport = new DirectP2PTransport(this.localIdentity);

    let directEndpoint: { host: string; port: number } | undefined;
    if (this.enableDirectTcp) {
      try {
        directEndpoint = await this.transport.startListener();
      } catch {
        directEndpoint = undefined;
      }
    }

    this.transport.setRelayFallback((targetPeerId, envelope) => {
      this.sendSignal({ type: 'relay:payload', targetPeerId, envelope });
    });

    this.transport.on('connectionMode', (ev: { peerId: string; mode: ConnectionMode }) => {
      this.sendSignal({ type: 'room:report_connection', targetPeerId: ev.peerId, mode: ev.mode });
      this.currentRoom?.emit('connectionStateChanged', ev);
    });

    this.transport.on('payload', (ev: { fromPeerId: string; payload: PeerDataPayload; mode: ConnectionMode }) => {
      void this.currentRoom?.handlePeerPayload(ev.fromPeerId, ev.payload, ev.mode);
    });

    this.transport.on('securityWarning', (warn) => {
      this.emit('securityWarning', warn);
      this.currentRoom?.emit('securityWarning', warn);
    });

    await this.connectSignaling(directEndpoint);
    this.initialized = true;
    return this.localIdentity.publicIdentity;
  }

  private connectSignaling(directEndpoint?: { host: string; port: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.signalingServer);
      this.ws = ws;

      const onError = (err: Error) => {
        reject(new TermLinkError('SIGNALING_FAILED', `Failed to connect to signaling server: ${err.message}`));
      };

      ws.once('error', onError);

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf8')) as ServerSignalingMessage;
        if (msg.type === 'welcome') {
          ws.off('error', onError);
          this.peerId = msg.peerId;
          this.transport?.setLocalPeerId(msg.peerId);
          this.sendSignal({
            type: 'hello',
            identity: this.localIdentity.publicIdentity,
            directEndpoint,
          });
          resolve();
          return;
        }
        this.handleServerMessage(msg);
      });

      ws.on('close', () => {
        this.emit('disconnected');
      });
    });
  }

  private sendSignal(msg: ClientSignalingMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async createRoom(options: {
    roomName?: string;
    requireHostApproval?: boolean;
    publicQuickConnect?: boolean;
    password?: string;
    maxPeers?: number;
    preferredCode?: string;
  } = {}): Promise<RoomSession> {
    if (!this.initialized) await this.initialize();

    return new Promise((resolve, reject) => {
      const onMsg = (msg: ServerSignalingMessage) => {
        if (msg.type === 'room:created') {
          cleanup();
          const session = this.attachRoomSession(msg.room, msg.reconnectToken);
          resolve(session);
        } else if (msg.type === 'error') {
          cleanup();
          reject(new TermLinkError(msg.code, msg.message));
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new TermLinkError('TIMEOUT', 'Timed out waiting for room creation.'));
      }, 8000);

      const cleanup = () => {
        clearTimeout(timer);
        this.off('_serverMessage', onMsg);
      };

      this.on('_serverMessage', onMsg);
      this.sendSignal({
        type: 'room:create',
        roomName: (options.roomName || `${this.localIdentity.publicIdentity.deviceName} Room`).slice(0, 64),
        requireHostApproval: options.requireHostApproval ?? this.config.requireHostApproval,
        publicQuickConnect: options.publicQuickConnect ?? this.config.defaultRoomMode === 'quick',
        password: options.password,
        maxPeers: options.maxPeers ?? this.config.maxPeers,
        preferredCode: options.preferredCode
          ? (/^\d{1,2}$/.test(options.preferredCode.trim())
              ? options.preferredCode.trim().padStart(2, '0')
              : options.preferredCode.trim())
          : undefined,
      });
    });
  }

  async lookupCode(code: string): Promise<RoomCandidate[]> {
    if (!this.initialized) await this.initialize();

    return new Promise((resolve, reject) => {
      const onMsg = (msg: ServerSignalingMessage) => {
        if (msg.type === 'room:candidates' && msg.code === code) {
          cleanup();
          resolve(msg.candidates);
        } else if (msg.type === 'error') {
          cleanup();
          reject(new TermLinkError(msg.code, msg.message));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new TermLinkError('TIMEOUT', 'Timed out looking up room code.'));
      }, 6000);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('_serverMessage', onMsg);
      };
      this.on('_serverMessage', onMsg);
      this.sendSignal({ type: 'room:lookup', code });
    });
  }

  async joinRoom(
    target: string,
    options: {
      roomId?: string;
      password?: string;
      reconnectToken?: string;
      onPending?: (info: { roomId: string; roomName: string; hostName: string; hostFingerprint: string }) => void;
      onAmbiguous?: (candidates: RoomCandidate[]) => Promise<string | null>;
      timeoutMs?: number;
    } = {}
  ): Promise<RoomSession> {
    if (!this.initialized) await this.initialize();

    const parsed = options.roomId
      ? ({ kind: 'roomId', roomId: options.roomId } as const)
      : parseJoinTarget(target);

    if (parsed.kind === 'invalid') {
      throw new TermLinkError('INVALID_TARGET', parsed.reason);
    }

    return new Promise((resolve, reject) => {
      const onMsg = async (msg: ServerSignalingMessage) => {
        if (msg.type === 'room:pending') {
          options.onPending?.({
            roomId: msg.roomId,
            roomName: msg.roomName,
            hostName: msg.hostName,
            hostFingerprint: msg.hostFingerprint,
          });
        } else if (msg.type === 'room:candidates') {
          if (options.onAmbiguous) {
            const chosenId = await options.onAmbiguous(msg.candidates);
            if (!chosenId) {
              cleanup();
              reject(new TermLinkError('JOIN_CANCELLED', 'Room selection cancelled.'));
              return;
            }
            this.sendSignal({
              type: 'room:join',
              roomId: chosenId,
              password: options.password,
              reconnectToken: options.reconnectToken,
            });
          } else {
            cleanup();
            reject(
              new TermLinkError('AMBIGUOUS_CODE', 'Multiple rooms share this 2-digit code. Specify roomId.', {
                candidates: msg.candidates,
              })
            );
          }
        } else if (msg.type === 'room:joined') {
          cleanup();
          const session = this.attachRoomSession(msg.room, msg.reconnectToken);
          // Initiate real direct P2P links to existing peers where endpoints are available
          for (const [pid, endpoint] of Object.entries(msg.directEndpoints || {})) {
            if (this.enableDirectTcp) {
              void this.transport?.connectToPeer(pid, endpoint);
            }
          }
          resolve(session);
        } else if (msg.type === 'room:rejected') {
          cleanup();
          reject(new TermLinkError('JOIN_REJECTED', msg.reason));
        } else if (msg.type === 'error') {
          cleanup();
          reject(new TermLinkError(msg.code, msg.message));
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new TermLinkError('JOIN_TIMEOUT', 'Timed out waiting to join room.'));
      }, options.timeoutMs ?? 60_000);

      const cleanup = () => {
        clearTimeout(timer);
        this.off('_serverMessage', onMsg);
      };

      this.on('_serverMessage', onMsg);

      if (parsed.kind === 'roomId') {
        this.sendSignal({
          type: 'room:join',
          roomId: parsed.roomId,
          password: options.password,
          reconnectToken: options.reconnectToken,
        });
      } else if (parsed.kind === 'code') {
        this.sendSignal({
          type: 'room:join',
          code: parsed.code,
          password: options.password,
          reconnectToken: options.reconnectToken,
        });
      } else {
        this.sendSignal({
          type: 'room:join',
          inviteToken: parsed.token,
          password: options.password,
          reconnectToken: options.reconnectToken,
        });
      }
    });
  }

  private attachRoomSession(room: RoomInfo, reconnectToken: string): RoomSession {
    const session = new RoomSession({
      roomInfo: room,
      reconnectToken,
      localPeerId: this.peerId,
      sendSignal: (m) => this.sendSignal(m),
      transport: this.transport!,
      localIdentity: this.localIdentity,
      config: this.config,
    });
    this.currentRoom = session;
    return session;
  }

  private handleServerMessage(msg: ServerSignalingMessage): void {
    this.emit('_serverMessage', msg);

    switch (msg.type) {
      case 'room:join_request':
        this.currentRoom?.emit('joinRequest', msg.request as PendingJoinRequest);
        break;
      case 'room:updated':
        this.currentRoom?.updateRoomInfo(msg.room);
        break;
      case 'room:peer_joined':
        this.transport?.registerPeerIdentity(msg.member.peerId, msg.member.identity);
        if (this.currentRoom && !this.currentRoom.roomInfo.members.some((m) => m.peerId === msg.member.peerId)) {
          this.currentRoom.roomInfo = {
            ...this.currentRoom.roomInfo,
            members: [...this.currentRoom.roomInfo.members, msg.member],
          };
        }
        if (msg.directEndpoint && this.enableDirectTcp) {
          void this.transport?.connectToPeer(msg.member.peerId, msg.directEndpoint);
        }
        this.currentRoom?.emit('peerJoined', msg.member);
        break;
      case 'room:peer_left':
        this.transport?.closePeer(msg.peerId);
        this.currentRoom?.emit('peerLeft', {
          peerId: msg.peerId,
          deviceName: msg.deviceName,
          reason: msg.reason,
        });
        break;
      case 'room:closed':
        this.currentRoom?.emit('roomClosed', { reason: msg.reason });
        this.currentRoom = null;
        break;
      case 'room:invite_created':
        this.currentRoom?.emit('inviteCreated', msg.invite as InviteRecord);
        break;
      case 'room:invite_revoked':
        this.currentRoom?.emit('inviteRevoked', { token: msg.token });
        break;
      case 'relay:payload':
        this.transport?.handleIncomingEnvelope(msg.fromPeerId, msg.envelope, 'relayed');
        break;
      case 'error':
        this.emit('error', new TermLinkError(msg.code, msg.message));
        break;
    }
  }

  renameDevice(newName: string): PeerPublicIdentity {
    const clean = newName.trim().slice(0, 64);
    this.config.deviceName = clean;
    const updated = this.identityStore.renameDevice(clean);
    this.localIdentity = updated;
    return updated.publicIdentity;
  }

  async disconnect(): Promise<void> {
    this.currentRoom?.stopTerminalSession();
    this.currentRoom = null;
    this.transport?.closeAll();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 500);
        timer.unref?.();
        ws.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.close();
      });
    }
    this.initialized = false;
  }
}

export * from '../../core/src/index';
export * from '../../permissions/src/index';
export * from '../../protocol/src/index';
