'use strict';
/**
 * El portón de CI ata la evidencia de cierre al cambio: una evidencia anterior al código que el pedido cambia no vale, y
 * el registro de humos tiene que coincidir con las salidas y capturas que anota.
 *
 * Lo nuevo entra avisando: hasta EVIDENCE_BOUND_FROM avisa y deja pasar; desde ese día frena. Las fechas se comparan con
 * el `hoy` que recibe `revisar`, así que las pruebas no dependen del día en que corren. Repos de juguete en una carpeta
 * temporal, HOME vacía, sin red.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GATE = path.join(ROOT, 'scripts', 'ci', 'tycon-ci-gate.js');
const gate = require(GATE);

const unDiaAntes = (dia) => { const d = new Date(`${dia}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const DESDE = gate.EVIDENCE_BOUND_FROM;
const ANTES = DESDE ? unDiaAntes(DESDE) : '2000-01-01';
const NO_PRUEBA = 'detecta una edición posterior o una evidencia anterior al código; no prueba que la evidencia sea verdadera';
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

function carpetaTemporal(t, prefijo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Un repo con la historia 1.1 en `in-progress`, su código y una evidencia de cierre, todo en el primer commit.
 * `declarados`: lo que la historia declara en `files_to_modify`. `extra`: más archivos para el primer commit.
 */
function repoDeJuguete(t, { declarados = ['src/feature.js'], extra = {} } = {}) {
  const dir = carpetaTemporal(t, 'cigate-atada-');
  const correr = (args, f = '2026-11-10') => execFileSync('git', ['-C', dir, '-c', 'user.email=b@b', '-c', 'user.name=b', '-c', 'maintenance.auto=false', ...args], {
    stdio: 'pipe', encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: `${f}T12:00:00Z`, GIT_COMMITTER_DATE: `${f}T12:00:00Z` },
  });
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), txt); };
  const story = (estado) => escribir('specs/1-1.md', `---\nstory: "1.1"\nepic: "1"\nstatus: ${estado}\n${declarados.length ? `files_to_modify:\n${declarados.map((d) => `  - ${d}`).join('\n')}\n` : ''}---\n# Story 1.1\n`);
  story('in-progress');
  escribir('src/feature.js', 'module.exports = 1;\n');
  escribir('.advisors/dod-runtime/1.1-20261110.md', 'verdict=PASS\n');
  for (const [rel, txt] of Object.entries(extra)) escribir(rel, txt);
  correr(['init', '-q', '-b', 'main', '.']);
  correr(['add', '-A']); correr(['commit', '-q', '-m', 'base']);
  const r = { dir, escribir, story };
  r.commit = (f) => { correr(['add', '-A']); correr(['commit', '-q', '-m', 'x'], f); };
  r.base = correr(['rev-parse', 'HEAD']).trim();
  return r;
}

const reglas = (lista) => (lista || []).map((h) => h.regla);
const de = (lista, regla) => (lista || []).filter((h) => h.regla === regla);
const chequeo = (res, nombre) => res.verificacion.filter((v) => v.chequeo === nombre);
const revisar = (r, hoy, opts = {}) => gate.revisar({ repo: r.dir, base: r.base, staged: false, hoy, ...opts });

/** El pedido cambia el código declarado y pasa la historia a `review`; la única evidencia es la del primer commit. */
function conCodigoCambiado(t, opciones) {
  const r = repoDeJuguete(t, opciones);
  r.escribir('src/feature.js', 'module.exports = 2;\n');
  r.story('review');
  r.commit('2026-11-11');
  return r;
}

/** Una línea `v:2` del registro de humos con su salida y su captura, y los dos archivos que anota. */
function registroConHuellas() {
  const salida = 'todo bien\n';
  const imagen = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  const linea = { v: 2, ts: '2026-11-10T11:00:00Z', exit: 0, acs: [1], output: '1.1-smoke-outputs/a.txt', output_sha: sha(salida), capture: '1.1-smoke-captures/c.png', capture_sha: sha(imagen) };
  return { linea, salida, imagen };
}

