[duty -> {{key}}] No new evidence since {{since}} ({{age}}), quiet for {{minutes}} minutes, no READY yet.
A report without new evidence does not reset this clock; 40 minutes without progress goes to the lead.
Provider quota or credit exhaustion overrides this nudge: STOP model work and report the blocker.
Reset coupons, credits (including existing paid or promotional balances), top-ups and paid overage
require the user's explicit permission for the specific use and amount.
Never redeem automatically or switch accounts/providers/models to evade the limit.
- Done: `{{dori}} ready {{key}} --text '<final answer>' --evidence <link>`
- Progress: `{{dori}} report {{key}} --text '<milestone>' --evidence <changed file | new PR link>`
- Blocked outside this pane: `{{dori}} report {{key}} --status waiting --for '<what you wait on>' --text 'WAITING: <blocker>'`
- Otherwise continue the work now.
