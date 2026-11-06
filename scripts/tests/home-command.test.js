#!/usr/bin/env node
/**
 * home-command.test.js — los comandos que imprime el arnés andan en PowerShell.
 *
 * El caso: un dev en Windows copió a PowerShell un comando que le mostró el arnés, «node ~/.claude/…/marker.js …», y
 * node contestó MODULE_NOT_FOUND. PowerShell no expande «~» en los argumentos de un programa; `$HOME` sí, también entre
 * comillas dobles, igual que bash, zsh y Git Bash. Lo que imprime el código dice `node "$HOME/<resto>"`; la única firma
 * de esos comandos (`runtime-waiver`) va con la ruta absoluta, porque la forma de la firma exige palabras literales.
 *
 * T1 compara cada una de las 45 líneas de la lista fija (fixtures/home-command/emissions.json) con el código de su
 * archivo, ruta y argumentos, y mira tres mensajes que se imprimen de verdad; T2 el ayudante; T3 y T4 corren el comando
 * por bash y por PowerShell; T5 el barrido que frena un «node ~/» nuevo; T6 los frenos con la forma nueva.
 *
 * Correr: node --test scripts/tests/home-command.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HC = () => require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'home-command.js'));
const OW = () => require(path.join(ROOT, 'scripts', 'lib', 'owner-window.js'));
const LISTA = require('./fixtures/home-command/emissions.json').emisiones;
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'safety-guard-pre.sh');
const MARKER_REL = '.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js';
const HAS_PWSH = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh'], { encoding: 'utf8' }).status === 0;
// la carpeta absoluta de la forma de firma, en el texto leído del código (donde todavía no hay una carpeta)
const CARPETA = '<carpeta>';

/** El texto viejo de una entrada con su forma nueva: sólo cambia cómo se nombra la carpeta; los argumentos, iguales. */
function nuevo(viejo, forma) {
  // el guion termina en `.js` o `.sh` seguido de un espacio o del final: `${require('./place.js')…}` es parte de la ruta
  const m = /^node ~\/(\S+?\.(?:js|sh))(?=\s|$)(.*)$/s.exec(viejo);
  assert.ok(m, `entrada sin guion: ${viejo}`);
  return `node "${forma === 'firma' ? CARPETA : '$HOME'}/${m[1]}"${m[2]}`;
}

/**
 * El código de un archivo tal como lo imprime: en `.js`, cada `${homeCommand('<ruta>')}` leído como `node "$HOME/<ruta>"`
 * (y `signatureCommand`, con la carpeta); en `.sh` y `.json`, sin los escapes de sus comillas y de `$`.
 */
