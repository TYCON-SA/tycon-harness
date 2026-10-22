#!/usr/bin/env node
'use strict';
// stable-data: la hora de ahora es a propósito: la matriz descarta la evidencia más vieja que el código, y una hora fija
// se pudriría. Las fechas de arranque que se prueban (T8) salen todas de la fecha de corte de la matriz, que es fija.
/**
 * visual-evidence.test.js — un criterio de pantalla cuenta como probado sólo con una captura o una grabación del
 * navegador real atada a ese criterio.
 *
 * Por qué: lo que el cliente ve no puede pasar por probado sólo porque una prueba salió verde. El portón E2E guarda
 * capturas, pero no cuentan para el veredicto de la matriz, y los humos de pantalla que corren fuera del E2E no dejan
 * imagen.
 *
 * Se prueba la matriz (runtime-matrix.js) con sus dos productores de imágenes de verdad: `e2e-evidence.js captures`
 * (el portón E2E) y `smoke-run.sh --capture` (el humo). Las imágenes son bytes de juguete con la firma de su formato:
 * la matriz mira la extensión, la ruta, la firma y la huella, no el contenido.
 *
 *   T1 pantalla sin imagen → SIN-EVIDENCIA          T5 --capture que no sirve (.txt, no existe, enlace, firma, 50 MB)
 *   T2 captura del E2E atada por @ac-N, y sus       T6 backend sigue igual, y las marcas @pantalla / @sin-pantalla
 *      rechazos (intento fallido, firma, sello)     T7 las dos guías piden la imagen y nombran --capture
 *   T3 una grabación .webm cuenta igual             T8 las stories ya en curso reciben un aviso, sin rojo
 *   T4 humo con --capture: huella en registro y espejo, y sus rechazos
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/visual-evidence.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..');
const rm = require(path.join(SCRIPTS, 'runtime-matrix.js'));
const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
const ledgerLine = require(path.join(__dirname, 'lib', 'smoke-ledger-line.js'));
const SMOKE_RUN = path.join(SCRIPTS, 'smoke-run.sh');
const E2E_EVIDENCE = path.join(SCRIPTS, 'lib', 'e2e-evidence.js');

const MOTIVO = /falta la captura o la grabación del navegador/;

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- armado

/**
 * Un repo de juguete con su story y su carpeta de evidencia, y un HOME de juguete con su gates.log (el espejo). `ui`
 * decide si la story cablea interfaz (un .tsx entre sus archivos) o es de backend (un .cs). `acs` es [[número, texto]];
 * `rows` son las filas de la tabla ### Tests.
 */
function makeWorkspace({ ui = true, acs, rows, created } = {}) {
  const ws = tmp('visev-');
  const repo = path.join(ws, 'Proj');
  const dodDir = path.join(repo, '.advisors', 'dod-runtime');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs', 'stories'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(dodDir, { recursive: true });
  const codeRel = ui ? 'src/Pantalla.tsx' : 'src/Feature.cs';
  const codeFile = path.join(repo, codeRel);
  fs.writeFileSync(codeFile, '// codigo de juguete\n');
  // Código "viejo": la evidencia que se arma después es posterior y cuenta.
  const hace1h = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(codeFile, hace1h, hace1h);

  const lista = acs || [[1, '**Given** la pantalla de facturas, **When** se abre, **Then** muestra la lista de Cliente A.']];
  const filas = rows || [['T1', '`Pantalla.Caso1`', '1', 'unit']];
  const md = [
    '---',
    'story: 9.9',
    'status: in-progress',
    ...(created ? [`created: ${created}`] : []),
    'files_to_modify:',
    `  - ${codeRel}`,
    '---',
    '',
    '## Acceptance Criteria',
    '',
    ...lista.map(([n, t]) => `${n}. ${t}`),
    '',
    '### Tests',
    '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |',
    '|---|---|---|---|---|---|',
    ...filas.map(([id, name, ac, nivel]) => `| ${id} | ${name} | ${ac} | ${nivel} | x | y |`),
    '',
  ].join('\n');
  const storyPath = path.join(repo, 'specs', 'stories', '9-9-fixture.md');
  fs.writeFileSync(storyPath, md);
  const home = tmp('visev-home-');
  const gatesLog = path.join(stateDir(home), 'gates.log');
  fs.mkdirSync(path.dirname(gatesLog), { recursive: true });
  return {
    ws, repo, dodDir, storyPath, md, home, gatesLog,
    // carpeta vacía de marcadores: la matriz no lee los de la máquina que corre la prueba
    activeDir: tmp('visev-active-'),
  };
}

function calc(f, extra = {}) {
  return rm.compute({ storyPath: f.storyPath, gatesLogPath: f.gatesLog, activeDir: f.activeDir, ...extra });
}

const compact = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const compactNow = () => compact(60 * 1000);

/** El gate E2E con su copia en gates.log, como lo deja `marker.js run-check dod -- bash e2e-gate.sh …`. */
function writeGate(f, tsCompact, specFilter, titulos, verdict = 'PASS') {
  fs.writeFileSync(path.join(f.dodDir, `9.9-e2e-gate-${tsCompact}.md`), [
    '# E2E Gate — 9.9', '', `verdict=${verdict}`, `**Spec filter**: ${specFilter}`, '- skipped: 0', '',
    '## Tests corridos (títulos completos — contrato DODRT-C8)', ...titulos.map((t) => `- ${t}`), '',
  ].join('\n'));
  fs.appendFileSync(f.gatesLog, JSON.stringify({
    ts: new Date().toISOString(), check: 'dod', status: verdict === 'PASS' ? 'green' : 'red:exit=1', provenance: 'run-check',
    cmd: `bash e2e-gate.sh /fe 9.9 /dir ${specFilter}`, exit: verdict === 'PASS' ? 0 : 1,
  }) + '\n');
}

