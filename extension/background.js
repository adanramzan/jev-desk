/* ========================================================
   Jev Desk — background.js (service worker, MV3 module)
   Implements io adapter via chrome.tabs / chrome.scripting,
   handles messages from the side panel.
   ======================================================== */

import { createJev, CATEGORIES, screenshotState, triageQuestions, markQuestion, decide } from './core/jev.mjs';
import { runAgent } from './core/agent.mjs';

// ---------- Settings ----------

const DEFAULTS = { apiKey: '', budgetUsd: 1, spentUsd: 0, baseUrl: 'https://api.typesafe.ai' };

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function updateSettings(patch) {
  await chrome.storage.local.set(patch);
}

// ---------- Side panel setup ----------

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});

// ---------- Emit events to side panel & test listeners ----------

function emit(event) {
  const payload = { type: 'event', ...event };
  globalThis.lastEvent = payload;
  if (!globalThis.events) globalThis.events = [];
  globalThis.events.push(payload);
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// ---------- Tab helpers ----------

async function getTargetTab() {
  const allTabs = await chrome.tabs.query({});
  // Prioritize web content tabs (exclude extension pages, chrome://, about:, etc.)
  const contentTabs = allTabs.filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'));
  
  const activeContentTab = contentTabs.find(t => t.active);
  if (activeContentTab) return activeContentTab;

  if (contentTabs.length > 0) return contentTabs[0];

  const [activeCur] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeCur || allTabs[0];
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
  return title || 'Untitled ticket';
}

// ---------- IO adapter for the agent ----------

function makeIo(tab) {
  const tabId = tab.id;
  const windowId = tab.windowId;
  return {
    async screenshot() {
      // Hide overlays before capture
      await execInTab(tabId, () => window.jevMarks?.hideOverlay?.());
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      await execInTab(tabId, () => window.jevMarks?.showOverlay?.());
      return dataUrl.replace(/^data:image\/\w+;base64,/, '');
    },
    async addMarks(scope) {
      await injectMarks(tabId);
      return execInTab(tabId, (s) => window.jevMarks.add(s ? { scope: s } : undefined), scope);
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
  const tab = await getTargetTab();
  if (!tab?.id) { emit({ event: 'error', message: 'No active tab' }); return; }

  const settings = await getSettings();
  const isLocal = settings.baseUrl?.includes('localhost') || settings.baseUrl?.includes('127.0.0.1');
  if (!settings.apiKey && !isLocal) {
    emit({ event: 'error', message: 'Set your API key first' });
    return;
  }
  const apiKey = settings.apiKey || 'test-key';

  const jev = createJev({
    apiKey,
    baseUrl: settings.baseUrl,
    budgetUsd: settings.budgetUsd,
    spentUsd: settings.spentUsd,
    onSpend: async (total) => {
      await updateSettings({ spentUsd: total });
      emit({ event: 'spend', spentUsd: total });
    },
  });

  const io = makeIo(tab);
  emit({ event: 'scan:start' });

  try {
    // Step 2: triage the visible ticket (marks on [data-ticket-actions] or whole page)
    const actionMarks = (await io.addMarks('[data-ticket-actions]')) || [];
    const markScope = actionMarks.length > 0 ? actionMarks : ((await io.addMarks()) || []);
    const markCount = markScope.length;

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

    const title = await readTitle(tab.id);

    const decisionEvent = {
      type: 'event',
      event: 'decision',
      scanResult: true,
      decision,
      title,
      latencyMs: result.latencyMs,
      costUsd: jev.spent() - settings.spentUsd,
    };

    emit(decisionEvent);
    return decisionEvent;
  } catch (error) {
    emit({ event: 'error', message: error.message });
    throw error;
  }
}

// ---------- Autopilot ----------

let autopilotAbort = null;

async function startAutopilot() {
  if (autopilotAbort) return;
  autopilotAbort = new AbortController();
  const signal = autopilotAbort.signal;

  const tab = await getTargetTab();
  if (!tab?.id) { emit({ event: 'error', message: 'No active tab' }); autopilotAbort = null; return; }

  const settings = await getSettings();
  const isLocal = settings.baseUrl?.includes('localhost') || settings.baseUrl?.includes('127.0.0.1');
  if (!settings.apiKey && !isLocal) {
    emit({ event: 'error', message: 'Set your API key first' });
    autopilotAbort = null;
    return;
  }
  const apiKey = settings.apiKey || 'test-key';

  const jev = createJev({
    apiKey,
    baseUrl: settings.baseUrl,
    budgetUsd: settings.budgetUsd,
    spentUsd: settings.spentUsd,
    onSpend: async (total) => {
      await updateSettings({ spentUsd: total });
      emit({ event: 'spend', spentUsd: total });
    },
  });

  const io = makeIo(tab);
  emit({ event: 'autopilot:started' });

  try {
    await runAgent({
      jev,
      io,
      onEvent: async (event) => {
        if (signal.aborted) return;
        let title = '';
        if (event.type === 'ticket') {
          title = await readTitle(tab.id);
          event.title = title;
        }
        emit({
          event: event.type === 'ticket' ? 'decision' : 'autopilot:event',
          subtype: event.type,
          ...event,
        });
      },
    });
  } catch (error) {
    if (!signal.aborted) emit({ event: 'error', message: error.message });
  }

  autopilotAbort = null;
  emit({ event: 'autopilot:stopped' });
}

function stopAutopilot() {
  if (autopilotAbort) {
    autopilotAbort.abort();
    autopilotAbort = null;
  }
  emit({ event: 'autopilot:stopped' });
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
    startAutopilot();
    sendResponse({ ok: true });
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
    updateSettings(msg.settings).then(() => sendResponse({ ok: true }));
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
