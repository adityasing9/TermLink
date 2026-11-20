# TermLink (`@2we/tl`)

> **Connect terminals. Share files. Collaborate directly. Peer-to-peer.**

[![npm version](https://img.shields.io/npm/v/@2we/tl.svg?color=cb3837)](https://www.npmjs.com/package/@2we/tl)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node: >=20.0.0](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Platform: Windows | Linux | macOS](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-blue.svg)]()
[![Tests: 14/14 Passing](https://img.shields.io/badge/tests-14%2F14%20passing-success.svg)]()

TermLink is a production-grade, cross-platform, peer-to-peer **terminal collaboration CLI and SDK**. It enables developers, sysadmins, and DevOps engineers to instantly link terminals across **Windows, Linux, macOS, cloud VMs, WSL2, VMware, and VirtualBox** — without requiring browser dashboards, SaaS accounts, port forwarding, or complex SSH tunnel configurations.

With TermLink, you can create a temporary room with a memorable **2-digit quick-connect code (`00`–`99`)**, verify peers with cryptographic fingerprints, chat end-to-end encrypted, transfer gigabyte-sized files with chunked SHA-256 integrity verification, propose shell commands safely, and optionally share host-controlled terminal sessions with per-peer read-only or interactive permissions.

---

## Table of Contents

- [🚀 Quick Setup & Connect (For Normal Users)](#-quick-setup--connect-for-normal-users)
- [Why TermLink?](#why-termlink)
- [How It Works (Architecture)](#how-it-works-architecture)
- [Advanced Usage & Self-Hosting](#advanced-usage--self-hosting)
- [Core Features Deep Dive](#core-features-deep-dive)
  - [1. 2-Digit Quick-Connect Codes & Secure Invites](#1-2-digit-quick-connect-codes--secure-invites)
  - [2. End-to-End Cryptographic Security & Real P2P](#2-end-to-end-cryptographic-security--real-p2p)
  - [3. Streaming Chunked File Transfer (SHA-256)](#3-streaming-chunked-file-transfer-sha-256)
  - [4. Host-Controlled Shared Terminal Sessions](#4-host-controlled-shared-terminal-sessions)
  - [5. Safe Command Proposals (No Auto-Exec)](#5-safe-command-proposals-no-auto-exec)
  - [6. Device Identity & Trust Store](#6-device-identity--trust-store)
  - [7. Network Diagnostics & Honest Reporting](#7-network-diagnostics--honest-reporting)
- [Complete CLI Command Reference](#complete-cli-command-reference)
  - [Interactive Menu](#interactive-menu)
  - [Quick-Join Shortcut](#quick-join-shortcut)
  - [`termlink create` / `termlink host`](#termlink-create--termlink-host)
  - [`termlink join <target>`](#termlink-join-target)
  - [`termlink chat <code>`](#termlink-chat-code)
  - [`termlink send <file>`](#termlink-send-file)
  - [`termlink receive <code>`](#termlink-receive-code)
  - [`termlink session share`](#termlink-session-share)
  - [`termlink server`](#termlink-server)
  - [`termlink room`](#termlink-room)
  - [`termlink diagnostics`](#termlink-diagnostics)
  - [`termlink config`](#termlink-config)
  - [`termlink devices` / `termlink peers`](#termlink-devices--termlink-peers)
  - [`termlink trust`](#termlink-trust)
  - [`termlink status`](#termlink-status)
  - [`termlink version`](#termlink-version)
- [In-Session Slash Commands](#in-session-slash-commands)
- [Developer SDK](#developer-sdk)
- [Self-Hosting & Docker Deployment](#self-hosting--docker-deployment)
- [VMware, VirtualBox & Cross-OS Topologies](#vmware-virtualbox--cross-os-topologies)
- [Verification & Automated Tests](#verification--automated-tests)
- [License & Security](#license--security)

---

## Why TermLink?

| Feature | Standard SSH / tmux / tmate | Traditional Chat / Slack | **TermLink** |
|---|---|---|---|
| **Form Factor** | Shell / Terminal | GUI / Browser / Electron | **Pure Terminal Native CLI** |
| **Setup Overhead** | Requires public IP, authorized_keys, open port 22 | Account signup, web workspace | **Zero setup: run `termlink`** |
| **Room Discovery** | Long IPs, dynamic DNS, or SSH links | Workspace invite link | **2-Digit Code (`47`) or invite link** |
| **Security Model** | Host opens full shell or bastion | Server holds plaintext/logs | **E2EE (Ed25519 + X25519 + AES-GCM)** |
| **Host Control** | Peer often gets full user privileges | File upload / copy-paste | **Host approval required; read-only default** |
| **File Transfer** | `scp` / `rsync` outside session | Cloud attachment limits | **Integrated P2P stream with SHA-256** |
| **Command Review** | Blind terminal execution | Paste block | **Structured proposal (Accept/Reject)** |

---

## How It Works (Architecture)

```
                            ┌─────────────────────────────────┐
                            │    TermLink Signaling Server    │
                            │   (WebSocket / Discovery / Relay)│
                            └────────────────┬────────────────┘
                                             │
                       WebSocket (WSS)       │       WebSocket (WSS)
                 ┌───────────────────────────┴───────────────────────────┐
                 ▼                                                       ▼
      ┌─────────────────────┐                                 ┌─────────────────────┐
      │   Node A (Host)     │                                 │   Node B (Client)   │
      │  termlink create    │◄═══════════════════════════════►│     termlink 47     │
      └──────────┬──────────┘   Direct TCP Socket / P2P Mesh  └──────────┬──────────┘
                 │            (RFC 5389 UDP STUN Discovery)              │
                 │            (Fallback: Opaque E2EE Relay)              │
                 │                                                       │
                 ├───────────────────────────────────────────────────────┤
                 │ • E2EE Chat & Private Messages (/msg)                 │
                 │ • Chunked P2P File Streaming (64 KiB chunks, SHA-256) │
                 │ • Host-Controlled Remote Shell (PowerShell / Bash)    │
                 │ • Safe Command Proposals (Non-auto-executing)         │
                 └───────────────────────────────────────────────────────┘
```

1. **Signaling & Handshake**: The host requests a 2-digit room code from the signaling server. The client enters the code (`termlink 47`).
2. **Host Approval**: The host terminal receives an alert displaying the requester's device name, OS, and cryptographic fingerprint. The host runs `/approve` to grant entry.
3. **P2P Direct Connection**: Both peers exchange candidate network endpoints (LAN IPs, VPN adapters, public IP discovered via RFC 5389 UDP STUN) and establish a direct TCP connection.
4. **Opaque E2EE Fallback**: If strict NAT or enterprise firewall rules prevent direct connection, traffic routes seamlessly through the signaling server as opaque ciphertext. The server cannot inspect or tamper with any payload.

---

## 🚀 Quick Setup & Connect (For Normal Users)

> **Zero configuration required!** TermLink comes out-of-the-box connected to a 24/7 cloud signaling server (`wss://termlink-x5qx.onrender.com/ws`).
> You and your peers do **not** need to set up servers, configure firewalls, or touch any settings. Just run the command and connect!

```text
┌─────────────────────────────────────────┐         ┌─────────────────────────────────────────┐
│            Computer A (Host)            │         │           Computer B (Friend)           │
│                                         │         │                                         │
│  1. Create room:                        │         │  1. Join using the 2-digit code:        │
│     npx @2we/tl create                  │         │     npx @2we/tl 47                      │
│                                         │         │                                         │
│  2. Room Code appears: 47               │         │  2. Instantly connected!                │
│                                         │         │                                         │
│  3. Connected!                          │ ◄═════► │  3. E2EE Chat, P2P Files & Terminal     │
└─────────────────────────────────────────┘         └─────────────────────────────────────────┘
```

---

### Step 1: Computer A creates the room
Open your terminal (PowerShell, Command Prompt, macOS Terminal, or Linux bash) and run:

```bash
npx @2we/tl create
```
*(Tip: Or install globally with `npm install -g @2we/tl` so you can simply type `tl create`)*.

TermLink will display your room information and a **2-digit room code**:
```text
══════════════════════════════════════════════════════════════
  ROOM CREATED: ADITYA-PC Room
  Room Code:    47
  Join Link:    https://termlink-x5qx.onrender.com/join/47
══════════════════════════════════════════════════════════════
Waiting for peers to join...
termlink[47]>
```
Share the 2-digit code (e.g. `47`) with your friend!

---

### Step 2: Computer B joins using the code
Your friend opens their terminal on their computer (anywhere in the world) and runs:

```bash
npx @2we/tl 47
```
*(Replace `47` with your actual room code. Or install globally with `npm install -g @2we/tl` and run `tl 47`)*.

---

### Step 3: Instantly Connected!
**Boom! No approval needed!**
Both terminals are immediately connected in real-time with end-to-end encryption!
Computer A's terminal will announce:
```text
● RAHUL-LAPTOP joined (collaborator)
```
And Computer B's terminal enters the room immediately!

---

### What you can do inside the room:

* 💬 **Chat**: Just type your message and press Enter.
* 🔒 **Private Message**: Send a private message only one person can read:
  ```text
  /msg RAHUL-LAPTOP Hey, check this secret key
  ```
* 📁 **Send Files (with SHA-256 Checksum)**:
  ```text
  /send ./archive.zip
  ```
  *(Your peer will see a prompt and run `/accept-file` to receive it).*
* 🛡️ **Propose Shell Commands (Safe Review)**:
  ```text
  /propose RAHUL-LAPTOP docker compose up -d
  ```
  *(Your peer can inspect and `/accept-cmd` without fear of auto-execution).*
* 💻 **Share Terminal (Host Opt-In)**:
  ```text
  /share-term
  ```
  *(Spawns a host PowerShell/Bash subshell; remote peers enter in read-only mode by default).*
* 🚪 **Leave the room**:
  ```text
  /leave
  ```

---

## 🛠️ Advanced Usage & Self-Hosting

### Permanent Global Installation
To avoid typing `npx @2we/tl` every time, install it globally once:
```bash
npm install -g @2we/tl
```
Now you can use the ultra-fast `tl` command from any terminal:
```bash
tl create        # Create room (auto-starts local server if offline)
tl 47            # Join room 47
tl diagnostics   # Test your network & P2P capability
tl status        # Check connection to 24/7 signaling server
```

### Self-Hosting a Private Signaling Server
If your company or team requires a private, isolated signaling network:
1. Run locally on your machine or private LAN:
   ```bash
   tl server --port 3000
   ```
2. Or deploy via Docker with the included [Dockerfile](Dockerfile) or [fly.toml](fly.toml) to your own cloud instance.
3. Switch your CLI to your custom private server:
   ```bash
   tl config set signalingServer wss://your-private-domain.com/ws
   ```
   *(To revert back to the public 24/7 server anytime: `tl config reset`)*.

### Running from Source (Local Git Repository)
```bash
git clone https://github.com/adityasing9/TermLink.git
cd TermLink
npm install
npm run build
npm test
```

---

## Core Features Deep Dive

### 1. 2-Digit Quick-Connect Codes & Secure Invites
- **Memorable 2-Digit Codes (`00`–`99`)**: Designed for quick verbal communication in team calls or standups.
- **Collision Disambiguation**: If two hosts generate the same 2-digit code on the same server, joining peers are presented with an interactive disambiguation menu showing host names, platforms, and fingerprints.
- **TTL Expiration**: Codes expire automatically after 30 minutes (configurable from 1 min to 24 hours).
- **Rate-Limiting**: Sliding-window rate limiter blocks brute-force enumeration attacks.
- **Code Rotation**: Host can execute `/rotate` inside an active room to immediately invalidate the old code and issue a fresh one.
- **Secret Invite URLs**: Generate cryptographically random `/invite/<token>` links with role scoping (e.g., `viewer`, `collaborator`) and single-use expiration.

### 2. End-to-End Cryptographic Security & Real P2P
- **Identity Keypairs**: Every node creates an **Ed25519** keypair for cryptographic signatures and an **X25519** keypair for Diffie-Hellman key agreement.
- **Session Keys**: Derived using **HKDF-SHA256** with domain separation (`termlink-e2ee-v1`).
- **Authenticated Encryption**: All messages, file chunks, and terminal streams are encrypted using **AES-256-GCM** with random 96-bit IVs and 128-bit authentication tags.
- **Tamper Resistance**: Payload envelopes include sender/recipient bindings and Ed25519 digital signatures. Any tampered byte or spoofed sender is immediately rejected.
- **Mesh Topology**: 2–8 peers operate in a full mesh topology ($N \times (N-1)/2$). Rooms with 9–20 peers automatically transition to a hybrid selective forwarding topology to preserve bandwidth.

### 3. Streaming Chunked File Transfer (SHA-256)
- **Zero Memory Bottlenecks**: Transfers files in 64 KiB chunks via Node.js streaming pipelines.
- **Integrity Verification**: Verifies both per-chunk checksums and whole-file SHA-256 digests.
- **Recipient Consent**: Incoming files are held until the recipient explicitly accepts (`/accept-file <id>`) or rejects (`/reject-file <id>`).
- **Path Traversal Guards**: Filenames are sanitized to prevent directory traversal (`../`), null-byte injection, hidden files, and Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
- **Safe Staging**: Files are streamed into `.part` temporary files and renamed only after full SHA-256 verification. If a file with the same name exists, TermLink creates a conflict-free non-overwriting destination path (`file (1).ext`).

### 4. Host-Controlled Shared Terminal Sessions
- **Opt-In & Disabled by Default**: Terminal sharing cannot run unless explicitly started by the host with `termlink session share` or `/share-term`.
- **Platform-Native Shell Selection**:
  - **Windows**: Automatically selects `powershell.exe` (or `pwsh.exe`).
  - **Linux / macOS**: Resolves `$SHELL`, `/bin/bash`, `/bin/zsh`, or `/bin/sh`.
- **Role-Based Access Control (RBAC)**: Remote peers enter the session in `disabled` mode. The host explicitly elevates peers to `read-only` (view terminal output only) or `interactive` (send keystrokes).
- **Session Locking & Instant Kill**:
  - The host can lock the session instantly, muting all remote inputs.
  - Revoking access or running `/stop-term` terminates the underlying subshell process immediately (using `SIGKILL` on POSIX and tree-kill `taskkill /T /F` on Windows).
- **Audit Trail**: Every keystroke, command, and permission change is recorded in an in-memory audit log.

### 5. Safe Command Proposals (No Auto-Exec)
- Send commands for peer review using `/propose <peer> <command>`.
- **Never Auto-Executed**: The receiving peer sees the command, its author, and an automated risk assessment.
- **High-Risk Detection**: Flags dangerous patterns including `rm -rf`, destructive drive formatting (`mkfs`, `dd`), pipe-to-shell scripts (`curl | sh`, `wget | bash`), and privilege escalation attempts (`chmod -R 777`).
- The recipient can accept, edit, or reject the proposal safely.

### 6. Device Identity & Trust Store
- TermLink stores local identity keys in `~/.termlink/identity.json` with strict POSIX permissions (`0o600`).
- Generates a human-verifiable 32-character hex fingerprint:
  ```text
  Fingerprint: 7B:3F:8A:1C:E4:90:D2:A5:6B:19:40:FE:83:52:66:C9
  ```
- Manage device trust across your team with `termlink devices` and `termlink trust revoke <id>`.

### 7. Network Diagnostics & Honest Reporting
- Built-in diagnostic engine (`termlink diagnostics`) tests:
  - Local network interfaces & active default gateways
  - Signaling server WebSocket reachability and roundtrip latency
  - RFC 5389 UDP STUN public IP/port mapping discovery
  - P2P direct socket binding availability
- Honest transport reporting in the status bar:
  - `Direct P2P` (Direct TCP over LAN/Internet)
  - `Local network` (Same subnet)
  - `VPN` (WireGuard / Tailscale / OpenVPN)
  - `Relayed` (Encrypted relay via signaling server)
  - `Connecting` / `Disconnected`

---

## Complete CLI Command Reference

> **Tip**: You can use either the short alias `tl` or the full command `termlink` interchangeably for every command below (e.g. `tl create`, `tl 47`, `tl diagnostics`, `tl chat 47`).

### Interactive Menu
Running `tl` (or `termlink`) without arguments opens an interactive navigation menu:
```bash
tl
# or: termlink
```
```text
  ════════════════════════════════════════════════════════
    TERMLINK — TERMINAL COLLABORATION
  ════════════════════════════════════════════════════════

  1. Create a room
  2. Join a room
  3. Trusted devices
  4. Network diagnostics
  5. Settings
  6. Exit

  Select an option [1-6]:
```

---

### Quick-Join Shortcut
Join any active room immediately by specifying its 2-digit code:
```bash
termlink 47
```

---

### `termlink create` / `termlink host`
Create a new collaboration room and generate a 2-digit discovery code.

```bash
termlink create [options]
termlink host [options]
```

#### Options:
- `-n, --name <name>`: Custom room name (default: `<DeviceName> Room`).
- `--no-approval`: Disables host approval; allows anyone with the code to enter immediately.
- `-p, --password <password>`: Set an optional room password (scrypt-hashed).
- `--code <code>`: Request a preferred 2-digit code (`00`–`99`).
- `-s, --signaling <url>`: Override the signaling server WebSocket URL for this session.
- `--non-interactive`: Output room metadata in JSON format and exit (ideal for automation scripts).

#### Examples:
```bash
# Host room with default settings
termlink create

# Host with custom name and password
termlink create --name "Devops Standup" --password "super-secret"

# Request specific 2-digit code
termlink create --code 88

# Automation script: get JSON output
termlink create --non-interactive
```

---

### `termlink join <target>`
Join a room using a 2-digit code, a `/join/NN` URL, or a secure `/invite/<token>` link.

```bash
termlink join <target> [options]
```

#### Options:
- `-p, --password <password>`: Provide the room password if required.
- `-s, --signaling <url>`: Override the signaling server URL.
- `--non-interactive`: Validate room connection and exit without opening interactive prompt.

#### Examples:
```bash
# Join by 2-digit code
termlink join 47

# Join with password
termlink join 47 -p "my-password"

# Join via invitation URL
termlink join https://termlink.example.com/join/47
termlink join https://termlink.example.com/invite/4f8b2a1c9e3d0f7a
```

---

### `termlink chat <code>`
Shortcut to join a room by 2-digit code and directly enter group chat mode:
```bash
termlink chat 47
```

---

### `termlink send <file>`
Send a file directly to an active room or a specific peer.

```bash
termlink send <file> [options]
```

#### Options:
- `--code <code>`: The 2-digit room code to connect to before sending.
- `--group`: Broadcast file offer to all peers in the room.
- `--to <peer>`: Send file exclusively to a specific peer name or device ID.

#### Examples:
```bash
# Send archive to everyone in room 47
termlink send ./release.tar.gz --code 47 --group

# Send database dump to specific peer
termlink send ./backup.sql --code 47 --to "RAHUL-LAPTOP"
```

---

### `termlink receive <code>`
Join a room in receiver mode, ready to interactively accept and download incoming files:
```bash
termlink receive 47
```

---

### `termlink session share`
Create a room and start an explicit host-controlled shared shell session.

```bash
termlink session share [options]
```

#### Options:
- `-n, --name <name>`: Session identifier (default: `shared-shell`).

#### Example:
```bash
termlink session share --name "Production Debug"
```

---

### `termlink server`
Launch a self-hosted TermLink signaling server on this machine:

```bash
termlink server [options]
```

#### Options:
- `-p, --port <port>`: Port to listen on (default: `3000` or `$PORT`).
- `--public-url <url>`: Publicly accessible base URL used when constructing invitation links.

#### Example:
```bash
termlink server --port 8080 --public-url https://termlink.mycompany.internal
```

---

### `termlink room`
Manage room lifecycle and inspect public room codes.

```bash
# Create room
termlink room create --name "Frontend Team"

# Lookup rooms matching a 2-digit code
termlink room lookup 47
```

---

### `termlink diagnostics`
Run a comprehensive diagnostic sweep on network interfaces, gateway routes, STUN bindings, and signaling reachability.

```bash
termlink diagnostics [options]
```

#### Options:
- `-d, --detailed`: Show full, unredacted local IP addresses and ports.
- `-s, --signaling <url>`: Test reachability against a specific signaling server.
- `--json`: Format the entire diagnostic report as JSON.

#### Example Output:
```text
=== TermLink Network Diagnostics ===
Status: Ready
Timestamp: 2026-11-20T14:40:00.000Z

Signaling:
  Server:  ws://localhost:3000/ws
  Status:  Connected (12ms latency)

Network Interfaces:
  - Wi-Fi (192.168.1.xxx) [Default Gateway: Reachable]

NAT & STUN Probing:
  - STUN Server: stun:stun.l.google.com:19302 (Reachable)
  - Public Endpoint: 203.0.113.42:54210
  - NAT Mapping: Endpoint-Independent

Direct P2P Capability:
  - TCP Listener: Available
  - Recommended Mode: Direct P2P
```

---

### `termlink config`
Inspect and customize your local TermLink configuration.

```bash
# View active configuration
termlink config

# Change signaling server
termlink config set signalingServer wss://termlink.example.com/ws

# Change default download folder
termlink config set fileTransferDirectory ~/Downloads/TermLink

# Change default device name
termlink config set deviceName "ADITYA-WORKSTATION"

# Reset all settings to factory defaults
termlink config reset
```

---

### `termlink devices` / `termlink peers`
Inspect your local cryptographic identity and list known/trusted peer devices:

```bash
termlink devices
```
```text
Local Device: ADITYA-PC (win32)
Device ID:    a8f10bc492e7d3
Fingerprint:  3A:5B:9C:12:F4:7E:88:21:09:44:6D:FE:1A:3C:55:B2

Known Devices (2):
  - RAHUL-LAPTOP       trusted    A1:B2:C3:D4:E5:F6:01:02:03:04:05:06:07:08:09:0A
  - UBUNTU-SERVER      trusted    F9:E8:D7:C6:B5:A4:10:20:30:40:50:60:70:80:90:00
```

---

### `termlink trust`
Manage device trust records:

```bash
# List all device records
termlink trust list

# Revoke a compromised or retired device by ID or Fingerprint
termlink trust revoke A1:B2:C3:D4:E5:F6:01:02:03:04:05:06:07:08:09:0A

# Reset your local cryptographic identity and generate a fresh keypair
termlink trust reset-identity
```

---

### `termlink status`
Quick check of local node status, identity fingerprint, and signaling health:
```bash
termlink status
```

---

### `termlink version`
Display the installed TermLink version:
```bash
termlink version
# termlink v1.0.0
```

---

## In-Session Slash Commands

When inside an active room session prompt (`termlink[47]> `), the following commands are available:

| Command | Arguments | Description |
|---|---|---|
| `/members` | None | List all peers in the room, their roles, platforms, fingerprints, and transport type. |
| `/status` | None | Show current room code, uptime, connection mode, and transfer statistics. |
| `/msg` | `<peer> <text>` | Send an end-to-end encrypted private message to a specific peer. |
| `/send` | `<file> [peer]` | Initiate a streaming file transfer to the entire room or a specific peer. |
| `/accept-file` | `[transferId]` | Accept an incoming file offer and begin downloading. |
| `/reject-file` | `[transferId]` | Decline an incoming file offer. |
| `/approve` | `[requestId]` | **(Host only)** Approve an incoming peer's join request. |
| `/reject` | `[requestId]` | **(Host only)** Reject an incoming peer's join request. |
| `/propose` | `<peer> <cmd>` | Propose a command for peer review. Will never auto-execute. |
| `/accept-cmd` | `[proposalId]` | Mark an incoming command proposal as accepted. |
| `/reject-cmd` | `[proposalId]` | Decline a command proposal. |
| `/invite` | None | Generate a fresh, role-scoped, expiring invitation link. |
| `/rotate` | None | **(Host only)** Rotate the 2-digit room code immediately. |
| `/share-term` | None | **(Host only)** Spawn a host-controlled shared shell session. |
| `/stop-term` | None | **(Host only)** Terminate the active shared shell session. |
| `/clear` | None | Clear the terminal screen. |
| `/help` | None | Print in-session help and command usage. |
| `/leave` | None | Disconnect from the room and return to your terminal prompt. |

---

## Developer SDK

You can embed TermLink directly into your own Node.js or TypeScript applications:

```typescript
import { TermLink } from '@2we/tl';

async function main() {
  const client = new TermLink({
    deviceName: 'MY-AUTOMATION-BOT',
    signalingServer: 'wss://termlink.example.com/ws',
  });

  await client.initialize();

  // Create room
  const room = await client.createRoom({
    roomName: 'Automated CI Room',
    requireHostApproval: false,
  });

  console.log(`Room created with code: ${room.code}`);

  // Listen for messages
  room.on('message', (msg) => {
    console.log(`[${msg.senderName}]: ${msg.text}`);
  });

  // Listen for incoming file transfers
  room.on('fileOffer', (offer) => {
    console.log(`Incoming file: ${offer.filename} (${offer.sizeBytes} bytes)`);
    offer.accept('./downloads');
  });

  room.on('fileComplete', (ev) => {
    console.log(`File saved to ${ev.savedPath} (Verified SHA-256: ${ev.verified})`);
  });

  // Send a broadcast message
  await room.sendMessage('CI build completed successfully!');
}

main().catch(console.error);
```

---

## Self-Hosting & Docker Deployment

### 1. Run via Docker
Build and start the container in one command:

```bash
docker build -t termlink-server .
docker run -d -p 3000:3000 -e PORT=3000 --name termlink-signaling termlink-server
```

### 2. Deploy to Cloud Run / Railway / Render / Fly.io
Deploy this repository directly to your cloud provider.
- **Port**: Set `PORT=3000` (or leave default on platforms that inject `$PORT`).
- **Public URL**: Set `TERMLINK_PUBLIC_BASE_URL=https://your-app.railway.app`.
- **Health Check Path**: `/health` (returns `200 OK` with JSON stats).

---

## VMware, VirtualBox & Cross-OS Topologies

TermLink is engineered to handle challenging virtualization networking topologies:

- **Scenario A: Host to Guest VM (Host-Only Network)**
  - Direct P2P connects over the virtual adapter (`vmnet1` / `vboxnet0`).
- **Scenario B: Two VMs on Different Physical Machines (Bridged Mode)**
  - Peers discover LAN IPs and establish direct TCP connections over the physical network.
- **Scenario C: Both VMs Behind NAT on Different Hosts**
  - TermLink detects NAT mapping via STUN. If NAT punch-through is blocked, it automatically activates the **Opaque E2EE Relay** through the signaling server.
- **Scenario D: Host Machine to WSL2 Instance**
  - Connects across the internal Windows hypervisor virtual switch interface.

For full architectural blueprints, see [docs/networking-and-vms.md](docs/networking-and-vms.md).

---

## Verification & Automated Tests

TermLink has a test suite covering cryptography, network protocol, file transfer integrity, and multi-process execution:

```bash
# Run all tests (unit, security, multi-peer integration, CLI processes)
npm test

# Run unit tests only
npm run test:unit

# Run security tests only
npm run test:security

# TypeScript type-checking
npm run lint

# Validate npm package contents (npm pack --dry-run)
npm run pack:check
```

---

## License & Security

- **License**: [MIT](LICENSE)
- **Security Policy**: See [SECURITY.md](SECURITY.md) for vulnerability disclosure guidelines and cryptographic threat model.
