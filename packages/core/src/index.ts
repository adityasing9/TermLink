import path from 'node:path';

export const TERMLINK_VERSION = '1.0.8';
export const PROTOCOL_VERSION = '1.0';

export type PeerRole = 'owner' | 'admin' | 'collaborator' | 'viewer' | 'guest';

export type ConnectionMode =
  | 'direct_p2p'
  | 'local_network'
  | 'vpn'
  | 'relayed'
  | 'connecting'
  | 'disconnected';

export type TerminalAccessMode = 'disabled' | 'read-only' | 'interactive';

export type PlatformKind = 'windows' | 'linux' | 'macos' | 'browser' | 'unknown';

export interface PeerPublicIdentity {
  deviceId: string;
  deviceName: string;
  platform: PlatformKind;
  osDetail: string;
  signingPublicKey: string; // base64url SPKI Ed25519
  dhPublicKey: string; // base64url SPKI X25519
  fingerprint: string; // formatted hex pairs e.g. A2:9F:81:7B:...
}

export interface RoomMember {
  peerId: string;
  identity: PeerPublicIdentity;
  role: PeerRole;
  connectionMode: ConnectionMode;
  joinedAt: number;
  trusted: boolean;
  terminalAccess: TerminalAccessMode;
  latencyMs?: number;
}

export interface TurnServerConfig {
  urls: string;
  username?: string;
  credential?: string;
}

export interface TermLinkConfig {
  deviceName: string;
  signalingServer: string;
  publicBaseUrl: string;
  stunServers: string[];
  turnServers: TurnServerConfig[];
  defaultRoomMode: 'quick' | 'private';
  requireHostApproval: boolean;
  maxPeers: number;
  fileTransferDirectory: string;
  autoAcceptFiles: boolean;
  terminalSharingEnabled: boolean;
  telemetryEnabled: boolean;
  roomCodeTtlMs: number;
  maxFileSizeBytes: number;
}

export const DEFAULT_CONFIG: TermLinkConfig = {
  deviceName: 'TERMLINK-NODE',
  signalingServer: 'wss://termlink-x5qx.onrender.com/ws',
  publicBaseUrl: 'https://termlink-x5qx.onrender.com',
  stunServers: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  turnServers: [],
  defaultRoomMode: 'quick',
  requireHostApproval: false,
  maxPeers: 8,
  fileTransferDirectory: './downloads',
  autoAcceptFiles: false,
  terminalSharingEnabled: false,
  telemetryEnabled: false,
  roomCodeTtlMs: 30 * 60 * 1000, // 30 minutes
  maxFileSizeBytes: 2 * 1024 * 1024 * 1024, // 2 GiB safety limit
};

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  config: TermLinkConfig;
}

export function validateConfig(input: Partial<TermLinkConfig>): ConfigValidationResult {
  const errors: string[] = [];
  const merged: TermLinkConfig = {
    ...DEFAULT_CONFIG,
    ...input,
  };

  if (typeof merged.deviceName !== 'string' || merged.deviceName.trim().length < 1) {
    errors.push('deviceName must be a non-empty string.');
  } else {
    merged.deviceName = merged.deviceName.trim().replace(/[\r\n\t]/g, '').slice(0, 64);
  }

  if (typeof merged.signalingServer !== 'string' || !/^wss?:\/\/[^\s]+$/i.test(merged.signalingServer)) {
    errors.push('signalingServer must be a valid ws:// or wss:// URL.');
  }

  if (typeof merged.publicBaseUrl !== 'string' || !/^https?:\/\/[^\s]+$/i.test(merged.publicBaseUrl)) {
    errors.push('publicBaseUrl must be a valid http:// or https:// URL.');
  }

  if (!Array.isArray(merged.stunServers) || merged.stunServers.some((s) => typeof s !== 'string' || !/^stuns?:/i.test(s))) {
    errors.push('stunServers must be an array of valid stun: or stuns: URIs.');
  }

  if (!Array.isArray(merged.turnServers)) {
    errors.push('turnServers must be an array.');
  } else {
    for (const turn of merged.turnServers) {
      if (!turn || typeof turn.urls !== 'string' || !/^turns?:/i.test(turn.urls)) {
        errors.push('Each turnServer entry must include a valid turn: or turns: URL.');
      }
    }
  }

  if (merged.defaultRoomMode !== 'quick' && merged.defaultRoomMode !== 'private') {
    errors.push('defaultRoomMode must be "quick" or "private".');
  }

  if (typeof merged.maxPeers !== 'number' || !Number.isInteger(merged.maxPeers) || merged.maxPeers < 2 || merged.maxPeers > 20) {
    errors.push('maxPeers must be an integer between 2 and 20.');
  }

  if (typeof merged.roomCodeTtlMs !== 'number' || merged.roomCodeTtlMs < 60_000 || merged.roomCodeTtlMs > 24 * 60 * 60 * 1000) {
    errors.push('roomCodeTtlMs must be between 60,000ms (1 min) and 86,400,000ms (24 hours).');
  }

  if (typeof merged.fileTransferDirectory !== 'string' || merged.fileTransferDirectory.trim().length === 0) {
    errors.push('fileTransferDirectory must be a non-empty path.');
  }

  // Security invariants: never silently force unsafe defaults
  merged.requireHostApproval = Boolean(merged.requireHostApproval);
  merged.autoAcceptFiles = Boolean(merged.autoAcceptFiles);
  merged.terminalSharingEnabled = Boolean(merged.terminalSharingEnabled);
  merged.telemetryEnabled = Boolean(merged.telemetryEnabled);

  return {
    valid: errors.length === 0,
    errors,
    config: merged,
  };
}

