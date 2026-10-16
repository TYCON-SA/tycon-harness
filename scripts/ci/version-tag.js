#!/usr/bin/env node
'use strict';
/**
 * scripts/ci/version-tag.js — el número de versión lo pone el merge, no cada pedido.
 *
 * POR QUÉ EXISTE. Una máquina instalada sabe si hay algo nuevo comparando números `AAAA.MM.DD.N`. Cuando cada pedido
 * subía `version.json` a mano por encima de `main`, dos pedidos en paralelo tomaban el mismo número: la cola de merge
 * los combina sin choque (es el mismo cambio en la misma línea) y `main` quedaba dos veces con el mismo número, y una
 * máquina sin clon no bajaba el segundo. El número ahora sale de una ETIQUETA `v<número>` que se pone sobre cada merge
 * a `main` después de que entra: nadie empuja a `main` por fuera de la cola; sólo se etiqueta lo que ya entró.
 *
 * LA TRANSICIÓN. `version.json` gana `numbering: "merge-tag"` y su `version` queda FIJO: es el piso. Una máquina con el
 * código de antes sólo mira ese archivo: el pedido que trae este cambio lo sube una última vez, así esa máquina ve un
 * número mayor, baja, y lo que baja ya lee etiquetas. Las etiquetas arrancan por encima del piso.
 *
 *   tag --sha <commit>          (lo corre .github/workflows/version-tag.yml en cada push a main) trae `main` y las
 *                               etiquetas; si `<commit>` ya no es la punta de `main`, no hace nada (la corrida del merge
 *                               siguiente numera la punta); si ya tiene etiqueta, tampoco; si no, crea `v<número>` y la
 *                               empuja. `--dry-run` dice qué haría sin crear ni empujar.
 *   check-pr --base <rev> --tip <rev>
 *                               el paso `version` de scripts/ci/public-ci.sh: con la marca en la base, el pedido no
 *                               cambia el número ni la marca; sin la marca (antes de la transición), el número tiene que
 *                               SUBIR, como siempre.
 *
 * EL NÚMERO. La fecha es la de hoy en UTC, pero nunca anterior a la de la última etiqueta ni a la del piso (un reloj
 * atrasado no da un número menor); `N` es 1 más el mayor `N` de esa fecha entre las etiquetas y el piso. Las corridas
 * no se pisan (`concurrency`): corre una por vez, y GitHub deja UNA sola esperando —la nueva reemplaza a la que
 * esperaba—; como cada corrida numera la punta de `main`, la reemplazada no hace falta. Dos merges nunca toman el mismo
 * número. Si la corrida de la punta no existió (Actions caído), se corre a mano desde la pestaña Actions
 * (`workflow_dispatch` sobre main): numera la punta.
 *
 * SALIDAS. 0 = hecho (etiquetó, o no le tocaba) · 1 = rojo (check-pr: el pedido toca lo que no debe) · 2 = no pude
 * (git falló, un `version.json` ilegible): nunca es un verde.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const VO = require(path.join(__dirname, '..', 'setup', 'harness', 'version-order.js'));

const VERSION_FILE = 'version.json';

/** La mayor de dos fechas `YYYY.MM.DD` (tienen largo fijo: se comparan como texto). */
const laterDay = (a, b) => (a >= b ? a : b);

/**
 * El número de la etiqueta que sigue. `today` (`YYYY.MM.DD`), `tags` (nombres de etiquetas: las que no son de número no
 * cuentan), `floor` (el `version` de `version.json`, o null).
 */
function nextNumber({ today, tags = [], floor = null }) {
  const known = (tags || []).map(VO.fromTag).filter(Boolean);
  if (floor && VO.isOrdered(floor)) known.push(floor);
  let date = today;
  for (const v of known) date = laterDay(date, VO.parts(v).day);
  return VO.next(date, known);
}

/**
 * Qué hacer con un commit recién llegado a `main`: `{ action: 'tag', name, version }` o `{ action: 'skip', reason }`.
 * `tipTags`: las etiquetas que ya apuntan a ese commit; `isTip`: si sigue siendo la punta de `main`.
 */
function decide({ sha, isTip, tipTags = [], today, tags = [], floor = null }) {
  const own = VO.bestTag(tipTags);
  if (own) return { action: 'skip', reason: `${String(sha).slice(0, 7)} ya tiene su número (${VO.tagName(own)})` };
  if (!isTip) return { action: 'skip', reason: `${String(sha).slice(0, 7)} ya no es la punta de main: la corrida del merge siguiente numera la punta` };
  const version = nextNumber({ today, tags, floor });
  return { action: 'tag', name: VO.tagName(version), version };
}

/**
 * El paso `version` de la CI pública, sobre los dos `version.json` ya leídos (`null` = ese commit no lo trae).
 * `{ ok: true|false, blocked?: true, line }`.
 */
