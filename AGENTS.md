# AGENTS.md: Gmail agent, web app and backend (instructions for coding agents: Codex, Claude Code and others)

The Gmail agent is a Hebrew, RTL service: a member connects Gmail (read-only), the agent classifies and summarizes new mail with Gemini, shows calendar and tasks, can e-mail a daily briefing, and has Free and Pro plans (Polar). **Email content is never stored.**

## The two repos (read this first)
| Repo | What it is |
|---|---|
| **this repo** `ArielK29/gmail-agent` | The web page (`docs/`, GitHub Pages: https://arielk29.github.io/gmail-agent/) **and the whole backend** (`supabase/`: Edge Functions, migrations, RLS tests). Source of truth for behavior. |
| `ArielK29/gmail-agent-mobile` (private; locally `..\gmail-agent-mobile` next to this folder) | The iOS and Android app (Expo + DOM components). A **client only** of this backend. Its own `AGENTS.md` and `docs/` describe the app. |

**Keep them in sync:**
- Backend work happens ONLY here. The mobile repo never gets backend code.
- When you change anything the app depends on (an Edge Function's name, actions, request or answer, a table or column the page reads, the sign-in flow, the plan states, the error codes), update `docs/BACKEND-CONTRACT.md` in the mobile repo in the same session, or open an issue there if you cannot. The mobile repo's contract file is the list of everything that must not break silently.
- When you work in the mobile repo and find the backend must change, open an issue HERE (and do the work here).
- Sister project: DuoFit (`ArielK29/DuoFit`) is a separate, already native Expo app; do not mix code between them.

## Layout
- `docs/`: the page (`index.html`, `logic.js` + `logic.test.js`, `privacy.html`, `terms.html`) and the documentation (`BILLING.md`, `TESTING.md`, `POLAR-UI.md`, `COST-REPORT.md`).
- `supabase/functions/`: `gmail-connect`, `gmail-callback`, `gmail-disconnect`, `gmail-sync` (sync, scans, digest), `polar-billing` (checkout, portal, info), `polar-webhook`, `delete-account`. `supabase/migrations/` (numbered SQL), `supabase/tests/` (RLS permission tests that roll themselves back).
- `TODO.md`: deferred items (the GitHub issues are the live list). `SETUP-HE.md`: setup in Hebrew.
- Supabase project `ppkbuyiatkxpfeqmvwzb` (Edge Functions, Postgres with RLS, pg_cron jobs for the sync and the scans). Polar is in SANDBOX only.

## The owner
Non-technical founder, Hebrew speaker, limited use of their hands, working alone. Reply in short, simple Hebrew, show proof, tables for summaries, minimize questions, decide sensible defaults and say what you decided. Code, comments and commits are in English; the page text is Hebrew.

## Hard rules
- **Secrets:** never in the repo, never typed or pasted into the chat or into a form for the owner (the owner copies and pastes them, from a normal browser; the in-app browser pane's clipboard does not work for secrets). Never print a token, a webhook secret or a key; logs may describe only its shape (length, prefix).
- **Never, without the owner's explicit approval in chat:** create accounts or credentials (for example OAuth clients), approve OAuth screens, change security settings, take real payments, connect the Polar PRODUCTION MCP (only the sandbox one is configured in `.mcp.json`), or merge.
- **Privacy:** no mail content, subjects, addresses or names in tables, logs or analytics (the `polar_events` log holds outcomes only).
- **Billing:** `billing_enforced=false` while testers use the product for free; the owner's account has a manual Pro grant that the webhook never overwrites. Do not flip the switch, run a payment window or change plans without the runbook in `docs/BILLING.md` and `supabase/tests/owner_payment_window.sql`, and always restore afterwards.
- **Database:** every table has RLS in the same migration; explicit per-command policies `to authenticated`; test in `supabase/tests/` (run in a transaction that ends in a rollback); security advisors must be clean. Never use the `service_role` key outside Edge Functions.
- **Edge Functions:** a function can import only its own folder, so shared files are copies that must stay identical (`entitlement.ts` in `gmail-sync`, `polar-webhook`, `polar-billing`, `gmail-connect`; `access.ts` in `gmail-sync` and `gmail-connect`); a test enforces this. Deploy through the Supabase MCP with all files of the function pasted. Do not deploy `gmail-sync` and `gmail-connect` changes that depend on `POLAR_SERVER` before the production plan (see issue 27).
- **Tests first** (TDD) for logic; mutation-check important tests; fake clients, never the real Google, Gemini or Polar in automated tests. Run the whole suite before committing:
  ```powershell
  $files = (Get-ChildItem -Recurse -Path supabase\functions,docs -Include *.test.ts,*.test.js | ForEach-Object { $_.FullName }); node --test $files
  ```
- **Deferred work** goes to GitHub issues (and `TODO.md`) with a clear owner step; do not leave it only in chat.
- Commits: English, `type: subject`, with the trailer given by the harness. Pushing to `main` is how this repo works today; say what was verified and what was not.

## Where to read more
`docs/BILLING.md` (plans, switches, webhook, runbook, decisions), `docs/TESTING.md` (every test run and lesson), `docs/POLAR-UI.md` (where things are in the Polar dashboard), `docs/COST-REPORT.md`.
