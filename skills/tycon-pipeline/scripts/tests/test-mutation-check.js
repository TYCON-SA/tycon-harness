#!/usr/bin/env node
'use strict';
/**
 * test-mutation-check.js — suite del CHEQUEO DE MUTANTES del harness TYCON.
 *
 * Por qué existe el chequeo: una suite en verde NO prueba que los tests ejerzan
 * el código nuevo — puede pasar que un test pase sin probar nada. El chequeo
 * rompe el código a propósito (mutantes chicos y determinísticos sobre las
 * líneas AGREGADAS) y verifica que ALGÚN test se ponga rojo.
 *
 * Esta suite incluye el
 * CONTROL POSITIVO obligatorio: una fixture donde un mutante SOBREVIVE a
 * propósito (función sin test) y otro donde MUERE (función testeada). Sin esa
 * fila que TIENE que encenderse, "0 sobrevivientes" es indistinguible de un
 * instrumento roto.
 *
 * Correr: node --test ~/.claude/agent-skills/skills/tycon-pipeline/scripts/tests/test-mutation-check.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'mutation');

const mutants = require(path.join(SCRIPTS, 'lib', 'mutation-mutants.js'));
const checker = require(path.join(SCRIPTS, 'mutation-check.js'));
const { runMutationGate } = require(path.join(SCRIPTS, 'lib', 'mutation-gate.js'));

// ── Helpers de fixture: mini-repo git en tmpdir ──────────────────────────────
// Las fuentes estáticas viven en fixtures/mutation/; el repo git se arma en un
// tmpdir en runtime (no se puede commitear un repo git adentro del repo).

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`comando falló: ${cmd} ${args.join(' ')}\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

// Crea un repo git con `calc.js` y `calc.test.js` como líneas AGREGADAS sobre
// HEAD (se commitea un placeholder y después se sobreescribe con la fixture).
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mutcheck-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'test@tycon.local'], dir);
  sh('git', ['config', 'user.name', 'tycon-test'], dir);
  sh('git', ['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'calc.js'), "'use strict';\n");
  fs.writeFileSync(path.join(dir, 'calc.test.js'), "'use strict';\n");
  sh('git', ['add', '.'], dir);
  sh('git', ['commit', '-q', '-m', 'base'], dir);
  // Sobreescribir con las fixtures reales → todo lo nuevo es "línea agregada".
  fs.copyFileSync(path.join(FIXTURES, 'calc.js'), path.join(dir, 'calc.js'));
  fs.copyFileSync(path.join(FIXTURES, 'calc.test.js'), path.join(dir, 'calc.test.js'));
  fs.copyFileSync(path.join(FIXTURES, 'story-con-tests.md'), path.join(dir, 'story-con-tests.md'));
  fs.copyFileSync(path.join(FIXTURES, 'story-sin-tests.md'), path.join(dir, 'story-sin-tests.md'));
  return dir;
}

// ── Lógica pura: generación de mutantes ──────────────────────────────────────

test('generateMutants: operadores básicos, sólo sobre líneas agregadas', async () => {
  const source = [
    'const a = x === y;',      // línea 1 — NO agregada: no se muta
    'const b = x !== y;',      // línea 2 — agregada
    'const c = p && q;',       // línea 3 — agregada
    'const d = p || q;',       // línea 4 — agregada
    'if (n >= 1) { f(); }',    // línea 5 — agregada
    'if (n <= 9) { g(); }',    // línea 6 — agregada
    'return true;',            // línea 7 — agregada
    'return false;',           // línea 8 — agregada
  ].join('\n');
  const out = mutants.generateMutants([
    { file: 'a.js', source, addedLines: [2, 3, 4, 5, 6, 7, 8] },
  ]);
  const ops = out.map((m) => `${m.line}:${m.operator}`);
  // La línea 1 (no agregada) no genera nada.
  assert.ok(!out.some((m) => m.line === 1), 'no debe mutar líneas no agregadas');
  assert.ok(ops.includes('2:neq-a-eq'), '!== → ===');
  assert.ok(ops.includes('3:and-a-or'), '&& → ||');
  assert.ok(ops.includes('4:or-a-and'), '|| → &&');
  assert.ok(ops.includes('5:gte-a-gt'), '>= → >');
  assert.ok(ops.includes('6:lte-a-lt'), '<= → <');
  assert.ok(ops.includes('5:negar-if'), 'if (X) → if (!(X))');
  assert.ok(ops.includes('7:return-true-a-false'), 'return true → return false');
  assert.ok(ops.includes('8:return-false-a-true'), 'return false → return true');
  // Cada mutante trae before/after distintos y el before es la línea real.
  for (const m of out) {
    assert.notEqual(m.before, m.after, 'before y after tienen que diferir');
    assert.equal(m.before, source.split('\n')[m.line - 1]);
  }
});

test('generateMutants: === → !== no matchea dentro de !== ni al revés', async () => {
  const out = mutants.generateMutants([
    { file: 'a.js', source: 'const b = x !== y;\nconst a = x === y;', addedLines: [1, 2] },
  ]);
  const línea1 = out.filter((m) => m.line === 1).map((m) => m.operator);
  const línea2 = out.filter((m) => m.line === 2).map((m) => m.operator);
  assert.deepEqual(línea1, ['neq-a-eq'], 'x !== y sólo genera neq-a-eq');
  assert.deepEqual(línea2, ['eq-a-neq'], 'x === y sólo genera eq-a-neq');
  assert.equal(out.find((m) => m.line === 2).after, 'const a = x !== y;');
});

test('generateMutants: no muta comentarios ni operadores dentro de strings', async () => {
  const source = [
    '// esto === no se muta',
    '* tampoco && esto (línea de bloque de comentario)',
    '/* ni esto || */',
    'const s = "a === b && c";',            // operadores SOLO dentro del string
    "const t = 'x >= y' && z;",             // && fuera del string SÍ se muta
    'const u = `p || q`; // y === acá no',  // template + comentario inline
  ].join('\n');
  const out = mutants.generateMutants([
    { file: 'a.js', source, addedLines: [1, 2, 3, 4, 5, 6] },
  ]);
  assert.ok(!out.some((m) => m.line === 1), 'línea // no se muta');
  assert.ok(!out.some((m) => m.line === 2), 'línea * no se muta');
  assert.ok(!out.some((m) => m.line === 3), 'línea /* no se muta');
  assert.ok(!out.some((m) => m.line === 4), 'operadores dentro de string no se mutan');
  const l5 = out.filter((m) => m.line === 5);
  assert.deepEqual(l5.map((m) => m.operator), ['and-a-or'], 'el && fuera del string sí');
  assert.equal(l5[0].after, "const t = 'x >= y' || z;");
  assert.ok(!out.some((m) => m.line === 6), 'template literal y comentario inline no se mutan');
});

