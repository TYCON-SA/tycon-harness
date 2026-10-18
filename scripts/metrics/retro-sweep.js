#!/usr/bin/env node
'use strict';
/**
 * retro-sweep.js — el barrido de cada noche: todo merge a main sin su archivo de métricas recibe su latido.
 * Casos: scripts/tests/retro-sweep.test.js.
 *
 * POR QUÉ EXISTE. retro-pending.js anota sólo el `git push` a main hecho desde una máquina, y casi todo entra por pedido
 * en la plataforma (la cola de GitHub, el auto-completar de Azure DevOps): esos merges no pasan por ninguna sesión, y
 * sin esto se quedan sin su archivo de métricas. Este barrido no depende de quién mergeó: lee la
 * historia de main (primer padre) de cada repo y corre el latido (retro-heartbeat.js: sin modelo, un segundo) de los que
 * no tienen archivo. La retro con modelo NO se corre acá: los merges de story van a la revisión de la semana.
 *
 * CUBIERTO. La regla de retro-pending.js (scripts/lib/retro-coverage.js: repo + sha) sobre las carpetas de `--out` y
 * `--covered-in`, y además un archivo con el sha COMPLETO del merge: el latido de otra máquina nombra el repo con su
 * propia ruta, y un sha de 40 caracteres no se repite entre repos. También cuenta lo que cada repo barrido ya tiene
 * guardado en `.dashboard/` de su main (leído de git: el clon de la noche no tiene los archivos en disco). Un archivo del latido cuenta como «latido sin
 * modelo»; cualquier otro, como «retro con aprendizajes».
 *
 * LO QUE NO PIDE RETRO. La lista declarada de retro-sweep.json (autor y asunto, con su motivo). Nada se excluye fuera
 * de esa lista: un merge que no calza recibe su latido.
 *
 * «NO PUDE MIRAR» NO ES «NO HAY». Un repo que no se pudo bajar o leer queda en el informe con `mirado: false` y su
 * motivo, y el barrido sale 2. Un latido que falló deja el merge en `faltan`, con el motivo, y no cambia la salida:
 * el barrido sí miró.
 *
 * Uso:
 *   node scripts/metrics/retro-sweep.js --out <dir> [--repo <nombre>=<carpeta|url>]… [--team-repos <team-repos.json>]
 *        [--clone-dir <dir>] [--covered-in <dir>]… [--since <YYYY-MM-DD>] [--report <archivo.json>] [--config <archivo>]
 *   --team-repos suma `public`, `maintainers` y `operations` de la organización. Una url se clona en --clone-dir (Azure,
 *   con la credencial de CLONE_TOKEN si está; el nocturno le pasa la de la corrida). Sin --since: desde el último informe que haya junto a --report o, sin ninguno, los
 *   últimos 7 días. stdout: la línea de resumen · exit 0 · 2 si algún repo no se pudo mirar o el uso está mal.
 * Ambiente: TYCON_TODAY (fecha, para pruebas) · TYCON_RETRO_SWEEP_HEARTBEAT (otro guion en lugar del latido, para pruebas).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const RC = require(path.join(__dirname, '..', 'lib', 'retro-coverage.js'));

const HEARTBEAT = process.env.TYCON_RETRO_SWEEP_HEARTBEAT || path.join(__dirname, 'retro-heartbeat.js');
const CONFIG = path.join(__dirname, 'retro-sweep.json');
const TEAM_KEYS = ['public', 'maintainers', 'operations'];
const DAY = 86400000;

function args(argv) {
  const a = { repos: [], coveredIn: [], out: null, teamRepos: null, clones: null, since: null, report: null, config: CONFIG, error: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) a.error = `${k} pide un valor`; return x; };
    if (k === '--repo') {
      const x = v() || '';
      const at = x.indexOf('=');
      if (at <= 0) a.error = `--repo pide <nombre>=<carpeta|url>: ${x}`; else a.repos.push({ nombre: x.slice(0, at), fuente: x.slice(at + 1) });
    } else if (k === '--covered-in') a.coveredIn.push(v());
    else if (k === '--out') a.out = v();
    else if (k === '--team-repos') a.teamRepos = v();
    else if (k === '--clone-dir') a.clones = v();
    else if (k === '--since') a.since = v();
    else if (k === '--report') a.report = v();
    else if (k === '--config') a.config = v();
    else a.error = `opción desconocida: ${k}`;
  }
  if (!a.error && !a.out) a.error = 'falta --out';
  if (!a.error && a.since && !/^\d{4}-\d{2}-\d{2}$/.test(a.since)) a.error = `--since pide YYYY-MM-DD: ${a.since}`;
  return a;
}

function git(cwd, argv, extra = []) {
  return spawnSync('git', [...extra, '-C', cwd, ...argv], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
}
const firstLine = (t) => String(t || '').trim().split('\n').pop().slice(0, 300);

/** La lista declarada, validada: cada entrada con motivo y al menos un patrón. */
function loadConfig(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (d.no_piden_retro || []).map((e, i) => {
    if (!e || typeof e.motivo !== 'string' || !e.motivo || !(e.autor || e.asunto)) throw new Error(`${file}: la entrada ${i} necesita motivo y autor o asunto`);
    return { motivo: e.motivo, autor: e.autor ? new RegExp(e.autor) : null, asunto: e.asunto ? new RegExp(e.asunto) : null, asuntoNo: e.asunto_no ? new RegExp(e.asunto_no) : null };
  });
}
function exclusion(rules, author, subject) {
  for (const r of rules) {
    if (r.autor && !r.autor.test(author)) continue;
    if (r.asunto && !r.asunto.test(subject)) continue;
    if (r.asuntoNo && r.asuntoNo.test(subject)) continue;
    return r.motivo;
  }
  return null;
}

