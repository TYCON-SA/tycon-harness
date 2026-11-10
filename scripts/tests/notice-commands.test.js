'use strict';
/**
 * notice-commands.test.js — los carteles que piden una firma sobre un archivo.
 *
 * Lo que se prueba: las dos formas de firmar (la ventana de permiso y la terminal de la persona) salen de una sola
 * fuente (`owner-window.js`); ningún texto que se imprime escribe a mano un comando de firma; cada forma de cada firma de
 * archivo destraba de verdad su freno en el laboratorio; los subcomandos que nombran los carteles existen; y el banco de
 * controles cuenta cómo frena cada cartel (con un comando, con una acción en llano o sin salida).
 *
 * El laboratorio de las firmas es el de `owner-window.test.js`: la casa de la cuenta, el árbol de procesos, la terminal y
 * la ventana se pasan como parámetros; nada se finge por el ambiente salvo el HOME de los frenos, que anotan con él.
 *
 * stable-data: las constancias de firma vencen a los 30 minutos y los frenos las leen con la hora real, así que se
 * firman con la hora de la corrida; AHORA es una hora fija para lo que no se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const ow = require('../lib/owner-window.js');
const SIG = require('../lib/signatures.js');

const SCRIPTS_PIPE = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts');
const MARKER = path.join(SCRIPTS_PIPE, 'marker.js');
const GUIONES = {
  'marker.js': MARKER,
  'pipeline.js': path.join(SCRIPTS_PIPE, 'pipeline.js'),
  'run-base-controls.sh': path.join(RAIZ, 'scripts', 'ci', 'run-base-controls.sh'),
  'harness.js': path.join(RAIZ, 'scripts', 'setup', 'harness.js'),
};
// `harness.js update` sin argumentos trae y aplica una versión nueva: no es inocuo. Ese guion decide si reconoce un
// subcomando con su tabla cerrada (`parse`), así que se le pregunta a ella, en un proceso aparte, sin correr nada.
const POR_SU_LECTOR = new Set(['harness.js']);
const AHORA = Date.parse('2026-10-27T13:00:00Z');
const INICIO = 'Tue Oct 27 10:00:00 2026';

// Los frenos de escritura anotan con el HOME del proceso: una casa de mentira para ellos, y sin el registro del cierre.
const HOME_DE_LOS_FRENOS = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-commands-home-'));
const HOME_ANTES = process.env.HOME;
process.env.HOME = HOME_DE_LOS_FRENOS;
process.env.TYCON_CLOSURE_RECORD = 'off';
test.after(() => {
  if (HOME_ANTES === undefined) delete process.env.HOME; else process.env.HOME = HOME_ANTES;
  fs.rmSync(HOME_DE_LOS_FRENOS, { recursive: true, force: true });
});

const fw = () => require(path.join(SCRIPTS_PIPE, 'on-frontmatter-write.js'));
const eg = () => require(path.join(SCRIPTS_PIPE, 'on-dod-evidence-guard.js'));
const sio = () => require(path.join(SCRIPTS_PIPE, 'lib', 'story-skill-gate-io.js'));
const rt = () => require(path.join(SCRIPTS_PIPE, 'on-red-test-edit.js'));

/**
 * Un repo con forma de arnés: un control (`scripts/ci/controls-from-base.json`) y su prueba, que ya existía en
 * `origin/main`. `escribir(casa, sesion)` deja el reporte de pruebas de esa sesión con la prueba en rojo y su marcador.
 */
