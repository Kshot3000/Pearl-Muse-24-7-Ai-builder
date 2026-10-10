// Pearl Games core verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/games.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GAMES, parseGame, parseBet, stakesFor, validateTimeout,
  newSecret, commitmentFor, verifyReveal, outcomeFor, winnerFor, revealAndScore,
  descriptorFingerprint, createGame, gameFromDescriptor,
  buildSettleScript, numsInternalKey, escrowFor, verifyEscrowAddress,
  settleSpendVBytes, planSettle,
  buildSettleBundle, parseSettleBundle, signSettleBundle, settleBundleStatus,
  buildSettleSpend, settleBundleFingerprint,
  refundSpendVBytes, buildRefundTx,
  practiceRound, verifyGameTranscript,
  prlToGrains, grainsToPRL, pubkeyFromPriv, gameKeyFromInput,
  NETWORKS, DUST_GRAIN, bytesToHex, hexToBytes, sha256,
  encodeBech32m, walletFromMnemonic, signForXOnly, verifySchnorrSig,
  SETTLE_BUNDLE_KIND, DESCRIPTOR_KIND,
} from "../src/games-core.js";

const net = NETWORKS.mainnet;

const DEALER_MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PLAYER_MN = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const dealer = walletFromMnemonic(DEALER_MN, net);
const player = walletFromMnemonic(PLAYER_MN, net);
const dealerX = bytesToHex(dealer.internalXOnly);
const playerX = bytesToHex(player.internalXOnly);

function mkGame(game = "flip", bet = "heads", stakePRL = "1", timeout = 50000) {
  const g = createGame({
    network: net, game, bet, dealerXOnly: dealerX, playerXOnly: playerX,
    playerStakePRL: stakePRL, timeoutHeight: timeout,
  });
  return g;
}

function escrows(g, network = net) {
  const base = {
    network, dealerXOnly: g.dealerXOnly, playerXOnly: g.playerXOnly,
    game: g.game, bet: g.bet, stakeDealerGrains: g.stakeDealerGrains,
    stakePlayerGrains: g.stakePlayerGrains, timeoutHeight: g.timeoutHeight, roundId: g.roundId,
  };
  return { d: escrowFor({ ...base, depositor: "dealer" }), p: escrowFor({ ...base, depositor: "player" }) };
}

/* ---------------- game parsing ---------------- */

test("parseGame accepts the three games, rejects unknown", () => {
  assert.equal(parseGame("flip").id, "flip");
  assert.equal(parseGame("dice-exact").payoutMultiple, 5);
  assert.equal(parseGame("dice-hilo").evenMoney, true);
  assert.throws(() => parseGame("poker"), /unknown game/);
});

test("parseBet validates per game", () => {
  assert.equal(parseBet("flip", "Heads"), "heads");
  assert.equal(parseBet("dice-exact", "6"), "6");
  assert.equal(parseBet("dice-hilo", "LOW"), "low");
  assert.throws(() => parseBet("flip", "7"), /bad bet/);
  assert.throws(() => parseBet("dice-hilo", "7"), /bad bet/);
});

test("stakesFor: even money splits, dice-exact dealer posts 5x, dust refused", () => {
  assert.deepEqual(stakesFor("flip", 100_000_000n), { dealer: 100_000_000n, player: 100_000_000n });
  assert.deepEqual(stakesFor("dice-hilo", 100_000_000n), { dealer: 100_000_000n, player: 100_000_000n });
  assert.deepEqual(stakesFor("dice-exact", 100_000_000n), { dealer: 500_000_000n, player: 100_000_000n });
  assert.throws(() => stakesFor("flip", 100n), /dust/);
});

/* ---------------- commit / reveal ---------------- */

test("commitment round-trips; tampered secret fails verification", () => {
  const s = newSecret();
  assert.match(s, /^[0-9a-f]{64}$/);
  const c = commitmentFor(s);
  assert.equal(commitmentFor(s), c);
  assert.ok(verifyReveal(s, c));
  const tampered = s.slice(0, 62) + (s.slice(62) === "00" ? "ff" : "00");
  assert.ok(!verifyReveal(tampered, c));
  assert.ok(!verifyReveal(s, c.slice(0, 62) + "00"));
});