/** Los repos de la organización, de team-repos.json. */
function teamRepos(file) {
  const TR = require(path.join(__dirname, '..', 'lib', 'team-repos.js'));
  const r = TR.load(file);
  if (!r.ok) throw new Error(`${file}: ${r.couldNotRead ? 'no se pudo leer' : (r.problems || []).map((p) => `${p.path} ${p.message}`).join(' · ')}`);
  return TEAM_KEYS.filter((k) => r.data[k]).map((k) => ({ nombre: r.data[k].repo, fuente: TR.url(r.data[k]) }));
}

/** Una carpeta git con la historia de main: la carpeta dada, o el clon de la url. `{ dir, ref }` o `{ motivo }`. */
function obtain(repo, clones) {
  if (fs.existsSync(repo.fuente) && fs.statSync(repo.fuente).isDirectory()) {
    const top = git(repo.fuente, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) return { motivo: `no es un repo git: ${firstLine(top.stderr)}` };
    const dir = top.stdout.trim();
    for (const ref of ['origin/main', 'main']) if (git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0) return { dir, ref };
    return { motivo: 'no tiene main' };
  }
  if (!clones) return { motivo: 'no es una carpeta y falta --clone-dir para bajarlo' };
  const dir = path.join(clones, repo.nombre.replace(/[^\w.-]/g, '_'));
  // la credencial de la corrida, sólo para Azure y sólo en la línea de comando (no queda escrita en el clon)
  const token = process.env.CLONE_TOKEN;
  const auth = /dev\.azure\.com/.test(repo.fuente) && token ? ['-c', `http.extraheader=AUTHORIZATION: bearer ${token}`] : [];
  const r = fs.existsSync(path.join(dir, '.git'))
    ? git(dir, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], auth)
    : (fs.mkdirSync(clones, { recursive: true }), spawnSync('git', [...auth, 'clone', '--quiet', '--no-checkout', repo.fuente, dir], { encoding: 'utf8', timeout: 600000 }));
  if (r.status !== 0) return { motivo: `no se pudo bajar: ${firstLine(r.stderr).replace(/bearer \S+/gi, 'bearer ***')}` };
  if (git(dir, ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']).status !== 0) return { motivo: 'no tiene main' };
  return { dir, ref: 'origin/main' };
}

/**
 * Desde cuándo se barre cada repo: --since, o un día antes del `hasta` del último informe (junto a --report) que MIRÓ
 * ese repo, o los últimos 7 días. Por repo: una noche que no pudo bajar un repo no corre su fecha, y sus merges se
 * barren la próxima vez que se lo pueda mirar.
 */
function sinceFor(a, today, nombre, ilegibles = []) {
  if (a.since) return a.since;
  let best = null;
  let pending = null;
  if (a.report) {
    const dir = path.dirname(path.resolve(a.report));
    let names = [];
    try { names = fs.readdirSync(dir).filter((x) => /^retro-sweep-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort(); } catch (e) {
      // sin carpeta todavía no hay informes; cualquier otra falla se dice como un informe ilegible
      names = [];
      if (e && e.code !== 'ENOENT' && !ilegibles.includes(dir)) ilegibles.push(`${path.basename(dir)}/ (${e.code || 'ilegible'})`);
    }
    for (const f of names) {
      let d;
      // un informe ilegible no fija la fecha, y se dice (no es «no hubo noche anterior»)
      try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { if (!ilegibles.includes(f)) ilegibles.push(f); continue; }
      const r = d && Array.isArray(d.repos) ? d.repos.find((x) => x && x.nombre === nombre && x.mirado === true) : null;
      const h = r && (r.hasta || d.hasta);
      if (/^\d{4}-\d{2}-\d{2}$/.test(h || '') && (!best || h > best)) {
        best = h;
        // lo que esa noche dejó en «faltan» se vuelve a barrer desde la fecha del merge más viejo
        const fechas = (Array.isArray(r.faltan) ? r.faltan : []).map((x) => x && x.fecha).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x || '')).sort();
        pending = fechas[0] || null;
      }
    }
  }
  // un día de solapamiento: el barrido es idempotente y así un merge de la medianoche no queda afuera
  if (best) {
    const overlap = new Date(Date.parse(`${best}T12:00:00Z`) - DAY).toISOString().slice(0, 10);
    return pending && pending < overlap ? pending : overlap;
  }
  return new Date(Date.parse(`${today}T12:00:00Z`) - 7 * DAY).toISOString().slice(0, 10);
}

