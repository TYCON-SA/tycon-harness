#!/usr/bin/env node
'use strict';
// preflight-missing.test.js — el arranque del pipeline (`pipeline.js start`) agrega sus líneas al .gitignore con el fin
// de línea del archivo, y avisa en un bloque «Falta antes de arrancar» lo que la ejecución va a necesitar y esta máquina
// no tiene: el programa de la plataforma del pedido de trabajo, la configuración de BMAD del repo y el servidor MCP de
// la herramienta de horas. El bloque no frena.
//
// Corre `pipeline.js` real con un HOME temporal, un repo de juguete y el id de sesión fijado en el proceso hijo.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/preflight-missing.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const P = () => require(path.join(SCRIPTS, 'pipeline.js'));
const WIN = process.platform === 'win32';
const PROG = JSON.parse(fs.readFileSync(path.join(RAIZ, 'integrations', 'azure-devops', 'integration.json'), 'utf8')).rawCommands[0].split(/\s+/)[0];

function entorno({ gitignore = null, autocrlf = null, workItem = false, bmad = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-missing-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'), WIN ? 'junction' : 'dir');
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'), WIN ? 'junction' : 'dir');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  if (autocrlf !== null) git('config', 'core.autocrlf', autocrlf);
  if (gitignore !== null) fs.writeFileSync(path.join(repo, '.gitignore'), gitignore);
  if (bmad) {
    fs.mkdirSync(path.join(repo, '_bmad', 'bmm'), { recursive: true });
    fs.writeFileSync(path.join(repo, '_bmad', 'bmm', 'config.yaml'), 'user_name: t\n');
  }
  const story = path.join(repo, 'specs', 'story-9.9-preflight.md');
  fs.writeFileSync(story, ['---', 'story: "9.9"', 'title: "preflight"', 'status: ready-for-dev', ...(workItem ? ['ado_work_item: 123'] : []), '---',
    '# Story 9.9', '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', ''].join('\n'));
  git('add', '.');
  git('commit', '-qm', 'inicio');
  return { base, home, repo, story, git };
}

// El PATH del proceso hijo sin el programa de la plataforma: las carpetas que lo traen se sacan, y lo que el arranque
// sí necesita de ellas (git y el buscador de programas) queda por un enlace en una carpeta propia.
function pathSin(base, prog) {
  const sep = path.delimiter;
  const nombres = WIN ? [`${prog}.cmd`, `${prog}.exe`, `${prog}.bat`, prog] : [prog];
  const tiene = (d) => nombres.some((n) => { try { return fs.statSync(path.join(d, n)).isFile(); } catch { return false; } });
  const propios = path.join(base, 'bin-propio');
  fs.mkdirSync(propios, { recursive: true });
  const dirs = String(process.env.PATH || process.env.Path || '').split(sep).filter(Boolean);
  for (const d of dirs.filter(tiene)) {
    for (const n of ['git', 'which', 'node']) {
      const f = path.join(d, n);
      if (fs.existsSync(f) && !fs.existsSync(path.join(propios, n))) fs.symlinkSync(f, path.join(propios, n));
    }
  }
  return [propios, path.dirname(process.execPath), ...dirs.filter((d) => !tiene(d))].join(sep);
}

// Un programa falso de la plataforma, adelante en el PATH: contesta y sale 0.
function pathCon(base, prog) {
  const d = path.join(base, 'bin-falso');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, prog), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (WIN) fs.writeFileSync(path.join(d, `${prog}.cmd`), '@exit /b 0\r\n');
  return [d, process.env.PATH || process.env.Path || ''].join(path.delimiter);
}

function correr(E, extra, sid) {
  const env = { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none', ...extra };
  if (WIN && extra.PATH) { delete env.Path; }
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'start', '--story', E.story, '--repo', E.repo, '--brief'], { encoding: 'utf8', env, input: '', cwd: E.repo });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* lo dice la aserción */ }
  return { ...r, out };
}

