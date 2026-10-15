import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../runner/run.mjs';
import { startStubJev } from './stub-jev.mjs';

const choice = value => ({ type: 'choice', choice: value, confidence: 0.97, probabilities: { [value]: 0.97 } });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-desk-e2e-'));
  const tickets = JSON.parse(await readFile(new URL('../helpdesk/tickets.json', import.meta.url)));
  let page;
  const stub = await startStubJev({ truthFor: async ({ questions }) => {
    const snapshot = await page.evaluate(() => ({
      next: document.querySelector('[data-ticket-list] [data-ticket-id]:has(.chip-new)')?.getAttribute('data-jev-mark'),
      activeId: Number(document.querySelector('[data-ticket-list] [data-ticket-id].active')?.getAttribute('data-ticket-id')),
      buttons: Object.fromEntries([...document.querySelectorAll('[data-ticket-actions] button')].map(button => [button.textContent, button.getAttribute('data-jev-mark')])),
    }));
    if (questions.next) return { next: choice(snapshot.next), any_new: { type: 'noul', noul: snapshot.next ? 0.99 : 0.01 } };
    const truth = tickets.find(ticket => ticket.id === snapshot.activeId).truth;
    const answers = {
      category: choice(truth.category), photo: choice(truth.photo),
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
  assert.equal(stub.calls.length, 1);
  assert.ok((await stat(reportPath)).size > 0);
});

test('runner rejects an invalid budget before opening the helpdesk', async () => {
  await assert.rejects(run({ apiKey: 'test', baseUrl: 'http://127.0.0.1:1', budgetUsd: Number.NaN }), /budgetUsd/);
});
