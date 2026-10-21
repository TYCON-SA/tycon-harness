#!/usr/bin/env node
'use strict';

/**
 * package-equivalence.js — el equipo no nota el cambio.
 *
 * Los revisores de Bizuit y de clientes no viven en el código del pipeline sino en manifiestos
 * (packs/). La promesa es que, con los paquetes instalados, el pipeline elige EXACTAMENTE los mismos
 * revisores que el de `main` antes de ese cambio: mismo set por grupo, misma
 * superficie de vuelta, mismas indicaciones de modelo. Eso no se supone: se mide, contra el
 * `pipeline.js` viejo sacado del git de agent-skills (`git archive <sha>`), sobre el mismo estado
 * de repo, en procesos separados con HOME aislado (no ensucia el registro de ninguna sesión).
 *
 *   node package-equivalence.js snapshot --base <sha> [--out tests/fixtures/equivalence-main.json]
 *       Corre el pipeline VIEJO sobre los casos armados (lib/equivalence-cases.js) y guarda la foto
 *       dorada que compara tests/package-equivalence.test.js (T10). Se regenera SÓLO a propósito.
 *
 *   node package-equivalence.js report   --base <sha> [--commits 30] [--repos-root <dir> | --repos a,b]
 *                                         [--exclude a,b] [--cases-only] [--out <informe.md>]
 *       (a) los casos armados con los DOS pipelines; (b) los últimos N commits de cada repo git
 *       encontrado bajo `--repos-root` (default TYCON_REPOS_ROOT o la raíz que resuelve el arnés, hasta 3 niveles,
 *       sin el arnés ni agent-skills). Cada commit se reproduce como lo vería una corrida real: un
 *       clon compartido efímero con HEAD en el padre y el árbol en el commit (`git diff HEAD` = el
 *       diff del commit; lo agregado queda untracked). Una sola diferencia de conjunto es rojo
 *       (exit 1). El orden se informa aparte: no es contrato.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CASOS, medir, sinOrden, destinoDeFoto } = require('./lib/equivalence-cases.js');

const SCRIPTS = __dirname;
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');            // agent-skills
const PIPELINE_NUEVO = path.join(SCRIPTS, 'pipeline.js');
const PACKS_REALES = path.join(RAIZ, 'packs');

/** La raíz de repos que resuelve el arnés (scripts/lib/repos-root.js, vía lib/harness-path.js). Sin raíz
 *  no se pueden descubrir repos: se dice y se frena (nunca una carpeta escrita a mano). */
function raizDeRepos() {
  try {
    const { rutaArnes } = require('./lib/harness-path.js');
    const r = require(path.join(rutaArnes(), 'scripts', 'lib', 'repos-root.js')).resolveReposRoot();
    if (r.root) return r.root;
    throw new Error(r.motivo);
  } catch (e) {
    console.error(`package-equivalence: sin raíz de repos (${e.message}) — pasá --repos-root <dir> o --repos <a,b>, o definí TYCON_REPOS_ROOT`);
    process.exit(2);
  }
}

