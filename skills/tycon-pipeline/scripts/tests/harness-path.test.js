'use strict';

/**
 * harness-path.test.js — dónde está el arnés, visto desde agent-skills (T5).
 *
 * LO QUE CUBRE. Hay UN lector de `TYCON_GUIDES_DIR`, `lib/harness-path.js`: la variable, o el
 * enlace `~/.claude/tycon-harness` que crea el instalador del arnés. Nunca `~/SourceCode`: con un
 * último recurso escrito a mano, en una máquina con el arnés en otra carpeta un hook «no
 * encuentra la lib» y seguiría sin ella, callado.
 *
 *   · con `TYCON_GUIDES_DIR` → ésa (también `TCG`, que exporta el banco de controles);
 *   · sin variable, con el enlace → el enlace;
 *   · sin ninguno: un COMANDO frena nombrando las dos cosas que buscó; un HOOK lo dice y sigue (fail-open,
 *     como `hook-io.js` y `.githooks/pre-commit`: la CI nocturna no exporta la variable ni tiene el
 *     enlace, y una máquina antes del primer instalador tampoco);
 *   · el modo «sólo el enlace» ignora la variable (para `guides-heal.js`: bajo el banco la variable
 *     apunta al repo REAL y un merge desde un caso sería un efecto colateral).
 *
 * 🔴 Sin `lib/harness-path.js` todo falla; un último recurso a mano caería a `~/SourceCode`.
 * 🔴 Nada acá toca el HOME real: cada caso arma su HOME en el temporal.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.resolve(__dirname, '..', 'lib', 'harness-path.js');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function casa() { const h = tmp('ruta-arnes-home-'); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; }
/** Un «clon» del arnés: tiene `scripts/install-tycon-hooks.sh` (el mismo criterio que el instalador; una carpeta
 *  `scripts/` suelta NO alcanza — de acá se carga código). */
function clon() {
  const d = tmp('ruta-arnes-clon-');
  fs.mkdirSync(path.join(d, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\n');
  return fs.realpathSync(d);
}
// los dos nombres: el lugar y el viejo, leídos de lib/harness-path.js (su copia declarada)
function enlaceEn(home, destino) { fs.symlinkSync(destino, path.join(home, '.claude', lib().LEGACY_PLACE_NAME)); }
function lugarEn(home, destino) { fs.symlinkSync(destino, path.join(home, '.claude', lib().PLACE_NAME)); }
function lib() { return require(LIB); }
function cli(args, env) {
  return spawnSync(process.execPath, [LIB, ...args], { encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH }, env) });
}

test('T5 RutaArnes_EnvEnlaceOFallaVisible — TYCON_GUIDES_DIR definida: resuelve por la variable', () => {
  const home = casa(); const c = clon(); const otro = clon();
  enlaceEn(home, otro);
  const r = lib().resolver({ env: { TYCON_GUIDES_DIR: c }, home, modo: 'comando' });
  assert.equal(r.dir, c);
  assert.equal(r.fuente, 'env');
  assert.equal(lib().rutaArnes({ env: { TYCON_GUIDES_DIR: c }, home }), c);
  // `TCG` (lo exporta el runner del banco) vale igual que la variable
  assert.equal(lib().resolver({ env: { TCG: c }, home, modo: 'comando' }).dir, c);
});

test('T5 — sólo el enlace: resuelve por el enlace', () => {
  const home = casa(); const c = clon();
  enlaceEn(home, c);
  const r = lib().resolver({ env: {}, home, modo: 'comando' });
  assert.equal(r.dir, c);
  assert.equal(r.fuente, 'enlace');
  // …y `lib()` carga de verdad un módulo del arnés encontrado (no sólo devuelve null cuando no está)
  fs.writeFileSync(path.join(c, 'scripts', 'lib', 'saludo.js'), 'module.exports = { hola: () => "hola" };\n');
  const mod = lib().lib('scripts/lib/saludo.js', { env: {}, home });
  assert.ok(mod && mod.hola() === 'hola', 'lib(): carga el módulo desde el arnés que resolvió');
  assert.equal(lib().lib('scripts/lib/no-existe.js', { env: {}, home }), null, 'lib(): un módulo que no está devuelve null, no tira');
});

