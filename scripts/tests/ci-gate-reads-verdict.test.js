'use strict';
/**
 * El portón de CI frena lo que el freno local ya frena: la evidencia que declara FAIL, la evidencia que está en el disco
 * y no en git, y la carpeta de corrida que por su fecha en git pide registro de autoría.
 *
 * Lo nuevo entra avisando: hasta STRICT_EVIDENCE_FROM avisa y deja pasar; desde ese día frena. Lo que ya frenaba sigue
 * frenando desde el primer día. Las fechas se comparan con el `hoy` que recibe `revisar`, así que las pruebas no dependen
 * del día en que corren. Repos de juguete en una carpeta temporal, HOME vacía, sin red.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GATE = path.join(ROOT, 'scripts', 'ci', 'tycon-ci-gate.js');
const gate = require(GATE);

const unDiaAntes = (dia) => { const d = new Date(`${dia}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const DESDE = gate.STRICT_EVIDENCE_FROM;
const ANTES = DESDE ? unDiaAntes(DESDE) : '2000-01-01';

const ROSTER = {
  version: 1, story: '1.1', implementer: { kind: 'sesion-principal', session_id: 's1' },
  reviewers: [{ agent: 'tycon-plugin-security-basics', kind: 'subagente', model: 'opus' }], iterations: 1,
};

function carpetaTemporal(t, prefijo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Un repo con la historia 1.1 en `in-progress` en su primer commit. `fecha`: la del commit base. */
function repoDeJuguete(t, { fecha = '2026-11-10' } = {}) {
  const dir = carpetaTemporal(t, 'cigate-veredicto-');
  const correr = (args, f) => execFileSync('git', ['-C', dir, '-c', 'user.email=b@b', '-c', 'user.name=b', '-c', 'maintenance.auto=false', ...args], {
    stdio: 'pipe', encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: `${f || fecha}T12:00:00Z`, GIT_COMMITTER_DATE: `${f || fecha}T12:00:00Z` },
  });
  const escribir = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), txt); };
  const story = (estado) => escribir('specs/1-1.md', `---\nstory: "1.1"\nepic: "1"\nstatus: ${estado}\n---\n# Story 1.1\n`);
  story('in-progress');
  correr(['init', '-q', '-b', 'main', '.']);
  correr(['add', '-A']); correr(['commit', '-q', '-m', 'base']);
  const r = { dir, escribir, story, git: (...a) => correr(a) };
  r.commit = (f) => { correr(['add', '-A']); correr(['commit', '-q', '-m', 'x'], f); };
  r.agregar = (...rutas) => correr(['add', '--', ...rutas]);
  r.cabeza = () => correr(['rev-parse', 'HEAD']).trim();
  r.base = r.cabeza();
  return r;
}

const reglas = (lista) => (lista || []).map((h) => h.regla);
const de = (lista, regla) => (lista || []).filter((h) => h.regla === regla);

/** La historia pasa a `estado` en un commit, con estos archivos de evidencia (ruta → texto). */
function aCerrar(t, estado, archivos, { staged = false } = {}) {
  const r = repoDeJuguete(t);
  r.story(estado);
  for (const [rel, txt] of Object.entries(archivos)) r.escribir(rel, txt);
  if (staged) r.git('add', '-A'); else r.commit();
  return r;
}

const revisar = (r, hoy, { staged = false, base } = {}) => gate.revisar({ repo: r.dir, base: base || r.base, staged, hoy });

test('T12 SondaC_FailVerdict_Blocks — la única evidencia declara FAIL, en sus tres formas, y frena desde la fecha @story-8.259 @ac-9', (t) => {
  assert.match(String(DESDE), /^\d{4}-\d{2}-\d{2}$/, 'el portón exporta STRICT_EVIDENCE_FROM');
  // la última, con los fines de línea de Windows tal como los guarda git
  for (const texto of ['verdict=FAIL\n', '- verdict: FAIL\n', '## Verdict global\n\nFAIL\n', '# x\r\n## Verdict global\r\n\r\nFAIL\r\n']) {
    const r = aCerrar(t, 'review', { '.advisors/dod-runtime/1.1-20261110.md': texto });
    const res = revisar(r, DESDE);
    assert.deepStrictEqual(reglas(res.hallazgos), ['evidencia-de-cierre-falla'], `«${texto.trim()}»: ${JSON.stringify(res.hallazgos)}`);
    const v = res.verificacion.find((x) => x.chequeo === 'veredicto-de-la-evidencia');
    assert.ok(v, 'el chequeo del veredicto figura en verificacion');
    assert.notStrictEqual(v.nivel, 'verificado-por-el-servidor', 'leer el veredicto nunca es «verificado»');
  }
});

