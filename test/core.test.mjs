import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetError, CATEGORIES, JevError, createJev, decide,
  markQuestion, screenshotState, triageQuestions,
} from '../core/jev.mjs';
import { runAgent } from '../core/agent.mjs';

const answer = (choice, confidence = 1) => ({ type: 'choice', choice, confidence });
const score = value => ({ type: 'score', score: value, confidence: 1 });
const noul = value => ({ type: 'noul', noul: value });
const box = value => ({ type: 'box', box: value, confidence: 1 });
const ok = (answers = {}) => ({ ok: true, json: async () => ({ answers, usage: { input_tokens: 1000 }, model: 'jev-1.14.0' }) });

test('decide applies inclusive confidence, urgency, refund, and photo boundaries', () => {
  for (const [confidence, mode] of [[0.9, 'auto'], [0.85, 'auto'], [0.7, 'suggest'], [0.6, 'suggest'], [0.5, 'human']]) {
    assert.equal(decide({ category: answer('damaged', confidence) }).mode, mode);
  }
  const damage = { top: 0.2, bottom: 0.4, left: 0.1, right: 0.3 };
  const base = { category: answer('damaged', 0.9), photo: answer('damaged'), damage_box: box(damage) };
  assert.deepEqual(decide({ ...base, urgency: score(2), refund: noul(0.5) }), {
    category: 'damaged', confidence: 0.9, mode: 'auto', urgent: true,
    refund: true, photo: 'damaged', damageBox: damage,
  });
  assert.equal(decide({ ...base, urgency: score(1.99), refund: noul(0.49), photo: answer('none') }).urgent, false);
  assert.equal(decide({ ...base, refund: noul(0.49) }).refund, false);
  assert.equal(decide({ ...base, photo: answer('none') }).damageBox, null);
});

test('Jev sends the specified request and records input-token spend', async () => {
  let request;
  const spends = [];
  const jev = createJev({ apiKey: 'secret', baseUrl: 'http://stub', budgetUsd: 1, fetchImpl: async (...args) => { request = args; return ok({ category: answer('refund') }); }, onSpend: (...args) => spends.push(args) });
  const result = await jev.ask({ state: { screen: 'ref' }, questions: { category: { type: 'choice' } }, assets: { ref: {} } });
  assert.equal(request[0], 'http://stub/v1/systemone');
  assert.equal(request[1].method, 'POST');
  assert.deepEqual(request[1].headers, { Authorization: 'Bearer secret', 'content-type': 'application/json', 'TypeSafe-Danger-Zone-Images': 'true' });
  assert.deepEqual(JSON.parse(request[1].body), { model: 'jev-1.14.0', state: { screen: 'ref' }, questions: { category: { type: 'choice' } }, assets: { ref: {} } });
  assert.equal(result.answers.category.choice, 'refund');
  assert.equal(result.model, 'jev-1.14.0');
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal(jev.spent(), 0.000042);
  assert.deepEqual(spends, [[0.000042, 0.000042]]);
});

test('a real-shaped Jev response flows through createJev and decide', async () => {
  const response = {
    model: 'jev-1.14.0',
    answers: {
      category: { type: 'choice', choice: 'damaged', confidence: 0.97, probabilities: { damaged: 0.97, refund: 0.03 } },
      photo: { type: 'choice', choice: 'damaged', confidence: 0.96 },
      urgency: { type: 'score', score: 1.43, confidence: 0.35, legend: { 0: 'Can wait', 1: 'Normal' }, probabilities: { 0: 0, 1: 0.57, 2: 0.43 } },
      refund: { type: 'noul', noul: 0.12 },
      damage_box: { type: 'box', box: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 }, confidence: 0.92 },
    },
    usage: { input_tokens: 3093, output_tokens: 101 },
  };
  const jev = createJev({ apiKey: 'test', budgetUsd: 1, fetchImpl: async () => ({ ok: true, json: async () => response }) });
  const result = await jev.ask({ state: {}, questions: triageQuestions(), assets: {} });
  assert.deepEqual(decide(result.answers), {
    category: 'damaged', confidence: 0.97, mode: 'auto', urgent: false,
    refund: false, photo: 'damaged', damageBox: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 },
  });
  assert.equal(jev.spent(), 3093 * 42e-9);
});

test('Jev budget guard prevents a request', async () => {
  let calls = 0;
  const jev = createJev({ apiKey: 'secret', budgetUsd: 0.1, spentUsd: 0.1, fetchImpl: async () => { calls++; return ok(); } });
  await assert.rejects(jev.ask({}), BudgetError);
  assert.equal(calls, 0);
});

test('Jev rejects invalid budgets at creation', () => {
  for (const budgetUsd of [undefined, 0, -1, NaN, Infinity, '1']) {
    assert.throws(() => createJev({ apiKey: 'secret', budgetUsd }), /budgetUsd/);
  }
});

