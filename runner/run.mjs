import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJev, CATEGORIES } from '../core/jev.mjs';
import { runAgent } from '../core/agent.mjs';
import { startServer } from '../scripts/serve.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const marksPath = join(root, 'core/marks.js');
const labelFor = Object.fromEntries(CATEGORIES.map(([key, label]) => [key, label]));
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : 0;
const rate = (n, total) => total ? n / total : 0;

async function getApiKey() {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  const env = await readFile(join(homedir(), '.ragbench/jev.env'), 'utf8').catch(() => '');
  return /(?:^|\n)\s*(?:export\s+)?JEV_API_KEY\s*=\s*["']?([^\s"'#]+)/.exec(env)?.[1];
}

function summarize(events, states, truth, stoppedBy, spentUsd) {
  const stateById = new Map(states.map(state => [state.id, state]));
  const truthById = new Map(truth.map(ticket => [ticket.id, ticket]));
  const tickets = events.map(event => {
    const ticket = truthById.get(event.id);
    const state = stateById.get(event.id);
    return {
      id: event.id, title: ticket?.subject, truth: ticket?.truth.category,
      decided: event.decision.category, mode: event.decision.mode, confidence: event.decision.confidence,
      photo: event.decision.photo, photoTruth: ticket?.truth.photo,
      status: state?.status, category: state?.category, clicked: event.clicked,
      correct: event.decision.category === ticket?.truth.category,
      latencyMs: event.latencyMs, costUsd: event.costUsd,
    };
  });
  const auto = tickets.filter(ticket => ticket.mode === 'auto');
  const imageTickets = tickets.filter(ticket => ticket.photoTruth !== 'none');
  const perCategory = Object.fromEntries(CATEGORIES.map(([key]) => {
    const subset = tickets.filter(ticket => ticket.truth === key);
    return [key, { count: subset.length, accuracy: rate(subset.filter(ticket => ticket.correct).length, subset.length) }];
  }));
  return {
    handled: tickets.length, stoppedBy, accuracy: rate(tickets.filter(ticket => ticket.correct).length, tickets.length),
    autoAccuracy: rate(auto.filter(ticket => ticket.correct).length, auto.length),
    autoRate: rate(auto.length, tickets.length), escalationRate: rate(tickets.length - auto.length, tickets.length),
    clickAccuracy: rate(auto.filter(ticket => ticket.category === ticket.decided && ticket.status === 'Triaged').length, auto.length),
    photoAccuracy: rate(imageTickets.filter(ticket => ticket.photo === ticket.photoTruth).length, imageTickets.length),
    perCategory, confusion: tickets.filter(ticket => !ticket.correct).map(({ id, truth, decided }) => ({ id, truth, decided })),
    p50LatencyMs: percentile(tickets.map(ticket => ticket.latencyMs), 0.5),
    p95LatencyMs: percentile(tickets.map(ticket => ticket.latencyMs), 0.95),
    totalCostUsd: spentUsd, costPer1kUsd: rate(spentUsd * 1000, tickets.length), tickets,
  };
}

function markdown(report) {
  const pct = value => `${(value * 100).toFixed(1)}%`;
  const rows = [
    ['Tickets', report.handled], ['Stopped by', report.stoppedBy], ['Decision accuracy', pct(report.accuracy)],
    ['Auto accuracy', pct(report.autoAccuracy)], ['Auto rate', pct(report.autoRate)],
    ['Escalation rate', pct(report.escalationRate)], ['Click accuracy', pct(report.clickAccuracy)],
    ['Photo accuracy (image tickets)', pct(report.photoAccuracy)],
    ['p50 latency', `${report.p50LatencyMs.toFixed(0)} ms`], ['p95 latency', `${report.p95LatencyMs.toFixed(0)} ms`],
    ['Total cost', `$${report.totalCostUsd.toFixed(6)}`], ['Cost per 1k tickets', `$${report.costPer1kUsd.toFixed(4)}`],
  ];
  return `# Jev Desk eval\n\n| Metric | Value |\n| --- | ---: |\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n\n## Per category\n\n| Category | Count | Accuracy |\n| --- | ---: | ---: |\n${Object.entries(report.perCategory).map(([key, value]) => `| ${labelFor[key]} | ${value.count} | ${pct(value.accuracy)} |`).join('\n')}\n\n## Confusion\n\n${report.confusion.length ? report.confusion.map(item => `- #${item.id}: ${item.truth} → ${item.decided}`).join('\n') : 'None'}\n`;
}

export async function run({ eval: evaluate = false, headed = !evaluate, limit = Infinity, slow = 0, budgetUsd = 4, baseUrl, apiKey, ledgerPath = '.jev-spend.json', reportsDir = 'reports', log = console.log, onPage } = {}) {
  if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('budgetUsd must be a finite positive number');
  const key = apiKey || await getApiKey();
  if (!key) throw new Error('JEV_API_KEY is required');
  const ledgerFile = resolve(ledgerPath);
  const outputDir = resolve(reportsDir);
  const spentBefore = JSON.parse(await readFile(ledgerFile, 'utf8').catch(() => '{"spentUsd":0}')).spentUsd;
  if (typeof spentBefore !== 'number' || !Number.isFinite(spentBefore) || spentBefore < 0) throw new Error('Invalid spend ledger');
  const budget = Math.min(4, budgetUsd);
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: !headed, slowMo: slow });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript({ path: marksPath });
    await page.goto(`${server.url}/?reset`);
    if (!await page.evaluate(() => Boolean(window.jevMarks))) await page.addScriptTag({ path: marksPath });
    await page.locator('[data-ticket-list] [data-ticket-id]').first().waitFor();
    await onPage?.(page);
    let lastTicketId;
    const io = {
      addMarks: scope => page.evaluate(scope => window.jevMarks.add({ scope }), scope),
      removeMarks: () => page.evaluate(() => window.jevMarks.remove()),
      click: async id => {
        const ticketId = await page.evaluate(id => document.querySelector(`[data-jev-mark="${id}"]`)?.closest('[data-ticket-id]')?.dataset.ticketId, id);
        if (ticketId) lastTicketId = Number(ticketId);
        if (!await page.evaluate(id => window.jevMarks.click(id), id)) throw new Error(`Unknown mark ${id}`);
      },
      screenshot: async () => {
        await page.evaluate(() => window.jevMarks.hideOverlay());
        try { return (await page.screenshot({ type: 'png' })).toString('base64'); }
        finally { await page.evaluate(() => window.jevMarks.showOverlay()); }
      },
      box: (box, caption) => page.evaluate(([box, caption]) => window.jevMarks.box(box, caption), [box, caption]),
      toast: message => page.evaluate(message => window.jevMarks.toast(message), message),
      wait: ms => page.waitForTimeout(ms),
    };
    const jev = createJev({ apiKey: key, baseUrl, budgetUsd: budget, spentUsd: spentBefore,
      onSpend: spentUsd => writeFileSync(ledgerFile, JSON.stringify({ spentUsd }) + '\n'),
    });
    const events = [];
    const visualTasks = [];
    const errors = [];
    const result = await runAgent({ jev, io, maxTickets: limit, onEvent: event => {
      if (event.type === 'error') { errors.push(event.message); log(`Error: ${event.message}`); }
      if (event.type !== 'ticket') return;
      events.push({ ...event, id: lastTicketId });
      const line = `#${lastTicketId}  ${labelFor[event.decision.category] || event.decision.category}  ${Math.round(event.decision.confidence * 100)}%  ${event.decision.mode}  📸 ${event.decision.photo}  ${Math.round(event.latencyMs)} ms  $${event.costUsd.toFixed(5)}`;
      if (!evaluate) log(line);
      visualTasks.push(io.toast(`${labelFor[event.decision.category] || event.decision.category} · ${Math.round(event.decision.confidence * 100)}% · ${event.decision.mode} · ${(event.latencyMs / 1000).toFixed(2)} s`));
    } });
    await Promise.all(visualTasks);
    const states = await page.evaluate(() => window.helpline.state());
    const report = summarize(events, states, truth, result.stoppedBy, jev.spent() - spentBefore);
    report.errors = errors;
    await io.toast(`${report.handled} tickets · ${(report.accuracy * 100).toFixed(0)}% correct · $${report.totalCostUsd.toFixed(5)} spent`);
    if (!evaluate) await page.waitForTimeout(Math.max(1500, slow * 4));
    await mkdir(outputDir, { recursive: true });
    const reportPath = join(outputDir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    await writeFile(reportPath, markdown(report));
    await writeFile(reportPath.replace(/\.md$/, '.json'), JSON.stringify(report, null, 2) + '\n');
    if (evaluate) log(markdown(report));
    return { report, reportPath };
  } finally {
    await browser?.close();
    await server.close();
  }
}

const truth = JSON.parse(await readFile(join(root, 'helpdesk/tickets.json'), 'utf8'));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  const options = {
    eval: args.includes('--eval'), headed: args.includes('--headed') || !args.includes('--eval'),
    limit: args.includes('--limit') ? Number(value('--limit')) : Infinity,
    slow: args.includes('--slow') ? Number(value('--slow')) : 0,
    budgetUsd: args.includes('--budget') ? Number(value('--budget')) : 4,
  };
  run(options).catch(error => { console.error(error); process.exitCode = 1; });
}
