'use strict';
// integrations.js — las integraciones que la organización puede enchufar, leídas de sus manifiestos.
//
// Cada integración es una carpeta `integrations/<nombre>/` con su `integration.json`: el nombre (igual al de la carpeta),
// el nombre para mostrar, de qué tipo es (`kind`), el guion que escucha el evento de trabajo (`onWork`), sus hooks, sus
// entradas del despachador y los ajustes que pide. El núcleo no conoce ninguna por su nombre: lo que sabe está acá.
//
// Los ajustes son de dos clases:
//   · de la organización (`from: "profile"`): `integrations.<nombre>.<clave>` en el perfil del equipo (la URL de una
//     instancia, por ejemplo). Tipos: `texto` o `url`.
//   · de cada persona (`type: "secreto"`): `<nombre>.<clave>`, en `<casa del arnés>/secrets/<nombre>.json`, carpeta 700 y
//     archivo 600 (en Windows, sólo la cuenta), o en la variable que declare el manifiesto. Van aparte de `config.json`
//     porque el freno de producción instalado lee ese archivo con su propia copia del lector de configuración, que no
//     conoce secciones nuevas: un secreto ahí dejaría la configuración rota para el freno hasta reinstalarlo.
// El valor de un secreto nunca se imprime ni se repite en un motivo: se dice si está o si falta.
//
// Casos: scripts/tests/work-signal.test.js, scripts/tests/time-tracking-config.test.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const KEY_RE = /^[a-z][A-Za-z0-9_]*$/;
const ENV_RE = /^TYCON_[A-Z0-9_]+$/;
const PROFILE_TYPES = Object.freeze(['texto', 'url']);
const KIND_RE = /^[a-z][A-Za-z0-9]*$/;
// los tipos que el núcleo busca por nombre
const KINDS = Object.freeze(['timeTracking']);

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** La carpeta de las integraciones: la del árbol, o `TYCON_INTEGRATIONS_DIR` (las pruebas). */
function integrationsDir(env = process.env) {
  const v = String(env.TYCON_INTEGRATIONS_DIR || '').trim();
  return v ? path.resolve(v) : path.join(ROOT, 'integrations');
}

/** Los motivos por los que un manifiesto no vale (vacío si vale). */
function problemsOf(m, folder) {
  const out = [];
  if (!isObject(m)) return ['no es un objeto JSON'];
  if (m.name !== folder) out.push(`«name» tiene que ser el nombre de la carpeta (${folder})`);
  if (!NAME_RE.test(String(m.name || ''))) out.push('«name» lleva sólo minúsculas, números y guiones');
  if (typeof m.label !== 'string' || !m.label.trim()) out.push('falta «label»');
  if (typeof m.kind !== 'string' || !KIND_RE.test(m.kind)) out.push('falta «kind»');
  // el tipo se compara tal cual: uno conocido con otras mayúsculas no se encontraría nunca
  else for (const k of KINDS) if (m.kind !== k && m.kind.toLowerCase() === k.toLowerCase()) out.push(`«kind» se escribe ${k}`);
  if (m.onWork !== undefined && (typeof m.onWork !== 'string' || path.isAbsolute(m.onWork) || m.onWork.split(/[\\/]/).includes('..'))) out.push('«onWork» es una ruta dentro de la carpeta');
  for (const s of Array.isArray(m.settings) ? m.settings : []) {
    if (!isObject(s) || typeof s.key !== 'string') { out.push('un ajuste sin «key»'); continue; }
    const parts = s.key.split('.');
    if (s.type === 'secreto') {
      if (parts.length !== 2 || parts[0] !== m.name || !KEY_RE.test(parts[1])) out.push(`el secreto «${s.key}» va como ${m.name}.<clave>`);
      if (s.env !== undefined && !ENV_RE.test(String(s.env))) out.push(`la variable de «${s.key}» empieza con TYCON_`);
    } else if (s.from === 'profile') {
      if (parts.length !== 3 || parts[0] !== 'integrations' || parts[1] !== m.name || !KEY_RE.test(parts[2])) out.push(`el ajuste «${s.key}» va como integrations.${m.name}.<clave>`);
      if (!PROFILE_TYPES.includes(s.type)) out.push(`el ajuste «${s.key}» es de tipo ${PROFILE_TYPES.join(' o ')}`);
    } else out.push(`el ajuste «${s.key}» es un secreto o viene del perfil (from: "profile")`);
  }
  return out;
}

