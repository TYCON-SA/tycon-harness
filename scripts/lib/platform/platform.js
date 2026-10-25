#!/usr/bin/env node
'use strict';
// platform.js — la capa de plataforma: el único lugar del núcleo que decide qué conector atiende cada operación y que
// le pasa el pedido. Los guiones, los hooks y los pasos del agente llaman acá; nunca a un conector ni a su CLI.
//
// Quién elige (el contrato, scripts/lib/platform/contract.js):
//   · lo atado a un repo (pedidos de cambio, la CI) va por la plataforma de ese repo en team-repos.json; un repo que no
//     la declara usa el valor por defecto del perfil;
//   · lo demás lo elige el perfil del equipo, `integrations.platform`: el área de la operación (`workItems`, `queue`) o
//     su `default`; sin la clave, la plataforma del repo de operaciones de team-repos.json (lo que se usaba antes).
// La capa no adivina: sin elección, con un valor que no es un conector, o con un conector que no está, contesta
// sin_plataforma con el motivo y cómo elegirla. Nunca elige Azure DevOps (ni otra) por costumbre ni por el remoto.
//
// Toda respuesta es `{ok:true, value}` o `{ok:false, reason, detail}` con un motivo del vocabulario cerrado; una
// excepción del conector, una respuesta con otra forma o un motivo inventado salen no_medido, nunca vacío.
//
// Uso: node scripts/lib/platform/platform.js <operación> [--repo <org/repo | JSON de la identidad>] [--args <JSON | @archivo>]
//   La operación va en una palabra o en dos (`work-item.close` o `work-item close`).
//   node scripts/lib/platform/platform.js choose <operación> [--repo …]: qué conector la atendería, sin pedirle nada.
//   Imprime el resultado en JSON y sale 0 siempre que el contrato se cumplió (aunque diga que no); 2 si se usó mal. Las
//   operaciones del pedido de trabajo traen además `summary`: la línea que el paso muestra y lleva al cierre.
//
// Casos: scripts/tests/platform-contract.test.js.