test('generateMutants: negar-if sólo si el paréntesis cierra en la misma línea', async () => {
  const source = [
    'if (a &&',        // if multilínea → sin negar-if (pero && sí)
    '    b) {',
    'if (esPar(n)) {', // if con paréntesis anidados que cierra en la línea → sí
  ].join('\n');
  const out = mutants.generateMutants([{ file: 'a.js', source, addedLines: [1, 2, 3] }]);
  assert.ok(!out.some((m) => m.line === 1 && m.operator === 'negar-if'), 'if multilínea no se niega');
  assert.ok(out.some((m) => m.line === 1 && m.operator === 'and-a-or'), 'el && del if multilínea sí se muta');
  const neg = out.find((m) => m.line === 3 && m.operator === 'negar-if');
  assert.ok(neg, 'if de una línea sí se niega');
  assert.equal(neg.after, 'if (!(esPar(n))) {');
});

test('generateMutants: orden determinístico — archivo alfabético, línea, operador', async () => {
  const entries = [
    { file: 'zzz.js', source: 'return true;', addedLines: [1] },
    { file: 'aaa.js', source: 'if (x >= 1 && y) { h(); }\nreturn false;', addedLines: [1, 2] },
  ];
  const out1 = mutants.generateMutants(entries);
  const out2 = mutants.generateMutants(entries.slice().reverse());
  assert.deepEqual(out1, out2, 'el orden no depende del orden de entrada');
  const files = out1.map((m) => m.file);
  assert.deepEqual(files, files.slice().sort(), 'archivos en orden alfabético');
  const deAaa = out1.filter((m) => m.file === 'aaa.js');
  const líneas = deAaa.map((m) => m.line);
  assert.deepEqual(líneas, líneas.slice().sort((a, b) => a - b), 'líneas ascendentes');
  // En la línea 1 de aaa.js el orden de operadores es el orden FIJO del catálogo.
  const opsL1 = deAaa.filter((m) => m.line === 1).map((m) => m.operator);
  const orden = mutants.OPERATOR_ORDER.filter((o) => opsL1.includes(o));
  assert.deepEqual(opsL1, orden, 'operadores en el orden fijo del catálogo');
});

test('applyMutant: aplica el mutante y falla ante mismatch', async () => {
  const source = 'const a = 1;\nreturn a === 1;\n';
  const [m] = mutants.generateMutants([{ file: 'x.js', source, addedLines: [2] }]);
  assert.equal(m.operator, 'eq-a-neq');
  const mutado = mutants.applyMutant(source, m);
  assert.equal(mutado, 'const a = 1;\nreturn a !== 1;\n');
  // Si el archivo cambió y la línea ya no coincide con `before` → null (fail-closed).
  assert.equal(mutants.applyMutant('otra cosa\ntotalmente distinta\n', m), null);
});

test('applyMutant: preserva CRLF en la línea mutada', async () => {
  const source = 'const a = 1;\r\nreturn a === 1;\r\n';
  const [m] = mutants.generateMutants([{ file: 'x.js', source, addedLines: [2] }]);
  const mutado = mutants.applyMutant(source, m);
  assert.equal(mutado, 'const a = 1;\r\nreturn a !== 1;\r\n');
});

// ── Runner: parsing de diff y detección de tests ─────────────────────────────

test('parseAddedLines: extrae los números de línea agregados de un diff -U0', async () => {
  const diff = [
    'diff --git a/calc.js b/calc.js',
    'index 111..222 100644',
    '--- a/calc.js',
    '+++ b/calc.js',
    '@@ -0,0 +2,3 @@',
    '+function f() {',
    '+  return 1;',
    '+}',
    '@@ -9 +8,2 @@',
    '+const x = 1;',
    '+const y = 2;',
    '@@ -20,2 +30 @@',
    '-borrada',
    '-borrada',
    '+una sola',
  ].join('\n');
  assert.deepEqual(checker.parseAddedLines(diff), [2, 3, 4, 8, 9, 30]);
});

test('looksLikeTestPath: positivos y negativos', async () => {
  const SÍ = ['mcp/tests/unit/foo.test.js', 'src/a.spec.ts', 'scripts/tests/algo.js', 'x/__tests__/y.js'];
  const NO = ['src/index.js', 'lib/story-checks.js', 'docs/tests.md', 'contest.js'];
  for (const p of SÍ) assert.equal(checker.looksLikeTestPath(p), true, `debería parecer test: ${p}`);
  for (const p of NO) assert.equal(checker.looksLikeTestPath(p), false, `NO debería parecer test: ${p}`);
});

// ── Runner: exit codes estructurales ─────────────────────────────────────────

test('story sin tests declarados → exit 2 con motivo', async () => {
  const repo = mkRepo();
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-sin-tests.md'),
    log: () => {},
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo || '', /test/i, 'el motivo tiene que explicar que faltan tests declarados');
});

test('repo inválido → exit 2', async () => {
  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-norepo-'));
  const r = await checker.runMutationCheck({
    repo: noRepo,
    storyPath: path.join(FIXTURES, 'story-con-tests.md'),
    log: () => {},
  });
  assert.equal(r.exitCode, 2);
});

// ── Runner: el restore es sagrado ────────────────────────────────────────────

test('restore: el archivo queda byte-idéntico aunque el comando de test EXPLOTE', async () => {
  const repo = mkRepo();
  const target = path.join(repo, 'calc.js');
  const antes = fs.readFileSync(target);
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    // La corrida BASE (mutant: null) pasa; la corrida del mutante EXPLOTA.
    runTests: ({ mutant }) => {
      if (!mutant) return { code: 0 };
      throw new Error('boom simulado del runner');
    },
    log: () => {},
  });
  const después = fs.readFileSync(target);
  assert.equal(Buffer.compare(antes, después), 0, 'el archivo tiene que quedar byte-idéntico');
  assert.equal(r.exitCode, 2, 'una excepción del runner es error estructural, no un veredicto');
});

test('restore: el archivo queda byte-idéntico tras una corrida normal', async () => {
  const repo = mkRepo();
  const target = path.join(repo, 'calc.js');
  const antes = fs.readFileSync(target);
  await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    runTests: ({ mutant }) => ({ code: mutant ? 1 : 0 }),
    log: () => {},
  });
  assert.equal(Buffer.compare(antes, fs.readFileSync(target)), 0);
});

