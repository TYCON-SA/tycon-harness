'use strict';
/**
 * save-ok.test.js — la huella de los repos de una corrida, los controles del commit, la foto y la evidencia del pedido,
 * y el aviso por los canales del arnés (`lib/save-ok.js`).
 *
 * En proceso, sobre repos de git descartables con su `origin/main`, y con un canal de mentira para el aviso. La firma de
 * guardar ya no existe: sus renglones viejos y un perfil que todavía la nombra se leen sin error.
 *
 * stable-data: las horas de la corrida son fijas; ninguna se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const SO = require('../lib/save-ok.js');
const CAT = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
const CONFIG = require(path.join(RAIZ, 'scripts', 'lib', 'tycon-config.js'));
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));

const ANTES = '2026-10-29T10:00:00.000Z';
const DESPUES = '2026-10-29T11:00:00.000Z';

function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@p', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@p' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Un repo con `origin/main` en el primer commit y la rama de la story sacada. `archivos`: { ruta: contenido }. */
function repo(t, archivos = { 'LEEME.md': 'hola\n' }) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'save-ok-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  sh(d, 'init', '-q', '-b', 'main');
  for (const [r, c] of Object.entries(archivos)) escribir(d, r, c);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  sh(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  sh(d, 'checkout', '-q', '-b', 'story/la-prueba');
  return d;
}
// cada archivo con la hora fija de antes de la corrida: «el último cambio» no depende del reloj de la máquina
function escribir(d, r, c) {
  const f = path.join(d, r);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, c);
  fs.utimesSync(f, new Date(ANTES), new Date(ANTES));
}

/** La corrida limpia sobre `repos`: preparación cerrada con estas huellas, pruebas y pase después del último cambio. */
function corridaLimpia(repos, extra = {}) {
  return {
    storyId: '9.99', startedAt: ANTES, repoPath: repos[0], storyPath: path.join(repos[0], 'specs', 'story-9.99.md'),
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'prepare-commit'],
    prepareCommitHuellas: SO.huellas(repos),
    checks: { tests: 'green' }, checksProvenance: { tests: 'test-gate' }, checksAt: { tests: DESPUES },
    adversarial: { runId: 'r1', launchedAt: DESPUES, sessionId: 'ses-a' },
    adversarialPasses: [{ ts: DESPUES, tipo: '5b', confirmados: 2, veredicto: 'no-listo' }],
    fileEvents: [{ path: path.join(repos[0], 'LEEME.md'), ts: ANTES, code: true }],
    ...extra,
  };
}
/** ¿El árbol de `repo` sigue siendo el de la huella `antes`? Lo que es papeleo de la huella no lo cambia. */
const misma = (antes, repo) => { const h = SO.huella(repo); return !h.error && h.rama === antes.rama && h.arbol === antes.arbol; };

test('ApproveSave_ForSession_OtraCorrida_Sale2 (T11) @story-8.143 @ac-8', () => {
  const vio = { storyId: '9.99', startedAt: ANTES };
  const r = (corrida) => ow.fijarDestino({ r: { destino: 'ses-a', via: 'delegacion', sesion: 'ses-coord', registro: { corrida: vio } }, propia: 'ses-coord', necesitaMarcador: true, leerMarcador: () => corrida, env: {} });
  assert.strictEqual(r({ storyId: '9.99', startedAt: ANTES }).codigo, 0, 'la misma corrida');
  assert.strictEqual(r({ storyId: '9.100', startedAt: ANTES }).codigo, 2, 'otra story');
  assert.strictEqual(r({ storyId: '9.99', startedAt: DESPUES }).codigo, 2, 'la misma story, cerrada y vuelta a abrir');
  assert.strictEqual(r(null).codigo, 2, 'sin corrida');
});

// 🔴 Falla con: el paso de preparar el commit que vuelve a pedir la constancia del ok, o que deja que un mensaje de otra
// sesión saltee la ventana de permiso.



// ── lo que confirmó el pase adversarial (una prueba por clase; las de dejar pasar algo sensible, primero) ──────────









test('ApproveSave_SpecsYTasks_NoVencenElOk (T26)', (t) => {
  const a = repo(t, { 'LEEME.md': 'hola\n', 'specs/story-9.99.md': '---\nstatus: in-progress\n---\n', 'app.js': '1\n' });
  escribir(a, 'app.js', '2\n');
  const antes = SO.huella(a);
  // el papeleo de la story después del ok: su estado, una tabla de tareas, un dato
  escribir(a, 'specs/story-9.99.md', '---\nstatus: review\n---\n');
  escribir(a, 'tasks/todo.md', '- [x] hecho\n');
  escribir(a, 'specs/qa/9.99-pasos.json', '{}\n');
  escribir(a, 'tasks/medicion.jsonl', '{}\n');
  sh(a, 'add', '-A');
  sh(a, 'commit', '-qm', 'la story y el papeleo');
  assert.strictEqual(misma(antes, a), true);
  // un guion en specs/ o en tasks/ es código: vence el ok
  escribir(a, 'specs/atajo.js', 'module.exports = 1;\n');
  assert.strictEqual(misma(antes, a), false, 'un .js en specs/ es código');
  fs.rmSync(path.join(a, 'specs', 'atajo.js'));
  escribir(a, 'tasks/x.sh', 'echo\n');
  assert.strictEqual(misma(antes, a), false, 'un .sh en tasks/ es código');
  fs.rmSync(path.join(a, 'tasks', 'x.sh'));
  // y el código, como siempre
  escribir(a, 'app.js', '3\n');
  assert.strictEqual(misma(antes, a), false, 'cambiar el código vence el ok');
});


