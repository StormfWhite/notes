/*
 * Shared Notes — Joanna's window onto the "Shared" folder of Storm's Notes app.
 *
 * Same files as the Pixel app (Note.java / Rich.java) and the laptop app (notes_desktop.py):
 * one Markdown file per note in Dropbox /notes/<id>.md with a small --- header. Only notes whose
 * header says `folder: Shared` (or a Shared/… subfolder) show here. Everything runs in the browser:
 * Dropbox API straight from the phone (PKCE, code pasted back — no server), a local copy for
 * offline use, longpoll for live updates, and a 3-way line merge when both sides edited a note.
 * Notes saved here carry `by: web:<device>`; Storm's apps drop that key when they save, so the laptop's
 * push sender (notes-app/push/notes_push.py) knows which changes were Storm's.
 */
"use strict";

const APP_KEY = "qsmbpc4l1v4uini";
const ROOT = "/notes";
const SHARED = "Shared";
const VAPID = "BF_YuaDjvJ4kEGdiX1lRq4JkyqKNQeRMRttfOWjfEd509gf_HhaCvzZdHwnPakMEhgJTWpmznx4VZO1TWckaC6c";
const LS = "sharednotes.v1";

const $ = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// =============================================================================================
// the file format (keep in step with Note.java, Rich.java, notes_desktop.py)
// =============================================================================================

const KEYS = ["id", "created", "modified", "folder", "source", "pinned", "dismissed", "locked", "deleted", "by"];

function parseNote(text) {
  const n = { id: "", created: 0, modified: 0, folder: "", source: "", pinned: false, dismissed: false,
    locked: false, deleted: 0, by: "", body: text };
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end > 0) {
      for (const line of text.slice(4, end).split("\n")) {
        const c = line.indexOf(":");
        if (c < 0) continue;
        const k = line.slice(0, c).trim(), v = line.slice(c + 1).trim();
        if (k === "id" || k === "folder" || k === "source" || k === "by") n[k] = v;
        else if (k === "created" || k === "modified" || k === "deleted") n[k] = Number(v) || 0;
        else if (k === "pinned" || k === "dismissed" || k === "locked") n[k] = v === "1";
      }
      n.body = text.slice(end + 5);
    }
  }
  return n;
}

function serializeNote(n) {
  let s = "---\n" + `id: ${n.id}\ncreated: ${n.created}\nmodified: ${n.modified}\n`;
  if (n.folder) s += `folder: ${n.folder}\n`;
  if (n.source) s += `source: ${n.source}\n`;
  if (n.pinned) s += "pinned: 1\n";
  if (n.dismissed) s += "dismissed: 1\n";
  if (n.locked) s += "locked: 1\n";
  if (n.deleted) s += `deleted: ${n.deleted}\n`;
  if (n.by) s += `by: ${n.by}\n`;
  return s + "---\n" + n.body;
}

const isShared = (n) => !n.deleted && !n.locked && (n.folder === SHARED || n.folder.startsWith(SHARED + "/"));

const PREFIX = /^(#{1,3} |- \[ \] |- \[[xX]\] |\* |- |\d+\. |> |`` )/;
const TABLE_ROW = /^\|.*\|\s*$/;
const TABLE_SEP = /^\|(\s*:?-{3,}:?\s*\|)+\s*$/;
const KIND_OF = { "# ": "title", "## ": "head", "### ": "sub", "- [ ] ": "open", "* ": "bullet", "- ": "dash", "> ": "quote", "`` ": "mono" };
const PREFIX_OF = { title: "# ", head: "## ", sub: "### ", open: "- [ ] ", done: "- [x] ", bullet: "* ", dash: "- ", quote: "> ", mono: "`` ", plain: "" };
const LISTY = new Set(["open", "done", "bullet", "dash", "num", "quote"]);
const HL_CODES = "pkomb";

function tableCells(row) {
  let r = row.trim();
  r = r.endsWith("|") && !r.endsWith("\\|") && r.length > 1 ? r.slice(1, -1) : r.slice(1);
  return r.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

/** Markdown body → blocks: {type:"line", kind, tabs, text, src} | {type:"table", rows, src[]} — Rich.fromMarkdown's rules. */
function parseBody(md) {
  const lines = md.split("\n"), out = [];
  let titled = false;
  for (let i = 0; i < lines.length; i++) {
    const l0 = lines[i];
    if (TABLE_ROW.test(l0)) {
      const src = [l0];
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1])) src.push(lines[++i]);
      const rows = src.filter((l, k) => !(k > 0 && TABLE_SEP.test(l))).map(tableCells);   // --- lines are rebuilt on save
      out.push({ type: "table", rows, src });
      titled = true;
      continue;
    }
    let sp = 0;
    while (sp < l0.length && l0[sp] === " ") sp++;
    let l = l0.slice(sp), kind = "plain";
    const m = PREFIX.exec(l);
    if (m) {
      const p = m[1];
      kind = KIND_OF[p] || (p.startsWith("- [") ? "done" : "num");
      l = l.slice(p.length);
    } else if (!titled && l.trim() && sp === 0) kind = "title";
    if (l.trim() || kind !== "plain") titled = true;
    out.push({ type: "line", kind, tabs: Math.floor(sp / 2), text: l, src: l0 });
  }
  return out;
}

/** '**a** _b_ ==p:c==' → runs [{t, b, i, u, s, hl}] — the phone's inline rules. */
function parseInline(s) {
  const on = [false, false, false, false];
  let hl = "", buf = "", i = 0;
  const out = [];
  const flush = () => { if (buf) { out.push({ t: buf, b: on[0], i: on[1], u: on[2], s: on[3], hl }); buf = ""; } };
  const closes = (from, w) => {
    if (w === 0) return s.indexOf("**", from) >= 0;
    if (w === 2) return s.indexOf("</u>", from) >= 0;
    if (w === 3) return s.indexOf("~~", from) >= 0;
    for (let j = from; j < s.length; j++) if (s[j] === "_" && (j + 1 >= s.length || !/[\p{L}\p{N}]/u.test(s[j + 1]))) return true;
    return false;
  };
  while (i < s.length) {
    if (!hl && s.startsWith("==", i) && i + 3 < s.length && HL_CODES.includes(s[i + 2]) && s[i + 3] === ":" && s.indexOf("==", i + 4) > 0) {
      flush(); hl = s[i + 2]; i += 4; continue;
    }
    if (hl && s.startsWith("==", i)) { flush(); hl = ""; i += 2; continue; }
    let w = -1, ln = 0;
    if (s.startsWith("**", i)) { w = 0; ln = 2; }
    else if (s.startsWith("<u>", i) && !on[2]) { w = 2; ln = 3; }
    else if (s.startsWith("</u>", i) && on[2]) { w = 2; ln = 4; }
    else if (s.startsWith("~~", i)) { w = 3; ln = 2; }
    else if (s[i] === "_") {
      const before = i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1]);
      const after = i + 1 >= s.length || !/[\p{L}\p{N}]/u.test(s[i + 1]);
      if ((!on[1] && before && i + 1 < s.length && s[i + 1] !== " ") || (on[1] && after)) { w = 1; ln = 1; }
    }
    if (w >= 0 && (on[w] || closes(i + ln, w))) { flush(); on[w] = !on[w]; i += ln; continue; }
    buf += s[i++];
  }
  flush();
  return out;
}

