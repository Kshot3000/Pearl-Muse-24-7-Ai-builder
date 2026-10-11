/* Pearl Names core — human-readable names for Pearl Taproot addresses.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-names.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does: lets anyone bind a memorable name (e.g. "kshot.prl") to a
 * prl1… Taproot address by signing a canonical registration record with the
 * BIP-86 key that controls that address, then inscribing the record with the
 * audited Taproot commit/reveal machinery (marker "prl-name" — deliberately
 * NOT "prl-20" so PRL-20 indexers never mistake it for a token op).
 * A standalone verifier re-derives the address from the key, re-checks the
 * Schnorr signature, and rules the binding VALID / INVALID. A local registry
 * resolves name conflicts by first-seen (earliest registered_at) — honest
 * about being local until a public prl-name indexer exists.
 *
 * Crypto lineage: ALL key derivation, TapTweak, bech32m, BIP-341 sighash,
 * envelope composition and wire serialization come from the audited
 * files/pages/sign/src/crypto.js (Pearl Sign) and files/pages/etch/src/etch-core.js
 * (Pearl Etch). This file adds only: name format rules, canonical binding
 * composition, the prl-name envelope, the commit/reveal plan wrapper, the
 * registry resolver, and the standalone verifier. No new crypto.
 *
 * Protocol facts (verified, not from memory):
 *  - Envelope shape (OP_FALSE OP_IF marker ctype empty body… OP_ENDIF):
 *    Pearlscriptions/indexer docs/prl-20-v0-spec.md, mirrored by
 *    crypto.js buildInscriptionScript and etch-core extractEnvelopes.
 *  - Pearl chain params: bech32m HRPs prl/tprl, BIP-86 coin 808276/1,
 *    P2TR dust 546 grains (see hidden_files/pearl-knowledge.md).
 */

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  tapLeafHash, commitKeyInfo, revealTxVBytes,
  decodeBech32m, encodeBech32m, bytesToHex, hexToBytes, sha256, schnorr,
  tweakKeypath, tweakPrivKeypath,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
} from "../../sign/src/crypto.js";
import {
  buildCommitTx, buildRevealTxSigned,
  extractEnvelopes, verifyRevealWitness,
} from "../../etch/src/etch-core.js";
import { utf8ToBytes } from "@noble/hashes/utils";

export {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
  buildCommitTx, buildRevealTxSigned,
  extractEnvelopes, verifyRevealWitness,
  bytesToHex, hexToBytes, sha256, schnorr, tweakKeypath, tweakPrivKeypath,
};

export const NAME_MARKER = "prl-name";
export const NAME_VERSION = 1;
export const NAME_SUFFIX = ".prl";
export const NAME_MIN = 3;
export const NAME_MAX = 63;

/** Names Pearl will never register (trademark / confusing / system). */
export const RESERVED_NAMES = new Set([
  "pearl", "prl", "admin", "administrator", "root", "system", "null",
  "genesis", "wallet", "wallets", "miner", "miners", "pool", "pools",
  "team", "official", "support", "help", "security", "faucet", "tokens",
  "market", "exchange", "bridge", "foundation", "dao", "dev", "developer",
  "test", "testing", "demo", "example", "localhost", "pearlscriptions",
  "prl20", "wrapped", "wprl", "oyster", "node", "network", "consensus",
]);

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const hasControl = (s) => [...s].some((c) => c < " " || c === " ");

/** Normalize + validate a name. Returns the canonical form. Throws otherwise. */
export function validateName(raw) {
  if (typeof raw !== "string") throw new Error("name must be a string");
  let n = raw.trim().toLowerCase();
  if (n.endsWith(NAME_SUFFIX)) n = n.slice(0, -NAME_SUFFIX.length);
  if (n.length < NAME_MIN || n.length > NAME_MAX)
    throw new Error(`name must be ${NAME_MIN}–${NAME_MAX} characters`);
  if (!NAME_RE.test(n))
    throw new Error("name may only use a–z, 0–9 and single hyphens; cannot start or end with a hyphen");
  if (n.includes("--")) throw new Error("name may not contain consecutive hyphens");
  if (hasControl(n)) throw new Error("name must not contain control characters");
  if (RESERVED_NAMES.has(n)) throw new Error(`"${n}" is a reserved name and cannot be registered`);
  if (/^\d+$/.test(n)) throw new Error("name may not be all digits");
  return n;
}