test('ApproveSave_PapeleoQueCargaAlgo_VenceElOk (T28)', (t) => {
  // lo que una herramienta carga o lo que está en la lista sensible, aunque viva en specs/ o tasks/ y sea .json o .md
  const casos = ['specs/.claude/settings.json', 'tasks/hooks.json', 'specs/team-profile.json', 'specs/package.json',
    'tasks/tsconfig.build.json', 'specs/.claude/commands/atajo.md', 'specs/X.MD'];
  for (const f of casos) {
    const a = repo(t);
    const antes = SO.huella(a);
    escribir(a, f, '{"x":1}\n');
    assert.strictEqual(misma(antes, a), false, `${f} vence el ok`);
  }
  // un enlace en specs/ que se reapunta después del ok
  const a = repo(t);
  escribir(a, 'specs/dato.md', 'a\n');
  escribir(a, 'specs/otro.md', 'b\n');
  fs.symlinkSync('dato.md', path.join(a, 'specs', 'enlace.md'));
  const antes = SO.huella(a);
  fs.unlinkSync(path.join(a, 'specs', 'enlace.md'));
  fs.symlinkSync('otro.md', path.join(a, 'specs', 'enlace.md'));
  assert.strictEqual(misma(antes, a), false, 'reapuntar un enlace vence el ok');
});

test('ApproveSave_PapeleoAnidado_NoEsPapeleo (T29)', (t) => {
  // sólo specs/ y tasks/ de la raíz del repo: una carpeta specs/ de otro lado es código
  const a = repo(t);
  const antes = SO.huella(a);
  escribir(a, 'app/specs/datos.json', '{}\n');
  assert.strictEqual(misma(antes, a), false);
});

/** Un `git init` sin ningún commit en una carpeta temporal: el repo de juguete que una corrida usa para medir algo. */
function juguete(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'save-ok-juguete-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  sh(d, 'init', '-q', '-b', 'main');
  escribir(d, 'medir.js', 'module.exports = 1;\n');
  return d;
}

// T30 Firma_RepoSinMedir_FrenaEnTodaVia
// 🔴 Falla con: un ok firmado en la ventana o en la terminal con un repo que no se pudo medir, que después no valida
// nunca, o un motivo que no nombra el repo.

// T31 Repos_GitInitEnCarpetaTemporal_NoEntra
// 🔴 Falla con: el repo de juguete de una carpeta temporal en el ok, sólo porque una edición de la corrida lo tocó; o un
// hermano declarado que queda afuera por vivir en una carpeta temporal.
test('Repos_GitInitEnCarpetaTemporal_NoEntra (T31)', (t) => {
  const a = repo(t, { 'LEEME.md': 'hola\n', 'specs/story-9.99.md': '---\nstory_id: "9.99"\n---\n' });
  const toy = juguete(t);
  const marker = corridaLimpia([a], { fileEvents: [{ path: path.join(a, 'LEEME.md'), ts: ANTES, code: true }, { path: path.join(toy, 'medir.js'), ts: ANTES, code: true }] });
  assert.deepStrictEqual(SO.reposDeLaCorrida({ marker, hermanos: [] }), [a], 'el de la story sí; el de juguete no');
  // un clon o un worktree de un repo real (con `origin`) en una carpeta temporal sí entra: si no, trabajar ahí lo
  // sacaría del control de lo sensible
  const clon = repo(t);
  sh(clon, 'remote', 'add', 'origin', 'https://example.com/acme/harness.git');
  escribir(clon, 'trabajo.js', 'module.exports = 3;\n');
  const conClon = corridaLimpia([a], { fileEvents: [...marker.fileEvents, { path: path.join(clon, 'trabajo.js'), ts: ANTES, code: true }] });
  assert.deepStrictEqual(SO.reposDeLaCorrida({ marker: conClon, hermanos: [] }).sort(), [a, clon].sort(), 'el clon con origin entra');
  // declarado como hermano, entra aunque viva en una carpeta temporal
  const hermano = repo(t);
  escribir(hermano, 'LEEME.md', 'cambiado\n');
  assert.deepStrictEqual(SO.reposDeLaCorrida({ marker, hermanos: [hermano] }).sort(), [a, hermano].sort());
});

// Repos_FallaDeGitEnCarpetaTemporal_Entra
// 🔴 Falla con: un repo de una carpeta temporal que queda fuera del ok porque git no pudo contestar si tiene `origin`
// (salida 128), leído igual que «no tiene origin» (salida 2): ante la duda, el repo entra.
test('Repos_FallaDeGitEnCarpetaTemporal_Entra', { skip: process.platform === 'win32' }, (t) => {
  const a = repo(t, { 'LEEME.md': 'hola\n', 'specs/story-9.99.md': '---\nstory_id: "9.99"\n---\n' });
  const toy = juguete(t);
  const marker = corridaLimpia([a], { fileEvents: [{ path: path.join(a, 'LEEME.md'), ts: ANTES, code: true }, { path: path.join(toy, 'medir.js'), ts: ANTES, code: true }] });
  gitQueFalla(t, 'remote get-url origin ');
  assert.deepStrictEqual(SO.reposDeLaCorrida({ marker, hermanos: [] }).sort(), [a, toy].sort(), 'sin saber si tiene origin, entra');
});

// T32 Ok_NoCubreElRepoTemporal
// 🔴 Falla con: el repo que quedó afuera de la corrida cubierto por su ok: mover el trabajo a una carpeta temporal
// saltearía el ok de guardar. Un commit o un push ahí pide su propio ok.

