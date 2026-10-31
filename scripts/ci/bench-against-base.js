#!/usr/bin/env node
/**
 * bench-against-base.js — el banco de un pedido corre los casos de la BASE contra los ganchos del pedido.
 * Casos: scripts/tests/bench-against-base.test.js
 *
 * POR QUÉ EXISTE: el banco de controles del pedido (public-ci.sh, paso 7) corre con los casos, la línea de base y el
 * corredor del propio pedido, que no piden firma. Un pedido que afloja un gancho y además baja su caso, lo saca de la
 * línea de base o cambia el corredor para no juzgarlo pasaba verde. Acá el banco entero (la carpeta
 * scripts/controls-bench: corredor, casos, línea de base) y la lista de huecos de Windows salen de la base, y todo lo demás
 * (los ganchos y sus bibliotecas) del pedido.
 *
 * CÓMO: una copia de trabajo aparte de la punta del pedido, con esos archivos en su versión de la base. El corredor de la
 * base corre ahí (`--tool both --json`, sin `--baseline`) y este guion compara caso por caso, con Claude (la línea de base
 * es de Claude):
 *   · aflojado: un caso de la base que exige algo del gancho (must-block, must-emit, must-run), verde en la línea de base
 *     de la base, que sale rojo con el pedido. Un gancho borrado cae acá: su caso sale rojo;
 *   · no medido: uno de ésos que sale `nomedido` con el pedido. Es rojo y la firma no lo cubre: se mide de nuevo;
 *   · no se juzga: un caso rojo en la línea de base de la base, uno de la lista de huecos y uno que el corredor saltea;
 *   · endurecer (un must-not-block o must-stay-quiet que ahora frena o habla) o sumar casos no pide nada.
 *
 * LO QUE CARGA EL CORREDOR. El corredor carga, además de lo suyo, bibliotecas de fuera del banco (scripts/lib/…,
 * scripts/setup/…). En el árbol armado salen del pedido, y una que reescribiera el informe taparía un gancho aflojado.
 * Por eso el proceso del corredor —y sólo él— las carga de una copia de la base: un desvío de la resolución de módulos
 * (`-r`, que no pasa a los procesos que lanza) cambia cada archivo del árbol por el mismo de la base. Los ganchos corren
 * en procesos aparte y cargan las bibliotecas del pedido, que es lo que se mide.
 *
 * LA FIRMA. Un aflojado pasa con la constancia del dueño de `run-base-controls.sh approve --entries`, en un archivo de
 * constancias del inventario (scripts/ci/controls-from-base.json de la base) de la rama del pedido. El ancla es
 * `{path, blob}` de TODO lo que el pedido cambia (salvo las constancias): un gancho puede correr por una copia que arma
 * su caso o por un envoltorio, y leer datos que ninguna lectura de rutas ve, así que un ancla más angosta dejaría afuera
 * un aflojamiento que una firma vieja taparía. Vale sólo una constancia del dueño (`by: "dueño"`, sin `via`): ni la
 * delegación ni la sesión designada firmando por su ventana la cubren. Si el pedido cambia algo después, cambia el hash y
 * vuelve a pedirla.
 *
 * EL MERGE DE GITHUB. En un pedido la punta es el merge que arma GitHub: el pedido es su segundo padre, y de ahí salen el
 * cambio y los blobs que se firman (lo que el dueño tiene en su rama), como en run-base-controls.sh. Si main avanzó
 * después de ese merge (una corrida repetida), los casos salen de su primer padre, la base que vio el pedido: con la base
 * nueva, un gancho que main endureció se leería como aflojado por el pedido. Una punta que no trae la base y no es ese
 * merge es «no pude correr».
 *
 * Es autocontenido (sólo módulos de Node) a propósito: es regla del control base-controls (sign_on_change), y su ancla es
 * este archivo solo. El hash y la lectura de constancias repiten los de run-base-controls.sh, que corre como heredoc y no
 * se puede cargar.
 *
 * USO:  node scripts/ci/bench-against-base.js --root <pedido> --base <rev> [--tip <rev>] [--out <dir>]
 * SALIDAS: 0 verde · 1 aflojado sin la firma del dueño, o no medido · 2 uso · 9 no pude correr (la última línea dice por
 * qué; nunca cae a verde).
 *
 * EL LÍMITE: Codex lo sigue midiendo el banco del pedido (la línea de base es de Claude), y el workflow corre del pedido,
 * como en run-base-controls.sh (guides/piezas-del-arnes.md).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BENCH = 'scripts/controls-bench';
const RUNNER = `${BENCH}/runner.js`;
const BASELINE = `${BENCH}/baseline/claude.json`;
const KNOWN_GAPS = 'scripts/tests/windows/known-gaps.json';
const INVENTORY = 'scripts/ci/controls-from-base.json';
const DEFAULT_APPROVALS = ['.github/control-changes/'];
const DEMANDS = new Set(['must-block', 'must-emit', 'must-run']);
const NOT_RUN = 9;

class NotRun extends Error {}
const notRun = (msg) => { throw new NotRun(msg); };

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--root', '--base', '--tip', '--out'].includes(k) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return null;
    out[k.slice(2)] = argv[++i];
  }
  return out.root && out.base ? out : null;
}

// git sin las variables que un hook le pasa a lo que lanza: decide la carpeta
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)));
function git(root, argv, { allowFail } = {}) {
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...argv], { encoding: 'utf8', env: GIT_ENV, maxBuffer: 512 * 1024 * 1024 });
  if (r.error) notRun(`git ${argv[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) notRun(`git ${argv.join(' ')}: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r;
}
const trimNl = (s) => s.replace(/\n+$/, '');
const short = (sha) => String(sha).slice(0, 12);
// Lo que se imprime trae texto del pedido (la salida de sus ganchos, sus rutas) y la CI lee comandos en la salida: cada
// línea sale con los caracteres de control escapados, `##` (Azure, en cualquier lugar) partido y `::` partido al comienzo
// de la línea, que es donde lo lee GitHub. Adentro de la línea se deja: es como se nombra un caso (`gancho::id`)
const escapeControl = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
const neutral = (line) => escapeControl(line).replace(/^(\s*):(?=:)/, '$1: ').replace(/#(?=#)/g, '# ');
const say = (text) => console.log(String(text).split('\n').map(neutral).join('\n'));
// el comando de la firma, para copiar a una terminal: el JSON va entre comillas simples con las suyas escapadas. Una ruta
// que la salida no puede mostrar tal cual (con `::`, `##` o un caracter de control) no se imprime como comando
function signCommand(entries, out) {
  if (entries.some((e) => /::|##|[\x00-\x1f\x7f]/.test(e.path))) return null;
  const quoted = `'${JSON.stringify(entries).replace(/'/g, "'\\''")}'`;
  return `bash scripts/ci/run-base-controls.sh approve --root <repo> --entries ${quoted} --out ${out}`;
}
function commitOf(root, rev) {
  const r = git(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], { allowFail: true });
  return r.status === 0 ? trimNl(r.stdout) : null;
}
function blobOf(root, rev, p) {
  if (!p || p.startsWith('./') || p.startsWith('../')) return null;
  const r = git(root, ['rev-parse', '--verify', '-q', `${rev}:${p}`], { allowFail: true });
  return r.status === 0 ? trimNl(r.stdout) : null;
}
function show(root, rev, p) {
  if (!blobOf(root, rev, p)) return null;
  const r = git(root, ['cat-file', 'blob', `${rev}:${p}`], { allowFail: true });
  return r.status === 0 ? r.stdout : null;
}

const isAncestor = (root, a, b) => git(root, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).status === 0;

// ── el desvío del corredor: sus módulos, de la copia de la base ──────────────────────────────────────────────────────
// Se carga con `node -r` en el proceso del corredor: cada módulo que resuelve adentro del árbol armado (FROM) lo cambia
// por el mismo archivo de la copia de la base (TO); uno que la base no trae corta la corrida. Cubre `require`, que es
// como carga el corredor (no usa `import()`). El archivo principal (el corredor) no pasa por acá:
// queda en el árbol armado, y de ahí sale la raíz desde la que lanza los ganchos
const RUNNER_SHIM = `'use strict';
const Module = require('module');
const fs = require('fs');
const path = require('path');
const from = process.env.BENCH_AGAINST_BASE_FROM;
const to = process.env.BENCH_AGAINST_BASE_TO;
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, ...rest) {
  const f = resolve.call(this, request, parent, isMain, ...rest);
  if (isMain || !from || !to || !path.isAbsolute(f) || !f.startsWith(from + path.sep)) return f;
  const g = path.join(to, path.relative(from, f));
  if (fs.existsSync(g)) return g;
  // un módulo que la base no trae no se toma del pedido: el corredor no arranca, y eso es «no pude correr»
  const e = new Error('el corredor de la base pide ' + path.relative(from, f) + ', que la base no trae');
  e.code = 'MODULE_NOT_FOUND';
  throw e;
};
`;

// ── las constancias: la forma y el hash de run-base-controls.sh ─────────────────────────────────────────────────────
function hashOf(entries) {
  return crypto.createHash('sha256').update(entries.map((e) => `${e.path}\t${e.blob}\n`).sort().join('')).digest('hex');
}
function readApprovals(root, rev, files) {
  const out = [];
  let bad = 0;
  // una constancia que no se lee no firma nada, y se cuenta
  const take = (text) => { try { out.push(JSON.parse(text)); } catch (_) { bad++; } };
  for (const file of files) {
    if (file.endsWith('/')) {
      const r = git(root, ['ls-tree', '-z', '--name-only', rev, '--', file], { allowFail: true });
      for (const p of (r.status === 0 ? r.stdout : '').split('\0').filter(Boolean)) {
        if (p.endsWith('.json')) { const t = show(root, rev, p); if (t !== null) take(t); }
      }
      continue;
    }
    const text = show(root, rev, file);
    if (text !== null) for (const line of text.split('\n')) if (line.trim()) take(line);
  }
  if (bad) say(`⚠️ ${bad} constancia(s) que no se leen (en ${short(rev)}): no firman nada`);
  return out;
}
// sólo la del dueño: sin vía (ni delegación ni refirma) y firmada por él, no por la sesión designada
const ownerSigned = (a, hash) => a && a.hash === hash && Array.isArray(a.rules)
  && a.rules.every((r) => r && typeof r.path === 'string' && typeof r.blob === 'string') && hashOf(a.rules) === hash
  && a.by === 'dueño' && a.via === undefined && a.clase === undefined;

// ── el árbol armado ──────────────────────────────────────────────────────────────────────────────────────────────────
// la punta del pedido con el banco y la lista de huecos de la base: lo que la base no trae, no queda
function assemble(root, base, tip, dir) {
  git(root, ['worktree', 'add', '--quiet', '--detach', dir, tip]);
  for (const p of [BENCH, KNOWN_GAPS]) {
    fs.rmSync(path.join(dir, p), { recursive: true, force: true });
    if (git(root, ['cat-file', '-e', `${base}:${p}`], { allowFail: true }).status === 0) git(dir, ['checkout', '--quiet', base, '--', p]);
  }
}

// el gancho de un caso, para nombrarlo en la salida: su ruta en el repo (también la copia que arma el caso en
// `${FIXTURE}/tcg/…`), o null si el caso arma su propio guion. No decide el ancla de la firma: ésa es todo el pedido
function hookPath(script) {
  const m = /^\$\{(?:TCG|SKILLS)\}\/(.+)$/.exec(String(script || '')) || /^\$\{FIXTURE\}\/tcg\/(.+)$/.exec(String(script || ''));
  return m ? path.posix.normalize(m[1]) : null;
}
function caseHooks(root, base) {
  const map = new Map();
  const list = git(root, ['ls-tree', '-z', '--name-only', base, '--', `${BENCH}/cases/hooks/`], { allowFail: true });
  for (const f of (list.status === 0 ? list.stdout : '').split('\0').filter((x) => x.endsWith('.json'))) {
    let raw; try { raw = JSON.parse(show(root, base, f)); } catch (_) { say(`⚠️ no pude leer ${f} de la base: sus casos salen sin el nombre de su gancho`); continue; }
    for (const h of Array.isArray(raw.hooks) ? raw.hooks : [raw]) {
      // el gancho del caso por sobre su envoltorio (un caso que corre el gancho a través de un guion propio)
      for (const c of h.cases || []) map.set(`${path.basename(String(h.script || h.hook))}::${c.id}`, hookPath(h.script) || hookPath(c.script));
    }
  }
  return map;
}

function main(argv) {
  const a = args(argv);
  if (!a) { console.error('uso: node scripts/ci/bench-against-base.js --root <pedido> --base <rev> [--tip <rev>] [--out <dir>]'); return 2; }
  const root = path.resolve(a.root);
  if (git(root, ['rev-parse', '--git-dir'], { allowFail: true }).status !== 0) notRun(`${root} no es un repo de git`);
  const asked = commitOf(root, a.base) || notRun(`la base ${a.base} no resuelve a un commit en ${root}`);
  const tip = commitOf(root, a.tip || 'HEAD') || notRun(`la punta ${a.tip || 'HEAD'} no resuelve a un commit en ${root}`);
  // el merge que arma GitHub: su primer padre está en la base, y el pedido es su segundo padre (ver la cabecera)
  const parents = trimNl(git(root, ['rev-list', '--parents', '-n', '1', tip]).stdout).split(' ').slice(1);
  const githubMerge = parents.length === 2 && isAncestor(root, parents[0], asked);
  let base = asked;
  if (!isAncestor(root, asked, tip)) {
    if (!githubMerge) notRun(`la punta ${short(tip)} no trae la base ${short(asked)}: traé main al pedido y volvé a correrlo`);
    base = parents[0];
    say(`la punta no trae la base ${short(asked)} (main avanzó después del merge que se revisa): los casos salen de ${short(base)}, la base que vio el pedido`);
  }
  const prHead = githubMerge ? parents[1] : tip;
  const mbR = git(root, ['merge-base', base, prHead], { allowFail: true });
  if (mbR.status !== 0) notRun(`no hay ancestro común entre la base ${short(base)} y el pedido ${short(prHead)}`);
  const mb = trimNl(mbR.stdout);
  if (!blobOf(root, base, RUNNER)) notRun(`la base ${short(base)} no trae ${RUNNER}: no hay con qué medir sus casos`);
  let baseline;
  try { baseline = JSON.parse(show(root, base, BASELINE)).cases; } catch (_) { baseline = null; }
  if (!baseline || typeof baseline !== 'object') notRun(`la base ${short(base)} no trae una línea de base que se lea (${BASELINE})`);
  // dónde viven las constancias lo dice el inventario de la base; uno que está y no se lee es «no pude correr»
  const inventoryRaw = show(root, base, INVENTORY);
  let inv = null;
  if (inventoryRaw !== null) { try { inv = JSON.parse(inventoryRaw); } catch (e) { notRun(`no pude leer ${INVENTORY} de la base: ${e.message}`); } }
  const approvalFiles = [].concat((inv && inv.approvals) || DEFAULT_APPROVALS).filter((x) => typeof x === 'string' && x);

  const out = a.out ? path.resolve(a.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'bench-against-base-out-'));
  fs.mkdirSync(out, { recursive: true });
  // la carpeta de trabajo: el árbol armado, la copia de la base para los módulos del corredor y su desvío
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-against-base-')));
  const dir = path.join(work, 'arbol');
  const baseCopy = path.join(work, 'base');
  const shim = path.join(work, 'desvio.js');
  let report;
  try {
    try {
      assemble(root, base, tip, dir);
      git(root, ['worktree', 'add', '--quiet', '--detach', baseCopy, base]);
      fs.writeFileSync(shim, RUNNER_SHIM);
    } catch (e) { notRun(`no pude armar el árbol (la punta ${short(tip)} con el banco de la base ${short(base)}): ${e.message}`); }
    const env = Object.fromEntries(Object.entries(GIT_ENV).filter(([k]) => !/^(TYCON_BENCH_|NODE_OPTIONS$)/.test(k)));
    Object.assign(env, { TYCON_SKILLS_DIR: dir, TYCON_GUIDES_DIR: dir, BENCH_AGAINST_BASE_FROM: dir, BENCH_AGAINST_BASE_TO: baseCopy });
    const json = path.join(out, 'bench-base.json');
    const log = path.join(out, 'bench-base.log');
    fs.rmSync(json, { force: true });
    say(`banco de la base: los casos, la línea de base y el corredor de ${short(base)} sobre los ganchos de ${short(tip)} (salida: ${log})`);
    const r = spawnSync(process.execPath, ['-r', shim, path.join(dir, RUNNER), '--tool', 'both', '--json', json],
      { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
    fs.writeFileSync(log, `${r.stdout || ''}${r.stderr || ''}`);
    if (r.error) notRun(`el corredor de la base no arrancó: ${r.error.message}`);
    if (r.status !== 0 && r.status !== 1) notRun(`el corredor de la base salió ${r.status} (ni 0 ni 1): ${trimNl(r.stdout || r.stderr || '').split('\n').pop()}`);
    try { report = JSON.parse(fs.readFileSync(json, 'utf8')); } catch (e) { notRun(`el corredor de la base no dejó su informe (${json}): ${e.message}`); }
  } finally {
    for (const w of [dir, baseCopy]) git(root, ['worktree', 'remove', '--force', w], { allowFail: true });
    fs.rmSync(work, { recursive: true, force: true });
    git(root, ['worktree', 'prune'], { allowFail: true });
  }

  const results = report && report.results;
  if (!results || typeof results !== 'object') notRun('el informe del corredor de la base no trae «results»');
  const hooks = caseHooks(root, base);
  const loose = [];
  const unmeasured = [];
  const missing = [];
  let judged = 0;
  let skipped = 0;
  for (const [key, wasGreen] of Object.entries(baseline)) {
    if (wasGreen !== true) continue;
    const res = results[key];
    // un caso que el informe no trae, o que trae sin su tipo o sin la corrida de Claude, no se midió
    const now = res && res.tools && res.tools.claude;
    if (!res || !res.type || !now) { missing.push(key); continue; }
    if (!DEMANDS.has(res.type)) continue;
    if (now.skipped || now.known_gap) { skipped++; continue; }
    judged++;
    if (now.nomedido) unmeasured.push({ key, why: (now.failures || []).join(' | ') });
    else if (!now.pass) loose.push({ key, type: res.type, hook: hooks.get(key) || null, failures: now.failures || [] });
  }
  // un caso de la línea de base que el corredor no devolvió, o ningún caso juzgado, es «no pude medir», nunca verde
  if (missing.length) notRun(`el corredor de la base no midió ${missing.length} caso(s) de su línea de base:${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`);
  if (!judged) notRun('ningún caso de la base se pudo juzgar: la línea de base no tiene casos verdes que exijan algo de su gancho, o el corredor los salteó todos');
  say(`${judged} caso(s) de la base que exigen algo de su gancho, verdes en su línea de base: ${loose.length} aflojado(s), ${unmeasured.length} no medido(s)${skipped ? ` · ${skipped} salteado(s) por el corredor (otro sistema, la lista de huecos o una asimetría declarada): no se juzgan` : ''}`);
  for (const u of unmeasured) say(`🟡 no medido: ${u.key} — ${u.why}. La firma no cubre lo que no se midió: volvé a correrlo`);
  for (const l of loose) {
    say(`❌ aflojado: ${l.key} · gancho ${l.hook || '(lo arma el caso)'} · la base esperaba ${l.type} (verde en su línea de base) · con el pedido: ${l.failures.join(' | ') || 'rojo'}`);
  }
  if (!loose.length) return unmeasured.length ? 1 : 0;

  // el ancla: todo lo que el pedido cambia, en su rama, salvo las constancias (ver la cabecera)
  // con --no-renames un renombre trae las dos rutas (la vieja, borrada); de una carpeta de constancias se excluyen sólo
  // las constancias (`<carpeta>/<hash>.json`, primer nivel), como las lee run-base-controls.sh: lo demás que haya ahí se ancla
  const isApproval = (p) => approvalFiles.some((f) => (f.endsWith('/') ? p.startsWith(f) && /^[^/]+\.json$/.test(p.slice(f.length)) : p === f));
  const changed = [...new Set(git(root, ['diff', '--name-only', '--no-renames', '-z', `${mb}...${prHead}`]).stdout.split('\0').filter(Boolean))]
    .filter((p) => !isApproval(p));
  const entries = changed.sort().map((p) => ({ path: p, blob: blobOf(root, prHead, p) || 'borrado' }));
  const hash = hashOf(entries);
  const signed = readApprovals(root, prHead, approvalFiles).some((x) => ownerSigned(x, hash));
  if (signed && !unmeasured.length) {
    say(`✅ con la constancia del dueño (${short(hash)}…) para todo lo que cambia el pedido: ${entries.map((e) => e.path).join(', ')}`);
    return 0;
  }
  if (signed) return 1;
  say(`El pedido afloja ${loose.length === 1 ? 'un freno' : `${loose.length} frenos`} sin la constancia del dueño. La firma es del dueño, en la ventana del dueño o en su terminal: ni la delegación ni la sesión designada la cubren. Cubre todo lo que cambia el pedido (${entries.length} archivo(s)): si cambia algo más, se vuelve a pedir.`);
  const command = signCommand(entries, approvalFiles[0]);
  if (command) say(`El comando, en la rama del pedido:\n   ${command}`);
  else say(`Una ruta del pedido no se puede mostrar tal cual en un comando: armá las entradas de --entries a mano con ${entries.length} archivo(s) (${hash}).`);
  return 1;
}

module.exports = { signCommand, neutral };

if (require.main === module) {
  // un error que no se esperaba tampoco cae a 1 (que se leería como un aflojamiento) ni a verde: es «no pude correr»
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    say(`no pude correr: ${e instanceof NotRun ? e.message : String((e && e.stack) || e)}`);
    process.exitCode = NOT_RUN;
  }
}
