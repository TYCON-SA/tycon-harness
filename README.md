# TYCON Harness

English · [Castellano](README.es.md)

**A development cycle for coding agents: complete, consistent, controlled and adaptable.**

- **Complete:** it goes from the request to production and to measurement; it does not stop at writing code.
- **Consistent:** every story follows the same workflow, on every machine of the team.
- **Controlled:** the checks block, they do not just warn: they do not rely on the model remembering the rules. The
  minimal install brings one (against destructive commands); the full install adds the rest.
- **Adaptable:** each organization adds its own reviewers, skills and configuration.

Your coding agent writes fast; the harness makes it work with method. It works with Claude Code and with Codex. The
AI software development life cycle (AI SDLC), step by step:

1. **Request and story:** you say what you want and the agent writes it as a story: what has to be done and how it is
   tested. For a small fix, asking for it in your own words is enough.
2. **Approved plan:** the agent makes the plan and shows it to you; in a small story it approves it on its own, in the others it waits for your go-ahead.
3. **Tests and code:** it writes the tests and the code, and runs the tests.
4. **Review:** specialized reviewers (security, conventions, coverage) check the change before the commit.
5. **Delivery:** the commit and the merge go through checks. Nothing is committed or pushed without your permission.
6. **Operation and measurement:** every merge to main leaves its metrics file, and your organization's nightly jobs
   review the dependencies and build the cycle dashboard.

