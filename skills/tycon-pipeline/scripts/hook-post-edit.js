#!/usr/bin/env node
// tycon hook entry — PostToolUse matcher Edit|Write (dispatcher).
// Path único para que el installer lo registre como hook plano (sin args).
// Corre el control de la integración de horas elegida + on-edit (advisory) en UN solo proceso node.
// Los hooks de una integración que corren en cada tool, de fondo, no van acá: son hooks aparte.
require('./dispatch.js').dispatch('post-edit');
