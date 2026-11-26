#!/usr/bin/env node
'use strict';
// precheck-guard-deadline.test.js — el chequeo del guion antes de la ventana de permiso usa sólo el tiempo que le queda al
// freno de seguridad. Con la máquina cargada, lo que corre antes del chequeo se come parte de los 20 s del freno; con su
// plazo entero, el reloj del freno cortaba el comando sin abrir la ventana. Ahora el freno le pasa a la ventana el segundo
// en que lo corta su reloj (TYCON_SAFETY_DEADLINE_S) y el chequeo termina antes, con margen; si no queda tiempo, no se
// corre: la ventana se abre como siempre y la firma la sigue dando el dueño.
// stable-data: lee el reloj para medir cuánto espera el chequeo; no depende de la fecha.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
const GUARD = path.join(RAIZ, 'scripts', 'hooks', 'safety-guard-pre.sh');
const MARKER = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const SKIP = process.platform === 'win32' && 'el freno se lanza con bash y los guiones de juguete sin .exe; la cuenta es la misma, se mide en la Mac';

const AHORA = 1_800_000_000_000;
const tope = (ms) => String(Math.floor((AHORA + ms) / 1000));

test('T108h Prechequeo_SinElTopeDelFreno_SuPlazoDeSiempre', () => {
  assert.strictEqual(ow.plazoDelChequeo('runtime-waiver', {}, AHORA), ow.PLAZO_DEL_PRECHEQUEO_MS);
  assert.strictEqual(ow.plazoDelChequeo('save', {}, AHORA), 240000);
  // un valor que no es un segundo de reloj no acota: el plazo de siempre
  for (const malo of ['', 'mañana', '-5', '0', '12', '1.8e9', '18000000000000']) {
    assert.strictEqual(ow.plazoDelChequeo('runtime-waiver', { TYCON_SAFETY_DEADLINE_S: malo }, AHORA), ow.PLAZO_DEL_PRECHEQUEO_MS, malo);
  }
});

test('T108i Prechequeo_ConElTopeDelFreno_UsaLoQueQuedaMenosElMargen', () => {
  // 🔴 rojo si: el chequeo espera su plazo entero aunque al freno le queden pocos segundos
  assert.strictEqual(ow.plazoDelChequeo('runtime-waiver', { TYCON_SAFETY_DEADLINE_S: tope(60000) }, AHORA), ow.PLAZO_DEL_PRECHEQUEO_MS, 'con tiempo de sobra, el suyo');
  assert.strictEqual(ow.plazoDelChequeo('runtime-waiver', { TYCON_SAFETY_DEADLINE_S: tope(9000) }, AHORA), 6000, '9 s que quedan, menos 3 de margen');
  assert.strictEqual(ow.plazoDelChequeo('save', { TYCON_SAFETY_DEADLINE_S: tope(20000) }, AHORA), 17000, 'el ok de guardar también');
  // con menos del mínimo (aquí, medio segundo) no se corre
  assert.strictEqual(ow.plazoDelChequeo('runtime-waiver', { TYCON_SAFETY_DEADLINE_S: tope(4000) }, AHORA + 500), 0);
  assert.strictEqual(ow.plazoDelChequeo('runtime-waiver', { TYCON_SAFETY_DEADLINE_S: tope(4000) }, AHORA - 500), 1500, 'con un segundo y medio, sí');
  assert.strictEqual(ow.plazoDelChequeo('runtime-waiver', { TYCON_SAFETY_DEADLINE_S: tope(-5000) }, AHORA), 0, 'ya vencido');
});

test('T108j Prechequeo_SinTiempo_NoCorreElGuion_YLaVentanaSeAbreComoSiempre', () => {
  // 🔴 rojo si: sin tiempo, el chequeo corre igual. Un guion que no existe dice «niega» si se corre; sin correrlo, «sin
  // respuesta»: la ventana se abre como siempre (la firma automática y el desvío no siguen) y el guion comprueba todo al firmar
  const palabras = ['no-existe-este-guion.js', 'algo'];
  const con = ow.comprobarConElGuion({ firma: 'runtime-waiver', palabras, cwd: os.tmpdir(), env: { ...process.env, TYCON_SAFETY_DEADLINE_S: String(Math.floor(Date.now() / 1000) + 60) } });
  assert.ok(con && con.niega, `con tiempo se corre: ${JSON.stringify(con)}`);
  const sin = ow.comprobarConElGuion({ firma: 'runtime-waiver', palabras, cwd: os.tmpdir(), env: { ...process.env, TYCON_SAFETY_DEADLINE_S: String(Math.floor(Date.now() / 1000) + 2) } });
  assert.match(String(sin && sin.sinRespuesta), /no quedó tiempo/, JSON.stringify(sin));
});

