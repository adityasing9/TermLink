# TermLink Architecture & Protocol

## Layered Modular Design

TermLink separates networking, protocol validation, security policy, terminal execution, and user interfaces into isolated workspace packages without circular dependencies:

1. `@termlink/core`: Shared TypeScript contracts, configuration validation, filename/path-traversal protection, command risk analysis, and structured logging.
2. `@termlink/permissions`: Pure RBAC engine governing `owner`, `admin`, `collaborator`, `viewer`, and `guest` privileges plus terminal interactive grants.
3. `@termlink/protocol`: Wire schemas, strict incoming frame validation (`256 KiB` control frame ceiling), join target parser (`47`, `/join/47`, `/invite/<token>`, `termlink://...`), and the future-ready `PeerAssistedManifest` module.
4. `@termlink/identity`: Local cryptographic keypair management (Ed25519 signatures + X25519 Diffie-Hellman + HKDF-SHA256 + AES-256-GCM), SHA-256 fingerprint formatting, and `0o600` local trust store.
5. `@termlink/room-engine`: Ephemeral 2-digit code allocator (`00`–`99`), collision resolution, scrypt password hashing, cryptographic invitation tokens (TTL, one-time, revocation), sliding-window anti-enumeration rate limiter, and reconnection tokens.
6. `@termlink/networking`: `TopologyManager` (`N*(N-1)/2` full mesh up to 8 peers, hybrid selective links for 9–20 peers), real RFC 5389 UDP STUN client (`node:dgram`), and `DirectP2PTransport` with transparent E2EE relay fallback.
7. `@termlink/file-transfer`: Streaming `fs.createReadStream` / `fs.createWriteStream` chunked transfer protocol (64 KiB chunks, per-chunk SHA-256, full-file SHA-256, backpressure ACKs, `.part` staging, conflict-free destination naming).
8. `@termlink/terminal-session`: Cross-platform shell abstraction (`powershell.exe` on Windows, `$SHELL`/`bash`/`zsh`/`sh` on Unix), disabled by default, per-peer access matrix, session lock, and audit logging.
9. `@termlink/diagnostics`: Real signaling RTT, UDP STUN binding test, TCP listener capability test, and privacy-respecting network interface inspection.
10. `@termlink/sdk`: Public event-driven developer API (`TermLink` + `RoomSession`).

## Transport & Encryption Flow

1. Peers connect to the lightweight signaling server (`ws://` or `wss://`) and send `hello` containing **only their public keys and fingerprint**.
2. Room discovery uses 2-digit codes or secure invite tokens. Host approval verifies peer fingerprints before issuing peer endpoints.
3. Peers exchange endpoints (Direct TCP for CLI/SDK, WebRTC SDP/ICE for browser peers) and establish direct peer-to-peer links whenever NAT/firewalls permit.
4. Every application message (chat, file offers/chunks, command proposals, terminal streams) is encrypted pairwise with AES-256-GCM and signed before transmission.
5. If direct connection fails, envelopes automatically fall back to the signaling server's opaque relay handler—and the UI explicitly labels the peer as `Relayed`.
