/* Pearl Subscribe — standing-order desk. All crypto runs locally; the page only
 * reads the chain (GET) and broadcasts at your explicit click. Keys are wiped
 * the moment signing finishes and are never stored. */
(() => {
  "use strict";
  const E = window.PearlSubscribe;
  if (!E) {
    document.body.innerHTML = "<p style='padding:2rem'>Pearl Subscribe failed to load (pearl-subscribe.bundle.js missing). Check the console.</p>";
    return;
  }
  const $ = (id) => document.getElementById(id);
  /** Escape for innerHTML interpolation — verifier output strings are built
   * from pasted, counterparty-supplied bundles and must render as text. */
  const esc = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  /* storage that survives hostile localStorage (Gallery lesson) */
  const store = {
    m: {},
    get(k) { try { return localStorage.getItem(k); } catch { return this.m[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { this.m[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch { delete this.m[k]; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: store.get("subscribe.blockbook") || E.NETWORKS.mainnet.blockbook,
    terms: null, descriptor: null, plans: null,
    fundingTxid: "", fundingHex: "",
    payments: [], bundleJson: "",
  };

  const showErr = (id, msg) => { const e = $(id); e.textContent = msg; e.hidden = false; };
  const hideErr = (id) => { $(id).hidden = true; };
  const copyText = async (t) => {
    try { await navigator.clipboard.writeText(t); return true; }
    catch { const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch {} ta.remove(); return true; }
  };
  const download = (name, text) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const shortAddr = (a) => a.length > 24 ? a.slice(0, 12) + "…" + a.slice(-10) : a;
  const approxDate = (height, tipH, tipMs) => {
    if (!Number.isInteger(tipH) || !tipMs) return "—";
    return new Date(tipMs + (height - tipH) * E.BLOCK_TIME_S * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  /* ---------- step navigation ---------- */
  const steps = ["service", "terms", "fund", "presign", "track", "cancel", "verify"];
  function goto(step) {
    for (const s of steps) {
      $("step-" + s).classList.toggle("active", s === step);
      document.querySelector(`#steps button[data-step="${s}"]`).classList.toggle("active", s === step);
    }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("#steps button").forEach((b) =>
    b.addEventListener("click", () => goto(b.dataset.step)));

  /* Strict integer field parse: bare parseInt truncated "445abc" to 445,
   * "512340.9" to 512340 and "5abc" to 5 — silently wrong terms baked into
   * the fingerprinted descriptor and the presigned locktime schedule. */
  function strictIntField(id, label) {
    const raw = $(id).value.trim();
    if (!/^\d+$/.test(raw)) throw new Error(label + " must be a whole number");
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new Error(label + " must be a whole number");
    return n;
  }

  function readTerms() {
    const periodSel = $("sub-period").value;
    const periodBlocks = periodSel === "custom"
      ? strictIntField("sub-period-custom", "custom period")
      : parseInt(periodSel, 10);
    const netKey = $("network").value;
    return {
      network: netKey,
      merchant: $("sub-merchant").value.trim(),
      anchor: $("sub-anchor").value.trim(),
      amountGrains: Number(E.parsePRL($("sub-amount").value.trim() || "0")),
      periodBlocks,
      periods: strictIntField("sub-periods", "periods"),
      startHeight: strictIntField("sub-start", "start height"),
      feeRate: strictIntField("sub-feerate", "fee rate"),
    };
  }

  /* ---------- step 1: service ---------- */
  $("sub-period").addEventListener("change", () => {
    $("sub-period-custom-wrap").hidden = $("sub-period").value !== "custom";
  });
  $("network").addEventListener("change", () => {
    S.network = E.NETWORKS[$("network").value];
    if (!$("blockbook").value.trim()) $("blockbook").placeholder = S.network.blockbook || "your blockbook URL";
  });
  const bbBase = () => $("blockbook").value.trim() || S.network.blockbook || "";
  $("blockbook").value = S.blockbook;

  $("sub-start-tip").addEventListener("click", async () => {
    const base = bbBase();
    if (!base) { showErr("service-err", "no Blockbook URL configured — enter one above or type the start height manually"); return; }
    hideErr("service-err");
    try {
      const tip = await E.fetchBlockbookTip(base);
      $("sub-start").value = String(tip + 144);
      store.set("subscribe.blockbook", base);
    } catch (e) { showErr("service-err", "could not read tip: " + e.message); }
  });

  $("service-next").addEventListener("click", () => {
    hideErr("service-err");
    let made;
    try {
      const terms = readTerms();
      made = E.makeDescriptor(terms);
    } catch (e) { showErr("service-err", e.message); return; }
    S.terms = made.descriptor; S.network = made.network;
    S.descriptor = made;
    store.set("subscribe.blockbook", bbBase());
    renderTerms(null, null);
    document.querySelector('#steps button[data-step="terms"]').classList.add("done");
    goto("terms");
  });

  /* ---------- step 2: terms ---------- */
  function renderTerms(tipH, tipMs) {
    const d = S.descriptor;
    $("terms-fp").textContent = d.fingerprint;
    $("terms-merchant-total").textContent = E.fmtPRL(BigInt(d.descriptor.amountGrains) * BigInt(d.descriptor.periods)) + " PRL";
    const plan = E.planFunding(d.descriptor);
    S.plans = plan;
    $("terms-funding-total").textContent = E.fmtPRL(plan.totalGrains) + " PRL";
    $("terms-schedule-note").textContent = `${d.descriptor.periods} payments, every ${d.descriptor.periodBlocks} blocks`;
    $("terms-body").innerHTML = d.schedule.map((h, i) =>
      `<tr><td class="num">${i + 1}</td><td class="num">${h}</td><td>${approxDate(h, tipH, tipMs)}</td>` +
      `<td class="num">${E.fmtPRL(BigInt(d.descriptor.amountGrains))} PRL</td></tr>`).join("");
    $("terms-desc").value = JSON.stringify(d.descriptor, null, 2);
  }
  $("terms-fp-copy").addEventListener("click", () => copyText($("terms-fp").textContent));
  $("terms-copy").addEventListener("click", () => copyText($("terms-desc").value));
  $("terms-download").addEventListener("click", () => download("pearl-sub-descriptor.json", $("terms-desc").value));
  $("terms-back").addEventListener("click", () => goto("service"));
  $("terms-next").addEventListener("click", () => { renderFund(); goto("fund"); });

  /* ---------- step 3: fund ---------- */
  function renderFund() {
    const plan = S.plans;
    $("fund-nout").textContent = plan.outputs.length + " outputs → " + shortAddr(S.terms.anchor);
    $("fund-perout").textContent = E.fmtPRL(plan.perOutputGrains) + ` PRL (amount + ${E.fmtPRL(plan.feeReserveGrains)} fee reserve)`;
    $("fund-total").textContent = E.fmtPRL(plan.totalGrains) + " PRL";
    $("fund-body").innerHTML = plan.outputs.map((o, i) =>
      `<tr><td class="num">${o.vout}</td><td class="addr">${shortAddr(o.address)}</td>` +
      `<td class="num">${E.fmtPRL(o.value)} PRL</td><td class="num">period ${i + 1}</td></tr>`).join("");
    $("fund-broadcast").disabled = true;
    $("fund-out").hidden = true;
  }

  $("fund-scan").addEventListener("click", async () => {
    hideErr("fund-err");
    const base = bbBase();
    if (!base) { showErr("fund-err", "no Blockbook URL configured"); return; }
    try {
      const utxos = await E.fetchUtxos(base, S.terms.anchor);
      $("fund-utxos").value = utxos.map((u) => `${u.txid}:${u.vout}:${u.value}`).join("\n");
    } catch (e) { showErr("fund-err", "scan failed: " + e.message); }
  });

  function readUtxos() {
    const text = $("fund-utxos").value.trim();
    if (!text) throw new Error("no UTXOs — scan via Blockbook or paste txid:vout:value-grains lines");
    try {
      const parsed = E.parseUtxoList(text, S.network);
      if (parsed.length) return parsed.map((u) => ({ ...u, value: BigInt(u.value) }));
    } catch {}
    return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [txid, vout, value] = l.split(":");
      if (!/^[0-9a-f]{64}$/i.test(txid || "") || !/^\d+$/.test(vout || "") || !/^\d+$/.test(value || "")) {
        throw new Error("bad UTXO line (want txid:vout:value-grains): " + l.slice(0, 40));
      }
      return { txid: txid.toLowerCase(), vout: parseInt(vout, 10), value: BigInt(value), confirmations: 1 };
    });
  }

  $("fund-build").addEventListener("click", async () => {
    hideErr("fund-err");
    $("fund-broadcast").disabled = true; $("fund-out").hidden = true;
    let key;
    try {
      const utxos = readUtxos();
      const plan = S.plans;
      const feeRate = S.terms.feeRate;
      const sel = E.selectCoins(utxos, plan.totalGrains, feeRate, plan.outputs.length);
      if (sel.change > 0n && sel.change < BigInt(E.DUST_GRAIN)) {
        throw new Error(`change ${sel.change} grains would be dust — add a larger UTXO or accept it into fees (not implemented: refusing instead)`);
      }
      key = E.subscriberKeyFromInput($("fund-key").value, S.network);
      E.assertKeyMatchesAnchor(key, S.terms.anchor, S.network);
      const anchorProg = E.addressToProgram(S.terms.anchor, S.network);
      const anchorSpk = E.p2trScriptPubKey(anchorProg);
      const outs = plan.outputs.map((o) => ({ program: anchorProg, value: Number(o.value) }));
      if (sel.change > 0n) outs.push({ program: anchorProg, value: Number(sel.change) });
      const built = E.buildKeypathTxEx(S.network,
        sel.selected.map((u) => ({ txid: u.txid, vout: u.vout, value: Number(u.value), spk: anchorSpk, priv: key.priv, internalXOnly: key.internalXOnly })),
        outs);
      // re-verify every signature against the wire before showing hex
      const fvr = E.verifySignedTx(S.network, built.hex,
        sel.selected.map((u) => ({ value: Number(u.value), spk: anchorSpk })));
      if (!fvr.every((r) => r.ok)) throw new Error("funding signature failed re-verification — refusing: " + fvr.map((r) => r.reason).join("; "));
      $("fund-txid").textContent = built.txid;
      $("fund-hex").value = built.hex;
      S.fundingTxid = built.txid; S.fundingHex = built.hex;
      $("fund-out").hidden = false;
      $("fund-broadcast").disabled = false;
      document.querySelector('#steps button[data-step="fund"]').classList.add("done");
    } catch (e) { showErr("fund-err", e.message); }
    finally { if (key) E.wipeKey(key); $("fund-key").value = ""; }
  });

  $("fund-broadcast").addEventListener("click", async () => {
    hideErr("fund-err");
    const base = bbBase();
    if (!base) { showErr("fund-err", "no Blockbook URL configured"); return; }
    try {
      const txid = await E.broadcastTx(base, S.fundingHex);
      $("fund-txid").textContent = String(txid || S.fundingTxid);
      S.fundingTxid = String(txid || S.fundingTxid);
      $("ps-funding-txid").value = S.fundingTxid;
      $("tr-funding-txid").value = S.fundingTxid;
      $("cx-funding-txid").value = S.fundingTxid;
    } catch (e) { showErr("fund-err", "broadcast failed: " + e.message); }
  });
  $("fund-back").addEventListener("click", () => goto("terms"));
  $("fund-next").addEventListener("click", () => {
    if (S.fundingTxid) { $("ps-funding-txid").value = S.fundingTxid; }
    renderCancelPeriods();
    goto("presign");
  });

  /* ---------- step 4: pre-sign ---------- */
  function paymentPlans() {
    const txid = $("ps-funding-txid").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("funding txid must be 64 hex chars");
    S.fundingTxid = txid;
    return { txid, plans: S.descriptor.schedule.map((_, i) => E.paymentTxPlan(S.terms, txid, i)) };
  }
  $("ps-plans").addEventListener("click", () => {
    hideErr("ps-err");
    try {
      const { plans } = paymentPlans();
      $("ps-body").innerHTML = plans.map((p) =>
        `<tr><td class="num">${p.period}</td><td class="num">${p.locktime}</td>` +
        `<td class="addr">${p.txid.slice(0, 20)}…</td><td class="num">${E.fmtPRL(BigInt(p.feeGrains))} PRL</td></tr>`).join("");
    } catch (e) { showErr("ps-err", e.message); }
  });
  $("ps-sign").addEventListener("click", () => {
    hideErr("ps-err"); $("ps-out").hidden = true;
    let key;
    try {
      const { txid } = paymentPlans();
      key = E.subscriberKeyFromInput($("ps-key").value, S.network);
      const { payments } = E.signPaymentTxs(S.terms, txid, key);
      key = null; // signPaymentTxs wipes
      S.payments = payments;
      const { bundle, json } = E.makeSignedBundle(S.terms, txid, payments);
      S.bundleJson = json;
      $("ps-bundle").value = json;
      $("ps-out").hidden = false;
      document.querySelector('#steps button[data-step="presign"]').classList.add("done");
    } catch (e) { showErr("ps-err", e.message); }
    finally { if (key) E.wipeKey(key); $("ps-key").value = ""; }
  });
  $("ps-copy").addEventListener("click", () => copyText($("ps-bundle").value));
  $("ps-download").addEventListener("click", () => download("pearl-sub-bundle.json", $("ps-bundle").value));
  $("ps-back").addEventListener("click", () => goto("fund"));
  $("ps-next").addEventListener("click", () => {
    $("tr-desc").value = $("terms-desc").value;
    $("tr-funding-txid").value = S.fundingTxid;
    goto("track");
  });

  /* ---------- step 5: track ---------- */
  $("tr-load-mine").addEventListener("click", () => {
    $("tr-desc").value = $("terms-desc").value || "";
    $("tr-funding-txid").value = S.fundingTxid || "";
  });
  $("tr-run").addEventListener("click", async () => {
    hideErr("tr-err");
    $("tr-body").innerHTML = "";
    let desc;
    try { desc = E.parseDescriptor($("tr-desc").value.trim()); }
    catch (e) { showErr("tr-err", e.message); return; }
    const fundingTxid = $("tr-funding-txid").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fundingTxid)) { showErr("tr-err", "funding txid must be 64 hex chars"); return; }
    const base = bbBase();
    if (!base) { showErr("tr-err", "no Blockbook URL configured — the ledger needs a chain source"); return; }
    try {
      const [tip, detail] = await Promise.all([
        E.fetchBlockbookTip(base),
        E.fetchTxDetail(base, fundingTxid),
      ]);
      $("tr-tip").textContent = `tip ${tip}`;
      const expected = S.payments.length === desc.descriptor.periods && S.fundingTxid === fundingTxid
        ? S.payments.map((p) => p.txid) : null;
      const rows = E.periodStatuses(desc.descriptor, detail, tip, expected);
      const nowMs = Date.now();
      $("tr-body").innerHTML = rows.map((r) =>
        `<tr><td class="num">${r.period}</td><td class="num">${r.locktime}</td><td>${approxDate(r.locktime, tip, nowMs)}</td>` +
        `<td><span class="pill ${r.state}">${r.state}</span></td><td class="hint">${r.note}</td></tr>`).join("");
      renderTerms(tip, nowMs);
    } catch (e) { showErr("tr-err", "chain read failed: " + e.message); }
  });

  /* ---------- step 6: cancel ---------- */
  function renderCancelPeriods() {
    const n = S.terms ? S.terms.periods : 12;
    $("cx-period").innerHTML = Array.from({ length: n }, (_, i) =>
      `<option value="${i}">Period ${i + 1}</option>`).join("");
  }
  renderCancelPeriods();
  $("cx-build").addEventListener("click", () => {
    hideErr("cx-err"); $("cx-out").hidden = true; $("cx-broadcast").disabled = true;
    let key;
    try {
      const fundingTxid = $("cx-funding-txid").value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(fundingTxid)) throw new Error("funding txid must be 64 hex chars");
      if (!S.terms) throw new Error("no subscription terms loaded — complete steps 1–2 first");
      key = E.subscriberKeyFromInput($("cx-key").value, S.network);
      const idx = parseInt($("cx-period").value, 10);
      const { txid, hex, feeGrains, reclaimedGrains } = E.buildCancelTx(S.terms, fundingTxid, idx, key);
      key = null; // buildCancelTx wipes
      $("cx-txid").textContent = txid;
      $("cx-reclaimed").textContent = `${E.fmtPRL(BigInt(reclaimedGrains))} PRL (fee ${E.fmtPRL(BigInt(feeGrains))} PRL)`;
      $("cx-hex").value = hex;
      S._cancelHex = hex;
      $("cx-out").hidden = false;
      $("cx-broadcast").disabled = false;
    } catch (e) { showErr("cx-err", e.message); }
    finally { if (key) E.wipeKey(key); $("cx-key").value = ""; }
  });
  $("cx-broadcast").addEventListener("click", async () => {
    hideErr("cx-err");
    const base = bbBase();
    if (!base) { showErr("cx-err", "no Blockbook URL configured"); return; }
    try { await E.broadcastTx(base, S._cancelHex); showErr("cx-err", ""); $("cx-err").hidden = true; }
    catch (e) { showErr("cx-err", "broadcast failed: " + e.message); }
  });

  /* ---------- step 7: verify ---------- */
  $("vf-load-mine").addEventListener("click", () => { $("vf-input").value = S.bundleJson || ""; });
  $("vf-run").addEventListener("click", () => {
    hideErr("vf-err");
    $("vf-out").hidden = true; $("vf-checks").innerHTML = "";
    let res;
    try { res = E.verifySignedBundle($("vf-input").value.trim()); }
    catch (e) { showErr("vf-err", e.message); return; }
    const box = $("vf-out");
    box.hidden = false;
    box.className = "verdict " + (res.ok ? "proven" : "invalid");
    box.innerHTML = `<p class="stamp">${res.ok ? "Bundle verified" : "Bundle invalid"}</p>` +
      `<p class="sub">${res.checks.length} checks passed${res.failures.length ? `, ${res.failures.length} failed` : ""} — ` +
      `descriptor, locktimes, amounts, change outputs, sequences, and every BIP-341 signature re-checked.</p>`;
    $("vf-checks").innerHTML =
      res.checks.map((c) => `<li class="ok">✓ ${esc(c)}</li>`).join("") +
      res.failures.map((f) => `<li class="bad">✗ ${esc(f)}</li>`).join("");
  });

  /* ---------- footer ---------- */
  document.querySelectorAll(".copy-btn").forEach((b) =>
    b.addEventListener("click", () => copyText($(b.dataset.for).textContent)));
})();