test("outcomeFor is deterministic and in range", () => {
  const s = newSecret();
  const o1 = outcomeFor({ secretHex: s, roundId: "ab12cd34", game: "flip" });
  assert.ok(o1 === "heads" || o1 === "tails");
  assert.equal(outcomeFor({ secretHex: s, roundId: "ab12cd34", game: "flip" }), o1);
  const d1 = outcomeFor({ secretHex: s, roundId: "ab12cd34", game: "dice-exact" });
  assert.ok(d1 >= 1 && d1 <= 6);
  // outcomes vary across secrets (not a constant function)
  const seen = new Set();
  for (let i = 0; i < 24; i++) seen.add(outcomeFor({ secretHex: newSecret(), roundId: "ab12cd34", game: "flip" }));
  assert.equal(seen.size, 2);
});

test("winnerFor covers every branch", () => {
  assert.equal(winnerFor({ game: "flip", bet: "heads", outcome: "heads" }), "player");
  assert.equal(winnerFor({ game: "flip", bet: "heads", outcome: "tails" }), "dealer");
  assert.equal(winnerFor({ game: "dice-exact", bet: "4", outcome: 4 }), "player");
  assert.equal(winnerFor({ game: "dice-exact", bet: "4", outcome: 5 }), "dealer");
  assert.equal(winnerFor({ game: "dice-hilo", bet: "low", outcome: 3 }), "player");
  assert.equal(winnerFor({ game: "dice-hilo", bet: "low", outcome: 4 }), "dealer");
  assert.equal(winnerFor({ game: "dice-hilo", bet: "high", outcome: 6 }), "player");
});

test("revealAndScore refuses a mismatched commitment", () => {
  const s = newSecret();
  assert.throws(
    () => revealAndScore({ secretHex: s, commitmentHex: "00".repeat(32), roundId: "ab12cd34", game: "flip", bet: "heads" }),
    /NOT PROVEN/,
  );
});

/* ---------------- descriptors ---------------- */

test("createGame descriptor round-trips byte-exact with stable fingerprint", () => {
  const g = mkGame("dice-exact", "4", "2", 50100);
  assert.ok(g.descriptor.startsWith("pearlgames:v1:prl:dice-exact:4:"));
  const back = gameFromDescriptor(g.descriptor, net);
  assert.equal(back.descriptor, g.descriptor);
  assert.equal(back.fingerprint, g.fingerprint);
  assert.equal(back.stakeDealerGrains, 1_000_000_000n); // 2 PRL * 5
  assert.equal(back.stakePlayerGrains, 200_000_000n);
  assert.equal(descriptorFingerprint(g.descriptor), g.fingerprint);
});

test("descriptor tampering is refused loudly", () => {
  const g = mkGame();
  const tamper = (i, ch) => {
    const parts = g.descriptor.split(":");
    parts[i] = ch;
    return parts.join(":");
  };
  assert.throws(() => gameFromDescriptor(tamper(3, "dice-exact"), net), /bad bet/); // game/bet mismatch
  assert.throws(() => gameFromDescriptor(g.descriptor.replace(":100000000:100000000:", ":100000000:99999999:"), net), /stakes/);
  assert.throws(() => gameFromDescriptor(g.descriptor + "x", net), /bad game descriptor|tampered|bad round id/);
  assert.throws(() => gameFromDescriptor(g.descriptor, NETWORKS.testnet), /descriptor is for prl/);
  assert.throws(() => createGame({
    network: net, game: "flip", bet: "heads", dealerXOnly: dealerX, playerXOnly: dealerX,
    playerStakePRL: "1", timeoutHeight: 50000,
  }), /must differ/);
});

/* ---------------- escrow addresses ---------------- */

test("escrow addresses are deterministic, distinct per depositor, and verify", () => {
  const g = mkGame();
  const { d, p } = escrows(g);
  assert.ok(d.address.startsWith("prl1p"));
  assert.ok(p.address.startsWith("prl1p"));
  assert.notEqual(d.address, p.address);
  assert.ok(verifyEscrowAddress(d));
  assert.ok(verifyEscrowAddress(p));
  const { d: d2 } = escrows(g);
  assert.equal(d.address, d2.address);
  // settle leaf is the 2-of-2; refund leaf binds the depositor
  assert.equal(d.settleScriptHex, p.settleScriptHex);
  assert.notEqual(d.refundScriptHex, p.refundScriptHex);
  assert.notEqual(d.internalKeyHex, p.internalKeyHex);
});

