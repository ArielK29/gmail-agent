# Gemini cost per active member (issue #30)

What is measured: `gmail_usage(user_id, day, emails)` counts the mails summarized per member per day (the model is `gemini-3.5-flash-lite`, see `supabase/functions/gmail-sync/sync.ts`). Mail content is never stored, so tokens per mail are NOT in our database: read the real token use and price from the Gemini console (Google AI Studio -> Usage) and put them in the formula below. Nothing here is guessed.

## 1. Mails per member per month (run in the Supabase SQL editor, read only)
```sql
select date_trunc('month', day)::date as month,
       count(distinct user_id)        as active_members,
       sum(emails)                    as mails,
       round(sum(emails)::numeric / nullif(count(distinct user_id), 0)) as mails_per_member
from public.gmail_usage
group by 1
order by 1;
```
First numbers (2026-10-14): 1 member (the owner), 62 mails in October so far.

## 2. Cost per member per month
`cost = mails_per_member x (input_tokens_per_mail x input_price + output_tokens_per_mail x output_price)`
- `input_tokens_per_mail`, `output_tokens_per_mail`: total tokens of the month in the Gemini console divided by `mails` from the query above.
- prices: from Google's current price list for the model, in the currency of the bill, converted to ILS.
- Add the extra calls that are not mails: calendar and tasks reading, the daily briefing and the morning e-mail, if they call Gemini.

## 3. Decision rule (from #30)
Cost per ACTIVE member above about 3-4 ILS per month: raise Pro to about 29 ILS and/or cap the free tier. Below: keep 19 ILS and no limits. Needs real usage (testers phase); with one member the number means little.
