// Pearl Channels DOM tests: runs the real pearl-channels.bundle.js + app.js in a
// minimal vm DOM (adapted from the vault harness), with a stubbed Blockbook.
// Drives Open -> Fund -> State (propose/sign/exchange/assemble/activate/revoke)
// -> Close (cooperative + unilateral claim) -> Verify.
// Usage: node --no-warnings tests/dom.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { TextEncoder, TextDecoder } from "node:util";
import { webcrypto } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolvePath(here, "..");
const html = fs.readFileSync(resolvePath(dir, "index.html"), "utf8");

/* ---------- minimal DOM (from the vault harness, extended) ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
const registry = [];
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this._className = "";
    this.dataset = {};
    this.value = ""; this._text = ""; this._html = "";
    this.hidden = false; this.disabled = false; this.checked = false;
    this.style = {}; this._handlers = {}; this._kids = [];
    this._attrs = {};
    this.type = ""; this.placeholder = ""; this.spellcheck = false;
    registry.push(this);
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { this._attrs[k] ?? null; return this._attrs[k] ?? null; }
  set className(v) { this._className = String(v); String(v).split(/\s+/).forEach((c) => c && this.classList.add(c)); }
  get className() { return this._className; }
  set innerHTML(v) {
    this._html = String(v); this._kids = [];
    this._text = String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  appendChild(k) { this._kids.push(k); return k; }
  remove() { for (const e of registry) e._kids = e._kids.filter((x) => x !== this); }
  get children() { return this._kids; }
  querySelector(sel) {
    // support the #steps [data-step="x"] lookups used by enableSteps()
    const m = sel.match(/\[data-step="([^"]+)"\]/);
    if (m) return registry.find((e) => e.dataset.step === m[1]) || null;
    return null;
  }
  querySelectorAll() { return []; }
  scrollIntoView() {}
  select() {}
}
const byId = new Map();
const stepButtons = [];
for (const m of html.matchAll(/<button[^>]*\bdata-step="([^"]+)"[^>]*>/g)) {
  const el = new El("button");
  el.dataset.step = m[1];
  el.disabled = /disabled/.test(m[0]);
  if (/\bactive\b/.test(m[0])) el.classList.add("active");
  el.addEventListener("click", () => {
    // mirror the real nav wiring: activate the matching panel
    for (const b of stepButtons) b.classList.toggle("active", b === el);
    for (const p of registry) {
      if (p.id && p.id.startsWith("step-")) p.classList.toggle("active", p.id === "step-" + m[1]);
    }
  });
  stepButtons.push(el);
}
const attrMap = new Map();
for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
  if (attrMap.has(m[1])) continue;
  const tag = m[0];
  const vv = tag.match(/\bvalue="([^"]*)"/);
  const cc = tag.match(/\bclass="([^"]*)"/);
  attrMap.set(m[1], {
    value: vv ? vv[1] : "",
    cls: cc ? cc[1] : "",
    checked: /\bchecked\b/.test(tag),
    hidden: /\bhidden\b/.test(tag),
  });
}
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    const a = attrMap.get(id);
    if (a) {
      if (a.value) el.value = a.value;
      if (a.cls) el.className = a.cls;
      if (a.checked) el.checked = true;
      if (a.hidden) el.hidden = true;
    }
    byId.set(id, el);
  }
  return byId.get(id);
};
const store = new Map();
const documentShim = {
  getElementById: getEl,
  querySelectorAll: (sel) => {
    if (sel === "#steps button") return stepButtons;
    return [];
  },
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
  readyState: "complete",
  execCommand: () => false,
};

/* ---------- stubbed Blockbook ---------- */
const QA = { txDetail: null, down: false };
const okBody = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const fail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "error" });
async function stubFetch(url) {
  const u = String(url);
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  if (QA.down) throw new Error("ECONNREFUSED");
  if (path.startsWith("/api/v2/tx/")) {
    const id = path.split("/api/v2/tx/")[1].split("?")[0];
    if (QA.txDetail && QA.txDetail.txid === id) return okBody(QA.txDetail);
    return fail(404);
  }
  if (path === "/api/v2/api") return okBody({ blockbook: { bestHeight: 901234 } });
  return fail(404);
}