test('restore FALLIDO end-to-end: exit 2 gritando, motivo con path y backup, y backup recuperable', async () => {
  // El invariante sagrado tiene que estar ANCLADO por un test: un mutante
  // `restoreOk = true;` sobre la verificación byte a byte dejaría la suite en
  // verde. Acá se inyecta un fs cuyo write de RESTAURACIÓN
  // (el del finally: target + Buffer) escribe bytes DISTINTOS a los originales.
  const repo = mkRepo();
  const target = path.join(repo, 'calc.js');
  const original = fs.readFileSync(target);
  const gritos = [];
  let corridas = 0;
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    runTests: ({ mutant }) => { if (mutant) corridas += 1; return { code: 0 }; },
    fsOps: {
      // Los mutantes corren sobre una COPIA: el path que llega es el de la copia, así
      // que el archivo se reconoce por nombre, no por el path del repo original.
      writeFileSync: (p, data, ...rest) => {
        if (p.endsWith('/calc.js') && Buffer.isBuffer(data)) {
          // La escritura de restauración, corrompida a propósito.
          return fs.writeFileSync(p, Buffer.concat([data, Buffer.from('RESTORE CORRUPTO')]));
        }
        return fs.writeFileSync(p, data, ...rest);
      },
    },
    log: (...a) => gritos.push(a.join(' ')),
  });
  assert.equal(r.exitCode, 2, 'restore fallido es exit 2, nunca un veredicto');
  assert.ok(r.result.motivo.includes('calc.js'), 'el motivo nombra el archivo que quedó mutado (en la copia)');
  assert.equal(Buffer.compare(fs.readFileSync(target), original), 0, 'y el ORIGINAL nunca se tocó: la copia existe para eso');
  assert.ok(gritos.some((g) => /RESTORE FALLIDO/.test(g)), 'el grito salió por el log');
  assert.equal(corridas, 1, 'tras un restore fallido NO se sigue al mutante siguiente');
  // El backup es el ÚNICO camino de recuperación: tiene que existir y tener
  // los bytes ORIGINALES. Su path viene en el motivo.
  const backupM = r.result.motivo.match(/bytes originales en (.+)$/);
  assert.ok(backupM, 'el motivo cita el path del backup');
  const backupPath = backupM[1].trim();
  assert.ok(fs.existsSync(backupPath), `el backup tiene que existir: ${backupPath}`);
  assert.equal(Buffer.compare(fs.readFileSync(backupPath), original), 0, 'el backup tiene los bytes originales');
  fs.unlinkSync(backupPath); // limpieza del test (en la vida real queda para el usuario)
});

test('camino feliz del restore: el runner LEE el archivo para verificar byte a byte tras CADA restauración', async () => {
  // Segunda ancla del mismo invariante: cuenta las lecturas BINARIAS del
  // target (sin encoding). Por mutante ejecutado hay exactamente 2: los bytes
  // originales al entrar y la VERIFICACIÓN post-restore. Con la verificación
  // mutada a `restoreOk = true;`, la segunda lectura desaparece → rojo.
  const repo = mkRepo();
  const target = path.join(repo, 'calc.js');
  let lecturasBinarias = 0;
  let corridas = 0;
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    runTests: ({ mutant }) => { if (mutant) corridas += 1; return { code: mutant ? 1 : 0 }; },
    fsOps: {
      readFileSync: (p, ...rest) => {
        if (p.endsWith('/calc.js') && rest.length === 0) lecturasBinarias += 1;   // el path es el de la COPIA
        return fs.readFileSync(p, ...rest);
      },
    },
    log: () => {},
  });
  assert.equal(r.exitCode, 0);
  assert.ok(corridas >= 2, 'la fixture tiene que producir varios mutantes ejecutados');
  assert.equal(
    lecturasBinarias, 2 * corridas,
    'falta la lectura de VERIFICACIÓN post-restore (2 lecturas binarias por mutante: originales + verificación)'
  );
});

test('la corrida BASE no sale en verde → exit 2 HONESTO: no acusa a la suite de estar rota', async () => {
  // Si la base falla, el veredicto de mutantes no significa nada (todo mutante
  // "muere" gratis). Pero afirmar "la suite está en ROJO" sería mentir cuando lo
  // que pasa es que node --test no sabe correr esos tests (vitest globals, etc.)
  // Exit 2 con la duda declarada.
  const repo = mkRepo();
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    runTests: () => ({ code: 1 }),
    log: () => {},
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo || '', /BASE/i, 'el motivo nombra la corrida base');
  assert.match(r.result.motivo || '', /node --test/, 'dice con qué runner corrió');
  assert.ok(!/arreglá la suite/i.test(r.result.motivo || ''), 'no ordena arreglar una suite que quizás no está rota');
});

test('la corrida BASE se pasa del tope de tiempo → exit 2 que dice TIMEOUT, no acusa a la suite', async () => {
  // El runner SABE que mató al hijo por timeout — tirar ese dato y reportar
  // "exit 1" convertiría una suite lenta VERDE en "suite en rojo".
  const repo = mkRepo();
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    runTests: () => ({ code: 1, timedOut: true }),
    log: () => {},
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo || '', /tope|timeout|lenta/i, 'el motivo dice que fue por tiempo');
  assert.ok(!/en rojo/i.test(r.result.motivo || ''), 'no afirma que la suite esté en rojo');
});

// ── CONTROL POSITIVO — la razón de ser de esta suite ─────────────────────────
// Fixture calc.js: `esPar` tiene test (su mutante MUERE), `nuncaTesteada` no
// tiene ninguno (sus mutantes SOBREVIVEN). Si alguna de las dos filas no se
// enciende, el instrumento está roto.

// ── La copia descartable tiene que ser el repo que el dev tiene delante ──
// Una copia que sólo enlaza `<repo>/node_modules` no alcanza: lo que git
// ignora (un `local.json`, `sub/node_modules`), los submódulos y un `--files` absoluto hacen que el
// chequeo salga 2 con la suite VERDE en el original — y el gate lo trata como «no aplicable»: el
// control se apaga solo. Cada uno de los cinco casos de abajo cubre una de esas formas.
function sinLog() { return () => {}; }

test('copia: `--files` ABSOLUTO se relativiza contra el repo original, no contra la copia', async () => {
  const repo = mkRepo();
  const r = await checker.runMutationCheck({
    repo, storyPath: path.join(repo, 'story-con-tests.md'), files: [path.join(repo, 'calc.js')], log: sinLog(),
  });
  assert.equal(r.exitCode, 0, `motivo: ${r.result && r.result.motivo}`);
  assert.ok(r.result.total >= 1, 'mutó calc.js');
});

