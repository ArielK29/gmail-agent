# Subscriptions with Polar (issue #22) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** A member can pay for the Pro plan of the Gmail agent through Polar.sh; the server alone decides who is Pro, and the Pro features are refused for everybody else.

**Architecture:** Same shape as the lesson (page on GitHub Pages -> Supabase Edge Function -> Polar -> webhook -> Supabase): `polar-billing` (member's session) creates a Polar checkout or a customer-portal session; Polar sends signed webhooks to `polar-webhook`, which is the ONLY writer of the `subscriptions` table; the sync, the scan and the e-mail check `isPro` on the server. Card details never touch our code.

**Tech Stack:** Supabase Edge Functions (Deno), Postgres + RLS, Polar REST API (`/v1/checkouts/`, `/v1/customer-sessions/`), Standard Webhooks signatures (HMAC-SHA256), plain JS page.

**Spec:** Polar docs read on 2026-10-13 (checkout sessions, webhooks, subscription events). Owner decisions (chat, 2026-10-13): app = Gmail agent; Free = automatic summaries + daily summary card (+ the briefing card with deadlines and replies); Pro = everything: scan and cross-check, calendar and tasks, e-mail briefing (and its test button); suggested price 5 USD per month (changeable in Polar, not in code).

**Owner decision 2 (2026-10-13, mid-build):** the first stage after launch is the TESTERS phase, so the app is free for everybody at first. A server setting `billing_enforced` (table `app_settings`, default `false`) makes every member Pro-equivalent; the owner flips it to `true` with one SQL line when payments go live. The page shows no payment buttons while it is `false`.

## Global Constraints
- Server-side enforcement only; the page hides things for comfort, never for security.
- `subscriptions` is written only by `polar-webhook` (service role) and by the owner through SQL for manual grants (`source = 'manual'`, never overwritten by a webhook).
- Secrets only as Supabase secrets: `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_ID`, optional `POLAR_SERVER` (`sandbox` default, `production`). None in the repo, none typed by Claude.
- Webhook: signature verified on the RAW body, timestamp within 5 minutes, idempotent by `webhook-id`, out-of-order safe by `modified_at`, always 200 for valid-but-ignorable events (Polar retries on errors).
- Access rule: `hasPro = !billing_enforced || isPro(subscription)`.
- Pro rule: `active` or `trialing`; `past_due` for 3 days after the period end; everything else is Free.
- All UI text Hebrew, plain text only (textContent).

## Review Focus
- A forged or replayed webhook must never grant Pro (tampered body, wrong secret, old timestamp, future timestamp, missing headers).
- The same webhook twice, or an old event arriving after a newer one, must not change the result.
- A member must not be able to write or read other members' subscription rows or Polar ids; a free member must not reach any Pro feature by calling the functions directly.
- A manual grant to the owner must survive webhooks.
- A failed save after a webhook was accepted must lead to a retry, not a lost payment.

### Task 1: Database
- [ ] migration 016: `subscriptions` (user_id pk, source, status, plan, current_period_end, cancel_at_period_end, polar_customer_id, polar_subscription_id unique, polar_modified_at, updated_at), RLS select-own with column grants (no Polar ids), `polar_events` (webhook_id pk, type, received_at; RLS, no policy); permission test file; apply with the MCP; advisors.

### Task 2: Pure logic (`entitlement.ts`, `webhook.ts`)
- [ ] `isPro(row, nowMs)`; `verifySignature(secret, headers, rawBody, nowMs)` (both secret interpretations, several signatures, constant-time compare); `parseSubscriptionEvent(payload)` -> `{userId, row}` or `ignore`. Tests first: valid and invalid signatures, mapping of every status, garbage payloads (fuzz).

### Task 3: `polar-webhook` function
- [ ] Claim `webhook-id`, apply the change if not older than the stored one, skip manual rows, give the claim back on failure (500 so Polar retries). Tests with a fake database: duplicate, out of order, unknown member, manual row, failed write, chaos.

### Task 4: `polar-billing` function
- [ ] member session -> `checkout` (allowlisted plan, own user id as `external_customer_id`, success and return URL from `APP_URL`) or `portal`; 409 when already Pro; clear errors when not configured. Tests with a fake Polar.

### Task 5: Enforcement in `gmail-sync`
- [ ] `startScan`, `refreshAgenda`, `sendDigests`, `sendTestDigest` require Pro (402 `pro_required` for member calls; silently skipped in background runs). Tests for each, including a lapsed subscription and a failing subscription read.

### Task 6: Page
- [ ] Plan card (Free/Pro), "upgrade" button, "manage subscription" button, `?billing=success` message with a short refresh loop, Pro-only parts show a lock text for Free members. Browser check with a throw-away member (free view, Pro view, hostile values).

### Task 7: Docs, deploy, verify
- [ ] Privacy and terms (Polar as seller of record and payment processor, what is stored), TESTING.md, deploy three functions, outside-in probes (garbage signature gets 403, no signature gets 403), mutation checks, advisors, Snyk, issue comments. Owner-only steps go to the deferred list (Polar account and sandbox, product, token, webhook endpoint and secret, Supabase secrets).

## Environments (owner's lesson, 2026-10-13)
Production = `main` + the live Supabase project + Polar live. Staging = a second Supabase project + a staging page + Polar SANDBOX. Same code, different addresses and secrets. Decision for later (costs money: a third project): create the staging environment BEFORE `billing_enforced` is turned on and `POLAR_SERVER=production` is set. Until then the one project runs against the Polar sandbox only, and the page says "תשלום ניסיוני, אין חיוב אמיתי".