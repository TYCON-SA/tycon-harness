#!/usr/bin/env node
'use strict';
/**
 * run-size.test.js — el tamaño de la corrida: liviana (sólo documentación o textos) o completa (lo demás), el tiempo
 * estimado que sale de las corridas archivadas, y las suites que corre una liviana.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/run-size.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const size = require(path.join(SCRIPTS, 'lib', 'run-size.js'));

const docs = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? `guides/g${i}.md` : `guides/img/cap-${i}.png`));

test('7.32-SoloTexto_Liviana: 20 documentos y capturas con 15 ACs salen livianos', () => {
  const r = size.classifyStory({ files: docs(20), acCount: 15 });
  assert.equal(r.size, 'liviana');
  assert.match(r.reason, /sólo documentación/);
  assert.equal(r.first_code_file, null);
});

test('7.32-UnArchivoDeCodigo_Completa: 19 documentos y un .js salen completos y nombran el .js', () => {
  const r = size.classifyStory({ files: [...docs(19), 'scripts/lib/algo.js'] });
  assert.equal(r.size, 'completa');
  assert.equal(r.first_code_file, 'scripts/lib/algo.js');
  assert.match(r.reason, /scripts\/lib\/algo\.js/);
});

test('7.32-RutasQueVuelvenCompleta: seguridad, producción, instalador, CI, configuración y shell', () => {
  const casos = [
    ['guides/security/claves.md', /seguridad/],
    ['scripts/production/notas.md', /producción/],
    ['install-tycon-hooks.md', /instalador/],
    ['pipelines/azure-pipelines-x.md', /CI/],
    ['.tycon/advisors.json', /\.json/],
    ['scripts/tools/x.sh', /\.sh/],
  ];
  for (const [f, motivo] of casos) {
    const r = size.classifyStory({ files: ['guides/a.md', f] });
    assert.equal(r.size, 'completa', `${f} tendría que volver completa la corrida`);
    assert.equal(r.first_code_file, f);
    assert.match(r.reason, motivo, `${f}: el motivo dice por qué (${r.reason})`);
  }
});

test('7.32-SinArchivos_Completa: una story sin archivos declarados es completa', () => {
  const r = size.classifyStory({ files: [] });
  assert.equal(r.size, 'completa');
  assert.match(r.reason, /no declara archivos/);
});

test('7.32-SuperficieManda: deep_review_always_paths y deep_review: always vuelven completa una de texto', () => {
  const porRuta = size.classifyStory({ files: ['guides/a.md', 'skills/x/SKILL.md'], alwaysPaths: ['skills/**'] });
  assert.equal(porRuta.size, 'completa');
  assert.match(porRuta.reason, /superficie compartida/);
  const porRepo = size.classifyStory({ files: ['guides/a.md'], deepReviewCfg: 'always' });
  assert.equal(porRepo.size, 'completa');
  assert.match(porRepo.reason, /deep_review: always/);
});

function historia(corridas) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-size-hist-'));
  corridas.forEach((c, i) => {
    const start = new Date(Date.UTC(2026, 9, 1, 10, 0, 0));
    const end = new Date(start.getTime() + c.min * 60000);
    const marker = {
      storyId: `9.${i}`, startedAt: start.toISOString(), lastTouch: end.toISOString(),
      stepTimings: { 8: { completedAt: end.toISOString() } }, stepsCompleted: c.abandoned ? [0, 1, 2] : [0, 1, 2, 3, 4, 5, 6, 7, 8],
      ...(c.size ? { size: c.size } : {}), filesTouched: c.files || [],
    };
    fs.writeFileSync(path.join(dir, `9.${i}-2026-10-01T1000.json`), JSON.stringify({ archivedAt: end.toISOString(), marker }));
  });
  return dir;
}

test('7.32-Estimacion_DeLaHistoria: la mediana de las livianas archivadas, con su fuente', () => {
  const dir = historia([
    { size: 'liviana', min: 30 }, { size: 'liviana', min: 50 }, { size: 'liviana', min: 40 },
    { size: 'liviana', min: 20 }, { size: 'liviana', min: 60 },
    { size: 'completa', min: 300 },
    { size: 'liviana', min: 1, abandoned: true },   // abandonada: no cuenta
    // sin `size`: se clasifica por lo que tocó (los archivos de la corrida no cuentan)
    { min: 400, files: ['/x/repo/scripts/a.js', '/x/repo/.advisors/pipeline-runs/r/step-02.md'] },
  ]);
  const e = size.estimate({ size: 'liviana', historyDir: dir });
  assert.equal(e.minutes, 40);
  assert.equal(e.samples, 5);
  assert.match(e.source, /mediana de 5 corridas livianas terminadas/);
  const c = size.estimate({ size: 'completa', historyDir: dir });
  assert.equal(c.samples, 2, 'la vieja sin tamaño cuenta como completa por el .js que tocó');
  assert.equal(c.minutes, 350);
  // un registro ilegible se dice aunque haya muestras buenas
  fs.writeFileSync(path.join(dir, 'roto.json'), '{');
  assert.match(size.estimate({ size: 'liviana', historyDir: dir }).source, /1 registro\(s\) ilegible/);
});

test('7.32-Estimacion_SinHistoria: sin registro, el número fijo y lo dice', () => {
  const e = size.estimate({ size: 'liviana', historyDir: path.join(os.tmpdir(), 'no-existe-run-size') });
  assert.equal(e.minutes, size.FIXED_MINUTES.liviana);
  assert.equal(e.samples, 0);
  assert.match(e.source, /estimado sin historia/);
  const c = size.estimate({ size: 'completa', historyDir: null });
  assert.equal(c.minutes, size.FIXED_MINUTES.completa);
});

test('7.32-Suites_SoloLasQueLeen: una liviana corre las suites que leen la guía y difiere las demás', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'run-size-suites-'));
  const t = path.join(repo, 'scripts', 'tests');
  fs.mkdirSync(t, { recursive: true });
  fs.mkdirSync(path.join(repo, 'guides'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'guides', 'piezas.md'), '# piezas\n');
  const ok = "require('node:test').test('x', () => {});\n";
  fs.writeFileSync(path.join(t, 'lee-la-guia.test.js'), `// lee guides/piezas.md\n${ok}`);
  fs.writeFileSync(path.join(t, 'por-nombre.test.js'), `// abre piezas.md\n${ok}`);
  fs.writeFileSync(path.join(t, 'otra.test.js'), ok);
  fs.writeFileSync(path.join(t, 'suites.json'), JSON.stringify({
    diarias: [
      { raiz: 'arnes', ruta: 'tests/lee-la-guia.test.js' },
      { raiz: 'arnes', ruta: 'tests/por-nombre.test.js' },
      { raiz: 'arnes', ruta: 'tests/otra.test.js' },
    ],
  }));
  const touched = path.join(repo, 'touched.json');
  fs.writeFileSync(touched, JSON.stringify({ known: true, files: ['guides/piezas.md'] }));
  const out = path.join(repo, 'resumen.json');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'run-suites-json.js'), repo, out,
    '--skills', repo, '--touched', touched, '--light'], { encoding: 'utf8', env: { ...process.env, TYCON_GATE_ALL_SUITES: '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(res.corridas, 2, 'corren las dos que nombran la guía');
  assert.deepEqual(res.deferred_suites.map((d) => path.basename(d.suite)), ['otra.test.js']);
  assert.match(res.deferred_suites[0].reason, /diferida por corrida liviana/);
  assert.equal(res.light, true);
});

// La lista de una story que reescribe las fichas de una guía, con los comentarios del frontmatter incluidos.
const LISTA_844 = [
  'tasks/measurement-8.44-piezas/                     # privado: la medición de la tanda A',
  'guides/maintaining/piezas-en-detalle.md            # público: el detalle de cada ficha',
  'scripts/tests/pieces-cards.test.js                 # público: T1-T5, T10, T11',
  'scripts/tests/pieces-destinations.test.js          # privado: T12',
  'guides/piezas-del-arnes.md                         # público: cada ficha reescrita',
  'guides/guide-update-proposals.md                 # privado (el real)',
  'scripts/tests/readme-index.test.js',
  'scripts/tests/guides-moved.test.js',
  'scripts/tests/third-party-skills.test.js',
  'scripts/tests/night-notices.test.js',
  'scripts/tests/upload-runs.test.sh',
  'scripts/tests/suites.json                          # público y privado: las suites nuevas',
  'tasks/todo.md',
  'NOTICE                                             # público: el crédito',
  'scripts/publishing/third-party-skills.json         # público: ídem en el manifiesto de terceros',
  'skills/tycon-pipeline/scripts/tests/unit.test.js   # público: T20',
];

const SIN_MANIFIESTO = LISTA_844.filter((f) => !f.includes('third-party-skills.json'));

test('7.32-Real_8.44_Completa: la 8.44 real sale completa por el manifiesto de terceros, con el motivo a la vista', () => {
  const r = size.classifyStory({ files: LISTA_844 });
  assert.equal(r.size, 'completa');
  assert.equal(r.first_code_file, 'scripts/publishing/third-party-skills.json');
  assert.match(r.reason, /third-party-skills\.json: archivo \.json que es un control/);
});

test('7.32-SoloDocumentacion_Liviana: la 8.44 sin el manifiesto sale liviana (pruebas, suites, tasks/ y NOTICE acompañan al texto)', () => {
  const r = size.classifyStory({ files: SIN_MANIFIESTO });
  assert.equal(r.size, 'liviana', r.reason);
});

test('7.32-Control_Completa: un JSON que es un control vuelve completa la corrida aunque lo demás sea texto', () => {
  for (const f of ['scripts/publishing/denylist.json', 'scripts/publishing/allowlist.json', 'scripts/lib/renames.json',
    '.tycon/internal-forms.json', 'scripts/publishing/split.json', 'scripts/publishing/new-names-exceptions.json',
    'hooks/hooks.json', 'scripts/hooks/safety-rules.json', '.mcp.json', 'renovate.json']) {
    const r = size.classifyStory({ files: [...SIN_MANIFIESTO, f] });
    assert.equal(r.size, 'completa', `${f} es un control`);
    assert.match(r.reason, /\.json/);
  }
});

test('7.32-Carpeta_PorSusArchivos: una carpeta se juzga por lo que trae; sin estar en el repo, completa', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'run-size-dir-'));
  fs.mkdirSync(path.join(repo, 'guides', 'm'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'guides', 'm', 'a.md'), 'x');
  assert.equal(size.classifyStory({ files: ['guides/m/'], roots: [repo] }).size, 'liviana');
  fs.writeFileSync(path.join(repo, 'guides', 'm', 'b.js'), 'x');
  assert.equal(size.classifyStory({ files: ['guides/m/'], roots: [repo] }).size, 'completa');
  assert.equal(size.classifyStory({ files: ['otra/'], roots: [repo] }).size, 'completa');
});

// ── lo que no puede pasar como texto: listas mal leídas, instrucciones del agente, lógica bajo tests/ ──
test('7.32-Lector_ListasEnLineaYComentarios: el lector de la story lee [a, b] y la clave con comentario', () => {
  const st = '---\nstory: "9"\nfiles_to_create: [guides/a.md, src/new.js]\nfiles_to_modify:   # los que cambian\n  - guides/b.md   # nota\n  - "src/c.js"\n---\n# x\n';
  assert.deepEqual(size.declaredFiles(st), ['guides/a.md', 'src/new.js', 'guides/b.md', 'src/c.js']);
  // la lista pegada al margen también se lee
  assert.deepEqual(size.declaredFiles('---\nfiles_to_modify:\n- guides/a.md\n- src/x.js\nstatus: x\n---\n'), ['guides/a.md', 'src/x.js']);
  // un comentario pegado al margen o un renglón vacío en el medio no cortan la lista
  assert.deepEqual(size.declaredFiles('---\nfiles_to_modify:\n- guides/a.md\n# público\n\n- src/x.js\nstatus: x\n---\n'), ['guides/a.md', 'src/x.js']);
  assert.equal(size.classifyStory({ files: size.declaredFiles(st) }).size, 'completa');
});

test('7.32-InstruccionesDelAgente_Completa: SKILL.md, los pasos, los revisores y CLAUDE.md no son documentación', () => {
  for (const f of ['skills/x/SKILL.md', 'skills/tycon-pipeline/steps/step-05-implement.md', 'agents/tycon-x.md', 'commands/x.md', 'CLAUDE.md', 'AGENTS.md']) {
    assert.equal(size.classifyStory({ files: ['guides/a.md', f] }).size, 'completa', f);
  }
});

test('7.32-LogicaEnTests_Completa: un helper bajo tests/ es código; una prueba y un fixture, no', () => {
  assert.equal(size.classifyStory({ files: ['guides/a.md', 'scripts/tests/lib/harness-runner.js'] }).size, 'completa');
  assert.equal(size.classifyStory({ files: ['guides/a.md', 'scripts/tests/a.test.js', 'tests/fixtures/x.json'] }).size, 'liviana');
});
