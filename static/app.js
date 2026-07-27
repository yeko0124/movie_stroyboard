'use strict';

/* ───────── 상수 / 유틸 ───────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const COLORS = ['#2B6CF0', '#5BC2A8', '#F0A93C', '#E0745E', '#C08FE0', '#9BB068'];

const FRAME_W = 320;          // 프레임 가로 (월드 단위)
const FRAME_H = 180;          // 16:9
const LABEL_H = 22;           // 프레임 위 라벨 높이
const GRID = 10;              // 배치 스냅
const IMAGE_SECONDS = 3;      // 이어서 재생할 때 이미지 한 장을 보여 주는 시간
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 3;

// 맥에서는 Ctrl 자리에 ⌘ 를 쓴다
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const state = {
  me: null,
  boards: [],
  board: null,
  boardSnapshot: '',
  order: [],                  // 읽기 순서로 정렬된 씬 배열
  sceneId: null,
  newProfile: { color: COLORS[0], file: null },
  busy: false,                // 드래그·마키 등 화면을 건드리는 중
  uploading: new Set(),
  pollTimer: null,
};

const view = { tx: 80, ty: 60, z: 1 };
const selection = new Set();

// 휠을 돌렸을 때: 'auto' 는 마우스 휠이면 확대, 트랙패드 스크롤이면 화면 이동.
// 감지가 어긋나면 아래 HUD 버튼으로 고정할 수 있다.
let wheelMode = localStorage.getItem('sb-wheel') || 'auto';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initial(name) {
  return (String(name || '?').trim()[0] || '?').toUpperCase();
}

function avatarHTML(user, size = 28) {
  if (!user) return '';
  if (user.avatar_url) {
    return `<img class="av" style="--sz:${size}px" src="${esc(user.avatar_url)}" alt="${esc(user.name)}" title="${esc(user.name)}">`;
  }
  return `<span class="av av-initial" style="--sz:${size}px;--c:${esc(user.color)}" title="${esc(user.name)}">${esc(initial(user.name))}</span>`;
}

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

function fmtWhen(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const mins = Math.floor((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}시간 전`;
  if (mins < 60 * 24 * 7) return `${Math.floor(mins / 1440)}일 전`;
  return then.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}

function pad2(n) { return String(n).padStart(2, '0'); }

let toastTimer = null;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ───────── API ───────── */

async function api(path, { method = 'GET', body, form } = {}) {
  const options = { method, headers: {} };
  if (form) {
    options.body = form;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  if (res.status === 204) return null;

  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }

  if (!res.ok) {
    if (res.status === 401) { state.me = null; showGate('code'); }
    const err = new Error((data && data.detail) || `요청에 실패했습니다 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function uploadWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* noop */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.detail) || `업로드 실패 (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('업로드 중 연결이 끊겼습니다.')));
    xhr.send(form);
  });
}

/* ───────── 테마 ───────── */

function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  localStorage.setItem('sb-theme', name);
  $$('.theme-btn').forEach((b) => { b.textContent = name === 'dark' ? '☀' : '☾'; });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'theme') {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }
  if (btn.dataset.act === 'logout') logout();
});

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.me = null;
  state.board = null;
  showGate('code');
}

/* ───────── 화면 전환 ───────── */

function showView(id) {
  $$('.view').forEach((v) => { v.hidden = v.id !== id; });
}

function showGate(step = 'code') {
  stopPolling();
  showView('view-gate');
  $('#form-code').hidden = step !== 'code';
  $('#step-profile').hidden = step !== 'profile';
  if (step === 'code') setTimeout(() => $('#input-code').focus(), 30);
}

/* ───────── 로그인 ───────── */

function renderColorRow() {
  $('#color-row').innerHTML = COLORS.map((c) => (
    `<button type="button" class="swatch" style="--c:${c}" data-color="${c}"
       aria-label="색 ${c}" aria-pressed="${c === state.newProfile.color}"></button>`
  )).join('');
}

function syncAvatarPreview() {
  const preview = $('#avatar-preview');
  const { color, file } = state.newProfile;
  if (file) {
    preview.outerHTML = `<img id="avatar-preview" class="av" style="--sz:56px" src="${URL.createObjectURL(file)}" alt="">`;
  } else {
    const name = $('#input-name').value.trim();
    preview.outerHTML = `<span id="avatar-preview" class="av av-initial" style="--sz:56px;--c:${color}">${esc(name ? initial(name) : '?')}</span>`;
  }
}

async function renderProfiles() {
  let profiles = [];
  try { profiles = await api('/api/profiles'); } catch { profiles = []; }

  $('#profile-list').innerHTML = profiles.length
    ? `<p class="field-label">누구세요?</p>` + profiles.map((p) => (
        `<button type="button" class="profile-btn" data-id="${p.id}">
           ${avatarHTML(p, 32)}<b>${esc(p.name)}</b>
         </button>`
      )).join('')
    : '';

  $('#form-profile').classList.toggle('solo', profiles.length === 0);
  $('#new-profile-label').textContent = profiles.length ? '새로 만들기' : '이름 정하기';
}

