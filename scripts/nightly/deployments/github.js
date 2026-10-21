'use strict';
/**
 * github.js — el segundo proveedor de la foto de despliegues: la API de deployments y
 * environments de GitHub. Un environment de GitHub es un stage de despliegue.
 *
 * Campos que se leen (documentación oficial de la API REST de GitHub, confirmada):
 *   GET repos/{o}/{r}/environments/{env}                     → existe (200) o no (404)
 *   GET repos/{o}/{r}/deployments?environment=&per_page=     → id, sha, created_at
 *   GET repos/{o}/{r}/deployments/{id}/statuses?per_page=    → id, state, created_at
 *   GET repos/{o}/{r}/actions/runs?status=waiting            → id, run_number, created_at
 *   GET repos/{o}/{r}/actions/runs/{id}/pending_deployments  → environment.name
 *   GET repos/{o}/{r}                                        → default_branch
 *   GET repos/{o}/{r}/actions/workflows/{wf}/runs?branch=    → status, conclusion, created_at, run_number
 * La API no documenta el orden de deployments ni de statuses: el guion ordena por created_at y, a igual fecha, por id.
 *
 * El criterio: cuenta como despliegue SÓLO el deployment cuyo ÚLTIMO estado es `success`. Cero deployments en un
 * environment que existe es «sin despliegue en la ventana», no «no medido». La aprobación: `pendiente` si una corrida en
 * `waiting` tiene un despliegue pendiente para el environment; «vencida» no se distingue de «cancelada» en GitHub y sale
 * no medida con su motivo. «Main»: la última corrida terminada del workflow en la rama por defecto, con la
 * tabla de conclusiones.
 *
 * Verificación en real limitada: ninguna organización que usa el arnés despliega hoy con GitHub Actions.
 * Habla por `gh api` (TYCON_GH_CMD lo reemplaza: un ejecutable, o un `.js` que corre con node). Fallas: lanza
 * `{ noMedido: true, motivo, detalle }`; 401/403 → `sin_permiso`, otra → `gh_fallo`, algo que no es JSON →
 * `respuesta_no_json`, sin tiempo → `presupuesto_agotado`.
 */
const { spawnSync } = require('child_process');

const noMedido = (motivo, detalle = '') => ({ noMedido: true, motivo, detalle: String(detalle || '') });
const fecha = (s) => { const t = Date.parse(s || ''); return Number.isNaN(t) ? 0 : t; };
const masNuevoPrimero = (a, b) => fecha(b.created_at) - fecha(a.created_at) || Number(b.id) - Number(a.id);
const MAIN = { success: 'verde', failure: 'roto', timed_out: 'roto', startup_failure: 'roto', neutral: 'con_avisos' };

function crear({ cmd = process.env.TYCON_GH_CMD || 'gh', deadline, ventana = 30 }) {
  function gh(ruta, { tolera404 = false } = {}) {
    if (Date.now() >= deadline) throw noMedido('presupuesto_agotado', 'se agotó el tiempo de la noche antes de consultar');
    const [bin, pre] = /\.js$/.test(cmd) ? [process.execPath, [cmd]] : [cmd, []];
    const r = spawnSync(bin, [...pre, 'api', '-H', 'Accept: application/vnd.github+json', ruta], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: Math.max(1000, Math.min(120000, deadline - Date.now())), env: process.env,
    });
    if (r.error) throw noMedido('gh_fallo', `${cmd} no se pudo ejecutar (${r.error.code || r.error.message})`);
    if (r.status !== 0) {
      const t = `${r.stderr || ''} ${r.stdout || ''}`;
      if (tolera404 && /HTTP 404/.test(t)) return null;
      throw noMedido(/HTTP (401|403)/.test(t) ? 'sin_permiso' : 'gh_fallo', t);
    }
    try { return JSON.parse(r.stdout); } catch { throw noMedido('respuesta_no_json', r.stdout); }
  }
  const lista = (v, clave) => {
    const l = clave ? v && v[clave] : v;
    if (!Array.isArray(l)) throw noMedido('respuesta_no_json', 'la respuesta no trae la lista esperada');
    return l.filter(Boolean);
  };

  function ultimoDespliegue(repo, env) {
    const deps = lista(gh(`repos/${repo}/deployments?environment=${encodeURIComponent(env)}&per_page=${ventana}`)).sort(masNuevoPrimero).slice(0, ventana);
    for (const d of deps) {
      const est = lista(gh(`repos/${repo}/deployments/${d.id}/statuses?per_page=100`)).sort(masNuevoPrimero)[0];
      if (est && est.state === 'success') {
        return { fecha: est.created_at, corrida: String(d.id), commit: String(d.sha || '').slice(0, 7) || null, commit_fuente: 'sha', con_avisos: false, constancia_humo: null, confiable: true };
      }
    }
    return null;
  }

  function aprobacion(repo, env) {
    const runs = lista(gh(`repos/${repo}/actions/runs?status=waiting&per_page=${ventana}`), 'workflow_runs').sort(masNuevoPrimero);
    for (const run of runs) {
      const pend = lista(gh(`repos/${repo}/actions/runs/${run.id}/pending_deployments`));
      // GitHub no distingue mayúsculas en el nombre de un environment
      if (pend.some((p) => p && p.environment && String(p.environment.name).toLowerCase() === String(env).toLowerCase())) {
        return { estado: 'pendiente', desde: run.created_at || null, corrida: String(run.run_number), vencida: 'no_medido', motivo: 'github_no_distingue_vencida' };
      }
    }
    return { estado: 'ninguna', vencida: 'no_medido', motivo: 'github_no_distingue_vencida' };
  }

  function main(repo, workflow) {
    const info = gh(`repos/${repo}`);
    const rama = info && info.default_branch;
    if (!rama) throw noMedido('respuesta_no_json', 'el repo no trae su rama por defecto');
    const runs = lista(gh(`repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(rama)}&status=completed&per_page=${ventana}`), 'workflow_runs').sort(masNuevoPrimero);
    const t = runs.find((r) => MAIN[r.conclusion]);
    return t ? MAIN[t.conclusion] : 'sin_corridas';
  }

  function leer(entrada, entorno) {
    const { environment } = entrada;
    // cada segmento codificado, y nunca uno hecho sólo de puntos: la ruta no puede salirse de repos/<dueño>/<repo>
    const partes = String(entrada.repo || '').split('/');
    if (partes.length !== 2 || partes.some((p) => !p || /^\.+$/.test(p))) throw noMedido('environment_no_existe', 'el repo no tiene la forma dueño/repo');
    const repo = partes.map(encodeURIComponent).join('/');
    if (gh(`repos/${repo}/environments/${encodeURIComponent(environment)}`, { tolera404: true }) === null) {
      throw noMedido('environment_no_existe', 'el environment no existe en el repo');
    }
    const r = { ultimo: ultimoDespliegue(repo, environment), ventana };
    if (entorno === 'production') r.aprobacion = aprobacion(repo, environment);
    if (entorno === 'staging') r.main = entrada.workflow ? main(repo, entrada.workflow) : null;
    return r;
  }

  return { leer };
}

module.exports = { crear };
