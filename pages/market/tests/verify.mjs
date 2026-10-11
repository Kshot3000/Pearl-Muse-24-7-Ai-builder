// Pearl Bazaar verification suite.
// Usage: node --no-warnings --loader tests/loader.mjs tests/verify.mjs
// (run from the market directory)
//
// Covers: 0x83 sighash layout + sign/verify round-trips, verifyListing tamper
// tests, fill-tx construction + buyer-sig verification, the matching engine,
// listing codec round-trips, buildTransferJson against the REAL prl20-core
// parser, the indexer client (mocked fetch), and the local board.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const goalDir = resolvePath(here, "..", "..", "..", "..");
const IDX = resolvePath(goalDir, "hidden_files/ecosystem-checkouts/pearlscriptions-indexer");

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  encodeBech32m, decodeBech32m, bytesToHex, hexToBytes,
  sha256, taggedHash, varint, u32le, u64le, txidLE,
  schnorr, tweakKeypath, tweakPrivKeypath, p2trScriptPubKey,
  keypathSigDigestEx,
  newMnemonic, walletFromMnemonic,
  buildTransferJson, validatePrl20Json,
  SIGHASH_DEFAULT, SIGHASH_SINGLE_ANYONECANPAY,
  makeListing, signListing, verifyListing, listingTemplateParts,
  fillTxVBytes, selectFillCoins, buildFillTx,
  encodeListing, decodeListing,
  selectCoinsSimple, planTransferLot,
  idxGetTokens, idxGetTransferLots, idxGetUtxos,
  fetchUtxos,
  loadBoard, saveBoard, boardAddListing, boardCancelListing, boardAddBid, boardCancelBid, boardAddTrade,
  loadSettings, saveSettings,
  mulberry32, demoTokens, demoBook, tapeMovers,
  fmtPRL, parsePRL, fmtTokens, parseOutpoint, outpointStr,
  Matching,
} from "../src/index.js";

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; /* console.log(`ok   ${name}`); */ }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
const skip = (name) => { skipped++; console.log(`skip ${name}`); };
const throws = (name, fn) => {
  try { fn(); ok(name, false, "did not throw"); }
  catch { ok(name, true); }
};

const NW = NETWORKS.mainnet;
const seller = walletFromMnemonic(newMnemonic(), NW);
const buyer = walletFromMnemonic(newMnemonic(), NW);
const sellerProg = tweakKeypath(seller.internalXOnly).tweakedX;
const sellerSpkHex = bytesToHex(p2trScriptPubKey(sellerProg));

function mkListing(over = {}) {
  return makeListing({
    tick: "prls", amt: "100000",
    lotTxid: "ab".repeat(32), lotVout: 0, lotValue: 546, lotSpkHex: sellerSpkHex,
    priceGrains: "250000000", seller: seller.address,
    expiry: Date.now() + 86400000,
    ...over,
  });
}
function signedListing(over = {}) {
  return signListing(mkListing(over), seller, NW);
}

