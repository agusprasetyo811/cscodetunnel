/* cscodetunnel dashboard — vanilla JS, no build step. */
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const STATE_COLORS = {
  starting: 'state-starting',
  online: 'state-online',
  restarting: 'state-restarting',
  error: 'state-error',
  stopped: 'state-stopped',
};
const METHOD_COLORS = {
  GET: 'm-get', POST: 'm-post', PUT: 'm-put', PATCH: 'm-patch',
  DELETE: 'm-delete', OPTIONS: 'm-options', HEAD: 'm-head',
};

let currentRecord = null;
let requestsByTunnel = new Map(); // tunnelId -> Set of record ids seen

/* ---------- API ---------- */
async function api(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

/* ---------- Tunnels ---------- */
function renderTunnels(tunnels) {
  const box = $('#tunnels');
  box.replaceChildren();
  if (!tunnels.length) {
    box.appendChild(el('div', 'empty', 'No tunnels running. Start one with: cscodetunnel http <port>'));
    return;
  }
  for (const t of tunnels) box.appendChild(tunnelCard(t));
}

function tunnelCard(t) {
  const card = el('div', 'tunnel');
  card.dataset.id = t.id;

  const head = el('div', 'tunnel-head');
  head.appendChild(el('span', 'tunnel-name', t.name));
  const badge = el('span', `badge ${STATE_COLORS[t.state] || ''}`, t.state);
  head.appendChild(badge);

  const urlRow = el('div', 'tunnel-url');
  if (t.url) {
    const a = el('a', null, t.url);
    a.href = t.url;
    a.target = '_blank';
    a.rel = 'noopener';
    urlRow.appendChild(a);
    const copy = el('button', 'btn btn-small', 'copy');
    copy.onclick = () => copyText(t.url);
    urlRow.appendChild(copy);
  } else if (t.state === 'online') {
    urlRow.appendChild(el('span', 'dim', '(url not known)'));
  } else {
    urlRow.appendChild(el('span', 'dim', 'reconnecting…'));
  }

  const meta = el('div', 'tunnel-meta');
  meta.appendChild(el('span', null, `→ ${t.displayTarget || t.localTarget}`));
  meta.appendChild(el('span', null, `restarts: ${t.restarts}`));
  meta.appendChild(el('span', null, `since ${new Date(t.startedAt).toLocaleTimeString()}`));
  if (t.lastError) meta.appendChild(el('span', 'err-text', t.lastError));

  const actions = el('div', 'tunnel-actions');
  const restart = el('button', 'btn btn-small', 'restart');
  restart.onclick = () => api(`/api/tunnels/${t.id}/restart`, { method: 'POST' }).catch(alert);
  const stop = el('button', 'btn btn-small btn-danger', 'stop');
  stop.onclick = () => api(`/api/tunnels/${t.id}/stop`, { method: 'POST' }).catch(alert);
  if (t.state === 'stopped') restart.disabled = stop.disabled = true;
  actions.append(restart, stop);

  card.append(head, urlRow, meta, actions);
  return card;
}

/* ---------- Requests ---------- */
function requestRow(rec, prepend) {
  const row = el('div', 'request');
  row.dataset.id = rec.id;

  const method = el('span', `method ${METHOD_COLORS[rec.method] || 'm-other'}`, rec.method);
  const path = el('span', 'req-path', rec.path + qs(rec.query));
  const status = rec.response
    ? el('span', `status ${rec.response.statusCode >= 400 ? 'status-err' : 'status-ok'}`, String(rec.response.statusCode))
    : el('span', 'status status-pending', '…');
  const dur = el('span', 'req-dur', rec.durationMs === null ? '' : `${rec.durationMs}ms`);
  const time = el('span', 'req-time', new Date(rec.timestamp).toLocaleTimeString());

  row.append(method, path, status, dur, time);
  row.onclick = () => openDetail(rec);
  return row;
}

function qs(query) {
  const s = new URLSearchParams(query).toString();
  return s ? `?${s}` : '';
}

function renderRequests(recs) {
  const box = $('#requests');
  box.replaceChildren();
  if (!recs.length) {
    box.appendChild(el('div', 'empty', 'No requests yet — hit your public URL.'));
    return;
  }
  for (const r of recs) box.appendChild(requestRow(r));
}

function upsertRequest(rec) {
  const box = $('#requests');
  if (box.querySelector('.empty')) box.replaceChildren();
  let row = box.querySelector(`[data-id="${rec.id}"]`);
  if (row) row.replaceWith(requestRow(rec));
  else box.prepend(requestRow(rec, true));
  while (box.children.length > 200) box.lastChild.remove();
  if (currentRecord && currentRecord.id === rec.id) refreshDetail();
}

function refreshDetail() {
  if (!currentRecord) return;
  api(`/api/requests/${currentRecord.id}`).then(openDetail).catch(() => {});
}

/* ---------- Detail modal ---------- */
function openDetail(rec) {
  currentRecord = rec;
  $('#modal').classList.remove('hidden');
  $('#modal-title').textContent = `${rec.method} ${rec.path}${qs(rec.query)} — ${rec.id}`;
  $('#copy-curl').onclick = () => copyText(asCurl(rec));
  renderDetail(rec, 'request');
}

function renderDetail(rec, tab) {
  const body = $('#modal-body');
  body.replaceChildren();
  $('.tab.active')?.classList.remove('active');
  $(`.tab[data-tab="${tab}"]`).classList.add('active');

  if (tab === 'request') {
    body.append(
      section('Headers', headersTable(rec.request.headers)),
      section('Body', bodyBlock(rec.request.body)),
    );
  } else if (!rec.response) {
    body.append(el('div', 'dim', 'Still waiting for a response…'));
  } else {
    const badges = [];
    if (rec.response.body?.truncated) badges.push('truncated');
    if (rec.response.body?.kind === 'binary') badges.push('binary');
    if (isCompressed(rec.response.headers)) badges.push('compressed');
    body.append(
      section(
        `Status ${rec.response.statusCode} ${rec.response.statusMessage}${badges.length ? ' · ' + badges.join(' · ') : ''}`,
        null,
      ),
      section('Headers', headersTable(rec.response.headers)),
      section('Body', bodyBlock(rec.response.body)),
    );
  }
}

function section(title, content) {
  const s = el('div', 'detail-section');
  s.appendChild(el('h3', null, title));
  if (content) s.appendChild(content);
  return s;
}

function headersTable(headers) {
  const table = el('table', 'headers');
  for (const [k, v] of Object.entries(headers)) {
    const tr = el('tr');
    tr.append(el('td', 'h-key', k), el('td', 'h-val', v));
    table.appendChild(tr);
  }
  return table;
}

function bodyBlock(body) {
  if (!body || body.kind === 'binary' || body.text === undefined || body.text === '') {
    return el('div', 'dim', body ? `(binary body, ${body.bytes} bytes)` : '(empty)');
  }
  const pre = el('pre', 'body-pre', body.text);
  if (body.truncated) pre.appendChild(el('div', 'badge', 'truncated'));
  return pre;
}

function isCompressed(headers) {
  const ce = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-encoding');
  return ce ? ce[1].trim() !== '' : false;
}

function asCurl(rec) {
  const host = rec.request.headers.host || 'example.com';
  const parts = [`curl -X ${rec.method}`, `'http://${host}${rec.path}${qs(rec.query)}'`];
  for (const [k, v] of Object.entries(rec.request.headers)) {
    if (['host', 'content-length'].includes(k.toLowerCase())) continue;
    parts.push(`-H '${k}: ${v}'`);
  }
  if (rec.request.body?.text) parts.push(`--data '${rec.request.body.text.replace(/'/g, "'\\''")}'`);
  return parts.join(' \\\n  ');
}

/* ---------- Logs ---------- */
function addLog(entry) {
  const box = $('#logs');
  if (box.querySelector('.empty')) box.replaceChildren();
  const line = el('div', 'log-line');
  line.append(el('span', 'log-tun', entry.tunnelId), el('span', 'log-text', entry.line));
  box.prepend(line);
  while (box.children.length > 200) box.lastChild.remove();
}

/* ---------- Utils ---------- */
function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => flash('copied'),
    () => alert('copy failed:\n' + text),
  );
}