test('T37 Gitignore_CRLF_SoloAgrega @story-8.93 @ac-19 — las líneas nuevas con el fin de línea del archivo; numstat N y 0', () => {
  const { gitignoreAppendText } = P();
  // la función: el fin de línea del primer salto; vacío o sin saltos, LF; sin salto final, uno antes
  assert.strictEqual(gitignoreAppendText('a\r\nb\r\n', ['x', 'y']), 'x\r\ny\r\n');
  assert.strictEqual(gitignoreAppendText('a\nb\n', ['x']), 'x\n');
  assert.strictEqual(gitignoreAppendText('', ['x']), 'x\n');
  assert.strictEqual(gitignoreAppendText('a', ['x']), '\nx\n');
  assert.strictEqual(gitignoreAppendText('a\r\nb', ['x']), '\r\nx\r\n');
  assert.strictEqual(gitignoreAppendText('a\r\nb\nc\n', ['x']), 'x\r\n', 'mixto: manda el primer salto');

  // el arranque real, con CRLF y LF, con core.autocrlf en true, false y sin tocar
  for (const [nombre, eol] of [['crlf', '\r\n'], ['lf', '\n']]) {
    for (const autocrlf of ['true', 'false', null]) {
      if (eol === '\n' && autocrlf === 'true') continue;   // un LF con autocrlf=true sale CRLF del checkout: es el caso CRLF
      const original = ['node_modules/', 'dist/', ''].join(eol);
      const E = entorno({ gitignore: original, autocrlf });
      const r = correr(E, {}, `s-t37-${nombre}-${autocrlf}`);
      assert.strictEqual(r.status, 0, `${nombre}/${autocrlf}: ${r.stderr}`);
      const ahora = fs.readFileSync(path.join(E.repo, '.gitignore'), 'utf8');
      assert.ok(ahora.startsWith(original), `${nombre}/${autocrlf}: lo de antes quedó igual`);
      const agregado = ahora.slice(original.length);
      assert.ok(agregado.length > 0, `${nombre}/${autocrlf}: agregó sus líneas`);
      const lineas = agregado.split(eol).slice(0, -1);
      assert.ok(agregado.endsWith(eol), `${nombre}/${autocrlf}: termina con ${JSON.stringify(eol)}`);
      if (eol === '\r\n') assert.ok(!/[^\r]\n/.test(agregado), `${nombre}/${autocrlf}: ningún LF suelto en lo agregado`);
      else assert.ok(!agregado.includes('\r'), `${nombre}/${autocrlf}: ningún CR en lo agregado`);
      const numstat = E.git('diff', '--numstat', '--', '.gitignore').trim().split(/\s+/);
      assert.strictEqual(numstat[0], String(lineas.length), `${nombre}/${autocrlf}: agregadas ${numstat.join(' ')}`);
      assert.strictEqual(numstat[1], '0', `${nombre}/${autocrlf}: borradas ${numstat.join(' ')}`);
    }
  }

  // un .gitignore que no se puede escribir: lo dice en las acciones y no frena
  if (!WIN && process.getuid && process.getuid() !== 0) {
    const E = entorno({ gitignore: 'node_modules/\n' });
    fs.chmodSync(path.join(E.repo, '.gitignore'), 0o444);
    const r = correr(E, {}, 's-t37-solo-lectura');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.out.acciones.some((a) => /^PIPE-C2: no pude agregar al \.gitignore/.test(a)), JSON.stringify(r.out.acciones));
  }
});

test('T39 Start_AvisaLoQueFalta @story-8.93 @ac-20 — sin el programa de la plataforma, sin BMAD y sin el MCP de horas: tres líneas y no frena', () => {
  const E = entorno({ gitignore: '', workItem: true });
  const r = correr(E, { PATH: pathSin(E.base, PROG), TYCON_PLATFORM: 'azure-devops', TYCON_TIME_TRACKING: 'clockify' }, 's-t39');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(r.out.ready, true);
  const faltas = r.out.missing_before_start;
  assert.ok(Array.isArray(faltas), `trae missing_before_start: ${r.stdout}`);
  assert.strictEqual(faltas.length, 3, JSON.stringify(faltas));
  for (const f of faltas) for (const k of ['falta', 'sin_eso', 'como']) assert.ok(String(f[k] || '').trim(), `${k} en ${JSON.stringify(f)}`);
  const [plataforma, bmad, horas] = ['plataforma', 'bmad', 'horas'].map((id) => faltas.find((f) => f.id === id));
  assert.match(plataforma.falta, new RegExp(`\\b${PROG}\\b`));
  assert.match(plataforma.sin_eso, /start-warning ado/);
  assert.match(bmad.falta, /_bmad\/bmm\/config\.yaml/);
  assert.match(bmad.sin_eso, /sin BMAD/);
  assert.match(horas.falta, /clockify/i);
  assert.match(horas.sin_eso, /start-warning time-tracking/);
  const linea = r.out.acciones.find((a) => a.startsWith('Falta antes de arrancar:'));
  assert.ok(linea, `la línea en las acciones: ${JSON.stringify(r.out.acciones)}`);

  // con una pausa (rama protegida), el bloque sale igual
  const Ep = entorno({ gitignore: '', workItem: true });
  Ep.git('checkout', '-q', '-b', 'main');
  const rp = correr(Ep, { PATH: pathSin(Ep.base, PROG), TYCON_PLATFORM: 'azure-devops', TYCON_TIME_TRACKING: 'clockify' }, 's-t39-pausa');
  assert.strictEqual(rp.out.ready, false);
  assert.strictEqual((rp.out.missing_before_start || []).length, 3, rp.stdout);

  // un detector que no puede mirar no inventa una falta: deja su motivo
  const noMedido = [];
  const fmRoto = { get work_item() { throw new Error('frontmatter ilegible'); }, get ado_work_item() { throw new Error('frontmatter ilegible'); } };
  const faltasRotas = P().computeMissingBeforeStart({ repo: E.repo, fm: fmRoto, env: { TYCON_TIME_TRACKING: 'none' }, home: E.home, noMedido });
  assert.ok(!faltasRotas.some((f) => f.id === 'plataforma'), JSON.stringify(faltasRotas));
  assert.ok(noMedido.some((m) => /plataforma \(frontmatter ilegible\)/.test(m)), JSON.stringify(noMedido));
});

