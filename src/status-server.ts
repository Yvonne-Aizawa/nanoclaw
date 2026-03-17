import { execSync } from 'child_process';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import {
  addKanbanCard,
  createKanbanColumn,
  deleteKanbanCard,
  deleteKanbanColumn,
  getAllRegisteredGroups,
  getKanbanBoard,
  moveKanbanCard,
  renameKanbanColumn,
  updateKanbanCard,
} from './db.js';
import {
  getMcpServerUrls,
  isContainerBackedMcpServer,
} from './mcp-containers.js';
import { logger } from './logger.js';

interface AgentEntry {
  groupJid: string;
  groupFolder: string | null;
  containerName: string | null;
  state: 'active' | 'idle' | 'waiting';
  isTask: boolean;
  taskId: string | null;
}

interface QueueStatus {
  agents: AgentEntry[];
  activeCount: number;
  maxConcurrent: number;
}

interface PoolStatus {
  size: number;
  assignments: number;
}

function getMcpStatus(): Array<{
  name: string;
  url: string;
  running: boolean;
}> {
  const servers = getMcpServerUrls();

  let runningNames: string[] = [];
  try {
    const out = execSync(
      "docker ps --filter name=nanoclaw-mcp --format '{{.Names}}'",
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
    );
    runningNames = out.trim().split('\n').filter(Boolean);
  } catch {
    // docker not available or no containers — treat all as unknown
  }

  return servers.map((s) => ({
    name: s.name,
    url: s.url,
    // Only container-backed servers need a docker ps health check
    running: isContainerBackedMcpServer(s.name)
      ? runningNames.length > 0
        ? runningNames.some((n) => n.includes(s.name))
        : true // docker ps failed — assume running
      : true, // in-process or remote proxy — no container to check
  }));
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NanoClaw Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e2e8f0; padding: 24px; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 6px; color: #fff; }
    h2 { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em;
         color: #475569; margin: 28px 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .card { background: #161b27; border: 1px solid #1e2535; border-radius: 8px; padding: 14px; }
    .badge { display: inline-block; font-size: 0.65rem; font-weight: 700; border-radius: 4px;
             padding: 2px 7px; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge-active  { background: #0d2b1a; color: #34d399; }
    .badge-idle    { background: #2b2100; color: #fbbf24; }
    .badge-waiting { background: #1a1535; color: #818cf8; }
    .badge-up      { background: #0d2b1a; color: #34d399; }
    .badge-down    { background: #2b0d0d; color: #f87171; }
    .row { display: flex; justify-content: space-between; align-items: center;
           padding: 7px 0; border-bottom: 1px solid #1e2535; }
    .row:last-child { border-bottom: none; }
    .lbl  { font-size: 0.8rem; color: #64748b; }
    .val  { font-size: 0.8rem; font-weight: 500; }
    .mono { font-family: ui-monospace, monospace; font-size: 0.75rem; color: #64748b; }
    .stats { display: flex; gap: 20px; margin-bottom: 4px; }
    .stat { text-align: center; }
    .stat-num { font-size: 1.75rem; font-weight: 700; color: #fff; line-height: 1; }
    .stat-lbl { font-size: 0.7rem; color: #475569; margin-top: 3px; }
    .empty { color: #334155; font-size: 0.85rem; padding: 10px 0; }
    #ts { font-size: 0.7rem; color: #334155; margin-bottom: 28px; margin-top: 2px; }
    nav { margin-bottom: 20px; }
    nav a { color: #64748b; font-size: 0.8rem; text-decoration: none; margin-right: 16px; }
    nav a:hover { color: #e2e8f0; }
  </style>
</head>
<body>
  <h1>NanoClaw</h1>
  <nav><a href="/">Status</a><a href="/kanban">Kanban</a></nav>
  <div id="ts">Loading...</div>

  <h2>Agents</h2>
  <div id="stats" class="stats"></div>
  <div style="margin-top:12px;" id="agents" class="grid"></div>

  <h2>Telegram Swarm</h2>
  <div id="swarm"></div>

  <h2>MCP Servers</h2>
  <div id="mcp" class="grid"></div>

  <script>
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function stat(n, label) {
      return '<div class="stat"><div class="stat-num">' + n + '</div>' +
             '<div class="stat-lbl">' + esc(label) + '</div></div>';
    }

    async function refresh() {
      try {
        const d = await fetch('/api/status').then(r => r.json());

        document.getElementById('ts').textContent =
          'Last updated ' + new Date().toLocaleTimeString();

        const waiting = d.agents.filter(a => a.state === 'waiting').length;
        document.getElementById('stats').innerHTML =
          stat(d.activeCount, 'Active') +
          stat(waiting, 'Waiting') +
          stat(d.maxConcurrent, 'Limit');

        const agentEl = document.getElementById('agents');
        if (!d.agents.length) {
          agentEl.innerHTML = '<p class="empty">No active agents</p>';
        } else {
          agentEl.innerHTML = d.agents.map(a => \`
            <div class="card">
              <div class="row">
                <span class="lbl">Group</span>
                <span class="val">\${esc(a.groupFolder || a.groupJid)}</span>
              </div>
              <div class="row">
                <span class="lbl">Container</span>
                <span class="mono">\${esc(a.containerName || '—')}</span>
              </div>
              <div class="row">
                <span class="lbl">State</span>
                <span class="badge badge-\${esc(a.state)}">\${esc(a.state)}\${a.isTask ? ' · task' : ''}</span>
              </div>
              \${a.taskId ? '<div class="row"><span class="lbl">Task ID</span><span class="mono">' + esc(a.taskId) + '</span></div>' : ''}
            </div>\`).join('');
        }

        const swarmEl = document.getElementById('swarm');
        if (d.swarm.size === 0) {
          swarmEl.innerHTML = '<p class="empty">No bot pool configured</p>';
        } else {
          swarmEl.innerHTML = \`<div class="card" style="max-width:280px;">
            <div class="row"><span class="lbl">Pool bots</span><span class="val">\${d.swarm.size}</span></div>
            <div class="row"><span class="lbl">Active assignments</span><span class="val">\${d.swarm.assignments}</span></div>
          </div>\`;
        }

        const mcpEl = document.getElementById('mcp');
        if (!d.mcpServers.length) {
          mcpEl.innerHTML = '<p class="empty">No MCP servers configured</p>';
        } else {
          mcpEl.innerHTML = d.mcpServers.map(s => \`
            <div class="card">
              <div class="row">
                <span class="val">\${esc(s.name)}</span>
                <span class="badge \${s.running ? 'badge-up' : 'badge-down'}">\${s.running ? 'up' : 'down'}</span>
              </div>
              <div class="row"><span class="mono">\${esc(s.url)}</span></div>
            </div>\`).join('');
        }
      } catch {
        document.getElementById('ts').textContent = 'Connection error — retrying...';
      }
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;

const KANBAN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NanoClaw Kanban</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e2e8f0;
           min-height: 100vh; display: flex; flex-direction: column; }
    header { padding: 16px 24px; border-bottom: 1px solid #1e2535; display: flex;
             align-items: center; gap: 20px; flex-shrink: 0; }
    header h1 { font-size: 1.1rem; font-weight: 600; color: #fff; }
    nav a { color: #64748b; font-size: 0.8rem; text-decoration: none; margin-right: 16px; }
    nav a:hover { color: #e2e8f0; }
    select { background: #161b27; border: 1px solid #1e2535; color: #e2e8f0;
             padding: 6px 10px; border-radius: 6px; font-size: 0.85rem; cursor: pointer; }
    select:focus { outline: none; border-color: #3b82f6; }
    .board-wrap { flex: 1; overflow-x: auto; padding: 20px 24px; }
    .board { display: flex; gap: 14px; align-items: flex-start; min-height: 100%; }
    .col { background: #161b27; border: 1px solid #1e2535; border-radius: 10px;
           width: 272px; flex-shrink: 0; display: flex; flex-direction: column; max-height: calc(100vh - 120px); }
    .col-header { padding: 12px 12px 8px; display: flex; align-items: center; gap: 6px; }
    .col-title { flex: 1; font-size: 0.85rem; font-weight: 600; color: #cbd5e1;
                 background: none; border: none; color: inherit; cursor: text; padding: 2px 4px;
                 border-radius: 4px; width: 100%; }
    .col-title:focus { outline: none; background: #0f1117; padding: 2px 4px; }
    .col-count { font-size: 0.7rem; color: #475569; background: #1e2535;
                 border-radius: 10px; padding: 1px 7px; }
    .col-del { background: none; border: none; color: #475569; cursor: pointer;
               font-size: 0.9rem; padding: 2px 5px; border-radius: 4px; line-height: 1; }
    .col-del:hover { background: #2b0d0d; color: #f87171; }
    .cards { padding: 0 8px 8px; overflow-y: auto; flex: 1; min-height: 40px; }
    .card { background: #1e2535; border: 1px solid #263045; border-radius: 7px;
            padding: 10px 10px 8px; margin-bottom: 7px; cursor: grab;
            transition: opacity 0.15s, box-shadow 0.15s; position: relative; }
    .card:hover { border-color: #334155; }
    .card.dragging { opacity: 0.4; cursor: grabbing; }
    .card.drag-over { box-shadow: 0 0 0 2px #3b82f6; }
    .col.drag-over-col .cards { background: rgba(59,130,246,0.05); border-radius: 6px; }
    .drop-placeholder { height: 6px; background: #3b82f6; border-radius: 3px;
                        margin-bottom: 7px; opacity: 0.7; }
    .card-title { font-size: 0.82rem; font-weight: 500; color: #e2e8f0; margin-bottom: 4px;
                  word-break: break-word; }
    .card-desc { font-size: 0.75rem; color: #64748b; word-break: break-word; white-space: pre-wrap; }
    .card-actions { display: none; position: absolute; top: 6px; right: 6px; gap: 4px; }
    .card:hover .card-actions { display: flex; }
    .btn-icon { background: #0f1117; border: 1px solid #263045; color: #94a3b8;
                border-radius: 4px; cursor: pointer; font-size: 0.7rem; padding: 2px 6px;
                line-height: 1.4; }
    .btn-icon:hover { border-color: #3b82f6; color: #93c5fd; }
    .btn-icon.del:hover { border-color: #f87171; color: #f87171; background: #2b0d0d; }
    .add-card-btn { margin: 0 8px 8px; background: none; border: 1px dashed #263045;
                    color: #475569; padding: 7px; border-radius: 6px; cursor: pointer;
                    font-size: 0.8rem; width: calc(100% - 16px); text-align: left; }
    .add-card-btn:hover { border-color: #3b82f6; color: #93c5fd; }
    .add-col-btn { background: rgba(255,255,255,0.04); border: 1px dashed #1e2535;
                   color: #475569; padding: 10px 16px; border-radius: 10px; cursor: pointer;
                   font-size: 0.85rem; width: 220px; flex-shrink: 0; text-align: left;
                   align-self: flex-start; }
    .add-col-btn:hover { border-color: #3b82f6; color: #93c5fd; }
    /* Modal */
    .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.6);
                display: flex; align-items: center; justify-content: center; z-index: 100; }
    .modal-bg.hidden { display: none; }
    .modal { background: #161b27; border: 1px solid #1e2535; border-radius: 12px;
             padding: 22px; width: 380px; max-width: 95vw; }
    .modal h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 14px; color: #fff; }
    .modal label { font-size: 0.78rem; color: #64748b; display: block; margin-bottom: 4px; }
    .modal input, .modal textarea {
      width: 100%; background: #0f1117; border: 1px solid #1e2535; color: #e2e8f0;
      border-radius: 6px; padding: 8px 10px; font-size: 0.85rem; font-family: inherit; }
    .modal input:focus, .modal textarea:focus { outline: none; border-color: #3b82f6; }
    .modal textarea { resize: vertical; min-height: 72px; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
    .btn { padding: 7px 16px; border-radius: 6px; font-size: 0.82rem; cursor: pointer;
           border: none; font-family: inherit; }
    .btn-primary { background: #1d4ed8; color: #fff; }
    .btn-primary:hover { background: #2563eb; }
    .btn-ghost { background: none; border: 1px solid #263045; color: #94a3b8; }
    .btn-ghost:hover { border-color: #475569; color: #e2e8f0; }
    .empty { color: #334155; font-size: 0.85rem; padding: 20px 24px; }
    .field + .field { margin-top: 10px; }
  </style>
</head>
<body>
  <header>
    <h1>NanoClaw</h1>
    <nav><a href="/">Status</a><a href="/kanban">Kanban</a></nav>
    <select id="group-sel">
      <option value="">— select group —</option>
    </select>
  </header>

  <div class="board-wrap">
    <div class="board" id="board">
      <p class="empty">Select a group to view its board.</p>
    </div>
  </div>

  <!-- Card modal -->
  <div class="modal-bg hidden" id="card-modal">
    <div class="modal">
      <h3 id="modal-title">Add card</h3>
      <div class="field">
        <label>Title</label>
        <input id="card-title-inp" type="text" placeholder="Card title" />
      </div>
      <div class="field">
        <label>Description (optional)</label>
        <textarea id="card-desc-inp" placeholder="Details…"></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save</button>
      </div>
    </div>
  </div>

  <script>
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let currentGroup = '';
  let board = null; // { columns: [{id, name, cards: [{id, title, description}]}] }

  // Drag state
  let dragCard = null;     // {cardId, fromColId}
  let dragCardEl = null;
  let dropTarget = null;   // {colId, position}

  // ── Helpers ────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  async function api(method, path, body) {
    const opts = { method, headers: {'Content-Type':'application/json'} };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error(await r.text());
    if (r.status === 204) return null;
    return r.json();
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    const groups = await api('GET', '/api/kanban');
    const sel = document.getElementById('group-sel');
    groups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.folder;
      opt.textContent = g.name ? g.name + ' (' + g.folder + ')' : g.folder;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => selectGroup(sel.value));
    if (groups.length === 1) { sel.value = groups[0].folder; selectGroup(groups[0].folder); }
  }

  async function selectGroup(folder) {
    currentGroup = folder;
    if (!folder) { document.getElementById('board').innerHTML = '<p class="empty">Select a group to view its board.</p>'; return; }
    board = await api('GET', '/api/kanban/' + encodeURIComponent(folder));
    renderBoard();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderBoard() {
    const el = document.getElementById('board');
    el.innerHTML = '';
    board.columns.forEach(col => el.appendChild(makeCol(col)));
    // Add column button
    const btn = document.createElement('button');
    btn.className = 'add-col-btn';
    btn.textContent = '+ Add column';
    btn.onclick = addColumn;
    el.appendChild(btn);
  }

  function makeCol(col) {
    const div = document.createElement('div');
    div.className = 'col';
    div.dataset.colId = col.id;

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'col-header';

    const titleInp = document.createElement('input');
    titleInp.className = 'col-title';
    titleInp.value = col.name;
    titleInp.addEventListener('blur', () => renameColumn(col.id, titleInp.value));
    titleInp.addEventListener('keydown', e => { if (e.key === 'Enter') titleInp.blur(); if (e.key === 'Escape') { titleInp.value = col.name; titleInp.blur(); } });

    const count = document.createElement('span');
    count.className = 'col-count';
    count.textContent = col.cards.length;

    const delBtn = document.createElement('button');
    delBtn.className = 'col-del';
    delBtn.title = 'Delete column';
    delBtn.textContent = '×';
    delBtn.onclick = () => deleteColumn(col.id);

    hdr.append(titleInp, count, delBtn);

    // Cards list
    const cardsList = document.createElement('div');
    cardsList.className = 'cards';
    cardsList.dataset.colId = col.id;
    col.cards.forEach((card, idx) => cardsList.appendChild(makeCard(card, col.id, idx)));

    // Drop zone events
    cardsList.addEventListener('dragover', e => onCardsListDragOver(e, col.id, cardsList));
    cardsList.addEventListener('dragleave', e => onCardsListDragLeave(e, div, cardsList));
    cardsList.addEventListener('drop', e => onDrop(e, col.id, cardsList));

    // Add card button
    const addBtn = document.createElement('button');
    addBtn.className = 'add-card-btn';
    addBtn.textContent = '+ Add card';
    addBtn.onclick = () => openAddCard(col.id);

    div.append(hdr, cardsList, addBtn);
    return div;
  }

  function makeCard(card, colId, idx) {
    const div = document.createElement('div');
    div.className = 'card';
    div.draggable = true;
    div.dataset.cardId = card.id;
    div.dataset.colId = colId;
    div.dataset.idx = idx;

    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = card.title;

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon';
    editBtn.textContent = 'Edit';
    editBtn.onclick = (e) => { e.stopPropagation(); openEditCard(card); };

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon del';
    delBtn.textContent = 'Del';
    delBtn.onclick = (e) => { e.stopPropagation(); deleteCard(card.id); };

    actions.append(editBtn, delBtn);
    div.append(titleEl, actions);

    if (card.description) {
      const descEl = document.createElement('div');
      descEl.className = 'card-desc';
      descEl.textContent = card.description;
      div.insertBefore(descEl, actions);
    }

    // Drag events
    div.addEventListener('dragstart', e => {
      dragCard = { cardId: card.id, fromColId: colId };
      dragCardEl = div;
      setTimeout(() => div.classList.add('dragging'), 0);
      e.dataTransfer.effectAllowed = 'move';
    });
    div.addEventListener('dragend', () => {
      div.classList.remove('dragging');
      clearDragUI();
      dragCard = null; dragCardEl = null; dropTarget = null;
    });

    return div;
  }

  // ── Drag and Drop ──────────────────────────────────────────────────────────
  function clearDragUI() {
    document.querySelectorAll('.drop-placeholder').forEach(el => el.remove());
    document.querySelectorAll('.drag-over-col').forEach(el => el.classList.remove('drag-over-col'));
  }

  function onCardsListDragOver(e, colId, listEl) {
    if (!dragCard) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    clearDragUI();
    listEl.closest('.col').classList.add('drag-over-col');

    // Find insertion position
    const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
    let insertBefore = null;
    let pos = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        insertBefore = cards[i];
        pos = i;
        break;
      }
    }

    dropTarget = { colId, position: pos };

    const ph = document.createElement('div');
    ph.className = 'drop-placeholder';
    if (insertBefore) listEl.insertBefore(ph, insertBefore);
    else listEl.appendChild(ph);
  }

  function onCardsListDragLeave(e, colDiv, listEl) {
    if (!colDiv.contains(e.relatedTarget)) {
      clearDragUI();
      dropTarget = null;
    }
  }

  async function onDrop(e, colId, listEl) {
    e.preventDefault();
    if (!dragCard || !dropTarget) { clearDragUI(); return; }
    const { cardId } = dragCard;
    const { colId: toCol, position } = dropTarget;
    clearDragUI();
    try {
      await api('POST', '/api/kanban/' + encodeURIComponent(currentGroup) + '/cards/' + encodeURIComponent(cardId) + '/move',
        { column_id: toCol, position });
      board = await api('GET', '/api/kanban/' + encodeURIComponent(currentGroup));
      renderBoard();
    } catch(err) { alert('Move failed: ' + err.message); }
  }

  // ── Column ops ─────────────────────────────────────────────────────────────
  async function addColumn() {
    const name = prompt('Column name:');
    if (!name || !name.trim()) return;
    await api('POST', '/api/kanban/' + encodeURIComponent(currentGroup) + '/columns', { name: name.trim() });
    board = await api('GET', '/api/kanban/' + encodeURIComponent(currentGroup));
    renderBoard();
  }

  async function renameColumn(colId, newName) {
    const col = board.columns.find(c => c.id === colId);
    if (!col || newName === col.name || !newName.trim()) return;
    try {
      await api('PATCH', '/api/kanban/' + encodeURIComponent(currentGroup) + '/columns/' + encodeURIComponent(colId), { name: newName.trim() });
      col.name = newName.trim();
    } catch(err) { alert('Rename failed: ' + err.message); renderBoard(); }
  }

  async function deleteColumn(colId) {
    const col = board.columns.find(c => c.id === colId);
    const msg = col && col.cards.length
      ? 'Delete column "' + col.name + '"? Its ' + col.cards.length + ' card(s) will move to the next column.'
      : 'Delete column "' + (col ? col.name : colId) + '"?';
    if (!confirm(msg)) return;
    await api('DELETE', '/api/kanban/' + encodeURIComponent(currentGroup) + '/columns/' + encodeURIComponent(colId));
    board = await api('GET', '/api/kanban/' + encodeURIComponent(currentGroup));
    renderBoard();
  }

  // ── Card modal ─────────────────────────────────────────────────────────────
  let modalMode = null; // {mode:'add', colId} or {mode:'edit', card}

  function openAddCard(colId) {
    modalMode = { mode: 'add', colId };
    document.getElementById('modal-title').textContent = 'Add card';
    document.getElementById('card-title-inp').value = '';
    document.getElementById('card-desc-inp').value = '';
    document.getElementById('card-modal').classList.remove('hidden');
    document.getElementById('card-title-inp').focus();
    document.getElementById('modal-save').onclick = saveCard;
  }

  function openEditCard(card) {
    modalMode = { mode: 'edit', card };
    document.getElementById('modal-title').textContent = 'Edit card';
    document.getElementById('card-title-inp').value = card.title;
    document.getElementById('card-desc-inp').value = card.description || '';
    document.getElementById('card-modal').classList.remove('hidden');
    document.getElementById('card-title-inp').focus();
    document.getElementById('modal-save').onclick = saveCard;
  }

  function closeModal() {
    document.getElementById('card-modal').classList.add('hidden');
    modalMode = null;
  }

  async function saveCard() {
    const title = document.getElementById('card-title-inp').value.trim();
    const description = document.getElementById('card-desc-inp').value.trim() || undefined;
    if (!title) { document.getElementById('card-title-inp').focus(); return; }

    try {
      if (modalMode.mode === 'add') {
        await api('POST', '/api/kanban/' + encodeURIComponent(currentGroup) + '/cards',
          { column_id: modalMode.colId, title, description });
      } else {
        await api('PATCH', '/api/kanban/' + encodeURIComponent(currentGroup) + '/cards/' + encodeURIComponent(modalMode.card.id),
          { title, description });
      }
      closeModal();
      board = await api('GET', '/api/kanban/' + encodeURIComponent(currentGroup));
      renderBoard();
    } catch(err) { alert('Save failed: ' + err.message); }
  }

  async function deleteCard(cardId) {
    if (!confirm('Delete this card?')) return;
    await api('DELETE', '/api/kanban/' + encodeURIComponent(currentGroup) + '/cards/' + encodeURIComponent(cardId));
    board = await api('GET', '/api/kanban/' + encodeURIComponent(currentGroup));
    renderBoard();
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if ((e.key === 'Enter') && e.ctrlKey && !document.getElementById('card-modal').classList.contains('hidden')) saveCard();
  });

  // Click outside modal to close
  document.getElementById('card-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('card-modal')) closeModal();
  });

  init();
  </script>
</body>
</html>`;

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function jsonOk(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(body);
}

function jsonErr(res: ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

/** Match /api/kanban/<group>[/<rest>] */
const KANBAN_RE = /^\/api\/kanban(?:\/([^/]+)(?:\/(.+))?)?$/;

async function handleKanban(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method?.toUpperCase() ?? 'GET';
  const url = req.url ?? '';
  const m = url.match(KANBAN_RE);
  if (!m) { jsonErr(res, 404, 'Not found'); return; }

  const group = m[1] ? decodeURIComponent(m[1]) : undefined;
  const rest = m[2] ?? '';

  // GET /api/kanban/groups
  if (!group) {
    if (method !== 'GET') { jsonErr(res, 405, 'Method Not Allowed'); return; }
    const groups = getAllRegisteredGroups();
    const list = Object.values(groups).map((g) => ({ folder: g.folder, name: g.name }));
    jsonOk(res, list);
    return;
  }

  // GET /api/kanban/:group  → full board
  if (!rest) {
    if (method !== 'GET') { jsonErr(res, 405, 'Method Not Allowed'); return; }
    jsonOk(res, getKanbanBoard(group));
    return;
  }

  // /api/kanban/:group/columns[/:colId]
  const colMatch = rest.match(/^columns(?:\/([^/]+))?$/);
  if (colMatch) {
    const colId = colMatch[1] ? decodeURIComponent(colMatch[1]) : undefined;
    const body = (method !== 'GET' && method !== 'DELETE') ? (await readBody(req) as Record<string, string>) : {};

    if (!colId) {
      // POST /columns
      if (method !== 'POST') { jsonErr(res, 405, 'Method Not Allowed'); return; }
      const col = createKanbanColumn(group, String(body.name ?? ''));
      jsonOk(res, col, 201);
    } else if (method === 'PATCH') {
      renameKanbanColumn(colId, group, String(body.name ?? ''));
      jsonOk(res, { ok: true });
    } else if (method === 'DELETE') {
      deleteKanbanColumn(colId, group);
      res.writeHead(204); res.end();
    } else {
      jsonErr(res, 405, 'Method Not Allowed');
    }
    return;
  }

  // /api/kanban/:group/cards[/:cardId[/move]]
  const cardMatch = rest.match(/^cards(?:\/([^/]+)(?:\/(move))?)?$/);
  if (cardMatch) {
    const cardId = cardMatch[1] ? decodeURIComponent(cardMatch[1]) : undefined;
    const action = cardMatch[2];
    const body = (method !== 'GET' && method !== 'DELETE') ? (await readBody(req) as Record<string, unknown>) : {};

    if (!cardId) {
      // POST /cards
      if (method !== 'POST') { jsonErr(res, 405, 'Method Not Allowed'); return; }
      const card = addKanbanCard(
        group,
        String(body.column_id ?? ''),
        String(body.title ?? ''),
        body.description != null ? String(body.description) : undefined,
      );
      jsonOk(res, card, 201);
    } else if (action === 'move') {
      // POST /cards/:id/move
      if (method !== 'POST') { jsonErr(res, 405, 'Method Not Allowed'); return; }
      const position = body.position != null ? Number(body.position) : undefined;
      moveKanbanCard(cardId, group, String(body.column_id ?? ''), position);
      jsonOk(res, { ok: true });
    } else if (method === 'PATCH') {
      updateKanbanCard(
        cardId, group,
        body.title != null ? String(body.title) : undefined,
        body.description != null ? String(body.description) : undefined,
      );
      jsonOk(res, { ok: true });
    } else if (method === 'DELETE') {
      deleteKanbanCard(cardId, group);
      res.writeHead(204); res.end();
    } else {
      jsonErr(res, 405, 'Method Not Allowed');
    }
    return;
  }

  jsonErr(res, 404, 'Not found');
}

export function startStatusServer(
  port: number,
  getQueueStatus: () => QueueStatus,
  getPoolStatus: () => PoolStatus,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '';

      if (url.startsWith('/api/kanban')) {
        handleKanban(req, res).catch((err) => {
          logger.error({ err }, 'Kanban API error');
          if (!res.headersSent) jsonErr(res, 500, String(err));
        });
        return;
      }

      if (req.method === 'GET' && url === '/api/status') {
        const q = getQueueStatus();
        const p = getPoolStatus();
        const body = JSON.stringify({
          agents: q.agents,
          activeCount: q.activeCount,
          maxConcurrent: q.maxConcurrent,
          swarm: p,
          mcpServers: getMcpStatus(),
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML_PAGE);
        return;
      }

      if (req.method === 'GET' && (url === '/kanban' || url === '/kanban/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(KANBAN_PAGE);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(port, '127.0.0.1', () => {
      logger.info(
        { port },
        'Status server started at http://127.0.0.1:' + port,
      );
      resolve(server);
    });
    server.on('error', reject);
  });
}
