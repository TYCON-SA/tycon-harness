#!/usr/bin/env node
'use strict';
// lost-run-partition.test.js — cerrar una ejecución que la partición de su historia dejó sin objeto (@story-8.276).
//
// Una ejecución arrancó sobre una historia sin bloque `pipelines:`; después la historia se partió en tandas y la ejecución
// quedó perdida. Cerrarla con `clear-session <S> --lost --partition` pide `lost-run:particion`, de rutina (nivel 1), y
// no `lost-run`, de nivel 2. El freno elige la firma por la bandera; el guion comprueba antes de la firma que la
// partición de verdad es posterior a la apertura (la historia de arranque sale del repo de la historia, por fecha) y,
// si no, sale 2 sin cerrar nada. `restore`, los escapes y `clear-session --lost` sin la bandera siguen en `lost-run`.
//
// Corre el guion real en una HOME de juguete, con la historia en un repo distinto del repo del código. La firma se da
// por pasada con la ventana de prueba (scripts/tests/lib/window-passed.js).
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/lost-run-partition.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const { conVentana } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));
const or = require(path.join(SCRIPTS, 'lib', 'open-runs.js'));
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
const firmas = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));

// stable-data: las fechas de los commits y de la apertura son fijas
const ANTES = '2026-01-01T10:00:00Z';
const APERTURA = '2026-01-02T10:00:00.000Z';
const DESPUES = '2026-01-03T10:00:00Z';
const SIN_TANDAS = ['---', 'story: "9.7"', 'title: "partida"', 'status: in-progress', 'files_to_modify:', '  - src/a.js', '---', '', '# Story 9.7', ''].join('\n');
const CON_TANDAS = ['---', 'story: "9.7"', 'title: "partida"', 'status: in-progress', 'pipelines:', '  - name: A-uno', '    status: pending',
  '  - name: B-dos', '    status: pending', 'files_to_modify:', '  - src/a.js', '---', '', '# Story 9.7', ''].join('\n');

function entorno({ alArrancar = SIN_TANDAS, ahora = CON_TANDAS } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-run-partition-'));
  const home = path.join(base, 'home');
  const codigo = path.join(base, 'codigo');
  const historias = path.join(base, 'historias');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  const git = (repo, fecha, ...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha },
  });
  for (const repo of [codigo, historias]) {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ANTES, 'init', '-q', '-b', 'feat/x');
    git(repo, ANTES, 'config', 'user.email', 't@t');
    git(repo, ANTES, 'config', 'user.name', 't');
  }
  fs.mkdirSync(path.join(codigo, 'src'));
  fs.writeFileSync(path.join(codigo, 'src', 'a.js'), 'module.exports = 1;\n');
  git(codigo, ANTES, 'add', '.');
  git(codigo, ANTES, 'commit', '-qm', 'inicio');
  fs.mkdirSync(path.join(historias, 'specs'));
  const story = path.join(historias, 'specs', 'story-9.7-partida.md');
  fs.writeFileSync(story, alArrancar);
  git(historias, ANTES, 'add', '.');
  git(historias, ANTES, 'commit', '-qm', 'la historia');
  if (ahora !== alArrancar) {
    fs.writeFileSync(story, ahora);
    git(historias, DESPUES, 'commit', '-qam', 'la historia se parte');
  }
  const env = (sid, extra = {}) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete e[k];
    Object.assign(e, { HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_TIME_TRACKING: 'none', TYCON_GUIDES_DIR: RAIZ });
    if (sid) e.CLAUDE_CODE_SESSION_ID = sid;
    return Object.assign(e, extra);
  };
  const correr = (args, sid, extra) => spawnSync(process.execPath, [MARKER, ...args], { encoding: 'utf8', env: env(sid, extra), input: '', cwd: codigo });
  const estado = () => require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
  const gates = () => path.join(estado(), 'gates.log');
  const eventos = (sid) => (fs.existsSync(gates()) ? fs.readFileSync(gates(), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l && l.sesion === sid && /^run-(open|close)$/.test(l.name)) : []);
  // la ejecución perdida: su apertura en el registro y su copia en la carpeta, sin marcador (el caso común)
  const abrir = (sid, { storyPath = story } = {}) => or.abrir({ sid, story: '9.7', storyPath, repo: codigo, runDir: path.join(codigo, '.advisors', 'pipeline-runs', `9.7-${sid}`), home, ahora: APERTURA });
  const marcador = (sid, m) => {
    fs.mkdirSync(path.join(estado(), 'active'), { recursive: true });
    fs.writeFileSync(path.join(estado(), 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, storyId: '9.7', storyPath: story, repoPath: codigo, ...m }));
  };
  return { home, codigo, historias, story, correr, gates, eventos, abrir, marcador };
}

const PREVIO = { TYCON_SIGN_PRECHECK: '1' };
const salida = (r) => `${r.stderr || ''}${r.stdout || ''}`;

test('T8 LostRun_SupersededByPartition_LevelOne @story-8.276 @ac-10', () => {
  // el freno elige la firma por la bandera, sin leer la historia
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} clear-session s-p --lost --partition`), ['lost-run:particion']);
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} clear-session s-p --lost`), ['lost-run']);
  const nivel = firmas.LEVELS.find((l) => l.id === 'lost-run:particion');
  assert.strictEqual(nivel && nivel.level, 1, 'de rutina');
  assert.ok(firmas.SIGNATURES.find((s) => s.id === 'lost-run:particion'), 'en el catálogo de firmas');
  // la historia se partió después de la apertura, y vive en otro repo que el código: el chequeo previo llega a la firma
  const E = entorno();
  E.abrir('s-p');
  const previo = E.correr(['clear-session', 's-p', '--lost', '--partition'], 's-p', PREVIO);
  assert.strictEqual(previo.status, 0, salida(previo));
  assert.match(previo.stdout, /tycon-sign-precheck: ok/);
  assert.ok(!E.eventos('s-p').some((e) => e.name === 'run-close'), 'el chequeo previo no cierra nada');
  // con la firma, la cierra como perdida, y lo que firmó es la firma nueva
  const r = E.correr(['clear-session', 's-p', '--lost', '--partition'], 's-p', conVentana({}));
  assert.strictEqual(r.status, 0, salida(r));
  const cierre = E.eventos('s-p').pop();
  assert.deepStrictEqual([cierre.name, cierre.estado], ['run-close', 'perdida']);
  assert.match(fs.readFileSync(E.gates(), 'utf8'), /"lost-run:particion/);
});

