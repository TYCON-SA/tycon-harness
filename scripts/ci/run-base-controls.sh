#!/usr/bin/env bash
# run-base-controls.sh — la revisión de un pedido corre los controles de la BASE sobre lo que trae el pedido.
# Casos: scripts/tests/base-controls.test.sh
#
# POR QUÉ EXISTE: la revisión de un pedido corría los controles tal como venían en el propio pedido. Un pedido que vaciaba
# el pre-commit, borraba el guion de un control, sumaba su excepción a una lista o bajaba un modo de `block` a `warn` se
# salteaba el control que lo tenía que frenar. Acá el control y su regla salen de la base (la punta de la rama destino; en
# la cola de merge, la base del grupo) y el contenido, del pedido.
#
# CÓMO: un COMMIT ARMADO. El árbol de la punta del pedido con cada archivo de regla del inventario
# (scripts/ci/controls-from-base.json) en su versión de la base, en el disco y en el índice (hay controles que leen su
# regla del índice), y como padre el ancestro común armado igual. Los controles de la base corren sobre él: el pre-commit
# en modo índice, como al commitear, y los demás pasos del inventario en modo rango o sobre el árbol. La pasada del
# pedido (los mismos pasos sobre la punta tal cual, con sus propios guiones) corre ADEMÁS, nunca en su lugar: un control
# nuevo del pedido también frena. Los archivos de regla son: el pre-commit, el inventario, cada guion de control, el
# código que corre cada guion (lo que carga con `require` o con `path.join(__dirname, …)`, lo que lanza como proceso
# hijo, las bibliotecas de las skills que nombra) y las listas, modos y umbrales que el inventario nombra.
#
# EL CAMBIO DE CONTROL. Si el pedido cambia archivos de regla (o un workflow del inventario):
#   · la base y el pedido pasan → entra (endurecer un control no pide trámite);
#   · la base frena y el pedido pasa → es un AFLOJAMIENTO: rojo, salvo la constancia del dueño en uno de los archivos de
#     constancias del inventario, anclada al hash del cambio (ruta y blob de cada archivo cambiado). Con la constancia, la
#     pasada se repite con lo aprobado en su versión del pedido y lo demás de la base, y tiene que dar verde: una
#     constancia no tapa un rojo que viene de otra regla. La firma `approve` pide una terminal de verdad, como
#     `marker.js runtime-waiver`; el rojo imprime el comando exacto;
#   · borrar una regla o un workflow que la base tiene es un aflojamiento;
#   · el pedido frena → rojo, como siempre.
# Cada cambio queda listado archivo por archivo: lo que se suma (+), lo que se saca (-) y lo que cambia (~).
#
# LA ALARMA A POSTERIORI. Lo que entró a la base mientras el pedido estaba abierto: desde donde el pedido salió de la
# base hasta la base (con un commit revisado que es un merge, como el de GitHub, el pedido es su segundo padre), o
# --alarm-range. Un workflow del inventario que cambió en ese tramo sin constancia del dueño para su versión final AVISA,
# y las sumas a los archivos de regla se cuentan. Avisa, no frena: ya está en la base.
#
# USO:
#   bash scripts/ci/run-base-controls.sh run --root <pedido> --base <rev> --range <base>...<punta> [--out <dir>]
#        [--alarm-range <a>..<b>] [--approvals-out <ruta>]
#   bash scripts/ci/run-base-controls.sh check-inventory --root <dir> [--ref <rev>]
#   bash scripts/ci/run-base-controls.sh pending --root <pedido> --base <rev> --range <base>...<punta> [--approvals-out <ruta>]
#   bash scripts/ci/run-base-controls.sh approve --root <dir> --entries '<json>' [--out <ruta>]     (pide terminal)
#   bash scripts/ci/run-base-controls.sh approve --root <dir> --file <ruta> --rev <commit> [--out <ruta>] (pide terminal)
#
# SALIDAS: 0 verde · 1 rojo · 2 uso (o `approve` sin terminal) · 9 no pude correr (la última línea dice por qué). «No pude
# correr» nunca cae a los controles del pedido: eso es el hueco que esto cierra.
#
# LOS LÍMITES (guides/piezas-del-arnes.md §scripts/ci/run-base-controls.sh): el propio workflow corre del pedido
# (GitHub y Azure corren el del pedido), así que un pedido que deja de llamar a este guion no corre nada de la base: lo
# frena el control de los workflows mientras todavía lo llame, y la alarma lo dice en el pedido siguiente. Las pruebas
# (suites, banco) son del código del pedido. Y el contenido de un archivo de regla cambiado lo juzga sólo la pasada del
# pedido: la de la base lo ve en su versión de la base.
set -uo pipefail
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
STDIN_INTERACTIVE=0
[ -t 0 ] && STDIN_INTERACTIVE=1
command -v node >/dev/null 2>&1 || { echo "no pude correr: no encuentro node en el PATH"; exit 9; }
command -v git >/dev/null 2>&1 || { echo "no pude correr: no encuentro git en el PATH"; exit 9; }
BASE_CONTROLS_STDIN_INTERACTIVE="${STDIN_INTERACTIVE}" exec node - "$@" <<'JS'
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const INVENTORY = 'scripts/ci/controls-from-base.json';
const NOT_RUN = 9;
const SELF = 'scripts/ci/run-base-controls.sh';
const CODE = /\.(c?js|mjs|sh)$/;
const [cmd, ...rest] = process.argv.slice(2);

function usage(code) {
  console.error('uso: bash scripts/ci/run-base-controls.sh run|pending --root <pedido> --base <rev> --range <base>...<punta> · check-inventory --root <dir> [--ref <rev>] · approve --root <dir> --entries <json> | --file <ruta> --rev <commit>');
  process.exit(code);
}
function opt(name) {
  const i = rest.indexOf(name);
  if (i < 0) return null;
  const v = rest[i + 1];
  if (v === undefined || v.startsWith('--')) { console.error(`run-base-controls: ${name} pide un valor`); usage(2); }
  return v;
}
function notRun(msg) { console.log(`no pude correr: ${msg}`); process.exit(NOT_RUN); }

