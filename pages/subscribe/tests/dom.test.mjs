// Pearl Subscribe DOM integration test — boots the real index.html + scripts
// (pearl-subscribe.bundle.js, app.js) in a stub DOM and checks:
//  1. every static id referenced by app.js exists in index.html
//  2. donation address + X handle are present and exact
//  3. app.js initializes without throwing (all listeners wired)
//  4. the full service -> terms -> fund -> pre-sign -> verify flow works with
//     fixture keys, and the emitted bundle verifies end-to-end
//  5. wrong-key signing is refused loudly and key inputs are wiped
// Run: node --no-warnings --test tests/dom.test.mjs
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
const appSrc = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
const bundleSrc = fs.readFileSync(resolvePath(dir, "pearl-subscribe.bundle.js"), "utf8");

test("every static id referenced by app.js exists in index.html", () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([...appSrc.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...refs].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], "app.js references ids missing from index.html: " + missing.join(", "));
});

test("donation address and X handle are present and exact", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address missing");
  assert.ok(html.includes("https://x.com/kshot9000"), "X link missing");
});

function buildStubDom() {
  class ClassList {
    constructor() { this.s = new Set(); }
    add(...c) { c.forEach((x) => this.s.add(x)); }
    remove(...c) { c.forEach((x) => this.s.delete(x)); }
    toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
    contains(c) { return this.s.has(c); }
  }
  const elements = new Map();
  const stepButtons = [];
  const sections = [];
  let qsn = 0;
  function makeEl(id) {
    const el = {
      classList: new ClassList(), dataset: {},
      value: "", textContent: "", hidden: false, disabled: false,
      placeholder: "", style: {}, tagName: "DIV",
      _handlers: {},
      children: [],
      addEventListener(t, f) { (this._handlers[t] ??= []).push(f); },
      appendChild(c) { this.children.push(c); return c; },
      append(...cs) { this.children.push(...cs); },
      click() { (this._handlers.click ?? []).forEach((f) => f({ target: this })); },
      querySelector() { return null; },
    };
    let _id = id, _innerHTML = "";
    Object.defineProperty(el, "id", {
      get() { return _id; },
      set(v) { elements.delete(_id); _id = v; elements.set(v, el); },
    });
    Object.defineProperty(el, "innerHTML", {
      get() { return _innerHTML; },
      set(v) { _innerHTML = String(v); },
    });
    elements.set(_id, el);
    return el;
  }
  for (const s of ["service", "terms", "fund", "presign", "track", "cancel", "verify"]) {
    const b = makeEl("stepbtn-" + s); b.dataset.step = s; stepButtons.push(b);
    const sec = makeEl("step-" + s); sections.push(sec);
  }
  const doc = {
    getElementById(id) { return elements.get(id) || makeEl(id); },
    querySelectorAll(sel) {
      if (sel === "#steps button") return stepButtons;
      if (sel === ".copy-btn") return [];
      return [];
    },
    querySelector(sel) {
      if (sel.startsWith("#steps button")) return makeEl("qs-" + (qsn++));
      return null;
    },
    createElement(tag) {
      const el = makeEl("dyn-" + Math.random().toString(36).slice(2));
      el.tagName = tag.toUpperCase();
      return el;
    },
    body: null,
  };
  doc.body = makeEl("body");
  return { doc, elements, makeEl };
}

function boot() {
  const { doc, elements, makeEl } = buildStubDom();
  for (const m of html.matchAll(/<(\w+)[^>]*id="([^"]+)"[^>]*>/g)) {
    const el = makeEl(m[2]);
    if (/\shidden(?=[\s>])/.test(m[0])) el.hidden = true;
    if (m[1] === "button" && /disabled(?=[\s>])/.test(m[0])) el.disabled = true;
  }
  const ctx = vm.createContext({
    document: doc,
    window: { scrollTo() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    crypto: webcrypto,
    TextEncoder, TextDecoder,
    URL, Blob,
    setTimeout, clearTimeout,
    console,
  });
  vm.runInContext(bundleSrc, ctx, { filename: "pearl-subscribe.bundle.js" });
  assert.ok(ctx.PearlSubscribe, "bundle must set PearlSubscribe");
  vm.runInContext("window.PearlSubscribe = PearlSubscribe;", ctx);
  vm.runInContext(appSrc, ctx, { filename: "app.js" });
  return { ctx, elements, $: (id) => elements.get(id) };
}

