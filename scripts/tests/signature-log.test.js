'use strict';
/**
 * signature-log.test.js — el registro común de las firmas: un renglón por firma, con quién firmó, por qué vía, si fue
 * delegada, quién la pidió, sobre qué sesión, su id y su nivel del catálogo, la máquina, la hora y el motivo.
 *
 * Todo en proceso: la casa, la hora y la huella de la máquina se pasan como parámetros.
 *
 * stable-data: la única hora es AHORA, fija; ninguna prueba crea commits.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('../lib/signature-log.js');
const ow = require('../lib/owner-window.js');
const cat = require('../lib/signatures.js');

const AHORA = Date.parse('2026-10-30T09:00:00Z');
const HUELLA = () => ({ huella: 'maquina-de-prueba', fuente: 'prueba' });

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'signature-log-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  return casa;
}

const renglones = (casa) => {
  const p = log.logPath(casa);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const CAMPOS = ['ts', 'signature', 'level', 'covers', 'via', 'delegated', 'signer', 'ordered_by', 'target', 'machine', 'reason', 'source'];

test('appendSignature escribe un renglón con todos los campos', (t) => {
  const casa = casaNueva(t);
  const r = log.appendSignature({ signature: 'save', via: 'window', signer: 'acme', orderedBy: 'ses-c', target: 'ses-a',
    reason: 'guardar la tanda', source: 'marker.js', home: casa, now: AHORA, huella: HUELLA });
  assert.deepStrictEqual(r, { ok: true, path: log.logPath(casa) });
  const [l] = renglones(casa);
  assert.deepStrictEqual(Object.keys(l), CAMPOS);
  assert.strictEqual(l.ts, '2026-10-30T09:00:00.000Z');
  assert.strictEqual(l.signature, 'save');
  assert.strictEqual(l.via, 'window');
  assert.strictEqual(l.delegated, false);
  assert.strictEqual(l.signer, 'acme');
  assert.strictEqual(l.ordered_by, 'ses-c');
  assert.strictEqual(l.target, 'ses-a');
  assert.strictEqual(l.machine, 'maquina-de-prueba');
  assert.strictEqual(l.reason, 'guardar la tanda');
  assert.strictEqual(l.source, 'marker.js');
});

test('el registro vive en la carpeta de estado de la casa, al lado de gates.log', (t) => {
  const casa = casaNueva(t);
  const estado = require('../../skills/tycon-pipeline/scripts/lib/state-dir.js').stateDir(casa);
  assert.strictEqual(log.logPath(casa), path.join(estado, 'signatures.jsonl'));
});

test('el nivel y lo que cubre salen del catálogo, de cada nivel', (t) => {
  const casa = casaNueva(t);
  for (const nivel of [1, 2, 3]) {
    const s = cat.SIGNATURES.find((x) => x.level === nivel);
    assert.ok(s, `el catálogo tiene una firma de nivel ${nivel}`);
    log.appendSignature({ signature: s.id, via: 'terminal', signer: 'acme', home: casa, now: AHORA, huella: HUELLA });
  }
  const ls = renglones(casa);
  assert.deepStrictEqual(ls.map((l) => l.level), [1, 2, 3]);
  for (const l of ls) assert.deepStrictEqual(l.covers, cat.SIGNATURES.find((x) => x.id === l.signature).covers);
});

test('un id de la tabla de niveles que no es una firma de hoy se escribe con su nivel', (t) => {
  const casa = casaNueva(t);
  const ids = new Set(cat.SIGNATURES.map((s) => s.id));
  const solo = cat.LEVELS.find((x) => !ids.has(x.id));
  assert.ok(solo, 'la tabla de niveles tiene un id que no es una firma de hoy');
  assert.strictEqual(log.appendSignature({ signature: solo.id, via: 'command', signer: 'acme', home: casa, now: AHORA, huella: HUELLA }).ok, true);
  const [l] = renglones(casa);
  assert.strictEqual(l.level, solo.level);
  assert.deepStrictEqual(l.covers, [solo.id]);
});

test('la vía de un comando (la emergencia) se escribe como cualquier otra', (t) => {
  const casa = casaNueva(t);
  const r = log.appendSignature({ signature: 'control-change', via: 'command', signer: 'acme', reason: 'el freno no deja arreglar producción',
    source: 'harness sign', home: casa, now: AHORA, huella: HUELLA });
  assert.strictEqual(r.ok, true);
  const [l] = renglones(casa);
  assert.strictEqual(l.via, 'command');
  assert.strictEqual(l.delegated, false);
  assert.strictEqual(l.source, 'harness sign');
});

test('una firma delegada dice que lo fue y lleva el nivel de la delegación', (t) => {
  const casa = casaNueva(t);
  log.appendSignature({ signature: 'save', via: 'delegation', signer: 'coordinadora (sesión ses-c)', orderedBy: 'ses-c', target: 'ses-a',
    home: casa, now: AHORA, huella: HUELLA });
  const [l] = renglones(casa);
  assert.strictEqual(l.delegated, true);
  assert.strictEqual(l.level, cat.delegatedLevel('save'));
});

test('un id fuera del catálogo no se escribe y devuelve el error', (t) => {
  const casa = casaNueva(t);
  const r = log.appendSignature({ signature: 'inventada', via: 'window', signer: 'acme', home: casa, now: AHORA, huella: HUELLA });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /inventada/);
  assert.deepStrictEqual(renglones(casa), []);
});

test('una vía fuera de la lista no se escribe y devuelve el error', (t) => {
  const casa = casaNueva(t);
  const r = log.appendSignature({ signature: 'save', via: 'chat', signer: 'acme', home: casa, now: AHORA, huella: HUELLA });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /chat/);
  assert.deepStrictEqual(renglones(casa), []);
});

test('sin huella de la máquina el renglón se escribe con machine null', (t) => {
  const casa = casaNueva(t);
  const r = log.appendSignature({ signature: 'save', via: 'window', signer: 'acme', home: casa, now: AHORA, huella: () => ({ error: 'sin id' }) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(renglones(casa)[0].machine, null);
  const r2 = log.appendSignature({ signature: 'save', via: 'window', signer: 'acme', home: casa, now: AHORA, huella: () => { throw new Error('rota'); } });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(renglones(casa)[1].machine, null);
});

test('si no se puede escribir, no lanza: devuelve el error', (t) => {
  const casa = casaNueva(t);
  // la carpeta de estado es un archivo: no se puede crear el registro adentro
  const estado = path.dirname(log.logPath(casa));
  fs.mkdirSync(path.dirname(estado), { recursive: true });
  fs.writeFileSync(estado, 'no es una carpeta');
  const r = log.appendSignature({ signature: 'save', via: 'window', signer: 'acme', home: casa, now: AHORA, huella: HUELLA });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('el motivo se recorta y va en una línea', (t) => {
  const casa = casaNueva(t);
  log.appendSignature({ signature: 'save', via: 'window', signer: 'acme', reason: `uno\ndos ${'x'.repeat(600)}`, home: casa, now: AHORA, huella: HUELLA });
  const [l] = renglones(casa);
  assert.ok(!l.reason.includes('\n'));
  assert.ok(l.reason.length <= 501);
});

test('el registro común no se escribe a mano: el freno de la carpeta de estado frena su Write', (t) => {
  const casa = casaNueva(t);
  const { computeStoryGate } = require('../../skills/tycon-pipeline/scripts/lib/story-gate.js');
  const p = log.logPath(casa);
  const r = computeStoryGate({ filePath: p, stateDir: path.dirname(p), homeDir: casa, repoRoot: casa });
  assert.strictEqual(r.action, 'block');
  assert.strictEqual(r.kind, 'state-dir');
});

// --- las firmas de los guiones pasan por firmar() de owner-window --------------------------------------------------

test('firmar por la ventana deja su renglón -signed en gates.log y el renglón común', (t) => {
  const casa = casaNueva(t);
  ow.firmar({ firma: 'save', via: 'ventana', sesion: 'ses-c', destino: 'ses-a', resumen: 'guardar', casa, ahora: AHORA, huella: HUELLA, persona: 'acme' });
  const estado = path.dirname(log.logPath(casa));
  const gates = fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.strictEqual(gates.length, 1);
  assert.strictEqual(gates[0].name, 'save-signed');
  const [l] = renglones(casa);
  assert.strictEqual(l.signature, 'save');
  assert.strictEqual(l.via, 'window');
  assert.strictEqual(l.delegated, false);
  assert.strictEqual(l.signer, 'acme');
  assert.strictEqual(l.ordered_by, 'ses-c');
  assert.strictEqual(l.target, 'ses-a');
  assert.strictEqual(l.reason, 'guardar');
  assert.strictEqual(l.machine, 'maquina-de-prueba');
});

test('firmar por la terminal y por delegación dicen su vía y quién firmó', (t) => {
  const casa = casaNueva(t);
  ow.firmar({ firma: 'critical-waiver', via: 'terminal', destino: 'ses-a', casa, ahora: AHORA, huella: HUELLA, persona: 'acme' });
  ow.firmar({ firma: 'save', via: 'delegacion', sesion: 'ses-c', destino: 'ses-a', casa, ahora: AHORA, huella: HUELLA, persona: 'acme' });
  const [term, del] = renglones(casa);
  assert.strictEqual(term.via, 'terminal');
  assert.strictEqual(term.signer, 'acme');
  assert.strictEqual(term.ordered_by, null);
  assert.strictEqual(del.via, 'delegation');
  assert.strictEqual(del.delegated, true);
  assert.strictEqual(del.signer, 'coordinadora (sesión ses-c)');
  assert.strictEqual(del.ordered_by, 'ses-c');
});

test('con el registro propio del guion (anotar), el renglón común se escribe igual', (t) => {
  const casa = casaNueva(t);
  const propio = [];
  ow.firmar({ firma: 'save', via: 'ventana', sesion: 'ses-c', destino: 'ses-a', casa, ahora: AHORA, huella: HUELLA, persona: 'acme', anotar: (r) => propio.push(r) });
  assert.strictEqual(propio.length, 1);
  assert.strictEqual(propio[0].name, 'save-signed');
  assert.strictEqual(renglones(casa).length, 1);
});

test('el guion que anota en su propio gates.log (sin casa) deja el renglón común al lado, en la carpeta de estado de su HOME', (t) => {
  const casa = casaNueva(t);
  const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TYCON_HOME: process.env.TYCON_HOME };
  t.after(() => { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.HOME = casa; process.env.USERPROFILE = casa; delete process.env.TYCON_HOME;
  const escritos = [];
  ow.firmar({ firma: 'save', via: 'ventana', sesion: 'ses-c', destino: 'ses-a', ahora: AHORA, huella: HUELLA, persona: 'acme', anotar: () => {},
    appendSignature: (o) => { escritos.push(o); return { ok: true }; } });
  assert.strictEqual(escritos.length, 1);
  assert.strictEqual(escritos[0].home, os.homedir());
  assert.strictEqual(escritos[0].home, casa);
});

test('si el registro común no se puede escribir, la firma sigue y avisa', (t) => {
  const casa = casaNueva(t);
  const propio = [];
  const avisos = [];
  ow.firmar({ firma: 'save', via: 'ventana', sesion: 'ses-c', destino: 'ses-a', casa, ahora: AHORA, huella: HUELLA, persona: 'acme',
    anotar: (r) => propio.push(r), appendSignature: () => ({ ok: false, error: 'disco lleno' }), avisar: (m) => avisos.push(m) });
  assert.strictEqual(propio.length, 1);
  assert.strictEqual(avisos.length, 1);
  assert.match(avisos[0], /disco lleno/);
});