test("NUMS internal key binds every game parameter", () => {
  const g = mkGame();
  const k1 = bytesToHex(numsInternalKey({
    dealerXOnly: g.dealerXOnly, playerXOnly: g.playerXOnly, game: g.game, bet: g.bet,
    stakeDealerGrains: g.stakeDealerGrains, stakePlayerGrains: g.stakePlayerGrains,
    timeoutHeight: g.timeoutHeight, roundId: g.roundId, depositor: "dealer",
  }));
  const k2 = bytesToHex(numsInternalKey({
    dealerXOnly: g.dealerXOnly, playerXOnly: g.playerXOnly, game: g.game, bet: g.bet,
    stakeDealerGrains: g.stakeDealerGrains, stakePlayerGrains: g.stakePlayerGrains,
    timeoutHeight: g.timeoutHeight, roundId: g.roundId, depositor: "player",
  }));
  assert.notEqual(k1, k2);
});

/* ---------------- settle planning ---------------- */

test("planSettle: pot minus exact fee; uneconomic refused", () => {
  const plan = planSettle({
    stakeDealerGrains: 100_000_000n, stakePlayerGrains: 100_000_000n,
    settleScriptLen: 70, controlLen: 65, feeRateGrainsPerVByte: 10,
  });
  assert.equal(plan.pot, 200_000_000n);
  assert.equal(plan.fee, BigInt(Math.ceil(plan.vBytes * 10)));
  assert.equal(plan.payout, plan.pot - plan.fee);
  assert.ok(plan.payout > BigInt(DUST_GRAIN));
  assert.throws(() => planSettle({
    stakeDealerGrains: 600n, stakePlayerGrains: 600n,
    settleScriptLen: 70, controlLen: 65, feeRateGrainsPerVByte: 1000,
  }), /uneconomic/);
});

/* ---------------- settle bundle round-trip ---------------- */

function mkFundedBundle(game = "flip", bet = "heads", stakePRL = "1") {
  const g = mkGame(game, bet, stakePRL);
  const { d, p } = escrows(g);
  const secret = newSecret();
  const commitment = commitmentFor(secret);
  const scored = revealAndScore({ secretHex: secret, commitmentHex: commitment, roundId: g.roundId, game: g.game, bet: g.bet });
  const winnerKey = scored.winner === "dealer" ? dealer : player;
  const winnerAddress = encodeBech32m(net.hrp, 1, winnerKey.internalXOnly);
  const fundingDealer = { txid: "aa".repeat(32), vout: 0, value: Number(g.stakeDealerGrains), address: d.address };
  const fundingPlayer = { txid: "bb".repeat(32), vout: 1, value: Number(g.stakePlayerGrains), address: p.address };
  const bundle = buildSettleBundle({
    network: net, gameParams: g, commitmentHex: commitment, secretHex: secret,
    fundingDealer, fundingPlayer, winnerAddress, feeRateGrainsPerVByte: 10,
  });
  return { g, d, p, secret, commitment, bundle, winnerAddress, scored };
}

test("buildSettleBundle: scores the real winner, exact fee math, fingerprint", () => {
  const { g, bundle, scored } = mkFundedBundle("dice-exact", "4", "1");
  assert.equal(bundle.kind, SETTLE_BUNDLE_KIND);
  assert.equal(bundle.winner, scored.winner);
  assert.equal(bundle.inputs.length, 2);
  assert.equal(bundle.digests.length, 2);
  assert.ok(bundle.digests.every((x) => /^[0-9a-f]{64}$/.test(x)));
  assert.equal(bundle.outputs[0].value, Number(g.stakeDealerGrains + g.stakePlayerGrains) - bundle.feeGrains);
  assert.equal(bundle.fingerprint, settleBundleFingerprint(bundle));
  assert.match(bundle.fingerprint, /^[0-9a-f]{16}$/);
});

test("buildSettleBundle refuses wrong funding value or address", () => {
  const { g, d, p, secret, commitment, winnerAddress } = mkFundedBundle();
  const badVal = { txid: "aa".repeat(32), vout: 0, value: Number(g.stakeDealerGrains) - 1, address: d.address };
  const goodP = { txid: "bb".repeat(32), vout: 1, value: Number(g.stakePlayerGrains), address: p.address };
  assert.throws(() => buildSettleBundle({
    network: net, gameParams: g, commitmentHex: commitment, secretHex: secret,
    fundingDealer: badVal, fundingPlayer: goodP, winnerAddress, feeRateGrainsPerVByte: 10,
  }), /refusing/);
  const badAddr = { txid: "aa".repeat(32), vout: 0, value: Number(g.stakeDealerGrains), address: p.address };
  assert.throws(() => buildSettleBundle({
    network: net, gameParams: g, commitmentHex: commitment, secretHex: secret,
    fundingDealer: badAddr, fundingPlayer: goodP, winnerAddress, feeRateGrainsPerVByte: 10,
  }), /does not match the re-derived escrow address/);
});