function controlEnRojo(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-commands-rt-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const estado = path.join(base, 'estado');
  for (const d of ['scripts/ci', 'scripts/lib', 'scripts/tests', '.advisors']) fs.mkdirSync(path.join(repo, d), { recursive: true });
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts/ci/controls-from-base.json'), JSON.stringify({ controls: [{ name: 'freno', script: 'scripts/lib/freno.js', rules: [] }] }));
  fs.writeFileSync(path.join(repo, 'scripts/lib/freno.js'), 'module.exports = 1;\n');
  const prueba = path.join(repo, 'scripts', 'tests', 'freno.test.js');
  fs.writeFileSync(prueba, "const F = require('../lib/freno.js');\n");
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const escribir = (casa, s) => {
    fs.writeFileSync(path.join(repo, '.advisors', 'tests-result.json'), JSON.stringify({ by: { session: s }, totals: { failed: 1, failure_entries: [{ raiz: 'arnes', ruta: 'tests/freno.test.js' }] } }));
    fs.writeFileSync(path.join(estado, 'active', `${s}.json`), JSON.stringify({ sessionId: s, storyId: '9.99', repoPath: repo, stepScheme: 2, stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'] }));
    const r = rt().handle({ session_id: s, tool_name: 'Edit', cwd: repo, tool_input: { file_path: prueba, old_string: 'F', new_string: 'G' } }, { stateDir: estado, casa, skillsDir: base });
    return r == null || (r && !r.block) ? true : r.block;
  };
  return { prueba, escribir };
}

// ── el recorrido de los textos impresos ────────────────────────────────────────────────────────────────────────────

/** Un comando de firma escrito a mano: `marker.js sign-file` y, después de un espacio, algo que no sea `:`. */
const LITERAL = /marker\.js sign-file (?!:)\S/;
/** El renglón que describe el comando (`uso: marker.js sign-file <firma> …`) no le pide una firma a nadie. */
const USO = /uso: marker\.js sign-file /;

/** ¿Es un comentario? En un `.js`, el renglón que empieza con `//`, `*` o `/*`; en un `.sh`, con `#`. */
function esComentario(linea, sh) {
  const t = linea.trimStart();
  return sh ? t.startsWith('#') : (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
}

/** Los renglones de `texto` que escriben a mano un comando de firma: `[{ renglon, texto }]`. */
function literalesDeFirma(texto, { sh = false } = {}) {
  const out = [];
  String(texto).split('\n').forEach((linea, i) => {
    if (esComentario(linea, sh)) return;
    if (LITERAL.test(linea) && !USO.test(linea)) out.push({ renglon: i + 1, texto: linea.trim() });
  });
  return out;
}

/** Los archivos que recorre la prueba: los `.js` de los guiones del pipeline (con sus subcarpetas) y los `.js` y `.sh` de los ganchos. */
function archivosDeCarteles() {
  const out = [];
  const caminar = (dir, exts) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') caminar(p, exts); continue; }
      if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  };
  caminar(SCRIPTS_PIPE, ['.js']);
  caminar(path.join(RAIZ, 'scripts', 'hooks'), ['.js', '.sh']);
  return out.sort();
}

/**
 * ¿La mención tiene forma de comando? Sí, salvo que el guion venga después de una palabra de la prosa («no salió
 * pipeline.js de …», «el pipeline.js de main»). Cuenta al principio, después de una comilla, un símbolo o una ruta
 * (`` `marker.js clear` ``, `🚫 marker.js designate-relay:`, `/h/marker.js`), o después de `node`, `bash` o un verbo que
 * pide correrlo («corré», «usá», «con», «pedile»…).
 */
const FORMA_DE_COMANDO = /(^|[^\p{L}\s] *|\b(?:[Cc]orré|[Uu]sá|con|correr|corriendo|[Pp]edí|[Pp]edile|corra|corren|firma|node|bash) )$/u;

/** Los subcomandos que nombran los carteles: `{ guion → Set(subcomando) }`, sacados del mismo recorrido. */
function subcomandosNombrados(archivos) {
  const re = /\b(marker\.js|pipeline\.js|run-base-controls\.sh|harness\.js) ([a-z][a-z0-9-]*)\b/g;
  const out = {};
  for (const f of archivos) {
    const sh = f.endsWith('.sh');
    for (const linea of fs.readFileSync(f, 'utf8').split('\n')) {
      if (esComentario(linea, sh)) continue;
      // un comentario a mitad de renglón (`catch { /* … */ }`) tampoco se le muestra a nadie
      const limpia = sh ? linea : linea.replace(/\/\*.*?\*\//g, '');
      for (const m of limpia.matchAll(re)) {
        if (!FORMA_DE_COMANDO.test(limpia.slice(Math.max(0, m.index - 30), m.index))) continue;
        (out[m[1]] = out[m[1]] || new Set()).add(m[2]);
      }
    }
  }
  return out;
}

// ── el laboratorio de los subcomandos ──────────────────────────────────────────────────────────────────────────────

/** Un ambiente aislado: la HOME vacía y sin la sesión del agente (un subcomando sin argumentos no toca nada de nadie). */
function ambienteAislado(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_CLOSURE_RECORD: 'off' };
  for (const k of Object.keys(env)) if (/SESSION_ID$/.test(k)) delete env[k];
  return env;
}

/** Lo que contesta un guion a un subcomando: el código de salida y el primer renglón, con el subcomando tapado. */
function respuesta(guion, sub, home) {
  const prog = guion.endsWith('.sh') ? 'bash' : process.execPath;
  const args = POR_SU_LECTOR.has(path.basename(guion))
    ? ['-e', 'const r = require(process.argv[1]).parse([process.argv[2]]); if (r && r.error) { console.error(r.error); process.exit(2); }', guion, sub]
    : [guion, sub];
  const r = spawnSync(prog, args, { cwd: home, env: ambienteAislado(home), input: '', encoding: 'utf8', timeout: 30000 });
  if (r.error) return { error: r.error.code || r.error.message };
  const primero = `${r.stdout || ''}${r.stderr || ''}`.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return { status: r.status, primero: primero.split(sub).join('<sub>') };
}

/**
 * Mide un guion: lo calibra con un subcomando inventado y compara cada subcomando nombrado con esa respuesta.
 * `{ estado: 'medido', desconocidos: [...] }` o `{ estado: 'no medido', motivo }` (nunca verde).
 */
function medirSubcomandos(guion, subs) {
  if (!fs.existsSync(guion)) return { estado: 'no medido', motivo: `no está ${guion}` };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-commands-sub-'));
  try {
    const inventado = `zz-no-existe-${process.pid}`;
    const base = respuesta(guion, inventado, home);
    if (base.error) return { estado: 'no medido', motivo: `no pude correrlo (${base.error})` };
    if (base.status === 0) return { estado: 'no medido', motivo: 'contesta 0 a un subcomando inventado: no hay con qué comparar' };
    const desconocidos = [];
    for (const sub of subs) {
      const r = respuesta(guion, sub, home);
      if (r.error) return { estado: 'no medido', motivo: `${sub}: no pude correrlo (${r.error})` };
      if (r.status === base.status && r.primero === base.primero) desconocidos.push(sub);
    }
    return { estado: 'medido', desconocidos };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// ── el laboratorio de las firmas (el molde de owner-window.test.js) ─────────────────────────────────────────────────

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-commands-casa-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: '/r/specs/story-9.99.md' }));
  return casa;
}

const herramienta = { pid: 100, ppid: 1, inicio: INICIO, comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' };
const BASE = [{ pid: 1, ppid: 0, inicio: 'Mon Oct 26 08:00:00 2026', comando: '/sbin/launchd' }];
const envolver = (casa, cmd) => `/bin/zsh -c source ${casa}/.claude/shell-snapshots/snapshot-zsh-1793030721191-z5n7vi.sh 2>/dev/null || true`
  + ' && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true'
  + " && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true"
  + ` && eval '${cmd.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-b725-cwd`;
const arbolDelFreno = () => [...BASE, herramienta,
  { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
  { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
const arbolDelGuion = (casa, cmd) => [...BASE, herramienta,
  { pid: 300, ppid: 100, inicio: INICIO, comando: envolver(casa, cmd) },
  { pid: 301, ppid: 300, inicio: INICIO, comando: cmd }];
const { APPROVERS } = require(path.join(__dirname, '..', 'lib', 'approver.js'));
const pedir = (casa, cmd, ahora) => ow.decidir({
  evento: { session_id: 'ses-a', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } },
  escapes: [], arbol: arbolDelFreno(), pid: 201, casa, ahora, delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }),
  clasificar: () => null, comprobar: () => null, aprobador: () => APPROVERS.maintainers,
});

/** Un repo con una historia en implementación, y la evidencia de la prueba en vivo por escribir. */
function repoNuevo(t) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-commands-repo-'));
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  for (const d of ['.git', 'specs', '.tycon', path.join('.advisors', 'dod-runtime')]) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, '.tycon', 'advisors.yaml'), "stories:\n  id_pattern: '^(?:[A-Z]{1,4}-)?\\d+(?:[.-]\\d+)*$'\n");
  const historia = path.join(r, 'specs', 'story-9.99-x.md');
  fs.writeFileSync(historia, '---\nstory: "9.99"\nepic: "9"\nstatus: in-progress\ntitle: "X"\n---\n# Story 9.99\n');
  return { repo: r, historia };
}

