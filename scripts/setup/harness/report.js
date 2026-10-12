'use strict';
// report.js — lo que el mecanismo le dice a la persona: la versión, el resumen de install, el diagnóstico de doctor,
// el registro de arranque y el aviso pendiente (story 8.13, AC 3, AC 11, AC 13).
//
// La versión, mientras el equipo instala desde los repos internos: `YYYY.MM.DD+<sha7>` —la fecha UTC del commit de HEAD
// del arnés, nunca la del reloj—, con el sha de agent-skills al lado (sin número, no se ordena). Con `version.json` en la
// raíz del árbol (la copia pública, tanda D: `{ version, source: { <fuente>: <sha>, … } }`) se imprime la estampada y sus
// shas fuente. El archivo NO trae canal —el mismo llega a `main` (estable) con el merge—: el canal que se muestra es el de
// la política. `source` es un mapa nombre → sha con las claves que traiga (hoy `harness` y `agent_skills`; con los repos
// internos unificados será una): no se exige ninguna. En `developer` se avisa que la versión es la del clon.
//
// El registro: `~/.claude/.tycon-pipeline/harness/startup.log`, una línea con fecha por entrada, rotado a 1 MB (el
// anterior queda en `startup.log.1`). El aviso (`notice`) es lo que `startup` deja en el estado y el hook síncrono
// imprime dirigido a la persona.
//
// Funciones puras respecto del HOME: reciben `home`/`env`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths } = require('./state.js');
const sources = require('./sources.js');

const LOG_MAX_BYTES = 1024 * 1024;
const VERSION_FILE = 'version.json';
const sha7 = (s) => (s ? String(s).slice(0, 7) : null);
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** `version.json` del árbol, si está y es legible. */
function stampedVersion(tree) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(tree, VERSION_FILE), 'utf8'));
    return isObject(j) && typeof j.version === 'string' && j.version ? j : null;
  } catch (_) { return null; }
}

/** Fecha UTC (YYYY.MM.DD) de un commit (por defecto HEAD), o null si no hay git a mano. */
function headDateUtc(dir, env, rev = 'HEAD') {
  const ct = sources.git(dir, ['log', '-1', '--format=%ct', rev], { env, timeout: 10000 });
  const n = ct.ok ? parseInt(ct.out, 10) : NaN;
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString().slice(0, 10).replace(/-/g, '.');
}

/**
 * El número de versión de un commit que está en el clon (lo traído, antes de aplicarlo): el de su `version.json` si lo
 * trae (`stamped`); si ese commit de verdad no trae el archivo, el derivado `YYYY.MM.DD+sha7` con la fecha UTC de ESE
 * commit. Si el archivo está y no se pudo leer, NO se inventa el derivado (no es «sin número»): `number` es `null` y
 * `problem` dice por qué. Lo usa el aviso de versión nueva (AC 26).
 * @returns {{ number: string|null, stamped: boolean, problem: string|null }}
 */
function numberAt(dir, rev, { env = process.env } = {}) {
  const v = sources.versionAt(dir, rev, { env });
  if (v.status === 'ok') return { number: v.version, stamped: true, problem: null };
  if (v.status === 'problem') return { number: null, stamped: false, problem: `${VERSION_FILE}: ${v.reason}` };
  const sha = sources.git(dir, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], { env, timeout: 10000 });
  const date = headDateUtc(dir, env, rev) || new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  return { number: `${date}+${sha7(sha.ok ? sha.out : rev) || 'sin-sha'}`, stamped: false, problem: null };
}

function sourceOf(state, name) { return (state.sources || []).find((s) => s && s.name === name) || null; }

/**
 * La versión derivada del estado y de los árboles: `{ number, stamped, harness: {commit}, agent_skills: {commit}, source }`.
 * `trees` permite mirar otros árboles (`{ harness, agent_skills }`); por defecto los del estado.
 */
function derive(state, { env = process.env, trees = {} } = {}) {
  const hs = sourceOf(state, 'harness');
  const as = sourceOf(state, 'agent_skills');
  const harnessDir = trees.harness || state.tree || (hs && hs.dir) || null;
  const skillsDir = trees.agent_skills || (as && as.dir) || null;
  const harnessCommit = (harnessDir && sources.head(harnessDir, { env })) || (hs && hs.commit) || null;
  const skillsCommit = (skillsDir && sources.head(skillsDir, { env })) || (as && as.commit) || null;
  const stamped = harnessDir ? stampedVersion(harnessDir) : null;
  if (stamped) {
    return {
      number: stamped.version, stamped: true,
      source: isObject(stamped.source) ? stamped.source : {},
      harness: { commit: harnessCommit }, agent_skills: { commit: skillsCommit },
    };
  }
  const date = (harnessDir && headDateUtc(harnessDir, env))
    || (state.version && state.version.installed_at ? String(state.version.installed_at).slice(0, 10).replace(/-/g, '.') : null)
    || new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  return {
    number: `${date}+${sha7(harnessCommit) || 'sin-sha'}`, stamped: false,
    source: { harness: harnessCommit, agent_skills: skillsCommit },
    harness: { commit: harnessCommit }, agent_skills: { commit: skillsCommit },
  };
}

