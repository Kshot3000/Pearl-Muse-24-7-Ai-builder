// Pearl Etch verification suite — node --test, zero new deps.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/etch.test.mjs
// Exercises the full inscription pipeline: spec JSON rules, batch script
// construction, commit address derivation, commit+reveal build/sign, and
// indexer-style witness round-trip parsing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NETWORKS, PRLS, DUST_GRAIN, CARRIER_VALUE_GRAINS,
  PRLS_FEE_RECIPIENT, prlsFeeProgram,
  composeOperation, buildBatchInscriptionScript, planInscription,
  buildCommitTx, buildRevealTxSigned, extractEnvelopes, verifyRevealWitness,
  witnessOfInput, addressToProgram,
  validatePrl20Json, newMnemonic, walletFromMnemonic, bytesToHex, hexToBytes, schnorr,
} from "../src/etch-core.js";
import {
  buildInscriptionScript, commitKeyInfo, revealTxVBytes, keypathTxVBytes,
  decodeBech32m,
} from "../../sign/src/crypto.js";
import { utf8ToBytes } from "@noble/hashes/utils";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const net = NETWORKS.mainnet;
const wallet = walletFromMnemonic(MNEMONIC, net);
const OWNER = wallet.address; // reuse wallet address as owner/change for tests

/* ---------------- PRL-20 JSON spec rules ---------------- */

test("valid deploy/mint/transfer compose cleanly", () => {
  const d = composeOperation("deploy", { tick: "pearl", max: "21000000", lim: "1000", dec: "8" });
  assert.equal(d.json, '{"p":"prl-20","op":"deploy","tick":"pearl","max":"21000000","lim":"1000","dec":"8"}');
  const m = composeOperation("mint", { tick: "prls", amt: "100000" });
  assert.equal(m.tick, "prls");
  const t = composeOperation("transfer", { tick: "PRLS", amt: "100000" }); // uppercase canonicalized
  assert.equal(t.tick, "prls");
});

test("prls deploy must use exact launch params", () => {
  assert.throws(() => composeOperation("deploy", { tick: "prls", max: "21000000", lim: "1000", dec: "8" }), /exact launch params/);
  const ok = composeOperation("deploy", { tick: "prls", max: "2100000000", lim: "100000", dec: "18" });
  assert.ok(ok.json.includes('"tick":"prls"'));
});

test("JSON rule violations are rejected", () => {
  // duplicate top-level fields
  let v = validatePrl20Json('{"p":"prl-20","op":"mint","tick":"prls","amt":"100000","amt":"1"}', "mint");
  assert.ok(!v.ok && v.errors.some((e) => e.includes("duplicate")));
  // leading zeros
  v = validatePrl20Json('{"p":"prl-20","op":"mint","tick":"prls","amt":"0100000"}', "mint");
  assert.ok(!v.ok);
  // negative / fractional
  v = validatePrl20Json('{"p":"prl-20","op":"mint","tick":"prls","amt":"-5"}', "mint");
  assert.ok(!v.ok);
  v = validatePrl20Json('{"p":"prl-20","op":"mint","tick":"prls","amt":"1.5"}', "mint");
  assert.ok(!v.ok);
  // bad ticker
  v = validatePrl20Json('{"p":"prl-20","op":"mint","tick":"UPPER!","amt":"1"}', "mint");
  assert.ok(!v.ok);
  assert.throws(() => composeOperation("mint", { tick: "waytoolongtickername", amt: "1" }), /tick/);
  // dec range
  assert.throws(() => composeOperation("deploy", { tick: "pearl", max: "100", lim: "10", dec: "19" }), /dec/);
  // extra + missing fields
  v = validatePrl20Json('{"p":"prl-20","op":"mint","tick":"prls","amt":"100000","fee":"1"}', "mint");
  assert.ok(!v.ok && v.errors.some((e) => e.includes("unknown field")));
  v = validatePrl20Json('{"p":"prl-20","op":"mint","tick":"prls"}', "mint");
  assert.ok(!v.ok && v.errors.some((e) => e.includes("missing")));
  // wrong p / op
  v = validatePrl20Json('{"p":"brc-20","op":"mint","tick":"prls","amt":"100000"}', "mint");
  assert.ok(!v.ok);
  // lim > max
  assert.throws(() => composeOperation("deploy", { tick: "pearl", max: "100", lim: "101", dec: "8" }), /lim/);
  // zero amt
  assert.throws(() => composeOperation("mint", { tick: "pearl", amt: "0" }), /amt/);
  // not JSON / not object
  v = validatePrl20Json("not json", "mint");
  assert.ok(!v.ok);
  v = validatePrl20Json("[1,2]", "mint");
  assert.ok(!v.ok);
});

