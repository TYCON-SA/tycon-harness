'use strict';

/**
 * export-compare.test.js — el ayudante que compara la copia pública antes y después de una mudanza (story 8.12, AC 4,
 * T6 · tanda R2, 2026-10-02).
 *
 * Lo que no se puede perder:
 *   · Que una ruta que cambió con el MISMO contenido sea «movido», no un hallazgo: la mudanza es eso.
 *   · Que cualquier otra diferencia en lo que sale o en lo que queda excluido, un glob muerto nuevo, el termómetro de
 *     nombres en castellano (`spanishNames`) o el techo de nombres (`names-ceiling`) sea un hallazgo (exit 1).
 *   · Que una foto rota sea «no pude comparar» (exit 2), nunca «iguales».
 *   · Que un cambio de lado (excluido ↔ publicado) nunca quede tapado por contenidos repetidos (T6b, pase adversarial R2).
 *   · Que un git que no pudo contestar al sacar la foto sea «no pude sacarla» (exit 2), no «el techo no está» (T6c).
 *
 * Trabaja con fotos de mentira escritas a mano (la forma que deja `export-compare.js snapshot`): no corre el exportador.
 * La foto contra los repos reales la ejercita `export-real.test.sh`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const COMPARE = path.join(RAIZ, 'scripts', 'publishing', 'export-compare.js');

const clone = (x) => JSON.parse(JSON.stringify(x));
const created = [];

// ── la foto de mentira: la forma que deja `snapshot` ───────────────────────────────────────────────────────────
const BASE = {
  snapshot: {
    version: 1,
    packages: ['core', 'bizuit'],
    explain: { exit: 0 },
    exports: { core: { exit: 0 }, bizuit: { exit: 0 } },
  },
  explain: {
    fuentes: { arnes: { ref: 'HEAD', sha: 'a'.repeat(40) }, 'agent-skills': { ref: 'HEAD', sha: 'b'.repeat(40) } },
    primerNivel: [],
    sinClasificar: [],
    coberturaExclusiones: [],
    exclusionesSinArchivo: [],
  },
  exports: {
    core: {
      resultado: 0, paquete: 'core', globsSinUso: [], entradasSinClasificar: [],
      spanishNames: { files: 1, options: 19, total: 20, dictionary: true },
    },
    bizuit: {
      resultado: 0, paquete: 'bizuit', globsSinUso: [], entradasSinClasificar: [],
      spanishNames: { files: 0, options: 0, total: 0, dictionary: true },
    },
  },
  files: {
    core: {
      shipped: {
        arnes: { 'README.md': 'h-readme', 'scripts/tools/uno.js': 'h-uno', 'guides/guia.md': 'h-guia' },
        'agent-skills': { 'skills/tycon-x/SKILL.md': 'h-skill' },
      },
      excluded: {
        arnes: { 'guides/incident-log.md': 'h-incidentes', 'scripts/metrics/censo-1.json': 'h-censo' },
        'agent-skills': {},
      },
    },
    bizuit: {
      shipped: { arnes: { 'guides/bizuit-x.md': 'h-bizuit' }, 'agent-skills': {} },
      excluded: { arnes: {}, 'agent-skills': {} },
    },
  },
  ceiling: {
    __doc: 'Techo de laboratorio.',
    core: { content: 10, paths: 0, glued: 1 },
    bizuit: { content: 0, paths: 0, glued: 0 },
  },
};

/** Escribe una foto en una carpeta nueva; `mutate` cambia una copia de BASE antes de escribirla. */
function photo(mutate = () => {}) {
  const data = clone(BASE);
  mutate(data);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-'));
  created.push(dir);
  const put = (name, value) => fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  put('snapshot.json', data.snapshot);
  put('explain.json', data.explain);
  for (const [p, v] of Object.entries(data.exports)) put(`export-${p}.json`, v);
  for (const [p, v] of Object.entries(data.files)) put(`files-${p}.json`, v);
  put('names-ceiling.json', data.ceiling);
  return dir;
}

function diff(before, after) {
  const r = spawnSync(process.execPath, [COMPARE, 'diff', before, after, '--json'], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  const human = spawnSync(process.execPath, [COMPARE, 'diff', before, after], { encoding: 'utf8' });
  return { code: r.status, json, out: r.stdout || '', err: r.stderr || '', human: `${human.stdout || ''}${human.stderr || ''}`, humanCode: human.status };
}
const kinds = (r) => (r.json && r.json.findings ? r.json.findings.map((f) => f.kind).sort() : null);

test('T6_SameSnapshots_Exit0', () => {
  const r = diff(photo(), photo());
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(r.json.result, 0);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.moved, []);
  assert.strictEqual(r.humanCode, 0, 'el modo legible da el mismo código');
  assert.match(r.human, /iguales/i, 'el legible lo dice en castellano');
});

