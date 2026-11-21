#!/usr/bin/env node
/**
 * story-discovery.test.js — el descubrimiento de stories y los controles que dependen de él.
 *
 * ── POR QUÉ ESTÁ EN SU PROPIO ARCHIVO ────────────────────────────────────────────────────────
 * No viven dentro de `unit.test.js`, que además de estos corre tests que lanzan herramientas de
 * verdad (uno corre un jest entero: 36s con la máquina cargada). El **chequeo de mutantes**
 * necesita correr la suite UNA VEZ POR MUTANTE y aborta si una corrida pasa de 120s — con lo
 * cual, en cuanto la máquina se carga, la verificación de estas guardas simplemente NO se puede
 * hacer. Separadas quedan en ~1s por corrida: el chequeo de mutantes es posible, que
 * es la única forma de saber si estos tests prueban algo o sólo pasan.
 *
 * Correr:  node --test <este archivo>
 * Wireado: `install-tycon-hooks.sh` (SessionStart, junto a unit.test.js).
 */

// Estas pruebas llaman a los hooks del cierre con el HOME real (y el instalador las corre en
// cada arranque). Sin esto, sus decisiones de mentira se anotarían en ~/.claude/.tycon-pipeline/frenos.jsonl, que
// sube al buzón y alimenta la métrica «evidencias rechazadas por los hooks del cierre» del tablero.
process.env.TYCON_CLOSURE_RECORD = 'off';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const { computeNextStory } = require(path.join(SCRIPTS, 'pipeline.js'));

// ═══════════════════════════════════════════════════════════════════════════════
// El gate de ATDD tiene que cubrir también lo implementado a mano, sin el PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════
// Sin pipeline no hay marker ni `fileEvents`, y sin eso el gate de `complete-step 4` no tiene nada que leer. El
// segundo freno —el aviso "estás editando archivos de una story sin invocar el pipeline"— tampoco salta si sólo
// escanea 3 rutas fijas `specs/stories/` y la story vive en otro lado. La capa de control no puede ser una persona
// leyendo el transcript.

const discovery = require(path.join(SCRIPTS, 'lib', 'story-discovery.js'));

// ═══════════════════════════════════════════════════════════════════════════════
// El descubridor no puede buscar por NOMBRE de carpeta
// ═══════════════════════════════════════════════════════════════════════════════
// Buscar por dos nombres de carpeta (`stories`, `epic-*`) falla igual que buscar por rutas absolutas, un nivel más
// arriba: en un repo del equipo las stories viven en `specs/bizuit-bpmn-mcp/` y el descubridor devolvería CERO — el
// aviso de "story sin pipeline" mudo, `pipeline.js next-story` en null, y el backfill de back-links diciendo "0 stories
// Mary+GOLD encontradas". Por eso la pertenencia la decide la ESTRUCTURA (un .md cuyo frontmatter
// declara `story:` y `status:`), nunca el nombre de la carpeta que lo contiene.
//
// 🔴 Los helpers de abajo escriben stories REALES en el fixture. Crear carpetas VACÍAS y afirmar encontrarlas
// probaría el matcher de nombres, no el descubrimiento — y pasaría en verde mientras el repo real devuelve cero.