/* ---------------- batch script construction ---------------- */

test("single-op batch script is byte-identical to crypto.js single builder", () => {
  const body = utf8ToBytes('{"p":"prl-20","op":"mint","tick":"prls","amt":"100000"}');
  const a = buildBatchInscriptionScript(wallet.internalXOnly, [body]);
  const b = buildInscriptionScript(wallet.internalXOnly, body);
  assert.ok(a.every((x, i) => x === b[i]) && a.length === b.length);
});

test("multi-envelope batch parses in order (indexer-style)", () => {
  const bodies = [
    utf8ToBytes('{"p":"prl-20","op":"mint","tick":"prls","amt":"100000"}'),
    utf8ToBytes('{"p":"prl-20","op":"transfer","tick":"pearl","amt":"42"}'),
  ];
  const script = buildBatchInscriptionScript(wallet.internalXOnly, bodies);
  const envs = extractEnvelopes(script);
  assert.equal(envs.length, 2);
  assert.equal(envs[0].marker, "prl-20");
  assert.equal(envs[0].contentType, "application/json");
  assert.equal(envs[0].bodyText, Buffer.from(bodies[0]).toString("utf8"));
  assert.equal(envs[1].bodyText, Buffer.from(bodies[1]).toString("utf8"));
});

test("commit address is a valid bech32m P2TR address decoding to the commit key", () => {
  const script = buildBatchInscriptionScript(wallet.internalXOnly, [utf8ToBytes('{"p":"prl-20","op":"mint","tick":"prls","amt":"100000"}')]);
  const info = commitKeyInfo(net, wallet.internalXOnly, script);
  assert.ok(info.commitAddress.startsWith("prl1p"));
  assert.equal(info.commitAddress.length, 63); // prl(3)+1+version(1)+program(52)+checksum(6)
  const d = decodeBech32m(info.commitAddress, "prl");
  assert.ok(d.program.every((x, i) => x === info.commitXOnly[i]));
  assert.equal(info.controlBlock.length, 33);
  assert.equal(info.controlBlock[0] & 0xfe, 0xc0);
});

/* ---------------- full cycle: batch prls mint ---------------- */

function fakeFunding(value) {
  return {
    txid: "11".repeat(32), vout: 0, value,
    priv: wallet.priv, internalXOnly: wallet.internalXOnly,
  };
}

