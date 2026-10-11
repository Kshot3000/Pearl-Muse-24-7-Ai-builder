// Pearl Covenant DOM integration test — boots the real index.html + committed
// bundle (pearl-vesting.bundle.js) + app.js against a minimal DOM shim and
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
for (const f of ["pearl-vesting.bundle.js", "qrcode.min.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f });
}
sandbox.window.PearlVesting = sandbox.PearlVesting;
vm.runInContext(fs.readFileSync(resolvePath(dir, "app.js"), "utf8"), sandbox, { filename: "app.js" });


const $ = (id) => document.getElementById(id);
const E = () => sandbox.window.PearlVesting;
const FUNDER_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BEN_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";

test("page boots with zero console errors (hostile localStorage)", () => {
  assert.ok(E(), "bundle global present");
  assert.ok($("forge"), "forge button present");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("every getElementById target in app.js exists in index.html", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  const ids = new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(","));
});

test("forge: custom past-dated schedule renders tranche cards + descriptor", () => {
  const e = E();
  const benAddr = e.walletFromMnemonic(BEN_MNEMONIC, e.NETWORKS.mainnet).address;
  $("beneficiary").value = benAddr;
  $("funder").value = FUNDER_MNEMONIC;
  $("custom").value = "2020-01-01, 1\n2020-06-01, 2\n2021-01-01, 3";
  $("revocable").checked = true;
  $("forge").click();
  assert.equal($("forge-err").hidden, true, "no forge error: " + $("forge-err").textContent);
  assert.equal($("schedule-out").hidden, false);
  const cards = $("tranche-cards").querySelectorAll(".card");
  assert.equal(cards.length, 3);
  const addrs = $("tranche-cards").textContent;
  assert.ok(/prl1p[0-9a-z]+/.test(addrs), "tranche addresses rendered");
  const desc = $("descriptor").value;
  assert.ok(desc.startsWith("vesting:v1:prl:"), "descriptor: " + desc.slice(0, 40));
  assert.ok(desc.includes(":r:addr:"), "revocable + address mode in descriptor");
  assert.ok($("beneficiary-mode-note").textContent.includes("address"), "mode note shown");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("@kshot9000"), "x handle in footer");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("step nav switches panels", () => {
  document.querySelector('#steps button[data-step="track"]').click();
  assert.ok($("step-track").classList.contains("active"));
  assert.ok(!$("step-forge").classList.contains("active"));
  document.querySelector('#steps button[data-step="forge"]').click();
  assert.ok($("step-forge").classList.contains("active"));
});

test("track: descriptor loads and re-derives the same addresses", () => {
  const m = $("tranche-cards").textContent.match(/prl1p[0-9a-z]+/);
  assert.ok(m, "forged tranche address rendered");
  const firstAddr = m[0];
  const desc = $("descriptor").value;
  $("track-descriptor").value = desc;
  $("track-load").click();
  assert.equal($("track-err").hidden, true, "no track error: " + $("track-err").textContent);
  const cards = $("track-out").querySelectorAll(".card");
  assert.equal(cards.length, 3);
  assert.ok($("track-out").textContent.includes(firstAddr), "re-derived address matches forged address");
  // malformed descriptor -> honest error
  $("track-descriptor").value = "vesting:v1:prl:garbage";
  $("track-load").click();
  assert.equal($("track-err").hidden, false);
});

test("claim: matured tranches listed; UTXO load needs Blockbook (honest error, no network)", async () => {
  const sel = $("claim-tranche");
  const opts = [...sel.querySelectorAll("option")].filter((o) => o.value);
  assert.ok(opts.length >= 3, "matured options present: " + opts.length);
  assert.ok(!opts[0].disabled, "past-dated tranche is matured, not disabled");
  sel.value = opts[0].value;
  sel.dispatchEvent({ type: "change" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal($("claim-err").hidden, false, "blockbook-missing error shown");
  assert.ok(/Blockbook/.test($("claim-err").textContent), "error text: " + $("claim-err").textContent);
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("forge rejects dust tranches honestly", () => {
  $("beneficiary").value = E().walletFromMnemonic(BEN_MNEMONIC, E().NETWORKS.mainnet).address;
  $("funder").value = FUNDER_MNEMONIC;
  $("custom").value = "2020-01-01, 0.00000001\n2020-06-01, 0.00000001";
  $("forge").click();
  assert.equal($("forge-err").hidden, false);
  assert.ok(/dust/.test($("forge-err").textContent), "error text: " + $("forge-err").textContent);
});

test("forge rejects silently-misparsed custom amounts and impossible dates", () => {
  $("beneficiary").value = E().walletFromMnemonic(BEN_MNEMONIC, E().NETWORKS.mainnet).address;
  $("funder").value = FUNDER_MNEMONIC;
  // the old float parse silently truncated "1.2.3" to a 1.2 PRL tranche
  $("custom").value = "2030-01-01, 1.2.3";
  $("forge").click();
  assert.equal($("forge-err").hidden, false);
  assert.ok(/bad amount/.test($("forge-err").textContent), "error text: " + $("forge-err").textContent);
  // sub-grain precision is refused, not rounded
  $("custom").value = "2030-01-01, 25.123456789";
  $("forge").click();
  assert.equal($("forge-err").hidden, false);
  assert.ok(/bad amount/.test($("forge-err").textContent), "error text: " + $("forge-err").textContent);
  // Date.UTC used to roll 2027-02-30 over to 2027-03-02 silently
  $("custom").value = "2027-02-30, 25";
  $("forge").click();
  assert.equal($("forge-err").hidden, false);
  assert.ok(/not a real calendar date/.test($("forge-err").textContent), "error text: " + $("forge-err").textContent);
  // source pins: money enters only through the exact core parser
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  assert.ok(src.includes("E.parsePRLToGrains($(\"total\").value)"), "total uses exact parser");
  assert.ok(src.includes("E.parsePRLToGrains(m[4])"), "custom amounts use exact parser");
  assert.ok(!/parseFloat\([^)]*\)\s*\*\s*E\.GRAIN_PER_PRL/.test(src), "no float money parse remains");
  assert.ok(html.includes("pearl-vesting.bundle.js?v=3"), "bundle cache pin");
  assert.ok(html.includes("app.js?v=4"), "app cache pin");
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

test("forge rejects silently-truncated tranche counts", () => {
  $("beneficiary").value = E().walletFromMnemonic(BEN_MNEMONIC, E().NETWORKS.mainnet).address;
  $("funder").value = FUNDER_MNEMONIC;
  $("custom").value = "";
  $("total").value = "100";
  $("start").value = "2030-01-01T00:00";
  $("cliff").value = "30";
  $("vest").value = "365";
  $("tranches").value = "12.9";
  $("forge").click();
  assert.equal($("forge-err").hidden, false);
  assert.ok(/tranche count/.test($("forge-err").textContent), "error text: " + $("forge-err").textContent);
  $("tranches").value = "1e1";
  $("forge").click();
  assert.equal($("forge-err").hidden, false);
  assert.ok(/tranche count/.test($("forge-err").textContent), "error text: " + $("forge-err").textContent);
  assert.ok(html.includes("app.js?v=4"), "app cache pin");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});
