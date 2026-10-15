/* ========================================================
   Helpline — app.js
   Demo helpdesk: ticket list + detail + triage action bar
   State in memory + localStorage; ?reset clears.
   ======================================================== */

// Category labels matching core/jev.mjs CATEGORIES (exact order)
const CATEGORIES = [
  { key: 'refund',     label: 'Refund' },
  { key: 'shipping',   label: 'Shipping' },
  { key: 'billing',    label: 'Billing' },
  { key: 'account',    label: 'Account' },
  { key: 'order',      label: 'Order change' },
  { key: 'damaged',    label: 'Damaged item' },
  { key: 'wrong_item', label: 'Wrong item' },
  { key: 'spam',       label: 'Spam' },
];

const STORAGE_KEY = 'helpline-state';

let tickets = [];  // loaded from tickets.json
let state = {};    // { [id]: { status, category, urgent } }
let activeId = null;

// ---------- State management ----------

function defaultState(t) {
  return { status: 'New', category: null, urgent: false };
}

function loadState() {
  if (new URLSearchParams(location.search).has('reset')) {
    localStorage.removeItem(STORAGE_KEY);
    // Keep ?reset so reloads also reset
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function initState() {
  const saved = loadState();
  for (const t of tickets) {
    state[t.id] = (saved && saved[t.id]) ? saved[t.id] : defaultState(t);
  }
}

// ---------- Rendering: ticket list ----------

function statusChipClass(status) {
  if (status === 'Triaged')   return 'chip chip-triaged';
  if (status === 'Escalated') return 'chip chip-escalated';
  return 'chip chip-new';
}

function categoryLabel(key) {
  const c = CATEGORIES.find(c => c.key === key);
  return c ? c.label : key;
}

function renderRow(t) {
  const s = state[t.id];
  const hasImages = t.images && t.images.length > 0;

  const row = document.createElement('div');
  row.className = 'ticket-row' + (t.id === activeId ? ' active' : '');
  row.setAttribute('data-ticket-id', t.id);
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');

  row.innerHTML = `
    <div class="ticket-row-main">
      <div class="ticket-row-top">
        <span class="ticket-subject">${esc(t.subject)}</span>
        <span class="ticket-time">${esc(t.received)}</span>
      </div>
      <div class="ticket-row-bottom">
        <span class="ticket-from">${esc(t.from)}</span>
        <span class="${statusChipClass(s.status)}">${esc(s.status)}</span>
        ${s.category ? `<span class="chip chip-category">${esc(categoryLabel(s.category))}</span>` : ''}
        ${s.urgent ? '<span class="badge-urgent">Urgent</span>' : ''}
        ${hasImages ? '<span class="badge-attachment" title="Has attachment">📎</span>' : ''}
      </div>
    </div>
  `;

  row.addEventListener('click', () => openTicket(t.id));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTicket(t.id); }
  });

  return row;
}

function renderList() {
  const container = document.getElementById('ticket-list');
  container.innerHTML = '';
  for (const t of tickets) {
    container.appendChild(renderRow(t));
  }
  updateCount();
}

function updateCount() {
  const newCount = tickets.filter(t => state[t.id].status === 'New').length;
  document.getElementById('topbar-count').textContent =
    `${tickets.length} tickets · ${newCount} new`;
}

// ---------- Rendering: detail ----------

function openTicket(id) {
  activeId = id;
  const t = tickets.find(t => t.id === id);
  if (!t) return;

  document.getElementById('detail-empty').style.display = 'none';
  document.getElementById('detail-content').style.display = 'flex';

  document.getElementById('detail-subject').textContent = t.subject;
  document.getElementById('detail-from').textContent = `From: ${t.from}`;
  document.getElementById('detail-time').textContent = t.received;
  document.getElementById('detail-body').textContent = t.body;

  // Images
  const imagesEl = document.getElementById('detail-images');
  imagesEl.innerHTML = '';
  if (t.images) {
    for (const src of t.images) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'Attachment';
      imagesEl.appendChild(img);
    }
  }

  // Action bar
  renderActions(t);

  // Highlight active row
  document.querySelectorAll('.ticket-row').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.ticketId) === id);
  });
}

function renderActions(t) {
  const bar = document.getElementById('detail-actions');
  bar.innerHTML = '';
  const s = state[t.id];

  // 8 category buttons
  for (const cat of CATEGORIES) {
    const btn = document.createElement('button');
    btn.className = 'action-btn' + (s.category === cat.key && s.status === 'Triaged' ? ' active-category' : '');
    btn.textContent = cat.label;
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', () => setCategory(t.id, cat.key));
    bar.appendChild(btn);
  }

  // Separator
  const sep1 = document.createElement('div');
  sep1.className = 'action-sep';
  bar.appendChild(sep1);

  // Urgent toggle
  const urgentBtn = document.createElement('button');
  urgentBtn.className = 'action-btn action-btn-urgent';
  urgentBtn.textContent = 'Urgent';
  urgentBtn.setAttribute('type', 'button');
  urgentBtn.setAttribute('aria-pressed', s.urgent ? 'true' : 'false');
  urgentBtn.addEventListener('click', () => toggleUrgent(t.id));
  bar.appendChild(urgentBtn);

  // Escalate to human
  const escBtn = document.createElement('button');
  escBtn.className = 'action-btn action-btn-escalate' + (s.status === 'Escalated' ? ' active-escalate' : '');
  escBtn.textContent = 'Escalate to human';
  escBtn.setAttribute('type', 'button');
  escBtn.addEventListener('click', () => escalate(t.id));
  bar.appendChild(escBtn);
}

// ---------- Actions ----------

function setCategory(id, catKey) {
  state[id].status = 'Triaged';
  state[id].category = catKey;
  saveState();
  refreshAfterAction(id);
}

function toggleUrgent(id) {
  state[id].urgent = !state[id].urgent;
  saveState();
  refreshAfterAction(id);
}

function escalate(id) {
  state[id].status = 'Escalated';
  saveState();
  refreshAfterAction(id);
}

function refreshAfterAction(id) {
  // Re-render the list (row updates) but keep the detail view open
  renderList();
  if (activeId === id) {
    const t = tickets.find(t => t.id === id);
    if (t) renderActions(t);
  }
}

// ---------- Helpers ----------

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- Public API for eval ----------

window.helpline = {
  state: () => tickets.map(t => ({
    id: t.id,
    status: state[t.id].status,
    category: state[t.id].category,
    urgent: state[t.id].urgent,
  })),
};

// ---------- Boot ----------

async function boot() {
  const res = await fetch('tickets.json');
  tickets = await res.json();
  initState();
  renderList();
}

boot();
