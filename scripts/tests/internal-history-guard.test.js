'use strict';

/**
 * internal-history-guard.test.js — el control de historia interna en la prosa que se publica (story 8.26, tanda G1 ·
 * AC 27 y 28 · T27 y T28).
 *
 * Lo que no se puede perder:
 *   · Que un commit que agrega una forma de historia interna a una guía no se cree (prendido), y que el mensaje diga el
 *     archivo, la línea y la forma sin repetir el texto.
 *   · Que no frene lo que ya estaba: retocar un párrafo, renombrar una guía, traer la otra rama en un merge. Y que sí
 *     frene lo que llega desde un archivo que no era prosa o no se publicaba.
 *   · Que «no pude mirar» sea 2 y nunca verde; que en modo aviso avise de verdad, y que bajarlo por variable se diga.
 *
 * Arma repos de juguete con git de verdad: uno con la forma del repo público (sin perfil: todo lo versionado se publica)
 * y uno con la forma del repo del equipo (perfil, lista blanca y tabla SINTÉTICAS: nunca lee las privadas, que en la
 * copia pública —donde esta suite también corre— no existen). Los registros van a una HOME temporal.
 *
 * Los ejemplos rojos se arman por partes (`j`): este archivo viaja, y `internal-history.test.js` no deja pasar un
 * número de pull request escrito de corrido en nada de lo publicado.
 */

const test = require('./lib/suite-parts.js').test;   // se corre en dos partes (ninguna suite pasa de 45 s): lib/suite-parts.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const GUARD = path.join(RAIZ, 'scripts', 'publishing', 'internal-history.js');
const ALLOWED = 'scripts/tests/fixtures/internal-history-allowed.json';
const ih = require(GUARD);
const { INTERNAL_START, INTERNAL_END } = require(path.join(RAIZ, 'scripts', 'publishing', 'public-copy.js'));
const j = (...parts) => parts.join('');

// ── los ejemplos, por partes ─────────────────────────────────────────────────────────────────────────────────────
const RED = {
  'product-story': j('la Story 4.2 de un producto', ' del equipo'),
  'pr-number': j('el PR', ' 1234'),
  'work-branch': j('story/', '8.26-G'),
  'incident-log': j('incident-log.md', '#caso-x'),
  'azure-run': j('la corrida #', '12511'),
  'private-commit': j('hasta el commit ', '`c6cbe1d4`'),
  'story-number': j('(story ', '8.12)'),
  'story-bare': j('desde la ', '8.9 es así'),
  'batch-code': j('en la tanda ', 'B2'),
  'owner-decision': j('(decisión del dueño, ', '2026-10-06)'),
  'debt-id': j('DEF-', '8.10.1-19-historia'),
  'case-label': j('Caso ', 'disparador: algo'),
};
const GREEN = {
  'product-story': 'una story que cerró sin su prueba, en un producto del equipo',
  'pr-number': 'un pull request, el pedido de cambio (2026-09-05)',
  'work-branch': 'la rama `story/<id>` o `feature/mi-cambio`',
  'incident-log': 'el registro de incidentes (`guides/incident-log.md`)',
  'azure-run': 'la corrida de la validación, con 12511 líneas (corrida 2026-05-23)',
  'private-commit': 'el commit que lo retiró',
  'story-number': 'una story, `story <N.M>`, la story que se implementa',
  'story-bare': 'la versión 3 de la lista',
  'batch-code': 'por tanda, cada tanda, la tanda siguiente',
  'owner-decision': 'pausa para decisión del dev',
  'debt-id': 'una deuda declarada, `DEF-<story>-<nombre>`',
  'case-label': 'Por qué: un caso real de uso',
};

// ── git del laboratorio: sin la configuración de la máquina ni las variables que git le pasa a sus hooks ─────────
function cleanEnv(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('TYCON_') && k !== 'NODE_TEST_CONTEXT') e[k] = v;
  return {
    ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    ...extra,
  };
}
function git(dir, args, { tolerate = false, env = {} } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { env: cleanEnv(env), encoding: 'utf8' });
  if (r.status !== 0 && !tolerate) throw new Error(`git ${args.join(' ')} (${dir}): ${r.stderr}`);
  return tolerate ? r : r.stdout.trim();
}
function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (content === null) { fs.rmSync(abs, { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}
const stage = (repo, files) => { write(repo, files); git(repo, ['add', '-A']); };
const commit = (repo, msg) => { git(repo, ['commit', '-q', '-m', msg]); return git(repo, ['rev-parse', 'HEAD']); };

const created = [];
test.after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); created.push(d); return d; };

/** La configuración de verdad con una forma en otro modo: una forma que hoy sólo avisa se prueba frenando, y al revés. */
function configWith(forms) {
  const real = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.json'), 'utf8'));
  for (const [form, mode] of Object.entries(forms)) real.forms[form] = { ...real.forms[form], mode };
  const file = path.join(tmp('internal-history-config'), 'config.json');
  fs.writeFileSync(file, JSON.stringify(real));
  return file;
}

/** El control, como lo corre el hook: parado en el repo, con la HOME del laboratorio. Prendido, salvo que se pida otra cosa. */
function guard(l, { args = [], env = {}, mode = 'block' } = {}) {
  const r = spawnSync(process.execPath, [GUARD, '--repo', l.repo, ...args], {
    cwd: l.repo, encoding: 'utf8',
    env: cleanEnv({ HOME: l.home, USERPROFILE: l.home, ...(mode ? { TYCON_INTERNAL_HISTORY: mode } : {}), ...env }),
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ── el laboratorio con la forma del repo público ─────────────────────────────────────────────────────────────────
const OLD_GUIDE = `# Vieja\n\nEsto quedó así ${RED['story-number']}.\nOtra línea.\n`;
function publicLab() {
  const dir = tmp('internal-history-public');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(dir, 'home'));
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, {
    'README.md': '# Arnés de juguete\n',
    'guides/a.md': '# Guía\n\nPrimera línea.\nSegunda línea.\n',
    'guides/old.md': OLD_GUIDE,
    'scripts/x.js': "'use strict';\nmodule.exports = 1;\n",
    'scripts/publishing/allowlist.json': { readerConventions: [{ path: 'tasks/todo.md', reason: 'prueba' }, { path: '.tycon/', reason: 'prueba' }] },
    'docs/note.md': `# Nota que no es prosa del alcance\n\n${RED['product-story']}.\n`,
  });
  git(repo, ['add', '-A']); commit(repo, 'base');
  return { dir, repo, home: path.join(dir, 'home') };
}

// ══ T27 · las formas ══════════════════════════════════════════════════════════════════════════════════════════════

test('InternalHistoryGuard_Scan_EachFormHasARedAndAGreen — cada forma ve su ejemplo rojo y deja pasar el verde', () => {
  const textual = Object.keys(ih.FORMS).filter((f) => f !== 'team-path');
  assert.deepStrictEqual(Object.keys(RED).sort(), textual.sort(), 'un rojo por cada forma de texto (si entra una forma, entra con su ejemplo)');
  for (const form of textual) {
    const red = ih.scan(`Una línea.\n${RED[form]}\n`, 'prose').filter((f) => f.form === form);
    assert.strictEqual(red.length, 1, `${form}: su rojo se ve una vez`);
    assert.strictEqual(red[0].line, 2, `${form}: en su línea`);
    assert.ok(RED[form].includes(red[0].value), `${form}: value es el texto encontrado`);
    assert.strictEqual(typeof red[0].col, 'number');
    assert.deepStrictEqual(ih.scan(GREEN[form], 'prose').filter((f) => f.form === form), [], `${form}: su verde pasa`);
  }
});

test('InternalHistoryGuard_Scan_FakeNamesAndPlaceholdersPass — los nombres de mentira y los marcadores no son historia', () => {
  const text = 'El cliente `acme` (`example.com`, «Cliente A») usa `story <N.M>` y `specs/<story>.md`.\nVer AC 3 y la story que se implementa.\n';
  assert.deepStrictEqual(ih.scan(text, 'prose'), []);
});

test('InternalHistoryGuard_Scan_ProductStoryCountsOnce — la story de un producto es un hallazgo, no dos', () => {
  const found = ih.scan(RED['product-story'], 'prose');
  assert.deepStrictEqual(found.map((f) => f.form), ['product-story'], 'el número de adentro no suma un story-number');
});

test('InternalHistoryGuard_Scan_CodeAndMessageZones_OnlyPrNumber — fuera de la prosa sólo el número de pull request', () => {
  const all = Object.values(RED).join('\n');
  for (const zone of ['code', 'message']) {
    assert.deepStrictEqual([...new Set(ih.scan(all, zone).map((f) => f.form))], ['pr-number'], zone);
  }
  assert.deepStrictEqual(ih.scan(j('story/', '8.26-G: ', '(story ', '8.26)'), 'message'), [], 'el número de una story del arnés pasa en una rama y en un mensaje');
  assert.deepStrictEqual(ih.ZONES, ['prose', 'code', 'message']);
});

test('InternalHistoryGuard_Scan_BadInputThrows — no poder mirar nunca es «sin hallazgos»', () => {
  assert.throws(() => ih.scan(null, 'prose'), TypeError);
  assert.throws(() => ih.scan('x', 'otra'), TypeError);
});

test('InternalHistoryGuard_ZoneOf_ProseByPath_WindowsSeparatorsToo — la zona sale de la ruta, con cualquier separador', () => {
  for (const p of ['guides/a.md', 'guides\\bizuit\\b.md', 'README.md', 'INSTALL.md', 'story-format.md', 'getting-started/mac.md',
    '.github/README.md', 'claude-md-blocks/x.md', 'skills/s/SKILL.md', 'commands/c.md', 'agents/a.md', 'packs/p/README.md']) {
    assert.strictEqual(ih.zoneOf(p), 'prose', p);
  }
  for (const p of ['scripts/x.js', 'scripts/README.md', 'guides/x.json', 'adapters/codex/agents/a.toml', 'adapters/README.md', 'pipelines/a.yml', 'tasks/x.md', 'docs/note.md']) {
    assert.strictEqual(ih.zoneOf(p), 'code', p);
  }
});

// ══ T27 · lo neto ═════════════════════════════════════════════════════════════════════════════════════════════════

test('InternalHistoryGuard_NetNewFormInGuide_Blocks_SaysFileLineForm_NotTheText — agregar una forma a una guía frena y dice dónde sin repetirla', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/a.md': `# Guía\n\nPrimera línea.\nPasó en ${RED['product-story']}.\n` });
  const r = guard(l);
  assert.strictEqual(r.code, 1, `un hallazgo es 1 (2 es «no pude mirar»)\n${r.out}`);
  assert.match(r.out, /guides\/a\.md:4\b[^\n]*product-story/, 'archivo, línea y forma');
  assert.ok(!r.out.includes('4.2'), `no repite el texto encontrado\n${r.out}`);
  assert.match(r.out, /internal-history-allowed\.json/, 'dice cómo se sale');
  assert.match(r.stdout, /^internal-history: findings=1 cannot_look=0 mode=block$/m, 'la línea de cuentas que lee la validación');
});

test('InternalHistoryGuard_FakeNamesAndCleanText_Pass — un commit limpio pasa callado', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/a.md': '# Guía\n\nEl cliente `acme` (`example.com`, «Cliente A») usa `story <N.M>`.\n' });
  const r = guard(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.stderr, '', 'sin hallazgos no dice nada');
});

test('InternalHistoryGuard_RetouchAndRename_Pass — retocar un párrafo que ya la traía o renombrar la guía no frena', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/old.md': OLD_GUIDE.replace('Otra línea.', 'Otra línea, retocada.').replace('Esto quedó así', 'Esto había quedado así') });
  assert.strictEqual(guard(l).code, 0, 'un retoque');
  git(l.repo, ['reset', '-q', '--hard']);
  git(l.repo, ['mv', 'guides/old.md', 'guides/renamed.md']);
  const r = guard(l);
  assert.strictEqual(r.code, 0, `un renombre de guía a guía\n${r.out}`);
});

test('InternalHistoryGuard_SecondCopyInSameFile_Blocks — otra más en el mismo archivo sí es nueva', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/old.md': `${OLD_GUIDE}Y otra vez ${RED['story-number']}.\n` });
  const r = guard(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/old\.md:5\b[^\n]*story-number/);
});

test('InternalHistoryGuard_MoveFromNonProse_Blocks — lo que llega desde un archivo que no era prosa es nuevo', () => {
  const l = publicLab();
  git(l.repo, ['mv', 'docs/note.md', 'guides/note.md']);
  const r = guard(l);
  assert.strictEqual(r.code, 1, `un git mv hacia la prosa trae la forma\n${r.out}`);
  assert.match(r.out, /guides\/note\.md:3\b[^\n]*product-story/);
});

test('InternalHistoryGuard_SameTextInCode_Passes — el mismo texto en un guion no es de este control', () => {
  const l = publicLab();
  stage(l.repo, { 'scripts/x.js': `'use strict';\n// ${RED['product-story']} ${RED['story-number']}\nmodule.exports = 1;\n`, 'docs/otra.md': `${RED['case-label']}\n` });
  const r = guard(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.stderr, '');
});

test('InternalHistoryGuard_Merge_OtherParentAlreadyHadIt_Passes — traer la otra rama no es agregar', () => {
  const l = publicLab();
  git(l.repo, ['checkout', '-q', '-b', 'otra']);
  stage(l.repo, { 'guides/b.md': `# B\n\n${RED['batch-code']}.\n` });
  commit(l.repo, 'otra: una guía con una forma (entró antes del control)');
  git(l.repo, ['checkout', '-q', 'main']);
  stage(l.repo, { 'guides/c.md': '# C\n\nLimpia.\n' });
  commit(l.repo, 'main: otra guía');
  git(l.repo, ['merge', '-q', '--no-ff', '--no-commit', 'otra']);
  const r = guard(l);
  assert.strictEqual(r.code, 0, `el merge ve lo que trae el otro padre como lo que ya estaba\n${r.out}`);
  // y lo que el merge agrega sobre los dos padres, sí
  stage(l.repo, { 'guides/c.md': `# C\n\nLimpia.\n${RED['debt-id']}\n` });
  assert.strictEqual(guard(l).code, 1, 'lo que no traía ningún padre es nuevo');
});

