'use strict';

/**
 * legacy-names-c3.test.js — los internos y las pruebas, renombrados (story 8.9, tanda C3 · 2026-10-01). T41, T42.
 *
 * Lo que no se puede perder:
 *   · Lo que nadie llama de afuera se renombra SIN reemplazo: en la ruta vieja no queda nada, y el que una guía manda a
 *     correr a mano deja el reemplazo generado (T41). El mapa pasa `--check-map` y no queda ningún ejecutable interno con
 *     nombre en castellano salvo los que esperan a otra tanda: el aviso del freno de producción, hasta su reinstalación
 *     ([DEF-8.9-C1-FRENO]), y el mapa del arnés, que muda la story 8.12, tanda R4 ([DEF-8.9-C2-HARNESS-MAP]).
 *   · Renombrar una prueba no la hace «desaparecer» del reporte nocturno: el reporte une la foto anterior con la de hoy
 *     por el mapa de renombres, y sólo anota como desaparecida una suite que de verdad no corrió (T42).
 *
 * Las rutas viejas salen del mapa en tiempo de ejecución (escritas acá, mantendrían vivos los nombres en castellano que
 * cuenta el termómetro). La prueba sale en la copia pública: sin el mapa del equipo, se saltea con motivo.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const { sinGitDelPadre } = require(path.join(RAIZ, 'scripts', 'lib', 'clean-git-env.js'));
const MAP =path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const TEAM = fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && fs.existsSync(MAP);
const SKIP_PUBLIC = !TEAM && 'copia pública: sin el mapa';
const SHIM_MARK = 'tycon-legacy-shim:';
const REPORT = path.join(RAIZ, 'scripts', 'ci', 'suites-report.js');

// Lo que el plan de la tanda aprobó (AC 37, re-medido al abrir la C3): 30 archivos, 1 con reemplazo.
const EXPECTED_FILES = 30;
const EXPECTED_SHIMS = 1;
// Los ejecutables internos que quedan en castellano a propósito: el aviso del freno (lo protege el freno por nombre). El
// código del mapa del arnés se renombró al inglés al pasar al repo público (census.js y public-version.js).
const STILL_SPANISH = ['arnes:scripts/hooks/produccion-notice.js'];

/**
 * agent-skills, por la regla común de scripts/lib/skills-dir.js: TYCON_SKILLS_DIR (el clon o su carpeta `skills`) › el
 * propio clon si es unido › la copia de la máquina. `null` si ahí no hay skills. Sin `catch`: si la biblioteca no puede
 * contestar, la suite es roja con la causa (story 8.18, pase adversarial del tramo 2, clase 3: sin variable miraba sólo
 * la ruta instalada y, en un clon unido, salteaba T41 y T41b o juzgaba las entradas de agent-skills en OTRO clon).
 */
