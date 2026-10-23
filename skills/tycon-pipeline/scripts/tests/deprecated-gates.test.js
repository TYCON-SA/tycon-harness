'use strict';

/**
 * deprecated-gates.test.js — lo que el código deprecado cambia en el pipeline: revisores, validador y freno de edición.
 *
 * Los revisores reciben marcados los archivos deprecados del diff; `mech-check` avisa (DEPR-W1) cuando una línea
 * agregada en un archivo vivo nombra una ruta deprecada; el validador frena (VAL-C9) una historia que toca lo
 * deprecado sin motivo; y editar un archivo deprecado sin una historia que lo declare avisa o frena según el repo.
 * Borrar o mover lo deprecado pasa siempre. Al final, las regresiones del pase adversarial.
 *
 * Cada caso con su casa (HOME) y su carpeta de estado: nada toca el estado de la máquina.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const ROOT = path.resolve(SCRIPTS, '..', '..', '..');

// fechas fijas y sin el mantenimiento automático de git: el mismo repo de juguete en cada corrida
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-22T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-22T12:00:00Z' };
function git(dir, ...args) { spawnSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { stdio: 'ignore', env: GIT_ENV }); }

function repo(yaml, archivos = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-g-')));
  fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  for (const [rel, txt] of Object.entries({ 'README.md': 'x\n', ...archivos })) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), txt);
  }
  if (yaml != null) fs.writeFileSync(path.join(d, '.tycon', 'advisors.yaml'), yaml);
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  require('../lib/config-source.js').limpiarCache();
  return d;
}

function lista({ edit = 'warn' } = {}) {
  return [
    'deprecated:',
    `  edit: ${edit}`,
    '  paths:',
    '    - path: "src/legacy/**"',
    '      level: frozen',
    '      reason: "reemplazado por src/billing"',
    '    - path: src/muerto',
    '      level: dead',
    '      reason: "no se usa desde 2025"',
  ].join('\n') + '\n';
}

function historia({ modificar = [], crear = [], motivo = null } = {}) {
  return [
    '---',
    'epic: 1',
    'story: "1.1"',
    'title: "una"',
    'status: in-progress',
    ...(motivo ? [`deprecated_reason: "${motivo}"`] : []),
    'files_to_create:',
    ...crear.map((f) => `  - ${f}`),
    'files_to_modify:',
    ...modificar.map((f) => `  - ${f}   # comentario`),
    '---',
    '',
    '# Story 1.1',
    '',
  ].join('\n');
}

/** Un pipeline abierto con esta historia en una carpeta de estado propia. */
function estadoConMarcador(storyPath, repoPath, sid = 'ses-1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-g-estado-'));
  if (storyPath) {
    fs.mkdirSync(path.join(dir, 'active'), { recursive: true });
    // stable-data: un marcador recién escrito; el freno no mira su antigüedad, sólo la historia que nombra
    const ahora = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'active', `${sid}.json`), JSON.stringify({
      storyId: '1.1', storyPath, repoPath, sessionId: sid, startedAt: ahora,
      lastActivity: ahora, stepsCompleted: [1, 2, 3, 4], stepsPending: [5],
    }));
  }
  return dir;
}

function escribir(dir, rel, txt) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), txt);
}

