# TYCON Harness for Claude Code and Codex

English · [Castellano](README.es.md)

**An AI software development life cycle (AI SDLC), from spec to production and beyond**, for Claude Code and Codex.

1. **Spec:** you and the agent write the story for the change: what has to be done and how it is tested. For a small
   fix, asking for it in your own words is enough.
2. **Code:** the agent makes the plan, waits for your go-ahead, and writes the code and the tests.
3. **Review:** specialized reviewers (security, conventions, coverage) check the change before the commit.
4. **Delivery:** the commit and the merge go through checks. For BIZUIT plugins it brings the scripts that deploy to
   test and to production.
5. **After:** every merge to main leaves its metrics file. The cycle dashboard and the nightly jobs (vulnerable
   dependencies, rule pruning) run only at TYCON today and are being published.

**It watches itself.** A test bench checks, on every change to the harness, that each control still blocks what it says
it blocks. If you turn it on, it also watches your sessions and proposes new rules for you to approve.

With the full profile, the checks block, they do not just warn: it does not rely on the model remembering the rules.
Most of them were born from a real incident.

**Each organization brings its own.** Its reviewers, skills and configuration travel in its team profile. TYCON brings
its own for BIZUIT plugins.

## Before you install: what changes on your machine

If you install with Claude, as described below, you get the full profile (`full`); the command by hand asks you which
one you want. The full profile changes things in all your projects, not just one:

- **Claude answers you in Spanish**, briefly and with the conclusion first. All command output, hook messages and
  rules are in Spanish too; there is no English option today.
- In a repo that works with stories, Claude does not edit code without going through the harness's story process.
- Git starts using a global folder for its commit checks (`core.hooksPath`). From then on, git stops running each
  repo's own checks, the ones in `.git/hooks/`. Claude asks you before it sets it.
- Once a day it reads the git history of your project repos (it finds their folder from where you use Claude Code). What it records stays on your machine.
- Claude Code keeps your conversations for a year.

If you don't want this, ask for the minimal profile (`minimal`). It brings the guides, the reviewers and the story process.
It does not change how Claude answers you and it does not touch git. It keeps a single guard: the one against destructive
commands.
To remove the harness, `harness.js uninstall --dry-run` shows what it would remove, and `harness.js uninstall --yes` removes it.

## What you need

- Claude Code, installed and signed in.
- Windows 11 with PowerShell 7, or Mac. On Linux or WSL, install by hand (it is in the "Reference").
- Node 22 or later and `tar`. On Mac, also Python 3 and Homebrew. Git is **not** needed to use the harness: it is
  downloaded as files, not cloned. A GitHub account is not needed either: this repository is public.
- To build BIZUIT extensions, your plugin's .NET SDK. Without it, the implementation stops at the build.

If something is missing, Claude tells you what to install and how.

## Install with Claude Code

It is the recommended path and takes about 10 minutes. Claude runs most of the commands; the download and the install
run in your own terminal.

1. Open the instructions for your system: [Windows](getting-started/windows.md), [Mac](getting-started/mac.md) or [Linux](getting-started/linux.md).
2. The instructions are in Spanish. Copy the whole "Parte 1" block (part 1). Open Claude Code in any folder and paste it into a new conversation.
3. Claude gives you the lines that download the install script, show it and run it: paste them in your own terminal,
   so you read the script before you run it. Nothing asks you to sign in: the harness never opens a browser.
4. Claude shows you the install plan and waits for your "yes". Before it touches `core.hooksPath`, it asks again.
5. At the end it writes a summary that ends in "OK" or "NO OK". Close Claude Code and open it again.

If you install a tool along the way, Claude asks you to close and reopen the terminal and Claude Code. If the summary
says "NO OK", keep it: it is what to show when you ask for help.

The harness lives in `~/.tycon/harness`, as downloaded files (no git). `~/.claude/tycon-harness` is a shortcut to that
same folder, and the commands on this page use it. Don't delete or move that folder: Claude Code
uses it from there, and it updates itself in place. Using the harness never needs a clone of this repository.

**Minimal profile.** When you paste the block, write "quiero el perfil mínimo" (I want the minimal profile) above it.
Claude installs `minimal` and does not touch `core.hooksPath`.