function skillsRoot() {
  const root = require(path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '').repo;
  return fs.existsSync(path.join(root, 'skills', 'tycon-pipeline')) ? root : null;
}
const SKILLS = skillsRoot();
const rootOf = (e) => ((e.repo || 'arnes') === 'agent-skills' ? SKILLS : RAIZ);
const entries = () => (TEAM ? JSON.parse(fs.readFileSync(MAP, 'utf8')).entries : []);
const c3Files = () => entries().filter((e) => e.kind === 'file' && e.batch === 'C3'
  && !/(^|\/)tests\//.test(e.old));
const c3Tests = () => entries().filter((e) => e.kind === 'file' && e.batch === 'C3' && /(^|\/)tests\//.test(e.old));
const firstLines = (abs) => fs.readFileSync(abs, 'utf8').split('\n').slice(0, 3).join('\n');

function cleanEnv(extra) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD') e[k] = v;
  return { ...e, ...extra };
}

test('T41 · BatchC3_InternalsRenamedNoShim — los 30 mudados; sin reemplazo salvo el que una guía corre a mano', { skip: SKIP_PUBLIC || (!SKILLS && 'sin agent-skills') }, () => {
  const files = c3Files();
  assert.strictEqual(files.length, EXPECTED_FILES, `archivos con batch C3 en el mapa: ${files.map((e) => e.old).join(', ')}`);
  const withShim = files.filter((e) => e.callers.some((c) => !['same-repo', 'ado'].includes(c)));
  assert.strictEqual(withShim.length, EXPECTED_SHIMS, `con reemplazo: ${withShim.map((e) => e.old).join(', ')}`);
  for (const e of files) {
    const root = rootOf(e);
    assert.ok(fs.existsSync(path.join(root, e.new)), `${e.new} no existe`);
    const old = path.join(root, e.old);
    if (withShim.includes(e)) {
      assert.ok(fs.existsSync(old) && firstLines(old).includes(`${SHIM_MARK} ${e.new}`), `${e.old}: no es el reemplazo de ${e.new}`);
    } else {
      assert.ok(!fs.existsSync(old), `${e.old} sigue en el disco (no lleva reemplazo: nadie lo llama de afuera)`);
    }
  }
  for (const e of c3Tests()) {
    assert.ok(fs.existsSync(path.join(rootOf(e), e.new)), `${e.new} no existe`);
    assert.ok(!fs.existsSync(path.join(rootOf(e), e.old)), `${e.old} sigue en el disco`);
  }
});

// ── los dos repos, o el repo unido (story 8.18) ─────────────────────────────────────────────────────────────────────
// Desde que el arnés trae agent-skills adentro, «los dos repos» pueden ser la MISMA carpeta: a la pregunta «dónde está
// agent-skills» le contestan el propio clon (por el enlace ~/.claude/agent-skills o por TYCON_SKILLS_DIR). Recorrerla una
// vez por repo contaba cada archivo dos veces, y `scripts/` del arnés salía además como si fuera de agent-skills (medido
// en Azure sobre la rama junta, corrida 11741). Cada archivo se mira UNA vez y con su fuente lógica: la misma partición
// por ruta de los frenos de nombres (new-names.js → sourceOfPath). Con dos clones no cambia nada: en el árbol del arnés
// de antes no hay ninguna ruta de la fuente agent-skills, y el otro clon es esa fuente entera.
const SPANISH_NAMES = path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js');
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const HIST = /^(specs|tasks|qa|\.advisors|\.dashboard|\.engram|inbox\/instincts\/archived)\//;
/** El detector del freno, con el diccionario del sistema si está. */
function detector() {
  const lib = require(SPANISH_NAMES);
  const words = lib.loadWords(fs.readFileSync(path.join(RAIZ, lib.WORDS_PATH), 'utf8'), lib.WORDS_PATH);
  const dictPath = process.env.TYCON_SPANISH_NAMES_DICTIONARY || '/usr/share/dict/words';
  return { det: lib.makeDetector(words, { dictPath }), dictPath };
}
/** Los ejecutables con nombre en castellano que no son un reemplazo generado: `["fuente:ruta", …]`. */
function spanishInternals(harnessRoot, skillsRoot, det) {
  const lib = require(SPANISH_NAMES);
  const { sourceOfPath } = require(path.join(RAIZ, 'scripts', 'publishing', 'new-names.js'));
  const roots = [[harnessRoot, sourceOfPath]];
  if (real(skillsRoot) !== real(harnessRoot)) roots.push([skillsRoot, () => 'agent-skills']);
  const left = [];
  for (const [dir, sourceOf] of roots) {
    // sin las variables que git le pasa a sus hooks: con ellas, `-C <dir>` no decide de qué repo se lista
    const ls = spawnSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28, env: sinGitDelPadre() });
    assert.strictEqual(ls.status, 0, `git ls-files en ${dir}: ${ls.stderr}`);
    for (const rel of ls.stdout.split('\0').filter(Boolean)) {
      if (HIST.test(rel)) continue;
      const abs = path.join(dir, rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue;
      const text = buf.toString('utf8');
      if (lib.kindOf(rel, text) !== 'executable' || text.split('\n').slice(0, 3).some((l) => l.includes(SHIM_MARK))) continue;
      const names = lib.pathNames(rel);
      if (det.isSpanish(names[names.length - 1]).spanish) left.push(`${sourceOf(rel)}:${rel}`);
    }
  }
  return left;
}

