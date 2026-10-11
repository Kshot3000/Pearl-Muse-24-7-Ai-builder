/* Pearl PRL-20 commit/reveal inscription builder.
 *
 * Pure ESM, zero build step. Runs in the browser (via import map) and in
 * node (for the verification test suite).
 *
 * Crypto lineage (attribution):
 *  - Key derivation, TapTweak, bech32m, BIP-341 keypath signing and wire
 *    serialization reimplement the audited pearlpurse wallet core
 *    (buildandtestppg/pearlpurse src/lib/pearl.js, ISC), itself verified
 *    byte-for-byte against Pearl's Go reference (node/txscript).
 *  - Script-path reveal (inscription envelope, control block, script-path
 *    sighash) follows Pearlscriptions docs/pearl-taproot-inscription-proof.md
 *    and is round-trip verified against the indexer's own parser
 *    (apps/indexer-api/src/indexer.js: extractTaprootInscriptionsFromRawTxHex)
 *    plus PRL-20 validation (packages/prl20-core: parsePrl20Operation).
 *  - Vendored deps: @scure/* + @noble/*, MIT (c) paulmillr.com and
 *    contributors — see lib/ and README.md.
 *
 * Protocol facts (verified, not from memory):
 *  - PRL-20 v0 spec: docs/prl-20-v0-spec.md in Pearlscriptions/indexer.
 *  - Pearl chain params: node/chaincfg/params.go via pearl-knowledge.md
 *    (bech32m HRP prl/tprl/rprl, BIP-86 coin type 808276/1, tx version 1).
 *  - Blockbook: https://blockbook.pearlresearch.ai (verified live 2026-09-26).
 */

import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { createBase58check } from "@scure/base";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

/* ---------------- chain params ---------------- */

export const GRAIN_PER_PRL = 100_000_000;
export const DUST_GRAIN = 546; // P2TR dust, matches upstream txrules / pearlpurse

export const NETWORKS = {
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    hrp: "prl",
    coinType: 808276,
    wifVersion: 0x80,
    txVersion: 1,
    blockbook: "https://blockbook.pearlresearch.ai",
  },
  testnet: {
    id: "testnet",
    label: "Testnet",
    hrp: "tprl",
    coinType: 1,
    wifVersion: 0xef,
    txVersion: 1,
    blockbook: "", // no public Pearl testnet blockbook known — user configurable
  },
};

/* PRLS launch constants (Pearlscriptions release manifest / prl20-core PRLS).
 * The mint FEE RECIPIENT is operator-configured per release manifest and is
 * NOT hardcoded here — the UI requires it as an input for prls mints. */
export const PRLS = Object.freeze({
  tick: "prls",
  max: "2100000000",
  lim: "100000",
  dec: "18",
  mintFeeGrain: 100_000_000,
});

/* ---------------- bech32m (audited, from pearlpurse) ---------------- */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const a = [];
  for (const c of hrp) a.push(c.charCodeAt(0) >>> 5);
  a.push(0);
  for (const c of hrp) a.push(c.charCodeAt(0) & 31);
  return a;
}
function checksum(hrp, data) {
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ BECH32M_CONST;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}
export function convertBits(data, fromBits, toBits, pad, strictPadding = false) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >>> bits) & maxv);
    }
  }
  if (pad && bits) ret.push((acc << (toBits - bits)) & maxv);
  if (!pad && bits) {
    if (strictPadding && (acc & ((1 << bits) - 1)) !== 0) throw new Error("invalid padding");
  }
  return ret;
}
export function encodeBech32m(hrp, version, program) {
  if (!(program instanceof Uint8Array) || program.length !== 32) throw new Error("program must be 32 bytes");
  if (version !== 1) throw new Error("only witness v1 (taproot) supported");
  const data5 = [version, ...convertBits([...program], 8, 5, true)];
  return hrp + "1" + data5.concat(checksum(hrp, data5)).map((v) => CHARSET[v]).join("");
}
export function decodeBech32m(addr, expectHrp = null) {
  if (typeof addr !== "string") throw new Error("address must be string");
  const raw = addr.trim();
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) throw new Error("mixed case");
  addr = raw.toLowerCase();
  if (addr.length > 90) throw new Error("too long");
  const pos = addr.lastIndexOf("1");
  if (pos < 1 || addr.length - pos - 1 < 7) throw new Error("missing separator");
  const hrp = addr.slice(0, pos);
  if (!/^[a-z0-9]+$/.test(hrp)) throw new Error("bad hrp");
  if (expectHrp && hrp !== expectHrp) throw new Error(`wrong network: expected ${expectHrp}, got ${hrp}`);
  const data5 = [];
  for (const c of addr.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v === -1) throw new Error("invalid char");
    data5.push(v);
  }
  if (polymod(hrpExpand(hrp).concat(data5)) !== BECH32M_CONST) throw new Error("bad checksum");
  const payload = data5.slice(0, -6);
  if (payload[0] !== 1) throw new Error("only witness v1 (taproot) supported");
  const data8 = convertBits(payload.slice(1), 5, 8, false, true);
  if (data8.length !== 32) throw new Error("program must be 32 bytes (v1 taproot)");
  return { hrp, version: payload[0], program: Uint8Array.from(data8) };
}

