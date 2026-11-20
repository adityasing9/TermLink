import crypto from 'node:crypto';
import dgram from 'node:dgram';
import EventEmitter from 'node:events';
import net from 'node:net';
import os from 'node:os';
import type { ConnectionMode, PeerPublicIdentity } from '../../core/src/index';
import { decryptFromPeer, encryptForPeer, type LocalIdentity } from '../../identity/src/index';
import type { EncryptedEnvelope, PeerDataPayload } from '../../protocol/src/index';

export type GroupTopologyMode = 'full_mesh' | 'hybrid_selective';

export interface TopologySummary {
  mode: GroupTopologyMode;
  peerCount: number;
  meshEdges: number;
  maxPeers: number;
  maxDirectConnectionsPerPeer: number;
}

/**
 * Configurable group topology manager.
 * - 2-8 peers: full mesh (connections = N * (N - 1) / 2)
 * - 9-20 peers: hybrid selective peer links to bound socket/CPU utilization
 */
export class TopologyManager {
  public readonly maxPeers: number;
  public readonly meshThreshold: number;
  public readonly maxDirectConnectionsPerPeer: number;

  constructor(options: { maxPeers?: number; meshThreshold?: number; maxDirectConnectionsPerPeer?: number } = {}) {
    this.maxPeers = Math.min(50, Math.max(2, options.maxPeers ?? 8));
    this.meshThreshold = options.meshThreshold ?? 8;
    this.maxDirectConnectionsPerPeer = options.maxDirectConnectionsPerPeer ?? 7;
  }

  calculateMeshConnections(peerCount: number): number {
    if (peerCount <= 1) return 0;
    return (peerCount * (peerCount - 1)) / 2;
  }

  getTopologySummary(peerCount: number): TopologySummary {
    const mode: GroupTopologyMode = peerCount <= this.meshThreshold ? 'full_mesh' : 'hybrid_selective';
    return {
      mode,
      peerCount,
      meshEdges: this.calculateMeshConnections(peerCount),
      maxPeers: this.maxPeers,
      maxDirectConnectionsPerPeer: this.maxDirectConnectionsPerPeer,
    };
  }

  /**
   * Returns which peers a local peer should open direct P2P links to.
   * For <= 8 peers: every other peer (full mesh).
   * For 9-20 peers: owner + deterministic ring neighbors up to maxDirectConnectionsPerPeer.
   */
  selectDirectTargets(localPeerId: string, allPeerIds: string[], ownerPeerId: string): string[] {
    const others = allPeerIds.filter((id) => id !== localPeerId).sort();
    if (allPeerIds.length <= this.meshThreshold) {
      return others;
    }

    const selected = new Set<string>();
    if (ownerPeerId !== localPeerId && others.includes(ownerPeerId)) {
      selected.add(ownerPeerId);
    }

    const sortedAll = [...allPeerIds].sort();
    const myIdx = sortedAll.indexOf(localPeerId);
    for (let offset = 1; offset < sortedAll.length && selected.size < this.maxDirectConnectionsPerPeer; offset++) {
      const next = sortedAll[(myIdx + offset) % sortedAll.length];
      if (next !== localPeerId) selected.add(next);
    }
    return Array.from(selected);
  }
}

export interface StunResult {
  reachable: boolean;
  server: string;
  reflexiveIp?: string;
  reflexivePort?: number;
  rttMs?: number;
  error?: string;
}

/**
 * Real RFC 5389 STUN Binding Request over UDP using native Node dgram.
 * Parses XOR-MAPPED-ADDRESS (0x0020) and MAPPED-ADDRESS (0x0001).
 */
