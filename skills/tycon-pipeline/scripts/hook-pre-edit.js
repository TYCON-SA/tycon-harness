#!/usr/bin/env node
// tycon hook entry — PreToolUse matcher Edit|Write.
// Path único para que el installer lo registre como hook plano (sin args).
// Corre on-frontmatter-write (DoD gate, puede bloquear) + on-write-collision (advisory)
// en UN solo proceso node. Ver dispatch.js.
require('./dispatch.js').dispatch('pre-edit');