test("full service -> terms -> fund -> pre-sign -> verify flow in stub DOM", () => {
  const { ctx, $ } = boot();
  const E = ctx.PearlSubscribe;
  const NW = E.NETWORKS.mainnet;
  const anchor = E.subscriberKeyFromInput("11".repeat(32), NW).keypathAddress;
  const merchant = E.subscriberKeyFromInput("22".repeat(32), NW).keypathAddress;

  // step 1: service
  $("network").value = "mainnet";
  $("sub-period").value = "3118";
  $("sub-merchant").value = merchant;
  $("sub-anchor").value = anchor;
  $("sub-amount").value = "1";
  $("sub-periods").value = "3";
  $("sub-start").value = "500000";
  $("sub-feerate").value = "5";
  $("service-next").click();
  assert.equal($("service-err").hidden, true, "service must not error: " + $("service-err").textContent);
  assert.match($("terms-fp").textContent, /^[0-9a-f]{16}$/, "fingerprint must be 64-bit hex");
  assert.equal(($("terms-body").innerHTML.match(/<tr>/g) || []).length, 3, "3 schedule rows");

  // step 2 -> 3: fund
  $("terms-next").click();
  assert.equal(($("fund-body").innerHTML.match(/<tr>/g) || []).length, 3, "3 funding outputs");
  assert.ok($("fund-total").textContent.includes("PRL"));

  // wrong key first: must refuse loudly
  $("fund-utxos").value = `${"aa".repeat(32)}:0:500000000`;
  $("fund-key").value = "33".repeat(32);
  $("fund-build").click();
  assert.equal($("fund-err").hidden, false, "wrong key must error");
  assert.match($("fund-err").textContent, /KEY MISMATCH/);

  // right key: builds, wipes
  $("fund-key").value = "11".repeat(32);
  $("fund-build").click();
  assert.equal($("fund-err").hidden, true, "fund must not error: " + $("fund-err").textContent);
  assert.equal($("fund-key").value, "", "key input wiped after signing");
  assert.match($("fund-txid").textContent, /^[0-9a-f]{64}$/, "funding txid shown");
  const fundingTxid = $("fund-txid").textContent;

  // step 4: pre-sign
  $("fund-next").click();
  assert.equal($("ps-funding-txid").value, fundingTxid, "funding txid carried to pre-sign");
  $("ps-plans").click();
  assert.equal($("ps-err").hidden, true, "plans must not error: " + $("ps-err").textContent);
  assert.equal(($("ps-body").innerHTML.match(/<tr>/g) || []).length, 3, "3 payment plans");
  $("ps-key").value = "11".repeat(32);
  $("ps-sign").click();
  assert.equal($("ps-err").hidden, true, "pre-sign must not error: " + $("ps-err").textContent);
  assert.equal($("ps-key").value, "", "key input wiped after signing");
  const bundleJson = $("ps-bundle").value;
  assert.ok(bundleJson.includes("pearl-sub-bundle:v1"), "signed bundle emitted");

  // step 7: verify — the UI's own verifier on the UI's own bundle
  $("vf-input").value = bundleJson;
  $("vf-run").click();
  assert.equal($("vf-err").hidden, true, "verify must not error: " + $("vf-err").textContent);
  assert.ok($("vf-out").innerHTML.includes("Bundle verified"), "verifier stamps the bundle");

  // tampered bundle through the same UI path
  const evil = JSON.parse(bundleJson);
  evil.payments[0].locktime += 1;
  $("vf-input").value = JSON.stringify(evil);
  $("vf-run").click();
  assert.ok($("vf-out").innerHTML.includes("Bundle invalid"), "tampered bundle rejected");
});

test("service refuses malformed integer terms, never truncates them into the descriptor", () => {
  const { ctx, $ } = boot();
  const E = ctx.PearlSubscribe;
  const NW = E.NETWORKS.mainnet;
  $("network").value = "mainnet";
  $("sub-period").value = "3118";
  $("sub-merchant").value = E.subscriberKeyFromInput("22".repeat(32), NW).keypathAddress;
  $("sub-anchor").value = E.subscriberKeyFromInput("11".repeat(32), NW).keypathAddress;
  $("sub-amount").value = "1";
  $("sub-periods").value = "3";
  $("sub-start").value = "512340xyz"; // bare parseInt silently used 512340
  $("sub-feerate").value = "5";
  $("service-next").click();
  assert.equal($("service-err").hidden, false, "malformed start height must error");
  assert.match($("service-err").textContent, /start height must be a whole number/);
  $("sub-start").value = "512340";
  $("sub-periods").value = "3abc"; // bare parseInt silently used 3
  $("service-next").click();
  assert.equal($("service-err").hidden, false, "malformed periods must error");
  assert.match($("service-err").textContent, /periods must be a whole number/);
  $("sub-periods").value = "3";
  $("sub-feerate").value = "5abc"; // bare parseInt silently used 5
  $("service-next").click();
  assert.equal($("service-err").hidden, false, "malformed fee rate must error");
  assert.match($("service-err").textContent, /fee rate must be a whole number/);
  $("sub-feerate").value = "5";
  $("sub-period").value = "custom";
  $("sub-period-custom").value = "445abc"; // bare parseInt silently used 445
  $("service-next").click();
  assert.equal($("service-err").hidden, false, "malformed custom period must error");
  assert.match($("service-err").textContent, /custom period must be a whole number/);
});

test("service refuses invalid terms loudly", () => {
  const { $ } = boot();
  $("network").value = "mainnet";
  $("sub-period").value = "3118";
  $("sub-merchant").value = "not-an-address";
  $("sub-anchor").value = "also-bad";
  $("sub-amount").value = "0.000001";
  $("sub-periods").value = "99";
  $("sub-start").value = "1";
  $("service-next").click();
  assert.equal($("service-err").hidden, false, "invalid terms must error");
  assert.ok($("service-err").textContent.length > 20, "error explains the problems");
});

test("verifier render escapes checks/failures (pasted-bundle XSS pin)", () => {
  assert.match(appSrc, /const esc = \(s\) => String\(s \?\? ""\)/);
  assert.match(appSrc, /\$\("vf-checks"\)\.innerHTML =\s*res\.checks\.map\(\(c\) => `<li class="ok">✓ \$\{esc\(c\)\}<\/li>`\)/);
  assert.match(appSrc, /res\.failures\.map\(\(f\) => `<li class="bad">✗ \$\{esc\(f\)\}<\/li>`\)/);
});