test('InternalHistoryGuard_CommitDashA_ReadsTheHookIndex — con `git commit -a` mira el índice del commit en curso', () => {
  const l = publicLab();
  const hook = path.join(l.repo, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  // las rutas con `/`: el hook lo corre el sh de git también en Windows, donde una `\` dentro de comillas es un escape
  const sh = (p) => p.split(path.sep).join('/');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${sh(process.execPath)}" "${sh(GUARD)}" --repo "$(git rev-parse --show-toplevel)"\n`, { mode: 0o755 });
  write(l.repo, { 'guides/a.md': `# Guía\n\n${RED['incident-log']}\n` });   // sin `git add`: sólo lo ve el índice del `-a`
  const env = { HOME: l.home, USERPROFILE: l.home, TYCON_INTERNAL_HISTORY: 'block' };
  const r = git(l.repo, ['commit', '-a', '-m', 'con una forma'], { tolerate: true, env });
  assert.notStrictEqual(r.status, 0, `el commit no se crea\n${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /guides\/a\.md:3\b[^\n]*incident-log/);
  write(l.repo, { 'guides/a.md': '# Guía\n\nLimpia.\n' });
  assert.strictEqual(git(l.repo, ['commit', '-a', '-m', 'limpio'], { tolerate: true, env }).status, 0, 'y uno limpio sí');
});

test('InternalHistoryGuard_DeclaredValue_Passes_OnlyInItsFileAndForm — un dato declarado pasa, con su archivo, su forma y su valor exacto', () => {
  const l = publicLab();
  const value = ih.scan(RED['story-number'], 'prose')[0].value;
  stage(l.repo, {
    [ALLOWED]: { allowed: [{ file: 'guides/a.md', form: 'story-number', value, reason: 'prueba: un ejemplo de salida' }] },
    'guides/a.md': `# Guía\n\nEjemplo de salida: ${RED['story-number']}\n`,
    'guides/c.md': `# C\n\n${RED['story-number']}\n`,
  });
  const r = guard(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(!/guides\/a\.md/.test(r.out), `el declarado pasa\n${r.out}`);
  assert.match(r.out, /guides\/c\.md:3\b[^\n]*story-number/, 'el mismo valor en otro archivo, no');
});

test('InternalHistoryGuard_Range_SameVerdictAsTheCommit — el diff de un pedido da lo mismo que el commit', () => {
  const l = publicLab();
  const base = git(l.repo, ['rev-parse', 'HEAD']);
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['private-commit']}\n` });
  commit(l.repo, 'con una forma (hecho sin el hook)');
  const r = guard(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/a\.md:3\b[^\n]*private-commit/);
  const none = guard(l, { args: ['--range', 'HEAD...HEAD'] });
  assert.strictEqual(none.code, 0, none.out);
  assert.match(none.out, /no medido/i, 'un rango sin commits no es «limpio»: lo dice');
});

test('InternalHistoryGuard_TeamPath_PublicMode — una ruta bajo una carpeta que no es pública; las del lector pasan', () => {
  const l = publicLab();
  stage(l.repo, {
    'guides/a.md': ['# Guía', '',
      j('Ver `inbox/', 'watcher/README.md` y `artifacts/', 'mapa.html`.'),
      'Tu `tasks/todo.md`, tu `.tycon/advisors.yaml`, `specs/<story>.md`, `scripts/x.js` y `guides/old.md` están bien.',
      // con el prefijo del arnés instalado se ve igual (en el repo del equipo el exportador también lo reconoce)
      j('Y `~/.claude/tycon-harness/onboarding/', 'datos.md` tampoco está.'),
      // límite conocido del repo público: una ruta de una carpeta pública que no existe no se distingue de un ejemplo
      'Y `scripts/mi-hook.js` o `scripts/devhost.sh` son del repo de quien lee.',
      ''].join('\n'),
  });
  const r = guard(l, { args: ['--config', configWith({ 'team-path': 'block' })] });
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual((r.out.match(/guides\/a\.md:3\b[^\n]*team-path/g) || []).length, 2, `las dos rutas de la línea 3\n${r.out}`);
  assert.match(r.out, /guides\/a\.md:5\b[^\n]*team-path/, 'la escrita con el prefijo del arnés instalado');
  assert.ok(!/guides\/a\.md:[46]/.test(r.out), `las del lector, un marcador, las que existen y las de una carpeta pública pasan\n${r.out}`);
});

test('InternalHistoryGuard_NoConfig_IsTwo — sin su configuración no pudo mirar', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/a.md': '# Guía\n\nLimpia, pero tocada.\n' });
  const r = guard(l, { args: ['--config', path.join(l.dir, 'no-existe.json')] });
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/i);
  assert.match(r.stdout, /^internal-history: findings=0 cannot_look=1 mode=block$/m);
});

test('InternalHistoryGuard_NothingProseTouched_QuietAndCheap — sin prosa entre lo tocado no carga nada', () => {
  const l = publicLab();
  stage(l.repo, { 'scripts/x.js': "'use strict';\nmodule.exports = 2;\n" });
  // ni siquiera lee su configuración: con una que no existe, igual pasa
  const r = guard(l, { args: ['--config', path.join(l.dir, 'no-existe.json')] });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.stderr, '');
});

// ══ T27 · el repo del equipo ══════════════════════════════════════════════════════════════════════════════════════

const TEAM_LIST = {
  __doc: 'Lista blanca de laboratorio.',
  packages: {
    core: {
      arnes: {
        in: ['README.md', 'guides/**', 'scripts/**', 'adapters/**'],
        out: [{ glob: 'guides/fuera.md', reason: 'prueba: queda afuera' }, { glob: 'scripts/publishing/public-files/**', reason: 'prueba: los papeles llegan por un sintético' },
          { glob: 'scripts/publishing/replacements.json', reason: 'prueba: privada' }],
      },
      'agent-skills': { in: ['agents/*.md', 'skills/tycon-*/**'], out: [{ glob: 'packs/**', reason: 'prueba: viajan con su paquete' }] },
    },
    // un segundo paquete con su revisor: su sección del catálogo sale del núcleo y queda pendiente para la copia que los une
    bizuit: {
      arnes: { in: [], out: [] },
      'agent-skills': { in: ['packs/bizuit/pack.json', 'agents/revisor-publico.md'], out: [] },
    },
  },
  suitesOutside: [],
  casesOutside: [],
  empty: {},
  readerConventions: [{ path: 'tasks/todo.md', reason: 'prueba' }, { path: 'specs', reason: 'prueba' }],
  synthetic: [{ target: 'getting-started/mac.md', from: 'scripts/publishing/public-files/getting-started/mac.md', packages: ['core'], reason: 'prueba: un papel' }],
};
function teamLab() {
  const dir = tmp('internal-history-team');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(dir, 'home'));
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, {
    'README.md': '# Arnés de juguete\n',
    'perfil-equipo.json': '{}\n',
    'guides/a.md': '# Guía\n\nPrimera línea.\n',
    'guides/fuera.md': `# Fuera\n\n${RED['product-story']}\n`,
    'scripts/x.js': "'use strict';\nmodule.exports = 1;\n",
    'scripts/publishing/allowlist.json': TEAM_LIST,
    'scripts/publishing/replacements.json': { pares: [], afuera: [] },
    'scripts/publishing/denylist.json': { terminos: [], permitidos: [] },
    'scripts/publishing/public-files/getting-started/mac.md': '# En Mac\n\nPrimeros pasos.\n',
    'tasks/plan.md': '# Plan\n',
    'tasks/todo.md': '# Pendientes\n',
    'specs/story-1.md': '# Story\n',
    'agents/revisor.md': '---\nname: revisor\ndescription: Revisor de laboratorio\n---\n\nRevisa.\n',
    'agents/revisor-publico.md': '---\nname: revisor-publico\ndescription: Revisor de un paquete\n---\n\nRevisa lo del paquete.\n',
    'packs/bizuit/pack.json': { name: 'bizuit', reviewers: [{ agent: 'revisor-publico', group: 'base' }] },
    'guides/advisor-rules-catalog.md': ['# Catálogo', '', 'Intro.', '', '## Núcleo — `revisor`', '', 'Reglas NUC-C1.', '', '## Público — `revisor-publico`', '', 'Reglas PUB-C1.', ''].join('\n'),
    'adapters/codex/agents/MANIFEST.json': { advisors: ['revisor', 'revisor-publico'] },
    'adapters/codex/agents/revisor.toml': 'name = "revisor"\n',
    'skills/tycon-pipeline/SKILL.md': '# Pipeline\n',
    '.tycon/post-commit-ignore': 'skills/x-*\n',
  });
  git(repo, ['add', '-A']); commit(repo, 'base: el repo unido de juguete');
  return { dir, repo, home: path.join(dir, 'home') };
}

test('InternalHistoryGuard_Team_ProfileWithoutTheTable_IsTwo — un clon del equipo sin la tabla no es el repo público', () => {
  const l = teamLab();
  stage(l.repo, { 'scripts/publishing/replacements.json': null, 'guides/a.md': `# Guía\n\n${RED['story-number']}\n` });
  const r = guard(l);
  assert.strictEqual(r.code, 2, `con perfil y sin tabla no se sabe qué sale\n${r.out}`);
  assert.match(r.out, /no pude mirar/i);
  // borrar SÓLO la tabla (ningún `.md` tocado) tampoco pasa callado: es de lo que decide qué se publica
  git(l.repo, ['reset', '-q', '--hard']);
  stage(l.repo, { 'scripts/publishing/replacements.json': null });
  const only = guard(l);
  assert.strictEqual(only.code, 2, only.out);
  assert.ok(!/looked=0/.test(only.stdout), 'no es «nada que mirar»');
});

test('InternalHistoryGuard_Team_NotTheUnifiedTree_IsTwo_AndBrokenMarkersAreLookedWhole — lo que no se puede clasificar es 2; un bloque interno mal cerrado no esconde nada', () => {
  let l = teamLab();
  stage(l.repo, { 'skills/tycon-pipeline/SKILL.md': null, 'guides/a.md': '# Guía\n\nTocada.\n' });
  const r = guard(l);
  assert.strictEqual(r.code, 2, `sin las skills adentro no es el repo unido: no se sabe qué sale\n${r.out}`);
  l = teamLab();
  stage(l.repo, { 'guides/a.md': ['# Guía', '', INTERNAL_START, RED['debt-id'], '', 'Sin cierre.', ''].join('\n') });
  const broken = guard(l);
  assert.strictEqual(broken.code, 1, `con el marcador roto el archivo se mira entero\n${broken.out}`);
  assert.match(broken.out, /guides\/a\.md:4\b[^\n]*debt-id/);
});

test('InternalHistoryGuard_Team_OnlyWhatShips_AsItShips — mira lo que sale, como sale: ni lo de afuera ni un bloque interno', () => {
  const l = teamLab();
  stage(l.repo, {
    'guides/fuera.md': `# Fuera\n\n${RED['product-story']}\n${RED['case-label']}\n`,   // no sale: no se mira
    'tasks/plan.md': `# Plan\n\n${RED['story-number']}\n`,                              // no sale
    'guides/a.md': ['# Guía', '', 'Primera línea.', '', INTERNAL_START, RED['story-number'], INTERNAL_END, '', 'Última.', ''].join('\n'),
  });
  const quiet = guard(l);
  assert.strictEqual(quiet.code, 0, `nada de eso se publica\n${quiet.out}`);
  stage(l.repo, { 'guides/a.md': ['# Guía', '', 'Primera línea.', '', INTERNAL_START, 'Sólo adentro.', INTERNAL_END, '', RED['owner-decision'], ''].join('\n') });
  const r = guard(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/a\.md:9\b[^\n]*owner-decision/, 'la línea es la del archivo real, no la del texto sin el bloque');
});

test('InternalHistoryGuard_Team_PaperCountsWithItsDestination — un papel es prosa por la ruta de su destino', () => {
  const l = teamLab();
  stage(l.repo, { 'scripts/publishing/public-files/getting-started/mac.md': `# En Mac\n\n${RED['batch-code']}\n` });
  const r = guard(l);
  assert.strictEqual(r.code, 1, `scripts/… no es prosa, pero sale como getting-started/mac.md\n${r.out}`);
  assert.match(r.out, /scripts\/publishing\/public-files\/getting-started\/mac\.md:3\b[^\n]*batch-code/, 'informa el archivo que hay que editar');
});

test('InternalHistoryGuard_Team_FileThatStartsShipping_IsLookedAtWhole — sacar un «out» publica el archivo entero', () => {
  const l = teamLab();
  const list = JSON.parse(JSON.stringify(TEAM_LIST));
  list.packages.core.arnes.out = list.packages.core.arnes.out.filter((o) => o.glob !== 'guides/fuera.md');
  stage(l.repo, { 'scripts/publishing/allowlist.json': list });
  const r = guard(l);
  assert.strictEqual(r.code, 1, `el commit no toca la guía, pero la publica\n${r.out}`);
  assert.match(r.out, /guides\/fuera\.md:3\b[^\n]*product-story/);
});

test('InternalHistoryGuard_Team_TeamPath_WhatTheExporterWouldMark — una ruta del repo del equipo que no sale', () => {
  const l = teamLab();
  stage(l.repo, {
    'guides/a.md': ['# Guía', '',
      j('El plan está en `tasks/', 'plan.md` y la tabla en `scripts/publishing/', 'replacements.json`.'),
      'Tu `tasks/todo.md`, `specs`, `specs/planning/x.md` (no existe acá) y `scripts/x.js` (sale) pasan.',
      ''].join('\n'),
  });
  const r = guard(l, { args: ['--config', configWith({ 'team-path': 'block' })] });
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual((r.out.match(/guides\/a\.md:3\b[^\n]*team-path/g) || []).length, 2, r.out);
  assert.ok(!/guides\/a\.md:4/.test(r.out), r.out);
});

// Lo que la publicación misma escribe en la copia (la lista blanca, `generated`: version.json) está en ella: una guía que
// lo nombra no nombra un archivo del equipo. 🔴 rojo previo: banco 13618, grupo C — las guías y el skill de merge que
// hablan de version.json salían como `team-path` (la copia se armaba sin lo generado).
test('InternalHistoryGuard_Team_TeamPath_GeneratedTargetIsInTheCopy — version.json, escrito al publicar, no es del equipo', () => {
  const l = teamLab();
  const guia = ['# Guía', '', 'La versión de la copia vive en `version.json`.', ''].join('\n');
  const conGenerado = JSON.parse(JSON.stringify(TEAM_LIST));
  conGenerado.generated = [{ target: 'version.json', reason: 'prueba: lo escribe la publicación' }];
  stage(l.repo, { 'version.json': { version: '2030.01.01.1' }, 'scripts/publishing/allowlist.json': conGenerado, 'guides/a.md': guia });
  const r = guard(l, { args: ['--config', configWith({ 'team-path': 'block' })] });
  assert.strictEqual(r.code, 0, `lo generado está en la copia\n${r.out}`);
  // el mismo archivo sin la declaración sí es del equipo: la excepción la da `generated`, no el nombre
  stage(l.repo, { 'scripts/publishing/allowlist.json': TEAM_LIST });
  const sin = guard(l, { args: ['--config', configWith({ 'team-path': 'block' })] });
  assert.strictEqual(sin.code, 1, sin.out);
  assert.match(sin.out, /guides\/a\.md:3\b[^\n]*team-path/);
});

// ══ T28 · los modos, la constancia y la cuenta ═══════════════════════════════════════════════════════════════════

test('InternalHistoryGuard_ModeTable_Unit — el modo efectivo: lo escrito, la variable, y lo que no se entiende', () => {
  const m = (written, env) => ih.effectiveMode({ mode: written }, env === undefined ? {} : { TYCON_INTERNAL_HISTORY: env });
  assert.deepStrictEqual(m('warn'), { mode: 'warn', lowered: false, odd: false });
  assert.deepStrictEqual(m('block'), { mode: 'block', lowered: false, odd: false });
  assert.deepStrictEqual(m('warn', 'block'), { mode: 'block', lowered: false, odd: false });
  assert.deepStrictEqual(m('block', 'warn'), { mode: 'warn', lowered: true, odd: false });
  assert.deepStrictEqual(m('block', '0'), { mode: 'off', lowered: true, odd: false });
  assert.deepStrictEqual(m('warn', '0'), { mode: 'off', lowered: true, odd: false });
  assert.deepStrictEqual(m('warn', 'quizás'), { mode: 'block', lowered: false, odd: true }, 'un valor que no se entiende falla cerrado');
  assert.strictEqual(ih.effectiveMode({ mode: 'otro' }, {}).mode, 'block', 'un modo escrito que no se entiende, también');
});

test('InternalHistoryGuard_Warn_SaysItAndExitsZero_SwitchLoweringIsSaid — avisando avisa de verdad, y bajarlo por variable se dice', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['story-number']}\n` });
  const warn = guard(l, { mode: 'warn' });
  assert.strictEqual(warn.code, 0, warn.out);
  assert.match(warn.stderr, /guides\/a\.md:3\b[^\n]*story-number/, 'dice lo mismo que diría frenando');
  assert.match(warn.stderr, /avisa/i);
  assert.match(warn.stdout, /^internal-history: findings=1 cannot_look=0 mode=warn$/m);
  const off = guard(l, { mode: '0' });
  assert.strictEqual(off.code, 0);
  assert.match(off.stderr, /apagado/i, 'apagado, lo dice en cada commit');
  assert.ok(!/guides\/a\.md/.test(off.out));
  const odd = guard(l, { mode: 'quizás' });
  assert.strictEqual(odd.code, 1, 'un valor raro frena');
  assert.match(odd.stderr, /no entiendo/i);
  // «no pude mirar» avisando: fuerte, y sale 0
  const cannot = guard(l, { mode: 'warn', args: ['--config', path.join(l.dir, 'no-existe.json')] });
  assert.strictEqual(cannot.code, 0, cannot.out);
  assert.match(cannot.stderr, /no pude mirar/i);
  assert.match(cannot.stdout, /^internal-history: findings=0 cannot_look=1 mode=warn$/m);
  // bajar por variable lo que la configuración escribe más alto se dice
  const blockConfig = path.join(l.dir, 'block.json');
  const real = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.json'), 'utf8'));
  fs.writeFileSync(blockConfig, JSON.stringify({ ...real, mode: 'block' }));
  const lowered = guard(l, { mode: 'warn', args: ['--config', blockConfig] });
  assert.strictEqual(lowered.code, 0);
  assert.match(lowered.stderr, /TYCON_INTERNAL_HISTORY/, 'nombra la variable que lo bajó');
  const written = guard(l, { mode: null, args: ['--config', blockConfig] });
  assert.strictEqual(written.code, 1, 'sin variable manda lo escrito');
});

test('InternalHistoryGuard_FormInWarn_NeverBlocks — una forma que quedó sólo como aviso no frena aunque el control frene', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['story-bare']}\n` });
  const r = guard(l, { args: ['--config', configWith({ 'story-bare': 'warn' })] });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.stderr, /guides\/a\.md:3\b[^\n]*story-bare/, 'avisa igual');
  assert.match(r.stdout, /^internal-history: findings=0 cannot_look=0 mode=block warnings=1$/m);
});