// T11 Huella_TrozosDeMemoria_SonPapeleo
// 🔴 Falla con: el ok vencido por la memoria que el gancho exporta después del ok (cada commit pediría otro ok), o la
// configuración de la memoria tratada como papeleo (un cambio que carga algo pasaría sin ok).
test('Huella_TrozosDeMemoria_SonPapeleo (T11) @story-8.151 @ac-11', (t) => {
  const a = repo(t, { 'LEEME.md': 'hola\n', '.engram/config.json': '{"project":"acme"}\n', '.engram/chunks/a.jsonl.gz': 'uno' });
  const antes = SO.huella(a);
  escribir(a, '.engram/chunks/a.jsonl.gz', 'dos');
  escribir(a, '.engram/chunks/b.jsonl.gz', 'nuevo');
  assert.strictEqual(misma(antes, a), true, 'un trozo de memoria no cambia la huella');
  // sólo los trozos: otro archivo en la carpeta de los trozos es otra cosa
  escribir(a, '.engram/chunks/c.js', 'module.exports = 1;\n');
  assert.strictEqual(misma(antes, a), false, 'un .js entre los trozos vence el ok');
  fs.rmSync(path.join(a, '.engram', 'chunks', 'c.js'));
  escribir(a, '.engram/config.json', '{"project":"otro"}\n');
  assert.strictEqual(misma(antes, a), false, 'la configuración de la memoria vence el ok');
  assert.ok(SO.esPapeleoDeLaHuella('.engram/chunks/x.jsonl.gz', '100644'));
  assert.ok(!SO.esPapeleoDeLaHuella('.engram/chunks/x.jsonl.gz', '120000'), 'un enlace no es papeleo');
  assert.ok(!SO.esPapeleoDeLaHuella('.engram/config.json', '100644'));
  assert.strictEqual(typeof SO.tieneCambios, 'function', 'tieneCambios se exporta');
});

// Huella_ExencionDeRuntime_EsPapeleo
// 🔴 Falla con: una exención de runtime anotada después de la última vuelta (`.tycon/runtime-waivers.jsonl`) vence el ok
// y pide otra vuelta; o la excepción abre otras carpetas ocultas, otro archivo de `.tycon/` o un enlace.
test('Huella_ExencionDeRuntime_EsPapeleo — la exención anotada tras la última vuelta no pide otra', (t) => {
  const a = repo(t, { 'LEEME.md': 'hola\n', '.tycon/runtime-waivers.jsonl': '' });
  const antes = SO.huella(a);
  escribir(a, '.tycon/runtime-waivers.jsonl', '{"story":"9.99","ac":"AC-3"}\n');
  assert.ok(misma(antes, a), 'la exención no cambia la huella');
  escribir(a, '.tycon/production.json', '{}\n');
  assert.ok(!misma(antes, a), 'otro archivo de .tycon/ sí la cambia');
  assert.ok(SO.esPapeleoDeLaHuella('.tycon/runtime-waivers.jsonl', '100644'));
  assert.ok(!SO.esPapeleoDeLaHuella('.tycon/runtime-waivers.jsonl', '120000'), 'un enlace no es papeleo');
  for (const rel of ['.tycon/runtime-waivers.json', '.tycon/otras.jsonl', 'sub/.tycon/runtime-waivers.jsonl', '.github/runtime-waivers.jsonl', '.tycon/x/runtime-waivers.jsonl']) {
    assert.ok(!SO.esPapeleoDeLaHuella(rel, '100644'), rel);
  }
});

/** El gancho pre-commit del repo, en una carpeta fuera de él (`core.hooksPath` local): `cuerpo` es bash. */
function gancho(t, d, cuerpo) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'save-ok-gancho-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'pre-commit'), `#!/usr/bin/env bash\n${cuerpo}\n`, { mode: 0o755 });
  sh(d, 'config', 'core.hooksPath', dir);
}

// 🔴 Falla con: un control del commit que frena después del ok (el «Sí» se pierde y hay que firmar otra vez), o un
// chequeo que mira el índice de la persona en vez de lo que guardaría el commit (lo sin seguimiento incluido).
test('ControlesDelCommit_UnControlQueFrena_NoSeFirma', (t) => {
  const a = repo(t);
  gancho(t, a, 'if git diff --cached -U0 | grep -q PROHIBIDO; then echo "datos estables: PROHIBIDO en lo que se guarda" >&2; exit 1; fi');
  escribir(a, 'nuevo.js', '// PROHIBIDO\n');            // sin seguimiento: el commit de todo lo lleva
  const indice = fs.readFileSync(path.join(a, '.git', 'index'));
  const frena = SO.controlesDelCommit({ repos: [a] });
  assert.strictEqual(frena.codigo, 2, frena.motivo);
  assert.match(frena.motivo, /los controles del commit[\s\S]*datos estables: PROHIBIDO/);
  assert.deepStrictEqual(fs.readFileSync(path.join(a, '.git', 'index')), indice, 'el índice de la persona no se tocó');
  escribir(a, 'nuevo.js', '// permitido\n');
  const r = SO.controlesDelCommit({ repos: [a] });
  assert.strictEqual(r.codigo, 0, r.motivo);
});

// 🔴 Falla con: un control que escribe en el repo durante el chequeo (el ok nacería vencido), o el aviso de sólo
// lectura que no le llega al gancho.
test('ControlesDelCommit_SoloLectura_YLoQueEscribeNoSeFirma', (t) => {
  const a = repo(t);
  escribir(a, 'LEEME.md', 'cambiado\n');
  gancho(t, a, '[ "${TYCON_PRECOMMIT_READ_ONLY:-}" = 1 ] || { echo regenerado > generado.html; git add generado.html; }');
  const antes = SO.huella(a).arbol;
  let r = SO.controlesDelCommit({ repos: [a] });
  assert.strictEqual(r.codigo, 0, r.motivo);
  assert.ok(!fs.existsSync(path.join(a, 'generado.html')), 'con el aviso de sólo lectura el gancho no escribe');
  assert.strictEqual(SO.huella(a).arbol, antes);
  gancho(t, a, 'echo regenerado > generado.html');
  r = SO.controlesDelCommit({ repos: [a] });
  assert.strictEqual(r.codigo, 2);
  assert.match(r.motivo, /cambiaron el repo \(generado\.html\)/);
});

