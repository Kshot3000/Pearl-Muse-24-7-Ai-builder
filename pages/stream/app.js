/* Pearl Stream — browser UI (classic script, window.PearlStream bundle). */
(function () {
  "use strict";
  const E = window.PearlStream;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Pearl Stream failed to load.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* storage that survives hostile localStorage */
  const store = {
    m: {},
    get(k) { try { return localStorage.getItem(k); } catch { return this.m[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { this.m[k] = v; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: store.get("ps.blockbook") || "",
    stream: null,  // forged { schedule, ticks }
    track: null,   // { schedule, ticks, funding: Map, chainTime, chainTimeSrc }
    utxos: new Map(), // tickIndex -> utxo (filled by scan or manual paste)
    claimPlan: null,
    cancelPlan: null,
  };

  function showErr(id, msg) { const e = $(id); e.textContent = msg; e.hidden = false; }
  function hideErr(id) { $(id).hidden = true; }
  function grainsToPRL(g) {
/* BigInt-exact (pool float-format class): the old float format
     * silently rounds grain counts past Number.MAX_SAFE_INTEGER.
     * Integer string/BigInt grain counts format exactly; anything
     * else keeps the legacy float rendering. */
    const s = typeof g === "bigint" ? g.toString() : String(g).trim();
    if (!/^-?\d+$/.test(s)) return (Number(g) / E.GRAIN_PER_PRL).toFixed(8).replace(/\.?0+$/, "");
    const b = BigInt(s), neg = b < 0n, a = neg ? -b : b;
    const w = (a / 100000000n).toString();
    const f = (a % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + w + (f ? "." + f : "");
  }
  function fmtDate(lock) { return new Date(lock * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"; }
  function countdown(lock, now) {
    const d = lock - now;
    if (d <= 0) return "matured";
    const days = Math.floor(d / 86400), h = Math.floor((d % 86400) / 3600), m = Math.floor((d % 3600) / 60);
    if (days > 0) return `in ${days}d ${h}h`;
    if (h > 0) return `in ${h}h ${m}m`;
    return `in ${Math.max(1, Math.floor(d / 60))}m`;
  }

  function renderQR(el, text) {
    el.innerHTML = "";
    try {
      if (typeof window.qrcode === "undefined") throw new Error("qr lib missing");
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(4, 8);
    } catch {
      el.innerHTML = "<p class='hint'>QR too large — use copy/download instead.</p>";
    }
  }

  /* ---------- step nav ---------- */
  document.querySelectorAll("#steps button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#steps button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll(".panel").forEach((s) => s.classList.remove("active"));
    $("step-" + b.dataset.step).classList.add("active");
  }));

  /* ---------- copy buttons ---------- */
  document.querySelectorAll(".copy-btn").forEach((b) => b.addEventListener("click", async () => {
    const t = $(b.dataset.for);
    const txt = t.value !== undefined && t.tagName !== "CODE" ? t.value : t.textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; }
    catch { b.textContent = "Copy failed"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  }));

  /* ---------- network + blockbook ---------- */
  function onNetworkChange() {
    S.network = E.NETWORKS[$("network").value];
    S.stream = null; S.track = null; S.utxos = new Map();
    $("schedule-out").hidden = true; $("track-out").innerHTML = ""; $("dashboard").hidden = true;
    renderTickRows();
  }
  $("network").addEventListener("change", onNetworkChange);
  if (S.blockbook) $("blockbook").value = S.blockbook;
  $("blockbook").addEventListener("change", (e) => {
    S.blockbook = e.target.value.trim();
    store.set("ps.blockbook", S.blockbook);
  });

  /* default start = now, rounded to the hour */
  $("start").value = new Date(Math.ceil(Date.now() / 3600000) * 3600000).toISOString().slice(0, 16);

  function blockbookBase() {
    const b = ($("blockbook").value || S.blockbook || "").trim().replace(/\/+$/, "");
    if (!b) throw new Error("set a Blockbook endpoint first");
    S.blockbook = b; store.set("ps.blockbook", b);
    return b;
  }

  function chainNow() {
    const ct = S.track && S.track.chainTime;
    return { now: ct || Math.floor(Date.now() / 1000), src: ct ? "blockbook" : "local clock" };
  }

  /* ---------- FORGE ---------- */
  $("forge-sample").addEventListener("click", () => {
    $("network").value = "testnet";
    onNetworkChange();
    const fm = E.newMnemonic(), bm = E.newMnemonic();
    $("funder").value = fm;
    $("beneficiary").value = bm;
    $("rate").value = "0.5";
    $("tick-value").value = "1";
    $("tick-unit").value = "86400";
    $("ticks").value = "8";
    showErr("forge-err", ""); $("forge-err").hidden = true;
    const n = $("beneficiary-mode-note");
    n.hidden = false;
    n.innerHTML = "<strong>Demo keys generated.</strong> Save both mnemonics — the funder one forges, the beneficiary one claims on testnet.";
  });

  $("forge").addEventListener("click", () => {
    hideErr("forge-err");
    try {
      const net = S.network;
      const ben = E.beneficiaryKeyFromInput($("beneficiary").value, net);
      const funderIn = E.partyKeyFromInput($("funder").value, net);
      const rateGrainsPerTick = E.parsePRLToGrains($("rate").value);
      if (!(rateGrainsPerTick > 0)) throw new Error("rate must be positive");
      const tickSeconds = Math.round(parseFloat($("tick-value").value) * parseInt($("tick-unit").value, 10));
      const startTime = Math.floor(new Date($("start").value).getTime() / 1000);
      if (!Number.isFinite(startTime) || startTime <= 0) throw new Error("start date is invalid");
      /* Strict tick-count parse: bare parseInt truncated "12.9" to 12
         and "1e2" to 1, silently shrinking the stream total
         (rate x tickCount) in the fingerprinted descriptor. */
      const tickRaw = $("ticks").value.trim();
      if (!/^\d+$/.test(tickRaw)) throw new Error("tick count must be an integer in 1..256");
      const tickCount = Number(tickRaw);
      const planned = E.planStream({
        network: net, beneficiary: ben, funderXOnly: funderIn.xonly,
        rateGrainsPerTick, tickSeconds, startTime, tickCount,
        revocable: $("revocable").checked,
      });
      S.stream = planned; S.track = null; S.utxos = new Map();
      $("stream-total").textContent = grainsToPRL(planned.schedule.totalGrains) + " PRL";
      renderTicks(planned.ticks, "tick-cards");
      $("descriptor").value = planned.schedule.descriptor;
      $("schedule-out").hidden = false;
      const note = $("beneficiary-mode-note");
      note.hidden = false;
      note.innerHTML = ben.mode === "address"
        ? "Beneficiary key mode: <strong>address</strong> — the beneficiary claims with the mnemonic/WIF behind <code>" + esc($("beneficiary").value.slice(0, 18)) + "…</code> (keypath-tweaked signing)."
        : "Beneficiary key mode: <strong>raw x-only key</strong> — the beneficiary claims with the matching private key or mnemonic.";
      $("descriptor-qr").innerHTML = "";
      refreshDest();
      renderTickRows();
    } catch (err) {
      showErr("forge-err", err.message);
    }
  });

  $("descriptor-qr-btn").addEventListener("click", () => renderQR($("descriptor-qr"), $("descriptor").value));
  $("descriptor-download").addEventListener("click", () => {
    if (!S.stream) return;
    const data = {
      ...S.stream.schedule,
      ticks: S.stream.ticks.map((t) => ({
        index: t.index, lock: t.lock, lockDateISO: t.lockDateISO, amountGrains: t.amountGrains,
        address: t.address, claimScript: E.bytesToHex(t.claimScript),
        clawbackScript: t.clawbackScript ? E.bytesToHex(t.clawbackScript) : null,
      })),
      exportedAt: new Date().toISOString(),
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "pearl-stream-schedule.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  function renderTicks(ticks, containerId) {
    const el = $(containerId);
    const { now } = chainNow();
    el.innerHTML = ticks.map((t) => `
      <div class="card">
        <h4>Tick ${t.index + 1} · ${esc(grainsToPRL(t.amountGrains))} PRL</h4>
        <div class="meta">Unlocks ${esc(fmtDate(t.lock))} <span class="badge ${t.lock <= now ? "mature" : "locked"}">${esc(countdown(t.lock, now))}</span></div>
        <div class="addr">${esc(t.address)}</div>
        <div class="row">
          <button class="ghost qr-toggle" data-addr="${esc(t.address)}">QR</button>
          <button class="ghost addr-copy" data-addr="${esc(t.address)}">Copy address</button>
        </div>
        <div class="qr" hidden></div>
      </div>`).join("");
    el.querySelectorAll(".qr-toggle").forEach((b) => b.addEventListener("click", () => {
      const qr = b.closest(".card").querySelector(".qr");
      qr.hidden = !qr.hidden;
      if (!qr.hidden && !qr.innerHTML) renderQR(qr, b.dataset.addr);
    }));
    el.querySelectorAll(".addr-copy").forEach((b) => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.dataset.addr); b.textContent = "Copied"; }
      catch { b.textContent = "Copy failed"; }
      setTimeout(() => { b.textContent = "Copy address"; }, 1500);
    }));
  }

  /* ---------- TRACK ---------- */
  function currentStream() {
    if (S.stream) return { schedule: S.stream.schedule, ticks: S.stream.ticks };
    if (S.track) return { schedule: S.track.schedule, ticks: S.track.ticks };
    return null;
  }

  function fundingOf(i) {
    return S.track && S.track.funding.get(i);
  }

  $("track-load").addEventListener("click", () => {
    hideErr("track-err");
    try {
      const { schedule, ticks } = E.scheduleFromDescriptor($("track-descriptor").value);
      S.network = schedule.networkHrp === "tprl" ? E.NETWORKS.testnet : E.NETWORKS.mainnet;
      $("network").value = schedule.networkHrp === "tprl" ? "testnet" : "mainnet";
      S.track = { schedule, ticks, funding: new Map(), chainTime: null, chainTimeSrc: null };
      S.stream = null; S.utxos = new Map();
      renderTicks(ticks, "track-out");
      $("dashboard").hidden = true;
      refreshDest();
      renderTickRows();
    } catch (err) {
      showErr("track-err", err.message);
    }
  });

  $("track-scan").addEventListener("click", async () => {
    hideErr("track-err");
    try {
      if (!S.track) throw new Error("load a stream first");
      const base = blockbookBase();
      const chainTime = await E.fetchChainTime(base);
      S.track.chainTime = chainTime;
      const now = chainTime || Math.floor(Date.now() / 1000);
      const el = $("chain-time");
      el.hidden = false;
      el.textContent = chainTime
        ? `Chain time (Blockbook latest block): ${fmtDate(chainTime)}`
        : "Blockbook chain time unreachable — using your local clock (maturity labels are approximate).";
      const cards = $("track-out").querySelectorAll(".card");
      for (let i = 0; i < S.track.ticks.length; i++) {
        const t = S.track.ticks[i];
        let utxos = [];
        try { utxos = await E.fetchUtxos(base, t.address); } catch (e) { utxos = []; }
        const funded = utxos.reduce((s, u) => s + (u.value || 0), 0);
        S.track.funding.set(i, { utxos, funded });
        if (utxos.length > 0) S.utxos.set(i, utxos[0]);
        const mature = E.isMature(t.lock, now);
        const badge = funded > 0
          ? `<span class="badge funded">funded ${esc(grainsToPRL(funded))} PRL</span>`
          : `<span class="badge unfunded">unfunded</span>`;
        const mat = mature ? `<span class="badge mature">matured</span>` : `<span class="badge locked">${esc(countdown(t.lock, now))}</span>`;
        const meta = cards[i].querySelector(".meta");
        if (meta) meta.innerHTML = `Unlocks ${esc(fmtDate(t.lock))} ${mat} ${badge}` +
          ` <span class="hint">${esc(grainsToPRL(t.amountGrains))} PRL/tick</span>`;
      }
      renderDashboard(now);
      renderTickRows();
    } catch (err) {
      showErr("track-err", err.message);
    }
  });

  function renderDashboard(now) {
    const cur = currentStream();
    if (!cur) return;
    const ticks = cur.ticks.map((t, i) => ({ ...t, funded: (fundingOf(i) || { funded: 0 }).funded > 0 }));
    const st = E.streamState(ticks, now);
    $("dashboard").hidden = false;
    $("dash-streamed").textContent = grainsToPRL(st.streamedGrains) + " PRL";
    $("dash-claimable").textContent = grainsToPRL(st.claimableGrains) + " PRL";
    $("dash-remaining").textContent = grainsToPRL(st.remainingGrains) + " PRL";
    $("dash-progress").textContent = st.percentStreamed.toFixed(1) + "%";
    $("dash-bar").style.width = Math.min(100, st.percentStreamed) + "%";
  }

  function refreshDest() {
    const cur = currentStream();
    if (!cur) return;
    if (cur.schedule.beneficiaryMode === "address" && !$("claim-dest").value) {
      $("claim-dest").value = E.encodeBech32m(cur.schedule.networkHrp, 1, E.hexToBytes(cur.schedule.beneficiary));
    }
  }

  /* ---------- CLAIM + CANCEL tick selection ----------
   * Checkbox registry: the minimal DOM test shim cannot match "#id .class"
   * selectors, so rows register their checkboxes here instead of being
   * re-queried. Works identically in real browsers. */
  const tickChecks = { claim: [], cancel: [] };

  function renderTickRows() {
    const cur = currentStream();
    const { now, src } = chainNow();
    for (const [boxId, kind] of [["claim-ticks", "claim"], ["cancel-ticks", "cancel"]]) {
      const box = $(boxId);
      box.innerHTML = "";
      tickChecks[kind] = [];
      if (!cur) { box.innerHTML = `<p class="hint">Forge or track a stream first.</p>`; continue; }
      if (kind === "cancel" && !cur.schedule.revocable) {
        box.innerHTML = `<p class="hint">This stream is not revocable — no clawback leaves exist.</p>`;
        continue;
      }
      cur.ticks.forEach((t, i) => {
        const mature = E.isMature(t.lock, now);
        const eligible = kind === "claim" ? mature : !mature;
        const f = fundingOf(i);
        const funded = f ? f.funded > 0 : null;
        const utxo = S.utxos.get(i);
        const label = document.createElement("label");
        label.className = "tick-row" + (eligible ? "" : " disabled");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "tick-check";
        cb.dataset.tick = String(i);
        cb.disabled = !eligible;
        cb.checked = eligible && (funded === null || funded); // pre-tick when funded or unknown
        const info = document.createElement("div");
        info.className = "tinfo";
        info.innerHTML = `Tick ${i + 1} · ${esc(grainsToPRL(t.amountGrains))} PRL · ${mature ? '<span class="badge mature">matured</span>' : `<span class="badge locked">${esc(countdown(t.lock, now))}</span>`}` +
          (funded === null ? ` <span class="badge unfunded">funding unknown (${esc(src)})</span>`
            : funded ? ` <span class="badge funded">funded</span>` : ` <span class="badge unfunded">unfunded</span>`) +
          (utxo ? `<div class="utxo-note">utxo ${esc(utxo.txid.slice(0, 12))}…:${utxo.vout} · ${esc(grainsToPRL(utxo.value))} PRL</div>` : "");
        const addr = document.createElement("div");
        addr.className = "taddr";
        addr.textContent = t.address;
        label.appendChild(cb);
        label.appendChild(info);
        label.appendChild(addr);
        box.appendChild(label);
        tickChecks[kind].push(cb);
      });
    }
  }

  function checkedTicks(kind) {
    return tickChecks[kind]
      .filter((c) => c.checked && !c.disabled)
      .map((c) => +c.dataset.tick);
  }

  function parseManualUtxos(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.map((line, i) => {
      const m = /^([0-9a-f]{64})\s+(\d+)\s+(\d+)$/i.exec(line);
      if (!m) throw new Error(`UTXO line ${i + 1}: expected "txid vout value"`);
      return { txid: m[1].toLowerCase(), vout: parseInt(m[2], 10), value: parseInt(m[3], 10) };
    });
  }

  async function scanUtxos(kind) {
    const cur = currentStream();
    if (!cur) throw new Error("forge or track a stream first");
    const base = blockbookBase();
    for (let i = 0; i < cur.ticks.length; i++) {
      let utxos = [];
      try { utxos = await E.fetchUtxos(base, cur.ticks[i].address); } catch (e) { utxos = []; }
      if (S.track) S.track.funding.set(i, { utxos, funded: utxos.reduce((s, u) => s + (u.value || 0), 0) });
      if (utxos.length > 0) S.utxos.set(i, utxos[0]);
    }
    renderTickRows();
  }
  $("claim-scan").addEventListener("click", async () => {
    hideErr("claim-err");
    try { await scanUtxos("claim"); } catch (e) { showErr("claim-err", e.message); }
  });
  $("cancel-scan").addEventListener("click", async () => {
    hideErr("cancel-err");
    try { await scanUtxos("cancel"); } catch (e) { showErr("cancel-err", e.message); }
  });

  async function feeRateFor(inputId) {
    const v = parseFloat($(inputId).value);
    if (Number.isFinite(v) && v > 0) return v;
    const base = blockbookBase();
    return await E.fetchFeeRateGrainsPerVByte(base, 2);
  }

  function reviewDl(el, rows) {
    el.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  }

  /** Assemble batch inputs for checked ticks. role: 'claim' | 'clawback'. */
  function gatherBatch(kind, manualId, role) {
    const cur = currentStream();
    if (!cur) throw new Error("forge or track a stream first");
    const idxs = checkedTicks(kind);
    if (idxs.length === 0) throw new Error(role === "claim" ? "tick at least one matured tick" : "tick at least one unmatured tick");
    const manual = parseManualUtxos($(manualId).value);
    if (manual.length > 0 && manual.length !== idxs.length) {
      throw new Error(`manual UTXO lines (${manual.length}) must match ticked ticks (${idxs.length}), or leave blank`);
    }
    const inputs = idxs.map((ti, k) => {
      const utxo = manual.length > 0 ? manual[k] : S.utxos.get(ti);
      if (!utxo) throw new Error(`tick ${ti + 1}: no UTXO — scan via Blockbook or paste it manually`);
      const { leaf } = E.tickLeafFor(cur.ticks[ti], role);
      return {
        txid: utxo.txid, vout: utxo.vout, value: utxo.value, tick: cur.ticks[ti],
        scriptLen: leaf.length,
      };
    });
    return { cur, idxs, inputs };
  }

  function secretWallet(secret, expectXOnlyHex, who) {
    const words = secret.trim().split(/\s+/);
    let w;
    if (words.length === 12 || words.length === 24) w = E.walletFromMnemonic(secret, S.network);
    else { try { w = E.walletFromWIF(secret, S.network); } catch { throw new Error(who + " secret must be a 12/24-word mnemonic or WIF"); } }
    if (E.bytesToHex(w.internalXOnly).toLowerCase() !== expectXOnlyHex.toLowerCase()) {
      throw new Error("this key does not match the " + who + " key in the stream");
    }
    return w;
  }

  /* ---------- CLAIM ---------- */
  $("claim-plan").addEventListener("click", async () => {
    hideErr("claim-err"); $("claim-review").hidden = true; $("claim-signed").hidden = true;
    try {
      const { cur, idxs, inputs } = gatherBatch("claim", "claim-manual", "claim");
      const secret = $("claim-secret").value;
      if (!secret) throw new Error("import the beneficiary secret");
      const signer = E.beneficiarySignerFor(secret, S.network, cur.schedule.beneficiary, cur.schedule.beneficiaryMode);
      const destProgram = E.addressToProgram($("claim-dest").value, S.network);
      const feeRate = await feeRateFor("claim-feerate");
      const sweep = E.planBatchClaim({
        inputs: inputs.map((x) => ({ value: x.value })),
        scriptLens: inputs.map((x) => { const { leaf } = E.tickLeafFor(x.tick, "claim"); return leaf.length; }),
        controlLens: inputs.map((x) => x.tick.claimControlBlock.length),
        feeRateGrainsPerVByte: feeRate,
      });
      S.claimPlan = { cur, idxs, inputs, signerPriv: signer.priv, destProgram, feeRate, sweep };
      const locks = idxs.map((i) => cur.ticks[i].lock);
      reviewDl($("claim-review-dl"), [
        ["Inputs", `${inputs.length} tick${inputs.length > 1 ? "s" : ""} (#${idxs.map((i) => i + 1).join(", #")})`],
        ["Total in", `${grainsToPRL(sweep.inputSum)} PRL`],
        ["Payout", `${grainsToPRL(sweep.payment)} PRL → ${$("claim-dest").value.slice(0, 24)}…`],
        ["Fee", `${sweep.fee} grains (${sweep.vBytes} vB @ ${feeRate} grains/vB)`],
        ["nLockTime", `${Math.max(...locks)} (${fmtDate(Math.max(...locks))})`],
        ["Sequence", "0xfffffffe on every input (non-final, CLTV satisfied)"],
      ]);
      $("claim-review").hidden = false;
    } catch (err) {
      showErr("claim-err", err.message);
    }
  });

  $("claim-sign").addEventListener("click", () => {
    hideErr("claim-err");
    try {
      const p = S.claimPlan;
      if (!p) throw new Error("plan the batch claim first");
      const signed = E.buildBatchClaimTx({
        network: S.network, inputs: p.inputs, role: "claim",
        signerPriv: p.signerPriv, destinationProgram: p.destProgram,
        feeRateGrainsPerVByte: p.feeRate,
      });
      S.claimPlan.signed = signed;
      reviewDl($("claim-signed-dl"), [
        ["TXID", signed.txid],
        ["Inputs swept", String(signed.inputCount)],
        ["Fee paid", `${signed.fee} grains`],
        ["Size", `${signed.vBytes} vB`],
        ["Signatures", `${signed.inputCount} verified locally against each tick's leaf key before hex was produced`],
      ]);
      $("claim-hex").value = signed.hex;
      $("claim-signed").hidden = false;
      $("claim-txid").hidden = true;
    } catch (err) {
      showErr("claim-err", err.message);
    }
  });

  $("claim-broadcast").addEventListener("click", async () => {
    hideErr("claim-err");
    try {
      const p = S.claimPlan;
      if (!p || !p.signed) throw new Error("sign first");
      const base = blockbookBase();
      const txid = await E.broadcastTx(base, p.signed.hex);
      const el = $("claim-txid");
      el.hidden = false;
      el.innerHTML = `Broadcast accepted — txid <code>${esc(txid || p.signed.txid)}</code>`;
      $("claim-secret").value = "";
      S.claimPlan.signerPriv = null;
    } catch (err) {
      showErr("claim-err", "Broadcast failed: " + err.message);
    }
  });

  $("claim-clear").addEventListener("click", () => {
    $("claim-secret").value = "";
    if (S.claimPlan) S.claimPlan.signerPriv = null;
  });

  /* ---------- CANCEL ---------- */
  $("cancel-plan").addEventListener("click", async () => {
    hideErr("cancel-err"); $("cancel-review").hidden = true; $("cancel-signed").hidden = true;
    try {
      const { cur, idxs, inputs } = gatherBatch("cancel", "cancel-manual", "clawback");
      if (!cur.schedule.revocable) throw new Error("this stream is not revocable");
      const secret = $("cancel-secret").value;
      if (!secret) throw new Error("import the funder secret");
      const w = secretWallet(secret, cur.schedule.funder, "funder");
      const destProgram = E.addressToProgram($("cancel-dest").value, S.network);
      const feeRate = await feeRateFor("cancel-feerate");
      const sweep = E.planBatchClaim({
        inputs: inputs.map((x) => ({ value: x.value })),
        scriptLens: inputs.map((x) => { const { leaf } = E.tickLeafFor(x.tick, "clawback"); return leaf.length; }),
        controlLens: inputs.map((x) => x.tick.clawbackControlBlock.length),
        feeRateGrainsPerVByte: feeRate,
      });
      S.cancelPlan = { cur, idxs, inputs, signerPriv: w.priv, destProgram, feeRate, sweep };
      const locks = idxs.map((i) => cur.ticks[i].lock);
      const maxLock = Math.max(...locks);
      reviewDl($("cancel-review-dl"), [
        ["Inputs", `${inputs.length} unmatured tick${inputs.length > 1 ? "s" : ""} (#${idxs.map((i) => i + 1).join(", #")})`],
        ["Total in", `${grainsToPRL(sweep.inputSum)} PRL`],
        ["Payout", `${grainsToPRL(sweep.payment)} PRL → ${$("cancel-dest").value.slice(0, 24)}…`],
        ["Fee", `${sweep.fee} grains (${sweep.vBytes} vB @ ${feeRate} grains/vB)`],
        ["nLockTime", `${maxLock} (${fmtDate(maxLock)}) — confirms only once this passes`],
        ["Sequence", "0xfffffffe on every input (non-final, CLTV satisfied)"],
      ]);
      $("cancel-review").hidden = false;
    } catch (err) {
      showErr("cancel-err", err.message);
    }
  });

  $("cancel-sign").addEventListener("click", () => {
    hideErr("cancel-err");
    try {
      const p = S.cancelPlan;
      if (!p) throw new Error("plan the cancel first");
      const signed = E.buildBatchClaimTx({
        network: S.network, inputs: p.inputs, role: "clawback",
        signerPriv: p.signerPriv, destinationProgram: p.destProgram,
        feeRateGrainsPerVByte: p.feeRate,
      });
      S.cancelPlan.signed = signed;
      reviewDl($("cancel-signed-dl"), [
        ["TXID", signed.txid],
        ["Inputs swept", String(signed.inputCount)],
        ["Fee paid", `${signed.fee} grains`],
        ["Size", `${signed.vBytes} vB`],
        ["Signatures", `${signed.inputCount} verified locally against each tick's clawback leaf key before hex was produced`],
      ]);
      $("cancel-hex").value = signed.hex;
      $("cancel-signed").hidden = false;
      $("cancel-txid").hidden = true;
    } catch (err) {
      showErr("cancel-err", err.message);
    }
  });

  $("cancel-broadcast").addEventListener("click", async () => {
    hideErr("cancel-err");
    try {
      const p = S.cancelPlan;
      if (!p || !p.signed) throw new Error("sign first");
      const base = blockbookBase();
      const txid = await E.broadcastTx(base, p.signed.hex);
      const el = $("cancel-txid");
      el.hidden = false;
      el.innerHTML = `Broadcast accepted — txid <code>${esc(txid || p.signed.txid)}</code>`;
      $("cancel-secret").value = "";
      S.cancelPlan.signerPriv = null;
    } catch (err) {
      showErr("cancel-err", "Broadcast failed: " + err.message);
    }
  });

  $("cancel-clear").addEventListener("click", () => {
    $("cancel-secret").value = "";
    if (S.cancelPlan) S.cancelPlan.signerPriv = null;
  });

  renderTickRows();
})();
