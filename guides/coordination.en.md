# Coordinating several sessions on one machine

This guide is for an organization that works with several agent sessions at once on the same machine and wants one of
them, **the coordinator**, to organize the rest. The coordinator decides what is not the owner's to decide, opens and
names the sessions, keeps the machine from being overloaded, and passes the owner only what is theirs.

It is a recipe, not a mode: nothing changes on a machine where nobody designated a coordinator. It is turned on in two
steps:

1. The team profile names the role in `approvals.relay_session` (on the site, the Configuration tab, "Who authorizes
   skipping a control").
2. On each machine, the owner writes "Esta sesión es la coordinadora" in the chat of the chosen session, and that
   session runs `marker.js designate-relay` with that quote.

After that, `/coordinate` in that session shows the machine's status. The program the coordinator uses is
`<harness>/scripts/tools/coordination.js`.

## What goes to the owner

Three things go to the owner, always the same ones:

- **Signatures**: what the harness asks a person to sign (for example, control changes).
- **Passwords**: what asks for the machine's password (for example, reinstalling the production brake).
- **Product decisions**: what gets built, for whom, and in what order of priority.

The coordinator decides everything else. The other sessions ask her, not the owner: that way the owner does not have
to repeat each session's context.

## How the coordinator decides

- She approves the sessions' plans, by delegation from the owner, and says so in the approval.
- On a matter of detail she picks the safest option and writes down what she picked and why.
- She asks the owner only what the previous section lists, with the whole context and a recommendation: the owner does
  not have to look anything up to decide.
- She does not ask the owner for something she can find out: first she looks at the code, the logs and the machine's
  status.

## Opening and naming the sessions

A session's name is the one in its session file: the same one the messages between sessions use and the one `/wip`
shows. It is set in a single step:

- When opening it, with its name (`-n <name>`).
- If it is already open, with `/rename <name>` in that session.

`/coordinate` lists the sessions whose name the tool made up and not a person, so the owner can name them.

The coordinator opens a new session with `coordination.js open --name <name> --cwd <folder> -- <task>`. It opens a real
session, in the background, never a subagent, and returns how to go in and watch it (`claude attach <name>`). Before
opening it checks two things, in order, and if one fails it does not open and says why:

1. The name: only letters, digits, hyphen and underscore, and not used by another live session.
2. The cap: if as many sessions as the cap are already working, it does not open.

`open` never retries. If the tool refuses because nobody approved the folder, it says in one line which folder the
owner has to open once; meanwhile, the owner opens the session and the coordinator gives it the task. The approval
belongs to a person: the agent does not write it. The other failures also take one line: the launcher is not
installed, the first line of its error, or it did not come back within 30 seconds. A failed opening does not count
toward the cap.

**Measured limit:** approving a folder does not cover the folders inside it, so each new worktree asks for its own
approval. In practice, the first time the coordinator opens a session in a new worktree, `open` answers that the
folder still needs approving.

**That is why there are fixed work slots.** With `--repo <repo>` instead of `--cwd`, `open` does not use a new folder:
it takes a free slot of the repo and opens the session there, on the job's branch (`--branch <branch>`, or
`wt/<name>`). There are as many slots as the cap and they are always the same folders, so the owner approves them only
once: `node scripts/tools/work-slots.js pending-trust` lists the missing ones, each with its `cd`. With no free slot,
`open` says so and does not open. The task tells the session how to release the slot when it is done; if the launcher
fails, the slot is free again. What the slots are: `guides/git-worktrees.md` §8.

**Not measured yet, left as the owner's test:** how long a session opened in the background takes to show up, and what
title the editor tab shows after `/rename`. The guide takes neither for granted.

`open` passes the task to the launcher as is, without reviewing it: nothing it says signs anything (see «The owner's
signatures»).

With Codex, the owner opens the sessions: Codex has no launcher for named background sessions.

## The cap: what counts as working

**Working** is a live session whose session file says it is busy. A session waiting for CI, the queue or the owner has
finished its turn: it does not count. Codex sessions do not write that file; they count if they had activity in the
last 5 minutes. A session that `open` opened less than 10 minutes ago counts even if it has not written its file yet.

