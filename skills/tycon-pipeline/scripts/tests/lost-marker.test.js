#!/usr/bin/env node
'use strict';
// lost-marker.test.js — una ejecución abierta a la que le falta una pieza frena (@story-8.121).
//
// Una ejecución abierta deja tres piezas: el marcador de la sesión, la apertura en `gates.log` (`run-open`) y una copia
// de la apertura en la carpeta de la ejecución del repo (`run-open.json`). Cada cierre legítimo anota `run-close`. Si
// falta una pieza (el marcador borrado con cualquier comando, `gates.log` borrado o movido, la copia editada), la edición,
// la consola, el cierre del turno y el commit frenan con «EJECUCIÓN PERDIDA». La salida es del dueño: `marker.js
// clear-session <sesión> --lost` o `marker.js restore <sesión>`, aprobados en la ventana de permiso o con --terminal: la
// frase en la conversación y el reenvío ya no firman. Los guiones se lanzan con la ventana dada por pasada
// (scripts/tests/lib/window-passed.js); sin ella, no cierran.
//
// Corre los guiones reales: `pipeline.js start` en una HOME y un repo de juguete, los borrados de verdad y los ganchos
// con el evento por la entrada. Los comandos que juzgan los ganchos van en las tablas de abajo, no en la línea de un
// comando: el freno de esta máquina los frenaría.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/lost-marker.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const GUARD = path.join(RAIZ, 'scripts', 'hooks', 'safety-guard-pre.sh');
const { conVentana } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));
const { inHarnessCopy } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'harness-copy.js'));
const TUID = 'toolu_8121';
const FRASE = 'autorizo cerrar la ejecución';
const PERDIDA = /EJECUCIÓN PERDIDA/;

// stable-data: la frase se compara contra la hora de la apertura, que es la del reloj real al arrancar
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
const deLaPersona = (texto, min = 2) => ({ type: 'user', timestamp: hace(min), message: { role: 'user', content: texto } });

function entorno() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-marker-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  // stable-data: los commits de juguete llevan fecha fija y el mantenimiento de git apagado
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const historia = (n, titulo) => {
    const f = path.join(repo, 'specs', `story-${n}-${titulo}.md`);
    fs.writeFileSync(f, ['---', `story: "${n}"`, `title: "${titulo}"`, 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---',
      `# Story ${n}`, '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '', '## Dev Agent Record', ''].join('\n'));
    return f;
  };
  const story = historia('9.9', 'perdida');
  const otra = historia('9.8', 'otra');
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');

  const env = (sid, extra = {}) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete e[k];
    Object.assign(e, { HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none',
      TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '', TYCON_GUIDES_DIR: RAIZ });
    if (sid) e.CLAUDE_CODE_SESSION_ID = sid;
    return Object.assign(e, extra);
  };
  const correr = (script, args, sid, extra) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: env(sid, extra), input: '', cwd: repo,
  });
  const estado = () => require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
  const gates = () => path.join(estado(), 'gates.log');
  const activo = (sid) => path.join(estado(), 'active', `${sid}.json`);
  const leerMarcador = (sid) => JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
  const eventos = (sid) => {
    if (!fs.existsSync(gates())) return [];
    return fs.readFileSync(gates(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((l) => l && (l.name === 'run-open' || l.name === 'run-close') && (!sid || l.sesion === sid));
  };
  const apertura = (sid) => eventos(sid).filter((l) => l.name === 'run-open').pop();
  const copiaDe = (sid) => { const a = apertura(sid); return a ? path.join(a.runDir, 'run-open.json') : null; };

  const arrancar = (sid, s = story, extra) => {
    const r = correr('pipeline.js', ['start', '--story', s, '--repo', repo, '--brief'], sid, extra);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    // el plan aprobado: la edición de código pasa con la ejecución sana
    const m = leerMarcador(sid);
    m.stepsCompleted = [...new Set([...(m.stepsCompleted || []), 'validate-story', 'plan', 'approve-plan'])];
    m.stepsPending = (m.stepsPending || []).filter((x) => !['validate-story', 'plan', 'approve-plan'].includes(x));
    fs.writeFileSync(activo(sid), JSON.stringify(m));
  };
  // la apertura de la sesión, corrida `min` minutos al pasado en las dos piezas (la frase se compara contra ella)
  const atrasarApertura = (sid, min) => {
    const a = apertura(sid);
    const ts = hace(min);
    const lineas = fs.readFileSync(gates(), 'utf8').split('\n').map((l) => {
      try { const o = JSON.parse(l); if (o.name === 'run-open' && o.sesion === sid && o.ts === a.ts) return JSON.stringify({ ...o, ts }); } catch { /* otra línea */ }
      return l;
    });
    fs.writeFileSync(gates(), lineas.join('\n'));
    const c = path.join(a.runDir, 'run-open.json');
    fs.writeFileSync(c, JSON.stringify({ ...JSON.parse(fs.readFileSync(c, 'utf8')), ts }));
  };
  const conversacion = (sid, registros) => {
    const dir = path.join(home, '.claude', 'projects', '-repo');
    fs.mkdirSync(dir, { recursive: true });
    let padre = null;
    const out = registros.map((r, i) => { const u = `u-${i}`; const x = { ...r, uuid: u, parentUuid: padre }; padre = u; return x; });
    out.push({ type: 'assistant', timestamp: hace(0), uuid: 'u-pedido', parentUuid: padre,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: TUID, name: 'Bash', input: {} }] } });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  const gancho = (script, sid, evento, extra) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)], {
      input: JSON.stringify({ ...(sid ? { session_id: sid } : {}), tool_use_id: TUID, cwd: repo, ...evento }), env: env(null, extra), encoding: 'utf8',
    });
    return { status: r.status, out: (r.stderr || '') + (r.stdout || '') };
  };
  const editar = (sid, archivo = 'src/a.js', extra) => gancho('on-story-gate.js', sid, { tool_name: 'Edit', tool_input: { file_path: path.join(repo, archivo) } }, extra);
  // la puerta de la consola corre desde una copia propia del arnés, igual que el guion que nombra el comando: el freno
  // reconoce un guion del arnés según el estado de git del clon
  const consola = (sid, command, tool_name = 'Bash', extra) => {
    const r = spawnSync(process.execPath, [inHarnessCopy(path.join(SCRIPTS, 'on-bash-write-gate.js'))], {
      input: JSON.stringify({ ...(sid ? { session_id: sid } : {}), tool_use_id: TUID, cwd: repo, tool_name, tool_input: { command: inHarnessCopy(command) } }),
      env: env(null, extra), encoding: 'utf8',
    });
    return { status: r.status, out: (r.stderr || '') + (r.stdout || '') };
  };
  const turno = (sid) => gancho('on-stop-dod-gate.js', sid, { hook_event_name: 'Stop' });
  const commit = (sid) => gancho('on-pre-commit.js', sid, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
  const freno = (sid, command) => {
    const r = spawnSync('bash', [GUARD], {
      input: JSON.stringify({ session_id: sid, tool_use_id: TUID, tool_name: 'Bash', tool_input: { command }, cwd: repo }), env: env(null), encoding: 'utf8',
    });
    return { status: r.status, out: r.stderr || '' };
  };
  const frenado = (r) => r.status === 2 || /"decision":"block"/.test(r.out);
  return { home, repo, story, otra, correr, estado, gates, activo, leerMarcador, eventos, apertura, copiaDe, arrancar, atrasarApertura,
    conversacion, gancho, editar, consola, turno, commit, freno, frenado };
}

