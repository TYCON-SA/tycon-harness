#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * retro-heartbeat.js — el latido de la retrospectiva: un archivo por merge a main, en un segundo y sin
 * modelo.
 *
 * POR QUÉ EXISTE. Lanzar el `tycon-retrospective-capturer` en el paso 10b de /tycon-merge-to-main por
 * cada merge sale caro. Medido en 30 días: 87 lanzamientos, 4,9 min y 135 k tokens de
 * mediana — 8,3 h y 12,5 M tokens — para archivos que salen casi todo en null (un fix de 18 líneas
 * en un test produce 5 de 8 métricas vacías). De las seis métricas del contrato, cuatro ya las
 * publican otras piezas, y aguas abajo el archivo tiene DOS consumidores: `first_pass_ratio` del
 * nocturno SDLC (lee las vueltas) y `retro-pending.js` (el archivo es lo que da el merge por
 * cubierto). Este script alimenta a los dos y a nadie más. El agente queda a pedido.
 *
 * QUÉ ESCRIBE. `<out>/metrics-<fecha>-<repo>-<story|adhoc>-<sha7>.json`, formato 2.0 validado por
 * scripts/lib/dashboard-metrics.js ANTES de escribir:
 *   · identidad: repo (absoluto), merge_commit (completo), project, captured_at, story, run_dir;
 *   · advisor_rerun_loop_iterations = la ÚLTIMA vuelta de revisores de la corrida de esa story;
 *   · las otras cinco en null, cada una con quién la cubre;
 *   · `rethink_notes`: las notas de «repensar el enfoque» de la corrida (`marker.js rethink`), si las hay; sin notas el
 *     campo no aparece. Se validan con lib/rethink.js (la misma regla de la nota) y se sanean; las que están y no cumplen
 *     los mínimos van en `rethink_notes_rotas` (no cuentan como nota) y se avisan.
 *
 * 🔴 DE DÓNDE SALEN LAS VUELTAS. Se podría suponer
 * «una sola cuenta», la de la vista de corridas. Hay tres y no coinciden: la columna de la
 * vista (`costo.iteraciones`, eventos step5-start) acierta 17 de 43 contra los revisores medidos por
 * vuelta; la cantidad de fotos, 37; la foto más alta, 39. Orden: la clave numérica ≥ 1 más alta de
 * `revisores.por_vuelta` (la vuelta de cada lanzamiento según el registro) y, si no hay,
 * la de `marker.iterations`. Sin ninguna: null con motivo. NUNCA 0 (la métrica es `count1`, y un 0
 * pintado donde no hubo insumo es exactamente lo que `null ≠ 0` prohíbe).
 *
 * 🔴 QUÉ VOLCADO ES «DE ESTE REPO+STORY». En ~/.claude/.tycon-pipeline/timing-history/ sólo se abren
 * los archivos de esa story. Coincide si `marker.storyId` es la story y el repo es el mismo por ruta
 * real, o es un CLON DESCARTABLE: 15 de las 28 corridas del arnés corren en
 * `/private/tmp/claude-501/-Users-…-<repo>/…/scratchpad/tcg-<story>`, con el checkout
 * codificado como carpeta de sesión. Y para el clon se exige además que su story exista en el repo
 * en el commit del merge: una sesión del arnés también arma proyectos de prueba con el mismo número
 * de story (medido: scratchpad/dorada/claude). Si el volcado más nuevo de la story es
 * ILEGIBLE y más nuevo que la coincidencia, la métrica sale null: no se salta para tomar uno viejo.
 * Límite declarado: un ilegible no se puede atribuir a un repo, así que uno
 * de OTRO repo con el mismo número de story también la deja en null. Null con motivo, nunca un número
 * falso; medido: 0 volcados ilegibles en 313.
 *
 * 🔴 NADA DEL VOLCADO VIAJA salvo números de vuelta y la fecha de archivado: el volcado trae rutas
 * absolutas (`filesSnapshot`), el prompt del dev y mensajes de error; este archivo va a git.
 * No lee `findings.json`, `gates.log` ni `hook-errors.log` (este último ni existe: el capturer
 * «mide» fallas leyéndolo en 110 de 118 archivos).
 *
 * Uso:
 *   node scripts/metrics/retro-heartbeat.js --repo <dir> --merge <sha> [--story <id>] [--out <dir>]
 *   stdout: la ruta escrita · exit 0
 *   exit 2 + motivo por stderr: --repo no es git · --merge no resuelve · validate() rechaza · no escribió
 * Default de --out: la carpeta de estado de la máquina (`<stateDir>/dashboard`, la dice scripts/lib/night-data.js; ahí
 * lo busca retro-pending.js). Nunca el `.dashboard/` de un clon. De ahí lo sube upload-runs.js al buzón, y el nocturno
 * del tablero lo junta en `.dashboard/merges/` de operaciones. Sin llave del buzón, lo dice por stderr («no viaja»).
 * Ambiente: TYCON_TODAY (fecha, para pruebas) · TYCON_RETRO_HEARTBEAT_FORCE_ROUNDS (valor crudo de la
 * métrica de vueltas antes de validar — sólo para probar que el validador frena).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { execFileSync } = require('child_process');