test('T19 OldEvidence_NoticeThenBlocks — la única evidencia es anterior al código que cambia el pedido: avisa y desde la fecha frena @story-8.259 @ac-13', (t) => {
  assert.match(String(DESDE), /^\d{4}-\d{2}-\d{2}$/, 'el portón exporta EVIDENCE_BOUND_FROM');
  const r = conCodigoCambiado(t);
  const antes = revisar(r, ANTES);
  assert.deepStrictEqual(de(antes.hallazgos, 'evidencia-vieja'), [], JSON.stringify(antes.hallazgos));
  const aviso = de(antes.avisos, 'evidencia-vieja');
  assert.strictEqual(aviso.length, 1, JSON.stringify(antes.avisos));
  assert.match(aviso[0].mensaje, /src\/feature\.js/);
  assert.ok(aviso[0].mensaje.includes(NO_PRUEBA), aviso[0].mensaje);
  assert.match(aviso[0].mensaje, new RegExp(`Avisa hasta el ${DESDE}`));
  const desde = revisar(r, DESDE);
  assert.deepStrictEqual(reglas(desde.hallazgos), ['evidencia-vieja'], JSON.stringify(desde.hallazgos));
  assert.deepStrictEqual(chequeo(desde, 'evidencia-atada').map((v) => v.nivel), ['verificado-por-el-servidor']);

  // una evidencia posterior al código que declara FAIL, o una línea del registro que no salió 0, no la ata: la vieja no
  // pasa por eso
  for (const [rel, txt] of [['.advisors/dod-runtime/1.1-20261112.md', 'verdict=FAIL\n'], ['.advisors/dod-runtime/1.1-smoke-ledger.jsonl', `${JSON.stringify({ ts: '2026-11-12T10:00:00Z', exit: 1, acs: [1] })}\n`]]) {
    const f = conCodigoCambiado(t);
    f.escribir(rel, txt);
    f.commit('2026-11-12');
    assert.deepStrictEqual(de(revisar(f, DESDE).hallazgos, 'evidencia-vieja').length, 1, `${rel}: una evidencia que falla no ata`);
  }
});

