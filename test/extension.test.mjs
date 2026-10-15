import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../scripts/serve.mjs';

// Real Jev response shapes helper
const choice = (val, conf = 0.97) => ({
  type: 'choice',
  choice: val,
  confidence: conf,
  probabilities: { [val]: conf },
});

// Inline stub Jev server (does not depend on test/stub-jev.mjs)
function startInlineStubJev(answerHandler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/systemone') {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push(body);
      const answers = typeof answerHandler === 'function' ? await answerHandler(body) : answerHandler;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'jev-1.14.0',
        answers,
        usage: { input_tokens: 3000, output_tokens: 90 },
      }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: err.message }));
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

const extensionDir = resolve('extension');

async function launchExtensionContext() {
  const args = [
    '--headless=new',
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ];
  try {
    return await chromium.launchPersistentContext('', { channel: 'chromium', args });
  } catch {
    return await chromium.launchPersistentContext('', { args });
  }
}

async function getServiceWorker(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  }
  return sw;
}

test('extension service worker scan sets marks and returns decision event on helpdesk ticket', async (t) => {
  const helpdesk = await startServer(0);
  t.after(() => helpdesk.close());

  const stubAnswers = {
    category: choice('damaged', 0.96),
    photo: choice('damaged', 0.92),
    urgency: {
      type: 'score',
      score: 2.5,
      confidence: 0.85,
      legend: { 3: 'Now' },
      probabilities: { 3: 0.85 },
    },
    refund: { type: 'noul', noul: 0.88 },
    damage_box: {
      type: 'box',
      box: { top: 0.2, bottom: 0.5, left: 0.3, right: 0.6 },
      confidence: 0.91,
    },
    btn_refund: choice('m1'),
    btn_shipping: choice('m2'),
    btn_billing: choice('m3'),
    btn_account: choice('m4'),
    btn_order: choice('m5'),
    btn_damaged: choice('m6'),
    btn_wrong_item: choice('m7'),
    btn_spam: choice('m8'),
    btn_urgent: choice('m9'),
    btn_escalate: choice('m10'),
  };

  const stubJev = await startInlineStubJev(stubAnswers);
  t.after(() => stubJev.close());

  const context = await launchExtensionContext();
  t.after(() => context.close());

  const sw = await getServiceWorker(context);
  assert.ok(sw, 'Service worker must be running');

  // Configure extension storage via service worker
  await sw.evaluate(async (baseUrl) => {
    await chrome.storage.local.set({
      apiKey: 'test-key',
      baseUrl,
      budgetUsd: 1,
    });
  }, stubJev.url);

  // Open helpdesk in the browser
  const page = context.pages()[0] || await context.newPage();
  await page.goto(helpdesk.url);

  // Click on the first ticket to open detail view
  await page.waitForSelector('[data-ticket-list] [data-ticket-id]');
  await page.click('[data-ticket-list] [data-ticket-id]');
  await page.waitForSelector('[data-ticket-actions]');

  // Trigger scan by evaluating in the service worker
  const decisionEvent = await sw.evaluate(() => runScan());

  // Assert decision event structure and values
  assert.ok(decisionEvent, 'Scan must return a decision event');
  assert.equal(decisionEvent.event, 'decision');
  assert.equal(decisionEvent.decision.category, 'damaged');
  assert.equal(decisionEvent.decision.confidence, 0.96);
  assert.equal(decisionEvent.decision.urgent, true);
  assert.equal(decisionEvent.decision.photo, 'damaged');
  assert.deepEqual(decisionEvent.decision.damageBox, { top: 0.2, bottom: 0.5, left: 0.3, right: 0.6 });
  assert.ok(decisionEvent.title, 'Decision event should include ticket title');

  // Assert marks and damage box exist on the page
  const markCount = await page.locator('.jev-mark').count();
  assert.ok(markCount >= 8, `Marks must exist on the page (found ${markCount})`);

  const boxCount = await page.locator('.jev-box').count();
  assert.equal(boxCount, 1, 'Damage box must exist on the page');
  assert.equal(await page.locator('.jev-box').textContent(), 'damage');

  // Assert stub received the call
  assert.equal(stubJev.calls.length, 1);
  assert.ok(stubJev.calls[0].questions.category);
});

