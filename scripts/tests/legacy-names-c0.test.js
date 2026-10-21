'use strict';

/**
 * legacy-names-c0.test.js — antes de renombrar lo que llaman la máquina y el otro repo, la estructura destino. T63.
 *
 * Lo que no se puede perder:
 *   · Todo ejecutable que cambia de carpeta —también los que ya están en inglés— tiene su entrada en el mapa
 *     con sus llamadores MEDIDOS antes de renombrar. La lista sale de la tabla «Una sola mudanza por archivo» de la
 *     story y de `git ls-files`, nunca de una lista de esta prueba: un ejecutable nuevo en una de esas carpetas sin su
 *     entrada la pone en rojo.
 *   · Una entrada nace antes de su mudanza y no hace nada hasta que el archivo se mueve: `--stale-mentions` no marca la
 *     ruta vieja de algo que sigue ahí, y la marca en cuanto se mudó. Un archivo que sólo cambia de carpeta no se busca por
 *     su nombre suelto (su nombre sigue en la ruta nueva); uno que se renombra, sí.
 *
 * Los laboratorios usan nombres en inglés: esta prueba sale en la copia pública y el termómetro cuenta los nombres de
 * todo lo que se publica. La parte que lee el mapa y la story real se saltea en la copia pública (no viajan).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const SPANISH = path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js');
const MAP = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const STORY = path.join(RAIZ, 'specs', 'story-8.9-nombres-en-ingles.md');
const LEGACY = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));

const EXEC = /\.(js|mjs|cjs|sh|ps1|py|command)$/;
const isTest = (f) => /(^|\/)(tests?|__tests__)\/|\.test\./.test(f);
const TEAM = fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && fs.existsSync(MAP) && fs.existsSync(STORY);
const SKIP_PUBLIC = !TEAM && 'copia pública: sin el mapa ni la story';

function cleanEnv(extra) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD') e[k] = v;
  return { ...e, ...extra };
}
const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** Las filas de «Una sola mudanza por archivo» con una carpeta de hoy y su destino (la última, genérica, no nombra ruta). */
function movesFromStory() {
  const text = fs.readFileSync(STORY, 'utf8');
  const at = text.indexOf('**Una sola mudanza por archivo:**');
  assert.ok(at > 0, 'la story tiene la tabla «Una sola mudanza por archivo»');
  const rows = [];
  for (const line of text.slice(at).split('\n').slice(1)) {
    if (rows.length && !line.startsWith('|')) break;
    const m = line.match(/^\| `([^`]+)\/` \| (\w+) \| `([^`]+)\/` \|$/);
    if (m) rows.push({ old: m[1], batch: m[2], new: m[3] });
  }
  return rows;
}