function bindGate() {
  $('#form-code').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#err-code');
    err.hidden = true;
    try {
      await api('/api/gate', { method: 'POST', body: { code: $('#input-code').value.trim() } });
      await renderProfiles();
      renderColorRow();
      syncAvatarPreview();
      showGate('profile');
      $('#input-name').focus();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  $('#profile-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.profile-btn');
    if (!btn) return;
    const form = new FormData();
    form.append('profile_id', btn.dataset.id);
    try {
      state.me = await api('/api/login', { method: 'POST', form });
      await openBoards();
    } catch (ex) { toast(ex.message, true); }
  });

  $('#color-row').addEventListener('click', (e) => {
    const swatch = e.target.closest('.swatch');
    if (!swatch) return;
    state.newProfile.color = swatch.dataset.color;
    renderColorRow();
    syncAvatarPreview();
  });

  $('#avatar-pick').addEventListener('click', () => $('#avatar-file').click());
  $('#avatar-file').addEventListener('change', (e) => {
    state.newProfile.file = e.target.files[0] || null;
    syncAvatarPreview();
  });
  $('#input-name').addEventListener('input', () => {
    if (!state.newProfile.file) syncAvatarPreview();
  });

  $('#form-profile').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#err-profile');
    err.hidden = true;
    const name = $('#input-name').value.trim();
    if (!name) { err.textContent = '이름을 입력해 주세요.'; err.hidden = false; return; }

    const form = new FormData();
    form.append('name', name);
    form.append('color', state.newProfile.color);
    if (state.newProfile.file) form.append('avatar', state.newProfile.file);
    try {
      state.me = await api('/api/login', { method: 'POST', form });
      await openBoards();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

function renderMeChips() {
  const html = state.me
    ? `${avatarHTML(state.me, 28)}<span class="name">${esc(state.me.name)}</span>
       <button class="btn btn-ghost btn-sm" data-act="logout">나가기</button>`
    : '';
  $$('.me-chip').forEach((chip) => { chip.innerHTML = html; });
}

/* ───────── 보드 목록 ───────── */

async function openBoards() {
  stopPolling();
  state.board = null;
  selection.clear();
  renderMeChips();
  showView('view-boards');
  await Promise.all([loadBoards(), loadStorageNote()]);
}

async function loadStorageNote() {
  try {
    const info = await api('/api/storage');
    $('#storage-note').textContent = info.backend === 'local'
      ? `로컬 저장 ${fmtBytes(info.used_bytes)} · 여유 ${fmtBytes(info.free_bytes)}`
      : `저장소 ${info.backend}`;
  } catch { $('#storage-note').textContent = ''; }
}

async function loadBoards() {
  state.boards = await api('/api/boards');
  const grid = $('#board-grid');
  if (!state.boards.length) {
    grid.innerHTML = `<div class="empty-state">아직 보드가 없습니다. <b>새 보드</b>로 시작하세요.</div>`;
    return;
  }
  grid.innerHTML = state.boards.map((b) => {
    let cover = `<span class="none">빈 보드</span>`;
    if (b.cover_url && b.cover_kind === 'image') {
      cover = `<img src="${esc(b.cover_url)}" alt="" loading="lazy">`;
    } else if (b.cover_url) {
      cover = `<video src="${esc(b.cover_url)}#t=0.1" preload="metadata" muted playsinline></video>`;
    }
    return `<button class="board-card" data-id="${b.id}">
      <div class="board-cover">${cover}</div>
      <div class="board-card-body">
        <h3>${esc(b.title)}</h3>
        <div class="sub">${b.scene_count}개 프레임 · ${esc(fmtWhen(b.updated_at))}</div>
      </div>
    </button>`;
  }).join('');
}

function bindBoards() {
  $('#btn-new-board').addEventListener('click', () => {
    const form = $('#form-new-board');
    form.hidden = !form.hidden;
    if (!form.hidden) $('#input-board-title').focus();
  });
  $('#btn-cancel-board').addEventListener('click', () => { $('#form-new-board').hidden = true; });

  $('#form-new-board').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#input-board-title').value.trim();
    const scenes = Number($('#input-board-scenes').value) || 0;
    try {
      const board = await api('/api/boards', { method: 'POST', body: { title, scenes } });
      $('#input-board-title').value = '';
      $('#form-new-board').hidden = true;
      await openBoard(board.id);
    } catch (ex) { toast(ex.message, true); }
  });

  $('#board-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.board-card');
    if (card) openBoard(Number(card.dataset.id));
  });

  $('#btn-back').addEventListener('click', openBoards);

  $('#board-title').addEventListener('change', async (e) => {
    const title = e.target.value.trim();
    if (!title || !state.board) return;
    try {
      await api(`/api/boards/${state.board.id}`, { method: 'PATCH', body: { title } });
      state.board.title = title;
    } catch (ex) { toast(ex.message, true); }
  });
  $('#board-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  $('#btn-delete-board').addEventListener('click', async () => {
    if (!state.board) return;
    if (!confirm(`"${state.board.title}" 보드를 지웁니다. 프레임과 올린 파일이 전부 사라집니다.`)) return;
    try {
      await api(`/api/boards/${state.board.id}`, { method: 'DELETE' });
      toast('보드를 지웠습니다.');
      await openBoards();
    } catch (ex) { toast(ex.message, true); }
  });

  $('#btn-add-scene').addEventListener('click', () => addSceneAt(null));
}

/* ───────── 보드 열기 / 데이터 ───────── */

async function openBoard(id) {
  showView('view-board');
  renderMeChips();
  selection.clear();
  state.board = { id, title: '', scenes: [] };
  await refreshBoard(true);
  fitToContent();
  startPolling();
}

async function refreshBoard(force = false) {
  if (!state.board) return;
  let data;
  try {
    data = await api(`/api/boards/${state.board.id}`);
  } catch (ex) {
    if (ex.status === 404) { toast('보드를 찾을 수 없습니다.', true); await openBoards(); }
    return;
  }
  const snapshot = JSON.stringify(data);
  if (!force && snapshot === state.boardSnapshot) return;
  state.boardSnapshot = snapshot;
  state.board = data;
  state.order = readingOrder(data.scenes);

  if (document.activeElement !== $('#board-title')) $('#board-title').value = data.title;
  $('#board-count').textContent = `${data.scenes.length} FRAMES`;

  // 사라진 프레임은 선택에서 뺀다
  const alive = new Set(data.scenes.map((s) => s.id));
  [...selection].forEach((id) => { if (!alive.has(id)) selection.delete(id); });

  renderCanvas();
  if (state.sceneId && !$('#modal').hidden) renderModal();
}