function arg(nombre, def) { const i = process.argv.indexOf(nombre); return i > -1 ? process.argv[i + 1] : def; }
function flag(nombre) { return process.argv.includes(nombre); }
function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function git(dir, args, opts = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`git no se pudo ejecutar (${r.error.code || r.error.message})`);   // binario ausente ≠ comando fallido
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} en ${dir}: ${r.stderr}`);
  return r.stdout;
}
const log = (s) => process.stderr.write(s + '\n');

/** El pipeline.js de `main` antes del cambio, sacado del git de agent-skills. */
function pipelineViejo(sha) {
  const shaCompleto = git(RAIZ, ['rev-parse', `${sha}^{commit}`]).trim();
  const dir = tmp('equiv-viejo-');
  const tar = path.join(dir, 'viejo.tar');
  const r = spawnSync('git', ['-C', RAIZ, 'archive', '-o', tar, shaCompleto, 'skills/tycon-pipeline/scripts'], { encoding: 'utf8' });
  if (r.error) throw new Error(`git no se pudo ejecutar (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new Error(`git archive ${sha}: ${r.stderr}`);
  const t = spawnSync('tar', ['-xf', tar, '-C', dir], { encoding: 'utf8' });
  if (t.error) throw new Error(`tar no se pudo ejecutar (${t.error.code || t.error.message})`);
  if (t.status !== 0) throw new Error(`tar: ${t.stderr}`);
  const pipeline = path.join(dir, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js');
  if (!fs.existsSync(pipeline)) throw new Error(`no salió pipeline.js de ${sha}`);
  return { pipeline, sha: shaCompleto };
}

function ambientes() {
  return {
    viejo: { HOME: tmp('equiv-home-viejo-') },
    nuevo: { HOME: tmp('equiv-home-nuevo-'), TYCON_PACKS_DIR: PACKS_REALES },
  };
}

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function diferencias(viejo, nuevo) {
  const out = [];
  for (const campo of ['base', 'completitud', 'conditional', 'model_hints', 'reloop_model_hints', 'superficie']) {
    if (!igual(viejo[campo], nuevo[campo])) out.push({ campo, viejo: viejo[campo], nuevo: nuevo[campo] });
  }
  return out;
}

// ── foto ──────────────────────────────────────────────────────────────────────────────────────
function foto() {
  const base = arg('--base');
  if (!base) { log('snapshot: falta --base <sha>'); process.exit(2); }
  const dorada = path.join(SCRIPTS, 'tests', 'fixtures', 'equivalence-main.json');
  const out = arg('--out', dorada);
  const { pipeline, sha } = pipelineViejo(base);
  const env = ambientes().viejo;
  const casos = {};
  // La foto de los casos que trae un paquete se guarda en la carpeta de ese paquete, nunca en
  // la que viaja — un paquete privado no deja su nombre en un archivo publicado. Con `--out` a otra ruta es una foto
  // de ENSAYO: todo queda al lado de esa ruta y la dorada de ningún paquete se toca (destinoDeFoto).
  const dePaquetes = new Map();   // dónde va la foto de cada paquete → { casos }
  for (const caso of CASOS) {
    const dir = tmp('equiv-caso-');
    const { files } = caso.armar(dir);
    const medido = sinOrden(medir({ pipeline, repo: dir, files, env }));
    if (caso.paquete) {
      const destino = destinoDeFoto(caso, out, dorada);
      if (!dePaquetes.has(destino)) dePaquetes.set(destino, {});
      dePaquetes.get(destino)[caso.nombre] = medido;
    } else casos[caso.nombre] = medido;
    log(`📸 ${caso.nombre}${caso.paquete ? ` (paquete ${caso.paquete})` : ''}: base=${medido.base.join(',')} · cond=${medido.conditional.join(',')}`);
  }
  const tomada = new Date().toISOString();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    __doc: 'Foto dorada de la equivalencia de paquetes (story 8.2): lo que el pipeline.js de main ANTES de la story elegía para cada caso de lib/equivalence-cases.js. La compara tests/package-equivalence.test.js. Regenerar SÓLO a propósito: node package-equivalence.js snapshot --base <sha>.',
    base_sha: sha,
    tomada_en: tomada,
    casos,
  }, null, 2) + '\n');
  log(`✅ foto de ${Object.keys(casos).length} casos → ${out} (base ${sha.slice(0, 7)})`);
  // la que viaja primero: si no se pudo escribir, la foto de ningún paquete queda cambiada a medias
  for (const [archivo, suyos] of dePaquetes) {
    fs.writeFileSync(archivo, JSON.stringify({
      __doc: 'Foto dorada de los casos de equivalencia que trae este paquete (story 8.10.3, tanda D). La compara tests/package-equivalence.test.js junto con la que viaja. Regenerar SÓLO a propósito: node package-equivalence.js snapshot --base <sha>.',
      base_sha: sha,
      tomada_en: tomada,
      casos: suyos,
    }, null, 2) + '\n');
    log(`✅ foto de ${Object.keys(suyos).length} caso(s) de paquete → ${archivo}`);
  }
}

// ── informe ───────────────────────────────────────────────────────────────────────────────────
function descubrirRepos(root, excluir) {
  const out = [];
  // (los dos nombres del arnés, el interno y el público)
  const SALTAR = new Set(['node_modules', 'tycon-claude-guides', 'tycon-harness', 'agent-skills', 'AgentSkills', 'BMAD', ...excluir]);
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SALTAR.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (fs.existsSync(path.join(p, '.git'))) { out.push(p); continue; }   // no se baja adentro de un repo
      walk(p, depth + 1);
    }
  };
  walk(root, 1);
  return out.sort();
}

