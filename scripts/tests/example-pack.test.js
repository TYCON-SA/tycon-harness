'use strict';
/**
 * example-pack.test.js — el paquete de revisores de ejemplo (examples/packs/svelte-fastapi/) y la manera de examinar un
 * paquete (`advisor-runner.js --pack`).
 *
 * Por qué: el arnés no mantiene un revisor por framework; cada organización trae el suyo en un paquete. Sin un ejemplo,
 * quien arma uno adivina cómo se dispara un revisor, cómo se valida el paquete y cómo se prueban sus revisores. Este
 * ejemplo es el modelo para copiar, y estas pruebas cuidan que siga siendo válido y que no se instale solo.
 *
 * Qué fija, sin modelo:
 *   · el ejemplo es un paquete válido y sus revisores se disparan por lo tocado (.py, .svelte; nunca con un .ts);
 *   · cada regla de cada revisor tiene un caso que la tiene que marcar y otro que no, con un par canario por revisor;
 *   · el examen corre los casos de un paquete con `--pack` y, sin esa bandera, corre lo de siempre;
 *   · el ejemplo NO se instala (no vive en packs/), y al perfil del equipo va sólo lo que la capa acepta;
 *   · la guía dice lo que hay que saber y está enlazada.
 * La medición con modelo (rojo antes, verde después) y el laboratorio con `env -i` quedan como constancia en el repo de
 * mantenimiento.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE_PACKS = path.join(ROOT, 'examples', 'packs');
const EXAMPLE = path.join(EXAMPLE_PACKS, 'svelte-fastapi');
const PIPELINE = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js');
const RUNNER = path.join(ROOT, 'scripts', 'controls-bench', 'advisor-runner.js');
const CORE_CASES = path.join(ROOT, 'scripts', 'controls-bench', 'cases', 'advisors');
const REVIEWERS = ['example-svelte-reviewer', 'example-fastapi-reviewer'];

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** El ambiente de una corrida aislada: otro HOME, sin sesión, sin variables del arnés de quien corre la prueba. */
function isolatedEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(TYCON_|CLAUDE_|CODEX_)/.test(k) || k === 'NODE_TEST_CONTEXT') continue;
    env[k] = v;
  }
  return Object.assign(env, { HOME: tmp('example-pack-home-') }, extra);
}

/** Las reglas que declara el catálogo de un revisor: las filas `| **PREFIJO-C1** |` de sus tablas. */
function rulesOf(agent) {
  const md = fs.readFileSync(path.join(EXAMPLE, 'agents', `${agent}.md`), 'utf8');
  return [...md.matchAll(/^\|\s*\*\*([A-Z]+-[CW]\d+)\*\*\s*\|/gm)].map((m) => m[1]);
}
const examOf = (agent) => JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'exam', `${agent}.json`), 'utf8'));