/** Display form of a canonical name. */
export const displayName = (name) => `${name}${NAME_SUFFIX}`;

/* ---------------- canonical binding ---------------- */

/** Seconds-level UTC ISO timestamp sanity window: not before 2026-01-01, not
 *  more than 10 minutes in the future (registered_at). expires_at may be any
 *  future time — it is the one timestamp allowed to point far ahead. */
const MIN_TS = Date.UTC(2026, 0, 1) / 1000;

function checkTimestamp(ts, field, allowFuture) {
  if (!Number.isSafeInteger(ts)) throw new Error(`${field} must be an integer unix timestamp`);
  if (ts < MIN_TS) throw new Error(`${field} is before the Pearl Names epoch`);
  if (!allowFuture && ts > Math.floor(Date.now() / 1000) + 600)
    throw new Error(`${field} is more than 10 minutes in the future`);
}

/** Compose the canonical registration record. Throws on any rule violation.
 *  Field order is fixed and must never change: v, name, address, xonly,
 *  network, registered_at, expires_at. */
export function composeBinding({ name, address, xonly, network, registeredAt, expiresAt }) {
  const n = validateName(name);
  if (typeof address !== "string" || !address) throw new Error("address is required");
  if (typeof xonly !== "string" || !/^[0-9a-f]{64}$/i.test(xonly))
    throw new Error("xonly must be 64 lowercase hex chars");
  if (typeof network !== "string" || !network) throw new Error("network is required");
  checkTimestamp(registeredAt, "registered_at", false);
  if (expiresAt !== null && expiresAt !== undefined) {
    checkTimestamp(expiresAt, "expires_at", true); // expiry may point years ahead
    if (expiresAt <= registeredAt) throw new Error("expires_at must be after registered_at");
  }
  // Bind the address to the key: decode, re-encode with the SAME program and
  // HRP — rejects garbage, mixed-case, and wrong-HRP addresses.
  const d = decodeBech32m(address, network === "mainnet" ? "prl" : network === "testnet" ? "tprl" : "rprl");
  if (d.version !== 1 || d.program.length !== 32) throw new Error("address is not a v1 taproot address");
  const canonAddr = encodeBech32m(d.hrp, 1, d.program);
  const fields = {
    v: NAME_VERSION,
    name: n,
    address: canonAddr,
    xonly: xonly.toLowerCase(),
    network,
    registered_at: registeredAt,
    expires_at: expiresAt ?? null,
  };
  const json = JSON.stringify(fields);
  return { json, bytes: utf8ToBytes(json), fields };
}

/** Validate a parsed record the same way the composer does (single source
 *  of truth for field rules). */
export function validateNameRecord(obj) {
  if (!obj || typeof obj !== "object") throw new Error("record must be an object");
  if (obj.v !== NAME_VERSION) throw new Error("v must be 1");
  // Reuse the composer as the single source of truth for field rules.
  composeBinding({
    name: obj.name, address: obj.address, xonly: obj.xonly,
    network: obj.network, registeredAt: obj.registered_at, expiresAt: obj.expires_at,
  });
  return obj;
}

/** Registration id: SHA-256 of the canonical bytes, hex. */
export const bindingId = (bytes) => bytesToHex(sha256(bytes));

/** 64-bit tamper-evident fingerprint, grouped for reading. */
export const fingerprint = (idHex) =>
  `${idHex.slice(0, 4)}-${idHex.slice(4, 8)}-${idHex.slice(8, 12)}-${idHex.slice(12, 16)}`;

/* ---------------- ownership proof (local signing) ---------------- */

/** Sign the canonical binding bytes with the tweaked keypath private key of
 *  the claimed address. Loudly refuses when the derived address does not
 *  match the binding's address (wrong-key refusal).
 *  priv32: 32-byte BIP-86 private key (Uint8Array). Returns 64-byte sig. */
