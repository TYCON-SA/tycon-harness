#!/usr/bin/env node
/**
 * ui-readability.test.js — la pantalla se revisa con ojos de usuario (story 7.24).
 *
 * Caso disparador (2026-10-14, guides/incident-log.md#case-screen-passed-all-controls-unreadable-2026-10-14): una ventana pasó todos los controles y
 * el dueño la vio «inentendible» en staging. La revisión de legibilidad sólo leía la guía del tester, y sus marcas se
 * resolvieron reescribiendo la guía: el texto malo siguió en la pantalla.
 *
 *   T1 story de pantalla sin `<clave>-legibilidad-ui.md` → `--check` falla nombrando el archivo
 *   T2 veredicto MARCAS / sin `captures:` / `screens:` incompleto → falla; el archivo completo pasa
 *   T3 una marca citada que sigue en la pantalla (literal o mensaje armado) → falla; `keep:` la deja y se imprime
 *   T4 story sin pantalla → no se exige nada
 *   T6 el banco del validador trae los dos casos de VAL-W16
 *   T7 el cierre del paso 8 muestra las capturas antes de pedir el commit
 *   T8 `visibleTexts` saca los textos visibles y deja afuera el código
 *   T9 VAL-W16 existe en el validador y el catálogo, y no auto-continúa en el paso 1
 *
 * El ejemplo es inventado a propósito (facturas): lo que se publica no lleva el rubro de un cliente.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/ui-readability.test.js < /dev/null
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SK = path.join(__dirname, '..');
const RAIZ = path.join(SK, '..', '..', '..');
const QA = path.join(SK, 'qa-guide.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-readability-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* nada */ } });
// HOME falso: gates.log, marcadores y aprobaciones viven bajo el home.
const HOME = path.join(TMP, 'casa');
fs.mkdirSync(path.join(HOME, '.claude', '.tycon-pipeline', 'active'), { recursive: true });

let n = 0;
// mundo — un repo git propio en su carpeta padre propia (la matriz mira vecinos).
function mundo() {
  const repo = path.join(TMP, `m${++n}`, 'repo');
  fs.mkdirSync(path.join(repo, '.advisors', 'dod-runtime'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'trabajo', repo], { stdio: 'ignore' });
  return repo;
}
function escribir(file, txt) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, txt); }

// story — una story de un AC en llano; `archivos` va a files_to_modify.
function story(repo, archivos) {
  const p = path.join(repo, 'specs', 'stories', 'story-1.1-x.md');
  escribir(p, [
    '---', 'epic: 1', 'story: "1.1"', 'title: "La lista de facturas"', 'status: in-progress',
    'files_to_modify:', ...archivos.map((a) => `  - ${a}`), '---', '', '# Story 1.1', '',
    '## Acceptance Criteria', '', '1. **Given** un cliente con facturas **When** abre la lista **Then** ve cuántas le faltan pagar.', '',
    '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    '| T1 | `ListaDeFacturas_MuestraPendientes` | 1 | e2e | x | y |', '',
  ].join('\n'));
  return p;
}
// guía lista: pasos en llano + legibilidad de la guía OK (así lo único que puede fallar es lo nuevo).
function guiaLista(repo, legibilidad = 'veredicto: OK\n') {
  const qa = path.join(repo, 'specs', 'qa');
  escribir(path.join(qa, '1.1-pasos.md'), 'Usuario por defecto: cliente\n\n## AC 1\nAbrir la lista de facturas.\n→ Ver cuántas faltan pagar.\n');
  escribir(path.join(qa, '1.1-legibilidad.md'), legibilidad);
  return qa;
}
const UI_OK = (screens) => `veredicto: OK\nscreens:\n${screens.map((s) => `  - ${s}`).join('\n')}\ncaptures: ninguna — sin E2E en esta prueba\n`;

