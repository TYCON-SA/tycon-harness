# The automatic reviews

Before coding, an agent reviews the story's **plan**; after coding, the **adversarial pass** runs the code to hunt for
defects. This guide puts together when each review runs, who launches it, with what reviewer, who approves, when the
owner counts as away and how it is configured. In Spanish: [revisiones-automaticas.md](revisiones-automaticas.md).

Everything is configured on the organization site, Configuration tab, «How Claude works» (sections **Plan review**,
**What runs the review**, **Adversarial pass** and **Reviewer rounds**), and it lives in `team-repos.json` of the
profile repo. A bad value falls back to the built-in only in its key, and it is said.

## Delicate or routine

A story is **delicate** if `pipeline.js risk-class` marks it so: it touches security, data, brakes, signatures, the
installer, production, a migration, or declares `sensible:`. In doubt, delicate. The rest is **routine**.

## When the owner counts as away

- **The away mark** is set. Whoever gets the owner's message saying they are leaving («go on autonomously», «I'm off»,
  «see you tomorrow» or similar) sets it: the coordinator, or the session itself if there is no coordinator, with
  `marker.js owner-away set --phrase "<what they said>"`. It clears itself when the owner comes back: a message typed
  by them, a verified office message, a signature of theirs, or after 24 hours. The office shows it while it is set.
- Or a review's question has been waiting `plan_review.owner_away_minutes` minutes without an answer (built-in 20). The
  minutes count from when the question was recorded (`marker.js review-ask`).

## Matrix 1: the plan review

| Delicate? | Does it run? (built-in) | Who approves on «approved» |
|---|---|---|
| Yes | Always, without asking (`plan_review.delicate: always`) | The owner, with the result in the box |
| No | The owner is asked (`plan_review.routine: ask`). Owner away: it reviews (`plan_review.routine_owner_away: review`) | With a coordinator: she does, on the owner's behalf (`plan_review.coordinator_approves: true`). Without one: the owner |

The coordinator launches it (`marker.js plan-review --for-session <session>`); without a coordinator, the session
itself (`marker.js plan-review`), and that review only informs. Built-in, it runs one lens, «suposicion-falsa»: what
the plan believes about the code and is not true. The results:

| Result | What happens |
|---|---|
| «approved» | Delicate, or without a coordinator: it reaches the owner with «reviewed, no findings». Routine with a coordinator: she approves |
| «approved with notes» | Confirmed findings below the severity cut: it counts as approved, the session fixes them while coding and the box shows them |
| «rejected» | Only for a confirmed finding at the cut (built-in, a bug). The session fixes the plan and the review runs again. It reaches the owner at the cap of rejections in a row (`review.max_rounds`, built-in 3), or right away with `plan_review.rejected_reaches_owner: true` |
| «no verdict» | It reaches the owner with «could not review: <reason>». If the plan changed while it ran, it is retried once |
| Chose not to review | The owner approves, and the box says «no review» |

## Matrix 2: the code review (the adversarial pass)

| | Small change (up to `deep_review.small_max_files` code files, built-in 6) | Large change |
|---|---|---|
| Delicate | Always runs (`deep_review.delicate: always`) | Always runs |
| Not delicate | By day, it asks (`deep_review.small_routine_day: ask`). Owner away: it runs (`deep_review.small_routine_owner_away: run`) | It runs (`deep_review.large_routine: run`) |

The session itself launches it; the coordinator only gives the turn. A small but dense change, or one of NORMAL risk
for a reason other than size, counts as large. What always won still wins: the signed skip record, the repo's or the
organization's `always`, the flags that force it and the shared surface. A documentation-only run has no pass.

## Matrix 3: what runs the review (both)

| Option (`review_runner.order`) | What runs | Where it is declared |
|---|---|---|
| `claude` (built-in) | Claude Code from the terminal | `integrations/review-runner/integration.json` |
| `codex` | Codex from the terminal | same |
| `cursor` | Cursor's agent from the terminal | same |
| `claude-ollama` | Claude Code with Ollama's models | same |
| `custom` | the command the organization writes (`review_runner.custom_command`) | the profile (`team-repos.json`) |

