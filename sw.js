// Shared Notes service worker: the app shell offline, and Storm's edits as notifications.
const VERSION = "v1";
const SHELL = ["./", "index.html", "app.js", "vendor/jszip.min.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// the shell: the saved copy answers at once and a fresh one is fetched behind it, so a launch never waits on
// the network and an update lands on the next launch. Dropbox calls pass straight through.
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then((c) => c.match(e.request, { ignoreSearch: true }).then((hit) => {
    const fresh = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh.catch(() => c.match("index.html"));
  })));
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: "Shared Notes", body: e.data ? e.data.text() : "" }; }
  self.clients.matchAll({ type: "window" }).then((cs) => cs.forEach((c) => c.postMessage({ pushed: d })));   // an open app re-syncs
  e.waitUntil(self.registration.showNotification(d.title || "Shared Notes", {
    body: d.body || "", tag: d.id || "notes", renotify: true, icon: "icon-192.png", badge: "icon-192.png", data: { id: d.id || "" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  const url = new URL(id ? "./#n=" + id : "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { c.postMessage({ open: id }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
