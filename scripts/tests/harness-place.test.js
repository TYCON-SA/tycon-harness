'use strict';
/**
 * harness-place.test.js — el nombre del lugar del arnés, definido UNA vez, y sus copias declaradas.
 *
 * Quien clona el repo público no debe leer después, en `~/.claude/`, el nombre del repo interno. El lugar
 * se llama como el repo público y el nombre viejo sigue resolviendo. Con el nombre definido varias veces y escrito a
 * mano en otros lugares, cada copia escrita a mano es una que se puede desfasar en silencio: por eso se define UNA vez
 * y las copias se declaran.
 *
 * Qué fija:
 *   T1  los identificadores nuevos en inglés, los dos frenos de nombres en 0 sobre la rama, y el nombre del repo
 *       público sin escribir como nombre de repo;
 *   T3  una sola definición: place.js sin dependencias, los archivos que toman el nombre de place.js sin la ruta del lugar escrita a mano, y
 *       samePath como el sistema (sin mayúsculas ni barra final en Windows; distinto en Linux);
 *   T4  cada copia declarada nombra los dos nombres de la constante; una copia desfasada y una no declarada hacen fallar;
 *       un envoltorio cae en `generated` por su marca;
 *   T13 los reconocedores conocen los dos nombres como SEGMENTO de ruta (el temporal `<lugar>-report-x` no es el
 *       arnés); lo que nombra sólo el viejo está declarado con su motivo;
 *   T14 Windows por construcción: en el archivo entero de cada copia declarada y de los dos aplicadores no hay
 *       operadores de enlace de shell; ningún borrado recursivo sobre un nombre; el comando que propone
 *       instinct-draft.js en Windows es la ruta absoluta con `/`, sin `$`.
 * 🔴 Nada toca el HOME real: lo que arma carpetas lo hace en el temporal.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PLACE = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js'));
const LIST_FILE = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'harness-place-names.json');
const LIST = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// La copia pública no trae public-repos.json ni las pruebas y papeles que no se publican: lo declarado que no está, ahí no
// se mide (y se dice una vez por prueba); en el repo interno, todo lo declarado tiene que estar.
const IN_COPY = !fs.existsSync(path.join(ROOT, 'scripts', 'publishing', 'public-repos.json'));
const here = (rel) => fs.existsSync(path.join(ROOT, rel));
function shipped(entries, label) {
  const missing = entries.filter((e) => !here(e.path || e));
  if (missing.length && !IN_COPY) assert.deepStrictEqual(missing, [], `${label}: declarado y no está en el repo`);
  if (missing.length) console.log(`⏭ ${label}: NO MEDIDO en la copia — ${missing.length} declarado(s) que no se publican`);
  return entries.filter((e) => here(e.path || e));
}

/** El código sin los comentarios de línea entera (`#`, `//`, `*`, `/*`) ni los `// …` del final de una línea. */
function codeOnly(text) {
  return text.split("\n").filter((l) => !/^\s*(#|\/\/|\*(?:\s|\/|$)|\/\*)/.test(l)).map((l) => {
    const i = l.indexOf(' //');
    if (i < 0) return l;
    const before = l.slice(0, i);
    const quotes = (before.match(/'/g) || []).length + (before.match(/"/g) || []).length + (before.match(/`/g) || []).length;
    return quotes % 2 === 0 ? before : l;
  }).join('\n');
}

/**
 * Los nombres del lugar que un archivo DEFINE o USA como lugar: constantes `PLACE_NAME`/`LEGACY_PLACE_NAME`, rutas
 * `.claude/<nombre>` (con `/`, `\` o `\\`), `path.join(…'.claude', '<nombre>'…)`, y las listas de los dos nombres de los
 * lectores en shell (`for x in A B; do`) y en PowerShell (`@('A', 'B')`).
 */
function placeNamesIn(text) {
  const code = codeOnly(text);
  const names = new Set();
  const add = (re) => { let m; re.lastIndex = 0; while ((m = re.exec(code))) for (const g of m.slice(1)) if (g) names.add(g); };
  add(/\b(?:LEGACY_)?PLACE_NAME\s*=\s*['"`]([^'"`]+)['"`]/g);
  add(/\.claude(?:\/|\\\\|\\)(tycon-[A-Za-z0-9-]+)/g);
  add(/['"]\.claude['"],\s*['"](tycon-[A-Za-z0-9-]+)['"]/g);
  add(/\bfor\s+\w+\s+in\s+(tycon-[A-Za-z0-9-]+)\s+(tycon-[A-Za-z0-9-]+)\s*;\s*do/g);
  add(/@\(\s*'(tycon-[A-Za-z0-9-]+)'\s*,\s*'(tycon-[A-Za-z0-9-]+)'\s*\)/g);
  return names;
}
/** ¿El archivo es una copia que nombra los dos nombres tal como los define la constante? Devuelve los problemas. */
function copyProblems(text) {
  const names = placeNamesIn(text);
  const problems = [];
  for (const n of names) if (n !== PLACE.PLACE_NAME && n !== PLACE.LEGACY_PLACE_NAME) problems.push(`nombra «${n}», que no es ninguno de los dos de la constante`);
  for (const n of [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME]) if (!names.has(n)) problems.push(`no nombra «${n}»`);
  return problems;
}

const isShimText = (text) => text.split('\n').slice(0, 3).some((l) => l.includes(LIST.generated[0].mark));
/** Los archivos de código que corren (sin pruebas, documentos ni historia), relativos a la raíz. */
function codeFiles(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ls-files: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean)
    .filter((f) => !/\.(md|json|ya?ml|html|txt|toml|tsv|csv|png|svg)$/.test(f))
    .filter((f) => !/^(specs|tasks|inbox|instincts|\.advisors|\.engram|\.dashboard|guides|onboarding|artifacts|adapters|claude-md-blocks)\//.test(f))
    .filter((f) => !/(^|\/)tests?\//.test(f) && !/\.test\./.test(f))
    .filter((f) => fs.existsSync(path.join(root, f)));
}
/**
 * Las copias que la lista no declara: código que escribe el nombre nuevo a mano, o que DEFINE el viejo como constante.
 * (Un mensaje o una ruta que todavía nombra el lugar por el viejo no es una copia de la constante: es texto, y lo cubre el
 * barrido por expresión —T38—.)
 */
function undeclaredCopies(root, files) {
  const declared = new Set([
    'scripts/setup/harness/place.js',
    'scripts/setup/harness/tycon-home.js',
    ...LIST.literal_copies.map((e) => e.path),
    ...LIST.recognizers.map((e) => e.path),
    ...LIST.legacy_only.map((e) => e.path),
    ...LIST.other_uses.map((e) => e.path),
    ...(LIST.place_text || []).map((e) => e.path),
  ]);
  const out = [];
  for (const f of files) {
    if (declared.has(f)) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch (_) { continue; }
    if (text.includes('\0') || isShimText(text)) continue;
    const code = codeOnly(text);
    const legacyConst = new RegExp(`\\b(?:const|let|var)\\s+\\w+\\s*=\\s*['"\`]${PLACE.LEGACY_PLACE_NAME}['"\`]`);
    if (code.includes(PLACE.PLACE_NAME) || legacyConst.test(code)) out.push(f);
  }
  return out;
}

// ── T1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T1 PlaceNames_EnglishIdentifiers_NoRealNames_PublicRepoNameUnwritten', () => {
  // los nombres que la máquina ejecuta, en inglés
  assert.deepStrictEqual(Object.keys(PLACE).sort(), ['LEGACY_PLACE_NAME', 'PLACE_NAME', 'isHarnessClone', 'legacyPlacePath', 'placePath', 'resolvePlace', 'samePath']);
  for (const k of ['literal_copies', 'recognizers', 'legacy_only', 'other_uses', 'place_text', 'generated']) assert.ok(Array.isArray(LIST[k]), `harness-place-names.json: falta la sección ${k}`);
  // el nombre del repo público no se escribe como nombre de repo (los papeles usan {{public-org}}/{{public-repo}})
  // public-repos.json no viaja a la copia pública (allowlist.json): ahí esta parte no se puede medir, y se dice
  const pubFile = path.join(ROOT, 'scripts', 'publishing', 'public-repos.json');
  const pub = fs.existsSync(pubFile) ? JSON.parse(fs.readFileSync(pubFile, 'utf8')) : null;
  if (!pub) console.log('⏭ T1: NO MEDIDO — el nombre del repo público sin escribir (no hay scripts/publishing/public-repos.json: la copia pública)');
  const asRepo = pub ? [`${pub.org}/${pub.repo}`, `github.com/${pub.org}`] : [];
  const mine = ['scripts/setup/harness/place.js', 'scripts/tests/fixtures/harness-place-names.json', 'scripts/tests/harness-place.test.js',
    'scripts/tests/harness-place-operations.test.js', ...LIST.literal_copies.map((e) => e.path), ...LIST.recognizers.map((e) => e.path)];
  for (const f of new Set(mine)) for (const s of asRepo) assert.ok(!read(f).includes(s), `${f} escribe el nombre del repo público como repo («${s}»)`);
  // los dos frenos de nombres sobre la rama (con origin/main a mano; sin él —un clon superficial—, NO MEDIDO)
  // 🔴 En un árbol armado —el repo privado con el público encima, como lo arma la validación de sus pedidos— la punta
  // es el commit local de esa superposición. Medido desde ahí, todo el público cuenta como «nuevo» y los frenos marcan
  // nombres que ya existían; medido hasta el commit anterior, el privado adelgazado
  // no trae la lista de palabras y el freno no puede mirar. Ahí este caso no mide los frenos sobre la rama, y lo dice.
  const tipSubject = spawnSync('git', ['-C', ROOT, 'log', '-1', '--format=%s', 'HEAD'], { encoding: 'utf8' });
  if (tipSubject.status === 0 && tipSubject.stdout.includes('[superposición local, no se empuja]')) {
    console.log('⏭ T1: NO MEDIDO — los frenos de nombres sobre la rama (árbol armado: la punta es la superposición del público)');
    return;
  }
  const base = spawnSync('git', ['-C', ROOT, 'merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' });
  const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (base.status !== 0 || base.stdout.trim() === head.stdout.trim()) {
    console.log('⏭ T1: NO MEDIDO — los frenos de nombres sobre la rama (sin origin/main, o la rama no tiene commits propios)');
    return;
  }
  for (const tool of ['spanish-names.js', 'new-names.js']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'publishing', tool), '--range', `${base.stdout.trim()}...HEAD`], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${tool} --range frena:\n${r.stdout}${r.stderr}`);
  }
});

// ── T3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// los archivos que toman el nombre de place.js
const AC3_FILES = ['scripts/lib/canonical-path.js', 'scripts/setup/harness.js', 'scripts/setup/harness/repoint.js', 'scripts/setup/harness/remove.js',
  'scripts/setup/harness/shared.js', 'scripts/setup/harness/snapshot.js', 'scripts/setup/harness/channel.js', 'scripts/setup/harness/report.js',
  'scripts/instincts/instinct-draft.js', 'scripts/publishing/export.js', 'scripts/publishing/profile-equivalence.js'];
test('T3 PlaceConstant_SingleDefinition_SamePathWin32', () => {
  // los dos nombres y sus rutas se definen en tycon-home.js (la raíz de todas las rutas del arnés, sin
  // dependencias); place.js es su fachada y no carga nada más
  const requiresOf = (rel) => [...read(rel).matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(requiresOf('scripts/setup/harness/place.js'), ['./tycon-home.js', 'path'], 'place.js carga algo más que tycon-home.js y path');
  assert.deepStrictEqual([...new Set(requiresOf('scripts/setup/harness/tycon-home.js'))], ['fs', 'os', 'path'], 'tycon-home.js sólo carga módulos de Node');
  const defined = ['scripts/setup/harness/place.js', 'scripts/setup/harness/tycon-home.js'].filter((f) => /\bPLACE_NAME\s*=\s*['"`]/.test(codeOnly(read(f))));
  assert.deepStrictEqual(defined, ['scripts/setup/harness/tycon-home.js'], 'los nombres del lugar se definen en tycon-home.js, una vez');
  // el lugar se llama como el repo público; sin public-repos.json (la copia), sólo que hay nombre
  const publicFile = path.join(ROOT, 'scripts', 'publishing', 'public-repos.json');
  if (fs.existsSync(publicFile)) assert.strictEqual(PLACE.PLACE_NAME, JSON.parse(fs.readFileSync(publicFile, 'utf8')).repo, 'el lugar no se llama como el repo público');
  else assert.ok(/^[A-Za-z0-9._-]+$/.test(PLACE.PLACE_NAME));
  assert.strictEqual(PLACE.LEGACY_PLACE_NAME, 'tycon-claude-guides');
  const legacyPath = new RegExp(`\\.claude(?:/|\\\\\\\\|\\\\)${PLACE.LEGACY_PLACE_NAME}|['"]\\.claude['"],\\s*['"]${PLACE.LEGACY_PLACE_NAME}['"]`);
  for (const f of AC3_FILES) {
    const code = codeOnly(read(f));
    assert.ok(!legacyPath.test(code), `${f}: escribe la ruta del lugar con el nombre viejo, fuera de los comentarios`);
    assert.ok(!code.includes(`'${PLACE.PLACE_NAME}'`) && !code.includes(`"${PLACE.PLACE_NAME}"`) && !code.includes(`/${PLACE.PLACE_NAME}/`),
      `${f}: escribe el nombre nuevo a mano, fuera de los comentarios`);
    assert.ok(/require\([^)]*place\.js['"]\)/.test(code), `${f}: no toma el nombre de place.js`);
  }
  // los otros usos de la palabra siguen donde estaban, declarados (other_uses)
  assert.ok(read('scripts/setup/harness/sources.js').includes(`'${PLACE.PLACE_NAME}'`), 'el stash de sources.js sigue');
  assert.ok(read('scripts/setup/harness/health.js').includes(`'${PLACE.PLACE_NAME}-health'`), 'el id de sesión de health.js sigue');
  // samePath: como el sistema
  assert.strictEqual(PLACE.samePath('C:\\Users\\X\\a', 'c:/users/x/a/', 'win32'), true);
  assert.strictEqual(PLACE.samePath('C:\\Users\\X\\a', 'c:/users/x/a/', 'linux'), false);
  assert.strictEqual(PLACE.samePath('/home/x/a/', '/home/x/a', 'linux'), true);
  assert.strictEqual(PLACE.samePath('/home/x/A', '/home/x/a', 'linux'), false);
  assert.strictEqual(PLACE.samePath('C:\\', 'c:/', 'win32'), true);
  assert.strictEqual(PLACE.samePath(null, '/a'), false);
});

// ── T4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T4 PlaceNames_LiteralCopies_MatchConstant_DriftFails_GeneratedByMark', () => {
  for (const e of shipped(LIST.literal_copies, 'T4')) {
    assert.ok(e.why && e.why.length > 10, `${e.path}: sin motivo`);
    assert.deepStrictEqual(copyProblems(read(e.path)), [], `${e.path}: la copia se desfasó de place.js`);
  }
  // sembradas: una copia con un nombre cambiado falla; una copia no declarada aparece
  const drift = read('scripts/lib/tycon-config.js').replace(`PLACE_NAME = '${PLACE.PLACE_NAME}'`, `PLACE_NAME = '${PLACE.PLACE_NAME}s'`);
  assert.notDeepStrictEqual(copyProblems(drift), [], 'una copia con el nombre cambiado tiene que fallar');
  const shellDrift = read('scripts/hooks/git-pre-commit-global.sh').replace(`in ${PLACE.PLACE_NAME} ${PLACE.LEGACY_PLACE_NAME}; do`, `in ${PLACE.PLACE_NAME}-x ${PLACE.LEGACY_PLACE_NAME}; do`);
  assert.notDeepStrictEqual(copyProblems(shellDrift), [], 'la lista de los lectores en shell, cambiada, tiene que fallar');
  // la realidad: ninguna copia sin declarar en el árbol
  assert.deepStrictEqual(undeclaredCopies(ROOT, codeFiles(ROOT)), [], 'copias de los nombres del lugar que harness-place-names.json no declara');
  // y una sembrada en un repo de juguete aparece
  const t = tmp('harness-place-t4-');
  spawnSync('git', ['init', '-q', t]);
  fs.mkdirSync(path.join(t, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(t, 'scripts', 'lib', 'other.js'), `const LINK = '${PLACE.LEGACY_PLACE_NAME}';\n`);
  fs.writeFileSync(path.join(t, 'scripts', 'lib', 'new-one.js'), `const N = '${PLACE.PLACE_NAME}';\n`);
  fs.writeFileSync(path.join(t, 'scripts', 'lib', 'shim.js'), `#!/usr/bin/env node\n// ${LIST.generated[0].mark} scripts/lib/x.js\nconst p = '.claude/${PLACE.PLACE_NAME}';\n`);
  assert.deepStrictEqual(undeclaredCopies(t, codeFiles(t)).sort(), ['scripts/lib/new-one.js', 'scripts/lib/other.js'], 'la sembrada no aparece, o el envoltorio no cae en generated');
  fs.rmSync(t, { recursive: true, force: true });
  // los envoltorios versionados llevan su marca y nombran sólo el lugar
  const shims = spawnSync('git', ['-C', ROOT, 'grep', '-l', '-I', LIST.generated[0].mark], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    .filter((f) => isShimText(read(f)));
  // la copia pública no trae el mapa de renombres ni los envoltorios: ahí esa parte no se mide, y se dice
  if (fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'renames.json'))) assert.ok(shims.length > 50, `pocos envoltorios encontrados por su marca: ${shims.length}`);
  else console.log(`⏭ T4: NO MEDIDO — los envoltorios (no hay scripts/lib/renames.json: la copia pública; ${shims.length} encontrados)`);
  for (const f of shims) assert.ok(!placeNamesIn(read(f)).has(PLACE.LEGACY_PLACE_NAME), `${f}: el envoltorio nombra el viejo (regenerar con legacy-names.js --write-shims)`);
});