test('extension side panel renders all 10 lanes, confidence bars, and reflects scan results', async (t) => {
  const helpdesk = await startServer(0);
  t.after(() => helpdesk.close());

  const stubAnswers = {
    category: choice('shipping', 0.94),
    photo: choice('none', 0.99),
    urgency: {
      type: 'score',
      score: 1.0,
      confidence: 0.8,
      legend: { 1: 'Normal' },
      probabilities: { 1: 0.8 },
    },
    refund: { type: 'noul', noul: 0.1 },
    damage_box: {
      type: 'box',
      box: { top: 0.1, bottom: 0.3, left: 0.2, right: 0.4 },
      confidence: 0.5,
    },
    btn_refund: choice('m1'),
    btn_shipping: choice('m2'),
    btn_billing: choice('m3'),
    btn_account: choice('m4'),
    btn_order: choice('m5'),
    btn_damaged: choice('m6'),
    btn_wrong_item: choice('m7'),
    btn_spam: choice('m8'),
    btn_urgent: choice('m9'),
    btn_escalate: choice('m10'),
  };

  const stubJev = await startInlineStubJev(stubAnswers);
  t.after(() => stubJev.close());

  const context = await launchExtensionContext();
  t.after(() => context.close());

  const sw = await getServiceWorker(context);
  const extId = new URL(sw.url()).host;

  await sw.evaluate(async (baseUrl) => {
    await chrome.storage.local.set({
      apiKey: 'test-key',
      baseUrl,
      budgetUsd: 1,
    });
  }, stubJev.url);

  // Open helpdesk tab
  const helpdeskPage = context.pages()[0] || await context.newPage();
  await helpdeskPage.goto(helpdesk.url);
  await helpdeskPage.waitForSelector('[data-ticket-list] [data-ticket-id]');
  await helpdeskPage.click('[data-ticket-list] [data-ticket-id]');
  await helpdeskPage.waitForSelector('[data-ticket-actions]');

  // Open side panel page
  const sidepanelPage = await context.newPage();
  await sidepanelPage.goto(`chrome-extension://${extId}/sidepanel.html`);

  // Assert all 10 lanes are present
  const laneIds = ['urgent', 'refund', 'shipping', 'billing', 'account', 'order', 'damaged', 'wrong_item', 'spam', 'human'];
  for (const id of laneIds) {
    const lane = sidepanelPage.locator(`#lane-${id}`);
    assert.equal(await lane.count(), 1, `Lane #${id} must exist in the side panel`);
  }

  // Click Scan this ticket on the side panel
  await sidepanelPage.click('#btn-scan');

  // Wait for card to appear in the shipping lane
  await sidepanelPage.waitForSelector('#lane-shipping .card');
  const cardCount = await sidepanelPage.locator('#lane-shipping .card').count();
  assert.equal(cardCount, 1, 'Card should be added to shipping lane');

  // Verify lane count badge updated
  const countText = await sidepanelPage.locator('#lane-shipping .lane-count').textContent();
  assert.equal(countText, '1');

  // Verify card content: subject, confidence bar, confidence percentage
  const cardSubject = await sidepanelPage.locator('#lane-shipping .card-subject').textContent();
  assert.ok(cardSubject.length > 0, 'Card subject must be displayed');

  const cardConfidence = await sidepanelPage.locator('#lane-shipping .card-confidence').textContent();
  assert.equal(cardConfidence, '94%');

  const fillClass = await sidepanelPage.locator('#lane-shipping .card-bar-fill').getAttribute('class');
  assert.ok(fillClass.includes('high'), 'High confidence bar class should be applied');

  // Verify marks were placed on helpdesk page
  const markCount = await helpdeskPage.locator('.jev-mark').count();
  assert.ok(markCount > 0, 'Marks must exist on the helpdesk page');
});