// ── Las tres piezas (AC 1-2) ──────────────────────────────────────────────────────────────────────────────────────────

test('T1 RunOpen_Start_AnotaEnLosDosLugares @story-8.121 @ac-1 — run-open en gates.log y su copia en la carpeta de la ejecución, sin cierre', () => {
  const E = entorno();
  E.arrancar('s-t1');
  const a = E.apertura('s-t1');
  assert.ok(a, 'gates.log trae run-open');
  assert.strictEqual(a.sesion, 's-t1');
  assert.strictEqual(String(a.story), '9.9');
  assert.ok(a.runDir && a.runDir.includes(path.join('.advisors', 'pipeline-runs')), a.runDir);
  assert.ok(Date.parse(a.ts));
  const copia = JSON.parse(fs.readFileSync(path.join(a.runDir, 'run-open.json'), 'utf8'));
  for (const k of ['sesion', 'story', 'runDir', 'ts']) assert.deepStrictEqual(copia[k], a[k], k);
  for (const k of ['cierre', 'estado', 'close', 'closedAt', 'run-close']) assert.ok(!(k in copia), `la copia no lleva ${k}`);
  // retomar (la historia vuelve a ready-for-dev): la copia queda con la apertura nueva
  fs.writeFileSync(E.story, fs.readFileSync(E.story, 'utf8').replace('status: in-progress', 'status: ready-for-dev'));
  E.arrancar('s-t1');
  const b = E.apertura('s-t1');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(b.runDir, 'run-open.json'), 'utf8')).ts, b.ts);
  // sin carpeta para la copia, el arranque no sigue callado: frena y lo dice
  const F = entorno();
  fs.writeFileSync(path.join(F.repo, '.advisors'), 'no es una carpeta');
  const r = F.correr('pipeline.js', ['start', '--story', F.story, '--repo', F.repo, '--brief'], 's-t1-sin');
  assert.match(r.stdout + r.stderr, /apertura-failed/, r.stdout + r.stderr);
  assert.ok(!F.apertura('s-t1-sin'), 'no anotó una apertura sin copia');
  // la carpeta se anota absoluta aunque llegue relativa: los frenos la leen desde otro directorio
  const or = require(path.join(SCRIPTS, 'lib', 'open-runs.js'));
  const previo = process.cwd();
  process.chdir(E.repo);
  try {
    const a1 = or.abrir({ sid: 's-t1-rel', story: '9.9', runDir: path.join('.advisors', 'pipeline-runs', '9.9-rel'), home: E.home });
    assert.ok(path.isAbsolute(a1.runDir), a1.runDir);
  } finally { process.chdir(previo); }
});

