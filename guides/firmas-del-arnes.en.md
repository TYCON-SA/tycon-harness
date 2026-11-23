# The owner's signatures

Some harness steps cannot be approved by the agent doing the work. This page says who gives each one. The full list,
with every signature by name, the levels and how to approve without a terminal, is in Spanish:
[firmas-del-arnes.md](firmas-del-arnes.md).

The team profile decides with two lists:

- `approvals.delegated_signing`: the **routine** signatures. The **harness gives them on its own**, in any session and on
  any machine, with or without a coordinator.
- `approvals.owner_only`: the signatures only the owner gives. A signature cannot be in both lists: if it is, the routine
  list reads as broken and none goes out on its own.

## The harness gives the routine signatures

A signature the profile lists in `approvals.delegated_signing` reaches nobody: it opens no permission window or box and
does not wait for the coordinator. The harness gives it on its own, in the session that asks for it (also for itself), in
harness sessions and product sessions, on any machine, with no list of machines.

- **The same content check as before.** Each script checks its own thing before signing without a person: the plan, with
  the automatic review approved on that same plan, and never the plan of a delicate story (that plan and its mockup, only
  with the owner's click or «approved», even if the profile names `plan-approval:delicada`); the comparison with main, that the story is not delicate; the save,
  with a clean story; the short path, within its allowance and with no high-risk paths; the pending item, on a repo where
  the session works. If that check says no, the signature goes to a person as always, and the window says why it did not
  go out on its own.
- **The harness writes the record, not the agent.** It stays in the common signature log with via `automatic`, signer
  «arnés (firma de trámite)», who asked, for which session and what was signed. The session console shows a one-line
  notice. The state folder and the log stay protected: the agent does not write them.
- **The lists change only in the team profile**, with a pull request to that repo. An organization that wants to give a
  signature back to the person removes it from `approvals.delegated_signing` or adds it to `approvals.owner_only`.
- **What stays with a person**: changing the controls (`control-change`), what cannot be undone and production (all of
  level 3, with the emergency), turning off a guard or skipping the tests or the adversarial pass (all of
  `approvals.owner_only`: `TYCON_NEW_NAMES`, `TYCON_TEST_GATE`, `DOD_BYPASS`, `adversarial-skip`, `no-deep-review` and
  the rest), naming or removing the coordinator, and answering «skip» or «wait» to the question of reviewing a plan
  or of running the adversarial pass (`plan-review-answer`, `code-review-answer`: only the owner's click or terminal). None of those goes out on its own even if a profile lists it.
- **The routine escapes** (the `escape:…` entries in the list, which go through the safety guard) also go out on their
  own, each in its usual form and with no other signature in the same command. The safety guard writes their record with
  via `automatica`, and it counts for what asks for it later (closing as debt, the expected red of the matrix).