// 🔴 Falla con: un control colgado tomado por verde, o un repo sin gancho que no se puede firmar.
test('ControlesDelCommit_ColgadoNiega_SinGanchoPasa', (t) => {
  const a = repo(t);
  escribir(a, 'LEEME.md', 'cambiado\n');
  sh(a, 'config', 'core.hooksPath', path.join(a, '.git', 'sin-ganchos'));
  assert.strictEqual(SO.controlesDelCommit({ repos: [a] }).codigo, 0, 'sin gancho no hay nada que frene');
  gancho(t, a, 'sleep 5');
  const r = SO.controlesDelCommit({ repos: [a], timeoutMs: 500 });
  assert.strictEqual(r.codigo, 2);
  assert.match(r.motivo, /no terminaron/);
});

// Las salidas y capturas de una prueba en vivo que el registro (`<clave>-smoke-ledger.jsonl`) nombra con su huella son
// evidencia: la matriz por criterio las exige, y el ok por delegación no puede tomarlas por código.
// 🔴 rojo con el código de antes: un `.png` o un `.txt` en la carpeta de la evidencia era «no es evidencia», y el ok
// de una historia con pruebas en vivo le tocaba siempre a una persona.
test('Evidencia_SalidasYCapturasDelRegistro_SonEvidencia', (t) => {
  const a = repo(t);
  const sha = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const txt = Buffer.from('salida del humo\n');
  escribir(a, '.advisors/dod-runtime/9.99-smoke-captures/20261101T120000-abc123.png', png);
  escribir(a, '.advisors/dod-runtime/9.99-smoke-outputs/20261101T120000-def456.txt', txt);
  escribir(a, '.advisors/dod-runtime/9.99-smoke-ledger.jsonl', `${JSON.stringify({ v: 2, acs: [1], output: '9.99-smoke-outputs/20261101T120000-def456.txt', output_sha: sha(txt), capture: '9.99-smoke-captures/20261101T120000-abc123.png', capture_sha: sha(png) })}\n`);
  for (const f of ['.advisors/dod-runtime/9.99-smoke-captures/20261101T120000-abc123.png', '.advisors/dod-runtime/9.99-smoke-outputs/20261101T120000-def456.txt']) {
    assert.ok(SO.esEvidenciaEnVivo(a, f), `${f}: la anotada es evidencia`);
  }
  // una captura suelta, o una anotada que cambió después de sellarla, no
  escribir(a, '.advisors/dod-runtime/9.99-smoke-captures/suelta.png', png);
  escribir(a, '.advisors/dod-runtime/9.99-smoke-outputs/20261101T120000-def456.txt', 'otra salida\n');
  assert.ok(!SO.esEvidenciaEnVivo(a, '.advisors/dod-runtime/9.99-smoke-captures/suelta.png'), 'la suelta no');
  assert.ok(!SO.esEvidenciaEnVivo(a, '.advisors/dod-runtime/9.99-smoke-outputs/20261101T120000-def456.txt'), 'la cambiada después de sellarla no');
});

// El chequeo previo del ok mira lo preparado cuando la persona preparó algo: un cambio que entra en dos commits se firma
// sin sacar del disco el resto. Sin nada preparado, lo de siempre: lo que guardaría el commit de todo.
// 🔴 rojo con el código de antes: miraba siempre el disco, y el código sin preparar frenaba el ok del primer commit.
test('ControlesDelCommit_ConAlgoPreparado_MiraLoPreparado', (t) => {
  const a = repo(t);
  gancho(t, a, 'if git diff --cached -U0 | grep -q PROHIBIDO; then echo "datos estables: PROHIBIDO en lo que se guarda" >&2; exit 1; fi');
  escribir(a, 'excepcion.json', '{"permitido": true}\n');
  sh(a, 'add', 'excepcion.json');
  escribir(a, 'resto.js', '// PROHIBIDO hasta que entre la excepción\n');   // en el disco, sin preparar
  const indice = fs.readFileSync(path.join(a, '.git', 'index'));
  const r = SO.controlesDelCommit({ repos: [a] });
  assert.strictEqual(r.codigo, 0, r.motivo);
  assert.deepStrictEqual(fs.readFileSync(path.join(a, '.git', 'index')), indice, 'el índice de la persona no se tocó');
  // lo preparado que frena, frena, y el motivo dice que miró lo preparado
  escribir(a, 'excepcion.json', '{"PROHIBIDO": true}\n');
  sh(a, 'add', 'excepcion.json');
  const n = SO.controlesDelCommit({ repos: [a] });
  assert.strictEqual(n.codigo, 2);
  assert.match(n.motivo, /lo preparado/);
});

// ── la foto del pedido y su evidencia ───────────────────────────────────────────────────────────────────────────────

// 🔴 Falla con: la foto del pull request que mira sólo lo preparado (la memoria, que el cierre prepara antes) y deja
// cerrar el paso con código que el commit va a frenar.
test('8.242-FotoDelPedido_ConSoloLaMemoriaPreparada_MiraTodoElDisco @story-8.242 @ac-20', (t) => {
  const a = repo(t);
  gancho(t, a, 'if git diff --cached -U0 | grep -q PROHIBIDO; then echo "datos estables: PROHIBIDO en el código" >&2; exit 1; fi');
  escribir(a, 'a.js', '// PROHIBIDO\n');
  escribir(a, '.engram/manifest.json', '{"chunks":[]}\n');
  sh(a, 'add', '.engram/manifest.json');
  const f = SO.fotoDelPedido({ repos: [a] });
  assert.strictEqual(f.codigo, 2, JSON.stringify(f));
  assert.match(f.motivo, /PROHIBIDO/);
  // la firma de guardar sí mira sólo lo preparado (un cambio que entra en dos commits)
  assert.strictEqual(SO.controlesDelCommit({ repos: [a] }).codigo, 0);
});