/**
 * Un reporte JSON de Playwright. Cada test: { title, suite?, results: [{ status, attachments: [[contentType, archivo]] }] };
 * `suite` lo mete dentro de un describe con ese título.
 */
function playwrightReport(dir, tests) {
  const specOf = (t) => ({
    title: t.title,
    tests: [{ results: t.results.map((r) => ({
      status: r.status,
      attachments: (r.attachments || []).map(([contentType, file]) => ({ name: 'adjunto', contentType, path: file })),
    })) }],
  });
  const nested = {};
  for (const t of tests.filter((x) => x.suite)) (nested[t.suite] = nested[t.suite] || []).push(specOf(t));
  const suites = [{
    title: 'story-9-9.spec.ts',
    specs: tests.filter((t) => !t.suite).map(specOf),
    suites: Object.entries(nested).map(([title, specs]) => ({ title, specs })),
  }];
  const out = path.join(dir, `playwright-${crypto.randomBytes(3).toString('hex')}.json`);
  fs.writeFileSync(out, JSON.stringify({ suites }));
  return out;
}

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EBML_HEAD = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/** Un archivo de juguete con la firma de su formato (png o webm). */
function juguete(dir, name, contenido = 'acme-1') {
  const p = path.join(dir, name);
  const head = /\.webm$/i.test(name) ? EBML_HEAD : PNG_HEAD;
  fs.writeFileSync(p, Buffer.concat([head, Buffer.from(contenido)]));
  return p;
}

/** Corre `e2e-evidence.js captures` con el HOME de juguete (ahí sella el índice). */
function runCaptures(f, informe, dest) {
  return spawnSync(process.execPath, [E2E_EVIDENCE, 'captures', informe, dest], { encoding: 'utf8', env: { ...process.env, HOME: f.home } });
}

/** Escribe un captures.json a mano y, salvo `seal: false`, su sello en el espejo; el caso de quien arma la evidencia sin el portón. */
function writeIndex(f, tsCompact, index, { seal = true, texto } = {}) {
  const dir = path.join(f.dodDir, `9.9-captures-${tsCompact}`);
  fs.mkdirSync(dir, { recursive: true });
  const crudo = texto !== undefined ? texto : JSON.stringify(index, null, 2) + '\n';
  fs.writeFileSync(path.join(dir, 'captures.json'), crudo);
  if (seal) fs.appendFileSync(f.gatesLog, JSON.stringify({ type: 'e2e-captures', ts: new Date().toISOString(), folder: path.basename(dir), sha256: sha256(crudo) }) + '\n');
  return dir;
}

/** Corre `smoke-run.sh` de verdad con el HOME de juguete. `acs: null` lo corre sin criterios. */
function runSmoke(f, flags, cmd, { acs = '1' } = {}) {
  const criterios = acs === null ? [] : ['--acs', acs, '--pass-if', 'la pantalla de facturas abre'];
  const res = spawnSync('bash', [SMOKE_RUN, f.dodDir, '9.9', ...criterios, ...flags, '--', ...cmd], {
    env: { ...process.env, HOME: f.home }, cwd: f.repo, encoding: 'utf8',
  });
  return res;
}

const ledgerEntries = (f) => fs.readFileSync(path.join(f.dodDir, '9.9-smoke-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const writeLedger = (f, entries) => fs.writeFileSync(path.join(f.dodDir, '9.9-smoke-ledger.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

// ---------------------------------------------------------------- pruebas

// Mutación: sacar el bloque de evidencia visual de compute() → el AC de pantalla vuelve a salir RUNTIME.
test('Matriz_PantallaSinImagen_SinEvidencia — un AC de pantalla con un humo verde y sin imagen no es RUNTIME', () => {
  const f = makeWorkspace();
  ledgerLine.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [1],
    v2: { pasaSi: 'la pantalla de facturas abre', outputText: 'HTTP 200' } });
  const r = calc(f);
  assert.equal(r.perAc[1].verdict, 'SIN-EVIDENCIA');
  assert.equal(r.perAc[1].pantalla, true);
  assert.match(r.perAc[1].motivo, MOTIVO);
  assert.match(r.perAc[1].motivo, /--capture/, 'dice cómo sacarla con el humo');
  assert.match(r.perAc[1].motivo, /@ac-1/, 'y cómo atarla desde el E2E');
  assert.equal(r.green, false, 'una pantalla sin imagen deja la matriz roja');
  assert.deepEqual(r.pendientes, [1]);
  assert.match(rm.renderMd(r), MOTIVO, 'el markdown muestra el motivo');

  // Un AC de pantalla cuya acción nunca se ejecutó (RUNTIME-PARCIAL) y sin imagen también pasa a SIN-EVIDENCIA.
  const parcial = makeWorkspace({ acs: [[1, '**Given** la pantalla de facturas, **When** el usuario crea una factura, **Then** la lista la muestra.']] });
  ledgerLine.append({ dodDir: parcial.dodDir, gatesLog: parcial.gatesLog, story: '9.9', acs: [1],
    v2: { pasaSi: 'la pantalla abre', outputText: 'HTTP 200' } });
  const rp = calc(parcial);
  assert.equal(rp.perAc[1].verdict, 'SIN-EVIDENCIA', 'la acción sin ejecutar no esconde la falta de imagen');
  assert.match(rp.perAc[1].motivo, MOTIVO);
  assert.ok(rp.warnings.some((w) => /describe una ACCIÓN/.test(w)), 'y el aviso de la acción sigue a la vista');
  assert.equal(rp.green, false);
});

