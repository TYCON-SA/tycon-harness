# Coordinating several sessions on one machine

This guide is for an organization that works with several agent sessions at once on the same machine and wants one of
them, **the coordinator**, to organize the rest. The coordinator decides what is not the owner's to decide, opens and
names the sessions, keeps the machine from being overloaded, and passes the owner only what is theirs.

It is a recipe, not a mode: nothing changes on a machine where nobody designated a coordinator. For her to organize, one
step is enough: on each machine, the owner asks the chosen session to be the coordinator, that session runs
`marker.js designate-relay` and the owner clicks in the box.

The coordinator does two things, and only the second needs the team profile:

1. **Organizing**: opening and naming sessions, the cap, the turns for heavy work, the notices, the waits and
   `/coordinate`. It works on the minimal install: without a profile, the role is called «coordinadora» (or
   «coordinator»).
2. **Signing for the owner**: passing the owner's signatures to other sessions and signing the routine ones the
   organization delegates. It needs the team profile to name the role in `approvals.relay_session` (on the site, the
   Configuration tab, "Who authorizes skipping a control") and the owner to confirm the designation. **Without a team
   profile the coordinator organizes and does not sign**: everything she would sign goes to the owner's window, and
   `confirm-designation` refuses. If the organization removes the key from the profile, an old confirmation stops
   counting.

How she is named: on each machine, the owner asks the chosen session, in their own words, to be the coordinator. That
session runs `marker.js designate-relay` with no sentence: the guard gives a box with "Sí" and "No" that says which
session it is and in which folder, and with the owner's click it is named (with the profile, also confirmed; without
it, she organizes and does not sign). The harness
does not read the sentence. To stop being it, `marker.js withdraw-relay`, with its own box. Both signatures belong only
to the owner, with a click in that session's tab: they are never delegated. If another coordinator opened that session
in the background (`coordination.js open`), the box is still shown in its tab and the session tells the coordinator
that opened it: the owner answers there or through remote control. Where the click cannot be checked, the
command says why and gives the fallbacks: the owner's terminal (`designate-relay --terminal`) or the sentence
(`--quote`, then `confirm-designation`).

