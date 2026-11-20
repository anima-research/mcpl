# MCPL RFC-008: Tool Classes

**Status:** Draft (revision 2). Draft→Accepted is gated on [RFC §10's executable-vector
criterion](#10-conformance-vectors).
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra
**Date:** 2026-09-30 (revisions 1, 2)
**Depends on:** nothing for authority. This RFC adds no capability path and changes no grant;
RFC-002 / SPEC §5.4 remains the sole source of what a connected server may do. It defines a
**hint** that hosts may use as an input to policy. Amends SPEC §13 (new §13.6), Appendix B.4
(enum), Changelog. Used by RFC-007.

Section references (§) are to the SPEC; references to this document are written "RFC §".

> **Revision 2 note.** Settles the `_meta` key, which servers will hardcode and which is
> therefore hard to change after adoption (formerly open question 1): `mcpl/class` is valid
> under MCP's key rules and outside MCP's reserved space, and the `mcpl/` prefix is now
> reserved for keys MCPL defines (RFC §3). Retargets the SPEC section to §13.6, since §13.5
> now holds RFC-005's locators and references. Adds the acceptance criterion (RFC §10).
> No change to the vocabulary, precedence, or trust model.

---

## 1. Summary

A host executes tools it did not write and cannot classify. It knows a tool's name, its
schema, and which connection provides it. It does not know whether calling the tool sends a
message to another person, writes the agent's diary, runs a shell command, or moves the
mouse. Every policy question that turns on that distinction — what to show an observer, what
to approve, what to audit, what to cap — is answered today by tool-name pattern lists that
each operator writes by hand and that break when a server renames a tool.

This RFC lets the providing server say what each tool **does**, in a rough, fixed
vocabulary of **classes**:

```
comms  memory  notes  files  shell  web  computer  media  body  control
```

The class rides on the MCP tool definition, in `_meta`, as `mcpl/class`. It is a hint, in
the same trust tier as MCP's `annotations`. The host computes an **effective class** per tool
from the server's hint, its own knowledge of its built-in tools, and operator overrides, and
uses it as a key for policy. A tool with no class is treated as the most restrictive class
for every question asked of it, so classing is how a server earns looser handling, never how
it is denied.

## 2. Motivation

- **Privacy policy needs the distinction, and only the server has it.** RFC-007 lets a
  server observe other tools' calls, and under a further grant their arguments. The
  arguments of a messaging tool are the agent's side of a private conversation with a person
  who is not party to any grant. The host should never send those, and it should not depend
  on an operator remembering that `discord--send`, `zulip--dm`, `say`, and `mail--compose`
  are all the same kind of thing.
- **Approvals.** Hosts that gate tool calls on approval want a rule like "shell and files
  ask, memory and body do not." Today that is a name list per deployment.
- **Audit and caps.** Grouping a session's tool use by what it did, and capping work by kind,
  both want the same key.
- **Observers.** An embodiment server that acts out tool use (RFC-007) wants to say "point
  for `computer`, prop for `shell`, nothing for `comms`" without knowing a deployment's tool
  names. Class gives it a portable vocabulary.

**Why not infer it.** Names are suggestive but unreliable across servers and languages,
schemas do not say what a side effect is, and MCP's existing hints (`readOnlyHint`,
`destructiveHint`, `openWorldHint`) describe *risk shape*, not *domain*. A `comms` tool and a
`files` write are both non-read-only, non-destructive, and open-world.

## 3. The class slot

Tools are MCP tool definitions (`tools/list`). MCP reserves `_meta` on `Tool` for
extensions, with prefixed keys. This RFC uses:

```jsonc
{
  "name": "send_message",
  "description": "Send a message to a channel or user",
  "inputSchema": { "…": "…" },
  "_meta": { "mcpl/class": ["comms"] }
}
```

- **`mcpl/class`** is an array of one or more `ToolClass` strings (RFC §4).
- It is an array because tools straddle: a tool that sends a file to a person is `comms` and
  `files`. A host applies the **union of restrictions** across every class named, so naming
  more classes can only make handling stricter (RFC §5.3).
- Unknown class strings are ignored for policy and SHOULD be logged; a tool whose only
  classes are unknown is unclassed (RFC §5.2).
- The slot is at MCP level, so a plain MCP server (not MCPL) can carry it too, and an MCPL
  host reads it from either.

**The key.** MCP (2025-06-18, Basic → General fields → `_meta`) defines a key as an optional
prefix — dot-separated labels followed by a slash — and a name, and reserves for itself any
prefix whose labels include `mcp` or `modelcontextprotocol` followed by a further label
(`mcp.dev/`, `tools.mcp.com/`). `mcpl/` is a single label followed by a slash, so it is a
valid prefix and is not in MCP's reserved space; `class` is a valid name. **The `mcpl/`
prefix is reserved for keys this specification defines.** Servers and hosts MUST NOT use
`mcpl/`-prefixed `_meta` keys for anything else, and a host MUST ignore an `mcpl/` key that
this specification does not define (and SHOULD log it), rather than guess at its meaning.

