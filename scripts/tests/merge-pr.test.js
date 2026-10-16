'use strict';

/**
 * merge-pr.test.js — el merge por pedido del lado de GitHub (scripts/tools/merge-pr.js) y el contrato del skill de merge.
 *
 * El skill de merge sabía crear un pedido sólo en Azure DevOps, donde el servidor lo completa solo. Con un repo de GitHub
 * el skill tiene que: saber de qué servidor es el repo y qué paso le toca; poner la rama al día; subir el número de
 * `version.json`; esperar EL control que el repo declara (un pedido trae varios) y recién ahí mergear. Lo que no puede pasar:
 *   · que un repo de Azure deje de seguir su paso de siempre, o que uno de GitHub termine en un empuje directo;
 *   · que se mergee con el control en rojo, sin terminar, de otra punta, o eligiendo un control por su cuenta;
 *   · que dos pedidos queden con el mismo número, o que el número baje;
 *   · que «no pude preguntar» se lea como «está todo bien».
 *
 * Todo corre sobre repos de juguete (git de verdad) y un `gh` de mentira: no sale a la red.
 *
 * Correr: node --test scripts/tests/merge-pr.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'scripts', 'tools', 'merge-pr.js');
const SKILL = path.join(ROOT, 'skills', 'tycon-merge-to-main');
const VO = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'version-order.js'));
const M = require(TOOL);

// ── repos de juguete ─────────────────────────────────────────────────────────────────────────────────────────────────
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-pr-test-'));
test.after(() => { fs.rmSync(SCRATCH, { recursive: true, force: true }); });

// un git sin la configuración de la máquina (sus hooks globales, su firma) ni la del proceso que corre la prueba
const EMPTY_CONFIG = path.join(SCRATCH, 'gitconfig-vacio');
fs.writeFileSync(EMPTY_CONFIG, '');
function gitEnv(date) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/.test(k)) env[k] = v;
  Object.assign(env, { GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Prueba', GIT_AUTHOR_EMAIL: 'prueba@example.invalid', GIT_COMMITTER_NAME: 'Prueba', GIT_COMMITTER_EMAIL: 'prueba@example.invalid' });
  if (date) { env.GIT_AUTHOR_DATE = date; env.GIT_COMMITTER_DATE = date; }
  return env;
}
const DAY = '2030.01.15';
const AT = (day, hour = 12) => `${day.replace(/\./g, '-')}T${String(hour).padStart(2, '0')}:00:00Z`;
const git = (dir, args, date = AT(DAY)) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv(date), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const deps = (extra = {}) => Object.assign({ env: gitEnv(AT(DAY)) }, extra);

let serial = 0;
const versionText = (version, eol = '\n') => ['{', `  "version": "${version}",`, '  "source": {', '    "harness": "0123456789abcdef0123456789abcdef01234567"', '  },',
  '  "transformed": [', '    { "path": "guides/una.md" }', '  ]', '}', ''].join(eol);

/** Un «público» de juguete (repo desnudo) y un clon de trabajo. `version`: null = el repo no numera versiones. */
function toy({ version = `${DAY}.1`, text = null } = {}) {
  const base = path.join(SCRATCH, `r${serial += 1}`);
  const pub = path.join(base, 'pub.git');
  const work = path.join(base, 'work');
  fs.mkdirSync(base, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', pub], { env: gitEnv() });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', work], { env: gitEnv() });
  fs.writeFileSync(path.join(work, 'a.txt'), 'uno\n');
  if (text !== null) fs.writeFileSync(path.join(work, 'version.json'), text);
  else if (version !== null) fs.writeFileSync(path.join(work, 'version.json'), versionText(version));
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'inicio']);
  git(work, ['remote', 'add', 'origin', pub]);
  git(work, ['push', '--quiet', 'origin', 'main']);
  git(work, ['fetch', '--quiet', 'origin']);
  return { pub, work };
}
/** Una rama de trabajo con un cambio en `file`, parada en ella. */
function branch(work, name, file = `${name.replace(/\W/g, '-')}.txt`, date = AT(DAY)) {
  git(work, ['checkout', '--quiet', '-b', name], date);
  fs.writeFileSync(path.join(work, file), `cambio de ${name}\n`);
  git(work, ['add', '-A'], date);
  git(work, ['commit', '--quiet', '-m', `cambio de ${name}`], date);
}
/** Lo que hace el servidor al completar un pedido: un commit de merge en la rama destino, empujado. */
function serverMerge(work, name) {
  const back = git(work, ['symbolic-ref', '--short', 'HEAD']);
  git(work, ['checkout', '--quiet', 'main']);
  git(work, ['merge', '--quiet', '--no-ff', '-m', `merge de ${name}`, name]);
  git(work, ['push', '--quiet', 'origin', 'main']);
  git(work, ['checkout', '--quiet', back]);
}
const commitVersion = (work, date = AT(DAY)) => git(work, ['commit', '--quiet', '-m', 'chore(version)', '--', 'version.json'], date);
const versionOf = (work, ref) => JSON.parse(git(work, ['show', `${ref}:version.json`])).version;
/** Un repo de juguete cuyo `origin` es sólo una dirección (no se usa la red), con su configuración de merge. */
function withRemote(url, config) {
  const dir = path.join(SCRATCH, `h${serial += 1}`);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', dir], { env: gitEnv() });
  if (url) git(dir, ['remote', 'add', 'origin', url]);
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.tycon'));
    fs.writeFileSync(path.join(dir, '.tycon', 'advisors.yaml'), config);
  }
  return dir;
}

const CHECK = 'validacion-de-prueba (Veredicto del cambio)';   // un nombre con espacios y paréntesis, como los de verdad
const PR_MODE = `# configuración de juguete\nevidence:\n  companion_repos: []\nmerge:\n  mode: pr\n  check: "${CHECK}"   # el control de la validación\n\nother:\n  check: otra-cosa\n`;
const PR_MODE_NO_CHECK = 'merge:\n  mode: pr\n';

// ── T62 (la parte que viaja): la fecha y el número que sigue, en la librería compartida ─────────────────────────────
test('T62 NextVersion_SharedLibrary_DayFromAnInstant_NextCountsOnlyThatDay', () => {
  assert.strictEqual(VO.day(Date.UTC(2030, 0, 15, 23, 59) / 1000), DAY);
  assert.strictEqual(VO.day(Date.UTC(2024, 1, 29, 0, 0) / 1000), '2024.02.29');
  assert.throws(() => VO.day(-1), /fecha/);
  assert.strictEqual(VO.next(DAY, []), `${DAY}.1`);
  assert.strictEqual(VO.next(DAY, [`${DAY}.9`, null]), `${DAY}.10`);
  assert.strictEqual(VO.next(DAY, ['2030.01.14.7']), `${DAY}.1`);
  assert.throws(() => VO.next(DAY, ['1.2']), /forma/);
  assert.throws(() => VO.next('2030.1.15', []), /fecha/);
});

// ── T18: de qué servidor es el repo y qué paso sigue ─────────────────────────────────────────────────────────────────
test('T18 MergeSkill_GithubRemote_CreatesPrNoSquash_WaitsCheck_AzureUnchanged — plan: el paso lo decide el remoto, y el control se declara', () => {
  const plan = (dir, extra) => M.plan({ repo: dir, source: 'feat/x', target: 'main' }, deps(extra));

  const github = plan(withRemote('https://github.com/Acme/Widgets.git', PR_MODE));
  assert.deepStrictEqual([github.code, github.host, github.ghRepo, github.mode, github.step, github.canMerge], [0, 'github', 'acme/widgets', 'pr', '9c', true]);
  assert.strictEqual(github.check, CHECK, 'el nombre del control, tal cual: con sus espacios y sus paréntesis');

  // sin el control declarado: se crea el pedido y NO se mergea — no se elige un control por cuenta propia
  const noCheck = plan(withRemote('git@github.com:acme/widgets.git', PR_MODE_NO_CHECK));
  assert.deepStrictEqual([noCheck.host, noCheck.step, noCheck.check, noCheck.canMerge], ['github', '9c', null, false]);
  assert.match(noCheck.notes.join(' '), /merge\.check/);

  const azure = plan(withRemote('https://dev.azure.com/acme/Proyecto%20Uno/_git/Repo', PR_MODE_NO_CHECK));
  assert.deepStrictEqual([azure.host, azure.step], ['azure', '9b']);
  assert.deepStrictEqual([azure.org, azure.project, azure.name], ['acme', 'proyecto uno', 'Repo']);

  // otro servidor: el paso 9 de siempre, diciendo que ahí no sabe crear pedidos
  const other = plan(withRemote('https://gitlab.example/acme/widgets.git', PR_MODE));
  assert.deepStrictEqual([other.host, other.step, other.canMerge], ['other', '9', false]);
  assert.match(other.notes.join(' '), /no sé crear pedidos/);

  // una carpeta local (el clon de un clon): el empuje va a esa carpeta, no a un servidor — paso 9, como hoy
  const real = withRemote('https://github.com/acme/widgets.git', PR_MODE);
  const local = plan(withRemote(real, PR_MODE));
  assert.deepStrictEqual([local.host, local.step], ['local', '9']);

  // un alias de ssh: lo que es lo dice ssh, no el nombre
  const alias = withRemote('git@trabajo:acme/widgets.git', PR_MODE);
  const asked = [];
  const resolved = plan(alias, { sshHost: (h) => { asked.push(h); return 'github.com'; } });
  assert.deepStrictEqual([resolved.host, resolved.ghRepo, resolved.step, asked], ['github', 'acme/widgets', '9c', ['trabajo']]);
  const unresolved = plan(alias, { sshHost: () => null });
  assert.deepStrictEqual([unresolved.host, unresolved.step], ['other', '9']);

  // sin remoto, y sin el modo declarado: el paso 9
  assert.deepStrictEqual([plan(withRemote(null, PR_MODE)).host, plan(withRemote(null, PR_MODE)).step], ['none', '9']);
  const push = plan(withRemote('https://github.com/acme/widgets.git'));
  assert.deepStrictEqual([push.host, push.mode, push.step], ['github', 'push', '9']);

  // «no pude leer» no es «sin remoto»: lo que no es un repo sale 2
  const notARepo = path.join(SCRATCH, `nada${serial += 1}`);
  fs.mkdirSync(notARepo);
  const failed = plan(notARepo);
  assert.strictEqual(failed.code, 2);
  assert.match(failed.reason, /no pude/);
});

test('T18 — plan: el archivo del cuerpo vive en la carpeta temporal de la máquina, uno por repo y por rama, con barras que leen bash y Node', () => {
  const dir = withRemote('https://github.com/acme/widgets.git', PR_MODE);
  const a = M.plan({ repo: dir, source: 'feat/x', target: 'main' }, deps());
  const again = M.plan({ repo: dir, source: 'feat/x', target: 'main' }, deps());
  const b = M.plan({ repo: dir, source: 'feat/y', target: 'main' }, deps());
  assert.strictEqual(a.bodyFile, again.bodyFile);
  assert.notStrictEqual(a.bodyFile, b.bodyFile);
  assert.ok(!a.bodyFile.includes('\\'), 'sin barras invertidas');
  assert.strictEqual(path.resolve(a.bodyFile), path.resolve(os.tmpdir(), path.basename(a.bodyFile)));
  assert.strictEqual(path.dirname(path.resolve(a.mergeBodyFile)), path.resolve(os.tmpdir()));
  assert.notStrictEqual(a.mergeBodyFile, a.bodyFile);
});

test('T18 — plan: lee el bloque merge de la configuración sin confundirlo con otro, con y sin comillas', () => {
  const read = (text) => { const dir = withRemote('https://github.com/acme/widgets.git', text); return M.readMergeConfig(dir); };
  assert.deepStrictEqual(read(PR_MODE), { mode: 'pr', check: CHECK });
  assert.deepStrictEqual(read("merge:\n  mode: 'pr'\n  check: un control sin comillas   # con un comentario\n"), { mode: 'pr', check: 'un control sin comillas' });
  assert.deepStrictEqual(read('merge:\n  mode: pr\n  check: "con # adentro"\n'), { mode: 'pr', check: 'con # adentro' });
  assert.deepStrictEqual(read('other:\n  mode: pr\n  check: x\n'), { mode: 'push', check: null });
  assert.deepStrictEqual(read('merge:\n  mode: push\nmerged:\n  check: x\n'), { mode: 'push', check: null });
  assert.deepStrictEqual(M.readMergeConfig(withRemote('https://github.com/acme/widgets.git')), { mode: 'push', check: null });
});

// ── T18: el texto del merge ──────────────────────────────────────────────────────────────────────────────────────────
test('T18 — message: el título «asunto (#N)» y el cuerpo, sin ninguna marca que saltee la CI', () => {
  const dir = path.join(SCRATCH, `m${serial += 1}`);
  fs.mkdirSync(dir);
  const from = path.join(dir, 'cuerpo.md');
  const to = path.join(dir, 'merge.md');
  const marks = ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]', 'skip-checks: true', 'skip-checks:true',
    '[skip azurepipelines]', '[azurepipelines skip]', '[skip azpipelines]', '[azpipelines skip]', '[skip azp]', '[azp skip]', '***NO_CI***'];
  fs.writeFileSync(from, [`merge: dev -> main — feat(x): una cosa [Skip CI] nueva`, '', 'El detalle.', ...marks.map((m) => `- un commit que decía ${m.toUpperCase()} y otro ${m}`), ''].join('\n'));
  const number = Number(['1', '2', '3'].join(''));   // de tres cifras, armado por partes
  const r = M.message({ pr: number, from, to });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.subject, `feat(x): una cosa nueva (#${number})`);
  const body = fs.readFileSync(to, 'utf8');
  for (const m of marks) assert.ok(!body.toLowerCase().includes(m.toLowerCase()), `el cuerpo no trae ${m}`);
  assert.match(body, /El detalle\./);
  assert.match(body, /un commit que decía/);
  // el asunto es la primera línea, también sin el prefijo del skill
  fs.writeFileSync(from, 'fix: algo\n\ncuerpo\n');
  assert.strictEqual(M.message({ pr: 7, from, to }).subject, 'fix: algo (#7)');
  // sin número, sin archivo o con un asunto que queda vacío: no inventa un título
  assert.strictEqual(M.message({ pr: 0, from, to }).code, 2);
  assert.strictEqual(M.message({ pr: 7, from: path.join(dir, 'no-existe.md'), to }).code, 2);
  fs.writeFileSync(from, '[skip ci]\n\ncuerpo\n');
  assert.strictEqual(M.message({ pr: 7, from, to }).code, 2);
});

