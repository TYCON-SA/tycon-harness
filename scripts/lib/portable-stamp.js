#!/usr/bin/env node
'use strict';
/*
 * portable-stamp.js — la constancia de que las portables dieron verde sobre un árbol, y si un cambio la necesita.
 *
 * POR QUÉ. Un pedido del arnés que toca el instalador entra a la cola, la CI de la cola corre las portables del
 * instalador, y si una da rojo el pedido se cae de la cola y frena a los que venían detrás. Correrlas ANTES de encolar
 * cuesta ~6 minutos en la máquina de quien encola; el rojo en la cola cuesta la cola entera.
 *
 * LA CONSTANCIA. scripts/tests/portable-suites.test.sh, cuando corre ENTERA (sin TYCON_PORTABLE_ONLY, _SKIP, _SHARD ni
 * _ALL) y da verde, anota el árbol de HEAD (`HEAD^{tree}`) en `portable-stamps.json` de la carpeta de estado. Sólo si
 * los archivos que git sigue no tenían cambios sin commitear, y si el árbol era el mismo al empezar y al terminar: lo
 * que se midió es exactamente lo que va en el commit. Es el árbol y no el commit: un rebase que no cambia el contenido
 * no pide correrlas de nuevo; uno que lo cambia, sí.
 *
 * QUIÉN LA NECESITA. Un cambio que toca lo que miden las suites del grupo `installer` de scripts/ci/heavy-suites.json,
 * con el mismo criterio con que la CI elige si correrlas (`groupCriterion` de scripts/ci/suites-for-change.js): las
 * que la CI saltearía no piden constancia. El cambio es lo que la rama trae sobre origin/main (`origin/main...HEAD`).
 *
 * Lo usa el freno de scripts/hooks/pr-auto-complete-guard.js. A mano:
 *   node scripts/lib/portable-stamp.js check [<repo>]   dice si el árbol de HEAD la necesita y si la tiene
 *   node scripts/lib/portable-stamp.js record <repo>    la anota (lo llama la corrida de las portables)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ARCHIVO = 'portable-stamps.json';
const MAX_ARBOLES = 30;
const BASE = 'origin/main';

// la carpeta del estado la sabe tycon-home.js; se carga al usarla, no al cargar este archivo
const archivoDe = (home) => path.join(require('../setup/harness/tycon-home.js').stateDir(home || os.homedir()), ARCHIVO);

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10000 });
  if (r.error || r.status !== 0) return { problem: `git ${args[0]}: ${String((r.error && r.error.message) || r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`}` };
  return { out: r.stdout };
}

/** El árbol de HEAD, y si lo que git sigue tiene cambios sin commitear: `{ tree, dirty }` o `{ problem }`. */
function arbolDe(repo) {
  const t = git(repo, ['rev-parse', 'HEAD^{tree}']);
  if (t.problem) return t;
  const s = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (s.problem) return s;
  return { tree: t.out.trim(), dirty: s.out.trim() !== '' };
}

function leer(home) {
  try {
    const d = JSON.parse(fs.readFileSync(archivoDe(home), 'utf8'));
    return d && typeof d === 'object' && d.trees && typeof d.trees === 'object' ? d : { trees: {} };
  } catch { return { trees: {} }; }
}