// Mutación: no atar la captura al AC, atarla por el describe, contar el intento fallido, copiar sin mirar los bytes, o
// contar un captures.json sin sello → alguna de las afirmaciones de abajo cambia.
test('Matriz_CapturaDelE2E_CuentaParaSuAC — la captura de un test @ac-2 cuenta para el AC 2 y no para los demás', () => {
  const f = makeWorkspace({
    acs: [2, 3, 4, 5, 6].map((n) => [n, `**Given** la lista de facturas ${n}, **Then** muestra el total.`]),
    rows: [['E1', '`story-9-9.spec.ts::flujo`', '2,3,4,5,6', 'e2e']],
  });
  const img = tmp('visev-img-');
  const png = (n) => juguete(img, `${n}.png`, `captura ${n}`);
  const ts = compactNow();
  const informe = playwrightReport(img, [
    { title: 'la lista muestra el total @ac-2', results: [{ status: 'passed', attachments: [['image/png', png('a')]] }] },
    { title: 'el detalle abre', results: [{ status: 'passed', attachments: [['image/png', png('b')]] }] },   // sin etiqueta
    { title: 'la lista y el detalle @ac-3 @ac-4', results: [{ status: 'passed', attachments: [['image/png', png('c')]] }] },   // dos etiquetas
    // el primer intento falla (su captura se copia pero no ata nada) y el reintento pasa sin imagen
    { title: 'el filtro @ac-5', results: [{ status: 'failed', attachments: [['image/png', png('d')]] }, { status: 'passed' }] },
    { title: 'el orden @ac-5', results: [{ status: 'skipped', attachments: [['image/png', png('e')]] }] },
    // la etiqueta del describe no es la del test
    { title: 'abre la vista', suite: 'flujo @ac-6', results: [{ status: 'passed', attachments: [['image/png', png('f')]] }] },
  ]);
  writeGate(f, ts, 'story-9-9.spec.ts', ['la lista muestra el total @ac-2', 'el detalle abre', 'la lista y el detalle @ac-3 @ac-4',
    'el filtro @ac-5', 'abre la vista']);
  const dest = path.join(f.dodDir, `9.9-captures-${ts}`);
  const cli = runCaptures(f, informe, dest);
  assert.equal(cli.status, 0, cli.stderr);
  const index = JSON.parse(fs.readFileSync(path.join(dest, 'captures.json'), 'utf8'));
  assert.equal(index.length, 6, 'todas se copian');
  assert.deepEqual(index.map((e) => e.acs), [[2], [], [3, 4], [], [], []], 'sólo el intento que pasó, sólo el título del test');
  assert.ok(index.every((e) => e.sha256 === sha256(fs.readFileSync(path.join(dest, e.file)))), 'cada entrada lleva la huella de su archivo');
  assert.match(cli.stdout, /^- .*01-/m, 'el listado por stdout sigue igual');
  const sellos = fs.readFileSync(f.gatesLog, 'utf8').split('\n').filter((l) => l.includes('"type":"e2e-captures"')).map((l) => JSON.parse(l));
  assert.equal(sellos.length, 1, 'una línea de sello en el espejo');
  assert.equal(sellos[0].folder, path.basename(dest));
  assert.equal(sellos[0].sha256, sha256(fs.readFileSync(path.join(dest, 'captures.json'), 'utf8')));

  const r = calc(f);
  assert.equal(r.perAc[2].verdict, 'RUNTIME');
  assert.equal(r.perAc[2].visual.length, 1);
  assert.equal(r.perAc[3].verdict, 'RUNTIME', 'dos etiquetas en un título: la misma imagen vale para los dos');
  assert.equal(r.perAc[4].verdict, 'RUNTIME');
  for (const n of [5, 6]) {
    assert.equal(r.perAc[n].verdict, 'SIN-EVIDENCIA', `el AC ${n} corrió pero no tiene una imagen que cuente`);
    assert.match(r.perAc[n].motivo, MOTIVO);
  }
  assert.equal(r.green, false);
  assert.deepEqual(r.pendientes, [5, 6]);

  // Un adjunto que no sirve no se copia, y se dice por qué (stderr), como lo que falta.
  const img2 = tmp('visev-img-');
  const real = juguete(img2, 'real.png');
  const enlace = path.join(img2, 'enlace.png');
  let hayEnlaces = true;
  try { fs.symlinkSync(real, enlace); } catch { hayEnlaces = false; }
  const falsa = path.join(img2, 'falsa.png'); fs.writeFileSync(falsa, 'esto no es un png');
  const gigante = path.join(img2, 'gigante.png'); fs.writeFileSync(gigante, PNG_HEAD); fs.truncateSync(gigante, 50 * 1024 * 1024 + 1);
  const bmp = path.join(img2, 'dibujo.bmp'); fs.writeFileSync(bmp, 'BM....');
  const rechazadas = [
    ...(hayEnlaces ? [['enlace simbólico', enlace]] : []),
    ['primeros bytes', falsa], ['50 MB', gigante], ['extensión', bmp],
  ];
  const dest2 = path.join(f.dodDir, '9.9-captures-20200101T000000Z');
  const cli2 = runCaptures(f, playwrightReport(img2, rechazadas.map(([que, file], i) => (
    { title: `rechazada ${i} @ac-2`, results: [{ status: 'passed', attachments: [[file.endsWith('.bmp') ? 'image/bmp' : 'image/png', file]] }] }))), dest2);
  assert.equal(cli2.status, 0, 'rechazar un adjunto no cambia el veredicto del gate');
  assert.equal(cli2.stdout.trim(), '', 'no se copió ninguna');
  assert.ok(!fs.existsSync(dest2), 'ni quedó la carpeta');
  for (const [que, file] of rechazadas) {
    assert.ok(cli2.stderr.split('\n').some((l) => l.includes(file) && l.includes(que)), `dice por qué no copió ${path.basename(file)}: ${cli2.stderr}`);
  }

  // El verificador: un gate fresco con captures.json y una imagen puestos a mano, sin el sello del espejo, no cuenta.
  const mano = makeWorkspace({ acs: [[2, '**Given** la lista, **Then** muestra el total.']], rows: [['E1', '`story-9-9.spec.ts::flujo`', '2', 'e2e']] });
  const tsM = compactNow();
  writeGate(mano, tsM, 'story-9-9.spec.ts', ['la lista muestra el total @ac-2']);
  const dirM = path.join(mano.dodDir, `9.9-captures-${tsM}`);
  fs.mkdirSync(dirM, { recursive: true });
  const manoPng = juguete(dirM, '01-a.png', 'puesta a mano');
  writeIndex(mano, tsM, [{ file: '01-a.png', title: 'la lista muestra el total @ac-2', acs: [2], sha256: sha256(fs.readFileSync(manoPng)) }], { seal: false });
  const rMano = calc(mano);
  assert.equal(rMano.perAc[2].verdict, 'SIN-EVIDENCIA', 'sin sello en el espejo no cuenta');
  assert.ok(rMano.avisos.some((a) => /sin sello/.test(a)), `lo dice: ${rMano.avisos}`);
  // …con el sello sí cuenta; y cambiar el índice o la imagen después de sellar lo saca de la cuenta
  writeIndex(mano, tsM, [{ file: '01-a.png', title: 'x', acs: [2], sha256: sha256(fs.readFileSync(manoPng)) }]);
  assert.equal(calc(mano).perAc[2].verdict, 'RUNTIME');
  fs.writeFileSync(path.join(dirM, 'captures.json'), JSON.stringify([{ file: '01-a.png', title: 'x', acs: [2, 3], sha256: sha256(fs.readFileSync(manoPng)) }]));
  assert.equal(calc(mano).perAc[2].verdict, 'SIN-EVIDENCIA', 'índice cambiado después de sellar');
  writeIndex(mano, tsM, [{ file: '01-a.png', title: 'x', acs: [2], sha256: sha256(fs.readFileSync(manoPng)) }]);
  fs.writeFileSync(manoPng, Buffer.concat([PNG_HEAD, Buffer.from('cambiada')]));
  const rCambio = calc(mano);
  assert.equal(rCambio.perAc[2].verdict, 'SIN-EVIDENCIA', 'imagen cambiada después de sellar');
  assert.ok(rCambio.avisos.some((a) => /01-a\.png/.test(a)));

  // Un captures.json ilegible o que no es una lista se dice; las entradas con ruta o sin extensión de imagen no cuentan.
  const rechazos = [
    ['ilegible', { texto: '{no es json' }, /captures\.json ilegible en 9\.9-captures-/],
    ['no es una lista', { texto: '{"file":"x.png"}' }, /no es una lista/],
  ];
  for (const [que, opts, esperado] of rechazos) {
    const w = makeWorkspace({ acs: [[2, '**Given** la lista, **Then** muestra el total.']], rows: [['E1', '`story-9-9.spec.ts::flujo`', '2', 'e2e']] });
    const t = compactNow();
    writeGate(w, t, 'story-9-9.spec.ts', ['x @ac-2']);
    writeIndex(w, t, null, opts);
    const rr = calc(w);
    assert.equal(rr.perAc[2].verdict, 'SIN-EVIDENCIA', que);
    assert.ok(rr.avisos.some((a) => esperado.test(a)), `${que}: ${rr.avisos}`);
  }
  const w2 = makeWorkspace({ acs: [[2, '**Given** la lista, **Then** muestra el total.']], rows: [['E1', '`story-9-9.spec.ts::flujo`', '2', 'e2e']] });
  const t2 = compactNow();
  writeGate(w2, t2, 'story-9-9.spec.ts', ['x @ac-2']);
  const dir2 = path.join(w2.dodDir, `9.9-captures-${t2}`);
  fs.mkdirSync(path.join(dir2, 'sub'), { recursive: true });
  const buenaSha = sha256(fs.readFileSync(juguete(dir2, '01-a.png')));
  fs.writeFileSync(path.join(dir2, 'notas.txt'), 'no es una imagen');
  fs.writeFileSync(path.join(dir2, 'sub', 'b.png'), PNG_HEAD);
  writeIndex(w2, t2, [
    { file: 'sub/b.png', title: 'x', acs: [2], sha256: sha256(PNG_HEAD) },                 // con ruta
    { file: 'notas.txt', title: 'x', acs: [2], sha256: sha256('no es una imagen') },       // extensión que no es de imagen
    { file: 'no-esta.png', title: 'x', acs: [2], sha256: buenaSha },                        // borrada
    { file: '01-a.png', title: 'x', acs: [2] },                                             // sin huella
  ]);
  const r2 = calc(w2);
  assert.equal(r2.perAc[2].verdict, 'SIN-EVIDENCIA');
  assert.equal(r2.avisos.length, 4, `cada rechazo se dice: ${r2.avisos}`);

  // Un gate viejo (anterior al código) o no verde no aporta imágenes aunque su índice esté sellado.
  for (const [que, tsGate, verdict] of [['viejo', compact(2 * 60 * 60 * 1000), 'PASS'], ['no verde', compactNow(), 'FAIL']]) {
    const g = makeWorkspace({ acs: [[2, '**Given** la lista, **Then** muestra el total.']], rows: [['E1', '`story-9-9.spec.ts::flujo`', '2', 'e2e']] });
    writeGate(g, tsGate, 'story-9-9.spec.ts', ['x @ac-2'], verdict);
    const carpeta = path.join(g.dodDir, `9.9-captures-${tsGate}`);
    fs.mkdirSync(carpeta, { recursive: true });
    const huella = sha256(fs.readFileSync(juguete(carpeta, '01-a.png')));
    writeIndex(g, tsGate, [{ file: '01-a.png', title: 'x', acs: [2], sha256: huella }]);
    const rg = calc(g);
    assert.notEqual(rg.perAc[2].verdict, 'RUNTIME', `gate ${que}`);
    assert.deepEqual(rg.perAc[2].visual, [], `gate ${que}: no cuenta la imagen`);
  }
});

