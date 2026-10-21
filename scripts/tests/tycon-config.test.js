'use strict';

/**
 * tycon-config.test.js — el lector de configuración del arnés (T1, T2, T3).
 *
 * POR QUÉ EXISTE. «Dónde está el arnés», «dónde viven los repos», «cuál es la organización de Azure DevOps»
 * y «a quién avisar» no pueden estar escritos en el código: valdrían en la máquina donde se escribieron y en
 * ninguna otra. Salen de UNA sola cadena —variable de entorno › archivo de la máquina (`~/.claude/tycon.json`) ›
 * perfil del equipo (`team-profile.json`, o `perfil-equipo.json`, el nombre anterior) › apagado / sin valor— y
 * `explicar` dice de dónde salió cada valor.
 *
 * Lo que estas pruebas sostienen:
 *   T1 · la precedencia: la misma clave en los cuatro niveles, quitando uno por vez → gana el más alto
 *        presente, y `explicar` muestra el origen correcto; las variables que ya existían siguen
 *        mandando con su nombre (`TYCON_ADO_ORG` y `ADO_ORG`); `TYCON_PROFILE` reemplaza o anula el perfil.
 *   T2 · un archivo roto NO se lee como «todo apagado»: un COMANDO frena (exit ≠ 0) nombrando archivo,
 *        clave y motivo; un HOOK lo dice por stderr en CADA corrida, sale 0, no deniega la herramienta y
 *        no hace la parte de la integración. Se prueba con un hook de verdad (`engram-pre-commit.sh`,
 *        PreToolUse|Bash) y un `engram` de mentira que registra si lo llamaron.
 *   T3 · el perfil del equipo sólo trae valores del equipo: un chat_id, un email o algo con forma de
 *        token lo hacen inválido con el motivo; lo mismo en el archivo de la máquina se acepta.
 *
 * 🔴 Sin `scripts/lib/tycon-config.js` todo falla (no existe el lector).
 * 🔴 Nada acá toca el HOME real: cada caso arma su HOME y su «arnés» (carpeta con perfil) en el temporal.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const LIB = path.join(SCRIPTS, 'lib', 'tycon-config.js');
const HOOK = path.join(SCRIPTS, 'hooks', 'engram-pre-commit.sh');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function casa() { const h = tmp('tcfg-home-'); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; }
/** Un «arnés» de mentira: sólo la carpeta donde vive `perfil-equipo.json` (objeto → JSON; string → tal cual). */
function arnesCon(perfil) {
  const d = tmp('tcfg-arnes-');
  if (perfil !== undefined && perfil !== null) {
    fs.writeFileSync(path.join(d, 'perfil-equipo.json'), typeof perfil === 'string' ? perfil : JSON.stringify(perfil, null, 2));
  }
  return d;
}
function maquina(home, contenido) {
  const p = path.join(home, '.claude', 'tycon.json');
  fs.writeFileSync(p, typeof contenido === 'string' ? contenido : JSON.stringify(contenido, null, 2));
  return p;
}
const ENV_LIMPIO = { PATH: process.env.PATH };
function lib() { return require(LIB); }
function cargar(opts) { return lib().cargar(Object.assign({ env: {} }, opts)); }
function cli(args, { home, env } = {}) {
  return spawnSync(process.execPath, [LIB, ...args], {
    encoding: 'utf8', env: Object.assign({}, ENV_LIMPIO, { HOME: home }, env || {}),
  });
}

// ── T1 ────────────────────────────────────────────────────────────────────────────────────────────

test('T1 Config_Precedencia_EnvMaquinaPerfilApagado — gana el nivel más alto presente y explicar lo dice', () => {
  const home = casa();
  const arnes = arnesCon({ ado: { org: 'https://dev.azure.com/perfil' }, integraciones: { clockify: true } });
  maquina(home, { ado: { org: 'https://dev.azure.com/maquina' }, integraciones: { clockify: true } });
  const env = { TYCON_ADO_ORG: 'https://dev.azure.com/env', TYCON_CLOCKIFY: '0' };

  // los cuatro niveles → env
  let c = cargar({ env, home, arnes });
  assert.deepEqual(c.errores, []);
  assert.equal(c.valores.ado.org, 'https://dev.azure.com/env');
  assert.equal(c.origenes['ado.org'], 'env');
  assert.equal(c.valores.integraciones.clockify, false);
  assert.equal(c.origenes['integraciones.clockify'], 'env');

  // sin env → máquina
  c = cargar({ env: {}, home, arnes });
  assert.equal(c.valores.ado.org, 'https://dev.azure.com/maquina');
  assert.equal(c.origenes['ado.org'], 'maquina');
  assert.equal(c.valores.integraciones.clockify, true);
  assert.equal(c.origenes['integraciones.clockify'], 'maquina');

  // sin máquina → perfil
  fs.unlinkSync(path.join(home, '.claude', 'tycon.json'));
  c = cargar({ env: {}, home, arnes });
  assert.equal(c.valores.ado.org, 'https://dev.azure.com/perfil');
  assert.equal(c.origenes['ado.org'], 'perfil');
  assert.equal(c.origenes['integraciones.clockify'], 'perfil');

  // sin perfil → apagado / sin valor
  c = cargar({ env: {}, home, arnes: arnesCon(null) });
  assert.equal(c.valores.ado.org, null);
  assert.equal(c.origenes['ado.org'], 'sin-valor');
  assert.equal(c.valores.integraciones.clockify, false);
  assert.equal(c.origenes['integraciones.clockify'], 'apagado');

  // `TYCON_PROFILE=0` corre SIN perfil aunque el archivo esté al lado del script
  c = cargar({ env: { TYCON_PROFILE: '0' }, home, arnes });
  assert.equal(c.origenes['ado.org'], 'sin-valor');
  assert.equal(c.archivos.perfil.estado, 'anulado');

  // `TYCON_PROFILE=<ruta>` reemplaza el perfil del arnés
  const otro = path.join(arnesCon({ ado: { org: 'https://dev.azure.com/otro-perfil' } }), 'perfil-equipo.json');
  c = cargar({ env: { TYCON_PROFILE: otro }, home, arnes });
  assert.equal(c.valores.ado.org, 'https://dev.azure.com/otro-perfil');
  assert.equal(c.archivos.perfil.ruta, otro);

  // las variables que ya existían siguen valiendo con su nombre: ADO_ORG también es ado.org, y
  // TYCON_ADO_ORG gana sobre ADO_ORG
  c = cargar({ env: { ADO_ORG: 'https://dev.azure.com/legacy' }, home, arnes });
  assert.equal(c.valores.ado.org, 'https://dev.azure.com/legacy');
  assert.equal(c.origenes['ado.org'], 'env');
  c = cargar({ env: { ADO_ORG: 'https://dev.azure.com/legacy', TYCON_ADO_ORG: 'https://dev.azure.com/nuevo' }, home, arnes });
  assert.equal(c.valores.ado.org, 'https://dev.azure.com/nuevo');

  // TYCON_CODEX sigue mandando y tiene tres estados; sin nada, codex queda apagado; el perfil puede decir "detect"
  assert.equal(cargar({ env: { TYCON_CODEX: '1' }, home, arnes }).valores.integraciones.codex, true);
  assert.equal(cargar({ env: { TYCON_CODEX: '0' }, home, arnes }).valores.integraciones.codex, false);
  assert.equal(cargar({ env: {}, home, arnes: arnesCon(null) }).valores.integraciones.codex, false);
  assert.equal(cargar({ env: {}, home, arnes: arnesCon({ integrations: { codex: 'detect' } }) }).valores.integraciones.codex, 'detect');

  // explicar: cada valor con su origen
  maquina(home, { telegram: { chat_id: '4242' } });
  const texto = lib().explicar({ env: { TYCON_CLOCKIFY: '1' }, home, arnes });
  assert.match(texto, /ado\.org[^\n]*\(perfil\)/);
  assert.match(texto, /telegram\.chat_id[^\n]*\(maquina\)/);
  assert.match(texto, /clockify[^\n]*prendida[^\n]*\(env\)/);
  assert.match(texto, /codegraph[^\n]*apagada/);
  const json = lib().explicar({ env: { TYCON_CLOCKIFY: '1' }, home, arnes, json: true });
  assert.equal(json.origenes['integraciones.clockify'], 'env');
  assert.equal(json.origenes['integraciones.codegraph'], 'apagado');
  // …y la CLI imprime lo mismo (con el perfil fijado por variable, que es como se apunta desde afuera)
  const r = cli(['explain'], { home, env: { TYCON_PROFILE: path.join(arnes, 'perfil-equipo.json') } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ado\.org[^\n]*\(perfil\)/);
  // …y `get <clave>` es lo que usan los scripts de shell
  const g = cli(['get', 'ado.org'], { home, env: { TYCON_PROFILE: path.join(arnes, 'perfil-equipo.json') } });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.stdout.trim(), 'https://dev.azure.com/perfil');
  const g2 = cli(['get', 'ado.org'], { home, env: { TYCON_PROFILE: '0' } });
  assert.equal(g2.status, 3, 'sin valor → exit 3, para que un `$(...)` vacío no se lea como «pregunté y no hay»');
});

// ── T2 ────────────────────────────────────────────────────────────────────────────────────────────