function medirCommits({ repo, n, viejo, nuevo, env }) {
  const fila = { repo, pedidos: n, medidos: 0, sinArchivos: 0, difConjunto: 0, difOrden: 0, errores: 0, detalles: [] };
  let commits;
  try { commits = git(repo, ['log', '--format=%H', '-n', String(n), 'HEAD']).trim().split('\n').filter(Boolean); }
  catch (e) {
    // Un repo recién inicializado (sin ningún commit) no es un error de medición: no hay nada que medir.
    if (/unknown revision|does not have any commits/.test(e.message)) { fila.pedidos = 0; return fila; }
    fila.errores++; fila.detalles.push({ commit: '-', campo: 'git log', viejo: e.message, nuevo: '' }); return fila;
  }
  const clon = tmp('equiv-clon-');
  try {
    git(os.tmpdir(), ['clone', '--shared', '--no-checkout', '-q', repo, clon]);
  } catch (e) { fila.errores++; fila.detalles.push({ commit: '-', campo: 'git clone', viejo: e.message, nuevo: '' }); return fila; }
  for (const c of commits) {
    let padre;
    try { padre = git(clon, ['rev-parse', '--verify', '-q', `${c}^`]).trim(); } catch (_e) { padre = null; }
    if (!padre) { fila.sinArchivos++; continue; }   // commit raíz: no hay diff que reproducir
    let files;
    try {
      git(clon, ['checkout', '-qf', c]);
      git(clon, ['clean', '-qfdx']);
      git(clon, ['reset', '-q', '--mixed', padre]);
      files = git(clon, ['diff', '--name-only', '--diff-filter=d', padre, c]).trim().split('\n').filter(Boolean)
        .filter((f) => fs.existsSync(path.join(clon, f)));
    } catch (e) { fila.errores++; fila.detalles.push({ commit: c.slice(0, 7), campo: 'git', viejo: e.message, nuevo: '' }); continue; }
    if (!files.length) { fila.sinArchivos++; continue; }
    let v; let nn;
    try {
      v = medir({ pipeline: viejo, repo: clon, files, story: null, env: env.viejo });
      nn = medir({ pipeline: nuevo, repo: clon, files, story: null, env: env.nuevo });
    } catch (e) { fila.errores++; fila.detalles.push({ commit: c.slice(0, 7), campo: 'pipeline', viejo: e.message.slice(0, 400), nuevo: '' }); continue; }
    fila.medidos++;
    const difs = diferencias(sinOrden(v), sinOrden(nn));
    if (difs.length) {
      fila.difConjunto++;
      for (const d of difs) fila.detalles.push({ commit: c.slice(0, 7), ...d });
    } else if (!igual(v.orden, nn.orden)) {
      // Informativo: el orden no es contrato. Se deja el primero de cada repo para que se vea de qué se trata.
      fila.difOrden++;
      if (fila.difOrden === 1) fila.detalles.push({ commit: c.slice(0, 7), campo: 'orden (informativo, mismo conjunto)', viejo: v.orden, nuevo: nn.orden });
    }
  }
  log(`  ${path.basename(repo)}: ${fila.medidos} medidos · ${fila.sinArchivos} sin archivos · ${fila.difConjunto} dif. de conjunto · ${fila.difOrden} dif. de orden · ${fila.errores} errores`);
  return fila;
}

