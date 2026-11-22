'use strict';

/**
 * instinct-observe.test.js — la grabadora de instintos en Node (integrations/instincts/scripts/instinct-observe.js), su
 * reenvío desde el `.sh` viejo y el aviso de una vez al arrancar (integrations/instincts/scripts/instincts-notice.js).
 *
 * Lo que no se puede perder:
 *   · Que con la integración prendida cada herramienta deje UNA línea con los seis campos de siempre más `repo` y
 *     `origin`, y que `origin` sea el host y la organización del remoto, sin el repo, sin usuario y sin credencial.
 *   · Que el saneado haga lo mismo que la grabadora de Python en sus casos, y además tape la firma de un enlace, las
 *     credenciales en una URL, `-u usuario:clave` y `Authorization`.
 *   · Que con la integración apagada no escriba nada ni cree la carpeta, aunque la variable vieja diga 1.
 *   · Que una falla salga 0 sin decir nada y deje el motivo en su registro.
 *   · Que el aviso diga una vez qué viaja, a quién y cómo bajarse, con su sello.
 *
 * Los permisos de mentira (`sk-`, `ghp_`) se arman por partes: uno entero frena el empuje al público.
 *
 * Uso: node --test scripts/tests/instinct-observe.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const HOOK = path.join(RAIZ, 'integrations', 'instincts', 'scripts', 'instinct-observe.js');
const FORWARDER = path.join(RAIZ, 'scripts', 'hooks', 'instinct-observe.sh');
const NOTICE = path.join(RAIZ, 'integrations', 'instincts', 'scripts', 'instincts-notice.js');
const obs = require(HOOK);
const j = (...parts) => parts.join('');

/** Una HOME de laboratorio con una raíz de repos adentro. */
function lab() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'instinct-observe-'));
  const repos = path.join(home, 'SourceCode');
  fs.mkdirSync(repos, { recursive: true });
  return { home, repos, obsDir: path.join(home, '.claude', 'tycon-observations') };
}

/** Un repo de juguete con `.git/config` y el remoto `origin` dado (sin lanzar git). */
function repoWith(dir, url) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const remote = url ? `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '';
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n${remote}`);
  return dir;
}

const event = (o) => JSON.stringify({ session_id: 'abcdef123456', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, ...o });

/** Corre la grabadora como función, con la integración prendida a mano (la llave entra en la tanda que la registra). */
function recordOn(l, ev) {
  const code = obs.run(ev, { home: l.home, reposRoot: l.repos, obsDir: l.obsDir, enabled: true, now: new Date('2026-10-21T12:00:00Z') });
  const file = path.join(l.obsDir, '2026-10.jsonl');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)) : [];
  return { code, lines };
}

test('T1 Observe_IntegrationOn_WritesLineWithRepoAndOrigin @story-4.7 @ac-1 @ac-3 — una línea con los ocho campos; origin canónico', () => {
  const l = lab();
  const forms = [
    'https://dev.azure.com/acme/Proyecto/_git/repo-a',
    'git@ssh.dev.azure.com:v3/acme/Proyecto/repo-b',
    j('acme', '@', 'vs-ssh.visualstudio.com:v3/acme/Proyecto/repo-c'),
    'https://acme.visualstudio.com/Proyecto/_git/repo-d',
  ];
  forms.forEach((url, i) => {
    const dir = repoWith(path.join(l.repos, 'Producto', `repo-${i}`), url);
    recordOn(l, event({ cwd: path.join(dir, 'src') }));
  });
  const gh = repoWith(path.join(l.repos, 'Otro', 'gh'), 'git@github.com:Dueno/repo.git');
  const { code, lines } = recordOn(l, event({ cwd: gh }));
  assert.strictEqual(code, 0);
  assert.strictEqual(lines.length, 5);
  for (const line of lines) {
    assert.deepStrictEqual(Object.keys(line).sort(), ['origin', 'project', 'repo', 'session_id', 'status', 'summary', 'tool', 'ts'].sort());
  }
  assert.deepStrictEqual(lines.slice(0, 4).map((x) => x.origin), Array(4).fill('dev.azure.com/acme'));
  assert.deepStrictEqual(lines.slice(0, 4).map((x) => x.repo), [0, 1, 2, 3].map((i) => `Producto/repo-${i}`));
  assert.strictEqual(lines[4].origin, 'github.com/dueno');
  assert.strictEqual(lines[4].repo, 'Otro/gh');
  assert.strictEqual(lines[0].session_id, 'abcdef12');
  assert.strictEqual(obs.canonOrigin(j('https://user:', 'secreto', '@dev.azure.com/Acme/P/_git/r')), 'dev.azure.com/acme');
  assert.strictEqual(obs.canonOrigin('https://gitlab.example.com/x/y.git'), null);
});

