'use strict';
/**
 * exemptions-record.test.js — la exención de una historia viaja con la constancia del dueño en el repo.
 *
 * Una exención (`advisors_exempt`, `dod_runtime_exempt`) saltea un chequeo del cierre. El gancho del encabezado la pide
 * firmada al escribirla, pero una historia se puede escribir por otros caminos (la consola, un parche, otra herramienta).
 * Con la firma, el arnés anota un renglón en `<repo>/.tycon/exemptions.jsonl`; el portón del commit y el de CI frenan una
 * exención que el diff agrega sin su renglón, y el archivo no se escribe a mano. Repos de git en carpetas temporales,
 * HOME temporal, sin red: los ganchos y el portón corren como procesos, como los corre Claude Code.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const EX = require(path.join(SCRIPTS, 'lib', 'exemptions.js'));
const PRE_COMMIT = path.join(SCRIPTS, 'on-pre-commit.js');
const ENCABEZADO = path.join(SCRIPTS, 'on-frontmatter-write.js');
const GATE = path.join(RAIZ, 'scripts', 'ci', 'tycon-ci-gate.js');
const SID = 's-exenciones';

const historia = (status, extra = '') => `---\nstory: "9.9"\nepic: "9"\ntitle: "Algo"\nstatus: ${status}\n${extra}qa_guide: off\n---\n\n# Story 9.9\n\nTexto.\n`;
const exenta = (campo) => `${campo}: true\n${campo}_reason: "docs"\n`;
const constancia = (campo, story = '9.9') => `${JSON.stringify({ story, campo, archivo: 'specs/story-9.9-algo.md', via: 'ventana', sesion: SID, ts: '2026-11-24T00:00:00Z' })}\n`;
const REL = 'specs/story-9.9-algo.md';

/** Un repo con `base` commiteado y `cambios` en el índice; `null` borra. */
function repo(t, base, cambios = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exenciones-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(r, { recursive: true });
  const fecha = '2026-11-24T00:00:00Z';
  const git = (...a) => execFileSync('git', ['-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0', ...a], { cwd: r, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  const escribir = (archivos) => {
    for (const [rel, txt] of Object.entries(archivos)) {
      const f = path.join(r, rel);
      if (txt === null) { fs.rmSync(f, { force: true }); continue; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, txt);
    }
  };
  git('init', '-q', '-b', 'main', '.');
  escribir({ 'README.md': 'x\n', ...base });
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', 'HEAD').trim();
  escribir(cambios);
  git('add', '-A');
  return { dir: r, home, base: sha, git, escribir };
}

function preCommit({ dir, home }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' };
  delete env.TYCON_HOME; delete env.NODE_TEST_CONTEXT; delete env.GIT_INDEX_FILE;
  const r = spawnSync(process.execPath, [PRE_COMMIT], { cwd: dir, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: SID, cwd: dir, tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } }) });
  return { code: r.status, err: r.stderr || '' };
}

function portonCI(r, ...args) {
  const p = spawnSync(process.execPath, [GATE, '--repo', r.dir, ...args, '--json'], { encoding: 'utf8', env: { ...process.env, HOME: r.home, USERPROFILE: r.home } });
  let j = null;
  try { j = JSON.parse(p.stdout); } catch (_) { j = null; }
  return { code: p.status, j, salida: `${p.stdout}${p.stderr}` };
}
const reglas = (j) => (j && Array.isArray(j.hallazgos) ? j.hallazgos.map((h) => h.regla) : []);

test('T1 Exenciones_Faltan_LeeElArchivoSoloConUnaNueva', () => {
  let leidas = 0;
  const leer = (texto) => () => { leidas++; return texto; };
  // sin exención nueva no lee nada: un commit que no agrega una no paga
  assert.deepStrictEqual(EX.faltan({ archivo: REL, viejo: historia('in-progress'), nuevo: historia('done'), leer: leer('') }), []);
  assert.deepStrictEqual(EX.faltan({ archivo: REL, viejo: historia('in-progress', exenta('advisors_exempt')), nuevo: historia('done', exenta('advisors_exempt')), leer: leer('') }), []);
  assert.deepStrictEqual(EX.faltan({ archivo: REL, viejo: null, nuevo: '# una guía\n\nadvisors_exempt: true\n', leer: leer('') }), []);
  assert.strictEqual(leidas, 0, 'no leyó el archivo de constancias');
  // nueva, sin constancia; con la de otra historia o de la otra exención tampoco
  for (const campo of ['advisors_exempt', 'dod_runtime_exempt']) {
    const otro = campo === 'advisors_exempt' ? 'dod_runtime_exempt' : 'advisors_exempt';
    assert.deepStrictEqual(EX.faltan({ archivo: REL, viejo: historia('in-progress'), nuevo: historia('in-progress', exenta(campo)), leer: leer('') }), [campo]);
    assert.deepStrictEqual(EX.faltan({ archivo: REL, viejo: historia('in-progress'), nuevo: historia('in-progress', exenta(campo)), leer: leer(constancia(campo, '9.10')) }), [campo]);
    assert.deepStrictEqual(EX.faltan({ archivo: REL, viejo: historia('in-progress'), nuevo: historia('in-progress', exenta(campo)), leer: leer(constancia(otro)) }), [campo]);
    // con la suya, nada; también en una historia nueva, y con un renglón ilegible al lado
    assert.deepStrictEqual(EX.faltan({ archivo: REL, viejo: historia('in-progress'), nuevo: historia('in-progress', exenta(campo)), leer: leer(`no es json\n${constancia(campo)}`) }), []);
    assert.deepStrictEqual(EX.faltan({ archivo: REL, viejo: null, nuevo: historia('done', exenta(campo)), leer: leer(constancia(campo)) }), []);
  }
  // sin poder leer el archivo, ninguna tiene constancia
  assert.deepStrictEqual(EX.faltan({ archivo: REL, viejo: '', nuevo: historia('done', exenta('advisors_exempt')), leer: () => { throw new Error('no hay'); } }), ['advisors_exempt']);
});