/** Escribe un .md con frontmatter en `<root>/<rel>`. `fm` es el cuerpo del frontmatter. */
function writeStoryFile(root, rel, fm, body = '# story') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\n${fm.join('\n')}\n---\n\n${body}\n`, 'utf8');
  return abs;
}

/** Repo de juguete con los layouts que existen + el ruido que no debe entrar. */
function mkRepoConLayouts(prefix = 'sd-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  // (a) layout clásico: specs/stories
  writeStoryFile(root, 'specs/stories/1-1-alta.md', ['story: "1.1"', 'epic: 1', 'status: done']);
  // (b) layout epic-*
  writeStoryFile(root, 'docs/nimbo/orders/epic-labels/2-1-map.md',
    ['story: "2.1"', 'epic: 2', 'status: ready-for-dev']);
  // (c) layout stories anidado
  writeStoryFile(root, 'specs/route-filters/stories/3-2-filtros.md',
    ['story: "3.2"', 'epic: 3', 'status: in-progress']);
  // (d) layout SIN carpeta de nombre conocido: un repo del equipo
  writeStoryFile(root, 'specs/bizuit-bpmn-mcp/4-43-leer-no-es-crear.md',
    ['story: "4.43"', 'epic: 4', 'status: ready-for-dev']);
  // (e) layout .specs OCULTA: los repos de specs de dos productos del equipo. La premisa "las ocultas no llevan specs"
  // es falsa, y sin esta excepción esos repos miden 0 stories.
  writeStoryFile(root, '.specs/extractos/stories/5-1-extracto.md',
    ['story: "5.1"', 'epic: 5', 'status: done']);
  // ruido que NO es una story
  writeStoryFile(root, 'docs/README.md', ['title: "guía"'], '# no tiene story: ni status:');
  fs.writeFileSync(path.join(root, 'notas.md'), '# un .md sin frontmatter\n', 'utf8');
  writeStoryFile(root, 'node_modules/paquete/specs/stories/9-9-x.md', ['story: "9.9"', 'status: done']);
  writeStoryFile(root, 'dist/specs/stories/9-8-x.md', ['story: "9.8"', 'status: done']);
  writeStoryFile(root, '.advisors/pipeline-runs/4.43-x/reporte.md', ['story: "9.7"', 'status: done']);
  // .specs es LA excepción, no la puerta: el resto de las ocultas sigue afuera.
  writeStoryFile(root, '.git/basura/9-6-x.md', ['story: "9.6"', 'status: done']);
  return root;
}

const idsDe = (r) => r.stories.map((s) => s.id).sort();

test('story-discovery: una story es un .md que DECLARA story:+status:, viva en la carpeta que viva', () => {
  const root = mkRepoConLayouts();

  const r = discovery.discoverStories(root, { cache: false });

  assert.deepEqual(idsDe(r), ['1.1', '2.1', '3.2', '4.43', '5.1'],
    'los CINCO layouts entran — incluidos specs/<lo-que-sea>/ y la oculta .specs/ (DOTSPECS-1)');
  assert.equal(r.partial, false, 'un repo de juguete entra holgado en el presupuesto');

  const paths = r.stories.map((s) => path.relative(root, s.path).split(path.sep).join('/'));
  assert.ok(paths.includes('specs/bizuit-bpmn-mcp/4-43-leer-no-es-crear.md'),
    'el layout de un repo del equipo es el caso disparador: sin nombre de carpeta conocido');
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')), 'node_modules NO se escanea');
  assert.ok(!paths.some((p) => p.startsWith('dist/')), 'dist NO se escanea');
  assert.ok(paths.includes('.specs/extractos/stories/5-1-extracto.md'),
    '.specs/ (oculta) SÍ entra: convención real de FRESNO/TIMBO — DOTSPECS-1');
  assert.ok(!paths.some((p) => p.startsWith('.advisors/')),
    'las carpetas ocultas tampoco — .advisors es la SALIDA del arnés, no specs');
  assert.ok(!paths.some((p) => p.startsWith('.git/')),
    '.specs es LA excepción, no la puerta: .git sigue afuera');
  assert.ok(!paths.some((p) => /README|notas/.test(p)),
    'un .md sin frontmatter, o con frontmatter sin story:/status:, no es una story');

  // findStoryDirs se DERIVA de dónde hay stories de verdad.
  const dirs = discovery.findStoryDirs(root, { cache: false }).map((d) => path.relative(root, d).split(path.sep).join('/')).sort();
  assert.deepEqual(dirs, [
    '.specs/extractos/stories',
    'docs/nimbo/orders/epic-labels',
    'specs/bizuit-bpmn-mcp',
    'specs/route-filters/stories',
    'specs/stories',
  ]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: el material de un banco de evals NO es trabajo (la forma del id lo separa)', () => {
  const root = mkRepoConLayouts('sd-ev-');
  // Los EV-* tienen frontmatter Mary+GOLD válido (story: + status:) y NO son trabajo: son
  // insumo de las evals. Si entraran, ensuciarían los conteos de stories del repo.
  writeStoryFile(root, 'mcp/eval/bancos/generacion/historias/ev1-t1-lineal.md',
    ['epic: eval', 'story: "EV-1"', 'status: ready-for-dev', 'eval_class: t1-lineal']);
  writeStoryFile(root, 'mcp/eval/bancos/generacion/historias/ev2-t2-decision.md',
    ['epic: eval', 'story: "EV-2"', 'status: ready-for-dev']);

  const r = discovery.discoverStories(root, { cache: false });

  assert.ok(!idsDe(r).some((id) => /^EV-/.test(id)), 'EV-1/EV-2 quedan afuera: su id no tiene forma de story');
  // Control positivo — sin esto, un descubridor ROTO que devuelve [] también "pasa" el assert de arriba.
  assert.deepEqual(idsDe(r), ['1.1', '2.1', '3.2', '4.43', '5.1'], 'y las stories de verdad siguen entrando');
  assert.equal(r.excluded.length, 2, 'lo excluido se CUENTA, no desaparece en silencio');
  assert.ok(r.excluded.every((e) => /^EV-/.test(e.id)));

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: un repo con otra forma de id lo declara en .tycon/advisors.yaml', () => {
  const root = mkRepoConLayouts('sd-cfg-');
  writeStoryFile(root, 'specs/evals/ev1.md', ['story: "EV-1"', 'status: ready-for-dev']);

  const sinConfig = discovery.discoverStories(root, { cache: false });
  assert.ok(!idsDe(sinConfig).includes('EV-1'), 'por default, EV-1 no es trabajo');

  const yaml = path.join(root, '.tycon', 'advisors.yaml');
  fs.mkdirSync(path.join(root, '.tycon'), { recursive: true });
  // Comilla SIMPLE: la forma recomendada para un regex en YAML — llega tal cual está escrito.
  fs.writeFileSync(yaml, "stories:\n  id_pattern: '^(?:\\d+(?:[.-]\\d+)*|EV-\\d+)$'\n", 'utf8');

  const conConfig = discovery.discoverStories(root, { cache: false });
  assert.ok(idsDe(conConfig).includes('EV-1'), 'con el escape declarado, el repo manda');
  assert.ok(idsDe(conConfig).includes('4.43'), 'y no rompe las que ya entraban');

  // Comilla DOBLE con las barras escapadas: YAML válido, y también tiene que funcionar. Un parser
  // que sólo pela comillas dejaría `\\d` (barra literal + d) y el patrón no matchearía nada —
  // config ignorada en silencio, que es la falla que este archivo entero viene a evitar.
  fs.writeFileSync(yaml, 'stories:\n  id_pattern: "^(?:\\\\d+(?:[.-]\\\\d+)*|EV-\\\\d+)$"\n', 'utf8');
  const dobleComilla = discovery.discoverStories(root, { cache: false });
  assert.ok(idsDe(dobleComilla).includes('EV-1'), 'la comilla doble con \\\\d también vale');
  assert.ok(idsDe(dobleComilla).includes('4.43'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: un id_pattern roto NO abre la puerta — avisa y cae al default', () => {
  const root = mkRepoConLayouts('sd-cfgbad-');
  writeStoryFile(root, 'specs/evals/ev1.md', ['story: "EV-1"', 'status: ready-for-dev']);
  fs.mkdirSync(path.join(root, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tycon', 'advisors.yaml'), 'stories:\n  id_pattern: "[sin-cerrar"\n', 'utf8');

  const r = discovery.discoverStories(root, { cache: false });

  assert.ok(!idsDe(r).includes('EV-1'), 'un regex inválido no puede degradar a "todo entra"');
  assert.deepEqual(idsDe(r), ['1.1', '2.1', '3.2', '4.43', '5.1'], 'sigue el default');
  assert.ok(r.warnings.some((w) => /id_pattern/.test(w)), 'y lo dice — una config ignorada en silencio es la falla de mañana');

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: respeta el presupuesto de tiempo y NUNCA cachea un parcial vacío', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-budget-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  // Árbol ancho: el escaneo completo no entra en un presupuesto de pocos ms. 30×2 alcanza —
  // esta suite corre en CADA arranque de sesión, así que el fixture se mantiene barato.
  for (let i = 0; i < 30; i++) {
    for (let j = 0; j < 2; j++) {
      writeStoryFile(root, `ruido/n${i}/sub${j}/doc.md`, ['title: "x"'], '# no es story');
    }
  }
  writeStoryFile(root, 'specs/mcp/5-1-real.md', ['story: "5.1"', 'status: ready-for-dev']);
  const cachePath = path.join(root, '.cache.json');

  // (a) presupuesto cero → corta ANTES de mirar nada. Determinista: no depende del reloj.
  const cero = discovery.discoverStories(root, { budgetMs: 0, cache: true, cachePath });
  assert.equal(cero.partial, true, 'sin presupuesto no hay escaneo');
  assert.deepEqual(cero.stories, []);
  assert.equal(fs.existsSync(cachePath), false,
    'un parcial VACÍO no se persiste: cachearlo dejaría el repo mudo una hora entera');

  // (b) presupuesto chico sobre un árbol que no entra → corta de verdad. Con un reloj de la prueba que avanza 1 ms
  // cada vez que el escaneo lo mira: con el reloj real, en una máquina rápida (un contenedor Linux) el árbol entero
  // SÍ entra en 3 ms, la prueba daría rojo y el instalador saldría con error.
  const realNow = Date.now;
  let tick = realNow();
  let corto;
  const t0 = realNow();
  Date.now = () => (tick += 1);
  try {
    corto = discovery.discoverStories(root, { budgetMs: 3, cache: false });
  } finally {
    Date.now = realNow;
  }
  const elapsed = realNow() - t0;
  assert.equal(corto.partial, true, 'el árbol de 60 carpetas no entra en 3 miradas al reloj');
  assert.ok(corto.stats.dirs < 60, `y CORTA de verdad: miró ${corto.stats.dirs} carpetas de más de 60`);
  assert.ok(elapsed < 250, `sin colgarse: tardó ${elapsed}ms`);

  const completo = discovery.discoverStories(root, { budgetMs: 60000, cache: true, cachePath });
  assert.deepEqual(idsDe(completo), ['5.1'], 'con presupuesto suficiente encuentra la story real');
  assert.equal(completo.partial, false);
  assert.equal(fs.existsSync(cachePath), true, 'un resultado completo sí se cachea');
  const cached = discovery.discoverStories(root, { budgetMs: 60000, cache: true, cachePath });
  assert.equal(cached.fromCache, true, 'y la segunda lectura sale del cache');
  assert.deepEqual(idsDe(cached), ['5.1']);

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: un frontmatter más largo que la lectura de cabecera igual se detecta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-big-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  // `status:` recién después de 12KB de frontmatter — la lectura corta de cabecera no lo ve.
  const relleno = Array.from({ length: 400 }, (_, i) => `nota_${i}: "${'x'.repeat(30)}"`);
  writeStoryFile(root, 'specs/x/6-1-larga.md', ['story: "6.1"', ...relleno, 'status: ready-for-dev']);

  const r = discovery.discoverStories(root, { cache: false });
  assert.deepEqual(idsDe(r), ['6.1'], 'la cabecera es una optimización, no un límite del contrato');

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: matchea el archivo editado contra files_to_modify, con el layout que sea', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd2-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  // Carpeta SIN nombre conocido: el layout que un descubridor por nombre no vería.
  writeStoryFile(root, 'specs/bizuit-bpmn-mcp/4-43-leer-no-es-crear.md', [
    'story: "4.43"', 'status: in-progress',
    'files_to_modify:', '  - "mcp/src/tools/write-spec.ts"',
  ]);
  const edited = path.join(root, 'mcp/src/tools/write-spec.ts');
  fs.mkdirSync(path.dirname(edited), { recursive: true });
  fs.writeFileSync(edited, '// x');

  const hit = discovery.findStoryReferencing(edited, { cache: false });
  assert.ok(hit, 'encuentra la story que declara ese archivo');
  assert.equal(hit.storyId, '4.43');

  const miss = discovery.findStoryReferencing(path.join(root, 'src/otro.ts'), { cache: false });
  assert.equal(miss, null, 'un archivo que ninguna story declara no matchea');

  fs.rmSync(root, { recursive: true, force: true });
});

// ── Cierre de mutantes en el parser del escape por repo ────────────────────────────────────────
// El parser del escape por repo (`.tycon/advisors.yaml`) es la parte que los casos felices ejercen por un solo camino:
// un mutante ahí sobrevive si ningún test la toca de costado. El chequeo de mutantes sirve para eso:
// decir qué línea no está probada, no qué línea está mal.

test('story-discovery: unquoteScalar respeta el tipo de comilla (es un REGEX lo que viaja adentro)', () => {
  const { unquoteScalar } = discovery;
  // Comilla doble: YAML desescapa `\\` → `\`. Sin eso, `\\d` queda como "barra literal + d".
  assert.equal(unquoteScalar('"^\\\\d+$"'), '^\\d+$');
  assert.equal(unquoteScalar('"dice \\"hola\\""'), 'dice "hola"');
  // Comilla simple: llega tal cual, salvo `''` que es una comilla simple escapada.
  assert.equal(unquoteScalar("'^\\d+$'"), '^\\d+$', 'la comilla simple NO desescapa las barras');
  assert.equal(unquoteScalar("'^It''s$'"), "^It's$");
  // Sin comillas, y comentario inline pelado.
  assert.equal(unquoteScalar('^\\d+$'), '^\\d+$');
  assert.equal(unquoteScalar("'^A$'   # el formato de este repo"), '^A$');
  // Un par de comillas VACÍO es un valor vacío, no dos caracteres de comilla.
  assert.equal(unquoteScalar("''"), '');
  assert.equal(unquoteScalar('""'), '');
  // Una comilla suelta no es un valor entrecomillado.
  assert.equal(unquoteScalar('"'), '"');
  assert.equal(unquoteScalar("'"), "'");
});

test('story-discovery: el parser del escape aguanta comentarios, líneas en blanco y la key siguiente', () => {
  const root = mkRepoConLayouts('sd-yaml-');
  writeStoryFile(root, 'specs/evals/ev1.md', ['story: "EV-1"', 'status: ready-for-dev']);
  const yaml = path.join(root, '.tycon', 'advisors.yaml');
  fs.mkdirSync(path.join(root, '.tycon'), { recursive: true });

  // (a) comentario + línea EN BLANCO dentro del bloque, antes de la clave.
  fs.writeFileSync(yaml, [
    'stories:',
    '  # la forma de id de este repo incluye los EV-*',
    '',
    "  id_pattern: '^(?:\\d+(?:[.-]\\d+)*|EV-\\d+)$'",
    '',
    'e2e:',
    '  gate: scripts/e2e.sh',
    '',
  ].join('\n'), 'utf8');
  assert.ok(idsDe(discovery.discoverStories(root, { cache: false })).includes('EV-1'),
    'una línea en blanco dentro del bloque no puede cortar la lectura de la config');

  // (b) el bloque `stories:` NO declara id_pattern, y OTRA key top-level sí tiene una clave
  //     con ese nombre: no puede filtrarse. El bloque termina donde dedenta.
  fs.writeFileSync(yaml, [
    'stories:',
    '  # sin id_pattern a propósito',
    'otra_cosa:',
    "  id_pattern: '^NO-DEBE-USARSE$'",
    '',
  ].join('\n'), 'utf8');
  const r = discovery.discoverStories(root, { cache: false });
  assert.equal(r.config.source, null, 'el id_pattern de otro bloque no es el de stories');
  assert.deepEqual(idsDe(r), ['1.1', '2.1', '3.2', '4.43', '5.1'], 'y sigue el default');

  // (c) id_pattern vacío = no declarado (y no un patrón que no matchea nada).
  fs.writeFileSync(yaml, "stories:\n  id_pattern: ''\n", 'utf8');
  assert.deepEqual(idsDe(discovery.discoverStories(root, { cache: false })), ['1.1', '2.1', '3.2', '4.43', '5.1'],
    'un patrón vacío cae al default, no deja el repo sin stories');

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: TYCON_STORY_SCAN_BUDGET_MS manda sobre el default', () => {
  // El default sin env se chequea en ESTE proceso (el módulo ya está cargado): 500ms es el
  // número que salió de medir el escaneo completo del repo más grande (~325ms) — si alguien lo
  // baja sin medir, este assert lo frena.
  assert.equal(discovery.DEFAULT_BUDGET_MS, 500, 'el default es un TOPE medido, no un número al azar');

  // El override sí necesita un proceso nuevo (el env se lee al cargar el módulo). UNO solo:
  // esta suite corre en cada arranque de sesión y cada spawn se paga ahí.
  const lib = path.join(SCRIPTS, 'lib', 'story-discovery.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-env-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'specs/7-1-x.md', ['story: "7.1"', 'status: done']);

  const conEnv = execFileSync('node', [lib, '--doctor', '--repo', root], {
    encoding: 'utf8', env: { ...process.env, TYCON_STORY_SCAN_BUDGET_MS: '1234' },
  });
  assert.match(conEnv, /presupuesto:\s*1234ms/, `el env tiene que ganar:\n${conEnv}`);
  assert.match(conEnv, /stories:\s*1\b/, 'y el --doctor encuentra la story del fixture');

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: isWorkStoryId separa trabajo de material', () => {
  for (const id of ['1.1', '4.43', '1.11', '9', '2-10', '1.2.3']) {
    assert.equal(discovery.isWorkStoryId(id), true, `${id} tiene forma de story`);
  }
  for (const id of ['EV-1', 'S1', 'eval', '', null, 'T1-lineal', 'story-4-43', '1.1-bis']) {
    assert.equal(discovery.isWorkStoryId(id), false, `${JSON.stringify(id)} NO tiene forma de story`);
  }
});
// ═══════════════════════════════════════════════════════════════════════════════
// Los DOS gates que deciden "esto es una story" no pueden usar la RUTA
// ═══════════════════════════════════════════════════════════════════════════════
// Misma familia que el descubridor (ver `story-discovery`): `on-frontmatter-write` y
// `on-pre-commit` no pueden preguntar "¿el path contiene /specs/stories/?". En un repo del equipo
// (`specs/bizuit-bpmn-mcp/`) ninguno de los dos se dispararía NUNCA: el freno que impide cerrar
// una story sin evidencia estaría apagado para todo un repo, sin un solo mensaje. Por eso los dos
// deciden por el frontmatter del archivo.
const ofwStructural = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
const opcStructural = require(path.join(SCRIPTS, 'on-pre-commit.js'));

test('on-frontmatter-write: el gate mira el FRONTMATTER, no la carpeta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofw-layout-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const dir = path.join(root, 'specs', 'bizuit-bpmn-mcp');   // ni `stories` ni `epic-*`
  fs.mkdirSync(dir, { recursive: true });
  const storyPath = path.join(dir, '4-43-leer-no-es-crear.md');
  // El marcador de E2E es lo que hace que este gate APLIQUE (storyRequiresRuntimeEvidence);
  // sin él la story no exige evidencia runtime y el hook devuelve null por otro motivo — que no
  // es el que este test mide.
  const cuerpo = [
    '## Acceptance Criteria', '- AC1: el endpoint responde', '',
    '## Tests', '- E2E: tests/e2e/leer-no-es-crear.spec.ts', '',
    '## Tasks', '- [x] hacerlo',
  ].join('\n');
  fs.writeFileSync(storyPath, `---\nstory: "4.43"\nepic: 4\nstatus: in-progress\n---\n\n${cuerpo}\n`);

  // Write que la pasa a `done` sin ninguna evidencia DoD en el repo → tiene que frenar.
  const nuevo = `---\nstory: "4.43"\nepic: 4\nstatus: done\n---\n\n${cuerpo}\n`;
  const r = ofwStructural.handle({
    tool_name: 'Write', tool_input: { file_path: storyPath, content: nuevo }, session_id: 'ofw-test',
  });
  assert.ok(r && r.block, `una story fuera de specs/stories/ también tiene que frenar:\n${JSON.stringify(r)}`);
  assert.match(r.block, /4\.43/);

  // Control negativo: un .md que NO es una story no puede caer en el gate.
  const doc = path.join(dir, 'notas-de-diseno.md');
  fs.writeFileSync(doc, '---\ntitle: "notas"\nstatus: done\n---\n\n# nada que ver\n');
  const rDoc = ofwStructural.handle({
    tool_name: 'Write', tool_input: { file_path: doc, content: '---\ntitle: "notas"\nstatus: done\n---\n\n# editado\n' }, session_id: 'ofw-test',
  });
  assert.equal(rDoc, null, 'un doc con `status:` pero sin `story:` no es una story');

  // Control negativo 2 — el material de un banco de evals SÍ declara story:+status:. Sin el
  // filtro por forma del id, este gate empezaría a frenar la edición de insumos de evals.
  const ev = path.join(root, 'mcp', 'eval', 'bancos', 'historias', 'ev1.md');
  fs.mkdirSync(path.dirname(ev), { recursive: true });
  const evViejo = `---\nepic: eval\nstory: "EV-1"\nstatus: in-progress\n---\n\n${cuerpo}\n`;
  fs.writeFileSync(ev, evViejo);
  const rEv = ofwStructural.handle({
    tool_name: 'Write',
    tool_input: { file_path: ev, content: evViejo.replace('status: in-progress', 'status: done') },
    session_id: 'ofw-test',
  });
  assert.equal(rEv, null, 'EV-1 es insumo de evals, no una story que haya que cerrar con evidencia');

  fs.rmSync(root, { recursive: true, force: true });
});

test('on-pre-commit: looksLikeStorySpec separa story de documento, sin mirar la ruta', () => {
  const { looksLikeStorySpec } = opcStructural;
  const story = '---\nstory: "4.43"\nepic: 4\nstatus: done\n---\n\n# Story\n';
  assert.equal(looksLikeStorySpec(story), true, 'declara story: y status:');

  for (const [nombre, contenido] of [
    ['doc con frontmatter que no es story', '---\ntitle: "guía"\nstatus: publicado\n---\n\n# guía\n'],
    ['md sin frontmatter', '# changelog\n\n- cosas\n'],
    ['frontmatter que no cierra', '---\nstory: "4.43"\nstatus: done\n\n# sin cierre\n'],
    ['story: mencionado en el cuerpo, no en el frontmatter', '---\ntitle: "x"\n---\n\nstory: "4.43"\nstatus: done\n'],
    ['material de evals (id sin forma de story)', '---\nepic: eval\nstory: "EV-1"\nstatus: done\n---\n\n# EV\n'],
    ['vacío', ''],
    ['null', null],
  ]) {
    assert.equal(looksLikeStorySpec(contenido), false, nombre);
  }

  // El escape del repo también vale acá: si un repo declara otra forma de id, la story entra.
  assert.equal(
    looksLikeStorySpec('---\nepic: eval\nstory: "EV-1"\nstatus: done\n---\n\n# EV\n', /^EV-\d+$/),
    true,
    'con el id_pattern del repo, EV-1 sí es una story',
  );
});
test('computeNextStory: encuentra la próxima story aunque el repo NO tenga specs/stories/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-nextstory-layout-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const sd = path.join(dir, 'specs', 'bizuit-bpmn-mcp');   // ni `stories` ni `epic-*`
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, '4-42-hecha.md'), '---\nstory: "4.42"\nstatus: done\n---\nb\n');
  fs.writeFileSync(path.join(sd, '4-43-proxima.md'), '---\nstory: "4.43"\nstatus: ready-for-dev\n---\nb\n');
  // Material de evals en el mismo repo: tiene story:+status: y NO compite por ser la próxima.
  const ev = path.join(dir, 'mcp', 'eval', 'bancos', 'historias');
  fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'ev1.md'), '---\nepic: eval\nstory: "EV-1"\nstatus: ready-for-dev\n---\nb\n');

  const r = computeNextStory({ repo: dir });
  assert.ok(!r.error, `no debería errorear: ${r.error || ''}`);
  assert.equal(r.next_story.story_id, '4.43');
  assert.equal(r.ready_count, 1, 'EV-1 no cuenta como ready-for-dev');
  fs.rmSync(dir, { recursive: true, force: true });
});
// ── Orden de ids y next-story: viven acá y no en unit.test.js para que el chequeo
// de mutantes los cubra (la suite grande no entra en su tope de tiempo por corrida).
const { cmpStoryId } = require(path.join(SCRIPTS, 'pipeline.js'));

test('cmpStoryId ordena numéricamente (2-9 antes de 2-10, no lexicográfico)', () => {
  const arr = ['2-10-x.md', '2-9-y.md', '1-2-a.md', '2-2-b.md'];
  arr.sort(cmpStoryId);
  assert.deepEqual(arr, ['1-2-a.md', '2-2-b.md', '2-9-y.md', '2-10-x.md']);
});

// 🔴 Los ids de estos fixtures no pueden ser `1-2-done` / `2-9-old`: una forma que NINGÚN
// repo real usa (todos escriben `story: "2.9"`). Como el descubridor es único y separa
// trabajo de material por la FORMA del id, el fixture tiene que parecerse al repo. El orden
// numérico se sigue probando igual — sale del nombre de archivo, no del id.
test('computeNextStory: primera ready-for-dev en orden numérico + warn de in-progress', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-nextstory-'));
  const sd = path.join(dir, 'specs', 'stories');
  fs.mkdirSync(sd, { recursive: true });
  const mk = (file, id, st) => fs.writeFileSync(path.join(sd, file + '.md'), `---\nstory: "${id}"\nstatus: ${st}\n---\nb\n`);
  mk('1-2-done', '1.2', 'done'); mk('2-10-new', '2.10', 'ready-for-dev');
  mk('2-9-old', '2.9', 'ready-for-dev'); mk('3-1-wip', '3.1', 'in-progress');
  const r = computeNextStory({ specsDir: sd });
  assert.equal(r.next_story.story_id, '2.9', '2-9 va ANTES que 2-10 (orden numérico, no lexicográfico)');
  assert.equal(r.ready_count, 2);
  assert.equal(r.in_progress.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computeNextStory: sin ready-for-dev → menú de recuperación', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-nostory-'));
  const sd = path.join(dir, 'specs', 'stories');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, '4-1-x.md'), '---\nstory: "4.1"\nstatus: in-progress\n---\nb\n');
  const r = computeNextStory({ specsDir: sd });
  assert.equal(r.next_story, null);
  assert.ok(Array.isArray(r.options) && r.options.length >= 3);
  assert.ok(r.options.some((o) => /in-progress/.test(o)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── next-story usa EL MISMO descubridor que on-edit ───────────────────────────────────────────
// Armar su propia lista con `readdirSync(<repo>/specs/stories)` devolvería un error
// ("no existe …/specs/stories") en todo repo con otro layout — un repo del equipo entre ellos.

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Guardas que el chequeo de mutantes señala como NO ejercidas
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Un mutante vivo no dice "esto está mal": dice "nadie probó esta línea". Los de abajo cierran los que tienen
// consecuencia real; los del `--doctor` (formato de la salida) se dejan a propósito sin probar.

test('story-discovery: `story:` SIN `status:` no es una story (y al revés tampoco)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-medio-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'specs/a/8-1-completa.md', ['story: "8.1"', 'status: done']);
  writeStoryFile(root, 'specs/a/8-2-sin-status.md', ['story: "8.2"', 'epic: 8']);
  writeStoryFile(root, 'specs/a/8-3-sin-story.md', ['status: done', 'epic: 8']);

  assert.deepEqual(idsDe(discovery.discoverStories(root, { cache: false })), ['8.1'],
    'hacen falta LOS DOS campos: con uno solo el harness no puede operar la story');
  assert.equal(discovery.probeStoryFile(path.join(root, 'specs/a/8-2-sin-status.md')), null);
  assert.equal(discovery.probeStoryFile(path.join(root, 'specs/a/8-3-sin-story.md')), null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: la relectura por frontmatter largo NO se dispara de más', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-relect-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  // (a) archivo CHICO cuyo frontmatter no cierra → no hay nada más que leer: no es story.
  writeStoryFile(root, 'specs/x/nota.md', ['story: "9.1"', 'status: done']);
  fs.writeFileSync(path.join(root, 'specs/x/roto.md'), '---\nstory: "9.2"\nstatus: done\n\n# sin cierre\n');
  // (b) archivo GRANDE que arranca con `---` y jamás cierra → tampoco, y sin colgarse.
  fs.writeFileSync(path.join(root, 'specs/x/enorme.md'), `---\n${'x'.repeat(300 * 1024)}\n`);

  const r = discovery.discoverStories(root, { cache: false });
  assert.deepEqual(idsDe(r), ['9.1'], 'sólo la que cierra el frontmatter');
  assert.equal(discovery.probeStoryFile(path.join(root, 'specs/x/roto.md')), null);
  assert.equal(discovery.probeStoryFile(path.join(root, 'specs/x/enorme.md')), null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: el presupuesto se compara con >=, así que 0 significa "no escanees"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cero-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'specs/a/10-1.md', ['story: "10.1"', 'status: done']);

  // Determinista: un repo de UN archivo se escanea en menos de 1ms, así que si el corte fuera
  // `> 0` en vez de `>= 0` este escaneo terminaría COMPLETO y encontraría la story.
  const r = discovery.discoverStories(root, { budgetMs: 0, cache: false });
  assert.equal(r.partial, true, 'presupuesto 0 = no se escanea nada');
  assert.deepEqual(r.stories, []);
  assert.equal(r.stats.dirs, 0, 'ni una sola carpeta leída');

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: la profundidad máxima corta, y corta DONDE dice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-prof-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'a/b/c/11-1-tres.md', ['story: "11.1"', 'status: done']);
  writeStoryFile(root, 'a/b/c/d/11-2-cuatro.md', ['story: "11.2"', 'status: done']);

  assert.deepEqual(idsDe(discovery.discoverStories(root, { cache: false, maxDepth: 3 })), ['11.1'],
    'a profundidad 3 entra la de 3 niveles y no la de 4');
  assert.deepEqual(idsDe(discovery.discoverStories(root, { cache: false, maxDepth: 4 })), ['11.1', '11.2']);

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: el orden de prioridad no cambia QUÉ se encuentra, sólo cuándo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-orden-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  // Una story en una carpeta que NO parece de specs: con presupuesto suficiente tiene que entrar.
  writeStoryFile(root, 'motor/interno/12-1-escondida.md', ['story: "12.1"', 'status: done']);
  writeStoryFile(root, 'specs/12-2-obvia.md', ['story: "12.2"', 'status: done']);

  assert.deepEqual(idsDe(discovery.discoverStories(root, { cache: false })), ['12.1', '12.2'],
    'el nombre de la carpeta decide el ORDEN de recorrido, nunca la pertenencia');

  fs.rmSync(root, { recursive: true, force: true });
});

test('next-story: sin stories, avisa con el criterio y el comando de diagnóstico', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-cero-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'docs/guia.md', ['title: "no es story"']);

  const r = computeNextStory({ repo: root });
  assert.equal(r.next_story, null);
  assert.equal(r.scanned.stories_found, 0);
  assert.ok(r.warnings.some((w) => /0 stories Mary\+GOLD/.test(w) && /--doctor/.test(w)),
    `un cero tiene que venir con el criterio y cómo diagnosticarlo:\n${JSON.stringify(r.warnings)}`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('on-pre-commit: el filtro del diff sólo deja pasar stories (sin mirar la ruta)', () => {
  // 🔴 Se llama a la FUNCIÓN REAL (`selectStorySpecs`), no a una reimplementación del filtro: copiar la lógica
  // acá adentro pasaría en verde mientras los mutantes de esas líneas sobreviven, porque el código de
  // producción nunca se ejecutaría.
  const { selectStorySpecs } = opcStructural;
  const contenidos = {
    'specs/bizuit-bpmn-mcp/4-43.md': '---\nstory: "4.43"\nstatus: done\n---\n\n#\n',
    'docs/README.md': '---\ntitle: "x"\nstatus: publicado\n---\n\n#\n',
    'mcp/eval/bancos/ev1.md': '---\nstory: "EV-1"\nstatus: done\n---\n\n#\n',
    'src/index.ts': 'export const x = 1;\n',
  };
  const files = Object.keys(contenidos);
  const leer = (f) => contenidos[f];

  const vistos = new Map();
  assert.deepEqual(
    selectStorySpecs(files, leer, null, vistos),
    ['specs/bizuit-bpmn-mcp/4-43.md'],
    'entra la story; no el doc, no el material de evals, no el código',
  );
  assert.deepEqual([...vistos.keys()], ['specs/bizuit-bpmn-mcp/4-43.md'],
    'y deja cacheado el contenido staged de lo que sí entró (para no releerlo)');

  // Con el escape del repo, el material de evals SÍ entra: es lo que el repo declaró.
  assert.equal(selectStorySpecs(files, leer, /^(?:\d+(?:[.-]\d+)*|EV-\d+)$/).length, 2);
  // Un diff sin ningún .md no puede devolver nada (ni llamar al lector).
  assert.deepEqual(selectStorySpecs(['src/a.ts', 'b.cs'], () => { throw new Error('no debería leer'); }), []);
});

test('on-frontmatter-write: hacen falta LOS DOS campos para que el gate aplique', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofw-campos-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const cuerpo = '## Acceptance Criteria\n- AC1\n\n## Tests\n- E2E: tests/e2e/x.spec.ts\n';
  const dir = path.join(root, 'specs', 'mcp');
  fs.mkdirSync(dir, { recursive: true });

  const casos = [
    ['sin story:', `---\nepic: 5\nstatus: in-progress\n---\n\n${cuerpo}`, `---\nepic: 5\nstatus: done\n---\n\n${cuerpo}`],
    ['sin status:', `---\nstory: "5.1"\nepic: 5\n---\n\n${cuerpo}`, `---\nstory: "5.1"\nepic: 5\ntitle: x\n---\n\n${cuerpo}`],
  ];
  for (const [nombre, viejo, nuevo] of casos) {
    const p = path.join(dir, `caso-${nombre.replace(/\W+/g, '')}.md`);
    fs.writeFileSync(p, viejo);
    assert.equal(
      ofwStructural.handle({ tool_name: 'Write', tool_input: { file_path: p, content: nuevo }, session_id: 'x' }),
      null, `${nombre} → el gate no aplica`,
    );
  }

  // Control positivo: con los dos campos y transición a done, SÍ frena.
  const ok = path.join(dir, '5-2-completa.md');
  fs.writeFileSync(ok, `---\nstory: "5.2"\nepic: 5\nstatus: in-progress\n---\n\n${cuerpo}`);
  const r = ofwStructural.handle({
    tool_name: 'Write',
    tool_input: { file_path: ok, content: `---\nstory: "5.2"\nepic: 5\nstatus: done\n---\n\n${cuerpo}` },
    session_id: 'x',
  });
  assert.ok(r && r.block, 'con los dos campos el gate sí aplica');

  fs.rmSync(root, { recursive: true, force: true });
});

test('next-story: la raíz sale del repo git, no del cwd suelto', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-raiz-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'specs/mcp/13-1.md', ['story: "13.1"', 'status: ready-for-dev']);
  // Se pasa una SUBcarpeta: la raíz tiene que subir hasta el `.git` y encontrar la story igual.
  const r = computeNextStory({ repo: path.join(root, 'specs', 'mcp') });
  assert.ok(!r.error, r.error || '');
  assert.equal(r.next_story && r.next_story.story_id, '13.1');
  assert.equal(r.scanned.root, root, 'escanea desde la raíz del repo, no desde el subdirectorio');
  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: un cache de una versión vieja se IGNORA, no se lee mal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cachev-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'specs/14-1.md', ['story: "14.1"', 'status: done']);
  const cachePath = path.join(root, '.cache.json');

  // Cache con un formato VIEJO (v2 guardaba carpetas, no stories) y una entrada mentirosa.
  fs.writeFileSync(cachePath, JSON.stringify({ v: 2, [root]: { at: Date.now(), dirs: ['/inventado'] } }));
  const r = discovery.discoverStories(root, { cache: true, cachePath });
  assert.equal(r.fromCache, false, 'una versión distinta de cache no se usa');
  assert.deepEqual(idsDe(r), ['14.1'], 'se re-escanea de verdad');

  // Y una entrada de la versión ACTUAL pero sin stats: se usa igual, sin romperse.
  // (el número de versión sube para invalidar los índices viejos, que podían decir "0 stories" donde sí había.)
  fs.writeFileSync(cachePath, JSON.stringify({ v: 4, [root]: { at: Date.now(), sig: 'default|6', stories: [], excluded: [] } }));
  const r2 = discovery.discoverStories(root, { cache: true, cachePath });
  assert.equal(r2.fromCache, true);
  assert.deepEqual(r2.stats, { dirs: 0, files: 0, ms: 0 }, 'stats ausente → cero, no undefined');

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: un escaneo COMPLETO no avisa de incompleto', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-nowarn-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'specs/15-1.md', ['story: "15.1"', 'status: done']);

  const completo = discovery.discoverStories(root, { cache: false });
  assert.equal(completo.partial, false);
  assert.deepEqual(completo.warnings, [], 'sin avisos cuando salió entero — si no, se aprenden a ignorar');

  const cortado = discovery.discoverStories(root, { budgetMs: 0, cache: false });
  assert.ok(cortado.warnings.some((w) => /INCOMPLETO/.test(w)), 'y sí avisa cuando quedó cortado');

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: files_to_modify se lee del FRONTMATTER, no del cuerpo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-body-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  // La story declara UN archivo en el frontmatter y menciona OTRO en el cuerpo (en un ejemplo).
  writeStoryFile(root, 'specs/16-1.md', [
    'story: "16.1"', 'status: in-progress',
    'files_to_modify:', '  - "src/real.ts"',
  ], '# Story\n\nEjemplo de lo que NO hay que tocar:\n\nfiles_to_modify:\n  - "src/ejemplo.ts"\n');
  for (const f of ['src/real.ts', 'src/ejemplo.ts']) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, f), '// x');
  }

  assert.ok(discovery.findStoryReferencing(path.join(root, 'src/real.ts'), { cache: false }),
    'el declarado en el frontmatter matchea');
  assert.equal(discovery.findStoryReferencing(path.join(root, 'src/ejemplo.ts'), { cache: false }), null,
    'lo que aparece en el CUERPO no cuenta — el contrato es el frontmatter');

  // Y el presupuesto también corta acá.
  assert.equal(discovery.findStoryReferencing(path.join(root, 'src/real.ts'), { cache: false, budgetMs: 0 }), null,
    'sin presupuesto no se afirma nada');

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: un cache con la MISMA firma pero otra versión tampoco se usa', () => {
  // Complementa el test de arriba: ahí la entrada vieja no tenía `sig` y se re-escaneaba por eso.
  // Acá la firma coincide, así que lo ÚNICO que puede rechazarla es el número de versión.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cachev2-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'specs/17-1.md', ['story: "17.1"', 'status: done']);
  const cachePath = path.join(root, '.cache.json');
  const entrada = { at: Date.now(), sig: 'default|6', partial: false, stats: { dirs: 1, files: 1, ms: 0 }, stories: [], excluded: [] };

  fs.writeFileSync(cachePath, JSON.stringify({ v: 999, [root]: entrada }));
  const r = discovery.discoverStories(root, { cache: true, cachePath });
  assert.equal(r.fromCache, false, 'versión distinta → el cache entero se descarta');
  assert.deepEqual(idsDe(r), ['17.1']);

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: el presupuesto del aviso de on-edit corta ANTES de mirar la primera story', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-fsr-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const storyPath = writeStoryFile(root, 'specs/18-1.md', [
    'story: "18.1"', 'status: in-progress', 'files_to_modify:', '  - "src/a.ts"',
  ]);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.ts'), '// x');
  // `stories` se pasa YA resuelto para que el reloj arranque pegado al bucle: así el corte es
  // exactamente la comparación, sin el tiempo del escaneo de por medio.
  const stories = [{ id: '18.1', status: 'in-progress', path: storyPath, dir: path.dirname(storyPath) }];

  assert.equal(discovery.findStoryReferencing(path.join(root, 'src/a.ts'), { stories, budgetMs: 0 }), null,
    'presupuesto 0 = no se mira ninguna story');
  const hit = discovery.findStoryReferencing(path.join(root, 'src/a.ts'), { stories, budgetMs: 60000 });
  assert.ok(hit && hit.storyId === '18.1', 'con presupuesto, la encuentra');

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: el --doctor informa dónde están las stories y qué excluyó', () => {
  const lib = path.join(SCRIPTS, 'lib', 'story-discovery.js');
  const root = mkRepoConLayouts('sd-doc-');
  for (let i = 1; i <= 7; i++) {
    writeStoryFile(root, `mcp/eval/bancos/ev${i}.md`, [`story: "EV-${i}"`, 'status: ready-for-dev']);
  }
  const out = execFileSync('node', [lib, '--doctor', '--repo', root], { encoding: 'utf8' });

  assert.match(out, /stories:\s*5\b/);
  assert.match(out, /specs\/bizuit-bpmn-mcp/, 'lista las carpetas donde hay stories, con su conteo');
  assert.match(out, /excluidos:\s*7\b/, 'y cuántas descartó por la forma del id');
  assert.match(out, /EV-1/, 'nombrando ejemplos');
  assert.match(out, /y 2 más/, 'y diciendo cuántas no listó — nunca truncar en silencio');

  fs.rmSync(root, { recursive: true, force: true });
});

test('next-story: informa con qué criterio de id escaneó', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-crit-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'specs/19-1.md', ['story: "19.1"', 'status: ready-for-dev']);

  const porDefault = computeNextStory({ repo: root });
  assert.equal(porDefault.scanned.id_criterion, 'default (id jerárquico numérico)');

  fs.mkdirSync(path.join(root, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tycon', 'advisors.yaml'), "stories:\n  id_pattern: '^\\d+(?:[.-]\\d+)*$'\n");
  const declarado = computeNextStory({ repo: root });
  assert.match(declarado.scanned.id_criterion, /^\^\\d\+.*\(\.tycon\/advisors\.yaml\)$/,
    `tiene que decir el patrón REAL del repo: ${declarado.scanned.id_criterion}`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: cada .md que se abre se CIERRA (si no, el escaneo se trunca solo)', () => {
  // 🔴 El probe abre un descriptor por
  // archivo; si no lo cierra, con el límite por defecto de 1M no se nota nada — pero el límite
  // habitual de macOS para procesos de escritorio es 256, y ahí un escaneo de 1300 `.md` se queda
  // sin descriptores a mitad de camino y devuelve MENOS stories, sin decir nada. Otra vez el
  // mismo modo de falla: un número más bajo que la verdad, indistinguible de la verdad.
  // Con el cierre roto y `ulimit -n 64`, encuentra 53 de 200 y después explota.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-fd-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  const N = 120;   // holgado sobre el límite de 64 que impone el subshell
  for (let i = 0; i < N; i++) {
    fs.writeFileSync(path.join(root, 'specs', `20-${i}.md`), `---\nstory: "20.${i}"\nstatus: done\n---\n\n#\n`);
  }
  const lib = path.join(SCRIPTS, 'lib', 'story-discovery.js');
  const prog = `const D=require(${JSON.stringify(lib)});`
    + `process.stdout.write(String(D.discoverStories(${JSON.stringify(root)},{cache:false,budgetMs:60000}).stories.length));`;

  // El límite de descriptores se baja en un subshell: es la única forma de que un leak se vea.
  const salida = execFileSync('bash', ['-c', `ulimit -n 64 && node -e ${JSON.stringify(prog)}`], { encoding: 'utf8' });
  assert.equal(Number(salida.trim()), N, `con pocos descriptores tiene que encontrarlas TODAS (encontró ${salida})`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('story-discovery: importar el módulo NO ejecuta nada (el CLI es sólo cuando se lo invoca)', () => {
  // Un módulo que corre su CLI al ser importado se lleva puesto al proceso que lo importa — y de
  // paso engaña al chequeo de mutantes: la suite termina sin correr un solo test, con código de
  // salida 0, y eso se lee como "los tests pasaron". Se verifica en un proceso aparte porque el
  // efecto sería, justamente, matar este.
  const lib = path.join(SCRIPTS, 'lib', 'story-discovery.js');
  const salida = execFileSync('node', ['-e', `require(${JSON.stringify(lib)}); process.stdout.write('SOLO-ESTO');`], { encoding: 'utf8' });
  assert.equal(salida, 'SOLO-ESTO', `importarlo no puede imprimir ni salirse: recibí ${JSON.stringify(salida)}`);
});

test('story-discovery: el --doctor lee sus flags en cualquier orden', () => {
  const lib = path.join(SCRIPTS, 'lib', 'story-discovery.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-flags-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  writeStoryFile(root, 'specs/21-1.md', ['story: "21.1"', 'status: done']);

  // `--repo` PRIMERO (posición 0): si el parser exigiera índice > 0 lo ignoraría y escanearía el
  // cwd equivocado — un diagnóstico que reporta sobre otro repo es peor que no tenerlo.
  const primero = execFileSync('node', [lib, '--repo', root, '--doctor'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.match(primero, new RegExp(`repo:\\s+${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(primero, /stories:\s*1\b/);

  fs.rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// El spawnIf del despachador no puede exigir la RUTA `specs/stories/`
// ═══════════════════════════════════════════════════════════════════════════════
// Si el pre-filtro que decide spawnear las hojas de ADO y de follow-ups (dispatch.js, `isStoryWrite`) decidiera por
// RUTA, crear una story en un repo con otro layout no crearía el work item de ADO ni correría el enlazado de
// follow-ups: la mayoría de los repos con stories del equipo quedaría fuera. Decide la IDENTIDAD DECLARADA (`story:`
// en el frontmatter del content), vía declaresStoryIdentity.

test('declaresStoryIdentity: la identidad la declara el frontmatter, jamás la ruta', () => {
  const f = discovery.declaresStoryIdentity;
  // dispara: story real, con o sin BOM, indentación o mayúscula (el detector tolera)
  assert.equal(f('---\nstory: "2.3"\nstatus: backlog\n---\n# S\n'), true);
  assert.equal(f('﻿---\nstory: 1.2\n---\n'), true);
  assert.equal(f('---\n  Story: 4.1\n---\n'), true);
  // NO dispara: docs de planning (status sin story), cuerpo, frontmatter roto, vacíos
  assert.equal(f('---\ntitle: PRD\nstatus: draft\n---\n# PRD\n'), false, 'un PRD declara estado, no identidad');
  assert.equal(f('# Doc\nstory: 1.1 en el cuerpo\n'), false, 'sin frontmatter no hay identidad');
  assert.equal(f('---\ntitle: x\n---\nstory: "9.9"\n'), false, 'un story: del CUERPO no cuenta');
  assert.equal(f('---\nstory: "2.3"\nsin cierre'), false, 'frontmatter sin cerrar: jurisdicción del lint');
  assert.equal(f('---\nstory:\nstatus: x\n---\n'), false, 'story: sin valor no es identidad');
  assert.equal(f(null), false);
  assert.equal(f(''), false);
});

// El ambiente de una máquina SIN configuración (la copia para un dev de otra organización): HOME vacía,
// sin el perfil del equipo y sin ninguna variable de Azure DevOps de quien corre; el arnés, el de este mismo árbol.
// La capa de plataforma lee la organización de un árbol vacío: en una máquina instalada el árbol trae team-repos.json
// con la plataforma de las operaciones, que elige dónde crear el pedido de trabajo aunque no haya perfil.
const HARNESS_HERE = path.resolve(SCRIPTS, '..', '..', '..');
function adoEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^TYCON_ADO|^AZURE_DEVOPS/.test(k)) env[k] = v;
  env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-home-'));
  env.USERPROFILE = env.HOME;
  env.TYCON_PROFILE = '0';
  env.TYCON_TREE = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-tree-'));
  if (fs.existsSync(path.join(HARNESS_HERE, 'scripts', 'lib', 'tycon-config.js'))) env.TYCON_GUIDES_DIR = HARNESS_HERE;
  return Object.assign(env, extra);
}

test('dispatch post-edit: el Write de una story FUERA de specs/stories/ spawnea las hojas de story-create', (t) => {
  // la hoja de ADO vive en integrations/ del arnés: una copia que sólo trae skills/ no la tiene
  if (!fs.existsSync(path.join(HARNESS_HERE, 'scripts', 'lib', 'tycon-config.js'))) { t.skip('sin el arnés en este árbol: no hay hoja de ADO que disparar'); return; }
  // El disparo REAL, end-to-end: dispatch.js decide por contenido y spawnea la hoja de ADO,
  // cuyo reminder es la evidencia. El layout es el de Pacara (docs/<área>/<épica>/) — el
  // caso que un guard por ruta dejaría mudo. OJO: la hoja excluye paths que contengan
  // el arnés o el ~/.claude — el fixture vive en tmpdir plano a propósito.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-spawn-'));
  const rel = 'docs/pedidos/epic-envios/story-9-9-demo.md';
  const contenido = '---\nstory: "9.9"\nepic: "pedidos"\nstatus: backlog\ntitle: "Demo"\napproach: "t"\n---\n# S\n';
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), contenido);
  const dispatch = path.join(SCRIPTS, 'dispatch.js');
  // Azure DevOps prendida por variable: la hoja de ADO sólo corre con la integración ado prendida, y esta
  // prueba mide el disparo, no la llave. Sin esto, en la copia pública (sin perfil del equipo) mediría la llave apagada.
  const run = (ev) => execFileSync('node', [dispatch, 'post-edit'], { input: JSON.stringify(ev), encoding: 'utf8', env: adoEnv({ TYCON_ADO_ORG: 'https://dev.azure.com/example-org' }) });

  const conStory = run({
    hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: 'sd-t1', cwd: root,
    tool_input: { file_path: path.join(root, rel), content: contenido },
  });
  assert.match(conStory, /STORY-CREATE-detect/, 'una story fuera de specs/stories/ tiene que disparar las hojas');

  const sinStory = run({
    hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: 'sd-t1', cwd: root,
    tool_input: { file_path: path.join(root, 'docs/prd.md'), content: '---\ntitle: PRD\nstatus: draft\n---\n# PRD\n' },
  });
  assert.doesNotMatch(sinStory, /STORY-CREATE/, 'un doc de planning no puede disparar los hooks de story');

  fs.rmSync(root, { recursive: true, force: true });
});

// Una máquina con las skills en un clon que sólo trae skills/ (sin integrations/ al lado): la hoja de ADO sale de la
// carpeta del arnés.
test('dispatch post-edit: con las skills en un clon aparte, la hoja de ADO sale de integrations/ del arnés', (t) => {
  if (!fs.existsSync(path.join(HARNESS_HERE, 'integrations', 'azure-devops', 'scripts', 'on-story-create.js'))) { t.skip('sin la integración de ADO en este árbol'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-split-'));
  fs.cpSync(path.join(HARNESS_HERE, 'skills'), path.join(tmp, 'clon', 'skills'), { recursive: true });
  const rel = 'docs/story-9-7-demo.md';
  const contenido = '---\nstory: "9.7"\nepic: "pedidos"\nstatus: backlog\ntitle: "Demo"\napproach: "t"\n---\n# S\n';
  fs.mkdirSync(path.join(tmp, 'repo', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'repo', rel), contenido);
  const ev = { hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: 'sd-t3', cwd: path.join(tmp, 'repo'), tool_input: { file_path: path.join(tmp, 'repo', rel), content: contenido } };
  const out = execFileSync('node', [path.join(tmp, 'clon', 'skills', 'tycon-pipeline', 'scripts', 'dispatch.js'), 'post-edit'],
    { input: JSON.stringify(ev), encoding: 'utf8', env: adoEnv({ TYCON_ADO_ORG: 'https://dev.azure.com/example-org', TYCON_GUIDES_DIR: HARNESS_HERE }) });
  assert.match(out, /STORY-CREATE-detect/, 'sin integrations/ al lado de las skills, la hoja tiene que salir del arnés');
  // sin arnés tampoco: la hoja no está en ningún lado, y se dice
  const sinArnes = spawnSync('node', [path.join(tmp, 'clon', 'skills', 'tycon-pipeline', 'scripts', 'dispatch.js'), 'post-edit'],
    { input: JSON.stringify(ev), encoding: 'utf8', env: adoEnv({ TYCON_ADO_ORG: 'https://dev.azure.com/example-org', TYCON_GUIDES_DIR: '' }) });
  assert.doesNotMatch(sinArnes.stdout, /STORY-CREATE-detect/);
  assert.match(sinArnes.stderr, /el control «ado-story-create» de la integración ado no está/, 'el control que falta no queda mudo');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// La hoja de ADO corre sólo con la integración ado prendida (ado.org o TYCON_ADO_ORG) o si el repo de la story trae
// `.tycon/ado-config.yaml`. Sin Azure DevOps configurado (la copia para un dev de otra organización), cada story nueva
// inyectaría «creá el work item en ADO» y mandaría a invocar una skill que después se saltearía sola.
test('dispatch post-edit: sin Azure DevOps configurado, la story nueva NO pide el work item; con la config del repo, sí', (t) => {
  if (!fs.existsSync(path.join(HARNESS_HERE, 'scripts', 'lib', 'tycon-config.js'))) { t.skip('sin el arnés en este árbol: no hay llave que medir'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ado-off-'));
  const rel = 'docs/pedidos/story-9-8-demo.md';
  const contenido = '---\nstory: "9.8"\nepic: "pedidos"\nstatus: backlog\ntitle: "Demo"\napproach: "t"\n---\n# S\n';
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), contenido);
  const dispatch = path.join(SCRIPTS, 'dispatch.js');
  const ev = { hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: 'sd-t2', cwd: root, tool_input: { file_path: path.join(root, rel), content: contenido } };
  const run = (extra) => execFileSync('node', [dispatch, 'post-edit'], { input: JSON.stringify(ev), encoding: 'utf8', env: adoEnv(extra) });

  assert.doesNotMatch(run(), /STORY-CREATE-detect/, 'sin ado.org ni config del repo, la hoja de ADO no tiene que avisar');
  assert.match(run({ TYCON_ADO_ORG: 'https://dev.azure.com/example-org' }), /STORY-CREATE-detect/, 'control: con la integración prendida, avisa');
  fs.mkdirSync(path.join(root, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tycon', 'ado-config.yaml'), 'ado_org: https://dev.azure.com/example-org\nado_project: Demo\n');
  assert.match(run(), /STORY-CREATE-detect/, 'el repo declara su Azure DevOps: avisa aunque la máquina no tenga organización');
  fs.rmSync(root, { recursive: true, force: true });
});