function informe() {
  const base = arg('--base');
  if (!base) { log('report: falta --base <sha>'); process.exit(2); }
  const n = parseInt(arg('--commits', '30'), 10);
  const out = arg('--out', null);
  const soloCasos = flag('--cases-only');
  const { pipeline: viejo, sha } = pipelineViejo(base);
  const env = ambientes();
  const nuevoSha = git(RAIZ, ['rev-parse', 'HEAD']).trim();
  const sucio = git(RAIZ, ['status', '--porcelain', '--', 'skills/tycon-pipeline', 'packs']).trim() !== '';

  // (a) casos armados
  log(`(a) casos armados: ${CASOS.length}`);
  const casos = [];
  for (const caso of CASOS) {
    const dir = tmp('equiv-caso-');
    const { files } = caso.armar(dir);
    const v = medir({ pipeline: viejo, repo: dir, files, env: env.viejo });
    const nn = medir({ pipeline: PIPELINE_NUEVO, repo: dir, files, env: env.nuevo });
    const difs = diferencias(sinOrden(v), sinOrden(nn));
    casos.push({ nombre: caso.nombre, files, conjunto: difs.length === 0, orden: igual(v.orden, nn.orden), difs, viejo: v });
    log(`  ${difs.length ? '❌' : '✅'} ${caso.nombre}${igual(v.orden, nn.orden) ? '' : ' (orden distinto)'}`);
  }

  // (b) commits reales
  let filas = [];
  let root = null;
  if (!soloCasos) {
    const explicitos = arg('--repos', null);
    root = arg('--repos-root', null) || process.env.TYCON_REPOS_ROOT || raizDeRepos();   // perezoso: con --repos-root no se deduce nada
    const excluir = (arg('--exclude', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const repos = explicitos ? explicitos.split(',').map((s) => path.resolve(s.trim())) : descubrirRepos(root, excluir);
    log(`(b) commits reales: ${repos.length} repos bajo ${explicitos ? '(explícitos)' : root}, ${n} commits cada uno`);
    for (const repo of repos) filas.push(medirCommits({ repo, n, viejo, nuevo: PIPELINE_NUEVO, env }));
  }

  const rojoCasos = casos.filter((c) => !c.conjunto).length;
  const rojoCommits = filas.reduce((a, f) => a + f.difConjunto, 0);
  const errores = filas.reduce((a, f) => a + f.errores, 0);

  // ── el informe ──
  const L = [];
  L.push('# Medición 8.2 — equivalencia de paquetes: el equipo no nota el cambio');
  L.push('');
  L.push(`Generado por \`skills/tycon-pipeline/scripts/package-equivalence.js report\` el ${new Date().toISOString()} en ${os.hostname()}.`);
  L.push('');
  L.push(`- **Pipeline viejo** (referencia, \`main\` antes de la story): agent-skills \`${sha}\` (\`git archive\`).`);
  L.push(`- **Pipeline nuevo**: agent-skills \`${nuevoSha}\`${sucio ? ' + cambios sin commitear de la story' : ''}, con los paquetes de \`packs/\` (bizuit, clientes).`);
  L.push('- **Qué se compara** (AC 9): set por grupo (`base`, `completitud`, `conditional`) como CONJUNTO; superficie de vuelta (`advisorAffectedByDelta` de cada revisor del set contra los archivos del diff); indicaciones de modelo con `--cost-tier lean` y las de re-loop. El **orden** no es contrato (`check-count` y el marker comparan conjuntos): se informa aparte.');
  L.push('- **Cómo se reproduce cada commit**: clon compartido efímero, HEAD en el padre, árbol en el commit — `git diff HEAD` es el diff del commit y lo agregado queda untracked, igual que en una corrida real. Los dos pipelines corren en procesos separados con HOME aislado.');
  L.push('');
  L.push(`## Veredicto: ${rojoCasos + rojoCommits === 0 && errores === 0 ? '✅ 0 diferencias de conjunto' : `❌ ${rojoCasos} caso(s) y ${rojoCommits} commit(s) con diferencias de conjunto${errores ? ` · ${errores} error(es) de medición` : ''}`}`);
  L.push('');
  L.push('## (a) Casos armados — cada rama de la matriz que el pipeline tenía escrita');
  L.push('');
  L.push('| Caso | Archivos | Conjunto | Orden | Set viejo (base · condicional) |');
  L.push('|---|---|---|---|---|');
  for (const c of casos) {
    L.push(`| ${c.nombre} | ${c.files.join(', ')} | ${c.conjunto ? '✅ igual' : '❌ DISTINTO'} | ${c.orden ? 'igual' : 'distinto'} | ${c.viejo.base.join(', ') || '—'} · ${c.viejo.conditional.join(', ') || '—'} |`);
  }
  for (const c of casos.filter((x) => !x.conjunto)) {
    L.push('');
    L.push(`### ❌ ${c.nombre}`);
    for (const d of c.difs) L.push(`- \`${d.campo}\`: viejo ${JSON.stringify(d.viejo)} · nuevo ${JSON.stringify(d.nuevo)}`);
  }
  L.push('');
  if (!soloCasos) {
    L.push(`## (b) Commits reales — últimos ${n} de cada repo bajo \`${root || '(explícitos)'}\``);
    L.push('');
    L.push('| Repo | Pedidos | Medidos | Sin archivos* | Dif. de conjunto | Dif. de orden** | Errores |');
    L.push('|---|---|---|---|---|---|---|');
    for (const f of filas) {
      L.push(`| ${path.relative(root || '/', f.repo) || f.repo} | ${f.pedidos === 0 ? 'sin commits' : f.pedidos} | ${f.medidos} | ${f.sinArchivos} | ${f.difConjunto ? `❌ ${f.difConjunto}` : '0'} | ${f.difOrden} | ${f.errores} |`);
    }
    const totales = filas.reduce((a, f) => ({ medidos: a.medidos + f.medidos, difConjunto: a.difConjunto + f.difConjunto, difOrden: a.difOrden + f.difOrden, errores: a.errores + f.errores }), { medidos: 0, difConjunto: 0, difOrden: 0, errores: 0 });
    L.push(`| **Total (${filas.length} repos)** | | **${totales.medidos}** | | **${totales.difConjunto}** | ${totales.difOrden} | ${totales.errores} |`);
    L.push('');
    L.push('\\* commits raíz, sin padre, o cuyo diff sólo borra archivos: no hay diff que reproducir. «Pedidos» menor que el total medido + sin archivos = el repo tiene menos commits que los pedidos.');
    L.push('');
    L.push('\\*\\* mismo CONJUNTO, distinto orden: los revisores de paquete van primero en `base` y al final en `conditional` (antes el de hermanos iba en el medio de la lista). No es contrato: `check-count`, el marker y el anuncio comparan conjuntos.');
    const conDetalle = filas.filter((f) => f.detalles.length);
    if (conDetalle.length) {
      L.push('');
      L.push('### Detalle de diferencias y errores');
      for (const f of conDetalle) {
        L.push('');
        L.push(`#### ${path.basename(f.repo)}`);
        for (const d of f.detalles) L.push(`- ${d.commit} · \`${d.campo}\`: viejo ${JSON.stringify(d.viejo)} · nuevo ${JSON.stringify(d.nuevo)}`);
      }
    }
    L.push('');
  }
  const texto = L.join('\n') + '\n';
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, texto); log(`📄 informe → ${out}`); }
  else process.stdout.write(texto);
  process.exit(rojoCasos + rojoCommits + errores === 0 ? 0 : 1);
}

