'use strict';

/**
 * legacy-names-c4.test.js — las carpetas, a su destino final (story 8.9, tanda C4 · 2026-10-01). T43, T44.
 *
 * Lo que no se puede perder:
 *   · Las cuatro carpetas de la C4 quedan mudadas (en la vieja sólo reemplazos), cada ejecutable que alguien nombra desde
 *     fuera deja su reemplazo, y los cinco `.json` en castellano se mudan una sola vez, ya con nombre en inglés (decisión
 *     del dueño, AC 39). Cambian las rutas y no los valores: cada aparición clasificada como valor antes de tocar nada
 *     sigue ahí, y ninguna ruta vieja queda fuera de la historia (T43).
 *   · El pre-commit de agent-skills corre el freno de verdad: con un arnés al día, por la carpeta nueva; con uno
 *     atrasado, por la vieja. La ruta vieja de los frenos corre el de verdad (mismo resultado) (T43).
 *   · El exportador no queda con exclusiones sin archivo y los pipelines de Azure parsean y nombran rutas que existen,
 *     ninguna de una carpeta mudada (T44). La parte manual de T44 —el nocturno siguiente con la misma cobertura— es la
 *     espera de la tanda D.
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
const { preCommitHook } = require('./lib/pre-commit-hook.js');

const RAIZ = path.resolve(__dirname, '..', '..');
const MAP = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const TEAM = fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && fs.existsSync(MAP);
const SKIP_PUBLIC = !TEAM && 'copia pública: sin el mapa';
const SHIM_MARK = 'tycon-legacy-shim:';
// La clasificación de cada aparición, hecha antes de tocar nada (AC 39: «archivo en el run dir»).
const CLASSIFICATION = path.join(RAIZ, '.advisors', 'pipeline-runs', '8.9-C4-20261001-1100', 'clasificacion-c4.tsv');

// Lo que el plan aprobó (re-medido al abrir la C4): 5 ejecutables con reemplazo y 5 `.json` renombrados sin reemplazo.
const EXPECTED_SHIMS = 5;
const EXPECTED_RENAMED_JSON = 5;
// Los tres guiones del arnés que el pre-commit de agent-skills corre por ruta.
const PRE_COMMIT_SCRIPTS = ['new-names.js', 'spanish-names.js', 'third-party-coverage.js'];

/**
 * agent-skills, por la regla común (scripts/lib/skills-dir.js): TYCON_SKILLS_DIR (el clon o su carpeta `skills`) › el
 * propio clon si es unido › la copia de la máquina. `null` si ahí no hay skills. Sin `catch`: si la biblioteca no puede
 * contestar, la suite es roja con la causa (story 8.18: antes cada suite tenía la ruta instalada escrita a mano).
 */
function skillsRoot() {
  const root = require(path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '').repo;
  return fs.existsSync(path.join(root, 'skills', 'tycon-pipeline')) ? root : null;
}
const SKILLS = skillsRoot();
const entries = () => (TEAM ? JSON.parse(fs.readFileSync(MAP, 'utf8')).entries : []);
const c4 = () => entries().filter((e) => e.batch === 'C4' && (e.kind === 'file' || e.kind === 'folder'));
const c4Folders = () => c4().filter((e) => e.kind === 'folder');
const c4Files = () => c4().filter((e) => e.kind === 'file');
// la carpeta de publicación, vieja y nueva (la que tiene una subcarpeta mudada adentro)
const publishing = () => {
  const f = c4Folders();
  const parent = f.find((e) => f.some((x) => x !== e && x.old.startsWith(`${e.old}/`)));
  assert.ok(parent, 'el mapa no trae la carpeta de publicación con su subcarpeta (batch C4)');
  return parent;
};
const firstLines = (abs) => fs.readFileSync(abs, 'utf8').split('\n').slice(0, 3).join('\n');

function cleanEnv(extra) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD') e[k] = v;
  return { ...e, ...extra };
}
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `c4-${p}-`));

