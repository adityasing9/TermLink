# Developer SDK & npm Publishing Guide

## Using the TypeScript SDK

```typescript
import { TermLink } from "termlink";

const client = new TermLink({
  deviceName: "AADI-PC",
  signalingServer: "ws://localhost:3000/ws",
});

await client.initialize();

const room = await client.createRoom({
  roomName: "DEV TEAM",
  requireHostApproval: true,
});

console.log("Room code:", room.code);

room.on("joinRequest", (req) => {
  console.log(`Incoming peer: ${req.identity.deviceName} (${req.identity.fingerprint})`);
  room.approveJoin(req.requestId, "collaborator");
});

room.on("peerJoined", (peer) => {
  console.log(`${peer.identity.deviceName} connected`);
});

room.on("message", (msg) => {
  console.log(`[${msg.senderName}] ${msg.text}`);
});

await room.sendMessage("Hello, everyone!");
```

### Public `RoomSession` Methods & Events

- **Methods**: `approveJoin`, `rejectJoin`, `kickPeer`, `setPeerRole`, `transferOwnership`, `rotateCode`, `createInvite`, `revokeInvite`, `updateSettings`, `sendMessage`, `sendPrivateMessage`, `proposeCommand`, `sendFile`, `pauseFileTransfer`, `resumeFileTransfer`, `cancelFileTransfer`, `startTerminalSession`, `setTerminalPeerAccess`, `lockTerminalSession`, `stopTerminalSession`, `sendTerminalInput`, `leave`, `closeRoom`.
- **Events**: `joinRequest`, `peerJoined`, `peerLeft`, `roomUpdated`, `roomClosed`, `inviteCreated`, `inviteRevoked`, `message`, `privateMessage`, `messageDelivered`, `fileOffer`, `fileProgress`, `fileComplete`, `fileRejected`, `fileCancelled`, `commandProposal`, `commandDecision`, `terminalState`, `terminalOutput`, `connectionStateChanged`, `securityWarning`.

---

## npm Packaging & Release Checklist

Before publishing to npm (never publish automatically without maintainer approval):

1. Update `"version"` in `package.json` following SemVer.
2. Run full verification:
   ```bash
   npm run lint
   npm test
   npm run build
   npm pack --dry-run
   ```
3. Verify the tarball includes `dist/bin/termlink.mjs`, `dist/signaling-server.mjs`, `dist/sdk/index.mjs`, `dist/types/**/*.d.ts`, `README.md`, `LICENSE`, and `SECURITY.md`, and excludes private keys, `.env`, or temporary files.
4. Create an annotated git tag (`git tag -a v1.0.0 -m "Release v1.0.0"`) and push to trigger the approval-gated `.github/workflows/release.yml` workflow.