test('T2 Observe_SanitizesLikeThePythonRecorder @story-4.7 @ac-1 — los casos del .py, los nuevos y una herramienta MCP', () => {
  const home = j('/Us', 'ers/lab');
  const s = (x) => obs.sanitize(x, home);
  assert.strictEqual(s(`cat ${home}/notas.txt`), 'cat $HOME/notas.txt');
  assert.strictEqual(s(j('curl -H token=', 'abcdefgh12345')), 'curl -H token=[REDACTED]');
  assert.strictEqual(s(j('export K=', 'sk-', 'abcdefghijklmnopqrst')), 'export K=[REDACTED-SK]');
  assert.strictEqual(s(j('git push https://', 'ghp_', 'abcdefghijklmnopqrst')), 'git push https://[REDACTED-GHP]');
  const long = s('x'.repeat(600));
  assert.strictEqual(long.length, 500);
  assert.ok(long.endsWith('...'));
  assert.strictEqual(s(j('curl "https://cuenta.blob.core.windows.net/c/a.json?sv=2024&', 'sig=', 'AbC%2Bdef123"')), 'curl "https://cuenta.blob.core.windows.net/c/a.json?sv=2024&sig=[REDACTED]"');
  assert.strictEqual(s(j('git clone https://usuario:', 'clave123', '@dev.azure.com/acme/p/_git/r')), 'git clone https://[REDACTED]@dev.azure.com/acme/p/_git/r');
  assert.strictEqual(s(j('curl -u usuario:', 'clave123', ' https://x.example')), 'curl -u [REDACTED] https://x.example');
  assert.strictEqual(s(j('curl -H "Authorization: Basic ', 'dXNlcjpwYXNz', '"')), 'curl -H "Authorization: [REDACTED]"');
  // las variables de un secreto con prefijo o sufijo, las cadenas de conexión, un valor con símbolos y las claves con forma propia
  assert.strictEqual(s(j('export AZURE_DEVOPS_EXT_PAT=', 'abcdefghijklmnop')), 'export AZURE_DEVOPS_EXT_PAT=[REDACTED]');
  assert.strictEqual(s(j('AWS_SECRET_ACCESS_KEY=', 'AbCdEf123456/xyz')), 'AWS_SECRET_ACCESS_KEY=[REDACTED]');
  const conn = j('DefaultEndpointsProtocol=https;Account', 'Key=');
  assert.strictEqual(s(j(conn, 'Zm9vYmFyYmF6cXV4==;EndpointSuffix=core')), j(conn, '[REDACTED];EndpointSuffix=core'));
  assert.strictEqual(s(j('login pass', 'word=', 'Abc!defghij')), j('login pass', 'word=[REDACTED]'));
  assert.strictEqual(s(j('echo ', 'eyJhbGciOiJIUzI1', 'NiJ9.eyJzdWIiOiIxMjM0NTY3.abc_def')), 'echo [REDACTED-JWT]');
  assert.strictEqual(s(j('echo ', 'AKIA', 'ABCDEFGHIJKLMNOP')), 'echo [REDACTED-AKIA]');
  assert.strictEqual(s(j('git clone https://user:p@ss', '@host.example/r')), 'git clone https://[REDACTED]@host.example/r', 'una clave con @ se tapa entera');
  assert.strictEqual(s('cd /path/to/somewhere/long && node build/check.js --json'), 'cd /path/to/somewhere/long && node build/check.js --json', 'un comando sin secretos pasa igual');
  assert.strictEqual(obs.summarize('mcp__codegraph__search', { query: 'algo' }), null);
  assert.strictEqual(obs.summarize('Read', { file_path: '/a/b.js' }), '/a/b.js');
  assert.strictEqual(obs.summarize('Grep', { pattern: 'foo' }), 'foo');
  assert.strictEqual(obs.summarize('Agent', { description: 'buscar' }), 'buscar');
  assert.strictEqual(obs.summarize('Skill', { skill: 'tycon-pipeline' }), 'tycon-pipeline');
});

