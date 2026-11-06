'use strict';
// finished-open.js — lo terminado sin cerrar: una ejecución con todos sus pasos hechos que sigue abierta, o un camino
// corto cuyo pedido está abierto o cuya rama ya entró a main. Lo usan el cierre de turno (on-stop-dod-gate.js, la sesión
// propia), el gancho de arranque (scripts/hooks/finished-open-notice.js, toda la máquina), /wip y la oficina.
//
// Nada se cierra acá: sólo se mira y se dice con qué se cierra; un cierre de más pierde la ejecución. Lo que no se pudo medir se
// dice como tal, nunca como «nada abierto».
//
// El pedido de un camino corto: la capa de plataforma sólo lista pedidos abiertos (`change-request list` con la rama),
// con un tope de 5 s; la respuesta, o su falla, queda 10 minutos en `finished-open-prs.json` de la carpeta de estado.
// «Ya entró a main» lo dice git, sin red: la rama tiene algo propio desde la base del carril y su punta está en
// origin/main. Que no se pudo ver el pedido se dice una vez por sesión y por día (`finished-open-said.json`).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const STEPS = require('./steps.js');
const { stateDir: stateDirOf } = require('./state-dir.js');
const { liveness } = require('./session-liveness.js');

const TOPE_MS = 5000;
const FOTO_MS = 10 * 60000;
const MAX_LINEAS = 5;
const POOL = 8;
const SIN_TIEMPO = `se acabó el tope de ${TOPE_MS / 1000} s`;
const RAMAS_PRINCIPALES = ['main', 'master'];
const PREFIJO = '🔔 [tycon-pipeline] ';
const RAIZ = path.join(__dirname, '..', '..', '..', '..');
const PLATFORM = path.join(RAIZ, 'scripts', 'lib', 'platform', 'platform.js');
const WIP = path.join(RAIZ, 'scripts', 'tools', 'work-in-progress.js');
// Un id que va en un comando para copiar: sin nada que la consola expanda, y sin un guion adelante (se leería como opción)
const SID_SEGURO = /^[A-Za-z0-9_][\w.-]*$/;
// Lo que viene de un nombre de archivo o de un marcador, en una línea y sin caracteres de control
const legible = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
// El motivo de una falla que viene de disco o de git (un mensaje de JSON.parse trae un trozo del archivo): legible y corto
const causa = (s) => legible(s).replace(/\s+/g, ' ').trim().slice(0, 160);
// La base de un carril que se le pasa a git: sólo un sha, para que nada del archivo se lea como opción
const SHA = /^[0-9a-f]{7,64}$/;
// Una ruta en un comando para copiar: entre comillas simples si tiene algo más que letras, números y separadores
const rutaParaLaConsola = (p) => (/^[\w./~-]+$/.test(String(p)) ? String(p) : `'${String(p).replace(/'/g, `'\\''`)}'`);

const corto = (sid) => String(sid).slice(0, 8);
const dia = (ms) => new Date(ms).toISOString().slice(0, 10);

/** «1 h 30 min», «45 min», «3 días»: cuánto pasó desde `desde`. */
function hace(desde, now) {
  const min = Math.max(0, Math.floor((now - desde) / 60000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / 1440)} días`;
}

/** Un JSON del disco: { data }, { ausente: true } o { error: '<motivo>' }. */
function leer(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { ausente: true } : { error: causa(e.code || e.message) }; }
  try { return { data: JSON.parse(text) }; } catch (e) { return { error: causa(`JSON roto: ${e.message}`) }; }
}
function escribir(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* la foto es un ahorro: sin ella se vuelve a preguntar */ }
}

/**
 * La ejecución de un marcador, si terminó: null si le quedan pasos o no cerró «Preparar el commit». Si no, `{ storyId,
 * desde, revisar, archivos }`: `desde` es el cierre de «Preparar el commit» (sin él, la última vez que se tocó);
 * `revisar`, si cambió código después de los revisores o los revisores cerraron después del último paso.
 */
