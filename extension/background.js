/* ========================================================
   Jev Desk — background.js (service worker, MV3 module)
   Implements io adapter via chrome.tabs / chrome.scripting,
   handles messages from the side panel.
   ======================================================== */

import { createJev, CATEGORIES, screenshotState, triageQuestions, markQuestion, decide } from './core/jev.mjs';
import { runAgent } from './core/agent.mjs';

// ---------- Settings ----------

const DEFAULTS = { apiKey: '', budgetUsd: 1, spentUsd: 0, baseUrl: 'https://api.typesafe.ai', scopes: { list: '[data-ticket-list]', actions: '[data-ticket-actions]' } };

function validBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { return false; }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function updateSettings(patch) {
  await chrome.storage.local.set(patch);
}

let jevPromise;
let busy = false;
let settingsChanged = false;
async function getJev() {
  if (!jevPromise) jevPromise = getSettings().then(settings => {
    if (!settings.apiKey) throw new Error('Set your API key first');
    if (!validBaseUrl(settings.baseUrl)) throw new Error('Base URL must use HTTPS (or HTTP on localhost)');
    return createJev({
      apiKey: settings.apiKey, baseUrl: settings.baseUrl,
      budgetUsd: settings.budgetUsd, spentUsd: settings.spentUsd,
      onSpend: async total => {
        await updateSettings({ spentUsd: total });
        emit({ type: 'spend', spentUsd: total });
      },
    });
  }).catch(error => { jevPromise = null; throw error; });
  return jevPromise;
}

// ---------- Side panel setup ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ---------- Emit events to side panel & test listeners ----------

function emit(event) {
  const payload = { type: 'event', event };
  globalThis.lastEvent = payload;
  if (!globalThis.events) globalThis.events = [];
  globalThis.events.push(payload);
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// ---------- Tab helpers ----------

async function getTargetTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw new Error('Open a helpdesk web tab first');
  return tab;
}

async function injectMarks(tabId) {
  // Only inject if not already present
  const [{ result: exists }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => typeof window.jevMarks !== 'undefined',
  });
  if (!exists) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['core/marks.js'],
    });
  }
}

async function execInTab(tabId, func, ...args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result;
}

async function readTitle(tabId) {
  const title = await execInTab(tabId, () => {
    return document.querySelector('#detail-subject, .detail-subject')?.textContent?.trim()
      || document.querySelector('[data-ticket-subject]')?.textContent?.trim()
      || Array.from(document.querySelectorAll('h1, h2')).find(el => !el.closest('[data-ticket-list]'))?.textContent?.trim()
      || document.querySelector('h1, h2')?.textContent?.trim()
      || '';
  }).catch(() => '');
  return title || '';
}

// ---------- IO adapter for the agent ----------

function makeIo(tab) {
  const tabId = tab.id;
  const windowId = tab.windowId;
  let lastCapture = 0;
  return {
    async screenshot() {
      const remaining = 600 - (Date.now() - lastCapture);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      const [active] = await chrome.tabs.query({ active: true, windowId });
      if (active?.id !== tabId) throw new Error('Switch back to the helpdesk tab');
      await execInTab(tabId, () => window.jevMarks?.hideOverlay?.());
      let dataUrl;
      try {
        const [stillActive] = await chrome.tabs.query({ active: true, windowId });
        if (stillActive?.id !== tabId) throw new Error('Switch back to the helpdesk tab');
        dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        lastCapture = Date.now();
      } finally { await execInTab(tabId, () => window.jevMarks?.showOverlay?.()); }
      return dataUrl.replace(/^data:image\/\w+;base64,/, '');
    },
    async addMarks(scope, { strict = false } = {}) {
      await injectMarks(tabId);
      return execInTab(tabId, (s, strict) => window.jevMarks.add(s ? { scope: s, strict } : undefined), scope, strict);
    },
    async removeMarks() {
      return execInTab(tabId, () => window.jevMarks.remove());
    },
    async click(id) {
      return execInTab(tabId, (markId) => window.jevMarks.click(markId), id);
    },
    async box(fracBox, text) {
      return execInTab(tabId, (b, t) => window.jevMarks.box(b, t), fracBox, text);
    },
    async clearBox() {
      return execInTab(tabId, () => window.jevMarks.clearBox());
    },
    async toast(text) {
      return execInTab(tabId, (t) => window.jevMarks.toast(t), text);
    },
    async wait(ms) {
      return new Promise(r => setTimeout(r, ms));
    },
  };
}

// ---------- Scan: triage a single visible ticket ----------

