#!/usr/bin/env node
'use strict';
// export-compare.js — la copia pública antes y después de una mudanza (story 8.12, AC 4 · tanda R2, 2026-10-02)
//
// POR QUÉ EXISTE: la 8.12 muda carpetas enteras del arnés (R2, R4, R5, R6) y el exportador nombra muchas de esas rutas
// (exclusiones fijas, «in» y «out» de la lista blanca). Una mudanza que se olvida de mover un glob puede publicar en
// silencio lo que antes quedaba excluido, o dejar afuera lo que salía. El AC 4 pide que cada tanda que toca una ruta que
// el exportador nombra compare la copia de antes con la de después y que la diferencia sea SÓLO de rutas. Este ayudante
// lo hace igual en todas las tandas: saca una foto de cada lado y las compara.
//
// QUÉ COMPARA, paquete por paquete (`core` y `bizuit`) y fuente por fuente (arnes, agent-skills):
//   a) lo que SALE en la copia y lo que queda EXCLUIDO (cubierto por un «in» del paquete pero fuera de la copia), por
//      contenido: una ruta que cambió con el mismo contenido es «movido», no hallazgo; la misma ruta con el contenido
//      retocado tampoco; movido y retocado con el mismo nombre de archivo, del mismo lado, se lista aparte. Un archivo
//      que cambia de lado (excluido que ahora sale, o al revés), uno nuevo y uno que desaparece son hallazgos. Un
//      cambio de lado nunca queda tapado por un contenido repetido (los `.gitkeep` vacíos): la ruta que cruzó se mira
//      antes que cualquier emparejamiento por contenido, y entre contenidos iguales gana la ruta más parecida;
//   b) ningún glob muerto ni entrada sin clasificar NUEVOS (`exclusionesSinArchivo` y `sinClasificar` del --explain,
//      `globsSinUso` y `entradasSinClasificar` de la exportación);
//   c) `spanishNames` (el termómetro de nombres en castellano, del --json de la exportación) igual;
//   d) `scripts/publishing/names-ceiling.json` igual (sin contar sus claves `__…`, que lo explican).
//   Los reemplazos generados que deja una mudanza en la ruta vieja no cuentan: no salen y no son un archivo.
//
// LA FOTO (`snapshot`) corre el exportador como lo correría cualquiera —`--explain --json` y la exportación de cada
// paquete con `--json`— contra los commits pedidos, y guarda en <carpeta>: snapshot.json (qué se corrió y cómo salió),
// explain.json, export-<paquete>.json, files-<paquete>.json (rutas y hash de git de lo que sale y lo excluido) y
// names-ceiling.json (el del commit del arnés). La copia y su listado PRIVADO de reemplazos se arman en un temporal y se
// borran: en la foto no queda ningún nombre real. El exportador que corre es el de `--exporter` (default: el de al lado):
// para el «antes» de una tanda, el de un clon `--shared` en el sha base, así cada lado se clasifica con su configuración.
//
// CÓMO FALLA: `diff` sale 0 = sólo cambiaron rutas · 1 = hallazgos (cada uno dicho en castellano) · 2 = no pude comparar
// (una foto rota o que falta, o una foto «antes» cuya exportación no salió). `snapshot` sale 0 con la foto escrita
// (aunque una exportación haya dado 1: los hallazgos son dato, y lo dice) · 2 si no pudo sacarla, o si el --explain o una
// exportación no pudo salir (2): la foto queda escrita para mirarla, pero no sirve (story 8.18, pase adversarial del
// tramo 2: antes salía 0 y una foto rota pasaba por buena). «No pude comparar» nunca es 0.
// Sin `--agent-skills`, el commit de agent-skills lo elige el exportador: en el repo unido, el de `--harness`.
//
// A mano (los repos, como el exportador: TYCON_GUIDES_DIR y TYCON_SKILLS_DIR):
//   node scripts/publishing/export-compare.js snapshot --out <carpeta-nueva> [--harness <ref>] [--agent-skills <ref>]
//        [--exporter <export.js>] [--packages core,bizuit] [--work <carpeta-temporal>]
//   node scripts/publishing/export-compare.js diff <foto-antes> <foto-después> [--json]
// La tanda guarda las dos fotos y el diff en la carpeta de su corrida (.advisors/pipeline-runs/<corrida>/export-compare/).
// Desde la story 8.18 (el repo unido), dos comparaciones más, sobre copias `--single-repo` ya armadas y sobre dos salidas
// de `--explain --json` (el porqué y las reglas, más abajo: «El mismo árbol desde el repo unido»):
//   node scripts/publishing/export-compare.js trees <copia-antes> <copia-después> [--json]
//        [--range <unión>..<punta> [--repo <clon>]] [--touched <lista>] [--allowlist <f>]
//   node scripts/publishing/export-compare.js exclusions <explain-antes.json> <explain-después.json> [--json]
//
// DESDE EL CORTE A GITHUB (story 8.26, AC 36) el exportador de este repo ya no arma copias: `snapshot` con el de al lado
// sale 2 (la exportación de cada paquete no sale), y `trees` no tiene copias nuevas que comparar. Quedan `diff` (sobre
// fotos ya sacadas) y `exclusions` (sobre dos salidas de `--explain --json`). Para comparar copias de antes del corte,
// `snapshot --exporter` con el `export.js` de un clon en un commit de entonces.
// Guía: guides/publicacion-espejo.md

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SOURCES = Object.freeze(['arnes', 'agent-skills']);
const SETS = Object.freeze(['shipped', 'excluded']);
const DEFAULT_PACKAGES = Object.freeze(['core', 'bizuit']);
const SNAPSHOT_VERSION = 1;
const CEILING = 'scripts/publishing/names-ceiling.json';
const SIDE = { shipped: 'sale en la copia', excluded: 'queda excluido' };

class CouldNotCompare extends Error {}

// ── utilidades ──────────────────────────────────────────────────────────────────────────────────────────────────
function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new CouldNotCompare(`${what}: no pude leer ${file} (${e.code || e.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CouldNotCompare(`${what}: ${file} no es un JSON válido (${e.message})`);
  }
}
/** El JSON con las claves ordenadas: dos objetos iguales dan el mismo texto, escriba quien los escriba. */
function canonical(x) {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}
const withoutDocKeys = (x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith('__'))) : x);
const strings = (x) => (Array.isArray(x) ? x.map((v) => (typeof v === 'string' ? v : canonical(v))) : []);

// ── la foto ─────────────────────────────────────────────────────────────────────────────────────────────────────
function git(dir, args, opts = {}) {
  // con salida binaria la entrada va como Buffer: spawnSync codifica una entrada de texto con `encoding`
  const input = opts.input === undefined ? undefined : (opts.binary ? Buffer.from(opts.input, 'utf8') : opts.input);
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: opts.binary ? 'buffer' : 'utf8', input, maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) {
    throw new CouldNotCompare(`git ${args.slice(0, 3).join(' ')} en ${dir} falló: ${r.error ? r.error.message : String(r.stderr).trim()}`);
  }
  return r.stdout;
}
/** `{ ruta: hash }` de los blobs de un commit (el hash de git ES el del contenido). */
function treeOf(dir, sha) {
  const out = git(dir, ['ls-tree', '-r', '-z', '--full-tree', sha]);
  const files = {};
  for (const line of out.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [, type, obj] = line.slice(0, tab).split(' ');
    if (type === 'blob') files[line.slice(tab + 1)] = obj;
  }
  return files;
}
function readBlobs(dir, objs) {
  const unique = [...new Set(objs)];
  const map = new Map();
  if (!unique.length) return map;
  const out = git(dir, ['cat-file', '--batch'], { input: `${unique.join('\n')}\n`, binary: true });
  let i = 0;
  for (const expected of unique) {
    const end = out.indexOf(0x0a, i);
    const head = out.slice(i, end).toString('utf8').split(' ');
    if (head[0] !== expected || head[1] === 'missing') throw new CouldNotCompare(`git cat-file no devolvió el objeto ${expected}`);
    const n = Number(head[2]);
    map.set(expected, out.slice(end + 1, end + 1 + n).toString('utf8'));
    i = end + 1 + n + 1;
  }
  return map;
}

function parseSnapshotArgs(argv) {
  const a = { packages: [...DEFAULT_PACKAGES] };
  const withValue = new Map([['--out', 'out'], ['--harness', 'harness'], ['--agent-skills', 'agentSkills'], ['--exporter', 'exporter'], ['--work', 'work'], ['--packages', 'packages']]);
  for (let i = 0; i < argv.length; i++) {
    const k = withValue.get(argv[i]);
    if (!k) throw new CouldNotCompare(`opción desconocida para snapshot: ${argv[i]}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new CouldNotCompare(`${argv[i - 1]} necesita un valor`);
    a[k] = k === 'packages' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v;
  }
  if (!a.out) throw new CouldNotCompare('snapshot necesita --out <carpeta nueva>');
  if (!a.packages.length) throw new CouldNotCompare('--packages vacío');
  return a;
}

