import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, deleteDoc
} from 'firebase/firestore';

(function () {
  var tasks = [];
  var store = null;
  var confirmId = null;
  var loaded = false;
  var cfg = window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey ? window.FIREBASE_CONFIG : null;

  var ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg>';

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  function fmtDay(s) {
    var p = s.split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var o = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString('fr-FR', o);
  }
  function fmtStamp(ms) {
    return new Date(ms).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDur(ms) {
    var m = Math.floor(ms / 60000);
    if (m < 1) return '< 1 min';
    var d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
    if (d > 0) return d + ' j ' + h + ' h';
    if (h > 0) return h + ' h ' + pad(mi);
    return mi + ' min';
  }
  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }
  function status(t) { return t.doneAt ? 'done' : (t.startedAt ? 'running' : 'todo'); }
  function setNote(msg, warn) { var n = $('note'); n.textContent = msg || ''; n.className = 'note' + (warn ? ' warn' : ''); }

  /* ---------- stockage local (sans synchronisation) ---------- */
  var LOCAL_KEY = 'a2m-memo-taches';
  function readLocal() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) { return []; } }
  function writeLocal(list) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch (e) { } }

  function localStore() {
    return {
      mode: 'local',
      start: function (cb) { tasks = readLocal(); cb(); },
      stop: function () { },
      save: function (t) { tasks = tasks.filter(function (x) { return x.id !== t.id; }).concat([t]); writeLocal(tasks); render(); },
      remove: function (id) { tasks = tasks.filter(function (x) { return x.id !== id; }); writeLocal(tasks); render(); }
    };
  }

  /* ---------- stockage synchronisé (Firebase) ---------- */
  var fbApp, fbAuth, fbDb;
  function cloudStore(uid) {
    var col = collection(fbDb, 'users', uid, 'tasks');
    var unsub = null;
    return {
      mode: 'sync',
      start: function (cb) {
        /* reprise des tâches créées avant la connexion */
        var old = readLocal();
        old.forEach(function (t) { setDoc(doc(col, t.id), t).catch(function () { }); });
        if (old.length) writeLocal([]);
        unsub = onSnapshot(col, function (snap) {
          tasks = snap.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
          cb();
        }, function () { setNote('Synchronisation interrompue. Vérifiez la connexion puis rechargez.', true); });
      },
      stop: function () { if (unsub) unsub(); unsub = null; },
      save: function (t) { setDoc(doc(col, t.id), t).catch(function () { setNote("Enregistrement impossible pour l'instant.", true); }); },
      remove: function (id) { deleteDoc(doc(col, id)).catch(function () { setNote('Suppression impossible pour l\'instant.', true); }); }
    };
  }

  /* ---------- actions ---------- */
  function findTask(id) { return tasks.filter(function (t) { return t.id === id; })[0]; }
  function addTask(title, date) {
    store.save({ id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: title, entryDate: date || todayStr(), createdAt: Date.now(), startedAt: null, doneAt: null });
  }
  function startTask(id) { var t = findTask(id); if (t) store.save(Object.assign({}, t, { startedAt: Date.now(), doneAt: null })); }
  function toggleDone(id) {
    var t = findTask(id); if (!t) return;
    store.save(t.doneAt ? Object.assign({}, t, { doneAt: null, startedAt: null }) : Object.assign({}, t, { doneAt: Date.now() }));
  }

  /* ---------- rendu ---------- */
  function taskHTML(t) {
    var st = status(t), h = '';
    h += '<article class="task ' + st + '" data-id="' + esc(t.id) + '">';
    h += '<button class="check" data-act="toggle" role="checkbox" aria-checked="' + (st === 'done') + '" aria-label="' + (st === 'done' ? 'Rouvrir la tâche' : 'Marquer comme terminée') + '">' + ICON_CHECK + '</button>';
    h += '<div class="body"><div class="title">' + esc(t.title) + '</div><div class="meta">';
    h += '<span>Entrée le ' + esc(fmtDay(t.entryDate)) + '</span>';
    if (st === 'running') {
      h += '<span>Démarrée ' + esc(fmtStamp(t.startedAt)) + '</span><span class="chip live" data-live="' + t.startedAt + '">' + fmtClock(Date.now() - t.startedAt) + '</span>';
    } else if (st === 'done') {
      if (t.startedAt) h += '<span class="chip spent">' + esc(fmtDur(t.doneAt - t.startedAt)) + '</span>';
      else h += '<span>Durée non chronométrée</span>';
      h += '<span>Terminée ' + esc(fmtStamp(t.doneAt)) + '</span>';
    }
    h += '</div></div><div class="actions">';
    if (confirmId === t.id) {
      h += '<span class="confirm">Supprimer ?<button class="btn small" data-act="delete-yes">Oui</button><button class="btn small ghost" data-act="delete-no">Non</button></span>';
    } else {
      if (st === 'todo') h += '<button class="btn small" data-act="start">Démarrer</button>';
      h += '<button class="icon" data-act="delete" aria-label="Supprimer la tâche">' + ICON_TRASH + '</button>';
    }
    h += '</div></article>';
    return h;
  }
  function group(title, list) {
    if (!list.length) return '';
    return '<section class="group"><h2>' + title + ' <em>' + list.length + '</em></h2>' + list.map(taskHTML).join('') + '</section>';
  }
  function render() {
    var running = tasks.filter(function (t) { return status(t) === 'running'; }).sort(function (a, b) { return a.startedAt - b.startedAt; });
    var todo = tasks.filter(function (t) { return status(t) === 'todo'; }).sort(function (a, b) { return a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : a.createdAt - b.createdAt; });
    var done = tasks.filter(function (t) { return status(t) === 'done'; }).sort(function (a, b) { return b.doneAt - a.doneAt; });
    var html = group('En cours', running) + group('À faire', todo) + group('Terminées', done);
    if (!tasks.length) {
      html = '<div class="empty"><strong>' + (loaded ? 'Aucune tâche pour le moment' : 'Chargement…') + '</strong>' +
        (loaded ? '<p>Saisissez une tâche ci-dessus, appuyez sur Démarrer quand vous commencez, puis cochez-la une fois terminée. Le temps passé s\'affichera ici.</p>' : '') + '</div>';
    }
    $('lists').innerHTML = html;
    updateStats();
  }
  function updateStats() {
    var now = Date.now(), spent = 0, nDone = 0, nOpen = 0;
    tasks.forEach(function (t) {
      if (t.doneAt) { nDone++; if (t.startedAt) spent += t.doneAt - t.startedAt; }
      else { nOpen++; if (t.startedAt) spent += now - t.startedAt; }
    });
    $('stats').innerHTML =
      '<div class="stat"><b>' + nOpen + '</b><span>Restantes</span></div>' +
      '<div class="stat"><b>' + nDone + '</b><span>Terminées</span></div>' +
      '<div class="stat"><b>' + tasks.length + '</b><span>Au total</span></div>' +
      '<div class="stat time"><b>' + esc(fmtDur(spent)) + '</b><span>Temps passé</span></div>';
    $('bar').style.width = (tasks.length ? Math.round(nDone / tasks.length * 100) : 0) + '%';
  }

  var lastMin = -1;
  setInterval(function () {
    var now = Date.now();
    document.querySelectorAll('[data-live]').forEach(function (el) { el.textContent = fmtClock(now - (+el.getAttribute('data-live'))); });
    var m = Math.floor(now / 60000);
    if (m !== lastMin) { lastMin = m; if (tasks.length) updateStats(); }
  }, 1000);

  /* ---------- écrans : connexion / application ---------- */
  function showApp(show) { $('app').hidden = !show; $('auth').hidden = show; }
  function authError(code) {
    var m = {
      'auth/invalid-email': "Adresse e-mail non valide.",
      'auth/missing-password': 'Saisissez votre mot de passe.',
      'auth/weak-password': 'Mot de passe trop court : 6 caractères minimum.',
      'auth/email-already-in-use': 'Un compte existe déjà avec cet e-mail. Utilisez « Se connecter ».',
      'auth/invalid-credential': 'E-mail ou mot de passe incorrect.',
      'auth/user-not-found': 'E-mail ou mot de passe incorrect.',
      'auth/wrong-password': 'E-mail ou mot de passe incorrect.',
      'auth/too-many-requests': 'Trop de tentatives. Réessayez dans quelques minutes.',
      'auth/network-request-failed': 'Pas de connexion internet. Réessayez une fois en ligne.',
      'auth/operation-not-allowed': "La connexion par e-mail n'est pas activée dans Firebase."
    };
    return m[code] || 'Connexion impossible. Réessayez.';
  }
  function setAuthMsg(msg, ok) { var e = $('authMsg'); e.textContent = msg || ''; e.className = 'authmsg' + (ok ? ' ok' : ''); }

  function bootApp(s, who) {
    if (store) store.stop();
    store = s; loaded = false; tasks = []; render();
    showApp(true);
    s.start(function () { loaded = true; render(); });
    if (s.mode === 'local') {
      setNote('Mode local : vos tâches restent sur cet appareil et ne sont pas synchronisées.', true);
      $('who').hidden = true;
    } else {
      setNote('');
      $('who').hidden = false; $('whoMail').textContent = who;
    }
  }

  function setupAuthUI() {
    function creds() { return { e: $('authEmail').value.trim(), p: $('authPass').value }; }
    $('authForm').addEventListener('submit', function (ev) {
      ev.preventDefault(); var c = creds(); setAuthMsg('');
      signInWithEmailAndPassword(fbAuth, c.e, c.p).catch(function (er) { setAuthMsg(authError(er.code)); });
    });
    $('authCreate').addEventListener('click', function () {
      var c = creds(); setAuthMsg('');
      createUserWithEmailAndPassword(fbAuth, c.e, c.p).catch(function (er) { setAuthMsg(authError(er.code)); });
    });
    $('authReset').addEventListener('click', function () {
      var c = creds(); if (!c.e) { setAuthMsg("Saisissez d'abord votre e-mail."); return; }
      sendPasswordResetEmail(fbAuth, c.e).then(function () { setAuthMsg('E-mail de réinitialisation envoyé.', true); }).catch(function (er) { setAuthMsg(authError(er.code)); });
    });
    $('logout').addEventListener('click', function () { signOut(fbAuth); });
  }

  /* ---------- événements ---------- */
  $('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!store) return;
    var title = $('newTitle').value.trim();
    if (!title) { $('newTitle').focus(); return; }
    addTask(title, $('newDate').value || todayStr());
    $('newTitle').value = ''; $('newDate').value = todayStr(); $('newTitle').focus();
  });
  $('lists').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]'); if (!btn) return;
    var id = btn.closest('.task').getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'start') startTask(id);
    else if (act === 'toggle') toggleDone(id);
    else if (act === 'delete') { confirmId = id; render(); }
    else if (act === 'delete-no') { confirmId = null; render(); }
    else if (act === 'delete-yes') { confirmId = null; store.remove(id); }
  });

  /* ---------- démarrage ---------- */
  $('today').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('newDate').value = todayStr();

  if (!cfg) {
    bootApp(localStore());
  } else {
    showApp(false);
    fbApp = initializeApp(cfg);
    fbAuth = getAuth(fbApp);
    fbDb = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    setupAuthUI();
    onAuthStateChanged(fbAuth, function (user) {
      if (user) bootApp(cloudStore(user.uid), user.email || '');
      else { if (store) { store.stop(); store = null; } tasks = []; showApp(false); }
    });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { }); });
  }
})();
