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
opening it checks three things, in order, and if one fails it does not open and says why:

1. The name: only letters, digits, hyphen and underscore, and not used by another live session.
2. The task: if it carries a permission phrase from the owner, it does not open (see "The owner's phrase").
3. The cap: if as many sessions as the cap are already working, it does not open.

`open` never retries. If the tool refuses because nobody approved the folder, it says in one line which folder the
owner has to open once; meanwhile, the owner opens the session and the coordinator gives it the task. The approval
belongs to a person: the agent does not write it. The other failures also take one line: the launcher is not
installed, the first line of its error, or it did not come back within 30 seconds. A failed opening does not count
toward the cap.

**Measured limit:** approving a folder does not cover the folders inside it, so each new worktree asks for its own
approval. In practice, the first time the coordinator opens a session in a new worktree, `open` answers that the
folder still needs approving.

**Not measured yet, left as the owner's test:** how long a session opened in the background takes to show up, and what
title the editor tab shows after `/rename`. The guide takes neither for granted.

`open` looks at the task before passing it to the launcher. A program that launches another session straight from the
console is outside that check: the brake looks at the agent's tools, not at what one program passes to another.

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
- **By delegation.** A signature the organization lets be signed by delegation is asked for in the chat, without a
  file: the owner gives their ok with their quote and the signature is made under the delegated signing rules. Today
  `signature` does not take this path yet: every signature goes through the terminal.

What asks for a password always goes through the terminal: only the owner types the password. Once the owner signed,
`coordination.js signature-done <id>` deletes the file and the pending entry. An empty folder and no pending entries
mean nothing is left to sign.

## The order of the requests

Requests to the public repo go in through its queue. The private repo's requests start as drafts, and the coordinator
publishes them in order, once their public pair is in.

## The owner's phrase

A permission phrase from the owner ("autorizo …") is written by the owner, in their chat. If another session writes or
forwards it, the permission no longer proves a person gave it. That is why the coordinator never puts it in a message
to another session, and `open` does not open a session whose task carries it, not even quoted: the owner writes the
phrase in the new session.

Forwarding a dev's ok with their quote is not a permission phrase and works as always.

## The notices to the owner

Short and plain: what happened, what is missing and what the owner decides, in that order. One notice per batch of
work, not one per session. The style meter that already exists measures this; this recipe does not add another one.

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
| One file per signature, deleted once signed | aviso | `status` counts the pending signatures; `signature` does not write a second file with the same command. |
| Requests in order | nadie | No data on the machine says which request pairs with which without asking the network on every turn. |
| Another session does not write the owner's phrase | freno | `open` does not open a session whose task carries it. Nothing checks a message between sessions yet. |
| Short and plain notices | aviso | The style meter that already exists. |
| Codex does not coordinate | aviso | `/coordinate` says so in Codex and stops. Codex can send messages with codex queue, but that command does not go through a tool the phrase brake can see. |

The "Measured by" column keeps the Spanish words the harness uses everywhere: **aviso** (a notice), **freno** (a brake)
and **nadie** (nobody).
