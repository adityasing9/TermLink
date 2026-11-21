import net from 'node:net';
import readline from 'node:readline';
import type http from 'node:http';
import chalk from 'chalk';
import { Command } from 'commander';
import {
  TERMLINK_VERSION,
  formatBytes,
  formatConnectionMode,
} from '../../../packages/core/src/index';
import { formatDiagnosticsText, runDiagnostics } from '../../../packages/diagnostics/src/index';
import { IdentityStore } from '../../../packages/identity/src/index';
import { isValidTwoDigitCode } from '../../../packages/protocol/src/index';
import { TermLink, type IncomingCommandProposal, type IncomingFileOffer, type RoomSession } from '../../../packages/sdk/src/index';
import { ConfigManager } from './config';
import {
  renderBanner,
  renderFileOfferPrompt,
  renderMemberList,
  renderProgressBar,
  renderRoomCreated,
} from './ui';

const configManager = new ConfigManager();
const identityStore = new IdentityStore();

function createPromptInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (ans) => resolve(ans.trim())));
}

function setLocalDeviceName(newName: string): { oldName: string; newName: string; fingerprint: string } {
  const cleanName = newName.trim().slice(0, 64);
  if (!cleanName) {
    throw new Error('Device name cannot be empty.');
  }
  const current = configManager.load();
  const oldName = current.deviceName;
  configManager.setKey('deviceName', cleanName);
  const updated = identityStore.renameDevice(cleanName);
  return {
    oldName,
    newName: cleanName,
    fingerprint: updated.publicIdentity.fingerprint,
  };
}