/* ---------------- hashing ---------------- */

export function taggedHash(tag, msg) {
  const tagHash = sha256(utf8ToBytes(tag));
  const pre = new Uint8Array(tagHash.length * 2 + msg.length);
  pre.set(tagHash);
  pre.set(tagHash, tagHash.length);
  pre.set(msg, tagHash.length * 2);
  return sha256(pre);
}
export const dblSha = (b) => sha256(sha256(b));

/* ---------------- keys ---------------- */

export function newMnemonic() {
  return generateMnemonic(wordlist, 128);
}
export function walletFromMnemonic(mnemonic, network, account = 0, index = 0) {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("invalid BIP-39 mnemonic");
  if (!Number.isInteger(account) || account < 0 || account > 0x7fffffff) throw new Error("bad account");
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) throw new Error("bad index");
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(`m/86'/${network.coinType}'/${account}'/0/${index}`);
  if (!child.privateKey) throw new Error("derivation failed");
  return walletFromPriv(child.privateKey, network);
}

const b58check = createBase58check(sha256); // encode/decode full payload (incl. version byte)

export function walletFromWIF(wif, network) {
  const raw = b58check.decode(wif.trim());
  // payload = [version][32-byte key][0x01?]
  if (raw.length < 33) throw new Error("invalid WIF payload length");
  if (raw[0] !== network.wifVersion) throw new Error(`wrong WIF network version (expected 0x${network.wifVersion.toString(16)})`);
  let key = raw.slice(1);
  if (key.length === 33 && key[32] === 0x01) key = key.slice(0, 32); // compressed flag
  if (key.length !== 32) throw new Error("invalid WIF key length");
  return walletFromPriv(key, network);
}

export function walletToWIF(priv, network) {
  const payload = new Uint8Array(34);
  payload[0] = network.wifVersion;
  payload.set(priv, 1);
  payload[33] = 0x01;
  return b58check.encode(payload);
}

export function walletFromPriv(priv, network) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  const internalXOnly = schnorr.getPublicKey(p); // x-only, no prefix
  const { tweakedX } = tweakKeypath(internalXOnly);
  return {
    priv: p,
    internalXOnly,
    address: encodeBech32m(network.hrp, 1, tweakedX),
    network,
  };
}

/** BIP-341 keypath tweak (empty merkle root): Q = P + H_TapTweak(P)*G */
export function tweakKeypath(internalXOnly) {
  const t = taggedHash("TapTweak", internalXOnly);
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  return { tweakedX: schnorr.utils.pointToBytes(Q), t };
}

/** Tweaked private key for keypath signing (negate d when P has odd y). */
export function tweakPrivKeypath(priv, internalXOnly) {
  let d = bytesToNumberBE(priv);
  const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32));
  if (P.toRawBytes(true)[0] === 0x03) d = secp256k1.CURVE.n - d;
  const { t } = tweakKeypath(internalXOnly);
  return numberToBytesBE((d + bytesToNumberBE(t)) % secp256k1.CURVE.n, 32);
}

/* ---------------- wire format (audited, from pearlpurse) ---------------- */

