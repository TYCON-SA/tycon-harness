'use strict';
// branch-rules.js — la regla de aprobación de una rama de un repo de Azure DevOps (`branch-rules.read`): si un pedido a
// esa rama necesita que alguien lo apruebe. La organización y el proyecto salen de la identidad del repo, como en los
// pedidos de cambio (change-requests.js). Dos lecturas:
//   az repos show --repository <repo> --project <proyecto> --org <org> -o json            (el id y la rama principal)
//   az repos policy list --repository-id <id> --branch refs/heads/<rama> --project <proyecto> --org <org> -o json
// Sin `branch`, la rama principal del repo (la que dice `repos show`), no «main» a ciegas: un repo con `master` tendría
// siempre «sin regla».
// De la lista cuentan sólo las del tipo «Minimum number of reviewers», sin borrar, cuyo alcance cubre este repo y esta
// rama (el mismo criterio que scripts/tools/merge-pr.js para las de compilación). Azure DevOps exige TODAS las prendidas
// que frenan, así que con varias se juntan: el mínimo es el mayor, el voto de quien abre cuenta sólo si cuenta en todas,
// y un empuje borra las aprobaciones si alguna lo pide. Sin ninguna que frene, la que menos le falta (`approvalFaults`
// del contrato) dice qué falta. Una lista que no se pudo leer es no_medido: nunca «sin regla».

const path = require('path');
const { correrAz, orgDe } = require('./change-requests.js');

// una rama que va a la línea de comandos (sin terminal: va como un argumento): sin opciones disfrazadas (`-x`), sin `..`,
// `//`, espacios ni los caracteres que git no acepta en una ref; con letras de cualquier idioma, `+` o `@`
const RAMA = /^(?!-)(?!.*\.\.)(?!\/)(?!.*\/\/)(?!.*[/.]$)(?!.*\.lock$)[^\s~^:?*[\\\x00-\x1f\x7f]{1,200}$/u;
// una ref completa (`refs/heads/main`, como la da `repos show`) se lleva al nombre de la rama
const sinRef = (b) => (typeof b === 'string' ? b.replace(/^refs\/heads\//, '') : b);

const no = (reason, detail) => ({ ok: false, reason, detail });
// La política de aprobación mínima, por el nombre de su tipo. Sin nombre, por su forma: trae `minimumApproverCount` y no
// trae lo de la de revisores obligatorios (`requiredReviewerIds`, `filenamePatterns`), que también lleva un mínimo.
const esDeRevisores = (p) => {
  const t = (p && p.type) || {};
  const s = (p && p.settings) || {};
  if (t.displayName) return /^minimum number of reviewers$/i.test(String(t.displayName));
  return typeof s.minimumApproverCount === 'number' && s.requiredReviewerIds === undefined && s.filenamePatterns === undefined;
};

/** Las reglas que se exigen juntas, como una sola: lo que Azure DevOps pide a un pedido para entrar. */
function juntar(reglas) {
  return { blocking: true, enabled: true, minimum: Math.max(...reglas.map((x) => x.minimum || 0)),
    creatorVoteCounts: reglas.every((x) => x.creatorVoteCounts), resetOnSourcePush: reglas.some((x) => x.resetOnSourcePush) };
}

/** Si el alcance de la política cubre este repo y esta rama. */
function cubre(p, repoId, ref, principal) {
  const alcance = p && p.settings && Array.isArray(p.settings.scope) ? p.settings.scope : [];
  return alcance.some((sc) => {
    if (!sc || (sc.repositoryId !== undefined && sc.repositoryId !== null && sc.repositoryId !== repoId)) return false;
    const tipo = String(sc.matchKind || '').toLowerCase();
    if (tipo === 'exact') return String(sc.refName || '') === ref;
    if (tipo === 'prefix') return Boolean(sc.refName) && ref.startsWith(String(sc.refName));
    if (tipo === 'defaultbranch') return Boolean(principal) && ref === principal;
    return false;
  });
}

const aRegla = (p) => {
  const s = p.settings || {};
  return { blocking: p.isBlocking === true, enabled: p.isEnabled === true, minimum: Number.isInteger(s.minimumApproverCount) ? s.minimumApproverCount : null,
    creatorVoteCounts: s.creatorVoteCounts === true, resetOnSourcePush: s.resetOnSourcePush === true };
};

function leerReglas(args, ctx) {
  const repo = ctx.repo || {};
  const o = orgDe(repo);
  if (o.problem) return o.problem;
  const pedida = sinRef(args.branch);
  if (pedida !== undefined && pedida !== null && !(typeof pedida === 'string' && RAMA.test(pedida))) {
    return no('rechazado', `branch tiene que ser el nombre de una rama (es ${JSON.stringify(args.branch)})`);
  }
  const timeout = () => (Number.isFinite(args.deadlineMs) ? args.deadlineMs - Date.now() : 120000);
  if (timeout() <= 0) return no('no_medido', 'tope: se acabó el tiempo antes de leer la regla');
  const comun = ['--project', repo.project, '--org', o.value, '-o', 'json'];
  const r = correrAz(ctx, ['repos', 'show', '--repository', repo.repo, ...comun], { timeout: timeout() });
  if (r.problem) return r.problem;
  if (!r.value || typeof r.value.id !== 'string' || !r.value.id) return no('no_medido', 'Azure DevOps no dijo el id del repo');
  const principal = typeof r.value.defaultBranch === 'string' ? r.value.defaultBranch : null;
  const rama = pedida || (principal ? sinRef(principal) : null);
  if (!rama || !RAMA.test(rama)) return no('no_medido', 'el repo no dice cuál es su rama principal: nombrala (branch)');
  if (timeout() <= 0) return no('no_medido', 'tope: se acabó el tiempo antes de leer la regla');
  const ref = `refs/heads/${rama}`;
  const l = correrAz(ctx, ['repos', 'policy', 'list', '--repository-id', r.value.id, '--branch', ref, ...comun], { timeout: timeout() });
  if (l.problem) return l.problem;
  if (!Array.isArray(l.value)) return no('no_medido', 'la lista de políticas de la rama no es una lista');
  const { approvalFaults } = require(path.join(ctx.root, 'scripts', 'lib', 'platform', 'contract.js'));
  const reglas = l.value.filter((p) => p && p.isDeleted !== true && esDeRevisores(p) && cubre(p, r.value.id, ref, principal)).map(aRegla);
  const exigidas = reglas.filter((x) => x.enabled && x.blocking);
  // sin ninguna exigida, la que menos le falta; con empate, la de mayor mínimo y después la primera de la lista
  const mejor = () => reglas.map((x, i) => ({ x, i, f: approvalFaults(x).length }))
    .sort((a, b) => a.f - b.f || (b.x.minimum || 0) - (a.x.minimum || 0) || a.i - b.i)[0];
  const approval = exigidas.length ? juntar(exigidas) : (reglas.length ? mejor().x : null);
  return { ok: true, value: { branch: rama, approval } };
}

module.exports = { 'branch-rules.read': leerReglas };
