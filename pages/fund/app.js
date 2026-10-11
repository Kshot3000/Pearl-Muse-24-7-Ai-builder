/* Pearl Fund page wiring — classic script, uses window.PearlFund bundle.
 *
 * Five steps: Launch a campaign -> Pledge -> Track funding -> Release (both
 * co-sign) -> Refund (unilateral, post-deadline). Secrets (mnemonics, WIFs,
 * private keys) live only in page memory between entry and Wipe; they are
 * never written to storage, never put in a URL, never sent anywhere.
 * Blockbook reads are GET-only; broadcasts are single explicit POSTs behind
 * double-confirm checkboxes.
 */
(function () {
  "use strict";
  const R = window.PearlFund;
  if (!R) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the Fund bundle.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const els = {
    network: $("network"), blockbook: $("blockbook"), feerate: $("feerate"),
    feeEstimate: $("fee-estimate"), cfgMsg: $("cfg-msg"),
    // launch
    lcRecipient: $("lc-recipient"), lcGoal: $("lc-goal"), lcDeadline: $("lc-deadline"),
    lcFetchHeight: $("lc-fetch-height"), lcPlus1440: $("lc-plus-1440"), lcHeightOut: $("lc-height-out"),
    lcKey: $("lc-key"), lcGenKey: $("lc-gen-key"), lcLaunch: $("lc-launch"),
    lcErr: $("lc-err"), lcKeyOut: $("lc-key-out"), lcOut: $("lc-out"),
    lcSummary: $("lc-summary"), lcDesc: $("lc-desc"), lcFingerprint: $("lc-fingerprint"), lcQr: $("lc-qr"),
    // pledge
    plDesc: $("pl-desc"), plFingerprint: $("pl-fingerprint"), plLoad: $("pl-load"), plErr: $("pl-err"),
    plCampaign: $("pl-campaign"), plSummary: $("pl-summary"),
    plBackerKey: $("pl-backer-key"), plGenKey: $("pl-gen-key"), plAmount: $("pl-amount"), plDerive: $("pl-derive"),
    plErr2: $("pl-err2"), plKeyOut: $("pl-key-out"), plOut: $("pl-out"),
    plAddress: $("pl-address"), plPledgeDesc: $("pl-pledge-desc"), plPledgeFp: $("pl-pledge-fp"), plQr: $("pl-qr"),
    plVerify: $("pl-verify"), plVerifyOut: $("pl-verify-out"),
    // track
    trDesc: $("tr-desc"), trFingerprint: $("tr-fingerprint"), trLoad: $("tr-load"),
    trPledges: $("tr-pledges"), trScan: $("tr-scan"), trScanMsg: $("tr-scan-msg"), trErr: $("tr-err"),
    trOut: $("tr-out"), trTotal: $("tr-total"), trTotalGrains: $("tr-total-grains"),
    trCount: $("tr-count"), trFunded: $("tr-funded"), trBlocks: $("tr-blocks"),
    trDeadline: $("tr-deadline"), trStatus: $("tr-status"), trGoalNote: $("tr-goal-note"),
    trBar: $("tr-bar"), trTbody: $("tr-tbody"),
    // release
    rlGate: $("rl-gate"), rlGateText: $("rl-gate-text"),
    rlDesc: $("rl-desc"), rlPledges: $("rl-pledges"), rlLoadScan: $("rl-load-scan"), rlScanMsg: $("rl-scan-msg"),
    rlErr: $("rl-err"), rlOut: $("rl-out"), rlTbody: $("rl-tbody"), rlToggleAll: $("rl-toggle-all"), rlBuild: $("rl-build"),
    rlBundleCard: $("rl-bundle-card"), rlBundleSummary: $("rl-bundle-summary"), rlBundle: $("rl-bundle"),
    rlImport: $("rl-import"), rlImportBtn: $("rl-import-btn"), rlErr2: $("rl-err2"),
    rlRecipKey: $("rl-recip-key"), rlCreatorKey: $("rl-creator-key"),
    rlSignRecip: $("rl-sign-recip"), rlSignCreator: $("rl-sign-creator"), rlStatus: $("rl-status"),
    rlFinalize: $("rl-finalize"), rlReviewWrap: $("rl-review-wrap"), rlReview: $("rl-review"),
    rlHex: $("rl-hex"), rlConfirm: $("rl-confirm"), rlBroadcast: $("rl-broadcast"), rlTxid: $("rl-txid"),
    // refund
    rfDesc: $("rf-desc"), rfFingerprint: $("rf-fingerprint"), rfKey: $("rf-key"), rfHeight: $("rf-height"),
    rfLoad: $("rf-load"), rfErr: $("rf-err"),
    rfRefusal: $("rf-refusal"), rfRefusalText: $("rf-refusal-text"),
    rfOut: $("rf-out"), rfSummary: $("rf-summary"), rfUtxo: $("rf-utxo"), rfBuild: $("rf-build"), rfErr2: $("rf-err2"),
    rfReviewWrap: $("rf-review-wrap"), rfReview: $("rf-review"), rfHex: $("rf-hex"),
    rfConfirm: $("rf-confirm"), rfBroadcast: $("rf-broadcast"), rfTxid: $("rf-txid"),
    // lockbar + footer
    wipe: $("wipe"), wipeMsg: $("wipe-msg"),
    donateAddr: $("donate-addr"),
  };

  if (R.DONATE_ADDRESS) els.donateAddr.textContent = R.DONATE_ADDRESS;

  const S = {
    network: null, base: null, lastDefaultBase: "",
    campaign: null,           // launch step result
    pledgeCampaign: null,     // pledge step campaign
    pledge: null, backerPrivHex: null,
    trackCampaign: null, trackSummary: null,
    release: null,            // { campaign, entries, feeRate }
    bundle: null, releaseSpend: null,
    refundPledge: null, refundBackerPrivHex: null, refundUtxos: null, refundHeight: null, refundTx: null,
  };

  /* ---------- small helpers ---------- */

  function showErr(el, msg) {
    el.textContent = msg;
    el.hidden = false;
    try { el.scrollIntoView({ block: "nearest" }); } catch { /* shim */ }
  }
  function hideErr(el) { el.hidden = true; el.textContent = ""; }

  function goStep(name) {
    ["launch", "pledge", "track", "release", "refund"].forEach((s) => {
      $("step-" + s).classList.toggle("active", s === name);
      const b = document.querySelector('#steps button[data-step="' + s + '"]');
      b.classList.toggle("active", s === name);
    });
  }
  document.querySelectorAll("#steps button").forEach((b) =>
    b.addEventListener("click", () => goStep(b.dataset.step)));

  function net() { return R.NETWORKS[els.network.value] || R.NETWORKS.mainnet; }

  function readBase(required) {
    const base = els.blockbook.value.trim().replace(/\/+$/, "");
    if (!base) {
      if (required) showErr(els.cfgMsg, "Set a Blockbook API endpoint first.");
      return null;
    }
    if (!/^https?:\/\//.test(base)) { showErr(els.cfgMsg, "Blockbook URL must start with http(s)://"); return null; }
    return base;
  }

  function fingerprint(descriptor) {
    const h = R.sha256(new TextEncoder().encode(String(descriptor).trim()));
    return R.bytesToHex(h).slice(0, 16);
  }

  function checkFingerprint(inputEl, descriptor, label) {
    const want = inputEl.value.trim();
    if (!want) return true; // optional, but the UI recommends it
    if (want.toLowerCase() !== fingerprint(descriptor)) {
      showErr(label, "FINGERPRINT MISMATCH — the descriptor does NOT match the expected fingerprint. " +
        "A single flipped character describes a different campaign. Refusing loudly; paste a fresh copy.");
      return false;
    }
    return true;
  }

  function grains(g) { return R.grainsToPRL(g) + " PRL"; }
  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function shortTxid(t) { return t.slice(0, 10) + "…" + t.slice(-6); }
  function shortKey(x) { return String(x).slice(0, 12) + "…" + String(x).slice(-8); }

  function kvRow(dl, k, v) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.appendChild(dt); dl.appendChild(dd);
  }

  function svgQr(el, text) {
    el.innerHTML = "";
    try {
      if (typeof window.qrcode === "undefined") return;
      const qr = window.qrcode(0, "M");
      qr.addData(text); qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 8, scalable: true });
    } catch { /* QR is a convenience; text is authoritative */ }
  }

  function copyText(text, note) {
    const done = () => { if (note) { note.textContent = "Copied."; setTimeout(() => { note.textContent = ""; }, 2000); } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => showErr(els.cfgMsg, "Copy failed — select the text manually."));
      } else {
        showErr(els.cfgMsg, "Clipboard unavailable — select the text manually.");
      }
    } catch { showErr(els.cfgMsg, "Clipboard unavailable — select the text manually."); }
  }
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
    const t = $(b.dataset.copy);
    if (!t) return;
    copyText(t.value !== undefined ? t.value : t.textContent, null);
  }));

  function readFeeRate() {
    const fr = Number(els.feerate.value);
    if (!Number.isFinite(fr) || fr <= 0) throw new Error("fee rate must be a positive number of grains/vB");
    return fr;
  }

  function wipeKeys() {
    for (const k of [els.lcKey, els.plBackerKey, els.rlRecipKey, els.rlCreatorKey, els.rfKey]) k.value = "";
    S.backerPrivHex = null; S.refundBackerPrivHex = null;
    els.wipeMsg.textContent = "Keys wiped from page memory.";
    setTimeout(() => { els.wipeMsg.textContent = ""; }, 4000);
  }

  /* ---------- config strip ---------- */

  function syncDefaultBase() {
    const n = net();
    if (!els.blockbook.value || els.blockbook.value === S.lastDefaultBase) {
      els.blockbook.value = n.blockbook || "";
    }
    S.lastDefaultBase = n.blockbook || "";
  }
  els.network.addEventListener("change", () => { S.network = net(); syncDefaultBase(); });
  S.network = net(); syncDefaultBase();

  els.feeEstimate.addEventListener("click", async () => {
    els.cfgMsg.textContent = "";
    const base = readBase(true);
    if (!base) return;
    els.feeEstimate.disabled = true;
    try {
      const perVb = await R.fetchFeeRateGrainsPerVByte(base);
      const ceil = Math.ceil(perVb);
      els.feerate.value = String(ceil);
      els.cfgMsg.textContent = `≈ ${ceil} grains/vB from Blockbook (raw ${perVb.toFixed(2)}).`;
    } catch (e) {
      els.cfgMsg.textContent = "Fee estimate unavailable: " + (e.message || e);
    } finally {
      els.feeEstimate.disabled = false;
    }
  });

  /* ---------- step 1: launch ---------- */

  els.lcFetchHeight.addEventListener("click", async () => {
    hideErr(els.lcErr);
    const base = readBase(true);
    if (!base) return;
    try {
      const h = await R.fetchChainHeight(base);
      els.lcHeightOut.textContent = "Chain height: " + h;
    } catch (e) { showErr(els.lcErr, "Could not fetch chain height: " + (e.message || e)); }
  });

  els.lcPlus1440.addEventListener("click", async () => {
    hideErr(els.lcErr);
    const base = readBase(true);
    if (!base) return;
    try {
      const h = await R.fetchChainHeight(base);
      els.lcDeadline.value = String(h + 1440);
      els.lcHeightOut.textContent = `Chain height ${h} → deadline ${h + 1440} (~10 days at 194 s/block).`;
    } catch (e) { showErr(els.lcErr, "Could not fetch chain height: " + (e.message || e)); }
  });

  els.lcGenKey.addEventListener("click", () => {
    const mn = R.newMnemonic();
    els.lcKey.value = mn;
    els.lcKeyOut.hidden = false;
    els.lcKeyOut.textContent = "Fresh creator key (12-word mnemonic) — back it up now; it is shown once and stays only in this page: " + mn;
  });

  els.lcLaunch.addEventListener("click", async () => {
    hideErr(els.lcErr);
    const network = net();
    els.lcLaunch.disabled = true;
    try {
      const base = els.blockbook.value.trim().replace(/\/+$/, "") || null;
      let currentHeight = null;
      if (base && /^https?:\/\//.test(base)) {
        try { currentHeight = await R.fetchChainHeight(base); }
        catch { /* future-check becomes the UI's honesty job */ }
      }
      /* Strict deadline parse: bare parseInt truncated "900000abc"/"900000.9"
       * to 900000 — a silently wrong CLTV deadline in the campaign descriptor. */
      const deadlineRaw = String(els.lcDeadline.value).trim();
      if (!/^\d+$/.test(deadlineRaw) || !Number.isSafeInteger(Number(deadlineRaw))) throw new Error("deadline must be a whole block height");
      const deadline = Number(deadlineRaw);
      const { campaign } = R.createCampaign({
        network,
        recipientAddr: els.lcRecipient.value,
        creatorKeyInput: els.lcKey.value,
        goalPRL: els.lcGoal.value,
        deadlineHeight: deadline,
        currentHeight,
      });
      S.campaign = campaign;
      els.lcSummary.innerHTML = "";
      kvRow(els.lcSummary, "Recipient", campaign.recipientAddr);
      kvRow(els.lcSummary, "Goal", grains(campaign.goalGrains) + ` (${campaign.goalGrains} grains)`);
      kvRow(els.lcSummary, "Deadline", String(campaign.deadlineHeight) + " (refunds unlock at this height)");
      kvRow(els.lcSummary, "Creator key", shortKey(campaign.creatorXOnlyHex) + " — " + (campaign.creatorSource || ""));
      kvRow(els.lcSummary, "Network", network.label);
      els.lcDesc.value = campaign.descriptor;
      els.lcFingerprint.textContent = fingerprint(campaign.descriptor);
      svgQr(els.lcQr, campaign.descriptor);
      els.lcOut.hidden = false;
      if (currentHeight !== null) {
        els.lcHeightOut.textContent = `Chain height ${currentHeight} — deadline is in the future.`;
      }
    } catch (e) {
      showErr(els.lcErr, "Launch refused: " + (e.message || e));
      els.lcOut.hidden = true;
    } finally {
      els.lcLaunch.disabled = false;
    }
  });

  /* ---------- step 2: pledge ---------- */

  els.plLoad.addEventListener("click", () => {
    hideErr(els.plErr);
    const network = net();
    try {
      const campaign = R.campaignFromDescriptor(els.plDesc.value, network);
      if (!checkFingerprint(els.plFingerprint, campaign.descriptor, els.plErr)) {
        els.plCampaign.hidden = true;
        return;
      }
      S.pledgeCampaign = campaign;
      els.plSummary.innerHTML = "";
      kvRow(els.plSummary, "Recipient", campaign.recipientAddr);
      kvRow(els.plSummary, "Goal", grains(campaign.goalGrains));
      kvRow(els.plSummary, "Deadline", String(campaign.deadlineHeight));
      kvRow(els.plSummary, "Creator", shortKey(campaign.creatorXOnlyHex));
      kvRow(els.plSummary, "Fingerprint", fingerprint(campaign.descriptor));
      els.plCampaign.hidden = false;
    } catch (e) {
      showErr(els.plErr, "Load refused: " + (e.message || e));
      els.plCampaign.hidden = true;
    }
  });

  els.plGenKey.addEventListener("click", () => {
    const mn = R.newMnemonic();
    els.plBackerKey.value = mn;
    els.plKeyOut.hidden = false;
    els.plKeyOut.textContent = "Fresh backer key (12-word mnemonic) — back it up now; it is your ONLY refund key: " + mn;
  });

  els.plDerive.addEventListener("click", async () => {
    hideErr(els.plErr2);
    const network = net();
    if (!S.pledgeCampaign) { showErr(els.plErr2, "Load a campaign first."); return; }
    els.plDerive.disabled = true;
    try {
      await new Promise((r) => setTimeout(r, 10)); // keep the key in a tight async scope
      const sk = R.secretKeyFromInput(els.plBackerKey.value, network);
      S.backerPrivHex = R.bytesToHex(sk.priv);
      const amountGrains = R.prlToGrains(els.plAmount.value);
      const pledge = R.createPledge({
        network,
        recipientAddr: S.pledgeCampaign.recipientAddr,
        creatorXOnly: S.pledgeCampaign.creatorXOnlyHex,
        goalGrains: S.pledgeCampaign.goalGrains,
        deadlineHeight: S.pledgeCampaign.deadlineHeight,
        backerXOnly: sk.xonly,
      });
      S.pledge = pledge;
      els.plAddress.value = pledge.address;
      els.plPledgeDesc.value = pledge.descriptor;
      els.plPledgeFp.textContent = fingerprint(pledge.descriptor);
      svgQr(els.plQr, pledge.address);
      let amountNote = $("pl-amount-note");
      if (!amountNote) {
        amountNote = document.createElement("p");
        amountNote.id = "pl-amount-note";
        amountNote.className = "hintline";
        els.plAddress.parentElement.after(amountNote);
      }
      amountNote.textContent = `Intended pledge: ${R.grainsToPRL(amountGrains)} PRL — fund the address above with this amount from your wallet (e.g. Pearl Sign). This page never moves funds on this step.`;
      els.plOut.hidden = false;
      els.plVerifyOut.textContent = "";
    } catch (e) {
      showErr(els.plErr2, "Derive refused: " + (e.message || e));
      els.plOut.hidden = true;
    } finally {
      els.plDerive.disabled = false;
    }
  });

  els.plVerify.addEventListener("click", () => {
    hideErr(els.plErr2);
    const network = net();
    try {
      const pledge = R.verifyPledgeAddress(els.plPledgeDesc.value, els.plAddress.value, network);
      els.plVerifyOut.textContent = "✓ Descriptor re-derives byte-for-byte to this address — untampered.";
      void pledge;
    } catch (e) {
      els.plVerifyOut.textContent = "";
      showErr(els.plErr2, "VERIFY FAILED: " + (e.message || e));
    }
  });

  /* ---------- step 3: track ---------- */

  els.trLoad.addEventListener("click", () => {
    hideErr(els.trErr);
    const network = net();
    try {
      const campaign = R.campaignFromDescriptor(els.trDesc.value, network);
      if (!checkFingerprint(els.trFingerprint, campaign.descriptor, els.trErr)) return;
      S.trackCampaign = campaign;
      els.trScanMsg.textContent = `Manifest loaded — goal ${grains(campaign.goalGrains)}, deadline ${campaign.deadlineHeight}.`;
    } catch (e) {
      showErr(els.trErr, "Load refused: " + (e.message || e));
    }
  });

  els.trScan.addEventListener("click", async () => {
    hideErr(els.trErr);
    const network = net();
    if (!S.trackCampaign) { showErr(els.trErr, "Load the campaign manifest first."); return; }
    const base = readBase(true);
    if (!base) return;
    const lines = els.trPledges.value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { showErr(els.trErr, "Paste at least one pledge descriptor."); return; }
    els.trScan.disabled = true;
    els.trScanMsg.textContent = "Scanning…";
    try {
      const height = await R.fetchChainHeight(base);
      const rows = [];
      for (const [i, line] of lines.entries()) {
        const { campaign, pledge } = R.pledgeFromDescriptor(line, network);
        if (campaign.descriptor !== S.trackCampaign.descriptor) {
          throw new Error(`pledge ${i + 1}: not from this campaign (descriptor round-trip mismatch)`);
        }
        const utxos = await R.fetchUtxos(base, pledge.address);
        let total = 0n;
        for (const u of utxos) total += BigInt(u.value);
        rows.push({ address: pledge.address, backer: pledge.backerXOnlyHex, utxos, totalValue: total });
      }
      const summary = R.summarizePledges(rows, S.trackCampaign.goalGrains, S.trackCampaign.deadlineHeight, height);
      S.trackSummary = summary;
      els.trTotal.textContent = summary.totalPRL + " PRL";
      els.trTotalGrains.textContent = summary.totalGrains + " grains";
      els.trCount.textContent = String(summary.backerCount);
      els.trFunded.textContent = summary.fundedCount + " funded";
      els.trBlocks.textContent = summary.matured ? "turned" : String(summary.blocksLeft);
      els.trDeadline.textContent = "deadline " + summary.deadlineHeight;
      els.trStatus.textContent = summary.goalMet ? "✓ Goal met" : "Funding…";
      els.trGoalNote.textContent = `goal ${summary.goalPRL} PRL · ${summary.progressPct.toFixed(2)}%`;
      els.trBar.style.width = Math.min(100, summary.progressPct).toFixed(2) + "%";
      els.trTbody.innerHTML = "";
      for (const r of summary.rows) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          `<td class="mono" title="${esc(r.address)}">${esc(r.address.slice(0, 14))}…${esc(r.address.slice(-8))}</td>` +
          `<td class="mono" title="${esc(r.backer)}">${esc(shortKey(r.backer))}</td>` +
          `<td class="mono">${grains(r.totalValue)}${r.totalValue === "0" ? " (unfunded)" : ""}</td>`;
        els.trTbody.appendChild(tr);
      }
      els.trOut.hidden = false;
      els.trScanMsg.textContent = `Scanned ${rows.length} pledge${rows.length === 1 ? "" : "s"} at height ${height}.`;
    } catch (e) {
      showErr(els.trErr, "Scan failed: " + (e.message || e));
      els.trOut.hidden = true;
    } finally {
      els.trScan.disabled = false;
    }
  });

  /* ---------- step 4: release ---------- */

  function renderReleaseRows() {
    els.rlTbody.innerHTML = "";
    S.release.entries.forEach((e, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><input type="checkbox" data-i="${i}" checked aria-label="include pledge UTXO"></td>` +
        `<td class="mono" title="${esc(e.address)}">${esc(e.address.slice(0, 14))}…${esc(e.address.slice(-8))}</td>` +
        `<td class="mono" title="${esc(e.txid)}">${esc(shortTxid(e.txid))}:${e.vout}</td>` +
        `<td class="mono">${grains(e.value)}</td>`;
      els.rlTbody.appendChild(tr);
    });
    els.rlToggleAll.checked = true;
  }

  els.rlLoadScan.addEventListener("click", async () => {
    hideErr(els.rlErr);
    const network = net();
    const base = readBase(true);
    if (!base) return;
    const lines = els.rlPledges.value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { showErr(els.rlErr, "Paste at least one funded pledge descriptor."); return; }
    let feeRate;
    try { feeRate = readFeeRate(); } catch (e) { showErr(els.rlErr, e.message); return; }
    els.rlLoadScan.disabled = true;
    els.rlScanMsg.textContent = "Loading + scanning…";
    try {
      const campaign = R.campaignFromDescriptor(els.rlDesc.value, network);
      const height = await R.fetchChainHeight(base);
      const entries = [];
      for (const [i, line] of lines.entries()) {
        const { campaign: pc, pledge } = R.pledgeFromDescriptor(line, network);
        if (pc.descriptor !== campaign.descriptor) {
          throw new Error(`pledge ${i + 1}: not from this campaign`);
        }
        const utxos = await R.fetchUtxos(base, pledge.address);
        for (const u of utxos) {
          entries.push({
            pledge, descriptor: line, address: pledge.address,
            txid: u.txid, vout: u.vout, value: u.value, confirmations: u.confirmations ?? 0,
          });
        }
      }
      if (!entries.length) throw new Error("no funded pledge UTXOs found — nothing to release yet");
      if (entries.length > R.MAX_RELEASE_INPUTS) {
        throw new Error(`too many pledge UTXOs (${entries.length}) — at most ${R.MAX_RELEASE_INPUTS} per release; split it`);
      }
      const total = entries.reduce((a, e) => a + BigInt(e.value), 0n);
      const goal = BigInt(campaign.goalGrains);
      S.release = { campaign, entries, feeRate, height };
      if (total < goal) {
        els.rlGate.hidden = false;
        els.rlGateText.textContent =
          `Pledged ${grains(total)} of the ${grains(goal)} goal at height ${height} — release is gated by the UI rule. ` +
          `Nothing on-chain stops an early co-signed release; this tab will not build one below the goal.`;
        els.rlOut.hidden = true;
        els.rlScanMsg.textContent = "";
        return;
      }
      els.rlGate.hidden = true;
      renderReleaseRows();
      els.rlOut.hidden = false;
      els.rlBundleCard.hidden = true;
      S.bundle = null;
      els.rlScanMsg.textContent =
        `Goal met: ${grains(total)} pledged across ${entries.length} UTXO${entries.length === 1 ? "" : "s"} (height ${height}).`;
    } catch (e) {
      showErr(els.rlErr, "Load + scan failed: " + (e.message || e));
      els.rlOut.hidden = true;
    } finally {
      els.rlLoadScan.disabled = false;
    }
  });

  els.rlToggleAll.addEventListener("change", () => {
    els.rlTbody.querySelectorAll("input[type=checkbox]").forEach((c) => { c.checked = els.rlToggleAll.checked; });
  });

  function selectedEntries() {
    const boxes = els.rlTbody.querySelectorAll("input[type=checkbox]");
    const out = [];
    boxes.forEach((c) => { if (c.checked) out.push(S.release.entries[Number(c.dataset.i)]); });
    return out;
  }

  function renderBundle() {
    const bundle = S.bundle;
    const campaign = R.campaignFromDescriptor(bundle.campaign, net());
    const d = R.describeBundle(bundle, campaign);
    const st = R.bundleStatus(bundle, campaign);
    els.rlBundleSummary.innerHTML = "";
    kvRow(els.rlBundleSummary, "Inputs", `${d.inputs} (${d.totalIn})`);
    kvRow(els.rlBundleSummary, "Recipient", d.recipient);
    kvRow(els.rlBundleSummary, "Payment", d.payment);
    kvRow(els.rlBundleSummary, "Fee", `${d.fee} (${d.vBytes} vBytes @ ${d.feeRate} grains/vB)`);
    els.rlBundle.value = JSON.stringify(bundle, null, 2);
    els.rlStatus.textContent =
      `Recipient ${st.recipientSigned ? "✓ signed" : "— pending"} · Creator ${st.creatorSigned ? "✓ signed" : "— pending"}` +
      (st.ready ? " · READY to finalize" : "");
    els.rlBundleCard.hidden = false;
  }

  els.rlBuild.addEventListener("click", () => {
    hideErr(els.rlErr);
    if (!S.release) { showErr(els.rlErr, "Load + scan funding first."); return; }
    const picked = selectedEntries();
    if (!picked.length) { showErr(els.rlErr, "Select at least one pledge UTXO."); return; }
    const network = net();
    try {
      const bundle = R.buildReleaseBundle({
        network,
        campaign: S.release.campaign,
        pledges: picked.map((e) => ({ pledge: e.pledge, utxo: { txid: e.txid, vout: e.vout, value: e.value } })),
        recipientAddr: S.release.campaign.recipientAddr,
        feeRateGrainsPerVByte: S.release.feeRate,
      });
      S.bundle = bundle;
      S.releaseSpend = null;
      els.rlReviewWrap.hidden = true;
      renderBundle();
    } catch (e) {
      showErr(els.rlErr, "Build refused: " + (e.message || e));
    }
  });

  els.rlImportBtn.addEventListener("click", () => {
    hideErr(els.rlErr2);
    if (!els.rlImport.value.trim()) { showErr(els.rlErr2, "Paste a bundle JSON first."); return; }
    try {
      const bundle = R.parseReleaseBundle(els.rlImport.value, net());
      // The imported bundle's own campaign replaces ours — it was fully re-derived + verified.
      S.release = S.release || {};
      S.bundle = bundle;
      S.releaseSpend = null;
      els.rlReviewWrap.hidden = true;
      renderBundle();
      hideErr(els.rlErr2);
    } catch (e) {
      showErr(els.rlErr2, "Import refused: " + (e.message || e));
    }
  });

  async function signBundle(inputEl, role) {
    hideErr(els.rlErr2);
    if (!S.bundle) { showErr(els.rlErr2, "Build or import a bundle first."); return; }
    const secretText = inputEl.value;
    if (!secretText.trim()) { showErr(els.rlErr2, `Paste the ${role} key.`); return; }
    try {
      await new Promise((r) => setTimeout(r, 10));
      const sk = R.secretKeyFromInput(secretText, net());
      const campaign = R.campaignFromDescriptor(S.bundle.campaign, net());
      R.signReleaseBundle(S.bundle, campaign, R.bytesToHex(sk.priv));
      renderBundle();
    } catch (e) {
      showErr(els.rlErr2, `Sign as ${role} refused: ` + (e.message || e));
    }
  }
  els.rlSignRecip.addEventListener("click", () => signBundle(els.rlRecipKey, "recipient"));
  els.rlSignCreator.addEventListener("click", () => signBundle(els.rlCreatorKey, "creator"));

  els.rlFinalize.addEventListener("click", () => {
    hideErr(els.rlErr2);
    if (!S.bundle) { showErr(els.rlErr2, "Build or import a bundle first."); return; }
    try {
      const network = net();
      const campaign = R.campaignFromDescriptor(S.bundle.campaign, network);
      const spend = R.finalizeReleaseBundle(S.bundle, campaign, network);
      S.releaseSpend = spend;
      els.rlReview.innerHTML = "";
      kvRow(els.rlReview, "Recipient", S.bundle.outputs[0].address);
      kvRow(els.rlReview, "Payment", grains(S.bundle.outputs[0].value));
      kvRow(els.rlReview, "Fee", grains(S.bundle.feeGrains) + ` (${spend.vBytes} vBytes)`);
      kvRow(els.rlReview, "Txid", spend.txid);
      kvRow(els.rlReview, "Both signatures", "re-verified at finalize");
      els.rlHex.value = spend.hex;
      els.rlConfirm.checked = false;
      els.rlBroadcast.disabled = true;
      els.rlReviewWrap.hidden = false;
    } catch (e) {
      showErr(els.rlErr2, "Finalize refused: " + (e.message || e));
    }
  });

  els.rlConfirm.addEventListener("change", () => {
    els.rlBroadcast.disabled = !els.rlConfirm.checked || !S.releaseSpend;
  });

  els.rlBroadcast.addEventListener("click", async () => {
    hideErr(els.rlErr2);
    if (!els.rlConfirm.checked) { showErr(els.rlErr2, "Tick the confirmation box first — broadcasting is final."); return; }
    if (!S.releaseSpend) { showErr(els.rlErr2, "Finalize the release first."); return; }
    const base = readBase(true);
    if (!base) return;
    els.rlBroadcast.disabled = true;
    try {
      const txid = await R.broadcastTx(base, S.releaseSpend.hex);
      els.rlTxid.textContent = "Broadcast accepted. Txid: " + txid;
      wipeKeys();
    } catch (e) {
      showErr(els.rlErr2, "Broadcast failed: " + (e.message || e));
    } finally {
      els.rlBroadcast.disabled = !els.rlConfirm.checked;
    }
  });

  /* ---------- step 5: refund ---------- */

  els.rfLoad.addEventListener("click", async () => {
    hideErr(els.rfErr);
    const network = net();
    const base = readBase(true);
    if (!base) return;
    els.rfLoad.disabled = true;
    try {
      const { pledge } = R.pledgeFromDescriptor(els.rfDesc.value, network);
      if (!checkFingerprint(els.rfFingerprint, pledge.descriptor, els.rfErr)) return;
      const sk = R.secretKeyFromInput(els.rfKey.value, network);
      if (R.bytesToHex(sk.xonly) !== pledge.backerXOnlyHex) {
        throw new Error("this key is not the backer of this pledge — refund refused");
      }
      S.refundPledge = pledge;
      S.refundBackerPrivHex = R.bytesToHex(sk.priv);
      let height = parseInt(String(els.rfHeight.value).trim(), 10);
      if (!Number.isSafeInteger(height) || height < 0) height = await R.fetchChainHeight(base);
      S.refundHeight = height;
      const utxos = await R.fetchUtxos(base, pledge.address);
      if (height < pledge.deadlineHeight) {
        els.rfRefusal.hidden = false;
        els.rfRefusalText.textContent =
          `Deadline height ${pledge.deadlineHeight}, chain is at ${height} (${pledge.deadlineHeight - height} blocks to go). ` +
          `The refund leaf is unspendable until the deadline — consensus would reject this transaction. Wait for the tide to turn.`;
        els.rfOut.hidden = true;
        return;
      }
      els.rfRefusal.hidden = true;
      if (!utxos.length) throw new Error("no UTXOs at this pledge address — nothing to refund");
      S.refundUtxos = utxos;
      els.rfSummary.innerHTML = "";
      kvRow(els.rfSummary, "Pledge address", pledge.address);
      kvRow(els.rfSummary, "Backer", shortKey(pledge.backerXOnlyHex) + " (your key ✓)");
      kvRow(els.rfSummary, "Deadline", `${pledge.deadlineHeight} — chain at ${height} (matured ✓)`);
      kvRow(els.rfSummary, "Refund pays to", "your own backer key — no destination to get wrong");
      els.rfUtxo.innerHTML = "";
      utxos.forEach((u, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = `${grains(u.value)} — ${shortTxid(u.txid)}:${u.vout} (${u.confirmations ?? 0} conf)`;
        els.rfUtxo.appendChild(o);
      });
      els.rfOut.hidden = false;
      els.rfReviewWrap.hidden = true;
      S.refundTx = null;
    } catch (e) {
      showErr(els.rfErr, "Load refused: " + (e.message || e));
      els.rfOut.hidden = true;
    } finally {
      els.rfLoad.disabled = false;
    }
  });

  els.rfBuild.addEventListener("click", async () => {
    hideErr(els.rfErr2);
    if (!S.refundPledge || !S.refundUtxos) { showErr(els.rfErr2, "Load the pledge first."); return; }
    let feeRate;
    try { feeRate = readFeeRate(); } catch (e) { showErr(els.rfErr2, e.message); return; }
    els.rfBuild.disabled = true;
    try {
      await new Promise((r) => setTimeout(r, 10));
      const u = S.refundUtxos[Number(els.rfUtxo.value) || 0];
      const tx = R.buildRefundTx({
        network: net(),
        pledge: S.refundPledge,
        utxo: { txid: u.txid, vout: u.vout, value: u.value },
        backerPriv: S.refundBackerPrivHex,
        feeRateGrainsPerVByte: feeRate,
        currentHeight: S.refundHeight,
      });
      S.refundTx = tx;
      els.rfReview.innerHTML = "";
      kvRow(els.rfReview, "Refund to", tx.refundAddress);
      kvRow(els.rfReview, "Payment", grains(tx.payment));
      kvRow(els.rfReview, "Fee", grains(tx.fee) + ` (${tx.vBytes} vBytes)`);
      kvRow(els.rfReview, "nLockTime", String(tx.locktime));
      kvRow(els.rfReview, "Txid", tx.txid);
      kvRow(els.rfReview, "Signature", "re-verified locally");
      els.rfHex.value = tx.hex;
      els.rfConfirm.checked = false;
      els.rfBroadcast.disabled = true;
      els.rfReviewWrap.hidden = false;
    } catch (e) {
      showErr(els.rfErr2, "Build refused: " + (e.message || e));
    } finally {
      els.rfBuild.disabled = false;
    }
  });

  els.rfConfirm.addEventListener("change", () => {
    els.rfBroadcast.disabled = !els.rfConfirm.checked || !S.refundTx;
  });

  els.rfBroadcast.addEventListener("click", async () => {
    hideErr(els.rfErr2);
    if (!els.rfConfirm.checked) { showErr(els.rfErr2, "Tick the confirmation box first — broadcasting is final."); return; }
    if (!S.refundTx) { showErr(els.rfErr2, "Build the refund first."); return; }
    const base = readBase(true);
    if (!base) return;
    els.rfBroadcast.disabled = true;
    try {
      const txid = await R.broadcastTx(base, S.refundTx.hex);
      els.rfTxid.textContent = "Broadcast accepted. Txid: " + txid;
      wipeKeys();
    } catch (e) {
      showErr(els.rfErr2, "Broadcast failed: " + (e.message || e));
    } finally {
      els.rfBroadcast.disabled = !els.rfConfirm.checked;
    }
  });

  /* ---------- lockbar ---------- */

  els.wipe.addEventListener("click", wipeKeys);

  // expose a tiny hook for the DOM test suite (harmless in production)
  window.__fundTest = { state: S, goStep, net };
})();