/** Un repo de juguete con un solo archivo cambiado, y los revisores que `pipeline.js advisors` elige para él. */
function advisorsFor(file) {
  const repo = tmp('example-pack-repo-');
  spawnSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), file.endsWith('.py') ? 'x = 1\n' : '<p>x</p>\n');
  const r = spawnSync(process.execPath, [PIPELINE, 'advisors', '--repo', repo, '--files', file], {
    encoding: 'utf8',
    env: isolatedEnv({ TYCON_PACKS_DIR: EXAMPLE_PACKS, TYCON_PACKS_DEFAULT: 'svelte-fastapi', TYCON_AGENTS_DIR: path.join(ROOT, 'agents') }),
  });
  assert.strictEqual(r.status, 0, `pipeline.js advisors salió ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.all), 'la salida de advisors trae `all`');
  return out.all;
}

const runner = (args, env = {}) => spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env: isolatedEnv(env) });
/** Los ids que lista `--list`: las líneas `<revisor> :: <id> [...]`. */
const listedIds = (stdout) => [...stdout.matchAll(/^(\S+) :: (\S+) \[/gm)].map((m) => `${m[1]}::${m[2]}`);

test('@story-8.59 @ac-1 8.59-Ejemplo_PaqueteValido', () => {
  const { validateTree } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'packs.js'));
  const nucleo = fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  const errores = validateTree({ packsDir: EXAMPLE_PACKS, agentsDir: path.join(ROOT, 'agents'), nucleo });
  assert.deepStrictEqual(errores, [], 'el ejemplo es un paquete válido');
  const pack = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'pack.json'), 'utf8'));
  assert.strictEqual(pack.name, 'svelte-fastapi');
  assert.deepStrictEqual(pack.reviewers.map((r) => r.agent).sort(), [...REVIEWERS].sort());
  for (const r of pack.reviewers) {
    assert.strictEqual(r.group, 'condicional', `${r.agent}: condicional`);
    for (const k of ['when', 'surface', 'depth', 'prefixes']) assert.ok(r[k], `${r.agent}: declara ${k}`);
  }
  assert.deepStrictEqual(pack.reviewers.flatMap((r) => r.prefixes).sort(), ['FASTAPI', 'SVELTE']);
});

test('@story-8.59 @ac-2 8.59-Ejemplo_SoloPy_FastAPI', () => {
  const all = advisorsFor('app/util.py');
  assert.ok(all.includes('example-fastapi-reviewer'), `un .py suma el revisor FastAPI: ${all.join(', ')}`);
  assert.ok(!all.includes('example-svelte-reviewer'), 'un .py no suma el de Svelte');
});

test('@story-8.59 @ac-2 8.59-Ejemplo_SoloSvelte_Svelte', () => {
  const all = advisorsFor('src/lib/Card.svelte');
  assert.ok(all.includes('example-svelte-reviewer'), `un .svelte suma el revisor Svelte: ${all.join(', ')}`);
  assert.ok(!all.includes('example-fastapi-reviewer'), 'un .svelte no suma el de FastAPI');
});

test('@story-8.59 @ac-2 8.59-Ejemplo_SoloTs_Ninguno', () => {
  const all = advisorsFor('src/main.ts');
  for (const r of REVIEWERS) assert.ok(!all.includes(r), `un .ts no suma ${r}`);
});

test('@story-8.59 @ac-3 8.59-Examen_DosCasosPorRegla', () => {
  let total = 0;
  for (const agent of REVIEWERS) {
    const rules = rulesOf(agent);
    assert.strictEqual(rules.length, 2, `${agent}: dos reglas en su catálogo (${rules.join(', ')})`);
    const exam = examOf(agent);
    assert.strictEqual(exam.advisor, agent);
    assert.ok(exam.prompt_template && exam.prompt_template.includes('{files}'), `${agent}: prompt_template con {files}`);
    for (const rule of rules) for (const type of ['must-flag', 'must-not-flag'])
      assert.ok(exam.cases.some((c) => c.rule === rule && c.type === type), `${agent}: falta un caso ${type} de ${rule}`);
    const canarios = exam.cases.filter((c) => c.canario === true);
    assert.deepStrictEqual([...new Set(canarios.map((c) => c.type))].sort(), ['must-flag', 'must-not-flag'], `${agent}: par canario`);
    for (const c of exam.cases) {
      assert.ok(rules.includes(c.rule), `${agent}::${c.id} nombra una regla de su catálogo`);
      assert.ok(c.files && Object.keys(c.files).length, `${agent}::${c.id} trae sus archivos`);
    }
    total += exam.cases.length;
  }
  assert.strictEqual(total, 8);
});

test('@story-8.59 @ac-4 8.59-Runner_Pack_ListaSusCasos', () => {
  const r = runner(['--pack', EXAMPLE, '--list']);
  assert.strictEqual(r.status, 0, r.stderr);
  const ids = listedIds(r.stdout);
  const esperados = REVIEWERS.flatMap((a) => examOf(a).cases.map((c) => `${a}::${c.id}`));
  assert.deepStrictEqual(ids.sort(), esperados.sort(), 'lista exactamente los casos del paquete');
  assert.match(r.stdout, new RegExp(`agentes: ${path.join(EXAMPLE, 'agents').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'el canónico se lee de la carpeta del paquete');
  // el informe de un paquete no se llama `advisors-*` ni `vida-*`: el aviso del arranque lee ésos (los del núcleo)
  assert.match(r.stdout, /informe: \S*\/pack-svelte-fastapi-[0-9a-f]{8}-claude\.json/, 'el informe lleva el prefijo del paquete');
  // dos paquetes cuyos nombres se escriben igual al limpiarlos («equipo.web» y «equipo-web») no comparten informe
  const informeDe = (nombre) => {
    const dir = tmp('example-pack-name-');
    fs.cpSync(EXAMPLE, dir, { recursive: true });
    const f = path.join(dir, 'pack.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.name = nombre; fs.writeFileSync(f, JSON.stringify(j));
    const rr = runner(['--pack', dir, '--list']);
    assert.strictEqual(rr.status, 0, rr.stderr);
    return /informe: (\S+)/.exec(rr.stdout)[1];
  };
  assert.notStrictEqual(informeDe('equipo.web'), informeDe('equipo-web'), 'cada paquete escribe su propio informe');
  // sin `name` en pack.json, el paquete se llama como su carpeta
  const sinNombre = tmp('example-pack-noname-');
  const carpeta = path.join(sinNombre, 'mi-paquete');
  fs.cpSync(EXAMPLE, carpeta, { recursive: true });
  const fm = path.join(carpeta, 'pack.json'); const jm = JSON.parse(fs.readFileSync(fm, 'utf8')); delete jm.name; fs.writeFileSync(fm, JSON.stringify(jm));
  const rn = runner(['--pack', carpeta, '--list']);
  assert.strictEqual(rn.status, 0, rn.stderr);
  assert.match(rn.stdout, /paquete: mi-paquete /, 'sin name, el de la carpeta');
  // --only acota a un subconjunto del paquete
  const ro = runner(['--pack', EXAMPLE, '--list', '--only', 'fastapi-c1']);
  assert.strictEqual(ro.status, 0, ro.stderr);
  assert.deepStrictEqual(listedIds(ro.stdout).sort(), ['example-fastapi-reviewer::fastapi-c1-con-modelo', 'example-fastapi-reviewer::fastapi-c1-cuerpo-como-dict'], '--only lista sólo lo que coincide');
});