// git sin las variables que un hook le pasa a lo que lanza: decide la carpeta
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)));
function git(root, args, { input, env, allowFail } = {}) {
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', input, env: { ...GIT_ENV, ...(env || {}) }, maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r;
}
const trimNl = (s) => s.replace(/\n+$/, '');
function resolveCommit(root, rev) {
  const r = git(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], { allowFail: true });
  return r.status === 0 ? trimNl(r.stdout) : null;
}
// un blob, por la ruta exacta desde la raíz (`rev:./x` resolvería contra la carpeta de quien llama)
function blobOf(root, rev, p) {
  if (!p || p.startsWith('.') && (p.startsWith('./') || p.startsWith('../'))) return null;
  const r = git(root, ['rev-parse', '--verify', '-q', `${rev}:${p}`], { allowFail: true });
  return r.status === 0 ? trimNl(r.stdout) : null;
}
function show(root, rev, p) {
  if (!blobOf(root, rev, p)) return null;
  const r = git(root, ['cat-file', 'blob', `${rev}:${p}`], { allowFail: true });
  return r.status === 0 ? r.stdout : null;
}
// la lista de archivos de un árbol, una vez por árbol: el recorrido del código pregunta por muchas rutas
const TREES = new Map();
function exists(root, rev, p) {
  const key = `${root}\0${rev}`;
  if (!TREES.has(key)) TREES.set(key, new Set(git(root, ['ls-tree', '-r', '--name-only', '-z', rev]).stdout.split('\0').filter(Boolean)));
  return TREES.get(key).has(p);
}
const short = (sha) => String(sha).slice(0, 12);
// Lo que se imprime puede traer texto del pedido (claves de un JSON, rutas y nombres de su inventario, la salida de un
// control) y no puede armar líneas propias en el registro ni comandos de la CI: un salto de línea dentro de un valor se
// muestra escapado (`safe`), y TODA línea que sale por la salida estándar pasa por `neutral`: los caracteres de control
// escapados y `::` (GitHub, que recorta los espacios del comienzo) y `##` (Azure) partidos, en cualquier posición.
const escapeControl = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
// sin pares: «:::» queda «: : :» y «###» queda «# # #» (un reemplazo de a pares dejaría uno entero)
const neutral = (line) => escapeControl(line).replace(/:(?=:)/g, ': ').replace(/#(?=#)/g, '# ');
const safe = (s) => escapeControl(String(s).replace(/\r?\n/g, '\\n'));
const writeOut = console.log.bind(console);
console.log = (...args) => writeOut(args.map(String).join(' ').split('\n').map(neutral).join('\n'));
const asPath = (r) => (typeof r === 'string' ? r : r && r.path);
const isOptional = (r) => typeof r === 'object' && r !== null && r.optional === true;
const approvalFiles = (inv) => [].concat(inv.approvals || []).filter((x) => typeof x === 'string' && x);

// ── el inventario ────────────────────────────────────────────────────────────────────────────────────────────────────
function readInventory(root, rev) {
  const text = show(root, rev, INVENTORY);
  if (text === null) return { missing: true };
  try {
    const inv = JSON.parse(text);
    if (!inv || typeof inv !== 'object' || !Array.isArray(inv.controls) || typeof inv.hook !== 'string') return { error: 'no tiene «hook» y «controls»' };
    return { inv };
  } catch (e) { return { error: e.message }; }
}

// el destino de un atajo generado de un nombre viejo: su segunda línea es `tycon-legacy-shim: <destino>` (la forma que
// escribe scripts/lib/legacy-names.js --write-shims); null si el texto no es un atajo
const SHIM_LINE = /^\s*(?:\/\/|#|<!--)\s*tycon-legacy-shim:\s*(\S+?)\s*(?:-->)?\s*$/;
function shimTarget(text) {
  const lines = String(text || '').split('\n', 3);
  const m = lines.length > 1 ? SHIM_LINE.exec(lines[1]) : null;
  return m ? m[1] : null;
}

// los guiones que llama el pre-commit: `$REPO_ROOT/…`, `$TCG/…` y `harness_publishing <guion>` (sin comentarios ni echo)
function scriptsCalledByHook(text) {
  const out = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^echo\b/.test(line)) continue;
    for (const m of line.matchAll(/\$\{?(?:REPO_ROOT|TCG)\}?\/([\w.@/-]+?\.(?:js|sh))(?![\w.])/g)) out.add(m[1]);
    for (const m of line.matchAll(/harness_publishing\s+([\w.-]+\.js)\b/g)) out.add(`scripts/publishing/${m[1]}`);
  }
  return out;
}