function leido(archivo) {
  const t = fs.readFileSync(path.join(ROOT, archivo), 'utf8');
  if (archivo.endsWith('.sh')) return t.replace(/\\(["$])/g, '$1');
  if (archivo.endsWith('.json')) return t.replace(/\\"/g, '"');
  return t
    .replace(/\$\{\s*homeCommand\((['"`])(.*?)\1\)\s*\}/g, (_, _q, r) => `node "$HOME/${r}"`)
    .replace(/\$\{\s*signatureCommand\((['"`])(.*?)\1\)\s*\}/g, (_, _q, r) => `node "${CARPETA}/${r}"`);
}

const comentario = (l) => /^\s*(\/\/|\/\*|\*|#)/.test(l);

/**
 * Los comandos nuevos de un texto leído, fuera de los comentarios. Uno cuya ruta es una variable (`$HOME/${r}`) no es un
 * comando que se imprime: es el texto del ayudante que un archivo suelto escribe por su cuenta.
 */
function comandosNuevos(texto) {
  let n = 0;
  for (const l of texto.split('\n')) if (!comentario(l)) n += (l.match(/node "(\$HOME|<carpeta>)\/(?!\$\{)/g) || []).length;
  return n;
}

const EXT = /\.(js|mjs|cjs|sh|json)$/;
/** Los archivos que barre AC 5: código y datos, fuera de las carpetas ocultas, las pruebas y los casos del banco. */
function archivosDe(raiz) {
  const fuera = [];
  const andar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'tests') continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(raiz, p).split(path.sep).join('/');
      if (e.isDirectory()) { if (rel !== 'scripts/controls-bench/cases') andar(p); }
      else if (EXT.test(e.name)) fuera.push(rel);
    }
  };
  andar(raiz);
  return fuera;
}

// un texto que es la ruta de un guion con «~» (`'~/.claude/…/marker.js'`): se interpola después de un `node`
const CONSTANTE_CON_TILDE = /['"`]~\/\.(claude|tycon)\/[^'"`\s]*\.(js|sh)['"`]/;

/** Las líneas con «node ~/» o con una constante con «~», fuera de los comentarios, como `archivo:línea`. */
function barrer(raiz) {
  const malas = [];
  for (const rel of archivosDe(raiz)) {
    fs.readFileSync(path.join(raiz, rel), 'utf8').split('\n').forEach((l, i) => {
      if (!comentario(l) && (l.includes('node ~/') || CONSTANTE_CON_TILDE.test(l))) malas.push(`${rel}:${i + 1}`);
    });
  }
  return malas;
}

// ── T1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 Falla con: una línea de la lista que todavía dice «node ~/», o que cambió algo más que la carpeta (un argumento de
//    menos, una comilla de más), o un archivo con un comando nuevo de más.
test('T1 ComandoImpreso_ConHome_EnLasLineas @story-8.218 @ac-1 — cada una de las 45 líneas con su forma nueva, ruta y argumentos iguales', () => {
  assert.strictEqual(LISTA.length, 45, 'la lista fija tiene las 45 líneas');
  assert.strictEqual(LISTA.filter((e) => e.forma === 'firma').length, 1, 'una sola firma');
  const porArchivo = new Map();
  const faltan = [];
  for (const e of LISTA) {
    porArchivo.set(e.archivo, (porArchivo.get(e.archivo) || 0) + 1);
    if (!leido(e.archivo).includes(nuevo(e.viejo, e.forma))) faltan.push(`${e.archivo} (era la ${e.linea}): ${nuevo(e.viejo, e.forma)}`);
  }
  assert.deepStrictEqual(faltan, [], 'líneas sin su forma nueva');
  for (const [archivo, n] of porArchivo) assert.strictEqual(comandosNuevos(leido(archivo)), n, `${archivo}: comandos nuevos ≠ entradas`);
  assert.deepStrictEqual(barrer(ROOT), [], 'líneas que todavía imprimen «node ~/»');
});

test('T1b ComandoImpreso_MensajesReales @story-8.218 @ac-1 — tres mensajes que se imprimen de verdad dicen node "$HOME/<resto>", con $HOME literal', () => {
  // `.tycon`: el arreglo del enlace viejo de harness-freshness.js
  const fresh = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'harness-freshness.js'));
  const r = fresh.revisar({ stepsDir: path.join(os.tmpdir(), 'no-son-estos'), scriptDir: path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts'), leerEstado: () => ({ status: 'missing' }) });
  assert.match(r.error, /«node "\$HOME\/\.tycon\/harness\/scripts\/setup\/harness\.js" install»/);
  // `.claude`: el aviso de los archivos que entraron después de los revisores
  const post = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'post-revision.js'));
  assert.ok(post.mensaje({ iter: 1, ts: '2026-11-05T12:00:00Z', archivos: ['a.js'] })
    .includes('node "$HOME/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js" smart-reloop --iter 2 --repo . --story <story>'));
  // el cartel del freno, corriendo el gancho: `$HOME` sale escrito, no la carpeta de quien lo corre
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-cmd-'));
  const g = gancho('TYCON_STATUS_GATE=off git status', home);
  assert.strictEqual(g.status, 2, g.stderr);
  assert.ok(g.stderr.includes(`node "$HOME/${MARKER_REL}" update-story-status <ruta de la historia> <estado>`), g.stderr);
  assert.ok(!g.stderr.includes(`${home}/.claude/agent-skills`), 'el cartel expandió $HOME');
});

// ── T2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T2 Ayudante_DevuelveElComandoConHome @story-8.218 @ac-2 — la forma con $HOME y la de firma, que no pone una carpeta peligrosa', () => {
  const { homeCommand, homePath, signatureCommand } = HC();
  assert.strictEqual(homeCommand(MARKER_REL), `node "$HOME/${MARKER_REL}"`);
  assert.strictEqual(homePath(MARKER_REL), `"$HOME/${MARKER_REL}"`, 'la ruta sola, para las constantes');
  assert.strictEqual(homeCommand('.tycon/harness/scripts/setup/harness.js'), 'node "$HOME/.tycon/harness/scripts/setup/harness.js"');
  assert.strictEqual(signatureCommand(MARKER_REL, '/casa/ana'), `node "/casa/ana/${MARKER_REL}"`);
  assert.strictEqual(signatureCommand(MARKER_REL, 'C:\\Users\\Ana Pérez'), `node "C:\\Users\\Ana Pérez/${MARKER_REL}"`);
  assert.strictEqual(signatureCommand(MARKER_REL), `node "${os.homedir()}/${MARKER_REL}"`);
  for (const mala of ['/casa/a"b', '/casa/$x', '/casa/a`b', '/casa/a\nb', '/casa/a\rb']) {
    const c = signatureCommand(MARKER_REL, mala);
    assert.strictEqual(c, `node "$HOME/${MARKER_REL}"`, JSON.stringify(mala));
    assert.ok(!c.includes(mala), JSON.stringify(mala));
  }
});

// ── T3 y T4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Una carpeta de la persona de prueba, con espacio en el nombre, y un guion que imprime «ok» y sus argumentos. */
function casaConGuion() {
  const casa = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'home-cmd-')), 'casa con espacio');
  const rel = '.claude/x/hola.js';
  fs.mkdirSync(path.join(casa, '.claude', 'x'), { recursive: true });
  fs.writeFileSync(path.join(casa, rel), "console.log(['ok', ...process.argv.slice(2)].join(' '));\n");
  return { casa, cmd: `${HC().homeCommand(rel)} uno dos` };
}

test('T3 Bash_HomeConEspacio_EncuentraElGuion @story-8.218 @ac-3 — bash expande $HOME y la ruta con espacio no se parte', () => {
  const { casa, cmd } = casaConGuion();
  const r = spawnSync('bash', ['-c', cmd], { env: { ...process.env, HOME: casa }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'ok uno dos');
});

// Sin pwsh no se mide: se dice NO MEDIDO (no es un verde), y en la CI es rojo, porque sus máquinas lo traen.
test('T4 PowerShell_EncuentraElGuion @story-8.218 @ac-4 — PowerShell expande $HOME en el argumento de node', { skip: !HAS_PWSH && !process.env.CI ? 'NO MEDIDO: esta máquina no tiene pwsh (no es un verde)' : false }, () => {
  assert.ok(HAS_PWSH, 'la CI tiene que traer pwsh: sin él, el comando de PowerShell no se prueba');
  const { casa, cmd } = casaConGuion();
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', cmd], { env: { ...process.env, HOME: casa, USERPROFILE: casa }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'ok uno dos');
});

// ── T5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T5 NodeConTilde_NuevoEnCodigo_Frena @story-8.218 @ac-5 — un «node ~/» o una constante con «~» frena en las cinco extensiones, con archivo y línea; comentarios, pruebas, casos del banco, .md y .toml, no', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'home-cmd-arbol-'));
  const escribir = (rel, t) => { fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true }); fs.writeFileSync(path.join(raiz, rel), t); };
  // frenan: un «node ~/» en un texto, en cada extensión, y una constante con «~» que se interpola después
  escribir('scripts/a.js', "const x = 1;\nconsole.log('corré: node ~/.claude/x/a.js');\n");
  escribir('scripts/b.mjs', "export const t = `node ~/.claude/x/b.js set`;\n");
  escribir('scripts/c.cjs', "module.exports = 'node ~/.tycon/harness/x/c.js';\n");
  escribir('scripts/d.sh', '# node ~/.claude/x/d.sh\necho "node ~/.claude/x/d.js"\n');
  escribir('scripts/e.json', '{ "how": "node ~/.claude/x/e.js set" }\n');
  escribir('scripts/f.js', "const M = '~/.claude/x/m.js';\nconsole.log(`node ${M} clear`);\n");
  // no frenan: comentarios (los dos estilos), una carpeta de pruebas, los casos del banco, una carpeta oculta, y lo que no es código
  escribir('scripts/g.js', "// node ~/.claude/x/g.js lo explica un comentario\n/* node ~/.claude/x/h.js */\n * const M = '~/.claude/x/m.js';\n");
  escribir('scripts/tests/i.test.js', "const dato = 'node ~/.claude/x/i.js';\n");
  escribir('scripts/controls-bench/cases/j.json', '{ "cmd": "node ~/.claude/x/j.js" }\n');
  escribir('.oculta/k.js', "console.log('node ~/.claude/x/k.js');\n");
  escribir('guides/l.md', 'node ~/.claude/x/l.js\n');
  escribir('adapters/codex/m.toml', 'cmd = "node ~/.claude/x/m.js"\n');
  escribir('scripts/n.txt', 'node ~/.claude/x/n.js\n');
  assert.deepStrictEqual(barrer(raiz).sort(), ['scripts/a.js:2', 'scripts/b.mjs:1', 'scripts/c.cjs:1', 'scripts/d.sh:2', 'scripts/e.json:1', 'scripts/f.js:1']);
});

// ── T6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SID = 's-home-cmd';
/** El gancho del freno con ese comando, como lo manda Codex (sin ventana de permiso: lo que frena, niega). */
function gancho(comando, home) {
  const e = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(e)) if (/^TYCON_/.test(k)) delete e[k];
  const r = spawnSync('bash', [HOOK], { input: JSON.stringify({ session_id: SID, tool_use_id: 't1', tool_name: 'Bash', tool_input: { command: comando }, cwd: home, turn_id: 'turn-1' }), env: e, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}
/** Una carpeta de la persona con el marcador de la sesión en ese estado. */
function casaConMarcador(checks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-cmd-'));
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  // stable-data: el gancho da por vencido un marcador viejo; la hora de ahora lo mantiene vivo y no cambia lo que se compara
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({ storyId: '9.9', startedAt: new Date().toISOString(), autonomous: true, checks,
    stepsPending: ['prepare-commit'], stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers'] }));
  return home;
}
const decide = (r) => (r.status === 2 ? `deny:${(/ESC-C\d+/.exec(r.stderr) || [''])[0]}` : 'allow');

test('T6 Firma_FormaNueva_ElFrenoDecideIgual @story-8.218 @ac-6 — la firma sigue siendo firma; los frenos deciden igual con $HOME; ninguna firma impresa usa $HOME', () => {
  const { homeCommand, signatureCommand } = HC();
  // (a) el runtime-waiver impreso, con la ruta absoluta, es la firma runtime-waiver
  for (const casa of [os.homedir(), 'C:\\Users\\Ana Pérez']) {
    const c = OW().canonicaDe(`${signatureCommand(MARKER_REL, casa)} runtime-waiver specs/story-9.9.md`);
    assert.strictEqual(c && c.id, 'runtime-waiver', casa);
  }
  // (b) los frenos deciden igual con «~» y con $HOME
  const viejo = `node ~/${MARKER_REL}`;
  const nuevoCmd = homeCommand(MARKER_REL);
  for (const [checks, espera] of [[{ tests: 'red:exit=1' }, 'deny:ESC-C3'], [{ tests: 'green', advisors: 'green' }, 'allow']]) {
    const sub = ' update-story-status specs/story-9.9.md review';
    const a = decide(gancho(viejo + sub, casaConMarcador(checks)));
    const b = decide(gancho(nuevoCmd + sub, casaConMarcador(checks)));
    assert.strictEqual(a, espera, `forma vieja: ${a}`);
    assert.strictEqual(b, a, 'con $HOME decide distinto');
  }
  const saltear = ' mark-adversarial-skipped --files a.js';
  assert.strictEqual(decide(gancho(nuevoCmd + saltear, casaConMarcador({ tests: 'green' }))), decide(gancho(viejo + saltear, casaConMarcador({ tests: 'green' }))));
  // (c) ningún comando impreso con $HOME sería una firma con «~» en su lugar
  const firmas = [];
  for (const rel of archivosDe(ROOT)) {
    if (!/\.(js|mjs|cjs|sh|json)$/.test(rel)) continue;
    leido(rel).split('\n').forEach((l, i) => {
      if (comentario(l)) return;
      for (const m of l.matchAll(/node "\$HOME\/([^"]+)"([^'"`\n]*)/g)) {
        const comoViejo = `node ~/${m[1]}${m[2]}`.replace(/\$\{[^}]*\}/g, 'x');
        const c = OW().canonicaDe(comoViejo);
        if (c) firmas.push(`${rel}:${i + 1} (${c.id})`);
      }
    });
  }
  assert.deepStrictEqual(firmas, [], 'firmas impresas con $HOME: la forma de la firma no las reconoce');
});

// ── T8 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const LIB = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib');
const PIPELINE_REL = '.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js';
/** El comando de un renglón de un cartel: desde el primer «node "» hasta el final. */
const comandoDe = (texto, sub) => {
  const l = texto.split('\n').find((x) => x.includes('node "') && x.includes(sub));
  assert.ok(l, `el cartel no trae el comando de ${sub}:\n${texto}`);
  return l.slice(l.indexOf('node "')).trim();
};
/**
 * Lo que el cartel imprime como firma: la forma de firma con la carpeta de la persona, y para canonicaDe la misma firma
 * que la forma vieja con «~» (`id` es la familia esperada: `adhoc-lane` cubre también `adhoc-lane:sobre-cupo`).
 */
function esFirma(texto, sub, id) {
  const c = comandoDe(texto, sub);
  const prefijo = `node "${os.homedir()}/${MARKER_REL}" `;
  assert.ok(c.startsWith(prefijo + sub), `${sub}: no es la forma de firma: ${c}`);
  // el hueco entre comillas («"<cita…>"») se completa como lo completa quien lo corre: la palabra que empieza con «<» se
  // lee como una redirección, en las dos formas
  const lleno = (s) => s.replace(/"<[^"]*>"/g, '"x"');
  const nueva = OW().canonicaDe(lleno(c));
  const vieja = OW().canonicaDe(lleno(`node ~/${MARKER_REL} ${c.slice(prefijo.length)}`));
  assert.ok(vieja && vieja.id.split(':')[0] === id, `${sub}: la forma vieja no era la firma ${id}: ${vieja && vieja.id}`);
  assert.strictEqual(nueva && nueva.id, vieja.id, `${sub}: con la ruta absoluta es otra firma (o ninguna): ${c}`);
}

// 🔴 Falla con: una constante que todavía guarda la ruta con «~», un cartel armado con ella que imprime «node ~/», o un
//    cartel de firma que imprime `$HOME` (la forma de la firma no lo reconoce) o deja de ser la misma firma.
test('T8 MensajesConConstante_ConHome_YLasFirmasSiguen @story-8.218 @ac-8 — las constantes con $HOME, los carteles con sus argumentos, y las cinco firmas en forma de firma', () => {
  const gate = require(path.join(LIB, 'story-gate.js'));
  const skillGate = require(path.join(LIB, 'story-skill-gate.js'));
  const save = require(path.join(LIB, 'save-brake.js'));
  // las constantes
  assert.strictEqual(gate.MARKER_JS, `"$HOME/${MARKER_REL}"`);
  assert.strictEqual(gate.MARKER_REL, MARKER_REL);
  assert.strictEqual(skillGate.MARKER_JS, `"$HOME/${MARKER_REL}"`);
  assert.match(fs.readFileSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'on-frontmatter-write.js'), 'utf8'),
    /const marker = homePath\('\.claude\/agent-skills\/skills\/tycon-pipeline\/scripts\/marker\.js'\);/);
  // carteles que no son firma: la forma con $HOME y sus argumentos
  const borrar = gate.markerDeleteMessage(['/r/.claude/.tycon-pipeline/active/s.json'], 'Bash');
  assert.ok(borrar.includes(`node "$HOME/${MARKER_REL}" clear `), borrar);
  const historia = gate.storyByConsoleMessage(['/r/specs/story-9.9.md'], 'Bash');
  assert.ok(historia.includes(`node "$HOME/${MARKER_REL}" update-story-status <ruta de la historia> <estado>`), historia);
  const tablero = gate.blockMessage({ kind: 'state-dir' }, { filePath: '/r/.tycon/state/coordination/tablero.json' });
  assert.ok(tablero.includes('node "$HOME/.tycon/harness/scripts/tools/office/board.js" set T-41'), tablero);
  for (const harness of [true, false]) {
    const faltan = save.textoFaltanRevisoresYPase({ harness, regla: 'r', archivo: 'a.js' });
    assert.ok(faltan.includes(`node "$HOME/${PIPELINE_REL}" advisors --adhoc`), faltan);
    assert.ok(faltan.includes(`node "$HOME/${PIPELINE_REL}" check-count --adhoc`), faltan);
    assert.ok(faltan.includes(`node "$HOME/${MARKER_REL}" mark-adversarial-result <N> --adhoc --result <archivo>`), faltan);
  }
  // las cinco firmas, en los carteles que se imprimen de verdad
  esFirma(gate.textoDelTope({ tocados: 9, cupo: 8 }), 'adhoc set', 'adhoc-lane');
  esFirma(gate.blockMessage({ kind: 'no-lane' }, { filePath: '/r/a.js', repoRoot: '/r' }), 'adhoc set', 'adhoc-lane');
  esFirma(gate.blockMessage({ kind: 'plan' }, { filePath: '/r/a.js', marker: { storyId: '9.9', stepScheme: 2 } }), 'complete-step approve-plan', 'plan-approval');
  const maqueta = save.textoDeLaMaqueta({ pantallas: ['src/p.tsx'], faltan: ['la maqueta'] });
  esFirma(maqueta, 'adhoc set', 'adhoc-lane');
  assert.ok(maqueta.includes('node "$HOME/.claude/agent-skills/skills/tycon-pipeline/scripts/mockup.js" render --data <modelo.json>'), maqueta);
  assert.ok(maqueta.includes(`node "$HOME/${MARKER_REL}" adhoc capture <ruta de la imagen>`), maqueta);
  const textos = save.textoDeLaMaqueta({ pantallas: ['src/p.tsx'], faltan: ['«Hola»'], textosQueFaltan: { total: 1, diferencias: 'd.md' } });
  esFirma(textos, 'adhoc set', 'adhoc-lane');
});

// ── El texto de respaldo de los archivos que corren sin la carpeta de skills ─────────────────────────────────────────
// 🔴 Falla con: un archivo que carga el ayudante «si está» con un texto de respaldo distinto del que da el ayudante: suelto
//    (en el banco, desde la copia fija del instalador) imprimiría otra forma sin que nada avise.
test('T8b RespaldoSinSkills_DiceLoMismoQueElAyudante @story-8.218 @ac-1 — el respaldo de los seis archivos da el mismo comando', () => {
  const { homeCommand } = HC();
  const archivos = ['scripts/hooks/branch-guard-notice.js', 'scripts/hooks/engram-drift-notice.js', 'scripts/setup/harness.js',
    'scripts/setup/harness/questions.js', 'scripts/setup/harness/repoint.js', 'scripts/setup/harness/report.js'];
  for (const rel of archivos) {
    const t = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const m = /const homeCommand = \(\(\) => \{[^\n]*existsSync\(lib\) \? require\(lib\)\.homeCommand : (\(r\) => `[^`]*`); \}\)\(\);/.exec(t);
    assert.ok(m, `${rel}: no encontré el respaldo del ayudante`);
    const respaldo = new Function(`return ${m[1]};`)();
    for (const r of [MARKER_REL, '.tycon/harness/scripts/setup/harness.js']) assert.strictEqual(respaldo(r), homeCommand(r), `${rel}: el respaldo dice otra cosa`);
  }
});