/** Runs → Markdown, highlight outermost (the canonical order both apps write). */
function runsToMd(runs) {
  const opens = ["**", "_", "<u>", "~~"], closes = ["**", "_", "</u>", "~~"];
  const on = [false, false, false, false];
  let hl = "", o = "";
  for (const r of runs) {
    const want = [r.b, r.i, r.u, r.s], change = (r.hl || "") !== hl;
    for (let k = 3; k >= 0; k--) if (on[k] && (!want[k] || change)) { o += closes[k]; on[k] = false; }
    if (change && hl) o += "==";
    if (change && r.hl) o += `==${r.hl}:`;
    hl = r.hl || "";
    for (let k = 0; k < 4; k++) if (want[k] && !on[k]) { o += opens[k]; on[k] = true; }
    o += r.t;
  }
  for (let k = 3; k >= 0; k--) if (on[k]) o += closes[k];
  if (hl) o += "==";
  return o;
}

const TAG = /(?<![\w#/&])#(?!(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b)([\p{L}\p{N}_-]*\p{L}[\p{L}\p{N}_-]*)/gu;

function runsToHtml(runs) {
  return runs.map((r) => {
    let h = esc(r.t);
    if (r.s) h = `<s>${h}</s>`;
    if (r.u) h = `<u>${h}</u>`;
    if (r.i) h = `<i>${h}</i>`;
    if (r.b) h = `<b>${h}</b>`;
    if (r.hl) h = `<mark data-hl="${r.hl}">${h}</mark>`;
    return h;
  }).join("");
}

/** A contenteditable node → runs. BR becomes "\n" (only meaningful inside table cells). */
function domRuns(node) {
  const out = [];
  const walk = (n, st) => {
    if (n.nodeType === 3) {
      const t = n.nodeValue.replace(/ /g, " ").replace(/​/g, "");
      if (t) out.push({ t, ...st });
      return;
    }
    if (n.nodeType !== 1) return;
    const tag = n.tagName;
    if (tag === "BR") { out.push({ t: "\n", ...st }); return; }
    const s2 = { ...st };
    const fw = n.style && n.style.fontWeight;
    if (tag === "B" || tag === "STRONG" || fw === "bold" || Number(fw) >= 600) s2.b = true;
    if (tag === "I" || tag === "EM" || (n.style && n.style.fontStyle === "italic")) s2.i = true;
    if (tag === "U" || (n.style && /underline/.test(n.style.textDecoration || ""))) s2.u = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL" || (n.style && /line-through/.test(n.style.textDecoration || ""))) s2.s = true;
    if (tag === "MARK" && n.dataset.hl) s2.hl = n.dataset.hl;
    for (const c of n.childNodes) walk(c, s2);
  };
  for (const c of node.childNodes) walk(c, { b: false, i: false, u: false, s: false, hl: "" });
  const merged = [];   // join neighbours with the same style
  for (const r of out) {
    const p = merged[merged.length - 1];
    if (p && p.b === r.b && p.i === r.i && p.u === r.u && p.s === r.s && p.hl === r.hl) p.t += r.t;
    else merged.push({ ...r });
  }
  return merged;
}

/** Note.plain: one line as the list shows it. */
function plain(line) {
  if (TABLE_SEP.test(line)) return "";
  if (TABLE_ROW.test(line)) line = tableCells(line).join("  ").replace(/<br\s*\/?>/gi, " ");
  let t = line.trim().replace(/^#{1,3} /, "").replace(/^- \[[ xX]\] /, "").replace(/^([*>-]|\d+\.) /, "")
    .replace(/^`` /, "").split("**").join("").split("~~").join("").replace(/<\/?u>/g, "").replace(/==[pkomb]:/g, "").split("==").join("");
  return t.replace(/(?<![\w])_(\S[^_]*)_(?![\w])/g, "$1").trim();
}
function titleOf(n) { for (const l of n.body.split("\n")) { const t = plain(l); if (t) return t; } return "New Note"; }
function previewOf(n) {
  let seen = false;
  for (const l of n.body.split("\n")) { const t = plain(l); if (!t) continue; if (!seen) { seen = true; continue; } return t; }
  return "No additional text";
}

// =============================================================================================
// 3-way line merge: both sides' edits survive (a line both changed keeps both versions)
// =============================================================================================

function lcsMap(a, b) {   // for each index of a: matching index in b, or -1
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const map = new Array(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { map[i] = j; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return map;
}

function merge3(base, ours, theirs) {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  const B = base.split("\n"), O = ours.split("\n"), T = theirs.split("\n");
  if (B.length * Math.max(O.length, T.length) > 4e6) return ours;   // huge: keep ours rather than stall
  const mo = lcsMap(B, O), mt = lcsMap(B, T);
  const out = [];
  let po = 0, pt = 0;
  const flushTo = (io, it) => {   // lines inserted on either side before the next anchor
    const a = O.slice(po, io), b = T.slice(pt, it);
    for (const l of a) out.push(l);
    for (const l of b) if (!a.includes(l)) out.push(l);
  };
  for (let i = 0; i < B.length; i++) {
    if (mo[i] >= 0 && mt[i] >= 0) {   // kept by both: an anchor
      flushTo(mo[i], mt[i]);
      out.push(B[i]);
      po = mo[i] + 1; pt = mt[i] + 1;
    }
  }
  flushTo(O.length, T.length);
  return out.join("\n");
}

// =============================================================================================
// local state
// =============================================================================================

const S = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS) || "{}");
    return Object.assign({ refresh: "", access: "", exp: 0, cursor: "", files: {}, notes: {}, dirty: {}, device: "", pushed: false }, s);
  } catch { return { refresh: "", access: "", exp: 0, cursor: "", files: {}, notes: {}, dirty: {}, device: "", pushed: false }; }
}
// S.files: path_lower → {rev, shared}   (every root note, so a moved note is noticed)
// S.notes: id → {rev, base, text}       (shared notes only; base = last synced file text)
// S.dirty: id → true                    (local edits not yet uploaded)
let saveT = 0;
function persist() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { console.warn(e); } }, 150);
}
if (!S.device) { S.device = Math.random().toString(36).slice(2, 10); persist(); }

// =============================================================================================
// Dropbox
// =============================================================================================

