// Non-normative, deterministic RFC-012 host-treatment model.
// This is not a transport, authentication system, or durable host implementation.

const BASE = "channels.incoming";
const STREAM = "channels.incoming.streaming";
const METHODS = new Set(["open", "update", "complete", "abort"]);
// Each mode permits everything the ones before it do (RFC §9).
const MODE_ORDER = ["final-only", "volatile", "prepare", "incremental"];
const MODES = new Set(MODE_ORDER);
const REASONS = new Set(["cancelled", "no_speech", "superseded", "source_error"]);
// What every post-open call names (RFC §5.1). Everything else about the stream
// comes from its Host-bound lease.
const LEASE = ["streamId", "leaseId", "revision"];
const copy = value => structuredClone(value);
const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort())
    && keys.every(key => same(a[key], b[key]));
};
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const scalarLength = value => {
  if (typeof value !== "string") return null;
  let length = 0;
  for (const char of value) {
    const point = char.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) return null;
    length++;
  }
  return length;
};
const identifier = value => {
  const length = scalarLength(value);
  return length !== null && length >= 1 && length <= 256;
};
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999;
const revision = value => Number.isSafeInteger(value) && value >= 1;
const knownKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const granted = (patterns, capability) => patterns.some(pattern => {
  const want = capability.split(".");
  const got = pattern.split(".");
  return got.length === want.length && got.every((part, index) => part === "*" || part === want[index]);
});
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const flag = value => typeof value === "boolean";
const channelEntry = value => knownKeys(value, ["identity", "generation", "direction", "permitted", "senders"])
  && identifier(value.identity) && Number.isSafeInteger(value.generation)
  && ["inbound", "outbound", "bidirectional"].includes(value.direction)
  && flag(value.permitted) && Array.isArray(value.senders) && value.senders.every(identifier);
// What each fixture setting must be, when the Host is built and when a control
// step changes one of those in CONTROL. A setting given, even as null, is
// checked, never replaced by its default.
const SETTINGS = {
  now: timestamp,
  transportEpoch: identifier,
  serverPrincipal: identifier,
  ready: flag,
  advertisement: object,
  grants: value => Array.isArray(value) && value.every(pattern => typeof pattern === "string"),
  channels: value => object(value) && Object.values(value).every(channelEntry),
  maxChars: positiveInteger,
  maxUpdateHz: value => Number.isFinite(value) && value > 0,
  maxDurationMs: positiveInteger,
  maxStreams: positiveInteger,
  mode: value => MODES.has(value),
  finalAccepted: flag,
};
// The settings a control step can change.
const CONTROL = ["now", "ready", "grants", "channels", "finalAccepted", "serverPrincipal", "transportEpoch", "mode"];

class Rejection extends Error {
  constructor(code, message, data) {
    super(message);
    this.result = { error: { code, message, ...(data ? { data } : {}) } };
  }
}
const invalid = () => { throw new Rejection(-32602, "Invalid params"); };
const reject = reason => { throw new Rejection(-32025, "Input stream rejected", { reason }); };

// Advertisement is separate from the grant. The new explicit member is a local
// exception to SPEC 5.1 shorthand: legacy booleans never advertise input streaming.
// `mcpl` is the object a peer advertises under capabilities.experimental.mcpl.
export function advertised(mcpl) {
  const channels = object(mcpl) && Object.hasOwn(mcpl, "channels") ? mcpl.channels : undefined;
  return {
    incoming: channels === true || (object(channels) && Object.hasOwn(channels, "incoming") && channels.incoming === true),
    streaming: object(channels) && Object.hasOwn(channels, "inputStreaming") && channels.inputStreaming === true,
  };
}