/**
 * `YYYY.MM.DD+sha7 · agent-skills sha7 · <mode> · <channel> · <sources>` (o la estampada y los shas fuente que traiga).
 * `opts.channel`: el canal de la política vigente (la única verdad, A9); sin él, el que guarda el estado.
 */
function versionLine(state, opts = {}) {
  const d = derive(state, opts);
  const list = (state.sources || []).map((s) => `${s.name}@${s.ref}`).join(', ') || 'sin fuentes';
  // con el clon de skills re-apuntado al repo unificado los dos clones están en el MISMO commit: se muestra uno solo,
  // el del número (story 8.18, AC 35). Con commits distintos —o sin clon aparte— se dice como siempre
  const oneCommit = Boolean(d.agent_skills.commit) && d.agent_skills.commit === d.harness.commit;
  const parts = d.stamped
    ? [d.number, ...Object.keys(d.source).map((name) => `${name.replace(/_/g, '-')} ${sha7(d.source[name]) || '—'}`)]
    : (oneCommit ? [d.number] : [d.number, `agent-skills ${sha7(d.agent_skills.commit) || '—'}`]);
  parts.push(state.mode || 'managed', opts.channel || state.channel || 'stable', list);
  // la capa (story 8.13.1, AC 17): su commit, y si quedó al mínimo, cuántas horas atrás de main interno
  const layer = (state.sources || []).find((s) => s && s.kind === 'layer');
  if (layer) {
    const lag = isObject(state.layer) && state.layer.minimum ? ` · mínimo, ${typeof state.layer.lag_hours === 'number' ? state.layer.lag_hours : '—'} h` : '';
    parts.push(`capa ${sha7(layer.commit) || '—'}${lag}`);
  }
  let line = parts.join(' · ');
  if (state.mode === 'developer') line += ` · modo desarrollador: la versión es la del clon ${state.tree}, no una publicada`;
  // la retención que dejó un rollback (tanda C, AC 19): update no avanza hasta levantarla
  if (isObject(state.hold)) line += ` · retención: deshiciste ${state.hold.commit || '—'} el ${state.hold.at || '—'}; update no avanza (harness.js rollback --release, o update --yes)`;
  return line;
}

/** Los campos del estado, con la versión derivada, más `hold`. */
function versionJson(state, opts = {}) {
  const d = derive(state, opts);
  return Object.assign({}, state, opts.channel ? { channel: opts.channel } : {}, {
    version: Object.assign({}, state.version || {}, {
      number: d.number, stamped: d.stamped, source: d.source,
      harness: d.harness.commit, agent_skills: d.agent_skills.commit,
    }),
    hold: state.hold || null,
  });
}

// ── el cierre de `install` (story 8.16, AC 8 y 9) ───────────────────────────────────────────────────────────────────
// El caso (auditoría de la copia publicada, 2026-10-03): `install` imprimía «piezas escritas: link, state, …» —los pasos
// del programa, no lo que quedó en la máquina— y de la salida del aplicador sólo iban al registro las últimas tres líneas:
// la persona no veía ni los hooks que le agregaron ni los avisos. Ahora el cierre cuenta lo que quedó, por tipo, desde el
// reporte del aplicador; dice cuántos hooks pueden frenar según la lista de efectos; repite cada aviso del aplicador tal
// cual; y dice dónde quedó la copia de respaldo, cómo volver, dónde está el registro y qué sigue.
const HARNESS_CMD = `node ~/.claude/${require('./place.js').PLACE_NAME}/scripts/setup/harness.js`;   // el lugar (story 8.19)
const WARNING_LINE = /^\s*(⚠|🔴|🛑)/u;
// el instalador de Windows escribe los mismos avisos con «! » y «!! » (no usa los emojis): sin esto, en Windows el
// cierre no repetía ninguno (pase adversarial de la tanda A)
const WARNING_LINE_WINDOWS = /^\s*(⚠|🔴|🛑|!!? )/u;
/**
 * Los avisos de la salida del aplicador, tal cual y sin repetir: cada línea que empieza con la marca (⚠, 🔴 o 🛑; con
 * `windows`, además «! » y «!! ») y los renglones SANGRADOS que la siguen — varios avisos del instalador terminan en
 * «:» y traen en el renglón de abajo el comando o la lista («Activalo con:» sin el comando no es un aviso tal cual).
 */
function warningLines(out, { windows = false } = {}) {
  const mark = windows ? WARNING_LINE_WINDOWS : WARNING_LINE;
  const seen = new Set();
  const L = [];
  let inside = false;
  for (const l of String(out || '').split(/\r?\n/)) {
    if (mark.test(l)) inside = true;
    else if (!(inside && /^\s+\S/.test(l))) { inside = false; continue; }
    if (!seen.has(l)) { seen.add(l); L.push(l); }
  }
  return L;
}

