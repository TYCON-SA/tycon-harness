'use strict';

/**
 * team-log-citations.test.js — el árbol que se publica no cita el registro de incidentes del equipo.
 *
 * El registro vive en el repo del equipo: desde afuera una cita a él no lleva a nada. Lo que el texto necesitaba decir (el
 * motivo de un control, el porqué de un caso) se dice en presente, en el mismo lugar.
 *
 * Lo que no se puede perder:
 *   · Que ningún archivo versionado (código, datos, guías) nombre el registro fuera de la lista de excepciones.
 *   · Que cada excepción sea UNA cita, con su archivo, el texto exacto del renglón y el motivo: nunca una carpeta ni un
 *     archivo entero.
 *   · Que una excepción que ya no coincide con ningún renglón haga fallar la prueba: la lista no junta polvo.
 *
 * Las excepciones son tres familias: la forma del registro en el freno de historia interna y sus pruebas (el freno tiene
 * que seguir reconociéndola), los archivos del freno de producción (se copian a /opt/tycon y no se tocan), y las pruebas
 * que leen el registro real con el perfil del equipo y en el público se saltean.
 *
 * El nombre del registro se escribe por partes: este archivo también se publica.
 *
 * Uso: node --test scripts/tests/team-log-citations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const NAME = ['incident', 'log'].join('-');
const ALLOWED_REL = 'scripts/tests/fixtures/team-log-citations-allowed.json';
const ALLOWED = path.join(RAIZ, ALLOWED_REL);

/** Cada renglón versionado que nombra el registro: `{ file, line, text }`. */
function citations() {
  let out = '';
  try {
    out = execFileSync('git', ['-C', RAIZ, 'grep', '-n', '-I', '--fixed-strings', NAME], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.status === 1) return []; // git grep sale 1 cuando no encuentra nada
    throw e;
  }
  // la lista de excepciones nombra el registro en cada entrada: es la lista, no una cita
  return out.split('\n').filter(Boolean).map((l) => {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    return { file: m[1], line: Number(m[2]), text: m[3] };
  }).filter((c) => c.file !== ALLOWED_REL);
}

const allowed = JSON.parse(fs.readFileSync(ALLOWED, 'utf8')).allowed;

test('T15 PublicTree_NoIncidentLogCitation @story-8.43 @ac-13 — el árbol no nombra el registro fuera de la lista de excepciones', () => {
  const pending = allowed.map((a) => ({ ...a, used: false }));
  const loose = [];
  for (const c of citations()) {
    const hit = pending.find((a) => !a.used && a.file === c.file && c.text.includes(a.text));
    if (hit) hit.used = true;
    else loose.push(`${c.file}:${c.line}: ${c.text.trim().slice(0, 120)}`);
  }
  assert.deepStrictEqual(loose, [], 'citas al registro fuera de la lista: se reescriben sin la cita, o se declaran con su motivo');
  const stale = pending.filter((a) => !a.used).map((a) => `${a.file}: «${a.text}»`);
  assert.deepStrictEqual(stale, [], 'excepciones que ya no coinciden con ningún renglón: se sacan de la lista');
});

test('T15b IncidentLogAllowed_OneCitationEach @story-8.43 @ac-13 — cada excepción es una cita con su texto y su motivo', () => {
  for (const a of allowed) {
    assert.ok(a.file && !a.file.endsWith('/'), `una excepción nombra un archivo, nunca una carpeta: ${JSON.stringify(a)}`);
    assert.ok(typeof a.text === 'string' && a.text.includes(NAME), `el texto de la excepción contiene la cita: ${a.file}`);
    assert.ok(typeof a.reason === 'string' && a.reason.length >= 20, `la excepción dice su motivo: ${a.file}`);
  }
});