export class InputStreamHost {
  constructor(config = {}) {
    if (!object(config)) throw Error("Invalid fixture configuration: not an object");
    const unknown = Object.keys(config).find(key => !Object.hasOwn(SETTINGS, key));
    if (unknown !== undefined) throw Error("Invalid fixture configuration: unknown setting " + unknown);
    const setting = (key, fallback) => {
      const value = Object.hasOwn(config, key) ? config[key] : fallback;
      if (!SETTINGS[key](value)) throw Error("Invalid fixture configuration: " + key);
      return value;
    };
    this.now = setting("now", 1000);
    // Every transport epoch this Host has used, so a control step's reconnect is
    // always a new connection. An epoch is a connection's lifetime, and nothing on
    // the wire names it.
    this.epochs = new Set([setting("transportEpoch", "epoch-1")]);
    this.serverPrincipal = setting("serverPrincipal", "server-1");
    this.ready = setting("ready", true);
    // The Server's advertisement. The Host under test implements this profile and
    // advertises it, so admission requires the Server's as well (RFC §2.2).
    this.advertisement = setting("advertisement", { channels: { incoming: true, inputStreaming: true } });
    // The effective grant. A control step that changes it is when the change takes
    // effect: an expansion once its policy exchange completes, a reduction before
    // its policy Request is sent (RFC §8).
    this.grants = setting("grants", [BASE, STREAM]);
    this.channels = copy(setting("channels", {
      "voice:lobby": { identity: "channel-lobby", generation: 1, direction: "inbound", permitted: true, senders: ["alice"] },
    }));
    this.maxChars = setting("maxChars", 100);
    this.maxUpdateHz = setting("maxUpdateHz", 10);
    this.maxDurationMs = setting("maxDurationMs", 10000);
    this.maxStreams = setting("maxStreams", 16);
    // The Host's own treatment policy for new leases (RFC §9). The model has no
    // recipients, so it can't show the per-recipient opt-in incremental needs, and
    // nothing here prepares or infers, so a prepare or incremental lease differs
    // from a volatile one only in which narrowings end it.
    this.mode = setting("mode", "volatile");
    this.finalAccepted = setting("finalAccepted", true);
    this.streams = new Map();
    this.messages = [];
    this.committedKeys = new Set();
    this.nextLease = 1;
  }

  // Ready state and the grant, which need nothing from the params (RFC §11).
  admit() {
    if (!this.ready) reject("not_ready");
    this.checkGrant();
  }

  // Both required grants, each with the advertisement it rests on (RFC §2.2).
  checkGrant() {
    const support = advertised(this.advertisement);
    for (const [capability, supported] of [[BASE, support.incoming], [STREAM, support.streaming]]) {
      if (!supported || !granted(this.grants, capability)) {
        throw new Rejection(-32002, "Capability denied", { capability });
      }
    }
  }

  channelFor(channelId, senderId) {
    const channel = Object.hasOwn(this.channels, channelId) ? this.channels[channelId] : undefined;
    if (!channel) throw new Rejection(-32023, "Unknown channel");
    if (!["inbound", "bidirectional"].includes(channel.direction)
      || !channel.permitted || !channel.senders.includes(senderId)) {
      throw new Rejection(-32017, "Channel not permitted");
    }
    return channel;
  }

  canonicalKey(channel, messageId) {
    return JSON.stringify([this.serverPrincipal, channel.identity, messageId]);
  }

  bindingMatches(stream, channel) {
    return channel.generation === stream.generation
      && this.canonicalKey(channel, stream.open.messageId) === stream.canonicalKey;
  }

  terminate(stream, status) {
    stream.status = status;
    stream.text = null;
  }

  // Clock/authority events are driven by the embedding host, not by the producer.
  sweep() {
    for (const stream of this.streams.values()) {
      if (stream.status !== "open") continue;
      if (this.now >= stream.expiresAt) this.terminate(stream, "expired");
      else {
        // Policy that isn't ready rejects calls meanwhile, but it isn't one of RFC
        // §8's invalidations, so the sweep leaves the ready state out: the lease
        // stands through a lapse, with what its receipt permits, and its deadline
        // still runs. Each of §8's invalidations ends it whether or not policy is
        // ready.
        try {
          this.checkGrant();
          const channel = this.channelFor(stream.open.channelId, stream.open.sender.id);
          if (!this.bindingMatches(stream, channel)) this.terminate(stream, "aborted");
        } catch (error) {
          if (!(error instanceof Rejection)) throw error;
          this.terminate(stream, "aborted");
        }
      }
    }
  }