test("full cycle: 2-mint prls batch — commit, reveal, witness round-trip", () => {
  const plan = planInscription({
    network: net, internalXOnly: wallet.internalXOnly,
    ops: [
      { op: "mint", params: { tick: "prls", amt: "100000" } },
      { op: "mint", params: { tick: "prls", amt: "100000" } },
    ],
    ownerAddress: OWNER, changeAddress: OWNER, feeRate: 5,
  });
  // pure mint batch shares one owner output
  assert.equal(plan.ownerOutputs.length, 1);
  assert.equal(plan.ownerOutputs[0].value, CARRIER_VALUE_GRAINS);
  // PRLS fee: 2 mints x 1 PRL to the manifest recipient
  assert.equal(plan.prlsMints, 2);
  assert.equal(plan.feeOutputs.length, 1);
  assert.equal(plan.feeOutputs[0].value, 2 * 100_000_000);
  assert.ok(plan.feeOutputs[0].program.every((x, i) => x === prlsFeeProgram()[i]));
  assert.equal(plan.prlsFeeNote, null);
  assert.ok(plan.commitValue > 0);

  const commit = buildCommitTx({
    network: net, fundingInputs: [fakeFunding(plan.commitValue + 50_000)],
    commitProgram: plan.commitProgram, commitValue: plan.commitValue,
    changeProgram: plan.changeProgram, feeRate: 5,
  });
  assert.match(commit.txid, /^[0-9a-f]{64}$/);
  assert.ok(commit.change >= 0);
  // commit fee covers the keypath vBytes
  const nOut = commit.change > 0 ? 2 : 1;
  assert.ok(commit.fee >= keypathTxVBytes(1, nOut) * 5);

  const reveal = buildRevealTxSigned({
    plan, commitTxid: commit.txid, commitVout: 0,
    internalPriv: wallet.priv, changeAddress: OWNER,
  });
  assert.match(reveal.txid, /^[0-9a-f]{64}$/);
  // reveal outputs: owner + PRLS fee + change
  // fee sanity: commitValue - outputs = fee charged
  assert.ok(reveal.fee >= 0);

  // signature verifies against the script-path sighash digest
  const pub = schnorr.getPublicKey(wallet.priv);
  assert.ok(schnorr.verify(hexToBytes(reveal.sig), hexToBytes(reveal.digest), pub));

  // indexer-style round-trip: parse the reveal witness like an indexer would
  const envs = verifyRevealWitness(reveal.hex);
  assert.equal(envs.length, 2);
  assert.deepEqual(envs[0].parsed, JSON.parse(plan.envelopes[0].json));
  assert.deepEqual(envs[1].parsed, JSON.parse(plan.envelopes[1].json));

  // vBytes estimate is a safe upper bound: measure the real serialized weight
  // and check it against the estimator at the ACTUAL output count.
  const raw = hexToBytes(reveal.hex);
  const wit = witnessOfInput(reveal.hex, 0);
  const witEnc = 1 + wit.reduce((n, x) => n + 1 + x.length, 0); // count + 1-byte len prefixes
  const base = raw.length - witEnc - 2; // - segwit marker/flag
  const nOutActual = raw[4 + 2 + 1 + 41]; // version + marker/flag + in-count + input
  assert.equal(Math.ceil((base * 3 + raw.length) / 4), revealTxVBytes(plan.script.length, nOutActual));
  // and the fee actually charged covers that weight at the fee rate
  assert.ok(reveal.fee >= revealTxVBytes(plan.script.length, nOutActual) * 5);
});

test("mixed batch maps one owner output per envelope", () => {
  const plan = planInscription({
    network: net, internalXOnly: wallet.internalXOnly,
    ops: [
      { op: "transfer", params: { tick: "pearl", amt: "10" } },
      { op: "transfer", params: { tick: "pearl", amt: "20" } },
    ],
    ownerAddress: OWNER, changeAddress: OWNER, feeRate: 5,
  });
  assert.equal(plan.ownerOutputs.length, 2);
  assert.equal(plan.feeOutputs.length, 0);
  const reveal = buildRevealTxSigned({
    plan, commitTxid: "22".repeat(32), commitVout: 1,
    internalPriv: wallet.priv, changeAddress: OWNER,
  });
  const envs = verifyRevealWitness(reveal.hex);
  assert.equal(envs.length, 2);
  assert.equal(envs[0].parsed.amt, "10");
  assert.equal(envs[1].parsed.amt, "20");
});

test("prls mint on testnet skips the mainnet fee recipient with a warning", () => {
  const tnet = NETWORKS.testnet;
  const tw = walletFromMnemonic(MNEMONIC, tnet);
  const plan = planInscription({
    network: tnet, internalXOnly: tw.internalXOnly,
    ops: [{ op: "mint", params: { tick: "prls", amt: "100000" } }],
    ownerAddress: tw.address, changeAddress: tw.address, feeRate: 5,
  });
  assert.equal(plan.feeOutputs.length, 0);
  assert.ok(plan.prlsFeeNote && plan.prlsFeeNote.includes("mainnet"));
  assert.ok(plan.commitAddress.startsWith("tprl1p"));
});

test("PRLS fee program matches the release manifest scriptPubKey", () => {
  const prog = prlsFeeProgram();
  assert.equal(bytesToHex(prog), "0effd3c4e44fd3886e8c1ebe943138fa6a944e21e4bbe7e2d9ab800b7f4c4ffa");
  assert.equal(PRLS_FEE_RECIPIENT, "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea");
});

test("commit tx refuses insufficient funds with a clear error", () => {
  const plan = planInscription({
    network: net, internalXOnly: wallet.internalXOnly,
    ops: [{ op: "mint", params: { tick: "pearl", amt: "5" } }],
    ownerAddress: OWNER, changeAddress: OWNER, feeRate: 5,
  });
  assert.throws(() => buildCommitTx({
    network: net, fundingInputs: [fakeFunding(100)],
    commitProgram: plan.commitProgram, commitValue: plan.commitValue,
    changeProgram: plan.changeProgram, feeRate: 5,
  }), /insufficient funds/);
});

