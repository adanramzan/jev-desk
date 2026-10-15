# Jev Desk — design

## Intent (agreed with the user, 2026-10-16)
An AI triage layer that works on **any** web helpdesk by looking at the screen, like a human agent: no helpdesk API, no admin rights. TypeSafe Jev (System One model) reads each ticket from a screenshot (text + attached photo), decides category / urgency / refund intent with calibrated confidence, and clicks the right buttons. One shared engine, two shells:
- **Chrome extension** (the product): side panel that sorts tickets into columns, draws badges/boxes over the page, and an Autopilot toggle that clicks when confident.
- **Playwright runner** (automation + proof): visible autopilot run, and an eval mode that runs over a labelled demo helpdesk and prints accuracy / speed / cost.

Showcase target: LinkedIn + portfolio. Success = `npm run demo` opens a browser where tickets get triaged live with a visible cursor and highlights, and `npm run eval` prints a table like "50 tickets · 9x% correct · 0.5 s/decision · $0.00x total".

Constraints: Jev spend hard cap **$4 total** for the whole project (enforced in code). Not Zendesk-branded (demo app is a generic helpdesk called "Helpline"). Node 24, ESM, only dependency `playwright` (dev).

## Evidence that shaped the design (measured 2026-10-16, model jev-preview → jev-1.14.0)
- Screenshot triage: 4/4 correct on photo type + category, ~0.4 s, ~3.2k input tokens per 1280×800 screenshot (~$0.00013).
- Box on a specific button in a row of similar buttons: 5/7 one-shot, worse with crop. **Not used for clicking.**
- Set-of-marks (numbered red labels drawn on every clickable element, Jev answers a Choice of label): 14/14, confidence 1.0. **Used for clicking.**
- Box is used only for a visual "evidence" highlight (damaged area in a photo), never for actions.
- API rejects very thin images ("Invalid image dimensions"); always send full-viewport screenshots.

## Architecture
```
core/jev.mjs     Jev client (fetch), budget guard, question builders, decide()
core/marks.js    in-page script: number clickable elements, click by mark, draw box/cursor/toast overlays
core/agent.mjs   the agent loop over an `io` adapter: next ticket → open → triage → act
runner/run.mjs   Playwright shell: io adapter over a Page; demo + eval modes; spend ledger file
extension/       MV3 shell: side panel UI, service worker io adapter (captureVisibleTab + content script)
helpdesk/        demo helpdesk app (static) + tickets.json + img/
scripts/serve.mjs static server for helpdesk (port 5180)
```

### Jev client — `core/jev.mjs` (isomorphic: no node: imports)
- `PRICE_PER_INPUT_TOKEN = 42e-9`, `MODEL = 'jev-1.14.0'`, default `baseUrl = 'https://api.typesafe.ai'`.
- `createJev({ apiKey, baseUrl, model, budgetUsd, spentUsd = 0, onSpend })` → `{ ask({state, questions, assets}), spent() }`.
  - Throws `BudgetError` **before** sending if `spent >= budgetUsd`.
  - Headers: `Authorization: Bearer`, `content-type: application/json`, `TypeSafe-Danger-Zone-Images: true`.
  - 20 s timeout per attempt; up to 3 attempts on network error / 5xx / 429 (backoff 0.5 s, 1 s); 4xx other than 429 → throw immediately with the API's message.
  - After success: `spent += usage.input_tokens * PRICE`; calls `onSpend(spentUsd, deltaUsd)`; returns `{answers, usage, latencyMs, model}`.
- `screenshotState(base64Png)` → `{ state: {screen: ref}, assets: {[ref]: {type:'image', format:'png', data_base64}} }` with `ref = 'scr-' + 8 random hex chars`.
- `CATEGORIES` (ordered; also the helpdesk button labels):
  `refund` "Refund", `shipping` "Shipping", `billing` "Billing", `account` "Account", `order` "Order change", `damaged` "Damaged item", `wrong_item` "Wrong item", `spam` "Spam".
