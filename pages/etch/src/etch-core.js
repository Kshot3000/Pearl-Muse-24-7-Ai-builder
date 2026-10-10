/* Pearl Etch core — PRL-20 inscription composer.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-etch.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does: compose PRL-20 deploy/mint/transfer operations into
 * Pearlscription envelopes (exact envelope shape from
 * Pearlscriptions/indexer docs/prl-20-v0-spec.md), build the Taproot
 * commit/reveal transaction pair, sign both legs, and round-trip-verify the
 * reveal witness with an indexer-style envelope parser.
 *
 * Crypto lineage: all signing, key derivation, TapTweak, bech32m, BIP-341
 * sighash and wire serialization are imported from the audited
 * files/pages/sign/src/crypto.js (itself verified byte-for-byte against
 * Pearl's Go reference and Pearlscriptions docs). This file adds only
 * composition logic — no new crypto.
 *
 * Protocol facts (verified, not from memory):
 *  - Envelope shape + PRL-20 v0 JSON rules: Pearlscriptions/indexer
 *    docs/prl-20-v0-spec.md (multi-envelope batches: one leaf, envelopes in
 *    script order; pure mint batches may share one owner output).
 *  - PRLS launch constants + fee recipient: release-manifest.example.json
 *    (mintFeeRecipient prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea,
 *    mintFeeGrain 100000000 = 1 PRL per credited mint).
 *  - Pearl chain params: bech32m HRPs prl/tprl, BIP-86 coin 808276/1,
 *    tx version 1, P2TR dust 546 grains (see pearl-knowledge.md).
 */

import {
  NETWORKS, PRLS, GRAIN_PER_PRL, DUST_GRAIN,
  buildInscriptionScript, tapLeafHash, commitKeyInfo, revealTxVBytes,
  buildRevealTx, buildKeypathTx, keypathTxVBytes,
  validatePrl20Json, buildDeployJson, buildMintJson, buildTransferJson,
  decodeBech32m, bytesToHex, hexToBytes, schnorr,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
} from "../../sign/src/crypto.js";
import { utf8ToBytes } from "@noble/hashes/utils";

export {
  NETWORKS, PRLS, GRAIN_PER_PRL, DUST_GRAIN,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
  validatePrl20Json, bytesToHex, hexToBytes, schnorr,
};

/* PRLS fee recipient (Pearlscriptions release-manifest.example.json,
 * network pearl-mainnet). Decoded at runtime so a typo'd constant can
 * never silently produce a wrong scriptPubKey. */
export const PRLS_FEE_RECIPIENT =
  "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea";

export function prlsFeeProgram() {
  const d = decodeBech32m(PRLS_FEE_RECIPIENT);
  if (d.version !== 1 || d.program.length !== 32) throw new Error("PRLS fee recipient is not a v1 taproot address");
  return d.program; // 32-byte x-only program
}

/* ---------------- operation composition ---------------- */

/** Compose one PRL-20 operation. Returns { op, tick, json, bytes }.
 *  Throws on any spec violation (build*Json validates strictly). */
export function composeOperation(op, params) {
  let json;
  if (op === "deploy") json = buildDeployJson(params);
  else if (op === "mint") json = buildMintJson(params);
  else if (op === "transfer") json = buildTransferJson(params);
  else throw new Error(`unsupported op: ${op}`);
  const v = validatePrl20Json(json, op);
  return { op, tick: v.tick, json, bytes: utf8ToBytes(json) };
}

/** Split a single-envelope script (from crypto.js) into its shared prefix
 *  (<x-only-key> OP_CHECKSIG) and its envelope block, with structural
 *  assertions so a future crypto.js change fails loudly instead of
 *  silently mis-splitting. */
function splitSingleScript(script) {
  if (!(script instanceof Uint8Array) || script.length < 40) throw new Error("bad inscription script");
  if (script[0] !== 0x20) throw new Error("expected 32-byte key push at script start");
  if (script[33] !== 0xac) throw new Error("expected OP_CHECKSIG after key");
  if (script[34] !== 0x00 || script[35] !== 0x63) throw new Error("expected OP_FALSE OP_IF envelope start");
  if (script[script.length - 1] !== 0x68) throw new Error("expected OP_ENDIF at script end");
  return { prefix: script.slice(0, 34), envelope: script.slice(34) };
}

/** Build the reveal leaf for a batch of envelopes: the shared
 *  <key> OP_CHECKSIG prefix followed by one OP_FALSE..OP_ENDIF envelope
 *  per operation, in order (matches the indexer's "envelopes in
 *  deterministic script order" rule). Single-op output is byte-identical
 *  to crypto.js buildInscriptionScript (pinned by test). */
