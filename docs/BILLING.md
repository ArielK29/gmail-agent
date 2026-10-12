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
| A member wants a refund | do it in the Polar dashboard; the webhook switches the access off | nothing else. |
| Free members see Pro data | should not happen: the server refuses | check `billing_enforced`, then the `subscriptions` row; run `supabase/tests/rls_subscriptions_test.sql`. |

## Known gaps (decide before real customers)
- **Deleting a member does not cancel the Polar subscription.** There is no account deletion in the agent yet; the table row disappears with the member (cascade) but Polar keeps billing. Before launch: cancel in Polar first, or build the deletion flow with a Polar cancel call.
- **Staging environment** (second Supabase project + staging page + Polar sandbox, as in the lesson of 2026-10-13) does not exist yet; it costs money (a third project). Until then the one project talks to the Polar sandbox only.
- **Checkout spam:** a signed-in member can create many checkout sessions (each only under their own Polar customer). Low impact; add a cooldown if it is ever abused.
- **Price shown on the page:** none (the price lives in Polar and is shown on Polar's page).

## Tests
`docs/TESTING.md`, section "Subscriptions with Polar". Run everything: see the command at the top of that file.
