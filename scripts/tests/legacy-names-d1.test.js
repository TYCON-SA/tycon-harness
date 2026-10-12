'use strict';

/**
 * legacy-names-d1.test.js — configuración: archivos y claves en inglés (story 8.9, tanda D1 · 2026-10-01). T45, T46, T48.
 *
 * Lo que no se puede perder:
 *   · Los ocho archivos de configuración que lee sólo su propio repo se mudan una sola vez, con su entrada en el mapa; el
 *     que lee otra versión del arnés (el control de los bloques del CLAUDE.md lee el índice o el disco de otro repo) lo
 *     encuentra por cualquiera de los dos nombres, con sus claves viejas, y dos distintos son «no pude mirar» (T45).
 *   · Cada clave quedó como dice la clasificación commiteada: las de esquema y documentación, en inglés; las 38 con
 *     historia (ids de métricas, estados, causas, el id de fuente y la clave del techo de la 8.10), intactas; el recuento
 *     es el de la story y `schemaFiles` nombra cada archivo de esquema (con sus dos nombres si se mudó). `readKeysDeep`
 *     traduce en todos los niveles, nunca toca valores ni ids, y dos valores distintos son error (T46).
 *   · El paquete Bizuit sale sin nombres en castellano (T48).
 *
 * Los nombres viejos salen del mapa y de la clasificación en tiempo de ejecución (escritos acá, mantendrían vivos los
 * nombres en castellano que cuenta el termómetro). En la copia pública, sin el mapa del equipo, se saltea con motivo.
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
const SKIP_PUBLIC = !TEAM && 'copia pública: sin el mapa';
const CLASSES = path.join(__dirname, 'fixtures', 'legacy-names-d1', 'key-classes.tsv');
const WORDS = path.join(RAIZ, 'scripts', 'lib', 'spanish-words.json');

// Lo que decidió el dueño sobre la medición (story, bajo el AC 44): ocho archivos renombrados y el recuento de claves
// distintas por archivo.
const EXPECTED_RENAMED_FILES = 8;
const EXPECTED_COUNT = { key: 118, comment: 26, 'value-vocabulary': 38, path: 1 };
// Claves opcionales que hoy ninguna entrada usa (la 8.7 A sacó la última exclusión con vencimiento): `archivo\tclave` →
// quién la lee. La clave no se puede buscar en el archivo; se busca, con su nombre nuevo, en su lector.
const UNUSED_TODAY = new Map([['scripts/publishing/allowlist.json\tuntil', 'scripts/publishing/export.js']]);
const BUDGET_NEW = 'claude-md-blocks/budget.json';
const PACK = 'packs/bizuit/pack.json';

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
const rootOf = (repo) => (repo === 'agent-skills' ? SKILLS : RAIZ);
const entries = () => (TEAM ? JSON.parse(fs.readFileSync(MAP, 'utf8')).entries : []);
const d1 = () => entries().filter((e) => e.batch === 'D1');

function cleanEnv(extra) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD') e[k] = v;
  return { ...e, ...extra };
}
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `d1-${p}-`));

/** La clasificación commiteada: file (nuevo) · repo · json_path (nombres viejos) · old · new · class · reason. */
function classes() {
  const [head, ...rows] = fs.readFileSync(CLASSES, 'utf8').trim().split('\n').map((l) => l.split('\t'));
  assert.deepStrictEqual(head, ['file', 'repo', 'json_path', 'old', 'new', 'class', 'reason'], 'la cabecera de la clasificación cambió');
  return rows.map(([file, repo, jsonPath, old, nu, cls, reason]) => ({ file, repo, jsonPath, old, new: nu, cls, reason }));
}

