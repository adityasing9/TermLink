import chalk from 'chalk';
import { formatBytes, formatConnectionMode, type RoomMember } from '../../../packages/core/src/index';
import type { RoomInfo } from '../../../packages/protocol/src/index';

const supportsUnicode =
  process.platform !== 'win32' ||
  Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode' || process.env.ConEmuTask);

export function renderBanner(subtitle: string = 'P2P COLLABORATION'): string {
  if (!supportsUnicode) {
    return [
      '+============================================+',
      '|                  TERMLINK                  |',
      `|              ${subtitle.padEnd(28)}  |`,
      '+============================================+',
    ].join('\n');
  }
  return [
    chalk.cyan('╔════════════════════════════════════════════╗'),
    chalk.cyan('║') + chalk.bold.white('                  TERMLINK                  ') + chalk.cyan('║'),
    chalk.cyan('║') + chalk.gray(`             ${subtitle.padEnd(29)}  `) + chalk.cyan('║'),
    chalk.cyan('╚════════════════════════════════════════════╝'),
  ].join('\n');
}

export function renderRoomCreated(room: RoomInfo): string {
  const lines = [
    '',
    renderBanner('P2P COLLABORATION'),
    '',
    chalk.green('Room created successfully!'),
    '',
    chalk.dim('ROOM CODE'),
    '',
    `                  ${chalk.bold.bgGreen.black(` ${room.code} `)}`,
    '',
    'Join from another terminal:',
    '',
    `    ${chalk.cyan(`termlink ${room.code}`)}`,
    '',
    'Invite link:',
    '',
    `    ${chalk.underline(room.joinUrl)}`,
    '',
    `Room: ${chalk.bold(room.roomName)} | Approval: ${room.requireHostApproval ? 'Required' : 'Open'}`,
    `Status: ${room.members.length > 1 ? chalk.green('Connected') : chalk.yellow('Waiting for peers...')}`,
    `Connected members: ${room.members.length}/${room.maxPeers}`,
    '',
  ];
  return lines.join('\n');
}

export function renderMemberList(room: RoomInfo): string {
  const bullet = supportsUnicode ? '●' : '*';
  const rows = room.members.map((m: RoomMember) => {
    const roleLabel = m.role === 'owner' ? chalk.yellow('Host') : chalk.white(m.role);
    const modeLabel = chalk.dim(formatConnectionMode(m.connectionMode));
    const nameCol = m.identity.deviceName.padEnd(18);
    return `  ${chalk.green(bullet)} ${chalk.bold(nameCol)} ${roleLabel.padEnd(18)} ${modeLabel}`;
  });
  return [
    '',
    `Room: ${chalk.bold(room.roomName)}   Code: ${chalk.bold.cyan(room.code)}`,
    `Connected peers: ${room.members.length}/${room.maxPeers}`,
    '',
    ...rows,
    '',
  ].join('\n');
}

export function renderProgressBar(percent: number, width: number = 24): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  const fullChar = supportsUnicode ? '█' : '#';
  const emptyChar = supportsUnicode ? '░' : '-';
  return `[${chalk.green(fullChar.repeat(filled))}${chalk.dim(emptyChar.repeat(width - filled))}] ${String(clamped).padStart(3)}%`;
}

export function renderFileOfferPrompt(offer: {
  filename: string;
  size: number;
  senderName: string;
  sha256: string;
}): string {
  return [
    '',
    chalk.bold.yellow('Incoming file'),
    `Filename: ${offer.filename}`,
    `Size:     ${formatBytes(offer.size)}`,
    `Sender:   ${offer.senderName}`,
    `SHA-256:  ${offer.sha256.slice(0, 16)}...`,
    '',
  ].join('\n');
}