const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

async function token() {
  if (S.access && Date.now() < S.exp) return S.access;
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: S.refresh, client_id: APP_KEY }),
  });
  if (!r.ok) {
    if (r.status === 400 || r.status === 401) { S.refresh = ""; persist(); show(); }
    throw new Error("sign-in " + r.status);
  }
  const o = await r.json();
  S.access = o.access_token; S.exp = Date.now() + (o.expires_in - 120) * 1000; persist();
  return S.access;
}

async function rpc(path, arg) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch("https://api.dropboxapi.com/2/" + path, {
      method: "POST", headers: { Authorization: "Bearer " + (await token()), "Content-Type": "application/json" },
      body: JSON.stringify(arg),
    });
    if (r.status === 401 && attempt === 0) { S.exp = 0; continue; }
    if (r.status === 429 && attempt < 3) { await sleep(1000 * (Number(r.headers.get("Retry-After")) || 3)); continue; }
    const t = await r.text();
    if (!r.ok) { const e = new Error(path + " " + r.status + " " + t.slice(0, 200)); e.status = r.status; e.body = t; throw e; }
    return JSON.parse(t);
  }
}

async function content(path, arg, body) {
  for (let attempt = 0; ; attempt++) {
    const h = { Authorization: "Bearer " + (await token()), "Dropbox-API-Arg": asciiJson(arg) };
    if (body !== undefined) h["Content-Type"] = "application/octet-stream";
    const r = await fetch("https://content.dropboxapi.com/2/" + path, { method: "POST", headers: h, body });
    if (r.status === 401 && attempt === 0) { S.exp = 0; continue; }
    if (r.status === 429 && attempt < 3) { await sleep(1000 * (Number(r.headers.get("Retry-After")) || 3)); continue; }
    if (!r.ok) { const t = await r.text(); const e = new Error(path + " " + r.status + " " + t.slice(0, 200)); e.status = r.status; e.body = t; throw e; }
    return r;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNotePath = (pl) => /^\/notes\/[0-9a-z]+\.md$/.test(pl);
const idOf = (pl) => pl.slice(ROOT.length + 1, -3);

async function downloadText(path) {
  const r = await content("files/download", { path });
  const meta = JSON.parse(r.headers.get("Dropbox-API-Result") || "{}");
  return { text: await r.text(), rev: meta.rev || "" };
}

/** A root note file arrived/changed: keep it if it's shared, drop it if it no longer is. */
function take(pl, rev, text) {
  const n = parseNote(text);
  const id = n.id || idOf(pl);
  const shared = isShared(n);
  S.files[pl] = { rev, shared };
  if (shared) {
    if (S.dirty[id] && S.notes[id]) S.notes[id].pending = { rev, text };   // merged on the next upload
    else S.notes[id] = { rev, base: text, text };
  } else if (S.notes[id] && !S.dirty[id]) delete S.notes[id];
  return id;
}

let syncing = null, status = "", statusErr = false;
function setStatus(s, err) { status = s; statusErr = !!err; const el = $("#status"); if (el) { el.textContent = s; el.classList.toggle("err", !!err); } }

function sync() {
  if (!syncing) syncing = doSync().catch((e) => { console.warn(e); setStatus(navigator.onLine ? "Couldn't sync — " + e.message : "Offline — changes are kept and sent later", true); })
    .finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  if (!S.refresh) return;
  await flush();
  const changed = new Set();
  if (!S.cursor) {
    // first run: list the folder (revs + cursor), then fetch it all as one zip — the same trick the phone uses
    setStatus("Getting notes…");
    const entries = [];
    let page = await rpc("files/list_folder", { path: ROOT, recursive: false });
    for (;;) {
      entries.push(...page.entries);
      if (!page.has_more) break;
      page = await rpc("files/list_folder/continue", { cursor: page.cursor });
    }
    const revs = {};
    for (const e of entries) if (e[".tag"] === "file" && isNotePath(e.path_lower)) revs[e.path_lower] = e.rev;
    const r = await content("files/download_zip", { path: ROOT });
    const zip = await JSZip.loadAsync(await r.arrayBuffer());
    const files = Object.values(zip.files).filter((f) => !f.dir);
    for (const f of files) {
      const rel = f.name.slice(f.name.indexOf("/") + 1).toLowerCase();
      const pl = ROOT + "/" + rel;
      if (!revs[pl]) continue;
      changed.add(take(pl, revs[pl], await f.async("string")));
    }
    S.cursor = page.cursor;
    persist();
  } else {
    let page;
    try { page = await rpc("files/list_folder/continue", { cursor: S.cursor }); }
    catch (e) {
      if (e.status === 409 && /reset/.test(e.body)) { S.cursor = ""; S.files = {}; persist(); return doSync(); }
      throw e;
    }
    for (;;) {
      for (const e of page.entries) {
        const pl = e.path_lower;
        if (!isNotePath(pl)) continue;
        if (e[".tag"] === "deleted") {
          const id = idOf(pl);
          delete S.files[pl];
          if (S.notes[id] && !S.dirty[id]) { delete S.notes[id]; changed.add(id); }
        } else if (e[".tag"] === "file" && (!S.files[pl] || S.files[pl].rev !== e.rev)) {
          const id = idOf(pl);
          if (S.notes[id] && S.notes[id].rev === e.rev) { S.files[pl] = { rev: e.rev, shared: true }; continue; }   // our own upload
          const d = await downloadText(e.path_display);
          changed.add(take(pl, d.rev || e.rev, d.text));
        }
      }
      S.cursor = page.cursor;
      if (!page.has_more) break;
      page = await rpc("files/list_folder/continue", { cursor: page.cursor });
    }
    persist();
  }
  await flush();
  setStatus("");
  if (changed.size) refresh(changed);
}

/** Wait for Dropbox to say something changed (no auth needed), then sync. Runs while visible. */
let polling = false;
async function longpoll() {
  if (polling) return;
  polling = true;
  try {
    while (document.visibilityState === "visible" && S.refresh) {
      if (!S.cursor) { await sync(); if (!S.cursor) { await sleep(10000); continue; } }
      try {
        const r = await fetch("https://notify.dropboxapi.com/2/files/list_folder/longpoll", {
          method: "POST", headers: { "Content-Type": "text/plain; charset=dropbox-cors-hack" },
          body: JSON.stringify({ cursor: S.cursor, timeout: 60 }),
        });
        const o = await r.json();
        if (o.changes) await sync();
        if (o.backoff) await sleep(o.backoff * 1000);
      } catch { await sleep(8000); }
    }
  } finally { polling = false; }
}

/** Upload every locally edited note; on a conflict, merge with theirs and try again. */
async function flush() {
  for (const id of Object.keys(S.dirty)) {
    const L = S.notes[id];
    if (!L) { delete S.dirty[id]; continue; }
    let text = L.text;
    if (L.pending) {   // theirs arrived while we had unsent edits
      text = mergeFiles(L.base, text, L.pending.text);
      L.base = L.pending.text; L.rev = L.pending.rev; delete L.pending;
      L.text = text;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const mode = L.rev ? { ".tag": "update", update: L.rev } : "add";
      try {
        const r = await content("files/upload", { path: `${ROOT}/${id}.md`, mode, autorename: false, mute: true }, new TextEncoder().encode(text));
        const meta = await r.json();
        L.rev = meta.rev; L.base = text; L.text = text;
        S.files[meta.path_lower] = { rev: meta.rev, shared: isShared(parseNote(text)) };
        if (!S.files[meta.path_lower].shared) delete S.notes[id];
        delete S.dirty[id];
        persist();
        break;
      } catch (e) {
        if (e.status !== 409) throw e;
        const theirs = await downloadText(`${ROOT}/${id}.md`);   // someone else saved first
        text = mergeFiles(L.base, text, theirs.text);
        L.base = theirs.text; L.rev = theirs.rev; L.text = text;
        if (current === id) refresh(new Set([id]));
      }
    }
  }
}

/** Merge whole files: bodies line by line, header fields from whichever edit is newer. */
function mergeFiles(base, ours, theirs) {
  const b = parseNote(base), o = parseNote(ours), t = parseNote(theirs);
  const n = o.modified >= t.modified ? { ...o } : { ...t };
  n.body = merge3(b.body, o.body, t.body);
  n.modified = Math.max(o.modified, t.modified, Date.now());
  n.by = "web:" + S.device;
  return serializeNote(n);
}

/** Save a note's new body (or header change) locally and schedule the upload. */
let upT = 0;
function edited(id, fn) {
  const L = S.notes[id];
  const n = parseNote(L.text);
  fn(n);
  n.modified = Date.now();
  n.by = "web:" + S.device;
  L.text = serializeNote(n);
  S.dirty[id] = true;
  persist();
  clearTimeout(upT);
  upT = setTimeout(() => sync(), 1200);
}

// =============================================================================================
// connecting (PKCE; Dropbox shows a code which is pasted back — no redirect URL to register)
// =============================================================================================

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The Dropbox link is built BEFORE the tap and Connect is a real link to it: an iPhone opens a new
// window only straight from a tap, and the old button awaited SHA-256 first, so iOS silently
// blocked it -- Joanna never got connected (2026-10-18). The verifier is kept 30 min while a
// sign-in is pending, so the app reloading while Dropbox is open doesn't void the code.
async function prepareAuth() {
  const kept = localStorage.getItem(LS + ".pkce"), at = +localStorage.getItem(LS + ".pkce.at") || 0;
  const v = kept && Date.now() - at < 30 * 60 * 1000 ? kept : b64url(crypto.getRandomValues(new Uint8Array(48)));
  if (v !== kept) { localStorage.setItem(LS + ".pkce", v); localStorage.setItem(LS + ".pkce.at", String(Date.now())); }
  const ch = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  $("#go-auth").href = "https://www.dropbox.com/oauth2/authorize?" + new URLSearchParams({
    client_id: APP_KEY, response_type: "code", token_access_type: "offline", code_challenge_method: "S256", code_challenge: ch,
  });
}

function startAuth(e) {
  const go = $("#go-auth");
  if (!go.href) { e.preventDefault(); prepareAuth().then(() => window.open(go.href, "_blank")); }
  go.classList.add("alt");
  go.textContent = "Open Dropbox Again";
}

async function finishAuth() {
  const code = $("#code").value.trim();
  if (!code) return;
  $("#auth-err").textContent = "";
  try {
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: APP_KEY,
        code_verifier: localStorage.getItem(LS + ".pkce") || "" }),
    });
    const o = await r.json();
    if (!r.ok) throw new Error(o.error_description || o.error || r.status);
    S.refresh = o.refresh_token; S.access = o.access_token; S.exp = Date.now() + (o.expires_in - 120) * 1000;
    localStorage.removeItem(LS + ".pkce"); localStorage.removeItem(LS + ".pkce.at");
    persist();
    show();
    sync().then(longpoll);
  } catch (e) { $("#auth-err").textContent = "That didn't work: " + e.message + ". Tap Open Dropbox Again for a fresh code."; }
}

