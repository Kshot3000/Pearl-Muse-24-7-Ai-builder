// Pearl Names DOM integration test — boots the real index.html + committed
// bundle (pearl-names.bundle.js) + app.js against a minimal DOM shim and
// drives the register wizard (check -> demo key -> sign -> plan ->
// commit/reveal build + witness self-verify), the directory import, and the
// standalone verifier, all against the shipped bundle.
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
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this.dataset = {};
    this.value = ""; this.textContent = ""; this._html = "";
    this.hidden = false; this.disabled = false;
    this._handlers = {}; this._kids = [];
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  appendChild(k) { this._kids.push(k); return k; }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  querySelector() { return null; }
}
const byId = new Map();
const hiddenIds = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]));
const selectDefaults = new Map();
for (const m of html.matchAll(/<select[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const sel = m[2].match(/<option[^>]*\bvalue="([^"]*)"[^>]*\bselected\b[^>]*>/) || m[2].match(/<option[^>]*\bvalue="([^"]*)"[^>]*>/);
  if (sel) selectDefaults.set(m[1], sel[1]);
}
// tab buttons + copy buttons from the real markup
const tabButtons = [...html.matchAll(/<button[^>]*\bdata-tab="([^"]+)"[^>]*>/g)].map((m) => {
  const b = new El("button"); b.dataset.tab = m[1]; return b;
});
const copyButtons = [...html.matchAll(/<button[^>]*\bclass="[^"]*\bcopy-btn\b[^"]*"[^>]*\bdata-for="([^"]+)"[^>]*>/g)].map((m) => {
  const b = new El("button"); b.dataset.for = m[1]; return b;
});
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    if (hiddenIds.has(id)) el.hidden = true;
    if (selectDefaults.has(id)) el.value = selectDefaults.get(id);
    byId.set(id, el);
  }
  return byId.get(id);
};
const documentShim = {
  getElementById: (id) => getEl(id),
  querySelectorAll: (sel) =>
    sel === "#tabs button" ? tabButtons :
    sel === ".copy-btn[data-for]" ? copyButtons : [],
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
};
const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  TextDecoder, crypto: webcrypto,
  location: { reload() {} },
  Blob: class Blob {}, URL: { createObjectURL: () => "", revokeObjectURL() {} },
  setTimeout, clearTimeout,
  confirm: () => false, // never auto-broadcast in tests
  console,
};
// in-memory localStorage (the app treats the real one as hostile, so this
// only has to implement the interface)
{
  const mem = new Map();
  sandbox.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
}
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
for (const f of ["pearl-names.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}
const N = sandbox.PearlNames;
assert.ok(N, "bundle loaded as window.PearlNames");

const click = (id) => getEl(id).click();
const setVal = (id, v) => { getEl(id).value = v; };

test("register wizard: name -> demo key -> sign -> plan -> commit/reveal -> self-verify", () => {
  // step 1: name check
  setVal("r-name", "alice-wonder");
  click("r-check");
  assert.equal(getEl("r-name-err").hidden, true, "no name error: " + getEl("r-name-err").textContent);
  assert.equal(getEl("r-name-ok").hidden, false);
  assert.ok(getEl("r-name-ok").textContent.includes("alice-wonder.prl"));

  // reserved name refused
  setVal("r-name", "admin");
  click("r-check");
  assert.equal(getEl("r-name-err").hidden, false);
  setVal("r-name", "alice-wonder");
  click("r-check");
  assert.equal(getEl("r-name-err").hidden, true);

  // step 2: demo key + sign
  click("r-gen");
  assert.ok(getEl("r-key").value.split(" ").length === 12, "demo mnemonic generated");
  click("r-prove");
  assert.equal(getEl("r-prove-err").hidden, true, "no prove error: " + getEl("r-prove-err").textContent);
  assert.equal(getEl("r-proof").hidden, false);
  assert.match(getEl("r-proof-id").textContent, /^[0-9a-f]{64}$/);
  assert.match(getEl("r-proof-fp").textContent, /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  assert.match(getEl("r-proof-sig").textContent, /^[0-9a-f]{128}$/);
  assert.ok(getEl("r-proof-json").value.includes('"name":"alice-wonder"'));

  // step 3: plan
  setVal("r-utxo", "44".repeat(32) + ":0:1000000");
  click("r-plan");
  assert.equal(getEl("r-plan-err").hidden, true, "no plan error: " + getEl("r-plan-err").textContent);
  assert.equal(getEl("r-plan-out").hidden, false);
  assert.ok(getEl("r-plan-commitaddr").textContent.startsWith("prl1p"));
  assert.ok(getEl("r-plan-fee").textContent.includes("grains"));

  // step 4: commit + reveal build (r-reveal delegates to r-commit)
  click("r-reveal");
  assert.equal(getEl("r-bc-err").hidden, true, "no build error: " + getEl("r-bc-err").textContent);
  assert.ok(getEl("r-commit-hex").value.length > 200);
  assert.ok(getEl("r-reveal-hex").value.length > 200);
});

test("directory: import signed binding, first-seen wins, search", () => {
  const binding = { json: getEl("r-proof-json").value, sig: getEl("r-proof-sig").textContent };
  click("d-add");
  assert.equal(getEl("d-addbox").hidden, false);
  setVal("d-json", JSON.stringify(binding));
  click("d-import");
  assert.equal(getEl("d-err").hidden, true, "no import error: " + getEl("d-err").textContent);
  assert.ok(getEl("d-rows").innerHTML.includes("alice-wonder.prl"), "name listed");
  assert.ok(getEl("d-rows").innerHTML.includes("✓ registered"));
});

test("verifier: pasted binding rules VALID, witness reveal rules VALID", () => {
  const binding = { json: getEl("r-proof-json").value, sig: getEl("r-proof-sig").textContent };
  setVal("v-input", JSON.stringify(binding));
  click("v-run");
  assert.equal(getEl("v-err").hidden, true, "no verify error");
  assert.equal(getEl("v-out").hidden, false);
  assert.ok(getEl("v-verdict").textContent.startsWith("VALID ✓"), "verdict: " + getEl("v-verdict").textContent);

  // tampered name -> INVALID
  const bad = JSON.parse(binding.json);
  bad.name = "mallory";
  setVal("v-input", JSON.stringify({ json: JSON.stringify(bad), sig: binding.sig }));
  click("v-run");
  assert.ok(getEl("v-verdict").textContent.startsWith("INVALID"), "tampered verdict: " + getEl("v-verdict").textContent);

  // reveal witness verification against the shipped bundle
  setVal("v-input", JSON.stringify(binding));
  click("v-run"); // restore good state
  click("v-witness");
  assert.equal(getEl("v-witnessbox").hidden, false);
  setVal("v-revealhex", getEl("r-reveal-hex").value);
  click("v-run-witness");
  assert.equal(getEl("v-err").hidden, true, "no witness error: " + getEl("v-err").textContent);
  assert.ok(getEl("v-verdict").textContent.includes("VALID"), "witness verdict: " + getEl("v-verdict").textContent);
});

test("register step 2: raw 64-hex private key proves ownership", () => {
  // derive the demo wallet's priv as hex through the bundle, then feed it
  // through the UI's raw-hex key path (was broken: missing export + routed to WIF)
  setVal("r-name", "hex-path");
  click("r-check");
  assert.equal(getEl("r-name-err").hidden, true, "no name error: " + getEl("r-name-err").textContent);
  const mn = getEl("r-key").value.split(" ").length === 12 ? getEl("r-key").value : N.newMnemonic();
  const w = N.walletFromMnemonic(mn, N.NETWORKS.mainnet);
  setVal("r-key", N.bytesToHex(w.priv));
  click("r-prove");
  assert.equal(getEl("r-prove-err").hidden, true, "no prove error: " + getEl("r-prove-err").textContent);
  assert.equal(getEl("r-proof").hidden, false);
  assert.match(getEl("r-proof-id").textContent, /^[0-9a-f]{64}$/);
  assert.ok(getEl("r-proof-json").value.includes(w.address), "bound to the hex key's address");
});

test("bundle API surface sanity", () => {
  assert.equal(typeof N.validateName, "function");
  assert.equal(typeof N.walletFromPriv, "function");
  assert.equal(typeof N.signBinding, "function");
  assert.equal(typeof N.verifySignedBinding, "function");
  assert.equal(typeof N.resolveRegistry, "function");
  assert.equal(typeof N.buildNameScript, "function");
  assert.equal(typeof N.verifyNameWitness, "function");
  assert.equal(N.NAME_MARKER, "prl-name");
});

test("app.js grain formatter is BigInt-exact (pool float-format class)", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "app.js"), "utf8");
  assert.ok(src.includes("100000000n"), "BigInt-exact grain formatter present");
  assert.ok(src.includes("/^-?\\d+$/"), "integer-grain gate present");
});

