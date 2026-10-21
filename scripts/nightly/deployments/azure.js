'use strict';
/**
 * azure.js — el lector de despliegues de Azure DevOps de la foto de despliegues. Lo usa deployments.js;
 * la serie histórica lo reusa en vez de escribir otro.
 *
 * EL CRITERIO (regla ADO 6 del equipo): una corrida cuenta como despliegue a un entorno SI Y SÓLO
 * SI su timeline tiene un registro `type: "Stage"` cuyo `identifier` es EXACTAMENTE uno de los declarados (sin distinguir
 * mayúsculas) y su `result` es `succeeded` o `succeededWithIssues` (éste con `con_avisos`). El nombre visible del stage
 * no se mira nunca, ni se busca un pedazo de texto: buscar «PROD» encuentra NONPROD y PREPROD y pierde Production. Ni el
 * resultado global de la corrida ni sus etiquetas deciden: una aprobación vencida deja la corrida `succeeded`.
 *
 * Ningún nombre de stage, pipeline, proyecto ni organización vive acá: todo llega de la configuración (operations.json →
 * deployments) y de `--org`.
 *
 * Por entrada `{ pipeline: "<proyecto>/<nombre exacto>", stages: [...] }`:
 *   1. el id de la definición con `az pipelines list --name` (busca por PREFIJO): se queda con la de nombre igual;
 *      cero → `pipeline_no_encontrado`, más de una → `pipeline_ambiguo`;
 *   2. hasta `ventana` corridas (`az pipelines runs list --top`, sin filtrar por estado: las en curso dicen «pendiente»),
 *      ordenadas por el guion (cola, después id), de la más nueva a la más vieja;
 *   3. el timeline de cada una hasta la primera que cuenta: el corte acota el costo;
 *   4. en producción, la aprobación sale de los timelines ya leídos de las corridas posteriores al último despliegue;
 *   5. en staging, «main» sale de la última corrida TERMINADA de refs/heads/main sin contar las canceladas.
 * El commit de una promoción a mano: si `triggerInfo.pipelineId` nombra la corrida de CI promovida, el
 * commit sale de ella (`commit_fuente: "recurso"`, una llamada más); si no y la corrida se encoló a mano, el commit de
 * `sourceVersion` no es confiable.
 *
 * Lista blanca: de cada registro del timeline se leen sólo type, identifier, state, result y fechas.
 *
 * Fallas: se lanza `{ noMedido: true, motivo, detalle }` con el texto crudo; deployments.js lo sanea. 401/403/TF400813/
 * «not authorized» → `sin_permiso`; otra salida ≠ 0 → `az_fallo`; algo que no es JSON → `respuesta_no_json`; sin tiempo
 * → `presupuesto_agotado`. Siempre `--org` y `-o json`, por TYCON_ADO_CMD (como open-prs.js), con maxBuffer de 64 MB.
 */
const { spawnSync } = require('child_process');

const CUENTA = new Set(['succeeded', 'succeededwithissues']);
const MAIN = 'refs/heads/main';

const noMedido = (motivo, detalle = '') => ({ noMedido: true, motivo, detalle: String(detalle || '') });
// El número de compilación es texto que arma el `name:` del pipeline (puede llevar quién la pidió): a la foto, que viaja
// por git, va sólo si tiene forma de número de compilación; si no, null.
const numero = (run) => (/^[\w.-]{1,40}$/.test(String(run.buildNumber || '')) ? String(run.buildNumber) : null);
const fecha = (s) => { const t = Date.parse(s || ''); return Number.isNaN(t) ? 0 : t; };