test('InternalHistoryGuard_CountLine_WrittenWithoutTheText — cada corrida con algo deja una línea de cuentas, nunca el texto', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['product-story']}\n${RED['batch-code']}\n` });
  assert.strictEqual(guard(l, { mode: 'warn' }).code, 0);
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name === 'internal-history.jsonl') found.push(path.join(d, e.name));
    }
  })(l.home);
  assert.strictEqual(found.length, 1, 'un registro en la carpeta del estado');
  const lines = fs.readFileSync(found[0], 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(lines[0].forms, { 'product-story': 1, 'batch-code': 1 });
  assert.strictEqual(lines[0].mode, 'warn');
  assert.strictEqual(lines[0].blocked, false);
  // sin el texto encontrado: los dos fragmentos se buscan FUERA de la hora (`ts`, con milésimas: «…:24.215Z» contiene
  // «4.2» y la prueba salía roja de a ratos en public-ci) y las dos frases enteras, en todo el renglón
  const sinTexto = (linea) => {
    const { ts, ...resto } = linea;
    const todo = JSON.stringify(linea);
    return !JSON.stringify(resto).includes('4.2') && !JSON.stringify(resto).includes('B2') && !todo.includes('Story 4.2') && !todo.includes('tanda B2');
  };
  assert.ok(sinTexto({ ...lines[0], ts: '2026-10-14T11:14:24.215Z' }), 'una hora con «4.2» no es el texto encontrado');
  assert.ok(!sinTexto({ ...lines[0], forms: { 'product-story': 'la Story 4.2' } }), 'espejo: el texto en un campo sí se ve');
  assert.ok(sinTexto(lines[0]), 'sin el texto encontrado');
  // un commit limpio no escribe nada (con el control como está escrito: bajado por la variable sí deja su línea)
  git(l.repo, ['reset', '-q', '--hard']);
  stage(l.repo, { 'guides/a.md': '# Guía\n\nLimpia.\n' });
  guard(l, { mode: null });
  assert.strictEqual(fs.readFileSync(found[0], 'utf8').trim().split('\n').length, 1);
});

test('InternalHistoryGuard_All_CountsByFormAndFile_NeverBlocks — la cuenta de todo lo que se publica', () => {
  const l = publicLab();
  const r = guard(l, { args: ['--all', '--json'] });
  assert.strictEqual(r.code, 0, r.out);
  const d = JSON.parse(r.stdout);
  assert.strictEqual(d.mode, 'public');
  assert.deepStrictEqual(d.forms, { 'story-number': 1 });
  assert.deepStrictEqual(d.files, { 'guides/old.md': { 'story-number': 1 } });
  assert.strictEqual(d.total, 1);
  assert.deepStrictEqual(d.stale, [], 'ninguna declaración colgada');
  const text = guard(l, { args: ['--all'] });
  assert.strictEqual(text.code, 0);
  assert.match(text.stdout, /story-number\s+1/);
});

test('InternalHistoryGuard_All_StaleDeclarationIsReported — un dato declarado que ya no aparece donde dice', () => {
  const l = publicLab();
  stage(l.repo, { [ALLOWED]: { allowed: [{ file: 'guides/a.md', form: 'batch-code', value: j('tanda ', 'B2'), reason: 'prueba' }] } });
  commit(l.repo, 'una declaración colgada');
  const d = JSON.parse(guard(l, { args: ['--all', '--json'] }).stdout);
  assert.strictEqual(d.stale.length, 1);
  assert.strictEqual(d.stale[0].file, 'guides/a.md');
});

// La lista de datos declarados viaja tal cual a los dos repos, y cada modo ve rutas del equipo distintas. Una ruta que
// acá no se puede ver no es una declaración colgada (pase adversarial de la tanda G2: en la copia pública, 32 de las 38
// rutas declaradas daban esta prueba en rojo; y una carpeta local, sin versionar, no tenía salida en el del equipo).
test('InternalHistoryGuard_All_TeamPathDeclaration_OnlyStaleWhereItCanBeSeen — una ruta declarada sólo sobra donde el control la puede ver', () => {
  // cada ruta, declarada para un archivo distinto: así la prueba dice CUÁL sobra, no sólo cuántas
  const entry = (file, value) => ({ file, form: 'team-path', value, reason: 'prueba' });
  const stale = (l) => JSON.parse(guard(l, { args: ['--all', '--json'] }).stdout).stale.map((e) => e.file);
  // repo público: sólo ve una ruta bajo una carpeta no pública
  const p = publicLab();
  stage(p.repo, { [ALLOWED]: { allowed: [entry('guides/perfil.md', 'perfil-equipo.json'), entry('guides/reparto.md', 'scripts/publishing/split.json'), entry('guides/buzon.md', j('inbox/', 'buzon/x.md'))] } });
  commit(p.repo, 'tres rutas declaradas que ninguna guía nombra');
  assert.deepStrictEqual(stale(p), ['guides/buzon.md'], 'en el público sobra sólo la que está bajo una carpeta no pública; las otras dos las juzga el repo del equipo');
  // repo del equipo: juzga lo que tiene versionado, y también lo que no puede ver ninguno de los dos
  const t = teamLab();
  stage(t.repo, { [ALLOWED]: { allowed: [
    entry('guides/local.md', j('inbox/', 'buzon/descartados')),   // una carpeta local, sin versionar, bajo una carpeta no pública: la juzga el público
    entry('guides/plan.md', j('tasks/', 'plan.md')),               // el equipo la tiene y ninguna guía la nombra: sobra
    entry('guides/borrada.md', 'scripts/ya-no-existe/x.js'),       // ni el equipo la tiene ni está bajo una carpeta no pública: nadie la puede ver, sobra acá
  ] } });
  commit(t.repo, 'tres rutas declaradas que ninguna guía nombra');
  assert.deepStrictEqual(stale(t), ['guides/plan.md', 'guides/borrada.md'], 'en el del equipo no sobra la carpeta local; sí la que tiene versionada y la que ya no ve nadie');
});

// ══ T27 · lo que encontraron los revisores y el pase adversarial ═════════════════════════════════════════════════

test('InternalHistoryGuard_Scan_FormSplitByTheLineWrap_IsSeen — un párrafo cortado a lo ancho es un solo renglón', () => {
  const wrapped = ih.scan(j('Esto se hizo en la tanda', '\n', 'B2 y quedó así.\n'), 'prose');
  assert.deepStrictEqual(wrapped.map((f) => [f.form, f.line]), [['batch-code', 1]], 'la forma partida por el corte se ve, en el renglón donde empieza');
  assert.strictEqual(ih.scan(j('> cita con la Story 4.2 de un', '\n', '> producto', ' del equipo\n'), 'prose').filter((f) => f.form === 'product-story').length, 1, 'también en una cita');
  assert.strictEqual(ih.scan(j('- un ítem con la story', '\n', '  8.12 al final\n'), 'prose').filter((f) => f.form === 'story-number').length, 1, 'y en la continuación de un ítem');
  // lo que NO es el mismo párrafo no se junta: un renglón en blanco, un título, una fila de tabla, un ítem nuevo, un cerco
  for (const apart of ['por tanda\n\nB2 es un código', '## La tanda\nB2 es un código', '| la tanda |\n| B2 |', '- la tanda\n- B2', '```\nla tanda\nB2\n```']) {
    assert.deepStrictEqual(ih.scan(apart, 'prose').filter((f) => f.form === 'batch-code'), [], JSON.stringify(apart));
  }
  assert.deepStrictEqual(ih.scan('una línea\r\ny otra con (story 8.1)\r\n', 'prose').map((f) => f.line), [2], 'con finales de línea de Windows, la misma línea');
});

test('InternalHistoryGuard_Scan_SentenceStartAndOtherSpellings — al empezar una oración se ve igual', () => {
  const found = (text, form) => ih.scan(text, 'prose').filter((f) => f.form === form).length;
  assert.strictEqual(found(j('Tanda ', 'B: lo que cambió'), 'batch-code'), 1, 'la palabra con mayúscula');
  assert.strictEqual(found(j('La ', '8.26 lo arregló'), 'story-bare'), 1);
  assert.strictEqual(found(j('Commit ', '`ad4f498` y merge ', '12946bf1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7'), 'private-commit'), 2, 'con mayúscula, y el hash entero');
  assert.strictEqual(found(j('Pull request ', '1234 y pull Request ', '#5678'), 'pr-number'), 2);
  assert.strictEqual(found(j('(2026-10-06, ', 'decisión del dueño)'), 'owner-decision'), 1, 'la fecha antes, dentro del paréntesis');
  assert.strictEqual(found(j('(build ', '8995) y builds ', '9003'), 'azure-run'), 2, 'una corrida dicha «build»');
  assert.strictEqual(found('un commit de prueba, el merge final y la build 2026-05-23', 'private-commit') + found('la build 2026-05-23', 'azure-run'), 0);
});

test('InternalHistoryGuard_Scan_IncidentLog_DoesNotHang — un renglón hostil no cuelga el control', () => {
  // 40.000 enlaces sin cerrar: con la expresión sin acotar (`[^)\s]*…[^)]*`) esto son miles de millones de pasos
  const hostile = `${'](a/incident-log'.repeat(40000)}\n`;
  const t0 = process.hrtime.bigint();
  ih.scan(hostile, 'prose');
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 2000, 'se mira en menos de dos segundos');
  assert.ok(!/\[\^\)\\?s?\]\*/.test(ih.FORMS['incident-log'].re.source), 'la expresión no trae una repetición sin tope dentro del enlace');
});

test('InternalHistoryGuard_NetKey_IgnoresTheWordsAround — retocar lo de alrededor no la hace nueva', () => {
  const l = publicLab();
  const base = `# G\n\nPasó con la Story 4.2 de un producto${' del equipo'}, y sigue desde la ${'8.9'} así.\n`;
  stage(l.repo, { 'guides/k.md': base });
  commit(l.repo, 'una guía que ya las trae');
  stage(l.repo, { 'guides/k.md': base.replace('de un producto', 'de otro producto').replace('desde la', 'a partir de la') });
  const r = guard(l);
  assert.strictEqual(r.code, 0, `la misma story y el mismo número, con otras palabras alrededor\n${r.out}`);
  stage(l.repo, { 'guides/k.md': base.replace('4.2', '4.3') });
  assert.strictEqual(guard(l).code, 1, 'otra story sí es otra');
});

test('InternalHistoryGuard_Merge_BothBranchesAddedTheSameValue_Passes — juntar dos ramas no es agregar', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/m.md': '# M\n\nUno.\n\nDos.\n\nTres.\n' });
  commit(l.repo, 'base de las dos ramas');
  git(l.repo, ['checkout', '-q', '-b', 'otra']);
  stage(l.repo, { 'guides/m.md': `# M\n\nUno.\n\nDos.\n\nTres, ${RED['batch-code']}.\n` });
  commit(l.repo, 'otra: la forma al final');
  git(l.repo, ['checkout', '-q', 'main']);
  stage(l.repo, { 'guides/m.md': `# M\n\nUno, ${RED['batch-code']}.\n\nDos.\n\nTres.\n` });
  commit(l.repo, 'main: la misma forma al principio');
  git(l.repo, ['merge', '-q', '--no-ff', '--no-commit', 'otra']);
  const r = guard(l);
  assert.strictEqual(r.code, 0, `las dos apariciones vienen una de cada rama\n${r.out}`);
  stage(l.repo, { 'guides/m.md': `# M\n\nUno, ${RED['batch-code']}.\n\nDos, ${RED['batch-code']}.\n\nTres, ${RED['batch-code']}.\n` });
  const third = guard(l);
  assert.strictEqual(third.code, 1, 'una tercera, que no traía ninguna rama, sí');
  assert.match(third.out, /guides\/m\.md:5\b[^\n]*batch-code/, 'y señala la que se agregó, no una de las que ya estaban');
});

test('InternalHistoryGuard_CommitWithPath_ReadsTheTemporaryIndex — con `git commit <ruta>` mira sólo lo que entra', () => {
  const l = publicLab();
  const hook = path.join(l.repo, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  const sh = (p) => p.split(path.sep).join('/');
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${sh(process.execPath)}" "${sh(GUARD)}" --repo "$(git rev-parse --show-toplevel)"\n`, { mode: 0o755 });
  const env = { HOME: l.home, USERPROFILE: l.home, TYCON_INTERNAL_HISTORY: 'block' };
  // una forma en el índice de siempre, que este commit NO lleva; y un archivo limpio que sí
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['debt-id']}\n` });
  write(l.repo, { 'guides/old.md': OLD_GUIDE.replace('Otra línea.', 'Otra línea, tocada.') });
  assert.strictEqual(git(l.repo, ['commit', 'guides/old.md', '-m', 'sólo el limpio'], { tolerate: true, env }).status, 0, 'lo que no entra en el commit no lo frena');
  const r = git(l.repo, ['commit', 'guides/a.md', '-m', 'el de la forma'], { tolerate: true, env });
  assert.notStrictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /guides\/a\.md:3\b[^\n]*debt-id/);
});

test('InternalHistoryGuard_FirstCommit_NoHead_LooksAtEverything — sin commits todavía, todo es nuevo', () => {
  const dir = tmp('internal-history-first');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(dir, 'home'));
  git(repo, ['init', '-q', '-b', 'main']);
  stage(repo, { 'guides/a.md': `# Guía\n\n${RED['case-label']}\n` });
  const r = guard({ dir, repo, home: path.join(dir, 'home') });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/a\.md:3\b[^\n]*case-label/);
});

test('InternalHistoryGuard_Range_Forms_AndWhatCannotBeLooked — dos puntos, tres puntos, y lo que no se puede mirar es 2', () => {
  const l = publicLab();
  const base = git(l.repo, ['rev-parse', 'HEAD']);
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['work-branch']}\n` });
  commit(l.repo, 'con una forma');
  assert.strictEqual(guard(l, { args: ['--range', `${base}..HEAD`] }).code, 1, 'con dos puntos');
  for (const bad of ['HEAD', 'no-existe...HEAD', `${base}...no-existe`, '--output=/tmp/x...HEAD']) {
    const r = guard(l, { args: ['--range', bad] });
    assert.strictEqual(r.code, 2, `${bad}\n${r.out}`);
    assert.match(r.stdout, /cannot_look=1/);
  }
  // el mensaje de «no pude mirar» nombra el rango: un control o un separador de línea adentro no sale crudo
  const c = (n) => String.fromCharCode(n);
  const odd = guard(l, { args: ['--range', j('no', c(0x9b), 'existe', c(0x2028), c(0x85), 'x...HEAD')] });
  assert.strictEqual(odd.code, 2, odd.out);
  assert.match(odd.stderr, /--range no\?existe\?\?x\.\.\.HEAD/, `el rango sale en el mensaje, con un signo en su lugar\n${JSON.stringify(odd.stderr)}`);
  assert.ok(![0x85, 0x9b, 0x2028].some((n) => odd.out.includes(c(n))), `nada de eso llega a la salida\n${JSON.stringify(odd.out)}`);
  // el rango no deja constancia en la máquina: no es el commit de nadie
  assert.ok(!fs.existsSync(path.join(l.home, '.claude')) && !fs.existsSync(path.join(l.home, '.tycon')), 'un pedido de cambio no escribe en la carpeta del estado');
});

test('InternalHistoryGuard_CopyLeavingAStub_Passes — mudar una guía dejando un talón no la hace nueva', () => {
  const l = publicLab();
  const body = `# Vieja\n\n${Array.from({ length: 12 }, (_, i) => `Párrafo ${i + 1} de la guía, con texto suficiente para que git lo reconozca.`).join('\n\n')}\n\nEsto quedó así ${RED['story-number']}.\n`;
  stage(l.repo, { 'guides/long.md': body });
  commit(l.repo, 'una guía larga que ya la trae');
  stage(l.repo, { 'guides/moved.md': body, 'guides/long.md': '# Vieja\n\nSe mudó a `guides/moved.md`.\n' });
  const r = guard(l);
  assert.strictEqual(r.code, 0, `la copia trae lo que la guía ya tenía\n${r.out}`);
});

test('InternalHistoryGuard_BrokenInputs_AreTwo_NotGreen — la lista de datos rota, el índice en conflicto y un `.md` que no es UTF-8', () => {
  let l = publicLab();
  stage(l.repo, { [ALLOWED]: '{ "allowed": [', 'guides/a.md': '# Guía\n\nTocada.\n' });
  let r = guard(l);
  assert.strictEqual(r.code, 2, `la lista de datos declarados no se deja leer\n${r.out}`);
  assert.ok(!r.out.includes('"allowed"'), 'y no repite su contenido');

  l = publicLab();
  stage(l.repo, { 'guides/a.md': Buffer.from('# Guía\n\nTocada, pero en otra codificación.\n', 'utf16le').toString('binary') });
  fs.writeFileSync(path.join(l.repo, 'guides/a.md'), Buffer.from('﻿# Guía\n\nTocada, en UTF-16.\n', 'utf16le'));
  git(l.repo, ['add', '-A']);
  r = guard(l);
  assert.strictEqual(r.code, 2, `un .md en UTF-16 no se puede mirar\n${r.out}`);
  assert.match(r.out, /UTF-8/);

  l = publicLab();
  git(l.repo, ['checkout', '-q', '-b', 'otra']);
  stage(l.repo, { 'guides/a.md': '# Guía\n\nDe la otra rama.\n' }); commit(l.repo, 'otra');
  git(l.repo, ['checkout', '-q', 'main']);
  stage(l.repo, { 'guides/a.md': '# Guía\n\nDe main.\n' }); commit(l.repo, 'main');
  git(l.repo, ['merge', '-q', 'otra'], { tolerate: true });
  r = guard(l);
  assert.strictEqual(r.code, 2, `con conflictos sin resolver no hay un después que mirar\n${r.out}`);
});

