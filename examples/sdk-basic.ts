import { TermLink } from '../packages/sdk/src/index';

async function main() {
  const client = new TermLink({
    deviceName: 'SDK-EXAMPLE-NODE',
    signalingServer: process.env.TERMLINK_SIGNALING_URL || 'ws://localhost:3000/ws',
  });

  const identity = await client.initialize();
  console.log('Initialized identity:', identity.deviceName, identity.fingerprint);

  const room = await client.createRoom({
    roomName: 'SDK Demo Room',
    requireHostApproval: true,
  });

  console.log(`Room created! Join with: termlink ${room.code}`);
  console.log(`Invite link: ${room.joinUrl}`);

  room.on('joinRequest', (req) => {
    console.log(`Approving ${req.identity.deviceName} (${req.identity.fingerprint})`);
    room.approveJoin(req.requestId, 'collaborator');
  });

  room.on('peerJoined', (peer) => {
    console.log(`${peer.identity.deviceName} connected`);
  });

  room.on('message', (msg) => {
    console.log(`[${msg.senderName}]: ${msg.text}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
