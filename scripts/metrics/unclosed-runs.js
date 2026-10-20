#!/usr/bin/env node
'use strict';
/**
 * unclosed-runs.js — las corridas del pipeline que quedaron sin cerrar en esta máquina.
 *
 * Una corrida deja su volcado en `timing-history/` (lo que sube al buzón) sólo cuando el marcador se limpia
 * (`marker.js clear`). Si el marcador desaparece antes, la corrida no sube y nada lo dice. Este guion las busca y deja,
 * por cada una, un volcado marcado `sinCerrar: true` en `timing-history/`, para que suba por el camino de siempre.
 *
 * Dónde busca: en `.advisors/pipeline-runs/` de los repos de las sesiones de la persona (`repos-root.js` →
 * `sessionRepos`), no en una raíz configurada.
 *
 * Qué cuenta como sin cerrar, un run dir `<clave>-<AAAAMMDDHHMMSS>` (UTC) que:
 *   1. es de esta máquina: nunca entró a git (sin seguimiento o ignorado) o el `gates.log` de la máquina tiene renglones
 *      de esa story en ese repo, desde el arranque hasta 48 h después. Un run dir commiteado sin renglones llegó por
 *      merge o es anterior al registro: no se toma, y es un límite;
 *   2. no tiene un cierre en `timing-history/` (misma story, arranque a menos de 5 minutos) ni un volcado de este guion;
 *   3. no es la corrida de un marcador vivo (misma story y mismo repo);
 *   4. arrancó hace más de 24 h.
 *
 * El volcado no inventa nada: trae la story, el repo, el arranque del nombre, los renglones del `gates.log`, los
 * hallazgos, los revisores y las aprobaciones que el run dir tenga; lo que falta va en `no_medido` con el motivo. La
 * sesión sale del `gates.log`; sin renglones, un identificador propio (`sin-cerrar-<huella>`), dicho en `no_medido`.
 *
 * Uso: node scripts/metrics/unclosed-runs.js [--json]   → lista las corridas sin cerrar (sólo lee)
 *      node scripts/metrics/unclosed-runs.js --write    → además deja sus volcados en timing-history/
 * Sale 0 siempre que pudo mirar; 2 si no pudo leer la carpeta de estado.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const H = 3600 * 1000;
const MIN_AGE_MS = 24 * H;
const GATES_WINDOW_MS = 48 * H;
const CLOSE_TOLERANCE_MS = 5 * 60 * 1000;
const RUN_NAME = /^(.+)-(\d{14})$/;
const SUFFIX = '-sin-cerrar.json';

const stateDirOf = (home) => require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).stateDir(home);

/** Dos rutas del mismo repo: en Windows sin distinguir mayúsculas ni la barra final. */
function sameRepo(a, b, platform = process.platform) {
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '');
  return platform === 'win32' ? norm(a).replace(/\//g, '\\').toLowerCase() === norm(b).replace(/\//g, '\\').toLowerCase() : norm(a) === norm(b);
}
const realOr = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };

function startOf(stamp) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(stamp);
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // Date.UTC acepta un mes 13 o un día 32 y los corre: una fecha que no vuelve igual no es una fecha
  return new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14) === stamp ? t : NaN;
}

function readJsonLines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (_) { /* un renglón roto no es un dato */ } }
  return out;
}

/** ¿El renglón del gates.log es de esta story? Por su storyId o por el nombre del archivo de la story. */
function gateIsStory(g, key) {
  if (g.storyId === key || g.story === key) return true;
  const base = path.basename(String(g.storyPath || ''));
  return base === `story-${key}.md` || base.startsWith(`story-${key}-`);
}

/**
 * Los run dirs que git conoce en ese repo (una sola llamada por repo: un repo puede tener cientos). Un run dir que no
 * está nunca entró a git (sin seguimiento o ignorado). Sin git o sin repo no se puede decir: null.
 */
