/* Pearl Names — page logic. All crypto via window.PearlNames
 * (audited Sign/Etch cores underneath). Keys live in page memory only.
 * localStorage is treated as hostile: every access is guarded. */
(function () {
  "use strict";
  var E = window.PearlNames;
  if (!E) { document.body.innerHTML = "<p style='padding:40px'>Pearl Names failed to load (pearl-names.bundle.js missing).</p>"; return; }

  var key = null;        // { priv, internalXOnly, address, xonly, network }
  var regName = null, regNetwork = "mainnet", regExpiry = null;
  var signed = null;     // { json, sig, id, fingerprint, fields }
  var plan = null, payload = null, commitTx = null, revealTx = null, commitTxid = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function show(el, on) { el.hidden = !on; }
  function setErr(id, msg) { var el = $(id); el.textContent = msg; show(el, !!msg); }
  function fmtPRL(g) {
/* BigInt-exact (pool float-format class): the old float format
     * silently rounds grain counts past Number.MAX_SAFE_INTEGER.
     * Integer string/BigInt grain counts format exactly; anything
     * else keeps the legacy float rendering. */
    const s = typeof g === "bigint" ? g.toString() : String(g).trim();
    if (!/^-?\d+$/.test(s)) return (Number(g) / 1e8).toFixed(8).replace(/\.?0+$/, "") + " PRL";
    const b = BigInt(s), neg = b < 0n, a = neg ? -b : b;
    const w = (a / 100000000n).toString();
    const f = (a % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + w + (f ? "." + f : "") + " PRL";
  }
  function fmtTs(ts) { return new Date(ts * 1000).toISOString().slice(0, 19) + "Z"; }
  function copyText(text, btn) {
    var done = function () {
      if (!btn) return;
      var old = btn.textContent; btn.textContent = "Copied ✓";
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }
  function download(name, text) {
    var blob = new Blob([text], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function storeDel(k) { try { window.localStorage.removeItem(k); } catch (e) {} }

  /* ---------- tabs ---------- */
  document.querySelectorAll("#tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("#tabs button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      document.querySelectorAll(".tab").forEach(function (t) {
        t.classList.toggle("active", t.id === "tab-" + b.dataset.tab);
      });
      if (b.dataset.tab === "directory") renderDirectory();
    });
  });
  document.querySelectorAll(".copy-btn[data-for]").forEach(function (b) {
    b.addEventListener("click", function () { copyText($(b.dataset.for).textContent, b); });
  });

  /* ---------- register step 1: name ---------- */
  $("r-check").addEventListener("click", function () {
    setErr("r-name-err", ""); show($("r-name-ok"), false);
    regName = null;
    var raw = $("r-name").value;
    try {
      var n = E.validateName(raw);
      regName = n; regNetwork = $("r-network").value;
      var ex = $("r-expiry").value.trim();
      /* Strict expiry parse: bare parseInt truncated "1893456000.9" to
         1893456000 and exponent input to its leading digit, and a long
         digit string became an unsafe integer — the value is signed
         into the binding as expires_at, so refuse anything but digits. */
      regExpiry = null;
      if (ex !== "") {
        if (!/^\d+$/.test(ex)) throw new Error("expiry must be a positive unix timestamp");
        regExpiry = Number(ex);
        if (!Number.isSafeInteger(regExpiry) || regExpiry <= 0) throw new Error("expiry must be a positive unix timestamp");
      }
      // local availability check
      var regs = loadRegistry();
      var taken = regs.some(function (r) {
        try { return JSON.parse(r.json).name === n; } catch (e) { return false; }
      });
      var okEl = $("r-name-ok");
      okEl.textContent = "✓ " + n + ".prl is available" + (taken ? " locally — note: it exists in your local registry already" : "") + " on " + regNetwork + ".";
      show(okEl, true);
    } catch (e) { setErr("r-name-err", e.message); }
  });

  /* ---------- register step 2: prove ---------- */
  $("r-gen").addEventListener("click", function () {
    $("r-key").value = E.newMnemonic();
  });
  function loadKey() {
    var text = $("r-key").value.trim();
    var net = E.NETWORKS[regNetwork || "mainnet"];
    var w;
    if (/\s/.test(text)) w = E.walletFromMnemonic(text, net);
    else if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) w = E.walletFromPriv(text.replace(/^0x/, ""), net);
    else w = E.walletFromWIF(text, net);
    return { priv: w.priv, internalXOnly: w.internalXOnly, address: w.address, xonly: E.bytesToHex(w.internalXOnly), network: regNetwork };
  }
  $("r-prove").addEventListener("click", function () {
    setErr("r-prove-err", ""); show($("r-proof"), false); signed = null;
    if (!regName) { setErr("r-prove-err", "Check a name in Step 1 first."); return; }
    try {
      key = loadKey();
      var now = Math.floor(Date.now() / 1000);
      var binding = E.composeBinding({
        name: regName, address: key.address, xonly: key.xonly,
        network: regNetwork, registeredAt: now, expiresAt: regExpiry,
      });
      var sig = E.signBinding(key.priv, binding, E.NETWORKS[regNetwork]);
      var v = E.verifySignedBinding({ json: binding.json, sig: E.bytesToHex(sig) });
      if (!v.ok) throw new Error("self-verification failed: " + v.checks.filter(function (c) { return !c.ok; }).map(function (c) { return c.label + " — " + c.detail; }).join("; "));
      signed = { json: binding.json, sig: E.bytesToHex(sig), id: v.id, fingerprint: v.fingerprint, fields: binding.fields };
      $("r-proof-id").textContent = v.id;
      $("r-proof-fp").textContent = v.fingerprint;
      $("r-proof-sig").textContent = E.bytesToHex(sig);
      $("r-proof-json").value = binding.json;
      show($("r-proof"), true);
    } catch (e) { setErr("r-prove-err", e.message); }
  });
  $("r-wipe").addEventListener("click", function () {
    if (key && key.priv) { try { key.priv.fill(0); } catch (e) {} }
    key = null; $("r-key").value = "";
    setErr("r-prove-err", ""); show($("r-proof"), false); signed = null;
  });

  /* ---------- register step 3: plan ---------- */
  $("r-plan").addEventListener("click", function () {
    setErr("r-plan-err", ""); show($("r-plan-out"), false); plan = null; payload = null;
    if (!signed) { setErr("r-plan-err", "Sign the registration in Step 2 first."); return; }
    try {
      var net = E.NETWORKS[regNetwork];
      payload = E.composeNamePayload({ binding: { json: signed.json }, sigHex: signed.sig });
      var rate = Math.max(1, Math.ceil(Number($("r-feerate").value)));
      if (!Number.isFinite(rate)) throw new Error("bad fee rate");
      plan = E.planNameInscription({
        network: net, internalXOnly: key.internalXOnly, payload: payload,
        ownerAddress: key.address, changeAddress: key.address, feeRate: rate,
      });
      $("r-plan-commitaddr").textContent = plan.commitAddress;
      $("r-plan-fee").textContent = plan.revealFee + " grains (" + fmtPRL(plan.revealFee) + ")";
      $("r-plan-commitval").textContent = plan.commitValue + " grains (" + fmtPRL(plan.commitValue) + ")";
      $("r-plan-leaf").textContent = plan.leafHash;
      show($("r-plan-out"), true);
    } catch (e) { setErr("r-plan-err", e.message); }
  });

  /* ---------- register step 4: broadcast ---------- */
  function parseUtxo() {
    var parts = $("r-utxo").value.trim().split(":");
    if (parts.length !== 3) throw new Error("UTXO must look like txid:vout:value");
    if (!/^[0-9a-f]{64}$/i.test(parts[0])) throw new Error("bad txid");
    if (!/^\d+$/.test(parts[1])) throw new Error("bad vout");
    if (!/^\d+$/.test(parts[2])) throw new Error("bad value");
    var vout = Number(parts[1]), value = Number(parts[2]);
    if (!Number.isSafeInteger(vout) || vout < 0) throw new Error("bad vout");
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("bad value");
    return { txid: parts[0].toLowerCase(), vout: vout, value: value };
  }
  $("r-commit").addEventListener("click", function () {
    setErr("r-bc-err", ""); commitTx = null; revealTx = null; commitTxid = null;
    if (!plan || !key) { setErr("r-bc-err", "Build a plan in Step 3 and keep your key loaded."); return; }
    try {
      var u = parseUtxo();
      commitTx = E.buildCommitTx({
        network: E.NETWORKS[regNetwork],
        fundingInputs: [{ txid: u.txid, vout: u.vout, value: u.value, program: E.addressToProgram(key.address, E.NETWORKS[regNetwork]), priv: key.priv, internalXOnly: key.internalXOnly }],
        commitProgram: plan.commitProgram, commitValue: plan.commitValue,
        changeProgram: plan.changeProgram, feeRate: plan.feeRate,
      });
      commitTxid = commitTx.txid;
      revealTx = E.buildRevealTxSigned({ plan: plan, commitTxid: commitTxid, commitVout: 0, internalPriv: key.priv, changeAddress: key.address });
      // sanity: our own reveal must parse back to our envelope
      var back = E.verifyNameWitness(revealTx.hex);
      if (!back.verify.ok) throw new Error("reveal self-check failed");
      $("r-commit-hex").value = commitTx.hex;
      $("r-reveal-hex").value = revealTx.hex;
      show($("r-txs"), true);
    } catch (e) { setErr("r-bc-err", e.message); }
  });
  $("r-reveal").addEventListener("click", function () { $("r-commit").click(); });
  function doubleConfirm(label) {
    return window.confirm("Broadcast " + label + " to " + regNetwork + "? This spends real PRL and cannot be undone.") &&
           window.confirm("Final check — broadcast " + label + " NOW?");
  }
  function bb() { return $("r-blockbook").value.trim().replace(/\/+$/, ""); }
  $("r-bc-commit").addEventListener("click", function () {
    setErr("r-bc-err", "");
    if (!commitTx || !doubleConfirm("the COMMIT transaction")) return;
    E.broadcastTx(bb(), commitTx.hex).then(function (r) {
      $("r-bc-err").className = "ok";
      setErr("r-bc-err", "Commit broadcast accepted: " + (r.txid || commitTx.txid) + " — wait for confirmation, then broadcast the reveal.");
    }).catch(function (e) { $("r-bc-err").className = "err"; setErr("r-bc-err", "Broadcast failed: " + e.message); });
  });
  $("r-bc-reveal").addEventListener("click", function () {
    setErr("r-bc-err", "");
    if (!revealTx || !doubleConfirm("the REVEAL transaction")) return;
    var self = this;
    E.broadcastTx(bb(), revealTx.hex).then(function (r) {
      $("r-bc-err").className = "ok";
      setErr("r-bc-err", "Reveal broadcast accepted: " + (r.txid || revealTx.txid));
      var cert = E.buildNameCertificate({ plan: plan, payload: payload, commitTxid: commitTxid, revealTxid: r.txid || revealTx.txid, blockHeight: null, blockTime: null });
      $("r-cert-json").textContent = JSON.stringify(cert, null, 2);
      show($("r-cert"), true);
      addToRegistry(signed);
    }).catch(function (e) { $("r-bc-err").className = "err"; setErr("r-bc-err", "Broadcast failed: " + e.message); });
  });

  /* ---------- directory ---------- */
  var REG_KEY = "pearl-names-registry";
  function loadRegistry() {
    try { var r = JSON.parse(storeGet(REG_KEY) || "[]"); return Array.isArray(r) ? r : []; }
    catch (e) { return []; }
  }
  function saveRegistry(regs) { storeSet(REG_KEY, JSON.stringify(regs)); }
  function addToRegistry(s) {
    var regs = loadRegistry();
    if (!regs.some(function (r) { return r.json === s.json; })) { regs.push({ json: s.json, sig: s.sig }); saveRegistry(regs); }
    renderDirectory();
  }
  $("d-add").addEventListener("click", function () { show($("d-addbox"), $("d-addbox").hidden); });
  $("d-clear").addEventListener("click", function () {
    if (window.confirm("Clear the local name registry?")) { storeDel(REG_KEY); renderDirectory(); }
  });
  $("d-import").addEventListener("click", function () {
    setErr("d-err", "");
    try {
      var obj = JSON.parse($("d-json").value);
      var v = E.verifySignedBinding(obj);
      if (!v.ok) throw new Error("binding invalid: " + v.checks.filter(function (c) { return !c.ok; }).map(function (c) { return c.label; }).join(", "));
      addToRegistry({ json: obj.json, sig: typeof obj.sig === "string" ? obj.sig : E.bytesToHex(obj.sig) });
      $("d-json").value = ""; show($("d-addbox"), false);
    } catch (e) { setErr("d-err", e.message); }
  });
  $("d-search").addEventListener("input", renderDirectory);
  function renderDirectory() {
    var regs = loadRegistry();
    var q = $("d-search").value.trim().toLowerCase();
    var res = E.resolveRegistry(regs);
    var rows = [];
    res.winners.forEach(function (w, name) {
      var v = E.verifySignedBinding(w.rec);
      if (q && name.indexOf(q) < 0 && v.address.toLowerCase().indexOf(q) < 0) return;
      rows.push("<tr><td><b>" + esc(name) + ".prl</b></td><td class='mono'>" + esc(v.address.slice(0, 18)) + "…" + "</td><td class='mono'>" + esc(w.fingerprint) + "</td><td>" + esc(fmtTs(v.checks.length ? JSON.parse(w.rec.json).registered_at : 0)) + "</td><td class='status-ok'>✓ registered</td></tr>");
    });
    $("d-rows").innerHTML = rows.length ? rows.join("") : "<tr><td colspan='5' class='dim'>No names yet — register one or import a signed binding.</td></tr>";
    var cl = $("d-contested-list"); cl.innerHTML = "";
    res.contested.forEach(function (c) {
      var li = document.createElement("li");
      li.innerHTML = "<span class='status-warn'>⚠ contested</span> <b>" + esc(JSON.parse(c.rec.json).name) + ".prl</b> — later claim by <span class='mono'>" + esc(JSON.parse(c.rec.json).address.slice(0, 18)) + "…</span>";
      cl.appendChild(li);
    });
    show($("d-contested"), res.contested.length > 0);
  }

  /* ---------- verify ---------- */
  $("v-run").addEventListener("click", function () {
    setErr("v-err", ""); show($("v-out"), false);
    try {
      var obj = JSON.parse($("v-input").value);
      showVerdict(E.verifySignedBinding(obj));
    } catch (e) { setErr("v-err", e.message); }
  });
  $("v-witness").addEventListener("click", function () { show($("v-witnessbox"), $("v-witnessbox").hidden); });
  $("v-run-witness").addEventListener("click", function () {
    setErr("v-err", ""); show($("v-out"), false);
    try {
      var r = E.verifyNameWitness($("v-revealhex").value.trim());
      showVerdict(r.verify, " (from on-chain reveal envelope)");
    } catch (e) { setErr("v-err", e.message); }
  });
  function showVerdict(v, extra) {
    var h = $("v-verdict");
    var warn = v.ok && v.checks.some(function (c) { return c.warn; });
    h.textContent = (v.ok ? (warn ? "VALID ⚠" : "VALID ✓") : "INVALID ✕") + (extra || "");
    h.className = v.ok ? "valid" : "invalid";
    var ul = $("v-checks"); ul.innerHTML = "";
    v.checks.forEach(function (c) {
      var li = document.createElement("li");
      li.className = c.ok ? "pass" : "fail";
      li.innerHTML = (c.ok ? "✓ " : "✕ ") + "<b>" + esc(c.label) + "</b> — " + esc(c.detail) + (c.warn ? " <span class='warn-tag'>⚠</span>" : "");
      ul.appendChild(li);
    });
    $("v-id").textContent = v.id || "—";
    $("v-fp").textContent = v.fingerprint || "—";
    show($("v-out"), true);
  }

  /* ---------- export ---------- */
  $("x-registry").addEventListener("click", function () {
    setErr("x-err", "");
    download("pearl-names-registry.json", JSON.stringify(loadRegistry(), null, 2));
  });
  $("x-envelope").addEventListener("click", function () {
    setErr("x-err", "");
    if (!signed) { setErr("x-err", "Sign a registration in Step 2 first."); return; }
    var payload = E.composeNamePayload({ binding: { json: signed.json }, sigHex: signed.sig });
    download("prl-name-envelope.json", JSON.stringify(JSON.parse(payload.json), null, 2));
  });

  renderDirectory();
})();
