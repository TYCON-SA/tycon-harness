#!/usr/bin/env node
'use strict';

/**
 * suites-for-change.js — qué suites de `scripts/tests/suites.json` corre el control de cada cambio en Azure.
 *
 * POR QUÉ (2026-10-02): el control de `main` (pipelines/azure-pipelines-pr.yml) corre las ~190 suites una por una y
 * se pasó de su tope de 45 minutos. Dos suites se llevaban casi la mitad: la copia pública de verdad
 * (`export-real.test.sh`, ~14 min) y las skills de terceros reales (`third-party-real.test.sh`, ~2 min). Las dos ya
 * declaraban `gate_only_when_touching`, que respetaba el portón de cada story y el control de Azure no. Con esto, en
 * el control corren sólo si el cambio toca alguna de sus carpetas o la suite misma. El banco nocturno las corre
 * todas las noches igual: no se pierde la medición, se mueve a la noche.
 *
 * LA REGLA de `gate_only_when_touching` es la del portón de las stories, leída de agent-skills
 * (`tycon-pipeline/scripts/lib/touched-files.js`): cada patrón es `<carpeta>/**`, relativo a la raíz del repo, sin
 * comodines antes del `/**` final. Un patrón con otra forma no se interpreta y la suite corre; sin esa regla, corre todo.
 *
 * LAS DOS MÁS LARGAS (`--heavy`, 2026-10-04, decisión del dueño): `export-real.test.sh` (~24 min en el nocturno) y
 * `clean-machine.test.sh` (~7 min cuando mide) corren en el control SÓLO si el cambio toca lo que ellas miden. El
 * criterio vive en scripts/ci/heavy-suites.json (suite → patrones, con su motivo) y, para esas suites, MANDA sobre su
 * `gate_only_when_touching`, que es más angosto y sigue siendo el del portón de cada story. No depende de la regla de
 * agent-skills: sus patrones son `<carpeta>/**`, `*` (un tramo sin barras) o la ruta exacta de un archivo. Un archivo
 * roto no apaga nada: se avisa y corre todo.
 * 2026-10-05 (decisión del dueño): una suite con `"shared": false` no hereda los patrones comunes. Así quedó la copia
 * pública de verdad: se llevaba ~28 de los ~40 minutos de cada validación y corría por casi cualquier cambio; ahora
 * corre en la rama sólo si el cambio toca el exportador o la prueba misma, y todas las noches en el banco nocturno.
 *
 * «NO PUDE MIRAR» CORRE TODO: sin lista de cambios (no se pudo calcular el diff, el archivo no existe o no se lee) no
 * se difiere ninguna suite, y se dice por qué. Nunca se corre menos por no saber.
 *
 * LA RAÍZ `agent-skills` SALE DE LA FUNCIÓN, NO DE QUIEN LLAMA (story 8.18, AC 12 y 13, 2026-10-03): los dos repos
 * internos se unieron en uno y las suites con raíz `agent-skills` viven en `<repo>/skills`. Con la raíz escrita en el
 * YAML (`$HOME/.claude/agent-skills/skills`), en un clon de trabajo se listaban las suites INSTALADAS en la máquina:
 * el control daba verde sin haber corrido el cambio. Sin `--skills`, la raíz es la que contesta `resolveSkillsDirs()`
 * de scripts/lib/skills-dir.js (la variable › el propio clon si es unido › lo instalado), la misma que usan los demás
 * lectores de suites.json; la línea `ROOT` dice cuál fue y de qué regla salió. `--skills` sigue valiendo para quien
 * la quiera fijar a mano. Una raíz que NO existe no saca sus suites de la lista (sería un salteo en silencio): siguen
 * como `RUN`, quien corre la lista las marca «NO se midió» y las cuenta como falla, y acá se dice el motivo.
 *
 * POR DEPENDENCIAS (`--deps`, story 8.22, tramo B, decisión del dueño: la validación en 15 min): una suite que no declara
 * criterio propio corre sólo si el cambio toca algo de lo que usa su código (scripts/ci/suite-deps.js); las demás, el
 * banco nocturno. Ante la duda corre (ver el bloque de `--deps` en main), y sin foto nocturna completa y reciente
 * (`--nightly`) no se saltea nada. Los .md no eligen (`--changed` es la lista de código), salvo para la pesada que
 * declara `reads_md` en heavy-suites.json, que se elige con la lista entera (`--changed-with-docs`).
 * Tramo E (2026-10-07): las pesadas también. Una pesada corre si el cambio toca sus patrones, la red de `shared` (que
 * quedó sólo con lo que el lector no puede calcular) o lo que usa su código, según su `deps` en heavy-suites.json: sin
 * poner, el grafo entero; `false`, sólo sus patrones; `"graph"`, el grafo sin el «depende de todo» (su ls-files o su
 * grep son sobre un repo de juguete). Sin --deps utilizable corren todas: sus patrones ya no alcanzan solos.
 * Tramo F (2026-10-07): `--over-limit` trae scripts/ci/suites-over-limit.json, la lista de las suites que pasan de 45 s
 * en el agente con lo que se decidió de cada una. La que va al nocturno (`"nightly": true`) sale `SKIP` aunque el cambio
 * la toque; la que lleva una excepción firmada corre como siempre. Sin saber qué cambió corren todas, y una lista que no
 * se deja leer no saltea ninguna.
 *
 * Uso:  node suites-for-change.js --suites <suites.json> --scripts <raíz scripts del arnés>
 *            [--skills <carpeta de skills>] [--changed <archivo con un cambio por línea>] [--heavy <heavy-suites.json>]
 *            [--changed-with-docs <la lista entera, con los .md>] [--deps [--nightly <ultimo-suites.json>]]
 *            [--over-limit <suites-over-limit.json>]
 * Salida (stdout): `ROOT\tagent-skills\t<carpeta>\t<de dónde salió>\t<ok|missing>` (una línea; de dónde salió:
 *        variable | own-clone | installed | --skills), `RUN\t<ruta absoluta>` por suite a correr, en el orden de
 *        suites.json (diarias y semanales), y `SKIP\t<nombre>\t<motivo>` por suite diferida. Avisos a stderr.
 * Sale 0 con la lista escrita · 2 si suites.json no se deja leer o no se pudo resolver la raíz de las skills.
 */