/* ============ 1. 0x83 sighash layout (consensus cross-check) ============ */
// Independently rebuild the expected message per Pearl node/txscript
// calcTaprootSignatureHashRaw for SINGLE|ANYONECANPAY and compare digests.
{
  const lotTxid = "cd".repeat(32);
  const spk = p2trScriptPubKey(sellerProg);
  const priceProg = sellerProg;
  const price = 250000000;
  const msg = [
    0x00, 0x83, ...u32le(NW.txVersion), ...u32le(0), // epoch, hash_type, version, locktime
    0x00, // spend_type: keypath, no annex
    ...txidLE(lotTxid), ...u32le(0), // outpoint
    ...u64le(546), ...varint(spk.length), ...spk, // prev txout (amount+spk)
    ...u32le(0xffffffff), // sequence
    ...sha256(Uint8Array.from([...u64le(price), ...varint(p2trScriptPubKey(priceProg).length), ...p2trScriptPubKey(priceProg)])), // sha_single_output
  ];
  const expected = taggedHash("TapSighash", Uint8Array.from(msg));
  const got = keypathSigDigestEx(NW,
    [{ txid: lotTxid, vout: 0, value: 546, spk }],
    [{ program: priceProg, value: price }],
    0xffffffff, 0, 0x83);
  ok("sighash-0x83-matches-consensus-layout", bytesToHex(got) === bytesToHex(expected));
  ok("sighash-0x83-differs-from-default",
    bytesToHex(got) !== bytesToHex(keypathSigDigestEx(NW,
      [{ txid: lotTxid, vout: 0, value: 546, spk }],
      [{ program: priceProg, value: price }], 0xffffffff, 0, 0x00)));
  throws("sighash-rejects-bad-hashtype", () =>
    keypathSigDigestEx(NW, [{ txid: lotTxid, vout: 0, value: 546, spk }],
      [{ program: priceProg, value: price }], 0xffffffff, 0, 0x01));
}

/* ============ 2. sign -> verify round trip ============ */
{
  const l = signedListing();
  ok("sign-produces-64B-sig", /^[0-9a-f]{128}$/.test(l.sig));
  ok("verifyListing-valid", verifyListing(l, NW).ok === true);
  // tamper with every sighash-committed field -> must fail.
  // NOTE: tick/amt are lot *metadata* — they are not committed by the 0x83
  // digest (which covers the lot outpoint/value/spk and output[0] only).
  // Mislabeling them is caught by schema validation + the indexer's
  // transfer-lots view of the actual lot, not by the signature.
  for (const [name, mut] of [
    ["price", (x) => ({ ...x, priceGrains: "250000001" })],
    ["lotTxid", (x) => ({ ...x, lotTxid: "ff".repeat(32) })],
    ["lotVout", (x) => ({ ...x, lotVout: 1 })],
    ["lotValue", (x) => ({ ...x, lotValue: 547 })],
    ["seller", (x) => ({ ...x, seller: buyer.address, lotSpkHex: bytesToHex(p2trScriptPubKey(tweakKeypath(buyer.internalXOnly).tweakedX)) })],
    ["sig-bit", (x) => ({ ...x, sig: (x.sig[0] === "0" ? "1" : "0") + x.sig.slice(1) })],
  ]) {
    const r = verifyListing(mut(l), NW);
    ok(`verifyListing-tamper-${name}-fails`, r.ok === false, JSON.stringify(r));
  }
  // tick/amt are metadata: schema still enforces their shape, and the real
  // lot contents are authoritative on the indexer — the signature is over the
  // on-chain terms (outpoint + price), which is exactly what Unisat-style
  // 0x83 listings commit to.
  ok("verifyListing-tick-shape-still-validated",
    verifyListing({ ...l, tick: "PEARL" }, NW).ok === true); // normalized case ok
  ok("verifyListing-bad-tick-shape-fails",
    verifyListing({ ...l, tick: "BAD TICK!" }, NW).ok === false);
  // wrong network hrp fails
  ok("verifyListing-wrong-network-fails",
    verifyListing(l, NETWORKS.testnet).ok === false);
  // expired fails (schema), unsigned fails
  ok("verifyListing-expired-fails",
    verifyListing({ ...l, expiry: Date.now() - 1000 }, NW).ok === false);
  ok("verifyListing-unsigned-fails",
    verifyListing(mkListing(), NW).ok === false);
  // lot spk must belong to the seller
  const badSpk = { ...l, lotSpkHex: bytesToHex(p2trScriptPubKey(tweakKeypath(buyer.internalXOnly).tweakedX)) };
  ok("verifyListing-lot-spk-mismatch-fails", verifyListing(badSpk, NW).ok === false);
  // template parts sanity
  const tp = listingTemplateParts(l, NW);
  ok("template-output0-is-price-to-seller",
    tp.outputs.length === 1 && tp.outputs[0].value === 250000000 &&
    bytesToHex(tp.outputs[0].program) === bytesToHex(sellerProg));
  throws("signListing-rejects-expired", () =>
    signListing(mkListing({ expiry: Date.now() - 1 }), seller, NW));
  throws("signListing-rejects-zero-price", () =>
    signListing(mkListing({ priceGrains: "0" }), seller, NW));
}

