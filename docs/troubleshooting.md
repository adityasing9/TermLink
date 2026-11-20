# Troubleshooting & Platform Setup

## Quick Diagnostics Command

Always start by running:

```bash
npm run cli -- diagnostics --detailed
```

## Common Issues

### 1. Signaling Shows "Disconnected"
- Confirm the signaling server is running (`npm run dev` on port 3000, or `npm run signaling` on port 8787).
- Check your configured URL: `npm run cli -- config` -> verify `signalingServer`.
- On VMs, replace `localhost` with the host machine's LAN or Host-Only IP address.

### 2. Connection Shows "Relayed" Instead of "Direct P2P"
- Direct P2P requires either a shared LAN/VPN or compatible NAT traversal.
- Windows Defender Firewall or `ufw` on Linux may block inbound ephemeral TCP/UDP sockets. Allow Node.js on Private networks if you want direct LAN sockets.
- Relayed traffic remains **end-to-end encrypted (AES-256-GCM)**; TermLink intentionally reports `Relayed` so you always know the real transport path.

### 3. Multiple Rooms Share the Same 2-Digit Code
- Two-digit codes have 100 slots (`00`–`99`). When two active public rooms share a code, TermLink displays all candidates with host device name, platform, and fingerprint prefix so you can select the exact room you intended.
- For private or high-traffic deployments, disable `publicQuickConnect` and share a secure `/invite/<TOKEN>` link.

### 4. Windows / PowerShell / Command Prompt Notes
- TermLink automatically detects `powershell.exe` on Windows and never assumes `/bin/bash` exists.
- Classic `cmd.exe` without UTF-8 automatically receives ASCII box-drawing fallbacks (`+===+`) instead of broken Unicode characters.

### 5. Linux / macOS Permissions
- Local identity secrets are stored in `~/.termlink/identity.secret.json` with mode `0600`.
- If you move or reset devices, run `termlink trust reset-identity` to generate a fresh Ed25519 + X25519 keypair.