/**
 * La parte del pre-commit del repo unido que la exportación publicó como el `.githooks/pre-commit` de `source`, o null.
 * En el repo unido el pre-commit viene partido (`pre-commit-harness`, `pre-commit-skills`) y la copia de dos repos
 * devuelve cada parte a su repo (transformación split-hooks, que la exportación anota en `ajustes`). Su ruta no está en
 * la copia, pero su contenido sí sale: no es un excluido (story 8.18, pase adversarial del tramo 2, clase 11 — la foto
 * las anotaba como excluidas y un `diff` entre una foto de antes de la unión y una del repo unido daba dos hallazgos
 * falsos). El nombre de la parte lo dice el exportador que corrió (`HOOK_PARTS`): uno que parte el pre-commit y no lo
 * dice es «no pude sacar la foto», nunca una parte adivinada.
 */
function splitHookPart(ctx, pkg, exportJson, source) {
  const split = (exportJson.ajustes || []).some((x) => x && x.transformacion === 'split-hooks' && x.archivo === `${source}/.githooks/pre-commit`);
  if (!split) return null;
  const parts = ctx.exporter.HOOK_PARTS;
  if (!parts || typeof parts[source] !== 'string') {
    throw new CouldNotCompare(`la exportación de ${pkg} partió el pre-commit (split-hooks) y el exportador no dice cómo se llama la parte de ${source} (export.js → HOOK_PARTS)`);
  }
  return parts[source];
}

/** Lo que sale y lo excluido de un paquete, con el hash de cada archivo. */
function filesOf(ctx, pkg, exportJson) {
  const copy = exportJson.salida;
  if (!copy || !fs.existsSync(copy)) throw new CouldNotCompare(`la exportación de ${pkg} salió 0 pero su copia no está en ${copy}`);
  const result = { shipped: {}, excluded: {} };
  for (const source of SOURCES) {
    const sha = exportJson.fuentes && exportJson.fuentes[source] && exportJson.fuentes[source].sha;
    if (!sha) throw new CouldNotCompare(`la exportación de ${pkg} no dice de qué commit salió ${source}`);
    const shipped = fs.existsSync(path.join(copy, source)) ? treeOf(path.join(copy, source), 'HEAD') : {};
    const def = (ctx.list.packages[pkg] || {})[source] || {};
    if (!Array.isArray(def.in)) throw new CouldNotCompare(`la lista blanca (${ctx.listPath}) no tiene «in» para ${pkg}/${source}`);
    // el repo unido (story 8.18): el exportador leyó UNA fuente física y la partió por ruta; acá, lo mismo — el árbol de
    // cada fuente lógica es su mitad del commit del arnés, y no se busca ningún otro clon
    const unified = exportJson.physicalSources === 1;
    if (unified && typeof ctx.sourceOfPath !== 'function') throw new CouldNotCompare(`la exportación de ${pkg} salió de una sola fuente física y al lado del exportador no está cómo partirla por ruta (new-names.js → sourceOfPath)`);
    const whole = treeOf(unified ? ctx.repos.arnes : ctx.repos[source], sha);
    const tree = unified ? Object.fromEntries(Object.entries(whole).filter(([r]) => ctx.sourceOfPath(r) === source)) : whole;
    const repoOfSource = unified ? ctx.repos.arnes : ctx.repos[source];
    const hookPart = splitHookPart(ctx, pkg, exportJson, source);
    const candidates = Object.keys(tree).filter((r) => r !== hookPart && !Object.prototype.hasOwnProperty.call(shipped, r) && def.in.some((g) => ctx.exporter.coincide(g, r)));
    const shimCandidates = ctx.legacy ? candidates.filter((r) => ctx.legacy.supportsShim(r)) : [];
    const texts = readBlobs(repoOfSource, shimCandidates.map((r) => tree[r]));
    const excluded = {};
    for (const r of candidates) {
      if (ctx.legacy && texts.has(tree[r]) && ctx.legacy.isShim(texts.get(tree[r]))) continue;   // un reemplazo generado
      excluded[r] = tree[r];
    }
    result.shipped[source] = shipped;
    result.excluded[source] = excluded;
  }
  return result;
}