/* ============ 3. fill transaction ============ */
{
  const l = signedListing();
  const buyerUtxos = [
    { txid: "11".repeat(32), vout: 0, value: 400_000_000, priv: buyer.priv, internalXOnly: buyer.internalXOnly },
  ];
  const fill = buildFillTx({ network: NW, listing: l, buyerUtxos, buyerAddress: buyer.address, feeRate: 5 });
  ok("fill-builds", !!fill.txid && /^[0-9a-f]{64}$/.test(fill.txid));
  ok("fill-fee-positive", fill.feeGrains > 0);
  ok("fill-change-nonnegative", fill.changeGrains >= 0);
  // fee math: inputs == outputs + fee
  const totalIn = 546 + 400_000_000;
  const totalOut = 250_000_000 + 546 + fill.changeGrains;
  ok("fill-conservation", totalIn - totalOut === fill.feeGrains, `${totalIn - totalOut} vs ${fill.feeGrains}`);
  ok("fill-vbytes-sane", fillTxVBytes(1, fill.nOut) >= 100 && fillTxVBytes(1, fill.nOut) < 1000);

  // verify buyer signatures against recomputed SIGHASH_DEFAULT digests
  const buyerProg = tweakKeypath(buyer.internalXOnly).tweakedX;
  const lotSpk = hexToBytes(sellerSpkHex);
  const dInputs = [
    { txid: l.lotTxid, vout: 0, value: 546, spk: lotSpk },
    { txid: "11".repeat(32), vout: 0, value: 400_000_000, spk: p2trScriptPubKey(buyerProg) },
  ];
  const dOutputs = [
    { program: sellerProg, value: 250_000_000 },
    { program: buyerProg, value: 546 },
    ...(fill.changeGrains > 0 ? [{ program: buyerProg, value: fill.changeGrains }] : []),
  ];
  // parse witness of buyer input from the serialized tx: find the 64B sig.
  // Simpler: recompute digest and check schnorr.verify against a signature
  // recovered by re-signing would be circular; instead verify the tx parses
  // and the lot witness is 65 bytes ending in 0x83.
  ok("fill-hex-has-65B-seller-witness", fill.hex.includes(l.sig + "83"));
  const d1 = keypathSigDigestEx(NW, dInputs, dOutputs, 0xffffffff, 1, SIGHASH_DEFAULT);
  // extract buyer sig from tx hex: witness section; do a structural check instead:
  // re-derive expected witness layout lengths
  ok("fill-hex-even-length", fill.hex.length % 2 === 0 && fill.hex.length > 200);

  // direct buyer-sig check: build the expected sig independently and confirm
  // the tx contains it (proves the tx's buyer witness is a valid sig for the digest)
  const expectedBuyerSig = bytesToHex(schnorr.sign(d1, tweakPrivKeypath(buyer.priv, buyer.internalXOnly), new Uint8Array(32)));
  ok("fill-buyer-witness-valid", fill.hex.includes(expectedBuyerSig));
  ok("fill-buyer-sig-verifies", schnorr.verify(hexToBytes(expectedBuyerSig), d1, buyerProg));

  // multi-input buyer
  const multi = buildFillTx({
    network: NW, listing: l, buyerAddress: buyer.address, feeRate: 5,
    buyerUtxos: [
      { txid: "22".repeat(32), vout: 0, value: 100_000_000, priv: buyer.priv, internalXOnly: buyer.internalXOnly },
      { txid: "33".repeat(32), vout: 1, value: 200_000_000, priv: buyer.priv, internalXOnly: buyer.internalXOnly },
    ],
  });
  ok("fill-multi-input", multi.nIn === 3 && multi.changeGrains >= 0);

  // failures
  throws("fill-rejects-tampered-listing", () => buildFillTx({
    network: NW, listing: { ...l, priceGrains: "1" }, buyerUtxos, buyerAddress: buyer.address, feeRate: 5,
  }));
  throws("fill-rejects-self-fill", () => buildFillTx({
    network: NW, listing: l, buyerUtxos, buyerAddress: seller.address, feeRate: 5,
  }));
  throws("fill-rejects-insufficient-funds", () => buildFillTx({
    network: NW, listing: l, buyerAddress: buyer.address, feeRate: 5,
    buyerUtxos: [{ txid: "44".repeat(32), vout: 0, value: 1000, priv: buyer.priv, internalXOnly: buyer.internalXOnly }],
  }));
  throws("fill-rejects-missing-buyer-key", () => buildFillTx({
    network: NW, listing: l, buyerAddress: buyer.address, feeRate: 5,
    buyerUtxos: [{ txid: "55".repeat(32), vout: 0, value: 400_000_000 }],
  }));
  // dust change folds into fee
  const dustCh = selectFillCoins({
    buyerUtxos: [{ txid: "66".repeat(32), vout: 0, value: 250_000_000 + Math.ceil(fillTxVBytes(1, 3) * 5) + 100 }],
    priceGrains: 250_000_000, feeRate: 5,
  });
  ok("fill-dust-change-folds-to-fee", dustCh.nOut === 2 && dustCh.changeGrains === 0);
}