test('T6_MovedSameContent_Exit0ListsMoved', () => {
  const after = photo((d) => {
    const s = d.files.core.shipped.arnes;
    delete s['scripts/tools/uno.js'];
    s['scripts/tools/nuevo-lugar/uno.js'] = 'h-uno';
    const e = d.files.core.excluded.arnes;
    delete e['scripts/metrics/censo-1.json'];
    e['inbox/censo-1.json'] = 'h-censo';
  });
  const r = diff(photo(), after);
  assert.strictEqual(r.code, 0, `una ruta que cambió con el mismo contenido no es hallazgo\n${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.moved.map((m) => `${m.package} ${m.set} ${m.source}/${m.from} -> ${m.to}`).sort(), [
    'core excluded arnes/scripts/metrics/censo-1.json -> inbox/censo-1.json',
    'core shipped arnes/scripts/tools/uno.js -> scripts/tools/nuevo-lugar/uno.js',
  ]);
  assert.match(r.human, /movid/i);
  assert.match(r.human, /scripts\/tools\/nuevo-lugar\/uno\.js/);
});

test('T6_SamePathEditedContent_NotAFinding', () => {
  // retocar un archivo que se queda en su lugar (una ruta vieja que se corrige adentro) no cambia el conjunto
  const r = diff(photo(), photo((d) => { d.files.core.shipped.arnes['guides/guia.md'] = 'h-guia-retocada'; }));
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings, []);
});

test('T6_MovedAndEdited_ListedNotFinding', () => {
  // movido Y retocado (un guion que se muda y corrige su require): mismo nombre de archivo, del mismo lado
  const r = diff(photo(), photo((d) => {
    delete d.files.core.shipped.arnes['scripts/tools/uno.js'];
    d.files.core.shipped.arnes['scripts/tools/otra/uno.js'] = 'h-uno-retocado';
  }));
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.movedEdited.map((m) => `${m.source}/${m.from} -> ${m.to}`), ['arnes/scripts/tools/uno.js -> scripts/tools/otra/uno.js']);
});

test('T6_NewShippedFile_Exit1', () => {
  const r = diff(photo(), photo((d) => { d.files.core.shipped.arnes['scripts/nuevo.js'] = 'h-nuevo'; }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(kinds(r), ['new-shipped']);
  assert.match(r.json.findings[0].message, /scripts\/nuevo\.js/);
  assert.match(r.json.findings[0].message, /sale en la copia/);
  assert.strictEqual(r.humanCode, 1);
  assert.match(r.human, /scripts\/nuevo\.js/);
});

test('T6_ExcludedFileGone_Exit1', () => {
  const r = diff(photo(), photo((d) => { delete d.files.core.excluded.arnes['guides/incident-log.md']; }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(kinds(r), ['gone-excluded']);
  assert.match(r.json.findings[0].message, /guides\/incident-log\.md/);
});

test('T6_ExcludedNowShipped_Exit1', () => {
  // lo peor de una mudanza: un archivo excluido que se movió fuera de su exclusión y ahora sale, con el mismo contenido
  const r = diff(photo(), photo((d) => {
    delete d.files.core.excluded.arnes['guides/incident-log.md'];
    d.files.core.shipped.arnes['guides/decisions/incident-log.md'] = 'h-incidentes';
  }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(kinds(r), ['now-shipped'], 'un solo hallazgo, no «nuevo» más «desaparecido»');
  assert.match(r.json.findings[0].message, /guides\/decisions\/incident-log\.md/);
  assert.match(r.json.findings[0].message, /guides\/incident-log\.md/);
  assert.deepStrictEqual(r.json.moved, [], 'cambiar de lado no es un movido');
});

// ── adversarial R2: contenidos repetidos no pueden tapar un cambio de lado ──────────────────────────────────────
// El pase adversarial de la R2 confirmó que, con dos archivos del mismo contenido (los `.gitkeep` vacíos del arnés), un
// archivo que pasaba de excluido a publicado se emparejaba por contenido del mismo lado y salía «movido», con exit 0.
/** Una foto con sólo estos archivos en core/arnes (el resto de BASE igual). `order` invierte el orden de las claves. */
const onlyCoreArnes = (shipped, excluded, order = 'as-is') => photo((d) => {
  const keep = (o) => (order === 'reversed' ? Object.fromEntries(Object.entries(o).reverse()) : o);
  d.files.core.shipped.arnes = keep(shipped);
  d.files.core.excluded.arnes = keep(excluded);
});

test('T6b_SideSwapWithRepeatedContent_Exit1 (adversarial R2)', () => {
  // caso 1 del pase: a/x y b/x tienen el mismo contenido y se cruzan de lado
  let r = diff(onlyCoreArnes({ 'a/x': 'h-rep' }, { 'b/x': 'h-rep' }), onlyCoreArnes({ 'b/x': 'h-rep' }, { 'a/x': 'h-rep' }));
  assert.strictEqual(r.code, 1, `un cruce de lado con contenido repetido es hallazgo\n${r.err}\n${r.out}`);
  assert.deepStrictEqual(kinds(r), ['now-excluded', 'now-shipped']);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.kind} ${f.from} -> ${f.path}`).sort(), ['now-excluded a/x -> a/x', 'now-shipped b/x -> b/x']);
  assert.deepStrictEqual(r.json.moved, [], 'cambiar de lado no es un movido');
  // caso 2 del pase: inbox/.gitkeep (vacío, como d.txt) pasa a publicarse
  r = diff(onlyCoreArnes({ 'd.txt': 'h-vacio' }, { 'inbox/.gitkeep': 'h-vacio' }),
    onlyCoreArnes({ 'inbox/.gitkeep': 'h-vacio' }, { 'other/.gitkeep': 'h-vacio' }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  const shipped = r.json.findings.filter((f) => f.kind === 'now-shipped');
  assert.deepStrictEqual(shipped.map((f) => `${f.from} -> ${f.path}`), ['inbox/.gitkeep -> inbox/.gitkeep'], 'inbox/.gitkeep AHORA SALE');
  assert.match(shipped[0].message, /AHORA SALE/);
  assert.ok(!r.json.moved.some((m) => m.to === 'inbox/.gitkeep' || m.from === 'inbox/.gitkeep'), 'inbox/.gitkeep no es un movido');
  assert.strictEqual(r.humanCode, 1);
});

test('T6b_RepeatedContentOneMovesOtherChangesSide_Exit1 (adversarial R2)', () => {
  // dos archivos idénticos, uno a cada lado: el publicado se muda (legítimo) y el excluido sale de su exclusión
  const before = { shipped: { 'p/a.md': 'h-rep' }, excluded: { 'q/b.md': 'h-rep' } };
  const after = { shipped: { 'p2/a.md': 'h-rep', 'r/b.md': 'h-rep' }, excluded: {} };
  for (const order of ['as-is', 'reversed']) {
    const r = diff(onlyCoreArnes(before.shipped, before.excluded, order), onlyCoreArnes(after.shipped, after.excluded, order));
    assert.strictEqual(r.code, 1, `[${order}] ${r.err}\n${r.out}`);
    assert.deepStrictEqual(r.json.findings.map((f) => `${f.kind} ${f.from} -> ${f.path}`), ['now-shipped q/b.md -> r/b.md'], `[${order}] el que cambió de lado es q/b.md`);
    assert.deepStrictEqual(r.json.moved.map((m) => `${m.set} ${m.from} -> ${m.to}`), ['shipped p/a.md -> p2/a.md'], `[${order}] la mudanza legítima sigue siendo movido`);
  }
});

test('T6b_RepeatedContentOnlyLegitMove_Exit0 (adversarial R2)', () => {
  // varios .gitkeep vacíos (mismo contenido, a los dos lados); sólo se muda una carpeta excluida: sigue dando 0 y cada
  // .gitkeep se empareja con el suyo, en cualquier orden de las claves
  const shipped = { 'scripts/vacio/.gitkeep': 'h-vacio', 'README.md': 'h-readme' };
  const before = { 'notas/pending/.gitkeep': 'h-vacio', 'notas/archived/.gitkeep': 'h-vacio', 'dependencias/x/.gitkeep': 'h-vacio' };
  const after = { 'inbox/notas/pending/.gitkeep': 'h-vacio', 'inbox/notas/archived/.gitkeep': 'h-vacio', 'dependencias/x/.gitkeep': 'h-vacio' };
  for (const order of ['as-is', 'reversed']) {
    const r = diff(onlyCoreArnes(shipped, before), onlyCoreArnes(shipped, after, order));
    assert.strictEqual(r.code, 0, `[${order}] una mudanza legítima con contenidos repetidos no es hallazgo\n${r.err}\n${r.out}`);
    assert.deepStrictEqual(r.json.findings, []);
    assert.deepStrictEqual(r.json.moved.map((m) => `${m.set} ${m.from} -> ${m.to}`).sort(), [
      'excluded notas/archived/.gitkeep -> inbox/notas/archived/.gitkeep',
      'excluded notas/pending/.gitkeep -> inbox/notas/pending/.gitkeep',
    ], `[${order}] cada uno con el suyo`);
  }
});

// ── silent (re-loop R2): un git que no pudo contestar no es «el archivo no está» ────────────────────────────────
// El revisor de fallos silenciosos: `snapshot` leía el techo con `git show` y cualquier salida ≠ 0 quedaba como «no está
// en <sha>», aunque git hubiera fallado por permisos o «dubious ownership»: la foto parecía completa. Estas pruebas
// arman un exportador de laboratorio (sale por su cuenta, sin la copia) y un repo de una sola confirmación.
function labExporter() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-lab-'));
  created.push(root);
  fs.mkdirSync(path.join(root, 'scripts', 'publishing'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'publishing', 'export.js'), `'use strict';
module.exports = { coincide: () => false };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--explain')) {
    process.stdout.write(JSON.stringify({ fuentes: { arnes: { sha: process.env.LAB_SHA } }, sinClasificar: [], exclusionesSinArchivo: [] }));
  } else {
    // LAB_EXPORT_EXIT: 2 = no pudo exportar (la foto sale 2) · 1 = exportó con hallazgos (dato: la foto sale 0)
    const code = Number(process.env.LAB_EXPORT_EXIT || 2);
    process.stdout.write(JSON.stringify({ resultado: code, paquete: 'core', motivo: 'exportación de laboratorio', globsSinUso: [], entradasSinClasificar: [] }));
    process.exitCode = code;
  }
}
`);
  fs.writeFileSync(path.join(root, 'scripts', 'publishing', 'allowlist.json'), '{ "packages": {} }\n');
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'skills-dir.js'), "module.exports = { resolveSkillsDirs: () => ({ repo: __dirname }) };\n");
  return path.join(root, 'scripts', 'publishing', 'export.js');
}
function labRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-repo-'));
  created.push(repo);
  const g = (...args) => {
    const r = spawnSync('git', ['-C', repo, '-c', 'user.name=lab', '-c', 'user.email=lab@example.invalid', ...args], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'repo de laboratorio sin techo\n');
  g('add', 'README.md');
  g('commit', '-q', '-m', 'lab');
  return { repo, sha: g('rev-parse', 'HEAD') };
}
function snapshotLab(env) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-foto-')), 'foto');
  created.push(path.dirname(out));
  const r = spawnSync(process.execPath, [COMPARE, 'snapshot', '--out', out, '--exporter', labExporter(), '--packages', 'core', '--harness', 'HEAD', '--agent-skills', 'HEAD'],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', dir: out };
}

test('T6c_SnapshotCeilingGitFails_Exit2 (silent, re-loop R2)', () => {
  const { repo, sha } = labRepo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-bin-'));
  created.push(bin);
  fs.writeFileSync(path.join(bin, 'git'), "#!/bin/sh\necho \"fatal: detected dubious ownership in repository at '$PWD'\" >&2\nexit 128\n");
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const r = snapshotLab({ LAB_SHA: sha, TYCON_GUIDES_DIR: repo, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.strictEqual(r.code, 2, `git que no pudo contestar = no pude sacar la foto\n${r.out}\n${r.err}`);
  assert.match(r.err, /dubious ownership/, 'dice qué pasó');
  assert.match(r.err, /names-ceiling\.json/);
  assert.doesNotMatch(`${r.out}${r.err}`, /no está en/, 'no lo disfraza de «el archivo no está»');
  assert.ok(!fs.existsSync(path.join(r.dir, 'snapshot.json')), 'nunca una foto que parece completa');
});

test('T6c_SnapshotCeilingMissingInCommit_NoteExit0 (silent, re-loop R2)', () => {
  const { repo, sha } = labRepo();
  // la exportación sale 1 (hallazgos: dato); con 2 la foto entera sale 2 (pase adversarial del tramo 2 de la 8.18, clase 1)
  const r = snapshotLab({ LAB_SHA: sha, TYCON_GUIDES_DIR: repo, LAB_EXPORT_EXIT: '1' });
  assert.strictEqual(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /names-ceiling\.json no está en/, 'la nota de siempre');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'names-ceiling.json'), 'utf8')), null);
  assert.ok(fs.existsSync(path.join(r.dir, 'snapshot.json')));
  // el espejo: la misma foto con la exportación que no pudo salir (2) es 2, y queda escrita para mirarla
  const broken = snapshotLab({ LAB_SHA: sha, TYCON_GUIDES_DIR: repo });
  assert.strictEqual(broken.code, 2, `${broken.out}\n${broken.err}`);
  assert.match(`${broken.out}${broken.err}`, /exportación de core salió 2/);
  assert.ok(fs.existsSync(path.join(broken.dir, 'snapshot.json')));
});

