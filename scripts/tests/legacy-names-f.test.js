'use strict';

/**
 * legacy-names-f.test.js — las carpetas internas, a su destino final (story 8.9, tanda F · 2026-10-03). T59, T60, T61.
 *
 * La tanda muda cuatro carpetas: las dos colas de fichas de los nocturnos a `inbox/`, la mini-clase a `onboarding/` y
 * los dos `.json` del nocturno de dependencias al lado de su guion. Lo que no se puede perder:
 *
 *   · T59 (AC 55) — cambian las RUTAS y nada más. La referencia es la clasificación del paso cero, hecha antes de mover
 *     nada: `fixtures/legacy-names-f/classification.tsv` trae, por archivo y carpeta, cuántas menciones eran ruta y
 *     cuántas valor, prosa u homónimo (sólo cuentas: los fragmentos de texto no viajan). Se mira por cuatro lados,
 *     porque ninguno alcanza solo:
 *       a) el disco: las cuatro mudadas; en la carpeta vieja de los `.json`, sólo los tres reemplazos;
 *       b) las cuentas: cada valor, prosa y homónimo clasificado sigue en su archivo (lo que sobra se informa, no frena:
 *          una mención nueva no es de la clasificación);
 *       c) la forma, línea por línea: ninguna ruta vieja de verdad en los archivos que tenían rutas ni en los que el
 *          mapa declara homónimos (ahí la palabra vieja es la rama de la cola, y el control de nombres viejos no mira);
 *       d) las doce rutas armadas por pedazos, que ningún buscador ve, listadas una por una; y las nueve de al lado
 *          (`.dashboard/<cola>`), que quedan.
 *     Lo que tiene forma de ruta fuera de los homónimos lo frena además `spanish-names.js --stale-mentions`
 *     (guides-moved.test.js lo exige en cero): acá no se repite, tarda medio minuto.
 *   · T60 (AC 56) — los dos yml nocturnos y la plantilla que trae los repos parsean y toda ruta que nombran existe:
 *     `--queue` y `--pending` en la carpeta nueva (con su `pending/`), `--branch` igual que antes, el `git add` y los
 *     `require` de `repos.json`. Y cada guion, en su modo que no escribe y SIN `--pending` ni `--config`, encuentra las
 *     fichas y la configuración en la carpeta nueva de un arnés de juguete (sin red, sin Azure, HOME de juguete).
 *   · T61 (AC 57) — el aviso de arranque de dependencias busca las fichas primero en la carpeta nueva y, si no está, en
 *     la vieja (del mapa), en lo publicado y en el disco: una máquina con las fichas todavía en la carpeta vieja sigue
 *     diciendo cuántos hallazgos esperan decisión. Sin ninguna de las dos, no inventa números.
 *
 * Cada prueba tiene al lado su laboratorio: el mismo comparador, con un caso armado para que falle.
 *
 * Si la cuenta de T59b baja a propósito (una frase que contaba la carpeta vieja y se fue con ella), se corrige el
 * fixture: esa mención pasa de `prose` a `path-in-doc`, y el motivo va en el commit.
 *
 * Las rutas viejas salen del mapa en tiempo de ejecución (escritas acá, mantendrían vivos los nombres en castellano que
 * cuenta el termómetro). En la copia pública, sin el mapa del equipo, lo que lo necesita se saltea con motivo.
 *
 * Correr: TYCON_SKILLS_DIR=<agent-skills> node --test scripts/tests/legacy-names-f.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const MAP = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const TEAM = fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && fs.existsSync(MAP);
const SKIP_PUBLIC = !TEAM && 'NO MEDIDO — copia pública sin el mapa';
const CLASSIFICATION = path.join(__dirname, 'fixtures', 'legacy-names-f', 'classification.tsv');
const SHIM_MARK = 'tycon-legacy-shim:';

// Los cuatro destinos (AC 55). Las carpetas viejas se toman del mapa por su destino.
const QUEUE_DEPS = 'inbox/dependencies';
const QUEUE_WATCHER = 'inbox/watcher';
const MINI_CLASS = 'onboarding/mini-class';
const DEPS_CONFIG = 'scripts/nightly/dependencies';
const DESTINATIONS = [QUEUE_DEPS, QUEUE_WATCHER, MINI_CLASS, DEPS_CONFIG];
const CONFIG_FILES = ['repos.json', 'summary.json'];
const EXPECTED_SHIMS_LEFT = 3;

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
const rootOf = (repo) => (repo === 'arnes' ? RAIZ : SKILLS);

const entries = () => (TEAM ? JSON.parse(fs.readFileSync(MAP, 'utf8')).entries : []);
const fFolders = () => entries().filter((e) => e.batch === 'F' && e.kind === 'folder');
/** La entrada del mapa de la carpeta que se mudó a `dest`. */
function folderOf(dest) {
  const e = fFolders().find((x) => x.new === dest);
  assert.ok(e, `el mapa no trae la carpeta que se mudó a ${dest} (kind folder, batch F)`);
  return e;
}
const lastPiece = (p) => path.posix.basename(p);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const firstLines = (abs) => fs.readFileSync(abs, 'utf8').split('\n').slice(0, 3).join('\n');

function cleanEnv(extra) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('TYCON_') && k !== 'TF_BUILD' && !/^(?:AZURE_|TELEGRAM_|BIZEXT_|GIT_)/.test(k)) e[k] = v;
  }
  return { ...e, ...extra };
}
const TEMPS = [];
function tmp(p) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `f-${p}-`)));
  TEMPS.push(d);
  return d;
}
process.on('exit', () => { for (const d of TEMPS) fs.rmSync(d, { recursive: true, force: true }); });
function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}
const versionedCache = new Map();
/** Lo que un repo versiona (con lo que está en el índice sin commitear). */
function versioned(root) {
  if (!versionedCache.has(root)) {
    const r = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.strictEqual(r.status, 0, `git ls-files en ${root} no pudo mirar (rc=${r.status}): ${r.stderr}`);
    versionedCache.set(root, r.stdout.split('\0').filter(Boolean));
  }
  return versionedCache.get(root);
}

// ══ T59 · la clasificación contra los dos repos ══════════════════════════════════════════════════════════════════

/** Cuántas veces nombra `text` cada carpeta vieja, por su último pedazo (la unidad de la clasificación: la aparición). */
function mentions(text, folders) {
  const words = folders.map((f) => [lastPiece(f.old), f.new]).sort((a, b) => b[0].length - a[0].length);
  const out = Object.fromEntries(folders.map((f) => [f.new, 0]));
  for (const m of text.matchAll(new RegExp(words.map(([w]) => esc(w)).join('|'), 'g'))) out[words.find(([w]) => w === m[0])[1]]++;
  return out;
}