const { SCHEMA_VERSION, validate } = require(path.join(__dirname, '..', 'lib', 'dashboard-metrics.js'));
const { nombreDeRepo, esRepoDelArnes } = require(path.join(__dirname, '..', 'lib', 'harness-repo.js'));
const { readEnv } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
const WHERE = 'scripts/metrics/retro-heartbeat.js';

const ARNES = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(stateDirOf(os.homedir()));
const HISTORIAL = path.join(STATE_DIR, 'timing-history');
const VUELTAS = 'advisor_rerun_loop_iterations';

// Quién cubre cada una de las otras cinco. Tres las publica otra pieza; las dos últimas no las
// publica nadie como serie y se dice qué las cubre (un freno) o que son a pedido.
const CUBIERTAS = {
  advisor_warnings_per_story:
    'la publica collect-findings.js (story 2.9): hallazgos.jsonl, por regla y gravedad, en todas las máquinas',
  advisor_warnings_actioned_ratio:
    'la disposición de cada hallazgo la publica collect-findings.js (story 2.9) en hallazgos.jsonl',
  advisor_pipeline_runtime_failures:
    'los revisores que no volvieron los publica reviewers-cost.js (story 2.15) en el volcado de la ejecución',
  step_8_commit_skipped_rerun:
    'no es una serie: lo impide el portón del pipeline (marker.js complete-step 5 y 8 exigen los revisores de la iteración)',
  advisor_findings_on_verification_artifacts:
    'no la publica ninguna pieza (el recolector de la 2.9 no guarda el archivo del hallazgo, a propósito): a pedido, con el tycon-retrospective-capturer',
};

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo' || k === '--merge' || k === '--story' || k === '--out') a[k.slice(2)] = argv[++i];
  }
  return a;
}

function git(cwd, argv) {
  try {
    return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch { return null; }
}

function real(p) {
  try { return fs.realpathSync.native(p); } catch { /* ya no existe (un clon borrado): se compara como está */ }
  return path.resolve(String(p));
}

// macOS y Windows no distinguen mayúsculas en el disco: la misma carpeta puede llegar escrita con otra caja
// (`git rev-parse` devuelve la caja real; un volcado puede traer otra).
const SIN_CAJA = process.platform === 'darwin' || process.platform === 'win32';
function caja(p) { return SIN_CAJA ? String(p).toLowerCase() : String(p); }

// Convención de worktrees del arnés (guides/git-worktrees.md), la misma que normaliza retro-pending.js: una
// corrida en <Repo>--wt-<slug> y un merge desde <Repo>--merge son del mismo repo.
const SUFIJO_WORKTREE = /--(merge|wt-[^\\/]*)$/;
function identidadDeRuta(p) {
  const r = real(p).replace(/[\\/]+$/, '');
  const base = path.basename(r).replace(SUFIJO_WORKTREE, '');
  return caja(base ? path.join(path.dirname(r), base) : r);
}

function fechaLocal() {
  const pedida = readEnv('TYCON_TODAY', { where: WHERE });
  if (/^\d{4}-\d{2}-\d{2}$/.test(pedida || '')) return pedida;
  const d = new Date();
  const dos = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}

// El nombre canónico del proyecto es el de engram si el repo lo declara; si no, la carpeta.
function proyectoDe(repo) {
  try {
    const n = fs.readFileSync(path.join(repo, '.engram-project'), 'utf8').trim();
    if (n) return n;
  } catch { /* sin declaración */ }
  return path.basename(repo);
}

function slug(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '-'); }

