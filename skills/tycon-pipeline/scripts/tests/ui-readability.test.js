#!/usr/bin/env node
/**
 * ui-readability.test.js — la pantalla se revisa con ojos de usuario.
 *
 * Qué cubre: una pantalla puede pasar todos los controles y aun así ser «inentendible» para quien la
 * usa. Si la revisión de legibilidad sólo lee la guía del tester, sus marcas se resuelven reescribiendo la guía y el
 * texto malo sigue en la pantalla.
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

  // Una captura nombrada que no existe frena.
  escribir(ui, UI_OK(ambas).replace(/captures:.*\n/, 'captures:\n  - /no/existe/01-lista.png\n'));
  r = check(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /01-lista\.png/, r.out);

  // Control positivo: con el archivo completo, pasa (si no, las de arriba no prueban nada).
  escribir(ui, UI_OK(ambas));
  r = check(s);
  assert.strictEqual(r.rc, 0, r.out);

  // Las formas que un revisor escribe de verdad también pasan:
  // la lista en una línea con comillas invertidas, y el veredicto en negrita.
  escribir(ui, '**veredicto**: OK\nscreens: `src/components/Facturas.tsx`, `src/components/Detalle.tsx`\ncaptures: ninguna — sin E2E en esta prueba\n');
  r = check(s);
  assert.strictEqual(r.rc, 0, r.out);
});

test('T11 UiTexts_CasosDelPaseAdversarial', () => {
  const ui = require('../lib/ui-texts.js');
  const textos = (src) => ui.visibleTexts(src).map((t) => t.text);
  // JSX dentro de una expresión (render condicional)
  assert.ok(textos('<div>{err && <p>Ocurrió un error al guardar</p>}</div>').includes('Ocurrió un error al guardar'));
  assert.ok(textos('<p>{ok ? <b>Todo salió bien</b> : null}</p>').includes('Todo salió bien'));
  // un mensaje en minúsculas no es una lista de clases CSS
  assert.ok(textos("setError('no se pudo guardar el cambio');").includes('no se pudo guardar el cambio'));
  assert.ok(!textos('<div className={cond ? "flex items-center" : "hidden md:block"} />').includes('flex items-center'));
  // una plantilla que cruza líneas
  assert.ok(textos('const m = `Error al guardar\n  el registro ahora`;').includes('Error al guardar el registro ahora'));
  // las entidades HTML se leen como la letra que ve el usuario
  assert.ok(textos('<p>Contrase&ntilde;a no v&aacute;lida</p>').includes('Contraseña no válida'));
  // la plantilla tiene que producir la cita ENTERA; una plantilla de puros huecos no produce nada
  assert.strictEqual(ui.quoteMatchesText('Tiene 1 facturas sin pagar', 'Tiene ${n} facturas sin pagar.'), true);
  assert.strictEqual(ui.quoteMatchesText('Tiene 1 facturas sin pagar desde marzo del año pasado', 'Tiene ${n} facturas'), false);
  assert.strictEqual(ui.quoteMatchesText('cualquier frase larga del revisor', '${a} ${b}'), false);
  // interpolación de Vue
  const tmp = fs.mkdtempSync(path.join(TMP, 'vue-'));
  const vue = path.join(tmp, 'Facturas.vue');
  fs.writeFileSync(vue, '<template>\n  <p>Tiene {{ n }} facturas pendientes</p>\n</template>\n');
  const hits = ui.whereInScreens('Tiene 1 facturas pendientes', [{ rel: 'Facturas.vue', abs: vue }]);
  assert.strictEqual(hits.length, 1, JSON.stringify(hits));
  // Una pantalla que no se puede leer no da la marca por resuelta: se dice.
  const nada = ui.whereInScreens('Tiene 1 facturas pendientes', [{ rel: 'NoEsta.vue', abs: path.join(tmp, 'NoEsta.vue') }]);
  assert.ok(nada.some((h) => h.unreadable), JSON.stringify(nada));

  // Ramas del extractor:
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

  // Una pantalla que está pero no se puede leer también frena, haya o no marcas. En Windows los
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
  // `--scope` sin valor no se anota como la marca de la guía
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

// ── lo construido se compara contra la maqueta aprobada con el plan ──────────────────────────
const MOCKUP = path.join(SK, 'mockup.js');
const PANTALLA_730 = 'src/components/Facturas.tsx';
// la maqueta la arma mockup.js; el archivo de aprobación lo escribe la prueba con la huella real (como marker.js)
function maquetaAprobada(storyPath, elements, { sha } = {}) {
  const model = JSON.stringify({ title: 'La lista de facturas', screens: [{ name: 'Lista de facturas', state: 'con facturas', elements }] });
  const r = spawnSync('node', [MOCKUP, 'render', '--data', '-', '--story', storyPath], { encoding: 'utf8', input: model, env: { ...process.env, HOME } });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const ap = path.join(path.dirname(out.out), '1.1-mockup-approval.json');
  escribir(ap, JSON.stringify({ schema: 1, story: '1.1', file: '1.1-mockup.html', sha256: sha || out.sha256, approvedAt: '2026-10-16T12:00:00Z' }));
  return { ...out, approval: ap };
}
function checkCon(storyPath, extra = []) {
  const env = { ...process.env, HOME };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('node', [QA, '--story', storyPath, '--check', ...extra], { encoding: 'utf8', input: '', env });
  return { rc: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const UI_730 = (extra = '') => `${UI_OK([PANTALLA_730])}mockup: 1.1-mockup.html\n${extra}`;
const BASICOS_730 = [{ kind: 'heading', text: 'Facturas pendientes' }, { kind: 'button', text: 'Pagar seleccionadas' }];
function mundoMaqueta(pantalla, elements, uiExtra) {
  const repo = mundo();
  escribir(path.join(repo, PANTALLA_730), pantalla);
  const s = story(repo, [PANTALLA_730]);
  const qa = guiaLista(repo);
  const mq = maquetaAprobada(s, elements);
  escribir(path.join(qa, '1.1-legibilidad-ui.md'), UI_730(uiExtra));
  return { repo, s, qa, mq };
}
const PANTALLA_OK = 'export const F = () => <div><h1>Facturas pendientes</h1><button>Pagar seleccionadas</button></div>;\n';
// mensaje armado con un hueco, una función `onPagar` y ningún botón
const PANTALLA_T20 = "export const F = ({ n }) => { const onPagar = () => n; return <p onClick={onPagar}>{`Tiene ${n} facturas sin pagar.`}</p>; };\n";
const MAQUETA_T20 = [{ kind: 'button', text: 'Dar de baja' }, { kind: 'button', text: 'Pagar' }, { kind: 'message', tone: 'info', text: 'Tiene 3 facturas sin pagar' }];

test('7.30-T18 UiReadability_MaquetaCambiada_PideReaprobar @story-7.30 @ac-16', () => {
  const { s, mq } = mundoMaqueta(PANTALLA_OK, BASICOS_730);
  let r = checkCon(s);
  assert.strictEqual(r.rc, 0, r.out);
  // la maqueta se vuelve a armar con otro texto y nadie la aprueba de nuevo
  const model = JSON.stringify({ title: 'X', screens: [{ name: 'Lista de facturas', state: 'e', elements: [{ kind: 'heading', text: 'Facturas por pagar' }] }] });
  spawnSync('node', [MOCKUP, 'render', '--data', '-', '--out', mq.out], { encoding: 'utf8', input: model });
  r = checkCon(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /\(9\) la maqueta cambió después de aprobada \(aprobada [0-9a-f]{12}, hoy [0-9a-f]{12}\)/);
  assert.match(r.out, /marker\.js approve-mockup --approved/);
  fs.unlinkSync(mq.out);
  r = checkCon(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.ok(r.out.includes(mq.out), r.out);
});

test('7.30-T19 UiReadability_AprobacionAusenteOIlegible @story-7.30 @ac-17 @ac-18', () => {
  const { s, mq } = mundoMaqueta(PANTALLA_OK, BASICOS_730);
  fs.unlinkSync(mq.approval);
  let r = checkCon(s);
  assert.strictEqual(r.rc, 0, r.out);
  assert.match(r.out, /sin maqueta aprobada: no se compara \(story aprobada antes de la 7\.30, o fuera del pipeline\)/);
  r = checkCon(s, ['--mockup-sha', mq.sha256]);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /el pipeline aprobó una maqueta \([0-9a-f]{12}\) y su aprobación no está en el repo/);
  escribir(mq.approval, '{roto');
  r = checkCon(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /no pude leer la aprobación de la maqueta/);
  escribir(mq.approval, JSON.stringify({ schema: 1, story: '1.1', file: '1.1-mockup.html', sha256: mq.sha256, approvedAt: 'x' }));
  r = checkCon(s, ['--mockup-sha', 'b'.repeat(64)]);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /y la del repo es otra \([0-9a-f]{12}\)/);
});

test('7.30-T20 UiReadability_TextoDeLaMaquetaQueFalta_Frena @story-7.30 @ac-19', () => {
  const { s, qa } = mundoMaqueta(PANTALLA_T20, MAQUETA_T20);
  let r = checkCon(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /\(10\) la maqueta muestra el button «Dar de baja» \(pantalla «Lista de facturas»\) y no está en ninguna pantalla de la story/);
  assert.match(r.out, /\(10\) la maqueta muestra el button «Pagar»/);
  assert.doesNotMatch(r.out, /«Tiene 3 facturas sin pagar» \(pantalla/);
  assert.match(r.out, /differs:/);
  escribir(path.join(qa, '1.1-legibilidad-ui.md'), UI_OK([PANTALLA_730]));
  r = checkCon(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /mockup: 1\.1-mockup\.html/);
});

test('7.30-T21 UiReadability_DiferenciaDeclarada_PasaYSeImprime @story-7.30 @ac-20', () => {
  const declaradas = '- «Dar de baja» — differs: el texto vive en el archivo de idioma\n- «Pagar» — differs: el botón sale del componente compartido\n';
  const { s, qa } = mundoMaqueta(PANTALLA_T20, MAQUETA_T20, declaradas);
  let r = checkCon(s);
  assert.strictEqual(r.rc, 0, r.out);
  assert.match(r.out, /diferencia declarada con la maqueta: «Dar de baja» — differs: el texto vive en el archivo de idioma/);
  escribir(path.join(qa, '1.1-legibilidad-ui.md'), UI_730('- «Dar de baja» — differs:\n- «Pagar» — differs: el botón sale del componente compartido\n'));
  r = checkCon(s);
  assert.strictEqual(r.rc, 2, r.out);
  assert.match(r.out, /«Dar de baja»/);
  // una diferencia declarada de un texto que SÍ está en la pantalla no es una marca de la capa 8
  escribir(path.join(qa, '1.1-legibilidad-ui.md'), UI_730(`${declaradas}- «Tiene 3 facturas sin pagar» — differs: quedó igual, por si cambia\n`));
  r = checkCon(s);
  assert.strictEqual(r.rc, 0, r.out);
  assert.doesNotMatch(r.out, /\(8\)/);
});

test('7.30-T22 UiReadability_SobranYPantallaIlegible @story-7.30 @ac-21 @ac-22', (t) => {
  const pantalla = 'export const F = () => <div><h1>Facturas pendientes</h1><button>Pagar seleccionadas</button><p>Ver el detalle de la factura</p></div>;\n';
  const { repo, s } = mundoMaqueta(pantalla, BASICOS_730);
  let r = checkCon(s);
  assert.strictEqual(r.rc, 0, r.out);
  assert.match(r.out, /en la pantalla y no en la maqueta: «Ver el detalle de la factura» \(src\/components\/Facturas\.tsx:\d+\)/);
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) { t.diagnostic('pantalla ilegible: no medible acá (constancia, no verde)'); return; }
  const abs = path.join(repo, PANTALLA_730);
  fs.chmodSync(abs, 0o000);
  try {
    r = checkCon(s);
    assert.strictEqual(r.rc, 2, r.out);
    assert.match(r.out, /\(10\) no pude leer la pantalla src\/components\/Facturas\.tsx/);
  } finally { fs.chmodSync(abs, 0o644); }
});

test('7.30-T23 QaGuide_UiTexts_TraeLaComparacion @story-7.30 @ac-23', () => {
  const pantalla = PANTALLA_T20.replace('</p>;', '</p> && <span>Ver el detalle de la factura</span>;');
  const { s } = mundoMaqueta(pantalla, MAQUETA_T20, '- «Pagar» — differs: el botón sale del componente compartido\n');
  const env = { ...process.env, HOME };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('node', [QA, '--story', s, '--ui-texts'], { encoding: 'utf8', input: '', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const sec = r.stdout.slice(r.stdout.indexOf('## Maqueta aprobada (1.1-mockup.html)'));
  assert.ok(r.stdout.includes('## Maqueta aprobada (1.1-mockup.html)'), r.stdout);
  assert.ok(sec.includes('Dar de baja'), sec);
  assert.match(sec, /Ver el detalle de la factura/);
  assert.match(sec, /Pagar.*differs: el botón sale del componente compartido/);
});

test('7.30-T25 Pasos_Step03Step07cYStep08_DicenLaMaqueta @story-7.30 @ac-25', () => {
  const leer = (f) => fs.readFileSync(path.join(SK, '..', 'steps', f), 'utf8');
  const p3 = leer('step-03-hitl-plan.md');
  for (const x of ['mockup.js status', 'mockup.js render', 'mockup.js texts', '--mockup-approved', 'AskUserQuestion']) assert.ok(p3.includes(x), `paso 3 sin ${x}`);
  assert.match(p3, /LOW[^\n]*maqueta|maqueta[^\n]*LOW/);
  assert.match(p3, /opciones numeradas/);
  assert.match(p3, /delegación/);
  const p7 = leer('step-07c-dod-runtime-gate.md');
  for (const x of ['mockup:', 'differs:', 'mockup-compare: no', '(9)', '(10)']) assert.ok(p7.includes(x), `paso 7c sin ${x}`);
  const p8 = leer('step-08-commit-prep.md');
  for (const x of ['-mockup.html', '-mockup-approval.json']) assert.ok(p8.includes(x), `paso 8 sin ${x}`);
});

test('7.30-T26 UiReadability_SinPantallasEnElDisco_TieneSalida @story-7.30 @ac-22', () => {
  // (a) la pantalla declarada no está en el disco
  {
    const repo = mundo();
    const s = story(repo, [PANTALLA_730]);
    const qa = guiaLista(repo);
    maquetaAprobada(s, BASICOS_730);
    escribir(path.join(qa, '1.1-legibilidad-ui.md'), UI_730());
    const r = checkCon(s);
    assert.strictEqual(r.rc, 2, r.out);
    assert.match(r.out, /no se puede comparar contra la maqueta: no encontré pantallas de la story en el disco/);
    assert.match(r.out, /mockup-compare: no — <motivo>/);
  }
  // (b) Razor y (c) un ítem `- path:`: el detector ve pantalla, el buscador de archivos no
  for (const archivo of ['frontend/Pages/Facturas.razor', 'path: src/components/Facturas.tsx']) {
    const repo = mundo();
    if (archivo.startsWith('path:')) escribir(path.join(repo, PANTALLA_730), PANTALLA_OK);
    else escribir(path.join(repo, archivo), '<h1>Facturas pendientes</h1>\n');
    const s = story(repo, [archivo]);
    const qa = guiaLista(repo);
    maquetaAprobada(s, BASICOS_730);
    const ui = path.join(qa, '1.1-legibilidad-ui.md');
    escribir(ui, `veredicto: OK\nscreens:\ncaptures: ninguna — sin E2E en esta prueba\nmockup: 1.1-mockup.html\n`);
    let r = checkCon(s);
    assert.strictEqual(r.rc, 2, `${archivo}\n${r.out}`);
    assert.match(r.out, /no encontré pantallas de la story en el disco \(busco \.tsx, \.jsx, \.vue, \.svelte en files_to_create, files_to_modify y la File List\)/);
    escribir(ui, `veredicto: OK\nscreens:\ncaptures: ninguna — sin E2E en esta prueba\nmockup: 1.1-mockup.html\nmockup-compare: no — las pantallas son Razor\n`);
    r = checkCon(s);
    assert.strictEqual(r.rc, 0, `${archivo}\n${r.out}`);
    assert.match(r.out, /comparación con la maqueta declarada imposible: las pantallas son Razor/);
    // un `mockup-compare: no —` sin motivo no toma la línea de abajo como motivo
    escribir(ui, `veredicto: OK\nscreens:\ncaptures: ninguna — sin E2E en esta prueba\nmockup: 1.1-mockup.html\nmockup-compare: no —\n- otra línea\n`);
    r = checkCon(s);
    assert.strictEqual(r.rc, 2, `${archivo}\n${r.out}`);
  }
});

// ── las pantallas del repo hermano, en el worktree de la rama de la story ───────────────

const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-19T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-19T12:00:00Z' };
function gitEn(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function commitTodo(dir, msg) {
  gitEn(dir, 'add', '-A');
  gitEn(dir, '-c', 'user.email=lab@lab', '-c', 'user.name=lab', 'commit', '-q', '-m', msg);
}
/**
 * Specs (la story de prueba, que declara a Front) y Front (el código), cada uno con su worktree en una rama de nombre distinto
 * que nombra la story. La pantalla nueva vive sólo en el worktree de Front; en el checkout principal hay otra versión.
 * `frontRama: null` → Front sin worktree (el principal queda en `main`).
 */
