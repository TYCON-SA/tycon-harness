'use strict';

/**
 * legacy-names-c2.test.js — lo que llaman los productos y las guías, renombrado (story 8.9, tanda C2 · 2026-10-01).
 * T39 (T40 es manual: un pipeline de producto real corre verde una vez, por id).
 *
 * Lo que no se puede perder:
 *   · Los productos no se tocan hasta el retiro: sus pipelines llaman a los guiones de `scripts/ci` por el nombre viejo, y
 *     en producción lo hacen desde el artefacto `arnes-ci`, que es SÓLO esa carpeta (sin `scripts/lib` ni el mapa). El
 *     reemplazo de cada guion renombrado tiene que estar en el artefacto y andar ahí solo (T39a, T39b).
 *   · Un producto nuevo nace con los nombres nuevos: las plantillas de pipeline de la skill de alta (`new-product-templates/
 *     pipelines/`) no nombran ningún guion viejo de la tanda (T39c).
 *   · Las guías muestran sólo el nombre nuevo (T39d) y los pasos de un pipeline de producto real siguen dando lo mismo
 *     contra el árbol renombrado (T39e = T32 corrida otra vez).
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
const MAP = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const TEAM = fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && fs.existsSync(MAP);
const SKIP_PUBLIC = !TEAM && 'copia pública: sin el mapa';
const SHIM_MARK = 'tycon-legacy-shim:';

// Lo que el plan de la tanda aprobó (plan-c2.md): 30 ejecutables, 15 de ellos en scripts/ci.
const EXPECTED_FILES = 30;
const EXPECTED_CI = 15;

const entries = () => (TEAM ? JSON.parse(fs.readFileSync(MAP, 'utf8')).entries : []);
const c2Files = () => entries().filter((e) => e.kind === 'file' && e.batch === 'C2' && (e.repo || 'arnes') === 'arnes'
  && !/^scripts\/tests\//.test(e.old));
const c2Ci = () => c2Files().filter((e) => e.old.startsWith('scripts/ci/'));
const isShim = (abs) => fs.existsSync(abs) && fs.readFileSync(abs, 'utf8').split('\n').slice(0, 3).some((l) => l.includes(SHIM_MARK));

function cleanEnv(extra) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD') e[k] = v;
  return { ...e, ...extra };
}
/** El artefacto `arnes-ci` como lo arma el pipeline de un producto: sólo `scripts/ci`, copiado entero. */
function artifact() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-arnes-ci-'));
  fs.cpSync(path.join(RAIZ, 'scripts', 'ci'), dir, { recursive: true });
  return dir;
}

test('T39 · BatchC2_AllMoved — los 30 de la tanda están en el mapa y mudados: el nuevo existe, el viejo es su reemplazo', { skip: SKIP_PUBLIC }, () => {
  const files = c2Files();
  assert.strictEqual(files.length, EXPECTED_FILES, `ejecutables con batch C2 en el mapa: ${files.map((e) => e.old).join(', ')}`);
  assert.strictEqual(c2Ci().length, EXPECTED_CI, 'guiones de scripts/ci con batch C2');
  for (const e of files) {
    assert.ok(fs.existsSync(path.join(RAIZ, e.new)), `${e.new} no existe`);
    assert.ok(isShim(path.join(RAIZ, e.old)), `${e.old} no es el reemplazo generado`);
    const second = fs.readFileSync(path.join(RAIZ, e.old), 'utf8').split('\n').slice(0, 3).join('\n');
    assert.ok(second.includes(`${SHIM_MARK} ${e.new}`), `${e.old}: el reemplazo no apunta a ${e.new}`);
  }
});

test('T39a · BatchC2_ArtifactCarriesShims — el artefacto arnes-ci trae, por cada guion renombrado, el nuevo y el reemplazo', { skip: SKIP_PUBLIC }, () => {
  const art = artifact();
  try {
    assert.ok(c2Ci().length > 0, 'la tanda no tiene guiones de scripts/ci');
    for (const e of c2Ci()) {
      const rel = (p) => path.posix.relative('scripts/ci', p);
      assert.ok(fs.existsSync(path.join(art, rel(e.new))), `el artefacto no trae ${rel(e.new)}`);
      assert.ok(isShim(path.join(art, rel(e.old))), `el artefacto no trae el reemplazo ${rel(e.old)}`);
    }
  } finally { fs.rmSync(art, { recursive: true, force: true }); }
});

