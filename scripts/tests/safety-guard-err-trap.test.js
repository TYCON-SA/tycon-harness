#!/usr/bin/env node
'use strict';
// safety-guard-err-trap.test.js — la trampa de errores del freno de comandos deja su línea en hook-errors.log cuando lo
// hace salir 0: el renglón y el texto del guion, nunca el comando del agente. La salida normal del final no escribe nada.
// La prueba de la trampa corre una copia del freno (con sus ayudantes de scripts/lib) en una carpeta temporal, con un
// renglón que falla agregado antes de la primera regla; la carpeta del registro la saca de stateDir de lib/state-dir.js.
// stable-data: no depende de la fecha; el sello del registro sólo se mira por su forma.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const GUARD = path.join(SCRIPTS, 'hooks', 'safety-guard-pre.sh');
const STATE_DIR_LIB = path.join(SCRIPTS, '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js');
// el renglón después del cual se agrega el que falla: la lectura del comando, antes de la primera regla
const ANCLA = 'CMD="$(read_field tool_input.command)" || cannot_read';
const RENGLON_QUE_FALLA = 'grep -q zz-no-esta <<< "$CMD"';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `sg-err-trap-${p}`));
const envDe = (home) => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home });

function registroDe(home) {
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(STATE_DIR_LIB)}).stateDir(process.env.HOME))`],
    { env: envDe(home), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return path.join(r.stdout, 'hook-errors.log');
}
const leer = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function correr(guard, command, home) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'sg-err-trap', cwd: os.tmpdir() });
  return spawnSync('bash', [guard], { input, encoding: 'utf8', timeout: 60000, env: envDe(home) });
}

// copia del freno en <tmp>/scripts/hooks con el renglón que falla (o el bloque que lo contiene), y sus ayudantes en
// <tmp>/scripts/lib; `linea` es el renglón del que falla
function copiaConFalla(bloque = [RENGLON_QUE_FALLA], indice = 0) {
  const raiz = tmp('copia-');
  fs.cpSync(path.join(SCRIPTS, 'lib'), path.join(raiz, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'scripts', 'hooks'), { recursive: true });
  const lineas = fs.readFileSync(GUARD, 'utf8').split('\n');
  const i = lineas.findIndex((l) => l.trim() === ANCLA);
  assert.ok(i >= 0, `no encontré «${ANCLA}» en el freno: la prueba quedó vieja`);
  lineas.splice(i + 1, 0, ...bloque);
  const guard = path.join(raiz, 'scripts', 'hooks', 'safety-guard-pre.sh');
  fs.writeFileSync(guard, lineas.join('\n'), { mode: 0o755 });
  return { guard, linea: i + 2 + indice };
}

test('T14 ErrTrap_LogsLineAndPasses @story-8.257 @ac-10', () => {
  // 🔴 rojo si: la trampa sale 0 sin escribir, escribe sin sello o sin renglón en blanco, o anota el comando del agente.
  const { guard, linea } = copiaConFalla();
  const home = tmp('home-');
  const r = correr(guard, 'rm -rf /tmp/sg-secreto-xyz', home);
  assert.equal(r.status, 0, `salió ${r.status}\n${r.stderr}`);
  const log = leer(registroDe(home));
  const re = new RegExp(`^\\[\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z\\] safety-guard ERR-FAIL-OPEN línea ${linea}: (.*)\\n\\n$`);
  const m = re.exec(log);
  assert.ok(m, `el registro no tiene la forma esperada:\n${JSON.stringify(log)}`);
  assert.match(m[2], /\$CMD/, 'el texto es el del guion, sin expandir');
  assert.doesNotMatch(log, /sg-secreto-xyz/, 'el registro trae el comando del agente');
  assert.doesNotMatch(log, /rm -rf/, 'el registro trae el comando del agente');
});

test('T14b ErrTrap_InsideBlock_LogsTheFailingLine @story-8.257 @ac-10', () => {
  // 🔴 rojo si: con el bash de la Mac (3.2), una falla dentro de un if anota el renglón del «fi» y no el del que falló
  // (prueba del pase adversarial).
  const { guard, linea } = copiaConFalla(['if true; then', '  :', `  ${RENGLON_QUE_FALLA}`, '  :', 'fi'], 2);
  const home = tmp('home-');
  const r = correr(guard, 'ls', home);
  assert.equal(r.status, 0, `salió ${r.status}\n${r.stderr}`);
  assert.match(leer(registroDe(home)), new RegExp(`ERR-FAIL-OPEN línea ${linea}: `));
});

test('T14c ErrTrap_NoLogPlace_StillPasses @story-8.257 @ac-10 @ac-12', () => {
  // 🔴 rojo si: sin poder escribir el registro (la carpeta del estado es un archivo) o sin el ayudante de la carpeta, la
  // trampa sale distinto de 0 o escribe en otro lado.
  const { guard } = copiaConFalla();
  const home = tmp('home-');
  const registro = registroDe(home);
  fs.mkdirSync(path.dirname(path.dirname(registro)), { recursive: true });
  fs.writeFileSync(path.dirname(registro), 'no soy una carpeta');
  const r = correr(guard, 'ls', home);
  assert.equal(r.status, 0, `con la carpeta del estado como archivo salió ${r.status}\n${r.stderr}`);
  assert.equal(fs.readFileSync(path.dirname(registro), 'utf8'), 'no soy una carpeta');
  const sinAyudante = copiaConFalla();
  fs.rmSync(path.join(path.dirname(path.dirname(sinAyudante.guard)), 'lib', 'state-dir.sh'));
  const home2 = tmp('home-');
  const r2 = correr(sinAyudante.guard, 'ls', home2);
  assert.equal(r2.status, 0, `sin el ayudante salió ${r2.status}\n${r2.stderr}`);
  assert.equal(leer(registroDe(home2)), '', 'sin el ayudante escribió el registro');
});

test('T14d ErrTrap_LongTextCut_AskedWindowStillOut @story-8.257 @ac-10', () => {
  // 🔴 rojo si: el texto pasa de 200 caracteres en el registro, o la ventana de permiso que una firma ya pidió no sale.
  const largo = `grep -q ${'z'.repeat(300)} <<< "$CMD"`;
  const { guard } = copiaConFalla([`OW_ASK_JSON='{"ventana":"pedida"}'`, largo], 1);
  const home = tmp('home-');
  const r = correr(guard, 'ls', home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\{"ventana":"pedida"\}/, 'la ventana ya pedida no salió');
  const m = /ERR-FAIL-OPEN línea \d+: (.*)\n\n$/.exec(leer(registroDe(home)));
  assert.ok(m, 'no quedó el registro');
  assert.equal(m[1].length, 200, `el texto tiene ${m[1].length} caracteres`);
});

test('T15 NormalExit_NoErrLine @story-8.257 @ac-16', () => {
  // 🔴 rojo si: la salida normal del final (o un freno que frena) escribe una línea de falla.
  const home = tmp('home-');
  const ok = correr(GUARD, 'ls', home);
  assert.equal(ok.status, 0, ok.stderr);
  const frena = correr(GUARD, 'rm -rf /', home);
  assert.equal(frena.status, 2, 'el freno dejó de frenar lo de siempre');
  assert.equal(leer(registroDe(home)), '', 'la salida normal escribió en hook-errors.log');
});