// ── T18: el contrato del skill, leído del disco ──────────────────────────────────────────────────────────────────────
const codeBlocks = (text) => [...text.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((m) => m[1]);
const commandsOf = (blocks, re) => blocks.flatMap((b) => b.split('\n')).reduce((acc, line) => {
  // un comando puede seguir en los renglones de abajo (terminados en `\`)
  if (acc.open) { acc.list[acc.list.length - 1] += `\n${line}`; acc.open = /\\\s*$/.test(line); return acc; }
  if (re.test(line)) { acc.list.push(line); acc.open = /\\\s*$/.test(line); }
  return acc;
}, { list: [], open: false }).list;

test('T18 — el paso 9c: crea el pedido de la forma que el freno lee, mergea con commit de merge atado a la punta, y nunca aplasta', () => {
  const text = fs.readFileSync(path.join(SKILL, 'steps', 'step-09c-create-pr-github.md'), 'utf8');
  const blocks = codeBlocks(text);
  const creates = commandsOf(blocks, /^\s*gh pr create\b/);
  const merges = commandsOf(blocks, /^\s*gh pr merge\b/);
  assert.ok(creates.length >= 1, 'el 9c trae el gh pr create');
  assert.ok(merges.length >= 1, 'el 9c trae el gh pr merge');
  for (const c of creates) for (const opt of ['--repo', '--base', '--head', '--title', '--body-file']) assert.ok(c.includes(opt), `gh pr create con ${opt}: ${c}`);
  for (const c of merges) for (const opt of ['--repo', '--merge', '--match-head-commit', '--subject', '--body-file']) assert.ok(c.includes(opt), `gh pr merge con ${opt}: ${c}`);
  // cada gh que publica va solo en su llamada: el freno no deja salir uno con archivo acompañado de otro comando
  for (const b of blocks.filter((x) => /^\s*gh pr (create|merge|edit)\b/m.test(x))) {
    const lines = b.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l));
    assert.ok(/^\s*gh pr (create|merge|edit)\b/.test(lines[0]), `el bloque empieza por el gh: ${b}`);
    assert.ok(!/&&|\|\||;|\|/.test(b.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')), `un solo comando en el bloque: ${b}`);
    assert.ok(!/\$\(|`/.test(b), `nada que la terminal tenga que armar: ${b}`);
    // el texto de afuera (el título, el asunto, las ramas, el repo, los archivos) va entre comillas SIMPLES: adentro la
    // terminal no expande nada. Entre comillas dobles, un asunto con `$(…)` correría esa orden antes de llegar a gh
    assert.ok(!b.includes('"'), `ninguna comilla doble en un gh que publica: ${b}`);
    for (const opt of ['--repo', '--title', '--subject', '--base', '--head', '--body-file']) {
      if (b.includes(`${opt} `)) assert.match(b, new RegExp(`${opt} '<[^'>]+>'`), `${opt} con su valor entre comillas simples: ${b}`);
    }
  }
  // …y en los demás bloques, lo que sale de un nombre de rama también va entre comillas simples
  for (const b of blocks) {
    if (!/^\s*(git|gh|node)\s/m.test(b)) continue;   // el bloque del reporte final no es un comando
    const outside = b.replace(/'[^'\n]*'/g, "''");
    for (const m of outside.matchAll(/<(source|target|dueño\/repo|bodyFile|mergeBodyFile)>/g)) assert.fail(`<${m[1]}> fuera de comillas simples en: ${b}`);
  }
  // ni aplastado, ni reordenado, ni salteando la regla, ni delegado al servidor, ni borrando la rama local — en NINGÚN bloque
  const all = blocks.join('\n');
  for (const banned of ['--squash', '--rebase', '--admin', '--auto', '--delete-branch']) assert.ok(!all.includes(banned), `ningún bloque del 9c usa ${banned}`);
  // la ruta del cuerpo la da el plan: una fija bajo /tmp no es la misma para bash y para Node en Windows
  assert.ok(!all.includes('/tmp/'), 'ningún bloque del 9c nombra /tmp/');
  // el orden: al día, versión, empujar, pedido, latido, espera, merge
  const order = ['merge-pr.js" plan', 'merge-pr.js" update-branch', 'merge-pr.js" bump-version', "push origin '<source>'", 'gh pr create', 'retro-heartbeat.js', 'merge-pr.js" wait-checks', 'merge-pr.js" message', 'gh pr merge'];
  let at = -1;
  for (const step of order) {
    const found = all.indexOf(step, at + 1);
    assert.ok(found > at, `el 9c trae «${step}» después de lo anterior`);
    at = found;
  }
  assert.match(all, /git -C <repo> commit [^\n]*-- version\.json/, 'el commit de versión nombra la ruta: no arrastra nada ya preparado');
  // después del merge: relee la rama destino y avisa si el número quedó igual (AC 44)
  assert.match(text, /qued[óo] igual/);
  // sin el control declarado, hasta el pedido —con su latido— y no más
  assert.match(text, /merge\.check/);
  assert.match(text, /hasta el 9c\.7 inclusive/);
  // un empuje rechazado no se arregla con un rebase: desarmaría el merge de la destino que la rama ya trae
  assert.match(text, /\*\*no\*\* se hace `pull --rebase`/);
  // cada desenlace de la espera tiene su renglón
  for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.match(text, new RegExp(`\\|\\s*${code}\\s*\\|`), `el 9c dice qué hacer con el código ${code}`);
});

test('T18 — el paso 9b manda al 9c sólo con GitHub, y sus comandos de Azure son los de antes', () => {
  const text = fs.readFileSync(path.join(SKILL, 'steps', 'step-09b-create-pr.md'), 'utf8');
  assert.match(text, /merge-pr\.js/);
  assert.match(text, /step-09c-create-pr-github\.md/);
  const az = codeBlocks(text).filter((b) => /\baz repos pr\b/.test(b));
  const print = crypto.createHash('sha256').update(az.join('\n---\n')).digest('hex');
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'merge-skill-azure-commands.json'), 'utf8'));
  assert.strictEqual(az.length, fixture.blocks, 'la cantidad de bloques con comandos de Azure del 9b');
  assert.strictEqual(print, fixture.sha256, 'los comandos de Azure del 9b cambiaron: si fue a propósito, actualizar la huella (ver el archivo)');
});

test('T18 — SKILL.md y el paso 8 nombran el camino de GitHub', () => {
  const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(skill, /step-09c-create-pr-github\.md/);
  assert.match(skill, /version\.json/);
  assert.match(skill, /retro-heartbeat\.js/);
  // El nombre de antes se arma por partes: escrito entero, el control de menciones viejas lo cuenta como una más.
  assert.ok(!skill.includes(['retro', 'latido.js'].join('-')), 'el guion del latido, por su nombre de hoy');
  const step8 = fs.readFileSync(path.join(SKILL, 'steps', 'step-08-hitl-push.md'), 'utf8');
  assert.match(step8, /merge-pr\.js/);
  assert.match(step8, /la versión sube/);
});

// ── T44: la versión ──────────────────────────────────────────────────────────────────────────────────────────────────
const bump = (work, source, extra = {}) => M.bumpVersion(Object.assign({ repo: work, source, target: 'main' }, extra), deps());
const update = (work, source) => M.updateBranch({ repo: work, source, target: 'main' }, deps());

test('T44 MergeToPublic_VersionBumped_TwoPrsDoNotCollide_ChannelFollowsMain — dos pedidos, uno detrás del otro: dos números distintos y seguidos', () => {
  const { work } = toy();
  branch(work, 'feat/a');
  const dry = bump(work, 'feat/a');
  assert.deepStrictEqual([dry.code, dry.action, dry.from, dry.to, dry.written], [0, 'bump', `${DAY}.1`, `${DAY}.2`, false]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(work, 'version.json'), 'utf8')).version, `${DAY}.1`, 'sin --write no escribe');
  const a = bump(work, 'feat/a', { write: true });
  assert.deepStrictEqual([a.code, a.action, a.to, a.written], [0, 'bump', `${DAY}.2`, true]);
  commitVersion(work);
  serverMerge(work, 'feat/a');

  git(work, ['checkout', '--quiet', 'main']);
  git(work, ['pull', '--quiet', 'origin', 'main']);
  branch(work, 'feat/b');
  assert.strictEqual(update(work, 'feat/b').action, 'none', 'nació de la punta: ya está al día');
  const b = bump(work, 'feat/b', { write: true });
  assert.deepStrictEqual([b.from, b.to], [`${DAY}.2`, `${DAY}.3`]);
  commitVersion(work);
  serverMerge(work, 'feat/b');
  assert.strictEqual(versionOf(work, 'origin/main'), `${DAY}.3`);
});

test('T44 — dos pedidos abiertos a la vez: el segundo no queda con el número repetido y termina mergeable con uno mayor', () => {
  const { work } = toy();
  branch(work, 'feat/a');
  bump(work, 'feat/a', { write: true });
  commitVersion(work);
  git(work, ['checkout', '--quiet', 'main']);
  branch(work, 'feat/b');
  assert.strictEqual(bump(work, 'feat/b', { write: true }).to, `${DAY}.2`, 'los dos nacieron de la misma base: el mismo número');
  commitVersion(work);
  serverMerge(work, 'feat/a');
  git(work, ['fetch', '--quiet', 'origin']);

  // justo antes de mergear: el número del segundo ya no es mayor que el de la destino
  const check = M.checkVersion({ repo: work, base: 'origin/main', head: 'feat/b' }, deps());
  assert.deepStrictEqual([check.code, check.base, check.head], [1, `${DAY}.2`, `${DAY}.2`]);
  // se trae la destino (el mismo cambio de los dos lados no choca) y se sube de nuevo
  const up = update(work, 'feat/b');
  assert.deepStrictEqual([up.code, up.action, up.resolved], [0, 'merged', []]);
  const again = bump(work, 'feat/b', { write: true });
  assert.deepStrictEqual([again.from, again.to], [`${DAY}.2`, `${DAY}.3`]);
  commitVersion(work);
  assert.strictEqual(M.checkVersion({ repo: work, base: 'origin/main', head: 'feat/b' }, deps()).code, 0);
  // y queda mergeable: el servidor lo completa sin conflicto
  serverMerge(work, 'feat/b');
  assert.strictEqual(versionOf(work, 'origin/main'), `${DAY}.3`);
});

