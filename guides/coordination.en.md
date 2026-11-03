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

On being designated, the session is told to read this guide, and it is told again after compacting or clearing its
conversation, because that is when it gets lost. **Clearing the conversation takes away the designation**: for the harness
it is another conversation. The session is told how to get it back, but does not get it back by itself: the owner has to
write the phrase and confirm it again. `/coordinate` in that session shows the machine's status. The program the
coordinator uses is `<harness>/scripts/tools/coordination.js`.

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

**The opened session starts like the coordinator.** It runs in the same permission mode as the coordinator and with
remote control under its name, so the owner can see it and drive it from claude.ai/code or the phone. With different
modes, the new session gets stuck on a permission prompt nobody sees, and the messages from the other sessions are held
back from it; if the owner is also away from the machine, they cannot go in with `claude attach`.

`open` does it by itself: it reads the coordinator's mode and launches the session with `--permission-mode <that mode>`
and `--remote-control <name>`. The mode is not chosen: `open` does not accept `--permission-mode`, so it never opens a
session with more permissions than the coordinator. It does not open, and says so in one line, if it cannot tell the
mode or if the coordinator is in plan mode (the new session would wait for someone to approve its plan). The mode comes
from the coordinator's conversation, which records it with each of the person's messages. **Known limit:** if someone
changes its mode with Shift+Tab and sends no message afterwards, `open` copies the previous mode. A session opened by
hand, or before this change, that got stuck like that, the coordinator stops and relaunches:
`claude --bg --resume <id> -n <name> --permission-mode <its mode> --remote-control <name> -- <task>`. To stop and
remove a background session, use `claude stop <id>` and `claude rm <id>`, with the id that `claude agents` shows: with
the name they answer that they cannot find it (measured on 2026-11-01).

`open` passes the task to the launcher as is, without reviewing it: nothing it says signs anything (see «The owner's
signatures»).

With Codex, the owner opens the sessions: Codex has no launcher for named background sessions.

## Closing a session

The coordinator, or a person in their terminal, closes a session with `coordination.js close --name <name>`. Before
closing it checks four things, and if one is missing it does not close and says which:

1. That it is idle: one running a command is not closed either.
2. That its folder has nothing uncommitted or unpushed.
3. That its branch got into `main`, and so did the branches it left in that folder since it started. In a fixed slot,
   that the slot is released: a slot is released, not deleted.
4. That it has no open run and no open quick fix.

What it cannot look at (a folder it did not record or that is gone, git not answering, an unreadable record) comes out
as «no sé» (I don't know), and it does not close either. With everything clean it runs `claude stop` and `claude rm`
with the session's id.

**An interactive session is not closed.** It is checked all the same and it says so: a person closes that tab.

**Limits.** It looks at the folder the session is in now: it does not see another worktree the session left behind, nor
what was kept with `git stash`. A branch deleted without merging is no longer seen. A branch squashed into one commit
reads as not merged. A worktree of a repo with no working folder comes out as «no sé». `claude stop` and `claude rm` by hand do not go through this.

## The cap: what counts as working

**Working** is a live session whose session file says it is busy. A session waiting for CI, the queue or the owner has
finished its turn: it does not count. Codex sessions do not write that file; they count if they had activity in the
last 5 minutes. A session that `open` opened less than 10 minutes ago counts even if it has not written its file yet.

The cap is `coordination.max_working`, from 1 to 20. The team profile gives the organization's number (on the site,
Configuration tab, "The sessions on each machine"), and each machine can change it for itself, because how much it
can take depends on the machine. With no value anywhere, the cap is 3. `coordination.js status` shows who is working,
who is waiting and why, and the cap with where it comes from.