test('T20 NewSmokeAfterCode_Passes — una evidencia commiteada después del código vale @story-8.259 @ac-13', (t) => {
  const r = conCodigoCambiado(t);
  r.escribir('.advisors/dod-runtime/1.1-20261112.md', 'verdict=PASS\n');
  r.commit('2026-11-12');
  const res = revisar(r, DESDE);
  assert.deepStrictEqual([...de(res.hallazgos, 'evidencia-vieja'), ...de(res.avisos, 'evidencia-vieja')], [], JSON.stringify(res));
  assert.deepStrictEqual(res.hallazgos, [], JSON.stringify(res.hallazgos));
  assert.deepStrictEqual(chequeo(res, 'evidencia-atada').map((v) => v.nivel), ['verificado-por-el-servidor']);
  // también una línea del registro de humos escrita después del código
  const h = conCodigoCambiado(t);
  h.escribir('.advisors/dod-runtime/1.1-smoke-ledger.jsonl', `${JSON.stringify({ ts: '2026-11-12T10:00:00Z', exit: 0, acs: [1] })}\n`);
  h.commit('2026-11-12');
  const conHumo = revisar(h, DESDE);
  assert.deepStrictEqual(de(conHumo.hallazgos, 'evidencia-vieja'), [], JSON.stringify(conHumo.hallazgos));

  // la evidencia reescrita con el mismo nombre después del código: vale por su última versión, no por la primera
  const re = conCodigoCambiado(t);
  re.escribir('.advisors/dod-runtime/1.1-20261110.md', 'verdict=PASS\notra corrida\n');
  re.commit('2026-11-12');
  assert.deepStrictEqual(de(revisar(re, DESDE).hallazgos, 'evidencia-vieja'), [], 'la evidencia reescrita vale');

  // en el servidor HEAD es la fusión del pedido con la rama destino: lo que la rama destino cambió en el archivo
  // declarado no es del pedido y no vence su evidencia
  const f = repoDeJuguete(t);
  const g = (...a) => execFileSync('git', ['-C', f.dir, '-c', 'user.email=b@b', '-c', 'user.name=b', ...a], { stdio: 'pipe', encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-13T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-13T12:00:00Z' } });
  f.escribir('src/feature.js', 'module.exports = 1;\n\n\n\n\n\nmodule.exports.b = 1;\n');
  f.commit('2026-11-10');
  const base0 = g('rev-parse', 'HEAD').trim();
  g('switch', '-q', '-c', 'pedido');
  f.escribir('src/feature.js', 'module.exports = 2;\n\n\n\n\n\nmodule.exports.b = 1;\n');
  f.commit('2026-11-11');
  f.escribir('.advisors/dod-runtime/1.1-20261112.md', 'verdict=PASS\n');
  f.story('review');
  f.commit('2026-11-12');
  g('switch', '-q', 'main');
  f.escribir('src/feature.js', 'module.exports = 1;\n\n\n\n\n\nmodule.exports.b = 2;\n');
  f.commit('2026-11-12');
  const destino = g('rev-parse', 'HEAD').trim();
  g('switch', '-q', '--detach', destino);
  g('merge', '-q', '--no-ff', '-m', 'Merge del pedido', 'pedido');
  assert.notStrictEqual(base0, destino);
  const fusion = gate.revisar({ repo: f.dir, base: destino, staged: false, hoy: DESDE });
  assert.deepStrictEqual(de(fusion.hallazgos, 'evidencia-vieja'), [], JSON.stringify(fusion.hallazgos));
  assert.deepStrictEqual(chequeo(fusion, 'evidencia-atada').map((v) => v.nivel), ['verificado-por-el-servidor'], JSON.stringify(fusion.verificacion));
});

test('T21 CodeInOtherRepo_OnlyNotice — el código declarado no está en este repo: sólo avisa que no es verificable desde acá @story-8.259 @ac-13', (t) => {
  const r = repoDeJuguete(t, { declarados: ['servicio/Servicio.cs'] });
  r.story('review');
  r.commit('2026-11-11');
  const res = revisar(r, DESDE);
  assert.deepStrictEqual(res.hallazgos, [], JSON.stringify(res.hallazgos));
  const aviso = de(res.avisos, 'evidencia-atada-otro-repo');
  assert.strictEqual(aviso.length, 1, JSON.stringify(res.avisos));
  assert.match(aviso[0].mensaje, /no verificable desde este repo/);
  assert.deepStrictEqual(de(res.avisos, 'evidencia-vieja'), []);
  assert.deepStrictEqual(chequeo(res, 'evidencia-atada').map((v) => v.nivel), ['no-medido']);

  // una ruta de este repo escrita con `./`, con barra invertida o con otra caja es de este repo, no de otro
  for (const ruta of ['./src/feature.js', 'src\\feature.js', 'SRC/Feature.js']) {
    const e = conCodigoCambiado(t, { declarados: [ruta] });
    const r2 = revisar(e, DESDE);
    assert.deepStrictEqual(de(r2.avisos, 'evidencia-atada-otro-repo'), [], `${ruta}: ${JSON.stringify(r2.avisos)}`);
    assert.deepStrictEqual(reglas(r2.hallazgos), ['evidencia-vieja'], `${ruta}: ${JSON.stringify(r2.hallazgos)}`);
  }
});

test('T22 LedgerOutputEdited_NoticeThenBlocks — una salida editada después del humo y una captura borrada: avisa y desde la fecha frena @story-8.259 @ac-14 @ac-15', (t) => {
  const { linea, salida, imagen } = registroConHuellas();
  const r = repoDeJuguete(t, {
    declarados: [],
    extra: {
      '.advisors/dod-runtime/1.1-smoke-ledger.jsonl': `${JSON.stringify(linea)}\n`,
      '.advisors/dod-runtime/1.1-smoke-outputs/a.txt': salida,
      '.advisors/dod-runtime/1.1-smoke-captures/c.png': imagen,
    },
  });
  r.escribir('.advisors/dod-runtime/1.1-smoke-outputs/a.txt', 'todo bien, editado\n');
  fs.rmSync(path.join(r.dir, '.advisors/dod-runtime/1.1-smoke-captures/c.png'));
  r.story('review');
  r.commit('2026-11-11');
  const antes = revisar(r, ANTES);
  assert.deepStrictEqual(de(antes.hallazgos, 'registro-de-humo-inconsistente'), [], JSON.stringify(antes.hallazgos));
  const aviso = de(antes.avisos, 'registro-de-humo-inconsistente');
  assert.strictEqual(aviso.length, 1, JSON.stringify(antes.avisos));
  assert.match(aviso[0].mensaje, /1\.1-smoke-outputs\/a\.txt/);
  assert.match(aviso[0].mensaje, /1\.1-smoke-captures\/c\.png/);
  assert.ok(aviso[0].mensaje.includes(NO_PRUEBA), aviso[0].mensaje);
  const desde = revisar(r, DESDE);
  assert.deepStrictEqual(reglas(desde.hallazgos), ['registro-de-humo-inconsistente'], JSON.stringify(desde.hallazgos));
});

test('T23 LedgerIntact_Passes_V1Skipped — el registro sin tocar pasa; la línea sin v:2 se saltea y se dice @story-8.259 @ac-14', (t) => {
  const { linea, salida, imagen } = registroConHuellas();
  const vieja = { ts: '2026-11-09T10:00:00Z', exit: 0, acs: [1] };
  // con los fines de línea de Windows en la salida, como los deja un checkout con autocrlf: la huella es la del texto con \n
  const r = repoDeJuguete(t, {
    declarados: [],
    extra: {
      '.advisors/dod-runtime/1.1-smoke-ledger.jsonl': `${JSON.stringify(linea)}\n${JSON.stringify(vieja)}\n`,
      '.advisors/dod-runtime/1.1-smoke-outputs/a.txt': salida.replace(/\n/g, '\r\n'),
      '.advisors/dod-runtime/1.1-smoke-captures/c.png': imagen,
    },
  });
  r.story('review');
  r.commit('2026-11-11');
  const res = revisar(r, DESDE);
  assert.deepStrictEqual(res.hallazgos, [], JSON.stringify(res.hallazgos));
  assert.deepStrictEqual(de(res.avisos, 'registro-de-humo-inconsistente'), []);
  assert.deepStrictEqual(chequeo(res, 'huellas-del-registro').map((v) => v.nivel), ['verificado-por-el-servidor']);
  const salteada = chequeo(res, 'huellas-del-registro-sin-v2');
  assert.deepStrictEqual(salteada.map((v) => [v.nivel, v.detalle]), [['no-medido', '1 línea sin v:2 salteada']]);

  // un registro sin ninguna línea v:2: el chequeo entero no se midió
  const s = repoDeJuguete(t, { declarados: [], extra: { '.advisors/dod-runtime/1.1-smoke-ledger.jsonl': `${JSON.stringify(vieja)}\n` } });
  s.story('review');
  s.commit('2026-11-11');
  const sinV2 = revisar(s, DESDE);
  assert.deepStrictEqual(chequeo(sinV2, 'huellas-del-registro').map((v) => v.nivel), ['no-medido']);
  assert.ok(!sinV2.verificacion.some((v) => /^huellas/.test(v.chequeo) && v.nivel === 'verificado-por-el-servidor'), JSON.stringify(sinV2.verificacion));
});

test('T24 GitNoAnswer_NotGreen — sin git que conteste, el juez no da la evidencia por buena: no pude comparar @story-8.259 @ac-16', (t) => {
  const r = conCodigoCambiado(t);
  const sinGit = () => ({ codigo: null, salida: '' });
  const antes = revisar(r, ANTES, { juezGit: sinGit });
  const aviso = de(antes.avisos, 'evidencia-no-comparada');
  assert.strictEqual(aviso.length, 1, JSON.stringify(antes.avisos));
  assert.match(aviso[0].mensaje, /no pude comparar/);
  assert.deepStrictEqual(de(antes.hallazgos, 'evidencia-no-comparada'), []);
  assert.deepStrictEqual(de(antes.avisos, 'evidencia-vieja'), [], 'sin respuesta no es «vieja»');
  const desde = revisar(r, DESDE, { juezGit: sinGit });
  assert.deepStrictEqual(reglas(desde.hallazgos), ['evidencia-no-comparada'], JSON.stringify(desde.hallazgos));
  assert.deepStrictEqual(chequeo(desde, 'evidencia-atada').map((v) => v.nivel), ['no-medido']);
});

test('T27 JudgeLibMissing_NotGreen — sin la regla del juez: no pude comparar, por la fecha; las huellas corren igual @story-8.259 @ac-21', (t) => {
  const { linea, salida, imagen } = registroConHuellas();
  const r = repoDeJuguete(t, {
    extra: {
      '.advisors/dod-runtime/1.1-smoke-ledger.jsonl': `${JSON.stringify(linea)}\n`,
      '.advisors/dod-runtime/1.1-smoke-outputs/a.txt': salida,
      '.advisors/dod-runtime/1.1-smoke-captures/c.png': imagen,
    },
  });
  r.escribir('src/feature.js', 'module.exports = 2;\n');
  r.story('review');
  r.commit('2026-11-11');
  const home = carpetaTemporal(t, 'cigate-atada-home-');
  const sinSkills = carpetaTemporal(t, 'cigate-atada-sin-skills-');
  const enProceso = (hoy) => {
    const p = spawnSync(process.execPath, ['-e', `
      const r = require(process.argv[1]).revisar({ repo: process.argv[2], base: process.argv[3], hoy: process.argv[4] });
      console.log(JSON.stringify({ hallazgos: r.hallazgos, avisos: r.avisos, verificacion: r.verificacion }));`, GATE, r.dir, r.base, hoy],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_SKILLS_DIR: sinSkills } });
    assert.strictEqual(p.status, 0, p.stderr);
    return JSON.parse(p.stdout.trim().split('\n').pop());
  };
  const antes = enProceso(ANTES);
  const aviso = de(antes.avisos, 'evidencia-no-comparada');
  assert.strictEqual(aviso.length, 1, JSON.stringify(antes.avisos));
  assert.match(aviso[0].mensaje, /no pude comparar: no cargó la regla \(.+\)/);
  assert.deepStrictEqual(antes.hallazgos, [], JSON.stringify(antes.hallazgos));
  assert.deepStrictEqual(chequeo(antes, 'evidencia-atada').map((v) => v.nivel), ['no-medido']);
  assert.deepStrictEqual(chequeo(antes, 'huellas-del-registro').map((v) => v.nivel), ['verificado-por-el-servidor'], 'las huellas no dependen de la regla');
  const desde = enProceso(DESDE);
  assert.deepStrictEqual(reglas(desde.hallazgos), ['evidencia-no-comparada'], JSON.stringify(desde.hallazgos));
});

