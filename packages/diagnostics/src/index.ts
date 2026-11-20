import net from 'node:net';
import os from 'node:os';
import WebSocket from 'ws';
import {
  DEFAULT_CONFIG,
  TERMLINK_VERSION,
  detectPlatform,
  type TermLinkConfig,
} from '../../core/src/index';
import { probeStunServer, type StunResult } from '../../networking/src/index';

export interface InterfaceSummary {
  name: string;
  family: string;
  internal: boolean;
  address: string; // redacted unless detailed = true
}

export interface DiagnosticsReport {
  timestamp: number;
  termlinkVersion: string;
  nodeVersion: string;
  platform: string;
  osRelease: string;
  arch: string;
  interfaces: InterfaceSummary[];
  localConnectivity: boolean;
  signaling: {
    url: string;
    connected: boolean;
    rttMs?: number;
    error?: string;
  };
  stun: StunResult;
  directP2P: {
    listenerAvailable: boolean;
    ephemeralPort?: number;
    error?: string;
  };
  relay: {
    available: boolean;
    mode: 'turn' | 'e2ee_signaling_relay' | 'unavailable';
    configuredTurnServers: number;
  };
  natSummary: string;
  firewallWarning: string | null;
  status: 'Ready' | 'Degraded' | 'Offline';
}

function redactIp(ip: string): string {
  if (ip === '127.0.0.1' || ip === '::1') return ip;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.x.x`;
  }
  return 'xxxx::xxxx';
}

async function testSignaling(url: string, timeoutMs: number = 3000): Promise<DiagnosticsReport['signaling']> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: DiagnosticsReport['signaling']) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      finish({ url, connected: false, error: (err as Error).message });
      return;
    }

    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      finish({ url, connected: false, error: 'Connection timed out' });
    }, timeoutMs);

    ws.on('open', () => {
      const rttMs = Date.now() - start;
      ws.close();
      finish({ url, connected: true, rttMs });
    });

    ws.on('error', (err) => {
      finish({ url, connected: false, error: err.message });
    });
  });
}

async function testDirectTcpBind(): Promise<DiagnosticsReport['directP2P']> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.on('error', (err) => {
      resolve({ listenerAvailable: false, error: err.message });
    });
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : undefined;
      server.close(() => {
        resolve({ listenerAvailable: true, ephemeralPort: port });
      });
    });
  });
}

export async function runDiagnostics(options: {
  config?: Partial<TermLinkConfig>;
  detailed?: boolean;
} = {}): Promise<DiagnosticsReport> {
  const cfg: TermLinkConfig = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const detailed = Boolean(options.detailed);

  const rawIfaces = os.networkInterfaces();
  const interfaces: InterfaceSummary[] = [];
  let hasNonInternal = false;

  for (const [name, entries] of Object.entries(rawIfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== 'IPv4') continue;
      if (!entry.internal) hasNonInternal = true;
      interfaces.push({
        name,
        family: entry.family,
        internal: entry.internal,
        address: detailed ? entry.address : redactIp(entry.address),
      });
    }
  }

  const primaryStun = cfg.stunServers[0] || 'stun:stun.l.google.com:19302';
  const [signaling, stunRaw, directP2P] = await Promise.all([
    testSignaling(cfg.signalingServer),
    probeStunServer(primaryStun, 2200),
    testDirectTcpBind(),
  ]);

  const stun: StunResult = detailed
    ? stunRaw
    : {
        ...stunRaw,
        reflexiveIp: stunRaw.reflexiveIp ? redactIp(stunRaw.reflexiveIp) : undefined,
      };

  const hasTurn = cfg.turnServers.length > 0;
  const relay: DiagnosticsReport['relay'] = hasTurn
    ? { available: true, mode: 'turn', configuredTurnServers: cfg.turnServers.length }
    : signaling.connected
      ? { available: true, mode: 'e2ee_signaling_relay', configuredTurnServers: 0 }
      : { available: false, mode: 'unavailable', configuredTurnServers: 0 };

  let natSummary = 'Local-only / UDP restricted';
  if (stun.reachable) {
    natSummary = 'UDP STUN reachable (NAT traversal available)';
  } else if (hasNonInternal) {
    natSummary = 'LAN reachable; external UDP STUN blocked or offline (encrypted relay fallback ready)';
  }

  let firewallWarning: string | null = null;
  if (!stun.reachable && !directP2P.listenerAvailable) {
    firewallWarning = 'Local firewall restricts inbound sockets and outbound UDP STUN. Connections will use encrypted relay fallback.';
  } else if (!stun.reachable) {
    firewallWarning = 'Outbound UDP STUN did not respond. Cross-network direct P2P may fall back to encrypted relay.';
  }

  const status: DiagnosticsReport['status'] = signaling.connected
    ? directP2P.listenerAvailable || stun.reachable
      ? 'Ready'
      : 'Degraded'
    : 'Offline';

  return {
    timestamp: Date.now(),
    termlinkVersion: TERMLINK_VERSION,
    nodeVersion: process.version,
    platform: `${detectPlatform()} (${os.type()})`,
    osRelease: os.release(),
    arch: os.arch(),
    interfaces,
    localConnectivity: hasNonInternal || interfaces.length > 0,
    signaling,
    stun,
    directP2P,
    relay,
    natSummary,
    firewallWarning,
    status,
  };
}

export function formatDiagnosticsText(report: DiagnosticsReport, detailed: boolean = false): string {
  const lines: string[] = [
    'TERMLINK DIAGNOSTICS',
    '',
    `TermLink:   v${report.termlinkVersion}`,
    `Platform:   ${report.platform} ${report.osRelease} (${report.arch})`,
    `Node:       ${report.nodeVersion}`,
    `Local Net:  ${report.localConnectivity ? 'Connected' : 'Unavailable'}`,
    '',
    `Signaling:  ${report.signaling.connected ? `Connected (${report.signaling.rttMs}ms)` : `Disconnected (${report.signaling.error || 'unreachable'})`}`,
    `STUN:       ${report.stun.reachable ? `Successful (${report.stun.rttMs ?? 0}ms${detailed && report.stun.reflexiveIp ? `, ${report.stun.reflexiveIp}:${report.stun.reflexivePort}` : ''})` : `Unavailable (${report.stun.error || 'no response'})`}`,
    `Direct P2P: ${report.directP2P.listenerAvailable ? `Available${detailed && report.directP2P.ephemeralPort ? ` (ephemeral port ${report.directP2P.ephemeralPort})` : ''}` : 'Restricted'}`,
    `Relay:      ${report.relay.available ? (report.relay.mode === 'turn' ? `Available (TURN, ${report.relay.configuredTurnServers} configured)` : 'Available (E2EE Relay Fallback)') : 'Unavailable'}`,
    `NAT Info:   ${report.natSummary}`,
  ];

  if (report.firewallWarning) {
    lines.push(`Firewall:   ${report.firewallWarning}`);
  }

  if (detailed && report.interfaces.length > 0) {
    lines.push('', 'Network Interfaces (detailed):');
    for (const iface of report.interfaces) {
      lines.push(`  - ${iface.name}: ${iface.address} (${iface.internal ? 'loopback' : 'routable'})`);
    }
  }

  lines.push('', `Status:     ${report.status}`);
  return lines.join('\n');
}
