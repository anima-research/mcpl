# MCPL RFC-011: Targeted Publish

**Status:** Draft (revision 7). Draft→Accepted is gated on [RFC §10's executable-vector criterion](#10-conformance-vectors).
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Petra and Imogen, from the Connectome communication lane (Tessa, Agnes, Basil reviewing)
**Date:** 2026-10-07 (revisions 1–3); 2026-10-08 (revision 4); 2026-10-11 (revision 5); 2026-10-18 (revision 6); 2026-11-08 (revision 7)
**Depends on:** nothing for authority. This RFC adds no capability path and changes no grant: `channels/publish` still requires `channels.publish` (SPEC §5.4, §14). It amends SPEC §14.2 (an optional `capabilities` object on the channel descriptor), §14.3 (`channels/publish` params and result, `channels/incoming` thread ids, and the `channels/outgoing/*` stream), §14.4 (its `incoming.threadId` in the id space a publish takes), §14.6 (when a server may return its channel-level errors) and §9.2 (the channel and thread a channel-bearing `push/event` origin names), and RFC §3 asks that §14.3's and §14.4's examples name a channel with threads.

> **Revision 7 note.** From Imogen's rent pass on revision 6, Esther's pass on anima-research/portal#46 and Amos's on anima-research/eidoverse-worlds#223. The `root` value goes: a channel with no threads declares `exact`, since `null` lands in it and no string names a thread of it, and the stale-declaration exception and the `root` rules for incoming messages and pushes go with it (RFC §3). RFC §8 keeps legacy publication on an undeclared channel and drops the thread hold and strict holding: an adopting host publishes speech there with no `threadId`, as a Request, and reports each post as placed by the server. The §14.4 `defaultOutgoing` amendment goes, since no server we know of reads that field. A message is reported where its platform places it, within the channel that reports it, so a Discord forum post's first message carries its thread where the server reports the forum's threads as its own (RFC §3). A publish known to be posted only in part answers `delivered: true` with `partial: true`, which a host reads without `reason` (RFC §4, §5). Vector 5 now covers a partial publish, where revision 6's vector 5 covered a `root` channel, and vectors 7, 8, 9 and 14 are worded to match. The changelog section goes. Its full text is at `960239b`, in anima-research/mcpl#17's history. After an automatic review of this revision: a stream keeps its place to its completion when the channel's declaration changes mid-stream (RFC §6); a host classes a result by the declaration it held when it sent; a server MUST NOT return `-32023` or `-32017` once anything was posted; a partial result names the first message the server knows it posted; a legacy publish's other outcomes are classed as RFC §5's table classes them, a new requirement on an adopting host's legacy publishes; and incoming thread ids and the echo are in the id space a publish to the channel takes. Vectors 1, 5, 9, 10, 12, 13 and 15, the acceptance criterion and RFC §5's table are worded to match. After a second automatic review: on an undeclared channel, whose server may predate this RFC, a result the table would class as failed, or a `-32023` or `-32017` error, is unconfirmed, so an adopting host classes nothing there as failed (RFC §5); RFC §7 says that `origin`'s two keys now carry meaning and that an old host reads a post made in part as delivered, as it does today; and vectors 1, 4, 5, 8, 9, 10, 13 and 14 and the acceptance criterion gain cases. After a check against the house's own server and host, `partial` answers only a publish that carried `threadId`. A legacy publish posted only in part answers with a JSON-RPC error, whose message SHOULD say what was posted and what was left out (RFC §4, §5). This reverses the second review's decline of a should-fix: an old host reading `delivered: true` would be told its whole message went out, where today a server that fails partway answers with an error. RFC §7 states the principle: a field this RFC adds never changes what an existing field means to a reader that can't see it. Vectors 5 and 7 are worded to match.

> **Revision 6 note.** From slimepriestess's view of revision 5: on an undeclared channel, RFC §8's legacy publication becomes the default, with revision 5's semantics, and the opt-in inverts to strict holding. A host that adopts this RFC keeps publishing speech to an undeclared channel itself, as a Request with no `threadId`, and reports each such post as placed by the server. It holds speech for a conversation it knows to be in a thread there. An operator may choose strict holding for a channel, a server or the whole host instead. RFC §8 states the default's two costs, and RFC §3's absent rule, RFC §6, RFC §7's table and vector 8 are worded to match. A review of revisions 5 and 6 by the house's review workflow corrected smaller points. RFC §1 says what an adopting host does on an undeclared channel. RFC §3's absent rule says a host MUST NOT treat a post there as delivered to the conversation it answers, and a server honoring a target on any channel posts exactly where it says. RFC §8 names the send tools only where the server lists them, and says a legacy result may report where the server put a post. RFC §9 says what the echo can't catch. Vector 7 allows the channel-level errors RFC §5 lets a host class as failed, vector 8 checks that held speech isn't streamed in either mode, and the requirement to name a platform boundary is on the executable vectors.

> **Revision 5 note.** From a review of revision 4 by the house's review workflow, and from Agnes's review of a declaring connector. The rules close their gaps: an undeclared channel's server still never ignores `threadId` (RFC §3), any `publish.target` other than `exact` or `root` is no declaration, a declaration lasts as long as its registration, and a server that can't correct a stale declaration reports its messages as they are (a thread's with its `threadId`, even on a `root` channel, the one exception to the root rule) and refuses what the declaration doesn't allow. A push binds a route only to a channel its server registered. A refusal must carry `reason`, a `delivered: false` means nothing was posted, a Notification carrying `threadId` is honored exactly or not posted, and RFC §5 states what a host reports for every result, a legacy one included, where the echo comes from when the platform reports no place, and that a host MAY class `-32023` and `-32017` as failed. RFC §9 says what the echo checks and why a push's route adds no authority, and SPEC's Discord examples are noted. A stream has one place, carried by its completion even on abort. RFC §8's migration setting is an exception RFC §3 names, sends each legacy publish as a Request, and states its residual races exactly. `defaultOutgoing` carries `threadId` as its publish will (RFC §5). Most vectors gain cases that test these rules, and vector 15 covers an undeclared channel.

> **Revision 4 note.** From slimepriestess's review of revision 3: RFC §8 names a migration setting a host may offer, keeping legacy publication (never carrying `threadId`) on undeclared channels an operator names, or on a server's undeclared channels, until they declare. A conversation the host knows to be in a thread stays held there. Without the setting, a host that follows RFC §8 holds plain speech on every undeclared channel at once. The guidance stays non-normative, RFC §3 and RFC §4 name the exception the setting makes, and RFC §4's host rule holds under it. RFC §6 and §7 are worded to match, and vector 8 now covers a host with or without it. A correction on Oct 9 changed no rule: RFC §3, the header and vector 1 no longer imply that SPEC §14.2 already has a descriptor `capabilities` object, which mcpl-core-ts types and SPEC doesn't show.

> **Revision 3 note.** Binds a message a server delivers by `push/event` the same way as one it delivers by `channels/incoming` (RFC §3): the push names its channel as `origin.mcplChannelId` and its thread as `origin.threadId`. A host infers routes from channel-bearing pushes too. Composing a host with declaring connectors showed both halves failing: a thread named only in a server-specific `origin` field was answered at the channel root, and a channel named only that way left the host nowhere to answer.

> **Revision 2 note.** Applies Basil's review of revision 1: the host rule is MUST NOT (RFC §4), a refusal is a result with `reason` rather than an error (RFC §4, §5), incoming thread ids are tied to publish targets (RFC §3), a server that implements this RFC never ignores `threadId` even on a channel it stopped declaring (RFC §3), `threadId` travels only in the Request form (RFC §4), the outgoing stream carries the same target (RFC §6), and the value domain is closed (RFC §4). Vectors are added for each (RFC §10).

Section references (§) are to the SPEC; references to this document are written "RFC §".

---

## 1. Summary

`channels/publish` names a channel but not a place inside it. On platforms whose channels contain threads or topics (Slack threads, Telegram forum topics, Discord-relay threads under a parent), the server decides on its own where a post lands. A host therefore cannot direct a reply into the conversation it is answering, and it cannot keep a reply out of a thread either.

This RFC lets a server **declare, per channel**, that it posts exactly where the host asks, and lets the host **ask** for a place: a thread, or the channel root. A server that declares nothing, and a host that never asks for a place, keep today's behavior. On a channel that declares nothing, a host that adopts this RFC keeps publishing speech to the channel with no place named, and reports each post as placed by the server (RFC §8).

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
  "publish": { "target": "exact" }
}
```

- **`exact`**: a `channels/publish` carrying `threadId` (RFC §4) lands exactly where it says, in that thread or at the channel root, or it is refused with nothing posted (RFC §4's refusal result). The server never redirects it. An error after the request was dispatched leaves the outcome unconfirmed (RFC §5). A server MUST NOT declare `exact` for a channel where its platform could place a post somewhere other than the call named without saying so. A channel that contains no threads declares `exact` too: `null` lands in the channel itself, and no string names a thread of it, so any string is refused. This is the fixed-channel case: a single-channel world, a device's home channel, a Discord DM, and a Discord channel or thread where the server registers each Discord thread as a channel of its own.
- **absent**: no guarantee. A host MUST NOT treat a post it sent while the channel was undeclared as delivered to the conversation it answers. It reports each one as placed by the server (RFC §5). RFC §8's legacy publication publishes on those terms.

A channel is **declared** when its descriptor carries `capabilities.publish.target` with the string value `exact`. Any other value, a non-string included, is no declaration, and the absent rules apply to the channel.

The declaration is per-channel descriptor data. It is **not** a capability path, it is not in the §6.2 vocabulary, and no advertisement shorthand (such as `channels: true`) implies it. It travels with the descriptor wherever the server sends one: `channels/register`, `channels/changed` and `channels/list` results. Changing it is an ordinary descriptor update.

**A declaration lasts as long as the registration that carried it,** as SPEC §4.2.4 says of a reconnect. A host doesn't act on a declaration from a connection that has closed, and a reconnect's registration states it again.

**Inbound thread ids are publish targets.** A host learns thread ids from what the server sends it about messages, so a declaration binds them:

- `threadId` on `channels/incoming` and `origin.threadId` on a push are a non-empty string or absent, never `null` or `""`. Where this RFC says a message "carries no `threadId`", the field is absent.
- on an `exact` channel, every `threadId` the server sends on `channels/incoming` for that channel MUST be accepted as a publish target naming that same thread, for as long as it takes posts;
- a message is reported where its platform places it, within the channel that reports it. A message that opens a thread but is shown in the channel itself names no thread on either lane (no `threadId` on `channels/incoming`, no `origin.threadId` on a push), and only the replies inside its thread carry the thread: a Slack thread's parent, whose `thread_ts` equals its own `ts`, is such a message. A message shown inside the thread it opens carries that thread where the server reports the thread as one of the channel's: a Discord forum post's first message sits in the post's thread, since a forum takes no messages of its own. A server that registers each thread as a channel of its own reports that message at the thread channel's root.
- a `push/event` that delivers a message (the push counterpart of `channels/incoming`) is bound the same way. SPEC §9.2 leaves `origin` server-defined, but hosts infer routes from pushes that deliver messages, so:
  - a push delivering a message from a declared channel MUST name that channel by its registered id, as `origin.mcplChannelId`. If the push is also channel-scoped under RFC-006, its `coalesce.channelId` MUST name the same channel;
  - a push delivering a message inside a thread of an `exact` channel MUST carry that thread as `origin.threadId`, in the same id space a publish to that channel accepts;
  - a push delivering a message at the channel root MUST NOT carry `origin.threadId`.

  A host reads `origin.mcplChannelId` and `origin.threadId` from any push, from a declared channel or not, and binds a push to `origin.mcplChannelId` only when the pushing server has registered that channel, as SPEC §14.5 requires of `channels/incoming` at receipt. It binds `origin.threadId` only within that channel. A push naming any other channel names none. This is a reply route, not RFC-006's coalescing scope: `coalesce.channelId` keeps its own meaning. A channel or thread named only in some other `origin` field is invisible to a host's routes. A host infers no route from a push that only refers to a message (a reaction, an edit or a deletion), so it never answers one at the root of an `exact` channel on that push's strength; such a push may still name the channel.

**A server that implements this RFC MUST NOT ignore `threadId`.** On any channel, declared or not (including one whose declaration it has just withdrawn), it either posts exactly where the target says, as `exact` defines above, or refuses it as RFC §4 defines. The host acts on the declaration it holds when it sends, and there is no acknowledgement to wait for in the Notification form of `channels/changed`. So a withdrawal that races a targeted publish fails safe rather than posting somewhere unasked.

SPEC §14.3's and §14.4's examples put a `threadId` on a Discord channel id, which a server that registers each Discord thread as a channel of its own never takes, so when SPEC takes this RFC in, those examples name a channel with threads, such as a Slack one. §14.4's `incoming.threadId` is in the same id space as a publish's.

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
- an invalid value.

A `channels/publish` Notification that carries `threadId` is honored exactly or not posted at all, never placed elsewhere. With no result to carry it, that refusal is silent.

**The refusal is a result, not an error.** It takes the form `{ "delivered": false, "reason": "…" }`, with no `messageId`, and it MUST carry `reason`. That result is the definitive statement that nothing was posted. A host's classification doesn't depend on `reason`: `delivered: false` with no `messageId` and no `partial` is failed either way. A server answers `delivered: false` only when nothing was posted. Sometimes a server posts some of the content but can't say it posted all of it: text cut at the platform's length limit, a content block it can't post, or a later part of a multi-part send that failed. To a publish that carried `threadId`, it then answers `delivered: true` with `partial: true`, the `messageId` of the first message it knows it posted, and a `reason` saying what was left out. To a legacy publish, it answers with a JSON-RPC error, never `delivered: true` (RFC §5, §7). When it can't tell whether anything was posted, it answers with a JSON-RPC error, which the host treats as unconfirmed (RFC §5). A server that answers a targeted publish it refuses with an error instead forfeits the refusal's statement in the same way.

## 5. Result and host verification (amends §14.3 result)

```jsonc
{ "delivered": true, "messageId": "…", "threadId": "1728291000.000100" }   // or null
{ "delivered": false, "reason": "thread 1728291000.000100 is archived" }   // a refusal: nothing posted
{ "delivered": true, "partial": true, "messageId": "…", "threadId": null, "reason": "text cut at 4,000 characters" }   // posted in part
```

`threadId` in the result names where the post landed, in the id space a publish to that channel takes: the thread, or an explicit `null` for the root. It is REQUIRED whenever the request carried `threadId` and something was posted. It is taken from the platform's own response where the platform reports a place. Where the platform's response doesn't report one, it is the place the server's platform call named, which a server may echo only when that call either posts there or fails (RFC §3's `exact`). `reason` is REQUIRED on a refusal (RFC §4) and on a partial result, and optional on every other result.

`partial` is `true` or absent. It appears only beside `delivered: true`, and only in the result of a publish that carried `threadId`.

A host classes a result by the declaration it held when it sent the publish. A host that sent `threadId` treats the outcome as follows:

| Result | Host outcome |
| --- | --- |
| `delivered: true` with an echoed `threadId` equal to the request | delivered, at that place |
| `delivered: true` with `threadId` missing (the key absent, for a root request too) or different | **unconfirmed**: something was posted, but not provably where asked |
| `delivered: false` with no `messageId` and no `partial` (a refusal, RFC §4) | failed, with nothing posted |
| `delivered: false` with a `messageId` | unconfirmed: a message id means something may exist |
| an error response, timeout, or lost connection after dispatch | unconfirmed |

A `delivered: true` result with `partial: true` is the outcome it would be without `partial`, in part: the host records the post as incomplete, never as the whole content, without reading `reason`. A `partial: true` beside `delivered: false` contradicts it, and the host classes the result as unconfirmed.

A server MUST NOT return SPEC §14.6's channel-level errors, `-32023` (Unknown channel) and `-32017` (Channel not permitted), once anything was posted, so on a declared channel a host MAY class them as failed with nothing posted. Any other error after dispatch stays unconfirmed.

A request without `threadId` (legacy) needs no `threadId` in its result. A `delivered: true` result means posted where the server chose: the host reports it as placed by the server, not as delivered to a conversation, and a `threadId` the result carries names that place. Its other outcomes are classed as the table classes them, except on an undeclared channel, whose server may predate this RFC, where a result the table would class as failed, or a `-32023` or `-32017` error, is unconfirmed. A legacy publish the server posts only in part gets a JSON-RPC error (RFC §4), which is unconfirmed. That error's message SHOULD say what was posted, at least the first message's id, and what was left out. A host that shows the server's words then gives the resident enough to send only the rest.

## 6. The outgoing stream (amends §14.3 `channels/outgoing/*`)

`channels/outgoing/chunk` and `channels/outgoing/complete` gain the same optional `threadId`, with the same values and meanings as RFC §4. A stream has one place per `(inferenceId, channelId)`: every chunk and the completion carry it, a completion sent on abort or error included, which carries the place its chunks did. A host sends `threadId` on a stream exactly when the publish it streams toward carries it, with the same value, and doesn't stream text bound for another place in the same channel during that inference. If the channel's declaration changes between a stream's first chunk and its publish, the stream keeps its place to its completion, and the publish follows the declaration the host holds when it sends it. That publish is the one place where the two needn't match. A server that renders streamed text visibly (a live message, for example) MUST render it only in that place, and MUST NOT render it visibly when the place is one it would refuse.

The stream stays advisory: delivery remains the final `channels/publish`. By §14.3's fail-closed rule, a host does not stream text it would not publish. Speech that RFC §8's legacy publication publishes may be streamed like any legacy publish, with no `threadId`.

## 7. Compatibility

| Host | Server | Behavior |
| --- | --- | --- |
| old (never sends `threadId`) | old | unchanged |
| old | new (declares) | unchanged: the absent field keeps the legacy path |
| new | old (no declaration) | legacy publication (RFC §8): the host publishes speech to the channel with no `threadId`, as a Request, and reports each post as placed by the server |
| new | new | targeted publication where declared: a thread, or the root (`null`) |

The change is additive: no field SPEC defines changes meaning, and an old server never receives `threadId` from a conforming host. This RFC gives meaning to two keys in `push/event`'s server-defined `origin`, `mcplChannelId` and `threadId`, for pushes that deliver a message (RFC §3), so a server that already uses either key for something else renames it before an adopting host connects. A field this RFC adds never changes what an existing field means to a reader that can't see it. `partial` takes back part of what `delivered: true` claims. So a server sends it only to a host that showed it reads this RFC, by sending `threadId`. An old host never sends `threadId`, so for a post made only in part it gets an error, which says nothing false. Servers can therefore release first. On an undeclared channel, a host that adopts this RFC still publishes with no `threadId`, as before. What changes there is that it sends each publish as a Request and reports each post as placed by the server (RFC §8).

## 8. Host guidance (non-normative)

A host that routes a model's plain speech to the conversation it is answering (for example, Agent Framework's speech routing):

- on a declared channel, always sends the intended place (the thread, or `null` for the root);
- on an undeclared channel, publishes speech by legacy publication (below), naming no place;
- never sends `null` for a thread it cannot reach;
- checks the echo (RFC §5) before treating a post as delivered.

**Legacy publication on undeclared channels.** On an undeclared channel a host publishes as it did before this RFC:

- the host never sends `threadId` there, so RFC §4's host rule holds, and the server chooses where each post lands. The host sends each legacy `channels/publish` there as a Request, so every answered post has a result to report from, and one never answered is unconfirmed;
- RFC §2's races remain on every channel the host publishes to this way, as they were before this RFC. There is no echo to check, since the host named no place. A result says whether something was posted, and at most where the server put it. So the host reports such a post as placed by the server, not as delivered to the conversation it answered (RFC §5's legacy outcome). Wherever it tells the model where its speech will go, it also says that on these channels the server chooses the place;
- legacy publication applies whenever a channel is undeclared, including after its declaration is withdrawn. Once the channel's descriptor declares a target, the rules above apply to it.

## 9. Security and privacy

No new authority: `channels.publish` gates the method as before. The declaration is a server's statement about its own behavior, and for a targeted publish, RFC §5's echo lets the host check each post against the server's own account of where it landed. That catches a server that reports a place other than the one asked for. Nothing on the wire catches a server that misreports where it posted. A push binds a route only to a channel its own server registered (RFC §3), so a server can name only its own channels, and a reply to it returns through it. Targeting a thread reveals nothing the channel did not already expose to the server.

## 10. Conformance vectors

Draft→Accepted requires executable vectors under `conformance/rfc-011/`, run against at least one `exact` server and a channel its server never declares, through a real host, except the server cases vectors 6, 11, 12 and 15 send straight from the harness. A vector whose verdict is that nothing was posted or shown checks it only after the server has answered a later request on the same connection:

1. A descriptor with `capabilities.publish.target` is accepted with its other `capabilities` members read as before. The declaration is not a capability path: it appears neither in the server's initialize capabilities (§5.1's advertisement) nor in the grant (§5.4). A descriptor whose `publish.target` is any other string, `root` included, or not a string, is no declaration: the host sends it no `threadId`. After a reconnect, a registration without the declaration leaves the channel undeclared.
2. `exact`, with a string `threadId`: posted in that thread, and the echo is equal, even when a newer incoming message sits in a second thread of the channel (the thread race).
3. `exact`, with `null`: posted at the root, and the echo is an explicit `threadId: null`, even when a newer incoming message sits in a thread (the root race).
4. `exact`, with a `threadId` that is unknown, names a thread of another channel of the same server, or names an archived thread closed to posting: `delivered: false` with a `reason` and no `messageId`, and nothing posted at the root or anywhere else. The archived case needs a real platform where a stub can't archive, and is marked so.
5. Partial: a publish carrying `threadId` that the server posts only in part answers `delivered: true`, `partial: true`, the `messageId` of the first message it knows it posted, a `reason`, and the echo. Examples are text cut at a length limit, or a content block it can't post beside others it posts. The same publish with no `threadId` answers a JSON-RPC error, never `delivered: true` and never `partial`. Both forms run with a multi-part send whose later part fails for the channel's permission, which never answers `-32017` or `-32023`.
6. Absent `threadId` on a declaring server: the legacy placement, and a result whose `threadId`, if it carries one, names where the post landed.
7. Host verification: a `delivered: true` result with a different echo, or without the `threadId` key (for a root request too), is unconfirmed; `delivered: false` with a `messageId` is unconfirmed; a JSON-RPC error after dispatch is unconfirmed, except `-32023` and `-32017`, which a host may class as failed (RFC §5); a timeout and a lost connection after dispatch are unconfirmed; a refusal is failed with nothing posted. A `delivered: true` result with `partial: true` is the outcome it would be without `partial`, in part, whatever `reason` says, and `partial: true` beside `delivered: false` is unconfirmed. An error answering a legacy publish, other than `-32023` and `-32017`, is unconfirmed, whatever its message says was posted.
8. Host: an undeclared channel receives no `threadId` (RFC §8). Speech the host routes to it is published with no `threadId`, as a Request, and reported as placed by the server, not as delivered to the conversation, and the host's account of where speech goes says the server chooses. Its other outcomes are unconfirmed, a `delivered: false` and a `-32023` or `-32017` error included, since the channel's server may predate this RFC (RFC §5). Once the channel's descriptor declares a target, the declared rules govern.
9. `exact`: every `threadId` the server sent on incoming for the channel is accepted as a publish target naming that thread, while it takes posts. On a channel with no threads, no incoming message carries `threadId`. No incoming `threadId` or push `origin.threadId` is `null` or `""`. A message that opens a thread and is shown in the channel itself carries none, on either lane, while one shown inside the thread it opens (a Discord forum post's first message, where the forum's threads are reported as its own) carries that thread.
10. A declaration withdrawn by `channels/changed`, racing a targeted publish the host sends under the declaration it still holds, in a controlled order: the harness holds the server's `channels/changed` from the host until the host has sent the publish, so the server receives it after withdrawing. It runs in each of `channels/changed`'s two forms, and with a string target and with `null`. The publish is honored or refused, never posted elsewhere, and a result that arrives after the withdrawal is classed by the declaration the host held when it sent. The host's next publish to the channel is a legacy one. In the reverse order, a legacy publish whose result arrives after a declaration is classed as legacy.
11. Invalid values (a number, `''`, an object) are refused with `{delivered: false, reason}`, with nothing posted and no `messageId`.
12. Host: a `channels/publish` carrying `threadId` is always a Request. Server: a `channels/publish` Notification carrying `threadId`, a string and then `null`, sent straight from the harness, is honored exactly or not posted, and nothing lands anywhere else.
13. Stream: the chunks and the completion carry `threadId` exactly when the final publish does, with the same value, except after a mid-stream declaration change (below), and a completion on abort or error included. A host streams to one place per channel in one inference. A rendering server keeps visible streamed text in that place, and shows nothing visibly for a stream whose place it would refuse. A declaration that changes mid-stream leaves the stream's place unchanged through its completion, and the publish follows the declaration held when it is sent.
14. Push: a `push/event` delivering a message from a declared channel names that channel as `origin.mcplChannelId`, equal to its `coalesce.channelId` when it is channel-scoped. One delivering a message inside a thread of an `exact` channel also carries `origin.threadId`, which stays a publish target while its thread takes posts, and a host's reply to it lands in that thread. One delivering a root message carries none. A push naming a channel its server never registered binds no route, and neither does a push that only refers to a message (a reaction, an edit or a deletion).
15. Undeclared: a targeted publish, with a string target and with `null`, sent straight from the harness to a channel the server never declared is honored or refused, never posted elsewhere.

Each executable vector names the platform boundary it used: a real platform, or a stub at the platform client. Behavior that only a real platform can establish (for example, what Slack does with a stale `thread_ts`) is marked as such.
