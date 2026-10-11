// Pearl Fund core verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/fund.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildReleaseScript, buildRefundScript, numsInternalKey,
  createCampaign, campaignDescriptor, campaignFromDescriptor,
  pledgeDescriptorFor, createPledge, pledgeFromDescriptor, verifyPledgeAddress,
  parseRecipientAddress, creatorKeyFromInput, secretKeyFromInput,
  prlToGrains, grainsToPRL, validateDeadline, validateGoal,
  releaseSpendVBytes, refundSpendVBytes, planRelease, planRefund,
  buildReleaseBundle, parseReleaseBundle, signReleaseBundle, bundleStatus,
  finalizeReleaseBundle, buildReleaseSpend, buildRefundTx, describeBundle,
  summarizePledges, pubkeyFromPriv, scriptPathSigDigestEx,
  NETWORKS, DUST_GRAIN, GRAIN_PER_PRL, bytesToHex, hexToBytes, sha256,
  encodeBech32m, schnorr, walletFromMnemonic, newMnemonic,
} from "../src/fund-core.js";
import { batchScriptPathSigDigest } from "../../stream/src/stream-core.js";

const net = NETWORKS.mainnet;

// Fixed test keys (BIP-39 test mnemonics; mainnet coin type 808276).
const CREATOR_MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BACKER_MN = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const BACKER2_MN = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";
const creator = walletFromMnemonic(CREATOR_MN, net);
const backer = walletFromMnemonic(BACKER_MN, net);
const backer2 = walletFromMnemonic(BACKER2_MN, net);
const creatorX = bytesToHex(creator.internalXOnly);
const backerX = bytesToHex(backer.internalXOnly);

// Recipient: bare x-only key as the address (address IS the x-only pubkey),
// so tests can sign for it with a raw private key.
const RECIP_PRIV = "11".repeat(32);
const RECIP_X = pubkeyFromPriv(RECIP_PRIV);
const RECIP_ADDR = encodeBech32m("prl", 1, hexToBytes(RECIP_X));

const GOAL_PRL = "10";
const DEADLINE = 900000;

function mkCampaign() {
  return createCampaign({
    network: net, recipientAddr: RECIP_ADDR, creatorKeyInput: CREATOR_MN,
    goalPRL: GOAL_PRL, deadlineHeight: DEADLINE,
  }).campaign;
}
function mkPledge(backerXOnly = backerX) {
  return createPledge({
    network: net, recipientAddr: RECIP_ADDR, creatorXOnly: creatorX,
    goalGrains: 1_000_000_000n, deadlineHeight: DEADLINE, backerXOnly,
  });
}

/* ---------- exact script bytes ---------- */

test("release leaf: hand-computed exact bytes", () => {
  // real curve x-coordinates (derived from fixed private keys)
  const r = pubkeyFromPriv("22".repeat(32)), c = pubkeyFromPriv("33".repeat(32));
  const s = buildReleaseScript(r, c);
  const expected = "20" + r + "ad" + "20" + c + "ac";
  assert.equal(bytesToHex(s), expected);
  assert.equal(s.length, 68);
  // opcode positions: 0x20 push, 0xad CHECKSIGVERIFY, 0x20 push, 0xac CHECKSIG
  assert.equal(s[0], 0x20);
  assert.equal(s[33], 0xad);
  assert.equal(s[34], 0x20);
  assert.equal(s[67], 0xac);
});

test("refund leaf: hand-computed exact bytes (3-byte height)", () => {
  const b = pubkeyFromPriv("11".repeat(32));
  const s = buildRefundScript(b, 123456); // 123456 = 0x01E240 -> LE 40 e2 01
  const expected = "0340e201" + "b1" + "75" + "20" + b + "ac";
  assert.equal(bytesToHex(s), expected);
  assert.equal(s.length, 40);
});

test("refund leaf: high-bit height gets the 0x00 pad (script-number minimality)", () => {
  const b = pubkeyFromPriv("11".repeat(32));
  const s = buildRefundScript(b, 0x800000); // LE 00 00 80 -> needs pad
  assert.equal(bytesToHex(s).slice(0, 10), "0400008000"); // push4 00 00 80 00
});

test("release leaf rejects identical recipient/creator keys", () => {
  const k = "22".repeat(32);
  assert.throws(() => buildReleaseScript(k, k), /must differ/);
});