async function runScan() {
  if (busy) throw new Error('A run is already active');
  busy = true;
  try {
    const tab = await getTargetTab();
    const jev = await getJev();
    const io = makeIo(tab);
    const { scopes } = await getSettings();
    emit({ type: 'scan:start' });
    const startSpend = jev.spent();
    // Step 2: triage the visible ticket (marks on [data-ticket-actions] or whole page)
    const actionMarks = (await io.addMarks(scopes.actions)) || [];
    const markScope = actionMarks.length > 0 ? actionMarks : ((await io.addMarks()) || []);
    const markCount = markScope.length;
    if (!markCount) throw new Error('No visible buttons to mark on this page');

    const screenshot = await io.screenshot();
    const { state, assets } = screenshotState(screenshot);
    const questions = triageQuestions();

    // Add mark questions for category buttons
    for (const [key, label] of CATEGORIES) {
      questions[`btn_${key}`] = markQuestion(`Which red label is on the "${label}" button in \`screen\`?`, markCount);
    }
    questions.btn_urgent = markQuestion('Which red label is on the "Urgent" button in `screen`?', markCount);
    questions.btn_escalate = markQuestion('Which red label is on the "Escalate to human" button in `screen`?', markCount);

    const result = await jev.ask({ state, questions, assets });
    const decision = decide(result.answers);

    // Draw marks + damage box, but do NOT click (leave marks on the page)
    if (decision.damageBox) {
      const { top, bottom, left, right } = decision.damageBox;
      await io.box([left, top, right - left, bottom - top], 'damage');
    }

    const title = await readTitle(tab.id) || 'Ticket 1';

    const decisionEvent = {
      type: 'decision',
      scanResult: true,
      decision,
      title,
      latencyMs: result.latencyMs,
      costUsd: jev.spent() - startSpend,
    };

    emit(decisionEvent);
    return decisionEvent;
  } catch (error) {
    emit({ type: 'error', message: error.message });
    throw error;
  } finally { busy = false; if (settingsChanged) { jevPromise = null; settingsChanged = false; } }
}

// ---------- Autopilot ----------

let autopilotAbort = null;

async function startAutopilot() {
  if (busy) return { error: 'A run is already active' };
  busy = true;
  autopilotAbort = new AbortController();
  const signal = autopilotAbort.signal;
  try {
    const tab = await getTargetTab();
    const jev = await getJev();
    const io = makeIo(tab);
    const { scopes } = await getSettings();
    emit({ type: 'autopilot:started' });
    let ticketNumber = 0;
    let pendingEvents = Promise.resolve();
    const result = await runAgent({
      jev,
      io,
      scopes,
      signal,
      onEvent: event => {
        pendingEvents = pendingEvents.then(async () => {
          if (event.type === 'ticket') {
            const fallback = `Ticket ${++ticketNumber}`;
            const title = await readTitle(tab.id);
            emit({ ...event, title: title || fallback });
          } else emit(event);
        });
      },
    });
    await pendingEvents;
    return result;
  } catch (error) {
    emit({ type: 'error', message: error.message });
    return { error: error.message };
  } finally {
    autopilotAbort = null;
    busy = false;
    if (settingsChanged) { jevPromise = null; settingsChanged = false; }
    emit({ type: 'autopilot:stopped' });
  }
}

function stopAutopilot() {
  autopilotAbort?.abort();
}

// ---------- Message handler ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'scan') {
    runScan()
      .then(res => sendResponse({ ok: true, ...res }))
      .catch(e => sendResponse({ error: e.message }));
    return true; // async
  }
  if (msg.action === 'autopilot:start') {
    if (busy) sendResponse({ error: 'A run is already active' });
    else { startAutopilot(); sendResponse({ ok: true }); }
    return false;
  }
  if (msg.action === 'autopilot:stop') {
    stopAutopilot();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === 'getSettings') {
    getSettings().then(s => sendResponse(s));
    return true;
  }
  if (msg.action === 'saveSettings') {
    if (!validBaseUrl(msg.settings.baseUrl)) { sendResponse({ error: 'Base URL must use HTTPS (or HTTP on localhost)' }); return false; }
    updateSettings(msg.settings).then(() => { if (busy) settingsChanged = true; else jevPromise = null; sendResponse({ ok: true }); });
    return true;
  }
});

// Expose on globalThis for Playwright SW evaluations
globalThis.runScan = runScan;
globalThis.startAutopilot = startAutopilot;
globalThis.stopAutopilot = stopAutopilot;
globalThis.getSettings = getSettings;
globalThis.updateSettings = updateSettings;
globalThis.events = [];