// Mutación: copiar sólo `image/*` (como antes) → el .webm no llega a la carpeta y el AC sale SIN-EVIDENCIA.
test('Matriz_Grabacion_Cuenta — un video .webm de Playwright cuenta igual que una captura', () => {
  const f = makeWorkspace({
    acs: [[1, '**Given** la lista de facturas, **Then** muestra el total.']],
    rows: [['E1', '`story-9-9.spec.ts::flujo`', '1', 'e2e']],
  });
  const img = tmp('visev-img-');
  const webm = juguete(img, 'video.webm', 'grabacion');
  const falso = path.join(img, 'falso.webm');
  fs.writeFileSync(falso, 'no es un video');
  const trace = path.join(img, 'trace.zip');
  fs.writeFileSync(trace, 'zip');
  const ts = compactNow();
  const titulo = 'la lista muestra el total @ac-1';
  const informe = playwrightReport(img, [
    { title: titulo, results: [{ status: 'passed', attachments: [['video/webm', webm]] }] },
    { title: 'otro test @ac-1', results: [{ status: 'passed', attachments: [['application/zip', trace], ['video/webm', falso]] }] },
  ]);
  writeGate(f, ts, 'story-9-9.spec.ts', [titulo]);
  const dest = path.join(f.dodDir, `9.9-captures-${ts}`);
  const cli = runCaptures(f, informe, dest);
  assert.equal(cli.status, 0, cli.stderr);
  const copiados = fs.readdirSync(dest);
  assert.ok(copiados.some((n) => n.endsWith('.webm')), `el video se copia: ${copiados}`);
  assert.equal(copiados.filter((n) => n.endsWith('.webm')).length, 1, 'el que no empieza como un webm no se copia');
  assert.ok(/falso\.webm/.test(cli.stderr) && /primeros bytes/.test(cli.stderr), `y se dice: ${cli.stderr}`);
  assert.ok(!copiados.some((n) => n.endsWith('.zip')), 'el trace sigue sin copiarse');

  const r = calc(f);
  assert.equal(r.perAc[1].verdict, 'RUNTIME');
  assert.match(r.perAc[1].visual[0], /\.webm$/);
  assert.equal(r.green, true);
});