The cap is `coordination.max_working`, from 1 to 20. The team profile gives the organization's number (on the site,
Configuration tab, "How many sessions work at once"), and each machine can change it for itself, because how much it
can take depends on the machine. With no value anywhere, the cap is 3. `coordination.js status` shows who is working,
who is waiting and why, and the cap with where it comes from.

The coordinator also sees it without asking: on each turn, if the machine is at the cap, a notice tells her who is
working; if it is over, by how much and which one has been working the shortest. Below the cap it says nothing, and no
other session sees it. It is turned off with `TYCON_COORDINATION_NOTICE=0`.

## Adversarial passes, one at a time

An adversarial pass weighs a lot on the machine: two at once overload it. Before launching one, the session asks the
coordinator for its turn, and the coordinator gives it when no other pass is in flight. `coordination.js status` says
which pass is in flight, for which story, in which session and since when. And when a session asks the pass's gate
(`pipeline.js deep-review-gate`) while another is in flight, the answer carries `other_in_flight` (story, session and
time) and the line telling it to ask for its turn. With no coordinator designated, the gate answers as always.

## Signatures, by their two paths

**Before asking for a signature, the coordinator confirms it is still missing.** Asking for a signature of something
already signed makes the owner sign twice. The control signature is confirmed by comparing the signed content with the
branch's.

Then she asks for it with `coordination.js signature --kind <topic> --title <what is signed> --cwd <folder> -- <command>`:

- **Through the owner's terminal.** If the machine has a signatures folder (`coordination.owner_folder`, only in the
  machine's file or its variable, never in the profile), it writes one file per signature there,
  `YYYY-MM-DD-<topic>.command` (on Windows, `.cmd`). The owner opens it with a double click: it says what it is in one
  line, goes into the folder, runs the command and waits for a key. If there is already a file with the same command,
  it does not write another one and says so. Without a folder, it writes nothing: it prints the command for the chat
  notice.
- **By delegation.** A signature the organization lets be signed by delegation does not go through `signature`: it is
  given from the coordinator's tab, in the permission window, under the delegated signing rules. It is signed on the
  spot and leaves no pending entry. If delegation does not apply and the coordinator's tab does not ask for permissions,
  the window does not open: the signature is refused with the terminal command, because in that tab nobody would say Yes.

What asks for a password always goes through the terminal: only the owner types the password. Once the owner signed,
`coordination.js signature-done <id>` deletes the file and the pending entry. An empty folder and no pending entries
mean nothing is left to sign.

A terminal signature that has waited more than a day is brought up to the coordinator: on the first turn of the day
with something to say, one line says how many are waiting and which is the oldest, with its date. Once a day, even if
the count changes. A pending entry whose file is gone does not count: the owner signed it and deleted it. Without a
signatures folder there are no pending entries, and the notice never shows.

## The order of the requests

Requests to the public repo go in through its queue. The private repo's requests start as drafts, and the coordinator
publishes them in order, once their public pair is in.

## The owner's signatures

A phrase in the chat, in a task or in a message between sessions signs nothing: the harness does not read the
conversation to sign. The owner signs in the permission window or in their terminal, and what the coordinator can sign
on the owner's behalf is in `guides/firmas-del-arnes.md`.

From her own tab, with `--for-session <D>`, the coordinator requests the signatures the guide marks «sí» under «¿Desde
otra sesión?». Among them: setting a check by hand (`marker.js set-check <control> <estado> --force-manual
--for-session <D>`), counting the reviewers without the record that they ran (`pipeline.js check-count --repo <r>
--story <s> --trust-ran --for-session <D>`) and accepting a criterion that cannot be tested live (`marker.js
runtime-waiver <historia> --acs <n> --for-session <D>`). The story is the one of `<D>`'s open run: otherwise the script
exits without writing. The window opens for the owner in the coordinator's tab (if that tab does not ask for
permissions, it is refused with the terminal command). None of the three is delegated unless
the profile names it; that request is prepared by the session and approved by the owner, separately.