test('T2 RunClose_CadaCaminoLegitimo_LoAnota @story-8.121 @ac-2 — clear, clear-session, adopt-session, las dos podas y el reemplazo', () => {
  const sano = (E, sid, que) => {
    const ultimo = E.eventos(sid).pop();
    assert.strictEqual(ultimo && ultimo.name, 'run-close', `${que}: el último evento de la sesión es el cierre`);
    assert.ok(ultimo.motivo, `${que}: el cierre trae su motivo`);
    assert.ok(ultimo.runDir, `${que}: el cierre trae la carpeta`);
    // la copia de esa sesión se borró (tras adoptar, la carpeta tiene la de la sesión nueva)
    const c = path.join(ultimo.runDir, 'run-open.json');
    assert.ok(!fs.existsSync(c) || JSON.parse(fs.readFileSync(c, 'utf8')).sesion !== sid, `${que}: la copia se borró`);
    for (const r of [E.editar(sid), E.consola(sid, 'echo x > src/b.js'), E.turno(sid)]) assert.doesNotMatch(r.out, PERDIDA, `${que}: ${r.out}`);
  };
  let E = entorno();
  E.arrancar('s-t2a');
  assert.strictEqual(E.correr('marker.js', ['clear', '--discard'], 's-t2a').status, 0);
  sano(E, 's-t2a', 'clear');

  E = entorno();
  E.arrancar('s-t2b');
  assert.strictEqual(E.correr('marker.js', ['clear-session', 's-t2b'], 's-otra').status, 0);
  sano(E, 's-t2b', 'clear-session');

  E = entorno();
  E.arrancar('s-t2c');
  assert.strictEqual(E.correr('marker.js', ['adopt-session', 's-t2c'], 's-t2c2').status, 0);
  sano(E, 's-t2c', 'adopt-session');
  const nueva = E.apertura('s-t2c2');
  assert.ok(nueva, 'adopt-session abre la nueva');
  assert.ok(fs.existsSync(path.join(nueva.runDir, 'run-open.json')), 'con su copia');
  assert.doesNotMatch(E.editar('s-t2c2').out, PERDIDA);
  // si no puede anotar el cierre y la apertura nueva, adopt-session sale con error, no callado
  E = entorno();
  E.arrancar('s-t2c3');
  fs.chmodSync(E.gates(), 0o444);
  try {
    const ra = E.correr('marker.js', ['adopt-session', 's-t2c3'], 's-t2c4');
    assert.notStrictEqual(ra.status, 0, ra.stderr);
    assert.match(ra.stderr, /no pude/);
  } finally { fs.chmodSync(E.gates(), 0o644); }
  // un marcador sin carpeta (de antes del registro) se adopta, y lo dice
  E = entorno();
  fs.mkdirSync(path.dirname(E.activo('s-t2c5')), { recursive: true });
  fs.writeFileSync(E.activo('s-t2c5'), JSON.stringify({ storyId: '9.9', sessionId: 's-t2c5', repoPath: E.repo, lastTouch: hace(1) }));
  const rv = E.correr('marker.js', ['adopt-session', 's-t2c5'], 's-t2c6');
  assert.strictEqual(rv.status, 0, rv.stderr);
  assert.match(rv.stderr, /sin apertura/);

  // la poda de 24 h de marker.js, corrida desde otra sesión
  E = entorno();
  E.arrancar('s-t2d');
  const viejo = E.leerMarcador('s-t2d');
  fs.writeFileSync(E.activo('s-t2d'), JSON.stringify({ ...viejo, lastTouch: hace(25 * 60) }));
  E.correr('marker.js', ['list-all'], 's-otra');
  assert.ok(!fs.existsSync(E.activo('s-t2d')), 'la poda borró el marcador');
  sano(E, 's-t2d', 'pruneStale');

  // la poda de 6 h de on-prompt.js, con un pedido de implementar desde otra sesión
  E = entorno();
  E.arrancar('s-t2e');
  fs.writeFileSync(E.activo('s-t2e'), JSON.stringify({ ...E.leerMarcador('s-t2e'), sessionId: 's-t2e', lastTouch: hace(7 * 60) }));
  E.correr('on-prompt.js', [], null);
  spawnSync(process.execPath, [path.join(SCRIPTS, 'on-prompt.js')], {
    input: JSON.stringify({ session_id: 's-otra', prompt: 'implementemos la story 9.9', cwd: E.repo }), encoding: 'utf8',
    env: { ...process.env, HOME: E.home, USERPROFILE: E.home, TYCON_GUIDES_DIR: RAIZ, TYCON_TIME_TRACKING: 'none' },
  });
  assert.ok(!fs.existsSync(E.activo('s-t2e')), 'la poda de 6 h borró el marcador');
  sano(E, 's-t2e', 'on-prompt');

  // el reemplazo por otra historia, con la ejecución anterior terminada o no
  E = entorno();
  E.arrancar('s-t2f');
  const vieja = E.apertura('s-t2f');
  // `start` de otra historia pausa con la ejecución a medias: el reemplazo es `set --replace`, después `start`
  const rr = E.correr('marker.js', ['set', JSON.stringify({ storyId: '9.8', storyPath: E.otra, repoPath: E.repo }), '--replace'], 's-t2f');
  assert.strictEqual(rr.status, 0, rr.stderr);
  E.arrancar('s-t2f', E.otra);
  const cierres = E.eventos('s-t2f').filter((l) => l.name === 'run-close');
  assert.strictEqual(cierres.length, 1, 'el reemplazo anota el cierre');
  assert.strictEqual(String(cierres[0].story), '9.9');
  assert.ok(!fs.existsSync(path.join(vieja.runDir, 'run-open.json')), 'la copia de la anterior se borró');
  assert.strictEqual(String(E.apertura('s-t2f').story), '9.8');
  assert.doesNotMatch(E.editar('s-t2f').out, PERDIDA);
});