/** Todas las claves de un objeto, en todos los niveles (los objetos dentro de listas también). */
function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) { v.forEach((x) => allKeys(x, out)); return out; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

// ── T45 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('T45a · BatchD_ConfigFilesBothNames — los ocho archivos se mudaron una vez, con su entrada en el mapa', { skip: SKIP_PUBLIC }, () => {
  const files = d1().filter((e) => e.kind === 'file');
  assert.strictEqual(files.length, EXPECTED_RENAMED_FILES, `archivos con batch D1: ${files.map((e) => e.old).join(', ')}`);
  for (const e of files) {
    assert.ok(/\.json$/.test(e.new), `${e.new}: la D1 sólo muda configuración`);
    assert.deepStrictEqual(e.callers, ['same-repo'], `${e.old}: lo lee sólo su repo (decisión del dueño); un llamador de afuera no va en la D1`);
    const root = rootOf(e.repo);
    if (e.repo === 'agent-skills' && !root) continue;   // sin agent-skills no se mira su lado
    assert.ok(fs.existsSync(path.join(root, e.new)), `${e.new} no existe`);
    assert.ok(!fs.existsSync(path.join(root, e.old)), `${e.old} sigue en el árbol: la mudanza es una sola`);
  }
});

/** Un repo de laboratorio con un bloque de 200 bytes y su techo por bloque en 50: frena (1) sólo si se leyó el techo. */
function budgetLab({ withNew, withOld, distinct, staged }) {
  const lab = tmp('budget');
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: lab, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  fs.mkdirSync(path.join(lab, 'claude-md-blocks'));
  fs.writeFileSync(path.join(lab, 'claude-md-blocks', 'lab-block.md'), `${'x'.repeat(199)}\n`);
  const fresh = { default: 10000, total: 100000, blocks: { 'lab-block': 50 } };
  const entry = d1().find((e) => e.kind === 'file' && e.new === BUDGET_NEW);
  assert.ok(entry, `el mapa no trae la mudanza de ${BUDGET_NEW}`);
  // la versión vieja trae el nombre viejo Y las claves viejas (las saca la clasificación, no se escriben acá)
  const oldKey = new Map(classes().filter((r) => r.file === BUDGET_NEW && r.cls !== 'value-vocabulary').map((r) => [r.new, r.old]));
  const toOld = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [oldKey.get(k) || k, v]));
  if (withNew) fs.writeFileSync(path.join(lab, BUDGET_NEW), JSON.stringify(fresh));
  if (withOld) {
    const old = distinct ? { ...fresh, blocks: { 'lab-block': 60 } } : fresh;
    fs.writeFileSync(path.join(lab, entry.old), JSON.stringify(toOld(old)));
  }
  if (staged) git('add', '-A');
  const args = [path.join(RAIZ, 'scripts', 'ci', 'check-claude-md-blocks.js'), '--repo', lab];
  if (staged) args.push('--staged');
  return spawnSync(process.execPath, args, { encoding: 'utf8', env: cleanEnv({ HOME: tmp('home') }) });
}

test('T45b · BatchD_ConfigFilesBothNames — el presupuesto de los bloques se lee por los dos nombres, con sus claves viejas', { skip: SKIP_PUBLIC }, () => {
  for (const staged of [false, true]) {
    const nu = budgetLab({ withNew: true, staged });
    assert.strictEqual(nu.status, 1, `sólo el nombre nuevo (${staged ? 'índice' : 'disco'}): el techo del bloque se lee y frena\n${nu.stdout}${nu.stderr}`);
    const old = budgetLab({ withOld: true, staged });
    assert.strictEqual(old.status, 1, `sólo el nombre viejo con claves viejas (${staged ? 'índice' : 'disco'}): otra versión del arnés también frena\n${old.stdout}${old.stderr}`);
    const same = budgetLab({ withNew: true, withOld: true, staged });
    assert.strictEqual(same.status, 1, `los dos con el mismo contenido: se lee uno\n${same.stdout}${same.stderr}`);
    const two = budgetLab({ withNew: true, withOld: true, distinct: true, staged });
    assert.strictEqual(two.status, 2, `los dos distintos (${staged ? 'índice' : 'disco'}): «no pude mirar», nunca un verde\n${two.stdout}${two.stderr}`);
    assert.match(two.stdout + two.stderr, /budget\.json/, 'el error nombra los dos archivos');
  }
});

