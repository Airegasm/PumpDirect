# USER_EXPANSION_OPT-IN

Notes / plans for scaling past the current **5-visitor WebRTC mesh cap** via an
opt-in SFU mode. Not built yet — this file just preserves the design so we
don't have to think it through again.

## Why we cap at 5 today

- WebRTC mesh: every peer holds a PC to every other peer.
- Owner cam at 1280×720 ≈ 1.5–2 Mbps **per visitor** (each visitor gets its
  own SRTP copy). 5 visitors → ~10 Mbps owner upload just for video.
- Per-peer DTLS-SRTP encrypt is CPU-bound; past ~6 peers it gets uncomfortable
  on a typical home machine.
- Pitch today: *"no third party touches the media — pure peer-to-peer."*
  That's the constraint that locks us to mesh.

## Opt-in shape (when we build it)

- New session-profile field, e.g. `mediaTransport: 'mesh' | 'sfu'`. Default:
  `'mesh'` so existing behavior is unchanged.
- Settings modal: tickbox "Use SFU for this session (supports >5 visitors)"
  with a short helper line about the tradeoff.
- When `sfu`, every peer publishes one outbound stream to the SFU and
  subscribes to N forwarded streams from it. WebRTC client wiring stays
  largely the same — just the signaling target changes.

## SFU options (all free, open-source)

| SFU | Lang | License | Why it fits | Why not |
| --- | --- | --- | --- | --- |
| **Galene** | Go | MIT | Single binary, trivial to run, ~10–20 peers per process. | Lower ceiling. |
| **mediasoup** | Node.js | MIT | Drops into our existing Node stack. Battle-tested. | Lower-level API; more glue code. |
| **LiveKit** | Go | Apache 2.0 | Production-polish. Great SDKs. | Bigger system, opinionated, separate auth tokens. |
| **Pion / ion-sfu** | Go | MIT | Light, composable. | More wiring than mediasoup. |
| **Janus** | C | GPLv3 | Mature, full-featured. | GPLv3 license posture. |

**First-pick:** Galene for the easiest onramp. mediasoup if we want this to
become a polished, production-grade feature.

## The E2EE caveat (important)

A vanilla SFU **decrypts and re-encrypts** every packet — it has to know
packet boundaries to forward. So the host machine running the SFU sees the
media in plaintext. Two options:

1. **Accept it.** If the SFU runs on the same Linux box the owner is already
   running on, the trust boundary doesn't actually move — same operator,
   same machine. We just update the security copy to say "media is
   end-to-end peer-to-peer in mesh mode, host-relayed in SFU mode."
2. **Layer E2EE via WebRTC Insertable Streams.** Client encrypts each media
   frame above SRTP; SFU forwards the encrypted bytes blindly. mediasoup
   and LiveKit both support this pattern. ~3–4× the integration effort.
   Safari support is iffy as of writing.

## Bandwidth math (with SFU)

- Owner publishes once to SFU: ~2 Mbps up.
- SFU fans out: subscribers × 2 Mbps each.
- 10 viewers ⇒ ~20 Mbps egress from SFU. Comfortable on a home 50 Mbps line.
- 20+ viewers ⇒ likely needs a small VPS ($5–20/mo) for the SFU.

## Other implications

- **Action-flash / overlay / state events** all flow over WS, not media —
  unaffected by mesh ↔ SFU swap.
- **Chat E2EE (AES-256-GCM)** is independent of media transport — stays
  exactly as it is.
- **Cloudflare Access** still gates entry — no change.
- **TOS copy + README** would need a small update to describe the SFU mode
  honestly (host machine sees media unless we add insertable-streams E2EE).

## Rough scope to build

| Component | Touch |
| --- | --- |
| Session-profile schema | Add `mediaTransport` field. |
| Settings modal | Tickbox + helper text. |
| WebRTC client (`views/rtc-client.js`) | Route signaling to SFU when set; alter PC creation. |
| Signaling server | Pass-through to SFU, or run SFU lib inline. |
| SFU process | Install + start with config (or embed via mediasoup). |
| Docs / README | Note the new mode + trust posture. |

Maybe a week of focused work for Galene-flavored MVP. Two-ish weeks for a
polished mediasoup integration with insertable-streams E2EE.

## When to actually do this

Now: **don't**. 5 visitors is fine for the intended use case. Revisit if /
when:

- Multiple users ask for larger group sessions.
- We want a "viewer-only paid tier" that scales past 5.
- We want to differentiate the project as multi-viewer-capable in marketing.