function trackedRuns(repo, problems) {
  const r = spawnSync('git', ['-C', repo, 'ls-files', '-z', '--', '.advisors/pipeline-runs'], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const why = r.error ? r.error.message : String(r.stderr || '').trim().split('\n')[0] || `salió ${r.status}`;
    problems.push(`${repo}: no pude preguntarle a git qué corridas conoce (${why}); sus corridas sin renglones en el gates.log no se miraron`);
    return null;
  }
  const names = new Set();
  for (const f of r.stdout.split('\0')) { const m = /^\.advisors\/pipeline-runs\/([^/]+)\//.exec(f); if (m) names.add(m[1]); }
  return names;
}

function findUnclosed(opts = {}) {
  const home = opts.home || os.homedir();
  const stateDir = opts.stateDir || stateDirOf(home);
  const now = opts.now != null ? opts.now : Date.now();
  const platform = opts.platform || process.platform;
  const problems = [];
  const histDir = path.join(stateDir, 'timing-history');
  // los volcados de este guion ya hechos, y los cierres de esta máquina (story → arranques). Los cierres pesan (la carpeta
  // puede pasar el GB): se abren sólo los de las stories que tienen un run dir candidato, por el nombre del archivo
  // (`<story>-<ts>.json`, como lo escribe marker.js)
  const done = new Set();
  let hist = [];
  try { hist = fs.readdirSync(histDir).filter((f) => f.endsWith('.json')); } catch (e) { if (e.code !== 'ENOENT') problems.push(`${histDir}: ${e.message}`); }
  for (const f of hist) if (f.endsWith(SUFFIX)) done.add(f);
  const closes = new Map();
  // Un cierre ilegible de la story no prueba que no esté: esa story queda sin decidir (no se toma), y se dice.
  const closesOf = (key) => {
    if (closes.has(key)) return closes.get(key);
    const safe = key.replace(/[^\w.-]/g, '_');
    const out = { starts: [], unreadable: false };
    for (const f of hist) {
      if (f.endsWith(SUFFIX) || !f.startsWith(`${safe}-`)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8')).marker;
        const t = Date.parse(m && m.startedAt);
        if (m && String(m.storyId) === key && Number.isFinite(t)) out.starts.push(t);
      } catch (e) {
        out.unreadable = true;
        problems.push(`${path.join(histDir, f)}: cierre ilegible (${e.message}); las corridas de la story ${key} no se miraron`);
      }
    }
    closes.set(key, out);
    return out;
  };
  // los marcadores vivos; uno ilegible puede ser el de cualquier corrida: con eso no se toma ninguna, y se dice
  const live = [];
  let liveUnreadable = false;
  try {
    for (const f of fs.readdirSync(path.join(stateDir, 'active')).filter((x) => x.endsWith('.json'))) {
      try { const m = JSON.parse(fs.readFileSync(path.join(stateDir, 'active', f), 'utf8')); if (m && m.storyId) live.push(m); } catch (e) {
        liveUnreadable = true;
        problems.push(`${path.join(stateDir, 'active', f)}: marcador ilegible (${e.message}); no se tomó ninguna corrida sin cerrar`);
      }
    }
  } catch (e) { if (e.code !== 'ENOENT') { liveUnreadable = true; problems.push(`${path.join(stateDir, 'active')}: ${e.message}; no se tomó ninguna corrida sin cerrar`); } }
  if (liveUnreadable) return { runs: [], problems };
  let gates = [];
  try { gates = readJsonLines(path.join(stateDir, 'gates.log')); } catch (e) { problems.push(`gates.log: ${e.message}`); }
  // el registro, indexado una vez por la ruta real de su repo (son miles de renglones y cientos de run dirs)
  const byRepo = new Map();
  const realCache = new Map();
  const realOnce = (p) => { if (!realCache.has(p)) realCache.set(p, realOr(p)); return realCache.get(p); };
  const keyOf = (p) => { const r = realOnce(p).replace(/[\\/]+$/, ''); return platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r; };
  for (const g of gates) {
    const t = Date.parse(g && g.ts);
    if (!g || !g.repoPath || !Number.isFinite(t)) continue;
    const k = keyOf(g.repoPath);
    if (!byRepo.has(k)) byRepo.set(k, []);
    byRepo.get(k).push({ g, t });
  }
  const gatesOf = (repo) => byRepo.get(keyOf(repo)) || [];

  const repos = opts.repos || require(path.join(__dirname, '..', 'lib', 'repos-root.js')).sessionRepos({ home, projectsDir: opts.projectsDir, tmp: opts.tmp, env: opts.env, platform });
  const runs = [];
  for (const repo of repos) {
    const base = path.join(repo, '.advisors', 'pipeline-runs');
    let names;
    try { names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') problems.push(`${base}: no la pude leer (${e.code || e.message})`);
      continue;
    }
    let tracked;   // se pide a git sólo si algún run dir llega a necesitarlo
    let repoGates; // los renglones del gates.log de este repo, con su hora
    for (const name of names) {
      const m = RUN_NAME.exec(name);
      if (!m) continue;
      const key = m[1];
      const start = startOf(m[2]);
      if (!Number.isFinite(start) || now - start <= MIN_AGE_MS) continue;
      if (done.has(`${name}${SUFFIX}`)) continue;
      // lo barato primero: el registro y git; los cierres (que pesan) sólo para lo que pasa
      if (repoGates === undefined) repoGates = gatesOf(repo);
      const mine = repoGates.filter((x) => x.t >= start && x.t <= start + GATES_WINDOW_MS && gateIsStory(x.g, key)).map((x) => x.g);
      if (!mine.length) {
        if (tracked === undefined) tracked = trackedRuns(repo, problems);
        if (!tracked || tracked.has(name)) continue;
      }
      if (live.some((x) => String(x.storyId) === key && sameRepo(realOr(x.repoPath), realOr(repo), platform))) continue;
      const c = closesOf(key);
      if (c.unreadable || c.starts.some((t) => Math.abs(t - start) <= CLOSE_TOLERANCE_MS)) continue;
      runs.push({ repo, dir: path.join(base, name), name, key, start, gates: mine, why: mine.length ? 'gates.log' : 'nunca entró a git' });
    }
  }
  return { runs, problems };
}

function readIfThere(file, parse) {
  try { const t = fs.readFileSync(file, 'utf8'); return { ok: true, value: parse(t) }; } catch (e) { return { ok: false, why: e.code === 'ENOENT' ? 'el run dir no lo trae' : `ilegible (${e.message})` }; }
}

/** El volcado de una corrida sin cerrar: sólo lo que hay; lo que falta, en `no_medido` con el motivo. */
function buildDump(run) {
  const no = {
    pasos: 'corrida sin cerrar: el marcador desapareció sin su cierre, que es lo que anota los pasos',
    consumo: 'corrida sin cerrar: el consumo se rescata al cerrar el marcador',
    costo: 'corrida sin cerrar: los agentes lanzados se cuentan al cerrar el marcador',
  };
  const counts = new Map();
  for (const g of run.gates) if (g.sessionId) counts.set(g.sessionId, (counts.get(g.sessionId) || 0) + 1);
  let sessionId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  sessionId = sessionId ? sessionId[0] : null;
  if (!sessionId) {
    sessionId = `sin-cerrar-${crypto.createHash('sha256').update(`${run.repo}\n${run.name}`).digest('hex').slice(0, 12)}`;
    no.sesion = 'el gates.log de esta máquina no tiene renglones de esta corrida: la sesión no se conoce; el identificador sale del repo y del run dir';
  }
  // Lo que sale de la máquina es una lista cerrada de campos, como en un cierre normal: nada de texto libre de la carpeta
  // de corrida (motivos, citas de aprobaciones) ni renglones de otras sesiones de la misma story.
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && (typeof o[k] === 'string' || typeof o[k] === 'number' || typeof o[k] === 'boolean')).map((k) => [k, o[k]]));
  const gates = run.gates.filter((g) => g.sessionId === sessionId)
    .map((g) => pick(g, ['ts', 'sessionId', 'repoPath', 'storyPath', 'check', 'status', 'provenance', 'name', 'action', 'mode', 'verdict']));
  const dump = {
    archivedAt: null,
    sinCerrar: true,
    origen: { runDir: run.name, porque: run.why },
    marker: { sessionId, storyId: run.key, repoPath: run.repo, startedAt: new Date(run.start).toISOString() },
    gates,
  };
  if (!gates.length) no.gates = 'el gates.log de esta máquina no tiene renglones de esta corrida';
  const f = readIfThere(path.join(run.dir, 'findings.json'), JSON.parse);
  if (f.ok && Array.isArray(f.value)) dump.hallazgos = f.value.map((x) => pick(x, ['rule_id', 'severity', 'advisor', 'disposition']));
  else no.hallazgos = f.ok ? 'el findings.json del run dir no es una lista' : f.why;
  const r = readIfThere(path.join(run.dir, 'review-roster.json'), JSON.parse);
  const roster = r.ok && r.value && (Array.isArray(r.value) ? r.value : r.value.reviewers || r.value.roster || r.value.revisores);
  if (Array.isArray(roster)) dump.revisores = roster.map((x) => (typeof x === 'string' ? x : x && (x.agent || x.advisor || x.name))).filter((x) => typeof x === 'string');
  else no.revisores = r.ok ? 'el review-roster.json del run dir no trae una lista de revisores' : r.why;
  const a = readIfThere(path.join(run.dir, 'approvals.jsonl'), (t) => t.split('\n').filter((l) => l.trim()).length);
  if (a.ok) dump.aprobaciones = a.value; else no.aprobaciones = a.why;
  dump.no_medido = no;
  return dump;
}