test('InternalHistoryGuard_PathWithNewline_IsNotPrintedRaw — una ruta rara no inyecta nada en el registro', { skip: process.platform === 'win32' && 'Windows no admite ese nombre de archivo' }, () => {
  const l = publicLab();
  stage(l.repo, { [j('guides/x', '\n', '##vso[task.complete result=Failed;]y.md')]: `# X\n\n${RED['batch-code']}\n` });
  const r = guard(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(!/^##vso/m.test(r.out), `ningún renglón empieza con un comando del registro\n${r.out}`);
  // los controles de la segunda tanda (U+0080 a U+009F: una terminal lee U+009B como el comienzo de una secuencia) y los
  // separadores de línea de Unicode tampoco salen crudos
  const l2 = publicLab();
  stage(l2.repo, { [j('guides/x', '\u009b', '31m', '\u2028', '\u0085', 'y.md')]: `# X\n\n${RED['batch-code']}\n` });
  const r2 = guard(l2);
  assert.strictEqual(r2.code, 1, r2.out);
  assert.ok(!/[\u0080-\u009f\u2028\u2029]/.test(r2.out), `ni un control ni un separador de línea llegan a la salida\n${JSON.stringify(r2.out)}`);
  assert.match(r2.out, /guides\/x\?31m\?\?y\.md/, 'la ruta sale, con un signo en su lugar');
});

test('InternalHistoryGuard_Cli_HelpUnknownAndMissingValue — la línea de comandos', () => {
  const l = publicLab();
  assert.strictEqual(guard(l, { args: ['--help'] }).code, 0);
  assert.match(guard(l, { args: ['--help'] }).stdout, /--range/);
  for (const bad of [['--does-not-exist'], ['--range'], ['--config']]) assert.strictEqual(guard(l, { args: bad }).code, 2, bad.join(' '));
  assert.throws(() => ih.parseArgs(['--ref']), ih.CouldNot);
  assert.deepStrictEqual(ih.parseArgs(['--all', '--json', '--ref', 'abc']), { mode: 'all', repo: null, range: null, json: true, ref: 'abc', config: null, publicRemote: null });
  assert.strictEqual(ih.parseArgs(['--public-remote', 'origin']).publicRemote, 'origin', 'el repo público se puede decir');
});

test('InternalHistoryGuard_All_Ref_AndAnInternalErrorIsTwo — la cuenta de otro commit; lo que no existe es 2', () => {
  const l = publicLab();
  const base = git(l.repo, ['rev-parse', 'HEAD']);
  stage(l.repo, { 'guides/old.md': '# Vieja\n\nLimpia.\n' });
  commit(l.repo, 'limpia');
  assert.strictEqual(JSON.parse(guard(l, { args: ['--all', '--json'] }).stdout).total, 0);
  assert.strictEqual(JSON.parse(guard(l, { args: ['--all', '--json', '--ref', base] }).stdout).total, 1, 'la cuenta del commit que se pide');
  assert.strictEqual(guard(l, { args: ['--all', '--ref', 'no-existe'] }).code, 2);
  // el texto de cada hallazgo sólo lo da `run` a quien lo llama desde un guion (la muestra): la línea de comandos, nunca
  const detail = ih.run({ mode: 'all', repo: l.repo, ref: base, config: null, detail: true });
  assert.deepStrictEqual(detail.list.map((f) => [f.file, f.line, f.form]), [['guides/old.md', 3, 'story-number']]);
  assert.ok(detail.list[0].text.includes(detail.list[0].value));
  assert.ok(!('list' in ih.run({ mode: 'all', repo: l.repo, ref: base, config: null })), 'sin pedirlo no viene');
  // la lista blanca del repo público que no se deja leer: no se sabe cuáles son las convenciones del lector
  stage(l.repo, { 'scripts/publishing/allowlist.json': '{ roto', 'guides/a.md': '# Guía\n\nTocada.\n' });
  assert.strictEqual(guard(l).code, 2, 'sin las convenciones del lector no puede decidir qué ruta es del equipo');
  assert.strictEqual(guard(l, { args: ['--all', '--ref', '--upload-pack=x'] }).code, 2, 'una referencia que parece una opción no llega a git como opción');
});

test('InternalHistoryGuard_TeamPaths_Unit — relativa a su carpeta, el ancla del registro, la carpeta sola, y con separadores de Windows', () => {
  const env = { has: (p) => ['guides/a.md', 'guides/sub/b.md', 'guides'].includes(p), team: (p) => ['tasks/plan.md', 'guides/sub/privado.md', 'guides/incident-log.md'].includes(p), conventions: ['tasks/todo.md'] };
  const hits = (text, file) => ih.teamPaths(text, file, env).map((f) => f.value);
  assert.deepStrictEqual(hits('Ver `privado.md` y `b.md`.', 'guides/sub/a.md'), ['guides/sub/privado.md'], 'relativa a la carpeta del archivo');
  assert.deepStrictEqual(hits('Ver `privado.md`.', 'guides\\sub\\a.md'), ['guides/sub/privado.md'], 'con separadores de Windows, lo mismo');
  assert.deepStrictEqual(hits(j('El caso: `guides/incident-log.md', '#caso-x`.'), 'guides/a.md'), [], 'el ancla del registro es de otra forma');
  assert.deepStrictEqual(hits('Tu `tasks/todo.md` y el `tasks/plan.md:12`.', 'guides/a.md'), ['tasks/plan.md'], 'la convención del lector pasa; `:N` no cambia la ruta');
  const pub = { has: () => false, team: null, roots: ['inbox'], conventions: [] };
  assert.deepStrictEqual(ih.teamPaths('La carpeta `inbox/`, la palabra `inbox` y `inbox/x.md`.', 'guides/a.md', pub).map((f) => f.value), ['inbox', 'inbox/x.md'], 'en el público, la carpeta sola cuenta escrita con su barra');
});

test('InternalHistoryGuard_FormMode_MisspelledIsBlock — el modo de una forma falla cerrado', () => {
  assert.strictEqual(ih.formModeOf({ forms: { x: { mode: 'warn' } } }, 'x'), 'warn');
  for (const config of [{ forms: { x: { mode: 'blok' } } }, { forms: { x: {} } }, { forms: {} }]) assert.strictEqual(ih.formModeOf(config, 'x'), 'block', JSON.stringify(config));
});

// (el mensaje del freno de nombres se mira además CORRIENDO el freno: `NewNames_…` en new-names.test.js, salida (b))
test('InternalHistoryGuard_NeighbourMessages_NoLongerSendToLinkTheLog — los dos frenos vecinos ya no mandan a enlazar el registro desde una guía', () => {
  const names = fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'new-names.js'), 'utf8');
  const at = names.indexOf("'  (b) Si es un caso");
  assert.ok(at > 0);
  const b = names.slice(at, names.indexOf("`  (c) Sólo si lo decide una persona", at));
  assert.match(b, /incident-log\.md/, 'sigue diciendo dónde vive el caso');
  assert.match(b, /no se enlaza/, 'y que una guía no lo enlaza');
  assert.ok(!/con el enlace a su entrada/.test(b));
  const blocks = fs.readFileSync(path.join(RAIZ, 'scripts', 'ci', 'check-claude-md-blocks.js'), 'utf8');
  assert.ok(!/referencialo: incident-log#/.test(blocks), 'el control de los bloques tampoco');
  assert.match(blocks, /el caso va al registro de incidentes/);
});

test('InternalHistoryGuard_CoveredFormWasAlreadyThere_NotNewWhenTheCoverGoes — limpiar a medias un renglón no hace nueva la que ya estaba debajo', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/c.md': `# C\n\nPasó en ${RED['product-story']}.\n` });
  commit(l.repo, 'una guía con la story de un producto');
  // se va «de un producto del equipo» y queda el número, que ya estaba (tapado por la forma de arriba)
  stage(l.repo, { 'guides/c.md': '# C\n\nPasó en la Story 4.2, y sigue.\n' });
  const r = guard(l);
  assert.strictEqual(r.code, 0, `el número ya estaba en ese renglón\n${r.out}`);
});

test('InternalHistoryGuard_Renames_DoNotDependOnTheMachineLimit_AndDocsPathIsNotABranch — el veredicto no depende de la configuración de git', () => {
  const l = publicLab();
  const body = (n) => `# Guía ${n}\n\n${Array.from({ length: 8 }, (_, i) => `Párrafo ${i + 1} de la guía número ${n}, con su texto.`).join('\n\n')}\n\nQuedó así ${RED['story-number']}.\n`;
  stage(l.repo, Object.fromEntries([1, 2, 3, 4].map((n) => [`guides/r${n}.md`, body(n)])));
  commit(l.repo, 'cuatro guías que ya la traen');
  git(l.repo, ['config', 'diff.renameLimit', '1']);
  git(l.repo, ['config', 'diff.renames', 'false']);
  for (const n of [1, 2, 3, 4]) git(l.repo, ['mv', `guides/r${n}.md`, `guides/renamed-${n}.md`]);
  const r = guard(l);
  assert.strictEqual(r.code, 0, `cuatro renombres con el tope de la máquina en uno\n${r.out}`);
  assert.deepStrictEqual(ih.scan('la ruta `docs/v2/guia.md` y la carpeta docs/2024', 'prose').filter((f) => f.form === 'work-branch'), [], 'una ruta bajo docs/ no es una rama (límite conocido: una rama docs/… tampoco se ve)');
});

test('InternalHistoryGuard_Keys_WhatIdentifiesEachForm — lo neto cuenta por lo que identifica a la forma', () => {
  const key = (form, text) => ih.FORMS[form].key(ih.scan(text, 'prose').find((f) => f.form === form).value);
  const same = (form, a, b) => assert.strictEqual(key(form, a), key(form, b), `${form}: «${a}» y «${b}» son la misma`);
  const other = (form, a, b) => assert.notStrictEqual(key(form, a), key(form, b), `${form}: «${a}» y «${b}» son distintas`);
  same('owner-decision', j('(decisión del dueño, ', '2026-10-06)'), j('2026-10-06', ': decisión del dueño'));
  other('owner-decision', j('(decisión del dueño, ', '2026-10-06)'), j('(decisión del dev, ', '2026-10-06)'));
  same('incident-log', j('[caso](incident-log.md', '#caso-x)'), j('`guides/incident-log.md', '#caso-x`'));
  other('incident-log', j('incident-log.md', '#caso-x'), j('incident-log.md', '#caso-y'));
  same('private-commit', j('commit ', '`ad4f498`'), j('Merge ', 'ad4f498'));
  same('azure-run', j('corrida ', '11738'), j('builds #', '11738'));
  same('story-number', j('story ', '8.12'), j('Stories ', '8.12'));
  other('story-number', j('story ', '8.12'), j('épica ', '8'));
  same('batch-code', j('tanda ', 'B2'), j('Tandas ', 'B2'));
  same('pr-number', j('PR ', '#1234'), j('pull request ', '1234'));
  same('product-story', j('Story 4.2 de un producto', ' del equipo'), j('un repo del equipo', ' tuvo la Story 4.2'));
});

test('InternalHistoryGuard_Scan_PositionOnTheSecondPhysicalLine — la línea y la columna son las del texto, no las del párrafo', () => {
  const quoted = ih.scan(j('> una cita que sigue\n', '>   y trae (story ', '8.12) al final\n'), 'prose');
  assert.deepStrictEqual(quoted.map((f) => [f.form, f.line, f.col]), [['story-number', 2, 12]], 'en la segunda línea de una cita, con su sangría');
  assert.strictEqual('>   y trae (story'.indexOf('story'), 12, 'la columna es la del renglón tal como está escrito');
  const item = ih.scan(j('- un ítem\n', '    que sigue en la tanda ', 'B2\n'), 'prose');
  assert.deepStrictEqual(item.map((f) => [f.form, f.line, f.col]), [['batch-code', 2, 20]]);
});

test('InternalHistoryGuard_OneFindingPerSpot_AndTheLastIdenticalLineIsTheNewOne — un pedazo de texto, un hallazgo', () => {
  const l = publicLab();
  stage(l.repo, { 'guides/a.md': `# Guía\n\nPasó en ${RED['product-story']}.\n` });
  const one = guard(l);
  assert.match(one.out, /\(1 hallazgo\(s\)\)/, `la story de un producto no es además un número de story\n${one.out}`);
  // un renglón idéntico a uno que ya estaba: el nuevo es el de abajo
  git(l.repo, ['reset', '-q', '--hard']);
  const line = `Quedó así ${RED['story-number']}.`;
  stage(l.repo, { 'guides/d.md': `# D\n\n${line}\n\nOtra cosa.\n` });
  commit(l.repo, 'ya la trae una vez');
  stage(l.repo, { 'guides/d.md': `# D\n\n${line}\n\nOtra cosa.\n\n${line}\n` });
  const twice = guard(l);
  assert.strictEqual(twice.code, 1, twice.out);
  assert.match(twice.out, /guides\/d\.md:7\b[^\n]*story-number/, 'señala el renglón agregado, no el que ya estaba');
  assert.ok(!/guides\/d\.md:3\b/.test(twice.out));
});