test('copia: un archivo IGNORADO por git que la suite lee viaja a la copia (la BASE no se pone roja)', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'local.json\n');
  fs.writeFileSync(path.join(repo, 'local.json'), '{"ok":true}\n');
  const t = path.join(repo, 'calc.test.js');
  fs.writeFileSync(t, "require('./local.json');\n" + fs.readFileSync(t, 'utf8'));
  const r = await checker.runMutationCheck({ repo, storyPath: path.join(repo, 'story-con-tests.md'), log: sinLog() });
  assert.equal(r.exitCode, 0, `motivo: ${r.result && r.result.motivo}`);
  assert.ok(r.result.killed >= 1);
});

test('copia: las dependencias en una SUBCARPETA (node_modules ignorado, sin node_modules en la raíz) también', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(repo, 'sub', 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'sub', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'sub', 'usa.js'), "module.exports = require('dep');\n");
  const t = path.join(repo, 'calc.test.js');
  fs.writeFileSync(t, "require('./sub/usa.js');\n" + fs.readFileSync(t, 'utf8'));
  const r = await checker.runMutationCheck({ repo, storyPath: path.join(repo, 'story-con-tests.md'), log: sinLog() });
  assert.equal(r.exitCode, 0, `motivo: ${r.result && r.result.motivo}`);
});

test('copia: un SUBMÓDULO poblado en el original está en la copia', async () => {
  const otro = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-submod-'));
  sh('git', ['init', '-q'], otro); sh('git', ['config', 'user.email', 't@t'], otro); sh('git', ['config', 'user.name', 't'], otro);
  fs.writeFileSync(path.join(otro, 'lib.js'), 'module.exports = 41;\n');
  sh('git', ['add', '.'], otro); sh('git', ['commit', '-q', '-m', 'lib'], otro);
  const repo = mkRepo();
  sh('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', otro, 'sub'], repo);
  sh('git', ['commit', '-q', '-m', 'submodulo'], repo);
  const t = path.join(repo, 'calc.test.js');
  fs.writeFileSync(t, "require('./sub/lib.js');\n" + fs.readFileSync(t, 'utf8'));
  const r = await checker.runMutationCheck({ repo, storyPath: path.join(repo, 'story-con-tests.md'), log: sinLog() });
  assert.equal(r.exitCode, 0, `motivo: ${r.result && r.result.motivo}`);
});

test('sin commits (repo recién iniciado): se muta en el propio repo, avisando — no exit 2', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mutcheck-nohead-'));
  sh('git', ['init', '-q'], dir);
  fs.copyFileSync(path.join(FIXTURES, 'calc.js'), path.join(dir, 'calc.js'));
  fs.copyFileSync(path.join(FIXTURES, 'calc.test.js'), path.join(dir, 'calc.test.js'));
  fs.copyFileSync(path.join(FIXTURES, 'story-con-tests.md'), path.join(dir, 'story-con-tests.md'));
  const logs = [];
  const r = await checker.runMutationCheck({ repo: dir, storyPath: path.join(dir, 'story-con-tests.md'), log: (...a) => logs.push(a.join(' ')) });
  assert.equal(r.exitCode, 0, `motivo: ${r.result && r.result.motivo}`);
  assert.ok(logs.some((l) => /PROPIO REPO/.test(l)), 'avisa que no hubo copia');
  assert.equal(fs.readFileSync(path.join(dir, 'calc.js'), 'utf8'), fs.readFileSync(path.join(FIXTURES, 'calc.js'), 'utf8'), 'el archivo queda restaurado');
});

test('CONTROL POSITIVO: un mutante muere (código testeado) y otro sobrevive (código sin test)', async () => {
  const repo = mkRepo();
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    log: () => {},
  });
  assert.equal(r.exitCode, 0, `corrida sana → exit 0 (result: ${JSON.stringify(r.result)})`);
  assert.ok(r.result.killed >= 1, 'el mutante de esPar (línea testeada) TIENE que morir');
  assert.ok(r.result.survived.length >= 1, 'los mutantes de nuncaTesteada TIENEN que sobrevivir');
  // El sobreviviente señala exactamente el código sin cobertura.
  const sinCobertura = r.result.survived.filter((m) => m.file === 'calc.js');
  assert.ok(sinCobertura.length >= 1, 'los sobrevivientes citan el archivo mutado');
  for (const m of sinCobertura) {
    assert.ok(m.line > 0 && m.operator && m.before && m.after, 'cada sobreviviente trae file/line/operator/before/after');
  }
  // El mutante de la línea `return n % 2 === 0;` (esPar) NO está entre los sobrevivientes.
  assert.ok(
    !r.result.survived.some((m) => m.before.includes('n % 2 === 0')),
    'el mutante del código testeado no puede sobrevivir'
  );
});

test('exit 1 cuando NINGÚN mutante muere (los tests no ejercen el código nuevo)', async () => {
  const repo = mkRepo();
  // Runner stub que siempre devuelve verde → todos los mutantes sobreviven.
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    runTests: () => ({ code: 0 }),
    log: () => {},
  });
  assert.equal(r.exitCode, 1);
  assert.equal(r.result.killed, 0);
  assert.ok(r.result.survived.length >= 1);
});

test('--max-mutants capea la corrida y registra los excedentes en skipped', async () => {
  const repo = mkRepo();
  let corridos = 0;
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    maxMutants: 2,
    runTests: ({ mutant }) => {
      if (mutant) corridos += 1;
      return { code: mutant ? 1 : 0 };
    },
    log: () => {},
  });
  assert.equal(corridos, 2, 'sólo se ejecutan maxMutants mutantes');
  assert.equal(r.result.total, 2);
  assert.ok(r.result.skipped.length >= 1, 'los excedentes quedan registrados en skipped');
  assert.ok(r.result.skipped.every((s) => s.reason), 'cada skipped trae su razón');
});

test('JSON de salida tiene la forma del contrato', async () => {
  const repo = mkRepo();
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    runTests: ({ mutant }) => ({ code: mutant ? 1 : 0 }),
    log: () => {},
  });
  const keys = Object.keys(r.result).sort();
  for (const k of ['total', 'killed', 'survived', 'skipped', 'verdict']) {
    assert.ok(keys.includes(k), `falta la clave '${k}' en el JSON`);
  }
  assert.equal(typeof r.result.total, 'number');
  assert.equal(typeof r.result.killed, 'number');
  assert.ok(Array.isArray(r.result.survived));
  assert.ok(Array.isArray(r.result.skipped));
});

// ── Capa de CABLEADO: el gate de `marker.js complete-step 4` ─────────────────
// AVISA, NO FRENA — salvo el único caso que frena:
// exit 1 (cero mutantes muertos habiendo generado alguno). Estos tests ejercitan
// `lib/mutation-gate.js` con el runner del chequeo INYECTADO (acá no se corre
// ningún mutante de verdad) y los logs capturados.