/** Deja en `dest` (timing-history/) un volcado por corrida sin cerrar, una sola vez. */
function materialize(opts = {}) {
  const home = opts.home || os.homedir();
  const stateDir = opts.stateDir || stateDirOf(home);
  const dest = opts.dest || path.join(stateDir, 'timing-history');
  const found = findUnclosed({ ...opts, stateDir });
  const written = [];
  for (const run of found.runs) {
    const file = path.join(dest, `${run.name}${SUFFIX}`);
    if (fs.existsSync(file)) continue;
    try {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(buildDump(run), null, 2), { encoding: 'utf8', flag: 'wx' });
      written.push(file);
    } catch (e) { if (e.code !== 'EEXIST') found.problems.push(`${file}: ${e.message}`); }
  }
  return { written, runs: found.runs, problems: found.problems };
}

module.exports = { findUnclosed, buildDump, materialize, sameRepo, SUFFIX };

if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    const r = argv.includes('--write') ? materialize({}) : { ...findUnclosed({}), written: [] };
    if (argv.includes('--json')) console.log(JSON.stringify({ runs: r.runs.map((x) => ({ repo: x.repo, name: x.name, story: x.key, porque: x.why })), written: r.written, problems: r.problems }, null, 2));
    else {
      console.log(r.runs.length ? `${r.runs.length} corrida(s) sin cerrar:` : 'ninguna corrida sin cerrar');
      for (const x of r.runs) console.log(`  · ${x.key} · ${x.repo} · ${x.name} (${x.why})`);
      for (const p of r.problems) console.log(`  ⚠️ ${p}`);
    }
    process.exit(0);
  } catch (e) { console.error(`unclosed-runs.js: ${e.message}`); process.exit(2); }
}
