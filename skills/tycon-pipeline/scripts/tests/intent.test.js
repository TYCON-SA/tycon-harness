#!/usr/bin/env node
/**
 * intent.test.js — el lector único de intenciones (`lib/intent.js`).
 *
 * Una intención es un archivo IntentSpec (frontmatter `id`, `status`, `objective`, `outcomes`) con dos secciones
 * propias: las preguntas abiertas y las decisiones reservadas. Lo que no se puede perder:
 *   - cada fila se lee por el nombre de su columna, con vocabularios cerrados que no se normalizan;
 *   - el objeto normalizado se valida contra el esquema oficial de IntentSpec, y las dos secciones propias no lo rompen;
 *   - lo que bloquea sale de la regla escrita, y un problema de forma bloquea siempre (falla cerrada);
 *   - leer dos veces el mismo texto da lo mismo.
 *
 * Todo corre con textos y repos de juguete en una carpeta temporal.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/intent.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const ROOT = path.resolve(SCRIPTS, '..', '..', '..');
const intent = require(path.join(SCRIPTS, 'lib', 'intent.js'));

const QH = '| # | Pregunta | Por qué importa | Quién contesta | Bloquea | Estado | Respuesta | Fuente |';
const RH = '| # | Decisión | Por qué es de una persona | Quién decide | Propuesta del agente | Estado | Respuesta | Fuente |';
const SEP = '|---|---|---|---|---|---|---|---|';

function doc({ fm, preguntas = ['Ninguna.'], reservadas = ['Ninguna.'], extra = [] } = {}) {
  const front = fm || ['id: story-1.1-x', 'status: draft', 'objective: "Buscar por fecha"', 'outcomes:', '  - "Responde rápido"'];
  return ['---', ...front, '---', '', '# Buscar por fecha', '', ...extra,
    '## Preguntas abiertas', '', ...preguntas, '', '## Decisiones reservadas', '', ...reservadas, ''].join('\n');
}
const q = (...cells) => `| ${cells.join(' | ')} |`;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `intent-${p}-`));
const ids = (list) => list.map((b) => b.id);
const problemOf = (r, fila) => r.problemas.filter((p) => p.fila === fila);

test('T1 Intent_ReadsFrontmatterAndRows @story-8.258 @ac-1', () => {
  const texto = doc({
    preguntas: [QH, SEP, q('Q1', '¿Qué fecha?', 'cambia el filtro', 'cliente', 'sí', 'abierta', '', '—')],
    reservadas: [RH, SEP, q('R1', 'Quién ve el reporte', 'son permisos', 'dueño', 'sólo admin', 'abierta', '', '—')],
  });
  const r = intent.readIntent(texto, { raiz: tmp('t1') });
  assert.deepStrictEqual(Object.keys(r).filter((k) => ['frontmatter', 'preguntas', 'reservadas', 'marcas', 'bloqueantes', 'problemas', 'avisos'].includes(k)).sort(),
    ['avisos', 'bloqueantes', 'frontmatter', 'marcas', 'preguntas', 'problemas', 'reservadas']);
  assert.strictEqual(r.frontmatter.id, 'story-1.1-x');
  assert.strictEqual(r.frontmatter.objective, 'Buscar por fecha');
  assert.deepStrictEqual(r.frontmatter.outcomes, ['Responde rápido']);
  assert.strictEqual(r.preguntas.length, 1);
  assert.strictEqual(r.preguntas[0]['#'], 'Q1');
  assert.strictEqual(r.preguntas[0]['Pregunta'], '¿Qué fecha?');
  assert.strictEqual(r.preguntas[0]['Bloquea'], 'sí');
  assert.strictEqual(r.reservadas[0]['Quién decide'], 'dueño');
  assert.strictEqual(r.reservadas[0]['Propuesta del agente'], 'sólo admin');
  assert.deepStrictEqual(r.problemas, []);
});

test('T2 Intent_SchemaRequiredAndEnums @story-8.258 @ac-2', () => {
  const texto = doc({ fm: ['id: x', 'status: hecho', 'outcomes: []', 'edgeCases:', '  - scenario: "sin datos"', 'colorFavorito: azul'] });
  const r = intent.readIntent(texto, { raiz: tmp('t2') });
  const esquema = r.problemas.filter((p) => p.fila === null);
  assert.strictEqual(esquema.length, 4, JSON.stringify(esquema, null, 1));
  assert.ok(esquema.some((p) => /objective/.test(p.mensaje)), 'falta objective');
  assert.ok(esquema.some((p) => /outcomes/.test(p.mensaje)), 'outcomes vacío');
  assert.ok(esquema.some((p) => /status/.test(p.mensaje)), 'status fuera de la lista');
  assert.ok(esquema.some((p) => /expectedBehavior/.test(p.mensaje)), 'edgeCase sin expectedBehavior');
  const avisos = r.avisos.filter((a) => /colorFavorito/.test(a.mensaje));
  assert.strictEqual(avisos.length, 1, 'un campo desconocido es aviso');
  assert.ok(!r.problemas.some((p) => /colorFavorito/.test(p.mensaje)), 'y no problema');
});

test('T3 Intent_QuestionsVocabularies @story-8.258 @ac-3 @ac-5', () => {
  const r = intent.readIntent(doc({
    preguntas: [QH, SEP,
      q('Q1', 'a', 'b', 'c', 'quizás', 'abierta', '', '—'),
      q('Q2', 'a', 'b', 'c', 'no', 'pendiente', '', '—'),
      q('Q3', 'a', 'b', 'c', 'no', 'abierta', '', 'chat:x'),
      q('Q4', 'a', 'b', 'c', 'no', 'supuesta', 'que sí', 'pedido:12'),
      q('Q5', 'a', 'b', 'c', 'no', 'contestada', 'que no', 'pedido:12')],
  }), { raiz: tmp('t3') });
  assert.ok(problemOf(r, 'Q1').some((p) => p.columna === 'Bloquea'), 'Bloquea fuera de vocabulario');
  assert.ok(problemOf(r, 'Q2').some((p) => p.columna === 'Estado'), 'Estado fuera de vocabulario');
  assert.ok(problemOf(r, 'Q3').some((p) => p.columna === 'Fuente'), 'Fuente fuera de vocabulario');
  assert.deepStrictEqual(problemOf(r, 'Q4'), [], 'pedido: en una supuesta vale');
  assert.ok(problemOf(r, 'Q5').some((p) => p.columna === 'Fuente' && /pedido/.test(p.mensaje)), 'pedido: en una contestada no');

  const ninguna = intent.readIntent(doc(), { raiz: tmp('t3b') });
  assert.deepStrictEqual(ninguna.problemas, []);
  assert.deepStrictEqual(ninguna.preguntas, []);

  const conEntrevista = intent.readIntent(doc({ preguntas: ['Entrevista: nivel alto, corrida abc123', '', 'Ninguna.'] }), { raiz: tmp('t3c') });
  assert.deepStrictEqual(conEntrevista.problemas, []);
  assert.deepStrictEqual(conEntrevista.entrevista, { nivel: 'alto', corrida: 'abc123' });
  const otroTexto = intent.readIntent(doc({ preguntas: ['Algo suelto antes.', '', 'Ninguna.'] }), { raiz: tmp('t3d') });
  assert.strictEqual(otroTexto.problemas.length, 1, JSON.stringify(otroTexto.problemas));
});

test('T4 Intent_ReservedVocabularies @story-8.258 @ac-4', () => {
  const r = intent.readIntent(doc({
    reservadas: [RH, SEP,
      q('R1', 'a', 'b', 'c', 'd', 'aprobada', 'sí', 'persona:x'),
      q('R2', 'a', 'b', 'c', 'd', 'tomada', 'sí', 'repo:a.md:1')],
  }), { raiz: tmp('t4') });
  assert.strictEqual(r.problemas.length, 2, JSON.stringify(r.problemas, null, 1));
  assert.ok(problemOf(r, 'R1').some((p) => p.columna === 'Estado'));
  assert.ok(problemOf(r, 'R2').some((p) => p.columna === 'Fuente'));

  const conMotivo = intent.readIntent(doc({ reservadas: ['Ninguna, porque no toca datos ni permisos.'] }), { raiz: tmp('t4b') });
  assert.deepStrictEqual(conMotivo.problemas, []);
  const sinMotivo = intent.readIntent(doc({ reservadas: ['Ninguna, porque .'] }), { raiz: tmp('t4c') });
  assert.strictEqual(sinMotivo.problemas.length, 1);
});

test('T5 Intent_BlockingRule @story-8.258 @ac-5', () => {
  const raiz = tmp('t5');
  fs.writeFileSync(path.join(raiz, 'a.md'), '1\n2\n3\n4\n5\n');
  const texto = doc({
    preguntas: [QH, SEP,
      q('Q1', 'a', 'b', 'c', 'sí', 'abierta', '', '—'),
      q('Q2', 'a', 'b', 'c', 'no', 'supuesta', 'que sí', '—'),
      q('Q3', 'a', 'b', 'c', 'sí', 'encontrada', 'está', 'repo:a.md:3'),
      q('Q4', 'a', 'b', 'c', 'sí', 'contestada', 'que no', 'persona:x'),
      q('Q5', 'a', 'b', 'c', 'sí', 'contestada', 'que no', 'repo:a.md:3'),
      q('Q6', 'a', 'b', 'c', 'sí', 'encontrada', 'está', 'repo:a.md:99'),
      q('Q7', 'a', 'b', 'c', 'sí', 'encontrada', 'está', 'memoria:12')],
    reservadas: [RH, SEP,
      q('R1', 'a', 'b', 'c', 'd', 'abierta', '', '—'),
      q('R2', 'a', 'b', 'c', 'd', 'tomada', 'que sí', 'persona:x')],
  });
  const r = intent.readIntent(texto, { raiz, constancia: () => false });
  assert.deepStrictEqual(ids(r.bloqueantes), ['Q1', 'Q4', 'Q5', 'Q6', 'Q7', 'R1', 'R2']);
  assert.ok(problemOf(r, 'Q5').length > 0, 'Q5: contestada con repo: es problema de forma');
  assert.ok(problemOf(r, 'Q6').some((p) => /a\.md:99/.test(p.mensaje)), 'Q6: la línea no existe');
  for (const id of ['Q4', 'R2']) {
    assert.match(r.bloqueantes.find((b) => b.id === id).motivo, /falta la constancia/, id);
  }

  // Sin la consulta (el lint, la CI) una fila cerrada por persona: se toma por su forma.
  const sinConsulta = intent.readIntent(texto, { raiz });
  assert.deepStrictEqual(ids(sinConsulta.bloqueantes), ['Q1', 'Q5', 'Q6', 'Q7', 'R1']);
  // Con la constancia, tampoco bloquean.
  const conConstancia = intent.readIntent(texto, { raiz, constancia: () => true });
  assert.deepStrictEqual(ids(conConstancia.bloqueantes), ['Q1', 'Q5', 'Q6', 'Q7', 'R1']);
});

test('T6 Intent_FormProblemsBlock_NoNormalizing @story-8.258 @ac-5', () => {
  const casos = [
    ['Bloquea: Si', [QH, SEP, q('Q1', 'a', 'b', 'c', 'Si', 'abierta', '', '—')], 'Q1'],
    ['supuesta con sí', [QH, SEP, q('Q1', 'a', 'b', 'c', 'sí', 'supuesta', 'que sí', '—')], 'Q1'],
    ['id repetido', [QH, SEP, q('Q1', 'a', 'b', 'c', 'no', 'abierta', '', '—'), q('Q1', 'a', 'b', 'c', 'no', 'abierta', '', '—')], 'Q1'],
    ['columna que falta', ['| # | Pregunta | Bloquea | Estado | Respuesta | Fuente |', '|---|---|---|---|---|---|', '| Q1 | a | no | abierta | | — |'], null],
    ['cabecera sola', [QH, SEP], null],
  ];
  for (const [nombre, preguntas, fila] of casos) {
    const r = intent.readIntent(doc({ preguntas }), { raiz: tmp('t6') });
    assert.ok(r.problemas.length > 0, `${nombre}: tiene que ser problema`);
    assert.ok(r.bloqueantes.length > 0, `${nombre}: un problema de forma bloquea`);
    if (fila) assert.ok(r.bloqueantes.some((b) => b.id === fila), `${nombre}: bloquea ${fila}`);
  }
  const si = intent.readIntent(doc({ preguntas: [QH, SEP, q('Q1', 'a', 'b', 'c', 'si', 'abierta', '', '—')] }), { raiz: tmp('t6b') });
  assert.ok(problemOf(si, 'Q1').some((p) => p.columna === 'Bloquea'), '«si» sin tilde no es «sí»');
});

test('T7 Intent_Marks @story-8.258 @ac-6', () => {
  const r = intent.readIntent(doc({
    extra: ['El filtro usa la fecha [falta: Q9] y el orden [falta: Q1].', ''],
    preguntas: [QH, SEP, q('Q1', 'a', 'b', 'c', 'no', 'contestada', 'por alta', 'persona:x')],
  }), { raiz: tmp('t7') });
  assert.deepStrictEqual(r.marcas.map((m) => m.id), ['Q9', 'Q1']);
  assert.strictEqual(r.problemas.filter((p) => /Q9/.test(p.mensaje)).length, 1, 'la marca de una fila que no existe');
  assert.strictEqual(r.avisos.filter((a) => /Q1/.test(a.mensaje) && /vieja/.test(a.mensaje)).length, 1, 'la marca quedó vieja');
});

test('T8 Intent_NoticeDateExported @story-8.258 @ac-21', () => {
  assert.match(intent.INTENT_NOTICE_UNTIL, /^\d{4}-\d{2}-\d{2}$/);
});

test('T9 Intent_SameInput_SameOutput @story-8.258 @ac-1 @ac-5', () => {
  const raiz = tmp('t9');
  fs.writeFileSync(path.join(raiz, 'a.md'), '1\n2\n3\n');
  const texto = doc({
    extra: ['Algo [falta: Q1].', ''],
    preguntas: [QH, SEP, q('Q1', 'a', 'b', 'c', 'sí', 'abierta', '', '—'), q('Q2', 'a', 'b', 'c', 'sí', 'encontrada', 'x', 'repo:a.md:2')],
  });
  assert.deepStrictEqual(intent.readIntent(texto, { raiz }), intent.readIntent(texto, { raiz }));
});

test('T41 Intent_OwnSectionsPassIntentSpecSchema @story-8.258 @ac-2 @ac-34', () => {
  const texto = doc({
    extra: ['## Constraints', '', '- Sin red', '', '## Edge Cases', '', '- **sin datos**: muestra vacío', '- fecha futura -> no filtra', '',
      'El orden depende de [falta: Q1].', ''],
    preguntas: [QH, SEP, q('Q1', '¿Qué orden?', 'cambia la lista', 'cliente', 'no', 'abierta', '', '—')],
  });
  const r = intent.readIntent(texto, { raiz: tmp('t41') });
  assert.deepStrictEqual(r.problemas, [], JSON.stringify(r.problemas, null, 1));
  assert.deepStrictEqual(r.modelo.constraints, ['Sin red']);
  assert.deepStrictEqual(r.modelo.edgeCases, [
    { scenario: 'sin datos', expectedBehavior: 'muestra vacío' },
    { scenario: 'fecha futura', expectedBehavior: 'no filtra' },
  ]);

  // el esquema copiado, con su origen, versión y licencia en el manifiesto y su renglón en el NOTICE
  const schema = JSON.parse(fs.readFileSync(intent.SCHEMA_PATH, 'utf8'));
  assert.strictEqual(schema.$id, 'https://intentspec.org/schema.json');
  assert.ok(fs.readFileSync(path.join(path.dirname(intent.SCHEMA_PATH), 'LICENSE'), 'utf8').includes('MIT License'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'publishing', 'third-party-skills.json'), 'utf8'));
  const target = path.relative(ROOT, path.dirname(intent.SCHEMA_PATH)).split(path.sep).join('/');
  const entry = manifest.derived.find((d) => d.target === target);
  assert.ok(entry, `falta la entrada derived de ${target}`);
  assert.match(entry.based_on.origin, /intentspec/);
  assert.match(`${entry.based_on.path} ${entry.why}`, /1\.2\.0/);
  assert.strictEqual(entry.license, 'MIT');
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8').split('\n');
  const i = notice.findIndex((l) => l.startsWith(`* ${target} `));
  assert.ok(i >= 0, 'falta su renglón en el NOTICE');
  assert.ok(notice.slice(i).some((l) => l.includes('Permission is hereby granted')), 'falta el aviso MIT debajo');
});

// ── Lo que encontraron el pase adversarial y los revisores ──────────────────────────────────────────────────────────

test('Intent_FormRulesNotCoveredBefore @story-8.258 @ac-5', () => {
  const r = intent.readIntent(doc({
    preguntas: [QH, SEP,
      q('Q1', 'a', 'b', 'c', 'no', 'encontrada', 'está', '—'),
      q('Q2', 'a', 'b', 'c', 'no', 'contestada', '', 'persona:x')],
    reservadas: [RH, SEP, q('R1', 'a', 'b', 'c', 'd', 'abierta', '', 'persona:x')],
  }), { raiz: tmp('rev1') });
  assert.ok(problemOf(r, 'Q1').some((p) => p.columna === 'Fuente'), 'encontrada sin repo: ni memoria:');
  assert.ok(problemOf(r, 'Q2').some((p) => p.columna === 'Respuesta'), 'contestada sin respuesta');
  assert.deepStrictEqual(problemOf(r, 'R1'), [], 'una reservada abierta puede nombrar a quién decide');
});

test('Intent_MarkWithoutRow_Blocks @story-8.258 @ac-5 @ac-6', () => {
  for (const id of ['Q9', 'R2']) {
    const r = intent.readIntent(doc({ fm: ['id: x', 'status: approved', 'objective: o', 'outcomes:', '  - "o"'], extra: [`Falta saber [falta: ${id}].`, ''] }), { raiz: tmp('rev2') });
    assert.ok(r.bloqueantes.some((b) => b.id === id), `${id}: un problema de forma bloquea siempre`);
  }
});

test('Intent_TableSeparatorShortDashes_IsNotARow @story-8.258 @ac-3', () => {
  for (const sep of ['|-|-|-|-|-|-|-|-|', '| :-- | :- | -: | :-: | -- | - | - | - |']) {
    const r = intent.readIntent(doc({ preguntas: [QH, sep, q('Q1', 'p', 'w', 'x', 'no', 'abierta', '', '—')] }), { raiz: tmp('rev3') });
    assert.deepStrictEqual(r.problemas, [], `${sep}: ${JSON.stringify(r.problemas)}`);
    assert.deepStrictEqual(r.preguntas.map((f) => f['#']), ['Q1']);
  }
});

test('Intent_YamlNullBoolFloat_AreNotText @story-8.258 @ac-2', () => {
  for (const fm of [['id: x', 'status: draft', 'objective: null', 'outcomes:', '  - "o"'],
    ['id: x', 'status: draft', 'objective: ~', 'outcomes:', '  - "o"'],
    ['id: x', 'status: draft', 'objective: true', 'outcomes:', '  - "o"'],
    ['id: x', 'status: draft', 'objective: o', 'outcomes: [1.5, true]']]) {
    const r = intent.readIntent(doc({ fm }), { raiz: tmp('rev4') });
    assert.ok(r.problemas.some((p) => /objective|outcomes/.test(p.mensaje)), `${fm.join(' / ')}: ${JSON.stringify(r.problemas)}`);
  }
});

test('Intent_RepeatedKeyOrColumn_IsAProblem @story-8.258 @ac-2 @ac-3', () => {
  const clave = intent.readIntent(doc({ fm: ['id: x', 'status: draft', 'objective: o', 'outcomes:', '  - "o"', 'status: approved'] }), { raiz: tmp('rev5') });
  assert.ok(clave.problemas.some((p) => /status/.test(p.mensaje) && /repet/.test(p.mensaje)), JSON.stringify(clave.problemas));
  const col = intent.readIntent(doc({ preguntas: [`${QH} Bloquea |`, '|---|---|---|---|---|---|---|---|---|', '| Q1 | p | w | c | sí | abierta |  | — | no |'] }), { raiz: tmp('rev5b') });
  assert.ok(col.problemas.some((p) => p.columna === 'Bloquea' && /repet/.test(p.mensaje)), JSON.stringify(col.problemas));
  assert.ok(col.bloqueantes.length > 0, 'una columna repetida no puede esconder una pregunta que bloquea');
});

test('Intent_DoubleQuotedEscapes_RoundTrip @story-8.258 @ac-1', () => {
  const objetivo = 'el total\tno suma "x" en C:\\temp é';
  const r = intent.readIntent(doc({ fm: ['id: x', 'status: draft', `objective: ${JSON.stringify(objetivo)}`, 'outcomes:', '  - "o"'] }), { raiz: tmp('rev6') });
  assert.strictEqual(r.frontmatter.objective, objetivo);
  const malo = intent.readIntent(doc({ fm: ['id: x', 'status: draft', 'objective: "un \\q raro"', 'outcomes:', '  - "o"'] }), { raiz: tmp('rev6b') });
  assert.ok(malo.problemas.some((p) => /frontmatter/.test(p.mensaje)), 'un escape que no se sabe leer es problema');
});

test('Intent_RepoSource_UnreadableAndSymlinkOutside @story-8.258 @ac-5', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const raiz = tmp('rev7');
  const afuera = tmp('rev7-afuera');
  fs.writeFileSync(path.join(afuera, 'b.md'), '1\n2\n3\n');
  fs.symlinkSync(path.join(afuera, 'b.md'), path.join(raiz, 'enlace.md'));
  fs.writeFileSync(path.join(raiz, 'cerrado.md'), '1\n2\n3\n');
  fs.chmodSync(path.join(raiz, 'cerrado.md'), 0o000);
  const r = intent.readIntent(doc({
    preguntas: [QH, SEP,
      q('Q1', 'a', 'b', 'c', 'sí', 'encontrada', 'está', 'repo:enlace.md:2'),
      q('Q2', 'a', 'b', 'c', 'sí', 'encontrada', 'está', 'repo:cerrado.md:2')],
  }), { raiz });
  assert.ok(problemOf(r, 'Q1').some((p) => /fuera del repo/.test(p.mensaje)), JSON.stringify(problemOf(r, 'Q1')));
  assert.ok(problemOf(r, 'Q2').some((p) => /no pude leer/.test(p.mensaje)), JSON.stringify(problemOf(r, 'Q2')));
  fs.chmodSync(path.join(raiz, 'cerrado.md'), 0o644);
});