const fs = require('fs');
const path = require('path');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

// La regla es UNA: la del portón de las stories, que vive en agent-skills (revisor de fallos silenciosos, 2026-10-02:
// una copia a mano ya divergía en los espacios). Sin ella no se difiere nada: corre todo.
function gateRule(skillsRoot) {
  try {
    const lib = require(path.join(skillsRoot, 'tycon-pipeline', 'scripts', 'lib', 'touched-files.js'));
    if (typeof lib.isValidPattern === 'function' && typeof lib.touches === 'function') return lib;
    return { missing: 'touched-files.js no exporta isValidPattern y touches' };
  } catch (e) {
    return { missing: `no encontré la regla del portón de las stories en ${skillsRoot} (${e.code || e.message})` };
  }
}

function readChanged(file) {
  if (!file) return { known: false, reason: 'no hay lista de cambios' };
  try {
    return { known: true, files: fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) };
  } catch (e) {
    return { known: false, reason: `la lista de cambios no se deja leer (${e.code || e.message})` };
  }
}

/**
 * La red de `--deps` (story 8.22, AC 9 g): lo que la rama saltea lo mide el banco nocturno. Sin su última foto
 * (`scripts/controls-bench/ultimo-suites.json` de origin/main), con `complete` distinto de true o con más de 36 h, esa red
 * no está. Devuelve el motivo por el que no hay red, o null si la hay.
 */
const NIGHTLY_MAX_HOURS = 36;
function nightlyNet(file, now = Date.now()) {
  if (!file) return 'no hay foto nocturna (--nightly)';
  let photo;
  try {
    photo = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return `la foto nocturna ${file} no se deja leer (${e.code || e.message})`;
  }
  if (!photo || photo.complete !== true) return `la foto nocturna dice complete: ${JSON.stringify(photo && photo.complete)}`;
  const at = Date.parse(photo.ts);
  if (!Number.isFinite(at)) return `la foto nocturna no trae una hora legible (ts: ${JSON.stringify(photo.ts)})`;
  const hours = (now - at) / 3600000;
  if (hours > NIGHTLY_MAX_HOURS) return `la foto nocturna es de hace ${Math.round(hours)} h (más de ${NIGHTLY_MAX_HOURS})`;
  return null;
}

/**
 * Lo que hay que buscar en el código de una suite para saber si usaba un archivo que el cambio borró o movió (story 8.22,
 * AC 9 b; pase adversarial del tramo B): su nombre (`state.js`); su nombre sin extensión pegado a una barra y a una
 * comilla, como lo escribe un `require` (`/state'`); y cada carpeta que lo contenía y ya no está en el disco
 * (`scripts/widgets`), de dos tramos o más —`scripts` sola nombraría casi todo—.
 */
function missingNeedles(missing, repoRoot) {
  const out = new Set();
  for (const m of missing) {
    const base = path.posix.basename(m);
    out.add(base);
    const stem = base.replace(/\.[^.]+$/, '');
    if (stem && stem !== base) for (const q of ["'", '"', '`']) out.add(`/${stem}${q}`);
    for (let d = path.posix.dirname(m); d.includes('/'); d = path.posix.dirname(d)) {
      if (fs.existsSync(path.join(repoRoot, d))) break;
      out.add(d);
    }
  }
  return [...out];
}

// La raíz `agent-skills`: `--skills` si se pasó; si no, LA función que usan todos los lectores de suites.json.
function skillsRootOf(argv) {
  const given = arg(argv, '--skills');
  if (given) return { dir: given, source: '--skills' };
  const d = require('../lib/skills-dir.js').resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '');
  return { dir: d.skills, source: d.source };
}

const realDir = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };

/**
 * Un patrón de heavy-suites.json como expresión regular sobre la ruta relativa de un archivo del cambio: `**` es
 * cualquier cosa (también barras), `*` un tramo sin barras, el resto literal. null si no es un patrón aceptable (vacío,
 * absoluto, con `..` o con barras invertidas).
 */
