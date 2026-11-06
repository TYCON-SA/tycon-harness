'use strict';
/**
 * adhoc-spawn-notice.test.js — el aviso «van N agentes de exploración libre» del gancho on-advisor-run.js.
 *
 * POR QUÉ. El aviso salía también en los agentes que no exploran (los revisores y los verificadores del pase, que
 * reciben un archivo con lo que tienen que leer), y el contador sumaba todo el registro de la sesión, de días, cuando
 * no había ronda de revisores que lo cortara.
 *
 * QUÉ MIDE. Que un pedido que nombra su lectura curada (un `.prompt.txt` que existe, o el archivo de contexto de la
 * ronda) no recibe el aviso ni suma (T1 a T3, T12); que sin corrida cuenta sólo la última hora y lo dice (T4, T9); que
 * con corrida cuenta desde el comienzo del paso abierto (T5) y que el corte más nuevo gana: la ronda de revisores, el
 * paso abierto o una corrida nueva (T6 a T8); que un marcador ilegible no se lee como «sin corrida» (T10); y que una
 * línea sin fecha cuenta después del corte y, sin corte, se nombra en el aviso (T11).
 *
 * stable-data: las horas del registro se arman relativas al reloj real (hace N minutos) porque el gancho mide la fase con
 * el reloj real; cada caso compara contra esas distancias, no contra una fecha fija.
 *
 * Correr:   node --test skills/tycon-pipeline/scripts/tests/adhoc-spawn-notice.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'on-advisor-run.js');
const { stateDir } = require('../lib/state-dir.js');
const SID = 'sesion-de-prueba-191';

function lab() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-notice-'));
  const state = stateDir(home);
  fs.mkdirSync(path.join(state, 'advisor-runs'), { recursive: true });
  return { home, state, log: path.join(state, 'advisor-runs', `${SID}.jsonl`) };
}

const hace = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
const linea = (o) => `${JSON.stringify(o)}\n`;

/** Lanza el gancho con un spawn de `general-purpose` y devuelve el aviso (o '' si no avisó). */
function lanzar(l, prompt) {
  const env = { ...process.env, HOME: l.home, USERPROFILE: l.home, TYCON_ADHOC_SPAWN_WARN: '2', CLAUDE_CODE_SESSION_ID: SID, TYCON_SESSION_ID: SID, TYCON_AUTO_SNAPSHOT: '0', TYCON_REVIEW_ROSTER: '0' };
  for (const k of ['TYCON_SPAWN_GOVERNANCE', 'TYCON_GUIDES_DIR', 'NODE_TEST_CONTEXT']) delete env[k];
  const event = { tool_name: 'Agent', session_id: SID, cwd: l.home, tool_input: { subagent_type: 'general-purpose', prompt, model: 'haiku' } };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return '';
  return JSON.parse(r.stdout).systemMessage || '';
}

function ultimaLinea(l) {
  const ls = fs.readFileSync(l.log, 'utf8').trim().split('\n');
  return JSON.parse(ls[ls.length - 1]);
}

test('T1 un pedido que nombra su .prompt.txt no recibe el aviso ni suma', () => {
  const l = lab();
  const pedido = path.join(l.home, 'adversarial-agentes', 'verify-1.prompt.txt');
  fs.mkdirSync(path.dirname(pedido), { recursive: true });
  fs.writeFileSync(pedido, 'leé esto');
  fs.writeFileSync(l.log, linea({ ts: hace(5), advisor: 'general-purpose' }) + linea({ ts: hace(4), advisor: 'general-purpose' }));
  const aviso = lanzar(l, `Leé ${pedido} y escribí la respuesta en el archivo que dice.`);
  assert.doesNotMatch(aviso, /exploración libre/);
  assert.strictEqual(ultimaLinea(l).curated, true);
  // el curado no suma: con dos libres antes y uno libre más, van 3, no 4
  const otro = lanzar(l, 'buscá dónde se define la función');
  assert.match(otro, /van 3 agentes de exploración libre/);
});