/**
 * La tabla del AC 4: por cada firma de archivo, el archivo que firma y el freno que lo escribe. `escribir(casa, sesion)`
 * devuelve true si el freno dejó pasar la escritura, o el texto con que la negó.
 */
function frenosDeArchivo(t) {
  const { repo, historia } = repoNuevo(t);
  const viejo = fs.readFileSync(historia, 'utf8');
  const ev = (sesion, archivo, content) => ({ session_id: sesion, tool_use_id: 'toolu_w', tool_name: 'Write', cwd: repo, transcript_path: path.join(HOME_DE_LOS_FRENOS, '.claude', 'projects', '-repo', `${sesion}.jsonl`), tool_input: { file_path: archivo, content } });
  const paso = (r) => (r == null || (r && !r.block) ? true : r.block);
  const nueva = path.join(repo, 'specs', 'story-AS-1-pedidos.md');
  const evidencia = path.join(repo, '.advisors', 'dod-runtime', '9.99-20261027.md');
  return [
    ['dod_runtime_exempt', historia, (casa, s) => paso(fw().handle(ev(s, historia, viejo.replace('status: in-progress', 'status: in-progress\ndod_runtime_exempt: true')), { casa }))],
    ['cambiar-el-estado', historia, (casa, s) => paso(fw().handle(ev(s, historia, viejo.replace('status: in-progress', 'status: ready-for-dev')), { casa }))],
    ['ALLOW_DOD_EVIDENCE_WRITE', evidencia, (casa, s) => paso(eg().handle(ev(s, evidencia, '# evidencia\n'), { casa }))],
    ['story-skill-bypass', nueva, (casa, s) => {
      const estado = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-commands-ssg-'));
      t.after(() => fs.rmSync(estado, { recursive: true, force: true }));
      const r = sio().evaluate({ absPath: nueva, content: '---\nstory: "AS-1"\nepic: "pedidos"\nstatus: ready-for-dev\ntitle: "Pedidos"\n---\n# Story AS-1\n',
        sessionId: s, via: 'Write', event: ev(s, nueva, ''), stateDir: estado, casa });
      return r.verdict.action === 'pass' ? true : r.message;
    }],
    (() => { const c = controlEnRojo(t); return ['red-control-test-edit', c.prueba, c.escribir]; })(),
  ];
}