// ── La ejecución perdida frena (AC 3-9, 17) ───────────────────────────────────────────────────────────────────────────

// las formas reales de borrar o mover el marcador que encontró el pase de la 8.113: `$M` es el marcador, `$D` una carpeta
const FORMAS = [
  ['rm', 'rm "$M"'],
  ['zip -m', 'zip -qm "$D/x.zip" "$M"'],
  ['rsync --remove-source-files', 'rsync -a --remove-source-files "$M" "$D/"'],
  ['tar --remove-files', 'tar -cf "$D/x.tar" --remove-files "$M"'],
  ['perl rename', 'perl -e \'rename $ARGV[0], $ARGV[1]\' "$M" "$D/m.json"'],
  ['ruby File.delete', 'ruby -e \'File.delete(ARGV[0])\' "$M"'],
  ['python os.remove', 'python3 -c \'import os,sys; os.remove(sys.argv[1])\' "$M"'],
];

test('T3 EjecucionPerdida_FormasDelPase_FrenaLaEdicion @story-8.121 @ac-3 — cada borrado de verdad del marcador; la edición siguiente frena', () => {
  let corridas = 0;
  for (const [nombre, forma] of FORMAS) {
    const E = entorno();
    const sid = `s-t3-${corridas}`;
    E.arrancar(sid);
    const D = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-marker-dest-'));
    spawnSync('bash', ['-c', forma], { env: { ...process.env, M: E.activo(sid), D }, stdio: 'ignore' });
    if (fs.existsSync(E.activo(sid))) continue; // esta máquina no trae el programa (o su versión no lo hace)
    corridas++;
    const r = E.editar(sid);
    assert.strictEqual(r.status, 2, `${nombre}: ${r.out}`);
    assert.match(r.out, PERDIDA, nombre);
    assert.match(r.out, /9\.9/, `${nombre}: el cartel nombra la historia`);
    assert.match(r.out, /marcador/i, `${nombre}: el cartel dice qué pieza falta`);
    assert.match(r.out, /--lost/, `${nombre}: el cartel dice la salida`);
  }
  assert.ok(corridas >= 3, `se corrieron ${corridas} formas`);
});

const borrarMarcador = (E, sid) => fs.rmSync(E.activo(sid));

test('T4 EjecucionPerdida_Consola_FrenaSinDestinos @story-8.121 @ac-4 — sed -i, una redirección, node -e, python3 -c y zip -x', () => {
  const E = entorno();
  E.arrancar('s-t4');
  borrarMarcador(E, 's-t4');
  for (const c of [
    "sed -i '' 's/1/2/' src/a.js",
    'echo x > src/b.js',
    "node -e \"require('fs').writeFileSync('src/a.js','x')\"",
    "python3 -c \"open('src/a.js','w').write('x')\"",
    'zip -r /tmp/x.zip . -x src/a.js',
  ]) {
    const r = E.consola('s-t4', c);
    assert.strictEqual(r.status, 2, `${c}: ${r.out}`);
    assert.match(r.out, PERDIDA, c);
  }
});

test('T5 EjecucionPerdida_AdhocNiApagadoPorRepo @story-8.121 @ac-5 — un ad-hoc declarado después y story_gate: false no la apagan', () => {
  let E = entorno();
  E.arrancar('s-t5a');
  borrarMarcador(E, 's-t5a');
  const ad = path.join(E.estado(), 'adhoc', 's-t5a.json');
  fs.mkdirSync(path.dirname(ad), { recursive: true });
  fs.writeFileSync(ad, JSON.stringify({ reason: 'un arreglo chico', declaredAt: new Date().toISOString(), lastTouch: new Date().toISOString() }));
  let r = E.editar('s-t5a');
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, PERDIDA);

  E = entorno();
  E.arrancar('s-t5b');
  fs.mkdirSync(path.join(E.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(E.repo, '.tycon', 'advisors.yaml'), 'pipeline:\n  story_gate: false\n');
  execFileSync('git', ['-C', E.repo, 'add', '.tycon'], { stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', E.repo, 'commit', '-qm', 'apagado'], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T10:00:00', GIT_COMMITTER_DATE: '2026-01-01T10:00:00' } });
  borrarMarcador(E, 's-t5b');
  r = E.editar('s-t5b');
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, PERDIDA);
});

test('T6 EjecucionPerdida_CierreDeTurno_Frena @story-8.121 @ac-6 — el cierre de turno frena con el cartel', () => {
  const E = entorno();
  E.arrancar('s-t6');
  borrarMarcador(E, 's-t6');
  const r = E.turno('s-t6');
  assert.ok(E.frenado(r), r.out);
  assert.match(r.out, PERDIDA);
});

test('T7 EjecucionPerdida_Commit_Frena @story-8.121 @ac-7 — el commit en el repo de la ejecución frena', () => {
  const E = entorno();
  E.arrancar('s-t7');
  borrarMarcador(E, 's-t7');
  const r = E.commit('s-t7');
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, PERDIDA);
});

