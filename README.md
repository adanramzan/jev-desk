# Jev Desk

**A support-ticket triage agent that works a helpdesk by looking at the screen.** No helpdesk API, no admin rights, no integration: point it at the ticket list and the action bar, and it does the rest. It reads each ticket from a screenshot (text *and* the attached photo), decides where the ticket goes, and clicks the button, the way a human agent would.

The decisions come from [TypeSafe's Jev](https://typesafe.ai), a "System One" model. Jev doesn't write text. It returns typed answers (a choice, a score, a yes/no probability, a box on an image) with calibrated confidence, in well under a second.

![Jev Desk triaging tickets](media/demo.gif)

## Results (real run, 50 tickets)

| | |
|---|---|
| Tickets triaged | **50 / 50** |
| Correct category | **100%** (50/50) |
| Correct photo type on tickets with a photo (damaged item, wrong product, receipt, error screenshot) | **100%** (13/13) |
| Correct photo type on all tickets | **98%** (49/50): one text-only ticket was tagged "receipt", though its category was still right |
| Clicked the right button | **100%** |
| Jev decision time per ticket (2 calls) | **1.3 s** median, 1.7 s p95 |
| End-to-end, including screenshots and clicks | about **2 s** per ticket (50 tickets in 99 s) |
| Total Jev cost | **$0.019** (estimated from input tokens) → about **$0.39 per 1,000 tickets** |

Two independent full runs gave identical results (same decisions, same single photo slip, same cost). Both reports are in [`reports/`](reports/). Run it yourself with `npm run eval`.

> Honest caveat: these tickets are clear-cut. Each one comes from a labelled dataset where every message has a single intent, or was written by me to show photo triage. A messy real inbox (several issues per email, threads, sarcasm) will score lower. That's what the confidence gate is for: below the threshold, the ticket goes to **Needs a human** instead of being auto-filed.

## How it works

```
 screenshot ──► Jev: what is this ticket?           ──► decision + confidence
                 · category      (Choice, 8 options)       ≥ 0.85 → click the category
                 · photo type    (Choice)                  below  → "Escalate to human"
                 · urgency       (Score, 4 levels)
                 · refund ask?   (Noul, probability)
                 · damage area   (Box, on the photo)  ──► highlighted on screen
            ──► Jev: which numbered mark is the button? ──► click
```

Two Jev calls per ticket: one to pick the next unassigned ticket from the list, and one to triage it *and* locate every action button at once. Jev answers all questions in a call in parallel, so the 15 questions in the triage call cost about the same as one. A button is only clicked when Jev's choice of mark has confidence ≥ 0.85.

**Why numbered marks instead of raw coordinates?** I measured both. Jev's Box answer (a bounding box on an image) found the right button in a row of look-alike buttons only 5/7 times. Drawing a small numbered label on every clickable element and asking Jev to *choose* a label ("set-of-marks", a standard web-agent technique) was right 14/14 times at confidence 1.0. So Box is used only to show the evidence (the damaged area in a customer's photo), never to decide where to click. The marks come from a generic query for clickable elements inside two regions you point it at (the ticket list and the action bar). In the demo helpdesk those are `[data-ticket-list]` and `[data-ticket-actions]`; on another helpdesk you set two CSS selectors in the extension settings. Autopilot refuses to run if the regions aren't found, so it never clicks around a page it doesn't understand. **Scan** (read-only, no clicks) works on any page.

## Two ways to run it

**1. Playwright runner.** It works through a backlog unattended, and it's how the accuracy numbers above are measured.

```bash
npm install
npm run demo                 # visible browser, live cursor, highlights and toasts
npm run eval                 # headless, all 50 tickets, writes reports/eval-*.md
node runner/run.mjs --limit 5 --record media/raw   # record a video
```

**2. Chrome extension.** It runs in your own logged-in helpdesk tab.

```bash
npm run build:ext            # copies the shared core into extension/
```

Then open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select `extension/`. Open the side panel, paste your Jev API key, and use **Scan this ticket** or **Autopilot**. Tickets are sorted into lanes: Urgent, Refund, Shipping, Billing, Account, Order change, Damaged item, Wrong item, Spam, and Needs a human.

The runner reads the API key from the `JEV_API_KEY` environment variable.

## Spend safety

Every call is priced at TypeSafe's $42 per billion input tokens. A ledger (`.jev-spend.json`) enforces a hard cap of $4 for the runner; the extension has its own budget, default $1. The automated tests never call Jev: they run against a local stub server.

Building and evaluating the whole project, including two full evals, used about $0.06 of Jev credit (ledger: $0.055).

## Project layout

```
core/        Jev client + budget guard, marks overlay, agent loop (shared by both shells)
runner/      Playwright runner: demo, eval, video recording
extension/   Chrome MV3 side panel
helpdesk/    "Helpline", a demo helpdesk with 50 labelled tickets
test/        unit, e2e (stub Jev), extension tests: npm test
```

## Data and credits

- Ticket text: 34 messages from the [Bitext customer-support dataset](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset) (CDLA-Sharing-1.0), mapped to 5 categories. The other 16 tickets (photos and spam) are hand-written. Each ticket records its source in `helpdesk/tickets.json`.
- Photos: Creative Commons images via Openverse, credited in [`helpdesk/img/CREDITS.md`](helpdesk/img/CREDITS.md).
- "Helpline" is a fictional demo app. This project is not affiliated with TypeSafe, Zendesk or any helpdesk vendor.

Built by orchestrating three coding agents: Claude (planning, review, integration), OpenAI Codex, and Google Antigravity.