test('Jev does not retry a billed response when onSpend throws', async () => {
  let calls = 0;
  const failure = new Error('ledger failed');
  const jev = createJev({ apiKey: 'secret', budgetUsd: 1, sleep: async () => {},
    fetchImpl: async () => { calls++; return ok(); }, onSpend: () => { throw failure; } });
  await assert.rejects(jev.ask({}), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(jev.spent(), 0.000042);
});

test('Jev charges 5000 tokens when successful usage lacks input tokens', async () => {
  const spends = [];
  const jev = createJev({ apiKey: 'secret', budgetUsd: 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {}, usage: {} }) }),
    onSpend: (...args) => spends.push(args) });
  await jev.ask({});
  assert.ok(Math.abs(jev.spent() - 0.00021) < 1e-12);
  assert.deepEqual(spends, [[jev.spent(), jev.spent()]]);
});

test('Jev retries 500 and 429, then succeeds', async () => {
  for (const status of [500, 429]) {
    let calls = 0;
    const jev = createJev({ apiKey: 'secret', budgetUsd: 1, sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? { ok: false, status, json: async () => ({ message: 'retry' }) } : ok() });
    await jev.ask({});
    assert.equal(calls, 2);
  }
});

test('Jev reports a 400 immediately and stops retrying after three attempts', async () => {
  let calls = 0;
  const bad = createJev({ apiKey: 'secret', budgetUsd: 1, sleep: async () => {}, fetchImpl: async () => { calls++; return { ok: false, status: 400, json: async () => ({ detail: { error_type: 'api_usage_error', message: 'Invalid request.' } }) }; } });
  await assert.rejects(bad.ask({}), error => error instanceof JevError && error.status === 400 && error.message === 'Invalid request.');
  assert.equal(calls, 1);
  const nonJson = createJev({ apiKey: 'secret', budgetUsd: 1, sleep: async () => {}, fetchImpl: async () => ({ ok: false, status: 400, json: async () => { throw new SyntaxError('unexpected token'); } }) });
  await assert.rejects(nonJson.ask({}), error => error instanceof JevError && error.status === 400 && error.message === 'Jev HTTP 400');
  calls = 0;
  const fail = createJev({ apiKey: 'secret', budgetUsd: 1, sleep: async () => {}, fetchImpl: async () => { calls++; throw Error('offline'); } });
  await assert.rejects(fail.ask({}), JevError);
  assert.equal(calls, 3);
});

test('screenshot and question builders follow the Jev contract', () => {
  const shot = screenshotState('pngbytes');
  assert.match(shot.state.screen, /^scr-[0-9a-f]{8}$/);
  assert.deepEqual(shot.assets[shot.state.screen], { type: 'image', format: 'png', data_base64: 'pngbytes' });
  const q = triageQuestions();
  assert.deepEqual(Object.keys(q.category.criteria), CATEGORIES.map(([key]) => key));
  assert.deepEqual(Object.values(q).map(({ type }) => type), ['choice', 'choice', 'score', 'noul', 'box']);
  assert.deepEqual(q.urgency.criteria, ['Can wait', 'Normal', 'Soon: customer is blocked or upset', 'Now: money lost, safety, or very angry']);
  assert.deepEqual(Object.keys(markQuestion('x', 3).criteria), ['m1', 'm2', 'm3']);
});

function fakeIo() {
  const clicks = [], boxes = [], waits = [];
  return {
    clicks, boxes, waits,
    screenshot: async () => 'png',
    addMarks: async () => Array.from({ length: 12 }, (_, i) => ({ id: `id${i + 1}`, label: String(i + 1) })),
    removeMarks: async () => {}, click: async id => clicks.push(id),
    box: async (...args) => boxes.push(args), toast: async () => {}, wait: async ms => waits.push(ms),
  };
}

test('agent triages two tickets, escalates low confidence, and stops when none remain', async () => {
  const io = fakeIo(), events = [];
  const scripted = [
    { next: answer('m1'), any_new: noul(1) },
    { category: answer('damaged', 0.9), photo: answer('damaged'), damage_box: box({ top: 0, bottom: 0.5, left: 0, right: 0.5 }), urgency: score(2), refund: noul(0), btn_damaged: answer('m2'), btn_urgent: answer('m3'), btn_escalate: answer('m4') },
    { next: answer('m5'), any_new: noul(1) },
    { category: answer('shipping', 0.5), photo: answer('none'), urgency: score(1), refund: noul(0), btn_shipping: answer('m2'), btn_escalate: answer('m4') },
    { any_new: noul(0.1) },
  ];
  const jev = { spent: () => 0, ask: async () => ({ answers: scripted.shift(), latencyMs: 10 }) };
  assert.deepEqual(await runAgent({ jev, io, onEvent: e => events.push(e) }), { handled: 2, stoppedBy: 'done' });
  assert.deepEqual(io.clicks, ['id1', 'id2', 'id3', 'id5', 'id4']);
  assert.deepEqual(io.boxes, [[[0, 0, 0.5, 0.5], 'damage']]);
  assert.deepEqual(events.map(e => e.type), ['ticket', 'ticket', 'done']);
  assert.deepEqual(events[0].clicked, ['Damaged item', 'Urgent']);
  assert.deepEqual(events[1].clicked, ['Escalate to human']);
  assert.equal(events[0].latencyMs, 20);
  assert.deepEqual(io.waits, [150, 150]);
});