export function signBinding(priv32, { json, bytes, fields }, network) {
  if (!(priv32 instanceof Uint8Array) || priv32.length !== 32) throw new Error("priv must be 32 bytes");
  const internalXOnly = schnorr.getPublicKey(priv32);
  const { tweakedX } = tweakKeypath(internalXOnly);
  const tweakedPriv = tweakPrivKeypath(priv32, internalXOnly); // audited: negates d for odd-y P
  const net = NETWORKS[network] || network;
  const expectAddr = encodeBech32m(net.hrp, 1, tweakedX);
  if (expectAddr !== fields.address)
    throw new Error("WRONG KEY: this private key controls " + expectAddr + ", not the claimed " + fields.address);
  return schnorr.sign(bytes, tweakedPriv);
}

/** Verify a signed binding { json, sig } (sig: 64-byte hex or bytes).
 *  Returns { ok, checks[], id, fingerprint, address }. Never throws on bad
 *  input — it rules INVALID instead. */
export function verifySignedBinding(signed) {
  const checks = [];
  const fail = (label, detail) => { checks.push({ label, detail, ok: false }); return null; };
  try {
    if (!signed || typeof signed.json !== "string") return { ok: false, checks: [fail("record present", "no binding JSON supplied")], id: null };
    checks.push({ label: "record present", detail: "binding JSON supplied", ok: true });
    const obj = JSON.parse(signed.json);
    try {
      validateNameRecord(obj);
      checks.push({ label: "record valid", detail: `v${obj.v} · ${displayName(obj.name)} · network ${obj.network}`, ok: true });
    } catch (e) { fail("record valid", e.message); return { ok: false, checks, id: null }; }
    // Re-derive the address from the internal key and compare.
    let recomputed;
    try {
      const { tweakedX } = tweakKeypath(hexToBytes(obj.xonly));
      const net = NETWORKS[obj.network];
      if (!net) throw new Error("unknown network " + obj.network);
      recomputed = encodeBech32m(net.hrp, 1, tweakedX);
    } catch (e) { fail("key binds address", e.message); return { ok: false, checks, id: null }; }
    if (recomputed !== obj.address) {
      fail("key binds address", `recomputed ${recomputed} ≠ claimed ${obj.address}`);
      return { ok: false, checks, id: null };
    }
    checks.push({ label: "key binds address", detail: "tweaked key re-derives the claimed prl1… address", ok: true });
    // Signature over the canonical bytes.
    const bytes = utf8ToBytes(signed.json);
    let sig;
    try {
      sig = typeof signed.sig === "string" ? hexToBytes(signed.sig) : signed.sig;
      if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new Error("sig must be 64 bytes");
    } catch (e) { fail("signature present", e.message); return { ok: false, checks, id: null }; }
    checks.push({ label: "signature present", detail: "64-byte Schnorr signature", ok: true });
    const { tweakedX } = tweakKeypath(hexToBytes(obj.xonly));
    const sigOk = schnorr.verify(sig, bytes, tweakedX);
    checks.push({ label: "signature valid", detail: sigOk ? "BIP-340 verification passed" : "signature does NOT verify against the binding", ok: sigOk });
    if (!sigOk) return { ok: false, checks, id: bindingId(bytes) };
    // Expiry.
    const now = Math.floor(Date.now() / 1000);
    if (obj.expires_at != null) {
      if (obj.expires_at <= now) { fail("not expired", `expired at ${new Date(obj.expires_at * 1000).toISOString()}`); return { ok: false, checks, id: bindingId(bytes) }; }
      const warn = obj.expires_at - now < 30 * 86400;
      checks.push({ label: "not expired", detail: warn ? "expires within 30 days — renew soon" : `valid until ${new Date(obj.expires_at * 1000).toISOString()}`, ok: true, warn });
    } else {
      checks.push({ label: "not expired", detail: "no expiry set (permanent binding)", ok: true });
    }
    const id = bindingId(bytes);
    return { ok: true, checks, id, fingerprint: fingerprint(id), address: obj.address, name: obj.name };
  } catch (e) {
    checks.push({ label: "record parses", detail: e.message, ok: false });
    return { ok: false, checks, id: null };
  }
}

/* ---------------- prl-name envelope ---------------- */

const OP_CHECKSIG = 0xac, OP_FALSE = 0x00, OP_IF = 0x63, OP_ENDIF = 0x68;

