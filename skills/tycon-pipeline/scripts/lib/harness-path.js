#!/usr/bin/env node
'use strict';
/**
 * lib/harness-path.js — dónde está el arnés, visto desde las skills. UN lector
 * (story 8.3 del arnés, AC 5, 2026-09-26).
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * Hasta la 8.3 `TYCON_GUIDES_DIR` se leía en doce lugares de los dos repos, todos con el mismo último
 * recurso escrito a mano: la carpeta donde UNA máquina tenía el clon. En cualquier otra máquina un
 * hook «no encontraba la lib del arnés» y seguía sin ella, callado — el modo de falla que el arnés
 * existe para cazar. Ahora el orden es uno solo y vive acá:
 *
 *   1. `TYCON_GUIDES_DIR` (o `TCG`, que exporta el runner del banco de controles) — la salida explícita;
 *   2. el lugar `~/.claude/tycon-harness`, que crea y cuida el instalador del arnés
 *      (`scripts/lib/canonical-path.js`): un prompt no puede leer una variable, pero sí una ruta estable;
 *   3. el nombre viejo `~/.claude/tycon-claude-guides`, que sigue resolviendo en las máquinas ya instaladas
 *      (story 8.19): con sólo el viejo se usa sin decir nada.
 *   Nunca una carpeta escrita a mano.
 *
 * Los dos nombres están ESCRITOS acá, no importados de `scripts/setup/harness/place.js`: este archivo es el que BUSCA
 * el arnés, y en una máquina con dos clones en transición (8.18) el clon de las skills no tiene `scripts/` al lado.
 * Es una copia declarada en `scripts/tests/fixtures/harness-place-names.json`; una prueba frena si se desfasa.
 *
 * Si ninguno resuelve —una máquina antes del primer instalador, la CI nocturna, que no exporta la
 * variable ni tiene el enlace en el HOME del agente—:
 *   · un COMANDO frena (`rutaArnes()` tira `RutaArnesError`) nombrando las dos cosas que buscó;
 *   · un HOOK lo dice y sigue como hoy (`rutaArnesHook()` devuelve `{ dir: null, aviso }`): fail-open,
 *     igual que `hook-io.js` y `.githooks/pre-commit` — nunca se rompe un Edit ni un commit por esto.
 * Una variable que apunta a algo que NO es un clon (sin `scripts/`) no vale, y se dice: no se degrada
 * en silencio a «sin arnés».
 *
 * `soloEnlace()` ignora la variable a propósito: es para `guides-heal.js`, que repara el clon del
 * arnés bajo el HOME de la sesión — bajo el banco la variable apunta al repo REAL, y un merge
 * automático contra ése desde un caso sería un efecto colateral (conserva `TYCON_GUIDES_HEAL_REPO`).
 *
 * Para shell (los scripts `.sh` y los fragmentos bash de los pasos) el mismo orden se escribe así:
 *   ${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}
 *
 * Uso: node lib/harness-path.js [--hook]      → la ruta (comando: exit 2 si no hay; hook: aviso por stderr, exit 0)
 *      node lib/harness-path.js --shell-idiom → el fragmento para shell
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLACE_NAME = 'tycon-harness';
const LEGACY_PLACE_NAME = 'tycon-claude-guides';
// Story 8.23 (A1): dónde vive el arnés lo sabe scripts/setup/harness/tycon-home.js. En el repo unido está en el mismo clon
// que este archivo y se le piden las rutas del lugar; se carga SI ESTÁ, por su ruta (como la vecina de skills-dir.js): en
// un clon de skills APARTE no hay scripts/ al lado y valen los dos nombres escritos arriba, que son los mismos (copia
// declarada en scripts/tests/fixtures/harness-place-names.json; T2 de tycon-home.test.js compara las dos). Si está y no
// carga, tira.
const TYCON_HOME_LIB = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js');
const tyconHome = fs.existsSync(TYCON_HOME_LIB) ? require(TYCON_HOME_LIB) : null;
const NOMBRE_ENLACE = PLACE_NAME;   // el nombre de siempre de la exportación: hoy, el lugar
const IDIOMA_SHELL = '${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}';

class RutaArnesError extends Error {
  constructor(mensaje, buscado) { super(mensaje); this.name = 'RutaArnesError'; this.buscado = buscado; }
}

function real(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
function enlace(home) { return tyconHome ? tyconHome.placePath(home || os.homedir()) : path.join(home || os.homedir(), '.claude', PLACE_NAME); }
function legacyLink(home) { return tyconHome ? tyconHome.legacyPlacePath(home || os.homedir()) : path.join(home || os.homedir(), '.claude', LEGACY_PLACE_NAME); }
function present(p) { try { fs.lstatSync(p); return true; } catch (_) { return false; } }
/**
 * Los dos nombres, primero el lugar y después el viejo. Devuelve el primero que resuelve a un clon, lo que se buscó
 * (el viejo SÓLO si en esa ruta hay algo: afuera ese nombre no existe) y lo que resolvió a algo que no es un clon.
 */
