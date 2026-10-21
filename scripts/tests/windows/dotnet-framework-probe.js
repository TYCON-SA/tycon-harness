#!/usr/bin/env node
'use strict';

/**
 * dotnet-framework-probe.js — la receta «.NET Framework (vstest)» del perfil del equipo, corrida de verdad: la puerta
 * de pruebas (test-gate.sh) sobre un proyecto mínimo de .NET Framework (scripts/tests/fixtures/netfx-vstest/), con
 * MSBuild y vstest encontrados por vswhere. Corre en un agente Windows de Azure con Visual Studio (el ensayo 182,
 * escenario `netfx`); en una máquina sin Visual Studio la receta dice que falta vswhere y la sonda sale roja.
 *
 * Dos corridas sobre el mismo proyecto, una prueba que pasa y otra que falla:
 *   1. sin detalle para el repo: 2 pruebas, 1 fallida, rojo;
 *   2. con el filtro «TestCategory=Unit» declarado para el repo (una entrada en `repos`): 1 de 1, verde.
 *
 * La prueba: NetfxRecipe_RealVstest_PassFailAndFilter @story-7.51 @ac-15.
 *
 * Uso: node dotnet-framework-probe.js --recipe <team-repos.json del perfil> --out <carpeta del informe>
 * Sale 0 si las dos corridas dieron lo esperado; 1 si no; 2 si no pudo arrancar.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(RAIZ, 'scripts', 'tests', 'fixtures', 'netfx-vstest');
const TEST_GATE = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'test-gate.sh');
const REMOTO = 'https://github.com/acme/netfx-probe.git';
const REPO = { platform: 'github', org: 'acme', repo: 'netfx-probe' };

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const RECETA = arg('--recipe');
const OUT = arg('--out');
if (!RECETA || !OUT) { process.stderr.write('uso: dotnet-framework-probe.js --recipe <team-repos.json> --out <carpeta>\n'); process.exit(2); }

/** El bash de Git para Windows: el `bash` del PATH de un agente Windows puede ser el de WSL. */
function bashDeGit() {
  if (process.platform !== 'win32') return 'bash';
  const candidatos = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
    .map((d) => path.join(d, 'Git', 'bin', 'bash.exe'));
  return candidatos.find((c) => fs.existsSync(c)) || 'bash';
}

function copiar(de, a) {
  fs.mkdirSync(a, { recursive: true });
  for (const e of fs.readdirSync(de, { withFileTypes: true })) {
    if (e.isDirectory()) copiar(path.join(de, e.name), path.join(a, e.name));
    else fs.copyFileSync(path.join(de, e.name), path.join(a, e.name));
  }
}

/** El proyecto mínimo como un repo de git, con un cambio en sus pruebas para que la puerta sepa qué se tocó. */
function repoDePrueba(base) {
  const d = path.join(base, 'netfx-probe');
  copiar(FIXTURE, d);
  // fecha fija y sin mantenimiento automático: el repo de prueba sale igual en cada corrida
  const fecha = '2026-01-01T00:00:00Z';
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], {
      encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha },
    });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q'); git('config', 'user.email', 'sonda@ejemplo.invalid'); git('config', 'user.name', 'sonda');
  git('remote', 'add', 'origin', REMOTO);
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  fs.appendFileSync(path.join(d, 'NetfxProbe.Tests', 'ProbeTests.cs'), '\n// tocado\n');
  return d;
}