  control(change) {
    if (!object(change)) throw Error("Invalid fixture control: not an object");
    // Own members only, as the constructor reads its configuration.
    const has = key => Object.hasOwn(change, key);
    const unknown = Object.keys(change).find(key => !CONTROL.includes(key));
    if (unknown !== undefined) {
      throw Error("Invalid fixture control: " + (Object.hasOwn(SETTINGS, unknown)
        ? unknown + " is set only when the Host is built" : "unknown member " + unknown));
    }
    for (const key of CONTROL) {
      if (has(key) && !SETTINGS[key](change[key])) throw Error("Invalid fixture control: " + key);
    }
    // Every refusal comes before any change, so a refused step changes nothing.
    if (has("now") && change.now < this.now) throw Error("Fixture clock must be monotonic");
    if (has("serverPrincipal") && !has("transportEpoch")) throw Error("A principal change requires a fresh connection");
    if (has("transportEpoch") && this.epochs.has(change.transportEpoch)) throw Error("Reconnect needs a fresh epoch");
    if (has("now")) {
      this.now = change.now;
      // A step is one Host event at its new time, so a lease whose deadline that
      // time has reached had expired (RFC §8) before the step's other changes,
      // and none of them ends it as aborted instead.
      this.sweep();
    }
    for (const key of CONTROL) {
      if (key !== "now" && key !== "transportEpoch" && has(key)) this[key] = copy(change[key]);
    }
    if (has("mode")) {
      // A policy that no longer permits a lease's mode invalidates the lease
      // rather than leaving a wider receipt standing (RFC §9).
      for (const stream of this.streams.values()) {
        if (stream.status === "open" && MODE_ORDER.indexOf(stream.receipt.mode) > MODE_ORDER.indexOf(this.mode)) {
          this.terminate(stream, "aborted");
        }
      }
    }
    if (has("transportEpoch")) {
      for (const stream of this.streams.values()) {
        if (stream.status === "open") this.terminate(stream, "aborted");
      }
      this.streams.clear();
      this.epochs.add(change.transportEpoch);
    }
    this.sweep();
  }

  request(method, params) {
    this.sweep();
    try {
      if (!METHODS.has(method)) throw new Rejection(-32601, "Method not found");
      // Whether params is an object is part of parsing the JSON-RPC envelope,
      // which precedes authorization (RFC §4.1 and §11).
      if (!object(params)) invalid();
      return { result: method === "open" ? this.open(params) : this.step(method, params) };
    } catch (error) {
      if (!(error instanceof Rejection)) throw error;
      return error.result;
    }
  }

  open(params) {
    // Ready state and grant first, then the channel and sender, then the rest of
    // the params (RFC §11).
    this.admit();
    if (!identifier(params.channelId) || !object(params.sender) || !identifier(params.sender.id)) invalid();
    const channel = this.channelFor(params.channelId, params.sender.id);
    const keys = ["streamId", "channelId", "messageId", "sender", "threadId",
      "contentType", "startedAt", "expiresAt"];
    if (!knownKeys(params, keys) || !["streamId", "messageId"].every(key => identifier(params[key]))
      || !knownKeys(params.sender, ["id", "name"])
      || ("name" in params.sender && (scalarLength(params.sender.name) === null || scalarLength(params.sender.name) > 256))
      || ("threadId" in params && !identifier(params.threadId))
      || params.contentType !== "text/plain" || !timestamp(params.startedAt)
      || !timestamp(params.expiresAt) || params.startedAt > params.expiresAt) invalid();
    if (this.now >= params.expiresAt) reject("expired");
    const existing = this.streams.get(params.streamId);
    if (existing) {
      // Expiry precedes replay handling (RFC §4.3).
      if (this.now >= existing.expiresAt) reject("expired");
      if (!same(existing.open, params)) reject("conflict");
      if (existing.status !== "open") reject("terminal");
      return copy(existing.receipt);
    }
    const canonicalKey = this.canonicalKey(channel, params.messageId);
    if (this.committedKeys.has(canonicalKey)
      || [...this.streams.values()].some(stream => stream.canonicalKey === canonicalKey)) reject("conflict");
    // Count tombstones too: this finite reference model never silently forgets an
    // admitted identity within an epoch. A production host needs bounded retention.
    if (this.streams.size >= this.maxStreams) reject("resource_limit");
    const expiresAt = Math.min(params.expiresAt, this.now + this.maxDurationMs);
    const receipt = {
      accepted: true, streamId: params.streamId, leaseId: "lease-" + this.nextLease++, expiresAt,
      maxUpdateHz: this.maxUpdateHz, maxChars: this.maxChars, mode: this.mode,
    };
    this.streams.set(params.streamId, {
      open: copy(params), generation: channel.generation, canonicalKey, expiresAt, receipt,
      status: "open", revision: 0, text: null, lastUpdateAt: null, terminal: null,
    });
    return copy(receipt);
  }

