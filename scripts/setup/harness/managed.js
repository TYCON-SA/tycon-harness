'use strict';
// managed.js — el registro de lo que el arnés instaló en la máquina: `managed` en harness-state.json (story 8.13, tanda B,
// AC 15-16).
//
// De dónde sale: el aplicador (`install-tycon-hooks.sh` / `.ps1`) corrido con `--report-json <archivo>` escribe un arreglo
// `[{ kind, where, id }]` con cada pieza registrable que dejó en la máquina —la que escribió y la que ya estaba y es suya—;
// `harness.js` le suma las que escribe él (el `@import` de CLAUDE.md, la línea de arranque y los tres archivos de la copia
// fija): esas no las repone `apply` sino `install`, y nunca se caen del registro. La lista declarada de qué cuenta y qué
// no, con el motivo de cada exclusión: scripts/tests/fixtures/harness-managed-pieces.json.
//
// «Sin registrar» mira sólo los hooks que el aplicador del árbol conoce (su lista canónica): un hook del árbol que
// registró otro instalador opcional no es del aplicador, y `apply` nunca lo registraría.
//
// Las tres reglas:
//   · `managed` es la UNIÓN de los reportes. Cada pieza conserva la `version` de la primera corrida que la reportó: es la
//     que la vuelta atrás (tanda C) deshace.
//   · Una pieza registrada que, después de una corrida EXITOSA del aplicador, ya no está en la máquina se cae del registro:
//     la sacó el aplicador (una integración apagada, un hook retirado). Si quedara, `doctor` pediría `apply` por algo que
//     `apply` ya no repone. Una corrida fallida no se funde.
//   · `doctor` es de sólo lectura: `present` y `unregistered` miran archivos y nunca escriben.
//
// Funciones puras respecto del HOME: reciben `home`/`env`. Núcleo público: no lee el perfil ni el mapa de renombres.

const fs = require('fs');
const os = require('os');
const path = require('path');
const PD = require('./plugin-dirs.js');   // story 7.27
const RP = require('./read-permissions.js');

const KINDS = ['hook', 'setting', 'block', 'import', 'startup-line', 'link', 'command', 'git-hook', 'launch-agent', 'codex', 'third-party', 'file'];
const EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop', 'SubagentStop', 'UserPromptSubmit', 'Notification', 'PreCompact'];
const BLOCK_RE = /<!--\s*TYCON_BLOCK:([^\s>]+)\s+START/g;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const key = (p) => `${p.kind}\u0000${p.where}\u0000${p.id}`;
const settingsPath = (home, env) => env.TYCON_SETTINGS_PATH || path.join(home, '.claude', 'settings.json');
const claudeMdPath = (home, env) => env.CLAUDE_MD_PATH || path.join(home, '.claude', 'CLAUDE.md');
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } };
const readJson = (file) => { const t = readText(file); if (t === null) return null; try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch (_) { return null; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };   // sigue enlaces, como `-d`

/** Valida y normaliza un reporte del aplicador: `{ ok, pieces, reason }`. Nunca tira. */
function parseReport(text) {
  let list;
  try { list = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch (e) { return { ok: false, pieces: [], reason: `reporte ilegible (${e.message})` }; }
  if (!Array.isArray(list)) return { ok: false, pieces: [], reason: 'el reporte tiene que ser un arreglo JSON' };
  const seen = new Set();
  const pieces = [];
  for (const p of list) {
    if (!isObject(p) || !KINDS.includes(p.kind) || typeof p.where !== 'string' || !p.where || typeof p.id !== 'string' || !p.id) {
      return { ok: false, pieces: [], reason: `pieza inválida en el reporte: ${JSON.stringify(p)}` };
    }
    const piece = { kind: p.kind, where: p.where, id: p.id };
    if ('value' in p) piece.value = p.value;   // un `setting`: el valor que puso el arnés (si el dev lo cambia, deja de ser suyo)
    if (!seen.has(key(piece))) { seen.add(key(piece)); pieces.push(piece); }
  }
  return { ok: true, pieces, reason: null };
}

/** El evento y la ruta de un id de hook: `"<EVENTO>:<ruta de la spec>"` o sólo la ruta (el aplicador de laboratorio). */
function hookId(id) {
  const i = id.indexOf(':');
  if (i > 0 && EVENTS.includes(id.slice(0, i))) return { event: id.slice(0, i), relpath: id.slice(i + 1) };
  return { event: null, relpath: id };
}
/** Lo que tiene que aparecer en el `command` de un hook: `@tcg:x.js` vive en scripts/hooks/ del árbol; lo demás en agent-skills. */
function hookNeedle(relpath) {
  return relpath.startsWith('@tcg:') ? `/scripts/hooks/${relpath.slice(5)}` : `/${relpath.replace(/^\/+/, '')}`;
}

/** Barras normales: el `.ps1` escribe los commands con `/` y las rutas de Windows vienen con `\` (pase adversarial). */
const slash = (s) => String(s).replace(/\\/g, '/');

/** Los `command` de settings.json, por evento: `[{ event, command }]` (con barras normales). */
function settingsCommands(settings) {
  const out = [];
  const hooks = isObject(settings) && isObject(settings.hooks) ? settings.hooks : {};
  for (const [event, blocks] of Object.entries(hooks)) {
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) for (const h of (isObject(b) && Array.isArray(b.hooks) ? b.hooks : [])) {
      if (isObject(h) && typeof h.command === 'string') out.push({ event, command: slash(h.command) });
    }
  }
  return out;
}

const SPEC_RE = new RegExp(`"((?:${EVENTS.join('|')})\\|[^"\\n]*)"`, 'g');
const PATH_TOKEN = /^(@tcg:[\w.-]+|[\w.-]+(?:\/[\w.-]+)+\.(?:js|sh|py|mjs|cjs))$/;
/**
 * Los hooks que el aplicador del árbol conoce —su lista canónica y sus opt-in, escritos como
 * `"EVENTO|matcher|ruta|etiqueta"`—: `[{ event, relpath, needle }]`, o `null` si no se puede leer. Es la frontera de
 * «del arnés»: un hook del árbol que registró otro instalador opcional (CodeGraph, instinct-mining…) no es del aplicador,
 * y `apply` nunca lo registraría (pase adversarial, iteración 2).
 */
function applierHooks(tree) {
  if (!tree) return null;
  const listed = hooksListRows(tree, () => true);
  if (listed !== undefined) return listed;
  const text = readText(path.join(tree, 'scripts', 'install-tycon-hooks.sh'));
  if (text === null) return null;
  const out = [];
  const seen = new Map();
  let m;
  SPEC_RE.lastIndex = 0;
  while ((m = SPEC_RE.exec(text))) {
    const parts = m[1].split('|');
    const at = parts.findIndex((t, i) => i > 0 && PATH_TOKEN.test(t));
    if (at < 0) continue;
    const relpath = parts[at];
    // el matcher es lo que hay entre el evento y la ruta (puede traer `|`: «Edit|Write»)
    addRow(out, seen, parts[0], relpath, parts.slice(1, at).join('|'));
  }
  return out.length ? out : null;
}
/**
 * La lista única de hooks (story 8.17, tanda W3): `scripts/setup/hooks-list.json` del árbol, la que leen los dos
 * aplicadores. Devuelve las filas (con la forma de `applierHooks`) de los registros que `keep` acepta; `null` si la
 * lista está pero no se puede leer (rota no es «no hay hooks»); `undefined` si el árbol no la trae — un clon de antes
 * de la W3 (una versión vuelta atrás): ahí la lista sigue en el texto de cada instalador y se lee de ahí, como antes.
 */
function hooksListRows(tree, keep) {
  const file = path.join(tree, 'scripts', 'setup', 'hooks-list.json');
  if (!fs.existsSync(file)) return undefined;
  const doc = readJson(file);
  if (!isObject(doc) || !Array.isArray(doc.hooks)) return null;
  const out = [];
  const seen = new Map();
  for (const h of doc.hooks) {
    if (!isObject(h) || !EVENTS.includes(h.event) || typeof h.spec !== 'string' || !keep(h)) continue;
    addRow(out, seen, h.event, h.spec, typeof h.matcher === 'string' ? h.matcher : '');
  }
  return out.length ? out : null;
}
/** Una fila de una lista de aplicador: un par evento+guion por entrada (lo que esperan `unregistered` y quien ya usaba
 *  estas listas), con TODOS sus matchers en `matchers` (B5: dos filas del mismo guion y evento con distinto matcher son
 *  dos controles). Devuelve true si el par ya estaba. */
function addRow(out, seen, event, relpath, matcher) {
  const k = `${event}:${relpath}`;
  const had = seen.get(k);
  if (had) { if (!had.matchers.some((x) => sameMatcher(x, matcher))) had.matchers.push(matcher); return true; }
  const row = { event, relpath, needle: hookNeedle(relpath), matcher, matchers: [matcher] };
  seen.set(k, row);
  out.push(row);
  return false;
}
/** El matcher, como conjunto: «Edit|Write» = «Write|Edit»; vacío y `*` son «todos» (como Matchers-Equal del .ps1). */
const normMatcher = (m) => String(m == null ? '' : m).split(/[|,]/).map((x) => x.trim()).filter((x) => x && x !== '*').sort().join('|');
const sameMatcher = (a, b) => normMatcher(a) === normMatcher(b);

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) { if (!isObject(cur) || !(part in cur)) return undefined; cur = cur[part]; }
  return cur;
}