test('T5 — ninguno de los dos: el comando frena nombrando la variable y el enlace; el hook avisa y sale 0', () => {
  const home = casa();
  const { RutaArnesError } = lib();
  assert.throws(() => lib().rutaArnes({ env: {}, home }), (e) => {
    assert.ok(e instanceof RutaArnesError);
    assert.match(e.message, /TYCON_GUIDES_DIR/);
    assert.match(e.message, /\.claude\/tycon-harness/);
    assert.doesNotMatch(e.message, /tycon-claude-guides/, 'el nombre viejo se nombra sólo si en esa ruta hay algo');
    assert.doesNotMatch(e.message, /SourceCode/, 'nunca cae a ~/SourceCode ni lo sugiere');
    return true;
  });
  const h = lib().rutaArnesHook({ env: {}, home });
  assert.equal(h.dir, null);
  assert.match(h.aviso, /TYCON_GUIDES_DIR/);
  assert.match(h.aviso, /\.claude\/tycon-harness/);
  assert.equal(lib().lib('scripts/lib/no-existe.js', { env: {}, home }), null, 'lib(): sin arnés devuelve null, no tira');
  // …y desde la línea de comandos: comando exit 2 con las dos cosas; hook exit 0 con el aviso por stderr
  const c = cli([], { HOME: home });
  assert.equal(c.status, 2);
  assert.match(c.stderr, /TYCON_GUIDES_DIR/);
  const k = cli(['--hook'], { HOME: home });
  assert.equal(k.status, 0);
  assert.match(k.stderr, /TYCON_GUIDES_DIR/);
  assert.equal(k.stdout, '');
});

test('T5 — una variable que apunta a algo que NO es un clon no vale en silencio: se dice qué se buscó', () => {
  const home = casa(); const c = clon();
  enlaceEn(home, c);
  const roto = tmp('ruta-arnes-no-clon-');
  fs.mkdirSync(path.join(roto, 'scripts'));   // una carpeta `scripts/` sin el instalador tampoco es un clon
  const r = lib().resolver({ env: { TYCON_GUIDES_DIR: roto }, home, modo: 'hook' });
  assert.equal(r.dir, c, 'la variable inválida no gana: sigue al enlace');
  assert.match(r.aviso || '', /TYCON_GUIDES_DIR/, 'y lo dice');
  const solo = lib().rutaArnesHook({ env: { TYCON_GUIDES_DIR: roto }, home: casa() });
  assert.equal(solo.dir, null);
  assert.match(solo.aviso, /no es un clon|no existe/);
});

test('T5 — el modo «sólo enlace» ignora la variable (guides-heal)', () => {
  const home = casa(); const c = clon(); const otro = clon();
  enlaceEn(home, c);
  assert.equal(lib().soloEnlace({ env: { TYCON_GUIDES_DIR: otro }, home }).dir, c);
  assert.equal(lib().soloEnlace({ env: { TYCON_GUIDES_DIR: otro }, home: casa() }).dir, null, 'sin enlace: null, aunque la variable esté');
});

