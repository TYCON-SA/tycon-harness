'use strict';
// extension-notices.test.js — los avisos que trae una extensión (un paquete o una integración) en su `notices.json`, y
// el gancho de arranque que los dice cuando aplican.
//
// Lo que no se puede perder:
//   · una extensión sin `notices.json` no tiene avisos y no es un error;
//   · el texto vive DENTRO de la carpeta de la extensión: una ruta que sale de ahí se rechaza;
//   · `when` es `session-start` o `before-command`; `commands` va sólo con `before-command`, y ahí es obligatorio;
//   · `repo_files` es una expresión regular sobre las rutas que git sigue en el repo;
//   · el gancho dice un aviso de paquete sólo si el paquete está activo para el repo y el repo cumple `repo_files`;
//   · cada aviso sale una vez por sesión; un manifiesto roto se dice en una línea; el gancho sale 0 siempre.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'extension-notices.js');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'extension-notices.js');
const N = () => require(LIB);

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function extension(dir, notices, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (notices !== undefined) fs.writeFileSync(path.join(dir, 'notices.json'), typeof notices === 'string' ? notices : JSON.stringify(notices));
  for (const [rel, txt] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
  return dir;
}
const aviso = (extra = {}) => Object.assign({ id: 'url-del-producto', text: 'notices/url.md', when: 'session-start' }, extra);

test('Lector_SinNoticesJson_NadaYSinError', () => {
  const r = N().readNotices(extension(tmp('ext-'), undefined));
  assert.deepStrictEqual(r, { notices: [], errors: [] });
});

test('Lector_AvisoValido_DevuelveTextoYCondicion', () => {
  const dir = extension(tmp('ext-'), { notices: [aviso({ repo_files: '(^|/)plugin\\.json$' })] }, { 'notices/url.md': 'regla de la URL\n' });
  const r = N().readNotices(dir);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.notices.length, 1);
  assert.strictEqual(r.notices[0].id, 'url-del-producto');
  assert.strictEqual(r.notices[0].when, 'session-start');
  assert.strictEqual(r.notices[0].file, fs.realpathSync(path.join(dir, 'notices', 'url.md')), 'la ruta real, la que se lee');
  assert.ok(r.notices[0].repoFiles.test('src/plugin.json'));
});

test('Lector_RutaFueraDeLaCarpeta_Rechaza', () => {
  for (const text of ['../afuera.md', '/etc/passwd', 'notices/../../afuera.md']) {
    const dir = extension(tmp('ext-'), { notices: [aviso({ text })] });
    const r = N().readNotices(dir);
    assert.strictEqual(r.notices.length, 0, `${text}: no se acepta`);
    assert.ok(r.errors.some((e) => /fuera de la carpeta/.test(e)), `${text}: lo dice`);
  }
});

test('Lector_EnlaceSimbolico_Rechaza', () => {
  // el gancho imprime el texto en la sesión: un enlace que apunta afuera del paquete (una llave, un .env) no puede pasar
  const afuera = path.join(tmp('afuera-'), 'secreto.txt');
  fs.writeFileSync(afuera, 'SECRETO\n');
  const conArchivo = extension(tmp('ext-'), { notices: [aviso()] });
  fs.mkdirSync(path.join(conArchivo, 'notices'));
  fs.symlinkSync(afuera, path.join(conArchivo, 'notices', 'url.md'));
  const r1 = N().readNotices(conArchivo);
  assert.strictEqual(r1.notices.length, 0, 'el archivo enlazado no se acepta');
  assert.ok(r1.errors.some((e) => /enlace/.test(e)), r1.errors.join(' | '));
  const conCarpeta = extension(tmp('ext-'), { notices: [aviso({ text: 'notices/secreto.txt' })] });
  fs.symlinkSync(path.dirname(afuera), path.join(conCarpeta, 'notices'));
  const r2 = N().readNotices(conCarpeta);
  assert.strictEqual(r2.notices.length, 0, 'una carpeta enlazada que sale del paquete no se acepta');
  assert.ok(r2.errors.some((e) => /fuera de la carpeta/.test(e)), r2.errors.join(' | '));
});

