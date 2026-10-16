'use strict';

/**
 * owner-email-notice.test.js — el aviso de una sola vez «tu máquina informa tu correo» (story 2.28, decisión 1 · AC 30 ·
 * T42-T43).
 *
 * La máquina que sube al buzón manda en `place.json` el correo global de git de quien la usa (`owner`). El aviso de
 * arranque `scripts/hooks/owner-email-notice.js` se lo dice al dev UNA vez, con cómo verlo y cambiarlo, y deja un sello
 * en la carpeta de estado con la HUELLA del correo (nunca el correo): otra vez sólo si el correo cambia. Lo que no puede
 * pasar:
 *   · decirlo en cada arranque (un aviso de todos los días se deja de leer), o guardar el correo en el sello;
 *   · avisar sin correo, con el buzón apagado, en un agente de compilación, apagado por variable, o sellar en esos casos;
 *   · frenar el arranque o tirar si la carpeta de estado no se deja escribir;
 *   · invocar git (el correo se lee como archivo, con la misma función que arma `owner`).
 *
 * Un HOME de prueba por caso (con USERPROFILE también), el entorno armado de cero (sin TF_BUILD ni GIT_CONFIG_GLOBAL de
 * la máquina que corre la prueba) y un `git` falso al frente del PATH que deja marca si alguien lo llama. Sin red.
 * Los correos son inventados.
 *
 * Correr: node --test scripts/tests/owner-email-notice.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO, 'scripts', 'hooks', 'owner-email-notice.js');
const { stateDir } = require(path.join(REPO, 'scripts', 'setup', 'harness', 'tycon-home.js'));
const SELLO = 'owner-email-notice.json';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-email-notice-'));
test.after(() => {
  // la carpeta sin permiso de escritura se devuelve antes de borrar
  try { (function abrir(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) { const p = path.join(d, e.name); fs.chmodSync(p, 0o700); abrir(p); } } })(tmp); } catch (_) { /* best effort */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// el git falso: si alguien lo llama, deja una marca
const FAKE_BIN = path.join(tmp, 'bin');
const MARCA_GIT = path.join(tmp, 'git-llamado.txt');
fs.mkdirSync(FAKE_BIN, { recursive: true });
fs.writeFileSync(path.join(FAKE_BIN, 'git'), `#!/bin/sh\necho llamado >> "${MARCA_GIT}"\nexit 0\n`, { mode: 0o755 });
fs.writeFileSync(path.join(FAKE_BIN, 'git.cmd'), `@echo llamado>> "${MARCA_GIT}"\r\n`);

let serial = 0;
/** Un HOME de prueba; con `correo`, una configuración global de git que lo trae (null: sin user.email). */
function casa(correo) {
  const home = path.join(tmp, `casa-${++serial}`);
  fs.mkdirSync(home, { recursive: true });
  ponerCorreo(home, correo);
  return home;
}
function ponerCorreo(home, correo) {
  const texto = correo === null ? '[user]\n\tname = Persona de Prueba\n' : `[user]\n\tname = Persona de Prueba\n\temail = ${correo}\n`;
  fs.writeFileSync(path.join(home, '.gitconfig'), texto);
}

