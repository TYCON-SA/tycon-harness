#!/usr/bin/env node
/**
 * mockup.test.js — la maqueta de la pantalla antes de construirla.
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
 *   T30-T34 la casilla chica con sus estados y el grupo en una fila con su leyenda, y sus datos inválidos
 *   T35-T36 la cabecera «esquema, no aspecto» y lo existente en gris
 *   T37 check acepta la maqueta nueva y la del formato anterior
 *   T38, T43 la leyenda y los rótulos se comparan con la pantalla; el title, como atributo o texto, y si falta es aviso
 *   T39 schema explica los campos nuevos
 *   T41-T42 el `value` de una casilla vieja se toma como `checked`, y check no se cae
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

  // por el CLI: si la story tiene maqueta aprobada y ya no tiene pantalla → no se compara, se dice y queda anotado
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

// ── Regresiones ──────────────────────────────────────────────────
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
  // «Pagar» sólo aparece en `onPagar`: sigue faltando
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

// Una pantalla puede ser una capa encima de otra, con el botón o enlace que la abre.
const CON_CAPA = () => ({
  storyId: '1.2',
  title: 'Los clientes',
  screens: [
    { name: 'Lista de clientes', state: 'con clientes', elements: [{ kind: 'heading', text: 'Clientes' }, { kind: 'button', text: 'Eliminar' }, { kind: 'link', text: 'Ver historial' }] },
    {
      name: 'Confirmar eliminación', state: 'abierta', presentation: 'layer', over: 'Lista de clientes', trigger: 'Eliminar',
      elements: [{ kind: 'text', text: '¿Eliminar este cliente?' }, { kind: 'button', text: 'Confirmar', primary: true }, { kind: 'button', text: 'Cancelar' }],
    },
  ],
});

test('Mockup_Capa_SeDibujaEncimaConSuDisparador @story-7.48 @ac-1', () => {
  const out = path.join(TMP, 'capa', 'm.html');
  const r = renderModelo(CON_CAPA(), out);
  assert.strictEqual(r.rc, 0, r.all);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<section class="screen layer" data-screen-index="1" data-screen-name="Confirmar eliminación" data-presentation="layer">/);
  assert.match(html, /Se abre encima de «Lista de clientes» con «Eliminar»/);
  assert.doesNotMatch(html.split('data-screen-index="1"')[0], /data-presentation="layer"/, 'la pantalla de abajo no es capa');
  assert.strictEqual(run(['check', out]).rc, 0, run(['check', out]).all);
  const t = run(['texts', out]);
  assert.strictEqual(t.rc, 0, t.all);
  assert.match(t.out, /Eliminar este cliente/);
  assert.match(t.out, /Confirmar/);
});

test('Mockup_Capa_DatosInvalidos_NoEscribe @story-7.48 @ac-2', () => {
  const casos = [
    [(m) => { m.screens[1].presentation = 'popup'; }, /pantalla 2: `presentation` «popup» no está en la lista \(page \| layer\)/],
    [(m) => { delete m.screens[1].over; }, /pantalla 2: una capa necesita `over`/],
    [(m) => { delete m.screens[1].trigger; }, /pantalla 2: una capa necesita `trigger`/],
    [(m) => { m.screens[1].over = 'Otra pantalla'; }, /pantalla 2: `over` «Otra pantalla» no es el nombre de otra pantalla/],
    [(m) => { m.screens[1].over = 'Confirmar eliminación'; }, /pantalla 2: `over` «Confirmar eliminación» no es el nombre de otra pantalla/],
    [(m) => { m.screens[1].trigger = 'Clientes'; }, /pantalla 2: `trigger` «Clientes» no es un botón ni un enlace de «Lista de clientes»/],
  ];
  casos.forEach(([cambio, motivo], i) => {
    const m = CON_CAPA(); cambio(m);
    const out = path.join(TMP, 'capa-mal', `${i}.html`);
    const r = renderModelo(m, out);
    assert.notStrictEqual(r.rc, 0, `caso ${i}`);
    assert.match(r.all, motivo, `caso ${i}: ${r.all}`);
    assert.strictEqual(fs.existsSync(out), false, `caso ${i}: no escribe`);
  });
  // un enlace también abre una capa
  const m = CON_CAPA(); m.screens[1].trigger = 'Ver historial';
  assert.strictEqual(renderModelo(m, path.join(TMP, 'capa-mal', 'enlace.html')).rc, 0);
});

test('T40 Mockup_SinCapa_HtmlIgualAlDeHoy @story-7.48 @ac-3 @story-8.129 @ac-11', () => {
  // la huella del HTML del modelo de muestra sin capas. Cambió a propósito con la cabecera «esquema, no aspecto» y la
  // marca de la casilla: una maqueta aprobada no se invalida, porque su huella sale del archivo guardado
  const HOY = '064d2cd6cad83edb58764e285d3b62ad2e9b9728d1fc1889b395bed3df57423d';
  const { renderMockup } = require(MOCKUP);
  const huella = (m) => require('crypto').createHash('sha256').update(renderMockup(m)).digest('hex');
  assert.strictEqual(huella(MODELO()), HOY);
  const conPage = MODELO(); conPage.screens.forEach((s) => { s.presentation = 'page'; });
  assert.strictEqual(huella(conPage), HOY);
});

test('Mockup_Schema_ExplicaLaCapa @story-7.48 @ac-4', () => {
  const r = run(['schema']);
  assert.strictEqual(r.rc, 0, r.all);
  for (const w of ['presentation', 'over', 'trigger', '"layer"']) assert.ok(r.out.includes(w), w);
  assert.match(r.out, /No se comparan[^.]*presentation/);
  const demo = path.join(TMP, 'capa', 'demo.html');
  assert.strictEqual(run(['demo', '--out', demo]).rc, 0);
  assert.match(fs.readFileSync(demo, 'utf8'), /data-presentation="layer"/);
});

test('Paso3_ArmarElModelo_DiceQueVaComoCapa @story-7.48 @ac-5', () => {
  // los renglones de la guía se juntan: una frase partida en dos sigue siendo la misma frase
  const paso = fs.readFileSync(path.join(SK, '..', 'steps', 'step-04-approve-plan.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(paso, /presentation: "layer"/);
  assert.match(paso, /ventana, un diálogo o un panel/);
  assert.match(paso, /la story manda sobre la convención/);
});

test('Pasos3y4_LaMaquetaFijaContenidoNoForma @story-7.48 @ac-6', () => {
  for (const f of ['step-04-approve-plan.md', 'step-05-implement.md']) {
    const paso = fs.readFileSync(path.join(SK, '..', 'steps', f), 'utf8').replace(/\s+/g, ' ');
    assert.match(paso, /la maqueta fija el contenido y los estados, no la forma/i, f);
    assert.match(paso, /la forma sale de la story y de la guía del stack/i, f);
    assert.match(paso, /donde la maqueta marca una capa[^.]*, se construye una capa/i, f);
  }
});

test('7.23-DeclaredDiffs_ComillasAnidadas @story-7.23 @ac-16 — un texto que lleva «» adentro se declara entero', () => {
  const { declaredDiffs } = require(MOCKUP);
  const md = [
    '- «Story 7.23 «Los pasos» — Revisores · 8 de 11 pasos hechos» — differs: lo arma pipelineTable',
    '- «Paso» — differs: encabezado',
    '- «a» y «b» — differs: dos textos en un renglón siguen valiendo los dos',
    '- «sin motivo» — differs: ',
  ].join('\n');
  const d = declaredDiffs(md);
  assert.strictEqual(d.get('Story 7.23 «Los pasos» — Revisores · 8 de 11 pasos hechos'), 'lo arma pipelineTable');
  assert.strictEqual(d.get('Paso'), 'encabezado');
  assert.ok(d.has('a') && d.has('b'));
  assert.ok(!d.has('sin motivo'), 'sin motivo no cuenta');
});

// ── Casillas, grupos, la cabecera y lo existente ─────────────────
// Un filtro de estados de factura: el ejemplo es inventado.
const CON_FILTRO = () => ({
  storyId: '1.3',
  title: 'El filtro de facturas',
  screens: [{
    name: 'Lista de facturas',
    elements: [
      { kind: 'heading', text: 'Facturas', existing: true },
      { kind: 'checkbox', label: 'Mostrar anuladas', checked: true },
      {
        kind: 'group', legend: 'Estado de la factura', items: [
          { label: 'Pendiente', checked: true },
          { label: 'Pagada' },
          { label: 'Vencida', disabled: true, title: 'Sólo para el administrador' },
        ],
      },
    ],
  }],
});
const armar = (m) => require(MOCKUP).renderMockup(m);
// la regla CSS de un selector, tal cual sale en el <style>
const regla = (html, sel) => { const m = html.match(new RegExp(`\\n\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)); return m ? m[1] : null; };

test('T30 Mockup_Casilla_NoHeredaElEstiloDelRecuadro @story-8.129 @ac-1', () => {
  const html = armar(CON_FILTRO());
  assert.doesNotMatch(html, /<div class="checkbox[^"]*"><span class="box"/, 'la marca no lleva la clase del recuadro');
  assert.match(html, /<span class="cb-mark[^"]*">/);
  const r = regla(html, '.cb-mark');
  assert.ok(r, 'hay una regla para la marca');
  assert.match(r, /width:\s*14px/);
  assert.match(r, /height:\s*14px/);
});

test('T31 Mockup_Casilla_MarcadaYDeshabilitadaSeVen @story-8.129 @ac-2', () => {
  const html = armar(CON_FILTRO());
  assert.match(html, /<span class="cb-mark on">x<\/span>[^\n]*Pendiente/, 'la marcada lleva la x');
  assert.match(html, /<span class="cb-mark"><\/span>[^\n]*Pagada/, 'la otra va vacía');
  assert.match(html, /<div class="checkbox disabled">[^\n]*Vencida[^\n]*S&#243;lo para el administrador|<div class="checkbox disabled">[^\n]*Vencida[^\n]*Sólo para el administrador/, 'la deshabilitada lleva su clase y el title a la vista');
  assert.match(regla(html, '.checkbox.disabled') || '', /color:\s*#9aa3b2/);
});

test('T32 Mockup_Casilla_CamposMalos_NoEscribe @story-8.129 @ac-3', () => {
  const casos = [
    [{ kind: 'checkbox', label: 'A', checked: 'si' }, /checked/],
    [{ kind: 'checkbox', label: 'A', disabled: 1 }, /disabled/],
    [{ kind: 'checkbox', label: 'A', title: 'por qué' }, /title/],
    [{ kind: 'group', legend: 'G', items: [{ label: 'A', checked: 'no' }] }, /checked/],
  ];
  casos.forEach(([el, re], i) => {
    const out = path.join(TMP, 't32', `${i}.html`);
    const r = renderModelo({ title: 'X', screens: [{ elements: [el] }] }, out);
    assert.strictEqual(r.rc, 2, r.all);
    assert.match(r.err, re);
    assert.ok(!fs.existsSync(out), 'no escribe nada');
  });
});

test('T33 Mockup_Grupo_UnaFilaConSuLeyenda @story-8.129 @ac-4', () => {
  const html = armar(CON_FILTRO());
  const m = html.match(/<fieldset class="group"><legend>([\s\S]*?)<\/legend><div class="group-row">([\s\S]*?)<\/div><\/fieldset>/);
  assert.ok(m, 'un fieldset con su leyenda y la fila');
  assert.match(m[1], /Estado de la factura/);
  const orden = ['Pendiente', 'Pagada', 'Vencida'].map((t) => m[2].indexOf(t));
  assert.ok(orden.every((n) => n >= 0) && orden[0] < orden[1] && orden[1] < orden[2], 'las tres en orden dentro de la fila');
  const r = regla(html, '.group-row');
  assert.match(r || '', /display:\s*flex/);
  assert.match(r || '', /flex-direction:\s*row/);
});

test('T34 Mockup_Grupo_DatosInvalidos_NoEscribe @story-8.129 @ac-5', () => {
  const casos = [
    [{ kind: 'group', items: [{ label: 'A' }] }, /legend/],
    [{ kind: 'group', legend: 'G' }, /items/],
    [{ kind: 'group', legend: 'G', items: [] }, /items/],
    [{ kind: 'group', legend: 'G', items: [{ checked: true }] }, /label/],
  ];
  casos.forEach(([el, re], i) => {
    const out = path.join(TMP, 't34', `${i}.html`);
    const r = renderModelo({ title: 'X', screens: [{ elements: [el] }] }, out);
    assert.strictEqual(r.rc, 2, r.all);
    assert.match(r.err, re);
    assert.ok(!fs.existsSync(out), 'no escribe nada');
  });
});

test('T35 Mockup_Cabecera_DiceQueEsUnEsquema @story-8.129 @ac-6', () => {
  const { mockupTexts } = require(MOCKUP);
  const html = armar(MODELO());
  const header = (html.match(/<header>([\s\S]*?)<\/header>/) || [])[1] || '';
  assert.match(header, /Esquema de textos y estados, no del aspecto/);
  assert.ok(!mockupTexts(html).some((t) => /Esquema de textos/.test(t.text)), 'la cabecera no se compara');
  assert.doesNotMatch(header, /En gris/, 'sin elementos existentes no explica el gris');
});

test('T36 Mockup_Existente_SeDibujaEnGris @story-8.129 @ac-7', () => {
  const { mockupTexts } = require(MOCKUP);
  const html = armar(CON_FILTRO());
  assert.match(html, /<div class="existing"><h2 class="heading">/);
  assert.match(regla(html, '.existing') || '', /color:\s*#9aa3b2/);
  assert.match((html.match(/<header>([\s\S]*?)<\/header>/) || [])[1], /En gris, lo que la pantalla ya tiene/);
  assert.ok(mockupTexts(html).some((t) => t.text === 'Facturas'), 'lo existente se sigue comparando');
  const out = path.join(TMP, 't36', 'mal.html');
  const r = renderModelo({ title: 'X', screens: [{ elements: [{ kind: 'text', text: 'Hola', existing: 'si' }] }] }, out);
  assert.strictEqual(r.rc, 2, r.all);
  assert.match(r.err, /existing/);
  assert.ok(!fs.existsSync(out));
});

test('T37 Mockup_Check_AceptaLaNuevaYLaVieja @story-8.129 @ac-8', () => {
  const nueva = path.join(TMP, 't37', 'nueva.html');
  assert.strictEqual(renderModelo(CON_FILTRO(), nueva).rc, 0);
  assert.strictEqual(run(['check', nueva]).rc, 0, run(['check', nueva]).all);
  // el formato anterior: sin la cabecera nueva, con la casilla de antes
  const { CSP, GENERATOR } = require(MOCKUP);
  const vieja = path.join(TMP, 't37', 'vieja.html');
  escribir(vieja, [
    '<!doctype html>', '<html lang="es"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`, `<meta name="generator" content="${GENERATOR}">`,
    '<title>Maqueta — Vieja</title></head><body>',
    '<header><h1>Vieja</h1><p>Maqueta de la pantalla. Se mira y se aprueba con el plan.</p></header>',
    '<section class="screen" data-screen-index="0" data-screen-name="P">',
    '<div class="checkbox"><span class="box"></span><span class="t" data-mockup-text="Pagada" data-kind="checkbox" data-screen="0">Pagada</span></div>',
    '</section></body></html>', '',
  ].join('\n'));
  const r = run(['check', vieja]);
  assert.strictEqual(r.rc, 0, r.all);
});

test('T38 Mockup_Comparacion_LeyendaYRotulosContraLaPantalla @story-8.129 @ac-9', () => {
  const { mockupTexts, compareWithScreens } = require(MOCKUP);
  const textos = mockupTexts(armar(CON_FILTRO()));
  const dir = fs.mkdtempSync(path.join(TMP, 't38-'));
  const bien = path.join(dir, 'Filtro.tsx');
  fs.writeFileSync(bien, [
    'export function Filtro() {', '  return (<div><h1>Facturas</h1>',
    '    <label><input type="checkbox" /> Mostrar anuladas</label>',
    '    <fieldset><legend>Estado de la factura</legend>',
    '      <label><input type="checkbox" /> Pendiente</label>', '      <label><input type="checkbox" /> Pagada</label>',
    '      <label title="Sólo para el administrador"><input type="checkbox" disabled /> Vencida</label>',
    '    </fieldset></div>);', '}', '',
  ].join('\n'));
  const ok = compareWithScreens({ texts: textos, screens: [{ rel: 'Filtro.tsx', abs: bien }], md: '' });
  assert.deepStrictEqual(ok.missing.map((t) => t.text), []);
  const mal = path.join(dir, 'FiltroMal.tsx');
  fs.writeFileSync(mal, fs.readFileSync(bien, 'utf8').replace('<legend>Estado de la factura</legend>', '').replace(' Pagada</label>', ' Cobrada</label>'));
  const faltan = compareWithScreens({ texts: textos, screens: [{ rel: 'FiltroMal.tsx', abs: mal }], md: '' }).missing.map((t) => t.text);
  assert.ok(faltan.includes('Estado de la factura'), faltan.join(' | '));
  assert.ok(faltan.includes('Pagada'), faltan.join(' | '));
});

test('T39 Mockup_Schema_ExplicaLosCamposNuevos @story-8.129 @ac-10', () => {
  const r = run(['schema']);
  assert.strictEqual(r.rc, 0, r.all);
  for (const w of ['checked', 'disabled', 'title', 'group', 'legend', 'existing', 'Esquema de textos y estados, no del aspecto']) assert.ok(r.out.includes(w), w);
  const demo = path.join(TMP, 't39', 'demo.html');
  assert.strictEqual(run(['demo', '--out', demo]).rc, 0);
  assert.strictEqual(run(['check', demo]).rc, 0);
});

test('T41 Mockup_Casilla_ValueViejo_SeTomaComoChecked @story-8.129 @ac-12', () => {
  const out = path.join(TMP, 't41', 'vieja.html');
  const m = { title: 'X', screens: [{ elements: [{ kind: 'checkbox', label: 'Pendiente', value: true }, { kind: 'checkbox', label: 'Pagada', value: false }] }] };
  const r = renderModelo(m, out);
  assert.strictEqual(r.rc, 0, r.all);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<span class="cb-mark on">x<\/span>[^\n]*Pendiente/);
  assert.match(html, /<span class="cb-mark"><\/span>[^\n]*Pagada/);
  assert.match(r.err, /usá checked/);
  const enGrupo = path.join(TMP, 't41', 'grupo.html');
  const g = { title: 'X', screens: [{ elements: [{ kind: 'group', legend: 'Estado', items: [{ label: 'Anulada', value: true }] }] }] };
  const rg = renderModelo(g, enGrupo);
  assert.strictEqual(rg.rc, 0, rg.all);
  assert.match(fs.readFileSync(enGrupo, 'utf8'), /<span class="cb-mark on">x<\/span>[^\n]*Anulada/);
  assert.match(rg.err, /usá checked/);
  // con `checked` y `value` juntos gana `checked`, y el aviso dice lo que se dibujó
  const mk = require(MOCKUP);
  const avisos = mk.modelWarnings({ screens: [{ elements: [{ kind: 'checkbox', label: 'Pagada', checked: false, value: true }] }] });
  assert.strictEqual(avisos.length, 1);
  assert.match(avisos[0], /`checked: false`/);
});

test('T42 Mockup_Check_MaquetaConValueNoSeCae @story-8.129 @ac-12', () => {
  const out = path.join(TMP, 't42', 'vieja.html');
  assert.strictEqual(renderModelo({ title: 'X', screens: [{ elements: [{ kind: 'checkbox', label: 'Pendiente', value: true }] }] }, out).rc, 0);
  const r = run(['check', out]);
  assert.strictEqual(r.rc, 0, r.all);
});

test('T43 Mockup_Comparacion_TitleComoAtributoYAviso @story-8.129 @ac-13', () => {
  const mk = require(MOCKUP);
  const html = armar(CON_FILTRO());
  const textos = mk.mockupTexts(html);
  const dir = fs.mkdtempSync(path.join(TMP, 't43-'));
  const base = [
    'export function Filtro() {', '  return (<div><h1>Facturas</h1><label><input type="checkbox" /> Mostrar anuladas</label>',
    '    <fieldset><legend>Estado de la factura</legend><label><input type="checkbox" /> Pendiente</label>',
    '      <label><input type="checkbox" /> Pagada</label>', '      <label TITULO><input type="checkbox" disabled /> Vencida</label>',
    '    </fieldset></div>);', '}', '',
  ].join('\n');
  const con = path.join(dir, 'Con.tsx');
  fs.writeFileSync(con, base.replace('TITULO', 'title={\'Sólo para el administrador\'}'));
  const a = mk.compareWithScreens({ texts: textos, screens: [{ rel: 'Con.tsx', abs: con }], md: '' });
  assert.deepStrictEqual(a.warnings, []);
  assert.deepStrictEqual(a.missing, []);
  const sin = path.join(dir, 'Sin.tsx');
  fs.writeFileSync(sin, base.replace(' TITULO', ''));
  const b = mk.compareWithScreens({ texts: textos, screens: [{ rel: 'Sin.tsx', abs: sin }], md: '' });
  assert.deepStrictEqual(b.missing, [], 'el title no es un faltante');
  assert.deepStrictEqual(b.warnings.map((t) => t.text), ['Sólo para el administrador']);
  // la capa 10 de qa-guide.js --check lo anota como nota, sin problema
  const qaDir = path.join(dir, 'qa');
  fs.mkdirSync(qaDir);
  const mockupPath = path.join(qaDir, '1.3-mockup.html');
  fs.writeFileSync(mockupPath, html);
  const sha = mk.mockupHash(html);
  mk.writeApproval({ approvalPath: path.join(qaDir, '1.3-mockup-approval.json'), mockupPath, story: '1.3', sha256: sha, approvedAt: '2026-10-25T00:00:00Z' });
  fs.writeFileSync(path.join(qaDir, '1.3-legibilidad-ui.md'), 'veredicto: OK\nmockup: 1.3-mockup.html\n');
  const { mockupLayers } = require(path.join(SK, 'qa-guide.js'));
  const capa = mockupLayers({ qaDir, qk: '1.3', mockupSha: sha, screens: [{ rel: 'Sin.tsx', abs: sin }] });
  assert.deepStrictEqual(capa.problems, []);
  assert.ok(capa.notes.some((n) => /Sólo para el administrador/.test(n)), capa.notes.join(' | '));
  // un mensaje con las mismas palabras que el motivo, después de la casilla, se sigue comparando: si falta, es faltante
  const mismoTexto = armar({ title: 'X', screens: [{ name: 'Facturas', elements: [
    { kind: 'checkbox', label: 'Pendiente', disabled: true, title: 'Sólo para el administrador' },
    { kind: 'message', text: 'Sólo para el administrador' },
  ] }] });
  const solo = path.join(dir, 'Solo.tsx');
  fs.writeFileSync(solo, 'export function F() { return (<label><input type="checkbox" disabled /> Pendiente</label>); }\n');
  const c = mk.compareWithScreens({ texts: mk.mockupTexts(mismoTexto), screens: [{ rel: 'Solo.tsx', abs: solo }], md: '' });
  assert.deepStrictEqual(c.missing.map((t) => t.text), ['Sólo para el administrador'], 'el mensaje que falta es faltante');
  assert.deepStrictEqual(c.warnings.map((t) => t.text), ['Sólo para el administrador']);
});