test('Revisores_ContextoMarcaLoDeprecado', () => {
  const d = repo(lista(), { 'src/legacy/x.js': 'module.exports = 1;\n', 'src/vivo.js': 'module.exports = 2;\n' });
  escribir(d, 'src/legacy/x.js', 'module.exports = 10;\n');
  escribir(d, 'src/vivo.js', 'module.exports = 20;\n');
  escribir(d, 'specs/story-1.1.md', historia({ modificar: ['src/legacy/x.js', 'src/vivo.js'] }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-g-casa-'));
  const r = spawnSync(process.execPath, ['-e', `
    const p = require(${JSON.stringify(path.join(SCRIPTS, 'pipeline.js'))});
    const out = p.buildAdvisorContext({ repo: ${JSON.stringify(d)}, story: ${JSON.stringify(path.join(d, 'specs/story-1.1.md'))},
      files: ['src/legacy/x.js', 'src/vivo.js'], iter: 1 });
    process.stdout.write(require('fs').readFileSync(out.context_file, 'utf8'));
  `], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'ctx-1' } });
  const ctx = r.stdout;
  assert.match(ctx, /## Archivos deprecados del diff \(1\)/, r.stderr);
  assert.match(ctx, /- src\/legacy\/x\.js — congelado: reemplazado por src\/billing/);
  assert.match(ctx, /no lo revises, salvo que la historia declare `deprecated_reason:`/);
  assert.match(ctx, /revisor de patrones hermanos: no tomes de modelo/);
  const seccion = ctx.split('## Archivos deprecados del diff')[1].split('\n## ')[0];
  assert.doesNotMatch(seccion, /src\/vivo\.js/);
});

test('MechCheck_LoVivoNombraLoDeprecado', () => {
  const dep = require('../lib/deprecated.js');
  const d = repo(lista(), {
    'src/app.js': 'module.exports = 0;\n', 'src/legacy/x.js': 'module.exports = 1;\n', 'src/legacy/y.js': 'module.exports = 3;\n',
  });
  escribir(d, 'src/app.js', "module.exports = 0;\nconst x = require('./legacy/x');\n");
  escribir(d, 'src/legacy/y.js', "module.exports = 3;\nconst x = require('./x');\n");
  const hallazgos = dep.vivoQueNombraDeprecado({ repo: d });
  assert.equal(hallazgos.length, 1, JSON.stringify(hallazgos));
  const h = hallazgos[0];
  assert.equal(h.rule, 'DEPR-W1');
  assert.equal(h.severity, 'WARNING');
  assert.equal(h.file, 'src/app.js');
  assert.equal(h.line, 2);
  assert.equal(h.ruta, 'src/legacy/x');
  assert.match(h.detail, /src\/app\.js:2/);

  // y llega a la salida de `pipeline.js mech-check`, sin frenar
  escribir(d, 'specs/story-1.1.md', historia({ modificar: ['src/app.js'] }));
  const mc = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'mech-check', '--repo', d, '--story', path.join(d, 'specs/story-1.1.md')], { encoding: 'utf8' });
  const out = JSON.parse(mc.stdout);
  assert.ok(out.findings.some((f) => f.rule === 'DEPR-W1' && f.file === 'src/app.js'), mc.stdout);
});

test('Validador_ArchivosDeprecados', () => {
  const dep = require('../lib/deprecated.js');
  const d = repo(lista(), { 'src/legacy/x.js': 'x\n', 'src/muerto/m.js': 'x\n', 'src/vivo.js': 'x\n' });
  const sin = dep.archivosDeHistoria({ repo: d, storyText: historia({ modificar: ['src/legacy/x.js', 'src/muerto/m.js', 'src/vivo.js'] }) });
  assert.deepEqual(sin.map((a) => [a.archivo, a.nivel, a.frena]), [['src/legacy/x.js', 'frozen', true], ['src/muerto/m.js', 'dead', true]]);
  const con = dep.archivosDeHistoria({ repo: d, storyText: historia({ modificar: ['src/legacy/x.js', 'src/muerto/m.js'], motivo: 'arreglo del redondeo' }) });
  assert.deepEqual(con.map((a) => [a.archivo, a.frena]), [['src/legacy/x.js', false], ['src/muerto/m.js', true]]);
  const nuevoMuerto = dep.archivosDeHistoria({ repo: d, storyText: historia({ crear: ['src/muerto/nuevo.js'], motivo: 'x' }) });
  assert.deepEqual(nuevoMuerto.map((a) => [a.archivo, a.lista, a.frena]), [['src/muerto/nuevo.js', 'files_to_create', true]]);
  const nuevoCongelado = dep.archivosDeHistoria({ repo: d, storyText: historia({ crear: ['src/legacy/nuevo.js'] }) });
  assert.equal(nuevoCongelado[0].frena, true);
  const nuevoConMotivo = dep.archivosDeHistoria({ repo: d, storyText: historia({ crear: ['src/legacy/nuevo.js'], motivo: 'x' }) });
  assert.equal(nuevoConMotivo[0].frena, false);

  // y llega a la salida de `pipeline.js validators`
  escribir(d, 'specs/story-1.1.md', historia({ modificar: ['src/muerto/m.js'] }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-g-casa-'));
  const v = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'validators', '--repo', d, '--story', path.join(d, 'specs/story-1.1.md')],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_STORY_REVIEW: '0' } });
  const out = JSON.parse(v.stdout);
  assert.deepEqual(out.archivos_deprecados.map((a) => [a.archivo, a.frena]), [['src/muerto/m.js', true]], v.stderr);
});