Servers SHOULD class every tool they expose. A server that changes a tool's class announces
it as any tool change, via `notifications/tools/list_changed`; the host recomputes the
effective class on re-list.

## 4. Vocabulary

| Class | The tool… |
|---|---|
| `comms` | sends to, or reads from, **other parties**: chat, DM, email, posting, calls, voice to a person. Both directions. |
| `memory` | reads or writes the **agent's own** recall: journals, diaries, memory stores, history of its own context. |
| `notes` | reads or writes **documents the agent authors**: wiki pages, task lists, drafts, knowledge bases. |
| `files` | reads or writes a **filesystem** or blob store: paths, contents, listings. |
| `shell` | **executes** commands or code: shells, interpreters, build and test runners. |
| `web` | fetches, searches, or browses the **public network**. |
| `computer` | drives a **GUI**: screen capture, pointer, keyboard, window management. |
| `media` | **generates or plays** images, audio, or video that are not messages to a person. |
| `body` | the agent's **embodiment and presence**: avatar, expression, status, TTS output not addressed to a person. |
| `control` | **host and agent settings**: spawning, lifecycle, configuration, grants, budgets. |

Edges, decided:

- Speech that reaches a person is `comms`, wherever it goes. A `say` tool that publishes to a
  chat surface is `comms`, not `body`, even when the same server also animates a mouth.
- Reading a person's messages is `comms`. The direction does not change what the data is.
- A memory tool that stores *other people's* words verbatim is `memory` and `comms`.
- A tool that runs code which may do anything (`execute_python`) is `shell`. Its
  consequences are unknowable; the class describes the tool, not the script.
- `web` is for the public network. A tool that fetches from the agent's own services or
  private documents is `files` or `notes`.

The vocabulary is deliberately coarse. A finer taxonomy would be argued about per tool and
would not be applied consistently across servers written by different people. Ten classes
that every author places a tool in within a few seconds are worth more than fifty that need
a guide. New classes are added by amendment to Appendix B.4, not by servers inventing them.

## 5. Effective class

### 5.1 Sources

A host computes each tool's effective class from, in precedence order:

1. **Operator override**, by host policy, keyed on the model-facing tool name (pattern
   syntax host-defined, as for §14.5 narrowing).
2. **The host's own knowledge** of tools it implements itself.
3. **The server's declaration** in `mcpl/class`.

The first source that yields a class wins entirely; sources are not merged. An override that
names a tool replaces the server's declaration, so that an operator can correct a
misclassed tool or tighten one.

### 5.2 Unclassed

A tool with no effective class is **unclassed**. For every policy question a host asks of
class, an unclassed tool MUST be treated as the most restrictive answer any class would give.
Under RFC-007, that is: metadata may be observed under grant, arguments never. Under an
approval policy, it asks. Under a cap, it counts against the tightest cap.

This is the deny-safe reading. A server that says nothing is handled as if its tool might
be `comms`; classing is how it earns anything looser.

### 5.3 Multiple classes

Where a tool has several classes, a host MUST apply the union of restrictions: the tool is
subject to every rule that applies to any of its classes. A host asking "may this tool's
arguments be shown?" answers no if any class says no. A host asking "does this call need
approval?" answers yes if any class says yes.

## 6. Trust

The class is the providing server's statement about its own tools, at the same tier as MCP
`annotations`: **a hint, not a claim the host verifies.** What a lie can do:

- A server that **over-classes** (says `comms` for a shell tool) gets its tool handled more
  strictly. It harms only itself.
- A server that **under-classes** (says `shell` for a messaging tool) can cause a host to
  treat its arguments as less sensitive than they are — for example, to send them to an
  RFC-007 observer. The data so exposed is data the lying server already holds and could
  forward out of band. The class cannot affect how *another* server's tools are handled.

So misclassing widens exposure only of what the liar already has. That is why the hint is
sufficient for policy without being a security boundary. The boundary remains the grant
(§5.4); the class decides how a host exercises its own discretion under it. Operators who
distrust a server's classing override it (RFC §5.1) or, as always, narrow the grant.

Hosts SHOULD show a tool's effective class and its source to operators next to the grant
(§13.2), so that a surprising class is visible before it matters.

## 7. What class does not do

- It confers no authority and gates no method. A tool's class does not change whether the
  agent may call it, or whether the providing server may do anything.