// ── T13 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T13 Recognizers_BothNamesAsSegments_LegacyOnlyDeclared', () => {
  const home = tmp('harness-place-t13-');
  const at = (name, ...rest) => path.join(home, 'Proyectos', name, ...rest);
  const placeHook = `node "${path.join(home, '.claude', PLACE.PLACE_NAME, 'scripts', 'hooks', 'x.js')}"`;
  const legacyHook = `node "${path.join(home, '.claude', PLACE.LEGACY_PLACE_NAME, 'scripts', 'hooks', 'x.js')}"`;
  const tempHook = `node "${path.join(os.tmpdir(), `${PLACE.PLACE_NAME}-report-x`, 'scripts', 'hooks', 'x.js')}"`;
  // profile-equivalence: un hook del arnés por cualquiera de los dos nombres; el temporal no
  const pe = require(path.join(ROOT, 'scripts', 'publishing', 'profile-equivalence.js'));
  assert.strictEqual(pe.isHarnessHook(placeHook), true, 'profile-equivalence: el lugar');
  assert.strictEqual(pe.isHarnessHook(legacyHook), true, 'profile-equivalence: el viejo');
  assert.strictEqual(pe.isHarnessHook(tempHook), false, 'profile-equivalence: el temporal no es el arnés');
  // harness-repo: la carpeta del clon por su nombre (respaldo sin origin)
  const hr = require(path.join(ROOT, 'scripts', 'lib', 'harness-repo.js'));
  assert.strictEqual(hr.porNombreDeCarpeta(at(PLACE.PLACE_NAME, 'a.js')), true, 'harness-repo: el nombre público');
  assert.strictEqual(hr.porNombreDeCarpeta(at(PLACE.LEGACY_PLACE_NAME, 'a.js')), true, 'harness-repo: el nombre interno');
  assert.strictEqual(hr.porNombreDeCarpeta(at(`${PLACE.PLACE_NAME}-report-x`, 'a.js')), false, 'harness-repo: un segmento que sólo empieza igual no es el arnés');
  // story-gate (skills): el mismo respaldo
  const sg = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-gate.js'));
  for (const n of [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME]) assert.ok(sg.HARNESS_REPO_SEGMENTS.has(n), `story-gate: falta ${n}`);
  assert.ok(!sg.HARNESS_REPO_SEGMENTS.has(`${PLACE.PLACE_NAME}-report-x`));
  // changes.js: las rutas del arnés en el tablero, por cualquiera de los dos nombres
  const ch = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'changes.js'));
  assert.strictEqual(ch.relativa(`/x/y/${PLACE.PLACE_NAME}/scripts/a.js`, '/otro/repo'), `${PLACE.PLACE_NAME}/scripts/a.js`);
  assert.strictEqual(ch.relativa(`/x/y/${PLACE.LEGACY_PLACE_NAME}/scripts/a.js`, '/otro/repo'), `${PLACE.LEGACY_PLACE_NAME}/scripts/a.js`);
  // remove.js: las raíces de los hooks incluyen los dos nombres
  const roots = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'remove.js')).hookRoots(home, path.join(home, 'clon'));
  for (const n of [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME]) assert.ok(roots.some((r) => r.endsWith(`/.claude/${n}`)), `remove.js hookRoots: falta ${n}`);
  // legacy-names.js: las formas de la raíz suman los dos enlaces si apuntan a ella
  const ln = require(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'));
  const clone = path.join(home, 'clon'); fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.mkdirSync(clone);
  fs.symlinkSync(clone, PLACE.placePath(home), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(PLACE.placePath(home), PLACE.legacyPlacePath(home), process.platform === 'win32' ? 'junction' : 'dir');
  const forms = ln.repoForms(clone, 'arnes', home);
  assert.ok(forms.includes(`~/.claude/${PLACE.PLACE_NAME}`) && forms.includes(`~/.claude/${PLACE.LEGACY_PLACE_NAME}`), `legacy-names repoForms: ${forms.join(' · ')}`);
  // export.js: un comando que corre un script del arnés por cualquiera de los dos nombres; `<arnés>/` va al lugar
  const src = read('scripts/publishing/export.js');
  assert.match(src, /function PREFIJOS_COMANDO\(\)/);
  // los que no se pueden llamar (un guion y dos hooks): los dos nombres como segmento, nunca como subcadena
  const ws = read('scripts/tools/tycon-worktree.sh');
  for (const n of [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME]) assert.ok(ws.includes(`*"/${n}"|*"/${n}/"*`), `tycon-worktree.sh: ${n} como segmento`);
  for (const f of ['skills/tycon-ado-story-wi/scripts/on-story-create.js', 'skills/tycon-story-followup-link/scripts/on-story-create.js']) {
    const code = codeOnly(read(f));
    assert.ok(!/filePath\.includes\('tycon-/.test(code), `${f}: reconoce por subcadena`);
    const rx = /if \((\/.+\/)\.test\(filePath\)\) process\.exit\(0\);/.exec(code);
    assert.ok(rx, `${f}: sin la expresión del salteo`);
    const re = eval(rx[1]);   // eslint-disable-line no-eval — la expresión del propio archivo
    assert.ok(re.test(`/a/${PLACE.PLACE_NAME}/specs/s.md`) && re.test(`/a/${PLACE.LEGACY_PLACE_NAME}/specs/s.md`) && !re.test(`/a/${PLACE.PLACE_NAME}-report-x/s.md`), `${f}: la expresión`);
  }
  const scg = read('scripts/hooks/session-collision-guard.js');
  assert.ok(scg.includes(`(${PLACE.LEGACY_PLACE_NAME}|${PLACE.PLACE_NAME}|agent-skills)$`), 'session-collision-guard: los dos nombres, como segmento');
  assert.ok(read('skills/tycon-pipeline/scripts/package-equivalence.js').includes(`'${PLACE.LEGACY_PLACE_NAME}', '${PLACE.PLACE_NAME}'`), 'package-equivalence: los dos nombres');
  // cada reconocedor declarado nombra los dos (por import o escritos)
  for (const e of shipped(LIST.recognizers, 'T13')) {
    const code = codeOnly(read(e.path));
    const both = e.imports ? (/place\.js/.test(code) && /PLACE_NAME|legacyPlacePath/.test(code)) : (code.includes(PLACE.PLACE_NAME) && code.includes(PLACE.LEGACY_PLACE_NAME));
    assert.ok(both, `${e.path} (${e.member}): no nombra los dos nombres (${e.imports ? 'por place.js' : 'escritos'})`);
  }
  // lo que nombra sólo el viejo, a propósito: con motivo, y sin el nombre nuevo
  for (const e of shipped(LIST.legacy_only, 'T13')) {
    assert.ok(e.why && e.why.length > 10, `${e.path}: sin motivo`);
    if (IN_COPY && e.lines) continue;   // sus líneas pueden ir entre las marcas de sólo interno, que la copia saca
    const code = codeOnly(read(e.path));
    assert.ok(code.includes(PLACE.LEGACY_PLACE_NAME), `${e.path}: ya no nombra el viejo; sacalo de legacy_only`);
  }
  for (const f of ['scripts/setup/harness/startup-line.js', 'scripts/hooks/harness-bootstrap-heal.sh']) {
    assert.ok(!codeOnly(read(f)).includes(PLACE.PLACE_NAME), `${f}: reconoce lo viejo de las máquinas; no lleva el nombre nuevo`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

// ── T14 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que NO es una operación sobre los nombres del lugar y usa un operador de enlace a propósito, con su motivo (la prueba
// barre el archivo entero; estas líneas son de otra cosa y sacarlas rompería lo suyo).
const OPERATOR_EXCEPTIONS = [
  { path: 'scripts/production/install-guard.sh', line: 'while [ -L "$p" ] && [ $n -lt 20 ]; do', why: 'real_de: sigue los enlaces del BINARIO de node que se copia a /opt, sin programas del usuario (corre con sudo, sólo en macOS)' },
  { path: 'scripts/production/install-guard.sh', line: 'local t; t="$(readlink "$p")"', why: 'real_de: ídem' },
  { path: 'scripts/production/install-guard.sh', line: 'if mode == "120000": data = os.readlink(p).encode("utf-8")', why: 'Python dentro del .sh (story 8.23, tanda D · AC 30): el verificador de la versión bajada recalcula el árbol de git desde el disco, y un enlace que el manifiesto trae con modo 120000 se hashea por su destino, como hace git; no es el lugar' },
  { path: 'scripts/install-tycon-hooks.sh', line: '[[ -d "$repo/.git" && -f "$repo/CLAUDE.md" && ! -e "$repo/AGENTS.md" && ! -L "$repo/AGENTS.md" ]] || continue', why: 'el puntero AGENTS.md no se escribe por un enlace roto (ronda adversarial 2026-08-23): no es un nombre del lugar' },
  { path: 'scripts/install-tycon-hooks.sh', line: 'if os.path.islink(p) and os.readlink(p).startswith(skills.rstrip("/") + "/"):', why: 'Python dentro del .sh: las skills enlazadas de Codex, no el lugar' },
  { path: 'scripts/install-tycon-hooks.sh', line: 'to = os.readlink(dst)', why: 'Python dentro del .sh (el plan de la 8.16): las skills enlazadas de Codex, no el lugar' },
  { path: 'scripts/install-tycon-hooks.sh', line: 'if os.path.islink(p) and os.readlink(p).startswith(skills + "/") and not os.path.exists(os.readlink(p)):', why: 'ídem: las skills de Codex que quedaron colgadas, no el lugar' },
];
const LINK_OPERATORS = [/\bln\s+-s/, /\[\[?\s*!?\s*-L\b/, /\btest\s+-L\b/, /\breadlink\b/, /\bmklink\b/i, /New-Item\b[^\n]*-ItemType\s+(?:Junction|SymbolicLink)/i];
test('T14 LinkOps_NodeOnly_WholeFileOperators_NoRecursiveRemoval_NoNewDollar', () => {
  // (las copias que no viajan en la copia pública —la plantilla del hook de un paquete del equipo— se miden donde están)
  const files = [...shipped(LIST.literal_copies, 'T14').map((e) => e.path), 'scripts/install-tycon-hooks.sh', 'scripts/install-tycon-hooks.ps1'];
  for (const f of files) {
    if (/\.js$/.test(f)) continue;   // en JavaScript la operación ES Node (fs.symlinkSync/readlinkSync): lo que pide el AC
    read(f).split('\n').forEach((l, i) => {
      if (/^\s*#/.test(l)) return;
      if (!LINK_OPERATORS.some((re) => re.test(l))) return;
      const ok = OPERATOR_EXCEPTIONS.some((x) => x.path === f && l.trim() === x.line);
      assert.ok(ok, `${f}:${i + 1}: un operador de enlace de shell (en Windows no anda igual; va por Node): ${l.trim()}`);
    });
  }
  for (const x of OPERATOR_EXCEPTIONS) assert.ok(read(x.path).split('\n').some((l) => l.trim() === x.line), `excepción que ya no está (sacala de la lista): ${x.path}: ${x.line}`);
  // un nombre se borra con unlink o rmdir, nunca recursivo: el creador y sus ayudantes
  const cp = read('scripts/lib/canonical-path.js');
  const body = (name) => { const i = cp.indexOf(`function ${name}(`); assert.ok(i >= 0, `falta ${name}`); return cp.slice(i, cp.indexOf('\n}\n', i)); };
  for (const fn of ['removeName', 'pointName', 'ensurePlace', 'placePlan', 'takePlaceLock', 'releasePlaceLock']) {
    assert.ok(!/rmSync|recursive:\s*true\s*,\s*force|rimraf/.test(body(fn).replace(/mkdirSync\([^)]*\)/g, '')), `${fn}: un borrado recursivo`);
  }
  assert.match(body('removeName'), /unlinkSync[\s\S]*rmdirSync/);
  // el borrado de una pieza `link` en uninstall, también: unlink/rmdir, nunca recursivo
  const rm = read('scripts/setup/harness/remove.js');
  const i = rm.indexOf('const rmName = '); assert.ok(i >= 0, 'remove.js: falta rmName');
  const rmBody = rm.slice(i, rm.indexOf('\n  };\n', i));
  assert.ok(/unlinkSync[\s\S]*rmdirSync/.test(rmBody) && !/rmSync|recursive/.test(rmBody), `remove.js rmName: ${rmBody}`);
  assert.match(rm.slice(rm.indexOf("case 'link': {"), rm.indexOf("case 'command': {")), /rmName\(piece, piece\.where\)/, 'remove.js: la pieza link no se borra con rmName');
  // el comando que propone instinct-draft.js: en Windows la ruta absoluta con `/` y sin `$`
  const draft = require(path.join(ROOT, 'scripts', 'instincts', 'instinct-draft.js'));
  const win = draft.hookCommand('x.sh', { platform: 'win32', home: 'C:\\Users\\Lab' });
  assert.strictEqual(win, `C:/Users/Lab/.claude/${PLACE.PLACE_NAME}/scripts/hooks/x.sh`);
  assert.ok(!win.includes('$') && !win.includes('\\'));
  assert.strictEqual(draft.hookCommand('x.sh', { platform: 'darwin' }), `$HOME/.claude/${PLACE.PLACE_NAME}/scripts/hooks/x.sh`, 'en Mac y Linux el comando sigue como estaba (el `$HOME` ya estaba)');
});

// ═══ La ruta del lugar en los textos ═════════════════════════════════════════════════════════
// La ruta del lugar con el nombre viejo, en cualquier forma: `~/.claude/<viejo>` con `/`, `\` o `\\`, y
// `path.join(…, '.claude', '<viejo>')`. El repo o la carpeta del clon (`SourceCode/<viejo>`, `_git/<viejo>`, el
// `project:` de engram) no es la ruta del lugar y no cuenta.
const LEGACY_PATH_RX = new RegExp(`\\.claude[/\\\\]+${PLACE.LEGACY_PLACE_NAME}(?![A-Za-z0-9_-])|['"]\\.claude['"],\\s*['"]${PLACE.LEGACY_PLACE_NAME}['"]`);
const PLACE_PATH_RX = new RegExp(`\\.claude[/\\\\]+${PLACE.PLACE_NAME}(?![A-Za-z0-9_-])`);
// El alcance del barrido, por expresión: lo versionado menos la historia.
const HISTORY_RX = /^(specs|tasks|inbox|instincts|\.advisors|\.engram|\.dashboard)\/|^guides\/((maintaining\/)?incident-log\.md|decisions\/|codex-migration\.md)|^scripts\/tests\/fixtures\/startup-lines\.json$/;
function sweepScope(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ls-files: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean).filter((f) => !HISTORY_RX.test(f)).filter((f) => fs.existsSync(path.join(root, f)));
}
/** Las líneas de un texto que escriben la ruta del lugar con el nombre viejo. */
const legacyPathLines = (text) => text.split('\n').filter((l) => LEGACY_PATH_RX.test(l));
/** Lo que el barrido deja nombrar la ruta vieja: la constante, las copias, los reconocedores, lo declarado y lo generado. */
function sweepAllowed() {
  // la constante y la lista que declara (ésta escribe las líneas declaradas, con la ruta vieja adentro)
  const byFile = new Map([['scripts/setup/harness/place.js', null], ['scripts/tests/fixtures/harness-place-names.json', null]]);
  for (const e of [...LIST.literal_copies, ...LIST.recognizers]) byFile.set(e.path, null);
  for (const e of LIST.legacy_only) byFile.set(e.path, e.lines || null);
  return byFile;
}
/** Las apariciones de la ruta vieja que el barrido no deja: [archivo, línea]. */
function sweepOffenders(root, files) {
  const allowed = sweepAllowed();
  const out = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch (_) { continue; }
    if (text.includes('\0') || isShimText(text)) continue;
    const lines = legacyPathLines(text);
    if (!lines.length) continue;
    if (allowed.has(f)) {
      const only = allowed.get(f);
      if (!only) continue;
      for (const l of lines) if (!only.some((s) => l.includes(s))) out.push(`${f}: ${l.trim().slice(0, 160)}`);
      continue;
    }
    for (const l of lines) out.push(`${f}: ${l.trim().slice(0, 160)}`);
  }
  return out;
}
/** Las líneas de un .md que quedan DENTRO de un bloque `tycon:internal-start` … `internal-end`. */
function insideInternal(text) {
  const start = '<!-- tycon:' + 'internal-start -->'; const end = '<!-- tycon:' + 'internal-end -->';
  let inside = false; const out = [];
  for (const l of text.split('\n')) {
    if (l.trim() === start) { inside = true; continue; }
    if (l.trim() === end) { inside = false; continue; }
    out.push(inside);
  }
  return out;
}

// ── T35 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TEAM_PAPERS = ['INSTALL.md', 'onboarding/new-dev-harness-setup.md', 'onboarding/step-0-mac.md', 'onboarding/step-0-windows.md',
  'guides/piezas-del-arnes.md', 'claude-md-blocks/names/tool-names.codex.md', 'commands/tycon-instincts.md'];
const NAMES_THE_PLACE = ['INSTALL.md', 'onboarding/new-dev-harness-setup.md', 'guides/piezas-del-arnes.md', 'claude-md-blocks/names/tool-names.codex.md', 'commands/tycon-instincts.md'];
test('T35 TeamPapers_PlacePath_OldStartupDeclared_TwoNamesParagraphInternal', () => {
  // la verificación del import en los papeles del equipo: una máquina nueva escribe
  // `@~/.claude/<lugar>/README.md`, así que todo chequeo de CLAUDE.md que busca el import por el nombre viejo tiene que
  // aceptar también el lugar. 🔴 Si el alta contara sólo `<viejo>/README.md`, esperaría 1 y una máquina nueva da 0.
  for (const f of shipped(TEAM_PAPERS, 'T35 (import)')) {
    const oneName = read(f).split('\n').filter((l) => l.includes('CLAUDE.md') && l.includes(PLACE.LEGACY_PLACE_NAME) && !l.includes(PLACE.PLACE_NAME) && !LEGACY_PATH_RX.test(l));
    assert.deepStrictEqual(oneName, [], `${f}: un chequeo del import en CLAUDE.md que sólo acepta el nombre viejo`);
  }
  const declared = LIST.legacy_only.find((e) => e.path === 'INSTALL.md');
  assert.ok(declared && Array.isArray(declared.lines) && declared.why, 'INSTALL.md: las líneas viejas declaradas en legacy_only, con motivo');
  for (const f of shipped(TEAM_PAPERS, 'T35')) {
    const text = read(f);
    const only = f === 'INSTALL.md' ? declared.lines : [];
    const bad = legacyPathLines(text).filter((l) => !only.some((s) => l.includes(s)));
    assert.deepStrictEqual(bad, [], `${f}: nombra la ruta del lugar por el nombre viejo`);
    if (NAMES_THE_PLACE.includes(f)) assert.ok(PLACE_PATH_RX.test(text), `${f}: no nombra el lugar`);
  }
  // en la copia el párrafo interno ya salió por sus marcas: lo de abajo se mide en el repo interno
  if (IN_COPY) { console.log('⏭ T35: NO MEDIDO en la copia — el párrafo de los dos nombres y las líneas declaradas (salen por las marcas)'); return; }
  // cada línea declarada sigue estando (si no, sacala de la lista)
  const install = read('INSTALL.md');
  for (const s of declared.lines) assert.ok(install.includes(s), `INSTALL.md: la línea declarada ya no está: ${s}`);
  // el párrafo de los dos nombres: adentro de las marcas de sólo interno, con los dos nombres y relocate
  const lines = install.split('\n'); const inside = insideInternal(install);
  const marks = ['<!-- tycon:' + 'internal-start -->', '<!-- tycon:' + 'internal-end -->'];   // armadas por partes: no son marcadores
  const content = lines.filter((l) => !marks.includes(l.trim()));
  const at = content.findIndex((l) => l.includes('harness.js relocate'));
  assert.ok(at >= 0, 'INSTALL.md: falta el párrafo de los dos nombres (harness.js relocate)');
  assert.strictEqual(inside[at], true, 'INSTALL.md: el párrafo de los dos nombres está fuera de las marcas de sólo interno');
  let a = at; while (a > 0 && content[a - 1].trim()) a -= 1;
  let b = at; while (b < content.length - 1 && content[b + 1].trim()) b += 1;
  const para = content.slice(a, b + 1).join(' ');
  assert.ok(PLACE_PATH_RX.test(para) && LEGACY_PATH_RX.test(para), `INSTALL.md: el párrafo no nombra los dos: ${para}`);
  // la copia que arma public-copy.js: sin el párrafo y sin la ruta vieja
  const { internalBlocks } = require(path.join(ROOT, 'scripts', 'publishing', 'public-copy.js'));
  const pub = internalBlocks(install, 'INSTALL.md');
  assert.deepStrictEqual(pub.errors, [], 'INSTALL.md: marcas mal puestas');
  assert.ok(!pub.text.includes('harness.js relocate'), 'la copia pública de INSTALL.md trae el párrafo de los dos nombres');
  assert.deepStrictEqual(legacyPathLines(pub.text), [], 'la copia pública de INSTALL.md nombra la ruta vieja');
  assert.ok(PLACE_PATH_RX.test(pub.text), 'la copia pública de INSTALL.md no nombra el lugar');
});

// ── T36 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T36 Reviewers_PlacePath_AdaptersRegenerated_NoHandEdits', () => {
  const files = sweepScope(ROOT).filter((f) => /^agents\/[^/]+\.md$/.test(f) || (/^skills\/.+\.md$/.test(f) && !/\/tests?\//.test(f)) || /^adapters\/codex\//.test(f));
  // el piso es «alguna»: cuántas hay cambia con lo que la organización lleva a sus paquetes
  assert.ok(files.filter((f) => f.startsWith('agents/')).length > 0, 'ninguna instrucción de revisores que mirar');
  const bad = [];
  for (const f of files) for (const l of legacyPathLines(read(f))) bad.push(`${f}: ${l.trim().slice(0, 140)}`);
  assert.deepStrictEqual(bad, [], 'instrucciones que lee el modelo con la ruta vieja del lugar');
  // lo generado sale de regenerar: generate.js --check dice que está al día (sin diferencia)
  if (!fs.existsSync(path.join(ROOT, 'build', 'generate.js'))) { console.log('⏭ T36: NO MEDIDO — sin build/generate.js'); return; }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'build', 'generate.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `adapters/codex no es lo que genera generate.js (regenerar, nunca a mano):\n${r.stdout}${r.stderr}`);
});

// ── T37 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const AC27_FILES = ['scripts/hooks/branch-guard-notice.js', 'scripts/hooks/engram-drift-notice.js', 'scripts/tools/context-budget.js',
  'scripts/tools/rules-distill.js', 'skills/clocki/scripts/install-clocki-hooks.sh', 'skills/clocki/scripts/install-clocki-hooks.ps1',
  'skills/tycon-pipeline/scripts/on-pre-commit.js', 'skills/tycon-pipeline/scripts/on-frontmatter-write.js', 'skills/tycon-pipeline/scripts/pipeline.js',
  'build/check.js', 'scripts/ci/nightly-dod-notice.sh', 'scripts/hooks/instinct-trigger.sh', 'scripts/lib/harness-audit.js',
  'scripts/lib/hook-io.js', 'scripts/lib/lint-story-frontmatter.js', 'scripts/setup/install-clockify-mcp.sh', 'scripts/setup/install-clockify-mcp.ps1',
  'scripts/tools/tycon-backfill-followups.js', 'skills/tycon-pipeline/scripts/dispatch.js', 'skills/tycon-pipeline/scripts/lib/story-gate-io.js'];
test('T37 CodeMessagesAndUsageComments_PlacePath', () => {
  const bad = [];
  for (const f of shipped(AC27_FILES, 'T37')) for (const l of legacyPathLines(read(f))) bad.push(`${f}: ${l.trim().slice(0, 140)}`);
  assert.deepStrictEqual(bad, [], 'mensajes y comentarios de uso con la ruta vieja del lugar');
  // los textos que nombran el lugar escrito (place_text): cada uno con motivo, y cada uno nombra el lugar de la constante
  // (si la constante cambia, estos textos quedan en rojo hasta que cambien con ella)
  for (const e of shipped(LIST.place_text, 'T37')) {
    assert.ok(e.why && e.why.length > 10, `${e.path}: sin motivo`);
    assert.ok(PLACE_PATH_RX.test(read(e.path)), `${e.path}: declarado en place_text y no nombra el lugar`);
  }
  // el comando que el aviso le propone a la persona existe afuera: nombra el lugar
  if (here('scripts/hooks/branch-guard-notice.js')) assert.ok(PLACE_PATH_RX.test(read('scripts/hooks/branch-guard-notice.js')), 'branch-guard-notice.js: el comando no nombra el lugar');
  // advisor-runner deja leer los dos nombres (reconocedor declarado): la ruta vieja sigue ahí, a propósito
  assert.ok(LIST.recognizers.some((e) => e.path === 'scripts/controls-bench/advisor-runner.js'), 'advisor-runner.js: reconocedor declarado');
});

// ── T38 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T38 Sweep_ScopeByExpression_LegacyPlacePathOnlyDeclared', () => {
  // la expresión del alcance: excluye la historia y nada más
  for (const f of ['specs/x.md', 'tasks/todo.md', 'inbox/a/b.md', `${'instincts'}/x`, '.advisors/x', '.engram/x', '.dashboard/x', 'guides/maintaining/incident-log.md', 'guides/decisions/x.md', 'scripts/tests/fixtures/startup-lines.json']) assert.ok(HISTORY_RX.test(f), `${f} es historia`);
  for (const f of ['guides/piezas-del-arnes.md', 'INSTALL.md', 'agents/a.md', 'scripts/tests/fixtures/other.json', 'skills/x/SKILL.md']) assert.ok(!HISTORY_RX.test(f), `${f} no es historia`);
  // la expresión de la ruta vieja: la ruta en sus formas; el repo o el clon no
  for (const s of ['~/.claude/' + PLACE.LEGACY_PLACE_NAME + '/x', '$HOME/.claude/' + PLACE.LEGACY_PLACE_NAME, '%USERPROFILE%\\.claude\\' + PLACE.LEGACY_PLACE_NAME + '\\x',
    `path.join(h, '.claude', '${PLACE.LEGACY_PLACE_NAME}')`, '.claude\\\\' + PLACE.LEGACY_PLACE_NAME]) assert.ok(LEGACY_PATH_RX.test(s), `la ruta vieja: ${s}`);
  for (const s of [`~/SourceCode/${PLACE.LEGACY_PLACE_NAME}`, `/_git/${PLACE.LEGACY_PLACE_NAME}`, `project: ${PLACE.LEGACY_PLACE_NAME}`, `~/.claude/${PLACE.PLACE_NAME}/x`, `~/.claude/${PLACE.LEGACY_PLACE_NAME}-viejo/x`]) assert.ok(!LEGACY_PATH_RX.test(s), `no es la ruta vieja: ${s}`);
  // cada declaración con `lines` tiene motivo
  for (const e of LIST.legacy_only) assert.ok(e.why && e.why.length > 10, `${e.path}: sin motivo`);
  // la realidad: sólo lo declarado
  assert.deepStrictEqual(sweepOffenders(ROOT, sweepScope(ROOT)), [], 'la ruta del lugar con el nombre viejo fuera de lo declarado (harness-place-names.json)');
  // y una sembrada aparece; un envoltorio por su marca, no
  const t = tmp('harness-place-t38-');
  spawnSync('git', ['init', '-q', t]);
  fs.mkdirSync(path.join(t, 'guides'), { recursive: true }); fs.mkdirSync(path.join(t, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(t, 'guides', 'g.md'), `corré node ~/.claude/${PLACE.LEGACY_PLACE_NAME}/scripts/x.js\n`);
  fs.writeFileSync(path.join(t, 'specs', 'vieja.md'), `node ~/.claude/${PLACE.LEGACY_PLACE_NAME}/scripts/x.js\n`);
  fs.writeFileSync(path.join(t, 'shim.js'), `#!/usr/bin/env node\n// ${LIST.generated[0].mark} x\nconst p = '.claude/${PLACE.LEGACY_PLACE_NAME}';\n`);
  spawnSync('git', ['-C', t, 'add', '-A']);
  assert.deepStrictEqual(sweepOffenders(t, sweepScope(t)).map((x) => x.split(':')[0]), ['guides/g.md'], 'la sembrada no aparece, la historia entró o el envoltorio no cae en generated');
  fs.rmSync(t, { recursive: true, force: true });
});

// ── T39 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T39 RepoAnchorsUnchanged_HistoryUntouched', () => {
  // lo que no es el lugar sigue: el project: de engram, la URL de Azure, la lista de repos derivados
  assert.ok(read('scripts/lib/harness-audit.js').includes(`'tycon', '${PLACE.LEGACY_PLACE_NAME}'`), 'harness-audit.js: el project: de engram');
  assert.ok(read('scripts/production/install-guard.sh').includes(`/${PLACE.LEGACY_PLACE_NAME}/_git/${PLACE.LEGACY_PLACE_NAME}`), 'install-guard.sh: la URL de Azure');
  assert.ok(read('scripts/publishing/third-party-coverage.js').includes(`'agent-skills', '${PLACE.LEGACY_PLACE_NAME}'`), 'third-party-coverage.js: la lista');
  // el diff de la rama no toca historia (salvo tasks/todo.md, esta story y su medición; .engram/ es la exportación de la
  // memoria que acompaña cada commit, sólo agrega)
  // Lo que mide: los commits PROPIOS de la rama (los que main no tiene), sin los merges. Así no depende de ninguna rama viva
  // (las ramas ya mergeadas se borran) y una mezcla de main en la rama no cuela la historia
  // de otras stories: `--no-merges` deja afuera el commit de mezcla y `merge-base origin/main HEAD` corta todo lo que ya
  // está en main. Parada en main (o con la rama ya mergeada) no hay commits propios: no hay qué medir, y se dice.
  const base = spawnSync('git', ['-C', ROOT, 'merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' });
  if (base.status !== 0 || !base.stdout.trim()) { console.log('⏭ T39: NO MEDIDO — sin origin/main (clon superficial)'); return; }
  const d = spawnSync('git', ['-C', ROOT, 'log', '--no-merges', '--name-only', '--format=', `${base.stdout.trim()}..HEAD`], { encoding: 'utf8' });
  assert.strictEqual(d.status, 0, d.stderr);
  if (!d.stdout.trim()) console.log('⏭ T39: la rama no tiene commits propios fuera de main: el diff de historia no se mide');
  // sólo se mide en una rama que toca la story de este lugar. Una rama de otra story edita su propia story (historia
  // para esta expresión) y eso no es «la rama reescribió historia»
  const own = d.stdout.split('\n').filter(Boolean);
  if (own.length && !own.some((f) => /^specs\/story-8\.19-[^/]+\.md$/.test(f))) { console.log('⏭ T39: no es una rama de la 8.19 (no toca su story): el diff de historia no se mide'); return; }
  // retocar las stories que nombran el lugar viejo es parte del cambio de nombre: también se permiten
  const allowed = /^(tasks\/todo\.md|specs\/story-8\.19-[^/]+\.md|specs\/story-8\.13\.1-[^/]+\.md|specs\/story-8\.15-[^/]+\.md|tasks\/measurement-8\.19-[^/]+\/.+|\.engram\/.+)$/;
  const touched = own.filter((f) => HISTORY_RX.test(f) && !allowed.test(f));
  assert.deepStrictEqual(touched, [], 'la tanda reescribió historia');
});

// ═══ El nombre del repo interno en lo que se publica ═════════════════════════════════════════════════
// T48: la prosa que se publica dice «el arnés» (o la ruta del lugar) donde nombraba al repo interno. Se mira fuera de
// las marcas de sólo interno (lo que no sale) y sin contar la ruta del lugar con el nombre viejo. README.md
// sigue bajo su tope. Lo que queda en la copia (datos de Azure, reconocedores, copias declaradas, pruebas) lo cuenta
// export-real.test.sh contra scripts/tests/fixtures/public-copy-internal-name.json (T52).
const INTERNAL_NAME_RX = new RegExp(PLACE.LEGACY_PLACE_NAME, 'i');
/** Las líneas de un .md que llegan a la copia (fuera de los bloques de sólo interno y de los de instalación interna). */
function publishedLines(text) {
  const start = '<!-- tycon:' + 'internal-start -->'; const end = '<!-- tycon:' + 'internal-end -->';
  let inside = false; const out = [];
  for (const l of text.split('\n')) {
    const t = l.trim();
    if (t === start || /^<!-- install:internal/.test(t)) { inside = true; continue; }
    if (t === end || /^<!-- \/install:internal/.test(t)) { inside = false; continue; }
    if (!inside) out.push(l);
  }
  return out;
}
test('T48 PublishedProse_InternalRepoName_SaysTheHarness_ReadmeUnderLimit', () => {
  const prose = sweepScope(ROOT).filter((f) => ['README.md', 'INSTALL.md', 'story-format.md', 'claude-md-blocks/response-style.md', 'claude-md-blocks/ado-runs-list-lag.md'].includes(f)
    || /^agents\/[^/]+\.md$/.test(f) || (/^skills\/.+\.md$/.test(f) && !/(^|\/)tests?\//.test(f)));
  assert.ok(prose.length > 30, `poca prosa encontrada: ${prose.length}`);
  // lo que el núcleo deja afuera (allowlist.json → packages.core.*.out: una skill interna, una historia) no se publica
  const allowFile = path.join(ROOT, 'scripts', 'publishing', 'allowlist.json');
  const out = fs.existsSync(allowFile) ? Object.values(JSON.parse(fs.readFileSync(allowFile, 'utf8')).packages.core).flatMap((src) => (src.out || []).map((x) => x.glob)) : [];
  const { coincide } = require(path.join(ROOT, 'scripts', 'publishing', 'export.js'));
  const shippedProse = prose.filter((f) => !out.some((g) => coincide(g, f)));
  const bad = [];
  for (const f of shippedProse) for (const l of publishedLines(read(f))) if (INTERNAL_NAME_RX.test(l.replace(new RegExp(LEGACY_PATH_RX.source, 'g'), ''))) bad.push(`${f}: ${l.trim().slice(0, 140)}`);
  assert.deepStrictEqual(bad, [], 'prosa publicada que nombra al repo interno (decí «el arnés», o la ruta del lugar)');
  assert.ok(Buffer.byteLength(read('README.md'), 'utf8') <= 25600, 'README.md pasó su tope de 25.600 bytes');
  // la lista de lo que queda en la copia: cada entrada con ruta, tipo y motivo, y sin la palabra del repo en el motivo
  const listFile = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'public-copy-internal-name.json');
  const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  for (const e of list.entries) {
    assert.ok(e.path && ['azure', 'functional', 'literal-copy', 'test', 'engram', 'history'].includes(e.kind) && e.why && e.why.length > 10, `public-copy-internal-name.json: entrada incompleta ${JSON.stringify(e)}`);
    assert.ok(!INTERNAL_NAME_RX.test(e.why), `${e.path}: el motivo nombra al repo interno`);
  }
  // el espejo: una línea sembrada fuera de las marcas cuenta; adentro, no
  const toy = ['# Título', `Leé la guía del repo ${PLACE.LEGACY_PLACE_NAME}.`, '<!-- tycon:' + 'internal-start -->', `Cloná ${PLACE.LEGACY_PLACE_NAME}.`, '<!-- tycon:' + 'internal-end -->'].join('\n');
  assert.deepStrictEqual(publishedLines(toy).filter((l) => INTERNAL_NAME_RX.test(l)).length, 1, 'el espejo de publishedLines');
});

// T49-T51. Lo publicado se decide como lo decide el exportador por la lista blanca
// (allowlist.json: `in` de algún paquete y ningún `out` de esa fuente); la medición de verdad, sobre la copia armada, es
// T52 en export-real.test.sh. Sin allowlist.json (la copia pública no lo trae) estas tres no se pueden medir, y se dice.
const INTERNAL_LIST = JSON.parse(read('scripts/tests/fixtures/public-copy-internal-name.json'));
const DECLARED_INTERNAL = new Map(INTERNAL_LIST.entries.map((e) => [e.path, e]));
const T48_PROSE = (f) => ['README.md', 'INSTALL.md', 'story-format.md', 'claude-md-blocks/response-style.md', 'claude-md-blocks/ado-runs-list-lag.md'].includes(f)
  || /^agents\/[^/]+\.md$/.test(f) || (/^skills\/.+\.md$/.test(f) && !/(^|\/)tests?\//.test(f));
const withoutPlacePath = (l) => l.replace(new RegExp(LEGACY_PATH_RX.source, 'g'), '');
/** ¿Sale en la copia? `null` si no hay lista blanca con qué decidirlo. */
function shippedPredicate() {
  const allowFile = path.join(ROOT, 'scripts', 'publishing', 'allowlist.json');
  if (!fs.existsSync(allowFile)) return null;
  const { coincide, EXCLUIDOS_SIEMPRE } = require(path.join(ROOT, 'scripts', 'publishing', 'export.js'));
  const allow = JSON.parse(fs.readFileSync(allowFile, 'utf8'));
  const never = (EXCLUIDOS_SIEMPRE || []).map((x) => x.glob);
  const glob = (x) => (typeof x === 'string' ? x : x.glob);
  const sources = Object.values(allow.packages).flatMap((pkg) => Object.values(pkg));
  const outside = new Set([...(allow.suitesOutside || []).map((s) => `scripts/${s.path}`), ...(allow.casesOutside || []).map((s) => s.path)]);
  return (f) => !outside.has(f) && !never.some((g) => coincide(g, f)) && sources.some((src) => (src.in || []).some((g) => coincide(glob(g), f)) && !(src.out || []).some((g) => coincide(glob(g), f)));
}
/** Las líneas que nombran al repo interno fuera de la ruta del lugar, en archivos que no están en la lista declarada. */
function undeclaredInternal(files, readText) {
  const bad = [];
  for (const f of files) {
    if (DECLARED_INTERNAL.has(f)) continue;
    const text = readText(f);
    if (text === null) continue;
    const lines = f.endsWith('.md') ? publishedLines(text) : text.split('\n');
    lines.forEach((l, i) => { if (INTERNAL_NAME_RX.test(withoutPlacePath(l))) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`); });
  }
  return bad;
}
const textOrNull = (f) => { const b = fs.readFileSync(path.join(ROOT, f)); return b.includes(0) ? null : b.toString('utf8'); };

test('T49 PublishedCodeMessagesAndComments_SayTheHarness', () => {
  const ships = shippedPredicate();
  if (!ships) { console.log('⏭ T49: NO MEDIDO — sin scripts/publishing/allowlist.json (la copia pública); lo mide T52 en el repo interno'); return; }
  // todo lo que se publica fuera de la prosa de T48 (código, pruebas, banco, guías): o «el arnés», o el archivo declarado
  const files = sweepScope(ROOT).filter(ships).filter((f) => !T48_PROSE(f));
  assert.ok(files.length > 500, `poco publicado encontrado: ${files.length}`);
  assert.deepStrictEqual(undeclaredInternal(files, textOrNull), [], 'lo publicado nombra al repo interno fuera de public-copy-internal-name.json (decí «el arnés», o declaralo con su motivo)');
  // cada archivo declarado existe y todavía nombra al repo interno (una declaración vieja no tapa nada en silencio)
  for (const e of shipped(INTERNAL_LIST.entries, 'public-copy-internal-name.json')) {
    assert.ok(INTERNAL_NAME_RX.test(read(e.path)), `${e.path}: declarado en public-copy-internal-name.json y ya no nombra al repo interno`);
  }
  // el espejo: un mensaje sembrado en un archivo no declarado aparece; el mismo texto con la ruta del lugar, no
  const seeded = { 'scripts/hooks/sembrado.js': `console.log('tu copia de ${PLACE.LEGACY_PLACE_NAME} está atrasada');\n`, 'scripts/hooks/ruta.js': `// ~/.claude/${PLACE.LEGACY_PLACE_NAME}/x\n` };
  assert.deepStrictEqual(undeclaredInternal(Object.keys(seeded), (f) => seeded[f]).map((x) => x.split(':')[0]), ['scripts/hooks/sembrado.js'], 'el espejo de T49');
});

test('T50 FunctionalRecognizers_AddPublicName_KeepInternal_AzureDataDeclared', () => {
  // los reconocedores declarados nombran los dos: el interno sigue, el público se suma
  const recognizers = INTERNAL_LIST.entries.filter((e) => e.kind === 'functional' && /^reconocedor/.test(e.why));
  assert.ok(recognizers.length >= 5, `pocos reconocedores declarados: ${recognizers.length}`);
  const word = (n) => new RegExp(`(^|[^A-Za-z0-9_-])${n}([^A-Za-z0-9_-]|$)`, 'm');
  for (const e of shipped(recognizers, 'reconocedores de public-copy-internal-name.json')) {
    const code = codeOnly(read(e.path));
    assert.ok(word(PLACE.LEGACY_PLACE_NAME).test(code), `${e.path}: el reconocedor ya no conoce el nombre interno`);
    assert.ok(word(PLACE.PLACE_NAME).test(code) || code.includes('PLACE_NAME'), `${e.path}: el reconocedor no suma el nombre público`);
  }
  // por conducta: fuera de todo repo git decide la carpeta, y las dos carpetas son el arnés; un parecido no
  const { juzgarRuta } = require(path.join(ROOT, 'scripts', 'lib', 'harness-repo.js'));
  const t = tmp('t50-');
  for (const [name, want] of [[PLACE.LEGACY_PLACE_NAME, true], [PLACE.PLACE_NAME, true], [`${PLACE.PLACE_NAME}-report-x`, false]]) {
    fs.mkdirSync(path.join(t, 'afuera', name, 'docs'), { recursive: true });
    const j = juzgarRuta(path.join(t, 'afuera', name, 'docs', 'x.md'));
    assert.strictEqual(j.arnes, want, `harness-repo.js: la carpeta «${name}» ${want ? 'es' : 'no es'} del arnés (dio ${j.arnes} por ${j.por})`);
  }
  fs.rmSync(t, { recursive: true, force: true });
  // los datos de Azure quedan, declarados con su motivo
  const azure = INTERNAL_LIST.entries.filter((e) => e.kind === 'azure');
  for (const p of ['scripts/ci/grant-new-product-permissions.js', 'scripts/production/install-guard.sh']) {
    assert.ok(azure.some((e) => e.path === p), `${p}: el dato de Azure no está declarado como «azure»`);
  }
  for (const e of shipped(azure, 'datos de Azure de public-copy-internal-name.json')) assert.ok(/Azure/.test(e.why), `${e.path}: el motivo no dice que es un dato de Azure`);
});

test('T51 TestsAndBench_TwinCasesWithPublicName', () => {
  // los casos que arman una carpeta con el nombre interno para probar un reconocimiento tienen su gemelo con el público.
  // Que los dos salgan verdes lo dicen el banco (--only) y la suite, corridos aparte.
  const TWINS = ['scripts/controls-bench/cases/hooks/14-retro-pending.json', 'scripts/controls-bench/cases/hooks/23-unpushed-notice.json', 'scripts/tests/harness-repo.test.sh',
    'skills/tycon-pipeline/scripts/tests/story-gate-cli.test.js', 'skills/tycon-pipeline/scripts/tests/story-skill-gate.test.js'];
  // las formas en que un caso arma la carpeta: `mkdir -p …/<n>`, `repo "$BASE/…/<n>`, `path.join(base, '<n>'` y la ruta
  // suelta `'/x/<n>/…'` (las de skills/ también)
  const builds = (text, name) => {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const forms = [`(?:mkdir -p "?|repo ")(?:\\$BASE/)?(?:[\\w.-]+/)*${n}(?=[/"\\s])`, `path\\.join\\(base, '${n}'`, `'/x/${n}/`];
    return forms.reduce((k, f) => k + (text.match(new RegExp(f, 'g')) || []).length, 0);
  };
  const missing = (text) => {
    const internal = builds(text, PLACE.LEGACY_PLACE_NAME);
    const pub = builds(text, PLACE.PLACE_NAME) + builds(text, '$PUB') + builds(text, '${PLACE_NAME}')
      + (text.match(/path\.join\(base, PUBLIC_NAME/g) || []).length + (text.match(/`\/x\/\$\{pub\}\//g) || []).length;   // el nombre, tomado de place.js
    return internal > 0 && pub < internal ? `${internal} con el nombre interno, ${pub} con el público` : null;
  };
  const bad = shipped(TWINS, 'casos con gemelo').map((f) => [f, missing(read(f))]).filter(([, m]) => m).map(([f, m]) => `${f}: ${m}`);
  assert.deepStrictEqual(bad, [], 'casos de reconocimiento con el nombre interno sin su gemelo con el público');
  // el espejo: un caso sin gemelo se ve; con gemelo, no
  assert.ok(missing(`"mkdir -p ${PLACE.LEGACY_PLACE_NAME}/MiProducto && cd x"`), 'el espejo de T51: un caso sin gemelo');
  assert.strictEqual(missing(`"mkdir -p ${PLACE.LEGACY_PLACE_NAME}/a && x" "mkdir -p ${PLACE.PLACE_NAME}/a && x"`), null, 'el espejo de T51: con gemelo');
});

// ═══ La guarda del laboratorio ══════════════════════════════════════════════════════════════════════════
// Las suites protegen la carpeta real con scripts/tests/lib/lab-guard.js, que toma el nombre del lugar de place.js. La
// guarda escrita a mano, con el nombre adentro, se copia de suite en suite y cae en T49 recién en el pedido.
// Se barre lo que se publica de scripts/: las pruebas de skills/ pueden correr desde un clon sin
// scripts/ al lado y guardan su copia, declarada en public-copy-internal-name.json.
const LAB_GUARD = 'scripts/tests/lib/lab-guard.js';
/** Las líneas que escriben a mano la guarda con el nombre viejo del lugar: [archivo:línea]. */
function handWrittenLabGuards(files, readText) {
  const n = PLACE.LEGACY_PLACE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // la lista de la guarda (`*<n>*|*agent-skills*|*/.claude*` en shell, `/<n>|agent-skills|\.claude/` en JavaScript) o su mensaje
  const rx = new RegExp(`${n}\\*?\\|\\*?agent-skills\\*?\\|\\*?/?\\\\?\\.claude|${n}.*laboratorio cayó|laboratorio cayó.*${n}`);
  const bad = [];
  for (const f of files) {
    const text = readText(f);
    if (text === null) continue;
    text.split('\n').forEach((l, i) => { if (rx.test(l) && !LEGACY_PATH_RX.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`); });
  }
  return bad;
}

test('T60 LabGuard_NameFromPlace_NoSuiteWritesItByHand', () => {
  const guard = (...args) => spawnSync(process.execPath, [path.join(ROOT, LAB_GUARD), ...args], { encoding: 'utf8' });
  const t = tmp('t60-');
  // conducta: fuera, sale 0 y no dice nada; en el nombre viejo, en agent-skills o con .claude en la ruta, sale 1 y lo dice
  assert.deepStrictEqual([guard(t, 'suite-x').status, guard(t, 'suite-x').stdout], [0, '']);
  for (const d of [path.join(t, PLACE.LEGACY_PLACE_NAME, 'x'), path.join(t, 'agent-skills'), path.join(t, '.claude', 'x'), path.join(t, 'casa.claude')]) {
    const r = guard(d, 'suite-x');
    assert.deepStrictEqual([r.status, r.stdout.trim()], [1, `❌ suite-x: el laboratorio cayó en ${d}`], d);
  }
  // el nombre nuevo, sólo con --place (es también el prefijo de carpetas temporales de varias suites)
  const pub = path.join(t, `${PLACE.PLACE_NAME}-state-x`);
  assert.deepStrictEqual([guard(pub, 'suite-x').status, guard(pub, 'suite-x', '--place').status], [0, 1]);
  // las barras de Windows cuentan como «/»
  assert.strictEqual(guard('C:\\Users\\lab\\.claude\\x', 'suite-x').status, 1);
  // mal llamado: 2, sin decidir nada
  for (const args of [[], [t], [t, 'suite-x', '--other'], [t, 'suite-x', '--place', 'de-más']]) assert.strictEqual(guard(...args).status, 2, JSON.stringify(args));
  // desde JavaScript: tira con el mismo mensaje
  const { labGuard } = require(path.join(ROOT, LAB_GUARD));
  assert.doesNotThrow(() => labGuard(t, 'suite-x'));
  assert.throws(() => labGuard(path.join(t, 'agent-skills'), 'suite-x'), /suite-x: el laboratorio cayó en /);
  // sin place.js no hay nombres: no deja correr
  const lone = tmp('t60-lone-');
  fs.mkdirSync(path.join(lone, 'scripts', 'tests', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, LAB_GUARD), path.join(lone, LAB_GUARD));
  assert.notStrictEqual(spawnSync(process.execPath, [path.join(lone, LAB_GUARD), t, 'suite-x'], { encoding: 'utf8' }).status, 0, 'sin place.js, la guarda no deja correr');
  // el barrido: nada en scripts/ que se publica escribe la guarda a mano (lo que no se publica puede nombrar al repo interno)
  const ships = shippedPredicate() || (() => true);
  const files = sweepScope(ROOT).filter((f) => f.startsWith('scripts/') && /\.(sh|js|mjs|ps1)$/.test(f) && f !== LAB_GUARD).filter(ships);
  assert.ok(files.length > 300, `pocos archivos encontrados: ${files.length}`);
  assert.deepStrictEqual(handWrittenLabGuards(files, textOrNull), [], `guarda del laboratorio escrita a mano con el nombre del lugar: usá ${LAB_GUARD}`);
  // el espejo: las tres formas que había se ven; la ruta del lugar y la llamada a la guarda, no
  const L = PLACE.LEGACY_PLACE_NAME;
  const seeded = {
    'a.sh': `case "$BASE" in *${L}*|*agent-skills*|*/.claude*) echo "❌ a: el laboratorio cayó en \${BASE}"; exit 1 ;; esac\n`,
    'b.js': `if (/${L}|agent-skills|\\.claude/.test(BASE)) throw new Error(\`el laboratorio cayó en \${BASE}\`);\n`,
    'c.js': `  assert.doesNotMatch(d, /${L}|agent-skills|\\.claude/, 'x');\n`,
    'd.sh': `node "$RAIZ/${LAB_GUARD}" "$BASE" d || exit 1\nls ~/.claude/${L} ~/.claude/agent-skills\n`,
  };
  assert.deepStrictEqual(handWrittenLabGuards(Object.keys(seeded), (f) => seeded[f]).map((x) => x.split(':')[0]), ['a.sh', 'b.js', 'c.js'], 'el espejo de T60');
});