test('Validador_ReglaVALC9_EnElCatalogo', () => {
  const leer = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const fuentes = {
    catalogo: leer('guides/advisor-rules-catalog.md'),
    validador: leer('agents/tycon-story-validator.md'),
    codex: leer('adapters/codex/agents/tycon-story-validator.toml'),
    codexNativo: leer('adapters/codex/agents-native/tycon-story-validator.toml'),
  };
  for (const [nombre, texto] of Object.entries(fuentes)) assert.match(texto, /VAL-C9/, `${nombre} no trae VAL-C9`);
  assert.match(fuentes.catalogo, /DEPR-W1/);
  assert.match(fuentes.validador, /archivos_deprecados/);
  const conteo = require(path.join(ROOT, 'scripts', 'lib', 'rules-catalog-count.js'));
  const r = conteo.check({ root: ROOT });
  assert.ok(!r.error, r.error);
  assert.ok(!r.skipped, `el conteo del catálogo no se salteó: ${r.skipped}`);
  assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.match(leer('story-format.md'), /^\| `deprecated_reason` \|/m, 'el campo en la tabla del frontmatter');
});

function editar(abs, extra = {}) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'ses-1', cwd: path.dirname(abs),
    tool_input: { file_path: abs, old_string: 'x', new_string: 'y' }, ...extra };
}

test('Editar_SinHistoria_AvisaPorOmision', () => {
  const gate = require('../on-deprecated-edit.js');
  const d = repo(lista(), { 'src/legacy/x.js': 'x\n' });
  const abs = path.join(d, 'src/legacy/x.js');
  const estado = estadoConMarcador(null);
  assert.equal(gate.handle(editar(abs), { stateDir: estado }), null, 'antes de editar, con warn, no frena');
  const post = gate.handle(editar(abs, { hook_event_name: 'PostToolUse' }), { stateDir: estado });
  for (const texto of [post.systemMessage, post.reminder]) {
    assert.match(texto, /src\/legacy\/x\.js/);
    assert.match(texto, /congelado/);
    assert.match(texto, /reemplazado por src\/billing/);
    assert.match(texto, /src\/legacy\/\*\*/);
    assert.doesNotMatch(texto, /TYCON_|=off|--no-|bypass/i, 'el aviso no enseña a apagarse');
  }
});

test('Editar_ModoBlock_Frena', () => {
  const gate = require('../on-deprecated-edit.js');
  const d = repo(lista({ edit: 'block' }), { 'src/legacy/x.js': 'x\n', 'src/muerto/m.js': 'x\n' });
  const abs = path.join(d, 'src/legacy/x.js');
  const sinHistoria = gate.handle(editar(abs), { stateDir: estadoConMarcador(null) });
  assert.ok(sinHistoria && sinHistoria.block, 'sin historia frena');
  assert.match(sinHistoria.block, /congelado/);
  assert.doesNotMatch(sinHistoria.block, /TYCON_|=off|--no-|bypass/i);

  escribir(d, 'specs/story-1.1.md', historia({ modificar: ['src/legacy/x.js', 'src/muerto/m.js'], motivo: 'arreglo del redondeo' }));
  const conHistoria = estadoConMarcador(path.join(d, 'specs/story-1.1.md'), d);
  assert.equal(gate.handle(editar(abs), { stateDir: conHistoria }), null, 'con historia y motivo pasa');
  const muerto = gate.handle(editar(path.join(d, 'src/muerto/m.js')), { stateDir: conHistoria });
  assert.ok(muerto && muerto.block, 'un muerto frena aunque la historia lo declare');
});