function byName(home) {
  const buscado = []; const invalid = [];
  for (const [i, e] of [enlace(home), legacyLink(home)].entries()) {
    const re = real(e);
    if (re && esClon(re)) return { dir: re, buscado, invalid };
    if (i === 0 || present(e)) buscado.push(describirEnlace(e));
    if (re) invalid.push(describirEnlace(e));
  }
  return { dir: null, buscado, invalid };
}
/** Un clon del arnés tiene `scripts/install-tycon-hooks.sh` — el MISMO criterio que usa el instalador para decir
 *  «clon válido» (scripts/lib/canonical-path.js). No alcanza con una carpeta `scripts/`: de acá se hace `require()`
 *  de código en hooks que corren en cada edición (revisor de seguridad, vuelta 1). */
function esClon(dir) { return !!dir && fs.existsSync(path.join(dir, 'scripts', 'install-tycon-hooks.sh')); }

function expandirHome(v, home) { return String(v).replace(/^~(?=$|[\\/])/, home || os.homedir()); }
function describirCandidato(nombre, valor) {
  if (!valor) return `${nombre}: sin definir`;
  const r = real(valor);
  if (!r) return `${nombre}: ${valor} no existe`;
  if (!esClon(r)) return `${nombre}: ${valor} no es un clon del arnés (no tiene scripts/install-tycon-hooks.sh)`;
  return `${nombre}: ${valor}`;
}
/** El enlace, con su estado de verdad: falta · colgado (existe y apunta a nada) · carpeta real · no es un clon · ok. */
function describirEnlace(e) {
  let st;
  try { st = fs.lstatSync(e); } catch (_) { return `el enlace ${e}: falta`; }
  if (!st.isSymbolicLink()) return `el enlace ${e}: hay una carpeta real en su lugar, no un enlace`;
  const r = real(e);
  if (!r) { let d = '?'; try { d = fs.readlinkSync(e); } catch (_) { /* nada */ } return `el enlace ${e}: colgado (apunta a ${d}, que no existe)`; }
  if (!esClon(r)) return `el enlace ${e}: apunta a ${r}, que no es un clon del arnés (no tiene scripts/install-tycon-hooks.sh)`;
  return `el enlace ${e}: ${r}`;
}

function avisoDe(buscado) {
  return `⚠️ tycon: no encuentro el arnés — busqué ${buscado.join(' · ')}. ` +
    'Corré scripts/install-tycon-hooks.sh del arnés (crea el lugar ~/.claude/tycon-harness) o definí TYCON_GUIDES_DIR=<ruta del clon>.';
}

/**
 * @param {object} [opts] env (default process.env) · home (default os.homedir()) · modo 'comando'|'hook' (default comando)
 * @returns {{dir:string|null, fuente:'env'|'enlace'|null, buscado:string[], aviso?:string}}
 * @throws {RutaArnesError} en modo comando cuando nada resuelve
 */