test('T8 EjecucionPerdida_ListaCerrada_Pasa @story-8.121 @ac-8 — leer pasa; leer con redirección frena', () => {
  const E = entorno();
  E.arrancar('s-t8');
  borrarMarcador(E, 's-t8');
  for (const c of ['cat src/a.js', 'ls src', 'git status', 'git diff', 'git log --oneline -3', 'grep -n x src/a.js', 'head -3 src/a.js',
    'tail -3 src/a.js', `node ${MARKER} get`, 'cat src/a.js | grep x']) {
    const r = E.consola('s-t8', c);
    assert.strictEqual(r.status, 0, `${c}: ${r.out}`);
  }
  // un marker.js que no es el del arnés no lee aunque se llame igual
  fs.writeFileSync(path.join(E.repo, 'src', 'marker.js'), 'require("fs").writeFileSync("src/a.js", "x");\n');
  // ni un programa plantado con el nombre de uno que lee
  fs.writeFileSync(path.join(E.repo, 'cat'), '#!/bin/sh\necho x > src/a.js\n', { mode: 0o755 });
  for (const c of ['cat src/a.js > src/b.js', `node ${MARKER} set '{"storyId":"9.9"}'`, 'git diff --output=src/b.js', 'cat $(echo src/a.js)',
    'node src/marker.js get', './cat src/a.js']) {
    const r = E.consola('s-t8', c);
    assert.strictEqual(r.status, 2, `${c}: ${r.out}`);
    assert.match(r.out, PERDIDA, c);
  }
});

test('T9 EjecucionPerdida_RegistroBorrado_Frena @story-8.121 @ac-9 — gates.log borrado o movido, y la carpeta del estado entera', () => {
  for (const que of ['borrado', 'movido', 'carpeta entera']) {
    const E = entorno();
    const sid = `s-t9-${que.replace(/\s/g, '')}`;
    E.arrancar(sid);
    if (que === 'borrado') fs.rmSync(E.gates());
    if (que === 'movido') fs.renameSync(E.gates(), `${E.gates()}.bak`);
    if (que === 'carpeta entera') fs.rmSync(E.estado(), { recursive: true, force: true });
    const r = E.editar(sid);
    assert.strictEqual(r.status, 2, `${que}: ${r.out}`);
    assert.match(r.out, PERDIDA, que);
    assert.match(r.out, /registro|gates\.log/, `${que}: el cartel dice que falta el registro`);
  }
  // el marcador y el registro borrados, con la sesión trabajando desde la carpeta de arriba: la copia se busca también
  // en el repo del archivo
  const A = entorno();
  A.arrancar('s-t9-arriba');
  fs.rmSync(A.activo('s-t9-arriba'));
  fs.rmSync(A.gates());
  const ra = A.gancho('on-story-gate.js', 's-t9-arriba', { tool_name: 'Edit', tool_input: { file_path: path.join(A.repo, 'src', 'a.js') }, cwd: path.dirname(A.repo) });
  assert.strictEqual(ra.status, 2, ra.out);
  assert.match(ra.out, PERDIDA);
  // sin registro, con una copia vieja que volvió y cuya carpeta se ordena después: el cartel nombra la de ahora
  const E = entorno();
  E.arrancar('s-t9-orden');
  const vieja = path.join(E.repo, '.advisors', 'pipeline-runs', 'zz-vieja');
  fs.mkdirSync(vieja, { recursive: true });
  fs.writeFileSync(path.join(vieja, 'run-open.json'), JSON.stringify({ sesion: 's-t9-orden', story: '9.1', runDir: vieja, ts: hace(5 * 24 * 60) }));
  fs.rmSync(E.gates());
  const or = require(path.join(SCRIPTS, 'lib', 'open-runs.js'));
  const p = or.perdida({ sid: 's-t9-orden', cwd: E.repo, home: E.home });
  assert.strictEqual(p && p.story, '9.9', JSON.stringify(p));
});

test('T15 CopiaEditada_Frena @story-8.121 @ac-17 — la copia con otra sesión, otra historia, otra hora o un cierre agregado', () => {
  for (const [que, cambio] of [['otra sesión', { sesion: 's-nadie' }], ['otra historia', { story: '9.7' }], ['otra hora', { ts: hace(300) }],
    ['un cierre', { estado: 'completa' }]]) {
    const E = entorno();
    const sid = `s-t15-${que.replace(/\s/g, '')}`;
    E.arrancar(sid);
    const c = E.copiaDe(sid);
    fs.writeFileSync(c, JSON.stringify({ ...JSON.parse(fs.readFileSync(c, 'utf8')), ...cambio }));
    const r = E.editar(sid);
    assert.strictEqual(r.status, 2, `${que}: ${r.out}`);
    assert.match(r.out, PERDIDA, que);
  }
  // una copia ilegible que nombra la sesión no cuenta como ausente: frena
  const I = entorno();
  I.arrancar('s-t15-ilegible');
  const rota = path.join(I.repo, '.advisors', 'pipeline-runs', 'vieja');
  fs.mkdirSync(rota, { recursive: true });
  fs.writeFileSync(path.join(rota, 'run-open.json'), '{"sesion":"s-t15-ilegible", roto');
  const ri = I.editar('s-t15-ilegible');
  assert.strictEqual(ri.status, 2, ri.out);
  assert.match(ri.out, PERDIDA);
  // una copia de una ejecución ya cerrada (la trajo git de vuelta) no frena
  const E = entorno();
  E.arrancar('s-t15-git');
  const c = E.copiaDe('s-t15-git');
  const guardada = fs.readFileSync(c, 'utf8');
  assert.strictEqual(E.correr('marker.js', ['clear', '--discard'], 's-t15-git').status, 0);
  fs.writeFileSync(c, guardada);
  assert.doesNotMatch(E.editar('s-t15-git').out, PERDIDA);
});