// 🔴 Falla con: una foto que no dice en qué commit estaba la rama, y un empuje que no se puede atar a lo preparado.
test('8.242-Huella_DiceElCommitDeLaRama_YElArbolDeUnCommit @story-8.242 @ac-2', (t) => {
  const a = repo(t);
  escribir(a, 'app.js', 'x\n');
  const h = SO.huella(a);
  assert.strictEqual(h.cabeza, sh(a, 'rev-parse', 'HEAD'));
  // el árbol de un commit, sin el papeleo, como la huella: commiteado igual da el mismo
  sh(a, 'add', '-A');
  sh(a, 'commit', '-q', '-m', 'app');
  const c = SO.arbolDelCommit(a, 'HEAD');
  assert.strictEqual(c.arbol, h.arbol);
  assert.strictEqual(c.commit, sh(a, 'rev-parse', 'HEAD'));
  assert.ok(SO.arbolDelCommit(a, 'no-existe').error, 'una rama que no existe no se mide');
});

// 🔴 Falla con: cambiar el estado de la historia en el sprint, la evidencia o la memoria después de preparar el pedido
// vence la foto, y el pedido frena por papeleo que no es código.
/**
 * Un git que falla con 128 («no pude», no «no está») cuando sus argumentos contienen `patron`; para el resto, el de
 * verdad. Vale hasta el final de la prueba.
 */