async function runInteractiveSession(client: TermLink, session: RoomSession): Promise<void> {
  const rl = createPromptInterface();
  const pendingOffers = new Map<string, IncomingFileOffer>();
  const pendingProposals = new Map<string, IncomingCommandProposal>();
  const pendingJoinReqs = new Map<string, { requestId: string; deviceName: string; fingerprint: string }>();

  const promptLine = () => {
    rl.setPrompt(chalk.cyan(`termlink[${session.code}]> `));
    rl.prompt();
  };

  session.on('joinRequest', (req) => {
    pendingJoinReqs.set(req.requestId, {
      requestId: req.requestId,
      deviceName: req.identity.deviceName,
      fingerprint: req.identity.fingerprint,
    });
    console.log('');
    console.log(chalk.yellow('Incoming peer join request:'));
    console.log(`  Name:        ${req.identity.deviceName}`);
    console.log(`  Platform:    ${req.identity.platform}`);
    console.log(`  Fingerprint: ${req.identity.fingerprint}`);
    console.log(`  Run ${chalk.green(`/approve ${req.requestId}`)} or ${chalk.red(`/reject ${req.requestId}`)}`);
    promptLine();
  });

  session.on('peerJoined', (member) => {
    console.log(`\n${chalk.green('●')} ${chalk.bold(member.identity.deviceName)} joined (${member.role})`);
    promptLine();
  });

  session.on('peerLeft', (ev) => {
    console.log(`\n${chalk.gray('○')} ${ev.deviceName} left (${ev.reason})`);
    promptLine();
  });

  session.on('message', (msg) => {
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    console.log(`\n[${chalk.dim(time)}] ${chalk.bold(msg.senderName)}: ${msg.text}`);
    promptLine();
  });

  session.on('privateMessage', (msg) => {
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    console.log(`\n[${chalk.dim(time)}] ${chalk.magenta(`[PM] ${msg.senderName}`)}: ${msg.text}`);
    promptLine();
  });

  session.on('fileOffer', (offer: IncomingFileOffer) => {
    pendingOffers.set(offer.transferId, offer);
    console.log(renderFileOfferPrompt(offer));
    console.log(`Run ${chalk.green(`/accept-file ${offer.transferId}`)} or ${chalk.red(`/reject-file ${offer.transferId}`)}`);
    promptLine();
  });

  session.on('fileProgress', (p) => {
    process.stdout.write(
      `\r${p.direction === 'send' ? 'Sending' : 'Receiving'} ${p.filename} ${renderProgressBar(p.percent)} (${formatBytes(p.speedBytesPerSec)}/s)`
    );
    if (p.percent >= 100) process.stdout.write('\n');
  });

  session.on('fileComplete', (ev) => {
    console.log(
      `\n${ev.verified ? chalk.green('File verified (SHA-256 OK)') : chalk.red('File verification FAILED')}: ${ev.savedPath || ev.transferId}`
    );
    promptLine();
  });

  session.on('commandProposal', (proposal: IncomingCommandProposal) => {
    pendingProposals.set(proposal.proposalId, proposal);
    console.log('');
    console.log(chalk.bold.yellow(`Command proposal from ${proposal.senderName}:`));
    console.log(`  ${chalk.white(proposal.command)}`);
    if (proposal.risk.dangerous) {
      console.log(chalk.red(`  WARNING (${proposal.risk.severity.toUpperCase()}): ${proposal.risk.reasons.join(' ')}`));
    }
    console.log(`  Review only — never auto-executed. Use /accept-cmd ${proposal.proposalId} or /reject-cmd ${proposal.proposalId}`);
    promptLine();
  });

  session.on('terminalOutput', (ev) => {
    process.stdout.write(ev.data);
  });

  session.on('roomClosed', (ev) => {
    console.log(`\n${chalk.red('Room closed:')} ${ev.reason}`);
    rl.close();
  });

  console.log(chalk.dim('Type a message to chat, or /help for commands.'));
  promptLine();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      promptLine();
      return;
    }

    try {
      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.split(' ');
        switch (cmd) {
          case '/help':
            console.log(
              [
                'Commands:',
                '  /members                     Show connected peers',
                '  /status                      Show room and connection status',
                '  /name <newName>              Change your device display name',
                '  /msg <peer> <text>           Send private E2EE message',
                '  /send <filePath>             Send file to group',
                '  /approve <reqId>             Approve pending peer',
                '  /reject <reqId>              Reject pending peer',
                '  /accept-file <transferId>    Accept incoming file transfer',
                '  /reject-file <transferId>    Reject incoming file transfer',
                '  /propose <peer> <cmd>        Propose command for peer review',
                '  /accept-cmd <id>             Mark proposed command accepted',
                '  /reject-cmd <id>             Reject proposed command',
                '  /invite                      Generate a secure invite link',
                '  /rotate                      Rotate 2-digit room code',
                '  /share-term                  Start opt-in shared terminal session',
                '  /stop-term                   Stop shared terminal session',
                '  /clear                       Clear terminal screen',
                '  /leave                       Leave room and exit',
              ].join('\n')
            );
            break;
          case '/members':
            console.log(renderMemberList(session.roomInfo));
            break;
          case '/status':
            console.log(
              `Room: ${session.roomInfo.roomName} | Code: ${session.code} | Members: ${session.members.length}/${session.roomInfo.maxPeers} | Topology: ${session.topology.getTopologySummary(session.members.length).mode}`
            );
            break;
          case '/name':
          case '/rename': {
            const newName = rest.join(' ').trim();
            if (!newName) {
              console.log(chalk.yellow(`Current device name: ${session.localDeviceName}. Usage: /name <newName>`));
            } else {
              session.renameDevice(newName);
              const updated = setLocalDeviceName(newName);
              console.log(chalk.green(`✔ Device display name updated to: ${chalk.bold(updated.newName)}`));
            }
            break;
          }
          case '/clear':
            console.clear();
            break;
          case '/msg': {
            const target = rest.shift();
            const text = rest.join(' ');
            if (!target || !text) {
              console.log(chalk.yellow('Usage: /msg <peerName> <message>'));
            } else {
              await session.sendPrivateMessage(target, text);
              console.log(chalk.dim(`Sent PM to ${target}`));
            }
            break;
          }
          case '/send': {
            const filePath = rest.join(' ');
            if (!filePath) {
              console.log(chalk.yellow('Usage: /send <path-to-file>'));
            } else {
              const id = await session.sendFile(filePath, { group: true });
              console.log(chalk.green(`File offer sent (${id}). Waiting for peer acceptance...`));
            }
            break;
          }
          case '/approve': {
            const reqId = rest[0] || Array.from(pendingJoinReqs.keys())[0];
            if (!reqId) {
              console.log(chalk.yellow('No pending join requests.'));
            } else {
              session.approveJoin(reqId);
              pendingJoinReqs.delete(reqId);
              console.log(chalk.green(`Approved ${reqId}`));
            }
            break;
          }
          case '/reject': {
            const reqId = rest[0] || Array.from(pendingJoinReqs.keys())[0];
            if (!reqId) {
              console.log(chalk.yellow('No pending join requests.'));
            } else {
              session.rejectJoin(reqId);
              pendingJoinReqs.delete(reqId);
              console.log(chalk.red(`Rejected ${reqId}`));
            }
            break;
          }
          case '/accept-file': {
            const tid = rest[0] || Array.from(pendingOffers.keys())[0];
            const offer = tid ? pendingOffers.get(tid) : undefined;
            if (!offer) {
              console.log(chalk.yellow('No matching pending file offer.'));
            } else {
              offer.accept();
              pendingOffers.delete(offer.transferId);
              console.log(chalk.green(`Accepted ${offer.filename}`));
            }
            break;
          }
          case '/reject-file': {
            const tid = rest[0] || Array.from(pendingOffers.keys())[0];
            const offer = tid ? pendingOffers.get(tid) : undefined;
            if (!offer) {
              console.log(chalk.yellow('No matching pending file offer.'));
            } else {
              offer.reject();
              pendingOffers.delete(offer.transferId);
              console.log(chalk.red(`Rejected ${offer.filename}`));
            }
            break;
          }
          case '/propose': {
            const target = rest.shift();
            const command = rest.join(' ');
            if (!target || !command) {
              console.log(chalk.yellow('Usage: /propose <peer> <command>'));
            } else {
              const id = session.proposeCommand(target, command);
              console.log(chalk.green(`Command proposal sent (${id}).`));
            }
            break;
          }
          case '/accept-cmd': {
            const id = rest[0] || Array.from(pendingProposals.keys())[0];
            const p = id ? pendingProposals.get(id) : undefined;
            if (p) {
              p.respond('accepted');
              pendingProposals.delete(p.proposalId);
              console.log(chalk.green(`Marked proposal "${p.command}" as accepted (run locally if desired).`));
            }
            break;
          }
          case '/reject-cmd': {
            const id = rest[0] || Array.from(pendingProposals.keys())[0];
            const p = id ? pendingProposals.get(id) : undefined;
            if (p) {
              p.respond('rejected');
              pendingProposals.delete(p.proposalId);
              console.log(chalk.red(`Rejected command proposal.`));
            }
            break;
          }
          case '/invite': {
            session.once('inviteCreated', (inv) => {
              console.log(`\nInvite link: ${chalk.underline(inv.url)} (role: ${inv.role})`);
              promptLine();
            });
            session.createInvite({ role: 'collaborator' });
            break;
          }
          case '/rotate':
            session.rotateCode();
            break;
          case '/share-term':
            session.startTerminalSession('shared-terminal');
            console.log(chalk.green('Shared terminal started (read-only by default; grant access explicitly).'));
            break;
          case '/stop-term':
            session.stopTerminalSession();
            console.log(chalk.yellow('Shared terminal stopped.'));
            break;
          case '/leave':
            session.leave();
            rl.close();
            return;
          default:
            console.log(chalk.yellow(`Unknown command: ${cmd}. Try /help`));
        }
      } else {
        await session.sendMessage(trimmed);
      }
    } catch (err) {
      console.log(chalk.red(`Error: ${(err as Error).message}`));
    }
    promptLine();
  });

  await new Promise<void>((resolve) => {
    rl.on('close', async () => {
      await client.disconnect();
      resolve();
    });
  });
}

