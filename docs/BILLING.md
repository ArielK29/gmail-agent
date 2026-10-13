# Billing runbook (Polar subscriptions, issue #22)

How money and access work in the Gmail agent, and what to do when something looks wrong. Written for the owner and for Claude.

## The picture
```
page (GitHub Pages) -> polar-billing (member's session) -> Polar checkout page (the member pays there)
Polar -> polar-webhook (signed message) -> table `subscriptions` -> gmail-sync checks `isPro` on the server
```
- Card details never touch our code. We store: status, period end, "cancel at period end", and Polar's customer and subscription ids.
- Only `polar-webhook` writes `subscriptions` (and the owner, by SQL, for manual grants).

## Plans
| | Free | Pro |
|---|---|---|
| Automatic summaries, daily summary, briefing card (deadlines, replies, handled marks) | yes | yes |
| Scan and cross-check | no | yes |
| Calendar and tasks | no | yes |
| Morning e-mail (and its test button) | no | yes |

While `billing_enforced` is `false` (the testers phase) everybody has everything. Pro rule: `active` or `trialing` until the period end + 3 days; `past_due` only inside those 3 days; everything else is Free. The owner has a manual grant (`source = 'manual'`, no end date) that webhooks never overwrite.

## Switches (table `app_settings`, readable by members, written only by the owner / service role; NEVER put a secret there)
| key | values | meaning |
|---|---|---|
| `billing_enforced` | `false` / `true` | `false`: everything free. `true`: Free and Pro are enforced. |
| `polar_environment` | `"sandbox"` / `"production"` | what the page tells the member ("test payment, no real charge" unless production). Must match `POLAR_SERVER`. |

```sql
update public.app_settings set value = 'true'::jsonb, updated_at = now() where key = 'billing_enforced';
update public.app_settings set value = '"production"'::jsonb, updated_at = now() where key = 'polar_environment';
```
Before turning payments on for real: every member who should keep Pro must have a subscription or a manual grant, the staging decision (below) is made, `POLAR_SERVER=production` and the production secrets are set.

## Supabase secrets (Edge Functions -> Secrets)
`POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_ID`, `POLAR_SERVER` (`sandbox` by default; `production` only on purpose), `APP_URL` (exists), `RESEND_API_KEY` (morning e-mail). Each environment (sandbox, production) has its own token, product, webhook endpoint and secret: Polar keeps the two worlds completely separate.

## Webhook endpoint
`https://<project>.supabase.co/functions/v1/polar-webhook`, subscription events (`subscription.*`). It answers: 200 applied / ignored / duplicate, 403 bad signature or too old (5 minutes), 413 too large, 503 no secret configured, 500 could not save (Polar then retries by itself, and nothing was recorded, so nothing is lost).

