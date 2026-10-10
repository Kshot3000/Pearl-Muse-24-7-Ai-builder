// Pearl Swap DOM integration test — boots the real index.html + scripts
// (pearl-swap.bundle.js, app.js) against a minimal DOM shim and drives the
// full flow: propose -> lock (manual UTXO) -> track spec load -> claim (Bob)
// -> refund (maturity guard), plus the tamper/mismatch refusals.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs
// (no jsdom on this VM; the shim implements exactly the surface app.js uses)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomFillSync } from "node:crypto";
import { TextEncoder, TextDecoder } from "node:util";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolvePath(here, "..");
const html = fs.readFileSync(resolvePath(dir, "index.html"), "utf8");

/* ---------- minimal DOM ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassList();    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this._innerHTML = "";
    this._handlers = {};
    this._props = {};
  }
  get className() { return [...this.classList.s].join(" "); }
  set className(v) {
    this.classList.s.clear();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this.children = [];
    // keep textContent in sync like a real DOM (tests read .textContent after renders)
    this.textContent = String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    // small parse: create stubs for common tags so app.js can query them
    const re = /<(input|button|select|textarea|label|div|p|code|span|h4|h3)\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(this._innerHTML))) {
      const [, tag, attrs] = m;
      const el = new El(tag);
      const idm = /\bid="([^"]*)"/.exec(attrs);
      if (idm) { el.id = idm[1]; dynById.set(idm[1], el); }
      const clsm = /\bclass="([^"]*)"/.exec(attrs);
      if (clsm) clsm[1].split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      const type = /\btype="([^"]*)"/.exec(attrs);
      el.type = type ? type[1] : "text";
      el.checked = /\bchecked\b/.test(attrs);
      const namem = /\bname="([^"]*)"/.exec(attrs);
      if (namem) el.name = namem[1];
      el.parent = this;
      this.children.push(el);
    }
  }
  get innerHTML() { return this._innerHTML; }
  addEventListener(ev, fn) { (this._handlers[ev] ??= []).push(fn); }
  dispatchEvent(e) { (this._handlers[e.type] || []).forEach((f) => f.call(this, e)); return true; }
  click() { this.dispatchEvent({ type: "click" }); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  getContext() { return null; } // canvas: QR path is try/caught in app.js
}
function matches(el, sel) {
  sel = sel.trim();
  if (sel.startsWith("#")) {
    const rest = sel.slice(1);
    const m = /^([\w-]+)(?:\s+(\w+)(?:\[([\w-]+)="([^"]+)"\])?)?$/.exec(rest);
    if (!m) return false;
    if (el.id !== m[1] && !(el._scopeId === m[1])) return false;
    if (m[2] && el.tagName !== m[2].toUpperCase()) return false;
    if (m[3] && String(el.dataset[m[3].replace(/^data-/, "")] ?? el[m[3]]) !== m[4]) return false;
    return true;
  }
  if (sel.startsWith(".")) return el.classList.contains(sel.slice(1));
  return el.tagName === sel.toUpperCase();
}

const byId = new Map();
const dynById = new Map(); // elements created later via innerHTML
const all = [];
const stubCache = new Map(); // one stable stub per underlying HTML tag occurrence
function stubFor(tag, attrs) {
  const key = tag + "|" + attrs;
  let el = stubCache.get(key);
  if (!el) {
    el = new El(tag);
    let dm;
    const dre = /data-([\w-]+)="([^"]*)"/g;
    while ((dm = dre.exec(attrs))) el.dataset[dm[1]] = dm[2];
    const clsm = /\bclass="([^"]*)"/.exec(attrs);
    if (clsm) el.className = clsm[1];
    stubCache.set(key, el);
    all.push(el);
  }
  return el;
}
// pre-create every id="..." element from the real HTML, with tag + data-* attrs
{
  const re = /<(\w+)([^>]*)\bid="([^"]+)"([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, before, id, after] = m;
    const el = new El(tag, id);
    const attrs = before + " " + after;
    let dm;
    const dre = /data-([\w-]+)="([^"]*)"/g;
    while ((dm = dre.exec(attrs))) el.dataset[dm[1]] = dm[2];
    if (/\bchecked\b/.test(attrs)) el.checked = true;
    // inputs with a hardcoded value="..." in the HTML boot with it
    const vm_ = /\bvalue="([^"]*)"/.exec(attrs);
    if (vm_ && (el.tagName === "INPUT" || el.tagName === "SELECT")) el.value = vm_[1];
    byId.set(id, el);
    all.push(el);
  }
  // steps nav buttons live inside #steps; give them scope ids
  const stepsEl = byId.get("steps");
  const btnRe = /<button\b([^>]*)data-step="([^"]+)"([^>]*)>/g;
  let bm;
  while ((bm = btnRe.exec(html))) {
    const b = new El("button");
    b.dataset.step = bm[2];
    b._scopeId = "steps";
    const cls = /class="([^"]*)"/.exec(bm[1] + bm[3]);
    if (cls) cls[1].split(/\s+/).forEach((c) => b.classList.add(c));
    stepsEl.appendChild(b);
    all.push(b);
  }
}

const document = {
  getElementById: (id) => {
    const el = byId.get(id) || dynById.get(id);
    if (!el) throw new Error("missing element id=" + id);
    return el;
  },
  querySelectorAll: (sel) => {
    sel = sel.trim();
    // ".class" or '.class[attr="v"]' — built from data-* markers in the HTML
    const cm = /^\.([\w-]+)(?:\[([\w-]+)="([^"]+)"\])?$/.exec(sel);
    if (cm) {
      const [, cls, attr, val] = cm;
      const out = [];
      const re = new RegExp(`<(button|div|span|a)\\b([^>]*)>`, "g");
      let m;
      while ((m = re.exec(html))) {
        const attrs = m[2];
        if (!new RegExp(`class="[^"]*\\b${cls}\\b`).test(attrs)) continue;
        if (attr) {
          const am = new RegExp(`${attr}="([^"]*)"`).exec(attrs);
          if (!am || am[1] !== val) continue;
        }
        out.push(stubFor(m[1], attrs));
      }
      return out;
    }
    // "#steps button" / '#steps button[data-step="x"]'
    const m = /^#([\w-]+)\s+button(?:\[data-step="([^"]+)"\])?$/.exec(sel);
    if (m) {
      const scope = byId.get(m[1]);
      return scope.children.filter(
        (c) => c.tagName === "BUTTON" && (!m[2] || c.dataset.step === m[2]),
      );
    }
    if (sel.startsWith("#")) {
      const el = byId.get(sel.slice(1));
      return el ? [el] : [];
    }
    return [];
  },
  querySelector: (sel) => document.querySelectorAll(sel)[0] || null,
  createElement: (tag) => new El(tag),
  body: new El("body"),
};
const window = {
  document,
  scrollTo: () => {},
  qrcode: () => { throw new Error("no QR in shim"); }, // exercises the try/catch path
};
class FakeEvent { constructor(type) { this.type = type; } }

const sandbox = {
  window, document, Event: FakeEvent,
  navigator: {}, console, TextEncoder, TextDecoder,
  crypto: { getRandomValues: (buf) => randomFillSync(buf) }, // generatePreimage
  setTimeout: (fn) => 0, clearTimeout: () => {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// esbuild iife attaches to the vm global; run bundle first, mirror it onto
// window (like a browser would), then load the QR lib and app.js
for (const f of ["pearl-swap.bundle.js", "qrcode.min.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f });
}
window.PearlSwap = sandbox.PearlSwap;
if (sandbox.qrcode) window.qrcode = sandbox.qrcode;
vm.runInContext(fs.readFileSync(resolvePath(dir, "app.js"), "utf8"), sandbox, { filename: "app.js" });

const $ = (id) => document.getElementById(id);
const MNEMONICS = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
];
const MAINNET = sandbox.window.PearlSwap.NETWORKS.mainnet;
const BOB_ADDR = () => sandbox.window.PearlSwap.funderKeyFromInput(MNEMONICS[1], MAINNET).address;
const ALICE_ADDR = () => sandbox.window.PearlSwap.funderKeyFromInput(MNEMONICS[0], MAINNET).address;
// browser default: the first <option> is selected
$("network").value = "mainnet";
$("p-role").value = "alice";

test("page boots: bundle + app wiring load without throwing", () => {
  assert.ok(sandbox.window.PearlSwap, "bundle global present");
  assert.ok($("propose-btn"), "propose controls present");
  assert.ok($("lock-build-btn"), "lock controls present");
  assert.ok($("claim-build-btn"), "claim controls present");
  assert.ok($("refund-build-btn"), "refund controls present");
});

test("every getElementById target in app.js exists in index.html", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  const ids = new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(","));
});

test("honest limits + attribution are on the page", () => {
  assert.ok(/honest limits/i.test(html), "limits panel");
  assert.ok(html.includes("@kshot9000"), "x handle");
  assert.ok($("donate-addr"), "donation address element exists");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"),
    "exact donation address in footer");
});

test("propose as Alice: renders prl1p swap address, descriptor, scripts", () => {
  $("p-role").value = "alice";
  $("p-prl").value = "10";
  $("p-btc").value = "0.5";
  $("p-t1").value = "120800";
  $("p-t2").value = "120000";
  $("p-alice-key").value = MNEMONICS[0];
  $("p-bob-key").value = MNEMONICS[1];
  $("p-pre-gen").click();
  assert.equal($("p-pre").value.length, 64, "preimage generated");
  assert.equal($("p-hash").value.length, 64, "hash derived");
  assert.equal($("p-pre-warn").hidden, false, "preimage safety warning visible");
  $("propose-btn").click();
  assert.equal($("propose-error").hidden, true, "no propose error: " + $("propose-error").textContent);
  const addr = $("sw-address").textContent;
  assert.ok(/^prl1p/.test(addr), "swap address is prl1p: " + addr);
  assert.ok(/^swap:v1:/.test($("sw-descriptor").textContent), "compact descriptor present: " + $("sw-descriptor").textContent.slice(0, 30));
  assert.ok($("sw-json").value.includes("\"role\""), "shareable JSON present");
  assert.ok($("sw-asm-claim").textContent.includes("SHA256"), "claim script shown");
  assert.ok($("sw-asm-refund").textContent.includes("CHECKLOCKTIMEVERIFY"), "refund script shown");
  assert.ok($("sw-qr").textContent.includes("QR too large") || $("sw-qr").textContent === "", "QR fallback path ok");
  assert.equal($("propose-out").hidden, false);
});

test("propose guard: T1 <= T2 is refused", () => {
  $("p-t1").value = "119900";
  $("p-t2").value = "120000";
  $("propose-btn").click();
  assert.equal($("propose-error").hidden, false, "timelock guard fired");
  assert.ok(/greater than/i.test($("propose-error").textContent), $("propose-error").textContent);
  $("p-t1").value = "120800"; // restore for later steps
});

test("lock: manual UTXO + local build produces a signed tx", () => {
  $("lock-load-btn").click();
  assert.equal($("lock-error").hidden, true, "spec loads: " + $("lock-error").textContent);
  assert.equal($("lock-work").hidden, false);
  $("lock-key").value = MNEMONICS[2];
  $("lock-derive-btn").click();
  assert.ok(/^prl1/.test($("lock-address").textContent), "funder address derived");
  assert.equal($("lock-key").value, "", "secret cleared from the field");
  // manual UTXO instead of network: 20 PRL to fund a 10 PRL lock
  $("lock-m-txid").value = "cc".repeat(32);
  $("lock-m-vout").value = "0";
  $("lock-m-value").value = "20";
  $("lock-add-utxo").click();
  $("lock-build-btn").click();
  assert.equal($("lock-error").hidden, true, "no lock error: " + $("lock-error").textContent);
  assert.ok(/^[0-9a-f]{64}$/.test($("lock-txid").textContent), "lock txid: " + $("lock-txid").textContent);
  assert.ok($("lock-hex").value.length > 400, "lock hex length");
  assert.equal($("lock-out").hidden, false);
  assert.ok($("lock-tx-summary").textContent.includes("re-verified locally"), "sig re-verification shown");
  // carry-over to claim/refund steps
  assert.equal($("claim-utxo-txid").value, $("lock-txid").textContent);
  assert.equal($("refund-utxo-vout").value, "0");
});

test("mirror template: bc1p address + byte-identical claim leaf with tips", () => {
  $("mirror-btc-network").value = "mainnet";
  $("mirror-btc-tip").value = "920000";
  $("mirror-pearl-tip").value = "120000";
  $("mirror-gen-btn").click();
  assert.ok(/^bc1p/.test($("mirror-address").textContent), "BTC mirror address: " + $("mirror-address").textContent);
  assert.ok($("mirror-claim-hex").textContent.includes("OP_SHA256"), "claim leaf shown");
  assert.ok($("mirror-note").textContent.includes("does not build or sign Bitcoin transactions"), "honest scope note");
});

test("track: spec loads and the lifecycle summary renders", () => {
  $("track-load-btn").click();
  assert.equal($("track-error").hidden, true, "track spec loads: " + $("track-error").textContent);
  assert.equal($("track-work").hidden, false);
  assert.ok($("track-state").textContent.includes("T1"), "timelocks shown");
});

test("claim: Bob builds the script-path claim with the revealed preimage", () => {
  $("claim-load-btn").click();
  assert.equal($("claim-error").hidden, true, "claim spec loads: " + $("claim-error").textContent);
  assert.equal($("claim-pre").value.length, 64, "preimage carried from propose step");
  $("claim-key").value = MNEMONICS[1];
  $("claim-dest").value = BOB_ADDR();
  $("claim-build-btn").click();
  assert.equal($("claim-error").hidden, true, "no claim error: " + $("claim-error").textContent);
  assert.ok(/^[0-9a-f]{64}$/.test($("claim-txid").textContent), "claim txid");
  assert.ok($("claim-hex").value.length > 400, "claim hex length");
  assert.equal($("claim-key").value, "", "secret cleared from the field");
  // carry the real claim hex to the preimage-extraction panel
  $("alice-claim-hex").value = $("claim-hex").value;
  $("alice-extract-btn").click();
  assert.equal($("alice-error").hidden, true, "no extract error: " + $("alice-error").textContent);
  assert.equal($("alice-pre").textContent, $("claim-pre").value, "extracted preimage matches the proposal preimage");
  assert.ok($("alice-btc-steps").textContent.includes("Bitcoin"), "alice btc follow-up steps");
});

test("claim guard: wrong preimage is refused", () => {
  $("claim-pre").value = "00".repeat(32);
  $("claim-key").value = MNEMONICS[1];
  $("claim-dest").value = BOB_ADDR();
  $("claim-build-btn").click();
  assert.equal($("claim-error").hidden, false, "wrong-preimage guard fired");
  assert.ok(/does not hash/i.test($("claim-error").textContent), $("claim-error").textContent);
});

test("refund: maturity guard refuses early refunds, allows at T1", () => {
  $("refund-load-btn").click();
  assert.equal($("refund-error").hidden, true, "refund spec loads: " + $("refund-error").textContent);
  $("refund-key").value = MNEMONICS[0];
  $("refund-dest").value = ALICE_ADDR();
  $("refund-height").value = "120799"; // one block before T1=120800
  $("refund-build-btn").click();
  assert.equal($("refund-error").hidden, false, "early refund refused");
  assert.ok(/mature/i.test($("refund-error").textContent), $("refund-error").textContent);
  $("refund-height").value = "120800"; // at T1
  $("refund-key").value = MNEMONICS[0];
  $("refund-build-btn").click();
  assert.equal($("refund-error").hidden, true, "no refund error at maturity: " + $("refund-error").textContent);
  assert.ok(/^[0-9a-f]{64}$/.test($("refund-txid").textContent), "refund txid");
  assert.ok($("refund-hex").value.length > 400, "refund hex length");
});

test("refund guard: Bob's key cannot refund", () => {
  $("refund-height").value = "120800";
  $("refund-key").value = MNEMONICS[1];
  $("refund-build-btn").click();
  assert.equal($("refund-error").hidden, false, "bob-key refund refused");
  assert.ok(/alice/i.test($("refund-error").textContent), $("refund-error").textContent);
});

test("lock/claim/refund refuse malformed vouts (parseInt truncation class)", () => {
  // parseInt("1.9")/"1e2" silently became vout 1 in all three builders
  $("lock-m-txid").value = "dd".repeat(32);
  $("lock-m-vout").value = "1.9";
  $("lock-m-value").value = "20";
  $("lock-add-utxo").click();
  assert.equal($("lock-error").hidden, false, "malformed lock vout must error");
  assert.match($("lock-error").textContent, /bad vout/, $("lock-error").textContent);
  $("claim-key").value = MNEMONICS[1];
  $("claim-utxo-vout").value = "1e2";
  $("claim-build-btn").click();
  assert.equal($("claim-error").hidden, false, "malformed claim vout must error");
  assert.match($("claim-error").textContent, /bad utxo vout/, $("claim-error").textContent);
  $("refund-key").value = MNEMONICS[0];
  $("refund-utxo-vout").value = "abc";
  $("refund-build-btn").click();
  assert.equal($("refund-error").hidden, false, "malformed refund vout must error");
  assert.match($("refund-error").textContent, /bad utxo vout/, $("refund-error").textContent);
});

test("amount inputs use the exact core parsers (float-parse class closed)", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  assert.ok(src.includes("E.parsePRLToGrains(str)"), "parsePRL delegates to the core exact parser");
  assert.ok(src.includes("E.parseBTCToSats(str)"), "parseBTC delegates to the core exact parser");
  assert.ok(!src.includes("Math.round(v * E.GRAIN_PER_PRL)"), "no float PRL parse left");
  assert.ok(!src.includes("Math.round(v * 1e8)"), "no float BTC parse left");
  assert.ok(html.includes("pearl-swap.bundle.js?v=3"), "bundle cache key bumped");
  assert.ok(html.includes('src="app.js?v=4"'), "app cache key bumped");
});

test("app.js grain formatter is BigInt-exact (pool float-format class)", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "app.js"), "utf8");
  assert.ok(src.includes("100000000n"), "BigInt-exact grain formatter present");
  assert.ok(src.includes("/^-?\\d+$/"), "integer-grain gate present");
});