function heavyPattern(text) {
  if (typeof text !== 'string' || !text || text.startsWith('/') || text.includes('\\') || text.split('/').includes('..')) return null;
  const body = text.split('**').map((part) => part.split('*').map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * Las suites de heavy-suites.json, cada una con sus patrones (los de `shared` más los suyos; con `"shared": false`,
 * sólo los suyos). `problem` si el archivo no se deja leer o trae algo que no se puede interpretar: entonces no se
 * difiere ninguna (corre todo).
 */
function readHeavy(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { problem: `${file} no se deja leer (${e.code || e.message})` };
  }
  const group = (entry, name) => {
    if (entry === undefined && name === 'shared') return [];
    if (!entry || !Array.isArray(entry.patterns)) return `«${name}» no trae una lista «patterns»`;
    const bad = entry.patterns.filter((x) => heavyPattern(x) === null);
    return bad.length ? `«${name}» trae patrones que no se pueden interpretar: ${JSON.stringify(bad)}` : entry.patterns.map(heavyPattern);
  };
  const shared = group(data && data.shared, 'shared');
  if (typeof shared === 'string') return { problem: `${file}: ${shared}` };
  if (!data.suites || typeof data.suites !== 'object' || Array.isArray(data.suites)) return { problem: `${file} no trae «suites»` };
  // `deps_ignore` (tramo E, pase adversarial): carpetas de datos que no viajan ni se instalan y que el código de las
  // pesadas nombra en rutas de juguete (el laboratorio, los avisos de los hooks). No eligen pesadas por el grafo; una
  // pesada que lea datos reales de ahí los pone en sus patrones. Sin la clave, no se ignora nada
  const ignore = data.deps_ignore === undefined ? [] : group(data.deps_ignore, 'deps_ignore');
  if (typeof ignore === 'string') return { problem: `${file}: ${ignore}` };
  // `groups` (story 8.22, tramo G; decisión del dueño, 2026-10-08): un criterio con nombre que varias suites comparten.
  // La suite que lo nombra (`"group": "<nombre>"`) corre SÓLO si el cambio toca los patrones del grupo o los suyos: no
  // hereda `shared` ni se elige por lo que usa su código. Nació para las suites del laboratorio del instalador, que
  // corren en la rama sólo cuando el cambio toca el instalador (el grupo `installer` dice su costo aceptado). Un grupo
  // mal escrito, o una suite que nombra uno que no existe, deja el archivo sin leer: corre todo.
  if (data.groups !== undefined && (!data.groups || typeof data.groups !== 'object' || Array.isArray(data.groups))) return { problem: `${file}: «groups» no es un objeto de grupos` };
  const groups = new Map();
  for (const [name, entry] of Object.entries(data.groups || {})) {
    const patterns = group(entry, name);
    if (typeof patterns === 'string') return { problem: `${file}: el grupo ${patterns}` };
    // Un grupo sin ningún patrón no elige nada: las suites que lo nombran quedarían sólo con su propio archivo, y un
    // cambio en lo que el grupo decía cuidar las saltearía sin aviso (pase adversarial del tramo G). Lista vacía = mal escrito
    if (!patterns.length) return { problem: `${file}: el grupo «${name}» trae la lista «patterns» vacía` };
    groups.set(name, patterns);
  }
  const suites = new Map();
  const readsMd = new Set();
  const depsMode = new Map();
  const graphLines = new Map();
  for (const [name, entry] of Object.entries(data.suites)) {
    const own = group(entry, name);
    if (typeof own === 'string') return { problem: `${file}: ${own}` };
    // `group`: el nombre de un grupo de `groups`. Con grupo, el criterio entero es el del grupo más lo propio: no admite
    // `shared`, `deps` ni las claves del grafo (dirían otra cosa a la vez). Otro valor no se adivina
    if (entry.group !== undefined) {
      if (typeof entry.group !== 'string' || !entry.group) return { problem: `${file}: «${name}» trae «group» que no es el nombre de un grupo (${JSON.stringify(entry.group)})` };
      if (!groups.has(entry.group)) return { problem: `${file}: «${name}» nombra el grupo «${entry.group}», que no está en «groups»` };
      const extra = ['shared', 'deps', 'graph_whole_lines', 'graph_whole_sha', 'reads_md'].filter((k) => entry[k] !== undefined);
      if (extra.length) return { problem: `${file}: «${name}» nombra un grupo y además trae ${extra.map((k) => `«${k}»`).join(', ')}: con grupo, el criterio es el del grupo` };
      depsMode.set(name, false);
      suites.set(name, [...groups.get(entry.group), ...own]);
      continue;
    }
    // `shared` de una suite: sin poner o true, hereda; false, no. Otro valor no se adivina
    if (entry.shared !== undefined && typeof entry.shared !== 'boolean') return { problem: `${file}: «${name}» trae «shared» que no es true ni false (${JSON.stringify(entry.shared)})` };
    // `reads_md` (story 8.22): la pesada mira también los .md del cambio (la copia pública los publica). Otro valor no se adivina
    if (entry.reads_md !== undefined && typeof entry.reads_md !== 'boolean') return { problem: `${file}: «${name}» trae «reads_md» que no es true ni false (${JSON.stringify(entry.reads_md)})` };
    // `deps` (story 8.22, tramo E): sin poner o true, también lo que usa su código; false, sólo sus patrones; "graph", lo
    // que usa sin el «depende de todo» (su ls-files o su grep son sobre un repo de juguete). Otro valor no se adivina
    if (![undefined, true, false, 'graph'].includes(entry.deps)) return { problem: `${file}: «${name}» trae «deps» que no es true, false ni "graph" (${JSON.stringify(entry.deps)})` };
    // `graph_whole_lines`: cuántas líneas de su código recorrían el repo cuando alguien revisó el «graph». Otro valor no se adivina
    if (entry.graph_whole_lines !== undefined && !(Number.isInteger(entry.graph_whole_lines) && entry.graph_whole_lines >= 0)) {
      return { problem: `${file}: «${name}» trae «graph_whole_lines» que no es un entero desde 0 (${JSON.stringify(entry.graph_whole_lines)})` };
    }
    // `graph_whole_sha`: la huella de esas líneas (12 hexadecimales). Otro valor no se adivina
    if (entry.graph_whole_sha !== undefined && !(typeof entry.graph_whole_sha === 'string' && /^[0-9a-f]{12}$/.test(entry.graph_whole_sha))) {
      return { problem: `${file}: «${name}» trae «graph_whole_sha» que no son 12 caracteres hexadecimales (${JSON.stringify(entry.graph_whole_sha)})` };
    }
    if (entry.reads_md === true) readsMd.add(name);
    depsMode.set(name, entry.deps === undefined ? true : entry.deps);
    if (entry.graph_whole_lines !== undefined) graphLines.set(name, { lines: entry.graph_whole_lines, sha: entry.graph_whole_sha });
    suites.set(name, entry.shared === false ? own : [...shared, ...own]);
  }
  return { suites, readsMd, depsMode, graphLines, ignore };
}

// ── Las que pasan del límite en la validación de una rama (story 8.22, tramo F, AC 21) ───────────────────────────────
// scripts/ci/suites-over-limit.json dice, por suite, qué se decidió: `"nightly": true` (la rama no la corre nunca: la
// corre el banco nocturno) o `"exception"` firmada (corre como siempre, y alguien se hizo cargo). Una entrada mal
// formada deja el archivo ENTERO sin leer: una excepción sin firma no cuenta, y media lista leída saltearía suites con
// una decisión que nadie tomó. Las `legacy-names-*` no entran: se retiran con la story 8.15 (AC 23).
const LEGACY_NAMES = /^legacy-names-/;
const filled = (x) => typeof x === 'string' && x.trim() !== '';
function readOverLimit(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { problem: `${file} no se deja leer (${e.code || e.message})` }; }
  const bad = (why) => ({ problem: `${file}: ${why}` });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('no es un objeto');
  if (typeof raw.limit_seconds !== 'number' || !(raw.limit_seconds > 0)) return bad('«limit_seconds» no es un número mayor que 0');
  if (!filled(raw.weight_set)) return bad('falta «weight_set», el juego de pesos con que se mide');
  if (!raw.suites || typeof raw.suites !== 'object' || Array.isArray(raw.suites)) return bad('«suites» no es un objeto');
  const suites = new Map();
  const nightly = new Set();
  for (const [name, e] of Object.entries(raw.suites)) {
    if (LEGACY_NAMES.test(name)) return bad(`${name} no puede tener entrada: las legacy-names-* no se tocan, se retiran con la story 8.15`);
    if (!e || typeof e !== 'object' || Array.isArray(e)) return bad(`${name}: su entrada no es un objeto`);
    const toNightly = e.nightly !== undefined;
    const excepted = e.exception !== undefined;
    if (toNightly === excepted) return bad(`${name}: lleva «nightly» o «exception», una sola de las dos`);
    if (toNightly) {
      if (e.nightly !== true) return bad(`${name}: «nightly» sólo puede ser true`);
      if (!filled(e.why)) return bad(`${name}: va al nocturno sin decir por qué («why»)`);
      nightly.add(name);
    } else {
      const x = e.exception;
      if (!x || typeof x !== 'object' || Array.isArray(x)) return bad(`${name}: «exception» no es un objeto`);
      if (!filled(x.signed_by)) return bad(`${name}: una excepción sin firma no cuenta («signed_by»)`);
      if (typeof x.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) return bad(`${name}: la excepción no dice cuándo se firmó («date», AAAA-MM-DD)`);
      if (!filled(x.why)) return bad(`${name}: la excepción no dice por qué («why»)`);
      if (x.until !== undefined && !filled(x.until)) return bad(`${name}: «until» no es un texto`);
    }
    suites.set(name, e);
  }
  return { limit: raw.limit_seconds, weightSet: raw.weight_set, suites, nightly };
}
/**
 * Lo que falta decidir y lo que sobra: cada suite de `weights` (nombre → segundos en el agente) que pasa del límite tiene
 * que tener entrada, y cada entrada tiene que ser de una suite de la lista que hoy pasa del límite.
 * Lo que pide decisión se juzga parte por parte: partir una suite es la forma de que cada parte entre en el límite.
 * Pero la excepción firmada de una parte NO sobra si la suite entera (la suma de sus partes) pasa del límite: el grupo del
 * laboratorio del instalador de scripts/ci/heavy-suites.json juzga entera la suite partida («el criterio es el de la
 * suite entera») y su control exige la decisión en cada parte. Sin esto las dos reglas se contradecían (nocturno del
 * 2026-10-15: dos partes de 27 y 35 s, entera 62 s, salían «la entrada sobra» acá y «sin decisión» allá). Sólo la
 * excepción: una parte liviana mandada «al nocturno» se sigue juzgando sola, porque esa decisión la saca de la validación.
 */