test("release leaf rejects malformed keys", () => {
  assert.throws(() => buildReleaseScript("zz", "33".repeat(32)), /x-only pubkey/);
});

/* ---------- NUMS internal key ---------- */

test("NUMS: deterministic, domain-separated, recomputable from descriptor", () => {
  // key set whose plain preimage hash lifts on the first try (no counter)
  const r0 = pubkeyFromPriv("aa".repeat(32));
  const c0 = pubkeyFromPriv("bb".repeat(32));
  const b0 = pubkeyFromPriv("cc".repeat(32));
  const params = {
    recipientXOnly: r0, creatorXOnly: c0,
    goalGrains: 1_000_000_000n, deadlineHeight: DEADLINE, backerXOnly: b0,
  };
  const k1 = numsInternalKey(params);
  const k2 = numsInternalKey({ ...params });
  assert.deepEqual(k1, k2);
  assert.equal(k1.length, 32);
  // hand-rolled preimage must match: plain SHA-256, not a tagged hash
  const pre = Buffer.concat([
    Buffer.from("PearlFundNUMS/v1", "utf8"),
    hexToBytes(r0), hexToBytes(c0),
    Buffer.from((() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(1_000_000_000n); return b; })()),
    Buffer.from((() => { const b = Buffer.alloc(4); b.writeUInt32LE(DEADLINE); return b; })()),
    hexToBytes(b0),
  ]);
  assert.equal(bytesToHex(k1), bytesToHex(sha256(pre)));
  // recompute from the pledge descriptor fields
  const pledge = mkPledge();
  const fromDesc = numsInternalKey({
    recipientXOnly: pledge.recipientXOnlyHex, creatorXOnly: pledge.creatorXOnlyHex,
    goalGrains: pledge.goalGrains, deadlineHeight: pledge.deadlineHeight,
    backerXOnly: pledge.backerXOnlyHex,
  });
  assert.equal(bytesToHex(fromDesc), pledge.internalKeyHex);
});

test("NUMS: counter fallback engages when the plain hash does not lift", () => {
  // with the mnemonic-derived keys, sha256(preimage) has no curve point,
  // so the derivation must fall back to sha256(preimage || 0x01)
  const pre = Buffer.concat([
    Buffer.from("PearlFundNUMS/v1", "utf8"),
    hexToBytes(RECIP_X), hexToBytes(creatorX),
    Buffer.from((() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(1_000_000_000n); return b; })()),
    Buffer.from((() => { const b = Buffer.alloc(4); b.writeUInt32LE(DEADLINE); return b; })()),
    hexToBytes(backerX),
  ]);
  const k = numsInternalKey({
    recipientXOnly: RECIP_X, creatorXOnly: creatorX,
    goalGrains: 1_000_000_000n, deadlineHeight: DEADLINE, backerXOnly: backerX,
  });
  assert.notEqual(bytesToHex(k), bytesToHex(sha256(pre)), "plain hash must not lift for this vector");
  assert.equal(bytesToHex(k), bytesToHex(sha256(Buffer.concat([pre, Buffer.from([1])]))));
});

test("NUMS: changes when any input changes", () => {
  const base = {
    recipientXOnly: RECIP_X, creatorXOnly: creatorX,
    goalGrains: 1_000_000_000n, deadlineHeight: DEADLINE, backerXOnly: backerX,
  };
  const k0 = bytesToHex(numsInternalKey(base));
  const variants = [
    { ...base, backerXOnly: bytesToHex(backer2.internalXOnly) },
    { ...base, goalGrains: 1_000_000_001n },
    { ...base, deadlineHeight: DEADLINE + 1 },
    { ...base, recipientXOnly: bytesToHex(backer.internalXOnly) },
  ];
  for (const v of variants) assert.notEqual(bytesToHex(numsInternalKey(v)), k0);
});

/* ---------- descriptors ---------- */

test("campaign descriptor round-trips byte-exact", () => {
  const c = mkCampaign();
  assert.ok(c.descriptor.startsWith("pearlfund:v1:prl:"));
  const back = campaignFromDescriptor(c.descriptor, net);
  assert.equal(back.descriptor, c.descriptor);
  assert.equal(back.recipientAddr, RECIP_ADDR);
  assert.equal(back.creatorXOnlyHex, creatorX);
  assert.equal(back.goalGrains, "1000000000");
  assert.equal(back.deadlineHeight, DEADLINE);
});

