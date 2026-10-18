# MCPL RFC-011: Targeted Publish

**Status:** Draft (revision 6). Draft→Accepted is gated on [RFC §10's executable-vector criterion](#10-conformance-vectors).
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code (Petra), from the Connectome communication lane (Tessa, Agnes, Basil reviewing)
**Date:** 2026-10-07 (revision 6: 2026-10-18)
**Depends on:** nothing for authority. This RFC adds no capability path and changes no grant: `channels/publish` still requires `channels.publish` (SPEC §5.4, §14). It amends SPEC §14.2 (an optional `capabilities` object on the channel descriptor), §14.3 (`channels/publish` params and result, `channels/incoming` thread ids, and the `channels/outgoing/*` stream), §14.4 (the place `defaultOutgoing` names) and §9.2 (the channel and thread a channel-bearing `push/event` origin names).

> **Revision 6 note.** From slimepriestess's view of revision 5: on an undeclared channel, RFC §8's legacy publication becomes the default, with revision 5's semantics, and the opt-in inverts to strict holding. A host that adopts this RFC keeps publishing speech to an undeclared channel itself, as a Request with no `threadId`, and reports each such post as placed by the server. It holds speech for a conversation it knows to be in a thread there. An operator may choose strict holding for a channel, a server or the whole host instead. RFC §8 states the default's two costs, and RFC §3's absent rule, RFC §6, RFC §7's table and vector 8 are worded to match.

> **Revision 5 note.** From a review of revision 4 by the house's review workflow, and from Agnes's review of a declaring connector. The rules close their gaps: an undeclared channel's server still never ignores `threadId` (RFC §3), any `publish.target` other than `exact` or `root` is no declaration, a declaration lasts as long as its registration, and a server that can't correct a stale declaration reports its messages as they are (a thread's with its `threadId`, even on a `root` channel, the one exception to the root rule) and refuses what the declaration doesn't allow. A push binds a route only to a channel its server registered. A refusal must carry `reason`, a `delivered: false` means nothing was posted, a Notification carrying `threadId` is honored exactly or not posted, and RFC §5 states what a host reports for every result, a legacy one included. A stream has one place, carried by its completion even on abort. RFC §8's migration setting is an exception RFC §3 names, sends each legacy publish as a Request, and states its residual races exactly. `defaultOutgoing` carries `threadId` as its publish will (RFC §5). Most vectors gain cases that test these rules, and vector 15 covers an undeclared channel.

> **Revision 4 note.** From slimepriestess's review of revision 3: RFC §8 names a migration setting a host may offer, keeping legacy publication (never carrying `threadId`) on undeclared channels an operator names, or on a server's undeclared channels, until they declare. A conversation the host knows to be in a thread stays held there. Without the setting, a host that follows RFC §8 holds plain speech on every undeclared channel at once. The guidance stays non-normative, RFC §3 and RFC §4 name the exception the setting makes, and RFC §4's host rule holds under it. Vector 8 now covers a host with or without it.

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

A channel descriptor gains an optional `capabilities` object, and this RFC defines its `publish` member. SPEC §14.2 does not yet show a descriptor `capabilities` object. mcpl-core-ts already types one, with `history` and `acknowledgment` members, and `publish` sits beside them:

```jsonc
"capabilities": {
  "publish": { "target": "exact" }   // or "root"
}
```

- **`exact`**: a `channels/publish` carrying `threadId` (RFC §4) lands exactly where it says, in that thread or at the channel root, or it is refused with nothing posted (RFC §4's refusal result). The server never redirects it. An error after the request was dispatched leaves the outcome unconfirmed (RFC §5). A server MUST NOT declare `exact` for a channel where its platform could place a post somewhere other than the call named without saying so.
- **`root`**: the channel contains no threads, and every publish lands in the channel itself. A string `threadId` is refused with nothing posted, while `null` is honored. This is the fixed-channel case: Discord channels, DMs, and Discord threads, which are channels in their own right; single-channel worlds; a device's home channel.
- **absent**: no guarantee. A host MUST NOT rely on this channel's publication to land in a particular place. RFC §8's legacy publication, the default on such a channel, publishes without relying on it: the host reports each post as placed by the server, not as delivered to the conversation it answers.

A channel is **declared** when its descriptor carries `capabilities.publish.target` with the string value `exact` or `root`. Any other value, a non-string included, is no declaration, and the absent rules apply to the channel.

The declaration is per-channel descriptor data. It is **not** a capability path, it is not in the §6.2 vocabulary, and no advertisement shorthand (such as `channels: true`) implies it. It travels with the descriptor wherever the server sends one: `channels/register`, `channels/changed` and `channels/list` results. Changing it is an ordinary descriptor update.

**A declaration lasts as long as the registration that carried it,** as SPEC §4.2.4 says of a reconnect. A host doesn't act on a declaration from a connection that has closed, and a reconnect's registration states it again.

**A stale declaration.** A declaration describes a channel as the host last heard it. When a server can no longer place posts as it declared (its platform changed the channel's shape, say), and its grant doesn't yet allow `channels/changed` (which requires `channels.register`), it doesn't hide the change:
- it reports incoming messages as they are: a thread's messages with their `threadId`, even on a channel declared `root`. This is the one exception to the `root` rule below, on either lane (`channels/incoming`'s `threadId` and a push's `origin.threadId`). A host following RFC §8 then holds speech for that conversation, since a thread conversation is reachable only on an `exact` channel;
- it refuses any publish target the declaration the host holds doesn't allow;
- once its grant allows, it sends `channels/changed` before anything that depends on the declaration.

**Inbound thread ids are publish targets.** A host learns thread ids from what the server sends it about messages, so a declaration binds them:

- `threadId` on `channels/incoming` and `origin.threadId` on a push are a non-empty string or absent, never `null` or `""`. Where this RFC says a message "carries no `threadId`", the field is absent.
- on an `exact` channel, every `threadId` the server sends on `channels/incoming` for that channel MUST be accepted as a publish target for as long as that thread takes posts;
- on a `root` channel, `channels/incoming` messages MUST NOT carry `threadId`, except under a stale declaration (above). A channel whose messages can sit in threads is not `root`.
- a message that opens a thread sits at the channel root, so neither lane names a thread for it: no `threadId` on `channels/incoming`, no `origin.threadId` on a push. The replies inside its thread carry the thread. (A Slack thread's parent, whose `thread_ts` equals its own `ts`, is a root message; so is a Telegram forum topic's opening message.)
- a `push/event` that delivers a message (the push counterpart of `channels/incoming`) is bound the same way. SPEC §9.2 leaves `origin` server-defined, but hosts infer routes from pushes that deliver messages, so:
  - a push delivering a message from a declared channel MUST name that channel by its registered id, as `origin.mcplChannelId`. If the push is also channel-scoped under RFC-006, its `coalesce.channelId` MUST name the same channel;
  - a push delivering a message inside a thread of an `exact` channel MUST carry that thread as `origin.threadId`, in the same id space a publish to that channel accepts;
  - a push delivering a message at the channel root, or in a `root` channel, MUST NOT carry `origin.threadId`, except under a stale declaration (above).

  A host reads `origin.mcplChannelId` and `origin.threadId` from any push, from a declared channel or not, and binds a push to `origin.mcplChannelId` only when the pushing server has registered that channel, as SPEC §14.5 requires of `channels/incoming` at receipt. It binds `origin.threadId` only within that channel. A push naming any other channel names none. This is a reply route, not RFC-006's coalescing scope: `coalesce.channelId` keeps its own meaning. A channel or thread named only in some other `origin` field is invisible to a host's routes. A host infers no route from a push that only refers to a message (a reaction, an edit or a deletion), so it never answers one at the root of an `exact` channel on that push's strength; such a push may still name the channel.

**A server that implements this RFC MUST NOT ignore `threadId`.** On any channel, declared or not (including one whose declaration it has just withdrawn), it either honors the target as RFC §3 defines or refuses it as RFC §4 defines. The host acts on the declaration it holds when it sends, and there is no acknowledgement to wait for in the Notification form of `channels/changed`. So a withdrawal that races a targeted publish fails safe rather than posting somewhere unasked.

SPEC §14.3's and §14.4's examples put a `threadId` on a Discord channel id. Discord channels are `root` channels here, so when SPEC takes this RFC in, those examples name an `exact` channel, such as a Slack one. §14.4's `incoming.threadId` is in the same id space as a publish's.

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
- A host MUST NOT send `threadId` to a channel that is not declared (RFC §3). An older server ignores the field and posts where it likes, so only the host can keep the guarantee.
- A host MUST send a `channels/publish` that carries `threadId` as a Request. A Notification has no result, so its placement could never be confirmed (RFC §5).

**Server rules.** A server honors `threadId` as RFC §3 states. A target it cannot honor MUST be refused without posting, and the server MUST NOT fall back to the root or to another thread. Such targets include:
- a thread that does not exist, is not a thread of this channel, or is archived and closed to posting;
- a string `threadId` on a `root` channel;
- an invalid value.

A `channels/publish` Notification that carries `threadId` is honored exactly or not posted at all, never placed elsewhere. With no result to carry it, that refusal is silent.

**The refusal is a result, not an error.** It takes the form `{ "delivered": false, "reason": "…" }`, with no `messageId`, and it MUST carry `reason`. That result is the definitive statement that nothing was posted. A host's classification doesn't depend on `reason`: `delivered: false` with no `messageId` is failed either way. A server answers `delivered: false` only when nothing was posted. When something may have been posted (a partial multi-part send, say), it answers with a JSON-RPC error, which the host treats as unconfirmed (RFC §5). A server that answers a targeted publish it refuses with an error instead forfeits the refusal's statement in the same way.

## 5. Result and host verification (amends §14.3 result)

```jsonc
{ "delivered": true, "messageId": "…", "threadId": "1728291000.000100" }   // or null
{ "delivered": false, "reason": "thread 1728291000.000100 is archived" }   // a refusal: nothing posted
```

`threadId` in the result names where the post landed: the thread, or an explicit `null` for the root. It is REQUIRED whenever the request carried `threadId` and something was posted. It is taken from the platform's own response where the platform reports a place. Where the platform's response doesn't report one, it is the place the server's platform call named, which a server may echo only when that call either posts there or fails (RFC §3's `exact`). `reason` is REQUIRED on a refusal (RFC §4) and optional on every other result.

A host that sent `threadId` treats the outcome as follows:

| Result | Host outcome |
| --- | --- |
| `delivered: true` with an echoed `threadId` equal to the request | delivered, at that place |
| `delivered: true` with `threadId` missing (the key absent, for a root request too) or different | **unconfirmed**: something was posted, but not provably where asked |
| `delivered: false` with no `messageId` (a refusal, RFC §4) | failed, with nothing posted |
| `delivered: false` with a `messageId` | unconfirmed: a message id means something may exist |
| an error response, timeout, or lost connection after dispatch | unconfirmed |

A host MAY class SPEC §14.6's channel-level errors, `-32023` (Unknown channel) and `-32017` (Channel not permitted), as failed with nothing posted, since a server returns them before posting. Any other error after dispatch stays unconfirmed.

A request without `threadId` (legacy) needs no `threadId` in its result. A `delivered: true` result means posted where the server chose: the host reports it as placed by the server, not as delivered to a conversation, and a `threadId` the result carries names that place. Its other outcomes follow the host's existing rules.

**The channel context names the place (amends §14.4).** When a host includes `defaultOutgoing` in `context/beforeInference`'s channel context, it carries `threadId` exactly as the publish it describes will: a thread, or `null` for the root, on a declared channel, and nothing otherwise. So a server adapting to the context is never told a place no post will reach.

## 6. The outgoing stream (amends §14.3 `channels/outgoing/*`)

`channels/outgoing/chunk` and `channels/outgoing/complete` gain the same optional `threadId`, with the same values and meanings as RFC §4. A stream has one place per `(inferenceId, channelId)`: every chunk and the completion carry it, a completion sent on abort or error included, which carries the place its chunks did. A host sends `threadId` on a stream exactly when the publish it streams toward carries it, with the same value, and doesn't stream text bound for another place in the same channel during that inference. A server that renders streamed text visibly (a live message, for example) MUST render it only in that place, and MUST NOT render it visibly when the place is one it would refuse.

The stream stays advisory: delivery remains the final `channels/publish`. By §14.3's fail-closed rule, a host does not stream text it would not publish, so it streams nothing toward a conversation where RFC §8 has it hold speech. Speech that RFC §8's legacy publication publishes may be streamed like any legacy publish, with no `threadId`.

## 7. Compatibility

| Host | Server | Behavior |
| --- | --- | --- |
| old (never sends `threadId`) | old | unchanged |
| old | new (declares) | unchanged: the absent field keeps the legacy path |
| new | old (no declaration) | by default, legacy publication (RFC §8): the host publishes speech to the channel itself with no `threadId`, as a Request, and reports each post as placed by the server, and it holds speech for a conversation it knows to be in a thread. An operator may choose strict holding instead |
| new | new | targeted publication where declared: a thread or the root on an `exact` channel, and the root (`null`) on a `root` channel |

The change is additive: no existing field changes meaning, and an old server never receives `threadId` from a conforming host. This RFC defines two keys in `push/event`'s server-defined `origin`, `mcplChannelId` and `threadId`, for pushes that deliver a message (RFC §3). Servers can therefore release first. A host that adopts this RFC changes what *it* publishes to undeclared channels: by default it holds speech for a conversation it knows to be in a thread there, and publishes the rest as before, as a Request. That is a host decision. RFC §8 states what this RFC recommends, and the strict holding an operator may choose instead.

## 8. Host guidance (non-normative)

A host that routes a model's plain speech to the conversation it is answering (for example, Agent Framework's speech routes):

- on a declared channel, always sends the intended place (the thread, or `null` for the root);
- treats a thread conversation as reachable only on an `exact` channel. It holds speech for a thread conversation anywhere else for the resident to deliver deliberately, and points to the server's own send tools where the server lists them;
- on an undeclared channel, publishes speech to the channel itself by legacy publication (below), unless an operator has chosen strict holding for it;
- never substitutes the root for a thread it cannot reach;
- checks the echo (RFC §5) before treating a post as delivered;
- names that place in §14.4's channel context: `defaultOutgoing` carries `threadId` as its publish will (RFC §5).

**Legacy publication, the default on undeclared channels.** Holding all speech on undeclared channels would make adopting a host all-or-nothing. Once it upgraded, plain speech would be held on every channel that has not yet declared, including those of servers no coordinated release covers, such as third-party connectors, operator-local servers and test rigs. Every resident would move from plain speech to deliberate sends on upgrade day, unannounced to the people they talk with, and any resident who doesn't take the extra step would go quiet to them. The races legacy publication leaves are the ones every host had before this RFC. So on an undeclared channel a host keeps legacy publication by default:

- the host still never sends `threadId` there, so RFC §4's host rule holds, and the server chooses where each post lands, as before this RFC. The host sends each legacy `channels/publish` there as a Request, so every post has a result to report from;
- a conversation the host knows to be in a thread stays held there, as on any channel that is not `exact`, with the server's own send tools named. Legacy publication cannot place a post in a particular thread, so it covers speech to the channel itself;
- RFC §2's root race remains on every channel the host publishes to this way. The thread race remains only where the server delivers a thread's messages without naming the thread, since the host then takes a thread conversation for the channel's own and publishes to it. There is no echo to check: a result says whether something was posted, not where. So the host reports such a post as placed by the server, not as delivered to the conversation it answered (RFC §5's legacy row). Wherever it tells the model where its speech will go, it also says that on these channels the server chooses the place;
- a push that names its channel only in a server-specific `origin` field gives the host no route, so a reply to it is held in either mode;
- legacy publication applies whenever a channel is undeclared, including after its declaration is withdrawn. Once the channel's descriptor declares a target, the rules above apply to it.

The default has two costs an operator should know before upgrading:

- **The thread hold isn't small on thread-heavy channels.** Before this RFC a host published a thread conversation's speech through legacy placement too. So on an undeclared channel whose server names its threads, where most conversation happens in them, such as Slack threads or forum topics, most of a resident's speech moves to deliberate sends. The hold is still right there: published, that speech would land wherever the server chose, under the resident's name.
- **The hold lands on honest servers first.** A server that names thread ids on incoming lets the host see that a conversation is in a thread, so the host holds it. A server that hides them gets that speech published, with the thread race. A server already naming its thread ids is one step from declaring, so the hold's incentive points toward declaring.

**Strict holding.** An operator may choose strict holding for a channel, for a server, or for the whole host. The host then publishes nothing of its plain speech to an undeclared channel it covers, and holds all such speech for the resident to deliver deliberately, as for a thread conversation. That trades reach for certainty on the channels it covers, and lapses for a channel once its descriptor declares a target.

## 9. Security and privacy

No new authority: `channels.publish` gates the method as before. The declaration is a server's statement about its own behavior, and for a targeted publish, RFC §5's echo lets the host check the server's own account of each post, which catches a server that posts somewhere it didn't say. A push binds a route only to a channel its own server registered (RFC §3), so a server can name only its own channels, and a reply to it returns through it. Targeting a thread reveals nothing the channel did not already expose to the server.

## 10. Conformance vectors

Draft→Accepted requires executable vectors under `conformance/rfc-011/`, run against at least one `exact` server, one `root` server, and a channel its server never declares, through a real host:

1. A descriptor with `capabilities.publish.target` is accepted with its other `capabilities` members read as before. The declaration is not a capability path: it appears neither in the server's initialize capabilities (§5.1's advertisement) nor in the grant (§5.4). A descriptor whose `publish.target` is an unknown string, or not a string, is no declaration: the host sends it no `threadId`.
2. `exact`, with a string `threadId`: posted in that thread, and the echo is equal, even when a newer incoming message sits in a second thread of the channel (the thread race).
3. `exact`, with `null`: posted at the root, and the echo is an explicit `threadId: null`, even when a newer incoming message sits in a thread (the root race).
4. `exact`, with a `threadId` that is unknown, names a thread of another channel of the same server, or names an archived thread closed to posting: `delivered: false` with no `messageId`, and nothing posted at the root or anywhere else. The archived case needs a real platform where a stub can't archive, and is marked so.
5. `root`, with a string `threadId`: refused as a result, `{delivered: false, reason}` with no `messageId`, not as a JSON-RPC error, with nothing posted. With `null`: posted, and the echo is `null`.
6. Absent `threadId` on a declaring server: the legacy placement, and a result whose `threadId`, if it carries one, names where the post landed.
7. Host verification: a `delivered: true` result with a different echo, or without the `threadId` key (for a root request too), is unconfirmed; `delivered: false` with a `messageId` is unconfirmed; a JSON-RPC error, a timeout and a lost connection after dispatch are unconfirmed; a refusal is failed with nothing posted.
8. Host: an undeclared channel receives no `threadId` in either mode (RFC §8). In the default mode, legacy publication, speech the host routes to the channel itself is published with no `threadId`, as a Request, and reported as placed by the server, not as delivered to the conversation; a conversation the host knows to be in a thread is held; and the host's account of where speech goes says the server chooses. Under strict holding, chosen for the channel, its server or the host, plain speech the host routes to it is held, not published, and no `channels/outgoing/chunk` is sent for it. Once the channel's descriptor declares a target, neither mode applies and the declared rules govern.
9. `exact`: every `threadId` the server sent on incoming for the channel is accepted as a publish target. `root`: no incoming message carries `threadId`, unless the declaration has gone stale, when a thread's messages carry it and the host holds speech for that conversation. A message that opens a thread carries none, on either lane.
10. A declaration withdrawn by `channels/changed`, racing a targeted publish the host sends under the declaration it still holds, in a controlled order: the harness holds the server's `channels/changed` from the host until the host has sent the publish, so the server receives it after withdrawing. The publish is honored or refused, never posted elsewhere.
11. Invalid values (a number, `''`, an object) are refused with `{delivered: false, reason}`, with nothing posted and no `messageId`.
12. Host: a `channels/publish` carrying `threadId` is always a Request. Server: a `channels/publish` Notification carrying `threadId`, sent straight from the harness, is honored exactly or not posted, and nothing lands anywhere else.
13. Stream: the chunks and the completion carry `threadId` exactly when the final publish does, with the same value, a completion on abort included. A rendering server keeps visible streamed text in that place, and shows nothing visibly for a stream whose place it would refuse.
14. Push: a `push/event` delivering a message from a declared channel names that channel as `origin.mcplChannelId`, equal to its `coalesce.channelId` when it is channel-scoped. One delivering a message inside a thread of an `exact` channel also carries `origin.threadId`, and a host's reply to it lands in that thread. One delivering a root message, or a message in a `root` channel, carries none. A push naming a channel its server never registered binds no route.
15. Undeclared: a targeted publish sent straight from the harness to a channel the server never declared is honored or refused, never posted elsewhere.

Each vector names the platform boundary it used: a real platform, or a stub at the platform client. Behavior that only a real platform can establish (for example, what Slack does with a stale `thread_ts`) is marked as such.

## 11. Changelog

- Revision 1 (2026-10-07): initial draft.
- Revision 2 (2026-10-07): from Basil's review. The host rule becomes MUST NOT, and the refusal is a `{delivered: false, reason}` result. Incoming thread ids are bound to publish targets, a server never ignores `threadId` on a withdrawn declaration, `threadId` is Request-only, the stream carries the target, and the value domain is closed. Vectors 9–13 are added.
- Revision 3 (2026-10-07): the binding extends to `push/event`s that deliver a message from a declared channel: the push names its channel as `origin.mcplChannelId` (agreeing with `coalesce.channelId` when RFC-006 channel-scoped) and its thread as `origin.threadId`, with vector 14. This was found by composing a host with declaring connectors whose pushes named the thread, or the channel, only in server-specific fields.
- Revision 4 (2026-10-08): from slimepriestess's review of revision 3. RFC §8 names a migration setting a host may offer: legacy publication, never carrying `threadId`, on undeclared channels an operator names until they declare, with thread conversations still held and its cost stated. RFC §6 and §7 are worded to match, and vector 8 covers a host with or without it.
- Revision 4, continued (2026-10-09): RFC §3, the header and vector 1 no longer imply that SPEC §14.2 already has a descriptor `capabilities` object. It doesn't. mcpl-core-ts types one, with `history` and `acknowledgment`, and this RFC adds `publish` beside them. No rule changes.
- Revision 5 (2026-10-11): from a review of revision 4 by the house's review workflow, and from Agnes's review of a declaring connector.
  - **Declaration (RFC §3):** a declared channel is defined, and any other `publish.target` value is none. A server MUST NOT declare `exact` where its platform could place a post elsewhere unannounced. The declaration travels with every descriptor the server sends and lasts as long as its registration. A server with a stale declaration it can't correct reports incoming as it is (a thread's `threadId` even on a `root` channel, the one exception to the root rule, with the host holding that speech), refuses what the declaration doesn't allow, and sends `channels/changed` once its grant allows. Inbound `threadId`s are a non-empty string or absent, a thread's opening message names no thread, and a push binds a route only to a channel its server registered. A host reads the push keys from any push, and infers no route from a push that only refers to a message. A server MUST NOT ignore `threadId` on any channel. The migration setting is named as the absent rule's one exception, and SPEC's Discord examples are noted.
  - **Request (RFC §4):** a refusal MUST carry `reason`, `delivered: false` means nothing was posted, and a Notification carrying `threadId` is honored exactly or not posted.
  - **Result (RFC §5):** the echo's source where the platform reports no place, an explicit `null` for the root, the `delivered: false` with a `messageId` row stated on its own terms, channel-level errors that MAY be failed, and the legacy outcome.
  - **Stream (RFC §6):** one place per `(inferenceId, channelId)`, carried by a completion on abort, and the hold applies per conversation.
  - **Compatibility (RFC §7):** the declared-root row, and the two push `origin` keys.
  - **Channel context (RFC §5, amending §14.4):** `defaultOutgoing` carries `threadId` exactly as the publish it describes will, and nothing on an undeclared channel.
  - **Guidance (RFC §8):** under the migration setting each legacy publish is a Request, the residual races are stated exactly, and the setting applies after a withdrawal too.
  - **Security (RFC §9):** what the echo checks, and why a push's route adds no authority.
  - **Vectors (RFC §10):** most vectors gain cases that test the rules above, the criterion adds an undeclared channel, and vector 15 covers one.
- Revision 6 (2026-10-18): from slimepriestess's view of revision 5. On an undeclared channel, RFC §8's legacy publication becomes the default, with revision 5's semantics: speech to the channel itself is published as a Request with no `threadId` and reported as placed by the server, and a conversation the host knows to be in a thread is held. An operator may choose strict holding for a channel, a server or the whole host instead. RFC §8 states the default's two costs: the thread hold on thread-heavy channels, and that the hold lands first on servers that name thread ids. RFC §3's absent rule, RFC §6, RFC §7's table and vector 8 are worded to match.
