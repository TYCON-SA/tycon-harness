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
const { spawnSync } = require('child_process');
const STEPS = require('./steps.js');
const { stateDir: stateDirOf } = require('./state-dir.js');
const { liveness } = require('./session-liveness.js');

const TOPE_MS = 5000;
const FOTO_MS = 10 * 60000;
const MAX_LINEAS = 5;
const RAMAS_PRINCIPALES = ['main', 'master'];
const PREFIJO = '🔔 [tycon-pipeline] ';
const RAIZ = path.join(__dirname, '..', '..', '..', '..');
const PLATFORM = path.join(RAIZ, 'scripts', 'lib', 'platform', 'platform.js');
const WIP = path.join(RAIZ, 'scripts', 'tools', 'work-in-progress.js');
const SID_SEGURO = /^[\w.-]+$/;

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
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { ausente: true } : { error: e.code || e.message }; }
  try { return { data: JSON.parse(text) }; } catch (e) { return { error: `JSON roto: ${e.message}` }; }
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
  if (topeMs <= 0) return { error: `se acabó el tope de ${TOPE_MS / 1000} s`, sinTiempo: true };
  const r = spawnSync(process.execPath, [PLATFORM, 'change-request', 'list', '--repo', JSON.stringify(w.identityOf(q)),
    '--args', JSON.stringify({ sourceBranch: rama, checks: false, deadlineMs: Date.now() + topeMs })], { encoding: 'utf8', env, timeout: topeMs, windowsHide: true });
  if (r.error) return { error: r.error.code === 'ETIMEDOUT' ? `se pasó del tope de ${TOPE_MS / 1000} s` : r.error.message };
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
  let falla = null;
  for (const repo of reposDelCarril(adhoc)) {
    if (!fs.existsSync(repo)) continue;
    const head = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const rama = head.status === 0 ? head.out : '';
    if (!rama || rama === 'HEAD' || RAMAS_PRINCIPALES.includes(rama)) continue;
    // ya entró: algo propio desde la base del carril, y la punta en origin/main
    const base = bases[repo] && bases[repo].sha;
    if (base) {
      const propio = git(repo, ['rev-list', '--count', `${base}..HEAD`]);
      if (propio.status === 0 && Number(propio.out) > 0 && git(repo, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).status === 0) return { entro: true };
    }
    const clave = `${repo}|${rama}`;
    let r = ctx.foto[clave];
    if (!r || !(ctx.now - r.at <= FOTO_MS) || r.at > ctx.now) {
      r = { at: ctx.now, ...pedirPedidos(repo, rama, { env: ctx.env, topeMs: Math.min(TOPE_MS, ctx.until - Date.now()) }) };
      // lo que no se preguntó por falta de tiempo no se guarda: el próximo lo pregunta
      if (!r.sinTiempo) { ctx.foto[clave] = r; ctx.cambio = true; }
    }
    if (r.error) { falla = falla || r.error; continue; }
    if (r.prs && r.prs.length) return { pedido: r.prs[0] };
  }
  return falla ? { error: falla } : null;
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
const motivo = (adhoc) => String((adhoc && adhoc.reason) || '(sin motivo)').replace(/\s+/g, ' ').slice(0, 80);

/**
 * Las líneas de la sesión `sid` para el cierre de turno: su ejecución terminada y su camino corto con pedido. Vacía si no
 * hay nada. `env` reemplaza el entorno de la consulta a la plataforma (las pruebas).
 */
