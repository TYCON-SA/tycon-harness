#!/usr/bin/env node
'use strict';
// harness-tree.js — la huella del código que mide un pipeline de operaciones, y la guarda que la compara (story 8.30).
//
// Uso:  node scripts/ci/harness-tree.js --tree --repo <checkout>
//       node scripts/ci/harness-tree.js --check-tree [--worktree] --repo <checkout>     (la huella esperada, en HARNESS_TREE)
//
// POR QUÉ EXISTE. Los pipelines de operaciones (pipelines/operations/) arman su árbol con el arnés y le ponen encima los
// datos y la configuración de la organización. Antes de medir y antes de guardar comprueban que el código siga siendo el
// que se armó: un paso que vuelva el checkout a otra rama dejaría la noche en verde midiendo otro árbol (pasó: un guion
// hacía `git checkout -B main origin/main` antes de medir). `push-nightly-data.js save` corre esta guarda antes de empujar.
//
// QUÉ ES LA HUELLA: `<sha256>@<commit>`. El sha256 es el del listado del commit (`git ls-tree -r`) SIN los datos de la
// noche; el commit es el de HEAD. Dos commits que sólo difieren en datos tienen la misma huella: guardar no la mueve.
// Datos = `.git`, `.dashboard/`, `inbox/`, `.engram/`, `.advisors/`, `artifacts/` y `scripts/controls-bench/ultimo-*.json`.
// Es la misma forma y la misma lista que usa la superposición del equipo que mantiene el arnés: un árbol armado de las
// dos maneras se compara igual.
//
// `--check-tree` sale 1, nombrando hasta diez archivos, si el código de HEAD ya no es el de HARNESS_TREE; con
// `--worktree` mira además que el disco sea el de HEAD (antes de medir; antes de guardar no: las suites dejan el árbol
// sucio). Sin HARNESS_TREE, o con otra forma, sale 2: sin huella no se da el árbol por bueno.
//
// Salida: 0 bien (la huella con --tree) · 1 no pudo, o el árbol cambió (el motivo en stderr) · 2 uso o sin huella.
// Casos: scripts/tests/harness-tree.test.js.
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DATA_DIRS = ['.git', '.dashboard', 'inbox', '.engram', '.advisors', 'artifacts'];
const DATA_FILE = /^scripts\/controls-bench\/ultimo-[^/]*\.json$/;
const TREE_MARK = /^([0-9a-f]{64})@([0-9a-f]{40}(?:[0-9a-f]{24})?)$/;

class Red extends Error {}