/**
 * Dónde quedó la copia de respaldo y cómo volver. Sin copia (no se pudo tomar: `takeSnapshot` lo anota en el registro)
 * se dice eso y nada más: nunca se promete una carpeta que no existe ni un `.bak` que traiga lo de antes. Medido en el
 * pase adversarial de la tanda A: los `.bak` que quedan en ese caso (el de la línea de arranque y el de las piezas
 * compartidas llevan el mismo sello al segundo, y el segundo pisa al primero) no traen el contenido de antes de
 * instalar, y la línea de import de `CLAUDE.md` no tiene copia propia (`[FUP-8.16-A-bak-sin-copia]`).
 */
function backupLine(dir) {
  if (dir) return `copia de respaldo: ${dir} · volver: ${HARNESS_CMD} rollback --list`;
  return 'copia de respaldo: no se pudo tomar (el registro dice por qué): esta instalación quedó sin copia de cómo estaba la máquina antes';
}

/**
 * Lo que quedó en la máquina, contado por tipo: las líneas de «qué quedó». `pieces` es el reporte del aplicador más las
 * piezas que hizo `harness.js`; `effects`, la lectura de la lista de efectos (`managed.readEffects`): con ella rota no
 * se cuenta ningún freno y se dice por qué — una lista rota no se lee como «nada frena». `thirdParty`: cuántas skills
 * de terceros declara el árbol (o null si no se sabe): las que no están en su lugar son las pendientes.
 */
function leftCounts(pieces, { effects = null, thirdParty = null } = {}) {
  const list = Array.isArray(pieces) ? pieces.filter(isObject) : [];
  const n = (kind) => list.filter((p) => p.kind === kind).length;
  const L = [];
  const hooks = list.filter((p) => p.kind === 'hook');
  if (hooks.length) {
    if (effects && effects.ok) {
      const braking = new Set(effects.effects.filter((e) => e.kind === 'hook' && e.blocks !== 'no').map((e) => e.id));
      const b = hooks.filter((p) => braking.has(p.id)).length;
      L.push(`hooks: ${hooks.length} (${b} ${b === 1 ? 'puede' : 'pueden'} frenar un comando)`);
    } else {
      L.push(`hooks: ${hooks.length} (no pude contar cuántos frenan: ${effects && effects.reason ? effects.reason : 'sin la lista de efectos'})`);
    }
  }
  for (const [kind, label] of [['block', 'bloques en CLAUDE.md'], ['setting', 'ajustes de settings.json'], ['git-hook', 'hooks de git'], ['command', 'comandos'], ['link', 'enlaces']]) {
    if (n(kind)) L.push(`${label}: ${n(kind)}`);
  }
  const placed = n('third-party');
  // con el paso apagado (`thirdParty: 'off'`) el aplicador no reporta ninguna aunque estén en disco, y no va a bajar
  // nada: ni «0 en su lugar» ni «pendientes» serían verdad
  if (thirdParty === 'off') L.push('skills de terceros: el paso está apagado (TYCON_THIRD_PARTY=0): no se bajó ni se contó ninguna');
  else {
    const pending = Number.isInteger(thirdParty) ? Math.max(0, thirdParty - placed) : null;
    if (placed || pending) L.push(`skills de terceros: ${placed} en su lugar${pending === null ? '' : `, ${pending} pendiente${pending === 1 ? '' : 's'}`}`);
  }
  return L;
}

/**
 * Lo que `install` imprime al final, en este orden: versión, canal y política; qué quedó, por tipo; cada aviso del
 * aplicador tal cual; las notas del programa; dónde quedó la copia de respaldo y cómo volver; el registro; y tres líneas
 * de «qué sigue». Una segunda corrida («sin cambios») repite sólo dónde está la copia de antes de instalar.
 */