// El mismo saneo que usa marker.js para nombrar el volcado.
function storySegura(id) { return String(id).replace(/[^\w.-]/g, '_'); }

// Carpeta de sesión de Claude Code: la ruta con todo lo que no es letra o número cambiado por «-».
function codificada(p) { return String(p).replace(/[^A-Za-z0-9]/g, '-'); }

function contieneCodificada(ruta, otra) {
  return caja(ruta).includes(`/${caja(codificada(otra))}/`);
}

function runDirDe(repo, story) {
  if (!story) return null;
  const base = path.join(repo, '.advisors', 'pipeline-runs');
  let dirs = [];
  try {
    // Con un número que se repite en el repo, la carpeta se llama `<tema>__<número>-<sello>`. Acá sólo
    // se conoce el número: se aceptan las dos formas, para no quedar ciegos a las nuevas. Es un puntero de la retro,
    // no un freno: con número repetido sigue siendo ambiguo.
    dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name.startsWith(`${story}-`) || d.name.includes(`__${story}-`))).map((d) => d.name).sort();
  } catch { return null; }
  return dirs.length ? `.advisors/pipeline-runs/${dirs[dirs.length - 1]}/` : null;
}

// ¿La story del volcado existe en el repo en el commit del merge? Sólo se puede preguntar si la ruta
// de la story es relativa al repo del volcado (así la guarda el marcador) o cuelga de él.
function storyEnElMerge(repo, merge, marker) {
  const sp = String(marker.storyPath || '');
  const rp = String(marker.repoPath || '').replace(/\/+$/, '');
  let rel = null;
  if (sp && !path.isAbsolute(sp)) rel = sp;
  else if (sp && rp && sp.startsWith(`${rp}/`)) rel = sp.slice(rp.length + 1);
  if (!rel) return false;
  return git(repo, ['cat-file', '-e', `${merge}:${rel}`]) !== null;
}

function esDeEsteRepo(repo, repoReal, merge, marker) {
  const rp = String(marker.repoPath || '');
  // Una ruta RELATIVA ('.', 'mcp', 'Backend': volcados viejos, anteriores a que marker.js la guardara
  // absoluta) no dice de qué repo es: resolverla contra la carpeta desde donde corre el latido tomaría las
  // vueltas de otro proyecto desde adentro del repo y daría null desde afuera. No coincide con nada.
  if (!rp || !path.isAbsolute(rp)) return false;
  if (identidadDeRuta(rp) === identidadDeRuta(repo)) return true;
  const rpReal = real(rp);
  const clon = contieneCodificada(rp, repo) || contieneCodificada(rp, repoReal)
    || contieneCodificada(repo, rp) || contieneCodificada(repoReal, rp)
    || contieneCodificada(repoReal, rpReal);
  return clon && storyEnElMerge(repo, merge, marker);
}

// AAAAMMDDHHMM: la misma clave para `archivedAt` (ISO) y para el sello del nombre del archivo.
function claveDeFecha(texto) {
  const dig = String(texto || '').replace(/\D/g, '');
  return dig.length >= 12 ? dig.slice(0, 12) : null;
}

function ultimaVuelta(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { max: null, vueltas: [] };
  const vueltas = Object.keys(obj).filter((k) => /^\d+$/.test(k)).map(Number).filter((n) => n >= 1).sort((a, b) => a - b);
  return { max: vueltas.length ? vueltas[vueltas.length - 1] : null, vueltas };
}

function nulo(motivo) { return { value: null, unavailable_reason: motivo }; }

