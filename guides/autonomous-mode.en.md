# The coordinator's autonomous mode

In Spanish: [autonomous-mode.md](autonomous-mode.md).

This page is for someone who has never used it. If you have not worked with a coordinator yet, start with
[Working with a coordinator](working-with-a-coordinator.en.md). The full rules the coordinator decides by are in
[Coordinating several sessions on one machine](coordination.en.md).

## What it is

The owner of the machine leaves (to sleep, for a long meeting, for the weekend) and the machine keeps working on its
own. The coordinator keeps opening sessions, giving them work and closing what can be closed without the owner. What
needs the owner is not lost and does not block anyone: it is gathered for when the owner comes back.

## What it is for

- **A night or a weekend pays off.** What does not need the owner moves until it reaches main on its own: a routine
  story, a small fix, a red test from the nightly run.
- **Nothing waits for an answer that will not come.** Sessions do not stop to ask: they write the decision down and go
  on with the rest.
- **When the owner is back, everything is together.** One batch of signatures, one at a time and with their context,
  instead of loose notices at all hours.

## How to start it

The owner tells the coordinator in their own words: "keep going on your own", "I'm leaving", "see you tomorrow". There
is no list of phrases: the coordinator judges it.

Under the hood, the coordinator sets **the owner-away mark**:

```bash
node marker.js owner-away set --phrase "<what the owner said>"
```

The mark belongs to the machine, not to a session: every session sees it. It is written to the log, with who set it,
the time and the phrase.

**It clears itself when the owner comes back.** Nobody has to remember to remove it. Any of these clears it:

- a message the owner types in any session;
- a message from the owner through the office (`/office`), verified;
- a signature of theirs after the mark, by window, terminal, click or message (a delegated signature does not count);
- expiry, after 24 hours.

## The rules, and what each one gains

1. **The mark.** With it, automatic reviews follow the organization's "owner away" rule right away, without waiting for
   the minutes without an answer. *Gain:* nobody waits half an hour to notice the owner is not there.
2. **No options box.** With the mark set, the harness denies the question box in every session, and says what to do
   instead: write the decision down, with a recommendation, and go on with the rest. If the owner is there and asked for
   the box, it is enough for them to write that they are back. *Gain:* one question no longer leaves a session stopped
   for hours (it happened: a session waited 5 hours one night).
3. **Signatures, gathered for when the owner is back.** Signatures that come up while the owner is away are gathered
   in a single batch, to be given by click, one at a time. The ones that touch the same files go in a single pull
   request, so that signing one does not expire the other. *Gain:* the owner signs everything at once, without repeats.
   It is an organization preference (see below).
4. **The coordinator gives what it can.** What the organization delegated to it (for example, level 1 routine
   signatures) it signs itself, without waiting. *Gain:* routine work does not wait for the morning. What it can sign is
   in [The harness signatures](firmas-del-arnes.en.md).
5. **Nothing by hand in the Claude Code folder.** Claude Code asks for confirmation to write in its folder even without
   permission prompts, and with the owner away nobody gives it. With the mark set, the harness stops that edit first and
   says what to do: use the harness script that writes it, or leave it for when the owner is back. The subfolders where
   Claude Code does not ask (each background session's working folder and the memories folder) stay free. *Gain:* no
   session waits for a confirmation nobody sees.
6. **Notices by profile.** By messaging, with the owner away, notices go out only if something really breaks, or never.
   *Gain:* the owner rests; if the organization wants, the owner hears about what is serious.

### The two organization preferences

They go in the team profile, under `coordination`. Each machine can change them for itself, like the coordinator's
other settings.

| Key | Values | Default |
|---|---|---|
| `away_signatures` | `on-return`: a single batch for when the owner is back · `hourly`: the hourly batch | `on-return` |
| `away_notify` | `broken-only`: only if something really breaks · `never`: never | `never` |

The coordinator sees them once per mark, in its notice on every turn.

## What it does NOT do

Autonomous mode does not sign what belongs to the owner. That always waits for the morning:

- delicate plans;
- changes to the harness controls (their records);
- anything that asks for a password or an access;
- what cannot be undone: production, deleting data, publishing outside.

## An example night

At 23:10 the owner writes to the coordinator "I'm leaving, keep going on your own". It sets the mark and goes on.

During the night:

- It finishes two routine stories that were in review. Their automatic reviews run with the owner-away rule, and both
  reach main on their own.
- A nightly test comes out red. It opens a session, which finds the cause, fixes it with its test and opens the pull
  request. Since it touches a control, its record waits for the morning.
- A session has a design question. The box is denied on its own: the session writes the question to a file with its
  recommendation, passes it to the coordinator and goes on with the part that does not depend on it.
- Another session needs to adjust a file in the Claude Code folder. The harness stops it: it leaves a note for later.
- No notice is sent: the organization has `away_notify: never`.

At 8:30 the owner writes "good morning" and the mark clears. They find:

- a batch of three signatures, one click each: the fix's record, a delicate plan and the design question, with the
  recommendation;
- the two stories already in main;
- the note about the Claude Code folder, for them to do.
