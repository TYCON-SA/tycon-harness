#!/usr/bin/env node
/**
 * installed-tree.test.js — qué es el árbol instalado del arnés y si una ruta cae adentro, por ruta real.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/installed-tree.test.js
 * 0 deps (node:test). Cada prueba arma un HOME temporal con la forma de una instalación por versión.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const tree = require(path.join(SCRIPTS, 'lib', 'installed-tree.js'));
const REPO_ROOT = path.join(SCRIPTS, '..', '..', '..');

delete process.env.TYCON_HOME;

/** HOME temporal: `~/.tycon` con el arnés, team, third-party y previous, y los enlaces de `~/.claude`. */
function mkHome({ release = true } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arbol-')));
  const own = path.join(home, '.tycon');
  fs.mkdirSync(path.join(own, 'state'), { recursive: true });
  fs.writeFileSync(path.join(own, 'state', 'harness-state.json'),
    JSON.stringify({ sources: [{ kind: release ? 'release' : 'clone' }] }));
  fs.mkdirSync(path.join(own, 'harness', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(own, 'harness', 'scripts', 'install-tycon-hooks.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(own, 'harness', 'story-format.md'), '# guía\n');
  for (const d of ['team', 'third-party', 'previous']) fs.mkdirSync(path.join(own, d), { recursive: true });
  fs.writeFileSync(path.join(own, 'config.json'), '{}');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  for (const l of ['tycon-harness', 'agent-skills']) fs.symlinkSync(path.join(own, 'harness'), path.join(home, '.claude', l), 'junction');
  fs.symlinkSync(path.join(home, '.claude', 'tycon-harness'), path.join(home, '.claude', 'tycon-claude-guides'), 'junction');
  return { home, own };
}

test('T1 Roots_ReleaseMachine', () => {
  const { home, own } = mkHome();
  const r = tree.roots({ home });
  for (const d of ['harness', 'team', 'third-party', 'previous']) assert.ok(r.includes(path.join(own, d)), d);
  assert.equal(r.length, 4);

  const clone = mkHome({ release: false });
  assert.deepEqual(tree.roots({ home: clone.home }), [], 'sin instalación por versión no hay árbol que negar');
});

test('T1b Roots_OwnHomeElsewhereAndMissingSibling', () => {
  // la casa del arnés en otra carpeta (TYCON_HOME) y una vecina que no está: se niega lo que hay, sin tirar
  const { home, own } = mkHome();
  const otra = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casa-')));
  fs.renameSync(own, path.join(otra, 'casa'));
  fs.rmSync(path.join(otra, 'casa', 'previous'), { recursive: true });
  for (const l of ['tycon-harness', 'agent-skills']) {
    fs.unlinkSync(path.join(home, '.claude', l));
    fs.symlinkSync(path.join(otra, 'casa', 'harness'), path.join(home, '.claude', l), 'junction');
  }
  process.env.TYCON_HOME = path.join(otra, 'casa');
  try {
    const r = tree.roots({ home });
    assert.deepEqual(r.sort(), ['harness', 'team', 'third-party'].map((d) => path.join(otra, 'casa', d)).sort());
  } finally { delete process.env.TYCON_HOME; }
});

test('T2 Inside_ByRealPath', () => {
  const { home, own } = mkHome();
  const r = tree.roots({ home });
  const adentro = [
    path.join(own, 'harness', 'story-format.md'),
    path.join(home, '.claude', 'tycon-harness', 'story-format.md'),
    path.join(home, '.claude', 'agent-skills', 'skills', 'x', 'SKILL.md'),
    path.join(home, '.claude', 'tycon-claude-guides', 'nuevo', 'dir', 'a.js'),
    path.join(own, 'team', 'abc', 'perfil.json'),
  ];
  for (const f of adentro) assert.equal(tree.inside(r, f), true, f);
  const afuera = [
    path.join(own, 'config.json'),
    path.join(own, 'state', 'active', 's1.json'),
    path.join(home, 'proyecto', 'src', 'a.js'),
    path.join(os.tmpdir(), 'x.md'),
  ];
  for (const f of afuera) assert.equal(tree.inside(r, f), false, f);
  assert.equal(tree.inside([], adentro[0]), false);
  assert.equal(tree.realPath(path.join(home, '.claude', 'tycon-harness', 'no', 'existe.md')),
    path.join(own, 'harness', 'no', 'existe.md'));
});

test('T2b Inside_DanglingLinkAndDotDot', () => {
  // un enlace roto que apunta adentro del árbol, y un `..` después de un enlace: se resuelven como el sistema al escribir
  // (las rutas con `..` se arman a mano: path.join las colapsaría antes de llegar)
  const { home, own } = mkHome();
  const r = tree.roots({ home });
  const afuera = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'afuera-')));
  fs.symlinkSync(path.join(own, 'harness', 'nuevo.md'), path.join(afuera, 'roto.md'));
  assert.equal(tree.inside(r, path.join(afuera, 'roto.md')), true, 'enlace roto hacia el árbol');
  fs.mkdirSync(path.join(own, 'harness', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(own, 'harness', 'skills'), path.join(afuera, 'sk'), 'junction');
  assert.equal(tree.inside(r, `${afuera}${path.sep}sk${path.sep}..${path.sep}x.md`), true, '.. después de un enlace');
  assert.equal(tree.inside(r, `${afuera}${path.sep}otro${path.sep}..${path.sep}x.md`), false, '.. sin enlace queda afuera');
});

test('T2c Inside_LinkLoopAndCase', () => {
  // un ciclo de enlaces no cuelga ni tira; la comparación no distingue mayúsculas (Mac y Windows)
  const { home, own } = mkHome();
  const r = tree.roots({ home });
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ciclo-')));
  fs.symlinkSync(path.join(d, 'b'), path.join(d, 'a'));
  fs.symlinkSync(path.join(d, 'a'), path.join(d, 'b'));
  assert.equal(tree.inside(r, path.join(d, 'a', 'x.md')), false);
  assert.equal(tree.inside(r, path.join(own, 'HARNESS', 'x.md').replace(own, own.toUpperCase())), true);
});

test('T10 Survey_NormalRunWritesOutsideTree', () => {
  // Dos guías mandaban al agente a escribir en la instalación: ahora mandan a
  // una copia de trabajo del repo, o dicen que en una instalación por versión el agente no puede.
  const install = fs.readFileSync(path.join(REPO_ROOT, 'INSTALL.md'), 'utf8');
  assert.doesNotMatch(install, /mkdir -p ~\/\.claude\/tycon-harness\/skills/);
  assert.doesNotMatch(install, /cd ~\/\.claude\/tycon-harness\n\s*git (add|rm)/);
  assert.match(install, /nunca en el arnés instalado/);
  const inactive = fs.readFileSync(path.join(REPO_ROOT, 'guides', 'maintaining', 'inactive-skills.md'), 'utf8');
  assert.match(inactive, /el agente no la puede escribir/);
});

test('T12 PiecesCard_NamesInstalledTree', () => {
  const card = fs.readFileSync(path.join(REPO_ROOT, 'guides', 'piezas-del-arnes.md'), 'utf8');
  assert.match(card, /árbol instalado/);
  assert.match(card, /se cambia con un pedido a su repo, no editando la instalación/);
  assert.match(card, /En Codex frena su sandbox/, 'lo medido de Codex (AC 10) está en la ficha');
  assert.match(card, /con acceso total escribe/, 'y lo que pasa con acceso total');
});
