#!/usr/bin/env node
// branch-guard-notice.js — SessionStart hook: grita si los repos compartidos del
// harness (el arnés, agent-skills) NO están checkouteados en main, o si
// están en main pero ATRASADOS respecto de lo publicado (origin/main), o TRABADOS
// (conflicto abierto que dejó un autostash del arranque).
//
// POR QUÉ EXISTE (2026-08-20, Etapa A migración Codex): esos dos repos son UNA copia
// en el disco de cada dev, y TODAS las sesiones leen guías/skills de lo que esté
// checkouteado. La convención de la migración es un branch por etapa (codex/etapa-*)
// mergeado a main al cerrar — si la sesión que trabaja la migración deja el clon
// parado en su branch, cualquier otra sesión arranca leyendo el arnés a medio hacer,
// SIN ningún error visible. La regla del clon compartido (codex-migration.md §5) dice
// "no se confía en memoria": este hook es el chequeo mecánico.
//
// SEGUNDA CONDICIÓN (2026-09-03): "clon válido" no es sólo "en main" — es "en main Y al
// día". La línea de arranque hace `git pull` y descarta el error a propósito; si un archivo
// modificado localmente choca con lo publicado, el pull no avanza y nadie se entera. Medido
// en una máquina del equipo: 272 commits atrás durante seis días, corriendo el instalador
// viejo cada día (el instalador vive adentro del clon), con el freno de story-a-mano
// llegado por agent-skills y sin el hook que lo abre. El archivo que trababa lo había
// escrito el propio arnés (el capturador de retrospectivas). Este hook lee origin/main tal
// como quedó del último fetch — el pull del arranque hace el fetch aunque el merge falle,
// salvo con el clon trabado (abajo), donde muere antes de fetchear: ahí "al día" puede ser
// viejo, y el fetch lo hace la sanadora — así que no necesita red: compara y nombra el
// archivo que traba.
//
// TERCERA CONDICIÓN (hallazgo H1 de la revisión adversarial del mismo día): con la línea
// de arranque ya protegida (`--autostash`), la primera vez que lo local no se puede reaplicar
// sobre lo nuevo git guarda lo local en el stash pero deja el archivo con marcadores de
// conflicto (`UU`) — y desde ahí ningún pull entra ("unmerged files"), con behind = 0. El
// consejo `git stash` en ese estado git lo rechaza. Acá se detecta y se da el consejo que sí
// funciona. Repararlo es tarea de lib/guides-heal.js del pipeline (al primer prompt); avisar
// es tarea de acá. incident-log#arnes-que-se-bloquea-a-si-mismo-2026-09-03
//
// COMPORTAMIENTO: en cada arranque de sesión, por cada repo: rama actual; si está en main,
// conflicto abierto por autostash, y cuántos commits está atrás de origin/main (si lo tiene).
// Cualquier problema → aviso a gritos por stdout (se inyecta como contexto de la sesión). SIN
// throttle a propósito: mientras la condición exista, cada sesión nueva la ve — un aviso que
// se calla es exactamente el silencio que este hook combate.
//
// Off: TYCON_BRANCH_GUARD=0
// Fail-open total: cualquier error → exit 0 sin output (nunca rompe el arranque).

'use strict';
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const os = require('os');
const { execFileSync } = require('child_process');

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: Object.assign({}, process.env, { LC_ALL: 'C' }),
  }).trim();
}
const lines = (s) => String(s || '').split('\n').filter(Boolean);

// ── «no pude leer» no es «no hay» (story 8.13, tanda D, segunda vuelta de revisores) ─────────────────────────────────
// Un `git` que falla no dice POR QUÉ con su sola falla: una ref con basura adentro, un lock o el tope de tiempo fallan
// igual que una ref ausente. Leer esa falla como «la rama no existe», «no es un clon», «sin conflictos» o «al día» es
// inventar un veredicto. Lo que DECIDE algo pasa por acá y distingue tres estados; ante «no se pudo leer» el aviso lo
// dice en una línea y no juzga ese clon (ni grita ni calla). Mismos topes de tiempo que `git()`.
/** Como `git()`, sin tirar: `{ ok: true, out }`, o `{ ok: false, code, silent, noGit }` — `code` es el de salida (`null`
 *  si lo cortó el tope de tiempo), `silent` si no escribió nada en stderr, `noGit` si en la máquina no hay git. */
function gitTry(dir, args) {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { LC_ALL: 'C' }),
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return {
      ok: false,
      code: e && typeof e.status === 'number' ? e.status : null,
      silent: !String((e && e.stderr) || '').trim(),
      noGit: Boolean(e && e.code === 'ENOENT'),
    };
  }
}
/** Una ref de ese clon: `'present'` (existe y lleva a un commit) · `'absent'` (no existe: `rev-parse --verify -q` sale con
 *  1 y sin decir nada) · `'unreadable'` (cualquier otra cosa: basura adentro —sale con 1 pero avisa por stderr—, un sha
 *  que no está, un lock, el tope de tiempo). Por código de salida y por si habló, nunca por el texto: no depende del
 *  idioma de git. */
function refState(dir, ref) {
  const r = gitTry(dir, ['rev-parse', '--verify', '-q', ref]);
  if (!r.ok) return r.code === 1 && r.silent ? 'absent' : 'unreadable';
  return gitTry(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).ok ? 'present' : 'unreadable';
}
/** ¿Esa carpeta es un clon? (tiene `.git`). Con un clon cuyo HEAD está roto git contesta «no es un repo»: mirar la carpeta
 *  es lo que separa «no está clonado» —no es problema de este aviso— de «está clonado y no lo pude leer». */
