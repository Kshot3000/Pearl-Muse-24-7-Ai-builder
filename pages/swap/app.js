/* Pearl Swap — browser UI (classic script, window.PearlSwap bundle). */
(function () {
  "use strict";
  const E = window.PearlSwap;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Pearl Swap failed to load.</p>"; return; }

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
    swap: null,
    secrets: new Map(), // xonlyHex -> { priv, role }, in memory only, never persisted
    preimageHex: null,  // Alice's preimage, in memory only
    funder: null,       // { priv, internalXOnly, address }, in memory only
    lockUtxos: [],
    lockTx: null,
    claimTx: null,
    refundTx: null,
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
    /* Exact parser (core): the old Number()+Math.round float parse
     * silently rounded sub-grain amounts and accepted "0x10"/"1e3". */
    const g = E.parsePRLToGrains(str);
    if (g <= 0) throw new Error("PRL amount must be a positive number");
    return g;
  }
  function parseBTC(str) {
    /* Exact parser (core) — same class as parsePRL, in satoshis. */
    const s = E.parseBTCToSats(str);
    if (s <= 0) throw new Error("BTC amount must be a positive number");
    return s;
  }
  function parseHeight(str, name) {
    const v = Number(String(str).trim());
    if (!Number.isSafeInteger(v) || v <= 0) throw new Error(name + " must be a positive block height");
    return v;
  }
  function fmtEta(secs) {
    if (secs <= 0) return "reached";
    const h = Math.floor(secs / 3600), d = Math.floor(h / 24);
    if (d > 0) return `~${d}d ${h % 24}h`;
    if (h > 0) return `~${h}h ${Math.floor((secs % 3600) / 60)}m`;
    return `~${Math.floor(secs / 60)}m`;
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
    if (!store.get("swap.blockbook")) $("blockbook").value = S.network.blockbook;
    S.blockbook = $("blockbook").value.trim() || S.network.blockbook;
    $("blockbook").placeholder = S.network.blockbook || "https://…";
  }
  $("network").addEventListener("change", () => { store.set("swap.blockbook", ""); applyNetwork(); });
  $("blockbook").addEventListener("change", () => {
    store.set("swap.blockbook", $("blockbook").value.trim());
    S.blockbook = $("blockbook").value.trim() || S.network.blockbook;
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

  function requireBlockbook() {
    applyNetwork();
    if (!S.blockbook) throw new Error("no Blockbook endpoint configured for " + S.network.label);
    return S.blockbook;
  }

  async function fetchTipHeight() {
    const bb = requireBlockbook();
    const res = await fetch(bb.replace(/\/$/, "") + "/api/v2");
    if (!res.ok) throw new Error("blockbook " + res.status + " on /api/v2");
    const j = await res.json();
    const h = Number(j.backend && j.backend.blocks);
    if (!Number.isSafeInteger(h) || h <= 0) throw new Error("could not read chain tip from Blockbook");
    return h;
  }

  /* ---------- swap summary renderer (shared) ---------- */
  function renderSwapSummary(elId, swap) {
    const d = E.describeSwap(swap);
    let html =
      "<div class=\"krow\"><dt>Role</dt><dd>" + esc(d.role) + "</dd></div>" +
      "<div class=\"krow\"><dt>Swap address</dt><dd><code>" + esc(d.address) + "</code></dd></div>" +
      "<div class=\"krow\"><dt>Alice locks</dt><dd>" + esc(d.prl) + " PRL</dd></div>" +
      "<div class=\"krow\"><dt>Bob locks</dt><dd>" + esc(d.btc) + " (coordination only)</dd></div>" +
      "<div class=\"krow\"><dt>Secret hash H</dt><dd><code>" + esc(d.secretHash) + "</code></dd></div>" +
      "<div class=\"krow\"><dt>T1 / T2</dt><dd>" + d.t1 + " / " + d.t2 + " (gap " + d.gap + " blocks)</dd></div>" +
      "<div class=\"krow\"><dt>Descriptor</dt><dd><code>" + esc(d.descriptor) + "</code></dd></div>";
    if (swap.warnings && swap.warnings.length) {
      html += swap.warnings.map((w) => "<div class=\"warn\">⚠ " + esc(w) + "</div>").join("");
    }
    $(elId).innerHTML = html;
  }

  function renderWarnings(elId, swap) {
    const el = $(elId);
    if (!swap.warnings || !swap.warnings.length) { el.innerHTML = ""; return; }
    el.innerHTML = swap.warnings.map((w) =>
      "<div class=\"warn\">⚠ " + esc(w) + "</div>").join("");
  }

  /* ---------- STEP 1: PROPOSE ---------- */
  $("p-pre-gen").addEventListener("click", () => {
    const p = E.generatePreimage();
    $("p-pre").value = E.bytesToHex(p);
    $("p-hash").value = E.bytesToHex(E.secretHashOf(p));
    $("p-pre-warn").hidden = false;
  });
  $("p-pre").addEventListener("input", () => {
    const t = $("p-pre").value.trim();
    $("p-pre-warn").hidden = !t;
    if (/^[0-9a-fA-F]{64}$/.test(t)) {
      try { $("p-hash").value = E.bytesToHex(E.secretHashOf(E.hexToBytes(t.toLowerCase()))); } catch { /* typing */ }
    }
  });

  function renderProposeOut(swap) {
    renderSwapSummary("sw-summary", swap);
    renderWarnings("sw-warnings", swap);
    $("sw-address").textContent = swap.address;
    $("sw-descriptor").textContent = swap.descriptor;
    $("sw-json").value = E.serializeSwap(swap);
    $("sw-asm-claim").textContent = swap.claimAsm;
    $("sw-asm-refund").textContent = swap.refundAsm;
    renderQR("sw-qr", swap.address);
    $("propose-out").hidden = false;
    // carry to later steps
    $("lock-spec").value = E.serializeSwap(swap);
    $("track-spec").value = E.serializeSwap(swap);
    $("claim-spec").value = E.serializeSwap(swap);
    $("refund-spec").value = E.serializeSwap(swap);
    markDone("propose");
  }

  $("propose-btn").addEventListener("click", () => {
    hideErr("propose-error");
    try {
      applyNetwork();
      const role = $("p-role").value;
      const preimageHex = $("p-pre").value.trim() || null;
      const secretHashHex = $("p-hash").value.trim() || null;
      if (role === "alice" && !preimageHex) {
        throw new Error("Alice must generate (or paste) the preimage — it is revealed only when Bob claims");
      }
      const { swap, secrets } = E.proposeSwap({
        role,
        network: S.network,
        prlGrains: parsePRL($("p-prl").value),
        btcSats: parseBTC($("p-btc").value),
        preimageHex,
        secretHashHex,
        aliceKeyInput: $("p-alice-key").value,
        bobKeyInput: $("p-bob-key").value,
        t1: parseHeight($("p-t1").value, "T1"),
        t2: parseHeight($("p-t2").value, "T2"),
        feeRateGrainsPerVByte: Number($("p-fee").value),
      });
      S.swap = swap;
      S.secrets = new Map(secrets.map((s) => [s.xonly, s]));
      S.preimageHex = preimageHex ? preimageHex.toLowerCase() : null;
      renderProposeOut(swap);
    } catch (err) { showErr("propose-error", err.message); }
  });

  $("load-spec-btn").addEventListener("click", () => {
    hideErr("propose-error");
    try {
      applyNetwork();
      const swap = E.parseSwapSpec($("load-spec").value, S.network);
      S.swap = swap;
      S.secrets = new Map();
      renderProposeOut(swap);
    } catch (err) { showErr("propose-error", err.message); }
  });

  $("sw-download").addEventListener("click", () => {
    const blob = new Blob([$("sw-json").value], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pearl-swap-spec.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $("to-lock-btn").addEventListener("click", () => goto("lock"));

  /* ---------- STEP 2: LOCK ---------- */
  function loadSpecInto(textareaId, errId, summaryId, workId) {
    hideErr(errId);
    const swap = E.parseSwapSpec($(textareaId).value, S.network);
    S.swap = swap;
    if (summaryId) {
      renderSwapSummary(summaryId, swap);
      $(summaryId).hidden = false;
    }
    if (workId) $(workId).hidden = false;
    return swap;
  }

  $("lock-load-btn").addEventListener("click", () => {
    try {
      applyNetwork();
      loadSpecInto("lock-spec", "lock-error", "lock-summary", "lock-work");
      $("lock-fee").value = String(S.swap.feeRateGrainsPerVByte);
      markDone("lock");
    } catch (err) { showErr("lock-error", err.message); }
  });

  $("lock-derive-btn").addEventListener("click", () => {
    hideErr("lock-error");
    try {
      applyNetwork();
      const w = E.funderKeyFromInput($("lock-key").value, S.network);
      S.funder = { priv: w.priv, internalXOnly: w.internalXOnly, address: w.address };
      $("lock-address").textContent = w.address;
      $("lock-key").value = ""; // clear the secret from the field immediately
    } catch (err) { showErr("lock-error", err.message); }
  });

  function renderLockUtxos() {
    const tb = $("lock-utxo-rows");
    tb.innerHTML = "";
    if (!S.lockUtxos.length) {
      tb.innerHTML = "<tr><td colspan=\"5\" class=\"hint\">No UTXOs loaded yet.</td></tr>";
      $("lock-balance").textContent = "";
      return;
    }
    const total = S.lockUtxos.reduce((a, u) => a + u.value, 0);
    $("lock-balance").textContent = "Balance: " + fmtPRL(total) + " PRL";
    S.lockUtxos.forEach((u, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td><input type=\"checkbox\" data-i=\"" + i + "\"" + (u.selected ? " checked" : "") + "></td>" +
        "<td><code>" + esc(u.txid.slice(0, 16)) + "…" + esc(u.txid.slice(-8)) + "</code></td>" +
        "<td>" + u.vout + "</td><td>" + fmtPRL(u.value) + "</td><td>" + (u.confirmations ?? "?") + "</td>";
      tr.querySelector("input").addEventListener("change", (ev) => {
        S.lockUtxos[parseInt(ev.target.dataset.i, 10)].selected = ev.target.checked;
      });
      tb.appendChild(tr);
    });
  }

  $("lock-refresh").addEventListener("click", async () => {
    hideErr("lock-error");
    try {
      if (!S.funder) throw new Error("derive the funder address first");
      const bb = requireBlockbook();
      $("lock-refresh").disabled = true;
      $("lock-refresh").textContent = "Loading…";
      const list = await E.fetchUtxos(bb, S.funder.address);
      const spkHex = E.funderSpkHex(S.funder.internalXOnly);
      S.lockUtxos = list.map((u) => ({ ...u, spkHex, selected: true }));
      renderLockUtxos();
      if (!list.length) showErr("lock-error", "No UTXOs found — fund the funder address first.");
    } catch (err) { showErr("lock-error", err.message); }
    finally { $("lock-refresh").disabled = false; $("lock-refresh").textContent = "Refresh via Blockbook"; }
  });

  $("lock-add-utxo").addEventListener("click", () => {
    hideErr("lock-error");
    try {
      const txid = $("lock-m-txid").value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("txid must be 64 hex characters");
      const voutRaw = $("lock-m-vout").value.trim();
      if (!/^\d+$/.test(voutRaw)) throw new Error("bad vout");
      const vout = Number(voutRaw);
      if (!Number.isSafeInteger(vout) || vout < 0) throw new Error("bad vout");
      const value = parsePRL($("lock-m-value").value);
      const spkHex = $("lock-m-spk").value.trim().toLowerCase() || null;
      if (spkHex && !/^[0-9a-f]+$/.test(spkHex)) throw new Error("scriptPubKey must be hex");
      if (S.lockUtxos.some((x) => x.txid === txid && x.vout === vout)) throw new Error("UTXO already listed");
      S.lockUtxos.push({ txid, vout, value, confirmations: "?", spkHex, selected: true });
      renderLockUtxos();
    } catch (err) { showErr("lock-error", err.message); }
  });

  $("lock-fee-btn").addEventListener("click", async () => {
    hideErr("lock-error");
    try {
      const bb = requireBlockbook();
      const r = await E.fetchFeeRateGrainsPerVByte(bb, 2);
      $("lock-fee").value = Math.max(1, Math.ceil(r));
    } catch (err) { showErr("lock-error", err.message); }
  });

  $("lock-build-btn").addEventListener("click", () => {
    hideErr("lock-error");
    try {
      if (!S.swap) throw new Error("load the swap spec first");
      if (!S.funder) throw new Error("derive the funder key first");
      const chosen = S.lockUtxos.filter((u) => u.selected);
      if (!chosen.length) throw new Error("select at least one funder UTXO");
      const feeRate = Number($("lock-fee").value);
      const lock = E.buildLockTx(S.network, {
        funderPriv: S.funder.priv,
        funderInternalXOnly: S.funder.internalXOnly,
        utxos: chosen,
        swapProgram: E.hexToBytes(S.swap.tweakedHex),
        prlGrains: S.swap.prlGrains,
        feeRateGrainsPerVByte: feeRate,
      });
      S.lockTx = lock;
      $("lock-tx-summary").innerHTML =
        "<div class=\"krow\"><dt>Swap address</dt><dd><code>" + esc(S.swap.address) + "</code></dd></div>" +
        "<div class=\"krow\"><dt>Locked</dt><dd>" + fmtPRL(S.swap.prlGrains) + " PRL</dd></div>" +
        "<div class=\"krow\"><dt>Fee</dt><dd>" + fmtPRL(lock.feeGrains) + " PRL @ " + esc(String(feeRate)) +
        " grains/vB (" + lock.vBytes + " vB)</dd></div>" +
        "<div class=\"krow\"><dt>Change</dt><dd>" + fmtPRL(lock.changeGrains) + " PRL back to funder</dd></div>" +
        "<div class=\"krow\"><dt>Signatures</dt><dd>re-verified locally ✓</dd></div>";
      const wEl = $("lock-warnings");
      wEl.innerHTML = lock.warnings.map((w) => "<div class=\"warn\">⚠ " + esc(w) + "</div>").join("");
      $("lock-txid").textContent = lock.txid;
      $("lock-hex").value = lock.hex;
      $("lock-confirm").checked = false;
      $("lock-ok").hidden = true;
      $("lock-bcast-error").hidden = true;
      $("lock-out").hidden = false;
      // carry the fresh swap UTXO to claim/refund steps
      $("claim-utxo-txid").value = lock.txid;
      $("claim-utxo-vout").value = "0";
      $("claim-utxo-value").value = fmtPRL(S.swap.prlGrains);
      $("refund-utxo-txid").value = lock.txid;
      $("refund-utxo-vout").value = "0";
      $("refund-utxo-value").value = fmtPRL(S.swap.prlGrains);
      if (S.preimageHex) $("claim-pre").value = S.preimageHex;
    } catch (err) { showErr("lock-error", err.message); }
  });

  $("lock-broadcast-btn").addEventListener("click", async () => {
    $("lock-ok").hidden = true;
    $("lock-bcast-error").hidden = true;
    try {
      if (!$("lock-confirm").checked) throw new Error("confirm the checkbox first — this moves real PRL");
      const bb = requireBlockbook();
      $("lock-broadcast-btn").disabled = true;
      $("lock-broadcast-btn").textContent = "Broadcasting…";
      const txid = await E.broadcastTx(bb, $("lock-hex").value.trim());
      const ok = $("lock-ok");
      ok.textContent = "Broadcast accepted — txid " + txid + ". Bob: now build your BTC mirror.";
      ok.hidden = false;
      markDone("lock");
    } catch (err) {
      const e = $("lock-bcast-error");
      e.textContent = err.message;
      e.hidden = false;
    } finally {
      $("lock-broadcast-btn").disabled = false;
      $("lock-broadcast-btn").textContent = "Broadcast via Blockbook";
    }
  });

  /* ---------- Bitcoin mirror template ---------- */
  $("mirror-gen-btn").addEventListener("click", () => {
    hideErr("lock-error");
    try {
      if (!S.swap) throw new Error("load the swap spec first");
      const btcTip = $("mirror-btc-tip").value.trim() ? parseInt($("mirror-btc-tip").value, 10) : undefined;
      const pearlTip = $("mirror-pearl-tip").value.trim() ? parseInt($("mirror-pearl-tip").value, 10) : undefined;
      const t = E.btcMirrorTemplate(S.swap, {
        btcNetwork: $("mirror-btc-network").value, btcTip, pearlTip,
      });
      $("mirror-address").textContent = t.address ||
        "(no address without chain tips — fill both tips above to compute the exact BTC address)";
      $("mirror-conversion").textContent = t.conversionNote;
      $("mirror-claim-hex").textContent = t.claimScriptHex + "\n" + t.claimAsm;
      $("mirror-refund-hex").textContent = t.refundScriptHex
        ? t.refundScriptHex + "\n" + t.refundAsm
        : "(refund script needs the suggested Bitcoin height — fill both tips above)";
      $("mirror-steps").innerHTML = t.steps.map((s) => "<p>" + esc(s) + "</p>").join("");
      $("mirror-note").textContent = t.honestNote;
      $("mirror-text").value =
        "PEARL SWAP — BITCOIN MIRROR TEMPLATE\n" +
        "====================================\n" +
        "Pearl swap descriptor: " + S.swap.descriptor + "\n" +
        "Pearl swap address: " + S.swap.address + "\n" +
        "Bitcoin network: " + t.btcNetwork + " (" + t.hrp + ")\n" +
        "BTC address: " + (t.address || "(needs chain tips)") + "\n" +
        "BTC amount: " + S.swap.btcSats + " sats (" + (S.swap.btcSats / 1e8).toFixed(8) + " BTC)\n" +
        "Secret hash H: " + S.swap.secretHashHex + "\n" +
        "Suggested BTC refund height: " + (t.suggestedBtcRefundHeight === null ? "(needs chain tips)" : t.suggestedBtcRefundHeight) + "\n" +
        "Conversion: " + t.conversionNote + "\n\n" +
        "CLAIM LEAF (byte-identical on both chains):\n" + t.claimScriptHex + "\n" + t.claimAsm + "\n\n" +
        "REFUND LEAF (Bob's BTC refund):\n" + (t.refundScriptHex || "(needs chain tips)") + "\n" + (t.refundAsm || "") + "\n\n" +
        "STEPS:\n" + t.steps.map((s, i) => s).join("\n") + "\n\n" +
        t.honestNote + "\n";
      $("mirror-out").hidden = false;
    } catch (err) { showErr("lock-error", err.message); }
  });

  /* ---------- STEP 3: TRACK ---------- */
  $("track-load-btn").addEventListener("click", () => {
    try {
      applyNetwork();
      loadSpecInto("track-spec", "track-error", "track-state", "track-work");
      $("track-countdown").innerHTML = "";
      markDone("track");
    } catch (err) { showErr("track-error", err.message); }
  });

  function stateClass(state) {
    return { "claimed": "state-claimed", "refunded": "state-refunded", "locked": "state-locked" }[state] || "state-awaiting";
  }

  $("track-scan-btn").addEventListener("click", async () => {
    hideErr("track-error");
    try {
      if (!S.swap) throw new Error("load the swap spec first");
      const bb = requireBlockbook();
      $("track-scan-btn").disabled = true;
      $("track-scan-btn").textContent = "Scanning…";
      const tip = await fetchTipHeight();
      $("track-tip").textContent = "Tip: " + tip.toLocaleString();
      const utxos = await E.fetchUtxos(bb, S.swap.address);
      const fundingSeen = utxos.length > 0;
      // spend scan: list address txs, fetch each, classify those spending the swap output
      let spends = [];
      try {
        const ar = await fetch(bb.replace(/\/$/, "") + "/api/v2/address/" + S.swap.address);
        if (ar.ok) {
          const aj = await ar.json();
          const txids = aj.txids || [];
          for (const txid of txids.slice(0, 25)) {
            try {
              const tx = await E.fetchTxStatus(bb, txid);
              if (tx && tx.hex) spends.push({ txid: String(txid).toLowerCase(), hex: tx.hex });
            } catch { /* skip unreadable tx */ }
          }
        }
      } catch { /* address endpoint optional */ }
      const st = E.classifySwapState(S.swap, { fundingSeen, spends });
      const cd = E.swapCountdown(S.swap, tip);
      $("track-state").innerHTML =
        "<div class=\"krow\"><dt>Status</dt><dd class=\"" + stateClass(st.state) + "\">" + esc(st.state.toUpperCase()) + "</dd></div>" +
        (st.txid ? "<div class=\"krow\"><dt>Spend txid</dt><dd><code>" + esc(st.txid) + "</code></dd></div>" : "") +
        (st.preimageHex ? "<div class=\"krow\"><dt>Preimage</dt><dd><code>" + esc(st.preimageHex) + "</code></dd></div>" : "") +
        "<div class=\"krow\"><dt>Funding UTXOs</dt><dd>" + utxos.length + "</dd></div>";
      $("track-countdown").innerHTML =
        "<div class=\"krow\"><dt>T1 (PRL refund)</dt><dd>height " + S.swap.t1 + " — " +
        (cd.t1Mature ? "<strong>mature</strong>" : cd.blocksToT1 + " blocks to go (" + fmtEta(cd.etaSecsToT1) + ")") + "</dd></div>" +
        "<div class=\"krow\"><dt>T2 (BTC deadline)</dt><dd>height " + S.swap.t2 + " — " +
        (cd.t2Reached ? "<strong>reached</strong>" : cd.blocksToT2 + " blocks to go (" + fmtEta(cd.etaSecsToT2) + ")") + "</dd></div>";
      if (st.state === "claimed" && st.preimageHex) {
        S.preimageHex = st.preimageHex;
        $("track-to-claim-btn").hidden = false;
      } else {
        $("track-to-claim-btn").hidden = true;
      }
    } catch (err) { showErr("track-error", err.message); }
    finally { $("track-scan-btn").disabled = false; $("track-scan-btn").textContent = "Scan via Blockbook"; }
  });

  $("track-classify-btn").addEventListener("click", () => {
    hideErr("track-error");
    try {
      if (!S.swap) throw new Error("load the swap spec first");
      const hex = $("track-tx-hex").value.trim();
      if (!hex) throw new Error("paste a transaction hex first");
      const parsed = E.parseTx(hex);
      const st = E.classifySwapState(S.swap, {
        fundingSeen: true,
        spends: [{ txid: parsed.inputs[0] ? "pasted-tx" : "?", hex }],
      });
      const out = $("track-classify-out");
      out.hidden = false;
      out.innerHTML =
        "<div class=\"krow\"><dt>Classification</dt><dd class=\"" + stateClass(st.state) + "\">" + esc(st.state.toUpperCase()) + "</dd></div>" +
        (st.preimageHex ? "<div class=\"krow\"><dt>Preimage revealed</dt><dd><code>" + esc(st.preimageHex) + "</code></dd></div>" : "") +
        (st.state === "refunded" ? "<div class=\"krow\"><dt>Note</dt><dd>nLockTime ≥ T1 — this was Alice's refund</dd></div>" : "");
      if (st.state === "claimed" && st.preimageHex) {
        S.preimageHex = st.preimageHex;
        $("track-to-claim-btn").hidden = false;
      }
    } catch (err) { showErr("track-error", err.message); }
  });

  $("track-to-claim-btn").addEventListener("click", () => {
    if (S.preimageHex) {
      $("alice-claim-hex").value = $("track-tx-hex").value.trim();
      goto("claim");
    }
  });

  /* ---------- STEP 4: CLAIM ---------- */
  $("claim-load-btn").addEventListener("click", () => {
    hideErr("claim-error");
    try {
      applyNetwork();
      loadSpecInto("claim-spec", "claim-error", null, "claim-work");
      if (S.preimageHex) $("claim-pre").value = S.preimageHex;
    } catch (err) { showErr("claim-error", err.message); }
  });

  $("claim-build-btn").addEventListener("click", () => {
    hideErr("claim-error");
    try {
      if (!S.swap) throw new Error("load the swap spec first");
      const { priv } = privFromInput($("claim-key").value);
      const claimVoutRaw = $("claim-utxo-vout").value.trim();
      if (!/^\d+$/.test(claimVoutRaw) || !Number.isSafeInteger(Number(claimVoutRaw))) throw new Error("bad utxo vout");
      const utxo = {
        txid: $("claim-utxo-txid").value.trim().toLowerCase(),
        vout: Number(claimVoutRaw),
        value: parsePRL($("claim-utxo-value").value),
      };
      const claim = E.buildClaimSpend(S.network, S.swap, {
        utxo,
        preimageHex: $("claim-pre").value,
        bobPrivHex: priv,
        destAddress: $("claim-dest").value,
        feeRateGrainsPerVByte: Number($("claim-fee").value),
      });
      S.claimTx = claim;
      S.preimageHex = claim.preimageHex;
      $("claim-txid").textContent = claim.txid;
      $("claim-hex").value = claim.hex;
      $("claim-confirm").checked = false;
      $("claim-ok").hidden = true;
      $("claim-bcast-error").hidden = true;
      $("claim-out").hidden = false;
      $("claim-key").value = ""; // clear the secret from the field immediately
    } catch (err) { showErr("claim-error", err.message); }
  });

  $("claim-broadcast-btn").addEventListener("click", async () => {
    $("claim-ok").hidden = true;
    $("claim-bcast-error").hidden = true;
    try {
      if (!$("claim-confirm").checked) throw new Error("confirm the checkbox first — this reveals the preimage on-chain");
      const bb = requireBlockbook();
      $("claim-broadcast-btn").disabled = true;
      $("claim-broadcast-btn").textContent = "Broadcasting…";
      const txid = await E.broadcastTx(bb, $("claim-hex").value.trim());
      const ok = $("claim-ok");
      ok.textContent = "Broadcast accepted — txid " + txid + ". The preimage is now public: Alice, extract it and claim the BTC.";
      ok.hidden = false;
      markDone("claim");
    } catch (err) {
      const e = $("claim-bcast-error");
      e.textContent = err.message;
      e.hidden = false;
    } finally {
      $("claim-broadcast-btn").disabled = false;
      $("claim-broadcast-btn").textContent = "Broadcast via Blockbook";
    }
  });

  $("alice-extract-btn").addEventListener("click", () => {
    hideErr("alice-error");
    try {
      applyNetwork();
      const specRaw = $("claim-spec").value.trim();
      const swap = specRaw ? E.parseSwapSpec(specRaw, S.network) : S.swap;
      if (!swap) throw new Error("load the swap spec first (Bob's path, above)");
      const preimageHex = E.extractPreimage($("alice-claim-hex").value, swap.secretHashHex);
      S.preimageHex = preimageHex;
      $("alice-pre").textContent = preimageHex;
      $("alice-btc-steps").innerHTML =
        "<p>1. In your Bitcoin wallet/tooling, open the BTC HTLC from the mirror template (Lock step) — " +
        "the claim leaf is <code>OP_SHA256 &lt;H&gt; OP_EQUALVERIFY &lt;your-key&gt; OP_CHECKSIG</code>.</p>" +
        "<p>2. Build a Bitcoin transaction spending the BTC HTLC via the claim leaf with witness " +
        "<code>[your-signature, " + esc(preimageHex.slice(0, 16)) + "…]</code> — the full preimage above goes in the witness.</p>" +
        "<p>3. Broadcast on Bitcoin and wait for confirmations. Do this <strong>before</strong> the BTC refund timeout.</p>" +
        "<p>4. Clear the preimage from this page when done.</p>";
      $("alice-out").hidden = false;
    } catch (err) { showErr("alice-error", err.message); }
  });

  /* ---------- STEP 5: REFUND ---------- */
  $("refund-load-btn").addEventListener("click", () => {
    hideErr("refund-error");
    try {
      applyNetwork();
      loadSpecInto("refund-spec", "refund-error", null, "refund-work");
    } catch (err) { showErr("refund-error", err.message); }
  });

  $("refund-tip-btn").addEventListener("click", async () => {
    hideErr("refund-error");
    try {
      $("refund-height").value = await fetchTipHeight();
    } catch (err) { showErr("refund-error", err.message); }
  });

  $("refund-build-btn").addEventListener("click", () => {
    hideErr("refund-error");
    try {
      if (!S.swap) throw new Error("load the swap spec first");
      const { priv } = privFromInput($("refund-key").value);
      const refundVoutRaw = $("refund-utxo-vout").value.trim();
      if (!/^\d+$/.test(refundVoutRaw) || !Number.isSafeInteger(Number(refundVoutRaw))) throw new Error("bad utxo vout");
      const utxo = {
        txid: $("refund-utxo-txid").value.trim().toLowerCase(),
        vout: Number(refundVoutRaw),
        value: parsePRL($("refund-utxo-value").value),
      };
      const currentHeight = parseInt($("refund-height").value, 10);
      if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) throw new Error("enter the current Pearl height (or fetch it)");
      const refund = E.buildRefundSpend(S.network, S.swap, {
        utxo,
        alicePrivHex: priv,
        destAddress: $("refund-dest").value,
        feeRateGrainsPerVByte: Number($("refund-fee").value),
        currentHeight,
      });
      S.refundTx = refund;
      $("refund-txid").textContent = refund.txid;
      $("refund-hex").value = refund.hex;
      $("refund-confirm").checked = false;
      $("refund-ok").hidden = true;
      $("refund-bcast-error").hidden = true;
      $("refund-out").hidden = false;
      $("refund-key").value = ""; // clear the secret from the field immediately
      markDone("refund");
    } catch (err) { showErr("refund-error", err.message); }
  });

  $("refund-broadcast-btn").addEventListener("click", async () => {
    $("refund-ok").hidden = true;
    $("refund-bcast-error").hidden = true;
    try {
      if (!$("refund-confirm").checked) throw new Error("confirm the checkbox first — this moves real PRL");
      const bb = requireBlockbook();
      $("refund-broadcast-btn").disabled = true;
      $("refund-broadcast-btn").textContent = "Broadcasting…";
      const txid = await E.broadcastTx(bb, $("refund-hex").value.trim());
      const ok = $("refund-ok");
      ok.textContent = "Broadcast accepted — txid " + txid;
      ok.hidden = false;
    } catch (err) {
      const e = $("refund-bcast-error");
      e.textContent = err.message;
      e.hidden = false;
    } finally {
      $("refund-broadcast-btn").disabled = false;
      $("refund-broadcast-btn").textContent = "Broadcast via Blockbook";
    }
  });

  /* ---------- init ---------- */
  applyNetwork();
})();