function resolver(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const modo = opts.modo || 'comando';
  const buscado = [];
  const avisos = [];

  // `~` se expande como en el lector de configuración del arnés (una `~` literal llega por el bloque `env` de
  // settings.json o por `export X="~/…"` con comillas — pase adversarial, vuelta 1)
  const cruda = (env.TYCON_GUIDES_DIR && String(env.TYCON_GUIDES_DIR).trim()) || (env.TCG && String(env.TCG).trim()) || '';
  const expandida = cruda ? expandirHome(cruda, home) : '';
  const variable = expandida ? (path.isAbsolute(expandida) ? expandida : path.join(home, expandida)) : '';   // relativa: contra el HOME, como el lector del arnés
  const nombreVar = env.TYCON_GUIDES_DIR && String(env.TYCON_GUIDES_DIR).trim() ? 'TYCON_GUIDES_DIR' : 'TCG';
  if (variable) {
    const r = real(variable);
    if (r && esClon(r)) return { dir: r, fuente: 'env', buscado: [describirCandidato(nombreVar, variable)] };
    const d = describirCandidato(nombreVar, variable);
    buscado.push(d); avisos.push(`⚠️ tycon: ${d} — la ignoro y sigo por el enlace`);
  } else buscado.push('TYCON_GUIDES_DIR: sin definir');

  const n = byName(home);
  if (n.dir) {
    // un nombre que resuelve a algo que no es un clon no vale, y se dice aunque el otro sí sirva
    for (const d of n.invalid) avisos.push(`⚠️ tycon: ${d} — no vale; sigo por el otro nombre`);
    return { dir: n.dir, fuente: 'enlace', buscado, aviso: avisos.length ? avisos.join('\n') : undefined };
  }
  buscado.push(...n.buscado);

  const aviso = avisoDe(buscado);
  if (modo === 'hook') return { dir: null, fuente: null, buscado, aviso };
  throw new RutaArnesError(aviso, buscado);
}

/** Modo comando: la ruta, o tira. */
function rutaArnes(opts) { return resolver(Object.assign({}, opts, { modo: 'comando' })).dir; }
/** Modo hook: nunca tira. */
function rutaArnesHook(opts) { return resolver(Object.assign({}, opts, { modo: 'hook' })); }
/** Sólo el enlace bajo el HOME, nunca la variable (guides-heal). */
function soloEnlace(opts = {}) {
  const n = byName(opts.home);
  if (n.dir) return { dir: n.dir, fuente: 'enlace' };
  return { dir: null, fuente: null, aviso: avisoDe(n.buscado) };
}
/** `lib('scripts/lib/hook-io.js')` → el módulo, o null si el arnés no está (modo hook, nunca tira). */
function lib(relativo, opts) {
  const r = rutaArnesHook(opts);
  if (!r.dir) return null;
  try { return require(path.join(r.dir, relativo)); } catch (_) { return null; }
}

module.exports = { NOMBRE_ENLACE, PLACE_NAME, LEGACY_PLACE_NAME, IDIOMA_SHELL, RutaArnesError, enlace, legacyLink, esClon, resolver, rutaArnes, rutaArnesHook, soloEnlace, lib };

if (require.main === module) {
  // story 8.9 (tanda B3b): la opción vieja sigue andando hasta el retiro
  require('./legacy-names.js').aliasArgv('skills/tycon-pipeline/scripts/lib/harness-path.js');
  const argv = process.argv.slice(2);
  if (argv.includes('--shell-idiom')) { process.stdout.write(IDIOMA_SHELL + '\n'); process.exit(0); }
  if (argv.includes('--hook')) {
    const r = rutaArnesHook();
    if (!r.dir) { process.stderr.write(r.aviso + '\n'); process.exit(0); }
    process.stdout.write(r.dir + '\n'); process.exit(0);
  }
  try { process.stdout.write(rutaArnes() + '\n'); process.exit(0); }
  catch (e) { process.stderr.write(e.message + '\n'); process.exit(2); }
}
