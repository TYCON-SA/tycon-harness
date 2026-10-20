# Your own reviewer pack

The harness ships general reviewers: security, tests, silent failures, acceptance-criteria coverage. It does not ship
one per framework. The mistakes specific to your stack (an unsanitized `{@html}` in Svelte, a blocking call in FastAPI)
are caught by a reviewer your organization writes and brings in a **pack**.

There is an example pack to copy in `examples/packs/svelte-fastapi/`, with two small reviewers and their exam cases. It
is not installed or active.

En castellano: [reviewer-packs.md](reviewer-packs.md).

## What a pack contains

```text
my-pack/
  pack.json                      the manifest: which reviewers it brings and when each one runs
  agents/<reviewer>.md           each reviewer: its instructions and its rule catalog
  exam/<reviewer>.json           the exam cases (they travel with the pack, as data)
```

A pack can also bring `skills/`, `guides/`, `templates/` and `claude-md-blocks/`. The full manifest format is in
[agent-architecture.md](agent-architecture.md), section «Paquetes de revisores».

**A reviewer** is a `.md` file with frontmatter (`name`, `tools`, `model`, `description`) and a rule catalog. Each rule
has an ID with the reviewer's prefix (`FASTAPI-C1` is critical, `FASTAPI-W1` is a warning), and each finding comes out
as `- [FASTAPI-C1] file:line …`. Copy one of the two in the example and change its name, prefix and rules. Two packs
cannot declare the same agent.

## When a reviewer runs

`when` in `pack.json` decides. The vocabulary is closed (`detection`, `files`, `added`, `all`, `any`, `no`): an unknown
key makes the pack invalid.

| Condition | Runs when |
|---|---|
| `{ "detection": "pyModified" }` | the diff touches a `.py` file (`svelteModified`, `vueModified`, `tsxModified`, `csModified`, `sourceModified`, `codeModified` and the other flags in the «Paquetes de revisores» section) |
| `{ "files": "(^\|/)app/routers/" }` | a path in the diff matches the regular expression |
| `{ "added": { "pattern": "from fastapi", "extensions": [".py"] } }` | an added line in those files matches |
| `all`, `any`, `no` | combine the above |

The example uses a single flag: the FastAPI reviewer runs on any `.py`, even one with nothing about FastAPI in it (the
reviewer answers `✅ OK`). If your repo has a lot of non-web Python, narrow it:
`{ "all": [ { "detection": "pyModified" }, { "added": { "pattern": "fastapi|APIRouter", "extensions": [".py"] } } ] }`.

`surface` says which files make it run again on each review round; `depth` (`lean`, `standard`, `deep`) says how
expensive the model that runs it is.

## How to activate it

**With the team profile** (the usual way):

1. Copy `pack.json`, `agents/` and `exam/` to `packs/<your-pack>/` in your team's profile repo. Do not copy the
   `README.md`: the team layer accepts a closed list of paths and, with a file outside it, it is not stacked on any
   machine. The cases in `exam/` travel as data: one level, `.json` only.
2. Activate it with `packs.default` in `team-profile.json` (`"all"` or a list with its name), or in the site's
   Configuration tab, Packs section.
3. Each machine gets it on its next update: the harness puts it in its packs folder and links its agents.

A repo can narrow the list with `packs:` in its `.tycon/advisors.yaml` (`packs: []` is none), never add to it.

**To try it on your machine without touching the profile**:

```bash
export TYCON_PACKS_DIR=<folder that contains your pack>   # e.g. the one that holds my-pack/
export TYCON_PACKS_DEFAULT=<your-pack>
```

With those two variables the pipeline picks your reviewers. To launch them, your tool has to find their `.md` files: in
Claude Code, copy them to `~/.claude/agents/` or to the repo's `.claude/agents/`. With the team profile the harness does
that.

## How to validate it and see when it runs

`pipeline.js advisors` validates the pack and says which reviewers run for the files you pass. A broken pack exits
with code 2 naming the file, the reviewer and the reason. Do it in a scratch repo and outside a pipeline run: the
command records the reviewers' start in the session log. `<harness>` is the folder where the harness is installed
(`~/.tycon/harness` by default).

```bash
mkdir /tmp/scratch && cd /tmp/scratch && git init -q && mkdir app && echo 'x = 1' > app/util.py
TYCON_PACKS_DIR=<folder> TYCON_PACKS_DEFAULT=<your-pack> \
  node <harness>/skills/tycon-pipeline/scripts/pipeline.js advisors --repo /tmp/scratch --files app/util.py
```