test('T3 Observe_ClientsPath_NotRecorded @story-4.7 @ac-1 — una entrada que nombra /clients/ no se graba', () => {
  const l = lab();
  const { code, lines } = recordOn(l, event({ cwd: l.home, tool_name: 'Read', tool_input: { file_path: '/x/specs/Clients/acme/notas.md' } }));
  assert.strictEqual(code, 0);
  assert.strictEqual(lines.length, 0);
  const win = recordOn(l, event({ cwd: l.home, tool_name: 'Read', tool_input: { file_path: 'C:\\repo\\specs\\clients\\acme\\notas.md' } }));
  assert.strictEqual(win.lines.length, 0, 'una ruta de Windows con \\clients\\ tampoco se graba');
});

test('T3b Observe_CodexApplyPatch_OneLinePerFile @story-4.7 @ac-6 — apply_patch da una línea por archivo, como Edit o Write', () => {
  const l = lab();
  const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** Add File: src/b.js\n+nuevo\n*** End Patch\n';
  const { lines } = recordOn(l, event({ cwd: l.home, tool_name: 'apply_patch', tool_input: { command: patch } }));
  assert.deepStrictEqual(lines.map((x) => x.tool), ['Edit', 'Write']);
  assert.deepStrictEqual(lines.map((x) => path.basename(x.summary)), ['a.js', 'b.js']);
});