// 🔴 La fila del punto ciego no queda ciega. La métrica
// `deep_review_skipped_then_hotfixed` mide «cambios que saltearon la revisión profunda y después hubo
// que arreglar», y sus dos señales presuponen una STORY (una hija con `followup_of:`, o un commit que
// re-toca su File List). Un cambio que entra SIN story no encaja en ninguna, así que la fila imprimiría
// `0` — y un ejemplo es exactamente ése: 93 líneas operativas a main sin story, sin pipeline
// y sin tests, incidente diez días después, fila en 0. Medido sobre la serie: 46 de 52 archivos
// publican 0, tres de ellos diciendo en su propio detalle que la pregunta no aplicaba.
//
// Acá NO se inventa la correlación —«y después hubo que arreglarlo» necesita una observación posterior,
// que es del nocturno—: `value` queda en null con su motivo. Lo que sí se publica es la SEÑAL CRUDA que
// ninguna otra pieza publica: de los commits del merge, cuántos entraron FUERA del pipeline y cuántos no
// declaran carril. El insumo ya existe y es durable: el hook `unpushed-work-notice.js` anota por commit
// {sha, carril} en su registro de sesión.
// 🔴 Límite declarado: ese registro es LOCAL a la máquina que commiteó. Un commit
// de otra máquina, o anterior al registro, sale en `commits_sin_carril` — que es el contador honesto de
// «no lo sé», no un cero.
function senialDeCarril({ repo, merge }) {
  const rango = git(repo, ['rev-list', '--no-merges', `${merge}^..${merge}`])
    || git(repo, ['rev-list', '--no-merges', '-n', '50', merge]);
  const shas = (rango || '').split('\n').filter(Boolean);
  if (!shas.length) return null;
  const porSha = new Map();
  let ledgers = [];
  try { ledgers = fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('unpushed-commits-') && f.endsWith('.jsonl')); }
  catch { ledgers = []; }
  for (const f of ledgers) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(STATE_DIR, f), 'utf8'); } catch { continue; }
    for (const linea of txt.split('\n')) {
      if (!linea.trim()) continue;
      let e; try { e = JSON.parse(linea); } catch { continue; }
      if (e && e.kind === 'commit' && e.sha && e.carril) porSha.set(e.sha, e.carril);
    }
  }
  let fuera = 0; let sinCarril = 0;
  for (const sha of shas) {
    const c = porSha.get(sha);
    if (!c) { sinCarril += 1; continue; }
    if (c !== 'pipeline') fuera += 1;
  }
  // 🔴 En los repos DEL ARNÉS el registro de carril no existe a propósito: `unpushed-work-notice.js`
  // los excluye (`underHarness`). O sea que justo donde pasó el caso que motivó esta fila —93 líneas a
  // main sin story, en este repo— la señal no puede ver nada. Se dice, no se disimula con un cero.
  let delArnes = false;
  try { delArnes = !!esRepoDelArnes(repo); } catch { delArnes = false; }
  return { commits: shas.length, commits_fuera_del_pipeline: fuera, commits_sin_carril: sinCarril, delArnes };
}

function metricaDeVueltas({ repo, repoReal, merge, story }) {
  if (!story) return nulo('push sin story (sin --story): no hubo ejecución del pipeline de la que contar vueltas');
  const prefijo = `${storySegura(story)}-`;
  let archivos = [];
  try { archivos = fs.readdirSync(HISTORIAL).filter((f) => f.startsWith(prefijo) && f.endsWith('.json')); }
  catch { return nulo(`sin volcado de ejecución para este repo+story (no hay ${HISTORIAL.replace(os.homedir(), '~')})`); }

  let elegido = null;
  let ilegibleMasNuevo = null;
  for (const f of archivos) {
    // El resto del nombre TIENE que ser la fecha del archivado (AAAA-MM-DDTHHMM…, como la escribe
    // marker.js). Si no lo es, el archivo es de OTRA story cuyo id extiende a éste con un guion (real:
    // 1.3 y 1.3-B-frontend) y no se mira: si estuviera ilegible, su «sello» no-fecha ordenaría después de
    // cualquier fecha y anularía la métrica de la story buscada.
    const resto = f.slice(prefijo.length, -'.json'.length);
    if (!/^\d{4}-\d{2}-\d{2}T\d{4}/.test(resto)) continue;
    const sello = claveDeFecha(resto);
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(HISTORIAL, f), 'utf8')); }
    catch {
      if (!ilegibleMasNuevo || sello > ilegibleMasNuevo) ilegibleMasNuevo = sello;
      continue;
    }
    const m = d && d.marker;
    if (!m || String(m.storyId) !== String(story)) continue;
    if (!esDeEsteRepo(repo, repoReal, merge, m)) continue;
    const cuando = String(d.archivedAt || '');
    // Una sola forma de clave para los dos casos (SILENT-W8 de la revisión): con archivedAt y sin él se
    // compararían `20260916100000` contra `2026-09-16T0900`, y el que no trae la fecha perdería siempre.
    const clave = claveDeFecha(cuando) || sello;
    if (!elegido || clave > elegido.clave) elegido = { clave, d, cuando };
  }

  if (ilegibleMasNuevo && (!elegido || ilegibleMasNuevo > elegido.clave)) {
    return nulo('volcado ilegible: el más nuevo de esta story no se pudo leer, y no se toma uno más viejo en su lugar');
  }
  if (!elegido) return nulo('sin volcado de ejecución para este repo+story');

  const desde = elegido.cuando ? ` — ejecución archivada el ${elegido.cuando.slice(0, 16)}Z` : '';
  const v = vueltaDeVolcado(elegido.d);
  if (!v) return nulo('el volcado no registra vueltas: sin revisores por vuelta ni fotos de iteración');
  const como = v.fuente === 'revisores.por_vuelta'
    ? `según los revisores por vuelta (vueltas ${v.vueltas.join(', ')})`
    : `según las fotos de iteración, marker.iterations (vueltas ${v.vueltas.join(', ')}; sin revisores por vuelta)`;
  return { value: v.value, fuente: v.fuente, vueltas: v.vueltas, detail: `última vuelta ${v.value} ${como}${desde}` };
}