function crear({ cmd = process.env.TYCON_ADO_CMD || 'az', org, deadline, ventana = 30 }) {
  function az(args, { vacio } = {}) {
    if (Date.now() >= deadline) throw noMedido('presupuesto_agotado', 'se agotó el tiempo de la noche antes de consultar');
    const r = spawnSync(cmd, [...args, '--org', org, '-o', 'json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: Math.max(1000, Math.min(120000, deadline - Date.now())), env: process.env,
    });
    if (r.error) throw noMedido('az_fallo', `${cmd} no se pudo ejecutar (${r.error.code || r.error.message})`);
    if (r.status !== 0) {
      const t = `${r.stderr || ''} ${r.stdout || ''}`;
      throw noMedido(/\b(401|403)\b|TF400813|not authorized|unauthorized|forbidden/i.test(t) ? 'sin_permiso' : 'az_fallo', t);
    }
    // el timeline de una corrida cancelada antes de correr nada vuelve VACÍO con salida 0 (la API
    // contesta sin cuerpo). Sólo donde el que llama lo dice (`vacio`) eso es «sin registros»; en cualquier otro pedido,
    // una salida vacía sigue siendo «no JSON»
    if (vacio !== undefined && String(r.stdout || '').trim() === '') return vacio;
    try { return JSON.parse(r.stdout); } catch { throw noMedido('respuesta_no_json', r.stdout); }
  }

  function definicion(entrada) {
    const s = String(entrada.pipeline);
    const i = s.indexOf('/');
    const proyecto = s.slice(0, i), nombre = s.slice(i + 1);
    const lista = az(['pipelines', 'list', '--name', nombre, '--project', proyecto]);
    if (!Array.isArray(lista)) throw noMedido('respuesta_no_json', 'la lista de pipelines no es una lista');
    const iguales = lista.filter((d) => d && String(d.name).toLowerCase() === nombre.toLowerCase());
    if (iguales.length === 0) throw noMedido('pipeline_no_encontrado', `ninguna definición se llama exactamente así en ${proyecto}`);
    if (iguales.length > 1) throw noMedido('pipeline_ambiguo', `${iguales.length} definiciones con el mismo nombre en ${proyecto}`);
    return { proyecto, id: iguales[0].id };
  }

  function corridas({ proyecto, id }) {
    const l = az(['pipelines', 'runs', 'list', '--pipeline-ids', String(id), '--project', proyecto, '--top', String(ventana)]);
    if (!Array.isArray(l)) throw noMedido('respuesta_no_json', 'la lista de corridas no es una lista');
    return l.filter(Boolean)
      .sort((a, b) => fecha(b.queueTime) - fecha(a.queueTime) || Number(b.id) - Number(a.id))
      .slice(0, ventana);
  }

  /** Sólo los campos de la lista blanca de cada registro. */
  function timeline(proyecto, run) {
    const t = az(['devops', 'invoke', '--area', 'build', '--resource', 'timeline', '--route-parameters', `project=${proyecto}`, `buildId=${run.id}`, '--api-version', '7.1'], { vacio: { records: [] } });
    if (!t || typeof t !== 'object') throw noMedido('respuesta_no_json', 'el timeline no es un objeto');
    return (Array.isArray(t.records) ? t.records : []).filter(Boolean).map((r) => ({
      // id y parentId sólo para saber de qué stage es cada aprobación: no salen a la foto
      id: r.id, parentId: r.parentId,
      type: r.type, identifier: r.identifier, state: r.state, result: r.result, startTime: r.startTime, finishTime: r.finishTime,
    }));
  }

  function despliegueEn(registros, stages) {
    const declarados = stages.map((s) => String(s).toLowerCase());
    let mejor = null;
    for (const r of registros) {
      if (r.type !== 'Stage' || r.state !== 'completed') continue;
      if (!declarados.includes(String(r.identifier || '').toLowerCase())) continue;
      if (!CUENTA.has(String(r.result || '').toLowerCase())) continue;
      if (!mejor || fecha(r.finishTime) > fecha(mejor.finishTime)) mejor = r;
    }
    return mejor;
  }

  function commitDe(proyecto, run) {
    const recurso = run.triggerInfo && run.triggerInfo.pipelineId;
    let leido = true;
    if (recurso) {
      try {
        const ci = az(['pipelines', 'runs', 'show', '--id', String(recurso), '--project', proyecto]);
        if (ci && ci.sourceVersion) return { commit: String(ci.sourceVersion).slice(0, 7), commit_fuente: 'recurso', confiable: true };
      } catch (e) {
        // el despliegue se leyó: si no se puede leer la corrida promovida, el commit deja de ser confiable, nada más
        if (e && e.motivo === 'presupuesto_agotado') throw e;
        leido = false;
      }
    }
    return {
      commit: String(run.sourceVersion || '').slice(0, 7) || null, commit_fuente: 'sourceVersion', confiable: leido && run.reason !== 'manual',
      motivo: leido ? 'promocion_manual_sin_commit' : 'commit_no_leido',
    };
  }

  /** ¿La aprobación es de uno de los stages declarados? Sube por parentId hasta el Stage. Sin cadena legible, sí. */
  function deLosStages(r, registros, stages) {
    const porId = new Map(registros.filter((x) => x.id).map((x) => [x.id, x]));
    const declarados = stages.map((s) => String(s).toLowerCase());
    let x = r;
    for (let i = 0; i < 10 && x && x.parentId; i++) {
      x = porId.get(x.parentId);
      if (x && x.type === 'Stage') return declarados.includes(String(x.identifier || '').toLowerCase());
    }
    return true;
  }

  function constancia(run) {
    const tags = Array.isArray(run.tags) ? run.tags : [];
    if (tags.includes('desplegado')) return true;
    if (tags.includes('despliegue-intentado')) return false;
    return null;
  }

  /**
   * `posteriores`: las corridas más nuevas que el último despliegue (vencidas y no aprobadas salen de ellas).
   * `enCurso`: TODA corrida sin terminar de la ventana, aunque sea más vieja que el despliegue (una puede esperar
   * aprobación mientras otra más nueva ya desplegó). Sólo cuentan las aprobaciones de los stages declarados.
   * `_fecha` (interna) deja a deployments.js elegir la corrida más nueva entre varios pipelines.
   */
  function aprobacion(posteriores, enCurso, stages) {
    let pendiente = null, noAprobada = null;
    const vencidas = [];
    const mias = (registros) => registros.filter((x) => x.type === 'Checkpoint.Approval' && deLosStages(x, registros, stages));
    for (const { run, registros } of enCurso) {
      for (const r of mias(registros)) {
        if (r.state === 'inProgress' && !pendiente) pendiente = { estado: 'pendiente', desde: r.startTime || null, corrida: numero(run), _fecha: fecha(r.startTime) };
      }
    }
    for (const { run, registros } of posteriores) {
      for (const r of mias(registros)) {
        if (r.state !== 'completed') continue;
        if (r.result === 'skipped') { if (!vencidas.includes(run)) vencidas.push(run); }
        else if (r.result && r.result !== 'succeeded' && !noAprobada) noAprobada = { estado: 'no_aprobada', resultado: /^[A-Za-z]{1,30}$/.test(String(r.result)) ? String(r.result) : 'otro', corrida: numero(run), _fecha: fecha(r.finishTime) };
      }
    }
    if (pendiente) return pendiente;
    if (vencidas.length) return { estado: 'vencida', cuantas: vencidas.length, corrida: numero(vencidas[0]), _fecha: fecha(vencidas[0].queueTime) };
    return noAprobada || { estado: 'ninguna' };
  }

  function main(runs) {
    const t = runs.find((r) => r.sourceBranch === MAIN && r.status === 'completed' && r.result !== 'canceled');
    if (!t) return 'sin_corridas';
    // un resultado que no es de la lista no se inventa: null, y el producto lo muestra «no medido»
    return { failed: 'roto', partiallySucceeded: 'con_avisos', succeeded: 'verde' }[t.result] || null;
  }

  /** Lo que la foto necesita de una entrada declarada. Lanza `noMedido`. */
  function leer(entrada, entorno) {
    const def = definicion(entrada);
    const runs = corridas(def);
    const leidas = [];
    const yaLeidas = new Map();
    let ultimo = null;
    for (const run of runs) {
      const registros = timeline(def.proyecto, run);
      yaLeidas.set(run.id, registros);
      const st = despliegueEn(registros, entrada.stages || []);
      if (st) {
        const c = commitDe(def.proyecto, run);
        ultimo = {
          fecha: st.finishTime, corrida: numero(run), commit: c.commit, commit_fuente: c.commit_fuente,
          con_avisos: String(st.result).toLowerCase() === 'succeededwithissues', constancia_humo: constancia(run), confiable: c.confiable, motivo_commit: c.motivo,
        };
        break;
      }
      leidas.push({ run, registros });
    }
    const r = { ultimo, ventana };
    if (entorno === 'production') {
      // las corridas sin terminar más viejas que el despliegue no se leyeron en el recorrido: se leen ahora (son pocas)
      const enCurso = runs.filter((x) => x.status !== 'completed')
        .map((x) => ({ run: x, registros: yaLeidas.has(x.id) ? yaLeidas.get(x.id) : timeline(def.proyecto, x) }));
      r.aprobacion = aprobacion(leidas, enCurso, entrada.stages || []);
    }
    if (entorno === 'staging') r.main = main(runs);
    return r;
  }

  return { leer };
}

module.exports = { crear, CUENTA };
