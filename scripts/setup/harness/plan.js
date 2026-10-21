'use strict';
/**
 * plan.js — lo que `install` (y `apply --dry-run`) muestra ANTES de escribir.
 *
 * `build()` junta tres cosas: el plan del aplicador (`--check --plan-json`: `[{kind, where, id, action}]`), las piezas
 * que escribe el propio programa (el enlace, el estado, la copia fija, la línea de arranque, el import) y la lista
 * declarada de efectos (`scripts/setup/install-effects.json`). `describe()` lo dice en ocho secciones, con la
 * forma de `describePlan` de uninstall.js:
 *
 *   escribe:                                agrupado por archivo, con cuántos hooks pueden frenar un comando
 *   cambia en cómo trabaja tu asistente:    cada bloque de reglas, el import y cada freno, con su oración `does`
 *   corre solo:                             la línea de arranque y, en una primera instalación, las tareas de fondo
 *   red:                                    a qué sale a preguntar
 *   guarda en disco:                        qué datos deja en tu carpeta mientras trabaja
 *   no toca:                                lo tuyo
 *   copia de respaldo:                      que se toma antes de escribir, y dónde
 *   quita:                                  sólo si algo se va
 *
 * Cada línea dice lo que pasa, no cómo está implementado: ningún nombre de guion ni de hook. Lo que ya estaba (`keep`)
 * no se anuncia como cambio, y una reparación no vuelve a listar las tareas de siempre (ya corrían). Un aplicador que no
 * sabe mostrar su plan lo dice, y entonces «nada que escribir» nunca es verdad.
 *
 * `effectsDiff()` / `describeEffectsDiff()`: la diferencia de comportamiento entre dos listas de efectos, lo que `update`
 * muestra antes de preguntar «¿Aplico ahora?».
 *
 * Datos puros: no lee ni escribe nada.
 */
const path = require('path');

