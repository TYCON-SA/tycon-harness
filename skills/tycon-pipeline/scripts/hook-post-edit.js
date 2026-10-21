#!/usr/bin/env node
// tycon hook entry — PostToolUse matcher Edit|Write (dispatcher).
// Path único para que el installer lo registre como hook plano (sin args).
// Corre clocki-enforce + on-edit (ambos advisory) en UN solo proceso node.
// NOTA: touch-activity (all-tools, async) NO va acá — queda como hook separado.
require('./dispatch.js').dispatch('post-edit');
