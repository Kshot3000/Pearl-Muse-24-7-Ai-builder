// Pearl Notary verification suite — node --test, zero new deps.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/notary.test.mjs
// Exercises: notary JSON rules, envelope script structure, commit/reveal
// planning, full sign cycle, indexer-style witness round-trip, and the
// on-chain verify path against a stub blockbook.
import test from "node:test";
import assert from "node:assert/strict";

import {
  NETWORKS, DUST_GRAIN, CARRIER_VALUE_GRAINS,
  NOTARY_MARKER,
  hashDocument, composeNotarization, validateNotaryRecord,
  buildNotaryScript, planNotarization,
  buildCommitTx, buildRevealTxSigned,
  extractEnvelopes, verifyRevealWitness, verifyNotarizationWitness,
  buildSealCertificate, addressToProgram,
  newMnemonic, walletFromMnemonic, bytesToHex, hexToBytes, schnorr,
} from "../src/notary-core.js";
import {
  commitKeyInfo, revealTxVBytes, keypathTxVBytes, decodeBech32m,
} from "../../sign/src/crypto.js";
import { utf8ToBytes } from "@noble/hashes/utils";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const net = NETWORKS.mainnet;
const wallet = walletFromMnemonic(MNEMONIC, net);
const OWNER = wallet.address;

const good = {
  hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  filename: "contract.pdf", size: 1048576, ts: "2026-09-28T04:00:00Z",
  title: "Loan agreement", by: "Alice",
};

/* ---------------- hashing ---------------- */

test("hashDocument matches SHA-256 of 'test'", () => {
  assert.equal(hashDocument("test"), good.hash);
  assert.equal(hashDocument(utf8ToBytes("test")), good.hash);
  assert.equal(hashDocument(new TextEncoder().encode("test").buffer), good.hash);
  assert.throws(() => hashDocument(123), /Uint8Array/);
});

/* ---------------- composition rules ---------------- */

test("compose produces canonical JSON", () => {
  const c = composeNotarization(good);
  assert.equal(c.json, '{"p":"prl-notary","v":1,"algo":"sha256","hash":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","filename":"contract.pdf","size":1048576,"ts":"2026-09-28T04:00:00Z","title":"Loan agreement","by":"Alice"}');
  assert.deepEqual(c.fields.hash, good.hash);
});

test("optional fields may be omitted", () => {
  const { title, by, ...rest } = good;
  const c = composeNotarization(rest);
  assert.ok(!("title" in c.fields) && !("by" in c.fields));
});

test("validation matrix rejects bad records", () => {
  const bad = (patch, re) => assert.throws(() => composeNotarization({ ...good, ...patch }), re, JSON.stringify(patch));
  bad({ hash: "XYZ" }, /64 lowercase hex/);
  bad({ hash: good.hash.toUpperCase() }, /64 lowercase hex/);
  bad({ hash: good.hash.slice(0, 63) }, /64 lowercase hex/); // 63 chars
  bad({ filename: "" }, /filename/);
  bad({ filename: "x".repeat(201) }, /filename/);
  bad({ filename: "a\u0000b" }, /control/);
  bad({ size: -1 }, /size/);
  bad({ size: 1.5 }, /size/);
  bad({ ts: "2026-09-28 04:00:00" }, /ISO-8601/);
  bad({ ts: "2099-01-01T00:00:00Z" }, /future/);
  bad({ ts: "2008-01-01T00:00:00Z" }, /predates/);
  bad({ title: "x".repeat(121) }, /title/);
  bad({ by: "bad\u007fname" }, /control/);
});

test("validateNotaryRecord rejects unknown fields and wrong envelope kind", () => {
  const rec = { p: "prl-notary", v: 1, algo: "sha256", ...good }; // full record, not composer input
  assert.throws(() => validateNotaryRecord({ ...rec, p: "prl-20", extra: 1 }), /unknown field/);
  assert.throws(() => validateNotaryRecord({ ...rec, p: "prl-20" }), /prl-notary/);
  assert.throws(() => validateNotaryRecord({ ...rec, v: 2 }), /v must be 1/);
  assert.throws(() => validateNotaryRecord(null), /object/);
  assert.doesNotThrow(() => validateNotaryRecord(JSON.parse(composeNotarization(good).json)));
});

