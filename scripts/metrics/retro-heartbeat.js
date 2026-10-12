#!/usr/bin/env node
'use strict';
/**
 * retro-heartbeat.js — el latido de la retrospectiva: un archivo por merge a main, en un segundo y sin
 * modelo (story 7.1 del arnés, 2026-09-16).
 *
 * POR QUÉ EXISTE. El paso 10b de /tycon-merge-to-main lanzaba el `tycon-retrospective-capturer` por
 * cada merge. Medido en 30 días (2026-08-17 → 09-16): 87 lanzamientos, 4,9 min y 135 k tokens de
 * mediana — 8,3 h y 12,5 M tokens — para archivos que salían casi todo en null (un fix de 18 líneas
 * en un test produjo 5 de 8 métricas vacías). De las seis métricas del contrato, cuatro ya las
 * publican otras piezas, y aguas abajo el archivo tiene DOS consumidores: `first_pass_ratio` del
 * nocturno SDLC (lee las vueltas) y `retro-pending.js` (el archivo es lo que da el merge por
 * cubierto). Este script alimenta a los dos y a nadie más. El agente queda a pedido.
 * Informes: tasks/revision-adversaria-cierre-2026-09-16.md, tasks/abogado-del-diablo-7.1-2026-09-16.md.
 *
 * QUÉ ESCRIBE. `<out>/metrics-<fecha>-<repo>-<story|adhoc>-<sha7>.json`, formato 2.0 validado por
 * scripts/lib/dashboard-metrics.js ANTES de escribir:
 *   · identidad: repo (absoluto), merge_commit (completo), project, captured_at, story, run_dir;
 *   · advisor_rerun_loop_iterations = la ÚLTIMA vuelta de revisores de la corrida de esa story;
 *   · las otras cinco en null, cada una con quién la cubre.
 *
 * 🔴 DE DÓNDE SALEN LAS VUELTAS (salvaguarda de la story, decisión del dev 2026-09-16). La story
 * suponía «una sola cuenta», la de la vista de corridas. Hay tres y no coinciden: la columna de la
 * vista (`costo.iteraciones`, eventos step5-start) acertó 17 de 43 contra los revisores medidos por
 * vuelta; la cantidad de fotos, 37; la foto más alta, 39. Orden: la clave numérica ≥ 1 más alta de
 * `revisores.por_vuelta` (la vuelta de cada lanzamiento según el registro, story 2.15) y, si no hay,
 * la de `marker.iterations`. Sin ninguna: null con motivo. NUNCA 0 (la métrica es `count1`, y un 0
 * pintado donde no hubo insumo es exactamente lo que `null ≠ 0` prohíbe).
 *
 * 🔴 QUÉ VOLCADO ES «DE ESTE REPO+STORY». En ~/.claude/.tycon-pipeline/timing-history/ sólo se abren
 * los archivos de esa story. Coincide si `marker.storyId` es la story y el repo es el mismo por ruta
 * real, o es un CLON DESCARTABLE: 15 de las 28 corridas del arnés corrieron en
 * `/private/tmp/claude-501/-Users-…-<repo>/…/scratchpad/tcg-2.7`, con el checkout
 * codificado como carpeta de sesión. Y para el clon se exige además que su story exista en el repo
 * en el commit del merge: una sesión del arnés también arma proyectos de prueba con el mismo número
 * de story (medido: 7.1-2026-08-22, scratchpad/dorada/claude). Si el volcado más nuevo de la story es
 * ILEGIBLE y más nuevo que la coincidencia, la métrica sale null: no se salta para tomar uno viejo.
 * Límite declarado (decisión del dev, 2026-09-16): un ilegible no se puede atribuir a un repo, así que uno
 * de OTRO repo con el mismo número de story también la deja en null. Null con motivo, nunca un número
 * falso; medido ese día, 0 volcados ilegibles en 313.
 *
 * 🔴 NADA DEL VOLCADO VIAJA salvo números de vuelta y la fecha de archivado: el volcado trae rutas
 * absolutas (`filesSnapshot`), el prompt del dev y mensajes de error; este archivo va a git.
 * No lee `findings.json`, `gates.log` ni `hook-errors.log` (este último ni existe: el capturer
 * «midió» fallas leyéndolo en 110 de 118 archivos).
 *
 * Uso:
 *   node scripts/metrics/retro-heartbeat.js --repo <dir> --merge <sha> [--story <id>] [--out <dir>]
 *   stdout: la ruta escrita · exit 0
 *   exit 2 + motivo por stderr: --repo no es git · --merge no resuelve · validate() rechaza · no escribió
 * Default de --out: el .dashboard/ del arnés donde vive este script (donde lo busca retro-pending.js).
 * Ambiente: TYCON_TODAY (fecha, para pruebas) · TYCON_RETRO_HEARTBEAT_FORCE_ROUNDS (valor crudo de la
 * métrica de vueltas antes de validar — sólo para probar que el validador frena).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
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
    'los revisores que no volvieron los publica reviewers-cost.js (story 2.15) en el volcado de la corrida',
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
// (medido por el pase adversarial: `git rev-parse` devuelve la caja real; un volcado puede traer otra).
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
    // Con un número que se repite en el repo, la carpeta se llama `<tema>__<número>-<sello>` (story 1.17.1). Acá sólo
    // se conoce el número: se aceptan las dos formas, para no quedar ciegos a las nuevas. Es un puntero de la retro,
    // no un freno: con número repetido sigue siendo ambiguo, como antes.
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
  // Una ruta RELATIVA ('.', 'mcp', 'CeiboBackend': volcados viejos, anteriores a que marker.js la guardara
  // absoluta) no dice de qué repo es: resolverla contra la carpeta desde donde corre el latido tomaba las
  // vueltas de otro proyecto desde adentro del repo y daba null desde afuera. No coincide con nada.
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

// 🔴 La fila del punto ciego deja de ser ciega (2026-09-18, DEEP-REVIEW-SKIP-SIN-STORY-1). La métrica
// `deep_review_skipped_then_hotfixed` mide «cambios que saltearon la revisión profunda y después hubo
// que arreglar», y sus dos señales presuponen una STORY (una hija con `followup_of:`, o un commit que
// re-toca su File List). Un cambio que entra SIN story no encaja en ninguna, así que la fila imprimía
// `0` — y el caso documentado es exactamente ése: 93 líneas operativas a main sin story, sin pipeline
// y sin tests, incidente diez días después, fila en 0. Medido sobre la serie: 46 de 52 archivos
// publican 0, tres de ellos diciendo en su propio detalle que la pregunta no aplicaba.
//
// Acá NO se inventa la correlación —«y después hubo que arreglarlo» necesita una observación posterior,
// que es del nocturno—: `value` queda en null con su motivo. Lo que sí se publica es la SEÑAL CRUDA que
// hoy no tenía nadie: de los commits del merge, cuántos entraron FUERA del pipeline y cuántos no
// declaran carril. El insumo ya existe y es durable: el hook `unpushed-work-notice.js` anota por commit
// {sha, carril} en su registro de sesión desde la story 2.7.
// 🔴 Límite declarado: ese registro nace el 2026-09-16 y es LOCAL a la máquina que commiteó. Un commit
// de otra máquina, o anterior a esa fecha, sale en `commits_sin_carril` — que es el contador honesto de
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
  if (!story) return nulo('push sin story (sin --story): no hubo corrida del pipeline de la que contar vueltas');
  const prefijo = `${storySegura(story)}-`;
  let archivos = [];
  try { archivos = fs.readdirSync(HISTORIAL).filter((f) => f.startsWith(prefijo) && f.endsWith('.json')); }
  catch { return nulo(`sin volcado de corrida para este repo+story (no hay ${HISTORIAL.replace(os.homedir(), '~')})`); }

  let elegido = null;
  let ilegibleMasNuevo = null;
  for (const f of archivos) {
    // El resto del nombre TIENE que ser la fecha del archivado (AAAA-MM-DDTHHMM…, como la escribe
    // marker.js). Si no lo es, el archivo es de OTRA story cuyo id extiende a éste con un guion (real:
    // 1.3 y 1.3-B-frontend) y no se mira: si estuviera ilegible, su «sello» no-fecha ordenaba después de
    // cualquier fecha y anulaba la métrica de la story buscada.
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
    // comparaban `20260916100000` contra `2026-09-16T0900`, y el que no traía la fecha perdía siempre.
    const clave = claveDeFecha(cuando) || sello;
    if (!elegido || clave > elegido.clave) elegido = { clave, d, cuando };
  }

  if (ilegibleMasNuevo && (!elegido || ilegibleMasNuevo > elegido.clave)) {
    return nulo('volcado ilegible: el más nuevo de esta story no se pudo leer, y no se toma uno más viejo en su lugar');
  }
  if (!elegido) return nulo('sin volcado de corrida para este repo+story');

  const desde = elegido.cuando ? ` — corrida archivada el ${elegido.cuando.slice(0, 16)}Z` : '';
  const v = vueltaDeVolcado(elegido.d);
  if (!v) return nulo('el volcado no registra vueltas: sin revisores por vuelta ni fotos de iteración');
  const como = v.fuente === 'revisores.por_vuelta'
    ? `según los revisores por vuelta (vueltas ${v.vueltas.join(', ')})`
    : `según las fotos de iteración, marker.iterations (vueltas ${v.vueltas.join(', ')}; sin revisores por vuelta)`;
  return { value: v.value, fuente: v.fuente, vueltas: v.vueltas, detail: `última vuelta ${v.value} ${como}${desde}` };
}

// LA cuenta de vueltas de una corrida, sobre su volcado ya leído: la clave numérica ≥ 1 más alta de
// `revisores.por_vuelta` (la vuelta de cada lanzamiento según el registro, story 2.15) y, si no hay,
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
    // un campo del registro, no una ruta: no cambia con el renombre (story 8.9, AC 32), así la serie de .dashboard/ sigue
    // siendo una sola. Se arma por partes para que no se lea como la ruta vieja del archivo.
    generated_by: ['retro', 'latido.js'].join('-'),
    metrics,
  };

  const v = validate(doc);
  if (!v.ok) salir(`el validador de dashboard-metrics.js rechazó el archivo, no se escribió nada: ${v.errors.join(' · ')}`);

  // en una instalación bajada (story 8.23, tanda D) el .dashboard vive en ~/.tycon/state/dashboard; lo sabe tycon-home.js
  const dashboardDefault = (() => { try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); return (typeof TH.dashboardDir === 'function' && TH.dashboardDir(os.homedir(), ARNES)) || null; } catch (_) { return null; } })();
  const out = path.resolve(a.out || dashboardDefault || path.join(ARNES, '.dashboard'));
  // El archivo se nombra por el REPO (lo que dice su remoto), no por la carpeta desde la que se corrió
  // (2026-09-17): un latido lanzado desde un clon descartable salía `metrics-…-tcg-adhoc-…`. Sin remoto
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
  process.stdout.write(`${destino}\n`);
}

module.exports = { vueltaDeVolcado, ultimaVuelta, runDirDe };
if (require.main === module) main();
