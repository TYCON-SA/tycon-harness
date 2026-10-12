'use strict';
/**
 * Tests del desempate por modelo barato del carril (lib/lane-classifier.js).
 *
 * Ninguno sale a la red: la invocación al modelo se inyecta. Lo que se prueba no es si Haiku
 * acierta —eso no es determinístico y no se puede testear acá— sino que TODO camino que no sea
 * "el modelo dijo ADHOC clarito" termine en null, o sea en el comportamiento de hoy: denegar.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LC = require(path.join(__dirname, '..', 'lib', 'lane-classifier.js'));

const conRespuesta = (txt) => ({ call: () => txt });

test('parseVerdict: sólo una palabra clara vale; ambigüedad y parloteo → null', () => {
  assert.equal(LC.parseVerdict('ADHOC'), 'adhoc');
  assert.equal(LC.parseVerdict('  adhoc\n'), 'adhoc');
  assert.equal(LC.parseVerdict('PIPELINE'), 'pipeline');
  assert.equal(LC.parseVerdict('NINGUNO'), null);
  // Las tres formas de "no me contestó nada usable" — todas caen a null.
  assert.equal(LC.parseVerdict('ADHOC o PIPELINE, depende'), null, 'dos palabras = ambiguo');
  assert.equal(LC.parseVerdict('No estoy seguro'), null);
  assert.equal(LC.parseVerdict(''), null);
  assert.equal(LC.parseVerdict(null), null);
});

test('classifyLane: el veredicto del modelo se respeta cuando es inequívoco', () => {
  const P = ['actualiza el sp de desduplicacion e incluilo en el repo'];
  assert.equal(LC.classifyLane(P, conRespuesta('ADHOC')).lane, 'adhoc');
  assert.equal(LC.classifyLane(P, conRespuesta('PIPELINE')).lane, 'pipeline');
  assert.equal(LC.classifyLane(P, conRespuesta('NINGUNO')).lane, null);
});

test('classifyLane: TODO lo que no sea un ADHOC claro cae a null (= denegar, como hoy)', () => {
  const P = ['hacé el cambio'];
  const casos = [
    ['respuesta vacía', ''],
    ['el modelo se puso a explicar', 'Depende del contexto, podría ser ADHOC pero también PIPELINE'],
    ['el modelo devolvió basura', '{"error":"rate limit"}'],
    ['el binario no está / falló', null],
  ];
  for (const [nombre, resp] of casos) {
    assert.equal(LC.classifyLane(P, conRespuesta(resp)).lane, null, nombre);
  }
  // Una excepción en la invocación NO se propaga: el portón no puede romperse por esto.
  const explota = { call: () => { throw new Error('spawn ENOENT'); } };
  assert.doesNotThrow(() => LC.classifyLane(P, explota));
  assert.equal(LC.classifyLane(P, explota).lane, null);
  assert.equal(LC.classifyLane(P, explota).via, 'error');
});

test('classifyLane: sin prompts del user no se consulta al modelo (no hay qué interpretar)', () => {
  let llamadas = 0;
  const spy = { call: () => { llamadas++; return 'ADHOC'; } };
  assert.equal(LC.classifyLane([], spy).lane, null);
  assert.equal(LC.classifyLane(['', '   '], spy).lane, null);
  assert.equal(llamadas, 0, 'no se gastó una llamada al modelo');
});

test('classifyLane: el kill-switch del dev lo apaga sin consultar', () => {
  const prev = process.env.TYCON_LANE_LLM;
  process.env.TYCON_LANE_LLM = '0';
  try {
    let llamadas = 0;
    const spy = { call: () => { llamadas++; return 'ADHOC'; } };
    const r = LC.classifyLane(['es un arreglito'], spy);
    assert.equal(r.lane, null);
    assert.equal(r.via, 'off');
    assert.equal(llamadas, 0);
  } finally {
    if (prev === undefined) delete process.env.TYCON_LANE_LLM; else process.env.TYCON_LANE_LLM = prev;
  }
});

// ── T73 (c) · story 8.17, tanda W6 · AC 50 ─────────────────────────────────────────────────────────────────────────
// En Windows `claude` instalado con npm es un `.cmd`, y Node no lo lanza sin shell. Antes eso daba un 'sin-modelo'
// mudo; ahora el desempate se apaga DICIÉNDOLO. La plataforma y el PATH se inyectan: corre igual en Linux y en Mac.
test('T73 TestGate_MissingRunnerSaysCouldNotRun_OwnTimeoutAndRealpath_CmdClaudeOff — un `claude` que es un .cmd apaga el desempate y lo dice', () => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-cmd-'));
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\nnode "%~dp0\\acme-cli.js" %*\r\n');
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n'); // el de sh que también deja npm: no es lanzable
  const env = { Path: `C:\\acme\\vacio;${dir}` };
  const avisos = [];
  const warn = (m) => avisos.push(m);
  let llamadas = 0;
  const spy = () => { llamadas++; return 'ADHOC'; };

  // sin invocación inyectada: no se intenta lanzar nada, se apaga y se dice
  const r = LC.classifyLane(['es un arreglito chico'], { platform: 'win32', env, warn });
  assert.equal(r.lane, null, 'apagado no abre el atajo: decide la capa mecánica');
  assert.equal(r.via, 'cmd-sin-shell', 'el motivo queda en el registro, distinto de «no hay modelo»');
  assert.match(r.motivo, /claude/);
  assert.match(r.motivo, /\.cmd/);
  assert.match(r.motivo, /apagado/);
  assert.equal(avisos.length, 1, 'se dice una vez, por stderr');
  assert.match(avisos[0], /\[lane-classifier\].*\.cmd/);

  // aunque la prueba inyecte la invocación, con la plataforma inyectada manda el .cmd: no se consulta
  assert.equal(LC.classifyLane(['es un arreglito chico'], { platform: 'win32', env, warn, call: spy }).via, 'cmd-sin-shell');
  assert.equal(llamadas, 0, 'no se gastó una llamada al modelo');

  // con un `.exe` lanzable (claude o codex) se consulta como siempre
  fs.writeFileSync(path.join(dir, 'codex.exe'), 'MZ');
  const conExe = LC.classifyLane(['es un arreglito chico'], { platform: 'win32', env, warn, call: spy });
  assert.equal(conExe.via, 'llm');
  assert.equal(conExe.lane, 'adhoc');
  assert.equal(llamadas, 1);
  fs.rmSync(path.join(dir, 'codex.exe'));

  // fuera de Windows, el mismo .cmd no apaga nada (ahí `claude` es un ejecutable de verdad)
  assert.equal(LC.cmdSinShell({ platform: 'linux', env }), null);
  assert.equal(LC.classifyLane(['es un arreglito chico'], { platform: 'linux', env, warn, call: spy }).via, 'llm');
  // en Windows sin ningún CLI del modelo sigue siendo «sin modelo», no «.cmd»
  assert.equal(LC.cmdSinShell({ platform: 'win32', env: { PATH: 'C:\\acme\\vacio' } }), null);
  assert.equal(avisos.length, 2, 'sólo los casos apagados avisan');

  // y queda anotado en la lista de lo que el arnés NO promete en Windows
  const soporte = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'windows-support.json'), 'utf8'));
  const e = soporte.excluded.find((x) => x.id === 'lane-model-tiebreak');
  assert.ok(e, 'windows-support.json no anota el desempate por modelo en `excluded`');
  assert.match(e.reason, /\.cmd/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildPrompt: le pasa al modelo los mensajes del USER y le pide sesgo hacia NINGUNO', () => {
  const p = LC.buildPrompt(['actualiza el sp de desduplicación', 'dale']);
  assert.match(p, /actualiza el sp de desduplicaci/);
  assert.match(p, /dale/);
  assert.match(p, /ADHOC/); assert.match(p, /PIPELINE/); assert.match(p, /NINGUNO/);
  // La regla de sesgo es lo que hace tolerable meter un modelo en un control: ante la duda, no abre.
  assert.match(p, /duda.*NINGUNO/is);
  // Y la negación explícita, que es la clase de fuga que el regex no supo cerrar.
  assert.match(p, /NEG/i);
});