/**
 * ¿La pieza está en la máquina? `true` | `false` | `null` (no sé mirarla).
 * `ctx` = `{ home, env, isStartupLine }` (`isStartupLine(command)`: la línea de arranque nueva, de startup-line.js).
 */
function present(piece, { home = os.homedir(), env = process.env, isStartupLine = null, cache = {} } = {}) {
  const json = (file) => (file in cache ? cache[file] : (cache[file] = readJson(file)));
  const text = (file) => (`t:${file}` in cache ? cache[`t:${file}`] : (cache[`t:${file}`] = readText(file)));
  switch (piece.kind) {
    case 'hook': {
      const s = json(piece.where);
      if (!s) return false;
      const { event, relpath } = hookId(piece.id);
      const needle = hookNeedle(relpath);
      return settingsCommands(s).some((c) => (!event || c.event === event) && c.command.includes(needle));
    }
    case 'setting': {
      const s = json(piece.where);
      // una regla de lectura del arnés es un elemento de permissions.allow, que también tiene las del dev
      if (RP.isRuleId(piece.id)) return Boolean(s) && RP.hasRule(s, RP.ruleOf(piece.id));
      const v = s ? getPath(s, piece.id) : undefined;
      if (v === undefined) return false;
      // la carpeta de los mods (story 7.27) es un elemento de una lista que también tiene las carpetas del dev
      if (piece.id === PD.PLUGIN_DIRS_ID) return PD.hasDir(v, piece.value, { home });
      // con el valor que puso el arnés: si el dev lo cambió, el ajuste es suyo (el aplicador tampoco lo reporta)
      return 'value' in piece ? JSON.stringify(v) === JSON.stringify(piece.value) : true;
    }
    case 'block': {
      const t = text(piece.where);
      const name = piece.id.replace(/^TYCON_BLOCK:/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // con su cierre: un bloque sin marcador de cierre el sync no lo toca ni lo reporta — no está en su lugar
      return t !== null && new RegExp(`<!--\\s*TYCON_BLOCK:${name}\\s+START[\\s\\S]*?<!--\\s*TYCON_BLOCK:${name}\\s+END`).test(t);
    }
    case 'import': {
      // con cualquiera de sus formas — los dos nombres del lugar (story 8.19, AC 20) y el README.md que era el índice
      // hasta que pasó a INDEX.md: una vuelta atrás deja la línea vieja y la pieza con el id nuevo, y la línea está
      const forms = require('./import-line.js').ALL_FORMS;
      const ids = forms.includes(piece.id) ? forms : [piece.id];
      const t = text(piece.where);
      return t !== null && t.split('\n').some((l) => ids.includes(l.trim()));
    }
    case 'startup-line': {
      const s = json(piece.where);
      if (!s || !isStartupLine) return s ? null : false;
      return settingsCommands(s).some((c) => c.event === 'SessionStart' && isStartupLine(c.command));
    }
    case 'link': case 'command': case 'git-hook': case 'launch-agent': case 'codex': case 'third-party': case 'file':
      return exists(piece.where);
    default:
      return null;
  }
}

/**
 * La unión: lo previo más lo nuevo; lo que ya estaba conserva su `version`; lo nuevo toma `version`. Con `present`, una
 * pieza previa que no vino en el reporte y ya no está en la máquina se cae (la sacó el aplicador).
 */
function merge(prev, reported, { version, present: isPresent = null } = {}) {
  const out = [];
  const byKey = new Map();
  for (const p of Array.isArray(prev) ? prev : []) if (isObject(p) && p.kind && p.where && p.id) byKey.set(key(p), p);
  const now = new Set();
  for (const p of reported) {
    now.add(key(p));
    const old = byKey.get(key(p));
    // la pieza entera del reporte (con el `value` de un ajuste: sin él, el estado no sabe qué valor puso el arnés)
    out.push(Object.assign({}, p, { version: (old && old.version) || version || null }));
  }
  for (const [k, p] of byKey) {
    if (now.has(k)) continue;
    if (isPresent && isPresent(p) === false) continue;   // la sacó el aplicador
    out.push(p);
  }
  return out;
}

/** Las piezas registradas que faltan en la máquina (las que `present` dice `false`). */
function missing(managed, opts = {}) {
  const cache = {};
  return (Array.isArray(managed) ? managed : []).filter((p) => present(p, Object.assign({ cache }, opts)) === false);
}

/**
 * Lo del arnés que está en la máquina y no está en el registro: hooks de settings.json que invocan algo del árbol
 * (`roots`: el árbol real, el enlace, agent-skills) y bloques `TYCON_BLOCK` de CLAUDE.md. La línea de arranque no cuenta
 * acá (es su propia pieza: `startup-line`). Devuelve `[{ kind, where, id, text }]`.
 */
function unregistered(managed, { home = os.homedir(), env = process.env, roots = [], tree = null, isStartupLine = null } = {}) {
  const list = Array.isArray(managed) ? managed : [];
  const out = [];
  const sp = settingsPath(home, env);
  const s = readJson(sp);
  const hooks = list.filter((p) => p.kind === 'hook').map((p) => Object.assign(hookId(p.id), { needle: hookNeedle(hookId(p.id).relpath) }));
  const covered = (event, command) => hooks.some((h) => (!h.event || h.event === event) && command.includes(h.needle));
  const known = applierHooks(tree);
  const realRoots = roots.filter(Boolean).map((r) => slash(r).replace(/\/+$/, ''));
  for (const c of settingsCommands(s)) {
    if (isStartupLine && c.event === 'SessionStart' && isStartupLine(c.command)) continue;
    if (/(^|[;&|]\s*)(cd|git)\s/.test(c.command) && /git\s+(-C\s+\S+\s+)?pull/.test(c.command)) continue;   // una línea de arranque vieja: la migra startup
    if (known) {
      // sólo lo que el aplicador conoce es «del arnés» para `apply` (lo demás del árbol lo registró otro instalador)
      const spec = known.find((k) => c.command.includes(k.needle));
      if (!spec || covered(c.event, c.command)) continue;
      out.push({ kind: 'hook', where: sp, id: `${c.event}:${spec.relpath}`, text: `hook ${c.event} ${spec.relpath}` });
      continue;
    }
    // sin la lista del aplicador (un árbol sin install-tycon-hooks.sh legible): todo hook que invoca algo de las raíces
    const root = realRoots.find((r) => c.command.includes(`${r}/`));
    if (!root || covered(c.event, c.command)) continue;
    const m = c.command.match(new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^"'\\s]+)`));
    out.push({ kind: 'hook', where: sp, id: `${c.event}:${m ? m[1] : c.command}`, text: `hook ${c.event} ${m ? m[1] : c.command}` });
  }
  const cp = claudeMdPath(home, env);
  const t = readText(cp);
  if (t !== null) {
    const blocks = new Set(list.filter((p) => p.kind === 'block' && p.where === cp).map((p) => p.id.replace(/^TYCON_BLOCK:/, '')));
    let m;
    BLOCK_RE.lastIndex = 0;
    while ((m = BLOCK_RE.exec(t))) if (!blocks.has(m[1])) out.push({ kind: 'block', where: cp, id: `TYCON_BLOCK:${m[1]}`, text: `bloque TYCON_BLOCK:${m[1]} en ${cp}` });
  }
  return out;
}

/** Una línea por pieza, para los mensajes de doctor. */
function describe(p) {
  if (p.kind === 'hook') { const h = hookId(p.id); return `hook ${h.event ? `${h.event} ` : ''}${h.relpath}`; }
  if (p.kind === 'setting') return `ajuste ${p.id} de ${p.where}`;
  return `${p.kind} ${p.id} (${p.where})`;
}

// ── la lista de efectos (story 8.16, AC 4) ──────────────────────────────────────────────────────────────────────────
// `scripts/setup/install-effects.json` es LA lista declarada de lo que la instalación cambia en la máquina y en cómo
// trabaja el asistente: la leen la portada (por su prueba), el cierre de `install` y, desde la tanda B, el plan. Acá vive
// su lector y su validación; el cruce con el instalador (una pieza sin entrada, una entrada sin pieza) es de su prueba,
// scripts/tests/install-effects.test.js. Una lista que falta, ilegible o inválida NO se lee como «no cambia nada»:
// `readEffects` devuelve `ok: false` con el archivo y el motivo, y quien la usa lo dice.
const EFFECTS_FILE = path.join('scripts', 'setup', 'install-effects.json');
const EFFECT_KINDS = [...KINDS, 'task'];
const EFFECT_KEYS = ['id', 'id_pattern', 'kind', 'title', 'group', 'default', 'site_section', 'site_pending', 'does', 'blocks', 'when', 'switch', 'network', 'stores', 'windows', 'front_page', 'profiles', 'source', 'en'];
// el inglés de cada pieza, para el sitio en inglés: la terminal sigue leyendo `title`, `does` y `switch`
const EFFECT_EN_KEYS = ['title', 'does', 'switch'];
// la variable de un interruptor: lo que va antes del primer espacio («TYCON_SESSION_GUARD=1 lo prende»)
const switchVariable = (s) => String(s).trim().split(' ')[0];
// cómo la muestra el sitio: un título corto, el grupo donde va, si viene prendida o apagada, la sección de Configuración
// donde la organización la cambia (`site_section`) o la pestaña donde debería poder cambiarla y todavía no (`site_pending`)
const EFFECT_GROUPS = ['safety', 'assistant', 'notices', 'memory', 'time', 'install', 'pipeline', 'codex'];
const EFFECT_DEFAULTS = ['on', 'off'];
const TITLE_MAX = 70;
// en qué perfil de instalación existe cada pieza (story 8.16, tanda C · AC 22): todo lo de `minimal` está en `full`
const PROFILES = ['minimal', 'full'];
// dónde frena: en ningún lado, en cualquier repo, sólo en un repo bajo el arnés, o sólo con el pipeline en modo autónomo
const EFFECT_BLOCKS = ['no', 'any-repo', 'harness-repos', 'autonomous-only'];
// cuándo existe la pieza: el vocabulario de scripts/tests/fixtures/harness-managed-pieces.json
const EFFECT_WHEN = /^(always|shared|single-repo|legacy-place|harness\.js|integration:[a-z]+|optin:[A-Za-z][A-Za-z_-]*|platform:(windows|darwin)( & (optin:[A-Z_]+|designated-machine))?)$/;
// las llaves de integración que existen (las de scripts/lib/tycon-config.js): una mal escrita o vieja da rojo, no pasa
const EFFECT_INTEGRATIONS = ['ado', 'telegram', 'clockify', 'engram', 'codegraph', 'mailbox', 'codex', 'nightly'];
const textOrNull = (v) => v === null || (typeof v === 'string' && v.trim().length > 0);

/** Las reglas que la lista rompe, cada una nombrando la entrada. Vacío = cumple. Nunca tira. */
function effectProblems(doc) {
  if (!isObject(doc) || !Array.isArray(doc.effects)) return ['la lista tiene que ser un objeto con un arreglo «effects»'];
  // una lista vacía es una lista rota: con ella el cierre diría «0 pueden frenar» con los frenos instalados
  if (!doc.effects.length) return ['la lista está vacía: sin entradas no dice qué cambia la instalación'];
  const out = [];
  const seen = new Set();
  doc.effects.forEach((e, i) => {
    if (!isObject(e)) { out.push(`effects[${i}]: no es una entrada`); return; }
    const name = e.id || e.id_pattern || `effects[${i}]`;
    for (const k of Object.keys(e)) if (!EFFECT_KEYS.includes(k)) out.push(`${name}: «${k}» no es un campo de la lista`);
    const hasId = typeof e.id === 'string' && e.id.length > 0;
    const hasPattern = typeof e.id_pattern === 'string' && e.id_pattern.length > 0;
    if (hasId === hasPattern) out.push(`${name}: lleva «id» o «id_pattern» (uno de los dos)`);
    if (hasPattern) { try { new RegExp(e.id_pattern); } catch (_) { out.push(`${name}: «id_pattern» no es una expresión regular`); } }
    if (!EFFECT_KINDS.includes(e.kind)) out.push(`${name}: kind vale ${JSON.stringify(e.kind)} y sólo puede ser ${EFFECT_KINDS.join(', ')}`);
    if (typeof e.does !== 'string' || !e.does.trim()) out.push(`${name}: falta «does» (una oración: qué cambia para la persona)`);
    if (typeof e.title !== 'string' || !e.title.trim() || e.title.length > TITLE_MAX) out.push(`${name}: falta «title» (qué hace, en una línea de hasta ${TITLE_MAX} caracteres)`);
    if (!EFFECT_GROUPS.includes(e.group)) out.push(`${name}: group vale ${JSON.stringify(e.group)} y sólo puede ser ${EFFECT_GROUPS.join(', ')}`);
    if (!EFFECT_DEFAULTS.includes(e.default)) out.push(`${name}: default vale ${JSON.stringify(e.default)} y sólo puede ser on u off (si viene prendida o apagada)`);
    for (const k of ['site_section', 'site_pending']) if (k in e && !(typeof e[k] === 'string' && /^[a-z]+$/.test(e[k]))) out.push(`${name}: «${k}», si está, es el identificador de una sección o una pestaña del sitio`);
    if ('site_section' in e && 'site_pending' in e) out.push(`${name}: o se cambia en una sección del sitio (site_section) o todavía no (site_pending), no las dos`);
    if (!EFFECT_BLOCKS.includes(e.blocks)) out.push(`${name}: blocks vale ${JSON.stringify(e.blocks)} y sólo puede ser ${EFFECT_BLOCKS.join(', ')}`);
    if (typeof e.when !== 'string' || !EFFECT_WHEN.test(e.when)) out.push(`${name}: when vale ${JSON.stringify(e.when)} y no es del vocabulario (always, integration:<llave>, optin:<VARIABLE>…)`);
    for (const k of ['switch', 'network', 'stores']) if (!textOrNull(e[k])) out.push(`${name}: «${k}» es un texto o null`);
    for (const k of ['windows', 'front_page']) if (typeof e[k] !== 'boolean') out.push(`${name}: «${k}» es true o false`);
    if (!Array.isArray(e.profiles) || !e.profiles.length || e.profiles.some((x) => !PROFILES.includes(x)) || !e.profiles.includes('full') || new Set(e.profiles).size !== e.profiles.length) {
      out.push(`${name}: «profiles» es ["minimal", "full"] o ["full"] (todo lo de minimal está en full), no ${JSON.stringify(e.profiles)}`);
    }
    const integration = typeof e.when === 'string' ? (e.when.match(/^integration:([a-z]+)$/) || [])[1] : null;
    if (integration && !EFFECT_INTEGRATIONS.includes(integration)) out.push(`${name}: when nombra la integración «${integration}», que no existe (${EFFECT_INTEGRATIONS.join(', ')})`);
    // un hook va siempre por su `id`: el cierre de install cuenta los frenos comparando con el id del reporte de piezas
    if (e.kind === 'hook' && !hasId) out.push(`${name}: un hook lleva «id», no «id_pattern» (el conteo de frenos lo busca por su id)`);
    if (e.kind === 'hook' && hasId && !hookId(e.id).event) out.push(`${name}: el id de un hook es «<EVENTO>:<ruta de su spec>»`);
    if (e.kind === 'task' && !(isObject(e.source) && typeof e.source.file === 'string' && e.source.file && typeof e.source.pattern === 'string' && e.source.pattern)) {
      out.push(`${name}: una tarea lleva «source» con «file» y «pattern» (dónde está lo que corre)`);
    }
    // `en`, si está: el título y el detalle en inglés, y la frase del interruptor sólo cuando el interruptor trae una.
    // Que falte no es un problema acá (esta validación corre también en el instalador): lo frena la prueba de la lista,
    // scripts/tests/install-effects.test.js
    if ('en' in e) {
      if (!isObject(e.en)) out.push(`${name}: «en» es un objeto con «title» y «does» en inglés`);
      else {
        for (const k of Object.keys(e.en)) if (!EFFECT_EN_KEYS.includes(k)) out.push(`${name}: «en.${k}» no es un campo de en (${EFFECT_EN_KEYS.join(', ')})`);
        if (typeof e.en.title !== 'string' || !e.en.title.trim() || e.en.title.length > TITLE_MAX) out.push(`${name}: falta «en.title» (el título en inglés, hasta ${TITLE_MAX} caracteres)`);
        if (typeof e.en.does !== 'string' || !e.en.does.trim()) out.push(`${name}: falta «en.does» (el detalle en inglés)`);
        const conFrase = typeof e.switch === 'string' && e.switch.trim() !== switchVariable(e.switch);
        if ('switch' in e.en && !conFrase) out.push(`${name}: «en.switch» va sólo cuando «switch» trae una frase además de la variable`);
        if (conFrase && !('switch' in e.en)) out.push(`${name}: falta «en.switch» (la frase del interruptor en inglés)`);
        if ('switch' in e.en && conFrase && !(typeof e.en.switch === 'string' && switchVariable(e.en.switch) === switchVariable(e.switch) && e.en.switch.trim() !== switchVariable(e.switch))) {
          out.push(`${name}: «en.switch» empieza con la misma variable que «switch» (${switchVariable(e.switch)}) y sigue con la frase`);
        }
      }
    }
    if (isObject(e.source) && 'ps1_pattern' in e.source && !(typeof e.source.ps1_pattern === 'string' && e.source.ps1_pattern)) {
      out.push(`${name}: «source.ps1_pattern», si está, es el texto que la nombra en el instalador de Windows`);
    }
    const k = `${e.kind}\u0000${name}`;
    if (seen.has(k)) out.push(`${name}: está dos veces`);
    seen.add(k);
  });
  out.push(...integrationProblems(doc.integrations));
  return out;
}

// Las integraciones que `install` ofrece en su pregunta (story 8.16, tanda D · AC 31): `integrations` es opcional (una
// lista de antes de la tanda D no la trae, y entonces no se ofrece ninguna); si está, nombra las ocho llaves una vez cada
// una. Una ofrecida (`offered: true`) dice qué hace y qué pide tener instalado; una que no se ofrece dice por qué (`why`)
// y, si se prende con un dato, cómo (`how`).
const INTEGRATION_KEYS = ['key', 'offered', 'does', 'needs', 'why', 'how'];
function integrationProblems(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['«integrations» es un arreglo'];
  const out = [];
  const seen = new Set();
  list.forEach((x, i) => {
    const name = isObject(x) && typeof x.key === 'string' ? `integrations.${x.key}` : `integrations[${i}]`;
    if (!isObject(x)) { out.push(`${name}: no es una entrada`); return; }
    for (const k of Object.keys(x)) if (!INTEGRATION_KEYS.includes(k)) out.push(`${name}: «${k}» no es un campo de una integración`);
    if (!EFFECT_INTEGRATIONS.includes(x.key)) out.push(`${name}: no es una integración que exista (${EFFECT_INTEGRATIONS.join(', ')})`);
    if (seen.has(x.key)) out.push(`${name}: está dos veces`);
    seen.add(x.key);
    if (typeof x.offered !== 'boolean') out.push(`${name}: «offered» es true o false`);
    const text = (k) => typeof x[k] === 'string' && x[k].trim().length > 0;
    if (x.offered === true && !(text('does') && text('needs'))) out.push(`${name}: una integración ofrecida dice qué hace («does») y qué pide («needs»)`);
    if (x.offered === false && !text('why')) out.push(`${name}: una integración que no se ofrece dice por qué («why»)`);
  });
  const missing = EFFECT_INTEGRATIONS.filter((k) => !seen.has(k));
  if (list.length && missing.length) out.push(`integrations: faltan ${missing.join(', ')} (la lista nombra las ocho)`);
  return out;
}

/** Las integraciones de la lista de efectos, tal cual (o [] si la lista no las trae). */
function readIntegrations(tree) {
  const file = path.join(tree || '', EFFECTS_FILE);
  const text = tree ? readText(file) : null;
  if (text === null) return [];
  try { const doc = JSON.parse(text.replace(/^﻿/, '')); return Array.isArray(doc.integrations) ? doc.integrations : []; } catch (_) { return []; }
}

/** La lista de efectos del árbol: `{ ok, effects, file, reason }`. Nunca tira. */
function readEffects(tree) {
  const file = path.join(tree || '', EFFECTS_FILE);
  const text = tree ? readText(file) : null;
  if (text === null) return { ok: false, effects: [], file, reason: `no pude leer ${file}` };
  let doc;
  try { doc = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return { ok: false, effects: [], file, reason: `${file} es ilegible (${e.message})` }; }
  const problems = effectProblems(doc);
  if (problems.length) return { ok: false, effects: [], file, reason: `${file} no pasa su validación: ${problems.slice(0, 3).join(' · ')}${problems.length > 3 ? ` (y ${problems.length - 3} más)` : ''}` };
  return { ok: true, effects: doc.effects, file, reason: null };
}

/** Los hooks de la lista que pueden frenar: denegar una herramienta o no dejar cerrar un turno. */
function brakes(effects) {
  return (Array.isArray(effects) ? effects : []).filter((e) => isObject(e) && e.kind === 'hook' && e.blocks !== 'no');
}

// ── los controles ESPERADOS (story 8.17, tanda W3a · AC 70) ─────────────────────────────────────────────────────────
// `missing` y `unregistered` comparan lo que el aplicador REPORTÓ contra la máquina: un control que el aplicador nunca
// registró no está en el registro y `doctor` decía «todas en su lugar» (pipeline 182: al instalador de Windows le
// faltaban 15 controles, los dos frenos de comandos entre ellos, y nada lo decía). `expectedControls` cuenta contra la
// LISTA del aplicador de esta plataforma, para esta configuración. Cuatro fuentes, todas archivos del árbol:
//   · la lista: `install-tycon-hooks.sh` (Mac y Linux, `applierHooks`) o `install-tycon-hooks.ps1` (Windows, `ps1Hooks`);
//   · la condición de cada control (`when`): scripts/tests/fixtures/harness-managed-pieces.json, que viaja en la copia
//     pública y cuya coincidencia con las dos listas la frena scripts/tests/hooks-lists-parity.test.js;
//   · lo que queda afuera en Windows, con su motivo: scripts/setup/windows-support.json → `excluded`;
//   · si está: `controlState()` — mismo evento, mismo matcher, el intérprete de su extensión y el guion en el disco
//     (pase adversarial de la W3a, B5); no depende de la forma de la ruta. Un control es evento + matcher + guion.
// Las integraciones las pasa quien llama (este módulo viaja en la copia fija y no puede cargar `scripts/lib/`).
const APPLIER_SH = 'install-tycon-hooks.sh';
const APPLIER_PS1 = 'install-tycon-hooks.ps1';
const CONDITIONS_FILE = path.join('scripts', 'tests', 'fixtures', 'harness-managed-pieces.json');
const WINDOWS_SUPPORT_FILE = path.join('scripts', 'setup', 'windows-support.json');
// los opt-in por variable: `true` = nace prendido (lo apaga `VAR=0`); `false` = nace apagado (lo prende `VAR=1`)
const OPT_IN_DEFAULT = { TYCON_SAFETY_GUARD: true, TYCON_TEST_SCOPE_GUARD: true, TYCON_SESSION_GUARD: false };
// el interruptor por control que, PUESTO, manda sobre la llave de su integración en los dos sentidos (story 8.3)
const SWITCH_OVER_INTEGRATION = { 'PreToolUse:@tcg:engram-pre-commit.sh': 'TYCON_ENGRAM_HOOK' };
const TELEGRAM_PLUGIN_DIR = path.join('.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram');
const PLATFORM_NAMES = { windows: 'win32', win32: 'win32', darwin: 'darwin', linux: 'linux' };

const PS1_ROW_RE = /@\{[^\n}]*\}/g;
const ps1Field = (row, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(row); return m ? m[1] : null; };
/**
 * Los hooks que el aplicador de Windows conoce: cada fila `@{ event='…'; … relpath='…'; [source='tcg';] … }` de
 * `install-tycon-hooks.ps1`, esté en la tabla que esté (la canónica, o una de opt-in al lado con la misma forma).
 * `[{ event, relpath, needle }]`, con `@tcg:` delante de lo que vive en scripts/hooks/ del árbol; `null` si no se puede
 * leer o no trae ninguna fila. Una fila COMENTADA (un `#` antes de ella en su línea, fuera de comillas) no es de la
 * lista: PowerShell no la lee y el aplicador no la registra, así que tampoco es un control esperado. Un `#` dentro de una
 * etiqueta o un comentario al final de la fila no la apagan.
 */
function ps1Hooks(tree) {
  if (!tree) return null;
  // desde la W3, la lista única menos lo que excluye de Windows (`platforms.windows: false`)
  const listed = hooksListRows(tree, (h) => !(isObject(h.platforms) && h.platforms.windows === false));
  if (listed !== undefined) return listed;
  const text = readText(path.join(tree, 'scripts', APPLIER_PS1));
  if (text === null) return null;
  const out = [];
  const seen = new Map();
  let m;
  PS1_ROW_RE.lastIndex = 0;
  while ((m = PS1_ROW_RE.exec(text))) {
    const row = m[0];
    const before = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index).replace(/'[^']*'|"[^"]*"/g, '');
    if (before.includes('#')) continue;   // comentada
    const event = ps1Field(row, 'event');
    const rel = ps1Field(row, 'relpath');
    if (!event || !rel || !EVENTS.includes(event)) continue;
    const relpath = ps1Field(row, 'source') === 'tcg' ? `@tcg:${rel}` : rel;
    addRow(out, seen, event, relpath, ps1Field(row, 'matcher') || '');   // `matcher=$null` → sin matcher
  }
  return out.length ? out : null;
}