test('T6_NewDeadGlob_Exit1', () => {
  // una exclusión que se quedó sin archivo (--explain) …
  let r = diff(photo(), photo((d) => {
    d.explain.exclusionesSinArchivo.push({ origen: 'fija', fuente: 'arnes', glob: 'guides/vieja/**', relevante: true, archivos: 0, reemplazos: 0 });
  }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(kinds(r), ['dead-glob']);
  assert.match(r.json.findings[0].message, /guides\/vieja\/\*\*/);
  // … un glob de «in» sin uso (la exportación) …
  r = diff(photo(), photo((d) => { d.exports.core.globsSinUso.push('arnes: scripts/viejo/**'); }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(kinds(r), ['dead-glob']);
  // … y una entrada de primer nivel sin clasificar
  r = diff(photo(), photo((d) => { d.explain.sinClasificar.push('arnes/inbox'); }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(kinds(r), ['unclassified']);
  assert.match(r.json.findings[0].message, /arnes\/inbox/);
  // el mismo glob muerto antes y después no es nuevo
  const dead = (d) => { d.exports.core.globsSinUso.push('arnes: scripts/viejo/**'); };
  r = diff(photo(dead), photo(dead));
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
});

test('T6_SpanishNamesDiffer_Exit1', () => {
  const r = diff(photo(), photo((d) => { d.exports.core.spanishNames.options = 20; d.exports.core.spanishNames.total = 21; }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(kinds(r), ['spanish-names']);
  assert.strictEqual(r.json.findings[0].package, 'core');
});

test('T6_CeilingDiffers_Exit1', () => {
  const r = diff(photo(), photo((d) => { d.ceiling.core.content = 11; }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(kinds(r), ['names-ceiling']);
  // el texto que lo explica (`__doc`) no es el techo
  const s = diff(photo(), photo((d) => { d.ceiling.__doc = 'Otro texto.'; }));
  assert.strictEqual(s.code, 0, `${s.err}\n${s.out}`);
});

test('T6_AfterExportFailed_Exit1', () => {
  const r = diff(photo(), photo((d) => {
    d.snapshot.exports.bizuit.exit = 2;
    d.exports.bizuit = { resultado: 2, paquete: 'bizuit', motivo: 'exclusión fija sin archivo: arnes/x', globsSinUso: [], entradasSinClasificar: [] };
    delete d.files.bizuit;
  }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(kinds(r), ['export-failed']);
  assert.match(r.json.findings[0].message, /bizuit[\s\S]*2/);
});

test('T6_BrokenJson_Exit2', () => {
  // un JSON roto en la foto de después
  const broken = photo();
  fs.writeFileSync(path.join(broken, 'files-core.json'), '{ "shipped": ');
  let r = diff(photo(), broken);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.strictEqual(r.json.result, 2);
  assert.match(r.json.reason, /files-core\.json/);
  assert.strictEqual(r.humanCode, 2);
  // una carpeta que no es una foto
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-vacia-'));
  created.push(empty);
  r = diff(photo(), empty);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.json.reason, /snapshot\.json/);
  // una foto «antes» cuya exportación no salió no sirve de base
  r = diff(photo((d) => { d.snapshot.exports.core.exit = 2; d.exports.core = { resultado: 2, motivo: 'x', globsSinUso: [], entradasSinClasificar: [] }; delete d.files.core; }), photo());
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.json.reason, /antes/);
});

test('T6_Usage_Exit2', () => {
  const r = spawnSync(process.execPath, [COMPARE, 'otra-cosa'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /snapshot[\s\S]*diff/);
});

// ══ story 8.18 (tramo 2) — el mismo árbol desde el repo unido: `trees` y `exclusions` ═══════════════════════════════════
// El arnés y agent-skills pasaron a ser un repo. La vara del tramo (AC 20) es binaria: la copia `--single-repo` que arma
// el exportador desde el repo unido tiene el MISMO árbol que la que armaba desde los dos repos, carpeta de primer nivel
// por carpeta de primer nivel, con una sola diferencia declarada —el `.gitignore` pierde el bloque `.advisors/` de
// agent-skills—. Y sobre la rama junta (AC 21), lo que difiere son sólo archivos que la story tocó a propósito.
// Acá se arma todo de juguete, con git de verdad en carpetas temporales (entorno limpio, sin la configuración de la
// máquina); la medición sobre los commits reales va aparte.
const EXPORT = path.join(RAIZ, 'scripts', 'publishing', 'export.js');
const { sinGitDelPadre } = require(path.join(RAIZ, 'scripts', 'lib', 'clean-git-env.js'));
const labHome = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-home-'));
created.push(labHome);
let clock = 1700000000;
function labEnv(extra = {}) {
  clock += 100;
  const date = `@${clock} +0000`;
  return sinGitDelPadre({
    HOME: labHome, XDG_CONFIG_HOME: path.join(labHome, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.invalid', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.invalid',
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, ...extra,
  });
}
function gitLab(dir, args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env: labEnv() });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} (${dir}): ${r.stderr}`);
  return r.stdout.trim();
}
/** Escribe archivos (`null` borra; `{ text, exec }` pone el bit de ejecución) y commitea todo. Devuelve el sha. */
function commitLab(dir, files, message) {
  for (const [rel, v] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (v === null) { fs.rmSync(abs, { force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof v === 'string' ? v : v.text);
    fs.chmodSync(abs, typeof v === 'string' || !v.exec ? 0o644 : 0o755);
  }
  gitLab(dir, ['add', '-A']);
  gitLab(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return gitLab(dir, ['rev-parse', 'HEAD']);
}
function newRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  gitLab(dir, ['init', '-q', '-b', 'main']);
  return dir;
}
/** Una copia hecha a mano: un repo con un commit. */
function handCopy(files) {
  const dir = newRepo('export-compare-copia-');
  commitLab(dir, files, 'copia de laboratorio');
  return dir;
}
/** Una copia igual a otra con unos archivos cambiados (la «de después» alterada de las pruebas que tienen que dar rojo). */
function alteredCopy(copy, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-alterada-'));
  created.push(dir);
  const r = spawnSync('git', ['clone', '-q', copy, path.join(dir, 'copia')], { encoding: 'utf8', env: labEnv() });
  assert.strictEqual(r.status, 0, r.stderr);
  commitLab(path.join(dir, 'copia'), files, 'alterada');
  return path.join(dir, 'copia');
}
function trees(before, after, extra = []) {
  const run = (json) => spawnSync(process.execPath, [COMPARE, 'trees', before, after, ...extra, ...(json ? ['--json'] : [])], { encoding: 'utf8', env: labEnv() });
  const r = run(true);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  const h = run(false);
  return { code: r.status, json, out: r.stdout || '', err: r.stderr || '', human: `${h.stdout || ''}${h.stderr || ''}`, humanCode: h.status };
}

// ── el laboratorio del exportador: los dos repos de juguete, y su unión con los mismos pasos que la de verdad ──────────
const ADVISORS_BLOCK = ['# Artefactos de las corridas (acá no se versionan).', '# Segunda línea del comentario.', '.advisors/'];
const IGNORE_HARNESS = 'node_modules/\n*.log\n\n# evidencia de las corridas\n.advisors/tmp/\n!.advisors/dod-runtime/\n';
const IGNORE_SKILLS = `${ADVISORS_BLOCK.join('\n')}\n\n# bytecode\n__pycache__/\nnode_modules/\n`;
const linesOf = (t) => t.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === ''));
const LAB_LIST = {
  packages: {
    core: {
      arnes: { in: ['README.md', '.gitignore', '.githooks/**', 'scripts/**', 'guides/**', 'commands/**'], out: [{ glob: 'guides/bizuit/*.md', reason: 'va al paquete bizuit' }, { glob: '.tycon/**', reason: 'la configuración del equipo' }] },
      'agent-skills': {
        in: ['.gitignore', '.githooks/**', 'agents/*.md', 'skills/tycon-*/**'],
        out: [{ glob: 'README.md', reason: 'la documentación interna del repo' }, { glob: '.tycon/**', reason: 'la configuración del equipo' }, { glob: 'packs/**', reason: 'cada manifiesto viaja con su paquete' }],
      },
    },
    bizuit: {
      arnes: { in: ['guides/bizuit/bizuit-plugin.md'], out: [] },
      'agent-skills': { in: ['packs/bizuit/pack.json', 'agents/tycon-plugin-dotnet-conventions.md'], out: [] },
    },
  },
  suitesOutside: [], casesOutside: [], empty: {}, synthetic: [],
};
const agent = (name) => `---\nname: ${name}\ndescription: Revisor de laboratorio ${name}\nmodel: sonnet\ntools: Read\n---\n\nRevisa.\n`;

let unionLab = null;
/** Se arma una vez: los dos repos antes de los choques, exportados como hoy; la unión; y el repo unido, exportado. */
function exporterLab() {
  if (unionLab) return unionLab;
  const ex = require(EXPORT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-union-'));
  created.push(dir);
  const harness = path.join(dir, 'arnes');
  const skills = path.join(dir, 'agent-skills');
  for (const d of [harness, skills, path.join(dir, 'cfg'), path.join(dir, 'out')]) fs.mkdirSync(d, { recursive: true });
  gitLab(harness, ['init', '-q', '-b', 'main']);
  gitLab(skills, ['init', '-q', '-b', 'main']);
  const cfg = { list: path.join(dir, 'cfg', 'allowlist.json'), table: path.join(dir, 'cfg', 'replacements.json'), denied: path.join(dir, 'cfg', 'denylist.json'), names: path.join(dir, 'cfg', 'public-repos.json') };
  fs.writeFileSync(cfg.list, JSON.stringify(LAB_LIST, null, 2));
  fs.writeFileSync(cfg.table, JSON.stringify({ pares: [], afuera: [] }));
  fs.writeFileSync(cfg.denied, JSON.stringify({ terminos: [{ patron: 'AcmeCorp', categoria: 'cliente', palabra: true }], emailsPermitidos: ['arnes@tycon.com.ar'] }));
  fs.writeFileSync(cfg.names, JSON.stringify({ org: 'example-org', repo: 'example-harness' }));

  // cada exclusión fija del exportador con un archivo que la cubre (si no, «exclusión fija sin archivo»: 2)
  const sample = (glob) => glob.replace(/^\*\*\//, '').replace(/\/\*\*$/, '/muestra.txt').replace(/[*?]/g, 'x');
  const samples = (source) => Object.fromEntries(ex.EXCLUIDOS_SIEMPRE.filter((x) => x.fuente === source && !x.clase).map((x) => [sample(x.glob), 'muestra de una exclusión fija\n']));
  const harnessSide = commitLab(harness, {
    ...samples('arnes'),
    'scripts/ci/product-parity.json': '{ "grupos": {} }\n',
    'README.md': '# Arnés de laboratorio\n', '.gitignore': IGNORE_HARNESS, '.githooks/pre-commit': { text: '#!/usr/bin/env bash\n# el del arnés\nexit 0\n', exec: true },
    '.tycon/advisors.yaml': 'packs: []\n', 'scripts/hola.js': "'use strict';\nmodule.exports = 1;\n",
    'scripts/publishing/allowlist.json': `${JSON.stringify(LAB_LIST, null, 2)}\n`,
    'guides/guia.md': '# Guía\n', 'guides/bizuit/bizuit-plugin.md': '# Plugins\n', 'specs/story.md': '# Una story\n',
  }, 'el lado del arnés, antes de los choques');
  const skillsSide = commitLab(skills, {
    ...samples('agent-skills'),
    '.gitignore': IGNORE_SKILLS, 'README.md': '# agent-skills de laboratorio\n', '.githooks/pre-commit': { text: '#!/usr/bin/env bash\n# el de agent-skills\nexit 0\n', exec: true },
    '.tycon/post-commit-ignore': 'skills/ajena\n', 'skills/tycon-pipeline/SKILL.md': '---\nname: tycon-pipeline\n---\n\nOrquesta.\n',
    'agents/revisor-nucleo.md': agent('revisor-nucleo'), 'agents/tycon-plugin-dotnet-conventions.md': agent('tycon-plugin-dotnet-conventions'),
    'packs/bizuit/pack.json': `${JSON.stringify({ name: 'bizuit', reviewers: [{ agent: 'tycon-plugin-dotnet-conventions', group: 'base' }] }, null, 2)}\n`,
  }, 'el lado de agent-skills, antes de los choques');

  const run = (name, pkg, args, env) => {
    const out = path.join(dir, 'out', name);
    const r = spawnSync(process.execPath, [EXPORT, '--allowlist', cfg.list, '--replacements', cfg.table, '--denied', cfg.denied, '--public-repos', cfg.names,
      '--package', pkg, '--single-repo', '--output', out, '--report', path.join(dir, 'out', `${name}.reemplazos.md`), '--json', ...args],
    { cwd: dir, encoding: 'utf8', env: labEnv({ TYCON_GUIDES_DIR: harness, ...env }) });
    assert.strictEqual(r.status, 0, `la exportación ${name} salió ${r.status}: ${r.stderr}\n${String(r.stdout).slice(0, 600)}`);
    return out;
  };
  // «el de antes»: dos repos físicos, cada uno en su commit de antes de los choques
  const twoRepos = ['--harness', harnessSide, '--agent-skills', skillsSide];
  const before = { core: run('antes-core', 'core', twoRepos, { TYCON_SKILLS_DIR: skills }), 'core,bizuit': run('antes-union', 'core,bizuit', twoRepos, { TYCON_SKILLS_DIR: skills }) };

  // la unión, con los pasos de la de verdad: los tres choques resueltos de cada lado, y un merge de las dos historias
  const own = linesOf(IGNORE_HARNESS);
  const joinedIgnore = `${[...new Set([...own, ...linesOf(IGNORE_SKILLS).filter((l) => !ADVISORS_BLOCK.includes(l) && !own.includes(l))])].join('\n')}\n`;
  gitLab(harness, ['mv', '.githooks/pre-commit', '.githooks/pre-commit-harness']);
  commitLab(harness, { '.githooks/pre-commit': { text: ex.PRE_COMMIT_DISPATCHER, exec: true }, '.gitignore': joinedIgnore }, 'los tres choques, del lado del arnés');
  gitLab(skills, ['mv', '.githooks/pre-commit', '.githooks/pre-commit-skills']);
  const skillsResolved = commitLab(skills, { '.gitignore': null, 'README.md': null }, 'los tres choques, del lado de agent-skills');
  gitLab(harness, ['fetch', '-q', skills, 'main']);
  gitLab(harness, ['merge', '-q', '--allow-unrelated-histories', '--no-edit', '-m', 'la unión', skillsResolved]);
  const union = gitLab(harness, ['rev-parse', 'HEAD']);
  // «el nuevo»: una fuente física, sin ningún otro clon a la vista
  const alone = { TYCON_SKILLS_DIR: path.join(dir, 'no-hay-otro-clon') };
  const after = { core: run('despues-core', 'core', ['--harness', union], alone), 'core,bizuit': run('despues-union', 'core,bizuit', ['--harness', union], alone) };
  unionLab = { dir, harness, skills, cfg, union, before, after, run, alone, harnessSide, skillsSide };
  return unionLab;
}

/**
 * El exportador REAL, envuelto para que `snapshot` lo corra con las listas de juguete del laboratorio: `snapshot` no
 * pasa `--allowlist` ni las otras tres, y lee la lista blanca de al lado del exportador. Las bibliotecas de al lado
 * (new-names.js, skills-dir.js, legacy-names.js) son las reales.
 */
let wrapped = null;
function wrappedExporter(lab) {
  if (wrapped) return wrapped;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-envuelto-'));
  created.push(root);
  const pub = path.join(root, 'scripts', 'publishing');
  const lib = path.join(root, 'scripts', 'lib');
  fs.mkdirSync(pub, { recursive: true });
  fs.mkdirSync(lib, { recursive: true });
  const toy = ['--allowlist', lab.cfg.list, '--replacements', lab.cfg.table, '--denied', lab.cfg.denied, '--public-repos', lab.cfg.names];
  fs.writeFileSync(path.join(pub, 'export.js'), `'use strict';
const { spawnSync } = require('child_process');
module.exports = require(${JSON.stringify(EXPORT)});
if (require.main === module) {
  const r = spawnSync(process.execPath, [${JSON.stringify(EXPORT)}, ...${JSON.stringify(toy)}, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status === null ? 2 : r.status);
}
`);
  fs.copyFileSync(lab.cfg.list, path.join(pub, 'allowlist.json'));
  fs.writeFileSync(path.join(pub, 'new-names.js'), `module.exports = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'publishing', 'new-names.js'))});\n`);
  for (const m of ['skills-dir.js', 'legacy-names.js']) fs.writeFileSync(path.join(lib, m), `module.exports = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'lib', m))});\n`);
  wrapped = path.join(pub, 'export.js');
  return wrapped;
}
/** `snapshot` con el exportador real envuelto. `extra`: las opciones de ref; `env`: los repos. */
function realSnapshot(lab, extra, env) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-foto-real-')), 'foto');
  created.push(path.dirname(out));
  const r = spawnSync(process.execPath, [COMPARE, 'snapshot', '--out', out, '--exporter', wrappedExporter(lab), '--packages', 'core', ...extra],
    { cwd: lab.dir, encoding: 'utf8', env: labEnv(env) });
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(out, 'snapshot.json'), 'utf8')); } catch { meta = null; }
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', dir: out, meta, files: () => JSON.parse(fs.readFileSync(path.join(out, 'files-core.json'), 'utf8')) };
}

// ── T20 · story 8.18, AC 20 ────────────────────────────────────────────────────────────────────────────────────────────
test('Export_SameTreeAsTwoRepos_PerPackage_OneDeclaredDiff', () => {
  // 🔴 rojo previo: «falta el subcomando» (export-compare.js no conocía `trees`) y el exportador buscaba otro clon
  const lab = exporterLab();
  for (const pkg of ['core', 'core,bizuit']) {
    const r = trees(lab.before[pkg], lab.after[pkg]);
    assert.strictEqual(r.code, 0, `[${pkg}] el mismo árbol salvo lo declarado\n${r.err}\n${r.out}`);
    assert.strictEqual(r.json.result, 0);
    assert.deepStrictEqual(r.json.findings, [], `[${pkg}]`);
    assert.deepStrictEqual(r.json.firstLevel.filter((x) => !x.same).map((x) => x.entry), ['.gitignore'], `[${pkg}] la única entrada de primer nivel que difiere`);
    assert.ok(r.json.firstLevel.some((x) => x.entry === 'skills' && x.same && x.type === 'tree' && /^[0-9a-f]{40}$/.test(x.before)), `[${pkg}] cada carpeta, con su identificador`);
    assert.deepStrictEqual(r.json.declared.map((x) => x.path), ['.gitignore'], `[${pkg}] UNA diferencia declarada`);
    assert.deepStrictEqual(r.json.declared[0].lines, ADVISORS_BLOCK, `[${pkg}] exactamente el bloque: la línea y su comentario`);
    assert.notStrictEqual(r.json.trees.before, r.json.trees.after, 'control: con el .gitignore distinto, el árbol entero es otro');
    assert.strictEqual(r.humanCode, 0, 'el modo legible da el mismo código');
    assert.match(r.human, /\.gitignore/);
    assert.match(r.human, /\.advisors\//);
  }
  assert.ok(fs.existsSync(path.join(lab.after['core,bizuit'], 'packs', 'bizuit', 'pack.json')) && !fs.existsSync(path.join(lab.after.core, 'packs')), 'control: los dos paquetes no son la misma copia');

  // el espejo, lo sano: una copia contra sí misma es el mismo árbol, sin nada que declarar
  const same = trees(lab.after.core, lab.after.core);
  assert.strictEqual(same.code, 0, `${same.err}\n${same.out}`);
  assert.deepStrictEqual([same.json.declared, same.json.findings], [[], []]);
  assert.strictEqual(same.json.trees.before, same.json.trees.after);

  // lo que NO pasa — el .gitignore pierde una línea MÁS que el bloque: 1
  let r = trees(lab.before.core, alteredCopy(lab.after.core, { '.gitignore': fs.readFileSync(path.join(lab.after.core, '.gitignore'), 'utf8').replace('__pycache__/\n', '') }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.kind} ${f.path}`), ['ignore-block .gitignore']);
  assert.match(r.json.findings[0].message, /__pycache__\//, 'dice qué línea sobra o falta');
  // … o conserva el bloque y cambia otra cosa
  r = trees(lab.before.core, alteredCopy(lab.before.core, { '.gitignore': `${fs.readFileSync(path.join(lab.before.core, '.gitignore'), 'utf8')}otra-linea/\n` }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.kind} ${f.path}`), ['ignore-block .gitignore']);
  // … un archivo de otra carpeta con otro contenido: 1 nombrándolo, y su carpeta de primer nivel difiere
  r = trees(lab.before.core, alteredCopy(lab.after.core, { 'scripts/hola.js': "'use strict';\nmodule.exports = 2;\n" }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.kind} ${f.path}`), ['unexplained scripts/hola.js']);
  assert.deepStrictEqual(r.json.firstLevel.filter((x) => !x.same).map((x) => x.entry), ['.gitignore', 'scripts']);
  assert.strictEqual(r.humanCode, 1);
  assert.match(r.human, /scripts\/hola\.js/);
  // … uno que aparece, uno que desaparece y uno que pierde el bit de ejecución
  r = trees(lab.before.core, alteredCopy(lab.after.core, { 'guides/nueva.md': '# nueva\n', 'README.md': null, '.githooks/pre-commit-skills': '#!/usr/bin/env bash\n# el de agent-skills\nexit 0\n' }));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.kind} ${f.path}`).sort(), ['unexplained .githooks/pre-commit-skills', 'unexplained README.md', 'unexplained guides/nueva.md']);
  assert.match(r.json.findings.find((f) => f.path === '.githooks/pre-commit-skills').message, /100755[\s\S]*100644/, 'el modo también es parte del árbol');

  // «no pude comparar» nunca es 0
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-vacia-'));
  created.push(notARepo);
  r = trees(lab.before.core, notARepo);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.strictEqual(r.json.result, 2);
  r = trees(lab.before.core, path.join(notARepo, 'no-existe'));
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  const one = spawnSync(process.execPath, [COMPARE, 'trees', lab.before.core], { encoding: 'utf8' });
  assert.strictEqual(one.status, 2, 'con una sola copia no hay qué comparar');
});

// ── T22 · story 8.18, AC 21 ────────────────────────────────────────────────────────────────────────────────────────────
test('Export_JoinedBranch_DiffOnlyTouchedFiles', () => {
  const lab = exporterLab();
  // la rama junta de juguete: sobre la unión, la story toca un guion que sale, una guía y algo que no viaja
  const clone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-junta-')), 'unido');
  created.push(path.dirname(clone));
  const c = spawnSync('git', ['clone', '-q', lab.harness, clone], { encoding: 'utf8', env: labEnv() });
  assert.strictEqual(c.status, 0, c.stderr);
  // (la story borra una guía y agrega otra: si `guides/` quedara sin nada que salga, el exportador la sumaría al
  // .gitignore de la copia —story 8.26, AC 30— y el .gitignore tendría una diferencia más que la declarada. Esa cuenta,
  // la de una carpeta que deja de publicar, no es de esta prueba: la mide la del exportador)
  const tip = commitLab(clone, {
    'scripts/hola.js': "'use strict';\nmodule.exports = 'la story lo tocó';\n", 'scripts/nuevo.js': "'use strict';\n",
    'guides/guia.md': null, 'guides/otra-guia.md': '# Otra guía\n\nLa que queda.\n', 'specs/story.md': '# Una story, retocada\n',
  }, 'lo que la story tocó a propósito');
  const joined = lab.run('junta-core', 'core', ['--harness', tip], { ...lab.alone, TYCON_GUIDES_DIR: clone });
  const range = ['--range', `${lab.union}..${tip}`, '--repo', clone, '--allowlist', lab.cfg.list];

  // lo que difiere del árbol de antes es sólo lo tocado (y el .gitignore declarado): 0, con la lista explicada
  let r = trees(lab.before.core, joined, range);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.explained.map((x) => x.path).sort(), ['guides/guia.md', 'guides/otra-guia.md', 'scripts/hola.js', 'scripts/nuevo.js'], 'cada archivo distinto, explicado por un archivo tocado');
  assert.deepStrictEqual(r.json.declared.map((x) => x.path), ['.gitignore']);
  assert.strictEqual(r.json.touched, 5, 'los cinco archivos del rango (uno no viaja)');
  assert.match(r.human, /scripts\/hola\.js/);
  // sin decir qué se tocó, las mismas diferencias son hallazgos: la vara del AC 20 no las admite
  r = trees(lab.before.core, joined);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((f) => f.path).sort(), ['guides/guia.md', 'guides/otra-guia.md', 'scripts/hola.js', 'scripts/nuevo.js']);

  // un archivo intruso —distinto, y la story no lo tocó—: 1 nombrándolo
  const intruder = alteredCopy(joined, { 'README.md': '# Arnés de laboratorio\n\nAlguien más lo cambió.\n' });
  r = trees(lab.before.core, intruder, range);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.kind} ${f.path}`), ['unexplained README.md']);
  assert.match(r.json.findings[0].message, /README\.md/);
  assert.match(r.json.findings[0].message, /no lo tocó|no está entre/);
  assert.strictEqual(r.humanCode, 1);
  assert.match(r.human, /README\.md/);

  // la lista de lo tocado también se puede dar hecha (una ruta por línea)
  const list = path.join(path.dirname(clone), 'tocados.txt');
  fs.writeFileSync(list, 'scripts/hola.js\nscripts/nuevo.js\nguides/guia.md\nguides/otra-guia.md\n\nspecs/story.md\n');
  r = trees(lab.before.core, joined, ['--touched', list, '--allowlist', lab.cfg.list]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  fs.writeFileSync(list, 'scripts/hola.js\nscripts/nuevo.js\nguides/otra-guia.md\n');
  r = trees(lab.before.core, joined, ['--touched', list, '--allowlist', lab.cfg.list]);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((f) => f.path), ['guides/guia.md']);

  // «no pude mirar» nunca es 0: un rango que git no conoce, una lista que no está, un rango sin forma
  for (const [what, extra, said] of [
    ['un commit que no existe', ['--range', `${lab.union}..no-existe`, '--repo', clone], /no-existe/],
    ['una lista que no está', ['--touched', path.join(path.dirname(clone), 'no-esta.txt')], /no-esta\.txt/],
    ['un rango sin forma', ['--range', 'HEAD', '--repo', clone], /--range/],
    ['un repo que no es un repo', ['--range', `${lab.union}..${tip}`, '--repo', path.dirname(clone)], /--repo|git/],
  ]) {
    const bad = trees(lab.before.core, joined, [...extra, '--allowlist', lab.cfg.list]);
    assert.strictEqual(bad.code, 2, `${what}: 2\n${bad.err}\n${bad.out}`);
    assert.match(bad.err, said, what);
  }
});

test('Export_JoinedBranch_DiffOnlyTouchedFiles — la imagen por el exportador: una skill renombrada, un papel, una traducción a Codex', () => {
  // lo que la story toca en el interno sale en la copia con OTRA ruta en tres casos: lo dice la lista blanca (y el exportador)
  const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-imagen-')), 'allowlist.json');
  created.push(path.dirname(list));
  // lo tocado sale (un «in» de su fuente): sólo lo que el exportador publica explica algo en la copia (clase 9 del pase
  // adversarial del tramo 2); la tabla privada de juguete va al lado de la lista
  fs.writeFileSync(path.join(path.dirname(list), 'replacements.json'), JSON.stringify({ pares: [], afuera: [] }));
  fs.writeFileSync(list, JSON.stringify({
    packages: { core: { arnes: { in: ['scripts/**'], out: [] }, 'agent-skills': { in: ['agents/*.md', 'skills/**'], out: [] } } },
    skillRenames: [{ source: 'agent-skills', from: 'skills/tycon-create-story', to: 'skills/tycon-create-story', why: 'x', reason: 'x' }],
    synthetic: [{ target: 'NOTICE', from: 'scripts/publishing/public-files/NOTICE', reason: 'x', packages: ['core'] }],
  }));
  const before = handCopy({
    'skills/tycon-create-story/SKILL.md': 'antes\n', NOTICE: 'antes\n', 'adapters/codex/agents/revisor.toml': 'antes\n',
    'adapters/codex/agents-native/revisor.toml': 'antes\n', 'agents/revisor.md': 'antes\n', 'scripts/otro.js': 'igual\n',
  });
  const after = alteredCopy(before, {
    'skills/tycon-create-story/SKILL.md': 'después\n', NOTICE: 'después\n', 'adapters/codex/agents/revisor.toml': 'después\n',
    'adapters/codex/agents-native/revisor.toml': 'después\n', 'agents/revisor.md': 'después\n',
  });
  const touched = path.join(path.dirname(list), 'tocados.txt');
  fs.writeFileSync(touched, 'skills/tycon-create-story/SKILL.md\nscripts/publishing/public-files/NOTICE\nagents/revisor.md\n');
  let r = trees(before, after, ['--touched', touched, '--allowlist', list]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.explained.map((x) => `${x.path} <- ${x.by}`).sort(), [
    'NOTICE <- scripts/publishing/public-files/NOTICE',
    'adapters/codex/agents-native/revisor.toml <- agents/revisor.md',
    'adapters/codex/agents/revisor.toml <- agents/revisor.md',
    'agents/revisor.md <- agents/revisor.md',
    'skills/tycon-create-story/SKILL.md <- skills/tycon-create-story/SKILL.md',
  ]);
  // el espejo: sin el archivo interno tocado, su imagen en la copia es un intruso
  fs.writeFileSync(touched, 'agents/revisor.md\n');
  r = trees(before, after, ['--touched', touched, '--allowlist', list]);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((f) => f.path).sort(), ['NOTICE', 'skills/tycon-create-story/SKILL.md']);
  // una lista blanca que no se deja leer es «no pude mirar»
  fs.writeFileSync(list, '{ "packages": ');
  r = trees(before, after, ['--touched', touched, '--allowlist', list]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
});

// ── story 8.18, pase adversarial del tramo 2 (clase 9): sólo explica lo que el exportador publica ─────────────────────
// La imagen de un archivo tocado era su misma ruta, se publicara o no: un archivo PRIVADO que la story tocó y que aparece
// en la copia pasaba como «tocado a propósito» —justo la fuga que la medición del AC 21 tiene que ver—, y lo mismo el
// destino de un papel cuyo homónimo privado se tocó (en el repo real, guides/incident-log.md).
test('Export_TreesTouched_OnlyWhatShipsExplains — un archivo tocado que el exportador no publica no explica su aparición en la copia', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-publica-'));
  created.push(dir);
  const list = path.join(dir, 'allowlist.json');
  // la tabla privada de juguete, al lado de la lista blanca (de ahí sale el «afuera» privado)
  fs.writeFileSync(path.join(dir, 'replacements.json'), JSON.stringify({ pares: [], afuera: [{ glob: 'arnes/guides/privada.md', motivo: 'de juguete' }] }));
  fs.writeFileSync(list, JSON.stringify({
    packages: { core: {
      arnes: { in: ['README.md', 'specs/**', 'guides/**', 'scripts/**'], out: [{ glob: 'guides/fuera.md', reason: 'la lista la deja afuera' }] },
      'agent-skills': { in: ['skills/**', 'agents/*.md'], out: [] },
    } },
    skillRenames: [],
    synthetic: [{ target: 'guides/incident-log.md', from: 'scripts/publishing/public-files/guides/incident-log.md', reason: 'x', packages: ['core'] }],
  }));
  const before = handCopy({ 'README.md': 'hola\n', 'guides/incident-log.md': 'el papel público\n', 'guides/guia.md': 'antes\n' });
  const after = alteredCopy(before, {
    'specs/story.md': '# privada\n',                          // exclusión fija
    'skills/projects/cliente/SKILL.md': '# de un cliente\n',  // exclusión fija, del lado de agent-skills
    'guides/fuera.md': 'la lista lo deja afuera\n',            // «out» de todos los paquetes que lo toman
    'guides/privada.md': 'afuera privado\n',                   // el «lista de excluidos» de la tabla privada
    'guides/incident-log.md': 'EL PRIVADO, con nombres\n',     // el destino de un papel, por su homónimo privado
    'guides/guia.md': 'después\n',                             // lo sano: sale, y la story lo tocó
  });
  const touched = path.join(dir, 'tocados.txt');
  const privateOnes = ['guides/fuera.md', 'guides/incident-log.md', 'guides/privada.md', 'skills/projects/cliente/SKILL.md', 'specs/story.md'];
  fs.writeFileSync(touched, `${[...privateOnes, 'guides/guia.md'].join('\n')}\n`);

  // 🔴 rojo previo: sale 0, «salvo 6 archivo(s) que la story tocó»
  let r = trees(before, after, ['--touched', touched, '--allowlist', list]);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.kind} ${f.path}`).sort(), privateOnes.map((p) => `unexplained ${p}`));
  assert.match(r.json.findings.find((f) => f.path === 'specs/story.md').message, /no lo publica/, 'dice por qué no lo explica');
  assert.deepStrictEqual(r.json.explained.map((x) => x.path), ['guides/guia.md'], 'el espejo: lo que sale y se tocó sigue explicado');

  // el espejo del papel: tocar su «from» explica su destino
  fs.writeFileSync(touched, 'scripts/publishing/public-files/guides/incident-log.md\n');
  r = trees(before, alteredCopy(before, { 'guides/incident-log.md': 'el papel público, retocado\n' }), ['--touched', touched, '--allowlist', list]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.explained.map((x) => `${x.path} <- ${x.by}`), ['guides/incident-log.md <- scripts/publishing/public-files/guides/incident-log.md']);

  // sin la tabla privada al lado de la lista no se sabe qué deja afuera: «no pude mirar»
  fs.rmSync(path.join(dir, 'replacements.json'));
  r = trees(before, after, ['--touched', touched, '--allowlist', list]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /replacements\.json/);
});