- It is not a description for the model. Hosts MUST NOT alter a tool's model-facing
  description or schema based on class. The model sees the tool as the server wrote it.
- It is not a content type. Whether an argument is an image or a string is the schema's job.
- It is not a rating of danger. MCP's `destructiveHint` and `openWorldHint` remain the place
  for that, and hosts may use both.

## 8. Uses in other RFCs

- **RFC-007** (tool lifecycle) keys `toolLifecycle.inputs` narrowing on class, excludes
  `comms` arguments from observation unconditionally, and lets a server's `tools/observe`
  filter match on class.
- Future: approval policy by class, audit grouping, workspace caps, and RFC-005 content
  references keyed on what produced the content.

## 9. Spec amendments

1. **§13.6 (new) Tool classes:** RFC §3, §5, §6, §7, including the reservation of the
   `mcpl/` `_meta` prefix.
2. **Appendix B.4:** add **ToolClass:** `"comms" | "memory" | "notes" | "files" | "shell" |
   "web" | "computer" | "media" | "body" | "control"`.
3. **Changelog:** record the `mcpl/class` slot and the vocabulary.

No new methods, capability paths, or error codes.

## 10. Conformance vectors

1. **Declared.** Server declares `_meta: {"mcpl/class": ["shell"]}` on `run`. Host's effective
   class for `s--run` is `["shell"]`.
2. **Unclassed.** Server declares nothing on `go`. Host treats `s--go` as unclassed: under
   RFC-007, `input` is never sent for it whatever the grant.
3. **Unknown string.** Server declares `["quantum"]`. Host logs, treats the tool as
   unclassed.
4. **Mixed.** Server declares `["shell", "quantum"]`. Effective class `["shell"]`.
5. **Multiple, union.** Server declares `["files", "comms"]` on `send_file`. A policy that
   permits `files` arguments and forbids `comms` arguments forbids them for this tool.
6. **Override wins.** Server declares `["body"]` on `speak`; operator policy classes `s--speak`
   as `["comms"]`. Effective class `["comms"]`, source "override".
7. **Host built-in.** A host-implemented `say` tool has the class the host assigns, which is
   `comms`.
8. **Re-list.** Server changes `run` to `["shell", "files"]` and sends
   `notifications/tools/list_changed`. After re-list the effective class is updated.
9. **No model effect.** With any class, the tool's description and schema as sent to the
   model are byte-identical to what the server provided.
10. **Malformed slot.** Server declares `_meta: {"mcpl/class": "shell"}` (a string, not an
    array). Host treats the tool as unclassed and SHOULD log it.
11. **Reserved prefix.** Server declares `_meta: {"mcpl/priority": "high"}`, a key this
    specification does not define. Host ignores it for every purpose (and SHOULD log it);
    the tool's effective class is unaffected.

**Acceptance criterion:** before this RFC moves Draft→Accepted, these vectors freeze as
executable vectors under `conformance/` (the RFC-003 §3.1 precedent, as RFC-005 §11 also
requires) and run against at least one host implementation. agent-framework PR #199
implements this revision's host side.

### Running the executable vectors

The frozen cases are in [`conformance/tool-class-vectors.json`](./conformance/tool-class-vectors.json). They retain the eleven case numbers above. Case 5 adds a files-only positive control and a shell-only tool outside the files narrowing, case 8 re-lists twice and ends with `["files"]` alone, so a Host that merges declarations fails it, case 9 checks all ten known classes, and case 11 includes a priority-only unclassed tool, for 26 stages in total. Each stage's description and input schema name its case and stage, so a Host still showing an earlier listing fails that stage. Before loading a Host adapter, coverage guards check the eleven case numbers, each case's origin and stage count, that each stage's description and schema differ from the stage before it, the ten distinct model-surface classes, and the priority-only control, so they accept only this profile's eleven cases. Expected class and argument-treatment outcomes are stored in the JSON rather than derived by a reference implementation.

Run the [checker](./conformance/check-tool-classes.mjs) with Bun against a local Agent Framework checkout. This adapter imports that checkout's TypeScript source and dependencies; no model API call is made.

```sh
git clone https://github.com/anima-research/agent-framework /tmp/mcpl-tool-class-host
git -C /tmp/mcpl-tool-class-host checkout --detach 02adf27f953da0669ee6febf36a3131c5d324c44
(cd /tmp/mcpl-tool-class-host && bun install)
bun test conformance/tool-class-runner.test.mjs
MCPL_FRAMEWORK=/tmp/mcpl-tool-class-host bun test conformance/tool-class-adapter.test.mjs
bun run conformance/check-tool-classes.mjs --host /tmp/mcpl-tool-class-host
```

