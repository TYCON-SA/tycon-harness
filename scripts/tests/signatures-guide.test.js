'use strict';
/**
 * signatures-guide.test.js — el catálogo de firmas del dueño y su guía dicen lo mismo (@story-8.139).
 *
 * El catálogo (scripts/lib/signatures.js) es la lista de todo lo que un freno le pide firmar al dueño: lo leen el lector
 * de la configuración (qué se puede delegar y qué es sólo del dueño) y los frenos. La guía (guides/firmas-del-arnes.md)
 * es lo que lee la persona para decidir qué delega. Si una firma está en uno y no en el otro, la persona decide sobre
 * una lista que no es la que el arnés aplica.
 *
 *   T1 · una fila de la guía por entrada del catálogo, con todas sus columnas iguales; están todas las firmas de la
 *        tabla de «Origen» de la story; la tabla de grupos de la guía es la del catálogo.
 *   T2 · la guía dice en voz alta que lo delegado no está protegido contra un agente tramposo (decisión 10).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const CATALOGO = path.join(RAIZ, 'scripts', 'lib', 'signatures.js');
const GUIA = path.join(RAIZ, 'guides', 'firmas-del-arnes.md');

// todas las firmas que piden los frenos hoy, escritas a mano para que una que se pierda del catálogo se note: cada escape
// es su propia entrada
const DE_LA_STORY = ['plan-approval', 'extra-round', 'refresh-after-main', 'control-change', 'critical-waiver',
  'runtime-waiver', 'manual-test', 'browser-test', 'lost-run', 'adversarial-skip', 'pending-approval',
  'escape:TYCON_SAFETY_OFF', 'escape:TYCON_PROD_LINT', 'escape:TYCON_NEW_NAMES', 'escape:TYCON_TEST_GATE',
  'escape:DOD_BYPASS', 'escape:TYCON_NO_DEEP_REVIEW', 'escape:TYCON_STATUS_GATE',
  'escape:story-skill-bypass', 'escape:set-autonomous', 'escape:cerrar-la-ejecucion', 'escape:cerrar-como-deuda',
  'escape:force-manual', 'escape:trust-ran', 'escape:ALLOW_DOD_EVIDENCE_WRITE', 'escape:dod_runtime_exempt',
  'escape:no-deep-review', 'escape:cambiar-el-estado', 'save'];

const OTRA_SESION = { yes: 'sí', no: 'no, por la terminal', pending: 'todavía sin comando' };

/** Las filas de la tabla que sigue al título `titulo`, como listas de celdas (sin la cabecera ni el separador). */
function tabla(texto, titulo) {
  const i = texto.indexOf(`\n${titulo}\n`);
  assert.ok(i >= 0, `la guía no tiene la sección «${titulo}»`);
  const filas = [];
  let empezo = false;
  for (const renglon of texto.slice(i + titulo.length + 2).split('\n')) {
    if (renglon.startsWith('|')) { empezo = true; filas.push(renglon.slice(1, -1).split(' | ').map((c) => c.trim())); continue; }
    if (empezo) break;
  }
  return filas.slice(2);
}

// T1 SignaturesGuide_UnaFilaPorFirma @story-8.139 @ac-1 @ac-2
// 🔴 Falla con: una firma del catálogo sin su fila en la guía, una columna distinta, o una firma de la story sin entrada.
test('8.139 T1 SignaturesGuide_UnaFilaPorFirma', () => {
  const cat = require(CATALOGO);
  const ids = cat.SIGNATURES.map((s) => s.id);
  assert.deepStrictEqual([...ids].sort(), [...DE_LA_STORY].sort(), 'el catálogo trae exactamente las firmas de la story');
  for (const s of cat.SIGNATURES) {
    for (const k of ['id', 'approves', 'command', 'otherSession']) assert.ok(typeof s[k] === 'string' && s[k].trim(), `${s.id}: falta ${k}`);
    assert.ok(Object.keys(OTRA_SESION).includes(s.otherSession), `${s.id}: otherSession ${s.otherSession}`);
    assert.ok(s.terminal === null ? s.otherSession === 'pending' : typeof s.terminal === 'string' && s.terminal.trim(), `${s.id}: terminal`);
  }
  const texto = fs.readFileSync(GUIA, 'utf8');
  const filas = tabla(texto, '## Las firmas');
  assert.deepStrictEqual(filas.map((f) => f[0]), ids.map((id) => `\`${id}\``), 'una fila por firma, en el orden del catálogo');
  for (const [i, s] of cat.SIGNATURES.entries()) {
    assert.deepStrictEqual(filas[i], [`\`${s.id}\``, s.approves, `\`${s.command}\``, OTRA_SESION[s.otherSession], s.terminal === null ? '—' : `\`${s.terminal}\``], s.id);
  }
  const grupos = tabla(texto, '## Los grupos de la 8.116');
  assert.deepStrictEqual(grupos.map((f) => f[0]), Object.keys(cat.GROUPS).map((g) => `\`${g}\``));
  for (const [i, g] of Object.keys(cat.GROUPS).entries()) {
    assert.strictEqual(grupos[i][1], cat.GROUPS[g].map((id) => `\`${id}\``).join(', '), g);
  }
  assert.ok(!Object.keys(cat.GROUPS).includes('off'), '«off» no es un grupo');
  assert.strictEqual(Object.keys(cat.GROUPS).length, 11);
});