function hermanos({ declarada = 'Front/src/components/Facturas.tsx', frontRama = 'feat/facturas-1-1-pantalla' } = {}) {
  const dir = path.join(TMP, `h${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const raiz = fs.realpathSync(dir);
  const specs = path.join(raiz, 'Specs');
  const front = path.join(raiz, 'Front');
  for (const r of [specs, front]) { fs.mkdirSync(r, { recursive: true }); spawnSync('git', ['init', '-q', '-b', 'main', r], { stdio: 'ignore' }); }
  escribir(path.join(specs, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - Front\n');
  escribir(path.join(specs, 'README.md'), 'specs\n');
  commitTodo(specs, 'base');
  escribir(path.join(front, 'src', 'components', 'Vieja.tsx'), 'export const V = () => <p>La pantalla de main.</p>;\n');
  escribir(path.join(front, 'src', 'components', 'Facturas.tsx'), 'export const F = () => <p>Texto viejo del principal.</p>;\n');
  commitTodo(front, 'base');
  const specsWt = path.join(raiz, 'Specs-wt');
  gitEn(specs, 'worktree', 'add', '-q', '-b', 'docs/facturas-1-1-impl', specsWt);
  let frontWt = null;
  if (frontRama) {
    frontWt = path.join(raiz, 'Front-wt');
    gitEn(front, 'worktree', 'add', '-q', '-b', frontRama, frontWt);
    escribir(path.join(frontWt, 'src', 'components', 'Facturas.tsx'), 'export const F = () => <p>Te faltan pagar 2 facturas.</p>;\n');
    escribir(path.join(frontWt, 'src', 'components', 'Nueva.tsx'), 'export const N = () => <h2>Factura nueva</h2>;\n');
  }
  fs.mkdirSync(path.join(specsWt, '.advisors', 'dod-runtime'), { recursive: true });
  const s = story(specsWt, [declarada]);
  return { raiz, specsWt, front, frontWt, story: s };
}

test('UiReadability_PantallaEnElWorktreeDelHermano_Pasa @story-7.34 @ac-6 — la pantalla nueva del hermano se encuentra', () => {
  // 🔴 rojo si la guía busca en el checkout principal de Front (otra rama): «(7) pantallas que no están en el disco».
  const lab = hermanos({ declarada: 'Front/src/components/Nueva.tsx' });
  const qa = guiaLista(lab.specsWt);
  escribir(path.join(qa, '1.1-legibilidad-ui.md'), UI_OK(['Front/src/components/Nueva.tsx']));
  const r = check(lab.story);
  assert.strictEqual(r.rc, 0, r.out);
});

test('UiTexts_LasTresFormasDeNombrarAlHermano @story-7.34 @ac-6 — <hermano>/x, ../<hermano>/x y (<hermano>) x leen el worktree', () => {
  const env = { ...process.env, HOME };
  delete env.NODE_TEST_CONTEXT;
  for (const declarada of ['Front/src/components/Facturas.tsx', '../Front/src/components/Facturas.tsx', '(Front) src/components/Facturas.tsx']) {
    const lab = hermanos({ declarada });
    const r = spawnSync('node', [QA, '--story', lab.story, '--ui-texts'], { encoding: 'utf8', input: '', env });
    assert.strictEqual(r.status, 0, `${declarada}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /- Te faltan pagar 2 facturas\./, `${declarada}\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /Texto viejo del principal/, `${declarada}\n${r.stdout}`);
  }
  // Lo que nombra a un hermano no se busca en su checkout principal: la pantalla que falta en el worktree, falta.
  const lab = hermanos({ declarada: 'Front/src/components/Vieja.tsx' });
  fs.rmSync(path.join(lab.frontWt, 'src', 'components', 'Vieja.tsx'));
  const r = spawnSync('node', [QA, '--story', lab.story, '--ui-texts'], { encoding: 'utf8', input: '', env });
  assert.doesNotMatch(r.stdout, /La pantalla de main/, r.stdout);
});

test('QaGuide_HermanoEnOtraRama_AvisaEnUnaLinea @story-7.34 @ac-5 — sin worktree, la guía dice de qué rama lee', () => {
  const lab = hermanos({ frontRama: null });
  const env = { ...process.env, HOME };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('node', [QA, '--story', lab.story, '--ui-texts'], { encoding: 'utf8', input: '', env });
  assert.match(`${r.stdout}\n${r.stderr}`, /Front[^\n]*checkout principal[^\n]*rama main/, `${r.stdout}\n${r.stderr}`);
});

test('ScreenFiles_MismaRutaEnDosRepos_SeRevisanLasDos @story-7.34 @ac-6 — (A) x y (B) x son dos pantallas', () => {
  // 🔴 Sin el repo en la clave, se deduplicaría por la ruta y la segunda pantalla no se revisaba ni faltaba.
  const ui = require(path.join(SK, 'lib', 'ui-texts.js'));
  const dir = fs.mkdtempSync(path.join(TMP, 'dos-repos-'));
  escribir(path.join(dir, 'A', 'src', 'App.tsx'), 'export const A = () => <p>a</p>;\n');
  escribir(path.join(dir, 'B', 'src', 'App.tsx'), 'export const B = () => <p>b</p>;\n');
  const fm = 'files_to_modify:\n  - (A) src/App.tsx\n  - (B) src/App.tsx\n';
  const resolve = (e) => { const m = e.match(/^\((\w+)\)\s+(.+)$/); return m ? path.join(dir, m[1], m[2]) : undefined; };
  const r = ui.screenFiles(fm, '', [], resolve);
  assert.deepStrictEqual(r.found.map((s) => s.abs).sort(), [path.join(dir, 'A', 'src', 'App.tsx'), path.join(dir, 'B', 'src', 'App.tsx')]);
  fs.rmSync(path.join(dir, 'A', 'src', 'App.tsx'));
  const sinA = ui.screenFiles(fm, '', [], resolve);
  assert.deepStrictEqual(sinA.found.map((s) => s.abs), [path.join(dir, 'B', 'src', 'App.tsx')]);
  assert.strictEqual(sinA.missing.length, 1, JSON.stringify(sinA));
});

test('QaGuide_RepoPropioEntreParentesis_LeeElWorktree @story-7.34 @ac-6 — (<repo de la story>) x desde su worktree', () => {
  // 🔴 `(Specs) x` caería a la carpeta vecina `Specs`, que puede ser el checkout principal en otra rama.
  const lab = hermanos({ declarada: '(Specs) src/Propia.tsx' });
  escribir(path.join(lab.raiz, 'Specs', 'src', 'Propia.tsx'), 'export const P = () => <p>La de main.</p>;\n');
  escribir(path.join(lab.specsWt, 'src', 'Propia.tsx'), 'export const P = () => <p>La de la rama.</p>;\n');
  const env = { ...process.env, HOME };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('node', [QA, '--story', lab.story, '--ui-texts'], { encoding: 'utf8', input: '', env });
  assert.match(r.stdout, /- La de la rama\./, r.stdout);
  assert.doesNotMatch(r.stdout, /La de main/, r.stdout);
});

test('QaGuide_RepoEntreParentesis_NoSaleDelRepo @story-7.34 @ac-6 — (<hermano>) ../../x no sale de su repo', () => {
  // 🔴 rojo si la forma con paréntesis une la raíz y la ruta sin la guarda de las otras dos formas.
  const lab = hermanos({ declarada: '(Front) ../Afuera.tsx' });
  escribir(path.join(lab.raiz, 'Afuera.tsx'), 'export const X = () => <p>Fuera del repo.</p>;\n');
  const env = { ...process.env, HOME };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('node', [QA, '--story', lab.story, '--ui-texts'], { encoding: 'utf8', input: '', env });
  assert.doesNotMatch(r.stdout, /Fuera del repo/, r.stdout);
});

test('QaGuide_RepoDeLaStorySinGit_LoDice @story-7.34 @ac-6 — si git no identifica el repo de la story, se dice', () => {
  // 🔴 rojo si, sin git, `(<repo propio>) x` cae a la carpeta vecina sin aviso.
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'sin-git-')));
  const repo = path.join(raiz, 'Proj');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); // una carpeta .git que git no reconoce
  escribir(path.join(repo, 'src', 'X.tsx'), 'export const X = () => <p>Hola.</p>;\n');
  const s = story(repo, ['(Proj) src/X.tsx']);
  const env = { ...process.env, HOME };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('node', [QA, '--story', s, '--ui-texts'], { encoding: 'utf8', input: '', env });
  assert.match(`${r.stdout}\n${r.stderr}`, /no pude identificar el repo git de la story/, `${r.stdout}\n${r.stderr}`);
});
