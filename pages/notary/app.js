/* Pearl Notary UI — 5-step notarization wizard + verifier.
 * All signing happens via the window.PearlNotary bundle (audited crypto);
 * this file is pure UI wiring. */
(() => {
  "use strict";
  const N = window.PearlNotary;
  if (!N) { document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-notary.bundle.js</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  /* storage that survives hostile localStorage (Gallery lesson) */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return this.m?.[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { (this.m ??= {})[k] = v; } },
  };

  const S = {
    docBytes: null, docName: "document.txt", composed: null,
    network: N.NETWORKS.mainnet, wallet: null, mnemonic: null,
    blockbook: store.get("notary.blockbook") || N.NETWORKS.mainnet.blockbook,
    feeRate: 5, utxos: [], plan: null, commit: null, reveal: null, cert: null,
  };

  const fmtPRL = (g) => {
/* BigInt-exact (pool float-format class): the old float format
     * silently rounds grain counts past Number.MAX_SAFE_INTEGER.
     * Integer string/BigInt grain counts format exactly; anything
     * else keeps the legacy float rendering. */
    const s = typeof g === "bigint" ? g.toString() : String(g).trim();
    if (!/^-?\d+$/.test(s)) return (Number(g) / N.GRAIN_PER_PRL).toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0") + " PRL";
    const b = BigInt(s), neg = b < 0n, a = neg ? -b : b;
    const w = (a / 100000000n).toString();
    const f = (a % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + w + "." + (f || "0") + " PRL";
  };
  const err = (id, msg) => { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- step navigation ---------- */
  const steps = ["document", "key", "commit", "reveal", "seal", "verify"];
  function goto(step) {
    steps.forEach((s) => {
      $("step-" + s).classList.toggle("active", s === step);
      const b = document.querySelector(`#steps button[data-step="${s}"]`);
      b.classList.toggle("active", s === step);
      if (steps.indexOf(s) < steps.indexOf(step)) b.classList.add("done");
    });
    window.scrollTo({ top: 0, behavior: (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth") });
  }
  document.querySelectorAll("#steps button").forEach((b) => b.addEventListener("click", () => goto(b.dataset.step)));

  const readFile = (f) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res({ name: f.name, bytes: new Uint8Array(r.result) });
    r.onerror = () => rej(new Error("could not read file"));
    r.readAsArrayBuffer(f);
  });

  /* ---------- step 1: document ---------- */
  function setDoc(name, bytes) {
    S.docBytes = bytes; S.docName = name || "document.txt";
    $("doc-filename").value = S.docName;
    $("doc-result").hidden = true; $("to-key").disabled = true;
  }
  const dz = $("dropzone");
  dz.addEventListener("click", (e) => { if (e.target.tagName !== "INPUT") $("file-input").click(); });
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file-input").click(); } });
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", async (e) => {
    e.preventDefault(); dz.classList.remove("over");
    const f = e.dataTransfer.files[0]; if (!f) return;
    try { const { name, bytes } = await readFile(f); setDoc(name, bytes); err("doc-error", null); }
    catch (ex) { err("doc-error", ex.message); }
  });
  $("file-input").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const { name, bytes } = await readFile(f); setDoc(name, bytes); err("doc-error", null); }
    catch (ex) { err("doc-error", ex.message); }
  });
  $("doc-text").addEventListener("input", (e) => {
    const t = e.target.value;
    if (t) setDoc($("doc-filename").value.trim() || "pasted-text.txt", new TextEncoder().encode(t));
  });
  $("seal-compose").addEventListener("click", () => {
    err("doc-error", null);
    try {
      if (!S.docBytes || S.docBytes.length === 0) throw new Error("Provide a document first — drop a file or paste text.");
      const filename = $("doc-filename").value.trim() || S.docName;
      const hash = N.hashDocument(S.docBytes);
      const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      S.composed = N.composeNotarization({
        hash, filename, size: S.docBytes.length, ts,
        title: $("doc-title").value.trim(), by: $("doc-by").value.trim(),
      });
      $("doc-hash").textContent = hash;
      $("doc-size").textContent = S.docBytes.length.toLocaleString() + " bytes";
      $("doc-envelope").textContent = S.composed.json;
      $("doc-result").hidden = false;
      $("to-key").disabled = false;
    } catch (e) { err("doc-error", e.message); }
  });
  $("to-key").addEventListener("click", () => goto("key"));

  /* ---------- step 2: key (same shape as Etch) ---------- */
  $("network").addEventListener("change", (e) => {
    S.network = N.NETWORKS[e.target.value];
    if (!store.get("notary.blockbook")) { S.blockbook = S.network.blockbook; $("blockbook").value = S.blockbook; }
    S.wallet = null; renderKeyCard();
  });
  $("key-source").addEventListener("change", (e) => { $("key-input-wrap").hidden = e.target.value === "generate"; });
  $("new-key").addEventListener("click", () => {
    $("key-source").value = "generate"; $("key-input-wrap").hidden = true; makeKey();
  });
  function makeKey() {
    err("key-error", null);
    try {
      const src = $("key-source").value;
      let w, mnemonic = null;
      if (src === "generate") { mnemonic = N.newMnemonic(); w = N.walletFromMnemonic(mnemonic, S.network); }
      else if (src === "mnemonic") { mnemonic = $("key-input").value.trim(); w = N.walletFromMnemonic(mnemonic, S.network); }
      else { w = N.walletFromWIF($("key-input").value.trim(), S.network); }
      S.wallet = w; S.mnemonic = mnemonic;
      renderKeyCard();
      $("to-commit").disabled = false;
    } catch (e) { err("key-error", e.message); }
  }
  $("make-key").addEventListener("click", makeKey);
  function renderKeyCard() {
    const c = $("key-card");
    if (!S.wallet) { c.hidden = true; return; }
    c.hidden = false;
    $("key-address").textContent = S.wallet.address;
    const m = $("key-mnemonic");
    m.textContent = S.mnemonic || "(imported key — no mnemonic stored)";
    m.classList.remove("shown");
  }
  $("reveal-mnemonic").addEventListener("click", () => $("key-mnemonic").classList.toggle("shown"));
  $("blockbook").value = S.blockbook;
  $("blockbook").addEventListener("change", (e) => { S.blockbook = e.target.value.trim(); store.set("notary.blockbook", S.blockbook); });
  $("to-commit").addEventListener("click", () => { goto("commit"); refreshCommitPlan(); });

  /* ---------- step 3: commit ---------- */
  function refreshCommitPlan() {
    err("commit-error", null);
    try {
      S.plan = N.planNotarization({
        network: S.network, internalXOnly: S.wallet.internalXOnly,
        notary: S.composed, ownerAddress: S.wallet.address,
        changeAddress: S.wallet.address, feeRate: S.feeRate,
      });
      const p = S.plan;
      $("commit-plan").hidden = false;
      $("commit-plan").innerHTML = `
        <div class="prow"><span class="k">Commit address</span><code>${p.commitAddress}</code></div>
        <div class="prow"><span class="k">Envelope</span><code>prl-notary</code> — SHA-256 <code>${S.composed.fields.hash.slice(0, 20)}…</code></div>
        <div class="prow"><span class="k">Commit must fund</span>${fmtPRL(p.commitValue)} <span class="hint">(owner output ${fmtPRL(1000)} + ~${fmtPRL(p.revealFee)} reveal fee)</span></div>
        <div class="prow"><span class="k">Leaf hash</span><code>${p.leafHash.slice(0, 32)}…</code></div>`;
      updateCommitButton();
    } catch (e) { err("commit-error", e.message); }
  }
  function parsePastedUtxos(text) {
    return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [txid, vout, value] = l.split(":");
      if (!/^[0-9a-f]{64}$/i.test(txid || "")) throw new Error("bad txid: " + l);
      const voutN = Number(vout);
      if (!/^\d+$/.test(vout || "") || !Number.isSafeInteger(voutN)) throw new Error("bad vout (must be a non-negative integer): " + l);
      const valueN = Number(value);
      if (!/^\d+$/.test(value || "") || !Number.isSafeInteger(valueN) || valueN <= 0) throw new Error("bad value (must be a positive integer number of grains): " + l);
      return { txid: txid.toLowerCase(), vout: voutN, value: valueN };
    });
  }
  function renderUtxos() {
    $("utxo-list").innerHTML = S.utxos.map((u) =>
      `<div class="u"><code>${u.txid.slice(0, 16)}…:${u.vout}</code><span>${fmtPRL(u.value)}</span></div>`).join("");
    updateCommitButton();
  }
  function selectCoins(target) {
    const sorted = [...S.utxos].sort((a, b) => a.value - b.value);
    const picked = []; let sum = 0;
    const feePad = 300 * S.feeRate;
    for (const u of sorted) {
      picked.push({ ...u, priv: S.wallet.priv, internalXOnly: S.wallet.internalXOnly });
      sum += u.value;
      if (picked.length >= 10) break;
      if (sum >= target + feePad) break;
    }
    return { picked, sum };
  }
  function updateCommitButton() { $("build-commit").disabled = !(S.plan && S.utxos.length > 0); }
  $("fetch-utxos").addEventListener("click", async () => {
    err("commit-error", null);
    try {
      if (!S.blockbook) throw new Error("Set a blockbook endpoint first.");
      const list = await N.fetchUtxos(S.blockbook, S.wallet.address);
      S.utxos = list.filter((u) => u.confirmations > 0 || list.length === 1);
      if (!S.utxos.length) throw new Error("No UTXOs found for " + S.wallet.address + " — fund it first.");
      renderUtxos();
    } catch (e) { err("commit-error", e.message); }
  });
  $("utxo-paste").addEventListener("change", (e) => {
    try { S.utxos = parsePastedUtxos(e.target.value); err("commit-error", null); renderUtxos(); }
    catch (ex) { err("commit-error", ex.message); }
  });
  const feeSlider = $("fee-slider");
  function setFee(r, silent) {
    S.feeRate = Math.max(1, Math.round(r));
    $("fee-readout").textContent = S.feeRate + " grains/vB";
    if (feeSlider.value != S.feeRate && +feeSlider.max >= S.feeRate) feeSlider.value = S.feeRate;
    if (!silent && $("step-commit").classList.contains("active") && S.wallet) refreshCommitPlan();
  }
  feeSlider.addEventListener("input", () => setFee(+feeSlider.value));
  $("fee-auto").addEventListener("click", async () => {
    try { const r = await N.fetchFeeRateGrainsPerVByte(S.blockbook); setFee(r); refreshCommitPlan(); }
    catch (e) { err("commit-error", "fee estimate failed: " + e.message); }
  });
  $("build-commit").addEventListener("click", () => {
    err("commit-error", null);
    try {
      const need = S.plan.commitValue;
      const { picked, sum } = selectCoins(need);
      if (sum < need) throw new Error(`Selected UTXOs cover ${fmtPRL(sum)} but the commit needs ${fmtPRL(need)}.`);
      const c = N.buildCommitTx({
        network: S.network, fundingInputs: picked,
        commitProgram: S.plan.commitProgram, commitValue: S.plan.commitValue,
        changeProgram: S.plan.changeProgram, feeRate: S.feeRate,
      });
      S.commit = c;
      $("commit-result").hidden = false;
      $("commit-txid").textContent = c.txid;
      $("commit-fee").textContent = fmtPRL(c.fee);
      $("commit-hex").value = c.hex;
      $("reveal-commit-txid").value = c.txid;
      $("to-reveal").disabled = false;
      err("commit-broadcast", null); $("commit-broadcast").hidden = true;
    } catch (e) { err("commit-error", e.message); }
  });
  $("copy-commit").addEventListener("click", () => navigator.clipboard.writeText($("commit-hex").value));
  $("broadcast-commit").addEventListener("click", async () => {
    try {
      const txid = await N.broadcastTx(S.blockbook, S.commit.hex);
      const b = $("commit-broadcast"); b.hidden = false;
      b.textContent = "Commit broadcast accepted. txid: " + txid + " — wait for confirmation before revealing.";
    } catch (e) { err("commit-error", e.message); }
  });
  $("to-reveal").addEventListener("click", () => { goto("reveal"); renderRevealPlan(); });

  /* ---------- step 4: reveal ---------- */
  function renderRevealPlan() {
    const p = S.plan; if (!p) return;
    $("reveal-plan").hidden = false;
    $("reveal-plan").innerHTML = `
      <div class="prow"><span class="k">Spends</span><code>${esc(($("reveal-commit-txid").value || "").slice(0, 24))}…</code> via script path</div>
      <div class="prow"><span class="k">Output 0</span>${fmtPRL(p.ownerOutputs[0].value)} → <code>owner (inscription)</code></div>
      <div class="prow"><span class="k">Est. reveal fee</span>${fmtPRL(p.revealFee)} at ${p.feeRate} grains/vB</div>`;
  }
  $("detect-commit").addEventListener("click", async () => {
    err("reveal-error", null);
    try {
      const list = await N.fetchUtxos(S.blockbook, S.plan.commitAddress);
      if (!list.length) throw new Error("No UTXO at the commit address yet — wait for the commit to confirm.");
      $("reveal-commit-txid").value = list[0].txid;
      $("reveal-commit-vout").value = String(list[0].vout);
      renderRevealPlan();
    } catch (e) { err("reveal-error", e.message); }
  });
  $("build-reveal").addEventListener("click", () => {
    err("reveal-error", null);
    $("reveal-verify").hidden = true;
    try {
      const txid = $("reveal-commit-txid").value.trim();
      if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error("Enter the commit txid first.");
      const voutRaw = $("reveal-commit-vout").value.trim();
      if (!/^\d+$/.test(voutRaw) || !Number.isSafeInteger(Number(voutRaw))) throw new Error("commit vout must be a non-negative integer");
      const r = N.buildRevealTxSigned({
        plan: S.plan, commitTxid: txid, commitVout: Number(voutRaw),
        internalPriv: S.wallet.priv, changeAddress: S.wallet.address,
      });
      S.reveal = r;
      $("reveal-result").hidden = false;
      $("reveal-txid").textContent = r.txid;
      $("reveal-fee").textContent = fmtPRL(r.fee);
      $("reveal-hex").value = r.hex;
      $("to-seal").disabled = false;
      $("reveal-broadcast").hidden = true;
    } catch (e) { err("reveal-error", e.message); }
  });
  $("copy-reveal").addEventListener("click", () => navigator.clipboard.writeText($("reveal-hex").value));
  $("broadcast-reveal").addEventListener("click", async () => {
    try {
      const txid = await N.broadcastTx(S.blockbook, S.reveal.hex);
      const b = $("reveal-broadcast"); b.hidden = false;
      b.textContent = "Reveal broadcast accepted. txid: " + txid;
    } catch (e) { err("reveal-error", e.message); }
  });
  $("verify-reveal").addEventListener("click", () => {
    try {
      const v = N.verifyNotarizationWitness(S.reveal.hex, S.docBytes);
      const el = $("reveal-verify"); el.hidden = false;
      el.innerHTML = v.match
        ? `<b>✓ Envelope parses exactly as an indexer would, and the document hash matches the sealed fingerprint.</b>`
        : `<b>✗ Envelope parses, but the document does NOT match the sealed fingerprint.</b>`;
    } catch (e) { err("reveal-error", "witness parse failed: " + e.message); }
  });
  $("to-seal").addEventListener("click", () => { goto("seal"); renderSeal(); });

  /* ---------- step 5: seal ---------- */
  function renderSeal() {
    S.cert = N.buildSealCertificate({
      plan: S.plan,
      commitTxid: S.commit ? S.commit.txid : $("reveal-commit-txid").value.trim(),
      revealTxid: S.reveal.txid, blockHeight: null, blockTime: null,
    });
    const c = S.cert, r = c.record;
    $("seal-body").innerHTML = `
      <div class="prow"><span class="k">Document</span><code>${esc(r.filename)}</code> (${r.size.toLocaleString()} bytes)</div>
      ${r.title ? `<div class="prow"><span class="k">Title</span>${esc(r.title)}</div>` : ""}
      ${r.by ? `<div class="prow"><span class="k">Notarized by</span>${esc(r.by)}</div>` : ""}
      <div class="prow"><span class="k">SHA-256</span><code>${r.hash}</code></div>
      <div class="prow"><span class="k">Sealed at</span>${esc(r.ts)}</div>
      <div class="prow"><span class="k">Reveal tx</span><code>${c.reveal.txid}</code></div>
      <div class="prow"><span class="k">Commit tx</span><code>${c.commit.txid}</code></div>
      <div class="prow"><span class="k">Network</span>${esc(c.network)}</div>
      <div class="prow"><span class="k">Block</span><span id="seal-block">not confirmed yet</span></div>`;
  }
  $("lookup-block").addEventListener("click", async () => {
    err("seal-error", null);
    try {
      const base = S.blockbook.replace(/\/+$/, "");
      const r = await fetch(`${base}/api/v2/tx/${S.reveal.txid}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const tx = await r.json();
      S.cert.reveal.blockHeight = tx.blockHeight ?? null;
      S.cert.reveal.blockTime = tx.blockTime ?? null;
      $("seal-block").textContent = tx.blockHeight != null
        ? `height ${tx.blockHeight} (${tx.confirmations ?? 0} confirmations)`
        : "still unconfirmed";
    } catch (e) { err("seal-error", "lookup failed: " + e.message); }
  });
  $("copy-cert").addEventListener("click", () => navigator.clipboard.writeText(JSON.stringify(S.cert, null, 2)));
  $("download-cert").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(S.cert, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pearl-notary-${S.reveal.txid.slice(0, 12)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("print-cert").addEventListener("click", () => window.print());
  $("restart").addEventListener("click", () => location.reload());

  /* ---------- verify tab ---------- */
  let vDocBytes = null;
  $("v-blockbook").value = S.blockbook;
  const vdz = $("v-dropzone");
  vdz.addEventListener("click", (e) => { if (e.target.tagName !== "INPUT") $("v-file-input").click(); });
  vdz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("v-file-input").click(); } });
  vdz.addEventListener("dragover", (e) => { e.preventDefault(); vdz.classList.add("over"); });
  vdz.addEventListener("dragleave", () => vdz.classList.remove("over"));
  vdz.addEventListener("drop", async (e) => {
    e.preventDefault(); vdz.classList.remove("over");
    const f = e.dataTransfer.files[0]; if (!f) return;
    try { ({ bytes: vDocBytes } = await readFile(f)); err("v-error", null); vdz.querySelector(".dz-main").textContent = "Document loaded: " + f.name; }
    catch (ex) { err("v-error", ex.message); }
  });
  $("v-file-input").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { ({ bytes: vDocBytes } = await readFile(f)); err("v-error", null); }
    catch (ex) { err("v-error", ex.message); }
  });
  $("v-text").addEventListener("input", (e) => {
    vDocBytes = e.target.value ? new TextEncoder().encode(e.target.value) : null;
  });
  $("v-run").addEventListener("click", async () => {
    err("v-error", null);
    $("v-result").hidden = true;
    try {
      const txid = $("v-txid").value.trim();
      const bb = $("v-blockbook").value.trim();
      if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error("Enter a valid reveal txid.");
      if (!vDocBytes || vDocBytes.length === 0) throw new Error("Provide the document to check.");
      if (!bb) throw new Error("Set a blockbook endpoint.");
      const v = await N.verifyNotarizationOnChain(bb, txid, vDocBytes);
      const r = $("v-result"); r.hidden = false;
      r.innerHTML = v.match
        ? `<div class="prow"><span class="k">Verdict</span><b style="color:#2f7a2f">✓ MATCH — this document was sealed on Pearl.</b></div>`
        : `<div class="prow"><span class="k">Verdict</span><b style="color:#a33327">✗ MISMATCH — this document does not match the sealed fingerprint.</b></div>`
        + `<div class="prow"><span class="k">Sealed hash</span><code>${v.record.hash}</code></div>`
        + `<div class="prow"><span class="k">Document hash</span><code>${v.hash}</code></div>`
        + `<div class="prow"><span class="k">Block</span>${v.blockHeight != null ? "height " + v.blockHeight + " (" + v.confirmations + " confirmations)" : "unconfirmed"}</div>`
        + `<div class="prow"><span class="k">Filename</span><code>${esc(v.record.filename)}</code></div>`
        + (v.record.title ? `<div class="prow"><span class="k">Title</span>${esc(v.record.title)}</div>` : "");
    } catch (e) { err("v-error", e.message); }
  });

  /* ---------- footer ---------- */
  $("copy-donate").addEventListener("click", () => navigator.clipboard.writeText(DONATE));

  setFee(5, true);
})();