const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  },
  URL: { createObjectURL: () => "blob:stub", revokeObjectURL() {} },
  TextDecoder, crypto: webcrypto, fetch: stubFetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
  confirm: () => true,
  addEventListener() {},
  scrollTo() {},
  console,
  Date,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
{
  const OuterTE = TextEncoder;
  const VMUint8Array = vm.runInContext("Uint8Array", sandbox);
  sandbox.TextEncoder = class extends OuterTE {
    encode(s) { return new VMUint8Array(super.encode(s)); }
  };
}
for (const f of ["pearl-channels.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 30000 });
}

const R = sandbox.PearlChannels;
assert.ok(R, "bundle exposes window.PearlChannels");
const T = sandbox.__channelsTest;
assert.ok(T, "test hook exposed");
const get = (id) => documentShim.getElementById(id);

// fixture keys: fixed privkeys -> x-only pubkeys through the real bundle
const PRIV_A = "11".repeat(32);
const PRIV_B = "22".repeat(32);
const XONLY_A = R.bytesToHex(R.schnorr.getPublicKey(R.hexToBytes(PRIV_A)));
const XONLY_B = R.bytesToHex(R.schnorr.getPublicKey(R.hexToBytes(PRIV_B)));
const XONLY_C = R.bytesToHex(R.schnorr.getPublicKey(R.hexToBytes("33".repeat(32))));
const XONLY_D = R.bytesToHex(R.schnorr.getPublicKey(R.hexToBytes("44".repeat(32))));
const PAYOUT_ME = R.encodeBech32m("prl", 1, R.hexToBytes(XONLY_C));
const PAYOUT_PEER = R.encodeBech32m("prl", 1, R.hexToBytes(XONLY_D));
const FUNDING_TXID = "ff".repeat(32);

test("boot: attribution, honest limits, step 1 visible", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("https://x.com/kshot9000"), "x link in footer");
  assert.ok(html.includes("@kshot9000"), "@kshot9000 attribution");
  assert.ok(html.includes("Honest limits"), "honest-limits panel present");
  assert.ok(html.includes("not a watchtower"), "watchtower disclaimer present");
  assert.ok(get("step-open").classList.contains("active"), "step 1 panel active");
  assert.ok(get("open-error").hidden, "no error at boot");
});

test("open: junk peer key refused loudly", () => {
  T.set("open-mykey", XONLY_A);
  T.set("open-peerkey", "junk");
  T.set("open-mypayout", PAYOUT_ME);
  T.set("open-peerpayout", PAYOUT_PEER);
  T.click("open-build");
  const e = T.err("open-error");
  assert.ok(!e.hidden, "error shown");
  assert.ok(T.state().chan === null, "no channel created");
});

test("open: channel opens, descriptor + address render", () => {
  T.set("open-mykey", XONLY_A);
  T.set("open-peerkey", XONLY_B);
  T.set("open-mypayout", PAYOUT_ME);
  T.set("open-peerpayout", PAYOUT_PEER);
  T.set("open-mycap", "10");
  T.set("open-peercap", "5");
  T.set("open-csv", "144");
  T.click("open-build");
  const e = T.err("open-error");
  assert.ok(e.hidden, "no error: " + e.text);
  const st = T.state();
  assert.ok(st.chan, "channel in state");
  assert.equal(st.chan.aXOnly, XONLY_A);
  assert.equal(st.chan.bXOnly, XONLY_B);
  assert.ok(st.chan.address.startsWith("prl1"), "prl1 channel address");
  assert.equal(T.text("open-address"), st.chan.address);
  assert.ok(!get("open-result").hidden, "result shown");
  assert.match(T.text("open-fp"), /^[0-9a-f]{16}$/);
  // descriptor persisted to localStorage
  assert.ok(store.get("pearl-channels.descriptor").includes("pearl-channel-descriptor:v1"));
  // fund step enabled
  const fundBtn = stepButtons.find((b) => b.dataset.step === "fund");
  assert.equal(fundBtn.disabled, false, "fund step enabled");
});

test("fund: manual funding txid activates state 0", () => {
  T.set("fund-manualtxid", FUNDING_TXID);
  T.set("fund-manualvout", "0");
  T.click("fund-manualgo");
  const e = T.err("fund-error");
  assert.ok(e.hidden, "no error: " + e.text);
  const st = T.state();
  assert.equal(st.fundingTxid, FUNDING_TXID);
  assert.equal(st.states.length, 1);
  assert.ok(st.states[0].active, "state 0 active");
  assert.equal(st.states[0].myBal, (10n * 100000000n).toString());
  assert.ok(!get("state-current").hidden, "state card shown");
  assert.ok(T.text("state-minelabel").includes("10"), "mine label: " + T.text("state-minelabel"));
});