// =============================================================================================
// list
// =============================================================================================

let current = null;   // id of the open note

function shared() {
  return Object.entries(S.notes).map(([id, L]) => ({ id, ...parseNote(L.text) })).filter(isShared);
}

function whenShort(ms) {
  const d = new Date(ms), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
}
function groupOf(ms) {
  const d = new Date(ms), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 Days";
  if (days < 30) return "Previous 30 Days";
  return d.getFullYear() === now.getFullYear() ? d.toLocaleDateString([], { month: "long" }) : String(d.getFullYear());
}

function renderList() {
  const q = $("#q").value.trim().toLowerCase();
  let notes = shared().sort((a, b) => b.modified - a.modified);
  $("#count").textContent = $("#mini-count").textContent = notes.length === 1 ? "1 Note" : `${notes.length} Notes`;
  if (q) notes = notes.filter((n) => n.body.toLowerCase().includes(q));
  const groups = [];
  const pinned = notes.filter((n) => n.pinned);
  if (pinned.length) groups.push(["Pinned", pinned]);
  for (const n of notes.filter((n) => !n.pinned)) {
    const g = groupOf(n.modified);
    if (!groups.length || groups[groups.length - 1][0] !== g) groups.push([g, []]);
    groups[groups.length - 1][1].push(n);
  }
  const rows = $("#rows");
  if (!notes.length) {
    rows.innerHTML = `<div class="empty">${q ? "No results" : S.cursor ? "No shared notes yet.<br>Tap the pencil to start one." : "Getting notes…"}</div>`;
    return;
  }
  rows.innerHTML = groups.map(([g, ns]) =>
    `<div class="section">${g === "Pinned" ? '<svg class="i" style="width:18px;height:18px;color:var(--tint)"><use href="#i-pin"/></svg>' : ""}${esc(g)}</div>` +
    `<div class="card">${ns.map((n) => `<button class="row" data-id="${esc(n.id)}"><div class="t">${esc(titleOf(n))}</div>` +
      `<div class="s"><b>${esc(whenShort(n.modified))}</b>${esc(previewOf(n))}</div></button>`).join("")}</div>`).join("");
}

function refresh(ids) {
  renderList();
  if (current && ids && ids.has(current) && !S.dirty[current]) {
    const L = S.notes[current];
    if (!L) { closeEditor(); return; }
    if (edBody !== parseNote(L.text).body) renderEditor(true);
  }
}

// =============================================================================================
// editor
// =============================================================================================

