/* Pearl Channels UI — the switchboard desk.
 * Classic script; uses window.PearlChannels (pearl-channels.bundle.js).
 * Keys live in memory only and are wiped after use; descriptors and
 * non-secret state persist in localStorage. */
(function () {
  "use strict";
  const P = window.PearlChannels;
  const $ = (id) => document.getElementById(id);
  const NET = "mainnet";

  const S = {
    chan: null,
    fundingTxid: null,
    fundingVout: 0,
    myPayoutAddr: "",
    blockbook: "",
    key: null, // { priv: Uint8Array, xonly: hex } — memory only
    states: [], // active + history
    proposal: null, // pending state being exchanged
    coop: null,
    claim: null,
  };

  /* ---------- helpers ---------- */
  function showError(boxId, e) {
    const b = $(boxId);
    b.hidden = false;
    b.textContent = "Error: " + (e && e.message ? e.message : e);
  }
  function clearError(boxId) { const b = $(boxId); b.hidden = true; b.textContent = ""; }
  function parseVoutField(id) {
    const raw = $(id).value.trim();
    if (!/^\d+$/.test(raw)) throw new Error("funding vout must be a non-negative integer");
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new Error("funding vout must be a non-negative integer");
    return n;
  }
  /* Strict CSV-delay parse: bare parseInt truncated "1e2" to 1 and "144.9"
   * to 144 — a silently shrunk dispute window. Digits only, like the vouts. */
  function parseCsvField() {
    const raw = $("open-csv").value.trim();
    if (!/^\d+$/.test(raw)) throw new Error("CSV delay must be a whole number of blocks");
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new Error("CSV delay must be a whole number of blocks");
    return n;
  }
  function grainsToPRL(g) { return P.fmtPRL(g) + " PRL"; }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function copyText(t, btn) {
    navigator.clipboard.writeText(t).then(() => {
      const old = btn.textContent; btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = old; }, 1200);
    });
  }
  function goStep(name) {
    document.querySelectorAll("#steps button").forEach((b) => {
      b.classList.toggle("active", b.dataset.step === name);
    });
    document.querySelectorAll("main .panel").forEach((p) => {
      p.classList.toggle("active", p.id === "step-" + name);
    });
  }
  document.querySelectorAll("#steps button").forEach((b) => {
    b.addEventListener("click", () => { if (!b.disabled) goStep(b.dataset.step); });
  });
  function enableSteps() {
    const hasChan = !!S.chan;
    const funded = hasChan && !!S.fundingTxid;
    const set = (name, disabled) => {
      const steps = $("steps");
      const b = steps && steps.querySelector ? steps.querySelector('[data-step="' + name + '"]') : null;
      if (b) b.disabled = disabled;
    };
    set("fund", !hasChan);
    set("state", !funded);
    set("close", !funded);
    set("track", !hasChan);
  }

  /** Resolve a signing key from user input and check it matches the channel. */
  function keyFromInput(input) {
    const t = String(input || "").trim();
    if (!t) throw new Error("enter your key to sign");
    if (!S.chan) throw new Error("open or restore a channel first");
    let priv, xonly;
    if (/^[0-9a-fA-F]{64}$/.test(t)) {
      priv = P.hexToBytes(t.toLowerCase());
      xonly = P.bytesToHex(P.schnorr.getPublicKey(priv));
    } else {
      const w = P.walletFromMnemonic(t, P.NETWORKS[NET]);
      priv = w.priv; xonly = P.bytesToHex(w.internalXOnly);
    }
    if (xonly !== S.chan.aXOnly.toLowerCase()) {
      if (priv) priv.fill(0);
      throw new Error("this key does not match the channel's party-A key");
    }
    S.key = { priv, xonly };
    return S.key;
  }
  function wipeKey() {
    if (S.key && S.key.priv) S.key.priv.fill(0);
    S.key = null;
    for (const id of ["fund-key", "pay-key", "close-coop-key", "close-uni-key"]) {
      const el = $(id); if (el) el.value = "";
    }
  }

  function activeState() { return S.states.find((s) => s.active) || null; }

  function renderStateCard() {
    const st = activeState();
    const card = $("state-current");
    if (!st) { card.hidden = true; return; }
    card.hidden = false;
    $("state-version").textContent = "State " + st.version + (st.revoked ? " (revoked)" : " — ACTIVE");
    $("state-fp").textContent = "fp " + (st.pair ? st.pair.mine.fingerprint : "genesis");
    const cap = Number(BigInt(S.chan.capacity));
    const minePct = (Number(BigInt(st.myBal)) / cap) * 100;
    $("state-minebar").style.width = minePct + "%";
    $("state-peerbar").style.width = (100 - minePct) + "%";
    $("state-minelabel").textContent = "You: " + grainsToPRL(st.myBal);
    $("state-peerlabel").textContent = "Peer: " + grainsToPRL(st.peerBal);
    const both = st.signed.mine && st.signed.theirs;
    $("state-sigs").innerHTML =
      `Signatures — you: <span class="${st.mySigs.mine && st.mySigs.theirs ? "ok" : "no"}">${st.mySigs.mine && st.mySigs.theirs ? "both copies ✓" : "missing"}</span>` +
      ` · peer: <span class="${st.peerSigs.mine && st.peerSigs.theirs ? "ok" : "no"}">${st.peerSigs.mine && st.peerSigs.theirs ? "both copies ✓" : "missing"}</span>` +
      ` · assembled: <span class="${both ? "ok" : "no"}">${both ? "yes ✓" : "no"}</span>`;
  }
  function renderHistory() {
    const box = $("state-historylist");
    box.innerHTML = "";
    for (const st of S.states) {
      const row = document.createElement("div");
      row.className = "hrow" + (st.active ? " active" : "") + (st.revoked ? " revoked" : "");
      row.textContent = `v${st.version} · you ${grainsToPRL(st.myBal)} / peer ${grainsToPRL(st.peerBal)}` +
        (st.active ? " · ACTIVE" : st.revoked ? " · revoked" : "");
      box.appendChild(row);
    }
    if (!S.states.length) box.innerHTML = '<div class="hrow">No states yet — the funding output is state 0 once funded.</div>';
  }

  /* ---------- STEP 1: open ---------- */
  function setChannel(chan, myPayoutAddr) {
    S.chan = chan;
    S.myPayoutAddr = myPayoutAddr;
    try {
      localStorage.setItem("pearl-channels.descriptor", JSON.stringify(chan));
      localStorage.setItem("pearl-channels.mypayout", myPayoutAddr);
    } catch { /* private mode */ }
    enableSteps();
    renderStateCard(); renderHistory();
  }

  $("open-build").addEventListener("click", () => {
    clearError("open-error");
    try {
      const myKeyInput = $("open-mykey").value;
      const peerXOnlyHex = $("open-peerkey").value.trim();
      const myPayoutAddr = $("open-mypayout").value.trim();
      const peerPayoutAddr = $("open-peerpayout").value.trim();
      if (!myPayoutAddr) throw new Error("your payout address is required");
      P.payoutProgram(myPayoutAddr, P.NETWORKS[NET]); // validates
      const chan = P.openChannel({
        myKeyInput,
        peerXOnlyHex,
        peerPayoutAddr,
        myCapacityGrains: P.parsePRL($("open-mycap").value || "0"),
        peerCapacityGrains: P.parsePRL($("open-peercap").value || "0"),
        csvDelay: parseCsvField(),
        networkId: NET,
      });
      setChannel(chan, myPayoutAddr);
      $("open-result").hidden = false;
      $("open-address").textContent = chan.address;
      $("open-shortdesc").textContent = P.shortDescriptor(chan);
      $("open-fp").textContent = P.channelFingerprint(chan);
      $("open-cap").textContent = grainsToPRL(chan.capacity) + ` (you ${grainsToPRL(chan.myCapacity)} / peer ${grainsToPRL(chan.peerCapacity)})`;
      $("open-csvshow").textContent = chan.csvDelay + " blocks";
      $("open-script").textContent = P.scriptAsm(P.hexToBytes(chan.fundingScript));
      $("open-descriptor").textContent = JSON.stringify(chan, null, 2);
      $("fund-feerate").value = $("open-feerate").value;
      $("pay-feerate").value = $("open-feerate").value;
      goStep("fund");
    } catch (e) { showError("open-error", e); }
  });
  $("open-copydesc").addEventListener("click", (e) => copyText($("open-descriptor").textContent, e.target));
  $("open-dl").addEventListener("click", () => download("pearl-channel-descriptor.json", $("open-descriptor").textContent));
  $("open-restore").addEventListener("click", () => { $("open-restorebox").hidden = !$("open-restorebox").hidden; });
  $("open-dorestore").addEventListener("click", () => {
    clearError("open-restoreerror");
    try {
      const raw = $("open-restorejson").value;
      const vr = P.verifyChannelDescriptor(raw);
      if (!vr.ok) throw new Error("descriptor refused:\n- " + vr.failures.join("\n- "));
      const chan = JSON.parse(raw);
      const myPayoutAddr = localStorage.getItem("pearl-channels.mypayout") || "";
      if (!myPayoutAddr) throw new Error("restored, but your payout address was not saved — enter it on the Verify step state or re-open");
      setChannel(chan, myPayoutAddr);
      $("open-result").hidden = false;
      $("open-address").textContent = chan.address;
      $("open-shortdesc").textContent = P.shortDescriptor(chan);
      $("open-fp").textContent = P.channelFingerprint(chan);
      $("open-cap").textContent = grainsToPRL(chan.capacity);
      $("open-csvshow").textContent = chan.csvDelay + " blocks";
      $("open-script").textContent = P.scriptAsm(P.hexToBytes(chan.fundingScript));
      $("open-descriptor").textContent = JSON.stringify(chan, null, 2);
      // Restore state 0 skeleton so funding can proceed
      goStep("fund");
    } catch (e) { showError("open-restoreerror", e); }
  });

  /* ---------- STEP 2: fund ---------- */
  function bbBase() {
    const v = ($("fund-blockbook").value || "").trim() || S.blockbook;
    if (!v) throw new Error("set a Blockbook base URL (or paste UTXOs)");
    return v.replace(/\/+$/, "");
  }
  $("fund-pastebtn").addEventListener("click", () => { $("fund-pastebox").hidden = !$("fund-pastebox").hidden; });
  $("fund-wipe").addEventListener("click", wipeKey);

  let fundUtxos = [];
  $("fund-scan").addEventListener("click", async () => {
    clearError("fund-error");
    try {
      const base = bbBase();
      S.blockbook = base;
      try { localStorage.setItem("pearl-channels.blockbook", base); } catch {}
      $("track-blockbook").value = base;
      const utxos = await P.fetchUtxos(base, S.myPayoutAddr);
      if (!utxos.length) throw new Error("no UTXOs found at your payout address — fund it first, or paste UTXOs");
      fundUtxos = utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value.toString(), spk: u.spk }));
      renderFundUtxos();
    } catch (e) { showError("fund-error", e); }
  });
  function renderFundUtxos() {
    const box = $("fund-utxos");
    if (!fundUtxos.length) { box.innerHTML = ""; return; }
    const total = fundUtxos.reduce((s, u) => s + BigInt(u.value), 0n);
    box.innerHTML = `<div class="note">${fundUtxos.length} UTXO(s), total ${grainsToPRL(total)}. Channel needs ${grainsToPRL(S.chan.capacity)} + fee.</div>`;
  }
  $("fund-build").addEventListener("click", async () => {
    clearError("fund-error");
    try {
      if (!S.chan) throw new Error("open a channel first");
      if (!$("fund-pastebox").hidden) {
        const pasted = JSON.parse($("fund-paste").value || "[]");
        if (!Array.isArray(pasted) || !pasted.length) throw new Error("paste a non-empty UTXO array");
        fundUtxos = pasted;
        renderFundUtxos();
      }
      if (!fundUtxos.length) throw new Error("scan or paste UTXOs first");
      const key = keyFromInput($("fund-key").value);
      const feeRate = parseFloat($("fund-feerate").value);
      const funded = P.planChannelFunding(NET, S.chan, fundUtxos, { priv: key.priv, internalXOnly: P.hexToBytes(key.xonly) }, feeRate);
      wipeKey();
      $("fund-result").hidden = false;
      $("fund-manual").hidden = false;
      $("fund-txid").textContent = funded.txid;
      $("fund-fee").textContent = grainsToPRL(funded.fee);
      $("fund-change").textContent = grainsToPRL(funded.change);
      $("fund-hex").value = funded.hex;
      S.fundingTxid = funded.txid; S.fundingVout = 0;
      $("fund-broadcast-note").hidden = true;
    } catch (e) { wipeKey(); showError("fund-error", e); }
  });
  $("fund-broadcast").addEventListener("click", async () => {
    clearError("fund-error");
    try {
      const hex = $("fund-hex").value.trim();
      if (!hex) throw new Error("build the funding tx first");
      if (!confirm("Broadcast the funding transaction to the Pearl network? This locks your PRL into the channel.")) return;
      if (!confirm("Second confirmation: broadcast funding tx " + S.fundingTxid + "?")) return;
      const base = bbBase();
      const txid = await P.broadcastTx(base, hex);
      $("fund-broadcast-note").hidden = false;
      $("fund-broadcast-note").textContent = "Broadcast accepted: " + txid + ". Wait for confirmation, then continue to State.";
      onFunded(S.fundingTxid, 0);
    } catch (e) { showError("fund-error", e); }
  });
  $("fund-confirm").addEventListener("click", () => {
    onFunded(S.fundingTxid, 0);
    $("fund-broadcast-note").hidden = false;
    $("fund-broadcast-note").textContent = "Marked as funded by you. The page will treat " + S.fundingTxid + " as the funding txid.";
  });
  function onFunded(txid, vout) {
    S.fundingTxid = txid; S.fundingVout = vout;
    // state 0 = funding distribution
    const mySecret = P.newRevocationSecret();
    const peerSecret = P.newRevocationSecret(); // placeholder until the peer sends theirs
    const st = {
      version: 0,
      myBal: S.chan.myCapacity, peerBal: S.chan.peerCapacity,
      myPayoutAddr: S.myPayoutAddr,
      mySecret: P.bytesToHex(mySecret),
      peerSecret: null,
      myRevokeHash160: P.bytesToHex(P.revocationHash160(mySecret)),
      peerRevokeHash160: P.bytesToHex(P.revocationHash160(peerSecret)), // replaced on exchange
      peerSecretSimulated: P.bytesToHex(peerSecret),
      pair: null, mySigs: { mine: null, theirs: null }, peerSigs: { mine: null, theirs: null },
      signed: { mine: null, theirs: null }, active: true, revoked: false,
    };
    S.states = [st];
    enableSteps(); renderStateCard(); renderHistory();
    goStep("state");
  }
  $("fund-manualgo").addEventListener("click", () => {
    clearError("fund-error");
    try {
      const txid = $("fund-manualtxid").value.trim();
      if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error("funding txid must be 64 hex characters");
      onFunded(txid.toLowerCase(), parseVoutField("fund-manualvout"));
    } catch (e) { showError("fund-error", e); }
  });

  /* ---------- STEP 3: state ---------- */
  $("pay-propose").addEventListener("click", () => {
    clearError("pay-error");
    try {
      const cur = activeState();
      if (!cur) throw new Error("fund the channel first");
      const dir = $("pay-direction").value;
      const amount = P.parsePRL($("pay-amount").value || "0");
      if (amount <= 0n) throw new Error("amount must be positive");
      const feeRate = parseFloat($("pay-feerate").value);
      let myBal = BigInt(cur.myBal), peerBal = BigInt(cur.peerBal);
      if (dir === "out") {
        if (amount > myBal) throw new Error("you only have " + grainsToPRL(cur.myBal));
        myBal -= amount; peerBal += amount;
      } else {
        if (amount > peerBal) throw new Error("the peer only has " + grainsToPRL(cur.peerBal));
        myBal += amount; peerBal -= amount;
      }
      const mySecret = P.newRevocationSecret();
      // Peer's revocation hash: they must send it. The simulator below fills it for testing.
      const peerHashInput = ($("pay-peerhash") && $("pay-peerhash").value || "").trim();
      const peerSecretSim = P.newRevocationSecret();
      const peerRevokeHash160 = peerHashInput
        ? (/^[0-9a-fA-F]{40}$/.test(peerHashInput) ? peerHashInput.toLowerCase() : (() => { throw new Error("peer revocation hash must be 40 hex chars"); })())
        : P.bytesToHex(P.revocationHash160(peerSecretSim));
      const state = {
        version: cur.version + 1,
        myBal: myBal.toString(), peerBal: peerBal.toString(),
        myPayoutAddr: S.myPayoutAddr,
        mySecret: P.bytesToHex(mySecret),
        peerSecret: null,
        myRevokeHash160: P.bytesToHex(P.revocationHash160(mySecret)),
        peerRevokeHash160,
        peerSecretSimulated: peerHashInput ? null : P.bytesToHex(peerSecretSim),
        pair: null, mySigs: { mine: null, theirs: null }, peerSigs: { mine: null, theirs: null },
        signed: { mine: null, theirs: null }, active: false, revoked: false,
      };
      state.pair = P.buildCommitmentPair(NET, S.chan, S.fundingTxid, S.fundingVout, {
        version: state.version, myBal: state.myBal, peerBal: state.peerBal,
        myPayoutAddr: state.myPayoutAddr,
        myRevokeHash160: state.myRevokeHash160, peerRevokeHash160: state.peerRevokeHash160,
      }, feeRate);
      state.feeRate = feeRate;
      S.proposal = state;
      $("pay-result").hidden = false;
      $("pay-version").textContent = "v" + state.version;
      $("pay-mine").textContent = grainsToPRL(state.myBal);
      $("pay-peer").textContent = grainsToPRL(state.peerBal);
      $("pay-fee").textContent = grainsToPRL(state.pair.mine.fee) + " (deducted from your to_local)";
      $("pay-revhash").textContent = state.myRevokeHash160;
      $("pay-notes").textContent = (state.pair.mine.notes.concat(state.pair.theirs.notes).join(" ") ||
        "Both commitment copies built. Sign yours, then exchange with your peer.") +
        (state.peerSecretSimulated ? " Peer revocation hash was simulated locally for testing — a real peer sends their own." : "");
      $("pay-signstatus").textContent = "";
      $("pay-assembled").hidden = true;
    } catch (e) { showError("pay-error", e); }
  });
  $("pay-wipe").addEventListener("click", wipeKey);

  $("pay-sign").addEventListener("click", () => {
    clearError("pay-error");
    try {
      const st = S.proposal;
      if (!st) throw new Error("propose a state first");
      const key = keyFromInput($("pay-key").value);
      st.mySigs.mine = P.signChannelDigest(P.bytesToHex(key.priv), st.pair.mine.digest);
      st.mySigs.theirs = P.signChannelDigest(P.bytesToHex(key.priv), st.pair.theirs.digest);
      wipeKey();
      $("pay-signstatus").innerHTML = 'You signed both copies. <span class="ok">✓</span> Export the bundle and send it to your peer.';
    } catch (e) { wipeKey(); showError("pay-error", e); }
  });

  $("pay-export").addEventListener("click", () => {
    clearError("pay-error");
    try {
      const st = S.proposal;
      if (!st) throw new Error("propose a state first");
      const json = P.exportStateBundle(S.chan, S.fundingTxid, S.fundingVout, {
        version: st.version, myBal: st.myBal, peerBal: st.peerBal,
        myPayoutAddr: st.myPayoutAddr,
        myRevokeHash160: st.myRevokeHash160, peerRevokeHash160: st.peerRevokeHash160,
        revokedSecrets: { mine: [], theirs: [] },
      }, st.pair, st.mySigs);
      $("pay-bundle").value = json;
      download("pearl-channel-state-v" + st.version + ".json", json);
    } catch (e) { showError("pay-error", e); }
  });

  function importBundleText(text) {
    const st = S.proposal;
    if (!st) throw new Error("propose a state first");
    const b = P.importStateBundle(text);
    if (b.fingerprint !== P.channelFingerprint(S.chan)) throw new Error("bundle is for a different channel");
    if (b.version !== st.version) throw new Error(`bundle is for v${b.version}, proposal is v${st.version}`);
    /* Perspective swap: the peer runs this same page with mirrored roles, so
     * their bundle's "my" is our "peer". Their mine-commitment digest equals
     * our theirs-commitment digest and vice versa. */
    if (String(b.myBal) !== String(st.peerBal) || String(b.peerBal) !== String(st.myBal)) {
      throw new Error(`balance mismatch: peer bundle says my=${b.myBal}/peer=${b.peerBal}, proposal is my=${st.myBal}/peer=${st.peerBal}`);
    }
    if (b.peerRevokeHash160 && b.peerRevokeHash160.toLowerCase() !== st.myRevokeHash160.toLowerCase()) {
      throw new Error("bundle's recorded hash for your key does not match your revocation hash — refusing");
    }
    // Adopt the peer's real revocation hash if it differs from a placeholder.
    if (b.myRevokeHash160 && b.myRevokeHash160.toLowerCase() !== st.peerRevokeHash160.toLowerCase()) {
      st.peerRevokeHash160 = b.myRevokeHash160.toLowerCase();
      st.peerSecretSimulated = null;
      st.pair = P.buildCommitmentPair(NET, S.chan, S.fundingTxid, S.fundingVout, {
        version: st.version, myBal: st.myBal, peerBal: st.peerBal,
        myPayoutAddr: st.myPayoutAddr,
        myRevokeHash160: st.myRevokeHash160, peerRevokeHash160: st.peerRevokeHash160,
      }, st.feeRate);
      st.mySigs = { mine: null, theirs: null }; // digests changed — re-sign
      $("pay-signstatus").innerHTML = '<span class="no">Peer revocation hash adopted — digests changed, sign again.</span>';
    }
    if (b.mySigs) {
      // swapped: their "mine" sig signs our "theirs" digest
      if (b.mySigs.mine) st.peerSigs.theirs = b.mySigs.mine;
      if (b.mySigs.theirs) st.peerSigs.mine = b.mySigs.theirs;
    }
    if (st.peerSigs.mine) $("pay-peersig-mine").value = st.peerSigs.mine;
    if (st.peerSigs.theirs) $("pay-peersig-theirs").value = st.peerSigs.theirs;
    $("pay-bundle").value = text;
  }
  $("pay-importtext").addEventListener("click", () => {
    clearError("pay-error");
    try { importBundleText($("pay-bundle").value); $("pay-signstatus").innerHTML += "<br>Peer bundle imported."; }
    catch (e) { showError("pay-error", e); }
  });
  $("pay-importfile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      clearError("pay-error");
      try { importBundleText(r.result); $("pay-bundle").value = r.result; }
      catch (err) { showError("pay-error", err); }
    };
    r.readAsText(f);
  });

  $("pay-assemble").addEventListener("click", () => {
    clearError("pay-error");
    try {
      const st = S.proposal;
      if (!st) throw new Error("propose a state first");
      st.peerSigs.mine = ($("pay-peersig-mine").value || "").trim() || st.peerSigs.mine;
      st.peerSigs.theirs = ($("pay-peersig-theirs").value || "").trim() || st.peerSigs.theirs;
      if (!st.mySigs.mine || !st.mySigs.theirs) throw new Error("sign your copies first");
      if (!st.peerSigs.mine || !st.peerSigs.theirs) throw new Error("both peer signatures are required");
      // Verify each signature against the right key before assembling.
      P.assertChannelSig(st.mySigs.mine, st.pair.mine.digest, S.chan.aXOnly, "your (your commitment)");
      P.assertChannelSig(st.peerSigs.mine, st.pair.mine.digest, S.chan.bXOnly, "peer (your commitment)");
      P.assertChannelSig(st.mySigs.theirs, st.pair.theirs.digest, S.chan.aXOnly, "your (their commitment)");
      P.assertChannelSig(st.peerSigs.theirs, st.pair.theirs.digest, S.chan.bXOnly, "peer (their commitment)");
      const mine = P.assembleFundingSpend(NET, S.chan, st.pair.mine, st.mySigs.mine, st.peerSigs.mine);
      const theirs = P.assembleFundingSpend(NET, S.chan, st.pair.theirs, st.mySigs.theirs, st.peerSigs.theirs);
      st.signed.mine = mine.hex; st.signed.theirs = theirs.hex;
      st.txidMine = mine.txid; st.txidTheirs = theirs.txid;
      $("pay-assembled").hidden = false;
      $("pay-txid-mine").textContent = mine.txid;
      $("pay-txid-theirs").textContent = theirs.txid;
      $("pay-hex-mine").value = mine.hex;
      $("pay-hex-theirs").value = theirs.hex;
    } catch (e) { showError("pay-error", e); }
  });

  $("pay-activate").addEventListener("click", () => {
    clearError("pay-error");
    try {
      const st = S.proposal;
      if (!st || !st.signed.mine || !st.signed.theirs) throw new Error("assemble both commitments first");
      const cur = activeState();
      if (cur) {
        cur.active = false; cur.revoked = true;
        cur.revealedMySecret = cur.mySecret;
      }
      st.active = true;
      S.states.push(st);
      S.proposal = null;
      $("pay-result").hidden = true;
      // Revocation box: reveal old secret, record peer's
      const box = $("state-revokebox");
      box.hidden = false;
      $("revoke-mine").textContent = cur && cur.revealedMySecret
        ? cur.revealedMySecret
        : "(genesis state — nothing to reveal)";
      $("revoke-status").textContent = cur
        ? "Send the secret above to your peer. Their old state is now revocable by you once they reveal theirs."
        : "Genesis state activated.";
      renderStateCard(); renderHistory();
    } catch (e) { showError("pay-error", e); }
  });
  $("revoke-copy").addEventListener("click", (e) => copyText($("revoke-mine").textContent, e.target));
  $("revoke-record").addEventListener("click", () => {
    clearError("pay-error");
    try {
      const secret = $("revoke-theirs").value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("peer's secret must be 64 hex characters");
      const revoked = S.states.filter((s) => s.revoked).sort((a, b) => b.version - a.version)[0];
      if (!revoked) throw new Error("no revoked state to attach this to");
      const h = P.bytesToHex(P.revocationHash160(P.hexToBytes(secret)));
      if (h !== revoked.peerRevokeHash160.toLowerCase()) {
        throw new Error("this secret does NOT hash to the peer's recorded revocation hash for v" + revoked.version + " — do not trust it");
      }
      revoked.peerSecret = secret;
      $("revoke-status").textContent = "Recorded and verified: the peer's v" + revoked.version + " secret hashes to their recorded revocation hash. If they broadcast v" + revoked.version + ", you can penalize via the penalty leaf.";
    } catch (e) { showError("pay-error", e); }
  });

  /* ---------- STEP 4: close ---------- */
  $("close-coop-build").addEventListener("click", () => {
    clearError("close-coop-error");
    try {
      const st = activeState();
      if (!st) throw new Error("no active state — fund the channel first");
      if (!st.signed.mine || !st.signed.theirs) throw new Error("the active state is not fully signed yet");
      const feeRate = parseFloat($("pay-feerate").value) || 2;
      const coop = P.buildCoopClose(NET, S.chan, S.fundingTxid, S.fundingVout, S.myPayoutAddr, {
        myBal: st.myBal, peerBal: st.peerBal,
      }, feeRate);
      S.coop = coop;
      $("close-coop-result").hidden = false;
      $("close-coop-txid").textContent = coop.txid;
      $("close-coop-fee").textContent = grainsToPRL(coop.fee);
      const youOut = coop.outputs.find((o) => o.kind === "coop_you");
      const peerOut = coop.outputs.find((o) => o.kind === "coop_peer");
      $("close-coop-mine").textContent = youOut ? grainsToPRL(youOut.value) + " → your payout address" : "dust — folded into the fee";
      $("close-coop-peer").textContent = peerOut ? grainsToPRL(peerOut.value) + " → peer payout address" : "dust — folded into the fee";
      $("close-coop-hex").hidden = true;
    } catch (e) { showError("close-coop-error", e); }
  });
  $("close-coop-sign").addEventListener("click", () => {
    clearError("close-coop-error");
    try {
      if (!S.coop) throw new Error("build the cooperative close first");
      const key = keyFromInput($("close-coop-key").value);
      S.coop.mySig = P.signChannelDigest(P.bytesToHex(key.priv), S.coop.digest);
      wipeKey();
      $("close-coop-error").hidden = true;
    } catch (e) { wipeKey(); showError("close-coop-error", e); }
  });
  $("close-coop-assemble").addEventListener("click", () => {
    clearError("close-coop-error");
    try {
      if (!S.coop || !S.coop.mySig) throw new Error("sign first");
      const peerSig = $("close-coop-peersig").value.trim();
      if (!/^[0-9a-fA-F]{128}$/.test(peerSig)) throw new Error("peer signature must be 128 hex characters");
      P.assertChannelSig(S.coop.mySig, S.coop.digest, S.chan.aXOnly, "your");
      P.assertChannelSig(peerSig.toLowerCase(), S.coop.digest, S.chan.bXOnly, "peer");
      const tx = P.assembleFundingSpend(NET, S.chan, S.coop, S.coop.mySig, peerSig.toLowerCase());
      S.coop.hex = tx.hex;
      $("close-coop-hex").hidden = false;
      $("close-coop-hex").value = tx.hex;
      $("close-coop-txid").textContent = tx.txid;
    } catch (e) { showError("close-coop-error", e); }
  });
  $("close-coop-broadcast").addEventListener("click", async () => {
    clearError("close-coop-error");
    try {
      if (!S.coop || !S.coop.hex) throw new Error("assemble the close transaction first");
      if (!confirm("Broadcast the cooperative close? This settles the channel on-chain with the active balances.")) return;
      if (!confirm("Second confirmation: broadcast cooperative close " + S.coop.txid + "?")) return;
      const txid = await P.broadcastTx(bbBase(), S.coop.hex);
      showError("close-coop-error", new Error("broadcast accepted: " + txid + " — channel closed cooperatively"));
      $("close-coop-error").hidden = false;
      $("close-coop-error").style.borderColor = "var(--signal)";
    } catch (e) { showError("close-coop-error", e); }
  });

  $("close-uni-build").addEventListener("click", () => {
    clearError("close-uni-error");
    try {
      const st = activeState();
      if (!st) throw new Error("no active state");
      if (!st.signed.mine) throw new Error("the active state's your-commitment copy is not fully signed");
      const feeRate = parseFloat($("pay-feerate").value) || 2;
      // buildClaimTx takes the commitment *template*; point it at the signed
      // commitment txid (segwit txids exclude the witness, so this matches).
      const commitment = Object.assign({}, st.pair.mine, { txid: st.txidMine });
      const claim = P.buildClaimTx(NET, S.chan, commitment, S.myPayoutAddr, feeRate);
      claim.commitmentTxid = st.txidMine;
      S.claim = claim;
      $("close-uni-result").hidden = false;
      $("close-uni-ctid").textContent = st.txidMine;
      $("close-uni-txid").textContent = claim.txid;
      $("close-uni-csv").textContent = S.chan.csvDelay + " blocks";
      $("close-uni-csv2").textContent = S.chan.csvDelay;
      $("close-uni-fee").textContent = grainsToPRL(claim.fee);
      $("close-uni-hex").hidden = true;
    } catch (e) { showError("close-uni-error", e); }
  });
  $("close-uni-sign").addEventListener("click", () => {
    clearError("close-uni-error");
    try {
      if (!S.claim) throw new Error("build the claim tx first");
      const key = keyFromInput($("close-uni-key").value);
      const sig = P.signChannelDigest(P.bytesToHex(key.priv), S.claim.digest);
      wipeKey();
      const tx = P.assembleClaimTx(NET, S.chan, S.claim, sig);
      S.claim.hex = tx.hex; S.claim.txid = tx.txid;
      $("close-uni-hex").hidden = false;
      $("close-uni-hex").value = tx.hex;
      $("close-uni-txid").textContent = tx.txid;
    } catch (e) { wipeKey(); showError("close-uni-error", e); }
  });
  $("close-uni-broadcast").addEventListener("click", async () => {
    clearError("close-uni-error");
    try {
      if (!S.claim || !S.claim.hex) throw new Error("sign the claim first");
      if (!confirm("Broadcast the CSV-delayed claim? Only do this after your commitment confirmed and the CSV delay has passed.")) return;
      if (!confirm("Second confirmation: broadcast claim " + S.claim.txid + "?")) return;
      const txid = await P.broadcastTx(bbBase(), S.claim.hex);
      showError("close-uni-error", new Error("broadcast accepted: " + txid));
      $("close-uni-error").hidden = false;
      $("close-uni-error").style.borderColor = "var(--signal)";
    } catch (e) { showError("close-uni-error", e); }
  });

  /* ---------- STEP 5: track ---------- */
  $("track-refresh").addEventListener("click", async () => {
    clearError("track-error");
    try {
      if (!S.chan) throw new Error("open a channel first");
      const base = ($("track-blockbook").value || "").trim() || S.blockbook;
      if (!base) throw new Error("set a Blockbook base URL");
      S.blockbook = base;
      try { localStorage.setItem("pearl-channels.blockbook", base); } catch {}
      const bb = base.replace(/\/+$/, "");
      const tipP = fetch(bb + "/api/v2/api").then((r) => r.json()).catch(() => null);
      const tip = await tipP;
      $("track-tip").textContent = tip && tip.blockbook && tip.blockbook.bestHeight != null
        ? "height " + tip.blockbook.bestHeight : "unavailable";
      if (S.fundingTxid) {
        const f = await fetch(bb + "/api/v2/tx/" + S.fundingTxid).then((r) => { if (!r.ok) throw new Error("funding tx not found"); return r.json(); });
        $("track-funding").textContent = S.fundingTxid.slice(0, 16) + "… · " +
          (f.confirmations > 0 ? f.confirmations + " confirmation(s)" : "UNCONFIRMED") +
          " · " + (f.blockHeight != null && f.blockHeight > 0 ? "block " + f.blockHeight : "mempool");
        S.fundingHeight = f.blockHeight > 0 ? f.blockHeight : null;
      } else {
        $("track-funding").textContent = "not funded yet";
      }
      const a = await fetch(bb + "/api/v2/address/" + S.chan.address).then((r) => r.json()).catch(() => null);
      $("track-addr").textContent = a
        ? `${a.txApperances || 0} tx(s) · ${a.balance || "0"} grains balance`
        : "unavailable";
      const st = activeState();
      $("track-state").textContent = st
        ? `v${st.version} · you ${grainsToPRL(st.myBal)} / peer ${grainsToPRL(st.peerBal)} · fp ${st.pair ? st.pair.mine.fingerprint : "n/a"}`
        : "none";
      if (S.claim && S.claim.commitmentTxid && S.fundingHeight != null) {
        $("track-claim").textContent = "claim built for commitment " + S.claim.commitmentTxid.slice(0, 16) +
          "… — enter the commitment's confirmation height in a block explorer to count down the CSV delay";
      } else {
        $("track-claim").textContent = "no unilateral claim in progress";
      }
      $("track-result").hidden = false;
    } catch (e) { showError("track-error", e); }
  });

  /* ---------- STEP 6: verify ---------- */
  function addChecks(listId, items, ok) {
    const ul = $(listId);
    ul.innerHTML = "";
    for (const t of items) {
      const li = document.createElement("li");
      li.textContent = t;
      ul.appendChild(li);
    }
    ul.style.display = items.length ? "" : "none";
  }
  $("verify-desc").addEventListener("click", () => {
    clearError("verify-error");
    try {
      const vr = P.verifyChannelDescriptor($("verify-descriptor").value);
      $("verify-result").hidden = false;
      $("verify-verdict").textContent = vr.ok ? "DESCRIPTOR VALID" : "DESCRIPTOR REFUSED";
      $("verify-verdict").className = vr.ok ? "proven" : "notproven";
      let addr = "";
      try { addr = JSON.parse($("verify-descriptor").value).address || ""; } catch {}
      $("verify-kind").textContent = vr.ok
        ? "The descriptor re-derives byte-for-byte" + (addr ? ": address " + addr : "")
        : "The descriptor was refused — it does not re-derive from its keys.";
      addChecks("verify-checks", vr.checks, true);
      addChecks("verify-failures", vr.failures, false);
    } catch (e) { showError("verify-error", e); }
  });
  $("verify-go").addEventListener("click", () => {
    clearError("verify-error");
    try {
      const vr = P.verifyChannelDescriptor($("verify-descriptor").value);
      if (!vr.ok) throw new Error("descriptor refused:\n- " + vr.failures.join("\n- "));
      const chan = JSON.parse($("verify-descriptor").value);
      const state = {
        version: parseInt($("verify-version").value, 10) || 0,
        myBal: ($("verify-mine").value || "0").toString(),
        peerBal: ($("verify-peer").value || "0").toString(),
        myPayoutAddr: $("verify-mypayout").value.trim(),
        myRevokeHash160: $("verify-myhash").value.trim().toLowerCase() || undefined,
        peerRevokeHash160: $("verify-peerhash").value.trim().toLowerCase() || undefined,
      };
      if (!state.myPayoutAddr) throw new Error("your payout address is required to match outputs");
      const res = P.verifyChannelTx(
        NET, chan,
        $("verify-hex").value.trim(),
        $("verify-fundingtxid").value.trim(),
        parseVoutField("verify-fundingvout"),
        state,
        state.myPayoutAddr,
        parseFloat($("verify-feerate").value)
      );
      $("verify-result").hidden = false;
      $("verify-verdict").textContent = res.ok ? "PROVEN" : "NOT PROVEN";
      $("verify-verdict").className = res.ok ? "proven" : "notproven";
      $("verify-kind").textContent = "Transaction kind: " + res.kind + " · txid " + res.txid;
      addChecks("verify-checks", res.checks, true);
      addChecks("verify-failures", res.failures, false);
    } catch (e) { showError("verify-error", e); }
  });

  /* ---------- footer ---------- */
  $("donate-copy").addEventListener("click", (e) => copyText($("donate-addr").textContent.trim(), e.target));

  /* ---------- test hook (used by tests/dom.test.mjs; harmless in production) ---------- */
  window.__channelsTest = {
    state: () => S,
    err: (id) => { const e = $(id); return { hidden: e.hidden, text: e.textContent }; },
    click: (id) => $(id).click(),
    set: (id, v) => { $(id).value = v; },
    text: (id) => $(id).textContent,
  };

  /* ---------- init: restore saved non-secret state ---------- */
  (function init() {
    try {
      S.blockbook = localStorage.getItem("pearl-channels.blockbook") || P.NETWORKS[NET].blockbook || "";
    } catch { S.blockbook = P.NETWORKS[NET].blockbook || ""; }
    $("fund-blockbook").value = S.blockbook;
    $("track-blockbook").value = S.blockbook;
    try {
      const raw = localStorage.getItem("pearl-channels.descriptor");
      if (raw) {
        const vr = P.verifyChannelDescriptor(raw);
        if (vr.ok) {
          S.chan = JSON.parse(raw);
          S.myPayoutAddr = localStorage.getItem("pearl-channels.mypayout") || "";
          $("open-result").hidden = false;
          $("open-address").textContent = S.chan.address;
          $("open-shortdesc").textContent = P.shortDescriptor(S.chan);
          $("open-fp").textContent = P.channelFingerprint(S.chan);
          $("open-cap").textContent = grainsToPRL(S.chan.capacity);
          $("open-csvshow").textContent = S.chan.csvDelay + " blocks";
          $("open-script").textContent = P.scriptAsm(P.hexToBytes(S.chan.fundingScript));
          $("open-descriptor").textContent = JSON.stringify(S.chan, null, 2);
        }
      }
    } catch { /* start clean */ }
    enableSteps();
    renderStateCard(); renderHistory();
    window.addEventListener("beforeunload", wipeKey);
  })();
})();