function installSummary(result = {}) {
  const L = [`versión: ${result.version || '—'}`];
  L.push(`canal: ${result.channel || 'stable'} · aplicación: ${result.apply || 'ask'}`);
  // el perfil de instalación (story 8.16, tanda C · AC 25): «perfil: minimal (--profile)», «perfil: full (sin elegir)»
  if (result.profile) L.push(result.profile);
  // las integraciones y el paquete del stack, cada uno con su origen (story 8.16, tanda D · AC 33)
  if (Array.isArray(result.configLines)) for (const l of result.configLines) L.push(l);
  if (result.changed === false) {
    L.push('sin cambios: ya estaba instalado así');
    if (Array.isArray(result.notes)) for (const n of result.notes) L.push(n);
    if (result.baseline) L.push(`copia de antes de instalar: ${result.baseline} · volver: ${HARNESS_CMD} rollback --list`);
    return L;
  }
  const left = leftCounts(result.pieces, { effects: result.effects, thirdParty: result.thirdParty });
  // un aplicador que no entregó su reporte de piezas (uno viejo, o un reporte inválido): lo contado es sólo lo que hizo
  // el programa, y se dice — un «qué quedó» corto no se lee como «el aplicador no dejó nada»
  // el instalador apagado a propósito (TYCON_NO_AUTOINSTALL=1) sale sin registrar nada y sin reporte: no es «un
  // reporte que falta», y se dice lo que pasó
  if (result.applierOff) left.push(`el instalador está apagado (TYCON_NO_AUTOINSTALL=1): no registró hooks ni bloques; sin esa variable, ${HARNESS_CMD} apply lo corre`);
  else if (result.reported === false) left.push(`el aplicador no entregó su reporte de piezas: falta contar lo que dejó (${HARNESS_CMD} doctor lo muestra)`);
  // un reporte válido y vacío tampoco deja la sección muda
  else if (!left.length) left.push(`el aplicador no reportó ninguna pieza (${HARNESS_CMD} doctor muestra lo que hay)`);
  L.push('qué quedó:');
  for (const l of left) L.push(`  ${l}`);
  for (const w of Array.isArray(result.warnings) ? result.warnings : []) L.push(w);
  if (Array.isArray(result.notes)) for (const n of result.notes) L.push(n);
  L.push(backupLine(result.backup));
  if (result.log) L.push(`registro: ${result.log}`);
  L.push('qué sigue:');
  L.push('  1. abrí una sesión nueva de Claude Code: los hooks y las reglas entran al abrirla');
  L.push(`  2. revisá cómo quedó: ${HARNESS_CMD} doctor`);
  L.push('  3. en el repo de tu producto, creá una story con la skill que las crea y pedí «implementemos la story <ruta>»');
  return L;
}

/**
 * Lo que `install` dice cuando el aplicador o la comprobación de salud fallan (AC 9): qué falló, que la instalación
 * quedó a medias, dónde están el registro y la copia, y las dos salidas. Sin «qué sigue».
 */
function installFailure({ what, log = null, backup = null, warnings = [] } = {}) {
  const L = [`harness.js install: ${what}`];
  for (const w of Array.isArray(warnings) ? warnings : []) L.push(w);
  L.push(`la instalación quedó a medias: el estado está escrito, y ${HARNESS_CMD} doctor lo detalla`);
  if (log) L.push(`registro: ${log}`);
  L.push(backupLine(backup));
  L.push(`dos salidas: ${HARNESS_CMD} install otra vez, o ${HARNESS_CMD} uninstall para sacarlo`);
  return L;
}

/** La línea que `update` suma cuando aplicó una versión (AC 8): dónde quedó la copia de antes y cómo volver. */
function updateBackupLine(dir) {
  return `copia de antes en ${dir} · volver: ${HARNESS_CMD} rollback`;
}

// ── los hooks que ya quedaron repetidos (story 8.18 · decisión del dueño, 2026-10-04: «avisa y no toca») ───────────
// El caso: el ensayo del alta de un dev nuevo (2026-10-03) terminó con 32 hooks registrados DOS veces —el mismo archivo
// por dos rutas: la carpeta del clon y el enlace del lugar del arnés—. El instalador ya no registra uno dos
// veces (reconoce un hook por el archivo real que nombra), pero los que una máquina ya tiene se quedan: sacarlos solo
// cambiaría el `settings.json` de las máquinas del equipo el día del corte. `doctor` lo dice una vez, como dato, y nada
// más: ni toca el archivo ni pone el diagnóstico en rojo. La limpieza, si se hace, es una tarea aparte.
//
// Repetido = el mismo evento, el mismo matcher (sus partes en cualquier orden, como los compara el instalador) y el
// MISMO archivo por su ruta real. El mismo archivo en otro evento o con otro matcher no lo es (varios hooks del arnés
// van en dos o tres eventos a propósito). Sólo cuentan los hooks DEL ARNÉS: los que nombran, entre comillas y con ruta
// absoluta —como los escribe el instalador—, un archivo que vive bajo una de las raíces (`roots`: el árbol y la carpeta
// de las skills). Un hook de la persona repetido es asunto suyo.
//
// «El mismo archivo» es QUÉ ARCHIVO es, no cómo está escrita su ruta (pase adversarial del tramo 3, clase 15 ·
// 2026-10-04). Se comparaba la ruta real letra por letra, y «es del arnés» era un prefijo letra por letra contra las
// raíces: `fs.realpathSync` resuelve enlaces pero no iguala mayúsculas, así que en un disco que no las distingue (el de
// una Mac, el de Windows) la misma carpeta escrita con otra caja (`…/src/harness` por `…/Src/harness`) ni contaba como
// del arnés. Medido: 27 hooks registrados dos veces y doctor callado. La regla, la misma que usa el instalador
// (`file_id` en install-tycon-hooks.sh):
//   1. por identidad de archivo —dispositivo e inodo—; «bajo una raíz» es que alguna carpeta madre ES esa raíz;
//   2. si el disco no da esa identidad, por la ruta real, igualando la caja SÓLO si ese disco no la distingue (se mide:
//      ¿la misma carpeta con la caja cambiada existe?). En un disco que sí la distingue, `a.js` y `A.js` son dos archivos.
// Un archivo que no está en el disco no cuenta (como antes). Dos nombres del mismo archivo (un enlace duro) son uno.
// la ruta real como la escribe el disco (`native` devuelve también la caja de verdad); si el sistema no la da —en
// Windows falla en algunas unidades virtuales—, la de siempre; si la ruta no existe, null
const realOrNull = (p) => {
  if (typeof fs.realpathSync.native === 'function') { try { return fs.realpathSync.native(p); } catch (_) { /* sigue con la de abajo */ } }
  try { return fs.realpathSync(p); } catch (_) { return null; }
};
const matcherKey = (m) => String(m || '').split('|').map((t) => t.trim()).filter(Boolean).sort().join('|');
/** La identidad de lo que hay en esa ruta (`dispositivo:inodo`), o null si no está o el disco no la da. */
const fileIdentity = (p) => {
  try { const st = fs.statSync(p, { bigint: true }); return st.ino ? `${st.dev}:${st.ino}` : null; } catch (_) { return null; }
};
const swapCase = (s) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
/** ¿El disco de esa ruta NO distingue mayúsculas? Se mide en la carpeta existente más cercana cuyo nombre tenga letras. */
function caseBlind(p) {
  for (let d = p; ; d = path.dirname(d)) {
    const name = path.basename(d);
    const other = swapCase(name);
    if (other !== name && fs.existsSync(d)) return fs.existsSync(path.join(path.dirname(d), other));
    if (path.dirname(d) === d) return false;   // sin una letra con qué medir: letra por letra
  }
}
const pathKey = (real) => (caseBlind(real) ? real.toLowerCase() : real);

