// Non-normative, deterministic RFC-009 host-treatment model.
// This is not a transport, authentication system, or durable host implementation.
import { createHash } from "node:crypto";

const BASE = "channels.incoming";
const STREAM = "channels.incoming.streaming";
const METHODS = new Set(["open", "update", "complete", "abort"]);
const MODES = new Set(["final-only", "volatile", "prepare", "incremental"]);
const REASONS = new Set(["cancelled", "no_speech", "superseded", "source_error"]);
const ENVELOPE = ["streamId", "transportEpoch", "leaseId", "channelId", "senderId",
  "contentType", "startedAt", "expiresAt", "revision"];
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
const digest = text => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
const granted = (patterns, capability) => patterns.some(pattern => {
  const want = capability.split(".");
  const got = pattern.split(".");
  return got.length === want.length && got.every((part, index) => part === "*" || part === want[index]);
});

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
export function advertised(capabilities) {
  const channels = object(capabilities) && Object.hasOwn(capabilities, "channels") ? capabilities.channels : undefined;
  return {
    incoming: channels === true || (object(channels) && Object.hasOwn(channels, "incoming") && channels.incoming === true),
    streaming: object(channels) && Object.hasOwn(channels, "inputStreaming") && channels.inputStreaming === true,
  };
}

export class InputStreamHost {
  constructor(config = {}) {
    this.now = config.now ?? 1000;
    this.epoch = config.transportEpoch ?? "epoch-1";
    this.serverPrincipal = config.serverPrincipal ?? "server-1";
    this.ready = config.ready ?? true;
    this.advertisement = config.advertisement ?? { channels: { incoming: true, inputStreaming: true } };
    this.grants = config.grants ?? [BASE, STREAM];
    this.channels = copy(config.channels ?? {
      "voice:lobby": { identity: "channel-lobby", generation: 1, direction: "inbound", permitted: true, senders: ["alice"] },
    });
    this.maxChars = config.maxChars ?? 100;
    this.maxUpdateHz = config.maxUpdateHz ?? 10;
    this.maxDurationMs = config.maxDurationMs ?? 10000;
    this.maxStreams = config.maxStreams ?? 16;
    this.mode = config.mode ?? "volatile";
    this.finalAccepted = config.finalAccepted ?? true;
    if (!MODES.has(this.mode) || !Number.isFinite(this.maxUpdateHz) || this.maxUpdateHz <= 0
      || !Number.isSafeInteger(this.maxChars) || this.maxChars <= 0) throw Error("Invalid fixture configuration");
    this.streams = new Map();
    this.messages = [];
    this.committedKeys = new Set();
    this.prepared = new Map();
    this.usedPreparation = [];
    this.nextLease = 1;
  }

  authority(channelId, senderId) {
    if (!this.ready) reject("not_ready");
    const support = advertised(this.advertisement);
    for (const [capability, supported] of [[BASE, support.incoming], [STREAM, support.streaming]]) {
      if (!supported || !granted(this.grants, capability)) {
        throw new Rejection(-32002, "Capability denied", { capability });
      }
    }
    const channel = this.channels[channelId];
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
    this.prepared.delete(stream.open.streamId);
  }

  // Clock/authority events are driven by the embedding host, not by the producer.
  sweep() {
    for (const stream of this.streams.values()) {
      if (stream.status !== "open") continue;
      if (this.now >= stream.expiresAt) this.terminate(stream, "expired");
      else {
        try {
          const channel = this.authority(stream.open.channelId, stream.open.sender.id);
          if (!this.bindingMatches(stream, channel)) this.terminate(stream, "aborted");
        } catch (error) {
          if (!(error instanceof Rejection)) throw error;
          this.terminate(stream, "aborted");
        }
      }
    }
  }

  control(change) {
    if ("now" in change) {
      if (!timestamp(change.now) || change.now < this.now) throw Error("Fixture clock must be monotonic");
      this.now = change.now;
    }
    if ("serverPrincipal" in change && !("transportEpoch" in change)) throw Error("A principal change requires a fresh connection");
    for (const key of ["ready", "grants", "channels", "finalAccepted", "serverPrincipal"]) {
      if (key in change) this[key] = copy(change[key]);
    }
    if ("transportEpoch" in change) {
      if (change.transportEpoch === this.epoch) throw Error("Reconnect needs a fresh epoch");
      for (const stream of this.streams.values()) {
        if (stream.status === "open") this.terminate(stream, "aborted");
      }
      this.streams.clear();
      this.prepared.clear();
      this.epoch = change.transportEpoch;
    }
    this.sweep();
  }

  request(method, params) {
    this.sweep();
    try {
      if (!METHODS.has(method)) throw new Rejection(-32601, "Method not found");
      if (!object(params)) invalid();
      return { result: method === "open" ? this.open(params) : this.step(method, params) };
    } catch (error) {
      if (!(error instanceof Rejection)) throw error;
      return error.result;
    }
  }

