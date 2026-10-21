#!/usr/bin/env node
'use strict';
/**
 * apply-hooks.js — registra en `settings.json` los hooks de `scripts/setup/hooks-list.json`. Módulo y comando. Lo llaman los dos instaladores: `install-tycon-hooks.sh` (Mac y
 * Linux) y `install-tycon-hooks.ps1` (Windows). Ninguno de los dos lleva una lista propia.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────────────────────
 * Con una lista y un código propios en cada instalador (un bloque de Python en el `.sh` y uno de PowerShell en el
 * `.ps1`), los dos se desfasan sin que nada lo diga: el `.ps1` registraría menos controles que el `.sh`, entre los
 * que faltarían los frenos de comandos. Una lista y un aplicador no se pueden desfasar de sí mismos.
 *
 * ── QUÉ HACE ────────────────────────────────────────────────────────────────────────────────────────────────────
 *   1. decide qué hooks van (`decide`): cada uno por su `when` y la configuración del arnés (integraciones y perfil de
 *      instalación, leídos con scripts/lib/tycon-config.js), las variables de opt-in y la plataforma;
 *   2. saca lo reemplazado por los despachadores (`superseded`), las formas viejas (`legacy_fragments`) y lo apagado;
 *   3. registra cada hook una sola vez, en su lugar canónico (el orden de la lista), con el intérprete de su
 *      extensión (`.js` → node, `.sh` → bash, `.py` → python3), sin mover lo ajeno;
 *   4. no reescribe el archivo si no hay nada que cambiar; si escribe, lo hace atómico y con copia (salvo bajo
 *      `harness.js`, que ya tomó la suya: `TYCON_HARNESS_SNAPSHOT_DIR`).
 * Una lista rota o un `settings.json` que no es JSON NO se leen como «no hay hooks»: sale 1 nombrando el archivo y el
 * motivo, y no escribe nada. Un guion de la lista que no está en el disco se nombra; no se saltea callado.
 *
 * ── LAS DOS PLATAFORMAS (`--platform posix|windows`; sin la opción, la de la máquina) ───────────────────────────
 * Se conservan las dos reglas propias de cada plataforma, probadas por separado:
 *   · posix (el bloque de Python del `.sh`): un hook es «el mismo» si su comando nombra el MISMO ARCHIVO —por la ruta,
 *     por el enlace o con otra caja en un disco que no la distingue—; otra carpeta es otro hook.
 *     Normaliza el `git pull` de la línea de arranque y escribe `cleanupPeriodDays` y la variable de `env` del arnés.
 *   · windows (el bloque de PowerShell del `.ps1`): un hook es «el mismo» si su comando invoca la ruta del
 *     guion DENTRO DE SU REPO (`scripts/hooks/…` o `skills/…`), con cualquier raíz y cualquier intérprete (la carpeta
 *     se nombra por el clon, por el enlace o como `/c/…`). Un `.sh` va con `bash` a secas (la ruta absoluta del
 *     bash de Git entre comillas es un error de sintaxis si lo lanza PowerShell, y Claude Code lanza los hooks con el
 *     bash de Git). Un `.sh` con `\r\n` en el disco, o que no se pudo leer, no se
 *     registra. Lo que `platforms.windows: false` excluye no se toca.
 *   · las dos: una ruta con `$`, acento grave o comilla doble no se escribe en un comando (lo lee un shell) y se dice.
 *
 * ── SALIDAS ─────────────────────────────────────────────────────────────────────────────────────────────────────
 *   --report-out <archivo>   el informe de texto que imprime el `.sh` (ADDED/EXISTED/REMOVED/MISSING/NORMALIZED/BACKUP)
 *   --json-out <archivo>     el mismo informe en JSON (lo lee el `.ps1`)
 *   TYCON_REPORT_PIECES      (variable) cada pieza que queda: `hook<TAB>settings<TAB><EVENTO>:<spec>`
 *   TYCON_PLAN_PIECES        (variable, sólo con --check) el plan: lo mismo con la acción
 *
 * Uso:  node scripts/setup/apply-hooks.js --skills <carpeta skills> [--settings <archivo>] [--check]
 *         [--platform posix|windows] [--hooks-dir <scripts/hooks>] [--list <hooks-list.json>]
 *         [--effects <install-effects.json>] [--report-out <archivo>] [--json-out <archivo>]
 * Sale 0 si aplicó (o, con --check, si pudo revisar); 1 si la lista, el settings.json o la escritura fallaron.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// La carpeta de los mods del arnés en CLAUDE_CODE_PLUGIN_DIRS. Se carga recién al escribir settings.json:
// hay quien carga este archivo solo, sin su carpeta, para usar sus funciones (count-hooks.js, los laboratorios).
let pluginDirs = null;
const PDmod = () => pluginDirs || (pluginDirs = require('./harness/plugin-dirs.js'));

const SETUP_DIR = __dirname;
const SCRIPTS_DIR = path.dirname(SETUP_DIR);

// `Notification` y `SessionEnd` sirven al aviso de espera: el pedido de permiso y la sesión que se cierra
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'Notification', 'SessionEnd'];
const WHEN_RE = /^(always|integration:[a-z]+|optin:TYCON_[A-Z_]+)$/;
const NEEDS = new Set(['telegram-plugin']);
const STEP_RE = /^(all|\d+[a-z]?)$/;
const EFFECTS = ['blocks', 'warns', 'records'];
const ASYNC_ALLOWED = true;

class ApplyError extends Error {}

// ── La lista ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** El matcher como conjunto: «Edit|Write» = «Write|Edit», y un nombre repetido cuenta una vez (el frozenset del Python). */
function normMatcher(m) {
  return [...new Set(String(m || '').split(/[|,]/).map((x) => x.trim()).filter(Boolean))].sort().join('|');
}

