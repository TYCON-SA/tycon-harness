'use strict';

/**
 * escape-hatches.test.js —las dos escotillas de emergencia (FIX-2 + decisión D1, 2026-08-25).
 *
 * ── QUÉ SE ROMPÍA ───────────────────────────────────────────────────────────────────────────────
 * Existe una escotilla: un archivo suelto con la palabra `off` apaga el control que exige "la
 * prueba antes que el código". Dos cosas estaban mal:
 *
 *   1. Se leía de la CARPETA. `echo off > .tycon/atdd-gate` sin commitear alcanzaba — y crear ese
 *      archivo tampoco genera evento de implementación (`.tycon` está en NEVER_CODE_SEGMENTS y los
 *      archivos sin extensión no están en CODE_EXTS), o sea que nada lo miraba.
 *   2. **Ese mismo `off` apagaba también, de yapa, el control de evidencia de la story** — el que
 *      avisa "estos criterios de aceptación no están verificados". Un dev que apagaba lo primero se
 *      llevaba lo segundo puesto sin saberlo, y **la herencia no estaba escrita en ningún lado**.
 *      Ése era el hallazgo reportable, no la escotilla en sí.
 *
 * Decisión del dev (D1, 2026-08-25): **dos llaves**. Impacto de separar: cero — ningún repo del
 * equipo tiene `.tycon/atdd-gate` (barrido de `~/SourceCode` el mismo día).
 *
 * Lanza git → throttle DIARIO.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const atdd = require('../lib/atdd-commit-gate.js');
const cs = require('../lib/config-source.js');

function git(dir, ...args) { spawnSync('git', ['-C', dir, ...args], { stdio: 'ignore' }); }

/** Repo con la escotilla `archivo` en el estado pedido. `commiteado` / `soloCarpeta` / null. */
function repo(archivo, valor, donde) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'escot-'));
  fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(d, 'a.txt'), 'x\n');
  git(d, 'init', '-q', '-b', 'main', '.');
  if (donde === 'commiteado') fs.writeFileSync(path.join(d, '.tycon', archivo), valor);
  git(d, 'add', 'a.txt', '.tycon');
  git(d, '-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  if (donde === 'carpeta') fs.writeFileSync(path.join(d, '.tycon', archivo), valor);
  cs.limpiarCache();
  return d;
}

const SIN_ENV = {};

// ── la escotilla de ATDD ──────────────────────────────────────────────────────────────────────
test('sin escotilla, el modo por defecto es avisar', () => {
  assert.equal(atdd.resolveMode(repo('atdd-gate', '', null), SIN_ENV), 'warn');
});

test('`off` escrito SOLO en la carpeta no apaga nada', () => {
  assert.equal(atdd.resolveMode(repo('atdd-gate', 'off\n', 'carpeta'), SIN_ENV), 'warn',
    'apagar es aflojar: sin commit no cuenta, y crear ese archivo no despierta a nadie');
});

test('`off` COMMITEADO sí apaga', () => {
  assert.equal(atdd.resolveMode(repo('atdd-gate', 'off\n', 'commiteado'), SIN_ENV), 'off');
});

test('`block` sin commitear tampoco escala el control', () => {
  // La otra dirección de la misma llave: sin commit, no cambia nada — ni para aflojar ni para apretar.
  assert.equal(atdd.resolveMode(repo('atdd-gate', 'block\n', 'carpeta'), SIN_ENV), 'warn');
  assert.equal(atdd.resolveMode(repo('atdd-gate', 'block\n', 'commiteado'), SIN_ENV), 'block');
});

test('la variable de entorno sigue ganando (es la escotilla del dev, no del agente)', () => {
  const d = repo('atdd-gate', 'off\n', 'commiteado');
  assert.equal(atdd.resolveMode(d, { TYCON_ATDD_COMMIT_GATE: 'block' }), 'block');
});

// ── la escotilla de EVIDENCIA — llave propia ──────────────────────────────────────────────────
test('🔴 apagar el gate de ATDD NO apaga el de evidencia', () => {
  // El hallazgo que motivó todo esto: la herencia existía y no estaba documentada.
  const d = repo('atdd-gate', 'off\n', 'commiteado');
  assert.equal(atdd.resolveMode(d, SIN_ENV), 'off');
  assert.equal(atdd.resolveEvidenceMode(d, SIN_ENV), 'warn',
    'cada control se apaga por su cuenta: llevarse el otro puesto sin saberlo era el bug');
});

test('el gate de evidencia tiene su propia llave, y también exige commit', () => {
  assert.equal(atdd.resolveEvidenceMode(repo('story-evidence-gate', 'off\n', 'carpeta'), SIN_ENV), 'warn');
  assert.equal(atdd.resolveEvidenceMode(repo('story-evidence-gate', 'off\n', 'commiteado'), SIN_ENV), 'off');
});

test('el gate de evidencia tiene su propia variable de entorno', () => {
  const d = repo('story-evidence-gate', '', null);
  assert.equal(atdd.resolveEvidenceMode(d, { TYCON_STORY_EVIDENCE_GATE: 'off' }), 'off');
  assert.equal(atdd.resolveEvidenceMode(d, { TYCON_ATDD_COMMIT_GATE: 'off' }), 'warn',
    'la variable del otro control tampoco lo apaga');
});

// ── el lector genérico ────────────────────────────────────────────────────────────────────────
test('un repo sin historia todavía cae a la carpeta (fail-open explícito)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'escot-nohist-'));
  fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(d, '.tycon', 'atdd-gate'), 'off\n');
  cs.limpiarCache();
  assert.equal(atdd.resolveMode(d, SIN_ENV), 'off', 'sin un commit contra el cual contrastar, manda la carpeta');
});
