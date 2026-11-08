// Bingo Arena client. The server is the single source of truth for called
// numbers, card contents, marks and wins — this file only renders server state
// and forwards the player's taps.
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'bingoArenaToken';
  let token = localStorage.getItem(TOKEN_KEY);
  let roomId = null;
  let state = null;
  let clockOffset = 0;
  let pollTimer = null;
  let tickTimer = null;
  let roomsTimer = null;
  let reqSeq = 0;
  let appliedSeq = 0;
  const pendingMarks = new Map(); // number -> desired marked state (optimistic)
  let winLine = null;

  const label = (n) => 'BINGO'[Math.min(4, Math.floor((n - 1) / 15))] + ' ' + n;

  class ApiError extends Error {
    constructor(msg, code, status) { super(msg); this.code = code; this.status = status; }
  }

  async function ensureSession() {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: token ? { authorization: 'Bearer ' + token } : {},
    });
    const data = await res.json();
    if (data.token) { token = data.token; localStorage.setItem(TOKEN_KEY, token); }
    setPoints(data.points);
  }

  async function api(path, { method = 'GET', body, retry = true } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && retry) {
      token = null; localStorage.removeItem(TOKEN_KEY);
      await ensureSession();
      return api(path, { method, body, retry: false });
    }
    if (!res.ok) throw new ApiError(data.error || 'Request failed', data.code, res.status);
    return data;
  }

  function setPoints(p) { if (typeof p === 'number') $('points').textContent = p.toLocaleString(); }

  // ------------------------------------------------------------ rooms

  async function loadRooms() {
    try {
      const { rooms, online } = await api('/rooms');
      $('online').textContent = online.toLocaleString();
      const list = $('roomList');
      list.innerHTML = '';
      for (const r of rooms) {
        const row = document.createElement('div');
        row.className = 'panel room';
        const info = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = r.name;
        const meta = document.createElement('small');
        meta.textContent = `75-Ball · ${r.players} player${r.players === 1 ? '' : 's'} · ball every ${r.intervalMs / 1000}s · Free entry`;
        info.append(name, meta);
        const btn = document.createElement('button');
        btn.textContent = 'Join';
        btn.onclick = () => joinRoom(r.id);
        row.append(info, btn);
        list.appendChild(row);
      }
    } catch (e) {
      $('roomList').innerHTML = '<div class="panel room"><div><strong>Couldn\'t load rooms</strong><small>Retrying…</small></div></div>';
    }
  }

  // ------------------------------------------------------------ game

  async function joinRoom(id) {
    roomId = id;
    stopGameTimers();
    pendingMarks.clear();
    winLine = null;
    state = null;
    clearInterval(roomsTimer);
    $('home').style.display = 'none';
    $('game').style.display = 'block';
    $('status').textContent = 'Joining…';
    $('card').innerHTML = '';
    try {
      const seq = ++reqSeq;
      applyState(await api(`/rooms/${id}/join`, { method: 'POST' }), seq);
      pollTimer = setInterval(poll, 1500);
      tickTimer = setInterval(tick, 250);
    } catch (e) {
      toast(e.message, true);
      leaveRoom();
    }
  }

  function leaveRoom() {
    stopGameTimers();
    state = null;
    $('game').style.display = 'none';
    $('home').style.display = 'block';
    loadRooms();
    roomsTimer = setInterval(loadRooms, 10000);
  }

  function stopGameTimers() { clearInterval(pollTimer); clearInterval(tickTimer); }

  async function poll() {
    if (!state) return;
    const seq = ++reqSeq;
    try { applyState(await api(`/games/${state.gameId}/state`), seq); } catch { /* transient */ }
  }

  function applyState(s, seq) {
    if (seq < appliedSeq) return; // a newer response already landed
    appliedSeq = seq;
    state = s;
    clockOffset = s.serverTime - Date.now();
    setPoints(s.points);
    render();
  }

  const serverNow = () => Date.now() + clockOffset;

  function tick() {
    if (!state) return;
    renderStatus();
    if (state.status === 'active' && state.nextCallAt && serverNow() >= state.nextCallAt + 150) {
      // A new ball is due — fetch it now rather than waiting for the poll.
      state.nextCallAt = null;
      poll();
    }
  }

  function isMarked(n) {
    if (pendingMarks.has(n)) return pendingMarks.get(n);
    return state.card.marked.includes(n);
  }

  function render() {
    $('roomName').textContent = state.roomName;
    $('current').textContent = state.current ? label(state.current) : '—';
    const recent = $('recent');
    recent.innerHTML = '';
    state.called.slice(-8).reverse().forEach((n) => {
      const b = document.createElement('span');
      b.textContent = n;
      b.title = label(n);
      recent.appendChild(b);
    });

    const banner = $('banner');
    banner.className = 'banner';
    if (state.status === 'won') {
      banner.classList.add(state.winner.isYou ? 'win' : 'lose');
      banner.textContent = state.winner.isYou ? '🏆 You won! Bingo verified by the server.' : 'Another player won this game.';
    } else if (state.status === 'ended') {
      banner.classList.add('lose');
      banner.textContent = 'All 75 balls were called — no winner this time.';
    }
    const over = state.status !== 'active';
    $('newGameBtn').style.display = over ? '' : 'none';
    const claimBtn = $('claimBtn');
    claimBtn.disabled = over || state.card.claimsLeft === 0;
    claimBtn.textContent = state.card.claimsLeft === 0 && !over ? 'No claims left' : 'Claim Bingo';

    renderStatus();
    renderCard();
  }

  function renderStatus() {
    const el = $('status');
    if (state.status !== 'active') {
      el.textContent = `${state.called.length}/75 called · game over`;
      return;
    }
    const secs = state.nextCallAt ? Math.max(0, Math.ceil((state.nextCallAt - serverNow()) / 1000)) : null;
    if (!state.called.length) el.textContent = `Game starts in ${secs ?? 0}s`;
    else if (secs === null) el.textContent = `${state.called.length}/75 called`;
    else el.textContent = `${state.called.length}/75 called · next ball in ${secs}s`;
  }

  function renderCard() {
    const body = $('card');
    body.innerHTML = '';
    const called = new Set(state.called);
    for (let r = 0; r < 5; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < 5; c++) {
        const i = r * 5 + c;
        const n = state.card.numbers[i];
        const td = document.createElement('td');
        if (n === 0) {
          td.textContent = 'FREE';
          td.classList.add('free', 'marked');
          td.setAttribute('aria-label', 'Free square, always marked');
        } else {
          td.textContent = n;
          const marked = isMarked(n) && called.has(n);
          if (marked) td.classList.add('marked');
          if (pendingMarks.has(n)) td.classList.add('pending');
          td.setAttribute('role', 'button');
          td.setAttribute('aria-pressed', String(marked));
          td.setAttribute('aria-label', label(n) + (marked ? ', marked' : ''));
          td.onclick = () => onCellTap(n, td);
        }
        if (winLine && winLine.includes(i)) td.classList.add('win');
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  function deny(td, msg) {
    td.classList.remove('denied');
    void td.offsetWidth; // restart animation
    td.classList.add('denied');
    setTimeout(() => td.classList.remove('denied'), 600);
    if (navigator.vibrate) navigator.vibrate(80);
    toast(msg, true);
  }

  async function onCellTap(n, td) {
    if (!state) return;
    if (state.status !== 'active') { toast('This game is over.'); return; }
    if (pendingMarks.has(n)) return;
    const currentlyMarked = isMarked(n) && state.called.includes(n);

    // Marking requires the number to be in the server's called list.
    // Unmarking a previously marked (called) number is always allowed.
    if (!currentlyMarked && !state.called.includes(n)) {
      deny(td, `${label(n)} hasn't been called yet`);
      return;
    }

    pendingMarks.set(n, !currentlyMarked);
    renderCard();
    const seq = ++reqSeq;
    try {
      const s = await api(`/games/${state.gameId}/mark`, { method: 'POST', body: { number: n, marked: !currentlyMarked } });
      pendingMarks.delete(n);
      applyState(s, seq);
    } catch (e) {
      pendingMarks.delete(n);
      renderCard();
      const cell = [...$('card').querySelectorAll('td')].find((t) => t.textContent === String(n));
      if (cell) deny(cell, e.message); else toast(e.message, true);
      if (e.code === 'game_over') poll();
    }
  }

  async function claimBingo() {
    if (!state || state.status !== 'active') return;
    const btn = $('claimBtn');
    btn.disabled = true;
    const seq = ++reqSeq;
    try {
      const res = await api(`/games/${state.gameId}/claim`, { method: 'POST' });
      if (res.ok) winLine = res.line;
      toast(res.message, !res.ok);
      applyState(res.state, seq);
    } catch (e) {
      toast(e.message, true);
      poll();
    } finally {
      if (state) render();
    }
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', isError);
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.display = 'none'), 2400);
  }

  // Expose the handlers used by inline onclick attributes.
  Object.assign(window, { joinRoom: (id) => joinRoom(id), leaveRoom, claimBingo });
  Object.defineProperty(window, 'roomId', { get: () => roomId });

  ensureSession()
    .catch(() => toast('Could not connect to the server', true))
    .finally(() => { loadRooms(); roomsTimer = setInterval(loadRooms, 10000); });
})();
