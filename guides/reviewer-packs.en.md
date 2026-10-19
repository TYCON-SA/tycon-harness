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
  exam/<reviewer>.json           the exam cases (they do not travel with the team profile)
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

1. Copy `pack.json` and `agents/` to `packs/<your-pack>/` in your team's profile repo. Do not copy `exam/` or the
   `README.md`: the team layer accepts a closed list of paths and, with a file outside it, it is not stacked on any
   machine.
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

**Where the cases live**: in the repo where your organization builds and examines the pack, not in the team profile.
They are used by whoever maintains the pack, not by every machine.