function pushData(data) {
  const b = data instanceof Uint8Array ? data : utf8ToBytes(String(data));
  if (b.length === 0) return [OP_FALSE];
  if (b.length <= 75) return [b.length, ...b];
  if (b.length <= 0xff) return [0x4c, b.length, ...b];
  if (b.length <= 0xffff) return [0x4d, b.length & 0xff, (b.length >> 8) & 0xff, ...b];
  return [0x4e, b.length & 0xff, (b.length >> 8) & 0xff, (b.length >> 16) & 0xff, (b.length >> 24) & 0xff, ...b];
}

/** <key> OP_CHECKSIG OP_FALSE OP_IF "prl-name" "application/json" <empty>
 *  <body chunks ≤520B> OP_ENDIF — same construction as crypto.js
 *  buildInscriptionScript, marker "prl-name" instead of "prl-20". */
export function buildNameScript(internalXOnly, bodyBytes) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32)
    throw new Error("internal key must be 32 bytes");
  const body = bodyBytes instanceof Uint8Array ? bodyBytes : utf8ToBytes(String(bodyBytes));
  if (body.length === 0) throw new Error("empty name body");
  const script = [
    ...pushData(internalXOnly), OP_CHECKSIG, OP_FALSE, OP_IF,
    ...pushData(utf8ToBytes(NAME_MARKER)),
    ...pushData(utf8ToBytes("application/json")),
    ...pushData(new Uint8Array(0)),
  ];
  for (let i = 0; i < body.length; i += 520) script.push(...pushData(body.slice(i, i + 520)));
  script.push(OP_ENDIF);
  return Uint8Array.from(script);
}

/** Decode a user-supplied address to its 32-byte taproot program, enforcing HRP. */
export function addressToProgram(address, network) {
  const d = decodeBech32m(address, network.hrp);
  if (d.version !== 1 || d.program.length !== 32) throw new Error("address is not a v1 taproot address");
  return d.program;
}

export const CARRIER_VALUE_GRAINS = 1000; // inscribed owner output value (above 546 dust)

/** The signed registration payload that goes inside the envelope. */
export function composeNamePayload({ binding, sigHex }) {
  if (!binding || typeof binding.json !== "string") throw new Error("bad binding");
  if (!/^[0-9a-f]{128}$/i.test(sigHex || "")) throw new Error("sigHex must be 128 hex chars");
  const fields = JSON.parse(binding.json);
  const payload = { p: NAME_MARKER, ...fields, sig: sigHex.toLowerCase() };
  const json = JSON.stringify(payload);
  return { json, bytes: utf8ToBytes(json), fields: payload };
}

/** Plan the name inscription: envelope → script → commit key → reveal
 *  outputs → fees. Single-envelope: one owner output carrying the
 *  registration. Returns a plan shaped exactly like etch-core's
 *  planInscription output (ownerOutputs, feeOutputs: [], script,
 *  commitProgram, commitValue, feeRate, network) so etch-core's
 *  buildCommitTx/buildRevealTxSigned apply. */
export function planNameInscription({ network, internalXOnly, payload, ownerAddress, changeAddress, feeRate }) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) throw new Error("bad internal key");
  const rate = Math.max(1, Math.ceil(Number(feeRate)));
  if (!Number.isFinite(rate)) throw new Error("bad fee rate");
  const composed = typeof payload === "string" ? { json: payload, bytes: utf8ToBytes(payload) } : payload;
  if (!composed || !(composed.bytes instanceof Uint8Array)) throw new Error("bad payload");

  const script = buildNameScript(internalXOnly, composed.bytes);
  const info = commitKeyInfo(network, internalXOnly, script);
  const ownerProgram = addressToProgram(ownerAddress, network);
  const changeProgram = addressToProgram(changeAddress, network);

  const ownerOutputs = [{ program: ownerProgram, value: CARRIER_VALUE_GRAINS }];
  const feeOutputs = [];
  const outSum = CARRIER_VALUE_GRAINS;
  const revealFee = revealTxVBytes(script.length, ownerOutputs.length + 1) * rate;
  const commitValue = outSum + revealFee;

  return {
    network, envelope: composed, script, scriptHex: bytesToHex(script),
    leafHash: bytesToHex(tapLeafHash(script)),
    merkleRoot: bytesToHex(info.merkleRoot),
    commitAddress: info.commitAddress, commitProgram: info.commitXOnly,
    controlBlock: info.controlBlock, controlBlockHex: bytesToHex(info.controlBlock),
    ownerOutputs, feeOutputs,
    revealFee, commitValue, changeProgram, feeRate: rate,
  };
}