- `triageQuestions()` → questions over `` `screen` ``:
  - `category` choice over CATEGORIES with one-line criteria each (see plan).
  - `photo` choice: `damaged`, `product`, `receipt`, `error_screenshot`, `none`.
  - `urgency` score: ["Can wait", "Normal", "Soon: customer is blocked or upset", "Now: money lost, safety, or very angry"].
  - `refund` noul: "Is the customer asking for their money back?"
  - `damage_box` box: "the damaged part of the product in the attached photo in `screen`".
- `markQuestion(instructions, count)` → choice with criteria `m1..mN` = `the element tagged with the red label "i"`.
- `decide(answers, t = {auto: 0.85, suggest: 0.6})` → `{ category, confidence, mode, urgent, refund, photo, damageBox }`:
  - `mode`: `'auto'` if confidence ≥ t.auto, `'suggest'` if ≥ t.suggest, else `'human'`.
  - `urgent`: urgency score ≥ 2.0. `refund`: noul ≥ 0.5. `damageBox`: the box only when photo == 'damaged'.

### In-page marks — `core/marks.js`
Plain script (no modules) defining `window.jevMarks`:
- `add({scope} = {})` → `[{id, label, x, y, w, h}]`: every visible `button, a[href], [role=button], input, select, [data-ticket-id]` inside `scope` (CSS selector, default document), numbered 1..N in **document order**, red label drawn at the element's top-left, `data-jev-mark` set.
- `remove()`, `click(id)` (animates the cursor to the element center, then `.click()`), `box(fracBox, text)` (outlined rectangle over the page region given as fractions of the viewport, with a caption), `toast(text)`, `cursor(x,y)`; overlays use `pointer-events:none` and live in one root `#jev-overlay` that `add()` never marks. Overlays are hidden while taking a screenshot only via `hideOverlay()`/`showOverlay()` (marks stay visible).

### Agent loop — `core/agent.mjs`
`runAgent({ jev, io, thresholds, maxTickets, onEvent })` where `io` = `{ screenshot(): base64Png, addMarks(scope?): marks[], removeMarks(), click(id), box(b,text), toast(t), wait(ms) }`.
Per ticket:
1. `addMarks('[data-ticket-list]')` on the ticket list, screenshot, ask a mark choice "Which red label is on the topmost ticket row whose status is New?" plus noul `any_new` "Is there any ticket row with status New in `screen`?". If `any_new < 0.5` → done. `click(choice)`; `removeMarks()`.
2. `addMarks('[data-ticket-actions]')`, screenshot, ask `triageQuestions()` **plus** one mark question per category ("Which red label is on the "<Label>" button?") plus marks for "Escalate to human" and "Urgent" (speculative fan-out: 1 call).
3. `d = decide(...)`. If `d.damageBox` → `box(damageBox, 'damage')`. If mode `auto` → click the category's mark (and Urgent's mark if `d.urgent`). Else → click "Escalate to human". `removeMarks()`.
4. `onEvent({type:'ticket', ticketTitle?, decision: d, clicked, latencyMs, costUsd})`.
Stops on `BudgetError` (event `budget`), on `maxTickets`, or when `any_new` says none left. Two Jev calls per ticket.

### Demo helpdesk — `helpdesk/`
Static app "Helpline". Left: ticket list (`[data-ticket-list]`, rows `[data-ticket-id]`) with subject, requester, relative time, status chip (New / Triaged / Escalated), category chip, urgent flag, paperclip if attachment. Right: ticket view with subject, requester, body, attached image(s), action bar `[data-ticket-actions]` containing: 8 category buttons (labels exactly as CATEGORIES), "Urgent" toggle, "Escalate to human". Clicking a category sets status Triaged + category; Escalate sets status Escalated. State in memory + localStorage; `?reset` clears. `window.helpline.state()` returns `[{id, status, category, urgent}]` for the eval. Looks like a real modern helpdesk (dense, neutral, pro), not a toy.