## Start working

1. Close Claude Code and open it again in your extension's repo folder: the rules load when it starts.
2. Ask for a story: "create a story with `tycon-create-story` to add a date filter". Read it and adjust it.
3. Ask "implementemos la story" (let's implement the story) with the file path. The phrase stays in Spanish.
4. The first time, Claude Code asks for permission to read the folder where the harness lives. You accept it once.
5. Claude shows you the plan, waits for your go-ahead, writes the code and runs the tests and reviewers.
6. It leaves the commit ready: it never commits or pushes without your permission.

If something doesn't work, type `/tycon-harness` in Claude Code (which version you have, whether it is installed correctly and whether there is a new one), or run `node ~/.claude/tycon-harness/scripts/setup/harness.js doctor`, which says what is missing. Neither one changes anything.

## For an organization

**Try it alone first.** Install it on your machine as described above: nothing from your organization is needed. If it
works for you, it is set up for the team with two repos of the organization, which only your team can see, besides this one, which
is the same for everybody:

| Repo | What it holds | Does it reach every machine? |
|---|---|---|
| This one (public) | the harness | Yes |
| The **team profile** (for example `harness-team-profile`) | the configuration the team shares and the list of where each repo of the organization lives (`team-repos.json`) | Yes, every machine that installs with `--team` |
| The **team operations** (for example `harness-team-operations`) | what runs at night for the organization (dependencies, dashboard, retrospectives) and who gets its notices (`operations.json`) | No: only those jobs read it |

An example: at ACME, Pedro is the administrator and Juan writes code.

1. Pedro creates ACME's two repos, in its Azure DevOps or GitHub, with access only for the team. For the profile he can
   start from [an example profile](https://github.com/TYCON-SA/harness-team-profile-example), ready to copy.
2. Pedro runs `node ~/.claude/tycon-harness/scripts/setup/harness.js team-config`. A page opens on his machine, with
   nothing on the internet, where he declares where each repo lives and who gets the notices. The page checks what he
   writes, saves it in the right repo and offers him the pull request.
3. Juan installs with `--team` and the profile: `harness.js install --version latest --team acme/harness-team-profile`
   if it is on GitHub, or with the repo's address if it is on Azure DevOps. From then on, every update also brings him
   what belongs to the team.

How the harness extends for your organization —the layers, the configuration page and a worked example— in an
[interactive map](https://www.bizuit.com/sdd-harness/more/mapa-del-arnes.html).

**The nightly jobs.** On Azure DevOps, the dependency review, the cycle metrics and the dashboard run in your
organization with three model pipelines and your operations repo: [how to set them up](pipelines/operations/README.md)
(in Spanish). On GitHub, the same three run as GitHub Actions workflows, and the dependency findings become issues in
each product repo: [how to set them up](pipelines/operations/github/README.md) (in Spanish). The production watcher is not
published: it is still TYCON's own.

## Where to go next

| If you want to… | Read |
|---|---|
| Install by hand, on Linux or with nobody at the keyboard | [Install by hand](getting-started/reference.md#install-by-hand) |
| Know what it writes on your machine and how to turn each thing off | [What it writes on your machine](getting-started/reference.md#what-it-writes-on-your-machine-and-what-it-does-on-its-own) |
| Update, go back or uninstall | [How it updates](getting-started/reference.md#how-it-updates) |
| Use it with Codex | [What is optional](getting-started/reference.md#what-is-optional) |
| Change the harness | [CONTRIBUTING.md](.github/CONTRIBUTING.md) |

## License and trademarks

Apache License 2.0: see [LICENSE](LICENSE). [NOTICE](NOTICE) lists the owner, the trademarks and the
attributions of the files derived from third-party work.

TYCON and Bizuit are trademarks of their owners, and the license does not grant them.
This harness uses BMad Method (MIT); it is not affiliated with or endorsed by BMad Code, LLC.

To contribute, read [CONTRIBUTING.md](.github/CONTRIBUTING.md). To report a vulnerability, read
[SECURITY.md](.github/SECURITY.md). Participation follows the [code of conduct](.github/CODE_OF_CONDUCT.md).