test('T41b · BatchC3_MapChecksAndNoSpanishInternals — --check-map pasa y no queda ningún interno en castellano', { skip: SKIP_PUBLIC || (!SKILLS && 'sin agent-skills') }, () => {
  const sn = SPANISH_NAMES;
  const r = spawnSync(process.execPath, [sn, '--check-map', '--repo', RAIZ], { encoding: 'utf8', env: cleanEnv({ TYCON_SKILLS_DIR: SKILLS }) });
  assert.strictEqual(r.status, 0, `--check-map: ${r.stdout}${r.stderr}`);
  // El mismo detector del freno, sobre lo que git versiona de los dos repos: ejecutables con nombre en castellano que no son
  // un reemplazo generado.
  const { det, dictPath } = detector();
  const left = spanishInternals(RAIZ, SKILLS, det);
  // Sin diccionario del sistema (el agente de Azure no trae /usr/share/dict/words) el detector reconoce menos castellano
  // (`censo` no sale): se ve menos, pero lo que se ve tiene que ser lo esperado.
  if (fs.existsSync(dictPath)) assert.deepStrictEqual(left.sort(), STILL_SPANISH, 'ejecutables internos que siguen en castellano');
  else for (const x of left) assert.ok(STILL_SPANISH.includes(x), `${x}: ejecutable interno en castellano que no se esperaba (sin diccionario)`);
});

// El mismo veredicto con un repo que con dos (story 8.18): un ejecutable en castellano sale UNA vez y con su fuente, esté
// agent-skills en otro clon, en el mismo, o dado por un enlace al mismo. Árboles de juguete; el nombre en castellano es el
// del aviso del freno, que el detector reconoce con o sin el diccionario del sistema.
test('T41b · BatchC3_MapChecksAndNoSpanishInternals — el repo unido y los dos repos dan el mismo veredicto, cada archivo con su fuente', { skip: SKIP_PUBLIC }, () => {
  const { det } = detector();
  const spanish = path.posix.basename(STILL_SPANISH[0].split(':')[1]);
  const harnessFiles = { [`scripts/lab/${spanish}`]: '#!/usr/bin/env node\n', 'scripts/lab/reader.js': '#!/usr/bin/env node\n' };
  const skillsFiles = { [`skills/lab-skill/scripts/${spanish}`]: '#!/usr/bin/env node\n', 'agents/lab-reviewer.md': '# lab\n' };
  const expected = [`agent-skills:skills/lab-skill/scripts/${spanish}`, `arnes:scripts/lab/${spanish}`];
  const dirs = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-home-')); dirs.push(home);   // git de verdad, sin la configuración de la máquina
  const gitEnv = sinGitDelPadre({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' });
  const make = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-tree-')); dirs.push(d);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
      fs.writeFileSync(path.join(d, rel), content);
    }
    const r = spawnSync('git', ['-C', d, 'init', '-q'], { encoding: 'utf8', env: gitEnv });
    assert.strictEqual(r.status, 0, `git init en el laboratorio: ${r.stderr}`);
    return d;
  };
  try {
    const unified = make({ ...harnessFiles, ...skillsFiles });
    assert.deepStrictEqual(spanishInternals(unified, unified, det).sort(), expected, 'el repo unido: una sola carpeta, cada archivo una vez');
    const link = path.join(home, 'agent-skills');
    fs.symlinkSync(unified, link, 'junction');   // `junction`: en Windows no pide permisos; en los demás se ignora
    assert.deepStrictEqual(spanishInternals(unified, link, det).sort(), expected, 'el repo unido, con agent-skills dado por un enlace al mismo clon');
    const skillsOnly = make(skillsFiles);
    assert.deepStrictEqual(spanishInternals(make(harnessFiles), skillsOnly, det).sort(), expected, 'dos repos: lo de siempre');
    // el clon unido con agent-skills dado en OTRO clon (el instalado de antes, todavía en la máquina): lo de `skills/`
    // del clon unido sigue siendo de la fuente agent-skills, nunca del arnés; el otro clon se mira además, entero
    assert.deepStrictEqual(spanishInternals(unified, skillsOnly, det).sort(), [expected[0], ...expected], 'el repo unido más otro clon de agent-skills');
  } finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
});