// ── story 8.18, AC 19 · la foto (`snapshot`) del repo unido: una fuente física, partida por ruta ───────────────────────
// La foto arma «lo excluido» mirando el árbol de cada fuente. Desde el repo unido no hay otro clon que mirar: el árbol de
// cada fuente lógica es su mitad del commit del arnés. Sin eso la foto buscaba agent-skills en otro lado (y si lo
// encontraba, en otro commit) y contaba como excluido de una fuente lo que es de la otra.
test('Export_OnePhysicalSource_SplitByPath_TwoReposStillWork — snapshot: lo excluido de cada fuente lógica sale de su mitad del mismo commit', () => {
  // un exportador de laboratorio: dice de cuántas fuentes físicas leyó y deja la copia de dos repos con lo que «sale»
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-lab-unido-'));
  created.push(root);
  const pub = path.join(root, 'scripts', 'publishing');
  fs.mkdirSync(pub, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'export.js'), `'use strict';
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
module.exports = { coincide: (glob, file) => (glob.endsWith('/**') ? file.startsWith(glob.slice(0, -2)) : glob === file) };
if (require.main === module) {
  const args = process.argv.slice(2);
  const sha = process.env.LAB_SHA;
  if (args.includes('--explain')) {
    process.stdout.write(JSON.stringify({ fuentes: { arnes: { sha } }, sinClasificar: [], exclusionesSinArchivo: [] }));
  } else {
    const out = args[args.indexOf('--output') + 1];
    const ships = { arnes: { 'README.md': 'sale\\n' }, 'agent-skills': { 'skills/una/SKILL.md': 'sale\\n' } };
    for (const [source, files] of Object.entries(ships)) {
      const dir = path.join(out, source);
      for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
      for (const g of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=lab', '-c', 'user.email=lab@example.invalid', 'commit', '-q', '-m', 'copia']]) {
        const r = spawnSync('git', ['-C', dir, ...g], { encoding: 'utf8' });
        if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(2); }
      }
    }
    const fuentes = { arnes: { sha }, 'agent-skills': { sha: process.env.LAB_SKILLS_SHA || sha } };
    process.stdout.write(JSON.stringify({ resultado: 0, paquete: 'core', salida: out, fuentes, physicalSources: Number(process.env.LAB_PHYSICAL), globsSinUso: [], entradasSinClasificar: [] }));
  }
}
`);
  fs.writeFileSync(path.join(pub, 'allowlist.json'), JSON.stringify({ packages: { core: {
    arnes: { in: ['README.md', '.gitignore', 'scripts/**', '.githooks/**', '.tycon/**'] }, 'agent-skills': { in: ['.gitignore', 'skills/**', '.githooks/**', '.tycon/**'] } } } }));
  // el `sourceOfPath` REAL, como en `wrappedExporter`: un doble a mano tenía otra regla (le faltaban los dos archivos
  // sueltos de agent-skills) y la prueba medía el doble, no la partición de verdad
  fs.writeFileSync(path.join(pub, 'new-names.js'), `module.exports = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'publishing', 'new-names.js'))});\n`);
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'skills-dir.js'), "module.exports = { resolveSkillsDirs: (v) => ({ repo: v || '/no-hay-otro-clon' }) };\n");
  const exporter = path.join(pub, 'export.js');
  const snap = (env) => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-foto-')), 'foto');
    created.push(path.dirname(out));
    const r = spawnSync(process.execPath, [COMPARE, 'snapshot', '--out', out, '--exporter', exporter, '--packages', 'core', '--harness', 'HEAD', '--agent-skills', 'HEAD'],
      { encoding: 'utf8', env: labEnv(env) });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', files: () => JSON.parse(fs.readFileSync(path.join(out, 'files-core.json'), 'utf8')) };
  };

  // el repo unido: todo en un commit
  const unified = newRepo('export-compare-unido-');
  // (los dos archivos sueltos de agent-skills —`.tycon/post-commit-ignore` y `.githooks/pre-commit-skills`— entran en el
  // commit: los parte el `sourceOfPath` REAL, no un doble con otra regla; revisión del tramo 2, vuelta 1)
  const sha = commitLab(unified, {
    'README.md': 'sale\n', '.gitignore': 'node_modules/\n', 'scripts/interno.js': '// no sale\n',
    'skills/una/SKILL.md': 'sale\n', 'skills/privada/SKILL.md': 'no sale\n',
    '.tycon/post-commit-ignore': 'skills/ajena\n', '.githooks/pre-commit-skills': '#!/usr/bin/env bash\nexit 0\n', '.githooks/pre-commit-harness': '#!/usr/bin/env bash\nexit 0\n',
  }, 'el repo unido');
  let r = snap({ LAB_SHA: sha, LAB_PHYSICAL: '1', TYCON_GUIDES_DIR: unified, TYCON_SKILLS_DIR: '' });
  assert.strictEqual(r.code, 0, `${r.out}\n${r.err}`);
  let f = r.files();
  assert.deepStrictEqual(Object.keys(f.shipped.arnes), ['README.md']);
  assert.deepStrictEqual(Object.keys(f.shipped['agent-skills']), ['skills/una/SKILL.md']);
  assert.deepStrictEqual(Object.keys(f.excluded.arnes).sort(), ['.githooks/pre-commit-harness', '.gitignore', 'scripts/interno.js'], 'lo excluido del arnés: su mitad, sin las skills ni los dos archivos sueltos de agent-skills');
  assert.deepStrictEqual(Object.keys(f.excluded['agent-skills']).sort(), ['.githooks/pre-commit-skills', '.tycon/post-commit-ignore', 'skills/privada/SKILL.md'],
    'lo excluido de agent-skills: su mitad, con sus dos archivos sueltos — el .gitignore es del arnés, por ruta');

  // el espejo: con dos repos físicos, como siempre — cada fuente con el árbol de SU repo
  const harness = newRepo('export-compare-arnes-');
  const harnessSha = commitLab(harness, { 'README.md': 'sale\n', '.gitignore': 'node_modules/\n', 'scripts/interno.js': '// no sale\n' }, 'el arnés');
  const skills = newRepo('export-compare-skills-');
  const skillsSha = commitLab(skills, { '.gitignore': '__pycache__/\n', 'skills/una/SKILL.md': 'sale\n', 'skills/privada/SKILL.md': 'no sale\n' }, 'agent-skills');
  r = snap({ LAB_SHA: harnessSha, LAB_SKILLS_SHA: skillsSha, LAB_PHYSICAL: '2', TYCON_GUIDES_DIR: harness, TYCON_SKILLS_DIR: skills });
  assert.strictEqual(r.code, 0, `${r.out}\n${r.err}`);
  f = r.files();
  assert.deepStrictEqual(Object.keys(f.excluded.arnes).sort(), ['.gitignore', 'scripts/interno.js']);
  assert.deepStrictEqual(Object.keys(f.excluded['agent-skills']).sort(), ['.gitignore', 'skills/privada/SKILL.md'], 'con dos repos, el .gitignore de agent-skills es suyo');

  // una sola fuente física y nadie que diga cómo partirla: «no pude sacar la foto», nunca una foto a medias
  fs.rmSync(path.join(pub, 'new-names.js'));
  r = snap({ LAB_SHA: sha, LAB_PHYSICAL: '1', TYCON_GUIDES_DIR: unified, TYCON_SKILLS_DIR: '' });
  assert.strictEqual(r.code, 2, `${r.out}\n${r.err}`);
  assert.match(r.err, /sourceOfPath/);
});