// ── T63 · el mapa: cada cosa que se muda, con sus llamadores medidos ─────────────────────────────────────────────
test('T63 PreC1_CallersMeasuredForEveryMove — cada carpeta y cada ejecutable que se muda tiene su entrada con callers', { skip: SKIP_PUBLIC }, () => {
  const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  const entries = map.entries.filter((e) => e && (e.kind === 'file' || e.kind === 'folder') && (e.repo || 'arnes') === 'arnes');
  const byOld = new Map(entries.map((e) => [e.old.replace(/\/+$/, ''), e]));
  // El piso es sobre la TABLA (que la lectura la encuentre entera), no sobre cuántas carpetas viejas quedan en el disco:
  // cada etapa de la mudanza muda las suyas y ese número baja hasta cero.
  const rows = movesFromStory();
  assert.ok(rows.length >= 8, `la tabla «Una sola mudanza por archivo» trae sus filas (hay ${rows.length})`);
  const moves = rows.filter((m) => fs.existsSync(path.join(RAIZ, m.old)));   // lo ya mudado del todo no está en el disco
  const ls = git(RAIZ, 'ls-files').split('\n').filter(Boolean);
  const missing = [];
  const valid = (e) => Array.isArray(e.callers) && e.callers.length > 0 && e.callers.every((c) => LEGACY.CALLERS.includes(c));
  for (const m of moves) {
    const f = byOld.get(m.old);
    if (!f || f.kind !== 'folder' || f.new.replace(/\/+$/, '') !== m.new || !valid(f)) missing.push(`carpeta ${m.old} → ${m.new}`);
    for (const rel of ls.filter((x) => path.posix.dirname(x) === m.old && EXEC.test(x) && !isTest(x))) {
      const e = byOld.get(rel);
      if (!e || e.kind !== 'file' || !e.new.startsWith(`${m.new}/`) || !valid(e)) missing.push(`archivo ${rel} (a ${m.new}/)`);
    }
  }
  // los ejecutables en castellano sueltos en scripts/ salen de ahí al renombrarse: su entrada dice adónde
  const sn = require(SPANISH);
  const det = sn.makeDetector(sn.loadWords(fs.readFileSync(path.join(RAIZ, sn.WORDS_PATH), 'utf8'), sn.WORDS_PATH));
  const loose = ls.filter((x) => path.posix.dirname(x) === 'scripts' && EXEC.test(x)
    && det.isSpanish(path.posix.basename(x).replace(/\.[^.]+$/, '')).spanish);
  // cero sueltos es válido: ya se mudaron los dos últimos (captura.sh y smoke-examen.sh); el que aparezca, con su entrada
  for (const rel of loose) {
    const e = byOld.get(rel);
    if (!e || path.posix.dirname(e.new) === 'scripts' || !valid(e)) missing.push(`suelto ${rel} (carpeta por la regla 1)`);
  }
  assert.deepStrictEqual(missing, [], 'sin entrada, o sin callers medidos, o con otro destino');
});

test('T63 PreC1_CallersMeasuredForEveryMove — los llamadores de afuera medidos quedan en el mapa', { skip: SKIP_PUBLIC }, () => {
  const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  const byNew = new Map(map.entries.filter((e) => e && (e.kind === 'file' || e.kind === 'folder')).map((e) => [e.new.replace(/\/+$/, ''), e]));
  // lo que la medición encontró de afuera (veredicto a mano, línea por línea): el pre-commit de
  // agent-skills corre tres guiones de la carpeta de publicación y su pipeline lee un manifiesto de ahí; la skill de
  // alta de productos edita y corre el nocturno de dependencias
  for (const n of ['scripts/publishing', 'scripts/publishing/new-names.js', 'scripts/publishing/spanish-names.js',
    'scripts/publishing/third-party-coverage.js', 'scripts/nightly/dependencies', 'scripts/nightly/dependencies/nightly-dependencies.js']) {
    const e = byNew.get(n);
    assert.ok(e, `${n}: tiene entrada`);
    assert.ok(e.callers.includes('other-repo'), `${n}: lo llama agent-skills (${e.callers.join(', ')})`);
  }
});

test('T63 PreC1_CallersMeasuredForEveryMove — el mapa con las entradas todavía no movidas pasa --check-map', { skip: SKIP_PUBLIC }, () => {
  const skills = process.env.TYCON_SKILLS_DIR || path.join(os.homedir(), '.claude', 'agent-skills');
  if (!fs.existsSync(skills)) return;   // sin agent-skills, --check-map no puede mirar las entradas de allá
  const r = spawnSync(process.execPath, [SPANISH, '--check-map', '--repo', RAIZ], { encoding: 'utf8', env: cleanEnv({ TYCON_SKILLS_DIR: skills }) });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
});