// LA cuenta de vueltas de una corrida, sobre su volcado ya leído: la clave numérica ≥ 1 más alta de
// `revisores.por_vuelta` (la vuelta de cada lanzamiento según el registro) y, si no hay,
// la de `marker.iterations` (las fotos). Null si no registra ninguna. La usan este script y la vista
// de corridas (scripts/nightly/dashboard/runs.js): una sola función, para que las dos páginas digan lo mismo.
// Nota: `costo.iteraciones` del volcado NO son vueltas — cuenta las veces que se calculó el set de
// revisores (eventos step5-start): acertó 17 de 43 contra los revisores medidos.
function vueltaDeVolcado(d) {
  if (!d || typeof d !== 'object') return null;
  const porVuelta = ultimaVuelta(d.revisores && d.revisores.por_vuelta);
  if (porVuelta.max !== null) return { value: porVuelta.max, fuente: 'revisores.por_vuelta', vueltas: porVuelta.vueltas };
  const fotos = ultimaVuelta(d.marker && d.marker.iterations);
  if (fotos.max !== null) return { value: fotos.max, fuente: 'marker.iterations', vueltas: fotos.vueltas };
  return null;
}

// La regla de la nota (los mínimos, qué es válida) vive en lib/rethink.js del pipeline: se usa ESA, no una copia. Se busca
// al lado del arnés y en las skills instaladas; si no aparece, las notas no se aceptan «tal cual» (ACCOV-C3): se dice.
function cargarRethink() {
  const candidatos = [
    path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'rethink.js'),
    path.join(os.homedir(), '.claude', 'agent-skills', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'rethink.js'),
  ];
  for (const c of candidatos) {
    try { if (fs.existsSync(c)) return require(c); } catch { /* siguiente */ }
  }
  return null;
}

// La carpeta de la corrida de ESTA story, por la clave exacta: `<clave>-<14 dígitos>` (o `<tema>__<clave>-<14 dígitos>`).
// Un prefijo no alcanza (`9.9-` también abre `9.9-1-…`). Entre varias, gana la que tiene archivos y luego la más reciente,
// como `resolveRunDir` del pipeline: una carpeta vacía más nueva no tapa a la corrida real.
function carpetaExactaDeNotas(repo, story) {
  if (!story) return null;
  const base = path.join(repo, '.advisors', 'pipeline-runs');
  const re = new RegExp(`^(?:.+__)?${String(story).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{14}$`);
  let nombres = [];
  try { nombres = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && re.test(d.name)).map((d) => d.name); } catch { return null; }
  let mejor = null; let tiene = -1; let reciente = -1;
  for (const n of nombres) {
    let has = 0; let newest = 0;
    try {
      for (const f of fs.readdirSync(path.join(base, n))) {
        has = 1;
        try { newest = Math.max(newest, fs.statSync(path.join(base, n, f)).mtimeMs); } catch { /* sigue */ }
      }
    } catch { /* sigue */ }
    if (!has) { try { newest = fs.statSync(path.join(base, n)).mtimeMs; } catch { newest = 0; } }
    if (has > tiene || (has === tiene && newest > reciente)) { tiene = has; reciente = newest; mejor = n; }
  }
  return mejor ? `.advisors/pipeline-runs/${mejor}/` : null;
}

