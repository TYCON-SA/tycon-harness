#!/usr/bin/env node
'use strict';
/**
 * canonical-path.js — ¿el arnés está donde el resto del arnés cree que está? Y el enlace que lo dice.
 *
 * ── EL CASO (2026-09-05) ──────────────────────────────────────────────────────────────────────
 * Un dev con los proyectos fuera de la carpeta canónica de entonces preguntó si el arnés podía fallar por la ruta.
 * Al medirlo: la ruta del clon estaba ESCRITA en ~50 lugares —la línea de arranque, 15 procedimientos
 * de revisores que leen las guías de ahí, la ruta por defecto del pipeline, la lista de lo que los
 * revisores pueden leer bajo el banco—. Si el clon vive en otro lado NADA falla: los hooks se resuelven
 * solos desde donde está el script (por eso todo "anda"), pero los revisores no encuentran las guías
 * que su procedimiento les manda leer. Degrada en silencio, que es el modo de falla que este arnés
 * existe para cazar.
 *
 * ── EL ENLACE (story 8.3, 2026-09-26) ─────────────────────────────────────────────────────────
 * Un prompt no puede leer una variable, pero sí una ruta estable. Desde la 8.3 la forma de nombrar al
 * arnés en prosa es un enlace en `~/.claude/` (hoy el lugar `~/.claude/tycon-harness`; el mismo recurso que `~/.claude/agents`,
 * que es un enlace a agent-skills), y el clon puede vivir en cualquier carpeta. Este archivo lo cuida:
 *   · `asegurarEnlace()` lo crea si falta y lo repara si está colgado (o si apunta a algo que no es un
 *     clon del arnés). Si apunta a OTRO clon válido —existe y tiene `scripts/install-tycon-hooks.sh`—
 *     NO lo mueve: lo dice y nombra `--link <ruta>`, la única forma de re-apuntarlo. Razón: el equipo
 *     trabaja desde clones descartables; un enlace robado por un instalador corrido desde el scratchpad
 *     queda colgado al borrarlo, y este aviso dejaría de sonar justo ahí. Una carpeta real en ese lugar
 *     no se pisa nunca. Los dos instaladores lo llaman (`--ensure-link`, respeta `--check`).
 *   · `aviso()` compara el clon donde vive este archivo con el destino REAL del enlace y, si no
 *     coinciden —o el enlace falta, está colgado o es una carpeta—, lo DICE por stdout (el instalador
 *     lo llama en cada arranque). Nunca frena y sale 0 siempre: es un aviso, y un aviso que rompe el
 *     arranque se apaga. Callado si coinciden · hay `TYCON_GUIDES_DIR` (la salida explícita; cubre
 *     pipeline y scripts, NO a los revisores, que leen por el enlace) · `TYCON_NO_CANONICAL_PATH=1`.
 *
 * Windows: se crea un JUNCTION (`fs.symlinkSync(…, 'junction')`): un symlink de directorio pide modo
 * desarrollador o admin y el junction no. `install-tycon-hooks.ps1` lo llama igual que el `.sh`. En el
 * Mac del autor no hay `pwsh` ni Windows: ese camino está verificado sólo por lectura — probarlo en
 * una máquina Windows es deuda declarada (misma deuda que ya tenía este archivo).
 *
 * ── EL LUGAR Y EL NOMBRE VIEJO (story 8.19, 2026-10-04) ─────────────────────────────────────────────────────
 * El enlace se llamaba como el repo interno. Desde la 8.19 el LUGAR del arnés es `~/.claude/tycon-harness` (el nombre del
 * repo público; la constante vive en scripts/setup/harness/place.js) y el nombre viejo (el del repo interno, `LEGACY_PLACE_NAME`)
 * sigue resolviendo en las máquinas ya instaladas. `--ensure-link` aplica la REGLA DE NACIMIENTO (`ensurePlace`), bajo
 * un candado propio (`~/.claude/.tycon-pipeline/place.lock`) y siempre en el mismo orden, primero el lugar y después el
 * viejo:
 *   · una carpeta real que es un clon, en cualquiera de los dos nombres, nunca se re-apunta ni se borra;
 *   · el destino de nacimiento es, en orden: a donde resuelve el nombre viejo (si es un clon); el `tree` del estado del
 *     mecanismo (o `--prefer <dir>`); recién entonces el clon que corre. Un clon descartable que corre primero no se
 *     queda con el nombre mientras el viejo o el estado digan otra cosa (el riesgo S1 de la story);
 *   · el nombre viejo, si es un enlace, apunta AL LUGAR (no al clon): re-apuntar el lugar no lo deja atrás.
 * La matriz entera (siete estados por nombre) está en `ensurePlace`, con la tabla de la story al lado. `--link <ruta>`
 * re-apunta el lugar creando antes el enlace nuevo con un nombre temporal y cambiándolo recién después.
 *
 * Uso: node scripts/lib/canonical-path.js [--clone <ruta>] [--canonical <ruta>] [--home <ruta>]   → el aviso (o nada)
 *      node scripts/lib/canonical-path.js --ensure-link [--clone <dir>] [--check] [--link <ruta>] [--prefer <dir>] [--home <ruta>]
 *        (sale 0 siempre, salvo un --link que no se puede cumplir —no es un clon, o el lugar es una carpeta real—: 2)
 *      node scripts/lib/canonical-path.js --ensure-repo-links --clone <dir> [--home <dir>] [--check] [--only agent-skills|entries]
 *        (los enlaces del repo único, story 8.7: ver «LOS ENLACES DEL REPO ÚNICO» más abajo; sale 0 siempre, 2 sólo por uso)
 *      node scripts/lib/canonical-path.js --place-pieces [--home <dir>]
 *        (story 8.19: «link<TAB>ruta<TAB>id» por cada nombre del lugar que es un enlace; sale 0 siempre)
 *      node scripts/lib/canonical-path.js --separate-skills-clone [--clone <dir>] [--home <dir>]
 *        (story 8.18: la ruta del clon aparte de agent-skills si la máquina está en la transición, o nada; sale 0 siempre)
 *      node scripts/lib/canonical-path.js --selftest
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { readEnv, aliasArgv } = require('./legacy-names.js');

// El nombre del lugar del arnés (story 8.19) vive en scripts/setup/harness/place.js. Se carga la primera vez que se usa:
// muchas pruebas y guiones copian scripts/lib/ suelta a un árbol de juguete y sólo preguntan `isSingleRepo()` (lo hace
// skills-dir.js, la vecina): esa pregunta no necesita el nombre y no tiene por qué romperse sin scripts/setup/.
let placeModule = null;
const PLACE = () => placeModule || (placeModule = require('../setup/harness/place.js'));

const RAIZ = path.resolve(__dirname, '..', '..');

function real(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
function rutaEnlace(home) { return PLACE().placePath(home); }
/** «Clon válido del arnés» = existe y tiene el instalador (el criterio del AC 4). */
function esClonDelArnes(dir) { return !!dir && fs.existsSync(path.join(dir, 'scripts', 'install-tycon-hooks.sh')); }

/** @returns {{ruta:string, estado:'falta'|'colgado'|'enlace'|'carpeta'|'archivo', destino:string|null, destinoReal:string|null}} */
function estadoEnlace({ home, enlace } = {}) {
  const ruta = enlace || rutaEnlace(home);
  let st;
  try { st = fs.lstatSync(ruta); } catch (_) { return { ruta, estado: 'falta', destino: null, destinoReal: null }; }
  if (!st.isSymbolicLink()) return { ruta, estado: st.isDirectory() ? 'carpeta' : 'archivo', destino: null, destinoReal: null };
  let destino = null;
  try { destino = fs.readlinkSync(ruta); } catch (_) { destino = null; }
  const destinoReal = real(ruta);
  return { ruta, estado: destinoReal ? 'enlace' : 'colgado', destino, destinoReal };
}

function borrarEnlace(ruta) {
  try { fs.unlinkSync(ruta); return; } catch (_) { /* en Windows un junction se borra como carpeta */ }
  fs.rmdirSync(ruta);
}
function crearEnlace(destino, ruta) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.symlinkSync(destino, ruta, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Crea / repara / respeta el enlace. Nunca tira por el estado del disco: devuelve qué hizo (o qué haría,
 * con `check`) y un mensaje para la persona.
 * @returns {{accion:'created'|'repaired'|'unchanged'|'other-clone'|'real-folder'|'repointed'|'invalid'|'error', mensaje:string, ruta:string, destino:string|null, escribio:boolean}}
 * (los valores de `accion` estaban en castellano hasta la story 8.9, tanda E; no salen del proceso: el instalador lee
 * sólo el mensaje y el código de salida)
 */
function asegurarEnlace(opts = {}) {
  // el lugar del arnés (sin `enlace` ni `destino`): la regla de nacimiento de la 8.19. Los enlaces del repo único
  // siguen por `asegurarEnlaceInterno`, con su criterio de siempre
  if (!opts.enlace && !opts.destino) return ensurePlace(opts);
  try { return asegurarEnlaceInterno(opts); }
  catch (e) {
    // Un enlace que no se pudo crear/borrar (permisos, un `.claude` que es archivo, disco de sólo lectura) se DICE y
    // el instalador sigue registrando hooks: un aviso que rompe el arranque se apaga (pase adversarial, vuelta 1).
    const ruta = (opts.enlace || rutaEnlace(opts.home));
    return { accion: 'error', mensaje: `⚠️ tycon: no pude crear/reparar el enlace ${ruta} (${e && e.message}). Los revisores nombran al arnés por ese enlace: arreglalo a mano o volvé a correr el instalador`, ruta, destino: null, escribio: false };
  }
}
// `destino` y `esValido` (story 8.7, tanda C) son para los enlaces del repo único, que apuntan ADENTRO del clon y tienen
// cada uno su criterio de «válido»; sin ellos vale lo de siempre: el destino es el clon y válido es «clon del arnés».
function asegurarEnlaceInterno({ clon, home, enlace, check = false, forzar = null, destino = null, esValido = esClonDelArnes } = {}) {
  const c = destino ? (real(destino) || path.resolve(destino)) : (real(clon || RAIZ) || path.resolve(clon || RAIZ));
  const e = estadoEnlace({ home, enlace });
  const pref = check ? '(--check) ' : '';
  const res = (accion, mensaje, destino, escribio) => ({ accion, mensaje: `${pref}${mensaje}`, ruta: e.ruta, destino, escribio: !!escribio });

  if (forzar) {
    const f = real(forzar);
    if (!esClonDelArnes(f)) {
      return res('invalid', `✗ --link ${forzar}: no es un clon del arnés (no tiene scripts/install-tycon-hooks.sh); el enlace no se tocó`, e.destinoReal, false);
    }
    if (e.estado === 'carpeta' || e.estado === 'archivo') {
      return res('real-folder', `⚠️ tycon: en ${e.ruta} hay una carpeta real, no un enlace: no la piso (movela y volvé a correr el instalador)`, null, false);
    }
    if (e.estado === 'enlace' && e.destinoReal === f) return res('unchanged', `✓ tycon: el enlace ${e.ruta} ya apunta a ${f}`, f, false);
    if (!check) { if (e.estado !== 'falta') borrarEnlace(e.ruta); crearEnlace(f, e.ruta); }
    return res('repointed', `✓ tycon: enlace ${e.ruta} re-apuntado a ${f} (--link)${e.destinoReal ? ` — antes apuntaba a ${e.destinoReal}` : ''}`, f, !check);
  }

  switch (e.estado) {
    case 'falta':
      if (!check) crearEnlace(c, e.ruta);
      return res('created', `✓ tycon: enlace ${e.ruta} → ${c} (creado: los revisores y el pipeline nombran al arnés por ahí)`, c, !check);
    case 'colgado':
      if (!check) { borrarEnlace(e.ruta); crearEnlace(c, e.ruta); }
      return res('repaired', `✓ tycon: el enlace ${e.ruta} estaba colgado (→ ${e.destino}); reparado → ${c}`, c, !check);
    case 'carpeta':
    case 'archivo':
      return res('real-folder', `⚠️ tycon: en ${e.ruta} hay una carpeta real, no un enlace: no la piso. Los revisores nombran al arnés por ese enlace: movela y volvé a correr el instalador`, null, false);
    case 'enlace':
      if (e.destinoReal === c) return res('unchanged', `✓ tycon: enlace ${e.ruta} → ${c}`, c, false);
      if (esValido(e.destinoReal)) {
        return res('other-clone', `⚠️ tycon: el enlace ${e.ruta} apunta a OTRO clon del arnés (${e.destinoReal}) y este instalador corre desde ${c}. No lo muevo solo (un clon descartable se lo llevaría y quedaría colgado). Para re-apuntarlo acá: install-tycon-hooks.sh --link ${c}`, e.destinoReal, false);
      }
      if (!check) { borrarEnlace(e.ruta); crearEnlace(c, e.ruta); }
      return res('repaired', `✓ tycon: el enlace ${e.ruta} apuntaba a ${e.destinoReal}, que no es un clon del arnés; reparado → ${c}`, c, !check);
    default:
      return res('unchanged', `tycon: estado del enlace desconocido (${e.estado})`, null, false);
  }
}

// ── EL LUGAR Y LA REGLA DE NACIMIENTO (story 8.19, AC 5-8) ─────────────────────────────────────────────────────────
// Los siete estados de cada nombre: F falta · E enlace a un clon válido · C colgado (también un ciclo) · N enlace a algo
// que no es un clon · R carpeta real que es un clon · X carpeta real que no es un clon · A archivo. La matriz (filas: el
// lugar; columnas: el viejo) es la de «Cómo funciona» de la story; cada rama de abajo cita su celda.
// Hasta el merge de la tanda C una máquina que no tenía el nombre viejo lo recibía igual (V→L*): los textos que todavía lo
// nombraban tenían que encontrar algo. Desde la tanda C los textos nombran el lugar y las celdas V→L* pasan a «—»: una
// máquina nueva queda con un solo nombre (AC 30). El viejo que ya nació así (legacy-place-born.json) no se borra acá:
// borrar el nombre viejo es el retiro (story 8.15).
const LEGACY_FOR_NEW_MACHINES = false;
const PLACE_LOCK_STALE_MS = 2 * 60 * 1000;
const PLACE_LOCK_WAIT_MS = 5000;

/** El estado de un nombre (lugar o viejo). `direct`: el destino escrito, resuelto contra la carpeta del enlace. */
function nameState(ruta, isValid = esClonDelArnes) {
  let st;
  try { st = fs.lstatSync(ruta); } catch (_) { return { ruta, kind: 'F', direct: null, real: null }; }
  if (st.isSymbolicLink()) {
    let direct = null;
    // (una unión de Windows se lee con el prefijo `\\?\`: sin sacarlo, no se compara con la ruta que se le dio)
    try { direct = path.resolve(path.dirname(ruta), fs.readlinkSync(ruta).replace(/^\\\\\?\\/, '')); } catch (_) { direct = null; }
    const r = real(ruta);
    if (!r) return { ruta, kind: 'C', direct, real: null };
    return { ruta, kind: isValid(r) ? 'E' : 'N', direct, real: r };
  }
  if (st.isDirectory()) { const r = real(ruta) || ruta; return { ruta, kind: isValid(r) ? 'R' : 'X', direct: null, real: r }; }
  return { ruta, kind: 'A', direct: null, real: null };
}

/** La ruta tal cual si su último nombre es un enlace (la forma con enlaces de la 8.33); si no, null. */
function stableName(p) {
  if (!p) return null;
  try { return fs.lstatSync(p).isSymbolicLink() ? path.resolve(p) : null; } catch (_) { return null; }
}

/** El `tree` del estado del mecanismo, si lo hay (sin validar el resto del estado). */
function stateTree(home) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDirOf(home || os.homedir()), 'harness-state.json'), 'utf8'));
    return s && typeof s.tree === 'string' ? s.tree : null;
  } catch (_) { return null; }
}

