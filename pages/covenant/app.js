/* Pearl Covenant — browser UI (classic script, window.PearlCovenant bundle). */
(function () {
  "use strict";
  const E = window.PearlCovenant;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Pearl Covenant failed to load.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* storage that survives hostile localStorage (Gallery lesson) */
  const store = {
    m: {},
    get(k) { try { return localStorage.getItem(k); } catch { return this.m[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { this.m[k] = v; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: "",
    covenant: null,
    secrets: new Map(), // xonlyHex -> privHex, in memory only, never persisted
    utxos: [],
    selectedUtxo: null,
    round: null,        // normalized round object (sign step)
    roundCovenant: null,
    builtRound: null,   // last round built in the spend step
  };

  function showErr(id, msg) { const e = $(id); e.textContent = msg; e.hidden = false; }
  function hideErr(id) { $(id).hidden = true; }
  function fmtPRL(grains) {
/* BigInt-exact (pool float-format class): the old float format
     * silently rounds grain counts past Number.MAX_SAFE_INTEGER.
     * Integer string/BigInt grain counts format exactly; anything
     * else keeps the legacy float rendering. */
    const s = typeof grains === "bigint" ? grains.toString() : String(grains).trim();
    if (!/^-?\d+$/.test(s)) return (Number(grains) / E.GRAIN_PER_PRL).toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0");
    const b = BigInt(s), neg = b < 0n, a = neg ? -b : b;
    const w = (a / 100000000n).toString();
    const f = (a % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + w + "." + (f || "0");
  }
  function parsePRL(str) {
    // Exact parser: a float round-trip silently rounds sub-grain and
    // >8-decimal inputs (0.123456789 -> 12345679 grains). Parse the decimal
    // string with BigInt instead, like the core parser; refuse inexact input.
    const m = String(str).trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
    if (!m) throw new Error("amount must be a positive number");
    const g = BigInt(m[1]) * BigInt(E.GRAIN_PER_PRL) + BigInt((m[2] || "").padEnd(8, "0"));
    if (g <= 0n) throw new Error("amount must be a positive number");
    if (g > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount out of range");
    return Number(g);
  }

  /* ---------- step navigation ---------- */
  const stepBtns = [...document.querySelectorAll("#steps button")];
  function goto(step) {
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    $("step-" + step).classList.add("active");
    stepBtns.forEach((b) => b.classList.toggle("active", b.dataset.step === step));
    window.scrollTo(0, 0);
  }
  stepBtns.forEach((b) => b.addEventListener("click", () => goto(b.dataset.step)));
  function markDone(step) {
    const b = stepBtns.find((x) => x.dataset.step === step);
    if (b) b.classList.add("done");
  }

  /* ---------- QR ---------- */
  function renderQR(elId, text) {
    const el = $(elId);
    el.innerHTML = "";
    try {
      if (typeof window.qrcode === "undefined") throw new Error("qr lib missing");
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(4, 8);
    } catch (err) {
      el.innerHTML = "<p class='hint'>QR too large for this payload — use copy/download instead.</p>";
    }
  }

  /* ---------- copy buttons ---------- */
  document.querySelectorAll(".copy-btn").forEach((b) => b.addEventListener("click", async () => {
    const t = $(b.dataset.for);
    const txt = t.value !== undefined && t.tagName !== "CODE" ? t.value : t.textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; }
    catch { b.textContent = "Copy failed"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  }));

  /* ---------- network / blockbook ---------- */
  function applyNetwork() {
    S.network = E.NETWORKS[$("network").value] || E.NETWORKS.mainnet;
    if (!store.get("covenant.blockbook")) $("blockbook").value = S.network.blockbook;
    S.blockbook = $("blockbook").value.trim() || S.network.blockbook;
    $("blockbook").placeholder = S.network.blockbook || "https://…";
  }
  $("network").addEventListener("change", () => { store.set("covenant.blockbook", ""); applyNetwork(); });
  $("blockbook").addEventListener("change", () => {
    store.set("covenant.blockbook", $("blockbook").value.trim());
    S.blockbook = $("blockbook").value.trim() || S.network.blockbook;
  });

  /* ---------- covenant step ---------- */
  function buildThresholdSelects() {
    const nSel = $("n-select"), mSel = $("m-select");
    const nKeep = nSel.value, mKeep = mSel.value;
    nSel.innerHTML = "";
    for (let n = 1; n <= E.MAX_COSIGNERS; n++) {
      const o = document.createElement("option");
      o.value = String(n); o.textContent = String(n);
      if (String(n) === (nKeep || "3")) o.selected = true;
      nSel.appendChild(o);
    }
    renderCosignerFields();
  }
  function renderCosignerFields() {
    const n = parseInt($("n-select").value, 10);
    const mSel = $("m-select"), mRaw = parseInt(mSel.value, 10);
    const mDef = Number.isInteger(mRaw) ? mRaw : Math.min(2, n);
    mSel.innerHTML = "";
    for (let m = 1; m <= n; m++) {
      const o = document.createElement("option");
      o.value = String(m); o.textContent = String(m) + "-of-" + n;
      if (m === Math.min(mDef, n)) o.selected = true;
      mSel.appendChild(o);
    }
    const wrap = $("cosigner-fields");
    wrap.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const card = document.createElement("div");
      card.className = "party-card";
      card.innerHTML =
        "<h3>Cosigner " + (i + 1) + "</h3>" +
        "<textarea id=\"ckey-" + i + "\" rows=\"2\" spellcheck=\"false\" aria-label=\"Cosigner " + (i + 1) + " key\" " +
        "placeholder=\"64-hex x-only pubkey or 12/24-word mnemonic\"></textarea>" +
        "<div class=\"row\"><button class=\"btn ghost gen-key\" data-for=\"ckey-" + i + "\">Generate fresh key</button>" +
        "<span class=\"key-ok\" id=\"ok-" + i + "\"></span></div>";
      wrap.appendChild(card);
    }
    wrap.querySelectorAll(".gen-key").forEach((b) => b.addEventListener("click", () => {
      const mn = E.newMnemonic(128);
      $(b.dataset.for).value = mn;
      const idx = b.dataset.for.split("-")[1];
      const okEl = $("ok-" + idx);
      if (okEl) okEl.textContent = "fresh mnemonic — back it up, it will not be shown again";
    }));
  }
  $("n-select").addEventListener("change", renderCosignerFields);

  function renderCovenantPreview() {
    const c = S.covenant;
    $("covenant-preview").hidden = false;
    $("cov-address").textContent = c.address;
    $("cov-descriptor").textContent = E.covenantDescriptor(c);
    $("cov-asm").textContent = c.scriptAsm;
    renderQR("cov-qr", c.address);
    $("cov-keys-table").innerHTML = c.keys.map((k, i) =>
      "<tr><td>" + (i + 1) + "</td><td><code>" + esc(k.xonly) + "</code></td>" +
      "<td>" + esc(k.source) + "</td>" +
      "<td>" + (k.hasPriv
        ? "<span class=\"badge\">key on this device</span>"
        : "<span class=\"badge dim\">pubkey only</span>") + "</td></tr>").join("");
    // vault step mirrors
    $("vault-address").textContent = c.address;
    renderQR("vault-qr", c.address);
    markDone("covenant");
  }

  $("forge-btn").addEventListener("click", () => {
    hideErr("forge-error");
    try {
      applyNetwork();
      const n = parseInt($("n-select").value, 10);
      const m = parseInt($("m-select").value, 10);
      const inputs = [];
      for (let i = 0; i < n; i++) {
        const v = $("ckey-" + i).value.trim();
        if (!v) throw new Error("cosigner " + (i + 1) + ": key is empty");
        inputs.push(v);
      }
      const { covenant, secrets } = E.createCovenant({ m, keyInputs: inputs, network: S.network });
      S.covenant = covenant;
      S.secrets = new Map(secrets.map((s) => [s.xonly, s.priv]));
      renderCovenantPreview();
    } catch (err) { showErr("forge-error", err.message); }
  });

  $("save-covenant").addEventListener("click", () => {
    if (!S.covenant) return;
    store.set("covenant.descriptor", E.covenantDescriptor(S.covenant));
    store.set("covenant.network", S.network.id);
    $("save-covenant").textContent = "Saved ✓";
    setTimeout(() => { $("save-covenant").textContent = "Save covenant on this device"; }, 1500);
  });

  function loadDescriptor(d) {
    applyNetwork();
    const c = E.covenantFromDescriptor(d, S.network);
    S.covenant = c;
    S.secrets = new Map(); // secrets are never persisted
    renderCovenantPreview();
  }
  $("load-btn").addEventListener("click", () => {
    hideErr("forge-error");
    try { loadDescriptor($("descriptor-input").value); }
    catch (err) { showErr("forge-error", err.message); }
  });

  /* ---------- vault step ---------- */
  function renderUtxos() {
    const tb = $("utxo-rows");
    if (!S.utxos.length) {
      tb.innerHTML = "<tr><td colspan=\"5\" class=\"hint\">No UTXOs loaded yet.</td></tr>";
      $("vault-balance").textContent = "";
      return;
    }
    tb.innerHTML = "";
    const total = S.utxos.reduce((a, u) => a + u.value, 0);
    $("vault-balance").textContent = "Balance: " + fmtPRL(total) + " PRL";
    S.utxos.forEach((u, i) => {
      const tr = document.createElement("tr");
      if (S.selectedUtxo === u) tr.className = "selected";
      tr.innerHTML =
        "<td><input type=\"radio\" name=\"utxo\" " + (S.selectedUtxo === u ? "checked" : "") + " data-i=\"" + i + "\"></td>" +
        "<td><code>" + esc(u.txid.slice(0, 16)) + "…" + esc(u.txid.slice(-8)) + "</code></td>" +
        "<td>" + u.vout + "</td><td>" + fmtPRL(u.value) + "</td><td>" + (u.confirmations ?? "?") + "</td>";
      tr.querySelector("input").addEventListener("change", (ev) => {
        S.selectedUtxo = S.utxos[parseInt(ev.target.dataset.i, 10)];
        $("spend-utxo-btn").disabled = false;
        renderUtxos();
      });
      tb.appendChild(tr);
    });
  }

  $("refresh-utxos").addEventListener("click", async () => {
    hideErr("vault-error");
    try {
      if (!S.covenant) throw new Error("forge or load a covenant first");
      applyNetwork();
      if (!S.blockbook) throw new Error("no Blockbook endpoint configured for " + S.network.label);
      $("refresh-utxos").disabled = true;
      $("refresh-utxos").textContent = "Loading…";
      S.utxos = await E.fetchUtxos(S.blockbook, S.covenant.address);
      S.selectedUtxo = null;
      $("spend-utxo-btn").disabled = true;
      renderUtxos();
      if (!S.utxos.length) showErr("vault-error", "No UTXOs found — fund the vault address first.");
    } catch (err) { showErr("vault-error", err.message); }
    finally { $("refresh-utxos").disabled = false; $("refresh-utxos").textContent = "Refresh UTXOs"; }
  });

  $("add-utxo").addEventListener("click", () => {
    hideErr("vault-error");
    try {
      const txid = $("m-txid").value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("txid must be 64 hex characters");
      const voutRaw = $("m-vout").value.trim();
      if (!/^\d+$/.test(voutRaw)) throw new Error("bad vout");
      const vout = Number(voutRaw);
      if (!Number.isSafeInteger(vout) || vout < 0) throw new Error("bad vout");
      const value = parsePRL($("m-value").value);
      const u = { txid, vout, value, confirmations: "?" };
      if (S.utxos.some((x) => x.txid === txid && x.vout === vout)) throw new Error("UTXO already listed");
      S.utxos.push(u);
      S.selectedUtxo = u;
      $("spend-utxo-btn").disabled = false;
      renderUtxos();
    } catch (err) { showErr("vault-error", err.message); }
  });

  $("spend-utxo-btn").addEventListener("click", () => {
    if (!S.selectedUtxo) return;
    const u = S.selectedUtxo;
    $("spend-utxo-info").innerHTML = "Spending <code>" + esc(u.txid.slice(0, 16)) + "…:" + u.vout +
      "</code> — <strong>" + fmtPRL(u.value) + " PRL</strong>";
    goto("spend");
  });

  /* ---------- spend step ---------- */
  function addPaymentRow(addr, amt) {
    const div = document.createElement("div");
    div.className = "pay-row";
    div.innerHTML =
      "<label>Recipient (P2TR address)<input class=\"pay-addr\" spellcheck=\"false\" placeholder=\"prl1…\"></label>" +
      "<label>Amount (PRL)<input class=\"pay-amt\" type=\"number\" min=\"0\" step=\"any\"></label>" +
      "<button class=\"btn ghost rm-pay\">✕</button>";
    if (addr) div.querySelector(".pay-addr").value = addr;
    if (amt) div.querySelector(".pay-amt").value = amt;
    div.querySelector(".rm-pay").addEventListener("click", () => div.remove());
    $("payments").appendChild(div);
  }
  $("add-payment").addEventListener("click", () => addPaymentRow());

  $("fee-estimate-btn").addEventListener("click", async () => {
    hideErr("round-error");
    try {
      applyNetwork();
      if (!S.blockbook) throw new Error("no Blockbook endpoint configured");
      const r = await E.fetchFeeRateGrainsPerVByte(S.blockbook, 2);
      $("fee-rate").value = Math.max(1, Math.ceil(r));
    } catch (err) { showErr("round-error", err.message); }
  });

  function renderRoundSummary(round, covenant) {
    const d = E.describeRound(round, covenant);
    $("round-summary").innerHTML =
      "<div class=\"krow\"><dt>Covenant</dt><dd>" + esc(d.covenant) + " · <code>" +
      esc(round.covenant.slice(0, 40)) + "…</code></dd></div>" +
      "<div class=\"krow\"><dt>Input</dt><dd><code>" + esc(d.input) + "</code></dd></div>" +
      d.outputs.map((o) => "<div class=\"krow\"><dt>" + (o.change ? "Change" : "Payment") +
        "</dt><dd><code>" + esc(o.address) + "</code> — " + esc(o.value) + " PRL</dd></div>").join("") +
      "<div class=\"krow\"><dt>Fee</dt><dd>" + esc(d.fee) + " PRL @ " + esc(String(d.feeRate)) +
        " grains/vB (" + round.vBytes + " vB)</dd></div>" +
      (d.memo ? "<div class=\"krow\"><dt>Memo</dt><dd>" + esc(d.memo) + "</dd></div>" : "") +
      "<div class=\"krow\"><dt>Digest</dt><dd><code>" + esc(round.digest) + "</code></dd></div>";
  }

  $("build-round").addEventListener("click", () => {
    hideErr("round-error");
    try {
      if (!S.covenant) throw new Error("forge or load a covenant first");
      if (!S.selectedUtxo) throw new Error("select a UTXO in the Vault step first");
      applyNetwork();
      const rows = [...document.querySelectorAll(".pay-row")];
      if (!rows.length) throw new Error("add at least one payment");
      const payments = rows.map((r) => {
        const address = r.querySelector(".pay-addr").value.trim();
        if (!address) throw new Error("a payment is missing its recipient address");
        return { address, valueGrains: parsePRL(r.querySelector(".pay-amt").value) };
      });
      const feeRate = Number($("fee-rate").value);
      if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error("bad fee rate");
      const round = E.buildSigningRound(S.covenant, S.network, {
        utxo: S.selectedUtxo,
        payments,
        feeRateGrainsPerVByte: feeRate,
        memo: $("memo").value,
      });
      S.builtRound = round;
      renderRoundSummary(round, S.covenant);
      $("round-json").value = E.serializeRound(round);
      renderQR("round-qr", E.serializeRound(round));
      $("round-out").hidden = false;
      markDone("spend");
    } catch (err) { showErr("round-error", err.message); }
  });

  $("download-round").addEventListener("click", () => {
    const blob = new Blob([$("round-json").value], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "covenant-round.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $("to-sign-btn").addEventListener("click", () => {
    $("sign-round-input").value = $("round-json").value;
    goto("sign");
  });

  /* ---------- sign step ---------- */
  function refreshSignKeySelect() {
    const sel = $("sign-key-select");
    sel.innerHTML = "<option value=\"\">Paste a key below…</option>";
    for (const [xonly] of S.secrets) {
      const o = document.createElement("option");
      o.value = xonly;
      o.textContent = xonly.slice(0, 16) + "… (on this device)";
      sel.appendChild(o);
    }
  }

  function renderSignStatus() {
    const r = S.round, c = S.roundCovenant;
    const st = E.roundStatus(r, c);
    const d = E.describeRound(r, c);
    $("round-status").innerHTML =
      "<div class=\"krow\"><dt>Covenant</dt><dd>" + esc(d.covenant) + "</dd></div>" +
      "<div class=\"krow\"><dt>Input</dt><dd><code>" + esc(d.input) + "</code></dd></div>" +
      d.outputs.map((o) => "<div class=\"krow\"><dt>" + (o.change ? "Change" : "Payment") +
        "</dt><dd><code>" + esc(o.address) + "</code> — " + esc(o.value) + " PRL</dd></div>").join("") +
      "<div class=\"krow\"><dt>Fee</dt><dd>" + esc(d.fee) + " PRL</dd></div>" +
      "<div class=\"krow\"><dt>Signers</dt><dd>" + (d.signers.length ? d.signers.map(esc).join(", ") : "none yet") + "</dd></div>";
    $("quorum-bar").style.width = Math.min(100, (st.have / st.need) * 100) + "%";
    $("quorum-label").textContent = "Quorum: " + st.have + " of " + st.need + " signatures" + (st.ready ? " — ready to finalize" : "");
    $("finalize-btn").disabled = !st.ready;
    // Keep the exportable round in sync: cosigners pass THIS json onward.
    $("sign-round-export").value = E.serializeRound(S.round);
  }

  $("verify-round").addEventListener("click", () => {
    hideErr("sign-error");
    try {
      applyNetwork();
      const r = E.parseRound($("sign-round-input").value, S.network);
      S.round = r;
      S.roundCovenant = E.covenantFromDescriptor(r.covenant, S.network);
      $("sign-work").hidden = false;
      $("final-out").hidden = true;
      refreshSignKeySelect();
      renderSignStatus();
      markDone("sign");
    } catch (err) { showErr("sign-error", err.message); }
  });

  function privFromInput(raw) {
    const t = String(raw || "").trim();
    if (/^[0-9a-fA-F]{64}$/.test(t)) return { priv: t.toLowerCase(), via: "hex private key" };
    const words = t.split(/\s+/);
    if (words.length === 12 || words.length === 24) {
      const w = E.walletFromMnemonic(t, S.network);
      return { priv: E.bytesToHex(w.priv), via: "mnemonic" };
    }
    throw new Error("key must be a 32-byte hex private key or a 12/24-word mnemonic");
  }

  $("sign-with-local").addEventListener("click", () => {
    hideErr("sign-error");
    try {
      if (!S.round) throw new Error("verify a round first");
      let priv;
      const sel = $("sign-key-select").value;
      if (sel) {
        priv = S.secrets.get(sel);
        if (!priv) throw new Error("key not on this device");
      } else {
        priv = privFromInput($("sign-key-input").value).priv;
      }
      E.signRound(S.round, S.roundCovenant, priv);
      $("sign-key-input").value = "";
      renderSignStatus();
    } catch (err) { showErr("sign-error", err.message); }
  });

  $("add-cosig").addEventListener("click", () => {
    hideErr("sign-error");
    try {
      if (!S.round) throw new Error("verify a round first");
      E.importSig(S.round, S.roundCovenant, $("cosig-key").value, $("cosig-sig").value);
      $("cosig-key").value = "";
      $("cosig-sig").value = "";
      renderSignStatus();
    } catch (err) { showErr("sign-error", err.message); }
  });

  $("download-signed-round").addEventListener("click", () => {
    const blob = new Blob([$("sign-round-export").value], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "covenant-round-signed.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $("finalize-btn").addEventListener("click", () => {
    hideErr("sign-error");
    try {
      if (!S.round) throw new Error("verify a round first");
      const spend = E.finalizeRound(S.round, S.roundCovenant, S.network);
      $("final-txid").textContent = spend.txid;
      $("final-hex").value = spend.hex;
      $("final-out").hidden = false;
      $("broadcast-ok").hidden = true;
      $("broadcast-error").hidden = true;
    } catch (err) { showErr("sign-error", err.message); }
  });

  $("broadcast-btn").addEventListener("click", async () => {
    $("broadcast-ok").hidden = true;
    $("broadcast-error").hidden = true;
    try {
      applyNetwork();
      if (!S.blockbook) throw new Error("no Blockbook endpoint configured");
      $("broadcast-btn").disabled = true;
      $("broadcast-btn").textContent = "Broadcasting…";
      const txid = await E.broadcastTx(S.blockbook, $("final-hex").value.trim());
      const ok = $("broadcast-ok");
      ok.textContent = "Broadcast accepted — txid " + txid;
      ok.hidden = false;
    } catch (err) {
      const e = $("broadcast-error");
      e.textContent = err.message;
      e.hidden = false;
    } finally {
      $("broadcast-btn").disabled = false;
      $("broadcast-btn").textContent = "Broadcast via Blockbook";
    }
  });

  /* ---------- init ---------- */
  buildThresholdSelects();
  applyNetwork();
  addPaymentRow();
  const saved = store.get("covenant.descriptor");
  if (saved) {
    try { loadDescriptor(saved); } catch { /* ignore stale saved descriptor */ }
  }
})();
