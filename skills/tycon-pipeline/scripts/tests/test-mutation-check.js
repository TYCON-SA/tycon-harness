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
const { runMutationGate, destinosDeLaStory } = require(path.join(SCRIPTS, 'lib', 'mutation-gate.js'));

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
  assert.doesNotMatch(texto, /--no-mutation|TYCON_MUTATION_CHECK/, 'el cartel no le dicta al agente cómo saltearlo');
  assert.match(texto, /lo decide la persona/, 'dice de quién es la decisión de saltearlo');
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

// Dos repos de juguete: `Specs` con la story y `Code`, su hermano declarado, con el código y la prueba que declara
function storyEnOtroRepo({ codigoAca = false } = {}) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mut-hermano-')));
  const repo = (dir, archivos) => {
    for (const [rel, texto] of Object.entries(archivos)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), texto);
    }
    const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('add', '-A'); g('-c', 'user.email=l@l', '-c', 'user.name=l', 'commit', '-q', '-m', 'base');
    return dir;
  };
  const crear = ['src/calc.js', 'tests/calc.test.js', ...(codigoAca ? ['lib/propio.js'] : [])];
  const story = ['---', 'story: "9.1"', 'files_to_create:', ...crear.map((f) => `  - ${f}`), '---', '', '# Story 9.1', ''].join('\n');
  const specs = repo(path.join(raiz, 'Specs'), { 'specs/s.md': story, '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - ../Code\n',
    ...(codigoAca ? { 'lib/propio.js': 'module.exports = 1;\n' } : {}) });
  const code = repo(path.join(raiz, 'Code'), { 'src/calc.js': 'module.exports = (a) => a === 1;\n', 'tests/calc.test.js': 'require("../src/calc.js");\n' });
  return { specs, code, story: path.join(specs, 'specs', 's.md') };
}

test('gate: la story en un repo y el código en su hermano → mide en el hermano, no en el de la story', async () => {
  const lab = storyEnOtroRepo();
  assert.deepEqual(destinosDeLaStory(lab.specs, lab.story, () => {}).map((d) => fs.realpathSync(d)), [lab.code]);
  const h = gateHarness();
  const repos = [];
  const r = runMutationGate({
    marker: { storyId: '9.1', repoPath: lab.specs, storyPath: lab.story }, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: ({ repo }) => { repos.push(fs.realpathSync(repo)); return { code: 0, result: { total: 3, killed: 3, survived: [], skipped: [], verdict: 'OK' } }; },
  });
  assert.equal(r.block, false);
  assert.deepEqual(repos, [lab.code], 'el chequeo corre en el repo del código');
  const g = h.entries['gates.log'];
  assert.equal(g.length, 1);
  assert.equal(fs.realpathSync(g[0].repo), lab.code, 'el veredicto dice en qué repo se midió');
  // la story que además declara código propio se mide en los dos; frena si frena cualquiera
  const lab2 = storyEnOtroRepo({ codigoAca: true });
  assert.deepEqual(destinosDeLaStory(lab2.specs, lab2.story, () => {}).map((d) => fs.realpathSync(d)), [lab2.specs, lab2.code]);
  const h2 = gateHarness();
  const r2 = runMutationGate({
    marker: { storyId: '9.1', repoPath: lab2.specs, storyPath: lab2.story }, opts: [], env: {},
    appendLog: h2.appendLog, log: h2.log,
    invokeCheck: ({ repo }) => (fs.realpathSync(repo) === lab2.code
      ? { code: 1, result: { total: 2, killed: 0, survived: SOBREVIVIENTES, skipped: [], verdict: 'TESTS_NO_EJERCEN_EL_CODIGO' } }
      : { code: 0, result: { total: 1, killed: 1, survived: [], skipped: [], verdict: 'OK' } }),
  });
  assert.equal(r2.block, true, 'cero muertos en el hermano frena aunque el de la story pase');
  assert.deepEqual(h2.entries['gates.log'].map((e) => e.status), ['pass', 'blocked']);
});