test('T31 SkippedChecks_NotMeasured — sin archivos declarados, con el código en otro repo o antes del commit: no medido @story-8.259 @ac-1 @ac-13 @ac-14', (t) => {
  for (const [caso, declarados] of [['sin archivos declarados', []], ['código en otro repo', ['servicio/Servicio.cs']]]) {
    const r = repoDeJuguete(t, { declarados });
    r.story('done');
    r.commit('2026-11-11');
    const res = revisar(r, DESDE);
    assert.deepStrictEqual(chequeo(res, 'evidencia-atada').map((v) => v.nivel), ['no-medido'], `${caso}: ${JSON.stringify(res.verificacion)}`);
    const salida = spawnSync(process.execPath, [GATE, '--repo', r.dir, '--base', r.base, '--json'], { encoding: 'utf8' });
    const json = JSON.parse(salida.stdout);
    assert.ok(json.verificacion.some((v) => v.chequeo === 'evidencia-atada' && v.nivel === 'no-medido'), `${caso}: --json trae el chequeo`);
    assert.ok(!json.verificacion.some((v) => v.chequeo === 'evidencia-atada' && v.nivel === 'verificado-por-el-servidor'), caso);
  }
  // antes del commit (`--staged`) no se mide: lo mide la matriz del freno del commit
  const s = repoDeJuguete(t);
  s.escribir('src/feature.js', 'module.exports = 2;\n');
  s.story('review');
  execFileSync('git', ['-C', s.dir, 'add', '-A']);
  const staged = gate.revisar({ repo: s.dir, staged: true, hoy: DESDE });
  assert.deepStrictEqual(chequeo(staged, 'evidencia-atada').map((v) => v.nivel), ['no-medido'], JSON.stringify(staged.verificacion));
  assert.deepStrictEqual([...de(staged.hallazgos, 'evidencia-vieja'), ...de(staged.avisos, 'evidencia-vieja')], []);
});