const SPLIT_PART = /^(.*)\.p[1-9]\d*\.test\.(js|sh)$/;
function wholeWeights(weights) {
  const whole = (n) => { const m = SPLIT_PART.exec(n); return m ? `${m[1]}.test.${m[2]}` : n; };
  const sum = {};
  for (const [n, w] of Object.entries(weights || {})) {
    const k = whole(n);
    sum[k] = typeof w === 'number' && (sum[k] === undefined || typeof sum[k] === 'number') ? (sum[k] || 0) + w : null;
  }
  return Object.fromEntries(Object.keys(weights || {}).map((n) => [n, sum[whole(n)] === null ? (weights || {})[n] : sum[whole(n)]]));
}
function overLimitProblems(cfg, weights, suiteNames) {
  const out = [];
  const judged = wholeWeights(weights);
  const shown = (n) => (judged[n] === (weights || {})[n] ? `${judged[n]} s` : `${judged[n]} s entera, ${weights[n]} s esta parte`);
  for (const [name, w] of Object.entries(weights || {})) {
    if (typeof w !== 'number' || w <= cfg.limit || LEGACY_NAMES.test(name)) continue;
    if (!cfg.suites.has(name)) out.push(`${name} pasa de ${cfg.limit} s (${w} s) y nadie decidió qué hacer: se parte, va al nocturno o lleva una excepción firmada`);
  }
  for (const name of cfg.suites.keys()) {
    if (!suiteNames.has(name)) out.push(`${name} tiene una decisión y no está en suites.json: si se renombró o se partió, la entrada sobra`);
    else if (typeof (weights || {})[name] !== 'number') out.push(`${name} tiene una decisión y no tiene peso medido en el juego de la validación: la entrada sobra`);
    else if ((cfg.suites.get(name) || {}).exception ? judged[name] <= cfg.limit : weights[name] <= cfg.limit) {
      out.push(`${name} tiene una decisión y ya no pasa de ${cfg.limit} s (${(cfg.suites.get(name) || {}).exception ? shown(name) : `${weights[name]} s`}): la entrada sobra`);
    }
  }
  return out;
}