/** Borra un NOMBRE (un enlace o un junction), nunca su contenido: `unlink` y, si no, `rmdir`. Jamás un borrado recursivo. */
function removeName(ruta) {
  try { fs.unlinkSync(ruta); return; } catch (_) { /* en Windows un junction se borra como carpeta */ }
  fs.rmdirSync(ruta);
}
function makeLink(target, ruta) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.symlinkSync(target, ruta, process.platform === 'win32' ? 'junction' : 'dir');
}
/**
 * Pone `ruta` apuntando a `target`. Si `ruta` ya existe (un enlace), crea antes el nuevo con un nombre temporal y lo cambia
 * recién después: si crear el temporal falla no se borró nada; si el cambio final falla, `ruta` se recrea hacia
 * `previous` y se dice (AC 8). En Windows renombrar sobre un junction existente no anda: se borra y se renombra.
 */
function pointName(target, ruta, previous = null) {
  let exists = true;
  try { fs.lstatSync(ruta); } catch (_) { exists = false; }
  if (!exists) { makeLink(target, ruta); return { swapped: false }; }
  const tmp = `${ruta}.tycon-new-${process.pid}`;
  try { removeName(tmp); } catch (_) { /* no había un temporal viejo */ }
  makeLink(target, tmp);   // si falla, tira acá: nada se borró
  try { fs.renameSync(tmp, ruta); return { swapped: true }; } catch (_) { /* Windows: rename sobre un junction */ }
  try { removeName(ruta); fs.renameSync(tmp, ruta); return { swapped: true }; } catch (e) {
    let restored = false;
    try { fs.lstatSync(ruta); } catch (_) { if (previous) { try { makeLink(previous, ruta); restored = true; } catch (_) { restored = false; } } }
    try { removeName(tmp); } catch (_) { /* nada */ }
    const err = new Error(`no pude cambiar ${ruta} por el enlace nuevo (${e && (e.code || e.message)})${restored ? `; quedó apuntando al destino anterior (${previous})` : ''}`);
    err.restored = restored;
    throw err;
  }
}

/** El candado del lugar, por `mkdir`: espera hasta 5 s; uno de más de 2 minutos se considera abandonado. */
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function takePlaceLock(home, { waitMs = PLACE_LOCK_WAIT_MS, staleMs = PLACE_LOCK_STALE_MS } = {}) {
  const dir = path.join(stateDirOf(home || os.homedir()), 'place.lock');
  try { fs.mkdirSync(path.dirname(dir), { recursive: true }); } catch (e) { return { ok: false, error: true, reason: e.message }; }
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(dir); return { ok: true, dir }; } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, error: true, reason: e.message };
      let age = 0;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch (_) { continue; }
      if (age > staleMs) { try { fs.rmdirSync(dir); } catch (_) { /* otro lo tomó */ } continue; }
      if (Date.now() >= until) return { ok: false, reason: 'otro proceso está creando el lugar (place.lock tomado)' };
      sleepMs(100);
    }
  }
}
function releasePlaceLock(l) { if (l && l.ok) { try { fs.rmdirSync(l.dir); } catch (_) { /* nada */ } } }

const KIND_WORD = { X: 'una carpeta real que no es un clon del arnés', A: 'un archivo', R: 'una carpeta real (un clon)' };

/**
 * Decide qué hace la regla de nacimiento (sin escribir). Devuelve el plan: `place` (destino nuevo del lugar o null),
 * `legacy` (true: el viejo pasa a apuntar al lugar), los mensajes y la acción para quien llama.
 */
function placePlan({ clon, home, forzar = null, prefer = null, isValid = esClonDelArnes } = {}) {
  const c = real(clon || RAIZ) || path.resolve(clon || RAIZ);
  const P = nameState(PLACE().placePath(home), isValid);
  const V = nameState(PLACE().legacyPlacePath(home), isValid);
  const same = (a, b) => PLACE().samePath(a, b);
  const legacyAtPlace = V.direct && same(V.direct, P.ruta);
  const plan = { P, V, c, place: null, previous: P.kind === 'E' || P.kind === 'N' ? P.real : null, legacy: false, accion: 'unchanged', lines: [], conflict: false };
  const say = (l) => plan.lines.push(l);
  // el viejo: V→L (enlace a reparar o re-apuntar), V→L* (falta: sólo hasta la tanda C), dato (carpeta ajena o archivo)
  const legacyFollows = () => {
    if (V.kind === 'F') { if (LEGACY_FOR_NEW_MACHINES) plan.legacy = true; return; }
    if (V.kind === 'C' || V.kind === 'N') { plan.legacy = true; return; }
    if (V.kind === 'E' && !legacyAtPlace) { plan.legacy = true; return; }
    if (V.kind === 'X' || V.kind === 'A') say(`ℹ tycon: en ${V.ruta} (el nombre viejo) hay ${KIND_WORD[V.kind]}: no lo toco`);
  };

  if (forzar) {
    const f = real(forzar);
    if (!isValid(f)) { plan.accion = 'invalid'; say(`✗ --link ${forzar}: no es un clon del arnés (no tiene scripts/install-tycon-hooks.sh); el lugar no se tocó`); return plan; }
    if (P.kind === 'R') { plan.accion = 'refused'; say(`✗ tycon: el lugar ${P.ruta} es una carpeta real (tu clon): no lo re-apunto; cloná en otra carpeta para usar el modo desarrollador`); return plan; }
    if (P.kind === 'X' || P.kind === 'A') { plan.accion = 'refused'; say(`✗ tycon: en ${P.ruta} hay ${KIND_WORD[P.kind]}, no un enlace: no lo piso (movelo y volvé a correrlo)`); return plan; }
    // la forma con enlaces (story 8.33): si lo que se pide es un ENLACE (`~/.tycon/harness`, una unión en Windows), el lugar
    // apunta a ese nombre, nunca a la carpeta numerada a la que lleva hoy: con la ruta real, la versión siguiente lo dejaría
    // apuntando a la vieja
    const stable = stableName(forzar);
    if (!(P.kind === 'E' && same(P.real, f) && (!stable || (P.direct && same(P.direct, stable))))) { plan.place = stable || f; plan.accion = 'repointed'; }
    if (V.kind === 'R' && !same(V.real, f)) say(`ℹ tycon: el nombre viejo ${V.ruta} es una carpeta real (otro clon, ${V.real}): no lo toco`);
    else legacyFollows();
    return plan;
  }

  if (P.kind === 'X' || P.kind === 'A') {   // aviso-lugar: nada se toca, se avisa en cada arranque
    plan.accion = 'real-folder';
    say(`⚠️ tycon: en ${P.ruta} hay ${KIND_WORD[P.kind]}, no un enlace: no lo piso. Los revisores nombran al arnés por ese lugar: movelo y volvé a correr el instalador`);
    return plan;
  }
  if (P.kind === 'F' || P.kind === 'C' || P.kind === 'N') {
    if (V.kind === 'R') { plan.place = V.real; plan.accion = 'created'; return plan; }                     // L→R
    if (V.kind === 'E') { plan.place = V.real; plan.accion = 'created'; legacyFollows(); return plan; }   // L→K · V→L
    // L→D: el viejo no da un clon; el estado (o --prefer) antes que el clon que corre
    const pref = real(prefer || stateTree(home));
    plan.place = pref && isValid(pref) ? (stableName(prefer || stateTree(home)) || pref) : c;
    plan.accion = P.kind === 'F' ? 'created' : 'repaired';
    legacyFollows();
    return plan;
  }
  // el lugar ya resuelve a un clon: P.kind es E (→ P.real) o R (la carpeta misma)
  const here = P.real;
  if (V.kind === 'E' && !legacyAtPlace && !same(V.real, here)) plan.conflict = true;
  else if (V.kind === 'R' && (P.kind === 'R' || !same(V.real, here))) plan.conflict = true;
  if (plan.conflict) {
    plan.accion = 'conflict';
    say(`⚠️ tycon: el lugar ${P.ruta} (→ ${here}) y el nombre viejo ${V.ruta} (→ ${V.real}) son clones distintos: no muevo ninguno. Elegí uno: install-tycon-hooks.sh --link <ruta>`);
    return plan;
  }
  if (V.kind !== 'R') legacyFollows();
  if (!same(here, c)) {
    plan.accion = 'other-clone';
    say(P.kind === 'R'
      ? `ℹ tycon: el lugar ${P.ruta} es tu clon y este instalador corre desde ${c}: no lo toco`
      : `⚠️ tycon: el lugar ${P.ruta} apunta a OTRO clon del arnés (${here}) y este instalador corre desde ${c}. No lo muevo solo (un clon descartable se lo llevaría y quedaría colgado). Para re-apuntarlo acá: install-tycon-hooks.sh --link ${c}`);
  }
  return plan;
}

/** Los nombres del lugar que son enlaces (las piezas `link` que anotan los aplicadores): ids PLACE_NAME y LEGACY_PLACE_NAME. */
function placePieces({ home } = {}) {
  const out = [];
  for (const [where, id] of [[PLACE().placePath(home), PLACE().PLACE_NAME], [PLACE().legacyPlacePath(home), PLACE().LEGACY_PLACE_NAME]]) {
    try { if (fs.lstatSync(where).isSymbolicLink()) out.push({ where, id }); } catch (_) { /* no está */ }
  }
  return out;
}

/**
 * La regla de nacimiento del lugar y del nombre viejo. Nunca tira por el estado del disco: devuelve qué hizo (o qué
 * haría, con `check`), las líneas para la persona y el orden en que escribió.
 * @returns {{accion:string, mensaje:string, ruta:string, destino:string|null, escribio:boolean, writes:string[]}}
 */