/** Un motivo que se guarda y viaja: sin credenciales ni rutas de la máquina, en una línea corta. */
function clean(t) {
  return String(t || '').replace(/bearer\s+\S+/gi, 'bearer ***').replace(/\/\/[^\s/@]*@/g, '//***@')
    .replace(/(^|[\s'"(=:])(?:[A-Za-z]:|~|\.{1,2})?[\\/][^\s'"),:]+/g, '$1<ruta>').slice(0, 200);
}

/**
 * Los archivos de métricas que un repo ya tiene guardados en main (`.dashboard/**.json`, subcarpetas incluidas), leídos de git: en la noche el
 * clon no tiene los archivos en disco, y ahí están los latidos y las retros que escribieron las máquinas.
 */
function dashboardFromGit(dir, ref) {
  // sin .dashboard/ en main no hay nada guardado (no es una falla); cualquier otra falla se dice
  if (git(dir, ['rev-parse', '--verify', '--quiet', `${ref}:.dashboard`]).status !== 0) return { records: [], motivo: null };
  const ls = git(dir, ['ls-tree', '-r', '--name-only', ref, '--', '.dashboard']);
  if (ls.status !== 0) return { records: [], motivo: `no se pudo listar .dashboard/ de main: ${clean(firstLine(ls.stderr))}` };
  const names = ls.stdout.split('\n').filter((f) => /\.json$/.test(f));
  if (!names.length) return { records: [], motivo: null };
  const cat = spawnSync('git', ['-C', dir, 'cat-file', '--batch'], { input: names.map((f) => `${ref}:${f}`).join('\n') + '\n', maxBuffer: 256 * 1024 * 1024 });
  if (cat.status !== 0) return { records: [], motivo: `no se pudo leer .dashboard/ de main: ${clean(firstLine(cat.stderr))}` };
  const buf = cat.stdout;
  const out = [];
  let i = 0;
  let skipped = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) break;
    const head = buf.slice(i, nl).toString('utf8').split(' ');
    if (head[1] !== 'blob') { skipped++; i = nl + 1; continue; }
    const size = Number(head[2]);
    const body = buf.slice(nl + 1, nl + 1 + size).toString('utf8');
    i = nl + 1 + size + 1;
    let d;
    try { d = JSON.parse(body); } catch { skipped++; continue; }
    if (!d || typeof d !== 'object') continue;
    const repo = d.repo || d.repo_path || d.repoPath;
    const sha = String(d.merge_commit || d.mergeCommit || d.commit || '');
    if (repo && sha) out.push({ repoStr: String(repo), sha, generatedBy: typeof d.generated_by === 'string' ? d.generated_by : null });
  }
  return { records: out, motivo: skipped ? `${skipped} archivo(s) de .dashboard/ de main no se pudieron leer` : null };
}

function sweepRepo(repo, got, ctx) {
  if (!got.dir) return { nombre: repo.nombre, mirado: false, motivo: clean(got.motivo) };
  const desde = sinceFor(ctx.a, ctx.today, repo.nombre, ctx.ilegibles);
  const log = git(got.dir, ['log', '--first-parent', `--since=${desde}T00:00:00`, '--format=%H%x09%cI%x09%an%x09%s', got.ref]);
  if (log.status !== 0) return { nombre: repo.nombre, mirado: false, motivo: `no se pudo leer la historia: ${clean(firstLine(log.stderr))}` };
  try { return walk(repo, got, ctx, desde, log.stdout); } catch (e) {
    // un archivo de métricas `null` (o ilegible de otra forma) no se saltea: el repo queda sin mirar, con el motivo
    return { nombre: repo.nombre, mirado: false, motivo: clean(`no se pudo leer lo ya cubierto: ${e.message}`) };
  }
}

function walk(repo, got, ctx, desde, history) {
  const res = { nombre: repo.nombre, mirado: true, desde, hasta: ctx.today, merges: 0, latido: 0, aprendizajes: 0, no_piden: {}, faltan: [], latidos_corridos: 0 };
  if (got.savedMotivo) res.guardado_sin_leer = got.savedMotivo;
  for (const line of history.split('\n').filter(Boolean)) {
    const [sha, date, author, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    res.merges++;
    const motivo = exclusion(ctx.rules, author, subject);
    if (motivo) { res.no_piden[motivo] = (res.no_piden[motivo] || 0) + 1; continue; }
    const recs = RC.coveringRecords({ repoPath: got.dir, sha }, ctx.dirs);
    for (const d of ctx.dirs) for (const m of RC.metricsIn(d) || []) if (m.sha === sha && !recs.includes(m)) recs.push(m);
    for (const m of ctx.saved) if ((m.sha === sha || (RC.sameRepo(m, got.dir) && RC.sameSha(m.sha, sha))) && !recs.includes(m)) recs.push(m);
    if (recs.length) { res[recs.some((m) => RC.kindOf(m) === 'aprendizajes') ? 'aprendizajes' : 'latido']++; continue; }
    const hb = spawnSync(process.execPath, [HEARTBEAT, '--repo', got.dir, '--merge', sha, '--out', ctx.out], { encoding: 'utf8', timeout: 120000 });
    res.latidos_corridos++;
    if (hb.status === 0) res.latido++;
    // la fecha del merge viaja con lo que falta: la noche siguiente vuelve a barrer desde ahí (sinceFor)
    else res.faltan.push({ sha, fecha: String(date).slice(0, 10), motivo: clean(`el latido falló: ${firstLine(hb.stderr) || (hb.error && (hb.error.code || hb.error.message)) || `código ${hb.status}`}`) });
  }
  return res;
}

function main() {
  const a = args(process.argv.slice(2));
  if (a.error) { console.error(`retro-sweep: ${a.error}`); return 2; }
  const today = process.env.TYCON_TODAY || new Date().toISOString().slice(0, 10);
  let rules; let repos;
  try {
    rules = loadConfig(a.config);
    repos = [...(a.teamRepos ? teamRepos(a.teamRepos) : []), ...a.repos];
  } catch (e) { console.error(`retro-sweep: ${e.message}`); return 2; }
  if (!repos.length) { console.error('retro-sweep: ningún repo para barrer (--repo o --team-repos)'); return 2; }
  const out = path.resolve(a.out);
  fs.mkdirSync(out, { recursive: true });
  const ctx = { a, today, rules, out, ilegibles: [], clones: a.clones ? path.resolve(a.clones) : null,
    dirs: [...new Set([out, ...a.coveredIn.map((d) => path.resolve(d))])] };
  const got = repos.map((r) => obtain(r, ctx.clones));
  ctx.saved = [];
  for (const g of got.filter((x) => x.dir)) { const d = dashboardFromGit(g.dir, g.ref); ctx.saved.push(...d.records); g.savedMotivo = d.motivo; }
  const results = repos.map((r, i) => sweepRepo(r, got[i], ctx));
  const looked = results.filter((r) => r.mirado);
  const sum = (k) => looked.reduce((n, r) => n + r[k], 0);
  const desdes = results.filter((r) => r.desde).map((r) => r.desde).sort();
  if (ctx.ilegibles.length) console.log(`  informe(s) anterior(es) ilegible(s), no fijaron la fecha: ${ctx.ilegibles.join(', ')}`);
  const report = { schema: 1, hecho: new Date().toISOString(), desde: desdes[0] || null, hasta: today, informes_ilegibles: ctx.ilegibles, repos: results,
    totales: { merges: sum('merges'), latido: sum('latido'), aprendizajes: sum('aprendizajes'),
      no_piden: looked.reduce((n, r) => n + Object.values(r.no_piden).reduce((x, y) => x + y, 0), 0),
      faltan: looked.reduce((n, r) => n + r.faltan.length, 0), latidos_corridos: sum('latidos_corridos'),
      sin_mirar: results.length - looked.length } };
  if (a.report) {
    fs.mkdirSync(path.dirname(path.resolve(a.report)), { recursive: true });
    const tmp = `${a.report}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
    fs.renameSync(tmp, a.report);
  }
  const t = report.totales;
  console.log(`retros desde ${report.desde || '?'}: ${t.merges} merges a main · latido sin modelo ${t.latido} (${t.latidos_corridos} corridos ahora) · retro con aprendizajes ${t.aprendizajes} · no piden retro ${t.no_piden} · faltan ${t.faltan}`);
  for (const r of results) for (const f of r.faltan || []) console.log(`  falta ${r.nombre} ${f.sha.slice(0, 7)}: ${f.motivo}`);
  for (const r of results) if (r.guardado_sin_leer) console.log(`  ${r.nombre}: ${r.guardado_sin_leer} (se corren latidos de más; no se pierde nada)`);
  const lost = results.filter((r) => !r.mirado);
  if (lost.length) {
    console.error(`🔴 retro-sweep: no pude mirar: ${lost.map((r) => `${r.nombre} (${r.motivo})`).join(' · ')}`);
    return 2;
  }
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { args, loadConfig, exclusion, teamRepos, clean };
