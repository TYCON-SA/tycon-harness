# Estimating at three levels

An estimate is useful if you can later see how far off it was. That is why the harness keeps every version of every
estimate, not only the last one: the epic with a range, the plan with one value per story, and the story that adjusts it
when it is written. When each story closes, the clock hours add up and you see the error at each level.

## Where it is kept

In the stories repo, in `.tycon/estimates.jsonl`: one line per estimate, append only. Nothing is overwritten or deleted.
The version that counts for each thing is the last line that names it. The first entry adds
`.tycon/estimates.jsonl merge=union` to `.gitattributes`, so two branches that add lines merge without a conflict in a
local merge. A merge made by the server may not honor that attribute: if two pull requests clash on the register, a
local merge that keeps the lines of both solves it.

A line that cannot be read (broken JSON, an unknown version, a broken field) is counted and reported, and the rest is
read anyway. The file is never rewritten.

## The three levels

| Level | When | Command |
|---|---|---|
| Epic | when it is written: a range with its assumptions | `node scripts/lib/estimates.js epic --repo <repo> --epic 3 --min 40 --max 70 --assumptions "no data migration"` |
| Plan | when it is split into stories: one value per story | `node scripts/lib/estimates.js plan --repo <repo> --story <id> --value 12` |
| Story | when it is written in detail: the adjustment | `tycon-create-story` does it; by hand, `estimates.js story --repo <repo> --story <id> --value 16` |

A story's epic comes from the `epic:` in its frontmatter. If that field changes, the story counts in the new epic.

## Seeing an epic

```bash
node scripts/lib/estimates.js report --repo <repo> --epic 3
```

It gives the range, the plan total, the current total (the story estimate if there is one; otherwise the plan's) and
whether it falls inside, below or above the range, and by how much. With `--json` it also lists each story with its
versions.

## The proposal

When a story is written, `tycon-create-story` looks for the most similar closed stories with their real hours
(`scripts/lib/similar-stories.js`), proposes a value based on them and says so. The person confirms, corrects or skips;
the register keeps what the model proposed, what stayed, which stories it was based on and who confirmed it. Skipping is
fine: a missing estimate never stops the story.

At first the proposals come out empty: they need closed stories with real hours, and those hours are recorded when a
story closes. Until then, the person estimates.

Similarity is a simple score: same epic, `topics` in common, declared files in common and title words in common. Only
stories in `done` with real hours count.

## The unit

The organization chooses it in `team-repos.json → estimates`: `unit` (`hours`, `days` or `points`),
`hours_per_day` (default 8) and `hours_per_point` (default none). Without the key, hours. Each line keeps the unit it
was written in, so changing the unit rewrites nothing.

The report compares in hours. Days use `hours_per_day`. With points and no `hours_per_point` it does not invent a rate:
if the epic mixes units, it shows the totals per unit and does not mark it inside or outside its range, and the story
proposal gives no value.

## Exit codes

`0` done · `2` invalid input (a value that is not a number greater than 0, `--min` greater than `--max`, a story that does
not exist or has no `epic:`): nothing is written · `3` the organization's configuration or the register could not be read.