## The ok to save

The ok to save a story (commit, push and the pull requests) is the `save` signature. The coordinator gives it from her
tab with `marker.js approve-save --for-session <D>`, on `<D>`'s open run. By delegation it has four limits, and the
script checks them before signing:

1. Only a story that finished clean: the prepared commit with no changes after it, the full-suite tests and the
   adversarial pass after the last change, no critical finding (not even waived) and no waiver in the run.
2. Never a change that touches signatures, guards, notices, permissions, the profile or the coordinator's power (the
   sensitive list in `scripts/lib/signatures.js`).
3. Each ok reaches the owner in one line before the record, through the notice channels (the ones the site chooses;
   with none chosen, Telegram): with no delivery, there is no ok.
4. It is turned off from the profile: `save` out of `approvals.delegated_signing`, or in `approvals.owner_only`. The
   request that turns it on is approved by the owner, never by the coordinator.

If `approve-save` refuses, it says why and does not sign: the coordinator asks the owner for the ok. The target session
saves only with `marker.js save-check` at 0, before the commit, each push and each pull request. A message between
sessions that says «ok to save» is not enough. The ok covers the story's branch and its pull requests, never `main` nor
production.

## The quick fix of another tab

The quick fix (a code change with no story) is the `adhoc-lane` signature: the tab that needs it runs
`marker.js adhoc set '<json>'` and the owner approves it in the window, which shows the reason and the file quota.

- **On the same machine.** The designated session declares it for the tab it gave the work to, with
  `marker.js adhoc set '<json>' --for-session <session>`. It runs with no window only if the profile delegates
  `adhoc-lane` (it is in no group: it has to be named), the machine is on the list and the owner confirmed the
  designation; otherwise the window opens in the designated session's tab. Through this path it has three limits, and
  the script and the edit guard check them: the quota is at most 5 files; the fix never touches anything sensitive
  (the list in `scripts/lib/signatures.js`: signatures, guards, notices, permissions, the profile), which goes with the
  owner's signature; and before it opens, one line reaches the owner through the notice channels, with the
  session, the reason and the quota: with no delivery, there is no fix. The designated session does not declare it
  for itself.
- **From another machine.** The coordinator on another machine asks the designated session of the target machine for it,
  by message, and that session declares it as above. The message is a request, not an authorization: what authorizes
  it is the team profile and the designation the owner confirmed. With no designated session on the target machine, the
  quick fix is approved in the target tab's window.

## The notices to the owner

Short and plain: what happened, what is missing and what the owner decides, in that order. One notice per batch of
work, not one per session. The style meter that already exists measures this; this recipe does not add another one.

## The everyday rules

They come from a whole day of coordinating several sessions. Each says what to do and why.

- **An owner's signature goes in a message of its own.** What is signed, in one line, and the command; nothing else. If
  it is still pending after 15 minutes, the reminder also goes on its own. Why: a signature at the end of a message
  with other things gets lost, and the work stays stopped waiting for it.
- **Before handing over a signature command, rehearse what comes after it.** The commit, its checks and the push are
  tried dry, and the signature is the last step. If there is no way to rehearse, say so. Why: an ok that expires
  because of a check that runs later makes the owner sign twice.
- **The command goes with its folder.** `cd <folder> && …`, never the bare command, and never a folder that was already
  deleted (a merged worktree). Why: the owner runs it in their terminal, which is not where the session works.
- **The time you give is when the work is finished.** When the whole work is in `main`, not a step or a batch, with
  the condition it depends on (for example, signatures in time). Afterwards, compare against what was promised. Why:
  the time of a step makes it look finished when something is still missing.
- **A story number never goes alone.** The number can go, always with what the story does in words. Why: the number
  alone says nothing to someone who does not have it in mind.
