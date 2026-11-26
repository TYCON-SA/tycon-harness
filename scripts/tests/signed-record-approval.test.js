'use strict';
/**
 * signed-record-approval.test.js — el registro del cuadro que aprobó el dueño, en cada constancia nueva: qué archivos lo
 * llevan, cómo lo arman los escritores y que los lectores de siempre no cambian.
 *
 *   T10 Catalogo_LasRutasYLasFirmas @story-8.334 @ac-10 · las rutas del catálogo (también la carpeta de una ejecución en
 *     una subcarpeta y las barras de Windows), qué firmas valen en cada una; las aprobaciones pendientes y una ruta
 *     cualquiera, afuera.
 *   T11 Escritores_RegistranElCuadro @story-8.334 @ac-11 · con el registro de un click, de un «aprobado», de la ventana y
 *     de la terminal: la exención, la exención en vivo con sus tres líneas manuales, una aprobación manual y la firma
 *     sobre un archivo llevan los cinco campos y la CI las da por buenas; las líneas automáticas, sin cuadro.
 *   T12 Escritores_SinCuadro_LoDicen @story-8.334 @ac-12 · la delegación, la revisión, lo hecho y avisado y la firma de
 *     trámite no dejan cuadro, y la exención sin cuadro lo dice.
 *   T13 Lectores_IgnoranElCuadro @story-8.334 @ac-13 · tieneConstancia, faltan, leer, normalizar, problemasDelRegistro y
 *     la cadena de las exenciones en vivo dan lo mismo con el cuadro y sin él.
 *   T14 NadaRegistraDespues @story-8.334 @ac-14 · armar el cuadro no toca lo escrito, y sólo lo arman los escritores.
 *
 * Todo con casa y carpetas temporales. Correr: node --test scripts/tests/signed-record-approval.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// la casa de la prueba, antes de cargar nada que la lea
const CASA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sra-casa-')));
process.env.HOME = CASA;
process.env.USERPROFILE = CASA;

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib');
const sra = require(path.join(ROOT, 'scripts', 'lib', 'signed-record-approval.js'));
const approvals = require(path.join(LIB, 'approvals.js'));
const exemptions = require(path.join(LIB, 'exemptions.js'));
const waiver = require(path.join(LIB, 'runtime-waiver.js'));
const ow = require(path.join(ROOT, 'scripts', 'lib', 'owner-window.js'));

test.after(() => fs.rmSync(CASA, { recursive: true, force: true }));

function carpeta(t, nombre) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sra-${nombre}-`)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const lineas = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
// lo que devuelve `exigir` para cada vía de una persona
// como lo escribe la ventana (owner-window.js): `aprobada_en` es la sesión donde aprobó el dueño y `ts`, la hora
const CLICK = { codigo: 0, via: 'click', registro: { aprobacion: hex('click'), aprobada_en: 'sesion-del-dueno-1', ts: '2026-11-25T12:00:05.000Z' } };
const MENSAJE = { codigo: 0, via: 'mensaje', registro: { aprobacion: hex('mensaje'), aprobada_en: 'sesion-del-dueno-2', ts: '2026-11-25T12:01:05.000Z' } };
const VENTANA = { codigo: 0, via: 'ventana', registro: { firma: 'control-change', sesion: 's1', sha256: hex('cmd'), comando: 'bash x', ts: '2026-11-25T12:02:00.000Z' } };
const TERMINAL = { codigo: 0, via: 'terminal' };

test('T10 Catalogo_LasRutasYLasFirmas', () => {
  const adentro = ['.github/control-changes/abc.json', '.tycon/control-changes/abc.json', '.github/control-changes.jsonl',
    '.tycon/control-changes.jsonl', '.tycon/exemptions.jsonl', '.tycon/runtime-waivers.jsonl',
    '.advisors/pipeline-runs/r1/approvals.jsonl', 'producto/.advisors/pipeline-runs/r1/approvals.jsonl',
    '.tycon\\exemptions.jsonl', './.tycon/runtime-waivers.jsonl'];
  for (const r of adentro) assert.ok(sra.entradaDe(r), `${r} está en el catálogo`);
  for (const r of ['tasks/pending-approvals.jsonl', 'tasks/pending-approvals/x.json', 'src/x.json', '.tycon/exemptions.jsonl.bak',
    'docs/.tycon/exemptions.jsonl', '.advisors/approvals.jsonl']) assert.strictEqual(sra.entradaDe(r), null, `${r} no está`);
  assert.strictEqual(sra.entradaDe('.github/control-changes/abc.json').entero, true, 'un archivo por firma es una constancia entera');
  // las firmas que valen en cada uno
  const firmas = (r, l, f) => sra.entradaDe(r).firmas(l, f);
  assert.deepStrictEqual(firmas('.tycon/control-changes.jsonl', {}), ['control-change', 'refresh-after-main']);
  assert.deepStrictEqual(firmas('.tycon/exemptions.jsonl', { campo: 'advisors_exempt' }), ['advisors_exempt']);
  assert.deepStrictEqual(firmas('.tycon/exemptions.jsonl', { campo: 'dod_runtime_exempt' }), ['dod_runtime_exempt']);
  assert.deepStrictEqual(firmas('.tycon/exemptions.jsonl', { campo: 'otro' }), []);
  assert.deepStrictEqual(firmas('.tycon/runtime-waivers.jsonl', {}), ['runtime-waiver']);
  assert.deepStrictEqual(firmas('.advisors/pipeline-runs/r1/approvals.jsonl', {}, 'runtime-waiver'), ['runtime-waiver'], 'una firma del catálogo vale');
  assert.deepStrictEqual(firmas('.advisors/pipeline-runs/r1/approvals.jsonl', {}, 'inventada'), [], 'una que no está en el catálogo, no');
  // en las aprobaciones de una ejecución, sólo las manuales llevan cuadro
  const e = sra.entradaDe('.advisors/pipeline-runs/r1/approvals.jsonl');
  assert.strictEqual(e.mira({ tipo: 'manual' }), true);
  assert.strictEqual(e.mira({ tipo: 'automatica' }), false);
});

test('T11 Escritores_RegistranElCuadro', (t) => {
  // lo que cada vía deja en el cuadro
  const click = sra.aprobacionDe(CLICK, 'save');
  assert.deepStrictEqual(click, { aprobacion: hex('click'), firma: 'save', via: 'click', aprobada_en: '2026-11-25T12:00:05.000Z' });
  assert.deepStrictEqual(sra.aprobacionDe(MENSAJE, 'save'), { aprobacion: hex('mensaje'), firma: 'save', via: 'mensaje', aprobada_en: '2026-11-25T12:01:05.000Z' });
  const ventana = sra.aprobacionDe(VENTANA, 'control-change');
  assert.strictEqual(ventana.via, 'ventana');
  assert.strictEqual(ventana.aprobacion, hex(sra.canonico(VENTANA.registro)), 'la ventana: el id de su pedido');
  assert.strictEqual(ventana.aprobada_en, VENTANA.registro.ts);
  const t1 = sra.aprobacionDe(TERMINAL, 'runtime-waiver', { ahora: Date.parse('2026-11-25T13:00:00Z') });
  const t2 = sra.aprobacionDe(TERMINAL, 'runtime-waiver', { ahora: Date.parse('2026-11-25T13:00:00Z') });
  assert.match(t1.aprobacion, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(t1.aprobacion, t2.aprobacion, 'dos firmas en la terminal no comparten id');
  assert.strictEqual(t1.aprobada_en, '2026-11-25T13:00:00.000Z');

  // la exención de una historia
  const repo = carpeta(t, 'repo');
  exemptions.anotar(repo, { story: '9.9', campo: 'advisors_exempt', archivo: 'specs/x.md', via: 'click', sesion: 's1',
    aprobacion: sra.aprobacionDe(CLICK, 'advisors_exempt'), avisar: () => {} });
  const [ex] = lineas(path.join(repo, '.tycon', 'exemptions.jsonl'));
  const exl = JSON.parse(ex);
  assert.deepStrictEqual(Object.keys(exl.cuadro).sort(), ['aprobacion', 'aprobada_en', 'firma', 'huella', 'via']);
  assert.deepStrictEqual(sra.verificar({ ruta: '.tycon/exemptions.jsonl', texto: ex }), { ok: true });

  // la exención en vivo y sus tres líneas manuales: la misma aprobación
  const apr = sra.aprobacionDe(MENSAJE, 'runtime-waiver');
  const log = path.join(repo, '.tycon', 'runtime-waivers.jsonl');
  waiver.appendWaiver({ story: '9.9', acs: [3, 1, 2], matrixHash: 'm1', approvedBy: 'Ana', nowIso: '2026-11-25T12:01:10.000Z', logPath: log,
    ok: { tipo: 'manual', quien: 'Ana', via: 'mensaje' }, aprobacion: apr });
  const run = path.join(repo, '.advisors', 'pipeline-runs', 'r1');
  for (const l of approvals.lineasDeFirmaPorTerminal([1, 2, 3], 'Ana')) approvals.anotar(run, { ...l, aprobacion: apr });
  approvals.anotar(run, { que: 'algo automático', tipo: 'automatica', quien: 'el arnés', aprobacion: apr });
  const [w] = lineas(log);
  const manuales = lineas(path.join(run, 'approvals.jsonl'));
  assert.strictEqual(manuales.length, 4);
  const delPedido = new Map();
  for (const x of [w, ...manuales.slice(0, 3)]) {
    const c = JSON.parse(x).cuadro;
    delPedido.set(c.aprobacion, [...(delPedido.get(c.aprobacion) || []), { firma: c.firma, aprobada_en: c.aprobada_en }]);
  }
  assert.deepStrictEqual([...delPedido.keys()], [apr.aprobacion], 'la exención en vivo y sus líneas comparten id');
  assert.deepStrictEqual(sra.verificar({ ruta: '.tycon/runtime-waivers.jsonl', texto: w, delPedido }), { ok: true });
  for (const x of manuales.slice(0, 3)) {
    assert.deepStrictEqual(sra.verificar({ ruta: '.advisors/pipeline-runs/r1/approvals.jsonl', texto: x, delPedido }), { ok: true });
  }
  assert.strictEqual(JSON.parse(manuales[3]).cuadro, undefined, 'una línea automática no lleva cuadro');

  // una aprobación manual cualquiera, con el click
  const run2 = path.join(repo, '.advisors', 'pipeline-runs', 'r2');
  approvals.anotar(run2, { que: 'el ok de guardar', tipo: 'manual', quien: 'Ana', via: 'click', aprobacion: sra.aprobacionDe(CLICK, 'save') });
  const [g] = lineas(path.join(run2, 'approvals.jsonl'));
  assert.deepStrictEqual(sra.verificar({ ruta: '.advisors/pipeline-runs/r2/approvals.jsonl', texto: g }), { ok: true });

  // un cambio de control en un archivo por firma: el objeto entero lleva el cuadro
  const cc = sra.conCuadro({ hash: hex('h'), rules: [{ path: 'a', blob: 'b' }], at: '2026-11-25', by: 'dueño' }, ventana);
  assert.deepStrictEqual(sra.verificar({ ruta: '.github/control-changes/x.json', texto: JSON.stringify(cc, null, 2) }), { ok: true });

  // la firma sobre un archivo guarda la aprobación para quien escribe la constancia
  const archivo = path.join(repo, 'specs', 'x.md');
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, 'x');
  const casa = carpeta(t, 'casa-ow');
  const aprobArchivo = sra.aprobacionDe(CLICK, 'advisors_exempt');
  ow.firmarArchivo({ firma: 'advisors_exempt', via: 'click', sesion: 'sesion-uno', archivo, casa, aprobacion: aprobArchivo });
  const usada = ow.consumirArchivo({ firma: 'advisors_exempt', sesion: 'sesion-uno', archivo, casa });
  assert.strictEqual(usada.ok, true, usada.motivo);
  assert.deepStrictEqual(usada.constancia.aprobacion, aprobArchivo);

  // run-base-controls.sh escribe sus tres constancias con el registro del cuadro
  const rbc = fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'run-base-controls.sh'), 'utf8');
  const escrituras = rbc.split('\n').filter((l) => /^\s*writeApproval\(root, out, entries, /.test(l));
  assert.ok(escrituras.length >= 3 && escrituras.every((l) => l.includes('withApprovalRecord(')), escrituras.join('\n'));
});

test('T12 Escritores_SinCuadro_LoDicen', (t) => {
  const reg = CLICK.registro;
  for (const via of ['delegacion', 'revision', 'avisado', 'automatica', 'otra']) {
    assert.strictEqual(sra.aprobacionDe({ codigo: 0, via, registro: reg }, 'save'), null, via);
  }
  assert.strictEqual(sra.aprobacionDe({ codigo: 1, via: 'click', registro: reg }, 'save'), null, 'una firma que no se dio');
  assert.strictEqual(sra.aprobacionDe({ codigo: 0, via: 'click', registro: { aprobada_en: 'x' } }, 'save'), null, 'un click sin su registro');
  assert.strictEqual(sra.aprobacionDe(null, 'save'), null);
  const repo = carpeta(t, 'repo');
  let dijo = '';
  exemptions.anotar(repo, { story: '9.9', campo: 'advisors_exempt', archivo: 'specs/x.md', via: 'delegacion', sesion: 's1', avisar: (x) => { dijo += x; } });
  const [l] = lineas(path.join(repo, '.tycon', 'exemptions.jsonl'));
  assert.strictEqual(JSON.parse(l).cuadro, undefined);
  assert.match(dijo, /va sin el cuadro del dueño: con la CI en freno, el pedido no entra; repetí la firma con el cuadro/);
  assert.strictEqual(sra.verificar({ ruta: '.tycon/exemptions.jsonl', texto: l }).ok, false, 'la CI no la da por buena');
});

test('T13 Lectores_IgnoranElCuadro', (t) => {
  const repo = carpeta(t, 'repo');
  const conC = carpeta(t, 'con');
  const sinC = carpeta(t, 'sin');
  // las exenciones
  const base = { story: '9.9', campo: 'advisors_exempt', archivo: 'specs/x.md', via: 'click', sesion: 's1', ts: '2026-11-25T12:00:00.000Z', avisar: () => {} };
  exemptions.anotar(conC, { ...base, aprobacion: sra.aprobacionDe(CLICK, 'advisors_exempt') });
  exemptions.anotar(sinC, base);
  const tc = fs.readFileSync(path.join(conC, '.tycon', 'exemptions.jsonl'), 'utf8');
  const ts = fs.readFileSync(path.join(sinC, '.tycon', 'exemptions.jsonl'), 'utf8');
  assert.notStrictEqual(tc, ts);
  assert.strictEqual(exemptions.tieneConstancia(tc, '9.9', 'advisors_exempt', 'specs/x.md'), exemptions.tieneConstancia(ts, '9.9', 'advisors_exempt', 'specs/x.md'));
  assert.strictEqual(exemptions.tieneConstancia(tc, '9.9', 'advisors_exempt', 'specs/x.md'), true);
  // las aprobaciones de una ejecución
  const runC = path.join(repo, 'c');
  const runS = path.join(repo, 's');
  const e = { que: 'plan', cuando: '2026-11-25T12:00:00.000Z', tipo: 'manual', quien: 'Ana', via: 'click' };
  approvals.anotar(runC, { ...e, aprobacion: sra.aprobacionDe(CLICK, 'plan-approval') });
  approvals.anotar(runS, e);
  const lc = approvals.leer(runC);
  const ls = approvals.leer(runS);
  const sinCuadro = ({ cuadro, ...x }) => x; // eslint-disable-line no-unused-vars
  assert.deepStrictEqual(lc.lineas.map(sinCuadro), ls.lineas);
  assert.ok(lc.lineas[0].cuadro, 'leer la trae con su cuadro');
  assert.deepStrictEqual(approvals.normalizar(lc.lineas[0]).cuadro, lc.lineas[0].cuadro, 'normalizar conserva el cuadro');
  const roster = { registro_aprobaciones: true };
  assert.deepStrictEqual(approvals.problemasDelRegistro({ registro: lc, roster }), approvals.problemasDelRegistro({ registro: ls, roster }));
  // la cadena de las exenciones en vivo
  const logC = path.join(repo, 'wc.jsonl');
  const logS = path.join(repo, 'ws.jsonl');
  const w = { story: '9.9', acs: [1, 2], matrixHash: 'm1', approvedBy: 'Ana', nowIso: '2026-11-25T12:00:00.000Z', ok: { tipo: 'manual', quien: 'Ana', via: 'click' } };
  const ec = waiver.appendWaiver({ ...w, logPath: logC, aprobacion: sra.aprobacionDe(CLICK, 'runtime-waiver') });
  const es = waiver.appendWaiver({ ...w, logPath: logS });
  assert.strictEqual(ec.chain, es.chain, 'el cuadro no entra en la cadena');
  assert.strictEqual(waiver.verifyChain(logC).entries.length, 1);
  assert.strictEqual(waiver.verifyChain(logS).entries.length, 1);
});

test('T14 NadaRegistraDespues', (t) => {
  const linea = { story: '9.9', campo: 'advisors_exempt', archivo: 'specs/x.md' };
  const copia = JSON.parse(JSON.stringify(linea));
  const con = sra.conCuadro(linea, sra.aprobacionDe(CLICK, 'advisors_exempt'));
  assert.deepStrictEqual(linea, copia, 'conCuadro devuelve otra línea y no toca la que recibe');
  assert.ok(con.cuadro);
  assert.strictEqual(sra.conCuadro(linea, null), linea, 'sin aprobación, la misma línea');
  // un archivo ya escrito no cambia por leerlo ni verificarlo
  const repo = carpeta(t, 'repo');
  exemptions.anotar(repo, { story: '9.9', campo: 'advisors_exempt', archivo: 'specs/x.md', via: 'delegacion', sesion: 's1', avisar: () => {} });
  const f = path.join(repo, '.tycon', 'exemptions.jsonl');
  const antes = fs.readFileSync(f);
  for (const l of lineas(f)) sra.verificar({ ruta: '.tycon/exemptions.jsonl', texto: l });
  exemptions.tieneConstancia(antes.toString('utf8'), '9.9', 'advisors_exempt', 'specs/x.md');
  assert.ok(fs.readFileSync(f).equals(antes), 'el archivo queda igual, byte a byte');
  // sólo los escritores arman el cuadro: conCuadro se llama desde ellos y desde ningún otro lado
  const llamadas = [];
  const mirar = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, n.name);
      if (n.isDirectory()) { if (!['node_modules', 'tests', '.git'].includes(n.name)) mirar(p); continue; }
      if (!/\.(js|sh)$/.test(n.name)) continue;
      if (/\.conCuadro\(/.test(fs.readFileSync(p, 'utf8'))) llamadas.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  mirar(path.join(ROOT, 'scripts'));
  mirar(path.join(ROOT, 'skills'));
  assert.deepStrictEqual(llamadas.sort(), [
    'scripts/ci/run-base-controls.sh',
    'skills/tycon-pipeline/scripts/lib/approvals.js',
    'skills/tycon-pipeline/scripts/lib/exemptions.js',
    'skills/tycon-pipeline/scripts/lib/runtime-waiver.js',
  ]);
});

// T15 · 🔴 Falla con: el cuadro guarda en `aprobada_en` el id de la sesión donde aprobó el dueño, que es lo que el
//    registro de la ventana (owner-window.js) guarda en su campo `aprobada_en`; la hora del registro es `ts`.
test('T15 Cuadro_AprobadaEnEsLaHora', () => {
  const sesion = 'sesion-del-dueno-3';
  const ts = '2026-11-25T12:00:05.000Z';
  for (const via of ['click', 'mensaje', 'terminal']) {
    const a = sra.aprobacionDe({ codigo: 0, via, registro: { aprobacion: hex(via), aprobada_en: sesion, ts } }, 'control-change');
    assert.strictEqual(a.aprobada_en, ts, `${via}: la hora del registro, no la sesión`);
  }
  // un registro sin `ts` con la hora en `aprobada_en` (una forma vieja) la sigue tomando; una sesión, nunca
  assert.strictEqual(sra.aprobacionDe({ codigo: 0, via: 'click', registro: { aprobacion: hex('v'), aprobada_en: ts } }, 'f').aprobada_en, ts);
  assert.strictEqual(sra.aprobacionDe({ codigo: 0, via: 'click', registro: { aprobacion: hex('s'), aprobada_en: sesion } }, 'f').aprobada_en, '');
});