function snapshot(argv) {
  const started = Date.now();
  const a = parseSnapshotArgs(argv);
  const exporterPath = path.resolve(a.exporter || path.join(__dirname, 'export.js'));
  if (!fs.existsSync(exporterPath)) throw new CouldNotCompare(`no encuentro el exportador en ${exporterPath}`);
  const exporterRoot = path.resolve(path.dirname(exporterPath), '..', '..');
  const out = path.resolve(a.out);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new CouldNotCompare(`--out ya existe y no está vacía: ${out} — la foto va en una carpeta nueva`);
  fs.mkdirSync(out, { recursive: true });
  const workParent = path.resolve(a.work || os.tmpdir());
  const work = fs.mkdtempSync(path.join(workParent, 'export-compare-'));
  // `--agent-skills` va sólo si se pidió (story 8.18, pase adversarial del tramo 2, clase 1): sin él, el exportador hace
  // lo de siempre —en el repo unido las dos fuentes salen del commit de --harness; con dos repos, origin/main de
  // agent-skills—. Antes se le pasaba siempre origin/main, y la foto de una rama adelantada del repo unido salía rota.
  // En snapshot.json, `agentSkills: null` = el que eligió el exportador (lo dice export-<paquete>.json → fuentes).
  const refs = ['--harness', a.harness || 'origin/main', ...(a.agentSkills ? ['--agent-skills', a.agentSkills] : [])];
  const run = (args) => spawnSync(process.execPath, [exporterPath, ...args, ...refs], { encoding: 'utf8', maxBuffer: 1 << 30, cwd: workParent });
  const put = (name, value) => fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`);
  const meta = { version: SNAPSHOT_VERSION, createdAt: new Date().toISOString(), exporter: exporterPath, refs: { harness: refs[1], agentSkills: a.agentSkills || null }, packages: a.packages, explain: {}, exports: {} };
  const notes = [];
  // lo que hace que la foto no sirva: el --explain o una exportación que NO PUDO salir (≠ 0 y ≠ 1; 1 son hallazgos: dato)
  const broken = [];
  try {
    // el exportador que corre trae su configuración, sus exclusiones y su `coincide`: cada lado se mira con lo suyo
    const exporter = require(exporterPath);
    let legacy = null;
    try { legacy = require(path.join(exporterRoot, 'scripts', 'lib', 'legacy-names.js')); } catch (_) { legacy = null; }
    const repos = {
      arnes: process.env.TYCON_GUIDES_DIR ? path.resolve(process.env.TYCON_GUIDES_DIR.replace(/^~(?=$|[\\/])/, os.homedir())) : exporterRoot,
      'agent-skills': require(path.join(exporterRoot, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR).repo,
    };
    const listPath = path.join(path.dirname(exporterPath), 'allowlist.json');
    const rawList = readJson(listPath, 'la lista blanca');
    const list = typeof exporter.paquetesConNombresNuevos === 'function' ? exporter.paquetesConNombresNuevos(rawList) : rawList;
    // las rutas de la fuente lógica agent-skills en el repo unido (story 8.18): las dice new-names.js, al lado del exportador
    // que corre. Uno de antes de la unión no las trae, y tampoco las necesita: nunca lee una sola fuente física
    let sourceOfPath = null;
    const namesPath = path.join(path.dirname(exporterPath), 'new-names.js');
    if (fs.existsSync(namesPath)) {
      const names = require(namesPath);
      if (typeof names.sourceOfPath === 'function') sourceOfPath = names.sourceOfPath;
    }
    const ctx = { exporter, legacy, repos, list, listPath, sourceOfPath };

    const ex = run(['--explain', '--json']);
    meta.explain = { exit: ex.status, stderr: String(ex.stderr || '').slice(-2000) };
    let explainJson = null;
    if (ex.status === 0) {
      try { explainJson = JSON.parse(ex.stdout); } catch (e) { throw new CouldNotCompare(`--explain salió 0 pero su salida no es JSON (${e.message})`); }
      put('explain.json', explainJson);
    } else {
      const why = String(ex.stderr || '').trim().split('\n').pop();
      notes.push(`--explain salió ${ex.status}`);
      broken.push(`--explain salió ${ex.status}${why ? `: ${why.slice(0, 400)}` : ''}`);
    }

    for (const pkg of a.packages) {
      const copy = path.join(work, `copia-${pkg}`);
      const r = run(['--package', pkg, '--output', copy, '--report', path.join(work, `${pkg}.reemplazos.md`), '--json']);
      let json;
      try { json = JSON.parse(r.stdout); } catch (e) {
        throw new CouldNotCompare(`la exportación de ${pkg} salió ${r.status} sin un JSON legible (${e.message}): ${String(r.stderr || '').slice(-600)}`);
      }
      meta.exports[pkg] = { exit: r.status, stderr: String(r.stderr || '').slice(-2000) };
      put(`export-${pkg}.json`, json);
      if (r.status === 0) put(`files-${pkg}.json`, filesOf(ctx, pkg, json));
      else {
        const said = `la exportación de ${pkg} salió ${r.status}${json.motivo ? `: ${json.motivo}` : ''}`;
        notes.push(said);
        if (r.status !== 1) broken.push(said);
      }
      fs.rmSync(copy, { recursive: true, force: true });
      fs.rmSync(path.join(work, `${pkg}.reemplazos.md`), { force: true });   // PRIVADO: nunca queda
    }

    // el techo, del commit del arnés que se exportó
    const harnessSha = (explainJson && explainJson.fuentes && explainJson.fuentes.arnes.sha)
      || git(repos.arnes, ['rev-parse', '--verify', `${refs[1]}^{commit}`]).trim();
    meta.shas = { arnes: harnessSha };
    // «el archivo no está en ese commit» es dato (nota); cualquier otro fallo de git (permisos, «dubious ownership», un
    // sha que no existe, git ausente) es no poder sacar la foto: nunca una foto que parece completa. Git en inglés
    // (LC_ALL=C) para poder leer el motivo.
    const shown = spawnSync('git', ['-C', repos.arnes, 'show', `${harnessSha}:${CEILING}`], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    const gitSaid = String(shown.stderr || '').trim();
    if (shown.status === 0) {
      let ceiling;
      try { ceiling = JSON.parse(shown.stdout); } catch (e) { throw new CouldNotCompare(`${CEILING} de ${harnessSha} no es JSON (${e.message})`); }
      put('names-ceiling.json', ceiling);
    } else if (!shown.error && shown.status === 128 && /does not exist in|exists on disk, but not in/.test(gitSaid)) {
      put('names-ceiling.json', null);
      notes.push(`${CEILING} no está en ${harnessSha.slice(0, 12)}`);
    } else {
      throw new CouldNotCompare(`no pude leer ${CEILING} de ${harnessSha.slice(0, 12)} en ${repos.arnes}: git ${shown.error
        ? `no corrió (${shown.error.message})` : `salió ${shown.status}${gitSaid ? `: ${gitSaid.slice(-600)}` : ' sin decir por qué'}`}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  meta.seconds = Math.round((Date.now() - started) / 1000);
  put('snapshot.json', meta);
  if (broken.length) {
    // escrita igual, para mirarla; pero una foto rota no es una foto (no sirve de base ni dice cómo sale la copia)
    process.stderr.write(`⛔ export-compare: la foto en ${out} quedó escrita, pero no sirve — ${broken.join(' · ')}\n`);
    return 2;
  }
  process.stdout.write(`📸 foto en ${out} (${meta.seconds} s)${notes.length ? ` — ojo: ${notes.join(' · ')}` : ''}\n`);
  return 0;
}

// ── la comparación ──────────────────────────────────────────────────────────────────────────────────────────────
function loadPhoto(dir, label) {
  const abs = path.resolve(dir);
  const file = (name) => path.join(abs, name);
  if (!fs.existsSync(file('snapshot.json'))) throw new CouldNotCompare(`la foto «${label}» (${abs}) no tiene snapshot.json: no es una foto de export-compare.js snapshot`);
  const meta = readJson(file('snapshot.json'), `la foto «${label}»`);
  if (!meta || meta.version !== SNAPSHOT_VERSION || !Array.isArray(meta.packages)) throw new CouldNotCompare(`la foto «${label}»: snapshot.json no tiene la forma de la versión ${SNAPSHOT_VERSION}`);
  const photo = { label, meta, explain: null, exports: {}, files: {}, ceiling: null };
  if (meta.explain && meta.explain.exit === 0) photo.explain = readJson(file('explain.json'), `la foto «${label}»`);
  for (const pkg of meta.packages) {
    photo.exports[pkg] = readJson(file(`export-${pkg}.json`), `la foto «${label}»`);
    if (photo.exports[pkg].resultado === 0) {
      const f = readJson(file(`files-${pkg}.json`), `la foto «${label}»`);
      for (const set of SETS) {
        if (!f || typeof f[set] !== 'object' || !f[set]) throw new CouldNotCompare(`la foto «${label}»: files-${pkg}.json no tiene «${set}»`);
      }
      photo.files[pkg] = f;
    }
  }
  photo.ceiling = readJson(file('names-ceiling.json'), `la foto «${label}»`);
  return photo;
}

const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
/** Cuántos tramos finales de ruta comparten dos rutas: `notas/pending/.gitkeep` se parece más a
 *  `inbox/notas/pending/.gitkeep` (3) que a `inbox/notas/archived/.gitkeep` (1). */
