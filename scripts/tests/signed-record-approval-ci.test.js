'use strict';
/**
 * signed-record-approval-ci.test.js — la regla `constancia-sin-cuadro` del portón de CI.
 *
 * Cada línea nueva de una constancia que firma una persona trae el registro del cuadro con que el dueño la aprobó: su
 * firma vale en ese archivo, su vía es de una persona, su huella es la de esa línea y su aprobación no se usó antes en
 * el historial de la base. El modo lo fija la biblioteca (`aviso` la lista y pasa; `freno` frena), y las pruebas lo
 * fijan dentro del proceso. Repos de git de juguete en carpetas temporales, casa temporal, sin red.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync, execFileSync } = require('child_process');

// la casa es temporal antes de cargar nada del arnés: ninguna prueba lee ni escribe la de la persona
const CASA = fs.mkdtempSync(path.join(os.tmpdir(), 'cuadro-ci-casa-'));
process.env.HOME = CASA;
process.env.USERPROFILE = CASA;
for (const v of ['TYCON_HOME', 'XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'TYCON_CI_BASE']) delete process.env[v];
process.on('exit', () => fs.rmSync(CASA, { recursive: true, force: true }));

const RAIZ = path.join(__dirname, '..', '..');
const LIB = path.join(RAIZ, 'scripts', 'lib', 'signed-record-approval.js');
const GATE = path.join(RAIZ, 'scripts', 'ci', 'tycon-ci-gate.js');
const SRA = require(LIB);
const gate = require(GATE);
const MODO_DE_FABRICA = SRA.MODO;

const FECHA = '2026-11-25T10:00:00Z';
const SID = 's-cuadro';
const hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const EXENCIONES = '.tycon/exemptions.jsonl';
const EN_VIVO = '.tycon/runtime-waivers.jsonl';
const CAMBIOS_TYCON = '.tycon/control-changes.jsonl';
const CAMBIOS_GITHUB = '.github/control-changes.jsonl';
const APROBACIONES = '.advisors/pipeline-runs/9.9-20261125100000/approvals.jsonl';
const APROBACIONES_SUB = 'app/.advisors/pipeline-runs/9.9-20261125100000/approvals.jsonl';

// las líneas como las escriben los comandos de cada constancia
const exencion = (n = 1, campo = 'advisors_exempt') => ({ story: `9.${n}`, campo, archivo: `specs/story-9.${n}-algo.md`, via: 'ventana', sesion: SID, ts: FECHA });
const enVivo = (n = 1) => ({ ts: FECHA, story: `9.${n}`, acs: [3], matrixHash: hex(`matriz-${n}`), approvedBy: 'persona', chain: hex(`cadena-${n}`) });
const cambio = (n = 1) => ({ hash: hex(`cambio-${n}`), rules: [{ path: 'scripts/ci/x.js', blob: hex(`blob-${n}`).slice(0, 40) }], at: FECHA, by: 'persona' });
const manual = (que = 'plan', via = 'click') => ({ que, cuando: FECHA, commit: null, tipo: 'manual', quien: 'persona', via });
const automatica = () => ({ que: 'plan', cuando: FECHA, commit: null, tipo: 'automatica', quien: 'sin nombrar', via: 'complete-step approve-plan' });
const jsonl = (...ls) => ls.map((l) => `${typeof l === 'string' ? l : JSON.stringify(l)}\n`).join('');

// lo que devuelve `exigir` (owner-window.js) cuando la persona aprueba, simulado por vía; cada uno es otra aprobación
let aprobaciones = 0;
function registro(via) {
  aprobaciones += 1;
  const reg = via === 'ventana'
    ? { firma: 'x', sesion: SID, sha256: hex(`pedido-${aprobaciones}`), comando: 'c', ts: FECHA }
    : { aprobacion: hex(`aprobacion-${via}-${aprobaciones}`), aprobada_en: FECHA };
  return { codigo: 0, via, registro: reg };
}
/** La línea como la escribe el escritor con la aprobación de la persona: con su cuadro. */
const firmada = (linea, firma, via = 'click') => SRA.conCuadro(linea, SRA.aprobacionDe(registro(via), firma));

const ENV = () => ({ ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, GIT_CONFIG_NOSYSTEM: '1' });

