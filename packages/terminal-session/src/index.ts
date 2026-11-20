import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import {
  TermLinkError,
  type PeerRole,
  type TerminalAccessMode,
} from '../../core/src/index';

export interface ShellSelection {
  command: string;
  args: string[];
  label: string;
  platform: NodeJS.Platform;
  ptyBacked: boolean;
}

export interface TerminalAuditEntry {
  timestamp: number;
  sessionId: string;
  event:
    | 'session_started'
    | 'session_stopped'
    | 'session_locked'
    | 'session_unlocked'
    | 'permission_changed'
    | 'input_accepted'
    | 'input_rejected';
  peerId: string;
  peerName: string;
  detail: string;
}

/**
 * Cross-platform shell selector.
 * Never assumes Bash exists on Windows or PowerShell exists on Linux.
 */
export function resolvePlatformShell(platform: NodeJS.Platform = process.platform): ShellSelection {
  if (platform === 'win32') {
    const pwsh = process.env.COMSPEC?.toLowerCase().includes('pwsh') ? process.env.COMSPEC : 'powershell.exe';
    return {
      command: pwsh,
      args: ['-NoLogo', '-NoExit'],
      label: 'PowerShell',
      platform,
      ptyBacked: false,
    };
  }

  const preferredShell =
    process.env.SHELL && fs.existsSync(process.env.SHELL)
      ? process.env.SHELL
      : fs.existsSync('/bin/bash')
        ? '/bin/bash'
        : fs.existsSync('/bin/zsh')
          ? '/bin/zsh'
          : '/bin/sh';

  const shellLabel = preferredShell.split('/').pop() || 'sh';
  return {
    command: preferredShell,
    args: ['-i'],
    label: shellLabel,
    platform,
    ptyBacked: false,
  };
}

export interface SharedTerminalSnapshot {
  sessionId: string;
  sessionName: string;
  ownerPeerId: string;
  ownerName: string;
  active: boolean;
  locked: boolean;
  shell: string;
  startedAt: number;
  permissions: Record<string, TerminalAccessMode>;
  auditLog: TerminalAuditEntry[];
}

/**
 * Host-controlled shared terminal session.
 * Disabled until explicitly started by the host.
 * Enforces per-peer read-only / interactive / disabled permissions and instant revocation.
 */
export class SharedTerminalSession extends EventEmitter {
  public readonly sessionId: string;
  public readonly sessionName: string;
  public readonly ownerPeerId: string;
  public readonly ownerName: string;
  public readonly shellInfo: ShellSelection;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private active = false;
  private locked = false;
  private seq = 0;
  private startedAt = 0;
  private readonly permissions = new Map<string, TerminalAccessMode>();
  private readonly auditLog: TerminalAuditEntry[] = [];

  constructor(params: {
    sessionName: string;
    ownerPeerId: string;
    ownerName: string;
    cwd?: string;
  }) {
    super();
    this.sessionId = `term_${crypto.randomBytes(6).toString('hex')}`;
    this.sessionName = params.sessionName.trim().slice(0, 48) || 'shared-terminal';
    this.ownerPeerId = params.ownerPeerId;
    this.ownerName = params.ownerName;
    this.shellInfo = resolvePlatformShell();
    this.permissions.set(params.ownerPeerId, 'interactive');
  }

  start(cwd: string = process.cwd()): void {
    if (this.active) return;

    const proc = spawn(this.shellInfo.command, this.shellInfo.args, {
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        TERMLINK_SHARED_SESSION: this.sessionId,
      },
      stdio: 'pipe',
    });

    this.proc = proc;
    this.active = true;
    this.startedAt = Date.now();

    this.recordAudit('session_started', this.ownerPeerId, this.ownerName, `Shell: ${this.shellInfo.command}`);