function gateHarness() {
  const entries = { 'gates.log': [], 'bypass.log': [] };
  const lines = [];
  return {
    entries,
    lines,
    appendLog: (file, obj) => { (entries[file] = entries[file] || []).push(obj); },
    log: (...a) => lines.push(a.join(' ')),
  };
}

const MARKER_FAKE = { storyId: '4.34', repoPath: '/tmp/fake-repo', storyPath: 'specs/story.md' };

const SOBREVIVIENTES = [
  { file: 'a.js', line: 7, operator: 'eq-a-neq', before: 'return x === 1;', after: 'return x !== 1;' },
  { file: 'a.js', line: 9, operator: 'and-a-or', before: 'if (p && q) {', after: 'if (p || q) {' },
];

test('gate: exit 1 (cero muertos) → BLOQUEA y el mensaje nombra mutantes sobrevivientes', async () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => ({
      code: 1,
      result: { total: 2, killed: 0, survived: SOBREVIVIENTES, skipped: [], verdict: 'TESTS_NO_EJERCEN_EL_CODIGO' },
    }),
  });
  assert.equal(r.block, true, 'cero muertos es el ÚNICO caso que frena');
  const texto = h.lines.join('\n');
  assert.match(texto, /BLOQUEADO/, 'el mensaje dice que bloquea');
  assert.match(texto, /ejercen/i, 'explica en castellano llano que los tests no ejercen el código nuevo');
  assert.ok(texto.includes('a.js:7'), 'lista sobrevivientes de ejemplo (archivo:línea)');
  const g = h.entries['gates.log'];
  assert.equal(g.length, 1, 'el veredicto queda SIEMPRE en gates.log');
  assert.equal(g[0].name, 'mutation');
  assert.equal(g[0].status, 'blocked');
  assert.equal(g[0].killed, 0);
});

test('gate: exit 0 con sobrevivientes → AVISA, no bloquea, y el veredicto queda en gates.log', async () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => ({
      code: 0,
      result: { total: 5, killed: 3, survived: SOBREVIVIENTES, skipped: [], verdict: 'AVISO_SOBREVIVIENTES' },
    }),
  });
  assert.equal(r.block, false, 'con algún muerto NO frena');
  const texto = h.lines.join('\n');
  assert.ok(texto.includes('a.js:7 [eq-a-neq]'), 'el aviso cita archivo:línea [operador]');
  assert.ok(texto.includes('a.js:9 [and-a-or]'));
  const g = h.entries['gates.log'];
  assert.equal(g.length, 1);
  assert.equal(g[0].status, 'warn-survivors');
  assert.equal(g[0].total, 5);
  assert.equal(g[0].killed, 3);
  assert.equal(g[0].survived, 2);
  assert.equal(typeof g[0].maxMutants, 'number', 'el presupuesto (--max-mutants) queda anotado en el log');
});

test('gate: exit 0 sin sobrevivientes → sigue en SILENCIO pero el veredicto queda en gates.log', async () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => ({ code: 0, result: { total: 4, killed: 4, survived: [], skipped: [], verdict: 'OK' } }),
  });
  assert.equal(r.block, false);
  assert.equal(h.lines.length, 0, 'sin sobrevivientes no hay ruido en consola');
  assert.equal(h.entries['gates.log'][0].status, 'pass');
});

test('gate: exit 2 (estructural, ej. story sin tests) → AVISA, no bloquea, y queda en gates.log', async () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => ({ code: 2, result: { motivo: 'la story no declara ningún archivo de test' } }),
  });
  assert.equal(r.block, false, 'una story de docs/config no tiene por qué trabarse');
  assert.match(h.lines.join('\n'), /no declara ningún archivo de test/, 'el aviso trae el motivo');
  const g = h.entries['gates.log'];
  assert.equal(g.length, 1);
  assert.equal(g[0].status, 'structural');
});

test('gate: TYCON_MUTATION_CHECK=off → ni se invoca', async () => {
  const h = gateHarness();
  let llamadas = 0;
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: { TYCON_MUTATION_CHECK: 'off' },
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => { llamadas += 1; return { code: 0, result: {} }; },
  });
  assert.equal(llamadas, 0, 'apagado global: el chequeo NI se invoca');
  assert.equal(r.block, false);
  assert.equal(h.entries['gates.log'].length, 0);
  assert.equal(h.entries['bypass.log'].length, 0);
});

test('gate: --no-mutation → no se invoca y queda en bypass.log', async () => {
  const h = gateHarness();
  let llamadas = 0;
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: ['--no-mutation'], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => { llamadas += 1; return { code: 0, result: {} }; },
  });
  assert.equal(llamadas, 0);
  assert.equal(r.block, false);
  const b = h.entries['bypass.log'];
  assert.equal(b.length, 1, 'el bypass NO es silencioso');
  assert.equal(b[0].kind, 'MUTATION_BYPASS');
  assert.equal(b[0].story, '4.34');
});

test('gate: el runner del chequeo EXPLOTA → fail-open avisando, nunca rompe complete-step 4', async () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => { throw new Error('boom inesperado'); },
  });
  assert.equal(r.block, false, 'un problema del chequeo mismo jamás frena el cierre');
  assert.match(h.lines.join('\n'), /boom inesperado/, 'el aviso dice qué pasó');
  assert.equal(h.entries['gates.log'][0].status, 'error');
});

test('gate: script ausente → fail-open avisando', async () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    scriptPath: '/no/existe/mutation-check.js',
    // sin invokeCheck: usa el default, que primero chequea que el script exista
  });
  assert.equal(r.block, false);
  assert.match(h.lines.join('\n'), /no encontrado|no existe/i);
  assert.equal(h.entries['gates.log'][0].status, 'error');
});

// ── Fallas del chequeo: nunca un veredicto falso ───────────────────────

const { spawn } = require('child_process');