### Tickets — `helpdesk/tickets.json`
`[{id, subject, from, received, body, images: ['img/x.jpg'], truth: {category, photo, source}}]`, 50 tickets:
- 34 from **Bitext customer-support dataset** (HF `bitext/Bitext-customer-support-llm-chatbot-training-dataset`, CDLA-Sharing-1.0): intents mapped to categories (get_refund/track_refund/check_refund_policy→refund; delivery_period/track_order/delivery_options/change_shipping_address→shipping; payment_issue/check_invoice/get_invoice/check_payment_methods→billing; recover_password/registration_problems/edit_account/delete_account→account; cancel_order/change_order→order). `source: 'bitext:<row>'`.
- 16 hand-written (labelled `source: 'handwritten'`): 5 damaged (photo), 5 wrong item (product photo contradicting the text), 2 billing with receipt photo, 1 account with error screenshot, 3 spam.

### Runner — `runner/run.mjs`
`node runner/run.mjs [--eval] [--headed] [--limit N] [--slow ms] [--budget usd]`
- Starts `scripts/serve.mjs` in-process, opens `http://localhost:5180/?reset`, injects `core/marks.js`, builds the `io` adapter (screenshot = `page.screenshot()` viewport 1280×800 PNG), runs `runAgent`.
- Spend ledger `.jev-spend.json` `{spentUsd}` at repo root is loaded before and saved after every call; global cap $4 (`--budget` can only lower it).
- Demo mode (`npm run demo`): headed, slowMo, overlays visible, prints a live log line per ticket.
- Eval mode (`npm run eval`): headless, then compares `window.helpline.state()` and the agent's decisions to `truth`, writes `reports/eval-<timestamp>.md` + `.json`: overall decision accuracy, accuracy on auto-handled, auto rate, escalation rate, click accuracy (clicked button == decided category), photo-type accuracy on image tickets, per-category accuracy, confusion list, p50/p95 latency, total cost, cost per 1k tickets.

### Extension — `extension/`
MV3, `side_panel`, permissions `storage, tabs, activeTab, scripting, sidePanel`, host permissions `<all_urls>`.
- `npm run build:ext` copies `core/*.mjs core/marks.js` into `extension/core/` (gitignored).
- Service worker (module) implements `io` with `chrome.tabs.captureVisibleTab` (PNG, strip `data:` prefix) and `chrome.scripting.executeScript` calling `window.jevMarks.*` in the active tab; injects `core/marks.js` on demand.
- Side panel: API key + budget (stored in `chrome.storage.local`, budget default $1, shows spent), buttons **Scan this ticket** (step 2–3 without clicking, shows decision) and **Autopilot** (start/stop `runAgent`), a board of lanes: Urgent first, then the 8 categories and "Needs a human", each lane listing ticket cards (subject from the decision event — the agent asks no extra question; use the tab title fallback "Ticket N"), with confidence %, refund badge, photo-type badge, latency. Live spend + tickets/minute.

## Error handling
- Jev 4xx → stop the run with the message. 5xx/network → retried, then the ticket is skipped (event `error`) and the loop continues.
- `BudgetError` → stop cleanly, report spend.
- Mark id from Jev not present → treated as `human` (click Escalate) and logged.

## Testing (no Jev spend in automated tests)
- `node --test` unit tests for core (decide thresholds, budget guard, retries, question shapes, agent loop with fake io + fake jev).
- E2E tests with Playwright + a local **stub Jev server** (`test/stub-jev.mjs`) that answers from the page truth, verifying the runner clicks the right buttons and the eval report is written; extension e2e: Playwright persistent context with `--load-extension`, stub Jev, run Scan on the helpdesk, assert decision arrives and marks render.
- One real eval run against Jev at the end (≈ 100 calls ≈ $0.02).

## Out of scope
Real Zendesk integration, replying to customers, multi-tab, auth, deploy.