test('T2 un pedido que nombra el archivo de contexto de la ronda es lectura curada', () => {
  const l = lab();
  const ctx = path.join(l.home, 'run', 'advisor-context.md');
  fs.mkdirSync(path.dirname(ctx), { recursive: true });
  fs.writeFileSync(ctx, 'contexto');
  fs.writeFileSync(l.log, linea({ ts: hace(10), event: 'step5-start', context_file: ctx }) +
    linea({ ts: hace(5), advisor: 'general-purpose' }) + linea({ ts: hace(4), advisor: 'general-purpose' }));
  const aviso = lanzar(l, `Tu contexto está en ${ctx}.`);
  assert.doesNotMatch(aviso, /exploración libre/);
  assert.strictEqual(ultimaLinea(l).curated, true);
});

test('T3 un .prompt.txt que no existe no cuenta como lectura curada', () => {
  const l = lab();
  fs.writeFileSync(l.log, linea({ ts: hace(5), advisor: 'general-purpose' }));
  const aviso = lanzar(l, `Leé ${path.join(l.home, 'no-esta.prompt.txt')}.`);
  assert.match(aviso, /van 2 agentes de exploración libre/);
  assert.strictEqual(ultimaLinea(l).curated, undefined);
});

test('T4 sin corrida cuenta sólo la última hora, y lo dice', () => {
  const l = lab();
  fs.writeFileSync(l.log, [2880, 1440, 90].map((m) => linea({ ts: hace(m), advisor: 'general-purpose' })).join('') +
    linea({ ts: hace(30), advisor: 'general-purpose' }));
  const aviso = lanzar(l, 'buscá dónde se arma el aviso');
  assert.match(aviso, /van 2 agentes de exploración libre en la última hora \(sin corrida abierta\)/);
});

test('T5 con corrida cuenta desde el comienzo del paso abierto', () => {
  const l = lab();
  fs.mkdirSync(path.join(l.state, 'active'), { recursive: true });
  fs.writeFileSync(path.join(l.state, 'active', `${SID}.json`), JSON.stringify({
    sessionId: SID, stepTimings: { plan: { startedAt: hace(60), completedAt: hace(15) }, 'approve-plan': { startedAt: hace(10) } },
  }));
  fs.writeFileSync(l.log, [40, 20, 12].map((m) => linea({ ts: hace(m), advisor: 'general-purpose' })).join('') +
    linea({ ts: hace(5), advisor: 'general-purpose' }));
  const aviso = lanzar(l, 'buscá el lector');
  assert.match(aviso, /van 2 agentes de exploración libre en esta fase/);
});

test('T6 la ronda de revisores, si es más nueva que el paso, corta', () => {
  const l = lab();
  fs.mkdirSync(path.join(l.state, 'active'), { recursive: true });
  fs.writeFileSync(path.join(l.state, 'active', `${SID}.json`), JSON.stringify({ sessionId: SID, stepTimings: { reviewers: { startedAt: hace(60) } } }));
  fs.writeFileSync(l.log, [50, 40, 30].map((m) => linea({ ts: hace(m), advisor: 'general-purpose' })).join('') +
    linea({ ts: hace(20), event: 'step5-start' }) + linea({ ts: hace(10), advisor: 'general-purpose' }));
  const aviso = lanzar(l, 'buscá el lector');
  assert.match(aviso, /van 2 agentes de exploración libre en esta fase/);
});

/** Un marcador de laboratorio con ese contenido (texto tal cual). */
function marcador(l, texto) {
  fs.mkdirSync(path.join(l.state, 'active'), { recursive: true });
  fs.writeFileSync(path.join(l.state, 'active', `${SID}.json`), texto);
}

test('T7 el paso abierto, si es más nuevo que la ronda, corta', () => {
  const l = lab();
  marcador(l, JSON.stringify({ sessionId: SID, stepTimings: { reviewers: { startedAt: hace(10) } } }));
  fs.writeFileSync(l.log, linea({ ts: hace(20), event: 'step5-start' }) +
    linea({ ts: hace(15), advisor: 'general-purpose' }) + linea({ ts: hace(5), advisor: 'general-purpose' }));
  assert.match(lanzar(l, 'buscá el lector'), /van 2 agentes de exploración libre en esta fase/);
});

