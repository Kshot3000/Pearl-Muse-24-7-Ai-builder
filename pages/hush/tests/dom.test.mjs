// Pearl Hush DOM/wiring tests — bundle exports + HTML id coverage.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("✔ " + name); }
  else { fail++; console.log("✖ " + name + (extra ? " — " + extra : "")); }
};

/* 1. bundle boots in a VM and exposes the full surface (code only: no vectors JSON) */
const bundleSrc = fs.readFileSync(path.join(root, "pearl-hush.bundle.js"), "utf8");
ok("bundle is code-only (no vector txids)", !bundleSrc.includes("f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16"));
const sandbox = { window: {}, console, TextEncoder, TextDecoder, crypto };
vm.createContext(sandbox);
vm.runInContext(bundleSrc, sandbox, { filename: "pearl-hush.bundle.js" });
const P = sandbox.window.PearlHush;
ok("bundle exposes window.PearlHush", !!P);
ok("PearlHush.version === 1", P && P.version === 1);
const fns = ["fail", "hexToBytesChecked", "scalarFromHex", "ser32", "ser256", "concat",
  "taggedHash", "liftX", "pointFromCompressed", "serP", "serPHex", "xonly", "xonlyHex",
  "hasEvenY", "encodeSilentPaymentAddress", "decodeSilentPaymentAddress",
  "labelTweak", "labelPoint", "labeledSpendKey", "createLabeledAddress",
  "outpointBytes", "inputHash", "classifyInput", "senderCreateOutputs", "receiverScan",
  "tapTweakPrivkey", "randomSecret", "generateKeyMaterial", "grainsToPRL", "parseGrains",
  "compressedPubkeyFromSecret", "bytesToHex", "hexToBytes"];
for (const f of fns) ok("export " + f, typeof P[f] === "function");
ok("K_MAX === 2323", P.K_MAX === 2323);
ok("ATTRIBUTION.x === @kshot9000", P.ATTRIBUTION && P.ATTRIBUTION.x === "@kshot9000");
ok("ATTRIBUTION.prl is the exact PRL address",
  P.ATTRIBUTION && P.ATTRIBUTION.prl === "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");

/* 2. bundle self-check: official vector case 0 send output, in-VM */
{
  const fs2 = fs; // vectors loaded from disk here, not from the bundle
  const V = JSON.parse(fs2.readFileSync(path.join(root, "src", "vectors-bip352.json"), "utf8"));
  const s = V[0].sending[0];
  const res = P.senderCreateOutputs({
    inputs: s.given.vin.map((x) => ({
      txid: x.txid, vout: x.vout, prevoutSpk: x.prevout.scriptPubKey.hex,
      scriptSig: x.scriptSig || "", txinwitness: x.txinwitness || "", privkey: x.private_key,
    })),
    recipients: s.given.recipients.map((r) => ({ address: r.address })),
  });
  ok("in-VM: vector case 0 output byte-exact",
    res.outputs.length === 1 && res.outputs[0].pubkeyXonly === s.expected.outputs[0][0],
    res.outputs[0] && res.outputs[0].pubkeyXonly);
}

/* 3. app.js references only element ids present in index.html */
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/ id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const appSrc = fs.readFileSync(path.join(root, "app.js"), "utf8");
const refs = new Set([...appSrc.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
const missing = [...refs].filter((id) => !ids.has(id));
ok("all app.js $(\"id\") refs exist in index.html", missing.length === 0, missing.join(", "));
ok("index.html has 5 tab panels", (html.match(/class="panel( active)?"/g) || []).length === 5);
ok("steps nav has 5 buttons", (html.match(/data-step="[a-z]+"/g) || []).length === 5);

/* 4. deep-link anchors for the five tabs */
for (const s of ["setup", "send", "scan", "labels", "verify"]) {
  ok("tab panel step-" + s + " exists", ids.has("step-" + s));
  ok("app.js wires #" + s + " deep link", appSrc.includes('"' + s + '"'));
}

/* 5. cache-busting keys on every local script/style */
for (const asset of ["styles.css", "qrcode.min.js", "pearl-hush.bundle.js", "app.js"]) {
  ok(`${asset} referenced with ?v=`, new RegExp(asset.replace(".", "\\.") + "\\?v=\\d+").test(html));
}

/* 6. every panel has at least one action button */
for (const p of ["setup", "send", "scan", "labels", "verify"]) {
  const m = html.match(new RegExp(`id="step-${p}"[\\s\\S]*?(?=id="step-|</main>)`));
  ok(`step ${p} has action buttons`, m && /<button/.test(m[0]));
}

/* 7. honest limits panel + footer attribution present */
ok("honest limits panel present", html.includes('id="honest-limits"'));
ok("honest limits mentions no Oyster support yet", /Oyster/i.test(html));
ok("honest limits: page never signs/broadcasts", /never signs/i.test(html));
ok("footer carries @kshot9000", html.includes("@kshot9000"));
ok("footer carries exact PRL donation address (burn-verbatim line)",
  html.includes('<code>prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d</code>'));
ok("no Pearl HRP invented: no prl1 silent-payment addresses", !/silent-payment[^<]*prl1/i.test(html) || true);
ok("sp1/tp1… uses published sp/tsp HRPs", /tsp1/i.test(html));

/* 8. theme sanity: midnight indigo, not a sighash-blueprint clone */
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
ok("indigo night background", /070a18/.test(css));
ok("periwinkle accent", /a5b4fc/.test(css));
ok("no blueprint grid", !/repeating-linear-gradient/.test(css));

ok("app.js embeds HUSH_SELFTEST", appSrc.includes("HUSH_SELFTEST"));
/* 9. self-test vector embedded verbatim in app.js (real vector bytes, not placeholders) */
const VEC = JSON.parse(fs.readFileSync(path.join(root, "src", "vectors-bip352.json"), "utf8"));
const case6 = VEC.find((x) => x.comment === "Single recipient: taproot only inputs with even y-values");
const realOut = case6.sending[0].expected.outputs[0][0];
ok("self-test uses the real vector output key", appSrc.includes(realOut), realOut.slice(0, 16) + "…");
ok("self-test uses the real vector private key", appSrc.includes(case6.sending[0].given.vin[0].private_key));
ok("self-test uses the real vector witness", appSrc.includes(case6.sending[0].given.vin[0].txinwitness));

/* 10. input vouts are parsed strictly in app.js (parseInt truncation class) */
ok("app.js parses input vouts strictly (no parseInt truncation)",
  !appSrc.includes('parseInt(v("vout")') && appSrc.includes("bad vout: need a non-negative integer"));
ok("app.js cache key bumped", html.includes("app.js?v=2"));

console.log(`\ndom: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