/**
 * @param {object} settings el settings.json ya leído
 * @param {string[]} roots las raíces del arnés (el árbol y la carpeta de las skills)
 * @param {{identity?: (p: string) => string|null}} [opts] `identity`: cómo se identifica un archivo (por defecto,
 *   dispositivo e inodo); una que devuelve null es un disco que no da identidad: vale la ruta real
 * @returns {Array<{event: string, matcher: string, file: string, count: number}>} los hooks del arnés que están más de una vez
 */
function repeatedHooks(settings, roots = [], { identity = fileIdentity } = {}) {
  const hooks = isObject(settings) && isObject(settings.hooks) ? settings.hooks : {};
  const rootIds = new Set();     // las raíces, por identidad
  const rootPaths = new Set();   // las raíces de un disco sin identidad, por su ruta real (con la caja que diga el disco)
  for (const root of (Array.isArray(roots) ? roots : []).filter(Boolean)) {
    const real = realOrNull(root);
    if (!real) continue;
    const id = identity(real);
    if (id) rootIds.add(id); else rootPaths.add(pathKey(real));
  }
  if (!rootIds.size && !rootPaths.size) return [];
  const dirIds = new Map();
  const dirIdentity = (d) => { if (!dirIds.has(d)) dirIds.set(d, identity(d)); return dirIds.get(d); };
  /** La clave del archivo si es del arnés (está bajo una raíz); null si no. */
  const ownKey = (real) => {
    const id = identity(real);
    if (id && rootIds.size) {
      for (let d = path.dirname(real); ; d = path.dirname(d)) {
        const dirId = dirIdentity(d);
        if (dirId && rootIds.has(dirId)) return id;
        if (path.dirname(d) === d) break;
      }
    }
    if (!rootPaths.size) return null;
    const key = pathKey(real);
    return [...rootPaths].some((r) => key.startsWith(r + path.sep)) ? (id || key) : null;
  };
  const ownFile = (command) => {
    for (const m of String(command).matchAll(/"([^"]+)"/g)) {
      if (!path.isAbsolute(m[1])) continue;
      const file = realOrNull(m[1]);
      const key = file ? ownKey(file) : null;
      if (key) return { file, key };
    }
    return null;
  };
  const seen = new Map();
  for (const event of Object.keys(hooks)) {
    for (const entry of Array.isArray(hooks[event]) ? hooks[event] : []) {
      if (!isObject(entry) || !Array.isArray(entry.hooks)) continue;
      const matcher = matcherKey(entry.matcher);
      for (const h of entry.hooks) {
        const own = isObject(h) && typeof h.command === 'string' ? ownFile(h.command) : null;
        if (!own) continue;
        const key = `${event}\n${matcher}\n${own.key}`;
        const item = seen.get(key) || { event, matcher, file: own.file, count: 0 };
        item.count += 1;
        seen.set(key, item);
      }
    }
  }
  return [...seen.values()].filter((x) => x.count > 1);
}