function isClone(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

/** Archivos en conflicto abierto, con sus etapas del índice (1 base · 2 la de HEAD · 3 la otra). Con `-z`: una ruta con
 *  espacio llega entera y sin las comillas que le pone `status --porcelain`. `null` si no se pudo mirar el índice. */
function unmergedFiles(dir) {
  try {
    const stages = new Map();
    for (const rec of git(dir, ['ls-files', '-u', '-z']).split('\0').filter(Boolean)) {
      const tab = rec.indexOf('\t');
      const p = rec.slice(tab + 1);
      if (!stages.has(p)) stages.set(p, new Set());
      stages.get(p).add(rec.slice(0, tab).split(' ')[2]);
    }
    return [...stages].map(([file, s]) => ({ file, inHead: s.has('2') }));
  } catch {
    return null;
  }
}

/** Una ruta o una carpeta lista para pegar en la shell: tal cual si es `[\w./-]+`; si no, entre comillas simples. Vive
 *  acá y no en scripts/lib/: el banco de controles copia este hook suelto. */
function sh(s) {
  return /^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** ¿El stash de arriba es un autostash (del arranque, o de guides-heal)? `null` si no se pudo mirar el stash. */
function topStashIsAutostash(dir) {
  try { return /autostash|tycon-guides-heal/i.test(lines(git(dir, ['stash', 'list']))[0] || ''); } catch { return null; }
}

/** Lo que traba el avance: trackeados modificados que también cambian, y no-trackeados que origin agrega. Si no se pudo
 *  mirar, las listas van vacías y `unread` lo dice: «no vi qué lo traba» no es «nada lo traba». */
function collidingFiles(dir, upstreamRef = 'origin/main') {
  try {
    const local = new Set(lines(git(dir, ['diff', '--name-only', 'HEAD'])));
    const untracked = new Set(lines(git(dir, ['ls-files', '--others', '--exclude-standard'])));
    const upstream = lines(git(dir, ['diff', '--name-only', 'HEAD', upstreamRef]));
    return { tracked: upstream.filter((f) => local.has(f)), untracked: upstream.filter((f) => untracked.has(f)), unread: false };
  } catch {
    return { tracked: [], untracked: [], unread: true };
  }
}

/** Consejo manual que funciona en el estado real (git rechaza `stash` sobre un índice en conflicto). */
function manualAdvice(dir, stuck, unmerged, collide) {
  const steps = [];
  const d = sh(dir);
  // Sólo los archivos en conflicto, NUNCA `reset --hard`: lo que el dev haya editado después de
  // quedar trabado no está en ningún stash (hallazgo H8 de la segunda pasada adversarial).
  // Un comando por tipo (story 8.5.1): `checkout HEAD --` sobre una ruta que HEAD no tiene (DU: el retiro de las skills
  // de terceros borró un archivo que el dev había tocado) falla ENTERO y no resuelve ni los demás. Ésas salen del
  // índice con `rm --cached`: el archivo del dev queda en el disco, y su versión sigue en el stash.
  if (stuck) {
    const gone = unmerged.filter((u) => !u.inHead).map((u) => sh(u.file));
    const kept = unmerged.filter((u) => u.inHead).map((u) => sh(u.file));
    if (gone.length) steps.push(`git -C ${d} rm --cached -- ${gone.join(' ')}   # los que lo publicado borró: tu versión queda en el disco y en el stash`);
    if (kept.length) steps.push(`git -C ${d} checkout HEAD -- ${kept.join(' ')}   # sólo los archivos en conflicto; lo tuyo ya está en el stash (git stash list)`);
    // Trabado Y atrasado: lo que el dev tocó DESPUÉS de trabarse y lo publicado también cambia traba el merge (pase
    // adversarial de la 8.5.1). Con el índice ya sin conflictos, `git stash` sí se acepta.
    const inConflict = new Set(unmerged.map((u) => u.file));
    if (collide.tracked.some((f) => !inConflict.has(f))) steps.push(`git -C ${d} stash   # lo que tocaste después y lo publicado cambia`);
  } else steps.push(`git -C ${d} stash`);
  if (collide.untracked.length) steps.push(`mové o borrá: ${collide.untracked.join(', ')}   # no trackeados que lo publicado agrega`);
  steps.push(`git -C ${d} merge --ff-only origin/main`);
  return steps;
}

// ── story 8.13 (tanda A, AC 9): el estado del mecanismo de instalación y su política ──────────────────────────────
// Este hook es síncrono: es el camino que hoy SÍ lleva un aviso a la conversación. Desde la 8.13 (a) imprime el `notice`
// pendiente que dejó `harness.js startup` (versión nueva en `ask`, fallo, retención, origen cambiado, Node viejo, estado
// roto), DIRIGIDO A LA PERSONA —el agente no aplica una actualización por su cuenta—; y (b) el grito de «atrasado» sólo en
// `managed` con `apply: auto`: en `developer`, en `ask` o con TYCON_UPDATE=0 el atraso es decisión de esa persona y lo dice
// `doctor`; con retención (`hold`, tanda C) tampoco: imprime la retención. Sin estado (una máquina que todavía no pasó
// por la tanda A) todo sigue como hoy. Vive acá y no en scripts/lib/ por la misma razón que `sh()`: el banco copia este
// hook suelto — por eso la política se lee con lo que haya: la variable
// (manda siempre), el lector de configuración si está al lado, lo que `startup` dejó en el estado, o `auto` (lo de hoy).
const fs = require('fs');
const STATE_FILE = path.join(stateDirOf(os.homedir()), 'harness-state.json');

/** `{ status: 'absent' | 'broken' | 'ok', state, why }` — un estado ilegible NO es «sin estado» (8.3 AC 2): tampoco
 *  uno de una versión más nueva (`schema` > 1) ni uno que apunta a un árbol que no está (revisor de alcance, iteración
 *  1: el hook sólo veía el JSON roto). Si mirar el archivo falla, también es «roto», nunca «sin estado». */
const SCHEMA_KNOWN = 1;
function harnessState() {
  let exists;
  try { exists = fs.existsSync(STATE_FILE); } catch { return { status: 'broken', why: 'no se pudo mirar' }; }
  if (!exists) return { status: 'absent' };
  let s;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { status: 'broken', why: 'no se puede leer' }; }
  if (!s || typeof s.schema !== 'number' || s.schema < 1) return { status: 'broken', why: 'no se puede leer' };
  if (s.schema > SCHEMA_KNOWN) return { status: 'broken', why: `es de una versión más nueva (schema ${s.schema})` };
  if (typeof s.tree === 'string' && s.tree && !fs.existsSync(s.tree)) return { status: 'broken', why: `apunta a un árbol que no está (${s.tree})` };
  return { status: 'ok', state: s };
}

/** La política de actualización: `{ enabled, apply: 'auto' | 'ask' }`. Variable › configuración › estado › auto. */
function updatePolicy(state) {
  const env = process.env;
  if (env.TYCON_UPDATE === '0') return { enabled: false, apply: null };
  if (env.TYCON_UPDATE_APPLY === 'auto' || env.TYCON_UPDATE_APPLY === 'ask') return { enabled: true, apply: env.TYCON_UPDATE_APPLY };
  try {
    const cfg = require('../lib/tycon-config.js');
    const r = cfg.leerParaHook();
    if (r.ok) { const v = cfg.valor(r.config, 'update.apply'); if (v === 'auto' || v === 'ask') return { enabled: true, apply: v }; }
  } catch { /* el hook corre suelto (banco) o el lector no conoce `update` todavía */ }
  const p = state && state.policy;
  if (p && (p.apply === 'auto' || p.apply === 'ask')) return { enabled: p.enabled !== false, apply: p.apply };
  return { enabled: true, apply: 'auto' };
}

// ── story 8.13 (tanda D, AC 25): una copia del repo público vive en la rama local `tycon/installed` ──────────────────
// Los dos canales del público (`mirror/sync` y `main`) se consumen con una rama local `tycon/installed` + `reset --hard`.
// Sin esto, después de su primera actualización cada sesión de una persona de afuera arrancaba con «FUERA de main», y el
// atraso se medía contra la ref equivocada. Sólo cuando EL ESTADO dice que esa fuente se reescribe: sin estado (el banco
// de controles corre este hook suelto) o con una fuente de ref fija, todo sigue como siempre.
//
// La fuente se busca por la CARPETA, no por el nombre (causa A del pase adversarial de la tanda D): la copia pública es
// UN solo repo —el estado trae una fuente, `harness`, y `~/.claude/agent-skills` es un enlace a ese mismo clon—. Buscando
// `agent_skills` por nombre no aparecía, la rama de casa quedaba en `main`, y cada sesión posterior a la primera
// actualización arrancaba con «agent-skills FUERA de main» y el consejo `checkout main`, que deja a `update` bloqueado.
// Un clon es de una fuente si su carpeta real ES la `dir` de esa fuente; y si dos de los repos que se recorren son el
// mismo clon, se juzga una vez.
const INSTALLED_BRANCH = 'tycon/installed';
const REF_SHAPE = /^[A-Za-z0-9._/-]{1,100}$/;
/** La identidad de una carpeta, siguiendo enlaces: `{ id }` con su número en el disco (así un enlace, `/tmp` contra
 *  `/private/tmp` o una ruta escrita con otra caja en un disco que no distingue mayúsculas son la MISMA carpeta); si el
 *  disco no da número, su ruta real. Sin identidad: `{ id: null, unreadable }` — `unreadable: false` si la carpeta NO
 *  ESTÁ (no es la misma que ninguna), `true` si está y no se pudo mirar (permisos, disco): ahí no se sabe. */
function folderId(dir) {
  try {
    const st = fs.statSync(dir, { bigint: true });
    return { id: st.ino ? `i:${st.dev}:${st.ino}` : `p:${fs.realpathSync.native(dir)}` };
  } catch (e) {
    return { id: null, unreadable: !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) };
  }
}
/** La fuente del estado cuya carpeta es ese clon (`dir`; la del arnés sin `dir`, el `tree` del estado): `{ source }` con
 *  la fuente si el estado dice que se reescribe, o `null` si no —o si el estado no nombra ese clon—. `unread: true` si
 *  ninguna coincidió y la carpeta de alguna no se pudo mirar: no se sabe si esa fuente es este clon. */