test("register: malformed pasted UTXO refused at parse time (garbage suffix / rounded oversize)", () => {
  setVal("r-utxo", "44".repeat(32) + ":0:100000abc");
  click("r-commit");
  assert.equal(getEl("r-bc-err").hidden, false);
  assert.ok(getEl("r-bc-err").textContent.includes("bad value"), "err: " + getEl("r-bc-err").textContent);
  setVal("r-utxo", "44".repeat(32) + ":0:9007199254740993");
  click("r-commit");
  assert.equal(getEl("r-bc-err").hidden, false);
  assert.ok(getEl("r-bc-err").textContent.includes("bad value"), "err: " + getEl("r-bc-err").textContent);
  setVal("r-utxo", "44".repeat(32) + ":1xyz:1000000");
  click("r-commit");
  assert.equal(getEl("r-bc-err").hidden, false);
  assert.ok(getEl("r-bc-err").textContent.includes("bad vout"), "err: " + getEl("r-bc-err").textContent);
});

test("register: malformed expiry refused, not truncated into the signed binding", () => {
  setVal("r-name", "strict-expiry");
  setVal("r-expiry", "1893456000.9");
  click("r-check");
  assert.equal(getEl("r-name-err").hidden, false);
  assert.ok(getEl("r-name-err").textContent.includes("expiry must be a positive unix timestamp"), "err: " + getEl("r-name-err").textContent);
  assert.equal(getEl("r-name-ok").hidden, true);
  setVal("r-expiry", "99999999999999999999");
  click("r-check");
  assert.equal(getEl("r-name-err").hidden, false);
  assert.ok(getEl("r-name-err").textContent.includes("expiry must be a positive unix timestamp"), "err: " + getEl("r-name-err").textContent);
  setVal("r-expiry", "1893456000");
  click("r-check");
  assert.equal(getEl("r-name-err").hidden, true, "no name error: " + getEl("r-name-err").textContent);
  assert.equal(getEl("r-name-ok").hidden, false);
});