async function ensureLocalServerIfConfigured(serverUrl: string): Promise<http.Server | null> {
  try {
    const url = new URL(serverUrl);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0';
    if (!isLocal) return null;

    const port = Number(url.port || 3000);

    const isRunning = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(300);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });

    if (isRunning) return null;

    const http = await import('node:http');
    const { TermLinkSignalingServer } = await import('../../signaling-server/src/index');

    const srv = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, autoSpawned: true, stats: sig.engine.getStats() }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('TermLink Auto-Signaling Server\n');
    });

    const sig = new TermLinkSignalingServer(srv, {
      publicBaseUrl: `http://localhost:${port}`,
      wsPath: url.pathname || '/ws',
    });

    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '0.0.0.0', () => resolve());
    });

    console.log(chalk.dim(`⚡ Auto-started local signaling server on ws://0.0.0.0:${port}${url.pathname || '/ws'}`));
    return srv;
  } catch {
    return null;
  }
}

async function handleCreateRoom(opts: { name?: string; approval?: boolean; password?: string; code?: string; maxPeers?: number; signaling?: string; nonInteractive?: boolean }): Promise<void> {
  const cfg = configManager.load();
  if (opts.signaling) cfg.signalingServer = opts.signaling;
  const autoServer = await ensureLocalServerIfConfigured(cfg.signalingServer);
  const client = new TermLink(cfg);

  try {
    await client.initialize();
    const room = await client.createRoom({
      roomName: (opts.name || `${cfg.deviceName} Room`).slice(0, 64),
      requireHostApproval: Boolean(opts.approval),
      password: opts.password,
      preferredCode: opts.code,
      maxPeers: opts.maxPeers ? Number(opts.maxPeers) : cfg.maxPeers,
    });

    if (opts.nonInteractive) {
      console.log(JSON.stringify({ roomId: room.roomId, code: room.code, joinUrl: room.joinUrl }));
      await client.disconnect();
      autoServer?.close();
      return;
    }

    console.log(renderRoomCreated(room.roomInfo));
    await runInteractiveSession(client, room);
  } finally {
    autoServer?.close();
  }
}

