'use strict';

/**
 * advisor-ledger.test.js — el registro de corridas de revisores (Tema 2, 2026-08-25).
 *
 * QUÉ PROTEGE: que la pregunta "¿corrieron los revisores de la story X?" se pueda contestar
 * mecánicamente. Antes no se podía: el registro automático guardaba `{ts, advisor, model}` sin
 * repo ni story (756 líneas medidas, CERO con repo) y se borraba solo a los 7 días.
 *
 * 🔴 El caso que más importa acá es `archive-no-habilita-borrar-si-no-pudo-escribir`: la poda
 * borra el archivo SÓLO si el resumen quedó escrito. Sin ese contrato, un fallo de escritura se
 * traduce en pérdida silenciosa de la única constancia no-falsificable de que los revisores
 * corrieron — que es exactamente el problema que este trabajo vino a cerrar.
 *
 * Parte PURA (sin spawns) — corre en cada arranque. Lo que lanza procesos vive en
 * `advisor-ledger-cli.test.js` (throttle diario).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const led = require('../lib/advisor-ledger.js');
const { readMarkerFile, attribution } = require('../lib/repo-attrib.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'led-')); }

const LOG_OK = [
  '{"ts":"2026-08-01T10:00:00.000Z","event":"step5-start","expected":["a","b"],"iter":1}',
  '{"ts":"2026-08-01T10:00:01.000Z","advisor":"sec","model":"sonnet","repo":"/r/Backend","story":"9.4"}',
  '{"ts":"2026-08-01T10:00:03.000Z","advisor":"tests","model":null,"repo":"/r/Backend","story":"9.4"}',
  '{"ts":"2026-08-01T10:00:02.000Z","advisor":"sec","model":null,"repo":"/r/Backend","story":"9.4"}',
].join('\n') + '\n';

test('summarize — repos, stories, conteo por advisor, ventana y rondas', () => {
  const s = led.summarize(LOG_OK, 'sesion-1');
  assert.equal(s.sessionId, 'sesion-1');
  assert.deepEqual(s.repos, ['/r/Backend']);
  assert.deepEqual(s.stories, ['9.4']);
  assert.deepEqual(s.advisors, { sec: 2, tests: 1 });
  assert.equal(s.spawns, 3);
  assert.equal(s.rondas, 1);
  assert.equal(s.from, '2026-08-01T10:00:00.000Z');
  assert.equal(s.to, '2026-08-01T10:00:03.000Z', 'la ventana se calcula por min/max, no por orden del archivo');
});

test('summarize — archivo vacío devuelve null (borrarlo no pierde nada)', () => {
  assert.equal(led.summarize('', 'x'), null);
  assert.equal(led.summarize('\n\n', 'x'), null);
});

test('summarize — una línea corrupta no rompe ni se cuenta', () => {
  const s = led.summarize('{roto\n' + LOG_OK, 'x');
  assert.equal(s.spawns, 3);
});

test('archive — escribe el resumen durable y habilita el borrado', () => {
  const d = tmp();
  const f = path.join(d, 'sesion-1.jsonl');
  fs.writeFileSync(f, LOG_OK);
  const dest = path.join(d, 'sum.jsonl');
  assert.equal(led.archive(f, 'sesion-1', dest), true);
  const escrito = JSON.parse(fs.readFileSync(dest, 'utf8').trim());
  assert.equal(escrito.spawns, 3);
  assert.deepEqual(escrito.stories, ['9.4']);
});

test('archive — si NO puede escribir el resumen, NO habilita el borrado', () => {
  // 🔴 EL CASO QUE MÁS IMPORTA. La poda borra sólo si esto devuelve true. Si un fallo de
  // escritura devolviera true igual, la única constancia no-falsificable de que los revisores
  // corrieron se perdería EN SILENCIO — el modo de falla exacto que este trabajo vino a cerrar.
  const d = tmp();
  const f = path.join(d, 'sesion-1.jsonl');
  fs.writeFileSync(f, LOG_OK);
  const dest = path.join(d, 'ocupado.jsonl');
  fs.mkdirSync(dest); // un directorio donde va el archivo → appendFileSync tira EISDIR
  assert.equal(led.archive(f, 'sesion-1', dest), false);
});

test('archive — archivo ilegible: devuelve true (no hay constancia que perder)', () => {
  assert.equal(led.archive(path.join(tmp(), 'no-existe.jsonl'), 'x'), true);
});

test('readSummaries — deduplica por sesión + arranque', () => {
  const d = tmp();
  const p = path.join(d, 's.jsonl');
  const l = JSON.stringify({ sessionId: 'a', from: 'T1', to: 'T2', repos: ['/r'], stories: ['1.1'], advisors: { x: 1 }, spawns: 1 });
  fs.writeFileSync(p, l + '\n' + l + '\n');
  assert.equal(led.readSummaries(p).length, 1, 'un resumen duplicado por un borrado fallido no debe contarse dos veces');
});

test('query — junta el detalle vivo con el resumen durable y filtra por story', () => {
  const d = tmp();
  const runs = path.join(d, 'runs');
  fs.mkdirSync(runs);
  fs.writeFileSync(path.join(runs, 'viva.jsonl'), LOG_OK);
  fs.writeFileSync(path.join(runs, 'otra.jsonl'),
    '{"ts":"2026-08-02T10:00:00.000Z","advisor":"sec","repo":"/r/Backend","story":"1.1"}\n');
  const sum = path.join(d, 'sum.jsonl');
  fs.writeFileSync(sum, JSON.stringify({
    sessionId: 'vieja', from: '2026-07-01T00:00:00.000Z', to: '2026-07-01T01:00:00.000Z',
    repos: ['/r/Backend'], stories: ['9.4'], advisors: { sec: 5 }, spawns: 5,
  }) + '\n');

  const r = led.query({ story: '9.4', runsDir: runs, summaryPath: sum });
  assert.equal(r.spawns, 8, '3 vivos de la 9.4 + 5 archivados');
  assert.equal(r.vivos.length, 3, 'la story 1.1 queda afuera');
  assert.equal(r.advisores.sec, 7);
  assert.deepEqual(r.stories, ['9.4']);
});

test('query — filtra por repo también por nombre de carpeta', () => {
  const d = tmp();
  const runs = path.join(d, 'runs');
  fs.mkdirSync(runs);
  fs.writeFileSync(path.join(runs, 'v.jsonl'), LOG_OK);
  const sum = path.join(d, 'sum.jsonl');
  assert.equal(led.query({ repo: 'Backend', runsDir: runs, summaryPath: sum }).spawns, 3);
  assert.equal(led.query({ repo: 'Frontend', runsDir: runs, summaryPath: sum }).spawns, 0);
});

test('query — cuenta los spawns vivos que quedaron sin repo (los previos al arreglo)', () => {
  const d = tmp();
  const runs = path.join(d, 'runs');
  fs.mkdirSync(runs);
  fs.writeFileSync(path.join(runs, 'v.jsonl'), '{"ts":"2026-08-01T10:00:00.000Z","advisor":"sec","model":null}\n');
  const r = led.query({ runsDir: runs, summaryPath: path.join(d, 'nada.jsonl') });
  assert.equal(r.sinAtribuir, 1);
  assert.equal(r.spawns, 1);
});

test('attribution — el marker manda: aporta repo Y story', () => {
  const home = tmp();
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sid.json'), JSON.stringify({ storyId: '7.6', repoPath: '/r/Extensions' }));
    // Sin `if`: un test que se saltea sus aserciones cuando el laboratorio no funciona es un
    // test que pasa siempre. Si el aislamiento por HOME se rompe, esto tiene que ponerse rojo.
    const m = readMarkerFile('sid');
    assert.ok(m, 'el marker del HOME de laboratorio tiene que leerse (resolución perezosa del state dir)');
    assert.equal(m.storyId, '7.6');
    assert.equal(attribution('sid', '/tmp').story, '7.6');
    assert.equal(attribution('sid', '/tmp').repo, '/r/Extensions');
  } finally { process.env.HOME = prev; }
});

test('attribution — un marker sin storyId no se usa (no inventa atribución)', () => {
  const home = tmp();
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sid2.json'), JSON.stringify({ repoPath: '/r/X' }));
    assert.equal(readMarkerFile('sid2'), null);
  } finally { process.env.HOME = prev; }
});

// ── El clon descartable es el MISMO repo (deuda ROSTER-CLON-DESCARTABLE, 2026-09-07) ───────────
// El portón de cierre pregunta por el repo del checkout y el ledger tiene estampada la ruta del
// clon descartable del scratchpad —el patrón que el arnés recomienda cuando hay otras sesiones
// vivas—, así que la consulta devolvía 0 revisores y el portón pedía `sin_testigo` con un motivo
// falso («implementado en otra máquina»). Medido al cerrar la story 2.3: 14 invocaciones en el
// ledger de la MISMA máquina, invisibles. La señal correcta es el `origin`, no la ruta ni el
// nombre de la carpeta: dos repos distintos que se llamen igual NO pueden confundirse.
function repoGit(dir, origin) {
  fs.mkdirSync(dir, { recursive: true });
  const { execFileSync } = require('child_process');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

test('query por repo — un clon descartable del MISMO origin cuenta como el mismo repo', () => {
  const base = tmp();
  const real = repoGit(path.join(base, 'tycon-claude-guides'), 'https://dev.azure.com/org-del-equipo/tcg/_git/tcg');
  const clon = repoGit(path.join(base, 'scratchpad', 'tcg-2.3'), 'https://dev.azure.com/org-del-equipo/tcg/_git/tcg');
  const runs = path.join(base, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'sid.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), advisor: 'tycon-plugin-security-basics', story: '2.3', repo: clon }) + '\n');
  const r = led.query({ story: '2.3', repo: real, runsDir: runs, summaryPath: path.join(base, 'nada.jsonl') });
  assert.equal(r.spawns, 1, 'el revisor corrido en el clon descartable tiene que contar para el repo real');
});

test('query por repo — dos repos DISTINTOS con el mismo nombre de carpeta no se confunden', () => {
  const base = tmp();
  const mio = repoGit(path.join(base, 'a', 'backend'), 'https://dev.azure.com/org-del-equipo/Totora/_git/Backend');
  const ajeno = repoGit(path.join(base, 'b', 'backend'), 'https://dev.azure.com/org-del-equipo/FRESNO/_git/Backend');
  const runs = path.join(base, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'sid.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), advisor: 'tycon-plugin-security-basics', story: '9.9', repo: ajeno }) + '\n');
  const r = led.query({ story: '9.9', repo: mio, runsDir: runs, summaryPath: path.join(base, 'nada.jsonl') });
  assert.equal(r.spawns, 0, 'un revisor corrido en OTRO repo que se llama igual no puede contar acá');
});

test('query por repo — sin git (clon borrado) se cae al nombre de la carpeta, como antes', () => {
  const base = tmp();
  const runs = path.join(base, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'sid.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), advisor: 'x', story: '1.1', repo: '/se/borro/tycon-claude-guides' }) + '\n');
  const r = led.query({ story: '1.1', repo: '/otro/lado/tycon-claude-guides', runsDir: runs, summaryPath: path.join(base, 'nada.jsonl') });
  assert.equal(r.spawns, 1, 'sin git no hay origin que comparar: el nombre de la carpeta sigue siendo la señal');
});