// ── T42: el reporte de suites lee el mapa ──────────────────────────────────────────────────────────────────────────
function report(dir, { previous, ran, runs, failures = '' }) {
  const rep = path.join(dir, 'ultimo.json');
  const ranFile = path.join(dir, 'ran.txt');
  fs.writeFileSync(ranFile, ran.join('\n') + '\n');
  const args = [REPORT, '--rep', rep, '--build', '2', '--runs', String(runs), '--failures', failures, '--detail', dir, '--ran', ranFile];
  if (previous) { fs.writeFileSync(path.join(dir, 'anterior.json'), JSON.stringify(previous)); args.push('--previous', path.join(dir, 'anterior.json')); }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: cleanEnv({}) });
  assert.strictEqual(r.status, 0, `suites-report: ${r.stdout}${r.stderr}`);
  return { out: JSON.parse(fs.readFileSync(rep, 'utf8')), stderr: r.stderr };
}

test('T42 · BatchC3_SuitesReportSameCount — una suite renombrada no «desaparece»; una que no corrió, sí', { skip: SKIP_PUBLIC }, () => {
  const t = c3Tests().find((e) => (e.repo || 'arnes') === 'arnes' && /\.test\.(sh|js)$/.test(e.old));
  assert.ok(t, 'la tanda no tiene pruebas renombradas del arnés');
  const viejo = path.posix.basename(t.old), nuevo = path.posix.basename(t.new);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-suites-'));
  try {
    // La foto anterior es de antes del cambio: sin lista de corridas, con la renombrada en rojo por su nombre viejo.
    const prev = { kind: 'bash-tests', build: '1', corridas: 3, failures: [viejo], motivos: { [viejo]: 'x' }, reintentos: {} };
    const ok = report(dir, { previous: prev, ran: [nuevo, 'a.test.sh', 'b.test.js'], runs: 3, failures: nuevo });
    assert.strictEqual(ok.out.corridas, prev.corridas, 'misma cantidad de suites que la foto anterior');
    assert.deepStrictEqual(ok.out.disappeared, [], `ninguna desapareció: ${ok.stderr}`);
    assert.deepStrictEqual(ok.out.ran, [nuevo, 'a.test.sh', 'b.test.js'].sort());
    for (const k of ['failures', 'motivos', 'reintentos', 'corridas']) assert.ok(k in ok.out, `falta la clave ${k}, que leen otros`);

    // Una que de verdad no corrió: la foto anterior (ahora con su lista) la tenía y hoy falta.
    const gone = report(dir, { previous: ok.out, ran: [nuevo, 'a.test.sh'], runs: 2 });
    assert.deepStrictEqual(gone.out.disappeared, ['b.test.js']);
    assert.match(gone.stderr, /b\.test\.js/, 'el aviso nombra la suite que desapareció');

    // Sin --previous, la foto anterior es el --rep antes de pisarlo.
    const again = report(dir, { ran: [nuevo], runs: 1 });
    assert.deepStrictEqual(again.out.disappeared, ['a.test.sh']);

    // Una suite que todavía corre por su nombre VIEJO (suites.json la nombra por su reemplazo) tampoco desaparece de una
    // noche a la otra: las dos fotos pasan por el mapa (pase adversarial de la C3: sólo se traducía la de antes).
    const conViejo = report(dir, { ran: [viejo, 'a.test.sh'], runs: 2 });
    const otraNoche = report(dir, { ran: [viejo, 'a.test.sh'], runs: 2 });
    assert.deepStrictEqual(conViejo.out.disappeared, [], `primera noche: ${conViejo.stderr}`);
    assert.deepStrictEqual(otraNoche.out.disappeared, [], `la misma lista la noche siguiente: ${otraNoche.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