function ensurePlace({ clon, home, check = false, forzar = null, prefer = null, isValid = esClonDelArnes } = {}) {
  const pref = check ? '(--check) ' : '';
  const placeRuta = PLACE().placePath(home);
  let current = null;   // el plan con el que se contesta: de él sale lo que le pasa al nombre viejo (el plan del instalador)
  const legacyOf = () => {
    if (!current || !current.V) return null;
    const V = current.V;
    const action = current.legacy ? (V.kind === 'F' ? 'add' : 'update') : (['E', 'C', 'N'].includes(V.kind) ? 'keep' : null);
    return { ruta: V.ruta, action };
  };
  const out = (accion, lines, destino, writes = []) => ({ accion, mensaje: lines.map((l) => `${pref}${l}`).join('\n'), ruta: placeRuta, destino, escribio: writes.length > 0, writes, legacy: legacyOf() });
  const planOf = () => placePlan({ clon, home, forzar, prefer, isValid });
  let plan;
  try { plan = current = planOf(); }
  catch (e) { return out('error', [`⚠️ tycon: no pude mirar el lugar ${placeRuta} (${e && e.message}); el nombre viejo sigue como estaba`], null); }
  // lo que no escribe (nada que hacer, conflicto, --check) se contesta sin el candado
  const quiet = (p) => p.accion === 'invalid' || p.accion === 'refused' || p.accion === 'conflict' || p.accion === 'real-folder' || (!p.place && !p.legacy);
  if (!quiet(plan) && !check) {
    // El plan se vuelve a calcular CON el candado tomado (segunda vuelta, C1): mientras éste esperaba, otro instalador
    // pudo crear el lugar; con el plan de antes, un clon descartable que esperaba el turno se quedaba con el nombre.
    const lock = takePlaceLock(home);
    if (!lock.ok && lock.error) return out('error', [`⚠️ tycon: no pude crear/reparar el lugar ${placeRuta} (${lock.reason}). El nombre viejo quedó como estaba; los revisores nombran al arnés por el lugar: arreglalo a mano o volvé a correr el instalador`], plan.previous);
    if (!lock.ok) return out('busy', [`⚠️ tycon: no escribo el lugar ahora: ${lock.reason}`], plan.P.real);
    try {
      try { plan = current = planOf(); }
      catch (e) { current = null; return out('error', [`⚠️ tycon: no pude mirar el lugar ${placeRuta} (${e && e.message}); el nombre viejo sigue como estaba`], null); }
      if (quiet(plan)) return finish(plan, null);
      return write(plan);
    } finally { releasePlaceLock(lock); }
  }
  return finish(plan, null);

  function describe(p, written) {
    const L = [];
    const did = (x) => written === null || written.includes(x);
    if (p.place && did(placeRuta)) {
      if (p.accion === 'repointed') L.push(`✓ tycon: lugar ${placeRuta} re-apuntado a ${p.place} (--link)${p.previous ? ` — antes apuntaba a ${p.previous}` : ''}`);
      else if (p.P.kind === 'F') L.push(`✓ tycon: lugar ${placeRuta} → ${p.place} (creado: los revisores y el pipeline nombran al arnés por ahí)`);
      else L.push(`✓ tycon: el lugar ${placeRuta} estaba ${p.P.kind === 'C' ? `colgado (→ ${p.P.direct})` : `apuntando a algo que no es un clon (${p.P.real})`}; reparado → ${p.place}`);
    }
    if (p.legacy && did(p.V.ruta)) L.push(`✓ tycon: el nombre viejo ${p.V.ruta} → ${placeRuta} (${p.V.kind === 'F' ? 'creado' : 're-apuntado al lugar'}: sigue andando para lo que todavía lo nombra)`);
    return L;
  }
  /** La respuesta sin escribir: lo que no se toca, lo que ya está, o lo que haría (--check). */
  function finish(p) {
    const lines = [...p.lines];
    const target = p.place || (p.P.real || null);
    if (p.accion === 'invalid' || p.accion === 'refused' || p.accion === 'conflict' || p.accion === 'real-folder') return out(p.accion, lines, p.P.real);
    if (!p.place && !p.legacy) {
      if (!lines.length) lines.push(`✓ tycon: lugar ${placeRuta} → ${target}`);
      return out(p.accion, lines, target);
    }
    return out(p.accion, [...describe(p, null), ...lines], target);
  }
  /** Escribe el plan (con el candado tomado): primero el lugar, después el viejo. */
  function write(p) {
    const lines = [...p.lines];
    const target = p.place || (p.P.real || null);
    const writes = [];
    if (p.place) {
      try { pointName(p.place, placeRuta, p.previous); writes.push(placeRuta); }
      catch (e) { return out('error', [`⚠️ tycon: no pude crear/reparar el lugar ${placeRuta} (${e && e.message}). El nombre viejo quedó como estaba; los revisores nombran al arnés por el lugar: arreglalo a mano o volvé a correr el instalador`], p.previous, writes); }
    }
    if (p.legacy) {
      try {
        pointName(placeRuta, p.V.ruta, p.V.direct); writes.push(p.V.ruta);
        if (p.V.kind === 'F') noteLegacyBorn(home, p.V.ruta);
      } catch (e) { lines.push(`⚠️ tycon: no pude apuntar el nombre viejo ${p.V.ruta} al lugar (${e && e.message})`); }
    }
    return out(p.accion, [...describe(p, writes), ...lines], p.place || target, writes);
  }
}

/**
 * El nombre viejo que nació en ESTA máquina por la regla de máquina nueva (V→L*, segunda vuelta C3): queda anotado en
 * ~/.claude/.tycon-pipeline/legacy-place-born.json para que el retiro (story 8.15) lo quite ahí, y sólo ahí; desde la tanda C
 * ya no nace (LEGACY_FOR_NEW_MACHINES en false). El viejo de una máquina
 * que ya lo tenía no se anota: sigue siendo de lo que la persona tiene escrito. Anotar nunca frena.
 */
function noteLegacyBorn(home, legacyRuta) {
  try {
    const dir = path.join(stateDirOf(home || os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'legacy-place-born.json'), JSON.stringify({ path: legacyRuta, rule: 'new-machine', at: new Date().toISOString() }, null, 2) + '\n');
  } catch (_) { /* la anotación nunca frena el arranque */ }
}

/**
 * Lo que la `accion` de un enlace es en el plan del instalador (story 8.16, AC 11): crearlo es `add`, repararlo o
 * re-apuntarlo es `update`, dejarlo como está (también el que apunta a otro clon y no se mueve) es `keep`. Una carpeta
 * real o un `--link` inválido no son del arnés: no van al plan (null).
 */
function planAction(accion) {
  return { created: 'add', repaired: 'update', repointed: 'update', unchanged: 'keep', 'other-clone': 'keep' }[accion] || null;
}
/** Anota las piezas del plan en el temporal del instalador (`TYCON_PLAN_PIECES`), con la forma de su reporte. */
function appendPlan(file, entries) {
  if (!file || !entries.length) return;
  try { fs.appendFileSync(file, entries.map((p) => `link\t${p.where}\t${p.id}\t${p.action}\n`).join('')); }
  catch (e) { process.stderr.write(`⚠ tycon: no pude anotar los enlaces en el plan del instalador (${e && e.message})\n`); }
}

// ── LOS ENLACES DEL REPO ÚNICO (story 8.7, tanda C · AC 18) ────────────────────────────────────────
// En el repo público el clon trae el arnés Y agent-skills juntos (skills/ y agents/ en su raíz). Todo lo que busca a
// agent-skills —19 lectores de TYCON_SKILLS_DIR, rutas fijas del código y los prompts, que nombran ~/.claude/agent-skills—
// tiene que encontrarlo sin ninguna variable puesta: tres enlaces más, con las reglas de `asegurarEnlace()`.
//   · ~/.claude/agent-skills → el clon · ~/.claude/agents → <clon>/agents · ~/.claude/skills → <clon>/skills.
//   · «Válido» es por enlace (decisión C12): si ya apunta a otro lado que sirve, NO se mueve y se dice —así un clon de
//     repo único corrido en una máquina del equipo no le roba sus enlaces—.
//   · Si ~/.claude/skills o ~/.claude/agents ya son carpetas reales (quien usa Claude Code con algo propio) —o un enlace
//     a una carpeta propia, que es lo mismo visto desde Claude— no se pisan ni se mueven:
//     adentro va un enlace por entrada del clon. Una entrada ajena con el mismo nombre no se toca y se nombra; en cada
//     corrida se agregan las nuevas y se sacan los enlaces SUYOS que quedaron colgados (su destino escrito cae bajo
//     <clon>/skills/ o <clon>/agents/ y ya no existe), y los enlaces duros que anotó cuya entrada ya no está en el clon
//     (story 8.17, W4). Un colgado ajeno no se toca, ni un archivo propio con el nombre de uno de esos duros.
//   · El clon del equipo (sin skills/ en la raíz) no aplica: no se imprime ni se toca nada.
// Windows: el enlace a una carpeta es un junction; el enlace por entrada a un ARCHIVO (cada revisor es un `.md`) prueba
// primero el enlace de archivo, que pide modo desarrollador; si Windows lo niega, un enlace duro; si tampoco, se dice y no
// se escribe (decisión C18; story 8.17, AC 39 — ver linkOne más abajo). Medido con un creador de enlaces inyectado (T51);
// en un Windows de verdad lo mide el paso `scenarios` del pipeline de Windows (T55).
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
const isRealDir = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch (_) { return false; } };   // un enlace no cuenta
// ¿`d` es la carpeta `sub` (agents o skills) de OTRO árbol del arnés? Lo es si se llama así y al lado tiene
// skills/tycon-pipeline como carpeta REAL. Un enlace no cuenta: la carpeta propia de alguien, una vez que este instalador
// le dejó adentro su enlace por entrada `tycon-pipeline`, no pasa a ser «otro clon».
const isOtherTree = (sub) => (d) => path.basename(d) === sub && isRealDir(path.join(path.dirname(d), 'skills', 'tycon-pipeline'));
const REPO_LINKS = [
  { id: 'agent-skills', sub: '', entries: false, valid: (d) => fs.existsSync(path.join(d, 'skills', 'tycon-pipeline')) },
  { id: 'agents', sub: 'agents', entries: true, valid: isOtherTree('agents') },
  { id: 'skills', sub: 'skills', entries: true, valid: isOtherTree('skills') },
];
/** ¿El clon es el repo único? (trae skills/tycon-pipeline y agents/ en su raíz) */
function isSingleRepo(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'skills', 'tycon-pipeline')) && isDir(path.join(dir, 'agents'));
}

// ── LA MÁQUINA DEL EQUIPO EN LA TRANSICIÓN (story 8.18, AC 28 · 2026-10-04) ────────────────────────────────────────
// El caso: los dos repos internos se unieron en uno. Desde ese día el clon del arnés de CADA máquina del equipo trae
// skills/ y agents/ en su raíz —o sea, `isSingleRepo()` da sí—, pero la máquina sigue como estaba: su clon viejo de
// agent-skills es una carpeta real en ~/.claude/agent-skills, y ~/.claude/skills y ~/.claude/agents son enlaces a su
// interior. Medido sobre la base (2026-10-04): con las reglas de arriba el instalador decía tres líneas en CADA arranque
// de CADA máquina, también con --check —«hay una carpeta real, no un enlace: no la piso» y dos «apunta a otro lado que
// sirve… no lo muevo»—. No hay nada que arreglar ahí: es el estado esperado hasta que la llave `update.skills_source`
// re-apunte ese clon. Un aviso que suena siempre y no pide nada es ruido, y el ruido tapa al aviso que sí importa.
//
// `separateSkillsClone()` reconoce ESE estado, y nada más: este clon es unido, y ~/.claude/agent-skills es OTRO clon de
// git que sirve como agent-skills (trae skills/tycon-pipeline y agents/). Vale la carpeta real (la máquina del equipo) y
// el enlace a un clon viejo que vive en otra carpeta; NO vale un enlace a otro árbol entero del arnés (un clon
// descartable corrido en esta máquina: eso se sigue diciendo), ni una carpeta que no es un clon de git, ni una que no
// trae las skills. Callar vale sólo para el estado conocido.
// En ese estado `ensureRepoLinks()` no aplica: no imprime, no mueve y no anota piezas, igual que antes de la unión. Y
// NUNCA apunta nada a este clon, ni siquiera un enlace que falta: si `main` volviera a un commit de antes de la unión,
// ese enlace quedaría colgado. Quién lo dice: `harness.js doctor`, una vez, como dato.
// `isSingleRepo()` no cambia (contrato C4 de la 8.18: la importan el exportador y la CI con ese criterio).
/**
 * @returns {string|null} la ruta real del clon aparte de agent-skills del que esta máquina lee las skills, o null si
 *   este clon no es unido o la máquina no está en ese estado
 */
function separateSkillsClone({ clone, home } = {}) {
  const given = path.resolve(clone || RAIZ);
  const c = real(given) || given;
  if (!isSingleRepo(c)) return null;
  const e = estadoEnlace({ enlace: path.join(home || os.homedir(), '.claude', 'agent-skills') });
  let dir = null;
  if (e.estado === 'carpeta') dir = real(e.ruta);
  else if (e.estado === 'enlace' && !esClonDelArnes(e.destinoReal)) dir = e.destinoReal;
  if (!dir || dir === c) return null;
  if (!isSingleRepo(dir)) return null;                        // no trae skills/tycon-pipeline y agents/: no es un agent-skills
  if (!fs.existsSync(path.join(dir, '.git'))) return null;    // una carpeta suelta, no un clon
  return dir;
}

// ── LAS SKILLS DE LA CUENTA EN EL CLON VIEJO (2026-10-05) ─────────────────────────────────────────────────────────────
// Claude Code baja las skills de la cuenta a ~/.claude/skills/synced/. En la transición, ~/.claude/skills es un enlace
// al interior del clon viejo de agent-skills, y ese repo no ignora `skills/synced/` (el unido sí, en su .gitignore desde
// el commit c86f2f39): medido en Windows el 2026-10-04, 229 archivos sueltos adentro del clon viejo, que un `git add -A`
// stagearía. Ese repo no se toca; lo que se escribe es su `.git/info/exclude`, que es LOCAL de esa máquina y no se
// versiona: una línea que sólo agrega «ignorar», no borra ni mueve nada.
//   · si `skills/synced/` ya está ignorado —por esa línea, por un .gitignore del repo o por el global— no se toca nada;
//   · con --check dice qué haría y no escribe;
//   · si git no contesta (no está, la carpeta no es un repo de verdad, se colgó) CALLA y no escribe: no es un freno,
//     es una comodidad. Lo peor que pasa es lo de antes —los archivos quedan sueltos— y el freno del `git add -A` en
//     ese árbol (GIT-C4 del safety-guard) sigue frenando.
const SYNCED_SKILLS = 'skills/synced/';
/**
 * @returns {{action:'already'|'would-add'|'added'|'unknown', file?:string, why?:string}}
 */