const KEPT_CLASSES = ['value', 'prose', 'homonym'];
const MOVED_CLASSES = ['path', 'path-in-doc'];
/** Las filas del fixture: repo · file (la ruta de hoy) · folder (la carpeta nueva) · class · count. */
function classification() {
  const [head, ...rows] = fs.readFileSync(CLASSIFICATION, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
  assert.deepStrictEqual(head, ['repo', 'file', 'folder', 'class', 'count'], 'el fixture cambió de columnas');
  return rows.map(([repo, file, folder, cls, count]) => ({ repo, file, folder, cls, count: Number(count) }));
}
/** Por archivo y carpeta: cuántas menciones eran ruta (`gone`) y cuántas no (`keep`). */
function expectations(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.repo}\t${r.file}\t${r.folder}`;
    if (!by.has(k)) by.set(k, { repo: r.repo, file: r.file, folder: r.folder, gone: 0, keep: 0 });
    by.get(k)[MOVED_CLASSES.includes(r.cls) ? 'gone' : 'keep'] += r.count;
  }
  return [...by.values()];
}
/** Lo que la clasificación dice de un archivo contra lo que hoy nombra: lo que se perdió frena; lo que sobra se informa. */
function compareMentions(expected, now) {
  const lost = [];
  const extra = [];
  for (const e of expected) {
    const n = now[e.folder] || 0;
    if (n < e.keep) lost.push(`${e.repo}:${e.file} [${e.folder}]: quedan ${n} menciones y ${e.keep} no eran ruta`);
    else if (n > e.keep) extra.push(`${e.repo}:${e.file} [${e.folder}]: ${n - e.keep} de más (tenía ${e.gone} ruta(s) que cambiar)`);
  }
  return { lost, extra };
}

// Delante de la palabra vieja, esto la vuelve OTRA cosa: la foto de la noche, una rama, la carpeta vieja de otra tanda.
const NOT_THE_FOLDER_BEFORE = ['.dashboard/', 'refs/heads/', 'origin/', 'scripts/'];
const END = '$|[\\s"\'`),;:|\\]}]';
const END_IN_CODE = '$|[\\s"\'`]';   // en código, `<vieja>/)` es el cierre de una expresión regular, no una carpeta
const isCode = (rel) => /\.(?:js|ts|mjs|cjs)$/.test(rel);
/**
 * Las rutas viejas DE VERDAD de una línea. `folders`: `{ old, new, children }`, con `children` = lo SUYO (lo que hoy
 * hay en la nueva y ya no en la vieja).
 *   · con algo suyo detrás (`<vieja>/pending`, `<vieja>/README.md`) o como glob de carpeta (`<vieja>/**`);
 *   · en el lugar de un argumento que es una carpeta (`--queue <vieja>`, `cd <vieja>`, `git add … <vieja>`);
 *   · sola con su barra (`<vieja>/`): sólo donde la palabra no es también una rama. `branchAlso(f)` dice si este archivo
 *     está declarado homónimo de esa entrada: ahí `<vieja>/` es el prefijo de las ramas de la cola, y `<vieja>/<id>` y
 *     `<vieja>/*` (un patrón de ramas) nunca cuentan.
 * Una carpeta de varios pedazos cuenta también por su último pedazo con algo suyo detrás.
 */
function oldRoutesIn(rawLine, folders, { code = false, branchAlso = () => false } = {}) {
  const line = rawLine.replace(/\\([./])/g, '$1');   // `<vieja>\/x\.html` de una expresión regular es la misma ruta
  const end = code ? END_IN_CODE : END;
  const out = [];
  for (const f of folders) {
    const single = !f.old.includes('/');
    const kids = f.children.length ? `(?:${f.children.map(esc).join('|')})(?![\\w-])` : '(?!)';
    const names = single ? esc(f.old) : `(?:${esc(f.old)}|${esc(lastPiece(f.old))}(?=/${kids}))`;
    const itself = branchAlso(f) ? '' : `|(?=${end}|/)`;   // `<vieja>//`: la barra que cierra una expresión regular
    const res = [new RegExp(`(?<![\\w.~-])${names}/(?:${kids}|\\*\\*${itself})`, 'g')];
    if (single) {
      res.push(new RegExp(`(?<=--queue[ =]["']?|(?:^|[\\s(;&|])cd +["']?)${esc(f.old)}(?=${END}|&)`, 'g'));
      if (/(?:^|[\s;&|])git add /.test(line)) res.push(new RegExp(`(?<=\\s)${esc(f.old)}(?=${END})`, 'g'));
    } else res.push(new RegExp(`(?<![\\w.~-])${esc(f.old)}(?=${end})`, 'g'));
    const seen = new Set();
    for (const re of res) {
      for (const m of line.matchAll(re)) {
        const before = line.slice(0, m.index);
        if (seen.has(m.index) || (single && NOT_THE_FOLDER_BEFORE.some((p) => before.endsWith(p)))) continue;
        seen.add(m.index);
        out.push({ folder: f.new, text: m[0] });
      }
    }
  }
  return out;
}
/**
 * Las rutas viejas armadas por pedazos: el último pedazo de la carpeta vieja entre comillas, dentro de un `path.join` o
 * `path.resolve` (una carpeta de una palabra, que entre comillas también es un valor: `fuente === '<vieja>'`) o en
 * cualquier lado (una de varios pedazos: la lista que se arma como `scripts/${d}`). Detrás de `'.dashboard'` es la foto
 * de la noche, que queda.
 */
function oldPiecesIn(line, folders) {
  const out = [];
  for (const f of folders) {
    const single = !f.old.includes('/');
    for (const m of line.matchAll(new RegExp(`(['"\`])${esc(lastPiece(f.old))}\\1`, 'g'))) {
      const before = line.slice(0, m.index);
      if (/['"`]\.dashboard['"`]$/.test(before.replace(/[\s,]+$/, ''))) continue;
      if (single && !/path\.(?:join|resolve)\([^;]*$/.test(before)) continue;
      out.push({ folder: f.new, text: m[0] });
    }
  }
  return out;
}
/** Cuántas veces arma `text` la foto de la noche de una cola: `'.dashboard', '<vieja>'`. */
const photoJoins = (text, word) => [...text.matchAll(new RegExp(`['"]\\.dashboard['"]\\s*,\\s*['"]${esc(word)}['"]`, 'g'))].length;

/** Lo que el detector necesita de cada carpeta de la tanda, leído del mapa y del disco. */
function movedFolders() {
  return fFolders().map((e) => {
    const stayed = new Set(list(path.join(RAIZ, e.old)));
    return { old: e.old, new: e.new, children: list(path.join(RAIZ, e.new)).filter((n) => !stayed.has(n)) };
  });
}
/** Los archivos que el mapa declara homónimos de cada carpeta de la tanda: `carpeta nueva → Set("repo\tarchivo")`. */
function homonymFiles() {
  const { globARegex } = require(path.join(RAIZ, 'scripts', 'publishing', 'detector.js'));
  const out = new Map();
  for (const e of fFolders()) {
    const repo = e.repo || 'arnes';
    const set = new Set();
    if (Array.isArray(e.homonyms) && rootOf(repo)) {
      const res = e.homonyms.map((h) => globARegex(h.glob));
      for (const rel of versioned(rootOf(repo))) if (res.some((re) => re.test(rel))) set.add(`${repo}\t${rel}`);
    }
    out.set(e.new, set);
  }
  return out;
}

// Las doce rutas armadas por pedazos (punto 17 del paso cero), una por una: archivo, línea medida sobre el `main` de
// antes de la tanda (sólo para ubicarla: se mira el archivo entero), qué arma y a qué carpeta se mudó.
const SCRIPT_DEPS = 'scripts/nightly/dependencies/nightly-dependencies.js';
const SCRIPT_WORK_ITEMS = 'scripts/nightly/dependencies/work-items.js';
const SCRIPT_SUMMARY = 'scripts/nightly/dependencies/daily-summary.js';
const SCRIPT_DASHBOARD = 'scripts/nightly/dashboard/dashboard.js';
const SCRIPT_NOTICE = 'scripts/hooks/dependencies-notice.js';
/** El guion de la mirada nocturna de producción se llama como su cola vieja: se arma del mapa. */
const scriptWatcher = () => `scripts/nightly/watcher/${folderOf(QUEUE_WATCHER).old}.js`;
const twelve = () => [
  { file: SCRIPT_NOTICE, line: 396, what: 'las fichas que lee el aviso de arranque', dest: QUEUE_DEPS },
  { file: SCRIPT_DASHBOARD, line: 731, what: 'el repos.json que lee el tablero', dest: DEPS_CONFIG },
  { file: SCRIPT_SUMMARY, line: 64, what: 'la carpeta de repos.json y summary.json del resumen diario', dest: DEPS_CONFIG },
  { file: SCRIPT_SUMMARY, line: 953, what: 'el --pending por defecto del resumen de dependencias', dest: QUEUE_DEPS },
  { file: SCRIPT_SUMMARY, line: 959, what: 'el --pending por defecto del resumen de la mirada de producción', dest: QUEUE_WATCHER },
  { file: SCRIPT_DEPS, line: 67, what: 'el --config por defecto del nocturno de dependencias', dest: DEPS_CONFIG },
  { file: SCRIPT_DEPS, line: 69, what: 'el --pending por defecto del nocturno de dependencias', dest: QUEUE_DEPS },
  { file: SCRIPT_WORK_ITEMS, line: 75, what: 'el --config por defecto de los pedidos de trabajo', dest: DEPS_CONFIG },
  { file: SCRIPT_WORK_ITEMS, line: 77, what: 'el --pending por defecto de los pedidos de trabajo', dest: QUEUE_DEPS },
  { file: scriptWatcher(), line: 51, what: 'el --pending por defecto de la mirada de producción', dest: QUEUE_WATCHER },
  { file: 'scripts/tools/harness-map/census.js', line: 217, what: 'la lista de subcarpetas de scripts/ que recorre el censo', dest: DEPS_CONFIG },
  { file: 'scripts/tools/harness-map/public-version.js', line: 51, what: 'el --output por defecto del mapa público', dest: MINI_CLASS },
];
// Las nueve de al lado, que NO se tocan: la foto de cada noche sigue en `.dashboard/<cola>` (archivo, cola, cuántas).
const photoNeighbors = () => [
  [SCRIPT_NOTICE, QUEUE_DEPS, 1], [SCRIPT_NOTICE, QUEUE_WATCHER, 1],
  [SCRIPT_SUMMARY, QUEUE_DEPS, 2], [SCRIPT_SUMMARY, QUEUE_WATCHER, 2],
  [SCRIPT_DEPS, QUEUE_DEPS, 1], [SCRIPT_WORK_ITEMS, QUEUE_DEPS, 1], [scriptWatcher(), QUEUE_WATCHER, 1],
];

test('T59a · BatchF_ClassifiedBeforeRename — las cuatro carpetas mudadas; en la vieja de los .json, sólo los tres reemplazos', { skip: SKIP_PUBLIC }, () => {
  const legacy = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
  const folders = fFolders();
  assert.deepStrictEqual(folders.map((e) => e.new).sort(), [...DESTINATIONS].sort(), 'carpetas con batch F en el mapa');
  for (const e of folders) {
    assert.ok(legacy.isMoved(e, RAIZ), `${e.old} → ${e.new}: no está mudada (la nueva no existe o en la vieja queda algo que no es un reemplazo)`);
  }
  const files = versioned(RAIZ);
  const config = folderOf(DEPS_CONFIG);
  for (const e of folders.filter((x) => x.new !== DEPS_CONFIG)) {
    assert.deepStrictEqual(files.filter((f) => f.startsWith(`${e.old}/`)), [], `${e.old}/ sigue teniendo archivos versionados`);
  }
  const left = files.filter((f) => f.startsWith(`${config.old}/`));
  assert.strictEqual(left.length, EXPECTED_SHIMS_LEFT, `en ${config.old}/ quedan: ${left.join(', ')}`);
  for (const rel of left) {
    assert.ok(firstLines(path.join(RAIZ, rel)).includes(`${SHIM_MARK} ${DEPS_CONFIG}/`), `${rel} no es un reemplazo de un guion de ${DEPS_CONFIG}/`);
  }
  for (const name of CONFIG_FILES) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(RAIZ, DEPS_CONFIG, name), 'utf8')), `${DEPS_CONFIG}/${name} no está o no parsea`);
  }
  // `.dashboard/` no se mueve: la foto de cada noche sigue donde estaba
  for (const q of [QUEUE_DEPS, QUEUE_WATCHER]) {
    const photo = `.dashboard/${folderOf(q).old}/`;
    assert.ok(files.some((f) => f.startsWith(photo)), `${photo} quedó sin fotos versionadas (esa carpeta no se muda)`);
  }
});