function sharedTail(p, q) {
  const a = p.split('/');
  const b = q.split('/');
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Empareja lo de antes con lo de después de una fuente de un paquete.
 *  El ORDEN de los pasos es el contrato: un cambio de lado de una RUTA se mira antes que cualquier emparejamiento por
 *  contenido, y el emparejamiento por contenido del mismo lado se queda sólo con lo que sobra de cada lado. Así, con
 *  contenidos repetidos (los `.gitkeep` vacíos), un archivo que entra o sale de la copia nunca queda «movido» (pase
 *  adversarial R2). Todo emparejamiento es determinista: no depende del orden de las claves de la foto. */
function compareFiles(pkg, source, before, after, out) {
  const entries = (photo) => SETS.flatMap((set) => Object.entries((photo[set] || {})[source] || {}).map(([p, hash]) => ({ set, path: p, hash })))
    .sort((x, y) => byText(x.set, y.set) || byText(x.path, y.path));
  const b = entries(before);
  const a = entries(after);
  const used = new Set();
  const take = (x) => used.add(x);
  const free = (list) => list.filter((x) => !used.has(x));
  const sideChanged = (x, y) => {
    const was = y.path === x.path ? x.path : `${y.path} → ${x.path}`;
    out.findings.push({
      kind: x.set === 'shipped' ? 'now-shipped' : 'now-excluded', package: pkg, source, path: x.path, from: y.path,
      message: x.set === 'shipped'
        ? `paquete ${pkg}, ${source}: ${was} AHORA SALE en la copia pública y antes quedaba excluido — ¿se movió fuera de su exclusión sin su glob?`
        : `paquete ${pkg}, ${source}: ${was} ahora queda excluido y antes salía en la copia`,
    });
  };
  /** Empareja por contenido lo que sobra: del mismo lado (`sameSide`) o del otro. Entre varios candidatos con el mismo
   *  contenido gana el de ruta más parecida, y a igual parecido el orden alfabético. */
  const pairByContent = (sameSide) => {
    const byHash = new Map();
    for (const y of free(b)) {
      if (!byHash.has(y.hash)) byHash.set(y.hash, []);
      byHash.get(y.hash).push(y);
    }
    const pairs = [];
    for (const x of free(a)) {
      for (const y of byHash.get(x.hash) || []) {
        if ((y.set === x.set) === sameSide) pairs.push({ x, y, score: sharedTail(x.path, y.path) });
      }
    }
    pairs.sort((p, q) => q.score - p.score || byText(p.x.set, q.x.set) || byText(p.x.path, q.x.path) || byText(p.y.path, q.y.path));
    const chosen = [];
    for (const p of pairs) {
      if (used.has(p.x) || used.has(p.y)) continue;
      take(p.x); take(p.y);
      chosen.push(p);
    }
    return chosen;
  };
  const pathIndex = (list) => new Map(list.map((x) => [`${x.set}\0${x.path}`, x]));
  // 1 · la misma ruta, del mismo lado (el contenido puede estar retocado)
  const beforeAt = pathIndex(b);
  for (const x of a) {
    const y = beforeAt.get(`${x.set}\0${x.path}`);
    if (y) { take(x); take(y); }
  }
  // 2 · la misma ruta, del otro lado: cambió de lado (antes que cualquier emparejamiento por contenido)
  for (const x of free(a)) {
    const y = beforeAt.get(`${x.set === 'shipped' ? 'excluded' : 'shipped'}\0${x.path}`);
    if (y && !used.has(y)) { take(x); take(y); sideChanged(x, y); }
  }
  // 3 · el mismo contenido en otra ruta, del mismo lado: movido
  for (const { x, y } of pairByContent(true)) out.moved.push({ package: pkg, source, set: x.set, from: y.path, to: x.path });
  // 4 · el mismo nombre de archivo, del mismo lado, sin otro candidato: movido y retocado
  for (const x of free(a)) {
    if (used.has(x)) continue;
    const base = path.posix.basename(x.path);
    const ys = free(b).filter((z) => z.set === x.set && path.posix.basename(z.path) === base);
    const xs = free(a).filter((z) => z.set === x.set && path.posix.basename(z.path) === base);
    if (ys.length === 1 && xs.length === 1) { take(x); take(ys[0]); out.movedEdited.push({ package: pkg, source, set: x.set, from: ys[0].path, to: x.path }); }
  }
  // 5 · el mismo contenido en otra ruta, del otro lado: cambió de lado (lo que sobró del paso 3, que con contenidos
  //     repetidos es justamente el que cruzó)
  for (const { x, y } of pairByContent(false)) sideChanged(x, y);
  // 6 · lo que queda: nuevo de un lado, desaparecido del otro
  for (const x of free(a)) {
    out.findings.push({ kind: `new-${x.set}`, package: pkg, source, path: x.path,
      message: `paquete ${pkg}, ${source}: ${x.path} es nuevo y ${SIDE[x.set]} (antes no estaba, ni con otra ruta ni con el mismo contenido)` });
  }
  for (const y of free(b)) {
    out.findings.push({ kind: `gone-${y.set}`, package: pkg, source, path: y.path,
      message: y.set === 'shipped'
        ? `paquete ${pkg}, ${source}: ${y.path} salía en la copia y ya no sale (ni con otra ruta ni con el mismo contenido)`
        : `paquete ${pkg}, ${source}: ${y.path} quedaba excluido y desapareció (¿se borró, o ya no lo cubre ningún «in»?)` });
  }
}

function compare(beforeDir, afterDir) {
  const before = loadPhoto(beforeDir, 'antes');
  const after = loadPhoto(afterDir, 'después');
  if (!before.explain) throw new CouldNotCompare(`la foto «antes» no sirve de base: su --explain salió ${before.meta.explain && before.meta.explain.exit}`);
  for (const pkg of before.meta.packages) {
    if (before.exports[pkg].resultado !== 0) throw new CouldNotCompare(`la foto «antes» no sirve de base: la exportación de ${pkg} salió ${before.exports[pkg].resultado}`);
  }
  const out = { findings: [], moved: [], movedEdited: [] };
  const add = (kind, message, extra = {}) => out.findings.push({ kind, ...extra, message });

  // b · lo del --explain
  if (!after.explain) {
    add('explain-failed', `--explain salió ${after.meta.explain && after.meta.explain.exit} en la foto «después»: ${String((after.meta.explain || {}).stderr || '').trim().slice(-300)}`);
  } else {
    const was = new Set(strings(before.explain.sinClasificar));
    for (const e of strings(after.explain.sinClasificar)) if (!was.has(e)) add('unclassified', `${e}: entrada de primer nivel SIN CLASIFICAR que antes no estaba (va a «in» de un paquete o a una exclusión, en el mismo commit que la crea)`, { entry: e });
    const key = (x) => `${x.origen}|${x.paquete || ''}|${x.fuente}|${x.glob !== undefined ? x.glob : `#${x.indice}`}`;
    const dead = new Set((before.explain.exclusionesSinArchivo || []).map(key));
    for (const x of after.explain.exclusionesSinArchivo || []) {
      if (dead.has(key(x))) continue;
      const which = x.origen === 'afuera-privado' ? `afuera privado #${x.indice}` : `${x.origen}${x.paquete ? ` (${x.paquete})` : ''} ${x.glob}`;
      add('dead-glob', `${x.fuente}: la exclusión ${which} ya no cubre ningún archivo${x.reemplazos ? ' (sólo queda su reemplazo en la ruta vieja)' : ''} — ¿se movió el archivo sin su glob?`, { source: x.fuente });
    }
  }

  // a, b, c · cada paquete
  const packages = [...new Set([...before.meta.packages, ...after.meta.packages])];
  for (const pkg of packages) {
    if (!after.meta.packages.includes(pkg)) { add('package-missing', `la foto «después» no trae el paquete ${pkg}`, { package: pkg }); continue; }
    if (!before.meta.packages.includes(pkg)) { add('package-missing', `la foto «antes» no trae el paquete ${pkg}: no hay contra qué compararlo`, { package: pkg }); continue; }
    const eb = before.exports[pkg];
    const ea = after.exports[pkg];
    for (const field of ['globsSinUso', 'entradasSinClasificar']) {
      const was = new Set(strings(eb[field]));
      for (const g of strings(ea[field])) {
        if (was.has(g)) continue;
        if (field === 'globsSinUso') add('dead-glob', `paquete ${pkg}: el glob de «in» ${g} no coincide con nada (antes sí)`, { package: pkg });
        else add('unclassified', `paquete ${pkg}: ${g} quedó sin clasificar (antes no)`, { package: pkg, entry: g });
      }
    }
    if (ea.resultado !== 0) {
      add('export-failed', `la exportación del paquete ${pkg} salió ${ea.resultado} en la foto «después»${ea.motivo ? `: ${String(ea.motivo).slice(0, 400)}` : ''}`, { package: pkg });
      continue;
    }
    if (canonical(eb.spanishNames) !== canonical(ea.spanishNames)) {
      add('spanish-names', `paquete ${pkg}: el termómetro de nombres en castellano cambió (antes ${canonical(eb.spanishNames)} · después ${canonical(ea.spanishNames)})`, { package: pkg });
    }
    for (const source of SOURCES) compareFiles(pkg, source, before.files[pkg], after.files[pkg], out);
  }

  // d · el techo de nombres
  if (canonical(withoutDocKeys(before.ceiling)) !== canonical(withoutDocKeys(after.ceiling))) {
    add('names-ceiling', `${CEILING} cambió (antes ${canonical(withoutDocKeys(before.ceiling))} · después ${canonical(withoutDocKeys(after.ceiling))})`);
  }
  return { result: out.findings.length ? 1 : 0, ...out };
}

function human(r) {
  const l = [];
  const list = (title, items) => {
    if (!items.length) return;
    l.push('', `${title} (${items.length}):`);
    for (const m of items) l.push(`  ${m.package} · ${m.source}: ${m.from} → ${m.to}${m.set === 'excluded' ? ' (excluido)' : ''}`);
  };
  if (r.result === 0) l.push(`✅ antes y después iguales salvo rutas: ${r.moved.length} movido(s), ${r.movedEdited.length} movido(s) y retocado(s)`);
  else {
    l.push(`🛑 la copia de después no es la de antes con otras rutas: ${r.findings.length} hallazgo(s)`, '');
    for (const f of r.findings) l.push(`  · ${f.message}`);
  }
  list('movidos con el mismo contenido', r.moved);
  list('movidos y retocados (mismo nombre de archivo, del mismo lado)', r.movedEdited);
  return `${l.join('\n')}\n`;
}

// ══ El mismo árbol desde el repo unido (story 8.18, tramo 2 · 2026-10-04) ═══════════════════════════════════════════════
// POR QUÉ: el arnés y agent-skills pasaron a ser UN repo, y la condición para cortar es binaria: la copia `--single-repo`
// que el exportador arma desde el repo unido es EL MISMO ÁRBOL que la que armaba desde los dos repos. `diff` (arriba)
// compara fotos de la copia de dos repos y tolera mudanzas; acá no hay nada que tolerar. `trees` compara dos copias ya
// armadas (cada una un repo de git con un commit) por el identificador de git: el árbol entero, cada entrada de primer
// nivel y, donde difieren, archivo por archivo. Una diferencia sólo pasa si está DECLARADA:
//   · el `.gitignore` de después es el de antes menos exactamente el bloque `.advisors/` de agent-skills —esa línea y
//     las de comentario que tiene pegadas arriba— (decisión del dueño, 2026-10-03: unir los dos .gitignore tal cual
//     dejaba de versionar el registro de revisores);
//   · con `--range <unión>..<punta>` (o `--touched <lista>`), un archivo que la story tocó a propósito: los archivos
//     distintos tienen que ser un subconjunto de la IMAGEN, por el exportador, de lo tocado. La imagen de un archivo es su
//     misma ruta y, en tres casos que dice la lista blanca o el exportador, otra: una skill que sale renombrada
//     (`skillRenames`), un papel (`synthetic`: su destino) y un revisor (sus dos traducciones a Codex). Un archivo
//     distinto que no es imagen de nada tocado es un intruso: 1, nombrándolo. Sólo tiene imagen lo que el exportador
//     publica (`shipsByExporter`): un archivo privado que la story tocó y que aparece en la copia es un intruso, no
//     algo «tocado a propósito». Por eso con lo tocado hace falta también la tabla privada al lado de la lista blanca.
// `exclusions` compara dos salidas de `export.js --explain --json`: 0 sin clasificar, 0 globs muertos, las mismas
// exclusiones fijas y cada exclusión cubriendo los mismos archivos; lo único que la unión cambia ahí también está
// declarado (las dos rutas de la raíz de agent-skills que quedaron del lado del arnés).
// CÓMO FALLAN: igual que `diff` — 0 = igual salvo lo declarado · 1 = hallazgos, cada uno nombrado · 2 = no pude comparar
// (una copia que no es un repo, un rango que git no conoce, una lista que no se deja leer). Nunca 0 sin haber mirado.
const IGNORE = '.gitignore';
const IGNORE_BLOCK_LINE = '.advisors/';
const CODEX_FOLDERS = Object.freeze(['adapters/codex/agents', 'adapters/codex/agents-native']);
// Lo que la unión cambia en `--explain`: el .gitignore y el README.md de agent-skills ya no son entradas de su fuente (el
// .gitignore unido y el README que manda son los del arnés), y la exclusión de ese README se queda sin archivo.
// El .gitattributes (2026-10-04): los dos repos lo traen idéntico desde la 8.17, después del commit de la unión; en el
// repo unido es uno, del lado del arnés, y la exclusión de agent-skills que lo dejaba fuera queda sin archivo. Lo midió
// export-real T21 sobre main de los dos repos (story 8.18); que sean idénticos lo exige la prueba al componer la unión.
const UNION_FIRST_LEVEL_GONE = Object.freeze(['agent-skills/.gitignore', 'agent-skills/README.md', 'agent-skills/.gitattributes']);
const UNION_COVERAGE_EMPTIED = Object.freeze([
  { origen: 'afuera', fuente: 'agent-skills', glob: 'README.md' },
  { origen: 'afuera', fuente: 'agent-skills', glob: '.gitattributes' },
]);

/** git sobre una copia o sobre el repo unido: sin las variables que git le pasa a sus hooks (este guion puede correr
 *  desde uno), y con el motivo de git si falla. */
function gitClean(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, env: require('../lib/clean-git-env.js').sinGitDelPadre() });
  if (r.error || r.status !== 0) {
    throw new CouldNotCompare(`git ${args.slice(0, 3).join(' ')} en ${dir} falló: ${r.error ? r.error.message : String(r.stderr).trim() || `salió ${r.status}`}`);
  }
  return r.stdout;
}

