import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const marksPath = new URL('../core/marks.js', import.meta.url).pathname;

test('evidence box is cleared when another ticket row is opened, kept on action clicks', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div data-ticket-id="1">Ticket 1</div><div data-ticket-id="2">Ticket 2</div><button>Damaged item</button>');
    await page.addScriptTag({ path: marksPath });
    const boxes = () => page.evaluate(() => document.querySelectorAll('#jev-overlay .jev-box').length);

    const marks = await page.evaluate(() => window.jevMarks.add());
    await page.evaluate(() => window.jevMarks.box([0.1, 0.1, 0.2, 0.2], 'damage'));
    assert.equal(await boxes(), 1);

    const button = marks.find(m => m.label === '3').id;
    await page.evaluate(id => window.jevMarks.click(id), button);
    assert.equal(await boxes(), 1, 'clicking an action keeps the evidence visible');

    await page.evaluate(id => window.jevMarks.click(id), marks[1].id);
    assert.equal(await boxes(), 0, 'opening another ticket clears it');
  } finally {
    await browser.close();
  }
});

test('strict missing scope leaves unrelated buttons unmarked', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<button>Dangerous unrelated action</button>');
    await page.addScriptTag({ path: marksPath });
    assert.deepEqual(await page.evaluate(() => window.jevMarks.add({ scope: '[data-ticket-list]', strict: true })), []);
    assert.equal(await page.locator('.jev-mark').count(), 0);
    assert.equal(await page.locator('[data-jev-mark]').count(), 0);
  } finally { await browser.close(); }
});

test('rows scrolled out of their list are not marked', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    const rows = Array.from({ length: 10 }, (_, i) => `<div data-ticket-id="${i + 1}" style="height:50px">Row ${i + 1}</div>`).join('');
    await page.setContent(`<div data-ticket-list style="height:150px;overflow:auto">${rows}</div>`);
    await page.addScriptTag({ path: marksPath });
    await page.evaluate(() => { document.querySelector('[data-ticket-list]').scrollTop = 100; });
    await page.evaluate(() => window.jevMarks.add({ scope: '[data-ticket-list]', strict: true }));
    const marked = await page.evaluate(() => [...document.querySelectorAll('[data-jev-mark]')].map(e => e.dataset.ticketId));
    assert.deepEqual(marked, ['3', '4', '5'], 'only the rows visible inside the scrolled list');
  } finally { await browser.close(); }
});

test('labels of tall rows sit inside the row, labels of small buttons on their corner', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div data-ticket-id="1" style="height:60px;margin-top:20px">Row</div><button style="height:28px">Billing</button>');
    await page.addScriptTag({ path: marksPath });
    await page.evaluate(() => window.jevMarks.add());
    const [row, rowLabel, btn, btnLabel] = await page.evaluate(() => {
      const r = el => el.getBoundingClientRect().top;
      const labels = [...document.querySelectorAll('.jev-mark')];
      return [r(document.querySelector('[data-ticket-id]')), r(labels[0]), r(document.querySelector('button')), r(labels[1])];
    });
    assert.ok(rowLabel > row + 10, 'row label is inside the row, away from its top border');
    assert.equal(btnLabel, btn, 'button label on the top-left corner');
  } finally { await browser.close(); }
});