const ed = $("#ed");
let edBody = "";   // the body the editor shows, as Markdown

function lineEl(b) {
  const d = document.createElement("div");
  d.className = "ln";
  d.dataset.k = b.kind;
  if (b.tabs) { d.dataset.t = b.tabs; d.style.marginLeft = b.tabs * 26 + "px"; }
  d.innerHTML = runsToHtml(parseInline(b.text)) || "<br>";
  d._src = b.src; d._html = d.innerHTML; d._k = b.kind; d._t = b.tabs || 0;
  return d;
}

function tableEl(b) {
  const wrap = document.createElement("div");
  wrap.className = "tbl";
  wrap.contentEditable = "false";
  const cols = Math.max(1, ...b.rows.map((r) => r.length));
  wrap.innerHTML = "<table>" + b.rows.map((r) => "<tr>" + Array.from({ length: cols }, (_, k) =>
    `<td contenteditable="true">${(r[k] || "").split(/<br\s*\/?>/i).map((p) => runsToHtml(parseInline(p))).join("<br>")}</td>`).join("") + "</tr>").join("") + "</table>";
  wrap._src = b.src; wrap._html = wrap.innerHTML;
  return wrap;
}

function renderEditor(keepCaret) {
  const L = S.notes[current];
  if (!L) return;
  const n = parseNote(L.text);
  let caretLine = -1;
  if (keepCaret) {
    const sel = getSelection();
    const ln = sel.rangeCount && lineOf(sel.anchorNode);
    if (ln) caretLine = [...ed.children].indexOf(ln);
  }
  ed.innerHTML = "";
  for (const b of parseBody(n.body)) ed.appendChild(b.type === "table" ? tableEl(b) : lineEl(b));
  if (!n.body.trim()) { ed.innerHTML = ""; ed.appendChild(lineEl({ kind: "title", tabs: 0, text: "" })); }   // a new note starts on its title
  renumber();
  ed._count = ed.children.length;
  edBody = n.body;
  $("#ed-date").textContent = new Date(n.modified).toLocaleString([], { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  if (caretLine >= 0 && document.activeElement === ed) {
    const el = ed.children[Math.min(caretLine, ed.children.length - 1)];
    if (el) placeCaret(el, true);
  }
}

function lineOf(node) {
  while (node && node !== ed) {
    if (node.parentNode === ed) return node;
    node = node.parentNode;
  }
  return null;
}

function renumber() {
  let n = 0;
  for (const el of ed.children) {
    if (el.dataset.k === "num") el.dataset.n = ++n;
    else n = 0;
  }
}

/** Editor DOM → Markdown body. Untouched lines/tables are written back byte for byte. */
function editorMd() {
  const out = [];
  let num = 0;
  // numbers are only rewritten once lines come or go (the phone renumbers on save, but an untouched note stays byte for byte)
  const structural = [...ed.children].some((el) => el._src === undefined) || ed.children.length !== ed._count;
  for (const el of ed.children) {
    if (el.classList.contains("tbl")) {
      num = 0;
      if (el._src && el.innerHTML === el._html) { out.push(...el._src); continue; }
      const rows = [...el.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) =>
        runsToMd(domRuns(td)).replace(/\|/g, "\\|").replace(/\n/g, "<br>").replace(/(<br>)+$/, "").trim()));
      if (!rows.length) continue;
      rows.forEach((r, i) => {
        out.push("| " + r.join(" | ") + " |");
        if (i === 0) out.push("|" + " --- |".repeat(r.length));
      });
      continue;
    }
    const k = el.dataset.k || "plain", tabs = Number(el.dataset.t || 0);
    num = k === "num" ? num + 1 : 0;
    if (el._src !== undefined && el.innerHTML === el._html && el._k === k && el._t === tabs && (k !== "num" || !structural)) { out.push(el._src); continue; }
    const text = runsToMd(domRuns(el)).replace(/\n/g, "");
    const pre = k === "num" ? `${num}. ` : PREFIX_OF[k] || "";
    out.push("  ".repeat(tabs) + pre + text);
  }
  return out.join("\n");
}

let edT = 0;
function editorChanged() {
  normalize();
  renumber();
  clearTimeout(edT);
  edT = setTimeout(commitEditor, 500);
}
function commitEditor() {
  clearTimeout(edT);
  if (!current || !S.notes[current]) return;
  const md = editorMd();
  if (md === edBody) return;
  edBody = md;
  edited(current, (n) => { n.body = md; });
  $("#ed-date").textContent = new Date().toLocaleString([], { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  renderList();
}

/** Keep the editor flat: every child a .ln line or a .tbl table. */
function normalize() {
  for (const node of [...ed.childNodes]) {
    if (node.nodeType === 3) {
      if (!node.nodeValue.trim() && node.nodeValue.indexOf("\n") >= 0) { node.remove(); continue; }
      const d = document.createElement("div");
      d.className = "ln"; d.dataset.k = "plain";
      ed.insertBefore(d, node); d.appendChild(node);
    } else if (node.nodeType === 1 && !node.classList.contains("ln") && !node.classList.contains("tbl")) {
      if (node.tagName === "BR") { const d = document.createElement("div"); d.className = "ln"; d.dataset.k = "plain"; d.innerHTML = "<br>"; node.replaceWith(d); continue; }
      node.classList.add("ln");
      if (!node.dataset.k) node.dataset.k = "plain";
    }
  }
  for (const el of ed.querySelectorAll(".ln .ln, .ln div")) {   // pasted/nested blocks: lift them out
    const top = lineOf(el);
    if (top && top !== el) { top.after(el); el.classList.add("ln"); if (!el.dataset.k) el.dataset.k = "plain"; }
  }
  if (!ed.children.length) { const d = document.createElement("div"); d.className = "ln"; d.dataset.k = "title"; d.innerHTML = "<br>"; ed.appendChild(d); }
}

function placeCaret(el, end) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(!end);
  const s = getSelection();
  s.removeAllRanges(); s.addRange(r);
}

function caretLine() {
  const s = getSelection();
  return s.rangeCount ? lineOf(s.getRangeAt(0).startContainer) : null;
}

function atLineStart(el) {
  const s = getSelection();
  if (!s.rangeCount || !s.isCollapsed) return false;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset);
  return r.toString().replace(/​/g, "") === "";
}

const isEmptyLine = (el) => !el.textContent.replace(/[​\s]/g, "");

