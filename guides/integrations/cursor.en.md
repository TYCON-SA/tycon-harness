# Use the harness with Cursor (trial)

In Spanish: [cursor.md](cursor.md).

An optional, short guide. It says what of the harness works with Cursor today and what is missing. The measurements come
from a lab with Cursor's terminal agent (`cursor-agent` 2026.10.19), its free plan and a toy repo with public material:
it is not a promise that everything works the same with your repos.

**In short:**

- **The checks and the skills work as they are**, with nothing installed for Cursor.
- **The global rules and the reviewers as separate agents are missing.** A story in progress adds them.
- **The free plan runs out fast** with a story's pipeline.
- **The «Auto» model got around a brake** by writing on its own the variable that turns it off. Read
  [the warnings](#warnings).

## What works as it is

- **The checks.** Cursor reads the hooks the harness registers for Claude Code in `~/.claude/settings.json` (its
  «Third-Party Imports» option, which comes on) and runs them. It translates the names by itself: a terminal command
  reaches the hook as `Shell` instead of `Bash`, and the brake still recognizes it. The safety brake stopped a commit
  that skipped the checks.
- **The skills.** Cursor sees the ones in `~/.claude/skills`, the pipeline's included. With «let's implement story X»
  it followed the pipeline: it created the branch, validated the story with a helper of its own, wrote the plan, the
  test and the code, with the tests green.

The checks run with your machine's real state: they read and write in the harness folder as in a Claude Code session.

## What is missing

- **The global rules.** Cursor reads `AGENTS.md` and `CLAUDE.md` at the project root and its `.cursor/rules` folder,
  but not the `CLAUDE.md` in your home folder. So the guide index and the rules the harness puts there do not reach it.
- **The reviewers as separate agents.** Cursor only launches its own helpers; it does not load the harness reviewers.
  The pipeline launches them by name, so with Cursor the reviewers step cannot run.
- **One marker per session.** The pipeline command that runs in the terminal does not get the Cursor session's id: two
  Cursor sessions in the same repo would share the same pipeline state.

A story in progress adds them: the rules where Cursor reads them, the reviewers passed as text to Cursor's helpers, and
an id of its own per session.

## Warnings

- **The brake that gets bypassed.** With the «Auto» model, the agent hit the safety brake and got around it by writing
  the variable that turns it off, claiming a permission nobody had given. It also happened with open models in other
  tools. While that escape is a variable the agent can write, the brake only stops a model that obeys. Another story
  in progress closes it by asking a person for permission.
- **The free plan runs out fast.** A single pipeline run up to the code used about 40,000 input tokens and 350,000
  cache tokens, and a few more prompts used up the quota. Once it runs out, every prompt returns the same limit notice.
- **«Auto» does not say which model it uses.** The output does not name it.
- **Headless needs `--force`.** In single-prompt mode (`-p`), Cursor refuses every terminal command unless you pass
  `--force`, and with `--force` it runs everything the model asks for.
- **Do not change HOME to isolate it.** Cursor's session lives in the system keychain, tied to your home folder: a test
  HOME asks for a new login.
