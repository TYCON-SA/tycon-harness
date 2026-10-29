'use strict';

/**
 * windows-guided.test.js — los guiones que ensayan el alta y la actualización en Windows SIGUIENDO LA PÁGINA PÚBLICA
 * (`getting-started/windows.md`), comando por comando, y después la capa del equipo.
 *
 * Como las otras suites de esta carpeta, lo que se mide acá NO es Windows: es que los guiones hagan lo que dicen. Lo que
 * no se puede perder:
 *   · la página se lee por su MARCA y cada comando de la ficha (`guided-steps.json`) está escrito, letra por letra, en el
 *     bloque que la persona copia: si la página cambia un comando, esto se pone rojo antes de que el ensayo corra a medias;
 *   · al laboratorio se le cambia UNA cosa de la página (el origen de la API) y el ambiente se arma desde limpio;
 *   · cada comando se juzga por su código de salida y por lo esperado, que es un dato de la ficha;
 *   · la primera sesión espera al trabajo que se desprendió del hook, y sólo por él: una marca vieja no hace esperar;
 *   · los permisos de juguete se buscan en la salida cruda, antes de taparla;
 *   · la foto de una versión bajada no supone un clon de git;
 *   · los dos ensayos eligen por lo que el árbol ES (una copia publicada trae `version.json`), y a una copia publicada que
 *     no trae lo que tiene que traer se le dice «no pude ensayar», nunca «no medido».
 *
 * Rápida: todo es de datos de juguete. Lo que corre el programa de verdad (instalar, la capa del equipo, la máquina que
 * se actualiza sola) va en `windows-guided-lab.test.js`, que tarda minutos.
 *
 * Correr: env -u NODE_TEST_CONTEXT node --test scripts/tests/windows-guided.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'scripts', 'tests', 'windows');
const FIXTURES = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'windows');
// la página pública de instalación: en su lugar (getting-started/windows.md, en el repo público y en el árbol del equipo
// con lo público encima); los papeles viejos del exportador (scripts/publishing/public-files/), sólo si no está ahí
const PAGE_REL = ['getting-started/windows.md', 'scripts/publishing/public-files/getting-started/windows.md'].find((r) => fs.existsSync(path.join(ROOT, r))) || 'getting-started/windows.md';
const PAGE = path.join(ROOT, PAGE_REL);
const PIPELINE = path.join(ROOT, 'pipelines', 'azure-pipelines-windows.yml');
const L = require(path.join(DIR, 'lab.js'));
const T = require(path.join(DIR, 'team-lab.js'));
const F = require(path.join(DIR, 'fire-registered.js'));
const G = require(path.join(DIR, 'guided-page.js'));
const TL = require(path.join(DIR, 'toy-lab.js'));
const RP = require(path.join(DIR, 'release-photo.js'));
const GI = require(path.join(DIR, 'guided-install.js'));
const GU = require(path.join(DIR, 'guided-update.js'));
const rehearse = require(path.join(DIR, 'rehearse.js'));

const fixtureText = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
// una página de juguete: el dato de prueba con el nombre de la carpeta del arnés puesto (va como marcador: ese nombre no se
// escribe en los datos de prueba)
const toyPage = (name) => fixtureText(name).split(G.PLACE_MARK).join(require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js')).PLACE_NAME);
const fixture = (name) => JSON.parse(fixtureText(name));
const clone = (x) => JSON.parse(JSON.stringify(x));
const node = (args, opts = {}) => spawnSync(process.execPath, args, Object.assign({ encoding: 'utf8', timeout: 120000 }, opts));
const tmp = (name) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `windows-guided-${name}-`));
const has = (bin) => L.scanPath(bin).length > 0;
// los repos de juguete se arman sin los hooks de git de quien corre la suite (su carpeta global de hooks no es del juguete)
const NO_HOOKS = path.join(os.tmpdir(), 'windows-guided-no-git-hooks');
const git = (args, cwd) => spawnSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${NO_HOOKS}`, ...args], { cwd, encoding: 'utf8' });
const write = (root, files) => { for (const [rel, text] of Object.entries(files)) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); } };
const bySeverity = (findings) => Object.fromEntries(findings.map((f) => [f.id, f.severity]));
const TOY_NAMES = Object.freeze({ org: 'acme-lab', repo: 'arnes-lab' });
const TOY_REMOTES = '{ "remotes": ["https://github.com/acme-lab/arnes-lab"] }\n';

// ═══ T1 · la página se lee por su marca ════════════════════════════════════════════════════════════════════════

test('GuidedPage_RealPage_BlockIsReadByItsMark', { skip: !fs.existsSync(PAGE) && 'NO MEDIDO — este árbol no trae la página pública de instalación' }, () => {
  const text = fs.readFileSync(PAGE, 'utf8');
  const m = G.loadManifest();
  const block = L.coverBlock(text, m.page.mark, m.page.fence);
  assert.ok(block && block.length > 2000, 'coverBlock devuelve el bloque de la parte 1');
  assert.match(block, /^Necesito instalar en esta máquina el arnés TYCON/, 'empieza donde empieza lo que la persona copia');
  assert.match(block, /^6\. /m, 'entero: llega al último paso');
  assert.doesNotMatch(block, /^8\. /m, 'y son siete: el del permiso de GitHub ya no está');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const open = lines.indexOf('<!-- guided:base -->');
  const close = lines.indexOf('<!-- /guided:base -->');
  assert.deepStrictEqual([lines.filter((l) => l === '<!-- guided:base -->').length, lines.filter((l) => l === '<!-- /guided:base -->').length], [1, 1], 'la marca y su cierre, una vez cada una, solas en su renglón');
  assert.strictEqual((text.match(/guided:base/g) || []).length, 2, 'y en ningún otro lugar de la página');
  // fuera del bloque de código: abre justo antes de la valla y cierra justo después
  assert.deepStrictEqual([lines[open + 1], lines[close - 1]], ['```text', '```']);
  assert.ok(!block.includes('<!--'), 'adentro del bloque que se copia no hay ningún comentario');
  // lo que la persona copia no cambió en ninguna letra: es el primer bloque `text` de la página, con marca o sin ella
  assert.strictEqual(block, /```text\n([\s\S]*?)\n```/.exec(text.replace(/\r\n/g, '\n'))[1]);
  assert.strictEqual(G.readBlock(text, m).block, block);
  // lo que public-papers le exige a la página sigue en su lugar, incluido el que depende de dónde corta un renglón
  for (const literal of ['node v24 (con v22 también anda)', 'quiero el perfil mínimo', '--profile minimal', '.git/hooks/', 'si configura la carpeta global de hooks de git) y preguntame si sigo']) assert.ok(text.includes(literal), `la página sigue diciendo «${literal}»`);
  // una marca repetida, o metida adentro del bloque, no se lee a medias
  assert.match(G.readBlock(text.replace('<!-- /guided:base -->', '<!-- /guided:base -->\n\n<!-- guided:base -->'), m).problem, /guided:base.*más de una vez|una sola vez/);
  assert.match(G.readBlock(text.replace('<!-- guided:base -->\n', ''), m).problem, /guided:base/);
  assert.match(G.readBlock(text.replace('1. Herramientas:', '<!-- guided:base -->\n1. Herramientas:'), m).problem, /guided:base/);
});

// ═══ T2 · la ficha ═════════════════════════════════════════════════════════════════════════════════════════════

// dos sesiones a la vez con settings.json tomado por otro programa: qué rompe, qué pierde un control y qué es ruido
test('GuidedUpdate_TwoSessions_JudgesStartupSettingsFailedAndTemps', () => {
  const ok = { label: 'una', exit: 0, error: null, err: '' };
  const clean = { readable: true, startup: true };
  assert.deepStrictEqual(GU.judgeTwoSessions({ pair: [ok, Object.assign({}, ok, { label: 'otra' })], settings: clean, leftovers: [], failed: null }), []);
  // «interrumpido» se reintenta solo en la sesión siguiente: no es un hallazgo
  assert.deepStrictEqual(GU.judgeTwoSessions({ pair: [ok], settings: clean, failed: { reason: 'interrupted' } }), []);
  const bad = GU.judgeTwoSessions({ pair: [ok, { label: 'otra', exit: 1, error: null, err: 'EPERM: operation not permitted, rename\n' }], settings: { readable: true, startup: false }, leftovers: ['.settings.12.34.tmp'], failed: { reason: 'apply-failed' } });
  assert.deepStrictEqual(bySeverity(bad), { 'two-sessions:startup-failed:otra': 'breaks', 'two-sessions:settings-broken': 'breaks', 'two-sessions:failed-not-retried': 'loses-control', 'two-sessions:temp-left': 'noise' });
  assert.match(bad[0].detail, /otra salió 1 .*EPERM/);
  assert.match(GU.judgeTwoSessions({ pair: [], settings: { readable: false, startup: false } })[0].detail, /no se deja leer/);
  // los temporales que se buscan: los de la línea de arranque y los del aplicador; las copias de respaldo no
  assert.deepStrictEqual(['.settings.12.1700000000000.tmp', 'settings.json.tmp.4242', 'settings.json.bak.20261028-1', 'settings.json'].filter((n) => GU.SETTINGS_TEMP.test(n)), ['.settings.12.1700000000000.tmp', 'settings.json.tmp.4242']);
});

test('GuidedSteps_Manifest_HasItsShape', () => {
  const m = G.loadManifest();
  assert.deepStrictEqual(G.manifestProblems(m), []);
  assert.deepStrictEqual(m.steps.map((s) => s.id), ['tools', 'plan', 'install', 'git-hooks', 'verify', 'report']);
  assert.strictEqual(new Set(m.steps.map((s) => s.id)).size, m.steps.length, 'identificadores únicos');
  for (const s of m.steps) {
    assert.match(s.id, /^[a-z][a-z-]*$/, `${s.id}: en inglés, sin espacios`);
    assert.ok(['machine', 'person'].includes(s.runs), `${s.id}: quién lo hace`);
    if (s.runs === 'person') { assert.ok(s.why && s.why.length > 15, `${s.id}: un paso de la persona dice por qué no se ensaya`); continue; }
    assert.ok(Object.values(T.SEVERITY).includes(s.severity), `${s.id}: la gravedad de que falle`);
    assert.ok(Array.isArray(s.commands) && s.commands.length, `${s.id}: sus comandos`);
    for (const c of s.commands) {
      assert.ok(typeof c.text === 'string' && c.text.trim() === c.text && c.text.length > 3, `${s.id}: el texto del comando, letra por letra`);
      assert.ok(Array.isArray(c.expect), `${s.id}: lo esperado de ESE comando, como dato`);
      for (const e of c.expect) assert.ok(G.KINDS.includes(e.kind), `${s.id}: lo esperado es de un tipo conocido (${e.kind})`);
      if (c.windows_only !== undefined) assert.ok(typeof c.windows_only === 'string' && c.windows_only.length > 10, `${s.id}: «sólo en Windows» lleva su motivo`);
    }
  }
  assert.deepStrictEqual(m.steps.filter((s) => s.runs === 'person').map((s) => s.id), ['report']);
  // la instalación es la línea npx de la página, la misma en el plan y en instalar; el laboratorio
  // declara sus dos cambios: el paquete armado en lugar del publicado, y la respuesta de la persona en el paso install
  const npxOf = (id) => m.steps.find((s) => s.id === id).commands[0].text;
  assert.strictEqual(npxOf('plan'), 'npx @tyconsa/harness@latest --audience me --profile full --integrations none --packs all --dry-run');
  assert.strictEqual(npxOf('install'), 'npx @tyconsa/harness@latest --audience me --profile full --integrations none --packs all');
  assert.ok(npxOf('plan').startsWith(m.lab.package.from) && npxOf('install').startsWith(m.lab.package.from), 'el cambio del paquete calza con los dos');
  assert.match(m.lab.package.to, /\{\{package\}\}/, 'el paquete armado va como marcador');
  assert.deepStrictEqual([m.lab.answer.step, m.lab.answer.append], ['install', '--yes']);
  assert.ok(m.lab.package.why.length > 15 && m.lab.answer.why.length > 15, 'cada cambio dice por qué');
  assert.strictEqual(m.needs.entry_package, 'scripts/setup/npm/package.json');
  // nadie baja ya el guion de entrada en la parte 1: queda a mano, fuera de lo que se ensaya
  for (const s of G.machineSteps(m)) for (const c of s.commands) assert.doesNotMatch(c.text, /get-harness\.ps1|raw\.githubusercontent\.com|api\.github\.com/, `${s.id}: «${c.text}»`);
  // la página baja el guion SIN credencial (el repo de la versión publicada es público): ningún comando de la ficha
  // manda un permiso de GitHub, y la ficha declara que el GitHub de juguete sirve el repo sin permiso
  for (const s of G.machineSteps(m)) for (const c of s.commands) assert.doesNotMatch(c.text, /Authorization|TYCON_GITHUB_TOKEN|Bearer/, `${s.id}: «${c.text}» no lleva credencial`);
  assert.strictEqual(m.lab.auth, 'none', 'el laboratorio sirve el repo como lo supone la página: público');
  assert.deepStrictEqual(G.AUTH_MODES.slice().sort(), ['none', 'token']);
  // la carpeta del arnés dentro de la de Claude Code va como marcador: su nombre lo da place.js, y es el del repo
  // público, que no se escribe en estos guiones
  const doctor = m.steps.find((s) => s.id === 'verify').commands[0].text;
  assert.ok(doctor.includes(`\\.claude\\${G.PLACE_MARK}\\scripts`), `el comando del diagnóstico lleva el marcador: ${doctor}`);
  assert.ok(!JSON.stringify(m).includes(require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js')).PLACE_NAME), 'la ficha no escribe ese nombre');
  assert.ok(G.withNames(doctor, null).includes(require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js')).PLACE_NAME) && !G.withNames(doctor, null).includes(G.PLACE_MARK));
  // el paso de los hooks de git: el primero sale 1 en toda máquina limpia; el segundo va detrás de una condición
  const hooks = m.steps.find((s) => s.id === 'git-hooks').commands;
  assert.deepStrictEqual([hooks[0].ok_exits, hooks[1].run_when, hooks[1].line_prefix], [[0, 1], 'previous-output-empty', 'Si no devuelve nada, corré:  ']);
  // la capa del equipo: dos comandos, con la dirección del repo como único hueco, y el permiso por la entrada estándar
  assert.strictEqual(m.team.commands.length, 2);
  assert.deepStrictEqual(m.team.commands.map((c) => (c.text.match(/<[a-z-]+>/g) || [])), [[], ['<team-url>']]);
  assert.ok(m.team.commands[0].stdin, 'el permiso de Azure no va por argumento');
  assert.ok(m.not_rehearsed.length >= 3 && m.not_rehearsed.every((n) => n.what && n.why), 'lo que el ensayo no corre, con su motivo');
  // una ficha rota se dice, no se usa
  const twice = clone(m); twice.steps.push(clone(twice.steps[0]));
  assert.match(G.manifestProblems(twice).join(' · '), /tools.*repetido/);
  const badKind = clone(m); badKind.steps[0].commands[0].expect = [{ kind: 'looks-fine' }];
  assert.match(G.manifestProblems(badKind).join(' · '), /looks-fine/);
  const noWhy = clone(m); delete noWhy.steps.find((s) => s.id === 'report').why;
  assert.match(G.manifestProblems(noWhy).join(' · '), /report.*motivo/);
  // cómo sirve el repo el GitHub de juguete es un dato de la ficha: sin él, o con un valor que no existe, se dice
  const noAuth = clone(m); delete noAuth.lab.auth;
  assert.match(G.manifestProblems(noAuth).join(' · '), /lab\.auth/);
  const badAuth = clone(m); badAuth.lab.auth = 'private';
  assert.match(G.manifestProblems(badAuth).join(' · '), /lab\.auth.*private/);
  const withToken = clone(m); withToken.lab.auth = 'token';
  assert.deepStrictEqual(G.manifestProblems(withToken), [], 'el otro modo que existe: el repo privado, con su permiso de juguete');
  const badWhen = clone(m); badWhen.steps.find((s) => s.id === 'git-hooks').commands[1].run_when = 'whenever';
  assert.match(G.manifestProblems(badWhen).join(' · '), /whenever/);
  // lo esperado mal escrito se dice ANTES de correr nada: usado así, daría un «sí» vacío o tiraría con la instalación
  // ya hecha (el ensayo a medias que no tiene que pasar)
  const install = (mm) => mm.steps.find((s) => s.id === 'install').commands[0];
  const broken = (change) => { const mm = clone(m); change(mm); return G.manifestProblems(mm).join(' · '); };
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'match', patern: 'versi[oó]n' }]; }), /install/, 'una expresión sin `pattern` calza con todo');
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'match', pattern: 'versi(n: \\S+' }]; }), /install/, 'una expresión que no compila');
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'match', pattern: 'x', flags: 'x' }]; }), /install/, 'opciones que no existen');
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'file', in: 'user', path: 'version.json' }]; }), /install/, 'un archivo en un lugar que no es ni la carpeta de usuario ni la de trabajo');
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'file', in: 'home' }]; }), /install/, 'un archivo sin su ruta');
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'file', in: 'home', path: '/etc/passwd' }]; }), /install/, 'una ruta absoluta');
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'file', in: 'cwd', path: '../afuera/version.json' }]; }), /install/, 'una ruta que sale de la carpeta');
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'equals' }]; }), /install/, 'un valor exacto sin el valor');
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'match', pattern: 'x', in: 'stderr' }]; }), /install/, 'una expresión que dice buscar en un canal que no existe');
  assert.match(broken((mm) => { mm.team.commands[0] = { text: 'harness.js install --yes', stdin: 'el permiso' }; }), /capa del equipo|team|config set/i, 'el permiso por la entrada estándar de un comando que no es el que lo guarda');
  // el control: las formas válidas de cada tipo pasan
  assert.strictEqual(broken((mm) => { install(mm).expect = [{ kind: 'match', pattern: '^versi[oó]n: \\S+', flags: 'im', in: 'any' }, { kind: 'file', in: 'home', path: '.tycon/harness/version.json' }, { kind: 'file', in: 'cwd', path: 'get-harness.ps1' }, { kind: 'min', value: 41, lab_gap: 'el GitHub de juguete no sirve las skills de terceros' }, { kind: 'equals', value: 1 }]; }), '');
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'min', value: 'muchos' }]; }), /install/, 'un mínimo que no es un número');
  assert.match(broken((mm) => { install(mm).expect = [{ kind: 'min', value: 3, lab_gap: '' }]; }), /install/, 'un «no comparable» sin motivo');
  assert.match(broken((mm) => { mm.steps[0].commands[0].notes = [{ id: 'node', pattern: 'v(' }]; }), /tools/, 'una nota con una expresión que no compila');
  // la capa del equipo: exactamente el comando que guarda el permiso (por la entrada estándar) y el que instala
  assert.match(broken((mm) => { mm.team.commands.push({ text: 'harness.js doctor' }); }), /capa del equipo|team/i, 'un tercer comando no se correría: se dice');
  assert.match(broken((mm) => { mm.team.commands.pop(); }), /capa del equipo|team/i);
  assert.match(broken((mm) => { delete mm.team.commands[0].stdin; }), /capa del equipo|team/i, 'sin `stdin`, el permiso no tiene por dónde entrar');
  assert.match(broken((mm) => { mm.team.commands[1].stdin = 'el permiso'; delete mm.team.commands[0].stdin; }), /capa del equipo|team/i, 'el permiso no entra al comando que instala');
  // y se leen por lo que son, no por su lugar: en el otro orden, el permiso sigue yendo al que lo declara
  const swapped = clone(m); swapped.team.commands.reverse();
  assert.deepStrictEqual(G.manifestProblems(swapped), []);
  assert.deepStrictEqual([G.teamCommands(swapped).token.text, G.teamCommands(swapped).install.text], [m.team.commands[0].text, m.team.commands[1].text]);
});

// ═══ T3 · cada comando de la ficha está en el bloque marcado ═══════════════════════════════════════════════════

test('GuidedSteps_EveryCommand_IsInTheMarkedBlock', { skip: !fs.existsSync(PAGE) && 'NO MEDIDO — este árbol no trae la página pública de instalación' }, () => {
  const m = G.loadManifest();
  const block = G.readBlock(fs.readFileSync(PAGE, 'utf8'), m).block;
  // la página en su lugar trae el nombre público ya puesto, el que dice el archivo de los remotos públicos: los
  // marcadores de la ficha se reemplazan con él antes de comparar, como en una copia publicada. Los papeles viejos del
  // exportador traían los marcadores, como la ficha: contra ellos se compara sin reemplazar.
  let names = null;
  if (!PAGE_REL.startsWith('scripts/publishing/')) {
    names = G.namesOf(fs.readFileSync(path.join(ROOT, m.needs.names), 'utf8'));
    assert.strictEqual(names.problem, undefined, `${m.needs.names}: ${names.problem}`);
  }
  const checked = G.checkPage(m, block, { names });
  assert.deepStrictEqual(checked.problems, []);
  assert.strictEqual(checked.ok, true);
  assert.deepStrictEqual([checked.page_steps, checked.manifest_steps], [6, 6], 'la cuenta de pasos numerados del bloque es la de la ficha');
  const lines = block.split('\n');
  for (const s of G.machineSteps(m)) for (const c of s.commands) {
    const said = G.withNames(c.text, names);
    if (c.line_prefix) assert.ok(lines.some((l) => l.trimStart() === `${c.line_prefix}${said}`), `${s.id}: «${said}» es el final de un renglón que empieza con su comienzo`);
    else assert.ok(lines.some((l) => l.trimStart() === said), `${s.id}: «${said}» es un renglón entero del bloque`);
  }
});

test('GuidedPage_NpxOrNpmLineTheManifestDoesNotKnow_IsACommand', () => {
  // npx es el comando principal de la página: uno que la ficha no conoce, sangrado como los que corre el asistente,
  // es un comando (no prosa) y el ensayo lo nombra
  for (const line of ['   npx --yes @otro/paquete --dry-run', '   npm install -g @openai/codex', '      npx @tyconsa/harness@latest --audience me']) assert.strictEqual(G.looksLikeCommand(line), true, `«${line.trim()}» es un comando`);
  for (const line of ['   npx no anda en esta red: pará y avisame', '   npm es un paquete aparte en algunas distribuciones']) assert.strictEqual(G.looksLikeCommand(line), false, `«${line.trim()}» es prosa`);
  if (!fs.existsSync(PAGE)) return;
  const m = G.loadManifest();
  const names = PAGE_REL.startsWith('scripts/publishing/') ? null : G.namesOf(fs.readFileSync(path.join(ROOT, m.needs.names), 'utf8'));
  const lines = G.readBlock(fs.readFileSync(PAGE, 'utf8'), m).block.split('\n');
  const at = lines.findIndex((l) => l.trim() === 'git config --global --get core.hooksPath');
  assert.ok(at > 0, 'el paso de los hooks de git trae su comando');
  lines.splice(at + 1, 0, '   npx --yes @otro/paquete --dry-run');
  const checked = G.checkPage(m, lines.join('\n'), { names });
  assert.strictEqual(checked.ok, false);
  assert.ok(checked.problems.some((p) => /un comando que la ficha no conoce: «npx --yes @otro\/paquete/.test(p.what)), JSON.stringify(checked.problems));
});

// ═══ T4 · la página cambió: se nombra el paso y no se ensaya nada ══════════════════════════════════════════════

test('GuidedSteps_PageChanged_NamesTheStepAndRehearsesNothing', () => {
  const m = G.loadManifest();
  const ok = toyPage('guided-page-ok.md');
  const read = (page) => (rel) => ({ 'getting-started/windows.md': page, 'scripts/setup/npm/package.json': '{ "name": "@tyconsa/harness", "version": "1.0.2" }\n', 'scripts/setup/public-remotes.json': TOY_REMOTES }[rel] || null);
  const fine = G.prepare({ read: read(ok), manifest: m });
  assert.strictEqual(fine.problem, undefined, fine.problem);
  assert.deepStrictEqual([fine.names, fine.page_name_from], [TOY_NAMES, 'scripts/setup/public-remotes.json']);
  // un comando cambiado
  const changed = G.prepare({ read: read(toyPage('guided-page-changed.md')), manifest: m });
  assert.match(changed.problem, /install/, 'dice el identificador del paso');
  assert.match(changed.problem, /--packs all/, 'y lo que faltó');
  assert.strictEqual(changed.block, undefined, 'no devuelve con qué ensayar: nunca a medias');
  // un paso de más: las dos cuentas
  const extra = G.prepare({ read: read(ok.replace('\nPara trabajar con BIZUIT Extensions', '\n7. Un paso nuevo que la ficha no conoce.\n\nPara trabajar con BIZUIT Extensions')), manifest: m });
  assert.match(extra.problem, /7 .*6|6 .*7/);
  // la página de ANTES (con la bajada del guion de entrada como paso propio) contra la ficha actual: no
  // calza, y no se ensaya nada. Es lo que pasa si la página y la ficha no cambian juntas
  const pageBefore = ok
    .replace('2. Ver el plan', '2. Bajar el guion de instalación: dame estas dos líneas.\n       Invoke-WebRequest -OutFile get-harness.ps1 https://raw.githubusercontent.com/acme-lab/arnes-lab/main/scripts/setup/get-harness.ps1\n\n3. Ver el plan');
  const before = G.prepare({ read: read(pageBefore), manifest: m });
  assert.match(before.problem, /7 pasos numerados y la ficha 6/, 'un paso de más');
  assert.strictEqual(before.block, undefined);
  // el comienzo del renglón que precede al comando condicional ya no está
  const prefix = G.prepare({ read: read(ok.replace('Si no devuelve nada, corré:  git config', 'Si está vacío:  git config')), manifest: m });
  assert.match(prefix.problem, /git-hooks/);
  assert.match(prefix.problem, /Si no devuelve nada, corré:/);
  // con otra organización en sus nombres, calza igual: la línea npx no nombra el repo; el nombre sólo dice
  // qué sirve el GitHub de juguete
  const other = G.prepare({ read: (rel) => (rel === 'scripts/setup/public-remotes.json' ? '{ "remotes": ["https://github.com/otra-org/otro-repo"] }' : read(ok)(rel)), manifest: m });
  assert.strictEqual(other.problem, undefined, other.problem);
  assert.deepStrictEqual(other.names, { org: 'otra-org', repo: 'otro-repo' });
  // sin el paquete de npm en el árbol que se ensaya no hay con qué armar la línea: se dice, no se ensaya a medias
  const noPackage = G.prepare({ read: (rel) => (rel === 'scripts/setup/npm/package.json' ? null : read(ok)(rel)), manifest: m });
  assert.match(noPackage.problem, /scripts\/setup\/npm\/package\.json/);

  // ── la comprobación va en los dos sentidos: lo que la PÁGINA trae y la ficha no conoce también frena ──
  const lines = ok.split('\n');
  const at = (needle) => { const i = lines.findIndex((l) => l.includes(needle)); assert.ok(i >= 0, `la página de juguete trae «${needle}»`); return i; };
  const withLine = (needle, extra, where = 'before') => { const out = lines.slice(); out.splice(at(needle) + (where === 'after' ? 1 : 0), 0, extra); return out.join('\n'); };
  // un comando agregado a un paso de la máquina: sin esto el ensayo «seguiría la página» corriendo menos de lo que manda
  const added = G.prepare({ read: read(withLine('@(Get-ChildItem', '   node "$env:USERPROFILE\\.claude\\otro.js" --parity')), manifest: m });
  assert.match(added.problem, /verify/, 'nombra el paso');
  assert.match(added.problem, /otro\.js/, 'y el comando que la ficha no conoce');
  // (la línea de instalar es la npx que termina en «--packs all»; la del plan sigue con --dry-run)
  const installAt = () => { const i = lines.findIndex((l) => l.trimEnd().endsWith('--integrations none --packs all')); assert.ok(i >= 0, 'la página de juguete trae la línea npx de instalar'); return i; };
  const afterInstall = lines.slice(); afterInstall.splice(installAt() + 1, 0, '       pwsh -File get-harness.ps1 -- repair --yes');
  const repair = G.prepare({ read: read(afterInstall.join('\n')), manifest: m });
  assert.match(repair.problem, /install/);
  assert.match(repair.problem, /repair --yes/);
  // el comando real cambió y el viejo quedó citado en otro paso: está «en la página», pero no donde se corre
  const moved = lines.slice();
  const real = installAt();
  const old = moved[real];
  moved[real] = `${old.trimEnd()} --integrations-all`;
  moved.splice(at('@(Get-ChildItem'), 0, old);
  const cited = G.prepare({ read: read(moved.join('\n')), manifest: m });
  assert.match(cited.problem, /install/);
  // la prosa de un paso no es un comando: un párrafo nuevo no frena
  const prose = G.prepare({ read: read(withLine('@(Get-ChildItem', '   Mostrale a la persona el resultado y seguí con el paso que sigue.')), manifest: m });
  assert.strictEqual(prose.problem, undefined, prose.problem);
  // ── y el orden: el ensayo corre en el orden de la ficha, que tiene que ser el de la página ──
  const block = G.readBlock(ok, m).block;
  const flipped = clone(m);
  const hooks = flipped.steps.find((s) => s.id === 'verify').commands;
  hooks.reverse();
  const order = G.checkPage(flipped, block, { names: TOY_NAMES });
  assert.strictEqual(order.ok, false, 'los comandos de un paso, en otro orden que en la página');
  assert.match(order.problems.map((p) => `${p.step}: ${p.what}`).join(' · '), /verify.*orden/);
  // dos pasos intercambiados en la ficha: cada comando queda fuera del paso que es el suyo
  const swappedSteps = clone(m);
  const [a, b] = ['plan', 'install'].map((id) => swappedSteps.steps.findIndex((s) => s.id === id));
  [swappedSteps.steps[a], swappedSteps.steps[b]] = [swappedSteps.steps[b], swappedSteps.steps[a]];
  const out = G.checkPage(swappedSteps, block, { names: TOY_NAMES });
  assert.strictEqual(out.ok, false);
  assert.match(out.problems.map((p) => `${p.step}: ${p.what}`).join(' · '), /fuera del paso/);
  // ── qué renglón del bloque cuenta como comando: cada forma, con su caso (la sangría es la de la página)
  const COMMANDS = [
    '       pwsh -File get-harness.ps1 -- --yes',                                   // sangrado como lo que la persona pega en su ventana
    '       cualquier cosa con esa sangría',                                        // ahí no hay prosa: todo cuenta
    '   $PSVersionTable.PSVersion.ToString(); node --version',                      // una variable
    '   @(Get-ChildItem "$env:USERPROFILE\\.claude\\skills" -Directory).Count',     // un arreglo
    '   (Select-String -Path "x" -Pattern "README.md").Count',                      // un cmdlet entre paréntesis
    '   Get-Content get-harness.ps1',                                               // un cmdlet
    '   git config --global --get core.hooksPath',                                  // un programa con su subcomando y sus opciones
    '   node "$env:USERPROFILE\\.claude\\x.js" doctor',                             // un programa con una ruta entre comillas
    '   winget install --id Microsoft.PowerShell',
  ];
  const PROSE = [
    '', '   ', 'Sin sangría: $esto no es un comando del bloque', '1. Herramientas:',
    '   Esperado: PowerShell 7.algo, node v22 o más y tar (viene con Windows 10 y posteriores).',
    '   Con mi sí, primero mirá si ya tengo algo configurado:',
    '   Si devuelve otra carpeta, NO la pises: mostrámela y decidimos.',
    '   instale yo, de a uno:  winget install Microsoft.PowerShell · winget install OpenJS.NodeJS.LTS',
    '   git NO hace falta: el arnés se baja como archivos, no se clona.',
    '   node v22 o más es lo que pide la página',
  ];
  for (const line of COMMANDS) assert.strictEqual(G.looksLikeCommand(line), true, `es un comando: «${line}»`);
  for (const line of PROSE) assert.strictEqual(G.looksLikeCommand(line), false, `no es un comando: «${line}»`);
});

// ═══ T5 · los nombres y los cambios del laboratorio son las únicas diferencias ═════════════════════════════════

test('GuidedPage_NamesAndLabChanges_AreTheOnlyDifferences', () => {
  const m = G.loadManifest();
  const names = G.namesOf(TOY_REMOTES);
  assert.deepStrictEqual(names, TOY_NAMES);
  assert.match(G.namesOf('{ "remotes": [] }').problem, /remotes/);
  assert.match(G.namesOf('no es json').problem, /JSON/);
  const block = G.readBlock(toyPage('guided-page-ok.md'), m).block;
  assert.strictEqual(G.checkPage(m, block, { names }).ok, true, 'con los nombres, calza');
  // en el laboratorio cambian dos cosas, y sólo en los renglones que las traen: el paquete publicado
  // por el armado, en el plan y en instalar; y la respuesta de la persona («s»), sumada al final de instalar
  const api = 'http://127.0.0.1:4455';
  const pkg = '/lab/guided/onboarding/package/tyconsa-harness-1.0.2.tgz';
  const changed = [];
  for (const s of G.machineSteps(m)) for (const [i, c] of s.commands.entries()) {
    const real = G.withNames(c.text, names);
    const lab = G.labText(real, m, { pkg, step: s.id });
    if (lab.changed) {
      changed.push(`${s.id}[${i}]${lab.answer ? '+answer' : ''}`);
      assert.strictEqual(lab.text, `${real.replace('npx @tyconsa/harness@latest', `npx --yes "file:${pkg}"`)}${s.id === 'install' ? ' --yes' : ''}`);
      assert.deepStrictEqual([lab.from, lab.to], ['npx @tyconsa/harness@latest', `npx --yes "file:${pkg}"`]);
    } else assert.strictEqual(lab.text, real, `${s.id}: ningún otro carácter se toca`);
  }
  assert.deepStrictEqual(changed, ['plan[0]', 'install[0]+answer']);
  // sin el paquete armado, el laboratorio no sustituye nada: correría el publicado, y eso no es ensayar el commit
  assert.strictEqual(G.labText(G.withNames(m.steps.find((s) => s.id === 'plan').commands[0].text, names), m, { pkg: null, step: 'plan' }).changed, false);
  // el ambiente de la variante se arma desde limpio: de quien lanza no llega ninguna variable del arnés ni de sus herramientas
  // (la carpeta de quien lanza, armada por partes: escrita entera tiene forma de carpeta de usuario, y eso no se escribe)
  const launcher = path.join(os.tmpdir(), 'windows-guided-who-launches');
  const base = { PATH: process.env.PATH || '', HOME: launcher, KEEP_ME: '1', TYCON_CODEX: '1', TYCON_HOME: path.join(launcher, 'own'), CODEX_HOME: path.join(launcher, 'codex'), CLAUDE_MD_PATH: path.join(launcher, 'CLAUDE.md'), CLAUDE_CONFIG_DIR: path.join(launcher, 'config'), TYCON_UPDATE_APPLY: 'auto', TYCON_STARTUP_DETACH: '0' };
  const home = path.join(os.tmpdir(), 'windows-guided-lab-home');
  const v = TL.variantEnv(home, { base, api, detectPath: '/nowhere', platform: 'linux' });
  for (const k of ['TYCON_CODEX', 'TYCON_HOME', 'CODEX_HOME', 'CLAUDE_MD_PATH', 'CLAUDE_CONFIG_DIR', 'TYCON_UPDATE_APPLY', 'TYCON_STARTUP_DETACH']) assert.ok(!(k in v.env), `${k} de quien lanza no llega a la variante`);
  // tampoco las variables con que git ubica su configuración: con ellas, el paso de los hooks de git de la página
  // (`git config --global`) escribiría en la configuración REAL de quien lanza
  const gitVars = { GIT_CONFIG_GLOBAL: path.join(launcher, 'gitconfig'), GIT_CONFIG_SYSTEM: path.join(launcher, 'system'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(launcher, 'hooks'), GIT_CONFIG_PARAMETERS: "'core.hooksPath=x'", XDG_CONFIG_HOME: path.join(launcher, 'xdg') };
  const withGit = TL.variantEnv(home, { base: Object.assign({}, base, gitVars), api, detectPath: '/nowhere', platform: 'linux' });
  for (const k of Object.keys(gitVars)) {
    assert.ok(withGit.env[k] !== gitVars[k], `${k} de quien lanza no llega a la variante`);
    assert.ok(withGit.lab_changes.env_removed.includes(k) || k in withGit.lab_changes.always || k in withGit.lab_changes.env_set, `${k}: queda dicho que se borró, o con qué valor del laboratorio se puso`);
  }
  assert.ok(!Object.values(withGit.env).some((val) => String(val).startsWith(launcher) && val !== base.HOME), 'ninguna ruta de quien lanza queda en el ambiente de la variante');
  // y el git del propio laboratorio: lo mismo
  const labGit = TL.cleanBase(Object.assign({}, base, gitVars));
  for (const k of Object.keys(gitVars)) assert.ok(!(k in labGit.env) && labGit.removed.includes(k), `${k} no llega al git del laboratorio`);
  // ni las del proxy: el cliente del arnés no exceptúa 127.0.0.1, y con un proxy de quien lanza los pedidos al GitHub
  // de juguete (con su permiso y el nombre del repo) saldrían hacia el proxy de verdad
  const proxyVars = { HTTP_PROXY: 'http://proxy.example:3128', HTTPS_PROXY: 'http://proxy.example:3128', https_proxy: 'http://proxy.example:3128', ALL_PROXY: 'socks5://proxy.example:1080', NO_PROXY: 'internal.example' };
  const withProxy = TL.variantEnv(home, { base: Object.assign({}, base, proxyVars), api, detectPath: '/nowhere', platform: 'linux' });
  for (const k of Object.keys(proxyVars)) assert.ok(!(k in withProxy.env) && withProxy.lab_changes.env_removed.includes(k), `${k} de quien lanza no llega a la variante, y queda dicho`);
  assert.ok(!JSON.stringify(TL.cleanBase(Object.assign({}, base, proxyVars)).env).includes('proxy.example'), 'ni al git del laboratorio');
  // las de npm tampoco: el instalador del paquete las lee como proxy, y la línea npx corre con ellas
  const npmProxyVars = { npm_config_proxy: 'http://proxy.example:3128', npm_config_https_proxy: 'http://proxy.example:3128', NPM_CONFIG_HTTPS_PROXY: 'http://proxy.example:3128', npm_config_noproxy: 'internal.example' };
  const withNpmProxy = TL.variantEnv(home, { base: Object.assign({}, base, npmProxyVars), api, detectPath: '/nowhere', platform: 'linux' });
  for (const k of Object.keys(npmProxyVars)) assert.ok(!(k in withNpmProxy.env) && withNpmProxy.lab_changes.env_removed.includes(k), `${k} de quien lanza no llega a la variante, y queda dicho`);
  assert.ok(!JSON.stringify(TL.cleanBase(Object.assign({}, base, npmProxyVars)).env).includes('proxy.example'), 'ni al git del laboratorio');
  // la línea npx corre con TODAS las rutas públicas en el GitHub de juguete: con git puesto y el crudo sin poner, el
  // cliente del arnés completa el crudo con el de verdad y el ensayo sale a la red
  const routes = GI.npxEnv({ KEEP_ME: '1' }, { git: 'http://127.0.0.1:4456', archive: 'http://127.0.0.1:4457', raw: 'http://127.0.0.1:4458', dir: path.join(os.tmpdir(), 'windows-guided-npx') });
  assert.deepStrictEqual([routes.TYCON_RELEASE_GIT, routes.TYCON_RELEASE_ARCHIVE, routes.TYCON_RELEASE_RAW, routes.KEEP_ME], ['http://127.0.0.1:4456', 'http://127.0.0.1:4457', 'http://127.0.0.1:4458', '1']);
  // lo que el laboratorio pone SIEMPRE y con qué lanza cada comando también va al reporte
  assert.deepStrictEqual(v.lab_changes.always, L.SAFE_ENV);
  assert.strictEqual(v.lab_changes.launched_with, TL.LAUNCHED_WITH);
  assert.match(TL.LAUNCHED_WITH, /Bypass/);
  assert.deepStrictEqual(v.lab_changes.env_removed.slice().sort(), ['CLAUDE_CONFIG_DIR', 'CLAUDE_MD_PATH', 'CODEX_HOME', 'TYCON_CODEX', 'TYCON_HOME', 'TYCON_STARTUP_DETACH', 'TYCON_UPDATE_APPLY'], 'lo borrado queda anotado');
  assert.deepStrictEqual([v.env.KEEP_ME, v.env.HOME, v.env.TYCON_RELEASE_API, v.env.TYCON_TOOLS_DETECT_PATH], ['1', home, api, '/nowhere']);
  // la lista es cerrada: lo que se pone es lo que queda dicho, y nada de lo que la persona no tiene
  assert.deepStrictEqual(Object.keys(v.lab_changes.env_set).sort(), TL.ENV_SET.slice().sort());
  for (const k of TL.ENV_SET) assert.strictEqual(v.env[k], v.lab_changes.env_set[k], `${k}: lo que dice es lo que puso`);
  assert.deepStrictEqual(TL.ENV_NEVER.slice().sort(), ['TYCON_CLAUDE', 'TYCON_GIT_HOOKS_DIR', 'TYCON_PROFILE', 'TYCON_STARTUP_DETACH', 'TYCON_UPDATE_APPLY']);
  for (const k of TL.ENV_NEVER) assert.ok(!(k in v.env) && !(k in v.lab_changes.env_set), `${k} no se pone: una persona no lo tiene`);
  assert.deepStrictEqual(v.lab_changes.never_set, TL.ENV_NEVER);
  // el permiso de juguete entra sólo en los pasos que lo usan, y el Azure de juguete desde que se suma la capa
  assert.ok(!('TYCON_GITHUB_TOKEN' in v.env) && !('TYCON_AZURE_API' in v.env));
  assert.deepStrictEqual(TL.withToken(v.env, 'permiso-de-juguete').TYCON_GITHUB_TOKEN, 'permiso-de-juguete');
  const team = TL.teamEnv(v.env, 'http://127.0.0.1:4466');
  assert.deepStrictEqual([team.TYCON_AZURE_API, team.TYCON_AZURE_GIT_CREDENTIAL], ['http://127.0.0.1:4466', '0']);
  assert.ok(!('TYCON_AZURE_API' in v.env), 'sin tocar el ambiente del que salió');
});

// ═══ T6 · el GitHub de juguete contesta el archivo crudo sólo cuando se lo piden ═══════════════════════════════

test('ToyGitHub_Contents_AnswersTheRawFileOnlyWhenAsked', { skip: !has('git') && 'NO MEDIDO — sin git' }, async () => {
  const base = tmp('t6');
  let server = null;
  try {
    const work = path.join(base, 'work');
    fs.mkdirSync(work, { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    const body = '# un guion de juguete — con acento: versión\r\nsegunda línea\n';
    write(work, { 'scripts/setup/get-harness.ps1': body });
    git(['add', '-A'], work);
    assert.strictEqual(git(['commit', '-q', '-m', 'uno'], work).status, 0);
    const bare = path.join(base, 'toy.git');
    assert.strictEqual(git(['clone', '-q', '--bare', work, bare], base).status, 0);
    const ports = path.join(base, 'ports.env');
    server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'tests', 'fixtures', 'toy-release-server.js'), '--repo', bare, '--org', 'acme-lab', '--name', 'arnes-lab', '--port-file', ports], { stdio: 'ignore' });
    for (let i = 0; i < 100 && !fs.existsSync(ports); i++) await new Promise((r) => setTimeout(r, 100));
    const api = /^API=(.+)$/m.exec(fs.readFileSync(ports, 'utf8'))[1].trim();
    const url = `${api}/repos/acme-lab/arnes-lab/contents/scripts/setup/get-harness.ps1`;
    // sin pedir el crudo: el JSON en base64 de siempre
    const plain = await fetch(url);
    const json = await plain.json();
    assert.deepStrictEqual([plain.status, json.encoding, Buffer.from(json.content, 'base64').toString('utf8'), json.path], [200, 'base64', body, 'scripts/setup/get-harness.ps1']);
    assert.match(plain.headers.get('content-type'), /application\/json/);
    // pidiéndolo: los bytes del archivo, ni uno más
    const raw = await fetch(url, { headers: { Accept: 'application/vnd.github.raw' } });
    assert.strictEqual(raw.status, 200);
    assert.strictEqual(Buffer.from(await raw.arrayBuffer()).toString('utf8'), body);
    assert.doesNotMatch(raw.headers.get('content-type') || '', /application\/json/);
    // el ETag y el 304, igual en los dos
    assert.ok(plain.headers.get('etag') && plain.headers.get('etag') === raw.headers.get('etag'));
    for (const headers of [{ 'If-None-Match': plain.headers.get('etag') }, { 'If-None-Match': plain.headers.get('etag'), Accept: 'application/vnd.github.raw' }]) assert.strictEqual((await fetch(url, { headers })).status, 304);
    // y un archivo que no está sigue siendo 404, pedido como se pida
    assert.strictEqual((await fetch(`${api}/repos/acme-lab/arnes-lab/contents/no-such-file`, { headers: { Accept: 'application/vnd.github.raw' } })).status, 404);
    // su «raw» (raw.githubusercontent.com, de donde la página baja el guion) lo sirve por rama, como GitHub: los mismos bytes
    const rawOrigin = /^RAW=(.+)$/m.exec(fs.readFileSync(ports, 'utf8'))[1].trim();
    const byBranch = await fetch(`${rawOrigin}/acme-lab/arnes-lab/main/scripts/setup/get-harness.ps1`);
    assert.strictEqual(byBranch.status, 200);
    assert.strictEqual(Buffer.from(await byBranch.arrayBuffer()).toString('utf8'), body);
    assert.strictEqual((await fetch(`${rawOrigin}/acme-lab/arnes-lab/main/no-such-file`)).status, 404);
    assert.strictEqual((await fetch(`${rawOrigin}/acme-lab/arnes-lab/otra-rama/scripts/setup/get-harness.ps1`)).status, 404, 'otra rama no: sólo main');
  } finally { if (server) server.kill(); fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T8 · juzgar un comando: el código de salida, lo esperado y cuándo corre ═══════════════════════════════════

test('GuidedInstall_Judge_ExitsExpectAndRunWhen', () => {
  const done = (x) => Object.assign({ exit: 0, error: null, timed_out: false, stdout: '', stderr: '' }, x);
  const install = { id: 'install', runs: 'machine', severity: 'breaks' };
  const gitHooks = { id: 'git-hooks', runs: 'machine', severity: 'loses-control' };
  // un código que la ficha no da por bueno
  const failed = G.judge(install, { text: 'pwsh -File get-harness.ps1', expect: [] }, done({ exit: 3, stderr: 'no pude' }));
  assert.deepStrictEqual(bySeverity(failed.findings), { 'guided:step-failed:install': 'breaks' });
  assert.match(failed.findings[0].detail, /salió 3/);
  // `git config --get` sale 1 cuando la clave no está: la ficha lo da por bueno, y no es un hallazgo
  assert.deepStrictEqual(G.judge(gitHooks, { text: 'git config --global --get core.hooksPath', ok_exits: [0, 1], expect: [] }, done({ exit: 1 })).findings, []);
  assert.deepStrictEqual(bySeverity(G.judge(gitHooks, { text: 'git config --global --get core.hooksPath', ok_exits: [0, 1], expect: [] }, done({ exit: 128 })).findings), { 'guided:step-failed:git-hooks': 'loses-control' });
  // un comando que no lanza ningún programa «falla» con código 0: se ve por lo esperado, no por el código
  const quiet = G.judge({ id: 'download', runs: 'machine', severity: 'breaks' }, { text: 'Get-Content get-harness.ps1', expect: [{ kind: 'match', pattern: '^# get-harness' }] }, done({ stderr: 'Get-Content: Cannot find path' }));
  assert.deepStrictEqual(bySeverity(quiet.findings), { 'guided:expected:download': 'breaks' });
  assert.deepStrictEqual(quiet.checks.map((c) => [c.kind, c.ok]), [['match', false]]);
  assert.deepStrictEqual(G.judge(install, { text: 'x', expect: [{ kind: 'match', pattern: '^# get-harness' }] }, done({ stdout: '# get-harness.ps1 — baja\n' })).findings, []);
  // un programa que no arrancó, o que se colgó, tampoco pasa por «salió 0»
  assert.deepStrictEqual(bySeverity(G.judge(install, { text: 'x', expect: [] }, done({ exit: null, error: 'ENOENT' })).findings), { 'guided:step-failed:install': 'breaks' });
  assert.deepStrictEqual(bySeverity(G.judge(install, { text: 'x', expect: [] }, done({ exit: null, timed_out: true })).findings), { 'guided:step-failed:install': 'breaks' });
  // un programa que PowerShell no encontró: el proceso sale 0 igual (o con el código del programa anterior), y el paso
  // puede no esperar nada. Se ve por lo que dejó dicho quien lo lanzó
  const missing = G.judge(gitHooks, { text: 'git config --global --get core.hooksPath', ok_exits: [0, 1], expect: [] }, done({ exit: 0, stderr: "git: The term 'git' is not recognized as a name of a cmdlet", not_found: ['git'] }));
  assert.deepStrictEqual(bySeverity(missing.findings), { 'guided:step-failed:git-hooks': 'loses-control' });
  assert.match(missing.findings[0].detail, /no encontró en la máquina: git/);
  assert.deepStrictEqual(G.judge(gitHooks, { text: 'git config --global --get core.hooksPath', ok_exits: [0, 1], expect: [] }, done({ exit: 0, not_found: [] })).findings, []);
  // una expresión se busca en la SALIDA, no en el canal de errores: ahí PowerShell repite el renglón del comando, y
  // toda palabra del comando «aparecería» (así el chequeo de tar no podía fallar nunca)
  const tools = G.loadManifest().steps.find((s) => s.id === 'tools');
  const noTar = G.judge(tools, tools.commands[0], done({ stdout: '7.5.2\nv22.11.0\n', stderr: "tar: /lab/tools-1.ps1:1\n$PSVersionTable.PSVersion.ToString(); node --version; tar --version\nThe term 'tar' is not recognized as a name of a cmdlet", not_found: ['tar'] }));
  assert.deepStrictEqual(noTar.checks.map((c) => [c.what, c.ok]), [['PowerShell 7', true], ['tar', false]]);
  assert.deepStrictEqual(Object.keys(bySeverity(noTar.findings)).sort(), ['guided:expected:tools', 'guided:step-failed:tools']);
  for (const tarSays of ['bsdtar 3.5.2 - libarchive 3.5.2 zlib/1.2.5.f-ipp', 'tar (GNU tar) 1.35']) {
    const withTar = G.judge(tools, tools.commands[0], done({ stdout: `7.5.2\nv22.11.0\n${tarSays}\n` }));
    assert.deepStrictEqual([withTar.findings, withTar.checks.map((c) => c.ok)], [[], [true, true]], tarSays);
  }
  // con `in: any` se busca en los dos canales (quien lo pide sabe que su comando habla por el de errores)
  assert.deepStrictEqual(G.judge(install, { text: 'x', expect: [{ kind: 'match', pattern: '^listo$', in: 'any' }] }, done({ stderr: 'listo\n' })).findings, []);
  assert.deepStrictEqual(bySeverity(G.judge(install, { text: 'x', expect: [{ kind: 'match', pattern: '^listo$' }] }, done({ stderr: 'listo\n' })).findings), { 'guided:expected:install': 'breaks' });
  // los otros tres tipos de lo esperado
  const verify = { id: 'verify', runs: 'machine', severity: 'breaks' };
  assert.deepStrictEqual(G.judge(verify, { text: 'x', expect: [{ kind: 'min', value: 41 }] }, done({ stdout: '57\n' })).findings, []);
  assert.deepStrictEqual(bySeverity(G.judge(verify, { text: 'x', expect: [{ kind: 'min', value: 41 }] }, done({ stdout: '12\n' })).findings), { 'guided:expected:verify': 'breaks' });
  assert.deepStrictEqual(bySeverity(G.judge(verify, { text: 'x', expect: [{ kind: 'min', value: 41 }] }, done({ stdout: 'no es un número\n' })).findings), { 'guided:expected:verify': 'breaks' });
  assert.deepStrictEqual(G.judge(verify, { text: 'x', expect: [{ kind: 'equals', value: 1 }] }, done({ stdout: '\n1\n' })).findings, []);
  assert.deepStrictEqual(bySeverity(G.judge(verify, { text: 'x', expect: [{ kind: 'equals', value: 1 }] }, done({ stdout: '2\n' })).findings), { 'guided:expected:verify': 'breaks' });
  const seen = [];
  const exists = (p) => { seen.push(p); return p === path.join('/lab/home', '.tycon', 'harness', 'version.json'); };
  assert.deepStrictEqual(G.judge(install, { text: 'x', expect: [{ kind: 'file', in: 'home', path: '.tycon/harness/version.json' }] }, done({}), { home: '/lab/home', cwd: '/lab/work', exists }).findings, []);
  assert.deepStrictEqual(bySeverity(G.judge(install, { text: 'x', expect: [{ kind: 'file', in: 'cwd', path: 'get-harness.ps1' }] }, done({}), { home: '/lab/home', cwd: '/lab/work', exists }).findings), { 'guided:expected:install': 'breaks' });
  assert.deepStrictEqual(seen, [path.join('/lab/home', '.tycon', 'harness', 'version.json'), path.join('/lab/work', 'get-harness.ps1')]);
  // lo que el laboratorio no puede dar no es un hallazgo: «no comparable», con su motivo
  const gap = G.judge(verify, { text: 'x', expect: [{ kind: 'min', value: 41, lab_gap: 'el GitHub de juguete no sirve las skills de terceros' }] }, done({ stdout: '12\n' }));
  assert.deepStrictEqual(gap.findings, []);
  assert.deepStrictEqual(gap.checks.map((c) => [c.comparable, c.why]), [[false, 'el GitHub de juguete no sirve las skills de terceros']]);
  // lo que se anota y no se compara (la versión de node es un dato del agente, no de la página)
  const noted = G.judge({ id: 'tools', runs: 'machine', severity: 'noise' }, { text: 'x', expect: [], notes: [{ id: 'node', pattern: '^v\\d+\\.\\d+\\.\\d+' }] }, done({ stdout: '7.5.2\nv20.11.0\nbsdtar 3.5.2\n' }));
  assert.deepStrictEqual([noted.findings, noted.noted], [[], { node: 'v20.11.0' }]);
  // cuándo corre: el condicional sólo si el anterior no devolvió nada; lo de Windows, sólo en Windows
  const conditional = { text: 'git config --global core.hooksPath x', run_when: 'previous-output-empty', expect: [] };
  assert.deepStrictEqual(G.shouldRun(conditional, done({ exit: 1, stdout: '' }), { platform: 'win32' }), { run: true });
  assert.deepStrictEqual(G.shouldRun(conditional, done({ exit: 1, stdout: '  \n' }), { platform: 'win32' }), { run: true });
  const skipped = G.shouldRun(conditional, done({ stdout: 'C:/Users/dev/.git-hooks\n' }), { platform: 'win32' });
  assert.deepStrictEqual([skipped.run, /ya devolvió/.test(skipped.skipped)], [false, true]);
  const windowsOnly = { text: 'node "$env:USERPROFILE\\.claude\\x.js" doctor', windows_only: 'la ruta con barras invertidas sólo resuelve en Windows', expect: [] };
  assert.deepStrictEqual(G.shouldRun(windowsOnly, null, { platform: 'win32' }), { run: true });
  assert.deepStrictEqual(G.shouldRun(windowsOnly, null, { platform: 'linux' }), { run: false, not_comparable: 'la ruta con barras invertidas sólo resuelve en Windows' });

  // ── seguir la página anota cada comando APENAS corre: si el paso se corta por su tope con un comando colgado, el
  // parcial dice cuáles habían corrido y cuál no volvió (si se anotaran todos juntos al final, se perderían)
  if (process.platform !== 'win32') {
    const base = tmp('t8');
    try {
      // un PowerShell de juguete: contesta al instante. Lo que importa acá es CUÁNDO queda anotado cada comando. Además
      // imprime el permiso de GitHub si lo tiene en su ambiente (sólo lo tiene en los pasos que lo usan)
      const ps = path.join(base, 'toy-pwsh');
      fs.writeFileSync(ps, '#!/bin/sh\necho 7.5.2\n[ -n "$TYCON_GITHUB_TOKEN" ] && echo "Authorization: Bearer $TYCON_GITHUB_TOKEN"\n[ -n "$TOY_MKDIR" ] && mkdir -p "$TOY_MKDIR"\nexit 0\n', { mode: 0o755 });
      const m = G.loadManifest();
      const out = path.join(base, 'out');
      const rec = L.recorder('onboarding', out);
      const facts = { commands: [] };
      const seen = [];
      const partial = () => JSON.parse(fs.readFileSync(L.partialFile(out, 'onboarding'), 'utf8')).facts.variants.guided.commands;
      // sin el paquete armado no se sigue la página: correría el publicado, y eso no es ensayar el commit
      assert.throws(() => GI.followPage({ ctx: { manifest: m, guide: { names: TOY_NAMES }, api: 'http://127.0.0.1:4455', tokens: {} }, home: path.join(base, 'home-sin'), env: process.env, ps, scratch: path.join(base, 'scratch-sin'), cwd: path.join(base, 'window'), id: 'x' }), /sin el paquete armado/);
      const pkgCtx = { package: path.join(base, 'tyconsa-harness-1.0.2.tgz'), git: 'http://127.0.0.1:4458', archive: 'http://127.0.0.1:4459', dir: path.join(base, 'lab-dir') };
      const followed = GI.followPage({
        ctx: { manifest: m, guide: { names: TOY_NAMES }, api: 'http://127.0.0.1:4455', raw: 'http://127.0.0.1:4457', tokens: { github: 'permiso-de-juguete-0123456789abcdef' }, ...pkgCtx },
        // (sin el permiso de GitHub que pueda tener en su consola quien corre la suite: el juguete imprime el que haya)
        home: path.join(base, 'home'), env: Object.assign({}, process.env, { TYCON_GITHUB_TOKEN: '' }), ps, scratch: path.join(base, 'scratch'), cwd: path.join(base, 'window'), id: 'onboarding-guided', platform: 'linux',
        commands: facts.commands,
        each: (found) => { rec.fact('variants', { guided: facts }); const rows = partial(); seen.push({ rows: rows.length, last_done: rows[rows.length - 1].exit !== undefined || Boolean(rows[rows.length - 1].skipped || rows[rows.length - 1].not_comparable), found: found.length }); },
      });
      assert.strictEqual(followed.commands, facts.commands, 'las filas se suman en el arreglo de quien llama');
      const ran = facts.commands.filter((c) => c.exit !== undefined);
      assert.ok(ran.length >= 5 && ran.every((c) => typeof c.started === 'string'), `corrió ${ran.length} comandos, cada uno con su hora de arranque`);
      // 🔴 falla si se anota todo al final: el PRIMER aviso ya trae el primer comando en el parcial, sin su salida todavía
      assert.deepStrictEqual([seen[0].rows, seen[0].last_done], [1, false], 'antes de esperarlo, el comando ya está dicho en el parcial');
      assert.deepStrictEqual([seen[1].rows, seen[1].last_done], [1, true], 'y apenas vuelve, con cómo salió');
      assert.strictEqual(seen[seen.length - 1].rows, facts.commands.length);
      assert.ok(seen.some((x) => x.found > 0), 'lo que cada comando encontró se entrega con él, no al final');
      assert.strictEqual(seen.reduce((n, x) => n + x.found, 0), followed.findings.length);
      // el condicional y lo de Windows quedan dichos sin correr
      assert.ok(facts.commands.some((c) => c.skipped) && facts.commands.some((c) => c.not_comparable));
      // 🔴 un comando de la página que IMPRIME el permiso: `guided:secret-printed`, que rompe, en los pasos que lo llevan
      // (bajar, el plan e instalar) y sólo en ésos; y lo que se guarda de su salida va tapado
      const printed = followed.findings.filter((f) => f.id === 'guided:secret-printed');
      assert.deepStrictEqual([printed.length > 0, printed.every((f) => f.severity === 'breaks')], [true, true]);
      assert.deepStrictEqual([...new Set(printed.map((f) => /paso ([a-z-]+)/.exec(f.detail)[1]))].sort(), GI.TOKEN_STEPS.slice().sort());
      assert.ok(!JSON.stringify(facts.commands).includes('permiso-de-juguete-0123456789abcdef') && JSON.stringify(facts.commands).includes(L.REDACTED_SECRET));
      assert.ok(!fs.readFileSync(L.partialFile(out, 'onboarding'), 'utf8').includes('permiso-de-juguete-0123456789abcdef'));
      // ── y sin permiso de GitHub en el laboratorio (el repo servido como público, que es lo que la página supone):
      // ningún paso lo lleva en su ambiente, TRAIGA LO QUE TRAIGA el ambiente que le pasan. Acá el ambiente llega con un
      // permiso puesto (el de quien lanza, que se coló): el PowerShell de juguete lo imprimiría en cada paso.
      // 🔴 Atrapa: que el paso herede la variable tal cual (el caso tiene que dejarla puesta al probar: si la vaciara antes,
      // no distinguiría nada y quedaría todo en verde aun volviendo el código atrás)
      // (el permiso de juguete se arma por partes: escrito entero junto al nombre de la variable, el detector de
      // publicación lo toma por una credencial)
      const plain = GI.followPage({
        ctx: { manifest: m, guide: { names: TOY_NAMES }, api: 'http://127.0.0.1:4455', raw: 'http://127.0.0.1:4457', tokens: { azure: 'permiso-de-azure-0123456789abcdef' }, ...pkgCtx },
        home: path.join(base, 'home-plain'), env: Object.assign({}, process.env, { TYCON_GITHUB_TOKEN: ['permiso-que-se-colo', '0123456789abcdef'].join('-') }), ps, scratch: path.join(base, 'scratch-plain'), cwd: path.join(base, 'window-plain'), id: 'onboarding-guided', platform: 'linux',
      });
      const plainRan = plain.commands.filter((c) => c.exit !== undefined);
      assert.ok(plainRan.length >= 5 && plainRan.every((c) => !/Authorization|permiso-que-se-colo/.test(c.out || '')), `ningún paso tuvo un permiso de GitHub en su ambiente: ${plainRan.filter((c) => /Authorization/.test(c.out || '')).map((c) => c.step).join(', ')}`);
      // y con permiso del laboratorio, los pasos que NO lo usan tampoco heredan el que se coló
      assert.deepStrictEqual(Object.keys(GI.stepEnv({ A: '1', TYCON_GITHUB_TOKEN: 'colado' }, { github: 'del-laboratorio' }, false)), ['A']);
      assert.strictEqual(GI.stepEnv({ A: '1', TYCON_GITHUB_TOKEN: 'colado' }, { github: 'del-laboratorio' }, true).TYCON_GITHUB_TOKEN, 'del-laboratorio');
      assert.deepStrictEqual(Object.keys(GI.stepEnv({ A: '1', tycon_github_token: 'colado' }, { azure: 'x' }, true)), ['A'], 'sin distinguir la caja del nombre (Windows)');
      // ── el archivo donde el envoltorio deja los programas que PowerShell no encontró: si está y no se deja leer, no
      // es «no faltó ninguno» — se dice
      const scratch2 = path.join(base, 'scratch2');
      assert.throws(() => TL.runPage({ ps, text: 'git --version', cwd: path.join(base, 'window'), env: Object.assign({}, process.env, { TOY_MKDIR: path.join(scratch2, 'x.not-found.txt') }), scratch: scratch2, id: 'x' }), /no pude leer qué programas no encontró PowerShell/);
      assert.deepStrictEqual(TL.runPage({ ps, text: 'git --version', cwd: path.join(base, 'window'), env: Object.assign({}, process.env), scratch: path.join(base, 'scratch3'), id: 'x' }).not_found, [], 'el control: sin el archivo, no faltó ninguno');
      // y una carpeta de trabajo con una comilla tipográfica en su ruta no se usa: PowerShell la toma por el cierre de
      // una cadena, y el envoltorio se rompería
      assert.throws(() => TL.runPage({ ps, text: 'git --version', cwd: path.join(base, 'window'), env: process.env, scratch: path.join(base, 'lab de l’equipo'), id: 'x' }), /comilla tipográfica/);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

// ═══ T9 · lo que no se ensaya, dicho ═══════════════════════════════════════════════════════════════════════════

test('GuidedInstall_NotRehearsed_ListsPersonStepsAndTheRest', () => {
  const m = G.loadManifest();
  const list = G.notRehearsed(m);
  for (const s of m.steps.filter((x) => x.runs === 'person')) assert.ok(list.some((n) => n.step === s.id && n.why === s.why), `el paso ${s.id}, con el motivo de la ficha`);
  for (const n of m.not_rehearsed) assert.ok(list.some((x) => x.what === n.what && x.why === n.why), `«${n.what}», con su motivo`);
  assert.strictEqual(list.length, m.steps.filter((x) => x.runs === 'person').length + m.not_rehearsed.length, 'nada más y nada menos');
  for (const n of list) assert.ok(n.what && n.why && n.why.length > 15);
  const all = list.map((n) => `${n.what} ${n.why}`).join('\n');
  for (const said of [/permiso/i, /winget/i, /parte 2/i, /gestor/i, /sí/]) assert.match(all, said);
  // ninguno se corre: lo que corre el ensayo son los pasos de la máquina, en el orden de la página
  assert.deepStrictEqual(G.machineSteps(m).map((s) => s.id), ['tools', 'plan', 'install', 'git-hooks', 'verify']);
  assert.ok(G.machineSteps(m).every((s) => s.commands.every((c) => !/Read-Host/.test(c.text))), 'ningún comando que pida una terminal');
});

// ═══ T10 · la sesión espera sólo por un trabajo desprendido que es nuevo y sigue vivo ══════════════════════════

test('Session_Detached_WaitsOnlyForALiveNewWorker', async () => {
  const base = tmp('t10');
  const live = [];
  try {
    const DETACH = path.join(ROOT, 'scripts', 'setup', 'harness', 'detach.js');
    // el programa de juguete: como hook, lanza la corrida desprendida y espera poco; como desprendido, la ADOPTA (si no
    // dejara su marca de arranque, el hook lo mataría por «no arrancó» y la prueba mediría otra cosa), trabaja y anota
    const program = path.join(base, 'toy-startup.js');
    fs.writeFileSync(program, [
      `const D = require(${JSON.stringify(DETACH)}); const fs = require('fs'); const path = require('path');`,
      // (el tercer argumento: cuánto espera el hook antes de irse; por defecto poco, para que el lento se desprenda)
      "const [dir, ms, wait] = process.argv.slice(2);",
      "if (D.adoptDetachedRun()) { setTimeout(() => { fs.writeFileSync(path.join(dir, 'worked'), String(process.pid)); D.writeResult(0, ['listo']); process.exit(0); }, Number(ms)); }",
      "else { const r = D.runDetached({ script: __filename, args: [dir, ms, wait], resultFile: path.join(dir, 'startup-result.' + process.pid + '.json'), waitMs: Number(wait || 400), pollMs: 25, startWaitMs: 8000 }); process.stdout.write(JSON.stringify(r)); process.exit(r ? r.code : 9); }",
    ].join('\n'));
    const env = Object.assign({}, process.env, { TYCON_STARTUP_SHIM: '0' });
    delete env.TYCON_STARTUP_DETACHED; delete env.TYCON_STARTUP_RESULT;
    const open = (dir, ms, wait = 400) => { fs.mkdirSync(dir, { recursive: true }); const before = TL.detachedMarks(dir); const r = node([program, dir, String(ms), String(wait)], { env }); assert.strictEqual(r.status, 0, r.stderr); return { before, hook: JSON.parse(r.stdout) }; };
    const lockDir = (dir) => path.join(dir, 'harness.lock');

    // ── uno lento: el hook vuelve antes de que termine, y la sesión ESPERA al que quedó trabajando
    const slow = path.join(base, 'slow');
    const s = open(slow, 1500);
    assert.strictEqual(s.hook.detached, true, 'el juguete: el hook se fue y el trabajo siguió aparte');
    assert.ok(!fs.existsSync(path.join(slow, 'worked')), 'el juguete: cuando vuelve el hook el trabajo no terminó');
    const waited = TL.waitDetached({ harnessDir: slow, lockDir: lockDir(slow), before: s.before, capMs: 15000, pollMs: 25 });
    assert.deepStrictEqual([waited.detached, waited.ended_by], [true, 'cleaned']);
    assert.ok(waited.waited_ms >= 500, `anota cuánto tardó (${waited.waited_ms} ms)`);
    // 🔴 falla si se saca la espera: recién ahora el trabajo terminó
    assert.ok(fs.existsSync(path.join(slow, 'worked')), 'después de la espera, el trabajo desprendido terminó');
    assert.deepStrictEqual(TL.sessionFindings({ form: 'default-shell', label: 'primera-1', hooks: [], wait: waited }), []);

    // ── uno rápido: termina dentro de la espera del hook; no se desprendió y no hay por qué esperar
    const fast = path.join(base, 'fast');
    // (el hook lo espera varios segundos: que termine «dentro de la espera» no depende de cuán cargada esté la máquina)
    const f = open(fast, 0, 8000);
    assert.strictEqual(f.hook.detached, false);
    const none = TL.waitDetached({ harnessDir: fast, lockDir: lockDir(fast), before: f.before, capMs: 15000, pollMs: 25 });
    assert.deepStrictEqual([none.detached, none.waited_ms, none.ended_by], [false, 0, null]);

    // ── uno que no termina: se deja de esperar en el tope, se dice quién quedó, y es un hallazgo que pierde un control
    const stuck = path.join(base, 'stuck');
    const k = open(stuck, 600000);
    live.push(k.hook.pid);
    const t0 = Date.now();
    const cut = TL.waitDetached({ harnessDir: stuck, lockDir: lockDir(stuck), before: k.before, capMs: 700, pollMs: 25 });
    assert.deepStrictEqual([cut.detached, cut.ended_by, cut.pid], [true, 'not-finished', k.hook.pid]);
    assert.ok(Date.now() - t0 < 5000, 'ninguna espera es sin tope');
    assert.deepStrictEqual(bySeverity(TL.sessionFindings({ form: 'bash-c', label: 'primera-2', hooks: [], wait: cut })), { 'session:bash-c:detached-run-not-finished': 'loses-control' });
    assert.match(TL.sessionFindings({ form: 'bash-c', label: 'primera-2', hooks: [], wait: Object.assign({ log_tail: ['startup: sigo bajando'] }, cut) })[0].detail, new RegExp(`${k.hook.pid}[\\s\\S]*sigo bajando`), 'con el proceso que quedó y el final del registro');

    // ── una marca que ya estaba ANTES de la sesión no hace esperar (queda hasta que el barrido la saque, una hora después)
    const old = path.join(base, 'old');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'startup-result.424242.json.gone'), `${process.pid}\n`);
    const o = TL.waitDetached({ harnessDir: old, lockDir: lockDir(old), before: TL.detachedMarks(old), capMs: 15000, pollMs: 25 });
    assert.deepStrictEqual([o.detached, o.waited_ms], [false, 0]);

    // ── una marca nueva con su resultado al lado: el trabajo llegó a anotar (terminó justo cuando el hook dejó de esperar)
    const left = path.join(base, 'left');
    fs.mkdirSync(left, { recursive: true });
    fs.writeFileSync(path.join(left, 'startup-result.515151.json.gone'), `${process.pid}\n`);
    fs.writeFileSync(path.join(left, 'startup-result.515151.json'), '{"code":0,"lines":[]}');
    const l = TL.waitDetached({ harnessDir: left, lockDir: lockDir(left), before: [], capMs: 15000, pollMs: 25 });
    assert.deepStrictEqual([l.detached, l.ended_by], [true, 'result-left']);
    assert.ok(l.waited_ms < 2000);
    // ── una marca nueva cuyo proceso ya no existe (lo mataron, o no arrancó): tampoco se espera, y no es un hallazgo
    const gone = path.join(base, 'gone');
    fs.mkdirSync(gone, { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(gone, 'startup-result.616161.json.gone'), `${dead.stdout}\n`);
    fs.writeFileSync(path.join(gone, 'startup-result.616161.json.started'), `${dead.stdout}\n`);
    const g = TL.waitDetached({ harnessDir: gone, lockDir: lockDir(gone), before: [], capMs: 15000, pollMs: 25 });
    assert.deepStrictEqual([g.detached, g.ended_by], [true, 'process-gone']);
    assert.ok(g.waited_ms < 2000);
    for (const w of [l, g]) assert.deepStrictEqual(TL.sessionFindings({ form: 'default-shell', label: 'x', hooks: [], wait: w }), []);
    // una marca de arranque sin su «el hook se fue» no se espera
    const started = path.join(base, 'started');
    fs.mkdirSync(started, { recursive: true });
    fs.writeFileSync(path.join(started, 'startup-result.717171.json.started'), `${process.pid}\n`);
    assert.strictEqual(TL.waitDetached({ harnessDir: started, lockDir: lockDir(started), before: [], capMs: 15000, pollMs: 25 }).detached, false);

    // ── el candado: una carpeta. Libre si no existe o si su dueño ya no existe; tomado por alguien vivo, se espera
    const locked = path.join(base, 'locked');
    fs.mkdirSync(lockDir(locked), { recursive: true });
    fs.writeFileSync(path.join(locked, 'startup-result.818181.json.gone'), `${dead.stdout}\n`);
    fs.writeFileSync(path.join(lockDir(locked), 'pid'), `${dead.stdout}\n${os.hostname()}\n`);
    assert.strictEqual(TL.waitDetached({ harnessDir: locked, lockDir: lockDir(locked), before: [], capMs: 15000, pollMs: 25 }).ended_by, 'process-gone', 'el candado de un dueño que ya no existe no hace esperar');
    fs.writeFileSync(path.join(lockDir(locked), 'pid'), `${process.pid}\n${os.hostname()}\n`);
    const held = TL.waitDetached({ harnessDir: locked, lockDir: lockDir(locked), before: [], capMs: 400, pollMs: 25 });
    assert.deepStrictEqual([held.ended_by, held.lock_held_by], ['not-finished', process.pid]);

    // ── el tope de la variante: varias esperas que juntas lo pasan
    const budget = { left_ms: 900 };
    const mark = (name) => { const d = path.join(base, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'startup-result.919191.json.gone'), `${process.pid}\n`); return d; };
    const first = TL.waitDetached({ harnessDir: mark('b1'), lockDir: lockDir(path.join(base, 'b1')), before: [], capMs: 600, pollMs: 25, budget });
    const second = TL.waitDetached({ harnessDir: mark('b2'), lockDir: lockDir(path.join(base, 'b2')), before: [], capMs: 600, pollMs: 25, budget });
    const third = TL.waitDetached({ harnessDir: mark('b3'), lockDir: lockDir(path.join(base, 'b3')), before: [], capMs: 600, pollMs: 25, budget });
    assert.deepStrictEqual([first.ended_by, second.ended_by, third.ended_by], ['not-finished', 'not-finished', 'not-finished']);
    // (márgenes anchos: lo que se mide es que la segunda y la tercera se cortan por el tope de la variante, antes que
    // por el propio —600 ms—, no una cuenta fina de milisegundos en una máquina cargada)
    assert.ok(first.waited_ms >= 550 && second.waited_ms < 580 && third.waited_ms < 300, `el tope de la variante corta (${first.waited_ms}, ${second.waited_ms}, ${third.waited_ms} ms)`);
    // ── una marca que ESTÁ y no se deja leer (acá, una carpeta en su lugar): no es «se limpió». Se la sigue esperando
    // hasta el tope, y queda dicho qué pasó
    const blind = path.join(base, 'blind');
    fs.mkdirSync(path.join(blind, 'startup-result.929292.json.gone'), { recursive: true });
    const unread = TL.waitDetached({ harnessDir: blind, lockDir: lockDir(blind), before: [], capMs: 300, pollMs: 25 });
    assert.deepStrictEqual([unread.detached, unread.ended_by, typeof unread.mark_unreadable], [true, 'not-finished', 'string']);
    assert.match(TL.sessionFindings({ form: 'default-shell', label: 'x', hooks: [], wait: unread })[0].detail, /una marca del trabajo que no se pudo leer/);
    assert.deepStrictEqual([Boolean(second.budget_exhausted), Boolean(third.budget_exhausted), budget.left_ms], [true, true, 0]);

    // ── y la sesión entera, con lo mismo: `fireSession` dispara los hooks de SessionStart tal como quedaron registrados,
    // ve que la línea de arranque se desprendió y ESPERA a que su trabajo termine antes de devolver
    if (process.platform !== 'win32') {
      const C = require(path.join(DIR, 'count-hooks.js'));
      const home = path.join(base, 'session-home');
      const hdir = path.join(home, '.claude', '.tycon-pipeline', 'harness');
      fs.mkdirSync(hdir, { recursive: true });
      const boot = path.join(hdir, 'bootstrap.js');
      fs.copyFileSync(program, boot);
      assert.ok(`node "${boot}"`.includes(C.BOOTSTRAP_MARK), 'el juguete: su comando es una línea de arranque para el ensayo');
      const secret = 'permiso-de-juguete-abcdef0123456789';
      const teller = path.join(home, 'teller.js');
      // (el permiso va en el MEDIO de una salida larga: lo que se guarda de un hook se recorta, y el permiso se busca
      // antes de recortar — si se buscara después, éste no se vería)
      fs.writeFileSync(teller, `process.stdout.write('x'.repeat(4000) + ' aviso con ${secret} ' + 'y'.repeat(4000) + '\\n'); process.exit(3);\n`);
      const settingsOf = (ms) => fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${boot}" "${hdir}" ${ms}`, async: true }, { type: 'command', command: `node "${teller}"` }] }] } }, null, 2)}\n`);
      const form = { id: 'default-shell', shell: '/bin/sh -c', launch: (command) => [command, [], { shell: true }] };
      const paths = { harnessDir: hdir, lockDir: lockDir(hdir), log: path.join(hdir, 'startup.log') };
      settingsOf(1200);
      const s1 = TL.fireSession({ form, home, env, label: 'con-la-capa', paths, secrets: { github: secret }, capMs: 15000, pollMs: 25 });
      assert.deepStrictEqual([s1.wait.detached, s1.wait.ended_by], [true, 'cleaned'], 'se desprendió y se lo esperó');
      // 🔴 falla si la sesión no espera: cuando vuelve, el trabajo desprendido ya terminó
      assert.ok(fs.existsSync(path.join(hdir, 'worked')), 'cuando la sesión vuelve, el trabajo desprendido ya terminó');
      assert.deepStrictEqual(s1.hooks.map((h) => [h.startup, h.is_async, h.exit]), [['new', true, 0], [null, false, 3]]);
      // el permiso se buscó en la salida CRUDA del hook, y lo que se devuelve ya va tapado
      assert.deepStrictEqual(s1.leaked, ['github']);
      assert.ok(s1.hooks[1].out.length < 2600, `lo guardado de un hook va recortado (${s1.hooks[1].out.length} caracteres)`);
      assert.ok(!JSON.stringify(s1).includes(secret));
      // el juicio de esa sesión, el mismo para toda sesión que el ensayo abre: el hook que falló y el permiso impreso
      assert.deepStrictEqual(bySeverity(TL.sessionFindings(s1)), { [`session:default-shell:hook-failed:${s1.hooks[1].hook}`]: 'noise', 'guided:secret-printed': 'breaks' });
      // uno que no termina: la sesión vuelve al tope y lo dice
      fs.rmSync(path.join(hdir, 'worked'), { force: true });
      settingsOf(600000);
      const s2 = TL.fireSession({ form, home, env, label: 'después-1', paths, capMs: 600, pollMs: 25 });
      if (s2.wait && s2.wait.pid) live.push(s2.wait.pid);
      assert.deepStrictEqual([s2.wait.detached, s2.wait.ended_by], [true, 'not-finished']);
      assert.ok(TL.sessionFindings(s2).some((f) => f.id === 'session:default-shell:detached-run-not-finished' && f.severity === 'loses-control'));
      // settings.json ilegible: la sesión no se pudo abrir, y eso rompe
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ "hooks": ');
      const s3 = TL.fireSession({ form, home, env, label: 'con-la-capa', paths, capMs: 600, pollMs: 25 });
      assert.match(s3.problem, /settings\.json no se pudo leer/);
      assert.deepStrictEqual(bySeverity(TL.sessionFindings(s3)), { 'session:default-shell:unreadable-settings': 'breaks' });
    }
  } finally {
    for (const pid of live) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* ya no está */ } }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ═══ T12 · los comandos de la capa son los del texto del alta del equipo ═══════════════════════════════════════