ed.addEventListener("beforeinput", (e) => {
  const sel = getSelection();
  const inCell = sel.rangeCount && sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest("td");
  if (inCell) {
    if (e.inputType === "insertParagraph") { e.preventDefault(); document.execCommand("insertLineBreak"); }
    return;
  }
  const el = caretLine();
  if (!el || el.classList.contains("tbl")) return;
  const k = el.dataset.k;
  if (e.inputType === "insertParagraph") {
    e.preventDefault();
    if (LISTY.has(k) && isEmptyLine(el)) {   // Return on an empty item ends the list (Notes)
      if (Number(el.dataset.t || 0) > 0) setTabs(el, Number(el.dataset.t) - 1); else setKind(el, "plain");
      editorChanged();
      return;
    }
    const r = sel.getRangeAt(0);
    if (!r.collapsed) r.deleteContents();
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(el, el.childNodes.length);
    const frag = tail.extractContents();
    const d = document.createElement("div");
    d.className = "ln";
    d.dataset.k = k === "done" ? "open" : ["title", "head", "sub"].includes(k) ? "plain" : k;
    if (el.dataset.t) { d.dataset.t = el.dataset.t; d.style.marginLeft = el.style.marginLeft; }
    d.appendChild(frag);
    if (!d.textContent) d.innerHTML = "<br>";
    if (!el.textContent) el.innerHTML = "<br>";
    el.after(d);
    placeCaret(d, false);
    d.scrollIntoView({ block: "nearest" });
    editorChanged();
  } else if (e.inputType === "deleteContentBackward" && sel.isCollapsed && atLineStart(el)) {
    if (k !== "plain" && k !== "title") { e.preventDefault(); setKind(el, "plain"); editorChanged(); }
    else if (Number(el.dataset.t || 0) > 0) { e.preventDefault(); setTabs(el, Number(el.dataset.t) - 1); editorChanged(); }
    else if (el.previousElementSibling && el.previousElementSibling.classList.contains("tbl")) e.preventDefault();
  }
});
ed.addEventListener("input", editorChanged);
ed.addEventListener("paste", (e) => {   // paste as text; several lines become several lines (checklists too)
  e.preventDefault();
  const t = (e.clipboardData.getData("text/plain") || "").replace(/\r\n?/g, "\n");
  if (!t.includes("\n")) { document.execCommand("insertText", false, t); return; }
  const el = caretLine();
  const blocks = parseBody(t).map((b) => b.type === "table" ? tableEl(b) : lineEl({ ...b, src: undefined }));
  if (!el) { blocks.forEach((b) => ed.appendChild(b)); }
  else { let at = el; for (const b of blocks) { at.after(b); at = b; } if (isEmptyLine(el)) el.remove(); placeCaret(at, true); }
  editorChanged();
});

function setKind(el, k) { el.dataset.k = k; }
function setTabs(el, t) {
  if (t > 0) { el.dataset.t = t; el.style.marginLeft = t * 26 + "px"; } else { delete el.dataset.t; el.style.marginLeft = ""; }
}

// tap a checkbox: toggle it without moving the caret or raising the keyboard
function checkAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const ln = el && lineOf(el);
  if (!ln || (ln.dataset.k !== "open" && ln.dataset.k !== "done")) return null;
  const r = ln.getBoundingClientRect();
  const left = r.left + parseFloat(getComputedStyle(ln).paddingLeft || 0) - 34;
  return x >= left - 8 && x <= left + 34 && y - r.top < 34 ? ln : null;
}
let checkDown = null;
ed.addEventListener("touchstart", (e) => { const t = e.touches[0]; checkDown = checkAt(t.clientX, t.clientY); if (checkDown) e.preventDefault(); }, { passive: false });
ed.addEventListener("touchend", (e) => { if (checkDown) { e.preventDefault(); toggleCheck(checkDown); checkDown = null; } }, { passive: false });
ed.addEventListener("mousedown", (e) => { const ln = checkAt(e.clientX, e.clientY); if (ln) { e.preventDefault(); toggleCheck(ln); } });
function toggleCheck(ln) {
  ln.dataset.k = ln.dataset.k === "open" ? "done" : "open";
  if (navigator.vibrate) navigator.vibrate(8);
  editorChanged();
}

// hold a table cell: rows, columns, the table
let holdT = 0;
ed.addEventListener("touchstart", (e) => {
  const td = e.target.closest && e.target.closest("td");
  if (!td) return;
  holdT = setTimeout(() => tableMenu(td), 550);
}, { passive: true });
for (const ev of ["touchmove", "touchend", "touchcancel"]) ed.addEventListener(ev, () => clearTimeout(holdT), { passive: true });
ed.addEventListener("contextmenu", (e) => { const td = e.target.closest && e.target.closest("td"); if (td) { e.preventDefault(); tableMenu(td); } });

function tableMenu(td) {
  const tr = td.parentElement, table = tr.closest("table"), wrap = table.closest(".tbl");
  const ci = [...tr.children].indexOf(td);
  const cols = tr.children.length;
  const newCell = () => { const c = document.createElement("td"); c.contentEditable = "true"; return c; };
  const done = () => { editorChanged(); };
  menu(td, [
    ["Add Row Above", "i-up", () => { const r = document.createElement("tr"); for (let k = 0; k < cols; k++) r.appendChild(newCell()); tr.before(r); done(); }],
    ["Add Row Below", "i-down", () => { const r = document.createElement("tr"); for (let k = 0; k < cols; k++) r.appendChild(newCell()); tr.after(r); done(); }],
    ["Add Column Before", "i-outdent", () => { for (const r of table.rows) r.children[ci].before(newCell()); done(); }],
    ["Add Column After", "i-indent", () => { for (const r of table.rows) r.children[ci].after(newCell()); done(); }],
    null,
    ["Delete Row", "i-trash", () => { if (table.rows.length > 1) tr.remove(); else wrap.remove(); done(); }, true],
    ["Delete Column", "i-trash", () => { if (cols > 1) { for (const r of table.rows) r.children[ci].remove(); } else wrap.remove(); done(); }, true],
    ["Delete Table", "i-trash", () => { wrap.remove(); done(); }, true],
  ]);
}

// ---- toolbar ----
for (const b of document.querySelectorAll("#tools button")) b.addEventListener("mousedown", (e) => e.preventDefault());
for (const b of document.querySelectorAll("#tools button")) b.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
const tap = (sel, fn) => { const el = $(sel); el.addEventListener("touchend", (e) => { e.preventDefault(); fn(); }); el.addEventListener("click", fn); };