// ── T46 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('T46a · BatchD_KeysClassifiedAndRecounted — cada clave quedó como dice su clase; el recuento es el de la story', { skip: SKIP_PUBLIC }, () => {
  const rows = classes();
  const distinct = {};
  for (const r of rows) (distinct[r.cls] = distinct[r.cls] || new Set()).add(`${r.file}\t${r.old}`);
  const count = Object.fromEntries(Object.entries(distinct).map(([c, s]) => [c, s.size]));
  assert.deepStrictEqual(count, EXPECTED_COUNT, 'el recuento de claves distintas por archivo no es el anotado en la story');

  const byFile = new Map();
  for (const r of rows) (byFile.get(r.file) || byFile.set(r.file, []).get(r.file)).push(r);
  for (const [file, rs] of byFile) {
    const repo = rs[0].repo;
    const root = rootOf(repo);
    if (repo === 'agent-skills' && !root) continue;
    const abs = path.join(root, file);
    assert.ok(fs.existsSync(abs), `${file} (${repo}) no existe`);
    const keys = allKeys(JSON.parse(fs.readFileSync(abs, 'utf8')));
    const kept = new Set(rs.filter((r) => r.cls === 'value-vocabulary').map((r) => r.old));
    for (const r of rs) {
      if (r.cls === 'value-vocabulary') {
        assert.ok(keys.has(r.old), `${file}: «${r.old}» tiene historia y no se renombra (${r.reason}), pero ya no está`);
      } else if (r.cls === 'path') {
        assert.ok(keys.has(r.new), `${file}: la clave que es una ruta sigue a su archivo («${r.new}»)`);
      } else {
        assert.ok(!kept.has(r.old), `${file}: «${r.old}» es esquema y también un id con historia en el mismo archivo — lo decide el dueño antes de renombrar`);
        assert.ok(!keys.has(r.old), `${file}: la clave «${r.old}» (${r.cls}) sigue en castellano; va «${r.new}»`);
        const reader = UNUSED_TODAY.get(`${file}\t${r.new}`);
        if (reader && !keys.has(r.new)) {
          // la clave es opcional y hoy ninguna entrada la usa: el nombre nuevo se mira en quien la lee
          const src = fs.readFileSync(path.join(root, reader), 'utf8');
          assert.match(src, new RegExp(`\\.${r.new}\\b`), `${reader} ya no lee «${r.new}» de ${file} (era «${r.old}», ${r.jsonPath})`);
          assert.doesNotMatch(src, new RegExp(`\\.${r.old}\\b\\s*(\\?|&&|\\))`), `${reader} lee «${r.old}» de ${file}: va «${r.new}»`);
          continue;
        }
        assert.ok(keys.has(r.new), `${file}: falta «${r.new}» (era «${r.old}», ${r.jsonPath})`);
      }
    }
  }
});

test('T46b · BatchD_KeysClassifiedAndRecounted — schemaFiles nombra cada archivo de esquema, con sus dos nombres si se mudó', { skip: SKIP_PUBLIC }, () => {
  const words = JSON.parse(fs.readFileSync(WORDS, 'utf8'));
  const schema = new Set(words.schemaFiles);
  const rows = classes();
  const files = [...new Set(rows.map((r) => r.file))];
  const moved = new Map(d1().filter((e) => e.kind === 'file').map((e) => [e.new, e.old]));
  for (const f of files) {
    const mixed = rows.some((r) => r.file === f && r.cls === 'value-vocabulary');
    if (mixed) continue;   // mezcla ids con historia: sus claves no se miran como nombres
    assert.ok(schema.has(f), `${f}: sus claves son esquema y no está en schemaFiles`);
    if (moved.has(f)) assert.ok(schema.has(moved.get(f)), `${f}: se mudó en la D1 y schemaFiles no lista su nombre viejo (el freno mide commits de antes)`);
  }
  assert.ok(schema.has(PACK), `${PACK} no está en schemaFiles: el termómetro no contaría sus claves (AC 44)`);
});