test('Editar_BorrarOMover_PasaSiempre', () => {
  const bash = require('../on-bash-write-gate.js');
  const d = repo(lista({ edit: 'block' }), { 'src/muerto/m.js': 'x\n', 'src/muerto/n.js': 'x\n', 'src/muerto/o.js': 'x\n' });
  const estado = estadoConMarcador(null);
  for (const command of ['git rm src/muerto/m.js', 'git mv src/muerto/n.js src/n.js', 'mv src/muerto/o.js src/muerto/p.js', 'rm -f src/muerto/o.js']) {
    const r = bash.handle({ tool_name: 'Bash', session_id: 'ses-1', cwd: d, tool_input: { command } }, { stateDir: estado });
    assert.ok(!r || !r.block || !/deprecado/.test(r.block), `${command}: ${r && r.block}`);
  }
});

test('Editar_PorLaTerminal', () => {
  const bash = require('../on-bash-write-gate.js');
  const d = repo(lista({ edit: 'block' }), { 'src/legacy/x.js': 'x\n' });
  const estado = estadoConMarcador(null);
  for (const command of ['sed -i s/x/y/ src/legacy/x.js', "cat > src/legacy/x.js <<'EOF'\nnuevo\nEOF"]) {
    const r = bash.handle({ tool_name: 'Bash', session_id: 'ses-1', cwd: d, tool_input: { command } }, { stateDir: estado });
    assert.ok(r && r.block, command);
    assert.match(r.block, /deprecado/);
    assert.match(r.block, /reemplazado por src\/billing/);
  }
});

// ── Vuelta 1 de revisores: los bordes del freno de edición (AC 8) y lo que no se puede mirar (AC 11) ────────────

function gatesLog(dir) { try { return fs.readFileSync(path.join(dir, "gates.log"), "utf8"); } catch (_e) { return ""; } }

test("Editar_HistoriaQueNoLoAutoriza_Frena", () => {
  const gate = require("../on-deprecated-edit.js");
  const d = repo(lista({ edit: "block" }), { "src/legacy/x.js": "x\n", "src/legacy/otro/index.js": "x\n" });
  const abs = path.join(d, "src/legacy/x.js");
  escribir(d, "specs/a.md", historia({ modificar: ["src/vivo.js"], motivo: "arreglo" }));
  assert.ok(gate.handle(editar(abs), { stateDir: estadoConMarcador(path.join(d, "specs/a.md"), d) }).block, "no lo declara");
  escribir(d, "specs/b.md", historia({ modificar: ["src/legacy/x.js"] }));
  assert.ok(gate.handle(editar(abs), { stateDir: estadoConMarcador(path.join(d, "specs/b.md"), d) }).block, "lo declara sin motivo");
  escribir(d, "specs/c.md", historia({ modificar: ["index.js"], motivo: "arreglo" }));
  assert.ok(gate.handle(editar(path.join(d, "src/legacy/otro/index.js")), { stateDir: estadoConMarcador(path.join(d, "specs/c.md"), d) }).block,
    "un nombre suelto no autoriza cualquier archivo que termine igual");
  assert.ok(gate.handle({ ...editar(abs), tool_name: "Write", tool_input: { file_path: abs, content: "y" } }, { stateDir: estadoConMarcador(null) }).block, "Write igual que Edit");
});

test("Editar_MuertoEnWarn_YMarcaSola_Avisan", () => {
  const gate = require("../on-deprecated-edit.js");
  const d = repo(lista(), { "src/muerto/m.js": "x\n", "src/marcado.js": "# harness-deprecated: dead — se borra\n" });
  const post = (f) => gate.handle({ ...editar(path.join(d, f)), hook_event_name: "PostToolUse" }, { stateDir: estadoConMarcador(null) });
  assert.match(post("src/muerto/m.js").systemMessage, /muerto/);
  assert.match(post("src/marcado.js").systemMessage, /marca .harness-deprecated:. en la cabecera/);
  const bash = require("../on-bash-write-gate.js");
  escribir(d, "src/muerto/notas.txt", "x\n");   // no es código: el carril no se mete
  const r = bash.handle({ tool_name: "Bash", session_id: "ses-1", cwd: d, tool_input: { command: "sed -i s/x/y/ src/muerto/notas.txt" } }, { stateDir: estadoConMarcador(null) });
  assert.ok(r && !r.block && /muerto/.test(r.aviso), "por la terminal, en warn, avisa sin frenar");
});