async function handleJoinRoom(target: string, opts: { password?: string; signaling?: string; nonInteractive?: boolean }): Promise<void> {
  const cfg = configManager.load();
  if (opts.signaling) cfg.signalingServer = opts.signaling;
  const client = new TermLink(cfg);
  await client.initialize();

  console.log(chalk.dim(`Connecting to ${cfg.signalingServer}...`));
  const session = await client.joinRoom(target, {
    password: opts.password,
    onPending: (info) => {
      console.log(chalk.yellow(`\nWaiting for host approval to join "${info.roomName}"`));
      console.log(`  Host:        ${info.hostName}`);
      console.log(`  Fingerprint: ${info.hostFingerprint}`);
    },
    onAmbiguous: async (candidates) => {
      console.log(chalk.yellow(`\nMultiple rooms found for code ${target}:`));
      candidates.forEach((c, idx) => {
        console.log(
          `  ${idx + 1}. ${c.roomName} — Host: ${c.hostName} (${c.hostPlatform}, ${c.hostFingerprintShort}...) [${c.memberCount}/${c.maxPeers}]`
        );
      });
      if (opts.nonInteractive) return null;
      const rl = createPromptInterface();
      const ans = await askQuestion(rl, 'Select room number (or empty to cancel): ');
      rl.close();
      const pick = Number(ans) - 1;
      return candidates[pick]?.roomId ?? null;
    },
  });

  console.log(chalk.green(`\nConnected to room "${session.roomInfo.roomName}" (Code ${session.code})!`));
  console.log(renderMemberList(session.roomInfo));

  if (opts.nonInteractive) {
    await client.disconnect();
    return;
  }

  await runInteractiveSession(client, session);
}

