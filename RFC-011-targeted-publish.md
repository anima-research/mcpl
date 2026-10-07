# MCPL RFC-011: Targeted Publish

**Status:** Draft (revision 1). Draft→Accepted is gated on [RFC §9's executable-vector criterion](#9-conformance-vectors).
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code (Petra), from the Connectome communication lane (Tessa, Agnes, Basil reviewing)
**Date:** 2026-10-07
**Depends on:** nothing for authority. This RFC adds no capability path and changes no grant: `channels/publish` still requires `channels.publish` (SPEC §5.4, §14). It amends SPEC §14.2 (channel descriptor `capabilities`) and §14.3 (`channels/publish` params and result).

Section references (§) are to the SPEC; references to this document are written "RFC §".

---

## 1. Summary

`channels/publish` names a channel but not a place inside it. On platforms whose channels contain threads or topics (Slack threads, Telegram forum topics, Discord-relay threads under a parent), the server decides on its own where a post lands. A host therefore cannot direct a reply into the conversation it is answering, and it cannot keep a reply out of a thread either.

This RFC lets a server **declare, per channel**, that it posts exactly where the host asks, and lets the host **ask** for a place: a thread, or the channel root. A server that declares nothing, and a host that asks for nothing, keep today's behavior.

## 2. Motivation

slack-mcpl posts into the thread of the most recent incoming message in the channel (anima-research/slack-mcpl#6). The host cannot override this, because the wire has no field to say where. Two failures follow:

- **Thread race.** A resident answers a mention in thread A. An ambient message then arrives in thread B of the same channel, and the answer lands in B.
- **Root race.** A resident answers a top-level message. An ambient message arrives in some thread, and the top-level answer lands inside that thread.

A server-side heuristic cannot fix either race, because only the host knows which conversation a reply belongs to. Explicit platform tools (`reply_message` with a thread id) work, but they cannot carry a host's ordinary plain-speech publication.

A field the server is free to ignore is not enough either. Old servers would silently drop it, and the host would believe it had targeted a thread when it had not. So the host must know, per channel, that the target will be honored, and it must be able to confirm where each post landed.

## 3. Declaration (amends §14.2)

A channel descriptor's optional `capabilities` object (alongside `history` and `acknowledgment`) gains:

```jsonc
"capabilities": {
  "publish": { "target": "exact" }   // or "root"
}
```

- **`exact`**: a `channels/publish` carrying `threadId` (RFC §4) lands exactly where it says, in that thread or at the channel root, or it fails with nothing posted. The server never redirects it.
- **`root`**: the channel contains no threads, and every publish lands in the channel itself. A string `threadId` is refused with nothing posted, while `null` is honored. This is the fixed-channel case: Discord channels, DMs, and Discord threads, which are channels in their own right; single-channel worlds; a device's home channel.
- **absent**: no guarantee. A host that needs to know where its post lands MUST NOT rely on this channel's publication.

The declaration is per-channel descriptor data. It is **not** a capability path, it is not in the §6.2 vocabulary, and no advertisement shorthand (such as `channels: true`) implies it. A server sends it in `channels/register` and `channels/changed`. Changing it is an ordinary descriptor update, and it applies to publishes made after the host has accepted the update.

## 4. Request (amends §14.3 `channels/publish` params)

```jsonc
{
  "method": "channels/publish",
  "params": {
    "conversationId": "conv_123",
    "channelId": "slack:C123",
    "threadId": "1728291000.000100",   // or null, or absent
    "content": [ { "type": "text", "text": "…" } ]
  }
}
```

- **a string**: post in exactly that thread.
- **`null`**: post at the channel root, never inside a thread.
- **absent**: legacy. The server chooses, exactly as before this RFC.

The distinction between `null` and absent is normative. An older caller never sends the field, so an upgraded server keeps its old behavior for that caller.

A host SHOULD send `threadId` only to channels that declare `capabilities.publish.target`. When a server declares the channel, it MUST honor `threadId` as RFC §3 states. In particular, a target it cannot honor MUST fail without posting, and it MUST NOT fall back to the root or to another thread. Examples are a thread that does not exist, is not a thread of this channel, or is archived and closed to posting; or a string `threadId` on a `root` channel. A failure SHOULD carry a `reason`.

## 5. Result and host verification (amends §14.3 result)

```jsonc
{ "delivered": true, "messageId": "…", "threadId": "1728291000.000100" }   // or null
```

`threadId` in the result names where the post landed: the thread, or `null` for the root. It is REQUIRED whenever the request carried `threadId`, and it is taken from the platform's own response where the platform reports one.

A host that sent `threadId` treats the outcome as follows:

| Result | Host outcome |
| --- | --- |
| `delivered: true` with an echoed `threadId` equal to the request | delivered, at that place |
| `delivered: true` with `threadId` missing or different | **unconfirmed**: something was posted, but not provably where asked |
| `delivered: false` with no `messageId` | failed, with nothing posted |
| `delivered: false` with a `messageId` (contradictory evidence) | unconfirmed, as the host already classifies it |
| an error response, timeout, or lost connection after dispatch | unconfirmed |

A request without `threadId` has a result without `threadId`. Its outcome follows the host's existing rules.

## 6. Compatibility

| Host | Server | Behavior |
| --- | --- | --- |
| old (never sends `threadId`) | old | unchanged |
| old | new (declares) | unchanged: the absent field keeps the legacy path |
| new | old (no declaration) | the host knows it has no guarantee, so it does not rely on that channel's publication (RFC §7) |
| new | new | exact targeting where declared |

The change is additive: no existing field changes meaning, and an old server never receives `threadId` from a conforming host. Servers can therefore release first. A host that adopts this RFC changes what *it* publishes to undeclared channels. That is a host decision, and RFC §7 states the rule this RFC recommends.

## 7. Host guidance (non-normative)

A host that routes a model's plain speech to the conversation it is answering (for example, Agent Framework's speech routes):

- publishes only to channels with a declared target, always sending the intended place: the thread, or `null` for the root;
- treats a thread conversation as reachable only on an `exact` channel, and any conversation on a channel with no declaration as unreachable by its own publication. It holds such speech for the resident to deliver deliberately, and points to the server's own send tools where the server lists them;
- never substitutes the root for a thread it cannot reach;
- checks the echo (RFC §5) before treating a post as delivered.

## 8. Security and privacy

No new authority: `channels.publish` gates the method as before. The declaration is a server's statement about its own behavior, and RFC §5's echo lets the host check that statement post by post. Targeting a thread reveals nothing the channel did not already expose to the server.

## 9. Conformance vectors

Draft→Accepted requires executable vectors under `conformance/rfc-011/`, run against at least one `exact` server and one `root` server through a real host:

1. A descriptor with `capabilities.publish.target` is accepted with the other capabilities intact. The declaration appears in neither the advertisement walk nor the grant.
2. `exact`, with a string `threadId`: posted in that thread, and the echo is equal.
3. `exact`, with `null`: posted at the root, and the echo is `null`, even when a newer incoming message sits in a thread (the root race).
4. `exact`, with an unknown or non-thread `threadId`: `delivered: false` with no `messageId`, and nothing posted at the root.
5. `root`, with a string `threadId`: refused with nothing posted. With `null`: posted, and the echo is `null`.
6. Absent `threadId` on a declaring server: the legacy result shape (no `threadId`), with the legacy placement.
7. Host verification: a `delivered: true` result with a missing or different echo is unconfirmed, and `delivered: false` with a `messageId` is unconfirmed.
8. Host: a channel with no declaration receives no `threadId`, and plain speech the host routes to it is held, not published.

Each vector names the platform boundary it used: a real platform, or a stub at the platform client. Behavior that only a real platform can establish (for example, what Slack does with a stale `thread_ts`) is marked as such.

## 10. Changelog

- Revision 1 (2026-10-07): initial draft.