test('Lector_TextoQueNoExiste_Rechaza', () => {
  const r = N().readNotices(extension(tmp('ext-'), { notices: [aviso()] }));
  assert.strictEqual(r.notices.length, 0);
  assert.ok(r.errors.some((e) => /no existe/.test(e)));
});

test('Lector_WhenYCommands_MalFormados_Rechaza', () => {
  const files = { 'notices/url.md': 'x\n' };
  const casos = [
    [aviso({ when: 'siempre' }), /when/],
    [aviso({ commands: ['cli uno'] }), /commands.*before-command/],
    [aviso({ when: 'before-command' }), /commands/],
    [aviso({ when: 'before-command', commands: [] }), /commands/],
    [aviso({ when: 'before-command', commands: ['ok', ''] }), /commands/],
  ];
  for (const [a, re] of casos) {
    const r = N().readNotices(extension(tmp('ext-'), { notices: [a] }, files));
    assert.strictEqual(r.notices.length, 0, JSON.stringify(a));
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(a)} → ${r.errors.join(' | ')}`);
  }
  const ok = N().readNotices(extension(tmp('ext-'), { notices: [aviso({ when: 'before-command', commands: ['cli uno', 'cli dos'] })] }, files));
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.notices[0].commands, ['cli uno', 'cli dos']);
});

test('Lector_RepoFilesNoEsRegex_Rechaza', () => {
  const r = N().readNotices(extension(tmp('ext-'), { notices: [aviso({ repo_files: '([' })] }, { 'notices/url.md': 'x\n' }));
  assert.strictEqual(r.notices.length, 0);
  assert.ok(r.errors.some((e) => /repo_files/.test(e)));
});

test('Lector_ClaveDesconocidaIdRepetidoOJsonRoto_Rechaza', () => {
  const files = { 'notices/url.md': 'x\n' };
  const desconocida = N().readNotices(extension(tmp('ext-'), { notices: [aviso({ color: 'rojo' })] }, files));
  assert.ok(desconocida.errors.some((e) => /color/.test(e)));
  const repetido = N().readNotices(extension(tmp('ext-'), { notices: [aviso(), aviso()] }, files));
  assert.strictEqual(repetido.notices.length, 1, 'el primero queda');
  assert.ok(repetido.errors.some((e) => /repetido/.test(e)));
  const roto = N().readNotices(extension(tmp('ext-'), '{ esto no es json', files));
  assert.strictEqual(roto.notices.length, 0);
  assert.ok(roto.errors.some((e) => /notices\.json/.test(e)));
  const sinLista = N().readNotices(extension(tmp('ext-'), { otra: 1 }, files));
  assert.ok(sinLista.errors.some((e) => /notices/.test(e)));
});

test('CapaDelEquipo_AdmiteLosAvisosDeUnPaquete', () => {
  // sin esto, una máquina rechaza ENTERA la punta del perfil que trae los avisos de un paquete
  const TEAM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
  assert.equal(TEAM.layerPathProblem('packs/equipo-juguete/notices.json'), null, 'el notices.json del paquete entra');
  assert.equal(TEAM.layerPathProblem('packs/equipo-juguete/notices/url.md'), null, 'el texto de un aviso entra');
  for (const p of ['packs/equipo-juguete/notices/sub/x.md', 'packs/equipo-juguete/notices/x.sh', 'packs/equipo-juguete/notices/CLAUDE.md',
    'packs/equipo-juguete/notices/.x.md', 'packs/equipo-juguete/otro.json']) {
    assert.notEqual(TEAM.layerPathProblem(p), null, `${p} no entra`);
  }
});

// ── el gancho ─────────────────────────────────────────────────────────────────────────────────

function hookLab({ repoFiles = ['plugin.json'], packsYaml = null, notices, extraPacks = {} } = {}) {
  const base = tmp('ext-hook-');
  const packs = path.join(base, 'packs');
  extension(path.join(packs, 'producto'), notices === undefined
    ? { notices: [aviso({ repo_files: '(^|/)plugin\\.json$' })] } : notices,
  { 'pack.json': JSON.stringify({ name: 'producto', description: 'de prueba' }), 'notices/url.md': 'REGLA-DE-LA-URL: con el prefijo del plugin\n' });
  for (const [name, n] of Object.entries(extraPacks)) {
    extension(path.join(packs, name), n, { 'pack.json': JSON.stringify({ name, description: 'de prueba' }) });
  }
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  for (const f of repoFiles) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), '{}\n'); }
  if (packsYaml !== null) { fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true }); fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), packsYaml); }
  execFileSync('git', ['-C', repo, 'add', '-A']);
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { base, packs, repo, home };
}
function runHook(l, { session = 'sesion-1', env = {}, cwd = l.repo } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    env: Object.assign({ PATH: process.env.PATH, HOME: l.home, TYCON_HOME: path.join(l.home, '.tycon'), TYCON_PACKS_DIR: l.packs, TYCON_PACKS_DEFAULT: 'all', TYCON_INTEGRATIONS_DIR: path.join(l.base, 'sin-integraciones') }, env),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('Gancho_PaqueteActivoYRepoCoincide_DiceElAviso', () => {
  const l = hookLab();
  const r = runHook(l);
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.includes('REGLA-DE-LA-URL'), r.out + r.err);
});

test('Gancho_RepoNoCoincide_Calla', () => {
  const l = hookLab({ repoFiles: ['README.md'] });
  const r = runHook(l);
  assert.strictEqual(r.code, 0);
  assert.ok(!r.out.includes('REGLA-DE-LA-URL'));
});

test('Gancho_PaqueteNoActivoEnElRepo_Calla', () => {
  const l = hookLab({ packsYaml: 'packs: []\n' });
  const r = runHook(l);
  assert.strictEqual(r.code, 0);
  assert.ok(!r.out.includes('REGLA-DE-LA-URL'));
});

test('Gancho_SinRepoFiles_AplicaDondeElPaqueteEstaActivo', () => {
  const l = hookLab({ repoFiles: ['README.md'], notices: { notices: [aviso()] } });
  assert.ok(runHook(l).out.includes('REGLA-DE-LA-URL'));
});

test('Gancho_UnaVezPorSesion', () => {
  const l = hookLab();
  assert.ok(runHook(l, { session: 's-a' }).out.includes('REGLA-DE-LA-URL'), 'la primera vez, sí');
  assert.ok(!runHook(l, { session: 's-a' }).out.includes('REGLA-DE-LA-URL'), 'la segunda, en la misma sesión, no');
  assert.ok(runHook(l, { session: 's-b' }).out.includes('REGLA-DE-LA-URL'), 'en otra sesión, otra vez');
});

test('Gancho_ManifiestoRoto_UnaLineaYSale0', () => {
  const l = hookLab({ extraPacks: { roto: '{ no es json' } });
  const r = runHook(l);
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.includes('REGLA-DE-LA-URL'), 'el aviso bueno sale igual');
  const lineas = (r.out + r.err).split('\n').filter((x) => /roto/.test(x));
  assert.strictEqual(lineas.length, 1, 'el roto se dice en una línea');
});

test('Gancho_SoloAvisosDeArranque', () => {
  const l = hookLab({ notices: { notices: [aviso({ when: 'before-command', commands: ['cli x'] })] } });
  assert.ok(!runHook(l).out.includes('REGLA-DE-LA-URL'), 'uno de antes de un comando no sale al arrancar');
});

test('Gancho_TrasCompactarOLimpiar_LoVuelveADecir', () => {
  // compactar o limpiar deja la sesión con el mismo id y sin lo dicho antes: el CLAUDE.md se recargaba, el aviso también
  const l = hookLab();
  const corre = (source) => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: 's-c', cwd: l.repo, hook_event_name: 'SessionStart', source }), encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: l.home, TYCON_HOME: path.join(l.home, '.tycon'), TYCON_PACKS_DIR: l.packs, TYCON_PACKS_DEFAULT: 'all', TYCON_INTEGRATIONS_DIR: path.join(l.base, 'sin') },
    });
    return r.stdout.includes('REGLA-DE-LA-URL');
  };
  assert.ok(corre('startup'), 'al arrancar, sí');
  assert.ok(!corre('resume'), 'al retomar, la conversación ya lo trae: no');
  assert.ok(corre('compact'), 'después de compactar, otra vez');
  assert.ok(corre('clear'), 'después de limpiar, otra vez');
});

test('Lector_ArchivoQueEmpiezaConDosPuntos_Acepta', () => {
  const r = N().readNotices(extension(tmp('ext-'), { notices: [aviso({ text: 'notices/..notas.md' })] }, { 'notices/..notas.md': 'x\n' }));
  assert.deepStrictEqual(r.errors, [], 'un archivo `..notas.md` está adentro de la carpeta');
  assert.strictEqual(r.notices.length, 1);
});

test('Gancho_RepoQueGitNoAbre_LoDice', () => {
  // un worktree cuyo .git apunta a una carpeta que ya no está: git sale 128 como con «no es un repo», pero hay un .git
  const l = hookLab();
  const roto = path.join(l.base, 'worktree-roto');
  fs.mkdirSync(roto);
  fs.writeFileSync(path.join(roto, 'plugin.json'), '{}\n');
  fs.writeFileSync(path.join(roto, '.git'), `gitdir: ${path.join(l.base, 'no-esta', '.git', 'worktrees', 'x')}\n`);
  const r = runHook(l, { cwd: roto });
  assert.strictEqual(r.code, 0);
  assert.ok(/no se pudo saber si .* es un repo/.test(r.out), r.out);
});

test('Gancho_CarpetaDePaquetesQueNoExiste_LoDice', () => {
  const l = hookLab();
  const r = runHook(l, { env: { TYCON_PACKS_DIR: path.join(l.base, 'no-existe') } });
  assert.strictEqual(r.code, 0);
  assert.ok(/no se pudo saber qué paquetes están activos/.test(r.out), r.out);
});

test('Gancho_GitNoContesta_NoDiceNingunAviso', () => {
  // sin saber si es un repo no se sabe qué paquetes declara: tampoco se dicen los avisos sin `repo_files`
  const l = hookLab({ notices: { notices: [aviso()] }, packsYaml: 'packs: []\n' });
  const r = runHook(l, { env: { PATH: path.dirname(process.execPath) } });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.out.includes('REGLA-DE-LA-URL'), 'el repo apagó el paquete: aunque git no conteste, no se dice');
});

test('Gancho_CarpetaQueNoExisteOEventoIlegible_LoDice', () => {
  const l = hookLab();
  const noEsta = runHook(l, { cwd: path.join(l.base, 'no-existe') });
  assert.strictEqual(noEsta.code, 0);
  assert.ok(/la carpeta de la sesión .* no existe/.test(noEsta.out), noEsta.out);
  const r = spawnSync(process.execPath, [HOOK], { input: '{ roto', encoding: 'utf8', cwd: l.repo,
    env: { PATH: process.env.PATH, HOME: l.home, TYCON_HOME: path.join(l.home, '.tycon'), TYCON_PACKS_DIR: l.packs, TYCON_PACKS_DEFAULT: 'all', TYCON_INTEGRATIONS_DIR: path.join(l.base, 'sin') } });
  assert.strictEqual(r.status, 0);
  assert.ok(/el evento de arranque no se pudo leer/.test(r.stdout), r.stdout);
});

test('Gancho_AvisoVacio_LoDice', () => {
  const l = hookLab();
  fs.writeFileSync(path.join(l.packs, 'producto', 'notices', 'url.md'), '   \n');
  const r = runHook(l);
  assert.strictEqual(r.code, 0);
  assert.ok(/url-del-producto está vacío/.test(r.out), r.out);
});

test('Gancho_GitNoContesta_LoDiceYSale0', () => {
  // sin git en el PATH no se sabe si el repo cumple `repo_files`: eso no es «no aplica», y se dice
  const l = hookLab();
  const r = runHook(l, { env: { PATH: path.dirname(process.execPath) } });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.out.includes('REGLA-DE-LA-URL'));
  assert.ok(/no se pudo saber si .* es un repo/.test(r.out), r.out);
});

test('Gancho_Apagado_Calla', () => {
  const l = hookLab();
  const r = runHook(l, { env: { TYCON_EXTENSION_NOTICES: '0' } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out, '');
});

test('Gancho_FueraDeUnRepo_ConRepoFilesCalla', () => {
  const l = hookLab();
  const r = runHook(l, { cwd: l.home });
  assert.strictEqual(r.code, 0);
  assert.ok(!r.out.includes('REGLA-DE-LA-URL'));
});
