'use strict';
// channel.js — la política de actualización: canal (`latest` | `stable`) y aplicación (`auto` | `ask`).
//
// Vive en la configuración del arnés (`scripts/lib/tycon-config.js`, sección `update`, vocabulario cerrado): variable de
// entorno (`TYCON_UPDATE_CHANNEL`, `TYCON_UPDATE_APPLY`) › `~/.claude/tycon.json` › `team-profile.json` (o `perfil-equipo.json`, el nombre anterior) › el default.
// Sin que nadie diga nada: `stable` + `ask`. El perfil del equipo trae `latest` + `auto`; la copia pública no trae perfil.
// Un valor fuera del vocabulario es un ERROR, no «apagado». `TYCON_UPDATE=0` apaga la actualización del todo
// (`startup` queda en importar engram + aplicador + salud).
//
// LA ACTUALIZACIÓN FIJADA POR EL EQUIPO: si el perfil del ÁRBOL del arnés dice `update.apply: auto`, la aplicación es
// `auto` y la actualización está prendida, digan lo que digan la máquina, `TYCON_UPDATE_APPLY` o `TYCON_UPDATE=0`
// (`locked: true`). Lo que no se usó queda en `overridden`, para decirlo. Ni `TYCON_PROFILE=<ruta>` ni
// `TYCON_PROFILE=0` lo cambian: una variable la puede poner cualquiera. Quedan afuera el modo desarrollador (el clon de
// quien mantiene no se actualiza solo) y la retención de una vuelta atrás, que con la actualización fijada vale sólo
// hasta que sale una versión posterior a la deshecha (`holdStands`).
//
// Mientras `tycon-config.js` no conozca la sección `update` (otra pieza la suma), su ausencia se
// trata como «sin valor» y se leen las variables y `~/.claude/tycon.json` directamente, con las mismas reglas; cuando la
// sección exista, manda `tycon-config`. `set` escribe SÓLO `update.channel` en `~/.claude/tycon.json` (atómico, preserva
// el resto del archivo).
//
// Funciones puras respecto del HOME: reciben `home` y `env`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../../lib/tycon-config.js');
const { writeAtomic } = require('./state.js');

const CHANNELS = Object.freeze(['latest', 'stable']);
const APPLIES = Object.freeze(['auto', 'ask']);
const DEFAULTS = Object.freeze({ channel: 'stable', apply: 'ask' });
const VARS = Object.freeze({ channel: 'TYCON_UPDATE_CHANNEL', apply: 'TYCON_UPDATE_APPLY' });
const ALLOWED = Object.freeze({ channel: CHANNELS, apply: APPLIES });
const OFF_VAR = 'TYCON_UPDATE';
const SKILLS_SEPARATE = 'separate';
const SKILLS_UNIFIED = 'unified';

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const machineFile = (home) => (config.rutaMaquina ? config.rutaMaquina(home) : path.join(home, '.claude', 'tycon.json'));
const vocabularyHasUpdate = () => Boolean(config.VOCABULARIO && config.VOCABULARIO.update);
const invalid = (where, key, v, allowed) => `${where} · ${key} · vale «${v}»; tiene que ser ${allowed.join(' o ')}`;

/** Lee `~/.claude/tycon.json` a mano (respaldo): `{ data }`, `{ data: null }` si no está, `{ error }` si está roto. */
function readMachine(home) {
  const file = machineFile(home);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { file, data: null };
    return { file, data: null, error: `no se pudo leer (${(e && e.code) || e.message})` };
  }
  try {
    const data = JSON.parse(text.replace(/^﻿/, ''));
    if (!isObject(data)) return { file, data: null, error: 'el contenido tiene que ser un objeto JSON' };
    return { file, data };
  } catch (e) { return { file, data: null, error: `JSON ilegible (${e.message})` }; }
}

/** El respaldo: variables › tycon.json › default, con el vocabulario cerrado. */
function readFallback(home, env) {
  const out = { channel: DEFAULTS.channel, apply: DEFAULTS.apply, origins: { channel: 'default', apply: 'default' }, errors: [] };
  const machine = readMachine(home);
  const section = machine.data && isObject(machine.data.update) ? machine.data.update : {};
  for (const key of ['channel', 'apply']) {
    const raw = env[VARS[key]];
    const v = raw === undefined ? '' : String(raw).trim();
    if (v) {
      if (!ALLOWED[key].includes(v)) { out.errors.push(invalid('entorno', VARS[key], v, ALLOWED[key])); continue; }
      out[key] = v; out.origins[key] = 'env'; continue;
    }
    if (Object.prototype.hasOwnProperty.call(section, key)) {
      const m = section[key];
      if (typeof m !== 'string' || !ALLOWED[key].includes(m)) { out.errors.push(invalid(machine.file, `update.${key}`, JSON.stringify(m), ALLOWED[key])); continue; }
      out[key] = m; out.origins[key] = 'maquina';
    }
  }
  if (machine.error) out.errors.push(`${machine.file} · ${machine.error}`);
  return out;
}