// Las notas de «repensar el enfoque» que la corrida guardó (`<corrida>/rethink/iter-N.json`, las escribe
// `marker.js rethink`): una story con notas no convergió en tres vueltas. Sin notas devuelve null y el campo no aparece:
// un 0 pintado donde no hubo notas diría «miré y no hay». Una nota que está y no cumple los mínimos de lib/rethink.js
// (ilegible, o de menos de 40 caracteres por campo) NO cuenta como nota: va aparte, en `rotas`, para que se diga.
// Los textos pasan por `sanear` de tokens-digest.js: el archivo de la retro viaja por git.
function notasDeRepensar(repo, runDirAprox, story) {
  // 🔴 sale rojo si la retro lee las notas de otra corrida u otra story de prefijo parecido, o de una carpeta vacía más
  // nueva que la corrida real: la carpeta se busca por la clave EXACTA de la story (y su sello), igual que el pipeline.
  const runDir = carpetaExactaDeNotas(repo, story) || runDirAprox;
  if (!runDir) return null;
  const rt = cargarRethink();
  const dir = path.join(repo, runDir, 'rethink');
  let nombres = [];
  try { nombres = fs.readdirSync(dir); } catch { return null; }
  if (!rt) {
    const hay = nombres.filter((n) => /^iter-\d+\.json$/.test(n)).map((n) => Number(/\d+/.exec(n)[0])).sort((x, y) => x - y);
    return hay.length ? { notas: [], rotas: hay.map((iter) => ({ iter, reason: 'no se encontró lib/rethink.js para validarla' })) } : null;
  }
  const { notes, broken } = rt.readAll(path.join(repo, runDir));
  if (!notes.length && !broken.length) return null;
  const notas = notes.map((n0) => {
    const n = rt.sanearNota(n0);
    return {
      iter: n.iter,
      ...(n.at ? { at: n.at } : {}),
      repeated: n.repeated,
      ...(n.change ? { change: n.change } : {}),
      ...(n.keep ? { keep: n.keep } : {}),
      ...(n.story_change ? { story_change: n.story_change } : {}),
    };
  });
  return { notas, rotas: broken.map((b) => ({ iter: b.iter, aviso: rt.brokenWarning(b) })) };
}

function salir(motivo) {
  process.stderr.write(`retro-latido: ${motivo}\n`);
  process.exit(2);
}