/** ¿La condición de un control se cumple? `{ on: true|false|null, why }` (`null` = no se puede decidir). */
function conditionState(id, when, { platform, integrations, env, home }) {
  for (const term of String(when).split('&').map((t) => t.trim()).filter(Boolean)) {
    if (term === 'always') continue;
    const [kind, arg] = [term.slice(0, term.indexOf(':')), term.slice(term.indexOf(':') + 1)];
    if (kind === 'integration') {
      const sw = SWITCH_OVER_INTEGRATION[id];
      if (sw && env[sw] !== undefined && env[sw] !== '') {
        if (env[sw] === '0') return { on: false, why: `apagado con ${sw}=0` };
        continue;   // puesto en otro valor: prendido, diga lo que diga la llave
      }
      if (!isObject(integrations)) return { on: null, why: `la configuración del arnés no se pudo leer: lo de la integración ${arg} queda como estaba` };
      if (integrations[arg] !== true) return { on: false, why: `la integración ${arg} está apagada` };
    } else if (kind === 'optin' && arg === 'telegram-plugin') {
      // una CARPETA, como el `[[ -d … ]]` del .sh: un archivo o un enlace colgado no es el plugin (B6)
      if (!isDir(path.join(home, TELEGRAM_PLUGIN_DIR))) return { on: false, why: 'el plugin de Telegram no está instalado' };
      if (env.TYCON_TG_ZOMBIE_SWEEP === '0') return { on: false, why: 'apagado con TYCON_TG_ZOMBIE_SWEEP=0' };
    } else if (kind === 'optin' && arg in OPT_IN_DEFAULT) {
      const on = OPT_IN_DEFAULT[arg] ? env[arg] !== '0' : env[arg] === '1';
      if (!on) return { on: false, why: OPT_IN_DEFAULT[arg] ? `apagado con ${arg}=0` : `nace apagado (lo prende ${arg}=1)` };
    } else if (kind === 'platform' && PLATFORM_NAMES[arg]) {
      if (PLATFORM_NAMES[arg] !== platform) return { on: false, why: `sólo en ${arg}` };
    } else {
      return { on: null, why: `condición que no sé leer: «${term}»` };
    }
  }
  return { on: true, why: null };
}