test('T16 PrimeraCapa_RutasDelRegistro_Frenan @story-8.121 @ac-18 — rm, mv y \\rm sobre gates.log y run-open.json', () => {
  const E = entorno();
  E.arrancar('s-t16');
  const copia = E.copiaDe('s-t16');
  for (const ruta of [E.gates(), copia]) {
    for (const c of [`rm ${ruta}`, `mv ${ruta} /tmp/x`, `\\rm -f ${ruta}`]) {
      const r = E.consola('s-t16', c);
      assert.strictEqual(r.status, 2, `${c}: ${r.out}`);
      assert.match(r.out, /BORRADO DEL ESTADO DEL PIPELINE/, c);
    }
  }
});

// ── La salida (AC 10, 11, 19, 20) ─────────────────────────────────────────────────────────────────────────────────────

test('T10 EjecucionPerdida_ConVentana_SeCierra @story-8.121 @ac-10 — aprobada en la ventana, cierra la ejecución como perdida', () => {
  const E = entorno();
  E.arrancar('s-t10');
  E.atrasarApertura('s-t10', 10);
  borrarMarcador(E, 's-t10');
  // la frase en la conversación ya no la firma: la ventana o la terminal
  E.conversacion('s-t10', [deLaPersona(`${FRASE}.`, 2)]);
  const sin = E.correr('marker.js', ['clear-session', 's-t10', '--lost'], 's-t10');
  assert.notStrictEqual(sin.status, 0, 'cerró sin la ventana');
  assert.match(sin.stderr, /no pasó por la ventana/);
  assert.match(sin.stderr, /--terminal/);
  assert.ok(!E.eventos('s-t10').some((l) => l.name === 'run-close'), 'anotó un cierre sin la ventana');
  const r = E.correr('marker.js', ['clear-session', 's-t10', '--lost'], 's-t10', conVentana({}));
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const cierre = E.eventos('s-t10').pop();
  assert.strictEqual(cierre.name, 'run-close');
  assert.strictEqual(cierre.estado, 'perdida');
  assert.strictEqual(cierre.via, 'ventana');
  assert.ok(!cierre.cita, 'el cierre no lleva cita');
  assert.ok(Date.parse(cierre.ts));
  assert.ok(!fs.existsSync(path.join(cierre.runDir, 'run-open.json')), 'la copia se borró');
  assert.doesNotMatch(E.editar('s-t10').out, PERDIDA);
});

test('T11 EjecucionPerdida_SinVentana_NoSeCierra @story-8.121 @ac-11 — sin la ventana ni la terminal, ni con la frase', () => {
  for (const sub of ['clear-session', 'restore']) {
    const extra = sub === 'clear-session' ? ['--lost'] : [];
    const E = entorno();
    const sid = 's-t11';
    E.arrancar(sid);
    E.atrasarApertura(sid, 10);
    borrarMarcador(E, sid);
    E.conversacion(sid, [deLaPersona(`${FRASE}.`, 2)]);
    // lo que pide el freno (la ventana) se prueba en proceso, con el árbol y la casa inyectados
    // (scripts/tests/owner-window.test.js): por subproceso leería el árbol real y escribiría en la casa de la cuenta.
    // Acá, el guion: sin la ventana no cierra, y dice cómo se firma en la terminal.
    const r = E.correr('marker.js', [sub, sid, ...extra], sid);
    assert.notStrictEqual(r.status, 0, `${sub}: el guion cerró sin la ventana`);
    assert.match(r.stderr, /no pasó por la ventana/, sub);
    assert.match(r.stderr, new RegExp(`${sub}[^\\n]*--terminal`), `${sub}: dice el comando de la terminal`);
    assert.ok(!E.eventos(sid).some((l) => l.name === 'run-close' && l.estado === 'perdida'), sub);
  }
  // las otras salidas del marcador no sacan una ejecución perdida (la copia borrada, el marcador vivo)
  const otras = [
    ['clear', (E, sid) => E.correr('marker.js', ['clear'], sid)],
    ['clear-session sin --lost', (E, sid) => E.correr('marker.js', ['clear-session', sid], 's-ajena')],
    ['adopt-session', (E, sid) => E.correr('marker.js', ['adopt-session', sid], 's-ajena')],
    ['set', (E, sid) => E.correr('marker.js', ['set', JSON.stringify({ storyId: '9.8', storyPath: E.otra, repoPath: E.repo }), '--replace'], sid)],
    ['poda de marker.js', (E, sid) => {
      fs.writeFileSync(E.activo(sid), JSON.stringify({ ...E.leerMarcador(sid), lastTouch: hace(25 * 60) }));
      return E.correr('marker.js', ['list-all'], 's-ajena');
    }],
    ['poda de on-prompt', (E, sid) => {
      fs.writeFileSync(E.activo(sid), JSON.stringify({ ...E.leerMarcador(sid), sessionId: sid, lastTouch: hace(7 * 60) }));
      return spawnSync(process.execPath, [path.join(SCRIPTS, 'on-prompt.js')], {
        input: JSON.stringify({ session_id: 's-ajena', prompt: 'implementemos la story 9.9', cwd: E.repo }), encoding: 'utf8',
        env: { ...process.env, HOME: E.home, USERPROFILE: E.home, TYCON_GUIDES_DIR: RAIZ, TYCON_TIME_TRACKING: 'none' },
      });
    }],
  ];
  for (const [que, salir] of otras) {
    const E = entorno();
    const sid = `s-t11o-${que.replace(/\W/g, '')}`;
    E.arrancar(sid);
    fs.rmSync(E.copiaDe(sid));
    salir(E, sid);
    assert.ok(!E.eventos(sid).some((l) => l.name === 'run-close'), `${que}: anotó un cierre sin la frase`);
    assert.ok(fs.existsSync(E.activo(sid)), `${que}: borró el marcador`);
    assert.match(E.editar(sid).out, PERDIDA, `${que}: la ejecución dejó de estar perdida`);
  }
  // adoptar otra ejecución no tapa la perdida de la sesión que adopta
  const D = entorno();
  D.arrancar('s-t11d-sana', D.otra);
  D.arrancar('s-t11d');
  borrarMarcador(D, 's-t11d');
  assert.notStrictEqual(D.correr('marker.js', ['adopt-session', 's-t11d-sana'], 's-t11d').status, 0, 'adoptó sobre una ejecución perdida');
  assert.match(D.editar('s-t11d').out, PERDIDA);
  // y la consola no deja pasar clear-session sin --lost como si fuera leer
  const C = entorno();
  C.arrancar('s-t11c');
  fs.rmSync(C.copiaDe('s-t11c'));
  const rc = C.consola('s-t11c', `node ${MARKER} clear-session s-t11c`);
  assert.strictEqual(rc.status, 2, rc.out);
  // la sesión escrita con una variable: no se sabe cuándo se abrió la ejecución, y frena aunque haya frase
  const V = entorno();
  V.arrancar('s-t11v');
  V.atrasarApertura('s-t11v', 10);
  borrarMarcador(V, 's-t11v');
  V.conversacion('s-t11v', [deLaPersona(`${FRASE}.`, 2)]);
  const fv = V.freno('s-t11v', `node ${MARKER} clear-session $SID --lost`);
  assert.strictEqual(fv.status, 2, fv.out);
  assert.match(fv.out, /literal/);
});