/** Un repo con `base` commiteado; `commit(archivos)` agrega el pedido (`null` borra). */
function repo(t, base = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cuadro-ci-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const dir = path.join(raiz, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0', ...a], { cwd: dir, stdio: 'pipe', encoding: 'utf8', env: ENV() });
  const escribir = (archivos) => {
    for (const [rel, txt] of Object.entries(archivos)) {
      const f = path.join(dir, rel);
      if (txt === null) { fs.rmSync(f, { force: true }); continue; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, txt);
    }
  };
  git('init', '-q', '-b', 'main', '.');
  escribir({ 'README.md': 'x\n', ...base });
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const commit = (archivos, msg = 'pedido') => {
    if (archivos) escribir(archivos);
    git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD').trim();
  };
  return { raiz, dir, base: git('rev-parse', 'HEAD').trim(), git, escribir, commit };
}

/** El portón en el proceso, con el modo fijado como lo fijan las pruebas. */
function conModo(modo, fn) {
  const antes = SRA.MODO;
  SRA.MODO = modo;
  try { return fn(); } finally { SRA.MODO = antes; }
}
const porton = (modo, r, base = r.base) => conModo(modo, () => gate.revisar({ repo: r.dir, base, staged: false, hoy: '2026-11-25' }));
const esAviso = (m) => m === 'aviso';
const delCuadro = (lista) => (lista || []).filter((h) => h.regla === gate.REGLA_DEL_CUADRO);
const nivelDe = (res) => (res.verificacion || []).find((v) => v.chequeo === 'constancias-con-cuadro');

/** El portón por la consola: el modo lo fija un módulo que se carga antes, dentro del proceso del portón. */
function consola(r, modo, args, env = {}) {
  const antes = [];
  if (modo) {
    const fijar = path.join(r.raiz, `modo-${modo}.js`);
    fs.writeFileSync(fijar, `require(${JSON.stringify(LIB)}).MODO = ${JSON.stringify(modo)};\n`);
    antes.push('-r', fijar);
  }
  const p = spawnSync(process.execPath, [...antes, GATE, '--repo', r.dir, ...args], { encoding: 'utf8', env: { ...ENV(), ...env } });
  let j = null;
  try { j = JSON.parse(p.stdout); } catch (_) { j = null; }
  return { code: p.status, j, salida: `${p.stdout}${p.stderr}` };
}

test('T15 CI_LineaConCuadro_Pasa: una línea escrita con el registro de la aprobación pasa, en cada archivo del catálogo', (t) => {
  const r = repo(t);
  const h1 = hex('carpeta-1');
  const h2 = hex('carpeta-2');
  r.commit({
    [EXENCIONES]: jsonl(firmada(exencion(1), 'advisors_exempt', 'ventana'), firmada(exencion(2, 'dod_runtime_exempt'), 'dod_runtime_exempt', 'mensaje')),
    [EN_VIVO]: jsonl(firmada(enVivo(), 'runtime-waiver', 'terminal')),
    [CAMBIOS_TYCON]: jsonl(firmada(cambio(1), 'control-change', 'click')),
    [CAMBIOS_GITHUB]: jsonl(firmada(cambio(2), 'control-change', 'mensaje')),
    [`.tycon/control-changes/${h1}.json`]: `${JSON.stringify(firmada(cambio(3), 'control-change'), null, 2)}\n`,
    [`.github/control-changes/${h2}.json`]: `${JSON.stringify(firmada(cambio(4), 'control-change', 'ventana'), null, 2)}\n`,
    // la automática no lleva cuadro y no se mira; la manual sí, en la raíz y en una subcarpeta
    [APROBACIONES]: jsonl(automatica(), firmada(manual(), 'plan-approval')),
    [APROBACIONES_SUB]: jsonl(firmada(manual('AC 3 imposible de verificar en vivo', 'runtime-waiver (terminal)'), 'runtime-waiver', 'terminal')),
  });
  for (const modo of ['aviso', 'freno']) {
    const res = porton(modo, r);
    assert.deepStrictEqual(delCuadro(res.hallazgos), [], `${modo}: ${JSON.stringify(res.hallazgos)}`);
    assert.deepStrictEqual(delCuadro(res.avisos), [], `${modo}: ${JSON.stringify(res.avisos)}`);
    const n = nivelDe(res);
    assert.ok(n && n.nivel === gate.NIVELES.REGISTRO, JSON.stringify(res.verificacion));
    assert.match(n.detalle, new RegExp(`^9 constancias nuevas, en ${modo}$`));
  }
  const c = consola(r, 'freno', ['--base', r.base, '--json']);
  assert.strictEqual(c.code, 0, c.salida);
  assert.deepStrictEqual(delCuadro(c.j.hallazgos), []);
});

test('T16 CI_SinCuadro_AvisoYFreno: en aviso la lista y pasa; en freno frena', (t) => {
  const r = repo(t, { [EXENCIONES]: jsonl(exencion(1)) });
  r.commit({ [EXENCIONES]: jsonl(exencion(1), exencion(2)) });

  const aviso = porton('aviso', r);
  assert.deepStrictEqual(delCuadro(aviso.hallazgos), []);
  const [a] = delCuadro(aviso.avisos);
  assert.ok(a, JSON.stringify(aviso.avisos));
  assert.strictEqual(delCuadro(aviso.avisos).length, 1, 'la línea de la base no se mira');
  assert.strictEqual(a.archivo, EXENCIONES);
  assert.strictEqual(a.linea, 2);
  assert.match(a.mensaje, /la línea 2: no trae el cuadro del dueño/);
  assert.match(a.mensaje, /Hoy avisa/);

  const freno = porton('freno', r);
  assert.deepStrictEqual(delCuadro(freno.avisos), []);
  assert.strictEqual(delCuadro(freno.hallazgos).length, 1, JSON.stringify(freno.hallazgos));
  assert.doesNotMatch(delCuadro(freno.hallazgos)[0].mensaje, /Hoy avisa/);

  // por la consola: en aviso la lista en su propio bloque y sale 0; en freno sale distinto de 0
  const ca = consola(r, 'aviso', ['--base', r.base]);
  assert.strictEqual(ca.code, 0, ca.salida);
  assert.match(ca.salida, /AVISO — constancias nuevas que no corresponden a un cuadro del dueño/);
  assert.match(ca.salida, /\[constancia-sin-cuadro\] \.tycon\/exemptions\.jsonl: la línea 2/);
  const cf = consola(r, 'freno', ['--base', r.base, '--json']);
  assert.notStrictEqual(cf.code, 0, cf.salida);
  assert.deepStrictEqual(delCuadro(cf.j.hallazgos).map((h) => h.archivo), [EXENCIONES]);
  const ct = consola(r, 'freno', ['--base', r.base]);
  assert.strictEqual(ct.code, 1, ct.salida);
  assert.match(ct.salida, /❌ tycon-ci-gate — 1 problema\(s\)/);

  // el pre-commit del arnés corre el portón con --staged también cuando el commit sólo trae una constancia: así lo corre
  // la revisión de la base en la CI, con el pre-commit de la base
  const st = repo(t, { [EXENCIONES]: jsonl(exencion(1)) });
  st.escribir({ [EXENCIONES]: jsonl(exencion(1), exencion(2)) });
  st.git('add', '-A');
  const pa = preCommit(st, 'aviso');
  assert.strictEqual(pa.code, 0, pa.salida);
  assert.match(pa.salida, /\[constancia-sin-cuadro\] \.tycon\/exemptions\.jsonl: la línea 2/);
  const pf = preCommit(st, 'freno');
  assert.strictEqual(pf.code, 1, pf.salida);
  assert.match(pf.salida, /COMMIT RECHAZADO — el portón del arnés/);
  assert.match(pf.salida, /\[constancia-sin-cuadro\]/);
  // con la constancia en el índice con su cuadro, pasa; un commit sin constancias ni historias no llama al portón
  st.escribir({ [EXENCIONES]: jsonl(exencion(1), firmada(exencion(2), 'advisors_exempt')) });
  st.git('add', '-A');
  assert.strictEqual(preCommit(st, 'freno').code, 0);
  const otro = repo(t);
  otro.escribir({ 'notas.txt': 'y\n' });
  otro.git('add', '-A');
  const sinNada = preCommit(otro, 'freno');
  assert.strictEqual(sinNada.code, 0, sinNada.salida);
  assert.doesNotMatch(sinNada.salida, /tycon-ci-gate:|constancia-sin-cuadro/);
});

/** El pre-commit del arnés sobre un repo de juguete, sólo con el tramo del portón, y el modo fijado en el proceso de node. */
function preCommit(r, modo) {
  const fijar = path.join(r.raiz, `modo-${modo}.js`);
  fs.writeFileSync(fijar, `require(${JSON.stringify(LIB)}).MODO = ${JSON.stringify(modo)};\n`);
  const env = { ...ENV(), TYCON_CHECKS_ONLY: 'scripts/ci/tycon-ci-gate.js', TYCON_CHECKS_CODE_ROOT: RAIZ, NODE_OPTIONS: `--require ${fijar}` };
  const p = spawnSync('bash', [path.join(RAIZ, '.githooks', 'pre-commit-checks')], { cwd: r.dir, encoding: 'utf8', env });
  return { code: p.status, salida: `${p.stdout}${p.stderr}` };
}

test('T17 CI_FirmaQueNoCorresponde: una firma que no es la del archivo, o una vía que no es de una persona, no corresponde', (t) => {
  const ap = { aprobacion: hex('a17'), via: 'click', aprobada_en: FECHA };
  const otraFirma = SRA.conCuadro(exencion(1), { ...ap, firma: 'control-change' });
  const v1 = SRA.verificar({ ruta: EXENCIONES, texto: JSON.stringify(otraFirma) });
  assert.strictEqual(v1.ok, false);
  assert.match(v1.motivo, /la firma «control-change» no es la de este archivo/);
  // la exención de la prueba en vivo no vale con la firma de la de revisores
  const otraExencion = SRA.conCuadro(exencion(2, 'dod_runtime_exempt'), { ...ap, firma: 'advisors_exempt' });
  assert.strictEqual(SRA.verificar({ ruta: EXENCIONES, texto: JSON.stringify(otraExencion) }).ok, false);
  const delegada = SRA.conCuadro(cambio(1), { ...ap, firma: 'control-change', via: 'delegacion' });
  const v2 = SRA.verificar({ ruta: CAMBIOS_TYCON, texto: JSON.stringify(delegada) });
  assert.strictEqual(v2.ok, false);
  assert.match(v2.motivo, /no es una vía de una persona/);
  // con su firma y una vía de una persona, sí
  assert.deepStrictEqual(SRA.verificar({ ruta: EXENCIONES, texto: JSON.stringify(SRA.conCuadro(exencion(3), { ...ap, aprobacion: hex('a17b'), firma: 'advisors_exempt' })) }), { ok: true });

  // en el portón, las dos frenan
  const r = repo(t);
  r.commit({ [EXENCIONES]: jsonl(otraFirma), [CAMBIOS_TYCON]: jsonl(delegada) });
  const res = porton('freno', r);
  assert.deepStrictEqual(delCuadro(res.hallazgos).map((h) => h.archivo).sort(), [CAMBIOS_TYCON, EXENCIONES]);
});

/** El mismo objeto con las claves al revés, en todos los niveles. */
const alReves = (x) => (Array.isArray(x) ? x.map(alReves)
  : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).reverse().map((k) => [k, alReves(x[k])])) : x);