const CHANGE = new Set(['add', 'update']);
const ACTIONS = new Set(['add', 'update', 'remove', 'keep']);
// el orden de las partes dentro de una línea de «escribe:» / «quita:»
const KIND_ORDER = ['hook', 'startup-line', 'pull-line', 'setting', 'block', 'import', 'link', 'file', 'command', 'git-hook', 'third-party', 'launch-agent', 'codex', 'state', 'channel', 'profile', 'config'];
// las piezas que se cuentan por carpeta (muchas, una al lado de la otra)
const BY_DIR = new Set(['file', 'command', 'git-hook', 'third-party']);
const NOTHING_NEW = '  - nada nuevo';
const OLD_APPLIER = 'este aplicador no sabe mostrar su plan: lo que escribe no está en esta lista';
const KEEPS = [
  'tus propios hooks y ajustes de settings.json (salvo lo que «escribe:» nombre)',
  'tu texto de CLAUDE.md fuera de los marcadores del arnés',
  'tus carpetas skills y agents: si ya eran tuyas, enlaza entrada por entrada y no pisa nada',
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const keyOf = (p) => `${p.kind}\u0000${p.where}\u0000${p.id}`;

/** La entrada de la lista de efectos que describe esta pieza (mismo `kind`, y su `id` o su `id_pattern`), o null. */
function effectFor(piece, effects) {
  for (const e of effects || []) {
    if (!e || e.kind !== piece.kind) continue;
    if (typeof e.id === 'string' && e.id === piece.id) return e;
    if (typeof e.id_pattern === 'string') {
      try { if (new RegExp(e.id_pattern).test(String(piece.id))) return e; } catch (_) { /* un patrón roto no describe nada */ }
    }
  }
  return null;
}

/**
 * ¿Aplica en esta máquina una entrada con este `when`? Lo que no se puede saber desde acá cuenta como no. Una
 * integración en `detect` (Codex en el perfil del equipo) la decide la máquina: cuenta como prendida si el plan del
 * aplicador trae piezas de esa integración (`detected`), que es lo que el aplicador resolvió al armarlo.
 */
function applies(when, { env = {}, platform = process.platform, integrations = {}, detected = {} } = {}) {
  if (['always', 'shared', 'harness.js', 'single-repo'].includes(when)) return true;
  const parts = String(when || '').split(/\s*&\s*/);
  return parts.every((w) => {
    let m;
    if ((m = w.match(/^integration:([a-z]+)$/))) return integrations[m[1]] === true || (integrations[m[1]] === 'detect' && detected[m[1]] === true);
    if ((m = w.match(/^optin:([A-Z][A-Z0-9_]*)$/))) return env[m[1]] === '1';
    if ((m = w.match(/^platform:(windows|darwin)$/))) return (m[1] === 'windows' ? 'win32' : 'darwin') === platform;
    return false;   // optin de un plugin, designated-machine: no se sabe desde acá
  });
}

/**
 * El plan: las piezas del aplicador y las propias, sin repetidos (si la misma pieza viene de los dos lados, gana la
 * acción que cambia algo), con lo necesario para describirlo.
 */
function build({ applier = { known: true, pieces: [] }, own = [], effects = [], home = '', env = {}, platform = process.platform,
  integrations = {}, first = false, backupRoot = null, profile = null } = {}) {
  const merged = new Map();
  for (const p of [...((applier && applier.pieces) || []), ...(own || [])]) {
    if (!p || !ACTIONS.has(p.action)) continue;
    const k = keyOf(p);
    const prev = merged.get(k);
    if (!prev || (prev.action === 'keep' && p.action !== 'keep')) merged.set(k, { kind: p.kind, where: p.where, id: p.id, action: p.action });
  }
  return {
    pieces: [...merged.values()],
    applierKnown: Boolean(applier && applier.known),
    effects: Array.isArray(effects) ? effects : [],
    home, env, platform, integrations, first: Boolean(first), backupRoot, profile,
  };
}

/** Nada que escribir: el aplicador supo decir su plan y todo queda como está. */
function nothingToWrite(plan) {
  return Boolean(plan && plan.applierKnown && plan.pieces.every((p) => p.action === 'keep'));
}

function display(plan, p) {
  const home = plan.home ? path.resolve(plan.home) : '';
  const abs = p ? path.resolve(p) : '';
  if (home && (abs === home || abs.startsWith(home + path.sep))) return `~${abs.slice(home.length).split(path.sep).join('/')}`;
  return String(p);
}

function partLabel(kind, list, plan) {
  const n = list.length;
  switch (kind) {
    case 'hook': {
      const brakes = list.filter((p) => { const e = effectFor(p, plan.effects); return e && e.blocks && e.blocks !== 'no'; }).length;
      return `${plural(n, 'hook', 'hooks')}${brakes ? ` (${plural(brakes, 'puede', 'pueden')} frenar un comando)` : ''}`;
    }
    case 'startup-line': return 'la línea de arranque';
    case 'setting': return plural(n, 'ajuste', 'ajustes');
    case 'block': return plural(n, 'bloque de reglas', 'bloques de reglas');
    case 'import': return 'la línea que carga las guías';
    case 'link': return n === 1 ? 'el enlace al clon' : `${n} enlaces al clon`;
    case 'file': return `la copia fija del programa de arranque (${plural(n, 'archivo', 'archivos')})`;
    case 'command': return plural(n, 'comando de barra', 'comandos de barra');
    case 'git-hook': return plural(n, 'hook global de git', 'hooks globales de git');
    case 'third-party': return plural(n, 'skill de terceros', 'skills de terceros');
    case 'launch-agent': return n === 1 ? 'un agente del sistema' : `${n} agentes del sistema`;
    case 'codex': return plural(n, 'pieza de Codex', 'piezas de Codex');
    case 'pull-line': return n === 1 ? 'una línea de arranque con `git pull`, para que no pise cambios locales' : `${n} líneas de arranque con \`git pull\`, para que no pisen cambios locales`;
    case 'state': return 'el estado de la instalación';
    case 'channel': return 'el canal elegido';
    case 'profile': return 'el perfil de instalación elegido';   // `install --profile` lo escribe
    case 'config': return n === 1 ? 'una respuesta de la instalación (integraciones o paquete del stack)' : `${n} respuestas de la instalación (integraciones y paquete del stack)`;
    default: return plural(n, kind, kind);
  }
}

/** Las líneas de «escribe:» o «quita:»: una por archivo (o carpeta), con sus partes en un orden fijo. */
function grouped(plan, pieces) {
  const groups = new Map();
  for (const p of pieces) {
    const where = BY_DIR.has(p.kind) ? path.dirname(p.where) : p.where;
    if (!groups.has(where)) groups.set(where, new Map());
    const byKind = groups.get(where);
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind).push(p);
  }
  const rank = (k) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };
  const out = [];
  for (const [where, byKind] of groups) {
    const kinds = [...byKind.keys()].sort((a, b) => rank(a) - rank(b));
    out.push(`  - ${display(plan, where)}: ${kinds.map((k) => partLabel(k, byKind.get(k), plan)).join(', ')}`);
  }
  return out;
}

const uniq = (xs) => [...new Set(xs.filter(Boolean))];

