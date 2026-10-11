# Morning briefing (issue #16) Implementation Plan

**Goal:** one morning card that answers "what did I miss": mails whose deadline is close or passed, mails I probably still owe an answer to, what is new since my last visit, plus the urgent mails the daily summary already lists. Gmail only, no new Google permission.

**Architecture:** the model returns a `deadline` (a date or empty) in the same call that already classifies each mail; the sync saves `thread_id` and `due_date`; after saving, a best-effort step (`refreshReplyState`) asks Gmail for the headers and labels of the newest threads (`threads.get`, metadata only) and stores `needs_reply` (the last message of the thread is not mine, judged by the SENT label so aliases work). The page computes the briefing from the saved rows (`morningBriefing`, pure, tested).

## Decisions
1. Deadlines come from the model but are validated by code: a real calendar day between 60 days ago and 400 days ahead, else ignored.
2. "Owe an answer" is a hint, worded "ייתכן שצריך לענות": only personal / work / finance / important mails, not urgent-low, not automatic senders (no-reply, notifications, newsletters), from the last 14 days, at least 12 hours old; re-checked at most every 6 hours, at most 20 threads per run.
3. The reply check can never fail or slow a sync: its own try/catch, its own limit, errors only logged.
4. "Since my last visit" is stored in the browser (localStorage), nothing on the server.
5. Not in v1: calendar and tasks (new Google permissions and verification), pushed delivery (#14), marking an item as done (v2).

## Edge cases found before coding
| # | Edge case | Decision |
|---|---|---|
| 1 | The model invents a date (2026-02-30, year 1900, "tomorrow", an empty string, a number) | `parseDeadline`: strict real day in the window, otherwise null |
| 2 | Relative dates in a mail ("by Friday") | The model gets today's date in the prompt |
| 3 | Draft, trash and spam messages in a thread | Ignored when deciding who wrote last |
| 4 | Thread where I answered from another address (alias) | Judged by the SENT label, not by the address |
| 5 | Gmail busy (429/5xx/network) during the thread check | Skip, retry in 6 hours; the sync result is not affected |
| 6 | Thread deleted (404) | needs_reply = false |
| 7 | Messages with missing or broken dates | Order by date when valid, else array order; never throws |
| 8 | Newsletters, no-reply, notifications | Never candidates |
| 9 | A member with thousands of mails | At most 20 threads per run, newest first |
| 10 | Dates and time zones on the page | The deadline is a calendar day compared with the member's local day; "older than 12 hours" uses real timestamps |

## Checkpoints
CP1 pure logic + tests. CP2 migration 010 + permission re-run. CP3 sync changes + reply step + tests (fake Gmail, chaos extended, mutation). CP4 page logic + tests. CP5 page + browser check. CP6 deploy, outside-in probes, privacy and terms, TESTING.md, issue closed.