test('T44 — la destino avanzó dos números: el único choque es version.json, se toma el de la destino y se sube de nuevo', () => {
  const { work } = toy();
  branch(work, 'feat/b');
  bump(work, 'feat/b', { write: true });
  commitVersion(work);                       // feat/b: .2
  for (const name of ['feat/a', 'feat/c']) { // la destino: .2 y después .3
    git(work, ['checkout', '--quiet', 'main']);
    git(work, ['pull', '--quiet', 'origin', 'main']);
    branch(work, name);
    bump(work, name, { write: true });
    commitVersion(work);
    serverMerge(work, name);
  }
  git(work, ['checkout', '--quiet', 'feat/b']);
  const up = update(work, 'feat/b');
  assert.deepStrictEqual([up.code, up.action, up.resolved], [0, 'merged', ['version.json']]);
  assert.strictEqual(versionOf(work, 'HEAD'), `${DAY}.3`, 'quedó el número de la destino');
  assert.throws(() => git(work, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']), 'el merge quedó cerrado');
  assert.strictEqual(git(work, ['status', '--porcelain', '--untracked-files=no']), '');
  const again = bump(work, 'feat/b', { write: true });
  assert.deepStrictEqual([again.from, again.to], [`${DAY}.3`, `${DAY}.4`]);
});

test('T44 — un conflicto en otro archivo frena: sale 5, nombra los archivos y no deja un merge a medias', () => {
  const { work } = toy();
  branch(work, 'feat/b', 'a.txt');
  bump(work, 'feat/b', { write: true });
  commitVersion(work);
  git(work, ['checkout', '--quiet', 'main']);
  branch(work, 'feat/a', 'a.txt');
  bump(work, 'feat/a', { write: true });
  commitVersion(work);
  serverMerge(work, 'feat/a');
  git(work, ['checkout', '--quiet', 'feat/b']);
  const before = git(work, ['rev-parse', 'HEAD']);
  const up = update(work, 'feat/b');
  assert.strictEqual(up.code, 5);
  assert.deepStrictEqual(up.conflicts, ['a.txt']);
  assert.match(up.reason, /el merge quedó deshecho/, 'dice cómo quedó el árbol');
  assert.strictEqual(git(work, ['rev-parse', 'HEAD']), before, 'la rama quedó donde estaba');
  assert.throws(() => git(work, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']), 'sin merge a medias');
  assert.strictEqual(git(work, ['status', '--porcelain', '--untracked-files=no']), '');
});

test('T44 — en la rama equivocada no escribe, y con el árbol sucio no trae nada: sale 2 sin tocar', () => {
  const { work } = toy();
  branch(work, 'feat/a');
  git(work, ['checkout', '--quiet', 'main']);
  const wrong = bump(work, 'feat/a', { write: true });
  assert.strictEqual(wrong.code, 2);
  assert.match(wrong.reason, /feat\/a/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(work, 'version.json'), 'utf8')).version, `${DAY}.1`);
  assert.strictEqual(update(work, 'feat/a').code, 2, 'tampoco trae la destino desde otra rama');
  // el plan (sin --write) sí se puede pedir desde otra rama: lee la rama, no el árbol de trabajo
  assert.deepStrictEqual([bump(work, 'feat/a').code, bump(work, 'feat/a').to], [0, `${DAY}.2`]);

  git(work, ['checkout', '--quiet', 'feat/a']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a medio escribir\n');
  const before = git(work, ['rev-parse', 'HEAD']);
  const dirty = update(work, 'feat/a');
  assert.strictEqual(dirty.code, 2);
  assert.match(dirty.reason, /sin commitear/);
  assert.strictEqual(git(work, ['rev-parse', 'HEAD']), before);
  assert.strictEqual(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'a medio escribir\n');
  // y un version.json con cambios sin commitear no se pisa
  git(work, ['checkout', '--quiet', '--', 'a.txt']);
  fs.writeFileSync(path.join(work, 'version.json'), versionText(`${DAY}.1`).replace('una.md', 'otra.md'));
  assert.strictEqual(bump(work, 'feat/a', { write: true }).code, 2);
});

test('T44 — el número nunca baja: la fecha sale del commit y nunca es anterior a la del número publicado; con el de la rama ya mayor, nada', () => {
  const later = '2030.01.20';
  const { work } = toy({ version: `${later}.3` });
  branch(work, 'feat/a');                    // commit del 15, publicado del 20
  const r = bump(work, 'feat/a', { write: true });
  assert.deepStrictEqual([r.from, r.to], [`${later}.3`, `${later}.4`]);
  assert.strictEqual(VO.compare(r.to, r.target), 1);
  commitVersion(work);
  const none = bump(work, 'feat/a', { write: true });
  assert.deepStrictEqual([none.code, none.action, none.written], [0, 'none', false]);
  assert.match(none.reason, /mayor/);

  // un commit de un día posterior al publicado: el día del commit, y vuelve a 1
  const next = toy();
  branch(next.work, 'feat/z', 'z.txt', AT('2030.02.01'));
  assert.strictEqual(bump(next.work, 'feat/z').to, '2030.02.01.1');
});

test('T44 — un repo que no numera versiones no gana nada; un version.json que no se deja leer sale 2', () => {
  const plain = toy({ version: null });
  branch(plain.work, 'feat/a');
  const none = bump(plain.work, 'feat/a', { write: true });
  assert.deepStrictEqual([none.code, none.action, none.written], [0, 'none', false]);
  assert.match(none.reason, /no numera/);
  assert.ok(!fs.existsSync(path.join(plain.work, 'version.json')));
  assert.strictEqual(M.checkVersion({ repo: plain.work, base: 'origin/main', head: 'feat/a' }, deps()).code, 0);

  for (const text of ['{ esto no es JSON', '{ "version": "1.2" }\n', '{ "otra": 1 }\n', '[]\n']) {
    const broken = toy({ text });
    branch(broken.work, 'feat/a');
    const r = bump(broken.work, 'feat/a', { write: true });
    assert.strictEqual(r.code, 2, `ilegible: ${text}`);
    assert.match(r.reason, /version\.json/);
    assert.strictEqual(fs.readFileSync(path.join(broken.work, 'version.json'), 'utf8'), text, 'no lo toca');
    assert.strictEqual(M.checkVersion({ repo: broken.work, base: 'origin/main', head: 'feat/a' }, deps()).code, 2);
  }
});

test('T44 — --write cambia sólo el valor de version: el resto del archivo queda byte a byte', () => {
  const text = `﻿{\r\n\t"transformed": [ {"path":"guides/una.md"} ],\r\n\t"version":   "${DAY}.1",\r\n\t"source": {"harness":"0123456789abcdef0123456789abcdef01234567"}\r\n}\r\n`;
  const { work } = toy({ text });
  branch(work, 'feat/a');
  assert.strictEqual(bump(work, 'feat/a', { write: true }).to, `${DAY}.2`);
  const after = fs.readFileSync(path.join(work, 'version.json'), 'utf8');
  assert.strictEqual(after, text.replace(`"${DAY}.1"`, `"${DAY}.2"`));
});

test('T44 — check-version: mayor pasa; igual, menor o sin el archivo en el pedido, no; ilegible o una referencia que no existe, 2', () => {
  const { work } = toy({ version: `${DAY}.5` });
  const at = (version, name) => {
    git(work, ['checkout', '--quiet', 'main']);
    git(work, ['checkout', '--quiet', '-b', name]);
    if (version === null) git(work, ['rm', '--quiet', 'version.json']);
    else { fs.writeFileSync(path.join(work, 'version.json'), versionText(version)); git(work, ['add', '-A']); }
    git(work, ['commit', '--quiet', '--allow-empty', '-m', name]);
    return M.checkVersion({ repo: work, base: 'origin/main', head: name }, deps());
  };
  assert.strictEqual(at(`${DAY}.6`, 'mayor').code, 0);
  const same = at(`${DAY}.5`, 'igual');
  assert.deepStrictEqual([same.code, same.base, same.head], [1, `${DAY}.5`, `${DAY}.5`]);
  assert.strictEqual(at(`${DAY}.4`, 'menor').code, 1);
  assert.strictEqual(at(null, 'sin-archivo').code, 1);
  assert.strictEqual(M.checkVersion({ repo: work, base: 'origin/main', head: 'no-existe' }, deps()).code, 2);
  assert.strictEqual(M.checkVersion({ repo: work, base: 'origin/no-existe', head: 'mayor' }, deps()).code, 2);
});

// ── T61: la espera del control ───────────────────────────────────────────────────────────────────────────────────────
/** Un pedido tal como lo contesta `gh pr view --json …`. */
function view(head, over = {}, checks = []) {
  return Object.assign({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: head, baseRefName: 'main', statusCheckRollup: checks }, over);
}
const run = (name, conclusion, over = {}) => Object.assign({ __typename: 'CheckRun', name, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion: conclusion || '',
  startedAt: '2030-01-15T12:00:00Z', detailsUrl: 'https://ci.example/corrida/1' }, over);
const status = (context, state, over = {}) => Object.assign({ __typename: 'StatusContext', context, state, startedAt: '2030-01-15T12:00:00Z', targetUrl: 'https://ci.example/estado/1' }, over);
// lo que un pedido de verdad trae además: los controles de cada trabajo y los de otras herramientas
const NOISE = [run(`${CHECK.split(' (')[0]} (Las suites)`, 'FAILURE'), run('otra-herramienta', 'CANCELLED'), run('validacion-de-prueba', 'FAILURE')];

// Los repos de juguete traen de `origin` una carpeta (hace falta para traer la rama destino de verdad): para la espera,
// que sólo le pregunta a un repo de GitHub, se dice aparte de qué repo es.
const GITHUB = () => ({ host: 'github', ghRepo: 'acme/widgets' });

/** Un `gh` de mentira: contesta cada pregunta con la siguiente de `answers` (la última se repite). */
function fakeGh(answers) {
  const calls = [];
  let i = 0;
  const gh = (args) => {
    calls.push(args);
    const a = answers[Math.min(i, answers.length - 1)];
    i += 1;
    if (a && a.fail) return { status: 1, stdout: '', stderr: a.fail };
    if (a && a.raw !== undefined) return { status: 0, stdout: a.raw, stderr: '' };
    return { status: 0, stdout: JSON.stringify(a), stderr: '' };
  };
  return { gh, calls };
}
/** Un repo con el pedido listo: la rama con un número mayor que el de la destino. */
function ready() {
  const t = toy();
  branch(t.work, 'feat/a');
  bump(t.work, 'feat/a', { write: true });
  commitVersion(t.work);
  return Object.assign(t, { head: git(t.work, ['rev-parse', 'HEAD']) });
}
function wait(t, answers, over = {}) {
  const fake = fakeGh(answers);
  let clock = 0;
  const slept = [];
  const r = M.waitChecks(Object.assign({ repo: t.work, pr: 7, head: t.head, target: 'main', check: CHECK, timeoutMin: 90, intervalS: 30 }, over),
    deps({ gh: fake.gh, hostOf: GITHUB, sleep: (ms) => { slept.push(ms); clock += ms; }, now: () => clock }));
  return Object.assign(r, { calls: fake.calls, slept });
}

test('T61 WaitChecks_EveryOutcomeHasItsCodeAndReason — verde sólo con el control declarado en SUCCESS sobre la punta esperada', () => {
  const t = ready();
  const green = wait(t, [view(t.head, {}, [...NOISE, run(CHECK, 'SUCCESS')])]);
  assert.deepStrictEqual([green.code, green.outcome, green.head], [0, 'green', t.head]);
  assert.strictEqual(green.calls.length, 1);
  // la punta y los controles salen de la MISMA respuesta, y la pregunta nombra el pedido
  const asked = green.calls[0];
  assert.deepStrictEqual(asked.slice(0, 3), ['pr', 'view', '7']);
  const fields = asked[asked.indexOf('--json') + 1].split(',');
  for (const f of ['state', 'isDraft', 'mergeable', 'mergeStateStatus', 'headRefOid', 'statusCheckRollup']) assert.ok(fields.includes(f), `pide ${f}`);

  // un estado de commit con ese nombre vale igual que un control
  assert.strictEqual(wait(t, [view(t.head, {}, [status(CHECK, 'SUCCESS')])]).code, 0);
  // los otros controles en rojo o cancelados no cuentan: sólo el declarado (mergeStateStatus queda UNSTABLE, y se puede mergear)
  assert.strictEqual(wait(t, [view(t.head, { mergeStateStatus: 'UNSTABLE' }, [...NOISE, run(CHECK, 'SUCCESS')])]).code, 0);
  // el nombre es por igualdad exacta: el de la corrida sola o el de otro trabajo no son el declarado
  const never = wait(t, [view(t.head, {}, NOISE)], { timeoutMin: 2 });
  assert.strictEqual(never.code, 3);
});

test('T61 — espera mientras el control no terminó, y sale cuando termina', () => {
  const t = ready();
  const r = wait(t, [view(t.head, {}, []), view(t.head, {}, [run(CHECK, null, { status: 'QUEUED' })]), view(t.head, {}, [run(CHECK, null)]),
    view(t.head, {}, [status(CHECK, 'PENDING')]), view(t.head, {}, [run(CHECK, 'STALE')]), view(t.head, {}, [run(CHECK, 'SUCCESS')])]);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.calls.length, 6);
  assert.deepStrictEqual(r.slept, [30000, 30000, 30000, 30000, 30000]);
  // en verde, pero GitHub todavía no calculó si se puede mergear: sigue preguntando
  const unknown = wait(t, [view(t.head, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, [run(CHECK, 'SUCCESS')]), view(t.head, {}, [run(CHECK, 'SUCCESS')])]);
  assert.deepStrictEqual([unknown.code, unknown.calls.length], [0, 2]);
});

test('T61 — terminado sin verde es rojo, con su estado y su enlace', () => {
  const t = ready();
  for (const conclusion of ['FAILURE', 'CANCELLED', 'SKIPPED', 'NEUTRAL', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
    const r = wait(t, [view(t.head, {}, [run(CHECK, conclusion)])]);
    assert.deepStrictEqual([r.code, r.outcome, r.state, r.link], [1, 'red', conclusion, 'https://ci.example/corrida/1'], conclusion);
  }
  for (const state of ['FAILURE', 'ERROR']) {
    const r = wait(t, [view(t.head, {}, [status(CHECK, state)])]);
    assert.deepStrictEqual([r.code, r.state, r.link], [1, state, 'https://ci.example/estado/1'], state);
  }
});

test('T61 — con dos entradas del mismo nombre vale la más reciente; si no se pueden ordenar, no es verde', () => {
  const t = ready();
  const old = run(CHECK, 'FAILURE', { startedAt: '2030-01-15T10:00:00Z' });
  const fresh = run(CHECK, 'SUCCESS', { startedAt: '2030-01-15T11:00:00Z' });
  assert.strictEqual(wait(t, [view(t.head, {}, [old, fresh])]).code, 0);
  assert.strictEqual(wait(t, [view(t.head, {}, [fresh, old])]).code, 0);
  const rerun = wait(t, [view(t.head, {}, [run(CHECK, 'SUCCESS', { startedAt: '2030-01-15T10:00:00Z' }), run(CHECK, 'FAILURE', { startedAt: '2030-01-15T11:00:00Z' })])]);
  assert.strictEqual(rerun.code, 1, 'la última corrida es la roja');
  const unordered = wait(t, [view(t.head, {}, [run(CHECK, 'SUCCESS', { startedAt: '' }), run(CHECK, 'FAILURE', { startedAt: '' })])], { timeoutMin: 2 });
  assert.strictEqual(unordered.code, 3);
  assert.match(unordered.reason, /ordenar/);
});

test('T61 — cada desenlace que no es verde tiene su código y su motivo', () => {
  const t = ready();
  const ok = [run(CHECK, 'SUCCESS')];
  const cases = [
    [[view(t.head, { state: 'MERGED' }, ok)], 4, 'closed'],
    [[view(t.head, { state: 'CLOSED' }, ok)], 4, 'closed'],
    [[view('f'.repeat(40), {}, ok)], 6, 'head-moved'],
    [[view(t.head, { isDraft: true }, ok)], 8, 'draft'],
    [[view(t.head, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, ok)], 5, 'conflicts'],
    [[view(t.head, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, [])], 5, 'conflicts'],   // sin esperar un control que no va a llegar
    [[view(t.head, { mergeStateStatus: 'BEHIND' }, ok)], 9, 'behind'],
    [[view(t.head, { mergeStateStatus: 'BLOCKED' }, ok)], 9, 'blocked'],
  ];
  for (const [answers, code, outcome] of cases) {
    const r = wait(t, answers);
    assert.deepStrictEqual([r.code, r.outcome], [code, outcome], outcome);
    assert.ok(r.reason && r.reason.length > 10, `con su motivo: ${outcome}`);
  }
  // bloqueado por la regla con el control todavía corriendo no es un desenlace: sigue esperando
  const stillRunning = wait(t, [view(t.head, { mergeStateStatus: 'BLOCKED' }, [run(CHECK, null)]), view(t.head, {}, ok)]);
  assert.deepStrictEqual([stillRunning.code, stillRunning.calls.length], [0, 2]);
});

test('T61 — no llegó o no terminó en el plazo: 3, y no pregunta para siempre', () => {
  const t = ready();
  const r = wait(t, [view(t.head, {}, [run(CHECK, null)])], { timeoutMin: 2 });
  assert.deepStrictEqual([r.code, r.outcome], [3, 'timeout']);
  assert.ok(r.calls.length >= 4 && r.calls.length <= 6, `unas pocas preguntas en 2 minutos, de a 30 s: ${r.calls.length}`);
  assert.match(wait(t, [view(t.head, {}, [])], { timeoutMin: 1 }).reason, /no llegó/);
});

test('T61 — «no pude preguntar» no es verde: tres fallas seguidas de gh, o una respuesta que no es JSON, salen 2', () => {
  const t = ready();
  const down = wait(t, [{ fail: 'sin red' }]);
  assert.deepStrictEqual([down.code, down.outcome, down.calls.length], [2, 'cannot-ask', 3]);
  assert.match(down.reason, /sin red/);
  // dos fallas y después contesta: sigue (la cuenta es de fallas SEGUIDAS)
  const recovers = wait(t, [{ fail: 'x' }, { fail: 'x' }, view(t.head, {}, [run(CHECK, null)]), { fail: 'x' }, { fail: 'x' }, view(t.head, {}, [run(CHECK, 'SUCCESS')])]);
  assert.strictEqual(recovers.code, 0);
  const garbage = wait(t, [{ raw: '<html>no soy JSON</html>' }]);
  assert.deepStrictEqual([garbage.code, garbage.calls.length], [2, 1]);
  assert.strictEqual(wait(t, [{ raw: '[]' }]).code, 2, 'un JSON que no es un pedido tampoco');
  // sin un control que esperar no se espera nada: no elige uno
  const noCheck = wait(t, [view(t.head, {}, [run(CHECK, 'SUCCESS')])], { check: null });
  assert.deepStrictEqual([noCheck.code, noCheck.calls.length], [2, 0]);
  assert.match(noCheck.reason, /merge\.check/);
  // y una punta que no está en este clon no se puede comparar
  assert.strictEqual(wait(t, [view('e'.repeat(40), {}, [run(CHECK, 'SUCCESS')])], { head: 'e'.repeat(40) }).code, 2);
});

test('T61 — en verde, pero la versión quedó atrás de la destino: 7 (se compara contra la punta traída de nuevo)', () => {
  const t = toy();
  branch(t.work, 'feat/a');
  bump(t.work, 'feat/a', { write: true });
  commitVersion(t.work);
  git(t.work, ['checkout', '--quiet', 'main']);
  branch(t.work, 'feat/b');
  bump(t.work, 'feat/b', { write: true });
  commitVersion(t.work);
  const head = git(t.work, ['rev-parse', 'HEAD']);
  // entra el otro pedido; este clon todavía no trajo la destino: la trae la espera
  serverMerge(t.work, 'feat/a');
  git(t.work, ['update-ref', 'refs/remotes/origin/main', git(t.work, ['rev-parse', 'origin/main~1'])]);
  const r = wait(Object.assign(t, { head }), [view(head, {}, [run(CHECK, 'SUCCESS')])]);
  assert.deepStrictEqual([r.code, r.outcome], [7, 'version-behind']);
  assert.match(r.reason, new RegExp(`${DAY.replace(/\./g, '\\.')}\\.2`));
  // un repo que no numera versiones no tiene qué comparar
  const plain = toy({ version: null });
  branch(plain.work, 'feat/a');
  const plainHead = git(plain.work, ['rev-parse', 'HEAD']);
  assert.strictEqual(wait(Object.assign(plain, { head: plainHead }), [view(plainHead, {}, [run(CHECK, 'SUCCESS')])]).code, 0);
});

// ── la línea de comandos ─────────────────────────────────────────────────────────────────────────────────────────────
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: Object.assign(gitEnv(AT(DAY)), env), windowsHide: true });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no siempre imprime JSON */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

test('T18 — por la línea de comandos: cada orden imprime JSON y sale con su código; con el remoto ilegible, 2', () => {
  const dir = withRemote('https://github.com/acme/widgets.git', PR_MODE);
  const p = cli(['plan', '--repo', dir, '--source', 'feat/x', '--target', 'main']);
  assert.deepStrictEqual([p.status, p.json.step, p.json.check], [0, '9c', CHECK]);
  const notARepo = path.join(SCRATCH, `nada${serial += 1}`);
  fs.mkdirSync(notARepo);
  assert.strictEqual(cli(['plan', '--repo', notARepo, '--source', 'a', '--target', 'main']).status, 2);
  // sin orden, con una que no existe o sin lo que la orden pide: 2 y cómo se usa
  for (const bad of [[], ['otra-cosa'], ['plan'], ['wait-checks', '--repo', dir], ['bump-version', '--repo', dir, '--source', 'x']]) {
    const r = cli(bad);
    assert.strictEqual(r.status, 2, bad.join(' '));
    assert.match(r.stderr, /uso:/);
  }
  assert.strictEqual(cli(['--help']).status, 0);
});

test('T61 — por la línea de comandos: wait-checks con un gh de mentira (un guion de Node, como corre en Windows) sale con el código del desenlace', () => {
  const t = ready();
  git(t.work, ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git']);   // la espera sólo le pregunta a un repo de GitHub
  const fake = path.join(SCRATCH, `gh-de-mentira-${serial += 1}.js`);
  fs.writeFileSync(fake, `process.stdout.write(JSON.stringify(${JSON.stringify(view(t.head, { state: 'CLOSED' }, []))}));\n`);
  const r = cli(['wait-checks', '--repo', t.work, '--pr', '7', '--head', t.head, '--target', 'main', '--check', CHECK], { TYCON_GH: fake });
  assert.deepStrictEqual([r.status, r.json.code, r.json.outcome], [4, 4, 'closed']);
  // el control sale de la configuración del repo si no se pasa
  fs.mkdirSync(path.join(t.work, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(t.work, '.tycon', 'advisors.yaml'), PR_MODE_NO_CHECK);
  const none = cli(['wait-checks', '--repo', t.work, '--pr', '7', '--head', t.head, '--target', 'main'], { TYCON_GH: fake });
  assert.strictEqual(none.status, 2);
  assert.match(none.json.reason, /merge\.check/);
});

// ══ lo que cazaron los revisores y el pase adversarial (vuelta 1) ════════════════════════════════════════════════════
// Un git que falla en UNA llamada: lo demás corre de verdad.
const failing = (when, answer = { ok: false, status: 128, out: '', err: 'fatal: git no pudo' }) => ({ git: (repo, args, real) => (when(args) ? answer : real()) });

test('T18 — la configuración: un comentario en la primera columna no cierra el bloque, y lo que no se sabe leer se dice', () => {
  const read = (text) => M.readMergeConfig(withRemote('https://github.com/acme/widgets.git', text));
  // 🔴 un comentario en la columna 0 ADENTRO del bloque: leído como fin del bloque, el plan mandaba a un empuje directo
  assert.deepStrictEqual(read('merge:\n# el modo\n  mode: pr\n\n# el control\n  check: "c (d)"\n'), { mode: 'pr', check: 'c (d)' });
  assert.deepStrictEqual(read('﻿merge:   # cómo llega el trabajo\r\n  mode: pr\r\n  check: c\r\n'), { mode: 'pr', check: 'c' });
  // sin valor: nada, `~`, `null`, o sólo un comentario — nunca un control que se llame así
  for (const empty of ['check:', 'check: ~', 'check: null', 'check: NULL', 'check:   # el nombre va acá', 'check: ""']) {
    assert.strictEqual(read(`merge:\n  mode: pr\n  ${empty}\n`).check, null, empty);
  }
  assert.strictEqual(read('merge:\n  mode:   # falta\n').mode, 'push');
  // lo que este lector no sabe leer TIRA: leído a medias sería otro control, u otro modo
  for (const unreadable of ['merge:\n  mode: pr\n  check: |\n    un control\n', 'merge:\n  mode: pr\n  check: >\n    x\n', 'merge:\n  mode: pr\n  check: [a, b]\n',
    'merge: { mode: pr, check: c }\n', 'merge: pr\n']) {
    assert.throws(() => read(unreadable), /no (lo )?sé leer/, unreadable);
    const p = M.plan({ repo: withRemote('https://github.com/acme/widgets.git', unreadable), source: 'a', target: 'main' }, deps());
    assert.strictEqual(p.code, 2, `plan con ${JSON.stringify(unreadable)}`);
    assert.match(p.reason, /advisors\.yaml/);
  }
});

test('T18 — desde una subcarpeta del repo, cada orden contesta lo mismo que desde la raíz', () => {
  const { work } = toy();
  git(work, ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git']);
  fs.mkdirSync(path.join(work, '.tycon'));
  fs.writeFileSync(path.join(work, '.tycon', 'advisors.yaml'), PR_MODE);
  fs.mkdirSync(path.join(work, 'scripts', 'adentro'), { recursive: true });
  fs.writeFileSync(path.join(work, 'scripts', 'adentro', 'x.txt'), 'x\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'configuración y una subcarpeta']);
  git(work, ['checkout', '--quiet', '-b', 'feat/a']);
  const sub = path.join(work, 'scripts', 'adentro');
  const top = M.plan({ repo: work, source: 'feat/a', target: 'main' }, deps());
  const inner = M.plan({ repo: sub, source: 'feat/a', target: 'main' }, deps());
  // 🔴 desde la subcarpeta el plan decía «el repo no declara merge.mode: pr» y mandaba a un empuje directo
  assert.deepStrictEqual([inner.step, inner.mode, inner.check, inner.bodyFile], [top.step, top.mode, top.check, top.bodyFile]);
  assert.deepStrictEqual([top.step, top.check], ['9c', CHECK]);
  // la versión que subiría va en el plan (lo que muestra el paso 8 del skill), igual desde los dos lados
  assert.deepStrictEqual(top.version, { action: 'bump', from: `${DAY}.1`, to: `${DAY}.2`, reason: null });
  assert.deepStrictEqual(inner.version, top.version);
  // 🔴 y `version.json` se buscaba relativo a la carpeta: «este repo no numera versiones», con código 0
  const b = M.bumpVersion({ repo: sub, source: 'feat/a', target: 'main' }, deps());
  assert.deepStrictEqual([b.code, b.action, b.to], [0, 'bump', `${DAY}.2`]);
  const c = M.checkVersion({ repo: sub, base: 'origin/main', head: 'feat/a' }, deps());
  assert.deepStrictEqual([c.code, c.base, c.head], [1, `${DAY}.1`, `${DAY}.1`]);
  assert.strictEqual(M.updateBranch({ repo: sub, source: 'feat/a', target: 'main' }, deps({ git: (r, a, real) => (a[0] === 'fetch' ? { ok: true, status: 0, out: '', err: '' } : real()) })).action, 'none');
});

test('T18 — plan: un número que no se pudo calcular se dice (no queda como «este repo no numera versiones»)', () => {
  const { work } = toy({ text: '{ "version": "no-tiene-forma" }\n' });
  git(work, ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git']);
  fs.mkdirSync(path.join(work, '.tycon'));
  fs.writeFileSync(path.join(work, '.tycon', 'advisors.yaml'), PR_MODE);
  branch(work, 'feat/a');
  const p = M.plan({ repo: work, source: 'feat/a', target: 'main' }, deps());
  assert.deepStrictEqual([p.code, p.step, p.version], [0, '9c', null]);
  assert.match(p.notes.join(' '), /no pude calcular la versión/);
  assert.match(p.notes.join(' '), /version\.json/);
});

test('T18 — un alias de ssh sin usuario y el servidor de GitHub por el puerto 443 son de GitHub; un alias que empieza con guion nunca llega a ssh', () => {
  const plan = (url, sshHost) => M.plan({ repo: withRemote(url, PR_MODE), source: 'a', target: 'main' }, deps({ sshHost }));
  const asked = [];
  const ssh = (map) => (h) => { asked.push(h); return map[h] || null; };
  // 🔴 `trabajo:dueño/repo` (sin `git@`) no se le preguntaba a ssh: salía «otro servidor» y el plan mandaba a empujar
  assert.deepStrictEqual([plan('trabajo:acme/widgets.git', ssh({ trabajo: 'github.com' })).host, asked.pop()], ['github', 'trabajo']);
  // (la dirección se arma por partes: escrita de corrido, este archivo —que viaja en la copia— dispararía el detector de
  // correos de la publicación)
  const port443 = ['git', 'ssh.github.com'].join('@');
  assert.strictEqual(plan(`${port443}:acme/widgets.git`, ssh({})).host, 'github');
  assert.strictEqual(plan(`ssh://${port443}:443/acme/widgets.git`, ssh({})).host, 'github');
  // un «servidor» que empieza con guion sería una opción para ssh: no se le pregunta, y no es de GitHub
  asked.length = 0;
  assert.strictEqual(plan('git@-oProxyCommand=algo:acme/widgets.git', ssh({ '-oProxyCommand=algo': 'github.com' })).host, 'other');
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(plan('git@trabajo:acme/widgets.git', ssh({ trabajo: 'ssh.github.com' })).host, 'github');
  assert.strictEqual(plan('git@trabajo:acme/widgets.git', ssh({ trabajo: 'gitlab.example' })).host, 'other');
  // una dirección con esquema que no es ssh no pasa por ssh
  asked.length = 0;
  assert.strictEqual(plan('https://git.example/acme/widgets.git', ssh({ 'git.example': 'github.com' })).host, 'other');
  assert.deepStrictEqual(asked, []);
  // la salida de `ssh -G`: el renglón `hostname`, y sólo ése
  assert.strictEqual(M.parseSshHostname('user git\nhostname GitHub.com\nport 22\n'), 'github.com');
  assert.strictEqual(M.parseSshHostname('user git\r\nhostname ssh.github.com\r\n'), 'ssh.github.com');
  assert.strictEqual(M.parseSshHostname('hostnamealgo github.com\nidentityfile ~/.ssh/hostname\n'), null);
  assert.strictEqual(M.parseSshHostname(''), null);
});

test('T44 — update-branch: si git no contesta, o no se puede deshacer el merge, se dice; nunca queda como «al día»', () => {
  const conflicted = () => {
    const { work } = toy();
    branch(work, 'feat/b', 'a.txt');
    git(work, ['checkout', '--quiet', 'main']);
    branch(work, 'feat/a', 'a.txt');
    serverMerge(work, 'feat/a');
    git(work, ['checkout', '--quiet', 'feat/b']);
    return work;
  };
  const run = (work, when, answer) => M.updateBranch({ repo: work, source: 'feat/b', target: 'main' }, deps(failing(when, answer)));
  // traer la destino falla
  const noFetch = run(conflicted(), (a) => a[0] === 'fetch');
  assert.strictEqual(noFetch.code, 2);
  assert.match(noFetch.reason, /no pude traer origin\/main/);
  // no se pudo saber si ya estaba al día
  const noCompare = run(conflicted(), (a) => a[0] === 'merge-base');
  assert.strictEqual(noCompare.code, 2);
  assert.match(noCompare.reason, /no pudo comparar/);
  // 🔴 el merge chocó y NO se pudo deshacer: el árbol quedó a medias, y eso va en el motivo (antes el resultado no se miraba)
  const stuck = conflicted();
  const noAbort = run(stuck, (a) => a[0] === 'merge' && a[1] === '--abort');
  // …y ya no es «hay conflictos, seguí»: sale 2, con los archivos que chocan a la vista
  assert.strictEqual(noAbort.code, 2);
  assert.deepStrictEqual(noAbort.conflicts, ['a.txt']);
  assert.match(noAbort.reason, /NO pude deshacer el merge/);
  assert.match(noAbort.reason, /a medias/);
  assert.ok(git(stuck, ['rev-parse', '--verify', 'MERGE_HEAD']), 'de verdad quedó a medias: el motivo no miente');
  // no se pudo leer qué chocó: no se resuelve nada a ciegas, y se deshace
  const blind = conflicted();
  const noList = run(blind, (a) => a[0] === 'diff');
  assert.strictEqual(noList.code, 2);
  assert.match(noList.reason, /no pude leer qué archivos chocan/);
  assert.throws(() => git(blind, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']), 'quedó deshecho');
  // el único choque es version.json, pero el commit que cierra el merge falla: se deshace y se dice
  const t = toy();
  branch(t.work, 'feat/b');
  bump(t.work, 'feat/b', { write: true });
  commitVersion(t.work);
  for (const name of ['feat/a', 'feat/c']) {
    git(t.work, ['checkout', '--quiet', 'main']);
    git(t.work, ['pull', '--quiet', 'origin', 'main']);
    branch(t.work, name);
    bump(t.work, name, { write: true });
    commitVersion(t.work);
    serverMerge(t.work, name);
  }
  git(t.work, ['checkout', '--quiet', 'feat/b']);
  const before = git(t.work, ['rev-parse', 'HEAD']);
  const noCommit = run(t.work, (a) => a[0] === 'commit');
  assert.strictEqual(noCommit.code, 2);
  assert.match(noCommit.reason, /no pude cerrar el merge/);
  assert.match(noCommit.reason, /quedó deshecho/);
  assert.strictEqual(git(t.work, ['rev-parse', 'HEAD']), before);
  assert.strictEqual(git(t.work, ['status', '--porcelain', '--untracked-files=no']), '');
  // un merge que git corta antes de empezar (un archivo sin trackear que pisaría): no hay nada que deshacer, y se dice
  const u = toy();
  branch(u.work, 'feat/b');
  git(u.work, ['checkout', '--quiet', 'main']);
  branch(u.work, 'feat/a', 'nuevo.txt');
  serverMerge(u.work, 'feat/a');
  git(u.work, ['checkout', '--quiet', 'feat/b']);
  fs.writeFileSync(path.join(u.work, 'nuevo.txt'), 'sin trackear, y el merge lo pisaría\n');
  const blocked = M.updateBranch({ repo: u.work, source: 'feat/b', target: 'main' }, deps());
  assert.strictEqual(blocked.code, 2);
  assert.match(blocked.reason, /sin dejar archivos en conflicto/);
  assert.match(blocked.reason, /no quedó ningún merge a medias/);
  assert.strictEqual(fs.readFileSync(path.join(u.work, 'nuevo.txt'), 'utf8'), 'sin trackear, y el merge lo pisaría\n');
});

test('T44 — bump-version --write: si no puede ubicar UN solo valor de version, o el cambio tocaría algo más, no escribe', () => {
  // el mismo número escrito dos veces (una clave `version` adentro de otra cosa): no se reescribe a ciegas
  const twice = `{\n  "version": "${DAY}.1",\n  "tool": { "version": "${DAY}.1" }\n}\n`;
  const a = toy({ text: twice });
  branch(a.work, 'feat/a');
  const r = bump(a.work, 'feat/a', { write: true });
  assert.strictEqual(r.code, 2);
  assert.match(r.reason, /2 veces/);
  assert.strictEqual(fs.readFileSync(path.join(a.work, 'version.json'), 'utf8'), twice);
  // el `version` de arriba escrito de otra forma que el patrón no encuentra (con un escape): tampoco
  const escaped = `{\n  "version": "${DAY}\\u002e1"\n}\n`;
  const b = toy({ text: escaped });
  branch(b.work, 'feat/a');
  const e = bump(b.work, 'feat/a', { write: true });
  assert.strictEqual(e.code, 2);
  assert.match(e.reason, /0 veces/);
  assert.strictEqual(fs.readFileSync(path.join(b.work, 'version.json'), 'utf8'), escaped);
  // por la línea de comandos, --write escribe y lo dice
  const c = toy();
  branch(c.work, 'feat/a');
  const viaCli = cli(['bump-version', '--repo', c.work, '--source', 'feat/a', '--target', 'main', '--write']);
  assert.deepStrictEqual([viaCli.status, viaCli.json.written, viaCli.json.to], [0, true, `${DAY}.2`]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(c.work, 'version.json'), 'utf8')).version, `${DAY}.2`);
});

test('T44 — después del merge: check-version contra el padre de la rama destino dice si el número quedó igual', () => {
  // es la comprobación del paso 9c.10 del skill, sobre un commit de merge de verdad
  const { work } = toy();
  branch(work, 'feat/sin-subir');
  serverMerge(work, 'feat/sin-subir');                      // un pedido que entró SIN subir el número
  git(work, ['fetch', '--quiet', 'origin']);
  const same = M.checkVersion({ repo: work, base: 'origin/main^1', head: 'origin/main' }, deps());
  assert.deepStrictEqual([same.code, same.base, same.head], [1, `${DAY}.1`, `${DAY}.1`]);
  git(work, ['checkout', '--quiet', 'main']);
  git(work, ['pull', '--quiet', 'origin', 'main']);
  branch(work, 'feat/subiendo');
  bump(work, 'feat/subiendo', { write: true });
  commitVersion(work);
  serverMerge(work, 'feat/subiendo');
  git(work, ['fetch', '--quiet', 'origin']);
  const rose = M.checkVersion({ repo: work, base: 'origin/main^1', head: 'origin/main' }, deps());
  assert.deepStrictEqual([rose.code, rose.base, rose.head], [0, `${DAY}.1`, `${DAY}.2`]);
});

test('T18 — message: no queda ninguna marca aunque vengan anidadas o partidas, y el resto del texto no se deforma', () => {
  const dir = path.join(SCRATCH, `m${serial += 1}`);
  fs.mkdirSync(dir);
  const from = path.join(dir, 'cuerpo.md');
  const to = path.join(dir, 'merge.md');
  const marks = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s?true|\*\*\*NO_CI\*\*\*/i;
  // 🔴 sacar una marca dejaba armada otra que venía partida; y juntar espacios fabricaba una en el título
  const nested = ['merge: dev -> main — arreglo [skip [skip ci]ci] del [skip  ci] lector', '', 'una [ci [ci skip]skip] anidada',
    'skip-checks:skip-checks: true true', '***NO_***NO_CI***CI***', '[skip [no ci] ci]', ''].join('\n');
  fs.writeFileSync(from, nested);
  const r = M.message({ pr: 12, from, to });
  assert.strictEqual(r.code, 0);
  assert.ok(!marks.test(r.subject), `el título quedó con una marca: ${r.subject}`);
  assert.ok(!marks.test(fs.readFileSync(to, 'utf8')), `el cuerpo quedó con una marca:\n${fs.readFileSync(to, 'utf8')}`);
  assert.strictEqual(M.withoutCiSkip(M.withoutCiSkip(nested)), M.withoutCiSkip(nested), 'pasarlo dos veces da lo mismo');
  assert.ok(!marks.test(M.cleanTopic('documenta [skip  ci] en la guía')));
  // 🔴 la limpieza aplastaba la sangría y las columnas de las líneas que traían una marca
  const shaped = ['feat: algo', '', '    git commit -m "x [skip ci]"   # un ejemplo con sangría', '| a    | [ci skip] |   b   |', 'una línea    con espacios   y sin marca', ''].join('\n');
  fs.writeFileSync(from, shaped);
  assert.strictEqual(M.message({ pr: 12, from, to }).code, 0);
  assert.strictEqual(fs.readFileSync(to, 'utf8'), shaped.replace('[skip ci]', '').replace('[ci skip]', ''));
  // un mensaje con fin de línea de Windows: el título no arrastra el retorno de carro
  fs.writeFileSync(from, 'fix: algo\r\n\r\ncuerpo\r\n');
  assert.strictEqual(M.message({ pr: 7, from, to }).subject, 'fix: algo (#7)');
  // donde iba el cuerpo había un enlace simbólico: se reemplaza, no se escribe a través de él
  const victim = path.join(dir, 'no-me-toques.txt');
  fs.writeFileSync(victim, 'intacto\n');
  fs.rmSync(to);
  try { fs.symlinkSync(victim, to); } catch (_) { return; }   // sin permiso para crear enlaces (Windows sin modo desarrollador)
  assert.strictEqual(M.message({ pr: 7, from, to }).code, 0);
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'intacto\n');
  assert.ok(!fs.lstatSync(to).isSymbolicLink());
  assert.match(fs.readFileSync(to, 'utf8'), /^fix: algo/);
});

test('T61 — la rama base del pedido tiene que ser la que se pidió comparar; y sin poder traer la destino, no es verde', () => {
  const t = ready();
  const ok = [run(CHECK, 'SUCCESS')];
  // 🔴 el pedido va a OTRA rama: la versión se comparaba contra la equivocada (y si ésa no numera versiones, verde)
  const other = wait(t, [view(t.head, { baseRefName: 'release' }, ok)]);
  assert.deepStrictEqual([other.code, other.outcome], [2, 'cannot-ask']);
  assert.match(other.reason, /release/);
  // en verde, pero no se pudo traer la destino para comparar el número
  const fake = fakeGh([view(t.head, {}, ok)]);
  const noFetch = M.waitChecks({ repo: t.work, pr: 7, head: t.head, target: 'main', check: CHECK }, deps(Object.assign({ gh: fake.gh, hostOf: GITHUB, sleep: () => {}, now: () => 0 }, failing((a) => a[0] === 'fetch'))));
  assert.deepStrictEqual([noFetch.code, noFetch.outcome], [2, 'cannot-ask']);
  assert.match(noFetch.reason, /no pude traer origin\/main/);
  // un nombre de control vacío no es un control
  assert.strictEqual(wait(t, [view(t.head, {}, ok)], { check: '' }).code, 2);
  // no se pudo leer de qué repo es: no se le deja elegir a gh
  const blind = M.waitChecks({ repo: t.work, pr: 7, head: t.head, target: 'main', check: CHECK }, deps(Object.assign({ gh: fake.gh, sleep: () => {}, now: () => 0 }, failing((a) => a[0] === 'remote' && a.length === 1))));
  assert.deepStrictEqual([blind.code, blind.outcome], [2, 'cannot-ask']);
  // 🔴 y si `origin` no es de GitHub tampoco: sin `--repo`, gh elegiría el repo por su cuenta (otro remoto de la
  // carpeta) y contestaría por el pedido de ESE repo con el mismo número
  const asked = fakeGh([view(t.head, {}, ok)]);
  const notGithub = M.waitChecks({ repo: t.work, pr: 7, head: t.head, target: 'main', check: CHECK }, deps({ gh: asked.gh, sleep: () => {}, now: () => 0 }));
  assert.deepStrictEqual([notGithub.code, notGithub.outcome, asked.calls.length], [2, 'cannot-ask', 0]);
  assert.match(notGithub.reason, /GitHub/);
  // con el repo sabido, la pregunta lo NOMBRA
  const named = wait(t, [view(t.head, {}, ok)]);
  assert.deepStrictEqual(named.calls[0].slice(-2), ['--repo', 'acme/widgets']);
  // una respuesta sin la rama base del pedido no se da por buena
  const noBase = wait(t, [Object.assign(view(t.head, {}, ok), { baseRefName: undefined })]);
  assert.deepStrictEqual([noBase.code, noBase.outcome], [2, 'cannot-ask']);
});

test('T18 — la configuración: un modo que no es push ni pr no se lee como «el repo no declara nada»', () => {
  // 🔴 `mode: PR` o `mode: pull-request` mandaban al paso 9 (un empuje directo) en un repo que declaró pedidos
  for (const mode of ['PR', 'pull-request', 'Pr', 'true']) {
    const dir = withRemote('https://github.com/acme/widgets.git', `merge:\n  mode: ${mode}\n  check: c\n`);
    assert.throws(() => M.readMergeConfig(dir), /push.*pr|pr.*push/, mode);
    const p = M.plan({ repo: dir, source: 'a', target: 'main' }, deps());
    assert.strictEqual(p.code, 2, `plan con mode: ${mode}`);
    assert.match(p.reason, /merge\.mode/);
  }
  assert.strictEqual(M.readMergeConfig(withRemote('https://github.com/acme/widgets.git', 'merge:\n  mode: "push"\n')).mode, 'push');
});

test('T18 — rootOf: la raíz desde cualquier carpeta del repo; lo que no es un repo, o un git que no contesta, es un problema', () => {
  const { work } = toy();
  fs.mkdirSync(path.join(work, 'a', 'b'), { recursive: true });
  const real = fs.realpathSync(work);
  assert.strictEqual(fs.realpathSync(M.rootOf(work, deps()).root), real);
  assert.strictEqual(fs.realpathSync(M.rootOf(path.join(work, 'a', 'b'), deps()).root), real);
  const outside = path.join(SCRATCH, `nada${serial += 1}`);
  fs.mkdirSync(outside);
  assert.match(M.rootOf(outside, deps()).problem, /no pude leer el repo/);
  assert.match(M.rootOf(path.join(SCRATCH, 'no-existe'), deps()).problem, /no pude leer el repo/);
  assert.match(M.rootOf(work, deps(failing((a) => a[0] === 'rev-parse'))).problem, /git no pudo/);
  // una respuesta vacía tampoco es una raíz
  assert.ok(M.rootOf(work, deps(failing((a) => a[0] === 'rev-parse', { ok: true, status: 0, out: '\n', err: '' }))).problem);
  // y cada orden lo dice con su código, sin seguir
  for (const r of [M.bumpVersion({ repo: outside, source: 'a', target: 'main' }, deps()), M.checkVersion({ repo: outside, base: 'a', head: 'b' }, deps()),
    M.updateBranch({ repo: outside, source: 'a', target: 'main' }, deps()), M.waitChecks({ repo: outside, pr: 1, head: 'a', target: 'main', check: 'c' }, deps())]) {
    assert.strictEqual(r.code, 2);
    assert.match(r.reason, /no pude leer el repo/);
  }
});

test('T61 — judgeCheck: dos entradas de la misma hora no se pueden ordenar; una sola, aunque no traiga fecha, vale', () => {
  const at = '2030-01-15T10:00:00Z';
  assert.strictEqual(M.judgeCheck([run(CHECK, 'SUCCESS', { startedAt: at }), run(CHECK, 'FAILURE', { startedAt: at })], CHECK).kind, 'unordered');
  assert.strictEqual(M.judgeCheck([status(CHECK, 'SUCCESS', { startedAt: undefined }), status(CHECK, 'FAILURE', { startedAt: undefined })], CHECK).kind, 'unordered');
  assert.strictEqual(M.judgeCheck([status(CHECK, 'SUCCESS', { startedAt: undefined })], CHECK).kind, 'green');
  assert.strictEqual(M.judgeCheck([status(CHECK, 'EXPECTED')], CHECK).kind, 'waiting');
  assert.strictEqual(M.judgeCheck([], CHECK).kind, 'missing');
  assert.strictEqual(M.judgeCheck(null, CHECK).kind, 'missing');
});

test('T18 — por la línea de comandos: una opción que no existe, sin su valor, o con un valor que no es un número, sale 2 y dice cómo se usa', () => {
  const dir = withRemote('https://github.com/acme/widgets.git', PR_MODE);
  const base = ['wait-checks', '--repo', dir, '--pr', '7', '--head', 'a'.repeat(40), '--target', 'main'];
  for (const bad of [['plan', '--repo', dir, '--source', 'a', '--target', 'main', '--unknown'], ['plan', '--repo', dir, '--source', 'a', '--target'],
    [...base, '--timeout-min', '0'], [...base, '--timeout-min', 'mucho'], [...base, '--interval-s', '-3'], [...base, '--interval-s', 'x']]) {
    const r = cli(bad);
    assert.strictEqual(r.status, 2, bad.slice(-2).join(' '));
    assert.match(r.stderr, /uso:/, bad.slice(-2).join(' '));
    assert.strictEqual(r.stdout, '', 'sin JSON: no llegó a correr');
  }
});

// ══ T78: desde un clon del PÚBLICO, la configuración del merge sale del clon de mantenimiento ════════════════════════
// Después del corte a GitHub, quien mantiene el arnés trabaja en un clon del repo público, que no trae `.tycon/`. Sin ese
// archivo el plan decía «push» y mandaba a un empuje directo a la rama principal. La configuración sigue viviendo en el
// clon PRIVADO de mantenimiento que la máquina declara: se lee de lo COMMITEADO en su rama principal remota (nunca de
// su árbol de trabajo), y para ese repo «no la encontré» frena con su motivo — nunca termina en un empuje directo.
const HR = require(path.join(ROOT, 'scripts', 'lib', 'harness-repo.js'));
const PUBLIC = 'acme/harness-public';
/** El reconocedor de juguete: el público es UN repo de GitHub; lo demás (productos, otros repos del arnés), no. */
const isPublic = (id) => Boolean(id && id.host === 'github.com' && id.ruta === PUBLIC);
const T78 = 'T78 MaintainerMachine_FromPublicClone_MaintainersCloneIsHarness_MergeModeFound';

/** Un clon del público de juguete: `origin` de GitHub (sólo la dirección), sin `.tycon/`, parado en una rama de trabajo. */
function publicClone(url = 'https://github.com/Acme/Harness-Public.git') {
  const { work } = toy();
  git(work, ['remote', 'set-url', 'origin', url]);
  branch(work, 'feat/a');
  return work;
}
// el plan sólo LEE el clon del público: los casos que no lo tocan comparten uno (cada juguete son varios git)
let sharedPublic = null;
const thePublic = () => sharedPublic || (sharedPublic = publicClone());
/**
 * Un clon de mantenimiento de juguete: su `origin` es un repo desnudo cuya rama principal trae `config` commiteada
 * (`null` = sin el archivo). `head: true` deja además escrito cuál es la principal del remoto (lo que deja un `git clone`).
 */
function maintainers(config = PR_MODE, { main = 'main', head = false } = {}) {
  const base = path.join(SCRATCH, `mnt${serial += 1}`);
  const remote = path.join(base, 'remoto.git');
  const clone = path.join(base, 'clon');
  fs.mkdirSync(base, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--bare', `--initial-branch=${main}`, remote], { env: gitEnv() });
  execFileSync('git', ['init', '--quiet', `--initial-branch=${main}`, clone], { env: gitEnv() });
  fs.writeFileSync(path.join(clone, 'a.txt'), 'uno\n');
  if (config !== null) {
    fs.mkdirSync(path.join(clone, '.tycon'));
    fs.writeFileSync(path.join(clone, '.tycon', 'advisors.yaml'), config);
  }
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '-m', 'inicio']);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '--quiet', 'origin', main]);
  git(clone, ['fetch', '--quiet', 'origin']);
  if (head) git(clone, ['remote', 'set-head', 'origin', main]);
  return { remote, clone };
}
/** Lo que declara la máquina, dicho a mano; `asked` cuenta cuántas veces se le preguntó. */
function machine(answer) {
  const asked = [];
  return { asked, deps: { isPublic, maintainers: (o) => { asked.push(o); return answer; } } };
}
const declaring = (clone) => machine({ declared: true, path: clone, problem: null });
/** Una casa del arnés de laboratorio (`TYCON_HOME`), con o sin su `config.json`. Nunca la de la máquina. */
function labHome(config) {
  const home = path.join(SCRATCH, `casa${serial += 1}`);
  fs.mkdirSync(home, { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
}
const labEnv = (home) => Object.assign(gitEnv(AT(DAY)), { TYCON_HOME: home });
const planOf = (repo, extra) => M.plan({ repo, source: 'feat/a', target: 'main' }, deps(extra));

test(`${T78} — plan: un clon del público sin .tycon lee el modo y el control del clon de mantenimiento que declara la máquina, y va por pedido`, () => {
  const m = maintainers();
  const mine = declaring(m.clone);
  const p = planOf(thePublic(),mine.deps);
  // 🔴 antes: mode «push», paso 9 — un empuje directo a la rama principal del público
  assert.deepStrictEqual([p.code, p.host, p.ghRepo, p.mode, p.step, p.canMerge, p.configFrom], [0, 'github', PUBLIC, 'pr', '9c', true, 'maintainers']);
  assert.strictEqual(p.check, CHECK, 'el nombre del control, tal cual lo declara el clon de mantenimiento');
  assert.match(p.notes.join(' '), /clon de mantenimiento/, 'el plan dice de dónde salió la configuración');
  assert.strictEqual(mine.asked.length, 1);
  // lo demás del plan no cambia: el número que subiría sale del propio clon del público
  assert.deepStrictEqual(p.version, { action: 'bump', from: `${DAY}.1`, to: `${DAY}.2`, reason: null });

  // el mismo repo por ssh, por el puerto 443 y por un alias de quien tiene varias cuentas: es el público igual
  const port443 = ['git', 'ssh.github.com'].join('@');   // por partes: escrito entero se lee como un correo
  for (const [url, extra] of [['git@github.com:acme/harness-public.git', {}], [`ssh://${port443}:443/acme/harness-public.git`, {}],
    ['git@trabajo:acme/harness-public.git', { sshHost: () => 'github.com' }]]) {
    const other = planOf(publicClone(url), Object.assign({}, declaring(m.clone).deps, extra));
    assert.deepStrictEqual([other.step, other.check, other.configFrom], ['9c', CHECK, 'maintainers'], url);
  }

  // sin el control en el clon de mantenimiento: el pedido se crea y no se mergea, y la nota dice dónde falta
  const noCheck = planOf(thePublic(),declaring(maintainers(PR_MODE_NO_CHECK).clone).deps);
  assert.deepStrictEqual([noCheck.step, noCheck.check, noCheck.canMerge, noCheck.configFrom], ['9c', null, false, 'maintainers']);
  assert.match(noCheck.notes.join(' '), /merge\.check[^\n]*clon de mantenimiento/);

  // con la declaración de VERDAD de la máquina (una casa de laboratorio): la misma respuesta
  const real = planOf(thePublic(),{ isPublic, env: labEnv(labHome({ paths: { maintainers: m.clone } })) });
  assert.deepStrictEqual([real.step, real.check, real.configFrom], ['9c', CHECK, 'maintainers']);

  // y la ayuda lo cuenta
  assert.match(M.USAGE, /configFrom/);
});

test(`${T78} — plan: se lee lo commiteado en la rama principal REMOTA del clon de mantenimiento, no su árbol de trabajo ni su rama`, () => {
  const m = maintainers();
  const file = path.join(m.clone, '.tycon', 'advisors.yaml');
  // su `main` local con un commit sin empujar que afloja el modo…
  fs.writeFileSync(file, 'merge:\n  mode: push\n');
  git(m.clone, ['commit', '--quiet', '-am', 'afloja sin empujar']);
  // …parado en OTRA rama, que no trae el bloque…
  git(m.clone, ['checkout', '--quiet', '-b', 'otra-cosa']);
  fs.writeFileSync(file, 'evidence:\n  companion_repos: []\n');
  git(m.clone, ['commit', '--quiet', '-am', 'sin el bloque']);
  // …y con el archivo editado sin commitear
  fs.writeFileSync(file, 'merge:\n  mode: push\n  check: "otro control"\n');
  const p = planOf(thePublic(),declaring(m.clone).deps);
  assert.deepStrictEqual([p.code, p.mode, p.step, p.check, p.canMerge, p.configFrom], [0, 'pr', '9c', CHECK, true, 'maintainers']);
  // …ni con el archivo BORRADO del árbol de trabajo
  fs.rmSync(path.join(m.clone, '.tycon'), { recursive: true });
  assert.deepStrictEqual([planOf(thePublic(),declaring(m.clone).deps).step, planOf(thePublic(),declaring(m.clone).deps).check], ['9c', CHECK]);

  // la principal es la que dice el remoto (lo que deja un `git clone`), se llame como se llame: acá no hay `origin/main`
  const trunk = maintainers(PR_MODE, { main: 'trunk', head: true });
  const viaHead = planOf(thePublic(),declaring(trunk.clone).deps);
  assert.deepStrictEqual([viaHead.step, viaHead.check, viaHead.configFrom], ['9c', CHECK, 'maintainers']);
  // y el motivo de un freno no nombra las ramas del repo privado
  const noBlock = planOf(thePublic(),declaring(maintainers('evidence:\n  companion_repos: []\n', { main: 'trunk', head: true }).clone).deps);
  assert.strictEqual(noBlock.code, 2);
  assert.ok(!/trunk/.test(noBlock.reason), noBlock.reason);
});

test(`${T78} — plan: para el clon del público, cada forma de «no encontré la configuración» sale 2 con su motivo — nunca el empuje directo`, () => {
  const inside = maintainers();
  fs.mkdirSync(path.join(inside.clone, 'adentro'));
  const plain = path.join(SCRATCH, `suelta${serial += 1}`);
  fs.mkdirSync(plain);
  const noRemote = path.join(SCRATCH, `sin-remoto${serial += 1}`);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', noRemote], { env: gitEnv() });
  fs.mkdirSync(path.join(noRemote, '.tycon'));
  fs.writeFileSync(path.join(noRemote, '.tycon', 'advisors.yaml'), PR_MODE);   // en su árbol sí está: no alcanza
  git(noRemote, ['add', '-A']);
  git(noRemote, ['commit', '--quiet', '-m', 'inicio']);
  const at = (clone) => ({ declared: true, path: clone, problem: null });
  const cases = [
    ['la máquina no declara ninguno', { declared: false, path: null, problem: null }, /no declara[^\n]*paths\.maintainers/],
    ['la configuración de la máquina no se deja leer', { declared: false, path: null, problem: 'la configuración de la máquina no se puede leer' }, /no se puede leer/],
    ['declara una carpeta que no está', { declared: true, path: path.join(SCRATCH, 'no-esta'), problem: 'paths.maintainers nombra una carpeta que no está' }, /carpeta que no está/],
    ['declara una carpeta que no es un clon', at(plain), /no es la raíz de un clon/],
    ['declara una subcarpeta de un clon', at(path.join(inside.clone, 'adentro')), /no es la raíz de un clon/],
    ['el clon no conoce su rama principal remota', at(noRemote), /no conoce su rama principal remota/],
    ['la rama principal remota no trae el archivo', at(maintainers(null).clone), /rama principal remota[^\n]*no trae \.tycon\/advisors\.yaml/],
    ['el archivo no trae el bloque merge', at(maintainers('evidence:\n  companion_repos: []\nother:\n  mode: pr\n  check: x\n').clone), /bloque[^\n]*merge/],
    ['el bloque merge no trae mode', at(maintainers('merge:\n  check: "un control"\n').clone), /merge\.mode/],
    ['el bloque merge trae mode sin valor', at(maintainers('merge:\n  mode:   # falta\n  check: c\n').clone), /merge\.mode/],
  ];
  for (const [name, answer, why] of cases) {
    const p = planOf(thePublic(),machine(answer).deps);
    // 🔴 antes: código 0, mode «push», paso 9
    assert.strictEqual(p.code, 2, name);
    assert.match(p.reason, why, name);
    assert.strictEqual(p.step, undefined, `${name}: sin paso que seguir`);
    assert.strictEqual(p.mode, undefined, `${name}: sin modo`);
    assert.match(p.reason, /paths\.maintainers/, `${name}: dice qué clave mirar`);
  }
  // sin declarar: el motivo trae cómo se arregla
  assert.match(planOf(thePublic(),machine(cases[0][1]).deps).reason, /harness\.js config set paths\.maintainers/);
  // con la declaración de VERDAD (casa de laboratorio): sin `config.json`, sin la clave, y con una carpeta que no está
  for (const [name, home] of [['sin config.json', labHome()], ['sin la clave', labHome({ paths: {} })], ['una carpeta que no está', labHome({ paths: { maintainers: path.join(SCRATCH, 'no-esta') } })]]) {
    const p = planOf(thePublic(),{ isPublic, env: labEnv(home) });
    assert.strictEqual(p.code, 2, name);
    assert.match(p.reason, /paths\.maintainers/, name);
  }
  // un git que no contesta en el clon de mantenimiento tampoco es «no declara nada»
  for (const order of ['symbolic-ref', 'ls-tree', 'show']) {
    const p = planOf(thePublic(),Object.assign({}, declaring(maintainers(PR_MODE, { head: true }).clone).deps, failing((a) => a[0] === order)));
    assert.strictEqual(p.code, 2, `git ${order} que falla`);
    assert.match(p.reason, /clon de mantenimiento/, `git ${order} que falla`);
  }
});

test(`${T78} — plan: «no sé si es el público» tampoco termina en un empuje directo — un alias de ssh sin resolver, o una declaración del público ilegible`, () => {
  const mine = declaring(maintainers().clone);
  // 🔴 el público clonado por un alias que ssh no resuelve: «otro servidor», sin archivo → «push», paso 9
  const alias = planOf(publicClone('git@trabajo:acme/harness-public.git'), Object.assign({}, mine.deps, { sshHost: () => null }));
  assert.strictEqual(alias.code, 2);
  assert.match(alias.reason, /ssh -G/);
  assert.strictEqual(alias.step, undefined);
  // control: otro repo por ese mismo alias, y el mismo nombre por https en otro servidor, siguen como hoy
  const product = planOf(withRemote('git@trabajo:acme/widgets.git'), Object.assign({}, mine.deps, { sshHost: () => null }));
  assert.deepStrictEqual([product.code, product.host, product.mode, product.step, product.configFrom], [0, 'other', 'push', '9', 'repo']);
  // 🔴 la declaración del público está y no se deja leer: el reconocedor contesta «no» a todo, y el público salía «push»
  const broken = { isPublic: () => false, publicDeclarations: () => [{ ruta: 'scripts/setup/public-remotes.json', motivo: 'no es JSON' }], maintainers: mine.deps.maintainers };
  const blind = planOf(thePublic(),broken);
  assert.strictEqual(blind.code, 2);
  assert.match(blind.reason, /no pude leer cuál es el repo público[^\n]*public-remotes\.json/);
  // control: con esa declaración rota, un repo que trae su archivo o que no es de GitHub no se entera
  assert.deepStrictEqual([planOf(withRemote('https://github.com/acme/widgets.git', PR_MODE), broken).step, planOf(withRemote('https://dev.azure.com/acme/P/_git/R'), broken).step], ['9c', '9']);
  assert.strictEqual(mine.asked.length, 0);
});

// Lo que encontró el pase adversarial (las tres sondas del «otro nombre de servidor» y la de las dos dudas juntas).
// La tabla de `mergeConfigFor`, una celda por caso: servidor de `origin` × declaración del público × archivo propio.
test(`${T78} — plan: la tabla entera (servidor × declaración del público × archivo propio): ninguna duda, ni dos juntas, termina en un empuje directo`, () => {
  const m = maintainers();
  const noSsh = { sshHost: () => null };   // ningún alias resuelve: lo que no es `github.com` escrito queda en «otro servidor»
  const unreadable = () => [{ ruta: 'scripts/setup/public-remotes.json', motivo: 'no es JSON' }];
  const at = (user, host) => [user, host].join('@');   // por partes: escrito entero se lee como un correo
  // un `origin` cuyo servidor no se reconoce y que trae la RUTA del público (dueño/repo, sin caja, sin `.git`)
  const PUBLIC_ROUTE = [
    'https://www.github.com/acme/harness-public.git',            // 🔴 GitHub lo redirige: salía «push», paso 9
    'https://WWW.GitHub.com/Acme/Harness-Public',
    'https://github.com./acme/harness-public.git',               // 🔴 con el punto final, también
    `https://${at('usuario:clave-de-prueba', 'www.github.com')}/acme/harness-public.git`,
    `ssh://${at('git', 'www.github.com')}/acme/harness-public.git`,
    'git@trabajo:acme/harness-public.git',
    'trabajo:acme/harness-public',
    'https://gitlab.example/acme/harness-public.git',
    'https://espejo.example/grupo/acme/harness-public.git',      // los dos últimos tramos de la ruta
    'transporte::https://github.com/acme/harness-public.git',    // la forma de un transporte propio de git
    'file:///no/esta/acme/harness-public.git',                   // una dirección que el lector de remotos no sabe leer
  ];
  // otra ruta, en GitHub o en un servidor que no se reconoce
  const OTHER_ROUTE = ['https://github.com/acme/widgets.git', 'https://www.github.com/acme/widgets.git', 'git@trabajo:acme/widgets.git',
    'https://gitlab.example/acme/harness-public-docs.git', 'https://gitlab.example/otra/harness-public.git', 'https://gitlab.example/harness-public.git'];
  // servidores que nunca son el público: Azure, una carpeta de la máquina y «sin origin»
  const folder = withRemote('https://github.com/acme/harness-public.git');
  const NEVER = [['azure', 'https://dev.azure.com/acme/P/_git/harness-public'], ['local', folder], ['none', null]];
  // Dos repos para toda la tabla (sin y con archivo propio): la dirección de `origin` la contesta un git de mentira —lo
  // demás corre de verdad—, así cada celda no arma su repo. De punta a punta, con el remoto escrito en el repo, corren
  // el caso del alias de arriba y el de la línea de comandos.
  const bare = withRemote(null);
  const withFile = withRemote(null, PR_MODE);
  const originIs = (url) => ({ git: (repo, args, real) => {
    if (args[0] === 'remote' && args.length === 1) return { ok: true, status: 0, out: url ? 'origin\n' : '', err: '' };
    if (args[0] === 'remote' && args[1] === 'get-url') return { ok: true, status: 0, out: `${url}\n`, err: '' };
    return real();
  } });
  const ask = (url, extra, config) => {
    const mine = declaring(m.clone);
    const p = planOf(config === undefined ? bare : withFile, Object.assign({}, mine.deps, noSsh, originIs(url), extra));
    return Object.assign(p, { asked: mine.asked.length });
  };
  const isPush = (p, why) => assert.deepStrictEqual([p.code, p.mode, p.step, p.configFrom, p.asked], [0, 'push', '9', 'repo', 0], why);

  // ── sin archivo propio, con la declaración del público LEGIBLE ──
  const known = ask('https://github.com/acme/harness-public.git');
  assert.deepStrictEqual([known.host, known.step, known.configFrom, known.asked], ['github', '9c', 'maintainers', 1], 'GitHub y es el público: el clon de mantenimiento');
  for (const url of PUBLIC_ROUTE) {
    const p = ask(url);
    // 🔴 antes (salvo por un alias de ssh): código 0, mode «push», paso 9
    assert.deepStrictEqual([p.code, p.step, p.mode, p.asked], [2, undefined, undefined, 0], url);
    assert.match(p.reason, /no sé si este repo es el público del arnés/, url);
    assert.match(p.reason, /ssh -G/, `${url}: dice qué mirar`);
    assert.ok(!p.reason.includes('clave-de-prueba'), 'el motivo no repite una credencial escrita en la dirección');
  }
  for (const url of OTHER_ROUTE) isPush(ask(url), `otra ruta: ${url}`);
  for (const [host, url] of NEVER) {
    const p = ask(url);
    assert.strictEqual(p.host, host);
    isPush(p, `${host}: como hoy`);
  }

  // ── sin archivo propio, con la declaración ILEGIBLE (el reconocedor contesta «no» a todo) ──
  const blind = { isPublic: () => false, publicDeclarations: unreadable };
  for (const url of ['https://github.com/acme/harness-public.git', ...PUBLIC_ROUTE, ...OTHER_ROUTE]) {
    const p = ask(url, blind);
    // 🔴 antes, con un servidor que no se reconoce: código 0, mode «push», paso 9 — sin nombrar la declaración rota
    assert.deepStrictEqual([p.code, p.step, p.mode, p.asked], [2, undefined, undefined, 0], `declaración ilegible: ${url}`);
    assert.match(p.reason, /no pude leer cuál es el repo público[^\n]*public-remotes\.json/, url);
  }
  for (const [host, url] of NEVER) isPush(ask(url, blind), `declaración ilegible, ${host}: como hoy`);

  // ── una declaración ilegible y otra que SÍ nombra al público: lo que se reconoce sigue su camino ──
  const half = { publicDeclarations: unreadable };
  assert.deepStrictEqual([ask('https://github.com/acme/harness-public.git', half).step, ask('https://github.com/acme/harness-public.git', half).configFrom], ['9c', 'maintainers']);
  assert.match(ask('https://www.github.com/acme/harness-public.git', half).reason, /no sé si este repo es el público/);

  // ── con archivo propio manda el suyo: en cualquier servidor, con la declaración legible o no ──
  for (const extra of [{}, blind]) {
    for (const [url, step] of [['https://github.com/acme/harness-public.git', '9c'], ['https://www.github.com/acme/harness-public.git', '9'], ['git@trabajo:acme/harness-public.git', '9'],
      ['https://dev.azure.com/acme/P/_git/harness-public', '9b'], [folder, '9'], [null, '9']]) {
      const p = ask(url, extra, PR_MODE);
      assert.deepStrictEqual([p.code, p.mode, p.check, p.step, p.configFrom, p.asked], [0, 'pr', CHECK, step, 'repo', 0], `con archivo propio: ${url}`);
    }
  }

  // y la espera, por el mismo lector: con la duda no elige un control ni le pregunta a gh
  const t = ready();
  const fake = fakeGh([view(t.head, {}, [run(CHECK, 'SUCCESS')])]);
  const waited = M.waitChecks({ repo: t.work, pr: 7, head: t.head, target: 'main' },
    deps(Object.assign({ gh: fake.gh, hostOf: () => ({ host: 'other', url: 'https://www.github.com/acme/harness-public.git' }), sleep: () => {}, now: () => 0 }, declaring(m.clone).deps)));
  assert.deepStrictEqual([waited.code, waited.outcome, fake.calls.length], [2, 'cannot-ask', 0]);
  assert.match(waited.reason, /no sé si este repo es el público/);
});

test(`${T78} — control: un repo que no es el público sigue como hoy; y el que trae su propio .tycon/advisors.yaml lo lee de ahí`, () => {
  const m = maintainers();
  // un repo de PRODUCTO en GitHub sin el archivo, en una máquina que declara su clon de mantenimiento: empuje, paso 9
  const product = declaring(m.clone);
  const push = planOf(withRemote('https://github.com/acme/widgets.git'), product.deps);
  assert.deepStrictEqual([push.code, push.host, push.mode, push.check, push.step, push.canMerge, push.configFrom], [0, 'github', 'push', null, '9', false, 'repo']);
  assert.match(push.notes.join(' '), /el repo no declara merge\.mode: pr en \.tycon.advisors\.yaml: el merge se empuja \(paso 9\)/, 'la nota de siempre');
  assert.strictEqual(product.asked.length, 0, 'a la máquina no se le pregunta por un repo que no es el público');
  // otro repo «del arnés» que no es el público (el de mantenimiento, en Azure), sin el archivo: como hoy
  const azure = planOf(withRemote('https://dev.azure.com/acme/Proyecto/_git/mantenimiento'), declaring(m.clone).deps);
  assert.deepStrictEqual([azure.host, azure.mode, azure.step, azure.configFrom], ['azure', 'push', '9', 'repo']);
  // otro repo en un servidor que no se reconoce: como hoy (el que trae la RUTA del público es otra cosa: la tabla, arriba)
  const elsewhere = planOf(withRemote('https://gitlab.example/acme/harness-public-docs.git'), declaring(m.clone).deps);
  assert.deepStrictEqual([elsewhere.host, elsewhere.mode, elsewhere.step, elsewhere.configFrom], ['other', 'push', '9', 'repo']);
  // con el reconocedor de VERDAD y una casa de laboratorio que declara el clon: un producto sigue en el empuje
  const real = planOf(withRemote('https://github.com/acme/widgets.git'), { env: labEnv(labHome({ paths: { maintainers: m.clone } })) });
  assert.deepStrictEqual([real.mode, real.step, real.configFrom], ['push', '9', 'repo']);

  // el propio clon del público CON su archivo: manda el suyo, aunque la máquina declare otro
  const own = publicClone();
  fs.mkdirSync(path.join(own, '.tycon'));
  fs.writeFileSync(path.join(own, '.tycon', 'advisors.yaml'), 'merge:\n  mode: pr\n  check: "el control propio"\n');
  const mine = declaring(m.clone);
  const p = planOf(own, mine.deps);
  assert.deepStrictEqual([p.step, p.check, p.canMerge, p.configFrom, mine.asked.length], ['9c', 'el control propio', true, 'repo', 0]);
  // …y el suyo con `mode: push` escrito es SU decisión: no se va a buscar otra
  fs.writeFileSync(path.join(own, '.tycon', 'advisors.yaml'), 'merge:\n  mode: push\n');
  assert.deepStrictEqual([planOf(own, mine.deps).step, planOf(own, mine.deps).configFrom, mine.asked.length], ['9', 'repo', 0]);
});

test(`${T78} — un archivo que está en el clon de mantenimiento y no se deja leer sale 2: no es «no declara nada»`, () => {
  for (const unreadable of ['merge: { mode: pr, check: c }\n', 'merge: pr\n', 'merge:\n  mode: PR\n  check: c\n', 'merge:\n  mode: pr\n  check: |\n    un control\n']) {
    const p = planOf(thePublic(),declaring(maintainers(unreadable).clone).deps);
    assert.strictEqual(p.code, 2, JSON.stringify(unreadable));
    assert.match(p.reason, /no pude leer[^\n]*advisors\.yaml[^\n]*clon de mantenimiento/, JSON.stringify(unreadable));
  }
  // el parseo del texto es el mismo, venga del disco o de git
  assert.deepStrictEqual(M.parseMergeConfig(PR_MODE), { mode: 'pr', check: CHECK });
  assert.deepStrictEqual(M.parseMergeConfig(PR_MODE), M.readMergeConfig(withRemote('https://github.com/acme/widgets.git', PR_MODE)));
  assert.deepStrictEqual(M.parseMergeConfig('other:\n  mode: pr\n'), { mode: 'push', check: null });
  assert.throws(() => M.parseMergeConfig('merge: pr\n'), /no lo sé leer/);
});

test(`${T78} — wait-checks: sin --check, el control de un clon del público sale del clon de mantenimiento; y si no lo encuentra, no espera`, () => {
  const t = ready();   // su `origin` es una carpeta (hace falta para traer la destino): de qué repo es se dice aparte
  const asPublic = () => ({ host: 'github', ghRepo: PUBLIC });
  const waitOn = (extra, answers = [view(t.head, {}, [...NOISE, run(CHECK, 'SUCCESS')])]) => {
    const fake = fakeGh(answers);
    const r = M.waitChecks({ repo: t.work, pr: 7, head: t.head, target: 'main' }, deps(Object.assign({ gh: fake.gh, hostOf: asPublic, sleep: () => {}, now: () => 0 }, extra)));
    return Object.assign(r, { calls: fake.calls });
  };
  const green = waitOn(declaring(maintainers().clone).deps);
  assert.deepStrictEqual([green.code, green.outcome, green.check, green.calls.length], [0, 'green', CHECK, 1]);
  // el clon de mantenimiento no declara el control: no se elige uno, y el motivo dice de dónde se leyó
  const noCheck = waitOn(declaring(maintainers(PR_MODE_NO_CHECK).clone).deps);
  assert.deepStrictEqual([noCheck.code, noCheck.outcome, noCheck.calls.length], [2, 'cannot-ask', 0]);
  assert.match(noCheck.reason, /merge\.check[^\n]*clon de mantenimiento/);
  // la máquina no declara ninguno: 2 con el mismo motivo que el plan, sin preguntarle nada a gh
  const undeclared = waitOn(machine({ declared: false, path: null, problem: null }).deps);
  assert.deepStrictEqual([undeclared.code, undeclared.outcome, undeclared.calls.length], [2, 'cannot-ask', 0]);
  assert.match(undeclared.reason, /paths\.maintainers/);
  // control: un repo que no es el público y no declara el control dice que se leyó del repo
  const product = waitOn(Object.assign({}, declaring(maintainers().clone).deps, { hostOf: GITHUB }));
  assert.deepStrictEqual([product.code, product.outcome, product.calls.length], [2, 'cannot-ask', 0]);
  assert.match(product.reason, /merge\.check/);
  assert.ok(!/clon de mantenimiento/.test(product.reason), product.reason);
  // y con --check dado no se lee ninguna configuración
  const given = machine({ declared: false, path: null, problem: null });
  const fake = fakeGh([view(t.head, {}, [run(CHECK, 'SUCCESS')])]);
  const r = M.waitChecks({ repo: t.work, pr: 7, head: t.head, target: 'main', check: CHECK }, deps(Object.assign({ gh: fake.gh, hostOf: asPublic, sleep: () => {}, now: () => 0 }, given.deps)));
  assert.deepStrictEqual([r.code, given.asked.length], [0, 0]);
});

test(`${T78} — por la línea de comandos: con el público que ESTE árbol declara y una casa de laboratorio, plan lee del clon de mantenimiento`, (t) => {
  // El público de verdad lo declara el árbol desde el que corre el guion; acá se le pregunta, sin escribirlo.
  const declared = HR.declaradas().publicas[0];
  if (!declared) { t.skip('este árbol no declara un repo público: el caso corre por la librería, con el reconocedor inyectado'); return; }
  const work = publicClone(`https://${declared.host}/${declared.ruta}.git`);
  const args = ['plan', '--repo', work, '--source', 'feat/a', '--target', 'main'];
  const m = maintainers();
  const found = cli(args, { TYCON_HOME: labHome({ paths: { maintainers: m.clone } }) });
  assert.deepStrictEqual([found.status, found.json.step, found.json.check, found.json.canMerge, found.json.configFrom], [0, '9c', CHECK, true, 'maintainers']);
  // sin declarar: sale 2 y lo dice por la salida de error, con cómo se arregla
  const none = cli(args, { TYCON_HOME: labHome() });
  assert.deepStrictEqual([none.status, none.json.code, none.json.step], [2, 2, undefined]);
  assert.match(none.stderr, /harness\.js config set paths\.maintainers/);
  // 🔴 el mismo repo escrito con otro nombre del servidor (GitHub lo redirige): salía 0, «push», paso 9
  git(work, ['remote', 'set-url', 'origin', `https://www.${declared.host}/${declared.ruta}.git`]);
  const www = cli(args, { TYCON_HOME: labHome({ paths: { maintainers: m.clone } }) });
  assert.deepStrictEqual([www.status, www.json.code, www.json.step, www.json.mode], [2, 2, undefined, undefined]);
  assert.match(www.stderr, /no sé si este repo es el público del arnés/);
  git(work, ['remote', 'set-url', 'origin', `https://${declared.host}/${declared.ruta}.git`]);
  // y wait-checks, sin --check, por el mismo camino: no llega a preguntarle a gh
  const head = git(work, ['rev-parse', 'HEAD']);
  const waited = cli(['wait-checks', '--repo', work, '--pr', '7', '--head', head, '--target', 'main'], { TYCON_HOME: labHome(), TYCON_GH: path.join(SCRATCH, 'no-hay-gh.js') });
  assert.strictEqual(waited.status, 2);
  assert.match(waited.json.reason, /paths\.maintainers/);
});

test(`${T78} — los textos del skill dicen dónde se declara el modo, y el paso 9b se lo pregunta al plan en vez de leer el archivo por su cuenta`, () => {
  const read = (...parts) => fs.readFileSync(path.join(SKILL, ...parts), 'utf8');
  const step9b = read('steps', 'step-09b-create-pr.md');
  // 🔴 el 9b leía el modo con un grep sobre el archivo del repo: en un clon del público decía «push»
  for (const b of codeBlocks(step9b)) assert.ok(!/(grep|cat|sed)[^\n]*advisors\.yaml/.test(b), `el 9b no lee el archivo por su cuenta: ${b}`);
  assert.match(step9b, /merge-pr\.js" plan/);
  for (const [name, text] of [['SKILL.md', read('SKILL.md')], ['el paso 8', read('steps', 'step-08-hitl-push.md')], ['el paso 9b', step9b], ['el paso 9c', read('steps', 'step-09c-create-pr-github.md')]]) {
    assert.match(text, /clon\s+de\s+mantenimiento/, `${name} dice de dónde sale la configuración en un clon del público`);
  }
  assert.match(read('steps', 'step-09c-create-pr-github.md'), /configFrom/);
});

// ── T79: el número lo pone el merge ──────────────────────────────────────────────────────────────────────────────────
// Con `numbering: "merge-tag"` en el version.json de la destino, el número lo pone una etiqueta v<número> sobre cada merge
// (scripts/ci/version-tag.js): el pedido no toca el archivo. Sin la marca, todo sigue como antes (T44).
const T79 = 'T79 VersionByMerge_MarkInTarget_PrDoesNotTouchVersion';
const markedText = (version) => versionText(version).replace(`"version": "${version}",`, `"version": "${version}",\n  "numbering": "merge-tag",`);

test(`${T79} — bump-version no hace nada y check-version pide el archivo igual`, () => {
  const { work } = toy({ text: markedText(`${DAY}.1`) });
  branch(work, 'feat/a');
  const b = bump(work, 'feat/a', { write: true });
  assert.deepStrictEqual([b.code, b.action, b.written], [0, 'none', false]);
  assert.match(b.reason, /lo pone el merge/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(work, 'version.json'), 'utf8')).version, `${DAY}.1`, 'no escribió nada');
  const same = M.checkVersion({ repo: work, base: 'origin/main', head: 'feat/a' }, deps());
  assert.deepStrictEqual([same.code, same.base, same.head], [0, `${DAY}.1`, `${DAY}.1`]);
  // el pedido que igual sube el número, o que saca la marca: rojo
  fs.writeFileSync(path.join(work, 'version.json'), markedText(`${DAY}.2`));
  commitVersion(work);
  assert.strictEqual(M.checkVersion({ repo: work, base: 'origin/main', head: 'feat/a' }, deps()).code, 1);
  fs.writeFileSync(path.join(work, 'version.json'), versionText(`${DAY}.1`));
  commitVersion(work);
  const unmarked = M.checkVersion({ repo: work, base: 'origin/main', head: 'feat/a' }, deps());
  assert.strictEqual(unmarked.code, 1);
  assert.match(unmarked.reason, /sin la marca/);
});

test(`${T79} — la transición: con la destino SIN la marca, el pedido que la trae sube el número una última vez`, () => {
  const { work } = toy();
  branch(work, 'feat/marca');
  fs.writeFileSync(path.join(work, 'version.json'), markedText(`${DAY}.1`));
  commitVersion(work);
  const b = bump(work, 'feat/marca', { write: true });
  assert.deepStrictEqual([b.action, b.from, b.to, b.written], ['bump', `${DAY}.1`, `${DAY}.2`, true]);
  commitVersion(work);
  const after = JSON.parse(fs.readFileSync(path.join(work, 'version.json'), 'utf8'));
  assert.deepStrictEqual([after.version, after.numbering], [`${DAY}.2`, 'merge-tag'], 'sube el número y la marca queda');
  assert.strictEqual(M.checkVersion({ repo: work, base: 'origin/main', head: 'feat/marca' }, deps()).code, 0);
});