test('T18 CI_HuellaQueNoCalza: un cuadro copiado a otra línea o una línea cambiada no calzan; el .json reformateado sí', (t) => {
  const a = firmada(exencion(1), 'advisors_exempt');
  const copiado = { ...exencion(2), cuadro: a.cuadro };
  const vc = SRA.verificar({ ruta: EXENCIONES, texto: JSON.stringify(copiado) });
  assert.strictEqual(vc.ok, false);
  assert.match(vc.motivo, /la huella del cuadro no es la de esta línea/);
  const cambiada = { ...a, archivo: 'specs/story-otra.md' };
  assert.strictEqual(SRA.verificar({ ruta: EXENCIONES, texto: JSON.stringify(cambiada) }).ok, false);

  const obj = firmada(cambio(5), 'control-change');
  const reformateado = `${JSON.stringify(alReves(obj), null, 4).replace(/\n/g, '\r\n')}\r\n`;
  const carpeta = `.tycon/control-changes/${obj.hash}.json`;
  assert.deepStrictEqual(SRA.verificar({ ruta: carpeta, texto: reformateado }), { ok: true });

  // en el portón: las dos primeras frenan, el .json reformateado pasa
  const r = repo(t);
  r.commit({ [EXENCIONES]: jsonl(copiado, cambiada), [carpeta]: reformateado });
  const res = porton('freno', r);
  const dichos = delCuadro(res.hallazgos);
  assert.deepStrictEqual(dichos.map((h) => [h.archivo, h.linea]), [[EXENCIONES, 1], [EXENCIONES, 2]], JSON.stringify(dichos));
});