// Un crash del runner NUNCA puede salir exit 1 (ambiguo con "cero muertos").
test('H1a: target sin permiso de escritura → exit 2 con el motivo REAL y archivo intacto', async () => {
  const repo = mkRepo();
  const target = path.join(repo, 'calc.js');
  const original = fs.readFileSync(target);
  fs.chmodSync(target, 0o444);
  try {
    // Los mutantes corren sobre una copia, así que el chmod del original no lo alcanza
    // — y ésa es la garantía. El «no pude escribir» se simula sobre el archivo de la copia.
    const eacces = Object.assign(new Error('EACCES: permission denied, open calc.js'), { code: 'EACCES' });
    const r = await checker.runMutationCheck({
      repo,
      storyPath: path.join(repo, 'story-con-tests.md'),
      runTests: ({ mutant }) => ({ code: mutant ? 1 : 0 }),
      fsOps: { writeFileSync: (p, ...rest) => { if (p.endsWith('/calc.js')) throw eacces; return fs.writeFileSync(p, ...rest); } },
      log: () => {},
    });
    assert.equal(r.exitCode, 2, 'un problema del chequeo es exit 2, JAMÁS exit 1 (acusaría a los tests)');
    assert.match(r.result.motivo || '', /EACCES|permission|no pude escribir/i, 'el motivo trae el error real');
    assert.equal(Buffer.compare(fs.readFileSync(target), original), 0, 'el archivo quedó intacto');
  } finally {
    fs.chmodSync(target, 0o644);
  }
});

// El gate bloquea SOLO con veredicto coherente; exit 1 sin result es problema del chequeo.
test('H1b: gate con exit 1 SIN result parseado → fail-open avisando, con el stderr del hijo impreso', async () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => ({ code: 1, result: null, stderr: 'Error: EACCES: permission denied\n    at writeFileSync' }),
  });
  assert.equal(r.block, false, 'exit 1 sin veredicto coherente NO puede bloquear');
  const texto = h.lines.join('\n');
  assert.match(texto, /chequeo/i, 'el aviso dice que el problema es del chequeo, no de los tests');
  assert.match(texto, /EACCES/, 'el stderr del hijo se imprime — el dev necesita la pista');
  assert.equal(h.entries['gates.log'][0].status, 'error');
});

test('H1b2: gate con exit 1 pero result INCOHERENTE (killed>0) → fail-open, no bloquea', async () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => ({
      code: 1,
      result: { total: 3, killed: 2, survived: [], skipped: [], verdict: 'OK' },
      stderr: '',
    }),
  });
  assert.equal(r.block, false, 'exit 1 con killed>0 es incoherente — problema del chequeo');
  assert.equal(h.entries['gates.log'][0].status, 'error');
});

// Señal en medio de un mutante: restore sincrónico + grito + exit 2 (proceso REAL).
test('H2a: SIGTERM con un mutante APLICADO → el handler restaura byte a byte, grita y sale 2', async () => {
  const repo = mkRepo();
  const target = path.join(repo, 'calc.js');
  // Suite lenta a propósito: da ventana para matar el proceso con el mutante en disco.
  fs.writeFileSync(path.join(repo, 'calc.test.js'), [
    "'use strict';",
    "const { test } = require('node:test');",
    "const assert = require('node:assert');",
    "const { esPar } = require('./calc.js');",
    "test('esPar lento', async () => {",
    '  await new Promise((r) => setTimeout(r, 4000));',
    '  assert.equal(esPar(2), true);',
    '  assert.equal(esPar(3), false);',
    '});',
    '',
  ].join('\n'));
  const original = fs.readFileSync(target);
  const child = spawn(process.execPath, [
    path.join(SCRIPTS, 'mutation-check.js'),
    '--repo', repo, '--story', path.join(repo, 'story-con-tests.md'), '--json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  // El mutante se aplica en la COPIA, que el CLI anuncia por stderr. Se espera a que
  // aparezca, se espera a ver el mutante ahí, y se manda la señal. El original tiene que quedar
  // byte-idéntico DURANTE y DESPUÉS — no sólo restaurado: nunca tocado.
  const t0 = Date.now();
  let copiaTarget = null;
  for (;;) {
    if (!copiaTarget) {
      const m = stderr.match(/copia descartable \((\S+?)\)/);
      if (m) copiaTarget = path.join(m[1], 'calc.js');
    } else if (fs.existsSync(copiaTarget) && Buffer.compare(fs.readFileSync(copiaTarget), original) !== 0) break;
    if (Date.now() - t0 > 30000) { child.kill('SIGKILL'); assert.fail('el mutante nunca se aplicó en la copia (¿baseline colgada?)'); }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(Buffer.compare(fs.readFileSync(target), original), 0, 'el ORIGINAL no se toca ni con el mutante en vuelo');
  child.kill('SIGTERM');
  const exitCode = await new Promise((resolve) => child.on('close', (c) => resolve(c)));
  assert.equal(Buffer.compare(fs.readFileSync(target), original), 0, 'byte-idéntico tras SIGTERM en pleno mutante');
  assert.equal(exitCode, 2, 'salida por señal con mutante en vuelo = exit 2, no muerte silenciosa');
  assert.match(stderr, /SIGTERM/i, 'el grito nombra la señal');
});

// Deadline ENTRE mutantes: corta limpio y reporta los restantes como skipped.
test('H2b: --deadline-ms corta entre mutantes y los restantes quedan skipped con razón deadline', async () => {
  const repo = mkRepo();
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    deadlineMs: 1, // el reloj se pasa ya en la primera comparación entre mutantes
    runTests: ({ mutant }) => {
      const t = Date.now();
      while (Date.now() - t < 30) { /* suite "lenta" simulada */ }
      return { code: mutant ? 1 : 0 };
    },
    log: () => {},
  });
  assert.equal(r.exitCode, 0, 'el corte por deadline no es un veredicto contra los tests');
  const porDeadline = r.result.skipped.filter((s) => /deadline/.test(s.reason));
  assert.ok(porDeadline.length >= 1, 'los mutantes que no llegaron a correr quedan declarados, no desaparecen');
  assert.ok(r.result.total < r.result.total + porDeadline.length, 'total = solo los ejecutados');
});

// Timeout duro del spawn en el gate: puede haber un archivo mutado y HAY que decirlo.
test('H2c: gate ante timeout duro → NO bloquea pero GRITA posible mutación y lo deja en gates.log', async () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => ({ code: null, result: null, stderr: '', timedOut: true }),
  });
  assert.equal(r.block, false, 'que no bloquee está bien; que no avise, no');
  const texto = h.lines.join('\n');
  assert.match(texto, /mutad/i, 'avisa que puede haber quedado un archivo mutado');
  assert.match(texto, /git status/, 'dice dónde mirar');
  assert.equal(h.entries['gates.log'][0].status, 'timeout-posible-mutacion');
});