function stopLines({ sid, home = os.homedir(), stateDir, now = Date.now(), env } = {}) {
  const ctx = contexto({ home, stateDir, now, env });
  const lines = [];
  const safe = String(sid || '_nosession').replace(/[/\\]/g, '_');
  const m = leer(path.join(ctx.sdir, 'active', `${safe}.json`));
  if (m.error) lines.push(`no pude leer la ejecución de la sesión ${sid} (${m.error})`);
  else if (m.data) { const e = runState(m.data); if (e) lines.push(lineaEjecucion(e, now)); }
  const a = leer(path.join(ctx.sdir, 'adhoc', `${safe}.json`));
  if (a.error) lines.push(`no pude leer el camino corto de la sesión ${sid} (${a.error})`);
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
  if (vida.unknown) return { vive: null, texto: `no sé si la sesión vive (${vida.unknown}): no doy comando` };
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
  const nombres = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; } };
  const vidaDe = (sid) => liveness(sid, { home, ...(isAlive ? { isAlive } : {}) });
  for (const n of nombres(path.join(ctx.sdir, 'active'))) {
    const sid = path.basename(n, '.json');
    const m = leer(path.join(ctx.sdir, 'active', n));
    if (m.error) { items.push({ sid, tipo: 'ilegible', texto: `no pude leer la ejecución de la sesión ${sid} (${m.error})` }); continue; }
    const e = m.data && runState(m.data);
    if (!e) continue;
    const quien = `story ${e.storyId} (sesión ${corto(sid)})`;
    if (e.revisar) { items.push({ sid, tipo: 'ejecucion', texto: `${quien}: cambió código después de los revisores; falta revisarlo (\`pipeline.js next\` en su sesión)` }); continue; }
    let perdida = null;
    try { perdida = require('./open-runs.js').perdida({ sid, cwd: m.data.repoPath, home }); } catch { perdida = null; }
    const segura = SID_SEGURO.test(sid) ? sid : JSON.stringify(sid);
    const cierre = perdida
      ? { texto: `su ejecución está perdida: node ${markerJs} clear-session ${segura} --lost (lo firma el dueño)` }
      : comoSeCierra(vidaDe(sid), `node ${markerJs} clear-session ${segura}`);
    items.push({ sid, tipo: 'ejecucion', texto: `${quien}: terminó${e.desde === null ? '' : ` hace ${hace(e.desde, now)}`} y sigue abierta; ${cierre.texto}` });
  }
  for (const n of nombres(path.join(ctx.sdir, 'adhoc'))) {
    const sid = path.basename(n, '.json');
    const a = leer(path.join(ctx.sdir, 'adhoc', n));
    if (a.error) { items.push({ sid, tipo: 'ilegible', texto: `no pude leer el camino corto de la sesión ${sid} (${a.error})` }); continue; }
    const s = a.data && adhocState(a.data, ctx);
    if (!s) continue;
    const quien = `camino corto «${motivo(a.data)}» (sesión ${corto(sid)})`;
    if (s.error) { items.push({ sid, tipo: 'sin-medir', texto: `${quien}: no pude ver si su pedido está abierto (${s.error})` }); continue; }
    const segura = SID_SEGURO.test(sid) ? sid : JSON.stringify(sid);
    const cierre = comoSeCierra(vidaDe(sid), `node ${markerJs} adhoc clear-orphan ${segura}`);
    items.push({ sid, tipo: 'camino-corto', texto: `${quien}: tiene ${queTiene(s)} y sigue abierto; ${cierre.texto}` });
  }
  if (ctx.cambio) escribir(ctx.fotoFile, ctx.foto);
  const lines = items.slice(0, MAX_LINEAS).map((i) => i.texto);
  if (items.length > MAX_LINEAS) lines.push(`y ${items.length - MAX_LINEAS} más`);
  return { items, lines };
}

/**
 * Lo que /wip y la oficina saben de un camino corto sin salir a la red: de la foto vigente, { pedido } o { entro }, o
 * null (sin foto, sin pedido o vieja). La rama ya en main sí se mira con git.
 */
function adhocFromPhoto(adhoc, { home = os.homedir(), stateDir, now = Date.now() } = {}) {
  const ctx = contexto({ home, stateDir, now });
  const conFoto = { ...ctx, until: 0 };
  const s = adhocState(adhoc, conFoto);
  return s && !s.error ? s : null;
}

module.exports = { runState, adhocState, stopLines, machine, adhocFromPhoto, hace, TOPE_MS, FOTO_MS, PREFIJO };