test('T2 PreCommit_ExencionSinConstancia_Frena: en cualquier estado, se haya escrito por donde se haya escrito', (t) => {
  for (const campo of ['advisors_exempt', 'dod_runtime_exempt']) {
    for (const estado of ['in-progress', 'done']) {
      const r = preCommit(repo(t, { [REL]: historia('in-progress') }, { [REL]: historia(estado, exenta(campo)) }));
      assert.strictEqual(r.code, 2, `${campo}, ${estado}: ${r.err}`);
      assert.match(r.err, new RegExp(`agrega \`${campo}\``));
      assert.match(r.err, /\.tycon\/exemptions\.jsonl/);
    }
  }
  // con su constancia en el índice, el chequeo de la exención pasa (la historia en implementación no pide nada más)
  const con = preCommit(repo(t, { [REL]: historia('in-progress') }, { [REL]: historia('in-progress', exenta('advisors_exempt')), [EX.RUTA]: constancia('advisors_exempt') }));
  assert.strictEqual(con.code, 0, con.err);
  // una constancia que no está en el índice no cuenta: el portón lee lo que se commitea
  const r = repo(t, { [REL]: historia('in-progress') }, { [REL]: historia('in-progress', exenta('advisors_exempt')) });
  r.escribir({ [EX.RUTA]: constancia('advisors_exempt') });
  assert.strictEqual(preCommit(r).code, 2, 'la constancia sin agregar al índice no cuenta');
  // la que ya estaba no pide nada
  const ya = preCommit(repo(t, { [REL]: historia('in-progress', exenta('advisors_exempt')) }, { [REL]: historia('in-progress', exenta('advisors_exempt')).replace('Texto.', 'Texto nuevo.') }));
  assert.strictEqual(ya.code, 0, ya.err);
});

test('T3 PortonCI_ExencionSinConstancia_Frena: en cualquier estado del diff, no sólo al pasar a done', (t) => {
  for (const campo of ['advisors_exempt', 'dod_runtime_exempt']) {
    const r = repo(t, { [REL]: historia('in-progress') });
    r.escribir({ [REL]: historia('in-progress', exenta(campo)) });
    r.git('add', '-A'); r.git('commit', '-q', '-m', 'exime');
    const p = portonCI(r, '--base', r.base);
    assert.ok(reglas(p.j).includes('exencion-sin-constancia'), `${campo}: ${p.salida}`);
    assert.notStrictEqual(p.code, 0, 'frena');
    // con su constancia commiteada, no
    r.escribir({ [EX.RUTA]: constancia(campo) });
    r.git('add', '-A'); r.git('commit', '-q', '-m', 'constancia');
    assert.ok(!reglas(portonCI(r, '--base', r.base).j).includes('exencion-sin-constancia'), `${campo} con constancia`);
  }
  // una exención que ya estaba en la base no pide constancia aunque la historia cambie
  const ya = repo(t, { [REL]: historia('in-progress', exenta('advisors_exempt')) });
  ya.escribir({ [REL]: historia('in-progress', exenta('advisors_exempt')).replace('Texto.', 'Texto nuevo.') });
  ya.git('add', '-A'); ya.git('commit', '-q', '-m', 'texto');
  assert.ok(!reglas(portonCI(ya, '--base', ya.base).j).includes('exencion-sin-constancia'));
  // en el pre-commit del portón (--staged), igual
  const st = repo(t, { [REL]: historia('in-progress') }, { [REL]: historia('in-progress', exenta('advisors_exempt')) });
  assert.ok(reglas(portonCI(st, '--staged').j).includes('exencion-sin-constancia'), 'con --staged');
});

