# PumpDirect

Self-hosted session controller for smart-plug-attached pumps, designed for invited remote guests.
Each operator runs their own instance on their own hardware — there is no central server.

> ⚠️ **Adults only.** This software is intended for use by, and access only granted to, people
> who are of legal age in their jurisdiction (**18+ or 21+ where applicable**). The operator of
> each instance is **solely responsible** for verifying every participant's age and consent. See
> `views/tos.js` for the full terms presented at first launch.

---

## What it is

PumpDirect lets you:

- Run a small, private web app on your own machine.
- Expose **only** that app to the public internet through a [Cloudflare Tunnel + Access](https://developers.cloudflare.com/cloudflare-one/) (free tier, ≤50 invited emails).
- Control smart plugs on your LAN (**TP-Link Kasa, Tapo, Wyze, Govee, Tuya**) via a calibrated action-template engine driven by capacity-based milestones.
- Let your invited guests connect, watch a live capacity gauge, fire pre-defined action templates (if you grant them control), and chat over WebSocket.
- Stream your webcam (live mode, WebRTC mesh, ≤5 viewers) or post auto-snapshots at capacity thresholds.
- Grant select controllers permission to publish their own cam into the mesh.

There's a clear separation between:

- **Owner GUI** — bound to `127.0.0.1` only, never reachable from the internet, full setup + admin.
- **Visitor app** — served through your Cloudflare Tunnel, gated by Cloudflare Access (email allowlist).

## Architecture at a glance

```
┌────────────────┐                                   ┌────────────────┐
│   visitor      │──── HTTPS ────► Cloudflare ─────► │  cloudflared   │
│   browser      │                  Access edge      │  (your PC)     │
│   (CF Access   │                  (email PIN)      │                │
│    auth'd)     │                                   │                │
└────────────────┘                                   └───────┬────────┘
                                                             │
                                                             ▼
                                                     ┌────────────────┐
                                                     │ public-server  │
                                                     │ :3000  127.0.0.1│
                                                     └───────┬────────┘
                                                             │
        ┌────────────────┐    loopback only        ┌────────┴────────┐
        │   owner        │◄──────────────────────► │ owner-server    │
        │   browser      │    http://localhost:3001│ :3001  127.0.0.1│
        │   (local)      │                         └────────┬────────┘
        └────────────────┘                                  │
                                                            ▼
                                                  ┌──────────────────┐
                                                  │ device-control + │
                                                  │ action-engine +  │
                                                  │ vendor services  │
                                                  └────────┬─────────┘
                                                           │
                                                  ┌────────▼─────────┐
                                                  │ Kasa / Tapo /    │
                                                  │ Wyze / Govee /   │
                                                  │ Tuya plug on LAN │
                                                  └──────────────────┘
```

- **Both servers** live in one Node process, behind a single in-process `event-bus`.
- **WebRTC media** (live cam, controller cam, snapshots) is peer-to-peer; the server only relays signaling.
- **Python helpers** (Kasa, Wyze, Tapo) are invoked as subprocesses via the local venv — only protocols that need them.

## Quick start

```bash
git clone https://github.com/Airegasm/PumpDirect.git
cd PumpDirect
./start.sh          # Linux/macOS — installs deps, builds venv if python3 present, opens owner GUI
# or
start.bat           # Windows
```

Then on first launch, in your local browser:

1. Accept the **Terms of Service** splash (one-time per TOS version).
2. Open the **Network** tab, run the **Cloudflare Tunnel** wizard:
   - Install `cloudflared` if missing (per-OS installer link/auto-download).
   - Authenticate against Cloudflare (browser popup).
   - Paste a CF API token (Account → Access: Apps & Policies: Edit · Zone → DNS: Read).
   - Create the tunnel, route DNS to `app.your-domain.com`.
   - **Enable Cloudflare Zero Trust** in the CF dashboard if it isn't already — one click.
   - Create the Access app + email allow-policy via the API call.
3. Open the **Devices** tab, scan for Kasa devices (UDP broadcast), add your pump plug, calibrate it (live timer or manual seconds-to-100%).
4. Open the **Users** tab, add invited guests by email + nickname. Each entry pushes to the CF Access allow-policy.
5. Open the **Pump Templates** tab, build milestones with announcements + action templates (`on` / `off` / `repeat` step DSL).
6. Open the **Launchpad** tab — pick a session profile (or create one), check participants' Connect/Action/Video permissions, hit **Start Session**.
   - Sessions begin in **standby**. Click **Exit Standby** to officially go live.
   - All session controls: Stop · E-STOP · Enter/Exit Standby.

## Stack & dependencies

- **Node.js 20+** (Express, ws, native fetch). Tested on 24.
- **Python 3.10+** *only if you use Tapo / Wyze / Matter* — the venv handles those subprocesses; Kasa / Govee / Tuya run purely in Node.
- **cloudflared** — installed via the in-app wizard.
- Optional: **NSSM** (Windows Service helper) — auto-downloaded by the hardening installer script.

## Security model

You will see this language in the TOS at first launch, but here's the engineer's view.

| Channel | Encrypted? | Notes |
|---|---|---|
| Visitor → Cloudflare edge | **Yes (HTTPS / WSS)** | Standard TLS to `*.your-domain.com`. |
| Cloudflare edge → your tunnel | **Yes (CF tunnel)** | `cloudflared` outbound to CF over QUIC/HTTP2. |
| Tunnel → PumpDirect public-server | Loopback (`127.0.0.1`) | App binds to localhost only. |
| Owner browser → owner-server | Loopback (`127.0.0.1`) | Never internet-reachable. SSH-forward this port if you want to use it remotely. |
| **Webcam streams** | **End-to-end DTLS-SRTP** | WebRTC peer-to-peer; the server only relays SDP/ICE. Cam audio + video frames are encrypted between browsers and never decryptable by anyone in between, including this app's server. |
| Chat messages | TLS in transit, plaintext on server | The owner's own server (your PC) sees chat in plaintext — necessary for fan-out, history, system messages, and moderation. No third party sees plaintext. Cloudflare can see plaintext at the edge because they terminate TLS for the public hostname; that's standard for any HTTPS site behind Cloudflare. |

**The owner is in the trust boundary.** This is by design: it's *your* server on *your* hardware, used by guests *you* approved through *your* Cloudflare Access email policy. The owner can read all chat, see what actions were fired, etc. — same as moderating a private group chat you host.

For owner-side hardening on Linux, see the **Network → OS Hardening** tab — it generates a systemd unit with:

```
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only (except project + ~/.cloudflared)
PrivateDevices=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK AF_PACKET
LockPersonality=yes
SystemCallArchitectures=native
... (full list in the unit template)
```

Windows path generates a PowerShell installer that registers PumpDirect via NSSM, runs it as a non-elevated service, and adds a Windows Defender Firewall rule pinning the listener to `127.0.0.1`.

### Cloudflare Tunnel + Access

- Access policy email allowlist is the **front door** — non-allowed visitors can't even reach the visitor app.
- The app *also* enforces `canConnect` / `canControl` / `canBroadcast` flags per-participant inside the session — Access getting wrong wouldn't grant control by itself.
- API token scope kept minimal: *Access: Apps & Policies: Edit* + *DNS: Read* + *Zone: Read*. No write access to your zone records beyond what the tunnel needs.

### What the engine refuses to do without consent

- Device actions only fire from emails the owner explicitly marked `canControl`.
- Controller cam broadcast only works when the **owner-level master switch** AND the **per-participant `canBroadcast`** flag are both on.
- If the session profile has `disableControlAt100` checked, the engine aborts any running action that pushes capacity ≥ 100%.

## Customization

- **Branding**: every `PumpDirect` string is plain HTML — search/replace if you fork.
- **Action template DSL** is in `services/templates-service.js`. Steps: `{type:'on'|'off', durationMs}` or `{type:'repeat', times, steps:[...]}`. Up to 3 levels of nesting.
- **Vendor support**: each vendor's adapter is in `services/<vendor>-service.js`. Drop a new file + register it in `services/device-control.js`'s `VENDOR_INFO` map.
- **Milestone "100%+" type**: regular milestones cap at 99%; mark one milestone as `is100Plus` for anything beyond.

## Distributing your fork

Everyone who runs `start.sh` / `start.bat` gets their own instance from scratch:

- `config.json` — gitignored; never published.
- `data/` — gitignored; per-instance devices.json, templates.json, sessions.json.
- `.venv/`, `node_modules/` — gitignored.
- `pumpdirect.service`, `install-service.ps1`, `bin/nssm.exe` — gitignored (generated on each host).

If you change your repo URL, update `routes/tos.js` and `start.sh` accordingly.

## Layout (high-level)

```
config.js                  Single config-file loader/saver
server.js                  Entrypoint — starts public + owner servers
public-server.js           Visitor side, /ws/visitor (max 5 distinct emails)
owner-server.js            Loopback owner GUI, /ws/owner
routes/                    Express routers per tab
services/                  Action engine, device control, signaling, vendors
views/                     Shared layout + page templates (no framework)
python/, scripts/          Python helpers for Tapo / Kasa / Wyze
utils/                     Logger, errors
start.sh, start.bat        Cross-platform launchers
```

## License

PumpDirect itself is published under the terms in the `LICENSE` file (or this repository's GitHub-displayed license). The bundled SwellDreams-derived modules in `services/` and `python/` carry their original headers.

The TOS in `views/tos.js` is the legally-binding text presented to operators at first launch. Don't strip it without a replacement.

## Credits

Built on top of, and ports the device subsystem from, [SwellDreams](https://github.com/Airegasm/SwellDreams).

---

If you find a bug or want to contribute, open an issue or PR. Reports about safety issues (e.g.,
edge cases where E-STOP fails or device control fires unexpectedly) are highest priority.