/**
 * Sanitizes an incoming filename to prevent path traversal, null-byte injection,
 * Windows reserved device names, and hidden directory escapes.
 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeFilename(rawName: string): { safe: boolean; filename: string; reason?: string } {
  if (typeof rawName !== 'string' || rawName.length === 0) {
    return { safe: false, filename: '', reason: 'Filename is empty.' };
  }

  if (rawName.includes('\0')) {
    return { safe: false, filename: '', reason: 'Filename contains null byte.' };
  }

  if (rawName.includes('..') || rawName.includes('/') || rawName.includes('\\')) {
    return { safe: false, filename: '', reason: 'Path traversal or directory separator detected in filename.' };
  }

  const trimmed = rawName.trim();
  if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') {
    return { safe: false, filename: '', reason: 'Filename resolves to relative directory.' };
  }

  if (trimmed.length > 255) {
    return { safe: false, filename: '', reason: 'Filename exceeds 255 characters.' };
  }

  if (WINDOWS_RESERVED_NAMES.test(trimmed)) {
    return { safe: false, filename: '', reason: 'Filename matches reserved Windows device name.' };
  }

  // Strip ASCII control chars
  const cleaned = trimmed.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_');
  if (cleaned !== trimmed) {
    return { safe: false, filename: cleaned, reason: 'Filename contains unsafe control or filesystem characters.' };
  }

  return { safe: true, filename: cleaned };
}

/**
 * Ensures resolved destination path stays strictly inside the base directory.
 */
export function resolveSafeDownloadPath(baseDir: string, rawFilename: string): string {
  const check = sanitizeFilename(rawFilename);
  if (!check.safe) {
    throw new TermLinkError('INVALID_FILENAME', check.reason || 'Unsafe filename rejected.');
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, check.filename);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TermLinkError('PATH_TRAVERSAL', 'Resolved path escapes download directory.');
  }
  return resolvedTarget;
}

export interface CommandRiskAssessment {
  dangerous: boolean;
  severity: 'safe' | 'caution' | 'high';
  reasons: string[];
}

const DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; severity: 'caution' | 'high'; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--force)\b/i, severity: 'high', reason: 'Recursive forced file deletion (rm -rf).' },
  { pattern: /\b(mkfs|fdisk|parted|format\s+[a-z]:|diskpart)\b/i, severity: 'high', reason: 'Disk formatting or partition modification command.' },
  { pattern: /\bdd\s+if=/i, severity: 'high', reason: 'Low-level block device write (dd).' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|pwsh|powershell)\b/i, severity: 'high', reason: 'Piping remote content directly into a shell interpreter.' },
  { pattern: /\b(chmod|chown)\s+(-R\s+)?(777|000)\b/i, severity: 'high', reason: 'Overly permissive or destructive filesystem permission change.' },
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/i, severity: 'high', reason: 'System shutdown or reboot command.' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, severity: 'high', reason: 'Fork bomb pattern detected.' },
  { pattern: /\b(sudo|su\s+-|runas|Start-Process\s+.*-Verb\s+RunAs)\b/i, severity: 'caution', reason: 'Elevated privilege execution requested.' },
  { pattern: /\b(del\s+\/[sqf]|rmdir\s+\/s|Remove-Item\s+.*-Recurse)\b/i, severity: 'high', reason: 'Recursive Windows file deletion.' },
  { pattern: /\b(nc|ncat|netcat)\s+.*-e\b|\/dev\/tcp\//i, severity: 'high', reason: 'Potential reverse shell pattern.' },
];

export function assessCommandRisk(command: string): CommandRiskAssessment {
  const reasons: string[] = [];
  let severity: 'safe' | 'caution' | 'high' = 'safe';

  for (const rule of DANGEROUS_COMMAND_PATTERNS) {
    if (rule.pattern.test(command)) {
      reasons.push(rule.reason);
      if (rule.severity === 'high') {
        severity = 'high';
      } else if (severity === 'safe') {
        severity = 'caution';
      }
    }
  }

  return {
    dangerous: severity !== 'safe',
    severity,
    reasons,
  };
}

export class TermLinkError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TermLinkError';
    this.code = code;
    this.details = details;
  }
}

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export class Logger {
  private level: LogLevel;
  private readonly scope: string;

  constructor(scope: string, level: LogLevel = 'info') {
    this.scope = scope;
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private emit(level: Exclude<LogLevel, 'silent'>, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) return;
    const ts = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${ts}] [${level.toUpperCase()}] [${this.scope}] ${message}${metaStr}`;
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit('error', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit('warn', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.emit('info', message, meta);
  }
  debug(message: string, meta?: Record<string, unknown>): void {
    this.emit('debug', message, meta);
  }
}

export function detectPlatform(nodePlatform: string = typeof process !== 'undefined' ? process.platform : 'browser'): PlatformKind {
  if (nodePlatform === 'win32') return 'windows';
  if (nodePlatform === 'darwin') return 'macos';
  if (nodePlatform === 'linux') return 'linux';
  if (nodePlatform === 'browser') return 'browser';
  return 'unknown';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let unitIdx = 0;
  while (val >= 1024 && unitIdx < units.length - 1) {
    val /= 1024;
    unitIdx++;
  }
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[unitIdx]}`;
}

export function formatConnectionMode(mode: ConnectionMode): string {
  switch (mode) {
    case 'direct_p2p':
      return 'Direct P2P';
    case 'local_network':
      return 'Local network';
    case 'vpn':
      return 'VPN';
    case 'relayed':
      return 'Relayed';
    case 'connecting':
      return 'Connecting';
    case 'disconnected':
      return 'Disconnected';
  }
}