test("addressToProgram enforces network HRP", () => {
  const prog = addressToProgram(OWNER, net);
  assert.equal(prog.length, 32);
  const tnet = NETWORKS.testnet;
  assert.throws(() => addressToProgram(OWNER, tnet), /wrong network/);
  assert.throws(() => addressToProgram("not an address", net), /missing separator|invalid char|bad checksum/);
});

test("newMnemonic produces a valid wallet", () => {
  const m = newMnemonic();
  const w = walletFromMnemonic(m, net);
  assert.ok(w.address.startsWith("prl1p"));
  assert.equal(w.internalXOnly.length, 32);
});

test("tokenizer survives 0x4e with high-bit length (signed-shift OOM regression)", () => {
  // 2026-09-28: OP_PUSHDATA4 length decoded with signed `<< 24` wrapped
  // negative on high-bit lengths (occurs naturally inside random Schnorr
  // signatures, which extractEnvelopes scans as candidate leaves), driving
  // the tokenizer offset hugely negative into an infinite OOM loop.
  // Must terminate and yield no envelopes.
  const hostile = new Uint8Array([0xa1, 0x74, 0xe4, 0x90, 0x92, 0xdd, 0xc5, 0x4e, 0x89, 0xe9, 0x0a, 0xfa, 0x3f, 0xdb, 0xcb, 0xc1]);
  const envs = extractEnvelopes(hostile);
  assert.deepEqual(envs, []);
});

test("app.js grain formatter is BigInt-exact (pool float-format class)", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "app.js"), "utf8");
  assert.ok(src.includes("100000000n"), "BigInt-exact grain formatter present");
  assert.ok(src.includes("/^-?\\d+$/"), "integer-grain gate present");
});

test("buildRevealTxSigned refuses a malformed commit vout (no u32 wrap into a signed tx)", () => {
  const plan = planInscription({
    network: net, internalXOnly: wallet.internalXOnly,
    ops: [{ op: "mint", params: { tick: "prls", amt: "100000" } }],
    ownerAddress: OWNER, changeAddress: OWNER, feeRate: 5,
  });
  // u32le wrapped each of these into a plausible-looking outpoint and the
  // reveal was signed over it (probe: hidden_files/run-2026-10-10-1813).
  for (const v of [-5, NaN, 1.5, 2 ** 32]) {
    assert.throws(
      () => buildRevealTxSigned({ plan, commitTxid: "11".repeat(32), commitVout: v, internalPriv: wallet.priv, changeAddress: OWNER }),
      /bad commit vout/, "commitVout " + v);
  }
});

test("reveal UI parses the commit vout strictly (no parseInt truncation / || 0 coercion)", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(!app.includes('parseInt($("reveal-commit-vout")'), "no parseInt on the commit vout field");
  assert.ok(app.includes("commit vout must be a non-negative integer"), "strict vout gate present");
});

test("buildCommitTx refuses malformed funding inputs up front (no NaN/rounded fee math)", () => {
  const prog = addressToProgram(OWNER, net);
  const base = { network: net, commitProgram: prog, commitValue: 100000, changeProgram: prog, feeRate: 5 };
  const good = fakeFunding(1000000);
  assert.throws(() => buildCommitTx({ ...base, fundingInputs: [{ ...good, vout: NaN }] }), /bad funding input vout/);
  assert.throws(() => buildCommitTx({ ...base, fundingInputs: [{ ...good, vout: -1 }] }), /bad funding input vout/);
  assert.throws(() => buildCommitTx({ ...base, fundingInputs: [{ ...good, value: NaN }] }), /bad funding input value/);
  assert.throws(() => buildCommitTx({ ...base, fundingInputs: [{ ...good, value: 9007199254740992 }] }), /bad funding input value/);
  assert.throws(() => buildCommitTx({ ...base, fundingInputs: [{ ...good, value: 0 }] }), /bad funding input value/);
  assert.throws(() => buildCommitTx({ ...base, fundingInputs: [{ ...good, txid: "zz" }] }), /bad funding input txid/);
});