// Las rutas que un texto de código nombra: los `require('./x')`, los `path.join(<algo>, 'a', 'b.js')` (de pedazos
// literales, con __dirname o con otra carpeta adelante), las cadenas con forma de ruta y lo que sigue a una variable de
// shell (`"$REPO_ROOT/scripts/x.sh"`). Cada una con cómo resolverla: contra la carpeta del guion o desde la raíz.
function namedPaths(text) {
  const out = [];
  for (const m of text.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) out.push({ lit: m[1], rel: 'dir' });
  for (const m of text.matchAll(/path\.(?:join|resolve)\(\s*([^()]*)\)/g)) {
    const args = m[1];
    const lits = [...args.matchAll(/(['"`])([^'"`\n$]*)\1/g)].map((x) => x[2]).filter(Boolean);
    if (!lits.length) continue;
    out.push({ lit: lits.join('/'), rel: /^\s*__dirname\s*,/.test(args) ? 'dir' : 'any' });
  }
  for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\n\\])*)\1/g)) {
    for (const piece of m[2].split(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/)) {
      const p = piece.replace(/^\/+/, '');
      if (p.length > 2 && /^[\w.@/-]+$/.test(p)) out.push({ lit: p, rel: /^\.{1,2}\//.test(piece) ? 'dir' : 'any' });
    }
  }
  return out;
}
// resuelve una ruta nombrada por `file` contra el árbol: la carpeta del guion, la raíz y la carpeta de las skills
function resolveNamed(root, rev, file, { lit, rel }, wanted) {
  const dir = path.posix.dirname(file);
  const tries = rel === 'dir' ? [path.posix.join(dir, lit)] : [path.posix.join(dir, lit), lit, `skills/${lit}`];
  for (let c of tries) {
    c = path.posix.normalize(c);
    if (c.startsWith('..') || c.startsWith('/')) continue;
    if (wanted.test(c) && exists(root, rev, c)) return c;
    if (wanted === CODE && !/\.\w+$/.test(c) && exists(root, rev, `${c}.js`)) return `${c}.js`;
  }
  return null;
}

// el código que corre un control: recorrido desde su guion. Las pruebas no cuentan (scripts/tests/ no es código de control)
function codeClosure(root, rev, scripts) {
  const seen = new Set();
  const queue = [...scripts];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    const text = show(root, rev, f);
    if (text === null) continue;
    seen.add(f);
    for (const n of namedPaths(text)) {
      const c = resolveNamed(root, rev, f, n, CODE);
      if (c && c !== f && !/(^|\/)tests?\//.test(c) && !seen.has(c)) queue.push(c);
    }
  }
  return seen;
}

// los archivos de datos (.json) que nombra un guion y existen en el árbol
function dataNamedBy(root, rev, file, text) {
  const found = new Set();
  for (const n of namedPaths(text)) {
    if (!/\.json$/.test(n.lit)) continue;
    const c = resolveNamed(root, rev, file, n, /\.json$/);
    if (c) found.add(c);
  }
  return found;
}

/** Lo que el inventario dice, resuelto contra un árbol: archivos de regla, dueño de cada uno, workflows. */
function resolveInventory(root, rev, inv) {
  const owner = new Map();
  const rules = new Set();
  const add = (p, who) => { if (!p) return; rules.add(p); if (!owner.has(p)) owner.set(p, who); };
  add(inv.hook, 'el pre-commit');
  add(INVENTORY, 'el inventario');
  const scripts = inv.controls.map((c) => c.script).filter(Boolean);
  for (const c of inv.controls) {
    add(c.script, `control ${c.name}`);
    for (const r of c.rules || []) add(asPath(r), `control ${c.name}`);
  }
  const closure = codeClosure(root, rev, [inv.hook, ...scripts]);
  for (const f of closure) add(f, 'código que corre un control');
  // todo guion que el pre-commit nombra es regla, también el que este árbol no trae (el respaldo de un nombre de antes):
  // si la base no lo tiene, el commit armado lo saca, y un pedido no puede crearlo para que corra en la pasada de la base
  const hookText = show(root, rev, inv.hook);
  if (hookText !== null) for (const p of scriptsCalledByHook(hookText)) add(p, 'el pre-commit');
  const workflows = (inv.workflows || []).filter((w) => w && w.path);
  for (const w of workflows) if (!owner.has(w.path)) owner.set(w.path, 'workflow');
  return { rules, owner, closure, workflows };
}

/** Los problemas del inventario contra un árbol: guiones que faltan, controles sin entrada o que nada corre, datos sin clasificar. */
function inventoryProblems(root, rev, inv) {
  const problems = [];
  const exists = (p) => !!blobOf(root, rev, p);
  if (!Array.isArray(inv.passes) || !inv.passes.length) problems.push('el inventario no trae ninguna pasada («passes»): sin pasadas no corre ningún control');
  const hookText = show(root, rev, inv.hook);
  const called = hookText === null ? new Set() : scriptsCalledByHook(hookText);
  const passText = (inv.passes || []).map((p) => (p.cmd || []).join(' ')).join('\n');
  for (const c of inv.controls) {
    if (!c.script) { problems.push(`un control del inventario no nombra su guion (${c.name || 'sin nombre'})`); continue; }
    if (!exists(c.script)) { if (c.optional !== true) problems.push(`el inventario nombra ${c.script} y el árbol no lo trae`); continue; }
    for (const r of c.rules || []) if (!isOptional(r) && !exists(asPath(r))) problems.push(`el inventario nombra ${asPath(r)} y el árbol no lo trae`);
  }
  if (hookText === null) { problems.push(`el inventario nombra ${inv.hook} y el árbol no lo trae`); return problems; }
  const listed = new Set(inv.controls.map((c) => c.script));
  // un guion que el pre-commit nombra y el árbol no trae (el respaldo de un nombre de antes) no corre: no es un control.
  // Un atajo generado de un nombre viejo (segunda línea `tycon-legacy-shim: <destino>`) se sigue hasta su destino, que
  // es el control; un destino fuera del árbol, que el árbol no trae o sin entrada frena. El atajo es regla (lo nombra el
  // pre-commit): en la pasada de la base corre su versión de la base.
  // un atajo vale sólo si el mapa de renombres del árbol lo declara (el nombre viejo con su destino): la línea sola la
  // puede escribir cualquiera, y un control nuevo disfrazado de atajo no se inventariaría
  let renames = [];
  try { renames = (JSON.parse(show(root, rev, 'scripts/lib/renames.json') || '{}').entries || []); } catch (_) { renames = []; }
  const declaredShim = (oldPath, newPath) => renames.some((e) => e && e.kind === 'file' && e.old === oldPath && e.new === newPath);
  const viaShim = new Set();
  for (const p of [...called].sort()) {
    if (listed.has(p) || !exists(p)) continue;
    const text = show(root, rev, p);
    if (text === null) { problems.push(`no pude leer ${p}, que el pre-commit nombra: no sé si es un control`); continue; }
    const target = shimTarget(text);
    if (target === null) { problems.push(`control sin inventariar: ${p}`); continue; }
    const norm = path.posix.normalize(target);
    if (path.posix.isAbsolute(target) || norm.startsWith('..') || norm !== target) problems.push(`el atajo ${p} apunta fuera del árbol (${safe(target)})`);
    else if (!exists(norm)) problems.push(`el atajo ${p} apunta a ${norm}, que el árbol no trae`);
    else if (!declaredShim(p, norm)) problems.push(`control sin inventariar: ${p} (dice ser un atajo de ${norm}, pero el mapa de renombres no lo declara)`);
    else if (!listed.has(norm)) problems.push(`control sin inventariar: ${norm} (el destino del atajo ${p})`);
    else viaShim.add(norm);
  }
  // un control del inventario que nada corre (ni el pre-commit, directo o por un atajo declarado, ni una pasada) sobra
  for (const c of inv.controls) {
    if (!c.script || !exists(c.script) || c.script === SELF) continue;
    if (!called.has(c.script) && !viaShim.has(c.script) && !passText.includes(c.script)) problems.push(`ningún paso corre ${c.script}: lo llama el pre-commit o una pasada del inventario, o no es un control`);
  }
  const { rules, closure } = resolveInventory(root, rev, inv);
  const classified = new Set([...rules, ...(inv.content || []).map(asPath), ...approvalFiles(inv)].filter(Boolean));
  // una entrada de «content» que termina en «/» clasifica la carpeta entera
  // y también una carpeta de constancias
  const contentDirs = [...(inv.content || []).map(asPath), ...approvalFiles(inv)].filter((p) => p && p.endsWith('/'));
  const isClassified = (d) => classified.has(d) || contentDirs.some((dir) => d.startsWith(dir));
  const unclassified = new Set();
  for (const f of closure) {
    const text = show(root, rev, f);
    if (text === null) continue;
    for (const d of dataNamedBy(root, rev, f, text)) if (!isClassified(d)) unclassified.add(d);
  }
  for (const d of [...unclassified].sort()) problems.push(`sin clasificar: ${d} (nombrado por un control: va en las reglas de su control o en «content»)`);
  return problems;
}

// ── el diff de una regla, entrada por entrada ─────────────────────────────────────────────────────────────────────────
// un valor como texto con las claves ordenadas: dos objetos iguales con otro orden de claves son el mismo
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function flatten(v, prefix, out) {
  if (Array.isArray(v)) {
    const key = prefix || '(raíz)';
    if (!out.arrays.has(key)) out.arrays.set(key, new Set());
    for (const item of v) out.arrays.get(key).add(canonical(item));
  } else if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) out.scalars.set(prefix || '(raíz)', '{}');
    for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.scalars.set(prefix || '(raíz)', JSON.stringify(v));
  }
  return out;
}
/** Las entradas que cambian entre dos versiones de un JSON: [{sign, line}]. null si alguna no es JSON. */
function jsonDiff(beforeText, afterText) {
  let a; let b;
  try { a = beforeText === null ? {} : JSON.parse(beforeText); b = afterText === null ? {} : JSON.parse(afterText); } catch (_) { return null; }
  const A = flatten(a, '', { arrays: new Map(), scalars: new Map() });
  const B = flatten(b, '', { arrays: new Map(), scalars: new Map() });
  const lines = [];
  for (const [k, items] of B.arrays) for (const it of items) if (!(A.arrays.get(k) || new Set()).has(it)) lines.push({ sign: '+', line: `${k}: ${it}` });
  for (const [k, items] of A.arrays) for (const it of items) if (!(B.arrays.get(k) || new Set()).has(it)) lines.push({ sign: '-', line: `${k}: ${it}` });
  for (const [k, v] of B.scalars) {
    if (!A.scalars.has(k)) lines.push({ sign: '+', line: `${k}: ${v}` });
    else if (A.scalars.get(k) !== v) lines.push({ sign: '~', line: `${k}: ${A.scalars.get(k)} → ${v}` });
  }
  for (const [k, v] of A.scalars) if (!B.scalars.has(k)) lines.push({ sign: '-', line: `${k}: ${v}` });
  return lines;
}
/** Una línea por archivo cambiado y sus entradas. */
function describeChange(root, p, who, fromRev, toRev) {
  const before = show(root, fromRev, p);
  const after = show(root, toRev, p);
  const head = `${p} (${who})`;
  if (after === null) return [`   ${head}: borrado`];
  if (before === null && !p.endsWith('.json')) return [`   ${head}: nuevo`];
  if (!p.endsWith('.json')) return [`   ${head}: cambia (guion o workflow)`];
  const d = jsonDiff(before, after);
  if (d === null) return [`   ${head}: cambia (no es JSON válido de un lado)`];
  const adds = d.filter((x) => x.sign === '+').length;
  return [`   ${head}: ${adds} suma(s)${before === null ? ' (nuevo)' : ''}`, ...d.map((x) => `      ${x.sign} ${safe(x.line)}`)];
}