export function buildBatchInscriptionScript(internalXOnly, bodies) {
  if (!Array.isArray(bodies) || bodies.length === 0) throw new Error("need at least one envelope body");
  const singles = bodies.map((b) => buildInscriptionScript(internalXOnly, b));
  const { prefix } = splitSingleScript(singles[0]);
  const parts = [prefix];
  for (const s of singles) parts.push(splitSingleScript(s).envelope);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------------- address helpers ---------------- */

/** Decode a user-supplied address to its 32-byte taproot program, enforcing
 *  the expected network HRP. Pearl is taproot-only (v1+). */
export function addressToProgram(address, network) {
  const d = decodeBech32m(address, network.hrp);
  return d.program;
}

/* ---------------- reveal + commit planning ---------------- */

export const CARRIER_VALUE_GRAINS = 1000; // value of each inscribed owner output (above 546 dust)

/** Plan the whole inscription: envelopes, reveal script, commit key info,
 *  reveal outputs (owner + optional PRLS fee), fees, and the commit value
 *  the commit transaction must fund.
 *
 *  params: { network, internalXOnly, ops: [{op, params}], ownerAddress,
 *            feeRate (grains/vB), changeAddress }
 */
export function planInscription({ network, internalXOnly, ops, ownerAddress, feeRate, changeAddress }) {
  if (!Array.isArray(ops) || ops.length === 0) throw new Error("no operations to inscribe");
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) throw new Error("bad internal key");
  const rate = Math.max(1, Math.ceil(Number(feeRate)));
  if (!Number.isFinite(rate)) throw new Error("bad fee rate");

  const envelopes = ops.map((o) => composeOperation(o.op, o.params));
  const script = buildBatchInscriptionScript(internalXOnly, envelopes.map((e) => e.bytes));
  const info = commitKeyInfo(network, internalXOnly, script);
  const ownerProgram = addressToProgram(ownerAddress, network);
  const changeProgram = addressToProgram(changeAddress, network);

  const prlsMints = envelopes.filter((e) => e.op === "mint" && e.tick === PRLS.tick).length;
  const allMint = envelopes.every((e) => e.op === "mint");
  // Spec: pure PRL-20 mint batches may share one owner output; mixed batches
  // map envelope order to matching owner outputs.
  const ownerOutputs = allMint
    ? [{ program: ownerProgram, value: CARRIER_VALUE_GRAINS }]
    : envelopes.map(() => ({ program: ownerProgram, value: CARRIER_VALUE_GRAINS }));

  const feeOutputs = [];
  let prlsFeeNote = null;
  if (prlsMints > 0) {
    if (network.id === "mainnet") {
      feeOutputs.push({ program: prlsFeeProgram(), value: prlsMints * PRLS.mintFeeGrain });
    } else {
      prlsFeeNote = "The PRLS fee recipient is configured for mainnet only — the fee output is skipped here, so these mints would NOT credit on mainnet indexers.";
    }
  }

  const revealOutputs = [...ownerOutputs, ...feeOutputs];
  const revealOutSum = revealOutputs.reduce((n, o) => n + o.value, 0);
  // Fee is estimated for exactly the outputs the reveal will carry. (No
  // phantom change-output slot: with commitValue defined below, the reveal
  // change is identically zero, so budgeting an extra output would just
  // overpay the fee by one P2TR output of weight every time.)
  const revealFee = revealTxVBytes(script.length, revealOutputs.length) * rate;
  const commitValue = revealOutSum + revealFee;

  return {
    network, envelopes, script, scriptHex: bytesToHex(script),
    leafHash: bytesToHex(tapLeafHash(script)),
    merkleRoot: bytesToHex(info.merkleRoot),
    commitAddress: info.commitAddress, commitProgram: info.commitXOnly,
    controlBlock: info.controlBlock, controlBlockHex: bytesToHex(info.controlBlock),
    ownerOutputs, feeOutputs, prlsMints, prlsFeeNote,
    revealFee, commitValue, changeProgram, feeRate: rate,
  };
}

/** Build + sign the commit transaction (keypath spends of the user's
 *  funding UTXOs). fundingInputs: [{txid, vout, value, priv, internalXOnly}].
 *  Returns { txid, hex, fee, change } — change < dust is donated to fees. */