export function varint(n) {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 0xff, (n >> 8) & 0xff];
  if (n <= 0xffffffff) return [0xfe, ...u32le(n)];
  return [0xff, ...u64le(n)];
}
export function u32le(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
export function u64le(n) {
  const lo = n % 0x100000000;
  const hi = Math.floor(n / 0x100000000);
  return [...u32le(lo), ...u32le(hi)];
}
export function p2trScriptPubKey(xOnlyPub) {
  return Uint8Array.from([0x51, 0x20, ...xOnlyPub]); // OP_1 <32-byte key>
}
export const txidLE = (txidHex) => {
  if (!/^[0-9a-f]{64}$/i.test(txidHex)) throw new Error("bad txid");
  return hexToBytes(txidHex).reverse();
};

/** CompactSize length for a value (1/3/5/9 bytes). */
const varintLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);

/** vBytes of a keypath P2TR tx (audited txVBytes from pearlpurse). */
export function keypathTxVBytes(nIn, nOut) {
  if (!Number.isInteger(nIn) || nIn < 1) throw new Error("nIn must be a positive integer");
  if (!Number.isInteger(nOut) || nOut < 1) throw new Error("nOut must be a positive integer");
  const baseBytes = 4 + 1 + 41 * nIn + 1 + 43 * nOut + 4;
  const weight = 4 * baseBytes + 2 + 66 * nIn;
  return Math.ceil(weight / 4);
}

/** Keypath commit tx. inputs: [{txid,vout,value,priv,internalXOnly}]; outputs: [{program,value}]. */
export function buildKeypathTx(network, inputs, outputs, sequence = 0xffffffff) {
  if (!inputs.length || !outputs.length) throw new Error("need inputs and outputs");
  for (const o of outputs) {
    if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("bad output program");
    if (!Number.isSafeInteger(o.value) || o.value <= 0) throw new Error("bad output value");
  }
  const core = [...u32le(network.txVersion), ...varint(inputs.length)];
  for (const inp of inputs) core.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(sequence));
  core.push(...varint(outputs.length));
  for (const out of outputs) {
    const s = p2trScriptPubKey(out.program);
    core.push(...u64le(out.value), ...varint(s.length), ...s);
  }
  core.push(...u32le(0));
  const txid = bytesToHex(dblSha(Uint8Array.from(core)).reverse());

  const sigs = inputs.map((inp, i) => {
    const digest = keypathSigDigest(network, inputs, outputs, sequence, i);
    const tweaked = tweakPrivKeypath(inp.priv, inp.internalXOnly);
    return schnorr.sign(digest, tweaked, new Uint8Array(32));
  });

  const full = [...u32le(network.txVersion), 0x00, 0x01, ...varint(inputs.length)];
  for (const inp of inputs) full.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(sequence));
  full.push(...varint(outputs.length));
  for (const out of outputs) {
    const s = p2trScriptPubKey(out.program);
    full.push(...u64le(out.value), ...varint(s.length), ...s);
  }
  for (const sig of sigs) full.push(...varint(1), ...varint(sig.length), ...sig);
  full.push(...u32le(0));
  return { txid, hex: bytesToHex(Uint8Array.from(full)) };
}

/** BIP-341 keypath sighash digest, generalized for hash_type.
 *
 *  hash_type 0x00 = SIGHASH_DEFAULT, 0x83 = SIGHASH_SINGLE|SIGHASH_ANYONECANPAY.
 *  inputs: [{txid, vout, value, spk}] where spk is the prevout's full
 *  scriptPubKey (Uint8Array). outputs: [{program: Uint8Array(32), value}].
 *
 *  Wire layout (verified field-by-field against Pearl consensus
 *  node/txscript calcTaprootSignatureHashRaw, the same lineage the
 *  SIGHASH_DEFAULT digest above was verified byte-for-byte against):
 *    0x00 || hash_type || nVersion || nLockTime ||
 *    [sha_prevouts || sha_amounts || sha_scriptpubkeys || sha_sequences]
 *        (skipped when ANYONECANPAY — not zeroed, omitted) ||
 *    [sha_outputs]  (skipped when SINGLE or NONE) ||
 *    spend_type (0x00: keypath, no annex) ||
 *    (ANYONECANPAY ? outpoint || amount || spk || nSequence : input_index u32le) ||
 *    [sha256(CTxOut at input index)]  (when SINGLE — AFTER the input section)
 *  then taggedHash("TapSighash", ...). */
