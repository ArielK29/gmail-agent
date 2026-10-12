# Map of the Polar dashboard for the Gmail agent (sandbox, 2026-10-12)
Read-only tour of https://sandbox.polar.sh/dashboard/duofit-polar (the organization used for the tests). Use it when a payment looks wrong.
| Where (left menu) | What it shows | When we use it |
|---|---|---|
| Home | revenue, MRR, active subscriptions, orders, checkout conversion, timeline of events | quick health look |
| Products | the catalogue; product "Gmail Agent Pro" 19 ILS / month | change the price or archive (never delete a product that has subscribers) |
| Customers | one customer per member (matched by `external_id` = our member id) | find a member, see their subscriptions |
| Sales > Orders | every charge (date, customer, product, status, amount); Export | refunds are done from an order |
| Sales > Subscriptions | status, subscription date, renewal date, product | check Pro state; cancel/revoke here |
| Finance > Income | gross, fees, tax, net per transaction (payouts need a payout account: not set up yet) | before real money |
| Settings > Webhooks (`/settings/webhooks`) | our endpoint `Gmail Agent` + a **Deliveries** list per endpoint (status, HTTP response, redeliver) | when a payment did not reach us |
| Settings > Developers / Access tokens | the API token (shown once) | rotate if exposed |
| Settings > Customer portal | what members may do themselves (plan change allowed, e-mail change not) | before real money |
| Settings > Emails | the 14 customer e-mails (all on) | check texts before real money |
| "Exit sandbox" (top) | switches to the REAL Polar (production) | never by accident |
Our side of the same story: Supabase table `polar_events` (outcome of every webhook message) and `subscriptions` (state per member), see docs/BILLING.md.