  open(params) {
    const keys = ["streamId", "channelId", "messageId", "sender", "threadId",
      "contentType", "startedAt", "expiresAt"];
    if (!knownKeys(params, keys) || !["streamId", "channelId", "messageId"].every(key => identifier(params[key]))
      || !knownKeys(params.sender, ["id", "name"]) || !identifier(params.sender.id)
      || ("name" in params.sender && (scalarLength(params.sender.name) === null || scalarLength(params.sender.name) > 256))
      || ("threadId" in params && !identifier(params.threadId))
      || params.contentType !== "text/plain" || !timestamp(params.startedAt)
      || !timestamp(params.expiresAt) || params.startedAt > params.expiresAt) invalid();
    const channel = this.authority(params.channelId, params.sender.id);
    if (this.now >= params.expiresAt) reject("expired");
    const existing = this.streams.get(params.streamId);
    if (existing) {
      if (!same(existing.open, params)) reject("conflict");
      if (this.now >= existing.expiresAt) reject("expired");
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
      accepted: true, streamId: params.streamId, transportEpoch: this.epoch,
      leaseId: "lease-" + this.nextLease++, expiresAt,
      maxUpdateHz: this.maxUpdateHz, maxChars: this.maxChars, mode: this.mode,
    };
    this.streams.set(params.streamId, {
      open: copy(params), generation: channel.generation, canonicalKey, expiresAt, receipt,
      status: "open", revision: 0, text: null, lastUpdateAt: null, terminal: null,
    });
    return copy(receipt);
  }

  lease(params, method) {
    const keys = [...ENVELOPE, method === "abort" ? "reason" : "text"];
    if (!knownKeys(params, keys)
      || !["streamId", "transportEpoch", "leaseId", "channelId", "senderId"].every(key => identifier(params[key]))
      || params.contentType !== "text/plain" || !timestamp(params.startedAt)
      || !timestamp(params.expiresAt) || !revision(params.revision)) invalid();
    this.authority(params.channelId, params.senderId);
    if (params.transportEpoch !== this.epoch) reject("lease_mismatch");
    const stream = this.streams.get(params.streamId);
    if (!stream) reject("unknown_stream");
    const expected = {
      streamId: stream.open.streamId, transportEpoch: this.epoch,
      leaseId: stream.receipt.leaseId, channelId: stream.open.channelId,
      senderId: stream.open.sender.id, contentType: stream.open.contentType,
      startedAt: stream.open.startedAt, expiresAt: stream.expiresAt,
    };
    if (!Object.entries(expected).every(([key, value]) => params[key] === value)) reject("lease_mismatch");
    if (this.now >= stream.expiresAt) reject("expired");
    if (!this.bindingMatches(stream, this.channels[params.channelId])) reject("lease_mismatch");
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
      this.prepared.delete(params.streamId);
      stream.revision = params.revision;
      stream.text = params.text;
      stream.lastUpdateAt = this.now;
      return { accepted: true, status: "updated", revision: stream.revision };
    }

    let result;
    if (method === "complete") {
      if (!this.finalAccepted) reject("final_rejected");
      const contentDigest = digest(params.text);
      const preparation = this.prepared.get(params.streamId);
      if (preparation?.revision === params.revision && preparation.contentDigest === contentDigest) {
        this.usedPreparation.push(params.streamId);
      }
      // One synchronous transition models atomic final-ingress acceptance and receipt
      // recording. The host's storage/outbox transaction must implement that boundary.
      this.committedKeys.add(stream.canonicalKey);
      this.messages.push({
        channelId: stream.open.channelId, messageId: stream.open.messageId,
        ...(stream.open.threadId ? { threadId: stream.open.threadId } : {}),
        author: copy(stream.open.sender), timestamp: new Date(stream.open.startedAt).toISOString(),
        content: [{ type: "text", text: params.text }],
      });
      result = { accepted: true, status: "completed", messageId: stream.open.messageId,
        revision: params.revision, contentDigest };
    } else result = { accepted: true, status: "aborted" };
    stream.revision = params.revision;
    this.terminate(stream, method === "complete" ? "completed" : "aborted");
    stream.terminal = { method, params: copy(params), result: copy(result) };
    return result;
  }

  prepare(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream || stream.status !== "open" || stream.text === null
      || !["prepare", "incremental"].includes(this.mode)) throw Error("Preparation stimulus has no permitted snapshot");
    this.prepared.set(streamId, {
      revision: stream.revision, contentDigest: digest(stream.text),
    });
  }

  snapshot() {
    return {
      streams: Object.fromEntries([...this.streams].map(([id, stream]) => [id, {
        status: stream.status, revision: stream.revision,
        // final-only has no presentation consumer even though the protocol model
        // keeps the latest snapshot to detect conflicting equal revisions.
        provisional: stream.status === "open" && this.mode !== "final-only" ? stream.text : null,
      }])),
      messages: copy(this.messages),
      prepared: Object.fromEntries(this.prepared),
      usedPreparation: copy(this.usedPreparation),
    };
  }
}