test('T39b · BatchC2_ShimRunsAloneInArtifact — en el artefacto solo, el nombre viejo corre el nuevo con los mismos argumentos y su código', { skip: SKIP_PUBLIC }, () => {
  const art = artifact();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-home-'));
  assert.strictEqual(c2Ci().length, EXPECTED_CI, 'guiones de scripts/ci con batch C2 (sin ellos no hay nada que correr)');
  try {
    for (const e of c2Ci()) {
      const rel = (p) => path.posix.relative('scripts/ci', p);
      const target = path.join(art, rel(e.new));
      // el guion nuevo, cambiado por un doble que dice qué recibió y sale con un código propio
      const js = /\.js$/.test(e.new);
      fs.writeFileSync(target, js
        ? "process.stdout.write('recibí:' + process.argv.slice(2).join('|') + '\\n'); process.exitCode = 7;\n"
        : '#!/usr/bin/env bash\nprintf \'recibí:%s\\n\' "$(IFS=\'|\'; echo "$*")"; exit 7\n');
      const old = path.join(art, rel(e.old));
      const cmd = js ? process.execPath : 'bash';
      const env = cleanEnv({ HOME: home, TF_BUILD: 'True', TYCON_GUIDES_DIR: path.join(home, 'no-hay-arnes') });
      const r = spawnSync(cmd, [old, 'uno', 'dos tres'], { encoding: 'utf8', env, cwd: art });
      assert.strictEqual(r.status, 7, `${rel(e.old)}: código ${r.status} (stderr: ${r.stderr})`);
      assert.strictEqual(r.stdout, 'recibí:uno|dos tres\n', `${rel(e.old)}: el nuevo no recibió los mismos argumentos`);
      assert.match(r.stderr, new RegExp(`##vso\\[task\\.logissue type=warning\\].*${e.new.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        `${rel(e.old)}: sin el aviso de nombre viejo en Azure`);
    }
  } finally {
    fs.rmSync(art, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('T39c · BatchC2_TemplatesUseNewNames — las plantillas de pipeline de un producto nuevo no nombran ningún guion viejo de la tanda', { skip: SKIP_PUBLIC }, () => {
  const dir = path.join(RAIZ, 'packs', 'bizuit', 'templates', 'pipelines');
  const ymls = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(ymls.length > 0, 'no hay plantillas de pipeline');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let usesNew = 0;
  for (const f of ymls) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const e of c2Ci()) {
      const oldBase = path.posix.basename(e.old);
      assert.doesNotMatch(text, new RegExp(`(?<![\\w.-])${esc(oldBase)}(?![\\w.-])`), `${f} nombra ${oldBase}`);
      if (text.includes(path.posix.basename(e.new))) usesNew++;
    }
  }
  assert.ok(usesNew > 0, 'las plantillas no nombran ningún guion nuevo de la tanda');
});

test('T39d · BatchC2_GuidesShowNewName — ninguna guía ni el README nombra un ejecutable viejo de la tanda', { skip: SKIP_PUBLIC }, () => {
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js'), '--stale-mentions', '--json', '--repo', RAIZ],
    { encoding: 'utf8', env: cleanEnv({}), maxBuffer: 1 << 26 });
  assert.ok(r.status === 0 || r.status === 1, `--stale-mentions no pudo mirar (exit ${r.status}): ${r.stderr}`);
  const found = JSON.parse(r.stdout);
  const list = found.findings;
  assert.ok(Array.isArray(list), `--stale-mentions --json sin «findings»: ${r.stdout.slice(0, 200)}`);
  // --stale-mentions sólo marca lo ya mudado: sin la tanda mudada, «nada que marcar» no dice nada
  assert.strictEqual(c2Files().filter((e) => isShim(path.join(RAIZ, e.old))).length, EXPECTED_FILES, 'la tanda no está mudada');
  const olds = new Set(c2Files().map((e) => e.old));
  const bases = new Set(c2Files().map((e) => path.posix.basename(e.old)));
  // cada hallazgo trae su archivo en `rel` (la forma de --stale-mentions): si el campo cambiara de nombre, este filtro
  // dejaría pasar todo en silencio — por eso se exige antes de filtrar (pase adversarial de la C2)
  for (const m of list) assert.ok(typeof m.rel === 'string' && typeof m.old === 'string', `hallazgo sin rel/old: ${JSON.stringify(m)}`);
  const isOurs = (m) => /\.md$/.test(m.rel) && (olds.has(m.old) || bases.has(path.posix.basename(m.old)));
  assert.ok(isOurs({ rel: 'README.md', old: c2Files()[0].old }), 'el filtro reconoce una mención vieja en una guía');
  const ours = list.filter(isOurs);
  assert.deepStrictEqual(ours.map((m) => `${m.rel}:${m.line} ${m.old}`), []);
});

test('T39e · BatchC2_ProductPipelineSameOutput — los pasos de un pipeline de producto real dan lo mismo contra el árbol renombrado (T32)', { skip: SKIP_PUBLIC }, (t) => {
  const r = spawnSync('bash', [path.join(RAIZ, 'scripts', 'tests', 'legacy-names-product-pipeline.test.sh')],
    { encoding: 'utf8', env: cleanEnv({}), maxBuffer: 1 << 26 });
  if (r.status === 2) { t.skip(`T32 NO MEDIDO: ${r.stdout.split('\n').filter(Boolean).pop()}`); return; }
  assert.strictEqual(r.status, 0, `T32 salió ${r.status}:\n${(r.stdout + r.stderr).split('\n').filter((l) => /❌|MAL|error/i.test(l)).join('\n')}`);
});

test('T39f · BatchC2_ProductSnapshotDoesNotBlockCopy — la foto de un pipeline de producto nombra guiones viejos a propósito y no frena la copia; una guía sí', { skip: SKIP_PUBLIC }, () => {
  const { mencionesViejas } = require(path.join(RAIZ, 'scripts', 'publishing', 'export.js'));
  const e = c2Ci()[0];
  assert.ok(e, 'la tanda no tiene guiones de scripts/ci');
  const viejos = { rutas: [{ ruta: e.old, nueva: e.new, carpeta: false, fuente: 'arnes' }] };
  const line = `bash ${e.old} --help`;
  const textos = new Map([
    ['arnes/scripts/tests/fixtures/product-pipeline/backend-azure-pipelines.yml', line],
    ['arnes/guides/una-guia.md', line],
  ]);
  assert.deepStrictEqual(mencionesViejas(textos, viejos).map((h) => h.archivo), ['arnes/guides/una-guia.md']);
});

test('T39g · BatchC2_ValueFollowsMovedFile — en la foto de antes, los valores de un archivo mudado se leen en su ruta vieja', () => {
  // laboratorio con nombres en inglés: el mapa muda tools/old.js → tools/new/tool.js y declara un valor en la ruta nueva
  const { extract } = require(path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js'));
  const renames = { entries: [
    { kind: 'file', old: 'scripts/tools/old.js', new: 'scripts/tools/new/tool.js', batch: 'C2', callers: ['docs'] },
    { kind: 'value', old: 'lab-old', new: 'lab-new', where: 'scripts/tools/new/tool.js', option: 'view', batch: 'B3a' },
  ] };
  const text = "const VIEW = { 'lab-old': 1 };\n";
  const names = (rel) => extract(rel, text, { renames }).filter((n) => n.category === 'value').map((n) => n.name);
  assert.deepStrictEqual(names('scripts/tools/new/tool.js'), ['lab-old'], 'en la ruta nueva');
  assert.deepStrictEqual(names('scripts/tools/old.js'), ['lab-old'], 'en la ruta vieja (la foto de antes de la mudanza)');
  assert.deepStrictEqual(names('scripts/tools/other.js'), [], 'en otro archivo, no');
});
