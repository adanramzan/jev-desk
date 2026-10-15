import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { run } from '../runner/run.mjs';
import { startServer } from '../scripts/serve.mjs';
import { startStubJev } from './stub-jev.mjs';

const choice = value => ({ type: 'choice', choice: value, confidence: 0.97, probabilities: { [value]: 0.97 } });

async function fixture(t, { wrongId, outOfOrder = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-desk-e2e-'));
  const tickets = JSON.parse(await readFile(new URL('../helpdesk/tickets.json', import.meta.url)));
  let page;
  let selectedFirst = false;
  const stub = await startStubJev({ truthFor: async ({ questions }) => {
    const snapshot = await page.evaluate(() => ({
      newMarks: [...document.querySelectorAll('[data-ticket-list] [data-ticket-id]:has(.chip-new)')].map(row => row.getAttribute('data-jev-mark')),
      activeId: Number(document.querySelector('[data-ticket-list] [data-ticket-id].active')?.getAttribute('data-ticket-id')),
      buttons: Object.fromEntries([...document.querySelectorAll('[data-ticket-actions] button')].map(button => [button.textContent, button.getAttribute('data-jev-mark')])),
    }));
    if (questions.next) {
      const next = snapshot.newMarks[outOfOrder && !selectedFirst ? 1 : 0];
      selectedFirst = true;
      return { next: choice(next), any_new: { type: 'noul', noul: next ? 0.99 : 0.01 } };
    }
    const truth = tickets.find(ticket => ticket.id === snapshot.activeId).truth;
    const answers = {
      category: choice(snapshot.activeId === wrongId ? (truth.category === 'refund' ? 'shipping' : 'refund') : truth.category), photo: choice(truth.photo),
      urgency: { type: 'score', score: 1.4, confidence: 0.5, legend: {}, probabilities: {} },
      refund: { type: 'noul', noul: 0.12 },
      damage_box: { type: 'box', box: { top: 0.2, bottom: 0.5, left: 0.3, right: 0.6 }, confidence: 0.9 },
    };
    for (const [key, label] of Object.entries({ refund: 'Refund', shipping: 'Shipping', billing: 'Billing', account: 'Account', order: 'Order change', damaged: 'Damaged item', wrong_item: 'Wrong item', spam: 'Spam', urgent: 'Urgent', escalate: 'Escalate to human' })) answers[`btn_${key}`] = choice(snapshot.buttons[label]);
    return answers;
  } });
  t.after(() => stub.close());
  return { dir, stub, tickets, onPage: opened => { page = opened; } };
}

test('runner triages five real helpdesk tickets and writes accurate eval and ledger', async t => {
  const { dir, stub, tickets, onPage } = await fixture(t);
  const { report, reportPath } = await run({ eval: true, limit: 5, baseUrl: stub.url, apiKey: 'test', ledgerPath: join(dir, 'ledger.json'), reportsDir: dir, onPage, log: () => {} });
  assert.equal(report.handled, 5);
  assert.equal(report.totalTickets, 50);
  assert.equal(report.accuracy, 1);
  assert.equal(report.autoRate, 1);
  assert.equal(report.stoppedBy, 'max');
  assert.deepEqual(report.tickets.map(ticket => ticket.id), tickets.slice(0, 5).map(ticket => ticket.id));
  assert.ok(report.tickets.every(ticket => ticket.status === 'Triaged' && ticket.correct));
  assert.equal(stub.calls.length, 10);
  assert.ok((await stat(reportPath)).size > 0);
  assert.ok((await stat(reportPath.replace(/\.md$/, '.json'))).size > 0);
  assert.ok(JSON.parse(await readFile(join(dir, 'ledger.json'))).spentUsd > 0);
});

test('runner stops at the spend budget and still writes a report', async t => {
  const { dir, stub, onPage } = await fixture(t);
  const { report, reportPath } = await run({ eval: true, limit: 5, budgetUsd: 0.000001, baseUrl: stub.url, apiKey: 'test', ledgerPath: join(dir, 'ledger.json'), reportsDir: dir, onPage, log: () => {} });
  assert.equal(report.stoppedBy, 'budget');
  assert.equal(report.handled, 0);
  assert.equal(report.accuracy, null);
  assert.equal(report.autoAccuracy, null);
  assert.equal(report.photoAccuracy, null);
  assert.match(await readFile(reportPath, 'utf8'), /Handled 0 of 50 tickets · Stopped by: budget[\s\S]*Decision accuracy \| n\/a/);
  assert.equal(stub.calls.length, 1);
  assert.ok((await stat(reportPath)).size > 0);
});

test('eval joins decisions to opened tickets and reports wrong categories', async t => {
  const { dir, stub, tickets, onPage } = await fixture(t, { wrongId: 1002, outOfOrder: true });
  const { report, reportPath } = await run({ eval: true, limit: 3, baseUrl: stub.url, apiKey: 'test', ledgerPath: join(dir, 'ledger.json'), reportsDir: dir, onPage, log: () => {} });
  assert.equal(report.tickets[0].id, tickets[1].id);
  assert.equal(report.handled, 3);
  assert.equal(report.accuracy, 2 / 3);
  assert.deepEqual(report.confusion, [{ id: 1002, truth: tickets[1].truth.category, decided: tickets[1].truth.category === 'refund' ? 'shipping' : 'refund' }]);
  assert.match(await readFile(reportPath, 'utf8'), /## Confusion[\s\S]*#1002:/);
});

test('eval handles all 50 tickets with visible New rows', async t => {
  const { dir, stub, onPage } = await fixture(t);
  const { report, reportPath } = await run({ eval: true, limit: 50, baseUrl: stub.url, apiKey: 'test', ledgerPath: join(dir, 'ledger.json'), reportsDir: dir, onPage, log: () => {} });
  assert.equal(report.handled, 50);
  assert.equal(report.totalTickets, 50);
  assert.equal(report.accuracy, 1);
  assert.equal(report.duplicates.length, 0);
  assert.ok(report.tickets.every(ticket => ticket.status === 'Triaged'));
  assert.match(await readFile(reportPath, 'utf8'), /Handled 50 of 50 tickets/);
});

test('runner rejects an invalid budget before opening the helpdesk', async () => {
  await assert.rejects(run({ apiKey: 'test', baseUrl: 'http://127.0.0.1:1', budgetUsd: Number.NaN }), /budgetUsd/);
  await assert.rejects(run({ apiKey: 'test', baseUrl: 'http://127.0.0.1:1', budgetUsd: 0 }), /budgetUsd/);
});

test('CLI rejects non-numeric flags before connecting to Jev', () => {
  for (const flag of ['--limit', '--slow', '--budget']) {
    const result = spawnSync(process.execPath, [new URL('../runner/run.mjs', import.meta.url).pathname, '--eval', flag, 'NaN'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a valid number/);
  }
});

test('Unassigned removes handled rows while the detail stays open and All keeps them', async t => {
  const server = await startServer(0);
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${server.url}/?reset`);
  await page.locator('[data-ticket-id]').first().click();
  const subject = await page.locator('#detail-subject').textContent();
  await page.getByRole('button', { name: 'Refund', exact: true }).click();
  await page.getByRole('button', { name: 'Urgent', exact: true }).click();
  assert.equal(await page.locator('#detail-subject').textContent(), subject);
  assert.equal(await page.locator('#detail-actions .action-btn-urgent').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-ticket-list] [data-ticket-id]').count(), 49);
  assert.equal(await page.locator('#tab-unassigned').textContent(), 'Unassigned (49)');
  await page.locator('#tab-all').click();
  assert.equal(await page.locator('[data-ticket-list] [data-ticket-id]').count(), 50);
  assert.match(await page.locator('[data-ticket-id="1001"]').textContent(), /Triaged/);
  assert.match(await page.locator('[data-ticket-id="1001"]').textContent(), /Urgent/);
});

test('marks injection preserves the overlay and replaces an earlier box', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const marksScript = await readFile(new URL('../core/marks.js', import.meta.url), 'utf8');
  await page.setContent('<button>Ticket</button>');
  await page.addScriptTag({ content: marksScript });
  await page.evaluate(() => {
    window.jevMarks.add();
    window.jevMarks.box([0, 0, 0.5, 0.5], 'first');
    window.originalJevMarks = window.jevMarks;
    window.originalOverlay = document.getElementById('jev-overlay');
  });
  await page.addScriptTag({ content: marksScript });
  assert.deepEqual(await page.evaluate(() => ({
    roots: document.querySelectorAll('#jev-overlay').length,
    labels: document.querySelectorAll('.jev-mark').length,
    boxes: document.querySelectorAll('.jev-box').length,
    sameApi: window.jevMarks === window.originalJevMarks,
    sameRoot: document.getElementById('jev-overlay') === window.originalOverlay,
  })), { roots: 1, labels: 1, boxes: 1, sameApi: true, sameRoot: true });
  await page.evaluate(() => window.jevMarks.box([0.5, 0.5, 0.2, 0.2], 'second'));
  assert.deepEqual(await page.evaluate(() => ({
    boxes: document.querySelectorAll('.jev-box').length,
    caption: document.querySelector('.jev-box')?.textContent,
  })), { boxes: 1, caption: 'second' });
});