function gitQueFalla(t, patron) {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-falla-'));
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\ncase " $* " in *"${patron}"*) echo "fatal: falla de prueba" >&2; exit 128;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const antes = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${antes}`;
  t.after(() => { process.env.PATH = antes; fs.rmSync(dir, { recursive: true, force: true }); });
}

// 🔴 Falla con: una falla de git (no «no existe») leída como falta de dato: la foto sale sin `cabeza` y lo que se empuja
// no se compara con ella, o los controles del commit miran el árbol vacío en lugar de frenar.
test('8.242-Rev_FallaDeGit_NoEsFaltaDeDato @story-8.242 @ac-2 @ac-20', { skip: process.platform === 'win32' }, (t) => {
  const a = repo(t);
  escribir(a, 'app.js', 'x\n');
  // lo que el repo no tiene es falta; un repo que git no puede leer no lo es
  assert.strictEqual(SO.arbolDelCommit(a, 'no-existe').falta, true);
  const fuera = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'save-ok-fuera-')));
  t.after(() => fs.rmSync(fuera, { recursive: true, force: true }));
  const r = SO.arbolDelCommit(fuera, 'HEAD');
  assert.ok(r.error, 'fuera de un repo no se mide');
  assert.ok(!r.falta, 'fuera de un repo no es «no existe»');
  gitQueFalla(t, '--verify --quiet HEAD ');
  const h = SO.huella(a);
  assert.ok(h.error, `si no pude leer HEAD, la foto no sale: ${JSON.stringify(h)}`);
  const c = SO.controlesDelCommit({ repos: [a], para: 'pedido' });
  assert.strictEqual(c.codigo, 2, `los controles no miran el árbol vacío: ${JSON.stringify(c)}`);
});

// 🔴 Falla con: la ventana del pull request que muestra «0» de algo que no se midió: un hallazgo con una severidad que
// no es CRITICAL ni WARNING desaparece, y un pase sin su número dice «0 confirmados».
test('8.242-Rev_Evidencia_NoInventaCeros @story-8.242 @ac-3', () => {
  const e = SO.evidenciaDelPedido({ marker: { adversarial: true, adversarialPasses: [{ tipo: '5b' }] }, findings: [{ severity: 'HIGH' }, { severity: 'CRITICAL' }, {}] });
  assert.match(e, /Pase: cerrado, sin el número de confirmados/, e);
  assert.match(e, /Hallazgos: 1 crítico, 0 avisos, 2 sin clasificar/, e);
  const limpio = SO.evidenciaDelPedido({ marker: { adversarial: true, adversarialPasses: [{ tipo: '5b', confirmados: 0 }] }, findings: [] });
  assert.match(limpio, /Pase: cerrado con 0 confirmados · Hallazgos: 0 críticos, 0 avisos$/, limpio);
});

test('8.242-Huella_ElPapeleoNoLaVence (T27) @story-8.242 @ac-19', (t) => {
  const a = repo(t, { 'LEEME.md': 'hola\n', 'specs/sprint-status.yaml': 'x: ready-for-dev\n', 'app.js': '1\n' });
  const antes = SO.huella(a).arbol;
  escribir(a, 'specs/sprint-status.yaml', 'x: review\n');
  escribir(a, '.advisors/dod-runtime/9.99-runtime-matrix.md', '# matriz\n');
  escribir(a, '.engram/chunks/abc.jsonl.gz', 'trozo');
  assert.strictEqual(SO.huella(a).arbol, antes, 'el estado del sprint, la evidencia y la memoria son papeleo');
  // un .yaml que no es el estado del sprint sigue siendo código o configuración
  escribir(a, 'specs/pipeline.yaml', 'trigger: main\n');
  assert.notStrictEqual(SO.huella(a).arbol, antes, 'otro .yaml de specs/ no es papeleo');
  fs.rmSync(path.join(a, 'specs', 'pipeline.yaml'));
  escribir(a, 'sprint-status.yaml', 'x\n');
  assert.notStrictEqual(SO.huella(a).arbol, antes, 'el estado del sprint fuera de specs/ no es papeleo');
  fs.rmSync(path.join(a, 'sprint-status.yaml'));
  escribir(a, 'app.js', '2\n');
  assert.notStrictEqual(SO.huella(a).arbol, antes, 'el código vence la foto');
});

// 🔴 Falla con: una evidencia que inventa un número donde la corrida no midió nada, que no separa los eximidos, o que
// lee los hallazgos sólo como lista.
test('EvidenciaDelPedido_PartesEnOrden_YNoMedido @story-8.242 @ac-3', () => {
  const vacio = SO.evidenciaDelPedido({ marker: { storyId: '9.99' }, findings: null });
  for (const parte of ['Pruebas', 'Revisores', 'Pase', 'Hallazgos']) assert.match(vacio, new RegExp(`${parte}: no medido`), vacio);
  assert.doesNotMatch(vacio, /\d/, `sin números inventados: ${vacio}`);
  const m = corridaLimpia([os.tmpdir()], {
    iterations: { 1: { ts: ANTES }, 2: { ts: DESPUES } },
    stepTimings: { reviewers: { startedAt: ANTES, completedAt: DESPUES } },
  });
  const findings = [
    { rule_id: 'A-C1', severity: 'CRITICAL', disposition: 'waived' },
    { rule_id: 'A-W1', severity: 'WARNING', disposition: 'open' },
    { rule_id: 'A-W2', severity: 'WARNING', disposition: 'fixed' },
  ];
  const e = SO.evidenciaDelPedido({ marker: m, findings });
  const orden = ['Pruebas', 'Revisores', 'Pase', 'Hallazgos'].map((p) => e.indexOf(`${p}:`));
  assert.deepStrictEqual([...orden].sort((x, y) => x - y), orden, `en orden: ${e}`);
  assert.match(e, /Pruebas: en verde \(test-gate\)/);
  assert.match(e, /Revisores: 2 vueltas/);
  assert.match(e, /Pase: cerrado con 2 confirmados/);
  assert.match(e, /Hallazgos: 1 crítico, 2 avisos; eximidos: 1/);
  // el archivo de hallazgos también se escribe como objeto
  assert.strictEqual(SO.evidenciaDelPedido({ marker: m, findings: { findings } }), e);
  // el pase salteado y las pruebas sin verde dicen lo que hay
  const s = SO.evidenciaDelPedido({ marker: { ...m, adversarial: null, adversarialPasses: [], adversarialSkip: { motivo: 'LOW', at: DESPUES }, checks: { tests: 'red' } }, findings: [] });
  assert.match(s, /Pruebas: red/);
  assert.match(s, /Pase: salteado por la regla/);
  assert.match(s, /Hallazgos: 0 críticos, 0 avisos/);
});

// ── La carpeta qa/ al lado de specs/ (8.271) ──────────────────────────────────────────────────────────────────────────
//
// Un repo que tiene `qa/` al lado de `specs/` (qa-dir.js) deja ahí la revisión de la pantalla y la guía del tester. Son
// informes, como la historia: cambiarlos después del ok de guardar no es cambiar el código. Sólo los `.md` hijos
// directos de una carpeta `qa`, con las exclusiones de siempre.

test('Papeleo_QaAlLadoDeSpecs_EsPapeleo @story-8.271 @ac-1', () => {
  assert.ok(SO.esPapeleoDeLaHuella('qa/9.9-legibilidad-ui.md', '100644'));
  assert.ok(SO.esPapeleoDeLaHuella('docs/qa/9.9-guia.md', '100644'));
});

test('Papeleo_QaCodigoOSubcarpetaOEnlace_NoEsPapeleo @story-8.271 @ac-2 @ac-15', () => {
  for (const rel of ['qa/helpers.js', 'qa/datos.json', 'qa/sub/x.md', '.qa/x.md', 'qa/.oculto/x.md']) {
    assert.ok(!SO.esPapeleoDeLaHuella(rel, '100644'), rel);
  }
  assert.ok(!SO.esPapeleoDeLaHuella('qa/x.md', '120000'), 'un enlace no es papeleo');
});

test('Huella_QaLegibilidadUiDespuesDelOk_NoLaVence @story-8.271 @ac-19', (t) => {
  const a = repo(t, { 'specs/story-9.99.md': '# 9.99\n', 'qa/9.99-legibilidad-ui.md': 'antes\n', 'qa/helpers.js': 'module.exports = 1;\n' });
  const antes = SO.huella(a).arbol;
  escribir(a, 'qa/9.99-legibilidad-ui.md', 'después de tocar el File List\n');
  assert.strictEqual(SO.huella(a).arbol, antes, 'la revisión de la pantalla no cambia la huella');
  escribir(a, 'qa/helpers.js', 'module.exports = 2;\n');
  assert.notStrictEqual(SO.huella(a).arbol, antes, 'un .js de qa/ sí la cambia');
});

// ── Los controles del privado con el público de la historia ──────────────────────────────────────────────────────────

/**
 * Un privado adelgazado de juguete que declara su hermano público en `.tycon/advisors.yaml` (`declara`, relativo al
 * privado). Su gancho corre `scripts/x.js` del arnés que le toque, como `harness_dir()`: `TYCON_GUIDES_DIR` si viene y
 * si no el «instalado» de juguete, que no lo trae; y anota qué carpeta usó y si le llegó la variable.
 */
function privadoConGancho(t, { declara = null } = {}) {
  const instalado = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'save-ok-instalado-')));
  t.after(() => fs.rmSync(instalado, { recursive: true, force: true }));
  fs.mkdirSync(path.join(instalado, 'scripts'));
  const priv = repo(t, {
    '.tycon/internal-forms.json': JSON.stringify({ layout: 'thin' }),
    'scripts/ci/overlay-harness.js': '// de juguete\n',
    ...(declara ? { '.tycon/advisors.yaml': `evidence:\n  companion_repos:\n    - ${declara}\n` } : {}),
    'specs/story-9.1-la-prueba.md': '---\nstory: "9.1"\n---\n',
  });
  const anota = path.join(instalado, 'uso.txt');
  gancho(t, priv, `d="\${TYCON_GUIDES_DIR:-${instalado}}"; printf '%s\\n%s\\n' "$d" "\${TYCON_GUIDES_DIR:-sin-variable}" > ${JSON.stringify(anota)}