function ignoreSyncedSkills({ dir, check = false, git = 'git' } = {}) {
  const { spawnSync } = require('child_process');
  const run = (args) => spawnSync(git, ['-C', dir, ...args], { encoding: 'utf8', timeout: 10000 });
  // la raíz del repo tiene que ser ESA carpeta: si no es un repo de verdad (un `.git` vacío), git sigue subiendo y
  // contestaría por el repo de una carpeta madre, y el exclude se escribiría en otro lado
  const top = run(['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || real(top.stdout.trim()) !== real(dir)) return { action: 'unknown', why: 'no es la raíz de un repo de git' };
  // `--no-index`: la pregunta es por el patrón, aunque algo de ahí estuviera en el índice. 0 = ignorado · 1 = no · otro = no sé
  const asked = run(['check-ignore', '-q', '--no-index', `${SYNCED_SKILLS}x`]);
  if (asked.status === 0) return { action: 'already' };
  if (asked.status !== 1) return { action: 'unknown', why: (asked.error && asked.error.code) || `check-ignore salió ${asked.status}` };
  // dónde vive el exclude de ESE repo (si es un worktree, `.git` es un archivo y el exclude está en el repo común)
  const where = run(['rev-parse', '--git-path', 'info/exclude']);
  if (where.status !== 0 || !where.stdout.trim()) return { action: 'unknown', why: 'rev-parse --git-path no contestó' };
  const file = path.resolve(dir, where.stdout.trim());
  let body = '';
  try { body = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return { action: 'unknown', why: e.code || e.message }; }
  if (body.split(/\r?\n/).some((l) => l.trim() === SYNCED_SKILLS)) return { action: 'already', file };
  if (check) return { action: 'would-add', file };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sep = body && !body.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${sep}# tycon: las skills de la cuenta de Claude (Claude Code las baja a ~/.claude/skills/synced/)\n${SYNCED_SKILLS}\n`);
  } catch (e) { return { action: 'unknown', why: e.code || e.message }; }
  return { action: 'added', file };
}

// ── EL ENLACE DE UN ARCHIVO (story 8.17, W4 · AC 39; decisión C18 de la 8.7) ────────────────────────────────────────
// Una carpeta se enlaza con un junction en Windows (no pide permisos). Un ARCHIVO (cada revisor es un `.md`) no admite
// junction: se prueba primero el enlace de archivo, que en Windows pide el «modo desarrollador»; si lo niega, un enlace
// duro (mismo archivo en el mismo disco, no pide permisos); si tampoco, se dice («no pude enlazar») y no se escribe nada.
// El enlace duro se reconoce en la corrida siguiente por ser el mismo archivo (dispositivo e inodo), no por su nombre.
// Si git reemplaza el archivo del clon (un pull que lo cambia), el duro queda con el contenido viejo y deja de ser el mismo
// archivo: como está anotado (ver «LOS ENLACES DUROS QUE CREÓ EL ARNÉS»), la corrida siguiente lo rehace, no lo nombra
// como entrada que choca.
// `links` se inyecta en las pruebas (T51 de canonical-path.test.sh): en Linux y Mac el enlace de archivo no falla nunca.
const DEFAULT_LINKS = { symlink: (t, w, type) => fs.symlinkSync(t, w, type), link: (t, w) => fs.linkSync(t, w), platform: process.platform };
// `{ bigint: true }`: en Windows el ID de archivo de NTFS pasa de 2^53 y como Number pierde los bits bajos: dos archivos
// distintos darían el mismo `ino` (pase adversarial, clase 6; T51c). Igual que apply-hooks.js.
const sameFile = (a, b) => {
  try {
    const x = fs.lstatSync(a, { bigint: true }); const y = fs.statSync(b, { bigint: true });
    return !x.isSymbolicLink() && x.isFile() && x.ino === y.ino && x.dev === y.dev;
  } catch (_) { return false; }
};

// ── LOS ENLACES DUROS QUE CREÓ EL ARNÉS (story 8.17, W4 · pase adversarial, clases 2, 3, 9 y 14) ───────────────────
// Un enlace duro es un archivo común: cuando el revisor se borra del clon no queda «colgado», así que ni la limpieza de
// linkEntries ni el desinstalador lo reconocían como del arnés, y la copia quedaba en ~/.claude/agents para siempre, sin
// aviso. Desde acá se anota cada duro que se crea en ~/.claude/.tycon-pipeline/hard-links.json: la ruta, el archivo del
// clon al que se enlazó y su identidad (dispositivo, inodo, fecha de modificación y tamaño, en bigint). Una entrada
// anotada es del arnés MIENTRAS el archivo siga siendo ése: si la persona lo reemplazó por uno suyo con el mismo nombre,
// la identidad no coincide y no se toca. La fecha de modificación cuida el inodo reusado (el sistema puede darle el mismo
// número a un archivo nuevo una vez borrados los dos nombres del viejo).
// Límite declarado: si alguien edita el revisor EN EL LUGAR (mismo archivo, otra fecha) y además lo borra del clon antes de
// la corrida siguiente, la identidad ya no coincide y el duro queda: se prefiere dejar un archivo de más a borrar uno ajeno.
// Si el registro está ilegible no se escribe ni se limpia por él (se dice en una línea).
const hardLinksFile = (home) => path.join(stateDirOf(home || os.homedir()), 'hard-links.json');
const fileId = (p) => {
  try {
    const s = fs.lstatSync(p, { bigint: true });
    if (s.isSymbolicLink() || !s.isFile()) return null;
    return { dev: String(s.dev), ino: String(s.ino), mtime: String(s.mtimeNs), size: String(s.size) };
  } catch (_) { return null; }
};
const sameId = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.mtime === b.mtime && a.size === b.size;
// la ruta comparable: la carpeta resuelta (/var y /private/var son la misma) y el nombre tal cual
const linkKey = (p) => { const d = path.dirname(path.resolve(p)); return path.join(real(d) || d, path.basename(p)); };
const under = (p, roots) => roots.some((r) => p === r || p.startsWith(r + path.sep));
/** @returns {{links:{where:string,target:string,id:object}[], broken:string|null}} */
function readHardLinks(home) {
  let raw;
  try { raw = fs.readFileSync(hardLinksFile(home), 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? { links: [], broken: null } : { links: [], broken: (e && (e.code || e.message)) || 'error' }; }
  try {
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.links)) return { links: d.links.filter((x) => x && typeof x.where === 'string' && typeof x.target === 'string' && x.id), broken: null };
  } catch (_) { /* cae abajo */ }
  return { links: [], broken: 'ilegible' };
}
function writeHardLinks(home, links) {
  const file = hardLinksFile(home);
  if (!links.length) { try { fs.unlinkSync(file); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; } return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 1, links }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
/**
 * ¿`where` es un enlace duro que creó el arnés y sigue siendo ése? Con `tree`, además, sólo si se enlazó a un archivo de
 * ese árbol. Lo usa el desinstalador: un archivo real con ese nombre que no está anotado (o que ya no es el anotado) es
 * de la persona.
 */
function ownHardLink({ where, home, tree = null } = {}) {
  if (!where) return false;
  const rec = readHardLinks(home).links.find((x) => x.where === linkKey(where));
  if (!rec || !sameId(rec.id, fileId(where))) return false;
  if (tree && !under(rec.target, [path.resolve(tree), real(tree)].filter(Boolean))) return false;
  return true;
}
/** Lo saca del registro (el desinstalador, después de borrarlo). @returns {boolean} false si el registro está ilegible */
function forgetHardLink({ where, home } = {}) {
  const reg = readHardLinks(home);
  if (reg.broken) return false;
  const left = reg.links.filter((x) => x.where !== linkKey(where));
  if (left.length !== reg.links.length) writeHardLinks(home, left);
  return true;
}
/** @returns {{kind:'symlink'|'junction'|'dir'|'hard'}} o tira con `fileWhy`/`hardWhy` si un archivo no se pudo enlazar */
function linkOne(target, where, links) {
  const L = Object.assign({}, DEFAULT_LINKS, links || {});
  if (isDir(target)) {
    const type = L.platform === 'win32' ? 'junction' : 'dir';
    L.symlink(target, where, type);
    return { kind: type };
  }
  let fileWhy;
  try { L.symlink(target, where, 'file'); return { kind: 'symlink' }; } catch (e) { fileWhy = (e && (e.code || e.message)) || 'error'; }
  try { L.link(target, where); return { kind: 'hard' }; } catch (e) {
    const err = new Error('no pude enlazar');
    err.unlinked = true; err.fileWhy = fileWhy; err.hardWhy = (e && (e.code || e.message)) || 'error';
    throw err;
  }
}

/** Un enlace por entrada de `src` dentro de la carpeta real `dir`. Nunca pisa lo que no es suyo. */
function linkEntries({ dir, src, written, id, check, links, home }) {
  // `toAdd`/`toRemove`: los nombres que agregaría o sacaría (el plan del instalador, story 8.16 · AC 11)
  // `hard`: los que quedaron como enlace duro · `unlinked`: archivos que no se pudieron enlazar de ninguna forma
  // `registry`: por qué no se pudo leer el registro de enlaces duros (null si se leyó)
  const out = { added: 0, removed: 0, clashes: [], failed: [], inPlace: [], toAdd: [], toRemove: [], hard: [], unlinked: [], registry: null };
  // los enlaces duros que creó el arnés (ver «LOS ENLACES DUROS QUE CREÓ EL ARNÉS»)
  const reg = readHardLinks(home); let dirty = false;
  out.registry = reg.broken;
  const recOf = (where) => reg.links.find((x) => x.where === linkKey(where));
  const ours = (where) => { const r = recOf(where); return !!r && sameId(r.id, fileId(where)); };
  const drop = (where) => { const k = linkKey(where); const n = reg.links.length; reg.links = reg.links.filter((x) => x.where !== k); if (reg.links.length !== n) dirty = true; };
  const record = (where, target) => {
    const idNow = fileId(where); const r = recOf(where);
    if (!idNow || (r && sameId(r.id, idNow))) return;
    drop(where); reg.links.push({ where: linkKey(where), target: real(target) || path.resolve(target), id: idNow }); dirty = true;
  };
  let names = [];
  try { names = fs.readdirSync(src).filter((n) => !n.startsWith('.')).sort(); } catch (_) { names = []; }
  for (const name of names) {
    const where = path.join(dir, name); const target = path.join(src, name);
    // una entrada del clon que es ella misma un enlace colgado no se enlaza: el enlace nacería colgado, el barrido de
    // abajo lo sacaría en esta misma corrida y la línea «1 agregado y 1 sacado» saldría en todas
    if (!fs.existsSync(target)) continue;
    const e = estadoEnlace({ enlace: where });
    if (e.estado === 'enlace' && e.destinoReal === real(target)) { out.inPlace.push(name); continue; }
    if (e.estado === 'archivo' && sameFile(where, target)) {   // su enlace duro (AC 39): se anota (o se re-anota, si cambió)
      if (!check) record(where, target);
      out.inPlace.push(name); continue;
    }
    // su enlace duro, pero git reemplazó el archivo del clon (un pull): ya no es el mismo archivo, y se rehace
    const stale = e.estado === 'archivo' && ours(where);
    if (e.estado !== 'falta' && e.estado !== 'colgado' && !stale) { out.clashes.push(`${id}/${name}`); continue; }   // una entrada ajena: no se toca
    if (check) { out.added++; out.toAdd.push(name); continue; }
    try {
      if (e.estado === 'colgado') borrarEnlace(where);
      if (stale) { fs.unlinkSync(where); drop(where); }
      const made = linkOne(target, where, links);
      if (made.kind === 'hard') { out.hard.push(name); record(where, target); }
      out.added++; out.inPlace.push(name);
    } catch (err) {
      if (err && err.unlinked) out.unlinked.push({ name: `${id}/${name}`, why: `enlace de archivo: ${err.fileWhy}; enlace duro: ${err.hardWhy}` });
      else out.failed.push({ name: `${id}/${name}`, why: (err && (err.code || err.message)) || 'error' });
    }
  }
  // lo suyo por enlace duro cuya entrada ya no está en el clon: se saca sólo si sigue siendo el archivo anotado y se
  // enlazó a ESTE clon (`written`); si la persona lo reemplazó por uno suyo, se olvida y no se toca
  const dirKey = linkKey(path.join(dir, '_'));
  for (const rec of reg.links.slice()) {
    if (path.dirname(rec.where) !== path.dirname(dirKey)) continue;
    const name = path.basename(rec.where);
    if (fs.existsSync(path.join(src, name))) continue;   // sigue en el clon: lo vio el bucle de arriba
    if (!under(rec.target, written.map((w) => real(w) || path.resolve(w)))) continue;   // de otro clon
    const where = path.join(dir, name);
    if (!sameId(rec.id, fileId(where))) { if (!check) drop(where); continue; }
    if (check) { out.removed++; out.toRemove.push(name); continue; }
    try { fs.unlinkSync(where); drop(where); out.removed++; } catch (err) { out.failed.push({ name: `${id}/${name}`, why: (err && (err.code || err.message)) || 'error' }); }
  }
  if (dirty && !check && !reg.broken) {
    try { writeHardLinks(home, reg.links); }
    catch (err) { out.registry = `no pude escribirlo (${(err && (err.code || err.message)) || 'error'})`; }
  }
  // lo suyo colgado: un enlace cuyo destino escrito cae bajo la carpeta del clon y ya no existe (la entrada se borró)
  let mine = [];
  try { mine = fs.readdirSync(dir); } catch (_) { mine = []; }
  for (const name of mine) {
    const where = path.join(dir, name);
    const e = estadoEnlace({ enlace: where });
    if (e.estado !== 'colgado' || !e.destino) continue;
    const abs = path.resolve(dir, e.destino);
    if (!written.some((w) => abs.startsWith(w + path.sep))) continue;
    if (check) { out.removed++; out.toRemove.push(name); continue; }
    try { borrarEnlace(where); out.removed++; } catch (err) { out.failed.push({ name: `${id}/${name}`, why: (err && (err.code || err.message)) || 'error' }); }
  }
  return out;
}

/**
 * Crea / repara / respeta los enlaces del repo único. Nunca tira: lo que no se pudo se dice en una línea.
 * `only`: 'agent-skills' (ése solo: el instalador lo necesita ANTES de verificar agent-skills) · 'entries' (agents y
 * skills: DESPUÉS del paso de terceros, para que las skills bajadas tengan su entrada en la primera corrida) · sin él, los tres.
 * @returns {{applies:boolean, lines:string[], pieces:{where:string,id:string}[], separate:string|null}} `lines`: una por
 *   enlace creado, reparado, no movido o carpeta real (nada si no cambió); `pieces`: los enlaces en su lugar que apuntan
 *   al clon, con la ruta de la HOME sin resolver (lo que el instalador anota como pieza `link`); `separate`: el clon
 *   aparte de agent-skills si la máquina está en la transición (ahí no aplica: ver `separateSkillsClone`).
 */
function ensureRepoLinks({ clone, home, check = false, only = null, links = null } = {}) {
  const given = path.resolve(clone || RAIZ);
  const c = real(given) || given;
  // `plan`: con `check`, cada enlace con lo que le haría el instalador (add · update · remove · keep; story 8.16, AC 11)
  const out = { applies: isSingleRepo(c), lines: [], pieces: [], separate: null, plan: [] };
  if (!out.applies) return out;
  // la máquina del equipo en la transición (8.18): dos clones, y las skills salen del viejo. Nada que decir ni que mover
  out.separate = separateSkillsClone({ clone: c, home });
  if (out.separate) {
    out.applies = false;
    // lo único que se hace en la transición: que el clon viejo ignore las skills de la cuenta (ver ignoreSyncedSkills).
    // Una vez por corrida del instalador: va con la llamada de agent-skills (o la de los tres), no con la de las entradas
    if (only !== 'entries') {
      const r = ignoreSyncedSkills({ dir: out.separate, check });
      if (r.action === 'added') out.lines.push(`✓ tycon: el clon viejo de agent-skills (${out.separate}) no ignoraba ${SYNCED_SKILLS}, donde Claude Code baja las skills de la cuenta: agregado a ${r.file} (local de esta máquina, no se versiona)`);
      else if (r.action === 'would-add') out.lines.push(`(--check) ✓ tycon: agregaría ${SYNCED_SKILLS} a ${r.file}: el clon viejo de agent-skills (${out.separate}) no ignora las skills de la cuenta`);
    }
    return out;
  }
  const pref = check ? '(--check) ' : '';
  const say = (l) => out.lines.push(`${pref}${l}`);
  const clashes = [];
  for (const L of REPO_LINKS) {
    if (only === 'agent-skills' && L.id !== 'agent-skills') continue;
    if (only === 'entries' && !L.entries) continue;
    const where = path.join(home || os.homedir(), '.claude', L.id);
    const dest = path.join(c, L.sub);
    try {
      const before = estadoEnlace({ enlace: where });
      // Un enlace a una carpeta PROPIA (ni este clon ni otro árbol del arnés: los archivos de configuración de la
      // persona, por ejemplo) se trata como una carpeta real: no se mueve, y adentro va un enlace por entrada. Moverlo
      // dejaba sus skills fuera de la vista de Claude (decisión del dueño, 2026-10-03).
      const own = L.entries && before.estado === 'enlace' && before.destinoReal !== real(dest)
        && isDir(before.destinoReal) && !L.valid(before.destinoReal);
      if ((before.estado === 'carpeta' || own) && L.entries) {
        const r = linkEntries({ dir: where, src: dest, written: [dest, path.join(given, L.sub)], id: L.id, check, links, home });
        if (r.added || r.removed) {
          const what = own ? `es un enlace a una carpeta propia (${before.destinoReal}), no lo muevo` : 'es una carpeta real, no la piso';
          const hard = r.hard.length ? `; ${r.hard.length} como enlace(s) duro(s) (${r.hard.join(', ')}): Windows no dejó crear el enlace de archivo, que pide el modo desarrollador` : '';
          say(check
            ? `✓ tycon: ${where} ${what}: agregaría ${r.added} enlace(s) por entrada y sacaría ${r.removed} (→ ${dest})`
            : `✓ tycon: ${where} ${what}: ${r.added} enlace(s) por entrada agregado(s) y ${r.removed} sacado(s) (→ ${dest})${hard}`);
        }
        if (r.unlinked.length) say(`⚠️ tycon: no pude enlazar ${r.unlinked.length} archivo(s) en ${where} (${r.unlinked[0].why}): ${r.unlinked.map((f) => f.name).join(', ')} — no escribí nada en su lugar; en Windows el enlace de archivo pide el modo desarrollador y el enlace duro, que el archivo esté en el mismo disco`);
        if (r.failed.length) say(`⚠️ tycon: no pude crear o sacar ${r.failed.length} enlace(s) por entrada en ${where} (${r.failed[0].why}): ${r.failed.map((f) => f.name).join(', ')}`);
        if (r.registry && (r.hard.length || r.removed || r.inPlace.length)) say(`⚠️ tycon: el registro de enlaces duros ${hardLinksFile(home)} ${r.registry === 'ilegible' ? 'está ilegible' : `no se pudo usar: ${r.registry}`}: los enlaces duros de ${where} que el arnés crea no se anotan ni se limpian solos`);
        clashes.push(...r.clashes);
        for (const name of r.inPlace) out.pieces.push({ where: path.join(where, name), id: `${L.id}/${name}` });
        for (const [names, action] of [[r.inPlace, 'keep'], [r.toAdd, 'add'], [r.toRemove, 'remove']]) {
          for (const name of names) out.plan.push({ where: path.join(where, name), id: `${L.id}/${name}`, action });
        }
        continue;
      }
      const r = asegurarEnlaceInterno({ enlace: where, destino: dest, esValido: L.valid, check });
      const action = planAction(r.accion);
      if (action) out.plan.push({ where, id: L.id, action });
      if (r.accion === 'created') say(`✓ tycon: enlace ${where} → ${dest} (creado: en el repo único las skills y los revisores salen de este clon)`);
      else if (r.accion === 'repaired') say(before.estado === 'colgado'
        ? `✓ tycon: el enlace ${where} estaba colgado (→ ${before.destino}); reparado → ${dest}`
        : `✓ tycon: el enlace ${where} apuntaba a ${before.destinoReal}, que no sirve como ${L.id}; reparado → ${dest}`);
      else if (r.accion === 'other-clone') say(`⚠️ tycon: el enlace ${where} apunta a otro lado que sirve (${before.destinoReal}) y este instalador corre desde ${c}: no lo muevo. Para que apunte acá, borralo y volvé a correr el instalador`);
      else if (r.accion === 'real-folder') say(`⚠️ tycon: en ${where} hay ${before.estado === 'archivo' ? 'un archivo' : 'una carpeta real'}, no un enlace: no ${before.estado === 'archivo' ? 'lo' : 'la'} piso (las skills y los revisores de este clon no se ven desde ahí)`);
      if (real(where) === real(dest) && estadoEnlace({ enlace: where }).estado === 'enlace') out.pieces.push({ where, id: L.id });
    } catch (e) {
      say(`⚠️ tycon: no pude crear/reparar el enlace ${where} (${e && e.message}): arreglalo a mano o volvé a correr el instalador`);
    }
  }
  if (clashes.length) say(`⚠️ tycon: ya existen en ~/.claude y no son de este clon, no las piso: ${clashes.join(', ')} (las del clon con ese nombre no se ven)`);
  return out;
}

/** @returns {string|null} el aviso, o null si no hay nada que decir */
function aviso({ clon, canonica, home, env = process.env } = {}) {
  if (readEnv('TYCON_NO_CANONICAL_PATH', { env, where: 'scripts/lib/canonical-path.js' }) === '1') return null;
  if (env.TYCON_GUIDES_DIR && String(env.TYCON_GUIDES_DIR).trim()) return null;
  const c = clon || RAIZ;
  const rc = real(c);
  const pie = [
    '   Los hooks se resuelven solos y por eso todo parece andar, pero los revisores y el pipeline nombran',
    '   al arnés por ese enlace: leerían otro clon, o nada, sin error. Corré scripts/install-tycon-hooks.sh',
    '   (crea o repara el enlace; --link <ruta> lo re-apunta). Si no podés, definí TYCON_GUIDES_DIR=<ruta>',
    '   — cubre pipeline y scripts, NO a los revisores. Off: TYCON_NO_CANONICAL_PATH=1.',
  ];
  if (canonica) {   // comparación directa contra una ruta (pruebas y usos viejos): sin enlace en el medio
    const rk = real(canonica);
    if (rc && rk && rc === rk) return null;
    return [`⚠️ tycon: el arnés corre desde ${c}, no desde la ruta canónica ${canonica}${rk ? '' : ' (que no existe)'}.`, ...pie].join('\n');
  }
  const e = estadoEnlace({ home });
  if (e.estado === 'enlace' && rc && e.destinoReal === rc) return null;
  // con sólo el nombre viejo (el lugar falta o está colgado) y apuntando a este clon, callado: lo usan sin decir nada
  // (story 8.19, AC 9); el instalador crea el lugar en la próxima corrida
  if ((e.estado === 'falta' || e.estado === 'colgado') && rc && PLACE().samePath(real(PLACE().legacyPlacePath(home)), rc)) return null;
  const cabeza = {
    falta: `⚠️ tycon: el arnés corre desde ${c} y el enlace ${e.ruta} FALTA.`,
    colgado: `⚠️ tycon: el arnés corre desde ${c} y el enlace ${e.ruta} está COLGADO (→ ${e.destino}).`,
    enlace: `⚠️ tycon: el arnés corre desde ${c}, pero el enlace ${e.ruta} apunta a OTRO clon: ${e.destinoReal}.`,
    carpeta: `⚠️ tycon: el arnés corre desde ${c}, y en ${e.ruta} hay una carpeta real en vez del enlace.`,
    archivo: `⚠️ tycon: el arnés corre desde ${c}, y en ${e.ruta} hay un archivo en vez del enlace.`,
  }[e.estado];
  return [cabeza, ...pie].join('\n');
}

function selftest() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ruta-canonica-'));
  const mk = (...p) => { const d = path.join(t, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const clonValido = (...p) => { const d = mk(...p); fs.mkdirSync(path.join(d, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\n'); return real(d); };
  const casa = (nombre) => { const h = mk('casas', nombre); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; };
  const a = clonValido('Proyectos', 'tycon-claude-guides');
  const b = clonValido('otra-carpeta', 'tycon-claude-guides');
  const noClon = real(mk('no-clon'));
  const casos = [];

  // ── T14: el aviso mira el enlace ──────────────────────────────────────────────────────────
  const h1 = casa('h1'); fs.symlinkSync(a, rutaEnlace(h1));
  casos.push(['T14 el arnés corre desde el clon del enlace: calla', aviso({ clon: a, home: h1, env: {} }) === null]);
  casos.push(['T14 …y un symlink al clon del enlace también calla (se compara la ruta real)',
    (() => { const s = path.join(t, 'symlink-a'); fs.symlinkSync(a, s); return aviso({ clon: s, home: h1, env: {} }) === null; })()]);
  casos.push(['T14 desde OTRO clon: avisa y nombra los dos',
    (() => { const m = aviso({ clon: b, home: h1, env: {} }); return !!m && m.includes(b) && m.includes(a) && /OTRO clon/.test(m); })()]);
  const h2 = casa('h2'); fs.symlinkSync(path.join(t, 'no-existe'), rutaEnlace(h2));
  casos.push(['T14 con el enlace roto: avisa y dice «colgado»', /COLGADO/.test(aviso({ clon: a, home: h2, env: {} }) || '')]);
  const h3 = casa('h3');
  casos.push(['T14 sin enlace: avisa y dice «falta»', /FALTA/.test(aviso({ clon: a, home: h3, env: {} }) || '')]);
  const h4 = casa('h4'); fs.mkdirSync(rutaEnlace(h4));
  casos.push(['T14 con una carpeta real en el lugar del enlace: avisa', /carpeta real/.test(aviso({ clon: a, home: h4, env: {} }) || '')]);
  casos.push(['TYCON_GUIDES_DIR definida: la salida explícita calla', aviso({ clon: b, home: h1, env: { TYCON_GUIDES_DIR: b } }) === null]);
  casos.push(['TYCON_GUIDES_DIR vacía NO es una salida', aviso({ clon: b, home: h1, env: { TYCON_GUIDES_DIR: '  ' } }) !== null]);
  casos.push(['TYCON_NO_CANONICAL_PATH=1: apagado', aviso({ clon: b, home: h1, env: { TYCON_NO_CANONICAL_PATH: '1' } }) === null]);
  casos.push(['el aviso dice que la variable NO cubre a los revisores', (aviso({ clon: b, home: h1, env: {} }) || '').includes('NO a los revisores')]);
  casos.push(['--canonical <ruta> (comparación directa, sin enlace): igual calla, distinta avisa',
    aviso({ clon: a, canonica: a, env: {} }) === null && /ruta canónica/.test(aviso({ clon: b, canonica: a, env: {} }) || '')]);

  // ── T4 (unitario): el instalador delega acá ───────────────────────────────────────────────
  const h5 = casa('h5');
  let r = asegurarEnlace({ clon: a, home: h5 });
  casos.push(['T4 sin enlace: lo crea apuntando al clon', r.accion === 'created' && r.escribio && real(rutaEnlace(h5)) === a]);
  r = asegurarEnlace({ clon: a, home: h5 });
  casos.push(['T4 ya apunta acá: intacto, sin escribir', r.accion === 'unchanged' && !r.escribio]);
  const h6 = casa('h6'); fs.symlinkSync(path.join(t, 'borrado'), rutaEnlace(h6));
  r = asegurarEnlace({ clon: a, home: h6 });
  casos.push(['T4 colgado: lo repara', r.accion === 'repaired' && real(rutaEnlace(h6)) === a]);
  const h7 = casa('h7'); fs.symlinkSync(b, rutaEnlace(h7));
  r = asegurarEnlace({ clon: a, home: h7 });
  casos.push(['T4 apunta a OTRO clon válido: avisa, NO lo mueve y nombra --link (sólo nace el nombre viejo, hacia el lugar: 8.19)', r.accion === 'other-clone' && !r.writes.includes(rutaEnlace(h7)) && real(rutaEnlace(h7)) === b && /--link/.test(r.mensaje)]);
  r = asegurarEnlace({ clon: a, home: h7, forzar: a });
  casos.push(['T4 …y con --link <ruta> lo re-apunta', r.accion === 'repointed' && real(rutaEnlace(h7)) === a]);
  const h8 = casa('h8'); fs.mkdirSync(rutaEnlace(h8)); fs.writeFileSync(path.join(rutaEnlace(h8), 'mio.txt'), 'x');
  r = asegurarEnlace({ clon: a, home: h8 });
  casos.push(['T4 carpeta real: no la toca y lo dice', r.accion === 'real-folder' && fs.existsSync(path.join(rutaEnlace(h8), 'mio.txt')) && /carpeta real/.test(r.mensaje)]);
  r = asegurarEnlace({ clon: a, home: h8, forzar: b });
  casos.push(['T4 carpeta real ni con --link (8.19: se niega y la línea de comandos sale 2)', r.accion === 'refused' && fs.lstatSync(rutaEnlace(h8)).isDirectory()]);
  const h9 = casa('h9');
  r = asegurarEnlace({ clon: a, home: h9, check: true });
  casos.push(['T4 --check: dice qué haría y NO escribe', r.accion === 'created' && !r.escribio && !fs.existsSync(rutaEnlace(h9)) && /--check/.test(r.mensaje)]);
  r = asegurarEnlace({ clon: a, home: h9, forzar: noClon });
  casos.push(['T4 --link a algo que no es un clon: inválido, con el motivo, sin escribir', r.accion === 'invalid' && /no es un clon/.test(r.mensaje) && !fs.existsSync(rutaEnlace(h9))]);
  const h10 = casa('h10'); fs.symlinkSync(noClon, rutaEnlace(h10));
  r = asegurarEnlace({ clon: a, home: h10 });
  casos.push(['T4 apunta a algo que existe pero no es un clon: se repara como colgado', r.accion === 'repaired' && real(rutaEnlace(h10)) === a]);
  const h11 = mk('casas', 'h11'); fs.writeFileSync(path.join(h11, '.claude'), 'un archivo donde iría la carpeta');
  r = asegurarEnlace({ clon: a, home: h11 });
  casos.push(['T4 el enlace no se puede escribir (`.claude` es un archivo): dice «no pude», no tira y no escribió (pase adversarial, vuelta 1)',
    r.accion === 'error' && !r.escribio && /no pude/.test(r.mensaje)]);

  // ── AC 18 de la 8.7 (unitario): los enlaces del repo único ────────────────────────────────────────
  const W = (f, txt) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };
  const isRealDir = (p) => { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch (_) { return false; } };
  const lexists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
  const singleRepoClone = (...p) => {
    const d = clonValido(...p);
    mk(...p, 'skills', 'tycon-pipeline'); mk(...p, 'skills', 'extra');
    W(path.join(d, 'agents', 'rev-a.md'), '# a\n'); W(path.join(d, 'agents', 'rev-b.md'), '# b\n');
    return d;
  };
  const u = singleRepoClone('publico', 'harness');
  const at = (h, ...p) => path.join(h, '.claude', ...p);
  const ids = (res) => res.pieces.map((x) => x.id).sort().join(',');
  casos.push(['AC18 isSingleRepo: con skills/tycon-pipeline y agents/ en la raíz sí; el clon del equipo (sin skills/) no',
    isSingleRepo(u) === true && isSingleRepo(a) === false]);

  const k1 = casa('k1');
  let q = ensureRepoLinks({ clone: u, home: k1 });
  casos.push(['AC18 HOME limpia: crea los tres enlaces (agent-skills → el clon, agents y skills → adentro), una línea por cada uno',
    q.applies === true && real(at(k1, 'agent-skills')) === u && real(at(k1, 'agents')) === path.join(u, 'agents') && real(at(k1, 'skills')) === path.join(u, 'skills')
    && q.lines.length === 3 && q.lines.every((l) => /creado/.test(l)) && ids(q) === 'agent-skills,agents,skills']);
  casos.push(['AC18 …las piezas llevan la ruta SIN resolver (la de la HOME), como las anota el instalador',
    q.pieces.every((x) => x.where === at(k1, x.id))]);
  q = ensureRepoLinks({ clone: u, home: k1 });
  casos.push(['AC18 segunda corrida sin cambios: ninguna línea, y los tres siguen contando como piezas en su lugar',
    q.lines.length === 0 && ids(q) === 'agent-skills,agents,skills']);

  const k2 = casa('k2');
  q = ensureRepoLinks({ clone: u, home: k2, only: 'agent-skills' });
  casos.push(['AC18 --only agent-skills: sólo ése (va antes de la verificación de agent-skills del instalador)',
    real(at(k2, 'agent-skills')) === u && !lexists(at(k2, 'skills')) && !lexists(at(k2, 'agents')) && ids(q) === 'agent-skills']);
  q = ensureRepoLinks({ clone: u, home: k2, only: 'entries' });
  casos.push(['AC18 --only entries: agents y skills (va después del paso de terceros)',
    real(at(k2, 'skills')) === path.join(u, 'skills') && real(at(k2, 'agents')) === path.join(u, 'agents') && ids(q) === 'agents,skills']);

  const k3 = casa('k3');
  q = ensureRepoLinks({ clone: a, home: k3 });
  casos.push(['AC18 el equipo (clon sin skills/ en la raíz): no aplica, no dice nada y no toca nada',
    q.applies === false && q.lines.length === 0 && q.pieces.length === 0 && fs.readdirSync(path.join(k3, '.claude')).length === 0]);

  // C12: «válido» por enlace — agent-skills si tiene skills/tycon-pipeline; skills y agents si son esa carpeta de OTRO
  // árbol del arnés (al lado hay skills/tycon-pipeline como carpeta real)
  const otherSkills = real(mk('equipo', 'agent-skills')); mk('equipo', 'agent-skills', 'skills', 'tycon-pipeline'); mk('equipo', 'agent-skills', 'agents');
  const k4 = casa('k4');
  fs.symlinkSync(otherSkills, at(k4, 'agent-skills')); fs.symlinkSync(path.join(otherSkills, 'skills'), at(k4, 'skills')); fs.symlinkSync(path.join(otherSkills, 'agents'), at(k4, 'agents'));
  q = ensureRepoLinks({ clone: u, home: k4 });
  // (la máquina del equipo DE VERDAD —su agent-skills es un clon de git— calla desde la story 8.18: T29, más abajo)
  casos.push(['AC18/C12 los tres apuntan a OTRO agent-skills válido que no es un clon de git: no se mueven, se dice, y no son piezas',
    real(at(k4, 'agent-skills')) === otherSkills && real(at(k4, 'skills')) === path.join(otherSkills, 'skills') && real(at(k4, 'agents')) === path.join(otherSkills, 'agents')
    && q.lines.length === 3 && q.lines.every((l) => /no lo muevo/.test(l)) && q.pieces.length === 0]);
  const k5 = casa('k5');
  fs.symlinkSync(noClon, at(k5, 'agent-skills')); fs.symlinkSync(noClon, at(k5, 'skills')); fs.symlinkSync(noClon, at(k5, 'agents'));
  q = ensureRepoLinks({ clone: u, home: k5 });
  casos.push(['AC18/C12 agent-skills apuntando a una carpeta que no sirve (sin skills/tycon-pipeline): se repara',
    real(at(k5, 'agent-skills')) === u && q.lines.filter((l) => /reparado/.test(l)).length === 1]);
  // skills y agents enlazados a una carpeta PROPIA (los archivos de configuración de la persona): se tratan como una
  // carpeta real —el enlace no se mueve, adentro va un enlace por entrada— (decisión del dueño, 2026-10-03)
  casos.push(['AC18 skills y agents enlazados a una carpeta propia: el enlace NO se mueve y adentro va un enlace por entrada',
    real(at(k5, 'skills')) === noClon && real(at(k5, 'agents')) === noClon
    && real(path.join(noClon, 'tycon-pipeline')) === path.join(u, 'skills', 'tycon-pipeline') && real(path.join(noClon, 'rev-a.md')) === path.join(u, 'agents', 'rev-a.md')
    && q.lines.filter((l) => /carpeta propia/.test(l) && /no lo muevo/.test(l)).length === 2 && q.lines.length === 3
    && ids(q).includes('skills/tycon-pipeline') && ids(q).includes('agents/rev-a.md') && !q.pieces.some((x) => x.id === 'skills' || x.id === 'agents')]);
  q = ensureRepoLinks({ clone: u, home: k5 });
  casos.push(['AC18 …y la segunda corrida no la confunde con «otro clon» (ya tiene tycon-pipeline adentro, como enlace): ninguna línea, las mismas piezas',
    q.lines.length === 0 && real(at(k5, 'skills')) === noClon && ids(q).includes('skills/tycon-pipeline') && ids(q).includes('agents/rev-b.md')]);
  const k6 = casa('k6');
  for (const n of ['agent-skills', 'skills', 'agents']) fs.symlinkSync(path.join(t, 'borrado', n), at(k6, n));
  q = ensureRepoLinks({ clone: u, home: k6 });
  casos.push(['AC18 colgados: los tres se reparan',
    real(at(k6, 'agent-skills')) === u && real(at(k6, 'skills')) === path.join(u, 'skills') && real(at(k6, 'agents')) === path.join(u, 'agents') && q.lines.length === 3 && q.lines.every((l) => /colgado/.test(l))]);
  const k7 = casa('k7'); W(path.join(at(k7, 'agent-skills'), 'mio.txt'), 'x');
  q = ensureRepoLinks({ clone: u, home: k7, only: 'agent-skills' });
  casos.push(['AC18 una carpeta real en ~/.claude/agent-skills: no se pisa y se dice',
    isRealDir(at(k7, 'agent-skills')) && lexists(path.join(at(k7, 'agent-skills'), 'mio.txt')) && q.lines.length === 1 && /carpeta real/.test(q.lines[0]) && q.pieces.length === 0]);

  // modo por entrada: ~/.claude/skills y ~/.claude/agents ya son carpetas reales de la persona
  const k8 = casa('k8');
  W(at(k8, 'skills', 'mine', 'SKILL.md'), '# mía\n'); W(at(k8, 'skills', 'extra', 'SKILL.md'), '# la mía se llama igual que una del clon\n');
  W(at(k8, 'agents', 'mine.md'), '# mío\n');
  q = ensureRepoLinks({ clone: u, home: k8 });
  casos.push(['AC18 carpetas reales: un enlace por entrada del clon (a una carpeta y a un archivo); la carpeta y lo propio, intactos',
    isRealDir(at(k8, 'skills')) && isRealDir(at(k8, 'agents')) && lexists(at(k8, 'skills', 'mine', 'SKILL.md')) && lexists(at(k8, 'agents', 'mine.md'))
    && real(at(k8, 'skills', 'tycon-pipeline')) === path.join(u, 'skills', 'tycon-pipeline')
    && real(at(k8, 'agents', 'rev-a.md')) === path.join(u, 'agents', 'rev-a.md') && real(at(k8, 'agents', 'rev-b.md')) === path.join(u, 'agents', 'rev-b.md')]);
  casos.push(['AC18 …la entrada que choca (una skill propia con el nombre de una del clon) no se pisa y se nombra en UNA línea',
    isRealDir(at(k8, 'skills', 'extra')) && lexists(at(k8, 'skills', 'extra', 'SKILL.md'))
    && q.lines.filter((l) => /no las piso/.test(l)).length === 1 && /skills\/extra/.test(q.lines.find((l) => /no las piso/.test(l)) || '')]);
  casos.push(['AC18 …una línea por carpeta con cuántos agregó, y las piezas son las entradas (no la carpeta, no la que choca)',
    q.lines.filter((l) => /agregad/.test(l)).length === 2 && ids(q) === 'agent-skills,agents/rev-a.md,agents/rev-b.md,skills/tycon-pipeline']);
  // segunda corrida: una skill nueva en el clon, un revisor borrado, y un colgado AJENO que no se toca (espejo)
  mk('publico', 'harness', 'skills', 'new-one'); fs.rmSync(path.join(u, 'agents', 'rev-b.md'));
  fs.symlinkSync(path.join(t, 'de-la-persona', 'ya-no-esta'), at(k8, 'skills', 'theirs'));
  q = ensureRepoLinks({ clone: u, home: k8 });
  casos.push(['AC18 segunda corrida: agrega la entrada nueva y saca el enlace SUYO que quedó colgado; el colgado ajeno queda (espejo)',
    real(at(k8, 'skills', 'new-one')) === path.join(u, 'skills', 'new-one') && !lexists(at(k8, 'agents', 'rev-b.md')) && isLink(at(k8, 'skills', 'theirs'))
    && lexists(at(k8, 'agents', 'mine.md')) && ids(q) === 'agent-skills,agents/rev-a.md,skills/new-one,skills/tycon-pipeline']);
  casos.push(['AC18 …y lo dice: en skills «1 … agregad», en agents «1 sacad»',
    q.lines.some((l) => /skills/.test(l) && /1 enlace\(s\) por entrada agregad/.test(l)) && q.lines.some((l) => /agents/.test(l) && /1 sacad/.test(l))]);
  q = ensureRepoLinks({ clone: u, home: k8 });
  casos.push(['AC18 tercera corrida sin cambios: sólo la línea del choque', q.lines.length === 1 && /no las piso/.test(q.lines[0])]);
  // en una entrada del clon: un colgado se repara; un enlace vivo a OTRO lado choca y no se toca
  const k9 = casa('k9'); fs.mkdirSync(at(k9, 'skills')); fs.mkdirSync(at(k9, 'agents'));
  const theirs = W(path.join(t, 'de-la-persona', 'rev-a.md'), '# el de la persona\n');
  fs.symlinkSync(path.join(t, 'clon-viejo', 'skills', 'tycon-pipeline'), at(k9, 'skills', 'tycon-pipeline')); fs.symlinkSync(theirs, at(k9, 'agents', 'rev-a.md'));
  q = ensureRepoLinks({ clone: u, home: k9, only: 'entries' });
  casos.push(['AC18 por entrada: un colgado con el nombre de una entrada se repara; un enlace vivo a otro lado choca y queda',
    real(at(k9, 'skills', 'tycon-pipeline')) === path.join(u, 'skills', 'tycon-pipeline') && real(at(k9, 'agents', 'rev-a.md')) === real(theirs)
    && /agents\/rev-a\.md/.test(q.lines.find((l) => /no las piso/.test(l)) || '') && !q.pieces.some((x) => x.id === 'agents/rev-a.md')]);

  // una entrada del CLON que es ella misma un enlace colgado no se enlaza (pase adversarial de la tanda C: se agregaba
  // y se sacaba en la misma corrida, todas las corridas, y se anotaba como pieza un enlace que ya no existía)
  const u2 = singleRepoClone('publico-colgado', 'harness'); fs.symlinkSync(path.join(t, 'no-existe', 'zzz'), path.join(u2, 'skills', 'dangling'));
  const k18 = casa('k18'); fs.mkdirSync(at(k18, 'skills')); fs.mkdirSync(at(k18, 'agents'));
  q = ensureRepoLinks({ clone: u2, home: k18, only: 'entries' });
  const firstRun = { dangling: lexists(at(k18, 'skills', 'dangling')), piece: q.pieces.some((x) => x.id === 'skills/dangling'), linked: real(at(k18, 'skills', 'tycon-pipeline')) === path.join(u2, 'skills', 'tycon-pipeline') };
  q = ensureRepoLinks({ clone: u2, home: k18, only: 'entries' });
  casos.push(['AC18 por entrada: una entrada del clon que es un enlace colgado no se enlaza ni es pieza; las sanas sí, y la segunda corrida no dice nada',
    !firstRun.dangling && !firstRun.piece && firstRun.linked && q.lines.length === 0 && !q.pieces.some((x) => x.id === 'skills/dangling')]);
  // una entrada que no se puede escribir (la carpeta real no deja crear nada adentro): se dice, no tira, y no es pieza
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const k19 = casa('k19'); fs.mkdirSync(at(k19, 'skills')); fs.mkdirSync(at(k19, 'agents')); fs.chmodSync(at(k19, 'skills'), 0o555);
    let threwEntry = false; try { q = ensureRepoLinks({ clone: u, home: k19, only: 'entries' }); } catch (_) { threwEntry = true; }
    fs.chmodSync(at(k19, 'skills'), 0o755);
    casos.push(['AC18 por entrada: una entrada que no se puede escribir se dice («no pude crear o sacar»), no tira y no es pieza; la otra carpeta sí se enlaza',
      !threwEntry && q.lines.some((l) => /no pude crear o sacar \d+ enlace\(s\) por entrada/.test(l) && /skills\/tycon-pipeline/.test(l))
      && !q.pieces.some((x) => /^skills\//.test(x.id)) && real(at(k19, 'agents', 'rev-a.md')) === path.join(u, 'agents', 'rev-a.md')]);
  } else {
    // root escribe igual en una carpeta sin permiso: el caso no puede fallar ahí, y se dice en vez de perderlo callado
    console.log('⏭ ruta-canonica: NO MEDIDO — «una entrada que no se puede escribir» (corre como root, o sin uid: no hay permiso que negar)');
  }

  // --check: dice qué haría y no escribe
  const k10 = casa('k10');
  q = ensureRepoLinks({ clone: u, home: k10, check: true });
  casos.push(['AC18 --check en una HOME limpia: tres líneas con lo que haría, nada escrito, ninguna pieza',
    q.lines.length === 3 && q.lines.every((l) => /^\(--check\) /.test(l)) && fs.readdirSync(path.join(k10, '.claude')).length === 0 && q.pieces.length === 0]);
  const k11 = casa('k11'); W(at(k11, 'skills', 'mine', 'SKILL.md'), '# mía\n');
  q = ensureRepoLinks({ clone: u, home: k11, only: 'entries', check: true });
  casos.push(['AC18 --check por entrada: dice cuántos agregaría y no escribe ninguno',
    fs.readdirSync(at(k11, 'skills')).join(',') === 'mine' && !lexists(at(k11, 'agents')) && q.lines.some((l) => /^\(--check\) /.test(l) && /skills/.test(l) && /agregar/.test(l))]);

  // nunca tira: `.claude` es un archivo
  const k12 = mk('casas', 'k12'); fs.writeFileSync(path.join(k12, '.claude'), 'un archivo donde iría la carpeta');
  let threw = false; try { q = ensureRepoLinks({ clone: u, home: k12 }); } catch (_) { threw = true; }
  casos.push(['AC18 un enlace que no se puede escribir: dice «no pude», no tira y no es pieza', !threw &&q.lines.length > 0 && q.lines.every((l) => /no pude/.test(l)) && q.pieces.length === 0]);

  // por la línea de comandos: el reporte de piezas (TYCON_REPORT_PIECES), --check que no lo escribe, y el uso
  const { spawnSync } = require('child_process');
  const cli = (args, env = {}) => spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_REPORT_PIECES: '' }, env) });
  const k13 = casa('k13'); const rep = path.join(t, 'pieces-k13.tsv');
  let c1 = cli(['--ensure-repo-links', '--clone', u, '--home', k13, '--check'], { TYCON_REPORT_PIECES: rep });
  casos.push(['AC18 CLI --check: sale 0, dice qué haría, no escribe enlaces ni el reporte de piezas',
    c1.status === 0 && /\(--check\)/.test(c1.stdout) && fs.readdirSync(path.join(k13, '.claude')).length === 0 && !fs.existsSync(rep)]);
  c1 = cli(['--ensure-repo-links', '--clone', u, '--home', k13], { TYCON_REPORT_PIECES: rep });
  const recorded = fs.existsSync(rep) ? fs.readFileSync(rep, 'utf8') : '';
  casos.push(['AC18 CLI con TYCON_REPORT_PIECES: anota «link<TAB>ruta<TAB>id» por cada enlace en su lugar',
    c1.status === 0 && recorded === ['agent-skills', 'agents', 'skills'].map((n) => `link\t${at(k13, n)}\t${n}\n`).join('')]);
  c1 = cli(['--ensure-repo-links', '--clone', a, '--home', casa('k14')], { TYCON_REPORT_PIECES: path.join(t, 'pieces-k14.tsv') });
  casos.push(['AC18 CLI en el clon del equipo: sale 0, no imprime nada y no anota nada',
    c1.status === 0 && c1.stdout === '' && !fs.existsSync(path.join(t, 'pieces-k14.tsv'))]);
  c1 = cli(['--ensure-repo-links', '--clone', u, '--home', casa('k15'), '--only', 'otra-cosa']);
  casos.push(['AC18 CLI --only con un valor que no existe: sale 2 (uso) y no escribe', c1.status === 2 && fs.readdirSync(path.join(t, 'casas', 'k15', '.claude')).length === 0]);
  const k16 = casa('k16');
  c1 = cli(['--ensure-link', '--clone', u, '--home', k16]);
  casos.push(['AC18 --ensure-link: en el repo único crea SÓLO el nombre del arnés (el lugar; desde la tanda C de la 8.19, una máquina nueva no recibe el viejo)',
    c1.status === 0 && real(rutaEnlace(k16)) === u && fs.readdirSync(path.join(k16, '.claude')).filter((n) => !n.startsWith('.')).sort().join(',') === (LEGACY_FOR_NEW_MACHINES ? [PLACE().LEGACY_PLACE_NAME, PLACE().PLACE_NAME] : [PLACE().PLACE_NAME]).sort().join(',')]);

  // ── story 8.18, AC 28 (unitario · T29): la máquina del equipo en la TRANSICIÓN ───────────────────────────────────
  // El clon del arnés ya trae skills/ y agents/ (`u`), y la máquina sigue con su clon viejo de agent-skills: una carpeta
  // REAL en ~/.claude/agent-skills, con skills y agents enlazados a su interior. Cero líneas, ninguna pieza, nada movido.
  // 🔴 rojo previo (medido sobre la base, 2026-10-04): tres líneas por corrida —«hay una carpeta real… no la piso» y dos
  //    «apunta a otro lado que sirve… no lo muevo»—, también con --check.
  const separate = typeof separateSkillsClone === 'function' ? separateSkillsClone : () => undefined;
  const teamHome = (name, { git = true, links = true } = {}) => {
    const h = casa(name); const d = at(h, 'agent-skills');
    mk('casas', name, '.claude', 'agent-skills', 'skills', 'tycon-pipeline'); mk('casas', name, '.claude', 'agent-skills', 'agents');
    if (git) mk('casas', name, '.claude', 'agent-skills', '.git');   // alcanza con la carpeta: «es un clon» se decide por ella
    W(path.join(d, 'untracked.txt'), 'lo del dev\n');
    if (links) { fs.symlinkSync(path.join(d, 'skills'), at(h, 'skills')); fs.symlinkSync(path.join(d, 'agents'), at(h, 'agents')); }
    return h;
  };
  const shape = (h) => ['agent-skills', 'skills', 'agents'].map((n) => { const e = estadoEnlace({ enlace: at(h, n) }); return `${n}:${e.estado}:${e.destino || ''}`; }).join('|');
  const m1 = teamHome('m1');
  const shapeBefore = shape(m1);
  casos.push(['T29 separateSkillsClone: en la máquina del equipo devuelve el clon viejo; con un clon del arnés sin skills/, null',
    separate({ clone: u, home: m1 }) === real(at(m1, 'agent-skills')) && separate({ clone: a, home: m1 }) === null]);
  const runs = [0, 1, 2].map(() => ensureRepoLinks({ clone: u, home: m1 }));
  casos.push(['T29 la máquina del equipo, tres corridas seguidas: cero líneas, ninguna pieza, y no aplica (como antes de traer skills/)',
    runs.every((r) => r.lines.length === 0 && r.pieces.length === 0 && r.applies === false)]);
  q = ensureRepoLinks({ clone: u, home: m1, check: true });
  casos.push(['T29 …con --check: cero líneas', q.lines.length === 0 && q.pieces.length === 0]);
  casos.push(['T29 …por partes, como las llama el instalador (--only agent-skills, --only entries): cero líneas',
    ensureRepoLinks({ clone: u, home: m1, only: 'agent-skills' }).lines.length === 0 && ensureRepoLinks({ clone: u, home: m1, only: 'entries' }).lines.length === 0]);
  casos.push(['T29 …y nada se movió: la carpeta sigue real, con lo del dev, y los dos enlaces apuntan a donde apuntaban',
    shape(m1) === shapeBefore && isRealDir(at(m1, 'agent-skills')) && lexists(path.join(at(m1, 'agent-skills'), 'untracked.txt'))]);
  const repPieces = path.join(t, 'pieces-m1.tsv');
  c1 = cli(['--ensure-repo-links', '--clone', u, '--home', m1], { TYCON_REPORT_PIECES: repPieces });
  casos.push(['T29 CLI en la máquina del equipo: sale 0, no imprime nada y no anota ninguna pieza',
    c1.status === 0 && c1.stdout === '' && c1.stderr === '' && !fs.existsSync(repPieces)]);
  c1 = cli(['--separate-skills-clone', '--clone', u, '--home', m1]);
  const c2 = cli(['--separate-skills-clone', '--clone', a, '--home', m1]);
  casos.push(['T29 CLI --separate-skills-clone: en la transición imprime el clon viejo; si el clon no trae skills/, nada; sale 0 en los dos',
    c1.status === 0 && c1.stdout === `${real(at(m1, 'agent-skills'))}\n` && c2.status === 0 && c2.stdout === '']);
  // el clon viejo en otra carpeta, con ~/.claude/agent-skills como ENLACE a él: son dos clones igual
  const m2 = casa('m2'); const elsewhere = real(mk('equipo-git', 'agent-skills'));
  mk('equipo-git', 'agent-skills', 'skills', 'tycon-pipeline'); mk('equipo-git', 'agent-skills', 'agents'); mk('equipo-git', 'agent-skills', '.git');
  fs.symlinkSync(elsewhere, at(m2, 'agent-skills')); fs.symlinkSync(path.join(elsewhere, 'skills'), at(m2, 'skills')); fs.symlinkSync(path.join(elsewhere, 'agents'), at(m2, 'agents'));
  q = ensureRepoLinks({ clone: u, home: m2 });
  casos.push(['T29 ~/.claude/agent-skills ENLAZADO a un clon viejo que vive en otra carpeta: también es la transición, calla y no mueve',
    separate({ clone: u, home: m2 }) === elsewhere && q.lines.length === 0 && real(at(m2, 'agent-skills')) === elsewhere && real(at(m2, 'skills')) === path.join(elsewhere, 'skills')]);
  // en la transición NUNCA se apunta nada a este clon: una entrada que falta no se crea (quedaría colgada si `main`
  // volviera a antes de la unión) y tampoco suma un aviso nuevo en cada arranque; lo dice `doctor`
  const m3 = teamHome('m3', { links: false });
  q = ensureRepoLinks({ clone: u, home: m3 });
  casos.push(['T29 en la transición, skills y agents que faltan no se crean hacia este clon, y no se dice nada',
    q.lines.length === 0 && q.pieces.length === 0 && !lexists(at(m3, 'skills')) && !lexists(at(m3, 'agents'))]);
  // (error) callar vale SÓLO para el estado conocido
  const m4 = teamHome('m4', { git: false });
  q = ensureRepoLinks({ clone: u, home: m4 });
  casos.push(['T29 (error) una carpeta real con skills/ pero que NO es un clon (sin .git): avisa como siempre («carpeta real», y los dos «no lo muevo»)',
    separate({ clone: u, home: m4 }) === null && q.lines.filter((l) => /carpeta real/.test(l)).length === 1 && q.lines.filter((l) => /no lo muevo/.test(l)).length === 2
    && isRealDir(at(m4, 'agent-skills'))]);
  const m5 = casa('m5'); W(path.join(at(m5, 'agent-skills'), 'mio.txt'), 'x'); mk('casas', 'm5', '.claude', 'agent-skills', '.git');
  q = ensureRepoLinks({ clone: u, home: m5, only: 'agent-skills' });
  casos.push(['T29 (error) un clon de OTRA cosa (con .git, sin skills/tycon-pipeline ni agents/): avisa «carpeta real» y no lo pisa',
    separate({ clone: u, home: m5 }) === null && q.lines.length === 1 && /carpeta real/.test(q.lines[0]) && lexists(path.join(at(m5, 'agent-skills'), 'mio.txt'))]);
  const u3 = singleRepoClone('publico-otro', 'harness'); mk('publico-otro', 'harness', '.git');
  const m6 = casa('m6');
  fs.symlinkSync(u3, at(m6, 'agent-skills')); fs.symlinkSync(path.join(u3, 'skills'), at(m6, 'skills')); fs.symlinkSync(path.join(u3, 'agents'), at(m6, 'agents'));
  q = ensureRepoLinks({ clone: u, home: m6 });
  casos.push(['T29 (error) los enlaces apuntan a OTRO clon del arnés entero (un clon descartable corrido acá): se sigue diciendo «no lo muevo», tres veces',
    separate({ clone: u, home: m6 }) === null && q.lines.length === 3 && q.lines.every((l) => /no lo muevo/.test(l)) && real(at(m6, 'agent-skills')) === u3]);
  const m7 = casa('m7'); fs.symlinkSync(u, at(m7, 'agent-skills'));
  casos.push(['T29 (espejo) el árbol único —~/.claude/agent-skills ya es este clon— no es la transición: los enlaces se crean como siempre',
    separate({ clone: u, home: m7 }) === null && ensureRepoLinks({ clone: u, home: m7 }).lines.filter((l) => /creado/.test(l)).length === 2]);
  casos.push(['T29 (contrato C4) isSingleRepo no cambió: el clon unido sí, el del equipo sin skills/ no, y el clon viejo de skills también da sí',
    isSingleRepo(u) === true && isSingleRepo(a) === false && isSingleRepo(real(at(m1, 'agent-skills'))) === true && isSingleRepo.length === 1]);

  // ── 2026-10-05 (T30): el clon viejo ignora las skills de la cuenta ─────────────────────────────────────────────────
  // 🔴 rojo previo: en la transición el instalador no hacía nada, y los 229 archivos de skills/synced/ quedaban sueltos
  //    adentro del clon viejo (medido en Windows el 2026-10-04). Repos de git DE VERDAD: la pregunta la contesta git.
  const { spawnSync: sp } = require('child_process');
  const gitOk = sp('git', ['--version'], { encoding: 'utf8' }).status === 0;
  if (gitOk) {
    const gitHome = (name) => {
      const h = teamHome(name, { git: false });
      sp('git', ['init', '-q', at(h, 'agent-skills')], { encoding: 'utf8' });
      return h;
    };
    const exclude = (h) => path.join(at(h, 'agent-skills'), '.git', 'info', 'exclude');
    const ignored = (h) => sp('git', ['-C', at(h, 'agent-skills'), 'check-ignore', '-q', '--no-index', 'skills/synced/x']).status === 0;
    const readOr = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
    const g1 = gitHome('g1');
    const before1 = readOr(exclude(g1));
    q = ensureRepoLinks({ clone: u, home: g1, check: true, only: 'agent-skills' });
    casos.push(['T30 --check en el clon viejo que no ignora skills/synced/: una línea «agregaría» y no escribe',
      !ignored(g1) && q.lines.length === 1 && /^\(--check\) .*agregaría skills\/synced\//.test(q.lines[0]) && readOr(exclude(g1)) === before1]);
    q = ensureRepoLinks({ clone: u, home: g1, only: 'entries' });
    casos.push(['T30 la llamada de las entradas no lo hace (una vez por corrida, con la de agent-skills)',
      q.lines.length === 0 && readOr(exclude(g1)) === before1]);
    q = ensureRepoLinks({ clone: u, home: g1, only: 'agent-skills' });
    casos.push(['T30 la llamada de agent-skills lo agrega al exclude local: una línea, y git ya lo ignora',
      q.lines.length === 1 && /no ignoraba skills\/synced\//.test(q.lines[0]) && ignored(g1)
      && readOr(exclude(g1)).startsWith(before1 || '') && readOr(exclude(g1)).split('\n').filter((l) => l === 'skills/synced/').length === 1]);
    const after1 = readOr(exclude(g1));
    const runs30 = [0, 1].map(() => ensureRepoLinks({ clone: u, home: g1 }));
    casos.push(['T30 con la línea ya puesta: dos corridas más, cero líneas, el archivo igual byte a byte',
      runs30.every((r) => r.lines.length === 0) && readOr(exclude(g1)) === after1]);
    const g2 = gitHome('g2');
    W(path.join(at(g2, 'agent-skills'), '.gitignore'), 'skills/synced/\n');
    const before2 = readOr(exclude(g2));
    q = ensureRepoLinks({ clone: u, home: g2, only: 'agent-skills' });
    casos.push(['T30 si el repo ya lo ignora por su .gitignore: no toca el exclude ni dice nada',
      q.lines.length === 0 && readOr(exclude(g2)) === before2]);
    const g3 = gitHome('g3');
    W(exclude(g3), '# lo del dev\n*.bak');
    ensureRepoLinks({ clone: u, home: g3, only: 'agent-skills' });
    casos.push(['T30 un exclude que no termina en salto de línea: lo del dev queda intacto y la línea va en su propio renglón',
      readOr(exclude(g3)).startsWith('# lo del dev\n*.bak\n') && ignored(g3)
      && sp('git', ['-C', at(g3, 'agent-skills'), 'check-ignore', '-q', '--no-index', 'a.bak']).status === 0]);
    // (error) un `.git` vacío adentro de un repo de verdad: git contestaría por el repo de afuera. No se escribe en ninguno
    const outer = real(mk('afuera')); sp('git', ['init', '-q', outer]);
    const g4 = casa('g4'); const inner = path.join(outer, 'agent-skills');
    fs.mkdirSync(path.join(inner, 'skills', 'tycon-pipeline'), { recursive: true }); fs.mkdirSync(path.join(inner, 'agents'));
    fs.mkdirSync(path.join(inner, '.git'));
    fs.symlinkSync(inner, at(g4, 'agent-skills'));
    const outerBefore = readOr(path.join(outer, '.git', 'info', 'exclude'));
    q = ensureRepoLinks({ clone: u, home: g4, only: 'agent-skills' });
    casos.push(['T30 (error) un .git vacío adentro de otro repo: calla y no escribe en el exclude del repo de afuera',
      separateSkillsClone({ clone: u, home: g4 }) === real(inner) && q.lines.length === 0
      && readOr(path.join(outer, '.git', 'info', 'exclude')) === outerBefore]);
    casos.push(['T30 (error) git que no se puede correr: «no sé», no escribe',
      ignoreSyncedSkills({ dir: at(gitHome('g5'), 'agent-skills'), git: path.join(t, 'no-hay-git') }).action === 'unknown']);
  } else {
    casos.push(['T30 NO MEDIDO: no hay git en esta máquina', false]);
  }

  fs.rmSync(t, { recursive: true, force: true });
  let malos = 0;
  for (const [n, ok] of casos) { if (!ok) malos++; console.log(`${ok ? '✅' : '❌'} ${n}`); }
  console.log(malos ? `❌ ruta-canonica selftest: ${malos}/${casos.length} mal` : `✅ ruta-canonica selftest: ${casos.length}/${casos.length}`);
  return malos ? 1 : 0;
}

if (require.main === module) {
  aliasArgv('scripts/lib/canonical-path.js', { exitCode: 2 });   // los nombres viejos siguen andando (story 8.9, tanda B3a)
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--ensure-link')) {
    const check = argv.includes('--check');
    const r = asegurarEnlace({ clon: arg('--clone'), home: arg('--home'), check, forzar: arg('--link'), prefer: arg('--prefer') });
    process.stdout.write(r.mensaje + '\n');
    // el plan del instalador (story 8.16, AC 11): sólo con --check, en el temporal que deja `--plan-json`. Desde la 8.19,
    // los dos nombres del lugar, cada uno con lo que le pasaría
    const action = planAction(r.accion);
    const planned = action ? [{ where: r.ruta, id: PLACE().PLACE_NAME, action }] : [];
    if (r.legacy && r.legacy.action) planned.push({ where: r.legacy.ruta, id: PLACE().LEGACY_PLACE_NAME, action: r.legacy.action });
    if (check) appendPlan(process.env.TYCON_PLAN_PIECES, planned);
    process.exit(r.accion === 'invalid' || r.accion === 'refused' ? 2 : 0);
  }
  if (argv.includes('--ensure-repo-links')) {
    const only = argv.includes('--only') ? String(arg('--only') || '') : null;
    if (only !== null && !['agent-skills', 'entries'].includes(only)) {
      process.stderr.write(`canonical-path.js: --only «${only}»: tiene que ser agent-skills o entries\n`);
      process.exit(2);
    }
    const check = argv.includes('--check');
    const r = ensureRepoLinks({ clone: arg('--clone'), home: arg('--home'), check, only });
    for (const l of r.lines) process.stdout.write(l + '\n');
    // el reporte de piezas del instalador (story 8.13, AC 15): mismo temporal y misma forma que anotan él y el sync
    const pieces = process.env.TYCON_REPORT_PIECES;
    if (pieces && !check && r.pieces.length) {
      try { fs.appendFileSync(pieces, r.pieces.map((p) => `link\t${p.where}\t${p.id}\n`).join('')); }
      catch (e) { process.stderr.write(`⚠ tycon: no pude anotar los enlaces del repo único en el reporte de piezas (${e && e.message})\n`); }
    }
    if (check) appendPlan(process.env.TYCON_PLAN_PIECES, r.plan);
    process.exit(0);   // sale 0 siempre (2 sólo por uso): un enlace que no se pudo escribir avisa, no frena el arranque
  }
  if (argv.includes('--place-pieces')) {
    // story 8.19 (AC 11): una pieza `link` por cada nombre del lugar que ES un enlace (un junction en Windows), con la
    // ruta sin resolver. Lo pregunta Node porque en el bash de Git para Windows `-L` no reconoce un junction. Sale 0
    for (const p of placePieces({ home: arg('--home') })) process.stdout.write(`link\t${p.where}\t${p.id}\n`);
    process.exit(0);
  }
  if (argv.includes('--separate-skills-clone')) {
    // la pregunta de la transición (8.18), para quien no puede cargar este archivo (harness.js corre desde su copia fija;
    // un guion de shell): imprime la ruta del clon aparte, o nada. Sale 0 siempre
    const dir = separateSkillsClone({ clone: arg('--clone'), home: arg('--home') });
    if (dir) process.stdout.write(dir + '\n');
    process.exit(0);
  }
  const m = aviso({ clon: arg('--clone'), canonica: arg('--canonical'), home: arg('--home') });
  if (m) console.log(m);
  process.exit(0);
}
module.exports = { aviso, asegurarEnlace, estadoEnlace, rutaEnlace, esClonDelArnes, ensurePlace, placePieces, placePlan, nameState, pointName, removeName, takePlaceLock, LEGACY_FOR_NEW_MACHINES, ensureRepoLinks, isSingleRepo, REPO_LINKS, separateSkillsClone, ignoreSyncedSkills, ownHardLink, forgetHardLink, hardLinksFile };
// el nombre del lugar, como siempre se exportó (story 8.19: sale de place.js, cargada al pedirlo)
Object.defineProperty(module.exports, 'NOMBRE_ENLACE', { enumerable: true, get: () => PLACE().PLACE_NAME });
