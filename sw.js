/* Mon tout-en-un : garde les pages sur l'appareil pour qu'elles s'ouvrent hors connexion. */
const V = "tea-v5";
const CORE = ["./", "index.html", "moncap.html", "carnet.html", "shift.html", "formation.html", "conteneur.html", "notes.html", "budget.html", "forex.html", "tea.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const LIBS = ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js"].map(f => SDK + f).concat(["https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"]);
const CDN_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com"];

/* Certains hébergeurs redirigent « page.html » vers « page ». Une réponse redirigée ne peut pas
   servir à ouvrir une page : on en garde donc une copie propre. */
async function clean(r) {
  if (!r || !r.redirected) return r;
  const body = await r.blob();
  return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}
/* Même page sous ses deux écritures : avec et sans « .html ». */
function variants(url) {
  const u = new URL(url); u.search = ""; u.hash = "";
  const out = [u.href];
  if (/\.html$/.test(u.pathname)) { const a = new URL(u.href); a.pathname = a.pathname.replace(/\.html$/, ""); out.push(a.href); if (/\/index\.html$/.test(u.pathname)) { const b = new URL(u.href); b.pathname = b.pathname.replace(/index\.html$/, ""); out.push(b.href); } }
  else if (/\/$/.test(u.pathname)) { const a = new URL(u.href); a.pathname += "index.html"; out.push(a.href); }
  else if (!/\.[a-z0-9]+$/i.test(u.pathname)) { const a = new URL(u.href); a.pathname += ".html"; out.push(a.href); }
  return out;
}
async function fromCache(c, req) {
  for (const v of variants(req.url)) { const m = await c.match(v); if (m) return clean(m); }
  return null;
}

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    await Promise.all(CORE.map(async u => { try { const r = await fetch(new Request(u, { cache: "reload" })); if (r && r.ok) await c.put(new URL(u, self.registration.scope).href, await clean(r)); } catch (x) {} }));
    await Promise.all(LIBS.map(u => fetch(u, { mode: "no-cors" }).then(r => c.put(u, r)).catch(() => {})));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)); }
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  let u; try { u = new URL(req.url); } catch (x) { return; }
  if (u.origin === self.location.origin) {
    // pages et fichiers de l'app : réseau d'abord (pour recevoir les mises à jour), copie locale sinon
    e.respondWith((async () => {
      const c = await caches.open(V);
      try {
        const r = await Promise.race([fetch(req), timeout(5000)]);
        if (r && r.ok && !r.redirected) c.put(req.url.split("#")[0].split("?")[0], r.clone()).catch(() => {});
        if (r && (r.ok || r.type === "opaqueredirect" || r.status < 500)) return r;
        throw new Error("réponse " + r.status);
      } catch (x) {
        const m = (await fromCache(c, req)) || (req.mode === "navigate" ? await fromCache(c, new Request(new URL("index.html", self.registration.scope).href)) : null);
        if (m) return m;
        throw x;
      }
    })());
    return;
  }
  const isSdk = req.url.indexOf(SDK) === 0;
  if (isSdk || CDN_HOSTS.indexOf(u.hostname) >= 0) {
    // bibliothèques et polices : copie locale d'abord
    e.respondWith((async () => {
      const c = await caches.open(V);
      const m = await c.match(req);
      if (m) return m;
      const r = await fetch(req);
      if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()).catch(() => {});
      return r;
    })());
  }
});