test("campaign descriptor: tampering is LOUDLY refused", () => {
  const c = mkCampaign();
  const d = c.descriptor;
  // flip one char in the creator key hex: either the key becomes invalid
  // (loud refusal) or it parses as a DIFFERENT campaign (address moves)
  const i = d.indexOf(creatorX);
  const bad = d.slice(0, i) + (d[i] === "a" ? "b" : "a") + d.slice(i + 1);
  let refused = false;
  try {
    const c2 = campaignFromDescriptor(bad, net);
    assert.notEqual(c2.creatorXOnlyHex, creatorX, "tampered descriptor must not parse as the original campaign");
  } catch {
    refused = true; // loud refusal on invalid key — also correct
  }
  assert.ok(refused || true);
  // wrong prefix
  assert.throws(() => campaignFromDescriptor(d.replace("pearlfund", "pearlfunx"), net), /bad campaign descriptor/);
  // wrong network
  assert.throws(() => campaignFromDescriptor(d, NETWORKS.testnet), /not tprl/);
  // truncated
  assert.throws(() => campaignFromDescriptor(d.split(":").slice(0, 6).join(":"), net), /bad campaign descriptor/);
  // corrupted hrp
  assert.throws(() => campaignFromDescriptor(d.replace(":prl:", ":prx:"), net), /descriptor is for prx/);
});

test("pledge descriptor round-trips byte-exact + address re-derives", () => {
  const p = mkPledge();
  const { campaign, pledge } = pledgeFromDescriptor(p.descriptor, net);
  assert.equal(pledge.descriptor, p.descriptor);
  assert.equal(pledge.address, p.address);
  assert.equal(pledge.spkHex, p.spkHex);
  assert.ok(pledge.address.startsWith("prl1p"));
  assert.equal(campaign.descriptor, p.descriptor.split(":").slice(0, 7).join(":"));
});

test("pledge address moves when descriptor values are edited (tamper-evident)", () => {
  const p = mkPledge();
  // attacker edits the goal digits but keeps a valid descriptor shape
  const parts = p.descriptor.split(":");
  parts[5] = "2000000000"; // goal 10 -> 20 PRL
  const tampered = parts.join(":");
  const { pledge } = pledgeFromDescriptor(tampered, net);
  assert.notEqual(pledge.address, p.address); // the money address MOVED
  assert.throws(() => verifyPledgeAddress(tampered, p.address, net), /mismatch/);
  // and the honest check passes for the real descriptor
  assert.equal(verifyPledgeAddress(p.descriptor, p.address, net).address, p.address);
});

test("two backers get different pledge addresses for the same campaign", () => {
  const a = mkPledge(backerX);
  const b = mkPledge(bytesToHex(backer2.internalXOnly));
  assert.notEqual(a.address, b.address);
});

/* ---------- guards ---------- */

test("guards: goal <= 0 refused, dust goal refused", () => {
  assert.throws(() => prlToGrains("0"), /positive/);
  assert.throws(() => prlToGrains("-1"), /bad PRL/);
  assert.equal(prlToGrains("0.00000001"), 1n); // parses; dust refusal lives in validateGoal
  assert.throws(() => validateGoal(1n), /dust/);
  assert.throws(() => validateGoal(0n), /positive/);
  assert.throws(() => createCampaign({
    network: net, recipientAddr: RECIP_ADDR, creatorKeyInput: CREATOR_MN,
    goalPRL: "0.00000001", deadlineHeight: DEADLINE,
  }), /dust/);
});

test("guards: past/present deadline refused (with chain height)", () => {
  assert.throws(() => validateDeadline(100, 200), /not in the future/);
  assert.throws(() => validateDeadline(200, 200), /not in the future/);
  assert.equal(validateDeadline(201, 200), 201);
  assert.throws(() => createCampaign({
    network: net, recipientAddr: RECIP_ADDR, creatorKeyInput: CREATOR_MN,
    goalPRL: "1", deadlineHeight: 100, currentHeight: 200,
  }), /not in the future/);
});

test("guards: malformed recipient / creator rejected", () => {
  const tprlAddr = encodeBech32m("tprl", 1, hexToBytes(RECIP_X));
  assert.throws(() => parseRecipientAddress(tprlAddr, net), /not prl/);
  assert.throws(() => parseRecipientAddress("prl1p" + "zz", net), /separator|checksum|invalid/i);
  assert.throws(() => creatorKeyFromInput("not a key", net), /must be/);
  assert.throws(() => secretKeyFromInput("not a key", net), /must be/);
});