/** Un árbol del arnés con la configuración del perfil; `args`, si viene, es el detalle de este repo. */
function arbol(base, nombre, conf, args) {
  const a = path.join(base, nombre);
  fs.mkdirSync(path.join(a, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(a, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
  // las bibliotecas del arnés: en Windows la puerta busca ahí el bash de Git (git-bash.js) antes de lanzar el comando
  copiar(path.join(RAIZ, 'scripts', 'lib'), path.join(a, 'scripts', 'lib'));
  const copia = JSON.parse(JSON.stringify(conf));
  const receta = copia.stack.test_runners.find((r) => r.name === 'netfx-vstest');
  if (args !== undefined) receta.repos = [...(receta.repos || []), { repo: REPO, args }];
  fs.writeFileSync(path.join(a, 'team-repos.json'), JSON.stringify(copia, null, 2));
  return a;
}

function correrPuerta(dir, tree, base, nombre) {
  const home = path.join(base, `home-${nombre}`);
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_GUIDES_DIR: tree, CLAUDE_CODE_SESSION_ID: `netfx-probe-${nombre}` };
  for (const k of ['TYCON_TEST_SCOPE', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'NODE_TEST_CONTEXT']) delete env[k];
  // stable-data: el reloj sólo mide cuánto tardó la corrida para el informe; no decide ningún resultado
  const t0 = Date.now();
  const r = spawnSync(bashDeGit(), [TEST_GATE, dir], { encoding: 'utf8', cwd: dir, env, maxBuffer: 64 * 1024 * 1024 });
  let art = null;
  try { art = JSON.parse(fs.readFileSync(path.join(dir, '.advisors', 'tests-result.json'), 'utf8')); } catch (_) { art = null; }
  fs.writeFileSync(path.join(OUT, `netfx-${nombre}.log`), `${r.stdout || ''}\n${r.stderr || ''}`);
  return { status: r.status, segundos: Math.round((Date.now() - t0) / 1000), art };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let conf;
  try { conf = JSON.parse(fs.readFileSync(RECETA, 'utf8').replace(/^﻿/, '')); } catch (e) {
    process.stderr.write(`no pude leer la receta ${RECETA}: ${e.message}\n`); process.exit(2);
  }
  if (!conf.stack || !Array.isArray(conf.stack.test_runners) || !conf.stack.test_runners.some((r) => r.name === 'netfx-vstest')) {
    process.stderr.write(`${RECETA} no declara la herramienta netfx-vstest en stack.test_runners\n`); process.exit(2);
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'netfx-probe-'));
  const casos = [
    { nombre: 'sin-filtro', args: undefined, espera: { total: 2, failed: 1, verde: false } },
    { nombre: 'con-filtro', args: 'TestCategory=Unit', espera: { total: 1, failed: 0, verde: true } },
  ];
  const filas = [];
  for (const c of casos) {
    const dir = repoDePrueba(path.join(base, c.nombre));
    const r = correrPuerta(dir, arbol(base, `arbol-${c.nombre}`, conf, c.args), base, c.nombre);
    const a = r.art || {};
    const t = a.totals || {};
    const ok = a.runner === 'netfx-vstest' && t.total === c.espera.total && t.failed === c.espera.failed && a.suite_green === c.espera.verde;
    filas.push({ caso: c.nombre, ok, salida: r.status, segundos: r.segundos, runner: a.runner || null, totals: t, suite_green: a.suite_green, totals_error: a.totals_error || null, espera: c.espera });
  }
  const todo = filas.every((f) => f.ok);
  fs.writeFileSync(path.join(OUT, 'netfx-report.json'), JSON.stringify({ ok: todo, casos: filas }, null, 2));
  const md = ['# La receta netfx-vstest, de verdad', '', `Resultado: ${todo ? 'como se esperaba' : 'NO dio lo esperado'}`, '',
    '| Caso | Herramienta | Pruebas | Fallidas | Verde | Salida | Esperado |', '|---|---|---|---|---|---|---|',
    ...filas.map((f) => `| ${f.caso} | ${f.runner} | ${f.totals.total ?? '—'} | ${f.totals.failed ?? '—'} | ${f.suite_green} | ${f.salida} | ${f.espera.total} / ${f.espera.failed} / ${f.espera.verde} |`),
    '', ...filas.filter((f) => f.totals_error).map((f) => `- ${f.caso}: ${f.totals_error}`)];
  fs.writeFileSync(path.join(OUT, 'netfx-report.md'), `${md.join('\n')}\n`);
  process.stdout.write(`${md.join('\n')}\n`);
  process.exit(todo ? 0 : 1);
}

main();