test('T59b · BatchF_ClassifiedBeforeRename — cada valor, prosa y homónimo clasificado sigue en su archivo', { skip: SKIP_PUBLIC }, (t) => {
  const rows = classification();
  const classes = new Set(rows.map((r) => r.cls));
  assert.deepStrictEqual([...classes].filter((c) => ![...KEPT_CLASSES, ...MOVED_CLASSES].includes(c)), [], 'clases que el fixture no conoce');
  assert.deepStrictEqual([...new Set(rows.map((r) => r.folder))].filter((f) => !DESTINATIONS.includes(f)), [], 'carpetas que no son de la tanda');
  assert.ok(rows.every((r) => Number.isInteger(r.count) && r.count > 0), 'una cuenta que no es un entero positivo');
  const expected = expectations(rows);
  const fileCount = new Set(expected.map((e) => `${e.repo}\t${e.file}`)).size;
  assert.ok(fileCount >= 150, `la clasificación trae ${fileCount} archivos (se midieron 174)`);
  assert.ok(expected.filter((e) => e.gone > 0).length >= 60, 'la clasificación perdió sus filas de ruta');

  const folders = fFolders();
  const missing = [];
  const lost = [];
  const extra = [];
  const byFile = new Map();
  for (const e of expected) {
    const k = `${e.repo}\t${e.file}`;
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(e);
  }
  let skippedSkills = 0;
  for (const group of byFile.values()) {
    const { repo, file } = group[0];
    if (!rootOf(repo)) { skippedSkills++; continue; }
    const abs = path.join(rootOf(repo), file);
    if (!fs.existsSync(abs)) { missing.push(`${repo}:${file}`); continue; }
    const r = compareMentions(group, mentions(fs.readFileSync(abs, 'utf8'), folders));
    lost.push(...r.lost);
    extra.push(...r.extra);
  }
  if (skippedSkills) t.diagnostic(`NO MEDIDO: ${skippedSkills} archivo(s) de agent-skills (sin TYCON_SKILLS_DIR ni la copia de la máquina)`);
  if (extra.length) t.diagnostic(`menciones que la clasificación no conocía (nuevas, o una ruta sin cambiar que la forma no delata):\n  ${extra.join('\n  ')}`);
  assert.deepStrictEqual(missing, [], 'archivos de la clasificación que ya no están (se sacan del fixture)');
  assert.deepStrictEqual(lost, [], 'valores, prosa u homónimos que la mudanza cambió (sólo cambian las rutas)');
});

test('T59b · laboratorio — el comparador ve un valor cambiado de más y una ruta sin cambiar', () => {
  const folders = [{ old: 'cola-vieja', new: 'inbox/queue' }, { old: 'scripts/config-vieja', new: 'scripts/nightly/queue' }];
  const before = "fuente: 'cola-vieja'\n--branch cola-vieja\nconst P = path.join(R, 'cola-vieja');\nrequire('./scripts/config-vieja/repos.json')\n";
  assert.deepStrictEqual(mentions(before, folders), { 'inbox/queue': 3, 'scripts/nightly/queue': 1 }, 'cuenta por aparición, la de varios pedazos aparte');
  const expected = [{ repo: 'arnes', file: 'x.js', folder: 'inbox/queue', gone: 1, keep: 2 }, { repo: 'arnes', file: 'x.js', folder: 'scripts/nightly/queue', gone: 1, keep: 0 }];
  const good = "fuente: 'cola-vieja'\n--branch cola-vieja\nconst P = path.join(R, 'inbox', 'queue');\nrequire('./scripts/nightly/queue/repos.json')\n";
  assert.deepStrictEqual(compareMentions(expected, mentions(good, folders)), { lost: [], extra: [] }, 'sólo cambiaron las rutas');
  const tooFar = good.replace("fuente: 'cola-vieja'", "fuente: 'queue'");
  assert.strictEqual(compareMentions(expected, mentions(tooFar, folders)).lost.length, 1, 'un valor cambiado tiene que frenar');
  const untouched = compareMentions(expected, mentions(before, folders));
  assert.deepStrictEqual([untouched.lost.length, untouched.extra.length], [0, 2], 'las rutas sin cambiar salen como menciones de más');
});

test('T59c · BatchF_ClassifiedBeforeRename — ninguna ruta vieja de verdad, tampoco en los archivos homónimos (línea por línea)', { skip: SKIP_PUBLIC }, (t) => {
  const legacy = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
  const folders = movedFolders();
  for (const f of folders) assert.ok(f.children.length > 0, `${f.new}: no hay nada adentro con qué reconocer la ruta vieja`);
  const homonyms = homonymFiles();
  const watched = new Set(expectations(classification()).filter((e) => e.gone > 0).map((e) => `${e.repo}\t${e.file}`));
  for (const set of homonyms.values()) for (const k of set) watched.add(k);
  const found = [];
  for (const k of watched) {
    const [repo, rel] = k.split('\t');
    if (!rootOf(repo) || (repo === 'arnes' && rel === path.relative(RAIZ, MAP))) continue;
    const abs = path.join(rootOf(repo), rel);
    if (!fs.existsSync(abs)) continue;   // T59b ya dice que falta
    const text = fs.readFileSync(abs, 'utf8');
    if (legacy.isGeneratedShim(rel, text)) continue;
    const opts = { code: isCode(rel), branchAlso: (f) => homonyms.get(f.new).has(k) };
    text.split('\n').forEach((line, i) => {
      for (const h of oldRoutesIn(line, folders, opts)) found.push(`${repo}:${rel}:${i + 1} «${h.text}» (hoy es ${h.folder}/)`);
    });
  }
  t.diagnostic(`archivos mirados: ${watched.size} · declarados homónimos en el mapa: ${[...homonyms.values()].reduce((n, s) => n + s.size, 0)}`);
  assert.deepStrictEqual(found, [], 'rutas viejas que quedaron');
});

