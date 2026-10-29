#!/usr/bin/env node
'use strict';
/**
 * legacy-retire-check.js — ¿qué nombres viejos se pueden retirar hoy? Casos: scripts/tests/legacy-retire-check.test.js
 *
 * Mide, por cada entrada del mapa de renombres (scripts/lib/renames.json):
 *   (a) la fecha: hoy contra su `retire_after` (la propia de la entrada, o la del mapa);
 *   (b) el buzón: los usos que sube cada máquina (`<máquina>/registros/legacy-names.jsonl.gz`) en la ventana; las
 *       máquinas esperadas (`reducer.expected_machines` de sources.json) que no reportaron en la ventana van aparte;
 *   (c) las corridas: los avisos «nombre viejo» del timeline de cada corrida de la ventana, en todos los pipelines de
 *       los proyectos de Azure DevOps donde viven los repos de la lista de productos (product-parity.json, `ado`); un
 *       pipeline de un repo que no está en la lista y llama al arnés (tiene ese aviso) sale en `undeclared_pipelines`.
 *
 * El estado de cada entrada: `limpia` (ninguna fuente que respondió la vio usada), `con-uso` (y quién), `sin-medir`
 * (falló la consulta de un repo que la nombra, según `legacy-names.js --product-report` sobre su clon; sin clon, todas)
 * o `sin-fuente` (su tipo no lo anota nadie: nunca es limpia). Una máquina callada NO cambia el estado de ninguna
 * entrada: va en `machines_unreported`, así una máquina callada no atrasa el retiro de todos.
 *
 * La ventana: los últimos 14 días; para una entrada con `retire_after` propia, la semana antes de esa fecha, que es
 * una semana después del día en que se vio el uso.
 *
 * 🔴 Mira el código de salida de cada consulta (`az`, la bajada del buzón) antes de leer su salida: una que falla es
 * «no pude medir» de ese repo o del buzón, nunca «sin usos» (regla ADO 5).
 *
 * Uso: node scripts/tools/legacy-retire-check.js [--json] [--today AAAA-MM-DD] [--map <f>] [--sources <f>]
 *        [--mirror <dir>] [--no-download] [--parity <f>] [--repos-root <dir>] [--az <ejecutable>]
 * Salida: 2 si una consulta falló o una máquina esperada no reportó · si no, 1 si la fecha no llegó o alguna entrada no
 *         está limpia · si no, 0. El retiro parcial se arma con el `--json`, nunca con el código de salida.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LN = require(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'));
const { aliasDeNombre, leerUnionesDeCarpetas } = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'reducer.js'));

const WINDOW_DAYS = 14;
const OWN_WINDOW_DAYS = 7;
const RUNS_TOP = 200;
// el motivo con que la subida (scripts/metrics/upload-runs.js) dice que la máquina no tiene registro de usos
const NO_REGISTRY = 'el registro no existe en esta máquina';
// los tipos que `--product-report` no busca en el clon de un producto y que un pipeline puede usar: con la consulta del
// repo caída, quedan sin medir siempre
const UNREPORTED_CI_KINDS = new Set(['subcommand']);
// Los tipos que alguien anota cuando se usan: los guiones al leer (`readEnv`, `readKeys`, `aliasOptions`,
// `resolveFile`, `prepareStateWrite`), los reemplazos de las rutas viejas (`--log-use`) y los traductores de scripts/ci.
const SOURCE_KINDS = new Set(LN.KINDS);
// los que no se pudo medir el buzón: la bajada sale 0 igual («esta máquina no puede leer el buzón»)
const DOWNLOAD_UNREAD = new Set(['sin_az', 'sin_sesion', 'sin_permiso', 'sin_permiso_a_mitad']);
const WARNING = /nombre viejo «([^»]+)» \(([\w-]+)\)(?: en (\S+?):)?/;
// los tipos que viven en un guion o archivo (`where`): un uso cuenta sólo para la entrada de ese guion
const WHERE_KINDS = new Set(['option', 'value', 'subcommand', 'key']);

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function parseArgs(argv) {
  const a = { json: false, download: true };
  const need = (i, f) => { if (i >= argv.length) throw new Error(`${f} necesita un valor`); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--no-download') a.download = false;
    else if (['--today', '--map', '--sources', '--mirror', '--parity', '--repos-root', '--az'].includes(x)) a[x.slice(2).replace('-r', 'R')] = need(++i, x);
    else throw new Error(`opción desconocida: ${x}`);
  }
  if (a.today !== undefined && !isDay(a.today)) throw new Error(`--today tiene que ser AAAA-MM-DD (es «${a.today}»)`);
  return a;
}

// la carpeta del estado la sabe tycon-home.js, que siempre viaja con el arnés
function stateDir() {
  return require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(os.homedir());
}

function defaults(a) {
  const out = { ...a };
  // el día local, como lo anota el registro de usos de cada máquina (legacy-names.js)
  const d = new Date();
  out.today = a.today || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  out.map = a.map || LN.DEFAULT_MAP;
  out.sources = a.sources || process.env.TYCON_SOURCES_JSON || path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'sources.json');
  out.mirror = a.mirror || process.env.TYCON_MAILBOX_DIR || path.join(stateDir(), 'corridas-buzon');
  out.az = a.az || 'az';
  return out;
}

/** Un ejecutable de az (o el de laboratorio, un .js): `{ ok, json, error }`, mirando el código de salida primero. */
function az(bin, args) {
  const [cmd, pre] = /\.js$/.test(bin) ? [process.execPath, [bin]] : [bin, []];
  const r = spawnSync(cmd, [...pre, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, error: `${bin} no corrió (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { ok: false, error: `az ${args.slice(0, 3).join(' ')} salió ${r.status}: ${String(r.stderr || '').trim().slice(0, 200)}` };
  // salió 0 sin escribir nada: lo decide quien pregunta (el timeline de una corrida cancelada antes de arrancar)
  if (!String(r.stdout || '').trim()) return { ok: true, json: null, empty: true };
  try { return { ok: true, json: JSON.parse(r.stdout) }; } catch (_) { return { ok: false, error: `az ${args.slice(0, 3).join(' ')} no devolvió JSON` }; }
}

function readJson(f, what) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(`no pude leer ${what} (${f}: ${e.code || e.message})`); }
}

/**
 * El buzón: usos por entrada, qué alias reportaron en la ventana y lo que no se pudo leer. Lanza si no puede leer el
 * espejo. Una máquina que nunca usó un nombre viejo no tiene registro: la subida lo dice con ese motivo, y es un reporte
 * con cero usos (el estado al que se quiere llegar). Un registro que no se pudo leer, no.
 */
function readMailbox(mirror, windowFrom, today) {
  let folders;
  try { folders = fs.readdirSync(mirror, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) {
    throw new Error(`no pude leer el espejo del buzón ${mirror} (${e.code || e.message})`);
  }
  const uniones = leerUnionesDeCarpetas(mirror);
  const reported = new Set();
  const uses = [];
  const failed = [];
  for (const m of folders) {
    const reg = path.join(mirror, m, 'registros');
    let cob;
    try { cob = JSON.parse(fs.readFileSync(path.join(reg, 'cobertura.json'), 'utf8')); } catch (_) { continue; }
    const ln = cob && cob.fuentes && cob.fuentes['legacy-names'];
    if (!ln || !isDay(cob.fecha) || cob.fecha < windowFrom) continue;
    const sinRegistro = ln.estado === 'no_medido' && ln.motivo === NO_REGISTRY;
    if (ln.estado !== 'medido' && !sinRegistro) continue;
    const alias = aliasDeNombre(m);
    const aliases = [alias];
    const u = uniones.estado === 'medidas' ? uniones.carpetas.get(m) : null;
    if (u && u.estado === 'unida') aliases.push(aliasDeNombre(u.nueva));
    for (const x of aliases) if (x) reported.add(x);
    if (sinRegistro) continue;
    let lines = [];
    try { lines = zlib.gunzipSync(fs.readFileSync(path.join(reg, 'legacy-names.jsonl.gz'))).toString('utf8').split('\n'); } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`no pude leer los usos de ${m} (${e.code || e.message})`);
    }
    let bad = 0;
    for (const l of lines) {
      if (!l.trim()) continue;
      let o;
      try { o = JSON.parse(l); } catch (_) { bad++; continue; }
      if (o && isDay(o.day) && o.day <= today && o.kind && o.old) uses.push({ day: o.day, kind: o.kind, old: o.old, script: o.script || null, source: `maquina:${alias || m}` });
    }
    // una línea rota pudo ser el único uso de un nombre: no se tira en silencio
    if (bad) failed.push({ source: 'buzon', query: `registro de ${alias || m}`, error: `${bad} línea(s) ilegible(s) en los usos de ${alias || m}` });
  }
  return { reported, uses, failed };
}

/**
 * Los avisos «nombre viejo» de las corridas de la ventana, en todos los pipelines de un proyecto: los de los repos de la
 * lista (`listed`: nombre del repo → ruta) y los demás, que salen «no declarados» si llaman al arnés (un aviso «nombre
 * viejo» sólo lo escribe el arnés). Una respuesta de az con otra forma es una consulta que falló, nunca «cero».
 */
function readProject(bin, project, listed, windowFrom, today) {
  const failed = [];
  const uses = [];
  const undeclared = [];
  const fail = (repo, query, error, extra = {}) => failed.push({ repo, query, error, ...extra });
  const list = az(bin, ['pipelines', 'list', '-p', project, '-o', 'json']);
  const bad = list.ok && !Array.isArray(list.json) ? 'az pipelines list no devolvió una lista' : null;
  if (!list.ok || bad) {
    for (const ruta of listed.values()) fail(ruta, `pipelines list ${project}`, list.error || bad);
    return { failed, uses, undeclared };
  }
  for (const p of list.json) {
    // la lista no trae el repo de cada pipeline: lo dice «pipelines show». Sin saberlo, los repos de la lista de ese
    // proyecto quedan sin medir (puede ser de cualquiera de ellos)
    let repoName = p && p.repository && p.repository.name;
    if (!repoName) {
      const show = az(bin, ['pipelines', 'show', '-p', project, '--id', String(p.id), '-o', 'json']);
      repoName = show.ok && show.json && show.json.repository && show.json.repository.name;
      if (!repoName) {
        for (const r of listed.values()) fail(r, `pipelines show ${p.id}`, show.error || `no sé de qué repo es el pipeline ${p.name}`);
        continue;
      }
    }
    const ruta = listed.get(repoName) || null;
    const label = ruta || `${project}/${repoName}`;
    const extra = ruta ? {} : { undeclared: true };
    const source = ruta ? `pipeline:${ruta}` : `no-declarado:${project}/${repoName}`;
    const runs = az(bin, ['pipelines', 'runs', 'list', '-p', project, '--pipeline-ids', String(p.id), '--top', String(RUNS_TOP), '-o', 'json']);
    if (!runs.ok || !Array.isArray(runs.json)) { fail(label, `runs list ${p.id}`, runs.error || 'az pipelines runs list no devolvió una lista', extra); continue; }
    // una corrida en curso (la de producción que espera su aprobación, a veces por semanas) se lee siempre, arranque
    // cuando arranque: lo que ya corrió tiene sus avisos, y los pasos que faltan todavía no usaron ningún nombre
    const ended = (r) => String((r && r.finishTime) || '').slice(0, 10);
    const inWindow = runs.json.filter((r) => r && (!r.finishTime || (isDay(ended(r)) && ended(r) >= windowFrom)));
    if (runs.json.length >= RUNS_TOP && runs.json.every((r) => !r.finishTime || ended(r) >= windowFrom)) {
      fail(label, `runs list ${p.id}`, `más de ${RUNS_TOP} ejecuciones en la ventana: se pasó el tope y no se miraron todas`, extra);
      continue;
    }
    let called = false;
    for (const run of inWindow) {
      const tl = az(bin, ['devops', 'invoke', '--area', 'build', '--resource', 'timeline', '--route-parameters', `project=${project}`, `buildId=${run.id}`, '--api-version', '7.1', '-o', 'json']);
      // una corrida cancelada antes de arrancar (empieza y termina en el mismo instante) no tiene registro: az sale 0 sin
      // escribir nada, y no usó ningún nombre. Cualquier otro vacío no se sabe qué fue: consulta que falló
      const neverRan = run.result === 'canceled' && run.startTime && run.startTime === run.finishTime;
      if (tl.ok && tl.empty && neverRan) continue;
      if (!tl.ok || !tl.json || !Array.isArray(tl.json.records)) { fail(label, `timeline ${run.id}`, tl.error || (tl.empty ? 'el timeline vino vacío' : 'el timeline no trae «records»'), extra); continue; }
      for (const rec of tl.json.records) {
        // cada aviso con el día de su paso; sin él, el de la corrida, y una en curso, hoy
        const recDay = String((rec && (rec.finishTime || rec.startTime)) || '').slice(0, 10);
        const day = isDay(recDay) ? recDay : (run.finishTime ? ended(run) : today);
        for (const is of (rec && rec.issues) || []) {
          const m = is && is.type === 'warning' && WARNING.exec(String(is.message || ''));
          if (!m) continue;
          called = true;
          uses.push({ day, kind: m[2], old: m[2] === 'option' ? m[1].replace(/^-+/, '') : m[1], script: m[3] || null, source });
        }
      }
    }
    if (!ruta && called) undeclared.push({ project, repo: repoName, pipeline: p.name });
  }
  return { failed, uses, undeclared };
}

function productRepos(parityFile) {
  const cfg = readJson(parityFile, 'la lista de productos');
  const out = new Map();
  for (const g of Object.values((cfg && cfg.grupos) || {})) {
    const repos = Array.isArray(g) ? g : (g && Array.isArray(g.repos) ? g.repos : []);
    for (const r of repos) {
      const ruta = typeof r === 'string' ? r : r && r.ruta;
      if (ruta && !out.has(ruta)) out.set(ruta, { ruta, ado: r && typeof r === 'object' ? r.ado || null : null });
    }
  }
  return [...out.values()];
}

function defaultParity() {
  try {
    const c = require(path.join(ROOT, 'scripts', 'ci', 'check-product-parity.js')).configPorDefecto();
    return c.problema ? { error: c.problema } : { file: c.ruta };
  } catch (e) { return { error: `no pude ubicar la lista de productos (${e.message})` }; }
}

function defaultReposRoot() {
  try { return require(path.join(ROOT, 'scripts', 'lib', 'repos-root.js')).resolveReposRoot().root; } catch (_) { return null; }
}

function check(o) {
  const today = o.today;
  const map = readJson(o.map, 'el mapa de renombres');
  const global = isDay(map.retire_after) ? map.retire_after : null;
  const entries = LN.entriesOf(map).filter((e) => typeof e.kind === 'string' && typeof e.old === 'string' && typeof e.new === 'string');
  const windowFrom = addDays(today, -WINDOW_DAYS);
  const failed = [];
  const reasons = [];
  const uses = [];

  // (b) el buzón
  if (o.download) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'metrics', 'download-runs.js'), '--json', '--no-threads'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch (_) { /* abajo */ }
    if (r.status !== 0 || !j) failed.push({ source: 'buzon', query: 'download-runs', error: `la bajada del buzón salió ${r.status}${j && j.motivo ? `: ${j.motivo}` : ''}` });
    else if (DOWNLOAD_UNREAD.has(j.estado)) failed.push({ source: 'buzon', query: 'download-runs', error: `esta máquina no puede leer el buzón (${j.estado}${j.motivo ? `: ${j.motivo}` : ''})` });
  }
  let mailbox = { reported: new Set(), uses: [], failed: [] };
  if (!failed.some((f) => f.source === 'buzon')) {
    try { mailbox = readMailbox(o.mirror, windowFrom, today); } catch (e) { failed.push({ source: 'buzon', query: 'espejo', error: e.message }); }
  }
  uses.push(...mailbox.uses);
  failed.push(...mailbox.failed);
  let expected = [];
  try {
    const s = readJson(o.sources, 'las máquinas esperadas');
    expected = ((s.reducer && s.reducer.expected_machines) || []).filter((m) => m && m.alias && (!isDay(m.from) || m.from < today)).map((m) => m.alias);
  } catch (e) { failed.push({ source: 'maquinas', query: 'sources.json', error: e.message }); }
  const buzonOk = !failed.some((f) => f.source === 'buzon' && (f.query === 'espejo' || f.query === 'download-runs'));
  const unreported = buzonOk ? expected.filter((al) => !mailbox.reported.has(al)) : [];

  // (c) las corridas
  const parity = o.parity ? { file: o.parity } : defaultParity();
  let repos = [];
  if (parity.error) failed.push({ source: 'productos', query: 'product-parity.json', error: parity.error });
  else { try { repos = productRepos(parity.file); } catch (e) { failed.push({ source: 'productos', query: 'product-parity.json', error: e.message }); } }
  // una lista vacía no mide nada; un producto sin `ado` no tiene corridas que leer: los dos son «no pude medir»
  if (!parity.error && !failed.some((f) => f.source === 'productos') && !repos.length) failed.push({ source: 'productos', query: 'product-parity.json', error: 'la lista de productos no tiene ningún repo' });
  for (const r of repos.filter((x) => !x.ado)) failed.push({ repo: r.ruta, query: 'ado', error: 'el repo no dice dónde vive en Azure DevOps (`ado`): sus ejecuciones no se miran' });
  // por proyecto, todos sus pipelines: los de la lista y los que no lo están
  const projects = new Map();
  for (const repo of repos.filter((r) => r.ado)) {
    const cut = String(repo.ado).lastIndexOf('/');
    const project = decodeURIComponent(String(repo.ado).slice(0, cut));
    if (!projects.has(project)) projects.set(project, new Map());
    projects.get(project).set(String(repo.ado).slice(cut + 1), repo.ruta);
  }
  const undeclared = [];
  for (const [project, listed] of projects) {
    const r = readProject(o.az, project, listed, windowFrom, today);
    uses.push(...r.uses);
    failed.push(...r.failed);
    undeclared.push(...r.undeclared);
  }
  const failedRepos = repos.filter((repo) => failed.some((f) => f.repo === repo.ruta && !f.undeclared));

  // lo que nombra cada repo cuya consulta falló. Un pipeline fuera de la lista que no se pudo leer (una corrida en curso,
  // una consulta caída) se informa y da salida 2, pero no deja sin medir lo de los productos: no se sabe qué nombra, y
  // marcar todo dejaría el retiro entero esperando a un repo ajeno (mismo criterio que la máquina callada, AC 18 b)
  const unmeasured = new Set();
  let unmeasuredAll = failed.some((f) => f.source === 'productos');
  const reposRoot = o.reposRoot || defaultReposRoot();
  for (const repo of failedRepos) {
    const clone = reposRoot ? path.join(reposRoot, repo.ruta) : null;
    if (!clone || !fs.existsSync(clone)) { unmeasuredAll = true; continue; }
    try { for (const f of LN.productReport(clone, { mapFile: o.map })) unmeasured.add(`${f.kind}\0${f.old}`); } catch (_) { unmeasuredAll = true; }
    for (const e of entries) if (UNREPORTED_CI_KINDS.has(e.kind)) unmeasured.add(`${e.kind}\0${e.old}`);
  }

  // un guion por su ruta de hoy: el registro anota la ruta con la que corrió, que puede ser la de antes
  const renamed = new Map(entries.filter((e) => e.kind === 'file').map((e) => [e.old, e.new]));
  const current = (p) => { let x = p; for (let i = 0; i < 10 && renamed.has(x); i++) x = renamed.get(x); return x; };

  // el estado de cada entrada
  const out = entries.map((e) => {
    const own = isDay(e.retire_after) ? e.retire_after : null;
    const date = own || global;
    const from = own ? addDays(own, -OWN_WINDOW_DAYS) : windowFrom;
    const old = e.kind === 'option' ? e.old.replace(/^-+/, '') : e.old;
    const sameWhere = (u) => !WHERE_KINDS.has(e.kind) || !e.where || !u.script || current(u.script) === current(e.where);
    const seen = uses.filter((u) => u.kind === e.kind && u.old === old && u.day >= from && sameWhere(u));
    let state = 'limpia';
    if (!SOURCE_KINDS.has(e.kind)) state = 'sin-fuente';
    else if (seen.length) state = 'con-uso';
    else if (unmeasuredAll || unmeasured.has(`${e.kind}\0${e.old}`)) state = 'sin-medir';
    return { kind: e.kind, old: e.old, new: e.new, where: e.where || null, state, due: Boolean(date) && today >= date, retire_after: date, sources: [...new Set(seen.map((u) => u.source))].sort() };
  });

  if (!global) reasons.push('el mapa no tiene fecha de retiro (retire_after)');
  else if (today < global) reasons.push(`la fecha de retiro todavía no llegó: ${global}`);
  const by = (s) => out.filter((e) => e.state === s).length;
  if (by('con-uso')) reasons.push(`${by('con-uso')} entrada(s) con uso en la ventana`);
  if (by('sin-medir')) reasons.push(`${by('sin-medir')} entrada(s) sin medir (una consulta falló)`);
  if (by('sin-fuente')) reasons.push(`${by('sin-fuente')} entrada(s) de un tipo que nadie anota`);
  if (out.some((e) => !e.due) && global && today >= global) reasons.push(`${out.filter((e) => !e.due).length} entrada(s) con fecha propia todavía por llegar`);
  if (unreported.length) reasons.push(`${unreported.length} máquina(s) esperada(s) sin reportar en la ventana`);
  for (const u of undeclared) reasons.push(`pipeline no declarado que llama al arnés: ${u.pipeline} (${u.project}/${u.repo}) — falta en la lista de productos`);
  for (const f of failed) reasons.push(`no pude medir ${f.repo || f.source}: ${f.error}`);

  const code = failed.length || unreported.length ? 2 : (reasons.length ? 1 : 0);
  return {
    code,
    report: {
      today, retire_after: global, window_from: windowFrom, own_date_for_used: addDays(today, OWN_WINDOW_DAYS),
      entries: out, machines_unreported: unreported, undeclared_pipelines: undeclared, failed_queries: failed, reasons,
      repos_without_ado: repos.filter((r) => !r.ado).map((r) => r.ruta),
    },
  };
}

function main(argv) {
  let o;
  try { o = defaults(parseArgs(argv)); } catch (e) { process.stderr.write(`legacy-retire-check: ${e.message}\n`); return 2; }
  let r;
  try { r = check(o); } catch (e) { process.stderr.write(`legacy-retire-check: no pude medir: ${e.message}\n`); return 2; }
  if (o.json) process.stdout.write(`${JSON.stringify(r.report, null, 1)}\n`);
  else {
    const n = (s) => r.report.entries.filter((e) => e.state === s).length;
    process.stdout.write(`${r.code === 0 ? 'Se puede retirar todo' : r.code === 1 ? 'Todavía no se retira todo' : 'No pude medir todo'} (${r.report.today}): ${n('limpia')} limpia(s), ${n('con-uso')} con uso, ${n('sin-medir')} sin medir, ${n('sin-fuente')} sin fuente.\n`);
    for (const m of r.report.reasons) process.stdout.write(`  · ${m}\n`);
  }
  return r.code;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, check, parseArgs };