/**
 * Los controles que el aplicador de `platform` registra para esta configuración, contra settings.json. Nunca tira.
 * `integrations` = `{ <llave>: true|false }`, o `null` si la configuración no se pudo leer (lo de una integración no se
 * cuenta: queda como estaba). Devuelve:
 *   source     de dónde salió la lista · listed  cuántas filas evento+matcher+guion trae (`null` = no se pudo leer)
 *   expected   `[{ id, event, relpath, matcher }]` lo que se espera · missing  lo esperado que no corre como debe, con
 *              `why` (el motivo) y `label` (cómo mostrarlo)
 *   off        `[{ id, why }]` apagado por la configuración · unknown  `[{ id, why }]` no se pudo decidir (no cuenta)
 *   excluded   `[{ id, reason }]` fuera en Windows a propósito (sólo en Windows) · undeclared  ids sin condición declarada
 *   problems   lo que impide contar bien, para decirlo · caveat  la salvedad de una cuenta sin la lista de condiciones
 */
function expectedControls({ platform = process.platform, tree = null, integrations = null, env = process.env, home = os.homedir(), profile = 'full' } = {}) {
  const windows = platform === 'win32';
  const source = windows ? APPLIER_PS1 : APPLIER_SH;
  const out = { source, listed: null, expected: [], missing: [], off: [], unknown: [], excluded: [], undeclared: [], problems: [], caveat: null };
  const list = windows ? ps1Hooks(tree) : applierHooks(tree);
  if (!list) {
    out.problems.push(`no pude leer la lista de controles de scripts/${source}${tree ? ` en ${tree}` : ' (sin árbol)'}: no sé cuántos se esperan en esta máquina`);
    return out;
  }
  // la condición de cada control
  const declared = readJson(path.join(tree, CONDITIONS_FILE));
  const conditions = new Map();
  if (isObject(declared) && Array.isArray(declared.pieces)) {
    for (const p of declared.pieces) if (isObject(p) && p.kind === 'hook' && typeof p.id === 'string' && typeof p.when === 'string') conditions.set(p.id, p.when);
  } else {
    out.caveat = `sin la lista de condiciones (${CONDITIONS_FILE.split(path.sep).join('/')} no está o no se puede leer): la cuenta toma todo lo de la lista y puede incluir controles apagados a propósito`;
  }
  // lo que queda afuera en Windows, con su motivo
  const excluded = new Map();
  if (windows) {
    const support = readJson(path.join(tree, WINDOWS_SUPPORT_FILE));
    if (!isObject(support) || !Array.isArray(support.excluded)) {
      out.problems.push(`no pude leer lo que queda afuera en Windows (${WINDOWS_SUPPORT_FILE.split(path.sep).join('/')} no está o no trae \`excluded\`): si falta un control excluido a propósito, sale como faltante`);
    } else {
      for (const e of support.excluded) {
        if (!isObject(e) || typeof e.id !== 'string' || !e.id || (e.kind && e.kind !== 'hook')) continue;
        excluded.set(e.id, String(e.reason || 'sin motivo declarado'));
        out.excluded.push({ id: e.id, reason: String(e.reason || 'sin motivo declarado') });
      }
    }
  }
  // un excluido se nombra por su guion (`x.sh`), por la ruta de su spec o por su id entero
  const isExcluded = (h) => [`${h.event}:${h.relpath}`, h.relpath, h.relpath.replace(/^@tcg:/, ''), path.posix.basename(h.relpath.replace(/^@tcg:/, ''))].some((k) => excluded.has(k));
  out.listed = list.reduce((n, h) => n + h.matchers.length, 0);   // filas: evento + matcher + guion, como el aplicador
  // en qué perfil existe cada control (story 8.16): de la lista de efectos del árbol; sin ella, todo se espera como en full
  const effectsById = new Map();
  if (profile !== 'full') {
    const eff = readEffects(tree);
    if (eff.ok) {
      for (const e of eff.effects) if (e.kind === 'hook' && e.id) effectsById.set(e.id, e);
    } else out.problems.push(`no pude leer qué trae cada perfil (${eff.reason}): cuento como en full`);
  }
  const settings = readJson(settingsPath(home, env));
  for (const h of list) {
    const id = `${h.event}:${h.relpath}`;
    if (isExcluded(h)) continue;
    const when = conditions.get(id);
    if (when === undefined && !out.caveat) out.undeclared.push(id);
    let state = when === undefined ? { on: true, why: null } : conditionState(id, when, { platform, integrations, env, home });
    // el perfil de instalación (story 8.16, tanda C · AC 28): fuera de full, lo que la lista de efectos no marca `minimal`
    // no se espera (salvo un opt-in prendido a mano con su variable en `1`); con el perfil sin saber, no se decide
    if (state.on === true && profile !== 'full') {
      const eff = effectsById.get(id);
      // la variable que lo prende a mano: la de `optin:<VARIABLE>`, y la del barrido de Telegram, que se declara por su
      // plugin (pase adversarial de la tanda C, clases 3 y 4)
      const optVar = eff && /^optin:([A-Z][A-Z0-9_]*)$/.test(eff.when) ? eff.when.slice('optin:'.length)
        : (eff && eff.when === 'optin:telegram-plugin' ? 'TYCON_TG_ZOMBIE_SWEEP' : null);
      // con el perfil sin saber, los dos frenos que nacen prendidos se registran igual (decisión del dueño, 2026-10-04):
      // se esperan, como en full
      const brakeWhenUnknown = profile === null && optVar && OPT_IN_DEFAULT[optVar] === true;
      if (eff && Array.isArray(eff.profiles) && !eff.profiles.includes('minimal') && !(optVar && env[optVar] === '1') && !brakeWhenUnknown) {
        state = profile === 'minimal' ? { on: false, why: 'el perfil minimal no lo trae' } : { on: null, why: 'no se sabe el perfil de instalación (la configuración está rota)' };
      }
    }
    if (state.on === false) { out.off.push({ id, why: state.why }); continue; }
    if (state.on === null) { out.unknown.push({ id, why: state.why }); continue; }
    // un control por matcher (B5): las dos filas PostToolUse de rebuild-before-verify.js son dos
    for (const matcher of h.matchers) {
      const control = { id, event: h.event, relpath: h.relpath, matcher };
      out.expected.push(control);
      const s = controlState(control, settings, h.matchers.filter((x) => !sameMatcher(x, matcher)));
      if (s.ok) continue;
      const label = `${h.event}${h.matchers.length > 1 ? ` [${matcher || 'sin matcher'}]` : ''} ${h.relpath}${s.why !== NOT_REGISTERED ? ` (${s.why})` : ''}`;
      out.missing.push(Object.assign({}, control, { why: s.why, label }));
    }
  }
  return out;
}

