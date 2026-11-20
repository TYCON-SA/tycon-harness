#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * branch-approval.js — si un pedido a la rama principal de un repo necesita que alguien lo apruebe.
 *
 * POR QUÉ EXISTE. Los pedidos a main se abren para entrar solos en cuanto su control da verde (el freno de auto-complete
 * lo exige). Si la rama no tiene una regla de aprobación mínima, «entrar solo» quiere decir «entrar sin que nadie lo
 * apruebe». El alta de un producto la crea; este comando la relee al terminar, y `harness.js doctor --fetch` lo corre
 * sobre los repos que declara la organización.
 *
 * QUÉ ES UNA REGLA QUE SIRVE (`approvalFaults` de scripts/lib/platform/contract.js): prendida, que frena el pedido, que
 * pide al menos una aprobación, que cuenta el voto de quien lo abrió (las sesiones abren los pedidos con el usuario del
 * dev) y que borra las aprobaciones con cada empuje nuevo. Pregunta por la capa de plataforma (`branch-rules.read`): la
 * plataforma del repo la decide team-repos.json, o `--platform`.
 *
 * USO
 *   node scripts/tools/branch-approval.js check --repo <org/repo | org/proyecto/repo | JSON de la identidad>
 *        [--platform <la de team-repos.json>] [--branch <rama>] [--json]
 *     Sin --branch, la rama principal del repo. Sale 0 si la regla sirve, 1 si falta o no sirve (dice qué le falta) y 2
 *     si no se pudo medir (no medido no es verde) o si se usó mal.
 *   node scripts/tools/branch-approval.js check-declared [--json] [--budget-ms <n>]
 *     Los repos de `merge_suites.repos` de team-repos.json, uno por uno, con un tope por repo y uno total (120 s): un
 *     renglón por repo. Sale 0 si todos sirven, 1 si alguno falta y 2 si alguno no se pudo medir (o no hay lista).
 *
 * Casos: scripts/tests/branch-approval.test.js.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const P = () => require(path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'));
const { approvalFaults } = require(path.join(ROOT, 'scripts', 'lib', 'platform', 'contract.js'));
const TEAM_REPOS = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));

const POR_REPO_MS = 30000;
const TOTAL_MS = 120000;

/** La identidad que llega en `--repo`: un JSON, `org/repo` u `org/proyecto/repo`; null si no se lee. */
function identidadDe(texto, plataforma) {
  const s = String(texto || '').trim();
  let r = null;
  if (s.startsWith('{')) { try { r = JSON.parse(s); } catch (_) { return null; } }
  else {
    const p = s.split('/');
    if (p.length === 2 && p.every(Boolean)) r = { org: p[0], repo: p[1] };
    else if (p.length === 3 && p.every(Boolean)) r = { org: p[0], project: p[1], repo: p[2] };
  }
  if (!r || typeof r !== 'object' || !r.org || !r.repo) return null;
  if (plataforma) r = { ...r, platform: plataforma };
  return r;
}

/** La identidad completa de team-repos.json para el mismo org y repo (trae su plataforma y su proyecto), o la de entrada. */
function completar(r, env) {
  if (r.platform && r.project) return r;
  const tree = path.resolve(env.TYCON_TREE || ROOT);
  let data = null;
  try { data = TEAM_REPOS.parse(fs.readFileSync(path.join(tree, 'team-repos.json'), 'utf8').replace(/^﻿/, '')).data; } catch (_) { return r; }
  const todos = [data && data.public, data && data.profile, data && data.operations, data && data.maintainers,
    ...((data && Array.isArray(data.harness_copies)) ? data.harness_copies : []),
    ...((data && data.merge_suites && Array.isArray(data.merge_suites.repos)) ? data.merge_suites.repos.map((e) => e && e.repo) : [])];
  const igual = (x) => x && String(x.org).toLowerCase() === String(r.org).toLowerCase() && String(x.repo).toLowerCase() === String(r.repo).toLowerCase()
    && (!r.project || String(x.project || '').toLowerCase() === String(r.project).toLowerCase());
  const hallados = todos.filter(igual);
  // `org/repo` con el mismo repo en dos proyectos: no se elige uno a ciegas
  const proyectos = [...new Set(hallados.map((x) => String(x.project || '')))];
  if (!r.project && proyectos.length > 1) return { ...r, ambiguo: proyectos };
  const hallado = hallados[0];
  return hallado ? { ...hallado, ...r, platform: r.platform || hallado.platform, project: r.project || hallado.project } : r;
}

const nombre = (r) => [r.org, r.project, r.repo].filter(Boolean).join('/');

/** El juicio de una lectura: `{ result, repo, branch, approval, faults, reason, detail }`. */
function juzgar(r, leido) {
  const base = { repo: nombre(r), branch: null, approval: null, faults: [], reason: null, detail: null };
  if (!leido || leido.ok !== true) return { ...base, result: 'no_medido', reason: (leido && leido.reason) || 'no_medido', detail: (leido && leido.detail) || 'sin respuesta' };
  const v = leido.value;
  if (!v || typeof v !== 'object' || typeof v.branch !== 'string' || (v.approval !== null && (typeof v.approval !== 'object' || Array.isArray(v.approval)))) {
    return { ...base, result: 'no_medido', reason: 'no_medido', detail: 'la plataforma contestó una regla sin forma' };
  }
  const faults = approvalFaults(v.approval);
  return { ...base, branch: v.branch, approval: v.approval, faults, result: faults.length ? (v.approval ? 'no_sirve' : 'falta') : 'sirve' };
}