[ -f "$d/scripts/x.js" ] || { echo "falta scripts/x.js en $d" >&2; exit 1; }`);
  const uso = () => { const [dir, variable] = fs.readFileSync(anota, 'utf8').split('\n'); return { dir, variable }; };
  return { priv, instalado, uso, story: path.join(priv, 'specs', 'story-9.1-la-prueba.md') };
}
/** El público de juguete con `version.json` y `scripts/`; `x` decide si trae el guion nuevo; `rama`, en qué rama queda. */
function publico(t, { x = true, rama = 'story/la-prueba' } = {}) {
  const pub = repo(t, { 'version.json': '{"version":"0.0.0"}\n', 'scripts/viejo.js': '// ya estaba\n', ...(x ? { 'scripts/x.js': '// el guion nuevo del pedido público\n' } : {}) });
  if (rama !== 'story/la-prueba') sh(pub, 'checkout', '-q', rama);
  return pub;
}
// el entorno de la sesión no decide: sin la variable, como en la CI
function sinVariable(t) {
  const antes = process.env.TYCON_GUIDES_DIR;
  delete process.env.TYCON_GUIDES_DIR;
  t.after(() => { if (antes === undefined) delete process.env.TYCON_GUIDES_DIR; else process.env.TYCON_GUIDES_DIR = antes; });
}

// 🔴 Falla con: los controles del privado con el arnés instalado, que no trae el guion nuevo del pedido público
// («Preparar» no cierra hasta el merge público), o la variable puesta también en los repos que no son el privado.
test('SaveOk_PrivateControls_FindScriptInStoryPublic @story-8.277 @ac-13: el gancho del privado corre con el público de la rama de la historia, con la historia y sin ella', (t) => {
  sinVariable(t);
  const pub = publico(t);
  const p = privadoConGancho(t, { declara: `../${path.basename(pub)}` });
  for (const [como, story] of [['con la historia (el ok de guardar)', p.story], ['sin la historia (la foto de «Preparar»)', undefined]]) {
    const r = SO.controlesDelCommit({ repos: [p.priv], story });
    assert.strictEqual(r.codigo, 0, `${como}: ${r.motivo}`);
    assert.strictEqual(p.uso().dir, pub, como);
  }
  // el público mismo, en la misma lista, corre como hoy: sin la variable
  const anota = path.join(p.instalado, 'uso-publico.txt');
  gancho(t, pub, `printf '%s' "\${TYCON_GUIDES_DIR:-sin-variable}" > ${JSON.stringify(anota)}`);
  assert.strictEqual(SO.controlesDelCommit({ repos: [p.priv, pub], story: p.story }).codigo, 0);
  assert.strictEqual(fs.readFileSync(anota, 'utf8'), 'sin-variable');
});

// 🔴 Falla con: tomar un clon del público en otra rama (o el primero que aparezca) como el de la historia, traer de la
// red en medio de los controles, o dejar pasar un guion que el público de la historia no trae.
test('SaveOk_NoCompanionOrMissing_AsToday @story-8.277 @ac-14 @ac-15: sin hermano, con el hermano fuera del disco o en otra rama, el arnés instalado; sin el guion, frena', (t) => {
  sinVariable(t);
  const casos = [
    ['sin hermano declarado', () => privadoConGancho(t)],
    ['el hermano declarado y no en disco', () => privadoConGancho(t, { declara: '../no-existe-este-publico-8277' })],
    ['el hermano en main', () => { const pub = publico(t, { rama: 'main' }); return { ...privadoConGancho(t, { declara: `../${path.basename(pub)}` }), pub }; }],
  ];
  for (const [como, armar] of casos) {
    const p = armar();
    for (const story of [p.story, undefined]) {
      const said = [];
      const write = process.stderr.write;
      process.stderr.write = (s) => { said.push(String(s)); return true; };
      let r;
      try { r = SO.controlesDelCommit({ repos: [p.priv], story }); } finally { process.stderr.write = write; }
      assert.strictEqual(r.codigo, 2, `${como}: frena como hoy, porque el instalado no trae el guion`);
      assert.deepStrictEqual(p.uso(), { dir: p.instalado, variable: 'sin-variable' }, como);
      // el hermano declarado que no está se dice: «no está» no se lee igual que «no hay»
      if (como === 'el hermano declarado y no en disco') assert.match(said.join(''), /el hermano declarado .*no-existe-este-publico-8277.* no está en disco: .*arnés instalado/, como);
    }
    if (p.pub) assert.ok(!fs.existsSync(path.join(p.pub, '.git', 'FETCH_HEAD')), `${como}: nada se trajo de la red`);
  }
  // una búsqueda del público que falla (acá, una historia que no es una ruta) no es «sin hermano»: corre con el
  // instalado, y se dice
  const roto = privadoConGancho(t);
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { said.push(String(s)); return true; };
  try { SO.controlesDelCommit({ repos: [roto.priv], story: 42 }); } finally { process.stderr.write = write; }
  assert.strictEqual(roto.uso().dir, roto.instalado);
  assert.match(said.join(''), /no pude buscar el público de la historia para .*: sus controles corren con el arnés instalado/);
  // el público de la historia sin el guion: frena, y usó ese público
  const pub = publico(t, { x: false });
  const p = privadoConGancho(t, { declara: `../${path.basename(pub)}` });
  const r = SO.controlesDelCommit({ repos: [p.priv], story: p.story });
  assert.strictEqual(r.codigo, 2);
  assert.match(r.motivo, /falta scripts\/x\.js/);
  assert.strictEqual(p.uso().dir, pub);
});

// 🔴 Falla con: la firma de guardar todavía en el código (sus funciones, su guion o su entrada del catálogo), o el aviso
// por los canales del arnés roto al sacarla (lo usa el camino corto).
test('SaveOk_SinFirmaDeGuardar_AvisarSigue (T5) @story-8.283 @ac-9 @ac-10', () => {
  for (const f of ['vigente', 'limpia', 'antesDeFirmar', 'constancia', 'sensibles', 'lineaDelAviso', 'exencionesDeLaCorrida']) {
    assert.strictEqual(SO[f], undefined, `${f} salió con la firma de guardar`);
  }
  assert.ok(!CAT.SIGNATURES.some((s) => s.id === 'save'), 'la firma de guardar no está en el catálogo');
  assert.ok(!CAT.LEVELS.some((l) => l.id === 'save' || l.id === 'save:sensible'), 'ni en la tabla de niveles');
  assert.ok(Array.isArray(CAT.SENSITIVE) && CAT.SENSITIVE.length, 'la lista de lo sensible se queda');
  assert.strictEqual(typeof SO.esSensible, 'function', 'y su lector también');
  // la lectura del código que carga firmas se queda: la usa la cobertura de noche (lib/nightly-coverage.js)
  assert.strictEqual(typeof SO.requiereSensible, 'function', 'requiereSensible se queda');
  assert.ok(Array.isArray(CAT.REQUIERE_SENSIBLE) && CAT.REQUIERE_SENSIBLE.includes('signatures.js'), 'con su lista');
  // el aviso, igual que antes: vale sólo con una entrega real
  const enviados = [];
  const ok = SO.avisar({ texto: 'hola', canales: () => ({ canales: ['telegram'] }), mandar: (o) => { enviados.push(o); return { resultados: [{ canal: 'telegram', entregado: true }] }; } });
  assert.deepStrictEqual(ok, { ok: true, canales: ['telegram'] });
  assert.strictEqual(enviados[0].texto, 'hola');
  assert.strictEqual(enviados[0].lado, 'sesion');
  assert.strictEqual(SO.avisar({ texto: 'x', canales: () => ({ canales: [] }), mandar: () => ({}) }).ok, false, 'sin canales no avisa');
  assert.strictEqual(SO.avisar({ texto: 'x', canales: () => ({ canales: ['telegram'] }), mandar: () => ({ resultados: [{ canal: 'telegram', entregado: false, motivo: 'caído' }] }) }).ok, false, 'sin entrega no vale');
  // en el arnés sólo quedan las aserciones de que el pipeline NO la pide
  // (los nombres armados por partes, para que esta prueba no se encuentre a sí misma)
  const g = spawnSync('git', ['-C', RAIZ, 'grep', '-l', '-e', ['approve', 'save'].join('-'), '-e', ['save', 'check'].join('-')], { encoding: 'utf8' });
  if (g.status === 0 || g.status === 1) {
    const quedan = g.stdout.split('\n').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
    assert.deepStrictEqual(quedan, ['skills/tycon-pipeline/scripts/tests/adhoc-high-risk.test.js', 'skills/tycon-pipeline/scripts/tests/save-brake.test.js'],
      'sólo la nombran las aserciones de que no se pide');
  }
});

// 🔴 Falla con: un renglón viejo de la firma de guardar que rompe al lector, o un perfil que la sigue delegando y deja de
// valer entero (la delegación del plan se caería con ella).
test('Registro_RenglonDeFirmaDeGuardar_SeLee (T6) @story-8.283 @ac-11', (t) => {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'save-ok-retirada-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  fs.mkdirSync(estado, { recursive: true });
  fs.writeFileSync(path.join(estado, 'gates.log'), [
    { ts: '2026-11-01T10:00:00.000Z', name: 'save-signed', status: 'ok', via: 'delegacion', destino: 'ses-a', story: '9.99' },
    { ts: '2026-11-01T09:00:00.000Z', name: 'relay-designation', status: 'ok', sesion: 'ses-coord', rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const { designacionVigente } = require('../lib/critical-waivers.js');
  const d = designacionVigente({ dir: estado });
  assert.ok(d && !d.error && d.sesion === 'ses-coord', 'el registro con el renglón viejo se lee');
  // la lista de firmas con un renglón viejo de guardar
  const SL = require(path.join(RAIZ, 'scripts', 'lib', 'signature-log.js'));
  const firmas = path.join(estado, 'firmas.jsonl');
  fs.writeFileSync(firmas, `${JSON.stringify({ ts: '2026-11-01T10:00:00.000Z', signature: 'save', via: 'delegation', target: 'ses-a', ordered_by: 'ses-coord' })}\n`);
  assert.deepStrictEqual(SL.lastSignatureFor('ses-a', { paths: [firmas], now: Date.parse('2026-11-02T00:00:00.000Z') }), { ts: '2026-11-01T10:00:00.000Z' });
  // el perfil del equipo de hoy: `save` retirada sigue valiendo en las tres listas, sin delegar nada
  assert.strictEqual(CONFIG.validarTipo('firmas', ['plan-approval', 'extra-round', 'save', 'adhoc-lane']), null, 'delegated_signing con save vale');
  assert.strictEqual(CONFIG.validarTipo('firmas-ids', ['critical-waiver', 'save']), null, 'owner_only con save vale');
  assert.strictEqual(CONFIG.validarTipo('niveles', { 'save:sensible': 3, 'plan-approval': 2 }), null, 'levels con save:sensible vale');
  assert.ok(CONFIG.delegaFirma({ approvals: { delegated_signing: ['plan-approval', 'save'] } }, 'plan-approval'), 'plan-approval se sigue delegando');
  assert.ok(!CAT.SIGNATURES.some((s) => s.id === 'save'), 'y ningún freno pide «save»: no delega nada');
  // un id que nunca existió sigue sin valer
  assert.notStrictEqual(CONFIG.validarTipo('firmas', ['no-existe']), null);
});