export function buildCommitTx({ network, fundingInputs, commitProgram, commitValue, changeProgram, feeRate }) {
  if (!Array.isArray(fundingInputs) || fundingInputs.length === 0) throw new Error("no funding inputs");
  // Validate funding inputs HERE, before any fee/change math: a NaN or
  // rounded value otherwise poisons inSum silently and only surfaces as a
  // context-free sighash refusal after a tx was half-built.
  for (const i of fundingInputs) {
    if (!/^[0-9a-f]{64}$/i.test(i.txid || "")) throw new Error("bad funding input txid");
    if (!Number.isSafeInteger(i.vout) || i.vout < 0) throw new Error("bad funding input vout");
    if (!Number.isSafeInteger(i.value) || i.value <= 0) throw new Error("bad funding input value");
  }
  const rate = Math.max(1, Math.ceil(Number(feeRate)));
  const inSum = fundingInputs.reduce((n, i) => n + i.value, 0);
  let fee = keypathTxVBytes(fundingInputs.length, 2) * rate;
  let change = inSum - commitValue - fee;
  const outputs = [{ program: commitProgram, value: commitValue }];
  if (change >= DUST_GRAIN) {
    outputs.push({ program: changeProgram, value: change });
  } else {
    fee = keypathTxVBytes(fundingInputs.length, 1) * rate;
    change = inSum - commitValue - fee;
    if (change < 0) throw new Error(`insufficient funds: need ${commitValue + fee} grains, have ${inSum}`);
    change = 0; // dust donated to miner fee
  }
  const { txid, hex } = buildKeypathTx(network, fundingInputs, outputs);
  return { txid, hex, fee: inSum - commitValue - change, change };
}

/** Build + sign the reveal transaction spending the commit output via the
 *  script path. Returns { txid, hex, fee, change, digest, sig }. */
export function buildRevealTxSigned({ plan, commitTxid, commitVout, internalPriv, changeAddress }) {
  if (!Number.isInteger(commitVout) || commitVout < 0 || commitVout > 0xffffffff) throw new Error("bad commit vout");
  const { network } = plan;
  const changeProgram = addressToProgram(changeAddress, plan.network);
  const outputs = [...plan.ownerOutputs, ...plan.feeOutputs];
  const outSum = outputs.reduce((n, o) => n + o.value, 0);
  const fee = revealTxVBytes(plan.script.length, outputs.length) * plan.feeRate;
  const change = plan.commitValue - outSum - fee;
  if (change < 0) throw new Error("commit value too small for reveal outputs + fee");
  if (change >= DUST_GRAIN) outputs.push({ program: changeProgram, value: change });
  const r = buildRevealTx(network, {
    commitTxid, commitVout, commitValue: plan.commitValue,
    commitProgram: plan.commitProgram, internalPriv,
    script: plan.script, controlBlock: plan.controlBlock, outputs,
  });
  return { ...r, fee: plan.commitValue - outputs.reduce((n, o) => n + o.value, 0), change: change >= DUST_GRAIN ? change : 0 };
}

/* ---------------- indexer-style envelope parsing ----------------
 * Mirrors Pearlscriptions/indexer apps/indexer-api/src/indexer.js
 * extractPearlscriptionEnvelopesFromScript: scan the executed leaf for
 * OP_FALSE(0x00) OP_IF(0x63), then marker / content-type / empty
 * separator / body chunks until OP_ENDIF(0x68). Used to round-trip-verify
 * our own reveal transactions the way an indexer would parse them. */

function tokenizeScript(script) {
  const toks = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    if (op === 0x00) { toks.push({ opcode: 0x00 }); } // OP_FALSE — an opcode, not an empty push
    else if (op <= 75) { toks.push({ data: script.slice(i, i + op) }); i += op; }
    else if (op === 0x4c) { const n = script[i++]; toks.push({ data: script.slice(i, i + n) }); i += n; }
    else if (op === 0x4d) { const n = script[i] | (script[i + 1] << 8); i += 2; toks.push({ data: script.slice(i, i + n) }); i += n; }
    else if (op === 0x4e) {
      // NOTE (2026-09-28): the 4-byte push length MUST decode unsigned.
      // `x << 24` is a signed int32 op in JS: a length with the high bit set
      // (e.g. inside a random Schnorr signature, which extractEnvelopes scans
      // as a candidate leaf) wrapped negative, drove `i` hugely negative, and
      // looped forever allocating tokens until OOM. Caught by the Pearl Notary
      // suite via a reveal whose sig contained 0x4e <high-bit length>.
      const n = (script[i] | (script[i + 1] << 8) | (script[i + 2] << 16) | (script[i + 3] << 24)) >>> 0;
      i += 4;
      if (n > script.length - i) break; // corrupt push: stop, don't trust the length
      toks.push({ data: script.slice(i, i + n) }); i += n;
    }
    else toks.push({ opcode: op });
  }
  return toks;
}