In the output, `all` has the set of reviewers and `packs` says which packs it loaded.

## How to examine a reviewer

A reviewer is a request to a model: you test it with cases. For each rule, one case that must flag it (`must-flag`) and
its corrected twin, which must not (`must-not-flag`). Each case brings its files and passes on the presence or absence
of the rule ID in the report. Mark one pair as `"canario": true`. The format is in the example's `exam/*.json`: each
file declares its `advisor` and each case its `id`, its `type` (`must-flag` or `must-not-flag`), its `rule` and its
`files` (relative paths that stay inside the case's folder, text content); optionally `git_commits`, `prompt`,
`canario` and `nota`, and nothing else. A case outside that format stops the exam with the reason, and an exam that did
not judge all its cases does not come out green.

```bash
cd <harness>
node scripts/controls-bench/advisor-runner.js --pack <your pack folder> --list            # which cases it runs
node scripts/controls-bench/advisor-runner.js --pack <your pack folder> --tool claude --runs 2
```

`--pack` runs only the cases in `<pack>/exam/`, with the agents from the pack's folder; the report goes to
`scripts/controls-bench/.bench/pack-<name>-<fingerprint>-claude.json` (the first line of the output says which). It
runs only with Claude, without `--baseline` or `--liveness`. If no case is left to run (an `--only` that matches
nothing, an empty case file), it stops: an exam that ran nothing never comes out green. Each pass takes about two
minutes of model time.

**Only examine packs you have read**: `--pack` runs the pack's reviewers as your user and with the tools each reviewer
declares in its frontmatter (`tools`). The exam rejects cases that write outside their folder or plant git or tool
configuration, but a reviewer that declares a tool for running commands will use it.

**Red first, green after**: write the cases for a new rule before the rule, and run them. The `must-flag` cases must
fail, because the reviewer does not know the rule yet. Then write the rule and run them again: both cases must pass. A
`must-flag` that passes before the rule exists proves nothing: the case is too obvious or leans on another rule.

**Where the cases live**: next to the pack, in `packs/<your-pack>/exam/` of the profile repo. They travel as data and
nothing loads them as instructions: whoever runs the exam uses them.

## If you work alone

This section is for the agent, when a person who works alone asks it for reviewers for their stack ("build me reviewers
for Svelte and FastAPI"). A pack of your own goes in the profile repo, even if it belongs to one person: it is the only
place that survives updates.

What is never done: writing the pack into the harness installation (`~/.tycon/harness/packs/`, or
`~/.claude/agent-skills/packs/`, which is the same place). The harness denies it, and the next update would delete it.
Nor is `packs.default` set in the machine configuration (`~/.claude/tycon.json`) for a profile pack: it goes in
`team-profile.json`.

1. **The profile.** If `harness.js doctor` shows no team profile, create a local one:
   `harness.js team-init --local --name <name>`. It lands in `~/<name>-profile`, in a git repo on the machine with a
   commit on `main`, with no account and no address. If there is already a profile, use that one.
2. **The pack.** Build it in `packs/<name>/` of the profile repo, with its `pack.json`, its `agents/` and its cases in
   `exam/`. The example `examples/packs/svelte-fastapi/` is the model; change its name, prefixes and rules.
3. **Activate it.** In the profile's `team-profile.json`, `packs.default` with its name (`["<name>"]`).
4. **Commit.** `git add -A && git commit` in the profile folder. The harness reads only what is committed on `main`.
5. **Bring it in.** `harness.js update`, or the first time `harness.js install --team <profile folder>`. Then
   `pipeline.js advisors` (as in "How to validate it") must name the pack in `packs`.
6. **The exam.** `advisor-runner.js --pack <profile folder>/packs/<name> --tool claude --runs 2`, as in "How to examine a
   reviewer". Each pass costs about two minutes of model time: tell the person first.
7. **Tell them what it checks.** Read each reviewer's catalog (its `.md` in `agents/`) and tell the person, in plain
   words and without the IDs, what each rule looks at, which ones stop the story and which only warn, and how many exam
   cases passed.
8. **The backup, once.** A local profile lives only on that machine: `doctor` shows it as a warning. Offer once to push it
   to GitHub or Azure DevOps: an empty private repo, and from the profile folder `git remote add origin <address>` and
   `git push -u origin main`; then `harness.js install --team <address>`, so the harness reads it from there. If the
   person says no, do not offer it again: the `doctor` warning stays, and it blocks nothing.