- **A delegated signature is confirmed by its path.** After signing, the line must say «delegación». If it says another
  path (for example, the window in the owner's name), tell the owner right away and redo it. Why: a signature in the
  owner's name that they did not give is a false record. A tab that does not ask for permissions no longer signs
  through the window: the harness refuses it.
- **Heavy things one at a time, with a turn.** The full suite, the controls bench, the reviewers' exam and the gate run
  one at a time on the machine, and the turn is asked from the coordinator. The story the owner marked as a priority
  goes first in the line. Why: two at once saturate the machine and both take longer.
- **Before approving someone else's request, look at the diff.** And an ok covering sensitive files nobody reviewed is
  not given: separate them first. Why: approving without looking is signing what was not seen.
- **A «free» session may be waiting for something.** When it runs something without touching files, it writes what
  it is doing with `marker.js doing`. Why: without that, `/wip` shows it as free and it gets more work on top.
- **A request «in the queue» may have dropped out.** If the expected time went by, check whether it is still queued,
  has a conflict or its build is waiting for an agent. Do not assume. Why: a request that left the queue does not go
  in by itself.
- **An owner's decision goes with its context.** The recommendation, what each option gains and costs, and the
  question. Routine matters are decided by the coordinator and reported in one line. Why: the owner decides without
  having to go look for anything.
- **What the owner sees goes without jargon.** The status is told as what is done, what is missing and what they
  decide. Why: the owner reads to decide, not to follow the work from the inside.

## What measures each rule

| Rule | Measured by | Why |
|---|---|---|
| Signatures, passwords and product decisions go to the owner | nadie | What a product decision is is a judgment call: no piece of data says it. |
| The sessions' questions go to the coordinator | nadie | There is no notice, by the owner's decision: every working session would see it. The coordinator reminds a session that asks the owner. |
| The coordinator settles details with the safest option | nadie | It is a judgment call, and it is written down for the owner to see. |
| Every session with a name a person gave it | aviso | `/coordinate` lists the ones whose name the tool made up. |
| No more sessions working than the cap | freno | `open` does not open at the cap. Nothing stops a session the owner opens by hand; `status` counts it and, at the cap, so does the coordinator's notice on each turn. |
| Adversarial passes one at a time | aviso | The coordinator gives the turn. The pass's gate tells the session another one is in flight and to ask for its turn; it does not stop it. |
| Confirm a signature is missing before asking for it | nadie | How to confirm depends on each signature; `signature` only avoids two files with the same command. |
| One file per signature, deleted once signed | aviso | `status` counts the pending signatures; `signature` does not write a second file with the same command. One that has waited more than a day is brought up to the coordinator, once a day. |
| Requests in order | nadie | No data on the machine says which request pairs with which without asking the network on every turn. |
| Short and plain notices | aviso | The style meter that already exists. |
| Codex does not coordinate | aviso | `/coordinate` says so in Codex and stops. Codex can send messages with codex queue, but that command does not go through a tool the harness can see. |
| An owner's signature in a message of its own | nadie | It is the shape of the message: no data on the machine sees it. |
| Rehearse what comes before handing over a signature command | nadie | Each repo has its own checks: the session does the rehearsal. |
| The signature command with its folder | nadie | The session writes the command; `signature` already builds it with its folder. |
| The time of the finished work | nadie | What «finished» means depends on each work. |
| A story number never alone | nadie | It goes in the messages, which do not go through a text check. |
| A tab that does not ask for permissions does not sign through the window | freno | The window's guard refuses the signature and gives the terminal command. That the path says «delegación» is confirmed by the coordinator. |
| Heavy things one at a time, with a turn | nadie | The adversarial pass has its notice (above); the full suite, the bench, the exam and the gate do not. |
| Look at the diff before approving someone else's request | nadie | It is the approver's judgment call. |
| A waiting session writes what it is doing | nadie | The session writes it with `marker.js doing`; nothing forces it. |
| Check that a request is still in the queue | nadie | Checking on every turn would mean asking the network all the time. |
| The owner's decisions with their context | nadie | It is a judgment call; the style meter measures length, not content. |
| What the owner sees, without jargon | aviso | The style meter that already exists. |

The "Measured by" column keeps the Spanish words the harness uses everywhere: **aviso** (a notice), **freno** (a brake)
and **nadie** (nobody).