test('T43 · BatchC4_FoldersPathsNotValues — las cuatro carpetas mudadas; reemplazo para lo que se nombra de afuera', { skip: SKIP_PUBLIC }, () => {
  const legacy = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
  const folders = c4Folders();
  assert.strictEqual(folders.length, 4, `carpetas con batch C4: ${folders.map((e) => e.old).join(', ')}`);
  for (const e of folders) {
    assert.ok(legacy.isMoved(e, RAIZ), `${e.old} → ${e.new}: no está mudada (la nueva no existe o en la vieja queda algo que no es un reemplazo)`);
  }
  const files = c4Files();
  const withShim = files.filter((e) => e.callers.some((c) => !['same-repo', 'ado'].includes(c)));
  const renamed = files.filter((e) => !withShim.includes(e));
  assert.strictEqual(withShim.length, EXPECTED_SHIMS, `con reemplazo: ${withShim.map((e) => e.old).join(', ')}`);
  assert.strictEqual(renamed.length, EXPECTED_RENAMED_JSON, `renombrados sin reemplazo: ${renamed.map((e) => e.old).join(', ')}`);
  for (const e of files) {
    assert.ok(fs.existsSync(path.join(RAIZ, e.new)), `${e.new} no existe`);
    const old = path.join(RAIZ, e.old);
    if (withShim.includes(e)) {
      assert.ok(fs.existsSync(old) && firstLines(old).includes(`${SHIM_MARK} ${e.new}`), `${e.old}: no es el reemplazo de ${e.new}`);
    } else {
      assert.ok(e.old.endsWith('.json') && e.new.endsWith('.json'), `${e.old}: sólo los .json se renombran sin reemplazo`);
      assert.ok(!fs.existsSync(old), `${e.old} sigue en el disco (nadie lo lee de afuera: no lleva reemplazo)`);
    }
  }
});