/** Con `tycon-config` que conoce `update`: sus valores y orígenes; un origen «sin valor» es el default. */
function readFromConfig(home, env, tree) {
  const out = { channel: DEFAULTS.channel, apply: DEFAULTS.apply, origins: { channel: 'default', apply: 'default' }, errors: [] };
  let c;
  try { c = config.cargar({ home, env, arnes: tree || config.RAIZ_ARNES }); } catch (e) {
    out.errors.push(`configuración del arnés: falla interna del lector (${e.message})`);
    return out;
  }
  // los errores de la sección `update` y los de ARCHIVO (clave nula: un tycon.json o un perfil ilegible). Un archivo
  // ilegible no es «sin valor»: descartarlo dejaría caer la política al perfil (`latest` + `auto`) aunque la
  // persona hubiera escrito `ask`
  for (const e of c.errores || []) {
    const key = String(e.clave || '');
    if (!e.clave || /^update\b/.test(key) || /^TYCON_UPDATE/.test(key)) out.errors.push(`${e.archivo}${e.clave ? ` · ${e.clave}` : ''} · ${e.motivo}`);
  }
  const v = (c.valores && c.valores.update) || {};
  for (const key of ['channel', 'apply']) {
    const val = v[key];
    const origin = (c.origenes || {})[`update.${key}`];
    if (val === null || val === undefined || val === '' || origin === 'sin-valor') continue;
    if (!ALLOWED[key].includes(val)) { out.errors.push(invalid('configuración', `update.${key}`, val, ALLOWED[key])); continue; }
    out[key] = val; out.origins[key] = origin || 'maquina';
  }
  // la llave de la transición a un solo repo: `unified` sólo si la configuración lo dice y lo dice
  // bien. Un valor fuera del vocabulario ya quedó arriba como error de la política (y con errores nadie mueve nada):
  // acá no se confía en el valor con que el lector rellena lo que está roto
  if (v.skills_source === SKILLS_UNIFIED && !out.errors.length) {
    out.skillsSource = SKILLS_UNIFIED;
    out.skillsSourceOrigin = (c.origenes || {})['update.skills_source'] || 'maquina';
  }
  return out;
}

/**
 * La política vigente. `skillsSource`: de dónde lee las skills una máquina con dos clones — `separate`, de
 * su clon viejo de agent-skills (lo que vale si nadie dice nada o si el lector de configuración es
 * anterior a la llave); `unified`, del repo unificado: `harness.js` re-apunta ese clon (scripts/setup/harness/repoint.js).
 * @returns {{ channel: 'latest'|'stable', apply: 'auto'|'ask', enabled: boolean, origins: {channel, apply}, errors: string[],
 *             skillsSource: 'separate'|'unified', skillsSourceOrigin: string }}
 */
function read(home = os.homedir(), env = process.env, { tree } = {}) {
  const r = vocabularyHasUpdate() ? readFromConfig(home, env, tree) : readFallback(home, env);
  const off = env[OFF_VAR] === undefined ? '' : String(env[OFF_VAR]).trim();
  const out = {
    channel: r.channel, apply: r.apply, enabled: off !== '0', origins: r.origins, errors: r.errors,
    skillsSource: r.skillsSource || SKILLS_SEPARATE, skillsSourceOrigin: r.skillsSourceOrigin || 'default',
    locked: false, overridden: [],
  };
  if (!teamFixesAuto(tree || config.RAIZ_ARNES)) return out;
  out.locked = true;
  const applyVar = env[VARS.apply] === undefined ? '' : String(env[VARS.apply]).trim();
  if (applyVar && applyVar !== 'auto') out.overridden.push({ origin: 'env', name: VARS.apply, value: applyVar });
  const machine = readMachine(home);
  const mApply = machine.data && isObject(machine.data.update) ? machine.data.update.apply : undefined;
  if (mApply !== undefined && mApply !== 'auto') out.overridden.push({ origin: 'maquina', name: machine.file, value: mApply });
  if (off === '0') out.overridden.push({ origin: 'env', name: OFF_VAR, value: off });
  out.apply = 'auto';
  out.origins = { ...out.origins, apply: 'perfil' };
  out.enabled = true;
  return out;
}