/** Los problemas de forma de la lista, uno por línea, nombrando el registro. Vacío = sana. */
function validateList(list) {
  const out = [];
  if (!list || typeof list !== 'object' || Array.isArray(list)) return ['la lista no es un objeto JSON'];
  if (!Array.isArray(list.hooks) || list.hooks.length === 0) out.push('falta `hooks` (un arreglo con al menos un registro)');
  for (const k of ['superseded', 'legacy_fragments']) {
    if (list[k] !== undefined && !(Array.isArray(list[k]) && list[k].every((x) => typeof x === 'string' && x))) out.push(`\`${k}\` tiene que ser un arreglo de textos`);
  }
  const seen = new Set();
  (Array.isArray(list.hooks) ? list.hooks : []).forEach((h, i) => {
    const who = h && typeof h.spec === 'string' ? h.spec : `registro ${i}`;
    if (!h || typeof h !== 'object') { out.push(`${who}: no es un objeto`); return; }
    if (!EVENTS.includes(h.event)) out.push(`${who}: event «${h.event}» fuera del vocabulario (${EVENTS.join(', ')})`);
    if (typeof h.matcher !== 'string') out.push(`${who}: matcher tiene que ser un texto (vacío = sin matcher)`);
    if (typeof h.spec !== 'string' || !/\.(js|sh|py)$/.test(h.spec) || /["$`]/.test(h.spec)) out.push(`${who}: spec tiene que ser la ruta de un .js, .sh o .py, sin comillas ni $`);
    if (typeof h.label !== 'string' || !h.label) out.push(`${who}: falta label`);
    if (typeof h.when !== 'string' || !WHEN_RE.test(h.when)) out.push(`${who}: when «${h.when}» fuera del vocabulario (always · integration:<llave> · optin:<VARIABLE>)`);
    const optin = typeof h.when === 'string' && h.when.startsWith('optin:');
    if (optin && !['on', 'off'].includes(h.default)) out.push(`${who}: un opt-in lleva default on u off`);
    if (!optin && (h.default !== undefined || h.profile !== undefined || h.brake !== undefined || h.needs !== undefined)) out.push(`${who}: default/profile/brake/needs son sólo de un opt-in`);
    if (h.profile !== undefined && h.profile !== 'full-only') out.push(`${who}: profile sólo puede ser full-only`);
    // full-only describe un opt-in que nace PRENDIDO en full (en minimal, sólo con su variable en 1): con default off
    // `decide` no tendría qué hacer y lo prendería igual
    if (h.profile === 'full-only' && h.default !== 'on') out.push(`${who}: profile full-only va con default on (un opt-in que nace apagado no depende del perfil)`);
    if (h.brake !== undefined && h.brake !== true) out.push(`${who}: brake sólo puede ser true`);
    if (h.needs !== undefined && !NEEDS.has(h.needs)) out.push(`${who}: needs «${h.needs}» fuera del vocabulario (${[...NEEDS].join(', ')})`);
    if (h.override !== undefined && !(typeof h.override === 'string' && /^TYCON_[A-Z_]+$/.test(h.override) && String(h.when).startsWith('integration:'))) out.push(`${who}: override es una variable TYCON_ y sólo va en un hook de integración`);
    if (h.async !== undefined && (h.async !== true || !ASYNC_ALLOWED)) out.push(`${who}: async sólo puede ser true`);
    if (!h.platforms || typeof h.platforms !== 'object' || typeof h.platforms.windows !== 'boolean') out.push(`${who}: falta platforms.windows (true o false)`);
    // en qué pasos del pipeline actúa y qué hace: no cambian lo que se registra; los muestra «Cómo trabaja» del sitio
    // (que cada id sea un paso de verdad lo cruza la prueba del sitio contra la tabla de pasos). Sin ellos la lista se
    // aplica igual: son datos para mostrar, y que la lista real los traiga lo exige su prueba
    if (h.steps !== undefined && (!Array.isArray(h.steps) || !h.steps.length || !h.steps.every((s) => typeof s === 'string' && STEP_RE.test(s)))) out.push(`${who}: steps tiene que ser una lista de pasos del pipeline («4», «7c»…) o ["all"]`);
    if (h.effect !== undefined && !EFFECTS.includes(h.effect)) out.push(`${who}: effect «${h.effect}» fuera del vocabulario (${EFFECTS.join(', ')})`);
    const key = `${h.event}|${normMatcher(h.matcher)}|${h.spec}`;
    if (seen.has(key)) out.push(`${who}: registro repetido (${h.event}, ${h.matcher || 'sin matcher'})`);
    seen.add(key);
  });
  return out;
}

/** Lee y valida la lista. Tira ApplyError con el archivo y el motivo: una lista rota nunca es «no hay hooks». */
function loadList(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new ApplyError(`${file}: la lista de hooks no está (${e.code || e.message}) — no escribo nada: una lista que no se puede leer no es «no hay hooks»`);
  }
  let list;
  try { list = JSON.parse(text); } catch (e) {
    throw new ApplyError(`${file}: la lista de hooks no es JSON (${e.message}) — no escribo nada`);
  }
  const problems = validateList(list);
  if (problems.length) throw new ApplyError(`${file}: la lista de hooks no pasa su validación — no escribo nada:\n  · ${problems.join('\n  · ')}`);
  return { hooks: list.hooks, superseded: list.superseded || [], legacy: list.legacy_fragments || [] };
}

/** Los ids `<EVENTO>:<spec>` que la lista de efectos marca `minimal`. null si no se pudo leer. */
function loadMinimalIds(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(j.effects.filter((e) => e.kind === 'hook' && (e.profiles || []).includes('minimal')).map((e) => e.id));
  } catch (_) { return null; }
}

// ── La configuración del arnés ───────────────────────────────────────────────────────────────────────────────────

/**
 * Integraciones y perfil, como los lee el instalador: con el comando de tycon-config.js (sus códigos de salida).
 * `runConfig(args)` (opcional): con qué correr ese comando. Lo pasa la tanda del aplicador
 * (scripts/setup/applier-batch.js), que lo corre en su mismo proceso; devuelve `{ status, stdout }` como `spawnSync`.
 * Sin él, un proceso de Node por pregunta.
 */
function readConfig({ env = process.env, libDir = path.join(SCRIPTS_DIR, 'lib'), runConfig = null } = {}) {
  const cfg = path.join(libDir, 'tycon-config.js');
  const integ = { state: 'sin-lector', values: {} };
  const profile = { state: 'sin-lector', value: undefined };
  if (!fs.existsSync(cfg)) return { integ, profile };
  const ask = (args) => (runConfig ? runConfig(args) : spawnSync(process.execPath, [cfg, ...args], { encoding: 'utf8', env }));
  const r = ask(['integrations', '--shell']);
  if (r.status === 0) {
    integ.state = 'ok';
    for (const line of String(r.stdout).split(/\r?\n/)) {
      const m = /^TYCON_INTEG_([A-Z]+)=(0|1|detect)$/.exec(line.trim());
      if (m) integ.values[m[1].toLowerCase()] = m[2];
    }
  } else if (r.status === 2) integ.state = 'rota';
  const p = ask(['get', 'install.profile']);
  const out = String(p.stdout || '').trim();
  if (p.status === 3) profile.state = 'ok';
  else if (p.status === 0 && (out === 'minimal' || out === 'full')) { profile.state = 'ok'; profile.value = out; }
  else profile.state = 'rota';
  return { integ, profile };
}