/* ============ 4. matching engine ============ */
{
  const { OrderBook, Market, resetSeqForTests } = Matching;
  resetSeqForTests();
  const NOW = 1_700_000_000_000;
  const A = "prl1aaaa", B = "prl1bbbb", C = "prl1cccc";

  // basic cross: bid maxPrice >= ask price -> trade at ask price
  {
    const b = new OrderBook("prls", { now: () => NOW });
    b.addAsk({ tick: "prls", amt: "100", priceGrains: "1000", seller: A, expiry: NOW + 1000 });
    b.addBid({ tick: "prls", amount: "100", maxPrice: "1200", buyerAddress: B });
    const { trades } = b.match(NOW);
    ok("match-basic-cross", trades.length === 1 && trades[0].amount === "100" && trades[0].priceGrains === "1000");
    ok("match-book-empty-after", b.asks.size === 0 && b.bids.size === 0);
  }
  // partial fill both sides: big ask, small bid
  {
    const b = new OrderBook("prls", { now: () => NOW });
    const ask = b.addAsk({ tick: "prls", amt: "1000", priceGrains: "10000", seller: A, expiry: NOW + 1000 });
    b.addBid({ tick: "prls", amount: "400", maxPrice: "5000", buyerAddress: B });
    const { trades } = b.match(NOW);
    ok("match-partial-ask-rests", trades.length === 1 && trades[0].amount === "400" &&
      trades[0].priceGrains === "4000" && ask.remaining === 600n && b.bids.size === 0);
  }
  // partial fill: big bid, small ask -> bid rests, sweeps next level
  {
    const b = new OrderBook("prls", { now: () => NOW });
    b.addAsk({ tick: "prls", amt: "100", priceGrains: "1000", seller: A, expiry: NOW + 1000 });
    b.addAsk({ tick: "prls", amt: "100", priceGrains: "1100", seller: C, expiry: NOW + 1000 });
    b.addBid({ tick: "prls", amount: "150", maxPrice: "2000", buyerAddress: B });
    const { trades } = b.match(NOW);
    ok("match-multi-level-sweep", trades.length === 2 &&
      trades[0].priceGrains === "1000" && trades[0].amount === "100" &&
      trades[1].priceGrains === "550" && trades[1].amount === "50"); // 50 @ 11/token
    const rest = b.bidsSorted();
    ok("match-bid-exhausted", rest.length === 0);
    const asks = b.asksSorted(NOW);
    ok("match-second-ask-partial", asks.length === 1 && asks[0].remaining === 50n);
  }
  // time priority on price ties
  {
    resetSeqForTests();
    const b = new OrderBook("prls", { now: () => NOW });
    b.addBid({ tick: "prls", amount: "10", maxPrice: "100", buyerAddress: B, created: NOW - 2000 });
    b.addBid({ tick: "prls", amount: "10", maxPrice: "100", buyerAddress: C, created: NOW - 1000 });
    b.addAsk({ tick: "prls", amt: "10", priceGrains: "100", seller: A, expiry: NOW + 1000 });
    const { trades } = b.match(NOW);
    ok("match-time-priority", trades.length === 1 && trades[0].buyer === B);
  }
  // self-trade prevention: own ask skipped, other ask still matches
  {
    const b = new OrderBook("prls", { now: () => NOW });
    b.addAsk({ tick: "prls", amt: "50", priceGrains: "500", seller: B, expiry: NOW + 1000 }); // own
    b.addAsk({ tick: "prls", amt: "50", priceGrains: "600", seller: A, expiry: NOW + 1000 });
    b.addBid({ tick: "prls", amount: "50", maxPrice: "1000", buyerAddress: B });
    const { trades } = b.match(NOW);
    ok("match-self-trade-blocked", trades.length === 1 && trades[0].seller === A && trades[0].buyer === B);
  }
  // self-only book: no match at all
  {
    const b = new OrderBook("prls", { now: () => NOW });
    b.addAsk({ tick: "prls", amt: "50", priceGrains: "500", seller: B, expiry: NOW + 1000 });
    b.addBid({ tick: "prls", amount: "50", maxPrice: "1000", buyerAddress: B });
    ok("match-self-only-no-trade", b.match(NOW).trades.length === 0);
  }
  // no cross -> no match
  {
    const b = new OrderBook("prls", { now: () => NOW });
    b.addAsk({ tick: "prls", amt: "50", priceGrains: "2000", seller: A, expiry: NOW + 1000 });
    b.addBid({ tick: "prls", amount: "50", maxPrice: "1000", buyerAddress: B });
    ok("match-no-cross", b.match(NOW).trades.length === 0);
  }
  // exact-equality cross (maxPrice*amt == price*amount)
  {
    const b = new OrderBook("prls", { now: () => NOW });
    b.addAsk({ tick: "prls", amt: "3", priceGrains: "100", seller: A, expiry: NOW + 1000 });
    b.addBid({ tick: "prls", amount: "6", maxPrice: "200", buyerAddress: B });
    ok("match-exact-equality", b.match(NOW).trades.length === 1);
  }
  // empty book
  {
    const b = new OrderBook("prls", { now: () => NOW });
    ok("match-empty-book", b.match(NOW).trades.length === 0);
  }
  // expiry filtering + purge
  {
    const b = new OrderBook("prls", { now: () => NOW });
    b.addAsk({ tick: "prls", amt: "50", priceGrains: "500", seller: A, expiry: NOW + 1000 });
    ok("match-expired-excluded", b.match(NOW + 2000).trades.length === 0);
    const gone = b.purgeExpired(NOW + 2000);
    ok("match-purge-expired", gone.length === 1 && b.asks.size === 0);
  }
  // BigInt precision: huge amounts cross exactly
  {
    const b = new OrderBook("prls", { now: () => NOW });
    const big = "123456789012345678901234567890";
    b.addAsk({ tick: "prls", amt: big, priceGrains: big, seller: A, expiry: NOW + 1000 });
    b.addBid({ tick: "prls", amount: big, maxPrice: big, buyerAddress: B });
    const { trades } = b.match(NOW);
    ok("match-bigint-precision", trades.length === 1 && trades[0].amount === big);
  }
  // validation
  {
    const b = new OrderBook("prls", { now: () => NOW });
    throws("match-reject-zero-amt", () => b.addAsk({ tick: "prls", amt: "0", priceGrains: "1", seller: A, expiry: NOW + 1 }));
    throws("match-reject-zero-price", () => b.addAsk({ tick: "prls", amt: "1", priceGrains: "0", seller: A, expiry: NOW + 1 }));
    throws("match-reject-expired-ask", () => b.addAsk({ tick: "prls", amt: "1", priceGrains: "1", seller: A, expiry: NOW - 1 }));
    throws("match-reject-zero-bid", () => b.addBid({ tick: "prls", amount: "0", maxPrice: "1", buyerAddress: B }));
    throws("match-reject-tick-mismatch", () => b.addAsk({ tick: "pearl", amt: "1", priceGrains: "1", seller: A, expiry: NOW + 1 }));
    ok("match-cancel-ask", (() => { const a = b.addAsk({ tick: "prls", amt: "1", priceGrains: "1", seller: A, expiry: NOW + 1 }); return b.cancelAsk(a.id) && b.asks.size === 0; })());
  }
  // Market: unknown tickers rejected
  {
    const m = new Market({ knownTickers: ["prls"], now: () => NOW });
    throws("market-unknown-ticker-ask", () => m.addAsk({ tick: "nope", amt: "1", priceGrains: "1", seller: A, expiry: NOW + 1 }));
    throws("market-unknown-ticker-bid", () => m.addBid({ tick: "nope", amount: "1", maxPrice: "1", buyerAddress: B }));
    m.addKnownTicker("pearl");
    ok("market-known-ticker-ok", !!m.book("pearl"));
    m.addAsk({ tick: "prls", amt: "10", priceGrains: "100", seller: A, expiry: NOW + 1000 });
    m.addBid({ tick: "prls", amount: "10", maxPrice: "100", buyerAddress: B });
    const r = m.matchAll(NOW);
    ok("market-matchall", r.prls && r.prls.trades.length === 1);
  }
  // depth ladder
  {
    const b = new OrderBook("prls", { now: () => NOW });
    b.addAsk({ tick: "prls", amt: "10", priceGrains: "100", seller: A, expiry: NOW + 1000 });
    b.addAsk({ tick: "prls", amt: "20", priceGrains: "200", seller: A, expiry: NOW + 1000 });
    const d = b.depth(10, NOW);
    ok("match-depth", d.asks.length === 1 && d.asks[0].amount === "30" && d.asks[0].orders === 2);
  }
}