// ── «está registrado» para un control (B5) ──────────────────────────────────────────────────────────────────────────
// Mismo evento, MISMO matcher, el intérprete de su extensión y el guion en el disco. `present()` (las piezas del
// registro) sigue mirando evento + final de ruta: ahí basta saber si el aplicador lo dejó.
const NOT_REGISTERED = 'no está registrado';
const RUNNERS_BY_EXT = { '.sh': ['bash', 'sh'], '.js': ['node'], '.mjs': ['node'], '.cjs': ['node'], '.py': ['python3', 'python'] };
/** El programa que lanza el comando: el primer pedazo (con o sin comillas), sin carpeta ni `.exe`. */
function commandRunner(command) {
  const m = /^\s*(?:"([^"]+)"|(\S+))/.exec(command);
  return path.posix.basename(slash(m ? (m[1] || m[2]) : '')).replace(/\.exe$/i, '').toLowerCase();
}
/** La ruta del guion en el comando: el argumento (entre comillas o no) que termina en `needle`. */
function commandScript(command, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`"([^"]*${esc})"|(\\S*${esc})(?=\\s|$)`).exec(command);
  return m ? (m[1] || m[2]) : null;
}
/** ¿El guion está en el disco? `true` / `false` / `null` (no sé mirarlo: una ruta que en ESTE sistema no es absoluta,
 *  como `C:/…` fuera de Windows; ahí no se da por faltante). En Windows, la forma de Git Bash (`/c/…`) es `C:/…`. */