A sentence designation of ANOTHER session, written when there is already a confirmed coordinator, does not replace her:
it stays **unconfirmed** until the owner confirms it (`confirm-designation`, from either session's tab), and
`/coordinate` says so («Designación sin confirmar: …»). Without `approvals.relay_session` in the profile that designation
could never be confirmed, so it is not written: the confirmed one is withdrawn first. If the coordinator is no longer
alive (her tab was closed), another session withdraws her with `marker.js withdraw-relay --session <her id>`, with the
owner's click; the command refuses if the session list cannot be read cleanly or if that session is still alive.

On being designated, the session is told to read this guide, and it is told again after compacting or clearing its
conversation, because that is when it gets lost. **Clearing the conversation takes away the designation**: for the harness
it is another conversation. The session is told how to get it back, but does not get it back by itself: the owner has to
ask again and give a new click. `/coordinate` in that session shows the machine's status. The program the
coordinator uses is `<harness>/scripts/tools/coordination.js`.

## The mother rule: the coordinator improves her own process

**The coordinator reviews her own process without being asked.** When a step repeats, queues up or yields little
(review rounds, repeated signatures, repeated passes, waits, routine approvals), she measures it: how many times, how
much time, how many tokens and what it found. She brings it to the hourly batch with the proposed cut and the data. If
the cut is in her hands, she applies it and says so; if not, she proposes it with her recommendation. Every batch carries
the section "what cost too much and what I changed", even if it says nothing.

## What goes to the owner

Four things go to the owner, always the same ones:

- **Signatures**: what the harness asks a person to sign (for example, control changes).
- **Passwords**: what asks for the machine's password (for example, reinstalling the production brake).
- **Product decisions**: what gets built, for whom, and in what order of priority.
- **What leaves the house**: what goes to production for a product and what is sent to a client or to someone outside. It
  does not include routine work: queuing requests of the harness itself, or publishing material already approved.

The coordinator decides everything else. The other sessions ask her, not the owner: that way the owner does not have
to repeat each session's context.

## How the coordinator decides

- She approves the sessions' plans, by delegation from the owner, and says so in the approval.
- On a matter of detail she picks the safest option and writes down what she picked and why.
- She asks the owner only what the previous section lists, with the whole context and a recommendation: the owner does
  not have to look anything up to decide.
- She does not ask the owner for something she can find out or do: first she looks at the code, the logs and the
  machine's status, and tries to do it herself with what she already has.
- She does not approve any change that gives her more power. For example, the request to the team profile that adds
  signatures to what she can sign is approved by the owner: approving her own power cancels the control.

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

**The names of new sessions.** Without `--name` (or with `--name auto`), `open` takes the first free name from
`coordination.session_names`. Once the list runs out, it goes on with a number: `Tero-2`, `Hornero-2`, and then
`Tero-3`. Without that setting it does not open and asks for the name, as always; that is why «auto» no longer works
as a session name. With `--repo` and no `--branch`, a name that already has a `wt/<name>` branch in the repo is
skipped: the new session does not start on another one's work. Openings go one at a time: if two arrive together, the
second waits for the first to finish, so they do not pick the same name. The key holds the id of a built-in
theme (`animals`, `rivers`, `colors` or `trees`) or a list of your own, in the usual order: the
`TYCON_COORDINATION_SESSION_NAMES` variable wins over the machine and the machine wins over the profile (the variable
takes the same: a theme, or comma-separated names). The
organization's theme is chosen in the Configuration tab of the site («The sessions on each machine»). The built-in themes
ship with the harness, which is published: they carry no real people and no trademarks.

**Each dev's own list is put together by their session, never by the site.** The dev asks for it in the chat in their
own words, for example «name my sessions after the planets». The session builds the list, shows it in full and waits
for their «Approved». With it, the session saves it in THAT machine's settings, comma-separated:
`node scripts/lib/tycon-config.js set coordination.session_names "Mercurio,Venus,Marte"`. A single name takes a
trailing comma (`"Mercurio,"`): without a comma, the text is read as a theme id. Each name goes without spaces
or accents (letters, digits, hyphen or underscore); if the dev asked for something with an accent, the session proposes
it without one. A list with real people or trademarks goes only there: never in the team profile, in a guide or in
anything that gets published. If the production guard installed on the machine predates this key, the command writes
nothing and says how to update it (with `sudo`, it asks for the dev's password): with the key, that guard would say
«configuration BROKEN» in every session. The session hands that command to the dev and saves the list afterwards.

`open` never retries. If the tool refuses because nobody approved the folder, it says in one line which folder the
owner has to open once; meanwhile, the owner opens the session and the coordinator gives it the task. The approval
belongs to a person: the agent does not write it. The other failures also take one line: the launcher is not
installed, the first line of its error, or it did not come back within 30 seconds. A failed opening does not count
toward the cap.

**With `--repo <repo>` instead of `--cwd`, `open` sets up the folder itself.** It creates a sibling copy of the repo,
`<repo>--wt-<name>`, from the tip of `origin/main`, on the branch `wt/<name>` (or the one in `--branch`), and opens the
session there. Claude Code 2.1.312 accepted it without asking if the main folder was approved; since Claude Code 2.1.330
the background session asks to approve each copy separately, even with the main folder approved. It goes beside the
repo, not inside, because of a **measured limit**: approving a folder does not cover the folders inside it, so
each new worktree asks for its own approval. If the copy or the branch already exist, `open` refuses in one line and
does not overwrite what is there. If it cannot fetch `main` or create the copy, it says the first line of the error and
does not open: it never starts from an old tip without saying so. If the launcher answers that the folder is not
approved, `open` keeps the copy and its branch, and says in one line that this copy (not the main folder) is not
approved, with what Claude Code answered: a person approves it once (`cd` to the copy and `claude`) and the session is
opened again there with the same name and `--reuse`. With `--reuse`, `open` creates nothing: it reuses the copy with
that name on the job's branch, and does not open if a live session is inside it. Any other launcher failure removes the
copy and the branch it just created. The task tells the session to leave everything committed, pushed and with its
request open when it is done. The copy is not removed when the session closes: the copy sweep takes it out, like any
other, once its branch got into `main`.

To get a machine ready before the first opening, `node scripts/tools/prepare-machine.js --repo <repo>` says one at a
time what is missing (the main folder not approved, an old guard, the coordinator's confirmation) and with which
command. It only reads: it approves nothing and does not ask for the password.

**Not measured yet, left as the owner's test:** how long a session opened in the background takes to show up, and what
title the editor tab shows after `/rename`. The guide takes neither for granted.

**The opened session starts like the coordinator.** It runs in the same permission mode as the coordinator and with
remote control under its name, so the owner can see it and drive it from claude.ai/code or the phone. With different
modes, the new session gets stuck on a permission prompt nobody sees, and the messages from the other sessions are held
back from it; if the owner is also away from the machine, they cannot go in with `claude attach`.

`open` does it by itself: it reads the coordinator's mode and launches the session with `--permission-mode <that mode>`
and `--remote-control <name>`. The mode is not chosen: `open` does not accept `--permission-mode`, so it never opens a
session with more permissions than the coordinator. It does not open, and says so in one line, if it cannot tell the
mode or if the coordinator is in plan mode (the new session would wait for someone to approve its plan). The mode comes
from the coordinator's conversation, which records it with each of the person's messages; the whole conversation is
searched, so it is also found for a coordinator working alone, with no message from the owner for hours. **Known limit:** if someone
changes its mode with Shift+Tab and sends no message afterwards, `open` copies the previous mode. A session opened by
hand, or before this change, that got stuck like that, the coordinator stops and relaunches:
`claude --bg --resume <id> -n <name> --permission-mode <its mode> --remote-control <name> -- <task>` (relaunched that
way it is not recorded as opened by the coordinator). To stop a
background session, use `coordination.js stop --name <name>`: it looks up the background id that the session recorded
and runs `claude stop` with it. It removes nothing, and the session is resumed with `coordination.js relaunch --id <id>`. By hand,
`claude stop <id>` and `claude rm <id>` need the id that `claude agents` shows: neither the name nor the ref that
ListAgents shows (the six characters in brackets) works, and they answer that they cannot find it (measured on
2026-11-01 and 2026-11-15).

`open` passes the task to the launcher as is, without reviewing it: nothing it says signs anything (see «The owner's
signatures»).

With Codex, the owner opens the sessions: Codex has no launcher for named background sessions.

### What the coordinator sees of Codex

Measured with Codex 0.162.1. The coordinator runs in Claude Code; from there:

- **It sees Codex sessions by their activity**, from the Codex database. It does not know whether one is waiting for a
  permission: with the permission prompt open, Codex writes it neither in the database nor in the session's log. So
  `status` says "no sé si espera un permiso" (I don't know whether it waits for a permission) on every Codex session.
  `codex agents` is a screen for a person: a command cannot read it.
- **It can leave them a message** with `codex queue --thread <id> --message <text>`. It stays in the Codex queue.
  Whether an open session reads it was not measured. A finished session also answers "Queued", without an error.
- **A Codex session's permission does not reach it**: it is answered in the Codex tab. What Codex brings for that
  (`exec_permission_approvals`, `request_permissions_tool`) is under development and off. Codex signatures still go
  through the terminal.
- **Codex's automatic permission review** (`approvals_reviewer = "auto_review"`) could not be compared with Claude's
  automatic mode: in the test, Codex did not ask for permission and the sandbox denied the command.

### The `--slot` option: fixed work slots

Claude Code 2.1.330 asks to approve each copy, even with the main folder approved. To avoid approving a new folder for
each job there is `open --repo <repo> --slot`: instead of creating a copy, it takes a free fixed slot of the repo and
opens the session there, on the job's branch. There are as many slots as the cap and they are always the same folders,
so the owner approves them only once: `node scripts/tools/work-slots.js pending-trust` lists, each with its `cd`, those
with no approval in sight, and `prepare-machine.js` names them all in one note. What counts is the slot's own recorded
approval or a background session that already opened there (`open` records it, and drops it if Claude Code later says
no); the main folder's does not count, and with neither it says it does not know instead of taking it as approved.
Without `--slot`, `open` still uses a free slot where a session already opened before creating a new copy, and says so in
its message; if there is none, it creates the copy as always. With no free slot, `open --slot` says so
and does not open. The task tells the session how to release the slot when it is done. If the launcher answers that the
slot is not approved, the slot stays taken with its branch and is retried with `--slot --reuse`, or released with
`release`; on any other failure it is free again. On closing, a slot is released, not deleted. Nothing creates slots
unless asked. What they are: `guides/git-worktrees.md` §8.

## Closing a session

The coordinator, or a person in their terminal, closes a session with `coordination.js close --name <name>`. Before
closing it checks four things, and if one is missing it does not close and says which:

1. That it is idle: one running a command is not closed either.
2. That its folder has nothing uncommitted or unpushed.
3. That its branch got into `main`, and so did the branches it left in that folder since it started. A sibling copy is
   checked like any working folder and is not removed on closing; with `--slot`, the slot has to be released.
4. That it has no open run and no open quick fix.

What it cannot look at (a folder it did not record or that is gone, git not answering, an unreadable record) comes out
as «no sé» (I don't know), and it does not close either. With everything clean it runs `claude stop` and `claude rm`
with the session's id.

**An interactive session is not closed.** It is checked all the same and it says so: a person closes that tab.

**Stopping is not closing.** `coordination.js stop --name <name>` stops a background session without checking whether
it is clean and without removing it; the same rule on who can. It is resumed with `coordination.js relaunch --id <id>`: it
runs `claude respawn`, waits to see it alive and records it as opened by the coordinator, like `open`. Relaunched by hand
with `claude respawn <id>`, it is not recorded, and its routine signatures fall into the owner's list.

**Limits.** It looks at the folder the session is in now: it does not see another worktree the session left behind, nor
what was kept with `git stash`. A branch deleted without merging is no longer seen. A branch squashed into one commit
reads as not merged. A worktree of a repo with no working folder comes out as «no sé». `claude stop` and `claude rm` by hand do not go through this.

### Finished but left open

A run with every step done stays open until `marker.js clear`, and a shortcut lane until `marker.js adhoc clear`. The
harness warns about it; it never closes it on its own, because it does not know which is the last push or the last pull
request, and closing too early loses the run.

- **At the end of every turn**, the session sees one line: the run of story <id> finished <time> ago and is still open,
  or the shortcut lane «<reason>» has its pull request <N> open (or its branch already in main) and is still open. If
  code changed after the reviewers, the line says it still needs reviewing, not closing. It does not block the turn.
- **When a session starts**, a notice lists what the whole machine has in that state, up to five, with its session and
  how to close it. If the session is alive, it closes it itself. If it died, the notice gives
  `marker.js clear-session <session>`, or `adhoc clear-orphan <session>` for a shortcut lane. If its run is lost, it gives
  `clear-session <session> --lost`, which the owner signs. If it cannot tell whether the session is alive (Codex leaves
  no session record), it says so and gives no command.
- **At startup, also the work folders with uncommitted changes**: each worktree of the harness repos and of the repos
  root with uncommitted changes and no live session inside, with its branch, how many files and how long nobody has
  touched them. It changes nothing. `TYCON_UNSAVED_FOLDERS=0` turns it off.
- **In the office and in `/wip`** the session shows «Terminado, falta cerrar» (finished, still to close), with the story
  and since when, also after a day. It does not count as working; if the session is busy with something else, it shows as working.

What the coordinator does: asks that session to close after its last push and its last pull request. If the session
died, it runs the command from the notice; the `--lost` one goes to the owner.

## The cap: what counts as working

**Working** is a live session whose session file says it is busy. A session waiting for CI, the queue or the owner has
finished its turn: it does not count. Codex sessions do not write that file; they count if they had activity in the
last 5 minutes. A session that `open` opened less than 10 minutes ago counts even if it has not written its file yet.

The cap is `coordination.max_working`, from 1 to 20. The team profile gives the organization's number (on the site,
Configuration tab, "The sessions on each machine"), and each machine can change it for itself, because how much it
can take depends on the machine. With no value anywhere, the cap is 3. `coordination.js status` shows who is working,
who is waiting and why, and the cap with where it comes from.

**The second cap: what is waiting for the person's review.** The first cap measures what the machine can take; this one,
what a person can review. It counts four things, only reading: the signatures waiting for the person (not the delegated
ones), the runs and shortcut paths finished without closing, the folders with uncommitted changes and no session (except
the test copies of a background job, under `~/.claude/jobs/`) and the pull requests stuck for an hour or more (not a
draft, unless it has conflicts). A live session waiting for the person does not add on its own: it is already in one of
those. The cap is `coordination.max_awaiting_review`, from 1 to 50, in the same order as the others; with no value
anywhere, 8. It comes in **warning mode**: with the review load at the cap, `open` and the background-session brake still
open, say so and leave a `review-cap` line in `gates.log`, so moving to a brake is decided with numbers; moving to a brake
is a commit that changes a constant, no variable changes it. What could not be read (because of the 4 s time limit, or a
broken source) does not add up and does not stop anything. The brake that does not leave the machine empty does not push
to open with the review full. The snapshot each session start leaves is shown by `status`, `/wip` and the coordinator's
notice, with its age; deciding counts again, never from the snapshot.

### How many stories at once, who launches the heavy work and when the owner is written to

Four rules for the coordinator, for any organization:

- **A cap on stories in the full cycle.** A story is in the cycle from the moment it starts until it lands on `main`.
  With the cap full, the coordinator neither starts nor resumes another one until one lands: the rest wait in line with
  `marker.js park --queue`. The cap is `coordination.max_stories_in_cycle`, from 1 to 20; with no value anywhere, 4. It
  follows the same order as `coordination.max_working`: the variable (`TYCON_COORDINATION_MAX_STORIES_IN_CYCLE`), the
  machine (`tycon-config.js set`) and the team profile. `coordination.js status` shows it with its origin. Today it is a
  rule the coordinator follows: no brake measures it.
- **Sessions launch the heavy work directly, and the harness decides.** A session that has to run the tests or the pass
  launches them without asking the coordinator: the harness says whether there is room (the machine's turn) and, if not,
  when to come back. The coordinator does not hand out turns: she only tells when the place frees up.
- **To the owner, one message per hour with what is theirs; what blocks, at once.** What waits for their signature or
  decision without blocking anyone goes together, in one message per hour. What blocks the work (a signature without
  which a session cannot go on, a red control nobody can unblock) is told right away.
- **What comes from the same case goes together.** If a report or a case brings a main fix and minor annoyances from the
  same use, the coordinator assigns them all in the same session, not the main one now and the minor ones later. Only
  what affects other people or teams stays out, such as another product's pipeline: that goes to the owner as a separate
  decision.

The cap brakes on every path the agent takes, not only through `open`. Before each command, a brake checks whether the
command opens a background Claude session: `claude --bg`, or `claude` running in the background (`&`, `nohup`, `setsid`,
`tmux new -d`, `screen -dm`, `Start-Process`, the tool's background execution), also wrapped in `env`, `sudo`,
`bash -c`, `pwsh -c` or `cmd /c`. If it opens one and the machine is at the cap, it refuses and gives the `open` command,
which waits its turn. It counts with the same function as `open`. Below the cap it lets the command through and records
the session, so it counts from that moment. If it cannot count (a state file that cannot be read) or cannot record the
session, it refuses as well and names the file. The way out is fixing that file, or the person opening the session from
their terminal: the brake only watches the agent's tools. It has no switch: a person changes the cap.

The coordinator also sees it without asking: when the machine reaches the cap or the number working changes, a notice
tells her who is working; if it is over, by how much and which one has been working the shortest. The line goes out once
per change, not on every turn: it goes out again if the count or the cap changes, if the machine drops below the cap and
comes back, or on another coordinator's first turn. If it cannot note that it already warned, it goes out on every turn
and says so. Below the cap it says nothing about that, and no other session sees it. It is turned off with `TYCON_COORDINATION_NOTICE=0`.

The same notice carries two more things:

- **Background sessions sitting idle.** A background session that has gone more than 15 minutes without working shows up
  as "X has been idle for N min: close it or give it work". Not one waiting for its adversarial pass, one that recently
  noted what it is doing (`marker.js doing`), or the one holding the machine's full suite.
- **The session that says it is working and does not write.** A "working" session that has not taken a step of its own in an
  hour (a message reaching it does not count), has no background command running and runs no agent (none wrote in 20 minutes) shows up as "X dice que trabaja, pero no escribe hace N min y no
  corre nada (su último paso: …): ¿trabada?". `owner-wait` says it once per session. Why: a command does not go past 10
  minutes, so an hour of silence with no agents is a stuck session, and in the office it looked the same as one at work.
- **Ready requests nobody queued, on GitHub.** An open, clean request (no conflict and no required checks pending) with no
  auto-merge and outside the queue, unchanged for more than 10 minutes, shows up with the command to queue it. Why: nobody is
  going to merge it, and everyone thinks it already went in. It comes from the last saved reading, less than an hour old: the
  notice does not go to the network. Requests from a bot do not show up. Not on Azure: without reading its checks, "clean"
  only says it does not conflict.
- **The session waiting for room for its pass.** It has to launch one and another holds the place: it shows up with who holds
  it, and once freed, with "can launch". Nothing wakes it by itself: the coordinator tells it.
- **The full-suite queue, stalled.** If no full suite is running and some session noted that it waits for its turn
  (`marker.js doing --waiting-for` with «suite», «portón» or «turno»), it shows "no corre ninguna suite completa y hay N
  esperando turno: dale el «arrancá» a X", with X the one waiting longest. Without that note it does not show: an idle
  session is not waiting for its turn. Waiting for a pass does not count: the notice above wakes the session that owes its pass.
  `status` shows the whole queue.

**With a free slot, free memory and ready work, the turn does not close.** A turn-closing brake
(`coordination-fill-gate.js`), only for the designated coordinator: if there is a free slot (the others working plus the
coordinator, below the cap: the same count as `open`), free memory is at 40 % or more and there is at least one ready
story without a session from her project (`ready-for-dev` in the office's project reading, with no open dependencies, no
pause and no run on this machine), the turn does not close: the brake says what there is and asks to open a session or
to write down why not, with `coordination.js keep-free --reason "<why>"`. The reason lasts 30 min and covers only the
ready work it saw: a new story voids it; three blocks in a row and on the fourth close the brake lets the turn end and
notes it as «cerró sin abrir ni motivo», which counts and shows like a reason (in `/wip`, «Lugares libres a propósito»,
and in the office). With the project reading stale the brake does not block for stories and sends it to refresh in the
background; unable to read the machine's state or to measure memory, it does not block either. Stopped runs are not
included: the long-queue notice keeps proposing them. It has no switch: the way out is the reason, which stays written.

## Heavy work takes turns: the full suite and adversarial passes

The machine runs **one adversarial pass at a time**, and never beside a large test run (the full gate, of 100 suites or
more, or the portable run). Up to **two large runs** go at once, the second only with free memory (below). The pass's
hunters and verifiers run their probes on the machine, not in the cloud: a pass and a large suite together used up the
memory and Claude Code closed sessions. The reviewers, the bench and the exam are calls to the model and ask for no turn.
The harness controls this, not anyone's memory:

- **A scoped gate does run beside the pass.** One of 40 suites or fewer runs with a pass in flight, one at a time and
  with the system's free memory at 40 % or more. It asks the coordinator for no turn: the harness decides when it starts
  (`heavy-turn.js besidePass`). Measured on 15/11: the pass weighs about as much as one more session (~0.5 GB), a gate
  running 4 at a time about the same, and a gate of up to 40 suites takes less time than a pass. With more than 40
  suites, with another gate already beside it, or with less free memory, the gate waits for the pass (it exits 75 and
  says why). Memory is checked once, at the start; if it cannot be measured, it does not stop the gate, and that is said.

- **Two large runs at once, with free memory.** The turn (`scripts/tools/heavy-turn.js`) is requested by the suite runner,
  when it is about to run 100 suites or more, scoped or not, by the whole portable run and by the quick suite at startup.
  Below 100 suites it is not requested. The turn has two places: with none running, one is taken; with one running, the
  second starts only with the system's free memory at the floor or above, 50 % unless someone changes it. Below it, or
  when memory cannot be measured, one: the test gate exits 75 (its "wait") and says who is running, the measured memory,
  the floor with its origin and how to free it. With two running, the third waits too. Memory is measured once, at the
  start: the run already going is not cut if it drops later. With a pass in flight from any live session, the own one
  too, none runs, and they say which story, which session and since when: never beside the pass, because the turn
  belongs to the machine, not to the session. The floor is changed with `coordination.second_heavy_min_free_pct` (1 to
  100; with 100 the machine keeps one turn): on this machine with `tycon-config.js set`, for one session with the
  `TYCON_COORDINATION_SECOND_HEAVY_MIN_FREE_PCT` variable, or in the team profile once every machine has this version (an
  older one would read the key as unknown). The 50 comes from what was measured on 15/11 on 16 GB: two gates running 4
  at a time add up to ~2.4 GB at peak, and from half free the machine stays near 35 %, far from the 28 % at which
  sessions were closed. The runner uses the `heavy-turn.js` of the repo it tests: a copy from before this change still
  asks for a single turn.
- **The pass is not launched with the machine busy.** With another pass in flight, a large run going, or a scoped gate
  that cannot go beside it (more than 40 suites, two gates, or free memory under 40 %), the pass's gate
  (`pipeline.js deep-review-gate`) exits 3, and `pipeline.js next` asks to wait instead of launching. The answer carries
  `other_in_flight` (story, session and time), `heavy_run` (session, how many suites and since when) or `gates_running`
  (session, suites and time of each gate), and the line saying who holds the place. Beside a single gate of up to 40
  suites, with free memory, the pass launches. The pass of a closed session does not count.
- **How each one frees up.** The large run releases its turn when it ends; the turn of a dead process, or one older than
  three hours, frees itself. That is why `heavy-turn.js take` asks for `--process <pid>`, the process that runs the heavy
  work (in a script, `$$`): without it, the turn would be tied to the command's shell, which ends right away, and it
  would free itself with nobody noticing. `release` asks for the same one. The pass has no turn file: it holds the
  machine from its launch until its session notes the result (`marker.js mark-adversarial-result`, with any verdict, `no-medido` too) or the skip
  (`marker.js mark-adversarial-skipped`). Relaunched, it holds it again. A session that closed frees it, and after an hour
  it no longer stops anything, because it may be finished or stuck, and that is said.
- **A free turn is not taken on its own: the «arrancá».** With a coordinator designated and alive, a gate that got a
  «wait» (its 77) is noted in the queue (`coordination/suite-waits/<session>.json`) and, when the turn frees up, does not
  take it on its next try: it waits for the «arrancá». Why: on 13/11 a waiting gate took the turn as soon as it freed
  up, on top of reviewers the coordinator had already launched. The «arrancá» is a command, `heavy-turn.js grant --to
  <session>` (the id, its start or the session's name), and only the coordinator gives it; the notice's queue line
  carries it whole. It holds for both places of the turn. While it is in force no other session takes the free turn; it
  expires after 10 minutes if its session does not take it, or when that session closes, and the queue moves to the next
  one. A session that never got a «wait» takes a free turn as always. A noted wait lasts three hours. The startup quick
  suite is not a gate: it is not noted and does not spend its session's «arrancá». If the coordinator closes or stops
  being designated, everything goes back to as always: the waiting gate takes the free turn.
- **The reservation, for what asks for no turn.** Reviewers and the pass are launched by the coordinator and have no
  process that takes the turn. Before launching them, `heavy-turn.js reserve --for "<what>"` takes the turn in that
  name: a gate that asks for it gets the «wait» with the reservation's name. With a large run going it does not reserve
  (it exits 77 and says who holds it). `heavy-turn.js release --reserve` frees it; it expires after 90 minutes (a round of
  reviewers or a pass; the three hours are a suite's) and, if the coordinator's session closed, after 10. With
  `--to <session>`, the reservation belongs to that session: it launches what was reserved (its pass without the
  pipeline, the next point) and its gate takes the turn with no separate «go», even if it was in the queue. It is for
  one thing at a time: if its gate is already running, the pass hook warns; with the pass in flight nothing stops its
  gate, so the session does not run it until the pass ends. Other sessions wait until it is released.
- **The pass without the pipeline also asks for the turn.** A session without a pipeline run (one the coordinator
  opened for a fix, or a loose one) launches its pass with the Agent or Workflow tool, with no marker to count it. On
  23/11 at 05:45, with several of those at once, the machine ran out of processes. The `agile-pass-turn.js` hook looks
  at each launch: every Workflow (the fan-out of agents that fills the machine) and an Agent whose description or type
  says adversarial (small reviewers and searches do not count; the request text is not read). If the session has neither the «go» (`grant --to`) nor a
  reservation for it (`reserve --for "<what>" --to <session>`), or if its gate already runs with that reservation, it
  warns the session and the person who holds the turn, and logs it in `gates.log` (`agile-pass-turn`). Today it only warns: whether it blocks is the owner's call, with that
  measurement (`MODO` in the hook). It does not look without a coordinator, at the coordinator itself, or at a pipeline
  session. `TYCON_AGILE_PASS_TURN=0` turns it off.

`coordination.js status` shows a single line, «Turno de tarea pesada», with who holds it and what it is; with one large
run, whether the second turn is free or closed, with the memory and the floor; with two, both. `heavy-turn.js holders`
lists them. A scoped gate running beside a pass says so in its own line, with how many suites. With no coordinator designated, everything answers as
always: in CI and in the cloud there is no turn. `TYCON_SUITE_TURN=0` turns off the suite's, and `TYCON_SUITE_TURN=1` asks for
it even with no coordinator: it can only stop too much.

### Swap memory

Claude Code closes idle sessions when it runs out of swap memory, even when the system's free memory looks ample: on
14/11 it closed two with the machine at 65 % free and 0.9 GB free of 8 GB of swap. `coordination.js status` reads it
(`sysctl vm.swapusage`, on macOS): with less than 15 % free it says how much is left and names the live sessions that
are not working, those waiting for something first, since those are the ones that get lost. What to do: before
launching anything heavy, close the idle ones that wait for nothing. If it cannot be read (another platform, a command
that fails) it says «no medida» and assumes nothing. Only the `status` command reads it: the per-turn notice and the
closing brake do not measure it. A session Claude Code already closed shows in «Cerradas por Claude Code» with what it was
waiting for (its `marker.js doing --waiting-for` note) and since when, above the others, with its `coordination.js relaunch --id`.

### The user's processes

Each user has a process cap (on macOS, `kern.maxprocperuid`; on the Mac mini, 2666). At the cap no command starts: not
the hooks, not the brakes. It happened on 23/11 at 05:45, with several adversarial passes at
once and a hung test, and the Telegram MCP went down. `coordination.js status` counts the user's processes (`ps -U`): from 70 % of the cap it says how
many there are and what the cap is. What to do: before launching anything heavy (a pass, mutants, a suite), ask for the
passes and background scripts that are not needed to stop. If they cannot be counted (another platform, a command that
fails) it says «no medidos» and assumes nothing; if `ps` cannot start for lack of processes, it says it is at the
cap. Like swap memory, only the `status` command counts them.

## The automatic reviews: what the coordinator does

When each review runs is set by the organization's configuration (`guides/automatic-reviews.en.md`). In each one,
the coordinator:

- **Asks or not.** If the matrix says to ask, she asks the owner, with the options box, and records it: the session
  runs `marker.js review-ask --kind plan|code` before the box, and she records the answer with
  `marker.js review-answer --for-session <session> --kind plan|code --choice review|skip|wait`. On each of her messages,
  the harness shows her the questions without an answer, how many minutes they have been waiting and, past
  `plan_review.owner_away_minutes`, what the «owner away» cell says.
- **Launches the plan review**: `marker.js plan-review --for-session <session>`, with the command it returns (the
  organization's reviewer), and records the result with `--result`.
- **Approves on the owner's behalf only with «approved»** on that same plan, with `plan_review.routine_approval` (O4)
  on `review` and `plan-approval` delegated. Without a coordinator, that same «approved» of the review the session
  launches itself approves the routine plan without a click: it is enough in both cases. With `person`, a routine plan
  is always signed by a person. Rejected or without a verdict, the plan waits. A delicate plan, and its mockup, are signed
  only by the owner with a click or an «approved» (also in the coordinator's tab), even if the profile names
  `plan-approval:delicada`. From that tab the command carries the quote: `marker.js complete-step approve-plan
  --approved '<the person's quote>' --for-session <session>`; without it nothing is signed and no box is shown.
  **The plan she approves is a part's plan**: if the run recorded its batch (`set-batch`) and the part is valid
  (with its `files:` or, without `files:`, with the files the story ties to it plus those it ties to no batch),
  «delicate» is measured on the part, and the plan stays tied to its list: editing code outside it stops, and at the
  close the whole diff is measured; if it comes out delicate, the plan goes back to the owner. The adversarial pass
  still goes by the whole story.
- **Gives the code pass its turn.** She launches nothing for the code: with the owner away, she answers on the owner's
  behalf the question whose cell says `review` (`review-answer --for-session`, with «owner away» as the reason), and the
  session itself launches the pass with its turn, as always. If the cell says `skip`, she records it with `--by-profile`:
  the script checks that the owner counts as away and that the cell says so, and records `por: perfil`. Outside that
  case, a code «skip» is the owner's answer: it asks for the `review-skip` signature, their click or their «approved» in
  your tab, never the delegation.
- **Sets the away mark** when the owner says they are leaving («go on autonomously», «I'm off», «see you tomorrow» or
  similar): `marker.js owner-away set --phrase "<what they said>"`. She judges it, not a list of phrases, but the phrase
  must be in a message the owner typed in her tab in the last 30 minutes: one from another session, a channel or a program
  does not count, and if their messages cannot be read it exits 2. Without the mark, the owner still counts as away after
  the minutes without an answer. The mark clears
  itself when the owner comes back: a message of theirs, a verified office message, a signature of theirs, or after 24
  hours. The office shows it while it is set.

## Signatures, by their three paths

**Before asking for a signature, the coordinator confirms it is still missing.** Asking for a signature of something
already signed makes the owner sign twice. The control signature is confirmed by comparing the signed content with the
branch's.

Then she asks for it through the path that applies:

- **With the owner's click or «aprobado».** Where the window does not reach, this comes first for every signature that
  accepts them. The coordinator shows the options box in her tab, with one question: what is approved, «firma <id>» and,
  if another session signs, «sesión <id>». It leaves no pending entry. The rules are in `guides/owner-signatures.md`,
  «Aprobar sin terminal».
- **Through the owner's terminal**, only what does not accept the click: with `coordination.js signature --kind <topic>
  --title <what is signed> --cwd <folder> -- <command>`. If the machine has a signatures folder (`coordination.owner_folder`, only in the
  machine's file or its variable, never in the profile), it writes one file per signature there,
  `YYYY-MM-DD-<topic>.command` (on Windows, `.cmd`). The owner opens it with a double click: it says what it is in one
  line, goes into the folder, runs the command and waits for a key. If there is already a file with the same command,
  it does not write another one and says so. Without a folder, it writes nothing: it prints the command for the chat
  notice.
- **Routine signatures do not come here.** A signature in `approvals.delegated_signing` is given by the harness on its
  own, in the session that asks for it: it reaches neither the coordinator nor the owner (`guides/owner-signatures.md`,
  «Las firmas de trámite las da el arnés»).
- **By delegation.** A signature the organization lets be signed by delegation does not go through `signature`: it is
  given from the coordinator's tab, in the permission window, under the delegated signing rules. It is signed on the
  spot and leaves no pending entry. If delegation does not apply and the coordinator's tab does not ask for permissions,
  the window does not open, because in that tab nobody would say Yes: the signature is refused, and the refusal says how
  to ask for the click or the «aprobado». Besides routine, the profile can delegate the procedural exceptions
  (`guides/owner-signatures.md`, «Qué excepciones se delegan»). `owner-next` does not give the box for another session's
  signature that the profile delegates to the coordinator, nor for one her tab cannot answer (the click-only ones):
  instead it says the route that works, which is the command with `--for-session` for her to sign it, or the click in
  the tab of the session that asked.

What asks for a password always goes through the terminal: only the owner types the password. Once the owner signed,
`coordination.js signature-done <id>` deletes the file and the pending entry. An empty folder and no pending entries
mean nothing is left to sign.

A terminal signature that has waited more than a day is brought up to the coordinator: on the first turn of the day
with something to say, one line says how many are waiting and which is the oldest, with its date. Once a day, even if
the count changes. A pending entry whose file is gone does not count: the owner signed it and deleted it. Without a
signatures folder there are no pending entries, and the notice never shows.

### Signing rules for every coordinator

The owner signs from the phone, with a click in the coordinator's box. For that to be enough:

- **No script or command for the owner's terminal**, except what cannot be undone: turning off the brake, production
  and an emergency. A session that needs a signature runs the command in its own tab, as is and alone, so the brake
  denies it and writes it down, and tells the coordinator "signature pending".
- **Each signature is a row of the signature list**, and it goes through as a box with `owner-next`, one at a time.
- **Before each box, two lines**: what changes if the owner signs, and the coordinator's recommendation.
- **The plan is not pasted into the chat before its signature.** The plan approval box brings "What it does", the files
  and the path of the full plan, and the click on that box is enough. The full plan is shown only if the owner asks for
  it. A plan without those two sections is shown in full before the box.
- **Signatures and decisions go together, in one batch per hour, and the batch never holds up the work.** What leaves a
  session stopped goes to the owner right away. The rest goes to the batch, and the session keeps going on a marked
  assumption meanwhile. An improvement in the coordinator's hands is applied at once: it does not wait for the batch.
  A session that waits for the owner and has no other work counts as stopped: first the coordinator gives it work from
  the queue, if there is something it can take; if not, the question goes to the owner right away.
- **The background `owner-wait` does not take the click away from the owner**: the brake lets it through if it runs
  exactly as its notice asks. Neither does the read-only watcher of a pull request
  (`coordination.js pr-wait --repo <org/repo> --number <n>`), nor the wait for a story to open its pull request
  (`pr-wait --repo <org/repo> --story <story>`). Both also keep delegated signing possible
  (`guides/owner-signatures.md`, «Aprobar en nombre del dueño»). Any other live background console does stop it: close
  it before asking for the box.
- **A request without code is approved by the coordinator**: if it brings only stories, records, evidence, memory or
  documentation, the coordinator gives on the owner's behalf the two approvals of the merge (the message and the push)
  and shows the owner the list in the hourly batch. With a single code file, both stay with the owner.

### The signature list: written down and, on coming back, one at a time

With `approvals.signature_list` set to `on`, what waits for the person stays written down in a single record, and `/office`
counts it under «Tu firma». **The list does not sign anything:** a click is still good for one signature and one command. There
is no signing in bulk: each row goes through its own box. With `off`, or without the key, it is as if it did not exist. It is
turned on in the profile, or on the machine to try it out.

- **What gets written down.** The brake writes down the signature it denies with its box to the target session itself. No row
  comes from a request run by another session, a delegated signature, «done and notified», an open window,
  `designation-confirm`, anything irreversible or Codex. What `coordination.js signature` leaves goes in the same record.
- **What closes it.** The signature given for that request (same signature, target and command), 24 hours, or its session
  no longer being alive. Using one signature does not close the session's other pending ones: each row waits for its own
  signature. An older signature, or one given in the terminal without `--for-session`, closes as always: the same
  signature for that target, or the pending item's code in its reason. If the sessions cannot be read, it stays.
- **How they go through, with a coordinator.** If the coordinator is confirmed and alive, it passes them all. The background
  session does not show the box or send messages: the brake tells it to wait for the notice. When the person writes, the
  coordinator gets a notice: answer what the person wrote and run `coordination.js owner-next`.
- **Without the list, with a coordinator.** The background session does not send the coordinator the question to copy:
  copied by hand it does not stay the same, and the click does not count. The brake says why the request does not reach
  her list (the list is off, or there is no confirmed, live coordinator) and gives the terminal command. The session tells
  her what is being decided and that command, and does not repeat its command until she says the owner signed.
- **How they go through, without a coordinator.** The target session gets the same notice, once per row, and runs `owner-next`.
  If the person already answered «aprobado» to that box, it does not ask again.
- **What `owner-next` gives.** One row, the oldest: a box to show without changing a letter, with a label («Firma 2/5»), and the
  notice for the target session. **A permission goes first**, with its own counter and box. What goes through the terminal comes
  last, with no box. If the plan has not been seen yet in that tab and does not bring "What it does" and "Files", it
  gives the plan to write out before the box. Below the question it prints the **detail** («Detalle (no va en el
  cuadro; mostralo si la persona lo pide):»): what did not fit in the box, such as the path of the plan or the diff and
  the whole lines. The detail never goes inside the options box and never names the signature's files, which the box
  counts by zone. If the box goes over the phone limit, it adds the line «Este cuadro pasa el tope del teléfono (N de M
  letras)»: it blocks nothing. If a row cannot be shown, or its repetition is denied, `owner-next --after <id>` gives
  the next one.
- **The session that asked always repeats the command**, with or without a coordinator. On «Sí», the coordinator sends it the
  notice and the session repeats the same command within 30 minutes. With an unused click, `owner-next` skips that row and says
  the repetition is missing.
- **On a «No»:** `coordination.js owner-reject <id>` removes the row and names the session to tell. A box that closes or
  resolves by itself leaves the row, and the pass stops there. A background session's permission is different: on «Sí»
  nothing is run, and on «No» its hook denies it by itself ("A background session's permission, as a box", below).
- **What the coordinator signs by delegation.** Since the harness gives the routine signatures, only what is delegable
  and not routine reaches the coordinator. A delegable signature that the working session asked for itself does not
  reach the person: the gate routes it to the coordinator (`guides/owner-signatures.md`, «Aprobar en nombre del dueño»).
  The notice counts it apart («N firmas las firmás vos por delegación»), and `owner-wait` announces it to her once.
  `owner-next` gives no box: it gives the command to run in her tab («Firmala vos por delegación, en tu pestaña, desde
  <folder>: <command>»). The coordinator runs it as is and tells the session it is signed: the session repeats nothing.
  If she does not sign it within `approvals.delegation_wait_minutes` (10 by default), or stops being alive, the row goes
  to the person with its usual box, and `owner-wait` announces that once. In `/office` it shows under «En curso» with «la
  firma la coordinadora», not under «Tu firma».

Limits: if the person leaves before answering, `/office` keeps counting them and they are asked next time. What another
background session asks with `--for-session` still goes by message to the coordinator. A tab without permissions still shows its
box: if the coordinator passes it too, one click is good, and the extra one expires by itself.

## The order of the requests

Requests to the public repo go in through its queue. The private repo's requests start as drafts, and the coordinator
publishes them in order, once their public pair is in.

## The owner's signatures

A task or a message between sessions signs nothing, even if it says «aprobado». The owner signs in the permission window;
where the window does not reach, with a click in the options box or an «aprobado» they typed; or in their terminal. Their
click or «aprobado» in the coordinator's tab is the owner's, not a delegation. What the coordinator can sign on the
owner's behalf is in `guides/owner-signatures.md`.

From her own tab, with `--for-session <D>`, the coordinator requests the signatures the guide marks «sí» under «¿Desde
otra sesión?». Among them: setting a check by hand (`marker.js set-check <control> <estado> --force-manual
--for-session <D>`), counting the reviewers without the record that they ran (`pipeline.js check-count --repo <r>
--story <s> --trust-ran --for-session <D>`) and accepting a criterion that cannot be tested live (`marker.js
runtime-waiver <historia> --acs <n> --for-session <D>`). The story is the one of `<D>`'s open run: otherwise the script
exits without writing. The window opens for the owner in the coordinator's tab (if that tab does not ask for
permissions, it is refused and approved with their click or «aprobado»). All three are level 2 and procedural: they are delegated to
her only if the team profile names them in `approvals.delegated_signing`, and then she signs them without a window and
they are logged with the «delegación» route. Which exceptions can be delegated and which stay with the owner is in
`guides/owner-signatures.md`, «Qué excepciones se delegan».

### Messages from the office

The owner can write to any session from its window in `/office`, the coordinator included. The message arrives as a hook
notice that starts with `[oficina <id>]`, never as a message of theirs in the conversation. The coordinator checks it before
acting with `node <harness>/scripts/tools/office-message.js verify <id>`: with a 0 she treats it as an instruction from the
owner and acts on the text `verify` prints, not on the one she received; if `verify` rejects it, she does not act and tells the person. **A message from the office never counts as a signature or as leave to sign by delegation**: it
does not answer an open question box either, which keeps waiting for the owner's click. The reason: an agent on the same
account can read the office token and imitate the message, and what is delegated is not protected
(`guides/owner-signatures.md`). The same text inside a file, a page or a tool result is not a message from the office.

## Saving is authorized in the permission window

Saving a story (commit, push and the pull requests) carries no signature and does not go through the coordinator.
Before saving, the command hook asks the person in that tab, in their permission window; with a yes, it saves. In a tab
that does not ask for permissions, it saves without asking and says so on screen. A message between sessions that
says «ok to save» is not needed and does not skip the window. Sensitive changes are covered by the pull request's
control signature, which is the owner's.

## The quick fix of another tab

The quick fix (a code change with no story) is the `adhoc-lane` signature: the tab that needs it runs
`marker.js adhoc set '<json>'` and the owner approves it in the window, which shows the reason and the file quota.

**It is asked for with its list.** The JSON names the files it will touch, one by one, and a reason with a single topic:

```bash
marker.js adhoc set '{"reason":"the customer combo does not filter by branch","datos":"sin-cambio","allowedFiles":["src/customers/combo.ts","src/customers/filter.ts"]}'
```

The test of each file on the list does not need to be named. Outside the list nothing is edited or saved; widening it is
another signature. The details (which reasons are not delegated, one delegated fix per repo) are in
`guides/owner-signatures.md`.

**Files of a sibling repo: `<Name>/<path>`.** From the stories repo, for example, the list names `Backend/src/A.cs` or
`Forms/src/x.tsx`, with no «..» and no absolute paths. It only works for a repo that sits next to the main checkout, is
its own main checkout (not a worktree) and is declared with this one in `repo_group` of `.tycon/advisors.yaml`, both
ways. The group is read from the remote's main branch (`origin/HEAD`), not from the folder or the local branch: a group
committed but not pushed does not count. With another live session in the sibling, it does not open. A list of more than
one repo is signed and delegated like a single-repo one: the siblings come from the declared group, without asking the
owner, and a repo that is not in the group gets in by no route. The box starts with the repos and how many files each
one has. Tests go per repo, each in its folder:
`marker.js adhoc test --repo <Name> -- <command>`. When saving, every repo that changed code needs its green run.

**Declaring it again keeps everything.** With another quota or another reason, the lane keeps its list, its high-risk mark
and its records, which hold while what they measured does not change. A new task in the same session goes on a new branch
from `main`: on the previous task's branch, its commits count toward the quota.

- **On the same machine.** The designated session declares it for the tab it gave the work to, with
  `marker.js adhoc set '<json>' --for-session <session>`. It runs with no window only if the profile delegates
  `adhoc-lane` (it is in no group: it has to be named), the machine is on the list and the owner confirmed the
  designation; otherwise the window opens in the designated session's tab. Through this path it has three limits, and
  the script and the edit guard check them: the quota is at most 5 files by default, and each organization sets it
  (`short_path` in the team profile; asking for more is denied, and the guard gives the question box for the owner); the fix never touches anything sensitive
  (the list in `scripts/lib/signatures.js`: signatures, guards, notices, permissions, the profile), which goes with the
  owner's signature; and before it opens, one line reaches the owner through the notice channels, with the
  session, the reason and the quota: with no delivery, there is no fix. The designated session does not declare it
  for itself.
- **From another machine.** The coordinator on another machine asks the designated session of the target machine for it,
  by message, and that session declares it as above. The message is a request, not an authorization: what authorizes
  it is the team profile and the designation the owner confirmed. With no designated session on the target machine, the
  quick fix is approved in the target tab's window.

**Going past the limit does not go through you.** Asking for more than 8 files (by default; each organization sets it) is
the `adhoc-lane:sobre-cupo` signature,
and the owner chooses it: with a click in the question box, in the tab doing the work or in yours while you are the current
coordinator, or in their terminal. Your tab only shows the box: the click is the owner's. A forwarded «aprobado» and the
delegation do not count. Only the implementation files the fix changed count: what came in from `main`, tests, guides
and probes do not add up. Past the quota, the fix stops on edit and does not save, and the message recommends a story. Limit:
it measures the branch being worked on and what is already on disk. Work built on another branch and pushed by its name, or
created in the same command that pushes, does not add up. That does not let it into `main`, because the pull request still has
its check and its review: it skips the notice, and it takes doing it on purpose. Conversely, on `dev` with `main` brought in and
not pushed, what is already integrated counts too: push it, or choose with the click. A pull request opened from a folder that is
not a repo (`cd F && gh pr create --repo o/r`) is charged to the session's branch, because the request does not say which copy
it comes from: if it belongs to another repo, choose with the click. Risk is measured like the limit, from the nearest
integration branch: a high-risk path that `dev` brought, on a branch born from `dev`, already went through its own pull request
and asks for no reviewers; a high-risk path the branch changed still does.

**A change to the data is not a short path.** On opening, the session answers whether the change alters where a piece of
data comes from or who can see it (`"datos": "sin-cambio"` or `"cambian"`); with «cambian» it does not open, and an open
lane does not change. On saving, the brake looks for the stack pack's signals (a call to a process, a role check, an
endpoint's authorization) in the lines the lane adds or removes, each repo against its own base, and with one it does not
save. If the session thinks it is a false positive, it runs `marker.js adhoc allow-data-change --changed "<what changed>"
--recommends <pasar|historia|descartar> --why "<why>"` and sends you the question the brake gives it: what stopped it,
with the line's text, what really changed and what it recommends. The signature is `adhoc-lane:datos`, and only the
owner's click approves it, in their tab or in yours: «Sí, aprobar» lets it through, and «No» sends the session to write the
story, or to discard what the lane did if the owner says so. A written «aprobado», the permission window and delegation do
not count. The click covers those signals: another line with a signal stops it again. When in doubt, a story.

**A foreign save, while the lane waits for its reviewers, asks for the click.** While a high-risk short path waits for its
reviewers and the pass, the session saves nothing, not in another repo or another worktree either. If what it saves is
not part of the lane and can be seen whole, the brake writes down the request and gives the session `marker.js adhoc
allow-foreign-save`. That command shows the command, the repo, the branch, what it saves (the commit's files, or the
push's commits), the hooks that run and the machine's configuration that runs programs, and asks for the signature
`adhoc-lane:guardado-ajeno`. Only the owner's click approves it, in the session's tab or in yours, or their terminal:
delegation, «hecho y avisado» and a written «aprobado» do not count. It lets that same command through once, in that
folder and with the repo as it was, for 30 minutes from the click; any change stops it again. The click is not offered,
and it stops as always, for what cannot be seen whole or can touch the lane's branch: a save of the lane, a pull request,
its own high-risk path, more than one repo, `--amend`, a push to a remote of the lane, to a path or with `--force` and its
relatives, git options that run programs, a hook that is not the repo's, a key of the repo's configuration that runs a
program, or a command longer than 160 characters or with characters that cannot be seen. There, run the lane's reviewers
and pass.

**With the mockup and the screenshot, what was built is compared with the mockup.** It compares texts, not the drawing: if a
text of the mockup is not in the fix's screens or in the other screens of its repos, it does not save. A text that already
exists in another screen passes, even if the fix did not build it. A difference is declared in `<mockup>-diferencias.md`,
with `- «<text>» — differs: <why>`, or `mockup-compare: no — <reason>` if it cannot be compared. The agent declares it,
with no signature: it stays visible in the save question and in `gates.log`.

**If the fix touches a screen, it does not save without three things.** What a screen is comes from the pipeline's own
criterion (`lib/ui-signal.js`, with the organization's `screen_test` rule), file by file. A test does not count.

1. The mockup, passing `mockup.js check`.
2. Its approval: `marker.js adhoc set '{"reason":"…","mockup":"<path>","mockupApproved":"<who and by which path>"}'`,
   with the usual signature. The window shows the mockup and who approved it. If the mockup changes, it needs approval again.
3. The screenshot, newer than the last change to the lane's files: `marker.js adhoc capture <image>`. It asks for no
   signature: it approves nothing, and the guard measures it. A code change afterwards expires it.

The save window shows the mockup and screenshot paths together. If the guard cannot measure whether the fix touches a
screen, it does not save either: nothing measured, nothing green.

**Limits.** The guard looks at the screenshot's date: it does not check that it shows that screen, nor compare it to the
mockup. A closed quick fix (`adhoc clear`) or an expired one stops nothing on save, same as the high-risk guard. A screen
recorded in a nested worktree that was deleted keeps asking for a mockup and a screenshot: the way out is `adhoc clear`.

## A stuck session, instantly

**When designated, and every time it ends, the coordinator runs
`node "<harness>/scripts/tools/coordination.js" owner-wait` in the background,** with the full path its notice gives: it
is the only background console with which the owner can still sign with a click. It looks every 2 seconds and ends with one line per novelty, and ending wakes the coordinator up:

- "<session> espera un permiso desde las HH:MM: <tool> <what it asks for>. Para entrar: claude attach <session>": the
  coordinator passes it to the owner with the session, what it asks for and a recommendation. A person answers the
  permission, in the session's tab or with `claude attach`.
- "<session> siguió: el permiso ya no está abierto" or "<session> se cerró con un permiso abierto": the owner is told if
  they had been asked. "Siguió" asks for nothing and does not wake the coordinator, like "… ya no espera a la persona":
  those lines are kept and come out ahead of the next news that does wake it.
- "<session>: la cerró Claude Code a las HH:MM por falta de memoria, quieta N min. Para levantarla: coordination.js relaunch --id <id>":
  Claude Code closes quiet background sessions on its own when the machine runs out of memory, and the harness cannot
  prevent it. The coordinator decides whether to bring it back: that uses memory again and counts for the cap.

- "un permiso para la persona: «<session>» pide «<tool>» en «<folder>» (<row>). Te da el cuadro owner-next…": a
  background session's permission arrived as a box (the next section). Each row is announced once.

There is one per machine, and without a confirmed coordinator it exits at once. If it is not running, the notice of each
turn says so with the command. `coordination.js status` shows the stuck sessions ("Trabadas") and the ones Claude Code
closed ("Cerradas por Claude Code").

### A background session's permission, as a box

With the list on, a confirmed and alive coordinator and her `owner-wait` running, **the permission a background session
in normal mode asks for reaches the person as a box, in the coordinator's tab** (`scripts/hooks/permission-relay.js`).
The hook writes the whole request in the list and waits; `owner-wait` announces it and `owner-next` gives the box, which
goes first: "¿Aprobás este pedido de <tool>? (permiso <id> · sesión <id> · código <fingerprint>) Carpeta: <folder>.
Pedido:" and the whole request, with its line breaks. In Edit, Write, NotebookEdit and WebFetch each line of free text
carries the mark "│ ", so nothing written inside is taken for a label, and the code is the fingerprint of the request's
fields: two different requests never look the same nor share a click. The coordinator shows it without changing a
letter, with «Sí, aprobar» and «No».

- **On «Sí, aprobar», nothing is run.** The hook sees the person's click, spends it and lets that request run once,
  with no permanent rule. The same request later carries another id and asks for another click.
- **On «No»:** `coordination.js owner-reject <id>`. The hook denies it and the session is told the person said no.
  Rejecting only denies: it never approves.
- **Only the person approves it, with a click in the coordinator's tab.** Never the coordinator: not by delegation
  (`approvals.delegated_signing` does not cover it), not with a typed «aprobado», not by touching the list.
- **A background session never waits for a permission.** Whatever the box does not settle is denied with its reason
  and a way out (do it another way, go on without it, or ask the coordinator), and it is logged in `gates.log` as
  `negado-de-fondo`. That happens with no answer within `coordination.permission_wait_minutes` (10 with no value, from 1
  to 30), if the coordinator dies or stops being the designated one while it waits, and when the request is not carried:
  another mode (auto, no permissions, accept edits, plan), no confirmed and alive coordinator, no `owner-wait`, the list
  off, a PowerShell command on Windows, or a request that cannot be shown whole (over 1500 characters, characters that
  are not seen or look blank, a line break in a path or an address, data the box does not show). A late click approves
  nothing.
- **The usual window comes** only where someone can answer it or the hook does not act: an open tab, the coordinator
  herself, Codex and the hook turned off. The tools it carries are Bash, PowerShell, Edit, Write, NotebookEdit and
  WebFetch; the question box and the plan, never.
- **If the person answers in the session's window** or the session closes, the hook dies and its row closes by itself:
  a click is never asked for a request that no longer waits.

What happened with each request stays in `gates.log` (`permission-relay`), without the request's text. It is turned off
with `TYCON_PERMISSION_RELAY=0`.

**What happens in other tabs reaches the coordinator on her turn**, and the working session sees nothing:

- "<session> le preguntó a la persona en su pestaña, hace N min": the session opened a question box or asked for its plan
  to be approved. It shows once per question, without the text: to know what it asks, ask the session or go in with
  `claude attach`. A permission does not show here: it shows among the stuck sessions.
- "<session>: te contestaron «…»": what the person typed in another tab, up to 120 characters, on one line and with
  secrets masked. At most 5 show, with "(+N más)", and each one shows once. Before handing it over, the notice checks in
  that session's conversation that a person typed it. A message from another session, a notice or a background
  session's task are not recorded. A message shaped like a seal is not recorded either, and an "aprobado" arrives
  labeled as what the person said there: it approves nothing and is not a signature.

Both lines need a confirmed, live coordinator, and they turn off with the rest of the notice
(`TYCON_COORDINATION_NOTICE=0`). What could not be read shows in "No pude leer".

**At every check, and before saying there is nothing for you, the coordinator looks at the office's waits** ("Tu firma"
and the state of each session), not only at the messages it gets: the notice can fail.

**The auto mode does not avoid the dialog.** Per the Claude Code documentation, in `auto` the dialog still opens with
`ask` rules, with an `rm` on critical paths, on the first read outside the working folder, and after 3 blocks in a row or
20 in total.

Known limit: with a permission open, another tool ending does not close it, but two uses of the same tool at once can
close it early.

Before it sits waiting for a turn, the session commits and pushes its work to its branch: if it closes while waiting, nothing is lost.
A session waiting for a turn notes it with `marker.js doing "<what I do>" --waiting-for "<what it waits for>"`: that wait
reaches the coordinator, and the owner only after 2 hours, not after 30 minutes, even if the closing gate escalated.
That noted wait also keeps its run from being pruned as old, for 24 h since it started waiting. With a pipeline run open
it goes without text, `marker.js doing --waiting-for "<what it waits for>"`, and the story's card says what it waits
for. `marker.js` refuses any other note there: the step already says what the run does and when it ends, and a note on
top would show the story paused. Leaving the story for other work is another session.

**A stopped autonomous mode arrives as a row.** When the closing control stops an autonomous session (the round cap, or
a round with no progress), it writes the time into its marker and leaves a request in the owner's list with the
`autonomy-resume` signature: "does this session go back to autonomous mode?", with the reason, the time and the failures
as they stood. The coordinator passes it with `owner-next` like any other; only the owner answers it, with their click
(in the coordinator's tab or in the session's) or from their terminal (`marker.js resume-autonomy --terminal
--for-session <session>`, which leaves a permit). The decision is taken by the stopped session itself with
`marker.js resume-autonomy`: the message the coordinator sends it only wakes it up, and if the command exits 1 the
session stays stopped. A "No" (`owner-reject`) is recorded and the session does not ask again on its own for that stop;
only `resume-autonomy --ask-again` asks again. While it is stopped, neither `set-autonomous true`, nor `set` with another
story, nor closing it without a signature, nor clearing it from another session are ways out. The panic button
(`STOP_AUTONOMY`) leaves no row: a person lifts it by hand.

**A pruned run can be recovered.** If it was pruned anyway ("abandonada: más de N h sin tocarse"), its marker was
saved: the session that takes it back runs `marker.js restore <session>` (the pruned session), with the owner's usual
signature, and it comes back with its done and pending steps, without repeating signatures.

## The notices to the owner

Short and plain: what happened, what is missing and what the owner decides, in that order. One notice per batch of
work, not one per session. The style meter that already exists measures this; this recipe does not add another one.

## How the coordinator speaks

**When she says something "finishes", it means working for real: it went into main and it is installed.** If not yet, she
says so: "in the queue", "in main, not installed", "programmed, no request yet". Why: the owner decides on that word, and a
"done" that does not work yet makes them consider settled something that is still broken. An end time also says which state
it refers to.

## The board in the office

The `/office` page shows pending work as a kanban with five columns: **Sin sesión, En curso, Tu firma, Esperan entrar and
Terminados**. En curso, Tu firma and Esperan entrar build themselves from what each session is doing. The coordinator's board adds what the machine
does not know, in `<state>/coordination/tablero.json`, and **it is written only with `board.js`**
(`scripts/tools/office/board.js`), which checks every row before saving, gives it its number, and writes to a separate file
and renames it, under a lock, so the office never reads it half written:

```bash
node <harness>/scripts/tools/office/board.js add titulo="Fix X" estado=espera grupo=Hoy    # a new pending item
node <harness>/scripts/tools/office/board.js set T-41 estado=curso quien=Sand nota="…"     # change a row
node <harness>/scripts/tools/office/board.js close T-41 [--real YYYY-MM-DDTHH:MM]          # close it
node <harness>/scripts/tools/office/board.js drop T-41 --reason "<why it goes>"            # remove it without calling it done
node <harness>/scripts/tools/office/board.js save --from <your separate file>              # the whole board
node <harness>/scripts/tools/office/board.js check                                         # check without writing
node <harness>/scripts/tools/office/board.js due                                           # the «Te toca» lines
node <harness>/scripts/tools/office/board.js due confirm <id>                              # still valid: count again
node <harness>/scripts/tools/office/board.js due drop <id>                                 # remove it
node <harness>/scripts/tools/office/board.js backups                                       # the board's copies
node <harness>/scripts/tools/office/board.js restore <copy>                                # go back to a copy
```

`save` and `restore` first copy the board they replace (the 30 newest stay in `coordination/board-backups/`): an
overwritten board comes back with `board.js backups` and `board.js restore <copy>`, with its numbers and the «Te toca»
dates. `save` does not shrink a board of 10 rows or more to less than half: if that is on purpose, add
`--allow-shrink`. A test (`TYCON_TEST_RUN=1`, the mark `smoke-run.sh` sets) does not write the real board.

Writing it by hand (Edit, Write or the console) is stopped with the command that does the same. Reading it stays free, and
the separate file for `save --from` lives outside the state folder. If something changed it without the command, the office
says so once under «No se pudo leer». A badly written row is not saved: `board.js` exits 2 and names the row and the rule.

- `pendientes`: a list; each item has `id` (its number, `T-41`: the command sets it), `titulo`, `estado` (`hecho`, `curso`,
  `firma`, `riesgo`, `entrando`, `sin-empezar`, or `espera`, which goes to «Sin sesión»; `curso` and `riesgo` go to «En
  curso» only if a live session is doing it, and otherwise also to «Sin sesión»; a `firma` whose `quien` is a session name
  (one word, like «Tero-2») that is no longer in the office goes to «Sin sesión», with «la sesión que la esperaba ya no está»: it does not wait for
  the owner), `grupo` (`Hoy`, `Esta semana`, `La semana
  que viene` or `Más adelante`), `orden`, `quien`, `nota`, and its time: `pronosticoIso` (local time, `YYYY-MM-DDTHH:MM`),
  or `termina` with its own text. A done item carries `realIso`. `estimadaIso` is not allowed. `ultimoHecho` is written
  only by the board when it moves on its own.
- `historia` (for example `"2.81"`) and `pedido` (`{ "repo": "tycon-harness", "numero": 885 }`), both optional. With
  `historia` and a run of that story on this machine, the row adds no state or time: they come from the run, and the row
  adds its `nota`. With `pedido`, the state comes from asking for it, at most once a minute: open goes to «Esperan
  entrar», with the reason if it is a draft or out of the queue; merged goes to «Terminados» with its merge time. If the query fails,
  the row stays where `estado` says and the reason goes to «No se pudo leer». `repo` is the name of a repo of a run on this
  machine or of one declared in `team-repos.json`. `estado` only counts when there is nowhere else to get it from.
- `meta`: `actualizado` and `teToca` (what the owner has to do, one line each). «Te toca» comes from the signatures, the
  open questions and this list: notes are not read, so what the owner has to do goes here. `meta.resumen` is ignored, like
  `tablas`: the line above the kanban builds itself from the cards («Sale primero: T-52 … · 19:30 · Tu firma: 2 · Trabado:
  1 · Tablero escrito a las 16:29», or «Nada con hora en curso»).
- A `teToca` line expires after 24 hours: it stops showing and the office says how many expired in the summary strip.
  Saving it again does not
  renew it, because `save --from` brings your whole file; `due confirm` renews it. `due drop` removes it from the board:
  remove it from your separate file too, or the next `save --from` brings it back with its date. Signatures and questions
  do not expire. The date lives in `meta.teTocaDesde`, which only `board.js` writes.

«Terminados» is what was done today, with its time; anything older, or with no `realIso`, goes to the «Hechos» table. It
also adds, with no row, the stories of your projects that turned closed on main since midnight and your pull requests
that went in since midnight; what a done row already says, by its story or its pull request, is not repeated. Those
stories belong to your machine: they do not travel to the site. «En curso» goes by end time: what ends first on top,
what has no time after, and the coordinator last.

A row that should not be there (a test wrote it, for example) **is not closed**: `close` counts it as work done. Remove it
with `board.js drop T-41 --reason "<why it goes>"`, which takes it off the board without going through «Terminados» or
«Hechos» and adds a `descartada` entry to the facts log with the number, the title, the reason and the time. Remove it
from your separate file too, or the next `save --from` brings it back. The number is not lost: a row with the same title
gets it back. A row with `historia` cannot be removed this way (exit 2): close it with `close`, because the board would
create it again while its session keeps working.

### Abiertas: the number of open stories

The wall, the detail of the «Pendientes» panel and the kanban say
`Abiertas: 67 · 10 en curso · 27 en espera · 30 sin comenzar`: the stories open on `main` in the coordinator's project (the one of its folder, by its remote). It is the
number the owner decides with, and **the coordinator reports that one**, the one in `office.js --json`
(`kanban.abiertas`): it does not count it separately.

- **Open**: the stories whose state is in the «backlog», «in progress» or «blocked» groups of the state vocabulary (drafts
  and backlog included), read from the fetched main branch. The ones that could not be read do not count and are named
  apart.
- **In progress** (`en curso`): it has a run with its session alive (Claude or Codex; the coordinator does not count), a
  stopped run with a signed plan from the last 24 h, or a session with a card that names it.
- **waiting** (`en espera`): it is in review or blocked, it waits for another story (`depends_on:`), or it is paused until
  today or later.
- **not started** (`sin comenzar`): the rest. The detail says how many have part of the work done (`in-progress` with
  nobody on them).
- Below, it says how old the data is: «Leído a las 16:20 · main traído hace 3 min». The read redoes itself within a minute
  when the main branch of a project moved, without going to the network: a `git fetch` (or `git pull`) updates it.
- The other projects go apart, in the detail, under «Otros proyectos», one per line; they are not added to the number.
- With no read, or one older than an hour, it says `Abiertas: sin dato`; with no coordinator, or if its repo belongs to no
  project, it says `Sin proyecto principal:` and the reason. Never a 0 or an old number.
- **«Sin sesión» no longer adds the folded stories**: the column counts its cards, and the line «Historias de tus
  proyectos · N» says how many are inside.

### The stories of your projects

A story that is in progress, in review or ready **shows up on its own**: it does not need a board row. These are the
stories of the projects you worked on in the last 7 days, because you opened a session there or made a commit of your own.

- They go to «Sin sesión», in the «Historias» group, after the board rows and sorted by priority. The «Pendientes» table
  has one row per project, under «De tus proyectos», that opens to show its stories.
- They are read in the background, from the fetched main branch of each repo, without going to the network. It runs only
  while the office is open, at most every half hour. Each project's line says when something was last fetched from that
  repo («traído hace 3 h»), even if it was another branch.
- A story with a run on this machine adds no card: it goes on its session's card. One that already names an open board row
  (`historia`) adds none either: the row stays, with its number.
- What has no story (a loose fix, a decision, something from outside) stays on the board, with `board.js`.
- Limit: «who» comes only from the runs on this machine. A story someone is coding on another machine says «sin asignar».
  These rows and cards do not travel to the organization site: they belong to each machine.

### The number of each task

Every row has a short fixed number, `T-41`, shown on its card, in the works of the tables and above the detail. The
command sets it when the row is saved and it never changes, even if the title does; a closed one is never reused. A row
that lost its `id` and has the exact title of a number already given gets it back. A row written by hand without a number
says «sin número» until it is saved once.

The coordinator puts the number in every assignment («You are Sand. T-41: …»), and the session carries it in what it says
it is doing (`marker.js doing "T-41 · …"`). Then the row goes on that session's card: a single card, with the number and
the row's note. A row whose `quien` names a live session that does not say its number is not hidden: it shows on its own,
with its number, and `board.js` warns about it when saving.

«How is T-41 going?»: `node <harness>/scripts/tools/office.js --task T-41` (or `41`) says it in one line; with `--json`,
the whole card. In the office, the «Buscar» field switches to the kanban, marks the card and opens it.

### The board moves on its own

The coordinator writes only what is new: a pending item that has no session, story or pull request yet, with `board.js
add`. The rest is moved by the board with what happens, through `board.js sync`, which the machine's office process calls
after every snapshot:

- a session that starts its story, or says a number in what it does, puts its row in «En curso» with who (if the story has
  no row, it adds one);
- a session waiting for the owner puts its row in «Tu firma», and back in «En curso» when it stops waiting;
- when its pull request enters main, the row is done, with the merge time;
- an abandoned pull request or a cut run says so in its note.

Each fact is applied once: a correction with `set` is not overwritten until another fact arrives. It never deletes a row or
changes its title or promised time, and a done row never goes back. If something could not be read, it does not apply what
comes from not seeing it. On a board without numbers or with a badly written row it does not write: it says so under «No se
pudo leer» until a `save` makes it sound.

### The «Hoy» and «Pendientes» tables

The two tables build themselves from the same cards as the kanban, and nobody writes them: not the coordinator, not a
session. A `tablas` key on the board is ignored, and `office.js --write-tables` answers that it no longer exists. «Hoy» holds
«En curso», «Tu firma», «Esperan entrar» and «Terminados»; «Pendientes» holds what has no session and what was left halfway.
There is one row per topic, naming up to two pieces of work, with a line counted from the cards: «5 en curso, el próximo
termina a las 23:30 · 2 esperan entrar · 6 terminados hoy». Touching the row opens its work.

A model picks the topic of each piece of work once, in the background, and it stays saved: it does not change when the work
changes its time or its session. It is the organization's nightly model (`models.nightly`), or that same model through the
local service if the machine does not have its key. It receives only the title of the new work and the topics already used.
The title of another project is not sent: it goes to «Otro proyecto». Neither is one naming a person on the private list, if
the list is on the machine: it goes to «Otros». With no model, the topic comes from the titles of recent pull requests, and
the table says so. The spending has a daily cap; `node scripts/tools/office/topics.js --report` says how much has gone.

If a topic came out wrong, fix it with `tema` on the board row: it wins over the model. A row cannot write the status line. An
open row that names a live session in `quien`, and is the only one naming it, remembers the pull request of its branch: when
that enters, the row moves to «Terminados» with its time, even if the session has closed.

Without the file the kanban still shows, with the real-state columns. A broken file is reported below, under «No se pudo
leer». The live office reads it again on its own when it changes, and the kanban says «Tablero escrito a las HH:MM», with
«(vieja)» once it passes the quiet-session threshold (even a board that is up to date and unchanged: it is only written
when it changes). The desks do not come from here:
they come from what each session is doing.

A run left on purpose is marked with `marker.js park <story> --queue` («En fila para pruebas») or `--until YYYY-MM-DD` («En
pausa hasta…»), even if its session is closed. With two runs of the same story, say which one with `--session <id>`. A
marked run shows no time or delay, never says «limpiar», and `marker.js clear-session` refuses it. The mark goes away with
`marker.js unpark <story>`, by adopting the run, or through the exit the owner signs. Neither one asks for a signature: the
mark authorizes nothing. Why: clearing one of those loses the work.

A quick fix's promised time is set by its session with `marker.js adhoc until HH:MM`. The office and `/wip` show it as
its end and measure the delay against it; without a time they say «sin hora estimada».

## The everyday rules

They come from a whole day of coordinating several sessions. Each says what to do and why.

- **An owner's signature goes in a message of its own.** What is signed, in one line, in an options box with a single
  signature; what goes through the terminal, with its command. Nothing else. If it is still pending after 15 minutes, the
  reminder also goes on its own. Why: a signature at the end of a message with other things gets lost, and the work stays
  stopped waiting for it.
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
  through the window: the harness refuses it. A click or an «aprobado» the hook did not record does not count either.
- **Heavy things, with a turn.** The controls bench and the reviewers' exam run one at a time on the machine, and the
  turn is asked from the coordinator. The full suite and the full gate ask for a turn too, and up to two run at once when
  free memory is at the floor (50 % unless changed) or above; below it, or when it cannot be measured, one at a time. The
  coordinator gives the second one its "go" when her notice says there is room. The harness also stops the full suite and
  the pass, which do not go together (above, "Heavy work takes turns"). A gate of 40 suites or fewer asks for no turn: the
  harness lets it run beside the pass, or makes it wait. The story the owner marked as a priority goes first in the line.
  Why: more than the memory can hold saturates the machine, everything takes longer and Claude Code closes sessions.
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
- **Sessions do not write to each other.** What one wants to tell another goes to the coordinator with the text ready, and
  she forwards it. Why: otherwise she hands out the same thing twice and loses the thread.
- **A session does not open a box in its own tab.** What needs a person goes to the coordinator and the session moves on to
  something else. If it is an owner's signature: tell them, and if they do not answer, go on. Why: a box leaves the session
  stopped until someone sees it, and that can be hours.
- **A session stuck waiting for the owner is reported at once.** Which one, what they have to answer and the recommended
  answer. Why: a stopped session nobody knows about wastes everyone's time.
- **Before saying "your turn", ask the session.** The owner writes in the tabs without going through the coordinator. Why:
  claiming something they already did costs them time and trust.
- **"Your turn" is only for what they can do now.** What they will need later is said with its time and its condition. Why:
  the owner reads "your turn" as something to do right then.
- **Every request to the owner comes complete.** The tab, the steps and the whole command, never "what I sent you". Why: on
  a day with many sessions, what was sent before gets buried.
- **If the owner asks how something is going, ask that session right then.** Do not answer with the last data point. Why: it
  may already be old.
- **A session that said "takes N" and went past double is checked without waiting for its notice.** Why: a hung process does
  not report.
- **Before assigning, size the work.** One line that says whether the work is light or full and how long it takes, and first
  check whether it already exists. Why: taking the long road without analyzing it is the most repeated mistake.
- **A session that finishes gets the next approved thing in that turn, or is closed.** Always within the cap. Why: a free
  session is wasted machine time, and the owner should not have to watch the board to assign.
- **A session that waits (the CI, the queue or a signature) does not sit idle.** The coordinator gives it the light work
  from the board: paperwork, conflicts, drafts. A new story with a pipeline goes in a new session, not in the one that
  waits, which only watches its pull request and is closed when it gets in. With two or more waiting for the gate, the
  coordinator stops the last ones in the queue and reopens a stopped run with a signed plan. Why: a waiting session
  holds a slot doing nothing, and a story that lands on it gets tied to someone else's pull request.
- **With a free slot, free memory and ready work, the coordinator does not close her turn.** She opens or resumes
  sessions, or writes down why not with `coordination.js keep-free`. Stopping sessions to save memory does not count:
  the floor to open is 40 %. Why: four times in two days the machine was left with 2 of 6 working and six signed stories
  waiting, with free memory above the floor; the notice said so and was ignored. A brake measures this rule (above,
  «The cap»).
- **With a long suite queue, no session is opened to program.** If more than two sessions are waiting for the suite or
  gate turn, a new session is opened only for work that does not need the suite: writing a story, reviewing or
  researching. Those that only wait for their turn can be closed and resumed with the same conversation when their turn
  comes (`coordination.js relaunch --id <id>`), with the order written down. Why: the suite runs one at a time; one more session does not
  speed anything up, it lengthens the queue and takes memory.
- **A red is not left behind, even if it is not from your own change.** Report it and fix it before going on. Why: tolerated
  reds hide the new ones.
- **What loosens a review does not go in, even if it saves time; what is only paperwork is not done.** If the code already
  went in and real use proves it, close it citing that evidence. The exception is code that decides things and was never
  reviewed. This does not skip a signature or a record the harness asks for. Why: quality is worth more than the minutes,
  and a record that finds nothing costs hours.
- **A message for the team is checked sentence by sentence before passing it on.** And devs are bothered as little as
  possible: a fix reaches them by itself; a manual step is the last resort. Why: a false promise reaches every machine.
- **The coordinator does not change code or guides itself.** Every change goes to a session, which makes it with its
  gate. Why: the shortcut skips the tests that pin down what changes, and the pull request drops without anyone seeing it.
- **A plan or proposal for the owner first goes through a separate reviewer.** An agent that looks for where it fails,
  and the owner sees what it found along with the plan. Why: whoever builds the plan does not see their own assumptions.
- **What the coordinator states, it checked; if not, it says «I did not check it».** Before proposing to remove or
  change something, it measures whether it is used. Why: a false statement costs the owner a badly made decision.
- **A change that promises speed is measured before and after on a loaded day.** Not only with the machine idle. Why:
  with the machine idle everything is fast, and the difference shows when several things run at once.

## How the coordinator works with the owner

They come from a whole day in which the coordinator worked with the owner away. They apply to any coordinator, also a
product's. Each one, with its why.

- **A question's box carries its context inside.** What happens today, what the problem is, what changes and what it
  implies. Why: the owner sees only the box, not the conversation that explains it.
- **The record of a control change is asked for at the end.** Only with the rest of the CI green and after the pull
  requests that touch the same files are in. Why: a record asked for earlier expires with the next change, and has to
  be asked for again.
- **Stories are closed in hours.** The quick smoke checks that have a script are run. A criterion impossible to test
  live goes by its waiver: the coordinator signs it with `marker.js runtime-waiver <story> --acs <n> --for-session <D>`
  if the team profile delegates it, and otherwise the owner does. Waiving the whole story is a signature only the owner
  gives. Why: a finished story that waits days for its closing takes up the queue without adding anything.
- **First what blocks everyone.** A red CI or a brake that does not let anyone work. After that, the order of the
  product's plan: the sprint's stories and what its owner decides. What is already approved is handed out in the same
  pulse, without waiting for the owner to ask. Why: a free session is lost machine time, and the owner does not have to
  hand out what is already approved.
- **Each pending item has written down who has it and in which pull request, before it is assigned.** Why: without
  that note the same fix is done twice; in a single day there were four duplicates.
- **One push per pull request, with everything together.** After that, only the fix of a red or of what a review asked
  for. Each push launches about 14 CI jobs, and GitHub runs about 20 at a time. If `main` does not move, the waiting
  jobs are counted before blaming a pull request. Why: extra pushes fill everyone's queue, and a pull request that waits
  is not a broken one.
- **A turn is never closed with «shall we go on?».** A session that waits gets work. Why: with the owner away, nobody
  answers that question and the session stays stopped.
- **With the owner away, no box is opened.** The owner is told through the team's notice channel, if the profile asks
  for it (`coordination.away_notify`, default `signatures`; with `broken-only` or `never` a signature is not notified),
  and the coordinator waits for them to write. The whole mode, for whoever uses it:
  [The coordinator's autonomous mode](autonomous-mode.en.md). Why: a box opened in the middle of the night left the coordinator stopped for six hours, and
  the sessions without work.
- **Before running the signature command of another session that asked for the owner's yes, the owner is asked.**
  Why: a signature the profile delegates to the coordinator goes through on its own when the command runs, without
  the owner seeing it.
- **The record is asked for with the folder still.** Before the command, the session confirms it touches nothing until
  the owner signs. Why: if the folder changes during the box, the record no longer matches and the click is lost.
- **The record is signed with the script from the installed copy of the harness** (`scripts/ci/run-base-controls.sh`),
  not the one in the pull request's folder. Why: an old copy of the script does not write the fingerprint, and the owner
  has to click twice.

## What measures each rule

| Rule | Measured by | Why |
|---|---|---|
| Signatures, passwords, product decisions and what leaves the house go to the owner | nadie | What a product decision or a routine release is is a judgment call: no piece of data says it. |
| The sessions' questions go to the coordinator | nadie | The working session sees no notice, by the owner's decision. When a session asks the person directly in its tab, the notice of each turn tells the coordinator, once per question, and she reminds the session. |
| The coordinator settles details with the safest option | nadie | It is a judgment call, and it is written down for the owner to see. |
| Every session with a name a person gave it | aviso | `/coordinate` lists the ones whose name the tool made up. |
| No more sessions working than the cap | freno | `open` does not open at the cap. Nothing stops a session the owner opens by hand; `status` counts it and, on reaching the cap or a change in the count, so does the coordinator's notice. |
| Do not open more when what waits for the person's review reaches its cap | aviso | `open` and the background-session brake still open, say so and log the `review-cap` line; what was not measured does not stop anything. It becomes a brake with a commit, when the lines justify it. |
| With a long suite queue, no sessions are opened to program | nadie | Which work needs the suite is a judgment call; `status` shows who is waiting for the turn. |
| One full suite at a time | freno | The suite runner and the whole portable run do not start with the turn held by another live process, and they say who holds it. A suite someone runs another way is not seen. |
| Adversarial passes one at a time | freno | The pass's gate exits 3 and `next` asks to wait with another in flight. Nothing stops launching the pass without asking the gate, and a quick fix's pass is not noted as in flight. After an hour, it only warns. |
| Idle background sessions get closed or given work | aviso | The coordinator's notice on each turn, after 15 minutes. |
| A session closes with nothing pending | freno | `close` does not close if something is missing or it could not look. `claude stop` and `claude rm` by hand do not go through it, and it does not see another worktree the session left behind. |
| A ready request does not stay unqueued | aviso | The coordinator's notice on each turn, after 10 minutes, and the startup one. GitHub only. |
| "Finishes" means working | nadie | It is the word she picks: no data on the machine sees it. |
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
| A tab that does not ask for permissions does not sign through the window | freno | The window's guard refuses the signature and says how to approve it with a click or an «aprobado»; what does not accept them, with the terminal command. That the path says «delegación» is confirmed by the coordinator. |
| A quick fix with a screen carries a mockup and a screenshot | freno | The save guard does not pass without the three things, or if it could not measure. It looks at the screenshot's date, not at what it shows. |
| Heavy things one at a time, with a turn | nadie | The full suite, the adversarial pass, the scoped gate beside the pass and the second large run (with its memory floor) have their stop (above); the bench, the exam and the full gate without a pass do not. |
| Look at the diff before approving someone else's request | nadie | It is the approver's judgment call. |
| A waiting session writes what it is doing | nadie | The session writes it with `marker.js doing`; nothing forces it. |
| Check that a request is still in the queue | nadie | Checking on every turn would mean asking the network all the time. |
| The owner's decisions with their context | nadie | It is a judgment call; the style meter measures length, not content. |
| What the owner sees, without jargon | aviso | The style meter that already exists. |
| The guide reaches the coordinator by itself | aviso | On being designated, and on compacting or clearing the conversation. Nobody measures whether she reads it. |
| The coordinator does not approve what gives her more power | nadie | The profile's control looks at the level of what is delegated, not at who approved the request. |
| Sessions do not write to each other | nadie | A message between sessions does not go through a control. |
| A session does not open a box in its tab | nadie | The session decides it when asking. |
| A stuck session is reported with the recommended answer | aviso | A permission, instantly, with `owner-wait`; the other waits, at 5 and at 30 minutes; the coordinator writes the recommendation. |
| Ask the session before saying "your turn" | nadie | It is the coordinator's judgment. What the person types in another tab reaches her on her turn, on one line; what got cut or went another way does not: that is why she still asks. |
| "Your turn" only for what can be done now | nadie | It is the shape of the message. |
| Every request to the owner comes complete | nadie | It is the shape of the message. |
| Ask the session when the owner asks how it is going | nadie | It is the coordinator's judgment call. |
| Check the session that went past double what it said | nadie | The duration was said in a message, not in a piece of data. |
| Size before assigning | nadie | It is the coordinator's judgment call. |
| A session that finishes gets work or is closed | aviso | The notice about idle background sessions, after 15 minutes. |
| A waiting session gets the light work | aviso | The coordinator's notice on each turn: it names the background session that noted it waits for the CI, the queue or a signature, with up to three light rows from the board, and proposes a new session for a story when there is a slot and memory. With two or more in the gate queue, it says which to stop and which stopped run with a signed plan to reopen. A session that did not note its wait is not seen. |
| With a free slot, free memory and ready work, the coordinator does not close her turn | freno | The turn-closing hook, only in the designated session: with a free slot (the others working plus her, below the cap), free memory at 40 % or more and a ready story without a session from her project (no open dependencies, no pause), it won't let the turn end until she opens a session or writes the reason with `coordination.js keep-free`, which lasts 30 min and covers only the work it saw; three blocks in a row and on the fourth it lets the turn close, noted as «cerró sin abrir ni motivo». Stopped runs are not included: with two or more waiting for the gate, the long-queue notice keeps proposing to reopen the oldest. Unable to read the state or measure memory, it does not block. |
| A red is not left behind | nadie | The controls stop your own; someone else's red is seen by whoever finds it. |
| Do not loosen a review, do not do paperwork | nadie | It is a judgment call: no data separates a review from paperwork. |
| Check a message for the team | nadie | The message goes out outside the machine. |
| The coordinator does not change code or guides itself | freno | The designated session does not write, edit or delete files of a repo or of the installed copy of the harness, through Edit, Write or the console: the brake tells it to hand the change to a session. Its memory and what is outside the repos pass. Limit, by choice: what a script saved in a file writes from inside is not looked at, because the harness scripts the coordinator runs write its state. |
| A plan for the owner first goes through a separate reviewer | nadie | It is a judgment call: no data separates a plan from any other message. |
| State only what was checked, and measure use before removing something | nadie | It is the coordinator's judgment call. |
| Measure a speed change on a loaded day | nadie | Which change promises speed is said in the message, not in a piece of data. |
| A question's box carries its context inside | nadie | It is the shape of the message: no data on the machine sees it. |
| The record of a control change, at the end | nadie | The session decides when to ask for it; an expired record is stopped by its control, not by when it was asked for. |
| Stories are closed in hours | nadie | It is a judgment call: the session sees which smoke check has a script. |
| First what blocks everyone, then the product's plan | nadie | What blocks everyone is judgment; the quiet sessions are counted by the notice of each turn. |
| Each pending item with who has it and in which pull request | nadie | The note goes in the coordinator's list, which does not go through a control. |
| One push per pull request | nadie | Nothing stops an extra push: the CI queue shows it. |
| Never close a turn with «shall we go on?» | nadie | It is the shape of the message; the coordinator with room and ready work is already stopped by the end-of-turn hook. |
| With the owner away, no box is opened | nadie | Whether the owner is away is the coordinator's judgment; nothing stops a box for that. |
| Ask the owner before running another session's signature | nadie | No control tells a delegated signature the owner wanted to see from a routine one. |
| The record, with the folder still | nadie | The session confirms it in a message; a record that no longer matches is stopped by its control. |
| The record, with the script from the installed copy | nadie | Which copy of the script runs is chosen by whoever writes the command. |

The "Measured by" column keeps the Spanish words the harness uses everywhere: **aviso** (a notice), **freno** (a brake)
and **nadie** (nobody).
