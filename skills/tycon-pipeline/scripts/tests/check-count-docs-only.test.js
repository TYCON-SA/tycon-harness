#!/usr/bin/env node
/**
 * check-count-docs-only.test.js — en una story con cambios sólo de documentación, el conteo de revisores controla
 * algo.
 *
 * El caso: al cerrar una story, `pipeline.js advisors` calcula 3 revisores para un diff de sólo
 * documentación, pero el `step5-start` del registro puede guardar un `expected` VACÍO, y `check-count` da OK con 0 corridos.
 * Con el set anotado entero, el conteo frena. Estos casos lo fijan.
 *
 * 🔴 Mutación que los pone en rojo: persistir `[]` en `logStep5Start` cuando el diff es sólo de docs (T1), o que
 * `check-count` acepte un `expected` vacío sin que mech-check lo haya vaciado (T2).
 *
 * Todo con HOME temporal: el registro real de la máquina no se toca.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const PIPELINE = path.join(__dirname, '..', 'pipeline.js');
const SID = 'test-check-count-docs-only';

function mkRepo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-'));
  // fecha fija y sin mantenimiento automático: el sha sale siempre igual (guides/test-execution-discipline.md)
  const fechas = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', r, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: { ...process.env, ...fechas } });
  fs.mkdirSync(path.join(r, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(r, 'specs', 'story-1.1.md'), [
    '---', 'epic: 1', 'story: "1.1"', 'title: "una guía"', 'status: in-progress', '---',
    '# Story 1.1', '', '## Acceptance Criteria', '1. la guía dice X', '',
    '## Tests', '| # | Test |', '|---|---|', '| 1 | T1 |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(r, 'README.md'), 'a\n');
  git('init', '-q');
  git('-c', 'user.email=noreply@example.com', '-c', 'user.name=lab', 'add', '-A');
  git('-c', 'user.email=noreply@example.com', '-c', 'user.name=lab', 'commit', '-qm', 'init');
  fs.appendFileSync(path.join(r, 'README.md'), 'b\n');
  fs.mkdirSync(path.join(r, 'docs'));
  fs.writeFileSync(path.join(r, 'docs', 'guia.md'), 'c\n');
  return r;
}

function correr(home, repo, args) {
  return spawnSync(process.execPath, [PIPELINE, ...args, '--repo', repo, '--story', 'specs/story-1.1.md', '--files', 'README.md', 'docs/guia.md'], {
    cwd: repo, encoding: 'utf8', timeout: 60000,
    // ningún paquete: la casa de juguete no tiene arnés que diga cuáles activa la organización, y la prueba mide el set
    // de revisores de un diff de documentación, no los paquetes
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_SESSION_ID: SID, TYCON_PACKS_DEFAULT: 'none' },
  });
}

function step5Starts(home) {
  const out = [];
  const buscar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) buscar(p);
      else if (e.name === `${SID}.jsonl`) {
        for (const l of fs.readFileSync(p, 'utf8').split('\n')) { try { const j = JSON.parse(l); if (j.event === 'step5-start') out.push(j); } catch { /* línea vacía */ } }
      }
    }
  };
  buscar(home);
  return out;
}

test('T1 · un diff de sólo documentación anota en step5-start el MISMO set que calcula (no uno vacío)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-home-'));
  const repo = mkRepo();
  const r = correr(home, repo, ['advisors']);
  assert.strictEqual(r.status, 0, r.stderr);
  const set = JSON.parse(r.stdout);
  assert.ok(set.all.length > 0, 'el set de un diff de docs no puede salir vacío');
  const starts = step5Starts(home);
  assert.strictEqual(starts.length, 1, 'esperaba un step5-start en el registro');
  assert.deepStrictEqual(starts[0].expected, set.all, 'lo anotado como esperado tiene que ser lo calculado');
});

test('T2 · con el set anotado y cero revisores corridos, check-count FRENA (no da OK con 0)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-home-'));
  const repo = mkRepo();
  assert.strictEqual(correr(home, repo, ['advisors']).status, 0);
  const r = correr(home, repo, ['check-count']);
  assert.notStrictEqual(r.status, 0, `check-count salió ${r.status} con cero corridos:\n${r.stdout}`);
  assert.match(r.stderr, /CERO spawns|FALL/);
});