test('T43b · BatchC4_FoldersPathsNotValues — ninguna ruta vieja fuera de la historia; los valores clasificados siguen', { skip: SKIP_PUBLIC || (!SKILLS && 'sin agent-skills') }, () => {
  const sn = path.join(RAIZ, publishing().new, 'spanish-names.js');
  const r = spawnSync(process.execPath, [sn, '--stale-mentions', '--json', '--repo', RAIZ], { encoding: 'utf8', env: cleanEnv({ TYCON_SKILLS_DIR: SKILLS }), maxBuffer: 1 << 26 });
  assert.ok(r.status === 0 || r.status === 1, `--stale-mentions no pudo mirar (rc=${r.status}): ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const prefixes = c4Folders().map((e) => `${e.old}/`);
  const jsons = c4Files().filter((e) => e.old.endsWith('.json')).map((e) => e.old);
  const mine = (out.findings || []).filter((f) => f && typeof f.old === 'string' && (prefixes.some((p) => `${f.old}/`.startsWith(p)) || jsons.includes(f.old)));
  assert.deepStrictEqual(mine.map((f) => `${f.source}:${f.rel}:${f.line} ${f.old}`), [], 'menciones de una ruta de la C4 fuera de su lugar');

  // Los valores: cada línea clasificada como valor antes de la mudanza sigue en su archivo (por el mapa, si se mudó).
  assert.ok(fs.existsSync(CLASSIFICATION), `falta la clasificación de la tanda (${path.relative(RAIZ, CLASSIFICATION)})`);
  const rows = fs.readFileSync(CLASSIFICATION, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t'));
  const values = rows.filter((x) => x[4] === 'valor');
  assert.ok(values.length >= 20, `la clasificación trae ${values.length} valores (se midieron 31)`);
  const fileMoves = new Map(c4Files().map((e) => [e.old, e.new]));
  // la ruta de hoy: la mudanza de la C4 y, después, las de las tandas siguientes (la R4 de la story 8.12 volvió a mudar
  // la carpeta del mapa del arnés a `scripts/tools/harness-map/`): se sigue la cadena del mapa hasta que no cambie, y sólo por las
  // mudanzas que ya pasaron —el mapa declara también las que vienen (la carpeta de la mini-clase, tanda F de la 8.9)—
  const laterMoves = entries().filter((e) => (e.kind === 'file' || e.kind === 'folder') && e.batch !== 'C4' && (!e.repo || e.repo === 'arnes')
    && typeof e.old === 'string' && typeof e.new === 'string' && fs.existsSync(path.join(RAIZ, e.new)));
  const step = (rel, list, files) => {
    if (files.has(rel)) return files.get(rel);
    const f = list.filter((e) => e.kind === 'folder' && rel.startsWith(`${e.old.replace(/\/+$/, '')}/`)).sort((a, b) => b.old.length - a.old.length)[0];
    return f ? `${f.new.replace(/\/+$/, '')}${rel.slice(f.old.replace(/\/+$/, '').length)}` : rel;
  };
  const laterFiles = new Map(laterMoves.filter((e) => e.kind === 'file').map((e) => [e.old, e.new]));
  const moved = (rel, repo) => {
    let cur = step(rel, c4Folders().map((e) => ({ ...e, kind: 'folder' })), fileMoves);
    for (let i = 0; repo === 'arnes' && i < 10; i++) {
      const next = step(cur, laterMoves, laterFiles);
      if (next === cur) break;
      cur = next;
    }
    return cur;
  };
  // una línea con un valor puede nombrar además uno de los `.json` renombrados: ese nombre sí cambia (por el mapa)
  const renamedBases = c4Files().filter((e) => e.old.endsWith('.json')).map((e) => [path.posix.basename(e.old), path.posix.basename(e.new)]);
  // la tanda D1 renombra las claves de la configuración (AC 42): una palabra que la C4 vio como valor y la D1 clasificó
  // como clave (la de los sintéticos de la lista blanca) cambia con su clave, no con la mudanza
  const d1Keys = new Set(entries().filter((e) => e.batch === 'D1' && e.kind === 'key').map((e) => e.old));
  const lost = [];
  for (const [repo, rel, , word, , text] of values) {
    if (d1Keys.has(word)) continue;
    const root = repo === 'agent-skills' ? SKILLS : RAIZ;
    if (!root) continue;
    const abs = path.join(root, moved(rel, repo));
    const body = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const expected = renamedBases.reduce((t, [o, n]) => t.split(o).join(n), text);
    if (!body.includes(expected)) lost.push(`${repo}:${rel} «${text.slice(0, 80)}»`);
  }
  assert.deepStrictEqual(lost, [], 'valores que la mudanza cambió (sólo cambian las rutas)');
});

// ── El pre-commit de agent-skills con un arnés de laboratorio ─────────────────────────────────────────────────────
/** Un arnés de laboratorio con los tres guiones en `dirs` (relativas); cada uno anota su ruta en el registro y pasa. */
function labHarness(dirs) {
  const h = tmp('arnes');
  for (const d of dirs) {
    fs.mkdirSync(path.join(h, d), { recursive: true });
    for (const s of PRE_COMMIT_SCRIPTS) {
      fs.writeFileSync(path.join(h, d, s), `require('fs').appendFileSync(process.env.C4_LOG, ${JSON.stringify(`${d}/${s}`)} + '\\n');\n`);
    }
  }
  return h;
}
/** Un repo de laboratorio con un archivo stageado bajo skills/ (así corre también el control de terceros). */
function labRepo() {
  const r = tmp('repo');
  const g = (...a) => spawnSync('git', ['-C', r, ...a], { encoding: 'utf8' });
  g('init', '-q');
  fs.mkdirSync(path.join(r, 'skills', 'x'), { recursive: true });
  fs.writeFileSync(path.join(r, 'skills', 'x', 'SKILL.md'), 'x\n');
  assert.strictEqual(g('add', '.').status, 0);
  return r;
}
function runPreCommit(harness) {
  const log = path.join(tmp('log'), 'ran.txt');
  fs.writeFileSync(log, '');
  // los controles de las skills viven en `pre-commit-checks`: lo elige el ayudante
  const r = spawnSync('bash', [preCommitHook('skills', SKILLS)], {
    cwd: labRepo(), encoding: 'utf8', env: cleanEnv({ TYCON_GUIDES_DIR: harness, C4_LOG: log }),
  });
  return { status: r.status, stderr: r.stderr, ran: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test('T43c · BatchC4_FoldersPathsNotValues — el pre-commit de agent-skills corre el freno de verdad, al día o atrasado', { skip: SKIP_PUBLIC || (!SKILLS && 'sin agent-skills') }, () => {
  const p = publishing();
  const fresh = runPreCommit(labHarness([p.new]));
  assert.strictEqual(fresh.status, 0, `arnés al día: ${fresh.stderr}`);
  // (la parte de las skills dice «pre-commit AgentSkills: no encontré …»; la del arnés, que corre en el mismo archivo, avisa
  // aparte por el lint de stories que el repo de laboratorio no trae)
  assert.doesNotMatch(fresh.stderr, /AgentSkills: no encontré/, 'arnés al día: el pre-commit no encontró un guion');
  assert.deepStrictEqual(fresh.ran, PRE_COMMIT_SCRIPTS.map((s) => `${p.new}/${s}`), 'arnés al día: corre los tres por la carpeta nueva');

  // con las dos carpetas (la vieja es la de los reemplazos): la nueva primero, nunca las dos
  const both = runPreCommit(labHarness([p.new, p.old]));
  assert.deepStrictEqual(both.ran, PRE_COMMIT_SCRIPTS.map((s) => `${p.new}/${s}`), 'con las dos carpetas: sólo la nueva');

  const stale = runPreCommit(labHarness([p.old]));
  assert.strictEqual(stale.status, 0, `arnés atrasado: ${stale.stderr}`);
  assert.doesNotMatch(stale.stderr, /AgentSkills: no encontré/, 'arnés atrasado: el pre-commit no encontró un guion');
  assert.deepStrictEqual(stale.ran, PRE_COMMIT_SCRIPTS.map((s) => `${p.old}/${s}`), 'arnés atrasado: corre los tres por la carpeta vieja');
});

test('T43d · BatchC4_FoldersPathsNotValues — la ruta vieja de los frenos corre el de verdad', { skip: SKIP_PUBLIC || (!SKILLS && 'sin agent-skills') }, () => {
  const p = publishing();
  const env = cleanEnv({ TYCON_SKILLS_DIR: SKILLS });
  const cases = [['new-names.js', ['--range', 'HEAD...HEAD', '--json']], ['spanish-names.js', ['--check-map', '--repo', RAIZ]]];
  for (const [s, args] of cases) {
    const viaOld = spawnSync(process.execPath, [path.join(RAIZ, p.old, s), ...args], { cwd: RAIZ, encoding: 'utf8', env });
    const viaNew = spawnSync(process.execPath, [path.join(RAIZ, p.new, s), ...args], { cwd: RAIZ, encoding: 'utf8', env });
    assert.ok(firstLines(path.join(RAIZ, p.old, s)).includes(`${SHIM_MARK} ${p.new}/${s}`), `${p.old}/${s} no es el reemplazo`);
    assert.strictEqual(viaOld.status, viaNew.status, `${s}: la ruta vieja sale ${viaOld.status} y la nueva ${viaNew.status}`);
    assert.strictEqual(viaOld.stdout.replace(/"ms":\d+/g, ''), viaNew.stdout.replace(/"ms":\d+/g, ''), `${s}: otra salida por la ruta vieja`);
  }
});

// Pase adversarial de la C4: el freno compila el exportador de una foto de antes de la mudanza (la base del PR de la C4),
// cuyo `require` relativo al detector cae en el reemplazo generado de la carpeta vieja. Ese reemplazo es para los
// llamadores de afuera: cargado por el propio freno anotaba un uso falso del nombre viejo y, en Azure, un aviso por stderr.
test('T43e · BatchC4_FoldersPathsNotValues — el código de una foto vieja no pasa por los reemplazos', { skip: SKIP_PUBLIC }, () => {
  const p = publishing();
  const home = tmp('home');
  const code = `
    const nn = require(${JSON.stringify(path.join(RAIZ, p.new, 'new-names.js'))});
    const text = () => "module.exports = { whatShips() {}, det: require('../" + ${JSON.stringify(path.posix.basename(p.old))} + "/detector.js') };";
    const mod = nn.exporterFor(${JSON.stringify(`${p.new}/export.js`)}, { obj: 'f'.repeat(40) }, text);
    const real = require(${JSON.stringify(path.join(RAIZ, p.new, 'detector.js'))});
    process.stdout.write(JSON.stringify({ same: mod.det === real }));`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: RAIZ, encoding: 'utf8', env: cleanEnv({ HOME: home, TF_BUILD: 'True' }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { same: true }, 'la foto vieja carga el detector de verdad');
  assert.doesNotMatch(r.stderr, /nombre viejo/, 'sin aviso de nombre viejo en Azure');
  assert.ok(!fs.existsSync(path.join(home, '.claude', '.tycon-pipeline', 'legacy-names.jsonl')), 'sin anotar un uso del nombre viejo');
});

test('T44 · BatchC4_ExporterAndNightly — el exportador sin exclusiones sin archivo', { skip: SKIP_PUBLIC || (!SKILLS && 'sin agent-skills') }, () => {
  // sobre lo commiteado de los dos repos (por defecto el exportador mira origin/main, que antes del merge no trae la tanda)
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'publishing', 'export.js'), '--explain', '--json', '--harness', 'HEAD', '--agent-skills', 'HEAD'],
    { cwd: RAIZ, encoding: 'utf8', env: cleanEnv({ TYCON_GUIDES_DIR: RAIZ, TYCON_SKILLS_DIR: SKILLS }), maxBuffer: 1 << 26 });
  assert.strictEqual(r.status, 0, `--explain: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.exclusionesSinArchivo), 'la salida no trae exclusionesSinArchivo');
  assert.deepStrictEqual(out.exclusionesSinArchivo, [], 'exclusiones que ya no cubren ningún archivo');
});