test('gate: sin hermanos, con un hermano que no existe o sin poder leerlos → mide el de la story y lo dice', async () => {
  const lab = storyEnOtroRepo();
  const avisos = [];
  // sin hermanos declarados: el de la story
  fs.rmSync(path.join(lab.specs, '.tycon'), { recursive: true });
  assert.deepEqual(destinosDeLaStory(lab.specs, lab.story, (t) => avisos.push(t)), [lab.specs]);
  assert.deepEqual(avisos, []);
  // un hermano declarado que no está en disco: se dice
  fs.mkdirSync(path.join(lab.specs, '.tycon'));
  fs.writeFileSync(path.join(lab.specs, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - ../NoExiste\n');
  assert.deepEqual(destinosDeLaStory(lab.specs, lab.story, (t) => avisos.push(t)), [lab.specs]);
  assert.match(avisos.join('\n'), /NO MEDIDO en .*NoExiste/);
  // la story ilegible con hermanos declarados: avisa y mide el de la story
  avisos.length = 0;
  fs.writeFileSync(path.join(lab.specs, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - ../Code\n');
  assert.deepEqual(destinosDeLaStory(lab.specs, path.join(lab.specs, 'specs', 'no-existe.md'), (t) => avisos.push(t)), [lab.specs]);
  assert.match(avisos.join('\n'), /no pude leer los repos hermanos/);
});

test('gate: el hermano se mide en el worktree donde la sesión escribió, no en el checkout en main', async () => {
  const lab = storyEnOtroRepo();
  // el puesto: un worktree del hermano en una rama que no nombra la story, con el código nuevo de la story
  const puesto = path.join(path.dirname(lab.code), 'Code--puesto');
  spawnSync('git', ['-C', lab.code, 'worktree', 'add', '-q', '-b', 'wt/otra', puesto], { encoding: 'utf8' });
  fs.writeFileSync(path.join(puesto, 'src', 'nuevo.js'), 'module.exports = 2;\n');
  const tocados = [path.join(puesto, 'src', 'nuevo.js'), path.join(lab.specs, 'specs', 's.md'), '/tmp/una-prueba-suelta.js'];
  assert.deepEqual(destinosDeLaStory(lab.specs, lab.story, () => {}, tocados), [fs.realpathSync(puesto)]);
  // sin archivos tocados, el que elige companion-repos
  assert.deepEqual(destinosDeLaStory(lab.specs, lab.story, () => {}, []).map((d) => fs.realpathSync(d)), [lab.code]);
  // un archivo declarado que no existe en ningún lado no vuelve «de acá» al repo de la story
  fs.writeFileSync(lab.story, fs.readFileSync(lab.story, 'utf8').replace('files_to_create:\n', 'files_to_create:\n  - lib/todavia-no.js\n'));
  assert.deepEqual(destinosDeLaStory(lab.specs, lab.story, () => {}, tocados), [fs.realpathSync(puesto)]);
});

test('gate: con varios repos, un «no medido» en uno no queda tapado por el que pasó', async () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {}, appendLog: h.appendLog, log: h.log,
    destinosDe: () => ['/tmp/uno', '/tmp/dos'],
    invokeCheck: ({ repo }) => (repo === '/tmp/uno'
      ? { code: 0, result: { total: 1, killed: 1, survived: [], skipped: [], verdict: 'OK' } }
      : { code: 2, result: { motivo: 'la story declara tests que NO existen en disco' } }),
  });
  assert.deepEqual([r.block, r.reason], [false, 'estructural']);
  assert.deepEqual(h.entries['gates.log'].map((e) => [e.repo, e.status]), [['/tmp/uno', 'pass'], ['/tmp/dos', 'structural']]);
});

test('gate: lo que no se pudo medir lo dice como «NO MEDIDO», con el repo', async () => {
  const h = gateHarness();
  runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {}, appendLog: h.appendLog, log: h.log,
    invokeCheck: () => ({ code: 2, result: { motivo: 'la story declara tests que NO existen en disco' } }),
  });
  assert.match(h.lines.join('\n'), /NO MEDIDO en \/tmp\/fake-repo/);
});

test('gate: TYCON_MUTATION_CHECK=off → ni se invoca, y el apagado queda en bypass.log', async () => {
  const h = gateHarness();
  let llamadas = 0;
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: { TYCON_MUTATION_CHECK: 'off' },
    appendLog: h.appendLog, log: h.log, today: new Date('2099-01-01T00:00:00Z'),
    invokeCheck: () => { llamadas += 1; return { code: 0, result: {} }; },
  });
  assert.equal(llamadas, 0, 'apagado global: el chequeo NI se invoca');
  assert.equal(r.block, false);
  assert.equal(h.entries['gates.log'].length, 0);
  assert.equal(h.entries['bypass.log'].length, 1, 'el apagado no es silencioso: la noche lo cuenta');
  assert.equal(h.entries['bypass.log'][0].kind, 'MUTATION_CHECK_OFF');
  assert.equal(h.lines.length, 0, 'desde la fecha de corte no suma un aviso en la consola (lo pide el freno con la firma)');
  // antes de la fecha de corte de la lista única de interruptores: el agente lee el aviso, una sola línea, con la fecha
  const h2 = gateHarness();
  runMutationGate({ marker: MARKER_FAKE, opts: [], env: { TYCON_MUTATION_CHECK: 'off' }, appendLog: h2.appendLog, log: h2.log,
    today: new Date('2026-11-01T00:00:00Z'), invokeCheck: () => ({ code: 0, result: {} }) });
  assert.equal(h2.lines.length, 1);
  assert.match(h2.lines[0], /esto pide la firma de una persona/);
});