  lease(params, method) {
    // Ready state and grant, the params, then the stream and its lease, the
    // stream's own channel and sender, and expiry (RFC §11). A changed
    // registration or identity has already ended the lease (sweep).
    this.admit();
    const keys = [...LEASE, method === "abort" ? "reason" : "text"];
    if (!knownKeys(params, keys) || !["streamId", "leaseId"].every(key => identifier(params[key]))
      || !revision(params.revision)) invalid();
    const stream = this.streams.get(params.streamId);
    if (!stream) reject("unknown_stream");
    if (params.leaseId !== stream.receipt.leaseId) reject("lease_mismatch");
    this.channelFor(stream.open.channelId, stream.open.sender.id);
    if (this.now >= stream.expiresAt) reject("expired");
    return stream;
  }

  text(params) {
    const length = scalarLength(params.text);
    if (length === null) invalid();
    if (length > this.maxChars) reject("size_limit");
  }

  step(method, params) {
    const stream = this.lease(params, method);
    if (method === "abort") {
      if (!REASONS.has(params.reason)) invalid();
    } else this.text(params);

    if (stream.status !== "open") {
      if (stream.terminal?.method === method) {
        if (same(stream.terminal.params, params)) return copy(stream.terminal.result);
        reject("conflict");
      }
      reject("terminal");
    }
    if (params.revision < stream.revision) {
      if (method !== "update") reject("stale_revision");
      return { accepted: true, status: "stale", revision: stream.revision };
    }
    if (method !== "abort" && params.revision === stream.revision && params.text !== stream.text) reject("conflict");
    if (method === "update") {
      if (params.revision === stream.revision) return { accepted: true, status: "duplicate", revision: stream.revision };
      if (stream.lastUpdateAt !== null && this.now - stream.lastUpdateAt < 1000 / this.maxUpdateHz) reject("rate_limited");
      stream.revision = params.revision;
      stream.text = params.text;
      stream.lastUpdateAt = this.now;
      return { accepted: true, status: "updated", revision: stream.revision };
    }

    let result;
    if (method === "complete") {
      if (!this.finalAccepted) reject("final_rejected");
      // One synchronous transition models atomic final-ingress acceptance and receipt
      // recording. The host's storage/outbox transaction must implement that boundary.
      this.committedKeys.add(stream.canonicalKey);
      this.messages.push({
        channelId: stream.open.channelId, messageId: stream.open.messageId,
        ...(stream.open.threadId ? { threadId: stream.open.threadId } : {}),
        author: copy(stream.open.sender), timestamp: new Date(stream.open.startedAt).toISOString(),
        content: [{ type: "text", text: params.text }],
      });
      result = { accepted: true, status: "completed", messageId: stream.open.messageId, revision: params.revision };
    } else result = { accepted: true, status: "aborted" };
    // A final is accepted at its revision; an abort accepts no snapshot, so the
    // accepted revision stays where the last update left it.
    if (method === "complete") stream.revision = params.revision;
    this.terminate(stream, method === "complete" ? "completed" : "aborted");
    stream.terminal = { method, params: copy(params), result: copy(result) };
    return result;
  }

  snapshot() {
    return {
      streams: Object.fromEntries([...this.streams].map(([id, stream]) => [id, {
        status: stream.status, revision: stream.revision,
        // final-only has no presentation consumer even though the protocol model
        // keeps the latest snapshot to detect conflicting equal revisions.
        provisional: stream.status === "open" && stream.receipt.mode !== "final-only" ? stream.text : null,
      }])),
      messages: copy(this.messages),
    };
  }
}