test('T46c · BatchD_KeysClassifiedAndRecounted — el termómetro no cuenta ninguna clave en castellano', { skip: SKIP_PUBLIC || (!SKILLS && 'sin agent-skills') }, () => {
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js'), '--count', '--json', '--repo', RAIZ],
    { encoding: 'utf8', env: cleanEnv({ TYCON_SKILLS_DIR: SKILLS }) });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  for (const [pkg, c] of Object.entries(j.packages)) assert.strictEqual(c.keys, 0, `${pkg}: quedan ${c.keys} clave(s) en castellano en los archivos de esquema`);
});

test('T46d · BatchD_KeysClassifiedAndRecounted — readKeysDeep traduce en todos los niveles y nunca toca valores ni ids', { skip: SKIP_PUBLIC }, () => {
  const { readKeysDeep, LegacyNamesError } = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
  assert.strictEqual(typeof readKeysDeep, 'function', 'legacy-names.js no exporta readKeysDeep');
  // palabras de laboratorio armadas por partes (AC 7): una clave vieja, su nueva, y un id que no está en el mapa
  const OLD = ['mot', 'ivo'].join('');
  const OLD2 = ['hast', 'a'].join('');
  const ID = ['en_', 'curso'].join('');
  const WHERE = 'lab/config.json';
  const map = { entries: [
    { kind: 'key', old: OLD, new: 'reason', where: WHERE, batch: 'D1' },
    { kind: 'key', old: OLD2, new: 'until', where: WHERE, batch: 'D1' },
    { kind: 'key', old: OLD, new: 'otro', where: 'lab/otro.json', batch: 'D1' },
  ] };
  const home = tmp('home');
  const o = { map, home };
  const input = { [OLD]: 'r1', list: [{ [OLD2]: '2026-12-31', [ID]: { [OLD]: OLD } }], [ID]: 3 };
  assert.deepStrictEqual(readKeysDeep(input, WHERE, o),
    { reason: 'r1', list: [{ until: '2026-12-31', [ID]: { reason: OLD } }], [ID]: 3 },
    'las claves viejas pasan a nuevas en todos los niveles; los ids y los valores quedan');
  assert.deepStrictEqual(input[OLD], 'r1', 'no modifica el objeto que recibe');
  assert.deepStrictEqual(readKeysDeep({ [OLD]: 'a', reason: 'a' }, WHERE, o), { reason: 'a' }, 'iguales: queda la nueva');
  assert.throws(() => readKeysDeep({ x: [{ [OLD]: 'a', reason: 'b' }] }, WHERE, o), (e) => e instanceof LegacyNamesError && e.message.includes(OLD) && e.message.includes('reason'),
    'distintos, aun anidados: error que nombra las dos');
  assert.deepStrictEqual(readKeysDeep({ [OLD]: 1 }, 'lab/nadie.json', o), { [OLD]: 1 }, 'otro where: no se toca');
  assert.deepStrictEqual(readKeysDeep(['a', 1], WHERE, o), ['a', 1], 'una lista de valores queda igual');
  assert.ok(fs.existsSync(path.join(home, '.claude', '.tycon-pipeline', 'legacy-names.jsonl')), 'el uso del nombre viejo se anota');
  const quiet = tmp('home');
  assert.deepStrictEqual(readKeysDeep({ [OLD]: 'r' }, WHERE, { map, home: quiet, record: false }), { reason: 'r' }, 'sin anotar, traduce igual');
  assert.ok(!fs.existsSync(path.join(quiet, '.claude', '.tycon-pipeline', 'legacy-names.jsonl')),
    'record: false (lo que se lee de una foto de git) no anota un uso: ensuciaría el registro que decide el retiro');
});

