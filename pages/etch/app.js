/* Pearl Etch UI — 5-step inscription wizard. All signing happens via the
 * window.PearlEtch bundle (audited crypto); this file is pure UI wiring. */
(() => {
  "use strict";
  const E = window.PearlEtch;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-etch.bundle.js</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  /* storage that survives hostile localStorage (Gallery lesson) */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return this.m?.[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { (this.m ??= {})[k] = v; } },
  };

  const S = {
    op: "mint", batch: [],
    network: E.NETWORKS.mainnet, wallet: null, mnemonic: null,
    blockbook: store.get("etch.blockbook") || E.NETWORKS.mainnet.blockbook,
    feeRate: 5, utxos: [], plan: null, commit: null, reveal: null,
  };

  const fmtPRL = (g) => {
/* BigInt-exact (pool float-format class): the old float format
     * silently rounds grain counts past Number.MAX_SAFE_INTEGER.
     * Integer string/BigInt grain counts format exactly; anything
     * else keeps the legacy float rendering. */
    const s = typeof g === "bigint" ? g.toString() : String(g).trim();
    if (!/^-?\d+$/.test(s)) return (Number(g) / E.GRAIN_PER_PRL).toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0") + " PRL";
    const b = BigInt(s), neg = b < 0n, a = neg ? -b : b;
    const w = (a / 100000000n).toString();
    const f = (a % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + w + "." + (f || "0") + " PRL";
  };
  /* clipboard that never throws: file:// and denied permissions fall back
   * to a manual-select copy, with an honest label either way */
  function copyText(text, btn) {
    const flash = (ok) => {
      if (!btn) return;
      const orig = btn.dataset.orig || (btn.dataset.orig = btn.textContent);
      btn.textContent = ok ? "copied" : "copy failed — select manually";
      setTimeout(() => { btn.textContent = orig; }, 1600);
    };
    const legacy = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand("copy");
        ta.remove(); flash(!!ok);
      } catch { flash(false); }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => flash(true), legacy);
        return;
      }
    } catch { /* fall through to legacy */ }
    legacy();
  }
  const err = (id, msg) => { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- step navigation ---------- */
  const steps = ["compose", "key", "commit", "reveal", "done"];
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

  /* ---------- step 1: compose ---------- */
  const FIELDS = {
    deploy: [
      ["tick", "Ticker (1–16 letters/digits)", "pearl"],
      ["max", "Max supply (integer string)", "21000000"],
      ["lim", "Mint limit per mint", "1000"],
      ["dec", "Decimals (0–18)", "8"],
    ],
    mint: [
      ["tick", "Ticker", "prls"],
      ["amt", "Amount (integer string)", "100000"],
    ],
    transfer: [
      ["tick", "Ticker", "prls"],
      ["amt", "Amount (integer string)", "100000"],
    ],
  };
  function renderOpForm() {
    document.querySelectorAll(".op-card").forEach((c) => c.classList.toggle("selected", c.dataset.op === S.op));
    $("op-form").innerHTML = FIELDS[S.op].map(([k, label, ph]) =>
      `<label>${esc(label)}<input data-field="${k}" value="${esc(ph)}"></label>`).join("");
  }
  document.querySelectorAll(".op-card").forEach((c) => c.addEventListener("click", () => { S.op = c.dataset.op; renderOpForm(); err("op-error", null); }));
  $("preset-prls").addEventListener("click", () => {
    if (S.op === "deploy") {
      document.querySelector('[data-field="tick"]').value = "prls";
      document.querySelector('[data-field="max"]').value = "2100000000";
      document.querySelector('[data-field="lim"]').value = "100000";
      document.querySelector('[data-field="dec"]').value = "18";
    } else {
      document.querySelector('[data-field="tick"]').value = "prls";
      document.querySelector('[data-field="amt"]').value = "100000";
    }
  });
  const fieldVals = () => Object.fromEntries([...document.querySelectorAll("#op-form [data-field]")].map((i) => [i.dataset.field, i.value.trim()]));
  $("add-op").addEventListener("click", () => {
    try {
      const env = E.composeOperation(S.op, fieldVals());
      S.batch.push(env);
      err("op-error", null);
      renderBatch();
    } catch (e) { err("op-error", "Invalid operation: " + e.message); }
  });
  function renderBatch() {
    $("batch-count").textContent = S.batch.length;
    $("batch-list").innerHTML = S.batch.map((b, i) =>
      `<li><span><span class="tag">${b.op}</span> <code>${esc(b.json)}</code></span><button class="btn tiny ghost" data-rm="${i}">remove</button></li>`).join("");
    document.querySelectorAll("[data-rm]").forEach((x) => x.addEventListener("click", () => { S.batch.splice(+x.dataset.rm, 1); renderBatch(); }));
    $("to-key").disabled = S.batch.length === 0;
  }
  $("to-key").addEventListener("click", () => goto("key"));

  /* ---------- step 2: key ---------- */
  $("network").addEventListener("change", (e) => {
    S.network = E.NETWORKS[e.target.value];
    if (!store.get("etch.blockbook")) { S.blockbook = S.network.blockbook; $("blockbook").value = S.blockbook; }
    S.wallet = null; renderKeyCard(); // key is network-specific; re-create below
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
      if (src === "generate") { mnemonic = E.newMnemonic(); w = E.walletFromMnemonic(mnemonic, S.network); }
      else if (src === "mnemonic") { mnemonic = $("key-input").value.trim(); w = E.walletFromMnemonic(mnemonic, S.network); }
      else { w = E.walletFromWIF($("key-input").value.trim(), S.network); }
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
  $("blockbook").addEventListener("change", (e) => { S.blockbook = e.target.value.trim(); store.set("etch.blockbook", S.blockbook); });
  $("to-commit").addEventListener("click", () => { goto("commit"); refreshCommitPlan(); });

  /* ---------- step 3: commit ---------- */
  function refreshCommitPlan() {
    err("commit-error", null);
    try {
      S.plan = E.planInscription({
        network: S.network, internalXOnly: S.wallet.internalXOnly,
        ops: S.batch.map((b) => ({ op: b.op, params: JSON.parse(b.json) })),
        ownerAddress: S.wallet.address, changeAddress: S.wallet.address, feeRate: S.feeRate,
      });
      const p = S.plan;
      $("commit-plan").hidden = false;
      $("commit-plan").innerHTML = `
        <div class="prow"><span class="k">Commit address</span><code>${p.commitAddress}</code></div>
        <div class="prow"><span class="k">Envelopes</span>${p.envelopes.length} × prl-20 (${p.envelopes.map((e) => e.op).join(", ")})</div>
        <div class="prow"><span class="k">Reveal outputs</span>${p.ownerOutputs.length} owner + ${p.feeOutputs.length} PRLS fee</div>
        ${p.prlsMints ? `<div class="prow"><span class="k">PRLS launch fee</span>${fmtPRL(p.prlsMints * 100000000)} → <code>${E.PRLS_FEE_RECIPIENT.slice(0, 20)}…</code></div>` : ""}
        ${p.prlsFeeNote ? `<div class="prow"><span class="k">Note</span>${esc(p.prlsFeeNote)}</div>` : ""}
        <div class="prow"><span class="k">Commit must fund</span>${fmtPRL(p.commitValue)} <span class="hint">(outputs + ~${fmtPRL(p.revealFee)} reveal fee)</span></div>
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
    const feePad = 300 * S.feeRate; // generous headroom; buildCommitTx re-validates exactly
    for (const u of sorted) {
      picked.push({ ...u, priv: S.wallet.priv, internalXOnly: S.wallet.internalXOnly });
      sum += u.value;
      if (picked.length >= 10) break;
      if (sum >= target + feePad) break;
    }
    return { picked, sum };
  }
  function updateCommitButton() {
    $("build-commit").disabled = !(S.plan && S.utxos.length > 0);
  }
  $("fetch-utxos").addEventListener("click", async () => {
    err("commit-error", null);
    try {
      if (!S.wallet) throw new Error("Create a key first (step 2).");
      if (!S.blockbook) throw new Error("Set a blockbook endpoint first.");
      const list = await E.fetchUtxos(S.blockbook, S.wallet.address);
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
    try {
      const r = await E.fetchFeeRateGrainsPerVByte(S.blockbook);
      setFee(r); refreshCommitPlan();
    } catch (e) { err("commit-error", "fee estimate failed: " + e.message); }
  });
  $("build-commit").addEventListener("click", () => {
    err("commit-error", null);
    try {
      if (!S.wallet) throw new Error("Create a key first (step 2).");
      const need = S.plan.commitValue;
      const { picked, sum } = selectCoins(need);
      if (sum < need) throw new Error(`Selected UTXOs cover ${fmtPRL(sum)} but the commit needs ${fmtPRL(need)}.`);
      const c = E.buildCommitTx({
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
  $("copy-commit").addEventListener("click", (e) => copyText($("commit-hex").value, e.currentTarget));
  $("broadcast-commit").addEventListener("click", async () => {
    try {
      const txid = await E.broadcastTx(S.blockbook, S.commit.hex);
      const b = $("commit-broadcast"); b.hidden = false;
      b.textContent = "Commit broadcast accepted. txid: " + txid + " — wait for confirmation before revealing.";
    } catch (e) { err("commit-error", e.message); }
  });
  $("to-reveal").addEventListener("click", () => { goto("reveal"); renderRevealPlan(); });

  /* ---------- step 4: reveal ---------- */
  function renderRevealPlan() {
    const p = S.plan; if (!p) return;
    $("reveal-plan").hidden = false;
    const outs = [...p.ownerOutputs, ...p.feeOutputs].map((o, i) =>
      `<div class="prow"><span class="k">Output ${i}</span>${fmtPRL(o.value)} → <code>${o === p.feeOutputs[0] ? "PRLS fee recipient" : "owner (inscription)"}</code></div>`).join("");
    $("reveal-plan").innerHTML = `
      <div class="prow"><span class="k">Spends</span><code>${esc($("reveal-commit-txid").value || "(commit txid)")}…</code> via script path</div>
      ${outs}
      <div class="prow"><span class="k">Est. reveal fee</span>${fmtPRL(p.revealFee)} at ${p.feeRate} grains/vB</div>`;
  }
  $("detect-commit").addEventListener("click", async () => {
    err("reveal-error", null);
    try {
      const list = await E.fetchUtxos(S.blockbook, S.plan.commitAddress);
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
      const r = E.buildRevealTxSigned({
        plan: S.plan, commitTxid: txid, commitVout: Number(voutRaw),
        internalPriv: S.wallet.priv, changeAddress: S.wallet.address,
      });
      S.reveal = r;
      $("reveal-result").hidden = false;
      $("reveal-txid").textContent = r.txid;
      $("reveal-fee").textContent = fmtPRL(r.fee);
      $("reveal-hex").value = r.hex;
      $("to-done").disabled = false;
      $("reveal-broadcast").hidden = true;
    } catch (e) { err("reveal-error", e.message); }
  });
  $("copy-reveal").addEventListener("click", (e) => copyText($("reveal-hex").value, e.currentTarget));
  $("broadcast-reveal").addEventListener("click", async () => {
    try {
      const txid = await E.broadcastTx(S.blockbook, S.reveal.hex);
      const b = $("reveal-broadcast"); b.hidden = false;
      b.textContent = "Reveal broadcast accepted. txid: " + txid;
    } catch (e) { err("reveal-error", e.message); }
  });
  $("verify-reveal").addEventListener("click", () => {
    try {
      const envs = E.verifyRevealWitness(S.reveal.hex);
      const v = $("reveal-verify"); v.hidden = false;
      v.innerHTML = `<b>✓ ${envs.length} envelope(s) parse exactly as an indexer would:</b><pre>${esc(envs.map((e) => e.bodyText).join("\n"))}</pre>`;
    } catch (e) { err("reveal-error", "witness parse failed: " + e.message); }
  });
  $("to-done").addEventListener("click", () => {
    goto("done");
    const p = S.plan;
    $("done-summary").innerHTML = `
      <div class="prow"><span class="k">Operations</span>${p.envelopes.map((e) => `<code>${esc(e.json)}</code>`).join("<br>")}</div>
      <div class="prow"><span class="k">Commit</span><code>${S.commit ? S.commit.txid : esc($("reveal-commit-txid").value)}</code></div>
      <div class="prow"><span class="k">Reveal</span><code>${S.reveal.txid}</code></div>
      <div class="prow"><span class="k">Network</span>${p.network.label}</div>
      <p class="hint">Track the reveal in Pearl Gallery (inscription wall) or the block explorer once confirmed.</p>`;
  });
  $("restart").addEventListener("click", () => location.reload());

  /* ---------- footer ---------- */
  $("copy-donate").addEventListener("click", (e) => copyText(DONATE, e.currentTarget));

  renderOpForm();
  setFee(5, true);
})();
