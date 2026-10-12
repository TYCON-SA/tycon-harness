#!/usr/bin/env node
'use strict';

/**
 * package-equivalence.js — el equipo no nota el cambio (story 8.2 del arnés, 2026-09-26).
 *
 * La 8.2 saca a los revisores de Bizuit y de clientes del código del pipeline y los pone en
 * manifiestos (packs/). La promesa es que, con los paquetes instalados, el pipeline nuevo elige
 * EXACTAMENTE los mismos revisores que el de `main` antes de la story: mismo set por grupo, misma
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

/** La raíz de repos que resuelve el arnés (scripts/lib/repos-root.js, vía lib/harness-path.js — story 8.3). Sin raíz
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

/** El pipeline.js de `main` antes de la story, sacado del git de agent-skills. */
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
  // story 8.10.3 (tanda D): la foto de los casos que trae un paquete se guarda en la carpeta de ese paquete, nunca en
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
  // (los dos nombres del arnés, el interno y el público: story 8.19, AC 12)
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

// story 8.9 (tanda B3b): los subcomandos y la opción viejos siguen andando hasta el retiro
require('./lib/legacy-names.js').aliasArgv('skills/tycon-pipeline/scripts/package-equivalence.js');
const cmd = process.argv[2];
if (cmd === 'snapshot') foto();
else if (cmd === 'report') informe();
else {
  log('uso: package-equivalence.js snapshot --base <sha> [--out <json>]\n     package-equivalence.js report --base <sha> [--commits N] [--repos-root <dir> | --repos a,b] [--exclude a,b] [--cases-only] [--out <md>]');
  process.exit(cmd ? 1 : 0);
}