const cache = new Map();   // carpeta → { stamp, result }
/**
 * Los manifiestos de la carpeta: `{ manifests: [{ name, label, kind, dir, onWork, hooks, dispatch, settings }], problems:
 * [{ name, reasons }] }`. Uno que no se lee o no vale queda en `problems` y no se usa. Sin carpeta, ninguno.
 */
function listManifests({ env = process.env, dir = integrationsDir(env) } = {}) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch (_) { return { manifests: [], problems: [] }; }
  const stamp = entries.map((n) => { try { return `${n}:${fs.statSync(path.join(dir, n, 'integration.json')).mtimeMs}`; } catch (_) { return `${n}:-`; } }).join('|');
  const hit = cache.get(dir);
  if (hit && hit.stamp === stamp) return hit.result;
  const manifests = [];
  const problems = [];
  for (const name of entries) {
    const file = path.join(dir, name, 'integration.json');
    if (!fs.existsSync(file)) continue;
    let m;
    try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { problems.push({ name, reasons: [`integration.json no se lee (${e.message})`] }); continue; }
    const reasons = problemsOf(m, name);
    if (reasons.length) { problems.push({ name, reasons }); continue; }
    manifests.push({
      name: m.name, label: m.label.trim(), kind: m.kind, dir: path.join(dir, name),
      onWork: m.onWork ? path.join(dir, name, m.onWork) : null,
      hooks: Array.isArray(m.hooks) ? m.hooks : [], dispatch: Array.isArray(m.dispatch) ? m.dispatch : [],
      settings: Array.isArray(m.settings) ? m.settings : [],
    });
  }
  const result = { manifests, problems };
  cache.set(dir, { stamp, result });
  return result;
}

/** El manifiesto de una integración por nombre (y tipo, si se pide), o null. */
function find(name, { kind = null, env = process.env, dir } = {}) {
  const n = String(name || '').trim().toLowerCase();
  return listManifests({ env, dir }).manifests.find((m) => m.name === n && (!kind || m.kind === kind)) || null;
}

/** Los ajustes de la organización de una integración: `{ <clave>: tipo }`, o null si la integración no existe. */
function profileSettings(name, opts) {
  const m = find(name, opts);
  if (!m) return null;
  const out = {};
  for (const s of m.settings) if (s.from === 'profile') out[s.key.split('.')[2]] = s.type;
  return out;
}

/** Los secretos que declaran todas las integraciones: `[{ key: 'nombre.clave', integration, name, env }]`. */
function secretKeys(opts) {
  const out = [];
  for (const m of listManifests(opts).manifests) {
    for (const s of m.settings) if (s.type === 'secreto') out.push({ key: s.key, integration: m.name, name: s.key.split('.')[1], env: s.env || null });
  }
  return out;
}
function isSecretKey(key, opts) { return secretKeys(opts).some((s) => s.key === key); }

/** La casa del arnés (la de tycon-home.js: `TYCON_HOME`, o `~/.tycon`). */
function tyconHome(env = process.env) {
  try { return require('../setup/harness/tycon-home.js').home({ env }); } catch (_) { /* sin esa biblioteca, la misma regla acá */ }
  const v = String(env.TYCON_HOME || '').trim();
  if (v && path.isAbsolute(v)) return v;
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), '.tycon');
}
function secretsDir(env = process.env) { return path.join(tyconHome(env), 'secrets'); }
function secretsFile(integration, env = process.env) { return path.join(secretsDir(env), `${integration}.json`); }

/**
 * El archivo de secretos de una integración: `{ data, damaged }`. Que no exista es `{}`; uno que no se lee o no es un
 * objeto es `damaged: true` (nunca se lee como vacío: guardar encima borraría los otros secretos que tenga).
 */
