# The harness in one minute

English · [Castellano](one-minute.es.md)

**What it is.** A development cycle for your coding agent (Claude Code or Codex). The agent writes fast; the harness
makes it work with method: every change is written down first, tested, and reviewed by other agents. And there are
controls that stop, not just warn.

**Your first day, in three steps:**

1. **Install**, in the terminal: `npx @tyconsa/harness@latest`. It shows what changes and asks once.
2. **Open your agent in your repo's folder and ask** "create a story to …" with what you want to do. It shows you the
   story through three plain questions and writes it when you say yes.
3. **Say "implementemos la story"** (the agent recognizes it in Spanish). The harness takes the agent step by step:
   the plan, the tests, the code, the reviewers and the live check. At the end it leaves you the commit message.

**What it never does without you:** it never commits or pushes without your permission, and it shows you any plan
that isn't small before coding.

**The harness's words:**

| Word | What it is |
|---|---|
| **story** | your request in writing, with its criteria and its tests; the agent follows it |
| **reviewer** | an agent that reviews the change before the commit (security, conventions, coverage) |
| **brake** | a control that stops a command and says why and how to go on |
| **run** | one pass through a story, from validation to commit |
| **pull request** | the request that takes the change to the main branch |
| **lane** | a small fix without a story, with a person's permission and a file cap |

If something doesn't work: `/tycon-harness` in Claude Code says what's missing, without touching anything. Everything
else is on the [cover page](../README.md).
