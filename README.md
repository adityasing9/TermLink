# TermLink

**Connect terminals. Share files. Collaborate directly.**

TermLink is a cross-platform, peer-to-peer **terminal collaboration npm package** (`termlink`) for Windows, Linux, macOS, physical machines, cloud VMs, VMware, VirtualBox, and WSL2.

Open a terminal, run `termlink`, get a **2-digit room code (`00`–`99`)** and invite link, approve joining peers by cryptographic fingerprint, chat in real time, transfer files directly with chunked SHA-256 verification, propose commands safely, and optionally share terminal sessions with per-peer permissions.

---

## Installation & Quick Start

### Install from npm (once published)

```bash
npm install -g termlink
termlink
```

Or run directly with `npx`:

```bash
npx termlink
```

### Run from Source (Local Build)

```bash
npm install
npm run build
```

Start a local or self-hosted signaling server in Terminal 1:

```bash
npm run signaling
# or globally after install: termlink server
```

**Computer A (Host) in Terminal 2:**

```bash
npm run cli -- create --name "DEV TEAM"
# or globally: termlink create --name "DEV TEAM"
```

**Computer B (Join via 2-digit code) in Terminal 3:**

```bash
npm run cli -- 47
# or globally: termlink 47
```

**Or join via invitation link:**

```bash
termlink join https://YOUR-DOMAIN/join/47
termlink join https://YOUR-DOMAIN/invite/SECURE-TOKEN
```

---

## Core Features

- **2-Digit Quick Connect (`00`–`99`)**: Dynamic discovery codes with host approval by default, sliding-window rate limiting, short TTL, code rotation, and safe multi-room collision disambiguation.
- **Secure Invitation Links**: Configurable `/join/<code>` and cryptographically random `/invite/<token>` links with role scoping, expiration, one-time use, and revocation.
- **End-to-End Encrypted Group Rooms**: Full mesh for 2–8 peers (`N × (N - 1) / 2`) and selective hybrid topology for 9–20 peers. Uses Ed25519 signing, X25519 key exchange, and AES-256-GCM encryption.
- **Real P2P Transport + Honest Relay Fallback**: Direct TCP P2P with RFC 5389 UDP STUN probing and opaque E2EE relay fallback. Accurately reports `Direct P2P`, `Local network`, `VPN`, `Relayed`, `Connecting`, or `Disconnected`.
- **Chunked Streaming File Transfer**: Streaming I/O with 64 KiB chunks, per-chunk and full-file SHA-256 verification, backpressure, pause/resume/cancel, explicit recipient approval, path traversal protection, and conflict-free destination naming.
- **Opt-In Remote Terminal Sharing**: Disabled by default. Requires explicit host activation, per-peer `read-only` or `interactive` permissions, session locking, instant revocation, and local audit records.
- **Safe Command Proposals**: Send commands for peer review (`Accept` / `Edit` / `Reject`) with dangerous-command warnings (`rm -rf`, `curl | sh`, `mkfs`, `dd`). Never auto-executed.
- **Role-Based Permissions**: `Owner`, `Admin`, `Collaborator`, `Viewer`, and `Guest`.

---

## CLI Command Reference

```bash
termlink                           # Interactive terminal menu
termlink 47                        # Quick-join room 47
termlink create                    # Create room & display 2-digit code
termlink host                      # Alias for create
termlink join 47                   # Join by 2-digit code
termlink join <URL>                # Join by /join/NN or /invite/TOKEN link
termlink room create               # Create room
termlink room lookup 47            # Inspect public candidates for code 47
termlink chat 47                   # Join room 47 and open group chat
termlink send <file> --code 47 --group
termlink send <file> --code 47 --to RAHUL-LAPTOP
termlink receive 47                # Join room 47 ready to approve incoming files
termlink session share             # Explicitly start host-controlled terminal share
termlink server [--port 3000]      # Run a self-hosted signaling server
termlink diagnostics [--detailed] [--json]
termlink config                    # Show local configuration
termlink config set <key> <value>  # Update config key
termlink config reset              # Restore defaults
termlink devices                   # Show local cryptographic identity & trusted peers
termlink trust revoke <id>         # Revoke device trust
termlink status                    # Check local node & signaling status
termlink version                   # Print TermLink version
```

Inside an active room session:

```text
/members · /status · /msg <peer> <text> · /send <file> · /approve <reqId>
/reject <reqId> · /accept-file <id> · /propose <peer> <cmd> · /invite
/rotate · /share-term · /stop-term · /clear · /help · /leave
```

---

## Repository Architecture

```text
termlink/
├── apps/
│   ├── cli/                 # Cross-platform TermLink terminal CLI
│   └── signaling-server/    # Lightweight WebSocket signaling & opaque E2EE relay
├── packages/
│   ├── core/                # Types, config validator, path/command security
│   ├── identity/            # Ed25519 + X25519 + AES-256-GCM & local trust store
│   ├── protocol/            # Wire schemas, join parser, peer-assist manifest
│   ├── permissions/         # RBAC permission engine (Owner -> Guest)
│   ├── room-engine/         # 2-digit codes, collisions, invites, rate limits
│   ├── file-transfer/       # Streaming chunked sender/receiver + SHA-256
│   ├── terminal-session/    # Cross-platform shell adapter, RBAC & audit log
│   ├── networking/          # Topology manager, RFC 5389 STUN, Direct TCP E2EE
│   ├── diagnostics/         # Signaling, STUN, socket & interface diagnostics
│   └── sdk/                 # Public TypeScript Developer SDK
├── dist/                    # Compiled standalone CLI binary, server, & SDK (.mjs + .d.ts)
├── scripts/build.mjs        # esbuild + tsc package compiler
├── tests/                   # Unit, multi-peer, multi-process CLI, and security tests
├── docs/                    # Architecture, VMware/VM, SDK, troubleshooting docs
└── .github/workflows/       # Cross-platform CI (Windows/Ubuntu/macOS) & Release
```

---

## Verification & Testing

```bash
npm run build        # Compile standalone CLI binary, server, and SDK into dist/
npm run lint         # TypeScript type-checking
npm test             # Unit + multi-peer + compiled CLI process + security tests
npm run pack:check   # Validate npm package tarball (npm pack --dry-run)
```

## Documentation

- [Architecture & Protocol](docs/architecture.md)
- [Networking, Self-Hosting, TURN & VMware/VirtualBox Guide](docs/networking-and-vms.md)
- [Developer SDK & npm Publishing Guide](docs/sdk-and-cli.md)
- [Troubleshooting & Platform Notes](docs/troubleshooting.md)
- [Security & Threat Model](SECURITY.md)

## License

MIT — see [LICENSE](LICENSE).