function rewrittenSource(state, id) {
  const list = state && Array.isArray(state.sources) ? state.sources : [];
  let unread = false;
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const d = typeof x.dir === 'string' && x.dir ? x.dir : (x.name === 'harness' && typeof state.tree === 'string' && state.tree ? state.tree : null);
    if (d === null) continue;
    const f = folderId(d);
    if (f.id === id) return { source: x.rewrites === true ? x : null, unread: false };
    if (f.id === null && f.unreadable) unread = true;
  }
  return { source: null, unread };
}
/** Cómo se nombra un clon en el aviso: una vez, aunque en esta máquina sea dos de los repos que se recorren. */
const shown = (l) => (l.also.length ? `${l.name} (el mismo clon que ${l.also.join(', ')})` : l.name);

// ── story 8.9 (tanda E, AC 53): los nombres viejos después de la fecha de retiro ──────────────────────────────────────
// Durante el renombre a inglés un nombre viejo sigue andando en silencio y cada uso se anota en
// ~/.claude/.tycon-pipeline/legacy-names.jsonl (AC 17). Pasada `retire_after` del mapa (scripts/lib/renames.json), si esta
// máquina anotó usos en los últimos 14 días, UNA línea dice cuáles y dónde cambiarlos: la story de retiro saca los nombres
// viejos y lo que todavía los usa dejaría de andar. Antes de la fecha, nada (el silencio de la transición es a propósito).
// Vive en este aviso y no en un hook propio: es el aviso de arranque sobre el estado del arnés en esta máquina, y un hook
// nuevo pedía registrarlo en el instalador, el banco y Codex para una línea que vive hasta la story de retiro. Lee el mapa
// y el registro directo (sin `legacy-names.js`): el banco copia este hook suelto, y sin mapa al lado calla.
// Las variables renombradas a inglés (TYCON_TODAY tiene nombre viejo, tanda B1) van por la biblioteca de nombres viejos,
// como en los demás hooks; sin la biblioteca al lado (el banco copia este hook suelto), el nombre nuevo a secas.
const readVar = (() => {
  try {
    const { readEnv } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
    return (n) => readEnv(n, { where: 'scripts/hooks/branch-guard-notice.js' });
  } catch { return (n) => process.env[n]; }
})();
const LEGACY_WINDOW_DAYS = 14;
const LEGACY_MAX_ITEMS = 4;
const LEGACY_MAX_SCRIPTS = 3;
// un nombre del mapa (sin espacios, comillas ni barras invertidas) y un guion relativo a su repo: lo que anota legacy-names.js
const LEGACY_NAME_SHAPE = /^[^\s"'\\]{1,200}$/;
const LEGACY_SCRIPT_SHAPE = /^(?![/~])(?![A-Za-z]:)[A-Za-z0-9._/-]{1,300}$/;
const isDate = (f) => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`))
  && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const minusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
// Los estados (`state-file`) los migra el arnés solo —prepareStateWrite copia el viejo al nuevo y anota el uso—: no hay
// nada que la persona tenga que cambiar, y «renombralo» pisaría el nuevo con el contenido viejo. No se avisan.
const LEGACY_NOT_FOR_PEOPLE = new Set(['state-file']);
/** Dónde se cambia un nombre viejo, según su tipo. `scripts`: los guiones que lo recibieron, el más reciente primero. */
function whereToChange(u, scripts) {
  const quien = scripts.slice(0, LEGACY_MAX_SCRIPTS).join(', ')
    + (scripts.length > LEGACY_MAX_SCRIPTS ? ` y ${scripts.length - LEGACY_MAX_SCRIPTS} más` : '');
  if (u.kind === 'env') return 'variable, en tu entorno: ~/.zshrc, el env de settings.json o el pipeline que la pone';
  if (u.kind === 'option') return `opción, en quien llama a ${quien}`;
  if (u.kind === 'subcommand' || u.kind === 'value') return `${u.kind === 'value' ? 'valor' : 'subcomando'}, en quien llama a ${quien}`;
  if (u.kind === 'file' || u.kind === 'folder') return 'ruta, donde se la llama: un guion propio, otro repo o un pipeline';
  if (u.kind === 'key') return `clave, en el archivo que lee ${quien}`;
  return 'archivo de configuración: renombralo al nuevo en el repo donde está';
}
// «No está» es legítimo (el banco copia este hook suelto, sin mapa; una máquina sin usos no tiene registro): calla. «Está y
// no lo pude leer» (permiso, disco, un mapa que no parsea) NO es «no hay nombres viejos en uso»: se dice, en una línea, y
// el arranque sigue (revisores de la tanda E).
// el motivo va en una sola línea y corto: el mensaje de un JSON roto cita el contenido del archivo
const legacyWhy = (e) => String((e && (e.code || e.message)) || 'sin detalle').replace(/\s+/g, ' ').slice(0, 120);
const legacyUnread = (what, e) => `🔔 TYCON — nombres viejos: no pude leer ${what} (${legacyWhy(e)}); no sé si esta máquina sigue usando alguno después de su fecha de retiro. Decile a la persona en una línea.`;
function legacyRetireLine() {
  try {
    const mapFile = process.env.TYCON_LEGACY_NAMES_MAP || path.join(__dirname, '..', 'lib', 'renames.json');
    let retire;
    try { retire = JSON.parse(fs.readFileSync(mapFile, 'utf8')).retire_after; } catch (e) {
      return e && e.code === 'ENOENT' ? null : legacyUnread('el mapa de renombres', e);
    }
    const fixed = readVar('TYCON_TODAY');
    const today = isDate(fixed) ? fixed : localDay(new Date());
    if (!isDate(retire) || today <= retire) return null;
    let raw;
    try { raw = fs.readFileSync(path.join(stateDirOf(os.homedir()), 'legacy-names.jsonl'), 'utf8'); } catch (e) {
      return e && e.code === 'ENOENT' ? null : legacyUnread('el registro de usos (~/.claude/.tycon-pipeline/legacy-names.jsonl)', e);
    }
    const since = minusDays(today, LEGACY_WINDOW_DAYS - 1);
    // por (tipo, nombre viejo), con CADA guion que lo recibió y el día más reciente de cada uno: el mismo nombre viejo vive
    // en varios guiones (opciones de igual nombre), y quedarse con la primera línea nombraba sólo el más viejo
    const used = new Map();
    for (const line of raw.split('\n')) {
      let u;
      try { u = JSON.parse(line); } catch { continue; }
      if (!u || !isDate(u.day) || u.day < since || u.day > today || typeof u.old !== 'string' || typeof u.new !== 'string') continue;
      // la forma que anota legacy-names.js (la misma que exige la subida al buzón): una línea rara no entra al aviso
      if (!LEGACY_NAME_SHAPE.test(u.old) || !LEGACY_NAME_SHAPE.test(u.new)) continue;
      if (LEGACY_NOT_FOR_PEOPLE.has(u.kind)) continue;
      const k = `${u.kind}\0${u.old}`;
      if (!used.has(k)) used.set(k, { u, last: u.day, scripts: new Map() });
      const g = used.get(k);
      if (u.day > g.last) g.last = u.day;
      const s = typeof u.script === 'string' && LEGACY_SCRIPT_SHAPE.test(u.script) ? u.script : '?';
      if (!g.scripts.has(s) || g.scripts.get(s) < u.day) g.scripts.set(s, u.day);
    }
    if (!used.size) return null;
    const show = (u) => (u.kind === 'option' ? `--${u.old} → --${u.new}` : `${u.old} → ${u.new}`);
    const byRecent = (a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0);
    const items = [...used.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0)).slice(0, LEGACY_MAX_ITEMS)
      .map((g) => `${show(g.u)} (${whereToChange(g.u, [...g.scripts].sort(byRecent).map(([s]) => s))})`);
    const more = used.size > LEGACY_MAX_ITEMS ? `; y ${used.size - LEGACY_MAX_ITEMS} más en ~/.claude/.tycon-pipeline/legacy-names.jsonl` : '';
    return `🔔 TYCON — nombres viejos después de su fecha de retiro (${retire}): esta máquina usó ${used.size} en los últimos ${LEGACY_WINDOW_DAYS} días — ${items.join('; ')}${more}. Cambialos por el nuevo antes de la story de retiro, que los saca (guides/nombres-en-ingles.md). Decile a la persona en una línea.`;
  } catch (e) {
    return legacyUnread('el aviso completo: falló al armarlo', e);
  }
}

/**
 * «No se pudo actualizar desde <fecha>: <motivo>» (story 8.23, tanda L, AC 39): lo anota el arranque que no pudo —también
 * el que se fue porque otra sesión tenía el candado— y acá se dice desde el segundo arranque fallido. La regla y el texto
 * viven en scripts/setup/harness/report.js; se carga SI ESTÁ al lado (el banco copia este hook suelto). Si está y no
 * carga, se dice: no se calla.
 */
function updateFailureLine() {
  const lib = path.join(__dirname, '..', 'setup', 'harness', 'report.js');
  if (!fs.existsSync(lib)) return null;
  try {
    const R = require(lib);
    const text = R.updateFailureText(R.readUpdateFailure(os.homedir()));
    return text ? `🔔 TYCON — el arnés no se está actualizando — decile a la persona: ${text}` : null;
  } catch (e) {
    return `🔔 TYCON — no pude leer si el arnés se está actualizando (${String(e && e.message || e).split('\n')[0]}): harness.js doctor lo detalla.`;
  }
}

/**
 * La línea vieja del índice (2026-10-14: el índice de guías pasó de README.md a INDEX.md, y README.md quedó como la
 * portada). Una sesión que arrancó con `@~/.claude/tycon-harness/README.md` en ~/.claude/CLAUDE.md cargó la portada, no el
 * índice: la línea se reescribe acá (import-line.js, la misma regla que el aplicador y harness.js) y a ESTA sesión, que ya
 * leyó el CLAUDE.md, se le pasa el índice. El índice no entra entero en la salida de un aviso de arranque (Claude Code
 * guarda en un archivo lo que pasa de ~10 KB y deja sólo el comienzo), así que se le pide leerlo por su ruta. En Codex
 * este aviso también corre; Codex nunca cargó el índice, y la línea le pide lo mismo una sola vez.
 * Con la línea vieja Y la de hoy (la sesión siguiente a una actualización por el arranque: el aplicador nuevo reescribe la
 * línea, y después el programa de antes, que todavía corre ese arranque, agrega la suya) la sesión sí cargó el índice:
 * se saca la repetida y no se dice nada.
 * Sin la biblioteca, sin INDEX.md en el árbol (una versión de antes) o sin la línea vieja → nada.
 */
function oldIndexLines() {
  const lib = path.join(__dirname, '..', 'setup', 'harness', 'import-line.js');
  const index = path.resolve(__dirname, '..', '..', 'INDEX.md');
  if (!fs.existsSync(lib) || !fs.existsSync(index)) return [];
  const IL = require(lib);
  const file = IL.claudeMdPath();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  if (!IL.hasOldForm(text)) return [];
  const r = IL.fixFile(file);
  if (text.split('\n').some((l) => IL.CURRENT_FORMS.includes(l.replace(/\r$/, '').trim()))) return [];
  const fixed = r.status === 'fixed'
    ? 'ya la pasé a INDEX.md: desde la próxima sesión se carga sola'
    : `no pude reescribirla (${r.reason || r.status}); la reescribe la próxima actualización o el próximo arranque`;
  return [
    `🔔 TYCON — esta sesión arrancó con la línea vieja del índice de guías en ${file}: cargó la portada del arnés, no el índice. La línea: ${fixed}.`,
    `   Para ESTA sesión, leé ahora entero ${index} antes de seguir: es el índice de guías («Cuándo leer cada guía» y las reglas siempre activas). No hace falta decírselo a la persona.`,
  ];
}

/**
 * PowerShell 7 faltante en Windows (story 8.35, decisión del dueño 2026-10-14). La línea de arranque de Windows es
 * `pwsh -Command "…"`: sin `pwsh`, falla en silencio y el arnés deja de arrancar y de actualizarse; sólo `doctor` lo decía.
 * Este hook corre con Node, así que puede avisarlo: una vez por máquina (la marca vive en la carpeta de estado); con `pwsh`
 * de vuelta la marca se borra, así que si vuelve a faltar avisa otra vez. `TYCON_BRANCH_GUARD_PLATFORM` es sólo de pruebas.
 */
function pwshMissingLines() {
  const platform = process.env.TYCON_BRANCH_GUARD_PLATFORM || process.platform;
  if (platform !== 'win32') return [];
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  // (el de la Microsoft Store es un alias de ejecución —un punto de reanálisis de 0 bytes— y `stat` puede fallar sobre él:
  // cuenta la entrada como la ve `lstat`, salvo una carpeta: Windows sólo ejecuta `pwsh.exe`)
  const found = dirs.some((d) => { try { return !fs.lstatSync(path.join(d, 'pwsh.exe')).isDirectory(); } catch (_) { return false; } });
  let stateDir;
  try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); stateDir = TH.stateDir(os.homedir()); } catch (_) { stateDir = path.join(os.homedir(), '.claude', '.tycon-pipeline'); }
  const mark = path.join(stateDir, 'pwsh-missing-notice.json');
  if (found) { try { fs.rmSync(mark, { force: true }); } catch (_) { /* nada */ } return []; }
  if (fs.existsSync(mark)) return [];
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(mark, `${JSON.stringify({ at: new Date().toISOString() })}\n`); } catch (_) { /* sin marca: avisa de nuevo la próxima */ }
  return [
    '🔔 TYCON — falta PowerShell 7 (pwsh) en esta máquina: sin él, el arranque del arnés no corre y el arnés no se actualiza. Decile a la persona, en una línea: instalalo con `winget install --id Microsoft.PowerShell --source winget` y abrí una sesión nueva. (Este aviso sale una sola vez.)',
  ];
}

try {
  if (process.env.TYCON_BRANCH_GUARD === '0') process.exit(0);
  const harnessLines = [];
  try { harnessLines.push(...pwshMissingLines()); } catch (_) { /* fail-open: un aviso que tira no frena el arranque */ }
  try { harnessLines.push(...oldIndexLines()); } catch (_) { /* fail-open: lo repone el próximo arranque */ }

  const hs = harnessState();
  const legacyLine = legacyRetireLine();
  if (legacyLine) harnessLines.push(legacyLine);
  const failureLine = updateFailureLine();
  if (failureLine) harnessLines.push(failureLine);
  if (hs.status === 'broken') {
    harnessLines.push(
      `🔔 TYCON — el estado del mecanismo de instalación (~/.claude/.tycon-pipeline/harness-state.json) ${hs.why || 'no se puede leer'}.`,
      '   Decile a la persona; `node ~/.claude/tycon-harness/scripts/setup/harness.js doctor` lo detalla. No lo arregles sin que te lo pida.',
    );
  } else if (hs.status === 'ok' && hs.state.notice) {
    harnessLines.push(
      `🔔 TYCON — aviso del mecanismo de instalación — decile a la persona: ${String(hs.state.notice).trim()}`,
      '   No lo apliques sin que te lo pida: la decisión es suya.',
    );
  }
  // La retención (story 8.13, tanda C, decisión 9 del dueño): `harness.js rollback` deja `hold` y desde ahí `update` no
  // avanza solo. El atraso es A PROPÓSITO —la persona deshizo esa versión—: gritar «ARNÉS ATRASADO» y dar el `merge`
  // para avanzar a mano sería empujar justo lo que se deshizo. En su lugar se dice la retención, dirigida a la persona:
  // qué versión se deshizo, desde cuándo y cómo volver a actualizar. Si el `notice` de `startup` ya trae el comando, no
  // se repite.
  const hold = hs.status === 'ok' && hs.state.hold && typeof hs.state.hold === 'object' ? hs.state.hold : null;
  if (hold && !/rollback --release/.test(String(hs.state.notice || ''))) {
    const since = typeof hold.at === 'string' && hold.at ? ` desde el ${hold.at.slice(0, 16).replace('T', ' ')} (UTC)` : '';
    harnessLines.push(
      `🔔 TYCON — retención del arnés — decile a la persona: se deshizo la versión ${hold.commit || '(sin número)'}${since}; el arnés no se actualiza solo mientras siga la retención.`,
      '   Para volver a actualizar: node ~/.claude/tycon-harness/scripts/setup/harness.js rollback --release (o update --yes). No lo hagas sin que te lo pida.',
    );
  }
  // ¿el atraso se grita? Sólo sin estado (lo de hoy), con estado roto, o en managed con apply: auto y sin retención
  const policy = hs.status === 'ok' ? updatePolicy(hs.state) : null;
  const shoutStale = hs.status !== 'ok' || (!hold && hs.state.mode === 'managed' && policy.enabled && policy.apply === 'auto');

  // El script vive en ~/.claude/tycon-harness/scripts/hooks/ → la raíz del repo es ../../
  const repos = [
    { name: 'el arnés', dir: path.resolve(__dirname, '..', '..') },   // el nombre que lee la persona (story 8.19, tanda E)
    { name: 'agent-skills', dir: path.join(os.homedir(), '.claude', 'agent-skills') },
  ];

  const offenders = [];
  const stale = [];
  const unreadable = []; // clones de los que algo no se pudo leer: se dice, y ese clon no se juzga
  const judged = new Map(); // identidad de la carpeta → cómo se nombra ese clon
  for (const { name, dir } of repos) {
    const head = gitTry(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    // repo no clonado / git ausente → no es problema de este hook. Una carpeta que SÍ es un clon y cuya rama git no pudo
    // decir (el HEAD o su rama rotos, el tope de tiempo) no es «no clonado»: sigue, y abajo se dice
    if (!head.ok && (head.noGit || !isClone(dir))) continue;
    // el mismo clon por dos caminos (el repo único: `~/.claude/agent-skills` es un enlace a este clon) se juzga una vez
    const id = folderId(dir).id;
    if (id && judged.has(id)) { judged.get(id).also.push(name); continue; }
    const label = { name, also: [] };
    if (id) judged.set(id, label);
    const unread = (what) => unreadable.push({ label, dir, what });
    if (!head.ok) { unread('en qué rama está parado'); continue; }
    const branch = head.out;
    if (!id) { unread('su carpeta'); continue; }
    // la rama donde vive ese clon: `main`; o, si el estado dice que su fuente se reescribe, `tycon/installed` — y `main`
    // sólo mientras esa rama no existe (no llegó su primera actualización): después, `update` no lo mueve desde `main`
    const found = hs.status === 'ok' ? rewrittenSource(hs.state, id) : { source: null, unread: false };
    if (found.unread) { unread('la carpeta de una fuente que nombra el estado del mecanismo de instalación (no sé si es este clon)'); continue; }
    const rewritten = found.source;
    const home = rewritten ? INSTALLED_BRANCH : 'main';
    let installed = false;
    if (rewritten && branch !== home) {
      // «no existe» sólo si git lo dice; una rama rota no es una rama que falta
      const st = refState(dir, `refs/heads/${INSTALLED_BRANCH}`);
      if (st === 'unreadable') { unread(`su rama "${INSTALLED_BRANCH}" (existe y no se deja leer)`); continue; }
      installed = st === 'present';
    }
    if (branch && branch !== home && !(rewritten && !installed && branch === 'main')) {
      offenders.push({ label, dir, branch, home, installed });
      continue;
    }
    // en developer, en ask, con TYCON_UPDATE=0 o con retención el atraso no se grita (lo dice `harness.js doctor`): no se mira
    if (!shoutStale) continue;
    const unmerged = unmergedFiles(dir);
    if (unmerged === null) { unread('si tiene conflictos abiertos (su índice)'); continue; }
    let stuck = false;
    if (unmerged.length > 0) {
      stuck = topStashIsAutostash(dir);
      if (stuck === null) { unread('su stash (tiene conflictos abiertos y no sé si los dejó el arranque)'); continue; }
    }
    // ¿Al día con lo publicado? Contra origin/main, o contra la ref que el estado dice que esa fuente sigue (la de su
    // canal). Sin esa ref en el clon (clon sin remoto, fixture) → no se juzga; con la ref ahí y sin poder contar, se dice.
    const upstream = rewritten && typeof rewritten.ref === 'string' && REF_SHAPE.test(rewritten.ref) ? `origin/${rewritten.ref}` : 'origin/main';
    let behind = 0;
    const count = gitTry(dir, ['rev-list', '--count', `HEAD..${upstream}`]);
    if (count.ok) behind = parseInt(count.out, 10) || 0;
    else if (refState(dir, `refs/remotes/${upstream}`) !== 'absent') { unread(`cuánto le falta contra ${upstream}`); continue; }
    if (behind > 0 || stuck) {
      let headDate = '';
      try { headDate = git(dir, ['log', '-1', '--format=%ad', '--date=short']); } catch { /* opcional */ }
      stale.push({ label, dir, behind, headDate, stuck, unmerged, collide: collidingFiles(dir, upstream), upstream, rewritten: Boolean(rewritten) });
    }
  }

  if (offenders.length === 0 && stale.length === 0 && unreadable.length === 0 && harnessLines.length === 0) process.exit(0);

  const out = [...harnessLines];
  // lo que no se pudo leer: una línea por clon, sin veredicto ni consejo de rama (no se aconseja a ciegas)
  for (const u of unreadable) {
    out.push(`🔔 TYCON — del clon ${shown(u.label)} (${u.dir}) no pude leer ${u.what}: no sé si está en su rama ni si está al día, y a ciegas no aconsejo nada. Decile a la persona en una línea; \`git -C ${sh(u.dir)} status\` muestra qué le pasa.`);
  }
  // Dos avisos, cada uno con SU vuelta: el de los clones que viven en `main` (el de siempre) y el de los que viven en
  // `tycon/installed`. Van separados para que ningún texto que manda a `main` quede debajo de un clon cuya fuente se
  // reescribe: desde `main` `update` no lo mueve, y ese consejo lo dejaba bloqueado (causa A).
  const offMain = offenders.filter((o) => o.home === 'main');
  const offInstalled = offenders.filter((o) => o.home !== 'main');
  if (offMain.length > 0) {
    out.push(
      '🔴🔴 BRANCH GUARD — repos compartidos del harness FUERA de main:',
      ...offMain.map((o) => `  - ${shown(o.label)} está en "${o.branch}" (${o.dir})`),
      'TODAS las sesiones leen guías/skills/hooks de lo que esté checkouteado — esta sesión',
      'está corriendo con un arnés a medio hacer. Si no sos la sesión que trabaja la',
      'migración: avisale al dev ANTES de confiar en cualquier guía o skill de ese repo.',
      'Si sos la sesión de la migración: acordate de volver a main al pausar o cerrar',
      '(regla del clon compartido, guides/codex-migration.md §5).',
      'Volver: git -C <repo> checkout main',
    );
  }
  if (offInstalled.length > 0) {
    out.push(
      '🔴🔴 BRANCH GUARD — repos compartidos del harness FUERA de su rama:',
      ...offInstalled.map((o) => `  - ${shown(o.label)} está en "${o.branch}" y no en "${o.home}" (${o.dir})`),
      'TODAS las sesiones leen guías/skills/hooks de lo que esté checkouteado ahí, y esta copia se',
      `actualiza desde "${INSTALLED_BRANCH}": parada en otra rama, la actualización puede no tocarla.`,
      'Decile a la persona en una línea; no cambies de rama sin que te lo pida.',
      // la vuelta que FUNCIONA en el estado real: a su rama si ya existe; si todavía no (no llegó su primera
      // actualización), un `checkout` de esa rama fallaría: la crea `update`
      ...offInstalled.map((o) => (o.installed
        ? `Volver: git -C ${sh(o.dir)} checkout ${o.home}`
        : `Volver: node ~/.claude/tycon-harness/scripts/setup/harness.js update   # "${o.home}" todavía no existe: la crea la primera actualización, o dice por qué no`)),
    );
  }
  if (stale.length > 0) {
    out.push('🔴 ARNÉS ATRASADO — copias locales del arnés detrás de lo publicado (origin/main) o trabadas:');
    for (const s of stale) {
      const trabas = [];
      if (s.stuck) trabas.push(`TRABADA: ${s.unmerged.map((u) => u.file).join(', ')} con conflicto abierto (el arranque guardó tus cambios aparte y no pudo reaplicarlos)`);
      if (s.collide.tracked.length) {
        const cap = s.collide.tracked.some((b) => b.endsWith('guide-update-proposals.md')) ? ' — guide-update-proposals.md lo escribió el capturador de retrospectivas, no vos' : '';
        trabas.push(`modificado en esta máquina: ${s.collide.tracked.join(', ')}${cap}`);
      }
      if (s.collide.untracked.length) trabas.push(`no trackeado acá y lo publicado lo agrega: ${s.collide.untracked.join(', ')}`);
      if (s.collide.unread) trabas.push('no pude mirar qué archivos la traban');
      const contra = s.upstream && s.upstream !== 'origin/main' ? ` de ${s.upstream}` : '';
      const estado = s.behind > 0 ? `${s.behind} commit(s) atrás${contra} (parada en el ${s.headDate || '?'})` : 'al día pero trabada';
      out.push(`  - ${shown(s.label)}: ${estado}${trabas.length ? ' · ' + trabas.join(' · ') : ''}`);
    }
    out.push(
      'El arranque intenta actualizarlas y no puede — sin error, porque el error se descarta a propósito.',
      'Esta sesión corre con guías, instalador y controles VIEJOS. Se repara sola al primer prompt',
      '(guides-heal del pipeline). Si este aviso vuelve en la próxima sesión, a mano:',
    );
    // una fuente que se reescribe no se arregla con un merge (su rama no desciende de la anterior): la mueve `update`
    for (const s of stale) {
      out.push(...(s.rewritten
        ? ['node ~/.claude/tycon-harness/scripts/setup/harness.js update   # dice por qué no avanza, o avanza']
        : manualAdvice(s.dir, s.stuck, s.unmerged, s.collide)).map((l) => `  ${l}`));
    }
    out.push('Avisale al dev en una línea.');
  }
  console.log(out.join('\n'));
  process.exit(0);
} catch {
  process.exit(0);
}