test("fund: malformed manual vout is refused, never silently coerced to another outpoint", () => {
  // parseInt truncated "1.9"/"1e2" to 1 and || 0 mapped "abc"/"" to 0 — a
  // mistyped vout silently pointed the channel at the wrong funding output.
  for (const bad of ["1.9", "1e2", "1xyz", "abc", "-5", ""]) {
    T.set("fund-manualtxid", FUNDING_TXID);
    T.set("fund-manualvout", bad);
    T.click("fund-manualgo");
    const e = T.err("fund-error");
    assert.ok(!e.hidden, "error shown for " + JSON.stringify(bad));
    assert.match(e.text, /funding vout/, e.text);
    assert.equal(T.state().fundingVout, 0, "funding vout unchanged for " + JSON.stringify(bad));
    assert.equal(T.state().states.length, 1, "state not rebuilt for " + JSON.stringify(bad));
  }
});

test("state: propose 1 PRL payment builds the pair", () => {
  T.set("pay-direction", "out");
  T.set("pay-amount", "1");
  T.set("pay-feerate", "2");
  T.click("pay-propose");
  const e = T.err("pay-error");
  assert.ok(e.hidden, "no error: " + e.text);
  const p = T.state().proposal;
  assert.ok(p, "proposal in state");
  assert.equal(p.version, 1);
  assert.equal(p.myBal, (9n * 100000000n).toString());
  assert.equal(p.peerBal, (6n * 100000000n).toString());
  assert.ok(p.pair.mine.digest && p.pair.theirs.digest, "both digests built");
  assert.ok(!get("pay-result").hidden, "proposal shown");
});

test("state: signing with the wrong key is refused", () => {
  T.set("pay-key", PRIV_B); // peer's key, not ours
  T.click("pay-sign");
  const e = T.err("pay-error");
  assert.ok(!e.hidden, "error shown");
  assert.match(e.text, /does not match/);
  assert.equal(T.state().key, null, "key wiped");
});

test("state: sign my copies, assemble needs peer sigs", () => {
  T.set("pay-key", PRIV_A);
  T.click("pay-sign");
  let e = T.err("pay-error");
  assert.ok(e.hidden, "no error: " + e.text);
  const p = T.state().proposal;
  assert.ok(p.mySigs.mine && p.mySigs.theirs, "both sigs recorded");
  assert.match(p.mySigs.mine, /^[0-9a-f]{128}$/);
  T.click("pay-assemble");
  e = T.err("pay-error");
  assert.ok(!e.hidden, "assemble refused without peer sigs");
  assert.match(e.text, /peer signatures are required/);
});

test("state: peer sigs assemble both commitments", () => {
  const st = T.state();
  const p = st.proposal;
  // peer signs both digests with their real key (mirrored flow)
  const sigMine = R.signChannelDigest(PRIV_B, p.pair.mine.digest);
  const sigTheirs = R.signChannelDigest(PRIV_B, p.pair.theirs.digest);
  T.set("pay-peersig-mine", sigMine);
  T.set("pay-peersig-theirs", sigTheirs);
  T.click("pay-assemble");
  const e = T.err("pay-error");
  assert.ok(e.hidden, "no error: " + e.text);
  assert.ok(p.signed.mine && p.signed.theirs, "both commitments assembled");
  assert.ok(!get("pay-assembled").hidden, "assembled box shown");
  assert.equal(T.text("pay-txid-mine").length, 64);
});

test("state: activate revokes state 0 and reveals the secret", () => {
  T.click("pay-activate");
  const e = T.err("pay-error");
  assert.ok(e.hidden, "no error: " + e.text);
  const st = T.state();
  assert.equal(st.states.length, 2);
  assert.ok(st.states[0].revoked, "state 0 revoked");
  assert.ok(st.states[1].active, "state 1 active");
  assert.equal(st.states[1].version, 1);
  assert.ok(!get("state-revokebox").hidden, "revocation box shown");
  assert.match(T.text("revoke-mine"), /^[0-9a-f]{64}$/, "old secret revealed");
  // record the peer's revealed secret (from the simulated placeholder)
  T.set("revoke-theirs", st.states[0].peerSecretSimulated);
  T.click("revoke-record");
  const e2 = T.err("pay-error");
  assert.ok(e2.hidden, "no error: " + e2.text);
  assert.equal(st.states[0].peerSecret, st.states[0].peerSecretSimulated, "peer secret recorded");
  assert.ok(T.text("revoke-status").includes("verified"), "verification confirmed: " + T.text("revoke-status"));
});