// ── por repo: ningún repo pierde un revisor ──────────────────────────────────────────────────
/** Un árbol del arnés de `sha` (el pipeline, los paquetes y los agentes), sacado del git de este clon. */
function arbolViejo(sha) {
  const shaCompleto = git(RAIZ, ['rev-parse', `${sha}^{commit}`]).trim();
  const dir = tmp('equiv-arbol-');
  const tar = path.join(dir, 'arbol.tar');
  const rutas = ['skills/tycon-pipeline/scripts', 'packs', 'agents'].filter((r) => git(RAIZ, ['ls-tree', '--name-only', shaCompleto, r]).trim());
  const r = spawnSync('git', ['-C', RAIZ, 'archive', '-o', tar, shaCompleto, ...rutas], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`git archive ${sha}: ${(r.error && r.error.message) || r.stderr}`);
  const t = spawnSync('tar', ['-xf', tar, '-C', dir], { encoding: 'utf8' });
  if (t.error || t.status !== 0) throw new Error(`tar: ${(t.error && t.error.message) || t.stderr}`);
  return { dir, sha: shaCompleto };
}

/** El ambiente con que corre el pipeline de un árbol: sus paquetes, sus agentes, la configuración de este clon y el perfil. */
function ambienteDeArbol(arbol, perfil) {
  return {
    HOME: tmp('equiv-home-'), TYCON_PACKS_DIR: path.join(arbol, 'packs'), TYCON_AGENTS_DIR: path.join(arbol, 'agents'),
    TYCON_GUIDES_DIR: RAIZ, ...(perfil ? { TYCON_PROFILE: perfil } : {}),
  };
}
const todos = (m) => [...new Set([...m.base, ...m.completitud, ...m.conditional])].sort();
const NO_ACTIVO = /la organización no lo activó/;