test('gate: TYCON_MUTATION_CHECK=OFF (mayúsculas) apaga igual, como lo cuenta la noche', async () => {
  const h = gateHarness();
  let llamadas = 0;
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: { TYCON_MUTATION_CHECK: 'OFF' },
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => { llamadas += 1; return { code: 0, result: {} }; },
  });
  assert.equal(llamadas, 0);
  assert.equal(r.reason, 'off');
  assert.equal(h.entries['bypass.log'][0].kind, 'MUTATION_CHECK_OFF');
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
// El chequeo elige la receta del paquete (casos: test-mutation-runners.js). Un `.ts` sin Jest ni Vitest
// no tiene receta: sigue siendo exit 2 estructural honesto, y el motivo dice que no encontró receta.
test('N3a: test declarado .ts sin receta → exit 2 estructural honesto («no encontré una receta»), sin correr nada', async () => {
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
  assert.match(r.result.motivo || '', /no encontré una receta de pruebas/, 'el motivo dice que no hay receta para esa prueba');
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
  // .NET tiene receta sólo con un `.csproj` de pruebas: sin él, el motivo dice que no hay receta.
  fs.mkdirSync(path.join(repo, 'apinetcore', 'Api.Tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'apinetcore', 'Api.Tests', 'CalcTests.cs'), 'public class CalcTests {}\n');
  const r = await checker.runMutationCheck({
    repo,
    storyPath: path.join(repo, 'story-dotnet.md'),
    runTests: () => { throw new Error('no debería llegar a correr nada'); },
    log: () => {},
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo || '', /no encontré una receta de pruebas para apinetcore\/Api\.Tests\/CalcTests\.cs/, 'dice que no hay receta, y para cuál');
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

// ── Lo commiteado durante la corrida también se muta ───────────────────────────────────────────────
// Las líneas a mutar salían de `git diff HEAD`: con la implementación ya commiteada no quedaba ninguna, y el chequeo
// decía «no se verificó nada». Se miden contra la base de la corrida (lib/coverage-base.js).

function repoCommiteado() {
  const repo = mkRepo();
  const base = sh('git', ['rev-parse', 'HEAD'], repo).trim();
  sh('git', ['add', '.'], repo);
  sh('git', ['commit', '-q', '-m', 'trabajo de la corrida'], repo);
  return { repo, base };
}

// Una historia de dos tandas con una prueba que todavía no existe porque es de la segunda; `estado` es el de esa tanda.
function storyConTandaB(repo, estado) {
  const p = path.join(repo, `story-tanda-${estado}.md`);
  fs.writeFileSync(p, [
    '---', 'story: "MUT-2"', 'epic: fixtures', 'status: in-progress',
    'files_to_create:', '  - "calc.js"', '  - "calc.test.js"', '  - "split.test.js"  # tanda B',
    'pipelines:', '  - name: A-calc', '    status: in-progress', '    acs: [1]',
    '  - name: B-split', `    status: ${estado}`, '    acs_pending: [2]',
    '---', '', '# Story fixture — una prueba de una tanda estacionada', '',
  ].join('\n'));
  return p;
}

test('una prueba declarada de una tanda estacionada que todavía no existe no deja sin medir a las otras', async () => {
  // 🔴 mutación: sin mirar las tandas (lo de antes) → «declara tests que NO existen» y sale 2; aceptar una tanda que no
  //    está estacionada → la prueba que falta de verdad deja de frenar.
  const repo = mkRepo();
  const corridos = [];
  const r = await checker.runMutationCheck({
    repo, storyPath: storyConTandaB(repo, 'blocked'),
    runTests: ({ mutant, testFiles }) => { corridos.push(...(testFiles || [])); return { code: mutant ? 1 : 0 }; }, log: () => {},
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r.result));
  assert.deepEqual(r.result.testsDeTandaBloqueada, [{ file: 'split.test.js', tandas: ['B-split'] }]);
  assert.ok(r.result.total >= 1, `muta lo de la tanda que se entrega (total=${r.result.total})`);
  assert.ok(!corridos.some((f) => /split\.test\.js/.test(f)), `no corre la que no existe: ${corridos}`);
  const activa = await checker.runMutationCheck({
    repo, storyPath: storyConTandaB(repo, 'in-progress'), runTests: () => ({ code: 0 }), log: () => {},
  });
  assert.equal(activa.exitCode, 2);
  assert.match(activa.result.motivo, /declara tests que NO existen en disco: .*split\.test\.js/);
});

test('con el trabajo commiteado, muta contra la base del marcador, no contra HEAD', async () => {
  const { repo, base } = repoCommiteado();
  const r = await checker.runMutationCheck({
    repo, storyPath: path.join(repo, 'story-con-tests.md'),
    marker: { baseSha: base, repoPath: repo },
    runTests: ({ mutant }) => ({ code: mutant ? 1 : 0 }), log: () => {},
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r.result));
  assert.ok(r.result.total >= 1, `con la base de la corrida hay líneas que mutar (total=${r.result.total})`);
});

test('con el trabajo commiteado y sin marcador, muta lo posterior a la bifurcación con la rama principal', async () => {
  const { repo, base } = repoCommiteado();
  sh('git', ['update-ref', 'refs/remotes/origin/main', base], repo);
  const r = await checker.runMutationCheck({
    repo, storyPath: path.join(repo, 'story-con-tests.md'),
    runTests: ({ mutant }) => ({ code: mutant ? 1 : 0 }), log: () => {},
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r.result));
  assert.ok(r.result.total >= 1, `lo de la rama se muta (total=${r.result.total})`);
});

test('un marcador que no se pudo leer se dice en el registro y la base queda en el resultado', async () => {
  const { repo, base } = repoCommiteado();
  sh('git', ['update-ref', 'refs/remotes/origin/main', base], repo);
  const lineas = [];
  const r = await checker.runMutationCheck({
    repo, storyPath: path.join(repo, 'story-con-tests.md'), markerError: 'marker.js get salió 1',
    runTests: ({ mutant }) => ({ code: mutant ? 1 : 0 }), log: (...a) => lineas.push(a.join(' ')),
  });
  assert.ok(lineas.some((l) => /base descartada \(marcador\).*marker\.js get salió 1/.test(l)), lineas.join('\n'));
  assert.equal(r.result.base.fuente, 'bifurcacion');
  assert.equal(r.result.base.ref, base);
});

// ── Topes medidos ────────────────────────────────────────────────────────────
// Un registro de tiempos de juguete: la suite `tests/lenta.test.js` tardó `ms` en cada corrida.
const corridas = (ms, s = 'tests/lenta.test.js') => [1, 2, 3].map((i) => ({ ts: `2026-11-1${i}T00:00:00Z`, suites: [{ s, ms }] }));
const MIN = 60000;

test('@story-8.279 @ac-12 T8 Mutation_CapsFromMeasuredTime', () => {
  const suite = ['skills/x/scripts/tests/lenta.test.js'];
  // 5 min medidos y 12 mutantes: 7,5 por corrida; el total (7,5 × 13) topa en 20
  const a = checker.topesMedidos({ suites: suite, mutantes: 12, runs: corridas(5 * MIN), presupuesto: checker.BUDGETS.default });
  assert.deepEqual(a, { perRunMs: 7.5 * MIN, totalMs: 20 * MIN, medidoMs: 5 * MIN });
  // 40 s y 2 mutantes: 60 s por corrida sube al piso de 2 min; el total, 2 × 3 = 6 min
  const b = checker.topesMedidos({ suites: suite, mutantes: 2, runs: corridas(40000), presupuesto: checker.BUDGETS.default });
  assert.deepEqual(b, { perRunMs: 2 * MIN, totalMs: 6 * MIN, medidoMs: 40000 });
  // 30 min medidos: el tope por corrida topa en 10
  assert.equal(checker.topesMedidos({ suites: suite, mutantes: 1, runs: corridas(30 * MIN), presupuesto: checker.BUDGETS.default }).perRunMs, 10 * MIN);
  // con varias suites, la más lenta
  const dos = [...corridas(MIN, 'tests/rapida.test.js'), ...corridas(3 * MIN)];
  assert.equal(checker.topesMedidos({ suites: ['a/tests/rapida.test.js', ...suite], mutantes: 1, runs: dos, presupuesto: checker.BUDGETS.default }).medidoMs, 3 * MIN);
  // la red del portón queda arriba del total más largo posible, con margen: si alguien sube un techo sin la red, salta
  const gate = require(path.join(SCRIPTS, 'lib', 'mutation-gate.js'));
  const mayor = Math.max(checker.MEASURED_TOTAL_CEIL_MS, ...Object.values(checker.BUDGETS).map((b2) => b2.totalMs));
  assert.ok(gate.HARD_TIMEOUT_MS >= mayor + MIN, `HARD_TIMEOUT_MS=${gate.HARD_TIMEOUT_MS} y el total más largo es ${mayor}`);
});

test('@story-8.279 @ac-13 @ac-14 T8 Mutation_NoMeasure_CapsAsToday', async () => {
  const suite = ['skills/x/scripts/tests/lenta.test.js'];
  assert.equal(checker.topesMedidos({ suites: suite, mutantes: 12, runs: [], presupuesto: checker.BUDGETS.default }), null, 'sin registro, los de hoy');
  assert.equal(checker.topesMedidos({ suites: [...suite, 'b/tests/sin-medida.test.js'], mutantes: 12, runs: corridas(5 * MIN), presupuesto: checker.BUDGETS.default }), null,
    'una suite sin medida: los de hoy');
  // los topes de hoy, de punta a punta: lo que recibe la corrida base
  const repo = mkRepo();
  const topes = [];
  await checker.runMutationCheck({
    repo, storyPath: path.join(repo, 'story-con-tests.md'), suiteRuns: [], log: () => {},
    runTests: ({ mutant, capMs }) => { if (!mutant) topes.push(capMs); return { code: mutant ? 1 : 0 }; },
  });
  assert.equal(topes[0], checker.BUDGETS.default.perRunMs);
  // la base que pasa del tope: «no medido» con el tope en minutos y el tiempo medido
  const lento = mkRepo();
  let t = 0;
  const r = await checker.runMutationCheck({
    repo: lento, storyPath: path.join(lento, 'story-con-tests.md'), suiteRuns: [], log: () => {}, now: () => t,
    runTests: ({ capMs }) => { t += capMs; return { code: 1, timedOut: true }; },
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo, /^no medido: la corrida base tardó más que el tope de 2 min \(medido: 120 s\)/);
});

// ── Sólo las pruebas de la historia ──────────────────────────────────────────
const CALC_MARCAS = "'use strict';\nfunction esPar(n) { return n % 2 === 0; }\nmodule.exports = { esPar };\n";
/** Un repo con calc.js nuevo, su prueba (`prueba`) y una historia 9.1 que los declara. */
function repoConMarcas(prueba) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mutmarca-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'test@tycon.local'], dir);
  sh('git', ['config', 'user.name', 'tycon-test'], dir);
  sh('git', ['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'calc.js'), "'use strict';\n");
  sh('git', ['add', '.'], dir);
  sh('git', ['commit', '-q', '-m', 'base'], dir);
  fs.writeFileSync(path.join(dir, 'calc.js'), CALC_MARCAS);
  fs.writeFileSync(path.join(dir, 'calc.test.js'), prueba);
  fs.writeFileSync(path.join(dir, 'story.md'), '---\nstory: "9.1"\nfiles_to_modify:\n  - calc.js\n  - calc.test.js\n---\n# fixture\n');
  return dir;
}
const prueba = (nombre, cuerpo = 'assert.equal(esPar(2), true);') => `test(${JSON.stringify(nombre)}, () => { ${cuerpo} });\n`;
const CABECERA = "'use strict';\nconst { test } = require('node:test');\nconst assert = require('node:assert');\nconst { esPar } = require('./calc.js');\n";

test('@story-8.279 @ac-15 T9 Mutation_NodeTest_OnlyStoryTests', async () => {
  const dir = repoConMarcas(CABECERA
    + prueba('T1 par @story-9.1 @ac-1') + prueba('T2 impar @story-9.1', 'assert.equal(esPar(3), false);')
    + prueba('T3 de la 9.12 @story-9.12', 'assert.ok(true);')
    + prueba('otra historia @story-4.2', 'assert.ok(true);') + prueba('sin marca', 'assert.ok(true);'));
  const filtros = [];
  const r = await checker.runMutationCheck({
    repo: dir, storyPath: path.join(dir, 'story.md'), suiteRuns: [], log: () => {},
    runTests: (o) => { filtros.push(o.nameFilter); return checker.defaultRun(o); },
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r.result));
  assert.ok(filtros.length >= 2 && filtros.every((f) => f === filtros[0] && /^@story-9\\\.1/.test(f)), `cada corrida con el filtro: ${filtros}`);
  assert.equal(r.result.baseTests, 2, 'corren sólo las dos de la 9.1: la de 9.12 no');
  assert.ok(r.result.killed >= 1);
  // el filtro anclado, solo: 9.1 no toma 9.12 ni 9.1.3, y sí la marca al final o antes de otra
  const re = new RegExp(checker.storyNamePattern('9.1'));
  for (const n of ['x @story-9.1', 'x @story-9.1 @ac-2', 'x @story-9.1, y']) assert.ok(re.test(n), n);
  for (const n of ['x @story-9.12', 'x @story-9.1.3', 'x @story-9a1']) assert.ok(!re.test(n), n);
});

test('@story-8.279 @ac-16 T9 Mutation_NoStoryTag_WholeFileAsToday', async () => {
  const dir = repoConMarcas(CABECERA + prueba('par') + prueba('impar', 'assert.equal(esPar(3), false);'));
  const filtros = [];
  const lineas = [];
  const r = await checker.runMutationCheck({
    repo: dir, storyPath: path.join(dir, 'story.md'), suiteRuns: [], log: (...a) => lineas.push(a.join(' ')),
    runTests: (o) => { filtros.push(o.nameFilter); return checker.defaultRun(o); },
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r.result));
  assert.ok(filtros.every((f) => !f), 'sin marcas, el archivo entero');
  assert.equal(r.result.baseTests, 2);
  assert.ok(lineas.some((l) => /ninguna prueba con la marca @story-9\.1.*archivo entero/.test(l)), lineas.join('\n'));
});

test('@story-8.279 @ac-17 T10 Mutation_FilterLeavesNoTests_NotGreen', async () => {
  // la marca sólo en un comentario: el filtro aplica y no deja ninguna prueba
  const dir = repoConMarcas(`${CABECERA}// las pruebas de la @story-9.1 viven en otro archivo\n${prueba('par')}`);
  let mutantes = 0;
  const r = await checker.runMutationCheck({
    repo: dir, storyPath: path.join(dir, 'story.md'), suiteRuns: [], log: () => {},
    runTests: (o) => { if (o.mutant) mutantes += 1; return checker.defaultRun(o); },
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo, /^no medido: .*@story-9\.1.*ninguna prueba/);
  assert.equal(mutantes, 0);
});

test('@story-8.279 @ac-12 T8 Mutation_CapsFromMeasuredTime — de punta a punta: la base recibe el tope medido', async () => {
  const repo = mkRepo();
  const topes = [];
  const r = await checker.runMutationCheck({
    repo, storyPath: path.join(repo, 'story-con-tests.md'), log: () => {},
    // la suite declarada `calc.test.js` medida en 3 min: 4,5 por corrida
    suiteRuns: corridas(3 * MIN, 'calc.test.js'),
    runTests: ({ mutant, capMs }) => { if (!mutant) topes.push(capMs); return { code: mutant ? 1 : 0 }; },
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r.result));
  assert.equal(topes[0], 4.5 * MIN, 'la base corre con el tope medido');
  assert.equal(r.result.measuredMs, 3 * MIN);
  // y la base que pasa ese tope dice el tope medido
  const lento = mkRepo();
  let t = 0;
  const rl = await checker.runMutationCheck({
    repo: lento, storyPath: path.join(lento, 'story-con-tests.md'), log: () => {}, now: () => t,
    suiteRuns: corridas(3 * MIN, 'calc.test.js'), runTests: ({ capMs }) => { t += capMs; return { code: 1, timedOut: true }; },
  });
  assert.match(rl.result.motivo, /tope de 4\.5 min \(medido: 270 s\)/);
});

test('@story-8.279 @ac-12 T8 Mutation_CapsFromMeasuredTime — lee el registro de tiempos de la máquina', async () => {
  // sin `suiteRuns`, el chequeo lee <estado>/suite-times.jsonl de la HOME: una HOME de juguete con la suite medida
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mut-home-'));
  const antes = process.env.HOME;
  process.env.HOME = home;
  try {
    const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), 'suite-times.jsonl'), `${corridas(3 * MIN, 'calc.test.js').map((r) => JSON.stringify({ v: 1, origen: 'gate', ...r })).join('\n')}\n{ roto\n`);
    const repo = mkRepo();
    const topes = [];
    const lineas = [];
    await checker.runMutationCheck({
      repo, storyPath: path.join(repo, 'story-con-tests.md'), log: (...a) => lineas.push(a.join(' ')),
      runTests: ({ mutant, capMs }) => { if (!mutant) topes.push(capMs); return { code: mutant ? 1 : 0 }; },
    });
    assert.equal(topes[0], 4.5 * MIN, 'la base corre con el tope medido del registro');
    assert.ok(lineas.some((l) => /renglón\(es\) del registro de tiempos no se dejan leer/.test(l)), lineas.join('\n'));
  } finally {
    process.env.HOME = antes;
  }
});

test('@story-8.279 @ac-15 T9 Mutation_NodeTest_OnlyStoryTests — la base roja se compara con el original con el mismo filtro', async () => {
  const dir = repoConMarcas(CABECERA + prueba('T1 par @story-9.1'));
  const llamadas = [];
  await checker.runMutationCheck({
    repo: dir, storyPath: path.join(dir, 'story.md'), suiteRuns: [], log: () => {},
    runTests: (o) => { llamadas.push({ repo: o.repo, nameFilter: o.nameFilter }); return { code: 1, tests: 1 }; },
  });
  assert.equal(llamadas.length, 2, 'la base en la copia y la misma corrida en el original');
  assert.ok(llamadas.every((l) => l.nameFilter && l.nameFilter === llamadas[0].nameFilter), JSON.stringify(llamadas));
});

test('@story-8.279 @ac-15 T9 Mutation_NodeTest_OnlyStoryTests — el mutante que rompe la carga del archivo es cazado, con el filtro', async () => {
  // el código nuevo tira al cargar si el mutante da vuelta la condición: el archivo de prueba no llega a correr ninguna
  const dir = repoConMarcas(CABECERA + prueba('T1 par @story-9.1'));
  fs.writeFileSync(path.join(dir, 'calc.js'), `${CALC_MARCAS}const LIMITE = 10;\nif (LIMITE === 3) throw new Error('límite');\n`);
  const r = await checker.runMutationCheck({ repo: dir, storyPath: path.join(dir, 'story.md'), suiteRuns: [], log: () => {} });
  assert.equal(r.exitCode, 0, JSON.stringify(r.result));
  assert.ok(r.result.killed >= 2, `el que rompe la carga cuenta como cazado: ${JSON.stringify(r.result)}`);
  assert.ok(!r.result.skipped.some((s) => /no corrió ninguna prueba/.test(s.reason || '')), JSON.stringify(r.result.skipped));
});

test('@story-8.279 @ac-17 T10 Mutation_FilterLeavesNoTests_NotGreen — también con «#» en la ruta y con el resultado ilegible', async () => {
  // el reportero TAP escapa «#» y «\» en el nombre del archivo: el renglón del archivo sin pruebas se descuenta igual
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mut#marca-'));
  const dir = path.join(base, 'repo#1');
  fs.mkdirSync(dir);
  const t = path.join(dir, 'c.test.js');
  fs.writeFileSync(t, `${CABECERA}// la marca @story-9.1 sólo en un comentario\n${prueba('par')}`);
  fs.writeFileSync(path.join(dir, 'calc.js'), CALC_MARCAS);
  const corrida = await checker.defaultRunTests({ repo: dir, testFiles: [t], nameFilter: checker.storyNamePattern('9.1') });
  assert.equal(corrida.tests, 0, 'el renglón escapado del archivo no cuenta como prueba');
  // con el filtro, una base cuyo resultado no dice cuántas corrieron tampoco es verde
  const d2 = repoConMarcas(CABECERA + prueba('T1 par @story-9.1'));
  let mutantes = 0;
  const r = await checker.runMutationCheck({
    repo: d2, storyPath: path.join(d2, 'story.md'), suiteRuns: [], log: () => {},
    runTests: ({ mutant }) => { if (mutant) mutantes += 1; return { code: 0, tests: null }; },
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo, /^no medido: .*no dice cuántas pruebas corrieron/);
  assert.equal(mutantes, 0);
});

test('un git diff que falla contra la base no se lee como «nada agregado»: devuelve null, no []', () => {
  const { repo, base } = repoCommiteado();
  assert.equal(checker.addedLinesOf(repo, 'calc.js', 'f'.repeat(40)), null);
  assert.ok(checker.addedLinesOf(repo, 'calc.js', base).length > 0);
  assert.deepEqual(checker.addedLinesOf(repo, 'calc.js', 'HEAD'), []);
});

// 🔴 El caso (un producto .NET con su frontend, 13 y 16/11): la historia vive en el backend y declara código y pruebas
// de los dos repos. El chequeo le pasaba a cada repo la lista entera: en el backend buscaba las pruebas del frontend,
// no las encontraba y salía «la story declara tests que NO existen» sin mutar nada; en el frontend, al revés. El
// control no medía en ninguno, y el motivo acusaba a la historia. Ahora cada repo toma sólo lo suyo.
function historiaEnDosRepos() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mut-dos-repos-')));
  const repo = (dir, base, nuevos) => {
    const escribir = (archivos) => {
      for (const [rel, texto] of Object.entries(archivos)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), texto);
      }
    };
    escribir(base);
    const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('add', '-A'); g('-c', 'user.email=l@l', '-c', 'user.name=l', 'commit', '-q', '-m', 'base');
    escribir(nuevos);
    return dir;
  };
  const prueba = (modulo, fn) => [
    "'use strict';", "const { test } = require('node:test');", "const assert = require('node:assert');",
    `const { ${fn} } = require('${modulo}');`,
    `test('${fn}', () => { assert.equal(${fn}(100), true); assert.equal(${fn}(101), false); });`, '',
  ].join('\n');
  const declarados = ['src/limite.js', 'tests/limite.test.js', 'web/tope.js', 'web/__tests__/tope.test.js'];
  const historia = ['---', 'story: "9.2"', 'files_to_create:', ...declarados.map((f) => `  - "${f}"`), '---', '', '# Story 9.2', ''].join('\n');
  const back = repo(path.join(raiz, 'Back'), { '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - ../Front\n', 'specs/s.md': historia }, {
    'src/limite.js': 'exports.permitido = (m) => m <= 100;\n', 'tests/limite.test.js': prueba('../src/limite.js', 'permitido'),
  });
  const front = repo(path.join(raiz, 'Front'), { 'web/.keep': '' }, {
    'web/tope.js': 'exports.dentro = (m) => m <= 100;\n', 'web/__tests__/tope.test.js': prueba('../tope.js', 'dentro'),
  });
  return { back, front, story: path.join(back, 'specs', 's.md') };
}

test('dos repos: cada uno se mide con lo suyo, y en los dos mueren los mutantes', () => {
  const lab = historiaEnDosRepos();
  for (const [quien, repo] of [['el de la historia', lab.back], ['el hermano', lab.front]]) {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'mutation-check.js'), '--repo', repo, '--story', lab.story, '--json'], { encoding: 'utf8' });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { j = null; }
    assert.equal(r.status, 0, `${quien}: ${(j && j.motivo) || r.stderr}`);
    assert.ok(j.total > 0 && j.killed === j.total, `${quien}: midió y mató sus mutantes (${JSON.stringify(j && { total: j.total, killed: j.killed })})`);
  }
});