/** Una copia: el identificador de su árbol, sus entradas de primer nivel y cada archivo con su modo y su hash. */
function readCopy(dir, label) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new CouldNotCompare(`la copia «${label}» no está en ${abs}`);
  // la copia es la raíz de SU repo: una carpeta cualquiera dentro de otro repo no es una copia
  const top = gitClean(abs, ['rev-parse', '--show-toplevel']).trim();
  if (fs.realpathSync(top) !== fs.realpathSync(abs)) throw new CouldNotCompare(`la copia «${label}» (${abs}) no es la raíz de un repo de git (la raíz es ${top})`);
  const tree = gitClean(abs, ['rev-parse', '--verify', 'HEAD^{tree}']).trim();
  const parse = (out) => out.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, obj] = line.slice(0, tab).split(' ');
    return { mode, type, obj, path: line.slice(tab + 1) };
  });
  const first = new Map(parse(gitClean(abs, ['ls-tree', '-z', 'HEAD'])).map((e) => [e.path, e]));
  const files = new Map(parse(gitClean(abs, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])).map((e) => [e.path, e]));
  return { dir: abs, label, tree, first, files, text: (p) => gitClean(abs, ['cat-file', 'blob', files.get(p).obj]) };
}

const ignoreLines = (t) => t.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === ''));
/** ¿El .gitignore de después es el de antes menos exactamente el bloque `.advisors/` (la línea y su comentario)? */
function ignoreBlock(beforeText, afterText) {
  const b = ignoreLines(beforeText);
  const a = ignoreLines(afterText);
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== IGNORE_BLOCK_LINE) continue;
    let j = i;
    while (j > 0 && b[j - 1].startsWith('#')) j--;
    const without = [...b.slice(0, j), ...b.slice(i + 1)];
    if (without.length === a.length && without.every((l, k) => l === a[k])) return { ok: true, lines: b.slice(j, i + 1) };
  }
  // no lo es: se dice qué líneas sobran o faltan (por texto; un .gitignore no repite líneas con sentido)
  const gone = b.filter((l) => !a.includes(l));
  const added = a.filter((l) => !b.includes(l));
  const show = (list) => list.slice(0, 8).map((l) => `«${l}»`).join(', ') + (list.length > 8 ? ` … y ${list.length - 8} más` : '');
  const why = [gone.length ? `faltan ${show(gone)}` : '', added.length ? `sobran ${show(added)}` : '', !gone.length && !added.length ? 'las mismas líneas, en otro orden o repetidas' : ''].filter(Boolean).join(' · ');
  return { ok: false, why };
}