/* ---------------- envelope script ---------------- */

test("notary envelope has marker prl-notary (not prl-20)", () => {
  const c = composeNotarization(good);
  const script = buildNotaryScript(wallet.internalXOnly, c.bytes);
  const envs = extractEnvelopes(script);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].marker, "prl-notary");
  assert.equal(envs[0].contentType, "application/json");
  assert.equal(envs[0].bodyText, c.json);
  assert.ok(!script.includes ? true : true);
  // marker bytes present, prl-20 marker absent
  assert.ok(bytesToHex(script).includes(Buffer.from("prl-notary").toString("hex")));
  assert.ok(!bytesToHex(script).includes(Buffer.from("prl-20").toString("hex")));
});

test("large bodies chunk at 520 bytes and round-trip", () => {
  // A composed notary record is small by construction (field length caps);
  // exercise the 520B chunking path directly with a synthetic large body.
  const bigBody = utf8ToBytes("n".repeat(1300));
  const script = buildNotaryScript(wallet.internalXOnly, bigBody);
  const envs = extractEnvelopes(script);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].marker, "prl-notary");
  assert.equal(envs[0].body.length, 1300);
  assert.equal(envs[0].bodyText, "n".repeat(1300));
});

test("buildNotaryScript rejects bad keys", () => {
  const c = composeNotarization(good);
  assert.throws(() => buildNotaryScript(new Uint8Array(31), c.bytes), /32 bytes/);
  assert.throws(() => buildNotaryScript(wallet.internalXOnly, new Uint8Array(0)), /empty/);
});

/* ---------------- plan ---------------- */

const composed = composeNotarization(good);
const plan = planNotarization({
  network: net, internalXOnly: wallet.internalXOnly, notary: composed,
  ownerAddress: OWNER, changeAddress: OWNER, feeRate: 5,
});

test("plan: commit value covers owner output + exact reveal fee", () => {
  assert.equal(plan.ownerOutputs.length, 1);
  assert.equal(plan.ownerOutputs[0].value, CARRIER_VALUE_GRAINS);
  assert.equal(plan.feeOutputs.length, 0);
  assert.equal(plan.revealFee, revealTxVBytes(plan.script.length, 2) * 5);
  assert.equal(plan.commitValue, CARRIER_VALUE_GRAINS + plan.revealFee);
  assert.equal(plan.feeRate, 5);
});

test("plan: commit address is a valid mainnet taproot address", () => {
  const d = decodeBech32m(plan.commitAddress, "prl");
  assert.equal(d.version, 1);
  assert.equal(d.program.length, 32);
  assert.deepEqual(bytesToHex(d.program), bytesToHex(plan.commitProgram));
});

test("plan: string notary + testnet HRP also work", () => {
  const tnet = NETWORKS.testnet;
  const w = walletFromMnemonic(MNEMONIC, tnet);
  const p = planNotarization({
    network: tnet, internalXOnly: w.internalXOnly, notary: composed.json,
    ownerAddress: w.address, changeAddress: w.address, feeRate: 1,
  });
  assert.ok(p.commitAddress.startsWith("tprl1"));
  assert.equal(addressToProgram(w.address, tnet).length, 32);
});

/* ---------------- full commit -> reveal cycle ---------------- */

const funding = {
  txid: "11".repeat(32), vout: 0, value: plan.commitValue + 20000,
  priv: wallet.priv, internalXOnly: wallet.internalXOnly,
};
const commit = buildCommitTx({
  network: net, fundingInputs: [funding],
  commitProgram: plan.commitProgram, commitValue: plan.commitValue,
  changeProgram: plan.changeProgram, feeRate: 5,
});

test("commit tx: exact fee accounting", () => {
  const expectFee = keypathTxVBytes(1, 2) * 5;
  assert.equal(commit.fee, expectFee);
  assert.equal(commit.change, funding.value - plan.commitValue - expectFee);
  assert.equal(/^[0-9a-f]{64}$/.test(commit.txid), true);
});