/** El argv de una forma impresa (`marker.js sign-file <firma> <archivo> …`), con la ruta entera del guion. */
function argvDe(forma) {
  const partes = String(forma).split(' ');
  assert.strictEqual(partes[0], 'marker.js', `la forma empieza con el guion: ${forma}`);
  return [MARKER, ...partes.slice(1)];
}

// ── T1 — las dos formas, de una sola fuente ────────────────────────────────────────────────────────────────────────

test('TerminalForm_HasTerminalAndSession (T1) @story-8.165 @ac-1', () => {
  assert.strictEqual(typeof ow.comoSeFirmaEnLaTerminal, 'function', 'owner-window.js exporta la forma de la terminal');
  assert.strictEqual(ow.comoSeFirmaEnLaTerminal('dod_runtime_exempt', '/r/a b.md', 'ses-a'),
    "marker.js sign-file dod_runtime_exempt '/r/a b.md' --terminal --for-session ses-a");
  assert.strictEqual(ow.comoSeFirmaEnLaTerminal('dod_runtime_exempt', '/r/specs/story-9.99.md', 'ses-a'),
    'marker.js sign-file dod_runtime_exempt /r/specs/story-9.99.md --terminal --for-session ses-a');
  // sin sesión no hay forma de la terminal, y se dice por qué
  for (const sin of [null, undefined, '', '_nosession']) {
    assert.strictEqual(ow.comoSeFirmaEnLaTerminal('dod_runtime_exempt', '/r/x.md', sin), null, `sin sesión (${sin}): ninguna forma de terminal`);
  }
  const f = ow.formasDeFirmar('dod_runtime_exempt', '/r/x.md', null);
  assert.strictEqual(f.terminal, null);
  assert.match(f.renglones.join('\n'), /sesión del agente/, 'el cartel sin sesión dice que la terminal necesita la sesión del agente');
  assert.ok(f.renglones.join('\n').includes(ow.comoSeFirma('dod_runtime_exempt', '/r/x.md')), 'y da la forma de la ventana');
  // la forma de la ventana no cambia
  assert.strictEqual(ow.comoSeFirma('dod_runtime_exempt', '/r/specs/story-9.99.md'), 'marker.js sign-file dod_runtime_exempt /r/specs/story-9.99.md');
  // el catálogo da la forma de la terminal de cada firma de archivo con la sesión del agente
  for (const firma of SIG.FIRMAS_DE_ARCHIVO) {
    const s = SIG.SIGNATURES.find((x) => x.id === `escape:${firma}`);
    assert.ok(s, `${firma}: está en el catálogo`);
    assert.match(s.terminal, /--terminal --for-session <sesión del agente>/, `${firma}: la forma de la terminal del catálogo lleva la sesión`);
  }
});