/** Los archivos tocados en el interno: de `git diff --name-only <a>..<b>` (sin detección de renombres: un renombre es
 *  una baja y un alta, y las dos rutas cuentan) o de una lista hecha, una ruta por línea. */
function touchedFiles(a) {
  const touched = new Set();
  if (a.range !== undefined) {
    if (!/^[^.\s]+(?:\.[^.\s]+)*\.\.[^.\s]+(?:\.[^.\s]+)*$/.test(a.range)) throw new CouldNotCompare(`--range «${a.range}» no tiene la forma <unión>..<punta> (dos puntos, no tres: son los archivos que cambian entre los dos commits)`);
    const repo = path.resolve(a.repo || (process.env.TYCON_GUIDES_DIR && process.env.TYCON_GUIDES_DIR.trim()
      ? process.env.TYCON_GUIDES_DIR.trim().replace(/^~(?=$|[\\/])/, os.homedir()) : path.resolve(__dirname, '..', '..')));
    let out;
    try {
      const [from, to] = a.range.split('..');
      for (const ref of [from, to]) gitClean(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      out = gitClean(repo, ['diff', '--name-only', '--no-renames', '-z', from, to]);
    } catch (e) {
      throw new CouldNotCompare(`no pude leer qué tocó la story (--range ${a.range}, --repo ${repo}): ${e.message}`);
    }
    for (const p of out.split('\0')) if (p) touched.add(p);
  }
  if (a.touched !== undefined) {
    let text;
    try { text = fs.readFileSync(path.resolve(a.touched), 'utf8'); } catch (e) {
      throw new CouldNotCompare(`no pude leer la lista de archivos tocados ${a.touched} (${e.code || e.message})`);
    }
    for (const p of text.split(/\r?\n/)) if (p.trim()) touched.add(p.trim());
  }
  return touched;
}

/**
 * ¿El exportador publica esta ruta del repo unido? (story 8.18, pase adversarial del tramo 2, clase 9). Antes la imagen
 * de un archivo tocado era su misma ruta, se publicara o no: un archivo PRIVADO que la story tocó y que aparece en la
 * copia pasaba como «tocado a propósito» —la fuga que la medición del AC 21 tiene que ver—. Sale si, en algún paquete
 * público, un «in» de su fuente lo toma y no lo deja afuera ninguna de las reglas que no dependen del paquete pedido: las
 * exclusiones fijas, el «out» de todos los paquetes que lo toman, el «lista de excluidos» de la tabla privada (la que está al lado de
 * la lista blanca), `suitesOutside` y `casesOutside`. Las mismas reglas, con las mismas funciones, que `filterPackage` de
 * export.js; las que dependen del paquete pedido (los revisores de otro paquete, `packs/<otro>/`) no se aplican: la copia
 * puede ser de cualquiera. Una tabla privada que no se deja leer es «no pude mirar», nunca «no deja nada afuera».
 */
function shipsByExporter(list, listPath) {
  const exporter = require('./export.js');
  const { sourceOfPath } = require('./new-names.js');
  const tablePath = path.join(path.dirname(listPath), 'replacements.json');
  const table = readJson(tablePath, 'la tabla privada (de su «lista de excluidos» sale lo que no se publica)');
  if (!table || typeof table !== 'object' || Array.isArray(table) || (table.afuera !== undefined && !Array.isArray(table.afuera))) {
    throw new CouldNotCompare(`la tabla privada ${tablePath} no tiene la forma de siempre («lista de excluidos» es una lista)`);
  }
  const privateOut = (table.afuera || []).map((x, i) => {
    const slash = x && typeof x.glob === 'string' ? x.glob.indexOf('/') : -1;
    if (slash < 1) throw new CouldNotCompare(`la tabla privada ${tablePath}: el «lista de excluidos» #${i} no tiene un glob «<fuente>/<glob>»`);
    return { source: x.glob.slice(0, slash), glob: x.glob.slice(slash + 1) };
  });
  const named = typeof exporter.paquetesConNombresNuevos === 'function' ? exporter.paquetesConNombresNuevos(list) : list;
  const packages = Object.entries(named.packages || {}).filter(([name]) => !exporter.PAQUETES_PRIVADOS.includes(name)).map(([, def]) => def || {});
  const suitesOut = new Set((named.suitesOutside || []).filter((s) => s && s.path).map((s) => `${s.root}/${s.root === 'arnes' ? 'scripts' : 'skills'}/${s.path}`));
  const casesOut = new Set((named.casesOutside || []).filter((c) => c && c.path).map((c) => `arnes/${c.path}`));
  const fits = (glob, p) => exporter.coincide(glob, p);
  return (p) => {
    const source = sourceOfPath(p);
    // con el `salvo` de cada exclusión fija (story 8.26, tanda C): las mismas reglas que filterPackage
    if (exporter.EXCLUIDOS_SIEMPRE.some((x) => x.fuente === source && (exporter.cubreFija ? exporter.cubreFija(x, p) : fits(x.glob, p)))) return false;
    if (privateOut.some((x) => x.source === source && fits(x.glob, p))) return false;
    if (suitesOut.has(`${source}/${p}`) || casesOut.has(`${source}/${p}`)) return false;
    const taking = packages.map((d) => d[source] || {}).filter((d) => (d.in || []).some((g) => fits(g, p)));
    return taking.some((d) => !(d.out || []).some((x) => x && fits(x.glob, p)));
  };
}

/** La imagen, por el exportador, de los archivos tocados: ruta en la copia → archivo del interno que la explica. Sólo
 *  lo que el exportador publica (`ships`) tiene imagen por su ruta, por su renombre o por su traducción a Codex; un
 *  papel (`synthetic`) la tiene por su `from`, que no viaja pero que el exportador pone en el destino. */
function imageOf(touched, list, ships) {
  if (typeof ships !== 'function') throw new CouldNotCompare('imageOf necesita saber qué publica el exportador');
  const image = new Map();
  const put = (copyPath, by) => { if (!image.has(copyPath)) image.set(copyPath, by); };
  const renames = (Array.isArray(list.skillRenames) ? list.skillRenames : []).filter((r) => r && typeof r.from === 'string' && typeof r.to === 'string' && r.from !== r.to);
  const synthetic = (Array.isArray(list.synthetic) ? list.synthetic : []).filter((s) => s && typeof s.from === 'string' && typeof s.target === 'string');
  for (const p of [...touched].sort(byText)) {
    for (const s of synthetic) if (s.from === p) put(s.target, p);
    if (!ships(p)) continue;
    put(p, p);
    for (const r of renames) if (p.startsWith(`${r.from}/`)) put(`${r.to}/${p.slice(r.from.length + 1)}`, p);
    const reviewer = /^agents\/([^/]+)\.md$/.exec(p);
    if (reviewer) for (const folder of CODEX_FOLDERS) put(`${folder}/${reviewer[1]}.toml`, p);
  }
  return image;
}

function parseTreesArgs(argv) {
  const a = { dirs: [] };
  const withValue = new Map([['--range', 'range'], ['--repo', 'repo'], ['--touched', 'touched'], ['--allowlist', 'allowlist']]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') { a.json = true; continue; }
    const k = withValue.get(argv[i]);
    if (k) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new CouldNotCompare(`${argv[i - 1]} necesita un valor`);
      a[k] = v;
    } else if (argv[i].startsWith('--')) throw new CouldNotCompare(`opción desconocida para trees: ${argv[i]}`);
    else a.dirs.push(argv[i]);
  }
  if (a.dirs.length !== 2) throw new CouldNotCompare(`trees necesita dos copias (la de antes y la de después)\n${usage()}`);
  if (a.repo !== undefined && a.range === undefined) throw new CouldNotCompare('--repo va con --range: es el repo donde se lee qué tocó la story');
  return a;
}

