#!/usr/bin/env node
/**
 * mockup.test.js — la maqueta de la pantalla antes de construirla (story 7.30).
 *
 * Hoy la pantalla se ve recién construida: un error de diseño se descubre cuando ya está programado y probado. La
 * maqueta es un HTML local, sin red y sin código, que el dueño aprueba con el plan; su huella queda anotada y la
 * revisión de la pantalla compara lo construido contra ella.
 *
 *   T1  render escribe un archivo sin red, con sus dos metas, y check lo acepta
 *   T2  datos inválidos: sale 2 nombrando el problema y no escribe nada
 *   T3  texto de relleno: sale 2; «Seleccionar todo», «VER TODO» y los datos de ejemplo no son relleno
 *   T4  lo que trae el JSON sale con el escape propio de la maqueta
 *   T5  check rechaza las cargas externas y lo que no generó el guion
 *   T6  texts lista sólo los textos que se comparan
 *   T7  status con y sin pantalla, con la misma clave que la guía del tester
 *   T8  la huella no cambia por los fines de línea de Windows
 *   T9  --open sin navegador dice la ruta
 *   T10 visual-plan.js se puede requerir sin correr y sale igual
 *   T24 los argumentos de qa-guide.js del paso 8 traen la huella aprobada
 *   T29 schema, demo y render por story
 *
 * El ejemplo es inventado a propósito (facturas): lo que se publica no lleva el rubro de un cliente.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/mockup.test.js < /dev/null
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SK = path.join(__dirname, '..');
const MOCKUP = path.join(SK, 'mockup.js');
const VISUAL = path.join(SK, 'visual-plan.js');
const MARKER = path.join(SK, 'marker.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* nada */ } });
const HOME = path.join(TMP, 'casa');
fs.mkdirSync(path.join(HOME, '.claude', '.tycon-pipeline', 'active'), { recursive: true });

function env(extra = {}) {
  const e = { ...process.env, HOME, USERPROFILE: HOME, TYCON_LANE_LLM: '0', ...extra };
  delete e.NODE_TEST_CONTEXT; // vacía no es borrada: dentro de node --test cambia cómo sale el hijo
  return e;
}
function run(args, opts = {}) {
  const r = spawnSync('node', [MOCKUP, ...args], { encoding: 'utf8', input: opts.input ?? '', env: env(opts.env), cwd: opts.cwd });
  return { rc: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}
function escribir(file, txt) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, txt); }

const MODELO = () => ({
  storyId: '1.1',
  title: 'La lista de facturas',
  screens: [
    {
      name: 'Lista de facturas',
      state: 'con facturas sin pagar',
      file: 'src/components/Facturas.tsx',
      elements: [
        { kind: 'heading', text: 'Facturas de Acme SA' },
        { kind: 'text', text: 'Tiene 3 facturas sin pagar.' },
        { kind: 'field', label: 'Buscar factura', placeholder: 'Número o fecha', value: '0001-00012345' },
        { kind: 'checkbox', label: 'Mostrar vencidas' },
        { kind: 'table', columns: ['Número', 'Vence', 'Importe'], rows: [['0001-00012345', '12/11', '$ 120.000']] },
        { kind: 'list', items: ['Primera cuota', 'Segunda cuota'] },
        { kind: 'message', tone: 'warn', text: 'Las facturas vencidas no se pueden pagar desde acá.' },
        { kind: 'button', text: 'Pagar seleccionadas', primary: true },
        { kind: 'link', text: 'Ver facturas pagadas' },
        { kind: 'box', text: 'Gráfico de vencimientos por mes' },
        { kind: 'box', text: 'Total a pagar este mes', compare: true },
      ],
    },
    { name: 'Lista de facturas', state: 'sin facturas', elements: [{ kind: 'text', text: 'No tiene facturas sin pagar.' }] },
  ],
  notes: 'para el dueño; no se compara',
});
let nm = 0;
function modeloEn(model) { const f = path.join(TMP, `modelo-${++nm}.json`); fs.writeFileSync(f, JSON.stringify(model)); return f; }
function renderModelo(model, out) { return run(['render', '--data', modeloEn(model), '--out', out]); }