test('T9 LostRun_OtherRuns_StillLevelTwo @story-8.276 @ac-11', () => {
  const casos = [
    // la historia ya traía su partición al arrancar
    ['sin cambio de partición', entorno({ alArrancar: CON_TANDAS, ahora: CON_TANDAS }), (E) => E.abrir('s-q')],
    // la ejecución tiene una tanda que la historia todavía nombra
    ['su tanda sigue', entorno({ alArrancar: CON_TANDAS, ahora: CON_TANDAS }), (E) => { E.abrir('s-q'); E.marcador('s-q', { batch: 'A-uno' }); }],
    // el marcador se podó por viejo y su tanda sigue en la historia: la tanda del podado cuenta igual que la del vivo
    ['tanda del podado', entorno(), (E) => {
      E.abrir('s-q');
      require(path.join(SCRIPTS, 'lib', 'story-gate-io.js')).savePruned(require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(E.home), 's-q',
        { sessionId: 's-q', storyId: '9.7', storyPath: E.story, repoPath: E.codigo, batch: 'A-uno', startedAt: APERTURA });
    }],
    // la historia de la apertura no se puede leer
    ['historia ilegible', entorno(), (E) => E.abrir('s-q', { storyPath: path.join(E.historias, 'specs', 'no-existe.md') })],
  ];
  for (const [nombre, E, armar] of casos) {
    armar(E);
    const r = E.correr(['clear-session', 's-q', '--lost', '--partition'], 's-q', PREVIO);
    assert.strictEqual(r.status, 2, `${nombre}: ${salida(r)}`);
    assert.match(r.stderr, /sin --partition/, nombre);
    assert.doesNotMatch(r.stdout, /tycon-sign-precheck: ok/, nombre);
    assert.ok(!E.eventos('s-q').some((e) => e.name === 'run-close'), `${nombre}: no cerró nada`);
  }
  // sin la bandera, el chequeo previo llega a la firma de siempre (el freno pide lost-run)
  const E = entorno({ alArrancar: CON_TANDAS, ahora: CON_TANDAS });
  E.abrir('s-q');
  const sin = E.correr(['clear-session', 's-q', '--lost'], 's-q', PREVIO);
  assert.strictEqual(sin.status, 0, salida(sin));
});

test('T10 LostRun_RestoreAndEscapes_Unchanged @story-8.276 @ac-12 @ac-19', () => {
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} restore s-p`), ['lost-run']);
  assert.deepStrictEqual(ow.firmasDelComando(`node ${MARKER} restore s-p --partition`), ['lost-run'], 'restore no tiene forma de rutina');
  for (const e of ['escape:cerrar-la-ejecucion', 'escape:cerrar-como-deuda', 'escape:rojo-esperado-de-la-matriz']) {
    assert.deepStrictEqual(firmas.SIGNATURES.find((s) => s.id === e).covers, ['lost-run'], e);
  }
  assert.strictEqual(firmas.LEVELS.find((l) => l.id === 'lost-run').level, 2);
  const nueva = firmas.SIGNATURES.find((s) => s.id === 'lost-run:particion');
  assert.deepStrictEqual([nueva.level, nueva.otherSession], [1, 'yes']);
  assert.ok(nueva.ifWrong, 'tiene su «si sale mal»');
  assert.ok(nueva.approvesEn, 'y su texto en inglés');
  // el grupo no la delega: un perfil que ya delega «lost-run» no la suma sin un pedido aparte
  assert.deepStrictEqual(firmas.expand('lost-run'), ['lost-run']);
  assert.deepStrictEqual(firmas.GROUPS['lost-run'], ['lost-run']);
  // pero restringe: «lost-run» en owner_only la vuelve sólo del dueño también
  assert.deepStrictEqual(firmas.expand('lost-run', { restringe: true }).sort(), ['lost-run', 'lost-run:particion']);
  // y el perfil que la delega por su id con «lost-run» sólo del dueño es una contradicción: la validación la dice, como
  // dice la de una misma firma en las dos listas (si no, el perfil pasa y la delegación la niega en cada máquina)
  const tc = require(path.join(RAIZ, 'scripts', 'lib', 'tycon-config.js'));
  const contradictorio = tc.parse(JSON.stringify({ approvals: { owner_only: ['lost-run'], delegated_signing: ['lost-run:particion'] } }));
  assert.match(JSON.stringify(contradictorio), /lost-run:particion está también en approvals\.owner_only/);
  const sinCruce = tc.parse(JSON.stringify({ approvals: { owner_only: ['lost-run'], delegated_signing: ['save'] } }));
  assert.doesNotMatch(JSON.stringify(sinCruce), /está también en approvals\.owner_only/);
  // la sesión que nombra el comando es la de la ejecución, como en lost-run
  assert.ok(ow.CON_PRECHEQUEO.has('lost-run:particion') && ow.CHEQUEO_ANTES_DEL_CUADRO.has('lost-run:particion'));
});