test('dos repos: una prueba del hermano que todavía no existe no se le pide al repo de la historia', () => {
  const lab = historiaEnDosRepos();
  fs.rmSync(path.join(lab.front, 'web', '__tests__', 'tope.test.js'));
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'mutation-check.js'), '--repo', lab.back, '--story', lab.story, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { declaredFor } = require(path.join(SCRIPTS, 'lib', 'companion-repos.js'));
  // la del hermano que falta se ubica por su carpeta, que sí existe allá
  assert.deepEqual(declaredFor(lab.back, lab.story, lab.front), ['web/tope.js', 'web/__tests__/tope.test.js']);
  assert.deepEqual(declaredFor(lab.back, lab.story, lab.back), ['src/limite.js', 'tests/limite.test.js']);
});

// Cero mutantes no es un verde: el portón lo anotaba como «pass» y no decía nada.
test('gate: SIN_MUTANTES avisa «NO MEDIDO» con el motivo y deja pasar', () => {
  const h = gateHarness();
  const r = runMutationGate({
    marker: MARKER_FAKE, opts: [], env: {},
    appendLog: h.appendLog, log: h.log,
    invokeCheck: () => ({ code: 0, result: { total: 0, killed: 0, survived: [], skipped: [], verdict: 'SIN_MUTANTES', runner: 'dotnet',
      motivo: 'ningún operador aplica sobre las líneas agregadas de los archivos que la story declara' } }),
  });
  assert.equal(r.block, false);
  assert.match(h.lines.join('\n'), /NO MEDIDO .*ningún operador aplica/);
  assert.deepEqual(h.entries['gates.log'].map((e) => e.status), ['warn-no-mutants']);
});