function selectedLines() {
  const s = getSelection();
  if (!s.rangeCount) return [];
  const a = lineOf(s.getRangeAt(0).startContainer), b = lineOf(s.getRangeAt(0).endContainer);
  if (!a) return [];
  const out = [];
  for (let el = a; el; el = el.nextElementSibling) { if (!el.classList.contains("tbl")) out.push(el); if (el === b) break; }
  return out;
}
function paragraph(k) {
  const ls = selectedLines();
  if (!ls.length) return;
  const cur = ls[0].dataset.k;
  const same = cur === k || (k === "open" && cur === "done");
  for (const el of ls) el.dataset.k = same ? "plain" : k;
  editorChanged();
}
tap("#t-check", () => paragraph("open"));
tap("#t-table", () => {
  const el = caretLine() || ed.lastElementChild;
  const t = tableEl({ rows: [["", ""], ["", ""]], src: null });
  t._src = null;
  if (el && isEmptyLine(el) && el.dataset.k !== "title") el.replaceWith(t); else (el || ed).after(t);
  if (!t.nextElementSibling) { const d = document.createElement("div"); d.className = "ln"; d.dataset.k = "plain"; d.innerHTML = "<br>"; t.after(d); }
  placeCaret(t.querySelector("td"), false);
  editorChanged();
});
tap("#t-aa", formatSheet);

function formatSheet() {
  const el = caretLine();
  const k = el ? el.dataset.k : "plain";
  const st = (cmd) => document.queryCommandState(cmd);
  sheet("Format", `
    <div class="styles">${[["title", "Title", "font-size:22px;font-weight:700"], ["head", "Heading", "font-size:18px;font-weight:700"],
      ["sub", "Subheading", "font-weight:700"], ["plain", "Body", ""], ["mono", "Monostyled", "font-family:ui-monospace,Menlo,monospace;font-size:15px"]]
      .map(([kk, label, css]) => `<button data-k="${kk}" class="${k === kk ? "on" : ""}" style="${css}">${label}</button>`).join("")}</div>
    <div class="seg">${[["bold", "<b>B</b>"], ["italic", "<i>I</i>"], ["underline", "<u>U</u>"], ["strikeThrough", "<s>S</s>"]]
      .map(([c, h]) => `<button data-cmd="${c}" class="${st(c) ? "on" : ""}">${h}</button>`).join("")}</div>
    <div class="seg">
      <button data-k="bullet" class="${k === "bullet" ? "on" : ""}">•</button><button data-k="dash" class="${k === "dash" ? "on" : ""}">–</button>
      <button data-k="num" class="${k === "num" ? "on" : ""}">1.</button><button data-k="quote" class="${k === "quote" ? "on" : ""}">❙</button>
      <button data-in="-1"><svg class="i"><use href="#i-outdent"/></svg></button><button data-in="1"><svg class="i"><use href="#i-indent"/></svg></button>
    </div>
    <div class="seg">${[...HL_CODES].map((c) => `<button data-hl="${c}"><mark data-hl="${c}">&nbsp;Aa&nbsp;</mark></button>`).join("")}</div>`,
  (b, close) => {
    if (b.dataset.k) {
      const ls = selectedLines();
      const same = ls[0] && ls[0].dataset.k === b.dataset.k;
      for (const l of ls) l.dataset.k = same && b.dataset.k !== "plain" ? "plain" : b.dataset.k;
      editorChanged(); close();
    } else if (b.dataset.cmd) {
      document.execCommand(b.dataset.cmd); b.classList.toggle("on"); editorChanged();
    } else if (b.dataset.in) {
      for (const l of selectedLines()) setTabs(l, Math.max(0, Number(l.dataset.t || 0) + Number(b.dataset.in)));
      editorChanged();
    } else if (b.dataset.hl) {
      highlight(b.dataset.hl); editorChanged(); close();
    }
  });
}

function highlight(code) {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return;
  const r = s.getRangeAt(0);
  const inMark = (r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement).closest("mark");
  if (inMark && inMark.dataset.hl === code) { inMark.replaceWith(...inMark.childNodes); return; }
  const m = document.createElement("mark");
  m.dataset.hl = code;
  m.appendChild(r.extractContents());
  r.insertNode(m);
}

// =============================================================================================
// screens
// =============================================================================================

function show() {
  const authed = !!S.refresh;
  $("#connect").classList.toggle("hidden", authed);
  if (!authed && !$("#go-auth").href) prepareAuth();
  $("#list").classList.toggle("hidden", !authed);
  if (authed) renderList();
}

function openNote(id, focus) {
  if (!S.notes[id]) return;
  current = id;
  renderEditor();
  $("#editor").classList.add("open");
  $("#editor").scrollTop = 0;
  if (location.hash !== "#n=" + id) history.pushState({ n: id }, "", "#n=" + id);
  if (focus) {
    const last = ed.lastElementChild;
    ed.focus();
    if (last) placeCaret(last, true);
  }
}

function closeEditor(fromPop) {
  commitEditor();
  if (current && S.notes[current] && !parseNote(S.notes[current].text).body.trim()) {   // an empty new note just goes away
    const id = current;
    edited(id, (n) => { n.deleted = Date.now(); });
  }
  current = null;
  ed.blur();
  $("#editor").classList.remove("open");
  $("#tools").classList.add("hidden");
  if (!fromPop && location.hash) history.back();
  renderList();
}

function newNote() {
  const id = crypto.getRandomValues(new Uint32Array(2)).reduce((s, v) => s + v.toString(16).padStart(8, "0"), "").slice(0, 12);
  const now = Date.now();
  const n = { id, created: now, modified: now, folder: SHARED, source: "", pinned: false, dismissed: false, locked: false, deleted: 0, by: "web:" + S.device, body: "" };
  S.notes[id] = { rev: "", base: "", text: serializeNote(n) };
  persist();
  openNote(id, true);
}

window.addEventListener("popstate", () => {
  const m = /^#n=(\w+)/.exec(location.hash);
  if (m && S.notes[m[1]]) openNote(m[1]);
  else if (current) closeEditor(true);
});

// keyboard up: Done button + format toolbar riding on top of the keyboard
ed.addEventListener("focus", () => { $("#ed-done").classList.remove("hidden"); $("#ed-more").classList.add("hidden"); $("#tools").classList.remove("hidden"); });
ed.addEventListener("focusout", () => setTimeout(() => {
  if (ed.contains(document.activeElement)) return;
  $("#ed-done").classList.add("hidden"); $("#ed-more").classList.remove("hidden"); $("#tools").classList.add("hidden");
  commitEditor();
}, 60));
if (window.visualViewport) {
  const ride = () => {
    const vv = visualViewport;
    const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
    $("#tools").style.transform = kb ? `translateY(${-kb + 6}px)` : "";
    $("#tools").style.paddingBottom = kb ? "8px" : "";
  };
  visualViewport.addEventListener("resize", ride);
  visualViewport.addEventListener("scroll", ride);
}

// list header turns compact once the big title scrolls away
addEventListener("scroll", () => $("#list-top").classList.toggle("small", scrollY > 40), { passive: true });

$("#rows").addEventListener("click", (e) => { const r = e.target.closest(".row"); if (r) openNote(r.dataset.id); });
$("#q").addEventListener("input", renderList);
tap("#compose", newNote);
$("#back").addEventListener("click", () => closeEditor());
tap("#ed-done", () => { ed.blur(); commitEditor(); });
$("#go-auth").addEventListener("click", startAuth);
$("#finish-auth").addEventListener("click", finishAuth);