// Los archivos NUEVOS (untracked) que la story DECLARA son el caso más
// común: TIENEN que chequearse (sus líneas = el archivo entero).
test('H3: archivos nuevos declarados por la story (untracked, sin `git add`) generan mutantes', async () => {
  // Repo cuyo commit base NO contiene calc.js: la story lo CREA (queda untracked).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mutuntracked-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'test@tycon.local'], dir);
  sh('git', ['config', 'user.name', 'tycon-test'], dir);
  sh('git', ['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  sh('git', ['add', 'README.md'], dir);
  sh('git', ['commit', '-q', '-m', 'base'], dir);
  for (const f of ['calc.js', 'calc.test.js', 'story-con-tests.md']) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  }
  const r = await checker.runMutationCheck({
    repo: dir,
    storyPath: path.join(dir, 'story-con-tests.md'),
    runTests: ({ mutant }) => ({ code: mutant ? 1 : 0 }),
    log: () => {},
  });
  assert.equal(r.exitCode, 0);
  assert.ok(r.result.total >= 1, `un chequeo que calla ante archivos nuevos es un verde falso (total=${r.result.total})`);
});

// Qué runner sabe correr el chequeo se decide por ESTRUCTURA (extensión
// ejecutable por `node --test`), JAMÁS escaneando el repo en busca de palabras
// como «vitest» (ningún control decide buscando frases).
test('N3a: test declarado .ts → exit 2 estructural honesto («sólo sé correr node --test»), sin correr nada', async () => {
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', 'calc.test.ts'), 'export {};\n');
  fs.writeFileSync(path.join(repo, 'story-ts.md'), [
    '---',
    'story: "MUT-4"',
    'epic: fixtures',
    'status: in-progress',
    'files_to_create:',
    '  - "calc.js"',
    '  - "tests/calc.test.ts"',
    '---',
    '',
    '# Story fixture — test TypeScript sin transpilar',
    '',
  ].join('\n'));
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-ts.md'),
    runTests: () => { throw new Error('no debería llegar a correr nada'); },
    log: () => {},
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo || '', /node --test/, 'el motivo dice qué sabe correr el chequeo');
  assert.match(r.result.motivo || '', /calc\.test\.ts/, 'y cita el test que no puede correr');
  assert.ok(!/ROJO/i.test(r.result.motivo || ''), 'nunca afirmar que la suite está rota cuando no la sabemos correr');
});

test('N3b: la palabra «vitest» en un comentario NO apaga el chequeo (nada de decidir por palabras)', async () => {
  // Un test node:test VERDE
  // con `// Migrado desde 'vitest'` no deshabilita el chequeo.
  const repo = mkRepo();
  const original = fs.readFileSync(path.join(FIXTURES, 'calc.test.js'), 'utf8');
  fs.writeFileSync(
    path.join(repo, 'calc.test.js'),
    `// Migrado desde 'vitest' a node:test — jest.fn() ya no se usa acá.\n${original}`,
  );
  // Runner REAL (default): si el chequeo corre de verdad, el mutante de esPar muere.
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    log: () => {},
  });
  assert.equal(r.exitCode, 0, `el chequeo tiene que CORRER, no apagarse (result: ${JSON.stringify(r.result)})`);
  assert.ok(r.result.killed >= 1, 'el mutante del código testeado muere — el chequeo corrió de verdad');
});

test('H4b: tests .NET declarados (FooTests.cs) → exit 2 honesto, no «la story no declara tests»', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'story-dotnet.md'), [
    '---',
    'story: "MUT-3"',
    'epic: fixtures',
    'status: in-progress',
    'files_to_create:',
    '  - "apinetcore/Api.Tests/CalcTests.cs"',
    '---',
    '',
    '# Story fixture .NET',
    '',
  ].join('\n'));
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-dotnet.md'),
    runTests: () => { throw new Error('no debería llegar a correr nada'); },
    log: () => {},
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo || '', /node --test/, 'dice qué sabe correr');
  assert.ok(!/no declara ning/i.test(r.result.motivo || ''), 'la story SÍ declara tests — decir lo contrario es falso');
});

// ── Los targets salen ÚNICAMENTE de lo que la story declara ─────────
// El descubrimiento por `git diff HEAD` + `ls-files --others` miraría TODO el repo
// cuando el pipeline es POR STORY — mutaría artefactos ajenos (bloqueo en falso
// comiéndose el presupuesto) y seguiría symlinks fuera del repo.

test('N1: los targets salen SOLO de la story — untracked ajenos y tracked modificados NO declarados no se mutan', async () => {
  const repo = mkRepo();
  // Basura típica que el propio pipeline deja + archivos ajenos a la story:
  fs.mkdirSync(path.join(repo, '.advisors'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.advisors', 'smoke.mjs'), 'if (a >= 1 && b === 2) { console.log(true); }\n');
  fs.writeFileSync(path.join(repo, 'ajeno.js'), 'const x = a && b;\nmodule.exports = x;\n');
  // Y un tracked MODIFICADO que la story tampoco declara (el camino `git diff HEAD`):
  fs.writeFileSync(path.join(repo, 'tracked-ajeno.js'), 'const t = 1;\n');
  sh('git', ['add', 'tracked-ajeno.js'], repo);
  sh('git', ['commit', '-q', '-m', 'tracked ajeno'], repo);
  fs.appendFileSync(path.join(repo, 'tracked-ajeno.js'), 'const y = p || q;\n');
  // Runner siempre-verde → TODOS los ejecutados quedan listados en survived.
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    runTests: () => ({ code: 0 }),
    log: () => {},
  });
  assert.equal(r.exitCode, 1, 'todos sobreviven → exit 1 (el stub nunca mata nada)');
  const tocados = [...r.result.survived, ...r.result.skipped].map((m) => m.file);
  assert.ok(tocados.length >= 1, 'la fixture declarada tiene que producir mutantes');
  for (const f of tocados) {
    assert.equal(f, 'calc.js', `mutó un archivo que la story NO declara: ${f}`);
  }
});

test('N2: target declarado que es symlink FUERA del repo → exit 2 sin escribir nada afuera', async () => {
  const repo = mkRepo();
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-fuera-'));
  const externo = path.join(fuera, 'externo.js');
  fs.writeFileSync(externo, 'function f(a, b) { if (a >= 1 && b === 2) { return true; } return false; }\n');
  const antes = fs.readFileSync(externo);
  fs.symlinkSync(externo, path.join(repo, 'enlace.js'));
  fs.writeFileSync(path.join(repo, 'story-symlink.md'), [
    '---',
    'story: "MUT-5"',
    'epic: fixtures',
    'status: in-progress',
    'files_to_create:',
    '  - "enlace.js"',
    '  - "calc.test.js"',
    '---',
    '',
    '# Story fixture — symlink que apunta fuera del repo',
    '',
  ].join('\n'));
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-symlink.md'),
    runTests: () => ({ code: 0 }),
    log: () => {},
  });
  assert.equal(r.exitCode, 2, 'un target que resuelve fuera del repo es exit 2, nunca se muta');
  assert.match(r.result.motivo || '', /fuera del repo/i, 'el motivo dice que el target resuelve afuera');
  assert.equal(Buffer.compare(fs.readFileSync(externo), antes), 0, 'el archivo externo quedó byte-idéntico');
});