function check(storyPath) {
  const env = { ...process.env, HOME };
  delete env.NODE_TEST_CONTEXT; // vacía no es borrada: dentro de node --test cambia cómo sale el hijo
  const r = spawnSync('node', [QA, '--story', storyPath, '--check'], { encoding: 'utf8', input: '', env });
  return { rc: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('T1 UiReadability_StoryConPantalla_ExigeArchivo', () => {
  const repo = mundo();
  escribir(path.join(repo, 'src', 'components', 'Facturas.tsx'), 'export const F = () => <p>Te faltan pagar 2 facturas.</p>;\n');
  const s = story(repo, ['src/components/Facturas.tsx']);
  guiaLista(repo);
  const r = check(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /specs\/qa\/1\.1-legibilidad-ui\.md/, r.out);
});

test('T2 UiReadability_VeredictoMarcas_BloqueaEnLaPantalla', () => {
  const repo = mundo();
  escribir(path.join(repo, 'src', 'components', 'Facturas.tsx'), 'export const F = () => <p>Te faltan pagar 2 facturas.</p>;\n');
  escribir(path.join(repo, 'src', 'components', 'Detalle.tsx'), 'export const D = () => <h2>Detalle de la factura</h2>;\n');
  const s = story(repo, ['src/components/Facturas.tsx', 'src/components/Detalle.tsx']);
  const qa = guiaLista(repo);
  const ui = path.join(qa, '1.1-legibilidad-ui.md');
  const ambas = ['src/components/Facturas.tsx', 'src/components/Detalle.tsx'];

  escribir(ui, UI_OK(ambas).replace('veredicto: OK', 'veredicto: MARCAS'));
  let r = check(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /en la pantalla/i, r.out);

  escribir(ui, UI_OK(ambas).replace(/captures:.*\n/, ''));
  r = check(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /captures:/, r.out);

  escribir(ui, UI_OK(['src/components/Facturas.tsx']));
  r = check(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /Detalle\.tsx/, r.out);

  // Una captura nombrada que no existe frena (revisores del paso 5: rama sin prueba).
  escribir(ui, UI_OK(ambas).replace(/captures:.*\n/, 'captures:\n  - /no/existe/01-lista.png\n'));
  r = check(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /01-lista\.png/, r.out);

  // Control positivo: con el archivo completo, pasa (si no, las de arriba no prueban nada).
  escribir(ui, UI_OK(ambas));
  r = check(s);
  assert.strictEqual(r.rc, 0, r.out);

  // Las formas que un revisor escribe de verdad también pasan (pase adversarial, clases 7/11/12; revisores, negrita):
  // la lista en una línea con comillas invertidas, y el veredicto en negrita.
  escribir(ui, '**veredicto**: OK\nscreens: `src/components/Facturas.tsx`, `src/components/Detalle.tsx`\ncaptures: ninguna — sin E2E en esta prueba\n');
  r = check(s);
  assert.strictEqual(r.rc, 0, r.out);
});

test('T11 UiTexts_CasosDelPaseAdversarial', () => {
  const ui = require('../lib/ui-texts.js');
  const textos = (src) => ui.visibleTexts(src).map((t) => t.text);
  // clase 1: JSX dentro de una expresión (render condicional)
  assert.ok(textos('<div>{err && <p>Ocurrió un error al guardar</p>}</div>').includes('Ocurrió un error al guardar'));
  assert.ok(textos('<p>{ok ? <b>Todo salió bien</b> : null}</p>').includes('Todo salió bien'));
  // clase 2: un mensaje en minúsculas no es una lista de clases CSS
  assert.ok(textos("setError('no se pudo guardar el cambio');").includes('no se pudo guardar el cambio'));
  assert.ok(!textos('<div className={cond ? "flex items-center" : "hidden md:block"} />').includes('flex items-center'));
  // clase 5: una plantilla que cruza líneas
  assert.ok(textos('const m = `Error al guardar\n  el registro ahora`;').includes('Error al guardar el registro ahora'));
  // clase 6: las entidades HTML se leen como la letra que ve el usuario
  assert.ok(textos('<p>Contrase&ntilde;a no v&aacute;lida</p>').includes('Contraseña no válida'));
  // clase 8 / revisores: la plantilla tiene que producir la cita ENTERA; una plantilla de puros huecos no produce nada
  assert.strictEqual(ui.quoteMatchesText('Tiene 1 facturas sin pagar', 'Tiene ${n} facturas sin pagar.'), true);
  assert.strictEqual(ui.quoteMatchesText('Tiene 1 facturas sin pagar desde marzo del año pasado', 'Tiene ${n} facturas'), false);
  assert.strictEqual(ui.quoteMatchesText('cualquier frase larga del revisor', '${a} ${b}'), false);
  // clase 4: interpolación de Vue
  const tmp = fs.mkdtempSync(path.join(TMP, 'vue-'));
  const vue = path.join(tmp, 'Facturas.vue');
  fs.writeFileSync(vue, '<template>\n  <p>Tiene {{ n }} facturas pendientes</p>\n</template>\n');
  const hits = ui.whereInScreens('Tiene 1 facturas pendientes', [{ rel: 'Facturas.vue', abs: vue }]);
  assert.strictEqual(hits.length, 1, JSON.stringify(hits));
  // Una pantalla que no se puede leer no da la marca por resuelta: se dice.
  const nada = ui.whereInScreens('Tiene 1 facturas pendientes', [{ rel: 'NoEsta.vue', abs: path.join(tmp, 'NoEsta.vue') }]);
  assert.ok(nada.some((h) => h.unreadable), JSON.stringify(nada));

  // Vuelta 2 de revisores — ramas del extractor que no tenían prueba:
  assert.ok(textos('<p>Contrase&#241;a no v&#xE1;lida</p>').includes('Contraseña no válida'));   // entidades numéricas
  assert.ok(textos('<p>{"Pagar todas juntas"}</p>').includes('Pagar todas juntas'));             // {"texto"} es texto
  assert.ok(!textos('<p>{/* esto no lo ve nadie */}Pagar ahora</p>').some((t) => /nadie/.test(t)));  // comentario de JSX
  assert.ok(!textos("const a = './ruta/de/algo'; const b = '@empresa/paquete lindo';").length);     // rutas y paquetes
  // Seguridad: una entidad fuera de rango no tumba el candado; queda como está.
  assert.doesNotThrow(() => textos('<p>Valor raro &#x110000; y &#99999999; acá</p>'));
  // Seguridad: muchos huecos y una cita larga que no coincide terminan rápido (sin explosión de caminos).
  const huecos = Array.from({ length: 40 }, (_x, i) => `{v${i}}`).join(' ');
  const cita = Array.from({ length: 120 }, () => 'palabra').join(' ') + ' final';
  const t0 = Date.now();
  assert.strictEqual(ui.quoteMatchesText(cita, `Inicio ${huecos} fin del mensaje`), false);
  assert.ok(Date.now() - t0 < 1000, `tardó ${Date.now() - t0} ms`);
});

test('T12 UiReadability_PantallaDeclaradaQueNoEsta_Frena', () => {
  const repo = mundo();
  escribir(path.join(repo, 'src', 'components', 'Facturas.tsx'), 'export const F = () => <p>Te faltan pagar 2 facturas.</p>;\n');
  // files_to_create, files_to_modify y el File List cuentan; la que no está en el disco frena (no se puede revisar).
  const p = story(repo, ['src/components/Facturas.tsx']);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
    .replace('files_to_modify:', 'files_to_create:\n  - src/components/Nueva.tsx\nfiles_to_modify:')
    + '\n## Dev Agent Record\n\n### File List\n\n- src/components/Detalle.tsx\n');
  const qa = guiaLista(repo);
  escribir(path.join(qa, '1.1-legibilidad-ui.md'), UI_OK(['src/components/Facturas.tsx']));
  let r = check(p);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /Nueva\.tsx/, r.out);
  assert.match(r.out, /Detalle\.tsx/, r.out);
  // Con las dos en el disco y leídas, pasa.
  escribir(path.join(repo, 'src', 'components', 'Nueva.tsx'), 'export const N = () => <h2>Factura nueva</h2>;\n');
  escribir(path.join(repo, 'src', 'components', 'Detalle.tsx'), 'export const D = () => <h2>Detalle de la factura</h2>;\n');
  escribir(path.join(qa, '1.1-legibilidad-ui.md'), UI_OK(['src/components/Facturas.tsx', 'src/components/Nueva.tsx', 'src/components/Detalle.tsx']));
  r = check(p);
  assert.strictEqual(r.rc, 0, r.out);

  // Una pantalla que está pero no se puede leer también frena, haya o no marcas (revisores, vuelta 2). En Windows los
  // permisos de archivo no se pueden quitar así: se saltea con constancia.
  if (process.platform === 'win32') { console.log('# T12: sin chmod en Windows — el caso de la pantalla ilegible no se midió'); return; }
  const nueva = path.join(repo, 'src', 'components', 'Nueva.tsx');
  fs.chmodSync(nueva, 0o000);
  try {
    r = check(p);
    assert.strictEqual(r.rc, 2, r.out);
    assert.match(r.out, /Nueva\.tsx/, r.out);
  } finally { fs.chmodSync(nueva, 0o644); }
});