/** 놓인 위치대로 번호를 매긴다: 윗줄 → 아랫줄, 각 줄은 왼쪽 → 오른쪽. */
function readingOrder(scenes) {
  const rows = [];
  for (const scene of [...scenes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.top - scene.y) < FRAME_H * 0.6);
    if (row) row.items.push(scene);
    else rows.push({ top: scene.y, items: [scene] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

function indexOfScene(id) {
  return state.order.findIndex((s) => s.id === id);
}

function findScene(id) {
  return state.board && state.board.scenes.find((s) => s.id === id);
}

/** 배치가 바뀌어 읽기 순서가 달라졌으면 서버에도 알려 준다. */
async function syncOrder() {
  const next = readingOrder(state.board.scenes);
  state.order = next;
  // 드래그 중에 state.order 는 이미 갱신돼 있으므로, 서버가 알고 있는 순서(position)와 비교한다.
  const known = [...state.board.scenes].sort((a, b) => a.position - b.position).map((s) => s.id).join(',');
  const after = next.map((s) => s.id).join(',');
  if (known === after) return;
  try {
    await api(`/api/boards/${state.board.id}/order`, {
      method: 'PUT', body: { ids: next.map((s) => s.id) },
    });
  } catch (ex) { toast(ex.message, true); }
}

/* ───────── 캔버스 그리기 ───────── */

function applyTransform() {
  $('#world').style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`;
  $('.hud-level').textContent = `${Math.round(view.z * 100)}%`;
}

function frameHTML(scene, index) {
  const no = `SC ${pad2(index + 1)}`;
  const count = scene.comment_count || 0;

  let inner;
  if (scene.media_kind === 'image') {
    inner = `<img src="${esc(scene.media_url)}" alt="" loading="lazy">
             <span class="frame-veil"></span>
             <button class="frame-open" data-open="${scene.id}" title="크게 보기">⤢</button>`;
  } else if (scene.media_kind === 'video') {
    inner = `<video src="${esc(scene.media_url)}#t=0.1" preload="metadata" muted playsinline></video>
             <span class="frame-veil"></span>
             <button class="frame-open" data-open="${scene.id}" title="재생">▶</button>`;
  } else {
    inner = `<span class="copy">더블클릭하거나<br>파일을 끌어다 놓기</span>`;
  }

  return `<div class="frame-node${selection.has(scene.id) ? ' selected' : ''}"
               data-id="${scene.id}"
               style="left:${scene.x}px; top:${scene.y - LABEL_H}px">
    <div class="frame-label">
      <span class="no">${no}</span>
      <span class="nm${scene.title ? '' : ' blank'}">${esc(scene.title || '제목 없음')}</span>
      ${count ? `<span class="badge" title="코멘트 ${count}개">${count}</span>` : ''}
    </div>
    <div class="frame-box${scene.media_kind ? '' : ' empty'}">${inner}</div>
  </div>`;
}

function renderCanvas() {
  $('#frames').innerHTML = state.order.map(frameHTML).join('');
  renderLinks();
  $('#canvas-empty').hidden = state.board.scenes.length > 0;
  renderSelectionPanel();
  applyTransform();
}

/** 꺾이는 지점을 둥글려 주는 폴리라인. */
function roundedPath(points, radius = 10) {
  if (points.length < 3) {
    return `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`;
  }
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(px - cx, py - cy) || 1;
    const outLen = Math.hypot(nx - cx, ny - cy) || 1;
    const r1 = Math.min(radius, inLen / 2);
    const r2 = Math.min(radius, outLen / 2);
    const sx = cx + ((px - cx) / inLen) * r1;
    const sy = cy + ((py - cy) / inLen) * r1;
    const ex = cx + ((nx - cx) / outLen) * r2;
    const ey = cy + ((ny - cy) / outLen) * r2;
    d += ` L ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx} ${cy} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d} L ${lx} ${ly}`;
}

/** 프레임을 잇는 연결선. 참고 화면처럼 양 끝에 작은 동그라미를 둔다. */
function renderLinks() {
  const svg = $('#links');
  const parts = [];

  for (let i = 0; i < state.order.length - 1; i += 1) {
    const a = state.order[i];
    const b = state.order[i + 1];
    const ax = a.x + FRAME_W + 6;      // 시작점 (오른쪽 가장자리 바깥)
    const ay = a.y + FRAME_H / 2;
    const bx = b.x - 6;                // 끝점 (왼쪽 가장자리 바깥)
    const by = b.y + FRAME_H / 2;

    let points;
    if (Math.abs(ay - by) < 2 && bx > ax) {
      points = [[ax, ay], [bx, by]];                     // 같은 줄 — 곧게
    } else {
      // 줄이 바뀌면 두 줄 사이 빈 공간으로 돌아 들어간다
      const rowBottom = a.y + FRAME_H;
      const nextTop = b.y - LABEL_H;
      const midY = nextTop > rowBottom ? (rowBottom + nextTop) / 2 : (ay + by) / 2;
      const outX = ax + 28;
      const inX = bx - 28;
      points = [[ax, ay], [outX, ay], [outX, midY], [inX, midY], [inX, by], [bx, by]];
    }

    parts.push(`<path class="link-line" d="${roundedPath(points)}"/>`);
    parts.push(`<circle class="link-dot" cx="${ax}" cy="${ay}" r="4"/>`);
    parts.push(`<circle class="link-dot" cx="${bx}" cy="${by}" r="4"/>`);
  }
  svg.innerHTML = parts.join('');
}

/** 드래그 중에는 통째로 다시 그리지 않고 위치만 옮긴다. */
function moveNode(id, x, y) {
  const node = $(`.frame-node[data-id="${id}"]`);
  if (!node) return;
  node.style.left = `${x}px`;
  node.style.top = `${y - LABEL_H}px`;
}

/* 화면 좌표 → 월드 좌표 */
function toWorld(clientX, clientY) {
  const rect = $('#viewport').getBoundingClientRect();
  return {
    x: (clientX - rect.left - view.tx) / view.z,
    y: (clientY - rect.top - view.ty) / view.z,
  };
}

function zoomAt(factor, clientX, clientY) {
  const rect = $('#viewport').getBoundingClientRect();
  const px = clientX === undefined ? rect.width / 2 : clientX - rect.left;
  const py = clientY === undefined ? rect.height / 2 : clientY - rect.top;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.z * factor));
  const ratio = next / view.z;
  view.tx = px - (px - view.tx) * ratio;
  view.ty = py - (py - view.ty) * ratio;
  view.z = next;
  applyTransform();
}

/** 휠 이벤트 단위(픽셀/줄/페이지)를 픽셀로 맞춘다. */
function normalizeDelta(e, axis = 'y') {
  const raw = axis === 'x' ? e.deltaX : e.deltaY;
  if (e.deltaMode === 1) return raw * 16;      // 줄 단위
  if (e.deltaMode === 2) return raw * 400;     // 페이지 단위
  return raw;
}

/**
 * 트랙패드 두 손가락 스크롤인지 어림한다.
 * 마우스 휠은 한 칸씩 큼직하게(보통 100 이상) 세로로만 굴러가고,
 * 트랙패드는 잘게·소수점으로·가로 성분까지 같이 들어온다.
 */
function looksLikeTrackpad(e) {
  if (e.deltaMode !== 0) return false;
  if (e.deltaX !== 0) return true;
  if (!Number.isInteger(e.deltaY)) return true;
  return Math.abs(e.deltaY) < 40;
}

function renderWheelMode() {
  const label = { auto: '휠 자동', zoom: '휠 확대', pan: '휠 이동' }[wheelMode];
  const btn = $('#btn-wheel-mode');
  if (btn) btn.textContent = label;

  const hint = $('#canvas-hint');
  if (hint) {
    const mod = IS_MAC ? '⌘' : 'Ctrl';
    const wheelSays = {
      auto: '휠 확대',
      zoom: '휠 확대',
      pan: `<kbd>${mod}</kbd>+휠 확대`,
    }[wheelMode];
    hint.innerHTML = `${wheelSays} · 빈 곳 끌어 선택 · <kbd>Space</kbd>+끌기로 화면 이동`;
  }
}

function fitToContent() {
  const scenes = state.board ? state.board.scenes : [];
  const rect = $('#viewport').getBoundingClientRect();
  if (!scenes.length || !rect.width) {
    view.tx = 80; view.ty = 60; view.z = 1;
    applyTransform();
    return;
  }
  const minX = Math.min(...scenes.map((s) => s.x));
  const minY = Math.min(...scenes.map((s) => s.y - LABEL_H));
  const maxX = Math.max(...scenes.map((s) => s.x + FRAME_W));
  const maxY = Math.max(...scenes.map((s) => s.y + FRAME_H));
  const pad = 70;
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
    Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY), 1)));
  view.z = z;
  view.tx = (rect.width - (maxX - minX) * z) / 2 - minX * z;
  view.ty = (rect.height - (maxY - minY) * z) / 2 - minY * z;
  applyTransform();
}

/* ───────── 선택 ───────── */

function renderSelectionPanel() {
  const panel = $('#selection-panel');
  const chosen = state.order.filter((s) => selection.has(s.id));
  panel.hidden = chosen.length === 0;
  if (!chosen.length) return;

  const videos = chosen.filter((s) => s.media_kind === 'video').length;
  const images = chosen.filter((s) => s.media_kind === 'image').length;
  const empty = chosen.length - videos - images;

  $('#sel-n').textContent = chosen.length;
  $('#sel-sub').textContent = [
    videos ? `영상 ${videos}` : '',
    images ? `이미지 ${images}` : '',
    empty ? `빈 프레임 ${empty}` : '',
  ].filter(Boolean).join(' · ');
  $('#btn-play-seq').disabled = videos + images === 0;
}

function setSelection(ids) {
  selection.clear();
  ids.forEach((id) => selection.add(id));
  $$('.frame-node').forEach((n) => n.classList.toggle('selected', selection.has(Number(n.dataset.id))));
  renderSelectionPanel();
}

function toggleSelection(id, additive) {
  if (!additive) {
    const only = selection.size === 1 && selection.has(id);
    setSelection(only ? [] : [id]);
    return;
  }
  if (selection.has(id)) selection.delete(id); else selection.add(id);
  setSelection([...selection]);
}

/* ───────── 캔버스 조작 ───────── */

let spaceHeld = false;

function bindCanvas() {
  const viewport = $('#viewport');

  /* 확대 / 이동 (휠 · 트랙패드) */
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();

    // 트랙패드 핀치와 Ctrl+휠은 브라우저가 똑같이 ctrlKey 로 준다 → 언제나 확대
    if (e.ctrlKey || e.metaKey) {
      zoomAt(Math.exp(-normalizeDelta(e) * 0.0022), e.clientX, e.clientY);
      return;
    }
    if (e.shiftKey) {                       // Shift+휠 = 가로 이동
      view.tx -= normalizeDelta(e);
      applyTransform();
      return;
    }

    const zoom = wheelMode === 'zoom' || (wheelMode === 'auto' && !looksLikeTrackpad(e));
    if (zoom) {
      zoomAt(Math.exp(-normalizeDelta(e) * 0.0022), e.clientX, e.clientY);
    } else {
      view.tx -= normalizeDelta(e, 'x');
      view.ty -= normalizeDelta(e, 'y');
      applyTransform();
    }
  }, { passive: false });

  $('#btn-wheel-mode').addEventListener('click', () => {
    wheelMode = { auto: 'zoom', zoom: 'pan', pan: 'auto' }[wheelMode];
    localStorage.setItem('sb-wheel', wheelMode);
    renderWheelMode();
  });
  renderWheelMode();

  /* HUD */
  $('.hud').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-zoom]');
    if (!btn) return;
    const kind = btn.dataset.zoom;
    if (kind === 'in') zoomAt(1.25);
    if (kind === 'out') zoomAt(1 / 1.25);
    if (kind === 'fit') fitToContent();
    if (kind === 'reset') { view.z = 1; applyTransform(); }
  });

  /* 스페이스를 누르면 화면 끌기 */
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTyping() && !spaceHeld) {
      spaceHeld = true;
      viewport.classList.add('space-ready');
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceHeld = false; viewport.classList.remove('space-ready'); }
  });

  /* 포인터: 화면 끌기 / 마키 선택 / 프레임 옮기기 */
  let mode = null;              // 'pan' | 'marquee' | 'drag'
  let start = null;
  let dragging = null;          // { id, ox, oy } 목록
  let moved = false;

  /* 손가락 두 개로 오므리기 / 벌리기 */
  const touches = new Map();
  let pinch = null;

  const cancelGesture = async () => {
    const wasDragging = mode === 'drag' && moved;
    mode = null;
    viewport.classList.remove('panning');
    $$('.frame-node.dragging').forEach((n) => n.classList.remove('dragging'));
    $('#marquee').hidden = true;
    state.busy = false;
    if (wasDragging) await refreshBoard(true);   // 옮기던 건 되돌린다
  };

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;

    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        cancelGesture();
        const [a, b] = [...touches.values()];
        pinch = {
          dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        return;
      }
      if (touches.size > 2) return;
    }
    if (pinch) return;

    const node = e.target.closest('.frame-node');
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) return;        // 열기 버튼은 click 으로 처리

    start = { x: e.clientX, y: e.clientY, world: toWorld(e.clientX, e.clientY) };
    moved = false;

    if (spaceHeld || e.button === 1 || e.altKey) {
      mode = 'pan';
      start.tx = view.tx; start.ty = view.ty;
      viewport.classList.add('panning');
    } else if (node) {
      mode = 'drag';
      const id = Number(node.dataset.id);
      if (!selection.has(id)) setSelection(e.shiftKey ? [...selection, id] : [id]);
      dragging = [...selection].map((sid) => {
        const scene = findScene(sid);
        return scene ? { id: sid, ox: scene.x - start.world.x, oy: scene.y - start.world.y } : null;
      }).filter(Boolean);
      $$('.frame-node').forEach((n) => n.classList.toggle('dragging', selection.has(Number(n.dataset.id))));
      state.busy = true;
    } else {
      mode = 'marquee';
      state.busy = true;
    }
    viewport.setPointerCapture(e.pointerId);
  });

  viewport.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // 손가락을 벌린 만큼 확대하고, 두 손가락이 움직인 만큼 화면도 따라 옮긴다
      view.tx += mid.x - pinch.mid.x;
      view.ty += mid.y - pinch.mid.y;
      applyTransform();
      zoomAt(dist / pinch.dist, mid.x, mid.y);
      pinch = { dist, mid };
      return;
    }
    if (!mode) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) > 4) moved = true;

    if (mode === 'pan') {
      view.tx = start.tx + dx;
      view.ty = start.ty + dy;
      applyTransform();
    } else if (mode === 'drag' && moved) {
      const world = toWorld(e.clientX, e.clientY);
      for (const item of dragging) {
        const scene = findScene(item.id);
        if (!scene) continue;
        scene.x = Math.round((world.x + item.ox) / GRID) * GRID;
        scene.y = Math.round((world.y + item.oy) / GRID) * GRID;
        moveNode(item.id, scene.x, scene.y);
      }
      state.order = readingOrder(state.board.scenes);
      renderLinks();
    } else if (mode === 'marquee' && moved) {
      drawMarquee(start, { x: e.clientX, y: e.clientY });
    }
  });

  viewport.addEventListener('pointerup', async (e) => {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    }
    if (!mode) return;
    const finished = mode;
    const wasMoved = moved;
    mode = null;
    viewport.classList.remove('panning');
    $$('.frame-node.dragging').forEach((n) => n.classList.remove('dragging'));
    $('#marquee').hidden = true;
    state.busy = false;

    if (finished === 'marquee') {
      if (wasMoved) {
        const a = start.world;
        const b = toWorld(e.clientX, e.clientY);
        const box = {
          x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y),
          x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y),
        };
        setSelection(state.board.scenes.filter((s) => (
          s.x < box.x2 && s.x + FRAME_W > box.x1 && s.y < box.y2 && s.y + FRAME_H > box.y1
        )).map((s) => s.id));
      } else {
        setSelection([]);       // 빈 곳 클릭 = 선택 해제
      }
      return;
    }

    if (finished === 'drag') {
      const node = e.target.closest('.frame-node');
      if (!wasMoved) {
        const id = node ? Number(node.dataset.id) : null;
        if (id !== null) toggleSelection(id, e.shiftKey);
        return;
      }
      // 옮긴 자리를 저장하고, 바뀐 읽기 순서를 반영한다
      const moves = dragging.map((item) => findScene(item.id)).filter(Boolean);
      try {
        await Promise.all(moves.map((s) => api(`/api/scenes/${s.id}`, {
          method: 'PATCH', body: { x: s.x, y: s.y },
        })));
        await syncOrder();
        await refreshBoard(true);
      } catch (ex) {
        toast(ex.message, true);
        await refreshBoard(true);
      }
    }
  });

  viewport.addEventListener('pointercancel', (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    mode = null;
    state.busy = false;
    $('#marquee').hidden = true;
    viewport.classList.remove('panning');
  });

  /* 프레임 열기 */
  viewport.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) { openModal(Number(openBtn.dataset.open)); }
  });

  viewport.addEventListener('dblclick', (e) => {
    const node = e.target.closest('.frame-node');
    if (!node) return;
    const scene = findScene(Number(node.dataset.id));
    if (!scene) return;
    if (scene.media_url) openModal(scene.id);
    else pickFileFor(scene.id);
  });

  /* 파일 끌어다 놓기 */
  viewport.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const node = e.target.closest('.frame-node');
    if (node) node.classList.add('file-over');
    else viewport.classList.add('file-over');
  });
  viewport.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  viewport.addEventListener('dragleave', (e) => {
    const node = e.target.closest('.frame-node');
    if (node && !node.contains(e.relatedTarget)) node.classList.remove('file-over');
    if (!viewport.contains(e.relatedTarget)) viewport.classList.remove('file-over');
  });
  viewport.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    $$('.frame-node.file-over').forEach((n) => n.classList.remove('file-over'));
    viewport.classList.remove('file-over');

    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const node = e.target.closest('.frame-node');
    if (node) await spreadFiles(Number(node.dataset.id), files);
    else await dropOnEmptyCanvas(toWorld(e.clientX, e.clientY), files);
  });

  /* 선택 패널 */
  $('#btn-clear-sel').addEventListener('click', () => setSelection([]));
  $('#btn-play-seq').addEventListener('click', () => {
    playSequence(state.order.filter((s) => selection.has(s.id)));
  });
}

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

function isFileDrag(e) {
  return e.dataTransfer && [...e.dataTransfer.types].includes('Files');
}

function drawMarquee(from, to) {
  const rect = $('#viewport').getBoundingClientRect();
  const box = $('#marquee');
  box.hidden = false;
  box.style.left = `${Math.min(from.x, to.x) - rect.left}px`;
  box.style.top = `${Math.min(from.y, to.y) - rect.top}px`;
  box.style.width = `${Math.abs(to.x - from.x)}px`;
  box.style.height = `${Math.abs(to.y - from.y)}px`;
}

/* ───────── 프레임 추가 / 업로드 ───────── */

let pendingSceneId = null;

async function addSceneAt(world, count = 1) {
  if (!state.board) return null;
  const body = { count };
  if (world) { body.x = Math.round(world.x / GRID) * GRID; body.y = Math.round(world.y / GRID) * GRID; }
  try {
    const created = await api(`/api/boards/${state.board.id}/scenes`, { method: 'POST', body });
    await refreshBoard(true);
    return created.ids;
  } catch (ex) {
    toast(ex.message, true);
    return null;
  }
}

async function dropOnEmptyCanvas(world, files) {
  const ids = await addSceneAt({ x: world.x - FRAME_W / 2, y: world.y - FRAME_H / 2 }, files.length);
  if (!ids) return;
  for (let i = 0; i < files.length; i += 1) await uploadToScene(ids[i], files[i]);
  await syncOrder();
  await refreshBoard(true);
}

function pickFileFor(sceneId) {
  pendingSceneId = sceneId;
  $('#media-file').click();
}

/** 프레임 위에 여러 개를 떨어뜨리면 읽기 순서대로 이어서 채운다. */
async function spreadFiles(startSceneId, files) {
  const from = indexOfScene(startSceneId);
  if (from < 0) return;

  const targets = [];
  for (let i = 0; i < files.length; i += 1) {
    const scene = state.order[from + i];
    targets.push(scene ? scene.id : null);
  }

  const shortfall = targets.filter((t) => t === null).length;
  if (shortfall > 0) {
    const last = state.order[state.order.length - 1];
    const ids = await addSceneAt(
      last ? { x: last.x + FRAME_W + 120, y: last.y } : null, shortfall);
    if (!ids) return;
    let k = 0;
    for (let i = 0; i < targets.length; i += 1) {
      if (targets[i] === null) { targets[i] = ids[k]; k += 1; }
    }
  }

  for (let i = 0; i < files.length; i += 1) await uploadToScene(targets[i], files[i]);
  await refreshBoard(true);
  await loadStorageNote();
}

async function uploadToScene(sceneId, file) {
  const node = $(`.frame-node[data-id="${sceneId}"] .frame-box`);
  let bar = null;
  if (node) {
    bar = document.createElement('div');
    bar.className = 'upload-bar';
    bar.innerHTML = '<i></i>';
    node.appendChild(bar);
  }
  state.uploading.add(sceneId);

  try {
    await uploadWithProgress(`/api/scenes/${sceneId}/media`, file, (ratio) => {
      if (bar) $('i', bar).style.width = `${Math.round(ratio * 100)}%`;
    });
  } catch (ex) {
    toast(ex.message, true);
    if (bar) bar.remove();
  } finally {
    state.uploading.delete(sceneId);
  }
}

function bindFileInput() {
  $('#media-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file && pendingSceneId) {
      await uploadToScene(pendingSceneId, file);
      await refreshBoard(true);
      await loadStorageNote();
    }
    pendingSceneId = null;
  });
}

/* ───────── 프레임 상세 모달 ───────── */

function openModal(sceneId) {
  state.sceneId = sceneId;
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  renderModal();
  loadComments();
}

function closeModal() {
  $('#modal').hidden = true;
  const stage = $('#modal-media');
  stage.innerHTML = '';          // 재생 중인 영상을 멈춘다
  delete stage.dataset.src;      // 같은 프레임을 다시 열어도 다시 그려지도록
  state.sceneId = null;
  document.body.style.overflow = '';
}

function renderModal() {
  const scene = findScene(state.sceneId);
  if (!scene) { closeModal(); return; }
  const no = `SC ${pad2(indexOfScene(scene.id) + 1)}`;

  $('#modal-slate').textContent = no;
  $('#modal-file').textContent = scene.media_name
    ? `${scene.media_name} · ${fmtBytes(scene.media_size)}`
    : '파일 없음';

  const stage = $('#modal-media');
  const signature = scene.media_url || '';
  if (stage.dataset.src !== signature) {
    stage.dataset.src = signature;
    if (scene.media_kind === 'video') {
      stage.innerHTML = `<video src="${esc(scene.media_url)}" controls autoplay playsinline preload="metadata"></video>`;
    } else if (scene.media_kind === 'image') {
      stage.innerHTML = `<img src="${esc(scene.media_url)}" alt="${esc(scene.title || no)}">`;
    } else {
      stage.innerHTML = `<div class="placeholder">이 프레임은 비어 있습니다.<br><br>
        <button class="btn btn-quiet btn-sm" data-pick="1">파일 넣기</button></div>`;
    }
  }

  if (document.activeElement !== $('#modal-title')) $('#modal-title').value = scene.title;
  if (document.activeElement !== $('#modal-note')) $('#modal-note').value = scene.note;

  $('#btn-clear-media').hidden = !scene.media_url;
  $('#composer-av').innerHTML = avatarHTML(state.me, 28);
}

async function loadComments() {
  const sceneId = state.sceneId;
  if (!sceneId) return;
  let comments = [];
  try { comments = await api(`/api/scenes/${sceneId}/comments`); } catch { return; }
  if (state.sceneId !== sceneId) return;

  const list = $('#comment-list');
  if (!comments.length) {
    list.innerHTML = `<p class="comment-empty">아직 코멘트가 없습니다.</p>`;
    return;
  }
  list.innerHTML = comments.map((c) => `
    <div class="comment">
      ${avatarHTML(c.author, 30)}
      <div class="comment-body">
        <div class="comment-head">
          <b>${esc(c.author.name)}</b>
          <time datetime="${esc(c.created_at)}">${esc(fmtWhen(c.created_at))}</time>
          ${state.me && c.author.id === state.me.id
            ? `<button class="del" data-comment="${c.id}" title="지우기">지우기</button>` : ''}
        </div>
        <div class="comment-text">${esc(c.body)}</div>
      </div>
    </div>`).join('');
}

function stepScene(delta) {
  const i = indexOfScene(state.sceneId);
  const next = state.order[i + delta];
  if (!next) return;
  state.sceneId = next.id;
  renderModal();
  loadComments();
}

function bindModal() {
  $('#btn-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#btn-prev').addEventListener('click', () => stepScene(-1));
  $('#btn-next').addEventListener('click', () => stepScene(1));

  const saveScene = async () => {
    const scene = findScene(state.sceneId);
    if (!scene) return;
    const title = $('#modal-title').value;
    const note = $('#modal-note').value;
    if (title === scene.title && note === scene.note) return;
    try {
      const updated = await api(`/api/scenes/${scene.id}`, { method: 'PATCH', body: { title, note } });
      Object.assign(scene, updated);
      renderCanvas();
    } catch (ex) { toast(ex.message, true); }
  };
  $('#modal-title').addEventListener('change', saveScene);
  $('#modal-note').addEventListener('change', saveScene);

  $('#btn-replace').addEventListener('click', () => pickFileFor(state.sceneId));
  $('#modal-media').addEventListener('click', (e) => {
    if (e.target.closest('[data-pick]')) pickFileFor(state.sceneId);
  });

  $('#btn-clear-media').addEventListener('click', async () => {
    const scene = findScene(state.sceneId);
    if (!scene || !confirm('이 프레임의 파일을 지웁니다.')) return;
    try {
      await api(`/api/scenes/${scene.id}/media`, { method: 'DELETE' });
      delete $('#modal-media').dataset.src;
      await refreshBoard(true);
      await loadStorageNote();
    } catch (ex) { toast(ex.message, true); }
  });

  $('#btn-delete-scene').addEventListener('click', async () => {
    const scene = findScene(state.sceneId);
    if (!scene || !confirm('이 프레임을 지웁니다. 코멘트도 함께 사라집니다.')) return;
    try {
      await api(`/api/scenes/${scene.id}`, { method: 'DELETE' });
      closeModal();
      await refreshBoard(true);
    } catch (ex) { toast(ex.message, true); }
  });

  const input = $('#input-comment');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#form-comment').requestSubmit();
    }
  });

  $('#form-comment').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body || !state.sceneId) return;
    try {
      await api(`/api/scenes/${state.sceneId}/comments`, { method: 'POST', body: { body } });
      input.value = '';
      input.style.height = 'auto';
      await loadComments();
      const box = $('.side-comments');
      box.scrollTop = box.scrollHeight;
      await refreshBoard(true);
    } catch (ex) { toast(ex.message, true); }
  });

  $('#comment-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.del');
    if (!btn) return;
    try {
      await api(`/api/comments/${btn.dataset.comment}`, { method: 'DELETE' });
      await loadComments();
      await refreshBoard(true);
    } catch (ex) { toast(ex.message, true); }
  });
}

/* ───────── 선택한 프레임 이어서 재생 ───────── */

const player = { list: [], i: 0, playing: false, timer: null, raf: null, start: 0, muted: false };

/**
 * 사파리를 비롯한 브라우저는 소리 있는 영상의 자동 재생을 막는다.
 * 막히면 음소거로 한 번 더 시도해서 재생이 끊기지 않게 한다.
 */
function playVideo(video, onBlocked) {
  video.muted = player.muted;
  video.play().catch(() => {
    video.muted = true;
    player.muted = true;
    renderSoundButton();
    video.play().then(() => {
      toast('브라우저가 소리 자동재생을 막아 음소거로 재생합니다. 🔊 를 누르면 소리가 켜집니다.');
    }).catch(onBlocked);
  });
}

function renderSoundButton() {
  const btn = $('#pl-sound');
  if (btn) {
    btn.textContent = player.muted ? '🔇' : '🔊';
    btn.title = player.muted ? '소리 켜기' : '소리 끄기';
  }
}

function playSequence(scenes) {
  const list = scenes.filter((s) => s.media_url);
  if (!list.length) { toast('선택한 프레임에 넣은 파일이 없습니다.', true); return; }

  player.list = list;
  player.i = 0;
  $('#player').hidden = false;
  document.body.style.overflow = 'hidden';
  renderSoundButton();

  $('#pl-strip').innerHTML = list.map((s, i) => {
    const no = pad2(indexOfScene(s.id) + 1);
    const thumb = s.media_kind === 'image'
      ? `<img src="${esc(s.media_url)}" alt="">`
      : `<video src="${esc(s.media_url)}#t=0.1" preload="metadata" muted playsinline></video>`;
    return `<button class="player-thumb" data-i="${i}" title="SC ${no}">${thumb}<span class="no">${no}</span></button>`;
  }).join('');

  playAt(0);
}

function stopClock() {
  clearTimeout(player.timer);
  player.timer = null;
  cancelAnimationFrame(player.raf);
  player.raf = null;
}

function playAt(index) {
  stopClock();
  if (index < 0 || index >= player.list.length) return;
  player.i = index;
  player.playing = true;

  const scene = player.list[index];
  const stage = $('#player-stage');
  const no = pad2(indexOfScene(scene.id) + 1);

  $('#pl-now').textContent = `SC ${no} · ${index + 1}/${player.list.length}`;
  $$('.player-thumb').forEach((t) => t.classList.toggle('on', Number(t.dataset.i) === index));
  $$('.player-thumb')[index]?.scrollIntoView({ block: 'nearest', inline: 'center' });
  $('#pl-toggle').textContent = '❚❚';

  if (scene.media_kind === 'video') {
    stage.innerHTML = `<video src="${esc(scene.media_url)}" autoplay playsinline></video>`;
    const video = $('video', stage);
    video.addEventListener('timeupdate', () => {
      if (video.duration) setProgress(video.currentTime / video.duration);
    });
    video.addEventListener('ended', () => advance());
    video.addEventListener('error', () => {
      toast(`SC ${no} 영상을 재생할 수 없습니다. 다음으로 넘어갑니다.`, true);
      player.timer = setTimeout(advance, 900);
    });
    playVideo(video, () => {
      // 음소거로도 막히면 멈춰 두고 사용자가 ▶ 를 누르게 한다
      player.playing = false;
      $('#pl-toggle').textContent = '▶';
    });
  } else {
    stage.innerHTML = `<img src="${esc(scene.media_url)}" alt="${esc(scene.title || `SC ${no}`)}">`;
    startImageClock(IMAGE_SECONDS * 1000);
  }
}

function startImageClock(ms, elapsedBefore = 0) {
  player.start = performance.now() - elapsedBefore;
  const tick = () => {
    const elapsed = performance.now() - player.start;
    setProgress(Math.min(1, elapsed / ms));
    if (elapsed >= ms) { advance(); return; }
    player.raf = requestAnimationFrame(tick);
  };
  player.raf = requestAnimationFrame(tick);
}

function setProgress(ratio) {
  $('#pl-progress').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}

function advance() {
  stopClock();
  if (player.i + 1 < player.list.length) playAt(player.i + 1);
  else { player.playing = false; $('#pl-toggle').textContent = '▶'; setProgress(1); }
}

function togglePlay() {
  const scene = player.list[player.i];
  if (!scene) return;
  const video = $('#player-stage video');

  if (player.playing) {
    player.playing = false;
    $('#pl-toggle').textContent = '▶';
    if (video) video.pause();
    else stopClock();
    return;
  }

  player.playing = true;
  $('#pl-toggle').textContent = '❚❚';
  if (video) {
    if (video.ended) playAt(player.i);
    else playVideo(video, () => { player.playing = false; $('#pl-toggle').textContent = '▶'; });
  } else {
    const done = Number($('#pl-progress').style.width.replace('%', '')) / 100 || 0;
    if (done >= 1) playAt(player.i);
    else startImageClock(IMAGE_SECONDS * 1000, done * IMAGE_SECONDS * 1000);
  }
}

function closePlayer() {
  stopClock();
  $('#player').hidden = true;
  $('#player-stage').innerHTML = '';
  player.list = [];
  player.playing = false;
  document.body.style.overflow = '';
}

function bindPlayer() {
  $('#pl-close').addEventListener('click', closePlayer);
  $('#pl-sound').addEventListener('click', () => {
    player.muted = !player.muted;
    const video = $('#player-stage video');
    if (video) video.muted = player.muted;
    renderSoundButton();
  });
  $('#pl-toggle').addEventListener('click', togglePlay);
  $('#pl-prev').addEventListener('click', () => playAt(Math.max(0, player.i - 1)));
  $('#pl-next').addEventListener('click', () => playAt(Math.min(player.list.length - 1, player.i + 1)));
  $('#pl-strip').addEventListener('click', (e) => {
    const thumb = e.target.closest('.player-thumb');
    if (thumb) playAt(Number(thumb.dataset.i));
  });
}

/* ───────── 키보드 ───────── */

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (!$('#player').hidden) {
      if (e.key === 'Escape') { closePlayer(); return; }
      if (isTyping()) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.key === 'ArrowLeft') playAt(Math.max(0, player.i - 1));
      if (e.key === 'ArrowRight') playAt(Math.min(player.list.length - 1, player.i + 1));
      return;
    }

    if (!$('#modal').hidden) {
      if (e.key === 'Escape') { closeModal(); return; }
      if (isTyping()) return;
      if (e.key === 'ArrowLeft') stepScene(-1);
      if (e.key === 'ArrowRight') stepScene(1);
      return;
    }

    if ($('#view-board').hidden || isTyping()) return;

    if (e.key === 'Escape') setSelection([]);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelection(state.board.scenes.map((s) => s.id));
    }
    if (e.key === 'Enter' && selection.size) {
      playSequence(state.order.filter((s) => selection.has(s.id)));
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
      e.preventDefault();
      deleteSelected();
    }
  });
}

async function deleteSelected() {
  const ids = [...selection];
  if (!confirm(`선택한 프레임 ${ids.length}개를 지웁니다. 코멘트도 함께 사라집니다.`)) return;
  try {
    for (const id of ids) await api(`/api/scenes/${id}`, { method: 'DELETE' });
    setSelection([]);
    await refreshBoard(true);
    await loadStorageNote();
  } catch (ex) { toast(ex.message, true); }
}

/* ───────── 다른 사람 변경사항 따라잡기 ───────── */

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (document.hidden || state.busy || state.uploading.size) return;
    if (!$('#player').hidden) return;
    await refreshBoard(false);
    if (!$('#modal').hidden) await loadComments();
  }, 5000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* ───────── 시작 ───────── */

async function boot() {
  applyTheme(localStorage.getItem('sb-theme') || 'light');
  bindGate();
  bindBoards();
  bindCanvas();
  bindFileInput();
  bindModal();
  bindPlayer();
  bindKeys();

  let session = { user: null, gate: false };
  try { session = await api('/api/me'); } catch { /* noop */ }

  if (session.user) {
    state.me = session.user;
    await openBoards();
  } else if (session.gate) {
    await renderProfiles();
    renderColorRow();
    syncAvatarPreview();
    showGate('profile');
  } else {
    showGate('code');
  }
}

boot();