test('T40 Start_TodoPresente_SinBloque @story-8.93 @ac-20 — programa presente, BMAD configurado y horas apagadas: sin el bloque', () => {
  const E = entorno({ gitignore: '', workItem: true, bmad: true });
  const r = correr(E, { PATH: pathCon(E.base, PROG), TYCON_PLATFORM: 'azure-devops', TYCON_TIME_TRACKING: 'none' }, 's-t40');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.ok(!('missing_before_start' in r.out), r.stdout);
  assert.ok(!r.out.acciones.some((a) => a.startsWith('Falta antes de arrancar:')), JSON.stringify(r.out.acciones));

  // el MCP de horas declarado en ~/.claude.json: tampoco sale
  const Em = entorno({ gitignore: '', bmad: true });
  fs.writeFileSync(path.join(Em.home, '.claude.json'), JSON.stringify({ mcpServers: { clockify: { command: 'x' } } }));
  const rm = correr(Em, { TYCON_TIME_TRACKING: 'clockify' }, 's-t40-mcp');
  assert.ok(!('missing_before_start' in rm.out), rm.stdout);

  // el servidor del proyecto se encuentra con la clave que escribe Claude Code: la ruta real (el repo llega por un
  // enlace), con `/` en Windows, y la del repo principal desde un worktree
  const { computeMissingBeforeStart } = P();
  const horas = (repo, home, noMedido = []) => computeMissingBeforeStart({ repo, fm: {}, env: { TYCON_TIME_TRACKING: 'clockify' }, home, noMedido }).filter((f) => f.id === 'horas');
  const delProyecto = (home, clave) => fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [clave]: { mcpServers: { clockify: { command: 'x' } } } } }));
  const Er = entorno({ bmad: true });
  const real = fs.realpathSync.native(Er.repo);
  const enlace = path.join(Er.base, 'enlace');
  fs.symlinkSync(Er.repo, enlace, WIN ? 'junction' : 'dir');
  delProyecto(Er.home, WIN ? real.replace(/\\/g, '/') : real);
  assert.deepStrictEqual(horas(enlace, Er.home), [], 'por un enlace, con la clave de la ruta real');
  assert.deepStrictEqual(horas(Er.repo, Er.home), [], 'con la ruta del repo');
  const wt = path.join(Er.base, 'wt');
  Er.git('worktree', 'add', '-q', '-b', 'otra', wt);
  assert.deepStrictEqual(horas(wt, Er.home), [], 'desde un worktree, con la clave del repo principal');
  delProyecto(Er.home, path.join(Er.base, 'otro-repo'));
  assert.strictEqual(horas(Er.repo, Er.home).length, 1, 'la clave de otro proyecto no cuenta');

  // un ~/.claude.json ilegible o una configuración del arnés rota: no inventa la falta, deja el motivo
  fs.writeFileSync(path.join(Er.home, '.claude.json'), '{ roto');
  const nm1 = [];
  assert.deepStrictEqual(horas(Er.repo, Er.home, nm1), []);
  assert.ok(nm1.some((m) => /\.claude\.json no es JSON válido/.test(m)), JSON.stringify(nm1));
  fs.unlinkSync(path.join(Er.home, '.claude.json'));
  fs.writeFileSync(path.join(Er.home, '.claude', 'tycon.json'), '{ roto');
  const nm2 = [];
  assert.deepStrictEqual(horas(Er.repo, Er.home, nm2), []);
  assert.ok(nm2.some((m) => /servidor MCP de la herramienta de horas/.test(m)), JSON.stringify(nm2));
});
