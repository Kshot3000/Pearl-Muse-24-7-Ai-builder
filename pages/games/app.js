/* Pearl Games UI — provably-fair commit-reveal games on Pearl Taproot.
 * All cryptography runs locally via window.PearlGames (pearl-games.bundle.js).
 * Keys live in memory only; every wipe button zeroes them. */
(() => {
  "use strict";
  const G = window.PearlGames;
  if (!G) { document.body.innerHTML = "<p style='padding:40px'>Pearl Games failed to load (bundle missing).</p>"; return; }

  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  const els = {};
  ["steps", "role-switch", "role-hint", "in-game", "in-bet", "game-desc", "in-stake", "in-timeout",
   "timeout-est", "stakes-preview", "in-net", "in-dealer", "in-player", "in-blockbook", "in-feerate",
   "btn-create", "btn-wipe", "game-summary", "game-fp", "game-desc-out", "btn-share-setup", "escrow-cards",
   "btn-newsecret", "out-secret", "out-commitment", "btn-wipe-secret", "in-commitment", "btn-lock-commitment",
   "commit-status", "fund-cards", "btn-scan-funding", "funding-status", "in-reveal-secret", "btn-reveal",
   "reveal-out", "btn-copy-reveal", "in-winner-addr", "btn-build-settle", "out-settle", "in-settle",
   "btn-import-settle", "settle-verify-out", "in-settle-key", "btn-sign-settle", "btn-wipe-settle-key",
   "out-signed-settle", "in-final-settle", "btn-finalize-settle", "settle-final-out", "btn-broadcast-settle",
   "in-refund-role", "in-refund-txid", "in-refund-vout", "in-refund-addr", "in-refund-key", "btn-build-refund",
   "btn-wipe-refund-key", "refund-out", "btn-broadcast-refund", "in-v-desc", "in-v-commit", "in-v-secret",
   "btn-verify", "verify-out", "in-solo-game", "in-solo-bet", "btn-solo-play", "solo-out", "solo-history",
  ].forEach((id) => { els[id.replace(/-/g, "_")] = $(id); });

  const S = {
    role: "solo",
    network: G.NETWORKS.mainnet,
    blockbook: G.NETWORKS.mainnet.blockbook,
    feeRate: 10,
    game: null,           // createGame() result (descriptor + params)
    escrows: null,        // {dealer, player} escrowFor results
    dealerKey: null, playerKey: null, // gameKeyFromInput results (priv may be null)
    secret: null, commitment: null,
    commitmentLocked: null,
    funding: { dealer: null, player: null }, // {txid, vout, value, confirmations}
    reveal: null,         // {secret, commitment, outcome, winner}
    settleBundle: null,   // imported/parsed bundle for signing
    finalizedSettle: null,
    refundTx: null,
    soloHistory: [],
  };

  const BLOCK_SECS = 194;

  function showErr(msg) {
    // errors render inline in the nearest card via a thrown alert box
    const d = document.createElement("div");
    d.className = "verdict bad";
    d.innerHTML = "<strong>Refused.</strong> ";
    d.appendChild(document.createTextNode(msg));
    return d;
  }
  function showOk(title, bodyHtml) {
    const d = document.createElement("div");
    d.className = "verdict proven";
    d.innerHTML = "<strong>" + title + "</strong>" + (bodyHtml || "");
    return d;
  }
  function kv(obj) {
    const dl = document.createElement("dl");
    dl.className = "kv";
    for (const [k, v] of Object.entries(obj)) {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    }
    return dl;
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
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }
  function shortAddr(a) { return a.length > 26 ? a.slice(0, 14) + "…" + a.slice(-8) : a; }
  function wipeInput(el) { el.value = ""; }

  /* ---------------- navigation ---------------- */

  const stepForRole = () => (S.role === "solo" ? "solo" : null);
  els.steps.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-step]");
    if (!b) return;
    showStep(b.dataset.step);
  });
  function showStep(name) {
    document.querySelectorAll("#steps button").forEach((b) =>
      b.classList.toggle("active", b.dataset.step === name));
    ["setup", "commit", "fund", "reveal", "settle", "refund", "verify", "solo"].forEach((s) => {
      $("panel-" + s).hidden = s !== name;
    });
    if (name === "fund") renderFundCards();
  }

  els.role_switch.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-role]");
    if (!b) return;
    S.role = b.dataset.role;
    document.querySelectorAll("#role-switch button").forEach((x) =>
      x.classList.toggle("active", x === b));
    const hints = {
      dealer: "You generate the secret and publish the commitment. You fund the dealer's escrow.",
      player: "You lock the dealer's commitment, then fund the player's escrow — never before the commitment is locked.",
      solo: "Practice against a local dealer. No keys, no funding, no broadcast — the protocol, demonstrated.",
    };
    els.role_hint.textContent = hints[S.role];
    showStep(S.role === "solo" ? "solo" : "setup");
  });
  els.role_hint.textContent = "Practice against a local dealer. No keys, no funding, no broadcast — the protocol, demonstrated.";

  /* ---------------- setup ---------------- */

  function fillBets(sel, gameId) {
    const g = G.parseGame(gameId);
    sel.innerHTML = "";
    for (const b of g.bets) {
      const o = document.createElement("option");
      o.value = b;
      o.textContent = gameId === "flip" ? b[0].toUpperCase() + b.slice(1)
        : gameId === "dice-hilo" ? (b === "low" ? "Low (1–3)" : "High (4–6)")
        : "Face " + b;
      sel.appendChild(o);
    }
    els.game_desc.textContent = g.describe;
  }
  fillBets(els.in_bet, "flip");
  els.in_game.addEventListener("change", () => { fillBets(els.in_bet, els.in_game.value); updateStakesPreview(); });
  els.in_bet.addEventListener("change", updateStakesPreview);
  els.in_stake.addEventListener("input", updateStakesPreview);
  els.in_timeout.addEventListener("input", () => {
    const t = parseInt(els.in_timeout.value, 10);
    if (Number.isSafeInteger(t) && t > 0) {
      G.fetchTipHeight(S.blockbook).then((tip) => {
        const blocks = t - tip;
        els.timeout_est.textContent = blocks > 0
          ? `≈ ${(blocks * BLOCK_SECS / 3600).toFixed(1)}h from now (chain at ${tip}).`
          : `in the past (chain at ${tip}) — pick a future height.`;
      }).catch(() => { els.timeout_est.textContent = ""; });
    } else els.timeout_est.textContent = "";
  });

  function updateStakesPreview() {
    try {
      const stakes = G.stakesFor(els.in_game.value, G.prlToGrains(els.in_stake.value));
      els.stakes_preview.innerHTML =
        `<div><div class="k">Dealer posts</div><div class="v">${G.grainsToPRL(stakes.dealer)} PRL</div></div>` +
        `<div><div class="k">Player posts</div><div class="v">${G.grainsToPRL(stakes.player)} PRL</div></div>` +
        `<div><div class="k">Winner takes</div><div class="v gold-text">${G.grainsToPRL(stakes.dealer + stakes.player)} PRL</div></div>`;
    } catch (e) { els.stakes_preview.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
  }
  updateStakesPreview();

  els.btn_wipe.addEventListener("click", () => {
    [els.in_dealer, els.in_player].forEach(wipeInput);
    S.dealerKey = S.playerKey = null;
  });

  els.btn_create.addEventListener("click", () => {
    try {
      const net = G.NETWORKS[els.in_net.value] || G.NETWORKS.mainnet;
      S.network = net;
      S.blockbook = els.in_blockbook.value.trim() || net.blockbook;
      S.feeRate = parseFloat(els.in_feerate.value) || 10;
      if (!S.blockbook) throw new Error("set a Blockbook URL (no public testnet Blockbook is known — run your own or use mainnet).");
      const dealerKey = G.gameKeyFromInput(els.in_dealer.value, net);
      const playerKey = G.gameKeyFromInput(els.in_player.value, net);
      /* Strict timeout parse: bare parseInt truncated "51200abc"/"51200.9"
       * to 51200 and "1e5" to 1 — a silently wrong refund height baked into
       * both escrow scripts. Digits only, like the refund vout below. */
      const timeoutRaw = els.in_timeout.value.trim();
      if (!/^\d+$/.test(timeoutRaw) || !Number.isSafeInteger(Number(timeoutRaw))) throw new Error("timeout height must be a whole block height");
      const game = G.createGame({
        network: net, game: els.in_game.value, bet: els.in_bet.value,
        dealerXOnly: dealerKey.xonly, playerXOnly: playerKey.xonly,
        playerStakePRL: els.in_stake.value,
        timeoutHeight: Number(timeoutRaw),
      });
      S.game = game; S.dealerKey = dealerKey; S.playerKey = playerKey;
      S.secret = null; S.commitment = null; S.commitmentLocked = null;
      S.funding = { dealer: null, player: null }; S.reveal = null;
      const base = {
        network: net, dealerXOnly: game.dealerXOnly, playerXOnly: game.playerXOnly,
        game: game.game, bet: game.bet, stakeDealerGrains: game.stakeDealerGrains,
        stakePlayerGrains: game.stakePlayerGrains, timeoutHeight: game.timeoutHeight, roundId: game.roundId,
      };
      S.escrows = { dealer: G.escrowFor({ ...base, depositor: "dealer" }), player: G.escrowFor({ ...base, depositor: "player" }) };
      G.verifyEscrowAddress(S.escrows.dealer);
      G.verifyEscrowAddress(S.escrows.player);
      renderGameSummary();
      showStep("commit");
    } catch (e) { els.game_summary.hidden = false; els.game_summary.prepend(showErr(e.message)); }
  });

  function renderGameSummary() {
    const g = S.game;
    els.game_summary.hidden = false;
    els.game_fp.textContent = "fp " + g.fingerprint;
    els.game_desc_out.textContent = g.descriptor;
    els.escrow_cards.innerHTML = "";
    for (const role of ["dealer", "player"]) {
      const esc = S.escrows[role];
      const card = document.createElement("div");
      card.className = "escrow-card";
      card.innerHTML = `<h4>${role} escrow</h4><div class="addr"></div>
        <div class="amt"></div><div class="qr-wrap"><div class="qr"></div></div>`;
      card.querySelector(".addr").textContent = esc.address;
      card.querySelector(".amt").textContent = G.grainsToPRL(BigInt(esc.stakeGrains)) + " PRL exactly";
      svgQr(card.querySelector(".qr"), esc.address);
      els.escrow_cards.appendChild(card);
    }
  }

  els.btn_share_setup.addEventListener("click", () => {
    if (!S.game) return;
    copyText(JSON.stringify({
      kind: "pearl-games-setup", version: 1,
      descriptor: S.game.descriptor,
      escrows: { dealer: S.escrows.dealer.address, player: S.escrows.player.address },
      blockbook: S.blockbook, feeRate: S.feeRate,
    }, null, 2));
  });

  document.querySelectorAll(".copy-btn").forEach((b) =>
    b.addEventListener("click", () => copyText($(b.dataset.copy).textContent || $(b.dataset.copy).value)));

  /* ---------------- commit ---------------- */

  els.btn_newsecret.addEventListener("click", () => {
    if (S.role !== "dealer") { els.commit_status.innerHTML = ""; els.commit_status.appendChild(showErr("Only the dealer's device generates the secret.")); return; }
    try {
      S.secret = G.newSecret();
      S.commitment = G.commitmentFor(S.secret);
      els.out_secret.value = S.secret;
      els.out_commitment.value = S.commitment;
      els.in_commitment.value = S.commitment;
    } catch (e) { els.commit_status.innerHTML = ""; els.commit_status.appendChild(showErr(e.message)); }
  });
  els.btn_wipe_secret.addEventListener("click", () => {
    S.secret = null; wipeInput(els.out_secret);
  });
  els.btn_lock_commitment.addEventListener("click", () => {
    try {
      const c = els.in_commitment.value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(c)) throw new Error("commitment must be 64 hex chars (sha256).");
      S.commitmentLocked = c;
      els.commit_status.innerHTML = "";
      els.commit_status.appendChild(showOk("Commitment locked.",
        `<div class="kv"><div class="kv"><dt>commitment</dt><dd>${c}</dd></div></div><p class="hint">The Fund step is now open. Fund only after this point — never before.</p>`));
    } catch (e) { els.commit_status.innerHTML = ""; els.commit_status.appendChild(showErr(e.message)); }
  });

  /* ---------------- fund ---------------- */

  function renderFundCards() {
    const wrap = els.fund_cards;
    wrap.innerHTML = "";
    if (!S.game) { wrap.innerHTML = "<p class='hint'>Create a game in step 1 first.</p>"; return; }
    const locked = !!S.commitmentLocked;
    for (const role of ["dealer", "player"]) {
      const esc = S.escrows[role];
      const mine = S.role === role;
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<h3>${role[0].toUpperCase() + role.slice(1)} funds ${G.grainsToPRL(BigInt(esc.stakeGrains))} PRL</h3>
        <code class="desc addr"></code>
        <div class="qr-wrap"><div class="qr"></div></div>
        ${locked ? "" : `<p class="hint bad-text">Commitment not locked yet — do not fund until step 2 is done.</p>`}
        ${mine && locked ? `
          <label>Fund from this wallet (WIF / mnemonic) — optional convenience
            <input type="password" class="fund-key" autocomplete="off" placeholder="your private key for the ${role} role">
          </label>
          <div class="row"><button class="btn primary fund-go">Build + broadcast funding tx</button></div>
          <div class="fund-out"></div>` : ""}
        ${!mine ? `<p class="hint">Your counterparty funds this address from their own wallet (exact amount). Scan below to confirm.</p>` : ""}`;
      card.querySelector(".addr").textContent = esc.address;
      svgQr(card.querySelector(".qr"), esc.address);
      const go = card.querySelector(".fund-go");
      if (go) go.addEventListener("click", () => fundFromKey(role, card));
      wrap.appendChild(card);
    }
  }

  async function fundFromKey(role, card) {
    const out = card.querySelector(".fund-out");
    out.innerHTML = "";
    try {
      const key = G.gameKeyFromInput(card.querySelector(".fund-key").value, S.network);
      if (!key.priv) throw new Error("that input has no private key.");
      const esc = S.escrows[role];
      const myAddr = G.walletAddress(S.network, key.xonly);
      const utxos = await G.fetchUtxos(S.blockbook, myAddr);
      if (!utxos.length) throw new Error("no UTXOs on " + shortAddr(myAddr) + " — fund that wallet first.");
      // pick the smallest UTXO that covers stake + fee headroom
      const stake = BigInt(esc.stakeGrains);
      const sorted = [...utxos].sort((a, b) => a.value - b.value);
      const pick = sorted.find((u) => BigInt(u.value) > stake);
      if (!pick) throw new Error("no single UTXO covers the stake — consolidate first (see Pearl Sweep).");
      const built = G.buildFundingTx({
        network: S.network, utxo: pick, key, escrow: esc, feeRateGrainsPerVByte: S.feeRate,
      });
      out.appendChild(showOk("Funding tx built.",
        kv({ txid: built.txid, fee: built.feeGrains + " grains", change: built.changeGrains + " grains" + (built.dustAbsorbed ? " (dust absorbed into fee)" : "") })));
      const btn = document.createElement("button");
      btn.className = "btn danger"; btn.textContent = "Broadcast funding tx (confirm twice)";
      let armed = false;
      btn.addEventListener("click", async () => {
        if (!armed) { armed = true; btn.textContent = "Click again to broadcast — real PRL moves"; return; }
        try {
          const res = await G.broadcastTx(S.blockbook, built.hex);
          out.appendChild(showOk("Broadcast.", kv({ txid: res?.result || built.txid })));
        } catch (e) { out.appendChild(showErr(e.message)); }
      });
      out.appendChild(btn);
      card.querySelector(".fund-key").value = "";
    } catch (e) { out.appendChild(showErr(e.message)); }
  }

  els.btn_scan_funding.addEventListener("click", async () => {
    els.funding_status.innerHTML = "";
    try {
      if (!S.game) throw new Error("create a game first.");
      for (const role of ["dealer", "player"]) {
        const esc = S.escrows[role];
        const hits = await G.findFunding({ blockbookUrl: S.blockbook, escrow: esc, stakeGrains: esc.stakeGrains });
        const line = document.createElement("div");
        line.className = "status-line";
        if (hits.length) {
          S.funding[role] = hits[0];
          line.innerHTML = `<span class="ok-text">●</span> ${role}: funded — <span class="gold-text">${hits[0].txid.slice(0, 16)}…:${hits[0].vout}</span> (${hits[0].confirmations} conf)`;
        } else {
          S.funding[role] = null;
          line.innerHTML = `<span class="bad-text">○</span> ${role}: not funded yet`;
        }
        els.funding_status.appendChild(line);
      }
      if (S.funding.dealer && S.funding.player) {
        els.funding_status.appendChild(showOk("Both sides funded.", "<p class='hint'>The dealer can now reveal in step 4.</p>"));
      }
    } catch (e) { els.funding_status.appendChild(showErr(e.message)); }
  });

  /* ---------------- reveal ---------------- */

  els.btn_reveal.addEventListener("click", () => {
    els.reveal_out.innerHTML = "";
    try {
      if (!S.game) throw new Error("create a game first.");
      if (!S.commitmentLocked) throw new Error("lock the dealer's commitment first (step 2).");
      const secret = els.in_reveal_secret.value.trim().toLowerCase();
      const scored = G.revealAndScore({
        secretHex: secret, commitmentHex: S.commitmentLocked,
        roundId: S.game.roundId, game: S.game.game, bet: S.game.bet,
      });
      S.reveal = { secret, commitment: S.commitmentLocked, outcome: scored.outcome, winner: scored.winner };
      const g = S.game;
      const outcomeHtml = g.game === "flip"
        ? `<div class="coin">${scored.outcome === "heads" ? "🪙" : "🌑"}</div><p style="text-align:center"><strong class="gold-text">${scored.outcome.toUpperCase()}</strong></p>`
        : `<div class="dice">🎲</div><p style="text-align:center;font-size:28px"><strong class="gold-text">${scored.outcome}</strong></p>`;
      els.reveal_out.innerHTML = outcomeHtml;
      els.reveal_out.appendChild(showOk("Commitment verified — outcome is genuine.",
        `<div class="who">Winner: <span class="gold-text">${scored.winner.toUpperCase()}</span></div>` +
        kv({ game: g.gameName, bet: g.bet, outcome_seed: "sha256(secret ‖ roundId)", commitment: S.commitmentLocked.slice(0, 24) + "…" }).outerHTML));
      els.btn_copy_reveal.hidden = false;
      els.in_reveal_secret.value = "";
    } catch (e) { els.reveal_out.appendChild(showErr(e.message)); }
  });

  els.btn_copy_reveal.addEventListener("click", () => {
    if (!S.reveal || !S.game) return;
    copyText(JSON.stringify({
      kind: "pearl-games-reveal", version: 1,
      descriptor: S.game.descriptor,
      commitment: S.reveal.commitment, secret: S.reveal.secret,
      outcome: S.reveal.outcome, winner: S.reveal.winner,
    }, null, 2));
  });

  /* ---------------- settle ---------------- */

  function bundleJson(bundle) {
    // shareable JSON: drop internal (underscore) fields, stringify BigInts
    return JSON.stringify(bundle, (k, v) => {
      if (k.startsWith("_")) return undefined;
      return typeof v === "bigint" ? v.toString() : v;
    }, 2);
  }

  function fundingInput(role) {
    const f = S.funding[role];
    if (!f) throw new Error(`${role} funding not found — scan funding in step 3 first.`);
    return { txid: f.txid, vout: f.vout, value: Number(S.game["stake" + role[0].toUpperCase() + role.slice(1) + "Grains"]), address: S.escrows[role].address };
  }

  els.btn_build_settle.addEventListener("click", () => {
    try {
      if (!S.game) throw new Error("create a game first.");
      if (!S.reveal) throw new Error("reveal the outcome first (step 4).");
      if (!S.commitment) { /* player side: secret came from the reveal bundle */ }
      const winnerAddr = els.in_winner_addr.value.trim();
      const bundle = G.buildSettleBundle({
        network: S.network, gameParams: S.game,
        commitmentHex: S.reveal.commitment, secretHex: S.reveal.secret,
        fundingDealer: fundingInput("dealer"), fundingPlayer: fundingInput("player"),
        winnerAddress: winnerAddr, feeRateGrainsPerVByte: S.feeRate,
      });
      els.out_settle.value = bundleJson(bundle);
    } catch (e) { els.out_settle.value = "REFUSED: " + e.message; }
  });

  els.btn_import_settle.addEventListener("click", () => {
    els.settle_verify_out.innerHTML = "";
    try {
      const parsed = G.parseSettleBundle(els.in_settle.value, S.network);
      S.settleBundle = parsed;
      const st = G.settleBundleStatus(parsed, parsed._gameParams);
      els.settle_verify_out.appendChild(showOk("Bundle verified — outcome, math, fingerprint and signatures all re-derive.",
        kv({
          game: parsed.game, bet: parsed.bet, outcome: String(parsed.outcome),
          winner: parsed.winner,
          payout: G.grainsToPRL(BigInt(parsed.outputs[0].value)) + " PRL",
          fee: parsed.feeGrains + " grains (" + parsed.vBytes + " vB)",
          fingerprint: parsed.fingerprint,
          signatures: st.signers.length + " of 2 (" + st.signers.map((s) => s.slice(0, 10) + "…").join(", ") + ")",
        }).outerHTML +
        (st.ready ? "" : "<p class='hint'>Not fully signed yet — sign below, then hand it back.</p>")));
    } catch (e) { els.settle_verify_out.appendChild(showErr(e.message)); }
  });

  els.btn_sign_settle.addEventListener("click", () => {
    try {
      if (!S.settleBundle) throw new Error("import a bundle first.");
      const priv = els.in_settle_key.value.trim();
      if (!priv) throw new Error("enter your signing key.");
      const gp = S.settleBundle._gameParams;
      const key = G.gameKeyFromInput(priv, S.network);
      if (!key.priv) throw new Error("that input has no private key.");
      G.signSettleBundle(S.settleBundle, gp, G.bytesToHex(key.priv));
      els.out_signed_settle.value = bundleJson(S.settleBundle);
      const st = G.settleBundleStatus(S.settleBundle, gp);
      els.settle_verify_out.appendChild(showOk("Signed.",
        `<p class="hint">${st.ready ? "Both signatures present — hand the bundle to the winner to finalize." : "Your signature is in. The other party still needs to sign."}</p>`));
      els.in_settle_key.value = "";
    } catch (e) { els.settle_verify_out.appendChild(showErr(e.message)); }
  });
  els.btn_wipe_settle_key.addEventListener("click", () => wipeInput(els.in_settle_key));

  els.btn_finalize_settle.addEventListener("click", () => {
    els.settle_final_out.innerHTML = "";
    try {
      const parsed = G.parseSettleBundle(els.in_final_settle.value, S.network);
      const spend = G.buildSettleSpend({ network: S.network, bundle: parsed, gameParams: parsed._gameParams });
      S.finalizedSettle = spend;
      els.settle_final_out.appendChild(showOk("Settle transaction built.",
        kv({ txid: spend.txid, vbytes: String(spend.vBytes), fee: parsed.feeGrains + " grains", pays: parsed.outputs[0].address }).outerHTML +
        `<p class="hint">Raw hex:</p><code class="desc">${spend.hex}</code>`));
      els.btn_broadcast_settle.hidden = false;
      els.btn_broadcast_settle.dataset.armed = "";
      els.btn_broadcast_settle.textContent = "Broadcast settle";
    } catch (e) { els.settle_final_out.appendChild(showErr(e.message)); }
  });

  els.btn_broadcast_settle.addEventListener("click", async () => {
    const b = els.btn_broadcast_settle;
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Click again to broadcast — the winner gets paid"; return; }
    try {
      const res = await G.broadcastTx(S.blockbook, S.finalizedSettle.hex);
      els.settle_final_out.appendChild(showOk("Broadcast.", kv({ txid: res?.result || S.finalizedSettle.txid }).outerHTML));
      b.hidden = true;
    } catch (e) { els.settle_final_out.appendChild(showErr(e.message)); }
  });

  /* ---------------- refund ---------------- */

  els.btn_build_refund.addEventListener("click", async () => {
    els.refund_out.innerHTML = "";
    els.btn_broadcast_refund.hidden = true;
    try {
      if (!S.game) throw new Error("create (or paste) a game first.");
      const role = els.in_refund_role.value;
      const voutRaw = els.in_refund_vout.value.trim();
      if (!/^\d+$/.test(voutRaw) || !Number.isSafeInteger(Number(voutRaw))) throw new Error("funding vout must be a non-negative integer");
      const tip = await G.fetchTipHeight(S.blockbook);
      const r = G.buildRefundTx({
        network: S.network, gameParams: S.game, depositor: role,
        funding: {
          txid: els.in_refund_txid.value.trim(), vout: Number(voutRaw),
          value: Number(S.game["stake" + role[0].toUpperCase() + role.slice(1) + "Grains"]),
          address: S.escrows[role].address,
        },
        depositorAddress: els.in_refund_addr.value.trim(),
        privHex: G.bytesToHex(G.gameKeyFromInput(els.in_refund_key.value, S.network).priv || new Uint8Array()),
        feeRateGrainsPerVByte: S.feeRate, tipHeight: tip,
      });
      S.refundTx = r;
      els.refund_out.appendChild(showOk("Refund built + signed.",
        kv({ txid: r.txid, pays: r.refundAddress, amount: G.grainsToPRL(BigInt(r.payment)) + " PRL", fee: r.fee + " grains", locktime: String(r.locktime), tip: String(tip) }).outerHTML +
        `<p class="hint">Raw hex:</p><code class="desc">${r.hex}</code>`));
      els.btn_broadcast_refund.hidden = false;
      els.btn_broadcast_refund.dataset.armed = "";
      els.in_refund_key.value = "";
    } catch (e) { els.refund_out.appendChild(showErr(e.message)); }
  });
  els.btn_wipe_refund_key.addEventListener("click", () => wipeInput(els.in_refund_key));

  els.btn_broadcast_refund.addEventListener("click", async () => {
    const b = els.btn_broadcast_refund;
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Click again to broadcast — real PRL moves"; return; }
    try {
      const res = await G.broadcastTx(S.blockbook, S.refundTx.hex);
      els.refund_out.appendChild(showOk("Broadcast.", kv({ txid: res?.result || S.refundTx.txid }).outerHTML));
      b.hidden = true;
    } catch (e) { els.refund_out.appendChild(showErr(e.message)); }
  });

  /* ---------------- verify ---------------- */

  els.btn_verify.addEventListener("click", () => {
    els.verify_out.innerHTML = "";
    try {
      const r = G.verifyGameTranscript({
        descriptor: els.in_v_desc.value.trim(),
        commitmentHex: els.in_v_commit.value.trim(),
        secretHex: els.in_v_secret.value.trim(),
      });
      if (r.proven) {
        const d = showOk("PROVEN — the transcript checks out.");
        d.appendChild(kv({
          game: r.game.gameName, bet: r.game.bet, outcome: String(r.outcome),
          winner: r.winner, fingerprint: r.game.fingerprint,
        }));
        els.verify_out.appendChild(d);
      } else {
        const d = showErr("NOT PROVEN.");
        const ul = document.createElement("ul");
        r.problems.forEach((p) => { const li = document.createElement("li"); li.textContent = p; ul.appendChild(li); });
        d.appendChild(ul);
        els.verify_out.appendChild(d);
      }
    } catch (e) { els.verify_out.appendChild(showErr(e.message)); }
  });

  /* ---------------- solo practice ---------------- */

  function fillSoloBets() {
    const g = G.parseGame(els.in_solo_game.value);
    els.in_solo_bet.innerHTML = "";
    for (const b of g.bets) {
      const o = document.createElement("option");
      o.value = b;
      o.textContent = els.in_solo_game.value === "flip" ? b[0].toUpperCase() + b.slice(1)
        : els.in_solo_game.value === "dice-hilo" ? (b === "low" ? "Low (1–3)" : "High (4–6)")
        : "Face " + b;
      els.in_solo_bet.appendChild(o);
    }
  }
  fillSoloBets();
  els.in_solo_game.addEventListener("change", fillSoloBets);

  els.btn_solo_play.addEventListener("click", () => {
    els.solo_out.innerHTML = "";
    try {
      const r = G.practiceRound({ game: els.in_solo_game.value, bet: els.in_solo_bet.value });
      const face = r.game === "flip" ? (r.outcome === "heads" ? "🪙 HEADS" : "🌑 TAILS") : `🎲 ${r.outcome}`;
      const d = showOk(`Round complete — ${r.winner === "player" ? "you win" : "dealer wins"}.`,
        `<p style="font-size:26px;margin:6px 0">${face}</p>` +
        kv({ commitment: r.commitment.slice(0, 24) + "…", secret: r.secret.slice(0, 24) + "…", round: r.roundId }).outerHTML +
        `<p class="hint">${r.note}</p>`);
      els.solo_out.appendChild(d);
      S.soloHistory.unshift(r);
      if (S.soloHistory.length > 12) S.soloHistory.pop();
      els.solo_history.innerHTML = S.soloHistory.map((h) =>
        `<div class="round"><strong class="gold-text">${h.gameName}</strong> · bet <code>${h.bet}</code> → <strong>${h.game === "flip" ? h.outcome : "🎲 " + h.outcome}</strong> · ` +
        `<span class="${h.winner === "player" ? "ok-text" : "bad-text"}">${h.winner === "player" ? "you win" : "dealer wins"}</span><br><code>commit ${h.commitment.slice(0, 20)}… ✓</code></div>`
      ).join("");
    } catch (e) { els.solo_out.appendChild(showErr(e.message)); }
  });

  // boot: solo practice is the default view
  showStep("solo");
})();