test("Editar_PorLaTerminal_BordesDelBorrarYMover", () => {
  const bash = require("../on-bash-write-gate.js");
  const d = repo(lista({ edit: "block" }), { "src/legacy/x.js": "x\n", "src/muerto/m.js": "x\n", "src/muerto/n.js": "x\n", "otro.js": "x\n", "tmp.txt": "x\n" });
  const corre = (command, estado = estadoConMarcador(null)) => bash.handle({ tool_name: "Bash", session_id: "ses-1", cwd: d, tool_input: { command } }, { stateDir: estado });
  assert.ok(corre("rm tmp.txt & sed -i s/x/y/ src/muerto/m.js").block, "un rm al principio no esconde la escritura que sigue (&)");
  assert.ok(corre("rm -f tmp.txt | sed -i s/x/y/ src/muerto/m.js").block, "ni detrás de una tubería");
  assert.ok(corre("mv otro.js src/muerto/n.js").block, "mover ENCIMA de un deprecado es pisarlo");
  const mover = corre("mv src/legacy/x.js src/x.js");
  // (el carril puede frenar un .js sin pipeline: acá importa que no lo frene lo deprecado)
  assert.ok(!mover || !mover.block || !/deprecado/.test(mover.block), `mover un congelado pasa: ${mover && mover.block}`);
  // con archivos que no son código el carril no se mete: la respuesta es sólo la de lo deprecado
  escribir(d, "src/legacy/a.txt", "x\n"); escribir(d, "src/muerto/b.txt", "x\n"); escribir(d, "src/muerto/c.txt", "x\n");
  assert.equal(corre("mv src/legacy/a.txt src/legacy/a2.txt"), null, "mover un congelado a un nombre nuevo pasa");
  assert.ok(corre("mv src/muerto/b.txt src/muerto/c.txt").block, "mover un deprecado ENCIMA de otro es pisarlo");
  assert.ok(corre('echo "x; rm y" > src/muerto/c.txt').block, "las comillas no esconden la redirección");
  assert.ok(corre("rm nada > src/muerto/c.txt").block, "un rm con redirección igual escribe");
  escribir(d, "specs/s.md", historia({ modificar: ["src/legacy/x.js"], motivo: "arreglo" }));
  const conHistoria = corre("sed -i s/x/y/ src/legacy/x.js", estadoConMarcador(path.join(d, "specs/s.md"), d));
  assert.ok(!conHistoria || !conHistoria.block || !/deprecado/.test(conHistoria.block), "con historia y motivo pasa también por la terminal");
});

test("Editar_NoSePuedeMirar_NoFrenaYQuedaDicho", () => {
  const gate = require("../on-deprecated-edit.js");
  const ilegible = repo("deprecated:\n  edit: block\n  paths:\n\t- path: x\n", { "src/legacy/x.js": "x\n" });
  const e1 = estadoConMarcador(null);
  assert.equal(gate.handle(editar(path.join(ilegible, "src/legacy/x.js")), { stateDir: e1 }), null);
  assert.match(gatesLog(e1), /unknown-config-ilegible/);
  const sinGit = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deprec-g-singit-")));
  escribir(sinGit, ".tycon/advisors.yaml", lista({ edit: "block" }));
  escribir(sinGit, "src/legacy/x.js", "x\n");
  const e2 = estadoConMarcador(null);
  assert.equal(gate.handle(editar(path.join(sinGit, "src/legacy/x.js")), { stateDir: e2 }), null);
  assert.match(gatesLog(e2), /unknown-sin-git/);
  const d = repo(lista({ edit: "block" }), { "src/legacy/x.js": "x\n" });
  const e4 = estadoConMarcador(path.join(d, "specs/no-existe.md"), d);
  assert.ok(gate.handle(editar(path.join(d, "src/legacy/x.js")), { stateDir: e4 }).block);
  assert.match(gatesLog(e4), /unknown-historia-ilegible/);
});