test('InternalHistoryGuard_ItsOwnError_IsTwo_WithTheClassOnly — un error del propio control es «no pude mirar», nunca un 1', () => {
  const l = publicLab();
  // una configuración que se deja leer pero rompe al control por dentro (la lista de carpetas no es una lista)
  const broken = configWith({});
  fs.writeFileSync(broken, JSON.stringify({ ...JSON.parse(fs.readFileSync(broken, 'utf8')), nonPublicRoots: 7 }));
  stage(l.repo, { 'guides/a.md': '# Guía\n\nVer `otra/carpeta.md`.\n' });
  const r = guard(l, { args: ['--config', broken] });
  assert.strictEqual(r.code, 2, `no es un hallazgo: no pudo mirar\n${r.out}`);
  assert.match(r.stderr, /no pude mirar — error del propio control \(TypeError, at /, 'dice la clase y dónde, no el mensaje');
  assert.ok(!/is not a function|includes/.test(r.stderr), `el mensaje del error ajeno no sale\n${r.stderr}`);
  assert.match(r.stdout, /^internal-history: findings=0 cannot_look=1 mode=block$/m);
  const warn = guard(l, { mode: 'warn', args: ['--config', broken] });
  assert.strictEqual(warn.code, 0, 'avisando, tampoco frena');
  assert.match(warn.stdout, /cannot_look=1 mode=warn/);
  // mal llamado también deja su línea de cuentas
  assert.match(guard(l, { args: ['--does-not-exist'] }).stdout, /^internal-history: findings=0 cannot_look=1 mode=block$/m);
});

test('InternalHistoryGuard_ExporterThatCannotLoad_IsTwo_MissingExporterIsFine_BadFormIsTwo — lo que no se puede cargar no se adivina', () => {
  // una copia suelta del control (como en un laboratorio): sin el exportador al lado anda igual, con menos reconocedores
  const dir = tmp('internal-history-loose');
  const pub = path.join(dir, 'scripts', 'publishing');
  fs.mkdirSync(pub, { recursive: true });
  for (const f of ['internal-history.js', 'internal-history.json', 'public-copy.js']) fs.copyFileSync(path.join(RAIZ, 'scripts', 'publishing', f), path.join(pub, f));
  const l = publicLab();
  stage(l.repo, { 'guides/a.md': j('# Guía\n\nVer `inbox/', 'x.md`.\n') });
  const loose = (extra = {}) => spawnSync(process.execPath, [path.join(pub, 'internal-history.js'), '--repo', l.repo], { cwd: l.repo, encoding: 'utf8', env: cleanEnv({ HOME: l.home, USERPROFILE: l.home, TYCON_INTERNAL_HISTORY: 'block', ...extra }) });
  const without = loose();
  assert.strictEqual(without.status, 1, `sin el exportador al lado mira igual\n${without.stdout}${without.stderr}`);
  assert.match(without.stderr, /guides\/a\.md:3\b[^\n]*team-path/);
  // con un exportador que está y no puede cargar algo suyo, no: reconocería menos rutas sin decirlo
  fs.writeFileSync(path.join(pub, 'export.js'), "'use strict';\nrequire('./no-existe-esta-pieza.js');\n");
  const broken = loose();
  assert.strictEqual(broken.status, 2, `un exportador roto es «no pude mirar»\n${broken.stdout}${broken.stderr}`);
  assert.match(broken.stdout, /cannot_look=1/);
  // y un `form` que no es una forma del control, en la lista de datos declarados, tampoco se adivina ni se imprime
  const l2 = publicLab();
  stage(l2.repo, { [ALLOWED]: { allowed: [{ file: 'guides/a.md', form: j('x', '\n', '##vso[task.complete result=Failed;]'), value: 'y', reason: 'prueba' }] }, 'guides/a.md': '# Guía\n\nTocada.\n' });
  const bad = guard(l2);
  assert.strictEqual(bad.code, 2, bad.out);
  assert.ok(!/^##vso/m.test(bad.out), 'y no llega al registro');
  commit(l2.repo, 'entra (el control avisa)');
  const all = guard(l2, { args: ['--all'] });
  assert.strictEqual(all.code, 2, 'la cuenta tampoco lo adivina');
  assert.ok(!/^##vso/m.test(all.out));
});

test('InternalHistoryGuard_MdThatIsNotProse_SaysLookedZero_AndConfigChangeLooksAtAll — «no había prosa» no es «limpio»', () => {
  const l = publicLab();
  stage(l.repo, { 'docs/otra.md': `# Otra\n\n${RED['case-label']}\n` });
  const r = guard(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.stdout, /^internal-history: findings=0 cannot_look=0 mode=block looked=0$/m, 'un .md tocado que no es prosa del alcance: lo dice');
  git(l.repo, ['reset', '-q', '--hard']); git(l.repo, ['clean', '-qfd']);
  // la configuración del control decide qué es una ruta del equipo: tocarla hace mirar todo
  stage(l.repo, { 'scripts/publishing/internal-history.json': { mode: 'warn', forms: {}, nonPublicRoots: [] } });
  assert.ok(!/looked=0/.test(guard(l).stdout), 'tocar la configuración del control no pasa callado');
});

// ══ T27 · el repo del equipo: lo que encontró el pase adversarial ═════════════════════════════════════════════════

test('InternalHistoryGuard_Team_All_CountsWhatShips_RepeatedPieceOnce_RealLineOfIdenticalLines — la cuenta del repo del equipo', () => {
  const l = teamLab();
  // un archivo que llevan dos paquetes (el núcleo por `guides/**` y el otro por su ruta): la pieza repetida cuenta una vez
  const list = JSON.parse(JSON.stringify(TEAM_LIST));
  list.packages.bizuit.arnes.in = ['guides/dos.md'];
  const line = `Quedó así ${RED['story-number']}.`;
  stage(l.repo, {
    'scripts/publishing/allowlist.json': list,
    'guides/dos.md': `# Dos\n\n${RED['batch-code']}\n`,
    'guides/fuera.md': `# Fuera\n\n${RED['product-story']}\n${RED['case-label']}\n`,
    'guides/iguales.md': ['# Iguales', '', INTERNAL_START, 'Sólo adentro.', INTERNAL_END, '', line, '', 'Otra cosa.', '', line, ''].join('\n'),
  });
  const r = guard(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual((r.out.match(/guides\/dos\.md:3\b/g) || []).length, 1, `la pieza que llevan dos paquetes, una vez\n${r.out}`);
  assert.match(r.out, /guides\/iguales\.md:7\b[^\n]*story-number/, 'dos renglones iguales: cada uno con su línea del archivo real');
  assert.match(r.out, /guides\/iguales\.md:11\b[^\n]*story-number/);
  assert.ok(!/línea aproximada/.test(r.out));
  commit(l.repo, 'entran (el control avisa, no frena)');
  const all = JSON.parse(guard(l, { args: ['--all', '--json'] }).stdout);
  assert.strictEqual(all.mode, 'team');
  assert.deepStrictEqual(all.files, { 'guides/dos.md': { 'batch-code': 1 }, 'guides/iguales.md': { 'story-number': 2 } }, 'cuenta lo que sale: ni lo de afuera ni el bloque interno');
});

test('InternalHistoryGuard_Team_NonUtf8_IsTwo_ParentWithoutConfig_IsAllNew — lo que no se puede leer es 2; un antes sin lista blanca no descuenta nada', () => {
  let l = teamLab();
  fs.writeFileSync(path.join(l.repo, 'guides/a.md'), Buffer.from('﻿# Guía\n\nEn UTF-16.\n', 'utf16le'));
  git(l.repo, ['add', '-A']);
  const r = guard(l);
  assert.strictEqual(r.code, 2, `un .md del equipo en UTF-16 no se puede mirar\n${r.out}`);
  assert.match(r.out, /UTF-8/);
  // un repo que todavía no tenía lista blanca: el commit que la trae publica todo, y todo se mira
  l = teamLab();
  const dir = tmp('internal-history-team-first');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(dir, 'home'));
  git(repo, ['init', '-q', '-b', 'main']);
  stage(repo, { 'guides/vieja.md': `# Vieja\n\n${RED['debt-id']}\n`, 'perfil-equipo.json': '{}\n' });
  commit(repo, 'antes de la lista blanca');
  for (const top of ['scripts', 'agents', 'packs', 'skills', 'adapters', '.tycon']) fs.cpSync(path.join(l.repo, top), path.join(repo, top), { recursive: true });
  git(repo, ['add', '-A']);
  const first = guard({ dir, repo, home: path.join(dir, 'home') });
  assert.strictEqual(first.code, 1, `el antes no tenía lista blanca: lo que empieza a salir se mira entero\n${first.out}`);
  assert.match(first.out, /guides\/vieja\.md:3\b[^\n]*debt-id/);
});

test('InternalHistoryGuard_Team_SameFileShippedUnderAnotherPath_IsNotNew_AndDeclaredByItsShippedPath — cambiar la ruta con que sale no lo hace nuevo', () => {
  const l = teamLab();
  stage(l.repo, { 'scripts/publishing/public-files/getting-started/mac.md': `# En Mac\n\n${RED['batch-code']}\n` });
  commit(l.repo, 'el papel ya la trae (entró antes del control)');
  const list = JSON.parse(JSON.stringify(TEAM_LIST));
  list.synthetic[0].target = 'getting-started/macos.md';
  stage(l.repo, { 'scripts/publishing/allowlist.json': list });
  const r = guard(l);
  assert.strictEqual(r.code, 0, `el mismo archivo, con otra ruta de salida\n${r.out}`);
  // un dato de un papel se declara con la ruta con que sale: así vale también en el repo público
  git(l.repo, ['reset', '-q', '--hard']);
  const value = ih.scan(RED['debt-id'], 'prose')[0].value;
  stage(l.repo, {
    'scripts/publishing/public-files/getting-started/mac.md': `# En Mac\n\n${RED['batch-code']}\n${RED['debt-id']}\n`,
    [ALLOWED]: { allowed: [{ file: 'getting-started/mac.md', form: 'debt-id', value, reason: 'prueba: un dato de un papel' }] },
  });
  const declared = guard(l);
  assert.strictEqual(declared.code, 0, `declarado por la ruta con que sale\n${declared.out}`);
});

test('InternalHistoryGuard_Team_PendingSectionOfAPackage_IsLooked — lo que un paquete deja pendiente también se publica', () => {
  const l = teamLab();
  const catalog = (extra) => ['# Catálogo', '', 'Intro.', '', '## Núcleo — `revisor`', '', 'Reglas NUC-C1.', '', '## Público — `revisor-publico`', '', 'Reglas PUB-C1.', extra, ''].join('\n');
  stage(l.repo, { 'guides/advisor-rules-catalog.md': catalog('Limpia.') });
  commit(l.repo, 'el catálogo, limpio');
  stage(l.repo, { 'guides/advisor-rules-catalog.md': catalog(RED['product-story']) });
  const r = guard(l);
  assert.strictEqual(r.code, 1, `la sección del revisor de un paquete sale en la copia que une los paquetes\n${r.out}`);
  assert.match(r.out, /guides\/advisor-rules-catalog\.md:12\b[^\n]*product-story/);
});

test('InternalHistoryGuard_Team_ManifestOfAPackage_IsNotQuiet_AndReclassifyingLooksAtAll — tocar lo que decide qué sale no pasa callado', () => {
  const l = teamLab();
  stage(l.repo, { 'guides/b.md': '# B\n\nUsa `scripts/x.js`.\n' });
  commit(l.repo, 'una guía que nombra un guion que sale');
  stage(l.repo, { 'packs/bizuit/pack.json': { name: 'bizuit', reviewers: [{ agent: 'revisor-publico', group: 'base' }], note: 'tocado' } });
  const manifest = guard(l);
  assert.strictEqual(manifest.code, 0, manifest.out);
  assert.ok(!/looked=0/.test(manifest.stdout), `el manifiesto de un paquete decide qué revisores salen: se mira\n${manifest.stdout}`);
  git(l.repo, ['reset', '-q', '--hard']);
  // y BORRARLO tampoco pasa callado (un borrado de lo que decide qué se publica se mira, o se dice que no se pudo)
  stage(l.repo, { 'packs/bizuit/pack.json': null });
  assert.ok(!/looked=0/.test(guard(l).stdout), 'borrar el manifiesto de un paquete no es «nada que mirar»');
  git(l.repo, ['reset', '-q', '--hard']);
  // el commit no toca la guía, pero saca de la copia el guion que la guía nombra: esa ruta pasa a ser del equipo
  const list = JSON.parse(JSON.stringify(TEAM_LIST));
  list.packages.core.arnes.out.push({ glob: 'scripts/x.js', reason: 'prueba: deja de salir' });
  stage(l.repo, { 'scripts/publishing/allowlist.json': list });
  const r = guard(l);
  assert.strictEqual(r.code, 1, `una ruta ya escrita que deja de llevar a algo\n${r.out}`);
  assert.match(r.out, /guides\/b\.md:3\b[^\n]*team-path/);
});

test('InternalHistoryGuard_Team_TranslationIsInTheCopy_AndPaperFromAnotherFile_IsLooked — una traducción sale; un papel que cambia de origen se mira', () => {
  const l = teamLab();
  stage(l.repo, { 'guides/b.md': '# B\n\nLa traducción vive en `adapters/codex/agents/revisor.toml`.\n' });
  const translation = guard(l);
  assert.strictEqual(translation.code, 0, `una traducción a Codex se regenera, pero está en la copia\n${translation.out}`);
  commit(l.repo, 'la guía');
  // el destino del papel es el mismo, pero ahora lo llena OTRO archivo, que ya existía y el commit no toca
  stage(l.repo, { 'scripts/publishing/public-files/getting-started/otro.md': `# En Mac\n\n${RED['owner-decision']}\n` });
  commit(l.repo, 'otro papel, todavía sin colocar (entra antes del control)');
  const list = JSON.parse(JSON.stringify(TEAM_LIST));
  list.synthetic[0].from = 'scripts/publishing/public-files/getting-started/otro.md';
  stage(l.repo, { 'scripts/publishing/allowlist.json': list });
  const r = guard(l);
  assert.strictEqual(r.code, 1, `lo que sale en esa ruta cambió aunque nadie tocó el archivo\n${r.out}`);
  assert.match(r.out, /public-files\/getting-started\/otro\.md:3\b[^\n]*owner-decision[^\n]*sale como getting-started\/mac\.md/);
});

// ══ T28 · el cableado ═════════════════════════════════════════════════════════════════════════════════════════════

test('InternalHistoryGuard_SummaryLine_Always_AndTheRecordForWhatWasNotLooked — la línea de cuentas sale siempre', () => {
  const l = publicLab();
  stage(l.repo, { 'scripts/x.js': "'use strict';\nmodule.exports = 3;\n" });
  assert.match(guard(l).stdout, /^internal-history: findings=0 cannot_look=0 mode=block looked=0$/m, 'nada de lo tocado era prosa: lo dice');
  assert.match(guard(l, { mode: '0' }).stdout, /^internal-history: findings=0 cannot_look=0 mode=off$/m, 'apagado: lo dice');
  assert.match(guard(l, { args: ['--range', 'HEAD...HEAD'] }).stdout, /^internal-history: findings=0 cannot_look=0 mode=block measured=0$/m);
  // «no pude mirar» y «bajado por variable» también dejan su línea en la carpeta del estado
  stage(l.repo, { 'guides/a.md': '# Guía\n\nTocada.\n' });
  const blockConfig = configWith({});
  fs.writeFileSync(blockConfig, JSON.stringify({ ...JSON.parse(fs.readFileSync(blockConfig, 'utf8')), mode: 'block' }));
  guard(l, { mode: 'warn', args: ['--config', blockConfig] });
  guard(l, { mode: 'warn', args: ['--config', path.join(l.dir, 'no-existe.json')] });
  const logs = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name === 'internal-history.jsonl') logs.push(path.join(d, e.name)); } })(l.home);
  const lines = fs.readFileSync(logs[0], 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.ok(lines.some((x) => x.lowered === true && x.cannot_look === false), 'la baja por variable');
  assert.ok(lines.some((x) => x.cannot_look === true), 'y el «no pude mirar»');
  const said = guard(l, { mode: 'warn', args: ['--config', path.join(l.dir, 'no-existe.json')] });
  assert.match(said.stderr, /TYCON_INTERNAL_HISTORY=warn/, 'sin poder leer el modo escrito, que la variable lo deja en aviso se dice igual');
});

// El registro de frenos (story 8.26, tanda G3 · AC 56): con el control frenando, cada commit que tocó prosa que se
// publica deja su decisión donde el tablero cuenta las de todos los frenos. Sólo códigos: nunca el texto encontrado.
test('InternalHistoryGuard_GuardRecord_EveryDecision_ByCode — cada decisión del commit queda en el registro de frenos', () => {
  const l = publicLab();
  const decisions = () => {
    const found = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name === 'frenos.jsonl') found.push(path.join(d, e.name)); } })(l.home);
    if (!found.length) return [];
    return fs.readFileSync(found[0], 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  };
  const last = () => { const all = decisions(); const d = all[all.length - 1]; return d ? `${d.freno}:${d.regla}:${d.veredicto}` : null; };
  // nada de lo tocado era prosa: no hubo nada que decidir, y no se anota
  stage(l.repo, { 'scripts/x.js': "'use strict';\nmodule.exports = 4;\n" });
  guard(l);
  assert.strictEqual(decisions().length, 0, 'sin prosa tocada no hay decisión');
  // una guía tocada y limpia: pasó, y cuenta (es el denominador)
  stage(l.repo, { 'guides/a.md': '# Guía\n\nTocada.\n' });
  guard(l);
  assert.strictEqual(last(), 'internal-history:clean:paso');
  // una forma nueva, frenando
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['product-story']}\n` });
  assert.strictEqual(guard(l).code, 1);
  assert.strictEqual(last(), 'internal-history:finding:bloqueo');
  // la huella es un resumen de forma, archivo y línea de cada hallazgo (para cruzar dos decisiones sobre el mismo
  // commit sin guardar nada legible); un commit limpio no lleva huella
  const footprint = require('crypto').createHash('sha256').update(JSON.stringify([['product-story', 'guides/a.md', 3]])).digest('hex');
  assert.strictEqual(decisions()[decisions().length - 1].sha256, footprint, 'la huella sale de forma, archivo y línea');
  assert.strictEqual(decisions()[decisions().length - 2].sha256, null, 'limpio: sin huella');
  // una forma que SÓLO AVISA, con el control frenando: el commit se crea y queda como aviso, con la variable o sin ella
  // (bajar el control no «escapa» de lo que no iba a frenar)
  const softForm = configWith({ 'product-story': 'warn' });
  fs.writeFileSync(softForm, JSON.stringify({ ...JSON.parse(fs.readFileSync(softForm, 'utf8')), mode: 'block' }));
  assert.strictEqual(guard(l, { mode: null, args: ['--config', softForm] }).code, 0, 'una forma que sólo avisa no frena');
  assert.strictEqual(last(), 'internal-history:finding:aviso');
  const softCount = decisions().length;
  assert.strictEqual(guard(l, { mode: 'warn', args: ['--config', softForm] }).code, 0);
  assert.strictEqual(decisions().length, softCount + 1, 'esa corrida también anotó');
  assert.strictEqual(last(), 'internal-history:finding:aviso', 'bajado por la variable y sin nada que frenar: no es un escape');
  // la misma, con el control escrito en `block` y bajado a aviso por la variable: se escapó
  const blockConfig = configWith({});
  fs.writeFileSync(blockConfig, JSON.stringify({ ...JSON.parse(fs.readFileSync(blockConfig, 'utf8')), mode: 'block' }));
  assert.strictEqual(guard(l, { mode: 'warn', args: ['--config', blockConfig] }).code, 0);
  assert.strictEqual(last(), 'internal-history:finding:escape');
  // y con el control escrito en aviso, avisó
  const warnConfig = configWith({});
  fs.writeFileSync(warnConfig, JSON.stringify({ ...JSON.parse(fs.readFileSync(warnConfig, 'utf8')), mode: 'warn' }));
  assert.strictEqual(guard(l, { mode: null, args: ['--config', warnConfig] }).code, 0);
  assert.strictEqual(last(), 'internal-history:finding:aviso');
  // no poder mirar, frenando; y apagado
  assert.strictEqual(guard(l, { args: ['--config', path.join(l.dir, 'no-existe.json')] }).code, 2);
  assert.strictEqual(last(), 'internal-history:could-not-look:bloqueo');
  // no poder mirar con el control ESCRITO en aviso (la lista de datos declarados, rota): avisó
  stage(l.repo, { [ALLOWED]: '{ roto' });
  const brokenList = guard(l, { mode: null, args: ['--config', warnConfig] });
  assert.strictEqual(brokenList.code, 0, brokenList.out);
  assert.match(brokenList.stdout, /cannot_look=1 mode=warn/);
  assert.strictEqual(last(), 'internal-history:could-not-look:aviso');
  git(l.repo, ['rm', '-q', '--cached', ALLOWED]); fs.rmSync(path.join(l.repo, ALLOWED));
  // anotar nunca decide la salida: con la carpeta del estado imposible de crear (la HOME es un archivo), el control
  // frena igual, dice lo mismo y no deja nada
  const noHome = path.join(l.dir, 'home-que-es-un-archivo');
  fs.writeFileSync(noHome, '');
  const count = decisions().length;
  const deaf = guard(l, { env: { HOME: noHome, USERPROFILE: noHome } });
  assert.strictEqual(deaf.code, 1, `sin dónde anotar, el veredicto es el mismo\n${deaf.out}`);
  assert.match(deaf.stdout, /^internal-history: findings=1 cannot_look=0 mode=block$/m);
  assert.strictEqual(decisions().length, count);
  guard(l, { mode: '0' });
  assert.strictEqual(last(), 'internal-history:disabled:escape');
  // apagado anota su escape aunque el commit no traiga prosa: sin mirar no se sabe, y un control apagado tiene que verse
  git(l.repo, ['reset', '-q', '--hard']);
  stage(l.repo, { 'scripts/x.js': "'use strict';\nmodule.exports = 5;\n" });
  const off = decisions().length;
  guard(l, { mode: '0' });
  assert.strictEqual(decisions().length, off + 1);
  assert.strictEqual(last(), 'internal-history:disabled:escape');
  // «no pude mirar» sin frenar (hay una guía entre lo tocado y falta la configuración): bajado por la variable, se escapó
  stage(l.repo, { 'guides/a.md': '# Guía\n\nOtra vez tocada.\n' });
  assert.strictEqual(guard(l, { mode: 'warn', args: ['--config', path.join(l.dir, 'no-existe.json')] }).code, 0);
  assert.strictEqual(last(), 'internal-history:could-not-look:escape', 'sin poder leer lo escrito, la variable lo dejó en aviso');
  // ni la cuenta ni el pedido de cambio son el commit de una máquina: no anotan. El rango es de verdad: un commit que
  // agrega una forma a una guía, mirado con `--range` da su hallazgo (sale 1) y no deja nada en el registro
  const base = git(l.repo, ['rev-parse', 'HEAD']);
  git(l.repo, ['reset', '-q', '--hard']);
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['work-branch']}\n` });
  commit(l.repo, 'una forma, ya commiteada');
  const before = decisions().length;
  const ranged = guard(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(ranged.code, 1, `el rango encontró la forma\n${ranged.out}`);
  assert.match(guard(l, { args: ['--all'] }).stdout, /historia interna en la prosa que se publica[^\n]*: 2 en 2/, 'la cuenta también la ve');
  assert.strictEqual(decisions().length, before, 'sólo el commit anota');
  // nunca el texto encontrado, ni la ruta: códigos y una huella
  const raw = JSON.stringify(decisions());
  assert.ok(!raw.includes('guides/a.md') && !/producto del equipo/.test(raw), 'el registro no lleva ni la ruta ni el texto');
  // y el nombre está en los dos vocabularios: el del registro y el del tablero
  const record = require(path.join(RAIZ, 'scripts', 'lib', 'guard-record.js'));
  assert.deepStrictEqual(record.FRENOS['internal-history'], { reglas: ['finding', 'could-not-look', 'disabled', 'clean'], veredictos: ['bloqueo', 'aviso', 'paso', 'escape'] });
  const sources = path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'sources.json');
  if (fs.existsSync(sources)) {
    const found = {};
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (['frenos_bloqueos', 'frenos_escapes', 'frenos_avisos'].includes(key) && value && Array.isArray(value.values)) found[key] = value.values;
        walk(value);
      }
    })(JSON.parse(fs.readFileSync(sources, 'utf8')));
    // los tres: el control frena, avisa y se puede bajar; una lista que no lo nombra descarta ese veredicto sin decirlo
    for (const key of ['frenos_bloqueos', 'frenos_escapes', 'frenos_avisos']) assert.ok((found[key] || []).includes('internal-history'), `${key}: el tablero conoce al control por su nombre`);
  }
});