function flash(msg) {
  const d = el('div', 'flash', msg);
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 1200);
}

/* ---------- Live updates ---------- */
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    $('#conn').className = 'conn conn-online';
    $('#conn').textContent = 'live';
    refreshAll();
  };
  es.onerror = () => {
    $('#conn').className = 'conn conn-offline';
    $('#conn').textContent = 'offline';
  };
  es.addEventListener('status', (e) => {
    const info = JSON.parse(e.data);
    const card = document.querySelector(`.tunnel[data-id="${info.id}"]`);
    if (card) card.replaceWith(tunnelCard(info));
  });
  es.addEventListener('request', (e) => {
    const { record } = JSON.parse(e.data);
    upsertRequest(record);
  });
  es.addEventListener('log', (e) => addLog(JSON.parse(e.data)));
  es.addEventListener('ping', () => {});
}

async function refreshAll() {
  const [tunnels, recs] = await Promise.all([api('/api/tunnels'), api('/api/requests?limit=100')]);
  renderTunnels(tunnels);
  renderRequests(recs);
}

/* ---------- Wiring ---------- */
$('#modal-close').onclick = () => {
  $('#modal').classList.add('hidden');
  currentRecord = null;
};
$('#modal').onclick = (e) => {
  if (e.target === $('#modal')) $('#modal-close').onclick();
};
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => currentRecord && renderDetail(currentRecord, t.dataset.tab);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#modal-close').onclick();
});

refreshAll().catch(() => {});
connectStream();