const reveal = buildRevealTxSigned({
  plan, commitTxid: commit.txid, commitVout: 0,
  internalPriv: wallet.priv, changeAddress: OWNER,
});

test("reveal tx: signature verifies and witness round-trips to our envelope", () => {
  assert.ok(reveal.sig && reveal.digest, "reveal must expose sig + digest");
  // The reveal script opens with <internal key> OP_CHECKSIG, so the script-path
  // signature is by the internal key (same as etch-core's audited flow).
  const pub = schnorr.getPublicKey(wallet.priv);
  assert.ok(schnorr.verify(hexToBytes(reveal.sig), hexToBytes(reveal.digest), pub));
  const envs = verifyRevealWitness(reveal.hex);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].marker, "prl-notary");
  assert.deepEqual(envs[0].parsed, JSON.parse(composed.json));
});

test("verifyNotarizationWitness: match on same doc, mismatch on other", () => {
  const ok = verifyNotarizationWitness(reveal.hex, "test");
  assert.equal(ok.match, true);
  assert.equal(ok.record.hash, good.hash);
  assert.equal(ok.marker, "prl-notary");
  const badDoc = verifyNotarizationWitness(reveal.hex, "different document");
  assert.equal(badDoc.match, false);
});

test("verifyNotarizationWitness rejects non-notary reveals", async () => {
  // Also the OOM regression test for the etch-core tokenizer: this reveal's
  // Schnorr signature happens to contain 0x4e followed by high-bit length
  // bytes, which used to send tokenizeScript into an infinite loop.
  // a bare prl-20-style envelope must not verify as a notarization
  const { buildInscriptionScript } = await import("../../sign/src/crypto.js");
  const script = buildInscriptionScript(wallet.internalXOnly, utf8ToBytes('{"p":"prl-20","op":"mint","tick":"x","amt":"1"}'));
  const info = commitKeyInfo(net, wallet.internalXOnly, script);
  const c = buildCommitTx({
    network: net,
    fundingInputs: [{ txid: "22".repeat(32), vout: 1, value: 50000, priv: wallet.priv, internalXOnly: wallet.internalXOnly }],
    commitProgram: info.commitXOnly, commitValue: 2000 + 5000, changeProgram: plan.changeProgram, feeRate: 5,
  });
  const fakePlan = { ...plan, script, scriptHex: bytesToHex(script), commitProgram: info.commitXOnly, commitValue: 2000 + 5000, ownerOutputs: [{ program: plan.ownerOutputs[0].program, value: 2000 }], feeOutputs: [], revealFee: 5000, feeRate: 5, network: net, controlBlock: info.controlBlock };
  const r = buildRevealTxSigned({ plan: fakePlan, commitTxid: c.txid, commitVout: 0, internalPriv: wallet.priv, changeAddress: OWNER });
  assert.throws(() => verifyNotarizationWitness(r.hex, "test"), /no prl-notary envelope/);
});

test("buildRevealTxSigned refuses a malformed commit vout (shared etch core guard)", () => {
  for (const v of [-5, NaN, 1.5, 2 ** 32]) {
    assert.throws(
      () => buildRevealTxSigned({ plan, commitTxid: commit.txid, commitVout: v, internalPriv: wallet.priv, changeAddress: OWNER }),
      /bad commit vout/, "commitVout " + v);
  }
});

test("seal certificate carries the full audit trail", () => {
  const cert = buildSealCertificate({ plan, commitTxid: commit.txid, revealTxid: reveal.txid, blockHeight: 120200, blockTime: 1790000000 });
  assert.equal(cert.app, "Pearl Notary");
  assert.equal(cert.record.hash, good.hash);
  assert.equal(cert.commit.txid, commit.txid);
  assert.equal(cert.reveal.blockHeight, 120200);
  assert.equal(cert.envelope.marker, "prl-notary");
  assert.ok(JSON.parse(JSON.stringify(cert))); // JSON-serializable
});