// ── T2 — los carteles dan las dos formas, dichas para quién ────────────────────────────────────────────────────────

test('Notices_GiveBothForms_SaidForWhom (T2) @story-8.165 @ac-2', (t) => {
  const vistas = new Set();
  for (const [firma, archivo, escribir] of frenosDeArchivo(t)) {
    const casa = casaNueva(t);
    const r = escribir(casa, 'ses-a');
    assert.notStrictEqual(r, true, `${firma}: sin constancia frena`);
    const texto = String(r);
    assert.ok(texto.includes(ow.comoSeFirma(firma, archivo)), `${firma}: da la forma de la ventana\n${texto}`);
    assert.ok(texto.includes(ow.comoSeFirmaEnLaTerminal(firma, archivo, 'ses-a')), `${firma}: da la forma de la terminal con la sesión del evento\n${texto}`);
    assert.match(texto, /la ventana[^\n]*la corre el agente/i, `${firma}: dice para quién es la de la ventana`);
    assert.match(texto, /tu terminal/i, `${firma}: dice para quién es la de la terminal`);
    vistas.add(firma);
  }
  assert.deepStrictEqual([...vistas].sort(), ['ALLOW_DOD_EVIDENCE_WRITE', 'cambiar-el-estado', 'dod_runtime_exempt', 'red-control-test-edit', 'story-skill-bypass']);
});

// ── T3 — ningún comando de firma escrito a mano ────────────────────────────────────────────────────────────────────

test('Notices_NoLiteralSignFile (T3) @story-8.165 @ac-3', () => {
  // un cartel de juguete: el literal se ve con su renglón; el comentario, el prefijo con dos puntos y el uso no cuentan
  const juguete = [
    "// marker.js sign-file dod_runtime_exempt x.md — un comentario",
    "  console.error('🔒 marker.js sign-file: sin sesión');",
    "  console.error('corré marker.js sign-file dod_runtime_exempt x.md');",
    '  console.error(`uso: marker.js sign-file <firma> <archivo>`);',
    '   * marker.js sign-file story-skill-bypass <archivo>',
  ].join('\n');
  assert.deepStrictEqual(literalesDeFirma(juguete).map((x) => x.renglon), [3]);
  assert.deepStrictEqual(literalesDeFirma("# marker.js sign-file x a.md\necho \"marker.js sign-file x a.md\"\n", { sh: true }).map((x) => x.renglon), [2]);
  // el arnés: ninguno
  const hallados = [];
  for (const f of archivosDeCarteles()) {
    for (const h of literalesDeFirma(fs.readFileSync(f, 'utf8'), { sh: f.endsWith('.sh') })) hallados.push(`${path.relative(RAIZ, f)}:${h.renglon}: ${h.texto}`);
  }
  assert.deepStrictEqual(hallados, [], `comandos de firma escritos a mano (van por comoSeFirma / comoSeFirmaEnLaTerminal):\n${hallados.join('\n')}`);
});

// ── T4 y T5 — cada forma de cada firma de archivo destraba ─────────────────────────────────────────────────────────

