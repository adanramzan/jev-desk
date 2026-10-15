/* ========================================================
   Jev Desk — sidepanel.js
   Side panel UI: settings, scan/autopilot, board of lanes.
   ======================================================== */

// Lane definitions: Urgent first, then 8 categories, then Needs a human
const LANES = [
  { id: 'urgent',     name: '🔴 Urgent',        css: 'lane-urgent' },
  { id: 'refund',     name: 'Refund',            css: '' },
  { id: 'shipping',   name: 'Shipping',          css: '' },
  { id: 'billing',    name: 'Billing',           css: '' },
  { id: 'account',    name: 'Account',           css: '' },
  { id: 'order',      name: 'Order change',      css: '' },
  { id: 'damaged',    name: 'Damaged item',      css: '' },
  { id: 'wrong_item', name: 'Wrong item',        css: '' },
  { id: 'spam',       name: 'Spam',              css: '' },
  { id: 'human',      name: 'Needs a human',     css: 'lane-human' },
];

// State
const cards = {};  // { [laneId]: [{subject, confidence, refund, photo, latencyMs, mode}] }
let ticketCount = 0;
let startTime = null;

// ---------- Init ----------

function init() {
  for (const lane of LANES) cards[lane.id] = [];
  renderBoard();
  loadSettings();
  bindEvents();
  listenForEvents();
}

// ---------- Settings ----------

function loadSettings() {
  chrome.runtime.sendMessage({ action: 'getSettings' }, (settings) => {
    if (!settings) return;
    document.getElementById('input-apikey').value = settings.apiKey || '';
    document.getElementById('input-budget').value = settings.budgetUsd ?? 1;
    document.getElementById('stat-budget').textContent = ` / $${(settings.budgetUsd ?? 1).toFixed(2)}`;
    document.getElementById('input-baseurl').value = settings.baseUrl || 'https://api.typesafe.ai';
    document.getElementById('input-list-scope').value = settings.scopes?.list || '[data-ticket-list]';
    document.getElementById('input-actions-scope').value = settings.scopes?.actions || '[data-ticket-actions]';
    updateSpend(settings.spentUsd || 0);
  });
}

function saveSettings() {
  const budgetUsd = Number(document.getElementById('input-budget').value);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) { setStatus('Enter a budget greater than zero'); return; }
  const settings = {
    apiKey: document.getElementById('input-apikey').value.trim(),
    budgetUsd,
    baseUrl: document.getElementById('input-baseurl').value.trim() || 'https://api.typesafe.ai',
    scopes: {
      list: document.getElementById('input-list-scope').value.trim() || '[data-ticket-list]',
      actions: document.getElementById('input-actions-scope').value.trim() || '[data-ticket-actions]',
    },
  };
  chrome.runtime.sendMessage({ action: 'saveSettings', settings }, (response) => {
    if (response?.error) { setStatus(response.error); return; }
    document.getElementById('stat-budget').textContent = ` / $${budgetUsd.toFixed(2)}`;
    setStatus('Settings saved');
  });
}

// ---------- Board rendering ----------

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  for (const lane of LANES) {
    const items = cards[lane.id];
    const details = document.createElement('details');
    details.className = `lane ${lane.css}`;
    details.id = `lane-${lane.id}`;
    if (items.length > 0) details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'lane-header';
    summary.innerHTML = `
      <span class="lane-name">${esc(lane.name)}</span>
      <span class="lane-count" data-count="${items.length}">${items.length}</span>
    `;
    details.appendChild(summary);

    if (items.length > 0) {
      const body = document.createElement('div');
      body.className = 'lane-body';
      for (const card of items) {
        body.appendChild(renderCard(card));
      }
      details.appendChild(body);
    }

    board.appendChild(details);
  }
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';

  const pct = Math.round((card.confidence || 0) * 100);
  const barClass = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low';

  let badgesHtml = '';
  if (card.refund) badgesHtml += '<span class="badge badge-refund">Refund</span>';
  if (card.photo && card.photo !== 'none') badgesHtml += `<span class="badge badge-photo">${esc(card.photo)}</span>`;
  if (card.urgent) badgesHtml += '<span class="badge badge-urgent-tag">Urgent</span>';
  if (card.latencyMs) badgesHtml += `<span class="badge badge-latency">${(card.latencyMs / 1000).toFixed(1)}s</span>`;

  el.innerHTML = `
    <div class="card-top">
      <span class="card-subject" title="${esc(card.subject).replaceAll('"', '&quot;')}">${esc(card.subject)}</span>
      <span class="card-confidence">${pct}%</span>
    </div>
    <div class="card-bar"><div class="card-bar-fill ${barClass}" style="width:${pct}%"></div></div>
    ${badgesHtml ? `<div class="card-badges">${badgesHtml}</div>` : ''}
  `;

  return el;
}