test("parseSettleBundle round-trips; tampering refused", () => {
  const { g, bundle } = mkFundedBundle();
  const back = parseSettleBundle(JSON.stringify(bundle), net);
  assert.equal(back.fingerprint, bundle.fingerprint);
  assert.equal(back.winner, bundle.winner);
  const evil = { ...bundle, feeGrains: bundle.feeGrains + 1 };
  assert.throws(() => parseSettleBundle(JSON.stringify(evil), net), /fingerprint mismatch/);
  const evil2 = JSON.parse(JSON.stringify(bundle));
  evil2.outputs[0].value += 1;
  assert.throws(() => parseSettleBundle(JSON.stringify(evil2), net), /fingerprint mismatch/);
  assert.throws(() => parseSettleBundle("not json", net), /not valid JSON/);
});

test("signSettleBundle: both parties sign, sigs verify, status tracks", () => {
  const { g, bundle } = mkFundedBundle();
  signSettleBundle(bundle, g, bytesToHex(dealer.priv));
  let st = settleBundleStatus(bundle, g);
  assert.ok(st.dealerSigned && !st.playerSigned && !st.ready);
  assert.throws(() => signSettleBundle(bundle, g, bytesToHex(dealer.priv)), /already signed/);
  const stranger = "22".repeat(32);
  assert.throws(() => signSettleBundle(bundle, g, stranger), /neither the dealer nor the player/);
  signSettleBundle(bundle, g, bytesToHex(player.priv));
  st = settleBundleStatus(bundle, g);
  assert.ok(st.ready);
  // every signature verifies against its digest
  for (const ps of bundle.partialSigs) {
    ps.sigs.forEach((sig, i) => assert.ok(verifySchnorrSig(sig, bundle.digests[i], ps.key)));
  }
  // parsed bundle keeps the signatures valid
  const back = parseSettleBundle(JSON.stringify(bundle), net);
  assert.ok(settleBundleStatus(back, g).ready);
});

test("buildSettleSpend: serializes the 2-input tx, vBytes + digests cross-check", () => {
  const { g, bundle } = mkFundedBundle("dice-hilo", "high", "0.5");
  signSettleBundle(bundle, g, bytesToHex(dealer.priv));
  signSettleBundle(bundle, g, bytesToHex(player.priv));
  const spend = buildSettleSpend({ network: net, bundle, gameParams: g });
  assert.match(spend.txid, /^[0-9a-f]{64}$/);
  assert.ok(spend.hex.length > 200);
  assert.equal(spend.vBytes, bundle.vBytes);
});

test("settle refuses to finalize without both signatures", () => {
  const { g, bundle } = mkFundedBundle();
  signSettleBundle(bundle, g, bytesToHex(dealer.priv));
  assert.throws(() => buildSettleSpend({ network: net, bundle, gameParams: g }), /both signatures/);
});

/* ---------------- refund ---------------- */

