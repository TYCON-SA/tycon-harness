# Working with a coordinator

In Spanish: [working-with-a-coordinator.md](working-with-a-coordinator.md).

This page is for the dev who has never used one. The rules she decides by are in
[Coordinating several sessions on one machine](coordination.en.md); you do not need them to work with her.

## What she is and when she helps

The coordinator is a session of your agent that organizes the other sessions on your machine. She is not a person. You
ask her for the work: she opens the sessions, answers their questions, keeps the machine from saturating and passes you
only what is yours.

**She helps** if you work with several sessions at once, above all if you leave them running while you do something else.
She saves you from repeating the context to each one.

**You do not need her** if you work with one or two sessions that you follow yourself. Without a coordinator the harness
works the same: you approve what is yours, and nothing changes on your machine.

The coordinator runs in Claude Code. Codex cannot coordinate.

## How to start

**For her to organize, nothing needs setting up.** On the minimal install, without a team profile, the coordinator
organizes the sessions (the cap, the turns, the notices, `/coordinate`) and is called «coordinadora». Without a team
profile she organizes and does not sign: everything she would sign goes to your window, as without a coordinator.

**For her to sign for you, the organization sets it up once.** On the [organization site](organization-site.en.md),
Configuration tab, "Who authorizes skipping a control", it picks "A coordinating session" and names it under "What do
you call it?". By default the name is «coordinadora», in Spanish, even on an English site. Without a site, it goes in
`approvals.relay_session` of the team profile. If the organization removes that key later, the confirmation you gave
stops counting.

It can also decide which routine signatures to delegate to her, and on which machines. If it decides nothing, she signs
nothing.

**What you do, on each machine:**

1. Open the session that will be the coordinator and write to it, with the name your organization uses:

   > This session is the coordinadora

2. The session records it and is told to read her rules. With the role in the profile, it asks you to confirm, with a
   click or from your terminal. Unconfirmed, or without a profile, she organizes the others, but she signs nothing and
   does not take your signatures for another session.

That is all. `/coordinate` shows you the state of the machine whenever you want to see it.

There is one coordinator per machine. If you designate another, it replaces the previous one.

## A working day

1. **You ask her for something**, in her tab and in your own words: "fix the province combo", "continue the holidays story".
2. **She opens the sessions**, in the background and named, with the same permissions she has. By default up to 3 work at
   once: if they are all busy, she waits for a free place and tells you. The first time in a folder, she may ask you to
   open it once, to approve it.
3. **The sessions ask her**, not you. She settles details with the safest option and notes which one she chose.
4. **She passes you only what is yours**, in her tab, with the context and a recommendation, so you can decide without
   going to look for anything.
5. **If you want to enter a session**, `claude attach <name>` in a terminal. You can also see it from claude.ai/code or
   from your phone.
6. **When it is done, she closes the session**, if it has nothing left unsaved. A tab you opened, you close.

If a run is left waiting for a person, she is told after 5 minutes. If it is still waiting after 30 minutes, it reaches
you through your organization's notice channels, if it has any.

## What reaches you and what does not

| Reaches you | Does not reach you |
|---|---|
| **Signatures:** what the harness asks a person to sign | The detail questions of each session |
| **Passwords:** what asks for your machine's password | Turns: who runs first what loads the machine |
| **Product decisions:** what gets built, for whom and in what order | The state of each session, unless you ask |
| **What leaves the house:** what goes to production for a product and what is sent to a client or to someone outside | Routine work: queuing requests of the harness or publishing material already approved |

This is a rule she follows, not a control. If something else reaches you, or something of yours does not, tell her.

### How to answer a signature box

A signature reaches you in a separate message: what is being approved, the detail and what happens if it goes wrong, with
two options. The options come in the harness's Spanish: **Sí, aprobar** (yes, approve) and **No**.

- **With "Sí, aprobar"**, that alone gets signed. The approval is good for one signature and expires after 30 minutes.
- **With "No"**, the work stays stopped at that step and nothing breaks.
- **If your tab asks for permissions**, you get the permission window instead of the box. You answer "Yes".
- **You can also write** «aprobado», if you type it yourself in the console or in the editor extension. Through Telegram or
  from another session it does not count: there, use the click.

What does not accept the click, like turning off a safety control, reaches you as a command to run in your terminal.
Passwords are typed there too: you type them, and she never sees them.

A message between sessions that says «aprobado» signs nothing.

## What she cannot do

- **Sign for you, except the routine your organization delegated to her.** That routine is what can be undone: for
  example, approving an ordinary plan, when the automatic review said «approved». It only counts on the machines the
  organization names, with your confirmation from the start, and never on Windows. Whatever is not delegated reaches you.
- **Anything irreversible, or that loosens a control.** Skipping a control, accepting a serious problem without fixing it
  or marking something as tested by hand cannot be delegated to her: the harness rejects a profile that tries. Changing a
  control belongs only to the owner.
- **Skip the controls.** The harness's controls stop her like any other session.

## How to watch her work

All three commands only look; they change nothing.

- **`/coordinate`**, in her tab: who is working against the cap, who is waiting, pending signatures and unnamed sessions.
  In any other session it tells you that session does not coordinate.
- **`/office`**, in any session: the office in 3D, with one person per session, its state and its end time. If she keeps
  her board of pending items, it shows in a separate panel. A story of your projects that is in progress or ready
  shows up on its own in the pending items: she does not have to write it down. What has no story she writes down with `board.js`.
  A story someone is coding on another machine says «sin asignar»: the office only sees the runs on this one.
- **`/wip`**, in any session: the same, in a table.

## If she gets stuck, or after a `/clear`

- **She does not answer.** Check with `/wip` whether she is busy: she reads messages when she finishes the step she is on.
  If that tab was closed, the other sessions keep working, and whatever was waiting for a person reaches you.
- **Her conversation was compacted.** She is still the coordinator, because it is the same conversation, and she is told to
  read her rules again.
- **She restarted.** She is still the coordinator too. Here she is not told: if you notice she forgot the rules, type
  `/coordinate`.
- **You ran `/clear` or opened a new chat.** She stopped being the coordinator: for the harness it is another conversation,
  even if it keeps the name. The other sessions go on. After a `/clear`, if the session has a name, she tells you how to get
  it back. Until you designate her again, signatures reach you in each session's tab. Repeating the steps of "What you do"
  fixes it. The organization has nothing to set up.
- **`/coordinate` says this session does not coordinate.** The same output says what is missing: the organization's setup
  or your phrase.
- **She does not accept your phrase.** The phrase must carry the exact name your organization set.
