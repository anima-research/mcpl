# MCPL RFC-016: Server Manuals

**Status:** Draft (revision 4)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a question asked by antra ("maybe we should spec manuals and
examples into the MCPL protocol proper?"), after a survey of how servers explain themselves
today.
**Date:** 2026-11-09 (revision 1); 2026-11-10 (revisions 2–4, from review: MCP `instructions` no
longer required of hosts, summary display bounded, `applied` disposition, SPEC amendment list
completed with a new §20, page caches per connection, vectors aligned with the normative text)
**Depends on:** MCP resources (`resources/list`, `resources/read`,
`notifications/resources/updated`), used unchanged. Amends SPEC §5.1's example, §17.1, §17.3 and
§17.6 (a `manual` manifest domain), and Appendix B.3 and B.4; adds a §20 (RFC §12). Shares its
document with the draft RFC-009 (endpoint discovery, PR #22): a server that publishes a discovery
guide publishes its manual's index there (RFC §7). Follows the draft RFC-010 (deprecate context
injection, PR #15) in keeping manual pages out of the context unless the agent asks for them or
the operator configures it. Adds no capability path and changes
no grant: RFC-002 / SPEC §5.4 remains the sole source of what a connected server may do.

Section references (§) are to the SPEC; references to this document are written "RFC §".

---

## 1. Summary

A tool description says what one tool does. Nothing in MCPL says what a server is for, when an
agent should reach for it, how its tools fit together, or what a good use of it looks like.
Servers that need to say so have found three different places, none of which a host can
recognize:

| Today | What goes wrong |
|---|---|
| MCP `instructions` in the `initialize` result | It is meant to be always in context, so it must stay short; and hosts may not show it at all. In one deployment five servers fill it and neither of the deployment's two hosts passes it to the agent. |
| A `guide` tool that returns prose | It works everywhere, but a host cannot tell it from any other tool: it cannot list, link, refresh or show it before the agent connects. |
| Prose appended to another tool's result (`whoami`) | Only an agent that happens to call that tool first finds it. |

This RFC defines a **manual**: markdown pages served as ordinary MCP resources, one of them the
**index**, named by a `manual` member of the MCPL manifest. Pages reach the model only when the
agent asks for them, or when its operator has configured the host to include one. Worked
examples are pages too. When the server also has an RFC-009 discovery guide, the guide **is** the
index: one document, read before connecting and after.

| Piece | Where it lives | In context all the time? |
|---|---|---|
| `manual.summary` | the manifest | when present: one line, shown with the server's tools |
| the index | an MCP resource named by `manual.index` | no: read when the agent asks |
| topic and example pages | MCP resources linked from the index | no: read when the agent asks |
| the discovery guide | RFC-009 `rel="help"` and the record's `guide` | before connecting; the same document as the index |

---

## 2. Motivation

### 2.1 What servers need to say

- **When to use it, and when not.** An agent decides whether to use a server before it decides
  how; a reference that starts with mechanics answers the second question only.
- **How the parts fit.** Feature sets, toolsets (RFC-014), channels, and the order calls
  usually come in.
- **What a good use looks like.** A worked example often teaches what a page of rules does not.
- **How to connect,** for a reader arriving through discovery (RFC-009).

Tool descriptions cannot carry this. They are per tool; they sit in every request's tool list,
so their length is paid on every call and every edit rebuilds the prompt cache; and a
multi-step example in one of them would bloat all the rest.

### 2.2 Consulted, not carried

Everything that is always in context is paid for on every inference, and every change to it
invalidates the cache from that point on; the draft RFC-010 (§2 there) measures the same effect
for context injection. A manual is consulted, not carried: an agent reads the index when it
starts using a server, comes back to a page when it needs one, and the host keeps only the
one-line summary resident.

### 2.3 Examples are pages

An example placed in a tool definition sits in every request. On a page, it is read when it is
relevant, it can be long enough to be complete, and the server's own tests can run it.

Whether a server needs examples at all is its own call. In a small test of SwarmBase's guide, two
models planned runs for five tasks under three versions of the guide, and a blind judge scored
the plans. Adding four worked examples (about 1,900 tokens) made no difference large enough to
see at that size. This RFC therefore does not ask servers for examples. It says where they go
when a server has them, and what makes one usable (RFC §5.3).

---

## 3. Why MCP resources

- **Manuals are passive, pulled data.** That is what MCP resources are for, and MCPL leaves
  resources unchanged by design (§1).
- **It degrades well** (§2, §3.2). A plain MCP host sees the pages as ordinary resources, which
  some MCP clients already let the model list and read. The server works unchanged.
- **Change notification exists:** `notifications/resources/updated`, for hosts that subscribe.

Alternatives considered:

- **A new `manual/read` method.** It duplicates resources and needs the same host work.
- **Standardizing a `guide` tool.** A tool sits in every request's tool list, and a host
  cannot tell it is documentation. It stays available as a fallback (RFC §8).
- **Longer `instructions`.** Always in context; see RFC §2.2.

---

## 4. The manifest member

```jsonc
"experimental": { "mcpl": { "version": "0.5", …,
  "manual": {
    "index": "https://docs.example.org/agents.md",
    "summary": "Live collaborative markdown documents. Read the manual before your first edit.",
    "tool": "guide"
  } } }
```

| Field | Required | Meaning |
|---|---|---|
| `index` | **yes** | URI of the index page. The server **MUST** list it in `resources/list` and serve it from `resources/read` as `text/markdown`. It **MUST NOT** be an `mcpl:` URI: those name endpoints (RFC-004), not documents. |
| `summary` | no | One line of plain text, at most 200 characters: what the server is for and when to read the manual. |
| `tool` | no | The name of a tool that returns the same text as the index, for hosts without this RFC (RFC §8). |

Unknown fields **MUST** be ignored. A server with a `manual` member **MUST** advertise MCP's
`resources` capability. A host **MUST** treat a `manual` member whose `index` is an `mcpl:` URI
as absent. A host shows at most the summary's first line, cut to 200 characters; a longer summary
does not invalidate the member.

**Its own manifest domain.** `manual` forms a domain of its own, amending §17.1 as RFC-014 does
for `toolsets`. A server that announces changes (§17.10) names `manual` in
`mcpl/manifestChanged` when the member changes (a new index URI, a new summary). It carries no
grant consequence: the impact is §17.6's `surface-changed`, disposition `applied` (the host
refreshes the summary it shows), or `informational` when only `manual.tool` changed, since that
takes effect at the next connection (RFC §8).

Changes to a page's **content** are not manifest changes. They are resource updates (RFC §6.4).
A server that edits its pages does not change its revision, and the text a host keeps in context
(the summary) changes only when the server deliberately changes the member.

**No capability path gates it.** Reading a page tells the server nothing but which page was
asked for, as `tools/list` does. Gating it would hide a server's documentation from the agents
that were granted the least.

---

## 5. Pages

### 5.1 Every page

- An MCP resource with `mimeType: "text/markdown"`, a `name` (a short title) and a `description`
  (one line on what the page covers).
- **SHOULD** stay under 32,000 characters. Split a long page rather than grow it.
- Links to other pages are those pages' resource URIs, written as ordinary markdown links.
- A server **MAY** tailor pages to the connection: the limits that apply to this caller, the
  identity it connected as. Tailoring adds to the text the server would serve an anonymous
  reader; it **MUST NOT** contradict it.

### 5.2 The index

The index **SHOULD**, in this order:

1. Say what the server is for, in a paragraph.
2. Say when to use it, and when not to.
3. Say how its parts fit together: feature sets, toolsets (RFC-014), channels, the order calls
   usually come in.
4. For a server reachable through discovery (RFC-009): how to connect, and what identity it
   expects.
5. List the other pages, one line each, with links.

An index that is the only page is fine. A small server needs no more.

### 5.3 Examples

An example page (or a section of one) **SHOULD**:

- open with the situation it fits ("Fits: …"), so a reader can tell when *not* to use it;
- be complete: usable without reading another example;
- be correct now. Where it is executable, the server's own tests **SHOULD** run it.

---

## 6. Host behaviour

### 6.1 Reading

A host that supports this RFC **SHOULD** give the agent one way to read any connected server's
manual: a host tool such as `manual {server, page?}`, where an absent `page` means the index, or,
for a host with RFC-014 meta-tools, a `page` argument added to its `look`. It **SHOULD NOT** add a tool per
server. Like RFC-014's meta-tools, the tool is static.

### 6.2 What stays in context

The host **SHOULD** show, wherever it presents a server (its tool group, its catalog entry, an
RFC-014 toolset announcement), that the server has a manual, with its `summary`. That text
stays in context for the session, so the host changes it only when the manifest's `manual`
member changes.

The host **MUST NOT** place page content into the agent's context except:

- in answer to the agent's own request, or
- under explicit operator configuration (for example: give this agent the Docs index when it
  first connects).

Anything a server can place into every inference without being asked is a context hook. §10
puts that behind a grant and the draft RFC-010 deprecates it; a manual must not reopen that
lane.

### 6.3 Presentation

- The host **SHOULD** mark manual text with its source (`[manual · docs · index]`), as it marks
  tool results.
- The host **MAY** cap what one read returns. If it does, it says where it cut and how to read
  the rest.
- A link to another page of the same server is read through `resources/read`. Any other link is
  ordinary text, and the host never follows it on its own (RFC-009 §7's posture on referrals).

### 6.4 Changes

When a page the agent has read changes (`notifications/resources/updated`, for a host that
subscribed), the host **MAY** tell the agent once that it changed, naming the page. It does not
re-send the page, or pass on the server's new description of it, unasked (RFC §6.2). A host that wants freshness re-reads on its own schedule.

### 6.5 MCP `instructions`

This RFC does not change how hosts treat MCP `instructions`. They are server text shown without
the agent asking, which the pull rule does not cover, so a host that shows them **SHOULD** cap
their length. A server with a manual **SHOULD** keep its `instructions` to a few lines that agree
with the summary and mention the manual: the substance belongs in the manual.

---

## 7. The same document as RFC-009

A server that publishes an RFC-009 guide (`rel="help"`, the record's `guide`) **MUST** use its
manual's index as that guide:

- `manual.index` is the guide's `https:` URL;
- `resources/read` on it returns the same markdown as an anonymous `GET` with
  `Accept: text/markdown` (tailoring under RFC §5.1 aside);
- links between pages are `https:` URLs. A reader without MCPL follows them over HTTP; a
  connected host reads the same URIs as resources.

A server with no HTTP presence uses any URI scheme it serves as resources
(`swarmbase:manual/index`), and RFC-009 does not apply to it.

---

## 8. Hosts without this RFC

- A server **MAY** keep a tool that returns the index, named by `manual.tool`. It **SHOULD**
  return the same text as the index page.
- A host that provides RFC §6.1's read path **MAY** leave that tool out of the agent's tool list,
  since the manual is reachable through it. Hiding a tool changes the tool list, so the host decides
  when the connection starts, not mid-session; a later change to `manual.tool` takes effect at
  the next connection. If the manual is removed or its index stops being readable, the host
  restores the tool it hid.
- A plain MCP host sees the pages as resources and ignores the `manual` member. The server
  works unchanged (§3.2).

---

## 9. Security considerations

- **Manual text is server testimony:** data for the model to weigh, never authority. A page
  saying the agent "may" do something grants nothing; as §13.4 puts it, the control is the grant
  (§5.4), not the instruction.
- **The pull rule** (RFC §6.2) keeps pages from becoming an ungranted context hook. Of the
  manual, only the summary is shown unasked: like a tool description it is server text in every
  request, which is why a host shows at most one line of 200 characters. Operator-configured
  pages are the operator's choice, and MCP `instructions` are outside this RFC (RFC §6.5).
- **Size:** RFC §5.1's page limit is advice to servers. A host that needs a bound on what one
  read puts into context sets its own cap (RFC §6.3).
- **Tailored pages** may carry the connecting identity's details and limits. A host **MUST NOT**
  serve a page cached from one connection on another connection.
- **Referrals:** a page that tells an agent to connect somewhere else, or to present a
  credential, is a referral in RFC-009 §7's sense, and hosts treat it the same way.

---

## 10. Deployment (non-normative)

Turning on RFC §6.2's summaries, or MCP `instructions`, in a host changes what every connected
agent sees on every turn, and rebuilds each agent's cached prefix once. Hosts should let operators
enable it per agent.

---

## 11. First implementations

- **SwarmBase** (a run-orchestration server, planned): its authoring guide, rewritten with
  tested worked examples in anima-research/swarmbase#14, becomes the index; the examples become
  pages; its `guide` tool stays as `manual.tool`.
- **Anima Docs** (candidate): its RFC-009 `agents.md` becomes `manual.index`.
- **Hosts** (candidates): the Connectome agent-framework, with a `manual` tool; mcpl-cc-bridge,
  re-exposing pages as its own MCP resources so a Claude Code session reads them with its
  resource tools.

---

## 12. Changes to the SPEC on acceptance

- **§5.1:** the example manifest shows a `manual` member.
- **§17.1:** a further domain, `manual`, holding the `manual` member; `capabilities` excludes it.
  (RFC-014 adds `toolsets` the same way; the two amendments are independent.)
- **§17.2:** the `manual` member and its member names are not capability identifiers; the digest
  does not check them as identifiers, as for other non-capability text.
- **§17.3, Appendix B.3's `domains` enum and B.4's `ChangeDomain`:** add `manual`.
- **§17.6:** `surface-changed` also covers a change to the `manual` member, with disposition
  `applied`.
- **§20 (new), Server Manuals:** RFC §4–§9 as normative text.
- **Appendix B.3:** the schema of RFC §15.
- **Changelog:** an entry.

---

## 13. Conformance vectors (to freeze before acceptance)

| # | Input | Expected |
|---|---|---|
| 1 | Server declares `manual.index` | not an `mcpl:` URI; the server advertises MCP `resources`; `resources/list` includes that URI with `mimeType` `text/markdown` |
| 2 | `resources/read` on the index | `text/markdown` content |
| 3 | `manual.index` is an `mcpl:` URI, in any letter case | host treats the member as absent; server otherwise unaffected |
| 4 | Host provides RFC §6.1's read path; `manual.index` cannot be read | the agent's read fails visibly (an error, or a result saying the index is unavailable); tools and grants unaffected |
| 5 | `summary` longer than 200 characters, or several lines | host shows at most its first line, cut to 200 characters; the member stays valid |
| 6 | Server that announces changes changes `summary`; host fetches the manifest | `mcpl/manifestChanged` names `manual`; one `surface-changed` receipt, `applied`; grant unchanged |
| 7 | Server edits a page's content | revision unchanged; `notifications/resources/updated` for subscribers |
| 8 | Agent has not asked for a page, and no operator configuration includes one | no page content in the assembled context (inspect the host's request) |
| 9 | Host provides RFC §6.1's read path; agent reads a page | content returned; a link to a sibling page reads as a resource |
| 10 | RFC-009 server | the record's `guide` equals `manual.index`, an `https:` URI; links between pages are `https:` URIs; `GET` with `Accept: text/markdown` returns the same text as `resources/read` for an anonymous reader |
| 11 | Unknown fields in `manual` | ignored |
| 12 | Plain MCP host | the index listed as an ordinary resource; server works |
| 13 | Two connections, by the same identity or different ones, read the same page URI | each gets the page as served on its own connection, never the other's cached copy |
| 14 | A page links to a URI that is not one of the server's pages | the host does not fetch it on its own |
| 15 | Agent reads a page; the server changes it and notifies | the new content is not placed in context until the agent asks again |

---

## 14. Open questions

- Should a toolset (RFC-014) or a feature set name its own page, so a host can offer it when the
  toolset opens?
- Are 200 characters right for `summary`, and 32,000 for a page?
- Should hosts tell the agent when a page it read has changed (RFC §6.4), or is that the
  attention cost RFC-010 warns about?
- Localized manuals.

---

## 15. Schema

Addition to Appendix B.3:

```jsonc
"manual": {
  "type": "object",
  "required": ["index"],
  "properties": {
    "index":   { "type": "string", "format": "uri", "pattern": "^(?![mM][cC][pP][lL]:)[A-Za-z][A-Za-z0-9+.-]*:" },
    "summary": { "type": "string", "description": "one line; hosts show at most 200 characters" },
    "tool":    { "type": "string" }
  }
}
```