/* ============ 5. codec round-trips ============ */
{
  const l = signedListing();
  const enc = encodeListing(l);
  const dec = decodeListing(enc);
  ok("codec-roundtrip", encodeListing(dec) === enc && dec.sig === l.sig && verifyListing(dec, NW).ok);
  throws("codec-rejects-unknown-field", () => decodeListing(JSON.stringify({ ...JSON.parse(enc), zz: 1 })));
  throws("codec-rejects-missing-field", () => { const o = JSON.parse(enc); delete o.sig; decodeListing(JSON.stringify(o)); });
  throws("codec-rejects-bad-json", () => decodeListing("{nope"));
  throws("codec-rejects-non-object", () => decodeListing("[1,2]"));
}

/* ============ 6. transfer JSON vs real prl20-core ============ */
{
  let parsePrl20Operation = null;
  try {
    const coreJs = resolvePath(IDX, "packages/prl20-core/src/index.js");
    if (existsSync(coreJs)) parsePrl20Operation = (await import("file://" + coreJs)).parsePrl20Operation;
  } catch { /* optional */ }
  if (!parsePrl20Operation) { skip("prl20-core checkout missing"); }
  else {
    const raw = buildTransferJson({ tick: "PRLS", amt: "100000" });
    const op = parsePrl20Operation(raw);
    ok("prl20-core-accepts-transfer", op.op === "transfer" && op.tick === "prls" && op.amt === "100000");
    throws("prl20-core-rejects-bad-transfer", () => parsePrl20Operation('{"p":"prl-20","op":"transfer","tick":"prls","amt":"01"}'));
    const v = validatePrl20Json(raw, "transfer");
    ok("validatePrl20Json-transfer", v.ok && v.tick === "prls");
    throws("validatePrl20Json-rejects-unknown-op", () => validatePrl20Json(raw, "burn"));
  }
}