// ── story 8.18, pase adversarial del tramo 2 (clase 1): la foto de una rama adelantada del repo unido ──────────────────
// `snapshot` le pasaba SIEMPRE `--agent-skills origin/main` al exportador. En el repo unido las dos fuentes salen del
// mismo commit: con un `--harness` que no fuera origin/main el exportador salía 2, la foto quedaba con todas sus
// exportaciones rotas, `snapshot` salía 0 igual y el mensaje mandaba a «sacar --agent-skills», que nadie había pasado.
test('Export_Snapshot_UnifiedBranch_SkillsFollowHarness — sin --agent-skills la foto sigue al arnés, y una foto con la exportación rota no sale 0', () => {
  const lab = exporterLab();
  // una rama adelantada un commit del main del repo unido (el clon trae origin/main = la unión)
  const clone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-adelantada-')), 'unido');
  created.push(path.dirname(clone));
  const c = spawnSync('git', ['clone', '-q', lab.harness, clone], { encoding: 'utf8', env: labEnv() });
  assert.strictEqual(c.status, 0, c.stderr);
  const tip = commitLab(clone, { 'guides/guia.md': '# Guía\n\nOtra versión, en una rama adelantada.\n' }, 'un commit adelante de origin/main');
  const env = { TYCON_GUIDES_DIR: clone, ...lab.alone };

  // 🔴 rojo previo: sale 0 con «ojo: --explain salió 2 · la exportación de core salió 2 … sacá --agent-skills»
  let r = realSnapshot(lab, ['--harness', tip], env);
  assert.strictEqual(r.code, 0, `${r.out}\n${r.err}`);
  assert.deepStrictEqual([r.meta.explain.exit, r.meta.exports.core.exit], [0, 0], `${r.out}\n${r.err}`);
  assert.doesNotMatch(`${r.out}${r.err}`, /salió 2|sacá --agent-skills/);
  const exported = JSON.parse(fs.readFileSync(path.join(r.dir, 'export-core.json'), 'utf8'));
  assert.deepStrictEqual([exported.fuentes.arnes.sha, exported.fuentes['agent-skills'].sha], [tip, tip], 'las dos fuentes, del commit pedido');
  assert.ok(fs.existsSync(path.join(r.dir, 'files-core.json')));

  // el espejo: sin ninguna opción (origin/main para el arnés), y con las dos en el mismo commit
  r = realSnapshot(lab, [], env);
  assert.deepStrictEqual([r.code, r.meta.explain.exit, r.meta.exports.core.exit], [0, 0, 0], `${r.out}\n${r.err}`);
  r = realSnapshot(lab, ['--harness', tip, '--agent-skills', tip], env);
  assert.deepStrictEqual([r.code, r.meta.explain.exit, r.meta.exports.core.exit], [0, 0, 0], `${r.out}\n${r.err}`);

  // lo que NO pasa: una foto con la exportación rota sale 2 (queda escrita, para mirarla), nombrando la causa
  r = realSnapshot(lab, ['--harness', tip, '--agent-skills', lab.union], env);
  assert.strictEqual(r.code, 2, `una foto rota no es una foto: ${r.out}\n${r.err}`);
  assert.strictEqual(r.meta.exports.core.exit, 2);
  assert.match(`${r.out}${r.err}`, /no es el mismo commit/, 'dice la causa del exportador');

  // con dos repos, sin --agent-skills, sigue siendo el origin/main de agent-skills (lo de siempre)
  gitLab(lab.skills, ['update-ref', 'refs/remotes/origin/main', lab.skillsSide]);
  r = realSnapshot(lab, ['--harness', lab.harnessSide], { TYCON_GUIDES_DIR: lab.harness, TYCON_SKILLS_DIR: lab.skills });
  assert.deepStrictEqual([r.code, r.meta.explain.exit, r.meta.exports.core.exit], [0, 0, 0], `${r.out}\n${r.err}`);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'export-core.json'), 'utf8')).fuentes['agent-skills'].sha, lab.skillsSide);
});