// ---------- Add a decision to a lane ----------

function addDecision(decision, title, latencyMs) {
  const card = {
    subject: title || `Ticket ${ticketCount + 1}`,
    confidence: decision.confidence,
    refund: decision.refund,
    photo: decision.photo,
    urgent: decision.urgent,
    mode: decision.mode,
    latencyMs,
  };

  // Urgent lane (cards also go to their category lane)
  if (decision.mode === 'auto' && decision.urgent) {
    cards.urgent.push(card);
  }

  // Category or human lane
  if (decision.mode !== 'auto') {
    cards.human.push(card);
  } else if (decision.category && cards[decision.category]) {
    cards[decision.category].push(card);
  }

  ticketCount++;
  renderBoard();
  updateRate();
}

// ---------- Stats ----------

function updateSpend(usd) {
  document.getElementById('stat-spend').textContent = `$${usd.toFixed(4)}`;
}

function updateRate() {
  if (!startTime) return;
  const minutes = (Date.now() - startTime) / 60_000;
  const rate = minutes > 0 ? (ticketCount / minutes).toFixed(1) : '0';
  document.getElementById('stat-rate').textContent = `${rate} t/min`;
}

function setStatus(text) {
  document.getElementById('statusbar').textContent = text;
}

// ---------- Event binding ----------

function bindEvents() {
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

  document.getElementById('btn-scan').addEventListener('click', () => {
    document.getElementById('btn-scan').disabled = true;
    setStatus('Scanning…');
    chrome.runtime.sendMessage({ action: 'scan' }, response => {
      document.getElementById('btn-scan').disabled = false;
      if (chrome.runtime.lastError || response?.error) setStatus(`Error: ${response?.error || chrome.runtime.lastError.message}`);
    });
  });

  const autopilotBtn = document.getElementById('btn-autopilot');
  autopilotBtn.addEventListener('click', () => {
    const isOn = autopilotBtn.dataset.state === 'on';
    if (isOn) {
      chrome.runtime.sendMessage({ action: 'autopilot:stop' });
      autopilotBtn.dataset.state = 'off';
      autopilotBtn.textContent = 'Autopilot';
      setStatus('Autopilot stopped');
    } else {
      startTime = Date.now();
      chrome.runtime.sendMessage({ action: 'autopilot:start' }, response => {
        if (chrome.runtime.lastError || response?.error) {
          autopilotBtn.dataset.state = 'off';
          autopilotBtn.textContent = 'Autopilot';
          setStatus(`Error: ${response?.error || chrome.runtime.lastError.message}`);
        }
      });
      autopilotBtn.dataset.state = 'on';
      autopilotBtn.textContent = 'Stop Autopilot';
      setStatus('Autopilot running…');
    }
  });
}

// ---------- Listen for events from background ----------

function listenForEvents() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'event') return;

    const event = msg.event;
    switch (event.type) {
      case 'scan:start':
        setStatus('Scanning…');
        break;

      case 'decision':
      case 'scan:result':
        if (!startTime) startTime = Date.now();
        if (event.decision) {
          addDecision(event.decision, event.title, event.latencyMs);
          setStatus(`Scanned: ${event.title || 'ticket'} → ${event.decision.category} (${Math.round((event.decision.confidence || 0) * 100)}%)`);
        }
        document.getElementById('btn-scan').disabled = false;
        break;

      case 'ticket':
        addDecision(event.decision, event.title, event.latencyMs);
        setStatus(`Triaged: ${event.title || 'ticket'} → ${event.decision.category}`);
        break;

      case 'budget':
        setStatus('Budget exhausted');
        break;

      case 'done':
        setStatus('All tickets processed');
        break;

      case 'stopped':
        setStatus('Autopilot stopped');
        break;

      case 'autopilot:started':
        setStatus('Autopilot running…');
        break;

      case 'autopilot:stopped': {
        const btn = document.getElementById('btn-autopilot');
        btn.dataset.state = 'off';
        btn.textContent = 'Autopilot';
        break;
      }

      case 'spend':
        updateSpend(event.spentUsd);
        break;

      case 'error':
        document.getElementById('btn-scan').disabled = false;
        setStatus(`Error: ${event.message}`);
        break;
    }
  });
}

// ---------- Helpers ----------

function esc(str) {
  if (!str) return '';
  const d = document.createElement('span');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- Boot ----------

init();