// ── las constancias del dueño ─────────────────────────────────────────────────────────────────────────────────────────
function hashOf(entries) {
  const text = entries.map((e) => `${e.path}\t${e.blob}\n`).sort().join('');
  return crypto.createHash('sha256').update(text).digest('hex');
}
// una entrada de `approvals` que termina en «/» es una carpeta: una constancia por archivo, `<hash>.json`, para que dos
// pedidos firmados no toquen el mismo archivo (GitHub no usa merge=union de .gitattributes: un registro de una línea por
// firma choca en cada merge). Los .jsonl de antes se siguen leyendo, línea por línea
const isApprovalDir = (f) => f.endsWith('/');
// una constancia vale sólo si sus reglas dan su hash: el chequeo del verde lo exige, y la alarma de lo que entró a main
// también, así que se filtra al leer
const holdsUp = (a) => a && typeof a.hash === 'string' && Array.isArray(a.rules) && a.rules.every((r) => r && typeof r.path === 'string' && typeof r.blob === 'string') && hashOf(a.rules) === a.hash;
// por qué un destino de `approve` no sirve (null si sirve): dentro del repo y sin enlaces en lo que ya existe del camino
function insideRepo(root, out) {
  if (path.isAbsolute(out)) return 'es una ruta absoluta';
  const rel = path.relative(root, path.resolve(root, out));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return 'sale del repo';
  // la carpeta de git no es parte del pedido: su configuración y sus ganchos no se tocan
  if (rel.split(path.sep).some((s) => s.toLowerCase() === '.git')) return 'cae en la carpeta de git';
  let cur = root;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    let st; try { st = fs.lstatSync(cur); } catch (_) { break; }
    if (st.isSymbolicLink()) return `pasa por un enlace (${path.relative(root, cur)})`;
  }
  return null;
}
// el nombre de un archivo viene del pedido: sale escapado, sin armar líneas propias en el registro
const notSigning = (what, rev, why) => console.log(`⚠️ base-controls: aviso — ${safe(what)} no firma nada (en ${short(rev)}): ${why}`);
// las constancias de un árbol, de todos los archivos y carpetas del inventario; lo que no se sostiene no firma nada, y se dice
function readApprovals(root, rev, files) {
  const out = [];
  for (const file of files) {
    if (isApprovalDir(file)) { out.push(...readApprovalDir(root, rev, file)); continue; }
    const text = show(root, rev, file);
    if (text === null) continue;
    let bad = 0; let wrongHash = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let a; try { a = JSON.parse(line); } catch (_) { bad++; continue; }
      if (holdsUp(a)) out.push(a); else wrongHash++;
    }
    if (bad) console.log(`⚠️ base-controls: aviso — ${bad === 1 ? 'una línea' : `${bad} líneas`} de ${file} no se lee${bad === 1 ? '' : 'n'} (en ${short(rev)}): no firma${bad === 1 ? '' : 'n'} nada`);
    if (wrongHash) notSigning(`${wrongHash === 1 ? 'una línea' : `${wrongHash} líneas`} de ${file}`, rev, 'sus reglas no dan su hash');
  }
  return out;
}
// una carpeta de constancias: cada archivo común `*.json` del primer nivel, nombrado por su hash
function readApprovalDir(root, rev, dir) {
  const out = [];
  const r = git(root, ['ls-tree', '-z', rev, '--', dir], { allowFail: true });
  // una carpeta que no está sale 0 y vacía: un error es «no pude listar», y se dice
  if (r.status !== 0) { notSigning(dir, rev, 'no pude listar la carpeta'); return out; }
  for (const rec of r.stdout.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [mode, type] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    const name = p.slice(dir.length);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) { notSigning(p, rev, 'no es un archivo común del primer nivel de la carpeta'); continue; }
    if (!name.endsWith('.json')) { notSigning(p, rev, 'no es un .json'); continue; }
    const text = show(root, rev, p);
    let a; try { a = text === null ? null : JSON.parse(text); } catch (_) { a = null; }
    if (a === null) { notSigning(p, rev, 'no se lee'); continue; }
    if (!holdsUp(a)) { notSigning(p, rev, 'sus reglas no dan su hash'); continue; }
    if (name !== `${a.hash}.json`) { notSigning(p, rev, `el nombre no es su hash (${short(a.hash)}…)`); continue; }
    out.push(a);
  }
  return out;
}
const approvedEntry = (approvals, p, blob) => approvals.some((a) => a && Array.isArray(a.rules) && a.rules.some((r) => r && r.path === p && r.blob === blob));
const approvalLine = (entries) => JSON.stringify({ hash: hashOf(entries), rules: entries, at: new Date().toISOString().slice(0, 10), by: 'dueño' });
// un argumento de shell entre comillas simples, para pegar tal cual en una terminal
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
function signCommand(root, entries, out) {
  return `bash ${SELF} approve --root ${root === '<repo>' ? root : shq(root)} --out ${shq(out)} --entries ${shq(JSON.stringify(entries))}`;
}