function checkPr(base, tip) {
  if (tip === null) return { ok: false, blocked: true, line: 'no pude correr: la punta no trae version.json' };
  if (base === null) return { ok: true, line: `version: la base no trae version.json; la punta dice ${tip.version}` };
  if (VO.numberedByTag(base)) {
    if (!VO.numberedByTag(tip)) return { ok: false, line: `version: la punta le saca a version.json la marca «numbering: ${VO.NUMBERING_BY_TAG}»: el número lo pone la etiqueta del merge, y sin la marca las máquinas no lo saben` };
    if (tip.version !== base.version) return { ok: false, line: `version: la punta dice ${tip.version} y la base ${base.version}: el número lo pone el merge (una etiqueta), el pedido no toca version.json` };
    return { ok: true, line: `version: el número lo pone el merge; version.json sigue en ${base.version} (el piso)` };
  }
  const cmp = VO.compare(tip.version, base.version);
  if (!VO.isOrdered(tip.version)) return { ok: false, line: `version: «${tip.version}» no tiene la forma AAAA.MM.DD.N` };
  if (cmp === null) return { ok: false, blocked: true, line: `no pude correr: la versión de la base, «${base.version}», no tiene la forma AAAA.MM.DD.N` };
  if (cmp > 0) return { ok: true, line: `version: ${base.version} → ${tip.version}` };
  return { ok: false, line: `version: la punta dice ${tip.version} y la base ${base.version}: cada pedido sube la versión (merge-pr.js bump-version, lo hace la skill de merge)` };
}

// ── git ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

/** El `version.json` de un commit: el objeto, `null` si no lo trae; tira si está y no se lee. */
function readVersionAt(root, rev) {
  const listed = git(root, ['ls-tree', '--name-only', rev, '--', VERSION_FILE]);
  if (!listed.ok) throw new Error(`no pude listar ${rev}: ${listed.err || 'git falló'}`);
  if (!listed.out.split('\n').includes(VERSION_FILE)) return null;
  const shown = git(root, ['show', `${rev}:${VERSION_FILE}`]);
  if (!shown.ok) throw new Error(`no pude leer ${VERSION_FILE} de ${rev}: ${shown.err || 'git falló'}`);
  let j;
  try { j = JSON.parse(shown.out.replace(/^﻿/, '')); } catch (e) { throw new Error(`${VERSION_FILE} de ${rev} no es JSON: ${e.message}`); }
  if (!j || typeof j !== 'object' || typeof j.version !== 'string') throw new Error(`${VERSION_FILE} de ${rev} no trae «version»`);
  return j;
}

function lines(text) { return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean); }

function cmdTag(root, { sha, dryRun, today }) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) return fail(`tag: --sha tiene que ser el commit completo (40 hex), llegó «${sha}»`);
  const f = git(root, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main', `+refs/tags/${VO.TAG_PREFIX}*:refs/tags/${VO.TAG_PREFIX}*`]);
  if (!f.ok) return fail(`tag: no pude traer main y las etiquetas: ${f.err || 'git fetch falló'}`);
  const tip = git(root, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/main^{commit}']);
  if (!tip.ok) return fail('tag: no pude leer la punta de main después de traerla');
  const all = git(root, ['tag', '--list', `${VO.TAG_PREFIX}*`]);
  // las que ya numeran ese commit: sólo las livianas, como las leen las máquinas
  const own = git(root, ['for-each-ref', '--points-at', sha, '--format=%(objecttype) %(refname:strip=2)', `refs/tags/${VO.TAG_PREFIX}*`]);
  if (!all.ok || !own.ok) return fail(`tag: no pude listar las etiquetas: ${all.err || own.err}`);
  let floor = null;
  try { const j = readVersionAt(root, sha); floor = j ? j.version : null; } catch (e) { return fail(`tag: ${e.message}`); }
  const ownTags = lines(own.out).filter((l) => l.startsWith('commit ')).map((l) => l.slice('commit '.length));
  const d = decide({ sha, isTip: tip.out === sha, tipTags: ownTags, today, tags: lines(all.out), floor });
  if (d.action === 'skip') { console.log(`version-tag: ${d.reason}`); return 0; }
  if (dryRun) { console.log(`version-tag: pondría ${d.name} sobre ${sha.slice(0, 7)} (--dry-run: no creo ni empujo nada)`); return 0; }
  const made = git(root, ['tag', d.name, sha]);
  if (!made.ok) return fail(`tag: no pude crear ${d.name}: ${made.err}`);
  const pushed = git(root, ['push', '-q', 'origin', `refs/tags/${d.name}`]);
  if (!pushed.ok) return fail(`tag: no pude empujar ${d.name}: ${pushed.err} (la etiqueta quedó sólo en esta copia; la corrida del merge siguiente numera la punta)`);
  console.log(`version-tag: ${d.name} sobre ${sha.slice(0, 7)}`);
  return 0;
}

function cmdCheckPr(root, { base, tip }) {
  if (!base || !tip) return fail('check-pr: faltan --base y --tip');
  let b; let t;
  try { b = readVersionAt(root, base); t = readVersionAt(root, tip); } catch (e) { console.log(`no pude correr: ${e.message}`); return 9; }
  const r = checkPr(b, t);
  console.log(r.line);
  if (r.blocked) return 9;
  return r.ok ? 0 : 1;
}

function fail(message) { console.error(`version-tag: ${message}`); return 2; }

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
  const root = opt('--root') || process.cwd();
  if (cmd === 'tag') {
    // `--today` sólo para las pruebas: la fecha de verdad es la del reloj, en UTC
    const today = opt('--today') || VO.day(Math.floor(Date.now() / 1000));
    return cmdTag(root, { sha: opt('--sha'), dryRun: rest.includes('--dry-run'), today });
  }
  if (cmd === 'check-pr') return cmdCheckPr(root, { base: opt('--base'), tip: opt('--tip') });
  console.error('uso: version-tag.js tag --sha <commit> [--dry-run] [--root <dir>] · version-tag.js check-pr --base <rev> --tip <rev> [--root <dir>]');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { nextNumber, decide, checkPr, readVersionAt, main };
