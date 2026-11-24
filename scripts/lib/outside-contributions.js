'use strict';
/**
 * outside-contributions.js — los pedidos y los issues abiertos de gente de afuera del equipo en el repo público. Un pedido
 * desde un fork no corre su CI hasta que alguien del equipo la aprueba, y un issue de afuera no le llega a nadie: si el
 * aviso depende de que alguien mire GitHub, el de afuera espera días.
 *
 * QUIÉN ES DE AFUERA lo decide la misma regla que el freno de pedidos de afuera (scripts/lib/external-pr.js,
 * `cuentasDelEquipo`): la lista `pull_requests.team_authors` del perfil, o sin lista la cuenta con que está autenticado el
 * CLI. Un bot es de afuera salvo que esté en la lista.
 *
 * QUÉ MIRA, sólo lecturas y con el CLI de GitHub (`TYCON_GH_CMD`, por defecto `gh`): los pedidos abiertos, los issues
 * abiertos (sin los pedidos, que la API también lista como issues) y las corridas de CI que esperan aprobación, para decir
 * de qué pedido son (por la punta de su rama). Hasta 100 de cada uno: más que eso se dice «100 o más».
 *
 * 🔴 NO MEDIDO NO ES CERO: sin red, sin sesión del CLI, una respuesta ilegible o sin saber quién es del equipo, la
 * medición dice «no medido» con el motivo. Nunca «ninguno» sin haber mirado.
 *
 * Lo que viene de GitHub (el autor) se sanea antes de imprimirlo: en una línea, sin `##` (lo leería un pipeline como una
 * orden) y sin invisibles ni `<>`.
 *
 * USO
 *   require('./outside-contributions.js').measure({ repo: 'org/nombre', home, env, arnes, cwd, run, now })
 *     → { ok: true, prs: [{ number, author, hours, draft, ciWaiting }], issues: [{ number, author, hours }], capped }
 *     | { ok: false, reason }
 *   require('./outside-contributions.js').lines(medicion, { max }) → [renglón…]   (vacío si no hay nada de afuera)
 *   require('./outside-contributions.js').summaryLine(medicion, { max }) → «De afuera: …», un solo renglón para el resumen
 *     diario: sólo números, cuentas con forma de cuenta de GitHub (la que no la tiene sale «?») y edades; el motivo de un
 *     «no medido» no va (puede nombrar una dirección).
 */
const { spawnSync } = require('child_process');

const POR_PAGINA = 100;
const TIEMPO_MS = 15000;
const HORA_MS = 3600000;