// ── Qué hooks van (integraciones, perfil, opt-in) ────────────────────────────────────

/**
 * @param {{hooks: object[]}} list
 * @param {{env: object, integ: {state, values}, profile: {state, value}, minimalIds: Set|null, platform: string,
 *          has: (need: string) => boolean}} ctx
 * @returns {{active: object[], known: string[], profileOff: Set<string>, leave: Set<string>}}
 *   active: los registros que van, en el orden de la lista · known: los spec que se SACAN si no están en active ·
 *   profileOff: los que se sacan por el perfil (su línea lo dice) · leave: los que dependen del perfil y quedan como están
 */
function decide(list, ctx) {
  const env = ctx.env || {};
  const v = (name) => (env[name] === undefined || env[name] === null ? '' : String(env[name]));
  let pstate = ctx.profile && ctx.profile.state;
  const pvalue = ctx.profile && ctx.profile.value;
  const minimalIds = ctx.minimalIds || new Set();
  // minimal sin la lista de qué trae: no se puede decidir, queda como estaba (el instalador lo dice)
  if (pstate === 'ok' && pvalue === 'minimal' && minimalIds.size === 0) pstate = 'rota';
  const isMinimal = pstate === 'ok' && pvalue === 'minimal';
  const isFull = pstate === 'ok' && !isMinimal;
  const integOk = ctx.integ && ctx.integ.state === 'ok';
  const integOn = (k) => integOk && ctx.integ.values[k] === '1';
  const windows = ctx.platform === 'windows';
  const has = ctx.has || (() => false);

  const active = [];
  const known = [];
  const addKnown = (s) => { if (!known.includes(s)) known.push(s); };
  const profileOff = new Set();
  const leave = new Set();

  for (const h of list.hooks) {
    if (windows && h.platforms.windows === false) continue;   // lo excluido en Windows no se registra ni se saca
    const [kind, arg] = h.when.split(':');
    if (kind === 'integration') {
      if (h.override) {
        const o = v(h.override);
        const on = o ? o !== '0' : integOn(arg);
        if (integOk || o) addKnown(h.spec);
        if (on) active.push(h);
      } else {
        if (integOk) addKnown(h.spec);
        if (integOn(arg)) active.push(h);
      }
      continue;
    }
    if (kind === 'always') {
      if (isFull) { active.push(h); continue; }
      if (minimalIds.has(`${h.event}:${h.spec}`)) { active.push(h); continue; }
      if (isMinimal) { profileOff.add(h.spec); addKnown(h.spec); }
      else leave.add(h.spec);
      continue;
    }
    // optin:<VARIABLE>
    const val = v(arg);
    if (h.profile === 'full-only') {
      let op;
      if (isMinimal) op = val === '1' ? 0 : 1;
      else if (val === '0') op = 1;
      else if (pstate !== 'ok' && !val && !h.brake) op = 2;
      else op = 0;
      if (op === 1 && isMinimal && val !== '0') profileOff.add(h.spec);
      if (op === 2) { leave.add(h.spec); continue; }
      addKnown(h.spec);
      if (op === 0 && (!h.needs || has(h.needs))) active.push(h);
      continue;
    }
    addKnown(h.spec);
    const on = h.default === 'on' ? val !== '0' : val === '1';
    if (on && (!h.needs || has(h.needs))) active.push(h);
  }
  return { active, known, profileOff, leave, full: isFull };
}

// ── Identidad de un hook (las dos reglas de hoy) ─────────────────────────────────────────────────────────────────

const QUOTED = /"([^"]+)"/g;
const caseBlindCache = new Map();
const fileIdCache = new Map();

/** realpath que, como os.path.realpath de Python, resuelve lo que existe y deja el resto como está. */
function looseRealpath(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(head), ...tail); } catch (_) { /* sigue subiendo */ }
    const parent = path.dirname(head);
    if (parent === head) return path.join(head, ...tail);
    tail.unshift(path.basename(head));
    head = parent;
  }
}
function swapcase(s) { return s.replace(/[a-zA-ZÀ-ÿ]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())); }
/** ¿El disco de `p` NO distingue mayúsculas? Se mide en la carpeta existente más cercana cuyo nombre tenga letras. */
function caseBlind(p) {
  let d = p;
  for (;;) {
    const name = path.basename(d);
    if (swapcase(name) !== name && fs.existsSync(d)) break;
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
  if (!caseBlindCache.has(d)) {
    let r = false;
    try {
      const a = fs.statSync(d, { bigint: true });
      const b = fs.statSync(path.join(path.dirname(d), swapcase(path.basename(d))), { bigint: true });
      r = a.dev === b.dev && a.ino === b.ino;
    } catch (_) { r = false; }
    caseBlindCache.set(d, r);
  }
  return caseBlindCache.get(d);
}
/** Qué archivo es `p`: dispositivo e inodo; si no está en el disco, su ruta real con la caja que diga el disco. */
function fileId(p) {
  if (fileIdCache.has(p)) return fileIdCache.get(p);
  let k = null;
  try {
    const st = fs.statSync(p, { bigint: true });
    if (st.ino) k = `file:${st.dev}:${st.ino}`;
  } catch (_) { k = null; }
  if (!k) {
    const r = looseRealpath(p);
    k = `path:${caseBlind(r) ? r.toLowerCase() : r}`;
  }
  fileIdCache.set(p, k);
  return k;
}
function quotedPaths(cmd) { return [...String(cmd).matchAll(QUOTED)].map((m) => m[1]); }
/** posix: ¿el comando nombra ese archivo? Tal cual, o por otra ruta absoluta (entre comillas) al mismo archivo. */
function namesFile(cmd, abs) {
  if (String(cmd).includes(abs)) return true;
  const want = fileId(abs);
  return quotedPaths(cmd).some((q) => path.isAbsolute(q) && q !== abs && fileId(q) === want);
}
/** windows: ¿el comando INVOCA ese guion? `<intérprete> "<raíz>/<ruta en su repo>"`, hasta el final del comando. */
function invokesRepoPath(cmd, repoPath) {
  if (!cmd || !repoPath) return false;
  const c = String(cmd).replace(/\\/g, '/').trim();
  const rel = repoPath.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:"[^"]+"|[^\\s"]+)\\s+"[^"]*/${rel}"(?:\\s|$)`, 'i').test(c);
}