test('T59c · laboratorio — una rama no es una ruta; una ruta vieja de verdad, sí', () => {
  const folders = [{ old: 'cola-vieja', new: 'inbox/queue', children: ['pending', 'README.md'] },
    { old: 'scripts/config-vieja', new: 'scripts/nightly/queue', children: ['repos.json'] }];
  const hits = (line, opts) => oldRoutesIn(line, folders, opts).map((h) => h.text);
  // lo que NO es la carpeta
  for (const line of ['git push origin HEAD:refs/heads/cola-vieja/abc123', 'las ramas `cola-vieja/<id>` quedan', "git branch --list 'cola-vieja/*'",
    'ls .dashboard/cola-vieja/', '--branch cola-vieja \\', 'la cola-vieja de siempre', 'node scripts/cola-vieja/x.js',
    'node scripts/config-vieja/reemplazo.js run', 'unzip /tmp/cola-vieja.zip']) {
    assert.deepStrictEqual(hits(line), [], `no es una ruta vieja: ${line}`);
  }
  // lo que SÍ
  for (const line of ['cat cola-vieja/pending/x.yaml', "{ glob: 'cola-vieja/**' }", '--queue cola-vieja \\', 'git add .dashboard/cola-vieja cola-vieja',
    '(cd cola-vieja && zip x)', "grep -E '^(a/b\\.html$|cola-vieja/README\\.md$)'", 'ver `cola-vieja/README.md`',
    'require("./scripts/config-vieja/repos.json")', 'antes salía de `config-vieja/repos.json`', '## scripts/config-vieja/', '/^scripts\\/config-vieja\\//']) {
    assert.strictEqual(hits(line).length, 1, `es una ruta vieja: ${line}`);
  }
  // sola con su barra: es la carpeta, salvo donde el mapa dice que ahí la palabra es la rama
  assert.strictEqual(hits('los borradores viven en `cola-vieja/`').length, 1);
  assert.deepStrictEqual(hits('quedan fuera las ramas `cola-vieja/`', { branchAlso: () => true }), []);
  assert.strictEqual(hits('cat cola-vieja/pending/x.yaml', { branchAlso: () => true }).length, 1, 'con algo suyo detrás cuenta siempre');
  // en código, el cierre de una expresión regular no es una carpeta
  assert.deepStrictEqual(hits('assert.match(out, /no aplica en la cola-vieja/);', { code: true }), []);
});

test('T59d · BatchF_ClassifiedBeforeRename — las doce rutas armadas por pedazos, una por una; las nueve de al lado quedan', { skip: SKIP_PUBLIC }, () => {
  const folders = fFolders();
  const all = twelve();
  assert.strictEqual(all.length, 12);
  const still = [];
  for (const x of all) {
    const abs = path.join(RAIZ, x.file);
    assert.ok(fs.existsSync(abs), `${x.file} no existe`);
    const mine = folders.filter((f) => f.new === x.dest);
    fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      if (oldPiecesIn(line, mine).length) still.push(`${x.file}:${i + 1} — ${x.what}: sigue armando la carpeta vieja (hoy es ${x.dest}/)`);
    });
  }
  assert.deepStrictEqual([...new Set(still)], [], 'rutas armadas por pedazos que siguen en la carpeta vieja (fallan calladas: el guion lee «nada»)');
  const neighbors = photoNeighbors();
  assert.strictEqual(neighbors.reduce((n, x) => n + x[2], 0), 9);
  for (const [file, queue, n] of neighbors) {
    const have = photoJoins(fs.readFileSync(path.join(RAIZ, file), 'utf8'), folderOf(queue).old);
    assert.ok(have >= n, `${file}: arma ${have} vez/veces la foto de la noche de ${queue} en .dashboard/ y eran ${n} (esa ruta queda)`);
  }
});

test('T59d · laboratorio — un pedazo entre comillas en un path.join es una ruta; en .dashboard o en una comparación, no', () => {
  const folders = [{ old: 'cola-vieja', new: 'inbox/queue' }, { old: 'scripts/config-vieja', new: 'scripts/nightly/queue' }];
  const hits = (line) => oldPiecesIn(line, folders).map((h) => h.folder);
  assert.deepStrictEqual(hits("const PENDING_DEF = path.join(ROOT, 'cola-vieja');"), ['inbox/queue']);
  assert.deepStrictEqual(hits("a.pending = a.pending || path.join(ROOT, 'cola-vieja');"), ['inbox/queue']);
  assert.deepStrictEqual(hits("const CFG = path.join(__dirname, '..', '..', 'config-vieja', 'repos.json');"), ['scripts/nightly/queue']);
  assert.deepStrictEqual(hits("for (const d of ['metrics', 'config-vieja', 'lib']) walk(`scripts/${d}`);"), ['scripts/nightly/queue']);
  assert.deepStrictEqual(hits("const OUT_DEF = path.join(ROOT, '.dashboard', 'cola-vieja');"), [], 'la foto de la noche queda');
  assert.deepStrictEqual(hits("if (a.fuente === 'cola-vieja') a.out = a.out || path.join(ROOT, '.dashboard', 'cola-vieja');"), [], 'un valor y la foto');
  assert.deepStrictEqual(hits("const PENDING_DEF = path.join(ROOT, 'inbox', 'queue');"), []);
  assert.strictEqual(photoJoins("x = path.join(R, '.dashboard', 'cola-vieja'); y = path.join(R, \".dashboard\", \"cola-vieja\");", 'cola-vieja'), 2);
});

// ══ T60 · los pipelines y los guiones en su modo que no escribe ══════════════════════════════════════════════════