// mundo — un repo git propio en su carpeta padre propia, con la story en specs/stories/.
let nw = 0;
function mundo() {
  const repo = path.join(TMP, `w${++nw}`, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'trabajo', repo], { stdio: 'ignore' });
  return repo;
}
function story(repo, archivos, extra = [], nombre = 'story-1.1-x.md', id = '1.1') {
  const p = path.join(repo, 'specs', 'stories', nombre);
  escribir(p, [
    '---', 'epic: 1', `story: "${id}"`, 'title: "La lista de facturas"', 'status: in-progress', ...extra,
    'files_to_modify:', ...archivos.map((a) => `  - ${a}`), '---', '', `# Story ${id}`, '',
    '## Acceptance Criteria', '', '1. **Given** un cliente con facturas **When** abre la lista **Then** ve cuántas le faltan pagar.', '',
    '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    '| T1 | `ListaDeFacturas_MuestraPendientes` | 1 | e2e | x | y |', '',
  ].join('\n'));
  return p;
}

test('T1 Mockup_Render_UnArchivoSinRed', () => {
  const out = path.join(TMP, 't1', 'm.html');
  const r = renderModelo(MODELO(), out);
  assert.strictEqual(r.rc, 0, r.all);
  const html = fs.readFileSync(out, 'utf8');
  for (const prohibido of [/<script/i, /\bsrc\s*=/i, /\bhref\s*=/i, /url\(/i]) assert.doesNotMatch(html, prohibido);
  assert.match(html, /<meta name="generator" content="tycon-mockup\/1">/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
  assert.match(html, /Lista de facturas/);
  assert.match(html, /sin facturas/);
  const res = JSON.parse(r.out);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.out, out);
  assert.match(res.sha256, /^[0-9a-f]{64}$/);
  assert.match(r.err, new RegExp(`abrila: ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.strictEqual(run(['check', out]).rc, 0);
  const demo = path.join(TMP, 't1', 'demo.html');
  assert.strictEqual(run(['demo', '--out', demo]).rc, 0);
  assert.strictEqual(run(['check', demo]).rc, 0, run(['check', demo]).all);
});

test('T2 Mockup_Render_DatosInvalidos_NoEscribe', () => {
  const out = path.join(TMP, 't2', 'm.html');
  escribir(out, 'ANTES');
  const conPantalla = (els) => ({ title: 'X', screens: [{ name: 'P', state: 'e', elements: els }] });
  const casos = [
    [['--data', path.join(TMP, 'no-existe.json')], /no pude leer --data/],
    [['--data', '-'], /JSON inválido/, '{roto'],
    [['--data', modeloEn({ screens: [] })], /title/],
    [['--data', modeloEn({ title: 'X' })], /screens/],
    [['--data', modeloEn({ title: 'X', screens: [{ name: 'P' }] })], /pantalla 1.*elements/],
    [['--data', modeloEn(conPantalla([{ kind: 'slider', text: 'a' }]))], /pantalla 1.*elemento 1.*slider/],
    [['--data', modeloEn(conPantalla([{ kind: 'heading', text: 'Hola' }, { kind: 'button' }]))], /pantalla 1.*elemento 2.*text/],
    [['--data', modeloEn(conPantalla([{ kind: 'text', text: 3 }]))], /elemento 1.*text/],
    [['--data', modeloEn(conPantalla([{ kind: 'table', columns: [] }]))], /elemento 1.*columns/],
    [['--data', modeloEn(conPantalla([{ kind: 'field', placeholder: 'x' }]))], /elemento 1.*label/],
  ];
  assert.strictEqual(casos.length, 10);
  for (const [args, re, input] of casos) {
    const r = run(['render', ...args, '--out', out], { input: input ?? '' });
    assert.strictEqual(r.rc, 2, `${args.join(' ')}\n${r.all}`);
    assert.match(r.err, re, r.all);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'ANTES');
  }
});

test('T3 Mockup_Render_TextoDeRelleno_Rechaza', () => {
  const out = path.join(TMP, 't3', 'm.html');
  const con = (el) => ({ title: 'X', screens: [{ name: 'P', state: 'e', elements: [{ kind: 'heading', text: 'Facturas' }, el] }] });
  for (const [el, nombre] of [
    [{ kind: 'heading', text: 'Lorem ipsum dolor' }, 'Lorem ipsum dolor'],
    [{ kind: 'button', text: 'TBD' }, 'TBD'],
    [{ kind: 'text', text: '...' }, '...'],
    [{ kind: 'button', text: 'TODO' }, 'TODO'],
  ]) {
    const r = renderModelo(con(el), out);
    assert.strictEqual(r.rc, 2, r.all);
    assert.ok(r.err.includes(nombre), r.all);
  }
  for (const el of [
    { kind: 'button', text: 'Seleccionar todo' },
    { kind: 'button', text: 'VER TODO' },
    { kind: 'field', label: 'Buscar', value: 'xxx' },
    { kind: 'table', columns: ['Número'], rows: [['xxx']] },
  ]) {
    const r = renderModelo(con(el), out);
    assert.strictEqual(r.rc, 0, `${JSON.stringify(el)}\n${r.all}`);
  }
});

test('T4 Mockup_Render_EscapaLoQueTraeElJson', () => {
  const out = path.join(TMP, 't4', 'm.html');
  const textos = ['<script>alert(1)</script>', '<img src=https://x/y.png>', 'url(http://x)', '@import "otra"', 'Dijo "hola"', 'Cobros & pagos'];
  const r = renderModelo({ title: 'X', screens: [{ name: 'P', state: 'e', elements: textos.map((t) => ({ kind: 'text', text: t })) }] }, out);
  assert.strictEqual(r.rc, 0, r.all);
  const html = fs.readFileSync(out, 'utf8');
  for (const prohibido of [/<script>/i, /\bsrc=/i, /url\(/i, /@import/i]) assert.doesNotMatch(html, prohibido);
  assert.strictEqual(run(['check', out]).rc, 0, run(['check', out]).all);
  const t = JSON.parse(run(['texts', out, '--json']).out);
  assert.deepStrictEqual(t.map((x) => x.text), textos);
  const { mockupEsc } = require(MOCKUP);
  assert.strictEqual(mockupEsc('a=b(c)@d:e'), 'a&#61;b&#40;c&#41;&#64;d&#58;e');
});

test('T5 Mockup_Check_CargaExternaONoGenerada_Rechaza', () => {
  const out = path.join(TMP, 't5', 'm.html');
  assert.strictEqual(renderModelo(MODELO(), out).rc, 0);
  const html = fs.readFileSync(out, 'utf8');
  const cargas = ['<link href="https://x/y.css">', '<img src="//x/y.png">', '<IMG SRCSET=a.png>', '<video poster=a.png></video>',
    '<p style="background:url(http://x)">a</p>', '<style>@import "x.css";</style>', '<script src="x.js"></script>', '<iframe></iframe>',
    '<meta http-equiv="refresh" content="0">'];
  const editada = path.join(TMP, 't5', 'editada.html');
  fs.writeFileSync(editada, html.replace('</body>', `${cargas.join('\n')}\n</body>`));
  const r = run(['check', editada]);
  assert.strictEqual(r.rc, 1, r.all);
  for (const re of [/<link/i, /<img/i, /srcset=/i, /poster=/i, /url\(/i, /@import/i, /<script/i, /<iframe/i, /refresh/i]) assert.match(r.all, re);
  assert.match(r.all, /línea \d+/);
  const ajena = path.join(TMP, 't5', 'ajena.html');
  fs.writeFileSync(ajena, html.replace(/<meta name="generator"[^>]*>/, ''));
  const r2 = run(['check', ajena]);
  assert.strictEqual(r2.rc, 1, r2.all);
  assert.match(r2.all, /generator/);
  const r3 = run(['check', path.join(TMP, 't5', 'no-existe.html')]);
  assert.strictEqual(r3.rc, 2, r3.all);
});

test('T6 Mockup_Texts_SoloLosQueSeComparan', () => {
  const out = path.join(TMP, 't6', 'm.html');
  assert.strictEqual(renderModelo(MODELO(), out).rc, 0);
  const t = JSON.parse(run(['texts', out, '--json']).out);
  const textos = t.map((x) => x.text);
  for (const esperado of ['Facturas de Acme SA', 'Tiene 3 facturas sin pagar.', 'Buscar factura', 'Número o fecha', 'Mostrar vencidas',
    'Número', 'Vence', 'Importe', 'Primera cuota', 'Segunda cuota', 'Las facturas vencidas no se pueden pagar desde acá.',
    'Pagar seleccionadas', 'Ver facturas pagadas', 'Total a pagar este mes', 'No tiene facturas sin pagar.']) {
    assert.ok(textos.includes(esperado), `falta ${esperado}`);
  }
  for (const ausente of ['0001-00012345', '$ 120.000', 'para el dueño; no se compara', 'Gráfico de vencimientos por mes', 'con facturas sin pagar', 'sin facturas']) {
    assert.ok(!textos.includes(ausente), `sobra ${ausente}`);
  }
  const boton = t.find((x) => x.text === 'Pagar seleccionadas');
  assert.strictEqual(boton.kind, 'button');
  assert.strictEqual(boton.screen, 0);
  assert.strictEqual(boton.screenName, 'Lista de facturas');
  assert.strictEqual(t.find((x) => x.text === 'No tiene facturas sin pagar.').screen, 1);
  const ajeno = path.join(TMP, 't6', 'ajeno.html');
  fs.writeFileSync(ajeno, '<html><body><p>hola</p></body></html>');
  const r = run(['texts', ajeno]);
  assert.strictEqual(r.rc, 2);
  assert.match(r.err, /no es una maqueta de mockup\.js/);
});

test('T7 Mockup_Status_ConYSinPantalla', () => {
  const repo = mundo();
  const conPantalla = story(repo, ['src/components/Facturas.tsx']);
  let r = run(['status', '--story', conPantalla, '--json']);
  assert.strictEqual(r.rc, 0, r.all);
  let s = JSON.parse(r.out);
  assert.strictEqual(s.screen, true);
  assert.ok(s.signal);
  assert.strictEqual(s.key, '1.1');
  assert.strictEqual(s.path, path.join(repo, 'specs', 'qa', '1.1-mockup.html'));
  assert.strictEqual(s.exists, false);
  assert.strictEqual(s.approval, null);

  const repo2 = mundo();
  const sinPantalla = story(repo2, ['src/Servicio.cs']);
  s = JSON.parse(run(['status', '--story', sinPantalla, '--json']).out);
  assert.strictEqual(s.screen, false);
  assert.strictEqual(s.path, null);

  r = run(['status', '--story', path.join(repo2, 'specs', 'stories', 'no-existe.md'), '--json']);
  assert.strictEqual(r.rc, 2, r.all);
  assert.doesNotMatch(r.all, /sin pantalla/);

  // con pantalla, exenta y con el número repetido en otra story del repo: la misma clave que la guía del tester
  const repo3 = mundo();
  const exenta = story(repo3, ['src/components/Facturas.tsx'], ['dod_runtime_exempt: true', 'dod_runtime_exempt_reason: "prueba"']);
  story(repo3, ['src/Otro.cs'], [], 'story-1.1-otra.md');
  s = JSON.parse(run(['status', '--story', exenta, '--json']).out);
  const { qaLocation } = require(path.join(SK, 'qa-guide.js'));
  const loc = qaLocation(exenta);
  assert.strictEqual(s.path, path.join(loc.qaDir, `${loc.qk}-mockup.html`));
});

test('T8 Mockup_Huella_IgualConFinesDeLineaDeWindows', () => {
  const { mockupHash } = require(MOCKUP);
  const lf = '<html>\n<body>\nhola\n</body>\n</html>\n';
  assert.strictEqual(mockupHash(lf), mockupHash(lf.replace(/\n/g, '\r\n')));
  assert.notStrictEqual(mockupHash(lf), mockupHash(lf.replace('hola', 'Hola')));
});

test('T9 Mockup_Open_SinNavegador_DiceLaRuta', (t) => {
  if (process.platform === 'win32') { t.skip('Windows: con PATH vacío lanzar cmd depende de la carpeta actual (constancia, no verde)'); return; }
  const out = path.join(TMP, 't9', 'm.html');
  const r = spawnSync(process.execPath, [MOCKUP, 'render', '--data', modeloEn(MODELO()), '--out', out, '--open'],
    { encoding: 'utf8', input: '', env: env({ PATH: '' }) });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(fs.existsSync(out));
  assert.ok(r.stderr.includes(`abrila: ${out}`), r.stderr);
});

test('T10 VisualPlan_SeRequiereSinCorrer_YSaleIgual', () => {
  const r = spawnSync(process.execPath, ['-e', `const v = require(${JSON.stringify(VISUAL)}); process.stdout.write(typeof v.esc + ' ' + typeof v.openInBrowser + ' ' + typeof v.renderHtml)`],
    { encoding: 'utf8', input: '', env: env() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'function function function');
  const demo = path.join(TMP, 't10', 'demo.html');
  fs.mkdirSync(path.dirname(demo), { recursive: true });
  const d = spawnSync(process.execPath, [VISUAL, 'demo', '--out', demo], { encoding: 'utf8', input: '', env: env() });
  assert.strictEqual(d.status, 0, d.stderr);
  assert.match(fs.readFileSync(demo, 'utf8'), /<script>/); // el plan visual sigue con su interacción
  const s = spawnSync(process.execPath, [VISUAL, 'schema'], { encoding: 'utf8', input: '', env: env() });
  assert.strictEqual(s.status, 0);
  assert.strictEqual(s.stdout, fs.readFileSync(VISUAL, 'utf8').split('\n').slice(11, 52).join('\n') + '\n');
});

test('T24 QaGuideArgs_ConAprobacion_PasaLaHuella', () => {
  const { qaGuideCheckArgs, mockupStep8 } = require(MOCKUP);
  const sha = 'a'.repeat(64);
  const con = qaGuideCheckArgs('/s/story.md', { mockupApproval: { sha256: sha } });
  assert.deepStrictEqual(con.slice(1), ['--check', '--story', '/s/story.md', '--mockup-sha', sha]);
  assert.ok(con[0].endsWith('qa-guide.js'));
  const sin = qaGuideCheckArgs('/s/story.md', {});
  assert.ok(!sin.includes('--mockup-sha'));
  assert.strictEqual(typeof mockupStep8, 'function');
  // en marker.js, la llamada del paso 8 usa esa función y su condición incluye la maqueta aprobada
  const src = fs.readFileSync(MARKER, 'utf8');
  assert.match(src, /qaGuideCheckArgs\(/);
  assert.match(src, /mockupApproval/);

  // por el CLI: la story tenía maqueta aprobada y ya no tiene pantalla → no se compara, se dice y queda anotado
  const repo = mundo();
  const s = story(repo, ['src/Servicio.cs']);
  const sid = 'sess-t24';
  const mk = (args, extra) => spawnSync('node', [MARKER, ...args], { encoding: 'utf8', input: '', env: env({ CLAUDE_CODE_SESSION_ID: sid, ...extra }) });
  let r = mk(['set', JSON.stringify({ storyId: '1.1', storyPath: s, repoPath: repo, stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8] })]);
  assert.strictEqual(r.status, 0, r.stderr);
  const mpath = path.join(HOME, '.claude', '.tycon-pipeline', 'active', `${sid}.json`);
  const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  m.mockupApproval = { file: path.join(repo, 'specs', 'qa', '1.1-mockup.html'), sha256: sha, mode: 'user', text: 'x', at: '2026-10-16T12:00:00Z' };
  m.mockupDecision = { screen: true, signal: 'x', at: '2026-10-16T12:00:00Z' };
  fs.writeFileSync(mpath, JSON.stringify(m));
  r = mk(['complete-step', '8']);
  assert.match(r.stderr, /la story tenía maqueta aprobada y ya no se detecta pantalla: no se compara/);
  assert.doesNotMatch(r.stderr, /qa-guide --check FALLÓ/);
  const gl = fs.readFileSync(path.join(HOME, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(gl.some((l) => l.name === 'mockup-compare' && l.status === 'skipped' && l.motivo === 'sin-pantalla'));
});

// ── Lo que encontró el pase adversarial (2026-10-17): regresiones ──────────────────────────────────────────────────
const comparar = (src, textos) => {
  const f = path.join(fs.mkdtempSync(path.join(TMP, 'adv-')), 'Pantalla.tsx');
  fs.writeFileSync(f, src);
  const { compareWithScreens } = require(MOCKUP);
  return compareWithScreens({ texts: textos.map((text) => ({ text, kind: 'text', screen: 0, screenName: 'P' })), screens: [{ rel: 'Pantalla.tsx', abs: f }], md: '' });
};

test('7.30-adv TextosCortos_CadenasYJsxLiteralesCuentan', () => {
  // columnas en un arreglo, un botón con estado, una traducción y un texto sin letras: están en la pantalla
  const src = [
    "const COLS = [{ header: 'Número' }, { header: 'Vence' }];",
    'const onPagar = () => 1;',
    "export const F = ({ saving }) => <div><button onClick={onPagar}>{saving ? 'Guardando' : 'Guardar'}</button>",
    "  <p>{t('Cancelar')}</p><span>%</span></div>;",
  ].join('\n');
  const r = comparar(src, ['Número', 'Vence', 'Guardar', 'Cancelar', '%', 'Pagar']);
  // «Pagar» sólo aparece en `onPagar`: sigue faltando (R13)
  assert.deepStrictEqual(r.missing.map((t) => t.text), ['Pagar']);
});

test('7.30-adv TextosConEspaciosRaros_SeComparanColapsados', () => {
  const r = comparar('export const F = () => <div><a>Ver todo</a><b>Guardar cambios</b></div>;\n', ['Ver  todo', 'Guardar\ncambios']);
  assert.deepStrictEqual(r.missing, []);
});

test('7.30-adv Check_CargasPartidasEnVariasLineasYAtributosDeAccion', () => {
  const out = path.join(TMP, 'adv-check', 'm.html');
  assert.strictEqual(renderModelo(MODELO(), out).rc, 0);
  const html = fs.readFileSync(out, 'utf8');
  const { validateMockupHtml } = require(MOCKUP);
  for (const frag of ['<a href\n="https://x">a</a>', '<a\nhref\n="x">a</a>', '<meta\nhttp-equiv="refresh" content="0">',
    '<p style="background:image-set(\'https://e/a.png\' 1x)">a</p>', '<button formaction="https://x">a</button>', '<div onclick="x()">a</div>']) {
    const v = validateMockupHtml(html.replace('</body>', `${frag}\n</body>`));
    assert.strictEqual(v.ok, false, `pasó: ${frag}`);
  }
  assert.strictEqual(validateMockupHtml(html).ok, true);
});

test('7.30-adv Relleno_PalabraEnteraYTodoAlPrincipio', () => {
  const { validateModel } = require(MOCKUP);
  const con = (text) => validateModel({ title: 'X', screens: [{ name: 'P', state: 'e', elements: [{ kind: 'text', text }] }] });
  for (const relleno of ['Lorem ipsum', 'TODO', 'TODO: el texto del botón', 'TBD', 'XXX']) assert.ok(con(relleno).length, `no lo vio: ${relleno}`);
  for (const real of ['Pagar TODO el saldo', 'VER TODO', 'Seleccionar todo', 'Explorémoslo juntos']) assert.deepStrictEqual(con(real), [], real);
});

test('7.30-adv Paso8_StoryIlegibleConDecisionSinPantalla_Frena', () => {
  const { mockupStep8 } = require(MOCKUP);
  const r = mockupStep8({ mockupDecision: { screen: false } }, path.join(TMP, 'no-existe', 'story.md'));
  assert.ok(r.block, JSON.stringify(r));
  assert.match(r.block, /no pude leer la story/);
});

test('T29 Mockup_SchemaDemoYRenderPorStory', () => {
  const sc = run(['schema']);
  assert.strictEqual(sc.rc, 0);
  assert.match(sc.out, /"screens"/);
  assert.match(sc.out, /heading \| text \| button/);
  const demo = path.join(TMP, 't29', 'demo.html');
  assert.strictEqual(run(['demo', '--out', demo]).rc, 0);
  assert.strictEqual(run(['check', demo]).rc, 0);
  const repo = mundo();
  const s = story(repo, ['src/components/Facturas.tsx']);
  const r = run(['render', '--data', modeloEn(MODELO()), '--story', s]);
  assert.strictEqual(r.rc, 0, r.all);
  const st = JSON.parse(run(['status', '--story', s, '--json']).out);
  assert.strictEqual(JSON.parse(r.out).out, st.path);
  assert.strictEqual(st.exists, true);
  const repo2 = mundo();
  const s2 = story(repo2, ['src/Servicio.cs']);
  const r2 = run(['render', '--data', modeloEn(MODELO()), '--story', s2]);
  assert.strictEqual(r2.rc, 2);
  assert.match(r2.err, /la story no tiene pantalla: no hay maqueta que armar/);
});
