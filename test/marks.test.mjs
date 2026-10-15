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
