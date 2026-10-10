/* Pearl Hush — DOM wiring for the BIP-352 silent payments desk.
   Classic script (no modules): runs after pearl-hush.bundle.js, which sets
   window.PearlHush. Every value shown is computed live from user input;
   nothing here touches a network. Secrets pasted into inputs are wiped on
   demand and the Send tab clears them automatically after deriving. */
(function () {
  "use strict";
  var PS = window.PearlHush;
  if (!PS) {
    document.body.innerHTML = "<p style='padding:40px;font-family:monospace'>PearlHush failed to load (bundle missing?).</p>";
    return;
  }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  /* ---------- deep-link tabs ---------- */
  var STEPS = ["setup", "send", "scan", "labels", "verify"];
  function activate(step, push) {
    if (STEPS.indexOf(step) < 0) step = "setup";
    STEPS.forEach(function (s) { $("step-" + s).classList.toggle("active", s === step); });
    Array.prototype.forEach.call(document.querySelectorAll("#steps button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-step") === step);
    });
    if (push !== false) { try { history.replaceState(null, "", "#" + step); } catch (e) {} }
  }
  Array.prototype.forEach.call(document.querySelectorAll("#steps button"), function (b) {
    b.addEventListener("click", function () { activate(b.getAttribute("data-step")); });
  });
  window.addEventListener("hashchange", function () { activate(location.hash.replace(/^#/, "")); });
  activate(location.hash.replace(/^#/, ""), false);

  /* ---------- QR + copy ---------- */
  function renderQR(el, text) {
    el.innerHTML = "";
    try {
      if (typeof window.qrcode === "undefined") throw new Error("qr lib missing");
      var qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(4, 8);
    } catch (e) { el.textContent = "QR unavailable: " + e.message; }
  }
  Array.prototype.forEach.call(document.querySelectorAll("button.copy"), function (b) {
    b.addEventListener("click", function () {
      var el = $(b.getAttribute("data-copy"));
      var t = (el.tagName === "TEXTAREA" || el.tagName === "INPUT") ? el.value : el.textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(t).catch(function () {});
      b.textContent = "copied";
      setTimeout(function () { b.textContent = "copy"; }, 1200);
    });
  });

  function showError(id, msg) {
    var box = $(id);
    box.hidden = false;
    box.textContent = String(msg).replace(/^REFUSED: /, "Refused: ");
  }
  function hideError(id) { $(id).hidden = true; }

  /* ---------- wipe all keys ---------- */
  var KEY_IDS = ["su-bscan", "su-bspend", "sc-bscan", "sc-bspend", "la-bscan", "la-bspend"];
  $("wipe-keys").addEventListener("click", function () {
    KEY_IDS.forEach(function (id) { $(id).value = ""; });
    Array.prototype.forEach.call(document.querySelectorAll("#se-inputs input[data-k='privkey']"), function (i) { i.value = ""; });
    ["su-result", "se-result", "sc-result", "la-result"].forEach(function (id) { $(id).hidden = true; });
  });

  /* ================= SETUP ================= */
  function showKeyMaterial(bscanHex, bspendHex) {
    var Bscan = PS.compressedPubkeyFromSecret(bscanHex);
    var Bspend = PS.compressedPubkeyFromSecret(bspendHex);
    var addr = PS.encodeSilentPaymentAddress(Bscan, Bspend, "sp");
    $("su-address").textContent = addr;
    $("su-bscan-pub").textContent = Bscan;
    $("su-bspend-pub").textContent = Bspend;
    renderQR($("su-qr"), addr);
    $("su-result").hidden = false;
  }
  $("su-gen").addEventListener("click", function () {
    hideError("su-error");
    try {
      var m = PS.generateKeyMaterial("sp");
      $("su-bscan").value = m.bscanHex;
      $("su-bspend").value = m.bspendHex;
      showKeyMaterial(m.bscanHex, m.bspendHex);
    } catch (e) { showError("su-error", e.message); }
  });
  $("su-derive").addEventListener("click", function () {
    hideError("su-error");
    try {
      var bscan = $("su-bscan").value, bspend = $("su-bspend").value;
      if (!bscan || !bspend) throw new Error("paste both secrets first (or generate new ones).");
      showKeyMaterial(bscan, bspend);
    } catch (e) { showError("su-error", e.message); }
  });

  /* ================= SEND ================= */
  function addInputRow() {
    var tb = document.querySelector("#se-inputs tbody");
    var tr = document.createElement("tr");
    var n = tb.rows.length;
    tr.innerHTML =
      "<td>" + n + "</td>" +
      "<td><input data-k='txid' spellcheck='false' placeholder='64 hex'></td>" +
      "<td><input data-k='vout' type='number' value='0' min='0'></td>" +
      "<td><input data-k='spk' spellcheck='false' placeholder='5120…'></td>" +
      "<td><input data-k='scriptSig' spellcheck='false' placeholder='(empty ok)'></td>" +
      "<td><input data-k='witness' spellcheck='false' placeholder='(empty ok)'></td>" +
      "<td><input data-k='privkey' spellcheck='false' placeholder='64 hex'></td>" +
      "<td><button class='mini del'>✕</button></td>";
    tr.querySelector(".del").addEventListener("click", function () { tr.remove(); renumber(); });
    tb.appendChild(tr);
  }
  function renumber() {
    Array.prototype.forEach.call(document.querySelectorAll("#se-inputs tbody tr"), function (tr, i) {
      tr.cells[0].textContent = i;
    });
  }
  function readInputs() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll("#se-inputs tbody tr"), function (tr) {
      function v(k) { return tr.querySelector("input[data-k='" + k + "']").value; }
      var voutRaw = v("vout").trim();
      if (!/^\d+$/.test(voutRaw) || !Number.isSafeInteger(Number(voutRaw))) throw new Error("bad vout: need a non-negative integer");
      out.push({
        txid: v("txid"), vout: Number(voutRaw),
        prevoutSpk: v("spk"), scriptSig: v("scriptSig"), txinwitness: v("witness"),
        privkey: v("privkey"),
      });
    });
    return out;
  }
  $("se-add-input").addEventListener("click", addInputRow);
  addInputRow();

  $("se-derive").addEventListener("click", function () {
    hideError("se-error");
    $("se-result").hidden = true;
    try {
      var inputs = readInputs();
      var addrs = $("se-recipients").value.split("\n").map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
      if (!addrs.length) throw new Error("add at least one recipient sp1… address.");
      var res = PS.senderCreateOutputs({
        inputs: inputs,
        recipients: addrs.map(function (a) { return { address: a }; }),
        taprootOnly: true,
      });
      var tb = document.querySelector("#se-outputs tbody");
      tb.innerHTML = "";
      res.outputs.forEach(function (o) {
        var tr = document.createElement("tr");
        tr.innerHTML = "<td>" + o.k + "</td><td><code>" + esc(o.pubkeyXonly) + "</code></td>" +
          "<td><code>" + esc(o.prlAddress) + "</code></td>";
        tb.appendChild(tr);
      });
      $("se-inputhash").textContent = res.inputHash;
      $("se-secrets").textContent = res.sharedSecrets.join("  ");
      $("se-skipped").textContent = res.skippedInputs.length
        ? "Skipped " + res.skippedInputs.length + " ineligible input(s): " + res.skippedInputs.join(", ")
        : "All inputs contributed to the shared secret.";
      $("se-result").hidden = false;
      // Wipe pasted input secrets after use — the desk never keeps them.
      Array.prototype.forEach.call(document.querySelectorAll("#se-inputs input[data-k='privkey']"), function (i) { i.value = ""; });
    } catch (e) { showError("se-error", e.message); }
  });

  /* ================= SCAN ================= */
  $("sc-scan").addEventListener("click", function () {
    hideError("sc-error");
    $("sc-result").hidden = true;
    try {
      var bscan = $("sc-bscan").value.trim(), bspend = $("sc-bspend").value.trim();
      if (!bscan || !bspend) throw new Error("paste your scan secret and spend secret first.");
      var labels = $("sc-labels").value.split(",").map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length; }).map(function (s) {
          if (!/^\d+$/.test(s)) throw new Error("bad label (need integer): " + s);
          return parseInt(s, 10);
        });
      var vins;
      try { vins = JSON.parse($("sc-vins").value); }
      catch (e) { throw new Error("inputs must be a JSON array: " + e.message); }
      if (!Array.isArray(vins) || !vins.length) throw new Error("need at least one input.");
      var outputs = $("sc-outputs").value.split("\n").map(function (s) { return s.trim().toLowerCase(); })
        .filter(function (s) { return s.length; });
      if (!outputs.length) throw new Error("paste at least one taproot output key to check.");
      var res = PS.receiverScan({ bscanHex: bscan, bspendHex: bspend, labelMs: labels, vins: vins, outputs: outputs });
      var tb = document.querySelector("#sc-matches tbody");
      tb.innerHTML = "";
      if (res.skipped) {
        var tr = document.createElement("tr");
        tr.innerHTML = "<td colspan='5'><em>" + esc(res.reason || "skipped") + "</em></td>";
        tb.appendChild(tr);
      }
      res.matches.forEach(function (m) {
        var tr2 = document.createElement("tr");
        tr2.innerHTML = "<td>" + m.k + "</td>" +
          "<td>" + (m.labelM === null || m.labelM === undefined ? "—" : "m = " + m.labelM) + "</td>" +
          "<td><code>" + esc(m.pubkeyXonly) + "</code></td>" +
          "<td><code>" + esc(m.prlAddress) + "</code></td>" +
          "<td><code>" + esc(m.spendPrivkey) + "</code></td>";
        tb.appendChild(tr2);
      });
      if (!res.skipped && !res.matches.length) {
        var tr3 = document.createElement("tr");
        tr3.innerHTML = "<td colspan='5'><em>No payments for you in these outputs.</em></td>";
        tb.appendChild(tr3);
      }
      $("sc-result").hidden = false;
    } catch (e) { showError("sc-error", e.message); }
  });

  /* ================= LABELS ================= */
  $("la-derive").addEventListener("click", function () {
    hideError("la-error");
    $("la-result").hidden = true;
    try {
      var bscan = $("la-bscan").value.trim(), bspend = $("la-bspend").value.trim();
      if (!bscan || !bspend) throw new Error("paste your scan secret and spend secret first.");
      var mStr = $("la-m").value.trim();
      if (!/^\d+$/.test(mStr)) throw new Error("label m must be a non-negative integer.");
      var m = parseInt(mStr, 10);
      if (m > 0xffffffff) throw new Error("label m must fit in 32 bits.");
      var Bspend = PS.compressedPubkeyFromSecret(bspend);
      var r = PS.createLabeledAddress(bscan, Bspend, m, "sp");
      $("la-address").textContent = r.address;
      $("la-m-echo").textContent = "(m = " + m + (m === 0 ? ", change" : "") + ")";
      $("la-tweak").textContent = r.tweakHex;
      $("la-bm").textContent = r.BmHex;
      renderQR($("la-qr"), r.address);
      $("la-result").hidden = false;
    } catch (e) { showError("la-error", e.message); }
  });

  /* ================= VERIFY ================= */
  $("ve-decode").addEventListener("click", function () {
    hideError("ve-error");
    $("ve-decode-result").hidden = true;
    try {
      var d = PS.decodeSilentPaymentAddress($("ve-address").value.trim());
      $("ve-hrpver").textContent = d.hrp + " · v" + d.version;
      $("ve-bscan").textContent = d.BscanHex;
      $("ve-bm").textContent = d.BmHex;
      $("ve-decode-result").hidden = false;
    } catch (e) { showError("ve-error", e.message); }
  });

  // Pinned official BIP-352 vector, embedded verbatim from
  // src/vectors-bip352.json so this page can prove its own math without
  // fetching anything. "Single recipient: taproot only inputs with even
  // y-values": send must reproduce the exact output key; scan must find it
  // and derive the exact priv_key_tweak.
  var HUSH_SELFTEST = {"comment":"Single recipient: taproot only inputs with even y-values","send":{"vin":[{"txid":"f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16","vout":0,"scriptSig":"","txinwitness":"0140c459b671370d12cfb5acee76da7e3ba7cc29b0b4653e3af8388591082660137d087fdc8e89a612cd5d15be0febe61fc7cdcf3161a26e599a4514aa5c3e86f47b","spk":"51205a1e61f898173040e20616d43e9f496fba90338a39faa1ed98fcbaeee4dd9be5","privkey":"eadc78165ff1f8ea94ad7cfdc54990738a4c53f6e0507b42154201b8e5dff3b1"},{"txid":"a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d","vout":0,"scriptSig":"","txinwitness":"0140bd1e708f92dbeaf24a6b8dd22e59c6274355424d62baea976b449e220fd75b13578e262ab11b7aa58e037f0c6b0519b66803b7d9decaa1906dedebfb531c56c1","spk":"5120782eeb913431ca6e9b8c2fd80a5f72ed2024ef72a3c6fb10263c379937323338","privkey":"fc8716a97a48ba9a05a98ae47b5cd201a25a7fd5d8b73c203c5f7b6b6b3b6ad7"}],"recipients":["sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv"],"outputs":[["de88bea8e7ffc9ce1af30d1132f910323c505185aec8eae361670421e749a1fb"]]},"recv":{"scan":"0f694e068028a717f8af6b9411f9a133dd3565258714cc226594b34db90c1f2c","spend":"9d6ad855ce3417ef84e836892e5a56392bfba05fa5d97ccea30e266f540e08b3","labels":[],"vin":[{"txid":"f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16","vout":0,"prevoutSpk":"51205a1e61f898173040e20616d43e9f496fba90338a39faa1ed98fcbaeee4dd9be5","scriptSig":"","txinwitness":"0140c459b671370d12cfb5acee76da7e3ba7cc29b0b4653e3af8388591082660137d087fdc8e89a612cd5d15be0febe61fc7cdcf3161a26e599a4514aa5c3e86f47b"},{"txid":"a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d","vout":0,"prevoutSpk":"5120782eeb913431ca6e9b8c2fd80a5f72ed2024ef72a3c6fb10263c379937323338","scriptSig":"","txinwitness":"0140bd1e708f92dbeaf24a6b8dd22e59c6274355424d62baea976b449e220fd75b13578e262ab11b7aa58e037f0c6b0519b66803b7d9decaa1906dedebfb531c56c1"}],"outputs":["de88bea8e7ffc9ce1af30d1132f910323c505185aec8eae361670421e749a1fb"],"found":[{"pub_key":"de88bea8e7ffc9ce1af30d1132f910323c505185aec8eae361670421e749a1fb","priv_key_tweak":"3fb9ce5ce1746ced103c8ed254e81f6690764637ddbc876ec1f9b3ddab776b03"}]}};
  $("ve-selftest").addEventListener("click", function () {
    hideError("ve-error");
    var box = $("ve-selftest-result"), proof = $("ve-proof"), detail = $("ve-proof-detail");
    box.hidden = true;
    proof.classList.remove("failed");
    try {
      var t = HUSH_SELFTEST;
      var sendRes = PS.senderCreateOutputs({
        inputs: t.send.vin.map(function (x) {
          return {
            txid: x.txid, vout: x.vout,
            prevoutSpk: x.spk,
            scriptSig: x.scriptSig || "", txinwitness: x.txinwitness || "",
            privkey: x.privkey,
          };
        }),
        recipients: t.send.recipients.map(function (a) { return { address: a }; }),
      });
      var gotSend = sendRes.outputs.map(function (o) { return o.pubkeyXonly; });
      var wantSend = t.send.outputs[0];
      var sendOk = gotSend.length === wantSend.length && gotSend.every(function (x, i) { return x === wantSend[i]; });
      var recvRes = PS.receiverScan({
        bscanHex: t.recv.scan, bspendHex: t.recv.spend,
        labelMs: t.recv.labels, vins: t.recv.vin, outputs: t.recv.outputs,
      });
      var recvOk = recvRes.matches.length === t.recv.found.length &&
        recvRes.matches.every(function (m, i) {
          return m.pubkeyXonly === t.recv.found[i].pub_key && m.privKeyTweak === t.recv.found[i].priv_key_tweak;
        });
      // Address round-trip: re-encoding the decoded address must be stable.
      var dec = PS.decodeSilentPaymentAddress(t.send.recipients[0]);
      var reenc = PS.encodeSilentPaymentAddress(dec.BscanHex, dec.BmHex, dec.hrp);
      var addrOk = reenc === t.send.recipients[0];
      var allOk = sendOk && recvOk && addrOk;
      proof.textContent = allOk ? "✓ PROVEN — byte-exact vs official BIP-352 vectors" : "✗ FAILED";
      if (!allOk) proof.classList.add("failed");
      detail.textContent = "send " + (sendOk ? "match" : "MISMATCH") + " · receive " +
        (recvOk ? "match" : "MISMATCH") + " · address round-trip " + (addrOk ? "match" : "MISMATCH") +
        " — vector: \"" + t.comment + "\" (full 28-case suite runs in the repo's node tests).";
      box.hidden = false;
    } catch (e) { showError("ve-error", e.message); }
  });
})();
