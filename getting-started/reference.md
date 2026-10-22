# TYCON Harness — reference

English · [Castellano](reference.es.md)

What follows is for looking things up: installing by hand, the minimal or full install, what it writes on your machine,
how it updates. You do not need to read it to start: start with the [front page](../README.md).

## What it is and what it isn't

**It is** a harness for your coding agent (Claude Code or Codex):

- **Guides and rules** that every session loads or reads on demand: how a story is written, how to commit, how to run
  tests without freezing the machine, and more.
- **Hooks** that your agent runs at fixed points (start of a session, before a command, before an edit, end of a turn):
  some only measure or warn, some block a command (see the table in [INSTALL.md](../INSTALL.md#los-hooks-que-instala)).
- **Reviewers**: subagents that review a diff against a closed list of rules, each finding with its rule ID.
- **The story workflow** (`tycon-pipeline`). A story is a document with one change, its acceptance criteria and its
  tests. The workflow validates it, plans, implements with build and test gates, runs the reviewers in parallel and prepares
  the commit. The agent never commits or pushes without your explicit permission.
- **A bench of controls** that checks, case by case, that each hook and reviewer still does what it says.

**It is not** a model, a hosted service or an app: everything runs on your machine, inside the assistant you already
use. It does not send your code anywhere beyond what that assistant already does. Most guides are written in Spanish;
this page and the community files have an English version. All command output, hook messages and the rules loaded into
your assistant are in Spanish only today.

## The harness's words

Ten words, each with a single meaning on these pages:

- **Story**: the document for one change, with its acceptance criteria and its tests.
- **Workflow**: what a story goes through, from validation to the prepared commit (`tycon-pipeline`).
- **Plan**: what the agent is going to do in a story; it does not write code until you approve it.
- **Reviewers**: the AI agents that check a change against their rules. The person who approves is the "approver".
- **Guard**: a check that denies a command, an edit or the end of a turn; it does not just warn.
- **Run**: one pass of the workflow over a story, with its timings and what the reviewers said.
- **Pull request**: the proposal of a change to a repo, which someone approves before it goes in.
- **Team repo**: an organization's own repo with the configuration that reaches every machine of the team.
- **Nightly jobs**: what runs at night for an organization (dependencies, metrics, dashboard), from its operations repo.
- **Team site**: the optional page where a team sees its runs and changes its configuration.

## Requirements

- **No GitHub account**: this repository is public, and the harness is downloaded from it without a credential.
- **Your coding agent**: Claude Code or Codex, installed and signed in.
- **On Windows, native**: Node 24 (Node 22 or later is enough), PowerShell 7 and `tar` (Windows 10 and later bring it). Git and Python
  are not needed. Through WSL, the same as on Mac and Linux, inside WSL.
- **On Mac and Linux**: Bash, Python 3, `tar`, `curl` and Node 24 (Node 22 or later is enough; tested on 22 and 24). Git is not needed.
- **Node 20**: 20 is tolerated only to update an existing installation; it is not tested.
- **The reviewers for your stack** that your team brings may need more (the .NET ones, the .NET SDK your plugin
  targets): each pack says so.

The exact list for Mac and Linux:

<!-- requirements -->
```text
bash
python3
tar
curl
node >= 22
```
<!-- /requirements -->

Windows: native (with PowerShell 7) or through WSL. The native path was tested on 2026-10-06 on a clean Windows 11
machine, installed from this copy: `doctor` reports everything in order, with the git hooks installed. Through WSL
nobody has tried it yet.

## Install by hand

**By hand** (and on Linux or through WSL) there are three steps: prepare the machine, download and install, and check.
Follow only the ones for your system. Installing with nobody at the keyboard is optional and comes at the end of this
section, under "Other ways to install". Using the harness does not need git nor a clone: the published version is
downloaded as files into `~/.tycon/harness`.

### 1. Prepare the machine

**On Windows** (native, tested with this copy; for WSL, follow the Mac and Linux steps inside WSL). Install what you are
missing, from any terminal:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Microsoft.PowerShell
```

Close the terminal and open **PowerShell 7** (that is its name in the Start menu): every command on this page runs
there, not in the 5.1 version that ships with the system. Check that `node --version` shows Node 24 (or 22) and that `tar
--version` answers (the system has brought it since 2018). Nothing else to sign in with: the harness never opens a browser.

**On Mac**, install what you are missing with Homebrew (https://brew.sh):

```bash
brew install node python
```

**On Linux**, do the same with your distribution's package manager. Check that `node --version` shows Node 24 (or 22).

### 2. Download and install

The main entry is a single line, the same on native Windows, Mac, Linux and WSL. It checks the requirements, downloads the
published version of the harness to a temporary folder and runs its `harness.js install`, which shows you the plan and
asks whether to go on. Options for `install` go after the name: `npx @tyconsa/harness@latest <options>`.

```bash
npx @tyconsa/harness@latest
```

**By hand, without npm.** Open a terminal in any folder and paste the lines for your system, one by one: the `bash` ones on Mac, Linux and WSL;
the `powershell` ones on native Windows. The first downloads the install script from GitHub's public file address
(`raw.githubusercontent.com`), with no credential and without going through the API; the second shows it, so you
read what you are about to run; the third runs it. The script checks the requirements, downloads the published
version as files (no git, no clone) to a temporary folder and continues with `harness.js install --version latest` in
the same terminal. They are three lines on purpose: piping a download straight into a shell is blocked by the command
guard (`SUP-C1`). The script never installs system packages nor uses `sudo`. Options for `install` go after `--`:
`bash get-harness.sh -- <options>`.

<!-- install:core -->
```bash
curl -fsSL -o get-harness.sh https://raw.githubusercontent.com/TYCON-SA/tycon-harness/main/scripts/setup/get-harness.sh
less get-harness.sh
bash get-harness.sh
```

```powershell
Invoke-WebRequest -OutFile get-harness.ps1 https://raw.githubusercontent.com/TYCON-SA/tycon-harness/main/scripts/setup/get-harness.ps1
Get-Content get-harness.ps1
pwsh -File get-harness.ps1
```
<!-- /install:core -->

GitHub limits requests that carry no credential to 60 per hour per network address, and a whole office usually shares
one. If a line answers 403, wait until the limit renews (at most an hour) and run that line again. With a GitHub
permission of your own you can skip the wait for the script: put it in the `TYCON_GITHUB_TOKEN` variable of that
terminal and run the script again (on Mac and Linux, `read -rs TYCON_GITHUB_TOKEN && export TYCON_GITHUB_TOKEN`; in
PowerShell 7, `$env:TYCON_GITHUB_TOKEN = Read-Host -MaskInput`). The script uses the permission and saves it in
`~/.tycon/config.json`, readable only by your user; `harness.js config unset github.token` removes it. The first line,
the one that downloads the script, never carries a credential and does not go through the API: it does not count
against that limit.

`install` writes nothing without telling you first: it asks three questions, then shows the plan and asks "¿Instalo?"
(install?). To see only the plan, without installing, add `--dry-run`.

### What to answer

The questions are in Spanish, and they use their own words: "perfil" (profile) is the minimal or full install,
"integraciones" (integrations) are the optional connections, and "paquete del stack" (stack pack) is the reviewers for
your stack. For "yes", type `y` or `s`.

1. **"¿Qué perfil instalo?"** (which profile?) Answer `1` (`minimal`, the minimal install) or `2` (`full`, the full
   one): there is no default.
   - `minimal`: the guides, the reviewers and the story workflow, without changing how the assistant answers you.
   - `full`: adds the guards (in a repository with stories, editing code goes through the workflow) and makes the
     assistant answer briefly and in Spanish in all your projects, not only where you use the harness.
2. **"¿Qué integraciones prendo?"** (which integrations?) They are the optional connections to external services, such
   as Azure DevOps or Clockify. Enter turns none on; you can turn them on later (see "What is optional").
3. **"¿Usás el paquete del stack en todos tus repos?"** (the stack pack in all your repositories?) It is the reviewers
   for your stack that your team repo brings (TYCON brings its own for BIZUIT plugins). With no team, or if not all
   your repositories use that stack, `n`, and each repository asks for it later.

After the three questions, **the plan and "¿Instalo? [s/N]"** (install?) shows which files it touches, what changes in
how your assistant works, what runs on its own, what it reaches over the network and what it stores on disk. Read it
and answer `y`.

`install` asks what it cannot decide on its own: the profile, which integrations to turn on, and whether you use the
stack pack in all your repos. It asks only once, on the first install with a terminal: with the profile already set (by
its variable or in `~/.claude/tycon.json`), with `--yes`, or over an existing install it asks nothing, and at the end it
says how to change the profile or the integrations. All three can also be answered with options:
`--profile minimal|full`, `--integrations <list|none>` and `--packs all|none`.

### 3. Check

Check the result (the first one on Mac and Linux, the second one in PowerShell):

```bash
node ~/.claude/tycon-harness/scripts/setup/harness.js doctor
```

```powershell
node "$HOME\.claude\tycon-harness\scripts\setup\harness.js" doctor
```

In PowerShell, write the other `node ~/.claude/…` commands on this page the same way as this one: with
`$HOME\.claude\…`.

If a tool is missing, the script (or `install`) stops with one line that names it, with the command to install it, and
writes nothing. Install it and run `bash get-harness.sh` again (the script you already downloaded).

With the full install (`full`), if git has no global `core.hooksPath`, `install` (and `apply`) set it to `~/.git-hooks/`, the folder of the
harness's git hooks; the plan says so before your "yes". If you already have another one, they leave it alone: they
warn, with the command to point it. What that key changes is under "What it writes on your machine".

### Other ways to install (optional)

**With nobody at the keyboard** (a container, a scheduled job): the same line, with the profile and `--yes`.

```bash
npx @tyconsa/harness@latest --profile minimal --yes
```

Mind where `--yes` goes. Written before the package name it belongs to npm: it accepts downloading the package without
asking, and does not touch the plan. Written after the name, as above, it is ours: it accepts the install plan without
anyone seeing it. Without a terminal npm downloads the package anyway, so npm's one is not needed.

By hand, without npm:

<!-- install:unattended -->
```bash
curl -fsSL -o get-harness.sh https://raw.githubusercontent.com/TYCON-SA/tycon-harness/main/scripts/setup/get-harness.sh
less get-harness.sh
bash get-harness.sh -- --profile minimal --yes
```

```powershell
Invoke-WebRequest -OutFile get-harness.ps1 https://raw.githubusercontent.com/TYCON-SA/tycon-harness/main/scripts/setup/get-harness.ps1
Get-Content get-harness.ps1
pwsh -File get-harness.ps1 -- --profile minimal --yes
```
<!-- /install:unattended -->

With `--yes` it accepts the plan without anyone seeing it: look at it first with `--dry-run`. `--yes` does not choose
the profile: the block installs the minimal one, or `--profile full` for the whole harness. Without a terminal the
script asks nothing. Where many machines share one address, such as a build agent, the limit above is reached often.
`TYCON_GITHUB_TOKEN`, set as above, covers what the script and the install request. The line that downloads the script
goes without a credential either way and does not go through the API: it does not count against that limit, and the
API's 403 does not stop it.

**Developer mode (to change the harness, not to use it).** Whoever maintains the harness clones this repository and
installs from the clone: that machine runs the harness from the clone and updating it is theirs (`harness.js link
--local <clone>` points an installed machine at a clone to try a change before publishing; `harness.js link --managed`
goes back). Using the harness never needs this. Git is a requirement only here.

<!-- install:clone -->
```bash
git clone https://github.com/TYCON-SA/tycon-harness tycon-harness && node tycon-harness/scripts/setup/harness.js install
```

```powershell
git clone https://github.com/TYCON-SA/tycon-harness tycon-harness; node tycon-harness/scripts/setup/harness.js install
```
<!-- /install:clone -->

<!-- install:clone-unattended -->
```bash
git clone https://github.com/TYCON-SA/tycon-harness tycon-harness && node tycon-harness/scripts/setup/harness.js install --profile minimal --yes
```

```powershell
git clone https://github.com/TYCON-SA/tycon-harness tycon-harness; node tycon-harness/scripts/setup/harness.js install --profile minimal --yes
```
<!-- /install:clone-unattended -->

## With or without the site

**The harness works fully without the site.** The [team site](../guides/organization-site.en.md) is optional:
a page to see the runs of every machine and to change the configuration from forms. The configuration always lives in
files in repos, and there are two ways to change it:

- **Without the site:** you edit the file in your clone of the right repo and push it with a pull request.
  `harness.js team-config` opens a page on your machine, read-only and with nothing on the internet, that shows how
  things stand and the problems the harness's readers see.
- **With the site:** the Configuration tab validates the change with those same readers and opens the pull request for
  you. It never writes `main`: the change goes in when someone approves it, or on its own, if the organization chose
  that for its admins' changes.

### What each one needs

| If you are… | You need | You don't need |
|---|---|---|
| A solo dev, without the site | the install on your machine | organization repos, or a GitHub or Azure DevOps account |
| A solo dev, with the site | the install, a team repo and an operations repo (an organization of one), and the site with its sign-in; the shared run history, if you want to see your runs there | the nightly jobs, unless you want the morning notice and the dashboard |
| The admin of a team, without the site | the install and the team repo, readable by the team; the operations repo, if you want the nightly jobs | the site |
| The admin of a team, with the site | all of the above, the operations repo with `site.access` (who signs in to the site), the site and, to see everybody's runs, the shared run history | — |
| A dev on a team that is already set up | the install with `--team <team repo>` and read permission on that repo | nothing else: the team's part arrives with every update |

### Where each setting lives

| Where | What it holds | How it changes |
|---|---|---|
| Your machine: `~/.claude/tycon.json`, the `TYCON_…` variables and `~/.tycon/config.json` | what is personal (paths, the Telegram chat, read permissions) and your preferences (optional connections, update channel and policy, minimal or full install, how the agent answers) | you change it, without a pull request; it is never versioned |
| The team repo: `team-profile.json`, `team-repos.json`, `skills/` and `packs/` | what applies to every machine: optional connections, updates, minimal or full install, the reviewers for the team's stack, how the agent answers, where each repo lives, which model each job uses | a pull request, by hand or from the site; it reaches each machine with its next update |
| The operations repo: `operations.json` | who gets the nightly notices, who reviews, the channel of the morning notice, who signs in to the site | a pull request, by hand or from the site; the nightly jobs and the site read it, never the machines |
| The site | no configuration of its own: it reads both repos and proposes the changes | — |

**What your machine can override.** For almost everything the order is `TYCON_…` variable › `~/.claude/tycon.json` ›
team repo (`team-profile.json`). So your machine can turn off, for itself only, a connection the team turns on, or
stay on `ask` while the team says `auto`. One key belongs to the team when its `team-profile.json` declares it: in
`packs.default` the team wins over your file and only `TYCON_PACKS_DEFAULT` overrides it. What is personal cannot go in the team repo: the
reader rejects it. What is in
`team-repos.json` and `operations.json` cannot be overridden from a machine, except the test coverage threshold. `tycon-config.js explain` says where each value came from, and what is written in
your file but not used.

### Configure your machine without a site or a team

A solo dev needs no repos and no site: their configuration lives in `~/.claude/tycon.json`, and `tycon-config.js` reads
and writes it.

```bash
node ~/.claude/tycon-harness/scripts/lib/tycon-config.js explain
node ~/.claude/tycon-harness/scripts/lib/tycon-config.js set integrations.engram true
node ~/.claude/tycon-harness/scripts/lib/tycon-config.js set response.style executive
node ~/.claude/tycon-harness/scripts/setup/harness.js channel stable
```

`explain` shows each value and where it came from. `set` validates the key and the value before writing, and says it
applies at the next startup or right away with `harness.js apply`. Read permissions do not go in that file:
`harness.js config set github.token` asks for them without showing them and stores them in `~/.tycon/config.json`. The
optional connections are in "What is optional"; the minimal or full install, in its section; the channel and the
policy, in "How it updates".

## Set up your organization

For your whole team to install with the same configuration, the organization needs its **team repo**: a repo of
its own, that only your team can read, with three files. `harness.js team-init` builds them for you. It runs on a machine that already has the harness
installed (without it, it exits 2: "install first"), because it validates with the readers of the installed version.

```bash
node $HOME/.tycon/harness/scripts/setup/harness.js team-init
```

It asks for whatever you did not pass as an option: the organization name (`--name`: unaccented letters, digits, dot and
dash), where the team repo lives (`--platform github|azure` and `--profile-repo`, a GitHub `org/repo` or
`https://dev.azure.com/<org>/<project>/_git/<repo>`) and the folder for the files (`--dir`; by default `~/<repo>`; a
folder with something in it is left alone). It downloads the published example (`harness-team-profile-example`) and
writes only the three required files:

- `team-layer.json` — the name and the minimum harness version (the one you have installed).
- `team-profile.json` — the team configuration, with the minimal install (`minimal`) and updates each person confirms; the `ado`
  block only if the repo lives in Azure DevOps.
- `team-repos.json` — where each repo lives: the public harness, the team repo and the nightly operations repo.

If something does not validate, it names the file and the field and writes nothing. `--dry-run` shows the three files
without writing. Then it tells you what comes next: create the **empty** repo, readable only by your team (setup does not create repos or ask
for write permissions), push the files (with git it offers to do it; without it, it prints the two commands), install
this machine with the team repo (`harness.js install --team <repo>`) and the line for the rest of the team. The nightly
processes and the `harness.js team-config` page are the next step, separately.

**If you work alone**, `harness.js team-init --local --name <name>` builds a one-person profile on this machine, with no
address and no account: the declaration and the profile (no `team-repos.json`), in `~/<name>-profile`, with git and a
commit on `main`. The harness reads it from that folder (`harness.js install --team <folder>`), only what is committed
on `main`. Your reviewer packs go there, so they survive updates (`guides/reviewer-packs.en.md`, "If you work alone").
While it lives only on your machine, `doctor` warns that it has no backup; to get one, push it to GitHub or Azure DevOps
and install again with `--team <address>`.

## Minimal or full install

There are two, `minimal` and `full`, and there is no default: `install` asks if you don't choose; without a terminal,
pass `--profile`.

- **`minimal`**: the guides, the skills, the reviewers, the story workflow and the new-version notice. It does not
  change how the assistant answers. It registers nine hooks (six that only take notes, the one that shows package notices, the brake against
  destructive commands and the one against editing code without a story or a one-off fix), plus those of each optional connection you turn on, and brings the links, commands and third-party skills.
- **`full`**: everything in `minimal`, plus the other brakes (the same gate for code written from the
  terminal, and the one against committing a story without the evidence it asks for), the three blocks that change how the assistant answers in all your projects (in Spanish,
  conclusion first, with a length cap), the two `settings.json` settings, the git hooks and the background tasks.

You choose with `--profile minimal` or `--profile full`, with `install.profile` in `~/.claude/tycon.json`, or with the
`TYCON_INSTALL_PROFILE` variable. Switching from one to the other removes or restores what applies, with a backup
first. In `minimal`, the other brakes still turn on with their variable set to `1` (`TYCON_TEST_SCOPE_GUARD=1`), and
the destructive-commands brake turns off only with `TYCON_SAFETY_GUARD=0`.

## What the full install changes

The full install (`full`) changes things in all your projects, not just one. It is what the guided install with Claude
Code leaves; with the npx line, you choose.

- **Your agent answers you in Spanish**, briefly and with the conclusion first. All command output, hook messages and
  rules are in Spanish too; there is no English option today.
- In a repo that works with stories, the agent does not edit code without going through the harness's workflow.
- Git starts using a global folder for its commit checks (`core.hooksPath`). From then on, git no longer calls each
  repo's own checks, the ones in `.git/hooks/`: the harness runs that folder's `pre-commit`, `post-commit` and
  `pre-push` instead (hooks with other names, like `commit-msg`, do not run). The installation sets it only if git has
  none, and the plan tells you before your "yes"; if you already have another one, it leaves it alone.
- Once a day it reads the git history of your project repos (it finds their folder from where you use your agent).
  What it records stays on your machine.
- Claude Code keeps your conversations for a year.

If you don't want this, choose the minimal install (`minimal`): it brings the guides, the reviewers and the story
workflow, adds the harness's guide index to your agent in every session, and does not touch git or the rules on how the
agent answers you. It keeps a single guard: the one against destructive commands. To remove the harness,
`harness.js uninstall --dry-run` shows what it would remove, and `harness.js uninstall --yes` removes it.

## Reviewers for your stack

The core does not bring them. They are what an organization adds for its stack —reviewers, skills, guides and
templates—, in a pack: `packs/<name>/` with its `pack.json`. They live in your team repo and reach your machine with
every update, with nothing to do.

**Your organization turns them on**: `packs.default` in the team repo (or in the site's Configuration tab, Packs
section). It takes `all`, `none` or a list of names. Your machine can set its own value (`TYCON_PACKS_DEFAULT`, or
`packs.default` in `~/.claude/tycon.json`) when the team does not set one. A product repo can narrow that list with
`packs:` in its `.tycon/advisors.yaml`, not add to it.

A repo that asks for a pack your machine does not have stops the workflow (exit 2) with this message (the message is in
Spanish; the path at the end is your machine's):

```text
el repo declara el paquete «<nombre>» en `packs:` y no está instalado en …
```

If you see it, the pack did not arrive with what your team brings: update with
`node ~/.claude/tycon-harness/scripts/setup/harness.js update`, and if it persists, ask your team's admin.

## What is optional

The optional connections ("integrations" in the configuration), all **off** by default. Each one is turned on with a
key in `~/.claude/tycon.json` or with its variable; `node ~/.claude/tycon-harness/scripts/lib/tycon-config.js explain` shows each value and where it came
from.

| Connection | What it does | How to turn it on |
|---|---|---|
| `ado` | Azure DevOps: work items for stories, pull request and pipeline (job) checks | `ado.org` in `~/.claude/tycon.json`, or `TYCON_ADO_ORG` |
| `clockify` | Clockify time tracking hooks | `integrations.clockify: true`, or `TYCON_CLOCKIFY=1` |
| `engram` | engram persistent memory: sync on commit and a daily check | `integrations.engram: true`, or `TYCON_ENGRAM=1` |
| `codegraph` | CodeGraph code index for the agents (informative: you install CodeGraph yourself) | `integrations.codegraph: true`, or `TYCON_CODEGRAPH=1` |
| `mailbox` | uploads the record of each run to your organization's shared run history; the organization has to have it set up (today, an Azure storage account) | `integrations.mailbox: true`, or `TYCON_MAILBOX=1` (its key in `TYCON_MAILBOX_JSON`) |
| `codex` | deploys the Codex side | `integrations.codex: true` or `"detect"`, or `TYCON_CODEX=1` |
| `claude` | plugs Claude Code (hooks, settings, the index import) | `integrations.claude: true` or `"detect"`, or `TYCON_CLAUDE=1` |
| `nightly` | notices from your organization's nightly jobs (dashboard, dependencies, retrospectives), which run from its operations repo: see [For teams](../README.md#for-teams) | `integrations.nightly: true`, or `TYCON_NIGHTLY=1` |
| `instincts` | the instinct recorder: one sanitized line per tool used, to find what the team keeps repeating; your team profile turns it on | `integrations.instincts: true` in the team profile, or `TYCON_INSTINCTS=1` to try it on one machine (`TYCON_INSTINCTS=0` turns it off) |
| `telegram` | progress notices to a Telegram chat | `telegram.chat_id` in `~/.claude/tycon.json`, or `TYCON_TELEGRAM_CHAT_ID` |

**The Codex side**: the same harness under Codex, translated and deployed automatically. It needs `codex` on the PATH
and logged in, and `TYCON_CODEX=1`. Details in [INSTALL.md](../INSTALL.md).

**Four proprietary skills** (`docx`, `pdf`, `pptx`, `xlsx`) are not part of this repo and are not downloaded: they come
with Anthropic's official plugin. Install it if you want them.

## What it writes on your machine and what it does on its own

This section comes from a declared list, `scripts/setup/install-effects.json`, which a test checks against the
installer. Most items have a switch, named next to them. The ones that do not (the import line, the two
`settings.json` settings, the record of your last requests and the quick startup tests) are removed by hand or with
`harness.js uninstall`. Where a switch goes is at the end of the section.

**It changes how your assistant answers**, in all your projects and not only where you use the harness. The install
writes three blocks of rules into `~/.claude/CLAUDE.md`, between their own markers, and one import line:

- `response-style`: the assistant answers in plain Spanish, conclusion first, with a cap of 1300 characters of prose.
  A hook measures every answer and reports the overrun to the assistant on the next turn (`TYCON_RESPONSE_METER=0`
  turns the measuring off). That is the executive style: the organization picks the language, style and cap in its
  team repo (`response`); unset, the assistant answers clear and to the point, with a cap of 2000.
- `background-execution`: steps longer than two minutes run in the background and are announced first. Another hook
  measures what kept the conversation blocked (`TYCON_BLOCKING_METER=0`).
- `tool-names`: the table with the exact name of every tool those rules mention.
- The import line loads the harness `INDEX.md` in every session: about 15 KB, in Spanish, with the index of the
  guides and the always-on rules.
- The links in `~/.claude/skills` and `~/.claude/agents` make the harness skills and reviewers available in all your
  sessions: the name and description of each one load in every session.

`TYCON_NO_CLAUDEMD_SYNC=1` stops syncing the blocks; the ones already written are removed by deleting what is between
their markers.

**Guards that can block**: some hooks in `~/.claude/settings.json` can deny a command or keep a turn from closing.

- In any repo: the guard against dangerous commands (deleting the root, force-pushing to `main`, downloading a script
  and piping it into a shell, printing a `.env` file, an `.ssh` key or the `.aws` credentials with `cat`, `head` or
  `tail`; `TYCON_SAFETY_GUARD=0` turns it off; the assistant's own read tool does not go through this guard), the guard
  against unfiltered test runs for `npm test`, Vitest and `dotnet test` (`TYCON_TEST_SCOPE_GUARD=0`), and the one that
  blocks a pull request to `main` created with `az` without its flags (`TYCON_PR_AUTO_COMPLETE_GUARD=0`).
- In a repo that works with the harness (it has a `.tycon/` folder, or stories created with the skill, or the workflow
  has already run there): the gate that denies editing code without the workflow, the one that denies committing a story
  without evidence, and the ones that hold a turn open after a push to `main` without metrics or with unpushed work.

The full table, with what each hook does, whether it blocks and its switch, is in
[INSTALL.md](../INSTALL.md#los-hooks-que-instala) (in Spanish).

**What it does on its own**: when a session starts, the startup line checks whether your channel has a new version,
at most once every 6 hours. If it does, it tells you and waits: it does not apply it unless you ask for it from a
terminal (`node ~/.claude/tycon-harness/scripts/setup/harness.js update --yes`). Then it runs the installer.
`TYCON_UPDATE=0` turns the check off; `TYCON_UPDATE_CHANNEL` and `TYCON_UPDATE_APPLY` set the channel and the policy.

- At every startup, in the background: it runs a few quick tests of the harness itself, and re-reads the workflow
  conversations that closed without their usage record (`TYCON_NO_THREAD_RESCUE=1`).
- Once a day, in the background: it walks the git history of up to 200 repos in the parent folder of the clone and
  leaves one file per day in the `.dashboard/` folder of the clone (`TYCON_STAGE_METRICS=0`); and it gathers, into a
  file on your machine, the findings the reviewers left in your repos (`TYCON_NO_COLLECT_FINDINGS=1`).
- When an "ad-hoc" lane is declared, the edit gate launches, on its own, one short query to your assistant's model, with
  your last requests, to decide whether it applies (`TYCON_LANE_LLM=0`).

**What it writes and keeps on disk**:

- **Hooks in `~/.claude/settings.json`**, and two settings that apply to all your projects: `cleanupPeriodDays: 365`
  (Claude Code keeps conversations for a year) and `env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` (every command starts
  at the project root). If you already had a value, yours stays.
- **Links** from `~/.claude/tycon-harness`, `~/.claude/agent-skills`, `~/.claude/skills` and `~/.claude/agents` to
  the clone. If `~/.claude/skills` or `~/.claude/agents` already are real folders, it creates one link per entry inside
  them and never overwrites anything of yours.
- **Slash commands** copied into `~/.claude/commands/` (`TYCON_NO_COMMANDS_SYNC=1` skips the copy).
- **Global git hooks** in `~/.git-hooks/` (`TYCON_NO_GIT_HOOKS=1` skips them). git only uses them with a global
  `core.hooksPath`: if git has none, `install`, `apply` and startup (with `auto` apply; with `ask`, the notice asks for it
  and `update --yes` sets it) point it to that folder (one you already have is left alone),
  and `uninstall` or the switch to the minimal install remove it if it is still that one. With a global
  `core.hooksPath` git no longer calls the `.git/hooks/` of your repos: the harness hook runs each repo's `.git/hooks/`
  and `.githooks/` instead, for `pre-commit`, `post-commit` and `pre-push` (hooks with other names do not run). The
  first time one runs it says so, with how to leave it as it was: delete it or remove its execute permission.
- **Third-party skills** downloaded from their origins into the `skills/` folder of the clone: the ones listed in
  `scripts/publishing/third-party-skills.json`, each pinned to a commit (`TYCON_THIRD_PARTY=0` skips the step).
- **The install mechanism's own files**: its state and its pinned startup copy in `~/.claude/.tycon-pipeline/`, the
  startup line in `~/.claude/settings.json`, and a backup copy before each change in
  `~/.claude/.tycon-pipeline/harness/backups/`: the five newest stay, plus the one from before installing (it never
  rotates) and the one from before the current version. `harness.js rollback --list` shows them.
- **The harness's own Node 24** in `~/.tycon/node/` (about 50 MB, downloaded from nodejs.org and checked against the
  fingerprints that travel in the harness): its hooks run with it, your projects keep your Node and the PATH is not
  touched. `TYCON_HARNESS_NODE=0` turns it off; `uninstall` leaves the folder and says how to delete it.
- **What the hooks keep**, all on your machine: the last 8 requests of each session and the workflow state in
  `~/.claude/.tycon-pipeline/`, the answers that went over the length cap in `~/.claude/response-style/`, what the
  other two meters note in `~/.claude/blocking-meter/` and `~/.claude/lectura-grande/` (the working folder of each turn
  and the files read in full), the blocked commands in `~/.claude/safety-guard.log` and, for each run, its timings and a compressed copy of the
  conversation (requests, paths and code included) in `~/.claude/.tycon-pipeline/timing-history/`, which is never
  deleted automatically.

**With the Codex side turned on** (it is off by default: `integrations.codex: true` or `"detect"`, or `TYCON_CODEX=1`),
the installer also writes under `~/.codex/`, without overwriting anything of yours: `AGENTS.md` (a mirror of the rules
in `~/.claude/CLAUDE.md`: the same blocks change how Codex answers), `hooks.json` (the same hooks), the `[mcp_servers]`
section and the `writable_roots` of `config.toml` (the MCP servers you already have registered in Claude Code; secrets
are never written to the file), the reviewers' files `<name>.config.toml` and `agents/<name>.toml`, and links under
`skills/`. On a Mac it leaves a login agent (`ar.com.tycon.harness-env`) that publishes the switch and the MCP secrets
to graphical apps (`TYCON_NO_GUI_ENV=1` skips it). Once a day it runs, in the background, a test inside Codex that
spends model sessions (`TYCON_BENCH_DAILY=0`). With Azure DevOps configured, it also leaves a one-line `AGENTS.md` in
your team's repos that have a `CLAUDE.md` and no `AGENTS.md`; you commit it with the repo
(`TYCON_NO_AGENTSMD_POINTER=1` skips it). One step stays manual: open
a `codex` session, run `/hooks` and approve them; without that the hooks do not run and give no error. The approval
belongs to Codex, not to the harness, and is saved from an interactive session. With no one at the keyboard (a
container, `codex exec` in a scheduled task) unapproved checks do not run; `codex exec --dangerously-bypass-hook-trust`
runs them without the saved approval, meant for checks you already vetted (measured with Codex 0.162: without the
option a full test suite ran; with it, the brake stopped it).
With an open model (`codex --oss`) you also need one that can use tools: a 7B coding model answered without running
any command, and without commands no check fires.

**Network**: the harness sends no usage data. Out of the box it talks to GitHub (the repo, to check for a new version,
and the origins of the third-party skills listed in `scripts/publishing/third-party-skills.json`) and, if one of your
neighbouring repos is a partial clone, to that repo's remote, to read its history (the daily walk). The short query to
your assistant's model goes through the assistant you already use. Each optional connection you turn on adds its own service:
with Telegram, a run that is left waiting for you for more than five minutes sends you a message with the story,
the step and what it is waiting for (`TYCON_WAIT_NOTICE=0` turns it off). The
clean-machine test of this repository, if you run it, also downloads its base images (Docker Hub and Microsoft's
registry); git, Python and CA certificates (Debian's package repository); the sample plugin and the third-party skills
(GitHub); and the plugin's packages (NuGet).

**Where a switch goes**: export the `TYCON_…` variable in the shell you open Claude Code from and, in addition, write
it under `env` in `~/.claude/settings.json`. Use both places: the VS Code extension may not see what your shell startup
file exports, and `harness.js` run from a terminal does not read `env`. Switches that turn off something the installer
registers take effect from the next session. `~/.claude/tycon.json` holds the optional connections, the update policy and the
packs, not those variables.

**Removing it**: `harness.js uninstall` removes only what the mechanism recorded. It leaves the clone,
`~/.claude/tycon.json`, the backup copies and the state folder `~/.claude/.tycon-pipeline/`, the third-party skills
already downloaded, and what the hooks kept (`~/.claude/response-style/`, `~/.claude/blocking-meter/`,
`~/.claude/lectura-grande/` and `~/.claude/safety-guard.log`); it lists them when it runs. It also removes `cleanupPeriodDays: 365` if it still has that value: Claude Code goes back to its
default retention and deletes older conversations; to keep them, write that key yourself before uninstalling.

## Your product repo

The workflow runs on your product repo. Two optional files configure it:

- `.tycon/advisors.yaml`: what the reviewers need to know about the repo, and `packs:` to ask for a pack.
- `_bmad/bmm/config.yaml` (with `_bmad/core/config.yaml`): the configuration that the `bmad-*` skills read. It is optional:
  without it, the skill asks your name, the language and the output folder. Today those answers are not saved: to pin
  them, ask your agent to write those two files, and commit `_bmad/` with the repo.

**What puts a repo under the harness**: the `.tycon/` folder, and also the first story (an `.md` file with `story:` and
`status:` in its header) or the `.advisors/` folder the workflow leaves behind. From then on, editing code without an
open workflow or a declared "ad-hoc" lane is denied, and a push to `main` holds the turn open, up to three times, until
its metrics file exists (`TYCON_RETRO_PENDING=0` turns that off). The command above that asks for the pack creates the
`.tycon/` folder. Two ways to turn the edit gate off: `TYCON_STORY_GATE=off` in your environment (the agent cannot set
it for the running session), and `pipeline.story_gate: false` in `.tycon/advisors.yaml`, committed, for that repo.

**The browser test**: when a story changes a screen and the repo has no way yet to test in a browser, the harness offers
to set it up. With your yes it installs Playwright in the repo (as a development tool) and its browser, and writes
`playwright.config.ts`, a first test in `tests/e2e/` and the `e2e:` block of `.tycon/advisors.yaml`. To undo it, ask your
agent to undo the browser test setup; by hand it is
`node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/e2e-setup.js undo --repo <repo>`. It removes only what nobody
changed and it does not remove the browser, which your other projects share. With your no, the story keeps the test
pending, in plain sight, and the next story with a screen offers it again.

## Offline

Without network, the install still finishes (exit 0). The third-party step says in one line that it could not reach
the origins, and the presence check names the third-party skills that are missing. At the start of each session,
`harness.js startup` says it is offline and goes on, in 35 seconds at most.

To retry, with network: `node ~/.claude/tycon-harness/scripts/setup/harness.js apply` runs the installer again.
The same applies if, with network, some skills were left pending because the step hit its network limit
(`TYCON_THIRD_PARTY_NETWORK_BUDGET_S`, 20 seconds per run).

## With a proxy or your company's CA

The installer (`npx @tyconsa/harness@latest`, `get-harness` and `harness.js` itself) goes through a proxy with the usual
variables, in the terminal where you run it:

```bash
export HTTPS_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,.example.com
```

`HTTPS_PROXY` (or `HTTP_PROXY`, also in lowercase) is the proxy; `NO_PROXY` is a comma-separated list of hosts or `.domain`
suffixes that go direct. npx also passes along npm's own (`npm_config_https_proxy`, `npm_config_proxy`), and npm itself
needs them to fetch the package. If your company inspects HTTPS with its own certificate, point Node to it before
running the line: `export NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem`. Without it the installer stops with «no pude
verificar el certificado» (could not verify the certificate) and names `NODE_EXTRA_CA_CERTS`; it never turns verification off. In PowerShell, the same with
`$env:HTTPS_PROXY = '…'`, `$env:NO_PROXY = '…'` and `$env:NODE_EXTRA_CA_CERTS = '…'`.

## Uninstall

```bash
node ~/.claude/tycon-harness/scripts/setup/harness.js uninstall --dry-run
node ~/.claude/tycon-harness/scripts/setup/harness.js uninstall --yes
```

The first one shows what it would remove, and changes nothing. The second one removes only what the installer recorded
(hooks, links, blocks, background tasks) and says what it leaves: your `~/.claude/tycon.json`, your repos and anything
of yours stay untouched. `--tool claude` or `--tool codex` unplugs only that tool and keeps the harness.

## How it updates

- **Versions**: each version carries a number `YYYY.MM.DD.N`, where `N` is its order within the day. `stable` is `main` of
  this repo, which only changes through a reviewed pull request. `latest` would read a pre-release branch if this repo
  had one; today it has none, so both channels bring the same. Moving from `latest` to `stable` never goes down a
  version.
- **Channel**: `stable` by default. See or set it with
  `node ~/.claude/tycon-harness/scripts/setup/harness.js channel [latest|stable]`, or with `TYCON_UPDATE_CHANNEL`.
- **Policy**: `ask` by default (it tells you and waits); `auto` applies on its own. Set it with `TYCON_UPDATE_APPLY` or
  `update.apply` in `~/.claude/tycon.json`. Choosing `latest` together with `auto` asks you to confirm: you get every
  change that lands on `main`, within minutes, with no review of yours.
- **By hand**: `harness.js update --check` says whether there is a new version; `harness.js update --yes` applies it;
  `harness.js version` shows what is installed; `harness.js doctor` diagnoses without changing anything.
- **Going back**: `harness.js rollback --list` shows the copies it can go back to, and
  `harness.js rollback --to <copy>` goes back to the one you choose. After going back, the harness stops updating on
  its own until you release it with `harness.js rollback --release`.
- **Removing everything**: `harness.js uninstall --dry-run` shows what it would remove; `harness.js uninstall --yes`
  removes only what the mechanism recorded, and leaves anything of yours untouched.
- **Startup**: the startup line runs from a pinned copy in `~/.claude/.tycon-pipeline/harness/`, not from the folder that gets updated,
  so a half-finished update cannot break it. `TYCON_UPDATE=0` turns the update off; `TYCON_UPDATE_CHANNEL` and
  `TYCON_UPDATE_APPLY` set the channel and the policy.

All of these run as `node ~/.claude/tycon-harness/scripts/setup/harness.js <command>`.
