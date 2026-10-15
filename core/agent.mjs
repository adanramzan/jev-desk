import { BudgetError, CATEGORIES, JevError, decide, markQuestion, screenshotState, triageQuestions } from './jev.mjs';

export async function runAgent({ jev, io, thresholds, maxTickets = Infinity, scopes = { list: '[data-ticket-list]', actions: '[data-ticket-actions]' }, onEvent = () => {}, signal }) {
  let handled = 0;
  const skipped = new Set();
  const markId = (choice, marks) => {
    const index = /^m([1-9]\d*)$/.exec(choice?.choice ?? '')?.[1];
    return choice?.confidence >= 0.85 && index ? marks[Number(index) - 1]?.id : undefined;
  };
  const stop = (stoppedBy) => ({ handled, stoppedBy });
  const stopped = async () => { if (signal?.aborted) { await io.clearBox?.(); onEvent({ type: 'stopped' }); return true; } return false; };

  while (handled < maxTickets) {
    if (await stopped()) return stop('stopped');
    let listAnswers, listLatency, startSpend = jev.spent();
    let currentMark;
    try {
      const marks = await io.addMarks(scopes.list, { strict: true });
      try {
        if (!marks.length) throw new Error('Helpdesk regions not found — Autopilot needs [data-ticket-list] and [data-ticket-actions] (or configured selectors)');
        const except = skipped.size ? ` Ignore the rows tagged ${[...skipped].join(', ')}.` : '';
        const result = await jev.ask({ ...screenshotState(await io.screenshot()), questions: {
          next: markQuestion('Which red label is on the topmost ticket row whose status is New in `screen`?' + except, marks.length),
          any_new: { type: 'noul', instructions: 'Is there any ticket row with status New in `screen`?' + except },
        } });
        listAnswers = result.answers;
        listLatency = result.latencyMs;
        if ((listAnswers.any_new?.noul ?? 0) < 0.5) {
          onEvent({ type: 'done', handled });
          return stop('done');
        }
        const id = markId(listAnswers.next, marks);
        if (!id) throw new Error('Unknown ticket mark');
        currentMark = listAnswers.next.choice;
        if (skipped.has(currentMark)) throw new Error('Jev selected a previously skipped ticket');
        if (await stopped()) return stop('stopped');
        await io.click(id);
      } finally { await io.removeMarks(); }

      await io.wait(150);
      if (await stopped()) return stop('stopped');
      const actionMarks = await io.addMarks(scopes.actions, { strict: true });
      try {
        if (!actionMarks.length) throw new Error('Helpdesk regions not found — Autopilot needs [data-ticket-list] and [data-ticket-actions] (or configured selectors)');
        const questions = triageQuestions();
        for (const [key, label] of CATEGORIES) questions[`btn_${key}`] = markQuestion('Which red label is on the "' + label + '" button in `screen`?', actionMarks.length);
        questions.btn_urgent = markQuestion('Which red label is on the "Urgent" button in `screen`?', actionMarks.length);
        questions.btn_escalate = markQuestion('Which red label is on the "Escalate to human" button in `screen`?', actionMarks.length);
        const result = await jev.ask({ ...screenshotState(await io.screenshot()), questions });
        const decision = decide(result.answers, thresholds);
        const clicked = [];
        if (decision.damageBox) {
          const { top, bottom, left, right } = decision.damageBox;
          await io.box([left, top, right - left, bottom - top], 'damage');
        }
        let categoryId = markId(result.answers[`btn_${decision.category}`], actionMarks);
        if (decision.mode === 'auto' && !categoryId) {
          decision.mode = 'human';
          onEvent({ type: 'error', message: 'Unknown category mark; escalating' });
        }
        if (decision.mode === 'auto') {
          const urgentId = decision.urgent ? markId(result.answers.btn_urgent, actionMarks) : undefined;
          if (decision.urgent && !urgentId) {
            onEvent({ type: 'error', message: 'Unknown urgent mark' });
            skipped.add(currentMark);
            continue;
          }
          if (await stopped()) return stop('stopped');
          await io.click(categoryId);
          clicked.push(CATEGORIES.find(([key]) => key === decision.category)[1]);
          if (decision.urgent) {
            if (await stopped()) return stop('stopped');
            await io.click(urgentId); clicked.push('Urgent');
          }
        } else {
          const escalateId = markId(result.answers.btn_escalate, actionMarks);
          if (!escalateId) {
            onEvent({ type: 'error', message: 'Unknown escalate mark' });
            skipped.add(currentMark);
            continue;
          }
          if (await stopped()) return stop('stopped');
          await io.click(escalateId);
          clicked.push('Escalate to human');
        }
        handled++;
        onEvent({ type: 'ticket', decision, clicked, latencyMs: listLatency + result.latencyMs, costUsd: jev.spent() - startSpend });
      } finally { await io.removeMarks(); }
    } catch (error) {
      if (error instanceof BudgetError) { onEvent({ type: 'budget' }); return stop('budget'); }
      onEvent({ type: 'error', message: error.message });
      if (error instanceof JevError && (!error.status || error.status >= 500 || error.status === 429) && currentMark) {
        skipped.add(currentMark);
        continue;
      }
      return stop('error');
    }
  }
  return stop('max');
}