export function keypathSigDigestEx(network, inputs, outputs, sequence, idx, hashType = 0x00) {
  const sha = (b) => sha256(b);
  if (!Number.isInteger(idx) || idx < 0 || idx >= inputs.length) throw new Error("bad input index");
  if (hashType !== 0x00 && hashType !== 0x83) throw new Error("unsupported hash_type (only 0x00 and 0x83)");
  const acp = (hashType & 0x80) !== 0;
  const base = hashType & 0x03;
  for (const i of inputs) {
    if (!/^[0-9a-f]{64}$/i.test(i.txid || "")) throw new Error("bad input txid");
    if (!Number.isInteger(i.vout) || i.vout < 0) throw new Error("bad input vout");
    if (!Number.isSafeInteger(i.value) || i.value <= 0) throw new Error("bad input value");
    if (!(i.spk instanceof Uint8Array) || i.spk.length === 0) throw new Error("bad input spk");
  }
  const msg = [0x00, hashType, ...u32le(network.txVersion), ...u32le(0)];
  if (!acp) {
    msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => [...txidLE(i.txid), ...u32le(i.vout)]))));
    msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => u64le(i.value)))));
    msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => [...varint(i.spk.length), ...i.spk]))));
    msg.push(...sha(Uint8Array.from(inputs.flatMap(() => u32le(sequence)))));
  }
  if (base !== 0x03 /* SINGLE */ && base !== 0x02 /* NONE */) {
    msg.push(...sha(Uint8Array.from(outputs.flatMap((o) => {
      const s = p2trScriptPubKey(o.program);
      return [...u64le(o.value), ...varint(s.length), ...s];
    }))));
  }
  msg.push(0x00); // spend_type: keypath, no annex
  const inp = inputs[idx];
  if (acp) {
    msg.push(...txidLE(inp.txid), ...u32le(inp.vout), ...u64le(inp.value),
      ...varint(inp.spk.length), ...inp.spk, ...u32le(sequence));
  } else {
    msg.push(...u32le(idx));
  }
  if (base === 0x03) {
    if (idx >= outputs.length) throw new Error("SIGHASH_SINGLE: no output at input index");
    const o = outputs[idx];
    const s = p2trScriptPubKey(o.program);
    msg.push(...sha(Uint8Array.from([...u64le(o.value), ...varint(s.length), ...s])));
  }
  return taggedHash("TapSighash", Uint8Array.from(msg));
}

/** BIP-341 keypath sighash digest (SigHashDefault). Pearl uses single-sha256
 *  component hashes per node/txscript/hashcache.go — identical to BIP-341. */
function keypathSigDigest(network, inputs, outputs, sequence, idx) {
  return keypathSigDigestEx(
    network,
    inputs.map((i) => ({
      txid: i.txid, vout: i.vout, value: i.value,
      spk: p2trScriptPubKey(tweakKeypath(i.internalXOnly).tweakedX),
    })),
    outputs,
    sequence,
    idx,
    0x00
  );
}

/* ---------------- inscription script (commit/reveal) ---------------- */

const OP_CHECKSIG = 0xac, OP_FALSE = 0x00, OP_IF = 0x63, OP_ENDIF = 0x68;
const TAPLEAF_VERSION = 0xc0;

function pushData(data) {
  const b = data instanceof Uint8Array ? data : utf8ToBytes(String(data));
  if (b.length === 0) return [OP_FALSE]; // empty push
  if (b.length <= 75) return [b.length, ...b];
  if (b.length <= 255) return [0x4c, b.length, ...b];
  if (b.length <= 520) return [0x4d, b.length & 0xff, (b.length >> 8) & 0xff, ...b];
  throw new Error("push exceeds 520 bytes");
}

/** Tapscript leaf per Pearlscriptions proof doc:
 *  <x-only-owner-pubkey> OP_CHECKSIG OP_FALSE OP_IF "prl-20"
 *  "application/json" <empty> <json chunks ≤520B> OP_ENDIF */
export function buildInscriptionScript(internalXOnly, jsonBytes) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) throw new Error("internal key must be 32 bytes");
  const body = jsonBytes instanceof Uint8Array ? jsonBytes : utf8ToBytes(jsonBytes);
  if (body.length === 0) throw new Error("empty inscription body");
  const chunks = [];
  for (let i = 0; i < body.length; i += 520) chunks.push(body.slice(i, i + 520));
  const script = [
    ...pushData(internalXOnly),
    OP_CHECKSIG, OP_FALSE, OP_IF,
    ...pushData(utf8ToBytes("prl-20")),
    ...pushData(utf8ToBytes("application/json")),
    ...pushData(new Uint8Array(0)),
  ];
  for (const c of chunks) script.push(...pushData(c));
  script.push(OP_ENDIF);
  return Uint8Array.from(script);
}

