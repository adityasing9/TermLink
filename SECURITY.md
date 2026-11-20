# TermLink Security Policy & Threat Model

## Security Architecture

TermLink is designed with defense-in-depth for peer-to-peer terminal collaboration:

1. **Two-Digit Codes Are Discovery Only**: Codes (`00`–`99`) are ephemeral discovery identifiers—never encryption keys and never authentication credentials.
2. **Host Approval by Default**: Joining via a 2-digit code enters a host approval queue displaying the joining peer's device name, platform, and SHA-256 public key fingerprint.
3. **End-to-End Encryption (E2EE)**:
   - Node.js CLI/SDK peers generate local Ed25519 signing keys + X25519 Diffie-Hellman keys stored locally with `0o600` permissions. Private keys are never transmitted.
   - Peer payloads (chat, file chunks, command proposals, terminal streams) are encrypted with AES-256-GCM and signed with Ed25519.
   - The signaling server forwards only opaque encrypted envelopes during relay fallback and never decrypts or persists private payloads.
4. **File Transfer Hardening**:
   - Recipients must explicitly approve every incoming file offer.
   - Strict filename sanitization blocks path traversal (`../`, `..\\`), null bytes, control characters, and Windows reserved names (`CON`, `NUL`, `COM1`, etc.).
   - Symlinks are rejected. Existing local files are never silently overwritten (conflict-safe deduplication).
   - Every chunk and final file is verified with SHA-256 before moving out of `.part` staging.
5. **Opt-In Terminal Sharing & Safe Command Proposals**:
   - Remote shell sharing is **disabled by default**.
   - Even when started by the host, connected peers start with `disabled` access and must be explicitly granted `read-only` or `interactive` permissions. Guests and viewers cannot receive `interactive` privileges.
   - Received command proposals are never auto-executed and are scanned for destructive patterns (`rm -rf`, `curl | bash`, `mkfs`, `dd`, privilege escalation).

## Threat Model & Documented Limitations

| Threat | Mitigation | Known Limitation |
| --- | --- | --- |
| 2-digit code guessing / enumeration | Per-client sliding-window rate limiter, short code TTL, host approval queue, collision disambiguation | An adversary on the same network may still trigger an approval prompt if public quick-connect is enabled; disable public quick-connect and use one-time invite tokens for sensitive rooms. |
| Signaling server compromise | E2EE prevents server from reading messages/files; host verifies peer fingerprints | A compromised signaling server could perform MITM on initial unverified key exchange unless peers compare fingerprints out-of-band or rely on previously pinned Trusted Devices. |
| Malicious files | Recipient confirmation, SHA-256 verification, no auto-execution, path traversal guard | TermLink does not include an antivirus scanner; recipients are responsible for inspecting received files before opening them. |
| Relay server compromise | Only AES-256-GCM ciphertext traverses the relay | Metadata (connection timing and packet sizes) remains visible to the relay operator. |

## Reporting a Vulnerability

Please report security issues privately via GitHub Security Advisories or to the project maintainers before public disclosure. Include reproduction steps, platform details, and expected vs. actual behavior.
