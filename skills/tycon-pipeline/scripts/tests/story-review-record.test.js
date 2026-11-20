'use strict';

/**
 * story-review-record.test.js — la constancia de la revisión previa de una historia vale en otra copia del mismo repo.
 *
 * Lo que no se puede perder:
 *   - la clave es la misma que la de la validación (el repo y la ruta de la historia dentro del repo), no una propia:
 *     escrita en una copia, la reconoce otra copia del mismo repo con la misma huella;
 *   - con otra huella no la reconoce, y el mismo número en otro repo no la ve;
 *   - una constancia escrita con la clave de antes (la ruta real de la historia) se sigue leyendo.
 *
 * Todo corre en laboratorios (HOME aislado, repos temporales) con nombres inventados (acme).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const lib = () => require(path.join(SCRIPTS, 'lib', 'story-review-record.js'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `revision-previa-${p}-`));
function escribir(file, txt) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, txt); }

function historia() {
  return [
    '---', 'story: "9.1"', 'title: "historia de laboratorio 9.1"', 'status: ready-for-dev', '---', '',
    '# Story 9.1: el carrito de acme', '', 'Status: ready-for-dev', '',
    '## Acceptance Criteria', '',
    '1. **Given** un carrito **When** se paga **Then** queda cerrado.', '',
  ].join('\n');
}

function copia(origen) {
  const repo = tmp('copia');
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  if (origen) spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', origen], { stdio: 'ignore' });
  const story = path.join(repo, 'specs', 'story-9.1.md');
  escribir(story, historia());
  return { repo, story };
}

const limpio = { resultado: 'limpio', hallazgos: [], modelo: 'acme-model', tokens: 10, duracion_ms: 20 };

test('StoryReview_OtherCopySameRepo_Recognized @story-8.277 @ac-23 — la revisión escrita en una copia vale en otra del mismo repo', () => {
  // 🔴 mutación: con la clave por la ruta absoluta de la historia, la otra copia no la ve (none).
  const home = tmp('home');
  const a = copia('https://example.com/acme/historias.git');
  const b = copia('git@example.com:acme/historias');
  lib().writeRecord(home, a.story, limpio);
  assert.equal(lib().readRecord(home, b.story).estado, 'current');
  // la clave es la de la validación, en la carpeta de las revisiones
  const vr = require(path.join(SCRIPTS, 'lib', 'validation-record.js'));
  assert.equal(vr.claveDeHistoria(a.story), vr.claveDeHistoria(b.story));
  assert.equal(path.basename(path.dirname(lib().recordFile(home, a.story))), lib().RECORD_DIR);
});

test('StoryReview_FingerprintChanged_NotRecognized @story-8.277 @ac-23 — con otra huella en la otra copia, no la reconoce', () => {
  const home = tmp('home');
  const a = copia('https://example.com/acme/historias.git');
  const b = copia('https://example.com/acme/historias.git');
  lib().writeRecord(home, a.story, limpio);
  escribir(b.story, historia().replace('queda cerrado', 'queda cerrado y facturado'));
  assert.equal(lib().readRecord(home, b.story).estado, 'stale');
});

test('StoryReview_SameNumberOtherRepo_Separate @story-8.277 @ac-24 — el mismo número en otro repo no la ve', () => {
  const home = tmp('home');
  const a = copia('https://example.com/acme/historias.git');
  const otro = copia('https://example.com/acme/otras.git');
  lib().writeRecord(home, a.story, limpio);
  assert.equal(lib().readRecord(home, otro.story).estado, 'none', 'otro origin');
  // sin origin, la clave es la raíz real del repo: otro repo sin origin no la ve, el mismo sí
  const s1 = copia(null);
  const s2 = copia(null);
  lib().writeRecord(home, s1.story, limpio);
  assert.equal(lib().readRecord(home, s2.story).estado, 'none', 'otro repo sin origin');
  assert.equal(lib().readRecord(home, s1.story).estado, 'current', 'el mismo repo sin origin');
});

test('StoryReview_OldKey_StillRead @story-8.277 @ac-25 — una revisión con la clave de antes se sigue leyendo', () => {
  // 🔴 mutación: leer sólo la clave nueva deja sin constancia a las revisiones escritas antes del cambio.
  const home = tmp('home');
  const a = copia('https://example.com/acme/historias.git');
  const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
  const real = fs.realpathSync.native(a.story);
  const vieja = path.join(stateDir(home), lib().RECORD_DIR, `${crypto.createHash('sha256').update(real).digest('hex').slice(0, 32)}.json`);
  assert.notEqual(vieja, lib().recordFile(home, a.story), 'la clave cambió');
  escribir(vieja, JSON.stringify({ path: real, resultado: 'limpio', motivo: null, hallazgos: [], huella: lib().huella(historia()), hora: '2026-11-14T22:01:18.549Z' }));
  assert.equal(lib().readRecord(home, a.story).estado, 'current');
  // la nueva gana sobre la vieja
  const b = copia('https://example.com/acme/historias.git');
  lib().writeRecord(home, b.story, { ...limpio, resultado: 'no-medido' });
  assert.equal(lib().readRecord(home, a.story).estado, 'unmeasured');
});