test('T44b · BatchC4_ExporterAndNightly — los pipelines de Azure parsean y nombran rutas que existen, ninguna mudada', { skip: SKIP_PUBLIC }, () => {
  const py = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
  // desde la R6 los seis viven en pipelines/
  const PIPES = path.join(RAIZ, 'pipelines');
  const ymls = fs.existsSync(PIPES) ? fs.readdirSync(PIPES).filter((f) => /^azure-pipelines[\w-]*\.yml$/.test(f)).map((f) => `pipelines/${f}`) : [];
  assert.ok(ymls.length >= 5, `pipelines de Azure: ${ymls.join(', ')}`);
  const prefixes = c4Folders().map((e) => `${e.old}/`);
  const problems = [];
  for (const y of ymls) {
    const abs = path.join(RAIZ, y);
    if (py.status === 0) {
      const p = spawnSync('python3', ['-c', 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))', abs], { encoding: 'utf8' });
      if (p.status !== 0) problems.push(`${y}: no parsea (${p.stderr.trim().split('\n').pop()})`);
    }
    const text = fs.readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/(?<![\w./-])scripts\/[\w./-]+\.(?:js|sh|py|ps1|json)(?![\w-])/g)) {
      if (!fs.existsSync(path.join(RAIZ, m[0]))) problems.push(`${y}: ${m[0]} no existe`);
      else if (prefixes.some((pf) => m[0].startsWith(pf))) problems.push(`${y}: ${m[0]} es una ruta mudada (usa la nueva)`);
    }
  }
  assert.deepStrictEqual(problems, []);
});