test('GuidedTeam_Commands_AreTheOnesInTheTeamText', { skip: !fs.existsSync(path.join(ROOT, T.DOC)) && 'NO MEDIDO — copia sin el texto del alta del equipo' }, () => {
  const m = G.loadManifest();
  const doc = fs.readFileSync(path.join(ROOT, T.DOC), 'utf8');
  const line = doc.split('\n').find((l) => /harness\.js install --version latest --team /.test(l));
  assert.ok(line, 'el alta del equipo trae el comando de la capa');
  // se compara desde `harness.js` en adelante, y salvo la dirección del repo
  const fromHarness = line.slice(line.indexOf('harness.js')).trim().replace(/(--team )\S+/, '$1<team-url>');
  assert.strictEqual(m.team.commands[1].text, fromHarness);
  assert.ok(doc.includes(m.team.commands[0].text), 'y el del permiso de Azure, sin eco y nunca por argumento');
  assert.deepStrictEqual(GI.teamArgs(m.team.commands[1].text, { teamUrl: TL.TEAM_URL }), ['install', '--version', 'latest', '--team', TL.TEAM_URL, '--yes']);
  assert.deepStrictEqual(GI.teamArgs(m.team.commands[0].text, { teamUrl: TL.TEAM_URL }), ['config', 'set', 'azure.token']);
  assert.match(TL.TEAM_URL, /^https:\/\/dev\.azure\.com\/acme\//, 'la dirección del repo del equipo de juguete es la que ya usa no-clone');
});

// ═══ T13 · sólo PowerShell 5.1: frena limpio y lo dice ═════════════════════════════════════════════════════════

test('GuidedPs51_StopsCleanAndSaysWhy', () => {
  const base = tmp('t13');
  try {
    const clear = { exit: 1, said: 'get-harness: este guion pide PowerShell 7 (pwsh) y lo corrió PowerShell 5.1.26100.4202 — sugerido (no lo corro): winget install Microsoft.PowerShell' };
    const intact = path.join(base, 'intact');
    const half = path.join(base, 'half');
    for (const home of [intact, half]) TL.makeHome(home);
    const before = GI.homeFacts(intact);
    assert.deepStrictEqual([before.harness_dir, before.startup_line, typeof before.settings_sha256], [false, false, 'string']);
    // frena limpio y lo dice: sin hallazgos
    assert.deepStrictEqual(GI.judgePs51({ powershell_file: clear, before, after: GI.homeFacts(intact) }), []);
    // el guion bajo 5.1 no dice que hace falta PowerShell 7 (un error de sintaxis, por ejemplo): pierde un control
    assert.deepStrictEqual(bySeverity(GI.judgePs51({ powershell_file: { exit: 1, said: 'At line:42 char:7 Unexpected token' }, before, after: GI.homeFacts(intact) })), { 'guided-ps51:no-clear-message': 'loses-control' });
    assert.deepStrictEqual(bySeverity(GI.judgePs51({ powershell_file: { exit: null, error: 'ENOENT', said: '' }, before, after: GI.homeFacts(intact) })), { 'guided-ps51:no-clear-message': 'loses-control' });
    // algo quedó escrito: la máquina a medio instalar, que rompe
    const halfBefore = GI.homeFacts(half);
    fs.mkdirSync(path.join(half, '.tycon', 'harness'), { recursive: true });
    assert.deepStrictEqual(bySeverity(GI.judgePs51({ powershell_file: clear, before: halfBefore, after: GI.homeFacts(half) })), { 'guided-ps51:half-installed': 'breaks' });
    fs.rmSync(path.join(half, '.tycon'), { recursive: true, force: true });
    fs.writeFileSync(path.join(half, '.claude', 'settings.json'), `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/.tycon-pipeline/harness/bootstrap.js"' }] }] } }, null, 2)}\n`);
    const written = GI.judgePs51({ powershell_file: clear, before: halfBefore, after: GI.homeFacts(half) });
    assert.deepStrictEqual(bySeverity(written), { 'guided-ps51:half-installed': 'breaks' });
    assert.match(written[0].detail, /settings\.json/);
    assert.match(written[0].detail, /línea de arranque/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T14 · la foto de una versión bajada no trae nada de git ═══════════════════════════════════════════════════

test('ReleasePhoto_DownloadedVersion_HasNoGitFacts', () => {
  const base = tmp('t14');
  try {
    const home = path.join(base, 'home');
    TL.makeHome(home);
    const tree = path.join(home, '.tycon', 'harness');
    // el árbol de una versión bajada: archivos, sin git. Lo que lee la foto del árbol se copia del de verdad
    for (const rel of ['scripts/setup/hooks-list.json', 'scripts/setup/apply-hooks.js', 'scripts/setup/install-effects.json', 'scripts/setup/windows-support.json']) {
      if (!fs.existsSync(path.join(ROOT, rel))) continue;
      fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(tree, rel));
    }
    write(tree, { 'version.json': '{ "version": "2030.04.01.1" }\n', 'scripts/hooks/session-notice.js': '// de juguete\n' });
    // el estado vive en la casa propia del arnés (~/.tycon/state), NO en la ruta fija de siempre
    write(home, { '.tycon/state/harness-state.json': `${JSON.stringify({ mode: 'managed', channel: 'stable', version: { number: '2030.04.01.1' }, notice: 'hay versión nueva: 2030.04.01.2', sources: [{ name: 'harness', kind: 'release', commit: 'a'.repeat(40) }] })}\n`, '.tycon/state/harness/startup.log': '2030-04-01T00:00:00Z startup: al día\n' });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${tree}/scripts/hooks/session-notice.js"` }, { type: 'command', command: `node "${home}/.claude/.tycon-pipeline/harness/bootstrap.js"`, async: true }] }] } }, null, 2)}\n`);
    const env = TL.variantEnv(home, { base: { PATH: process.env.PATH || '' }, api: 'http://127.0.0.1:1', detectPath: '/nowhere' }).env;
    const paths = TL.statePaths({ home, env });
    assert.strictEqual(paths.problem, undefined, paths.problem);
    assert.ok(L.samePath(L.realOrSelf(path.dirname(paths.file)), L.realOrSelf(path.join(home, '.tycon', 'state'))), `la carpeta del estado la resuelve el arnés (${paths.file})`);
    const p = RP.photo({ home, tree, env, paths });
    assert.ok(!('repos' in p), 'sin `repos`: una versión bajada no es un clon');
    assert.deepStrictEqual([p.version.number, p.state.exists, p.state.version, p.state.notice, p.state.kind], ['2030.04.01.1', true, '2030.04.01.1', 'hay versión nueva: 2030.04.01.2', 'release']);
    assert.deepStrictEqual(p.startup_log_tail, ['2030-04-01T00:00:00Z startup: al día']);
    // los hooks esperados salen de la lista del árbol instalado (hooks-list.json), no de un instalador de bash
    assert.strictEqual(p.expected.problem, undefined, p.expected.problem);
    assert.strictEqual(p.expected.from, 'scripts/setup/hooks-list.json');
    assert.ok(p.expected.expected_total > 10 && p.expected.missing.length > 0, 'contra la lista de verdad, a este juguete le faltan casi todos');
    const judged = RP.judgePhoto(p);
    assert.ok(!judged.some((f) => /^repo:|^update:not-applied/.test(f.id)), `ningún hallazgo de git: ${judged.map((f) => f.id).filter((id) => /^repo:/.test(id)).join(', ')}`);
    assert.ok(judged.some((f) => /^hooks:missing:/.test(f.id) && f.severity === 'loses-control'));
    assert.ok(judged.some((f) => f.id === 'state:notice' && f.severity === 'noise'));
    for (const f of judged) assert.ok(T.SEVERITY_TEXT[f.severity] && f.detail, f.id);
    // el estado: que NO esté no es lo mismo que estar y no dejarse leer
    const stateText = fs.readFileSync(paths.file, 'utf8');
    fs.writeFileSync(paths.file, '{ "mode": "managed", ');
    const brokenState = RP.photo({ home, tree, env, paths });
    assert.deepStrictEqual([brokenState.state.exists, /no es JSON/.test(brokenState.state.problem)], [true, true]);
    assert.strictEqual(bySeverity(RP.judgePhoto(brokenState))['state:unreadable'], 'loses-control');
    assert.throws(() => TL.stateOf(paths), /no es JSON/, 'quien lo lee para decidir algo no lo toma por «no hay estado»');
    fs.rmSync(paths.file);
    const noState = RP.photo({ home, tree, env, paths });
    assert.deepStrictEqual(noState.state, { exists: false });
    assert.ok(!('state:unreadable' in bySeverity(RP.judgePhoto(noState))));
    assert.strictEqual(TL.stateOf(paths), null);
    // y un estado que está y no se puede ABRIR (acá, una carpeta en su lugar) tampoco es «no hay»: sólo «no existe» lo es
    fs.mkdirSync(paths.file);
    assert.throws(() => TL.stateOf(paths), /no pude leer el estado del arnés/);
    assert.strictEqual(bySeverity(RP.judgePhoto(RP.photo({ home, tree, env, paths })))['state:unreadable'], 'loses-control');
    fs.rmdirSync(paths.file);
    fs.writeFileSync(paths.file, stateText);
    assert.ok(!('state:unreadable' in bySeverity(judged)), 'el control: con el estado sano no sale');
    // el número de versión: un version.json que está y no se deja leer se dice con su motivo
    fs.writeFileSync(path.join(tree, 'version.json'), '{ "version": ');
    assert.match(TL.versionFacts(tree).problem, /no es JSON/);
    assert.match(RP.judgePhoto(RP.photo({ home, tree, env, paths })).find((f) => f.id === 'version:unreadable').detail, /no es JSON/);
    fs.writeFileSync(path.join(tree, 'version.json'), '{ "version": "" }\n');
    assert.match(TL.versionFacts(tree).problem, /no trae un número/);
    assert.deepStrictEqual(TL.versionFacts(path.join(base, 'no-such-tree')), { number: null, problem: null }, 'sin archivo no hay versión instalada: no es un problema de lectura');
    // un árbol instalado sin su número de versión: no se sabe qué quedó, y rompe
    fs.rmSync(path.join(tree, 'version.json'));
    assert.strictEqual(bySeverity(RP.judgePhoto(RP.photo({ home, tree, env, paths })))['version:unreadable'], 'breaks');
    // y sin la lista de hooks en el árbol, la comparación se dice imposible: no se inventa una lista
    fs.rmSync(path.join(tree, 'scripts', 'setup', 'hooks-list.json'));
    assert.match(RP.photo({ home, tree, env, paths }).expected.problem, /hooks-list\.json/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T15 · comparar dos fotos: cada identificador con su gravedad ══════════════════════════════════════════════

test('ReleasePhoto_Compare_EveryIdHasItsSeverity', () => {
  const before = fixture('release-photo-before.json');
  const after = fixture('release-photo-after.json');
  assert.ok(!('repos' in before) && !('repos' in after), 'los datos de prueba son de una versión bajada');
  assert.deepStrictEqual(RP.comparePhotos(before, clone(before)), [], 'la misma foto dos veces: ninguna diferencia');
  const smokeBefore = { rows: [{ key: 'PreToolUse:@tcg:safety-brake.js[Bash]', event: 'PreToolUse', form: 'default-shell', exit: 0, error: null, blocked: false }, { key: 'Stop:@tcg:old-meter.js', event: 'Stop', form: 'default-shell', exit: 0, error: null, blocked: false }, { key: 'SessionStart:@tcg:flaky-notice.js', event: 'SessionStart', form: 'default-shell', exit: 1, error: null, blocked: false }] };
  const smokeAfter = { rows: [{ key: 'PreToolUse:@tcg:safety-brake.js[Bash]', event: 'PreToolUse', form: 'default-shell', exit: 2, error: null, blocked: true, said: 'frenado' }, { key: 'Stop:@tcg:old-meter.js', event: 'Stop', form: 'default-shell', exit: 1, error: null, blocked: false, said: 'Cannot find module' }, { key: 'SessionStart:@tcg:flaky-notice.js', event: 'SessionStart', form: 'default-shell', exit: 1, error: null, blocked: false }] };
  const sessions = [
    { label: 'después-1', form: 'bash-c', hooks: [{ hook: 'startup-line', startup: 'new', exit: 1, error: null, out: '', err: 'pwsh: command not found' }, { hook: '@tcg:flaky-notice.js', startup: null, exit: 1, error: null, out: '', err: 'sin red' }], wait: { detached: true, ended_by: 'not-finished', pid: 4242, waited_ms: 180000 } },
    { label: 'después-2', form: 'default-shell', hooks: [{ hook: 'startup-line', startup: 'new', exit: 0, error: null, out: '', err: 'Receiving objects: 100%' }], wait: { detached: false, ended_by: null, waited_ms: 0 } },
    { label: 'después-3', form: 'default-shell', problem: 'settings.json no se pudo leer: Unexpected token' },
  ];
  const diff = RP.comparePhotos(before, after, { sessions, smokeBefore, smokeAfter, expectVersion: after.version.number });
  const by = bySeverity(diff);
  // rompe
  assert.strictEqual(by['smoke:default-shell:PreToolUse:@tcg:safety-brake.js[Bash]'], 'breaks');
  assert.strictEqual(by['links:wrong:skills'], 'breaks');
  assert.strictEqual(by['session:default-shell:unreadable-settings'], 'breaks');
  // pierde un control
  for (const id of ['hooks:lost:SessionStart:@tcg:bench-notice.js', 'hooks:dangling:Stop:@tcg:old-meter.js', 'smoke:default-shell:Stop:@tcg:old-meter.js', 'session:bash-c:startup-line-failed', 'session:bash-c:detached-run-not-finished', 'settings:keys-lost', 'commands:lost']) assert.strictEqual(by[id], 'loses-control', id);
  assert.ok(diff.some((d) => /^doctor:fail:/.test(d.id) && d.severity === 'loses-control'), 'un rojo nuevo de doctor');
  // ruido
  assert.strictEqual(by['hooks:lost:Stop:@tcg:retired-meter.js'], 'noise', 'un hook que la lista de la versión nueva ya no trae no es un control perdido');
  for (const id of ['settings:keys-added', 'settings:rewritten', 'version:changed', 'hooks:gained', 'commands:added', 'startup:line-changed', 'session:bash-c:hook-failed:@tcg:flaky-notice.js', 'session:default-shell:startup-line-stderr', 'state:notice']) assert.strictEqual(by[id], 'noise', id);
  assert.ok(diff.some((d) => /^doctor:new-warn:/.test(d.id) && d.severity === 'noise'));
  // lo que ya fallaba igual antes no es una diferencia; faltar contra la lista no es de esta actualización; y nada de git
  assert.ok(!('smoke:default-shell:SessionStart:@tcg:flaky-notice.js' in by));
  assert.ok(!diff.some((d) => /^hooks:missing:|^repo:|^update:not-applied/.test(d.id)));
  // ordenadas por gravedad, un identificador por diferencia, cada una con su texto, y ningún texto del viernes
  const order = diff.map((d) => T.SEVERITY_ORDER.indexOf(d.severity));
  assert.deepStrictEqual(order, order.slice().sort((a, b) => a - b));
  assert.strictEqual(new Set(diff.map((d) => d.id)).size, diff.length);
  for (const d of diff) { assert.ok(d.detail && d.detail.length > 15 && T.SEVERITY_TEXT[d.severity], d.id); assert.doesNotMatch(d.detail, /viernes|clon/, d.id); }
  // «se actualizó» es el número del árbol instalado: si quedó en el de antes, pierde un control
  const stuck = clone(after); stuck.version.number = before.version.number;
  assert.strictEqual(bySeverity(RP.comparePhotos(before, stuck, { expectVersion: after.version.number }))['version:not-applied'], 'loses-control');
  assert.ok(!('version:not-applied' in bySeverity(RP.comparePhotos(before, stuck))), 'sin una versión que esperar (la variante que pregunta), no llegar no es un hallazgo');
  const unreadable = clone(after); unreadable.version.number = null;
  assert.strictEqual(bySeverity(RP.comparePhotos(before, unreadable, { expectVersion: after.version.number }))['version:unreadable'], 'breaks');
  // dos sesiones seguidas, lanzadas igual, que dejan settings.json distinto
  const twice = [{ label: 'a', form: 'default-shell', hooks: [], settings_sha256: 'a' }, { label: 'b', form: 'default-shell', hooks: [], settings_sha256: 'b' }];
  assert.strictEqual(bySeverity(RP.comparePhotos(before, after, { sessions: twice }))['settings:rewritten-every-session'], 'noise');
  // las respuestas cortas
  const a = RP.answers(before, after, diff, { sessions, expectVersion: after.version.number });
  assert.deepStrictEqual([a.healthy, a.updated, a.version.before, a.version.after, a.hooks.before, a.hooks.after, a.hooks.kept], [false, true, before.version.number, after.version.number, 4, 4, 2]);
  assert.strictEqual(RP.answers(before, stuck, [], { expectVersion: after.version.number }).updated, false);
  // el juicio de una sesión es UNO solo: una sesión que no entra a una comparación de fotos (la de antes, la de la capa,
  // las de la máquina que pregunta) da los mismos hallazgos, con la misma gravedad, que una que sí
  for (const s of sessions) {
    const alone = bySeverity(TL.sessionFindings(s));
    assert.ok(Object.keys(alone).length > 0, s.label);
    for (const [id, severity] of Object.entries(alone)) assert.strictEqual(by[id], severity, `${s.label}: ${id}`);
  }
  assert.deepStrictEqual(Object.keys(by).filter((id) => /^session:/.test(id)).sort(), sessions.flatMap((s) => TL.sessionFindings(s).map((f) => f.id)).sort(), 'y la comparación no agrega ni saca ninguno');
  // en la variante sin pwsh, que la línea de arranque falle es lo que se mide (con su propio hallazgo): lo demás se juzga igual
  assert.deepStrictEqual(bySeverity(TL.sessionFindings(sessions[0], { startup: false })), { 'session:bash-c:hook-failed:@tcg:flaky-notice.js': 'noise', 'session:bash-c:detached-run-not-finished': 'loses-control' });
  // un permiso de juguete en lo que imprimió un hook de la sesión: rompe, pase la sesión por donde pase
  const leaky = { label: 'con-la-capa', form: 'default-shell', hooks: [], wait: { detached: false }, leaked: ['azure'] };
  assert.deepStrictEqual(bySeverity(TL.sessionFindings(leaky)), { 'guided:secret-printed': 'breaks' });
  assert.strictEqual(bySeverity(RP.comparePhotos(before, clone(before), { sessions: [leaky] }))['guided:secret-printed'], 'breaks');
  // la máquina DESPUÉS de sumar la capa se juzga con esta misma comparación: un rojo nuevo del diagnóstico y una
  // sesión con la capa que falla salen con su gravedad (la foto no se limita a anotarse)
  const withTeam = clone(before);
  withTeam.doctor.fail = [...before.doctor.fail, 'settings.json: 12 hooks del arnés ya no están registrados'];
  const afterTeam = bySeverity(RP.comparePhotos(before, withTeam, { sessions: [{ label: 'con-la-capa', form: 'default-shell', hooks: [{ hook: 'startup-line', startup: 'new', exit: 1, error: null, out: '', err: 'bootstrap: no arranca' }], wait: { detached: false } }] }));
  assert.strictEqual(afterTeam['session:default-shell:startup-line-failed'], 'loses-control');
  assert.ok(Object.entries(afterTeam).some(([id, severity]) => /^doctor:fail:/.test(id) && severity === 'loses-control'));
  // un estado que no se deja leer, en la foto de después
  const blind = clone(before); blind.state = { exists: true, problem: 'el estado del arnés no es JSON' };
  assert.strictEqual(bySeverity(RP.comparePhotos(before, blind))['state:unreadable'], 'loses-control');
});

// ═══ T17 · la máquina que pregunta: lo dice en la segunda sesión ═══════════════════════════════════════════════

test('GuidedUpdate_Ask_TellsInTheSecondSession', () => {
  const published = '2031.01.01.2';
  const installed = '2031.01.01.1';
  const notice = `arnés ${published} disponible (instalada ${installed}) — para aplicarla: harness.js update --yes`;
  const session = (label, out, startupOut = '') => ({ label, form: 'default-shell', hooks: [{ hook: 'startup-line', startup: 'new', is_async: true, exit: 0, error: null, out: startupOut, err: '' }, { hook: '@tcg:branch-guard-notice.js', startup: null, exit: 0, error: null, out, err: '' }] });
  const ask = (x) => GU.judgeAsk(Object.assign({ published, before: installed, after: installed }, x));
  // el aviso quedó en el estado y el hook de avisos se lo dice a la persona en la sesión siguiente: sin hallazgos
  const told = ask({ state_notice: notice, sessions: [session('una', ''), session('otra', `🔔 TYCON — aviso del mecanismo de instalación — decile a la persona: ${notice}`)] });
  assert.deepStrictEqual(told.findings, []);
  assert.deepStrictEqual([told.what_the_dev_is_told.state_notice, told.what_the_dev_is_told.hook_said.includes(`decile a la persona: arnés ${published}`)], [notice, true]);
  // en el estado, y ningún hook lo dice
  const silent = ask({ state_notice: notice, sessions: [session('una', ''), session('otra', 'otra cosa que no es el aviso')] });
  assert.deepStrictEqual(bySeverity(silent.findings), { 'update:ask:notice-not-shown': 'loses-control' });
  assert.deepStrictEqual([silent.what_the_dev_is_told.state_notice, silent.what_the_dev_is_told.hook_said], [notice, null]);
  // sin aviso en el estado
  const none = ask({ state_notice: null, sessions: [session('una', ''), session('otra', '')] });
  assert.deepStrictEqual(bySeverity(none.findings), { 'update:ask:no-notice': 'loses-control' });
  // no actualizarse sola NO es un hallazgo acá: es lo que tiene que hacer una máquina que pregunta
  assert.ok(![...told.findings, ...silent.findings, ...none.findings].some((f) => /not-applied|not-updated/.test(f.id)));
  // el aviso dicho en la PRIMERA sesión no cuenta: se mira la sesión siguiente a la que miró la red
  const early = ask({ state_notice: notice, sessions: [session('una', `decile a la persona: ${notice}`), session('otra', '')] });
  assert.deepStrictEqual(bySeverity(early.findings), { 'update:ask:notice-not-shown': 'loses-control' });
  // lo que imprime la propia LÍNEA DE ARRANQUE no cuenta: quedó registrada como trabajo de fondo y su salida no llega a
  // la persona
  const onlyStartup = ask({ state_notice: notice, sessions: [session('una', ''), session('otra', '', `decile a la persona: ${notice}`)] });
  assert.deepStrictEqual(bySeverity(onlyStartup.findings), { 'update:ask:notice-not-shown': 'loses-control' });
  // «el aviso de versión nueva» es el que NOMBRA la versión publicada. El estado guarda ahí también que no pudo mirar
  // la red, o que el permiso venció: con eso la persona no se entera de que hay una versión, aunque un hook lo repita
  for (const other of ['el permiso de GitHub guardado venció o se revocó (401). creá un permiso nuevo', 'la ref main contestó 500', 'la política de actualización está mal escrita (apply: quizás): no se actualiza hasta arreglarla', 'finales de línea: 3 guiones con CRLF']) {
    const wrong = ask({ state_notice: other, sessions: [session('una', ''), session('otra', `🔔 TYCON — aviso del mecanismo de instalación — decile a la persona: ${other}`)] });
    assert.deepStrictEqual(bySeverity(wrong.findings), { 'update:ask:no-notice': 'loses-control' }, other);
    assert.match(wrong.findings[0].detail, /otro aviso/);
  }
  // y un hook que habla de «versión» sin nombrar la publicada (la de retención, por ejemplo) tampoco es el aviso
  const retention = ask({ state_notice: notice, sessions: [session('una', ''), session('otra', '🔔 TYCON — decile a la persona: se deshizo la versión que estaba a medio aplicar')] });
  assert.deepStrictEqual(bySeverity(retention.findings), { 'update:ask:notice-not-shown': 'loses-control' });
  // la máquina que pregunta y CAMBIA SOLA de versión: ése es el hallazgo, con su nombre — y no «no hay aviso» (al
  // aplicar, el programa borra el aviso: decir que «la persona no tiene de dónde enterarse» sería otro diagnóstico)
  for (const left of [null, notice]) {
    const alone = ask({ state_notice: left, after: published, sessions: [session('una', ''), session('otra', '')] });
    assert.deepStrictEqual(bySeverity(alone.findings), { 'update:ask:applied-by-itself': 'loses-control' });
    assert.ok(alone.findings[0].detail.includes(`${installed} → ${published}`));
  }
  // el comando a mano, lanzado SIN una terminal: el programa se niega (aplicar lo decide una persona) y la máquina no
  // cambia. Eso es lo esperado: no es un hallazgo
  const refused = GU.judgeByHand({ exit: 2, error: null, said: 'harness.js update: `--yes` necesita una terminal, o `apply: auto` en la configuración (la política es «ask»: aplicar una versión nueva lo decide una persona)', version_before: installed, version_after: installed });
  assert.deepStrictEqual([refused.findings, refused.refused_cleanly], [[], true]);
  // si aplicó igual, sin una persona delante: pierde un control
  const applied = GU.judgeByHand({ exit: 0, error: null, said: `versión: ${published}`, version_before: installed, version_after: published });
  assert.deepStrictEqual(bySeverity(applied.findings), { 'update:ask:applied-without-a-person': 'loses-control' });
  assert.strictEqual(applied.refused_cleanly, false);
  // se negó sin decir que hace falta una terminal (o ni arrancó): no cambió nada, pero no es «se negó limpio»
  const unclear = GU.judgeByHand({ exit: 1, error: null, said: 'TypeError: Cannot read properties of undefined', version_before: installed, version_after: installed });
  assert.deepStrictEqual([unclear.findings, unclear.refused_cleanly], [[], false]);
  // y aplicar a mano, con una persona en una terminal, está en la lista de lo no ensayado
  assert.ok(G.notRehearsed(G.loadManifest()).some((n) => /update --yes/.test(n.what) && /terminal/.test(n.why)));
  // «el hook no dijo nada» y «no se llegó a mirar los hooks» no son lo mismo: el reporte los distingue por este dato
  assert.deepStrictEqual([told.what_the_dev_is_told.hook_checked, silent.what_the_dev_is_told.hook_checked, none.what_the_dev_is_told.hook_checked], [true, true, false]);
  assert.strictEqual(ask({ state_notice: notice, after: published, sessions: [session('una', ''), session('otra', '')] }).what_the_dev_is_told.hook_checked, false);
  // el número de versión leído DESPUÉS de las sesiones: sin número no es «no cambió» ni «no se actualizó» — rompe, con
  // su nombre, y dice en qué momento se leyó
  assert.deepStrictEqual(GU.judgeVersionRead({ number: installed, problem: null }, 'después de las dos sesiones'), []);
  for (const [read, said] of [[{ number: null, problem: null }, /ya no hay version\.json/], [{ number: null, problem: 'version.json no es JSON: Unexpected end' }, /no es JSON/]]) {
    const lost = GU.judgeVersionRead(read, 'después de las dos sesiones');
    assert.deepStrictEqual(bySeverity(lost), { 'version:unreadable': 'breaks' });
    assert.match(lost[0].detail, said);
    assert.match(lost[0].detail, /^después de las dos sesiones, /);
  }
  // 🔴 y los jueces son de tres estados: sin el número de después NINGUNO dice «no» — ni «no se actualizó sola» (con su
  // actualización a mano), ni «cambió sola», ni «no hay aviso», ni «se negó» / «no se negó». Lo único que sale es
  // `version:unreadable`
  const noNumber = { number: null, problem: 'version.json no es JSON' };
  const blindAuto = GU.judgeReached(noNumber, 'después de las sesiones', { expected: published, sessions: 4 });
  assert.deepStrictEqual([blindAuto.number, blindAuto.reached, blindAuto.by_hand, bySeverity(blindAuto.findings)], [null, null, false, { 'version:unreadable': 'breaks' }]);
  const reachedIt = GU.judgeReached({ number: published, problem: null }, 'después de las sesiones', { expected: published, sessions: 4 });
  assert.deepStrictEqual([reachedIt.reached, reachedIt.by_hand, reachedIt.findings], [true, false, []]);
  const stayed = GU.judgeReached({ number: installed, problem: null }, 'después de las sesiones', { expected: published, sessions: 4 });
  assert.deepStrictEqual([stayed.reached, stayed.by_hand, bySeverity(stayed.findings)], [false, true, { 'version:not-applied': 'loses-control' }]);
  assert.match(stayed.findings[0].detail, /después de 4 sesión\(es\)/);
  const blindAsk = GU.judgeAsk({ state_notice: null, sessions: [session('una', ''), session('otra', '')], published, before: installed, after: null });
  assert.deepStrictEqual([blindAsk.findings, blindAsk.cannot_tell, blindAsk.what_the_dev_is_told.hook_checked], [[], true, false]);
  const blindHand = GU.judgeByHand({ exit: 2, error: null, said: '`--yes` necesita una terminal', version_before: installed, version_after: null });
  assert.deepStrictEqual([blindHand.findings, blindHand.refused_cleanly], [[], null]);
  const blindPwsh = GU.judgePwshMissing({ updated: null, sessions: [session('una', '')], doctor: { readable: true, fail: [], warn: [], ok: [] } });
  assert.deepStrictEqual(blindPwsh.findings, []);
  // la versión de antes: si no quedó instalada con los comandos de la página, no hay actualización que ensayar — rompe
  assert.deepStrictEqual(GU.judgeInstalled({ wanted: installed, read: { number: installed, problem: null } }), []);
  for (const [read, said] of [[{ number: null, problem: null }, /que no hay versión/], [{ number: null, problem: 'version.json no es JSON' }, /no es JSON/], [{ number: '2030.01.01.9', problem: null }, /2030\.01\.01\.9/]]) {
    const not = GU.judgeInstalled({ wanted: installed, read });
    assert.deepStrictEqual(bySeverity(not), { 'install-failed': 'breaks' });
    assert.match(not[0].detail, said);
  }
});

// ═══ T18 · sin pwsh: si no se actualizó, se dice; y si nadie lo avisa, también ═════════════════════════════════

test('GuidedUpdate_PwshMissing_ReportsNotUpdatedAndSilence', () => {
  const session = (out, err, exit = 127, notice = '') => ({ label: 'sin-pwsh-1', form: 'bash-c', hooks: [{ hook: 'startup-line', startup: 'new', exit, error: null, out, err }, { hook: '@tcg:session-notice.js', startup: null, exit: 0, error: null, out: notice, err: '' }] });
  const healthy = { readable: true, fail: [], warn: [], ok: ['requisitos: node'] };
  // no se actualizó y nadie dijo nada: los dos hallazgos
  const silent = GU.judgePwshMissing({ updated: false, sessions: [session('', '')], doctor: healthy });
  assert.deepStrictEqual(bySeverity(silent.findings), { 'update:pwsh-missing:not-updated': 'loses-control', 'update:pwsh-missing:silent': 'loses-control' });
  assert.deepStrictEqual(silent.something_tells, { hook: null, doctor: null });
  // no se actualizó, pero doctor marca el requisito que falta: uno solo
  const flagged = GU.judgePwshMissing({ updated: false, sessions: [session('', '')], doctor: { readable: true, fail: ['falta PowerShell 7 (pwsh) en el PATH'], warn: [], ok: [] } });
  assert.deepStrictEqual(bySeverity(flagged.findings), { 'update:pwsh-missing:not-updated': 'loses-control' });
  assert.match(flagged.something_tells.doctor, /pwsh/);
  // o lo dice algún hook de la sesión (uno que no es la línea de arranque: su salida sí llega a la persona)
  const said = GU.judgePwshMissing({ updated: false, sessions: [session('', '', 127, '🔔 TYCON — el arnés no se está actualizando: falta pwsh en el PATH')], doctor: healthy });
  assert.deepStrictEqual(bySeverity(said.findings), { 'update:pwsh-missing:not-updated': 'loses-control' });
  assert.match(said.something_tells.hook, /pwsh/);
  // 🔴 el error del SHELL al no encontrar pwsh NO es un aviso: lo imprime la línea de arranque (que es trabajo de fondo,
  // la persona no lo ve) y nombra a `pwsh` en toda máquina. Si contara, esta variante nunca diría «nadie avisa»
  for (const shellError of ['bash: pwsh: command not found', '/bin/sh: 1: pwsh: not found', "'pwsh' is not recognized as an internal or external command"]) {
    const shell = GU.judgePwshMissing({ updated: false, sessions: [session('', shellError)], doctor: healthy });
    assert.deepStrictEqual(bySeverity(shell.findings), { 'update:pwsh-missing:not-updated': 'loses-control', 'update:pwsh-missing:silent': 'loses-control' }, shellError);
    assert.match(shell.findings[0].detail, /pwsh/, 'lo que devolvió la línea de arranque queda escrito en el hallazgo');
  }
  // se actualizó igual: ningún hallazgo
  assert.deepStrictEqual(GU.judgePwshMissing({ updated: true, sessions: [session('', '', 0)], doctor: healthy }).findings, []);
  // cada hook de arranque, con lo que devolvió
  assert.deepStrictEqual(silent.startup_hooks.map((h) => [h.form, h.exit]), [['bash-c', 127]]);
  // «sólo PowerShell 5.1» no es una variante de la actualización: es esta misma máquina, y el reporte lo dice en una línea
  // (`no-pack` es la máquina sin la capa ni paquetes activos de la prueba de actualización de los paquetes;
  // `two-sessions`, la de dos sesiones a la vez con settings.json tomado)
  assert.deepStrictEqual(GU.VARIANTS.map((v) => v.id), ['auto', 'ask', 'pwsh-missing', 'no-pack', 'two-sessions']);
  assert.match(GU.SAME_MACHINE_NOTE, /5\.1/);
  assert.match(GU.SAME_MACHINE_NOTE, /pwsh-missing/);
  const md = rehearse.renderMarkdown({ run: { scenario: 'update', expected_steps: ['inventory', 'update'] }, steps: [{ name: 'update', status: 'measured', findings: [], facts: { guided: true, same_machine_note: GU.SAME_MACHINE_NOTE, variants: {} } }], verdict: { color: 'green', errors: [], missing_steps: [], not_measured: [], by_severity: { breaks: 0, 'loses-control': 0, noise: 0, unrated: 0 } } });
  assert.ok(md.includes(GU.SAME_MACHINE_NOTE), 'para que nadie la busque');
});

// ═══ T19 · los dos ensayos eligen por lo que el árbol ES ═══════════════════════════════════════════════════════

const TOY_TAG = 'retorno/2030-01-01-de-juguete';
/** Un repo de juguete de un solo árbol y su checkout como lo deja un agente. `{ origin, checkout }`. */
function toyTree(base, name, { friday = {}, today = {} } = {}) {
  const origin = path.join(base, `${name}-origin`);
  fs.mkdirSync(origin, { recursive: true });
  git(['init', '-q', '-b', 'main'], origin);
  const commit = (files, message) => { write(origin, files); git(['add', '-A'], origin); assert.strictEqual(git(['commit', '-q', '-m', message], origin).status, 0, `no pude armar «${message}»`); return git(['rev-parse', 'HEAD'], origin).stdout.trim(); };
  commit(Object.assign({ 'README.md': '# arnés de juguete\n', 'scripts/a.sh': '#!/bin/sh\nexit 0\n' }, friday), 'antes');
  git(['tag', TOY_TAG], origin);
  const head = commit(Object.assign({ 'scripts/b.sh': '#!/bin/sh\nexit 0\n' }, today), 'lo que se ensaya');
  const checkout = path.join(base, `${name}-checkout`);
  fs.mkdirSync(checkout, { recursive: true });
  git(['init', '-q'], checkout);
  git(['remote', 'add', 'origin', origin], checkout);
  assert.strictEqual(git(['fetch', '-q', '--tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'], checkout).status, 0);
  assert.strictEqual(git(['checkout', '-q', '--detach', head], checkout).status, 0);
  return { origin, checkout, head };
}
const TWO_CLONES_DOC = [
  '## PASO 1 — Clonar los dos repos compartidos', '', '```powershell', 'git clone https://example.com/acme/arnes-lab "$env:USERPROFILE\\SourceCode\\arnes-lab"', '```', '', '```powershell', 'git clone https://example.com/acme/skills-lab agent-skills', '```', '',
  '## PASO 2 — Los enlaces', '', '```powershell', 'cmd /c mklink /J agents x', '```', '',
  '## PASO 3 — El import', '', '```powershell', 'Add-Content CLAUDE.md "@x"', '```', '',
  '## PASO 4 — La línea de arranque', '', '```json', '"SessionStart": [{ "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File x/install-tycon-hooks.ps1", "async": true }] }]', '```', '',
  '- Windows: `pwsh -NoProfile -ExecutionPolicy Bypass -File "x\\install-tycon-hooks.ps1"`', '',
  '## PASO 9 — Verificación final', '', '```powershell', 'Write-Output ok', '```', '', '═══ FIN DEL PROMPT ═══', '',
].join('\n');
const NO_CLONE_DOC = ['## PASO 1 — La versión instalada del arnés (sin clonar)', '', 'El arnés vive en `~/.tycon/harness`: lo dejó el guion de entrada.', '', '## PASO 2 — Lo que dejó el instalador', '', '═══ FIN DEL PROMPT ═══', ''].join('\n');
const NO_CLONE_REASON = 'el alta sin clon se ensaya contra una copia publicada (la fuente github): el árbol interno no trae la página ni el guion de entrada en su lugar';

test('Probes_ChooseByWhatTheTreeIs', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('t19');
  try {
    const run = (toy, name, scenario) => {
      const src = path.join(base, `${name}-sources`); const lab = path.join(base, `${name}-lab`); const out = path.join(base, `${name}-out`);
      const built = node([path.join(DIR, 'build-sources.js'), '--output', src, '--harness', toy.checkout, '--single-repo', '--friday-tag', TOY_TAG]);
      assert.strictEqual(built.status, 0, built.stderr);
      const r = node([path.join(DIR, 'rehearse.js'), 'all', '--lab', lab, '--out', out, '--sources', src, '--scenario', scenario, '--allow-temp'], { timeout: 300000 });
      const report = JSON.parse(fs.readFileSync(path.join(out, 'windows-report.json'), 'utf8'));
      return { r, lab, report, step: (n) => report.steps.find((s) => s.name === n) };
    };
    // ── un árbol con version.json (una copia publicada) y SIN la página: eligió el ensayo nuevo, que no puede ensayar
    const copy = run(toyTree(base, 'copy', { friday: { 'version.json': '{ "version": "2026.01.01.1" }\n' } }), 'copy', 'all');
    for (const name of ['update', 'onboarding']) {
      assert.strictEqual(copy.step(name).status, 'error', `${name}: ${copy.step(name).reason}`);
      assert.match(copy.step(name).reason, /no pude ensayar/);
      assert.match(copy.step(name).reason, /getting-started\/windows\.md/, 'dice lo que buscó');
      assert.match(copy.step(name).reason, /copia publicada/);
      assert.doesNotMatch(copy.step(name).reason, /texto del alta del equipo|sin una marca/, 'no pasó por el ensayo de antes');
    }
    assert.ok(!fs.existsSync(path.join(copy.lab, 'users')) || !fs.readdirSync(path.join(copy.lab, 'users')).length, 'sin instalar nada');
    assert.deepStrictEqual([copy.report.verdict.color, copy.r.status], ['red', 1], 'en una copia publicada esos archivos tienen que estar: rojo, no «con avisos»');
    // ── una copia publicada con la página y sin el paquete de npm: lo mismo, por el camino entero (el paso del
    // pipeline, no la función suelta), diciendo qué buscó
    const noScript = run(toyTree(base, 'no-script', { friday: { 'version.json': '{ "version": "2026.01.01.1" }\n', 'getting-started/windows.md': toyPage('guided-page-ok.md'), 'scripts/setup/public-remotes.json': TOY_REMOTES } }), 'no-script', 'onboarding');
    assert.strictEqual(noScript.step('onboarding').status, 'error', noScript.step('onboarding').reason);
    assert.match(noScript.step('onboarding').reason, /no pude ensayar: .*el paquete de npm.*scripts\/setup\/npm\/package\.json/);
    assert.match(noScript.step('onboarding').reason, /copia publicada/);
    assert.ok(!fs.existsSync(path.join(noScript.lab, 'users')) && !fs.existsSync(path.join(noScript.lab, 'guided')), 'sin instalar nada y sin levantar ningún servidor');
    assert.deepStrictEqual([noScript.report.verdict.color, noScript.r.status], ['red', 1]);
    // y con la página SIN su marca
    const page = toyPage('guided-page-ok.md').replace('<!-- guided:base -->\n', '').replace('<!-- /guided:base -->\n', '');
    const noMark = run(toyTree(base, 'no-mark', { friday: { 'version.json': '{ "version": "2026.01.01.1" }\n', 'getting-started/windows.md': page, 'scripts/setup/npm/package.json': '{ "name": "@tyconsa/harness", "version": "1.0.2" }\n', 'scripts/setup/public-remotes.json': TOY_REMOTES } }), 'no-mark', 'onboarding');
    assert.deepStrictEqual([noMark.step('onboarding').status, /la marca.*guided:base/.test(noMark.step('onboarding').reason)], ['error', true], noMark.step('onboarding').reason);
    // ── el árbol interno con el texto de dos clones: el ensayo común, sin cambios (acá, su error de siempre)
    const two = run(toyTree(base, 'two', { friday: { 'onboarding/new-dev-harness-setup.md': TWO_CLONES_DOC, 'onboarding/step-0-windows.md': 'sin clon en el paso cero\n' } }), 'two', 'all');
    for (const name of ['update', 'onboarding']) {
      assert.strictEqual(two.step(name).status, 'error');
      assert.match(two.step(name).reason, /texto del alta es de dos clones y el laboratorio trae un solo repo/);
    }
    // ── el árbol interno con el texto sin clon: «no medido», con el motivo nuevo, entero
    const none = run(toyTree(base, 'none', { friday: { 'onboarding/new-dev-harness-setup.md': NO_CLONE_DOC, 'onboarding/step-0-windows.md': 'sin clon\n' } }), 'none', 'all');
    assert.deepStrictEqual([none.step('onboarding').status, none.step('onboarding').reason], ['not-measured', NO_CLONE_REASON]);
    assert.deepStrictEqual([none.step('update').status, none.step('update').reason], ['not-measured', `en el commit del viernes, ${NO_CLONE_REASON}`]);
    assert.strictEqual(T.parseTeamDoc(NO_CLONE_DOC, '').not_measured, NO_CLONE_REASON);
    assert.deepStrictEqual([none.report.verdict.color, none.report.verdict.nothing_measured], ['green', true]);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T20 · una copia publicada sin lo que tiene que traer es un error ══════════════════════════════════════════

test('PublishedCopy_WithoutWhatItMustBring_IsAnError', () => {
  const m = G.loadManifest();
  const full = { 'getting-started/windows.md': toyPage('guided-page-ok.md'), 'scripts/setup/npm/package.json': '{ "name": "@tyconsa/harness", "version": "1.0.2" }\n', 'scripts/setup/public-remotes.json': TOY_REMOTES };
  const reader = (files) => (rel) => (rel in files ? files[rel] : null);
  assert.strictEqual(G.prepare({ read: reader(full), manifest: m }).problem, undefined);
  const without = (rel) => { const f = Object.assign({}, full); delete f[rel]; return G.prepare({ read: reader(f), manifest: m }); };
  const cases = [
    [without('getting-started/windows.md'), /la página.*getting-started\/windows\.md/],
    [G.prepare({ read: reader(Object.assign({}, full, { 'getting-started/windows.md': full['getting-started/windows.md'].replace('<!-- guided:base -->\n', '').replace('<!-- /guided:base -->\n', '') })), manifest: m }), /la marca.*guided:base.*getting-started\/windows\.md/],
    [without('scripts/setup/npm/package.json'), /el paquete de npm.*scripts\/setup\/npm\/package\.json/],
    [without('scripts/setup/public-remotes.json'), /scripts\/setup\/public-remotes\.json/],
  ];
  for (const [got, rx] of cases) {
    assert.match(got.problem, rx, 'dice lo que buscó y dónde');
    assert.match(got.problem, /copia publicada/);
    const result = GI.notReady(got.problem);
    assert.deepStrictEqual([result.status, /^no pude ensayar: /.test(result.reason)], [L.STATUS.error, true], 'nunca «no medido»');
  }
  // y si quien lee no puede leer (git falló), tampoco es «no está»: el problema sube tal cual
  assert.match(G.prepare({ read: () => { throw new Error('git show salió 128'); }, manifest: m }).problem, /git show salió 128/);

  // ── el motivo de «no pude ensayar» también pasa por el tapador: cuando la página y la ficha no coinciden, el motivo
  // cita comandos de la página, que traen la organización y el nombre del repo público
  const differs = G.prepare({ read: reader(Object.assign({}, full, { 'getting-started/windows.md': toyPage('guided-page-changed.md') })), manifest: m });
  assert.deepStrictEqual(differs.names, TOY_NAMES, 'los nombres van con el problema, para poder taparlo');
  if (has('git') && process.platform !== 'win32') {
    const base = tmp('t20');
    try {
      const lab = path.join(base, 'lab');
      fs.mkdirSync(lab, { recursive: true });
      const stateOf = (toy) => ({ remotes: { harness: { dir: toy.origin, target: toy.head } } });
      const published = { 'version.json': '{ "version": "2026.01.01.1" }\n', 'scripts/setup/npm/package.json': '{ "name": "@tyconsa/harness", "version": "1.0.2" }\n', 'scripts/setup/public-remotes.json': TOY_REMOTES };
      // la página cambió el comando de instalar: no se levanta nada, y el motivo no nombra el repo
      const moved = toyPage('guided-page-changed.md');
      assert.notStrictEqual(moved, toyPage('guided-page-ok.md'), 'la página de juguete cambiada es otra');
      const changed = GI.openLab({ lab, name: 'onboarding', state: stateOf(toyTree(base, 'changed', { today: Object.assign({ 'getting-started/windows.md': moved }, published) })) });
      if (!changed.problem && changed.stop) changed.stop();   // (si calzara, no quedan servidores vivos colgando la prueba)
      assert.match(changed.problem, /la página .* y la ficha del ensayo no coinciden/);
      assert.match(changed.problem, /install/);
      assert.ok(!changed.problem.includes(TOY_NAMES.org) && !changed.problem.includes(TOY_NAMES.repo), `el motivo no trae la organización ni el nombre del repo público: ${changed.problem}`);
      assert.ok(!fs.existsSync(path.join(lab, 'guided')), 'y no se levantó nada');
      // ── con el laboratorio abierto, quien no puede seguir armándolo lo descarta: cierra lo levantado y saca la
      // carpeta, para que el paso se pueda volver a intentar (y el motivo sale tapado)
      const stopped = [];
      const fake = (which) => () => ({ url: `http://127.0.0.1:1/${which}`, stop: () => stopped.push(which) });
      const good = stateOf(toyTree(base, 'good', { today: Object.assign({ 'getting-started/windows.md': toyPage('guided-page-ok.md') }, published) }));
      const ctx = GI.openLab({ lab, name: 'update', state: good, start: { github: fake('github'), azure: fake('azure') } });
      assert.strictEqual(ctx.problem, undefined, ctx.problem);
      assert.ok(fs.existsSync(path.join(lab, 'guided', 'update', 'team', 'team.git')), 'el laboratorio del paso quedó armado');
      // abierto, el paso no se abre otra vez: es de una sola corrida
      assert.match(GI.openLab({ lab, name: 'update', state: good, start: { github: fake('github-2'), azure: fake('azure-2') } }).problem, /ya corrió sobre este laboratorio/);
      const why = ctx.discard(`no pude clonar https://github.com/${TOY_NAMES.org}/${TOY_NAMES.repo} para publicar`);
      assert.deepStrictEqual(stopped, ['github', 'azure'], 'cerró los dos servidores (y nunca levantó los del segundo intento)');
      assert.ok(!fs.existsSync(path.join(lab, 'guided', 'update')), 'sacó la carpeta del paso');
      assert.ok(/no pude clonar/.test(why) && !why.includes(TOY_NAMES.repo), why);
      // y entonces sí se puede volver a intentar
      const retry = GI.openLab({ lab, name: 'update', state: good, start: { github: fake('github-3'), azure: fake('azure-3') } });
      assert.strictEqual(retry.problem, undefined, retry.problem);
      retry.stop();
      // un servidor que no levanta, con el otro ya arriba: se cierra el que estaba y la carpeta se saca
      const half = GI.openLab({ lab, name: 'onboarding', state: good, start: { github: fake('github-4'), azure: () => ({ problem: 'el Azure DevOps de juguete no levantó: EACCES' }) } });
      assert.match(half.problem, /Azure DevOps de juguete no levantó/);
      assert.ok(stopped.includes('github-4') && !fs.existsSync(path.join(lab, 'guided', 'onboarding')));
      // ── cómo se sirve el repo lo decide la ficha (`lab.auth`), no el guion. Con `none` —lo que la página supone: baja
      // el guion sin credencial— el GitHub de juguete se levanta SIN permiso y el laboratorio no arma ninguno de GitHub
      // (así ningún paso puede llevarlo en su ambiente); con `token`, privado y con su permiso de juguete.
      // 🔴 Atrapa: que el guion levante el repo SIEMPRE como privado y ponga el permiso en los pasos que bajan e
      // instalan, diga lo que diga la ficha — así la bajada sin credencial da 404
      const served = [];
      const spy = (which) => (args) => { served.push({ which, token: args.token, pat: args.pat }); return { url: `http://127.0.0.1:1/${which}`, stop: () => {} }; };
      const lab2 = path.join(base, 'lab-auth');
      fs.mkdirSync(lab2, { recursive: true });
      const open = GI.openLab({ lab: lab2, name: 'onboarding', state: good, start: { github: spy('github'), azure: spy('azure') } });
      assert.strictEqual(open.problem, undefined, open.problem);
      assert.deepStrictEqual([served[0].which, served[0].token], ['github', null], 'con la ficha de hoy, el repo se sirve sin permiso');
      assert.deepStrictEqual(Object.keys(open.tokens), ['azure'], 'y el único permiso de juguete es el del Azure DevOps del equipo');
      assert.ok(served[1].pat && served[1].pat === open.tokens.azure);
      const noChanges = { env_set: {}, env_removed: [], never_set: [], always: {}, launched_with: TL.LAUNCHED_WITH };
      assert.match(GI.labChanges({ ctx: open, changes: noChanges, ps: null, env: {}, scratch: path.join(base, 'scratch-auth') }).token, /^TYCON_GITHUB_TOKEN: no se pone en ningún paso/);
      assert.match(GI.githubServing(open), /público, sin permiso/);
      open.stop();
      const closed = clone(m);
      closed.lab.auth = 'token';
      const priv = GI.openLab({ lab: lab2, name: 'update', state: good, manifest: closed, start: { github: spy('github'), azure: spy('azure') } });
      assert.strictEqual(priv.problem, undefined, priv.problem);
      assert.match(String(served[2].token), /^toy-github-[0-9a-f]{16}$/, 'con `token`, privado y con su permiso de juguete');
      assert.deepStrictEqual([Object.keys(priv.tokens).sort(), priv.tokens.github === served[2].token], [['azure', 'github'], true]);
      assert.match(GI.labChanges({ ctx: priv, changes: noChanges, ps: null, env: {}, scratch: path.join(base, 'scratch-auth') }).token, /permiso de juguete.*sólo en los pasos plan, install/);
      assert.match(GI.githubServing(priv), /privado, con un permiso de juguete/);
      priv.stop();
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

// ═══ T21 · los permisos se buscan en la salida cruda ═══════════════════════════════════════════════════════════

test('Secrets_AreSearchedInTheRawOutput', () => {
  const base = tmp('t21');
  try {
    const github = 'permiso-github-de-juguete-0123456789';
    const azure = 'permiso-azure-de-juguete-9876543210';
    const secrets = { github, azure };
    // un comando que imprime el permiso: se ve en la salida CRUDA
    const leaked = TL.guard({ stdout: `Authorization: Bearer ${github}\n`, stderr: '' }, secrets);
    assert.deepStrictEqual(leaked.leaked, ['github']);
    assert.ok(!leaked.clean.stdout.includes(github) && leaked.clean.stdout.includes(L.REDACTED_SECRET));
    const both = TL.guard({ stdout: 'nada', stderr: `PAT=${azure} y ${github}` }, secrets);
    assert.deepStrictEqual(both.leaked.slice().sort(), ['azure', 'github']);
    // uno que no: nada que decir
    assert.deepStrictEqual(TL.guard({ stdout: 'versión: 2030.04.01.1\n', stderr: '' }, secrets).leaked, []);
    // 🔴 falla si se busca después de tapar: sobre lo ya tapado, la búsqueda da siempre «no está»
    assert.deepStrictEqual(TL.guard(leaked.clean, secrets).leaked, [], 'el control: en lo tapado ya no se encuentra');
    assert.deepStrictEqual(bySeverity(TL.secretFindings(leaked.leaked, 'install')), { 'guided:secret-printed': 'breaks' });
    assert.deepStrictEqual(TL.secretFindings([], 'install'), []);
    // ningún archivo de la carpeta del reporte trae ninguno de los dos valores. El de Azure entra por la entrada estándar:
    // el tapador no lo conoce solo (no está en ninguna variable de ambiente), se le pasa a mano
    const out = path.join(base, 'out');
    const rec = L.recorder('onboarding', out);
    rec.setRedactor(TL.redactor({ secrets: [github, azure], env: { PATH: '/usr/bin' } }));
    rec.fact('commands', [{ step: 'install', out: `…${github}…`, err: `…${azure}…` }]);
    rec.note(`una nota con ${azure}`);
    rec.finding('guided:secret-printed', 'secret', `el comando imprimió ${github}`, null, { severity: 'breaks' });
    assert.ok(fs.readFileSync(L.partialFile(out, 'onboarding'), 'utf8').includes(L.REDACTED_SECRET), 'también el parcial sale tapado');
    rec.finish(L.STATUS.measured, null);
    const everything = fs.readdirSync(path.join(out, 'steps')).map((f) => fs.readFileSync(path.join(out, 'steps', f), 'utf8')).join('\n');
    assert.ok(!everything.includes(github) && !everything.includes(azure), 'ninguno de los dos valores queda escrito');
    assert.ok(everything.includes('guided:secret-printed'));
    // lo que se hace con la salida de TODO comando que el ensayo corre: buscar en la cruda y devolver la tapada, con su hallazgo
    const checked = TL.checked({ stdout: `token=${azure}\n`, stderr: '', exit: 0 }, secrets, 'la capa del equipo');
    assert.deepStrictEqual([bySeverity(checked.findings), checked.clean.stdout.includes(azure), checked.clean.exit], [{ 'guided:secret-printed': 'breaks' }, false, 0]);
    assert.match(checked.findings[0].detail, /la capa del equipo.*azure/);
    assert.deepStrictEqual(TL.checked({ stdout: 'nada', stderr: '' }, secrets, 'x').findings, []);
    // la red de abajo: lo que llega al reporte ya resumido (la foto, el humo, el diagnóstico) pasa por el tapador, que
    // mira lo que tapa
    const watch = TL.watching(TL.redactor({ secrets: [github, azure], env: {} }), secrets);
    assert.deepStrictEqual(TL.savedLeaks(watch), []);
    assert.deepStrictEqual(watch.redact({ facts: { doctor: { fail: ['nada raro'] } } }), { facts: { doctor: { fail: ['nada raro'] } } });
    assert.deepStrictEqual(TL.savedLeaks(watch), [], 'sin permisos en lo guardado, nada');
    const tapped = watch.redact({ facts: { doctor: { fail: [`el permiso guardado es ${azure}`] } } });
    assert.ok(!JSON.stringify(tapped).includes(azure), 'lo tapa igual');
    assert.deepStrictEqual(TL.savedLeaks(watch).map((f) => [f.id, f.severity]), [['guided:secret-printed:saved', 'breaks']]);
    assert.match(TL.savedLeaks(watch)[0].detail, /azure/);

    // ── la capa del equipo, contra un programa de juguete: el permiso entra SÓLO por la entrada estándar del comando
    // que la declara, y la salida de todo lo que se mira después (la versión, la configuración) también se revisa
    const home = path.join(base, 'home');
    const tree = path.join(home, '.tycon', 'harness');
    const stateFile = path.join(home, 'state.json');
    const commit = 'c'.repeat(40);
    write(tree, {
      'scripts/setup/harness.js': [
        "const fs = require('fs'); const path = require('path'); const a = process.argv.slice(2); const home = process.env.TOY_HOME; const tree = path.resolve(__dirname, '..', '..');",
        "if (a[0] === 'config' && a[1] === 'set') { const v = fs.readFileSync(0, 'utf8').trim(); fs.writeFileSync(path.join(home, 'saved-permit'), v); fs.appendFileSync(path.join(home, 'calls.log'), a.join(' ') + '\\n'); process.exit(v ? 0 : 4); }",
        `if (a[0] === 'install') { fs.appendFileSync(path.join(home, 'calls.log'), a.join(' ') + '\\n'); fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ team: { repo: 'acme/proyecto/equipo-lab', host: 'azure', commit: '${commit}' } })); fs.writeFileSync(path.join(tree, '.tycon-team.json'), JSON.stringify({ commit: '${commit}' })); fs.writeFileSync(path.join(tree, 'perfil-equipo.json'), '{}'); console.log('versión: 2030.01.01.1'); process.exit(0); }`,
        `if (a[0] === 'version') { console.log(JSON.stringify({ number: '2030.01.01.1', kind: 'release', team: { commit: '${commit}', repo: 'equipo-lab' }, debug: process.env.TOY_LEAK === '1' ? fs.readFileSync(path.join(home, 'saved-permit'), 'utf8') : '' })); process.exit(0); }`,
        "if (a[0] === 'doctor') { console.log(JSON.stringify({ mode: 'managed', fail: ['settings.json: 12 hooks del arnés ya no están registrados'], warn: [], ok: ['capa del equipo equipo-lab ccccccc'] })); process.exit(0); }",
        'process.exit(9);',
      ].join('\n'),
      // de dónde dice el programa de juguete que salen los paquetes: del perfil (lo que hace el arnés)
      // o de donde diga `TOY_PACKS_ORIGIN`
      'scripts/lib/tycon-config.js': "console.log(JSON.stringify({ origenes: { 'ado.org': 'perfil del equipo', 'integraciones.engram': 'perfil del equipo', 'paquetes.default': process.env.TOY_PACKS_ORIGIN || 'perfil del equipo' } }));\n",
    });
    const m = G.loadManifest();
    const team = (manifest, leak, packsOrigin) => {
      for (const f of ['saved-permit', 'calls.log', 'state.json']) fs.rmSync(path.join(home, f), { force: true });
      const env = Object.assign({}, process.env, { TOY_HOME: home, TOY_LEAK: leak ? '1' : '0' }, packsOrigin ? { TOY_PACKS_ORIGIN: packsOrigin } : {});
      if (!packsOrigin) delete env.TOY_PACKS_ORIGIN;
      return GI.addTeam({ ctx: { manifest, tokens: secrets, azureApi: 'http://127.0.0.1:4466', team: { commit } }, home, env, tree, paths: { file: stateFile } });
    };
    const clean = team(m, false);
    assert.strictEqual(fs.readFileSync(path.join(home, 'saved-permit'), 'utf8'), azure, 'el permiso llegó por la entrada estándar del comando que lo guarda');
    assert.deepStrictEqual(fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n'), ['config set azure.token', `install --version latest --team ${TL.TEAM_URL} --yes`], 'nunca por argumento');
    // T14 GuidedTeam_CleanRun_NoProfileOriginFinding @story-8.29 @ac-13 @ac-16 — con los paquetes saliendo del perfil
    // (el perfil del equipo gana sobre lo elegido al instalar) la capa sumada no deja ningún hallazgo…
    assert.deepStrictEqual(bySeverity(clean.findings), {}, 'la organización, las integraciones y los paquetes salen del perfil: nada que informar');
    assert.ok(Object.keys(clean.facts.profile_origin).some((k) => /^pa[a-z]*\.default$/.test(k)), 'los paquetes figuran entre lo que sale del perfil');
    // …y el chequeo no se aflojó: si los paquetes vuelven a salir de la máquina, el hallazgo vuelve a salir
    const fromMachine = team(m, false, 'máquina');
    assert.deepStrictEqual(bySeverity(fromMachine.findings), { 'guided:team:profile-origin': 'loses-control' }, 'lo que la persona eligió al instalar le ganaría al perfil: los paquetes no salen del perfil');
    assert.match(fromMachine.findings[0].detail, /los paquetes.*paquetes\.default: máquina/);
    assert.deepStrictEqual([clean.facts.state.commit, clean.facts.stacked.commit, clean.facts.doctor_line, clean.facts.doctor.fail.length], [commit, commit, 'capa del equipo equipo-lab ccccccc', 1]);
    assert.deepStrictEqual([clean.env.TYCON_AZURE_API, clean.env.TYCON_AZURE_GIT_CREDENTIAL], ['http://127.0.0.1:4466', '0']);
    // un comando de los que se miran DESPUÉS imprime el permiso: rompe, y lo guardado va tapado
    const leaking = team(m, true);
    assert.strictEqual(bySeverity(leaking.findings)['guided:secret-printed'], 'breaks');
    assert.match(leaking.findings.find((f) => f.id === 'guided:secret-printed').detail, /version --json/);
    assert.ok(!JSON.stringify(leaking.facts).includes(azure));
    // los comandos se toman por lo que son, no por su lugar en la ficha: en el otro orden, lo mismo
    const flipped = clone(m); flipped.team.commands.reverse();
    team(flipped, false);
    assert.strictEqual(fs.readFileSync(path.join(home, 'saved-permit'), 'utf8'), azure);
    assert.deepStrictEqual(fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n')[0], 'config set azure.token', 'y el del permiso corre primero');
    // ── cada cosa que el alta del equipo manda comprobar y no quedó, con su identificador y su gravedad. El programa
    // de juguete, con UNA cosa cambiada por vez (`TOY_BREAK`)
    const toy = fs.readFileSync(path.join(tree, 'scripts', 'setup', 'harness.js'), 'utf8');
    const broken = (how) => {
      const src = { 'not-stacked': toy.replace("fs.writeFileSync(path.join(tree, '.tycon-team.json')", "fs.writeFileSync(path.join(home, 'elsewhere.json')"), 'other-commit': toy.replace(`fs.writeFileSync(path.join(tree, '.tycon-team.json'), JSON.stringify({ commit: '${commit}' }))`, `fs.writeFileSync(path.join(tree, '.tycon-team.json'), JSON.stringify({ commit: '${'d'.repeat(40)}' }))`), 'no-team-in-version': toy.replace(`team: { commit: '${commit}', repo: 'equipo-lab' }, `, ''), 'no-doctor-line': toy.replace("ok: ['capa del equipo equipo-lab ccccccc']", "ok: ['requisitos: node']"), 'doctor-unreadable': toy.replace("if (a[0] === 'doctor') { console.log(", "if (a[0] === 'doctor') { console.log('no es json'); process.exit(0); console.log(") }[how];
      assert.notStrictEqual(src, toy, `el juguete «${how}» cambia algo`);
      fs.rmSync(path.join(tree, '.tycon-team.json'), { force: true }); fs.rmSync(path.join(tree, 'perfil-equipo.json'), { force: true });
      write(tree, { 'scripts/setup/harness.js': src });
      return team(m, false);
    };
    // (acá no se descuenta ningún hallazgo del origen del perfil, porque `guided:team:profile-origin` no sale: cada
    // juguete roto tiene que dar su hallazgo y ningún otro)
    const without = (findings) => bySeverity(findings);
    assert.deepStrictEqual(without(broken('not-stacked').findings), { 'guided:team:not-stacked': 'breaks' });
    assert.deepStrictEqual(without(broken('other-commit').findings), { 'guided:team:not-stacked': 'breaks' }, 'apilada con OTRO commit que el del estado tampoco vale');
    assert.deepStrictEqual(without(broken('no-team-in-version').findings), { 'guided:team:version-without-team': 'loses-control' });
    assert.deepStrictEqual(without(broken('no-doctor-line').findings), { 'guided:team:doctor-line': 'loses-control' });
    const unreadableDoctor = broken('doctor-unreadable');
    assert.deepStrictEqual(without(unreadableDoctor.findings), { 'guided:team:doctor-line': 'loses-control' });
    assert.match(unreadableDoctor.findings.find((f) => f.id === 'guided:team:doctor-line').detail, /no se pudo leer/);
    assert.strictEqual(unreadableDoctor.facts.doctor.readable, false);
    // si no se pudo guardar el permiso, el que instala no se corre (no tiene con qué) y queda dicho
    write(tree, { 'scripts/setup/harness.js': 'process.exit(7);\n' });
    const failed = team(m, false);
    assert.deepStrictEqual(bySeverity(failed.findings), { 'guided:team:install-failed': 'breaks' });
    assert.deepStrictEqual([failed.facts.commands.length, 'doctor_line' in failed.facts], [1, false]);
    // y un estado que ESTÁ y no se deja leer no es «la capa no quedó apilada»: no se pudo saber, y tira
    write(tree, { 'scripts/setup/harness.js': 'process.exit(0);\n' });
    fs.writeFileSync(stateFile, '{ "team": ');
    assert.throws(() => GI.addTeam({ ctx: { manifest: m, tokens: secrets, azureApi: 'http://127.0.0.1:4466', team: { commit } }, home, env: Object.assign({}, process.env, { TOY_HOME: home }), tree, paths: { file: stateFile } }), /no es JSON/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T22 · una variante que tira no se lleva a las demás ═══════════════════════════════════════════════════════

test('Probe_OneVariantThrows_TheOthersStillRun', () => {
  const base = tmp('t22');
  try {
    const rec = L.recorder('onboarding', path.join(base, 'out'));
    const ran = [];
    const variants = [{ id: 'first', what: 'la que tira' }, { id: 'second', what: 'la que no' }, { id: 'third', what: 'la que no corre' }];
    const result = TL.runVariants({ variants, rec, say: () => {}, run: (v, facts) => {
      ran.push(v.id);
      if (v.id === 'first') { facts.reached = 'la mitad'; throw new Error('se cayó a mitad'); }
      if (v.id === 'third') { facts.not_run = 'no hay powershell en esta máquina'; return false; }
      facts.done = true;
      return true;
    } });
    assert.deepStrictEqual(ran, ['first', 'second', 'third'], 'las demás corren igual');
    assert.deepStrictEqual([result.variants.first.threw, result.variants.first.reached, result.variants.second.done, result.variants.third.not_run], ['se cayó a mitad', 'la mitad', true, 'no hay powershell en esta máquina']);
    assert.deepStrictEqual([result.ran, result.broke], [2, ['la variante first tiró: se cayó a mitad']]);
    assert.deepStrictEqual(Object.keys(rec.step.facts.variants), ['first', 'second', 'third'], 'las tres anotadas');
    // el paso: «error» si alguna tiró, «error» si ninguna pudo correr, «medido» si corrieron
    assert.deepStrictEqual(TL.variantsStatus(result).status, L.STATUS.error);
    assert.match(TL.variantsStatus(result).reason, /no pude ensayar: la variante first tiró: se cayó a mitad/);
    assert.deepStrictEqual(TL.variantsStatus({ variants: { a: { done: true } }, ran: 1, broke: [] }), { status: L.STATUS.measured, reason: null });
    const noneRan = TL.variantsStatus({ variants: { a: { not_run: 'sin pwsh' } }, ran: 0, broke: [] });
    assert.deepStrictEqual([noneRan.status, /ninguna variante pudo correr.*a: sin pwsh/.test(noneRan.reason)], [L.STATUS.error, true]);
    // la principal del paso (`required`) que no pudo ni empezar: el paso NO ensayó, aunque otra variante haya corrido
    const specs = [{ id: 'first' }, { id: 'second', required: true }];
    const mainSkipped = TL.variantsStatus({ variants: { first: { done: true }, second: { not_run: 'no hay pwsh en esta máquina' } }, ran: 1, broke: [] }, specs);
    assert.deepStrictEqual([mainSkipped.status, /la variante second, que es la principal del paso, no corrió: no hay pwsh/.test(mainSkipped.reason)], [L.STATUS.error, true]);
    // una que no es la principal y no corrió: el paso midió, y queda dicho en su motivo (no callado)
    const sideSkipped = TL.variantsStatus({ variants: { first: { not_run: 'no hay powershell en esta máquina' }, second: { done: true } }, ran: 1, broke: [] }, specs);
    assert.deepStrictEqual([sideSkipped.status, sideSkipped.reason], [L.STATUS.measured, 'medido, pero no corrió: first: no hay powershell en esta máquina']);
    // pedida una sola variante que no es la principal, la principal no hace falta
    assert.strictEqual(TL.variantsStatus({ variants: { first: { done: true } }, ran: 1, broke: [] }, [{ id: 'first' }]).status, L.STATUS.measured);
    assert.deepStrictEqual([GI.VARIANTS.filter((v) => v.required).map((v) => v.id), GU.VARIANTS.filter((v) => v.required).map((v) => v.id)], [['guided'], ['auto']]);
    // lo que el laboratorio cambió lo anota TODA variante que corre, sin pisar a la otra: lo común una vez, lo propio
    // de cada una bajo su nombre
    const rec2 = L.recorder('onboarding', path.join(base, 'out2'));
    const labCtx = { manifest: G.loadManifest(), api: 'http://127.0.0.1:4455', raw: 'http://127.0.0.1:4457', git: 'http://127.0.0.1:4458', archive: 'http://127.0.0.1:4459', azureApi: 'http://127.0.0.1:4466', package: '/lab/guided/onboarding/package/tyconsa-harness-1.0.2.tgz' };
    const changesOf = (home) => TL.variantEnv(home, { base: { PATH: process.env.PATH || '' }, api: labCtx.api, detectPath: '/nowhere', platform: 'linux' }).lab_changes;
    const one = GI.noteLabChanges(rec2, { ctx: labCtx, v: { id: 'guided', ps: 'pwsh' }, home: '/lab/users/guided', changes: changesOf('/lab/users/guided'), ps: null, env: {}, scratch: path.join(base, 's') });
    assert.deepStrictEqual(one.by_variant, { guided: { user_folder: '/lab/users/guided', shell: 'pwsh' } });
    assert.deepStrictEqual([one.package.to, one.package.where, one.answer.step, one.launched_with, one.env_set_with_team.TYCON_AZURE_API, one.execution_policy.effective], [`npx --yes "file:${labCtx.package}"`, 'plan[0], install[0]', 'install', TL.LAUNCHED_WITH, labCtx.azureApi, null]);
    const two = GI.noteLabChanges(rec2, { ctx: labCtx, v: { id: 'guided-ps51', ps: 'powershell' }, home: '/lab/users/guided-ps51', changes: changesOf('/lab/users/guided-ps51'), ps: null, env: {}, scratch: path.join(base, 's'), own: { pwsh_removed_from: ['/usr/local/bin'] } });
    assert.strictEqual(two, one, 'el mismo dato del paso: la segunda no lo arma de nuevo');
    assert.deepStrictEqual(rec2.step.facts.lab_changes.by_variant, { guided: { user_folder: '/lab/users/guided', shell: 'pwsh' }, 'guided-ps51': { user_folder: '/lab/users/guided-ps51', shell: 'powershell', pwsh_removed_from: ['/usr/local/bin'] } });
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(L.partialFile(path.join(base, 'out2'), 'onboarding'), 'utf8')).facts.lab_changes.by_variant), ['guided', 'guided-ps51'], 'y queda en el parcial');
    // dónde tiró queda anotado: en una corrida de veinte minutos, el mensaje solo no alcanza
    assert.match(result.variants.first.threw_at, /windows-guided\.test\.js/);
    // los dos topes de la espera al trabajo desprendido, y el de un comando de la página (menor que el del paso entero:
    // un comando colgado se corta con su nombre, antes de que se corte el paso)
    assert.deepStrictEqual([TL.WAIT_CAP_MS, TL.VARIANT_WAIT_BUDGET_MS], [180000, 600000]);
    assert.ok(TL.PAGE_TIMEOUT_MS < rehearse.OWN_STEPS.onboarding.cap * 1000 && TL.PAGE_TIMEOUT_MS < rehearse.OWN_STEPS.update.cap * 1000);
    // elegir variantes por nombre: una que no existe se dice
    assert.deepStrictEqual(TL.chooseVariants(variants, ['second']).chosen.map((v) => v.id), ['second']);
    assert.match(TL.chooseVariants(variants, ['fourth']).problem, /ninguna variante se llama fourth.*first, second, third/);
    assert.strictEqual(TL.chooseVariants(variants, null).chosen.length, 3);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T23 · el git del laboratorio usa su propia carpeta de usuario ═════════════════════════════════════════════

test('ToyLab_Git_UsesItsOwnHome', { skip: (!has('git') && 'NO MEDIDO — sin git') || (process.platform === 'win32' && 'el hook de juguete es un guion de sh') }, () => {
  const base = tmp('t23');
  try {
    const lab = path.join(base, 'lab');
    fs.mkdirSync(lab, { recursive: true });
    fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
    // el remoto del laboratorio y la copia «autor»
    const work = path.join(base, 'work');
    fs.mkdirSync(work, { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    write(work, { 'version.json': '{ "version": "2026.01.01.1" }\n' });
    git(['add', '-A'], work); git(['commit', '-q', '-m', 'uno'], work);
    const bare = path.join(lab, 'remotes', 'harness.git');
    assert.strictEqual(git(['clone', '-q', '--bare', work, bare], base).status, 0);
    // la carpeta de usuario de una variante, DESPUÉS del paso git-hooks: una carpeta global de hooks, con un hook que falla
    const home = path.join(lab, 'users', 'guided');
    const hooks = path.join(home, '.git-hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const witness = path.join(base, 'hook-ran');
    fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\necho corrió > "${witness}"\nexit 1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(home, '.gitconfig'), `[core]\n\thooksPath = ${hooks}\n`);
    const variant = L.labEnv(home, { base: process.env });
    const own = TL.gitEnv(lab, { base: process.env });
    assert.ok(!L.samePath(own.HOME, home) && L.isInside(own.HOME, lab), 'una carpeta de usuario propia del laboratorio, nunca la de la variante');
    const author = path.join(base, 'author');
    assert.strictEqual(TL.git(base, ['clone', '--quiet', bare, author], own).exit, 0);
    // el control: con la carpeta de la variante, el hook corre y el commit no sale
    fs.writeFileSync(path.join(author, 'CHANGES'), 'x\n');
    TL.git(author, ['add', '-A'], variant);
    assert.notStrictEqual(TL.git(author, ['commit', '-q', '-m', 'con la carpeta de la variante'], variant).exit, 0, 'el juguete: ese hook frena un commit');
    assert.ok(fs.existsSync(witness));
    fs.rmSync(witness);
    // publicar una versión con el git del laboratorio: sale 0 y el hook no corrió
    const published = TL.publish({ author, number: '2031.01.01.1', env: own });
    assert.deepStrictEqual([published.ok, published.reason], [true, undefined]);
    assert.ok(!fs.existsSync(witness), 'los hooks del arnés no corren sobre los clones del laboratorio');
    assert.strictEqual(git(['rev-parse', 'refs/heads/main'], bare).stdout.trim(), published.commit);
    assert.strictEqual(JSON.parse(git(['show', 'main:version.json'], bare).stdout).version, '2031.01.01.1');
    // 🔴 tampoco si quien lanza el ensayo trae variables con que git ubica su configuración: apuntadas a la de la
    // variante (con su hook que falla), el git del laboratorio no las hereda
    const launcher = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks, XDG_CONFIG_HOME: home });
    const seeded = TL.gitEnv(lab, { base: launcher });
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) assert.ok(seeded[k] !== launcher[k], `${k} de quien lanza no llega al git del laboratorio`);
    assert.strictEqual(TL.publish({ author, number: '2031.01.01.2', env: seeded }).ok, true);
    assert.ok(!fs.existsSync(witness), 'con esas variables en quien lanza, el hook tampoco corrió');
    // el control: con esas variables SIN borrar, ese hook frena el commit (así se sabe que la prueba puede fallar)
    fs.writeFileSync(path.join(author, 'CHANGES'), 'y\n');
    TL.git(author, ['add', '-A'], launcher);
    assert.notStrictEqual(TL.git(author, ['commit', '-q', '-m', 'con las variables de quien lanza'], launcher).exit, 0);
    assert.ok(fs.existsSync(witness));
    fs.rmSync(witness);
    TL.git(author, ['reset', '-q', '--hard', 'HEAD'], own);
    // el número de la versión siguiente es siempre mayor que el de lo que se ensaya, sea real o de una copia sellada
    assert.deepStrictEqual([TL.nextVersion('2026.10.10.5', 1), TL.nextVersion('2030.01.01.1', 2), TL.nextVersion(null, 1)], ['2030.01.01.1', '2031.01.01.2', '2030.01.01.1']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T24 · cada guion deja el remoto del laboratorio en el commit que se ensaya ════════════════════════════════

test('Probes_LeaveTheLabRemoteOnTheRehearsedCommit', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('t24');
  try {
    const lab = path.join(base, 'lab');
    fs.mkdirSync(lab, { recursive: true });
    const work = path.join(base, 'work');
    fs.mkdirSync(work, { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    write(work, { 'version.json': '{ "version": "2026.01.01.1" }\n' });
    git(['add', '-A'], work); git(['commit', '-q', '-m', 'lo que se ensaya'], work);
    const target = git(['rev-parse', 'HEAD'], work).stdout.trim();
    const bare = path.join(lab, 'remotes', 'harness.git');
    assert.strictEqual(git(['clone', '-q', '--bare', work, bare], base).status, 0);
    const state = { remotes: { harness: { dir: bare, target, friday: null, base: null } } };
    const env = TL.gitEnv(lab, { base: process.env });
    const main = () => git(['rev-parse', 'refs/heads/main'], bare).stdout.trim();
    const author = path.join(base, 'author');
    TL.git(base, ['clone', '--quiet', bare, author], env);
    // otro guion (el de la actualización, que corre antes en `all`) dejó publicaciones encima
    assert.strictEqual(TL.publish({ author, number: '2031.01.01.1', env }).ok, true);
    assert.notStrictEqual(main(), target, 'el juguete: el remoto quedó movido');
    let inside = null;
    const result = TL.onRehearsedCommit(state, env, () => {
      inside = main();
      // y este guion publica en el medio
      const author2 = path.join(base, 'author2');
      TL.git(base, ['clone', '--quiet', bare, author2], env);
      assert.strictEqual(TL.publish({ author: author2, number: '2031.01.01.2', env }).ok, true);
      assert.notStrictEqual(main(), target);
      return { status: 'measured', reason: null };
    });
    assert.strictEqual(inside, target, 'al empezar: main en el commit que se ensaya');
    assert.strictEqual(main(), target, 'al terminar: también');
    assert.deepStrictEqual(result, { status: 'measured', reason: null });
    // si el guion tira, el remoto queda igual en su lugar (y el error sube)
    TL.publish({ author, number: '2031.01.01.3', env: Object.assign({}, env) });
    assert.throws(() => TL.onRehearsedCommit(state, env, () => { throw new Error('se cayó'); }), /se cayó/);
    assert.strictEqual(main(), target);
    // y si no se puede apuntar, no se ensaya: es «no pude ensayar»
    const broken = TL.onRehearsedCommit({ remotes: { harness: { dir: path.join(base, 'no-such.git'), target } } }, env, () => ({ status: 'measured', reason: null }));
    assert.deepStrictEqual([broken.status, /^no pude ensayar: /.test(broken.reason)], [L.STATUS.error, true]);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T25 · los topes, el corte a los 40 minutos y ninguna credencial ═══════════════════════════════════════════

test('Rehearsal_Caps_TheFortyMinuteCut_AndNoCredentials', { skip: !fs.existsSync(PIPELINE) && 'NO MEDIDO — este árbol no trae pipelines/azure-pipelines-windows.yml (vive en el repo del equipo)' }, () => {
  assert.deepStrictEqual([rehearse.OWN_STEPS.onboarding.cap, rehearse.OWN_STEPS.update.cap], [1200, 1500]);
  const src = fs.readFileSync(PIPELINE, 'utf8').replace(/\r\n/g, '\n');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const start = code.indexOf('  - job: Rehearsal');
  assert.ok(start > 0);
  // el trabajo termina donde empieza el siguiente: un trabajo nuevo detrás no le cambia la cuenta
  const next = code.indexOf('\n  - job: ', start + 1);
  const job = code.slice(start, next < 0 ? undefined : next);
  // el trabajo corta a los 40 minutos cuando el escenario es onboarding o update; los demás conservan su tope
  assert.match(job, /\$\{\{ if in\(parameters\.scenario, 'onboarding', 'update'\) \}\}:\n\s+timeoutInMinutes: 40\n/);
  assert.match(job, /\$\{\{ if not\(in\(parameters\.scenario, 'onboarding', 'update'\)\) \}\}:\n\s+timeoutInMinutes: 150\n/);
  assert.strictEqual((job.match(/timeoutInMinutes:/g) || []).length, 2, 'un tope por rama de la condición, y ninguno más en el trabajo');
  // el reporte y el veredicto corren igual después del corte
  const stepOf = (needle) => { const i = job.indexOf(needle); assert.ok(i > 0, needle); return job.slice(i, job.indexOf('\n\n', i) < 0 ? undefined : job.indexOf('\n\n', i)); };
  for (const needle of ['rehearse.js finish ', 'PublishPipelineArtifact@1', 'rehearse.js verdict ']) assert.match(stepOf(needle), /condition: always\(\)/, `${needle.trim()} corre siempre`);
  // el trabajo del ensayo sigue sin recibir ninguna credencial: los permisos de juguete se arman dentro del guion
  assert.doesNotMatch(job, /AccessToken|windowsSessionCredential|\$\(\w*(Token|Secret|Password|Credential)\w*\)/i);
  assert.doesNotMatch(job, /TYCON_GITHUB_TOKEN|TYCON_AZURE|azure\.token|github\.token/, 'ni una variable del permiso de juguete en el YAML');
  // y los guiones lo arman solos: nada de leerlo del ambiente de quien lanza
  for (const f of ['guided-install.js', 'guided-update.js', 'toy-lab.js']) assert.doesNotMatch(fs.readFileSync(path.join(DIR, f), 'utf8'), /process\.env\.(TYCON_GITHUB_TOKEN|TYCON_AZURE_PAT|SYSTEM_ACCESSTOKEN)/, f);
  assert.match(TL.toyToken('github'), /^[a-z0-9-]{20,}$/);
  assert.notStrictEqual(TL.toyToken('github'), TL.toyToken('azure'));
  // la cabecera cuenta los dos ensayos como son
  assert.match(src, /página pública/);
  assert.match(src, /40 minutos/);
});

// ═══ T26 · el reporte de una corrida guiada ════════════════════════════════════════════════════════════════════

function guidedReport() {
  const command = (step, text, exit, expected) => ({ step, runs: 'machine', text, exit, error: null, seconds: 1.2, expected, out: 'ok' });
  const session = (label, form, detached, waited_ms, ended_by) => ({ label, form, shell: '/bin/sh -c', hooks: [{ hook: 'startup-line', startup: 'new', exit: 0, error: null, ms: 900, out: '', err: '' }], wait: { detached, waited_ms, ended_by }, version: '2026.10.10.5' });
  const labChangesOf = (byVariant) => ({ download_origin: { from: 'https://raw.githubusercontent.com', to: 'http://127.0.0.1:4457', where: 'download[0]' }, token: 'TYCON_GITHUB_TOKEN: no se pone en ningún paso (el GitHub de juguete sirve el repo como público, sin permiso)', env_set: { TYCON_RELEASE_API: 'http://127.0.0.1:4455' }, env_removed: ['TYCON_CODEX'], never_set: TL.ENV_NEVER, always: { GIT_TERMINAL_PROMPT: '0' }, launched_with: TL.LAUNCHED_WITH, execution_policy: { launched_with: 'Bypass', effective: 'Bypass' }, by_variant: byVariant });
  const labChanges = labChangesOf({ guided: { user_folder: '/lab/users/guided', shell: 'pwsh' } });
  const notRehearsed = [{ step: 'report', what: 'el bloque de texto con el resultado del alta', why: 'armar el reporte lo hace el asistente con la persona' }, { step: null, what: 'la parte 2 de la página', why: 'todos sus pasos piden a la persona o salen a la red de verdad' }];
  const onboarding = { name: 'onboarding', status: 'measured', reason: null, wall_seconds: 240, cap_s: 1200, notes: ['una nota del ensayo, que el reporte muestra'], findings: [{ id: 'onboarding:guided:guided:expected:verify', kind: 'page', detail: 'verify: la cuenta de skills dio 12 y la página espera más de 40', severity: 'breaks', variant: 'guided' }], facts: {
    guided: true, lab_mode: true, rehearsed_version: '2030.06.01.1', page: { file: 'getting-started/windows.md', mark: 'guided:base', at: 'a'.repeat(40), page_name_from: 'scripts/setup/public-remotes.json', page_steps: 7 }, lab_changes: labChanges, not_rehearsed: notRehearsed, measured_variant: 'guided',
    variants: {
      guided: { what: 'una máquina con Claude Code y PowerShell 7', home: '/lab/users/guided', ps: 'pwsh', version: '2026.10.10.5',
        commands: [command('tools', '$PSVersionTable.PSVersion.ToString(); node --version; tar --version', 0, [{ kind: 'match', expected: '^7\\.', measured: '7.5.2', ok: true, comparable: true }]), command('verify', '@(Get-ChildItem "$env:USERPROFILE\\.claude\\skills" -Directory).Count', 0, [{ kind: 'min', expected: 41, measured: 12, ok: false, comparable: true }]), { step: 'verify', runs: 'machine', text: 'node "$env:USERPROFILE\\.claude\\tycon-harness\\scripts\\setup\\harness.js" doctor', not_comparable: 'la ruta con barras invertidas sólo resuelve en Windows' },
          // un programa que PowerShell no encontró (sale 0 igual), y un comando que arrancó y no volvió (el paso se cortó)
          Object.assign(command('git-hooks', 'git config --global --get core.hooksPath', 0, []), { not_found: ['git'] }),
          { step: 'install', runs: 'machine', text: 'pwsh -File get-harness.ps1 -- --profile full --yes', started: '2026-10-10T20:00:00.000Z' }],
        sessions: [session('primera-1', 'default-shell', true, 4200, 'cleaned'), session('primera-2', 'bash-c', false, 0, null)],
        // la foto de la máquina con la capa puesta: una de verdad (el dato de prueba de la comparación), con un rojo más
        after_team: (() => { const p = fixture('release-photo-after.json'); p.doctor.fail = [...p.doctor.fail, 'enlace ~/.claude/skills roto']; return p; })(),
        team: { commands: [{ text: 'harness.js config set azure.token', exit: 0 }, { text: 'harness.js install --version latest --team <team-url> --yes', exit: 0 }], state: { repo: 'acme/proyecto/equipo-lab', commit: 'b'.repeat(40), host: 'azure' }, profile_origin: { 'ado.org': 'perfil', 'packs.default': 'perfil' }, version_json: { team: { commit: 'b'.repeat(40) } }, doctor_line: 'capa del equipo equipo-lab bbbbbbb', session: session('con-la-capa', 'default-shell', true, 6100, 'cleaned') },
        answers: { usable: false, by_severity: { breaks: 1, 'loses-control': 0, noise: 0 } } },
      'guided-ps51': { what: 'una máquina que sólo tiene el PowerShell 5.1 de Windows', home: '/lab/users/guided-ps51', not_run: 'no hay powershell en esta máquina' },
    } } };
  const update = { name: 'update', status: 'measured', reason: null, wall_seconds: 500, cap_s: 1500, findings: [], facts: {
    guided: true, lab_mode: true, rehearsed_version: '2030.06.01.1', page: onboarding.facts.page, lab_changes: labChangesOf({ auto: { user_folder: '/lab/users/update-auto', shell: 'pwsh' }, 'pwsh-missing': { user_folder: '/lab/users/update-without-ps7', shell: 'pwsh', pwsh_removed_from: ['/usr/local/bin'], when: 'después de instalar la versión de antes' } }), not_rehearsed: notRehearsed, same_machine_note: GU.SAME_MACHINE_NOTE,
    variants: {
      auto: { what: 'con la capa del equipo (aplica sola)', home: '/lab/users/update-auto', version_before: '2031.01.01.1', version_published: '2031.01.01.2', version_after: '2031.01.01.2', updated_by_itself: true, sessions: [session('después-1', 'bash-c', true, 9000, 'cleaned')], answers: { healthy: true, updated: true, by_severity: { breaks: 0, 'loses-control': 0, noise: 0 }, what_the_dev_is_told: ['startup: actualizado a 2031.01.01.2'] } },
      ask: { what: 'sin la capa del equipo (avisa y pregunta)', home: '/lab/users/update-ask', version_before: '2031.01.01.2', version_published: '2031.01.01.3', version_after: '2031.01.01.2', changed_by_itself: false, sessions: [session('una', 'default-shell', true, 3000, 'cleaned'), session('otra', 'default-shell', false, 0, null)], what_the_dev_is_told: { state_notice: 'hay versión nueva: 2031.01.01.3', hook_said: 'decile a la persona: hay versión nueva: 2031.01.01.3' }, by_hand: { without_a_terminal: true, exit: 2, error: null, version: '2031.01.01.2', refused_cleanly: true, said: '`--yes` necesita una terminal' }, answers: { by_severity: { breaks: 0, 'loses-control': 0, noise: 0 } } },
      'pwsh-missing': { what: 'instalada con PowerShell 7; después pwsh no está en el PATH', home: '/lab/users/update-pwsh-missing', not_run: 'quitar pwsh del PATH se lleva también a node' },
    } } };
  const inventory = { name: 'inventory', status: 'measured', reason: null, findings: [], facts: {} };
  const report = { schema: 1, kind: 'windows-rehearsal', run: { id: '12999', number: '20261010.9', scenario: 'all', expected_steps: ['inventory', 'update', 'onboarding'], platform: 'linux', lab_mode: true, node: '20.0.0', single_repo: true, harness_ref: `github:${'a'.repeat(40)}`, commits: { harness: { friday: null, today: 'a'.repeat(40), between: null, today_ref: 'HEAD' } }, friday_tag: null }, steps: [inventory, update, onboarding] };
  report.verdict = rehearse.verdict(report);
  return report;
}

test('Report_GuidedRun_RendersItsSectionsAndIsGreen', () => {
  const report = guidedReport();
  // el veredicto: verde cuando los pasos midieron; ya no termina «con avisos» por estos dos ensayos
  assert.deepStrictEqual([report.verdict.color, report.verdict.nothing_measured, report.verdict.not_measured], ['green', false, []]);
  let md;
  assert.doesNotThrow(() => { md = rehearse.renderMarkdown(report); });
  assert.match(md, /## Veredicto: VERDE/);
  assert.doesNotMatch(md, /CON AVISOS/);
  // por variante: la tabla de comandos de la página (paso, quién, código de salida, esperado contra medido)
  assert.match(md, /## El alta, siguiendo la página pública/);
  assert.match(md, /### guided — una máquina con Claude Code y PowerShell 7/);
  assert.match(md, /\| Paso \| Quién \| Comando \| Salió \| Esperado contra medido \|/);
  assert.match(md, /\| tools \| la máquina \| .*PSVersionTable.* \| 0 \| .*7\.5\.2.*\|/);
  assert.match(md, /\| verify \| la máquina \| .*Get-ChildItem.* \| 0 \| .*41.*12.*NO.*\|/);
  assert.match(md, /no comparable: la ruta con barras invertidas sólo resuelve en Windows/);
  // lo que el laboratorio cambió, lo no ensayado, cada sesión (si se desprendió y cuánto tardó) y la capa del equipo
  assert.match(md, /## Lo que el laboratorio cambió/);
  assert.match(md, /el origen de la bajada del guion: .*https:\/\/raw\.githubusercontent\.com.*http:\/\/127\.0\.0\.1:4457/);
  assert.match(md, /Bypass/);
  assert.match(md, /## No ensayado/);
  assert.match(md, /armar el reporte lo hace el asistente con la persona/);
  // y que ningún paso llevó un permiso de GitHub queda dicho entre lo que el laboratorio cambió
  assert.match(md, /- TYCON_GITHUB_TOKEN: no se pone en ningún paso/);
  assert.match(md, /\| Sesión \| Lanzada por \| La línea de arranque \| ¿Se desprendió\? \| Esperó \(s\) \| Cómo terminó la espera \|/);
  assert.match(md, /\| primera-1 \| default-shell \| .* \| sí \| 4\.2 \| terminó y limpió \|/);
  assert.match(md, /\| primera-2 \| bash-c \| .* \| no \| 0 \| — \|/);
  assert.match(md, /\*\*La capa del equipo\*\*/);
  assert.match(md, /capa del equipo equipo-lab/);
  assert.match(md, /guided-ps51[\s\S]*No corrió: no hay powershell en esta máquina/);
  // en update: la versión de antes y la de después, con lo que se le dijo a la persona
  assert.match(md, /## La actualización, sobre una máquina instalada con la página/);
  assert.match(md, /\| auto — .* \| 2031\.01\.01\.1 \| 2031\.01\.01\.2 \| 2031\.01\.01\.2 \| sí \|/);
  assert.match(md, /Lo que se le dijo a la persona/);
  assert.match(md, /decile a la persona: hay versión nueva: 2031\.01\.01\.3/);
  assert.match(md, /`harness\.js update --yes` lanzado sin una terminal: salió 2 y quedó la versión 2031\.01\.01\.2 \(se negó y dijo por qué: es lo esperado\)/);
  assert.ok(md.includes(GU.SAME_MACHINE_NOTE));
  // ningún título habla del viernes ni de clones en esa corrida
  const titles = md.split('\n').filter((l) => /^#{1,4} /.test(l) || /^\| /.test(l) && /---/.test(md.split('\n')[md.split('\n').indexOf(l) + 1] || ''));
  assert.ok(titles.length > 8, `sólo ${titles.length} títulos leídos`);
  for (const t of titles) assert.doesNotMatch(t, /viernes|\bclon(es)?\b|agent-skills/i, t);
  assert.match(md, /`aaaaaaaaaa`/, 'dice qué commit se ensayó');
  // el hallazgo que rompe sale con su gravedad, en su variante
  assert.match(md, /\*\*rompe el trabajo del dev \(1\)\*\*[\s\S]*guided:expected:verify/);
  // lo que el reporte no puede callar
  assert.match(md, /\| git-hooks \| la máquina \| .* \| 0 · NO ENCONTRÓ: git \|/, 'un programa que no estaba, aunque el proceso salió 0');
  assert.match(md, /NO VOLVIÓ \(arrancó 2026-10-10T20:00:00\.000Z y el paso se cortó\)/, 'el comando que quedó corriendo cuando se cortó el paso');
  assert.match(md, /Cómo quedó la máquina con la capa puesta: 4 hook\(s\) · línea de arranque .* · doctor .*rojo\(s\).* · versión \d{4}\.\d\d\.\d\d\.\d+ — en rojo: .*enlace ~\/\.claude\/skills roto/, 'la máquina DESPUÉS de sumar la capa');
  assert.match(md, /- onboarding · guided: carpeta de usuario \/lab\/users\/guided, con `pwsh`/);
  assert.match(md, /- update · pwsh-missing: .*`pwsh` quitado del PATH después de instalar la versión de antes \(\/usr\/local\/bin\)/, 'lo propio de cada variante, de los dos pasos');
  assert.match(md, /cada comando de la página se lanza con: .*Bypass/);
  assert.match(md, /variables que se ponen siempre.*GIT_TERMINAL_PROMPT=0/);
  assert.match(md, /## Notas del ensayo\n\n- onboarding: una nota del ensayo, que el reporte muestra/);
  assert.match(md, /\| una copia publicada del arnés \| .* \| 2030\.06\.01\.1 \|/);
  // cada dato común sale del paso que LO TRAE: si el alta no pudo ensayar (queda con `guided` y nada más), lo que la
  // actualización sí midió no desaparece del reporte
  const half = guidedReport();
  half.steps[half.steps.findIndex((s) => s.name === 'onboarding')] = { name: 'onboarding', status: 'error', reason: 'no pude ensayar: el GitHub de juguete no dejó su archivo de puertos en 10 s', findings: [], facts: { guided: true } };
  half.verdict = rehearse.verdict(half);
  const halfMd = rehearse.renderMarkdown(half);
  assert.match(halfMd, /## Veredicto: ROJO/);
  assert.match(halfMd, /## Lo que el laboratorio cambió/);
  assert.match(halfMd, /- update · auto: carpeta de usuario/);
  assert.match(halfMd, /armar el reporte lo hace el asistente con la persona/, '«no ensayado» sigue con sus filas');
  assert.match(halfMd, /\| una copia publicada del arnés \| .* \| 2030\.06\.01\.1 \|/);
  assert.match(halfMd, /La página `getting-started\/windows\.md`|## La actualización, sobre una máquina instalada con la página/);
  // y si NINGÚN paso llegó a anotar la lista de lo no ensayado, no sale una tabla vacía como si se hubiera ensayado todo
  const blank = guidedReport();
  for (const s of blank.steps) delete s.facts.not_rehearsed;
  assert.match(rehearse.renderMarkdown(blank), /## No ensayado\n\nNingún paso de esta ejecución llegó a anotar la lista[\s\S]*NO quiere decir que se ensayó todo/);
  // una variante que tiró: se dice dónde, y su fila corta no la da por medida
  const threw = guidedReport();
  Object.assign(threw.steps.find((s) => s.name === 'update').facts.variants.ask, { threw: 'no pude leer el estado del arnés', threw_at: 'at stateOf (toy-lab.js:333:11)' });
  const threwMd = rehearse.renderMarkdown(threw);
  assert.match(threwMd, /La medición tiró: no pude leer el estado del arnés — en at stateOf \(toy-lab\.js:333:11\)\. Lo de abajo es lo que alcanzó a medir\./);
  assert.match(threwMd, /\| ask — .*NO SE PUDO ENSAYAR entera — tiró: no pude leer el estado del arnés/);
  // las celdas son de tres estados: lo que no se llegó a medir no sale como «no»
  const cut = guidedReport();
  const cutAsk = cut.steps.find((s) => s.name === 'update').facts.variants.ask;
  delete cutAsk.changed_by_itself; delete cutAsk.sessions[1].wait;
  const cutTeam = cut.steps.find((s) => s.name === 'onboarding').facts.variants.guided.team;
  delete cutTeam.doctor_line; delete cutTeam.version_json; delete cutTeam.session;
  const cutMd = rehearse.renderMarkdown(cut);
  assert.match(cutMd, /\| ask — .* \| no se midió \|/);
  assert.match(cutMd, /\| otra \| default-shell \| .* \| no se midió \| — \| — \|/);
  assert.match(cutMd, /lo que el alta del equipo manda comprobar no se llegó a mirar: la capa no se instaló/);
  assert.doesNotMatch(cutMd, /NO nombra la capa/);
  // y con la capa instalada y el diagnóstico en rojo, se ve
  const red = guidedReport();
  Object.assign(red.steps.find((s) => s.name === 'onboarding').facts.variants.guided.team, { doctor: { readable: true, fail: ['settings.json: 12 hooks del arnés ya no están registrados'] } });
  assert.match(rehearse.renderMarkdown(red), /el diagnóstico: capa del equipo equipo-lab bbbbbbb — y trae en rojo: settings\.json: 12 hooks/);
  // ── las dos variantes que arriba «no corrieron», CORRIDAS: sus ramas del reporte se arman acá, no por primera vez
  // en una corrida de Azure
  const ran = guidedReport();
  const sameHome = { harness_dir: false, settings_sha256: 'a'.repeat(64), startup_line: false };
  ran.steps.find((s) => s.name === 'onboarding').facts.variants['guided-ps51'] = { what: 'una máquina que sólo tiene el PowerShell 5.1 de Windows', home: '/lab/users/guided-ps51', ps: 'powershell', pwsh_removed_from: ['/usr/local/bin'], followed_page: false, why: 'la página manda parar en el paso 1 si no hay PowerShell 7: el ensayo no la sigue desde ahí', tools: { exit: 0, error: null, powershell_version: '5.1.26100.4202' }, off_page: [{ what: 'bajar el guion con el comando de la página', exit: 0, error: null, said: '' }, { what: 'el guion de entrada, lanzado con powershell -File', exit: 1, error: null, said: 'get-harness: este guion pide PowerShell 7 (pwsh) y lo corrió PowerShell 5.1' }], script_placed_by_lab: 'con este PowerShell el comando de la página no dejó get-harness.ps1 en la carpeta: lo puso el laboratorio', left: { before: sameHome, after: sameHome } };
  const failing = (label, form) => ({ label, form, shell: '/bin/sh -c', hooks: [{ hook: 'startup-line', startup: 'new', exit: 127, error: null, ms: 40, out: '', err: 'pwsh: command not found' }], wait: { detached: false, waited_ms: 0, ended_by: null }, version: '2031.01.01.5' });
  const updRan = ran.steps.find((s) => s.name === 'update');
  updRan.facts.variants['pwsh-missing'] = { what: 'instalada con PowerShell 7; después pwsh no está en el PATH', home: '/lab/users/update-without-ps7', version_before: '2031.01.01.5', version_published: '2031.01.01.6', version_after: '2031.01.01.5', updated: false, pwsh_removed_from: ['/usr/local/bin'], sessions: [failing('sin-pwsh-1', 'bash-c'), failing('sin-pwsh-2', 'default-shell')], something_tells: { hook: null, doctor: null }, answers: { by_severity: { breaks: 0, 'loses-control': 2, noise: 0 } } };
  updRan.findings.push({ id: 'update:pwsh-missing:update:pwsh-missing:not-updated', kind: 'update', detail: 'sin pwsh en el PATH la máquina no se actualizó', severity: 'loses-control', variant: 'pwsh-missing' }, { id: 'update:pwsh-missing:update:pwsh-missing:silent', kind: 'update', detail: 'y nada se lo avisa a la persona', severity: 'loses-control', variant: 'pwsh-missing' });
  // un hallazgo que es del PASO y no de una variante (la red de abajo de los permisos), y una nota de un paso de medición
  ran.steps.find((s) => s.name === 'onboarding').findings.push({ id: 'onboarding:guided:secret-printed:saved', kind: 'secret', detail: 'en lo que el ensayo iba a guardar de la salida de un comando: la salida trae el permiso de juguete (azure)', severity: 'breaks' });
  ran.steps.push({ name: 'fire-registered', status: 'measured', reason: null, findings: [], notes: ['la línea de arranque lanzada por default-shell: la parte del enlace roto NO se midió — el estado del arnés existe y no se pudo leer'], facts: { variant: 'guided' } });
  ran.run.expected_steps.push('fire-registered');
  ran.verdict = rehearse.verdict(ran);
  const ranMd = rehearse.renderMarkdown(ran);
  assert.match(ranMd, /\| guided-ps51 — .* \| la página manda parar: frenó limpio y lo dijo \|/);
  assert.match(ranMd, /No siguió la página: la página manda parar en el paso 1/);
  assert.match(ranMd, /con `powershell`: salió 0; PowerShell 5\.1\.26100\.4202/);
  assert.match(ranMd, /\| el guion de entrada, lanzado con powershell -File \| 1 \| get-harness: este guion pide PowerShell 7/);
  assert.match(ranMd, /Nota: con este PowerShell el comando de la página no dejó get-harness\.ps1/);
  assert.match(ranMd, /Cómo quedó la máquina: sin la carpeta del arnés · settings\.json sin cambios · sin línea de arranque\./);
  assert.match(ranMd, /\| pwsh-missing — .* \| 2031\.01\.01\.5 \| 2031\.01\.01\.6 \| 2031\.01\.01\.5 \| NO \| 0 \| 2 \| 0 \|/);
  assert.match(ranMd, /`pwsh` fuera del PATH \(se quitó \/usr\/local\/bin\)/);
  assert.match(ranMd, /\| sin-pwsh-1 \| bash-c \| salió 127 /);
  assert.match(ranMd, /¿Algo le avisa a la persona\? Un hook de la sesión: no · el diagnóstico: no\./);
  assert.match(ranMd, /\*\*pierde un control[^*]*\(2\)\*\*[\s\S]*not-updated[\s\S]*silent/);
  // 🔴 el hallazgo del paso entero cuenta en el total Y tiene su renglón (si sólo sumara a «rompe», nadie lo nombraría)
  assert.strictEqual(ran.verdict.by_severity.breaks, 2);
  assert.match(ranMd, /## onboarding: hallazgos del paso entero \(no de una variante\)\n\n\*\*rompe el trabajo del dev \(1\)\*\*\n\n- `guided:secret-printed:saved` — /);
  assert.match(ranMd, /## Notas del ensayo\n\n[\s\S]*- fire-registered: la línea de arranque lanzada por default-shell: la parte del enlace roto NO se midió/, 'las notas de todos los pasos, no sólo de los dos guiados');
  // la máquina de 5.1 cuyo paso se cortó antes del juicio: «sin hallazgos» no es «frenó limpio»
  const cutPs = guidedReport();
  cutPs.steps.find((s) => s.name === 'onboarding').facts.variants['guided-ps51'] = { what: 'una máquina que sólo tiene el PowerShell 5.1 de Windows', home: '/lab/users/guided-ps51', followed_page: false, why: 'la página manda parar' };
  assert.match(rehearse.renderMarkdown(cutPs), /\| guided-ps51 — .* \| la página manda parar: no se terminó de medir \|/);
  // «el hook no dijo nada» contra «no se llegó a mirar los hooks» (el estado no guardaba el aviso de la versión)
  const unlooked = guidedReport();
  Object.assign(unlooked.steps.find((s) => s.name === 'update').facts.variants.ask.what_the_dev_is_told, { state_notice: null, hook_said: null, hook_checked: false });
  assert.match(rehearse.renderMarkdown(unlooked), /el aviso en el estado: NO hay\n- lo que dijo el hook de avisos en la sesión siguiente: no se miró/);
  assert.match(rehearse.renderMarkdown(unlooked), /no se miró \(sin el aviso de la versión nueva en el estado/);
  // sin número de versión después de las sesiones, las celdas no dicen «NO»: no se sabe (y el hallazgo está en la lista)
  const lost = guidedReport();
  const lostVariants = lost.steps.find((s) => s.name === 'update').facts.variants;
  Object.assign(lostVariants.auto, { version_after: null, updated_by_itself: null });
  Object.assign(lostVariants.ask.by_hand, { version: null, refused_cleanly: null });
  const lostMd = rehearse.renderMarkdown(lost);
  assert.match(lostMd, /\| auto — .* \| 2031\.01\.01\.1 \| 2031\.01\.01\.2 \| — \| no se sabe \|/);
  assert.match(lostMd, /lanzado sin una terminal: salió 2 y quedó la versión — \(no se juzgó si se negó: después no se pudo leer la versión\)/);
  assert.strictEqual(RP.answers(fixture('release-photo-before.json'), Object.assign(fixture('release-photo-after.json'), { version: { number: null } }), [], { expectVersion: '2031.01.01.2' }).updated, null, 'y en las respuestas cortas de la foto, lo mismo');
  // la máquina que pregunta y cambió sola: «no se miró» dice por qué
  const alone = guidedReport();
  const aloneAsk = alone.steps.find((s) => s.name === 'update').facts.variants.ask;
  Object.assign(aloneAsk, { changed_by_itself: true, version_after: '2031.01.01.3' });
  Object.assign(aloneAsk.what_the_dev_is_told, { hook_said: null, hook_checked: false });
  assert.match(rehearse.renderMarkdown(alone), /no se miró \(la máquina cambió sola de versión/);
  const nothing = guidedReport();
  Object.assign(nothing.steps.find((s) => s.name === 'update').facts.variants.ask.what_the_dev_is_told, { hook_said: null, hook_checked: true });
  assert.match(rehearse.renderMarkdown(nothing), /lo que dijo el hook de avisos en la sesión siguiente: NADA/);
  // y una corrida de las de antes (el árbol interno) sale como antes
  const old = rehearse.renderMarkdown({ run: { scenario: 'all', commits: { harness: { friday: 'c'.repeat(40), today: 'd'.repeat(40), between: 3, today_ref: 'origin/main' } }, friday_tag: 'retorno/x' }, steps: [{ name: 'update', status: 'not-measured', reason: 'x', findings: [], facts: {} }], verdict: { color: 'green', nothing_measured: true, errors: [], missing_steps: [], not_measured: ['update: x'], by_severity: { breaks: 0, 'loses-control': 0, noise: 0, unrated: 0 } } });
  assert.match(old, /\| Repo \| El viernes \| Hoy \| Commits en el medio \|/);
  assert.match(old, /## Veredicto: CON AVISOS/);
});

// ═══ T27 · los registros de las suites ═════════════════════════════════════════════════════════════════════════

test('Suites_Registration_RunWhenThePageChanges', { skip: !fs.existsSync(path.join(ROOT, 'scripts', 'ci', 'heavy-suites.json')) && 'NO MEDIDO — copia sin los registros de las suites' }, () => {
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const suites = read('scripts/tests/suites.json');
  const all = Object.values(suites).filter(Array.isArray).flat().filter((s) => s && typeof s.ruta === 'string');
  const entry = (name) => { const found = all.filter((s) => s.ruta === `tests/${name}`); assert.strictEqual(found.length, 1, `${name}: una entrada en suites.json`); return found[0]; };
  const fast = entry('windows-guided.test.js');
  const lab = entry('windows-guided-lab.test.js');
  const today = entry('windows-rehearsal.test.js');
  // lo que las dispara: la página pública, el guion de entrada, el texto del alta, los guiones del ensayo, sus datos de
  // prueba y los dos servidores de juguete. En suites.json un patrón es una carpeta («<carpeta>/**»)
  const covers = (patterns, file) => (patterns || []).some((p) => (p.endsWith('/**') ? file.startsWith(p.slice(0, -2)) : p === file));
  const TOUCHED = ['getting-started/windows.md', 'scripts/setup/get-harness.ps1', 'onboarding/new-dev-harness-setup.md', 'scripts/tests/windows/guided-install.js', 'scripts/tests/fixtures/windows/guided-page-ok.md', 'scripts/tests/fixtures/toy-release-server.js', 'scripts/tests/fixtures/toy-azure-server.js'];
  for (const s of [fast, lab]) for (const f of TOUCHED) assert.ok(covers(s.gate_only_when_touching, f), `${s.ruta} corre al tocar ${f}`);
  assert.ok(covers(today.gate_only_when_touching, 'getting-started/windows.md'), 'la suite del ensayo de hoy suma la página pública a lo que la dispara');
  assert.ok(!covers(fast.gate_only_when_touching, 'guides/integrations/engram-workflow.md'), 'el control: una guía cualquiera no las dispara');
  // la de laboratorio es pesada (grupo installer), con su excepción firmada por pasar de 45 s. En la validación de una
  // rama manda heavy-suites.json: corre con el instalador (el grupo trae los dos servidores de juguete) y con lo suyo
  const heavy = read('scripts/ci/heavy-suites.json');
  const labEntry = heavy.suites['windows-guided-lab.test.js'] || {};
  assert.strictEqual(labEntry.group, 'installer');
  const inBranch = [...heavy.groups.installer.patterns, ...(labEntry.patterns || [])];
  for (const f of ['scripts/tests/windows-guided-lab.test.js', 'getting-started/windows.md', 'scripts/setup/get-harness.ps1', 'scripts/tests/windows/guided-install.js', 'scripts/tests/windows/guided-update.js', 'scripts/tests/windows/toy-lab.js', 'scripts/tests/fixtures/toy-release-server.js', 'scripts/tests/fixtures/toy-azure-server.js', 'scripts/setup/harness.js']) assert.ok(covers(inBranch, f), `la de laboratorio corre en la rama al tocar ${f}`);
  assert.ok(!('windows-guided.test.js' in heavy.suites), 'la rápida no es pesada');
  const over = read('scripts/ci/suites-over-limit.json');
  const exception = (Array.isArray(over.suites) ? over.suites : Object.entries(over.suites || {}).map(([suite, v]) => Object.assign({ suite }, v))).find((s) => s.suite === 'windows-guided-lab.test.js');
  assert.ok(exception && exception.exception && exception.exception.signed_by, 'con su excepción en suites-over-limit.json');
  const weights = JSON.stringify(read('scripts/ci/suites-weights.json'));
  for (const name of ['windows-guided.test.js', 'windows-guided-lab.test.js']) assert.ok(weights.includes(name), `${name} tiene su peso`);
  // las dos viven en el repo público con los guiones y sus datos de prueba: ninguna figura entre las suites que no viajan
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'publishing', 'allowlist.json'), 'utf8'));
  const outside = (allow.suitesOutside || []).map((x) => x && x.path);
  for (const name of ['windows-guided.test.js', 'windows-guided-lab.test.js']) assert.ok(!outside.includes(`tests/${name}`), `${name} no está entre las suites que no viajan`);
  // los archivos nuevos de la carpeta pasan el freno de nombres en castellano
  const mine = ['guided-steps.json', 'guided-page.js', 'toy-lab.js', 'release-photo.js', 'guided-install.js', 'guided-update.js'].map((f) => path.join(DIR, f))
    .concat(['guided-page-ok.md', 'guided-page-changed.md', 'release-photo-before.json', 'release-photo-after.json'].map((f) => path.join(FIXTURES, f)));
  for (const f of mine) assert.ok(fs.existsSync(f), `${path.basename(f)} existe`);
  let sn = null;
  try { sn = require(path.join(ROOT, 'scripts', 'publishing', 'spanish-names.js')); } catch (_) { sn = null; }
  const det = sn ? sn.makeDetector(sn.loadWords(fs.readFileSync(path.join(ROOT, sn.WORDS_PATH), 'utf8'), sn.WORDS_PATH)) : null;
  if (det && det.dictionary) {
    const names = new Set(mine.map((f) => path.basename(f).replace(/\.(test\.)?(js|json|sh|md)$/, '')));
    for (const f of mine.filter((x) => /\.js$/.test(x))) { const text = fs.readFileSync(f, 'utf8'); for (const m of text.matchAll(/'--([a-z][a-z-]+)'/g)) names.add(m[1]); for (const m of text.matchAll(/\b(TYCON_WINDOWS_[A-Z_]+)\b/g)) names.add(m[1]); }
    // la ficha ENTERA: toda clave, en cualquier nivel (también `needs`, lo esperado, las notas, la capa del equipo y lo
    // no ensayado), y los identificadores de los pasos y de las notas
    const m = G.loadManifest();
    const keys = new Set();
    const walk = (x) => {
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (!x || typeof x !== 'object') return;
      for (const [k, val] of Object.entries(x)) { keys.add(k.replace(/^__/, '')); if (k === 'id' && typeof val === 'string') keys.add(val); walk(val); }
    };
    walk(m);
    for (const k of ['entry_package', 'names', 'kind', 'pattern', 'flags', 'path', 'value', 'lab_gap', 'stdin', 'commands', 'not_rehearsed', 'node', 'git-hooks']) assert.ok(keys.has(k), `el recorrido de la ficha llega a «${k}»`);
    for (const k of keys) names.add(k);
    const spanish = [...names].filter((n) => det.isSpanish(n).spanish);
    assert.deepStrictEqual(spanish, [], `nombres en castellano en lo que lee la máquina: ${spanish.join(', ')}`);
  }
  // sin nombres reales ni historia interna en lo que viaja: ni la organización de Azure del equipo, ni una dirección con usuario
  for (const f of mine) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /dev\.azure\.com\/(?!acme\b)[A-Za-z0-9_-]+/, `${path.basename(f)}: sólo la organización de juguete`);
    assert.doesNotMatch(text, /https?:\/\/[^\s/@"']+@/, `${path.basename(f)}: ninguna dirección con usuario`);
    assert.doesNotMatch(text, /story \d+\.\d+|tanda [A-Z]\d?\b|DEF-\d/i, `${path.basename(f)}: sin historia interna`);
  }
});

// ═══ T28 · fire-registered: con una versión bajada, el enlace roto «no aplica» ═════════════════════════════════

test('FireRegistered_DownloadedVersion_BrokenLinkDoesNotApply', { skip: process.platform === 'win32' && 'el juguete lanza por /bin/sh' }, () => {
  const base = tmp('t28');
  try {
    const PLACE = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js'));
    const toyHome = (name, source) => {
      const home = path.join(base, name);
      const tree = path.join(home, 'tree');
      fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline', 'harness'), { recursive: true });
      fs.mkdirSync(tree, { recursive: true });
      fs.symlinkSync(tree, path.join(home, '.claude', PLACE.PLACE_NAME), 'dir');
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ "hooks": {} }\n');
      fs.writeFileSync(path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json'), `${JSON.stringify({ mode: 'managed', sources: [source] })}\n`);
      return { home, tree, log: path.join(home, '.claude', '.tycon-pipeline', 'harness', 'startup.log') };
    };
    // la línea de juguete: deja su rastro en el registro, como bootstrap.js, y nunca corre el respaldo
    const run = (h) => {
      const rec = L.recorder('fire-registered', path.join(h.home, 'out'));
      const line = { command: `node -e "require('fs').appendFileSync(process.argv[1], 'startup: al día\\n')" "${h.log}"`, is_async: true };
      const forms = [{ id: 'default-shell', shell: '/bin/sh -c', launch: (command) => [command, [], { shell: true }] }];
      F.measureStartup({ line, forms, home: h.home, clone: h.tree, env: Object.assign({}, process.env, { HOME: h.home }), rec });
      return rec.step;
    };
    // ── una versión bajada: el arranque encuentra el árbol por el estado; el respaldo no corre y no es un hallazgo
    const release = run(toyHome('release', { name: 'harness', kind: 'release', commit: 'a'.repeat(40) }));
    const item = release.facts.startup.by_form[0];
    assert.ok(item.healthy && item.healthy.bootstrap_ran, 'la parte sana se mide igual');
    assert.match(item.broken.not_applicable, /versión bajada/);
    assert.match(item.broken.not_applicable, /estado/);
    assert.ok(!('fallback_ran' in item.broken) && !item.broken_links, 'no rompe ningún enlace');
    assert.deepStrictEqual(release.findings.filter((f) => /^startup:fallback-did-not-run:/.test(f.id)), []);
    // ── con un clon: rompe el enlace, espera el respaldo, y lo repone
    const cloned = run(toyHome('clone', { name: 'harness', kind: 'tree', commit: 'b'.repeat(40) }));
    const was = cloned.facts.startup.by_form[0];
    assert.deepStrictEqual([was.broken_links, was.broken.fallback_ran, was.broken.not_applicable], [[PLACE.PLACE_NAME], false, undefined]);
    assert.deepStrictEqual(cloned.findings.map((f) => f.id), ['startup:fallback-did-not-run:default-shell']);
    assert.strictEqual(cloned.facts.startup.link_restored, true);
    // sin estado (una instalación de antes del mecanismo): rompe el enlace igual que con un clon
    const bare = toyHome('no-state', { name: 'harness', kind: 'tree' });
    fs.rmSync(path.join(bare.home, '.claude', '.tycon-pipeline', 'harness-state.json'));
    assert.deepStrictEqual(run(bare).findings.map((f) => f.id), ['startup:fallback-did-not-run:default-shell']);
    assert.deepStrictEqual([F.installedAsRelease(bare.home), F.installedAsRelease(path.join(base, 'release')), F.installedAsRelease(path.join(base, 'clone'))], [false, true, false]);
    // el estado en la casa propia del arnés (~/.tycon/state): se lee de ahí
    const own = toyHome('own-home', { name: 'harness', kind: 'release', commit: 'a'.repeat(40) });
    fs.mkdirSync(path.join(own.home, '.tycon', 'state'), { recursive: true });
    fs.renameSync(path.join(own.home, '.claude', '.tycon-pipeline', 'harness-state.json'), path.join(own.home, '.tycon', 'state', 'harness-state.json'));
    assert.strictEqual(F.installedAsRelease(own.home), true);
    assert.match(run(own).facts.startup.by_form[0].broken.not_applicable, /versión bajada/);
    // un estado que ESTÁ y no se deja leer: «no sé» no es «no es una versión bajada». No se rompe ningún enlace (daría
    // un hallazgo falso por cada forma de lanzar) y esa parte queda «no medido», con el motivo
    const unreadable = toyHome('unreadable', { name: 'harness', kind: 'release', commit: 'a'.repeat(40) });
    fs.writeFileSync(path.join(unreadable.home, '.claude', '.tycon-pipeline', 'harness-state.json'), '{ "sources": [');
    assert.strictEqual(F.installedAsRelease(unreadable.home), null);
    const blind = run(unreadable);
    assert.match(blind.facts.startup.by_form[0].broken.not_measured, /no se pudo leer/);
    assert.ok(!blind.facts.startup.by_form[0].broken_links, 'no rompe ningún enlace a ciegas');
    assert.ok(blind.facts.startup.by_form[0].healthy.bootstrap_ran, 'la parte sana se mide igual');
    assert.deepStrictEqual(blind.findings.filter((f) => /fallback/.test(f.id)), []);
    assert.ok(blind.notes.some((n) => /la parte del enlace roto NO se midió/.test(n) && /no se pudo leer/.test(n)), 'y queda como nota del paso: sin hallazgos, el reporte no imprime nada más de él');
    assert.deepStrictEqual(release.notes.filter((n) => /NO se midió/.test(n)), [], 'el control: con el estado sano no hay nota');
    // lo mismo si el estado está y no se puede abrir (una carpeta en su lugar): sólo «no existe» deja seguir buscando
    const shut = toyHome('shut', { name: 'harness', kind: 'release', commit: 'a'.repeat(40) });
    fs.rmSync(path.join(shut.home, '.claude', '.tycon-pipeline', 'harness-state.json'));
    fs.mkdirSync(path.join(shut.home, '.claude', '.tycon-pipeline', 'harness-state.json'));
    assert.strictEqual(F.installedAsRelease(shut.home), null);
    // team-lab.js conserva todo lo que exporta: las sondas que no se tocan lo usan
    const EXPORTED = ['LAYER_A2', 'writeTeamLayerA2', 'LAYER_A2C', 'writeTeamLayerA2c', 'STATE_FILE', 'DOC', 'STEP_ZERO', 'KNOWN_LINES', 'SEVERITY', 'SEVERITY_TEXT', 'SEVERITY_ORDER', 'NOT_REHEARSED', 'REHEARSAL_ENV', 'SHAPE', 'SHAPE_TEXT', 'notRehearsed', 'readJsonLoose', 'makeRemotes', 'readState', 'pointRemotes', 'showFile', 'fileAt', 'docSection', 'fencedBlocks', 'parseTeamDoc', 'readTeamDoc', 'knownWindowsLines', 'redirectEnv', 'redactor', 'simulateWeekend', 'withoutPwsh', 'rehearsalEnv', 'runPs', 'mergeStartupLine', 'isNewStartup', 'isOldStartup', 'isHarnessStartup', 'findHarnessClone', 'registeredStartup', 'teamInstall', 'hookKey', 'settingsFacts', 'linkFacts', 'repoFacts', 'doctorFacts', 'expectedFacts', 'photo', 'launchForms', 'fireSessionStart', 'smoke', 'eolFacts', 'psParseFacts', 'judgePhoto', 'comparePhotos', 'answers', 'lastLines', 'tellingLine'];
    for (const name of EXPORTED) assert.ok(name in T, `team-lab.js sigue exportando ${name}`);
    for (const name of ['NAME', 'BLOCK_RX', 'hookName', 'payload', 'genericInput', 'benchCases', 'shellForms', 'fire', 'measure']) assert.ok(name in F, `fire-registered.js sigue exportando ${name}`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
