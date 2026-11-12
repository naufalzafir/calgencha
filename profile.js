/* CalGencha profiles.
   A profile is a named, password-protected save of every tool's data.
   - The data is encrypted in the browser (PBKDF2 + AES-GCM) and kept in IndexedDB.
   - Changes are saved automatically while you are logged in.
   - Chrome/Edge on a computer can also autosave to a save file you choose.
   - A profile can be downloaded as one .json file and loaded on another device.
   Nothing is ever sent to a server. To add a new tool, put its storage key in KEYS below. */
(function () {
  'use strict';

  var KEYS = ['barline.draft.v1', 'spendtracker.v1', 'habittracker.v1'];
  var ACTIVE = 'calgencha.active';
  var SESSION = 'calgencha.session';
  var ITER = 250000;

  var store = null, nativeSet = null, nativeRemove = null;
  try {
    store = window.localStorage;
    nativeSet = Storage.prototype.setItem;
    nativeRemove = Storage.prototype.removeItem;
    store.getItem('calgencha.probe');
  } catch (e) { store = null; }
  var OK = !!(store && window.crypto && crypto.subtle && window.indexedDB);
  var CAN_FILE = typeof window.showSaveFilePicker === 'function';

  var S = { id: null, name: '', key: null, dirty: false, saving: false, lastSaved: null, fileState: 'none', hasHandle: false, error: '' };
  var listeners = [];
  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }

  /* ---------- small helpers ---------- */
  function b2s(buf) { var a = new Uint8Array(buf), s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function s2b(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function rid() { return Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(8)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function timeText(d) { try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }

  /* ---------- IndexedDB ---------- */
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('calgencha', 1);
      r.onupgradeneeded = function () { var d = r.result; d.createObjectStore('profiles', { keyPath: 'id' }); d.createObjectStore('handles', { keyPath: 'id' }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(name, mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(name, mode), out = fn(t.objectStore(name));
        t.oncomplete = function () { db.close(); res(out && 'result' in out ? out.result : undefined); };
        t.onerror = t.onabort = function () { db.close(); rej(t.error); };
      });
    });
  }
  function dbGet(n, id) { return tx(n, 'readonly', function (s) { return s.get(id); }); }
  function dbAll(n) { return tx(n, 'readonly', function (s) { return s.getAll(); }); }
  function dbPut(n, v) { return tx(n, 'readwrite', function (s) { return s.put(v); }); }
  function dbDel(n, id) { return tx(n, 'readwrite', function (s) { return s.delete(id); }); }

  /* ---------- encryption ---------- */
  function derive(pw, salt, iter) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']).then(function (m) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, m, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    });
  }
  function enc(key, obj) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj))).then(function (ct) { return { iv: b2s(iv), ct: b2s(ct) }; });
  }
  function dec(key, rec) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: s2b(rec.iv) }, key, s2b(rec.ct)).then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }

  /* ---------- live data in this browser ---------- */
  function collect() {
    var d = {};
    KEYS.forEach(function (k) { var r = null; try { r = store.getItem(k); } catch (e) {} if (r) { try { d[k] = JSON.parse(r); } catch (e) {} } });
    return d;
  }
  function apply(data) {
    KEYS.forEach(function (k) {
      try { if (data && data[k] !== undefined) nativeSet.call(store, k, JSON.stringify(data[k])); else nativeRemove.call(store, k); } catch (e) {}
    });
  }
  function hasLocalData() { return Object.keys(collect()).length > 0; }
  function setActive(id, name) { S.id = id; S.name = name; nativeSet.call(store, ACTIVE, JSON.stringify({ id: id, name: name })); }
  function setSession(key) {
    return crypto.subtle.exportKey('raw', key).then(function (raw) {
      try { sessionStorage.setItem(SESSION, JSON.stringify({ id: S.id, key: b2s(raw) })); } catch (e) {}
    });
  }

  /* ---------- the save file (optional, Chrome/Edge on a computer) ---------- */
  function fileText(r) {
    return JSON.stringify({ app: 'calgencha', type: 'profile', version: 1, id: r.id, name: r.name, kdf: { name: 'PBKDF2-SHA256', iter: r.kdf.iter, salt: r.kdf.salt }, iv: r.iv, ct: r.ct, saved: r.saved }, null, 2);
  }
  function refreshHandle() {
    if (!S.id) { S.hasHandle = false; S.fileState = 'none'; return Promise.resolve(); }
    return dbGet('handles', S.id).then(function (h) {
      S.hasHandle = !!(h && h.handle);
      if (!S.hasHandle) { S.fileState = 'none'; return; }
      if (!h.handle.queryPermission) { S.fileState = 'ok'; return; }
      return h.handle.queryPermission({ mode: 'readwrite' }).then(function (p) { S.fileState = p === 'granted' ? 'ok' : 'perm'; });
    }).catch(function () { S.fileState = 'none'; });
  }
  var mem = null; /* the linked file handle for this page, so saving does not depend on a database round trip */
  function getHandle() { return mem && mem.id === S.id ? Promise.resolve(mem) : dbGet('handles', S.id); }
  function writeFile(rec) {
    return getHandle().then(function (h) {
      if (!h || !h.handle) { S.hasHandle = false; S.fileState = 'none'; return; }
      S.hasHandle = true;
      var q = h.handle.queryPermission ? h.handle.queryPermission({ mode: 'readwrite' }) : Promise.resolve('granted');
      return q.then(function (p) {
        if (p !== 'granted') { S.fileState = 'perm'; return; }
        return h.handle.createWritable().then(function (w) { return w.write(fileText(rec)).then(function () { return w.close(); }); }).then(function () { S.fileState = 'ok'; });
      });
    }).catch(function () { S.fileState = 'error'; });
  }

  /* ---------- saving ---------- */
  var chain = Promise.resolve(), timer = null;
  function doSave() {
    if (!S.key || !S.id) return Promise.reject(new Error('This profile is locked. Unlock it first.'));
    S.saving = true; S.error = ''; S.dirty = false; emit();
    return dbGet('profiles', S.id).then(function (rec) {
      if (!rec) throw new Error('This profile was not found in this browser.');
      var now = new Date().toISOString();
      return enc(S.key, { name: S.name, saved: now, data: collect() }).then(function (e) {
        rec.iv = e.iv; rec.ct = e.ct; rec.saved = now;
        return dbPut('profiles', rec).then(function () { return writeFile(rec); });
      });
    }).then(function () { S.lastSaved = new Date(); S.saving = false; emit(); },
      function (err) { S.dirty = true; S.saving = false; S.error = (err && err.message) || 'Could not save'; emit(); throw err; });
  }
  function saveNow() { chain = chain.then(doSave, doSave); return chain; }
  function changed() {
    if (!S.id) return;
    S.dirty = true; emit();
    if (S.key) { clearTimeout(timer); timer = setTimeout(function () { saveNow().catch(function () {}); }, 800); }
  }
  if (OK) {
    Storage.prototype.setItem = function (k) {
      var r = nativeSet.apply(this, arguments);
      if (this === store && KEYS.indexOf(k) >= 0) changed();
      return r;
    };
    var flush = function () { if (S.id && S.key && S.dirty) saveNow().catch(function () {}); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
    window.addEventListener('storage', function (e) { if (e.key === ACTIVE) location.reload(); });
  }

  /* ---------- profile actions ---------- */
  function need() { if (!OK) throw new Error('Profiles need a secure page (https) and a browser that supports encryption.'); }
  function list() { return OK ? dbAll('profiles').then(function (a) { return a.map(function (r) { return { id: r.id, name: r.name, saved: r.saved }; }).sort(function (x, y) { return x.name.localeCompare(y.name); }); }) : Promise.resolve([]); }

  function register(name, pw, keep) {
    need();
    name = String(name || '').trim().slice(0, 40);
    if (!name) return Promise.reject(new Error('Choose a profile name.'));
    if (String(pw || '').length < 8) return Promise.reject(new Error('Use a password of at least 8 characters.'));
    if (S.id) return Promise.reject(new Error('Log out first.'));
    return list().then(function (ps) {
      if (ps.some(function (p) { return p.name.toLowerCase() === name.toLowerCase(); })) throw new Error('A profile called "' + name + '" already exists in this browser.');
      var salt = crypto.getRandomValues(new Uint8Array(16)), id = rid();
      return derive(pw, salt, ITER).then(function (key) {
        var rec = { id: id, name: name, kdf: { iter: ITER, salt: b2s(salt) }, iv: '', ct: '', saved: '' };
        return dbPut('profiles', rec).then(function () {
          if (!keep) apply({});
          setActive(id, name); S.key = key; S.dirty = false; S.lastSaved = null; S.hasHandle = false; S.fileState = 'none';
          return setSession(key);
        }).then(function () { return saveNow(); });
      });
    });
  }
  function login(id, pw) {
    need();
    if (S.id) return Promise.reject(new Error('Log out first.'));
    return dbGet('profiles', id).then(function (rec) {
      if (!rec) throw new Error('That profile was not found.');
      return derive(pw || '', s2b(rec.kdf.salt), rec.kdf.iter).then(function (key) {
        return dec(key, rec).then(function (payload) {
          apply(payload.data || {});
          setActive(rec.id, rec.name); S.key = key; S.dirty = false; S.error = ''; S.lastSaved = rec.saved ? new Date(rec.saved) : null;
          return setSession(key).then(refreshHandle);
        }, function () { throw new Error('Wrong password, or the file is damaged.'); });
      });
    }).then(emit);
  }
  function unlock(pw) {
    need();
    return dbGet('profiles', S.id).then(function (rec) {
      if (!rec) throw new Error('This profile was not found in this browser.');
      return derive(pw || '', s2b(rec.kdf.salt), rec.kdf.iter).then(function (key) {
        return dec(key, rec).then(function () { S.key = key; return setSession(key); }, function () { throw new Error('Wrong password.'); });
      });
    }).then(function () { emit(); return S.dirty ? saveNow().catch(function () {}) : null; });
  }
  function logout(discard) {
    need();
    var done = function () {
      apply({});
      try { nativeRemove.call(store, ACTIVE); sessionStorage.removeItem(SESSION); } catch (e) {}
      clearTimeout(timer);
      S.id = null; S.name = ''; S.key = null; S.dirty = false; S.lastSaved = null; S.hasHandle = false; S.fileState = 'none'; S.error = '';
      emit();
    };
    if (S.id && S.key && !discard) return saveNow().then(done);
    return Promise.resolve().then(done);
  }
  function changePassword(pw) {
    need();
    if (!S.key) return Promise.reject(new Error('Unlock the profile first.'));
    if (String(pw || '').length < 8) return Promise.reject(new Error('Use a password of at least 8 characters.'));
    var salt = crypto.getRandomValues(new Uint8Array(16));
    return dbGet('profiles', S.id).then(function (rec) {
      return derive(pw, salt, ITER).then(function (key) {
        rec.kdf = { iter: ITER, salt: b2s(salt) };
        return dbPut('profiles', rec).then(function () { S.key = key; return setSession(key); }).then(saveNow);
      });
    });
  }
  function remove(id) {
    need();
    return dbDel('profiles', id).then(function () { return dbDel('handles', id); }).then(function () {
      if (S.id === id) { try { nativeRemove.call(store, ACTIVE); sessionStorage.removeItem(SESSION); } catch (e) {} S.id = null; S.name = ''; S.key = null; S.dirty = false; S.hasHandle = false; S.fileState = 'none'; }
      emit();
    });
  }

  /* ---------- files ---------- */
  function downloadFile(id) {
    need();
    id = id || S.id;
    var go = function () {
      return dbGet('profiles', id).then(function (rec) {
        if (!rec || !rec.ct) throw new Error('Nothing to download yet.');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([fileText(rec)], { type: 'application/json' }));
        a.download = 'calgencha-' + rec.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() + '.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        return rec.name;
      });
    };
    return (S.id === id && S.key) ? saveNow().then(go) : go();
  }
  function importFile(file) {
    need();
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(new Error('Could not read that file.')); }; r.readAsText(file); }).then(function (txt) {
      var o; try { o = JSON.parse(txt); } catch (e) { throw new Error('That file is not valid JSON.'); }
      if (!o || o.app !== 'calgencha' || o.type !== 'profile' || o.version !== 1 || typeof o.id !== 'string' || !/^[\w-]{6,64}$/.test(o.id) || typeof o.name !== 'string' || !o.name.trim() ||
        !o.kdf || !(o.kdf.iter >= 100000 && o.kdf.iter <= 2000000) || typeof o.kdf.salt !== 'string' || typeof o.iv !== 'string' || typeof o.ct !== 'string' || !o.ct) throw new Error('That is not a CalGencha profile file.');
      var rec = { id: o.id, name: o.name.trim().slice(0, 40), kdf: { iter: Math.floor(o.kdf.iter), salt: o.kdf.salt }, iv: o.iv, ct: o.ct, saved: typeof o.saved === 'string' ? o.saved : '' };
      try { s2b(rec.kdf.salt); s2b(rec.iv); s2b(rec.ct); } catch (e) { throw new Error('That profile file is damaged.'); }
      return dbGet('profiles', rec.id).then(function (old) {
        if (S.id === rec.id) throw new Error('You are logged in to this profile already.');
        if (old && old.saved && rec.saved && old.saved > rec.saved && !confirm('The copy in this browser is newer than this file. Replace it with the older file?')) throw new Error('Nothing was changed.');
        return list().then(function (ps) {
          var n = rec.name, i = 2;
          while (ps.some(function (p) { return p.id !== rec.id && p.name.toLowerCase() === n.toLowerCase(); })) n = rec.name + ' (' + (i++) + ')';
          rec.name = n;
          return dbPut('profiles', rec).then(function () { return rec; });
        });
      });
    });
  }
  function linkFile() {
    need();
    if (!CAN_FILE) return Promise.reject(new Error('This browser cannot save to a file automatically.'));
    if (!S.key) return Promise.reject(new Error('Unlock the profile first.'));
    return window.showSaveFilePicker({ suggestedName: 'calgencha-' + S.name.replace(/[^\w.-]+/g, '-').toLowerCase() + '.json', types: [{ description: 'CalGencha profile', accept: { 'application/json': ['.json'] } }] })
      .then(function (h) { mem = { id: S.id, handle: h }; return dbPut('handles', { id: S.id, handle: h }); })
      .then(function () { S.hasHandle = true; S.fileState = 'ok'; return saveNow(); });
  }
  function unlinkFile() { mem = null; return dbDel('handles', S.id).then(function () { S.hasHandle = false; S.fileState = 'none'; emit(); }); }
  function reconnect() {
    return getHandle().then(function (h) {
      if (!h || !h.handle) throw new Error('No save file is linked.');
      return h.handle.requestPermission({ mode: 'readwrite' }).then(function (p) {
        if (p !== 'granted') throw new Error('Permission was not given.');
        return saveNow();
      });
    });
  }

  var api = {
    ok: OK, canFile: CAN_FILE, keys: KEYS,
    state: function () { return { id: S.id, name: S.name, unlocked: !!S.key, dirty: S.dirty, saving: S.saving, lastSaved: S.lastSaved, fileState: S.fileState, hasHandle: S.hasHandle, error: S.error }; },
    onChange: function (f) { listeners.push(f); },
    hasLocalData: hasLocalData, list: list, register: register, login: login, unlock: unlock, logout: logout,
    changePassword: changePassword, remove: remove, saveNow: saveNow, downloadFile: downloadFile, importFile: importFile,
    linkFile: linkFile, unlinkFile: unlinkFile, reconnect: reconnect
  };
  window.CalGenchaProfile = api;

  /* ---------- start up ---------- */
  api.ready = !OK ? Promise.resolve() : Promise.resolve().then(function () {
    try { var a = JSON.parse(store.getItem(ACTIVE)); if (a && a.id) { S.id = a.id; S.name = String(a.name || ''); } } catch (e) {}
    if (!S.id) return;
    return Promise.resolve().then(function () {
      var s = null; try { s = JSON.parse(sessionStorage.getItem(SESSION)); } catch (e) {}
      if (s && s.id === S.id && s.key) return crypto.subtle.importKey('raw', s2b(s.key), 'AES-GCM', true, ['encrypt', 'decrypt']).then(function (k) { S.key = k; }, function () {});
    }).then(refreshHandle).then(function () {
      return dbGet('profiles', S.id).then(function (rec) { if (!rec) { try { nativeRemove.call(store, ACTIVE); } catch (e) {} S.id = null; S.name = ''; S.key = null; } else if (rec.saved) S.lastSaved = new Date(rec.saved); });
    });
  }).catch(function () {}).then(emit);

  /* ---------- UI ---------- */
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function css() {
    var s = document.createElement('style');
    s.textContent =
      '.sitebar{display:flex;align-items:center;justify-content:space-between;gap:12px}' +
      '.pchip{display:inline-flex;align-items:center;max-width:55vw;padding:4px 10px;border:1px solid var(--line,#ccc);border-radius:999px;color:var(--muted,var(--mute,#666));font:600 12px/1.3 system-ui,sans-serif;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.pchip:hover{color:var(--ink,#111);border-color:var(--muted,var(--mute,#666))}.pchip.warn{color:var(--over,var(--bad,#c2410c))}' +
      '.pf label{display:block;font-size:13px;font-weight:600;color:var(--muted,#555);margin:12px 0 4px}' +
      '.pf input[type=text],.pf input[type=password],.pf select{width:100%;min-height:44px;padding:0 12px;border:1px solid var(--line,#ccc);border-radius:8px;background:var(--surface-2,var(--bg,#fff));color:var(--ink,#111);font:inherit}' +
      '.pf input:focus-visible,.pf select:focus-visible{outline:2px solid var(--accent,#2347c8);outline-offset:2px}' +
      '.pf .acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.pf .note{font-size:13px;color:var(--muted,#555);margin:8px 0 0}' +
      '.pf label.chk{display:flex;align-items:center;gap:8px;font-weight:400;color:var(--ink,#111)}.pf label.chk input{width:18px;height:18px;flex:none}' +
      '.pf .st{font-size:14px;color:var(--muted,#555);margin:4px 0 0}.pf .msg{min-height:1.3em;font-size:14px;margin:12px 0 0;color:var(--muted,#555)}.pf .msg.err{color:var(--over,#c2410c)}' +
      '.pf .danger{color:var(--over,#c2410c)}.pf hr{border:0;border-top:1px solid var(--line,#ccc);margin:16px 0 0}';
    document.head.appendChild(s);
  }

  function chip() {
    var bar = document.querySelector('.sitebar');
    if (!bar) return;
    var a = document.getElementById('pchip');
    if (!a) { a = document.createElement('a'); a.id = 'pchip'; a.className = 'pchip'; a.href = 'index.html#profile'; bar.appendChild(a); }
    var st = api.state(), t, warn = false;
    if (!OK) { a.style.display = 'none'; return; }
    if (!st.id) t = 'Guest · Log in';
    else if (!st.unlocked) { t = st.name + ' · Locked, tap to unlock'; warn = true; }
    else if (st.saving) t = st.name + ' · Saving…';
    else if (st.error) { t = st.name + ' · Not saved'; warn = true; }
    else if (st.dirty) t = st.name + ' · Unsaved changes';
    else t = st.name + (st.lastSaved ? ' · Saved ' + timeText(st.lastSaved) : '');
    a.textContent = t; a.classList.toggle('warn', warn);
    a.setAttribute('aria-label', 'Profile: ' + t + '. Open profile settings.');
  }

  function panel(root) {
    var view = 'home', msg = '', bad = false, pick = '', focus = '';
    function $(id) { return document.getElementById(id); }
    function say(t, e) { msg = t; bad = !!e; var m = $('pf_msg'); if (m) { m.textContent = t; m.className = 'msg' + (e ? ' err' : ''); } }
    function fail(e) { say((e && e.message) || 'Something went wrong.', true); }

    function statusText() {
      var st = api.state();
      if (!st.unlocked) return 'Locked. Enter your password to save changes.';
      if (st.saving) return 'Saving…';
      if (st.error) return 'Could not save: ' + st.error;
      if (st.dirty) return 'Changes not saved yet…';
      return st.lastSaved ? 'All changes saved at ' + timeText(st.lastSaved) + '.' : 'Ready.';
    }
    function fileHtml(st) {
      if (!api.canFile) return '<p class="note">Autosaving to a file works in Chrome and Edge on a computer. On this browser, use Download save file to keep a copy.</p>';
      if (!st.hasHandle) return '<div class="acts"><button type="button" class="btn" data-a="link">Autosave to a save file…</button></div><p class="note">Pick a file once and every change is also written there.</p>';
      var line = st.fileState === 'ok' ? 'Autosaving to your save file.' : st.fileState === 'perm' ? 'Your browser needs permission again to write to the save file.' : 'Could not write to the save file.';
      return '<p class="st" id="pf_file">' + line + '</p><div class="acts">' + (st.fileState === 'perm' ? '<button type="button" class="btn primary" data-a="reconnect">Allow saving to file</button>' : '') +
        '<button type="button" class="btn" data-a="link">Choose another file…</button><button type="button" class="btn" data-a="unlink">Stop autosaving to file</button></div>';
    }

    function draw() {
      if (!OK) { root.innerHTML = '<div class="pf"><p class="note">Profiles need a secure page (https) and a browser that supports encryption. Open this site from its GitHub Pages address.</p></div>'; return Promise.resolve(); }
      return api.list().then(function (ps) {
        var st = api.state(), h = '<div class="pf">';
        if (!st.id) {
          h += '<p class="st">You are using CalGencha as a guest. Your data stays in this browser. A profile adds a password, automatic saving, and a save file you can move to another device.</p>';
          if (view === 'home') {
            h += '<div class="acts"><button type="button" class="btn primary" data-a="goReg">Register</button><button type="button" class="btn" data-a="goLogin">Log in</button>' +
              '<button type="button" class="btn" data-a="loadFile">Load a profile file…</button></div>';
          } else if (view === 'register') {
            h += '<form data-f="reg"><label for="pf_n">Profile name</label><input type="text" id="pf_n" maxlength="40" autocomplete="username">' +
              '<label for="pf_p">Password (at least 8 characters)</label><input type="password" id="pf_p" autocomplete="new-password">' +
              '<label for="pf_p2">Repeat password</label><input type="password" id="pf_p2" autocomplete="new-password">' +
              (api.hasLocalData() ? '<label class="chk"><input type="checkbox" id="pf_keep" checked> Keep the data already in this browser</label>' : '') +
              '<p class="note"><b>There is no password recovery.</b> Nothing is stored on a server, so if you forget the password nobody can open the profile.</p>' +
              '<div class="acts"><button type="submit" class="btn primary">Create profile</button><button type="button" class="btn" data-a="home">Cancel</button></div></form>';
          } else if (view === 'login') {
            if (!ps.length) h += '<p class="note">There are no profiles in this browser yet. Register, or load a profile file.</p><div class="acts"><button type="button" class="btn" data-a="loadFile">Load a profile file…</button><button type="button" class="btn" data-a="home">Back</button></div>';
            else {
              if (!pick || !ps.some(function (p) { return p.id === pick; })) pick = ps[0].id;
              h += '<form data-f="login"><label for="pf_sel">Profile</label><select id="pf_sel">' + ps.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === pick ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>' +
                '<label for="pf_p">Password</label><input type="password" id="pf_p" autocomplete="current-password">' +
                (api.hasLocalData() ? '<p class="note">Logging in replaces the data currently in this browser with the profile\'s data.</p>' : '') +
                '<div class="acts"><button type="submit" class="btn primary">Log in</button><button type="button" class="btn" data-a="loadFile">Load a profile file…</button><button type="button" class="btn" data-a="home">Cancel</button></div></form>';
            }
          }
        } else if (!st.unlocked) {
          h += '<p class="st">Signed in as <b>' + esc(st.name) + '</b> (locked)</p><p class="note">The browser forgot your password when the tab was closed. Your data is still here. Enter the password to turn saving back on.</p>' +
            '<form data-f="unlock"><label for="pf_p">Password</label><input type="password" id="pf_p" autocomplete="current-password"><div class="acts"><button type="submit" class="btn primary">Unlock</button>' +
            '<button type="button" class="btn danger" data-a="logoutDiscard">Log out without saving</button></div></form>';
        } else {
          h += '<p class="st">Signed in as <b>' + esc(st.name) + '</b></p><p class="st" id="pf_st">' + esc(statusText()) + '</p>' + fileHtml(st) + '<hr>' +
            '<div class="acts"><button type="button" class="btn" data-a="save">Save now</button><button type="button" class="btn" data-a="download">Download save file</button>' +
            '<button type="button" class="btn" data-a="goPw">Change password</button><button type="button" class="btn primary" data-a="logout">Log out</button></div>';
          if (view === 'pw') h += '<form data-f="pw"><label for="pf_p">New password (at least 8 characters)</label><input type="password" id="pf_p" autocomplete="new-password"><div class="acts"><button type="submit" class="btn primary">Change password</button><button type="button" class="btn" data-a="home">Cancel</button></div></form>';
          h += '<p class="note">Logging out saves your profile, then clears this browser so the next person starts fresh. Log in again to bring it back.</p>' +
            '<div class="acts"><button type="button" class="btn danger" data-a="delete">Delete this profile from this browser</button></div>';
        }
        h += '<p class="msg' + (bad ? ' err' : '') + '" id="pf_msg" role="status">' + esc(msg) + '</p><input type="file" id="pf_file_in" accept=".json,application/json" hidden></div>';
        root.innerHTML = h;
        if (focus && $(focus)) $(focus).focus(); focus = '';
      });
    }
    function go(v, f) { view = v; focus = f || ''; msg = ''; bad = false; return draw(); }

    root.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-a]'); if (!b) return;
      var a = b.dataset.a, st = api.state();
      if (a === 'goReg') go('register', 'pf_n');
      else if (a === 'goLogin') go('login', 'pf_p');
      else if (a === 'home') go('home');
      else if (a === 'goPw') go('pw', 'pf_p');
      else if (a === 'loadFile') $('pf_file_in').click();
      else if (a === 'save') { say('Saving…'); api.saveNow().then(function () { say('Saved.'); }, fail); }
      else if (a === 'download') api.downloadFile().then(function (n) { say('Downloaded the save file for ' + n + '.'); }, fail);
      else if (a === 'link') api.linkFile().then(function () { return draw().then(function () { say('Autosave to the save file is on.'); }); }, function (er) { if (er && er.name === 'AbortError') return; fail(er); });
      else if (a === 'unlink') api.unlinkFile().then(function () { return draw(); }, fail);
      else if (a === 'reconnect') api.reconnect().then(function () { return draw().then(function () { say('Saved to the file.'); }); }, fail);
      else if (a === 'logout') { say('Saving and logging out…'); api.logout(false).then(function () { return go('home').then(function () { say('Logged out. Your profile is saved in this browser; log in to bring your data back.'); }); }, fail); }
      else if (a === 'logoutDiscard') { if (confirm('Log out without unlocking? Changes made since the tab was closed will not be added to your profile.')) api.logout(true).then(function () { return go('home'); }, fail); }
      else if (a === 'delete') { if (confirm('Delete the profile "' + st.name + '" from this browser? Your current data stays here as guest data. Download the save file first if you want a copy.')) api.remove(st.id).then(function () { return go('home'); }, fail); }
    });
    root.addEventListener('change', function (e) {
      if (e.target.id === 'pf_sel') pick = e.target.value;
      if (e.target.id !== 'pf_file_in') return;
      var f = e.target.files[0]; e.target.value = ''; if (!f) return;
      api.importFile(f).then(function (rec) { pick = rec.id; return go('login', 'pf_p').then(function () { say('Loaded "' + rec.name + '". Enter its password to log in.'); }); }, fail);
    });
    root.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target.dataset.f, p = $('pf_p') ? $('pf_p').value : '';
      if (f === 'reg') {
        if (p !== $('pf_p2').value) return say('The two passwords do not match.', true);
        var keep = $('pf_keep') ? $('pf_keep').checked : false;
        if (!keep && api.hasLocalData() && !confirm('Start empty? The data currently in this browser will be cleared.')) return;
        say('Creating profile…');
        api.register($('pf_n').value, p, keep).then(function () { return go('home').then(function () { say('Profile created. Your changes now save automatically.'); }); }, fail);
      } else if (f === 'login') {
        if (api.hasLocalData() && !confirm('Logging in replaces the data currently in this browser with this profile\'s data. Continue?')) return;
        say('Opening profile…');
        api.login($('pf_sel').value, p).then(function () { return go('home').then(function () { say('Logged in.'); }); }, fail);
      } else if (f === 'unlock') {
        say('Unlocking…'); api.unlock(p).then(function () { return go('home').then(function () { say('Unlocked.'); }); }, fail);
      } else if (f === 'pw') {
        say('Changing password…'); api.changePassword(p).then(function () { return go('home').then(function () { say('Password changed.'); }); }, fail);
      }
    });
    api.onChange(function () { var s = $('pf_st'); if (s) s.textContent = statusText(); var fl = $('pf_file'); if (fl && api.state().fileState !== 'ok') draw(); });
    api.ready.then(function () { return draw(); });
  }

  function start() {
    css();
    var root = document.getElementById('profilePanel');
    api.onChange(chip);
    api.ready.then(chip);
    if (root) panel(root);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