test('T19 CI_AprobacionRepetida: una aprobación del historial de la base, o con otra firma en el pedido, no corresponde', (t) => {
  // está en una línea de la base
  const vieja = firmada(exencion(1), 'advisors_exempt');
  const reusar = (linea, firma, de) => SRA.conCuadro(linea, { aprobacion: de.cuadro.aprobacion, firma, via: 'click', aprobada_en: de.cuadro.aprobada_en });
  const r1 = repo(t, { [EXENCIONES]: jsonl(vieja) });
  r1.commit({ [EXENCIONES]: jsonl(vieja, reusar(exencion(2), 'advisors_exempt', vieja)) });
  const d1 = delCuadro(porton('freno', r1).hallazgos);
  assert.deepStrictEqual(d1.map((h) => h.linea), [2], JSON.stringify(d1));
  assert.match(d1[0].mensaje, /esa aprobación ya se usó/);

  // estuvo en la base, en otro archivo del catálogo, y se sacó antes del pedido
  const sacada = firmada(enVivo(1), 'runtime-waiver', 'terminal');
  const r2 = repo(t, { [EN_VIVO]: jsonl(sacada) });
  const base2 = r2.commit({ [EN_VIVO]: '' }, 'saca la línea');
  r2.commit({ [EXENCIONES]: jsonl(reusar(exencion(3), 'advisors_exempt', sacada)) });
  const d2 = delCuadro(porton('freno', r2, base2).hallazgos);
  assert.deepStrictEqual(d2.map((h) => h.archivo), [EXENCIONES], JSON.stringify(d2));
  assert.match(d2[0].mensaje, /esa aprobación ya se usó/);

  // la misma aprobación en dos líneas del pedido con otra firma
  const r3 = repo(t);
  const comun = { aprobacion: hex('a19-3'), via: 'click', aprobada_en: FECHA };
  r3.commit({
    [EXENCIONES]: jsonl(SRA.conCuadro(exencion(4), { ...comun, firma: 'advisors_exempt' })),
    [EN_VIVO]: jsonl(SRA.conCuadro(enVivo(4), { ...comun, firma: 'runtime-waiver' })),
  });
  const d3 = delCuadro(porton('freno', r3).hallazgos);
  assert.deepStrictEqual(d3.map((h) => h.archivo).sort(), [EN_VIVO, EXENCIONES].sort());
  assert.ok(d3.every((h) => /la misma aprobación aparece en otra firma del pedido/.test(h.mensaje)));

  // la exención en vivo y sus tres líneas manuales comparten la aprobación: corresponden
  const r4 = repo(t);
  const enVivoAp = SRA.aprobacionDe(registro('terminal'), 'runtime-waiver');
  const manuales = [1, 2, 3].map((n) => SRA.conCuadro(manual(`AC ${n} imposible de verificar en vivo`, 'runtime-waiver (terminal)'), enVivoAp));
  r4.commit({ [EN_VIVO]: jsonl(SRA.conCuadro(enVivo(5), enVivoAp)), [APROBACIONES]: jsonl(automatica(), ...manuales) });
  const res4 = porton('freno', r4);
  assert.deepStrictEqual(delCuadro(res4.hallazgos), [], JSON.stringify(res4.hallazgos));
  assert.match(nivelDe(res4).detalle, /^4 constancias nuevas/);

  // mover con git una constancia vieja de una carpeta no es nueva; un archivo agregado distinto sí
  const viejo = cambio(6);
  const r5 = repo(t, { [`.tycon/control-changes/${viejo.hash}.json`]: `${JSON.stringify(viejo)}\n` });
  fs.mkdirSync(path.join(r5.dir, '.github', 'control-changes'), { recursive: true });
  r5.git('mv', `.tycon/control-changes/${viejo.hash}.json`, `.github/control-changes/${viejo.hash}.json`);
  r5.commit();
  assert.deepStrictEqual(delCuadro(porton('freno', r5).hallazgos), []);
  assert.strictEqual(nivelDe(porton('freno', r5)), undefined, 'el movimiento no es una constancia nueva');
  r5.commit({ [`.github/control-changes/${hex('otro')}.json`]: `${JSON.stringify(cambio(7))}\n` });
  assert.strictEqual(delCuadro(porton('freno', r5, r5.base).hallazgos).length, 1);

  // el historial se busca en cada archivo del catálogo, sin distinguir mayúsculas, y en ninguno más
  const r6 = repo(t);
  const rutas = [
    `.tycon/control-changes/${hex('x')}.json`, `.GITHUB/Control-Changes/${hex('y')}.JSON`, '.github/control-changes.jsonl',
    '.Tycon/control-changes.jsonl', '.tycon/EXEMPTIONS.jsonl', '.tycon/runtime-waivers.jsonl',
    '.advisors/pipeline-runs/r1/approvals.jsonl', 'app/sub/.advisors/pipeline-runs/r2/approvals.jsonl',
    // fuera del catálogo
    'tasks/pending-approvals.jsonl', 'tasks/pending-approvals/p1.json', 'docs/exemptions.jsonl', '.tycon/control-changes/sub/z.json',
    '.advisors/pipeline-runs/r1/sub/approvals.jsonl', '.tycon/exemptions.jsonl.bak', '.advisors/dod-runtime/approvals.jsonl',
  ];
  // en el índice y no en el disco, sin plegar mayúsculas: así da igual el sistema de archivos
  const indice = (...a) => execFileSync('git', ['-c', 'core.ignorecase=false', ...a], { cwd: r6.dir, encoding: 'utf8', input: '{}\n', env: ENV() });
  const blob = indice('hash-object', '-w', '--stdin').trim();
  for (const p of rutas) indice('update-index', '--add', '--cacheinfo', `100644,${blob},${p}`);
  const halladas = indice('ls-files', '--', ...gate.RUTAS_DEL_CATALOGO).split('\n').filter(Boolean).sort();
  assert.deepStrictEqual(halladas, rutas.filter((p) => SRA.entradaDe(p)).sort());
});