// ── Aplicar ──────────────────────────────────────────────────────────────────────────────────────────────────────

function runnerFor(spec) {
  if (spec.endsWith('.sh')) return 'bash';
  if (spec.endsWith('.py')) return 'python3';
  return 'node';
}
// Un hook `.js` en cualquiera de sus dos formas: `node "<guion>"` o la ruta del Node del arnés,
// sin comillas (`…/node/current/bin/node "<guion>"`, `C:/…/node.exe "<guion>"`) o con comillas (`"…/node" "<guion>"`).
const JS_RUNNER = /(?:^|[\s/"])node(?:\.exe)?"?\s+"/i;
/** El intérprete escrito al principio de un comando: lo que va antes de ` "<guion>"` (con sus comillas si las trae). */
function leadingInterpreter(cmd) {
  const m = /^\s*("[^"]+"|[^\s"]+)\s+"/.exec(String(cmd || ''));
  return m ? m[1] : null;
}
const fwd = (p) => String(p).replace(/\\/g, '/');
const nameOf = (spec) => spec.replace(/^@tcg:/, '');

/** Tres resultados, nunca dos: tiene \r\n · no tiene · no se pudo leer (con el motivo). */
function crlfOnDisk(p) {
  try { return { ok: true, crlf: fs.readFileSync(p, 'utf8').includes('\r\n'), reason: null }; } catch (e) { return { ok: false, crlf: false, reason: e.message }; }
}
function unsafeChar(p) { for (const ch of ['$', '`', '"']) if (String(p).includes(ch)) return ch; return null; }

function lugarCanonico(indices, mio) {
  let antes = -1; let despues = -1;
  indices.forEach((k, j) => {
    if (k === null || k === undefined) return;
    if (k < mio) antes = j;
    else if (k > mio && despues < 0) despues = j;
  });
  if (antes >= 0) return antes + 1;
  if (despues >= 0) return despues;
  return indices.length;
}

/**
 * El lugar en el orden del arnés de un hook ya registrado (`null` = es ajeno). Por la INVOCACIÓN, no por un pedazo del
 * texto: un comando ajeno que sólo menciona la ruta no es ese hook, y `retro-pending.js` no es
 * `pending.js`.
 *   posix   `orden`: Map `${evento}\0${ruta absoluta}` → índice; cuenta si el comando trae `"<ruta>"` y no es `bash -c`/`sh -c`.
 *   windows `ordenWin`: [{ ev, repoPath, idx }]; cuenta si el comando invoca la ruta del guion en su repo (invokesRepoPath).
 */
function harnessIndexOf(ev, hk, { windows, orden = new Map(), ordenWin = [] }) {
  const cmd = hk && typeof hk === 'object' && typeof hk.command === 'string' ? hk.command : '';
  if (windows) { const o2 = ordenWin.find((x) => x.ev === ev && invokesRepoPath(cmd, x.repoPath)); return o2 ? o2.idx : null; }
  if (/^\s*(bash -c|sh -c)/.test(cmd)) return null;
  for (const [k, idx] of orden) { const [e, ap] = k.split('\0'); if (e === ev && cmd.includes(`"${ap}"`)) return idx; }
  return null;
}

const PULL_FLAGS = ['--ff-only', '--autostash'];
const PULL_RES = [
  /(cd\s+\S*(?:tycon-claude-guides|agent-skills)\S*\s*(?:&&|;)\s*git\s+pull)((?:\s+--[\w-]+(?:=\S+)?)*)/g,
  /(git\s+-C\s+\S*(?:tycon-claude-guides|agent-skills)\S*\s+pull)((?:\s+--[\w-]+(?:=\S+)?)*)/g,
];
function normalizePullLine(cmd) {
  let changed = false;
  let out = cmd;
  for (const rx of PULL_RES) {
    out = out.replace(rx, (all, head, flags = '') => {
      const present = new Set(flags.split(/\s+/).filter(Boolean));
      const faltan = PULL_FLAGS.filter((f) => !present.has(f) && !present.has(f.replace('--', '--no-')));
      if (!faltan.length) return all;
      changed = true;
      return `${head} ${faltan.join(' ')}${flags}`;
    });
  }
  return { cmd: out, changed };
}

