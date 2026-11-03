'use strict';
/**
 * known-secrets.js — los valores reales de los secretos de esta máquina y cómo se tapan.
 *
 * Compara por valor exacto, nunca por forma: una clave de ejemplo en un archivo de pruebas no coincide con nada y sale tal
 * cual. Tampoco ataja lo que la máquina no conoce (la contraseña de un archivo de un producto, un valor partido o
 * codificado): es contra el descuido, no contra quien quiera sacarlo a propósito.
 *
 * Los valores se leen en cada llamada y no se guardan en ningún lado. Un origen que falla se anota en `problems`, sin
 * valores, y no corta a los demás; un archivo que no existe es lo normal y no se anota.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeDir } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const COVERED = '«tapado»';
const MIN_LENGTH = 16;
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|_PAT_|_PAT$|_KEY$/;
const SHELL_FILES = ['.zshrc', '.zprofile', '.bashrc'];
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const WORD_END = new Set([' ', '\t', ';', '&', '|', '(', ')']);
const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;
const URL_USER_INFO = /^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+)@/i;
const URL_SECRET_PARAM = /[?&](?:sig|signature|token|access_token|key|api_key|apikey|secret|password|pass|pat)=/i;
const KEY_SEGMENT = /^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z]).{20,}$/;

const isSecretName = (name) => SECRET_NAME.test(String(name).toUpperCase());

/** Una dirección lleva credencial si trae algo antes de la arroba (`git@` es el usuario fijo de ssh) o una firma en la consulta. */
function urlHasCredential(value) {
  const info = URL_USER_INFO.exec(value);
  return Boolean(info && info[1] !== 'git') || URL_SECRET_PARAM.test(value);
}

/** Una ruta, también relativa o de Windows. Una clave en base64 puede empezar con `/`: la delatan `+`, `=` o un tramo largo y mezclado. */
function looksLikePath(value) {
  if (!/[\\/]/.test(value) || /[+=]/.test(value)) return false;
  return !value.split(/[\\/]+/).some((part) => KEY_SEGMENT.test(part));
}

/** Un valor largo que no es una ruta ni una dirección sin credencial: taparlo no rompe salidas comunes. */
function worthCovering(value) {
  if (typeof value !== 'string' || value.length < MIN_LENGTH) return false;
  return URL_FORM.test(value) ? urlHasCredential(value) : !looksLikePath(value);
}

/**
 * Las palabras de un renglón de shell, como las corta el shell: `{ text, literal }`. `literal` es falso si la palabra lleva
 * una expansión (`$OTRA`, `$(comando)`, comillas invertidas): no es un valor que comparar. Un `#` al principio de una
 * palabra es un comentario.
 */
function shellWords(line) {
  const words = [];
  let text = '';
  let literal = true;
  let open = false;
  const end = () => { if (open) words.push({ text, literal }); text = ''; literal = true; open = false; };
  const skipTo = (from, close) => { const at = line.indexOf(close, from); return at < 0 ? line.length : at; };
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (WORD_END.has(c)) { end(); continue; }
    if (c === '#' && !open) break;
    open = true;
    if (c === "'") {
      const close = skipTo(i + 1, "'");
      if (close === line.length) literal = false;
      text += line.slice(i + 1, close);
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) { text += line[j + 1]; j += 2; continue; }
        if (line[j] === '$' || line[j] === '`') literal = false;
        text += line[j];
        j += 1;
      }
      if (j >= line.length) literal = false;
      i = j;
    } else if (c === '$') {
      literal = false;
      if (line[i + 1] === '(') {
        let depth = 0;
        let j = i + 1;
        for (; j < line.length; j += 1) {
          if (line[j] === '(') depth += 1;
          if (line[j] === ')' && --depth === 0) break;
        }
        i = j;
      } else if (line[i + 1] === '{') i = skipTo(i + 2, '}');
    } else if (c === '`') {
      literal = false;
      i = skipTo(i + 1, '`');
    } else if (c === '\\' && i + 1 < line.length) {
      text += line[i + 1];
      i += 1;
    } else text += c;
  }
  end();
  return words;
}

function assignmentsIn(text) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    for (const word of shellWords(line)) {
      const m = ASSIGNMENT.exec(word.text);
      if (m && word.literal && isSecretName(m[1])) values.push(m[2]);
    }
  }
  return values;
}

/** Las claves `sección.clave` que la configuración declara de tipo `secreto`; sin el lector, las de nombre alcanzan. */
function declaredSecrets(problems) {
  const keys = new Set();
  try {
    const config = require(path.join(__dirname, 'tycon-config.js'));
    for (const [section, entries] of Object.entries(config.VOCABULARIO)) {
      for (const [key, type] of Object.entries(entries)) if (type === 'secreto') keys.add(`${section}.${key}`);
    }
  } catch (e) {
    problems.push(`no pude leer los tipos de la configuración (${e.code || e.name})`);
  }
  return keys;
}

function configValues(node, trail, declared, out) {
  if (Array.isArray(node)) { for (const item of node) configValues(item, trail, declared, out); return; }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) configValues(value, [...trail, key], declared, out);
    return;
  }
  if (typeof node === 'string' && (isSecretName(trail[trail.length - 1] || '') || declared.has(trail.join('.')))) out.push(node);
}