test('T108k Prechequeo_UnGuionTrabado_LoCortaAntesQueElRelojDelFreno', { skip: SKIP }, () => {
  // 🔴 rojo si: el chequeo trabado espera sus 12 s; con el tope del freno a ~5 s lo corta a los ~2 s
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prechequeo-trabado-'));
  const traba = path.join(dir, 'traba.js');
  // se queda esperando sólo en el chequeo (safety-guard-trace.test.js usa la misma forma de cargar algo antes del guion)
  fs.writeFileSync(traba, "if (process.env.TYCON_SIGN_PRECHECK === '1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);\n");
  const t0 = Date.now();
  const r = ow.comprobarConElGuion({ firma: 'runtime-waiver', palabras: [MARKER, 'runtime-waiver', path.join(dir, 'story-9.99.md')], cwd: dir,
    env: { ...process.env, NODE_OPTIONS: `--require "${traba}"`, TYCON_SAFETY_DEADLINE_S: String(Math.floor(t0 / 1000) + 6) } });
  const tardo = Date.now() - t0;
  assert.match(String(r && r.sinRespuesta), /no terminó en \d+ s/, `un chequeo cortado no contestó: ${JSON.stringify(r)}`);
  assert.ok(tardo < 4500, `esperó ${tardo} ms`);
  assert.ok(tardo >= 900, `esperó ${tardo} ms: el chequeo tenía que correr hasta el plazo`);
});

// --- el freno le pasa a la ventana el segundo en que lo corta su reloj -----------------------------------------------
function freno(command, { env = {}, espia }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prechequeo-casa-'));
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd: os.tmpdir() });
  const t0 = Date.now();
  const r = spawnSync('bash', [GUARD], { input, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home, NODE_OPTIONS: `--require "${espia}"`, ...env } });
  return { ...r, t0 };
}
function espia(dir, { frenarAntes = 0 } = {}) {
  const f = path.join(dir, 'vista.jsonl');
  const p = path.join(dir, 'espia.js');
  // anota lo que ve la ventana; con frenarAntes, el primer paso del freno tarda eso (una máquina cargada)
  fs.writeFileSync(p, `const path = require('path');
const g = path.basename(process.argv[1] || '');
if (g === 'owner-window.js') require('fs').appendFileSync(${JSON.stringify(f)}, JSON.stringify({ tope: process.env.TYCON_SAFETY_DEADLINE_S || null, ahora: Date.now() }) + '\\n');
if (g === 'run-close.js' && ${frenarAntes} > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${frenarAntes});
`);
  return { p, vistas: () => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}
const PLAN = `node ${MARKER} approve-plan --approved "sí"`;

test('T108l Freno_LePasaALaVentanaElSegundoEnQueLoCortaSuReloj', { skip: SKIP }, () => {
  // 🔴 rojo si: el freno consulta la ventana sin decirle cuánto le queda
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prechequeo-espia-'));
  const e = espia(dir);
  const r = freno(PLAN, { espia: e.p, env: { TYCON_SAFETY_TIMEOUT_S: '20' } });
  const v = e.vistas();
  assert.ok(v.length >= 1, `la ventana no se consultó: ${r.stdout}${r.stderr}`);
  const corte = Number(v[0].tope) * 1000;
  assert.ok(Number.isInteger(Number(v[0].tope)), JSON.stringify(v[0]));
  // nunca después del reloj real (el freno arrancó antes de consultar la ventana, y su reloj corta a los 20 s), y a lo
  // sumo dos segundos antes por el redondeo
  assert.ok(corte <= v[0].ahora + 20000, `corte ${corte - v[0].ahora} ms después de consultar la ventana`);
  assert.ok(corte >= r.t0 + 17000, `corte ${corte - r.t0} ms después de lanzar el freno`);
});

test('T108m Freno_ConLoAnteriorLento_ElTopeQueLlegaYaDescuentaLoGastado', { skip: SKIP }, () => {
  // 🔴 rojo si: el tope no descuenta lo que el freno ya gastó (la cuenta con SECONDS)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prechequeo-lento-'));
  const e = espia(dir, { frenarAntes: 3000 });
  const r = freno(PLAN, { espia: e.p, env: { TYCON_SAFETY_TIMEOUT_S: '20' } });
  const v = e.vistas();
  assert.ok(v.length >= 1, `la ventana no se consultó: ${r.stdout}${r.stderr}`);
  const queda = Number(v[0].tope) * 1000 - v[0].ahora;
  assert.ok(queda <= 20000 - 3000 + 1000, `a la ventana le quedan ${queda} ms después de gastar 3 s`);
  assert.ok(queda >= 8000, `a la ventana le quedan ${queda} ms`);
});