test('T17 Restore_ConFrase_ReabreSinFraseFrena @story-8.121 @ac-19 — restore con la frase reabre desde la copia', () => {
  const E = entorno();
  E.arrancar('s-t17');
  const antes = E.apertura('s-t17');
  E.atrasarApertura('s-t17', 10);
  borrarMarcador(E, 's-t17');
  const r = E.correr('marker.js', ['restore', 's-t17'], 's-t17', conVentana({}));
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const m = E.leerMarcador('s-t17');
  assert.strictEqual(String(m.storyId), '9.9');
  assert.strictEqual(m.storyPath, E.story);
  assert.strictEqual(m.runDir, antes.runDir);
  const nueva = E.apertura('s-t17');
  assert.strictEqual(nueva.motivo, 'restaurada');
  assert.doesNotMatch(E.editar('s-t17').out, PERDIDA);
  // restaurar desde una sesión con su propia ejecución: la propia queda cerrada, no pisada callada
  const F = entorno();
  F.arrancar('s-t17y', F.otra);
  F.arrancar('s-t17x');
  F.atrasarApertura('s-t17x', 10);
  borrarMarcador(F, 's-t17x');
  const ry = F.correr('marker.js', ['restore', 's-t17x'], 's-t17y', conVentana({}));
  assert.strictEqual(ry.status, 0, ry.stderr + ry.stdout);
  const cierre = F.eventos('s-t17y').find((l) => l.name === 'run-close');
  assert.ok(cierre && String(cierre.story) === '9.8', 'la ejecución propia (9.8) quedó cerrada');
  assert.doesNotMatch(F.editar('s-t17y').out, PERDIDA);
});

test('T18 ClearSessionSinLost_NoAnotaCierre @story-8.121 @ac-20 — sin --lost y sin marcador no cierra y nombra --lost', () => {
  const E = entorno();
  E.arrancar('s-t18');
  borrarMarcador(E, 's-t18');
  const antes = E.eventos('s-t18').length;
  const r = E.correr('marker.js', ['clear-session', 's-t18'], 's-t18');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--lost/);
  assert.strictEqual(E.eventos('s-t18').length, antes, 'no anotó nada');
});

// ── No-regresión, Codex y Windows (AC 12-13) ──────────────────────────────────────────────────────────────────────────