const TOP_CANONICAL = { cleanupPeriodDays: 365 };
const ENV_CANONICAL = { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' };

/**
 * Aplica la decisión sobre el objeto `settings` (lo modifica). Devuelve el resultado; no escribe nada.
 * @param {object} settings
 * @param {{list, decision, platform, hooksDir, skills, check, env, settingsPath}} o
 */
function applyToSettings(settings, o) {
  const windows = o.platform === 'windows';
  const env = o.env || {};
  const resolve = (spec) => (spec.startsWith('@tcg:') ? path.join(o.hooksDir, spec.slice(5)) : path.join(o.skills, spec));
  const repoPathOf = (spec) => (spec.startsWith('@tcg:') ? `scripts/hooks/${spec.slice(5)}` : `skills/${spec}`);
  const repoOf = (spec) => (spec.startsWith('@tcg:') ? path.dirname(path.dirname(o.hooksDir)) : path.dirname(o.skills));
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};
  const hooks = settings.hooks;
  const r = { added: [], existed: [], removed: [], missing: [], notInstalled: [], deferred: [], normalized: [], reformed: [], present: [], topAdded: [], envAdded: [] };
  // con qué se escribe un hook `.js`: lo decide harness-node.js#interpreter mirando el disco; quien no
  // lo pasa (una prueba, un llamador viejo) queda con `node`
  const jsPrefix = (o.interp && o.interp.prefix) || 'node';
  const active = o.decision.active;
  const activeSpecs = new Set(active.map((h) => h.spec));
  const inactive = o.decision.known.filter((s) => !activeSpecs.has(s));
  const cmdOf = (hk) => (hk && typeof hk === 'object' && typeof hk.command === 'string' ? hk.command : '');

  // 1 · sacar lo reemplazado, lo apagado y lo viejo
  for (const ev of Object.keys(hooks)) {
    const bucket = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const next = [];
    for (const entry of bucket) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) { if (windows) next.push(entry); continue; }
      const kept = [];
      for (const hk of entry.hooks) {
        const cmd = cmdOf(hk);
        const cmdFwd = fwd(cmd);
        let why = null; let what = null;
        const sup = o.list.superseded.find((s) => (windows ? invokesRepoPath(cmd, s) : cmd.includes(s) && JS_RUNNER.test(cmd)));
        if (sup) { what = sup; why = 'superseded by H10 dispatcher'; }
        if (!what) {
          const off = inactive.find((s) => (windows ? invokesRepoPath(cmd, repoPathOf(s)) : namesFile(cmd, resolve(s))));
          if (off) { what = off; why = o.decision.profileOff.has(off) ? 'fuera del perfil minimal' : 'disabled by env var'; }
        }
        if (!what) {
          const lf = o.list.legacy.find((f) => cmd.includes(f) || (windows && cmdFwd.includes(f)));
          if (lf) { what = lf; why = 'legacy path migrado a @tcg (repo guides)'; }
        }
        if (what) r.removed.push({ event: ev, relpath: what, why }); else kept.push(hk);
      }
      if (kept.length) { entry.hooks = kept; next.push(entry); }
    }
    if (next.length) hooks[ev] = next; else delete hooks[ev];
  }

  // 2 · el orden canónico y los matchers con que la lista registra cada guion
  const orden = new Map();   // posix: `${ev}\0${abs}` → idx · windows: lista de {ev, repoPath, idx}
  const ordenWin = [];
  active.forEach((h, i) => {
    const abs = resolve(h.spec);
    if (!orden.has(`${h.event}\0${abs}`)) orden.set(`${h.event}\0${abs}`, i);
    ordenWin.push({ ev: h.event, repoPath: repoPathOf(h.spec), idx: i });
  });
  if (!windows) {
    const byFile = new Map([...orden].map(([k, i]) => { const [ev, abs] = k.split('\0'); return [`${ev}\0${fileId(abs)}`, i]; }));
    for (const [ev, bucket] of Object.entries(hooks)) {
      for (const entry of Array.isArray(bucket) ? bucket : []) {
        for (const hk of entry && Array.isArray(entry.hooks) ? entry.hooks : []) {
          for (const q of quotedPaths(cmdOf(hk))) {
            if (path.isAbsolute(q) && !orden.has(`${ev}\0${q}`) && byFile.has(`${ev}\0${fileId(q)}`)) orden.set(`${ev}\0${q}`, byFile.get(`${ev}\0${fileId(q)}`));
          }
        }
      }
    }
  }
  const indiceDelArnes = (ev, hk) => harnessIndexOf(ev, hk, { windows, orden, ordenWin });
  const wanted = new Map();
  for (const h of active) {
    const k = `${h.event}\0${windows ? repoPathOf(h.spec) : resolve(h.spec)}`;
    if (!wanted.has(k)) wanted.set(k, new Set());
    wanted.get(k).add(normMatcher(h.matcher));
  }
  const isStrictSubset = (a, b) => { const A = a.split('|').filter(Boolean); const B = new Set(b.split('|').filter(Boolean)); return A.length > 0 && A.length < B.size && A.every((x) => B.has(x)); };
  // un `.js` es el mismo hook en las dos formas del intérprete: se reconoce y se reescribe en su lugar
  const sameHook = (cmd, h, abs, runner) => (windows ? invokesRepoPath(cmd, repoPathOf(h.spec)) : namesFile(cmd, abs) && (runner === 'node' ? JS_RUNNER.test(cmd) : cmd.includes(`${runner} "`)));
  // el comando con el intérprete que corresponde, si el de hoy es otro: sólo se cambia el intérprete (el guion queda escrito
  // como estaba); null si ya está bien o no es un `.js`
  const reform = (cmd, runner) => {
    if (runner !== 'node') return null;
    const now = leadingInterpreter(cmd);
    // sólo un intérprete que es un Node (`node`, o una ruta que termina en node/node.exe): otro comando no se toca
    if (!now || now === jsPrefix || !/(?:^|[/"])node(?:\.exe)?"?$/i.test(now)) return null;
    return `${jsPrefix}${String(cmd).replace(/^\s*/, '').slice(now.length)}`;
  };
  const takeNarrower = (bucket, h, abs, runner) => {
    const taken = [];
    const target = normMatcher(h.matcher);
    if (!target) return taken;
    const want = wanted.get(`${h.event}\0${windows ? repoPathOf(h.spec) : abs}`) || new Set();
    for (const entry of [...bucket]) {
      const old = entry && typeof entry === 'object' && typeof entry.matcher === 'string' ? entry.matcher : '';
      const oldN = normMatcher(old);
      if (!oldN || !isStrictSubset(oldN, target) || want.has(oldN)) continue;
      if (!entry || !Array.isArray(entry.hooks)) continue;
      const keep = [];
      for (const hk of entry.hooks) { if (sameHook(cmdOf(hk), h, abs, runner)) taken.push({ hook: hk, matcher: old }); else keep.push(hk); }
      if (keep.length === entry.hooks.length) continue;
      if (keep.length) entry.hooks = keep; else bucket.splice(bucket.indexOf(entry), 1);
    }
    return taken;
  };

  const deferSh = windows && env.TYCON_HARNESS_LOCK_HELD === '1' && env.TYCON_HARNESS_GIT_BASH_HEALTH !== '1' && !o.check;

  // 3 · registrar
  active.forEach((h, specIdx) => {
    const abs = resolve(h.spec);
    const id = `${h.event}:${h.spec}`;
    const runner = runnerFor(h.spec);
    const isSh = runner === 'bash';
    const repo = repoOf(h.spec);
    if (!fs.existsSync(abs)) {
      r.missing.push({ event: h.event, matcher: h.matcher, relpath: h.spec, label: h.label });
      if (windows) r.notInstalled.push({ kind: 'missing', event: h.event, relpath: nameOf(h.spec), repo });
      return;
    }
    const absCmd = windows ? fwd(abs) : abs;
    // En Windows un .sh también va con `bash` a secas: con la ruta absoluta del bash de Git entre comillas, el comando
    // lanzado por PowerShell es un error de sintaxis y sale 1 aun con una entrada legítima; y Claude Code en Windows
    // lanza cada hook con el bash de Git, donde `bash` es ese mismo bash: la ruta absoluta no suma nada.
    // un `.js` con el Node del arnés si está (sin comillas, o con comillas en Mac y Linux si la ruta trae
    // espacios); si no, `node`. La ruta del intérprete nunca deja un hook sin registrar: lo decide sólo la del guion
    const command = `${runner === 'node' ? jsPrefix : runner} "${absCmd}"`;
    const eol = windows && isSh ? crlfOnDisk(abs) : null;
    const crlf = !!(eol && eol.ok && eol.crlf);
    const unverified = !!(eol && !eol.ok);

    const bucketExisted = Array.isArray(hooks[h.event]);
    const bucket = bucketExisted ? hooks[h.event] : [];
    const target = normMatcher(h.matcher);
    let found = null;
    for (const entry of bucket) {
      if (!entry || typeof entry !== 'object' || normMatcher(entry.matcher) !== target || !Array.isArray(entry.hooks)) continue;
      found = entry.hooks.find((hk) => sameHook(cmdOf(hk), h, abs, runner)) || null;
      if (found) break;
    }
    const deferThis = deferSh && isSh;
    if (found && deferThis) { r.existed.push({ event: h.event, relpath: h.spec, deferred: true }); r.planKeep = (r.planKeep || []).concat(id); return; }
    let carried = null;
    if (!deferThis) {
      const narrow = takeNarrower(bucket, h, abs, runner);
      for (const n of (found ? narrow : narrow.slice(1))) r.removed.push({ event: h.event, relpath: h.spec, why: `duplicado con el matcher viejo «${n.matcher}»: queda el de «${h.matcher}»` });
      if (!found && narrow.length) carried = narrow[0];
    }
    const warnRegistered = () => {
      if (crlf) r.notInstalled.push({ kind: 'crlf-registered', event: h.event, relpath: nameOf(h.spec), repo });
      if (unverified) r.notInstalled.push({ kind: 'unverified-registered', event: h.event, relpath: nameOf(h.spec), repo, path: fwd(abs), reason: eol.reason });
    };
    if (found) {
      // el mismo hook en la otra forma del intérprete: se reescribe ESE comando, en su lugar (misma posición, matcher y
      // `async`), y se informa como cambio de forma
      const next = reform(cmdOf(found), runner);
      if (next) { r.reformed.push({ event: h.event, relpath: h.spec, from: leadingInterpreter(cmdOf(found)), to: jsPrefix }); found.command = next; }
      r.existed.push({ event: h.event, relpath: h.spec });
      r.present.push(id);
      warnRegistered();
      return;
    }
    if (deferThis) { if (!r.deferred.includes(nameOf(h.spec))) r.deferred.push(nameOf(h.spec)); return; }
    if (carried) warnRegistered();
    else if (crlf) { r.notInstalled.push({ kind: 'crlf', event: h.event, relpath: nameOf(h.spec), repo }); return; }
    if (unverified && !carried) { r.notInstalled.push({ kind: 'unverified', event: h.event, relpath: nameOf(h.spec), repo, path: fwd(abs), reason: eol.reason }); return; }
    if (!carried) {
      // una ruta con `$`, acento grave o comilla doble: el comando lo lee un shell, que leería otra ruta. No se escribe un
      // comando roto, en ninguna plataforma
      const ch = unsafeChar(absCmd);
      if (ch) { r.notInstalled.push({ kind: 'unsafe-path', event: h.event, relpath: nameOf(h.spec), repo, path: absCmd, char: ch }); return; }
    }
    let hookObj; let label = h.label;
    if (carried) {
      hookObj = carried.hook; label = `${h.label} — matcher ampliado de «${carried.matcher}» a «${h.matcher}»`;
      const next = reform(cmdOf(hookObj), runner);
      if (next) { r.reformed.push({ event: h.event, relpath: h.spec, from: leadingInterpreter(cmdOf(hookObj)), to: jsPrefix }); hookObj.command = next; }
    }
    else { hookObj = { type: 'command', command }; if (h.async) hookObj.async = true; }
    let appended = false;
    for (const entry of bucket) {
      if (entry && typeof entry === 'object' && normMatcher(entry.matcher) === target) {
        if (!Array.isArray(entry.hooks)) entry.hooks = [];
        entry.hooks.splice(lugarCanonico(entry.hooks.map((x) => indiceDelArnes(h.event, x)), specIdx), 0, hookObj);
        appended = true;
        break;
      }
    }
    if (!appended) {
      const newEntry = { hooks: [hookObj] };
      if (h.matcher) newEntry.matcher = h.matcher;
      const primeros = bucket.map((e) => {
        const ks = (e && Array.isArray(e.hooks) ? e.hooks : []).map((x) => indiceDelArnes(h.event, x)).filter((k) => k !== null);
        return ks.length ? Math.min(...ks) : null;
      });
      bucket.splice(lugarCanonico(primeros, specIdx), 0, newEntry);
    }
    if (!bucketExisted) hooks[h.event] = bucket;
    r.added.push({ event: h.event, matcher: h.matcher, relpath: h.spec, label });
    r.present.push(id);
  });

  // 4 · posix: la línea de arranque y las dos claves del arnés (como el bloque de Python del .sh)
  if (!windows) {
    for (const entry of Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []) {
      for (const hk of entry && Array.isArray(entry.hooks) ? entry.hooks : []) {
        const cmd = cmdOf(hk);
        if (!cmd.includes('pull')) continue;
        const n = normalizePullLine(cmd);
        if (n.changed) { hk.command = n.cmd; r.normalized.push(cmd); }
      }
    }
  }
  return r;
}

// ── El comando ───────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const x = argv[++i]; if (x === undefined) throw new ApplyError(`apply-hooks: ${k} pide un valor`); return x; };
    if (k === '--check') a.check = true;
    else if (k === '--settings') a.settings = val();
    else if (k === '--platform') a.platform = val();
    else if (k === '--hooks-dir') a.hooksDir = val();
    else if (k === '--skills') a.skills = val();
    else if (k === '--list') a.list = val();
    else if (k === '--effects') a.effects = val();
    else if (k === '--report-out') a.reportOut = val();
    else if (k === '--json-out') a.jsonOut = val();
    else throw new ApplyError(`apply-hooks: no conozco la opción ${k}`);
  }
  return a;
}