const limpio = (t, n = 60) => String(t || '').replace(/#{2,}/g, '#').replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}<>]/gu, '').trim().slice(0, n) || '?';

/** Una llamada al CLI que devuelve JSON: `{ valor }` o `{ error }`. */
function ghJson(args, { cwd, env, run }) {
  const cmd = (env && env.TYCON_GH_CMD) || 'gh';
  const r = run(cmd, args, { cwd, encoding: 'utf8', timeout: TIEMPO_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
  if (!r || r.error || r.status !== 0) {
    const porque = !r ? 'no contestó' : r.error ? (r.error.code === 'ETIMEDOUT' ? 'no contestó a tiempo' : r.error.code || r.error.message)
      : String(r.stderr || '').trim().split('\n')[0] || `salió ${r.status}`;
    return { error: limpio(porque, 160) };
  }
  try { return { valor: JSON.parse(r.stdout) }; } catch { return { error: 'GitHub contestó algo que no se lee' }; }
}

const horasDesde = (fecha, now) => { const t = Date.parse(fecha); return Number.isFinite(t) ? Math.max(0, (now - t) / HORA_MS) : null; };

/** Lo que dice GitHub de los pedidos y los issues de afuera del repo `org/nombre`. */
function measure({ repo, home, env = process.env, arnes, cwd, run = spawnSync, now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))) return { ok: false, reason: `«${limpio(repo)}» no es un repo de GitHub (org/nombre)` };
  // la regla del freno, con el mismo CLI que el resto de la medición
  const viaGh = (cmd, args, o) => run(cmd === 'gh' ? ((env && env.TYCON_GH_CMD) || 'gh') : cmd, args, { ...o, windowsHide: true });
  const ext = require('./external-pr.js');
  const eq = ext.cuentasDelEquipo({ home, env, arnes, cwd, run: viaGh });
  if (eq.error) return { ok: false, reason: `${eq.error}: no sé quién es del equipo` };
  const delEquipo = (login) => eq.cuentas.includes(ext.cuentaComparable(login));
  const autorDe = (u) => (u && typeof u.login === 'string' ? (u.type === 'Bot' && !u.login.startsWith('app/') ? `app/${u.login.replace(/\[bot\]$/, '')}` : u.login) : null);

  const o = { cwd, env, run };
  const pulls = ghJson(['api', `repos/${repo}/pulls?state=open&per_page=${POR_PAGINA}`], o);
  if (pulls.error) return { ok: false, reason: `los pedidos: ${pulls.error}` };
  const issues = ghJson(['api', `repos/${repo}/issues?state=open&per_page=${POR_PAGINA}`], o);
  if (issues.error) return { ok: false, reason: `los issues: ${issues.error}` };
  const corridas = ghJson(['api', `repos/${repo}/actions/runs?status=action_required&per_page=${POR_PAGINA}`], o);
  if (corridas.error) return { ok: false, reason: `la CI que espera aprobación: ${corridas.error}` };
  if (!Array.isArray(pulls.valor) || !Array.isArray(issues.valor) || !corridas.valor || !Array.isArray(corridas.valor.workflow_runs)) {
    return { ok: false, reason: 'GitHub contestó algo que no se lee' };
  }

  const esperan = new Set(corridas.valor.workflow_runs.map((c) => c && c.head_sha).filter(Boolean));
  const prs = [];
  for (const p of pulls.valor) {
    const autor = autorDe(p && p.user);
    if (!autor || !Number.isInteger(p.number)) return { ok: false, reason: 'GitHub no dijo de quién es un pedido' };
    if (delEquipo(autor)) continue;
    prs.push({ number: p.number, author: autor, hours: horasDesde(p.created_at, now), draft: p.draft === true, ciWaiting: Boolean(p.head && esperan.has(p.head.sha)) });
  }
  const sueltos = [];
  for (const i of issues.valor) {
    if (i && i.pull_request) continue;
    const autor = autorDe(i && i.user);
    if (!autor || !Number.isInteger(i.number)) return { ok: false, reason: 'GitHub no dijo de quién es un issue' };
    if (delEquipo(autor)) continue;
    sueltos.push({ number: i.number, author: autor, hours: horasDesde(i.created_at, now) });
  }
  const masViejo = (a, b) => (b.hours ?? -1) - (a.hours ?? -1) || a.number - b.number;
  return { ok: true, prs: prs.sort(masViejo), issues: sueltos.sort(masViejo),
    capped: pulls.valor.length >= POR_PAGINA || issues.valor.length >= POR_PAGINA };
}

/** «hace 40 min», «hace 5 h» o «hace 3 días»; sin fecha legible, «sin fecha». */
function haceDe(horas) {
  if (horas === null || horas === undefined) return 'sin fecha';
  if (horas < 1) return `hace ${Math.floor(horas * 60)} min`;
  if (horas < 48) return `hace ${Math.floor(horas)} h`;
  return `hace ${Math.floor(horas / 24)} días`;
}

/** Los renglones del aviso: uno por pedido o issue de afuera, los más viejos primero, hasta `max`. */
function lines(m, { max = 5 } = {}) {
  if (!m || !m.ok) return [`pedidos e issues de afuera: no medido (${limpio(m && m.reason, 200)})`];
  const todos = [
    ...m.prs.map((p) => ({ h: p.hours, t: `pedido de afuera esperando: #${p.number} de ${limpio(p.author)}, ${haceDe(p.hours)}${p.draft ? ' (borrador)' : ''}${p.ciWaiting ? '; su CI espera aprobación' : ''}` })),
    ...m.issues.map((i) => ({ h: i.hours, t: `issue de afuera abierto: #${i.number} de ${limpio(i.author)}, ${haceDe(i.hours)}` })),
  ].sort((a, b) => (b.h ?? -1) - (a.h ?? -1));
  const out = todos.slice(0, max).map((x) => x.t);
  if (todos.length > max) out.push(`(+${todos.length - max} más de afuera)`);
  if (m.capped) out.push('(se leyeron los primeros 100: puede haber más de afuera)');
  return out;
}

// una cuenta de GitHub, o la de un bot como `app/<nombre>`: lo único del autor que pasa al resumen diario
const CUENTA = /^(app\/)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const cuentaSegura = (a) => (CUENTA.test(String(a || '')) ? a : '?');

/** El renglón del resumen diario. */
function summaryLine(m, { max = 5 } = {}) {
  if (!m || !m.ok) return 'De afuera: ? (no medido)';
  const todos = [
    ...m.prs.map((p) => ({ h: p.hours, t: `pedido #${p.number} de ${cuentaSegura(p.author)} ${haceDe(p.hours)}${p.draft ? ' (borrador)' : ''}${p.ciWaiting ? ' (CI espera aprobación)' : ''}` })),
    ...m.issues.map((i) => ({ h: i.hours, t: `issue #${i.number} de ${cuentaSegura(i.author)} ${haceDe(i.hours)}` })),
  ].sort((a, b) => (b.h ?? -1) - (a.h ?? -1));
  if (!todos.length) return m.capped ? 'De afuera: ? (no medido)' : 'De afuera: ninguno';
  const items = todos.slice(0, max).map((x) => x.t);
  if (todos.length > max || m.capped) items.push(`+${todos.length - Math.min(max, todos.length)}${m.capped ? ' o más' : ''} más`);
  return `De afuera: ${items.join(' · ')}`;
}

module.exports = { measure, lines, summaryLine, haceDe };
