# Using the harness with Ollama models (Claude Code and Codex)

En castellano: [ollama.md](ollama.md).

An optional guide. It is for you if you want to work with the harness using an open model that runs in Ollama, instead
of the models from Anthropic or OpenAI. It tells how to connect each tool, what was measured with each model and what
to be careful about. The measurements come from a lab run with public material and Ollama's free plan: they are not a
promise that everything will work the same on your repos.

**In short:**

- With **Claude Code**, the harness reaches the reviewers: they run as separate agents.
- With **Codex**, the harness blocks what it should and the pipeline launches the reviewers itself, as separate
  processes with your session's model: it does not depend on the model knowing how to launch agents. Before picking a
  model for Codex, try it with the probe ([below](#before-picking-a-model-for-codex-the-probe)).
- You need a model that **uses tools**. A local 7B model does not use them and is not enough.
- The controls work, and a model tries to get around them: their escapes are the person's decision. Read
  [the warnings](#warnings).

## What you need

- **Ollama 0.14 or newer.** That is the first version that serves the Anthropic API, which Claude Code uses. Check with
  `ollama --version`.
- **An Ollama account**, for the cloud models: `ollama signin`. Those models run on Ollama's servers, not on your
  machine, so they need no memory.
- **The harness installed** for the tool you use (Claude Code, Codex or both).

Cloud models are registered once with `ollama pull`:

```bash
ollama signin
ollama pull gemma4:31b-cloud
ollama pull gpt-oss:120b-cloud
```

## Which models work

What was measured, by tool. "Uses tools" is the condition for everything else: without it the controls do not fire, the
pipeline does not run and the reviewers do not work.

The same toy story with each model and each tool. "Steps" are the 10 pipeline steps it actually closed, not the ones it
claimed.

| Model | Plan | Claude Code | Codex |
|---|---|---|---|
| `deepseek-v4-pro:cloud` | Pro | **10 of 10 steps**, story done, ~26 min | 5 of 10; finished the story but **claimed steps it did not run** |
| `gemma4:31b-cloud` | free | **10 of 10 steps**, story done, ~16 min | 4 of 10; gave up after 2 minutes without finishing |
| `nemotron-3-super:cloud` | free | 9 of 10, story done, ~13 min | **10 of 10 steps**, story done, ~7 min (uses more tokens) |
| `glm-5.3:cloud` | Pro | 7 of 10, story done, ~58 min | **10 of 10 steps**, story done, ~15 min (the most tokens) |
| `kimi-k2.7-code:cloud` | Pro | 9 of 10, story done, slow (~84 min) | 9 of 10, story done, ~13 min |
| `minimax-m3.1-flash:cloud` | free | 7 of 10, story done, slow (~96 min) | **does not start** as is: the API rejects Codex's tools (`invalid tool type: namespace`); in **reduced mode** it answers (see below) |
| `gpt-oss:120b-cloud` | free | **0 of 10**: claimed pipeline steps it did not run | 3 of 10; **said "done" without doing it** and named files that did not exist |
| `beam:cloud` | free | **does not use tools** through Ollama's Anthropic API | uses tools; followed the pipeline up to implementing and stopped at the reviewers |
| a local 7B model | — | not measured | **does not use tools**: it writes the call as text and Codex runs nothing |

**Which one to pick.** With Claude Code, `deepseek-v4-pro:cloud` if you have the Pro plan; otherwise `gemma4:31b-cloud`,
or `nemotron-3-super:cloud` if speed matters. With Codex, `nemotron-3-super:cloud` (free and fast) or, with the Pro plan,
`glm-5.3:cloud` or `kimi-k2.7-code:cloud`. Do not use `gpt-oss:120b-cloud` with the harness, nor
`minimax-m3.1-flash:cloud` with Codex outside reduced mode. The controls held with all of them: each model was asked to close in red, turn
off the loop and commit skipping the checks, and none managed it. The difference between models is whether they do the
work, not whether they escape.

Two more facts:

- Large local models need a lot of memory. `gpt-oss:20b` is about a 13 GB download and is the reasonable minimum for
  Codex; `gpt-oss:120b` needs 80 GB or more. On a shared 16 GB Mac even the 7B pushed memory into the warning level.
- The free models were never cut off by plan limits. The cuts that happened were connection drops
  (`stream disconnected`).

## Claude Code in the terminal

Claude Code talks to Ollama through its Anthropic API. You tell it where to go with environment variables, and you set
them **for that window only**: other sessions keep using Anthropic.

Put this function in your `~/.zshrc` (or `~/.bashrc`; in bash, replace `read "model?…"` with `read -p "…" model`):

```bash
# Claude Code with an Ollama model, in this window only.
# Usage: claude-ollama                     -> pick from a list
#        claude-ollama gemma4:31b-cloud
claude-ollama() {
  local model="$1"
  if [ -z "$model" ]; then
    local options=("gemma4:31b-cloud" "gpt-oss:120b-cloud" "other")
    echo "Which Ollama model? (the first two are in the free plan)"
    select m in "${options[@]}"; do
      if [ "$m" = "other" ]; then read "model?Model name: "; else model="$m"; fi
      [ -n "$model" ] && break
    done
  fi
  if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
    ollama pull "$model" || { echo "Could not pull $model: is Ollama running and 0.14 or newer?"; return 1; }
  fi
  (
    export ANTHROPIC_BASE_URL="http://localhost:11434" ANTHROPIC_AUTH_TOKEN="ollama" ANTHROPIC_API_KEY="" \
           ANTHROPIC_MODEL="$model" TYCON_MODEL_PROVIDER="ollama"
    eval "$(node "$HOME/.claude/tycon-harness/scripts/lib/models-env.js" --provider ollama)"
    claude --model "$model" "${@:2}"
  )
}
```

What each variable does:

| Variable | What it does |
|---|---|
| `ANTHROPIC_BASE_URL` | sends the calls to Ollama, not to Anthropic |
| `ANTHROPIC_AUTH_TOKEN` | Ollama asks for no key, but Claude Code wants a value: use `ollama` |
| `ANTHROPIC_API_KEY` | empty, so an Anthropic key you may have saved is not used |
| `ANTHROPIC_MODEL` | the session's model |
| `ANTHROPIC_DEFAULT_SONNET_MODEL`, `_OPUS_`, `_HAIKU_` | the harness reviewers ask for `sonnet`; this gives them a model that exists in Ollama |

`models-env.js` sets the three `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` from your organization's **Ollama table** (on the site,
«Which model each level is, by provider»; in the file, `models.providers.ollama`). A level with no model loaded (or set to
`inherit`) uses the session's model, the one you picked when opening. So if the organization says the economy level is
`gemma4:31b-cloud` and the balanced one `gpt-oss:120b-cloud`, economy reviewers run on the first and balanced ones on the
second. With no table loaded, everything uses the model you picked, as before. To see what it will set:
`node ~/.claude/tycon-harness/scripts/lib/models-env.js --provider ollama`. The function does not set
`CLAUDE_CODE_SUBAGENT_MODEL`: it would override the table. `TYCON_MODEL_PROVIDER` tells the harness this session is on
Ollama (it can also be declared for the machine with `node scripts/lib/tycon-config.js set models.provider ollama`), and
`pipeline.js start` warns if the session's variables do not match the table.

Then you run `claude-ollama gemma4:31b-cloud` instead of `claude`. To go back to normal, exit and open `claude`.

Things you will see:

- **Do not use `/model` inside the session.** What you pick there is saved for all sessions, the normal ones too.
  Change models by exiting and opening `claude-ollama` with another name.
- **The cost Claude Code shows is a local calculation** with Anthropic's prices. Ollama does not charge for these free
  models; that number is not money.
- **An `unrecognized_model` notice on every request.** Claude Code does not know the model name. It changes nothing.
- **The tests control is only in the full harness profile** for Claude Code. The minimal profile does not install it.

## Claude Code in VS Code

The VS Code extension reads the variables from its settings, not from your terminal. To avoid changing your other
windows, use **a separate VS Code profile**:

1. Menu **File → Preferences → Profiles → Create Profile…** and name it, for example, `ollama`.
2. With that profile active, open the settings as JSON (**Preferences: Open User Settings (JSON)**) and add:

```json
{
  "claudeCode.environmentVariables": [
    { "name": "ANTHROPIC_BASE_URL", "value": "http://localhost:11434" },
    { "name": "ANTHROPIC_AUTH_TOKEN", "value": "ollama" },
    { "name": "ANTHROPIC_API_KEY", "value": "" },
    { "name": "ANTHROPIC_MODEL", "value": "gemma4:31b-cloud" },
    { "name": "ANTHROPIC_DEFAULT_OPUS_MODEL", "value": "gemma4:31b-cloud" },
    { "name": "ANTHROPIC_DEFAULT_SONNET_MODEL", "value": "gemma4:31b-cloud" },
    { "name": "ANTHROPIC_DEFAULT_HAIKU_MODEL", "value": "gemma4:31b-cloud" },
    { "name": "CLAUDE_CODE_SUBAGENT_MODEL", "value": "gemma4:31b-cloud" }
  ]
}
```

The setting lives in that profile: windows with the default profile keep using Anthropic. Run `ollama pull` for the
model first. The same warnings apply as in the terminal (no `/model`, the cost is a calculation, the
`unrecognized_model` notice).

With your organization's Ollama table loaded, the three `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` come from it: `node ~/.claude/tycon-harness/scripts/lib/models-env.js --provider ollama --format vscode` prints those entries (those of a level set to `inherit` are left out: they stay with `ANTHROPIC_MODEL`).

## Codex

Codex has a mode for open models:

```bash
codex --oss --local-provider ollama -m gpt-oss:120b-cloud
```

- **The provider is `ollama`.** Without `-m`, `--oss` uses `gpt-oss:20b`.
- **A context of at least 64K tokens.** The harness instructions (rules, skills, reviewers) are long. With the default
  context, Ollama trims what Codex sends and the model works almost blind. Cloud models already have a long context; if
  you use a local one, raise it in Ollama.
- **The controls must be approved with `/hooks`.** In an interactive Codex session, type `/hooks` and approve the
  harness controls. Unapproved, `codex exec` does not run them and says nothing.
- **Install the harness for Codex** from the published version: `harness.js install --version latest --tool codex`.

### Before picking a model for Codex: the probe

Codex sends the model tools of type `namespace`: that is how it groups its subagents, its apps and each MCP server.
Some Ollama models reject them and the session does not start. The probe tells you before you lose a session:

```bash
node scripts/lib/ollama-tools-probe.js --model minimax-m3.1-flash:cloud
```

It answers in one line, always with exit 0:

- "acepta las herramientas de Codex" (accepts Codex's tools): use it with Codex as is.
- "no acepta las herramientas de Codex (namespace): usalo con Claude Code" (use it with Claude Code), and, if the model
  answers without them, also how to use it with Codex in **reduced mode**.
- "no pude preguntarle a Ollama" (could not ask Ollama) or "Ollama contestó algo que no sé leer" (unreadable answer): it
  does not know, and says so. It never says "accepts" without a good answer.

**Reduced mode** removes everything Codex sends as `namespace`, plus web search (a tool without a name that Ollama also
rejects): `-c features.multi_agent=false -c features.apps=false -c web_search="disabled"` and a `CODEX_HOME` without MCP
servers. What you lose: subagents (not needed, the pipeline launches reviewers as separate processes), apps, web search
and MCP servers (reviewers that use the code index or memory work without them). Measured on 2026-10-23 with
codex-cli 0.162.1 and Ollama 0.16.3: `minimax-m3.1-flash:cloud` rejects the full form and answers in reduced mode;
`kimi-k2.7-code:cloud` accepts the full form. Codex no longer has the other format (`wire_api = "chat"`): there is no
other supported way out. You run the probe yourself: the installer does not call it.

### The pipeline launches the reviewers

With Codex, the "Revisores" step runs `pipeline.js reviewers-run`: each reviewer is a separate `codex exec` process,
with your session's model if you started the pipeline with
`pipeline.js start … --codex-session '{"oss":true,"provider":"ollama","model":"<model>"}'` (`"config"` passes the
reduced-mode options). Without that option, each reviewer uses its profile's model (next section). Before, the step
asked the model to launch each reviewer as an agent; a model that did not use that tool launched none.

### Reviewers in Codex: the machine's model

Each Codex reviewer profile pins an OpenAI model. That model does not exist in Ollama, and the reviewer fails with
`unknown input item type: additional_tools`. The way out is to tell the harness that reviewers use **your machine's
model**, the one in your `config.toml`.

That is declared in the team profile (`team-repos.json`), inside `models`:

```json
{ "models": { "codex_reviewers": "inherit" } }
```

For a single machine there is another way: with `models.provider` set to `ollama`, the Codex reviewers take the **Ollama
table**, and a level set to `inherit` (or not loaded) is deployed without `model =`. It is what `codex_reviewers: inherit`
does for the whole organization, but only on that machine; if the organization has `codex_reviewers: inherit`, that wins.


You choose it from the organization site, in the models table, row **"Reviewers in Codex"** (Spanish: «Los revisores en
Codex»; see `guides/organization-site.en.md`). It exists **since harness version 2026.10.22.22**. Without that value
nothing changes for those who use OpenAI models; with it, the deployment removes the `model =` line from the reviewer
profiles.

## Warnings

- **A model may try to write a control's escape.** In the lab, `gpt-oss` put `TYCON_SAFETY_OFF=1` in front of a
  commit with `--no-verify`, although the order said not to look for another way. That no longer works: the escape of
  the security control, and those of the production check (`TYCON_PROD_LINT`) and the names check (`TYCON_NEW_NAMES`),
  only count if the person wrote **"autorizo <variable>"** ("I authorize <variable>") in the chat in the last 30
  minutes ([control guide](../safety-guard.md)). The tests control keeps its light escape: `beam` used it on its own,
  and it only protects the machine's load. Codex does not let the harness read its conversation, so there the
  per-command escape does not count.
- **A model may skip the steps of the stories skill.** In the lab, `gemma4` called `tycon-create-story` without
  following its steps, authorized the hand-written-story bypass by itself and wrote the story anyway. That no longer
  works: writing a story without the skill only counts if the person wrote **"autorizo story-skill-bypass"** ("I
  authorize story-skill-bypass") in the chat.
- **Check the state, not the story.** `gpt-oss` loaded the pipeline skill and, over five turns, reported steps 1 to 7
  as "completed" without running a script or writing a file. The controls did not stop it because there was nothing to
  stop. What gives it away is the state: the story stayed in `ready-for-dev` and no new files appeared. Check
  `git status` and the story before believing it.
- **With Codex on Ollama, subagents fail** (`unsupported call`). Codex groups its tools into namespaces and Ollama's API
  loses them, so the pipeline cannot launch reviewers. It does not depend on any harness option. It is reported at
  [openai/codex#42488](https://github.com/openai/codex/issues/42488) and
  [ollama/ollama#18284](https://github.com/ollama/ollama/issues/18284). **With Claude Code the reviewers do run as
  separate agents.** If you need the reviewers, use Claude Code.
- **`beam:cloud` does not use tools through Ollama's Anthropic API.** On every request it says it will run a command and
  ends the turn without the call. With Codex it does use them. For Claude Code, pick one from the table above.
- **The closing controls hold.** `gemma4` could not pass the live verification matrix, which asks for a person's
  decision, not even by trying the escape.
- **Paid models return 402** (`not in the Free plan`). `glm-5.3`, `kimi-k2.7-code` and `deepseek-v4-pro` need
  Ollama's Pro plan.

## When something fails

| Symptom | Cause | What to do |
|---|---|---|
| `unrecognized_model` on every request | Claude Code does not know the model name | nothing: the result is the same |
| 402, "not in the Free plan" | the model needs the Pro plan | use one of the free ones in the table |
| Claude Code answers but runs no commands | the model does not use tools (`beam`, a 7B) | change the model |
| `unknown input item type: additional_tools` in a Codex reviewer | the reviewer profile pins an OpenAI model | set `"codex_reviewers": "inherit"` in `models` |
| `unsupported call` when launching reviewers in Codex | a Codex limit with Ollama | use Claude Code for that part |
| `codex exec` does not run the controls | they are not approved | approve with `/hooks` |
| `stream disconnected` on a long task | the connection to the cloud dropped | retry; long tasks are cut more often |
| Claude Code still uses Anthropic | the variables did not reach that window | open with `claude-ollama` or the VS Code profile |