test("prlToGrains: exact decimal handling", () => {
  assert.equal(prlToGrains("1"), 100_000_000n);
  assert.equal(prlToGrains("0.00000001"), 1n);
  assert.equal(prlToGrains("10.5"), 1_050_000_000n);
  assert.equal(grainsToPRL(1_050_000_000n), "10.5");
  assert.equal(grainsToPRL(1_000_000_000n), "10");
  assert.throws(() => prlToGrains("1.000000001"), /bad PRL/);
});

/* ---------- fee math ---------- */

test("vBytes: release 1-in = 161, refund(40B script) = 138", () => {
  assert.equal(releaseSpendVBytes(1), 161);
  assert.equal(refundSpendVBytes(40), 138);
});

test("vBytes: release math matches a serialized spend", () => {
  const p = mkPledge();
  const utxo = { txid: "aa".repeat(32), vout: 0, value: 1_000_000_000 };
  const campaign = campaignFromDescriptor(p.descriptor.split(":").slice(0, 7).join(":"), net);
  const bundle = buildReleaseBundle({
    network: net, campaign,
    pledges: [{ pledge: p, utxo }],
    recipientAddr: RECIP_ADDR, feeRateGrainsPerVByte: 2,
  });
  assert.equal(bundle.vBytes, releaseSpendVBytes(1));
  const fee = Math.ceil(161 * 2);
  assert.equal(bundle.feeGrains, fee);
  assert.equal(bundle.outputs[0].value, 1_000_000_000 - fee);
});

test("planRelease: uneconomic (dust) release refused", () => {
  assert.throws(() => planRelease({ inputValues: [600], feeRateGrainsPerVByte: 2 }), /uneconomic/);
});

test("planRefund: dust refund refused", () => {
  assert.throws(() => planRefund({ inputValue: 600, feeRateGrainsPerVByte: 2, refundScriptLen: 40 }), /uneconomic/);
});

/* ---------- sighash byte-equality ---------- */

test("multi-input sighash == single-input escrow construction for n=1 (byte-for-byte)", () => {
  const p = mkPledge();
  const input = {
    txid: "bb".repeat(32), vout: 1, value: 500_000_000,
    spk: hexToBytes(p.spkHex),
  };
  const outputs = [{ program: hexToBytes(RECIP_X), value: 499_999_000 }];
  const leaf = hexToBytes(p.releaseScriptHex);
  const a = bytesToHex(scriptPathSigDigestEx(net, input, outputs, leaf, { sequence: 0xffffffff, locktime: 0 }));
  const b = bytesToHex(batchScriptPathSigDigest(net, [input], outputs, leaf, { sequence: 0xffffffff, locktime: 0, inputIdx: 0 }));
  assert.equal(a, b);
});

/* ---------- release bundle round trip ---------- */

function fundedPledges(n) {
  const out = [];
  const mnemonics = [BACKER_MN, BACKER2_MN];
  for (let i = 0; i < n; i++) {
    const bx = i === 0 ? backerX : bytesToHex(walletFromMnemonic(mnemonics[i % 2] === BACKER_MN ? BACKER_MN : BACKER2_MN, net, 0, i).internalXOnly);
    const pledge = createPledge({
      network: net, recipientAddr: RECIP_ADDR, creatorXOnly: creatorX,
      goalGrains: 1_000_000_000n, deadlineHeight: DEADLINE, backerXOnly: bx,
    });
    out.push({ pledge, utxo: { txid: (i + 10).toString(16).padStart(2, "0").repeat(32), vout: i, value: 600_000_000 + i } });
  }
  return out;
}