    const emitData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.seq += 1;
      this.emit('output', {
        sessionId: this.sessionId,
        data: text,
        seq: this.seq,
        timestamp: Date.now(),
      });
    };

    proc.stdout.on('data', emitData);
    proc.stderr.on('data', emitData);
    proc.on('exit', (code, signal) => {
      this.active = false;
      this.proc = null;
      this.recordAudit(
        'session_stopped',
        this.ownerPeerId,
        this.ownerName,
        `Exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`
      );
      this.emit('exit', { sessionId: this.sessionId, code, signal });
    });
  }

  setPeerAccess(peerId: string, peerName: string, role: PeerRole, access: TerminalAccessMode): void {
    if (peerId === this.ownerPeerId) return;
    if ((role === 'guest' || role === 'viewer') && access === 'interactive') {
      throw new TermLinkError('FORBIDDEN', `Role "${role}" cannot receive interactive terminal access.`);
    }
    this.permissions.set(peerId, access);
    this.recordAudit('permission_changed', peerId, peerName, `Access set to ${access}`);
  }

  revokePeer(peerId: string, peerName: string): void {
    this.permissions.set(peerId, 'disabled');
    this.recordAudit('permission_changed', peerId, peerName, 'Access revoked immediately');
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.recordAudit(
      locked ? 'session_locked' : 'session_unlocked',
      this.ownerPeerId,
      this.ownerName,
      locked ? 'Interactive input locked for all remote peers' : 'Session unlocked'
    );
  }

  canPeerView(peerId: string): boolean {
    if (peerId === this.ownerPeerId) return true;
    const mode = this.permissions.get(peerId) ?? 'disabled';
    return mode === 'read-only' || mode === 'interactive';
  }

  canPeerInteract(peerId: string): boolean {
    if (!this.active) return false;
    if (peerId === this.ownerPeerId) return true;
    if (this.locked) return false;
    return this.permissions.get(peerId) === 'interactive';
  }

  writeInput(peerId: string, peerName: string, input: string): boolean {
    if (!this.active || !this.proc) {
      this.recordAudit('input_rejected', peerId, peerName, 'Session inactive');
      return false;
    }

    if (!this.canPeerInteract(peerId)) {
      this.recordAudit(
        'input_rejected',
        peerId,
        peerName,
        this.locked ? 'Session is locked' : 'Peer lacks interactive permission'
      );
      return false;
    }

    // Limit single input burst to 4096 bytes for safety
    const safeInput = input.slice(0, 4096);
    this.proc.stdin.write(safeInput);
    this.recordAudit(
      'input_accepted',
      peerId,
      peerName,
      `Wrote ${safeInput.length} bytes: ${JSON.stringify(safeInput.trim()).slice(0, 80)}`
    );
    return true;
  }

  stop(): void {
    if (!this.active || !this.proc) return;
    this.active = false;
    const proc = this.proc;
    this.proc = null;
    try {
      proc.stdin.end();
      proc.kill('SIGTERM');
      // Interactive shells (e.g. bash -i) ignore SIGTERM on Unix; ensure immediate termination
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 100);
      killTimer.unref?.();
      if (process.platform === 'win32' && proc.pid) {
        try {
          execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          // ignore
        }
      } else {
        proc.kill('SIGKILL');
      }
    } catch {
      // ignore if already dead
    }
    this.recordAudit('session_stopped', this.ownerPeerId, this.ownerName, 'Terminated by host');
  }

  getSnapshot(): SharedTerminalSnapshot {
    const perms: Record<string, TerminalAccessMode> = {};
    for (const [k, v] of this.permissions.entries()) {
      perms[k] = v;
    }
    return {
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      ownerPeerId: this.ownerPeerId,
      ownerName: this.ownerName,
      active: this.active,
      locked: this.locked,
      shell: this.shellInfo.label,
      startedAt: this.startedAt,
      permissions: perms,
      auditLog: this.auditLog.slice(-100),
    };
  }

  private recordAudit(
    event: TerminalAuditEntry['event'],
    peerId: string,
    peerName: string,
    detail: string
  ): void {
    this.auditLog.push({
      timestamp: Date.now(),
      sessionId: this.sessionId,
      event,
      peerId,
      peerName,
      detail,
    });
    if (this.auditLog.length > 500) {
      this.auditLog.splice(0, this.auditLog.length - 500);
    }
  }
}
