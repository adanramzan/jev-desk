export const MODEL = 'jev-1.14.0', PRICE_PER_INPUT_TOKEN = 42e-9;
export class BudgetError extends Error {}
export class JevError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export const CATEGORIES = [
  ['refund', 'Refund', 'Wants money back, or asks about a refund or its status'],
  ['shipping', 'Shipping', 'Delivery time, tracking, lost or late parcel, delivery address or options'],
  ['billing', 'Billing', 'Charges, double charges, payment failures, invoices, receipts, payment methods'],
  ['account', 'Account', 'Login, password, sign-up errors, editing or deleting the account'],
  ['order', 'Order change', 'Cancel or modify an order that was placed'],
  ['damaged', 'Damaged item', 'Item arrived broken, cracked, dented or damaged'],
  ['wrong_item', 'Wrong item', 'Received a different product than the one ordered'],
  ['spam', 'Spam', 'Unsolicited marketing, scams, phishing, not a real customer'],
];

export function createJev({ apiKey, baseUrl = 'https://api.typesafe.ai', model = MODEL, budgetUsd, spentUsd = 0, onSpend = () => {}, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  return {
    spent: () => spentUsd,
    async ask({ state, questions, assets }) {
      if (spentUsd >= budgetUsd) throw new BudgetError('Jev budget exhausted');
      const started = performance.now();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/systemone`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'TypeSafe-Danger-Zone-Images': 'true' },
            body: JSON.stringify({ model, state, questions, assets }),
            signal: AbortSignal.timeout(20_000),
          });
          const data = response.ok ? await response.json() : await response.json().catch(() => ({}));
          if (!response.ok) {
            const error = new JevError(data.detail?.message || data.message || data.error?.message || `Jev HTTP ${response.status}`, response.status);
            if (response.status < 500 && response.status !== 429) throw error;
            if (attempt === 2) throw error;
          } else {
            const deltaUsd = (data.usage?.input_tokens || 0) * PRICE_PER_INPUT_TOKEN;
            spentUsd += deltaUsd;
            onSpend(spentUsd, deltaUsd);
            return { answers: data.answers, usage: data.usage, latencyMs: performance.now() - started, model: data.model || model };
          }
        } catch (error) {
          if (error instanceof JevError && (error.status < 500 && error.status !== 429 || attempt === 2)) throw error;
          if (attempt === 2) throw new JevError(error.message);
        }
        await sleep(attempt === 0 ? 500 : 1000);
      }
    },
  };
}

export function screenshotState(base64Png) {
  const ref = `scr-${Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')}`;
  return { state: { screen: ref }, assets: { [ref]: { type: 'image', format: 'png', data_base64: base64Png } } };
}

export function triageQuestions() {
  return {
    category: { type: 'choice', instructions: 'What is the main issue in `screen`?', criteria: Object.fromEntries(CATEGORIES.map(([key, , criterion]) => [key, criterion])) },
    photo: { type: 'choice', instructions: 'What kind of attached photo appears in `screen`?', criteria: {
      damaged: 'A damaged product', product: 'A product', receipt: 'A receipt or invoice', error_screenshot: 'A screenshot of an error', none: 'No attachment',
    } },
    urgency: { type: 'score', instructions: 'How urgent is the customer issue in `screen`?', criteria: ['Can wait', 'Normal', 'Soon: customer is blocked or upset', 'Now: money lost, safety, or very angry'] },
    refund: { type: 'noul', instructions: 'Is the customer asking for their money back?' },
    damage_box: { type: 'box', instructions: 'the damaged part of the product in the attached photo in `screen`' },
  };
}

export function markQuestion(instructions, count) {
  return { type: 'choice', instructions, criteria: Object.fromEntries(Array.from({ length: count }, (_, i) => [`m${i + 1}`, `the element tagged with the red label "${i + 1}"`])) };
}

export function decide(answers, t = { auto: 0.85, suggest: 0.6 }) {
  const category = answers.category?.choice;
  const confidence = answers.category?.confidence ?? 0;
  const photo = answers.photo?.choice ?? 'none';
  return {
    category, confidence,
    mode: confidence >= t.auto ? 'auto' : confidence >= t.suggest ? 'suggest' : 'human',
    urgent: (answers.urgency?.score ?? 0) >= 2,
    refund: (answers.refund?.noul ?? 0) >= 0.5,
    photo,
    damageBox: photo === 'damaged' ? answers.damage_box?.box ?? null : null,
  };
}