test('T46e · BatchD_KeysClassifiedAndRecounted — los frenos sobre un rango desde antes de la D1 no avisan «nombre viejo»', { skip: SKIP_PUBLIC || (!SKILLS && 'sin agent-skills'), timeout: 240000 }, (t) => {
  // la base de un rango anterior a la D1 trae la lista blanca y los manifiestos con las claves viejas: es historia, y en
  // Azure cada aviso sería un warning en el pull request (y un uso falso en el registro del retiro)
  const BASE = '1779dc1';
  if (spawnSync('git', ['-C', RAIZ, 'cat-file', '-e', `${BASE}^{commit}`]).status !== 0) { t.skip(`NO MEDIDO: el clon no trae ${BASE} (superficial)`); return; }
  const home = tmp('home');
  for (const script of ['new-names.js', 'spanish-names.js']) {
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'publishing', script), '--range', `${BASE}...HEAD`, '--repo', RAIZ],
      { encoding: 'utf8', env: cleanEnv({ HOME: home, TF_BUILD: 'True', TYCON_SKILLS_DIR: SKILLS }), maxBuffer: 64 * 1024 * 1024 });
    // Cualquiera de los dos frenos puede decir 1 sobre este rango y está bien: una excepción (del glosario, o de la lista
    // de nombres reales) cuenta sólo si ya estaba en la base, y la base es fija; toda excepción aprobada después (en su
    // PR aparte, como manda el freno) no existe para ella. Le pasó primero al de castellano y, con las tres excepciones de
    // la story 8.10.1 (los servidores y las entradas de llavero inventados de las pruebas del freno de producción), al de
    // nombres reales. Lo que esta prueba mide es el «nombre viejo»; lo que no puede pasar es que no haya podido mirar (2)
    assert.ok(r.status === 0 || r.status === 1, `${script} --range no pudo mirar (exit ${r.status}): ${r.stderr.slice(-1500)}`);
    assert.doesNotMatch(r.stderr, /nombre viejo/, `${script} --range ${BASE}...HEAD avisa nombres viejos al leer la base: ${r.stderr.split('\n').filter((l) => /nombre viejo/.test(l)).slice(0, 3).join(' | ')}`);
  }
  assert.ok(!fs.existsSync(path.join(home, '.claude', '.tycon-pipeline', 'legacy-names.jsonl')), 'leer la base anotó usos del nombre viejo');
});

// ── T48 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('T48 · BatchD_BizuitPackage — el paquete Bizuit sale sin nombres en castellano', { skip: SKIP_PUBLIC || (!SKILLS && 'sin agent-skills'), timeout: 240000 }, () => {
  const out = path.join(tmp('export'), 'copia');
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'publishing', 'export.js'), '--package', 'bizuit', '--output', out, '--json',
    '--harness', 'HEAD', '--agent-skills', 'HEAD'],
  { encoding: 'utf8', env: cleanEnv({ TYCON_SKILLS_DIR: SKILLS, TYCON_GUIDES_DIR: RAIZ }), maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `el exportador no armó la copia: ${r.stderr.slice(-2000)}`);
  const j = JSON.parse(r.stdout);
  assert.ok(j.spanishNames, 'la salida no trae spanishNames');
  assert.strictEqual(j.spanishNames.total, 0, `quedan nombres en castellano en el paquete Bizuit: ${JSON.stringify(j.spanishNames)}`);
  // la cuenta incluye las claves del manifiesto: si no estuviera en schemaFiles, «0» no diría nada de ellas
  const words = JSON.parse(fs.readFileSync(WORDS, 'utf8'));
  assert.ok(words.schemaFiles.includes(PACK), `${PACK} no está en schemaFiles`);
});