// ── el commit armado ─────────────────────────────────────────────────────────────────────────────────────────────────
const IDENT = { GIT_AUTHOR_NAME: 'run-base-controls', GIT_AUTHOR_EMAIL: 'run-base-controls@localhost', GIT_COMMITTER_NAME: 'run-base-controls', GIT_COMMITTER_EMAIL: 'run-base-controls@localhost' };
function treeOf(root, rev) { return trimNl(git(root, ['rev-parse', `${rev}^{tree}`]).stdout); }
// el árbol de `fromRev` con cada ruta de `paths` en su versión de `fromBase` (o sin ella, si `fromBase` no la tiene)
function armTree(root, work, fromRev, fromBase, paths) {
  const idx = path.join(work, `index-${crypto.randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: idx };
  git(root, ['read-tree', fromRev], { env });
  const lines = [];
  for (const p of paths) {
    // un ls-tree que falla es «no pude leer», no «la base no lo tiene»: tira, y la corrida sale «no pude correr»
    const r = git(root, ['ls-tree', fromBase, '--', p]);
    const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(r.stdout || '');
    if (m) lines.push(`${m[1]} ${m[2]}\t${p}`);
    else lines.push(`0 ${'0'.repeat(40)}\t${p}`);
  }
  if (lines.length) git(root, ['update-index', '--index-info'], { env, input: `${lines.join('\n')}\n` });
  const tree = trimNl(git(root, ['write-tree'], { env }).stdout);
  fs.rmSync(idx, { force: true });
  return tree;
}
function commitTree(root, tree, parent, msg) { return trimNl(git(root, ['commit-tree', tree, '-p', parent, '-m', msg], { env: IDENT }).stdout); }
/** El par (ancestro, punta) armado con `paths` de la base: los commits, y si quedaron iguales a los de verdad. */
function armPair(a, work, paths, label) {
  const baseTree = armTree(a.root, work, a.mb, a.base, paths);
  const tipTree = armTree(a.root, work, a.tip, a.base, paths);
  const same = baseTree === treeOf(a.root, a.mb) && tipTree === treeOf(a.root, a.tip);
  if (same) return { same, base: a.mb, tip: a.tip };
  const base = commitTree(a.root, baseTree, a.mb, `el ancestro ${short(a.mb)} con ${label}`);
  return { same, base, tip: commitTree(a.root, tipTree, base, `el pedido ${short(a.tip)} con ${label}`) };
}

// ── una pasada ───────────────────────────────────────────────────────────────────────────────────────────────────────
function runPass(a, work, label, rev, parentRev) {
  const dir = path.join(work, `tree-${crypto.randomBytes(4).toString('hex')}`);
  git(a.root, ['worktree', 'add', '--quiet', '--detach', dir, rev]);
  const results = [];
  try {
    git(dir, ['reset', '--quiet', '--soft', parentRev]);
    for (const pass of a.inv.passes || []) {
      // lo que la pasada necesita se mira en la BASE: si la base no lo tiene, no aplica; si lo tiene y el pedido lo
      // borró, la pasada falla (borrar lo que un control mira no es «no aplica»)
      const need = [].concat(pass.if_exists || []);
      if (need.some((p) => !blobOf(a.root, a.base, p))) { console.log(`· base-controls: ${pass.name} no aplica (la base no trae ${need.filter((p) => !blobOf(a.root, a.base, p)).join(', ')})`); continue; }
      const gone = need.filter((p) => !fs.existsSync(path.join(dir, p)));
      if (gone.length) {
        results.push({ name: pass.name, ok: false });
        console.log(`❌ base-controls: ${pass.name} — rojo (${label})\n     el pedido borra ${gone.join(', ')}, que la pasada ${pass.name} necesita`);
        continue;
      }
      const argv = pass.cmd.map((x) => x.replace(/\{base\}/g, parentRev).replace(/\{tip\}/g, rev).replace(/\{root\}/g, dir));
      const env = { ...GIT_ENV, TYCON_GUIDES_DIR: dir, TYCON_SKILLS_DIR: dir, TYCON_NO_LIVENESS_PRECOMMIT: '1' };
      const r = spawnSync(argv[0], argv.slice(1), { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
      const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
      const ok = r.status === 0 && !r.error;
      results.push({ name: pass.name, ok });
      console.log(`${ok ? '✅' : '❌'} base-controls: ${pass.name}${ok ? '' : ' — rojo'} (${label})`);
      if (output && !ok) console.log(output.split('\n').map((l) => `     ${safe(l.replace(/\r$/, ''))}`).join('\n'));
      if (r.error) console.log(`     no pude lanzar ${argv[0]}: ${r.error.message}`);
    }
  } finally {
    git(a.root, ['worktree', 'remove', '--force', dir], { allowFail: true });
  }
  return results;
}

// ── el análisis común de run y pending ───────────────────────────────────────────────────────────────────────────────
function analyze() {
  const rootArg = opt('--root'); const baseArg = opt('--base'); const range = opt('--range');
  if (!rootArg || !baseArg || !range) usage(2);
  if (!fs.existsSync(rootArg)) notRun(`--root ${rootArg} no existe`);
  const root = path.resolve(rootArg);
  const m = /^(.+?)\.\.\.(.+)$/.exec(range);
  if (!m) notRun(`--range pide <base>...<punta> y recibió «${range}»`);
  const base = resolveCommit(root, baseArg);
  if (!base) notRun(`la base ${baseArg} no resuelve a un commit en ${root}: sin la base no hay de dónde correr los controles (y los del pedido no son la revisión)`);
  const rangeBase = resolveCommit(root, m[1]); const tip = resolveCommit(root, m[2]);
  if (!rangeBase || !tip) notRun(`la historia no alcanza para --range ${range} en ${root}`);
  const mbR = git(root, ['merge-base', rangeBase, tip], { allowFail: true });
  if (mbR.status !== 0) notRun(`no hay ancestro común entre ${m[1]} y ${m[2]}`);
  const mb = trimNl(mbR.stdout);
  // el commit revisado en GitHub es un merge cuyo PRIMER padre es la base (o una versión anterior de ella: main pudo
  // avanzar entre que GitHub armó el merge y la revisión, o el trabajo se volvió a correr): el pedido propiamente dicho es
  // su segundo padre. Una rama que termina en «merge de main» también es un merge, pero su primer padre es la rama, que
  // no está en la base, y el segundo es main: ahí el pedido es la punta misma (si no, las entradas a firmar saldrían con
  // los contenidos de main)
  const parents = trimNl(git(root, ['rev-list', '--parents', '-n', '1', tip]).stdout).split(' ').slice(1);
  const primeroEnLaBase = parents.length === 2
    && git(root, ['merge-base', '--is-ancestor', parents[0], rangeBase], { allowFail: true }).status === 0;
  const prHead = primeroEnLaBase ? parents[1] : null;
  const read = readInventory(root, base);
  if (read.missing) notRun(`la base ${short(base)} no trae ${INVENTORY}: no sé qué controles correr desde ella`);
  if (read.error) notRun(`el inventario de la base (${INVENTORY}) no se lee: ${read.error}`);
  const inv = read.inv;
  const { rules, owner, workflows } = resolveInventory(root, base, inv);
  const controlFiles = [...new Set([...rules, ...workflows.map((w) => w.path)])].sort();
  const changed = controlFiles.filter((p) => blobOf(root, mb, p) !== blobOf(root, tip, p));
  // la constancia ancla lo que el dueño ve en su rama: el pedido, no el merge que arma GitHub
  const signedRev = prHead || tip;
  const entries = changed.map((p) => ({ path: p, blob: blobOf(root, signedRev, p) || 'borrado' }));
  const files = approvalFiles(inv);
  const approvalsOut = opt('--approvals-out') || files[0] || '.tycon/control-changes.jsonl';
  return { root, base, rangeBase, tip, mb, prHead, inv, rules, owner, workflows, controlFiles, changed, entries, hash: hashOf(entries), approvalsOut };
}
function printChanges(a) {
  if (!a.changed.length) { console.log('base-controls: el pedido no cambia ningún archivo de regla ni workflow del inventario'); return; }
  console.log(`base-controls: reglas que cambia el pedido (${a.changed.length}):`);
  for (const p of a.changed) console.log(describeChange(a.root, p, a.owner.get(p) || 'regla', a.mb, a.tip).join('\n'));
}

// ── la alarma a posteriori ───────────────────────────────────────────────────────────────────────────────────────────
function alarm(a) {
  const ar = opt('--alarm-range');
  let from; let to = a.base;
  if (ar) {
    const m = /^(.+?)\.\.(.+)$/.exec(ar);
    const f = m && resolveCommit(a.root, m[1]); const t = m && resolveCommit(a.root, m[2]);
    if (!f || !t) { console.log(`⚠️ base-controls: aviso — --alarm-range ${ar} no resuelve: la alarma a posteriori NO miró nada`); return; }
    from = f; to = t;
  } else {
    // desde donde el pedido salió de la base (con el merge de GitHub, desde su segundo padre)
    const r = git(a.root, ['merge-base', a.base, a.prHead || a.tip], { allowFail: true });
    if (r.status !== 0) { console.log('⚠️ base-controls: aviso — no encuentro dónde salió el pedido de la base: la alarma a posteriori NO miró nada'); return; }
    from = trimNl(r.stdout);
  }
  if (from === to) return;
  const approvals = readApprovals(a.root, a.base, approvalFiles(a.inv));
  // cada archivo una vez: su versión final contra la del comienzo del tramo
  for (const w of a.workflows) {
    const before = blobOf(a.root, from, w.path); const after = blobOf(a.root, to, w.path);
    if (before === after || approvedEntry(approvals, w.path, after || 'borrado')) continue;
    const last = trimNl(git(a.root, ['log', '-1', '--format=%H', `${from}..${to}`, '--', w.path], { allowFail: true }).stdout || '') || to;
    console.log(`⚠️ base-controls: aviso — main trajo ${w.path} en ${short(last)} sin constancia del dueño. Revisá qué cambió (git diff ${short(from)} ${short(to)} -- ${w.path}); si está bien, firmalo desde una terminal: bash ${SELF} approve --root <repo> --file ${w.path} --rev ${short(to)}`);
  }
  for (const p of [...a.rules].sort()) {
    if (!p.endsWith('.json') || blobOf(a.root, from, p) === blobOf(a.root, to, p)) continue;
    const d = jsonDiff(show(a.root, from, p), show(a.root, to, p));
    if (!d) { console.log(`⚠️ base-controls: aviso — no pude comparar ${p} (main lo cambió y no es JSON válido de un lado): la alarma NO lo contó`); continue; }
    const adds = d.filter((x) => x.sign === '+');
    if (!adds.length) continue;
    console.log(`⚠️ base-controls: main trajo, mientras el pedido estaba abierto: ${p}: ${adds.length} suma(s)`);
    for (const x of adds) console.log(`      + ${safe(x.line)}`);
  }
}

// ── los comandos ─────────────────────────────────────────────────────────────────────────────────────────────────────
function cmdCheckInventory() {
  const rootArg = opt('--root'); if (!rootArg) usage(2);
  const root = path.resolve(rootArg);
  let rev = opt('--ref');
  if (rev) {
    if (!resolveCommit(root, rev)) notRun(`${rev} no resuelve a un commit en ${root}`);
  } else {
    // sin --ref, el árbol de trabajo tal cual (lo versionado y lo nuevo que no ignora .gitignore), como un árbol de git
    const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'base-controls-idx-')), 'index');
    const env = { GIT_INDEX_FILE: idx };
    if (resolveCommit(root, 'HEAD')) git(root, ['read-tree', 'HEAD'], { env });
    git(root, ['add', '-A', '.'], { env });
    rev = trimNl(git(root, ['write-tree'], { env }).stdout);
    fs.rmSync(path.dirname(idx), { recursive: true, force: true });
  }
  const read = readInventory(root, rev);
  if (read.missing) notRun(`${rev} no trae ${INVENTORY}`);
  if (read.error) notRun(`${INVENTORY} no se lee: ${read.error}`);
  const problems = inventoryProblems(root, rev, read.inv);
  for (const p of problems) console.log(`❌ base-controls: ${p}`);
  console.log(problems.length ? `❌ base-controls: el inventario no cuadra (${problems.length})` : `✅ base-controls: el inventario cuadra con ${read.inv.hook} (${read.inv.controls.length} controles)`);
  process.exit(problems.length ? 1 : 0);
}

function cmdRun() {
  const a = analyze();
  const outArg = opt('--out');
  const work = outArg ? (fs.mkdirSync(outArg, { recursive: true }), fs.mkdtempSync(path.join(path.resolve(outArg), 'base-controls-'))) : fs.mkdtempSync(path.join(os.tmpdir(), 'base-controls-'));
  const reasons = [];
  try {
    console.log(`base-controls: base ${short(a.base)} · ancestro ${short(a.mb)} · punta ${short(a.tip)}${a.prHead ? ` (merge; el pedido es ${short(a.prHead)})` : ''} · los controles y su regla salen de la base`);
    // el inventario: el de la base contra la base (sus guiones están), y el del pedido contra el pedido (sus controles nuevos tienen entrada)
    const baseProblems = inventoryProblems(a.root, a.base, a.inv);
    for (const p of baseProblems) console.log(`❌ base-controls: inventario de la base — ${p}`);
    if (baseProblems.length) reasons.push('el inventario de la base no cuadra');
    const tipRead = readInventory(a.root, a.tip);
    if (tipRead.inv) {
      const tipProblems = inventoryProblems(a.root, a.tip, tipRead.inv);
      // los nombres y rutas salen del inventario del pedido: un salto de línea no arma una línea propia
      for (const p of tipProblems) console.log(`❌ base-controls: inventario del pedido — ${safe(p)}`);
      if (tipProblems.length) reasons.push('el inventario del pedido no cuadra');
    } else {
      console.log(`· base-controls: el pedido no trae un inventario que se lea (${safe(tipRead.error || 'borrado')}): corre el de la base`);
    }
    printChanges(a);

    // la pasada de la base y la del pedido
    const armed = armPair(a, work, [...a.rules], `la regla de la base ${short(a.base)}`);
    let baseRes; let prRes;
    if (armed.same) {
      console.log('base-controls: la regla de la base y la del pedido son la misma: una sola pasada');
      prRes = runPass(a, work, `base ${short(a.base)} = pedido`, a.tip, a.mb);
      baseRes = prRes;
    } else {
      baseRes = runPass(a, work, `base ${short(a.base)}`, armed.tip, armed.base);
      prRes = runPass(a, work, `pedido ${short(a.tip)}`, a.tip, a.mb);
    }
    // lo que la base tiene y el pedido borra, y los workflows con las marcas de la base
    const baseProblemsOfPr = [];
    for (const p of a.changed) if (blobOf(a.root, a.base, p) && !blobOf(a.root, a.tip, p)) baseProblemsOfPr.push(`el pedido borra ${p}, que la base tiene`);
    for (const w of a.workflows) {
      const text = show(a.root, a.tip, w.path);
      if (text === null) { if (!w.optional && !blobOf(a.root, a.base, w.path)) baseProblemsOfPr.push(`${w.path} no está en el pedido`); continue; }
      for (const s of w.must_contain || []) if (!text.includes(s)) baseProblemsOfPr.push(`${w.path} ya no trae la base (falta «${s}»)`);
    }
    console.log(`${baseProblemsOfPr.length ? '❌' : '✅'} base-controls: workflows y borrados${baseProblemsOfPr.length ? ' — rojo' : ''} (base ${short(a.base)})`);
    for (const p of baseProblemsOfPr) console.log(`     ${p}`);

    // ninguna pasada corrió (todas «no aplica», o el inventario no trae): no se midió nada, y eso no es verde
    if (!baseRes.length) reasons.push('no corrió ninguna pasada del inventario desde la base: no medido no es verde');
    const baseRed = baseRes.some((r) => !r.ok) || baseProblemsOfPr.length > 0;
    const prRed = prRes.some((r) => !r.ok);
    if (prRed) reasons.push(`la pasada del pedido frena: ${prRes.filter((r) => !r.ok).map((r) => r.name).join(', ')}`);
    let approved = false;
    if (baseRed && !prRed) {
      if (a.changed.length) {
        const approvals = readApprovals(a.root, a.tip, approvalFiles(a.inv));
        // la línea tiene que cuadrar entera: el hash del cambio, y sus reglas son las que dan ese hash
        const signed = approvals.some((x) => x && x.hash === a.hash && Array.isArray(x.rules) && hashOf(x.rules) === a.hash);
        if (!signed) {
          reasons.push(`el pedido afloja un control sin la constancia del dueño: ${a.changed.join(', ')}. La firma, desde una terminal (con el arnés instalado si el repo no trae este guion): ${signCommand('<repo>', a.entries, a.approvalsOut)}`);
        } else {
          // con la constancia: la regla de la base menos lo aprobado, que va en su versión del pedido; tiene que dar verde
          const rest = [...a.rules].filter((p) => !a.changed.includes(p));
          const ap = armPair(a, work, rest, `la regla de la base ${short(a.base)} y lo aprobado del pedido`);
          const apRes = runPass(a, work, `base ${short(a.base)} con lo aprobado`, ap.tip, ap.base);
          if (apRes.some((r) => !r.ok)) reasons.push(`la constancia cubre ${a.changed.join(', ')}, pero la base sigue frenando con eso aprobado: el rojo viene de otra regla (una que main endureció); el pedido tiene que ponerse al día`);
          else approved = true;
        }
      } else {
        reasons.push('la base frena lo que trae el pedido (una regla que main endureció: el pedido tiene que ponerse al día)');
      }
    } else if (baseRed) {
      reasons.push(`la pasada de la base frena: ${[...baseRes.filter((r) => !r.ok).map((r) => r.name), ...(baseProblemsOfPr.length ? ['workflows y borrados'] : [])].join(', ')}`);
    }
    alarm(a);
    if (reasons.length) {
      for (const r of reasons) console.log(`❌ base-controls: rojo — ${r}`);
      process.exitCode = 1;
    } else if (approved) {
      console.log(`✅ base-controls: cambio de control aprobado: ${a.changed.join(', ')} (constancia del dueño ${a.hash.slice(0, 12)})`);
    } else if (a.changed.length) {
      console.log('✅ base-controls: verde — la base y el pedido pasan: entra sin constancia');
    } else {
      console.log('✅ base-controls: verde');
    }
  } catch (e) {
    console.log(`no pude correr: ${e.message}`);
    process.exitCode = NOT_RUN;
  } finally {
    git(a.root, ['worktree', 'prune'], { allowFail: true });
    if (!outArg) fs.rmSync(work, { recursive: true, force: true });
  }
}

function cmdPending() {
  const a = analyze();
  printChanges(a);
  if (!a.changed.length) { console.log('base-controls: no hay nada que firmar'); return; }
  console.log(`hash: ${a.hash}`);
  console.log(`la firma, desde tu terminal: ${signCommand(a.root, a.entries, a.approvalsOut)}`);
}

function readFromTty(prompt) {
  let fd;
  try { fd = fs.openSync('/dev/tty', 'r+'); } catch (_) { return null; }
  fs.writeSync(fd, prompt);
  const buf = Buffer.alloc(256); let text = '';
  for (;;) {
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (_) { break; }
    if (!n) break;
    text += buf.slice(0, n).toString('utf8');
    if (text.includes('\n')) break;
  }
  fs.closeSync(fd);
  return text.split('\n')[0].trim();
}
function cmdApprove() {
  const root = path.resolve(opt('--root') || '.');
  let entries;
  if (opt('--entries')) {
    try { entries = JSON.parse(opt('--entries')); } catch (e) { console.error(`run-base-controls approve: --entries no es JSON: ${e.message}`); process.exit(2); }
    if (!Array.isArray(entries) || !entries.length || entries.some((e) => !e || typeof e.path !== 'string' || typeof e.blob !== 'string')) { console.error('run-base-controls approve: --entries es una lista de {path, blob}'); process.exit(2); }
    // la constancia sólo sirve si firma lo que el pedido trae en su punta: una entrada de otra versión (por ejemplo, la de
    // main, cuando la rama termina en un merge con main) haría firmar algo que la revisión no acepta. Se mira antes que
    // la terminal, así quien prepara el comando también se entera
    const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFail: true });
    if (head.status !== 0) { console.error(`run-base-controls approve: no pude leer la punta de ${root} (no es un repo, o no tiene commits): no sé si las entradas son las del pedido. No se firmó nada.`); process.exit(2); }
    const distintas = entries.filter((e) => (blobOf(root, 'HEAD', e.path) || 'borrado') !== e.blob);
    if (distintas.length) {
      console.error(`run-base-controls approve: las entradas no coinciden con la punta de ${root} (HEAD ${short(trimNl(git(root, ['rev-parse', 'HEAD']).stdout))}): ${distintas.map((e) => `${e.path} (firma ${short(e.blob)}, la punta tiene ${short(blobOf(root, 'HEAD', e.path) || 'borrado')})`).join(', ')}. No se firmó nada: pedí el comando de nuevo con \`pending\` sobre la rama del pedido al día.`);
      process.exit(1);
    }
  }
  if (process.env.BASE_CONTROLS_STDIN_INTERACTIVE !== '1') {
    console.error('🔒 run-base-controls approve: pide una terminal interactiva de verdad (la constancia es del dueño, no de un agente). Correlo vos, en tu terminal.');
    process.exit(2);
  }
  // con --file la entrada sale de --rev, así que coincide con ella por construcción
  if (!entries && opt('--file')) {
    const p = opt('--file'); const rev = opt('--rev') || 'HEAD';
    entries = [{ path: p, blob: blobOf(root, rev, p) || 'borrado' }];
  } else if (!entries) {
    usage(2);
  }
  const read = readInventory(root, 'HEAD');
  const out = opt('--out') || (read.inv && approvalFiles(read.inv)[0]) || '.tycon/control-changes.jsonl';
  // el destino puede salir del inventario del pedido: se mira antes de preguntar, y la persona ve adónde va la firma
  const where = insideRepo(root, out);
  if (where) { console.error(`run-base-controls approve: el destino ${safe(out)} ${where}: no se firmó nada.`); process.exit(2); }
  console.error('Vas a firmar, como dueño, este cambio de control:');
  for (const e of entries) console.error(`   ${safe(e.path)} (blob ${short(e.blob)})`);
  console.error(`La firma va a: ${safe(out)}${isApprovalDir(out) ? `${hashOf(entries)}.json` : ''}`);
  const answer = readFromTty('Escribí «apruebo» para firmarlo: ');
  if (answer === null) { console.error('🔒 run-base-controls approve: no pude abrir /dev/tty: pide una terminal interactiva de verdad.'); process.exit(2); }
  if (answer !== 'apruebo') { console.error('run-base-controls approve: no se firmó nada.'); process.exit(1); }
  const line = approvalLine(entries);
  if (!isApprovalDir(out)) {
    const dest = path.join(root, out);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.appendFileSync(dest, `${line}\n`);
    console.log(`✅ constancia escrita en ${out}: commiteala en el pedido.`);
    return;
  }
  // un archivo por firma, creado de una vez: lo que ya está no se pisa, ni siquiera con dos firmas a la vez
  const hash = hashOf(entries);
  const rel = `${out}${hash}.json`;
  const dest = path.join(root, rel);
  try {
    fs.mkdirSync(path.join(root, out), { recursive: true });
    fs.writeFileSync(dest, `${line}\n`, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      // un enlace o una carpeta con ese nombre no es una firma: el lector no lo cuenta, así que no se dice «ya estaba»
      let st = null; try { st = fs.lstatSync(dest); } catch (_) { /* se dice abajo */ }
      if (!st || !st.isFile()) {
        console.error(`run-base-controls approve: ${safe(rel)} ya existe y no es un archivo común (${st ? (st.isSymbolicLink() ? 'un enlace' : 'una carpeta u otra cosa') : 'no lo pude mirar'}): no se tocó y no se firmó nada.`);
        process.exit(1);
      }
      let prev = null; let why = 'no es esta firma';
      try { prev = JSON.parse(fs.readFileSync(dest, 'utf8')); } catch (e2) { why = e2.code ? `no lo pude leer (${e2.code})` : 'no es JSON'; }
      if (prev && holdsUp(prev) && prev.hash === hash) { console.log(`✅ ya estaba firmado: ${rel} trae esta misma firma; no se tocó.`); return; }
      console.error(`run-base-controls approve: ${safe(rel)} ya existe y ${why}: no se tocó y no se firmó nada. Miralo antes de seguir.`);
      process.exit(1);
    }
    console.error(`run-base-controls approve: no pude escribir ${safe(rel)} (${e.code || e.message}): no se firmó nada.`);
    process.exit(1);
  }
  console.log(`✅ constancia escrita en ${rel}: commiteala en el pedido.`);
}

try {
  if (cmd === 'run') cmdRun();
  else if (cmd === 'check-inventory') cmdCheckInventory();
  else if (cmd === 'pending') cmdPending();
  else if (cmd === 'approve') cmdApprove();
  else if (cmd === '-h' || cmd === '--help') usage(0);
  else usage(2);
} catch (e) {
  notRun(e.message);
}
JS
