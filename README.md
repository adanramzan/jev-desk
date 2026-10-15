# Jev Desk

**A support-ticket triage agent that works any helpdesk by looking at the screen.** No helpdesk API, no admin rights, no integration. It reads each ticket from a screenshot (text *and* the attached photo), decides where the ticket goes, and clicks the button, the way a human agent would.

The decisions come from [TypeSafe's Jev](https://typesafe.ai), a "System One" model. Jev doesn't write text. It returns typed answers (a choice, a score, a yes/no probability, a box on an image) with calibrated confidence, in well under a second.

![Jev Desk triaging tickets](media/demo.gif)

## Results (real run, 50 tickets)

| | |
|---|---|
| Tickets triaged | **50 / 50** |
| Correct category | **100%** (50/50) |
| Correct photo type (damaged item, wrong product, receipt, error screenshot) | **100%** (13/13) |
| Clicked the right button | **100%** |
| Time per ticket (2 Jev calls) | **1.3 s** median |
| Total Jev cost | **$0.019** → **$0.39 per 1,000 tickets** |

Full report: [`reports/`](reports/). Run it yourself with `npm run eval`.

> Honest caveat: these tickets are clear-cut. Each one comes from a labelled dataset where every message has a single intent, or was written by me to show photo triage. A messy real inbox (several issues per email, threads, sarcasm) will score lower. That's what the confidence gate is for: below the threshold, the ticket goes to **Needs a human** instead of being auto-filed.

## How it works

```
 screenshot ──► Jev: what is this ticket?           ──► decision + confidence
                 · category      (Choice, 8 options)       ≥ 0.85 → click the category
                 · photo type    (Choice)                  ≥ 0.60 → suggest
                 · urgency       (Score, 4 levels)         else   → "Escalate to human"
                 · refund ask?   (Noul, probability)
                 · damage area   (Box, on the photo)  ──► highlighted on screen
            ──► Jev: which numbered mark is the button? ──► click
```

Two Jev calls per ticket: one to pick the next unassigned ticket from the list, and one to triage it *and* locate every action button at once. Jev answers all questions in a call in parallel, so asking 13 questions costs about the same as asking one.

**Why numbered marks instead of raw coordinates?** I measured both. Jev's Box answer (a bounding box on an image) found the right button in a row of look-alike buttons only 5/7 times. Drawing a small numbered label on every clickable element and asking Jev to *choose* a label ("set-of-marks", a standard web-agent technique) was right 14/14 times at confidence 1.0. So Box is used only to show the evidence (the damaged area in a customer's photo), never to decide where to click. The marks come from a generic query for clickable elements, so nothing is specific to one helpdesk.

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

The API key comes from `JEV_API_KEY`, or from `~/.ragbench/jev.env` for the runner.

## Spend safety

Every call is priced at TypeSafe's $42 per billion input tokens. A ledger (`.jev-spend.json`) enforces a hard cap of $4 for the runner; the extension has its own budget, default $1. The automated tests never call Jev: they run against a local stub server.

The whole project was built for about $0.03 of Jev usage.

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