## Things that can go wrong
| Symptom | Likely cause | What to do |
|---|---|---|
| Member paid but is still Free | webhook not delivered or secret wrong | Polar dashboard -> Webhooks -> delivery log; fix the secret; press "redeliver". Meanwhile grant by hand: `insert into subscriptions (user_id, source, status, current_period_end) values ('<id>','manual','active', now() + interval '1 month') on conflict (user_id) do update set source='manual', status='active', current_period_end=excluded.current_period_end;` (and remove the manual row once the real one arrives: `delete ... where source='manual'`). |
| Webhook answers 403 for every message | wrong `POLAR_WEBHOOK_SECRET` (sandbox secret in production or the other way round) | set the secret of the right environment. |
| The morning e-mail is refused (403) in the Resend sandbox | the default sender `onboarding@resend.dev` may only mail the address of the Resend account itself | open the Resend account with the same e-mail address as the member's Gmail, or verify a domain and set `EMAIL_FROM`. |
| Webhook answers 503 | `POLAR_WEBHOOK_SECRET` not set | set it. |
| "Payment not available yet" on the page | `POLAR_ACCESS_TOKEN`, `POLAR_PRODUCT_ID` or `APP_URL` missing | set them. |
| A member cancelled but still has Pro | normal: access continues until the period end (+3 days grace) | nothing. |
| A member wants a refund | **A refund alone does NOT end the subscription** (per Polar's docs; to be confirmed in the sandbox test). Order: (1) in the Polar dashboard REVOKE (or cancel immediately) the subscription, the webhook then switches the access off; (2) refund the order. A refund without a revoke leaves the member Pro and billed again next month. (The old text of this runbook said the refund switches access off; that was wrong.) | nothing else. |
| A chargeback or dispute | not handled automatically (only `subscription.*` events are subscribed) | Polar e-mails the owner; revoke the subscription in the Polar dashboard by hand. |
| Free members see Pro data | should not happen: the server refuses | check `billing_enforced`, then the `subscriptions` row; run `supabase/tests/rls_subscriptions_test.sql`. |

## Known gaps (decide before real customers)
- **Deleting a member does not cancel the Polar subscription.** There is no account deletion in the agent yet; the table row disappears with the member (cascade) but Polar keeps billing. Before launch: cancel in Polar first, or build the deletion flow with a Polar cancel call.
- **Staging environment** (second Supabase project + staging page + Polar sandbox, as in the lesson of 2026-10-13) does not exist yet; it costs money (a third project). Until then the one project talks to the Polar sandbox only.
- **Checkout spam:** a signed-in member can create many checkout sessions (each only under their own Polar customer). Low impact; add a cooldown if it is ever abused.
- **Price shown on the page:** none (the price lives in Polar and is shown on Polar's page).

## Tests
`docs/TESTING.md`, section "Subscriptions with Polar". Run everything: see the command at the top of that file.

## Decisions about the Polar organization (2026-10-13)
- Organization name `Gmail Agent`, slug `gmail-agent` (or `gmail-agent-ariel` if taken), type Individual, software / SaaS, pricing model Subscription.
- **Default payment currency: Israeli New Shekel (ILS)**, chosen by the owner (not US Dollar). Suggested Pro price: about 19 ILS per month (roughly 5 USD); the price is set in Polar, never in the code.
- The Polar SANDBOX MCP server (`polar-sandbox`, https://mcp.polar.sh/mcp/polar-sandbox) is installed in the owner's Claude Code user configuration and in the project file `.mcp.json`. It needs the owner's one-time OAuth sign-in (`/mcp`). The production server is deliberately not installed.
## Polar sandbox state (2026-10-12)
- The Polar SANDBOX MCP server is authenticated (OAuth done by the owner in the browser). The CLI used for it lives in the Claude desktop package folder, so `claude` is not on the PATH of the terminal panel; the helper scripts in `scripts/` call it by full path.
- Sandbox organization in use for the tests: `duofit-polar` (created by the owner on 2026-10-12, default currency ILS). Before production a proper organization for the Gmail agent should be created (name, support e-mail, product URL).
- Sandbox product `Gmail Agent Pro`: id `c0a5bcf3-700a-4076-9eed-9b3d542be0fb`, recurring every 1 month, fixed price 19.00 ILS. The id is not a secret; it is the value of the Supabase secret `POLAR_PRODUCT_ID` (the owner sets the secrets).
- Windows PowerShell 5.1 breaks double quotes inside a prompt passed to a program: keep helper prompts free of double quotes (see `scripts/polar-create-pro-product.ps1`).
## Owner decisions on the payment loop (2026-10-12, after the mentor review)
- **Pro features** stay as decided: Free = automatic summaries, daily summary card, briefing card; Pro = scan and cross-check, calendar and tasks, morning e-mail.
- **Price:** ONE monthly Pro product at 19 ILS. No yearly plan, no trial, no second tier yet (revisit after about 3 months of real payers: yearly about 190 ILS).
- **Testers when billing starts:** delegated to Claude; chosen default = 3 months of free Pro by a MANUAL grant with an end date (`source='manual'`, `current_period_end` set), no Polar product. Needed before `billing_enforced=true`: one grant row per tester.
- **Free tier limits:** not now. First measure the Gemini cost per active member during the testers phase (existing cap: 300 mails per day per member), then decide a limit or a price change (if the cost is above about 3-4 ILS per member per month, raise the price to 29 ILS or cap the free tier).
- **Order of work (mentor):** Session A (Claude alone): sandbox pre-flight, webhook outcome logging, product allowlist in the webhook, environment reported by the billing function, price shown on the plan card, refund text fixed (done). Session B: one 30-45 minute sandbox payment window with the owner BEFORE testers join (the flag is global): buy, replay, double purchase, portal, cancel/uncancel, renewal, failed renewal (card 4000 0000 0000 0341), recovery, refund (+ revoke), re-buy, cleanup. Go-live later: Google verification and paid Gemini first, delete-my-account with Polar revoke, sandbox-row purge or environment tag, production Polar organization and payouts, accountant check on VAT status, refund policy text.
## Order of priorities (owner, 2026-10-12): FREE TESTERS FIRST
The first thing Ariel does is work with testers for free (`billing_enforced=false`, everything free). Payments are NOT on the critical path for that: the remaining payment work (Session A code changes, Session B payment window) happens in parallel or after, but BEFORE any real money. What blocks the testers phase is elsewhere: #8 tester e-mails in Google Audience (max 100 in Testing mode), #86 SMTP for e-mail sign-up (or use "Sign in with Google"), #7 Google secret in Supabase, #11 reconnect every 7 days (Testing mode), and the Gemini free-tier privacy statement (#9).
Pre-flight of the Polar sandbox (read-only, 2026-10-12): allow_multiple_subscriptions=false (good: no double subscription), benefit_revocation_grace_period=0, proration=prorate, tax behavior=location, all 14 customer e-mails on, currency ILS, webhook ab254d57 enabled with the 11 subscription events (API 2026-10), product Gmail Agent Pro 19.00 ILS monthly without trial. Payouts are enabled but not set up (payout_account_id empty): needed before real money.
## Payment hardening (issue #24, 2026-10-12)
- **Webhook ignores other products:** only subscriptions of `POLAR_PRODUCT_ID` change access (the sandbox organization is shared with another app). If the product id is missing the webhook answers 503 (Polar retries). Where to look when a payment does not arrive: table `polar_events` (server only): columns `outcome` (applied/ignored), `reason` (for example `other_product`, `no_product`, `manual_grant`, `older_than_stored`), `user_id`, `subscription_status`, `current_period_end`, kept 30 days. Example: `select received_at, type, outcome, reason, subscription_status from polar_events order by received_at desc limit 20;`
- **Environment tag:** every row written by the webhook carries `polar_server` ('sandbox' or 'production', from `POLAR_SERVER`; only the exact word `production` means production). A row of the other environment never gives Pro and never blocks a purchase. Manual grants count everywhere. Old rows were tagged sandbox by migration 019. Before go-live you can still purge the sandbox rows: `delete from subscriptions where source='polar' and polar_server='sandbox';`.
- **The page asks the server** (`polar-billing`, action `info`) for the environment and the price, read from Polar and cached 5 minutes. The setting `app_settings.polar_environment` is no longer used by the page (informational only; it can be removed later).
- **Not deployed yet:** gmail-sync and gmail-connect (they contain the same environment rule). No behaviour change while `POLAR_SERVER` is sandbox; deploy them from `main` BEFORE switching to production (checklist #27).
## Delete my account (issue #26, 2026-10-13)
The page button "מחק את החשבון שלי" calls the Edge Function `delete-account`. Order: the Polar customer is deleted first (anonymized; Polar ends the subscription at the same time), then the Gmail data and the subscription row, then the Google token, then the member. If Polar cannot do its part, NOTHING is deleted and the member is told; trying again later is safe. **Token scope needed: `customers:write`** (so the sandbox/production token must keep it; the minimal set is therefore `checkouts:write`, `customer_sessions:write`, `products:read`, `customers:write`; `customers:read` and `subscriptions:read` are not used). Known edge: a member whose Polar webhook never arrived has no stored customer id, so no Polar call is made for them (Polar retries webhooks, so this should not happen; check `polar_events` if in doubt). Manual runbook if the function is unavailable: revoke the subscription and delete the customer in the Polar dashboard first, then delete the member in Supabase.