// T2 SignaturesGuide_DiceLoDelegadoNoEstaProtegido @story-8.139 @ac-2
// 🔴 Falla con: la guía sin la sección, o una sección que no dice que la coordinadora es un agente que puede aprobar sola.
test('8.139 T2 SignaturesGuide_DiceLoDelegadoNoEstaProtegido', () => {
  const texto = fs.readFileSync(GUIA, 'utf8');
  const i = texto.indexOf('\n## Lo delegado no está protegido\n');
  assert.ok(i >= 0, 'falta la sección');
  const seccion = texto.slice(i + 1).split('\n## ')[0];
  for (const frase of ['La sesión de la coordinadora es un agente', 'el arnés no lo distingue de un ok del dueño',
    'sólo va lo de bajo riesgo']) {
    assert.ok(seccion.includes(frase), `la sección no dice «${frase}»`);
  }
});

const TRES = ['escape:force-manual', 'escape:trust-ran', 'runtime-waiver'];

// T14 Catalogo_TresFirmas_OtraSesionSi @story-8.142 @ac-5 @ac-6 @ac-7
// 🔴 Falla con: una de las tres sin «sí, desde otra sesión», o los dos escapes que siguen pidiéndose por el freno.
test('8.142 T14 Catalogo_TresFirmas_OtraSesionSi', () => {
  const cat = require(CATALOGO);
  const de = (id) => cat.SIGNATURES.find((s) => s.id === id);
  for (const id of TRES) assert.strictEqual(de(id).otherSession, 'yes', id);
  for (const id of ['escape:force-manual', 'escape:trust-ran']) {
    assert.strictEqual(de(id).kind, 'guion', id);
    assert.match(de(id).command, /--for-session <D>/, `${id}: la forma canónica nombra la sesión destino`);
    assert.match(de(id).terminal, /--terminal/, `${id}: la terminal`);
  }
  assert.match(de('escape:force-manual').command, /^marker\.js set-check <control> <estado> --force-manual/);
  assert.match(de('escape:trust-ran').command, /^pipeline\.js check-count --repo <r> --story <s> --trust-ran/);
});

// T15 SignaturesGuide_TresFilas @story-8.142 @ac-10
// 🔴 Falla con: la guía que todavía dice «no, por la terminal» para alguna de las tres, o sin su forma nueva.
test('8.142 T15 SignaturesGuide_TresFilas', () => {
  const cat = require(CATALOGO);
  const filas = tabla(fs.readFileSync(GUIA, 'utf8'), '## Las firmas');
  for (const id of TRES) {
    const f = filas.find((x) => x[0] === `\`${id}\``);
    assert.ok(f, `${id}: sin fila`);
    assert.strictEqual(f[3], 'sí', id);
    assert.strictEqual(f[2], `\`${cat.SIGNATURES.find((s) => s.id === id).command}\``, id);
  }
});

// T14 SignaturesGuide_FilaSave @story-8.143 @ac-10
// 🔴 Falla con: el ok de guardar en el catálogo sin su fila en la guía, o con la fila que dice que no se da desde otra sesión.
test('8.143 T14 SignaturesGuide_FilaSave', () => {
  const cat = require(CATALOGO);
  const f = tabla(fs.readFileSync(GUIA, 'utf8'), '## Las firmas').find((x) => x[0] === '`save`');
  assert.ok(f, 'la guía trae la fila de «save»');
  assert.strictEqual(f[3], 'sí');
  assert.strictEqual(f[2], `\`${cat.SIGNATURES.find((s) => s.id === 'save').command}\``);
});