export function tapLeafHash(script) {
  const pre = Uint8Array.from([TAPLEAF_VERSION, ...varint(script.length), ...script]);
  return taggedHash("TapLeaf", pre);
}

/** Commit-key info: tweak internal key with the single-leaf merkle root. */
export function commitKeyInfo(network, internalXOnly, script) {
  const merkleRoot = tapLeafHash(script);
  const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...merkleRoot]));
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  const commitXOnly = schnorr.utils.pointToBytes(Q);
  const parity = Q.toAffine().y & 1n ? 1 : 0;
  return {
    merkleRoot,
    commitXOnly,
    commitAddress: encodeBech32m(network.hrp, 1, commitXOnly),
    controlBlock: Uint8Array.from([TAPLEAF_VERSION | parity, ...internalXOnly]), // 33 B, empty path
  };
}

/** vBytes of the script-path reveal tx. */
export function revealTxVBytes(scriptLen, nOut) {
  const baseBytes = 4 + 1 + 41 + 1 + 43 * nOut + 4; // ver+count+1in+count+outs+locktime
  const witnessBytes = 1 + (1 + 64) + (varintLen(scriptLen) + scriptLen) + (1 + 33); // count + sig + script + control block
  return Math.ceil((4 * baseBytes + 2 + witnessBytes) / 4);
}

/** BIP-341 script-path sighash digest (SigHashDefault, no annex). */
function scriptPathSigDigest(network, commitTxid, commitVout, commitValue, commitProgram, outputs, script, sequence, inputIdx = 0) {
  const sha = (b) => sha256(b);
  const prevouts = sha(Uint8Array.from([...txidLE(commitTxid), ...u32le(commitVout)]));
  const amounts = sha(Uint8Array.from(u64le(commitValue)));
  const commitSpk = p2trScriptPubKey(commitProgram);
  const spks = sha(Uint8Array.from([...varint(commitSpk.length), ...commitSpk]));
  const seqs = sha(Uint8Array.from(u32le(sequence)));
  const outs = sha(Uint8Array.from(outputs.flatMap((o) => {
    const s = p2trScriptPubKey(o.program);
    return [...u64le(o.value), ...varint(s.length), ...s];
  })));
  const leafHash = tapLeafHash(script);
  const msg = Uint8Array.from([
    0x00, 0x00, ...u32le(network.txVersion), ...u32le(0),
    ...prevouts, ...amounts, ...spks, ...seqs, ...outs,
    0x02, // spend_type: script path (ext_flag=1), no annex
    ...u32le(inputIdx),
    ...leafHash, 0x00, 0xff, 0xff, 0xff, 0xff, // leaf hash, key version, codesep 0xffffffff
  ]);
  return taggedHash("TapSighash", msg);
}

/** Script-path reveal tx spending the commit output.
 *  outputs: [{program: Uint8Array(32), value}] — owner output FIRST. */
export function buildRevealTx(network, { commitTxid, commitVout, commitValue, commitProgram, internalPriv, script, controlBlock, outputs, sequence = 0xffffffff }) {
  if (!(script instanceof Uint8Array) || script.length === 0) throw new Error("bad script");
  if (controlBlock.length !== 33 || (controlBlock[0] & 0xfe) !== TAPLEAF_VERSION) throw new Error("bad control block");
  const digest = scriptPathSigDigest(network, commitTxid, commitVout, commitValue, commitProgram, outputs, script, sequence);
  const sig = schnorr.sign(digest, internalPriv, new Uint8Array(32));

  const core = [...u32le(network.txVersion), ...varint(1),
    ...txidLE(commitTxid), ...u32le(commitVout), ...varint(0), ...u32le(sequence),
    ...varint(outputs.length)];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    core.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  core.push(...u32le(0));
  const txid = bytesToHex(dblSha(Uint8Array.from(core)).reverse());

  const full = [...u32le(network.txVersion), 0x00, 0x01, ...varint(1),
    ...txidLE(commitTxid), ...u32le(commitVout), ...varint(0), ...u32le(sequence),
    ...varint(outputs.length)];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    full.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  full.push(...varint(3), ...varint(sig.length), ...sig, ...varint(script.length), ...script, ...varint(controlBlock.length), ...controlBlock, ...u32le(0));
  return { txid, hex: bytesToHex(Uint8Array.from(full)), digest: bytesToHex(digest), sig: bytesToHex(sig) };
}

