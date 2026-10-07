# MCPL RFC-011: Targeted Publish

**Status:** Draft (revision 3). Draft→Accepted is gated on [RFC §10's executable-vector criterion](#10-conformance-vectors).
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code (Petra), from the Connectome communication lane (Tessa, Agnes, Basil reviewing)
**Date:** 2026-10-07
**Depends on:** nothing for authority. This RFC adds no capability path and changes no grant: `channels/publish` still requires `channels.publish` (SPEC §5.4, §14). It amends SPEC §14.2 (channel descriptor `capabilities`), §14.3 (`channels/publish` params and result, `channels/incoming` thread ids, and the `channels/outgoing/*` stream) and §9.2 (the channel and thread a channel-bearing `push/event` origin names).

> **Revision 3 note.** Binds a message a server delivers by `push/event` the same way as one it delivers by `channels/incoming` (RFC §3): the push names its channel as `origin.mcplChannelId` and its thread as `origin.threadId`. A host infers routes from channel-bearing pushes too. Composing a host with declaring connectors showed both halves failing: a thread named only in a server-specific `origin` field was answered at the channel root, and a channel named only that way left the host nowhere to answer.

> **Revision 2 note.** Applies Basil's review of revision 1: the host rule is MUST NOT (RFC §4), a refusal is a result with `reason` rather than an error (RFC §4, §5), incoming thread ids are tied to publish targets (RFC §3), a server that implements this RFC never ignores `threadId` even on a channel it stopped declaring (RFC §3), `threadId` travels only in the Request form (RFC §4), the outgoing stream carries the same target (RFC §6), and the value domain is closed (RFC §4). Vectors are added for each (RFC §10).

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

The declaration is per-channel descriptor data. It is **not** a capability path, it is not in the §6.2 vocabulary, and no advertisement shorthand (such as `channels: true`) implies it. A server sends it in `channels/register` and `channels/changed`, and changing it is an ordinary descriptor update.

**Inbound thread ids are publish targets.** A host learns thread ids from what the server sends it about messages, so a declaration binds them:

- on an `exact` channel, every `threadId` the server sends on `channels/incoming` for that channel MUST be accepted as a publish target for as long as that thread takes posts;
- on a `root` channel, `channels/incoming` messages MUST NOT carry `threadId`. A channel whose messages can sit in threads is not `root`.
- a `push/event` that delivers a message from a declared channel (the push counterpart of `channels/incoming`) is bound the same way. SPEC §9.2 leaves `origin` server-defined, but hosts infer routes from pushes that deliver messages, so:
  - the push MUST name that channel by its registered id, as `origin.mcplChannelId`. If the push is also channel-scoped under RFC-006, its `coalesce.channelId` MUST name the same channel;
  - a push delivering a message inside a thread of an `exact` channel MUST carry that thread as `origin.threadId`, in the same id space a publish to that channel accepts;
  - a push delivering a message at the channel root, or in a `root` channel, MUST NOT carry `origin.threadId`.

  A channel or thread named only in some other `origin` field is invisible to a host's routes: a host then has nowhere to answer, or answers at the root. A push that only refers to a message, such as a reaction, an edit or a deletion, is outside this binding (no host answers one); it may still name the channel.

**A server that implements this RFC never ignores `threadId`.** On any channel, declared or not (including one whose declaration it has just withdrawn), it either honors the target as RFC §3 defines or refuses it as RFC §4 defines. The host acts on the declaration it holds when it sends, and there is no acknowledgement to wait for in the Notification form of `channels/changed`. So a withdrawal that races a targeted publish fails safe rather than posting somewhere unasked.

## 4. Request (amends §14.3 `channels/publish` params)

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "channels/publish",
  "params": {
    "conversationId": "conv_123",
    "channelId": "slack:C123",
    "threadId": "1728291000.000100",   // or null, or absent
    "content": [ { "type": "text", "text": "…" } ]
  }
}
```

- **a non-empty string**: post in exactly that thread.
- **`null`**: post at the channel root, never inside a thread.
- **absent**: legacy. The server chooses, exactly as before this RFC.

The distinction between `null` and absent is normative. An older caller never sends the field, so an upgraded server keeps its old behavior for that caller. Any other value (a number, an empty string, an object, …) is invalid, and the server refuses it.

**Host rules.**
- A host MUST NOT send `threadId` to a channel whose descriptor declares no `capabilities.publish.target`. An older server ignores the field and posts where it likes, so only the host can keep the guarantee.
- A host MUST send a `channels/publish` that carries `threadId` as a Request. A Notification has no result, so its placement could never be confirmed (RFC §5).

**Server rules.** A server honors `threadId` as RFC §3 states. A target it cannot honor MUST be refused without posting, and the server MUST NOT fall back to the root or to another thread. Such targets include:
- a thread that does not exist, is not a thread of this channel, or is archived and closed to posting;
- a string `threadId` on a `root` channel;
- an invalid value.

**The refusal is a result, not an error.** It takes the form `{ "delivered": false, "reason": "…" }`, with no `messageId`. That result is the definitive statement that nothing was posted. A server that answers a targeted publish with a JSON-RPC error instead forfeits that statement: the host cannot tell an error from a partial post, so it treats the outcome as unconfirmed (RFC §5).

## 5. Result and host verification (amends §14.3 result)

```jsonc
{ "delivered": true, "messageId": "…", "threadId": "1728291000.000100" }   // or null
{ "delivered": false, "reason": "thread 1728291000.000100 is archived" }   // a refusal: nothing posted
```

`threadId` in the result names where the post landed: the thread, or `null` for the root. It is REQUIRED whenever the request carried `threadId` and something was posted, and it is taken from the platform's own response where the platform reports one. `reason` is optional on any result. On a refusal it says why.

A host that sent `threadId` treats the outcome as follows:

| Result | Host outcome |
| --- | --- |
| `delivered: true` with an echoed `threadId` equal to the request | delivered, at that place |
| `delivered: true` with `threadId` missing or different | **unconfirmed**: something was posted, but not provably where asked |
| `delivered: false` with no `messageId` (a refusal, RFC §4) | failed, with nothing posted |
| `delivered: false` with a `messageId` (contradictory evidence) | unconfirmed, as the host already classifies it |
| an error response, timeout, or lost connection after dispatch | unconfirmed |

A request without `threadId` needs no `threadId` in its result, and its outcome follows the host's existing rules.

## 6. The outgoing stream (amends §14.3 `channels/outgoing/*`)

`channels/outgoing/chunk` and `channels/outgoing/complete` gain the same optional `threadId`, with the same values and meanings as RFC §4. A host sends it on a stream exactly when the stream's final `channels/publish` will carry it, with the same value. A server that renders streamed text visibly (a live message, for example) MUST render it only in that place, and MUST NOT render it visibly when the place is one it would refuse.

The stream stays advisory: delivery remains the final `channels/publish`. By §14.3's fail-closed rule, a host does not stream text it would not publish, so a host following RFC §8 streams nothing to an undeclared channel.

## 7. Compatibility

| Host | Server | Behavior |
| --- | --- | --- |
| old (never sends `threadId`) | old | unchanged |
| old | new (declares) | unchanged: the absent field keeps the legacy path |
| new | old (no declaration) | the host knows it has no guarantee, so it does not rely on that channel's publication (RFC §8) |
| new | new | exact targeting where declared |

The change is additive: no existing field changes meaning, and an old server never receives `threadId` from a conforming host. Servers can therefore release first. A host that adopts this RFC changes what *it* publishes to undeclared channels. That is a host decision, and RFC §8 states the rule this RFC recommends.

## 8. Host guidance (non-normative)

A host that routes a model's plain speech to the conversation it is answering (for example, Agent Framework's speech routes):

- publishes only to channels with a declared target, always sending the intended place: the thread, or `null` for the root;
- treats a thread conversation as reachable only on an `exact` channel, and any conversation on a channel with no declaration as unreachable by its own publication. It holds such speech for the resident to deliver deliberately, and points to the server's own send tools where the server lists them;
- never substitutes the root for a thread it cannot reach;
- checks the echo (RFC §5) before treating a post as delivered.

## 9. Security and privacy

No new authority: `channels.publish` gates the method as before. The declaration is a server's statement about its own behavior, and RFC §5's echo lets the host check that statement post by post. Targeting a thread reveals nothing the channel did not already expose to the server.

## 10. Conformance vectors

Draft→Accepted requires executable vectors under `conformance/rfc-011/`, run against at least one `exact` server and one `root` server through a real host:

1. A descriptor with `capabilities.publish.target` is accepted with the other capabilities intact. The declaration appears in neither the advertisement walk nor the grant.
2. `exact`, with a string `threadId`: posted in that thread, and the echo is equal.
3. `exact`, with `null`: posted at the root, and the echo is `null`, even when a newer incoming message sits in a thread (the root race).
4. `exact`, with an unknown or non-thread `threadId`: `delivered: false` with no `messageId`, and nothing posted at the root.
5. `root`, with a string `threadId`: refused with nothing posted. With `null`: posted, and the echo is `null`.
6. Absent `threadId` on a declaring server: the legacy result shape (no `threadId`), with the legacy placement.
7. Host verification: a `delivered: true` result with a missing or different echo is unconfirmed, and `delivered: false` with a `messageId` is unconfirmed.
8. Host: a channel with no declaration receives no `threadId`, and plain speech the host routes to it is held, not published.
9. `exact`: every `threadId` the server sent on incoming for the channel is accepted as a publish target. `root`: no incoming message carries `threadId`.
10. A declaration withdrawn by `channels/changed` while a targeted publish is in flight: the publish is honored or refused, never posted elsewhere.
11. Invalid values (a number, `''`, an object) are refused with `{delivered: false, reason}`, with nothing posted and no `messageId`.
12. Host: a `channels/publish` carrying `threadId` is always a Request.
13. Stream: the chunks and the completion carry the final publish's `threadId`, and a rendering server keeps visible streamed text in that place.
14. Push: a `push/event` delivering a message from a declared channel names that channel as `origin.mcplChannelId`, equal to its `coalesce.channelId` when it is channel-scoped. One delivering a message inside a thread of an `exact` channel also carries `origin.threadId`, and a host's reply to it lands in that thread. One delivering a root message, or a message in a `root` channel, carries none.

Each vector names the platform boundary it used: a real platform, or a stub at the platform client. Behavior that only a real platform can establish (for example, what Slack does with a stale `thread_ts`) is marked as such.

## 11. Changelog

- Revision 1 (2026-10-07): initial draft.
- Revision 2 (2026-10-07): from Basil's review. The host rule becomes MUST NOT, and the refusal is a `{delivered: false, reason}` result. Incoming thread ids are bound to publish targets, a server never ignores `threadId` on a withdrawn declaration, `threadId` is Request-only, the stream carries the target, and the value domain is closed. Vectors 9–13 are added.
- Revision 3 (2026-10-07): the binding extends to `push/event`s that deliver a message from a declared channel: the push names its channel as `origin.mcplChannelId` (agreeing with `coalesce.channelId` when RFC-006 channel-scoped) and its thread as `origin.threadId`, with vector 14. This was found by composing a host with declaring connectors whose pushes named the thread, or the channel, only in server-specific fields.