test('T20 CI_LineaQueNoEsJson: una línea que no es JSON no corresponde, y se nombra', (t) => {
  const v = SRA.verificar({ ruta: EXENCIONES, texto: '{roto' });
  assert.strictEqual(v.ok, false);
  assert.match(v.motivo, /no es JSON/);
  const r = repo(t, { [EXENCIONES]: jsonl(exencion(1)) });
  r.commit({ [EXENCIONES]: jsonl(exencion(1), '{roto') });
  const [h] = delCuadro(porton('freno', r).hallazgos);
  assert.ok(h);
  assert.strictEqual(h.linea, 2);
  assert.match(h.mensaje, /la línea 2 \("\{roto"\): no es JSON/);
});

test('T22 CI_BaseIlegibleOSuperficial: sin la base, o con el historial cortado, lo dice', (t) => {
  const NADA = '0'.repeat(40);
  const con = repo(t, { [EXENCIONES]: jsonl(exencion(1)) });
  con.commit({ 'README.md': 'y\n' });
  const sin = repo(t);
  sin.commit({ 'README.md': 'y\n' });
  for (const modo of ['aviso', 'freno']) {
    const a = porton(modo, con, NADA);
    assert.ok(a.error, 'el portón ya no revisa nada sin la base');
    const dichos = delCuadro(esAviso(modo) ? a.avisos : a.hallazgos);
    assert.strictEqual(dichos.length, 1, `${modo}: ${JSON.stringify(a)}`);
    assert.match(dichos[0].mensaje, /^no se pudo leer la base: las constancias no se miraron/);
    assert.deepStrictEqual(delCuadro(esAviso(modo) ? a.hallazgos : a.avisos), []);
    const b = porton(modo, sin, NADA);
    assert.deepStrictEqual([...delCuadro(b.hallazgos), ...delCuadro(b.avisos)], [], `${modo} sin archivos del catálogo`);
  }
  const cli = consola(con, 'freno', ['--base', NADA]);
  assert.strictEqual(cli.code, 1);
  assert.match(cli.salida, /\[constancia-sin-cuadro\] \.tycon\/exemptions\.jsonl: no se pudo leer la base/);

  // un clon superficial: lo dice sólo si el pedido trae líneas nuevas del catálogo
  const clonar = (r) => {
    const clon = path.join(r.raiz, 'clon');
    execFileSync('git', ['clone', '-q', '--depth', '2', pathToFileURL(r.dir).href, clon], { stdio: 'pipe', env: ENV() });
    assert.strictEqual(execFileSync('git', ['-C', clon, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8', env: ENV() }).trim(), 'true');
    return { ...r, dir: clon };
  };
  const conLinea = repo(t, { [EXENCIONES]: jsonl(exencion(1)) });
  const base = conLinea.commit({ 'README.md': 'y\n' }, 'medio');
  conLinea.commit({ [EXENCIONES]: jsonl(exencion(1), firmada(exencion(2), 'advisors_exempt')) });
  const sinLinea = repo(t, { [EXENCIONES]: jsonl(exencion(1)) });
  const base2 = sinLinea.commit({ 'README.md': 'y\n' }, 'medio');
  sinLinea.commit({ 'README.md': 'z\n' });
  for (const modo of ['aviso', 'freno']) {
    const s = porton(modo, clonar(conLinea), base);
    const dichos = delCuadro(esAviso(modo) ? s.avisos : s.hallazgos);
    assert.strictEqual(dichos.length, 1, `${modo}: ${JSON.stringify(s)}`);
    assert.match(dichos[0].mensaje, /^no se pudo leer la base: las constancias no se miraron: el clon es superficial/);
    assert.strictEqual(nivelDe(s).nivel, gate.NIVELES.NO_MEDIDO);
    fs.rmSync(path.join(conLinea.raiz, 'clon'), { recursive: true, force: true });
    const n = porton(modo, clonar(sinLinea), base2);
    assert.deepStrictEqual([...delCuadro(n.hallazgos), ...delCuadro(n.avisos)], [], `${modo} sin líneas nuevas`);
    fs.rmSync(path.join(sinLinea.raiz, 'clon'), { recursive: true, force: true });
  }
});

test('T23 CI_ComoHoy: las líneas de la base no se miran ni se reescriben; sin archivos del catálogo, lo de siempre', (t) => {
  const viejas = jsonl(exencion(1), exencion(2));
  const carpeta = `.tycon/control-changes/${hex('vieja')}.json`;
  const base = { [EXENCIONES]: viejas, [CAMBIOS_TYCON]: jsonl(cambio(1)), [carpeta]: `${JSON.stringify(cambio(9))}\n`, [APROBACIONES]: jsonl(manual()) };
  const r = repo(t, base);
  r.commit({ 'README.md': 'y\n' });
  const sinCatalogo = repo(t);
  sinCatalogo.commit({ 'README.md': 'y\n' });
  const sinRepo = (j) => { const { repo: _r, base: _b, ...resto } = j; return resto; };
  for (const modo of ['aviso', 'freno']) {
    const res = porton(modo, r);
    assert.deepStrictEqual([...delCuadro(res.hallazgos), ...delCuadro(res.avisos)], []);
    assert.strictEqual(nivelDe(res), undefined, 'un pedido que no trae constancias no suma nada');
    // la salida es la misma que en un repo sin archivos del catálogo
    const j1 = consola(r, modo, ['--base', r.base, '--json']);
    const j2 = consola(sinCatalogo, modo, ['--base', sinCatalogo.base, '--json']);
    assert.strictEqual(j1.code, 0, j1.salida);
    assert.deepStrictEqual(sinRepo(j1.j), sinRepo(j2.j));
    assert.deepStrictEqual(Object.keys(j2.j).sort(), ['aprobaciones', 'archivos', 'avisos', 'base', 'exenciones', 'hallazgos', 'repo', 'revisadas', 'staged', 'verificacion']);
    // antes del pedido (la base contra sí misma), tampoco
    const antes = consola(r, modo, ['--base', 'HEAD', '--json']);
    assert.strictEqual(antes.code, 0, antes.salida);
    assert.deepStrictEqual(delCuadro(antes.j.avisos), []);
  }
  // un pedido que suma una línea con su cuadro después de las viejas: sólo se mira la nueva
  r.commit({ [EXENCIONES]: viejas + jsonl(firmada(exencion(3), 'advisors_exempt')) });
  const res = porton('freno', r);
  assert.deepStrictEqual(delCuadro(res.hallazgos), []);
  assert.match(nivelDe(res).detalle, /^1 constancia nueva/);
  // el portón no escribe: ninguna línea vieja cambia
  for (const [rel, txt] of Object.entries(base)) assert.strictEqual(rel === EXENCIONES ? fs.readFileSync(path.join(r.dir, rel), 'utf8').slice(0, viejas.length) : fs.readFileSync(path.join(r.dir, rel), 'utf8'), txt, rel);
  assert.strictEqual(r.git('status', '--porcelain'), '');
});

test('T24 Modo_FijoEnElCodigo: un valor desconocido frena; ninguna variable ni opción lo cambia', (t) => {
  for (const v of ['bloquear', '', undefined, null, 'AVISO', 'freno']) assert.strictEqual(conModo(v, () => SRA.modo()), 'freno', String(v));
  assert.strictEqual(conModo('aviso', () => SRA.modo()), 'aviso');

  const r = repo(t, { [EXENCIONES]: jsonl(exencion(1)) });
  r.commit({ [EXENCIONES]: jsonl(exencion(1), exencion(2)) });
  assert.strictEqual(delCuadro(porton('bloquear', r).hallazgos).length, 1, 'un valor desconocido cuenta como freno');

  // una variable de ambiente y una opción con el nombre del modo no cambian nada, para ningún lado
  const variables = (m) => ({ MODO: m, MODE: m, TYCON_MODE: m, SIGNED_RECORD_MODE: m, TYCON_SIGNED_RECORD_MODE: m });
  const opciones = (m) => ['--mode', m, `--signed-record-mode=${m}`];
  assert.strictEqual(consola(r, 'freno', ['--base', r.base, ...opciones('aviso')], variables('aviso')).code, 1);
  assert.strictEqual(consola(r, 'aviso', ['--base', r.base, ...opciones('freno')], variables('freno')).code, 0);
  // sin fijarlo, rige el de fábrica, diga lo que diga el ambiente
  const deFabrica = consola(r, null, ['--base', r.base, ...opciones(esAviso(MODO_DE_FABRICA) ? 'freno' : 'aviso')], variables(esAviso(MODO_DE_FABRICA) ? 'freno' : 'aviso'));
  assert.strictEqual(deFabrica.code, esAviso(MODO_DE_FABRICA) ? 0 : 1, deFabrica.salida);

  // la biblioteca no lee el modo de una variable, una opción ni un archivo
  const texto = fs.readFileSync(LIB, 'utf8');
  assert.doesNotMatch(texto, /process\.env/);
  assert.doesNotMatch(texto, /\bargv\b/);
  assert.doesNotMatch(texto, /require\(\s*['"](?:node:)?fs['"]\s*\)/);
  // el modo cambia con un commit y su constancia: la revisión pide la firma del dueño en cada cambio de la biblioteca
  const inventario = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'ci', 'controls-from-base.json'), 'utf8'));
  const reglas = inventario.controls.find((c) => c.name === 'base-controls').rules;
  assert.ok(reglas.some((x) => x && x.path === 'scripts/lib/signed-record-approval.js' && x.sign_on_change === true));
});

test('T25 Guias_DicenLaRegla: las dos guías nombran el cuadro, la regla, los modos, qué se mira y lo que no protege', () => {
  const pide = ['cuadro', 'constancia-sin-cuadro', '`aviso`', '`freno`', 'MODO', 'Lo que no protege',
    '.tycon/exemptions.jsonl', '.tycon/runtime-waivers.jsonl', 'approvals.jsonl', 'control-changes', 'tasks/pending-approvals',
    'delegación', 'refresh-after-main', 'huella', 'aprobada_en'];
  for (const guia of ['guides/owner-signatures.md', 'guides/ci-gate.md']) {
    const texto = fs.readFileSync(path.join(RAIZ, guia), 'utf8');
    for (const s of pide) assert.ok(texto.includes(s), `${guia} no nombra ${s}`);
  }
});