test('T13 OnePassAmongFails_Passes — basta un archivo que no declara FAIL; el registro de humos pasa sólo con una salida 0 @story-8.259 @ac-9', (t) => {
  const FAIL = { '.advisors/dod-runtime/1.1-20261110.md': 'verdict=FAIL\n' };
  const casos = [
    ['un .md sin FAIL', { ...FAIL, '.advisors/dod-runtime/1.1-20261111.md': 'hola\n' }, true],
    ['un registro con exit 0', { ...FAIL, '.advisors/dod-runtime/1.1-smoke-ledger.jsonl': '{"exit":2,"acs":[1]}\n{"exit":0,"acs":[1]}\n' }, true],
    ['un registro sin exit 0', { ...FAIL, '.advisors/dod-runtime/1.1-smoke-ledger.jsonl': '{"exit":1}\n{"exit":"0"}\n' }, false],
    ['un registro sin JSON legible', { ...FAIL, '.advisors/dod-runtime/1.1-smoke-ledger.jsonl': 'exit 0\n' }, false],
  ];
  for (const [nombre, archivos, pasa] of casos) {
    const res = revisar(aCerrar(t, 'review', archivos), DESDE);
    if (pasa) {
      assert.deepStrictEqual(res.hallazgos, [], `${nombre}: ${JSON.stringify(res.hallazgos)}`);
      const v = res.verificacion.find((x) => x.chequeo === 'veredicto-de-la-evidencia');
      assert.deepStrictEqual([v.nivel, v.detalle], ['ejecucion-registrada', 'no declara FAIL'], nombre);
    } else {
      assert.deepStrictEqual(reglas(res.hallazgos), ['evidencia-de-cierre-falla'], nombre);
    }
  }
});

test('T14 VerdictUnreadable_DoesNotPass — un archivo que no es texto no pasa, y sin skills el veredicto se lee igual @story-8.259 @ac-9 @ac-10', (t) => {
  const r = aCerrar(t, 'review', { '.advisors/dod-runtime/1.1-20261110.md': 'verdict\u0000FAIL\u0000binario' });
  const res = revisar(r, DESDE);
  const h = de(res.hallazgos, 'veredicto-no-leido');
  assert.strictEqual(h.length, 1, JSON.stringify(res.hallazgos));
  assert.match(h[0].mensaje, /no es texto/);

  // (2) en un proceso aparte, sin skills que cargar: el clon del arnés trae las suyas, así que se apunta a una vacía
  const falla = aCerrar(t, 'review', { '.advisors/dod-runtime/1.1-20261110.md': 'verdict=FAIL\n' });
  const home = carpetaTemporal(t, 'cigate-home-');
  const sinSkills = carpetaTemporal(t, 'cigate-sin-skills-');
  const p = spawnSync(process.execPath, ['-e', `
    const r = require(process.argv[1]).revisar({ repo: process.argv[2], base: process.argv[3], hoy: process.argv[4] });
    console.log(JSON.stringify(r.hallazgos.map((h) => h.regla)));`, GATE, falla.dir, falla.base, DESDE],
  { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_SKILLS_DIR: sinSkills } });
  assert.strictEqual(p.status, 0, p.stderr);
  assert.deepStrictEqual(JSON.parse(p.stdout.trim().split('\n').pop()), ['evidencia-de-cierre-falla']);
  assert.match(p.stderr, /evidence-key\.js/, 'el proceso corrió sin las skills: la biblioteca de la clave no cargó');
});

