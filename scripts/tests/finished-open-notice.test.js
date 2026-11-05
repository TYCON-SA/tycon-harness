'use strict';
// finished-open-notice.test.js — el aviso de arranque de lo terminado sin cerrar: lista lo de
// toda la máquina, hasta cinco, con el comando de cada sesión; calla si no hay nada. Corre el gancho real en una casa de
// prueba; ningún caso sale a la red (los caminos cortos no tienen repo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'finished-open-notice.js');
const { stateDir, claudeDir } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));

const PASOS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'prepare-commit'];
const terminada = (story) => ({
  storyId: story, stepScheme: 2, stepsCompleted: PASOS, stepsPending: [], dodRuntimeChecked: true, deepReviewDone: true,
  stepTimings: { reviewers: { completedAt: '2026-10-15T10:00:00Z' }, findings: { completedAt: '2026-10-15T10:10:00Z' }, 'prepare-commit': { completedAt: '2026-10-15T10:30:00Z' } },
  lastTouch: '2026-10-15T10:30:00Z',
});

function casa() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'finished-open-notice-'));
  const sdir = stateDir(home);
  fs.mkdirSync(path.join(sdir, 'active'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir(home), 'sessions'), { recursive: true });
  const marcador = (sid, m) => fs.writeFileSync(path.join(sdir, 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, ...m }));
  const sesion = (sid, vive) => fs.writeFileSync(path.join(claudeDir(home), 'sessions', `${sid.slice(0, 8)}.json`),
    JSON.stringify({ sessionId: sid, pid: vive ? process.pid : 2147483646 }));
  const correr = (env = {}) => spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'nueva-0000' }),
    env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: '', TYCON_EVAL_SANDBOX: '', TYCON_FINISHED_OPEN_NOTICE: '', TYCON_FINISHED_OPEN_NOW: '2026-10-15T12:00:00Z', ...env },
  });
  return { home, sdir, marcador, sesion, correr };
}

test('T19 Arranque_ListaLasDeOtrasSesiones @story-8.195 @ac-19 — seis casos de tres sesiones: cinco y «y 1 más», cada uno con el comando de su sesión', () => {
  const C = casa();
  const viva = 'aaaaaaaa-viva';
  const muerta = 'bbbbbbbb-muerta';
  const sinRegistro = 'cccccccc-codex';
  C.sesion(viva, true);
  C.sesion(muerta, false);
  // dos ejecuciones por sesión (una con un sufijo de marcador, como las que adopta otra sesión)
  for (const [sid, n] of [[viva, 1], [viva, 2], [muerta, 3], [muerta, 4], [sinRegistro, 5], [sinRegistro, 6]]) {
    const archivo = n % 2 ? sid : `${sid}-${n}`;
    C.marcador(archivo, { ...terminada(`9.${n}`), sessionId: archivo });
  }
  // cada marcador es su propia sesión para la regla de vida: los sufijados no tienen registro
  const r = C.correr();
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  const renglones = out.split('\n').filter((l) => /^\s*· /.test(l));
  assert.equal(renglones.length, 6, out);
  assert.match(renglones[5], /y 1 más/);
  assert.match(out, /story 9\.1 \(sesión aaaaaaaa\): terminó hace 1 h 30 min y sigue abierta; la cierra su sesión/);
  assert.doesNotMatch(out.split('\n').find((l) => /story 9\.1 /.test(l)), /clear-session/, 'la viva no lleva comando de cierre');
  assert.match(out, new RegExp(`story 9\\.3 \\(sesión bbbbbbbb\\): terminó hace 1 h 30 min y sigue abierta; su sesión ya no está: node \\S*marker\\.js clear-session ${muerta}`));
  assert.match(out, /story 9\.[56] \(sesión cccccccc\): .*no sé si la sesión vive \(no tiene registro de sesión: puede ser de Codex, o estar cerrada\): no doy comando/);
  assert.doesNotMatch(out, /nueva-0000/, 'el comando es el de cada sesión, no el de la que arranca');
});

test('T19b Arranque_EjecucionPerdida_ConLost @story-8.195 @ac-19 — la ejecución perdida lleva clear-session --lost', () => {
  const C = casa();
  const sid = 'dddddddd-perdida';
  C.sesion(sid, false);
  C.marcador(sid, terminada('9.7'));
  // la pieza que falta: la ejecución dice que está abierta en su repo y el marcador de su carpeta no está (lib/open-runs.js)
  const lost = path.join(C.home, 'lost.js');
  fs.writeFileSync(lost, `require(${JSON.stringify(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'open-runs.js'))}).perdida = () => ({ caso: 'sin-marcador' });\n`);
  const r = spawnSync(process.execPath, ['--require', lost, HOOK], {
    encoding: 'utf8', input: '{}', env: { ...process.env, HOME: C.home, USERPROFILE: C.home, TYCON_HOME: '', TYCON_EVAL_SANDBOX: '', TYCON_FINISHED_OPEN_NOTICE: '', TYCON_FINISHED_OPEN_NOW: '2026-10-15T12:00:00Z' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`story 9\\.7 .*su ejecución está perdida: node \\S*marker\\.js clear-session ${sid} --lost \\(lo firma el dueño\\)`));
});

test('T20 Avisos_NadaAbierto_Callan @story-8.195 @ac-20 — sin nada terminado, sin salida; con uno terminado, la línea', () => {
  const C = casa();
  C.marcador('eeeeeeee-encurso', { ...terminada('9.8'), stepsPending: ['prepare-commit'], stepsCompleted: PASOS.slice(0, -1) });
  const vacio = C.correr();
  assert.equal(vacio.status, 0, vacio.stderr);
  assert.equal(vacio.stdout, '', 'nada terminado: calla');
  // en la misma casa, uno terminado: el gancho corre y dice
  C.marcador('ffffffff-hecha', terminada('9.9'));
  const lleno = C.correr();
  assert.match(lleno.stdout, /story 9\.9 \(sesión ffffffff\): terminó hace/);
  // apagado, calla
  assert.equal(C.correr({ TYCON_FINISHED_OPEN_NOTICE: '0' }).stdout, '');
});

test('T21 Avisos_NoCierranNada @story-8.195 @ac-21 — el aviso de arranque no toca los marcadores que lista', () => {
  const C = casa();
  C.sesion('gggggggg-muerta', false);
  C.marcador('gggggggg-muerta', terminada('9.10'));
  const f = path.join(C.sdir, 'active', 'gggggggg-muerta.json');
  const antes = fs.readFileSync(f, 'utf8');
  const r = C.correr();
  assert.match(r.stdout, /clear-session gggggggg-muerta/, 'da el comando');
  assert.equal(fs.readFileSync(f, 'utf8'), antes, 'y no lo corre');
});