/* ============ 7. indexer client (mocked fetch) ============ */
{
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(url);
    const body = url.endsWith("/tokens") ? { tokens: [{ ticker: "prls" }], total: 1 }
      : url.includes("/transfer-lots") ? { transferLots: [{ id: "l1", ticker: "prls", amount: "100", currentOutpoint: `${"ab".repeat(32)}:0` }], tokens: {}, total: 1 }
      : url.includes("/utxos") ? { utxos: [{ outpoint: `${"ab".repeat(32)}:0`, valueGrain: "546", protected: true }] }
      : {};
    return { ok: true, json: async () => body };
  };
  const t = await idxGetTokens("https://idx.example", mockFetch);
  ok("idx-tokens", t.total === 1 && t.tokens[0].ticker === "prls");
  const lots = await idxGetTransferLots("https://idx.example/", "prl1xyz", mockFetch);
  ok("idx-transfer-lots", lots.total === 1 && lots.transferLots[0].amount === "100");
  const utxos = await idxGetUtxos("https://idx.example", "prl1xyz", mockFetch);
  ok("idx-utxos", utxos.length === 1 && utxos[0].protected === true);
  await idxGetTokens("", mockFetch).then(() => ok("idx-empty-base-throws", false), () => ok("idx-empty-base-throws", true));
  const badFetch = async () => ({ ok: false, status: 500 });
  await idxGetTokens("https://idx.example", badFetch).then(() => ok("idx-http-error", false), () => ok("idx-http-error", true));
}