const stripArg = (v) => v.replace(/^["']|["']$/g, '').replace(/^\$\(Build\.SourcesDirectory\)\//, '');
const ARG = '("[^"]*"|\'[^\']*\'|[^\\s\\\\]+)';
/** Lo que un yml nombra: los llamados al guion que abre los PR (con su cola y su rama), carpetas, `git add`, guiones y `require`. */
function ymlRoutes(text) {
  const lines = text.split('\n');
  // las opciones se leen de lo que corre: un comentario que explica `--pending` no es un llamado
  const live = lines.filter((l) => !/^\s*#/.test(l)).join('\n');
  const all = (re, where = live) => [...where.matchAll(re)].map((m) => stripArg(m[1]));
  const calls = [];
  lines.forEach((line, i) => {
    if (!/open-pr-per-finding\.sh/.test(line) || /^\s*#/.test(line)) return;
    let j = i;
    let block = line;
    while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) block += `\n${lines[++j]}`;
    const arg = (name) => { const m = new RegExp(`--${name}[ =]+${ARG}`).exec(block); return m ? stripArg(m[1]) : null; };
    calls.push({ line: i + 1, queue: arg('queue'), branch: arg('branch') });
  });
  // Lo que el paso guarda en main. Hasta la story 8.26 (tanda H1a) era un `git add <rutas>`; desde entonces los
  // nocturnos guardan por `push-nightly-data.js save … -- <rutas>`: las rutas van después del «--», en el mismo
  // llamado (que sigue en varias líneas con «\»). Las dos formas cuentan: es la misma lista, con otro comando.
  const saved = [];
  lines.forEach((line, i) => {
    if (!/push-nightly-data\.js\s+save\b/.test(line) || /^\s*#/.test(line)) return;
    let j = i;
    let block = line;
    while (/\\\s*$/.test(lines[j]) && j + 1 < lines.length) block += `\n${lines[++j]}`;
    // el ÚLTIMO «--» suelto: un mensaje puede traer uno adentro («--message "a -- b"»), y las rutas van al final
    const m = /^[\s\S]*(?:^|\s)--\s+([^\n]+?)\s*$/.exec(block);
    saved.push(m ? m[1].trim().split(/\s+/).map(stripArg) : []);
  });
  return {
    calls,
    pending: all(new RegExp(`--pending[ =]+${ARG}`, 'g')),
    out: all(new RegExp(`--out[ =]+${ARG}`, 'g')),
    gitAdd: [...lines.filter((l) => /^\s*git add /.test(l)).map((l) => l.trim().split(/\s+/).slice(2).filter((a) => !a.startsWith('-')).map(stripArg)), ...saved],
    scripts: all(/(?<![\w./-])(scripts\/[\w./-]+\.(?:js|sh|py|ps1|json))(?![\w-])/g, text),   // también las que cita un comentario
    requires: all(/require\(\s*["']\.\/([^"']+)["']\s*\)/g),
  };
}
/**
 * Los problemas de las rutas de un yml contra un repo: `queue` es la carpeta de las fichas (con su `pending/`) y `branch`
 * el prefijo de las ramas, que no cambia. Sin `queue` (la plantilla que trae los repos) sólo se miran guiones y `require`.
 */
function ymlProblems(text, { root, queue = null, branch = null, oldFolders = [] }) {
  const r = ymlRoutes(text);
  const problems = [];
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  for (const s of new Set(r.scripts)) {
    if (!exists(s)) problems.push(`${s} no existe`);
    else if (oldFolders.some((o) => s.startsWith(`${o}/`))) problems.push(`${s} es una ruta de la carpeta vieja (usa la nueva)`);
  }
  for (const q of new Set(r.requires)) if (!exists(q)) problems.push(`require("./${q}"): no existe`);
  if (!queue) return problems;
  for (const c of r.calls) {
    if (c.queue !== queue) problems.push(`línea ${c.line}: --queue ${c.queue} — es la carpeta de las fichas: tiene que ser ${queue}`);
    else if (!isDir(path.join(root, c.queue, 'pending'))) problems.push(`línea ${c.line}: --queue ${c.queue} no tiene pending/ (el paso no encontraría ninguna ficha)`);
    if (c.branch !== branch) problems.push(`línea ${c.line}: --branch ${c.branch} — el prefijo de las ramas no cambia: ${branch}`);
  }
  for (const p of r.pending) {
    if (p !== queue) problems.push(`--pending ${p} — tiene que ser la carpeta de las fichas: ${queue}`);
    else if (!isDir(path.join(root, p, 'pending'))) problems.push(`--pending ${p} no tiene pending/`);
  }
  for (const o of r.out.filter((x) => x.startsWith('.dashboard/'))) if (!isDir(path.join(root, o))) problems.push(`--out ${o}: no existe (la foto de la noche no se muda)`);
  for (const args of r.gitAdd) {
    for (const a of args) if (!exists(a)) problems.push(`git add ${a}: no existe`);
    if (!args.includes(queue)) problems.push(`git add ${args.join(' ')}: no lleva la carpeta de las fichas (${queue})`);
  }
  return problems;
}
/** El yml de cada nocturno se llama como su cola vieja (Azure lo nombra desde su definición: no se renombra). */
const nightlyYml = (queue) => `pipelines/azure-pipelines-${folderOf(queue).old}.yml`;
const FETCH_REPOS_YML = 'pipelines/templates/traer-repos.yml';
function parses(abs) {
  const py = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
  if (py.status !== 0) return { measured: false };
  const p = spawnSync('python3', ['-c', 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))', abs], { encoding: 'utf8' });
  return { measured: true, ok: p.status === 0, error: p.stderr.trim().split('\n').pop() };
}

test('T60a · BatchF_PipelinesParseAndDryRunsMatch — los yml parsean y toda ruta que nombran existe; --queue es la carpeta nueva', { skip: SKIP_PUBLIC }, (t) => {
  const oldFolders = fFolders().map((e) => e.old);
  for (const queue of [QUEUE_DEPS, QUEUE_WATCHER]) {
    const rel = nightlyYml(queue);
    const abs = path.join(RAIZ, rel);
    assert.ok(fs.existsSync(abs), `${rel} no existe`);
    const p = parses(abs);
    if (!p.measured) t.diagnostic(`NO MEDIDO: ${rel} no se parseó (python3 sin PyYAML)`);
    else assert.ok(p.ok, `${rel} no parsea: ${p.error}`);
    const text = fs.readFileSync(abs, 'utf8');
    const routes = ymlRoutes(text);
    assert.strictEqual(routes.calls.length, 2, `${rel}: llamados al guion que abre los PR (el que anota y el que abre)`);
    assert.ok(routes.pending.length >= 2 && routes.gitAdd.length === 1, `${rel}: --pending ×${routes.pending.length}, git add ×${routes.gitAdd.length}`);
    assert.deepStrictEqual(ymlProblems(text, { root: RAIZ, queue, branch: folderOf(queue).old, oldFolders }), [], `${rel}: rutas`);
  }
  const abs = path.join(RAIZ, FETCH_REPOS_YML);
  const p = parses(abs);
  if (p.measured) assert.ok(p.ok, `${FETCH_REPOS_YML} no parsea: ${p.error}`);
  const text = fs.readFileSync(abs, 'utf8');
  // Story 8.26, tanda C: la lista de productos ya no se lee con dos `require` de una ruta fija; la plantilla la recibe
  // por el parámetro `productRegistry`, y su valor por defecto es la carpeta nueva (la validación con un repo de GitHub
  // como propio le pasa la que trae de afuera).
  assert.strictEqual(productRegistryDefault(text), `${DEPS_CONFIG}/repos.json`, `${FETCH_REPOS_YML}: repos.json se lee de ${DEPS_CONFIG}/ por defecto`);
  assert.ok(fs.existsSync(path.join(RAIZ, DEPS_CONFIG, 'repos.json')), `${DEPS_CONFIG}/repos.json existe`);
  assert.deepStrictEqual(ymlProblems(text, { root: RAIZ, oldFolders }), [], `${FETCH_REPOS_YML}: rutas`);
});

test('T60a · laboratorio — una cola que quedó con el nombre viejo, una rama renombrada y una ruta que no existe frenan', () => {
  const root = tmp('yml');
  for (const d of ['inbox/queue/pending', '.dashboard/cola-vieja', 'scripts/ci', 'scripts/nightly/queue']) fs.mkdirSync(path.join(root, d), { recursive: true });
  write(root, 'scripts/ci/open-pr-per-finding.sh', '');
  write(root, 'scripts/nightly/queue/run.js', '');
  write(root, 'scripts/nightly/queue/repos.json', '{}');
  const yml = ({ queue = 'inbox/queue', branch = 'cola-vieja', pending = 'inbox/queue', add = 'inbox/queue', script = 'scripts/nightly/queue/run.js', req = 'scripts/nightly/queue/repos.json' } = {}) => [
    '          # un comentario que nombra scripts/ci/open-pr-per-finding.sh no es un llamado',
    '          bash scripts/ci/open-pr-per-finding.sh --record-only \\',
    `            --queue ${queue} \\`,
    `            --branch ${branch} \\`,
    `            --script ${script}`,
    '          git clone --quiet --branch main "$URL" "$D"',
    `          node ${script} run --out "$(Build.SourcesDirectory)/.dashboard/cola-vieja" --pending "$(Build.SourcesDirectory)/${pending}"`,
    `          git add .dashboard/cola-vieja ${add}`,
    `          node -e 'console.log(require("./${req}").repos)'`,
  ].join('\n');
  const check = (o) => ymlProblems(yml(o), { root, queue: 'inbox/queue', branch: 'cola-vieja', oldFolders: ['cola-vieja', 'scripts/config-vieja'] });
  assert.deepStrictEqual(check(), [], 'el yml bien escrito no tiene problemas');
  assert.strictEqual(ymlRoutes(yml()).calls.length, 1, 'el comentario no cuenta como llamado');
  assert.match(check({ queue: 'cola-vieja' }).join('\n'), /--queue cola-vieja — es la carpeta de las fichas/);
  assert.match(check({ branch: 'inbox/queue' }).join('\n'), /--branch inbox\/queue — el prefijo de las ramas no cambia/);
  assert.match(check({ pending: 'cola-vieja' }).join('\n'), /--pending cola-vieja — tiene que ser la carpeta de las fichas/);
  assert.match(check({ add: 'cola-vieja' }).join('\n'), /git add cola-vieja: no existe/);
  // la misma lista dicha por el guion de guardar (la forma de hoy): las rutas van después del «--», en un llamado
  // partido en varias líneas. Se lee igual: la carpeta de las fichas tiene que estar, y con su nombre nuevo.
  write(root, 'scripts/ci/push-nightly-data.js', '');
  const viaSave = (o) => yml(o).replace(/ {10}git add \.dashboard\/cola-vieja (\S+)/,
    '          node scripts/ci/push-nightly-data.js save \\\n            --message "m" \\\n            -- .dashboard/cola-vieja $1');
  const opts = { root, queue: 'inbox/queue', branch: 'cola-vieja', oldFolders: ['cola-vieja', 'scripts/config-vieja'] };
  assert.deepStrictEqual(ymlRoutes(viaSave()).gitAdd, [['.dashboard/cola-vieja', 'inbox/queue']], 'las rutas que guarda el guion se leen de después del «--»');
  assert.deepStrictEqual(ymlProblems(viaSave(), opts), [], 'el yml que guarda por el guion, bien escrito, no tiene problemas');
  // un «--» adentro del mensaje no corta la lista, ni partido en líneas ni en una sola
  const dashed = viaSave().replace('--message "m"', '--message "a -- b"');
  assert.deepStrictEqual(ymlRoutes(dashed).gitAdd, [['.dashboard/cola-vieja', 'inbox/queue']], 'el «--» del mensaje no es el de las rutas');
  assert.deepStrictEqual(ymlRoutes(dashed.replace(/ \\\n\s+/g, ' ')).gitAdd, [['.dashboard/cola-vieja', 'inbox/queue']], 'y en una sola línea tampoco');
  // sin «--» no hay rutas: no pasa por «no encontré nada que mirar»
  assert.match(ymlProblems(viaSave().replace(/ \\\n\s+-- [^\n]+/, ''), opts).join('\n'), /no lleva la carpeta de las fichas/);
  assert.match(ymlProblems(viaSave({ add: 'cola-vieja' }), opts).join('\n'), /git add cola-vieja: no existe/, 'y una cola con el nombre viejo frena igual');
  assert.match(ymlProblems(viaSave({ add: '.dashboard/cola-vieja' }), opts).join('\n'), /no lleva la carpeta de las fichas/);
  assert.match(check({ script: 'scripts/config-vieja/run.js' }).join('\n'), /scripts\/config-vieja\/run\.js no existe/);
  assert.match(check({ req: 'scripts/config-vieja/repos.json' }).join('\n'), /require\("\.\/scripts\/config-vieja\/repos\.json"\): no existe/);
  fs.rmSync(path.join(root, 'inbox/queue/pending'), { recursive: true });
  assert.match(check().join('\n'), /--queue inbox\/queue no tiene pending\//, 'una cola sin pending/ sale verde sin abrir un solo PR');
});

// ── el arnés de juguete ──────────────────────────────────────────────────────────────────────────────────────────
const TODAY = '2026-10-03';
const NOW = `${TODAY}T12:00:00Z`;
/**
 * El día del juguete es SIEMPRE `TODAY`: sus fotos llevan esa fecha, y un guion que la midiera contra el reloj de verdad
 * las vería viejas a los pocos días (el tablero calla una fuente de más de dos días: esta prueba habría salido roja para
 * siempre desde el tercero). Cada guion recibe el día por la opción o la variable que ofrece (`--today`,
 * `TYCON_DEPS_NOW`); y como el tablero no ofrece ninguna, TODO guion que corre esta prueba arranca además con el reloj de
 * node clavado en `NOW`: un módulo que se carga antes que el guion (`NODE_OPTIONS=--require`) y reemplaza `Date`.
 * Devuelve el `NODE_OPTIONS` para el entorno del guion (detrás de lo que ya traiga el de quien corre la prueba).
 */
function pinnedClock(dir) {
  const file = path.join(dir, 'pinned-clock.js');
  fs.writeFileSync(file, [
    "'use strict';",
    'const Real = Date;',
    `const FIXED = Real.parse(${JSON.stringify(NOW)});`,
    'function Pinned(...a) {',
    '  if (!new.target) return new Real(FIXED).toString();',
    '  return a.length ? new Real(...a) : new Real(FIXED);',
    '}',
    'Pinned.prototype = Real.prototype;',
    'Pinned.now = () => FIXED;',
    'Pinned.parse = Real.parse;',
    'Pinned.UTC = Real.UTC;',
    'globalThis.Date = Pinned;',
    '',
  ].join('\n'));
  return [process.env.NODE_OPTIONS, `--require ${JSON.stringify(file)}`].filter(Boolean).join(' ');
}
const TOY_COPIES = ['scripts/nightly', 'scripts/lib', 'scripts/metrics'];
const TOY_REPOS = {
  azure: { org: 'https://dev.azure.com/acme' },
  repos: [
    { producto: 'acme', ruta: 'acme/forms', ado: 'Acme/forms', tipo: 'npm', activo: true },
    { producto: 'acme', ruta: 'acme/backend', ado: 'Acme/backend', tipo: 'nuget', activo: true },
    { producto: 'globex', ruta: 'globex/forms', ado: 'Globex/forms', tipo: 'npm', activo: true },
  ],
};
const TOY_DEPS_CARDS = { pending: ['aaaa1111', 'bbbb2222'], promoted: ['cccc3333'] };
const depsCard = (id, verdict) => `id: ${id}\ndetectado: ${TODAY}\nveredicto: ${verdict}\npaquete: pkg-${id}\nseveridad: high\nnoches: 3\nrepos:\n  - acme/forms\navisos:\n  - https://example.invalid/GHSA-${id}\n`;
const watcherCard = (id) => `id: "${id}"\nfecha: "${TODAY}"\nproducto: "acme"\nregla: "latido"\nhuella: "${id.slice(-8)}"\nseveridad: "media"\nplugin: "x"\ndiagnostico: "nada"\nveredicto: pendiente\n`;
const TOY_WATCHER_CARDS = { pending: [`${TODAY}-acme-dddd4444`], archived: [`${TODAY}-acme-eeee5555`] };
/** La foto de la noche de cada cola, con la forma de verdad: vive en `.dashboard/<cola vieja>/` y NO se muda. */
function writePhotos(root) {
  const deps = folderOf(QUEUE_DEPS).old;
  const watcher = folderOf(QUEUE_WATCHER).old;
  write(root, `.dashboard/${deps}/${deps}-${TODAY}.json`, JSON.stringify({
    fecha: TODAY, corrida_completa: true, linea_base: false, comparado_contra: null, repos_activos: 3, repos_apagados: 0, repos: [], no_medidos: [],
    hallazgos: [], presencias: [], anunciados_hoy: [], postergados_por_presupuesto: [], anexados: [], reaparecidos_ids: [], presupuesto: { tope: 2 },
    resueltos_ids: [], descartados_ids: [], aceptadas_sin_resolver: [], rechazadas_sin_deuda_ids: [], ignorados_ids: [],
    pedidos: { creados: [], fallidos: [] }, resumen: { canal: 'telegram', message_id: 1, entregado_el: `${TODAY}T04:00:00Z`, motivo: null }, cruce: { consultado: true },
  }));
  write(root, `.dashboard/${watcher}/${watcher}-${TODAY}.json`, JSON.stringify({
    fecha: TODAY, generado: `${TODAY}T08:00:00.000Z`, productos: {}, conteos: {}, hallazgos: [], no_medido: [], nuevos: 0, repetidos: 0,
    marcados_ignorados: 0, ignorados_ids: [], modo: 'normal', aviso: null, recordados: 0,
    resumen: { canal: 'telegram', message_id: 1, entregado_el: `${TODAY}T08:00:00Z`, motivo: null },
  }));
}
/**
 * Un arnés de juguete con los guiones nocturnos de verdad (copiados: cada uno arma sus rutas desde donde vive), fichas y
 * configuración inventadas. `layout`: 'new' = todo en las carpetas nuevas; 'old' = todo en las viejas (del mapa).
 */
function toyHarness(layout) {
  const base = tmp('toy');
  const root = path.join(base, 'team', 'harness');
  for (const d of TOY_COPIES) fs.cpSync(path.join(RAIZ, d), path.join(root, d), { recursive: true });
  // la configuración de verdad no viaja al juguete: productos inventados
  for (const f of CONFIG_FILES) fs.rmSync(path.join(root, DEPS_CONFIG, f), { force: true });
  fs.rmSync(path.join(root, 'scripts', 'nightly', 'watcher', 'hosts.json'), { force: true });
  const at = (dest) => (layout === 'new' ? dest : folderOf(dest).old);
  write(root, `${at(DEPS_CONFIG)}/repos.json`, JSON.stringify(TOY_REPOS, null, 1));
  write(root, `${at(DEPS_CONFIG)}/summary.json`, '{ "rubros_sin_fuente": {} }\n');
  for (const [sub, ids] of Object.entries(TOY_DEPS_CARDS)) for (const id of ids) write(root, `${at(QUEUE_DEPS)}/${sub}/${id}.yaml`, depsCard(id, sub === 'pending' ? 'pendiente' : 'util'));
  for (const [sub, ids] of Object.entries(TOY_WATCHER_CARDS)) for (const id of ids) write(root, `${at(QUEUE_WATCHER)}/${sub}/${id}.yaml`, watcherCard(id));
  writePhotos(root);
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env = cleanEnv({ HOME: home, TYCON_NO_NIGHTLY_EXAM: '1', NODE_OPTIONS: pinnedClock(base) });
  const run = (rel, args) => spawnSync(process.execPath, [path.join(root, rel), ...args], { cwd: base, encoding: 'utf8', env, timeout: 60000, maxBuffer: 1 << 26 });
  return { base, root, home, env, run };
}
/** El JSON que imprime el tablero en su modo que no escribe (antes y después imprime líneas de texto). */
function dashboardPanels(stdout) {
  const a = stdout.indexOf('\n{\n');
  const b = stdout.lastIndexOf('\n}\n');
  assert.ok(a >= 0 && b > a, `el tablero no imprimió su JSON:\n${stdout.slice(0, 400)}`);
  return JSON.parse(stdout.slice(a + 1, b + 2));
}
/** El valor por defecto del parámetro `productRegistry` de la plantilla (story 8.26, tanda C). */
function productRegistryDefault(text) {
  const m = /- name: productRegistry\s+type: string\s+default: '([^']+)'/.exec(text);
  return m ? m[1] : null;
}
/**
 * El `node -e` con que la plantilla lista las rutas de los repos a traer, tal cual está en el yml, y la lista que lee por
 * defecto (el `productRegistry` de la plantilla, que el snippet recibe como argumento).
 */
function fetchReposSnippet() {
  const text = fs.readFileSync(path.join(RAIZ, FETCH_REPOS_YML), 'utf8');
  const line = text.split('\n').find((l) => /new Set\(r\.map\(/.test(l));
  assert.ok(line, `${FETCH_REPOS_YML}: no encuentro el paso que lista las rutas de los repos`);
  const m = /node -e '([^']+)'/.exec(line);
  assert.ok(m, `${FETCH_REPOS_YML}: el paso que lista las rutas cambió de forma`);
  const registry = productRegistryDefault(text);
  assert.ok(registry, `${FETCH_REPOS_YML}: sin el valor por defecto de productRegistry`);
  return { snippet: m[1], registry };
}
/** Lo que cada guion encuentra, corrido con sus valores por defecto: sin `--pending` ni `--config`. */
function whatTheScriptsFind(toy) {
  const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
  const depsOut = path.join(toy.root, '.dashboard', folderOf(QUEUE_DEPS).old);
  const watcherWord = folderOf(QUEUE_WATCHER).old;   // el valor de --source de esa cola es su nombre de siempre
  const report = toy.run(SCRIPT_DEPS, ['report', '--json']);
  const clones = toy.run(SCRIPT_DEPS, ['clone-list']);
  const workItems = toy.run(SCRIPT_WORK_ITEMS, ['run', '--simulate', '--json', '--today', TODAY, '--out', depsOut]);
  const defaults = spawnSync(process.execPath, ['-e', 'const a = require(process.argv[1]).parseArgs(["node", "x", "run"]); console.log(JSON.stringify({ pending: a.pending, config: a.config }));',
    path.join(toy.root, SCRIPT_WORK_ITEMS)], { cwd: toy.base, encoding: 'utf8', env: toy.env, timeout: 60000 });
  const summaryDeps = toy.run(SCRIPT_SUMMARY, ['build', '--source', 'dependencies', '--today', TODAY, '--json']);
  const summaryWatcher = toy.run(SCRIPT_SUMMARY, ['build', '--source', watcherWord, '--today', TODAY, '--json']);
  const watcher = toy.run(scriptWatcher(), ['report', '--json']);
  const dashboard = toy.run(SCRIPT_DASHBOARD, ['--dry-run', '--json']);
  const { snippet, registry } = fetchReposSnippet();
  const fetch = spawnSync(process.execPath, ['-e', snippet, path.join(toy.root, registry)], { cwd: toy.root, encoding: 'utf8', env: toy.env, timeout: 60000 });
  const wiDefaults = json(defaults) || {};
  const sd = json(summaryDeps);
  const sw = json(summaryWatcher);
  let panels = null;
  try { panels = dashboardPanels(dashboard.stdout); } catch { panels = null; }
  return {
    raw: { report, clones, workItems, defaults, summaryDeps, summaryWatcher, watcher, dashboard, fetch },
    depsCards: (json(report) || {}).total,
    depsPending: (json(report) || {}).pendientes,
    clones: clones.status === 0 ? clones.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')[0]) : null,
    workItemsSays: workItems.stderr,
    workItemsPending: wiDefaults.pending ? list(path.join(wiDefaults.pending, 'pending')).filter((f) => f.endsWith('.yaml')).length : null,
    workItemsConfig: wiDefaults.config ? fs.existsSync(wiDefaults.config) : null,
    summaryDepsIds: sd ? (sd.rubros.vivas_por_proyecto.valor || []).flatMap((p) => p.ids).sort() : null,
    summaryWatcherIds: sw ? (sw.rubros.pendientes.valor || []).map((x) => x.id) : null,
    watcherCards: (json(watcher) || {}).total,
    dashboardProducts: panels && panels.extra && panels.extra.vigilados,
    fetched: fetch.status === 0 ? fetch.stdout.split('\n').filter(Boolean) : null,
  };
}
const TOY_ROUTES = [...new Set(TOY_REPOS.repos.map((r) => r.ruta))];
const TOY_PRODUCTS = new Set(TOY_REPOS.repos.map((r) => r.producto)).size;

test('T60b · BatchF_PipelinesParseAndDryRunsMatch — cada guion, sin --pending ni --config, encuentra las fichas y repos.json en la carpeta nueva', { skip: SKIP_PUBLIC }, () => {
  const toy = toyHarness('new');
  const f = whatTheScriptsFind(toy);
  const allDeps = Object.values(TOY_DEPS_CARDS).flat();
  const err = (r) => `rc=${r.status} ${r.stderr.slice(0, 300)}`;
  assert.strictEqual(f.depsCards, allDeps.length, `el nocturno de dependencias (report): ${err(f.raw.report)}`);
  assert.strictEqual(f.depsPending, TOY_DEPS_CARDS.pending.length, 'el nocturno de dependencias cuenta las pendientes');
  assert.deepStrictEqual(f.clones, TOY_ROUTES, `el nocturno de dependencias (clones) lee repos.json: ${err(f.raw.clones)}`);
  assert.match(f.workItemsSays, /sin token/, 'los pedidos de trabajo llegan hasta el token: leyeron repos.json y la foto de la noche');
  assert.doesNotMatch(f.workItemsSays, /no se pudo leer la configuración/);
  assert.strictEqual(f.workItemsPending, TOY_DEPS_CARDS.pending.length, 'los pedidos de trabajo: su --pending por defecto tiene las fichas');
  assert.strictEqual(f.workItemsConfig, true, 'los pedidos de trabajo: su --config por defecto existe');
  assert.deepStrictEqual(f.summaryDepsIds, [...allDeps].sort(), `el resumen de dependencias: ${err(f.raw.summaryDeps)}`);
  assert.deepStrictEqual(f.summaryWatcherIds, TOY_WATCHER_CARDS.pending, `el resumen de la mirada de producción: ${err(f.raw.summaryWatcher)}`);
  assert.strictEqual(f.watcherCards, Object.values(TOY_WATCHER_CARDS).flat().length, `la mirada de producción (report): ${err(f.raw.watcher)}`);
  assert.ok(f.dashboardProducts, `el tablero no midió los productos vigilados: ${err(f.raw.dashboard)}`);
  assert.deepStrictEqual([f.dashboardProducts.estado, f.dashboardProducts.total], ['medido', TOY_PRODUCTS], 'el tablero: la misma cantidad de productos que declara repos.json');
  assert.deepStrictEqual(f.fetched, TOY_ROUTES, `el paso que trae los repos: ${err(f.raw.fetch)}`);
  assert.deepStrictEqual(list(toy.home), [], 'ningún guion escribió en la HOME');
  // el generador del mapa público, contra el repo de verdad y sin escribir: su salida por defecto está en la carpeta nueva
  const check = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'tools', 'harness-map', 'public-version.js'), '--check'], { cwd: toy.base, encoding: 'utf8', env: toy.env, timeout: 60000 });
  assert.strictEqual(check.status, 0, `public-version.js --check: ${check.stdout.slice(0, 300)} ${check.stderr.slice(0, 300)}`);
});