function readSecretsFile(integration, env) {
  let raw;
  try { raw = fs.readFileSync(secretsFile(integration, env), 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { data: {}, damaged: false } : { data: {}, damaged: true }; }
  try {
    const j = JSON.parse(raw);
    return isObject(j) ? { data: j, damaged: false } : { data: {}, damaged: true };
  } catch (_) { return { data: {}, damaged: true }; }
}

/** El valor de un secreto (de su variable, o de su archivo), o null. Para pasarlo a la integración, nunca para mostrarlo. */
function readSecret(key, { env = process.env, dir } = {}) {
  const s = secretKeys({ env, dir }).find((x) => x.key === key);
  if (!s) return null;
  if (s.env && String(env[s.env] || '').trim()) return String(env[s.env]).trim();
  const v = readSecretsFile(s.integration, env).data[s.name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** «está» o «falta» (con el motivo si el archivo está dañado), sin el valor. */
function secretState(key, opts = {}) {
  if (readSecret(key, opts)) return 'está';
  const s = secretKeys(opts).find((x) => x.key === key);
  return s && readSecretsFile(s.integration, opts.env || process.env).damaged ? 'falta (el archivo de secretos está dañado)' : 'falta';
}

/** Sólo el usuario: 700/600 en posix; en Windows, `icacls` deja sólo a la cuenta. */
function restrictToUser(p, { platform = process.platform, dir = false } = {}) {
  if (platform !== 'win32') {
    try { fs.chmodSync(p, dir ? 0o700 : 0o600); return { ok: true }; } catch (e) { return { ok: false, reason: e.code || 'chmod falló' }; }
  }
  const user = process.env.USERNAME || os.userInfo().username;
  const r = spawnSync('icacls', [p, '/inheritance:r', '/grant:r', `${user}:${dir ? '(OI)(CI)F' : 'F'}`], { windowsHide: true, encoding: 'utf8' });
  return r.status === 0 ? { ok: true } : { ok: false, reason: `icacls salió ${r.status === null ? 'matado' : r.status}` };
}

/**
 * Guarda (o saca, con `null`) un secreto declarado en su archivo: atómico, carpeta y archivo sólo del usuario. Si no se
 * puede dejar sólo para el usuario, no queda nada escrito y falla: un secreto legible por otros no se guarda.
 * @returns {{ ok: boolean, file?: string, reason?: string }}
 */
function writeSecret(key, value, { env = process.env, platform = process.platform, dir } = {}) {
  const s = secretKeys({ env, dir }).find((x) => x.key === key);
  if (!s) return { ok: false, reason: `«${key}» no es un secreto de ninguna integración` };
  if (value !== null && (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim()))) return { ok: false, reason: `${key} tiene que ser un texto sin espacios (el valor no se muestra)` };
  const folder = secretsDir(env);
  const file = secretsFile(s.integration, env);
  const current = readSecretsFile(s.integration, env);
  if (current.damaged) return { ok: false, reason: `${file} está dañado (no se lee como JSON): no lo piso, porque puede tener otros secretos — arreglalo o borralo y volvé a guardar ${key}` };
  const data = current.data;
  if (value === null) delete data[s.name]; else data[s.name] = value.trim();
  const tmpFile = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const rd = restrictToUser(folder, { platform, dir: true });
    if (!rd.ok) return { ok: false, reason: `no pude dejar ${folder} sólo para tu usuario (${rd.reason}); no guardé nada` };
    if (!Object.keys(data).length) { fs.rmSync(file, { force: true }); return { ok: true, file }; }
    fs.writeFileSync(tmpFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    const rf = restrictToUser(tmpFile, { platform });
    if (!rf.ok) { fs.rmSync(tmpFile, { force: true }); return { ok: false, reason: `no pude dejar el archivo sólo para tu usuario (${rf.reason}); lo borré y no guardé nada` }; }
    fs.renameSync(tmpFile, file);
    return { ok: true, file };
  } catch (e) {
    try { fs.rmSync(tmpFile, { force: true }); } catch (_) { /* ya no está */ }
    return { ok: false, reason: `no pude escribir ${file} (${e.code || 'error'})` };
  }
}

module.exports = {
  integrationsDir, listManifests, find, profileSettings, secretKeys, isSecretKey,
  tyconHome, secretsDir, secretsFile, readSecret, secretState, writeSecret, PROFILE_TYPES,
};
