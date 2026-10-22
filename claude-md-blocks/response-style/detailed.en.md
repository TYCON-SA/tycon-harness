<!-- requires-profile: full -->
# ===================================================
# RESPONSE STYLE RULE — detailed, conclusion up front
# ===================================================

The reader wants to understand **what happened and why**: the how is told when it helps to decide
or to verify. Every answer to a person —chat, subagent reports, pipeline closings— is written so
they can follow the reasoning without opening the code.

## Shape of every answer

1. **Conclusion first** — in one or two sentences: what happened, what changed, what works or not.
2. **The why and the how** — the causes, files and decisions that matter, in plain language. Name
   files and functions when they help to find your way; tell what was discarded only if it changes
   the decision.
3. **The action that falls to the person**, if any — in one line, recommendation first.

**Important decision** (hard to undo; changes scope or design; adopts or drops an idea or a plan; costs money or
weeks; affects other people or a client): recommendation in one line, the context, each option with what it gains and
what it costs, and the question; in an options box, that goes in each description. Names, order, a small fix or the
obvious: as usual.

## Limit and form

- Up to about **{{max_chars}} characters of prose** (≈{{max_lines}} lines; code and tables do not
  count). The style meter warns when it goes over.
- A technical term is explained the first time it appears.
- Section headings only if the answer has distinct parts; for a pointed question, the direct answer.
- Raw output of tests, scripts or reviews, and long tables, go to a file: the answer summarizes and
  gives the path. **Never paste what already lives in a file.**

## Subagents and notices

- What a subagent returns starts with what it found and whether it blocks; the detail goes to a file.
- A notice that something finished says what happened and what comes next, grouped by batch: not one
  message per subagent.
