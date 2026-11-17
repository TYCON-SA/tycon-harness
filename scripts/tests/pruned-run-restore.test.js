'use strict';
// pruned-run-restore.test.js — una ejecución que espera un turno con la espera anotada (`marker.js doing --waiting-for`)
// no se poda por vieja, en ninguna de las tres podas (marker.js, on-prompt.js y story-gate-io.js); la que se poda deja una
// copia y `marker.js restore <sesión>` la rearma con sus pasos; la guía dice cómo.
//
// Corre los guiones reales en una HOME y un repo de juguete. Correr: node --test scripts/tests/pruned-run-restore.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts');
const IO = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
const { conVentana } = require(path.join(ROOT, 'scripts', 'tests', 'lib', 'window-passed.js'));

const hace = (h) => new Date(Date.now() - h * 3600000).toISOString();

function entorno() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pruned-run-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(ROOT, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(ROOT, path.join(home, '.claude', 'tycon-harness'));
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
  const historia = (n) => {
    const f = path.join(repo, 'specs', `story-${n}-espera.md`);
    fs.writeFileSync(f, ['---', `story: "${n}"`, 'title: "espera"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---',
      `# Story ${n}`, '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '', '## Dev Agent Record', ''].join('\n'));
    return f;
  };
  const story = historia('9.9');
  const stories = { 's-espera': story, 's-sin-nota': historia('9.8'), 's-nota-vieja': historia('9.7'), 's-podada': historia('9.6') };
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid, extra = {}) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete e[k];
    Object.assign(e, { HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none',
      TYCON_MUTATION_CHECK: 'off', TYCON_GUIDES_DIR: ROOT });
    if (sid) e.CLAUDE_CODE_SESSION_ID = sid;
    return Object.assign(e, extra);
  };
  const correr = (script, args, sid, extra) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: env(sid, extra), input: '', cwd: repo,
  });
  const estado = require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
  const activo = (sid) => path.join(estado, 'active', `${sid}.json`);
  const leer = (sid) => JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
  /** Una ejecución abierta de verdad, con el plan aprobado, y su último toque `horas` atrás. */
  const arrancar = (sid, horas) => {
    const r = correr('pipeline.js', ['start', '--story', stories[sid] || story, '--repo', repo, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    const m = leer(sid);
    m.stepsCompleted = [...new Set([...(m.stepsCompleted || []), 'validate-story', 'plan', 'approve-plan'])];
    m.stepsPending = (m.stepsPending || []).filter((x) => !['validate-story', 'plan', 'approve-plan'].includes(x));
    m.lastTouch = hace(horas);
    fs.writeFileSync(activo(sid), JSON.stringify(m));
  };
  /** Un marcador de otra sesión escrito a mano, sin apertura: para la poda de on-prompt y del portón. */
  const marcador = (sid, horas) => {
    fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
    fs.writeFileSync(activo(sid), JSON.stringify({ storyId: '9.9', storyPath: story, repoPath: repo, sessionId: sid, lastTouch: hace(horas),
      startedAt: hace(horas + 1), stepsCompleted: ['start'], stepsPending: ['implement'] }));
  };
  const espera = (sid, horas) => {
    fs.mkdirSync(path.join(estado, 'doing'), { recursive: true });
    fs.writeFileSync(path.join(estado, 'doing', `${sid}.json`), JSON.stringify({ text: 'espera el turno de suite', at: hace(horas), waitingFor: 'el turno de suite de la coordinadora', waitingSince: hace(horas) }));
  };
  return { home, repo, story, estado, correr, activo, leer, arrancar, marcador, espera };
}

test('T37 Poda_EsperaDeTurno_NoSePodaEnMarker @story-8.202 @ac-33', () => {
  const E = entorno();
  E.arrancar('s-espera', 30);
  E.espera('s-espera', 1);
  E.arrancar('s-sin-nota', 30);
  E.arrancar('s-nota-vieja', 30);
  E.espera('s-nota-vieja', 30);
  const r = E.correr('marker.js', ['list-all'], 's-otra');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(E.activo('s-espera')), 'la que espera turno sigue');
  assert.ok(!fs.existsSync(E.activo('s-sin-nota')), 'sin nota, se poda');
  assert.ok(!fs.existsSync(E.activo('s-nota-vieja')), 'con la nota de más de 24 h, se poda');
});

