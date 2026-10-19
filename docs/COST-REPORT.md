# Gemini cost report (issue 30)

Answers one question: **what would the model cost per ACTIVE member per month?** Decision rule from issue 30 and `docs/BILLING.md`: if it is above about 3 to 4 ILS per active member per month, raise the Pro price to about 29 ILS and/or cap the free tier.

Run it in the Supabase SQL Editor (project `ppkbuyiatkxpfeqmvwzb`). It is read only and uses `gmail_usage` (mails summarized per member per day, written by `gmail-sync`). Change the numbers in the first block, not the rest.

## What the numbers assume (all are estimates)
| Parameter | Value | Where it comes from |
|---|---|---|
| Input tokens per mail | 900 | Upper estimate: at most 1500 characters of body (`MAX_BODY_CHARS`), sender and subject, and a share of the prompt (10 mails per model call, `CHUNK_SIZE`). |
| Output tokens per mail | 250 | Upper estimate: summary, category, urgency and suggested action as JSON in Hebrew. |
| Price | $0.30 per 1M input, $2.50 per 1M output | `gemini-3.5-flash-lite`, paid tier, standard, from [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing) on 2026-10-20. The free tier costs nothing, so this is what the PAID tier (issue 9) would charge. |
| Exchange rate | 3.7 ILS per USD | Update to the current rate. |
| "Active" member | mails on at least 5 days of the month | Change `active_days_in_month` if the testers use it less. |

The estimate is deliberately on the high side. **Replace the two token numbers with real ones** as soon as the Google AI Studio / Cloud console shows token counts for a few days (Usage page, requests and tokens per day), and the dollar total there is the final check.

## Not counted
- Calls that are not mail summaries (reply checks, history scans are counted because they write to `gmail_usage`; the morning e-mail is not a model call).
- Failed or retried model calls (they cost tokens but are not counted as summarized mails).
- Any month before the usage table existed.

## Query
```sql
with params as (
  select
    900::numeric  as input_tokens_per_mail,    -- upper estimate: 1500 characters of body (MAX_BODY_CHARS) + sender and subject + share of the prompt
    250::numeric  as output_tokens_per_mail,   -- upper estimate: summary, category, urgency, suggested action as JSON, in Hebrew
    0.30::numeric as usd_per_million_input,    -- gemini-3.5-flash-lite, paid tier, standard (ai.google.dev/gemini-api/docs/pricing, 2026-10-20)
    2.50::numeric as usd_per_million_output,
    3.7::numeric  as ils_per_usd,              -- update to the current rate
    5             as active_days_in_month      -- a member is "active" with mails summarized on at least this many days of the month
),
per_member as (
  select date_trunc('month', day)::date as month, user_id, sum(emails)::int as emails, count(*) filter (where emails > 0)::int as days_with_mail
  from public.gmail_usage
  group by 1, 2
),
priced as (
  select m.*, p.active_days_in_month,
         m.emails * (p.input_tokens_per_mail * p.usd_per_million_input + p.output_tokens_per_mail * p.usd_per_million_output) / 1000000 * p.ils_per_usd as cost_ils
  from per_member m cross join params p
)
select
  month,
  count(*) filter (where days_with_mail >= active_days_in_month)                                   as active_members,
  count(*)                                                                                         as members_with_any_mail,
  sum(emails)                                                                                      as emails_summarized,
  round(avg(emails) filter (where days_with_mail >= active_days_in_month), 0)                      as avg_emails_per_active_member,
  round(avg(cost_ils) filter (where days_with_mail >= active_days_in_month)::numeric, 2)           as avg_cost_ils_per_active_member,
  round(max(cost_ils)::numeric, 2)                                                                 as max_cost_ils_any_member,
  round(sum(cost_ils)::numeric, 2)                                                                 as total_cost_ils,
  case when coalesce(avg(cost_ils) filter (where days_with_mail >= active_days_in_month), 0) > 3.5 then 'ABOVE the 3-4 ILS line (issue 30): decide price or free-tier cap' else 'below the 3-4 ILS line' end as verdict
from priced
group by month
order by month desc;
```

## Reading the result
| Column | Meaning |
|---|---|
| `active_members` / `members_with_any_mail` | How many members reach the active line, and how many have any mail at all. |
| `avg_cost_ils_per_active_member` | The number to compare with the 3 to 4 ILS line. |
| `max_cost_ils_any_member` | The most expensive single member; the cap is 300 mails per day (about 8 USD per month at these assumptions), so one heavy member cannot run up the bill. |
| `verdict` | Plain text: above or below the line. |

## First result (2026-10-20, real data)
One member (the owner), October: 190 mails summarized, estimated cost **0.63 ILS**, below the line. One member says little about future customers: run it again after the testers phase has several members.