test("close: cooperative close builds, signs, assembles", () => {
  T.click("close-coop-build");
  let e = T.err("close-coop-error");
  assert.ok(e.hidden, "no error: " + e.text);
  const st = T.state();
  assert.ok(st.coop, "coop template built");
  assert.ok(!get("close-coop-result").hidden, "coop result shown");
  T.set("close-coop-key", PRIV_A);
  T.click("close-coop-sign");
  e = T.err("close-coop-error");
  assert.ok(e.hidden, "sign ok: " + e.text);
  const peerSig = R.signChannelDigest(PRIV_B, st.coop.digest);
  T.set("close-coop-peersig", peerSig);
  T.click("close-coop-assemble");
  e = T.err("close-coop-error");
  assert.ok(e.hidden, "assemble ok: " + e.text);
  assert.ok(st.coop.hex, "coop hex assembled");
  assert.ok(!get("close-coop-hex").hidden, "hex shown");
  // outputs pay both payout addresses — verify via the standalone verifier
  const vr = R.verifyChannelTx("mainnet", st.chan, st.coop.hex, FUNDING_TXID, 0, {
    version: 1, myBal: st.states[1].myBal, peerBal: st.states[1].peerBal, myPayoutAddr: PAYOUT_ME,
  }, PAYOUT_ME, 2);
  assert.ok(vr.ok, "coop close PROVEN: " + vr.failures.join("; "));
  assert.equal(vr.kind, "cooperative close");
});

test("close: unilateral claim builds and signs", () => {
  T.click("close-uni-build");
  let e = T.err("close-uni-error");
  assert.ok(e.hidden, "no error: " + e.text);
  const st = T.state();
  assert.ok(st.claim, "claim template built");
  assert.equal(st.claim.commitmentTxid, st.states[1].txidMine);
  T.set("close-uni-key", PRIV_A);
  T.click("close-uni-sign");
  e = T.err("close-uni-error");
  assert.ok(e.hidden, "sign ok: " + e.text);
  assert.ok(st.claim.hex, "claim hex assembled");
  assert.ok(!get("close-uni-hex").hidden, "claim hex shown");
});

test("verify: descriptor-only check passes", () => {
  T.set("verify-descriptor", JSON.stringify(T.state().chan));
  T.click("verify-desc");
  const e = T.err("verify-error");
  assert.ok(e.hidden, "no error: " + e.text);
  assert.ok(!get("verify-result").hidden, "result shown");
  assert.equal(T.text("verify-verdict"), "DESCRIPTOR VALID");
});

test("verify: tampered descriptor is refused", () => {
  const tampered = JSON.parse(JSON.stringify(T.state().chan));
  tampered.csvDelay = 999;
  T.set("verify-descriptor", JSON.stringify(tampered));
  T.click("verify-desc");
  assert.equal(T.text("verify-verdict"), "DESCRIPTOR REFUSED");
});

test("verify: full commitment tx PROVEN", () => {
  const st = T.state();
  T.set("verify-descriptor", JSON.stringify(st.chan));
  T.set("verify-fundingtxid", FUNDING_TXID);
  T.set("verify-fundingvout", "0");
  T.set("verify-version", "1");
  T.set("verify-mine", st.states[1].myBal);
  T.set("verify-peer", st.states[1].peerBal);
  T.set("verify-mypayout", PAYOUT_ME);
  T.set("verify-feerate", "2");
  T.set("verify-myhash", st.states[1].myRevokeHash160);
  T.set("verify-peerhash", st.states[1].peerRevokeHash160);
  T.set("verify-hex", st.states[1].signed.mine);
  T.click("verify-go");
  const e = T.err("verify-error");
  assert.ok(e.hidden, "no error: " + e.text);
  assert.equal(T.text("verify-verdict"), "PROVEN");
  assert.ok(T.text("verify-kind").includes("commitment"), "kind shown: " + T.text("verify-kind"));
});

test("nav: all steps reachable, no dead controls", () => {
  for (const name of ["open", "fund", "state", "close", "track", "verify"]) {
    const btn = stepButtons.find((b) => b.dataset.step === name);
    assert.ok(btn, name + " button exists");
    assert.equal(btn.disabled, false, name + " enabled");
  }
});