// ── story 8.18, pase adversarial del tramo 2 (clase 11): las dos partes del pre-commit salen ───────────────────────────
// En el repo unido el pre-commit viene partido (`pre-commit-harness`, `pre-commit-skills`) y la copia de dos repos las
// devuelve a `.githooks/pre-commit` de cada fuente (split-hooks). La foto las anotaba como «excluidas» —están en el árbol,
// las cubre un «in» y su ruta no sale—: un `diff` entre una foto de antes de la unión y una del repo unido daba dos
// hallazgos falsos («es nuevo y queda excluido»).
test('Export_Snapshot_AcrossUnion_HookPartsShip — la foto del repo unido no anota como excluidas las partes del pre-commit', () => {
  const lab = exporterLab();
  const before = realSnapshot(lab, ['--harness', lab.harnessSide, '--agent-skills', lab.skillsSide], { TYCON_GUIDES_DIR: lab.harness, TYCON_SKILLS_DIR: lab.skills });
  assert.strictEqual(before.code, 0, `${before.out}\n${before.err}`);
  const afterEnv = { TYCON_GUIDES_DIR: lab.harness, ...lab.alone };
  const after = realSnapshot(lab, ['--harness', lab.union, '--agent-skills', lab.union], afterEnv);
  assert.strictEqual(after.code, 0, `${after.out}\n${after.err}`);
  const f = after.files();
  assert.ok(!('.githooks/pre-commit-harness' in f.excluded.arnes), 'pre-commit-harness sale (como .githooks/pre-commit del arnés)');
  assert.ok(!('.githooks/pre-commit-skills' in f.excluded['agent-skills']), 'pre-commit-skills sale (como .githooks/pre-commit de agent-skills)');
  assert.ok(f.shipped.arnes['.githooks/pre-commit'] && f.shipped['agent-skills']['.githooks/pre-commit'], 'cada copia trae su pre-commit');

  // 🔴 rojo previo: tres hallazgos — las dos partes «nuevas y excluidas» y el .gitignore declarado
  const r = diff(before.dir, after.dir);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((x) => `${x.kind} ${x.source} ${x.path}`), ['gone-shipped agent-skills .gitignore'], 'queda sólo la diferencia declarada de la unión');

  // el espejo: dos fotos del repo unido entre sí, 0
  const again = realSnapshot(lab, ['--harness', lab.union, '--agent-skills', lab.union], afterEnv);
  const same = diff(after.dir, again.dir);
  assert.strictEqual(same.code, 0, `${same.err}\n${same.out}`);
});