function main() {
  const a = args(process.argv.slice(2));
  if (!a.repo || !a.merge) salir('uso: retro-heartbeat.js --repo <dir> --merge <sha> [--story <id>] [--out <dir>]');

  const repoArg = path.resolve(a.repo);
  const repo = git(repoArg, ['rev-parse', '--show-toplevel']);
  if (!repo) salir(`--repo no es un repo git: ${repoArg}`);
  const merge = git(repo, ['rev-parse', '--verify', '--quiet', `${a.merge}^{commit}`]);
  if (!merge) salir(`--merge no resuelve a un commit en ${repo}: ${a.merge}`);
  const repoReal = real(repo);
  const story = a.story ? String(a.story) : null;
  const hoy = fechaLocal();

  const vueltas = metricaDeVueltas({ repo, repoReal, merge, story });
  const forzadas = readEnv('TYCON_RETRO_HEARTBEAT_FORCE_ROUNDS', { where: WHERE });
  if (forzadas !== undefined) {
    const crudo = forzadas;
    vueltas.value = /^-?\d+(\.\d+)?$/.test(crudo) ? Number(crudo) : crudo;
    delete vueltas.unavailable_reason;
  }
  const metrics = { [VUELTAS]: vueltas };
  for (const [k, motivo] of Object.entries(CUBIERTAS)) metrics[k] = nulo(motivo);

  // El punto ciego, con su señal cruda al lado (ver senialDeCarril): value null SIEMPRE — la
  // correlación la hace el nocturno — pero las partes dicen cuántos commits de este merge entraron
  // fuera del pipeline y cuántos no declaran carril.
  const carril = senialDeCarril({ repo, merge });
  metrics.deep_review_skipped_then_hotfixed = carril
    ? { value: null,
        unavailable_reason: `la correlación «saltearon la revisión y después hubo que arreglar» necesita una observación posterior (es del nocturno); acá va la señal cruda: ${carril.commits_fuera_del_pipeline} de ${carril.commits} commit(s) de este merge entraron fuera del pipeline y ${carril.commits_sin_carril} no declaran carril${carril.delArnes ? ' — y este es un repo DEL ARNÉS, donde el registro de carril no se escribe a propósito (unpushed-work-notice.js los excluye): ahí «sin carril» es lo esperado, no una medición' : ' (el registro por commit nace el 2026-09-16 y es local a la máquina que commiteó)'}`,
        commits_fuera_del_pipeline: carril.commits_fuera_del_pipeline,
        commits_sin_carril: carril.commits_sin_carril }
    : nulo('no pude listar los commits de este merge, así que no hay ni señal de carril ni correlación');

  const doc = {
    schema_version: SCHEMA_VERSION,
    project: proyectoDe(repo),
    captured_at: hoy,
    ts: new Date().toISOString(),
    repo,
    merge_commit: merge,
    story,
    run_dir: runDirDe(repo, story),
    // un campo del registro, no una ruta: no cambia con el renombre, así la serie de .dashboard/ sigue
    // siendo una sola. Se arma por partes para que no se lea como la ruta vieja del archivo.
    generated_by: ['retro', 'latido.js'].join('-'),
    metrics,
  };
  const repensar = notasDeRepensar(repo, doc.run_dir, story);
  if (repensar && repensar.notas.length) doc.rethink_notes = repensar.notas;
  if (repensar && repensar.rotas.length) {
    // 🔴 sale rojo si una nota rota se descarta sin avisar: queda dicho en el archivo y en la salida de error.
    doc.rethink_notes_rotas = repensar.rotas.map((r) => ({ iter: r.iter, aviso: r.aviso || `nota ilegible/incompleta de la vuelta ${r.iter}: ${r.reason}` }));
    for (const r of doc.rethink_notes_rotas) process.stderr.write(`retro-latido: ${r.aviso}\n`);
  }

  const v = validate(doc);
  if (!v.ok) salir(`el validador de dashboard-metrics.js rechazó el archivo, no se escribió nada: ${v.errors.join(' · ')}`);

  // Dónde escribe la máquina lo suyo lo sabe scripts/lib/night-data.js: su carpeta de estado, siempre. Desde ahí viaja
  // por el buzón; sin llave, se dice que no viaja. 🔴 Nunca el `.dashboard/` de un clon: ensucia ese checkout y nadie
  // lo sube. Sin esa biblioteca al lado, la carpeta de datos de la máquina o el `.dashboard` del arnés.
  // 🔴 Si la biblioteca ESTÁ y no carga, esto tira: volver callado a esa otra ruta sería escribir en un clon. Y si no
  // pudo saber dónde escribe la máquina, no se escribe nada y se dice (el merge queda sin su archivo, que es lo que
  // cobra retro-pending.js).
  const nightLib = path.join(__dirname, '..', 'lib', 'night-data.js');
  const machine = fs.existsSync(nightLib) ? require(nightLib).machineDashboard(ARNES) : null;
  if (!a.out && machine && !machine.dir) salir(`no se escribió nada: ${machine.why}`);
  const dashboardDefault = machine && machine.dir ? machine.dir : (() => { try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); return (typeof TH.dashboardDir === 'function' && TH.dashboardDir(os.homedir(), ARNES)) || null; } catch (_) { return null; } })();
  const out = path.resolve(a.out || dashboardDefault || path.join(ARNES, '.dashboard'));
  // El archivo se nombra por el REPO (lo que dice su remoto), no por la carpeta desde la que se corrió:
  // un latido lanzado desde un clon descartable saldría `metrics-…-tcg-adhoc-…`. Sin remoto
  // legible, la carpeta, como siempre. El campo `repo` NO cambia: es la ruta con la que retro-pending.js
  // empareja el merge con su archivo.
  const nombre = `metrics-${hoy}-${slug(nombreDeRepo(repo) || path.basename(repo))}-${story ? slug(story) : 'adhoc'}-${merge.slice(0, 7)}.json`;
  const destino = path.join(out, nombre);
  try {
    fs.mkdirSync(out, { recursive: true });
    const tmp = `${destino}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, destino);
  } catch (err) {
    salir(`no se pudo escribir ${destino}: ${err && err.message ? err.message : err}`);
  }
  // sin llave del buzón el archivo no viaja: se dice en cada corrida (por stderr; por stdout sale sólo la ruta, que
  // otros leen)
  if (!a.out && machine && machine.travels === false) process.stderr.write(`retro-latido: el registro quedó en esta máquina y no viaja por el buzón — ${machine.why}\n`);
  process.stdout.write(`${destino}\n`);
}

module.exports = { vueltaDeVolcado, ultimaVuelta, runDirDe };
if (require.main === module) main();