/** El renglón para una persona. */
function renglon(j) {
  const donde = `${j.repo}${j.branch ? ` · ${j.branch}` : ''}`;
  if (j.result === 'sirve') return `✓ ${donde}: un pedido necesita ${j.approval.minimum === 1 ? 'una aprobación' : `${j.approval.minimum} aprobaciones`}; cuenta el voto de quien lo abrió y un empuje nuevo la borra`;
  if (j.result === 'no_medido') return `? ${donde}: no medido — ${j.detail}`;
  return `✗ ${donde}: ${j.faults.join('; ')} — falta una regla de aprobación mínima: 1 aprobación, que cuente el voto de quien abre el pedido, que se borre con cada empuje y que frene`;
}

const codigoDe = (js) => (js.some((j) => j.result === 'no_medido') ? 2 : js.some((j) => j.result !== 'sirve') ? 1 : 0);

async function check(r, { branch, env, deadlineMs } = {}) {
  const args = { ...(branch ? { branch } : {}), ...(deadlineMs ? { deadlineMs } : {}) };
  let leido;
  try { leido = await P().run('branch-rules.read', args, { repo: r, env: env || process.env }); } catch (e) {
    leido = { ok: false, reason: 'no_medido', detail: `la capa de plataforma falló (${String((e && e.message) || e).split('\n')[0]})` };
  }
  return juzgar(r, leido);
}

/** Los repos de merge_suites de team-repos.json, cada uno con su tope; `{ problem }` si no hay lista. */
async function checkDeclared({ env = process.env, budgetMs = TOTAL_MS } = {}) {
  const tree = path.resolve(env.TYCON_TREE || ROOT);
  let data;
  try {
    const t = fs.readFileSync(path.join(tree, 'team-repos.json'), 'utf8').replace(/^﻿/, '');
    const p = TEAM_REPOS.parse(t);
    if (!p || !p.data || (p.problems && p.problems.length)) return { problem: `team-repos.json no valida (${(p && p.problems && p.problems[0] && p.problems[0].message) || 'sin motivo'})` };
    data = p.data;
  } catch (e) { return { problem: e && e.code === 'ENOENT' ? 'este árbol no trae team-repos.json: no hay repos declarados' : `team-repos.json no se puede leer (${(e && e.code) || 'error'})` }; }
  const repos = data.merge_suites && Array.isArray(data.merge_suites.repos) ? data.merge_suites.repos.map((e) => e && e.repo).filter((x) => x && x.org && x.repo) : [];
  if (!repos.length) return { problem: 'team-repos.json no declara repos en merge_suites' };
  const fin = Date.now() + budgetMs;
  const out = [];
  for (const r of repos) {
    const queda = fin - Date.now();
    if (queda <= 0) { out.push({ ...juzgar(r, { ok: false, reason: 'no_medido', detail: `tope: se acabaron los ${Math.round(budgetMs / 1000)} s antes de mirar este repo` }) }); continue; }
    out.push(await check(r, { env, deadlineMs: Date.now() + Math.min(POR_REPO_MS, queda) }));
  }
  return { value: out };
}

function opciones(argv) {
  const o = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (['--repo', '--platform', '--branch', '--budget-ms'].includes(a)) {
      if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) return { error: `falta el valor de ${a}` };
      o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else return { error: `opción desconocida: ${a}` };
  }
  return o;
}

const USO = 'uso: branch-approval.js check --repo <org/repo | org/proyecto/repo | JSON> [--platform <p>] [--branch <rama>] [--json]\n'
  + '     branch-approval.js check-declared [--json] [--budget-ms <n>]\n';

async function main(argv, { env = process.env, out = (t) => process.stdout.write(t), err = (t) => process.stderr.write(t) } = {}) {
  const [cmd, ...resto] = argv;
  const o = opciones(resto);
  if (o.error || !['check', 'check-declared'].includes(cmd)) { err(`${o.error ? `${o.error}\n` : ''}${USO}`); return 2; }
  if (cmd === 'check') {
    const r0 = identidadDe(o.repo, o.platform);
    if (!r0) { err(`--repo no se lee (${JSON.stringify(o.repo || '')})\n${USO}`); return 2; }
    const r1 = completar(r0, env);
    const j = r1.ambiguo
      ? { repo: nombre(r1), branch: null, approval: null, faults: [], result: 'no_medido', reason: 'rechazado',
        detail: `hay un repo ${r1.repo} en varios proyectos de ${r1.org} (${r1.ambiguo.join(', ')}): nombralo como org/proyecto/repo` }
      : await check(r1, { branch: o.branch, env });
    out(o.json ? `${JSON.stringify(j)}\n` : `${renglon(j)}\n`);
    return codigoDe([j]);
  }
  const budget = o.budgetMs === undefined ? TOTAL_MS : Number(o.budgetMs);
  if (!Number.isInteger(budget) || budget <= 0) { err(`--budget-ms tiene que ser un entero mayor que 0\n${USO}`); return 2; }
  const d = await checkDeclared({ env, budgetMs: budget });
  if (d.problem) {
    out(o.json ? `${JSON.stringify({ repos: null, reason: d.problem })}\n` : `? reglas de aprobación: no medido — ${d.problem}\n`);
    return 2;
  }
  out(o.json ? `${JSON.stringify({ repos: d.value })}\n` : d.value.map((j) => `${renglon(j)}\n`).join(''));
  return codigoDe(d.value);
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });

module.exports = { main, check, checkDeclared, juzgar, renglon, identidadDe };