// La firma de la ventana se lee en la casa de la cuenta (la del sistema, no la de HOME): el gancho corre acá, con la casa
// de la prueba como parámetro, y HOME apunta a ella mientras tanto para que el registro de frenos no toque la de verdad
test('T4 Encabezado_ExencionFirmada_AnotaLaConstanciaEnElRepo; sin repo, frena', (t) => {
  const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
  const { handle } = require(ENCABEZADO);
  const correr = (home, evento) => {
    const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TYCON_GUIDES_DIR: process.env.TYCON_GUIDES_DIR };
    Object.assign(process.env, { HOME: home, USERPROFILE: home, TYCON_GUIDES_DIR: RAIZ });
    try {
      const r = handle({ hook_event_name: 'PreToolUse', session_id: SID, tool_use_id: 'toolu_x', ...evento }, { casa: home });
      return { status: r && r.block ? 2 : 0, stderr: (r && r.block) || '' };
    } finally {
      for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
  const agregar = (f, campo) => ({ tool_name: 'Edit', tool_input: { file_path: f, old_string: 'qa_guide: off\n', new_string: `${exenta(campo)}qa_guide: off\n` } });
  for (const campo of ['advisors_exempt', 'dod_runtime_exempt']) {
    const r = repo(t, { [REL]: historia('in-progress') });
    const f = path.join(r.dir, REL);
    ow.firmarArchivo({ firma: campo, via: 'ventana', sesion: SID, archivo: f, casa: r.home });
    const p = correr(r.home, agregar(f, campo));
    assert.strictEqual(p.status, 0, `${campo}: ${p.stderr}`);
    const texto = fs.readFileSync(path.join(r.dir, EX.RUTA), 'utf8');
    assert.ok(EX.tieneConstancia(texto, '9.9', campo, REL), texto);
    const renglon = JSON.parse(texto.trim().split('\n').pop());
    assert.strictEqual(renglon.archivo, REL);
    assert.strictEqual(renglon.sesion, SID);
    // sin firma, frena y no anota nada
    const otro = repo(t, { [REL]: historia('in-progress') });
    assert.strictEqual(correr(otro.home, agregar(path.join(otro.dir, REL), campo)).status, 2);
    assert.ok(!fs.existsSync(path.join(otro.dir, EX.RUTA)), 'sin firma no hay constancia');
  }
  // una historia fuera de un repo: la firma vale pero la constancia no se puede anotar, y frena diciéndolo
  const suelta = fs.mkdtempSync(path.join(os.tmpdir(), 'exenciones-suelta-'));
  t.after(() => fs.rmSync(suelta, { recursive: true, force: true }));
  const casa = path.join(suelta, 'home');
  fs.mkdirSync(casa);
  const f = path.join(suelta, 'specs', 'story-9.9-algo.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, historia('in-progress'));
  ow.firmarArchivo({ firma: 'advisors_exempt', via: 'ventana', sesion: SID, archivo: f, casa });
  const p = correr(casa, agregar(f, 'advisors_exempt'));
  assert.strictEqual(p.status, 2, p.stderr);
  assert.match(p.stderr, /no pude anotar su constancia/);
});

test('T5 Frenos_ArchivoDeConstancias_NoSeEscribeAMano', () => {
  const sg = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
  for (const p of ['/r/.tycon/exemptions.jsonl', 'r/.TYCON/Exemptions.jsonl', '.tycon/exemptions.jsonl']) assert.strictEqual(sg.signedRecordKind(p), 'exemptions', p);
  for (const p of ['/r/.tycon/exemptions.jsonl.bak', '/r/exemptions.jsonl', '/r/.tycon/otra.jsonl']) assert.strictEqual(sg.signedRecordKind(p), null, p);
  const r = sg.computeStoryGate({ filePath: '/r/.tycon/exemptions.jsonl', stateDir: '/estado', homeDir: '/casa', repoRoot: '/r', repoHasTycon: true, repoHasStories: true, marker: null, adhoc: null });
  assert.strictEqual(r.action, 'block');
  assert.strictEqual(r.kind, 'exemptions');
  assert.match(sg.blockMessage(r, { filePath: '/r/.tycon/exemptions.jsonl' }), /no se escribe a mano/);
});

test('T6 Consola_ArchivoDeConstancias_NoSeEscribe; leerlo, sí', (t) => {
  const r = repo(t, { [REL]: historia('in-progress'), [EX.RUTA]: constancia('advisors_exempt') });
  const consola = (command) => {
    const env = { ...process.env, HOME: r.home, USERPROFILE: r.home };
    for (const k of Object.keys(env)) if (/^TYCON_|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete env[k];
    return spawnSync(process.execPath, [path.join(SCRIPTS, 'on-bash-write-gate.js')], { cwd: r.dir, env, encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd: r.dir, tool_name: 'Bash', tool_input: { command } }) });
  };
  const fila = '{"story":"9.9","campo":"dod_runtime_exempt"}';
  for (const cmd of [`echo '${fila}' >> .tycon/exemptions.jsonl`, `printf '%s\\n' '${fila}' | tee -a .tycon/exemptions.jsonl`, 'cp /dev/null .tycon/exemptions.jsonl']) {
    const p = consola(cmd);
    assert.strictEqual(p.status, 2, `${cmd}: ${p.stderr}`);
  }
  assert.strictEqual(consola('cat .tycon/exemptions.jsonl').status, 0, 'leerlo pasa');
  // nombrada con una sustitución o con un comodín que la alcanza (pase adversarial de la fila 90)
  for (const cmd of [`echo '${fila}' >> $(echo .tycon)/exemptions.jsonl`, `echo '${fila}' >> .tycon/exempt*.jsonl`,
    `echo '${fila}' >> .tycon/exemptions.json[l]`, `cd .tycon && echo '${fila}' >> exemptions*`]) {
    const p = consola(cmd);
    assert.strictEqual(p.status, 2, `${cmd}: ${p.stderr}`);
  }
  // un comodín que no la alcanza pasa
  assert.strictEqual(consola('echo x >> .tycon/notas-*.txt').status, 0, 'otro archivo de .tycon con comodín');
});

// Pase adversarial de la fila 90: la constancia es de una historia en un archivo, y «ya estaba» es de la misma historia
test('T7 Constancia_DeLaHistoriaYSuArchivo: otro archivo con el mismo número, o un archivo exento que cambia de historia, la piden', (t) => {
  const OTRO = 'specs/story-9.9-otra.md';
  const historiaEn = (id, extra = '') => historia('in-progress', extra).replace('story: "9.9"', `story: "${id}"`);
  // la constancia de la historia en su archivo no le sirve a otro archivo con el mismo número
  const otro = { [REL]: historia('in-progress', exenta('advisors_exempt')), [EX.RUTA]: constancia('advisors_exempt') };
  const a = repo(t, otro, { [OTRO]: historia('in-progress', exenta('advisors_exempt')) });
  assert.strictEqual(preCommit(a).code, 2, 'pre-commit: otro archivo con el mismo número');
  a.git('commit', '-q', '--no-verify', '-m', 'otro');
  assert.ok(reglas(portonCI(a, '--base', a.base).j).includes('exencion-sin-constancia'), 'CI: otro archivo con el mismo número');
  // un archivo exento de antes que pasa a declarar otra historia no le pasa la exención
  const b = repo(t, { [REL]: historia('in-progress', exenta('advisors_exempt')) }, { [REL]: historiaEn('8.5', exenta('advisors_exempt')) });
  assert.strictEqual(preCommit(b).code, 2, 'pre-commit: cambia de historia');
  b.git('commit', '-q', '--no-verify', '-m', 'otra historia');
  assert.ok(reglas(portonCI(b, '--base', b.base).j).includes('exencion-sin-constancia'), 'CI: cambia de historia');
});

test('T8 Renombre_YComentario_NoFrenanDeMas: `git mv` de una exenta de antes, y `story:` con comentario', (t) => {
  // una historia exenta de antes del cambio (sin constancia) se mueve de carpeta: no agrega nada
  const r = repo(t, { [REL]: historia('in-progress', exenta('advisors_exempt')) });
  fs.mkdirSync(path.join(r.dir, 'specs', 'cerradas'), { recursive: true });
  r.git('mv', REL, 'specs/cerradas/story-9.9-algo.md');
  assert.strictEqual(preCommit(r).code, 0, 'pre-commit: git mv');
  r.git('commit', '-q', '--no-verify', '-m', 'mueve');
  assert.ok(!reglas(portonCI(r, '--base', r.base).j).includes('exencion-sin-constancia'), 'CI: git mv');
  // `story: 9.9 # tanda` con su constancia firmada (el gancho anota 9.9): pasa en el commit y en CI
  const conComentario = historia('in-progress', exenta('advisors_exempt')).replace('story: "9.9"', 'story: 9.9 # tanda');
  const c = repo(t, { [REL]: historia('in-progress') }, { [REL]: conComentario, [EX.RUTA]: constancia('advisors_exempt') });
  assert.strictEqual(preCommit(c).code, 0, 'pre-commit: comentario');
  c.git('commit', '-q', '--no-verify', '-m', 'comentario');
  assert.ok(!reglas(portonCI(c, '--base', c.base).j).includes('exencion-sin-constancia'), 'CI: comentario');
});
