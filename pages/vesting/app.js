/* Pearl Vesting — browser UI (classic script, window.PearlVesting bundle). */
(function () {
  "use strict";
  const E = window.PearlVesting;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Pearl Vesting failed to load.</p>"; return; }

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
    blockbook: store.get("pv.blockbook") || "",
    schedule: null,      // forged { schedule, tranches }
    funderPrivHex: null, // in-memory only, from forge-time mnemonic
    track: null,         // { schedule, tranches, funding: Map, chainTime, chainTimeSrc }
    claimPlan: null,
    clawPlan: null,
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
    S.schedule = null; S.track = null;
    $("schedule-out").hidden = true; $("track-out").innerHTML = "";
    refreshClaimTrancheOptions();
  }
  $("network").addEventListener("change", onNetworkChange);
  if (S.blockbook) $("blockbook").value = S.blockbook;
  $("blockbook").addEventListener("change", (e) => {
    S.blockbook = e.target.value.trim();
    store.set("pv.blockbook", S.blockbook);
  });

  /* default start = now, rounded to the hour */
  $("start").value = new Date(Math.ceil(Date.now() / 3600000) * 3600000).toISOString().slice(0, 16);

  function blockbookBase() {
    const b = ($("blockbook").value || S.blockbook || "").trim().replace(/\/+$/, "");
    if (!b) throw new Error("set a Blockbook endpoint first");
    S.blockbook = b; store.set("pv.blockbook", b);
    return b;
  }

  function parseCustom(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.map((line, i) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})\s*,\s*(\S+)$/.exec(line);
      if (!m) throw new Error(`custom line ${i + 1}: expected "YYYY-MM-DD, PRL"`);
      const lock = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
      /* Date.UTC silently rolls impossible dates over (2027-02-30 becomes
         2027-03-02, month 13 becomes next January) — a rolled date would
         lock a tranche at a time the funder never chose. Round-trip the
         components and refuse anything that is not a real calendar date. */
      const rt = new Date(lock * 1000);
      if (rt.getUTCFullYear() !== +m[1] || rt.getUTCMonth() !== +m[2] - 1 || rt.getUTCDate() !== +m[3]) {
        throw new Error(`custom line ${i + 1}: ${m[1]}-${m[2]}-${m[3]} is not a real calendar date`);
      }
      /* Exact parser: the old Math.round(parseFloat(x) * 1e8) silently
         truncated "1.2.3" to 1.2 PRL and rounded sub-grain amounts. */
      let amountGrains;
      try {
        amountGrains = E.parsePRLToGrains(m[4]);
      } catch {
        throw new Error(`custom line ${i + 1}: bad amount "${m[4]}" — decimal PRL, at most 8 decimal places`);
      }
      if (!(amountGrains > 0)) throw new Error(`custom line ${i + 1}: bad amount`);
      return { lock, amountGrains };
    });
  }

  /* ---------- FORGE ---------- */
  $("forge-sample").addEventListener("click", () => {
    $("network").value = "testnet";
    onNetworkChange();
    const fm = E.newMnemonic(), bm = E.newMnemonic();
    $("funder").value = fm;
    $("beneficiary").value = bm;
    $("total").value = "10";
    $("cliff").value = "1";
    $("vest").value = "30";
    $("tranches").value = "3";
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
      S.funderPrivHex = funderIn.priv ? E.bytesToHex(funderIn.priv) : null;
      const revocable = $("revocable").checked;
      const customText = $("custom").value.trim();
      let planned;
      if (customText) {
        planned = E.planSchedule({
          network: net, beneficiary: ben, funderXOnly: funderIn.xonly,
          totalGrains: 0, startTime: 0, cliffSeconds: 0, vestSeconds: 1,
          revocable, customTranches: parseCustom(customText),
        });
      } else {
        const totalGrains = E.parsePRLToGrains($("total").value);
        const startTime = Math.floor(new Date($("start").value).getTime() / 1000);
        if (!Number.isFinite(startTime) || startTime <= 0) throw new Error("start date is invalid");
        const cliffSeconds = Math.round(parseFloat($("cliff").value) * 86400);
        const vestSeconds = Math.round(parseFloat($("vest").value) * 86400);
        if (!(vestSeconds > 0)) throw new Error("vesting duration must be positive");
        if (cliffSeconds < 0) throw new Error("cliff cannot be negative");
        if (cliffSeconds >= vestSeconds) throw new Error("cliff must be shorter than the vesting duration");
        /* Strict tranche-count parse: bare parseInt truncated "12.9"
           to 12 and "1e1" to 1, silently re-splitting the schedule
           that the descriptor fingerprints. */
        const trancheRaw = $("tranches").value.trim();
        if (!/^\d+$/.test(trancheRaw)) throw new Error("tranche count must be an integer in 1..64");
        const trancheCount = Number(trancheRaw);
        planned = E.planSchedule({
          network: net, beneficiary: ben, funderXOnly: funderIn.xonly,
          totalGrains, startTime, cliffSeconds, vestSeconds, trancheCount, revocable,
        });
      }
      S.schedule = planned;
      renderSchedule(planned, "tranche-cards");
      $("descriptor").value = planned.schedule.descriptor;
      $("schedule-out").hidden = false;
      const note = $("beneficiary-mode-note");
      note.hidden = false;
      note.innerHTML = ben.mode === "address"
        ? "Beneficiary key mode: <strong>address</strong> — the beneficiary claims with the mnemonic/WIF behind <code>" + esc($("beneficiary").value.slice(0, 18)) + "…</code> (keypath-tweaked signing)."
        : "Beneficiary key mode: <strong>raw x-only key</strong> — the beneficiary claims with the matching private key or mnemonic.";
      $("descriptor-qr").innerHTML = "";
      refreshClaimTrancheOptions();
    } catch (err) {
      showErr("forge-err", err.message);
    }
  });

  $("descriptor-qr-btn").addEventListener("click", () => renderQR($("descriptor-qr"), $("descriptor").value));
  $("descriptor-download").addEventListener("click", () => {
    if (!S.schedule) return;
    const data = {
      ...S.schedule.schedule,
      tranches: S.schedule.tranches.map((t) => ({
        index: t.index, lock: t.lock, lockDateISO: t.lockDateISO, amountGrains: t.amountGrains,
        address: t.address, claimScript: E.bytesToHex(t.claimScript),
        clawbackScript: t.clawbackScript ? E.bytesToHex(t.clawbackScript) : null,
      })),
      exportedAt: new Date().toISOString(),
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "pearl-vesting-schedule.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  function renderSchedule(planned, containerId) {
    const el = $(containerId);
    const now = Math.floor(Date.now() / 1000);
    el.innerHTML = planned.tranches.map((t) => `
      <div class="card">
        <h4>Tranche ${t.index + 1} · ${esc(grainsToPRL(t.amountGrains))} PRL</h4>
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
  function currentTranches() {
    if (S.schedule) return { schedule: S.schedule.schedule, tranches: S.schedule.tranches, src: "forged" };
    if (S.track) return { schedule: S.track.schedule, tranches: S.track.tranches, src: "tracked" };
    return null;
  }

  $("track-load").addEventListener("click", () => {
    hideErr("track-err");
    try {
      const amounts = $("track-amounts").value.trim()
        ? $("track-amounts").value.split(",").map((x) => parseInt(x.trim(), 10))
        : null;
      const { schedule, tranches } = E.scheduleFromDescriptor($("track-descriptor").value, amounts);
      S.network = schedule.networkHrp === "tprl" ? E.NETWORKS.testnet : E.NETWORKS.mainnet;
      $("network").value = schedule.networkHrp === "tprl" ? "testnet" : "mainnet";
      S.track = { schedule, tranches, funding: new Map(), chainTime: null, chainTimeSrc: null };
      renderSchedule({ tranches }, "track-out");
      refreshClaimTrancheOptions();
    } catch (err) {
      showErr("track-err", err.message);
    }
  });

  $("track-scan").addEventListener("click", async () => {
    hideErr("track-err");
    try {
      if (!S.track) throw new Error("load a schedule first");
      const base = blockbookBase();
      const chainTime = await E.fetchChainTime(base);
      S.track.chainTime = chainTime;
      S.track.chainTimeSrc = chainTime ? "blockbook" : "local";
      const now = chainTime || Math.floor(Date.now() / 1000);
      const el = $("chain-time");
      el.hidden = false;
      el.textContent = chainTime
        ? `Chain time (Blockbook latest block): ${fmtDate(chainTime)}`
        : "Blockbook chain time unreachable — using your local clock (maturity labels are approximate).";
      const cards = $("track-out").querySelectorAll(".card");
      for (let i = 0; i < S.track.tranches.length; i++) {
        const t = S.track.tranches[i];
        let utxos = [];
        try { utxos = await E.fetchUtxos(base, t.address); } catch (e) { utxos = []; }
        const funded = utxos.reduce((s, u) => s + (u.value || 0), 0);
        S.track.funding.set(i, { utxos, funded });
        const mature = E.isMature(t.lock, now);
        const badge = funded > 0
          ? `<span class="badge funded">funded ${esc(grainsToPRL(funded))} PRL</span>`
          : `<span class="badge unfunded">unfunded</span>`;
        const mat = mature ? `<span class="badge mature">matured</span>` : `<span class="badge locked">${esc(countdown(t.lock, now))}</span>`;
        const meta = cards[i].querySelector(".meta");
        if (meta) meta.innerHTML = `Unlocks ${esc(fmtDate(t.lock))} ${mat} ${badge}` +
          (t.amountGrains ? ` <span class="hint">expected ${esc(grainsToPRL(t.amountGrains))} PRL</span>` : "");
      }
      refreshClaimTrancheOptions();
    } catch (err) {
      showErr("track-err", err.message);
    }
  });

  /* ---------- CLAIM + CLAWBACK (shared) ---------- */
  function fundingFor(src, i) {
    if (src === "forged") return null; // scan happens in track; forge-time claims scan on demand
    return S.track && S.track.funding.get(i);
  }

  async function refreshClaimTrancheOptions() {
    const cur = currentTranches();
    const chainTime = S.track && S.track.chainTime;
    const now = chainTime || Math.floor(Date.now() / 1000);
    for (const [selId, kind] of [["claim-tranche", "claim"], ["claw-tranche", "clawback"]]) {
      const sel = $(selId);
      sel.innerHTML = `<option value="">—</option>`;
      if (!cur) continue;
      if (kind === "clawback" && !cur.schedule.revocable) {
        sel.innerHTML = `<option value="">— schedule is not revocable —</option>`;
        continue;
      }
      cur.tranches.forEach((t, i) => {
        const mature = E.isMature(t.lock, now);
        const o = document.createElement("option");
        o.value = `${cur.src}:${i}`;
        o.textContent = `#${i + 1} · ${grainsToPRL(t.amountGrains || 0)} PRL · ${mature ? "matured" : countdown(t.lock, now)}`;
        if (!mature) o.disabled = true;
        sel.appendChild(o);
      });
    }
  }

  function selectedOption(sel) {
    if (sel.selectedOptions && sel.selectedOptions[0]) return sel.selectedOptions[0];
    const opts = sel.querySelectorAll ? sel.querySelectorAll("option") : [];
    for (const o of opts) if (o.value === sel.value && o.value !== "") return o;
    return null;
  }

  function parseTrancheRef(ref) {
    const [src, idx] = ref.split(":");
    const cur = src === "forged" ? { schedule: S.schedule.schedule, tranches: S.schedule.tranches }
      : { schedule: S.track.schedule, tranches: S.track.tranches };
    return { cur, t: cur.tranches[+idx], i: +idx, src };
  }

  async function loadUtxoOptions(trancheSelId, utxoSelId) {
    const ref = $(trancheSelId).value;
    const sel = $(utxoSelId);
    sel.innerHTML = `<option value="">—</option>`;
    if (!ref) return;
    const { t } = parseTrancheRef(ref);
    const base = blockbookBase();
    const utxos = await E.fetchUtxos(base, t.address);
    utxos.forEach((u, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `${u.txid.slice(0, 12)}…:${u.vout} · ${grainsToPRL(u.value)} PRL`;
      o.dataset.utxo = JSON.stringify(u);
      sel.appendChild(o);
    });
    if (utxos.length === 0) {
      const o = document.createElement("option");
      o.value = ""; o.textContent = "— no UTXOs (unfunded?) —"; o.disabled = true;
      sel.appendChild(o);
    }
  }
  $("claim-tranche").addEventListener("change", () => {
    hideErr("claim-err");
    const ref = $("claim-tranche").value;
    if (ref) {
      const { cur, t } = parseTrancheRef(ref);
      if (cur.schedule.beneficiaryMode === "address") {
        $("claim-dest").value = E.encodeBech32m(cur.schedule.networkHrp, 1, E.hexToBytes(t.beneficiary));
      }
    }
    loadUtxoOptions("claim-tranche", "claim-utxo").catch((e) => showErr("claim-err", e.message));
  });
  $("claw-tranche").addEventListener("change", () => {
    hideErr("claw-err");
    loadUtxoOptions("claw-tranche", "claw-utxo").catch((e) => showErr("claw-err", e.message));
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

  /* ---------- CLAIM ---------- */
  $("claim-plan").addEventListener("click", async () => {
    hideErr("claim-err"); $("claim-review").hidden = true; $("claim-signed").hidden = true;
    try {
      const ref = $("claim-tranche").value;
      if (!ref) throw new Error("pick a matured tranche");
      const { cur, t } = parseTrancheRef(ref);
      const utxoOpt = selectedOption($("claim-utxo"));
      if (!utxoOpt || !utxoOpt.dataset.utxo) throw new Error("pick a UTXO to claim");
      const utxo = JSON.parse(utxoOpt.dataset.utxo);
      const secret = $("claim-secret").value;
      if (!secret) throw new Error("import the beneficiary secret");
      const signer = E.beneficiarySignerFor(secret, S.network, t.beneficiary, cur.schedule.beneficiaryMode);
      const destProgram = E.addressToProgram($("claim-dest").value, S.network);
      const feeRate = await feeRateFor("claim-feerate");
      const sweep = E.planClaimSweep({
        inputValue: utxo.value, feeRateGrainsPerVByte: feeRate,
        scriptLen: t.claimScript.length, controlLen: t.claimControlBlock.length,
      });
      S.claimPlan = { t, utxo, signerPriv: signer.priv, destProgram, feeRate, sweep, locktime: t.lock };
      reviewDl($("claim-review-dl"), [
        ["Tranche", `#${t.index + 1} · unlock ${fmtDate(t.lock)}`],
        ["Input", `${utxo.txid}:${utxo.vout} · ${grainsToPRL(utxo.value)} PRL`],
        ["Payout", `${grainsToPRL(sweep.payment)} PRL → ${$("claim-dest").value.slice(0, 24)}…`],
        ["Fee", `${sweep.fee} grains (${sweep.vBytes} vB @ ${feeRate} grains/vB)`],
        ["nLockTime", `${t.lock} (${fmtDate(t.lock)})`],
        ["Sequence", "0xfffffffe (non-final, CLTV satisfied)"],
      ]);
      $("claim-asm").textContent = E.scriptAsm(t.claimScript);
      $("claim-review").hidden = false;
    } catch (err) {
      showErr("claim-err", err.message);
    }
  });

  $("claim-sign").addEventListener("click", () => {
    hideErr("claim-err");
    try {
      const p = S.claimPlan;
      if (!p) throw new Error("plan the claim first");
      const signed = E.buildClaimTx({
        network: S.network, utxo: p.utxo, tranche: p.t,
        leaf: p.t.claimScript, controlBlock: p.t.claimControlBlock,
        signerPriv: p.signerPriv, destinationProgram: p.destProgram,
        feeRateGrainsPerVByte: p.feeRate,
      });
      S.claimPlan.signed = signed;
      reviewDl($("claim-signed-dl"), [
        ["TXID", signed.txid],
        ["Fee paid", `${signed.fee} grains`],
        ["Size", `${signed.vBytes} vB`],
        ["Signature", "verified locally against the leaf key before hex was produced"],
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

  /* ---------- CLAWBACK ---------- */
  $("claw-plan").addEventListener("click", async () => {
    hideErr("claw-err"); $("claw-review").hidden = true; $("claw-signed").hidden = true;
    try {
      const ref = $("claw-tranche").value;
      if (!ref) throw new Error("pick a matured tranche");
      const { cur, t } = parseTrancheRef(ref);
      if (!cur.schedule.revocable || !t.clawbackScript) throw new Error("this schedule is not revocable");
      const utxoOpt = selectedOption($("claw-utxo"));
      if (!utxoOpt || !utxoOpt.dataset.utxo) throw new Error("pick a UTXO to claw back");
      const utxo = JSON.parse(utxoOpt.dataset.utxo);
      const secret = $("claw-secret").value;
      if (!secret) throw new Error("import the funder secret");
      const words = secret.trim().split(/\s+/);
      let w;
      if (words.length === 12 || words.length === 24) w = E.walletFromMnemonic(secret, S.network);
      else { try { w = E.walletFromWIF(secret, S.network); } catch { throw new Error("funder secret must be a 12/24-word mnemonic or WIF"); } }
      if (E.bytesToHex(w.internalXOnly).toLowerCase() !== t.funder.toLowerCase()) {
        throw new Error("this key does not match the funder key in the schedule");
      }
      const destProgram = E.addressToProgram($("claw-dest").value, S.network);
      const feeRate = await feeRateFor("claw-feerate");
      const sweep = E.planClaimSweep({
        inputValue: utxo.value, feeRateGrainsPerVByte: feeRate,
        scriptLen: t.clawbackScript.length, controlLen: t.clawbackControlBlock.length,
      });
      S.clawPlan = { t, utxo, signerPriv: w.priv, destProgram, feeRate, sweep };
      reviewDl($("claw-review-dl"), [
        ["Tranche", `#${t.index + 1} · unlock ${fmtDate(t.lock)}`],
        ["Input", `${utxo.txid}:${utxo.vout} · ${grainsToPRL(utxo.value)} PRL`],
        ["Payout", `${grainsToPRL(sweep.payment)} PRL → ${$("claw-dest").value.slice(0, 24)}…`],
        ["Fee", `${sweep.fee} grains (${sweep.vBytes} vB @ ${feeRate} grains/vB)`],
        ["nLockTime", `${t.lock} (${fmtDate(t.lock)})`],
        ["Sequence", "0xfffffffe (non-final, CLTV satisfied)"],
      ]);
      $("claw-asm").textContent = E.scriptAsm(t.clawbackScript);
      $("claw-review").hidden = false;
    } catch (err) {
      showErr("claw-err", err.message);
    }
  });

  $("claw-sign").addEventListener("click", () => {
    hideErr("claw-err");
    try {
      const p = S.clawPlan;
      if (!p) throw new Error("plan the clawback first");
      const signed = E.buildClaimTx({
        network: S.network, utxo: p.utxo, tranche: p.t,
        leaf: p.t.clawbackScript, controlBlock: p.t.clawbackControlBlock,
        signerPriv: p.signerPriv, destinationProgram: p.destProgram,
        feeRateGrainsPerVByte: p.feeRate,
      });
      S.clawPlan.signed = signed;
      reviewDl($("claw-signed-dl"), [
        ["TXID", signed.txid],
        ["Fee paid", `${signed.fee} grains`],
        ["Size", `${signed.vBytes} vB`],
        ["Signature", "verified locally against the leaf key before hex was produced"],
      ]);
      $("claw-hex").value = signed.hex;
      $("claw-signed").hidden = false;
      $("claw-txid").hidden = true;
    } catch (err) {
      showErr("claw-err", err.message);
    }
  });

  $("claw-broadcast").addEventListener("click", async () => {
    hideErr("claw-err");
    try {
      const p = S.clawPlan;
      if (!p || !p.signed) throw new Error("sign first");
      const base = blockbookBase();
      const txid = await E.broadcastTx(base, p.signed.hex);
      const el = $("claw-txid");
      el.hidden = false;
      el.innerHTML = `Broadcast accepted — txid <code>${esc(txid || p.signed.txid)}</code>`;
      $("claw-secret").value = "";
      S.clawPlan.signerPriv = null;
    } catch (err) {
      showErr("claw-err", "Broadcast failed: " + err.message);
    }
  });

  $("claw-clear").addEventListener("click", () => {
    $("claw-secret").value = "";
    if (S.clawPlan) S.clawPlan.signerPriv = null;
  });

  /* prefill clawback destination when a funder mnemonic was used at forge time */
  $("claw-tranche").addEventListener("focus", () => {
    if (S.funderPrivHex && !$("claw-dest").value) {
      try {
        const w = E.walletFromMnemonic($("funder").value, S.network);
        $("claw-dest").value = E.encodeBech32m(S.network.hrp, 1, E.tweakKeypath(w.internalXOnly).tweakedX);
      } catch { /* funder input was x-only; leave blank */ }
    }
  });

  refreshClaimTrancheOptions();
})();