test('T38 Poda_EsperaDeTurno_NoSePodaEnOnPrompt @story-8.202 @ac-34', () => {
  const E = entorno();
  E.marcador('s-espera', 8);
  E.espera('s-espera', 1);
  E.marcador('s-sin-nota', 8);
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-prompt.js')], {
    input: JSON.stringify({ session_id: 's-otra', hook_event_name: 'UserPromptSubmit', prompt: 'implementemos la story 9.9', cwd: E.repo }),
    env: { ...process.env, HOME: E.home, USERPROFILE: E.home, TYCON_HOME: '', CLAUDE_CODE_SESSION_ID: 's-otra' }, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(E.activo('s-espera')), 'la que espera turno sigue');
  assert.match(r.stdout + r.stderr, /s-espera/, 'y la lista la cuenta como ocupada');
  assert.ok(!fs.existsSync(E.activo('s-sin-nota')), 'sin nota, se poda como hoy');
});

test('T39 StoryGate_EsperaDeTurno_SigueOcupada @story-8.202 @ac-34', () => {
  const E = entorno();
  E.marcador('s-espera', 8);
  E.espera('s-espera', 1);
  E.marcador('s-sin-nota', 8);
  const otras = IO.listOtherMarkers(E.estado, 's-yo', path.join(E.repo, 'src', 'a.js')).map((m) => m.sessionId);
  assert.deepStrictEqual(otras, ['s-espera']);
  assert.ok(IO.waitingTurn(E.estado, 's-espera'));
  assert.strictEqual(IO.waitingTurn(E.estado, 's-sin-nota'), null);
});

test('T40 Poda_GuardaCopia_YRestoreLaRearma @story-8.202 @ac-35', () => {
  const E = entorno();
  E.arrancar('s-podada', 30);
  const r = E.correr('marker.js', ['list-all'], 's-otra');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(E.activo('s-podada')), 'se podó');
  const copia = path.join(E.estado, 'pruned', 's-podada.json');
  assert.ok(fs.existsSync(copia), 'dejó la copia');
  assert.ok(JSON.parse(fs.readFileSync(copia, 'utf8')).stepsCompleted.includes('approve-plan'));
  const rr = E.correr('marker.js', ['restore', 's-podada'], 's-nueva', conVentana({}));
  assert.strictEqual(rr.status, 0, rr.stderr + rr.stdout);
  const m = E.leer('s-nueva');
  assert.strictEqual(String(m.storyId), '9.6');
  assert.ok(m.stepsCompleted.includes('approve-plan'), 'con sus pasos hechos');
  assert.ok(m.stepsPending.includes('implement') && !m.stepsPending.includes('plan'), 'y sus pendientes');
  assert.ok(!fs.existsSync(copia), 'la copia se borra');
  // sin copia ni apertura: el mensaje de siempre
  const rn = E.correr('marker.js', ['restore', 's-nadie'], 's-nueva2', conVentana({}));
  assert.notStrictEqual(rn.status, 0);
  assert.match(rn.stderr, /no tiene una ejecución abierta/);
});

test('T41 Guia_DiceComoSeRecuperaUnaPodada @story-8.202 @ac-36', () => {
  const es = fs.readFileSync(path.join(ROOT, 'guides', 'coordination.md'), 'utf8');
  const en = fs.readFileSync(path.join(ROOT, 'guides', 'coordination.en.md'), 'utf8');
  for (const g of [es, en]) assert.match(g, /marker\.js restore <sesi(ó|o)n>|marker\.js restore <session>/);
  assert.match(es, /poda[^\n]*24 h/);
  assert.match(en, /pruned[^\n]*\n?[^\n]*24 h|24 h[^\n]*prun/);
});