function compareTrees(a) {
  const before = readCopy(a.dirs[0], 'antes');
  const after = readCopy(a.dirs[1], 'después');
  const withTouched = a.range !== undefined || a.touched !== undefined;
  let image = new Map();
  let touched = new Set();
  if (withTouched) {
    touched = touchedFiles(a);
    const listPath = path.resolve(a.allowlist || path.join(__dirname, 'allowlist.json'));
    const list = readJson(listPath, 'la lista blanca (de ahí sale la imagen de lo tocado)');
    if (!list || typeof list !== 'object' || Array.isArray(list)) throw new CouldNotCompare(`la lista blanca ${listPath} no es un objeto`);
    image = imageOf(touched, list, shipsByExporter(list, listPath));
  }
  const entries = [...new Set([...before.first.keys(), ...after.first.keys()])].sort(byText);
  const idOf = (e) => (e ? e.obj : null);
  const sameEntry = (x, y) => Boolean(x && y && x.obj === y.obj && x.mode === y.mode && x.type === y.type);
  const firstLevel = entries.map((entry) => {
    const x = before.first.get(entry);
    const y = after.first.get(entry);
    return { entry, type: (x || y).type, before: idOf(x), after: idOf(y), same: sameEntry(x, y) };
  });
  const out = { trees: { before: before.tree, after: after.tree }, firstLevel, touched: withTouched ? touched.size : null, declared: [], explained: [], findings: [] };
  const different = [...new Set([...before.files.keys(), ...after.files.keys()])].sort(byText).filter((p) => !sameEntry(before.files.get(p), after.files.get(p)));
  for (const p of different) {
    const x = before.files.get(p);
    const y = after.files.get(p);
    const how = !x ? 'no estaba en el árbol de antes y ahora sale'
      : !y ? 'salía en el árbol de antes y ya no sale'
        : x.mode !== y.mode ? `cambió de modo (${x.mode} → ${y.mode})${x.obj !== y.obj ? ' y de contenido' : ''}`
          : 'tiene otro contenido';
    if (image.has(p)) { out.explained.push({ path: p, by: image.get(p), how }); continue; }
    if (p === IGNORE && x && y && x.mode === y.mode && x.type === 'blob' && y.type === 'blob') {
      const block = ignoreBlock(before.text(p), after.text(p));
      if (block.ok) {
        out.declared.push({ path: p, what: `pierde el bloque ${IGNORE_BLOCK_LINE} de agent-skills (su línea y su comentario) y nada más`, lines: block.lines });
      } else {
        out.findings.push({ kind: 'ignore-block', path: p, message: `${p}: no difiere exactamente en el bloque ${IGNORE_BLOCK_LINE} de agent-skills (la única diferencia declarada): ${block.why}` });
      }
      continue;
    }
    out.findings.push({ kind: 'unexplained', path: p,
      message: withTouched
        ? (touched.has(p)
          ? `${p}: ${how}, y la story lo tocó pero el exportador no lo publica (una exclusión, un «out» o el «afuera» privado): tocarlo no explica que aparezca en la copia`
          : `${p}: ${how}, y la story no lo tocó (no está entre los ${touched.size} archivos tocados ni es la imagen de ninguno por el exportador)`)
        : `${p}: ${how} — fuera del ${IGNORE}, el árbol tiene que ser el mismo (¿es un archivo que la story tocó a propósito? decilo con --range <unión>..<punta>)` });
  }
  return { result: out.findings.length ? 1 : 0, ...out };
}

function humanTrees(r) {
  const l = [];
  const short = (id) => (id ? id.slice(0, 12) : '(no está)');
  if (r.result === 0) {
    const except = [r.declared.length ? `${r.declared.length} diferencia(s) declarada(s)` : '', r.explained.length ? `${r.explained.length} archivo(s) que la story tocó` : ''].filter(Boolean).join(' y ');
    l.push(r.trees.before === r.trees.after ? `✅ el mismo árbol: ${r.trees.before}` : `✅ el mismo árbol, carpeta de primer nivel por carpeta de primer nivel, salvo ${except}`);
  } else {
    l.push(`🛑 no es el mismo árbol: ${r.findings.length} hallazgo(s)`, '');
    for (const f of r.findings) l.push(`  · ${f.message}`);
  }
  l.push('', `árbol de antes   ${r.trees.before}`, `árbol de después ${r.trees.after}`, '', 'primer nivel (antes → después):');
  for (const e of r.firstLevel) l.push(`  ${e.same ? '=' : '≠'} ${e.entry.padEnd(24)} ${short(e.before)}${e.same ? '' : ` → ${short(e.after)}`}`);
  if (r.declared.length) {
    l.push('', 'declarado:');
    for (const d of r.declared) l.push(`  ${d.path}: ${d.what}`, ...d.lines.map((x) => `      - ${x}`));
  }
  if (r.explained.length) {
    l.push('', `tocado a propósito por la story (${r.explained.length}):`);
    for (const e of r.explained) l.push(`  ${e.path}${e.by !== e.path ? ` ← ${e.by}` : ''}: ${e.how}`);
  }
  return `${l.join('\n')}\n`;
}

/** Una salida de `export.js --explain --json`, con las claves que esta comparación lee. */
function readExplain(file, label) {
  const e = readJson(path.resolve(file), `la salida de --explain «${label}»`);
  for (const k of ['primerNivel', 'sinClasificar', 'exclusionesFijas', 'coberturaExclusiones', 'exclusionesSinArchivo']) {
    if (!e || !Array.isArray(e[k])) throw new CouldNotCompare(`la salida de --explain «${label}» (${file}) no trae «${k}»: no es una salida de export.js --explain --json`);
  }
  return e;
}