test('agent stops after the first ticket without opening another', async () => {
  const io = fakeIo(), events = [], controller = new AbortController();
  let calls = 0;
  const jev = { spent: () => 0, ask: async () => ({ answers: ++calls % 2
    ? { next: answer('m1'), any_new: noul(1) }
    : { category: answer('refund'), btn_refund: answer('m2') }, latencyMs: 1 }) };
  const result = await runAgent({ jev, io, signal: controller.signal, onEvent: event => {
    events.push(event);
    if (event.type === 'ticket') controller.abort();
  } });
  assert.deepEqual(result, { handled: 1, stoppedBy: 'stopped' });
  assert.deepEqual(io.clicks, ['id1', 'id2']);
  assert.deepEqual(events.map(event => event.type), ['ticket', 'stopped']);
  assert.equal(calls, 2);
});

test('agent escalates an unknown category mark', async () => {
  const io = fakeIo(), events = [];
  const scripted = [
    { next: answer('m1'), any_new: noul(1) },
    { category: answer('refund', 0.9), btn_refund: answer('m99'), btn_escalate: answer('m4') },
  ];
  const jev = { spent: () => 0, ask: async () => ({ answers: scripted.shift(), latencyMs: 1 }) };
  assert.deepEqual(await runAgent({ jev, io, maxTickets: 1, onEvent: e => events.push(e) }), { handled: 1, stoppedBy: 'max' });
  assert.deepEqual(io.clicks, ['id1', 'id4']);
  assert.equal(events.find(e => e.type === 'ticket').decision.mode, 'human');
});

test('agent skips an unknown escalate mark and continues to the next ticket', async () => {
  const io = fakeIo(), events = [], prompts = [];
  const scripted = [
    { next: answer('m1'), any_new: noul(1) },
    { category: answer('refund', 0.5), btn_escalate: answer('m99') },
    { next: answer('m2'), any_new: noul(1) },
    { category: answer('refund', 0.5), btn_escalate: answer('m4') },
    { any_new: noul(0) },
  ];
  const jev = { spent: () => 0, ask: async ({ questions }) => {
    prompts.push(questions);
    return { answers: scripted.shift(), latencyMs: 1 };
  } };
  assert.deepEqual(await runAgent({ jev, io, onEvent: e => events.push(e) }), { handled: 1, stoppedBy: 'done' });
  assert.match(prompts[2].next.instructions, /m1/);
  assert.deepEqual(io.clicks, ['id1', 'id2', 'id4']);
  assert.deepEqual(events.map(e => e.type), ['error', 'ticket', 'done']);
});

test('agent stops on budget and respects maxTickets', async () => {
  const io = fakeIo(), events = [];
  const jev = { spent: () => 0, ask: async () => { throw new BudgetError('limit'); } };
  assert.deepEqual(await runAgent({ jev, io, onEvent: e => events.push(e) }), { handled: 0, stoppedBy: 'budget' });
  assert.equal(events[0].type, 'budget');
  assert.deepEqual(await runAgent({ jev, io, maxTickets: 0 }), { handled: 0, stoppedBy: 'max' });
});

test('agent skips a ticket after exhausted server retries and avoids repeating it', async () => {
  const io = fakeIo(), events = [], prompts = [];
  const scripted = [
    { next: answer('m1'), any_new: noul(1) },
    new JevError('unavailable', 503),
    { next: answer('m2'), any_new: noul(1) },
    { category: answer('refund', 0.9), btn_refund: answer('m3') },
    { any_new: noul(0) },
  ];
  const jev = { spent: () => 0, ask: async ({ questions }) => {
    prompts.push(questions);
    const next = scripted.shift();
    if (next instanceof Error) throw next;
    return { answers: next, latencyMs: 1 };
  } };
  assert.deepEqual(await runAgent({ jev, io, onEvent: e => events.push(e) }), { handled: 1, stoppedBy: 'done' });
  assert.match(prompts[2].next.instructions, /m1/);
  assert.deepEqual(io.clicks, ['id1', 'id2', 'id3']);
  assert.deepEqual(events.map(e => e.type), ['error', 'ticket', 'done']);
});