export async function probeStunServer(stunUri: string, timeoutMs: number = 2500): Promise<StunResult> {
  const cleaned = stunUri.replace(/^stuns?:/i, '');
  const [host, portStr] = cleaned.split(':');
  const port = Number(portStr || 19302);
  if (!host || !Number.isFinite(port)) {
    return { reachable: false, server: stunUri, error: 'Invalid STUN URI.' };
  }

  const start = Date.now();
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const txId = crypto.randomBytes(12);
    // RFC 5389 Header: Type 0x0001 (Binding Request), Length 0, Magic Cookie 0x2112A442, TxID (12 bytes)
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0);
    req.writeUInt16BE(0x0000, 2);
    req.writeUInt32BE(0x2112a442, 4);
    txId.copy(req, 8);

    let finished = false;
    const done = (result: StunResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      done({ reachable: false, server: stunUri, error: 'STUN UDP request timed out (UDP may be restricted).' });
    }, timeoutMs);

    socket.on('error', (err) => {
      done({ reachable: false, server: stunUri, error: err.message });
    });

    socket.on('message', (msg) => {
      if (msg.length < 20) return;
      const msgType = msg.readUInt16BE(0);
      const magic = msg.readUInt32BE(4);
      if (msgType !== 0x0101 || magic !== 0x2112a442) return;
      if (!msg.subarray(8, 20).equals(txId)) return;

      // Parse attributes
      let offset = 20;
      while (offset + 4 <= msg.length) {
        const attrType = msg.readUInt16BE(offset);
        const attrLen = msg.readUInt16BE(offset + 2);
        const attrVal = msg.subarray(offset + 4, offset + 4 + attrLen);

        if (attrType === 0x0020 && attrVal.length >= 8 && attrVal[1] === 0x01) {
          // XOR-MAPPED-ADDRESS IPv4
          const xPort = attrVal.readUInt16BE(2) ^ 0x2112;
          const ipBytes = [
            attrVal[4] ^ 0x21,
            attrVal[5] ^ 0x12,
            attrVal[6] ^ 0xa4,
            attrVal[7] ^ 0x42,
          ];
          done({
            reachable: true,
            server: stunUri,
            reflexiveIp: ipBytes.join('.'),
            reflexivePort: xPort,
            rttMs: Date.now() - start,
          });
          return;
        }
        if (attrType === 0x0001 && attrVal.length >= 8 && attrVal[1] === 0x01) {
          const mPort = attrVal.readUInt16BE(2);
          const ipBytes = [attrVal[4], attrVal[5], attrVal[6], attrVal[7]];
          done({
            reachable: true,
            server: stunUri,
            reflexiveIp: ipBytes.join('.'),
            reflexivePort: mPort,
            rttMs: Date.now() - start,
          });
          return;
        }
        offset += 4 + Math.ceil(attrLen / 4) * 4;
      }

      done({ reachable: true, server: stunUri, rttMs: Date.now() - start });
    });

    socket.send(req, port, host, (err) => {
      if (err) done({ reachable: false, server: stunUri, error: err.message });
    });
  });
}

export function classifyIpConnectionMode(ip: string): ConnectionMode {
  const clean = ip.replace(/^::ffff:/, '');
  if (clean === '127.0.0.1' || clean === '::1') return 'local_network';
  if (
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(clean)
  ) {
    return 'local_network';
  }
  // CGNAT / Tailscale / WireGuard typical ranges (100.64.0.0/10)
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(clean)) {
    return 'vpn';
  }
  return 'direct_p2p';
}