test('T8 una corrida nueva (run-start) corta el registro', () => {
  const l = lab();
  fs.writeFileSync(l.log, linea({ ts: hace(30), advisor: 'general-purpose' }) + linea({ ts: hace(20), event: 'run-start' }) +
    linea({ ts: hace(10), advisor: 'general-purpose' }));
  assert.match(lanzar(l, 'buscá el lector'), /van 2 agentes de exploración libre en esta fase/);
});

test('T9 un marcador sin pasos o sin paso abierto cuenta la última hora, sin corrida abierta', () => {
  for (const m of [{ sessionId: SID }, { sessionId: SID, stepTimings: { plan: { startedAt: hace(90), completedAt: hace(80) } } }]) {
    const l = lab();
    marcador(l, JSON.stringify(m));
    fs.writeFileSync(l.log, linea({ ts: hace(120), advisor: 'general-purpose' }) + linea({ ts: hace(30), advisor: 'general-purpose' }));
    assert.match(lanzar(l, 'buscá el lector'), /van 2 agentes de exploración libre en la última hora \(sin corrida abierta\)/);
  }
});

test('T10 un marcador ilegible o con una fecha rota no se lee como «sin corrida»', () => {
  for (const texto of ['{ esto no es json', JSON.stringify({ sessionId: SID, stepTimings: { reviewers: { startedAt: 'ayer' } } })]) {
    const l = lab();
    marcador(l, texto);
    fs.writeFileSync(l.log, linea({ ts: hace(120), advisor: 'general-purpose' }) + linea({ ts: hace(30), advisor: 'general-purpose' }));
    const aviso = lanzar(l, 'buscá el lector');
    assert.doesNotMatch(aviso, /sin corrida abierta/);
    assert.match(aviso, /van 2 agentes de exploración libre en esta fase \(no pude leer el marcador de la corrida/);
  }
});

test('T11 una línea sin fecha cuenta después del corte; sin corte no se cuenta y el aviso la nombra', () => {
  const conCorte = lab();
  fs.writeFileSync(conCorte.log, linea({ ts: hace(20), event: 'step5-start' }) + linea({ advisor: 'general-purpose' }));
  assert.match(lanzar(conCorte, 'buscá el lector'), /van 2 agentes de exploración libre en esta fase \(umbral 2\) —/);
  const sinCorte = lab();
  fs.writeFileSync(sinCorte.log, linea({ advisor: 'general-purpose' }) + linea({ ts: hace(10), advisor: 'general-purpose' }));
  assert.match(lanzar(sinCorte, 'buscá el lector'), /van 2 agentes .*; 1 sin fecha en el registro, no contados/);
});

test('T12 curatedReading: puntuación, el contexto de un revisor, lo que no es su lectura y las rutas de red', () => {
  const { curatedReading } = require(HOOK);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curated-'));
  const pedido = path.join(dir, 'caza-1.prompt.txt');
  const ctx = path.join(dir, 'ctx-validator.md');
  const suelto = path.join(dir, 'advisor-context.md');
  for (const f of [pedido, ctx, suelto]) fs.writeFileSync(f, 'x');
  const ronda = [linea({ event: 'step5-start', context_file_overrides: { 'tycon-story-validator': ctx } }).trim(), '{"event":"step5-start", roto'];
  assert.strictEqual(curatedReading(`Leé ${pedido}, y contestá.`, []), pedido);
  assert.strictEqual(curatedReading(`Tu contexto: ${ctx};`, ronda), ctx);
  assert.strictEqual(curatedReading(`Mirá ${suelto}`, ronda), null);
  assert.strictEqual(curatedReading('Leé \\\\equipo\\carpeta\\caza-1.prompt.txt', []), null);
  assert.strictEqual(curatedReading('Leé //equipo/carpeta/caza-1.prompt.txt', []), null);
  assert.strictEqual(curatedReading('', ronda), null);
});