test("MechCheck_ImportYRutaEscrita_YListaIlegibleQuedaDicha", () => {
  const dep = require("../lib/deprecated.js");
  const d = repo(lista(), { "src/a.ts": "x\n", "src/b.js": "x\n", "src/legacy/x.ts": "x\n" });
  escribir(d, "src/a.ts", "x\nimport { y } from \"./legacy/x\";\n");
  escribir(d, "src/b.js", "x\nconst p = \"src/legacy/x.ts\";\n");
  const h = dep.vivoQueNombraDeprecado({ repo: d });
  assert.deepEqual(h.map((x) => [x.file, x.line]).sort(), [["src/a.ts", 2], ["src/b.js", 2]]);
  const ilegible = repo("deprecated:\n  paths:\n\t- path: x\n", {});
  const e = estadoConMarcador(null);
  assert.deepEqual(dep.vivoQueNombraDeprecado({ repo: ilegible, stateDir: e }), []);
  assert.equal(dep.seccionParaRevisores({ repo: ilegible, files: ["a.js"], stateDir: e }), "");
  assert.equal((gatesLog(e).match(/unknown-config-ilegible/g) || []).length, 2, "cada lector que no pudo mirar lo dice");
});

// ── Regresiones del freno: borrar y mover, la terminal destino por destino, otro repo────────────────────────────────────────────────────────────

test("Adversarial_Codex_BorrarOMoverConApplyPatchPasa", () => {
  const gate = require("../on-deprecated-edit.js");
  const { editEventsFrom } = require(path.join(ROOT, "scripts", "lib", "hook-io.js"));
  const d = repo(lista({ edit: "block" }), { "src/legacy/a.js": "x\n", "src/legacy/b.js": "x\n", "src/legacy/c.js": "x\n" });
  const parche = (cuerpo) => ({ tool_name: "apply_patch", cwd: d, hook_event_name: "PreToolUse", session_id: "ses-1", tool_input: { command: `*** Begin Patch\n${cuerpo}\n*** End Patch` } });
  const juzgar = (ev) => editEventsFrom(ev).map((e) => gate.handle(e, { stateDir: estadoConMarcador(null) }));
  assert.deepEqual(juzgar(parche("*** Delete File: src/legacy/a.js")), [null], "borrar pasa");
  assert.deepEqual(juzgar(parche("*** Update File: src/legacy/b.js\n*** Move to: src/nuevo/b.js")), [null], "mover pasa");
  const editar = juzgar(parche("*** Update File: src/legacy/c.js\n@@\n-x\n+y"));
  assert.ok(editar[0] && editar[0].block, "editarlo sigue frenando");
});

test("Adversarial_Terminal_MvJuzgadoDestinoPorDestino", () => {
  const bash = require("../on-bash-write-gate.js");
  const d = repo(lista({ edit: "block" }), {
    "src/legacy/a.txt": "x\n", "src/muerto/m.txt": "x\n", "vivo.txt": "x\n", "otro.txt": "x\n",
  });
  fs.mkdirSync(path.join(d, "src/muerto/sub"), { recursive: true });
  const corre = (command) => bash.handle({ tool_name: "Bash", session_id: "ses-1", cwd: d, tool_input: { command } }, { stateDir: estadoConMarcador(null) });
  assert.ok(corre("mv src/legacy/a.txt src/legacy/a2.txt && cp otro.txt src/muerto/nuevo.txt").block,
    "mover algo deprecado no exime a las demás escrituras del comando");
  assert.ok(corre("mv vivo.txt src/muerto/").block, "mover algo vivo adentro de una carpeta muerta es crear ahí");
  assert.equal(corre("mv src/muerto/m.txt src/muerto/sub/"), null, "mover un deprecado a una carpeta deprecada que existe pasa");
});

test("Adversarial_Historia_RutaDeOtroRepoNoSeJuzgaAca", () => {
  const dep = require("../lib/deprecated.js");
  const d = repo(lista(), { "src/muerto/m.js": "x\n" });
  const texto = historia({ modificar: ["(otro-repo) src/muerto/m.js", `(${path.basename(d)}) src/legacy/x.js`] });
  const r = dep.archivosDeHistoria({ repo: d, storyText: texto });
  assert.deepEqual(r.map((a) => a.archivo), ["src/legacy/x.js"], "la del otro repo no; la marcada con el nombre de éste, sí");
});