function runState(marker) {
  if (!marker || typeof marker !== 'object' || !Array.isArray(marker.stepsPending) || marker.stepsPending.length) return null;
  if (!STEPS.isDone(marker, 'prepare-commit')) return null;
  const vuelta = STEPS.reviewersRound(marker);
  const t = (marker.stepTimings || {})['prepare-commit'] || {};
  const desde = [t.completedAt, marker.lastTouch].map((v) => Date.parse(v || '')).find(Number.isFinite);
  return {
    storyId: marker.storyId ? String(marker.storyId) : '?',
    desde: desde === undefined ? null : desde,
    revisar: Boolean(vuelta) || STEPS.prepareCommitStale(marker),
    archivos: vuelta ? vuelta.archivos : [],
  };
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: TOPE_MS, windowsHide: true });
  return { status: r.status, out: String(r.stdout || '').trim(), err: r.error ? r.error.message : String(r.stderr || '').trim() };
}

/** El pedido abierto de una rama, por la capa de plataforma: { prs: [números] } o { error }. */
function pedirPedidos(repo, rama, { env = process.env, topeMs = TOPE_MS } = {}) {
  if (!fs.existsSync(PLATFORM) || !fs.existsSync(WIP)) return { error: 'la capa de plataforma no está en esta instalación' };
  const origin = git(repo, ['remote', 'get-url', 'origin']);
  if (origin.status !== 0 || !origin.out) return { error: 'el repo no tiene origin' };
  const w = require(WIP);
  const q = w.parseRemote(origin.out);
  if (!q.kind) return { error: `no sé consultar pedidos en ${q.host}` };
  if (topeMs <= 0) return { error: SIN_TIEMPO, sinTiempo: true };
  const r = spawnSync(process.execPath, [PLATFORM, 'change-request', 'list', '--repo', JSON.stringify(w.identityOf(q)),
    '--args', JSON.stringify({ sourceBranch: rama, checks: false, deadlineMs: Date.now() + topeMs })], { encoding: 'utf8', env, timeout: topeMs, windowsHide: true });
  // con el tope recortado por las consultas de antes, vencerlo es falta de tiempo, no una falla de la plataforma
  if (r.error) return r.error.code === 'ETIMEDOUT' && topeMs < TOPE_MS ? { error: SIN_TIEMPO, sinTiempo: true }
    : { error: r.error.code === 'ETIMEDOUT' ? `se pasó del tope de ${TOPE_MS / 1000} s` : r.error.message };
  let v;
  try { v = JSON.parse(r.stdout); } catch { return { error: `respuesta ilegible (${String(r.stderr || r.stdout).split('\n')[0].slice(0, 160) || `salió ${r.status}`})` }; }
  if (!v || v.ok !== true) return { error: `${(v && v.reason) || 'no_medido'}: ${String((v && v.detail) || 'sin detalle').split('\n')[0].slice(0, 160)}` };
  if (!Array.isArray(v.value)) return { error: 'respuesta ilegible (no es una lista)' };
  return { prs: v.value.map((p) => p && p.number).filter(Number.isInteger) };
}

/**
 * Lo que dice un camino corto de sus repos: `{ pedido, entro }` si tiene un pedido abierto o su rama ya entró a main,
 * `{ error }` si no se pudo ver el pedido, o null si no hay nada de eso. `ctx`: { foto, now, env, until }.
 */