// Mutación: no guardar la huella en el espejo, o no verificarla → la imagen cambiada después sigue contando.
test('Humo_ConCaptura_LaGuardaConHuella — la imagen queda en la evidencia con su huella en el registro y en el espejo', () => {
  const f = makeWorkspace();
  const img = tmp('visev-img-');
  const png = juguete(img, 'pantalla.png', 'facturas');
  const res = runSmoke(f, ['--capture', png], ['true']);
  assert.equal(res.status, 0, res.stderr);

  const [entry] = ledgerEntries(f);
  assert.match(entry.capture, /^9\.9-smoke-captures\/\d{8}T\d{6}Z-[0-9a-f]{6}\.png$/);
  const copia = path.join(f.dodDir, entry.capture);
  assert.ok(fs.existsSync(copia), 'la imagen está en la evidencia');
  const huella = sha256(fs.readFileSync(png));
  assert.equal(entry.capture_sha, huella, 'la huella del registro es la de la imagen');
  assert.equal(sha256(fs.readFileSync(copia)), huella, 'y la copia es la misma imagen');
  const espejo = fs.readFileSync(f.gatesLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(espejo.length, 1);
  assert.equal(espejo[0].capture_sha, huella, 'el espejo (fuera del repo) lleva la misma huella');
  assert.ok(!('capture' in espejo[0]), 'el espejo no lleva rutas del repo');

  const r = calc(f);
  assert.equal(r.perAc[1].verdict, 'RUNTIME', JSON.stringify(r.perAc[1]));
  assert.equal(r.perAc[1].visual.length, 1);
  assert.equal(r.green, true);

  // Sin espejo (otro gates.log, vacío) el humo no cuenta, ni su imagen.
  const vacio = path.join(f.home, 'vacio.log'); fs.writeFileSync(vacio, '');
  const sinEspejo = calc(f, { gatesLogPath: vacio });
  assert.notEqual(sinEspejo.perAc[1].verdict, 'RUNTIME');
  assert.deepEqual(sinEspejo.perAc[1].visual, []);

  // La ruta de la imagen sale de la carpeta del registro, o la imagen se borró: el humo sigue valiendo, sin imagen.
  writeLedger(f, [{ ...entry, capture: '../huida.png' }]);
  const conPuntos = calc(f);
  assert.equal(conPuntos.perAc[1].verdict, 'SIN-EVIDENCIA');
  assert.ok(conPuntos.warnings.some((w) => /ruta de la imagen no válida/.test(w)), 'lo dice');
  writeLedger(f, [entry]);
  fs.rmSync(copia);
  const borrada = calc(f);
  assert.equal(borrada.perAc[1].verdict, 'SIN-EVIDENCIA');
  assert.ok(borrada.warnings.some((w) => /imagen ausente/.test(w)));
  assert.match(borrada.perAc[1].motivo, /imagen ausente/, 'y el motivo del AC lo nombra');

  // La imagen cambiada después de correr ya no es la que selló el espejo.
  fs.writeFileSync(copia, 'otra imagen');
  const cambiada = calc(f);
  assert.equal(cambiada.perAc[1].verdict, 'SIN-EVIDENCIA');
  // Y editar también la huella del registro (viaja con el código) tampoco alcanza: el espejo no cambia.
  writeLedger(f, [{ ...entry, capture_sha: sha256(fs.readFileSync(copia)) }]);
  assert.equal(calc(f).perAc[1].verdict, 'SIN-EVIDENCIA');

  // Una grabación .webm vale igual que una captura.
  const w = makeWorkspace();
  assert.equal(runSmoke(w, ['--capture', juguete(img, 'clip.webm', 'clip')], ['true']).status, 0);
  assert.match(ledgerEntries(w)[0].capture, /\.webm$/);
  assert.equal(calc(w).perAc[1].verdict, 'RUNTIME');

  // Con --acs 1,2 la imagen vale para los dos criterios y no para el 3.
  const tres = makeWorkspace({ acs: [1, 2, 3].map((n) => [n, `**Given** la pantalla ${n}, **Then** se ve el total.`]) });
  assert.equal(runSmoke(tres, ['--capture', png], ['true'], { acs: '1,2' }).status, 0);
  const rTres = calc(tres);
  assert.equal(rTres.perAc[1].verdict, 'RUNTIME');
  assert.equal(rTres.perAc[2].verdict, 'RUNTIME');
  assert.deepEqual(rTres.perAc[1].visual, rTres.perAc[2].visual);
  assert.deepEqual(rTres.perAc[3].visual, [], 'el 3 no tiene imagen');
  assert.notEqual(rTres.perAc[3].verdict, 'RUNTIME');

  // --capture sin --acs avisa y no se ata a ningún criterio: otro humo del AC 1, sin imagen, sigue sin tenerla.
  const suelta = makeWorkspace();
  const sinAcs = runSmoke(suelta, ['--capture', png], ['true'], { acs: null });
  assert.equal(sinAcs.status, 0, sinAcs.stderr);
  assert.match(sinAcs.stderr, /sin --acs/);
  assert.deepEqual(ledgerEntries(suelta)[0].acs, []);
  ledgerLine.append({ dodDir: suelta.dodDir, gatesLog: suelta.gatesLog, story: '9.9', acs: [1], v2: { pasaSi: 'abre', outputText: 'HTTP 200' } });
  assert.equal(calc(suelta).perAc[1].verdict, 'SIN-EVIDENCIA');

  // Un humo que no corre la app (una prueba unitaria) no aporta imagen aunque la traiga.
  const unit = makeWorkspace();
  assert.equal(runSmoke(unit, ['--capture', png], ['echo', 'node', '--test', 'x']).status, 0);
  const rUnit = calc(unit);
  assert.notEqual(rUnit.perAc[1].verdict, 'RUNTIME');
  assert.deepEqual(rUnit.perAc[1].visual, []);

  // Si la copia falla después de correr (el comando borra la imagen), el humo sale con el exit del comando, el registro
  // anota por qué y la matriz lo dice en el motivo del criterio.
  const roto = makeWorkspace();
  const efimera = juguete(img, 'efimera.png');
  const rotoRes = runSmoke(roto, ['--capture', efimera], ['rm', efimera]);
  assert.equal(rotoRes.status, 0, rotoRes.stderr);
  const [e] = ledgerEntries(roto);
  assert.ok(!('capture' in e) && typeof e.capture_error === 'string' && e.capture_error.length > 0, JSON.stringify(e));
  const rRoto = calc(roto);
  assert.equal(rRoto.perAc[1].verdict, 'SIN-EVIDENCIA');
  assert.match(rRoto.perAc[1].motivo, /la captura no se pudo guardar: /);
  assert.match(rRoto.perAc[1].motivo, MOTIVO);
});

// Mutación: no validar el archivo antes de correr → el comando corre y el humo no falla.
test('Humo_CapturaQueNoEsImagen_Falla — lo que no sirve como captura hace fallar el humo sin correr el comando', () => {
  const img = tmp('visev-img-');
  const txt = path.join(img, 'nota.txt');
  fs.writeFileSync(txt, 'no es una imagen');
  const falsa = path.join(img, 'falsa.png'); fs.writeFileSync(falsa, 'esto no es un png');
  const falsaWebm = path.join(img, 'falsa.webm'); fs.writeFileSync(falsaWebm, PNG_HEAD);
  const gigante = path.join(img, 'gigante.png'); fs.writeFileSync(gigante, PNG_HEAD); fs.truncateSync(gigante, 50 * 1024 * 1024 + 1);
  const real = juguete(img, 'real.png');
  const enlace = path.join(img, 'enlace.png');
  const casos = [
    [txt, /\.png|png/, 'un .txt'],
    [path.join(img, 'no-existe.png'), /no existe/, 'un archivo que no existe'],
    [falsa, /primeros bytes/, 'un .png que no empieza como un png'],
    [falsaWebm, /primeros bytes/, 'un .webm que no empieza como un webm'],
    [gigante, /50 MB/, 'un archivo de más de 50 MB'],
  ];
  try { fs.symlinkSync(real, enlace); casos.push([enlace, /enlace simbólico/, 'un enlace simbólico']); } catch { /* sin enlaces en esta máquina */ }
  for (const [archivo, motivo, que] of casos) {
    const f = makeWorkspace();
    const marca = path.join(img, `corrio-${path.basename(archivo)}`);
    const res = runSmoke(f, ['--capture', archivo], ['touch', marca]);
    assert.equal(res.status, 2, `${que}: sale 2 (${res.stderr})`);
    assert.match(res.stderr, /--capture/, `${que}: nombra la opción`);
    assert.match(res.stderr, motivo, `${que}: dice el motivo (${res.stderr})`);
    assert.match(res.stderr, /webm/, `${que}: dice qué formatos sirven`);
    assert.ok(!fs.existsSync(marca), `${que}: el comando no corrió`);
    assert.ok(!fs.existsSync(path.join(f.dodDir, '9.9-smoke-ledger.jsonl')), `${que}: no deja registro`);
  }
  // sin valor
  const f = makeWorkspace();
  const res = runSmoke(f, ['--capture'], ['true']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--capture necesita/);
});

// Mutación: clasificar todo AC como de pantalla (sin mirar la story) → el AC de backend sale SIN-EVIDENCIA.
test('Matriz_Backend_SigueIgual — un AC que no es de pantalla no pide imagen; y las marcas por AC', () => {
  // (a) story de backend: con un humo verde, RUNTIME sin imagen
  const back = makeWorkspace({ ui: false, acs: [[1, '**Given** una factura, **Then** la API la devuelve.']] });
  ledgerLine.append({ dodDir: back.dodDir, gatesLog: back.gatesLog, story: '9.9', acs: [1],
    v2: { pasaSi: 'responde 200 con la factura', outputText: 'HTTP 200' } });
  const rb = calc(back);
  assert.equal(rb.perAc[1].verdict, 'RUNTIME');
  assert.ok(!rb.perAc[1].pantalla, 'no es de pantalla');
  assert.ok(!('pantalla' in rb.perAc[1]) && !('visual' in rb.perAc[1]), 'y su AC no lleva campos nuevos: la matriz queda igual que antes');
  assert.equal(rb.green, true);
  assert.deepEqual(rb.avisos, []);

  // (b) story de interfaz con un AC marcado @sin-pantalla: ese AC sigue con el humo; el otro pide imagen
  const mixta = makeWorkspace({ acs: [
    [1, '**Given** la pantalla de facturas, **Then** muestra el total.'],
    [2, '**Given** una factura, **Then** la API la devuelve. @sin-pantalla'],
  ] });
  ledgerLine.append({ dodDir: mixta.dodDir, gatesLog: mixta.gatesLog, story: '9.9', acs: [1, 2],
    v2: { pasaSi: 'la pantalla abre y la API responde', outputText: 'HTTP 200' } });
  const rm2 = calc(mixta);
  assert.equal(rm2.perAc[1].verdict, 'SIN-EVIDENCIA');
  assert.equal(rm2.perAc[2].verdict, 'RUNTIME');
  assert.ok(!rm2.perAc[2].pantalla);

  // (c) story de backend con un AC marcado @pantalla: ése, y sólo ése, pide imagen
  const marcada = makeWorkspace({ ui: false, acs: [
    [1, '**Given** una factura, **Then** la API la devuelve.'],
    [2, '**Given** el informe, **Then** se ve el total en el tablero. @pantalla'],
  ] });
  ledgerLine.append({ dodDir: marcada.dodDir, gatesLog: marcada.gatesLog, story: '9.9', acs: [1, 2],
    v2: { pasaSi: 'la API responde y el tablero abre', outputText: 'HTTP 200' } });
  const rmk = calc(marcada);
  assert.equal(rmk.perAc[1].verdict, 'RUNTIME');
  assert.equal(rmk.perAc[2].verdict, 'SIN-EVIDENCIA');
  assert.equal(rmk.perAc[2].pantalla, true);
});

// Mutación: sacar una de las dos guías, o `--capture` de su texto. Si la definición de hecho no está, falla (no se saltea).
test('Guia_PantallaPideImagen — el paso «Probar en vivo» y la definición de hecho piden captura o grabación', () => {
  const paso = path.join(SCRIPTS, '..', 'steps', 'step-10-live-check.md');
  const guia = path.join(SCRIPTS, '..', '..', '..', 'guides', 'definition-of-done.md');
  assert.ok(fs.existsSync(paso), `no encontré el paso en ${paso}`);
  assert.ok(fs.existsSync(guia), `no encontré la definición de hecho en ${guia}: sin ella esta prueba no mide nada`);
  const textos = [['el paso «Probar en vivo»', fs.readFileSync(paso, 'utf8')], ['la definición de hecho', fs.readFileSync(guia, 'utf8')]];
  for (const [que, t] of textos) {
    // Con `\s+` porque las guías cortan los renglones. `ok(re.test())` y no `match`: si falla, `match` vuelca la guía entera.
    assert.ok(/AC\s+de\s+pantalla/.test(t), `${que} nombra el AC de pantalla`);
    assert.ok(/captura\s+o\s+(una\s+)?grabaci[oó]n/i.test(t), `${que} pide captura o grabación`);
    assert.ok(/--capture/.test(t), `${que} nombra --capture del humo`);
    assert.ok(/@ac-N/.test(t), `${que} nombra la etiqueta del E2E`);
    assert.ok(/@sin-pantalla/.test(t), `${que} nombra la marca para soltar un AC`);
  }
});

// Mutación: ignorar la fecha de arranque → el AC del arranque anterior sale SIN-EVIDENCIA y la matriz roja.
test('Matriz_StoryYaEnCurso_AvisoSinRojo — antes del corte, un AC de pantalla sin imagen avisa y no bloquea', () => {
  const CORTE = rm.VISUAL_EVIDENCE_FROM;
  const corte = Date.parse(CORTE);
  const HORA = 60 * 60 * 1000;
  const DIA = 24 * HORA;
  const dia = (n) => new Date(corte + n * DIA).toISOString().slice(0, 10);
  const armar = (opts) => {
    const f = makeWorkspace(opts);
    ledgerLine.append({ dodDir: f.dodDir, gatesLog: f.gatesLog, story: '9.9', acs: [1],
      v2: { pasaSi: 'la pantalla de facturas abre', outputText: 'HTTP 200' } });
    return f;
  };
  const marcador = (f, nombre, datos) => fs.writeFileSync(path.join(f.activeDir, nombre), typeof datos === 'string' ? datos : JSON.stringify(datos));

  // (a) por la fecha de arranque que pasa quien llama
  const f = armar();
  const antes = calc(f, { startedAt: new Date(corte - HORA).toISOString() });
  assert.equal(antes.perAc[1].verdict, 'RUNTIME', 'no se frena a mitad de su trabajo');
  assert.equal(antes.green, true, 'la matriz no sale roja');
  assert.equal(antes.avisos.length, 1);
  assert.match(antes.avisos[0], MOTIVO);
  assert.match(antes.avisos[0], /--capture/, 'el aviso dice cómo sacar la captura');
  assert.match(antes.avisos[0], /dada por quien llamó/, 'y de dónde salió la fecha de arranque');
  assert.ok(antes.warnings.some((w) => MOTIVO.test(w)), 'y se ve entre los avisos de la matriz');
  const despues = calc(f, { startedAt: new Date(corte + HORA).toISOString() });
  assert.equal(despues.perAc[1].verdict, 'SIN-EVIDENCIA');
  assert.equal(despues.green, false);
  assert.deepEqual(despues.avisos, []);

  // (b) sin marcador, por el `created:` de la story: con la fecha sola cuenta como el final de ese día, así que una story
  // creada el día del corte rige. Sin ninguna fecha, rige.
  const vieja = calc(armar({ created: dia(-1) }));
  assert.equal(vieja.green, true);
  assert.match(vieja.avisos[0], /created:/, 'el aviso dice que la fecha salió del created:');
  assert.equal(calc(armar({ created: dia(0) })).perAc[1].verdict, 'SIN-EVIDENCIA', 'creada el día del corte: rige');
  assert.equal(calc(armar({ created: dia(1) })).perAc[1].verdict, 'SIN-EVIDENCIA');
  assert.equal(calc(armar()).perAc[1].verdict, 'SIN-EVIDENCIA');

  // (c) el marcador de la story manda sobre el `created:`; se busca por su ruta, aunque el marcador la guarde relativa al repo
  const arranque = new Date(corte - DIA).toISOString();
  const conMarcador = armar({ created: dia(1) });
  marcador(conMarcador, 'sesion-a.json', { storyId: '9.9', storyPath: 'specs/stories/9-9-fixture.md', repoPath: conMarcador.repo, startedAt: arranque });
  const rMarcador = calc(conMarcador);
  assert.equal(rMarcador.perAc[1].verdict, 'RUNTIME');
  assert.equal(rMarcador.avisos.length, 1);
  assert.match(rMarcador.avisos[0], /marcador/, 'y que salió del marcador');

  // por el número, sólo si en el repo hay UN único marcador con ese número
  const porNumero = armar({ created: dia(1) });
  marcador(porNumero, 'sesion-b.json', { storyId: '9.9', storyPath: 'specs/stories/otra.md', repoPath: porNumero.repo, startedAt: arranque });
  assert.equal(calc(porNumero).perAc[1].verdict, 'RUNTIME', 'un único marcador con el número: vale');
  marcador(porNumero, 'sesion-c.json', { storyId: '9.9', storyPath: 'specs/stories/tercera.md', repoPath: porNumero.repo, startedAt: arranque });
  assert.equal(calc(porNumero).perAc[1].verdict, 'SIN-EVIDENCIA', 'con dos marcadores del mismo número no se sabe cuál es: se ignoran');

  // un marcador del mismo número en otro repo no cuenta
  const otro = armar();
  marcador(otro, 'sesion-d.json', { storyId: '9.9', storyPath: 'specs/stories/9-9-fixture.md', repoPath: path.join(otro.ws, 'OtroRepo'), startedAt: arranque });
  assert.equal(calc(otro).perAc[1].verdict, 'SIN-EVIDENCIA');

  // un marcador que no se puede leer se dice
  const roto = armar();
  marcador(roto, 'sesion-e.json', '{no es json');
  const rRoto = calc(roto);
  assert.equal(rRoto.perAc[1].verdict, 'SIN-EVIDENCIA');
  assert.ok(rRoto.avisos.some((a) => /marcador ilegible: sesion-e\.json/.test(a)), `${rRoto.avisos}`);
});

test('CapturasSinIndice_PortonAnterior @story-7.34 @ac-9 — carpeta de capturas sin captures.json: portón viejo, con la acción', () => {
  // 🔴 rojo: decía «captures.json ilegible» de un índice que no existe (capturas de antes de la regla del índice).
  const w = makeWorkspace({ acs: [[2, '**Given** la lista, **Then** muestra el total.']], rows: [['E1', '`story-9-9.spec.ts::flujo`', '2', 'e2e']] });
  const t = compactNow();
  writeGate(w, t, 'story-9-9.spec.ts', ['x @ac-2']);
  const dir = path.join(w.dodDir, `9.9-captures-${t}`);
  fs.mkdirSync(dir, { recursive: true });
  juguete(dir, '01-a.png');
  const r = calc(w);
  assert.equal(r.perAc[2].verdict, 'SIN-EVIDENCIA');
  assert.ok(r.avisos.some((a) => /anterior a la regla del índice/.test(a) && /volvé a correr el portón E2E con los specs de la story/.test(a)), `${r.avisos}`);
  assert.ok(!r.avisos.some((a) => /ilegible/.test(a)), `${r.avisos}`);
});

test('CapturasIndiceQueNoParsea_SigueIlegible @story-7.34 @ac-10 — un índice que existe y no parsea sigue siendo ilegible', () => {
  const w = makeWorkspace({ acs: [[2, '**Given** la lista, **Then** muestra el total.']], rows: [['E1', '`story-9-9.spec.ts::flujo`', '2', 'e2e']] });
  const t = compactNow();
  writeGate(w, t, 'story-9-9.spec.ts', ['x @ac-2']);
  writeIndex(w, t, null, { texto: '{no es json' });
  const r = calc(w);
  assert.ok(r.avisos.some((a) => /captures\.json ilegible en 9\.9-captures-/.test(a)), `${r.avisos}`);
  assert.ok(!r.avisos.some((a) => /anterior a la regla del índice/.test(a)), `${r.avisos}`);
});