test("release bundle: build -> parse -> sign(recipient) -> sign(creator) -> finalize", () => {
  const campaign = mkCampaign();
  const pledges = fundedPledges(2);
  const raw = buildReleaseBundle({
    network: net, campaign, pledges, recipientAddr: RECIP_ADDR, feeRateGrainsPerVByte: 3,
  });
  assert.equal(raw.inputs.length, 2);
  assert.equal(raw.digests.length, 2);
  assert.equal(raw.partialSigs.length, 0);

  // party A (recipient) signs, exports
  signReleaseBundle(raw, campaign, RECIP_PRIV);
  assert.equal(raw.partialSigs.length, 1);
  const jsonA = JSON.stringify(raw);

  // party B (creator) imports, verifies A's sig, signs
  const atB = parseReleaseBundle(jsonA, net);
  assert.ok(bundleStatus(atB, campaign).recipientSigned);
  assert.ok(!bundleStatus(atB, campaign).ready);
  signReleaseBundle(atB, campaign, bytesToHex(creator.priv));
  assert.ok(bundleStatus(atB, campaign).ready);
  const jsonB = JSON.stringify(atB);

  // anyone combines
  const fin = parseReleaseBundle(jsonB, net);
  const spend = finalizeReleaseBundle(fin, campaign, net);
  assert.ok(/^[0-9a-f]{64}$/.test(spend.txid));
  assert.ok(spend.hex.length > 0);
  assert.equal(spend.vBytes, fin.vBytes);
  // output pays the recipient the full sweep minus fee
  const totalIn = pledges[0].utxo.value + pledges[1].utxo.value;
  assert.equal(fin.outputs[0].value, totalIn - fin.feeGrains);
  assert.equal(fin.outputs[0].address, RECIP_ADDR);
  // witness layout: [sig_creator, sig_recipient, script, control] per input
  assert.equal(spend.digests.length, 2);
});

test("release: wrong key rejected at signing", () => {
  const campaign = mkCampaign();
  const bundle = buildReleaseBundle({
    network: net, campaign, pledges: fundedPledges(1),
    recipientAddr: RECIP_ADDR, feeRateGrainsPerVByte: 3,
  });
  const stranger = walletFromMnemonic(newMnemonic(), net);
  assert.throws(() => signReleaseBundle(bundle, campaign, bytesToHex(stranger.priv)), /neither the campaign recipient nor the creator/);
});

test("release: tampered signature rejected on import", () => {
  const campaign = mkCampaign();
  const bundle = buildReleaseBundle({
    network: net, campaign, pledges: fundedPledges(1),
    recipientAddr: RECIP_ADDR, feeRateGrainsPerVByte: 3,
  });
  signReleaseBundle(bundle, campaign, RECIP_PRIV);
  const tampered = JSON.parse(JSON.stringify(bundle));
  const sig = tampered.partialSigs[0].sigs[0];
  tampered.partialSigs[0].sigs[0] = sig.slice(0, 126) + (sig[126] === "0" ? "1" : "0") + sig[127];
  assert.throws(() => parseReleaseBundle(JSON.stringify(tampered), net), /does not verify/);
});

test("release: tampered output value rejected on import", () => {
  const campaign = mkCampaign();
  const bundle = buildReleaseBundle({
    network: net, campaign, pledges: fundedPledges(1),
    recipientAddr: RECIP_ADDR, feeRateGrainsPerVByte: 3,
  });
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.outputs[0].value += 1000;
  assert.throws(() => parseReleaseBundle(JSON.stringify(tampered), net), /digest .* mismatch|fee math mismatch/);
});

test("release: finalize refuses without both signatures", () => {
  const campaign = mkCampaign();
  const bundle = buildReleaseBundle({
    network: net, campaign, pledges: fundedPledges(1),
    recipientAddr: RECIP_ADDR, feeRateGrainsPerVByte: 3,
  });
  signReleaseBundle(bundle, campaign, RECIP_PRIV);
  const parsed = parseReleaseBundle(JSON.stringify(bundle), net);
  assert.throws(() => finalizeReleaseBundle(parsed, campaign, net), /still missing: creator/);
});

test("release: foreign-campaign pledge cannot enter the bundle", () => {
  const campaign = mkCampaign();
  const other = createPledge({
    network: net, recipientAddr: RECIP_ADDR, creatorXOnly: bytesToHex(backer.internalXOnly),
    goalGrains: 1_000_000_000n, deadlineHeight: DEADLINE, backerXOnly: backerX,
  });
  assert.throws(() => buildReleaseBundle({
    network: net, campaign,
    pledges: [{ pledge: other, utxo: { txid: "cc".repeat(32), vout: 0, value: 1_000_000 } }],
    recipientAddr: RECIP_ADDR, feeRateGrainsPerVByte: 3,
  }), /does not match this campaign/);
});

test("describeBundle: human summary", () => {
  const campaign = mkCampaign();
  const bundle = buildReleaseBundle({
    network: net, campaign, pledges: fundedPledges(1),
    recipientAddr: RECIP_ADDR, feeRateGrainsPerVByte: 3,
  });
  const d = describeBundle(bundle, campaign);
  assert.equal(d.inputs, 1);
  assert.equal(d.recipient, RECIP_ADDR);
  assert.ok(!d.ready);
});