// El modo que decide si el commit se crea es el que ENTRA en el commit (el del índice), como la lista de datos
// declarados: editar `mode` sin stagear no baja el control callado. Hace falta el control adentro del repo que se
// commitea, como en el arnés: el laboratorio se lleva el guion y lo que carga.
test('InternalHistoryGuard_WrittenMode_IsTheStagedOne — una edición sin stagear de la configuración no baja el control', () => {
  const l = publicLab();
  const copy = (rel) => { const to = path.join(l.repo, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(RAIZ, rel), to); };
  for (const rel of ['scripts/publishing/internal-history.js', 'scripts/publishing/internal-history.json', 'scripts/publishing/public-copy.js',
    'scripts/lib/guard-record.js', 'scripts/setup/harness/tycon-home.js']) copy(rel);
  const configFile = path.join(l.repo, 'scripts', 'publishing', 'internal-history.json');
  const written = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.writeFileSync(configFile, `${JSON.stringify({ ...written, mode: 'block' }, null, 2)}\n`);
  git(l.repo, ['add', '-A']); commit(l.repo, 'el control, adentro del repo, frenando');
  const own = (extra = {}) => {
    const r = spawnSync(process.execPath, [path.join(l.repo, 'scripts', 'publishing', 'internal-history.js'), '--repo', l.repo], {
      cwd: l.repo, encoding: 'utf8', env: cleanEnv({ HOME: l.home, USERPROFILE: l.home, ...extra }),
    });
    return { code: r.status, stdout: r.stdout || '', out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['batch-code']}\n` });
  assert.strictEqual(own().code, 1, 'la línea de base: frena');
  // en el disco, `mode: warn`; en el índice sigue `block`: frena igual
  fs.writeFileSync(configFile, `${JSON.stringify({ ...written, mode: 'warn' }, null, 2)}\n`);
  const unstaged = own();
  assert.strictEqual(unstaged.code, 1, `la edición sin stagear no baja el control\n${unstaged.out}`);
  assert.match(unstaged.stdout, /findings=1 cannot_look=0 mode=block/);
  // stageada, entra en el commit y vale: avisa (y se ve en el diff del commit)
  git(l.repo, ['add', 'scripts/publishing/internal-history.json']);
  const staged = own();
  assert.strictEqual(staged.code, 0, staged.out);
  assert.match(staged.stdout, /mode=warn/);
  // corrido desde OTRO árbol (el control del arnés sobre este repo), su configuración es la suya: no lee la de acá
  assert.match(guard(l, { mode: null }).stdout, /mode=block/);
  // sacarla del índice dejando en el disco una copia en aviso tampoco lo baja: el repo la versiona, así que vale la
  // que está commiteada (en `block`), no la copia que no entra en el commit
  git(l.repo, ['reset', '-q', '--hard']);
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['batch-code']}\n` });
  git(l.repo, ['rm', '-q', '--cached', 'scripts/publishing/internal-history.json']);
  fs.writeFileSync(configFile, `${JSON.stringify({ ...written, mode: 'warn' }, null, 2)}\n`);
  const removed = own();
  assert.strictEqual(removed.code, 1, `fuera del índice y en aviso en el disco: frena igual\n${removed.out}`);
  assert.match(removed.stdout, /findings=1 cannot_look=0 mode=block/);
});

test('InternalHistoryGuard_GuardRecord_DecisionTable_Unit — la decisión de un commit, caso por caso', () => {
  const d = (state) => { const x = ih.decisionOf(state); return x ? `${x.rule}:${x.verdict}` : null; };
  const finding = [{ form: 'batch-code', file: 'guides/a.md', line: 3, formMode: 'block' }];
  const soft = [{ form: 'story-bare', file: 'guides/a.md', line: 3, formMode: 'warn' }];
  // apagado: siempre un escape, haya o no qué mirar
  assert.strictEqual(d({ mode: 'off', lowered: true }), 'disabled:escape');
  assert.strictEqual(d({ mode: 'off', lowered: true, looked: 4, findings: finding }), 'disabled:escape');
  // no pude mirar: frenó, avisó (el control escrito en aviso) o se escapó (bajado por la variable)
  assert.strictEqual(d({ mode: 'block', cannotLook: true, blocked: true }), 'could-not-look:bloqueo');
  assert.strictEqual(d({ mode: 'warn', cannotLook: true }), 'could-not-look:aviso');
  assert.strictEqual(d({ mode: 'warn', cannotLook: true, lowered: true }), 'could-not-look:escape');
  // un hallazgo: frenó; avisó (una forma que sólo avisa con el control frenando, o el control escrito en aviso); o se escapó
  assert.strictEqual(d({ mode: 'block', findings: finding, blocked: true, looked: 1 }), 'finding:bloqueo');
  assert.strictEqual(d({ mode: 'block', findings: soft, blocked: false, looked: 1 }), 'finding:aviso', 'una forma que sólo avisa no frena');
  assert.strictEqual(d({ mode: 'warn', findings: soft, lowered: true, looked: 1 }), 'finding:aviso', 'y bajar el control no la vuelve un escape: no iba a frenar');
  assert.strictEqual(d({ mode: 'warn', findings: [...soft, ...finding], lowered: true, looked: 1 }), 'finding:escape', 'con una que sí frenaba, se escapó');
  assert.strictEqual(d({ mode: 'warn', findings: finding, looked: 1 }), 'finding:aviso');
  assert.strictEqual(d({ mode: 'warn', findings: finding, lowered: true, looked: 1 }), 'finding:escape');
  // limpio: pasó si miró algo; sin prosa entre lo tocado no hubo decisión (también bajado por la variable)
  assert.strictEqual(d({ mode: 'block', looked: 2 }), 'clean:paso');
  assert.strictEqual(d({ mode: 'warn', lowered: true, looked: 2 }), 'clean:paso');
  assert.strictEqual(d({ mode: 'block', looked: 0 }), null);
  assert.strictEqual(d({ mode: 'warn', lowered: true }), null);
  // y cada par que puede salir está en el vocabulario del registro: uno que no esté no se anota
  const record = require(path.join(RAIZ, 'scripts', 'lib', 'guard-record.js'));
  for (const pair of ['disabled:escape', 'could-not-look:bloqueo', 'could-not-look:aviso', 'could-not-look:escape', 'finding:bloqueo', 'finding:aviso', 'finding:escape', 'clean:paso']) {
    const [rule, verdict] = pair.split(':');
    assert.strictEqual(record.reglaNormalizada('internal-history', rule), rule, `${rule} es una regla del vocabulario`);
    assert.ok(record.veredictoValido('internal-history', verdict), `${verdict} es un veredicto del vocabulario`);
  }
});

test('InternalHistoryGuard_ValidationStep_OneRun_NoticesWithFixedTextAndTheCount — en la validación corre una vez y avisando se ve', () => {
  const yml = fs.readFileSync(path.join(RAIZ, 'pipelines/azure-pipelines-pr.yml'), 'utf8').split('\n');
  const runs = yml.filter((l) => /node scripts\/publishing\/internal-history\.js/.test(l));
  assert.strictEqual(runs.length, 1, 'una sola corrida para las dos fuentes');
  assert.match(runs[0], /--range "\$\(baseDelCambio\)\.\.\.HEAD"/, 'sobre el diff del pedido');
  assert.ok(!/--source/.test(runs[0]), 'sin fuente: mira las dos');
  const at = yml.indexOf(runs[0]);
  const step = yml.slice(at, at + 24).join('\n');
  assert.match(step, /falla "\$\(\[ "\$RC" = 1 \] && echo '[^']*historia interna[^']*' \|\| echo '[^']*no pude mirar[^']*'\)"/, 'frenando, suma a las fallas con texto fijo');
  const notices = step.split('\n').filter((l) => l.includes('##vso[task.logissue type=warning]')).map((l) => l.slice(l.indexOf('##vso')));
  for (const n of notices) {
    const vars = n.match(/\$[A-Za-z_({][A-Za-z_0-9)}]*/g) || [];
    assert.deepStrictEqual(vars.filter((v) => v !== '$N' && v !== '$TOTAL'), [], `un aviso sólo lleva una cuenta: ${n.trim()}`);
  }
  // un paso verde nunca queda mudo: cada camino en que el control no frenó y hay algo que saber tiene su aviso
  for (const [what, re] of [['los hallazgos en modo aviso, con su cuenta', /\$N forma/], ['los de las formas que sólo avisan', /\$TOTAL forma/],
    ['«no pude mirar» en modo aviso', /NO PUDO MIRAR/], ['el control apagado', /APAGADO/], ['la línea de cuentas que falta', /sin su línea de cuentas/]]) {
    assert.ok(notices.some((n) => re.test(n)), what);
  }
  assert.match(step, /\[ -z "\$IH_LINE" \]/, 'sin línea de cuentas no es «limpio»');
});

test('InternalHistoryGuard_ValidationStep_ShellLogic_OnEachSummaryLine — lo que el paso hace con cada línea de cuentas', { skip: process.platform === 'win32' && 'el paso es bash' }, () => {
  // el paso de verdad, sacado del YAML y corrido con un control de mentira que imprime la línea que se le pide
  const yml = fs.readFileSync(path.join(RAIZ, 'pipelines/azure-pipelines-pr.yml'), 'utf8').split('\n');
  const from = yml.findIndex((l) => /IH_OUT="\$\(node scripts\/publishing\/internal-history\.js/.test(l));
  const to = yml.findIndex((l, i) => i > from && /^\s*fi\s*$/.test(l) && /^\s*$/.test(yml[i + 1] || ''));
  const body = yml.slice(from, to + 1).map((l) => l.replace(/^ {10}/, '')).join('\n')
    .replace('node scripts/publishing/internal-history.js --range "$(baseDelCambio)...HEAD"', 'printf "%s" "$FAKE_OUT"; exit "$FAKE_RC"');
  const stepOf = (out, rc) => spawnSync('bash', ['-c', `set -uo pipefail\nFALLAS=0\nfalla(){ echo "ERROR $1"; FALLAS=$((FALLAS+1)); }\n${body}\necho "FALLAS=$FALLAS"`],
    { encoding: 'utf8', env: { ...process.env, FAKE_OUT: out, FAKE_RC: String(rc) } }).stdout;
  const line = (s) => `internal-history: ${s}\n`;
  assert.match(stepOf(line('findings=0 cannot_look=0 mode=warn'), 0), /^FALLAS=0\s*$/, 'limpio: ni aviso ni falla');
  assert.match(stepOf(line('findings=3 cannot_look=0 mode=warn'), 0), /type=warning\][^\n]*agrega 3 forma[\s\S]*FALLAS=0/);
  assert.match(stepOf(line('findings=0 cannot_look=0 mode=block warnings=2'), 0), /type=warning\][^\n]*agrega 2 forma\(s\) de las que sólo avisan[\s\S]*FALLAS=0/);
  assert.match(stepOf(line('findings=0 cannot_look=1 mode=warn'), 0), /NO PUDO MIRAR[\s\S]*FALLAS=0/);
  assert.match(stepOf(line('findings=0 cannot_look=0 mode=off'), 0), /APAGADO[\s\S]*FALLAS=0/);
  assert.match(stepOf('', 0), /sin su línea de cuentas[\s\S]*FALLAS=0/, 'un control que no dijo nada no es «limpio»');
  assert.match(stepOf(line('findings=1 cannot_look=0 mode=block'), 1), /ERROR el cambio agrega historia interna[\s\S]*FALLAS=1/);
  assert.match(stepOf(line('findings=0 cannot_look=1 mode=block'), 2), /ERROR historia interna: no pude mirar[\s\S]*FALLAS=1/);
  assert.match(stepOf('', 1), /ERROR[\s\S]*FALLAS=1/, 'un control que muere frena');
});