/** La línea de `doctor` para esos hooks: cuántos, dónde, un ejemplo y cómo sacarlos a mano. */
function repeatedHooksText(repeated, settingsFile) {
  const first = repeated[0];
  const example = `${first.event}${first.matcher ? ` (${first.matcher})` : ''} → ${path.basename(first.file)}, ${first.count} veces`;
  return `hooks repetidos: ${repeated.length} hook(s) del arnés están registrados más de una vez en ${settingsFile} (por ejemplo ${example}). `
    + 'Es un dato, no un error: el instalador ya no repite ninguno, y los que estaban no se sacan solos. '
    + `Para sacarlos a mano: en ese archivo, bajo «hooks», dejá UNA sola entrada por cada evento y archivo — las repetidas nombran el mismo archivo por dos rutas (la carpeta del clon y un nombre del lugar, ~/.claude/${require('./place.js').PLACE_NAME} o ~/.claude/${require('./place.js').LEGACY_PLACE_NAME}, o la misma carpeta escrita con otras mayúsculas); el instalador no la vuelve a agregar`;
}

const MARK = { fail: '✗', warn: '!', ok: '✓' };
/** El diagnóstico en texto: la primera línea es el modo; después cada ítem con su nivel. */
function doctorText(report = {}) {
  const items = Array.isArray(report.items) ? report.items : [];
  const L = [`modo: ${report.mode || 'sin estado'}`];
  for (const level of ['fail', 'warn', 'ok']) {
    for (const it of items.filter((i) => i && i.level === level)) L.push(`  ${MARK[level]} ${it.text}`);
  }
  const fails = items.filter((i) => i && i.level === 'fail').length;
  const warns = items.filter((i) => i && i.level === 'warn').length;
  L.push(fails ? `${fails} en rojo, ${warns} aviso(s)` : (warns ? `${warns} aviso(s), nada en rojo` : 'todo en orden'));
  return L.join('\n');
}
function doctorJson(report = {}) {
  const items = Array.isArray(report.items) ? report.items : [];
  const pick = (level) => items.filter((i) => i && i.level === level).map((i) => i.text);
  // las claves que suma la tanda D de la 8.16 (`profile`, `integrations`, `packs`, `brakes`) van después de las de siempre
  return Object.assign({ mode: report.mode || null, fail: pick('fail'), warn: pick('warn'), ok: pick('ok') }, report.extra || {});
}