/** Los commits de los últimos `dias` días de un repo, medidos con los dos árboles: `{ repo, medidos, pierden: [{commit, revisores}], noActivos: [motivo], errores: [..] }`. */
function medirRepo({ repo, dias, viejo, nuevo }) {
  const fila = { repo, medidos: 0, sinArchivos: 0, pierden: [], ganan: 0, noActivos: [], errores: [] };
  let commits = [];
  try { commits = git(repo, ['log', `--since=${dias}.days`, '--format=%H', 'HEAD']).trim().split('\n').filter(Boolean); }
  catch (e) { if (!/unknown revision|does not have any commits/.test(e.message)) fila.errores.push(`git log: ${e.message.slice(0, 200)}`); return fila; }
  if (!commits.length) return fila;
  const clon = tmp('equiv-clon-');
  try { git(os.tmpdir(), ['clone', '--shared', '--no-checkout', '-q', repo, clon]); } catch (e) { fila.errores.push(`git clone: ${e.message.slice(0, 200)}`); return fila; }
  for (const c of commits) {
    let padre;
    try { padre = git(clon, ['rev-parse', '--verify', '-q', `${c}^`]).trim(); } catch (_e) { padre = null; }
    if (!padre) { fila.sinArchivos++; continue; }
    let files;
    try {
      git(clon, ['checkout', '-qf', c]); git(clon, ['clean', '-qfdx']); git(clon, ['reset', '-q', '--mixed', padre]);
      files = git(clon, ['diff', '--name-only', '--diff-filter=d', padre, c]).trim().split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(clon, f)));
    } catch (e) { fila.errores.push(`${c.slice(0, 7)} git: ${e.message.slice(0, 200)}`); continue; }
    if (!files.length) { fila.sinArchivos++; continue; }
    // un repo que declara un paquete que la organización no activó frena el pipeline: es un hallazgo, no un error
    const correr = (lado, cual) => {
      try { return medir({ pipeline: lado.pipeline, repo: clon, files, story: null, env: lado.env }); } catch (e) {
        if (NO_ACTIVO.test(e.message)) { const m = (e.message.match(/[^\n]*la organización no lo activó[^\n]*/) || [e.message])[0].trim(); if (!fila.noActivos.includes(m)) fila.noActivos.push(m); return null; }
        fila.errores.push(`${c.slice(0, 7)} ${cual}: ${e.message.split('\n').slice(0, 3).join(' ').slice(0, 300)}`); return null;
      }
    };
    const v = correr(viejo, 'árbol de antes');
    const nn = v && correr(nuevo, 'árbol nuevo');
    if (!v || !nn) continue;
    fila.medidos++;
    const antes = todos(v); const despues = todos(nn);
    const perdidos = antes.filter((a) => !despues.includes(a));
    if (perdidos.length) fila.pierden.push({ commit: c.slice(0, 7), revisores: perdidos });
    if (despues.some((a) => !antes.includes(a))) fila.ganan++;
  }
  log(`  ${path.basename(repo)}: ${fila.medidos} medidos · ${fila.pierden.length} pierden · ${fila.noActivos.length ? 'declara un paquete no activo · ' : ''}${fila.errores.length} errores`);
  return fila;
}

