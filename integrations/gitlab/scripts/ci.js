'use strict';
// ci.js — la CI de un repo de GitLab (`ci.read`), leída de los estados de commit de la punta: ahí informan sus
// resultados tanto los pipelines de GitLab como una CI de afuera. De cada contexto vale el más nuevo; cada uno es una
// etapa con su resultado tal como lo da GitLab. `running` si alguno no terminó, `failed` si alguno terminó mal,
// `succeeded` si todos terminaron bien y `none` sin ninguno. Un trabajo manual sin disparar y uno que GitLab deja fallar
// no cuentan en contra: el pipeline de esa punta está en verde igual. El valor no dice «desplegado»: un control verde no es un
// despliegue.
//
// La punta se resuelve primero a su commit: GitLab contesta los estados de un commit, y con el nombre de una rama
// devuelve una lista vacía sin error, que se leería como «ninguna CI».

const { glab } = require('./glab-api.js');
const { estados, repoDe, sinTerminar, terminoMal } = require('./change-requests.js');

const no = (reason, detail) => ({ ok: false, reason, detail });
// en una lectura, lo que la llamada devuelve como «rechazado» (un tope de pedidos) es una lectura que no se hizo
const comoLectura = (p) => (p.reason === 'rechazado' ? no('no_medido', p.detail) : p);

function leerCi(args, ctx) {
  const t = repoDe(ctx);
  if (t.problem) return t.problem;
  const punta = String(args.commit || args.branch || '');
  if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/.test(punta)) return no('rechazado', 'falta el commit o la rama, o no tiene forma de commit o de rama');
  const g = glab(ctx, t.host, 'GET', `${t.p}/repository/commits/${encodeURIComponent(punta)}`);
  if (g.problem) return comoLectura(g.problem);
  const sha = g.value && typeof g.value.id === 'string' ? g.value.id : '';
  // el id va en la ruta del pedido siguiente: sólo lo que puede ser un commit, nunca «.» ni «..»
  if (!/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/.test(sha)) return no('no_medido', 'GitLab no devolvió el commit de esa punta');
  const c = estados(ctx, t, sha);
  if (c.problem) return comoLectura(c.problem);
  const stages = c.value.map((x) => ({ pipeline: null, name: x.name, result: sinTerminar(x) || !x.status ? null : x.status }));
  if (!stages.length) return { ok: true, value: { state: 'none', stages } };
  const corriendo = stages.some((x) => x.result === null);
  const mal = c.value.some(terminoMal);
  return { ok: true, value: { state: corriendo ? 'running' : (mal ? 'failed' : 'succeeded'), stages } };
}

module.exports = { 'ci.read': leerCi };