/* ============ 7b. blockbook fetchUtxos exactness (stubbed fetch) ============ */
{
  const realFetch = globalThis.fetch;
  const stubUtxos = (list) => {
    globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify(list) });
  };
  try {
    stubUtxos([{ txid: "ab".repeat(32), vout: 1, value: "250000000", confirmations: 2 }]);
    const good = await fetchUtxos("https://bb.example", "prl1xyz");
    ok("fetch-utxos-exact", good.length === 1 && good[0].value === 250000000 && good[0].vout === 1);
    // Past MAX_SAFE_INTEGER a bare Number() rounds (…993 -> …992, …995 -> …996):
    // the fetch must refuse loudly instead of returning a rounded funding UTXO.
    for (const raw of ["9007199254740993", "9007199254740995"]) {
      stubUtxos([{ txid: "ab".repeat(32), vout: 0, value: raw, confirmations: 1 }]);
      await fetchUtxos("https://bb.example", "prl1xyz").then(
        () => ok("fetch-utxos-refuses-unsafe-" + raw, false, "did not throw"),
        (e) => ok("fetch-utxos-refuses-unsafe-" + raw, /too large to handle exactly/.test(e.message)),
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ============ 8. board / settings / demo ============ */
{
  saveBoard({ v: 1, listings: [], bids: [], trades: [], seq: 1 });
  const l = signedListing();
  const id = boardAddListing(l);
  let b = loadBoard();
  ok("board-add-listing", b.listings.length === 1 && b.listings[0].boardId === id);
  ok("board-cancel-listing", boardCancelListing(id) && loadBoard().listings.length === 0);
  const bid = { tick: "prls", amount: "10", maxPrice: "100", buyerAddress: buyer.address };
  const bidId = boardAddBid(bid);
  ok("board-add-bid", loadBoard().bids.length === 1);
  ok("board-cancel-bid", boardCancelBid(bidId) && loadBoard().bids.length === 0);
  boardAddTrade({ tick: "prls", amount: "10", priceGrains: "100", buyer: "x", seller: "y" });
  ok("board-add-trade", loadBoard().trades.length === 1);

  saveSettings({ indexerBase: "https://idx.example", demo: false, address: "prl1x", networkId: "mainnet" });
  const s = loadSettings();
  ok("settings-roundtrip", s.indexerBase === "https://idx.example" && s.demo === false);

  const r1 = mulberry32(42)(), r2 = mulberry32(42)();
  ok("demo-deterministic", r1 === r2);
  const toks = demoTokens();
  ok("demo-tokens", toks.length >= 3 && toks[0].ticker === "prls");
  const book1 = demoBook("prls", NETWORKS.mainnet, 1337, 1_700_000_000_000);
  const book2 = demoBook("prls", NETWORKS.mainnet, 1337, 1_700_000_000_000);
  ok("demo-book-deterministic", JSON.stringify(book1) === JSON.stringify(book2));
  ok("demo-book-shaped", book1.listings.length === 9 && book1.trades.length > 40);
  ok("demo-listings-flagged", book1.listings.every((x) => x.demo === true));
  const movers = tapeMovers(book1.trades, ["prls"], 1_700_000_000_000);
  ok("tape-movers", movers.length === 1 && typeof movers[0].changePct === "number" && movers[0].trades > 2);
}

/* ============ 9. helpers ============ */
{
  ok("fmtPRL", fmtPRL(150000000n) === "1.5" && fmtPRL(1n) === "0.00000001" && fmtPRL(100000000n) === "1");
  ok("parsePRL", parsePRL("1.5") === 150000000n && parsePRL("0.00000001") === 1n);
  throws("parsePRL-bad", () => parsePRL("abc"));
  ok("fmtTokens", fmtTokens("1500000000000000000", 18) === "1.5");
  ok("outpoint-roundtrip", (() => { const p = parseOutpoint(`${"ab".repeat(32)}:3`); return p.vout === 3 && outpointStr(p.txid, p.vout) === `${"ab".repeat(32)}:3`; })());
  throws("parseOutpoint-bad", () => parseOutpoint("nope"));
  const coins = selectCoinsSimple(
    [{ txid: "aa".repeat(32), vout: 0, value: 100000 }, { txid: "bb".repeat(32), vout: 0, value: 50000 }],
    120000, 5, 1);
  ok("selectCoinsSimple", coins.totalIn === 150000 && coins.changeGrains >= 0);
  throws("selectCoinsSimple-insufficient", () => selectCoinsSimple([{ txid: "aa".repeat(32), vout: 0, value: 10 }], 120000, 5, 1));
}

/* ============ 10. transfer-lot plan (commit/reveal) ============ */
{
  const w = walletFromMnemonic(newMnemonic(), NW);
  const utxos = [{ txid: "99".repeat(32), vout: 0, value: 50_000_000 }];
  const plan = planTransferLot({ network: NW, wallet: w, utxos, tick: "prls", amt: "100000", feeRate: 5 });
  ok("plan-transfer-json", plan.json === '{"p":"prl-20","op":"transfer","tick":"prls","amt":"100000"}');
  ok("plan-lot-outpoint", plan.lot.txid === plan.revealTx.txid && plan.lot.vout === 0 && plan.lot.value === DUST_GRAIN);
  ok("plan-fees", plan.commitFeeGrains > 0 && plan.revealFeeGrains > 0);
  // the reveal owner output must pay to the wallet (the lot is theirs)
  ok("plan-reveal-pays-owner", plan.revealTx.hex.includes(bytesToHex(p2trScriptPubKey(tweakKeypath(w.internalXOnly).tweakedX)).slice(2)));
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