test('T60b · laboratorio — con las fichas y repos.json en las carpetas viejas, ningún guion encuentra nada', { skip: SKIP_PUBLIC }, () => {
  const f = whatTheScriptsFind(toyHarness('old'));
  assert.strictEqual(f.depsCards, 0, 'el nocturno de dependencias no lee la cola vieja');
  assert.strictEqual(f.clones, null, 'sin repos.json en la carpeta nueva, clones no lista nada');
  assert.match(f.workItemsSays, /no se pudo leer la configuración/);
  assert.strictEqual(f.workItemsPending, 0);
  assert.strictEqual(f.workItemsConfig, false);
  assert.strictEqual(f.watcherCards, 0, 'la mirada de producción no lee la cola vieja');
  assert.ok(f.dashboardProducts && f.dashboardProducts.estado === 'no_medido', 'el tablero, sin repos.json, dice no medido');
  // por ESE motivo, no porque la foto de la noche se haya puesto vieja
  // el motivo es el del tablero publicado: sin repos.json dice que la lista de productos del equipo no vino (antes del
  // corte el repo del equipo decía «no hay productos declarados en repos.json»; desde el corte el texto es el del público)
  assert.match(String(f.dashboardProducts.motivo), /lista de productos del equipo no viene/, 'el tablero no mide porque no encontró repos.json');
  assert.strictEqual(f.fetched, null, 'el paso que trae los repos falla sin repos.json');
});