The runner tests check the coverage guards. They also run the checker against a [stand-in Host](./conformance/tool-class-stand-in.mjs) that reports the expected outcomes with one fault at a time, so a weakened comparison fails them. The checker prints the case file and its sha256, the adapter, the Host's Git revision, whether the Host has uncommitted changes or untracked files that aren't ignored, the Bun version, the resolved Chronicle, context-manager, and Membrane versions, and whether the Host is the case file's reference revision. It then checks every stage, reports each case, and finishes with `TOOL CLASS CONFORMANCE OK (11 RFC cases, 26 stages)`. A run with any failed stage lists every failure and how many stages passed, and exits nonzero. The optional `--vectors PATH` selects another case file; `--adapter PATH` selects another implementation adapter.

The recorded run used clean Host revision `02adf27f953da0669ee6febf36a3131c5d324c44`, Bun 1.4.2, `@animalabs/chronicle` 0.4.0, `@animalabs/context-manager` 0.13.0, and `@animalabs/membrane` 0.5.86. The Host does not commit a dependency lock, so a fresh installation may resolve other permitted versions; the checker reports the actual versions used.

### Evidence boundary

The [Agent Framework adapter](./conformance/agent-framework-tool-classes.mjs) creates an actual Framework with a temporary Chronicle store, a synthetic model transport, and a [synthetic stdio tool provider](./conformance/tool-class-provider.mjs). The provider runs as a separate process, supplies data, and emits real `notifications/tools/list_changed` notifications. It implements no class policy.

The checks read the Host's actual tool ingestion and re-list handling and its lifecycle descriptor. They read each tool's effective class and the source that decided it from the Host's own listing of the tools the agent is shown (`listToolClasses`, RFC §6). They read the description and input schema from the request the Host would send the model (`previewActivation`), after its permission and presentation filters. At each stage the adapter waits until the Host's registered definition of the tool appears or changes, which shows that the Host has applied that stage's listing. Server definitions reach the Host only through the provider process, and a host-origin definition is a copy, so a Host that changes its own copy can't change the values the checker expects.

Argument exclusion is checked with the Host's actual `openingFor()` decision routine and the Host's class metadata for the tool. The observer, its two lifecycle grants, its requesting filter, and the `inputs` narrowing are the fixture's, not read from a server's configuration. The runner asserts that a `started` payload exists before inspecting its arguments; suppressing the whole event cannot pass an exclusion case.

The argument checks therefore exercise Host policy output. The Host's configuration wiring and notification delivery to an observer are RFC-007's behavior, which these vectors don't test. The model checks inspect the request the Host would send, not a live model provider.

Recommended diagnostics are reported separately from required behavior. Each stage records only diagnostics captured since the previous stage's observation; an earlier warning cannot satisfy a later diagnostic hint. The log in case 3 is §3's SHOULD for unknown class strings. At the reference Host revision, unknown and malformed class diagnostics were present; the undefined `mcpl/priority` slot was ignored correctly but produced no recommended diagnostic. The checker exposes that SHOULD-level observation in its summary. Supplying this evidence leaves Draft→Accepted to protocol review.

### Consuming the vectors in another Host

Each vector starts with a fresh Host. Its `origin` is `server`, a provider's tool, or `host`, a tool the embedding Host implements. A host-origin case has one stage, since only a provider's listing is replaced. `overrides` and `hostClasses` are the fixture's operator and Host knowledge tables. `inputsPolicy` gives the argument-observation narrowing, and `input` is synthetic tool input. Both lifecycle capabilities and a matching `input:true` filter are preconditions.

Each stage supplies a complete tool definition, its model-facing name, and explicit expected classes, source, and argument treatment. Descriptor and effective class arrays must contain known strings and match the expected membership; their order is not a protocol requirement. Later server stages replace the listing and announce the change. Compare description strings and serialized input schemas with the submitted values. A `diagnosticHint` records a recommended diagnostic observation; it is not a new required error-message spelling.

To reuse the checker, an adapter exports async `loadHost(root)`, returning `{info, observe(vector)}`. `info` identifies the implementation and revision. `observe` returns one observation per stage with `descriptor`, `effective:{classes,source}`, `model`, `opening`, and `diagnostics`. These are observations from the Host, not copies of the vector's expected outcome.

## 11. Decisions and open questions

Decided:

1. **Key spelling** (revision 2, formerly open question 1): `mcpl/class`, valid under MCP's
   `_meta` rules and outside MCP's reserved space; the `mcpl/` prefix is reserved for keys
   MCPL defines (RFC §3).

Deferred:

1. **Should feature sets carry a default class** for all tools they contribute, so a server
   need not tag each tool? Deferred: tools and feature sets are not bound in the SPEC today
   (§6), and a per-tool slot is unambiguous. This does not block acceptance.