// ── T21 (la herramienta) · story 8.18, AC 20: `--explain --json` de antes y de después dan la misma lista de excluidos ──
test('Export_PrivateStaysOut_SameExclusions_NoDeadGlobs — exclusions: las dos salidas de --explain, comparadas', () => {
  const explainOf = (mutate = () => {}) => {
    const data = {
      fuentes: { arnes: { ref: 'HEAD', sha: 'a'.repeat(40) }, 'agent-skills': { ref: 'HEAD', sha: 'b'.repeat(40) } },
      primerNivel: [
        { fuente: 'arnes', entrada: '.gitignore', tipo: 'archivo', reglas: [{ tipo: 'entra', glob: '.gitignore', detalle: 'core' }] },
        { fuente: 'arnes', entrada: 'specs', tipo: 'carpeta', reglas: [{ tipo: 'fija', glob: 'specs/**', detalle: 'las stories' }] },
        { fuente: 'agent-skills', entrada: '.gitignore', tipo: 'archivo', reglas: [{ tipo: 'entra', glob: '.gitignore', detalle: 'core' }] },
        { fuente: 'agent-skills', entrada: 'README.md', tipo: 'archivo', reglas: [{ tipo: 'afuera', glob: 'README.md', detalle: 'interna' }] },
        { fuente: 'agent-skills', entrada: 'skills', tipo: 'carpeta', reglas: [{ tipo: 'entra', glob: 'skills/tycon-*/**', detalle: 'core' }, { tipo: 'fija', glob: 'skills/projects/**', detalle: 'clientes' }] },
      ],
      sinClasificar: [],
      exclusionesFijas: [{ fuente: 'arnes', glob: 'specs/**', motivo: 'las stories' }, { fuente: 'agent-skills', glob: 'skills/projects/**', motivo: 'clientes' }],
      coberturaExclusiones: [
        { origen: 'fija', fuente: 'arnes', glob: 'specs/**', relevante: false, archivos: 3, reemplazos: 0 },
        { origen: 'fija', fuente: 'agent-skills', glob: 'skills/projects/**', relevante: true, archivos: 36, reemplazos: 0 },
        { origen: 'afuera', paquete: 'core', fuente: 'agent-skills', glob: 'README.md', relevante: false, archivos: 1, reemplazos: 0 },
        { origen: 'afuera-privado', indice: 0, fuente: 'arnes', relevante: true, archivos: 2, reemplazos: 0 },
      ],
      exclusionesSinArchivo: [],
    };
    mutate(data);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-compare-explain-')), 'explain.json');
    created.push(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
  };
  const exclusions = (a, b) => {
    const r = spawnSync(process.execPath, [COMPARE, 'exclusions', a, b, '--json'], { encoding: 'utf8' });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { json = null; }
    const h = spawnSync(process.execPath, [COMPARE, 'exclusions', a, b], { encoding: 'utf8' });
    return { code: r.status, json, out: r.stdout || '', err: r.stderr || '', human: `${h.stdout || ''}${h.stderr || ''}`, humanCode: h.status };
  };
  // el repo unido: agent-skills ya no trae .gitignore ni README.md (la unión los dejó del lado del arnés)
  const unified = (d) => {
    d.fuentes['agent-skills'].sha = d.fuentes.arnes.sha;
    d.primerNivel = d.primerNivel.filter((x) => !(x.fuente === 'agent-skills' && ['.gitignore', 'README.md'].includes(x.entrada)));
    d.coberturaExclusiones.find((x) => x.glob === 'README.md').archivos = 0;
  };
  let r = exclusions(explainOf(), explainOf(unified));
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.declared.map((x) => x.what).sort(), ['coverage afuera core agent-skills README.md: 1 → 0', 'first-level agent-skills/.gitignore', 'first-level agent-skills/README.md']);
  assert.strictEqual(r.humanCode, 0);
  assert.match(r.human, /misma lista de excluidos/i);
  // las mismas dos salidas: 0, sin nada que declarar
  r = exclusions(explainOf(), explainOf());
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual([r.json.declared, r.json.findings], [[], []]);

  // lo que NO pasa, cada uno 1 y nombrado
  const cases = [
    ['una exclusión que cubre menos archivos (algo privado dejó de estar excluido)', (d) => { unified(d); d.coberturaExclusiones.find((x) => x.glob === 'skills/projects/**').archivos = 35; }, 'coverage', /skills\/projects\/\*\*[\s\S]*36[\s\S]*35/],
    ['un «afuera» privado que cubre otra cantidad, sin nombrar su glob', (d) => { unified(d); d.coberturaExclusiones.find((x) => x.origen === 'afuera-privado').archivos = 1; }, 'coverage', /afuera privado #0/],
    ['una exclusión fija menos', (d) => { unified(d); d.exclusionesFijas.pop(); }, 'fixed-exclusions', /skills\/projects\/\*\*/],
    ['una entrada de primer nivel sin clasificar', (d) => { unified(d); d.sinClasificar.push('arnes/carpeta-nueva'); }, 'unclassified', /arnes\/carpeta-nueva/],
    ['un glob muerto', (d) => { unified(d); d.exclusionesSinArchivo.push({ origen: 'fija', fuente: 'arnes', glob: 'specs/**', relevante: true, archivos: 0, reemplazos: 0 }); }, 'dead-glob', /specs\/\*\*/],
    ['una entrada de primer nivel que desaparece sin estar declarada', (d) => { unified(d); d.primerNivel = d.primerNivel.filter((x) => x.entrada !== 'specs'); }, 'first-level', /arnes\/specs/],
    ['una entrada que cambia de decisión (de fija a entra)', (d) => { unified(d); d.primerNivel.find((x) => x.entrada === 'specs').reglas = [{ tipo: 'entra', glob: 'specs/**', detalle: 'core' }]; }, 'first-level', /arnes\/specs/],
    ['una fila de cobertura nueva', (d) => { unified(d); d.coberturaExclusiones.push({ origen: 'afuera', paquete: 'core', fuente: 'arnes', glob: 'x/**', relevante: false, archivos: 1, reemplazos: 0 }); }, 'coverage', /x\/\*\*/],
  ];
  for (const [what, mutate, kind, said] of cases) {
    r = exclusions(explainOf(), explainOf(mutate));
    assert.strictEqual(r.code, 1, `${what}: 1\n${r.err}\n${r.out}`);
    assert.deepStrictEqual(r.json.findings.map((f) => f.kind), [kind], what);
    assert.match(r.json.findings[0].message, said, what);
  }
  // una salida rota o que falta es «no pude comparar»
  const broken = explainOf();
  fs.writeFileSync(broken, '{ "primerNivel": ');
  r = exclusions(explainOf(), broken);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  r = exclusions(explainOf(), path.join(path.dirname(broken), 'no-esta.json'));
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  r = exclusions(explainOf((d) => { delete d.coberturaExclusiones; }), explainOf());
  assert.strictEqual(r.code, 2, `una salida sin sus claves no es de --explain\n${r.err}\n${r.out}`);

  // El .gitattributes (2026-10-04): los dos repos lo traen IDÉNTICO desde la 8.17, después del commit de la unión. En el
  // repo unido es un archivo, del lado del arnés, como el README.md: la entrada de agent-skills deja de existir y su
  // la exclusión queda en 0. Medido con export-real T21 sobre main de los dos repos. Del lado del arnés, en cambio, sigue
  // siendo un hallazgo: sólo se declara lo que la unión le saca a agent-skills.
  const withAttributes = (d) => {
    d.primerNivel.push({ fuente: 'arnes', entrada: '.gitattributes', tipo: 'archivo', reglas: [{ tipo: 'entra', glob: '.gitattributes', detalle: 'core' }] });
    d.primerNivel.push({ fuente: 'agent-skills', entrada: '.gitattributes', tipo: 'archivo', reglas: [{ tipo: 'afuera', glob: '.gitattributes', detalle: 'va el del arnés' }] });
    d.coberturaExclusiones.push({ origen: 'afuera', paquete: 'core', fuente: 'agent-skills', glob: '.gitattributes', relevante: false, archivos: 1, reemplazos: 0 });
  };
  const unifiedWithAttributes = (d) => {
    withAttributes(d);
    unified(d);
    d.primerNivel = d.primerNivel.filter((x) => !(x.fuente === 'agent-skills' && x.entrada === '.gitattributes'));
    d.coberturaExclusiones.find((x) => x.glob === '.gitattributes').archivos = 0;
  };
  r = exclusions(explainOf(withAttributes), explainOf(unifiedWithAttributes));
  assert.strictEqual(r.code, 0, `el .gitattributes de los dos repos, unido: 0\n${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.declared.map((x) => x.what).sort(), ['coverage afuera core agent-skills .gitattributes: 1 → 0', 'coverage afuera core agent-skills README.md: 1 → 0',
    'first-level agent-skills/.gitattributes', 'first-level agent-skills/.gitignore', 'first-level agent-skills/README.md']);
  r = exclusions(explainOf(withAttributes), explainOf((d) => { unifiedWithAttributes(d); d.primerNivel = d.primerNivel.filter((x) => !(x.fuente === 'arnes' && x.entrada === '.gitattributes')); }));
  assert.strictEqual(r.code, 1, `el .gitattributes del arnés que desaparece no está declarado\n${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.findings.map((f) => f.kind), ['first-level']);
  assert.match(r.json.findings[0].message, /arnes\/\.gitattributes/);
});

test.after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});