const isSafeText = (b, max) => b && b.length > 0 && b.length <= max && [...b].every((c) => c >= 0x20 && c < 0x7f);

/** Extract envelopes from an executed tapscript leaf (Uint8Array). */
export function extractEnvelopes(scriptBytes) {
  const toks = tokenizeScript(scriptBytes);
  // Mirrors the indexer's tokenData(): OP_0 in a data position is the empty
  // byte string (this is how crypto.js encodes the envelope separator).
  const tData = (t) => {
    if (!t) return null;
    if (t.data) return t.data;
    if (t.opcode === 0x00) return new Uint8Array(0);
    return null;
  };
  const out = [];
  for (let i = 0; i <= toks.length - 6; i++) {
    if (toks[i].opcode !== 0x00 || toks[i + 1].opcode !== 0x63) continue;
    const marker = tData(toks[i + 2]), ctype = tData(toks[i + 3]), sep = tData(toks[i + 4]);
    if (!isSafeText(marker, 80) || !isSafeText(ctype, 120) || !sep || sep.length !== 0) continue;
    const chunks = [];
    let c = i + 5;
    while (c < toks.length && toks[c].opcode !== 0x68) {
      const ch = toks[c].data;
      if (!ch) { chunks.length = 0; break; }
      chunks.push(ch); c++;
    }
    if (chunks.length === 0 || toks[c]?.opcode !== 0x68) continue;
    const total = chunks.reduce((n, x) => n + x.length, 0);
    const body = new Uint8Array(total);
    let o = 0;
    for (const x of chunks) { body.set(x, o); o += x.length; }
    out.push({
      marker: new TextDecoder().decode(marker),
      contentType: new TextDecoder().decode(ctype),
      body,
      bodyText: new TextDecoder().decode(body),
    });
    i = c;
  }
  return out;
}

/* Minimal raw-tx parser: returns the witness stack (array of Uint8Array)
 * for the input at inputIdx. Enough to pull the reveal script out of a
 * serialized reveal transaction for verification. */
function readVarint(b, o) {
  const f = b[o];
  if (f < 0xfd) return [f, 1];
  if (f === 0xfd) return [b[o + 1] | (b[o + 2] << 8), 3];
  if (f === 0xfe) return [(b[o + 1] | (b[o + 2] << 8) | (b[o + 3] << 16) | (b[o + 4] << 24)) >>> 0, 5];
  const lo = (b[o + 1] | (b[o + 2] << 8) | (b[o + 3] << 16) | (b[o + 4] << 24)) >>> 0;
  return [lo, 9]; // high 32 bits ignored (values fit)
}

export function witnessOfInput(txHex, inputIdx = 0) {
  const b = hexToBytes(txHex);
  let o = 0;
  o += 4; // version
  if (b[o] !== 0x00 || b[o + 1] !== 0x01) throw new Error("not a segwit tx");
  o += 2;
  let [nIn, n] = readVarint(b, o); o += n;
  for (let i = 0; i < nIn; i++) { o += 36; const [sc, sn] = readVarint(b, o); o += sn + sc; o += 4; }
  let [nOut, m] = readVarint(b, o); o += m;
  for (let i = 0; i < nOut; i++) { o += 8; const [sl, sm] = readVarint(b, o); o += sm + sl; }
  for (let i = 0; i < nIn; i++) {
    const [nw, wn] = readVarint(b, o); o += wn;
    const stack = [];
    for (let w = 0; w < nw; w++) { const [wl, wln] = readVarint(b, o); o += wln; stack.push(b.slice(o, o + wl)); o += wl; }
    if (i === inputIdx) return stack;
  }
  throw new Error("input index out of range");
}

/** Verify a reveal tx the way an indexer would: extract the witness,
 *  find the executed script leaf (the stack item holding envelopes),
 *  parse envelopes, and return them with parsed JSON. */
export function verifyRevealWitness(revealHex) {
  const stack = witnessOfInput(revealHex, 0);
  // Witness layout: [sig, script, controlBlock]. The executed leaf is the
  // stack item that parses to >= 1 envelope (indexer rule: "the executed
  // Taproot script-path leaf immediately before a plausible control block").
  for (const item of stack) {
    const envs = extractEnvelopes(item);
    if (envs.length > 0) {
      return envs.map((e) => ({ ...e, parsed: JSON.parse(e.bodyText) }));
    }
  }
  throw new Error("no inscription envelopes found in reveal witness");
}