/** ¿El perfil del equipo en la raíz del árbol fija `update.apply: auto`? Un perfil ausente o ilegible no fija nada. */
function teamFixesAuto(tree) {
  if (!tree || typeof config.perfilDelArbol !== 'function') return false;
  try {
    const data = JSON.parse(fs.readFileSync(config.perfilDelArbol(tree).ruta, 'utf8').replace(/^\uFEFF/, ''));
    return isObject(data) && isObject(data.update) && data.update.apply === 'auto';
  } catch (_) { return false; }
}

/**
 * ¿Sigue valiendo la retención de una vuelta atrás? Sin la actualización fijada, hasta levantarla a mano. Fijada por el
 * equipo, mientras lo publicado sea la versión deshecha: cuando alguna fuente de la retención trae otra punta, vence.
 */
function holdStands(hold, tips, policy) {
  if (!hold) return false;
  if (!policy || !policy.locked) return true;
  const undone = isObject(hold.sources) ? hold.sources : {};
  return !Object.keys(undone).some((k) => tips && tips[k] && tips[k] !== undone[k]);
}

// La copia del lector de configuración que instala el freno de producción (con sudo; se actualiza sólo al reinstalarlo)
// lee el mismo ~/.claude/tycon.json y rechaza una sección que no conoce: si es anterior a la sección `update`, escribirla
// la deja en «configuración ROTA» hasta reinstalar el freno. Se avisa.
const GUARD_LIB = '/opt/tycon/lib/tycon-config.js';
function guardWarning(guardLib) {
  try {
    if (!fs.existsSync(guardLib)) return null;
    if (/\bupdate\s*:/.test(fs.readFileSync(guardLib, 'utf8'))) return null;
    return `ojo: el freno de producción instalado (${guardLib}) es anterior a la sección «update» y va a decir «configuración ROTA» hasta reinstalarlo: sudo bash ~/.claude/${require('./place.js').PLACE_NAME}/scripts/production/install-guard.sh`;
  } catch (_) { return null; }
}

/** Fija `update.channel` en `~/.claude/tycon.json` y nada más. `warning`: el aviso del freno de producción, si aplica. */
function set(home = os.homedir(), value, { guardLib = GUARD_LIB } = {}) {
  const v = value === undefined ? '' : String(value).trim();
  if (!CHANNELS.includes(v)) return { ok: false, reason: `canal «${v}»: tiene que ser ${CHANNELS.join(' o ')}`, file: machineFile(home) };
  // un solo escritor del archivo: `setKey` de la configuración, que conserva el resto del
  // archivo igual. Sin variables (`env: {}`): de la variable que le gana avisa `channel` mismo, con su línea. Un
  // lector anterior a `setKey` escribe acá abajo.
  if (typeof config.setKey === 'function' && vocabularyHasUpdate()) {
    const r = config.setKey(home, 'update.channel', v, { env: {}, guardLib });
    if (!r.ok) return { ok: false, reason: r.reason, file: r.file };
    const out = { ok: true, reason: null, file: r.file, before: typeof r.before === 'string' ? r.before : null, after: v };
    if (r.warning) out.warning = r.warning;
    return out;
  }
  const machine = readMachine(home);
  if (machine.error) return { ok: false, reason: `${machine.file}: ${machine.error} — no se escribe sobre un archivo roto`, file: machine.file };
  const data = machine.data || {};
  const before = isObject(data.update) && typeof data.update.channel === 'string' ? data.update.channel : null;
  data.update = Object.assign(isObject(data.update) ? data.update : {}, { channel: v });
  try {
    writeAtomic(machine.file, `${JSON.stringify(data, null, 2)}\n`);
  } catch (e) { return { ok: false, reason: `no pude escribir ${machine.file}: ${e.message}`, file: machine.file }; }
  const out = { ok: true, reason: null, file: machine.file, before, after: v };
  const warning = guardWarning(guardLib);
  if (warning) out.warning = warning;
  return out;
}

module.exports = { CHANNELS, APPLIES, DEFAULTS, VARS, OFF_VAR, read, set, machineFile, holdStands };