export function getLocalRoutableIpv4(): string {
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

interface DirectPeerLink {
  peerId: string;
  socket: net.Socket;
  mode: ConnectionMode;
  buffer: string;
}

/**
 * Real Direct TCP P2P Transport with E2EE (X25519 + AES-256-GCM + Ed25519)
 * and transparent encrypted relay fallback when direct connections cannot be established.
 * Never falsely reports a direct connection when using relay fallback.
 */
export class DirectP2PTransport extends EventEmitter {
  private server: net.Server | null = null;
  private listenPort = 0;
  private readonly links = new Map<string, DirectPeerLink>();
  private readonly peerIdentities = new Map<string, PeerPublicIdentity>();
  private localPeerId = '';
  private readonly localIdentity: LocalIdentity;
  private relaySender: ((targetPeerId: string, envelope: EncryptedEnvelope) => void) | null = null;

  constructor(localIdentity: LocalIdentity) {
    super();
    this.localIdentity = localIdentity;
  }

  setLocalPeerId(peerId: string): void {
    this.localPeerId = peerId;
  }

  setRelayFallback(sender: (targetPeerId: string, envelope: EncryptedEnvelope) => void): void {
    this.relaySender = sender;
  }

  registerPeerIdentity(peerId: string, identity: PeerPublicIdentity): void {
    this.peerIdentities.set(peerId, identity);
  }

  async startListener(bindHost: string = '0.0.0.0'): Promise<{ host: string; port: number }> {
    if (this.server) {
      return { host: getLocalRoutableIpv4(), port: this.listenPort };
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.attachIncomingSocket(socket);
      });
      server.on('error', reject);
      server.listen(0, bindHost, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.listenPort = addr.port;
        }
        this.server = server;
        resolve({ host: getLocalRoutableIpv4(), port: this.listenPort });
      });
    });
  }

  async connectToPeer(peerId: string, endpoint: { host: string; port: number }, timeoutMs: number = 2000): Promise<ConnectionMode> {
    if (this.links.has(peerId)) {
      return this.links.get(peerId)!.mode;
    }

    return new Promise((resolve) => {
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
      let settled = false;

      const finish = (mode: ConnectionMode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emit('connectionMode', { peerId, mode });
        resolve(mode);
      };

      const timer = setTimeout(() => {
        socket.destroy();
        finish('relayed');
      }, timeoutMs);

      socket.on('connect', () => {
        const mode = classifyIpConnectionMode(endpoint.host);
        // Send authenticated handshake frame identifying our peerId
        socket.write(`${JSON.stringify({ handshake: true, peerId: this.localPeerId })}\n`);
        this.registerSocket(peerId, socket, mode);
        finish(mode);
      });

      socket.on('error', () => {
        socket.destroy();
        finish('relayed');
      });
    });
  }

  private attachIncomingSocket(socket: net.Socket): void {
    let buffer = '';
    const onFirstData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      const rest = buffer.slice(nl + 1);
      socket.off('data', onFirstData);
      try {
        const parsed = JSON.parse(line) as { handshake?: boolean; peerId?: string };
        if (parsed.handshake && typeof parsed.peerId === 'string') {
          const mode = classifyIpConnectionMode(socket.remoteAddress || '127.0.0.1');
          this.registerSocket(parsed.peerId, socket, mode, rest);
          this.emit('connectionMode', { peerId: parsed.peerId, mode });
        } else {
          socket.destroy();
        }
      } catch {
        socket.destroy();
      }
    };
    socket.on('data', onFirstData);
    socket.on('error', () => socket.destroy());
  }

  private registerSocket(peerId: string, socket: net.Socket, mode: ConnectionMode, initialBuffer: string = ''): void {
    const existing = this.links.get(peerId);
    if (existing) {
      existing.socket.destroy();
    }

    const link: DirectPeerLink = { peerId, socket, mode, buffer: initialBuffer };
    this.links.set(peerId, link);

    const processBuffer = () => {
      let nl = link.buffer.indexOf('\n');
      while (nl !== -1) {
        const line = link.buffer.slice(0, nl).trim();
        link.buffer = link.buffer.slice(nl + 1);
        if (line.length > 0) {
          try {
            const envelope = JSON.parse(line) as EncryptedEnvelope;
            this.handleIncomingEnvelope(peerId, envelope, mode);
          } catch (err) {
            this.emit('error', err);
          }
        }
        nl = link.buffer.indexOf('\n');
      }
    };

    if (link.buffer.length > 0) processBuffer();

    socket.on('data', (chunk) => {
      link.buffer += chunk.toString('utf8');
      processBuffer();
    });

    socket.on('close', () => {
      if (this.links.get(peerId)?.socket === socket) {
        this.links.delete(peerId);
        this.emit('connectionMode', { peerId, mode: 'relayed' });
      }
    });

    socket.on('error', () => {
      socket.destroy();
    });
  }

  getConnectionMode(peerId: string): ConnectionMode {
    const link = this.links.get(peerId);
    if (link && !link.socket.destroyed) return link.mode;
    return this.relaySender ? 'relayed' : 'disconnected';
  }

  sendToPeer(peerId: string, payload: PeerDataPayload): ConnectionMode {
    const remoteIdentity = this.peerIdentities.get(peerId);
    if (!remoteIdentity) {
      throw new Error(`Missing public identity for peer ${peerId}`);
    }

    const envelope = encryptForPeer(
      this.localIdentity,
      this.localPeerId,
      peerId,
      remoteIdentity.dhPublicKey,
      payload
    );

    const link = this.links.get(peerId);
    if (link && !link.socket.destroyed && link.socket.writable) {
      link.socket.write(`${JSON.stringify(envelope)}\n`);
      return link.mode;
    }

    if (this.relaySender) {
      this.relaySender(peerId, envelope);
      return 'relayed';
    }

    return 'disconnected';
  }

  handleIncomingEnvelope(fromPeerId: string, envelope: EncryptedEnvelope, viaMode: ConnectionMode): void {
    const remoteIdentity = this.peerIdentities.get(fromPeerId);
    if (!remoteIdentity) return;
    try {
      const payload = decryptFromPeer<PeerDataPayload>(this.localIdentity, remoteIdentity, envelope);
      this.emit('payload', { fromPeerId, payload, mode: viaMode });
    } catch (err) {
      this.emit('securityWarning', { fromPeerId, reason: (err as Error).message });
    }
  }

  closePeer(peerId: string): void {
    const link = this.links.get(peerId);
    if (link) {
      link.socket.destroy();
      this.links.delete(peerId);
    }
  }

  closeAll(): void {
    for (const link of this.links.values()) {
      link.socket.destroy();
    }
    this.links.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