test('T14 UiReadability_ConfigDeAcompanantes_SeDice', () => {
  const repo = mundo();
  escribir(path.join(repo, 'src', 'components', 'Facturas.tsx'), 'export const F = () => <p>Te faltan pagar 2 facturas.</p>;\n');
  const s = story(repo, ['src/components/Facturas.tsx']);
  const qa = guiaLista(repo);
  escribir(path.join(qa, '1.1-legibilidad-ui.md'), UI_OK(['src/components/Facturas.tsx']));
  // Un repo acompañante declarado que no existe: las pantallas se buscan igual, pero se dice (no en silencio).
  escribir(path.join(repo, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - RepoQueNoExiste\n');
  let r = check(s);
  assert.strictEqual(r.rc, 0, r.out);
  assert.match(r.out, /RepoQueNoExiste/, r.out);
  if (process.platform === 'win32') { console.log('# T14: sin chmod en Windows — el yaml ilegible no se midió'); return; }
  const yaml = path.join(repo, '.tycon', 'advisors.yaml');
  fs.chmodSync(yaml, 0o000);
  try {
    r = check(s);
    assert.match(r.out, /no pude leer .*advisors\.yaml/i, r.out);
  } finally { fs.chmodSync(yaml, 0o644); }
});

test('T13 QaGuide_UiTexts_ListaPorPantalla', () => {
  const repo = mundo();
  escribir(path.join(repo, 'src', 'components', 'Facturas.tsx'), 'export const F = ({ n }) => <section className="p-4"><h2>Facturas del mes</h2><p>{`Te faltan pagar ${n} facturas.`}</p></section>;\n');
  const s = story(repo, ['src/components/Facturas.tsx']);
  const env = { ...process.env, HOME };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('node', [QA, '--story', s, '--ui-texts'], { encoding: 'utf8', input: '', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /## src\/components\/Facturas\.tsx/);
  assert.match(r.stdout, /- Facturas del mes/);
  assert.match(r.stdout, /- Te faltan pagar \$\{n\} facturas\./);
  assert.doesNotMatch(r.stdout, /p-4/);
});

test('T3 UiReadability_MarcaResueltaSoloEnGuia_Rechaza', () => {
  const repo = mundo();
  const tsx = path.join(repo, 'src', 'components', 'Facturas.tsx');
  const s = story(repo, ['src/components/Facturas.tsx']);
  const marca = '- «Tiene 1 facturas sin pagar» — no se entiende si es una o varias — resuelta en la guía\n';
  const qa = guiaLista(repo, `veredicto: OK\n${marca}`);
  escribir(path.join(qa, '1.1-legibilidad-ui.md'), UI_OK(['src/components/Facturas.tsx']));

  escribir(tsx, 'export const F = () => <p>Tiene 1 facturas sin pagar</p>;\n');
  let r = check(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /Tiene 1 facturas sin pagar/, r.out);
  assert.match(r.out, /Facturas\.tsx/, r.out);

  // Mensaje armado: las partes fijas siguen en el código aunque el número salga de una variable.
  escribir(tsx, 'export const F = ({ n }) => <p>{`Tiene ${n} facturas sin pagar.`}</p>;\n');
  r = check(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /Facturas\.tsx/, r.out);

  // Con la pantalla corregida, pasa.
  escribir(tsx, 'export const F = ({ n }) => <p>{`Te faltan pagar ${n} facturas.`}</p>;\n');
  r = check(s);
  assert.strictEqual(r.rc, 0, r.out);

  // `keep:` deja la marca, pero se dice.
  escribir(tsx, 'export const F = () => <p>Tiene 1 facturas sin pagar</p>;\n');
  guiaLista(repo, `veredicto: OK\n${marca.trim()} — keep: el dueño pidió este texto tal cual\n`);
  r = check(s);
  assert.strictEqual(r.rc, 0, r.out);
  assert.match(r.out, /Tiene 1 facturas sin pagar/, r.out);

  // Una cita de dos palabras (un botón nombrado en un paso) no es una marca sobre la pantalla.
  escribir(tsx, 'export const F = () => <button>Pagar ahora</button>;\n');
  guiaLista(repo, 'veredicto: OK\n- el paso dice «Pagar ahora» sin decir dónde está el botón — resuelta en la guía\n');
  r = check(s);
  assert.strictEqual(r.rc, 0, r.out);
});

test('T4 UiReadability_StorySinPantalla_NoExige', () => {
  const repo = mundo();
  escribir(path.join(repo, 'src', 'Facturas', 'FacturasService.cs'), 'public class FacturasService {}\n');
  const s = story(repo, ['src/Facturas/FacturasService.cs']);
  const r = check(s);
  assert.strictEqual(r.rc, 0, r.out);
  assert.doesNotMatch(r.out, /legibilidad-ui/, r.out);
});

test('T6 StoryValidator_ACConIdsAlUsuario_Warning — los dos casos del banco', () => {
  const banco = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'controls-bench', 'cases', 'advisors', 'tycon-story-validator.json'), 'utf8'));
  const deW16 = banco.cases.filter((c) => c.rule === 'VAL-W16');
  const marca = deW16.find((c) => c.type === 'must-flag');
  const limpio = deW16.find((c) => c.type === 'must-not-flag');
  assert.ok(marca && marca.expect_veredicto === 'hallazgos', 'falta el caso must-flag de VAL-W16');
  assert.ok(limpio && limpio.expect_veredicto === 'sin-la-regla', 'falta el caso must-not-flag de VAL-W16');
  const storyDe = (c) => Object.entries(c.files).find(([k]) => k.startsWith('specs/'))[1];
  assert.match(storyDe(marca), /idFactura/);
  assert.match(storyDe(limpio), /idFactura/);
});

test('T7 Step08_CierreConPantalla_MuestraCapturas', () => {
  const txt = fs.readFileSync(path.join(SK, '..', 'steps', 'step-08-commit-prep.md'), 'utf8');
  assert.match(txt, /Así se ve: ¿se entiende\?/);
  assert.match(txt, /## Capturas/);
  assert.match(txt, /antes de pedir el commit/i);
});

test('T8 UiTexts_ExtraeTextosVisibles_SinCodigo', () => {
  const { visibleTexts } = require('../lib/ui-texts.js');
  const src = [
    "import { Boton } from './Boton';",
    "export function Lista({ n, onPagar }) {",
    "  return (",
    '    <div className="flex items-center gap-2" data-testid="lista-facturas" key="k1">',
    '      <h2>Facturas del mes</h2>',
    '      <input placeholder="Buscar por número" aria-label="Buscador de facturas" />',
    '      <p>{`Te faltan pagar ${n} facturas.`}</p>',
    '      <Boton title="Pagar todas juntas" onClick={onPagar}>Pagar</Boton>',
    "      {console.log('render de la lista')}",
    '    </div>',
    '  );',
    '}',
  ].join('\n');
  const textos = visibleTexts(src).map((t) => t.text);
  for (const esperado of ['Facturas del mes', 'Buscar por número', 'Buscador de facturas', 'Te faltan pagar ${n} facturas.', 'Pagar todas juntas', 'Pagar']) {
    assert.ok(textos.includes(esperado), `falta «${esperado}» en ${JSON.stringify(textos)}`);
  }
  for (const fuera of ['flex items-center gap-2', 'lista-facturas', 'k1', './Boton', 'render de la lista']) {
    assert.ok(!textos.includes(fuera), `no debía salir «${fuera}»: ${JSON.stringify(textos)}`);
  }
});

test('T10 PipelineQaReadability_ScopeUi_AnotaLaMarca', () => {
  const repo = mundo();
  const s = story(repo, ['src/components/Facturas.tsx']);
  const gates = path.join(HOME, '.claude', '.tycon-pipeline', 'gates.log');
  const env = { ...process.env, HOME };
  delete env.NODE_TEST_CONTEXT;
  const correr = (...extra) => spawnSync('node', [path.join(SK, 'pipeline.js'), 'qa-readability', '--story', s, '--repo', repo, '--marks', '2', ...extra], { encoding: 'utf8', input: '', env });
  let r = correr('--scope', 'ui');
  assert.strictEqual(r.status, 0, r.stderr);
  const lineas = fs.readFileSync(gates, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lineas.some((l) => l.name === 'qa-legibilidad-ui' && l.marcas === 2 && l.storyId === '1.1'), JSON.stringify(lineas.slice(-2)));
  r = correr('--scope', 'pantalla');
  assert.strictEqual(r.status, 2, 'un --scope que no existe no se anota');
  // pase adversarial, clase 14: `--scope` sin valor no se anota como la marca de la guía
  r = correr('--scope');
  assert.strictEqual(r.status, 2, '--scope sin valor no se anota');
});

test('T9 Step01_ValW16_NoAutoContinua', () => {
  const paso1 = fs.readFileSync(path.join(SK, '..', 'steps', 'step-01-validate-story.md'), 'utf8');
  const lista = paso1.split('\n').find((l) => /whitelist de formato cosmético/.test(l)) || '';
  assert.ok(lista, 'no encontré la línea de la lista que auto-continúa');
  assert.doesNotMatch(lista, /VAL-W16/);
  const validador = fs.readFileSync(path.join(RAIZ, 'agents', 'tycon-story-validator.md'), 'utf8');
  const catalogo = fs.readFileSync(path.join(RAIZ, 'guides', 'advisor-rules-catalog.md'), 'utf8');
  assert.match(validador, /\[VAL-W16\]/);
  assert.match(catalogo, /\*\*VAL-W16\*\*/);
});