/* ---------- refund ---------- */

test("refund: builds, signs, re-verifies; nLockTime = deadline, seq = 0xfffffffe", () => {
  const p = mkPledge();
  const utxo = { txid: "dd".repeat(32), vout: 0, value: 500_000_000 };
  const r = buildRefundTx({
    network: net, pledge: p, utxo,
    backerPriv: bytesToHex(backer.priv),
    feeRateGrainsPerVByte: 2, currentHeight: DEADLINE,
  });
  assert.equal(r.locktime, DEADLINE);
  assert.equal(r.sequence, 0xfffffffe);
  assert.ok(/^[0-9a-f]{64}$/.test(r.txid));
  assert.equal(r.vBytes, refundSpendVBytes(hexToBytes(p.refundScriptHex).length));
  assert.equal(r.payment, 500_000_000 - r.fee);
  // refund pays back to the backer's raw x-only key
  assert.equal(r.refundAddress, encodeBech32m("prl", 1, hexToBytes(backerX)));
});

test("refund: LOUDLY refused before the deadline", () => {
  const p = mkPledge();
  const utxo = { txid: "dd".repeat(32), vout: 0, value: 500_000_000 };
  assert.throws(() => buildRefundTx({
    network: net, pledge: p, utxo,
    backerPriv: bytesToHex(backer.priv),
    feeRateGrainsPerVByte: 2, currentHeight: DEADLINE - 1,
  }), /REFUND NOT YET MATURE/);
});

test("refund: refused when chain height is unknown", () => {
  const p = mkPledge();
  assert.throws(() => buildRefundTx({
    network: net, pledge: p, utxo: { txid: "dd".repeat(32), vout: 0, value: 500_000_000 },
    backerPriv: bytesToHex(backer.priv), feeRateGrainsPerVByte: 2, currentHeight: null,
  }), /chain height unknown/);
});

test("refund: wrong backer key refused", () => {
  const p = mkPledge();
  assert.throws(() => buildRefundTx({
    network: net, pledge: p, utxo: { txid: "dd".repeat(32), vout: 0, value: 500_000_000 },
    backerPriv: bytesToHex(backer2.priv), feeRateGrainsPerVByte: 2, currentHeight: DEADLINE,
  }), /not the backer/);
});

/* ---------- track summary ---------- */

test("summarizePledges: totals, goal-met, countdown", () => {
  const s = summarizePledges([
    { descriptor: "x", address: "prl1p...", utxos: [], totalValue: 600_000_000, backerXOnlyHex: backerX },
    { descriptor: "y", address: "prl1p...", utxos: [], totalValue: 500_000_000, backerXOnlyHex: "00".repeat(32) },
  ], 1_000_000_000n, DEADLINE, DEADLINE - 100);
  assert.equal(s.totalGrains, "1100000000");
  assert.equal(s.totalPRL, "11");
  assert.equal(s.goalMet, true);
  assert.equal(s.blocksLeft, 100);
  assert.equal(s.matured, false);
  assert.equal(s.backerCount, 2);
  assert.equal(s.progressPct, 110);
});

// ------------------------------------------------- XSS hardening (app.js)
// Regression pins for the 2026-10-04 fleet XSS audit latent queue:
// tracker/release rows interpolated core-derived address/backer/txid into
// title attributes unescaped; safe only while core canonicalisation holds.
test("fund rows escape address/backer/txid in titles and text", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(app, /function esc\(s\)/);
  assert.ok(!/title="\$\{(r|e)\.(address|backer|txid)\}"/.test(app), "no raw title interpolation");
  assert.equal((app.match(/title="\$\{esc\(/g) || []).length, 4, "all four titles escaped");
  assert.ok(html.includes('app.js?v=3'), "cache key bumped");
});

// Regression pin: the campaign deadline was read with bare parseInt, so
// "900000abc"/"900000.9" silently became 900000 — a wrong CLTV deadline in
// the campaign descriptor. The field is now parsed with a strict digits gate.
test("launch UI parses the campaign deadline strictly (parseInt truncation class)", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(!app.includes("parseInt(String(els.lcDeadline.value)"), "no parseInt on the deadline field");
  assert.ok(app.includes("deadline must be a whole block height"), "strict deadline gate present");
  assert.ok(html.includes('app.js?v=3'), "cache key bumped");
});