function porRepo() {
  const dias = parseInt(arg('--since', '30'), 10);
  const out = arg('--out', null);
  let perfil = arg('--profile', null);
  if (perfil) perfil = path.resolve(perfil);
  else if (!['team-profile.json', 'perfil-equipo.json'].some((n) => fs.existsSync(path.join(RAIZ, n)))) {
    log('per-repo: sin perfil del equipo en este clon — pasá --profile <team-profile.json> (sin él, ningún paquete está activo y la medición no dice nada)');
    process.exit(2);
  }
  let viejoDir; let viejoSha = null;
  if (arg('--old-tree')) viejoDir = path.resolve(arg('--old-tree'));
  else { const a = arbolViejo(arg('--base', 'origin/main')); viejoDir = a.dir; viejoSha = a.sha; }
  const nuevoDir = path.resolve(arg('--new-tree', RAIZ));
  const lado = (d) => ({ pipeline: path.join(d, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js'), env: ambienteDeArbol(d, perfil) });
  const explicitos = arg('--repos', null);
  const root = explicitos ? null : (arg('--repos-root', null) || process.env.TYCON_REPOS_ROOT || raizDeRepos());
  const repos = explicitos ? explicitos.split(',').map((s) => path.resolve(s.trim())) : descubrirRepos(root, (arg('--exclude', '') || '').split(',').map((s) => s.trim()).filter(Boolean));
  log(`per-repo: ${repos.length} repos, commits de los últimos ${dias} días`);
  const filas = repos.map((repo) => medirRepo({ repo, dias, viejo: lado(viejoDir), nuevo: lado(nuevoDir) }));
  const pierden = filas.filter((f) => f.pierden.length);
  const noActivos = filas.filter((f) => f.noActivos.length);
  const errores = filas.reduce((a, f) => a + f.errores.length, 0);
  // sin un solo commit medido (ningún repo, o ninguno con commits en la ventana) no hay veredicto: «no medido», nunca verde
  const medidos = filas.reduce((a, f) => a + f.medidos, 0);
  const sinMedir = medidos === 0 && !noActivos.length;
  const L = [];
  L.push('# Medición 8.41 — paquetes por repo: ningún repo pierde un revisor');
  L.push('');
  L.push(`Generado por \`skills/tycon-pipeline/scripts/package-equivalence.js per-repo\` el ${new Date().toISOString()}.`);
  L.push('');
  L.push(`- **Árbol de antes**: ${viejoSha ? `\`${viejoSha}\` (git archive)` : viejoDir}. **Árbol del cambio**: ${nuevoDir === RAIZ ? `este clon (\`${git(RAIZ, ['rev-parse', 'HEAD']).trim()}\`${git(RAIZ, ['status', '--porcelain', '--', 'skills/tycon-pipeline', 'packs', 'agents']).trim() ? ' + cambios sin commitear' : ''})` : nuevoDir}.`);
  L.push(`- **Perfil**: ${perfil || 'el de este clon'}. **Repos**: ${explicitos ? 'los pedidos' : `los de \`${root}\``} (${repos.length}), commits de los últimos ${dias} días.`);
  L.push('- **Rojo** si un repo pierde un revisor (el set completo: base, completitud y condicionales) o declara en `packs:` un paquete que la organización no activó.');
  L.push('');
  L.push(`## Veredicto: ${sinMedir ? `⚠️ NO MEDIDO — ${repos.length} repo(s) y ningún commit medido en los últimos ${dias} días: no hay con qué decir que nadie pierde un revisor` : pierden.length || noActivos.length || errores ?`❌ ${pierden.length} repos pierden un revisor · ${noActivos.length} declaran un paquete que la organización no activó${errores ? ` · ${errores} error(es) de medición` : ''}` : `✅ 0 repos pierden un revisor · 0 declaran un paquete no activo`}`);
  L.push('');
  L.push('| Repo | Medidos | Sin archivos | Pierden | Ganan | Paquete no activo | Errores |');
  L.push('|---|---|---|---|---|---|---|');
  for (const f of filas) L.push(`| ${root ? path.relative(root, f.repo) : path.basename(f.repo)} | ${f.medidos} | ${f.sinArchivos} | ${f.pierden.length ? `❌ ${f.pierden.length}` : '0'} | ${f.ganan} | ${f.noActivos.length ? '❌' : '—'} | ${f.errores.length} |`);
  for (const f of filas.filter((x) => x.pierden.length || x.noActivos.length || x.errores.length)) {
    L.push('');
    L.push(`### ${path.basename(f.repo)}`);
    for (const p of f.pierden) L.push(`- ${p.commit} pierde: ${p.revisores.join(', ')}`);
    for (const m of f.noActivos) L.push(`- declara un paquete que la organización no activó: ${m}`);
    for (const e of f.errores) L.push(`- error: ${e}`);
  }
  L.push('');
  const texto = L.join('\n') + '\n';
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, texto); log(`📄 medición → ${out}`); } else process.stdout.write(texto);
  process.exit(sinMedir ? 2 : (pierden.length || noActivos.length || errores ? 1 : 0));
}

// Los subcomandos y la opción viejos siguen andando hasta el retiro
require('./lib/legacy-names.js').aliasArgv('skills/tycon-pipeline/scripts/package-equivalence.js');
const cmd = process.argv[2];
if (cmd === 'snapshot') foto();
else if (cmd === 'report') informe();
else if (cmd === 'per-repo') porRepo();
else {
  log('uso: package-equivalence.js snapshot --base <sha> [--out <json>]\n     package-equivalence.js report --base <sha> [--commits N] [--repos-root <dir> | --repos a,b] [--exclude a,b] [--cases-only] [--out <md>]\n     package-equivalence.js per-repo [--base <sha> | --old-tree <dir>] [--new-tree <dir>] [--since <días>] [--profile <perfil>] [--repos-root <dir> | --repos a,b] [--exclude a,b] [--out <md>]');
  process.exit(cmd ? 1 : 0);
}