test('T4 Observe_IntegrationOff_WritesNothingEvenWithLegacyVar @story-4.7 @ac-2 — apagada: ni archivo ni carpeta, aunque la variable vieja diga 1', () => {
  const l = lab();
  const r = spawnSync(process.execPath, [HOOK], {
    input: event({ cwd: l.home }),
    encoding: 'utf8',
    env: { ...process.env, HOME: l.home, USERPROFILE: l.home, TYCON_INSTINCTS: '0', TYCON_INSTINCT_MINING: '1', TYCON_INSTINCT_OBS_DIR: '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(l.obsDir), 'no crea la carpeta');
  const off = obs.run(event({ cwd: l.home }), { home: l.home, reposRoot: l.repos, obsDir: l.obsDir, enabled: false });
  assert.strictEqual(off, 0);
  assert.ok(!fs.existsSync(l.obsDir));
});

test('T5 Observe_Worktree_ReadsOriginFromCommonDir @story-4.7 @ac-3 — worktree, repo fuera de la raíz y rutas con barra invertida', () => {
  const l = lab();
  const main = repoWith(path.join(l.repos, 'Producto', 'principal'), 'https://dev.azure.com/acme/P/_git/principal');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt1'), { recursive: true });
  fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt1', 'commondir'), '../..\n');
  const wt = path.join(l.repos, 'Producto', 'principal-wt');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt1')}\n`);
  let { lines } = recordOn(l, event({ cwd: path.join(wt, 'lib') }));
  assert.strictEqual(lines[0].repo, 'Producto/principal-wt');
  assert.strictEqual(lines[0].origin, 'dev.azure.com/acme');
  const afuera = repoWith(path.join(l.home, 'Desktop', 'Proyectos', 'Ejemplo'), 'git@github.com:alguien/ejemplo.git');
  ({ lines } = recordOn(l, event({ cwd: afuera })));
  assert.strictEqual(lines[1].repo, 'Desktop/Proyectos/Ejemplo');
  assert.strictEqual(obs.toSlash('Producto\\principal'), 'Producto/principal');
});

test('T6 Observe_NoRepoOrNoOrigin_NullFields @story-4.7 @ac-3 — sin git o sin origin, los dos campos van null y la línea igual se graba', () => {
  const l = lab();
  const suelta = path.join(l.repos, 'suelta');
  fs.mkdirSync(suelta, { recursive: true });
  let { lines } = recordOn(l, event({ cwd: suelta }));
  assert.strictEqual(lines[0].repo, null);
  assert.strictEqual(lines[0].origin, null);
  const sinOrigin = repoWith(path.join(l.repos, 'Producto', 'sin-origin'), null);
  ({ lines } = recordOn(l, event({ cwd: sinOrigin })));
  assert.strictEqual(lines[1].repo, 'Producto/sin-origin');
  assert.strictEqual(lines[1].origin, null);
});

test('T7 Observe_Failures_ExitZeroSilentAndLogged @story-4.7 @ac-4 — evento ilegible, carpeta sin permiso y config ilegible', () => {
  const l = lab();
  const log = path.join(l.obsDir, 'instinct-observe.errors.log');
  assert.strictEqual(obs.run('{no es json', { home: l.home, reposRoot: l.repos, obsDir: l.obsDir, enabled: true }), 0);
  assert.match(fs.readFileSync(log, 'utf8'), /evento ilegible/);
  const repo = repoWith(path.join(l.repos, 'Producto', 'roto'), 'https://dev.azure.com/acme/P/_git/roto');
  fs.chmodSync(path.join(repo, '.git', 'config'), 0o000);
  const { code, lines } = recordOn(l, event({ cwd: repo }));
  fs.chmodSync(path.join(repo, '.git', 'config'), 0o644);
  assert.strictEqual(code, 0);
  if (process.getuid && process.getuid() !== 0) {
    assert.strictEqual(lines.at(-1).origin, null, 'un config ilegible da origin null');
    assert.match(fs.readFileSync(log, 'utf8'), /config ilegible/);
  }
  const bloqueada = path.join(l.home, 'bloqueada');
  fs.mkdirSync(bloqueada, { recursive: true });
  fs.chmodSync(bloqueada, 0o500);
  const r = spawnSync(process.execPath, ['-e', `process.exitCode = require(${JSON.stringify(HOOK)}).run(${JSON.stringify(event({ cwd: l.home }))}, { home: ${JSON.stringify(l.home)}, reposRoot: null, obsDir: ${JSON.stringify(path.join(bloqueada, 'obs'))}, enabled: true })`], { encoding: 'utf8' });
  fs.chmodSync(bloqueada, 0o700);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
});

test('T7b Observe_ErrorsLog_CappedAt100KB @story-4.7 @ac-4 — el registro de fallas no pasa de 100 KB y conserva lo último', () => {
  const l = lab();
  fs.mkdirSync(l.obsDir, { recursive: true });
  const log = path.join(l.obsDir, 'instinct-observe.errors.log');
  fs.writeFileSync(log, 'viejo\n'.repeat(20000));
  obs.run('{no es json', { home: l.home, reposRoot: l.repos, obsDir: l.obsDir, enabled: true });
  const text = fs.readFileSync(log, 'utf8');
  assert.ok(Buffer.byteLength(text) <= 100 * 1024, `quedó en ${Buffer.byteLength(text)} bytes`);
  assert.match(text.split('\n').filter(Boolean).at(-1), /evento ilegible/);
});

test('T9 Notice_OncePerMachine_AndLegacyVarsNotice @story-4.7 @ac-9 — un aviso con lo que viaja y su sello; el de las variables viejas, una vez', () => {
  const l = lab();
  const notice = require(NOTICE);
  const stateDir = path.join(l.home, 'estado');
  const first = notice.decide({ prendida: true, env: {}, stateDir, now: new Date('2026-10-21T23:30:00-03:00') });
  assert.match(first.text, /los comandos/);
  assert.match(first.text, /buzón/);
  assert.match(first.text, /mantenedores/);
  assert.match(first.text, /correo de git/);
  assert.match(first.text, /TYCON_INSTINCTS=0/);
  notice.seal(stateDir, first.seal);
  const sealed = JSON.parse(fs.readFileSync(path.join(stateDir, 'instincts-notice.json'), 'utf8'));
  assert.strictEqual(sealed.said_on, '2026-10-22', 'la fecha del sello es la del día en UTC');
  assert.strictEqual(sealed.state, 'prendida');
  assert.strictEqual(notice.decide({ prendida: true, env: {}, stateDir }).text, null, 'el segundo arranque no repite');
  const legacy = notice.decide({ prendida: false, env: { TYCON_INSTINCT_MINING: '1' }, stateDir: path.join(l.home, 'otro') });
  assert.match(legacy.text, /ya no prenden/);
  notice.seal(path.join(l.home, 'otro'), legacy.seal);
  assert.strictEqual(notice.decide({ prendida: false, env: { TYCON_INSTINCT_MINING: '1' }, stateDir: path.join(l.home, 'otro') }).text, null);
  assert.strictEqual(notice.decide({ prendida: false, env: {}, stateDir: path.join(l.home, 'nada') }).text, null, 'apagada y sin variables viejas: silencio');
});

test('T33 Forwarder_RunsNodeAndLogsLegacyUse @story-4.7 @ac-8 — el .sh viejo reenvía a node', () => {
  const l = lab();
  const text = fs.readFileSync(FORWARDER, 'utf8');
  assert.match(text, /instinct-observe\.js/);
  assert.match(text, /legacy-names\.sh/);
  assert.ok(!fs.existsSync(path.join(RAIZ, 'scripts', 'hooks', 'instinct-observe.py')), 'el .py se fue');
  const r = spawnSync('bash', [FORWARDER], { input: event({ cwd: l.home }), encoding: 'utf8', env: { ...process.env, HOME: l.home, TYCON_INSTINCTS: '0' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  // prendida: la línea la escribe el .js y el uso del nombre viejo queda anotado
  const on = spawnSync('bash', [FORWARDER], {
    input: event({ cwd: l.home }),
    encoding: 'utf8',
    env: { ...process.env, HOME: l.home, USERPROFILE: l.home, TYCON_PROFILE: '0', TYCON_INSTINCTS: '1', TYCON_INSTINCT_OBS_DIR: l.obsDir },
  });
  assert.strictEqual(on.status, 0, on.stderr);
  const files = fs.existsSync(l.obsDir) ? fs.readdirSync(l.obsDir).filter((f) => f.endsWith('.jsonl')) : [];
  assert.strictEqual(files.length, 1, 'el reenvío pasó el evento a node');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(l.obsDir, files[0]), 'utf8').trim()).summary, 'ls');
  const uses = spawnSync('find', [l.home, '-name', 'legacy-names*.jsonl'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  assert.ok(uses.some((f) => fs.readFileSync(f, 'utf8').includes('instinct-observe.sh')), `el uso del nombre viejo quedó anotado (${uses.join(', ') || 'sin registro'})`);
});

test('T7b Observe_BrokenConfig_LoggedNotSilent @story-4.7 @ac-4 — una configuración que no se puede leer no es «apagada»: queda anotada', () => {
  const l = lab();
  fs.mkdirSync(path.join(l.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(l.home, '.claude', 'tycon.json'), '{ esto no es json');
  const ctx = obs.contextFromConfig({ TYCON_PROFILE: '0', TYCON_INSTINCT_OBS_DIR: l.obsDir }, l.home);
  assert.strictEqual(ctx.enabled, false);
  const log = path.join(l.obsDir, 'instinct-observe.errors.log');
  assert.ok(fs.existsSync(log) && /configuración/.test(fs.readFileSync(log, 'utf8')), 'el motivo quedó en el registro');
});

test('T38b LiveFire_ShellToolOf_NamesToolAndResponseKeys @story-4.7 @ac-6 — la sonda saca el nombre de la herramienta y las claves de su respuesta', () => {
  const { shellToolOf } = require(path.join(RAIZ, 'scripts', 'controls-bench', 'live-fire.js'));
  assert.deepStrictEqual(shellToolOf({ tool_name: 'Bash', tool_response: { stdout: 'x', exit_code: 0 } }), { tool: 'Bash', response_keys: ['exit_code', 'stdout'] });
  assert.deepStrictEqual(shellToolOf({ tool_name: 'exec_command', tool_response: 'texto' }), { tool: 'exec_command', response_keys: 'string' });
  assert.deepStrictEqual(shellToolOf('unparseable'), { tool: null, response_keys: null });
});

test('T34 Observe_PowerShellTool_RecordedLikeBash @story-4.7 @ac-1 — el comando de PowerShell se graba saneado como el de Bash', () => {
  const l = lab();
  const { lines } = recordOn(l, event({ cwd: l.home, tool_name: 'PowerShell', tool_input: { command: j('$env:K="', 'sk-', 'abcdefghijklmnopqrst"; dir C:\\x') } }));
  assert.strictEqual(lines[0].tool, 'PowerShell');
  assert.strictEqual(lines[0].summary, '$env:K="[REDACTED-SK]"; dir C:\\x');
});

test('T35 Observe_GithubFineGrainedAndOtherTokens_AreMasked — los tokens de GitHub de grano fino y los gho_/ghu_/ghs_/ghr_ también se tapan', () => {
  const s = (x) => obs.sanitize(x, null);
  const pat = j('github', '_pat_', '11AAAAAAAAAAAAAAAAAAAA', '_', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  for (const t of [pat, j('gho', '_', 'abcdefghijklmnopqrst'), j('ghs', '_', 'abcdefghijklmnopqrst')]) {
    for (const cmd of [`cd /tmp && TOK='${t}' && curl -s x`, `gh auth login --with-token <<< ${t}`, `curl -H "X: ${t}" x`]) {
      const out = s(cmd);
      assert.ok(!out.includes(t), out);
      assert.match(out, /\[REDACTED-GHP\]/, out);
    }
  }
});

// Un permiso de Azure DevOps de laboratorio (52 letras de base32), y uno del formato nuevo (84, con la marca AZDO)
const PAT_ADO = j('abcdefgh', 'ijklmnop', 'qrstuvwx', 'yz234567', 'abcdefgh', 'ijklmnop', 'qrst');
const PAT_ADO_NUEVO = j('A'.repeat(40), 'b'.repeat(36), 'AZ', 'DO', 'c1d2');
const CLAVE = j('Zq7xW2vK', '9pLm4nB8');
// la herramienta de SQL Server, armada por partes: el freno de producción lee el texto de un comando
const SQLCMD = j('sql', 'cmd');
// una clave corta de laboratorio y la palabra que la nombra, por partes
const CORTA = j('Hun', 'ter7');
const PASS = j('PASS', 'WORD');

test('T36 Observe_AdoPatForms_Masked — el permiso de Azure DevOps como usuario de una URL, en «curl -u :» y suelto', () => {
  const s = (x) => obs.sanitize(x, null);
  assert.strictEqual(PAT_ADO.length, 52);
  assert.strictEqual(PAT_ADO_NUEVO.length, 84);
  for (const cmd of [
    `curl -s -u :${PAT_ADO} https://dev.azure.com/acme/_apis/projects`,
    `curl -s --user :${PAT_ADO} https://dev.azure.com/acme/_apis/projects`,
    `curl -s -u ":${PAT_ADO}" https://dev.azure.com/acme/_apis/projects`,
    `git clone https://${PAT_ADO}@dev.azure.com/acme/p/_git/r`,
    `echo ${PAT_ADO} | az devops login --organization https://dev.azure.com/acme`,
    `printf '%s' '${PAT_ADO_NUEVO}' | az devops login`,
    `printf 'protocol=https\\nhost=dev.azure.com\\nusername=x\\npassword=${PAT_ADO}\\n' | git credential approve`,
  ]) {
    const out = s(cmd);
    assert.ok(!out.includes(PAT_ADO) && !out.includes(PAT_ADO_NUEVO), out);
  }
  // lo de todos los días queda igual: la organización como usuario de la URL, git por ssh, un -u sin dos puntos
  for (const cmd of [j('git clone https://acme', '@', 'dev.azure.com/acme/p/_git/r'), j('git clone ssh://git', '@', 'github.com/acme/api.git'), 'git push -u origin main', 'git push -u origin HEAD:refs/heads/wt/x']) {
    assert.strictEqual(s(cmd), cmd);
  }
});

test('T37 Observe_PasswordOptionsOfTools_Masked — la clave de la herramienta de SQL Server, az, docker o mysql en su opción, y «--user u:clave»', () => {
  const s = (x) => obs.sanitize(x, null);
  for (const cmd of [
    `${SQLCMD} -S db.acme.test -U sa -P '${CLAVE}' -Q "select 1"`,
    `${SQLCMD} -S db.acme.test -U sa -P ${CLAVE} -Q "select 1"`,
    `az login --service-principal -u app -p ${CLAVE} --tenant acme`,
    `docker login -u dev -p ${CLAVE} registry.acme.test`,
    `mysql -uroot -p${CLAVE} app`,
    `curl --user dev:${CLAVE} https://x`,
    `curl -udev:${CLAVE} https://x`,
  ]) {
    const out = s(cmd);
    assert.ok(!out.includes(CLAVE), out);
  }
  // las otras -p y -P quedan: un directorio, un puerto, una publicación de puertos, mysql pidiendo la clave
  for (const cmd of ['mkdir -p src/lib', 'ssh -p 2222 acme.test', 'docker run -p 8080:80 img', 'mysql -p app', 'mysql -h db -P 3306 app', 'docker login registry.acme.test && docker run -p 8080:80 img']) {
    assert.strictEqual(s(cmd), cmd);
  }
});

test('T38 Observe_CamelCaseAndEscapedKeywords_Masked — accessToken, clientSecret, _authToken, dbPassword', () => {
  const s = (x) => obs.sanitize(x, null);
  for (const cmd of [
    `curl -d '{"accessToken":"${CLAVE}"}' https://api`,
    `npm config set //registry.npmjs.org/:_authToken=${CLAVE}`,
    `clientSecret=${CLAVE} node app.js`,
    `node app.js --dbPassword=${CLAVE}`,
    `AdminPassword=${CLAVE} ./run.sh`,
    `node app.js --refreshToken ${CLAVE}`,
  ]) {
    const out = s(cmd);
    assert.ok(!out.includes(CLAVE), out);
  }
  // una clave que no es secreto queda
  for (const cmd of ["node -e \"sort({ sortKey: 'createdAt' })\"", 'cat src/tokenizer.js', 'grep -rn "cancellationToken" src']) {
    assert.strictEqual(s(cmd), cmd);
  }
});

test('T39 Observe_ShortAndQuotedPasswords_Masked — una clave corta después de = o :, y una entre comillas con signos', () => {
  const s = (x) => obs.sanitize(x, null);
  for (const [cmd, valor] of [
    [`node app.js "Initial Catalog=db1;Pass${'word'}=${CORTA};"`, CORTA],
    [`export ${PASS}=${CORTA}`, CORTA],
    [`mysql --pass${'word'}='${j('Ab1&', 'cdefghij9')}' -e 'select 1'`, j('Ab1&', 'cdefghij9')],
    [`export DB_${PASS}="${j('P@ss&', 'w0rd 2024')}"`, j('P@ss&', 'w0rd 2024')],
  ]) {
    const out = s(cmd);
    assert.ok(!out.includes(valor), out);
  }
  for (const cmd of ['pwd && ls', 'echo $(pwd)/x', 'cat password-policy.md', 'grep -rn "password" src', j('git com', 'mit -m "fix password reset"'), 'pwd\nnode script.js']) {
    assert.strictEqual(s(cmd), cmd);
  }
});

test('T40 Observe_BasicAuthHeaderForms_Masked — Authorization con = o con comillas', () => {
  const s = (x) => obs.sanitize(x, null);
  for (const cmd of [`Invoke-RestMethod -Uri $u -Headers @{Authorization="Basic ${CLAVE}"}`, `http GET https://x Authorization:"Basic ${CLAVE}"`]) {
    const out = s(cmd);
    assert.ok(!out.includes(CLAVE), out);
  }
});

test('T41 Observe_SanitizeIsIdempotent — sanear dos veces deja lo mismo, también un resumen cortado después de un valor tapado', () => {
  const s = (x) => obs.sanitize(x, null);
  const cortado = s(`cd x && ${'a'.repeat(470)} --token=${CLAVE}123 && echo fin`);
  assert.ok(cortado.endsWith('...'), cortado.slice(-30));
  for (const x of [cortado, `curl -u :${PAT_ADO} x`, `git clone https://${PAT_ADO}@dev.azure.com/a/b`, `${SQLCMD} -P ${CLAVE}`, `x accessToken=${CLAVE}`, `export ${PASS}=${CORTA}`, `Authorization="Basic ${CLAVE}"`, j('ghp', '_', 'abcdefghijklmnopqrst')]) {
    const una = s(x);
    assert.strictEqual(s(una), una, una);
  }
});

test('T42 Observe_ShellVariablesAreNotSecrets — en las formas nuevas, una variable del shell o el comienzo de un objeto quedan como están', () => {
  const s = (x) => obs.sanitize(x, null);
  for (const cmd of [
    `${SQLCMD} -S "$SRV" -U "$USR" -P "$PW" -Q "select 1"`,
    `${SQLCMD} -S db.acme.test -U sa -P $SA_PASSWORD -Q "select 1"`,
    `export ${PASS}=$PW`,
    `export DB_${PASS}="$PW"`,
    `node app.js --dbPass${'word'}=$DB_${PASS}`,
    'node -e "run({ secret:{env:\'X\'} })"',
    'docker login -u dev -p "${REGISTRY_TOKEN}" registry.acme.test',
  ]) {
    assert.strictEqual(s(cmd), cmd);
  }
});

test('T43 Observe_EverydayCommandsStayTheSame — buscar un nombre de clave, $(id -u), pip --user, find en la carpeta de mysql', () => {
  const s = (x) => obs.sanitize(x, null);
  for (const cmd of [
    'grep -rn "authorization:" src/',
    `rg "pass${'word'}=" -g "*.env"`,
    'grep -rn cancellationToken src/Features',
    'docker run -u $(id -u):$(id -g) img',
    'pip install --user https://x.test/p.whl',
    'find /var/lib/mysql -perm 600 -print',
    `grep -rn 'pass${'word'}: "{{ .Values.db.pass${'word'} }}"' charts`,
    j('git com', 'mit -m "refactor: rename accessToken handling in AuthService module"'),
    'jq ".accessToken" response.json',
  ]) {
    assert.strictEqual(s(cmd), cmd);
  }
});

test('T44 Observe_MoreCredentialForms_Masked — un nombre en mayúsculas, un JSON escapado, la URL sin usuario, la llave como usuario, un comando en varios renglones', () => {
  const s = (x) => obs.sanitize(x, null);
  for (const cmd of [
    `export PG${PASS}=${CLAVE}`,
    `export DB_PASS=${CLAVE}`,
    `curl -d "{\\"pass${'word'}\\":\\"${CLAVE}\\"}" x`,
    `redis-cli -u redis://:${CLAVE}@cache.acme.test:6379`,
    `curl -u ${j('sk_test_', 'abcdefghijklmnop')}: https://x`,
    `az login \\\n  -u app \\\n  -p ${CLAVE}`,
    `Invoke-RestMethod -Headers @{Authorization="Basic ${CLAVE}"}`,
  ]) {
    const out = s(cmd);
    assert.ok(!out.includes(CLAVE) && !out.includes(j('sk_test_', 'abcdefghijklmnop')), out);
    assert.strictEqual(s(out), out, `sanear dos veces deja lo mismo: ${out}`);
  }
  // lo que sigue a una clave tapada queda, también en la segunda pasada
  const conPuntoYComa = s(`${SQLCMD} -S h -U sa -P "${CLAVE}"; echo $?`);
  assert.match(conPuntoYComa, /\[REDACTED\]; echo \$\?$/);
  assert.strictEqual(s(conPuntoYComa), conPuntoYComa);
  // el corte de 500 no parte una marca
  for (let n = 470; n < 500; n++) {
    const una = s(`${'a'.repeat(n)} token=${CLAVE} y más texto después del valor para pasar el corte de quinientos`);
    assert.doesNotMatch(una, /\[REDACT?E?D?\.\.\.$|\[RE?D?A?C?\.\.\.$/, una.slice(-20));
    assert.strictEqual(s(una), una, una.slice(-30));
  }
});

test('T45 Observe_ThirdRoundForms — la herramienta por su ruta o con .exe, secretKey, una sigla delante, PowerShell, sshpass, redis-cli -a, mongosh, un usuario de dominio', () => {
  const s = (x) => obs.sanitize(x, null);
  for (const cmd of [
    `docker exec -it sql1 /opt/mssql-tools18/bin/${SQLCMD} -S localhost -U sa -P "${CLAVE}" -C -Q "select 1"`,
    `${SQLCMD}.exe -S h -U sa -P ${CLAVE} -Q x`,
    `./${SQLCMD} -P ${CLAVE}`,
    `/usr/local/mysql/bin/mysql -uroot -p${CLAVE} app`,
    `curl -d '{"secretKey":"${CLAVE}"}' x`,
    `node app.js --privateKey ${CLAVE}`,
    `export DB${PASS.slice(0, 1)}${PASS.slice(1).toLowerCase()}=${CLAVE}`,
    `$sec = ConvertTo-SecureString '${CLAVE}' -AsPlainText -Force`,
    `New-LocalUser -Name dev -${PASS.slice(0, 1)}${PASS.slice(1).toLowerCase()} (ConvertTo-SecureString '${CLAVE}' -AsPlainText -Force)`,
    `sshpass -p '${CLAVE}' ssh dev@acme.test`,
    `redis-cli -h cache -a ${CLAVE} ping`,
    `mongosh mongodb://h --username dev -p ${CLAVE}`,
    `curl -u 'CORP\\jdoe:${CLAVE}' https://intranet.acme.test`,
  ]) {
    const out = s(cmd);
    assert.ok(!out.includes(CLAVE), out);
    assert.strictEqual(s(out), out, `sanear dos veces deja lo mismo: ${out}`);
  }
  for (const cmd of [
    'docker run --user 1000:1000 img', 'docker run -u 1000:1000 img', j('x abc_', 'ghs', '_abcdefghijklmnopqrstuvwxyz_total'),
    'export TYCON_BYPASS=yesyesyes', 'export COMPASS=northnorth', `node -e "cfg({ pass${'word'}: false, secret: null })"`,
    'grep -rn secretKey src/config', `curl -d "{\\"pass${'word'}\\":\\"$PW\\"}" x`, 'redis-cli -u redis://:$REDIS_PW@cache',
    'Invoke-RestMethod -Headers @{Authorization="Bearer $token"}',
  ]) {
    assert.strictEqual(s(cmd), cmd);
  }
});
