#!/usr/bin/env node
'use strict';
/**
 * count-hooks.js — los hooks que quedaron en `settings.json`, contra los que deberían estar (story 8.17, W0 · AC 7).
 *
 * POR QUÉ EXISTE. El análisis previo contó, leyendo el código, que el instalador de Windows registra 29 hooks donde
 * el de Mac y Linux registra 45: le faltan 18 y tiene 2 que correrían dos veces. Eso es una lectura, no una medición.
 * Este paso lo mide sobre el `settings.json` que dejó la instalación de verdad, y lo dice por nombre.
 *
 * LA LISTA ESPERADA no está escrita acá: en W0 sale de LEER `scripts/install-tycon-hooks.sh` del clon que se mide —sus
 * arreglos `HOOKS_CANONICAL` y `OPTIN_HOOKS`, la función que dice qué hook es de qué integración, y la condición de
 * cada opt-in—, evaluada para la configuración de esa corrida (qué integraciones están prendidas, qué variables hay).
 * Desde W3 sale de `scripts/setup/hooks-list.json` del clon (`expectedFromList`), decidida con la misma función que usa
 * el aplicador y para la plataforma donde corre la medición: en Windows, lo que la lista excluye no se espera. La lectura
 * del instalador queda sólo para medir un clon de antes de la W3.
 *
 * QUÉ DICE, por nombre: qué hook esperado FALTA; cuál está MÁS DE UNA VEZ; cuál está en OTRO evento o con OTRO matcher;
 * cuál quedó registrado estando reemplazado (corre dos veces: suelto y dentro de su despachador); cuál es del arnés y
 * no está en la lista; y cuál nombra un archivo que NO EXISTE.
 *
 * CÓMO FALLA. Si el instalador trae una condición que este lector no sabe evaluar, o le falta una de las piezas que
 * lee, la lista esperada no es de fiar: el paso sale «error» y nombra qué no supo leer. Nunca cuenta contra una lista
 * a medias.
 *
 * Uso: node scripts/tests/windows/count-hooks.js --lab <laboratorio> --out <carpeta del reporte>
 *      node scripts/tests/windows/count-hooks.js --settings <settings.json> --installer <install-tycon-hooks.sh>
 *           --integrations <json> [--home <carpeta>] [--clone <clon>]       (suelto: imprime el resultado)
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');
const PLACE = require('../../setup/harness/place.js');

const NAME = 'count-hooks';
const BOOTSTRAP_MARK = '.tycon-pipeline/harness/bootstrap.js';
const TCG = '@tcg:';

// ── leer el instalador ───────────────────────────────────────────────────────────────────────────────────────────

/** Una cadena de bash entre comillas dobles, ya sin sus escapes. */
function unquote(s) { return s.replace(/\\(["$`\\])/g, '$1'); }
const ITEM = /^\s*"((?:[^"\\]|\\.)*)"\s*$/;

/** Los elementos de `NAME=( … )`: una cadena por línea, hasta la línea que cierra el arreglo. `null` si no está. */
function bashArray(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${name}=(`);
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === ')') return out;
    const m = ITEM.exec(lines[i]);
    if (m) out.push(unquote(m[1]));
  }
  return null;
}

/**
 * Cada `OPTIN_HOOKS+=( … )` con la condición del `if` que lo envuelve: `[{ spec, condition, optin }]`. Desde los perfiles
 * de la 8.16 (tanda C) el instalador decide un opt-in en una línea aparte, `_OP=0; _optin_por_perfil VAR [freno] || _OP=$?`,
 * y el `if` pregunta por `"$_OP" == 0`: `optin` es la última de esas líneas antes del bloque (`{ name, brake }`), o null.
 */
function optinBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  let condition = null;
  let optin = null;
  for (let i = 0; i < lines.length; i++) {
    const call = /^_OP=0; _optin_por_perfil ([A-Z0-9_]+)( freno)? \|\| _OP=\$\?\s*$/.exec(lines[i]);
    if (call) { optin = { name: call[1], brake: Boolean(call[2]) }; continue; }
    const cond = /^if \[\[ (.+) \]\]; then\s*$/.exec(lines[i]);
    if (cond) { condition = cond[1]; continue; }
    if (/^fi\s*$/.test(lines[i])) { condition = null; continue; }
    if (lines[i].trim() !== 'OPTIN_HOOKS+=(') continue;
    for (i += 1; i < lines.length && lines[i].trim() !== ')'; i++) {
      const m = ITEM.exec(lines[i]);
      if (m) out.push({ spec: unquote(m[1]), condition, optin });
    }
  }
  return out;
}

/** Los elementos de un conjunto de Python `NAME = { "a", "b", … }` (de una o de varias líneas). `null` si no está. */
function pythonSet(text, name) {
  const m = new RegExp(`^${name} = \\{([^}]*)\\}`, 'm').exec(text);
  if (!m) return null;
  const body = m[1].split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');   // los comentarios no son elementos
  return [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Qué hook es de qué integración: `{ <ruta del hook>: <integración en minúsculas> }`. `null` si la función no está. */
function integrationOf(text) {
  const m = /^_hook_de_integracion\(\) \{\n([\s\S]*?)\n\}/m.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const integ = /_INTEG_DE=([A-Z_]+)/.exec(line);
    if (!integ) continue;
    for (const p of line.matchAll(/\*"\|([^|"]+)\|"\*/g)) out[p[1]] = integ[1].toLowerCase();
  }
  return out;
}

/** `EVENTO|matcher|ruta|texto`: el matcher puede traer `|` (Edit|Write), y el texto también (gemelo de parse_spec). */
function parseSpec(spec, matcherTokens) {
  const parts = spec.split('|');
  if (parts[1] === '') return { event: parts[0], matcher: '', relpath: parts[2] };
  let i = 1;
  const tokens = [];
  while (i < parts.length && matcherTokens.has(parts[i])) { tokens.push(parts[i]); i++; }
  return { event: parts[0], matcher: tokens.join('|'), relpath: parts[i] };
}

/**
 * ¿Se cumple la condición de un opt-in? `true`, `false`, o `null` si trae una forma que este lector no conoce.
 * Las formas de hoy: `"${VAR:-D}" == "V"` y `!=`, `"$ENGRAM_HOOK_ON" == "1"`, `-d "$HOME/…"`, y `"$_OP" == 0` (la
 * línea `_optin_por_perfil` de antes del bloque, con la misma regla que el instalador), unidas por `&&`.
 * `'leave'` = el perfil no se pudo leer y el opt-in no es un freno: el instalador lo deja como está (no se espera).
 */
function evalCondition(condition, { env, integrations, home, exists, optin = null, profile = { state: 'ok', value: 'full' } }) {
  if (!condition) return true;
  const derived = {
    // el interruptor del hook de engram manda sobre la llave, en los dos sentidos (lo dice el instalador)
    ENGRAM_HOOK_ON: env.TYCON_ENGRAM_HOOK !== undefined && env.TYCON_ENGRAM_HOOK !== '' ? (env.TYCON_ENGRAM_HOOK === '0' ? '0' : '1') : (integrations.engram === true ? '1' : '0'),
  };
  let all = true;
  for (const raw of condition.split('&&')) {
    const clause = raw.trim();
    let m = /^"\$\{([A-Z0-9_]+):-([^}]*)\}" (==|!=) "([^"]*)"$/.exec(clause);
    if (m) {
      const value = env[m[1]] !== undefined && env[m[1]] !== '' ? env[m[1]] : m[2];
      if ((value === m[4]) !== (m[3] === '==')) all = false;
      continue;
    }
    m = /^"\$([A-Z0-9_]+)" (==|!=) "([^"]*)"$/.exec(clause);
    if (m && Object.prototype.hasOwnProperty.call(derived, m[1])) {
      if ((derived[m[1]] === m[3]) !== (m[2] === '==')) all = false;
      continue;
    }
    m = /^-d "\$HOME\/([^"$]+)"$/.exec(clause);
    if (m) {
      if (!exists(path.join(home, ...m[1].split('/')))) all = false;
      continue;
    }
    if (/^"\$_OP" == "?0"?$/.test(clause)) {
      if (!optin) return null;   // sin la línea que decide _OP, no se sabe qué pregunta
      const op = optinByProfile(optin, { env, profile });
      if (op === 2) return 'leave';
      if (op !== 0) all = false;
      continue;
    }
    return null;
  }
  return all;
}

/** `_optin_por_perfil` del instalador: 0 = se registra, 1 = no, 2 = queda como está (perfil ilegible y no es un freno). */
function optinByProfile({ name, brake }, { env, profile }) {
  const v = env[name] === undefined ? '' : String(env[name]);
  if (profile.state === 'ok' && profile.value === 'minimal') return v === '1' ? 0 : 1;
  if (v === '0') return 1;
  if (profile.state !== 'ok' && v === '' && !brake) return 2;
  return 0;
}

/**
 * La lista esperada para esta configuración: `{ hooks: [{ event, matcher, relpath }], superseded: [...], problems: [...] }`.
 * `integrations` es lo que contesta `tycon-config.js integrations --json`; `null` = no se pudo leer (el instalador,
 * en ese caso, deja los hooks de las integraciones como estaban: acá no se esperan ni se cuentan de más).
 */
function expectedHooks(installerText, { integrations = {}, env = {}, home = '', exists = fs.existsSync, profile = { state: 'ok', value: 'full' } } = {}) {
  const problems = [];
  const text = String(installerText).replace(/\r\n/g, '\n');
  const canonical = bashArray(text, 'HOOKS_CANONICAL');
  if (!canonical || !canonical.length) problems.push('no encontré el arreglo HOOKS_CANONICAL en el instalador');
  const tokens = pythonSet(text, 'KNOWN_MATCHER_TOKENS');
  if (!tokens) problems.push('no encontré KNOWN_MATCHER_TOKENS en el instalador: no sé partir los matchers');
  const integ = integrationOf(text);
  if (!integ) problems.push('no encontré la función _hook_de_integracion en el instalador');
  const superseded = pythonSet(text, 'SUPERSEDED_RELPATHS');
  if (!superseded) problems.push('no encontré SUPERSEDED_RELPATHS en el instalador');
  if (!/^OPTIN_HOOKS=\(\)\s*$/m.test(text)) problems.push('no encontré OPTIN_HOOKS en el instalador');
  // en minimal el instalador registra del set canónico sólo lo que install-effects.json marca así: este lector no lo
  // sabe todavía, y una lista de full contra una instalación minimal daría faltantes falsos
  if (profile.state === 'ok' && profile.value === 'minimal' && /_optin_por_perfil/.test(text)) problems.push('la instalación medida es del perfil minimal: este lector sólo sabe la lista de full');
  if (problems.length) return { hooks: [], superseded: superseded || [], problems };

  const matcherTokens = new Set(tokens);
  const hooks = [];
  const skipped = [];
  for (const spec of canonical) {
    const h = parseSpec(spec, matcherTokens);
    const of = integ[h.relpath];
    if (of) {
      if (!integrations) { skipped.push({ relpath: h.relpath, why: `integración ${of}: no pude leer la configuración` }); continue; }
      if (integrations[of] !== true) { skipped.push({ relpath: h.relpath, why: `integración ${of} apagada` }); continue; }
    }
    hooks.push(Object.assign(h, { origin: 'canonical' }));
  }
  for (const { spec, condition, optin } of optinBlocks(text)) {
    const h = parseSpec(spec, matcherTokens);
    const on = evalCondition(condition, { env, integrations: integrations || {}, home, exists, optin, profile });
    if (on === null) { problems.push(`no sé evaluar la condición «${condition}» del opt-in ${h.relpath}`); continue; }
    if (on === 'leave') { skipped.push({ relpath: h.relpath, why: 'el perfil de instalación no se pudo leer: el instalador lo deja como está' }); continue; }
    if (on) hooks.push(Object.assign(h, { origin: 'optin' })); else skipped.push({ relpath: h.relpath, why: `opt-in apagado (${condition})` });
  }
  return { hooks, superseded, skipped, problems };
}

/**
 * La lista esperada desde la lista única (story 8.17, tanda W3): `scripts/setup/hooks-list.json` del clon, decidida con
 * la misma función que usa el aplicador (`decide` de scripts/setup/apply-hooks.js) para esta plataforma y esta
 * configuración. Misma forma que `expectedHooks`. `null` si el clon no trae la lista (uno de antes de la W3: se lee el
 * instalador, como en W0).
 */
function expectedFromList(clone, { integrations = {}, env = {}, home = '', exists = fs.existsSync, profile = { state: 'ok', value: 'full' }, platform = process.platform } = {}) {
  const listFile = path.join(clone, 'scripts', 'setup', 'hooks-list.json');
  if (!fs.existsSync(listFile)) return null;
  const problems = [];
  let mod; let list;
  try { mod = require(path.join(clone, 'scripts', 'setup', 'apply-hooks.js')); } catch (e) { return { hooks: [], superseded: [], skipped: [], problems: [`no pude cargar apply-hooks.js del clon: ${e.message}`] }; }
  try { list = mod.loadList(listFile); } catch (e) { return { hooks: [], superseded: [], skipped: [], problems: [e.message] }; }
  const effects = path.join(clone, 'scripts', 'setup', 'install-effects.json');
  const values = {};
  for (const [k, v] of Object.entries(integrations || {})) values[k] = v === true ? '1' : '0';
  const decision = mod.decide(list, {
    env,
    integ: integrations ? { state: 'ok', values } : { state: 'rota', values: {} },
    profile: { state: profile.state, value: profile.value },
    minimalIds: mod.loadMinimalIds(effects),
    platform: platform === 'win32' ? 'windows' : 'posix',
    has: (need) => need === 'telegram-plugin' && exists(path.join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram')),
  });
  const active = new Set(decision.active);
  const hooks = decision.active.map((h) => ({ event: h.event, matcher: h.matcher, relpath: h.spec, origin: h.when.startsWith('optin:') ? 'optin' : 'canonical' }));
  const skipped = list.hooks.filter((h) => !active.has(h)).map((h) => ({
    relpath: h.spec,
    why: platform === 'win32' && h.platforms.windows === false ? 'fuera en Windows (scripts/setup/windows-support.json → excluded)'
      : decision.leave.has(h.spec) ? 'el perfil de instalación no se pudo leer: el aplicador lo deja como está'
        : decision.profileOff.has(h.spec) ? 'fuera del perfil minimal'
          : h.when.startsWith('integration:') ? `integración ${h.when.slice('integration:'.length)} apagada` : `opt-in apagado (${h.when})`,
  }));
  return { hooks, superseded: list.superseded, skipped, problems };
}

// ── leer settings.json ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * El intérprete y el archivo de un `command` con la forma que escriben los instaladores: `node "<ruta>"` / `bash "<ruta>"`,
 * y desde la W4 un `.sh` en Windows con la ruta del bash de Git entre comillas (`"C:/…/bash.exe" "<ruta>"`): el intérprete
 * es el nombre de ese archivo, sin `.exe` (pase adversarial de la W3W4, clases 1 y 12).
 */
function commandFile(command) {
  const m = /^\s*(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s+"([^"]+)"\s*$/.exec(String(command || ''));
  if (!m) return { runner: null, file: null };
  const runner = m[1] ? m[1].replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '') : m[2];
  return { runner, file: m[3] };
}

/** Cada hook de `settings.json`, aplanado: `{ event, matcher, command, runner, file, startup_line }`. */
function registeredHooks(settings) {
  const out = [];
  const hooks = settings && typeof settings.hooks === 'object' && settings.hooks ? settings.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) {
        if (!h || typeof h.command !== 'string') continue;
        out.push(Object.assign({ event, matcher: g.matcher || '', command: h.command, is_async: h.async === true, startup_line: h.command.includes(BOOTSTRAP_MARK) }, commandFile(h.command)));
      }
    }
  }
  return out;
}

const matcherKey = (m) => String(m || '').split('|').map((t) => t.trim()).filter(Boolean).sort().join('|');
const suffixOf = (relpath) => (relpath.startsWith(TCG) ? `/scripts/hooks/${relpath.slice(TCG.length)}` : `/skills/${relpath}`);

/**
 * Compara. Un hook registrado «es» uno esperado si su archivo termina en la ruta de ése (los del arnés bajo
 * `scripts/hooks/`, los de las skills bajo `skills/`): así no importa por qué enlace o con qué barras quedó escrito.
 */
function compare(expected, settings, { superseded = [], home = '', clone = '', exists = fs.existsSync, platform = process.platform } = {}) {
  const cmp = (p) => L.comparable(p, platform);
  const all = registeredHooks(settings);
  const startup = all.filter((r) => r.startup_line);
  const reg = all.filter((r) => !r.startup_line).map((r) => Object.assign({ used: false, path: r.file ? cmp(r.file) : '' }, r));
  const roots = [clone, home ? PLACE.placePath(home) : '', home ? PLACE.legacyPlacePath(home) : '', home ? path.join(home, '.claude', 'agent-skills') : ''].filter(Boolean).map(cmp);
  const owned = (r) => Boolean(r.path) && roots.some((root) => r.path === root || r.path.startsWith(`${root}/`));
  const relpathOf = (r) => {
    const tcg = /\/scripts\/hooks\/([^/]+)$/.exec(r.path);
    if (tcg) return `${TCG}${tcg[1]}`;
    const sk = /\/skills\/(.+)$/.exec(r.path);
    return sk ? sk[1] : r.path;
  };
  // El nombre es el id de cada hallazgo (va a known-gaps.json). Un mismo archivo puede estar esperado dos veces en el
  // mismo evento con matchers distintos (rebuild-before-verify.js en PostToolUse: Edit|Write y Bash): ahí el nombre
  // lleva el matcher, o los dos registros serían un solo hallazgo y uno de ellos quedaría sin medir. Los demás
  // nombres no cambian.
  const keyOf = (x) => `${x.event}:${x.relpath}`;
  const name = (e) => (expected.filter((x) => keyOf(x) === keyOf(e)).length > 1 && e.matcher ? `${keyOf(e)} [${e.matcher}]` : keyOf(e));

  const missing = []; const duplicated = []; const misplaced = [];
  const pending = [];
  for (const e of expected) {
    const suffix = cmp(suffixOf(e.relpath));
    const same = reg.filter((r) => !r.used && r.path.endsWith(suffix) && r.event === e.event && matcherKey(r.matcher) === matcherKey(e.matcher));
    if (!same.length) { pending.push({ e, suffix }); continue; }
    for (const r of same) r.used = true;
    if (same.length > 1) duplicated.push({ hook: name(e), matcher: e.matcher, times: same.length });
  }
  // lo que no está en su lugar: ¿está el mismo archivo en otro evento o con otro matcher, sin dueño?
  // En dos pasadas: primero, para todos, el mismo evento con otro matcher; después, cualquier otro evento. En una sola
  // pasada, con un archivo esperado en varios eventos, el primero de la lista se llevaba el registro del otro evento y
  // el que falta y el que está corrido salían con los nombres cruzados.
  const found = new Map();
  for (const sameEvent of [true, false]) {
    for (const p of pending) {
      if (found.has(p)) continue;
      const r = reg.find((x) => !x.used && x.path.endsWith(p.suffix) && (!sameEvent || x.event === p.e.event));
      if (r) { r.used = true; found.set(p, r); }
    }
  }
  for (const p of pending) {
    const { e } = p; const elsewhere = found.get(p);
    if (elsewhere) misplaced.push({ hook: name(e), expected: { event: e.event, matcher: e.matcher }, found: { event: elsewhere.event, matcher: elsewhere.matcher } });
    else missing.push({ hook: name(e), matcher: e.matcher, origin: e.origin || null });
  }
  // lo mismo para lo registrado: si el archivo está más de una vez en el evento, el nombre lleva el matcher
  const regName = (r, rel) => {
    const same = reg.filter((x) => x.event === r.event && x.path === r.path).length;
    return same > 1 && r.matcher ? `${r.event}:${rel} [${r.matcher}]` : `${r.event}:${rel}`;
  };
  const replaced = []; const unexpected = []; let foreign = 0;
  for (const r of reg.filter((x) => !x.used)) {
    if (!owned(r)) { foreign++; continue; }
    const rel = relpathOf(r);
    if (superseded.includes(rel)) replaced.push({ hook: regName(r, rel), matcher: r.matcher });
    else unexpected.push({ hook: regName(r, rel), matcher: r.matcher });
  }
  const dangling = reg.filter((r) => r.file && !exists(r.file)).map((r) => ({ hook: regName(r, owned(r) ? relpathOf(r) : r.file), file: r.file }));
  const unreadable = reg.filter((r) => !r.file).map((r) => ({ event: r.event, command: L.clip(r.command, 200) }));
  const runners = {};
  for (const r of reg.filter(owned)) runners[r.runner] = (runners[r.runner] || 0) + 1;
  return {
    expected_total: expected.length,
    registered_total: all.length,
    registered_of_harness: reg.filter(owned).length,
    registered_foreign: foreign,
    in_place: expected.length - missing.length - misplaced.length,
    missing, duplicated, misplaced, superseded: replaced, unexpected, dangling,
    other_forms: unreadable,
    runners,
    startup_line: { count: startup.length, events: [...new Set(startup.map((s) => s.event))], is_async: startup.map((s) => s.is_async) },
  };
}

/** Los hallazgos de una comparación: uno por hook, con un id que no cambia de una corrida a otra. */
function findingsOf(result) {
  const out = [];
  for (const m of result.missing) out.push({ id: `hooks:missing:${m.hook}`, kind: 'hook-missing', detail: `el hook esperado ${m.hook}${m.matcher ? ` (matcher ${m.matcher})` : ''} no quedó registrado`, closes: 'W4' });
  for (const d of result.duplicated) out.push({ id: `hooks:duplicated:${d.hook}`, kind: 'hook-duplicated', detail: `${d.hook} quedó registrado ${d.times} veces`, closes: 'W4' });
  for (const s of result.superseded) out.push({ id: `hooks:superseded:${s.hook}`, kind: 'hook-superseded', detail: `${s.hook} quedó registrado suelto y además lo corre su despachador: corre dos veces`, closes: 'W4' });
  for (const m of result.misplaced) out.push({ id: `hooks:misplaced:${m.hook}`, kind: 'hook-misplaced', detail: `${m.hook} se esperaba en ${m.expected.event}${m.expected.matcher ? ` (${m.expected.matcher})` : ''} y está en ${m.found.event}${m.found.matcher ? ` (${m.found.matcher})` : ''}`, closes: 'W4' });
  for (const u of result.unexpected) out.push({ id: `hooks:unexpected:${u.hook}`, kind: 'hook-unexpected', detail: `${u.hook} es del arnés, quedó registrado y no está en la lista esperada`, closes: 'W4' });
  for (const d of result.dangling) out.push({ id: `hooks:dangling:${d.hook}`, kind: 'hook-dangling', detail: `${d.hook} nombra un archivo que no existe: ${d.file}`, closes: 'W4' });
  if (result.startup_line.count !== 1) out.push({ id: 'hooks:startup-line-count', kind: 'startup-line', detail: `la línea de arranque quedó ${result.startup_line.count} veces en settings.json (se espera una)`, closes: 'W5' });
  return out;
}

// ── el paso ──────────────────────────────────────────────────────────────────────────────────────────────────────

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** Lo que contesta el lector de configuración del clon con el ambiente de la instalación medida: objeto, o `null`. */
function readIntegrations(clone, env, rec) {
  const reader = path.join(clone, 'scripts', 'lib', 'tycon-config.js');
  if (!fs.existsSync(reader)) { rec.note(`sin ${reader}: no sé qué integraciones están prendidas`); return null; }
  const r = L.run(process.execPath, [reader, 'integrations', '--json'], { env, timeoutMs: 30000 });
  if (r.error || r.exit !== 0) { rec.note(`el lector de configuración salió ${r.error || r.exit}: ${L.firstLine(r.stderr)}`); return null; }
  try { return JSON.parse(r.stdout); } catch (e) { rec.note(`el lector de configuración no devolvió JSON: ${e.message}`); return null; }
}

/** El perfil de instalación como lo lee el instalador (8.16 C): `get install.profile` del lector del clon, con el
 *  ambiente de la instalación medida. 0 con minimal|full → ok; 3 (sin valor) → ok, full; otra salida → rota. */
function readProfile(clone, env) {
  const reader = path.join(clone, 'scripts', 'lib', 'tycon-config.js');
  if (!fs.existsSync(reader)) return { state: 'sin-lector', value: null };
  const r = L.run(process.execPath, [reader, 'get', 'install.profile'], { env, timeoutMs: 30000 });
  const out = String(r.stdout || '').trim();
  if (!r.error && r.exit === 0 && (out === 'minimal' || out === 'full')) return { state: 'ok', value: out };
  if (!r.error && r.exit === 3) return { state: 'ok', value: 'full' };
  return { state: 'rota', value: null, why: r.error || `salió ${r.exit}: ${L.firstLine(r.stderr)}` };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--settings': 'value', '--installer': 'value', '--integrations': 'value', '--home': 'value', '--clone': 'value' });
  if (args.problem) { process.stderr.write(`count-hooks.js: ${args.problem}\n`); return 2; }
  if (args.settings) {
    // suelto: un settings.json y un instalador cualesquiera, sin laboratorio
    if (!args.installer) { process.stderr.write('count-hooks.js: con --settings hace falta --installer\n'); return 2; }
    const integrations = args.integrations ? JSON.parse(args.integrations) : {};
    const exp = expectedHooks(fs.readFileSync(args.installer, 'utf8'), { integrations, env: process.env, home: args.home || '' });
    if (exp.problems.length) { process.stderr.write(`count-hooks.js: no pude medir: ${exp.problems.join(' · ')}\n`); return 2; }
    process.stdout.write(`${JSON.stringify(compare(exp.hooks, readJson(args.settings), { superseded: exp.superseded, home: args.home || '', clone: args.clone || '' }), null, 2)}\n`);
    return 0;
  }
  if (!args.lab || !args.out) { process.stderr.write('count-hooks.js: faltan --lab <laboratorio> y --out <carpeta del reporte>\n'); return 2; }
  const lab = path.resolve(args.lab);
  const rec = L.recorder(NAME, path.resolve(args.out));
  let state;
  try { state = readJson(path.join(lab, 'lab-state.json')); } catch (_) { state = null; }
  const variant = state && state.measured_variant;
  if (!variant) { rec.finish(L.STATUS.notMeasured, 'ninguna instalación dejó un settings.json que contar (ver el paso install)'); process.stdout.write('count-hooks: no medido — sin instalación que contar\n'); return 0; }
  const problem = L.labHomeProblem(variant.home, { labRoot: lab, allowTemp: Boolean(state.allow_temp) });
  if (problem) { rec.finish(L.STATUS.error, `no pude medir: ${problem}`); process.stdout.write(`count-hooks: error — ${problem}\n`); return 0; }
  const env = L.labEnv(variant.home, { extra: variant.env || {} });
  rec.setRedactor(L.redactor({ publicUrl: (L.readCover(variant.clone, { fence: 'bash' }) || {}).url, secrets: L.secretValues() }));
  rec.fact('variant', variant.id);
  let settings;
  try { settings = readJson(variant.settings); } catch (e) { rec.finish(L.STATUS.error, `no pude medir: no pude leer ${variant.settings}: ${e.message}`); return 0; }
  const integrations = readIntegrations(variant.clone, env, rec);
  rec.fact('integrations', integrations);
  const profile = readProfile(variant.clone, env);
  rec.fact('profile', profile);
  // desde la W3, la lista única del clon, para la plataforma donde corre la medición; un clon de antes, el instalador
  let exp = expectedFromList(variant.clone, { integrations, env, home: variant.home, profile });
  let source = 'scripts/setup/hooks-list.json';
  if (!exp) {
    source = 'scripts/install-tycon-hooks.sh';
    const installer = path.join(variant.clone, 'scripts', 'install-tycon-hooks.sh');
    let installerText;
    try { installerText = fs.readFileSync(installer, 'utf8'); } catch (e) { rec.finish(L.STATUS.error, `no pude medir: no pude leer ${installer}: ${e.code || e.message}`); return 0; }
    exp = expectedHooks(installerText, { integrations, env, home: variant.home, profile });
  }
  rec.fact('expected', { source, hooks: exp.hooks.map((h) => `${h.event}:${h.relpath}${h.matcher ? ` [${h.matcher}]` : ''}`), left_out: exp.skipped || [] });
  if (exp.problems.length) { rec.finish(L.STATUS.error, `no pude medir: la lista esperada no es de fiar: ${exp.problems.join(' · ')}`); process.stdout.write(`count-hooks: error — ${exp.problems.join(' · ')}\n`); return 0; }
  const result = compare(exp.hooks, settings, { superseded: exp.superseded, home: variant.home, clone: variant.clone });
  rec.fact('result', result);
  for (const f of findingsOf(result)) rec.finding(f.id, f.kind, f.detail, f.closes);
  rec.finish(L.STATUS.measured);
  process.stdout.write(`count-hooks: esperados ${result.expected_total} · en su lugar ${result.in_place} · faltan ${result.missing.length} · repetidos ${result.duplicated.length} · reemplazados ${result.superseded.length} · en otro lugar ${result.misplaced.length} · de más ${result.unexpected.length} · sin archivo ${result.dangling.length}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, BOOTSTRAP_MARK, bashArray, optinBlocks, pythonSet, integrationOf, parseSpec, evalCondition, expectedHooks, expectedFromList, commandFile, registeredHooks, compare, findingsOf };