test('T15 SondaD_StagedReadsIndex — con --staged la evidencia se busca en el índice @story-8.259 @ac-11', (t) => {
  // en el disco y sin `git add`
  const r = repoDeJuguete(t);
  r.story('review'); r.agregar('specs/1-1.md');
  r.escribir('.advisors/dod-runtime/1.1-20261110.md', 'evidencia');
  const sinAdd = revisar(r, DESDE, { staged: true });
  const h = de(sinAdd.hallazgos, 'sin-evidencia-de-cierre');
  assert.strictEqual(h.length, 1, JSON.stringify(sinAdd.hallazgos));
  assert.match(h[0].mensaje, /\.gitignore/, 'nombra el .gitignore como causa posible');
  // con `git add`
  r.agregar('.advisors/dod-runtime/1.1-20261110.md');
  assert.deepStrictEqual(revisar(r, DESDE, { staged: true }).hallazgos, []);
  // en el índice y borrada del disco: lo que se va a commitear la trae
  fs.rmSync(path.join(r.dir, '.advisors', 'dod-runtime', '1.1-20261110.md'));
  assert.deepStrictEqual(revisar(r, DESDE, { staged: true }).hallazgos, [], 'la evidencia del índice cuenta');

  // ni en git ni en el disco: frena como hoy, aun antes de la fecha
  const nada = repoDeJuguete(t);
  nada.story('review'); nada.agregar('specs/1-1.md');
  assert.deepStrictEqual(reglas(revisar(nada, ANTES, { staged: true }).hallazgos), ['sin-evidencia-de-cierre']);

  // a `done` con la carpeta de corrida sólo en el disco
  const c = repoDeJuguete(t);
  c.story('done'); c.escribir('.advisors/dod-runtime/1.1-20261110.md', 'evidencia');
  c.agregar('specs/1-1.md', '.advisors/dod-runtime/1.1-20261110.md');
  c.escribir('.advisors/pipeline-runs/1.1-20261110120000/review-roster.json', JSON.stringify(ROSTER));
  const res = revisar(c, DESDE, { staged: true });
  assert.deepStrictEqual(reglas(res.hallazgos), ['sin-constancia-de-revisores'], JSON.stringify(res.hallazgos));
  // `git add -N` anota la ruta sin su contenido y el commit no la lleva: no está en lo que se va a commitear
  const n = repoDeJuguete(t);
  n.story('done'); n.agregar('specs/1-1.md');
  n.escribir('.advisors/dod-runtime/1.1-20261110.md', 'verdict=FAIL\n');
  n.escribir('.advisors/pipeline-runs/1.1-20261110120000/review-roster.json', JSON.stringify(ROSTER));
  n.git('add', '-N', '.advisors');
  const conN = revisar(n, DESDE, { staged: true });
  assert.deepStrictEqual(reglas(conN.hallazgos), ['sin-evidencia-de-cierre', 'sin-constancia-de-revisores'], JSON.stringify(conN.hallazgos));
  assert.match(de(conN.hallazgos, 'sin-evidencia-de-cierre')[0].mensaje, /git add/);

  // la evidencia commiteada en un submódulo: git del repo no la lista, y eso no es «está sólo en el disco»
  for (const staged of [false, true]) {
    const m = repoDeJuguete(t);
    const sub = path.join(m.dir, 'backend');
    fs.mkdirSync(path.join(sub, '.advisors', 'dod-runtime'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.advisors', 'dod-runtime', '1.1-20261115.md'), '- verdict: PASS\n');
    const enSub = (...a) => execFileSync('git', ['-C', sub, '-c', 'user.email=b@b', '-c', 'user.name=b', ...a], { stdio: 'pipe' });
    enSub('init', '-q', '-b', 'main', '.'); enSub('add', '-A'); enSub('commit', '-q', '-m', 'sub');
    m.story('review');
    if (staged) m.git('add', '-A'); else m.commit();
    const res2 = revisar(m, DESDE, { staged });
    assert.deepStrictEqual(res2.hallazgos, [], `submódulo, staged=${staged}: ${JSON.stringify(res2.hallazgos)}`);
    assert.deepStrictEqual(de(res2.avisos, 'sin-evidencia-de-cierre'), [], `submódulo, staged=${staged}: no avisa «sólo en el disco»`);
  }
});

test('T16 SondaA_FolderNewInPr_RequiresRoster — una carpeta nueva en el pedido pide su registro, con el nombre que traiga @story-8.259 @ac-12', (t) => {
  for (const carpeta of ['1.1-amano', '1.1-20260101120000']) {
    const r = aCerrar(t, 'done', {
      '.advisors/dod-runtime/1.1-20261110.md': 'evidencia',
      [`.advisors/pipeline-runs/${carpeta}/nota.txt`]: 'a mano',
    });
    const res = revisar(r, DESDE);
    assert.deepStrictEqual(reglas(res.hallazgos), ['sin-registro-de-autoria'], `${carpeta}: ${JSON.stringify(res.hallazgos)}`);
  }
  // el registro válido sólo en el disco no lo cumple
  const s = repoDeJuguete(t);
  s.story('done');
  s.escribir('.advisors/dod-runtime/1.1-20261110.md', 'evidencia');
  s.escribir('.advisors/pipeline-runs/1.1-20261110120000/nota.txt', 'a mano');
  s.escribir('.advisors/pipeline-runs/1.1-20261110120000/review-roster.json', JSON.stringify(ROSTER));
  s.agregar('specs/1-1.md', '.advisors/dod-runtime/1.1-20261110.md', '.advisors/pipeline-runs/1.1-20261110120000/nota.txt');
  assert.deepStrictEqual(reglas(revisar(s, DESDE, { staged: true }).hallazgos), ['sin-registro-de-autoria']);
  // …tampoco si el disco suma un aviso de incoherencia: un aviso no es un reclamo de la mirada del disco
  s.escribir('.advisors/pipeline-runs/1.1-20261110120000/findings.json', JSON.stringify([{ advisor: 'fantasma', rule_id: 'X-1' }]));
  const conAviso = revisar(s, DESDE, { staged: true });
  assert.deepStrictEqual(reglas(conAviso.avisos).filter((x) => x === 'roster-incoherente'), ['roster-incoherente']);
  assert.deepStrictEqual(reglas(conAviso.hallazgos), ['sin-registro-de-autoria']);
});

/** Una carpeta de corrida sin registro que ya está en la base, con su commit en `fecha`. */
function conCarpetaEnLaBase(t, carpeta, fecha) {
  const r = repoDeJuguete(t, { fecha: '2026-01-05' });
  r.escribir(`.advisors/pipeline-runs/${carpeta}/findings.json`, '[]');
  r.commit(fecha);
  r.base = r.cabeza();
  r.story('done');
  r.escribir('.advisors/dod-runtime/1.1-20261110.md', 'evidencia');
  r.commit('2026-11-10');
  return r;
}

test('T17 OldFolderBeforeCutoff_NoClaim — una carpeta sin fecha que entró antes del corte no pide nada @story-8.259 @ac-12', (t) => {
  const res = revisar(conCarpetaEnLaBase(t, '1.1-vieja', '2026-01-10'), DESDE);
  assert.deepStrictEqual(res.hallazgos, [], JSON.stringify(res.hallazgos));
  assert.deepStrictEqual(de(res.avisos, 'sin-registro-de-autoria'), []);
});

test('T18 FolderCannotBeDated_RequiresRoster — git que falla y clon recortado piden el registro @story-8.259 @ac-12', (t) => {
  assert.strictEqual(typeof gate.fechaDeCarpeta, 'function', 'el portón exporta fechaDeCarpeta');
  const r = conCarpetaEnLaBase(t, '1.1-vieja', '2026-01-10');
  const roto = () => { throw new Error('git no contesta'); };
  const f = gate.fechaDeCarpeta(r.dir, r.base, '.advisors/pipeline-runs/1.1-vieja', roto);
  assert.ok(f && f.error, `un git que falla no da fecha: ${JSON.stringify(f)}`);

  for (const carpeta of ['1.1-vieja', '1.1-20260101120000']) {
    const origen = repoDeJuguete(t, { fecha: '2026-01-05' });
    origen.escribir(`.advisors/pipeline-runs/${carpeta}/findings.json`, '[]');
    origen.commit('2026-01-10');
    for (const dia of ['2026-09-01', '2026-10-01', '2026-11-02']) { origen.escribir('otro.txt', dia); origen.commit(dia); }
    const clon = path.join(carpetaTemporal(t, 'cigate-recorte-'), 'clon');
    execFileSync('git', ['clone', '-q', '--depth', '2', `file://${origen.dir}`, clon], { stdio: 'pipe' });
    const enClon = (...a) => execFileSync('git', ['-C', clon, '-c', 'user.email=b@b', '-c', 'user.name=b', ...a], { stdio: 'pipe', encoding: 'utf8' });
    enClon('checkout', '-q', '-b', 'pedido');
    fs.writeFileSync(path.join(clon, 'specs', '1-1.md'), '---\nstory: "1.1"\nepic: "1"\nstatus: done\n---\n# Story 1.1\n');
    fs.mkdirSync(path.join(clon, '.advisors', 'dod-runtime'), { recursive: true });
    fs.writeFileSync(path.join(clon, '.advisors', 'dod-runtime', '1.1-20261110.md'), 'evidencia');
    enClon('add', '-A'); enClon('commit', '-q', '-m', 'pedido');
    const res = gate.revisar({ repo: clon, base: 'origin/main', hoy: DESDE });
    const h = de(res.hallazgos, 'sin-registro-de-autoria');
    assert.strictEqual(h.length, 1, `${carpeta}: ${JSON.stringify(res.hallazgos)}`);
    assert.match(h[0].mensaje, /no pude fechar la carpeta/);
    assert.deepStrictEqual(de(res.avisos, 'carpeta-fecha-contradictoria'), [], `${carpeta}: no es una contradicción`);
  }
});

test('T29 FolderNameBeforeCutoffGitAfter_NoticeListed — nombre viejo, git después del corte: avisa y no frena @story-8.259 @ac-12', (t) => {
  const res = revisar(conCarpetaEnLaBase(t, '1.1-20260101120000', '2026-09-15'), DESDE);
  assert.deepStrictEqual(res.hallazgos, [], JSON.stringify(res.hallazgos));
  const a = de(res.avisos, 'carpeta-fecha-contradictoria');
  assert.strictEqual(a.length, 1, JSON.stringify(res.avisos));
  assert.match(a[0].mensaje, /1\.1-20260101120000/);
  assert.match(a[0].mensaje, /2026-01-01/);
  assert.match(a[0].mensaje, /2026-09-15/);
});

test('T30 TandaB_NoticeBeforeDate_BlocksAfter — antes de la fecha avisa con la misma regla, desde la fecha frena @story-8.259 @ac-22', (t) => {
  const casos = [
    ['evidencia FAIL', 'evidencia-de-cierre-falla', (staged) => aCerrar(t, 'review', { '.advisors/dod-runtime/1.1-20261110.md': 'verdict=FAIL\n' }, { staged })],
    ['evidencia ilegible', 'veredicto-no-leido', (staged) => aCerrar(t, 'review', { '.advisors/dod-runtime/1.1-20261110.md': 'a\u0000b' }, { staged })],
    ['carpeta nueva', 'sin-registro-de-autoria', (staged) => aCerrar(t, 'done', {
      '.advisors/dod-runtime/1.1-20261110.md': 'evidencia', '.advisors/pipeline-runs/1.1-amano/nota.txt': 'x' }, { staged })],
  ];
  for (const staged of [false, true]) {
    for (const [nombre, regla, armar] of casos) {
      const r = armar(staged);
      const antes = revisar(r, ANTES, { staged });
      assert.deepStrictEqual(antes.hallazgos, [], `${nombre}, staged=${staged}: antes de la fecha no frena`);
      assert.strictEqual(de(antes.avisos, regla).length, 1, `${nombre}, staged=${staged}: avisa con ${regla}`);
      assert.deepStrictEqual(reglas(revisar(r, DESDE, { staged }).hallazgos), [regla], `${nombre}, staged=${staged}: desde la fecha frena`);
    }
    // la evidencia en el disco y no en git
    const d = repoDeJuguete(t);
    d.story('review');
    if (staged) d.agregar('specs/1-1.md'); else d.commit();
    d.escribir('.advisors/dod-runtime/1.1-20261110.md', 'evidencia');
    const antes = revisar(d, ANTES, { staged });
    assert.deepStrictEqual(antes.hallazgos, [], `disco sin git, staged=${staged}`);
    assert.strictEqual(de(antes.avisos, 'sin-evidencia-de-cierre').length, 1);
    assert.deepStrictEqual(reglas(revisar(d, DESDE, { staged }).hallazgos), ['sin-evidencia-de-cierre']);
  }
});

test('T32 Guide_SaysVerdictIsRead — la guía dice qué lee el portón del veredicto y desde cuándo frena @story-8.259 @ac-22', () => {
  const guia = fs.readFileSync(path.join(ROOT, 'guides', 'ci-gate.md'), 'utf8');
  assert.ok(guia.includes(DESDE), `la guía nombra ${DESDE}`);
  assert.match(guia, /evidencia-de-cierre-falla/);
  assert.match(guia, /«hola» (sigue pasando|pasa)/);
  assert.doesNotMatch(guia, /Se declara, no se cierra todavía/);
  assert.doesNotMatch(guia, /No lee lo que dice la evidencia de cierre/);
  assert.doesNotMatch(guia, /no lo que dice adentro/);
});
