#!/usr/bin/env node
'use strict';
/**
 * story-number.js — el número de una historia nueva, mirando todo lo que otra sesión pudo haber tomado.
 *
 *   node story-number.js next --repo <repo de historias> --epic <n> [--specs <carpeta>] [--no-fetch]
 *
 * Mirar sólo `main` no alcanza: dos sesiones de la misma máquina escriben a la vez, y la historia de la otra vive en su
 * worktree sin empujar, o en una rama sin pedido. Esto junta los números de la épica de cuatro lugares:
 *   1. `origin/main`: los archivos de historia de la carpeta y los renglones de `sprint-status.yaml`;
 *   2. cada rama remota (después de traerlas): sus archivos de historia, y el número que nombra la rama;
 *   3. cada worktree del repo en esta máquina: su carpeta de historias en disco, con lo que no está commiteado;
 *   4. la carpeta de este clon, también en disco.
 * Un pedido abierto sale siempre de una rama remota: por eso no se pregunta aparte.
 *
 * Imprime JSON `{ epic, next, used, doubts }` y sale 0 si el número es seguro, 3 si hay duda (una rama que nombra un
 * número sin historia, ramas que no se pudieron traer, un worktree que no se pudo leer) y 2 si la llamada está mal.
 * Con duda, `next` igual dice el número que saldría, pero la skill no lo asigna sola: lo pregunta.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// `story-<épica>.<n>-<título>.md` (formato del arnés) o `<épica>-<n>-<título>.md` (formato de BMAD)
function numberOfFile(name, epic) {
  const m = String(name).match(/^(?:story-)?(\d+)[.-](\d+)[-.]/i);
  if (!m || m[1] !== String(epic)) return null;
  return Number(m[2]);
}

// el número de la épica que nombra una rama, con punto o guion (`<épica>.<n>` o `<épica>-<n>`), en cualquier lugar del nombre
function numbersOfBranch(ref, epic) {
  const out = [];
  const re = new RegExp(`(?:^|[^\\d])${epic}[.-](\\d+)(?!\\d)`, 'g');
  for (const m of String(ref).matchAll(re)) out.push(Number(m[1]));
  return out;
}

// renglones `8-153-titulo: draft` de sprint-status.yaml
function numbersOfSprintStatus(text, epic) {
  const out = [];
  const re = new RegExp(`^\\s*${epic}-(\\d+)-[\\w-]*\\s*:`, 'gm');
  for (const m of String(text || '').matchAll(re)) out.push(Number(m[1]));
  return out;
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim() };
}

function filesOfRef(repo, ref, specs) {
  const r = git(repo, ['ls-tree', '-r', '--name-only', ref, '--', specs]);
  return r.ok ? r.out.split('\n').filter(Boolean).map((f) => path.posix.basename(f)) : null;
}

function filesOnDisk(dir) {
  try { return fs.readdirSync(dir); } catch (_) { return null; }
}

function collect({ repo, epic, specs = 'specs', fetch = true }) {
  const used = [];
  const doubts = [];
  const add = (n, where) => { if (Number.isInteger(n)) used.push({ n, where }); };

  if (fetch) {
    const f = git(repo, ['fetch', '--quiet', '--prune', 'origin']);
    if (!f.ok) doubts.push(`no pude traer las ramas remotas (${f.err.split('\n')[0] || 'sin detalle'}): una historia de otra sesión puede faltar`);
  }

  // 1 y 2: main y las ramas remotas
  const refs = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  if (!refs.ok) doubts.push(`no pude listar las ramas remotas (${refs.err.split('\n')[0]})`);
  const branchNumbers = [];
  for (const ref of refs.ok ? refs.out.split('\n').filter((r) => r && !/\/HEAD$/.test(r)) : []) {
    const files = filesOfRef(repo, ref, specs);
    if (files) for (const f of files) add(numberOfFile(f, epic), ref);
    for (const n of numbersOfBranch(ref.replace(/^[^/]+\//, ''), epic)) branchNumbers.push({ n, ref });
    const sprint = git(repo, ['show', `${ref}:${specs}/sprint-status.yaml`]);
    if (sprint.ok) for (const n of numbersOfSprintStatus(sprint.out, epic)) add(n, `${ref} (sprint-status)`);
  }

  // 3 y 4: los worktrees de la máquina, este clon incluido, en disco
  const wt = git(repo, ['worktree', 'list', '--porcelain']);
  const trees = wt.ok ? wt.out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)) : [repo];
  if (!wt.ok) doubts.push(`no pude listar los worktrees (${wt.err.split('\n')[0]})`);
  for (const t of trees) {
    const dir = path.join(t, specs);
    const files = filesOnDisk(dir);
    if (files === null) {
      if (fs.existsSync(t)) continue; // un worktree sin carpeta de historias: no tiene ninguna
      doubts.push(`el worktree ${t} figura y no está en disco`);
      continue;
    }
    for (const f of files) add(numberOfFile(f, epic), t);
    let sprint = null;
    try { sprint = fs.readFileSync(path.join(dir, 'sprint-status.yaml'), 'utf8'); } catch (_) { /* sin sprint-status */ }
    for (const n of numbersOfSprintStatus(sprint, epic)) add(n, `${t} (sprint-status)`);
  }

  const max = used.reduce((m, u) => Math.max(m, u.n), 0);
  // una rama que nombra un número que ninguna historia tiene: otra sesión pudo haberlo tomado
  const known = new Set(used.map((u) => u.n));
  for (const b of branchNumbers) {
    if (!known.has(b.n) && b.n >= max) doubts.push(`la rama ${b.ref} nombra ${epic}.${b.n} y no encontré esa historia`);
  }
  const top = Math.max(max, ...branchNumbers.map((b) => b.n), 0);
  return { epic: String(epic), next: `${epic}.${top + 1}`, used, doubts };
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const cmd = argv[0];
  const repo = arg(argv, '--repo');
  const epic = arg(argv, '--epic');
  if (cmd !== 'next' || !repo || !/^\d+$/.test(String(epic || ''))) {
    process.stderr.write('uso: story-number.js next --repo <repo de historias> --epic <n> [--specs <carpeta>] [--no-fetch]\n');
    return 2;
  }
  if (!fs.existsSync(repo)) { process.stderr.write(`story-number.js: no existe ${repo}\n`); return 2; }
  const r = collect({ repo: path.resolve(repo), epic, specs: arg(argv, '--specs') || 'specs', fetch: !argv.includes('--no-fetch') });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  return r.doubts.length ? 3 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { collect, numberOfFile, numbersOfBranch, numbersOfSprintStatus, main };