test('N2b: --files (override explícito) con un target que resuelve fuera del repo → exit 2', async () => {
  const repo = mkRepo();
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-fuera2-'));
  const externo = path.join(fuera, 'externo.js');
  fs.writeFileSync(externo, 'const z = a === b;\n');
  const antes = fs.readFileSync(externo);
  fs.symlinkSync(externo, path.join(repo, 'enlace.js'));
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-con-tests.md'),
    files: ['enlace.js'],
    runTests: () => ({ code: 0 }),
    log: () => {},
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo || '', /fuera del repo/i);
  assert.equal(Buffer.compare(fs.readFileSync(externo), antes), 0, 'el archivo externo quedó byte-idéntico');
});

test('un declarado que no existe en disco queda en skipped con su razón — nunca un crash', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'story-fantasma.md'), [
    '---',
    'story: "MUT-6"',
    'epic: fixtures',
    'status: in-progress',
    'files_to_create:',
    '  - "calc.js"',
    '  - "todavia-no-existe.js"',
    '  - "calc.test.js"',
    '---',
    '',
    '# Story fixture — declara un archivo que todavía no se escribió',
    '',
  ].join('\n'));
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-fantasma.md'),
    runTests: ({ mutant }) => ({ code: mutant ? 1 : 0 }),
    log: () => {},
  });
  assert.equal(r.exitCode, 0, 'un declarado ausente no es un crash ni un veredicto');
  assert.ok(
    r.result.skipped.some((s) => s.file === 'todavia-no-existe.js' && /no existe/i.test(s.reason || '')),
    `el ausente queda declarado en skipped con su razón (skipped: ${JSON.stringify(r.result.skipped)})`
  );
  assert.ok(r.result.total >= 1, 'los declarados que SÍ existen se chequean igual');
});

// ── Cobertura del borde REAL del cableado: defaultInvokeCheck ────────────────
// Renombrar --deadline-ms dejaría la suite verde y
// cada corrida real degradaría a ruido estructural. Este test spawna el CLI de
// verdad (flags, --json, parseo) contra la fixture — si el CLI y el gate
// driftean, esto se pone ROJO.
test('gate E2E con el invoke REAL (defaultInvokeCheck): flags, --json y veredicto de punta a punta', async () => {
  const repo = mkRepo();
  const h = gateHarness();
  const r = runMutationGate({
    marker: { storyId: 'MUT-1', repoPath: repo, storyPath: 'story-con-tests.md' },
    opts: [],
    env: {},
    appendLog: h.appendLog,
    log: h.log,
    maxMutants: 6,
    // SIN invokeCheck: usa defaultInvokeCheck (spawn real de mutation-check.js).
  });
  assert.equal(r.invoked, true);
  assert.equal(r.block, false, 'esPar está testeada — algún mutante muere, no bloquea');
  const g = h.entries['gates.log'][0];
  assert.equal(g.name, 'mutation');
  assert.equal(
    g.status, 'warn-survivors',
    `si esto da 'structural'/'error', el CLI y el gate driftearon (flags/--json): ${JSON.stringify(g)}`
  );
  assert.ok(g.killed >= 1, 'el mutante del código testeado muere DE VERDAD (corrida real)');
  assert.ok(g.survived >= 1, 'nuncaTesteada no tiene test: sus mutantes sobreviven DE VERDAD');
});


// ── El chequeo de mutantes corre sobre una COPIA, no sobre el repo del dev ──────
// Un mutante no es un bug, es código roto a propósito. Si el archivo bajo
// mutación tiene efectos sobre el repo (git, borrar archivos, red), correrlo contra
// el working tree REAL los ejecutaría N veces, con el código deliberadamente roto: un
// mutante que dé vuelta el operador que elige el repo destino puede dejar cosas
// preparadas en el índice del repo de verdad. Por eso se usa una copia descartable (una
// lista de archivos excluidos hay que mantenerla, y el día que falte un nombre vuelve el problema).
// 🔴 Rojo si: el efecto del test aparece en el repo original.
test('los mutantes corren sobre una copia: un efecto del test NO toca el repo original', async () => {
  const repo = mkRepo();
  // el test de la fixture, además de probar, deja un rastro en su cwd — como haría un script que commitea
  fs.appendFileSync(path.join(repo, 'calc.test.js'),
    "\nrequire('fs').writeFileSync(require('path').join(process.cwd(), 'efecto-del-test.txt'), 'toqué el repo');\n");
  sh('git', ['add', '.'], repo);
  sh('git', ['commit', '-q', '-m', 'test con efecto'], repo);
  // y una línea nueva a mutar
  fs.appendFileSync(path.join(repo, 'calc.js'), '\nfunction esMayor(a, b) { return a >= b; }\nmodule.exports.esMayor = esMayor;\n');
  const r = await checker.runMutationCheck({ repo, storyPath: path.join(repo, 'story-con-tests.md'), log: () => {} });
  // (exit 1 es el veredicto normal acá: la línea nueva no tiene test y su mutante sobrevive)
  assert.ok([0, 1].includes(r.exitCode), `corrida completa (result: ${JSON.stringify(r.result).slice(0, 200)})`);
  assert.ok(!fs.existsSync(path.join(repo, 'efecto-del-test.txt')),
    'el efecto del test tiene que caer en la COPIA, no en el repo original');
  assert.ok(r.result && r.result.repoDeTrabajo && r.result.repoDeTrabajo !== repo,
    'el resultado dice sobre qué copia corrió (repoDeTrabajo)');
  assert.ok(!fs.existsSync(r.result.repoDeTrabajo), 'la copia se borra al terminar');
});

test('la copia refleja lo que hay en el working tree (cambios sin commitear incluidos)', async () => {
  const repo = mkRepo();
  // cambio SIN commitear en calc.js: es lo que la story implementó y todavía no commiteó
  fs.appendFileSync(path.join(repo, 'calc.js'), '\nfunction esMayor(a, b) { return a >= b; }\nmodule.exports.esMayor = esMayor;\n');
  const r = await checker.runMutationCheck({ repo, storyPath: path.join(repo, 'story-con-tests.md'), log: () => {} });
  assert.ok([0, 1].includes(r.exitCode));
  assert.ok(r.result.survived.some((m) => m.before.includes('a >= b')),
    'el mutante de la línea sin commitear existe: la copia tenía el cambio del working tree');
});
