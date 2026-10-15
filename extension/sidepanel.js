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
    document.getElementById('input-baseurl').value = settings.baseUrl || 'https://api.typesafe.ai';
    updateSpend(settings.spentUsd || 0);
  });
}

function saveSettings() {
  const settings = {
    apiKey: document.getElementById('input-apikey').value.trim(),
    budgetUsd: Number(document.getElementById('input-budget').value) || 1,
    baseUrl: document.getElementById('input-baseurl').value.trim() || 'https://api.typesafe.ai',
  };
  chrome.runtime.sendMessage({ action: 'saveSettings', settings }, () => {
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
      <span class="card-subject" title="${esc(card.subject)}">${esc(card.subject)}</span>
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
    subject: title || 'Untitled ticket',
    confidence: decision.confidence,
    refund: decision.refund,
    photo: decision.photo,
    urgent: decision.urgent,
    mode: decision.mode,
    latencyMs,
  };

  // Urgent lane (cards also go to their category lane)
  if (decision.urgent) {
    cards.urgent.push(card);
  }

  // Category or human lane
  if (decision.mode === 'human') {
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
    chrome.runtime.sendMessage({ action: 'scan' }, () => {
      // Response comes via events
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
      chrome.runtime.sendMessage({ action: 'autopilot:start' });
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

    switch (msg.event) {
      case 'scan:start':
        setStatus('Scanning…');
        break;

      case 'decision':
      case 'scan:result':
        if (!startTime) startTime = Date.now();
        if (msg.decision) {
          addDecision(msg.decision, msg.title, msg.latencyMs);
          setStatus(`Scanned: ${msg.title || 'ticket'} → ${msg.decision.category} (${Math.round((msg.decision.confidence || 0) * 100)}%)`);
        }
        document.getElementById('btn-scan').disabled = false;
        if (msg.costUsd != null) updateSpend((parseFloat(document.getElementById('stat-spend').textContent.slice(1)) || 0) + msg.costUsd);
        break;

      case 'autopilot:event':
        if (msg.decision) {
          addDecision(msg.decision, msg.title, msg.latencyMs);
          setStatus(`Triaged: ${msg.title || 'ticket'} → ${msg.decision.category}`);
        } else if (msg.subtype === 'budget' || msg.type === 'budget') {
          setStatus('Budget exhausted');
        } else if (msg.subtype === 'done' || msg.type === 'done') {
          setStatus('All tickets processed');
        }
        break;

      case 'autopilot:started':
        setStatus('Autopilot running…');
        break;

      case 'autopilot:stopped': {
        const btn = document.getElementById('btn-autopilot');
        btn.dataset.state = 'off';
        btn.textContent = 'Autopilot';
        setStatus('Autopilot stopped');
        break;
      }

      case 'spend':
        updateSpend(msg.spentUsd);
        break;

      case 'error':
        document.getElementById('btn-scan').disabled = false;
        setStatus(`Error: ${msg.message}`);
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