test('@story-8.59 @ac-5 8.59-Runner_SinPack_IgualQueAntes', () => {
  const r = runner(['--list']);
  assert.strictEqual(r.status, 0, r.stderr);
  const esperados = fs.readdirSync(CORE_CASES).filter((f) => f.endsWith('.json'))
    .flatMap((f) => { const s = JSON.parse(fs.readFileSync(path.join(CORE_CASES, f), 'utf8')); return s.cases.map((c) => `${s.advisor}::${c.id}`); });
  assert.deepStrictEqual(listedIds(r.stdout).sort(), esperados.sort(), 'los mismos casos de siempre');
  assert.ok(!/example-/.test(r.stdout), 'ningún caso del ejemplo');
});

test('@story-8.59 @ac-6 8.59-Runner_Pack_FrenaLoQueNoAplica', () => {
  const sinExam = tmp('example-pack-noexam-');
  fs.copyFileSync(path.join(EXAMPLE, 'pack.json'), path.join(sinExam, 'pack.json'));
  const sinManifiesto = tmp('example-pack-nomanifest-');
  fs.mkdirSync(path.join(sinManifiesto, 'exam'));
  fs.copyFileSync(path.join(EXAMPLE, 'exam', 'example-svelte-reviewer.json'), path.join(sinManifiesto, 'exam', 'example-svelte-reviewer.json'));
  // un paquete armado a mano a partir del ejemplo, con un cambio que lo deja sin examinar
  const variante = (prefijo, cambiar) => {
    const dir = tmp(prefijo);
    fs.cpSync(EXAMPLE, dir, { recursive: true });
    cambiar(dir);
    return dir;
  };
  const editarJson = (f, fn) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); fn(j); fs.writeFileSync(f, JSON.stringify(j)); };
  const agentsAfuera = variante('example-pack-agentsout-', (d) => editarJson(path.join(d, 'pack.json'), (j) => { j.agents = '../afuera'; }));
  const sinAgente = variante('example-pack-noagent-', (d) => fs.rmSync(path.join(d, 'agents', 'example-svelte-reviewer.md')));
  const casosVacios = variante('example-pack-nocases-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.cases = []; }));
  const sinRevisor = variante('example-pack-noadvisor-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { delete j.advisor; }));
  // los casos de un paquete usan el contrato del ejemplo: id, type must-flag|must-not-flag, rule y files. Un caso sin
  // regla, de otro tipo o que depende de un servidor que puede faltar (y entonces se saltea) no examina nada
  const sinRegla = variante('example-pack-norule-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { delete j.cases[0].rule; }));
  const tipoRaro = variante('example-pack-type-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.cases[0].type = 'artefactos'; }));
  const conMcp = variante('example-pack-mcp-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.cases[0].expect_mcp = { server: 'x', tool: 'y' }; }));
  const sinId = variante('example-pack-noid-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { delete j.cases[0].id; }));
  const barraInvertida = variante('example-pack-backslash-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.cases[0].files = { 'a\\b.txt': 'x' }; }));
  const tramoVacio = variante('example-pack-emptyseg-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.cases[0].files = { 'a//b.txt': 'x' }; }));
  const enSvelte = (prefijo, fn) => variante(prefijo, (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), fn));
  const reglaEnBlanco = enSvelte('example-pack-blankrule-', (j) => { j.cases[0].rule = '  '; });
  const conEngram = enSvelte('example-pack-engram-', (j) => { j.cases[0].expect_engram = { project: 'advbench-x' }; });
  const commitsNoLista = enSvelte('example-pack-commitsobj-', (j) => { j.cases[0].git_commits = { message: 'm' }; });
  // el texto del pedido va como argumento de la herramienta: si empieza con «-» se leería como una opción
  const plantillaOpcion = enSvelte('example-pack-tplopt-', (j) => { j.prompt_template = '--other-option {files}'; });
  const pedidoOpcion = enSvelte('example-pack-promptopt-', (j) => { j.cases[0].prompt = '-x'; });
  const plantillaNoTexto = enSvelte('example-pack-tplnum-', (j) => { j.prompt_template = 7; });
  // ni archivos que la herramienta carga sola desde la carpeta del caso (configuración, servidores, instrucciones)
  const confClaude = enSvelte('example-pack-dotclaude-', (j) => { j.cases[0].files = { '.Claude/settings.json': '{}' }; });
  const confMcp = enSvelte('example-pack-mcp-json-', (j) => { j.cases[0].files = { '.mcp.json': '{}' }; });
  const instrucciones = enSvelte('example-pack-claudemd-', (j) => { j.cases[0].files = { 'src/CLAUDE.md': 'x' }; });
  // el contrato es una lista cerrada de claves: una de otra herramienta (tools, asymmetry) dejaba un caso salteado en
  // silencio y el examen verde con los demás; una clave desconocida tampoco entra
  const soloCodex = enSvelte('example-pack-tools-', (j) => { j.cases[0].tools = ['codex']; j.cases[0].asymmetry = 'x'; });
  const claveRara = enSvelte('example-pack-unknown-', (j) => { j.cases[0].esperar_algo = true; });
  const archivoNoTexto = enSvelte('example-pack-nontext-', (j) => { j.cases[0].files = { 'a.txt': 7 }; });
  const manifiestoRoto = variante('example-pack-badjson-', (d) => fs.writeFileSync(path.join(d, 'pack.json'), '{ esto no es json'));
  // las claves de `files` son rutas dentro de la carpeta temporal del caso: un paquete ajeno no escribe afuera
  const archivoAfuera = variante('example-pack-fileout-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.cases[0].files = { '../../afuera.txt': 'x' }; }));
  const archivoAbsoluto = variante('example-pack-fileabs-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.cases[0].files = { [path.join(os.tmpdir(), 'afuera.txt')]: 'x' }; }));
  // ni dentro de `.git/` de la carpeta del caso: un `.git/config` plantado corre un comando en el `git commit` del examen
  const enGit = variante('example-pack-gitdir-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.cases[0].git_commits = [{ message: 'm', files: { '.GIT/config': '[core]\n\tfsmonitor = touch /tmp/x\n' } }]; }));
  // stable-data: «pre-commit» es el nombre de un archivo de un caso que el examen rechaza al cargar; acá no se crea ningún commit
  const enGitAnidado = variante('example-pack-gitnested-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.cases[0].files = { 'sub/.git/hooks/pre-commit': 'x' }; }));
  const commitAfuera = variante('example-pack-commitout-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.cases[0].git_commits = [{ message: 'm', files: { '../afuera.txt': 'x' } }]; }));
  const revisorConRuta = variante('example-pack-advisorpath-', (d) => editarJson(path.join(d, 'exam', 'example-svelte-reviewer.json'), (j) => { j.advisor = '../../agents/tycon-story-validator'; }));
  const casos = [
    [['--pack', EXAMPLE, '--baseline', 'check'], /baseline/],
    [['--pack', EXAMPLE, '--tool', 'codex'], /codex/],
    [['--pack', EXAMPLE, '--tool', 'both'], /codex/],
    [['--pack', sinExam], /\/exam no existe o no tiene casos/],
    [['--pack', sinManifiesto], /pack\.json/],
    [['--list', '--pack'], /--pack necesita la carpeta/],
    [['--pack', EXAMPLE, '--only', 'no-coincide-con-nada'], /ningún caso/],
    [['--list', '--pack', EXAMPLE, '--only', 'no-coincide-con-nada'], /ningún caso/],
    [['--pack', EXAMPLE, '--liveness'], /liveness/],
    [['--pack', agentsAfuera], /sale de la carpeta/],
    [['--pack', sinAgente], /sin su \.md/],
    [['--pack', casosVacios], /sin casos/],
    [['--pack', sinRevisor], /"advisor"/],
    [['--pack', revisorConRuta], /"advisor"/],
    [['--pack', sinRegla], /"rule"/],
    [['--pack', tipoRaro], /"type"/],
    [['--pack', conMcp], /expect_mcp/],
    [['--pack', '--list'], /--pack necesita la carpeta/],
    [['--pack', manifiestoRoto], /pack\.json/],
    [['--pack', EXAMPLE, '--selftest-retro'], /--selftest-retro/],
    [['--pack', EXAMPLE, '--check-apps-off'], /--check-apps-off/],
    [['--pack', EXAMPLE, '--selftest-mcp'], /--selftest-mcp/],
    [['--pack', EXAMPLE, '--reclassify'], /--reclassify/],
    [['--pack', EXAMPLE, '--selftest-variance'], /--selftest-variance/],
    [['--pack', EXAMPLE, '--selftest-sandbox'], /--selftest-sandbox/],
    [['--pack', EXAMPLE, '--selftest-classes'], /--selftest-classes/],
    [['--pack', sinId], /"id"/],
    [['--pack', reglaEnBlanco], /"rule"/],
    [['--pack', conEngram], /expect_engram/],
    [['--pack', commitsNoLista], /"git_commits"/],
    [['--pack', plantillaOpcion], /"prompt_template"/],
    [['--pack', pedidoOpcion], /"prompt"/],
    [['--pack', plantillaNoTexto], /"prompt_template"/],
    [['--pack', confClaude], /\.Claude\/settings\.json/],
    [['--pack', confMcp], /\.mcp\.json/],
    [['--pack', instrucciones], /CLAUDE\.md/],
    [['--pack', soloCodex], /"tools"/],
    [['--pack', claveRara], /"esperar_algo"/],
    [['--pack', archivoNoTexto], /a\.txt/],
    [['--pack', EXAMPLE, '--jobs', '0'], /--jobs/],
    [['--pack', EXAMPLE, '--jobs', 'abc'], /--jobs/],
    [['--pack', barraInvertida], /a\\b\.txt/],
    [['--pack', tramoVacio], /a\/\/b\.txt/],
    [['--pack', archivoAfuera], /afuera\.txt/],
    [['--pack', archivoAbsoluto], /afuera\.txt/],
    [['--pack', commitAfuera], /afuera\.txt/],
    [['--pack', enGit], /\.GIT\/config/],
    [['--pack', enGitAnidado], /\.git\/hooks/],
  ];
  for (const [args, motivo] of casos) {
    const r = runner(args);
    assert.notStrictEqual(r.status, 0, `${args.join(' ')} tiene que frenar`);
    assert.match(r.stderr, motivo, `${args.join(' ')}: dice el motivo`);
    assert.ok(!/advisor-bench:/.test(r.stdout), `${args.join(' ')}: no corre ningún caso`);
  }
});

// dos casos con la misma clave `advisor::id` guardarían el veredicto con esa clave: el segundo pisaría al primero y un
// rojo quedaría tapado por un verde, con el conteo «juzgados == planeados» cuadrando igual
test('@story-8.60 @ac-1 @ac-2 8.60-Runner_Pack_FrenaIdsRepetidos', () => {
  const SVELTE = 'example-svelte-reviewer';
  const copia = (prefijo, cambiar) => { const dir = tmp(prefijo); fs.cpSync(EXAMPLE, dir, { recursive: true }); cambiar(path.join(dir, 'exam')); return dir; };
  // en un mismo archivo: el must-not-flag de SVELTE-C1 con el id del must-flag
  const enUnArchivo = copia('example-pack-dupid-', (exam) => {
    const f = path.join(exam, `${SVELTE}.json`); const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.cases[1].id = j.cases[0].id; fs.writeFileSync(f, JSON.stringify(j));
  });
  // en dos archivos del mismo revisor
  const enDosArchivos = copia('example-pack-dupfile-', (exam) => {
    const j = JSON.parse(fs.readFileSync(path.join(exam, `${SVELTE}.json`), 'utf8'));
    j.cases = [j.cases.find((c) => c.id === 'svelte-w1-cancelada-en-ondestroy')];
    j.cases[0].id = 'svelte-w1-subscribe-sin-cancelar';
    fs.writeFileSync(path.join(exam, `${SVELTE}-2.json`), JSON.stringify(j));
  });
  for (const [dir, id] of [[enUnArchivo, 'svelte-c1-html-de-una-prop'], [enDosArchivos, 'svelte-w1-subscribe-sin-cancelar']]) {
    for (const extra of [[], ['--list']]) {
      const args = ['--pack', dir, ...extra];
      const r = runner(args);
      assert.notStrictEqual(r.status, 0, `${args.join(' ')} tiene que frenar`);
      assert.ok(r.stderr.includes(`${SVELTE}::${id}`), `${args.join(' ')}: nombra la clave repetida (${r.stderr.trim()})`);
      assert.deepStrictEqual(listedIds(r.stdout), [], `${args.join(' ')}: no lista ningún caso`);
      assert.ok(!/advisor-bench:/.test(r.stdout), `${args.join(' ')}: no corre ningún caso`);
    }
  }
});

test('@story-8.59 @ac-7 @ac-8 8.59-Ejemplo_NoSeInstala', () => {
  // packs/ del público trae sólo su README; en el árbol armado de los nocturnos trae además los del perfil del equipo. En
  // ninguno de los dos está el ejemplo.
  assert.ok(!fs.existsSync(path.join(ROOT, 'packs', 'svelte-fastapi')), 'el ejemplo no está en packs/');
  const { listPacks } = require(path.join(ROOT, 'scripts', 'lib', 'pack-pieces.js'));
  const descubiertos = listPacks(path.join(ROOT, 'packs')).packs;
  assert.ok(!descubiertos.some((p) => p.name === 'svelte-fastapi'), 'el ejemplo no está entre los paquetes descubiertos');
  for (const p of descubiertos) {
    const agentes = (JSON.parse(fs.readFileSync(p.file, 'utf8')).reviewers || []).map((r) => r.agent);
    for (const r of REVIEWERS) assert.ok(!agentes.includes(r), `${p.name} no declara ${r}`);
  }
  const { layerPathProblem } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
  const files = [];
  (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(EXAMPLE, p).split(path.sep).join('/')); } })(EXAMPLE);
  for (const rel of files) {
    const why = layerPathProblem(`packs/svelte-fastapi/${rel}`);
    // los casos del examen viajan con el paquete, así el examen se puede correr donde vive el paquete
    if (rel === 'pack.json' || rel.startsWith('agents/') || /^exam\/[^/]+\.json$/.test(rel)) assert.strictEqual(why, null, `${rel} viaja con el perfil del equipo`);
    else assert.ok(why, `${rel} no viaja con el perfil: se queda donde se arma el paquete`);
  }
  assert.ok(files.some((f) => f.startsWith('exam/')) && files.includes('README.md'), 'el ejemplo trae exam/ y README.md');
});

test('@story-8.59 @ac-9 8.59-Guia_DiceLoQueHayQueSaber', () => {
  for (const g of ['guides/reviewer-packs.md', 'guides/reviewer-packs.en.md']) {
    const txt = read(g);
    for (const w of ['pack.json', 'pyModified', 'svelteModified', '`files`', '`added`', 'packs.default', 'TYCON_PACKS_DIR', 'packs:', 'pipeline.js advisors', '--pack', 'exam/', 'examples/packs/svelte-fastapi'])
      assert.ok(txt.includes(w), `${g} nombra ${w}`);
  }
  for (const f of ['INDEX.md', 'packs/README.md', 'guides/agent-architecture.md'])
    assert.ok(read(f).includes('reviewer-packs.md'), `${f} enlaza la guía`);
  assert.ok(read('guides/piezas-del-arnes.md').includes('examples/'), 'el árbol de piezas nombra examples/');
});

test('@story-8.70 @ac-6 @ac-7 ReviewerPacks_SoloSection', () => {
  const es = read('guides/reviewer-packs.md');
  const sec = es.slice(es.indexOf('## Si trabajás solo'));
  assert.ok(es.includes('## Si trabajás solo'), 'la guía en castellano trae la sección');
  for (const w of ['harness.js team-init --local', 'packs/<nombre>/', 'team-profile.json', 'packs.default', 'git commit', 'harness.js update', '--pack', 'catálogo', 'una sola vez', 'harness.js install --team', 'nunca'])
    assert.ok(sec.includes(w), `la sección nombra ${w}`);
  assert.ok(/nunca se hace: escribir el paquete en la instalación/i.test(sec), 'dice que nunca se escribe en la instalación');
  assert.ok(/no lo vuelvas a ofrecer/.test(sec), 'la copia de respaldo se ofrece una sola vez');
  assert.ok(!/No copies `exam\/`/.test(es), 'el examen ya viaja con el paquete');
  const en = read('guides/reviewer-packs.en.md');
  assert.ok(en.includes('## If you work alone'), 'la guía en inglés trae la sección');
  const secEn = en.slice(en.indexOf('## If you work alone'));
  for (const w of ['harness.js team-init --local', 'packs/<name>/', 'team-profile.json', 'harness.js update', '--pack', 'catalog', 'once', 'harness.js install --team'])
    assert.ok(secEn.includes(w), `the section names ${w}`);
});