$("#ed-more").addEventListener("click", () => {
  const n = parseNote(S.notes[current].text);
  menu($("#ed-more"), [
    [n.pinned ? "Unpin" : "Pin", "i-pin", () => { commitEditor(); edited(current, (x) => { x.pinned = !x.pinned; }); renderList(); }],
    ["Move Checked to Bottom", "i-sort", () => {
      const done = [...ed.children].filter((el) => el.dataset.k === "done");
      let lastOpen = null;
      for (const el of ed.children) if (el.dataset.k === "open") lastOpen = el;
      if (lastOpen) { let at = lastOpen; for (const d of done) { at.after(d); at = d; } editorChanged(); }
    }],
    null,
    ["Delete", "i-trash", () => alertBox("Delete Note?", "It goes to Recently Deleted on Storm's side.", "Delete", true, () => {
      const id = current; commitEditor(); edited(id, (x) => { x.deleted = Date.now(); }); closeEditor();
    }), true],
  ]);
});

$("#list-more").addEventListener("click", () => {
  menu($("#list-more"), [
    [S.pushed ? "Notifications On" : "Turn On Notifications", "i-bell", () => menu($("#list-more"), [
      ["This is Joanna's phone", "i-bell", () => enablePush("Joanna")],
      ["This is Storm's phone", "i-bell", () => enablePush("Storm")],
    ])],
    ["Sync Now", "i-sync", () => { setStatus("Syncing…"); sync(); }],
    null,
    ["Disconnect Dropbox", "i-logout", () => alertBox("Disconnect?", "Notes stay in Dropbox. You'll need a new code to connect again.", "Disconnect", true, () => {
      localStorage.removeItem(LS); location.reload();
    }), true],
  ]);
});

// =============================================================================================
// menus, sheets, alerts (iOS style)
// =============================================================================================

function scrim(close) {
  const s = document.createElement("div");
  s.className = "scrim";
  s.addEventListener("click", close);
  document.body.appendChild(s);
  requestAnimationFrame(() => s.classList.add("on"));
  return s;
}

function menu(anchor, items) {
  const m = document.createElement("div");
  m.className = "menu glass";
  const close = () => { m.classList.remove("on"); sc.classList.remove("on"); setTimeout(() => { m.remove(); sc.remove(); }, 200); };
  const sc = scrim(close);
  for (const it of items) {
    if (!it) { const g = document.createElement("div"); g.className = "gap"; m.appendChild(g); continue; }
    const [label, icon, fn, red] = it;
    const b = document.createElement("button");
    if (red) b.className = "red";
    b.innerHTML = `<span>${esc(label)}</span><svg class="i"><use href="#${icon}"/></svg>`;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => { close(); fn(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  const left = Math.min(innerWidth - mw - 16, Math.max(16, r.right - mw));
  const top = r.bottom + 8 + mh > innerHeight - 16 ? Math.max(16, r.top - mh - 8) : r.bottom + 8;
  m.style.left = left + "px"; m.style.top = top + "px";
  requestAnimationFrame(() => m.classList.add("on"));
}

function sheet(title, html, onButton) {
  const s = document.createElement("div");
  s.className = "sheet glass";
  const close = () => { s.classList.remove("on"); sc.classList.remove("on"); setTimeout(() => { s.remove(); sc.remove(); }, 250); };
  const sc = scrim(close);
  s.innerHTML = `<h3><span>${esc(title)}</span><button class="circle" aria-label="Close" style="width:32px;height:32px;background:var(--fill)"><svg class="i" style="width:16px;height:16px"><use href="#i-plus" transform="rotate(45 12 12)"/></svg></button></h3>` + html;
  s.querySelector("h3 button").addEventListener("click", close);
  for (const b of s.querySelectorAll("button:not(h3 button)")) {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    b.addEventListener("touchend", (e) => { e.preventDefault(); onButton(b, close); });
    b.addEventListener("click", () => onButton(b, close));
  }
  document.body.appendChild(s);
  requestAnimationFrame(() => s.classList.add("on"));
}

function alertBox(title, msg, action, red, fn) {
  const a = document.createElement("div");
  a.className = "alert glass";
  const close = () => { a.classList.remove("on"); sc.classList.remove("on"); setTimeout(() => { a.remove(); sc.remove(); }, 200); };
  const sc = scrim(close);
  a.innerHTML = `<div class="msg"><b>${esc(title)}</b><p>${esc(msg)}</p></div><div class="btns"><button>Cancel</button><button style="${red ? "color:var(--red)" : ""}">${esc(action)}</button></div>`;
  const [c, ok] = a.querySelectorAll(".btns button");
  c.addEventListener("click", close);
  ok.addEventListener("click", () => { close(); fn(); });
  document.body.appendChild(a);
  requestAnimationFrame(() => a.classList.add("on"));
}

// =============================================================================================
// push: Storm's edits arrive as notifications (sent by the laptop, see notes_push.py)
// =============================================================================================

function urlB64ToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** `who` owns this phone: the laptop never tells someone about their own edits. */
async function enablePush(who) {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      alertBox("Add to Home Screen first", "On iPhone, notifications work once this is on your Home Screen: Share → Add to Home Screen, then open it from there.", "OK", false, () => {});
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { setStatus("Notifications are off in Settings", true); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(VAPID) });
    await content("files/upload", { path: `${ROOT}/_push/${S.device}.json`, mode: "overwrite", mute: true },
      new TextEncoder().encode(JSON.stringify({ subscription: sub.toJSON(), device: S.device, name: who, ua: navigator.userAgent, created: Date.now() })));
    S.pushed = true; persist();
    setStatus("Notifications on — you'll hear when a shared note changes");
    setTimeout(() => setStatus(""), 5000);
  } catch (e) { setStatus("Couldn't turn on notifications: " + e.message, true); }
}

// =============================================================================================
// start
// =============================================================================================

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("sw", e));
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.open) { sync().then(() => openNote(e.data.open)); }
    if (e.data && e.data.pushed) { window.__lastPush = e.data.pushed; sync(); }
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { sync().then(longpoll); }
  else commitEditor();
});
addEventListener("online", () => sync());
addEventListener("pagehide", commitEditor);

show();
if (S.refresh) {
  const m = /^#n=(\w+)/.exec(location.hash);
  if (m && S.notes[m[1]]) openNote(m[1]);
  sync().then(() => { if (m && S.notes[m[1]] && current !== m[1]) openNote(m[1]); longpoll(); });
}

// exposed for tests
window.__notes = { parseBody, parseInline, runsToMd, merge3, editorMd, parseNote, serializeNote, S, openNote, closeEditor, commitEditor, sync, persist };