async function runMainMenu(): Promise<void> {
  const rl = createPromptInterface();
  const cfg = configManager.load();
  const self = identityStore.loadOrCreate(cfg.deviceName).publicIdentity;

  console.log('');
  console.log(renderBanner('TERMINAL COLLABORATION'));
  console.log(chalk.dim(`Device: ${chalk.bold(self.deviceName)} | Fingerprint: ${self.fingerprint.slice(0, 17)}...`));
  console.log('');
  console.log('1. Create a room (Host)');
  console.log('2. Join a room (Enter 2-digit code)');
  console.log(`3. Rename this device (Current: ${self.deviceName})`);
  console.log('4. Trusted devices');
  console.log('5. Network diagnostics');
  console.log('6. Settings & Config');
  console.log('7. Exit');
  console.log('');
  const choice = await askQuestion(rl, 'Select an option [1-7]: ');

  switch (choice) {
    case '1': {
      const codeInput = await askQuestion(rl, 'Custom 2-digit room code 00-99 (leave blank for random): ');
      let customCode: string | undefined = undefined;
      if (codeInput.trim()) {
        let clean = codeInput.trim();
        if (/^\d{1,2}$/.test(clean)) {
          clean = clean.padStart(2, '0');
        }
        if (isValidTwoDigitCode(clean)) {
          customCode = clean;
        } else {
          console.log(chalk.yellow(`Invalid 2-digit code "${codeInput}". A random code will be generated.`));
        }
      }
      const name = await askQuestion(rl, 'Room name (leave blank for default): ');
      rl.close();
      await handleCreateRoom({ name: name || undefined, code: customCode });
      break;
    }
    case '2': {
      const target = await askQuestion(rl, 'Enter 2-digit room code or invite link: ');
      rl.close();
      await handleJoinRoom(target, {});
      break;
    }
    case '3': {
      console.log(`\nCurrent device name: ${chalk.cyan.bold(self.deviceName)}`);
      const newName = await askQuestion(rl, 'Enter new device name (or press Enter to keep): ');
      rl.close();
      if (newName.trim()) {
        const res = setLocalDeviceName(newName.trim());
        console.log(chalk.green(`\n✔ Device name successfully updated to: ${chalk.bold(res.newName)}`));
        console.log(chalk.dim(`Fingerprint: ${res.fingerprint}\n`));
      } else {
        console.log('\nDevice name unchanged.\n');
      }
      break;
    }
    case '4': {
      rl.close();
      const devices = identityStore.listDevices();
      console.log(`\nLocal Identity: ${self.deviceName} (${self.platform})`);
      console.log(`Fingerprint:    ${self.fingerprint}\n`);
      if (devices.length === 0) {
        console.log('No trusted devices recorded yet.');
      } else {
        for (const d of devices) {
          console.log(`- ${d.deviceName} [${d.status}] ${d.fingerprint}`);
        }
      }
      break;
    }
    case '5': {
      rl.close();
      const report = await runDiagnostics({ config: configManager.load(), detailed: false });
      console.log('\n' + formatDiagnosticsText(report, false) + '\n');
      break;
    }
    case '6': {
      rl.close();
      console.log('\nCurrent Configuration (' + configManager.getPath() + '):');
      console.log(JSON.stringify(configManager.load(), null, 2));
      break;
    }
    default:
      rl.close();
      console.log('Goodbye.');
  }
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) {
    console.error(chalk.red(`\nTermLink requires Node.js >= 20.0.0 (you are running Node ${process.version}).`));
    console.error(chalk.yellow('\nTo install or update Node.js LTS:'));
    if (process.platform === 'win32') {
      console.error(chalk.cyan('  winget install OpenJS.NodeJS.LTS'));
    } else if (process.platform === 'darwin') {
      console.error(chalk.cyan('  brew install node'));
    } else {
      console.error(chalk.cyan('  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt install -y nodejs'));
    }
    console.error(chalk.yellow('  (IMPORTANT: Restart your terminal window after installing Node.js)\n'));
    process.exit(1);
  }

  const rawArgs = argv.slice(2);

  // Quick-join shortcut: `termlink 47`
  if (rawArgs.length === 1 && isValidTwoDigitCode(rawArgs[0])) {
    await handleJoinRoom(rawArgs[0], {});
    return;
  }

  // No arguments: launch interactive menu
  if (rawArgs.length === 0) {
    await runMainMenu();
    return;
  }

  const program = new Command();
  program
    .name('termlink')
    .description('Connect terminals. Share files. Collaborate directly.')
    .version(TERMLINK_VERSION);

  program
    .command('create [code]')
    .alias('host')
    .description('Create a new TermLink room with an optional custom 2-digit code (e.g. tl create 77)')
    .option('-c, --code <code>', 'Custom 2-digit room code (00-99)')
    .option('-n, --name <name>', 'Room name')
    .option('-m, --max-peers <number>', 'Maximum peer limit (2-50, default: 8)')
    .option('--approval', 'Require host approval for each peer (default: off)')
    .option('-p, --password <password>', 'Optional room password')
    .option('-s, --signaling <url>', 'Override signaling server WebSocket URL')
    .option('--non-interactive', 'Output room JSON and exit (for scripts)')
    .action(async (codeArg: string | undefined, opts) => {
      let chosenCode = opts.code || codeArg;
      if (chosenCode && /^\d{1,2}$/.test(chosenCode.trim())) {
        chosenCode = chosenCode.trim().padStart(2, '0');
      }
      if (chosenCode && !isValidTwoDigitCode(chosenCode)) {
        console.error(
          chalk.red(
            `Error: Custom room code must be 2 digits between 00 and 99 (received: "${codeArg || opts.code}").`
          )
        );
        process.exit(1);
      }
      await handleCreateRoom({
        name: opts.name,
        approval: opts.approval,
        password: opts.password,
        code: chosenCode,
        maxPeers: opts.maxPeers ? Number(opts.maxPeers) : undefined,
        signaling: opts.signaling,
        nonInteractive: opts.nonInteractive,
      });
    });

  program
    .command('name [newName]')
    .alias('rename')
    .description('View or set your device display name (e.g. tl name Alice-Laptop)')
    .action(async (newName?: string) => {
      const cfg = configManager.load();
      const current = identityStore.loadOrCreate(cfg.deviceName).publicIdentity.deviceName;
      if (newName && newName.trim()) {
        const res = setLocalDeviceName(newName.trim());
        console.log(chalk.green(`✔ Device name successfully updated to: ${chalk.bold(res.newName)}`));
        console.log(chalk.dim(`Fingerprint: ${res.fingerprint}`));
      } else {
        const rl = createPromptInterface();
        console.log(`Current device name: ${chalk.cyan.bold(current)}`);
        const answer = await askQuestion(rl, 'Enter new device name (or press Enter to keep): ');
        rl.close();
        if (answer.trim()) {
          const res = setLocalDeviceName(answer.trim());
          console.log(chalk.green(`✔ Device name successfully updated to: ${chalk.bold(res.newName)}`));
          console.log(chalk.dim(`Fingerprint: ${res.fingerprint}`));
        } else {
          console.log('Device name unchanged.');
        }
      }
    });

  program
    .command('join <target>')
    .description('Join a room by 2-digit code (e.g. 47) or invitation link')
    .option('-p, --password <password>', 'Room password if required')
    .option('-s, --signaling <url>', 'Override signaling server WebSocket URL for this session')
    .option('--non-interactive', 'Connect and exit without interactive prompt')
    .action(async (target: string, opts) => {
      await handleJoinRoom(target, { password: opts.password, signaling: opts.signaling, nonInteractive: opts.nonInteractive });
    });

  program
    .command('server')
    .description('Start a self-hosted TermLink signaling server on this machine')
    .option('-p, --port <port>', 'Port to listen on', '3000')
    .option('--public-url <url>', 'Public base URL for generated invite links')
    .action(async (opts) => {
      const http = await import('node:http');
      const { TermLinkSignalingServer } = await import('../../signaling-server/src/index');
      const port = Number(opts.port || 3000);
      const publicBaseUrl = (opts.publicUrl || `http://localhost:${port}`).replace(/\/$/, '');
      const srv = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, version: TERMLINK_VERSION, stats: sig.engine.getStats() }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`TermLink Signaling Server v${TERMLINK_VERSION}\n`);
      });
      const sig = new TermLinkSignalingServer(srv, { publicBaseUrl, wsPath: '/ws' });
      srv.listen(port, '0.0.0.0', () => {
        console.log(chalk.green(`TermLink Signaling Server listening on ws://0.0.0.0:${port}/ws`));
        console.log(chalk.dim(`Health check: http://localhost:${port}/health`));
      });
      await new Promise(() => {});
    });

  const roomCmd = program.command('room').description('Room lifecycle management');
  roomCmd
    .command('create [code]')
    .description('Create a new room with optional custom 2-digit code')
    .option('-c, --code <code>', 'Custom 2-digit room code (00-99)')
    .option('-n, --name <name>', 'Room name')
    .action(async (codeArg: string | undefined, opts) => {
      let chosenCode = opts.code || codeArg;
      if (chosenCode && /^\d{1,2}$/.test(chosenCode.trim())) {
        chosenCode = chosenCode.trim().padStart(2, '0');
      }
      if (chosenCode && !isValidTwoDigitCode(chosenCode)) {
        console.error(chalk.red(`Error: Custom room code must be 2 digits between 00 and 99.`));
        process.exit(1);
      }
      return handleCreateRoom({ name: opts.name, code: chosenCode });
    });
  roomCmd
    .command('lookup <code>')
    .description('Inspect public room candidates matching a 2-digit code')
    .action(async (code: string) => {
      const client = new TermLink(configManager.load());
      await client.initialize();
      const candidates = await client.lookupCode(code);
      if (candidates.length === 0) {
        console.log(`No active public rooms found for code ${code}.`);
      } else {
        for (const c of candidates) {
          console.log(`${c.code} | ${c.roomName} | Host: ${c.hostName} (${c.hostFingerprintShort}...) | ${c.memberCount}/${c.maxPeers}`);
        }
      }
      await client.disconnect();
    });

  program
    .command('chat <code>')
    .description('Join a room by 2-digit code and open interactive terminal chat')
    .action(async (code: string) => {
      await handleJoinRoom(code, {});
    });

  program
    .command('send <file>')
    .description('Send a file directly to a room or specific peer')
    .option('--code <code>', 'Room code to join before sending')
    .option('--group', 'Send to all connected peers in the room')
    .option('--to <peer>', 'Send to a specific peer name or ID')
    .action(async (file: string, opts) => {
      if (!opts.code) {
        console.log(chalk.yellow('Tip: Use /send <file> inside an active room, or pass --code <NN> to join and send.'));
        return;
      }
      const client = new TermLink(configManager.load());
      await client.initialize();
      const session = await client.joinRoom(opts.code, {});
      const tid = await session.sendFile(file, { group: opts.group, toPeer: opts.to });
      console.log(`File offer created (${tid}) for ${file}. Waiting for transfer completion...`);
      await new Promise<void>((resolve) => {
        session.once('fileComplete', (ev) => {
          console.log(ev.verified ? chalk.green('Transfer verified (SHA-256 OK).') : chalk.red('Transfer failed.'));
          resolve();
        });
      });
      await client.disconnect();
    });

  program
    .command('receive <code>')
    .description('Join a room to receive incoming files with interactive approval')
    .action(async (code: string) => {
      await handleJoinRoom(code, {});
    });

  const sessionCmd = program.command('session').description('Manage opt-in shared terminal sessions');
  sessionCmd
    .command('share')
    .description('Create a room and start an explicit host-controlled shared terminal session')
    .option('-n, --name <name>', 'Terminal session name', 'shared-shell')
    .action(async (opts) => {
      const cfg = configManager.load();
      const autoServer = await ensureLocalServerIfConfigured(cfg.signalingServer);
      const client = new TermLink(cfg);
      try {
        await client.initialize();
        const room = await client.createRoom({
          roomName: `${cfg.deviceName} Terminal`.slice(0, 64),
          requireHostApproval: true,
        });
        console.log(renderRoomCreated(room.roomInfo));
        room.startTerminalSession(opts.name);
        console.log(chalk.green(`Shared terminal "${opts.name}" started. Remote peers are Disabled until granted access.`));
        await runInteractiveSession(client, room);
      } finally {
        autoServer?.close();
      }
    });

  program
    .command('diagnostics')
    .description('Run real network, STUN, signaling, and P2P capability diagnostics')
    .option('-d, --detailed', 'Include unredacted local IP addresses and ports')
    .option('-s, --signaling <url>', 'Test a specific signaling server URL')
    .option('--json', 'Output diagnostics as JSON')
    .action(async (opts) => {
      const cfg = configManager.load();
      if (opts.signaling) cfg.signalingServer = opts.signaling;
      const report = await runDiagnostics({ config: cfg, detailed: Boolean(opts.detailed) });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log('\n' + formatDiagnosticsText(report, Boolean(opts.detailed)) + '\n');
      }
    });

  const cfgCmd = program.command('config').description('View or update local TermLink configuration');
  cfgCmd.action(() => {
    console.log(JSON.stringify(configManager.load(), null, 2));
  });
  cfgCmd
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action((key: string, value: string) => {
      const updated = configManager.setKey(key, value);
      console.log(chalk.green(`Updated ${key}.`));
      console.log(JSON.stringify(updated, null, 2));
    });
  cfgCmd
    .command('reset')
    .description('Reset configuration to defaults')
    .action(() => {
      const reset = configManager.reset();
      console.log(chalk.green('Configuration reset to defaults.'));
      console.log(JSON.stringify(reset, null, 2));
    });

  program
    .command('devices')
    .alias('peers')
    .description('Show local cryptographic identity and trusted devices')
    .action(() => {
      const self = identityStore.loadOrCreate().publicIdentity;
      console.log(`Local Device: ${self.deviceName} (${self.platform})`);
      console.log(`Device ID:    ${self.deviceId}`);
      console.log(`Fingerprint:  ${self.fingerprint}`);
      const devices = identityStore.listDevices();
      console.log(`\nKnown Devices (${devices.length}):`);
      for (const d of devices) {
        console.log(`  - ${d.deviceName.padEnd(18)} ${d.status.padEnd(10)} ${d.fingerprint}`);
      }
    });

  program
    .command('trust <action> [target]')
    .description('Manage device trust: list | revoke <id-or-fingerprint> | reset-identity')
    .action((action: string, target?: string) => {
      if (action === 'revoke' && target) {
        const ok = identityStore.revokeDevice(target);
        console.log(ok ? chalk.green(`Revoked ${target}`) : chalk.yellow(`No device matched ${target}`));
      } else if (action === 'reset-identity') {
        const fresh = identityStore.resetIdentity(configManager.load().deviceName);
        console.log(chalk.green(`Generated new cryptographic identity. Fingerprint: ${fresh.publicIdentity.fingerprint}`));
      } else {
        const devices = identityStore.listDevices();
        console.log(JSON.stringify(devices, null, 2));
      }
    });

  program
    .command('status')
    .description('Show local TermLink status and signaling health')
    .option('-s, --signaling <url>', 'Check a specific signaling server URL')
    .action(async (opts) => {
      const cfg = configManager.load();
      if (opts.signaling) cfg.signalingServer = opts.signaling;
      const self = identityStore.loadOrCreate(cfg.deviceName).publicIdentity;
      const report = await runDiagnostics({ config: cfg, detailed: false });
      console.log(`TermLink v${TERMLINK_VERSION} | Device: ${self.deviceName}`);
      console.log(`Fingerprint: ${self.fingerprint}`);
      console.log(`Signaling:   ${cfg.signalingServer} (${report.signaling.connected ? 'Connected' : 'Offline'})`);
      console.log(`Connection:  ${formatConnectionMode(report.directP2P.listenerAvailable ? 'direct_p2p' : 'relayed')}`);
    });

  program
    .command('version')
    .description('Print TermLink version')
    .action(() => {
      console.log(`termlink v${TERMLINK_VERSION}`);
    });

  await program.parseAsync(argv);
}