const stringsIn = (node) => (typeof node === 'string' ? [node] : node && typeof node === 'object' ? Object.values(node).flatMap(stringsIn) : []);

/** La casa del arnés, con la regla de tycon-home.js: `TYCON_HOME` si es absoluta; si no, `~/.tycon`. */
function ownRoot(home, env) {
  const own = String(env.TYCON_HOME || '').trim();
  return own && path.isAbsolute(own) ? own : path.join(home, '.tycon');
}

const longestFirst = (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * `{ secrets: [{ value, origin }], problems: [texto sin valores], readable }`, sin repetir valores y con el más largo
 * primero. `readable` cuenta los archivos que se pudieron leer, y el entorno si trajo un secreto: en 0, no se comprobó nada.
 */
function readKnownSecrets({ home = os.homedir(), env = process.env } = {}) {
  const problems = [];
  const found = new Map();
  let readable = 0;
  const add = (value, origin) => { if (worthCovering(value) && !found.has(value)) found.set(value, origin); };
  const read = (file, label) => {
    try { const text = fs.readFileSync(file, 'utf8'); readable += 1; return text; }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') problems.push(`${label}: ${e.code || e.name}`); return null; }
  };

  for (const [name, value] of Object.entries(env)) if (isSecretName(name)) add(value, 'entorno');
  if (found.size) readable += 1;

  for (const name of SHELL_FILES) {
    const text = read(path.join(home, name), `~/${name}`);
    if (text !== null) for (const value of assignmentsIn(text)) add(value, 'shell');
  }

  const channels = path.join(claudeDir(home), 'channels');
  let names = [];
  try { names = fs.readdirSync(channels); }
  catch (e) { if (e.code !== 'ENOENT') problems.push(`la carpeta de canales: ${e.code || e.name}`); }
  for (const name of names) {
    const text = read(path.join(channels, name, '.env'), `el canal ${name}`);
    if (text !== null) for (const value of assignmentsIn(text)) add(value, 'canal');
  }

  // la configuración vive en la casa del arnés o, en una máquina con Claude Code, en su carpeta: se leen las dos
  const declared = declaredSecrets(problems);
  for (const [file, label] of [[path.join(ownRoot(home, env), 'config.json'), 'config.json de la casa del arnés'], [path.join(claudeDir(home), 'tycon.json'), 'tycon.json']]) {
    const text = read(file, label);
    if (text === null) continue;
    let parsed;
    try { parsed = JSON.parse(text.replace(/^﻿/, '')); }
    catch { problems.push(`${label}: no es JSON`); readable -= 1; continue; }
    const out = [];
    configValues(parsed, [], declared, out);
    for (const value of out) add(value, 'configuración');
  }

  // el almacén de las integraciones: lo que está ahí se declaró secreto, así que una dirección también se tapa
  const store = path.join(ownRoot(home, env), 'secrets');
  let stored = [];
  try { stored = fs.readdirSync(store).filter((name) => name.endsWith('.json')); }
  catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') problems.push(`la carpeta de secretos: ${e.code || e.name}`); }
  for (const name of stored) {
    const text = read(path.join(store, name), `el secreto ${name}`);
    if (text === null) continue;
    let parsed;
    try { parsed = JSON.parse(text.replace(/^﻿/, '')); }
    catch { problems.push(`el secreto ${name}: no es JSON`); readable -= 1; continue; }
    for (const value of stringsIn(parsed)) if (value.length >= MIN_LENGTH && !found.has(value)) found.set(value, 'configuración');
  }

  const secrets = [...found].map(([value, origin]) => ({ value, origin })).sort((a, b) => longestFirst(a.value, b.value));
  return { secrets, problems, readable };
}

/** Cómo puede aparecer un valor en una salida: tal cual, con los escapes de JSON, y en un JSON guardado dentro de otro. */
function formsOf(secrets) {
  const forms = new Map();
  for (const { value, origin } of secrets) {
    const once = JSON.stringify(value).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);
    for (const form of [value, once, twice]) if (!forms.has(form)) forms.set(form, origin);
  }
  return [...forms].sort(([a], [b]) => longestFirst(a, b));
}

/**
 * Tapa los valores en los campos de texto de cualquier estructura, nunca en el JSON serializado: conserva los campos y su
 * forma. `{ value, count, origins }`; sin nada que tapar, `count` es 0.
 */
function coverIn(input, secrets) {
  const forms = formsOf(secrets);
  let count = 0;
  const origins = new Set();
  const coverText = (text) => {
    let out = text;
    for (const [form, origin] of forms) {
      if (!out.includes(form)) continue;
      const parts = out.split(form);
      count += parts.length - 1;
      origins.add(origin);
      out = parts.join(COVERED);
    }
    return out;
  };
  const walk = (node) => {
    if (typeof node === 'string') return coverText(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  const value = walk(input);
  return { value, count, origins: [...origins] };
}

/** Tapa en un texto leído como latin1, la forma en que la subida al buzón no cambia un byte de lo demás. */
function coverInLatin1(text, secrets) {
  const asLatin1 = (s) => Buffer.from(s, 'utf8').toString('latin1');
  const covered = asLatin1(COVERED);
  let out = text;
  for (const [form] of formsOf(secrets)) out = out.split(asLatin1(form)).join(covered);
  return out;
}

module.exports = { COVERED, readKnownSecrets, coverIn, coverInLatin1 };