// ── la capa privada (story 8.13.1, tanda A · AC 5): el texto y el JSON de lo que midió `layerFacts` (harness.js) ──────
// Acá no se chequea nada: se cuenta y se nombra. Una lista larga se corta en LAYER_NAMED rutas y dice cuántas más hay.
const LAYER_NAMED = 20;
const named = (paths, each) => {
  const L = paths.slice(0, LAYER_NAMED).map(each);
  if (paths.length > LAYER_NAMED) L.push(each(`… y ${paths.length - LAYER_NAMED} más`));
  return L;
};
/** ¿Esa fuente está entera? Compatible, y nada que falte, sobre, esté editado a mano o sea de otro commit. */
function layerSourceWhole(f) {
  return !f.problem && Boolean(f.compat && f.compat.ok) && !f.missing.length && !f.hand.length && !f.stale.length
    && !f.foreign.length && !f.listProblem;
}
/** ¿Toda la capa está entera, y el árbol gestionado (si lo es) no puede empujar? Es lo que `layer --check` contesta. */
function layerWhole(facts) {
  return facts.sources.every(layerSourceWhole) && (!facts.managed || (facts.managed.no_push && facts.managed.pre_push));
}
/** El resumen de una fuente: «capa: N agregados, M pisados (transformados), K a mano[, todo en su lugar]». */
function layerSummary(f) {
  if (!f.addedPaths) return null;
  return `capa: ${f.addedPaths.length} agregados, ${f.overwrittenPaths.length} pisados (transformados), ${f.hand.length} a mano${layerSourceWhole(f) ? ', todo en su lugar' : ''}`;
}
/** Las líneas de `doctor` sobre la capa: `{ level, text }`. Lo que la rompe es rojo; lo que la persona tocó, aviso. */
function layerItems(facts) {
  const items = [];
  const add = (level, text) => items.push({ level, text });
  for (const f of facts.sources) {
    const who = facts.sources.length > 1 ? ` (${f.name})` : '';
    if (f.problem) { add('fail', `capa${who}: ${f.problem}`); continue; }
    if (!f.compat.ok) {
      if (f.compat.problem === 'other-version') {
        const unpublished = f.compat.unpublished || [];
        const changed = f.compat.otherVersion.filter((p) => !unpublished.includes(p));
        const why = [
          changed.length ? `${changed.join(', ')} — el público tiene esas rutas con otro contenido y no están entre los transformados de su version.json` : null,
          unpublished.length ? `${unpublished.join(', ')} — el interno las publica y la copia no las trae` : null,
        ].filter(Boolean).join('; ');
        add('fail', `capa de otra versión${who} (commit ${sha7(f.commit)}): ${why}: esta capa no se usa`);
      } else add('fail', `capa${who}: ${f.compat.reason}`);
    }
    for (const t of named(f.missing, (p) => `capa${who}: falta ${p} (del commit ${sha7(f.commit)})`)) add('fail', t);
    for (const t of named(f.stale, (p) => `capa${who}: ${p} no es el del commit ${sha7(f.commit)} de la capa (lo apiló otra corrida, o no se apiló)`)) add('fail', t);
    for (const t of named(f.hand, (p) => `capa${who}: ${p} editado a mano — la capa no lo pisa ni lo borra`)) add('warn', t);
    for (const t of named(f.foreign, (p) => `${p}: no viene de ninguna fuente (no es de la copia pública, ni de la capa, ni de lo que escribe la máquina)`)) add('warn', t);
    if (f.listProblem) add('warn', `capa${who}: no pude listar lo que hay en el árbol (${f.listProblem}): lo que no viene de ninguna fuente no se miró`);
    const sum = layerSummary(f);
    if (sum) add('ok', `${sum}${who}`);
    if (f.writers) add('ok', `capa${who}: ${f.writers} archivo(s) escritos por la máquina en el árbol (no gestionados: no se comparan)`);
    if (f.minimum) {
      const m = f.minimum;
      if (m.hours === null) add('warn', `capa al mínimo${who}: no sé cuántas horas está detrás de main interno (${m.reason})`);
      else add(m.hours > facts.lagWarnHours ? 'warn' : 'ok', `capa al mínimo${who}: ${m.hours} horas detrás de main interno${m.measured ? '' : ` (lo midió la última actualización; ahora ${m.reason})`}`);
    }
  }
  const M = facts.managed;
  if (M) {
    if (M.no_push) add('ok', `árbol gestionado: pushurl de origin es ${facts.noPush} (no puede empujar)`);
    else add('fail', `árbol gestionado: pushurl de origin es ${M.pushurl ? `«${M.pushurl}»` : '(ninguno)'}, no ${facts.noPush} — un clon del público con lo privado adentro no puede empujar: git -C ${M.tree} remote set-url --push origin ${facts.noPush}`);
    if (M.pre_push) add('ok', `árbol gestionado: el pre-push que frena todo push está (${M.hook})`);
    else add('fail', `árbol gestionado: falta el pre-push que frena todo push (${M.hook || 'git no dijo dónde va'})`);
  }
  return items;
}
/** La clave `layer` de `doctor --json` (y lo que imprime `layer --json`): una entrada por fuente. */
function layerJson(facts, { list = false } = {}) {
  return facts.sources.map((f) => Object.assign({
    name: f.name, commit: f.commit, whole: layerSourceWhole(f), problem: f.problem,
    compatible: f.compat ? f.compat.ok : null, incompatibility: f.compat && !f.compat.ok ? f.compat.problem : null,
    other_version: f.compat ? f.compat.otherVersion : [],
    added: f.addedPaths ? f.addedPaths.length : null, overwritten: f.overwrittenPaths ? f.overwrittenPaths.length : null,
    hand_edited: f.hand, missing: f.missing, stale: f.stale, foreign: f.foreign, writers: f.writers,
    minimum: f.minimum ? { hours: f.minimum.hours, measured: f.minimum.measured, reason: f.minimum.reason } : null,
    managed_tree: facts.managed ? { no_push: facts.managed.no_push, pre_push: facts.managed.pre_push } : null,
  }, list ? { add: f.addedPaths || [], overwrite: f.overwrittenPaths || [] } : {}));
}
/** Lo que imprime `layer` (sin rutas): las mismas líneas que doctor, y con `--list` cada archivo agregado y pisado. */
function layerText(facts, { list = false } = {}) {
  const L = layerItems(facts).map((it) => `${MARK[it.level]} ${it.text}`);
  if (list) {
    for (const f of facts.sources) {
      for (const p of f.addedPaths || []) L.push(`  agregado: ${p}`);
      for (const p of f.overwrittenPaths || []) L.push(`  pisado (transformado): ${p}`);
    }
  }
  return L;
}
/** `layer --json --public … --harness-clone …`: el complemento calculado, con `add` y `overwrite` como listas de rutas. */
function layerComputeJson(r) {
  return Object.assign({}, r, {
    add: r.entries.filter((e) => e.kind === 'add').map((e) => e.path),
    overwrite: r.entries.filter((e) => e.kind === 'overwrite').map((e) => e.path),
  });
}
/** Lo mismo en texto: la cuenta, lo que falla y, con `--list`, cada ruta. */
function layerComputeText(r, { list = false } = {}) {
  const j = layerComputeJson(r);
  const L = [];
  if (!r.ok && r.problem !== 'other-version') L.push(`✗ capa: ${r.reason}`);
  else L.push(`capa: ${j.add.length} agregados, ${j.overwrite.length} pisados (transformados), ${r.same.length} iguales${r.ok ? '' : ' — capa de otra versión'}`);
  for (const p of r.otherVersion) L.push(`  ✗ capa de otra versión: ${p}`);
  for (const p of r.onlyPublic.undeclared) L.push(`  ! sólo en la copia y sin declarar en layer-public-only.json: ${p}`);
  if (list) {
    for (const p of j.add) L.push(`  agregado: ${p}`);
    for (const p of j.overwrite) L.push(`  pisado (transformado): ${p}`);
  }
  return L;
}