/** El plan en castellano, en sus ocho secciones (la última, «quita:», sólo si algo se va). */
function describe(plan) {
  const changes = plan.pieces.filter((p) => CHANGE.has(p.action));
  const removes = plan.pieces.filter((p) => p.action === 'remove');
  const withEffect = changes.map((p) => ({ p, e: effectFor(p, plan.effects) })).filter((x) => x.e);
  const ctx = { env: plan.env, platform: plan.platform, integrations: plan.integrations,
    detected: { codex: plan.pieces.some((p) => p.kind === 'codex' && p.action !== 'remove') } };
  // las tareas de fondo del perfil que va a quedar: una de full no
  // se anuncia en un plan de minimal, porque el aplicador de minimal no la lanza
  const inProfile = (e) => !plan.profile || !Array.isArray(e.profiles) || e.profiles.includes(plan.profile);
  const tasks = plan.first ? plan.effects.filter((e) => e && e.kind === 'task' && applies(e.when, ctx) && inProfile(e)) : [];
  const L = [];
  const section = (title, lines) => { L.push(title); L.push(...(lines.length ? lines : [NOTHING_NEW])); };

  const writes = grouped(plan, changes);
  if (!plan.applierKnown) writes.push(`  - ${OLD_APPLIER}`);
  // la carpeta global de hooks de git: sin ella los hooks de git que se instalan no corren, y la pone la
  // instalación si git no tiene ninguna. Es configuración de git de la persona: el plan lo dice antes del «sí»
  const gitHook = changes.find((p) => p.kind === 'git-hook');
  if (gitHook && !(plan.env && plan.env.TYCON_NO_GIT_HOOKS === '1')) {
    writes.push(`  - la carpeta global de hooks de git (core.hooksPath → ${display(plan, path.dirname(gitHook.where))}), sólo si git no tiene ninguna: con ella git corre los hooks del arnés en todos tus repos, en lugar del .git/hooks/ de cada uno. Si ya tenés una, no la toca`);
  }
  section('escribe:', writes);
  section('cambia en cómo trabaja tu asistente:', uniq(withEffect
    .filter(({ p, e }) => p.kind === 'block' || p.kind === 'import' || (p.kind === 'hook' && e.blocks && e.blocks !== 'no'))
    .map(({ e }) => e.does)).map((d) => `  - ${d}`));
  section('corre solo:', uniq([
    ...withEffect.filter(({ p }) => p.kind === 'startup-line').map(({ e }) => e.does),
    ...tasks.map((e) => e.does),
  ]).map((d) => `  - ${d}`));
  section('red:', uniq([...withEffect.map(({ e }) => e.network), ...tasks.map((e) => e.network)]).map((d) => `  - ${d}`));
  section('guarda en disco:', uniq([
    ...withEffect.filter(({ p }) => p.kind === 'hook').map(({ e }) => e.stores),
    ...tasks.map((e) => e.stores),
  ]).map((d) => `  - ${d}`));
  section('no toca:', KEEPS.map((k) => `  - ${k}`));
  section('copia de respaldo:', [`  - se toma antes de escribir, de todo lo que cambia, en ${plan.backupRoot ? `${display(plan, plan.backupRoot)}/` : 'la carpeta de copias del arnés'}`]);
  if (removes.length) section('quita:', grouped(plan, removes));
  return L;
}

// ── la diferencia de comportamiento entre dos listas de efectos (lo que `update` muestra antes de preguntar) ──────────
const effectKey = (e) => `${e.kind}\u0000${e.id || e.id_pattern}`;

function effectsDiff(before = [], after = []) {
  const b = new Map((before || []).filter(Boolean).map((e) => [effectKey(e), e]));
  const a = new Map((after || []).filter(Boolean).map((e) => [effectKey(e), e]));
  const added = [...a.keys()].filter((k) => !b.has(k)).map((k) => a.get(k));
  const removed = [...b.keys()].filter((k) => !a.has(k)).map((k) => b.get(k));
  const blocksChanged = [...a.keys()].filter((k) => b.has(k) && b.get(k).blocks !== a.get(k).blocks)
    .map((k) => ({ effect: a.get(k), from: b.get(k).blocks, to: a.get(k).blocks }));
  return { added, removed, blocksChanged };
}

function describeEffectsDiff(d) {
  if (!d || (!d.added.length && !d.removed.length && !d.blocksChanged.length)) return ['qué cambia en el comportamiento: nada (la lista de efectos es la misma)'];
  const L = ['qué cambia en el comportamiento:'];
  for (const e of d.added) L.push(`  + entra: ${e.does}`);
  for (const e of d.removed) L.push(`  - sale: ${e.does}`);
  for (const x of d.blocksChanged) {
    const verb = x.to === 'no' ? 'deja de frenar' : (x.from === 'no' ? 'ahora puede frenar' : 'cambia cuándo frena');
    L.push(`  ~ ${verb}: ${x.effect.does}`);
  }
  return L;
}

module.exports = { OLD_APPLIER, ACTIONS, effectFor, applies, build, nothingToWrite, describe, effectsDiff, describeEffectsDiff };