function adhocState(adhoc, ctx) {
  const { reposDelCarril } = require('./adhoc-base.js');
  const bases = (adhoc && adhoc.bases) || {};
  // lo que no se pudo mirar se dice: nunca se lee como «nada abierto»
  let falla = null;
  let sinTiempo = false;
  const anotar = (motivo) => { falla = falla || causa(motivo); };
  for (const repo of reposDelCarril(adhoc)) {
    if (!fs.existsSync(repo)) { anotar(`la carpeta ${repo} ya no está`); continue; }
    const head = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (head.status !== 0) { anotar(`no pude leer la rama de ${repo}: ${head.err.split('\n')[0]}`); continue; }
    const rama = head.out;
    if (!rama || rama === 'HEAD' || RAMAS_PRINCIPALES.includes(rama)) continue;
    // ya entró: la punta está en origin/main (1 = no es ancestro; otra salida, falla), es distinta de la base del carril y
    // no está en la línea propia de main desde la base. Una rama que sólo trajo main tiene la punta en esa línea: no
    // entró; una que entró con su merge la tiene del otro lado del merge. Una que entró sin merge (por avance rápido) no
    // se distingue de la que sólo trajo main, y no se afirma
    const base = bases[repo] && SHA.test(String(bases[repo].sha)) ? bases[repo].sha : null;
    // sin main remoto no hay con qué comparar: como sin base, no se afirma (no es una falla)
    const hayMain = git(repo, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']).status === 0;
    if (base && hayMain) {
      const punta = git(repo, ['rev-parse', 'HEAD']);
      const entro = git(repo, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
      if (punta.status !== 0) anotar(`no pude leer la punta de ${repo}: ${punta.err.split('\n')[0]}`);
      else if (entro.status === 0 && !punta.out.startsWith(base) && !base.startsWith(punta.out)) {
        const linea = git(repo, ['rev-list', '--first-parent', `${base}..origin/main`]);
        if (linea.status !== 0) anotar(`no pude leer la línea de main de ${repo}: ${linea.err.split('\n')[0]}`);
        else if (!linea.out.split('\n').includes(punta.out)) return { entro: true };
      } else if (entro.status !== 0 && entro.status !== 1) anotar(`no pude ver si ${repo} entró a main: ${entro.err.split('\n')[0]}`);
    }
    const clave = `${repo}|${rama}`;
    let r = ctx.foto[clave];
    if (!r || !(ctx.now - r.at <= FOTO_MS) || r.at > ctx.now) {
      r = { at: ctx.now, ...pedirPedidos(repo, rama, { env: ctx.env, topeMs: Math.min(TOPE_MS, ctx.until - Date.now()) }) };
      // lo que no se preguntó por falta de tiempo no se guarda: el próximo lo pregunta
      if (!r.sinTiempo) { ctx.foto[clave] = r; ctx.cambio = true; }
    }
    if (r.sinTiempo) sinTiempo = true;
    if (r.error) { anotar(r.error); continue; }
    if (r.prs && r.prs.length) return { pedido: r.prs[0] };
  }
  return falla ? { error: falla, ...(sinTiempo ? { sinTiempo: true } : {}) } : null;
}

function contexto({ home, stateDir, now, env }) {
  const sdir = stateDir || stateDirOf(home);
  const fotoFile = path.join(sdir, 'finished-open-prs.json');
  const f = leer(fotoFile);
  return { sdir, fotoFile, foto: f.data && typeof f.data === 'object' ? f.data : {}, now, env: env || process.env, until: Date.now() + TOPE_MS, cambio: false };
}

/** Lo ya dicho, por sesión, día y caso: true si hay que decirlo ahora (y lo anota). */
function decirUnaVez(sdir, sid, now, caso) {
  const file = path.join(sdir, 'finished-open-said.json');
  const r = leer(file);
  const said = r.data && typeof r.data === 'object' ? r.data : {};
  const hoy = dia(now);
  const clave = `${sid}|${hoy}|${caso}`;
  if (said[clave]) return false;
  for (const k of Object.keys(said)) if (!k.includes(`|${hoy}|`)) delete said[k];
  said[clave] = true;
  escribir(file, said);
  return true;
}

const lineaEjecucion = (e, now) => (e.revisar
  ? `la ejecución de la story ${e.storyId} tiene código cambiado después de los revisores${e.archivos.length ? ` (${e.archivos.slice(0, 5).join(', ')}${e.archivos.length > 5 ? ` y ${e.archivos.length - 5} más` : ''})` : ''}: falta revisarlo; \`pipeline.js next\` dice cómo`
  : `la ejecución de la story ${e.storyId} terminó${e.desde === null ? '' : ` hace ${hace(e.desde, now)}`} y sigue abierta: cerrala con \`marker.js clear\` después del último push y del último pedido`);
const queTiene = (a) => (a.entro ? 'su rama ya en main' : `su pedido ${a.pedido} abierto`);
const motivo = (adhoc) => legible((adhoc && adhoc.reason) || '(sin motivo)').replace(/\s+/g, ' ').slice(0, 80);

/**
 * Las líneas de la sesión `sid` para el cierre de turno: su ejecución terminada y su camino corto con pedido. Vacía si no
 * hay nada. `env` reemplaza el entorno de la consulta a la plataforma (las pruebas).
 */
function stopLines({ sid, home = os.homedir(), stateDir, now = Date.now(), env } = {}) {
  const ctx = contexto({ home, stateDir, now, env });
  const lines = [];
  const safe = String(sid || '_nosession').replace(/[/\\]/g, '_');
  const m = leer(path.join(ctx.sdir, 'active', `${safe}.json`));
  if (m.error) lines.push(`no pude leer la ejecución de la sesión ${legible(sid)} (${m.error})`);
  else if (m.data) { const e = runState(m.data); if (e) lines.push(lineaEjecucion(e, now)); }
  const a = leer(path.join(ctx.sdir, 'adhoc', `${safe}.json`));
  if (a.error) lines.push(`no pude leer el camino corto de la sesión ${legible(sid)} (${a.error})`);
  else if (a.data) {
    const s = adhocState(a.data, ctx);
    if (s && s.error) {
      if (decirUnaVez(ctx.sdir, sid, now, 'pedido')) lines.push(`no pude ver si el pedido del camino corto está abierto (${s.error})`);
    } else if (s) lines.push(`el camino corto «${motivo(a.data)}» tiene ${queTiene(s)} y sigue abierto: cerralo con \`marker.js adhoc clear\``);
  }
  if (ctx.cambio) escribir(ctx.fotoFile, ctx.foto);
  return lines.map((l) => PREFIJO + l);
}

/** Cómo se cierra lo de otra sesión, según viva o no (ninguno si vive: la cierra ella). */
function comoSeCierra(vida, comando) {
  if (vida.unknown) return { vive: null, texto: `no sé si la sesión vive (${causa(vida.unknown)}): no doy comando` };
  if (vida.sinRegistro) return { vive: null, texto: 'no sé si la sesión vive (no tiene registro de sesión: puede ser de Codex, o estar cerrada): no doy comando' };
  if (vida.alive) return { vive: true, texto: 'la cierra su sesión' };
  return { vive: false, texto: `su sesión ya no está: ${comando}` };
}

/**
 * Lo de toda la máquina, para el arranque: `{ items, lines }`. Cada item: { sid, tipo, texto }. `lines`: hasta cinco
 * y «y N más». `markerJs`: la ruta con que se nombran los comandos.
 */
function machine({ home = os.homedir(), stateDir, now = Date.now(), env, markerJs = 'marker.js', isAlive } = {}) {
  const ctx = contexto({ home, stateDir, now, env });
  const items = [];
  // una carpeta que no existe es «nada»; una que no se puede leer se dice
  const nombres = (dir, que) => {
    try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch (e) {
      if (e.code !== 'ENOENT') items.push({ sid: null, tipo: 'ilegible', texto: `no pude leer ${que} de la máquina (${causa(e.code || e.message)})` });
      return [];
    }
  };
  const vidaDe = (sid) => liveness(sid, { home, ...(isAlive ? { isAlive } : {}) });
  const node = `node ${rutaParaLaConsola(markerJs)}`;
  // un renglón que falla no tumba a los demás: se dice cuál
  const cadaUno = (n, que, hacer) => {
    try { hacer(); } catch (e) { items.push({ sid: null, tipo: 'ilegible', texto: `no pude mirar ${que} ${legible(n)} (${causa(String(e.message || e).split('\n')[0])})` }); }
  };
  for (const n of nombres(path.join(ctx.sdir, 'active'), 'las ejecuciones')) cadaUno(n, 'la ejecución', () => {
    const sid = path.basename(n, '.json');
    const m = leer(path.join(ctx.sdir, 'active', n));
    if (m.error) { items.push({ sid, tipo: 'ilegible', texto: `no pude leer la ejecución de la sesión ${legible(sid)} (${m.error})` }); return; }
    const e = m.data && runState(m.data);
    if (!e) return;
    const quien = `story ${legible(e.storyId)} (sesión ${legible(corto(sid))})`;
    if (e.revisar) { items.push({ sid, tipo: 'ejecucion', texto: `${quien}: cambió código después de los revisores; falta revisarlo (\`pipeline.js next\` en su sesión)` }); return; }
    let cierre;
    if (!SID_SEGURO.test(sid)) cierre = { texto: 'id de sesión raro: no doy comando' };
    else {
      let perdida = null;
      let noSe = null;
      try { perdida = require('./open-runs.js').perdida({ sid, cwd: m.data.repoPath, home }); } catch (err) { noSe = causa(String(err.message || err).split('\n')[0]); }
      cierre = noSe ? { texto: `no pude ver si su ejecución está perdida (${noSe}): no doy comando` }
        : perdida ? { texto: `su ejecución está perdida: ${node} clear-session ${sid} --lost (lo firma una persona)` }
          : comoSeCierra(vidaDe(sid), `${node} clear-session ${sid}`);
    }
    items.push({ sid, tipo: 'ejecucion', texto: `${quien}: terminó${e.desde === null ? '' : ` hace ${hace(e.desde, now)}`} y sigue abierta; ${cierre.texto}` });
  });
  for (const n of nombres(path.join(ctx.sdir, 'adhoc'), 'los caminos cortos')) cadaUno(n, 'el camino corto', () => {
    const sid = path.basename(n, '.json');
    const a = leer(path.join(ctx.sdir, 'adhoc', n));
    if (a.error) { items.push({ sid, tipo: 'ilegible', texto: `no pude leer el camino corto de la sesión ${legible(sid)} (${a.error})` }); return; }
    const s = a.data && adhocState(a.data, ctx);
    if (!s) return;
    const quien = `camino corto «${motivo(a.data)}» (sesión ${legible(corto(sid))})`;
    if (s.error) { items.push({ sid, tipo: 'sin-medir', texto: `${quien}: no pude ver si su pedido está abierto (${s.error})` }); return; }
    const cierre = SID_SEGURO.test(sid) ? comoSeCierra(vidaDe(sid), `${node} adhoc clear-orphan ${sid}`) : { texto: 'id de sesión raro: no doy comando' };
    items.push({ sid, tipo: 'camino-corto', texto: `${quien}: tiene ${queTiene(s)} y sigue abierto; ${cierre.texto}` });
  });
  if (ctx.cambio) escribir(ctx.fotoFile, ctx.foto);
  const lines = items.slice(0, MAX_LINEAS).map((i) => i.texto);
  if (items.length > MAX_LINEAS) lines.push(`y ${items.length - MAX_LINEAS} más`);
  return { items, lines };
}

/**
 * Las carpetas de trabajo (los worktrees de los repos del arnés y de la raíz de repos) con cambios sin commitear y sin
 * ninguna sesión viva adentro: el trabajo que quedó tirado al cerrarse su sesión. Una línea por carpeta, con su rama,
 * cuántos archivos y desde cuándo nadie los toca (el cambio más nuevo). Hasta cinco y «y N más»; el mismo tope de 5 s,
 * con varias consultas a git a la vez. `repos`: los repos principales a mirar; sin él, el clon del arnés, agent-skills y
 * los de la raíz de repos (hasta dos niveles). No toca nada: sólo `git worktree list` y `git status`.
 */
async function unsavedFolders({ home = os.homedir(), now = Date.now(), env = process.env, repos, isAlive } = {}) {
  const until = Date.now() + TOPE_MS;
  const gitEnv = { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
  const gitRaw = (dir, args) => new Promise((resolve) => {
    const ms = until - Date.now();
    if (ms <= 0) { resolve({ tarde: true }); return; }
    execFile('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: ms, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: gitEnv },
      (err, out) => resolve(err ? (err.killed ? { tarde: true } : { error: true }) : { out: String(out) }));
  });
  // de a POOL consultas a la vez, en el orden dado (los del arnés primero)
  const enTanda = async (lista, hacer) => {
    const res = new Array(lista.length);
    let sig = 0;
    await Promise.all(Array.from({ length: Math.min(POOL, lista.length) }, async () => {
      while (sig < lista.length) { const i = sig++; res[i] = await hacer(lista[i]); }
    }));
    return res;
  };
  const vivas = require('./session-liveness.js').liveCwds({ home, ...(isAlive ? { isAlive } : {}) });
  if (vivas.unknown) return [`no sé qué sesiones viven (${causa(vivas.unknown)}): no miro las carpetas sin commitear`];
  // la ruta real del ancestro que existe, más lo que falta: una sesión puede estar en una subcarpeta ya borrada
  const real = (p) => {
    const abs = path.resolve(p);
    for (let d = abs; ; d = path.dirname(d)) {
      try { return path.join(fs.realpathSync(d), path.relative(d, abs)); } catch { if (path.dirname(d) === d) return abs; }
    }
  };
  const dentro = (hijo, padre) => hijo === padre || hijo.startsWith(padre.endsWith(path.sep) ? padre : padre + path.sep);
  const ocupadas = vivas.cwds.map(real);
  let sinRaiz = null;
  if (!repos) {
    repos = [RAIZ, path.join(require('./state-dir.js').claudeDir(home), 'agent-skills')];
    let roots = [];
    try { roots = require(path.join(RAIZ, 'scripts', 'lib', 'repos-root.js')).resolveReposRoot(undefined, { env, home }).roots || []; } catch (e) { sinRaiz = causa(String(e.message || e).split('\n')[0]); }
    const hijos = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => path.join(d, e.name)); } catch { return []; } };
    for (const r of roots) for (const a of hijos(r)) { repos.push(a); for (const b of hijos(a)) repos.push(b); }
  }
  // sólo un repo principal (`.git` carpeta): sus worktrees salen de su lista, estén donde estén
  const principales = [...new Set(repos.filter((r) => { try { return fs.statSync(path.join(r, '.git')).isDirectory(); } catch { return false; } }).map(real))];
  let sinMirar = 0;
  const carpetas = new Map();
  for (const [i, l] of (await enTanda(principales, (r) => gitRaw(r, ['worktree', 'list', '--porcelain']))).entries()) {
    if (l.tarde) { sinMirar += 1; continue; }
    if (l.error) { items.push({ cuando: -1, texto: `${legible(principales[i])}: no pude listar sus carpetas de trabajo` }); continue; }
    for (const b of l.out.split(/\n\n+/).map((x) => x.split('\n')).slice(1)) {   // el primero es el checkout principal
      const dir = (b.find((x) => x.startsWith('worktree ')) || '').slice(9);
      if (!dir || b.some((x) => x.startsWith('prunable')) || !fs.existsSync(dir)) continue;
      const rdir = real(dir);
      if (carpetas.has(rdir) || ocupadas.some((c) => dentro(c, rdir))) continue;
      const rama = (b.find((x) => x.startsWith('branch ')) || '').replace(/^branch (refs\/heads\/)?/, '');
      carpetas.set(rdir, { dir, rama, orden: i });
    }
  }
  const lista = [...carpetas.values()];
  const estados = await enTanda(lista, (c) => gitRaw(c.dir, ['status', '--porcelain', '-z', '--untracked-files=normal']));
  const items = [];
  lista.forEach((c, k) => {
    const st = estados[k];
    if (st.tarde) { sinMirar += 1; return; }
    if (st.error) { items.push({ cuando: -1, texto: `${legible(c.dir)}: no pude ver si tiene cambios sin commitear` }); return; }
    const entradas = st.out.split('\0');
    const archivos = [];
    for (let i = 0; i < entradas.length; i += 1) {
      const e = entradas[i];
      if (!e.trim()) continue;
      archivos.push(e.slice(3));
      if (/[RC]/.test(e.slice(0, 2))) i += 1;   // un renombre o una copia traen su origen en la entrada siguiente
    }
    if (!archivos.length) return;
    const fechas = archivos.map((f) => { try { return fs.lstatSync(path.join(c.dir, f)).mtimeMs; } catch { return NaN; } }).filter(Number.isFinite);
    items.push({ cuando: fechas.length ? Math.max(...fechas) : -1, texto: `${legible(c.dir)} (${c.rama ? `rama ${legible(c.rama)}` : 'sin rama'}): ${archivos.length} archivo${archivos.length === 1 ? '' : 's'} sin commitear${fechas.length ? `, sin tocar hace ${hace(Math.max(...fechas), now)}` : ''}; ninguna sesión viva trabaja ahí` });
  });
  // lo tocado más recién primero: lo que se acaba de perder pesa más que lo que lleva semanas así
  const lines = items.sort((a, b) => b.cuando - a.cuando).slice(0, MAX_LINEAS).map((i) => i.texto);
  if (items.length > MAX_LINEAS) lines.push(`y ${items.length - MAX_LINEAS} más`);
  if (sinMirar) lines.push(`${sinMirar} sin mirar: ${SIN_TIEMPO}`);
  if (sinRaiz) lines.push(`no pude saber dónde está la raíz de repos (${sinRaiz}): sólo miré los del arnés`);
  return lines;
}

/**
 * Lo que /wip y la oficina saben de un camino corto sin salir a la red: de la foto vigente, { pedido } o { entro }; la
 * falla que la foto guardó, o la de git, como { error }; null sin foto (lo único que faltó fue preguntar) o sin pedido.
 * La rama ya en main sí se mira con git.
 */
function adhocFromPhoto(adhoc, { home = os.homedir(), stateDir, now = Date.now() } = {}) {
  const ctx = contexto({ home, stateDir, now });
  const s = adhocState(adhoc, { ...ctx, until: 0 });
  if (s && s.error && s.sinTiempo && s.error === SIN_TIEMPO) return null;
  return s ? (s.error ? { error: s.error } : s) : null;
}

module.exports = { runState, adhocState, stopLines, machine, unsavedFolders, adhocFromPhoto, hace, TOPE_MS, FOTO_MS, PREFIJO };