// ── T63 · «mudada» no se decide en silencio: un error que no es «no existe» frena diciéndolo ─────────────────────────
test('T63 PreC1_CallersMeasuredForEveryMove — isMoved: un permiso denegado no es «ya no está»', { skip: process.getuid && process.getuid() === 0 && 'como root el permiso no se niega' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-c0-perm-'));
  fs.mkdirSync(path.join(root, 'target'), { recursive: true });
  fs.writeFileSync(path.join(root, 'target', 'new.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(root, 'locked'), { recursive: true });
  fs.writeFileSync(path.join(root, 'locked', 'old.js'), 'module.exports = 0;\n');
  fs.chmodSync(path.join(root, 'locked'), 0o000);
  try {
    // sin esto, el stat del viejo falla por permiso, se lee como «el viejo ya no está» y la entrada queda mudada
    assert.throws(() => LEGACY.isMoved({ kind: 'file', old: 'locked/old.js', new: 'target/new.js' }, root),
      (e) => e instanceof LEGACY.LegacyNamesError && /locked\/old\.js/.test(e.message) && /EACCES/.test(e.message), 'el viejo ilegible frena');
    assert.throws(() => LEGACY.isMoved({ kind: 'file', old: 'target/new.js', new: 'locked/old.js' }, root),
      (e) => e instanceof LEGACY.LegacyNamesError && /EACCES/.test(e.message), 'el nuevo ilegible también');
    // lo que de verdad no existe sigue siendo «no»
    assert.strictEqual(LEGACY.isMoved({ kind: 'file', old: 'nowhere/old.js', new: 'target/new.js' }, root), true);
    assert.strictEqual(LEGACY.isMoved({ kind: 'file', old: 'target/new.js', new: 'nowhere/new.js' }, root), false);
  } finally {
    fs.chmodSync(path.join(root, 'locked'), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── T63 · --stale-mentions respeta lo todavía no movido ──────────────────────────────────────────────────────────
function lab(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-c0-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), content);
  }
  git(d, 'init', '-q');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=a@b', '-c', 'user.name=lab', 'commit', '-qm', 'lab', '--no-verify');
  return d;
}
const stale = (arnes, skills) => spawnSync(process.execPath, [SPANISH, '--stale-mentions', '--repo', arnes, '--json'],
  { encoding: 'utf8', env: cleanEnv({ TYCON_SKILLS_DIR: skills }) });

test('T63 PreC1_CallersMeasuredForEveryMove — --stale-mentions: nada antes de la mudanza; la ruta vieja después; el nombre suelto sólo si cambia', () => {
  const entries = [
    { kind: 'folder', old: 'scripts/legacy-dir', new: 'scripts/nightly/target', batch: 'lab', callers: ['docs', 'same-repo'] },
    { kind: 'file', old: 'scripts/legacy-dir/keep-name.js', new: 'scripts/nightly/target/keep-name.js', batch: 'lab', callers: ['docs'] },
    { kind: 'file', old: 'scripts/legacy-dir/old-name.js', new: 'scripts/nightly/target/new-name.js', batch: 'lab', callers: ['docs'] },
  ];
  const map = `${JSON.stringify({ __about: 'mapa de laboratorio', retire_after: null, entries }, null, 2)}\n`;
  const arnes = lab({
    'scripts/lib/renames.json': map,
    'scripts/legacy-dir/keep-name.js': 'module.exports = 1;\n',
    'scripts/legacy-dir/old-name.js': 'module.exports = 2;\n',
    'guides/a.md': 'Correr `node scripts/legacy-dir/keep-name.js`.\n',
    'guides/b.md': 'El guion keep-name.js y el old-name.js, los dos.\n',
  });
  const skills = lab({ 'README.md': 'nada\n' });

  const before = stale(arnes, skills);
  assert.strictEqual(before.status, 0, `antes de mudar, la ruta vieja es la real: nada que marcar\n${before.stdout}${before.stderr}`);

  // primero se renombra UN archivo, directo a su destino final: la carpeta nueva ya existe, pero la vieja sigue
  // siendo la de verdad (keep-name.js está ahí) — sólo el nombre viejo del renombrado se marca
  fs.mkdirSync(path.join(arnes, 'scripts', 'nightly', 'target'), { recursive: true });
  git(arnes, 'mv', 'scripts/legacy-dir/old-name.js', 'scripts/nightly/target/new-name.js');
  git(arnes, '-c', 'user.email=a@b', '-c', 'user.name=lab', 'commit', '-qm', 'renombre', '--no-verify');
  const early = stale(arnes, skills);
  assert.strictEqual(early.status, 1, `el renombrado se marca\n${early.stdout}${early.stderr}`);
  const earlyFound = JSON.parse(early.stdout).findings.map((f) => `${f.rel}:${f.line} ${f.old}`).sort();
  assert.deepStrictEqual(earlyFound, ['guides/b.md:1 scripts/legacy-dir/old-name.js'], 'la carpeta vieja no cuenta como mudada mientras tenga archivos de verdad');
  const L = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
  assert.strictEqual(L.isMoved(entries[0], arnes), false, 'isMoved: la carpeta, todavía no');
  assert.strictEqual(L.isMoved(entries[2], arnes), true, 'isMoved: el archivo renombrado, sí');
  const rewrites = L.machineRewrites({ entries }, { guides: arnes, skills, home: os.homedir() });
  assert.ok(rewrites.length > 0 && rewrites.every((r) => r.to.endsWith('/new-name.js')), 'el instalador reescribe sólo el archivo mudado, nunca la carpeta');

  // el exportador mira el árbol del commit, no el disco: el mismo criterio (sus rutas viejas no pueden salir en la copia)
  const ex = require(path.join(RAIZ, 'scripts', 'publishing', 'export.js'));
  const viejasEn = (dir) => {
    const ctx = { repos: { arnes: { dir } }, arboles: { arnes: ex.listarArbol({ dir }, 'HEAD') } };
    return ex.nombresViejos(ctx).rutas.map((r) => r.ruta).sort();
  };
  assert.deepStrictEqual(viejasEn(arnes), ['scripts/legacy-dir/old-name.js'], 'exportador: sólo el renombrado; la carpeta todavía no');

  // la mudanza del resto: la carpeta a su destino; las guías todavía con lo viejo
  git(arnes, 'mv', 'scripts/legacy-dir/keep-name.js', 'scripts/nightly/target/keep-name.js');
  git(arnes, '-c', 'user.email=a@b', '-c', 'user.name=lab', 'commit', '-qm', 'mudanza', '--no-verify');
  assert.deepStrictEqual(viejasEn(arnes), ['scripts/legacy-dir', 'scripts/legacy-dir/keep-name.js', 'scripts/legacy-dir/old-name.js'], 'exportador: mudado todo');
  const after = stale(arnes, skills);
  assert.strictEqual(after.status, 1, `después de mudar, lo viejo se marca\n${after.stdout}${after.stderr}`);
  const found = JSON.parse(after.stdout).findings.map((f) => `${f.rel}:${f.line} ${f.old}`).sort();
  assert.ok(found.some((f) => f.startsWith('guides/a.md:1 ')), `la ruta vieja completa: ${found.join(' · ')}`);
  assert.ok(found.includes('guides/b.md:1 scripts/legacy-dir/old-name.js'), `el nombre suelto que cambió: ${found.join(' · ')}`);
  assert.ok(!found.includes('guides/b.md:1 scripts/legacy-dir/keep-name.js'), `el nombre suelto que NO cambió no se marca: ${found.join(' · ')}`);

  // con las guías al día (la ruta nueva nombra keep-name.js, que es el mismo nombre), limpio
  fs.writeFileSync(path.join(arnes, 'guides', 'a.md'), 'Correr `node scripts/nightly/target/keep-name.js`.\n');
  fs.writeFileSync(path.join(arnes, 'guides', 'b.md'), 'El guion keep-name.js y el new-name.js, los dos.\n');
  git(arnes, '-c', 'user.email=a@b', '-c', 'user.name=lab', 'commit', '-qam', 'guías', '--no-verify');
  const clean = stale(arnes, skills);
  assert.strictEqual(clean.status, 0, `${clean.stdout}${clean.stderr}`);
  for (const d of [arnes, skills]) fs.rmSync(d, { recursive: true, force: true });
});