The cap brakes on every path the agent takes, not only through `open`. Before each command, a brake checks whether the
command opens a background Claude session: `claude --bg`, or `claude` running in the background (`&`, `nohup`, `setsid`,
`tmux new -d`, `screen -dm`, `Start-Process`, the tool's background execution), also wrapped in `env`, `sudo`,
`bash -c`, `pwsh -c` or `cmd /c`. If it opens one and the machine is at the cap, it refuses and gives the `open` command,
which waits its turn. It counts with the same function as `open`. Below the cap it lets the command through and records
the session, so it counts from that moment. If it cannot count (a state file that cannot be read) or cannot record the
session, it refuses as well and names the file. The way out is fixing that file, or the person opening the session from
their terminal: the brake only watches the agent's tools. It has no switch: a person changes the cap.

The coordinator also sees it without asking: on each turn, if the machine is at the cap, a notice tells her who is
working; if it is over, by how much and which one has been working the shortest. Below the cap it says nothing about that,
and no other session sees it. It is turned off with `TYCON_COORDINATION_NOTICE=0`.

The same notice carries two more things:

- **Background sessions sitting idle.** A background session that has gone more than 15 minutes without working shows up
  as "X has been idle for N min: close it or give it work". Not one waiting for its adversarial pass, one that recently
  noted what it is doing (`marker.js doing`), or the one holding the machine's full suite.
- **Ready requests nobody queued, on GitHub.** An open, clean request (no conflict and no required checks pending) with no
  auto-merge and outside the queue, unchanged for more than 10 minutes, shows up with the command to queue it. Why: nobody is
  going to merge it, and everyone thinks it already went in. It comes from the last saved reading, less than an hour old: the
  notice does not go to the network. Requests from a bot do not show up. Not on Azure: without reading its checks, "clean"
  only says it does not conflict.
- **The session waiting for room for its pass.** It has to launch one and another holds the place: it shows up with who holds
  it, and once freed, with "can launch". Nothing wakes it by itself: the coordinator tells it.

## Heavy work takes turns: the full suite and adversarial passes

The machine can run at the same time **one full suite and one adversarial pass or batch of reviewers from another session**:
the pass and the reviewers run in the cloud and barely use the machine. **Never two full suites or two passes at once.**
The harness controls this, not anyone's memory:

- **The second large run does not start.** The turn (`scripts/tools/heavy-turn.js`) is requested by the suite runner, when it
  is about to run 100 suites or more, scoped or not, and by the whole portable run. With the turn held by another live
  process they do not run (the test gate exits 75, its "wait") and they say who holds it, how many suites it runs, since when
  and how to free it. Below 100 suites it is not requested. The turn of a dead process, or one older than three hours, frees itself.
- **The second pass is not launched.** With another in flight, the pass's gate (`pipeline.js deep-review-gate`) exits 3, and
  `pipeline.js next` asks to wait instead of launching. The answer carries `other_in_flight` (story, session and time) and the
  line saying who holds the place. The pass of a closed session does not count.
- **How long the place can take to free up.** Up to an hour too long: the harness knows a pass finished when its session
  collects it, not when it finishes in the cloud. After that hour it no longer stops anything, because it may be finished or
  stuck, and that is said.

`coordination.js status` shows the suite and the pass in progress. With no coordinator designated, everything answers as
always: in CI and in the cloud there is no turn. `TYCON_SUITE_TURN=0` turns off the suite's, and `TYCON_SUITE_TURN=1` asks for
it even with no coordinator: it can only stop too much.

## Signatures, by their three paths

**Before asking for a signature, the coordinator confirms it is still missing.** Asking for a signature of something
already signed makes the owner sign twice. The control signature is confirmed by comparing the signed content with the
branch's.

Then she asks for it through the path that applies:

- **With the owner's click or «aprobado».** Where the window does not reach, this comes first for every signature that
  accepts them. The coordinator shows the options box in her tab, with one question: what is approved, «firma <id>» and,
  if another session signs, «sesión <id>». It leaves no pending entry. The rules are in `guides/firmas-del-arnes.md`,
  «Aprobar sin terminal».
- **Through the owner's terminal**, only what does not accept the click: with `coordination.js signature --kind <topic>
  --title <what is signed> --cwd <folder> -- <command>`. If the machine has a signatures folder (`coordination.owner_folder`, only in the
  machine's file or its variable, never in the profile), it writes one file per signature there,
  `YYYY-MM-DD-<topic>.command` (on Windows, `.cmd`). The owner opens it with a double click: it says what it is in one
  line, goes into the folder, runs the command and waits for a key. If there is already a file with the same command,
  it does not write another one and says so. Without a folder, it writes nothing: it prints the command for the chat
  notice.
- **By delegation.** A signature the organization lets be signed by delegation does not go through `signature`: it is
  given from the coordinator's tab, in the permission window, under the delegated signing rules. It is signed on the
  spot and leaves no pending entry. If delegation does not apply and the coordinator's tab does not ask for permissions,
  the window does not open, because in that tab nobody would say Yes: the signature is refused, and the refusal says how
  to ask for the click or the «aprobado».

What asks for a password always goes through the terminal: only the owner types the password. Once the owner signed,
`coordination.js signature-done <id>` deletes the file and the pending entry. An empty folder and no pending entries
mean nothing is left to sign.

A terminal signature that has waited more than a day is brought up to the coordinator: on the first turn of the day
with something to say, one line says how many are waiting and which is the oldest, with its date. Once a day, even if
the count changes. A pending entry whose file is gone does not count: the owner signed it and deleted it. Without a
signatures folder there are no pending entries, and the notice never shows.

### The signature list: written down and, on coming back, one at a time

With `approvals.signature_list` set to `on`, what waits for the person stays written down in a single record, and `/office`
counts it under «Tu firma». **The list does not sign anything:** a click is still good for one signature and one command. There
is no signing in bulk: each row goes through its own box. With `off`, or without the key, it is as if it did not exist. It is
turned on in the profile, or on the machine to try it out.

- **What gets written down.** The brake writes down the signature it denies with its box to the target session itself. No row
  comes from a request run by another session, a delegated signature, «done and notified», an open window,
  `designation-confirm`, anything irreversible or Codex. What `coordination.js signature` leaves goes in the same record.
- **What closes it.** The signature given for that target, 24 hours, or its session no longer being alive. If the sessions cannot
  be read, it stays.
- **How they go through, with a coordinator.** If the coordinator is confirmed and alive, it passes them all. The background
  session does not show the box or send messages: the brake tells it to wait for the notice. When the person writes, the
  coordinator gets a notice: answer what the person wrote and run `coordination.js owner-next`.
- **How they go through, without a coordinator.** The target session gets the same notice, once per row, and runs `owner-next`.
  If the person already answered «aprobado» to that box, it does not ask again.
- **What `owner-next` gives.** One row, the oldest: a box to show without changing a letter, with a label («Firma 2/5»), and the
  notice for the target session. **A permission goes first**, with its own counter and box. What goes through the terminal comes
  last, with no box. If the plan has not been seen yet in that tab, it gives the plan to write out before the box. If a row
  cannot be shown, or its repetition is denied, `owner-next --after <id>` gives the next one.
- **The session that asked always repeats the command**, with or without a coordinator. On «Sí», the coordinator sends it the
  notice and the session repeats the same command within 30 minutes. With an unused click, `owner-next` skips that row and says
  the repetition is missing.
- **On a «No»:** `coordination.js owner-reject <id>` removes the row and names the session to tell. A box that closes or
  resolves by itself leaves the row, and the pass stops there.

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
owner's behalf is in `guides/firmas-del-arnes.md`.

From her own tab, with `--for-session <D>`, the coordinator requests the signatures the guide marks «sí» under «¿Desde
otra sesión?». Among them: setting a check by hand (`marker.js set-check <control> <estado> --force-manual
--for-session <D>`), counting the reviewers without the record that they ran (`pipeline.js check-count --repo <r>
--story <s> --trust-ran --for-session <D>`) and accepting a criterion that cannot be tested live (`marker.js
runtime-waiver <historia> --acs <n> --for-session <D>`). The story is the one of `<D>`'s open run: otherwise the script
exits without writing. The window opens for the owner in the coordinator's tab (if that tab does not ask for
permissions, it is refused and approved with their click or «aprobado»). All three are level 2, so none can be delegated to
her: the harness rejects a profile that tries (`guides/firmas-del-arnes.md`).

## Saving is authorized in the permission window

Saving a story (commit, push and the pull requests) carries no signature and does not go through the coordinator.
Before saving, the command hook asks the person in that tab, in their permission window; with a yes, it saves. In a tab
that does not ask for permissions, it saves without asking and says so on screen. A message between sessions that
says «ok to save» is not needed and does not skip the window. Sensitive changes are covered by the pull request's
control signature, which is the owner's.

## The quick fix of another tab

The quick fix (a code change with no story) is the `adhoc-lane` signature: the tab that needs it runs
`marker.js adhoc set '<json>'` and the owner approves it in the window, which shows the reason and the file quota.

- **On the same machine.** The designated session declares it for the tab it gave the work to, with
  `marker.js adhoc set '<json>' --for-session <session>`. It runs with no window only if the profile delegates
  `adhoc-lane` (it is in no group: it has to be named), the machine is on the list and the owner confirmed the
  designation; otherwise the window opens in the designated session's tab. Through this path it has three limits, and
  the script and the edit guard check them: the quota is at most 5 files (asking for more is denied, and the guard gives the question box for the owner); the fix never touches anything sensitive
  (the list in `scripts/lib/signatures.js`: signatures, guards, notices, permissions, the profile), which goes with the
  owner's signature; and before it opens, one line reaches the owner through the notice channels, with the
  session, the reason and the quota: with no delivery, there is no fix. The designated session does not declare it
  for itself.
- **From another machine.** The coordinator on another machine asks the designated session of the target machine for it,
  by message, and that session declares it as above. The message is a request, not an authorization: what authorizes
  it is the team profile and the designation the owner confirmed. With no designated session on the target machine, the
  quick fix is approved in the target tab's window.

**Going past the limit does not go through you.** Asking for more than 8 files is the `adhoc-lane:sobre-cupo` signature,
and the developer chooses it: with a click in the question box of the tab doing the work, or in their terminal. A click in
your tab does not count, nor a forwarded «aprobado», nor the delegation; so a background session nobody is watching can only
do it through the terminal. Only the implementation files the fix changed count: what came in from `main`, tests, guides
and probes do not add up. Past the quota, the fix stops on edit and does not save, and the message recommends a story. Limit:
it measures the branch being worked on and what is already on disk. Work built on another branch and pushed by its name, or
created in the same command that pushes, does not add up. That does not let it into `main`, because the pull request still has
its check and its review: it skips the notice, and it takes doing it on purpose. Conversely, on `dev` with `main` brought in and
not pushed, what is already integrated counts too: push it, or choose with the click. A push with something else in the command
(`| cat`, `&& echo`), or written with an alias or a variable in front, also counts what git does not track, even from another session: repeat the push alone. A real route
named `tests`, `e2e`, `cypress` or `playwright` counts as a test, and asks for no mockup. With a fix that has nothing noted yet, a
save in another folder is charged the limit of the session's branch: if it really is not part of that fix, choose with the click.
And in a repo with no commits, a file with `git add -N` that goes up with `git commit -a` does not get the high-risk mark.

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
does not know. The coordinator writes the whole board to `<state>/coordination/tablero.json` (first to a separate file and
then renamed, so the office never reads it half written) every time it changes:

- `pendientes`: a list; each item has `titulo`, `estado` (`hecho`, `curso`, `firma`, `riesgo`, `entrando`, `sin-empezar`, or
  `espera`, which goes to «Sin sesión»; `curso` and `riesgo` go to «En curso» only if a live session is doing it, and otherwise also to «Sin sesión»), `grupo` (`Hoy`, `Esta semana`, `La semana que viene` or `Más adelante`), `orden`,
  `quien`, `nota`, and its time: `pronosticoIso` or `estimadaIso` (local time, `YYYY-MM-DDTHH:MM`), or `termina` with its
  own text. A done item carries `realIso`.
- `historia` (for example `"2.81"`) and `pedido` (`{ "repo": "tycon-harness", "numero": 885 }`), both optional. With
  `historia` and a run of that story on this machine, the row adds no state or time: they come from the run, and the row
  adds its `nota`. With `pedido`, the state comes from asking for it, at most once a minute: open goes to «Esperan
  entrar», with the reason if it is a draft or out of the queue; merged goes to «Terminados» with its merge time. If the query fails,
  the row stays where `estado` says and the reason goes to «No se pudo leer». `repo` is the name of a repo of a run on this
  machine or of one declared in `team-repos.json`. `estado` only counts when there is nowhere else to get it from.
- `meta`: `actualizado`, `resumen` and `teToca` (what the owner has to do, one line each). «Te toca» comes from the
  signatures, the open questions and this list: notes are not read, so what the owner has to do goes here.

«Terminados» is what was done today, with its time; anything older, or with no `realIso`, goes to the «Hechos» table.

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
when it changes). A row of a person who already has a real-state card is not duplicated. The desks do not come from here:
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
- **Heavy things, with a turn.** The full suite, the controls bench, the reviewers' exam and the gate run one at a time on
  the machine, and the turn is asked from the coordinator. The harness also stops the full suite and the pass (above,
  "Heavy work takes turns"). The story the owner marked as a priority goes first in the line. Why: two at once saturate the
  machine and both take longer.
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
- **A red is not left behind, even if it is not from your own change.** Report it and fix it before going on. Why: tolerated
  reds hide the new ones.
- **What loosens a review does not go in, even if it saves time; what is only paperwork is not done.** If the code already
  went in and real use proves it, close it citing that evidence. The exception is code that decides things and was never
  reviewed. This does not skip a signature or a record the harness asks for. Why: quality is worth more than the minutes,
  and a record that finds nothing costs hours.
- **A message for the team is checked sentence by sentence before passing it on.** And devs are bothered as little as
  possible: a fix reaches them by itself; a manual step is the last resort. Why: a false promise reaches every machine.

## What measures each rule

| Rule | Measured by | Why |
|---|---|---|
| Signatures, passwords, product decisions and what leaves the house go to the owner | nadie | What a product decision or a routine release is is a judgment call: no piece of data says it. |
| The sessions' questions go to the coordinator | nadie | There is no notice, by the owner's decision: every working session would see it. The coordinator reminds a session that asks the owner. |
| The coordinator settles details with the safest option | nadie | It is a judgment call, and it is written down for the owner to see. |
| Every session with a name a person gave it | aviso | `/coordinate` lists the ones whose name the tool made up. |
| No more sessions working than the cap | freno | `open` does not open at the cap. Nothing stops a session the owner opens by hand; `status` counts it and, at the cap, so does the coordinator's notice on each turn. |
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
| Heavy things one at a time, with a turn | nadie | The full suite and the adversarial pass have their stop (above); the bench, the exam and the gate do not. |
| Look at the diff before approving someone else's request | nadie | It is the approver's judgment call. |
| A waiting session writes what it is doing | nadie | The session writes it with `marker.js doing`; nothing forces it. |
| Check that a request is still in the queue | nadie | Checking on every turn would mean asking the network all the time. |
| The owner's decisions with their context | nadie | It is a judgment call; the style meter measures length, not content. |
| What the owner sees, without jargon | aviso | The style meter that already exists. |
| The guide reaches the coordinator by itself | aviso | On being designated, and on compacting or clearing the conversation. Nobody measures whether she reads it. |
| The coordinator does not approve what gives her more power | nadie | The profile's control looks at the level of what is delegated, not at who approved the request. |
| Sessions do not write to each other | nadie | A message between sessions does not go through a control. |
| A session does not open a box in its tab | nadie | The session decides it when asking. |
| A stuck session is reported with the recommended answer | aviso | The waiting notice goes out at 5 and at 30 minutes; the coordinator writes the recommendation. |
| Ask the session before saying "your turn" | nadie | What the owner writes in another tab does not reach her. |
| "Your turn" only for what can be done now | nadie | It is the shape of the message. |
| Every request to the owner comes complete | nadie | It is the shape of the message. |
| Ask the session when the owner asks how it is going | nadie | It is the coordinator's judgment call. |
| Check the session that went past double what it said | nadie | The duration was said in a message, not in a piece of data. |
| Size before assigning | nadie | It is the coordinator's judgment call. |
| A session that finishes gets work or is closed | aviso | The notice about idle background sessions, after 15 minutes. |
| A red is not left behind | nadie | The controls stop your own; someone else's red is seen by whoever finds it. |
| Do not loosen a review, do not do paperwork | nadie | It is a judgment call: no data separates a review from paperwork. |
| Check a message for the team | nadie | The message goes out outside the machine. |

The "Measured by" column keeps the Spanish words the harness uses everywhere: **aviso** (a notice), **freno** (a brake)
and **nadie** (nobody).