/** Anota el árbol como verde. `{ ok: true, tree }` o `{ ok: false, why }`. */
function anotar(tree, home) {
  if (!/^[0-9a-f]{40,64}$/.test(String(tree))) return { ok: false, why: `«${tree}» no es un árbol de git` };
  const d = leer(home);
  d.trees[tree] = { at: new Date().toISOString() };
  // los más nuevos: la constancia es de un árbol, no un historial
  d.trees = Object.fromEntries(Object.entries(d.trees).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, MAX_ARBOLES));
  try {
    fs.mkdirSync(path.dirname(archivoDe(home)), { recursive: true });
    const tmp = `${archivoDe(home)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
    fs.renameSync(tmp, archivoDe(home));
  } catch (e) { return { ok: false, why: `no pude escribir ${archivoDe(home)} (${e.code || e.message})` }; }
  return { ok: true, tree };
}

/**
 * ¿El cambio de la rama toca el instalador? `{ touches: [suites], files }` (lista vacía: no lo toca) o `{ problem }`.
 * Fuera de un repo del arnés (sin scripts/ci/heavy-suites.json) no aplica: `{ notHarness: true }`.
 */
function toca(repo) {
  const heavy = path.join(repo, 'scripts', 'ci', 'heavy-suites.json');
  const selector = path.join(repo, 'scripts', 'ci', 'suites-for-change.js');
  if (!fs.existsSync(heavy) || !fs.existsSync(selector)) return { notHarness: true };
  const d = git(repo, ['diff', '--name-only', `${BASE}...HEAD`]);
  if (d.problem) return { problem: `no pude listar lo que trae la rama sobre ${BASE} (${d.problem})` };
  const files = d.out.split('\n').filter(Boolean);
  let crit;
  let nombres;
  try {
    crit = require(selector).groupCriterion(heavy, 'installer');
    nombres = Object.entries(JSON.parse(fs.readFileSync(heavy, 'utf8')).suites || {}).filter(([, v]) => v && v.group === 'installer').map(([k]) => k);
  } catch (e) { return { problem: `no pude leer el criterio del instalador (${String((e && e.message) || e).split('\n')[0]})` }; }
  if (crit.problem) return { problem: crit.problem };
  if (!nombres.length) return { problem: `${heavy} no trae suites del grupo «installer»` };
  return { touches: nombres.filter((n) => !crit.skips(n, files)), files };
}

/**
 * El veredicto para encolar desde `repo`: `{ needed: false }` si no la necesita, `{ needed: true, ok: true, at }` si la
 * tiene, `{ needed: true, ok: false, why }` si falta, o `{ problem }` si no se pudo saber.
 */
function veredicto(repo, home) {
  const t = toca(repo);
  if (t.notHarness) return { needed: false, notHarness: true };
  if (t.problem) return { problem: t.problem };
  if (!t.touches.length) return { needed: false };
  const a = arbolDe(repo);
  if (a.problem) return { problem: a.problem };
  const sello = leer(home).trees[a.tree];
  if (sello) return { needed: true, ok: true, tree: a.tree, at: sello.at, suites: t.touches };
  return { needed: true, ok: false, tree: a.tree, suites: t.touches,
    why: `no hay constancia de las portables en verde para el árbol ${a.tree.slice(0, 12)} de HEAD` };
}

module.exports = { arbolDe, anotar, toca, veredicto, archivoDe };

if (require.main === module) {
  const [verbo, repoArg, extra] = process.argv.slice(2);
  const repo = path.resolve(repoArg || process.cwd());
  if (verbo === 'record') {
    // `record <repo> <árbol del principio>`: anota sólo si el árbol no cambió en el medio y no había cambios sin commitear
    const a = arbolDe(repo);
    if (a.problem) { console.log(`suites-portables: sin constancia (${a.problem})`); process.exit(0); }
    if (a.dirty) { console.log('suites-portables: sin constancia: hay cambios sin commitear, lo medido no es lo que va en el commit'); process.exit(0); }
    if (extra && extra !== a.tree) { console.log('suites-portables: sin constancia: el árbol cambió mientras corrían'); process.exit(0); }
    const r = anotar(a.tree, os.homedir());
    console.log(r.ok ? `suites-portables: constancia anotada para el árbol ${r.tree.slice(0, 12)} (encolar lo pide si el cambio toca el instalador)` : `suites-portables: sin constancia (${r.why})`);
    process.exit(0);
  }
  if (verbo === 'check') {
    const v = veredicto(repo, os.homedir());
    if (v.problem) { console.log(`no sé: ${v.problem}`); process.exit(1); }
    if (!v.needed) { console.log(v.notHarness ? 'no aplica: no es un repo del arnés' : 'no la necesita: el cambio no toca el instalador'); process.exit(0); }
    console.log(v.ok ? `la tiene: portables en verde para el árbol ${v.tree.slice(0, 12)} (${v.at})` : `falta: ${v.why}`);
    process.exit(v.ok ? 0 : 1);
  }
  console.error('uso: portable-stamp.js check [<repo>] | record <repo> [<árbol del principio>]');
  process.exit(2);
}