/** Anota líneas en el temporal de piezas o del plan. Devuelve false si no pudo (y lo dice): quien llama decide si frena. */
function appendLines(file, lines) {
  if (!file || !lines.length) return true;
  try { fs.appendFileSync(file, lines.map((l) => `${l}\n`).join('')); return true; } catch (e) {
    process.stderr.write(`⚠ tycon: no pude anotar los hooks y ajustes en ${file} (${e.message})\n`);
    return false;
  }
}

function main(argv = process.argv.slice(2), env = process.env, { runConfig = null } = {}) {
  const a = parseArgs(argv);
  const platform = a.platform || (process.platform === 'win32' ? 'windows' : 'posix');
  if (!['posix', 'windows'].includes(platform)) throw new ApplyError(`apply-hooks: --platform es posix o windows, no «${platform}»`);
  const windows = platform === 'windows';
  const home = os.homedir();
  const settingsPath = path.resolve(a.settings || env.TYCON_SETTINGS_PATH || path.join(home, '.claude', 'settings.json'));
  const hooksDir = path.resolve(a.hooksDir || path.join(SCRIPTS_DIR, 'hooks'));
  if (!a.skills) throw new ApplyError('apply-hooks: falta --skills (la carpeta skills/ del arnés)');
  const skills = path.resolve(a.skills);
  const list = loadList(a.list || path.join(SETUP_DIR, 'hooks-list.json'));

  let raw = '';
  let existed = true;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw new ApplyError(`${settingsPath}: no pude leer settings.json (${e.message}) — no lo toco`);
    existed = false;
  }
  // un BOM al principio es válido en Windows y no lo hace ilegible (como harness/shared.js, managed.js y remove.js):
  // ConvertFrom-Json lo acepta, y sin esto el instalador de Windows entero se caería
  raw = raw.replace(/^﻿/, '');
  let settings;
  try { settings = raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
    throw new ApplyError(`${settingsPath}: settings.json no es JSON (${e.message}) — no lo toco; arreglalo (o restaurá su copia .bak) y volvé a correr el instalador`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new ApplyError(`${settingsPath}: settings.json no es un objeto JSON — no lo toco`);

  const { integ, profile } = readConfig({ env, runConfig });
  const minimalIds = loadMinimalIds(a.effects || path.join(SETUP_DIR, 'install-effects.json'));
  const has = (need) => need === 'telegram-plugin' && fs.existsSync(path.join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram'));
  const decision = decide(list, { env, integ, profile, minimalIds, platform, has });
  // el intérprete de los hooks `.js`: mirando el disco, también si este instalador corre suelto
  const interp = require('./harness/harness-node.js').interpreter({ env, platform: windows ? 'win32' : (process.platform === 'win32' ? 'linux' : process.platform) });
  const r = applyToSettings(settings, { list, decision, platform, hooksDir, skills, check: a.check, env, settingsPath, interp });

  // las dos claves del arnés (posix): como el .sh, salvo que las haya hecho harness.js o el perfil no sea full
  // fuera de full (minimal, o el perfil sin saber) las dos claves tampoco se escriben ni se anotan; en
  // Windows las hace harness.js (scripts/setup/harness/shared.js)
  const sharedDone = windows || env.TYCON_HARNESS_SHARED_DONE === '1' || !decision.full;
  const added = r.added.map((x) => [x.event, x.matcher, x.relpath, x.label]);
  if (!sharedDone) {
    for (const [k, v] of Object.entries(TOP_CANONICAL)) if (!(k in settings)) { settings[k] = v; r.topAdded.push(k); }
    if (r.topAdded.length) added.push(['settings', '', `settings:${r.topAdded.join(',')}`, 'clave canónica del arnés']);
  }
  const removed = r.removed.map((x) => [x.event, x.relpath, x.why]);
  const lines = [];
  if (r.normalized.length) lines.push(`NORMALIZED:${r.normalized.length}`);
  if (r.reformed.length) { lines.push(`REFORMED:${r.reformed.length}`); for (const x of r.reformed) lines.push(`  ~ ${x.event} → ${x.relpath}  [${x.from} → ${x.to}]`); }
  if (added.length) { lines.push(`ADDED:${added.length}`); for (const [e, m, p, l] of added) lines.push(`  + ${e} (matcher='${m || '*'}') → ${p}  [${l}]`); }
  if (r.existed.length) lines.push(`EXISTED:${r.existed.length}`);
  if (removed.length) { lines.push(`REMOVED:${removed.length}`); for (const [e, p, w] of removed) lines.push(`  - ${e} → ${p}  [${w}]`); }
  if (r.missing.length) { lines.push(`MISSING:${r.missing.length}`); for (const x of r.missing) lines.push(`  ! ${x.event} (matcher='${x.matcher || '*'}') → ${x.relpath}`); }
  // las rutas que un shell leería mal (en Windows lo imprime el .ps1 desde el JSON)
  const unsafe = r.notInstalled.filter((n) => n.kind === 'unsafe-path');
  if (!windows && unsafe.length) { lines.push(`UNSAFE:${unsafe.length}`); for (const n of unsafe) lines.push(`  !! ${n.event} → ${n.relpath}  [la ruta trae «${n.char}»: ${n.path}]`); }

  // la variable de `env` (después del informe, como en el .sh: escribe el archivo pero no tiene línea propia)
  const envObj = sharedDone ? {} : (settings.env && typeof settings.env === 'object' ? settings.env : (settings.env = {}));
  // la carpeta de los mods del arnés (la misma unión que shared.js): con TYCON_NO_MODS=1 no se toca
  const PD = sharedDone || env.TYCON_NO_MODS === '1' ? null : PDmod();
  if (!sharedDone) {
    for (const [k, v] of Object.entries(ENV_CANONICAL)) if (!(k in envObj)) { envObj[k] = v; r.envAdded.push(k); }
    const dirs = !PD ? { changed: false } : PD.addDir(envObj[PD.PLUGIN_DIRS_KEY], PD.ourDir(home), { sep: PD.separator(platform), home, inherited: env[PD.PLUGIN_DIRS_KEY] });
    if (dirs.changed) { envObj[PD.PLUGIN_DIRS_KEY] = dirs.value; r.envAdded.push(PD.PLUGIN_DIRS_KEY); r.pluginDirsAdded = true; }
    if (r.envAdded.length) added.push(['env', '', `env:${r.envAdded.join(',')}`, 'variable canónica del arnés']);
  }
  const modsPiece = Boolean(PD) && PD.hasDir(envObj[PD.PLUGIN_DIRS_KEY], PD.ourDir(home), { sep: PD.separator(platform), home });

  const where = settingsPath;
  appendLines(env.TYCON_REPORT_PIECES, [
    ...r.present.map((id) => `hook\t${where}\t${id}`),
    ...(sharedDone ? [] : [
      ...Object.entries(TOP_CANONICAL).filter(([k, v]) => settings[k] === v).map(([k, v]) => `setting\t${where}\t${k}\t${JSON.stringify(v)}`),
      ...Object.entries(ENV_CANONICAL).filter(([k, v]) => envObj[k] === v).map(([k, v]) => `setting\t${where}\tenv.${k}\t${JSON.stringify(v)}`),
      ...(modsPiece ? [`setting\t${where}\t${PD.PLUGIN_DIRS_ID}\t${JSON.stringify(PD.ourDir(home))}`] : []),
    ]),
  ]);
  if (a.check) {
    const fresh = new Set(r.added.filter((x) => !x.rewritten).map((x) => `${x.event}:${x.relpath}`));
    const rewritten = new Set([...r.added.filter((x) => x.rewritten), ...r.reformed].map((x) => `${x.event}:${x.relpath}`));
    // un plan al que le falta algo no se muestra: si no se pudo anotar, sale distinto de 0 y el instalador no arma el plan
    const planOk = appendLines(env.TYCON_PLAN_PIECES, [
      ...r.present.map((id) => `hook\t${where}\t${id}\t${fresh.has(id) ? 'add' : rewritten.has(id) ? 'update' : 'keep'}`),
      ...(r.planKeep || []).map((id) => `hook\t${where}\t${id}\tkeep`),
      ...r.removed.map((x) => `hook\t${where}\t${x.event}:${x.relpath}\tremove`),
      ...r.normalized.map((c) => `pull-line\t${where}\t${c.split(/\s+/).filter(Boolean).join(' ')}\tupdate`),
      ...(sharedDone ? [] : [
        ...Object.entries(TOP_CANONICAL).map(([k, v]) => (r.topAdded.includes(k) ? `setting\t${where}\t${k}\tadd` : settings[k] === v ? `setting\t${where}\t${k}\tkeep` : null)).filter(Boolean),
        ...Object.entries(ENV_CANONICAL).map(([k, v]) => (r.envAdded.includes(k) ? `setting\t${where}\tenv.${k}\tadd` : envObj[k] === v ? `setting\t${where}\tenv.${k}\tkeep` : null)).filter(Boolean),
        ...(modsPiece ? [`setting\t${where}\t${PD.PLUGIN_DIRS_ID}\t${r.pluginDirsAdded ? 'add' : 'keep'}`] : []),
      ]),
    ]);
    if (!planOk) throw new ApplyError(`no pude anotar los hooks en el plan (${env.TYCON_PLAN_PIECES}): el plan quedaría incompleto y no se escribe`);
  }

  const changed = added.length > 0 || removed.length > 0 || r.normalized.length > 0 || r.reformed.length > 0;
  let backup = null;
  if (!a.check && changed) {
    if (existed && !env.TYCON_HARNESS_SNAPSHOT_DIR) {
      const ts = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}T${pad(ts.getHours())}-${pad(ts.getMinutes())}-${pad(ts.getSeconds())}`;
      backup = `${settingsPath}.bak.${stamp}`;
      fs.copyFileSync(settingsPath, backup);
      lines.push(`BACKUP:${backup}`);
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const tmp = path.join(path.dirname(settingsPath), `.settings.${process.pid}.${Date.now()}.tmp`);
    // los permisos: los del archivo que estaba; uno nuevo nace 0600 (settings.json suele guardar tokens en `env`)
    let mode = 0o600;
    try { if (existed) mode = fs.statSync(settingsPath).mode & 0o777; } catch (_) { mode = 0o600; }
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
      fs.chmodSync(tmp, mode);   // writeFileSync aplica la umask: el permiso exacto, aparte
      fs.renameSync(tmp, settingsPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* no quedó */ }
      throw new ApplyError(`${settingsPath}: no pude escribir settings.json (${e.message})`);
    }
  }
  if (a.reportOut) fs.writeFileSync(a.reportOut, lines.length ? `${lines.join('\n')}\n` : '');
  if (a.jsonOut) {
    fs.writeFileSync(a.jsonOut, `${JSON.stringify({
      platform, settings: settingsPath, check: a.check, changed, backup,
      added: r.added, existed: r.existed.length, removed: r.removed, missing: r.missing, notInstalled: r.notInstalled,
      deferred: r.deferred, normalized: r.normalized.length, reformed: r.reformed, topAdded: r.topAdded, envAdded: r.envAdded,
      profileLeave: [...decision.leave], profileOff: [...decision.profileOff],
    }, null, 2)}\n`);
  }
  return 0;
}

/**
 * La línea de comandos entera, como función: lo mismo que corre el arranque de este archivo como programa,
 * con su `try/catch`. Devuelve el código de salida. La llama la tanda del aplicador (scripts/setup/applier-batch.js),
 * que le pasa `runConfig` para leer la configuración en su mismo proceso.
 */
function cli(argv, opts = {}) {
  try { return main(argv, process.env, opts); } catch (e) {
    process.stderr.write(`✗ tycon: ${e instanceof ApplyError ? e.message : (e && e.stack) || e}\n`);
    return 1;
  }
}

module.exports = { TOP_CANONICAL, ENV_CANONICAL, lugarCanonico, harnessIndexOf, validateList, loadList, loadMinimalIds, readConfig, decide, applyToSettings, normMatcher, invokesRepoPath, namesFile, runnerFor, normalizePullLine, main, cli, ApplyError };

if (require.main === module) process.exitCode = cli(process.argv.slice(2));