// Lo encontró el pase adversarial: formas de dos y tres repos en que todavía no medía, y un motivo engañoso.
const correrChequeo = (repo, story) => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'mutation-check.js'), '--repo', repo, '--story', story, '--json'], { encoding: 'utf8' });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { j = null; }
  return { status: r.status, j, salida: `${(j && j.motivo) || ''} ${r.stderr}` };
};

test('dos repos: el hermano medido desde otra copia suya (un worktree) se mide con lo suyo', () => {
  const lab = historiaEnDosRepos();
  const otra = path.join(path.dirname(lab.front), 'Front--puesto');
  spawnSync('git', ['-C', lab.front, 'worktree', 'add', '-q', '-b', 'wt/otra', otra], { encoding: 'utf8' });
  for (const rel of ['web/tope.js', 'web/__tests__/tope.test.js']) {
    fs.mkdirSync(path.dirname(path.join(otra, rel)), { recursive: true });
    fs.copyFileSync(path.join(lab.front, rel), path.join(otra, rel));
  }
  const r = correrChequeo(otra, lab.story);
  assert.equal(r.status, 0, r.salida);
  assert.ok(r.j.total > 0 && r.j.killed === r.j.total);
});

test('tres repos: la story en un repo de historias sin hermanos, y el backend declara el frontend', () => {
  const lab = historiaEnDosRepos();
  // la story se muda a un tercer repo que no declara hermanos; los archivos llevan el nombre del repo adelante
  const specs = path.join(path.dirname(lab.back), 'Specs');
  fs.mkdirSync(path.join(specs, 'specs'), { recursive: true });
  const texto = fs.readFileSync(lab.story, 'utf8').replace(/"src\//g, '"Back/src/').replace(/"tests\//g, '"Back/tests/').replace(/"web\//g, '"Front/web/');
  fs.writeFileSync(path.join(specs, 'specs', 's.md'), texto);
  spawnSync('git', ['-C', specs, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  spawnSync('git', ['-C', specs, 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', specs, '-c', 'user.email=l@l', '-c', 'user.name=l', 'commit', '-q', '-m', 'b'], { encoding: 'utf8' });
  for (const repo of [lab.back, lab.front]) {
    const r = correrChequeo(repo, path.join(specs, 'specs', 's.md'));
    assert.equal(r.status, 0, `${path.basename(repo)}: ${r.salida}`);
    assert.ok(r.j.total > 0 && r.j.killed === r.j.total);
  }
});

test('dos repos: la forma «(<repo>) <ruta>» se lee como del repo que nombra', () => {
  const lab = historiaEnDosRepos();
  fs.writeFileSync(lab.story, fs.readFileSync(lab.story, 'utf8').replace(/"web\//g, '"(Front) web/'));
  const { declaredFor } = require(path.join(SCRIPTS, 'lib', 'companion-repos.js'));
  assert.deepEqual(declaredFor(lab.back, lab.story, lab.front), ['web/tope.js', 'web/__tests__/tope.test.js']);
  assert.deepEqual(declaredFor(lab.back, lab.story, lab.back), ['src/limite.js', 'tests/limite.test.js']);
});

test('dos repos: un repo sin pruebas propias dice que son de otro repo, no que no hay', () => {
  const lab = historiaEnDosRepos();
  // el frontend queda sólo con código: sus pruebas se declaran en el backend
  fs.writeFileSync(lab.story, fs.readFileSync(lab.story, 'utf8').replace('  - "web/__tests__/tope.test.js"\n', ''));
  const r = correrChequeo(lab.front, lab.story);
  assert.equal(r.status, 2);
  assert.match(r.salida, /las pruebas que la story declara son de otro repo/);
  assert.doesNotMatch(r.salida, /no declara ningún archivo de test/);
});

// 🔴 Falla con: un git que no termina (un `git apply` colgado, sin consumir CPU) dejaba «Correr las pruebas» parado sin
//    límite: la copia de trabajo se armaba con execFileSync sin tope. Ahora cada llamada a git tiene su tope, y al vencer
//    la copia no se arma y el chequeo sale «no medido» con el motivo.
test('CopiaDeTrabajo_GitColgado_NoMedidoConMotivo — un git que no termina se corta a su tope y dice por qué', () => {
  const repo = mkRepo();
  // un git de juguete: se queda dormido en `apply`; lo demás lo hace el git de verdad
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mutcheck-git-'));
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = apply ] && exec sleep 300; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const guion = `const c = require(${JSON.stringify(path.join(SCRIPTS, 'mutation-check.js'))}).crearCopiaDeTrabajo(${JSON.stringify(repo)}, () => {}, { topeMs: 1500 });
process.stdout.write(JSON.stringify({ dir: c.dir, motivo: c.motivo }));`;
  const inicio = Date.now();
  const r = spawnSync(process.execPath, ['-e', guion], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.notEqual(r.signal, 'SIGTERM', `la copia quedó colgada más de 30 s (${r.stderr})`);
  const c = JSON.parse(r.stdout);
  assert.equal(c.dir, null, 'sin copia');
  assert.match(c.motivo, /git apply no terminó en 1,5 s/);
  assert.ok(Date.now() - inicio < 20000, 'se cortó a su tope');
  // un git que no contesta si el repo tiene commits no se lee como «sin commits» (eso mutaría en el propio repo)
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = rev-parse ] && exec sleep 300; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const s = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(SCRIPTS, 'mutation-check.js'))}).sinCommits(${JSON.stringify(repo)}, 1500)))`],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(s.stdout, 'null', `un rev-parse colgado no es «sin commits» (${s.stderr})`);
  assert.equal(checker.sinCommits(repo), false, 'con git sano, el repo tiene commits');
});

// El chequeo entero con un git de juguete que se duerme cuando `cuando` (un pedazo de shell sobre "$*") da verdadero:
// devuelve lo que devolvió runMutationCheck, o el corte de la prueba si quedó colgado.
function chequeoConGitColgado(repo, cuando) {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mutcheck-git-'));
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif ${cuando}; then exec sleep 300; fi\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const guion = `require(${JSON.stringify(path.join(SCRIPTS, 'mutation-check.js'))}).runMutationCheck({ repo: ${JSON.stringify(repo)},
  storyPath: ${JSON.stringify(path.join(repo, 'story-con-tests.md'))}, log: () => {}, topeGitMs: 1500 })
  .then((r) => process.stdout.write(JSON.stringify({ exitCode: r.exitCode, motivo: r.result && r.result.motivo, skipped: r.result && r.result.skipped })));`;
  const r = spawnSync(process.execPath, ['-e', guion], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TYCON_COVERAGE_BASE: '' } });
  assert.notEqual(r.signal, 'SIGTERM', `el chequeo quedó colgado más de 60 s (${r.stderr})`);
  return JSON.parse(r.stdout);
}

test('Chequeo_GitColgadoAlBuscarLaBase_NoMedido — un merge-base que no termina sale «no medido», no mide contra otra base', () => {
  // la rama se llama main: con otro nombre por defecto (el de la CI) no hay rama principal y el merge-base no corre
  const repo = mkRepo();
  sh('git', ['branch', '-M', 'main'], repo);
  const r = chequeoConGitColgado(repo, 'case "$*" in *merge-base*) true;; *) false;; esac');
  assert.equal(r.exitCode, 2);
  assert.match(r.motivo, /no medido: git merge-base no terminó en 1,5 s y se cortó al buscar la base/);
});

test('Chequeo_ListaDeIgnoradosColgada_NoMedido — la copia no se arma sin dependencias en silencio', () => {
  const r = chequeoConGitColgado(mkRepo(), 'case "$*" in *--ignored*) true;; *) false;; esac');
  assert.equal(r.exitCode, 2);
  assert.match(r.motivo, /git ls-files no terminó en 1,5 s y se cortó/);
});

test('Chequeo_LsFilesColgado_NoMutaElArchivoEntero — un archivo sin respuesta de git se saltea con su motivo', () => {
  const r = chequeoConGitColgado(mkRepo(), 'case "$*" in *"ls-files -- calc.js"*) true;; *) false;; esac');
  const calc = (r.skipped || []).find((x) => x.file === 'calc.js');
  assert.ok(calc, `calc.js no se mide como archivo nuevo entero: ${JSON.stringify(r)}`);
  assert.match(calc.reason, /git ls-files no terminó en 1,5 s y se cortó: sus líneas no se midieron/);
});
