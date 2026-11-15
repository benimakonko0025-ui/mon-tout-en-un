/* Mon tout-en-un : pont entre les apps et Firebase.
   Les pages appellent window.claude.use("db" | "user" | "downloads") ; ici ces appels
   sont servis par Firebase (connexion Google + Firestore) au lieu du compte Claude.
   Toutes les données d'une personne vivent sous  u/{uid}/...  */
(function () {
  "use strict";
  var CFG = {
    apiKey: "AIzaSyBnz1rYofxGze2ba2eS-mRekev5zpE-bto",
    authDomain: "mon-tout-en-un.firebaseapp.com",
    projectId: "mon-tout-en-un",
    storageBucket: "mon-tout-en-un.firebasestorage.app",
    messagingSenderId: "1007776492156",
    appId: "1:1007776492156:web:e056ec15be8012a57af7f9"
  };
  var SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
  var LIBS = ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js"];
  var W = window, D = document;
  var auth = null, fs = null, uid = null, email = "", uname = "";
  var resolveNs, nsPromise = new Promise(function (r) { resolveNs = r; });
  var failed = false;

  /* ---------- téléchargements (sauvegarde) : marche même sans Firebase ---------- */
  var downloads = Object.freeze({
    save: function (o) {
      return new Promise(function (res, rej) {
        try {
          var blob = new Blob([o && o.data != null ? o.data : ""], { type: (o && o.mimeType) || "application/json" });
          var url = URL.createObjectURL(blob), a = D.createElement("a");
          a.href = url; a.download = (o && o.filename) || "sauvegarde.json"; a.style.display = "none";
          D.body.appendChild(a); a.click();
          setTimeout(function () { try { D.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 1500);
          res(true);
        } catch (e) { rej(e); }
      });
    }
  });

  W.claude = Object.freeze({
    use: function (name) {
      if (name === "downloads") return Promise.resolve(downloads);
      if (name !== "db" && name !== "user") return Promise.resolve(null);
      if (failed) return Promise.resolve(null);
      return nsPromise.then(function (ns) { return ns ? ns[name] || null : null; });
    }
  });

  /* ---------- données : Firestore n'accepte ni undefined ni tableau dans un tableau ---------- */
  function enc(v, inArr) {
    if (v === undefined || typeof v === "function") return inArr ? null : undefined;
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) { var a = v.map(function (x) { return enc(x, true); }); return inArr ? { __a: a } : a; }
    var o = {}, k, e;
    for (k in v) if (Object.prototype.hasOwnProperty.call(v, k)) { e = enc(v[k], false); if (e !== undefined) o[k] = e; }
    return o;
  }
  function dec(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(dec);
    if (typeof v.toMillis === "function") return v.toMillis();
    var ks = Object.keys(v);
    if (ks.length === 1 && ks[0] === "__a" && Array.isArray(v.__a)) return v.__a.map(dec);
    var o = {}; ks.forEach(function (k) { o[k] = dec(v[k]); }); return o;
  }
  var NOMETA = { hasPendingWrites: false, fromCache: false };
  function wDoc(s) { return { id: s.id, exists: !!s.exists, metadata: s.metadata || NOMETA, data: function () { return s.exists ? dec(s.data()) : undefined; } }; }
  function wCol(s) { var docs = s.docs.map(wDoc); return { docs: docs, empty: !docs.length, size: docs.length, metadata: s.metadata || NOMETA, forEach: function (f) { docs.forEach(f); } }; }

  /* Hors connexion, Firestore garde l'écriture sur l'appareil et l'envoie plus tard :
     on n'attend donc pas indéfiniment la confirmation du serveur. */
  function settle(p, val) {
    return new Promise(function (res, rej) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; res(val === undefined ? true : val); } }, navigator.onLine === false ? 200 : 2500);
      p.then(function () { if (!done) { done = true; clearTimeout(t); res(val === undefined ? true : val); } },
        function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } else { try { console.warn("[tout-en-un] écriture refusée", e); } catch (x) {} } });
    });
  }
  /* Lecture : le serveur d'abord, la copie de l'appareil s'il tarde ou manque. */
  function getSafe(ref) {
    return new Promise(function (res, rej) {
      var done = false, ok = function (s) { if (!done) { done = true; clearTimeout(t); res(s); } };
      var cache = function (onFail) { try { ref.get({ source: "cache" }).then(ok, onFail || function () {}); } catch (e) { if (onFail) onFail(e); } };
      var t = setTimeout(function () { if (!done) cache(); }, navigator.onLine === false ? 60 : 4000);
      ref.get().then(ok, function (e) { if (!done) cache(function () { if (!done) { done = true; clearTimeout(t); rej(e); } }); });
    });
  }
  function P(path) { return "u/" + uid + "/" + String(path).replace(/^\/+|\/+$/g, ""); }
  function mkDoc(r) {
    return {
      id: r.id,
      get: function () { return getSafe(r).then(wDoc); },
      set: function (d, opt) { return settle(opt ? r.set(enc(d), opt) : r.set(enc(d))); },
      update: function (d) { return settle(r.update(enc(d))); },
      delete: function () { return settle(r.delete()); },
      onSnapshot: function (cb, err) { return r.onSnapshot(function (s) { cb(wDoc(s)); }, err || function () {}); }
    };
  }
  function mkQuery(q, isCol) {
    var o = {
      get: function () { return getSafe(q).then(wCol); },
      where: function (f, op, v) { return mkQuery(q.where(f, op, v)); },
      orderBy: function (f, d) { return mkQuery(d ? q.orderBy(f, d) : q.orderBy(f)); },
      limit: function (n) { return mkQuery(q.limit(n)); },
      onSnapshot: function (cb, err) { return q.onSnapshot(function (s) { cb(wCol(s)); }, err || function () {}); }
    };
    if (isCol) {
      o.doc = function (id) { return mkDoc(id == null ? q.doc() : q.doc(String(id))); };
      o.add = function (d) { var r = q.doc(); return settle(r.set(enc(d)), mkDoc(r)); };
    }
    return o;
  }
  function makeNs() {
    return {
      db: Object.freeze({ collection: function (p) { return mkQuery(fs.collection(P(p)), true); }, doc: function (p) { return mkDoc(fs.doc(P(p))); } }),
      user: Object.freeze({ id: function () { return Promise.resolve(uid); }, email: function () { return Promise.resolve(email); }, me: function () { return Promise.resolve({ id: uid, name: uname, email: email }); } })
    };
  }

  /* ---------- écran de connexion ---------- */
  var ov = null;
  function domReady(f) { if (D.body) f(); else D.addEventListener("DOMContentLoaded", f); }
  function showLogin(msg) {
    domReady(function () {
      if (!ov) {
        ov = D.createElement("div"); ov.id = "tea-login";
        ov.setAttribute("style", "position:fixed;inset:0;z-index:2147483000;background:#0d0e11;color:#f2f3f5;display:flex;align-items:center;justify-content:center;padding:24px;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif");
        ov.innerHTML = '<div style="max-width:360px;text-align:center"><div style="font-size:26px;font-weight:700;margin-bottom:6px">Mon <span style="color:#ff6a1a">tout-en-un</span></div>' +
          '<p style="color:#9aa1ac;margin:0 0 22px">Connecte-toi avec ton compte Google pour retrouver tes données sur tous tes appareils.</p>' +
          '<button id="tea-go" type="button" style="font:inherit;font-weight:600;border:0;border-radius:14px;padding:14px 22px;background:#ff6a1a;color:#fff;cursor:pointer;width:100%">Se connecter avec Google</button>' +
          '<p id="tea-msg" role="status" style="color:#ffc244;font-size:14px;min-height:1.5em;margin:16px 0 0"></p></div>';
        D.body.appendChild(ov);
        D.getElementById("tea-go").addEventListener("click", signIn);
      }
      ov.style.display = "flex";
      if (msg) D.getElementById("tea-msg").textContent = msg;
    });
  }
  function hideLogin() { if (ov) ov.style.display = "none"; }
  function say(t) { var m = D.getElementById("tea-msg"); if (m) m.textContent = t; }
  function authMsg(e) {
    var c = (e && e.code) || "";
    if (c === "auth/unauthorized-domain") return "Ce site n'est pas encore autorisé dans Firebase : Authentication, Paramètres, Domaines autorisés.";
    if (c === "auth/network-request-failed") return "Pas de connexion Internet. Réessaie quand le réseau revient.";
    if (c === "auth/popup-closed-by-user" || c === "auth/cancelled-popup-request" || c === "auth/user-cancelled") return "Connexion annulée. Touche le bouton pour réessayer.";
    return "Connexion impossible (" + (c || "erreur") + "). Réessaie.";
  }
  function signIn() {
    if (!auth) { say("Chargement en cours, réessaie dans un instant."); return; }
    var provider = new W.firebase.auth.GoogleAuthProvider();
    say("Ouverture de la connexion Google…");
    auth.signInWithPopup(provider).then(function () { say("Connecté. Chargement…"); }, function (e) {
      var c = (e && e.code) || "";
      if (c === "auth/popup-blocked" || c === "auth/operation-not-supported-in-this-environment") {
        try { auth.signInWithRedirect(provider).catch(function (e2) { say(authMsg(e2)); }); } catch (e3) { say(authMsg(e3)); }
      } else say(authMsg(e));
    });
  }
  function fillAccount() {
    domReady(function () {
      var el = D.getElementById("tea-acct"); if (!el) return;
      el.hidden = false; el.textContent = "";
      var s = D.createElement("span"); s.textContent = "Connecté : " + (email || "compte Google") + " · ";
      var b = D.createElement("button"); b.type = "button"; b.textContent = "Se déconnecter";
      b.setAttribute("style", "font:inherit;background:none;border:0;color:#ff8a3d;text-decoration:underline;cursor:pointer;padding:0");
      b.addEventListener("click", function () { if (auth) auth.signOut(); });
      el.appendChild(s); el.appendChild(b);
    });
  }

  /* ---------- démarrage ---------- */
  function fail(msg) {
    failed = true; resolveNs(null);
    try { console.warn("[tout-en-un] " + msg); } catch (e) {}
    domReady(function () {
      var n = D.createElement("div");
      n.setAttribute("style", "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;background:#2a2118;color:#ffc244;border:1px solid #6b4a12;border-radius:12px;padding:10px 14px;font:14px/1.4 system-ui,sans-serif;text-align:center");
      n.textContent = "Synchronisation indisponible pour le moment : tes modifications restent sur cet appareil. Recharge la page quand le réseau revient.";
      D.body.appendChild(n); setTimeout(function () { try { n.remove(); } catch (e) {} }, 9000);
    });
  }
  function start() {
    try {
      var fb = W.firebase;
      if (!fb || !fb.auth || !fb.firestore) { fail("Firebase non chargé"); return; }
      fb.initializeApp(CFG);
      auth = fb.auth(); fs = fb.firestore();
      try { fs.settings({ ignoreUndefinedProperties: true }); } catch (e) {}
      try { fs.enablePersistence({ synchronizeTabs: true }).catch(function () {}); } catch (e) {}
      try { auth.getRedirectResult().catch(function (e) { showLogin(authMsg(e)); }); } catch (e) {}
      var first = true;
      auth.onAuthStateChanged(function (u) {
        if (u) {
          if (uid && uid !== u.uid) { location.reload(); return; }
          if (!uid) { uid = u.uid; email = u.email || ""; uname = u.displayName || ""; resolveNs(makeNs()); }
          hideLogin(); fillAccount();
        } else {
          if (uid) { location.reload(); return; }
          showLogin(first ? "" : "");
        }
        first = false;
      }, function () { showLogin("Connexion impossible pour le moment."); });
    } catch (e) { fail("Démarrage Firebase impossible : " + (e && e.message)); }
  }
  function load(i) {
    if (i >= LIBS.length) { start(); return; }
    var s = D.createElement("script"); s.src = SDK + LIBS[i]; s.async = false;
    s.onload = function () { load(i + 1); };
    s.onerror = function () { fail("Bibliothèque Firebase injoignable"); };
    (D.head || D.documentElement).appendChild(s);
  }
  load(0);

  /* ---------- application installable + mode hors connexion ---------- */
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    W.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
  var deferred = null;
  W.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferred = e;
    var b = D.getElementById("tea-install"); if (!b) return;
    b.hidden = false;
    b.onclick = function () { if (!deferred) return; deferred.prompt(); deferred.userChoice.then(function () { deferred = null; b.hidden = true; }); };
  });
  W.addEventListener("appinstalled", function () { var b = D.getElementById("tea-install"); if (b) b.hidden = true; });
})();