// ══ T61 · el aviso de arranque lee la carpeta nueva y la vieja ═══════════════════════════════════════════════════

const WAITING =/(\d+) hallazgo\(s\) esperando decisión/;
/**
 * Un arnés de juguete que es un repo git con su `origin/main`, como lee el aviso. `cards`: `{ carpeta: cuántas }`.
 * `published`: las fichas están en `origin/main` y NO en el disco; si no, están en el disco y NO en lo publicado
 * (así cada lectura sólo puede salir de su fuente). La foto de la noche va en los dos lados.
 */
function noticeToy({ cards = {}, published = true, photo = true } = {}) {
  const base = tmp('notice');
  const root = path.join(base, 'harness');
  const home = path.join(base, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const env = cleanEnv({ HOME: home, TYCON_NO_NIGHTLY_EXAM: '1', GIT_CONFIG_NOSYSTEM: '1', NODE_OPTIONS: pinnedClock(base) });
  const git = (...a) => {
    const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  };
  const plant = () => {
    for (const [folder, n] of Object.entries(cards)) {
      for (let i = 0; i < n; i++) write(root, `${folder}/pending/card${i}.yaml`, `id: card${i}\npaquete: pkg-${i}\nseveridad: high\nnoches: ${i + 1}\n`);
    }
  };
  git('init', '-q', '-b', 'main');
  write(root, 'README.md', 'juguete\n');
  if (photo) writePhotos(root);
  // el mapa viaja al disco del juguete (no a lo publicado): la carpeta vieja se toma del mapa, viva donde viva el aviso
  write(root, 'scripts/lib/renames.json', fs.readFileSync(MAP, 'utf8'));
  write(root, '.gitignore', 'scripts/\n');
  if (published) plant();
  git('add', '-A');
  git('commit', '-q', '-m', 'juguete');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (published) for (const folder of Object.keys(cards)) fs.rmSync(path.join(root, folder), { recursive: true, force: true });
  else plant();
  const noGit = path.join(base, 'no-hay-git');   // un git que no se puede ejecutar obliga a leer el disco
  const r = spawnSync(process.execPath, [path.join(RAIZ, SCRIPT_NOTICE)], {
    cwd: base, encoding: 'utf8', timeout: 60000,
    env: { ...env, TYCON_DEPS_REPO: root, TYCON_DEPS_NOW: NOW, ...(published ? {} : { TYCON_DEPS_GIT: noGit }) },
  });
  assert.strictEqual(r.status, 0, `el aviso salió ${r.status}: ${r.stderr}`);
  return { out: r.stdout, waiting: (WAITING.exec(r.stdout) || [])[1] || null, home };
}

test('T61a · BatchF_NoticesReadOldAndNew — con las fichas en la carpeta nueva o en la vieja, el aviso cuenta los hallazgos que esperan', { skip: SKIP_PUBLIC }, () => {
  const oldQueue = folderOf(QUEUE_DEPS).old;
  for (const [name, folder] of [['nueva', QUEUE_DEPS], ['vieja', oldQueue]]) {
    for (const published of [true, false]) {
      const where = `fichas en la carpeta ${name}, leídas de ${published ? 'lo publicado' : 'el disco'}`;
      const r = noticeToy({ cards: { [folder]: 2 }, published });
      assert.strictEqual(r.waiting, '2', `${where}: tiene que decir cuántos hallazgos esperan decisión —\n${r.out}`);
      assert.doesNotMatch(r.out, /no hay nada esperando decisión/, `${where}: un verde falso`);
      if (published) assert.doesNotMatch(r.out, /leído del disco/, `${where}: no leyó lo publicado`);
      else assert.match(r.out, /leído del disco/, `${where}: tiene que decir que leyó el disco`);
      assert.deepStrictEqual(list(r.home), [], 'el aviso no escribe en la HOME');
    }
  }
});

test('T61b · BatchF_NoticesReadOldAndNew — primero la carpeta nueva: con las dos, la vieja no se suma', { skip: SKIP_PUBLIC }, () => {
  const oldQueue = folderOf(QUEUE_DEPS).old;
  for (const published of [true, false]) {
    const r = noticeToy({ cards: { [QUEUE_DEPS]: 1, [oldQueue]: 3 }, published });
    assert.strictEqual(r.waiting, '1', `con las dos carpetas (${published ? 'publicado' : 'disco'}) cuenta la nueva —\n${r.out}`);
  }
});

test('T61c · BatchF_NoticesReadOldAndNew — sin ninguna de las dos carpetas no inventa números; la foto sigue en .dashboard/', { skip: SKIP_PUBLIC }, () => {
  for (const published of [true, false]) {
    const none = noticeToy({ published });
    assert.strictEqual(none.waiting, null, `sin fichas no hay número que decir —\n${none.out}`);
    assert.match(none.out, new RegExp(`\\(${TODAY}\\)`), 'la noche de la foto se sigue leyendo de .dashboard/ (no se mudó)');
    // laboratorio: las fichas en una carpeta que no es ni la nueva ni la vieja no se cuentan — el número sale de esas dos
    const elsewhere = noticeToy({ cards: { 'inbox/otra-cola': 2 }, published });
    assert.strictEqual(elsewhere.waiting, null, `fichas en otra carpeta no cuentan —\n${elsewhere.out}`);
  }
  // laboratorio: sin la foto de la noche el aviso calla (todavía no se estrenó), tenga las fichas que tenga
  const noPhoto = noticeToy({ cards: { [QUEUE_DEPS]: 2 }, photo: false });
  assert.strictEqual(noPhoto.out.trim(), '', 'sin foto en .dashboard/ no hay nada que cobrar');
});