test('T2 Config_ArchivoRoto_FallaNombrandoArchivoYClave — un comando frena con archivo, clave y motivo', () => {
  const { ConfigError } = lib();
  // (a) JSON ilegible en el archivo de la máquina
  let home = casa();
  const rota = maquina(home, '{ "ado": { "org": "x", }');
  assert.throws(() => lib().leer({ env: {}, home, arnes: arnesCon(null) }), (e) => {
    assert.ok(e instanceof ConfigError, 'tira ConfigError');
    assert.equal(e.errores.length, 1);
    assert.equal(e.errores[0].archivo, rota);
    assert.match(e.errores[0].motivo, /JSON/i);
    assert.match(e.message, new RegExp(rota.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  // (b) clave desconocida en el perfil
  const arnesRoto = arnesCon({ integraciones: { clokify: true } });
  assert.throws(() => lib().leer({ env: {}, home: casa(), arnes: arnesRoto }), (e) => {
    assert.equal(e.errores[0].archivo, path.join(arnesRoto, 'perfil-equipo.json'));
    assert.equal(e.errores[0].clave, 'integraciones.clokify');
    assert.match(e.errores[0].motivo, /desconocida/);
    return true;
  });
  // (c) tipo equivocado en la máquina
  home = casa();
  const tipo = maquina(home, { integraciones: { engram: 'si' } });
  assert.throws(() => lib().leer({ env: {}, home, arnes: arnesCon(null) }), (e) => {
    assert.equal(e.errores[0].archivo, tipo);
    assert.equal(e.errores[0].clave, 'integraciones.engram');
    assert.match(e.errores[0].motivo, /booleano|tipo/i);
    return true;
  });
  // (d) una variable con un valor que no es del tipo también es configuración rota, y se dice
  assert.throws(() => lib().leer({ env: { TYCON_CLOCKIFY: 'quizás' }, home: casa(), arnes: arnesCon(null) }), (e) => {
    assert.equal(e.errores[0].archivo, 'entorno');
    assert.equal(e.errores[0].clave, 'TYCON_CLOCKIFY');
    return true;
  });
  // (e) `cargar` no tira: devuelve los errores para quien quiera decidir; `leer` sí tira
  const c = cargar({ env: {}, home, arnes: arnesCon(null) });
  assert.equal(c.errores.length, 1);
  // (e') `TYCON_PROFILE` apuntando a un archivo que no existe es configuración rota, no «sin perfil»
  assert.throws(() => lib().leer({ env: { TYCON_PROFILE: path.join(tmp('tcfg-nada-'), 'no-existe.json') }, home: casa(), arnes: arnesCon(null) }), (e) => {
    assert.match(e.errores[0].motivo, /no existe/);
    assert.match(e.errores[0].archivo, /no-existe\.json$/);
    return true;
  });
  // (f) la CLI (un comando) sale ≠ 0 nombrando el archivo, la clave y el motivo
  const r = cli(['explain'], { home, env: { TYCON_PROFILE: '0' } });
  assert.equal(r.status, 2, 'un comando con la config rota sale 2');
  assert.match(r.stderr, new RegExp(tipo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.stderr, /integraciones\.engram/);
  const v = cli(['validate'], { home, env: { TYCON_PROFILE: '0' } });
  assert.equal(v.status, 2);
});

test('T2 Config_ArchivoRoto — un hook lo dice en CADA corrida, sale 0 y no hace la parte de la integración', () => {
  const home = casa();
  const rota = maquina(home, '{ "integrations": { "engram": "si" } }');
  // (a) el modo hook del lector: aviso por stderr dos veces seguidas (sin sello), exit 0, stdout vacío
  for (let i = 0; i < 2; i++) {
    const h = cli(['validate', '--hook'], { home, env: { TYCON_PROFILE: '0' } });
    assert.equal(h.status, 0, `corrida ${i + 1}: un hook nunca sale ≠ 0 por la config`);
    assert.match(h.stderr, /integrations\.engram/, `corrida ${i + 1}: el aviso nombra la clave`);
    assert.match(h.stderr, new RegExp(rota.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `corrida ${i + 1}: y el archivo`);
    assert.equal(h.stdout, '', 'nada por stdout: un PreToolUse no debe emitir JSON de decisión por esto');
  }
  const ph = lib().leerParaHook({ env: {}, home, arnes: arnesCon(null) });
  assert.equal(ph.ok, false);
  assert.match(ph.aviso, /integrations\.engram/);
  assert.equal(typeof ph.aviso, 'string');
  const ok = lib().leerParaHook({ env: {}, home: casa(), arnes: arnesCon(null) });
  assert.equal(ok.ok, true);
  assert.ok(ok.config && ok.config.valores);

  // (b) un hook DE VERDAD: engram-pre-commit.sh (PreToolUse|Bash) ante un `git commit` en un repo con
  //     memoria. Un `engram` de mentira registra si lo llamaron. Con la config rota: aviso ×2, exit 0,
  //     cero llamadas, sin denegar la herramienta. Con la config sana: SÍ llama (control anti-tautología).
  const bin = tmp('tcfg-bin-');
  const registro = path.join(bin, 'llamadas.log');
  fs.writeFileSync(path.join(bin, 'engram'), `#!/bin/sh\necho "$@" >> "${registro}"\nexit 0\n`, { mode: 0o755 });
  const repo = tmp('tcfg-repo-');
  spawnSync('git', ['-C', repo, 'init', '-q']);
  fs.mkdirSync(path.join(repo, '.engram', 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.engram-project'), 'prueba\n');
  fs.writeFileSync(path.join(repo, '.engram', 'manifest.json'), '{"version":1,"chunks":[]}\n');
  const correrHook = (h) => spawnSync('bash', [HOOK], {
    cwd: repo, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' }, cwd: repo }),
    // engram PRENDIDA (TYCON_ENGRAM=1): con el perfil apagado viene apagada, y el hook no sincroniza con su
    // integración apagada — el caso mide la configuración ROTA, no la llave
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: h, TYCON_PROFILE: '0', TYCON_ENGRAM: '1' },
  });
  for (let i = 0; i < 2; i++) {
    const r = correrHook(home);
    assert.equal(r.status, 0, `hook, corrida ${i + 1}: exit 0 (stderr: ${r.stderr})`);
    assert.match(r.stderr, /integrations\.engram/, `hook, corrida ${i + 1}: el aviso sale`);
    assert.doesNotMatch(r.stdout, /"decision"/, 'no deniega la herramienta');
    assert.ok(!fs.existsSync(registro), `hook, corrida ${i + 1}: engram NO se llamó`);
  }
  const sano = correrHook(casa());
  assert.equal(sano.status, 0, sano.stderr);
  assert.ok(fs.existsSync(registro) && /sync --project prueba/.test(fs.readFileSync(registro, 'utf8')),
    'con la config sana el hook SÍ sincroniza (si esto falla, el caso de arriba no probaba nada)');
});

// ── T3 ────────────────────────────────────────────────────────────────────────────────────────────

test('T3 Config_ValorPersonalEnPerfil_Rechazado — lo personal invalida el perfil; en la máquina se acepta', () => {
  const casos = [
    [{ telegram: { chat_id: '1122334455' } }, 'telegram.chat_id', /personal/],
    [{ ado: { org: 'dev.a.bis@example.com' } }, 'ado.org', /personal.*email|email.*personal/i],
    [{ ado: { org: '1234567890:AAFabcdefghijklmnopqrstuvwxyz0123456789' } }, 'ado.org', /personal.*token|token.*personal/i],
    [{ rutas: { repos: '~/Proyectos' } }, 'rutas.repos', /máquina|maquina/i],
  ];
  for (const [perfil, clave, motivo] of casos) {
    const arnes = arnesCon(perfil);
    assert.throws(() => lib().leer({ env: {}, home: casa(), arnes }), (e) => {
      assert.equal(e.errores[0].archivo, path.join(arnes, 'perfil-equipo.json'), `${clave}: nombra el perfil`);
      assert.equal(e.errores[0].clave, clave);
      assert.match(e.errores[0].motivo, motivo, `${clave}: el motivo dice por qué`);
      return true;
    });
  }
  // los mismos valores en el archivo de la máquina se aceptan
  const home = casa();
  maquina(home, { telegram: { chat_id: '1122334455' }, rutas: { repos: '~/Proyectos' } });
  const c = lib().leer({ env: {}, home, arnes: arnesCon(null) });
  assert.equal(c.valores.telegram.chat_id, '1122334455');
  assert.equal(c.origenes['telegram.chat_id'], 'maquina');
  assert.equal(c.valores.rutas.repos, path.join(home, 'Proyectos'), 'la `~` se expande al HOME dado');
});

test('T3 Config_PerfilRealDelEquipo_SinNadaPersonal — el perfil que viaja en el arnés es válido y no trae nada personal (NO MEDIDO sin él)', (t) => {
  // En la copia pública el perfil del equipo no viaja: sin él esta prueba no tiene qué mirar y lo dice —
  // NO MEDIDO, nunca un verde—. En el interno mide lo de siempre.
  const rutaReal = lib().perfilDelArbol(path.join(SCRIPTS, '..')).ruta;   // el nombre actual, o el anterior
  if (!fs.existsSync(rutaReal)) {
    console.log(`  ℹ NO MEDIDO — el perfil del equipo no está (${rutaReal}): la copia pública no lo trae. No se juzga acá.`);
    t.skip('perfil del equipo ausente: no medido');
    return;
  }
  const real = lib().leer({ env: {}, home: casa() });
  assert.equal(real.archivos.perfil.estado, 'leido');
  assert.equal(real.valores.telegram.chat_id, null, 'el perfil real no trae chat');
});

// ── Valores con FORMA de secreto de un proveedor: armados por partes ──────────────────
// Este archivo sale en la copia pública, y el escaneo de secretos de GitHub no lee las excepciones del equipo: ninguna
// línea trae uno de estos valores entero. Son todos de mentira, y en ejecución cada caso recibe el texto de siempre.
const GH_UPPER = 'gh' + 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
const GH_LOWER = 'gh' + 'p_abcdefghijklmnopqrstuvwxyz1234567890';
const AWS_SHAPE = 'AKIA' + 'IOSFODNN7EXAMPLE';
const PEM_BEGIN = '-----BEGIN RSA PRIVATE ' + 'KEY-----';
const SLACK_SHAPE = 'xox' + 'b-1234567890-abcdefghij';
// Un JWT son tres tramos unidos por puntos: {"alg":"HS256"}, {"sub":"dev"} y la firma (una larga y una corta).
const JWT_PARTS = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJkZXYifQ'];
const JWT_LONG = [...JWT_PARTS, 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.');
const JWT_SHORT = [...JWT_PARTS, 'SflKxwRJSM'].join('.');

// ── lo que el lector normaliza y lo que un comentario no puede traer ──

test('T3 Config_ComentarioConDatoPersonal_Rechazado — un email, un token o un chat bajo `__doc`/`__nota` invalidan el perfil; en la máquina se aceptan', () => {
  const casos = [
    [{ __contacto: 'dev.a.bis@example.com', ado: { org: 'https://dev.azure.com/equipo' } }, '__contacto', /email/i],
    [{ integraciones: { __nota: '1234567890:AAFabcdefghijklmnopqrstuvwxyz0123456789', clockify: true } }, 'integraciones.__nota', /token/i],
    [{ __x: { telegram: { chat_id: '1122334455' } } }, '__x', /chat/i],
    // formas de secreto que un corte de 32 caracteres no atraparía
    [{ __nota: `firmar con ${JWT_LONG}` }, '__nota', /JWT/],
    [{ ado: { org: 'https://dev.azure.com/equipo', __nota: AWS_SHAPE } }, 'ado.__nota', /AWS/],
    [{ __doc: 'password=hunter2 para el buzón' }, '__doc', /credencial/],
    [{ __doc: `usar ${GH_UPPER}` }, '__doc', /GitHub/],
    // con espacios adentro: la tokenización no las puede partir antes de mirarlas
    [{ __nota: 'el buzón usa token: abcdef123456 hasta que se rote' }, '__nota', /credencial/],
    [{ __doc: `${PEM_BEGIN} MIIEow… -----END RSA PRIVATE KEY-----` }, '__doc', /clave privada/],
    // escrito como chat_id=…. Un número suelto («avisar al chat 1122334455.») NO se frena: sólo lo inequívoco — ver T4.
    [{ __nota: 'chat_id=1122334455' }, '__nota', /credencial|chat/i],
    [{ __doc: `el token es ${GH_LOWER}.` }, '__doc', /GitHub|token/i],
  ];
  for (const [perfil, clave, motivo] of casos) {
    const arnes = arnesCon(perfil);
    assert.throws(() => lib().leer({ env: {}, home: casa(), arnes }), (e) => {
      assert.equal(e.errores[0].archivo, path.join(arnes, 'perfil-equipo.json'), `${clave}: nombra el perfil`);
      assert.equal(e.errores[0].clave, clave);
      assert.match(e.errores[0].motivo, /comentario/, `${clave}: dice que estaba en un comentario`);
      assert.match(e.errores[0].motivo, motivo, `${clave}: y qué forma tenía`);
      return true;
    });
  }
  // control: un comentario de verdad (texto del equipo) no molesta…
  const sano = arnesCon({ __doc: 'perfil del equipo · ver guides/integrations/engram-workflow.md (story 8.3, 2026-09-26)', ado: { org: 'https://dev.azure.com/equipo' } });
  assert.equal(lib().leer({ env: {}, home: casa(), arnes: sano }).valores.ado.org, 'https://dev.azure.com/equipo');
  // …y en el archivo de la máquina el mismo comentario personal se acepta (ahí sí vive lo de la persona)
  const home = casa();
  maquina(home, { __contacto: 'dev.a.bis@example.com', telegram: { chat_id: '1122334455' } });
  assert.equal(lib().leer({ env: {}, home, arnes: arnesCon(null) }).valores.telegram.chat_id, '1122334455');
});

// ── el detector de lo personal, sin falsos positivos sobre prosa técnica ──────────

test('T4 Config_ComentarioTecnico_NoEsPersonal — una ruta, una clave del vocabulario, una variable TYCON_* o el número de un build no son datos de una persona (story 8.3.1, AC 3)', () => {
  const comentarios = [
    'clave: integraciones.engram',
    'llave: scripts/metrics/corridas-buzon.json',
    'TYCON_NO_ENGRAM_PROJECT_CHECK_VERBOSE apaga el aviso',
    'build 1234567890 salió verde',
    'la corrida 20260926213714 y el PR 3482123456, id de corrida 987654321, sha 1234567890123',
    'clave ado.org; ver guides/integraciones-por-configuracion-del-equipo.md',
    // sin espacio después de los dos puntos, y un archivo sin carpeta
    'clave:integraciones.engram',
    'llave:scripts/metrics/corridas-buzon.json',
    'clave: tycon.json',
    'llave=perfil-equipo.json',
    'ver guides/decisions/interruptores-fuera-de-tycon-2026-08-25.md',
    'ver corrida-1234567890.json',
    'ver logs/build_1234567890.log',
    // sólo lo inequívoco: lo que sería una ADIVINANZA no rompe el perfil. El número de chat suelto no se frena a
    // propósito; queda para quien revisa el pull request.
    'avisar al chat 1122334455.',
    'la clave es correcto-caballo-bateria-grapadora-secreta',
    'a8f3k2m9q7w1e5r6t4y0u2i8o3p7l1z9',
    'ver 1122334455.json',
    // una dirección con usuario no es un email, y una palabra no es un secreto
    'el remoto es git@github.com:org/repo.git',
    'la org se escribe https://usuario@dev.azure.com/org',
    'token: revisar la doc de rotación',
    'el secret: vive en la bóveda, no acá',
  ];
  for (const c of comentarios) {
    const arnes = arnesCon({ __doc: c, integraciones: { __nota: c }, ado: { org: 'https://dev.azure.com/equipo' } });
    const r = lib().leer({ env: {}, home: casa(), arnes });
    assert.equal(r.valores.ado.org, 'https://dev.azure.com/equipo', `«${c}»: el perfil carga`);
  }
});

test('T5 Config_ComentarioConDatoPersonal_SigueRechazado — lo inequívoco (email, tokens con formato conocido, clave privada, nombre=valor de una credencial) se frena en cualquier lugar del comentario (story 8.3.1, AC 4)', () => {
  const casos = [
    // lo inequívoco se frena esté donde esté: pegado a otra cosa, dentro de una ruta, entre corchetes o con un prefijo
    [{ __doc: `clave: ${GH_UPPER}` }, '__doc', /GitHub/],
    [{ __nota: `ver ${GH_UPPER}/README.md` }, '__nota', /GitHub/],
    [{ __doc: 'build dev.a.bis@example.com' }, '__doc', /email/i],
    [{ __nota: `usar {${GH_UPPER}}` }, '__nota', /GitHub/],
    [{ __nota: `[${AWS_SHAPE}]` }, '__nota', /AWS/],
    // armado en pedazos: escrito entero, el freno de nombres en castellano lo lee como una variable; y el pedazo
    // de la derecha, escrito entero, tiene la forma de una llave de AWS: por eso viene de la constante
    [{ __doc: 'TYCON_' + AWS_SHAPE }, '__doc', /AWS/],
    [{ __doc: 'clave: TYCON_ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123' }, '__doc', /GitHub/],
    [{ __doc: `ver ${SLACK_SHAPE}` }, '__doc', /Slack/],
    [{ __doc: 'usar sk-abcdefghijklmnop1234' }, '__doc', /API/],
    [{ __doc: 'la contraseña: password=hunter2' }, '__doc', /credencial/],
    [{ __doc: 'secret: s3cr3t0' }, '__doc', /credencial/],
    [{ __doc: 'chat_id: 1122334455' }, '__doc', /credencial/],
    // con el nombre de la variable adelante: el guion bajo también separa
    [{ __doc: 'DB_PASSWORD=hunter2' }, '__doc', /credencial/],
    [{ __doc: 'exportar TYCON_API_KEY=abcd1234' }, '__doc', /credencial/],
    // el ajuste para no confundir direcciones y palabras no afloja lo que sí es un dato
    [{ __doc: 'escribir a dev.a.bis@example.com: ahí contesta' }, '__doc', /email/i],
    [{ __doc: 'password=Contraseña!' }, '__doc', /credencial/],
    [{ __doc: 'token: 9f8e7d6c' }, '__doc', /credencial/],
    // la clave viaja también a través de una lista
    [{ __nota: { chat_id: ['1122334455'] } }, '__nota', /credencial/],
    [{ __doc: `firmar con ${JWT_SHORT}` }, '__doc', /JWT/],
  ];
  for (const [perfil, clave, motivo] of casos) {
    const arnes = arnesCon(perfil);
    assert.throws(() => lib().leer({ env: {}, home: casa(), arnes }), (e) => {
      assert.equal(e.errores[0].clave, clave);
      assert.match(e.errores[0].motivo, /comentario/, `${JSON.stringify(perfil)}: dice que estaba en un comentario`);
      assert.match(e.errores[0].motivo, motivo, `${JSON.stringify(perfil)}: y qué forma tenía`);
      return true;
    }, `${JSON.stringify(perfil)} tiene que seguir rechazado`);
  }
});

test('T6 Config_MaquinaAceptaLoPersonal — el mismo comentario, técnico o personal, se acepta en ~/.claude/tycon.json (story 8.3.1, AC 5)', () => {
  for (const c of ['clave: integraciones.engram', 'build 1234567890', 'avisar al chat 1122334455', 'password=hunter2']) {
    const home = casa();
    maquina(home, { __doc: c, telegram: { chat_id: '1122334455' } });
    assert.equal(lib().leer({ env: {}, home, arnes: arnesCon(null) }).valores.telegram.chat_id, '1122334455', `«${c}» en la máquina se acepta`);
  }
});

test('T9 Config_InterruptorPorHook_MandaEnLosDosSentidos — TYCON_ENGRAM_HOOK=1 prende aunque la llave esté apagada; =0 apaga aunque esté prendida; sin poner, decide la llave', () => {
  const { integracionParaHook } = lib();
  const home = casa(); const arnes = arnesCon(null);
  const conInter = (val, extra) => integracionParaHook('engram', { env: Object.assign({}, extra || {}, val === undefined ? {} : { TYCON_ENGRAM_HOOK: val }), home, arnes, interruptor: 'TYCON_ENGRAM_HOOK' });
  assert.equal(conInter(undefined).prendida, false, 'sin interruptor y sin llave: apagada');
  const r1 = conInter('1'); assert.equal(r1.prendida, true, '=1 con la llave apagada: prendida'); assert.match(r1.origen, /interruptor/);
  assert.equal(conInter('0', { TYCON_ENGRAM: '1' }).prendida, false, '=0 con la llave prendida: apagada');
  assert.equal(conInter(undefined, { TYCON_ENGRAM: '1' }).prendida, true, 'sin interruptor decide la llave');
  // un interruptor que no está en la lista no manda (no es un canal para prender cualquier cosa)
  assert.equal(integracionParaHook('engram', { env: { TYCON_WHATEVER: '1' }, home, arnes, interruptor: 'TYCON_WHATEVER' }).prendida, false);
});

test('T1 Config_AdoOrg_Normalizado — barra final, forma visualstudio, usuario y espacios dan la forma canónica; el nombre sale de ahí', () => {
  const { normalizarOrg, nombreDeOrganizacion } = lib();
  assert.equal(normalizarOrg('https://dev.azure.com/equipo/'), 'https://dev.azure.com/equipo');
  assert.equal(normalizarOrg('https://equipo.visualstudio.com/'), 'https://dev.azure.com/equipo');
  assert.equal(normalizarOrg('  https://usuario@dev.azure.com/equipo  '), 'https://dev.azure.com/equipo');
  assert.equal(nombreDeOrganizacion('https://equipo.visualstudio.com'), 'equipo');
  assert.equal(normalizarOrg('otra cosa'), 'otra cosa', 'lo que no es una organización queda como está (recortado)');
  // en los tres orígenes: variable, máquina y perfil
  const home = casa();
  maquina(home, { ado: { org: 'https://equipo.visualstudio.com/' } });
  assert.equal(lib().leer({ env: {}, home, arnes: arnesCon(null) }).valores.ado.org, 'https://dev.azure.com/equipo');
  assert.equal(lib().leer({ env: { TYCON_ADO_ORG: 'https://dev.azure.com/env/ ' }, home, arnes: arnesCon(null) }).valores.ado.org, 'https://dev.azure.com/env');
  assert.equal(lib().leer({ env: {}, home: casa(), arnes: arnesCon({ ado: { org: 'https://dev.azure.com/perfil/' } }) }).valores.ado.org, 'https://dev.azure.com/perfil');
  // y la CLI, que es lo que leen los scripts de shell para derivar el nombre («lo que sigue a la última barra»)
  const g = cli(['get', 'ado.org'], { home, env: { TYCON_PROFILE: '0' } });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.stdout.trim(), 'https://dev.azure.com/equipo');
});

test('T3 Config_RutaRelativaOConEspacios_ResueltaContraElHome — nunca contra el cwd del proceso que lee; `~` también en TYCON_PROFILE', () => {
  const home = casa();
  maquina(home, { rutas: { repos: 'Proyectos' } });
  assert.equal(lib().leer({ env: {}, home, arnes: arnesCon(null) }).valores.rutas.repos, path.join(home, 'Proyectos'));
  maquina(home, { rutas: { repos: ' ~/x ' } });
  assert.equal(lib().leer({ env: {}, home, arnes: arnesCon(null) }).valores.rutas.repos, path.join(home, 'x'));
  // desde otro cwd, la CLI da lo mismo (no depende de <cwd>/Proyectos)
  maquina(home, { rutas: { repos: 'Proyectos' } });
  const r = spawnSync(process.execPath, [LIB, 'get', 'rutas.repos'], { encoding: 'utf8', cwd: os.tmpdir(), env: Object.assign({}, ENV_LIMPIO, { HOME: home, TYCON_PROFILE: '0' }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(home, 'Proyectos'));
  // por VARIABLE, una ruta relativa también va contra el HOME (el mismo lector no puede tener dos reglas)
  assert.equal(lib().leer({ env: { TYCON_REPOS_ROOT: 'Proyectos' }, home, arnes: arnesCon(null) }).valores.rutas.repos, path.join(home, 'Proyectos'));
  // `~` en TYCON_PROFILE se expande al HOME dado
  fs.writeFileSync(path.join(home, 'perfil.json'), JSON.stringify({ ado: { org: 'https://dev.azure.com/tilde' } }));
  assert.equal(lib().leer({ env: { TYCON_PROFILE: '~/perfil.json' }, home, arnes: arnesCon(null) }).valores.ado.org, 'https://dev.azure.com/tilde');
});

test('T2 Config_HookConRuidoEnStderr_NoEsConfigRota — un warning de node por stderr no apaga el engram sync ni se presenta como configuración rota', () => {
  const bin = tmp('tcfg-bin-ruido-');
  const registro = path.join(bin, 'llamadas.log');
  fs.writeFileSync(path.join(bin, 'engram'), `#!/bin/sh\necho "$@" >> "${registro}"\nexit 0\n`, { mode: 0o755 });
  // un `node` que avisa por stderr y después corre el de verdad (NODE_OPTIONS, nvm, una ExperimentalWarning…)
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "(node:1) ExperimentalWarning: algo experimental" >&2\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const repo = tmp('tcfg-repo-ruido-');
  spawnSync('git', ['-C', repo, 'init', '-q']);
  fs.mkdirSync(path.join(repo, '.engram', 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.engram-project'), 'prueba\n');
  fs.writeFileSync(path.join(repo, '.engram', 'manifest.json'), '{"version":1,"chunks":[]}\n');
  const r = spawnSync('bash', [HOOK], {
    cwd: repo, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' }, cwd: repo }),
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: casa(), TYCON_PROFILE: '0', TYCON_ENGRAM: '1' },   // engram prendida: ver T2 de arriba
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ROTA/, 'el ruido de node no se presenta como configuración rota');
  assert.ok(fs.existsSync(registro) && /sync --project prueba/.test(fs.readFileSync(registro, 'utf8')),
    `con la config sana y ruido en stderr el hook SÍ sincroniza (stderr: ${r.stderr})`);
});

// ── lo que el instalador y las pruebas «sin nada» necesitan del lector ─────────────

test('T9 Config_LlaveDelBuzonPorVariable — TYCON_MAILBOX_JSON dice dónde está la llave (la misma variable que lee upload-runs.js): apuntando a un archivo inexistente, el buzón queda apagado aunque el clon traiga la llave', () => {
  const home = casa();
  const arnes = arnesCon(null);
  fs.mkdirSync(path.join(arnes, 'scripts', 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(arnes, 'scripts', 'metrics', 'corridas-buzon.json'), '{}');
  const con = cargar({ home, arnes, env: {} });
  assert.equal(con.valores.integraciones.mailbox, true);
  assert.equal(con.origenes['integraciones.mailbox'], 'archivo-llave');
  const sin = cargar({ home, arnes, env: { TYCON_MAILBOX_JSON: path.join(arnes, 'no-hay-llave.json') } });
  assert.equal(sin.valores.integraciones.mailbox, false, 'sin la llave (por variable) el buzón está apagado');
  assert.equal(sin.origenes['integraciones.mailbox'], 'apagado');
  // y la variable de la llave (TYCON_MAILBOX=0) manda sobre la llave presente
  const off = cargar({ home, arnes, env: { TYCON_MAILBOX: '0' } });
  assert.equal(off.valores.integraciones.mailbox, false);
  assert.equal(off.origenes['integraciones.mailbox'], 'env');
});

test('T9 Config_IntegracionesParaShell — `integrations --shell` imprime una asignación por integración (0 · 1 · detect), exit 0; con la configuración rota no imprime nada y sale 2', () => {
  const home = casa();
  const env = { TYCON_PROFILE: '0', TYCON_MAILBOX_JSON: '/no/hay/llave.json', TYCON_CLOCKIFY: '1', TYCON_ADO_ORG: 'https://dev.azure.com/x', TYCON_CODEX: 'detect' };
  const r = cli(['integrations', '--shell'], { home, env });
  assert.equal(r.status, 0, r.stderr);
  const lineas = r.stdout.trim().split('\n');
  for (const esperada of ['TYCON_INTEG_ADO=1', 'TYCON_INTEG_CLOCKIFY=1', 'TYCON_INTEG_CODEX=detect', 'TYCON_INTEG_ENGRAM=0',
    'TYCON_INTEG_CODEGRAPH=0', 'TYCON_INTEG_MAILBOX=0', 'TYCON_INTEG_NIGHTLY=0', 'TYCON_INTEG_TELEGRAM=0']) {
    assert.ok(lineas.includes(esperada), `falta ${esperada} en:\n${r.stdout}`);
  }
  assert.ok(lineas.every((l) => /^TYCON_INTEG_[A-Z]+=(0|1|detect)$/.test(l)), `sólo asignaciones (el instalador las evalúa):\n${r.stdout}`);
  const j = cli(['integrations', '--json'], { home, env });
  assert.equal(j.status, 0, j.stderr);
  const obj = JSON.parse(j.stdout);
  assert.deepEqual(Object.keys(obj).sort(), ['ado', 'clockify', 'codegraph', 'codex', 'engram', 'mailbox', 'nightly', 'telegram']);
  assert.equal(obj.codex, 'detect'); assert.equal(obj.ado, true); assert.equal(obj.engram, false);
  maquina(home, '{ "integrations": { "clokify": true } }');
  const rota = cli(['integrations', '--shell'], { home, env: { TYCON_PROFILE: '0' } });
  assert.equal(rota.status, 2, 'configuración rota: exit 2');
  assert.match(rota.stderr, /clokify/);
  assert.equal(rota.stdout.trim(), '', 'con la configuración rota no se imprime ninguna asignación (no se lee como «todo apagado»)');
});

test('T9 Config_IntegracionParaHook — integracionParaHook(llave) nunca tira: prendida/apagada con su origen; rota → apagada:false + aviso (el hook lo imprime y no hace su parte)', () => {
  const home = casa();
  const arnes = arnesCon({ integrations: { nightly: true } });
  const on = lib().integracionParaHook('nightly', { home, arnes, env: {} });
  assert.deepEqual([on.ok, on.prendida, on.origen], [true, true, 'perfil']);
  const off = lib().integracionParaHook('nightly', { home, arnes, env: { TYCON_PROFILE: '0' } });
  assert.deepEqual([off.ok, off.prendida, off.origen], [true, false, 'apagado']);
  maquina(home, '{ "integrations": { "nightly": "si" } }');
  const rota = lib().integracionParaHook('nightly', { home, arnes, env: {} });
  assert.equal(rota.ok, false);
  assert.equal(rota.prendida, false, 'con la configuración rota la integración NO se ejecuta');
  assert.match(rota.aviso, /ROTA/);
  assert.match(rota.aviso, /integrations\.nightly/);
  assert.throws(() => lib().integracionParaHook('jira', { home, arnes, env: {} }), /jira/, 'una llave fuera del vocabulario es un error de programación, no un «apagado»');
});

// ── la política de actualización — `update.channel` y `update.apply` ─────────────
// 🔴 Sin la sección `update` en el vocabulario, «sin nada» da `undefined` (no `stable`), el perfil con `update`
//    es «clave desconocida», y `TYCON_UPDATE_CHANNEL=nightly` pasa en silencio.

test('T13 Config_UpdateKeys_DefaultsProfileErrors_InternalAskWarning — sin nada: stable+ask (default); perfil: latest+auto; valor fuera del vocabulario: error (nunca «apagado»); explain con origen; TYCON_UPDATE=0 es interruptor (la parte de doctor vive en harness-doctor.test.sh)', (t) => {
  const { VOCABULARIO, VARIABLES, INTERRUPTORES_POR_HOOK } = lib();
  // el vocabulario y las variables, por nombre (lo que channel.js y el instalador van a leer)
  assert.ok(VOCABULARIO.update && VOCABULARIO.update.channel && VOCABULARIO.update.apply, 'la sección `update` está en el vocabulario');
  assert.deepEqual(VARIABLES['update.channel'], ['TYCON_UPDATE_CHANNEL']);
  assert.deepEqual(VARIABLES['update.apply'], ['TYCON_UPDATE_APPLY']);
  assert.ok(INTERRUPTORES_POR_HOOK.includes('TYCON_UPDATE'), 'TYCON_UPDATE es un interruptor por hook (=0 apaga la actualización del todo)');

  // (a) sin nada → stable + ask, con origen `default` (no `sin-valor`: la política siempre tiene un valor)
  let c = cargar({ env: {}, home: casa(), arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.equal(c.valores.update.channel, 'stable');
  assert.equal(c.valores.update.apply, 'ask');
  assert.equal(c.origenes['update.channel'], 'default');
  assert.equal(c.origenes['update.apply'], 'default');

  // (b) el perfil del equipo → latest + auto, origen perfil; y el detector de lo personal lo acepta
  const arnes = arnesCon({ update: { channel: 'latest', apply: 'auto' } });
  c = cargar({ env: {}, home: casa(), arnes });
  assert.deepEqual(c.errores, [], 'update en el perfil no es un dato personal ni una clave desconocida');
  assert.equal(c.valores.update.channel, 'latest');
  assert.equal(c.valores.update.apply, 'auto');
  assert.equal(c.origenes['update.channel'], 'perfil');
  assert.equal(c.origenes['update.apply'], 'perfil');
  // …y el perfil REAL del equipo trae latest + auto (NO MEDIDO en la copia pública, que no lo trae)
  const rutaReal = lib().perfilDelArbol(path.join(SCRIPTS, '..')).ruta;   // el nombre actual, o el anterior
  if (fs.existsSync(rutaReal)) {
    const real = lib().leer({ env: {}, home: casa() });
    assert.equal(real.valores.update.channel, 'latest', 'el perfil del equipo pide el canal «al día»');
    assert.equal(real.valores.update.apply, 'auto', 'el perfil del equipo aplica solo');
  } else {
    console.log(`  ℹ NO MEDIDO — el perfil del equipo no está (${rutaReal}): la copia pública no lo trae.`);
  }

  // (c) la precedencia de siempre: la máquina gana al perfil, la variable gana a la máquina
  const home = casa();
  maquina(home, { update: { channel: 'stable' } });
  c = cargar({ env: {}, home, arnes });
  assert.equal(c.valores.update.channel, 'stable'); assert.equal(c.origenes['update.channel'], 'maquina');
  assert.equal(c.valores.update.apply, 'auto'); assert.equal(c.origenes['update.apply'], 'perfil');
  c = cargar({ env: { TYCON_UPDATE_CHANNEL: 'latest', TYCON_UPDATE_APPLY: 'ask' }, home, arnes });
  assert.equal(c.valores.update.channel, 'latest'); assert.equal(c.origenes['update.channel'], 'env');
  assert.equal(c.valores.update.apply, 'ask'); assert.equal(c.origenes['update.apply'], 'env');
  assert.equal(c.variables['update.channel'], 'TYCON_UPDATE_CHANNEL');

  // (d) un valor fuera del vocabulario es un ERROR, nunca «apagado» ni el default
  //     · por variable: un comando frena nombrando la variable y los valores válidos…
  const r = cli(['explain'], { home: casa(), env: { TYCON_PROFILE: '0', TYCON_UPDATE_CHANNEL: 'nightly' } });
  assert.equal(r.status, 2, 'un comando con TYCON_UPDATE_CHANNEL=nightly sale 2');
  assert.match(r.stderr, /TYCON_UPDATE_CHANNEL/);
  assert.match(r.stderr, /nightly/);
  assert.match(r.stderr, /latest/); assert.match(r.stderr, /stable/);
  //     …y un hook avisa por stderr y sale 0 (no frena ni deniega)
  const h = cli(['validate', '--hook'], { home: casa(), env: { TYCON_PROFILE: '0', TYCON_UPDATE_CHANNEL: 'nightly' } });
  assert.equal(h.status, 0, 'un hook nunca sale ≠ 0 por la configuración');
  assert.match(h.stderr, /ROTA/); assert.match(h.stderr, /TYCON_UPDATE_CHANNEL/);
  assert.equal(h.stdout, '');
  //     · en ~/.claude/tycon.json: `apply: "yes"` es error con archivo, clave y motivo
  const homeRoto = casa();
  const rota = maquina(homeRoto, { update: { apply: 'yes' } });
  assert.throws(() => lib().leer({ env: {}, home: homeRoto, arnes: arnesCon(null) }), (e) => {
    assert.equal(e.errores.length, 1);
    assert.equal(e.errores[0].archivo, rota);
    assert.equal(e.errores[0].clave, 'update.apply');
    assert.match(e.errores[0].motivo, /auto/); assert.match(e.errores[0].motivo, /ask/); assert.match(e.errores[0].motivo, /"yes"/);
    return true;
  });
  //     · un tipo que no es texto tampoco pasa, y una clave desconocida en `update` se dice
  assert.throws(() => lib().leer({ env: {}, home: casa(), arnes: arnesCon({ update: { channel: true } }) }), (e) => { assert.equal(e.errores[0].clave, 'update.channel'); return true; });
  assert.throws(() => lib().leer({ env: {}, home: casa(), arnes: arnesCon({ update: { canal: 'latest' } }) }), (e) => { assert.equal(e.errores[0].clave, 'update.canal'); assert.match(e.errores[0].motivo, /desconocida/); return true; });
  //     · `cargar` (sin tirar) NO rellena con el default lo que está roto: no hay valor que leer como «stable»
  const cr = cargar({ env: { TYCON_UPDATE_APPLY: 'maybe' }, home: casa(), arnes: arnesCon(null) });
  assert.equal(cr.errores.length, 1);
  assert.equal(cr.errores[0].clave, 'TYCON_UPDATE_APPLY');

  // (e) explain muestra las dos claves con su origen, en texto y en --json
  const texto = lib().explicar({ env: { TYCON_UPDATE_CHANNEL: 'latest' }, home: casa(), arnes: arnesCon(null) });
  assert.match(texto, /update\.channel = latest \(env\)/);
  assert.match(texto, /update\.apply = ask \(default\)/);
  const json = lib().explicar({ env: {}, home: casa(), arnes, json: true });
  assert.equal(json.valores.update.channel, 'latest');
  assert.equal(json.origenes['update.channel'], 'perfil');
  assert.equal(json.origenes['update.apply'], 'perfil');
  const jd = lib().explicar({ env: {}, home: casa(), arnes: arnesCon(null), json: true });
  assert.equal(jd.origenes['update.channel'], 'default');
  //     …y la CLI: `explain` imprime el origen y `get update.channel` anda (lo que leen channel.js y los scripts de shell)
  const e = cli(['explain'], { home: casa(), env: { TYCON_PROFILE: path.join(arnes, 'perfil-equipo.json') } });
  assert.equal(e.status, 0, e.stderr);
  assert.match(e.stdout, /update\.channel = latest \(perfil\)/);
  const g = cli(['get', 'update.channel'], { home: casa(), env: { TYCON_PROFILE: '0' } });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.stdout.trim(), 'stable', 'sin nada, `get update.channel` da el default (exit 0: hay valor)');
  const ga = cli(['get', 'update.apply'], { home: casa(), env: { TYCON_PROFILE: path.join(arnes, 'perfil-equipo.json') } });
  assert.equal(ga.stdout.trim(), 'auto');

  // (f) TYCON_UPDATE=0 es un interruptor por hook: explain lo muestra como tal (lo lee channel.js, no este lector)
  const ci = cargar({ env: { TYCON_UPDATE: '0' }, home: casa(), arnes: arnesCon(null) });
  assert.deepEqual(ci.errores, [], 'el interruptor no es un valor del vocabulario: no se valida como tal');
  assert.equal(ci.entorno.interruptores.TYCON_UPDATE, '0');
  assert.match(lib().explicar({ env: { TYCON_UPDATE: '0' }, home: casa(), arnes: arnesCon(null) }), /interruptores por hook[^\n]*TYCON_UPDATE=0/);

  // (g) la sección se escribe `update` en los archivos (ya está en inglés): una clave `update` en la máquina se lee
  //     y `valor(config, 'update.channel')` la devuelve
  const hm = casa(); maquina(hm, { update: { channel: 'latest', apply: 'auto' } });
  const cm = lib().leer({ env: {}, home: hm, arnes: arnesCon(null) });
  assert.equal(lib().valor(cm, 'update.channel'), 'latest');
  assert.equal(lib().valor(cm, 'update.apply'), 'auto');
  t.diagnostic('T13 cubre AC 12 salvo el aviso de doctor (harness-doctor.test.sh)');
});

// ── T31: la llave de la transición — `update.skills_source` ───────────────────────────────
// De dónde lee las skills una máquina del equipo con dos clones: `separate` (su clon de agent-skills aparte) o
// `unified` (ese clon re-apuntado al repo unido). La clave vive acá; re-apuntar es de `scripts/setup/harness/repoint.js`.
// 🔴 Sin la clave en el vocabulario, «sin nada» da `undefined` (no `separate`), `update.skills_source` en la
//    máquina o en el perfil es «clave desconocida», la variable `TYCON_UPDATE_SKILLS_SOURCE=both` pasa en
//    silencio y `explain` no la muestra.

test('T31 Config_SkillsSourceKey_DefaultSeparate_OutOfVocabularyIsError — sin nada: separate (default); variable › máquina › perfil; un valor fuera de separate|unified es error con archivo y clave, nunca el default; explain con valor y origen; el perfil real no la trae hasta el corte', (t) => {
  const { VOCABULARIO, VARIABLES, DEFAULTS } = lib();
  assert.equal(VOCABULARIO.update.skills_source, 'opcion:separate|unified', 'vocabulario cerrado: separate | unified');
  assert.deepEqual(VARIABLES['update.skills_source'], ['TYCON_UPDATE_SKILLS_SOURCE']);
  assert.equal(DEFAULTS['update.skills_source'], 'separate', 'por defecto, como hoy: cada máquina lee de su clon viejo');

  // (a) sin nada → separate, con origen `default` (siempre tiene un valor: nunca `sin-valor`)
  let c = cargar({ env: {}, home: casa(), arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.equal(c.valores.update.skills_source, 'separate');
  assert.equal(c.origenes['update.skills_source'], 'default');
  //     …y no cambia el default de sus vecinas (la clave nueva no arrastra a sus vecinas)
  assert.equal(c.valores.update.channel, 'stable'); assert.equal(c.valores.update.apply, 'ask');

  // (b) el orden de siempre: perfil → máquina → variable
  const arnes = arnesCon({ update: { channel: 'latest', apply: 'auto', skills_source: 'unified' } });
  c = cargar({ env: {}, home: casa(), arnes });
  assert.deepEqual(c.errores, [], 'la clave en el perfil no es un dato personal ni una clave desconocida');
  assert.equal(c.valores.update.skills_source, 'unified'); assert.equal(c.origenes['update.skills_source'], 'perfil');
  //     la máquina le gana al perfil: así una máquina (las de Windows, por ejemplo) se queda con la llave apagada
  const home = casa();
  maquina(home, { update: { skills_source: 'separate' } });
  c = cargar({ env: {}, home, arnes });
  assert.equal(c.valores.update.skills_source, 'separate'); assert.equal(c.origenes['update.skills_source'], 'maquina');
  assert.equal(c.valores.update.channel, 'latest', 'lo demás del perfil sigue valiendo'); assert.equal(c.origenes['update.channel'], 'perfil');
  //     la variable le gana a la máquina
  c = cargar({ env: { TYCON_UPDATE_SKILLS_SOURCE: 'unified' }, home, arnes });
  assert.equal(c.valores.update.skills_source, 'unified'); assert.equal(c.origenes['update.skills_source'], 'env');
  assert.equal(c.variables['update.skills_source'], 'TYCON_UPDATE_SKILLS_SOURCE');
  //     espejo: una variable vacía no es un valor (manda la máquina)
  c = cargar({ env: { TYCON_UPDATE_SKILLS_SOURCE: '  ' }, home, arnes });
  assert.equal(c.valores.update.skills_source, 'separate'); assert.equal(c.origenes['update.skills_source'], 'maquina');

  // (c) un valor fuera del vocabulario es un ERROR, no «el defecto»
  //     · por variable: un comando sale 2 nombrando la variable y los dos valores; un hook avisa y sale 0
  const r = cli(['explain'], { home: casa(), env: { TYCON_PROFILE: '0', TYCON_UPDATE_SKILLS_SOURCE: 'both' } });
  assert.equal(r.status, 2, 'un comando con TYCON_UPDATE_SKILLS_SOURCE=both sale 2');
  assert.match(r.stderr, /TYCON_UPDATE_SKILLS_SOURCE/); assert.match(r.stderr, /both/);
  assert.match(r.stderr, /separate/); assert.match(r.stderr, /unified/);
  const g2 = cli(['get', 'update.skills_source'], { home: casa(), env: { TYCON_PROFILE: '0', TYCON_UPDATE_SKILLS_SOURCE: 'both' } });
  assert.equal(g2.status, 2, '`get` con la configuración rota tampoco contesta el default');
  assert.equal(g2.stdout.trim(), '', 'nada por stdout: quien lo lee desde shell no recibe «separate»');
  const h = cli(['validate', '--hook'], { home: casa(), env: { TYCON_PROFILE: '0', TYCON_UPDATE_SKILLS_SOURCE: 'both' } });
  assert.equal(h.status, 0, 'un hook nunca sale ≠ 0 por la configuración');
  assert.match(h.stderr, /ROTA/); assert.match(h.stderr, /TYCON_UPDATE_SKILLS_SOURCE/);
  //     · en ~/.claude/tycon.json: error con archivo, clave y motivo
  const homeRoto = casa();
  const rota = maquina(homeRoto, { update: { skills_source: 'merged' } });
  assert.throws(() => lib().leer({ env: {}, home: homeRoto, arnes: arnesCon(null) }), (e) => {
    assert.equal(e.errores.length, 1);
    assert.equal(e.errores[0].archivo, rota);
    assert.equal(e.errores[0].clave, 'update.skills_source');
    assert.match(e.errores[0].motivo, /separate/); assert.match(e.errores[0].motivo, /unified/); assert.match(e.errores[0].motivo, /"merged"/);
    return true;
  });
  //     · en el perfil, igual (otra caja no es el mismo valor); y un tipo que no es texto (true no es «unified») tampoco pasa
  assert.throws(() => lib().leer({ env: {}, home: casa(), arnes: arnesCon({ update: { skills_source: 'Unified' } }) }), (e) => { assert.equal(e.errores[0].clave, 'update.skills_source'); return true; });
  assert.throws(() => lib().leer({ env: {}, home: casa(), arnes: arnesCon({ update: { skills_source: true } }) }), (e) => { assert.equal(e.errores[0].clave, 'update.skills_source'); return true; });
  //     · los tres lectores lo dicen: `cargar` (sin tirar) deja el error en `errores` —quien lo usa tiene que mirarlos:
  //       el valor que queda al lado NO es la respuesta—, `leer` tira, y `leerParaHook` contesta `ok: false` sin config
  const cr = cargar({ env: { TYCON_UPDATE_SKILLS_SOURCE: 'both' }, home: casa(), arnes: arnesCon(null) });
  assert.equal(cr.errores.length, 1);
  assert.equal(cr.errores[0].clave, 'TYCON_UPDATE_SKILLS_SOURCE');
  assert.throws(() => lib().leer({ env: { TYCON_UPDATE_SKILLS_SOURCE: 'both' }, home: casa(), arnes: arnesCon(null) }), /TYCON_UPDATE_SKILLS_SOURCE/);
  const hk = lib().leerParaHook({ env: { TYCON_UPDATE_SKILLS_SOURCE: 'both' }, home: casa(), arnes: arnesCon(null) });
  assert.equal(hk.ok, false); assert.equal(hk.config, undefined, 'un hook no recibe una configuración con la llave rota');

  // (d) explain la muestra con su origen, en texto y en --json; y `get` la contesta (lo que lee un guion de shell)
  assert.match(lib().explicar({ env: {}, home: casa(), arnes: arnesCon(null) }), /update\.skills_source = separate \(default\)/);
  assert.match(lib().explicar({ env: { TYCON_UPDATE_SKILLS_SOURCE: 'unified' }, home: casa(), arnes: arnesCon(null) }), /update\.skills_source = unified \(env\)/);
  assert.match(lib().explicar({ env: {}, home, arnes }), /update\.skills_source = separate \(maquina\)/);
  const json = lib().explicar({ env: {}, home: casa(), arnes, json: true });
  assert.equal(json.valores.update.skills_source, 'unified');
  assert.equal(json.origenes['update.skills_source'], 'perfil');
  const e = cli(['explain'], { home: casa(), env: { TYCON_PROFILE: path.join(arnes, 'perfil-equipo.json') } });
  assert.equal(e.status, 0, e.stderr);
  assert.match(e.stdout, /update\.skills_source = unified \(perfil\)/);
  const g = cli(['get', 'update.skills_source'], { home: casa(), env: { TYCON_PROFILE: '0' } });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.stdout.trim(), 'separate', 'sin nada, `get update.skills_source` da el default (exit 0: hay valor)');
  const cm = lib().leer({ env: {}, home, arnes });
  assert.equal(lib().valor(cm, 'update.skills_source'), 'separate');

  // (e) el perfil REAL del equipo: la clave se crea en el código y el perfil puede no traerla todavía (la prende el
  //     dueño, en su propio pull request). Mientras el perfil no la trae, una máquina del equipo queda en `separate`. Si el
  //     perfil ya la trae, tiene que ser un valor del vocabulario, y se dice: esta prueba no frena su alta.
  const rutaReal = lib().perfilDelArbol(path.join(SCRIPTS, '..')).ruta;   // el nombre actual, o el anterior
  if (fs.existsSync(rutaReal)) {
    const real = lib().leer({ env: {}, home: casa() });
    assert.ok(['separate', 'unified'].includes(real.valores.update.skills_source));
    if (real.origenes['update.skills_source'] === 'default') assert.equal(real.valores.update.skills_source, 'separate');
    t.diagnostic(`el perfil del equipo ${real.origenes['update.skills_source'] === 'perfil' ? `YA trae update.skills_source = ${real.valores.update.skills_source} (el corte está hecho)` : 'todavía no trae update.skills_source: las máquinas quedan en separate'}`);
  } else {
    console.log(`  ℹ NO MEDIDO — el perfil del equipo no está (${rutaReal}): la copia pública no lo trae.`);
  }
});

// ── T37: el paquete del stack viene apagado por defecto — la clave `packs.default` ─────────
// 🔴 Sin la sección `packs` en el vocabulario, «sin nada» da `undefined` (no `none`), un perfil con `packs` es
//    «clave desconocida» y `TYCON_PACKS_DEFAULT=algunos` pasa en silencio.

test('T37 Packs_ApagadoPorDefectoSinPerfil (lector) — sin nada: none (default); perfil all; la variable manda; un valor fuera de all|none es error con archivo y clave; explain con valor y origen; el perfil real del equipo dice all', () => {
  const { VOCABULARIO, VARIABLES, DEFAULTS } = lib();
  assert.ok(VOCABULARIO.packs && VOCABULARIO.packs.default, 'la sección `packs` está en el vocabulario');
  assert.deepEqual(VARIABLES['packs.default'], ['TYCON_PACKS_DEFAULT']);
  assert.equal(DEFAULTS['packs.default'], 'none', 'afuera, sin perfil, el paquete del stack viene apagado');

  // (a) sin nada → none, con origen `default`
  let c = cargar({ env: {}, home: casa(), arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.equal(c.valores.packs.default, 'none');
  assert.equal(c.origenes['packs.default'], 'default');

  // (b) el perfil del equipo → all (no es un dato personal ni una clave desconocida)
  const arnes = arnesCon({ packs: { default: 'all' } });
  c = cargar({ env: {}, home: casa(), arnes });
  assert.deepEqual(c.errores, []);
  assert.equal(c.valores.packs.default, 'all');
  assert.equal(c.origenes['packs.default'], 'perfil');

  // (c) la variable manda sobre el perfil; y SIN perfil, vale lo que diga la máquina (con un perfil que declara los
  //     paquetes, el perfil le gana a la máquina: sus pruebas están al final de este archivo)
  c = cargar({ env: { TYCON_PACKS_DEFAULT: 'none' }, home: casa(), arnes });
  assert.equal(c.valores.packs.default, 'none');
  assert.equal(c.origenes['packs.default'], 'env');
  assert.equal(c.variables['packs.default'], 'TYCON_PACKS_DEFAULT');
  const home = casa();
  maquina(home, { packs: { default: 'all' } });
  c = cargar({ env: {}, home, arnes: arnesCon(null) });
  assert.equal(c.valores.packs.default, 'all');
  assert.equal(c.origenes['packs.default'], 'maquina');

  // (d) un valor fuera de all|none es un ERROR nombrando archivo y clave (nunca «none» ni el default)
  const roto = arnesCon({ packs: { default: 'todos' } });
  assert.throws(() => lib().leer({ env: {}, home: casa(), arnes: roto }), (e) => {
    assert.equal(e.errores.length, 1);
    assert.equal(e.errores[0].archivo, path.join(roto, 'perfil-equipo.json'));
    assert.equal(e.errores[0].clave, 'packs.default');
    assert.match(e.errores[0].motivo, /all/); assert.match(e.errores[0].motivo, /none/); assert.match(e.errores[0].motivo, /"todos"/);
    return true;
  });
  // (un nombre solo es una lista de un paquete —el que no está instalado frena en el pipeline—; inválido es
  // lo que no puede ser un nombre de paquete)
  assert.throws(() => lib().leer({ env: { TYCON_PACKS_DEFAULT: 'Algunos!' }, home: casa(), arnes: arnesCon(null) }), (e) => {
    assert.equal(e.errores[0].archivo, 'entorno');
    assert.equal(e.errores[0].clave, 'TYCON_PACKS_DEFAULT');
    return true;
  });
  assert.throws(() => lib().leer({ env: {}, home: casa(), arnes: arnesCon({ packs: { defecto: 'all' } }) }), (e) => {
    assert.equal(e.errores[0].clave, 'packs.defecto'); assert.match(e.errores[0].motivo, /desconocida/); return true;
  });

  // (e) explain muestra el valor y su origen, en texto, en --json y por la CLI; `get packs.default` anda
  assert.match(lib().explicar({ env: {}, home: casa(), arnes: arnesCon(null) }), /packs\.default = none \(default\)/);
  assert.match(lib().explicar({ env: { TYCON_PACKS_DEFAULT: 'all' }, home: casa(), arnes: arnesCon(null) }), /packs\.default = all \(env\)/);
  const json = lib().explicar({ env: {}, home: casa(), arnes, json: true });
  assert.equal(json.valores.packs.default, 'all');
  assert.equal(json.origenes['packs.default'], 'perfil');
  const e = cli(['explain'], { home: casa(), env: { TYCON_PROFILE: path.join(arnes, 'perfil-equipo.json') } });
  assert.equal(e.status, 0, e.stderr);
  assert.match(e.stdout, /packs\.default = all \(perfil\)/);
  const g = cli(['get', 'packs.default'], { home: casa(), env: { TYCON_PROFILE: '0' } });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.stdout.trim(), 'none');

  // (f) el perfil REAL del equipo prende el paquete para todos: en el equipo nada cambia (NO MEDIDO en la copia pública)
  const rutaReal = lib().perfilDelArbol(path.join(SCRIPTS, '..')).ruta;   // el nombre actual, o el anterior
  if (fs.existsSync(rutaReal)) {
    const real = lib().leer({ env: {}, home: casa() });
    assert.equal(real.valores.packs.default, 'all', 'el perfil del equipo dice packs.default: all');
    assert.equal(real.origenes['packs.default'], 'perfil');
  } else {
    console.log(`  ℹ NO MEDIDO — el perfil del equipo no está (${rutaReal}): la copia pública no lo trae.`);
  }
});

// ── las claves y el valor de integración que se escriben y se ven, en inglés ─────────────────────
// 🔴 Con un vocabulario en castellano, `integrations.mailbox` sería «clave desconocida», `"detect"` un tipo
//    equivocado, `key mailbox` «integración desconocida», y `explain` mostraría las tres con su nombre en castellano.
//    Que los nombres anteriores sigan valiendo lo prueba legacy-names-g.test.js (con el mapa, que la copia no trae).

test('T65 Config_IntegrationKeysInEnglish — mailbox, nightly y "detect" se leen del archivo, del perfil y de la variable; explain, get, key, integrations y los mensajes de «apagado» los muestran así', () => {
  const home = casa();
  const arnes = arnesCon({ integrations: { nightly: true, codex: 'detect' } });
  maquina(home, { integrations: { mailbox: true } });
  const c = cargar({ env: { TYCON_MAILBOX_JSON: '/no/hay/llave.json' }, home, arnes });
  assert.deepEqual(c.errores, []);
  assert.equal(c.valores.integraciones.mailbox, true);
  assert.equal(c.origenes['integraciones.mailbox'], 'maquina');
  assert.equal(c.valores.integraciones.nightly, true);
  assert.equal(c.origenes['integraciones.nightly'], 'perfil');
  assert.equal(c.valores.integraciones.codex, 'detect');
  // las variables: TYCON_MAILBOX / TYCON_NIGHTLY (0 · 1) y TYCON_CODEX (0 · 1 · detect)
  const e = cargar({ env: { TYCON_MAILBOX: '0', TYCON_NIGHTLY: '0', TYCON_CODEX: 'detect', TYCON_PROFILE: '0' }, home: casa(), arnes });
  assert.deepEqual(e.errores, []);
  assert.deepEqual([e.valores.integraciones.mailbox, e.valores.integraciones.nightly, e.valores.integraciones.codex], [false, false, 'detect']);
  assert.equal(e.origenes['integraciones.codex'], 'env');

  // el vocabulario que se informa es el nuevo: una clave mal escrita lista las válidas, y un tipo equivocado dice "detect"
  assert.throws(() => lib().leer({ env: { TYCON_PROFILE: '0' }, home: (() => { const h = casa(); maquina(h, { integrations: { mailbx: true } }); return h; })(), arnes }), (err) => {
    assert.equal(err.errores[0].clave, 'integrations.mailbx');
    assert.match(err.errores[0].motivo, /clockify, engram, codegraph, mailbox, codex, nightly/);
    return true;
  });
  assert.throws(() => lib().leer({ env: { TYCON_PROFILE: '0' }, home: (() => { const h = casa(); maquina(h, { integrations: { codex: 'quizas' } }); return h; })(), arnes }), (err) => {
    assert.match(err.errores[0].motivo, /true, false o "detect"/);
    return true;
  });
  assert.throws(() => lib().leer({ env: { TYCON_PROFILE: '0', TYCON_CODEX: 'quizas' }, home: casa(), arnes }), (err) => {
    assert.match(err.errores[0].motivo, /0 o 1 \(o detect\)/);
    return true;
  });

  // explain (texto y --json), integrations, key y get
  const env = { TYCON_MAILBOX_JSON: '/no/hay/llave.json', TYCON_PROFILE: path.join(arnes, 'perfil-equipo.json') };
  const texto = cli(['explain'], { home, env });
  assert.equal(texto.status, 0, texto.stderr);
  assert.match(texto.stdout, /^\s+mailbox\s+prendida \(maquina/m);
  assert.match(texto.stdout, /^\s+nightly\s+prendida \(perfil\)/m);
  assert.match(texto.stdout, /^\s+codex\s+detect \(perfil\)/m);
  const json = JSON.parse(cli(['explain', '--json'], { home, env }).stdout);
  assert.equal(json.valores.integraciones.mailbox, true);
  assert.equal(json.valores.integraciones.codex, 'detect');
  assert.match(json.integraciones.nightly, /^prendida/);
  assert.match(json.integraciones.codex, /^detect \(/);
  assert.equal(json.origenes['integraciones.nightly'], 'perfil');
  const ocho = JSON.parse(cli(['integrations', '--json'], { home, env }).stdout);
  assert.deepEqual([ocho.mailbox, ocho.nightly, ocho.codex], [true, true, 'detect']);
  const shell = cli(['integrations', '--shell'], { home, env }).stdout.trim().split('\n');
  for (const esperada of ['TYCON_INTEG_MAILBOX=1', 'TYCON_INTEG_NIGHTLY=1', 'TYCON_INTEG_CODEX=detect']) assert.ok(shell.includes(esperada), `falta ${esperada} en:\n${shell.join('\n')}`);
  for (const [llave, estado] of [['mailbox', 'prendida'], ['nightly', 'prendida'], ['codex', 'detect']]) {
    const k = cli(['key', llave], { home, env });
    assert.equal(k.status, 0, `key ${llave}: ${k.stderr}`);
    assert.equal(k.stdout.trim(), estado);
  }
  const apagada = cli(['key', 'nightly'], { home, env: { TYCON_PROFILE: '0' } });
  assert.equal(apagada.status, 3);
  assert.equal(cli(['key', 'nightly', '--hook'], { home, env }).stdout.trim(), 'prendida');
  assert.equal(cli(['get', 'integrations.mailbox'], { home, env }).stdout.trim(), '1');
  assert.equal(cli(['get', 'integrations.codex'], { home, env }).stdout.trim(), 'detect');

  // los mensajes de «apagado» mandan a escribir la forma nueva (son los que imprime un comando que la necesitaba)
  const { COMO_SE_PRENDE, LAS_OCHO, VARIABLES } = lib();
  assert.deepEqual(LAS_OCHO, ['ado', 'clockify', 'engram', 'codegraph', 'mailbox', 'codex', 'nightly', 'telegram']);
  assert.match(COMO_SE_PRENDE.mailbox, /integrations\.mailbox=true/);
  assert.match(COMO_SE_PRENDE.nightly, /integrations\.nightly=true/);
  assert.match(COMO_SE_PRENDE.codex, /integrations\.codex=true o "detect"/);
  assert.deepEqual(VARIABLES['integraciones.mailbox'], ['TYCON_MAILBOX']);
  assert.deepEqual(VARIABLES['integraciones.nightly'], ['TYCON_NIGHTLY']);
  assert.equal(lib().integracionParaComando('mailbox', { home, arnes, env: { TYCON_MAILBOX_JSON: '/no/hay/llave.json' } }).prendida, true);
  const off = lib().integracionParaHook('mailbox', { home: casa(), arnes, env: { TYCON_MAILBOX_JSON: '/no/hay/llave.json' } });
  assert.deepEqual([off.ok, off.prendida], [true, false]);
  assert.match(off.apagada, /integrations\.mailbox=true/);
});

test('T65 Config_TeamProfile_NewKeys — el perfil del equipo que viaja en el arnés escribe mailbox, nightly y "detect" (NO MEDIDO sin él)', (t) => {
  const rutaReal = lib().perfilDelArbol(path.join(SCRIPTS, '..')).ruta;   // el nombre actual, o el anterior
  if (!fs.existsSync(rutaReal)) return t.skip('NO MEDIDO — el perfil del equipo no está: la copia pública no lo trae');
  const perfil = JSON.parse(fs.readFileSync(rutaReal, 'utf8'));
  assert.deepEqual(Object.keys(perfil.integrations).sort(), ['clockify', 'codex', 'engram', 'mailbox', 'nightly']);
  assert.equal(perfil.integrations.codex, 'detect');
  const real = lib().leer({ env: { TYCON_MAILBOX_JSON: '/no/hay/llave.json' }, home: casa() });
  assert.deepEqual([real.valores.integraciones.mailbox, real.valores.integraciones.nightly, real.valores.integraciones.codex], [true, true, 'detect']);
  assert.equal(real.origenes['integraciones.mailbox'], 'perfil');
});

// ── el perfil de instalación ─────────────────────────────────────────────────────────

test('T29 Config_InstallProfile_ClosedNoDefault_EnvFileProfileOrder_Explain — sin nada: nulo con origen sin-valor (no entra en DEFAULTS); variable › máquina › perfil; explain dice el valor con su origen o «sin elegir»; get sale 3 sin valor; un valor fuera de minimal|full es configuración ROTA en el archivo y en la variable, nunca full', () => {
  const { VOCABULARIO, DEFAULTS, VARIABLES } = lib();
  assert.equal(VOCABULARIO.install.profile, 'opcion:minimal|full');
  assert.ok(!('install.profile' in DEFAULTS), 'install.profile no tiene valor por defecto: es la decisión del dueño');
  assert.deepEqual(VARIABLES['install.profile'], ['TYCON_INSTALL_PROFILE']);

  // sin nada
  let home = casa();
  let c = cargar({ home, arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.equal(c.valores.install.profile, null);
  assert.equal(c.origenes['install.profile'], 'sin-valor');
  let out = cli(['explain'], { home, env: { TYCON_PROFILE: '0' } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /install\.profile = sin elegir/);
  const get = cli(['get', 'install.profile'], { home, env: { TYCON_PROFILE: '0' } });
  assert.equal(get.status, 3, 'sin valor: get sale 3');
  assert.equal(get.stdout, '');

  // los tres a la vez, quitando uno por vez: variable › máquina › perfil
  const arnes = arnesCon({ install: { profile: 'full' } });
  maquina(home, { install: { profile: 'minimal' } });
  c = cargar({ home, arnes, env: { TYCON_INSTALL_PROFILE: 'full' } });
  assert.deepEqual([c.valores.install.profile, c.origenes['install.profile']], ['full', 'env']);
  c = cargar({ home, arnes });
  assert.deepEqual([c.valores.install.profile, c.origenes['install.profile']], ['minimal', 'maquina']);
  fs.rmSync(path.join(home, '.claude', 'tycon.json'));
  c = cargar({ home, arnes });
  assert.deepEqual([c.valores.install.profile, c.origenes['install.profile']], ['full', 'perfil']);
  out = cli(['explain'], { home, env: { TYCON_PROFILE: path.join(arnes, 'perfil-equipo.json') } });
  assert.match(out.stdout, /install\.profile = full \(perfil\)/);
  assert.equal(cli(['get', 'install.profile'], { home, env: { TYCON_PROFILE: path.join(arnes, 'perfil-equipo.json') } }).stdout.trim(), 'full');

  // fuera de la lista: ROTA, en el archivo y en la variable (nunca «full»)
  home = casa();
  maquina(home, { install: { profile: 'medio' } });
  c = cargar({ home, arnes: arnesCon(null) });
  assert.ok(c.errores.some((e) => e.clave === 'install.profile' && /minimal, full/.test(e.motivo)), JSON.stringify(c.errores));
  assert.equal(cli(['get', 'install.profile'], { home, env: { TYCON_PROFILE: '0' } }).status, 2);
  c = cargar({ home: casa(), arnes: arnesCon(null), env: { TYCON_INSTALL_PROFILE: 'medio' } });
  assert.ok(c.errores.some((e) => e.clave === 'TYCON_INSTALL_PROFILE' && /minimal o full/.test(e.motivo)), JSON.stringify(c.errores));
});

test('T30 Config_SetKey_ValidatesAtomicPreservesRefusesBroken_Warnings — setKey crea el archivo, conserva byte a byte lo demás y el nombre de sección que ya tiene, valida clave y tipo, no escribe sobre un archivo roto, y avisa cuando una variable le gana o cuando el freno de producción instalado no conoce la sección', () => {
  const { setKey } = lib();
  const sinFreno = { guardLib: path.join(tmp('tcfg-sin-freno-'), 'no-esta.js'), env: {} };

  // archivo ausente: lo crea
  let home = casa();
  let r = setKey(home, 'install.profile', 'minimal', sinFreno);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.file, path.join(home, '.claude', 'tycon.json'));
  assert.deepEqual([r.before, r.after, r.warning], [null, 'minimal', null]);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), { install: { profile: 'minimal' } });
  // y otra vez, con el valor previo
  r = setKey(home, 'install.profile', 'full', sinFreno);
  assert.deepEqual([r.ok, r.before, r.after], [true, 'minimal', 'full']);

  // con otras secciones (una con el nombre anterior de la sección): lo demás queda igual y el nombre de sección también
  home = casa();
  const VIEJA = 'integra' + 'ciones';   // el nombre anterior de la sección, armado en dos partes (control de menciones viejas)
  const antes = { __nota: 'mía', ado: { org: 'https://dev.azure.com/acme' }, [VIEJA]: { engram: true }, update: { channel: 'stable' } };
  maquina(home, antes);
  r = setKey(home, 'integrations.clockify', true, sinFreno);
  assert.equal(r.ok, true, r.reason);
  const despues = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.deepEqual(despues, Object.assign({}, antes, { [VIEJA]: { engram: true, clockify: true } }), 'la sección se escribe con el nombre que ya tenía en el archivo');
  r = setKey(home, 'install.profile', 'full', sinFreno);
  const final = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.deepEqual(Object.keys(final), ['__nota', 'ado', VIEJA, 'update', 'install'], 'el orden y lo demás no cambian; la sección nueva va al final');
  assert.deepEqual(lib().cargar({ home, env: {}, arnes: arnesCon(null) }).errores, [], 'lo que escribe setKey se lee sin errores');

  // clave desconocida, tipo equivocado, valor fuera de la lista: no escribe
  const quieto = fs.readFileSync(r.file, 'utf8');
  for (const [k, v] of [['install.perfil', 'full'], ['nada.profile', 'full'], ['install.profile', 'medio'], ['integrations.engram', 'si'], ['ado.org', '']]) {
    r = setKey(home, k, v, sinFreno);
    assert.equal(r.ok, false, `${k}=${v} no se escribe`);
    assert.ok(r.reason && r.reason.length > 0);
  }
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'tycon.json'), 'utf8'), quieto);

  // archivo roto: no escribe encima
  home = casa();
  const roto = maquina(home, '{ "install": ');
  r = setKey(home, 'install.profile', 'full', sinFreno);
  assert.equal(r.ok, false);
  assert.match(r.reason, /roto|ilegible/);
  assert.equal(fs.readFileSync(roto, 'utf8'), '{ "install": ');

  // una variable que le gana a lo escrito: lo avisa
  home = casa();
  r = setKey(home, 'install.profile', 'minimal', { guardLib: sinFreno.guardLib, env: { TYCON_INSTALL_PROFILE: 'full' } });
  assert.equal(r.ok, true);
  assert.match(r.warning, /TYCON_INSTALL_PROFILE/);

  // un freno de producción instalado cuyo lector no conoce la sección: lo avisa, con el comando para reinstalarlo
  const freno = path.join(tmp('tcfg-freno-'), 'tycon-config.js');
  fs.writeFileSync(freno, "const VOCABULARIO = Object.freeze({ ado: Object.freeze({ org: 'texto' }), update: Object.freeze({ channel: 'opcion:latest|stable' }) });\n");
  r = setKey(casa(), 'install.profile', 'full', { guardLib: freno, env: {} });
  assert.equal(r.ok, true);
  assert.match(r.warning, /freno de producción/);
  assert.match(r.warning, /install-guard\.sh/);
  r = setKey(casa(), 'update.channel', 'latest', { guardLib: freno, env: {} });
  assert.equal(r.warning, null, 'una sección que el lector del freno ya conoce no avisa');
  // un tycon.json que es un enlace (la configuración en un repo de dotfiles): se escribe el destino y el enlace sigue
  // siendo enlace
  home = casa();
  const dotfiles = path.join(tmp('tcfg-dotfiles-'), 'tycon.json');
  fs.writeFileSync(dotfiles, JSON.stringify({ ado: { org: 'https://dev.azure.com/acme' } }, null, 2));
  fs.symlinkSync(dotfiles, path.join(home, '.claude', 'tycon.json'));
  r = setKey(home, 'install.profile', 'minimal', sinFreno);
  assert.equal(r.ok, true, r.reason);
  assert.ok(fs.lstatSync(path.join(home, '.claude', 'tycon.json')).isSymbolicLink(), 'el enlace sigue siendo enlace');
  assert.deepEqual(JSON.parse(fs.readFileSync(dotfiles, 'utf8')), { ado: { org: 'https://dev.azure.com/acme' }, install: { profile: 'minimal' } }, 'el destino del enlace tiene la clave nueva');
  // las dos formas de una sección (la actual y la anterior, con el mismo valor: el lector las acepta): se escriben las dos
  // y el archivo sigue sano
  home = casa();
  maquina(home, { integrations: { engram: true }, [VIEJA]: { engram: true } });
  r = setKey(home, 'integrations.clockify', true, sinFreno);
  assert.equal(r.ok, true, r.reason);
  const dos = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.deepEqual([dos.integrations.clockify, dos[VIEJA].clockify], [true, true], 'las dos formas de la sección llevan el valor');
  assert.deepEqual(lib().cargar({ home, env: {}, arnes: arnesCon(null) }).errores, [], 'el archivo sigue sano después de escribir');
  // un freno que está y no se puede leer (acá, una carpeta en su lugar): no poder leerlo no es «lo conoce» — avisa
  r = setKey(casa(), 'install.profile', 'full', { guardLib: tmp('tcfg-freno-carpeta-'), env: {} });
  assert.equal(r.ok, true);
  assert.match(r.warning || '', /no pude leerlo/);
});

// ── T47: `tycon-config.js set <clave> <valor>` ─────────────────────────────────────────
// Lo que se edita a mano en ~/.claude/tycon.json, con el escritor único (`setKey`). Una llave acepta true, false,
// 1 o 0 (`integrations.codex`, además, detect); una opción, sus valores; un texto, uno no vacío. Sale 0 con «antes →
// después» y cómo se aplica; una clave desconocida sale 2 con las válidas; un valor inválido, 2; un archivo roto, 2 sin
// escribir; si una variable le gana, lo avisa.
// 🔴 Sin el subcomando `set`, la CLI sale 2 con el uso.
test('T47 Config_SetCli_EveryType_UnknownKeyBrokenFileEnvWins — set escribe cada tipo con setKey, dice antes → después y cómo se aplica; clave desconocida, valor inválido o archivo roto salen 2 sin escribir; una variable que le gana se avisa', () => {
  const sinFreno = path.join(tmp('tcfg-set-sin-freno-'), 'no-esta.js');
  const base = (home, extra) => ({ home, env: Object.assign({ TYCON_PROFILE: '0', TYCON_GUARD_LIB_FOR_TEST: sinFreno }, extra || {}) });
  const leerArchivo = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'tycon.json'), 'utf8'));
  const home = casa();

  // una llave: true/false/1/0
  let out = cli(['set', 'integrations.engram', '1'], base(home));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^integrations\.engram: \(sin valor\) → true en .*tycon\.json$/m);
  assert.match(out.stdout, /se aplica en el próximo arranque, o ya con `harness\.js apply`; para ver antes qué cambia, `harness\.js apply --dry-run`/);
  out = cli(['set', 'integrations.engram', 'false'], base(home));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^integrations\.engram: true → false en /m);
  assert.equal(leerArchivo(home).integrations.engram, false);
  // integrations.codex acepta además detect
  out = cli(['set', 'integrations.codex', 'detect'], base(home));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(leerArchivo(home).integrations.codex, 'detect');
  // una opción
  out = cli(['set', 'install.profile', 'minimal'], base(home));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(leerArchivo(home).install.profile, 'minimal');
  // un texto
  out = cli(['set', 'ado.org', 'https://dev.azure.com/acme'], base(home));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(leerArchivo(home).ado.org, 'https://dev.azure.com/acme');
  assert.deepEqual(lib().cargar({ home, env: {}, arnes: arnesCon(null) }).errores, [], 'lo que escribió set se lee sano');

  // clave desconocida: 2 con las válidas, sin escribir
  const antes = fs.readFileSync(path.join(home, '.claude', 'tycon.json'), 'utf8');
  out = cli(['set', 'integrations.foo', 'true'], base(home));
  assert.equal(out.status, 2);
  assert.match(out.stderr, /clave desconocida/);
  assert.match(out.stderr, /install\.profile/, 'nombra las válidas');
  // valores inválidos: una llave con «quizás», una opción fuera de la lista, un texto vacío
  for (const [k, v] of [['integrations.engram', 'quizas'], ['install.profile', 'medio'], ['ado.org', '  '], ['integrations.codex', 'auto']]) {
    out = cli(['set', k, v], base(home));
    assert.equal(out.status, 2, `set ${k} ${v}: ${out.stdout}${out.stderr}`);
  }
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'tycon.json'), 'utf8'), antes, 'nada se escribió con una clave o un valor inválidos');
  // sin valor: el uso, 2
  assert.equal(cli(['set', 'install.profile'], base(home)).status, 2);

  // un archivo roto: 2 y no se escribe
  const rota = casa();
  fs.writeFileSync(path.join(rota, '.claude', 'tycon.json'), '{ esto no es json');
  out = cli(['set', 'install.profile', 'full'], base(rota));
  assert.equal(out.status, 2);
  assert.match(out.stderr, /roto/);
  assert.equal(fs.readFileSync(path.join(rota, '.claude', 'tycon.json'), 'utf8'), '{ esto no es json');

  // una variable que le gana: escribe y lo avisa
  out = cli(['set', 'install.profile', 'full'], base(casa(), { TYCON_INSTALL_PROFILE: 'minimal' }));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /TYCON_INSTALL_PROFILE=minimal le gana/);
});

// ── T2: `update.source` y `paths.tree` ────────────────────────────────────────────────
// De dónde instala la máquina (`internal` | `public`, por defecto `public`) y la carpeta del árbol gestionado (por
// defecto la carpeta del mecanismo, sin el nombre del lugar). Variable › máquina › perfil › default, con su origen en
// `explain`. Un valor fuera del vocabulario es un error; una ruta relativa también (el árbol no puede depender del cwd ni
// del HOME de quien lee). `paths.tree` es de la máquina: el perfil no la puede traer. El perfil del equipo trae
// `update.source: internal`. La mitad del estado de T2 vive en harness-state.test.js.
// 🔴 Sin esas claves en el vocabulario, `update.source` y `paths.tree` son «clave desconocida».

test('8.13.1 · T2 State_AdditiveFields_OldStateReadsAsInternalNoLayer_ConfigKeysWithOrigin (config) — update.source y paths.tree: vocabulario, variables, defaults, precedencia con origen, errores y explain', () => {
  const { VOCABULARIO, VARIABLES, DEFAULTS } = lib();
  assert.equal(VOCABULARIO.update.source, 'opcion:internal|public', 'vocabulario cerrado: internal | public');
  assert.ok(VOCABULARIO.rutas.tree, 'paths.tree está en la sección paths (rutas por dentro)');
  assert.deepEqual(VARIABLES['update.source'], ['TYCON_UPDATE_SOURCE']);
  assert.deepEqual(VARIABLES['rutas.tree'], ['TYCON_TREE']);
  assert.equal(DEFAULTS['update.source'], 'public');
  assert.equal(DEFAULTS['rutas.tree'], '~/.claude/.tycon-pipeline/harness/tree');
  const PLACE = require('../setup/harness/place.js');
  for (const nombre of [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME]) assert.ok(!DEFAULTS['rutas.tree'].includes(nombre), `el default no lleva el nombre del lugar (${nombre})`);

  // sin nada (sin perfil): public y la carpeta del mecanismo, los dos con origen default
  let home = casa();
  let c = cargar({ env: {}, home, arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.deepEqual([c.valores.update.source, c.origenes['update.source']], ['public', 'default']);
  assert.deepEqual([c.valores.rutas.tree, c.origenes['rutas.tree']], [path.join(home, '.claude', '.tycon-pipeline', 'harness', 'tree'), 'default']);

  // TYCON_PROFILE=0 con el arnés de verdad: default, aunque el perfil del equipo diga otra cosa
  c = cargar({ env: { TYCON_PROFILE: '0' }, home: casa() });
  assert.deepEqual([c.valores.update.source, c.origenes['update.source']], ['public', 'default']);

  // paths.tree en tycon.json: origen maquina (con `~` también); update.source en la máquina, también
  home = casa();
  const arbol = path.join(home, 'otro', 'arbol');
  maquina(home, { paths: { tree: arbol }, update: { source: 'internal' } });
  c = cargar({ env: {}, home, arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.deepEqual([c.valores.rutas.tree, c.origenes['rutas.tree']], [arbol, 'maquina']);
  assert.deepEqual([c.valores.update.source, c.origenes['update.source']], ['internal', 'maquina']);
  maquina(home, { paths: { tree: '~/arbol-mio' } });
  c = cargar({ env: {}, home, arnes: arnesCon(null) });
  assert.deepEqual([c.errores, c.valores.rutas.tree, c.origenes['rutas.tree']], [[], path.join(home, 'arbol-mio'), 'maquina']);

  // la variable manda sobre la máquina
  const otro = path.join(casa(), 'desde-variable');
  maquina(home, { paths: { tree: arbol }, update: { source: 'internal' } });
  c = cargar({ env: { TYCON_UPDATE_SOURCE: 'public', TYCON_TREE: otro }, home, arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.deepEqual([c.valores.update.source, c.origenes['update.source'], c.variables['update.source']], ['public', 'env', 'TYCON_UPDATE_SOURCE']);
  assert.deepEqual([c.valores.rutas.tree, c.origenes['rutas.tree'], c.variables['rutas.tree']], [otro, 'env', 'TYCON_TREE']);

  // update.source: cloud — error de vocabulario con archivo y clave, en la máquina, en el perfil y en la variable; nunca el default
  home = casa();
  const rota = maquina(home, { update: { source: 'cloud' } });
  assert.throws(() => lib().leer({ env: {}, home, arnes: arnesCon(null) }), (e) => {
    assert.equal(e.name, 'ConfigError');
    assert.equal(e.errores[0].archivo, rota);
    assert.equal(e.errores[0].clave, 'update.source');
    assert.match(e.errores[0].motivo, /internal, public/);
    return true;
  });
  assert.throws(() => lib().leer({ env: {}, home: casa(), arnes: arnesCon({ update: { source: 'cloud' } }) }), (e) => { assert.equal(e.errores[0].clave, 'update.source'); return true; });
  assert.throws(() => lib().leer({ env: { TYCON_UPDATE_SOURCE: 'cloud' }, home: casa(), arnes: arnesCon(null) }), (e) => { assert.equal(e.errores[0].clave, 'TYCON_UPDATE_SOURCE'); return true; });

  // paths.tree relativa: error (en el archivo y en la variable); sin valor: error, no el default
  home = casa();
  maquina(home, { paths: { tree: 'arbol/relativo' } });
  assert.throws(() => lib().leer({ env: {}, home, arnes: arnesCon(null) }), (e) => {
    assert.equal(e.errores[0].clave, 'paths.tree');
    assert.match(e.errores[0].motivo, /absoluta/);
    return true;
  });
  assert.throws(() => lib().leer({ env: { TYCON_TREE: 'arbol/relativo' }, home: casa(), arnes: arnesCon(null) }), (e) => { assert.equal(e.errores[0].clave, 'TYCON_TREE'); return true; });
  home = casa();
  maquina(home, { paths: { tree: '  ' } });
  assert.throws(() => lib().leer({ env: {}, home, arnes: arnesCon(null) }), (e) => { assert.equal(e.errores[0].clave, 'paths.tree'); return true; });
  // una variable vacía es «no está»: el default, como cualquier otra variable del lector
  c = cargar({ env: { TYCON_TREE: '' }, home: casa(), arnes: arnesCon(null) });
  assert.deepEqual([c.errores, c.origenes['rutas.tree']], [[], 'default']);

  // el perfil: update.source sí (origen perfil, y el detector de lo personal lo acepta); paths.tree no (es de la máquina)
  c = cargar({ env: {}, home: casa(), arnes: arnesCon({ update: { source: 'internal' } }) });
  assert.deepEqual(c.errores, [], 'update.source en el perfil no es un dato personal ni una clave desconocida');
  assert.deepEqual([c.valores.update.source, c.origenes['update.source']], ['internal', 'perfil']);
  assert.throws(() => lib().leer({ env: {}, home: casa(), arnes: arnesCon({ paths: { tree: '/una/ruta' } }) }), (e) => {
    assert.equal(e.errores[0].clave, 'paths.tree');
    assert.match(e.errores[0].motivo, /máquina/);
    return true;
  });
  // perfil roto: error que nombra el archivo, nunca «default»
  const arnesRoto = arnesCon('{ "update": ');
  assert.throws(() => lib().leer({ env: {}, home: casa(), arnes: arnesRoto }), (e) => { assert.equal(e.errores[0].archivo, path.join(arnesRoto, 'perfil-equipo.json')); return true; });

  // explain: el valor con su origen, en texto y en JSON
  const arnesInterno = arnesCon({ update: { source: 'internal' } });
  home = casa();
  let texto = lib().explicar({ env: {}, home, arnes: arnesInterno });
  assert.match(texto, /update\.source = internal \(perfil\)/);
  assert.ok(texto.includes(`paths.tree = ${path.join(home, '.claude', '.tycon-pipeline', 'harness', 'tree')} (default)`), texto);
  texto = lib().explicar({ env: { TYCON_PROFILE: '0' }, home: casa() });
  assert.match(texto, /update\.source = public \(default\)/);
  texto = lib().explicar({ env: { TYCON_TREE: otro }, home: casa(), arnes: arnesCon(null) });
  assert.ok(texto.includes(`paths.tree = ${otro} (env)`), texto);
  const json = lib().explicar({ env: {}, home: casa(), arnes: arnesInterno, json: true });
  assert.deepEqual([json.valores.update.source, json.origenes['update.source'], json.origenes['rutas.tree']], ['internal', 'perfil', 'default']);
  // la CLI: get da el default (exit 0: hay valor)
  const g = cli(['get', 'update.source'], { home: casa(), env: { TYCON_PROFILE: '0' } });
  assert.deepEqual([g.status, g.stdout.trim()], [0, 'public'], g.stderr);
  const h = casa();
  const gt = cli(['get', 'paths.tree'], { home: h, env: { TYCON_PROFILE: '0' } });
  assert.deepEqual([gt.status, gt.stdout.trim()], [0, path.join(h, '.claude', '.tycon-pipeline', 'harness', 'tree')], gt.stderr);
});

test('8.13.1 · T2 Config_TeamProfile_UpdateSourceNotInternal — el perfil del equipo que viaja en el arnés no fija la fuente interna de las actualizaciones ni paths.tree (NO MEDIDO sin él)', (t) => {
  const rutaReal = lib().perfilDelArbol(path.join(SCRIPTS, '..')).ruta;   // el nombre actual, o el anterior
  if (!fs.existsSync(rutaReal)) {
    console.log(`  ℹ NO MEDIDO — el perfil del equipo no está (${rutaReal}): la copia pública no lo trae.`);
    t.skip('perfil del equipo ausente: no medido');
    return;
  }
  const real = lib().leer({ env: {}, home: casa() });
  assert.equal(real.archivos.perfil.estado, 'leido');
  // las máquinas se actualizan del repo público: un perfil que fijara la fuente interna las dejaría atadas a un repo cerrado
  assert.notEqual(real.valores.update.source, 'internal', 'el perfil del equipo no fija la fuente interna');
  assert.equal(real.origenes['rutas.tree'], 'default', 'el perfil no trae la carpeta del árbol');
});

test('8.13.1 · T2 Config_GuardCopyWithoutNewKeys_Warns — el freno de producción instalado que conoce update y paths pero no source ni tree: escribir una clave nueva avisa; las de siempre no', () => {
  const { setKey } = lib();
  const freno = path.join(tmp('tcfg-freno-8131-'), 'tycon-config.js');
  fs.writeFileSync(freno, [
    'const VOCABULARIO = Object.freeze({',
    "  rutas: Object.freeze({ repos: 'ruta' }),",
    "  update: Object.freeze({ channel: 'opcion:latest|stable', apply: 'opcion:auto|ask', skills_source: 'opcion:separate|unified' }),",
    '});',
    '',
  ].join('\n'));
  let r = setKey(casa(), 'update.source', 'internal', { guardLib: freno, env: {} });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.warning || '', /freno de producción/);
  assert.match(r.warning || '', /update\.source/);
  r = setKey(casa(), 'paths.tree', path.join(casa(), 'arbol'), { guardLib: freno, env: {} });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.warning || '', /paths\.tree/);
  r = setKey(casa(), 'update.channel', 'latest', { guardLib: freno, env: {} });
  assert.equal(r.warning, null, 'una clave que el freno ya conoce no avisa');
  r = setKey(casa(), 'paths.repos', path.join(casa(), 'repos'), { guardLib: freno, env: {} });
  assert.equal(r.warning, null, 'paths.repos ya la conoce');
  // una ruta relativa no se escribe
  r = setKey(casa(), 'paths.tree', 'relativa', { guardLib: freno, env: {} });
  assert.equal(r.ok, false);
});

// ── T24 ────────────────────────────────────────────────────────────────────────────────────
// `integrations.codex: detect` sigue a la herramienta INSTALADA —su ejecutable o su configuración propia—. Si siguiera
// a «ya desplegado» (un hooks.json en su carpeta), una máquina con Codex instalado y sin desplegar no recibiría nada, y
// una que lo desinstaló seguiría contando. Existe `integrations.claude` con el mismo vocabulario, y a la máquina con una
// herramienta instalada y sin enchufar se le avisa antes de enchufársela.
const TOOLS_LIB = path.join(SCRIPTS, 'setup', 'harness', 'tools.js');
function fakeTool(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\necho lab\r\n' : '#!/bin/sh\necho lab\n');
  fs.chmodSync(file, 0o755);
  return dir;
}

test('8.23 C · T24 Detect_ToolInstalledNotDeployed_ClaudeAndCodex_NoticeBefore — `integrations.claude` existe con el vocabulario de codex, y no es una novena integración', () => {
  const C = lib();
  assert.equal(C.VOCABULARIO.integraciones.claude, C.VOCABULARIO.integraciones.codex, 'el mismo tipo: true, false o detect');
  assert.deepEqual(C.TOOLS, ['claude', 'codex']);
  assert.equal(C.LAS_OCHO.length, 8, 'las integraciones siguen siendo ocho');
  assert.ok(!C.LAS_OCHO.includes('claude') && !C.INTEGRACIONES.includes('claude'));
  // nadie dijo nada: «sin decir» (quien decide lo trata como detect), con el origen que lo distingue de «apagada a propósito»
  let k = C.toolKeys(cargar({ home: casa(), arnes: arnesCon(null) }));
  assert.deepEqual(k, { claude: { value: false, origin: 'apagado' }, codex: { value: false, origin: 'apagado' } });
  // en el archivo de la máquina: detect, true y false, las tres formas en las dos llaves
  const h = casa();
  maquina(h, { integrations: { claude: 'detect', codex: false } });
  k = C.toolKeys(cargar({ home: h, arnes: arnesCon(null) }));
  assert.deepEqual(k, { claude: { value: 'detect', origin: 'maquina' }, codex: { value: false, origin: 'maquina' } });
  // por variable, y la variable gana
  k = C.toolKeys(cargar({ home: h, arnes: arnesCon(null), env: { TYCON_CLAUDE: '0', TYCON_CODEX: 'detect' } }));
  assert.deepEqual(k, { claude: { value: false, origin: 'env' }, codex: { value: 'detect', origin: 'env' } });
  // el perfil del equipo también puede decirlo
  k = C.toolKeys(cargar({ home: casa(), arnes: arnesCon({ integrations: { claude: true, codex: 'detect' } }) }));
  assert.deepEqual(k, { claude: { value: true, origin: 'perfil' }, codex: { value: 'detect', origin: 'perfil' } });
  // un valor que no vale es configuración rota, no «apagada»
  const roto = casa();
  maquina(roto, { integrations: { claude: 'a veces' } });
  assert.ok(cargar({ home: roto, arnes: arnesCon(null) }).errores.some((e) => /claude/.test(e.clave) && /detect/.test(e.motivo)));
  // y las ocho de siempre no cambian por la llave nueva
  const ocho = C.integraciones(C.leer({ home: h, arnes: arnesCon(null), env: {} }));
  assert.deepEqual(Object.keys(ocho).sort(), [...C.LAS_OCHO].sort());
});

test('8.23 C · T24 — `detect` sigue al EJECUTABLE (o a la configuración propia de la herramienta), no a lo desplegado, en las dos', () => {
  const T = require(TOOLS_LIB);
  for (const tool of ['codex', 'claude']) {
    const other = tool === 'codex' ? 'claude' : 'codex';
    // (a) el ejecutable está y no hay nada desplegado → instalada → `detect` la enchufa
    let home = tmp('tools-home-');
    let bin = fakeTool(tmp('tools-bin-'), tool);
    let env = { TYCON_TOOLS_DETECT_PATH: bin, CODEX_HOME: path.join(home, '.codex') };
    let d = T.detect({ home, env });
    assert.deepEqual([d[tool].installed, d[tool].by], [true, 'path'], `${tool}: el ejecutable sin despliegue cuenta`);
    assert.equal(d[other].installed, false);
    assert.deepEqual(T.choose({ keys: { [tool]: { value: 'detect', origin: 'perfil' } }, detected: d }).tools, [tool]);
    // (b) hay despliegue del arnés y NO hay ejecutable ni configuración propia → no instalada → `detect` no la enchufa
    home = tmp('tools-home-');
    env = { TYCON_TOOLS_DETECT_PATH: tmp('tools-empty-'), CODEX_HOME: path.join(home, '.codex') };
    fs.mkdirSync(path.join(home, '.codex', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), '{ "hooks": {} }');
    fs.writeFileSync(path.join(home, '.codex', 'lab.config.toml'), '');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ "hooks": {} }');
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '<!-- TYCON_BLOCK:x START -->\n<!-- TYCON_BLOCK:x END -->\n');
    d = T.detect({ home, env });
    assert.equal(d[tool].installed, false, `${tool}: lo que el arnés desplegó no es «instalada»`);
    assert.deepEqual(T.choose({ keys: { [tool]: { value: 'detect', origin: 'perfil' } }, detected: d }).tools, [], `${tool}: detect sigue al ejecutable, no al despliegue`);
    assert.equal(T.codexDeployed({ home, env }), true, 'y el despliegue de Codex sí está (es lo que miraba el detect de antes)');
    // (c) sin ejecutable, con la configuración que crea la herramienta misma → instalada
    fs.writeFileSync(T.ownConfig(tool, { home, env }), '{}');
    d = T.detect({ home, env });
    assert.deepEqual([d[tool].installed, d[tool].by], [true, 'config']);
  }
});

test('8.23 C · T24 — las llaves: prendida enchufa aunque no esté, apagada A PROPÓSITO no enchufa aunque esté, sin decir es detect', () => {
  const T = require(TOOLS_LIB);
  const both = { claude: { installed: true, by: 'path', where: '/x/claude' }, codex: { installed: true, by: 'path', where: '/x/codex' } };
  const none = { claude: { installed: false, by: null, where: null }, codex: { installed: false, by: null, where: null } };
  assert.deepEqual(T.choose({ keys: {}, detected: both }).tools, ['claude', 'codex'], 'sin llaves: las detectadas');
  assert.deepEqual(T.choose({ keys: { codex: { value: true, origin: 'maquina' } }, detected: none }).tools, ['codex'], 'prendida: se enchufa aunque no se detecte');
  const off = T.choose({ keys: { codex: { value: false, origin: 'env' } }, detected: both });
  assert.deepEqual([off.tools, off.off], [['claude'], ['codex']], 'apagada a propósito: no, y se dice');
  assert.match(T.planLine(off, both), /sin enchufar, apagada con su llave: Codex/);
  assert.deepEqual(T.choose({ keys: { codex: { value: false, origin: 'apagado' } }, detected: both }).tools, ['claude', 'codex'], '«nadie dijo nada» no es «apagada»');
  assert.deepEqual(T.choose({ option: ['codex'], keys: { codex: { value: false, origin: 'env' } }, detected: none }).tools, ['codex'], '--tool manda sobre todo');
});

test('8.23 C · T24 — el aviso previo: instalada y sin enchufar se dice (no se enchufa sola); enchufada, o apagada a propósito, no', () => {
  const T = require(TOOLS_LIB);
  const home = tmp('tools-home-');
  const env = { CODEX_HOME: path.join(home, '.codex') };
  const detected = { claude: { installed: true, by: 'path', where: '/x/claude' }, codex: { installed: true, by: 'path', where: '/x/codex' } };
  // una máquina con un estado anterior: sin `tools` en el estado, sin despliegue de Codex → lo enchufado es Claude Code
  const old = { tree: '/x' };
  assert.deepEqual(T.plugged(old, { home, env }), ['claude']);
  const n = T.unpluggedNotice({ state: old, detected, keys: { codex: { value: 'detect', origin: 'perfil' } }, home, env });
  assert.match(n, /^herramienta sin enchufar: Codex está instalado/);
  assert.match(n, /harness\.js install --tool codex/);
  assert.match(` · ${n}`, T.NOTICE_TAIL, 'el aviso se reconoce para sacarlo cuando deja de valer');
  // con la llave apagada a propósito no se avisa; ya enchufada, tampoco
  assert.equal(T.unpluggedNotice({ state: old, detected, keys: { codex: { value: false, origin: 'maquina' } }, home, env }), null);
  assert.equal(T.unpluggedNotice({ state: { tools: ['claude', 'codex'] }, detected, keys: {}, home, env }), null);
  // sin instalar, nada
  assert.equal(T.unpluggedNotice({ state: old, detected: Object.assign({}, detected, { codex: { installed: false } }), keys: {}, home, env }), null);
  // una máquina sólo con Codex a la que le llega Claude Code: el aviso nombra a Claude Code
  assert.match(T.unpluggedNotice({ state: { tools: ['codex'] }, detected, keys: {}, home, env }), /Claude Code está instalado.*install --tool claude/);
});

// ── dónde vive el arnés ──────────────────────────────────────────────

test('T40 Config_InstallHome_ClosedNoDefault_TeamProfileKeepsItOff — install.home es opcion claude|tycon sin default (sin valor = claude); la variable es TYCON_INSTALL_HOME; explain lo dice; y el perfil del equipo NO la trae: prenderla es del dueño, después de migrar su máquina', () => {
  const { VOCABULARIO, DEFAULTS, VARIABLES } = lib();
  assert.equal(VOCABULARIO.install.home, 'opcion:claude|tycon');
  assert.ok(!('install.home' in DEFAULTS), 'install.home no tiene valor por defecto: sin valor es claude, lo de hoy');
  assert.deepEqual(VARIABLES['install.home'], ['TYCON_INSTALL_HOME']);

  // sin nada: nulo (= claude), y explain lo dice
  const home = casa();
  let c = cargar({ home, arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.equal(c.valores.install.home, null);
  assert.equal(c.origenes['install.home'], 'sin-valor');
  const out = cli(['explain'], { home, env: { TYCON_PROFILE: '0' } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /install\.home = claude \(sin valor/);

  // variable › máquina › perfil, y fuera de la lista es ROTA
  const arnes = arnesCon({ install: { home: 'tycon' } });
  c = cargar({ home, arnes });
  assert.deepEqual([c.valores.install.home, c.origenes['install.home']], ['tycon', 'perfil']);
  maquina(home, { install: { home: 'claude' } });
  c = cargar({ home, arnes });
  assert.deepEqual([c.valores.install.home, c.origenes['install.home']], ['claude', 'maquina']);
  c = cargar({ home, arnes, env: { TYCON_INSTALL_HOME: 'tycon' } });
  assert.deepEqual([c.valores.install.home, c.origenes['install.home']], ['tycon', 'env']);
  c = cargar({ home, arnes: arnesCon({ install: { home: 'casa' } }) });
  assert.ok(c.errores.some((e) => /home/.test(`${e.clave || ''} ${e.motivo || ''}`)), `un valor fuera de la lista es configuración ROTA: ${JSON.stringify(c.errores)}`);

  // el interruptor del equipo está APAGADO hasta que el dueño lo prenda: el perfil real del repo no trae
  // `install.home`; cuando lo traiga, esta prueba se actualiza con esa decisión escrita
  const perfilReal = path.join(SCRIPTS, '..', 'perfil-equipo.json');
  if (fs.existsSync(perfilReal)) {
    const real = JSON.parse(fs.readFileSync(perfilReal, 'utf8'));
    assert.ok(!(real.install && 'home' in real.install), 'perfil-equipo.json trae install.home: prender la mudanza automática del equipo es decisión del dueño, después de migrar su máquina (story 8.23, AC 31 y 32)');
  }
});

// ── el perfil del equipo gana sobre los paquetes elegidos al instalar ────────────────────────────────────
// La página pública instala con `--packs all`, el instalador lo escribe en el archivo de la máquina, y después la
// persona suma la capa del equipo, que trae el perfil. Con el orden de siempre (variable › máquina › perfil) los
// paquetes tendrían origen en la máquina: el día que el equipo cambiara el perfil, esas máquinas no se enterarían.
// Por eso, para los paquetes, y sólo para los paquetes, el perfil del equipo gana al leer (variable › perfil ›
// máquina). El archivo de la máquina no se toca nunca.
// 🔴 Si la máquina ganara, T1, T5 y T9 fallarían (`explain` no diría nada de lo que queda sin usar, y `set` no
//    avisaría).

test('8.29 · T1 Config_Packs_ProfileBeatsMachine @story-8.29 @ac-1 — con perfil y máquina declarando los paquetes, vale el del perfil y su origen es perfil', () => {
  for (const [delPerfil, deLaMaquina] of [['all', 'none'], ['none', 'all'], ['all', 'all']]) {
    const home = casa();
    maquina(home, { packs: { default: deLaMaquina } });
    const c = cargar({ home, arnes: arnesCon({ packs: { default: delPerfil } }) });
    assert.deepEqual(c.errores, []);
    assert.deepEqual([c.valores.packs.default, c.origenes['packs.default']], [delPerfil, 'perfil'], `perfil ${delPerfil}, máquina ${deLaMaquina}`);
  }
  // la lista de claves en las que gana el perfil se declara una vez; son dos (la segunda, la pregunta del modelo
  // mayor en el pase adversarial)
  assert.deepEqual(lib().PROFILE_WINS, ['packs.default', 'adversarial.model_question']);
});

test('8.29 · T2 Config_Packs_EnvBeatsProfile @story-8.29 @ac-2 — la variable le sigue ganando a todo', () => {
  const home = casa();
  maquina(home, { packs: { default: 'all' } });
  const c = cargar({ env: { TYCON_PACKS_DEFAULT: 'none' }, home, arnes: arnesCon({ packs: { default: 'all' } }) });
  assert.deepEqual(c.errores, []);
  assert.deepEqual([c.valores.packs.default, c.origenes['packs.default'], c.variables['packs.default']], ['none', 'env', 'TYCON_PACKS_DEFAULT']);
});

test('8.29 · T3 Config_Packs_NoProfile_MachineStands @story-8.29 @ac-3 — sin perfil del equipo queda lo que eligió la máquina', () => {
  const home = casa();
  maquina(home, { packs: { default: 'all' } });
  // el archivo del perfil no está
  let c = cargar({ home, arnes: arnesCon(null) });
  assert.deepEqual([c.valores.packs.default, c.origenes['packs.default']], ['all', 'maquina']);
  // el perfil está, y la máquina corre sin él
  c = cargar({ env: { TYCON_PROFILE: '0' }, home, arnes: arnesCon({ packs: { default: 'none' } }) });
  assert.deepEqual([c.valores.packs.default, c.origenes['packs.default']], ['all', 'maquina']);
  assert.equal(c.archivos.perfil.estado, 'anulado');
});

test('8.29 · T4 Config_Packs_ProfileSilent_MachineStands @story-8.29 @ac-4 — un perfil que no declara los paquetes no le gana a nadie', () => {
  const home = casa();
  maquina(home, { packs: { default: 'all' } });
  const c = cargar({ home, arnes: arnesCon({ ado: { org: 'https://dev.azure.com/acme' } }) });
  assert.deepEqual(c.errores, []);
  assert.deepEqual([c.valores.packs.default, c.origenes['packs.default']], ['all', 'maquina']);
  assert.equal(c.origenes['ado.org'], 'perfil');
});

test('8.29 · T5 Config_Explain_SaysWhatTheMachineHoldsUnused @story-8.29 @ac-5 — explain dice lo que la máquina tiene escrito y no se usa, sólo si difiere; --json lo trae siempre', () => {
  const perfil = arnesCon({ packs: { default: 'all' } });
  // distintos: el renglón lo dice
  const home = casa();
  maquina(home, { packs: { default: 'none' } });
  const texto = lib().explicar({ env: {}, home, arnes: perfil });
  const renglon = texto.split('\n').find((l) => /packs\.default =/.test(l));
  assert.match(renglon, /packs\.default = all \(perfil/);
  assert.match(renglon, /none/, 'nombra el valor que la máquina tiene escrito');
  assert.match(renglon, /no se usa/);
  assert.match(renglon, /perfil del equipo/);
  let json = lib().explicar({ env: {}, home, arnes: perfil, json: true });
  assert.deepEqual([json.valores.packs.default, json.origenes['packs.default']], ['all', 'perfil']);
  assert.deepEqual(json.shadowed, { 'packs.default': { value: 'none', origin: 'maquina', by: 'perfil' } });
  // …y la CLI imprime lo mismo
  const r = cli(['explain'], { home, env: { TYCON_PROFILE: path.join(perfil, 'perfil-equipo.json') } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /packs\.default = all \(perfil[^\n]*none[^\n]*no se usa/);
  const rj = cli(['explain', '--json'], { home, env: { TYCON_PROFILE: path.join(perfil, 'perfil-equipo.json') } });
  assert.equal(rj.status, 0, rj.stderr);
  assert.equal(JSON.parse(rj.stdout).shadowed['packs.default'].value, 'none');

  // iguales: el renglón no agrega nada (toda máquina instalada con la página tiene `all` escrito); --json sí lo trae
  const igual = casa();
  maquina(igual, { packs: { default: 'all' } });
  assert.match(lib().explicar({ env: {}, home: igual, arnes: perfil }), /packs\.default = all \(perfil\)\n/);
  json = lib().explicar({ env: {}, home: igual, arnes: perfil, json: true });
  assert.deepEqual(json.shadowed, { 'packs.default': { value: 'all', origin: 'maquina', by: 'perfil' } });

  // con una variable ganándole a los dos: lo vigente no sale del perfil, así que el renglón no agrega nada; --json
  // trae igual lo que la máquina tiene escrito sin usar (es un dato del archivo, no del valor vigente)
  const conVariable = { TYCON_PACKS_DEFAULT: 'none' };
  assert.match(lib().explicar({ env: conVariable, home: igual, arnes: perfil }), /packs\.default = none \(env\)\n/);
  assert.match(lib().explicar({ env: conVariable, home, arnes: perfil }), /packs\.default = none \(env\)\n/, 'aunque la máquina diga otra cosa que el perfil');
  assert.deepEqual(lib().explicar({ env: conVariable, home: igual, arnes: perfil, json: true }).shadowed, { 'packs.default': { value: 'all', origin: 'maquina', by: 'perfil' } });

  // sin nada escrito en la máquina, o sin perfil: nada que decir
  assert.deepEqual(lib().explicar({ env: {}, home: casa(), arnes: perfil, json: true }).shadowed, {});
  assert.deepEqual(lib().explicar({ env: {}, home, arnes: arnesCon(null), json: true }).shadowed, {});
});

test('8.29 · T9 Set_PacksDefault_WarnsProfileWins @story-8.29 @ac-9 — set escribe en el archivo de la máquina y avisa que gana el perfil, nombrando la variable', () => {
  const perfil = path.join(arnesCon({ packs: { default: 'all' } }), 'perfil-equipo.json');
  const home = casa();
  const r = cli(['set', 'packs.default', 'none'], { home, env: { TYCON_PROFILE: perfil, TYCON_GUARD_LIB_FOR_TEST: path.join(home, 'sin-freno.js') } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'tycon.json'), 'utf8')).packs.default, 'none', 'el archivo es de la persona: se escribe igual');
  assert.match(r.stdout, /perfil del equipo/);
  assert.match(r.stdout, /TYCON_PACKS_DEFAULT/, 'dice el camino para cambiarlo en esa máquina');
  assert.match(r.stdout, /no hace efecto/);
  // lo vigente sigue siendo lo del perfil
  const g = cli(['get', 'packs.default'], { home, env: { TYCON_PROFILE: perfil } });
  assert.equal(g.stdout.trim(), 'all');

  // sin perfil que la declare, o con una clave en la que el perfil no gana: el aviso no sale
  const sinPerfil = casa();
  const s = cli(['set', 'packs.default', 'all'], { home: sinPerfil, env: { TYCON_PROFILE: '0', TYCON_GUARD_LIB_FOR_TEST: path.join(sinPerfil, 'sin-freno.js') } });
  assert.equal(s.status, 0, s.stderr);
  assert.doesNotMatch(s.stdout, /perfil del equipo/);
  const otraClave = cli(['set', 'update.apply', 'ask'], { home, env: { TYCON_PROFILE: path.join(arnesCon({ update: { apply: 'auto' } }), 'perfil-equipo.json'), TYCON_GUARD_LIB_FOR_TEST: path.join(home, 'sin-freno.js') } });
  assert.equal(otraClave.status, 0, otraClave.stderr);
  assert.doesNotMatch(otraClave.stdout, /perfil del equipo/, 'en la política de actualización la máquina sigue ganando: no hay nada que avisar');

  // un perfil que ESTÁ y no se deja leer no es «no hay perfil»: se escribe igual (el archivo es de la persona) y se DICE
  // que no se pudo saber si gana, y que con el perfil así la configuración queda rota
  const perfilRoto = arnesCon('{ esto no es JSON');
  const conRoto = casa();
  const rr = cli(['set', 'packs.default', 'none'], { home: conRoto, env: { TYCON_PROFILE: path.join(perfilRoto, 'perfil-equipo.json'), TYCON_GUARD_LIB_FOR_TEST: path.join(conRoto, 'sin-freno.js') } });
  assert.equal(rr.status, 0, rr.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(conRoto, '.claude', 'tycon.json'), 'utf8')).packs.default, 'none');
  assert.match(rr.stdout, /no pude leer el perfil del equipo/);
  assert.match(rr.stdout, /ROTA/);
  // …y lo mismo con la variable del perfil apuntando a un archivo que no existe
  const sinArchivo = casa();
  const rn = cli(['set', 'packs.default', 'none'], { home: sinArchivo, env: { TYCON_PROFILE: path.join(sinArchivo, 'no-esta.json'), TYCON_GUARD_LIB_FOR_TEST: path.join(sinArchivo, 'sin-freno.js') } });
  assert.equal(rn.status, 0, rn.stderr);
  assert.match(rn.stdout, /no pude leer el perfil del equipo[^\n]*no existe/);

  // la biblioteca llamada directo con su arnés (sin la variable): el mismo aviso; y con el perfil roto no tira ni deja
  // de escribir
  const directo = casa();
  const sinFreno = path.join(directo, 'sin-freno.js');
  let d = lib().setKey(directo, 'packs.default', 'none', { env: {}, arnes: arnesCon({ packs: { default: 'all' } }), guardLib: sinFreno });
  assert.equal(d.ok, true, d.reason);
  assert.match(d.warning, /el perfil del equipo fija packs\.default en all/);
  d = lib().setKey(directo, 'packs.default', 'all', { env: {}, arnes: perfilRoto, guardLib: sinFreno });
  assert.equal(d.ok, true, d.reason);
  assert.match(d.warning, /no pude leer el perfil del equipo/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directo, '.claude', 'tycon.json'), 'utf8')).packs.default, 'all');
  // sin perfil en ese arnés: nada que avisar del perfil
  d = lib().setKey(directo, 'packs.default', 'none', { env: {}, arnes: arnesCon(null), guardLib: sinFreno });
  assert.equal(d.ok, true, d.reason);
  assert.doesNotMatch(String(d.warning), /perfil del equipo/);
});

test('8.29 · T10 OldMachine_FileUntouched_OriginIsProfile @story-8.29 @ac-10 — la máquina ya instalada: su archivo queda igual byte a byte y los paquetes salen del perfil', () => {
  const home = casa();
  // un archivo como el que deja la página pública, con más cosas adentro y su propio formato
  const escrito = '{\n    "install": { "profile": "full" },\n  "packs": {"default":"all"},\n  "telegram": { "chat_id": "4242" }\n}\n';
  const archivo = maquina(home, escrito);
  const perfil = arnesCon({ packs: { default: 'all' }, install: { profile: 'full' } });
  const json = lib().explicar({ env: {}, home, arnes: perfil, json: true });
  assert.deepEqual(json.errores, []);
  assert.equal(json.origenes['packs.default'], 'perfil');
  const r = cli(['explain', '--json'], { home, env: { TYCON_PROFILE: path.join(perfil, 'perfil-equipo.json') } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).origenes['packs.default'], 'perfil');
  assert.equal(fs.readFileSync(archivo, 'utf8'), escrito, 'leer no reescribe el archivo de la persona');
});

test('8.29 · T11 Config_BrokenProfile_StillAnError @story-8.29 @ac-11 — un perfil ilegible o con un valor fuera de la lista es un error, nunca el valor de la máquina', () => {
  const home = casa();
  maquina(home, { packs: { default: 'all' } });
  const ilegible = arnesCon('{ esto no es JSON');
  assert.throws(() => lib().leer({ env: {}, home, arnes: ilegible }), (e) => {
    assert.equal(e.errores[0].archivo, path.join(ilegible, 'perfil-equipo.json'));
    return true;
  });
  const fuera = arnesCon({ packs: { default: 'algunos' } });
  assert.throws(() => lib().leer({ env: {}, home, arnes: fuera }), (e) => {
    assert.equal(e.errores[0].archivo, path.join(fuera, 'perfil-equipo.json'));
    assert.equal(e.errores[0].clave, 'packs.default');
    assert.match(e.errores[0].motivo, /"algunos"/);
    return true;
  });
});

test('8.29 · T12 Config_BrokenMachineFile_StillAnError @story-8.29 @ac-12 — que el perfil gane no tapa un archivo de la máquina roto', () => {
  const home = casa();
  const archivo = maquina(home, '{ "packs": ');
  assert.throws(() => lib().leer({ env: {}, home, arnes: arnesCon({ packs: { default: 'all' } }) }), (e) => {
    assert.equal(e.errores[0].archivo, archivo);
    return true;
  });
  // y un valor fuera de la lista en la máquina también frena, aunque el perfil lo vaya a pisar
  maquina(home, { packs: { default: 'algunos' } });
  assert.throws(() => lib().leer({ env: {}, home, arnes: arnesCon({ packs: { default: 'all' } }) }), (e) => {
    assert.equal(e.errores[0].clave, 'packs.default');
    return true;
  });
});

test('8.29 · T13 OtherKeys_MachineStillBeatsProfile @story-8.29 @ac-15 — en todo lo demás la máquina le sigue ganando al perfil', () => {
  const home = casa();
  maquina(home, { ado: { org: 'https://dev.azure.com/maquina' }, integrations: { engram: false, clockify: false }, update: { apply: 'ask', channel: 'stable' }, install: { profile: 'minimal' }, paths: { repos: home } });
  const perfil = arnesCon({ ado: { org: 'https://dev.azure.com/perfil' }, integrations: { engram: true, clockify: true }, update: { apply: 'auto', channel: 'latest' }, install: { profile: 'full' }, packs: { default: 'all' } });
  const c = cargar({ home, arnes: perfil });
  assert.deepEqual(c.errores, []);
  assert.deepEqual([c.valores.integraciones.engram, c.origenes['integraciones.engram']], [false, 'maquina'], 'una integración apagada en la máquina sigue apagada aunque el perfil la prenda');
  assert.deepEqual([c.valores.integraciones.clockify, c.origenes['integraciones.clockify']], [false, 'maquina']);
  assert.deepEqual([c.valores.update.apply, c.origenes['update.apply']], ['ask', 'maquina']);
  assert.deepEqual([c.valores.update.channel, c.origenes['update.channel']], ['stable', 'maquina']);
  assert.deepEqual([c.valores.install.profile, c.origenes['install.profile']], ['minimal', 'maquina']);
  assert.deepEqual([c.valores.ado.org, c.origenes['ado.org']], ['https://dev.azure.com/maquina', 'maquina']);
  assert.equal(c.origenes['rutas.repos'], 'maquina');
  // …y lo único que sale del perfil son los paquetes (la máquina no los declara acá: no hay nada sin usar)
  assert.deepEqual([c.valores.packs.default, c.origenes['packs.default']], ['all', 'perfil']);
  assert.deepEqual(c.shadowed, {});
});

test('8.29 · T17 Docs_PacksOrderSaidOnce @story-8.29 @ac-18 — donde se describe el orden de los paquetes, ninguno dice el viejo y todos dicen que gana el perfil del equipo', (t) => {
  const RAIZ = path.join(SCRIPTS, '..');
  // el lector y el pipeline están en todo árbol; las guías, en el interno y en la copia que las trae
  const siempre = ['scripts/lib/tycon-config.js', 'skills/tycon-pipeline/scripts/lib/packs.js'];
  const guias = ['guides/agent-architecture.md', 'guides/maintaining/publicacion-espejo.md', 'guides/maintaining/mecanismo-de-instalacion.md', 'INSTALL.md'];
  // el árbol interno se reconoce por el perfil del equipo, que la copia pública no trae: ahí tienen que estar los seis
  const interno = fs.existsSync(path.join(RAIZ, 'perfil-equipo.json'));
  // el orden anterior, escrito de corrido: la variable, y enseguida el archivo de la máquina
  const ordenViejo = /TYCON_PACKS_DEFAULT`? › `?~\/\.claude\/tycon\.json/;
  const ganaElPerfil = /perfil del equipo (le )?gana/;
  const medidos = [];
  for (const rel of [...siempre, ...guias]) {
    const ruta = path.join(RAIZ, rel);
    if (!fs.existsSync(ruta)) {
      assert.ok(!siempre.includes(rel), `${rel} no está: es uno de los dos que viajan siempre`);
      assert.ok(!interno, `${rel} no está en el árbol interno: ahí tienen que estar los seis lugares`);
      t.diagnostic(`NO MEDIDO: ${rel} no está en esta copia`);
      continue;
    }
    // de corrido: un párrafo cortado en renglones (o un comentario con su ` * ` al margen) se lee como una sola línea
    const texto = fs.readFileSync(ruta, 'utf8').replace(/\n\s*(\*|\/\/)?\s*/g, ' ').replace(/\s+/g, ' ');
    assert.doesNotMatch(texto, ordenViejo, `${rel} todavía escribe el orden viejo de los paquetes (la máquina antes que el perfil)`);
    assert.match(texto, ganaElPerfil, `${rel} nombra los paquetes y no dice que en esa clave gana el perfil del equipo`);
    medidos.push(rel);
  }
  assert.ok(siempre.every((rel) => medidos.includes(rel)), 'el lector y el pipeline se miden siempre');
  if (interno) assert.equal(medidos.length, siempre.length + guias.length, `en el árbol interno se miden los seis: ${medidos.join(', ')}`);
  else t.diagnostic(`medidos ${medidos.length} de ${siempre.length + guias.length} (copia sin perfil del equipo)`);
});

// ── El nombre del perfil: team-profile.json, y el anterior que sigue valiendo ───────────────────────────────────

test('TPN Config_PerfilConSusDosNombres_NuevoViejoYLosDos — se busca primero team-profile.json; el de antes vale con un aviso; con los dos gana el nuevo', () => {
  const L = lib();
  assert.equal(L.NOMBRE_PERFIL, 'team-profile.json');
  assert.equal(L.NOMBRE_PERFIL_VIEJO, 'perfil-equipo.json');
  const escribir = (d, n, v) => fs.writeFileSync(path.join(d, n), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  const NUEVO = { ado: { org: 'https://dev.azure.com/nuevo' }, integraciones: { engram: true } };
  const VIEJO = { ado: { org: 'https://dev.azure.com/viejo' }, integraciones: { clockify: true } };

  // (1) sólo el nombre nuevo: se lee, sin aviso
  const a1 = arnesCon(null); escribir(a1, 'team-profile.json', NUEVO);
  let c = cargar({ home: casa(), arnes: a1 });
  assert.deepEqual(c.errores, []);
  assert.equal(c.archivos.perfil.ruta, path.join(a1, 'team-profile.json'));
  assert.equal(c.archivos.perfil.estado, 'leido');
  assert.equal(c.archivos.perfil.aviso, null, 'con el nombre nuevo no hay nada que avisar');
  assert.equal(c.valores.ado.org, 'https://dev.azure.com/nuevo'); assert.equal(c.origenes['ado.org'], 'perfil');
  let r = L.leerPerfil({ arnes: a1, home: casa(), env: {} });
  assert.equal(r.estado, 'leido'); assert.equal(r.ruta, path.join(a1, 'team-profile.json')); assert.equal(r.aviso, null);

  // (2) sólo el anterior: sigue andando, con un aviso de UNA línea que dice cómo renombrarlo
  const a2 = arnesCon(VIEJO);
  c = cargar({ home: casa(), arnes: a2 });
  assert.deepEqual(c.errores, []);
  assert.equal(c.archivos.perfil.ruta, path.join(a2, 'perfil-equipo.json'));
  assert.equal(c.valores.ado.org, 'https://dev.azure.com/viejo'); assert.equal(c.origenes['ado.org'], 'perfil');
  assert.match(c.archivos.perfil.aviso, /nombre de antes \(perfil-equipo\.json\).*git mv perfil-equipo\.json team-profile\.json/);
  assert.equal(c.archivos.perfil.aviso.includes('\n'), false, 'el aviso es una sola línea');
  r = L.leerPerfil({ arnes: a2, home: casa(), env: {} });
  assert.equal(r.estado, 'leido'); assert.match(r.aviso, /git mv perfil-equipo\.json team-profile\.json/);

  // (3) los dos: gana el nuevo (sus valores, su ruta) y se avisa que el anterior sobra
  const a3 = arnesCon(VIEJO); escribir(a3, 'team-profile.json', NUEVO);
  c = cargar({ home: casa(), arnes: a3 });
  assert.deepEqual(c.errores, []);
  assert.equal(c.archivos.perfil.ruta, path.join(a3, 'team-profile.json'));
  assert.equal(c.valores.ado.org, 'https://dev.azure.com/nuevo', 'con los dos gana el nuevo');
  assert.equal(c.valores.integraciones.clockify, false, 'del de antes no se lee nada');
  assert.match(c.archivos.perfil.aviso, /vale team-profile\.json y perfil-equipo\.json no se usa.*git rm perfil-equipo\.json/);
  // …también cuando el anterior está roto: no se lee, así que no rompe nada
  const a4 = arnesCon('{ roto'); escribir(a4, 'team-profile.json', NUEVO);
  assert.deepEqual(cargar({ home: casa(), arnes: a4 }).errores, [], 'un perfil-equipo.json roto al lado del nuevo no se lee');

  // (4) ninguno: ausente, sin aviso, y la ruta que se nombra es la del nombre nuevo
  const a5 = arnesCon(null);
  c = cargar({ home: casa(), arnes: a5 });
  assert.equal(c.archivos.perfil.estado, 'ausente'); assert.equal(c.archivos.perfil.aviso, null);
  assert.equal(c.archivos.perfil.ruta, path.join(a5, 'team-profile.json'));

  // (5) TYCON_PROFILE manda y no avisa por el nombre (la ruta la eligió alguien a propósito)
  c = cargar({ env: { TYCON_PROFILE: path.join(a2, 'perfil-equipo.json') }, home: casa(), arnes: a3 });
  assert.equal(c.valores.ado.org, 'https://dev.azure.com/viejo'); assert.equal(c.archivos.perfil.aviso, null);

  // (6) explain lo dice en una línea con el anterior; con el nombre nuevo, no
  assert.match(L.explicar({ env: {}, home: casa(), arnes: a2 }), /\n  aviso: el perfil usa el nombre de antes \(perfil-equipo\.json\)/);
  assert.doesNotMatch(L.explicar({ env: {}, home: casa(), arnes: a1 }), /aviso: el perfil/);
  assert.equal(L.explicar({ env: {}, home: casa(), arnes: a2, json: true }).archivos.perfil.aviso.length > 0, true, 'explain --json lo trae en archivos.perfil.aviso');
});

// ── la pregunta del modelo mayor en el pase adversarial ─────────────────────────────────────────────────

test('7.19 · Config_ModelQuestion_ReaderValidatesAndExplains — default ask, never y ask válidos, un valor inventado es un error, explain la nombra', () => {
  // sin nadie que diga nada: ask, con origen default
  let c = cargar({ home: casa(), arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.deepEqual([c.valores.adversarial.model_question, c.origenes['adversarial.model_question']], ['ask', 'default']);

  // los dos valores del vocabulario, escritos en la máquina, con el validador real
  for (const v of ['never', 'ask']) {
    const home = casa();
    maquina(home, { adversarial: { model_question: v } });
    const r = cli(['validate'], { home, env: { TYCON_PROFILE: '0' } });
    assert.equal(r.status, 0, `${v}: validate tenía que salir 0 — ${r.stdout}${r.stderr}`);
    c = cargar({ home, arnes: arnesCon(null) });
    assert.deepEqual([c.valores.adversarial.model_question, c.origenes['adversarial.model_question']], [v, 'maquina']);
  }

  // un valor fuera del vocabulario es configuración ROTA (nunca «ask» en silencio)
  const rota = casa();
  maquina(rota, { adversarial: { model_question: 'siempre' } });
  const r = cli(['validate'], { home: rota, env: { TYCON_PROFILE: '0' } });
  assert.notEqual(r.status, 0, 'validate rechaza un valor inventado');
  assert.ok(cargar({ home: rota, arnes: arnesCon(null) }).errores.some((e) => /model_question/.test(`${e.clave} ${e.motivo}`)), 'el error nombra la clave');

  // explain la nombra con su origen, en texto y en --json
  const home = casa();
  maquina(home, { adversarial: { model_question: 'never' } });
  assert.match(lib().explicar({ env: {}, home, arnes: arnesCon(null) }), /\n  adversarial\.model_question = never \(maquina\)/);
  const j = lib().explicar({ env: {}, home, arnes: arnesCon(null), json: true });
  assert.equal(j.valores.adversarial.model_question, 'never');
  assert.equal(j.origenes['adversarial.model_question'], 'maquina');

  // gana el perfil del equipo, y explain dice que lo escrito en la máquina no se usa
  const h2 = casa();
  maquina(h2, { adversarial: { model_question: 'never' } });
  const conPerfil = arnesCon({ adversarial: { model_question: 'ask' } });
  c = cargar({ home: h2, arnes: conPerfil });
  assert.deepEqual([c.valores.adversarial.model_question, c.origenes['adversarial.model_question']], ['ask', 'perfil']);
  assert.match(lib().explicar({ env: {}, home: h2, arnes: conPerfil }), /adversarial\.model_question = ask \(perfil; [^\n]*no se usa/);
});

test('Response_ClosedVocabulary_IntegerRange_DefaultsByStyle @story-2.31 @ac-1 @ac-4 @ac-6 — cómo contesta el asistente: vocabulario cerrado, largo acotado y el tope del estilo', () => {
  const C = lib();
  const con = (perfil, env = {}) => cargar({ home: casa(), arnes: arnesCon(perfil), env });
  // sin valor: neutral, es, y el tope del estilo
  let c = con({});
  assert.deepEqual(C.respuesta(c), { language: 'es', style: 'neutral', max_chars: C.TOPE_POR_ESTILO.neutral, origen: { language: 'default', style: 'default', max_chars: 'estilo' } });
  assert.deepEqual(C.TOPE_POR_ESTILO, { executive: 1300, detailed: 3000, neutral: 2000 });
  // el perfil de TYCON
  c = con({ response: { language: 'es', style: 'executive', max_chars: 1300 } });
  assert.deepEqual([C.respuesta(c).style, C.respuesta(c).max_chars, C.respuesta(c).origen.max_chars], ['executive', 1300, 'perfil']);
  assert.equal(C.respuesta(con({ response: { style: 'detailed' } })).max_chars, 3000, 'sin max_chars, el del estilo elegido');
  // los bordes del largo: 300 y 4000 entran; 299, 4001, un texto o un decimal son configuración rota
  for (const n of [300, 4000]) assert.deepEqual(con({ response: { max_chars: n } }).errores, [], `max_chars ${n}`);
  for (const n of [299, 4001, '800', 800.5, null]) {
    assert.ok(con({ response: { max_chars: n } }).errores.some((e) => /response\.max_chars/.test(e.clave) && /entero entre 300 y 4000/.test(e.motivo)), `max_chars ${JSON.stringify(n)} rechazado`);
  }
  // un estilo o un idioma fuera de la lista, también
  assert.ok(con({ response: { style: 'fancy' } }).errores.some((e) => /response\.style/.test(e.clave)));
  assert.ok(con({ response: { language: 'pt' } }).errores.some((e) => /response\.language/.test(e.clave)));
  // por variable: la cifra se lee como entero; fuera de rango o con letras, rota
  assert.equal(C.respuesta(con({}, { TYCON_RESPONSE_MAX_CHARS: '900' })).max_chars, 900);
  for (const v of ['100', 'mil', '9000']) assert.ok(con({}, { TYCON_RESPONSE_MAX_CHARS: v }).errores.some((e) => e.clave === 'TYCON_RESPONSE_MAX_CHARS'), `variable ${v}`);
  // `response --json`: lo que leen los sincronizadores; con la configuración rota, nada por stdout y exit 2
  const home = casa();
  const p = path.join(home, 'perfil.json');
  fs.writeFileSync(p, JSON.stringify({ response: { style: 'executive' } }));
  const ok = cli(['response', '--json'], { home, env: { TYCON_PROFILE: p } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { language: 'es', style: 'executive', max_chars: 1300, origen: { language: 'default', style: 'perfil', max_chars: 'estilo' } });
  fs.writeFileSync(p, JSON.stringify({ response: { style: 'fancy' } }));
  const rota = cli(['response', '--json'], { home, env: { TYCON_PROFILE: p } });
  assert.equal(rota.status, 2); assert.equal(rota.stdout, '');
});


// ── Quién puede reenviar el ok de un dev (approvals.relay_session) ─────────────────────────────────────
// Vale SÓLO desde el perfil del equipo (versionado, se cambia por pedido): si la leyera de una variable o del archivo de
// la máquina, el agente que implementa podría abrirse él mismo la puerta de la exención de un crítico.
test('8.63 · RelaySession_SoloDesdeElPerfil @story-8.63 @ac-11', () => {
  // en el perfil: vale
  let c = cargar({ home: casa(), arnes: arnesCon({ approvals: { relay_session: 'coordinadora' } }) });
  assert.deepEqual(c.errores, []);
  assert.deepEqual([c.valores.approvals.relay_session, c.origenes['approvals.relay_session']], ['coordinadora', 'perfil']);
  // sin nada: nadie
  c = cargar({ home: casa(), arnes: arnesCon(null) });
  assert.deepEqual([c.valores.approvals.relay_session, c.origenes['approvals.relay_session']], [null, 'sin-valor']);
  // en el archivo de la máquina: no la abre, no rompe la configuración, y se dice
  const home = casa();
  maquina(home, { approvals: { relay_session: 'yo-mismo' } });
  c = cargar({ home, arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.equal(c.valores.approvals.relay_session, null);
  assert.deepEqual(c.shadowed['approvals.relay_session'], { value: 'yo-mismo', origin: 'maquina', by: 'solo-perfil' });
  assert.match(lib().explicar({ env: {}, home, arnes: arnesCon(null) }), /approvals\.relay_session = sin valor.*vale sólo desde el perfil del equipo/);
  // no hay variable que la cambie (VARIABLES no la declara), y TYCON_PROFILE tampoco: sale del perfil del árbol
  assert.equal(lib().VARIABLES['approvals.relay_session'], undefined);
  const otro = path.join(tmp('tcfg-perfil-'), 'perfil.json');
  fs.writeFileSync(otro, JSON.stringify({ approvals: { relay_session: 'yo-mismo' } }));
  c = cargar({ env: { TYCON_PROFILE: otro }, home: casa(), arnes: arnesCon(null) });
  assert.deepEqual([c.valores.approvals.relay_session, c.shadowed['approvals.relay_session'].origin], [null, 'TYCON_PROFILE']);
  c = cargar({ env: { TYCON_PROFILE: otro }, home: casa(), arnes: arnesCon({ approvals: { relay_session: 'coordinadora' } }) });
  assert.equal(c.valores.approvals.relay_session, 'coordinadora', 'el del árbol, no el de la variable');
  c = cargar({ env: { TYCON_PROFILE: '0' }, home: casa(), arnes: arnesCon({ approvals: { relay_session: 'coordinadora' } }) });
  assert.equal(c.valores.approvals.relay_session, 'coordinadora', 'TYCON_PROFILE=0 tampoco la apaga');
  // `set` no la escribe en la máquina
  const r = cli(['set', 'approvals.relay_session', 'yo-mismo'], { home: casa() });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /sólo desde el perfil del equipo/);
  assert.deepEqual(lib().PROFILE_ONLY, ['approvals.relay_session', 'qa.manual_check']);
});

// ── Una persona marca cada criterio como probado a mano (qa.manual_check) ──────────────────────────────
// Cerrada (off | required) y sólo desde el perfil: si la leyera de la máquina o de una variable, el agente que implementa
// podría apagarse el freno del cierre.
test('7.46 · Config_QaManualCheck_ValoresYDefault @story-7.46 @ac-5', () => {
  let c = cargar({ home: casa(), arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.deepEqual([c.valores.qa.manual_check, c.origenes['qa.manual_check']], [null, 'sin-valor'], 'sin valor: apagada');
  c = cargar({ home: casa(), arnes: arnesCon({ qa: { manual_check: 'required' } }) });
  assert.deepEqual(c.errores, []);
  assert.deepEqual([c.valores.qa.manual_check, c.origenes['qa.manual_check']], ['required', 'perfil']);
  c = cargar({ home: casa(), arnes: arnesCon({ qa: { manual_check: 'off' } }) });
  assert.equal(c.valores.qa.manual_check, 'off');
  c = cargar({ home: casa(), arnes: arnesCon({ qa: { manual_check: 'si' } }) });
  assert.ok(c.errores.some((e) => e.clave === 'qa.manual_check'), JSON.stringify(c.errores));
});

test('7.46 · Config_QaManualCheck_SoloPerfil @story-7.46 @ac-6', () => {
  const home = casa();
  maquina(home, { qa: { manual_check: 'required' } });
  let c = cargar({ home, arnes: arnesCon(null) });
  assert.deepEqual(c.errores, []);
  assert.equal(c.valores.qa.manual_check, null);
  assert.deepEqual(c.shadowed['qa.manual_check'], { value: 'required', origin: 'maquina', by: 'solo-perfil' });
  assert.equal(lib().VARIABLES['qa.manual_check'], undefined);
  const otro = path.join(tmp('tcfg-perfil-'), 'perfil.json');
  fs.writeFileSync(otro, JSON.stringify({ qa: { manual_check: 'off' } }));
  c = cargar({ env: { TYCON_PROFILE: otro }, home: casa(), arnes: arnesCon({ qa: { manual_check: 'required' } }) });
  assert.equal(c.valores.qa.manual_check, 'required', 'el del árbol, no el de la variable');
  const r = cli(['set', 'qa.manual_check', 'off'], { home: casa() });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /sólo desde el perfil del equipo/);
});