test('T13 EjecucionPerdida_CodexYPowerShell @story-8.121 @ac-13 — la sesión de Codex, la herramienta PowerShell y las rutas de Windows', () => {
  // Codex: el marcador y la apertura con CODEX_SESSION_ID; el evento sin session_id
  let E = entorno();
  const cx = { CODEX_SESSION_ID: 's-t13cx' };
  const r0 = E.correr('pipeline.js', ['start', '--story', E.story, '--repo', E.repo, '--brief'], null, cx);
  assert.strictEqual(r0.status, 0, r0.stderr + r0.stdout);
  assert.ok(E.apertura('s-t13cx'), 'la apertura lleva la sesión de Codex');
  // con la ejecución sana, otra sesión que llega por el evento no frena (sin falso positivo)
  assert.doesNotMatch(E.editar('s-t13-otra', 'src/a.js', cx).out, PERDIDA);
  borrarMarcador(E, 's-t13cx');
  for (const r of [E.editar(null, 'src/a.js', cx), E.consola(null, 'echo x > src/b.js', 'Bash', cx)]) {
    assert.strictEqual(r.status, 2, r.out);
    assert.match(r.out, PERDIDA);
  }
  // PowerShell
  E = entorno();
  E.arrancar('s-t13ps');
  borrarMarcador(E, 's-t13ps');
  const ps = E.consola('s-t13ps', 'Set-Content -Path src/a.js -Value x', 'PowerShell');
  assert.strictEqual(ps.status, 2, ps.out);
  assert.match(ps.out, PERDIDA);
  // Windows: la carpeta con barras invertidas y otras mayúsculas es la misma
  const or = require(path.join(SCRIPTS, 'lib', 'open-runs.js'));
  assert.strictEqual(or.mismaRuta('C:\\Repo\\.advisors\\pipeline-runs\\9.9-1', 'c:/repo/.advisors/pipeline-runs/9.9-1', 'win32'), true);
  assert.strictEqual(or.mismaRuta('/repo/A', '/repo/a', 'linux'), false);
  E = entorno();
  E.arrancar('s-t13w');
  const c = E.copiaDe('s-t13w');
  const copia = JSON.parse(fs.readFileSync(c, 'utf8'));
  fs.writeFileSync(c, JSON.stringify({ ...copia, runDir: copia.runDir.toUpperCase().replace(/\//g, '\\') }));
  assert.strictEqual(or.perdida({ sid: 's-t13w', cwd: E.repo, home: E.home, platform: 'win32' }), null, 'en Windows es la misma carpeta');
  assert.ok(or.perdida({ sid: 's-t13w', cwd: E.repo, home: E.home, platform: 'linux' }), 'fuera de Windows no lo es');
});

test('T14 NoRegresion_CerradaSinEjecucionYPrimeraCapa @story-8.121 @ac-12 — sin ejecución nada cambia; la primera capa frena lo de siempre', () => {
  const E = entorno();
  // una sesión sin ejecución y sin ad-hoc: el repo no está bajo el arnés, pasa como hoy
  for (const r of [E.editar('s-t14'), E.consola('s-t14', 'echo x > src/b.js'), E.turno('s-t14'), E.commit('s-t14')]) {
    assert.doesNotMatch(r.out, PERDIDA, r.out);
  }
  // otra sesión con su ejecución sana no frena a ésta
  E.arrancar('s-t14-otra');
  assert.doesNotMatch(E.editar('s-t14').out, PERDIDA);
  // la primera capa frena lo mismo que hoy
  const activos = path.join(E.estado(), 'active');
  for (const c of [`rm -rf ${activos}`, `mv ${E.activo('s-t14-otra')} /tmp/x`]) {
    const r = E.consola('s-t14-otra', c);
    assert.strictEqual(r.status, 2, `${c}: ${r.out}`);
    assert.match(r.out, /BORRADO DEL ESTADO DEL PIPELINE/, c);
  }
});

// stable-data: T14b mide cuánto tarda leer el registro; ninguna fecha entra en lo que se compara.
test('T14b NoRegresion_RegistroGrandeNoSubeElCosto @story-8.121 @ac-12 — el registro de megas se lee sin partirlo en renglones', () => {
  const or = require(path.join(SCRIPTS, 'lib', 'open-runs.js'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-marker-t14b-'));
  const g = or.gatesPath(home);
  fs.mkdirSync(path.dirname(g), { recursive: true });
  const ruido = JSON.stringify({ ts: '2026-10-25T00:00:00Z', name: 'story-gate', status: 'ok', via: 'Bash: ls' });
  const partes = [];
  for (let i = 0; i < 40000; i++) partes.push(ruido);
  partes.splice(100, 0, JSON.stringify({ ts: 't1', name: 'run-open', sesion: 's-a', story: '9.9', runDir: '/r/a' }) + '\r');
  partes.splice(20000, 0, JSON.stringify({ ts: 't2', name: 'story-gate', sesion: 's-a', via: 'Bash: echo "run-open"' }));
  partes.splice(30000, 0, '{"name":"run-open", roto');
  partes.push(JSON.stringify({ ts: 't3', name: 'run-close', sesion: 's-a', runDir: '/r/a' }));
  fs.writeFileSync(g, partes.join('\n'));   // el último renglón sin salto
  const r = or.leerEventos(home);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.eventos.map((e) => `${e.name}:${e.ts}`), ['run-open:t1', 'run-close:t3'], 'sólo las aperturas y los cierres, en orden');
  // alternadas, para que la carga de la máquina pese igual: leer los eventos cuesta menos de la mitad que partir el
  // registro en renglones, que corría en cada comando de consola y le sumaba más de un tercio
  const vuelta = (f) => { const t0 = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const mediana = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const partir = () => fs.readFileSync(g, 'utf8').split('\n').filter((l) => l.includes('"run-open"') || l.includes('"run-close"'));
  const renglones = [], eventos = [];
  for (let i = 0; i < 15; i++) { renglones.push(vuelta(partir)); eventos.push(vuelta(() => or.leerEventos(home))); }
  const [a, b] = [mediana(renglones), mediana(eventos)];
  assert.ok(b <= a / 2, `partir en renglones ${a.toFixed(1)} ms, leer los eventos ${b.toFixed(1)} ms (más de la mitad)`);
});