// Run when executed directly as a CLI binary (`termlink`, `tl`, `node dist/bin/termlink.mjs`, or `tsx apps/cli/src/index.ts`)
const invoked = (process.argv[1] || '').toLowerCase();
const isMain =
  !process.argv[1] ||
  invoked.includes('termlink') ||
  invoked.includes('tl') ||
  invoked.endsWith('.ts') ||
  invoked.endsWith('.js') ||
  invoked.endsWith('.mjs');

if (isMain) {
  runCli().catch((err) => {
    console.error(chalk.red(`\nTermLink Error: ${(err as Error).message}`));
    console.error(chalk.dim('\n💡 Quick troubleshooting & environment suggestions:'));
    if (process.platform === 'win32') {
      console.error(chalk.dim('  • Install/Update Node.js (LTS): ') + chalk.cyan('winget install OpenJS.NodeJS.LTS'));
    } else if (process.platform === 'darwin') {
      console.error(chalk.dim('  • Install/Update Node.js (LTS): ') + chalk.cyan('brew install node'));
    } else {
      console.error(chalk.dim('  • Install/Update Node.js (LTS): ') + chalk.cyan('curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt install -y nodejs'));
    }
    console.error(chalk.yellow('  • IMPORTANT: Always restart your terminal after installing Node.js so PATH updates!'));
    console.error(chalk.dim('  • Check network & signaling:   ') + chalk.cyan('tl diagnostics'));
    console.error(chalk.dim('  • Reset configuration:         ') + chalk.cyan('tl config reset\n'));
    process.exit(1);
  });
}