test('T5 — `~` en la variable se expande al HOME (como en el lector del arnés); un enlace COLGADO se describe como colgado, no como «falta»', () => {
  // Una `~` literal puede llegar a la variable por el bloque `env` de settings.json o por
  // `export X="~/…"` con comillas; el lector de configuración la expande y este lector tiene que hacer lo mismo
  const home = casa();
  const c = path.join(home, 'clon');
  fs.mkdirSync(path.join(c, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(c, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\n');
  const r = lib().resolver({ env: { TYCON_GUIDES_DIR: '~/clon' }, home, modo: 'comando' });
  assert.equal(r.dir, fs.realpathSync(c));
  assert.equal(r.fuente, 'env');
  // …y una ruta relativa también va contra el HOME, como en el lector del arnés (no contra el cwd)
  assert.equal(lib().resolver({ env: { TYCON_GUIDES_DIR: 'clon' }, home, modo: 'comando' }).dir, fs.realpathSync(c));
  // el enlace existe pero apunta a nada: «colgado (apunta a …)», que es lo que hay que arreglar; no «falta»
  const home2 = casa();
  lugarEn(home2, path.join(home2, 'no-existe-mas'));
  const h = lib().rutaArnesHook({ env: {}, home: home2 });
  assert.equal(h.dir, null);
  assert.match(h.aviso, /colgado/);
  assert.match(h.aviso, /no-existe-mas/);
  assert.doesNotMatch(h.aviso, /: falta/);
  assert.match(lib().soloEnlace({ env: {}, home: home2 }).aviso, /colgado/);
});

test('T5 — el idioma para shell es el mismo orden, escrito una sola vez', () => {
  // El idioma nombra el lugar
  assert.equal(lib().IDIOMA_SHELL, '${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}');
  const cli1 = cli(['--shell-idiom'], { HOME: casa() });
  assert.equal(cli1.stdout.trim(), '${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}');
});

// ── T9 (parte de las skills): primero el lugar, después el viejo ─────────────────────────────────────
test('T9 Readers_PlaceFirstThenLegacy — los dos: el lugar; sólo el lugar: el lugar; sólo el viejo: el viejo, sin decir nada', () => {
  const a = clon(); const b = clon();
  const both = casa(); lugarEn(both, a); enlaceEn(both, b);
  assert.equal(lib().resolver({ env: {}, home: both }).dir, a, 'con los dos, el lugar');
  assert.equal(lib().soloEnlace({ home: both }).dir, a, 'soloEnlace también prueba primero el lugar');
  const onlyPlace = casa(); lugarEn(onlyPlace, a);
  assert.equal(lib().resolver({ env: {}, home: onlyPlace }).dir, a);
  const onlyLegacy = casa(); enlaceEn(onlyLegacy, b);
  const r = lib().resolver({ env: {}, home: onlyLegacy, modo: 'hook' });
  assert.equal(r.dir, b, 'con sólo el viejo, el viejo');
  assert.equal(r.aviso, undefined, '…sin imprimir nada');
  assert.equal(lib().soloEnlace({ home: onlyLegacy }).dir, b);
  const k = cli(['--hook'], { HOME: onlyLegacy });
  assert.equal(k.status, 0); assert.equal(k.stdout.trim(), b); assert.equal(k.stderr, '', 'la línea de comandos tampoco dice nada');
});

test('T9 — ninguno: el aviso nombra el lugar y el viejo SÓLO si en esa ruta hay algo; un nombre que no es un clon no vale y se dice', () => {
  const none = casa();
  const h = lib().rutaArnesHook({ env: {}, home: none });
  assert.ok(h.aviso.includes(`${lib().PLACE_NAME}: falta`)); assert.doesNotMatch(h.aviso, /tycon-claude-guides/);
  const withLegacy = casa(); fs.mkdirSync(path.join(withLegacy, '.claude', lib().LEGACY_PLACE_NAME));   // una carpeta que no es un clon
  const h2 = lib().rutaArnesHook({ env: {}, home: withLegacy });
  assert.equal(h2.dir, null);
  assert.match(h2.aviso, /tycon-claude-guides/, 'en el viejo hay algo: se nombra');
  // el lugar apunta a algo que no es un clon y el viejo sí sirve: sigue por el viejo y lo dice
  const c = clon(); const noClone = tmp('ruta-arnes-no-clon-');
  const mixed = casa(); lugarEn(mixed, noClone); enlaceEn(mixed, c);
  const r = lib().resolver({ env: {}, home: mixed, modo: 'hook' });
  assert.equal(r.dir, c);
  assert.match(r.aviso || '', /no vale/);
});