The first on the list is «the reviewer» and the rest is the fallback order: if one hits its usage limit or fails, the
same agent is relaunched with the next one. In code mode only a confined reviewer runs. With
`review_runner.verifiers: per_lens` (built-in) the review launches one verifier per kind of finding, instead of one per
finding.

## The severity that blocks and the rounds cap

Only a confirmed finding with severity at the cut `review.blocking_severity` (built-in `bug`) rejects the plan or is
CRITICAL in the code; the rest confirmed are notes or warnings. The rounds cap `review.max_rounds` (built-in 3) applies
to both reviews; a repo adjusts it in its `.tycon/advisors.yaml`, by commit. There is no per-machine adjustment.

## The options

| Option | What it does | Key | Values | Built-in | When to change it |
|---|---|---|---|---|---|
| O1 | Plan review on delicate stories | `plan_review.delicate` | `always` · `ask` | `always` | `ask` if you prefer to decide each time, even on delicate ones |
| O2 | Plan review on routine stories | `plan_review.routine` | `always` · `ask` · `never` | `ask` | `always` to never ask; `never` if your team does not want it |
| O3 | Routine plan review with the owner away | `plan_review.routine_owner_away` | `review` · `wait` · `skip` | `review` | `wait` if you prefer it to wait; `skip` to go on without review |
| O4 | The coordinator approves a routine plan reviewed with no bugs | `plan_review.coordinator_approves` | `true` · `false` | `true` | `false` if you want to sign every plan yourself |
| O5 | A rejected plan reaches the owner right away | `plan_review.rejected_reaches_owner` | `true` · `false` | `false` | `true` if you want to see every rejection, not only at the cap |
| O6 | Code review on delicate stories | `deep_review.delicate` | `always` · `ask` | `always` | `ask` if you prefer to decide each time |
| O7 | Up to how many code files a change is small | `deep_review.small_max_files` | integer from 1 to 50 | `6` | higher if your stories touch many small files |
| O8 | Code review, routine and small, with the owner around | `deep_review.small_routine_day` | `ask` · `run` · `skip` | `ask` | `run` to always run it; `skip` for the old behavior |
| O9 | Code review, routine and small, with the owner away | `deep_review.small_routine_owner_away` | `run` · `skip` · `wait` | `run` | `wait` if you prefer it to wait for the owner |
| O10 | Code review, routine and large | `deep_review.large_routine` | `run` · `ask` | `run` | `ask` if you prefer to decide each time |
| O11 | The reviewer | `review_runner.order[0]` | `claude` · `codex` · `cursor` · `claude-ollama` · `custom` | `claude` | if your team works with another tool |
| O12 | The reviewers' fallback order | `review_runner.order` | list of those values, no repeats | `["claude"]` | to have a fallback when one hits its usage limit |
| O13 | Minutes without an answer to count the owner as away | `plan_review.owner_away_minutes` | integer from 5 to 240 | `20` | more if the owner usually answers late |
| O14 | Your own reviewer's command (only with `custom`) | `review_runner.custom_command` | text | — | with a reviewer that is not a built-in one |
| O15 | The rounds cap, the same for plan and code | `review.max_rounds` | integer from 1 to 6 | `3` | lower to stop sooner; higher if your stories are long |
| O16 | How many verifiers | `review_runner.verifiers` | `per_lens` · `per_finding` | `per_lens` | `per_finding` to measure one per finding |
| O17 | From what severity a confirmed finding blocks | `review.blocking_severity` | `bug` · `robustness` · `all` | `bug` | `robustness` or `all` to also block on the rest |
| O18 | Which lenses the plan review runs | `plan_review.lenses` | list of `suposicion-falsa` · `ac-sin-cubrir` · `prueba-que-falta` · `riesgo-sin-defensa` | `["suposicion-falsa"]` | add lenses for a wider review, at the cost of more agents |