The checks are one part of the cycle: they guard every step. There are two ways to start it: [on your own, on your
machine](#start-on-your-own), or [for your team](#for-teams).

## Start on your own

**It works today for .NET, JavaScript, TypeScript, Python, Go and Java**: out of the box the test step runs .NET,
Vitest, Jest, Node (`node --test`), pytest, Go, Maven, Gradle and Karma. With another tool, that step does not recognize
your tests yet until your team declares it in its configuration ("Your technology", on the site).

Before you install you need your coding agent (Claude Code or Codex) signed in, and Node 22 or later. The full list
is in [What you need](#what-you-need).

For your agent to follow the cycle, install the harness on your machine. Open the terminal (on Windows, PowerShell 7)
and type:

```bash
npx @tyconsa/harness@latest
```

It asks nothing before the plan: it installs for you, with the minimal install, no optional connections and no
reviewers for a stack. It shows you in five lines (in Spanish) what will change and asks once "¿Instalo? [s/N]"
(install?): with a "no", nothing is left behind. Without Claude Code or Codex it tells you how to install them and
downloads nothing. After the "s" (yes) it takes less than a minute and ends with "arnés instalado" (harness
installed) and the version. The minimal install adds the harness's guide index to your agent in every session; it
does not touch git or the rules on how the agent answers you. To remove it, `harness.js uninstall --dry-run` shows
what it would remove and `harness.js uninstall --yes` removes it.

If you use Codex, one step is left: the last line asks you to open `codex`, run `/hooks` and approve them once. Codex
approves its hooks one by one; without that step the harness's controls do not run in Codex, and nothing warns you.

The full install adds the guards in the repos that work with the harness and changes how the agent answers you in all your projects:
[what it changes](getting-started/reference.md#what-the-full-install-changes).

## Your first story

A story is your request in writing, with its criteria and its tests: the agent follows it and the reviewers check it. Make the first one small, like a new function in one file: one like that takes about 10 minutes.

1. **Open your coding agent in your repo's folder**: that is where it writes the story, creates the branch and saves the changes. If it was open from before you installed, close it and open it again: the harness's rules load when it starts.
2. **Say you trust the folder**: the first time you open your agent in that folder, it asks whether you trust it: say yes.
3. **Ask for the story in your own words**, so the change is written down before any code: "create a story to add a date filter".
4. **Review the story.** The agent builds it from your request, answering three plain questions (what it must do, how you can tell it works, and what it must not touch), and marks what it assumed. It shows it to you and writes it on your "yes". If your repo already has a `_bmad/` folder, it builds it with what is there.
5. **Ask "implementemos la story" (let's implement the story) with the file path**, to start the run: the phrase stays in Spanish. If there is no git, it initializes it; if you are on `main`, it creates the branch. It validates the story and, if something is missing, asks whether to fix it. In a small story it shows you the plan and approves it on its own; in the others, you approve it. Then it writes the tests and the code, runs the tests and the reviewers, and checks each criterion by running it. If the story touches screens, it also builds a mockup for you to approve, tests it in a browser if your repo already has those tests, and leaves a guide for testing it by hand.
6. **Read the summary and say "commit it".** It leaves the message ready and never commits or pushes without your permission. When the first story closes, it offers you the full install.

If something doesn't work, `/tycon-harness` (in Claude Code) or `node ~/.claude/tycon-harness/scripts/setup/harness.js doctor` says what is missing, without changing anything.

## What you need

- Your coding agent, Claude Code or Codex, installed and signed in: it is where you use the harness.
- Node 24 and `tar` (Node 22 or later is enough to run the install line). On Mac and Linux, also Python 3.
- Windows 11 with PowerShell 7, Mac or Linux. WSL was not tested.
- Git is **not** needed to install the harness: it is downloaded as files, not cloned.
  A GitHub account is not needed either: this repository is public. To commit your stories you do need git, with
  your name and email set (`git config --global user.name` and `user.email`).
- Your Node is needed to install. After that the harness downloads its own Node 24 (about 50 MB, from nodejs.org) and
  its hooks run with it; your projects keep your Node, which is not touched. Turn it off with `TYCON_HARNESS_NODE=0`.
- What your project needs to build (for example, the .NET SDK). Without it, the implementation stops at the build.

If something is missing, the installer tells you what and installs nothing. To install by hand, without npm, or with
nobody at the keyboard: [Install by hand](getting-started/reference.md#install-by-hand).

## Install with Claude Code

It is the alternative if you would rather be guided, and it takes about 10 minutes. Claude runs most of the commands;
the install runs in your own terminal. This path gives you the full install (`full`).

1. Open the instructions for your system: [Windows](getting-started/windows.md), [Mac](getting-started/mac.md) or [Linux](getting-started/linux.md).
2. The instructions are in Spanish. Copy the whole "Parte 1" block (part 1). Open Claude Code in any folder and paste it into a new conversation.
3. Claude gives you the npx line for your own terminal: you run it, so you see the plan before you answer. Nothing
   asks you to sign in: the harness never opens a browser.
4. Claude shows you the install plan and waits for your "yes". The plan says whether it will set `core.hooksPath`.
5. At the end it writes a summary that ends in "OK" or "NO OK". Close Claude Code and open it again.

If you install a tool along the way, Claude asks you to close and reopen the terminal and Claude Code. If the summary
says "NO OK", keep it: it is what to show when you ask for help.

The harness lives in `~/.tycon/harness`, as downloaded files (no git). `~/.claude/tycon-harness` is a shortcut to that
same folder, and the commands on this page use it. Don't delete or move that folder: your agent uses it from there,
and it updates itself in place. Using the harness never needs a clone of this repository.

**The minimal install.** When you paste the block, write "quiero el perfil mínimo" (I want the minimal profile) above
it. Claude installs `minimal` and does not touch `core.hooksPath`.

## For teams

**Try it alone first.** Install it on your machine as described above: nothing from your organization is needed. If it
works for you, it is set up for the team with two repos of the organization, which only your team can see, besides
this one, which is the same for everybody:

| Repo | What it holds | Does it reach every machine? |
|---|---|---|
| This one (public) | the harness | Yes |
| The **team repo** (for example `harness-team-profile`) | the configuration the team shares and the list of where each repo of the organization lives (`team-repos.json`) | Yes, every machine that installs with `--team` |
| The **team operations** (for example `harness-team-operations`) | what runs at night for the organization (dependencies, dashboard, retrospectives) and who gets its notices (`operations.json`) | No: only those jobs read it |

An example: at ACME, Pedro is the admin and Juan writes code.

1. Pedro sets ACME up with `npx @tyconsa/harness@latest --audience org`. The line installs his machine and goes on with `harness.js team-init`: it
   asks for the name, the platform and the address of the team repo, builds its three files (`team-layer.json`,
   `team-profile.json` and `team-repos.json`) from [an example](https://github.com/TYCON-SA/harness-team-profile-example)
   and validates them before writing. It creates no repos and asks for no credentials: it tells him where to create the
   empty repo, with access only for the team, and if he says yes it pushes it with his git. With the harness already
   installed, the same is `node ~/.tycon/harness/scripts/setup/harness.js team-init`. The operations repo is created
   separately (below, "The nightly jobs").
2. Everything that is customized —where each repo lives, who gets the notices, the thresholds— is configured from the
   **Configuration** tab of the [team site](guides/organization-site.en.md) (admins only): it validates with the
   harness's own readers and proposes every change as a pull request, never a direct write to `main`. While ACME has no
   site, each file is changed with a pull request to its repo: what reaches the machines, to the team repo; what is for
   the nightly jobs and the site, to the operations repo. The harness works fully that way: what each case needs and
   where each setting lives, in [With or without the site](getting-started/reference.md#with-or-without-the-site).
   The local page (`node ~/.tycon/harness/scripts/setup/harness.js team-config`) shows, read-only and with nothing on
   the internet, what is in his clones and the problems the readers see; it saves and proposes nothing.
3. Juan installs with npx and the team repo: `npx @tyconsa/harness@latest --team acme/harness-team-profile` if it is on
   GitHub, or `npx @tyconsa/harness@latest --team https://dev.azure.com/acme/<project>/_git/harness-team-profile` if it
   is on Azure DevOps. Since only the team sees that repo, before downloading anything the line checks that it can read
   it and, if not, asks him for read permission. From then on, every update also brings him what belongs to the team.

How the harness extends for your organization —what each organization adds, the configuration page and a worked example— in an
[interactive map](https://www.bizuit.com/sdd-harness/more/mapa-del-arnes.html).

**The nightly jobs.** On Azure DevOps, the dependency review, the cycle metrics and the dashboard run in your
organization with three model jobs and your operations repo: [how to set them up](pipelines/operations/README.md)
(in Spanish). On GitHub, the same three run as GitHub Actions workflows, and the dependency findings become issues in
each product repo: [how to set them up](pipelines/operations/github/README.md) (in Spanish).

## What else it does

- **It watches itself.** A test bench checks, on every change to the harness, that each check still blocks what it
  says it blocks. If you turn it on, it also watches your sessions and proposes new rules for you to approve.
- **Checks born from incidents.** With the full install, the checks block, they do not just warn. Most of them were
  born from a real incident.
- **Reviewers for your stack.** Each organization adds its own in its team repo. TYCON brings its own for BIZUIT
  plugins, with the scripts that deploy to test and to production.
- **What is still TYCON's own:** the production watcher is not published.

The harness's words (story, workflow, guard, nightly jobs…), one line each, in
[The harness's words](getting-started/reference.md#the-harnesss-words).

## Where to go next

| If you want to… | Read |
|---|---|
| Install by hand, on Linux or with nobody at the keyboard | [Install by hand](getting-started/reference.md#install-by-hand) |
| Know what it writes on your machine and how to turn each thing off | [What it writes on your machine](getting-started/reference.md#what-it-writes-on-your-machine-and-what-it-does-on-its-own) |
| Update, go back or uninstall | [How it updates](getting-started/reference.md#how-it-updates) |
| Use it with Codex | [What is optional](getting-started/reference.md#what-is-optional) |
| Understand a word of the harness | [The harness's words](getting-started/reference.md#the-harnesss-words) |
| Change the harness | [CONTRIBUTING.md](.github/CONTRIBUTING.md) |

## License and trademarks

Apache License 2.0: see [LICENSE](LICENSE). [NOTICE](NOTICE) lists the owner, the trademarks and the
attributions of the files derived from third-party work.

TYCON and Bizuit are trademarks of their owners, and the license does not grant them.
This harness uses BMad Method (MIT); it is not affiliated with or endorsed by BMad Code, LLC.

To contribute, read [CONTRIBUTING.md](.github/CONTRIBUTING.md). To report a vulnerability, read
[SECURITY.md](.github/SECURITY.md). Participation follows the [code of conduct](.github/CODE_OF_CONDUCT.md).