test('EveryFileSignature_TerminalFormUnblocks (T4) @story-8.165 @ac-4', (t) => {
  const filas = frenosDeArchivo(t);
  assert.deepStrictEqual(filas.map(([f]) => f).sort(), [...SIG.FIRMAS_DE_ARCHIVO].sort(), 'cada firma de archivo tiene su renglón en la tabla');
  const tty = { windows: false, hay: () => true, preguntar: () => 'firmo' };
  for (const [firma, archivo, escribir] of filas) {
    const casa = casaNueva(t);
    assert.notStrictEqual(escribir(casa, 'ses-a'), true, `${firma}: antes de firmar, frena`);
    const argv = argvDe(ow.comoSeFirmaEnLaTerminal(firma, archivo, 'ses-a'));
    const e = ow.exigir({ firma: `escape:${firma}`, argv, propia: '_nosession', casa, tty, ahora: Date.now() });
    assert.strictEqual(e.codigo, 0, `${firma}: la terminal firma (${e.motivo})`);
    assert.strictEqual(e.destino, 'ses-a', `${firma}: para la sesión del cartel`);
    ow.firmarArchivo({ firma, via: e.via, sesion: e.destino, archivo, casa, ahora: Date.now() });
    assert.strictEqual(escribir(casa, 'ses-a'), true, `${firma}: con la firma de la terminal, pasa`);
  }
});

test('EveryFileSignature_WindowFormUnblocks (T5) @story-8.165 @ac-4 @ac-9', (t) => {
  for (const [firma, archivo, escribir] of frenosDeArchivo(t)) {
    const casa = casaNueva(t);
    assert.notStrictEqual(escribir(casa, 'ses-a'), true, `${firma}: antes de firmar, frena`);
    const forma = ow.comoSeFirma(firma, archivo);
    const cmd = `node ${MARKER} ${forma.slice('marker.js '.length)}`;
    const ahora = Date.now();
    const r = pedir(casa, cmd, ahora);
    assert.strictEqual(r.decision, 'ask', `${cmd}: ${r.texto}`);
    const e = ow.exigir({ firma: `escape:${firma}`, argv: argvDe(forma), pid: 301, arbol: arbolDelGuion(casa, cmd), casa, ahora, propia: 'ses-a' });
    assert.strictEqual(e.codigo, 0, `${firma}: la ventana firma igual que hoy (${e.motivo})`);
    ow.firmarArchivo({ firma, via: e.via, sesion: 'ses-a', archivo, casa, ahora });
    assert.strictEqual(escribir(casa, 'ses-a'), true, `${firma}: con la firma de la ventana, pasa`);
  }
});

// ── T6 y T7 — los subcomandos nombrados existen; lo que no se puede correr no es verde ─────────────────────────────

test('NamedSubcommands_Recognized (T6) @story-8.165 @ac-5', () => {
  const nombrados = subcomandosNombrados(archivosDeCarteles());
  // el control de la prueba misma: un inventado sale rojo en los cuatro guiones
  for (const [nombre, guion] of Object.entries(GUIONES)) {
    const m = medirSubcomandos(guion, [`zz-otro-inventado-${process.pid}`]);
    assert.strictEqual(m.estado, 'medido', `NO MEDIDO: ${nombre} — ${m.motivo}`);
    assert.strictEqual(m.desconocidos.length, 1, `${nombre}: un subcomando inventado tiene que salir como desconocido`);
  }
  const fallas = [];
  for (const [nombre, subs] of Object.entries(nombrados)) {
    const m = medirSubcomandos(GUIONES[nombre], [...subs].sort());
    if (m.estado !== 'medido') fallas.push(`NO MEDIDO: ${nombre} — ${m.motivo}`);
    else for (const s of m.desconocidos) fallas.push(`${nombre} ${s}: lo nombra un cartel y el guion no lo reconoce`);
  }
  assert.deepStrictEqual(fallas, []);
});