const isData = (rel) => DATA_DIRS.some((p) => rel === p || rel.startsWith(`${p}/`)) || DATA_FILE.test(rel);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Los nombres que van a un mensaje terminan en el log de Azure: una sola línea, sin controles ni órdenes de Azure.
function plain(value, max = 160) {
  const s = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/##vso/gi, '## vso');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
const some = (list, n = 10) => `${list.slice(0, n).map((x) => plain(x, 600)).join(', ')}${list.length > n ? ', …' : ''}`;

function git(dir, args, env) {
  const r = spawnSync('git', ['-C', dir, ...args], { env, maxBuffer: 1 << 30 });
  return { ok: r.status === 0, out: r.stdout ? r.stdout.toString('utf8') : '', err: r.stderr ? r.stderr.toString('utf8').trim() : String(r.error || '') };
}
function gitOrRed(dir, args, what, env) {
  const r = git(dir, args, env);
  if (!r.ok) throw new Red(`${what}: ${r.err.split('\n')[0] || 'git falló sin decir por qué'}`);
  return r.out;
}
// La salida de un git con -z, partida por NUL y sin recortar: un nombre puede empezar o terminar con un espacio.
const gitZ = (dir, args, what, env) => gitOrRed(dir, args, what, env).split('\0').filter(Boolean);

/** La huella del código de `rev` en `repo`. → { code, message, tree } */
function treeOf({ repo, rev = 'HEAD', env = process.env } = {}) {
  try {
    if (!repo) throw new Red('falta --repo');
    const commit = gitOrRed(repo, ['rev-parse', '--verify', `${rev}^{commit}`], `no pude leer el commit de ${repo}`, env).trim();
    const code = gitZ(repo, ['ls-tree', '-r', '-z', '--full-tree', commit], `no pude listar el commit ${commit.slice(0, 12)}`, env)
      .filter((e) => !isData(e.slice(e.indexOf('\t') + 1)));
    if (!code.length) throw new Red(`el commit ${commit.slice(0, 12)} no trae ningún archivo de código`);
    const tree = `${sha256(code.join('\0'))}@${commit}`;
    return { code: 0, message: tree, tree };
  } catch (e) {
    return { code: 1, message: e instanceof Red ? e.message : `no pude leer la huella del árbol: ${e.message}`, tree: null };
  }
}

/** ¿El código de HEAD sigue siendo el de `expect`? Con `worktree`, además: ¿el disco es el de HEAD? → { code, message } */
function guardTree({ repo, expect, worktree = false, env = process.env } = {}) {
  const m = TREE_MARK.exec(String(expect || ''));
  if (!repo || !m) {
    return { code: 2, message: `no hay con qué comparar: falta HARNESS_TREE, o no tiene forma de huella (${expect ? 'vino otra cosa' : 'vacía'}). La deja la plantilla que arma el árbol; sin ella no se da el árbol por bueno` };
  }
  try {
    const now = treeOf({ repo, env });
    if (now.code !== 0) throw new Red(now.message);
    const [, wasHash, wasCommit] = m;
    const [nowHash, nowCommit] = now.tree.split('@');
    // sin detección de renombres: un archivo de código movido a una carpeta de datos se vería sólo por su destino
    const names = (args, what) => gitZ(repo, ['diff', '--name-only', '--no-renames', '-z', ...args], what, env).filter((p) => !isData(p));
    if (nowHash !== wasHash) {
      let changed = [];
      if (git(repo, ['cat-file', '-e', `${wasCommit}^{commit}`], env).ok) changed = names([wasCommit, nowCommit], 'no pude comparar los dos commits');
      throw new Red(`el árbol que se mide ya no es el que se armó: HEAD era ${wasCommit.slice(0, 12)} y es ${nowCommit.slice(0, 12)}, con otro código${changed.length ? ` (${changed.length} archivo(s): ${some(changed)})` : ''}. Algún paso movió el checkout: lo que se mida o se guarde desde acá no es el arnés que dice la corrida`);
    }
    if (worktree) {
      // lo cambiado o borrado sin commitear, y lo que está de más sin que el .gitignore lo ignore
      const dirty = names(['HEAD', '--'], 'no pude comparar el disco con HEAD');
      const extra = gitZ(repo, ['ls-files', '--others', '--exclude-standard', '-z'], 'no pude listar lo que el disco trae de más', env).filter((p) => !isData(p));
      const off = [...dirty, ...extra.map((p) => `${p} (de más)`)];
      if (off.length) throw new Red(`el código del disco ya no es el del commit que se mide (${nowCommit.slice(0, 12)}): ${off.length} archivo(s) cambiados sin commitear, o de más: ${some(off)}`);
    }
    return { code: 0, message: `el árbol sigue siendo el que se armó (${nowCommit.slice(0, 12)}${worktree ? ', y el disco también' : ''})` };
  } catch (e) {
    return { code: 1, message: e instanceof Red ? e.message : `no pude comprobar el árbol: ${e.message}` };
  }
}

function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let mode = null;
  let repo = null;
  let worktree = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tree' || a === '--check-tree') {
      if (mode && mode !== a) { stderr.write('harness-tree: --tree y --check-tree no van a la vez\n'); return 2; }
      mode = a;
    } else if (a === '--repo') {
      if (argv[i + 1] === undefined) { stderr.write('harness-tree: --repo necesita un valor\n'); return 2; }
      repo = argv[++i];
    } else if (a === '--worktree') worktree = true;
    else { stderr.write(`harness-tree: no conozco «${plain(a)}»\n`); return 2; }
  }
  if (!mode || !repo || (worktree && mode !== '--check-tree')) {
    stderr.write('uso: node scripts/ci/harness-tree.js --tree --repo <checkout>\n'
      + '     node scripts/ci/harness-tree.js --check-tree [--worktree] --repo <checkout>      (la huella esperada, en HARNESS_TREE)\n');
    return 2;
  }
  const r = mode === '--tree' ? treeOf({ repo, env }) : guardTree({ repo, expect: env.HARNESS_TREE, worktree, env });
  if (r.code === 0) stdout.write(`${r.message}\n`);
  else stderr.write(`harness-tree: ${r.message}\n`);
  return r.code;
}

module.exports = { treeOf, guardTree, isData, main, DATA_DIRS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
