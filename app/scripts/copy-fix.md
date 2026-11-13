# Fixing copy and density: the agent playbook

Goal: every page as easy as possible to understand. Short, plain copy; nothing said twice; no figure shown twice.
Shorten, never hide: numbers, limits, prices and consequences stay.

## Loop

1. **Measure.** From `app/`: `bun run copy-lint --all` (every string finding, worst files first) and
   `DENSITY_OUT=<dir> bun run density` (`<dir>/summary.md`, `report.json` and an annotated screenshot per page and
   device: duplicates magenta, long blocks orange, explanations with no action yellow).
2. **Pick the worst page** by density score. Read its screenshot and findings, then the copy-lint findings in the
   files that render it.
3. **Fix, in this order:**
   - **Duplicate information** (`dup-value`, `dup-text`, `dup-label`): keep the one place a reader looks for it
     (usually the page's own card, not the sidebar or a banner) and remove or link the other.
   - **Long blocks and inert explanations:** cut to one short sentence next to the control it explains; move
     reference detail to the docs and link it.
   - **String findings:** shorten to the limit for its kind (`LIMITS` in `copy-lint.mjs`), drop filler and hedges, use
     the glossary's term, digits, sentence case, and don't restate the heading or label.
4. **Check.** Rerun both linters (a clean local run drops fixed findings from the baselines), `bun run build`, and
   `bun run cls` if a layout changed (CLS ≤ 0.001, phone layout holds).
5. **Ship.** One page per PR with the before and after screenshots and scores, and the updated baselines.

## Glossary: one name per concept

| Use | Not |
| --- | --- |
| workspace | account, team, tenant (“account” is the person’s sign-in) |
| Hosted mail / your AWS account | shared, BYO, bring your own AWS |
| daily limit | quota, cap, sending limit (“SES quota” only for an AWS account’s own quota) |
| sender score | reputation score, health (“reputation” only for an SES account) |
| balance, add credit | funds, top up, wallet |
| address (receiving address when ambiguous) | inbound address, mailbox |
| agent inbox | sandbox mailbox, temp inbox |
| route, ritual, endpoint, omen, catch-all, trace | rule, script, destination, AI question |
| webhook | callback, hook |
| suppressed | blocked, blacklisted |
| subscribed / unsubscribed / unknown consent | opted in, confirmed |
| owners and admins | administrators, managers |

Style: lead with the outcome; one short sentence over two; errors say what went wrong and what to do, in one line.

## Exceptions

A finding that is right as it is (a legal phrase, a quoted API name): accept it with `--update-baseline` and say why
in the PR.
