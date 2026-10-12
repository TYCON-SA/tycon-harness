#!/usr/bin/env node
/**
 * backfill-discovery.test.js — el backfill de back-links usa EL MISMO descubridor que el resto
 * del arnés, no uno propio.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * `tycon-backfill-followups.js` armaba su índice con un `readdirSync(dir)` PLANO: sólo veía los
 * `.md` sueltos del directorio que se le pasara, sin bajar un nivel. Contra un repo del equipo —donde
 * las stories viven en `specs/bizuit-bpmn-mcp/`— corría desde la raíz del repo y avisaba
 * "0 stories Mary+GOLD encontradas". Dos buscadores distintos en dos repos distintos: el que
 * arreglás no es el que se rompe.
 *
 * Ahora delega en `lib/story-discovery.js` del skill `tycon-pipeline` (fuente única), con
 * fail-open ruidoso si ese repo no está clonado.
 *
 * Correr: node --test scripts/tests/backfill-discovery.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKFILL = path.join(__dirname, '..', 'tools', 'tycon-backfill-followups.js');

function write(root, rel, fm, body = '# story') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\n${fm.join('\n')}\n---\n\n${body}\n`, 'utf8');
  return abs;
}

function run(args, cwd) {
  try {
    return { code: 0, out: execFileSync('node', [BACKFILL, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/** Repo con el layout que el buscador plano no veía + una relación follow-up real. */
function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  write(root, 'specs/bizuit-bpmn-mcp/4-33-padre.md', ['story: "4.33"', 'epic: 4', 'status: done', 'title: "La madre"']);
  write(root, 'specs/bizuit-bpmn-mcp/4-43-hija.md', [
    'story: "4.43"', 'epic: 4', 'status: ready-for-dev', 'title: "La hija"',
    'followup_of:', '  - id: "4.33"', '    type: fix', '    summary: "lo que faltó"',
  ]);
  // Material de evals: frontmatter Mary+GOLD válido, NO es trabajo del repo.
  write(root, 'mcp/eval/bancos/generacion/historias/ev1.md', ['epic: eval', 'story: "EV-1"', 'status: ready-for-dev']);
  return root;
}

test('backfill: descubre las stories del repo aunque no vivan en un dir plano', () => {
  const root = mkRepo();

  const r = run([], root);   // sin --dir: descubre desde el repo del cwd

  assert.ok(!/0 stories Mary\+GOLD encontradas/.test(r.out),
    `no debería reportar cero:\n${r.out}`);
  assert.match(r.out, /Stories revisadas\*{0,2}:\s*2\b/,
    `debería ver las 2 stories de specs/bizuit-bpmn-mcp/ (y NO el material de evals):\n${r.out}`);
  assert.match(r.out, /4\.33/, 'y detectar el back-link que le falta a la padre');

  fs.rmSync(root, { recursive: true, force: true });
});

test('backfill: --apply escribe el back-link en la padre descubierta', () => {
  const root = mkRepo();
  const padre = path.join(root, 'specs/bizuit-bpmn-mcp/4-33-padre.md');

  const r = run(['--apply'], root);
  assert.equal(r.code, 0, r.out);

  const after = fs.readFileSync(padre, 'utf8');
  assert.match(after, /followed_up_by:/, 'la padre queda con el back-link');
  assert.match(after, /id:\s*["']?4\.43/, 'apuntando a la hija');

  // Idempotente: una segunda corrida no duplica.
  run(['--apply'], root);
  const twice = fs.readFileSync(padre, 'utf8');
  assert.equal((twice.match(/id:\s*["']?4\.43/g) || []).length, 1, 'no duplica entries');

  fs.rmSync(root, { recursive: true, force: true });
});

test('backfill: el material de evals no entra en el conteo', () => {
  const root = mkRepo();
  const r = run([], root);
  assert.ok(!/EV-1/.test(r.out), `EV-1 es insumo de evals, no una story del repo:\n${r.out}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('backfill: --render-table linkea bien cuando padre e hija viven en carpetas distintas', () => {
  // Regresión introducida POR el descubrimiento recursivo: con todas las stories en un dir plano,
  // `./<basename>` siempre era correcto. Con layouts anidados, ya no.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-rt-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  write(root, 'specs/mcp/4-33-padre.md', ['story: "4.33"', 'epic: 4', 'status: done', 'title: "La madre"']);
  write(root, 'specs/mcp/sub-epic/4-43-hija.md', [
    'story: "4.43"', 'epic: 4', 'status: done', 'title: "La hija"',
    'followup_of:', '  - id: "4.33"', '    type: fix', '    summary: "lo que faltó"',
  ]);
  run(['--apply'], root);   // deja el back-link en la padre

  const r = run(['--render-table', '--story', '4.33'], root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\(\.\/sub-epic\/4-43-hija\.md\)/,
    `el link a la hija tiene que bajar a su carpeta, no asumir que está al lado:\n${r.out}`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('backfill: --dir sigue funcionando y ahora también baja un nivel', () => {
  const root = mkRepo();
  const r = run(['--dir', path.join(root, 'specs')], root);
  assert.match(r.out, /Stories revisadas\*{0,2}:\s*2\b/, `--dir <padre> encuentra las anidadas:\n${r.out}`);
  fs.rmSync(root, { recursive: true, force: true });
});
