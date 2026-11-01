# The harness in one minute

English · [Castellano](one-minute.es.md)

**What it is.** A development cycle for your coding agent (Claude Code or Codex). The agent writes fast; the harness
brings method to it: every change is written down first, tested, and reviewed by other agents. And there are checks
that stop you, not just warn you.

**Your first day, in three steps:**

1. **Install**, in the terminal: `npx @tyconsa/harness@latest`. It shows what changes and asks once. You need Node 22
   or later and your agent already installed (on Windows, PowerShell 7).
2. **Open your agent in your repo's folder and ask** "create a story to …" with what you want to do. It builds the
   story by answering three plain questions (what it has to do, how you can tell it works, what it must not touch),
   shows it to you and writes it when you say yes.
3. **Say "implementemos la story"** (the agent recognizes it in Spanish). The harness takes the agent step by step:
   the plan, the tests, the code, the reviewers and the live check. At the end it leaves you the commit message.

**What it never does without you:** it never commits or pushes without your permission, and it shows you the plan
before coding: in a small story it approves it itself, in the others it waits for your go-ahead.

**The harness's words:**

| Word | What it is |
|---|---|
| **story** | your request in writing, with its criteria and its tests; the agent follows it |
| **reviewer** | an agent that reviews the change before the commit (security, conventions, coverage) |
| **guard** | a check that stops a command and says why and how to go on |
| **run** | one pass through a story, from validation to commit |
| **pull request** | the request that takes the change to the main branch |
| **lane** | how a change travels: with a story, or as an ad-hoc fix (a small fix, with a person's permission and a cap on files) |

If something doesn't work: `/tycon-harness` in Claude Code says what's missing, without touching anything; from any
terminal, `node ~/.claude/tycon-harness/scripts/setup/harness.js doctor` does the same. Everything else is on the
[cover page](../README.md).
