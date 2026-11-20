# Networking, Self-Hosting, TURN & Virtual Machines (VMware / VirtualBox / WSL2)

## Self-Hosting the Signaling Server

Run the standalone lightweight signaling server on any Linux/Windows/macOS host or VPS:

```bash
PORT=8787 TERMLINK_PUBLIC_BASE_URL=https://termlink.yourdomain.com npm run signaling
```

Point CLI peers to your server:

```bash
termlink config set signalingServer wss://termlink.yourdomain.com/ws
termlink config set publicBaseUrl https://termlink.yourdomain.com
```

Always terminate TLS (`wss://` and `https://`) via Caddy, Nginx, or a cloud load balancer in production. Never hardcode a domain you do not own.

## Configuring STUN & TURN Relay Servers

For strict corporate NAT or symmetric firewalls, configure STUN and TURN servers in `~/.termlink/config.json`:

```json
{
  "stunServers": [
    "stun:stun.l.google.com:19302"
  ],
  "turnServers": [
    {
      "urls": "turn:turn.yourdomain.com:3478",
      "username": "termlink",
      "credential": "SET_VIA_ENV_OR_LOCAL_SECRET"
    }
  ]
}
```

When no external TURN server is configured and direct P2P cannot connect, TermLink falls back to end-to-end encrypted relay forwarding over the signaling WebSocket and accurately displays `Relayed`.

---

## VMware, VirtualBox & WSL2 Scenarios

TermLink runs natively inside the guest OS (Windows, Ubuntu, Kali, Debian, Fedora, Arch, macOS). No VMware-specific driver is required.

### Scenario A: Windows Host + Ubuntu VMware Guest
- **Network Mode**: Bridged (recommended) or NAT.
- **Host (Windows PowerShell)**: `termlink create --name "HOST-VM-LAB"` -> displays 2-digit code (e.g., `47`).
- **Guest (Ubuntu Terminal)**: `termlink 47` -> host approves Ubuntu guest's fingerprint.
- **Expected Transport**: `Local network` on Bridged mode; `Local network` or `Relayed` on NAT depending on host firewall rules.

### Scenario B: Windows Host + Kali VMware Guest + Ubuntu VM (3-Peer Group)
- All three machines configure the same `signalingServer` (either hosted on the Windows host LAN IP e.g. `ws://192.168.1.10:3000/ws`, or a shared HTTPS/WSS server).
- Host runs `termlink create`; Kali and Ubuntu guests both run `termlink <code>`.
- Full mesh establishes `3 × 2 / 2 = 3` encrypted pairwise links.

### Scenario C: Separate Physical Computers & VMs Across Different Networks
- Point all peers to a publicly reachable TLS signaling server (`wss://...`).
- TermLink probes UDP STUN for NAT traversal and falls back automatically to E2EE relay when symmetric NAT blocks direct packets.

### Scenario D: Host-Only Networking (VMware VMnet1 / VirtualBox vboxnet0)
- **Limitation**: Host-only adapters have **no internet access** and cannot reach public STUN servers (`stun.l.google.com`).
- **How to run**: Start the signaling server on the host machine bound to `0.0.0.0:3000`, find the host's host-only IP (e.g., `192.168.56.1`), and run:
  ```bash
  termlink config set signalingServer ws://192.168.56.1:3000/ws
  ```
- Direct LAN P2P works cleanly between the host and all VMs on that host-only subnet.

### Scenario E: NAT Networking Limitations
- VMware/VirtualBox NAT places the guest behind a second NAT layer (Double NAT).
- Outbound connections to the signaling server work immediately, while inbound direct connections to the guest may be blocked by the hypervisor NAT.
- **Verification**: Run `termlink diagnostics --detailed` inside the guest to inspect `Signaling`, `STUN`, `Direct P2P`, and `Relay` readiness.