function scriptOnDisk(file) {
  if (!file) return null;
  let f = file;
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(f)) f = `${f[1]}:${f.slice(2)}`;
  if (!path.isAbsolute(f)) return null;
  return fs.existsSync(f);
}
/** `{ ok, why }`: si el control corre como debe, o el motivo del más cercano que no (otro matcher, otro intérprete, el
 *  guion que no está) o `no está registrado`. `siblings`: los otros matchers del mismo evento y guion en la lista —esa
 *  fila es OTRO control, no «este registrado con otro matcher»—. */
function controlState(control, settings, siblings = []) {
  const needle = hookNeedle(control.relpath);
  const runners = RUNNERS_BY_EXT[path.posix.extname(control.relpath.replace(/^@tcg:/, '')).toLowerCase()] || null;
  const blocks = isObject(settings) && isObject(settings.hooks) && Array.isArray(settings.hooks[control.event]) ? settings.hooks[control.event] : [];
  let why = null;
  for (const b of blocks) {
    if (!isObject(b) || !Array.isArray(b.hooks)) continue;
    for (const h of b.hooks) {
      if (!isObject(h) || typeof h.command !== 'string') continue;
      const command = slash(h.command);
      if (!command.includes(needle)) continue;
      if (!sameMatcher(b.matcher, control.matcher)) { if (!siblings.some((x) => sameMatcher(x, b.matcher))) why = why || `registrado con otro matcher (${b.matcher || 'ninguno'}; se espera ${control.matcher || 'ninguno'})`; continue; }
      const runner = commandRunner(command);
      if (runners && !runners.includes(runner)) { why = `registrado con ${runner || 'otro programa'} en vez de ${runners[0]}: así no corre`; continue; }
      const file = commandScript(command, needle);
      if (scriptOnDisk(file) === false) { why = `su guion no está en el disco: ${file}`; continue; }
      return { ok: true, why: null };
    }
  }
  return { ok: false, why: why || NOT_REGISTERED };
}

module.exports = {
  KINDS, EVENTS, parseReport, hookId, hookNeedle, applierHooks, ps1Hooks, present, merge, missing, unregistered, describe, expectedControls,
  EFFECTS_FILE, EFFECT_KINDS, EFFECT_BLOCKS, EFFECT_INTEGRATIONS, PROFILES, effectProblems, readEffects, brakes,
  integrationProblems, readIntegrations,
};