/** Una línea con fecha en startup.log; al pasar 1 MB el anterior queda en `.1`. Nunca tira. */
function log(home = os.homedir(), line) {
  const { log: file, harnessDir } = paths(home);
  try {
    fs.mkdirSync(harnessDir, { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch (_) { size = 0; }
    if (size > LOG_MAX_BYTES) {
      try { fs.rmSync(`${file}.1`, { force: true }); } catch (_) { /* no estaba */ }
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${String(line).replace(/\r?\n/g, ' ')}\n`);
  } catch (_) { /* el registro nunca frena nada */ }
  return file;
}

function setNotice(state, text) { state.notice = text ? String(text) : null; return state; }
function clearNotice(state) { state.notice = null; return state; }

// ── «no se pudo actualizar desde» (story 8.23, tanda L, AC 39) ─────────────────────────────────────────────────────
// Un archivo aparte del estado, al lado del candado: lo escribe justamente el arranque que NO pudo actualizar —también
// el que se fue porque otra sesión tenía el candado, que no puede tocar el estado—. Escritura atómica; ilegible = «no sé».
const FAILURE_SAY_FROM = 2;   // desde el segundo arranque fallido: uno solo puede ser un corte de red de un minuto

function readUpdateFailure(home) {
  const file = paths(home).failuresFile;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? null : { unreadable: `${file}: ${e.message}` }; }
  try {
    const f = JSON.parse(raw);
    return f && typeof f.since === 'string' && Number.isInteger(f.count) ? f : { unreadable: `${file}: no tiene el formato esperado` };
  } catch (e) { return { unreadable: `${file}: ${e.message}` }; }
}
// Dos clases (pase adversarial de la tanda L): `busy` (otra sesión tuvo el candado demasiado tiempo) la borra cualquier
// arranque sano que tuvo el candado; `update` (no se pudo mirar o aplicar: sin red, sin credencial, la versión no
// quedó sana) sólo una mirada sana. Si no, un arranque en la ventana sin red —o en modo desarrollador, que nunca mira—
// dejaba un aviso falso para siempre.
const BUSY_FAILURE_MS = 5 * 60 * 1000;
/** ¿Un candado ocupado es una falla? Sólo si el otro lo tiene hace rato: dos sesiones que arrancan juntas no lo son. */
function busyIsFailure({ ageMs }) { return Number.isFinite(ageMs) && ageMs >= BUSY_FAILURE_MS; }
function recordUpdateFailure(home, reason, { now = Date.now(), kind = 'update' } = {}) {
  const file = paths(home).failuresFile;
  const prev = readUpdateFailure(home);
  const at = new Date(now).toISOString();
  // la clase `update` gana: un candado que se soltó no tapa que la red no anda
  const k = prev && !prev.unreadable && prev.kind === 'update' ? 'update' : kind;
  const next = prev && !prev.unreadable
    ? { since: prev.since, count: prev.count + 1, reason: String(reason), last: at, kind: k }
    : { since: at, count: 1, reason: String(reason), last: at, kind };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) { log(home, `startup: no pude anotar que no se pudo actualizar (${e.message}): ${reason}`); }
  return next;
}
/** Borra la falla anotada; con `kind`, sólo si es de esa clase (una de antes, sin clase, cuenta como `update`). */
function clearUpdateFailure(home, { kind = null } = {}) {
  if (kind) { const f = readUpdateFailure(home); if (!f || f.unreadable || (f.kind || 'update') !== kind) return; }
  try { fs.rmSync(paths(home).failuresFile, { force: true }); } catch (e) { log(home, `startup: no pude borrar la falla anotada (${e.message}): el próximo arranque sano lo reintenta`); }
}
/** El aviso, o null si no hay que decir nada todavía. */
function updateFailureText(f) {
  if (!f) return null;
  if (f.unreadable) return `no pude leer desde cuándo el arnés no se actualiza (${f.unreadable}): harness.js doctor lo detalla`;
  if (f.count < FAILURE_SAY_FROM) return null;
  return `no se pudo actualizar desde ${f.since} (${f.count} arranques): ${f.reason} — harness.js doctor lo detalla`;
}

module.exports = {
  LOG_MAX_BYTES, VERSION_FILE, derive, stampedVersion, numberAt, versionLine, versionJson,
  installSummary, installFailure, updateBackupLine, warningLines, leftCounts,
  repeatedHooks, repeatedHooksText, doctorText, doctorJson, log, setNotice, clearNotice,
  readUpdateFailure, recordUpdateFailure, clearUpdateFailure, updateFailureText, busyIsFailure, BUSY_FAILURE_MS,
  layerItems, layerJson, layerWhole, layerText, layerComputeJson, layerComputeText,
};