function compareExclusions(beforeFile, afterFile) {
  const before = readExplain(beforeFile, 'antes');
  const after = readExplain(afterFile, 'después');
  const out = { declared: [], findings: [] };
  const add = (kind, message) => out.findings.push({ kind, message });
  // un «afuera» privado no muestra su glob (es privado): va por su posición
  const which = (x) => (x.origen === 'afuera-privado' ? `afuera privado #${x.indice}` : `${x.origen}${x.paquete ? ` ${x.paquete}` : ''} ${x.fuente} ${x.glob}`);
  const rowKey = (x) => `${x.origen}|${x.paquete || ''}|${x.fuente}|${x.glob !== undefined ? x.glob : `#${x.indice}`}`;

  for (const e of strings(after.sinClasificar)) add('unclassified', `${e}: entrada de primer nivel SIN CLASIFICAR en la salida de después`);
  for (const x of after.exclusionesSinArchivo) add('dead-glob', `la exclusión ${which(x)} no cubre ningún archivo en la salida de después — ¿se movió el archivo sin su glob?`);

  const fixedOf = (e) => new Map(e.exclusionesFijas.map((x) => [`${x.fuente}/${x.glob}`, canonical(x)]));
  const fb = fixedOf(before);
  const fa = fixedOf(after);
  const fixedDiff = [...new Set([...fb.keys(), ...fa.keys()])].sort(byText).filter((k) => fb.get(k) !== fa.get(k));
  if (fixedDiff.length) add('fixed-exclusions', `las exclusiones fijas no son las mismas: ${fixedDiff.map((k) => `${k} (${!fa.has(k) ? 'ya no está' : !fb.has(k) ? 'es nueva' : 'cambió'})`).join(', ')}`);

  const cb = new Map(before.coberturaExclusiones.map((x) => [rowKey(x), x]));
  const ca = new Map(after.coberturaExclusiones.map((x) => [rowKey(x), x]));
  for (const k of [...new Set([...cb.keys(), ...ca.keys()])].sort(byText)) {
    const x = cb.get(k);
    const y = ca.get(k);
    if (!x || !y) { add('coverage', `la exclusión ${which(x || y)} ${x ? 'ya no figura en la salida de después' : 'es nueva en la salida de después'}`); continue; }
    if (x.archivos === y.archivos && Boolean(x.relevante) === Boolean(y.relevante)) continue;
    const emptied = UNION_COVERAGE_EMPTIED.some((d) => d.origen === x.origen && d.fuente === x.fuente && d.glob === x.glob);
    if (emptied && y.archivos === 0 && !y.relevante && !x.relevante) {
      out.declared.push({ what: `coverage ${which(x)}: ${x.archivos} → 0`, why: 'ese archivo de agent-skills no entró a la unión: manda el del arnés' });
      continue;
    }
    add('coverage', `la exclusión ${which(x)} cubría ${x.archivos} archivo(s) y ahora ${y.archivos}${Boolean(x.relevante) !== Boolean(y.relevante) ? ` (y ${y.relevante ? 'ahora' : 'ya no'} cae bajo un «in»)` : ''}: lo excluido no es lo mismo`);
  }

  // el primer nivel: las mismas entradas con las mismas reglas (una regla «afuera privado» no muestra su glob: va su tipo)
  const rules = (r) => canonical((r.reglas || []).map((x) => (x.tipo === 'afuera privado' ? { tipo: x.tipo } : x)));
  const levelOf = (e) => new Map(e.primerNivel.map((r) => [`${r.fuente}/${r.entrada}`, rules(r)]));
  const lb = levelOf(before);
  const la = levelOf(after);
  for (const k of [...new Set([...lb.keys(), ...la.keys()])].sort(byText)) {
    if (lb.get(k) === la.get(k)) continue;
    if (!la.has(k) && UNION_FIRST_LEVEL_GONE.includes(k)) {
      out.declared.push({ what: `first-level ${k}`, why: 'una de las rutas que los dos repos traían: en el repo unido es un solo archivo, del lado del arnés' });
      continue;
    }
    add('first-level', `${k}: ${!la.has(k) ? 'estaba en el primer nivel de antes y ya no' : !lb.has(k) ? 'es una entrada nueva del primer nivel' : 'la clasifican otras reglas que antes'}`);
  }
  return { result: out.findings.length ? 1 : 0, ...out };
}

function humanExclusions(r) {
  const l = [];
  if (r.result === 0) l.push(`✅ la misma lista de excluidos: 0 sin clasificar, 0 globs muertos, las mismas exclusiones fijas y cada exclusión con los mismos archivos${r.declared.length ? ` (salvo ${r.declared.length} cambio(s) declarado(s) de la unión)` : ''}`);
  else {
    l.push(`🛑 la lista de excluidos no es la misma: ${r.findings.length} hallazgo(s)`, '');
    for (const f of r.findings) l.push(`  · ${f.message}`);
  }
  if (r.declared.length) {
    l.push('', 'declarado:');
    for (const d of r.declared) l.push(`  ${d.what} — ${d.why}`);
  }
  return `${l.join('\n')}\n`;
}

function usage() {
  return 'uso: export-compare.js snapshot --out <carpeta-nueva> [--harness <ref>] [--agent-skills <ref>] [--exporter <export.js>] [--packages core,bizuit] [--work <dir>]\n'
    + '     export-compare.js diff <foto-antes> <foto-después> [--json]\n'
    + '     export-compare.js trees <copia-antes> <copia-después> [--range <unión>..<punta> [--repo <dir>]] [--touched <lista>] [--allowlist <f>] [--json]\n'
    + '     export-compare.js exclusions <explain-antes.json> <explain-después.json> [--json]\n';
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'snapshot') {
    try {
      return snapshot(rest);
    } catch (e) {
      process.stderr.write(`⛔ export-compare: no pude sacar la foto — ${e instanceof CouldNotCompare ? e.message : (e && e.stack) || e}\n`);
      return 2;
    }
  }
  if (cmd === 'diff') {
    const json = rest.includes('--json');
    const dirs = rest.filter((x) => x !== '--json');
    try {
      if (dirs.length !== 2 || dirs.some((d) => d.startsWith('--'))) throw new CouldNotCompare(`diff necesita dos fotos (antes y después)\n${usage()}`);
      const r = compare(dirs[0], dirs[1]);
      process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : human(r));
      return r.result;
    } catch (e) {
      const reason = e instanceof CouldNotCompare ? e.message : (e && e.stack) || String(e);
      if (json) process.stdout.write(`${JSON.stringify({ result: 2, reason }, null, 2)}\n`);
      process.stderr.write(`⛔ export-compare: no pude comparar — ${reason}\n`);
      return 2;
    }
  }
  if (cmd === 'trees' || cmd === 'exclusions') {
    const json = rest.includes('--json');
    try {
      let r;
      if (cmd === 'trees') r = compareTrees(parseTreesArgs(rest));
      else {
        const files = rest.filter((x) => x !== '--json');
        if (files.length !== 2 || files.some((f) => f.startsWith('--'))) throw new CouldNotCompare(`exclusions necesita dos salidas de --explain --json (la de antes y la de después)\n${usage()}`);
        r = compareExclusions(files[0], files[1]);
      }
      process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : (cmd === 'trees' ? humanTrees(r) : humanExclusions(r)));
      return r.result;
    } catch (e) {
      const reason = e instanceof CouldNotCompare ? e.message : (e && e.stack) || String(e);
      if (json) process.stdout.write(`${JSON.stringify({ result: 2, reason }, null, 2)}\n`);
      process.stderr.write(`⛔ export-compare: no pude comparar — ${reason}\n`);
      return 2;
    }
  }
  process.stderr.write(`⛔ export-compare: falta el subcomando\n${usage()}`);
  return 2;
}

module.exports = { compare, snapshot, CouldNotCompare, compareTrees, compareExclusions, imageOf, ignoreBlock, shipsByExporter };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