// ── La corrida podada se recupera: la ventana del dueño, el restore que no pisa y el orden de los cierres ──────────

const RESTORE_STEPS = path.join(SCRIPTS, 'lib', 'restore-steps.js');
const SOURCES = path.join(ROOT, 'scripts', 'lib', 'signature-sources.js');

/** Una corrida podada de verdad: se arranca, se envejece y la poda de `list-all` la guarda en `pruned/`. */
function podada(E, sid = 's-podada') {
  E.arrancar(sid, 30);
  const r = E.correr('marker.js', ['list-all'], 's-otra');
  assert.strictEqual(r.status, 0, r.stderr);
  const copia = path.join(E.estado, 'pruned', `${sid}.json`);
  assert.ok(fs.existsSync(copia), 'la poda dejó la copia');
  return copia;
}

/** El renglón `frena=` del freno para un comando: [escape, subcomando, argumento, desde]. */
function frenoDe(E, comando) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'run-close.js'), '--gate', '--session', 's-pide', '--command-stdin'], {
    encoding: 'utf8', input: comando, cwd: E.repo, env: { ...process.env, HOME: E.home, USERPROFILE: E.home, TYCON_HOME: '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const l = r.stdout.split('\n').find((x) => x.startsWith('frena='));
  return l ? l.slice('frena='.length).split('\t') : null;
}

// T4 Restore_PrunedWithoutOpening_GuardShowsWindow — @story-8.288 @ac-5 @ac-6
// 🔴 Falla con: que el freno no encuentre la apertura de una corrida podada (niega sin ventana) o que la pregunta del
// cuadro no diga de qué sesión es ni cuándo se abrió.
test('T4 Restore_PrunedWithoutOpening_GuardShowsWindow @story-8.288 @ac-5 @ac-6', () => {
  const E = entorno();
  const copia = podada(E);
  // la poda cerró la apertura en el registro: el freno sólo la encuentra por la copia podada
  const conHora = JSON.parse(fs.readFileSync(copia, 'utf8'));
  assert.ok(conHora.startedAt, 'la copia trae la hora de arranque');
  const f = frenoDe(E, 'node marker.js restore s-podada');
  assert.ok(f, 'el freno pide la firma de la salida perdida');
  assert.notStrictEqual(f[3], '-', 'con la copia podada, el freno sabe cuándo se abrió (no niega sin ventana)');
  assert.strictEqual(f[3], conHora.startedAt);
  const fuentes = require(SOURCES);
  const p = fuentes.partesDe({ firma: 'lost-run', palabras: ['marker.js', 'restore', 's-podada'], cwd: E.repo, estado: E.estado, destino: 's-pide' });
  assert.ok(p && Array.isArray(p.queHace), 'la firma lost-run tiene su fuente');
  const linea = p.queHace.join(' ');
  assert.match(linea, /9\.6/, 'nombra la historia');
  assert.match(linea, /s-podada/, 'nombra la sesión');
  assert.match(linea, /abierta a las \d\d:\d\d/, 'dice cuándo se abrió');
  assert.strictEqual(p.fuente, p.queHace.join('\n'), 'la fuente es lo que se muestra (entra a la huella)');
  // sin startedAt, la hora sale del último toque y se dice «antes de»
  const { startedAt: _s, ...sinHora } = conHora;
  fs.writeFileSync(copia, JSON.stringify(sinHora));
  const f2 = frenoDe(E, 'node marker.js restore s-podada');
  assert.strictEqual(f2[3], `antes de ${sinHora.lastTouch}`);
  const p2 = fuentes.partesDe({ firma: 'lost-run', palabras: ['marker.js', 'restore', 's-podada'], cwd: E.repo, estado: E.estado, destino: 's-pide' });
  assert.match(p2.queHace.join(' '), /abierta antes de las \d\d:\d\d/);
  // `clear-session --lost` no mira la copia podada, como el guion: el freno ve lo mismo que hoy
  const f3 = frenoDe(E, 'node marker.js clear-session s-podada --lost');
  assert.strictEqual(f3[3], '-');
  // sin copia ni apertura: niega como hoy, sin fuente propia
  fs.rmSync(copia);
  const f4 = frenoDe(E, 'node marker.js restore s-podada');
  assert.strictEqual(f4[3], '-', 'sin copia ni apertura, el freno niega sin ventana como hoy');
  assert.strictEqual(fuentes.partesDe({ firma: 'lost-run', palabras: ['marker.js', 'restore', 's-podada'], cwd: E.repo, estado: E.estado, destino: 's-pide' }), null);
});

// T5 Restore_TerminalTwice_SecondDoesNotOverwrite — @story-8.288 @ac-7
// 🔴 Falla con: que un restore desde la terminal (`_nosession`) pise y cierre el marcador vivo de otra historia.
test('T5 Restore_TerminalTwice_SecondDoesNotOverwrite @story-8.288 @ac-7', () => {
  const { pisaMarcadorVivo } = require(RESTORE_STEPS);
  const ahora = Date.parse('2026-11-17T12:00:00Z');
  const vivo = { storyId: '9.9', lastTouch: '2026-11-17T11:00:00Z' };
  const frena = pisaMarcadorVivo({ sid: '_nosession', previo: vivo, story: '9.6', ahora, staleHours: 6 });
  assert.ok(frena, 'otra historia, viva: frena');
  assert.strictEqual(String(frena.historia), '9.9');
  assert.strictEqual(frena.ultimoToque, vivo.lastTouch);
  assert.strictEqual(pisaMarcadorVivo({ sid: '_nosession', previo: vivo, story: '9.9', ahora, staleHours: 6 }), null, 'la misma historia sigue');
  assert.strictEqual(pisaMarcadorVivo({ sid: '_nosession', previo: { storyId: '9.9', lastTouch: '2026-11-17T05:00:00Z' }, story: '9.6', ahora, staleHours: 6 }), null, 'pasado el plazo de la poda, sigue');
  assert.strictEqual(pisaMarcadorVivo({ sid: 's-con-nombre', previo: vivo, story: '9.6', ahora, staleHours: 6 }), null, 'una sesión con nombre, como hoy');
  assert.strictEqual(pisaMarcadorVivo({ sid: '_nosession', previo: null, story: '9.6', ahora, staleHours: 6 }), null, 'sin marcador, sigue');

  // por el guion: sin variable de sesión cae en `_nosession`, y frena antes de la firma sin cerrar nada
  const E = entorno();
  const copia = podada(E);
  fs.writeFileSync(E.activo('_nosession'), JSON.stringify({ storyId: '9.9', storyPath: E.story, repoPath: E.repo, sessionId: '_nosession',
    lastTouch: hace(1), startedAt: hace(2), stepsCompleted: ['start'], stepsPending: ['implement'] }));
  const antes = fs.readFileSync(E.activo('_nosession'), 'utf8');
  const r = E.correr('marker.js', ['restore', 's-podada'], null);
  assert.notStrictEqual(r.status, 0, 'frena');
  assert.match(r.stderr, /9\.9/, 'nombra la historia viva');
  assert.match(r.stderr, /--for-session/, 'da la salida de la sesión destino');
  assert.match(r.stderr, /clear-session _nosession/, 'y la de sacar el marcador viejo');
  assert.strictEqual(fs.readFileSync(E.activo('_nosession'), 'utf8'), antes, 'no tocó el marcador vivo');
  assert.ok(fs.existsSync(copia), 'la copia podada sigue');

  // una sesión con nombre con otra historia: como hoy, la reemplaza y la anota (en un entorno aparte: el marcador de
  // `_nosession` de arriba es de la misma historia que arrancaría)
  const N = entorno();
  podada(N);
  N.arrancar('s-espera', 1);
  const rr = N.correr('marker.js', ['restore', 's-podada'], 's-espera', conVentana({}));
  assert.strictEqual(rr.status, 0, rr.stderr + rr.stdout);
  assert.strictEqual(String(N.leer('s-espera').storyId), '9.6');
  assert.strictEqual(N.leer('s-espera').restorePendiente, undefined, 'terminado: sin lista de pendientes');
  assert.match(fs.readFileSync(path.join(N.estado, 'gates.log'), 'utf8'), /reemplazada por restore s-podada/);
});

// T6 Restore_FailsWritingMarker_ClosesNothing — @story-8.288 @ac-8
// 🔴 Falla con: cerrar la apertura o el marcador previo antes de escribir el marcador nuevo, o que una repetición no
// pueda completar lo que faltó.
test('T6 Restore_FailsWritingMarker_ClosesNothing @story-8.288 @ac-8', () => {
  const { correrRestore } = require(RESTORE_STEPS);
  const pendiente = () => ({ sesion: 's-podada', story: '9.6', ts: '2026-11-17T10:00:00Z', antes: false, pasos: [
    { que: 'apertura', sesion: 's-podada', runDir: '/r/a', story: '9.6' },
    { que: 'reemplazada', previo: { storyId: '9.9', storyPath: '/r/s.md', repoPath: '/r', runDir: '/r/b', sessionId: 's-x' } },
    { que: 'abrir' },
    { que: 'podada', sesion: 's-podada' },
  ] });
  const corridos = [];
  const pasos = (falla = {}) => Object.fromEntries(['apertura', 'reemplazada', 'abrir', 'podada'].map((q) => [q, (p) => {
    if (falla[q] === 'tira') throw new Error(`no pude ${q}`);
    if (falla[q] === 'falso') return false;
    corridos.push({ que: q, datos: p });
    return true;
  }]));

  // falla al escribir el marcador: no corre ningún paso
  const r1 = correrRestore({ pendiente: pendiente(), pasos: pasos(), escribirMarcador: () => { throw new Error('EACCES'); } });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.falto, 'marcador');
  assert.deepStrictEqual(corridos, [], 'ningún cierre ni borrado antes del marcador');

  // escribe el marcador y falla «reemplazada» (devuelve false, como cerrarEjecucion): el marcador queda con lo que falta
  let guardado = null;
  const escribir = (p) => { guardado = JSON.parse(JSON.stringify(p)); };
  const r2 = correrRestore({ pendiente: pendiente(), pasos: pasos({ reemplazada: 'falso' }), escribirMarcador: escribir });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.falto, 'reemplazada');
  assert.deepStrictEqual(corridos.map((c) => c.que), ['apertura'], 'sólo corrió lo de antes');
  assert.deepStrictEqual(guardado.pasos.map((p) => p.que), ['reemplazada', 'abrir', 'podada'], 'lo que falta queda guardado con sus datos');
  assert.strictEqual(guardado.pasos[0].previo.runDir, '/r/b');
  assert.strictEqual(guardado.ts, '2026-11-17T10:00:00Z', 'la hora de la apertura viaja con la lista');

  // la repetición, con lo guardado: corre sólo lo que faltó, con los datos guardados, y deja la lista vacía
  corridos.length = 0;
  const r3 = correrRestore({ pendiente: guardado, pasos: pasos(), escribirMarcador: escribir });
  assert.strictEqual(r3.ok, true);
  assert.deepStrictEqual(corridos.map((c) => c.que), ['reemplazada', 'abrir', 'podada']);
  assert.strictEqual(corridos[0].datos.previo.storyId, '9.9');
  assert.deepStrictEqual(guardado.pasos, [], 'terminado: la lista quedó vacía');

  // un paso que tira también corta ahí
  corridos.length = 0;
  const r4 = correrRestore({ pendiente: pendiente(), pasos: pasos({ abrir: 'tira' }), escribirMarcador: escribir });
  assert.strictEqual(r4.falto, 'abrir');
  assert.match(String(r4.error), /no pude abrir/);
  assert.deepStrictEqual(guardado.pasos.map((p) => p.que), ['abrir', 'podada']);
});