/* ---------------- PRL-20 JSON (mirrors prl20-core validation) ---------------- */

const INTEGER_STRING = /^(0|[1-9][0-9]*)$/;
const TICKER_PATTERN = /^[a-z0-9]{1,16}$/;

function findDuplicateTopLevelKeys(raw) {
  // Depth-tracking scan: record every "key" at brace depth 1 followed by ':'.
  const keys = [];
  let i = 0;
  const n = raw.length;
  const skipWs = () => { while (i < n && /\s/.test(raw[i])) i++; };
  const skipString = () => { // raw[i] === '"'; advances past it
    let j = i + 1;
    while (j < n) {
      const ch = raw[j];
      if (ch === "\\") { j += 2; continue; }
      if (ch === '"') break;
      j++;
    }
    i = j + 1;
  };
  const skipValue = () => {
    skipWs();
    if (raw[i] === '"') { skipString(); return; }
    if (raw[i] === "{" || raw[i] === "[") {
      const open = raw[i], close = open === "{" ? "}" : "]";
      let d = 0;
      while (i < n) {
        const ch = raw[i];
        if (ch === '"') { skipString(); continue; }
        if (ch === open) d++;
        if (ch === close) { d--; if (d === 0) { i++; return; } }
        i++;
      }
      return;
    }
    while (i < n && raw[i] !== "," && raw[i] !== "}") i++;
  };
  skipWs();
  if (raw[i] !== "{") return [];
  i++; skipWs();
  while (i < n && raw[i] !== "}") {
    skipWs();
    if (raw[i] !== '"') { i++; continue; } // malformed; JSON.parse reports it
    const ks = i + 1;
    skipString();
    let key;
    try { key = JSON.parse(raw.slice(ks - 1, i)); } catch { key = null; }
    skipWs();
    if (raw[i] === ":") {
      if (key !== null) keys.push(key);
      i++;
      skipValue();
      skipWs();
      if (raw[i] === ",") i++;
    }
  }
  const seen = new Set(), dups = [];
  for (const k of keys) { if (seen.has(k)) dups.push(k); else seen.add(k); }
  return [...new Set(dups)];
}

export function validatePrl20Json(rawJson, op) {
  const errors = [];
  if (!["deploy", "mint", "transfer"].includes(op)) throw new Error(`unsupported op: ${op}`);
  const dups = findDuplicateTopLevelKeys(rawJson);
  if (dups.length) errors.push(`duplicate field: ${dups[0]}`);
  let p;
  try { p = JSON.parse(rawJson); }
  catch { return { ok: false, errors: ["not valid JSON"] }; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, errors: ["payload must be a JSON object"] };
  const need = op === "deploy" ? ["p", "op", "tick", "max", "lim", "dec"] : ["p", "op", "tick", "amt"];
  for (const k of Object.keys(p)) if (!need.includes(k)) errors.push(`unknown field: ${k}`);
  for (const k of need) if (!(k in p)) errors.push(`missing field: ${k}`);
  if (p.p !== "prl-20") errors.push('p must be "prl-20"');
  if (p.op !== op) errors.push(`op must be "${op}"`);
  const tick = String(p.tick ?? "").toLowerCase();
  if (!TICKER_PATTERN.test(tick)) errors.push("tick must be 1-16 lowercase letters/digits");
  const ints = op === "deploy" ? ["max", "lim", "dec"] : ["amt"];
  for (const f of ints) {
    if (typeof p[f] !== "string" || !INTEGER_STRING.test(p[f])) errors.push(`${f} must be a canonical integer string (no leading zeros)`);
  }
  if (errors.length) return { ok: false, errors };
  if (op === "deploy") {
    const max = BigInt(p.max), lim = BigInt(p.lim), dec = Number(p.dec);
    if (max <= 0n) errors.push("max must be > 0");
    if (lim <= 0n) errors.push("lim must be > 0");
    if (lim > max) errors.push("lim must be <= max");
    if (!Number.isInteger(dec) || dec < 0 || dec > 18) errors.push("dec must be 0-18");
    if (tick === PRLS.tick && (p.max !== PRLS.max || p.lim !== PRLS.lim || p.dec !== PRLS.dec))
      errors.push("prls deploy must use the exact launch params (max 2100000000, lim 100000, dec 18)");
  } else {
    if (BigInt(p.amt) <= 0n) errors.push("amt must be > 0");
  }
  return { ok: errors.length === 0, errors, tick };
}

