# The coordinator's autonomous mode

In Spanish: [autonomous-mode.md](autonomous-mode.md).

This page is for whoever works with a coordinator and wants to leave it working on its own: overnight, over a weekend,
or while they are busy with something else. What the coordinator is and how to start it is in
[Working with a coordinator](working-with-a-coordinator.en.md); its full rules, in
[Coordinating several sessions on one machine](coordination.en.md).

## What it is

Autonomous mode is the coordinator working **while the owner is away**. The owner leaves, and the machine keeps going:
the sessions finish what they have, whatever does not need the owner gets into `main`, and whatever does need them waits,
gathered together.

It is not another tool or another setting. It is the same coordinator, with a mark that says "the owner is not here".

## What it is for

- **The night is not wasted.** What is already approved moves on its own: tests, reviews, pull requests that get into
  `main` with CI green.
- **The owner does not come back to a mess.** What needs their signature waits for them in a list, one at a time, with
  its context.
- **Nobody is stuck waiting for an answer.** A session that needs the owner writes the question down and moves on to
  something else.

## How to start it

The owner tells the coordinator in their own words, in its tab: "keep going on your own", "I'm leaving", "see you
tomorrow".

- **What happens inside.** The coordinator sets the **away mark**:
  `marker.js owner-away set --phrase "<what the owner said>"`. The phrase has to be in a message the owner typed in their
  tab in the last 30 minutes: the agent does not set the mark on its own, nor because of a message from another session.
- **How to see it.** The office (`/office`) shows it while it is set.
- **How it is lifted.** On its own, when the owner comes back: a message from them, a message from them through the
  office, a signature of theirs, or after 24 hours.

Without the mark, the owner counts as away anyway after a while without answering (each organization sets how long);
the mark only brings forward what would happen anyway.

## Its rules, and what each one gains

| Rule | What it gains |
|---|---|
| **The mark.** The owner says they are leaving and the coordinator sets it; it lifts itself when they come back. | Every session knows, without asking, that there is nobody to ask. |
| **No option box.** With the mark set, nobody opens a question box: the decision is written down, with its recommendation, and the session moves on. | A box opened in the middle of the night used to leave a session stuck for hours, waiting for someone who was not there. |
| **Signatures are gathered for the return.** Whatever asks for the owner's signature stays in their list; when they come back, the coordinator hands it to them one at a time, by click. Signatures that touch the same files go in a single pull request. | The owner signs everything at once, in a short while, and no signature makes another one expire. |
| **The coordinator gives what it can.** Routine work the organization delegated to it (for example, approving an ordinary plan when the automatic review said "approved") it signs itself. | What can be undone does not wait for the owner. |
| **Nothing by hand in the Claude folder.** With the owner away, nobody writes by hand inside Claude Code's configuration folder: the harness scripts are used, or it is left for the return. | Claude Code asks for confirmation to write there even without permission prompts, and with the owner away nobody gives it: the session used to get stuck. |
| **Notices according to the profile.** With the owner away, the organization chooses what reaches them through the notice channels (Telegram, Slack, Teams or email): see below. | Each organization decides whether it wants to know at night or only in the morning. |

### Notices while the owner is away

The `coordination.away_notify` option of the team profile says what reaches the owner while they are away:

| Value | What reaches them |
|---|---|
| `signatures` (default) | One notice for each signature or permission left waiting for them. It waits in their list anyway: the notice only tells them it is there. |
| `broken-only` | Only what really broke: a control that does not run, an outage. Signatures wait silently. |
| `never` | Nothing. Everything waits in their list for when they come back. |

It is changed in the team profile, like any other coordinator option.

## What it does NOT do

Autonomous mode does not give the coordinator anything it did not have. With the owner away:

- **It does not sign what belongs to the owner.** A delicate plan, a change to a control, whatever asks for a password
  and anything irreversible always wait for their return.
- **It does not skip the brakes.** They stop it just like any other session.
- **It does not decide the product.** What gets built and in what order is the owner's call; at night, work moves on
  with what is already decided.

## An example night

Made up, to show the shape.

At 11 pm, the owner tells the coordinator "I'm leaving, keep going on your own" and closes the laptop. The coordinator
sets the mark.

During the night:

- Three sessions finish small fixes that were already approved. Their pull requests pass CI and get into `main`.
- One session needs to choose between two ways of doing a fix. It does not open a box: it writes down which one it
  recommends and why, and the coordinator gives it other work from the queue.
- Another session finishes a change to a control. It asks for its signature, which stays in the owner's list; since the
  profile says `signatures`, the owner gets a one-line notice. The session moves on.
- The coordinator approves two routine plans, because the organization delegated them to it.

At 8 am, the owner writes "good morning". The mark lifts itself. The coordinator hands over what was waiting: the
control's signature, by click, and the decision that was written down, with its recommendation. Everything else is
already in `main`.