/** Corre el aviso con ese HOME y el buzón prendido (salvo que `extra` diga otra cosa). */
function arrancar(home, extra = {}) {
  const env = {
    PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    USERPROFILE: home,
    TYCON_MAILBOX: '1',
    ...extra,
  };
  // en Windows, lo que el proceso hijo necesita para arrancar (la misma forma que las demás pruebas)
  if (process.platform === 'win32') for (const k of ['SystemRoot', 'PATHEXT']) if (process.env[k] !== undefined && !(k in extra)) env[k] = process.env[k];
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const huella = (correo) => crypto.createHash('sha256').update(correo.trim().toLowerCase()).digest('hex');
const rutaSello = (home) => path.join(stateDir(home), SELLO);
const leerSello = (home) => fs.readFileSync(rutaSello(home), 'utf8');
const gitNoLlamado = () => assert.ok(!fs.existsSync(MARCA_GIT), 'el aviso no invoca git: lee la configuración como archivo');

function esElRenglon(out, correo) {
  const lineas = out.split(/\r?\n/).filter((l) => l.trim());
  assert.strictEqual(lineas.length, 1, `un solo renglón; salió:\n${out}`);
  const l = lineas[0];
  assert.ok(l.includes(`(${correo})`), `el renglón dice el correo informado (${correo}): ${l}`);
  assert.ok(l.includes('Tu máquina le informa al equipo tu correo de git'), l);
  assert.ok(l.includes('para que veas tus corridas en el sitio de la organización'), l);
  assert.ok(l.includes('`git config --global user.email`'), `dice cómo verlo: ${l}`);
  assert.ok(l.includes('`git config --global user.email <otro>`'), `dice cómo cambiarlo: ${l}`);
}

function selloConHuella(home, correo) {
  const texto = leerSello(home);
  const sello = JSON.parse(texto);
  assert.strictEqual(sello.email_sha256, huella(correo), 'el sello guarda la huella del correo informado');
  const local = correo.split('@')[0].toLowerCase();
  assert.ok(!texto.toLowerCase().includes(local) && !texto.toLowerCase().includes('ejemplo.test'), `el sello nunca guarda el correo: ${texto}`);
}

test('T42_AvisoDelCorreo_UnaVez_YOtraSiCambia', () => {
  const home = casa('  Persona.Uno@Ejemplo.Test ');

  const r1 = arrancar(home);
  assert.strictEqual(r1.code, 0, r1.err);
  assert.strictEqual(r1.err, '');
  esElRenglon(r1.out, 'persona.uno@ejemplo.test');
  selloConHuella(home, 'persona.uno@ejemplo.test');

  for (const n of [2, 3]) {
    const r = arrancar(home);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(r.out, '', `arranque ${n}: con el sello de ese correo, calla`);
  }
  selloConHuella(home, 'persona.uno@ejemplo.test');

  // la persona cambia su correo global de git: se dice otra vez, con el nuevo, y el sello se renueva
  ponerCorreo(home, 'otra.persona@ejemplo.test');
  const r4 = arrancar(home);
  assert.strictEqual(r4.code, 0, r4.err);
  esElRenglon(r4.out, 'otra.persona@ejemplo.test');
  assert.ok(!r4.out.includes('persona.uno@'), 'el renglón dice el correo nuevo, no el viejo');
  selloConHuella(home, 'otra.persona@ejemplo.test');
  assert.strictEqual(arrancar(home).out, '', 'con el sello renovado, calla');

  gitNoLlamado();
});

test('T43_AvisoDelCorreo_CallaSinBuzonSinCorreoOEnCompilacion', () => {
  const casos = [
    ['sin user.email', casa(null), {}],
    ['el buzón apagado', casa('persona.dos@ejemplo.test'), { TYCON_MAILBOX: '0' }],
    ['TYCON_NO_UPLOAD_RUNS=1', casa('persona.dos@ejemplo.test'), { TYCON_NO_UPLOAD_RUNS: '1' }],
    ['un agente de compilación', casa('persona.dos@ejemplo.test'), { TF_BUILD: 'True' }],
    ['TYCON_OWNER_EMAIL_NOTICE=0', casa('persona.dos@ejemplo.test'), { TYCON_OWNER_EMAIL_NOTICE: '0' }],
  ];
  for (const [nombre, home, extra] of casos) {
    const r = arrancar(home, extra);
    assert.strictEqual(r.code, 0, `${nombre}: ${r.err}`);
    assert.strictEqual(r.out, '', `${nombre}: calla`);
    assert.strictEqual(r.err, '', `${nombre}: sin nada en la salida de errores`);
    assert.ok(!fs.existsSync(rutaSello(home)), `${nombre}: no sella`);
  }

  // la carpeta de estado no se deja escribir: calla, sale 0 y no tira (sin sello, no se promete «una sola vez»)
  const home = casa('persona.tres@ejemplo.test');
  const dir = stateDir(home);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const sinPermisos = process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0);
  if (sinPermisos) { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, 0o555); }
  else fs.writeFileSync(dir, 'no es una carpeta');   // Windows o root: la carpeta de estado es un archivo, tampoco se escribe
  const r = arrancar(home);
  if (sinPermisos) fs.chmodSync(dir, 0o700);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, '', 'sin poder sellar, calla');
  assert.strictEqual(r.err, '', 'no tira');
  assert.ok(!fs.existsSync(path.join(dir, SELLO)), 'no quedó sello');

  gitNoLlamado();
});