export function buildDeployJson({ tick, max, lim, dec }) {
  const t = String(tick).toLowerCase();
  const raw = JSON.stringify({ p: "prl-20", op: "deploy", tick: t, max: String(max), lim: String(lim), dec: String(dec) });
  const v = validatePrl20Json(raw, "deploy");
  if (!v.ok) throw new Error("invalid deploy: " + v.errors.join("; "));
  return raw;
}
export function buildMintJson({ tick, amt }) {
  const t = String(tick).toLowerCase();
  const raw = JSON.stringify({ p: "prl-20", op: "mint", tick: t, amt: String(amt) });
  const v = validatePrl20Json(raw, "mint");
  if (!v.ok) throw new Error("invalid mint: " + v.errors.join("; "));
  return raw;
}
/** PRL-20 transfer inscription JSON. Mirrors buildMintJson; the transfer op
 *  debits available balance and creates a lot controlled by the transfer
 *  inscription UTXO (see docs/prl-20-v0-spec.md "Transfer-Lot Rules"). */
export function buildTransferJson({ tick, amt }) {
  const t = String(tick).toLowerCase();
  const raw = JSON.stringify({ p: "prl-20", op: "transfer", tick: t, amt: String(amt) });
  const v = validatePrl20Json(raw, "transfer");
  if (!v.ok) throw new Error("invalid transfer: " + v.errors.join("; "));
  return raw;
}

/* ---------------- blockbook REST ---------------- */

async function bbFetch(base, path, opts = {}) {
  const res = await fetch(base.replace(/\/$/, "") + path, opts);
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${path}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
export async function fetchUtxos(blockbookBase, address) {
  const list = await bbFetch(blockbookBase, `/api/v2/utxo/${address}`);
  if (!Array.isArray(list)) throw new Error("unexpected utxo response");
  return list.map((u) => {
    const value = Number(u.value); // grains (satoshis field)
    // Refuse values past MAX_SAFE_INTEGER instead of silently rounding them.
    if (!Number.isSafeInteger(value)) throw new Error("UTXO value too large to handle exactly");
    return { txid: u.txid, vout: u.vout, value, confirmations: u.confirmations ?? 0 };
  }).filter((u) => u.value > 0 && /^[0-9a-f]{64}$/i.test(u.txid));
}
/** Fee rate in grains/vByte. Blockbook estimatefee returns PRL/kB (like BTC/kB). */
export async function fetchFeeRateGrainsPerVByte(blockbookBase, blocks = 2) {
  const r = await bbFetch(blockbookBase, `/api/v2/estimatefee/${blocks}`);
  const perKb = Number(r.result ?? r);
  if (!Number.isFinite(perKb) || perKb <= 0) throw new Error("fee estimate unavailable");
  return (perKb * GRAIN_PER_PRL) / 1000;
}
/** Broadcast a raw tx hex. Returns the txid; throws with the backend's message on rejection.
 *  Verified 2026-09-26 against https://blockbook.pearlresearch.ai: the v1
 *  /api/sendtx/ endpoint takes the raw hex as the request body (text/plain);
 *  success -> {"result":"<txid>"}, rejection -> {"error":"..."}. */
export async function broadcastTx(blockbookBase, hex) {
  const base = blockbookBase.replace(/\/$/, "");
  const res = await fetch(base + "/api/sendtx/", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: hex,
  });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch { /* non-JSON body */ }
  if (!res.ok || j.error) {
    throw new Error("broadcast rejected: " + (j.error || `HTTP ${res.status}: ${text.slice(0, 160)}`));
  }
  const txid = j.result ?? j.txid;
  if (!/^[0-9a-f]{64}$/i.test(txid || "")) throw new Error("unexpected broadcast response: " + text.slice(0, 160));
  return txid.toLowerCase();
}
export async function fetchTxStatus(blockbookBase, txid) {
  return bbFetch(blockbookBase, `/api/v2/tx/${txid}`);
}

export { bytesToHex, hexToBytes, sha256, schnorr };
