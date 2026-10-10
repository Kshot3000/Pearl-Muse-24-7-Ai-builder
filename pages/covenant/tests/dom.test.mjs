// Pearl Covenant DOM integration test — boots the real index.html + committed
// bundle (pearl-covenant.bundle.js) + app.js against a minimal DOM shim and
// drives the full flow: forge -> vault (manual UTXO) -> build round ->
// verify -> sign (local + cosigner) -> finalize, plus footer-attribution
// checks. localStorage is hostile (throws) to exercise the memory fallback.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs
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

/* ---------- minimal DOM ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
const TAG_RE = "(input|button|select|textarea|label|div|p|code|span|h3|h4|tr|td|th|tbody|thead|table|dt|dd|option|a)";
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this.dataset = {};
    this.children = []; this.parent = null;
    this.style = {};
    this.value = ""; this.textContent = ""; this.checked = false;
    this.hidden = false; this.disabled = false;
    this._innerHTML = ""; this._handlers = {};
  }
  get className() { return [...this.classList.s].join(" "); }
  set className(v) {
    this.classList.s.clear();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this.textContent = String(v).replace(/<[^>]*>/g, "");
    this.children = [];
    const re = new RegExp("<" + TAG_RE + "\\b([^>]*)>", "gi");
    let m;
    while ((m = re.exec(this._innerHTML))) {
      const [, tag, attrs] = m;
      const el = new El(tag);
      const idm = /\bid="([^"]*)"/.exec(attrs);
      if (idm) { el.id = idm[1]; dynById.set(idm[1], el); }
      const clsm = /\bclass="([^"]*)"/.exec(attrs);
      if (clsm) clsm[1].split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      const typem = /\btype="([^"]*)"/.exec(attrs);
      el.type = typem ? typem[1] : "text";
      el.checked = /\bchecked\b/.test(attrs);
      let dm; const dre = /data-([\w-]+)="([^"]*)"/g;
      while ((dm = dre.exec(attrs))) el.dataset[dm[1]] = dm[2];
      el.parent = this;
      this.children.push(el);
      all.push(el);
    }
  }
  get innerHTML() { return this._innerHTML; }
  addEventListener(ev, fn) { (this._handlers[ev] ??= []).push(fn); }
  dispatchEvent(e) { (this._handlers[e.type] || []).forEach((f) => f.call(this, e)); return true; }
  click() { this.dispatchEvent({ type: "click", target: this, preventDefault() {} }); }
  appendChild(c) {
    c.parent = this; this.children.push(c);
    // mirror browser <select>: a selected <option> sets the select's value
    if (c.tagName === "OPTION" && c.selected && this.tagName === "SELECT" && !this.value) {
      this.value = c.value;
    }
    return c;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) { if (matches(c, sel)) out.push(c); walk(c); }
    };
    walk(this);
    return out;
  }
}
function matches(el, sel) {
  sel = sel.trim();
  if (sel.startsWith("#")) {
    const m = /^#([\w-]+)(?:\s+(\w+)(?:\[data-([\w-]+)="([^"]+)"\])?)?$/.exec(sel.slice(1));
    if (!m) return false;
    if (el.id !== m[1] && el._scopeId !== m[1]) return false;
    if (m[2] && el.tagName !== m[2].toUpperCase()) return false;
    if (m[3] && String(el.dataset[m[3]] ?? "") !== m[4]) return false;
    return true;
  }
  if (sel.startsWith(".")) {
    const m = /^\.([\w-]+)(?:\[data-([\w-]+)="([^"]+)"\])?$/.exec(sel);
    if (!m) return false;
    if (!el.classList.contains(m[1])) return false;
    if (m[2] && String(el.dataset[m[2]] ?? "") !== m[3]) return false;
    return true;
  }
  return el.tagName === sel.toUpperCase();
}

const byId = new Map();
const dynById = new Map();
const all = [];
{
  const re = /<(\w+)([^>]*)\bid="([^"]+)"([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, before, id, after] = m;
    const el = new El(tag, id);
    const attrs = before + " " + after;
    let dm; const dre = /data-([\w-]+)="([^"]*)"/g;
    while ((dm = dre.exec(attrs))) el.dataset[dm[1]] = dm[2];
    const clsm = /\bclass="([^"]*)"/.exec(attrs);
    if (clsm) el.className = clsm[1];
    if (/\bchecked\b/.test(attrs)) el.checked = true;
    if (/\bhidden\b/.test(attrs)) el.hidden = true;
    byId.set(id, el);
    all.push(el);
  }
  const stepsEl = byId.get("steps");
  const btnRe = /<button\b([^>]*)data-step="([^"]+)"([^>]*)>/g;
  let bm;
  while ((bm = btnRe.exec(html))) {
    const b = new El("button");
    b.dataset.step = bm[2];
    b._scopeId = "steps";
    const cls = /class="([^"]*)"/.exec(bm[1] + bm[3]);
    if (cls) b.className = cls[1];
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
    const m = /^#([\w-]+)\s+button(?:\[data-step="([^"]+)"\])?$/.exec(sel);
    if (m) {
      const scope = byId.get(m[1]);
      return (scope ? scope.children : []).filter(
        (c) => c.tagName === "BUTTON" && (!m[2] || c.dataset.step === m[2]));
    }
    return all.filter((el) => matches(el, sel));
  },
  querySelector: (sel) => document.querySelectorAll(sel)[0] || null,
  createElement: (tag) => { const el = new El(tag); all.push(el); return el; },
  body: new El("body"),
};

/* hostile localStorage: every access throws, exercising the memory fallback */
const hostileStorage = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("SecurityError"); },
};
const errors = [];
const sandbox = {
  document,
  navigator: { clipboard: { writeText: async () => {} } },
  localStorage: hostileStorage,
  TextEncoder, TextDecoder,
  crypto: webcrypto,
  location: { reload() {} },
  setTimeout: (fn) => 0, clearTimeout: () => {},
  scrollTo() {},
  URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
  fetch: async () => { throw new Error("no network in DOM test"); },
  console: { ...console, error: (...a) => { errors.push(a.join(" ")); } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ["pearl-covenant.bundle.js", "qrcode.min.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f });
}
sandbox.window.PearlCovenant = sandbox.PearlCovenant;
vm.runInContext(fs.readFileSync(resolvePath(dir, "app.js"), "utf8"), sandbox, { filename: "app.js" });

const $ = (id) => document.getElementById(id);
const E = () => sandbox.window.PearlCovenant;
const MNEMONICS = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
];

test("page boots with zero console errors (hostile localStorage)", () => {
  assert.ok(E(), "bundle global present");
  assert.ok($("forge-btn"), "forge button present");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("every getElementById target in app.js exists in index.html", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  const ids = new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  // ckey-*/ok-* are created at runtime by renderCosignerFields (by design)
  const missing = [...ids].filter((id) => !byId.has(id) && !/^(ckey|ok)-\d+$/.test(id));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(","));
});

test("forge: 2-of-3 covenant renders a prl1p vault address", () => {
  $("n-select").value = "3";
  $("n-select").dispatchEvent({ type: "change" });
  $("m-select").value = "2";
  for (let i = 0; i < 3; i++) $("ckey-" + i).value = MNEMONICS[i];
  $("forge-btn").click();
  assert.equal($("forge-error").hidden, true, "no forge error: " + $("forge-error").textContent);
  assert.equal($("covenant-preview").hidden, false);
  const addr = $("cov-address").textContent;
  assert.ok(/^prl1p/.test(addr), "vault address: " + addr);
  assert.ok($("cov-descriptor").textContent.startsWith("covenant:v1:prl:2-of-3:"));
  assert.ok($("cov-asm").textContent.includes("CHECKSIGADD"));
  assert.ok($("cov-keys-table").querySelectorAll("tr").length >= 3);
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("@kshot9000"), "x handle in footer");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("vault: manual UTXO -> select -> spend step", () => {
  document.querySelector('#steps button[data-step="vault"]').click();
  assert.ok($("step-vault").classList.contains("active"));
  $("m-txid").value = "ab".repeat(32);
  $("m-vout").value = "0";
  $("m-value").value = "2.5";
  $("add-utxo").click();
  assert.equal($("vault-error").hidden, true, "no vault error: " + $("vault-error").textContent);
  assert.ok($("vault-balance").textContent.includes("2.5"));
  const radio = $("utxo-rows").querySelector("input");
  assert.ok(radio, "utxo row rendered");
  radio.checked = true;
  radio.dispatchEvent({ type: "change", target: radio });
  assert.equal($("spend-utxo-btn").disabled, false);
  $("spend-utxo-btn").click();
  assert.ok($("step-spend").classList.contains("active"));
  assert.ok($("spend-utxo-info").textContent.includes("2.5"));
});

test("spend: build signing round", () => {
  const e = E();
  const destKey = e.partyKeyFromInput(MNEMONICS[2], e.NETWORKS.mainnet).xonly;
  const dest = e.createCovenant({
    m: 1, keyInputs: [e.bytesToHex(destKey)], network: e.NETWORKS.mainnet,
  }).covenant.address;
  const row = document.querySelector(".pay-row");
  row.querySelector(".pay-addr").value = dest;
  row.querySelector(".pay-amt").value = "0.5";
  $("fee-rate").value = "5";
  $("memo").value = "dom test payout";
  $("build-round").click();
  assert.equal($("round-error").hidden, true, "no round error: " + $("round-error").textContent);
  assert.equal($("round-out").hidden, false);
  const json = $("round-json").value;
  assert.ok(json.length > 200, "round json length " + json.length);
  assert.ok($("round-summary").textContent.includes("dom test payout"));
  $("to-sign-btn").click();
  assert.ok($("step-sign").classList.contains("active"));
  assert.equal($("sign-round-input").value, json);
});

test("sign: verify -> local sig -> cosigner sig -> finalize", () => {
  const e = E();
  $("verify-round").click();
  assert.equal($("sign-error").hidden, true, "no sign error: " + $("sign-error").textContent);
  assert.equal($("sign-work").hidden, false);
  assert.ok($("quorum-label").textContent.includes("0 of 2"));
  // local signature with the first mnemonic pasted
  $("sign-key-input").value = MNEMONICS[0];
  $("sign-with-local").click();
  assert.equal($("sign-error").hidden, true, "no sign error: " + $("sign-error").textContent);
  assert.ok($("quorum-label").textContent.includes("1 of 2"), $("quorum-label").textContent);
  // cosigner signature computed via the bundle (as if received over the wire)
  const round = JSON.parse($("sign-round-input").value);
  const w = e.walletFromMnemonic(MNEMONICS[1], e.NETWORKS.mainnet);
  const keyHex = e.bytesToHex(w.internalXOnly);
  const sig = e.bytesToHex(e.signForXOnly(w.priv, round.digest));
  $("cosig-key").value = keyHex;
  $("cosig-sig").value = sig;
  $("add-cosig").click();
  assert.equal($("sign-error").hidden, true, "no cosig error: " + $("sign-error").textContent);
  assert.ok($("quorum-label").textContent.includes("2 of 2"), $("quorum-label").textContent);
  assert.equal($("finalize-btn").disabled, false);
  $("finalize-btn").click();
  assert.equal($("sign-error").hidden, true, "no finalize error: " + $("sign-error").textContent);
  assert.equal($("final-out").hidden, false);
  assert.ok(/^[0-9a-f]{64}$/.test($("final-txid").textContent), "txid: " + $("final-txid").textContent);
  assert.ok($("final-hex").value.length > 400, "hex length " + $("final-hex").value.length);
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("app.js grain formatter is BigInt-exact (pool float-format class)", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "app.js"), "utf8");
  assert.ok(src.includes("100000000n"), "BigInt-exact grain formatter present");
  assert.ok(src.includes("/^-?\\d+$/"), "integer-grain gate present");
});

test("vault refuses a malformed vout (parseInt truncation class)", () => {
  const balBefore = $("vault-balance").textContent;
  $("m-txid").value = "ef".repeat(32);
  // parseInt("1.9") silently became vout 1 — a different outpoint than typed
  $("m-vout").value = "1.9";
  $("m-value").value = "2.5";
  $("add-utxo").click();
  assert.equal($("vault-error").hidden, false, "malformed vout must error");
  assert.match($("vault-error").textContent, /bad vout/, $("vault-error").textContent);
  assert.equal($("vault-balance").textContent, balBefore, "no UTXO may be added from a malformed vout");
});

test("vault refuses inexact UTXO values (float-parser round-up class)", () => {
  const balBefore = $("vault-balance").textContent;
  $("m-txid").value = "cd".repeat(32);
  $("m-vout").value = "1";
  // >8 decimals: a float parser silently rounded this to 12345679 grains
  $("m-value").value = "0.123456789";
  $("add-utxo").click();
  assert.equal($("vault-error").hidden, false, "inexact UTXO value must error");
  assert.match($("vault-error").textContent, /positive number/, $("vault-error").textContent);
  assert.equal($("vault-balance").textContent, balBefore, "no UTXO may be added from an inexact value");
});
