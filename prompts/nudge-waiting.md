[duty -> {{key}}] Waiting on {{target}} since {{waitingSince}}; no new evidence for {{age}}.
Waiting does not stop this clock; 40 minutes without progress goes to the lead with what you wait on.
If waiting on exhausted provider token allowance, usage quota or credit budget, stay stopped.
Escalate for the user's decision. Reset coupons, credits (including existing paid or promotional balances),
top-ups and paid overage require explicit user permission for the specific use and amount.
Do not work around the limit with automatic redemption, retries or account/provider/model switches.
- Check that what you wait on is still alive and moving (a check, a process, a request):
{{wholeTarget}}
- It moved: `{{dori}} report {{key}} --text '<what changed>' --evidence <its log, file or link>`
- It is done: `{{dori}} report {{key}} --status working --text '<result>' --evidence <file|link>`
- It is stuck: `{{dori}} report {{key}} --status waiting --text 'STUCK: <what you saw>'`, then work around it.