/* ---------------- verification ---------------- */

/** Parse a reveal tx's witness, find the prl-name envelope, and verify the
 *  embedded registration. revealHex: serialized reveal tx.
 *  Returns { record, payload, verify }. Throws if no name envelope. */
export function verifyNameWitness(revealHex) {
  const envs = verifyRevealWitness(revealHex);
  const env = envs.find((e) => e.marker === NAME_MARKER);
  if (!env) throw new Error("no prl-name envelope in this reveal");
  const payload = env.parsed;
  if (!payload || payload.p !== NAME_MARKER) throw new Error("envelope payload is not a prl-name registration");
  const verify = verifySignedBinding({ json: JSON.stringify({
    v: payload.v, name: payload.name, address: payload.address, xonly: payload.xonly,
    network: payload.network, registered_at: payload.registered_at, expires_at: payload.expires_at,
  }), sig: payload.sig });
  return { record: validateNameRecord(payload), payload, verify, marker: env.marker };
}

/** Fetch a reveal tx from blockbook and verify the embedded registration.
 *  Returns { record, payload, verify, txid, blockHeight, blockTime, confirmations }. */
export async function verifyNameOnChain(blockbookUrl, revealTxid) {
  if (!/^[0-9a-f]{64}$/i.test(revealTxid || "")) throw new Error("bad reveal txid");
  const base = String(blockbookUrl).replace(/\/+$/, "");
  const r = await fetch(`${base}/api/v2/tx/${revealTxid.toLowerCase()}`);
  if (!r.ok) throw new Error(`blockbook tx lookup failed: HTTP ${r.status}`);
  const tx = await r.json();
  if (!tx.hex) throw new Error("blockbook did not return raw tx hex");
  const v = verifyNameWitness(tx.hex);
  return { ...v, txid: tx.txid, blockHeight: tx.blockHeight ?? null, blockTime: tx.blockTime ?? null, confirmations: tx.confirmations ?? 0 };
}

/* ---------------- local registry ---------------- */

/** Resolve a set of registration records into a name → winner map.
 *  First-seen (lowest registered_at) wins; later same-name records are
 *  listed as contested. Invalid records are listed as rejected. */
export function resolveRegistry(records) {
  const winners = new Map();
  const contested = [];
  const rejected = [];
  const sorted = [...records].sort((a, b) => (a.fields?.registered_at ?? 0) - (b.fields?.registered_at ?? 0));
  for (const rec of sorted) {
    const v = verifySignedBinding(rec);
    if (!v.ok) { rejected.push({ rec, checks: v.checks }); continue; }
    const name = v.name;
    if (!winners.has(name)) winners.set(name, { rec, id: v.id, fingerprint: v.fingerprint });
    else contested.push({ rec, id: v.id, winnerId: winners.get(name).id });
  }
  return { winners, contested, rejected };
}

/* ---------------- name certificate ---------------- */

/** Build the human-readable name certificate object (JSON-serializable). */
export function buildNameCertificate({ plan, payload, commitTxid, revealTxid, blockHeight, blockTime }) {
  const rec = validateNameRecord(JSON.parse(plan.envelope.json));
  return {
    app: "Pearl Names",
    network: plan.network.label,
    name: displayName(rec.name),
    address: rec.address,
    registration: { id: bindingId(plan.envelope.bytes), fingerprint: fingerprint(bindingId(plan.envelope.bytes)), registered_at: rec.registered_at, expires_at: rec.expires_at },
    envelope: { marker: NAME_MARKER, contentType: "application/json", leafHash: plan.leafHash, merkleRoot: plan.merkleRoot },
    commit: { txid: commitTxid, address: plan.commitAddress },
    reveal: { txid: revealTxid, blockHeight: blockHeight ?? null, blockTime: blockTime ?? null },
    verify: "Re-derive the address from the registration's xonly key, check the BIP-340 signature over the canonical record, and compare the record id against the inscribed envelope.",
    issuedAt: new Date().toISOString(),
  };
}