test('InternalHistoryGuard_PreCommitHook_RunsIt_StderrVisible_MissingScriptRejectsInTeamClone — el pre-commit lo corre, deja ver lo que dice y sin el guion no mira a ciegas', () => {
  const { preCommitHook } = require('./lib/pre-commit-hook.js');
  const hook = fs.readFileSync(preCommitHook('harness', RAIZ), 'utf8');
  const at = hook.indexOf('INTERNAL_HISTORY="$REPO_ROOT/scripts/publishing/internal-history.js"');
  assert.ok(at > 0, 'el guion del pre-commit nombra al control');
  // el tramo entero del control, hasta su `fi` (no un ancho fijo: la condición del perfil, con sus dos nombres, lo alarga)
  const block = hook.slice(at, hook.indexOf('\nfi\n', at) + 4);
  assert.match(block, /node "\$INTERNAL_HISTORY" --repo "\$REPO_ROOT" >\/dev\/null; then/, 'la línea de cuentas se calla; lo que dice (por la salida de errores) se ve');
  assert.ok(!/2>\s*\/dev\/null/.test(block), 'nunca se tapa lo que el control dice');
  assert.match(block, /COMMIT RECHAZADO — historia interna/);
  // con el control frenando, que falte el guion en un clon del equipo es «no pude mirar»: el commit no se crea
  // (el perfil del equipo con su nombre de hoy o el de antes: los dos dicen «clon del equipo»)
  assert.match(block, /elif \[ -f "\$REPO_ROOT\/team-profile\.json" \] \|\| \[ -f "\$REPO_ROOT\/perfil-equipo\.json" \]; then\s*\n\s*echo "⛔ COMMIT RECHAZADO — historia interna: no pude mirar \(falta \$\{INTERNAL_HISTORY\}\)[^\n]*>&2\s*\n[\s\S]{0,500}?\n\s*exit 1\s*\n\s*fi/, 'si falta el guion en un clon del equipo, rechaza');
  assert.match(block, /guard-record\.js" --guard internal-history --rule could-not-look --verdict bloqueo >\/dev\/null 2>&1 \|\| true/, 'y el rechazo queda en el registro de frenos, sin cambiar la salida');
  assert.ok(!/no encontré \$\{INTERNAL_HISTORY\}/.test(block), 'ya no avisa y sigue');
});

// El camino central, corrido: el tramo del pre-commit de verdad con el control de verdad. Un commit que agrega una forma
// a una guía NO se crea; el mismo commit, limpio, entra. (El tramo se copia tal cual; sólo se le dice dónde está el guion.)
test('InternalHistoryGuard_PreCommitHook_FindingRejectsTheCommit_Live — con una forma nueva el commit no se crea; limpio, entra', () => {
  const { preCommitHook } = require('./lib/pre-commit-hook.js');
  const hook = fs.readFileSync(preCommitHook('harness', RAIZ), 'utf8');
  const assign = 'INTERNAL_HISTORY="$REPO_ROOT/scripts/publishing/internal-history.js"';
  const from = hook.indexOf(assign);
  const to = hook.indexOf('\nfi\n', from);
  assert.ok(from > 0 && to > from, 'el tramo del control en el pre-commit');
  const sh = (p) => p.split(path.sep).join('/');
  const stretch = hook.slice(from, to + 4).replace(assign, `INTERNAL_HISTORY="${sh(GUARD)}"`);
  const l = publicLab();
  const file = path.join(l.repo, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env bash\nREPO_ROOT="$(git rev-parse --show-toplevel)"\n${stretch}exit 0\n`, { mode: 0o755 });
  const env = { HOME: l.home, USERPROFILE: l.home };   // sin la variable: frena por lo que está escrito
  const count = () => git(l.repo, ['rev-list', '--count', 'HEAD']);
  const before = count();
  stage(l.repo, { 'guides/a.md': `# Guía\n\n${RED['product-story']}\n` });
  const bad = git(l.repo, ['commit', '-m', 'trae una forma'], { tolerate: true, env });
  assert.notStrictEqual(bad.status, 0, `con una forma nueva el commit no se crea\n${bad.stdout}${bad.stderr}`);
  assert.match(`${bad.stdout}${bad.stderr}`, /guides\/a\.md:3\b[^\n]*product-story/, 'dice dónde, por la salida de errores');
  assert.match(`${bad.stdout}${bad.stderr}`, /COMMIT RECHAZADO — historia interna en la prosa que se publica/);
  assert.ok(!/internal-history: findings=/.test(`${bad.stdout}${bad.stderr}`), 'la línea de cuentas no ensucia el commit');
  assert.strictEqual(count(), before, 'no hay commit nuevo');
  stage(l.repo, { 'guides/a.md': '# Guía\n\nLimpia.\n' });
  const good = git(l.repo, ['commit', '-m', 'limpio'], { tolerate: true, env });
  assert.strictEqual(good.status, 0, `limpio, entra\n${good.stdout}${good.stderr}`);
  assert.strictEqual(Number(count()), Number(before) + 1);
});

// El mismo camino, corrido: el tramo del pre-commit de verdad, en un repo de juguete sin el guion. Con el perfil del
// equipo el commit no se crea; sin el perfil (la copia pública, un laboratorio) no dice nada, como los otros frenos.
test('InternalHistoryGuard_PreCommitHook_MissingScript_Live — sin el guion, un clon del equipo no commitea y uno de afuera sí', () => {
  const { preCommitHook } = require('./lib/pre-commit-hook.js');
  const hook = fs.readFileSync(preCommitHook('harness', RAIZ), 'utf8');
  const from = hook.indexOf('INTERNAL_HISTORY="$REPO_ROOT/scripts/publishing/internal-history.js"');
  const to = hook.indexOf('\nfi\n', from);
  assert.ok(from > 0 && to > from, 'el tramo del control en el pre-commit');
  const stretch = hook.slice(from, to + 4);
  // el repo de juguete trae la biblioteca del registro (un clon al que le falta SÓLO el guion del control) y la carpeta
  // del estado del laboratorio, para ver que el rechazo queda anotado
  const lib = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  const run = (profile, { withLib = true } = {}) => {
    const dir = tmp('internal-history-hook');
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    write(repo, {
      'guides/a.md': '# Guía\n\nPrimera línea.\n',
      ...(withLib ? { 'scripts/lib/guard-record.js': lib('scripts/lib/guard-record.js'), 'scripts/setup/harness/tycon-home.js': lib('scripts/setup/harness/tycon-home.js') } : {}),
      ...(profile ? { [profile === true ? 'perfil-equipo.json' : profile]: '{}\n' } : {}),
    });
    const file = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/usr/bin/env bash\nREPO_ROOT="$(git rev-parse --show-toplevel)"\n${stretch}exit 0\n`, { mode: 0o755 });
    git(repo, ['add', '-A']);
    const r = git(repo, ['commit', '-m', 'un commit cualquiera'], { tolerate: true, env: { HOME: dir, USERPROFILE: dir } });
    const records = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git' || e.name === 'repo') continue; if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name === 'frenos.jsonl') records.push(...fs.readFileSync(path.join(d, e.name), 'utf8').trim().split('\n').map((x) => JSON.parse(x))); } })(dir);
    return { status: r.status, out: `${r.stdout}${r.stderr}`, commits: git(repo, ['rev-list', '--all', '--count'], { tolerate: true }).stdout.trim(), records };
  };
  const team = run(true);
  assert.notStrictEqual(team.status, 0, `con el perfil del equipo y sin el guion, el commit no se crea\n${team.out}`);
  assert.match(team.out, /COMMIT RECHAZADO — historia interna: no pude mirar/);
  assert.strictEqual(team.commits, '0');
  assert.deepStrictEqual(team.records.map((x) => `${x.freno}:${x.regla}:${x.veredicto}`), ['internal-history:could-not-look:bloqueo'], 'el rechazo queda en el registro de frenos');
  // con el perfil en su nombre de hoy, igual: es un clon del equipo
  const teamNew = run('team-profile.json');
  assert.notStrictEqual(teamNew.status, 0, `con team-profile.json y sin el guion, el commit no se crea\n${teamNew.out}`);
  assert.match(teamNew.out, /COMMIT RECHAZADO — historia interna: no pude mirar/);
  assert.strictEqual(teamNew.commits, '0');
  const outside = run(false);
  assert.strictEqual(outside.status, 0, `sin perfil y sin el guion no hay qué mirar\n${outside.out}`);
  assert.doesNotMatch(outside.out, /historia interna/);
  assert.deepStrictEqual(outside.records, [], 'y sin perfil no se anota nada: no hubo decisión');
  // un clon al que le falta también la biblioteca del registro: rechaza igual; anotar nunca decide la salida
  const bare = run(true, { withLib: false });
  assert.notStrictEqual(bare.status, 0, `sin el guion y sin la biblioteca del registro, el commit tampoco se crea\n${bare.out}`);
  assert.match(bare.out, /COMMIT RECHAZADO — historia interna: no pude mirar/);
  assert.deepStrictEqual(bare.records, []);
});

// ══ el repo de verdad ═════════════════════════════════════════════════════════════════════════════════════════════

test('InternalHistoryGuard_RealConfig_Sane — la configuración que viaja se entiende y cada forma tiene su modo', () => {
  const config = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.json'), 'utf8'));
  assert.ok(['warn', 'block'].includes(config.mode), 'el modo escrito');
  assert.deepStrictEqual(Object.keys(config.forms).sort(), Object.keys(ih.FORMS).sort(), 'una entrada por forma, ni una más');
  for (const [form, f] of Object.entries(config.forms)) assert.ok(['warn', 'block'].includes(f.mode), `${form}: su modo`);
  assert.ok(Array.isArray(config.nonPublicRoots) && config.nonPublicRoots.length, 'las carpetas que no son públicas');
  // en el repo del equipo, esas carpetas son destinos no públicos del reparto (en la copia el reparto no viaja)
  const split = path.join(RAIZ, 'scripts', 'publishing', 'split.json');
  if (fs.existsSync(split)) {
    const globs = JSON.parse(fs.readFileSync(split, 'utf8')).rules.map((r) => r.glob);
    for (const root of config.nonPublicRoots) assert.ok(globs.includes(`${root}/**`), `${root}/ tiene que ser una carpeta que el reparto no da por pública`);
  }
});

test('InternalHistoryGuard_RealAllowedList_EveryEntryHasItsForm — cada dato declarado dice de qué forma es', () => {
  const allowed = JSON.parse(fs.readFileSync(path.join(RAIZ, ALLOWED), 'utf8')).allowed;
  for (const e of allowed) {
    assert.ok(Object.keys(ih.FORMS).includes(e.form), `${e.file}: «form» tiene que ser una forma del control`);
    assert.ok(e.file && e.value && e.reason, `${e.file}: archivo, valor exacto y motivo`);
  }
});

test('InternalHistoryGuard_RealRepo_AllRuns_NoStaleDeclarations — sobre este repo cuenta, y no hay declaraciones colgadas', () => {
  const home = tmp('internal-history-real-home');
  const r = spawnSync(process.execPath, [GUARD, '--repo', RAIZ, '--all', '--json'], { cwd: RAIZ, encoding: 'utf8', env: cleanEnv({ HOME: home, USERPROFILE: home }) });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const d = JSON.parse(r.stdout);
  assert.ok(['team', 'public'].includes(d.mode));
  assert.strictEqual(typeof d.total, 'number');
  assert.deepStrictEqual(d.stale, [], 'una declaración que ya no hace falta, sale');
});

// ══ las guías y las portadas, en cero (tanda G2 · AC 26 · T26) ═══════════════════════════════════

// Lo que la tanda G2 deja en cero, por la ruta con que el control nombra cada archivo: en el repo del equipo un papel
// figura con su ruta de `scripts/publishing/public-files/`; en el público, con la de su destino.
const isGuideOrCover = (file) => /^guides\//.test(file) || /^(README|INSTALL|story-format)\.md$/.test(file)
  || /^(getting-started|\.github)\//.test(file) || /^scripts\/publishing\/public-files\//.test(file);
const MEASUREMENT = path.join(RAIZ, 'tasks', 'measurement-8.26-tanda-g');
// El registro de incidentes de verdad vive sólo en el repo del equipo; la copia trae una página en su lugar.
const TEAM_LOG = fs.existsSync(path.join(RAIZ, 'scripts', 'publishing', 'public-repos.json')) ? path.join(RAIZ, 'guides', 'incident-log.md') : null;

test('PublishedGuidesAndCovers_NoInternalHistory (T26) — ninguna guía ni portada que se publica trae una forma de historia interna', () => {
  // la misma cuenta que `--all` (la línea de comandos la cuida la prueba de arriba), sobre el commit de HEAD
  const d = ih.run({ mode: 'all', repo: RAIZ, ref: 'HEAD', config: null });
  assert.strictEqual(d.outcome, 'counted');
  const left = Object.entries(d.files).filter(([file]) => isGuideOrCover(file))
    .map(([file, forms]) => `${file}: ${Object.entries(forms).map(([form, n]) => `${form} ${n}`).join(', ')}`);
  assert.deepStrictEqual(left, [], 'cada guía y cada portada dice la regla y su porqué, sin el caso: lo que es un dato o un ejemplo se declara, con su motivo');
  // y el cero no es un cero vacío: el control miró las portadas y las guías
  const looked = d.paths.filter(isGuideOrCover);
  for (const f of ['README.md', 'INSTALL.md', 'story-format.md']) assert.ok(looked.includes(f), `${f} está entre lo mirado`);
  assert.ok(looked.filter((f) => f.startsWith('guides/')).length >= 40, `las guías están entre lo mirado (${looked.length} archivos)`);
});

// Esta es un SELLO, no una medición: lee la cuenta que la tanda dejó escrita y mira que sea coherente. El cero de hoy
// lo vuelve a medir la prueba de arriba. Lo que el control no ve no se vuelve a contar acá a propósito: la decisión 13
// (f) de la story dice que el control no lo cuida después de la tanda (un techo vivo sería una forma más, sin su
// medición de falsos positivos).
test('PublishedGuidesAndCovers_CountBeforeAfter (T26) — la cuenta de antes y después, por archivo, está escrita y cuadra', (t) => {
  if (!fs.existsSync(MEASUREMENT)) return t.skip('NO MEDIDO en la copia pública: la medición de la tanda no se publica');
  const file = path.join(MEASUREMENT, 'after-g2.json');
  assert.ok(fs.existsSync(file), 'falta tasks/measurement-8.26-tanda-g/after-g2.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sum = (files) => Object.values(files).reduce((a, forms) => a + Object.values(forms).reduce((x, y) => x + y, 0), 0);
  assert.ok(m.before.total > 1000, 'la cuenta de antes es la del control sobre la base de la tanda');
  assert.strictEqual(sum(m.before.files), m.before.total, 'la cuenta de antes suma lo que dice');
  assert.strictEqual(m.after.total, 0, 'después: cero en guías y portadas');
  assert.deepStrictEqual(m.after.files, {}, 'después: ningún archivo con formas');
  for (const f of Object.keys(m.before.files)) assert.ok(isGuideOrCover(f), `${f}: la cuenta de la tanda es de guías y portadas`);
  // lo que el control no ve a sabiendas (decisión 13 f): contado antes y después, y lo que queda dice por qué
  assert.ok(m.unseen && m.unseen.before.total >= m.unseen.after.total, 'lo que el control no ve también se contó antes y después');
  assert.strictEqual((m.unseen.kept || []).reduce((a, k) => a + k.count, 0), m.unseen.after.total, 'cada aparición que queda está anotada');
  for (const k of m.unseen.kept || []) assert.ok(k.file && k.reason && k.count > 0, 'lo que queda: archivo, cuántas y motivo');
  // el papel que se lee dice el mismo total que el dato
  const md = fs.readFileSync(path.join(MEASUREMENT, 'after-g2.md'), 'utf8');
  assert.ok(md.includes(String(m.before.total).replace(/\B(?=(\d{3})+(?!\d))/g, '.')), 'el papel de la cuenta dice el mismo total de antes');
});

test('PublishedGuidesAndCovers_CasesKeptInTheLog (T26) — cada enlace que salió de una guía quedó anotado en el registro', (t) => {
  if (!TEAM_LOG) return t.skip('NO MEDIDO en la copia pública: el registro de incidentes no se publica');
  const log = fs.readFileSync(TEAM_LOG, 'utf8');
  const start = log.indexOf('\n## Qué guía citaba cada caso');
  assert.ok(start > 0, 'el registro tiene la tabla «Qué guía citaba cada caso»');
  const table = log.slice(start);
  const cites = JSON.parse(fs.readFileSync(path.join(MEASUREMENT, 'citations-g2.json'), 'utf8')).citations;
  assert.ok(cites.length > 100, 'la tabla salió a máquina de las guías, antes de sacar los enlaces');
  const missing = cites.filter((c) => !table.includes(`| \`${c.anchor}\` | \`${c.guide}\` | ${c.section} |`)).map((c) => `${c.anchor} ← ${c.guide}`);
  assert.deepStrictEqual(missing, [], 'cada cita sacada tiene su fila: «qué caso motivó esta regla» se sigue pudiendo contestar');
  // un ancla que el registro no tiene no se da por anotada sin decirlo (las anclas, como las lee el guion que sacó la tabla)
  const anchors = require(path.join(MEASUREMENT, 'citations.js')).logAnchors(log);
  for (const c of cites) assert.strictEqual(c.resolved, anchors.has(c.anchor), `${c.anchor}: la tabla dice si el caso está en el registro`);
});

test('PublishedGuidesAndCovers_MeasurementScripts (T26) — los dos guiones de la medición ven lo que dicen ver', (t) => {
  if (!fs.existsSync(MEASUREMENT)) return t.skip('NO MEDIDO en la copia pública: la medición de la tanda no se publica');
  const unseen = require(path.join(MEASUREMENT, 'unseen.js'));
  const hit = (text) => Object.entries(unseen.CANDIDATES).filter(([, re]) => { re.lastIndex = 0; return re.test(text); }).map(([kind]) => kind);
  // cada candidata, con su rojo y su verde (los rojos, por partes: este archivo se publica)
  const cases = [
    ['stage', j('la Etapa', ' C del plan'), 'cada etapa del ciclo'],
    ['stretch', j('en el tramo', ' 2'), 'un tramo del recorrido'],
    ['pass', j('en la pasada', ' 3'), 'en una pasada'],
    ['pass', j('la vuelta', ' 2 de revisores'), 'otra vuelta de revisores'],
    ['fix', j('el FIX', '-4'), 'el arreglo'],
    ['finding', j('el hallazgo', ' #9'), 'un hallazgo'],
    ['asked', j('el dev', ' pidió que frene'), 'pausa para decisión del dev'],
    ['adversarial', j('el pase adversarial de', ' la tanda'), 'el pase adversarial'],
    // las variantes de la misma clase que encontró el pase adversarial de la tanda (la primera lista las dejaba pasar)
    ['pass', j('en la ronda', ' 2 de revisores'), 'dos rondas consecutivas'],
    ['batchNumber', j('la Tanda', ' 2 queda cerrada'), 'por tanda'],
    ['substep', j('el registro', ' D.4 del plan'), 'el registro de incidentes'],
    ['substep', j('(D', '.5)'), 'la sección §2.4 y la versión 1.20.0'],
    ['asked', j('El dueño', ' firmó la clase entera'), 'lo firma el dueño del repo'],
    ['adversarial', j('Revisión adversarial', ' 2026-08-19 (14 hallazgos)'), 'una revisión adversarial'],
    ['lettered', j('un pipeline real de la story', ' CO-3'), 'una story de backend'],
    ['numberedRun', j('medido en el run', ' 9.4 del pipeline'), 'medido en una corrida del pipeline'],
    ['numberedRun', j('(caso', ' 2.15: una suite de consola)'), 'en ese caso, 2.5 veces más lento'],
  ];
  for (const [kind, red, green] of cases) {
    assert.ok(hit(red).includes(kind), `${kind}: ve su ejemplo rojo`);
    assert.deepStrictEqual(hit(green), [], `${kind}: deja pasar el verde («${green}»)`);
  }
  // lo que está en un bloque interno no se publica: no se cuenta, y la línea informada sigue siendo la del archivo
  const lines = unseen.withoutInternal(['uno', INTERNAL_START, j('la Etapa', ' C'), INTERNAL_END, 'cinco'].join('\n'));
  assert.deepStrictEqual(lines, ['uno', '', '', '', 'cinco']);
  // por renglón lógico, como el control: una candidata partida por el corte del párrafo se ve, en la línea donde empieza
  assert.deepStrictEqual(unseen.candidatesOf(['# Título', '', j('Esto se hizo en la Etapa'), 'C del plan.', ''].join('\n')).map((c) => [c.kind, c.line]), [['stage', 3]]);
  assert.deepStrictEqual(unseen.candidatesOf(j('el dueño', '\n', 'decidió seguir\n')).map((c) => c.kind), ['asked'], 'también el verbo en el renglón siguiente');
  // los `.md` nuevos que HEAD no tiene: sin trackear, agregados, agregados y vueltos a editar, con intención de agregar,
  // y con un nombre que git escaparía entre comillas (con `-z` llega tal cual)
  const status = ['?? guides/a.md', 'A  guides/b.md', 'AM guides/c.md', ' A guides/d.md', 'R  guides/e.md', 'guides/antes.md', ' M guides/f.md', '?? guides/ñandú.md', '?? x.js', ''].join('\0');
  assert.deepStrictEqual(unseen.newFilesFrom(status), ['guides/a.md', 'guides/b.md', 'guides/c.md', 'guides/d.md', 'guides/e.md', 'guides/ñandú.md'], 'también el nombre nuevo de un renombre: HEAD lo conoce por el de antes');
  // una opción que pide valor y no lo trae es un error, nunca «sin la opción» (la cuenta «de antes» saldría igual a la de después)
  for (const bad of [['--ref'], ['--ref', ''], ['--set'], ['--unknown-flag']]) assert.throws(() => unseen.parseArgs(bad), /pide un valor|no entiendo/, JSON.stringify(bad));
  assert.deepStrictEqual(unseen.parseArgs(['--ref', 'abc123', '--json']), { ref: 'abc123', set: 'g2', json: true, lines: false });
  assert.throws(() => unseen.count('', 'g2'), /--ref tiene que ser/, 'una referencia vacía no mide el árbol de trabajo');
  // las anclas del registro: el identificador entre comillas invertidas, el `{#id}` escrito, y el encabezado desnudo
  const { logAnchors, citationsOf } = require(path.join(MEASUREMENT, 'citations.js'));
  const anchors = logAnchors(['### `caso-uno` — algo', '### caso-dos {#caso-dos}', '## caso-tres', '<a id="caso-cuatro"></a>', '### `caso-ñandú-2026`'].join('\n'));
  for (const a of ['caso-uno', 'caso-dos', 'caso-tres', 'caso-cuatro', 'caso-ñandú-2026']) assert.ok(anchors.has(a), `${a} es un ancla del registro`);
  const guide = ['# Guía', '## Una sección', j('ver incident-log.md', '#caso-uno.'), '```', '## no es un encabezado', j('(caso: incident-log', '#caso-nueve)'), '```'].join('\n');
  assert.deepStrictEqual(citationsOf('guides/x.md', guide, anchors), [
    { anchor: 'caso-uno', guide: 'guides/x.md', section: 'Una sección', resolved: true },
    { anchor: 'caso-nueve', guide: 'guides/x.md', section: 'Una sección', resolved: false },
  ], 'cada cita, con su sección y si el registro la tiene; dentro de un cerco también se ve, y un «##» de un cerco no es una sección');
  // un ancla con letras acentuadas se lee entera (el registro las tiene), y los cercos se siguen por su carácter, su
  // largo y su sangría: un `~~~` o un cerco más corto adentro de otro no lo cierran, y uno con cuatro espacios es contenido
  const tricky = ['## Real', '````markdown', '## Falso uno', '```js', '~~~', '```', '## Falso dos', '````', '## Otra real',
    '```markdown', '    ```csharp', '    ```', '## Falso tres', '```', j('ver incident-log.md', '#caso-ñandú-2026'), '## Última', j('y ``` suelto `incident-log', '#caso-dos` en línea'), '## Después del código en línea', j('incident-log', '#caso-tres')].join('\n');
  assert.deepStrictEqual(citationsOf('guides/y.md', tricky, anchors).map((c) => [c.anchor, c.section, c.resolved]), [
    ['caso-ñandú-2026', 'Otra real', true], ['caso-dos', 'Última', true], ['caso-tres', 'Después del código en línea', true],
  ]);
  // una referencia que empieza con un guion no llega a git como opción
  for (const script of ['unseen.js', 'citations.js']) {
    const r = spawnSync(process.execPath, [path.join(MEASUREMENT, script), '--ref', '--output=x'], { cwd: RAIZ, encoding: 'utf8', env: cleanEnv() });
    assert.strictEqual(r.status, 2, `${script}: una referencia que parece una opción no se acepta\n${r.stdout}${r.stderr}`);
  }
});

test('PublishedGuidesAndCovers_PublicLogPage (T26) — la página pública del registro no dice que las guías enlazan a ella', () => {
  const page = TEAM_LOG ? path.join(RAIZ, 'scripts', 'publishing', 'public-files', 'guides', 'incident-log.md') : path.join(RAIZ, 'guides', 'incident-log.md');
  const text = fs.readFileSync(page, 'utf8');
  assert.ok(!/links here|enlazan acá|Every guide still cites|Las guías los siguen citando/i.test(text), 'las guías ya no citan el caso ni enlazan a esta página');
  assert.match(text, /repo(sitorio)? de mantenimiento|maintenance repository/i, 'dice dónde viven los casos');
  assert.deepStrictEqual(ih.scan(text, 'prose').map((f) => f.form), [], 'y ella misma no trae formas');
});

// ══ las skills, los revisores y los bloques, en cero (tanda G3 · AC 55 · T58) ═════════════════════

// Lo que la tanda G3 deja en cero. En esos archivos el `.md` es la conducta: un revisor decide según su texto y el
// pipeline hace lo que dicen sus pasos. Por eso la tanda no se mide sólo con la cuenta: las traducciones a Codex salen
// del mismo texto, y el examen de los revisores corrió dos veces antes y dos después.
const isSkillReviewerOrBlock = (file) => /^(agents|skills|claude-md-blocks|commands)\//.test(file);

test('SkillsReviewersAndBlocks_NoInternalHistory (T58) — ninguna skill, revisor ni bloque que se publica trae una forma de historia interna', () => {
  const d = ih.run({ mode: 'all', repo: RAIZ, ref: 'HEAD', config: null });
  assert.strictEqual(d.outcome, 'counted');
  const left = Object.entries(d.files).filter(([file]) => isSkillReviewerOrBlock(file))
    .map(([file, forms]) => `${file}: ${Object.entries(forms).map(([form, n]) => `${form} ${n}`).join(', ')}`);
  assert.deepStrictEqual(left, [], 'cada revisor, cada skill y cada bloque dice la regla y su porqué, sin el caso: el ejemplo de una salida va con marcador, y un dato se declara con su motivo');
  // y el cero no es un cero vacío: el control miró los revisores, los pasos del pipeline y los bloques
  const looked = d.paths.filter(isSkillReviewerOrBlock);
  assert.ok(looked.filter((f) => f.startsWith('agents/')).length >= 20, `los revisores están entre lo mirado (${looked.length} archivos)`);
  assert.ok(looked.filter((f) => f.startsWith('skills/tycon-pipeline/steps/')).length >= 12, 'los pasos del pipeline están entre lo mirado');
  assert.ok(looked.filter((f) => f.startsWith('claude-md-blocks/')).length >= 2, 'los bloques siempre cargados están entre lo mirado');
});

// Un SELLO, como el de la tanda anterior: lee la cuenta que la tanda dejó escrita y mira que sea coherente.
test('SkillsReviewersAndBlocks_CountBeforeAfter (T58) — la cuenta de antes y después, por archivo, está escrita y cuadra', (t) => {
  if (!fs.existsSync(MEASUREMENT)) return t.skip('NO MEDIDO en la copia pública: la medición de la tanda no se publica');
  const file = path.join(MEASUREMENT, 'after-g3.json');
  assert.ok(fs.existsSync(file), 'falta tasks/measurement-8.26-tanda-g/after-g3.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sum = (files) => Object.values(files).reduce((a, forms) => a + Object.values(forms).reduce((x, y) => x + y, 0), 0);
  assert.ok(m.before.total > 400, 'la cuenta de antes es la del control sobre la base de la tanda');
  assert.strictEqual(sum(m.before.files), m.before.total, 'la cuenta de antes suma lo que dice');
  assert.strictEqual(m.after.total, 0, 'después: cero en skills, revisores y bloques');
  assert.deepStrictEqual(m.after.files, {}, 'después: ningún archivo con formas');
  for (const f of Object.keys(m.before.files)) assert.ok(isSkillReviewerOrBlock(f), `${f}: la cuenta de la tanda es de skills, revisores y bloques`);
  assert.ok(m.unseen && m.unseen.before.total >= m.unseen.after.total, 'lo que el control no ve también se contó antes y después');
  assert.strictEqual((m.unseen.kept || []).reduce((a, k) => a + k.count, 0), m.unseen.after.total, 'cada aparición que queda está anotada');
  for (const k of m.unseen.kept || []) assert.ok(k.file && k.reason && k.count > 0, 'lo que queda: archivo, cuántas y motivo');
  // la lista de ejemplos de salida (escrita antes de reescribir): cada archivo que tenía un ejemplo con número lo
  // tiene hoy como marcador, no borrado ni con el número de vuelta
  const examplesFile = path.join(MEASUREMENT, 'examples-g3.md');
  assert.ok(fs.existsSync(examplesFile), 'falta la lista de ejemplos de salida (examples-g3.md)');
  const withMarker = fs.readFileSync(examplesFile, 'utf8').split('\n')
    .map((line) => line.match(/^\| `((?:agents|skills)\/[^`]+\.md)` \|.*\|([^|]*)\|\s*$/))
    .filter((m) => m && /<[^>]+>/.test(m[2])).map((m) => m[1]);
  assert.ok(withMarker.length >= 12, `la lista nombra los archivos con ejemplos (${withMarker.length})`);
  // por archivo, al menos tantos marcadores como renglones de la lista: borrar uno de sus ejemplos se ve
  const rows = {};
  for (const rel of withMarker) rows[rel] = (rows[rel] || 0) + 1;
  for (const [rel, n] of Object.entries(rows)) {
    const markers = (fs.readFileSync(path.join(RAIZ, rel), 'utf8').match(/<N\.M>|<otra N\.M>|<N-M>|<sha>|<id>|<rama>|<otra>/g) || []).length;
    assert.ok(markers >= n, `${rel}: ${n} ejemplo(s) de salida en la lista y ${markers} marcador(es) en el archivo`);
  }
  // el skill del pipeline se midió con una corrida sobre una story de juguete: el papel dice qué hizo de cada lado
  const toy = fs.readFileSync(path.join(MEASUREMENT, 'toy-run-g3.md'), 'utf8');
  assert.match(toy, /\| # \| Con el texto de antes \| Con el texto de después \|/, 'la corrida de juguete, de los dos lados');
  for (const step of ['pipeline.js start', 'agente tycon-story-validator', 'skill bmad-dev-story', 'pipeline.js risk-class']) {
    assert.ok(toy.split(step).length >= 3, `«${step}» está en las dos corridas`);
  }
  // lo que la tanda no pudo medir queda dicho, no callado
  assert.ok(Array.isArray(m.notMeasured) && m.notMeasured.length > 0 && m.notMeasured.every((x) => x.what && x.why), 'lo que no se midió, con su motivo');
  const md = fs.readFileSync(path.join(MEASUREMENT, 'after-g3.md'), 'utf8');
  assert.ok(md.includes(String(m.before.total)), 'el papel de la cuenta dice el mismo total de antes');
});

test('SkillsReviewersAndBlocks_CasesKeptInTheLog (T58) — cada enlace que salió de un revisor, una skill o un bloque quedó anotado en el registro', (t) => {
  if (!TEAM_LOG) return t.skip('NO MEDIDO en la copia pública: el registro de incidentes no se publica');
  const log = fs.readFileSync(TEAM_LOG, 'utf8');
  const start = log.indexOf('\n### Qué skill, revisor o bloque citaba cada caso');
  assert.ok(start > 0, 'el registro tiene la tabla «Qué skill, revisor o bloque citaba cada caso»');
  const table = log.slice(start);
  const cites = JSON.parse(fs.readFileSync(path.join(MEASUREMENT, 'citations-g3.json'), 'utf8')).citations;
  assert.ok(cites.length > 60, 'la tabla salió a máquina, antes de sacar los enlaces');
  const missing = cites.filter((c) => !table.includes(`| \`${c.anchor}\` | \`${c.guide}\` | ${c.section} |`)).map((c) => `${c.anchor} ← ${c.guide}`);
  assert.deepStrictEqual(missing, [], 'cada cita sacada tiene su fila');
  const anchors = require(path.join(MEASUREMENT, 'citations.js')).logAnchors(log);
  for (const c of cites) assert.strictEqual(c.resolved, anchors.has(c.anchor), `${c.anchor}: la tabla dice si el caso está en el registro`);
});

test('SkillsReviewersAndBlocks_TranslationsRegenerated (T58) — las traducciones a Codex salen del texto de hoy', (t) => {
  const generate = path.join(RAIZ, 'build', 'generate.js');
  if (!fs.existsSync(generate)) return t.skip('NO MEDIDO: este árbol no trae el generador de las traducciones');
  const r = spawnSync(process.execPath, [generate, '--check'], { cwd: RAIZ, encoding: 'utf8', env: cleanEnv() });
  assert.strictEqual(r.status, 0, `una traducción quedó atrás de su revisor: corré «node build/generate.js»\n${String(r.stdout).split('\n').filter((l) => !l.startsWith('✅')).join('\n')}${r.stderr}`);
});

// Otro SELLO: el examen de los revisores tocados, dos pasadas antes de reescribir y dos después. Un veredicto que cambia
// sólo cuenta si cambia en las dos de después contra las dos de antes; lo demás es ruido, y queda anotado.
test('SkillsReviewersAndBlocks_ExamVerdictsUnchanged (T58) — el examen de los revisores tocados da lo mismo antes y después', (t) => {
  if (!fs.existsSync(MEASUREMENT)) return t.skip('NO MEDIDO en la copia pública: la medición de la tanda no se publica');
  const file = path.join(MEASUREMENT, 'exam-g3.json');
  assert.ok(fs.existsSync(file), 'falta tasks/measurement-8.26-tanda-g/exam-g3.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cases = Object.entries(m.cases);
  assert.ok(cases.length >= 80, `el examen cubrió los casos de los revisores tocados (${cases.length})`);
  const same = (a) => a.every((x) => x === a[0]);
  const changed = []; const noise = [];
  for (const [key, c] of cases) {
    for (const side of ['before', 'after']) {
      assert.ok(Array.isArray(c[side]) && c[side].length === 2 && c[side].every((x) => typeof x === 'boolean'), `${key}: dos pasadas de «${side}», cada una con su veredicto`);
    }
    if (same(c.before) && same(c.after) && c.before[0] !== c.after[0]) changed.push(key);
    else if (!same(c.before) || !same(c.after)) noise.push(key);
  }
  assert.deepStrictEqual(changed, [], 'ningún caso cambia de veredicto en las dos pasadas de después contra las dos de antes');
  assert.deepStrictEqual([...(m.noise || [])].map((n) => n.case).sort(), noise.sort(), 'cada caso que contestó distinto entre pasadas está anotado como ruido');
  // de cada revisor que la tanda tocó hay al menos un caso
  const reviewers = new Set(cases.map(([key]) => key.split('::')[0]));
  for (const r of m.reviewers) assert.ok(reviewers.has(r), `${r}: tocado por la tanda y con casos en el examen`);
  assert.ok(m.reviewers.length >= 18, 'los revisores tocados están listados');
});