test("buildRefundTx: pre-timeout refusal, wrong key/depositor refused", () => {
  const g = mkGame("flip", "heads", "1", 51000);
  const { d } = escrows(g);
  const funding = { txid: "cc".repeat(32), vout: 0, value: Number(g.stakeDealerGrains), address: d.address };
  const depAddr = encodeBech32m(net.hrp, 1, dealer.internalXOnly);
  assert.throws(() => buildRefundTx({
    network: net, gameParams: g, depositor: "dealer", funding,
    depositorAddress: depAddr, privHex: bytesToHex(dealer.priv),
    feeRateGrainsPerVByte: 10, tipHeight: 50999,
  }), /not mature/);
  assert.throws(() => buildRefundTx({
    network: net, gameParams: g, depositor: "dealer", funding,
    depositorAddress: depAddr, privHex: bytesToHex(player.priv),
    feeRateGrainsPerVByte: 10, tipHeight: 51000,
  }), /not the depositor's key/);
  const { p } = escrows(g);
  const wrongFunding = { ...funding, address: p.address };
  assert.throws(() => buildRefundTx({
    network: net, gameParams: g, depositor: "dealer", funding: wrongFunding,
    depositorAddress: depAddr, privHex: bytesToHex(dealer.priv),
    feeRateGrainsPerVByte: 10, tipHeight: 51001,
  }), /wrong-depositor guard/);
});

test("buildRefundTx: post-timeout builds a locktime=timeout tx paying the depositor", () => {
  const g = mkGame("flip", "tails", "1", 51000);
  const { d } = escrows(g);
  const funding = { txid: "cc".repeat(32), vout: 0, value: Number(g.stakeDealerGrains), address: d.address };
  const depAddr = encodeBech32m(net.hrp, 1, dealer.internalXOnly);
  const r = buildRefundTx({
    network: net, gameParams: g, depositor: "dealer", funding,
    depositorAddress: depAddr, privHex: bytesToHex(dealer.priv),
    feeRateGrainsPerVByte: 10, tipHeight: 51007,
  });
  assert.equal(r.locktime, 51000);
  assert.equal(r.depositor, "dealer");
  assert.match(r.txid, /^[0-9a-f]{64}$/);
  assert.equal(r.payment, Number(g.stakeDealerGrains) - r.fee);
  assert.ok(r.payment >= DUST_GRAIN);
});

/* ---------------- practice + verifier ---------------- */

test("practiceRound runs the full protocol locally with a verified commitment", () => {
  const r = practiceRound({ game: "dice-exact", bet: "3" });
  assert.ok(r.commitmentVerified);
  assert.ok(verifyReveal(r.secret, r.commitment));
  assert.ok(r.outcome >= 1 && r.outcome <= 6);
  assert.ok(["dealer", "player"].includes(r.winner));
  assert.match(r.note, /no PRL moved/);
});

test("verifyGameTranscript: PROVEN on honest transcript, NOT PROVEN on tamper", () => {
  const g = mkGame("flip", "heads", "1");
  const secret = newSecret();
  const commitment = commitmentFor(secret);
  const ok = verifyGameTranscript({ descriptor: g.descriptor, commitmentHex: commitment, secretHex: secret });
  assert.ok(ok.proven);
  assert.ok(["heads", "tails"].includes(ok.outcome));
  const bad = verifyGameTranscript({ descriptor: g.descriptor, commitmentHex: commitment, secretHex: "ff".repeat(32) });
  assert.ok(!bad.proven);
  assert.ok(bad.problems.some((p) => /commitment/.test(p)));
});

/* ---------------- misc ---------------- */

test("validateTimeout bounds", () => {
  // structural: any absolute height below the 500M locktime threshold is fine
  assert.equal(validateTimeout(125105), 125105);
  assert.equal(validateTimeout(1), 1);
  assert.throws(() => validateTimeout(0), /positive/);
  assert.throws(() => validateTimeout(500000000), /positive/);
  // with the tip known: must be in the future, 144..52560 blocks ahead
  assert.throws(() => validateTimeout(120105, 120105), /not in the future/);
  assert.throws(() => validateTimeout(120000, 120105), /not in the future/);
  assert.throws(() => validateTimeout(120105 + 143, 120105), /at least 144/);
  assert.throws(() => validateTimeout(120105 + 52561, 120105), /~4 months/);
  assert.equal(validateTimeout(120105 + 144, 120105), 120105 + 144);
  assert.equal(validateTimeout(120105 + 52560, 120105), 120105 + 52560);
});

test("prlToGrains / grainsToPRL exact", () => {
  assert.equal(prlToGrains("1.5"), 150_000_000n);
  assert.equal(grainsToPRL(150_000_000n), "1.5");
  assert.throws(() => prlToGrains("1.123456789"), /bad PRL/);
});

test("gameKeyFromInput accepts x-only, mnemonic, WIF", () => {
  const a = gameKeyFromInput(dealerX, net);
  assert.equal(a.xonly, dealerX);
  assert.equal(a.priv, null);
  const b = gameKeyFromInput(DEALER_MN, net);
  assert.equal(b.xonly, dealerX);
  assert.ok(b.priv instanceof Uint8Array);
  assert.throws(() => gameKeyFromInput("nope", net), /must be/);
});

// ------------------------------------------------- XSS hardening (app.js)
// Regression pins for the 2026-10-04 fleet XSS audit latent queue:
// the stakes-preview catch was the fleet's last unescaped e.message ->
// innerHTML (the core error echoes the user's own stake input).
test("stakes preview escapes the prlToGrains error message", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(app, /function esc\(s\)/);
  assert.ok(app.includes("${esc(e.message)}"), "preview error escaped");
  assert.ok(!app.includes("${e.message}"), "no raw e.message interpolation remains");
  assert.ok(html.includes('app.js?v=3'), "cache key bumped");
});

// Regression pin: the refund funding vout was read with bare parseInt, so
// "1.9"/"1e2" silently became vout 1 — a refund signed over the wrong
// outpoint. The field is now parsed with the fleet's strict digits gate.
test("refund UI parses the funding vout strictly (parseInt truncation class)", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(!app.includes("parseInt(els.in_refund_vout"), "no parseInt on the refund vout field");
  assert.ok(app.includes("funding vout must be a non-negative integer"), "strict vout gate present");
});