if (require.main === module) { try { require('../node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { OPERATIONS, REASONS, REPO_OPERATIONS, areaOf, shapeProblem } = require('./contract.js');
const INT = require('../integrations.js');
const TEAM_REPOS = require('../team-repos.js');

// el detalle de un «no» llega a la salida y a los registros: sin direcciones, correos, tokens ni textos largos que
// puedan ser una credencial, y a lo sumo 300 caracteres
function limpiar(t) {
  return String(t == null ? '' : t)
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <oculto>')
    .replace(/https?:\/\/[^\s"')]+/g, '<dirección>')
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi, '<correo>')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, '<oculto>')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}
const no = (reason, detail, extra) => Object.assign({ ok: false, reason, detail: limpiar(detail) || 'sin detalle' }, extra || {});
const CHOOSE = 'elegila en team-profile.json → integrations.platform, por ejemplo {"default": "github"} (en el sitio: Configuración → Integraciones)';

/** El árbol de la organización (donde viven team-profile.json y team-repos.json). */
const treeOf = (opts) => path.resolve(opts.tree || (opts.env || process.env).TYCON_TREE || ROOT);

/** La elección del perfil: `{ value, problem }`. Una configuración rota no es «sin elegir»: se dice. */
function profileChoice(opts) {
  const env = opts.env || process.env;
  let cfg;
  try {
    const CFG = require('../tycon-config.js');
    cfg = CFG.cargar({ env, home: opts.home || env.HOME || os.homedir(), arnes: treeOf(opts) });
    // lo que toca la elección: la clave, su variable, o el perfil entero que no se pudo leer (un perfil roto no es «sin
    // elegir»: pudo haber elegido otra plataforma)
    const perfil = CFG.perfilDelArbol(treeOf(opts)).ruta;
    const sola = (cfg.errores || []).filter((e) => /integrations\.platform|TYCON_PLATFORM/.test(String(e.clave)) || (e.clave == null && e.archivo && path.resolve(String(e.archivo)) === path.resolve(perfil)));
    if (sola.length) return { value: null, problem: `${sola[0].clave || path.basename(String(sola[0].archivo))}: ${sola[0].motivo}` };
    const p = CFG.plataforma(cfg, env);
    if (p.problem) return { value: null, problem: p.problem };
    return { value: p.value, problem: null, config: cfg };
  } catch (e) {
    return { value: null, problem: `no pude leer la configuración (${String((e && e.message) || e).split('\n')[0]})` };
  }
}

/** team-repos.json del árbol: `{ data }`; `{ data: null }` si no está; `{ problem }` si está y no se puede leer o no valida. */
function teamRepos(opts) {
  let texto;
  // `teamReposFile`: un archivo con otro nombre que pidió quien llama (work-items.js --team-repos); si no, el del árbol
  try { texto = fs.readFileSync(opts.teamReposFile ? path.resolve(opts.teamReposFile) : path.join(treeOf(opts), 'team-repos.json'), 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { data: null } : { problem: `team-repos.json no se puede leer (${(e && e.code) || 'error'})` };
  }
  try {
    const r = TEAM_REPOS.parse(texto.replace(/^﻿/, ''));
    if (r && r.data && (!r.problems || !r.problems.length)) return { data: r.data };
    const p = (r && r.problems && r.problems[0]) || {};
    return { problem: `team-repos.json no valida (${p.path ? `${p.path}: ` : ''}${p.message || 'sin motivo'})` };
  } catch (e) { return { problem: `team-repos.json no valida (${String((e && e.message) || e).split('\n')[0]})` }; }
}

/** Todas las identidades de repo que declara team-repos.json (cada una trae su plataforma). */
function identidades(tr) {
  if (!tr || typeof tr !== 'object') return [];
  const ms = tr.merge_suites && Array.isArray(tr.merge_suites.repos) ? tr.merge_suites.repos.map((e) => e && e.repo) : [];
  return [tr.public, tr.profile, tr.operations, tr.maintainers, ...(Array.isArray(tr.harness_copies) ? tr.harness_copies : []), ...ms]
    .filter((r) => r && typeof r === 'object' && r.org && r.repo);
}

/** Una identidad de repo a partir de lo que llega: un objeto, un JSON o `org/repo`. */
function repoOf(repo) {
  if (!repo) return null;
  if (typeof repo === 'object') return repo;
  const s = String(repo).trim();
  if (s.startsWith('{')) { try { return JSON.parse(s); } catch (_) { return null; } }
  const [org, name] = s.split('/');
  return org && name ? { org, repo: name } : null;
}

/**
 * La identidad de team-repos.json de un repo, a partir de dónde vive según su remoto (`{host: 'azure', org, project,
 * name}` o `{host: 'github', ghRepo}`, como lo lee merge-pr.js): `{platform, org, project?, repo}`, o null si el remoto
 * no es de una plataforma conocida. No adivina: un remoto de otro lado no tiene plataforma.
 */
function identityFromRemote(where) {
  if (!where || typeof where !== 'object') return null;
  if (where.host === 'azure' && where.org && where.name) return { platform: 'azure', org: where.org, project: where.project, repo: where.name };
  if (where.host === 'github' && where.ghRepo) { const [org, repo] = String(where.ghRepo).split('/'); return org && repo ? { platform: 'github', org, repo } : null; }
  return null;
}

/** El conector de un nombre: el manifiesto, o el motivo por el que no hay. */
function connector(name, env) {
  const m = INT.find(name, { kind: 'platform', env });
  if (m) return { manifest: m };
  const dir = INT.integrationsDir(env);
  const roto = INT.listManifests({ env, dir }).problems.find((p) => p.name === name);
  if (roto) return { problem: `el conector ${name} no se puede usar: ${roto.reasons.join('; ')}` };
  const existe = fs.existsSync(path.join(dir, name, 'integration.json'));
  if (existe) return { problem: `${name} es una integración, pero no es un conector de plataforma` };
  return { problem: Object.values(TEAM_REPOS.CONNECTORS).includes(name) ? `el conector ${name} no está instalado (falta integrations/${name}/)` : `plataforma desconocida: «${name}»` };
}

/**
 * Qué conector atiende una operación: `{ok:true, value:{connector, origin}}` o `{ok:false, reason:'sin_plataforma',
 * detail}`. `opts`: `repo` (para las operaciones de un repo), `env`, `tree`, `home`.
 */
function choose(operation, opts = {}) {
  const env = opts.env || process.env;
  if (!OPERATIONS.includes(operation)) return no('no_soportado', `operación desconocida: ${operation} (las del contrato: ${OPERATIONS.join(', ')})`);
  const perfil = profileChoice(opts);
  if (perfil.problem) return no('sin_plataforma', `la elección de plataforma del perfil está rota: ${perfil.problem}`);
  const elegida = perfil.value || {};
  let name = null; let origin = null;
  if (REPO_OPERATIONS.includes(operation)) {
    const repo = repoOf(opts.repo);
    if (!repo) return no('sin_plataforma', `${operation} es de un repo: falta --repo (org/repo o su identidad de team-repos.json)`);
    let plat = repo.platform;
    if (!plat) {
      // el repo sin plataforma: la que declara team-repos.json para ese mismo repo, si está
      const leido = teamRepos(opts);
      if (leido.problem) return no('sin_plataforma', `${leido.problem}: no sé la plataforma del repo ${repo.org}/${repo.repo}`);
      const igual = identidades(leido.data).find((r) => String(r.org).toLowerCase() === String(repo.org).toLowerCase() && String(r.repo).toLowerCase() === String(repo.repo).toLowerCase());
      plat = igual && igual.platform;
    }
    if (plat) {
      name = TEAM_REPOS.connectorOf(plat);
      if (!name) return no('sin_plataforma', `plataforma desconocida: «${plat}» (el repo ${repo.org}/${repo.repo} en team-repos.json)`);
      origin = 'repo';
    } else if (elegida.default) { name = elegida.default; origin = 'perfil:default'; }
    else return no('sin_plataforma', `el repo ${repo.org}/${repo.repo} no declara su plataforma en team-repos.json y el perfil no tiene un valor por defecto: declarala en el repo, o ${CHOOSE}`);
  } else {
    const area = areaOf(operation);
    if (elegida[area]) { name = elegida[area]; origin = `perfil:${area}`; }
    else if (elegida.default) { name = elegida.default; origin = 'perfil:default'; }
    else {
      const leido = teamRepos(opts);
      if (leido.problem) return no('sin_plataforma', `${leido.problem}: no sé la plataforma de ${operation}`);
      const tr = leido.data;
      const plat = tr && tr.operations && tr.operations.platform;
      if (plat && TEAM_REPOS.connectorOf(plat)) { name = TEAM_REPOS.connectorOf(plat); origin = 'team-repos:operations'; }
      // `sinEleccion`: nadie eligió nada (ni el perfil ni team-repos.json); quien llama decide si eso tiene un camino propio
      else return no('sin_plataforma', `nadie eligió la plataforma de ${operation}: ${CHOOSE}`, { sinEleccion: true });
    }
  }
  const c = connector(name, env);
  if (c.problem) return no('sin_plataforma', `${c.problem}: se trata como sin plataforma; ${CHOOSE}`);
  return { ok: true, value: { connector: name, origin } };
}

/** Lo que el conector recibe además de los argumentos: el estado de sus secretos y los valores de la configuración. */
function context(manifest, opts) {
  const env = opts.env || process.env;
  let cfg = null; let rota = null;
  try { cfg = require('../tycon-config.js').cargar({ env, home: opts.home || env.HOME || os.homedir(), arnes: treeOf(opts) }); } catch (e) {
    cfg = { valores: {} }; rota = limpiar(String((e && e.message) || e).split('\n')[0]);
  }
  // el problema de la configuración que toca a una sección (`ado`, `github`…): un error de una clave ajena no frena al
  // conector; uno sin clave (el archivo entero no se lee) sí
  const configProblem = (seccion) => {
    if (rota) return rota;
    const e = (cfg.errores || []).find((x) => x.clave == null || String(x.clave).split('.')[0] === seccion);
    return e ? limpiar(`${e.clave == null ? path.basename(String(e.archivo || 'la configuración')) : e.clave}: ${e.motivo}`) : null;
  };
  const config = () => cfg;
  return {
    env,
    // la raíz del arnés: un conector reusa sus lectores de ahí (no por su propia ubicación, que puede ser otra carpeta)
    root: ROOT,
    repo: repoOf(opts.repo),
    label: manifest.label,
    // si la configuración de una sección no se pudo leer: un conector no confunde eso con «falta el dato»
    configProblem,
    // si un secreto está (nunca su valor: el conector lo lee con readSecret cuando lo necesita)
    secretState: (key) => { const estado = INT.secretState(key, { env, dir: INT.integrationsDir(env) }); return { present: estado === 'está', estado }; },
    readSecret: (key) => INT.readSecret(key, { env, dir: INT.integrationsDir(env) }),
    // un valor de la configuración de la máquina (por ejemplo `ado.org`), o undefined
    configValue: (ruta) => {
      const [sec, clave] = String(ruta).split('.');
      const v = config().valores || {};
      return v[sec] && typeof v[sec] === 'object' ? v[sec][clave] : undefined;
    },
  };
}

/** Le pasa la operación a un conector ya elegido y deja la respuesta dentro del contrato. */
async function call(manifest, operation, args, opts) {
  if (!manifest.operations.includes(operation)) return no('no_soportado', `${manifest.label} no declara ${operation}`);
  let mod;
  try { mod = require(path.join(manifest.dir, manifest.connector)); } catch (e) {
    return no('no_medido', `el conector ${manifest.name} no carga (${(e && e.code) || String((e && e.message) || e).split('\n')[0]})`);
  }
  if (!mod || typeof mod.run !== 'function') return no('no_medido', `el conector ${manifest.name} no exporta run()`);
  let r;
  try { r = await mod.run(operation, args || {}, context(manifest, opts)); } catch (e) {
    return no('no_medido', `el conector ${manifest.name} falló en ${operation}: ${String((e && e.message) || e).split('\n')[0]}`);
  }
  const mal = shapeProblem(r);
  if (mal) return no('no_medido', `el conector ${manifest.name} contestó fuera del contrato en ${operation} (${mal})`);
  return r.ok ? r : no(r.reason, r.detail);
}

/**
 * La línea que el paso del agente muestra de una operación del pedido de trabajo, y que llega al mensaje de cierre de la
 * ejecución: qué pasó, lo que la plataforma no tiene y dónde quedaron las horas. Una sola línea.
 */
function summary(operation, r, label) {
  // un «no» que llega a medias (el conector ya publicó algo) no se dice «no se tocó»: reintentar lo duplicaría
  if (!r.ok) return limpiar(/^a medias: /.test(r.detail) ? `pedido de trabajo: quedó a medias — ${r.detail.replace(/^a medias: /, '')}` : `pedido de trabajo: no se tocó — ${r.detail}`);
  const v = r.value || {};
  const en = label ? ` en ${label}` : '';
  let t;
  if (operation === 'work-item.create') t = `pedido de trabajo #${v.id} creado${en}`;
  // sólo el comentario no lee el estado: decir uno sería inventarlo
  else if (operation === 'work-item.update' && v.commented && !v.changed) t = `pedido de trabajo #${v.id}${en}: comentado, sin cambiar el estado`;
  else if (operation === 'work-item.update') t = v.changed ? `pedido de trabajo #${v.id}${en}: ${v.previo} → ${v.estado}` : `pedido de trabajo #${v.id}${en}: sin cambios (${v.estado})`;
  else {
    t = `pedido de trabajo #${v.id} cerrado${en}`;
    if (v.hours === null || v.hours === undefined) t += ' · sin horas';
    else if (v.hoursAs === 'comment') t += ` · ${v.hours} h como comentario (${label || 'la plataforma'} no tiene un campo de horas)`;
    else t += ` · ${v.hours} h en ${v.hoursField || 'el campo de horas'}`;
  }
  const faltan = (Array.isArray(v.unsupported) ? v.unsupported : []).map((u) => u && u.field).filter(Boolean).sort();
  if (faltan.length) t += ` · no soportado${en}: ${faltan.join(', ')}`;
  for (const w of Array.isArray(v.warnings) ? v.warnings : []) t += ` · ${w}`;
  // los avisos pueden traer el texto de un error de la plataforma: pasan por la misma limpieza que un «no»
  return limpiar(t);
}

/** Elige el conector de la operación y le pasa el pedido. Las del pedido de trabajo traen además su `summary`. */
async function run(operation, args = {}, opts = {}) {
  const c = choose(operation, opts);
  const env = opts.env || process.env;
  const manifest = c.ok ? INT.find(c.value.connector, { kind: 'platform', env }) : null;
  const r = c.ok ? await call(manifest, operation, args, opts) : c;
  if (!operation.startsWith('work-item.')) return r;
  // los avisos del conector pueden traer el texto de un error de la plataforma: pasan por la misma limpieza que un «no»
  const v = r.ok && r.value && Array.isArray(r.value.warnings) ? { ...r, value: { ...r.value, warnings: r.value.warnings.map(limpiar) } } : r;
  return { ...v, summary: summary(operation, v, manifest && manifest.label) };
}

/**
 * La prueba de conformidad de un conector: cada operación que declara contesta dentro del contrato (con argumentos de
 * prueba; un «no» con su motivo también cumple). `{ problems: [texto] }`, vacío si cumple.
 */
async function conformance(name, opts = {}) {
  const env = opts.env || process.env;
  const c = connector(name, env);
  if (c.problem) return { problems: [c.problem] };
  const problems = [];
  const PRUEBA = { entrada: { pipeline: 'Proyecto/publicar', stages: ['Prod'], repo: 'acme/portal', environment: 'production' }, entorno: 'production' };
  for (const op of c.manifest.operations) {
    const r = await call(c.manifest, op, PRUEBA, { ...opts, repo: opts.repo || { org: 'acme', repo: 'portal' } });
    const mal = shapeProblem(r);
    if (mal) problems.push(`${op}: ${mal}`);
    else if (!r.ok && /fuera del contrato|no exporta|no carga/.test(r.detail)) problems.push(`${op}: ${r.detail}`);
  }
  return { problems };
}

function main(argv) {
  // `choose <operación>`: qué conector la atendería, sin pedirle nada (un paso que tiene un camino propio de una
  // plataforma lo pregunta antes de tomarlo)
  if (argv[0] === 'choose') {
    const op = argv.length > 2 && OPERATIONS.includes(`${argv[1]}.${argv[2]}`) ? `${argv[1]}.${argv[2]}` : argv[1];
    if (!OPERATIONS.includes(op)) { process.stderr.write(`uso: platform.js choose <operación>\noperaciones: ${OPERATIONS.join(', ')}\n`); return Promise.resolve(2); }
    const i = argv.indexOf('--repo');
    process.stdout.write(`${JSON.stringify(choose(op, { repo: i >= 0 ? argv[i + 1] : undefined }))}\n`);
    return Promise.resolve(0);
  }
  // la operación en una palabra (`work-item.create`) o en dos (`work-item create`)
  const dos = argv.length > 1 && OPERATIONS.includes(`${argv[0]}.${argv[1]}`);
  const operation = dos ? `${argv[0]}.${argv[1]}` : argv[0];
  const rest = argv.slice(dos ? 2 : 1);
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  if (!operation || !OPERATIONS.includes(operation)) {
    process.stderr.write(`uso: platform.js <operación> [--repo <org/repo|JSON>] [--args <JSON | @archivo.json>]\noperaciones: ${OPERATIONS.join(', ')}\n`);
    return Promise.resolve(2);
  }
  let args = {};
  if (opt('--args') !== undefined) {
    // `@archivo`: los argumentos en un archivo (un texto largo, como la descripción de una historia, no entra cómodo en la línea)
    const crudo = opt('--args');
    try { args = JSON.parse(crudo.startsWith('@') ? fs.readFileSync(crudo.slice(1), 'utf8') : crudo); } catch (e) { process.stderr.write(`--args no es JSON (${e.message})\n`); return Promise.resolve(2); }
  }
  return run(operation, args, { repo: opt('--repo') }).then((r) => { process.stdout.write(`${JSON.stringify(r)}\n`); return 0; });
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { choose, run, call, conformance, connector, identityFromRemote, limpiar, summary, main, OPERATIONS, REASONS };