test('UnrunnableScript_NotMeasured (T7) @story-8.165 @ac-8', () => {
  const m = medirSubcomandos(path.join(os.tmpdir(), `no-existe-${process.pid}`, 'guion.js'), ['algo']);
  assert.strictEqual(m.estado, 'no medido');
  assert.match(m.motivo, /no está/);
  // un guion que contesta 0 a cualquier cosa tampoco se puede medir
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-commands-cero-'));
  try {
    const g = path.join(dir, 'siempre-cero.js');
    fs.writeFileSync(g, 'process.exit(0);\n');
    const c = medirSubcomandos(g, ['algo']);
    assert.strictEqual(c.estado, 'no medido');
    assert.match(c.motivo, /contesta 0/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T8 y T9 — el banco cuenta cómo frena cada cartel ───────────────────────────────────────────────────────────────

test('Bench_ClassifiesBlockingNotices (T8) @story-8.165 @ac-6', () => {
  const { clasificarCartel } = require(path.join(RAIZ, 'scripts', 'controls-bench', 'runner.js'));
  assert.strictEqual(typeof clasificarCartel, 'function', 'el banco exporta la clasificación');
  assert.strictEqual(clasificarCartel('Frenado. Corré: node scripts/fix.js apply --all'), 'comando');
  assert.strictEqual(clasificarCartel(`Frenado. ${ow.comoSeFirma('dod_runtime_exempt', '/r/x.md')}`), 'comando');
  // la ruta del guion entre comillas (`node "$HOME/…/marker.js" set-flag …`) también es un comando
  assert.strictEqual(clasificarCartel('Frenado.\n  node "/home/a b/scripts/marker.js" note-red-test --test x'), 'comando');
  assert.strictEqual(clasificarCartel('Frenado.\nPedile a la persona que lo apruebe en la ventana.'), 'llano');
  assert.strictEqual(clasificarCartel('Frenado.\nAlternativa: escribilo con la herramienta de edición.'), 'llano');
  assert.strictEqual(clasificarCartel('No se puede.'), 'callejon');
  assert.strictEqual(clasificarCartel(''), 'callejon');
});

test('Bench_DeadEnd_NamedNotRed (T9) @story-8.165 @ac-6 @ac-7', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-commands-banco-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const casos = path.join(tmp, 'casos');
  fs.mkdirSync(casos);
  const freno = (nombre, cartel) => {
    const p = path.join(tmp, `${nombre}.sh`);
    // el cartel, renglón por renglón (con «%s», un «\n» dentro de las comillas saldría tal cual)
    const renglones = cartel.split('\n').map((l) => `printf '%s\\n' ${JSON.stringify(l)} >&2`).join('\n');
    fs.writeFileSync(p, `#!/usr/bin/env bash\ncat > /dev/null\n${renglones}\nexit 2\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };
  const hook = (script, id) => ({ hook: id, script, event: 'PreToolUse', cases: [{ id, type: 'must-block', stdin: { session_id: 'bench-nc', tool_name: 'Bash', tool_input: { command: 'true' } }, expect: { exit: 2 } }] });
  fs.writeFileSync(path.join(casos, '99-carteles.json'), JSON.stringify({ hooks: [
    hook(freno('con-comando', 'Frenado. Corré: node scripts/arreglo.js aplicar'), 'cartel-con-comando'),
    hook(freno('en-llano', 'Frenado.\nPedile a la persona que lo apruebe.'), 'cartel-en-llano'),
    hook(freno('sin-salida', 'No se puede.'), 'cartel-sin-salida'),
  ] }, null, 2));
  const informe = path.join(tmp, 'informe.json');
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'controls-bench', 'runner.js'), '--tool', 'claude', '--json', informe],
    { env: { ...process.env, TYCON_BENCH_CASES_DIR: casos }, encoding: 'utf8', timeout: 120000 });
  const salida = `${r.stdout}${r.stderr}`;
  assert.strictEqual(r.status, 0, `el banco queda en verde por un callejón sin salida:\n${salida}`);
  assert.match(salida, /callejón sin salida: 99-carteles\.json · cartel-sin-salida/);
  assert.doesNotMatch(salida, /callejón sin salida: 99-carteles\.json · cartel-(con-comando|en-llano)/);
  const rep = JSON.parse(fs.readFileSync(informe, 'utf8'));
  assert.deepStrictEqual(rep.carteles, { comando: 1, llano: 1, callejon: 1 });
});

// ── T10 — la prueba de las rutas enteras sigue igual ───────────────────────────────────────────────────────────────

test('PipelineCommandPaths_StillGreen (T10) @story-8.165 @ac-10', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-commands-paths-'));
  try {
    // sin la marca de proceso hijo de node:test, que haría que la suite de adentro no corra sus pruebas
    const env = { ...process.env, HOME: home };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', path.join(RAIZ, 'scripts', 'tests', 'pipeline-command-paths.test.js')],
      { env, encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    const pasaron = Number((`${r.stdout}`.match(/^ℹ pass (\d+)/m) || [])[1] || 0);
    assert.ok(pasaron > 0, `la suite de las rutas enteras corrió sus pruebas (pasaron ${pasaron}):\n${r.stdout}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

module.exports = { literalesDeFirma, archivosDeCarteles, subcomandosNombrados, medirSubcomandos, AHORA };