function main(argv) {
  const suitesFile = arg(argv, '--suites');
  const scriptsRoot = arg(argv, '--scripts');
  if (!suitesFile || !scriptsRoot) {
    process.stderr.write('uso: suites-for-change.js --suites <suites.json> --scripts <dir> [--skills <dir>] [--changed <archivo>] [--changed-with-docs <archivo>] [--heavy <heavy-suites.json>] [--deps [--nightly <ultimo-suites.json>]] [--over-limit <suites-over-limit.json>]\n');
    return 2;
  }
  let root;
  try {
    root = skillsRootOf(argv);
  } catch (e) {
    process.stderr.write(`❌ no pude resolver la raíz de las skills (${e.code || e.message}): sin ella no sé de dónde corren las suites de agent-skills\n`);
    return 2;
  }
  const skillsRoot = root.dir;
  let suites;
  try {
    suites = JSON.parse(fs.readFileSync(suitesFile, 'utf8'));
  } catch (e) {
    process.stderr.write(`❌ ${suitesFile} no se deja leer (${e.message}): sin la lista de suites no sé qué correr\n`);
    return 2;
  }
  let changed = readChanged(arg(argv, '--changed'));
  // La lista tal cual, antes de mirar la regla del portón: el criterio de las dos más largas no depende de ella.
  const listed = changed;
  const heavyFile = arg(argv, '--heavy');
  let heavy = heavyFile ? readHeavy(heavyFile) : { suites: new Map(), readsMd: new Set(), depsMode: new Map(), graphLines: new Map(), ignore: [] };
  if (heavy.problem) {
    process.stderr.write(`⚠️  ${heavy.problem}: no difiero ninguna suite, corre todo\n`);
    changed = { known: false, reason: `el criterio de las suites largas (${heavyFile}) no se pudo leer` };
    heavy = { suites: new Map(), readsMd: new Set(), depsMode: new Map(), graphLines: new Map(), ignore: [] };
  }
  const rule = gateRule(skillsRoot);
  if (changed.known && rule.missing) changed = { known: false, reason: rule.missing };
  if (!changed.known) process.stderr.write(`ℹ️  ${changed.reason}: corre todo\n`);
  const { isValidPattern, touches } = rule;
  // Las que pasan del límite y van al nocturno (tramo F): la rama no las corre aunque el cambio las toque. Sin saber qué
  // cambió corre todo, también ellas; y si la lista no se deja leer no se saltea ninguna por el límite, y se dice.
  const overFile = arg(argv, '--over-limit');
  let toNightly = { limit: 0, names: new Set() };
  if (overFile) {
    const over = readOverLimit(overFile);
    if (over.problem) process.stderr.write(`⚠️  ${over.problem}: no salteo ninguna por el límite\n`);
    else if (changed.known) toNightly = { limit: over.limit, names: over.nightly };
  }
  const overSkip = (name) => `SKIP\t${name}\tpasa de ${toNightly.limit} s: la corre el nocturno`;
  const all = [...(suites.diarias || []), ...(suites.semanales || [])].filter((s) => s && typeof s.ruta === 'string');
  const rootExists = isDir(skillsRoot);
  const out = [`ROOT\tagent-skills\t${skillsRoot}\t${root.source}\t${rootExists ? 'ok' : 'missing'}`];
  const fromSkills = all.filter((s) => s.raiz === 'agent-skills').length;
  if (!rootExists && fromSkills) {
    process.stderr.write(`⚠️  la raíz «agent-skills» no existe: ${skillsRoot} (salió de: ${root.source}) — sus ${fromSkills} suite(s) salen NO MEDIDAS: siguen en la lista y quien la corre no las va a encontrar\n`);
  }
  // «La propia suite», como ruta del repo: scripts/<ruta> para las del arnés y, en el repo unido, skills/<ruta> para
  // las de agent-skills. Con dos repos físicos la de agent-skills queda fuera del repo y no hay ruta que comparar.
  // Para las de agent-skills se prueban DOS formas (pase adversarial del tramo 1 de la story 8.18, 2026-10-04): con la
  // RAÍZ resuelta a su ruta real, que es lo que había, y con el ARCHIVO entero resuelto. La segunda cubre `--skills`
  // apuntando a una carpeta real con un enlace por skill (la forma de `~/.claude/skills`): ahí la raíz resuelta es ella
  // misma, la ruta daba `../…` y la suite editada se difería. La primera se conserva porque un archivo que ya no está
  // en disco (la suite que el cambio borró) no se puede resolver. Alcanza con que una figure en el cambio: sumar una
  // forma sólo puede hacer correr una suite, nunca diferirla.
  const repoRoot = realDir(path.dirname(path.resolve(scriptsRoot)));
  const skillsReal = realDir(skillsRoot);
  const insideRepo = (abs) => {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    return rel.startsWith('../') || path.isAbsolute(rel) ? null : rel;
  };
  // Una suite PARTIDA (story 8.22, tramo F) es un archivo entero con todas sus pruebas y N partes de una línea,
  // `<suite>.p<k>.test.<js|sh>`, que son lo registrado. «La propia suite» de una parte es también su archivo entero —ahí
  // viven sus casos— y lo que la reparte: el registro de duraciones y la biblioteca. Y su CÓDIGO, para leer de qué depende,
  // es el del entero (`codePath`): leído desde la parte, el entero quedaba un nivel más abajo, sin su «recorre el repo» ni
  // lo que nombran los guiones que nombra. Pase adversarial del tramo: editar el entero de una partida con criterio propio
  // salteaba todas sus partes (20 de 28), y una partida sin criterio dejaba de correr con cambios en lo que usa.
  // Qué ES una parte lo dicen su nombre Y su contenido: la línea que carga el entero (`runPart` en Node, `SUITE_PART=k/n`
  // con el nombre del entero en consola). Sólo por el nombre, una suite común que se llamara `x.p1.test.js` al lado de
  // un `x.test.js` ajeno se leía por las dependencias de ése, y salía SKIP con un cambio en lo que ella sí usa (revisor
  // de fallos silenciosos, vuelta 3). Una parte que no está o no se deja leer se toma por el nombre: sólo puede hacerla
  // correr de más. El entero cuenta como propio esté o no en disco: si el cambio lo borró o lo movió, sus partes
  // quedaron sin qué cargar y tienen que correr y salir rojas, no saltearse hasta el nocturno. El código, en cambio, se
  // lee del entero sólo si está (`codePath`); si no, de la parte. Vale para las dos raíces.
  const PART = /^(.*)\.p[1-9]\d*\.test\.(js|sh)$/;
  const wholeNames = new Map();
  const wholeNameOf = (rel) => {
    if (!rel) return null;
    if (wholeNames.has(rel)) return wholeNames.get(rel);
    const m = rel.match(PART);
    let whole = m ? `${m[1]}.test.${m[2]}` : null;
    if (whole) {
      let text = null;
      try { text = fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch (_) { text = null; }
      const loads = m[2] === 'js' ? /suite-parts\.js['"`]\s*\)\s*\.runPart\(/ : /(^|\s)SUITE_PART=\d+\/\d+\s/;
      if (text !== null && !(loads.test(text) && (m[2] === 'js' || text.includes(path.posix.basename(whole))))) whole = null;
    }
    wholeNames.set(rel, whole);
    return whole;
  };
  const ownPaths = (s) => {
    const own = s.raiz === 'agent-skills'
      ? [path.join(skillsReal, s.ruta), realDir(path.join(skillsRoot, s.ruta))].map(insideRepo).filter(Boolean)
      : [`scripts/${s.ruta}`];
    for (const rel of [...own]) {
      const whole = wholeNameOf(rel);
      if (!whole) continue;
      const dir = path.posix.dirname(rel);
      own.push(whole, ...(whole.endsWith('.js') ? [`${dir}/suite-parts.json`, `${dir}/lib/suite-parts.js`] : [`${dir}/lib/suite-parts.sh`]));
    }
    return own;
  };
  const codePath = (s) => {
    const rel = ownPaths(s)[0];
    const whole = wholeNameOf(rel);
    return whole && fs.existsSync(path.join(repoRoot, whole)) ? whole : rel;
  };
  // --deps (story 8.22, tramo B; antes `64a5a523`): una suite que no declara criterio propio corre sólo si el cambio toca
  // algo de lo que su código usa (scripts/ci/suite-deps.js). Ante la duda, corre:
  //  (a) el cambio toca cómo se elige (este archivo, el lector de dependencias, el criterio de las pesadas, la lista de
  //      las que pasan de 45 s o el pipeline) → corre todo. La lista de suites no: casi toda story suma una suite, y la
  //      nueva viene en el cambio y se corre a sí misma; las que leen la lista dependen de ella como de cualquier archivo.
  //  (b) un archivo borrado o movido no tiene dependencias que leer: corre toda suite cuyo código nombre su nombre (con
  //      extensión, sin ella dentro de comillas —`require('./state')`— o la carpeta que se fue con él).
  //  (c) una suite que no está en disco corre, y quien la corre dice «NO se midió»; una que está y no se deja leer (o
  //      algo de lo que carga), también corre.
  //  (g) sin foto nocturna completa y de las últimas 36 h no hay red para lo salteado: no se saltea nada.
  // Las de `gate_only_when_touching` siguen con su criterio: `--deps` no las mira. Las pesadas (`--heavy`), desde el tramo
  // E, sí: corren si el cambio toca sus patrones, la red de `shared` o lo que usa su código (según su `deps`), y sin
  // `--deps` utilizable corren todas, porque sus patrones ya no alcanzan solos.
  const SELECTION_ITSELF = ['scripts/ci/suites-for-change.js', 'scripts/ci/suite-deps.js', 'scripts/ci/heavy-suites.json',
    'scripts/ci/suites-over-limit.json', 'pipelines/azure-pipelines-pr.yml'];
  let depsSel = null;
  if (argv.includes('--deps') && listed.known && changed.known) {
    const files = listed.files.map((f) => f.replace(/\\/g, '/'));
    const itself = files.filter((f) => SELECTION_ITSELF.includes(f));
    const noNet = nightlyNet(arg(argv, '--nightly'));
    if (itself.length) process.stderr.write(`ℹ️  el cambio toca cómo se eligen las suites (${itself.join(', ')}): corre todo\n`);
    else if (noNet) process.stderr.write(`ℹ️  --deps no saltea nada: el nocturno no midió todo: no hay red para lo salteado (${noNet})\n`);
    else {
      const D = require('./suite-deps.js');
      const missing = files.filter((f) => !fs.existsSync(path.join(repoRoot, f)));
      depsSel = { D, files, needles: missingNeedles(missing, repoRoot), needlesBy: new Map(), cache: new Map(), texts: new Map() };
    }
  }
  // ¿Se puede saltear `s` porque el cambio (`files`) no toca nada de lo que usa su código? `ignoreWhole`: la pesada con
  // `deps: "graph"`, cuyo ls-files o grep es sobre un repo de juguete — no depende de todo por eso.
  const depsSkip = (s, files = depsSel && depsSel.files, ignoreWhole = false) => {
    if (!depsSel) return false;
    const rel = codePath(s);
    if (!rel) return false;   // fuera del repo (skills instaladas): no hay código que leer, corre
    // no está —ella, o la parte registrada aunque su entero esté—: corre, y quien la corre dice «NO se midió»
    if (!fs.existsSync(path.join(repoRoot, rel)) || !fs.existsSync(path.join(repoRoot, ownPaths(s)[0]))) return false;
    const read = depsSel.D.suiteDeps(repoRoot, rel, depsSel.cache);
    const deps = ignoreWhole ? { ...read, wholeRepo: false } : read;
    // (c) algo de la suite que no se deja leer: no se sabe qué usa, corre (y se dice)
    for (const u of deps.unreadable) process.stderr.write(`⚠️  ${path.posix.basename(rel)}: no se deja leer ${u.rel} (${u.reason}) — corre\n`);
    if (depsSel.D.touchedBy(deps, files) || ownPaths(s).some((own) => files.includes(own))) return false;
    // lo borrado o movido de ESTA lista: una pesada que mira .md se evalúa con la lista entera, y un .md borrado que su
    // código lee también cuenta (pase adversarial del tramo E: antes sólo se buscaba lo de la lista de código)
    let needles = depsSel.needles;
    if (files !== depsSel.files) {
      const key = files.join('\n');
      if (!depsSel.needlesBy.has(key)) depsSel.needlesBy.set(key, missingNeedles(files.filter((f) => !fs.existsSync(path.join(repoRoot, f))), repoRoot));
      needles = depsSel.needlesBy.get(key);
    }
    if (needles.length) {
      // (b) lo borrado o movido: corre si lo que usa la suite lo nombra — por su nombre, sin extensión dentro de un
      // `require` o por una carpeta que ya no está. Un archivo que no se deja leer cuenta como que lo nombra.
      const view = (f) => {
        if (!depsSel.texts.has(f)) {
          let v = null;
          try { const t = fs.readFileSync(path.join(repoRoot, f), 'utf8'); v = { t, c: depsSel.D.candidates(t) }; } catch (_) { v = null; }
          depsSel.texts.set(f, v);
        }
        return depsSel.texts.get(f);
      };
      const names = (f) => { const v = view(f); return !v || needles.some((n) => v.t.includes(n) || v.c.has(n)); };
      if ([...deps.files].some(names)) return false;
    }
    return true;
  };
  // Las pesadas que miran .md (`reads_md`) se eligen con la lista ENTERA (`--changed-with-docs`); las demás, y todo lo
  // que no es pesada, con `--changed`, que en la 170 es la lista de código (story 8.22, AC 7: los .md no eligen suites).
  // Pedida y no legible: las que miran .md no saben qué .md cambiaron, y corren (sin lista, como en «no pude mirar»).
  const docsFile = arg(argv, '--changed-with-docs');
  let withDocs = readChanged(docsFile);
  if (docsFile && !withDocs.known) {
    process.stderr.write(`⚠️  --changed-with-docs ${docsFile} no se deja leer (${withDocs.reason}): las suites que miran .md corren\n`);
    withDocs = { known: false, unreadable: true };
  }
  const seen = new Set();
  const lines = [];
  const heavyWithoutDeps = [];
  // ¿El «graph» de esta pesada sigue revisado? Sólo si su código tiene hoy las mismas líneas que recorren el repo que
  // cuando alguien lo revisó (`graph_whole_lines`). Si no, depende de todo hasta que la revisen, y se dice (revisores del
  // tramo E: si no, un recorrido real del repo agregado después se salteaba en silencio).
  const graphStillReviewed = (s, name) => {
    const rel = codePath(s);
    let now = null;
    let sha = null;
    try {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      now = depsSel.D.wholeRepoLines(text);
      sha = depsSel.D.wholeRepoSha(text);
    } catch (_) { now = null; }
    const said = heavy.graphLines.get(name) || {};
    if (now === null || said.lines !== now) {
      process.stderr.write(`⚠️  ${name}: graph_whole_lines dice ${said.lines === undefined ? 'nada' : said.lines} y su código tiene ${now === null ? '¿?' : now} línea(s) que recorren el repo: depende de todo hasta que alguien la revise (${heavyFile})\n`);
      return false;
    }
    // mismo número, otras líneas (revisores del tramo E, iter 2): una reemplazada por otra también se vuelve a mirar
    if (said.sha !== sha) {
      process.stderr.write(`⚠️  ${name}: las líneas que recorren el repo cambiaron (graph_whole_sha): depende de todo hasta que alguien la revise (${heavyFile}, ahora ${sha})\n`);
      return false;
    }
    return true;
  };
  for (const s of all) {
    const abs = s.raiz === 'agent-skills' ? path.join(skillsRoot, s.ruta) : path.join(scriptsRoot, s.ruta);
    const name = path.basename(s.ruta);
    const heavyPatterns = s.raiz === 'agent-skills' ? null : heavy.suites.get(name);
    if (toNightly.names.has(name)) {
      if (heavyPatterns) seen.add(name);
      lines.push(overSkip(name));
      continue;
    }
    if (heavyPatterns) {
      seen.add(name);
      // Sin lista de cambios no se sabe qué tocó: corre.
      const list = heavy.readsMd.has(name) && (withDocs.known || withDocs.unreadable) ? withDocs : listed;
      const files = list.known ? list.files.map((f) => f.replace(/\\/g, '/')) : null;
      const mode = heavy.depsMode.get(name);
      // (lo propio de una parte —su archivo entero, el reparto— la corre aunque sus patrones no lo nombren)
      if (files && !files.some((f) => heavyPatterns.some((re) => re.test(f))) && !ownPaths(s).some((own) => files.includes(own))) {
        // tramo E: los patrones ya no alcanzan solos (la red de `shared` se achicó). Sin `--deps` utilizable corre, como
        // cualquier suite cuando --deps no saltea nada; con `deps: false`, sus patrones son todo su criterio; si no, se
        // saltea sólo si tampoco usa nada del cambio.
        if (!depsSel) heavyWithoutDeps.push(name);
        else if (mode === false) {
          lines.push(`SKIP\t${name}\tel cambio no toca lo que mide (${heavyFile}): la corre el banco nocturno`);
          continue;
        } else if (depsSkip(s, files.filter((f) => !heavy.ignore.some((re) => re.test(f))), mode === 'graph' && graphStillReviewed(s, name))) {
          lines.push(`SKIP\t${name}\tel cambio no toca lo que mide (${heavyFile}) ni nada de lo que usa su código (scripts/ci/suite-deps.js): la corre el banco nocturno`);
          continue;
        }
      }
      lines.push(`RUN\t${abs}`);
      continue;
    }
    const gate = s.gate_only_when_touching;
    if (gate !== undefined && changed.known) {
      if (!Array.isArray(gate) || !gate.length || !gate.every(isValidPattern)) {
        process.stderr.write(`⚠️  ${s.ruta}: «gate_only_when_touching» no es una lista de «<carpeta>/**» (${JSON.stringify(gate)}) — corre\n`);
      } else {
        if (!touches(changed.files, gate) && !ownPaths(s).some((own) => changed.files.includes(own))) {
          lines.push(`SKIP\t${path.basename(s.ruta)}\tel cambio no toca ${gate.join(', ')}: la corre el banco nocturno`);
          continue;
        }
      }
    }
    if (gate === undefined && depsSkip(s)) {
      lines.push(`SKIP\t${name}\tel cambio no toca nada de lo que usa su código (scripts/ci/suite-deps.js): la corre el banco nocturno`);
      continue;
    }
    lines.push(`RUN\t${abs}`);
  }
  if (heavyWithoutDeps.length) {
    process.stderr.write(`ℹ️  sin --deps utilizable, ${heavyWithoutDeps.length} pesada(s) que no tocan lo que miden corren igual: sus patrones ya no alcanzan solos (${heavyWithoutDeps.join(', ')})\n`);
  }
  for (const name of heavy.suites.keys()) {
    if (!seen.has(name)) process.stderr.write(`⚠️  ${heavyFile} nombra ${name}, que no está en suites.json: si se renombró, renombrala también ahí\n`);
  }
  // (f) si con --deps no queda ninguna suite que correr, corre todo: un cambio de código que nadie usa no es un «nada
  // que medir», y un plan vacío la 170 lo cuenta como «no se midió» (rojo)
  if (depsSel && !lines.some((l) => l.startsWith('RUN\t'))) {
    process.stderr.write('ℹ️  con --deps no quedaba ninguna suite: corre todo\n');
    lines.length = 0;
    for (const s of all) {
      const name = path.basename(s.ruta);
      lines.push(toNightly.names.has(name) ? overSkip(name) : `RUN\t${s.raiz === 'agent-skills' ? path.join(skillsRoot, s.ruta) : path.join(scriptsRoot, s.ruta)}`);
    }
  }
  out.push(...lines);
  process.stdout.write(out.join('\n') + (out.length ? '\n' : ''));
  return 0;
}

// 🔴 `process.exitCode`, no `process.exit()`: escrita a una tubería, la salida es asincrónica y `process.exit()` la corta
// a los 8 KB (medido el 2026-10-04 con la lista real: 140 de 219 líneas, sin la copia pública ni la máquina limpia). En
// el pipeline va a un archivo y no mordía; a quien la lea por una tubería, sí.
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, nightlyNet, readOverLimit, overLimitProblems };
