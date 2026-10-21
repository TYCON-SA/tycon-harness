'use strict';
// las suites que lanzan harness.js no bajan el Node del arnés de nodejs.org
process.env.TYCON_HARNESS_NODE = '0';
// harness-team-azure.test.js — la capa del equipo desde AZURE DEVOPS (la fuente de TYCON), contra el Azure de
// juguete (scripts/tests/fixtures/toy-azure-server.js) sobre un repo bare real. Sin red, sin tocar ~/.tycon ni ~/.claude.
//
//   TA1 · la URL del repo del equipo: https://dev.azure.com/<org>/<proyecto>/_git/<repo> (con usuario@, barra final o .git)
//         se entiende; otra cosa, no.
//   TA2 · la credencial, en orden: el PAT de ~/.tycon/config.json (azure.token) gana; si no, el gestor de credenciales de git
//         SIN interacción (un `git` de juguete en el PATH); sin ninguna, se DICE qué falta y las dos formas de ponerla.
//   TA3 · resolver: ref → commit → árbol recursivo (su hash recalculado da el treeId) → lista cerrada → declaración y perfil
//         por `items`, verificados por su blob; una lista cortada no se usa; un item alterado no se usa.
//   TA4 · el acceso, como Azure lo da: anónimo o PAT inválido → la página de login (302) → «sin credencial / no vale» con la
//         acción; 403 → sin permiso de lectura; 404 → el repo o el proyecto no existe; nunca «sin red».
//   TA5 · bajar: los archivos uno por uno a la caché con su manifiesto; la segunda vez, desde la caché sin pedir nada.
//   T41 · el reloj de la bajada, contra el Azure de juguete LENTO: bajar no hereda el reloj de mirar; si el suyo no alcanza
//         dice «se acabó el tiempo» (no «sin red») y el intento siguiente sigue desde lo ya bajado; el cliente de GitHub, igual.
//
// Uso: node --test scripts/tests/harness-team-azure.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const AZ = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team-azure.js'));
const TEAM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
const SERVER = path.join(__dirname, 'fixtures', 'toy-azure-server.js');

const casa = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `team-azure-${name}-`));
  if (d.startsWith(ROOT) || /agent-skills|\.claude\/|\.tycon\//.test(d)) throw new Error(`el laboratorio cayó en ${d}`);
  return d;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const gitEnv = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (args, cwd) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

const PROFILE = '{ "ado": { "org": "https://dev.azure.com/acme" }, "integrations": { "engram": true, "nightly": true, "mailbox": true }, "update": { "channel": "latest", "apply": "auto" }, "packs": { "default": "all" }, "install": { "profile": "full" } }\n';

/** Un repo del equipo de juguete (bare) y el Azure de juguete que lo atiende. */
// El reloj de la bajada que le da producción (team.js): 120 s, o 3 s por archivo que falta. Sin él, `fetch` corre contra el
// reloj de 15 s del cliente, que arranca al crearlo y cuenta también la resolución: con 114 archivos, un proceso por
// pedido, una máquina con carga lo pasa y la prueba falla por tiempo y no por lo que mide.
const DOWN = { deadlineFor: (pending) => Date.now() + Math.max(120, Math.ceil(pending) * 3) * 1000 };

async function lab(name, { pat = 'pat-lab' } = {}) {
  const dir = casa(name);
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(work, 'scripts', 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(work, 'team-layer.json'), '{ "schema": 1, "name": "equipo-lab", "requires": { "harness": ">= 2026.10.01.1" } }\n');
  fs.writeFileSync(path.join(work, 'perfil-equipo.json'), PROFILE);
  fs.writeFileSync(path.join(work, 'scripts', 'metrics', 'corridas-buzon.json'), '{ "_que_es": "llave de juguete", "sas": "sv=lab" }\n');
  fs.writeFileSync(path.join(work, 'README.md'), '# repo del equipo de juguete\n');
  git(['init', '-q', '-b', 'main'], work); git(['add', '-A'], work); git(['commit', '-q', '-m', 'la capa'], work);
  const bare = path.join(dir, 'team.git');
  git(['clone', '-q', '--bare', work, bare], dir);
  const control = path.join(dir, 'control.json'); fs.writeFileSync(control, JSON.stringify({ pat }));
  const ports = path.join(dir, 'ports.env'); const logFile = path.join(dir, 'requests.log');
  const srv = spawn(process.execPath, [SERVER, '--repo', bare, '--org', 'acme', '--project', 'proyecto', '--name', 'equipo-lab', '--control', control, '--log', logFile, '--port-file', ports], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !fs.existsSync(ports); i++) await wait(50);
  if (!fs.existsSync(ports)) throw new Error('el Azure de juguete no arrancó');
  const api = /^AZURE=(.+)$/m.exec(fs.readFileSync(ports, 'utf8'))[1].trim();
  const home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, '.tycon'), { recursive: true });
  const env = { TYCON_AZURE_API: api, TYCON_HOME: path.join(home, '.tycon'), TYCON_AZURE_GIT_CREDENTIAL: '0', PATH: process.env.PATH };
  const src = AZ.parseAzureUrl('https://dev.azure.com/acme/proyecto/_git/equipo-lab');
  const requests = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const setControl = (c) => fs.writeFileSync(control, JSON.stringify(c));
  const savePat = (value) => fs.writeFileSync(path.join(home, '.tycon', 'config.json'), JSON.stringify({ azure: { token: value } }));
  const head = () => git(['rev-parse', 'main'], bare);
  const publish = (file, text, msg) => { const f = path.join(work, ...file.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); git(['add', '-A'], work); git(['commit', '-q', '-m', msg], work); git(['push', '-q', bare, 'main'], work); };
  return { dir, work, bare, home, env, src, requests, setControl, savePat, head, publish, api, stop: () => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('TA1 TeamAzure_Url_DevAzureCom_WithUserSlashOrGit_Parsed_OthersRefused', () => {
  const ok = AZ.parseAzureUrl('https://dev.azure.com/acme/proyecto/_git/equipo-lab');
  assert.deepEqual(ok, { ok: true, host: 'azure', org: 'acme', project: 'proyecto', name: 'equipo-lab', url: 'https://dev.azure.com/acme/proyecto/_git/equipo-lab' });
  // las URL con `usuario@` se arman acá: escritas enteras, el detector de la copia pública las lee como un correo
  const conUsuario = (usuario, resto) => `https://${usuario}@dev.azure.com/${resto}`;
  for (const v of [conUsuario('acme', 'acme/proyecto/_git/equipo-lab'), 'https://dev.azure.com/acme/proyecto/_git/equipo-lab/', 'https://dev.azure.com/acme/proyecto/_git/equipo-lab.git', 'https://dev.azure.com/acme/Mi%20Proyecto/_git/equipo-lab']) {
    assert.equal(AZ.parseAzureUrl(v).ok, true, v);
  }
  assert.equal(AZ.parseAzureUrl('https://dev.azure.com/acme/Mi%20Proyecto/_git/equipo-lab').project, 'Mi Proyecto');
  for (const bad of ['', 'acme/equipo-lab', 'https://github.com/acme/equipo-lab', 'https://dev.azure.com/acme/_git/equipo-lab', 'http://dev.azure.com/acme/proyecto/_git/x', 'https://dev.azure.com/acme/proyecto/_git/../x', 'https://dev.azure.com/acme/proyecto/_git/x/y']) {
    const r = AZ.parseAzureUrl(bad);
    assert.equal(r.ok, false, `«${bad}» tendría que rechazarse`);
    assert.match(r.problem, /dev\.azure\.com|caracteres/);
  }
  // una URL mal escrita con `usuario:clave@` no repite la clave al citarla
  const leak = AZ.parseAzureUrl(conUsuario('alguien:SECRETO-PEGADO', 'acme/_git/x'));
  assert.equal(leak.ok, false); assert.doesNotMatch(leak.problem, /SECRETO-PEGADO/); assert.match(leak.problem, /dev\.azure\.com\/acme\/_git\/x/);
  const leak2 = TEAM.parseTeam(conUsuario('alguien:SECRETO-PEGADO', 'acme/_git/x'));
  assert.equal(leak2.ok, false); assert.doesNotMatch(leak2.problem, /SECRETO-PEGADO/);
  // nombres que Azure DevOps admite y una empresa de habla hispana va a tener: acentos y paréntesis pasan,
  // y en la URL de la API viajan codificados; lo que cambiaría la ruta (`/`, `:`, `?`, `#`, `%`, `&`, `@`, `~`) sigue afuera
  const acento = AZ.parseAzureUrl('https://dev.azure.com/acme/Facturaci%C3%B3n/_git/capa');
  assert.equal(acento.ok, true, acento.problem); assert.equal(acento.project, 'Facturación'); assert.match(acento.url, /\/Facturaci%C3%B3n\/_git\/capa$/);
  const parens = TEAM.parseTeam('https://dev.azure.com/acme/Proyecto%20(Legacy)/_git/capa-%C3%B1and%C3%BA');
  assert.equal(parens.ok, true, parens.problem); assert.equal(parens.name, 'capa-ñandú'); assert.equal(parens.project, 'Proyecto (Legacy)');
  for (const bad of ['https://dev.azure.com/acme/R%26D/_git/capa', 'https://dev.azure.com/acme/a%2Fb/_git/capa', 'https://dev.azure.com/acme/proyecto/_git/x%3Ay', 'https://dev.azure.com/acme/pro%3Fyecto/_git/x', 'https://dev.azure.com/acme/~x/_git/x', 'https://dev.azure.com/acme/a%40b/_git/x']) {
    const r = AZ.parseAzureUrl(bad);
    assert.equal(r.ok, false, `«${bad}» tendría que rechazarse`); assert.match(r.problem, /caracteres/);
  }
});

test('TA2 TeamAzure_Credential_ConfigPatWins_ThenGitCredentialNoPrompt_ThenSaidMissingWithBothWays', () => {
  const home = casa('cred');
  const env = { TYCON_HOME: path.join(home, '.tycon'), PATH: process.env.PATH };
  const src = AZ.parseAzureUrl('https://dev.azure.com/acme/proyecto/_git/equipo-lab');
  // un git de juguete que contesta `credential fill` sin preguntar (y anota que corrió sin interacción)
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const fakeGit = path.join(bin, 'git');
  // (y sin askpass: la terminal de VS Code deja GIT_ASKPASS en el entorno; con él git abriría un cuadro al dev — revisión adversarial)
  fs.writeFileSync(fakeGit, `#!/bin/sh\n[ "$1" = credential ] && [ "$2" = fill ] || exit 9\n[ "$GCM_INTERACTIVE" = never ] && [ "$GIT_TERMINAL_PROMPT" = 0 ] || { echo "interactivo" >&2; exit 8; }\n[ -z "\${GIT_ASKPASS:-}" ] && [ -z "\${SSH_ASKPASS:-}" ] || { echo "askpass" >&2; exit 7; }\ncat > "${home}/fill.in"\n[ -f "${home}/sin-credencial" ] && exit 1\nprintf 'protocol=https\\nhost=dev.azure.com\\nusername=alguien\\npassword=pat-del-gestor\\n'\n`);
  fs.chmodSync(fakeGit, 0o755);
  env.GIT_ASKPASS = '/usr/bin/false'; env.SSH_ASKPASS = '/usr/bin/false';   // como la terminal de VS Code: el programa tiene que vaciarlas
  // (1) sin PAT guardado y sin credencial en el gestor: se dice qué falta y las dos formas
  fs.writeFileSync(path.join(home, 'sin-credencial'), '');
  const none = AZ.credential(src, { env, git: fakeGit });
  assert.equal(none.ok, false);
  assert.match(none.reason, /sin credencial de Azure DevOps/);
  assert.match(none.reason, /config set azure\.token/);
  assert.match(none.reason, /gestor de credenciales/);
  assert.match(fs.readFileSync(path.join(home, 'fill.in'), 'utf8'), /host=dev\.azure\.com\npath=acme\/proyecto\/_git\/equipo-lab/, 'le pidió al gestor la credencial de ESE repo');
  // (2) el gestor la tiene: se usa, sin preguntar
  fs.unlinkSync(path.join(home, 'sin-credencial'));
  const gcm = AZ.credential(src, { env, git: fakeGit });
  assert.deepEqual([gcm.ok, gcm.source, gcm.pat, gcm.username], [true, 'git-credential', 'pat-del-gestor', 'alguien']);
  // (3) el PAT guardado gana al gestor
  fs.mkdirSync(path.join(home, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tycon', 'config.json'), '{ "azure": { "token": "pat-guardado" } }');
  const cfg = AZ.credential(src, { env, git: fakeGit });
  assert.deepEqual([cfg.ok, cfg.source, cfg.pat], [true, 'config', 'pat-guardado']);
  // (4) el gestor apagado por variable (las pruebas del laboratorio): sin PAT guardado, falta
  fs.unlinkSync(path.join(home, '.tycon', 'config.json'));
  assert.equal(AZ.credential(src, { env: Object.assign({}, env, { TYCON_AZURE_GIT_CREDENTIAL: '0' }), git: fakeGit }).ok, false);
  // (5) un git que no está no cuelga ni tira: falta, dicho
  assert.equal(AZ.credential(src, { env, git: path.join(home, 'no-hay-git') }).ok, false);
  // (6) la configuración propia ilegible no se traga: se dice
  fs.writeFileSync(path.join(home, '.tycon', 'config.json'), '{ roto');
  const broken = AZ.credential(src, { env, git: fakeGit });
  assert.equal(broken.ok, false); assert.match(broken.reason, /config\.json/);
});

test('TA3 TeamAzure_Resolve_RefCommitTreeHashRecomputed_ClosedList_ItemsVerifiedByBlob_TruncatedOrTamperedRefused', async () => {
  const L = await lab('resolve');
  try {
    L.savePat('pat-lab');
    const cred = AZ.credential(L.src, { env: L.env });
    assert.equal(cred.source, 'config');
    const c = AZ.client(L.src, cred, { env: L.env });
    const r = AZ.resolve(c, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.commit, L.head());
    assert.deepEqual(r.files.map((f) => f.path), ['perfil-equipo.json', 'scripts/metrics/corridas-buzon.json']);
    assert.deepEqual(r.declaration, { name: 'equipo-lab', requires: '2026.10.01.1' });
    assert.equal(r.host, 'azure'); assert.equal(r.repo, L.src.url);
    assert.ok(r.profileEntries.some((e) => e.ruta === 'integraciones.engram' && e.valor === true));
    const paths = L.requests().map((q) => q.path);
    assert.ok(paths.some((p) => /\/refs\?filter=heads\/main/.test(p)) && paths.some((p) => /\/commits\//.test(p)) && paths.some((p) => /\/trees\/.*recursive=true/.test(p)) && paths.some((p) => /\/items\?path=%2Fteam-layer\.json/.test(p)), paths.join('\n'));
    assert.ok(L.requests().every((q) => q.auth_sha256 !== 'pat-lab'), 'el registro del servidor no trae el PAT en claro');
    // la versión que va a quedar no cumple la mínima
    const old = AZ.resolve(c, { version: '2026.09.01.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(old.ok, false); assert.match(old.reason, /2026\.10\.01\.1/);
    // una lista del árbol cortada: su hash no da el del commit → no se usa
    L.setControl({ pat: 'pat-lab', truncated_tree: true });
    const cut = AZ.resolve(c, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(cut.ok, false); assert.match(cut.reason, /no da el árbol del commit/);
    // una lista con una entrada sin forma (nula, sin ruta, sin sha, sin tipo): «no se usa», dicho — nunca un TypeError que suba
    // hasta harness.js como volcado de pila
    const SHA = (ch) => ch.repeat(40);
    for (const entry of [null, { mode: '100644', gitObjectType: 'blob', objectId: SHA('c') }, { relativePath: 'team-layer.json', mode: '100644', gitObjectType: 'blob', objectId: null }, { relativePath: 'team-layer.json', mode: '100644', objectId: SHA('c') }, { relativePath: 'team-layer.json', gitObjectType: 'blob', objectId: 'no-es-sha' }]) {
      const fake = { src: L.src, get: (p) => /^refs\?/.test(p) ? { ok: true, status: 200, json: { value: [{ name: 'refs/heads/main', objectId: SHA('a') }] } }
        : /^commits\//.test(p) ? { ok: true, status: 200, json: { treeId: SHA('b') } }
        : /^trees\//.test(p) ? { ok: true, status: 200, json: { treeEntries: [entry] } } : { ok: false, status: 0, kind: 'test', error: `pedido inesperado ${p}` } };
      const mal = AZ.resolve(fake, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
      assert.equal(mal.ok, false, JSON.stringify(entry)); assert.match(mal.reason, /entrada sin forma/);
    }
    // un item alterado: su blob no es el de la lista → no se usa
    L.setControl({ pat: 'pat-lab', tamper_item: 'perfil-equipo.json' });
    const tam = AZ.resolve(c, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(tam.ok, false); assert.match(tam.reason, /no es el blob/);
    L.setControl({ pat: 'pat-lab' });
    // una ruta fuera de la lista cerrada en el repo del equipo: la capa entera, rechazada y nombrada
    L.publish('scripts/hooks/x.js', 'module.exports = 1;\n', 'un guion');
    const bad = AZ.resolve(c, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(bad.ok, false); assert.match(bad.reason, /scripts\/hooks\/x\.js: fuera de la lista cerrada/);
  } finally { L.stop(); }
});

test('TA4 TeamAzure_Access_LoginPageIsMissingOrInvalidCredential_403NoRead_404RepoOrProject_NeverNoNetwork', async () => {
  const L = await lab('access');
  try {
    const resolve = (cred) => AZ.resolve(AZ.client(L.src, cred, { env: L.env }), { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    // sin credencial: Azure manda a la página de login (302) → «sin credencial», con la acción
    const none = { ok: false, reason: 'x' };
    const anon = resolve(none);
    assert.equal(anon.ok, false); assert.equal(anon.missing, 'team');
    assert.match(anon.reason, /sin credencial de Azure DevOps/); assert.match(anon.reason, /302/); assert.match(anon.reason, /config set azure\.token/);
    assert.doesNotMatch(anon.reason, /sin red/);
    // un PAT que no vale: la misma página de login → «no vale», nombrando de dónde salió
    L.savePat('pat-que-no-vale');
    const bad = resolve(AZ.credential(L.src, { env: L.env }));
    assert.equal(bad.ok, false); assert.match(bad.reason, /no vale/); assert.match(bad.reason, /PAT guardado/);
    assert.doesNotMatch(bad.reason, /pat-que-no-vale/, 'el valor del PAT no se imprime');
    // vale pero no ve el repo: 403 → sin permiso de lectura
    L.savePat('pat-lab'); L.setControl({ pat: 'pat-lab', blind: true });
    const blind = resolve(AZ.credential(L.src, { env: L.env }));
    assert.equal(blind.ok, false); assert.match(blind.reason, /permiso de lectura \(Code: Read\)/);
    // el repo no existe: 404
    L.setControl({ pat: 'pat-lab', missing_repo: true });
    const miss = resolve(AZ.credential(L.src, { env: L.env }));
    assert.equal(miss.ok, false); assert.match(miss.reason, /no existe en acme\/proyecto/);
    // otro proyecto: 404 del proyecto
    L.setControl({ pat: 'pat-lab' });
    const otherSrc = AZ.parseAzureUrl('https://dev.azure.com/acme/otro-proyecto/_git/equipo-lab');
    const proj = AZ.resolve(AZ.client(otherSrc, AZ.credential(otherSrc, { env: L.env }), { env: L.env }), { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(proj.ok, false); assert.match(proj.reason, /proyecto otro-proyecto no existe/);
    // TYCON_AZURE_API por http hacia OTRO host: la credencial no se manda en claro
    const insecure = AZ.resolve(AZ.client(L.src, AZ.credential(L.src, { env: L.env }), { env: Object.assign({}, L.env, { TYCON_AZURE_API: 'http://ejemplo.invalid:8080' }) }), { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(insecure.ok, false); assert.match(insecure.reason, /no se manda en claro/);
    assert.equal(L.requests().filter((q) => q.path.includes('ejemplo')).length, 0);
    // la rama `main` tiene que ser exacta: con `main-old` y sin `main`, no se usa «la primera»
    git(['branch', '-m', 'main', 'main-old'], L.bare);
    const noMain = AZ.resolve(AZ.client(L.src, AZ.credential(L.src, { env: L.env }), { env: L.env }), { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(noMain.ok, false); assert.match(noMain.reason, /no tiene la rama main/); assert.match(noMain.reason, /main-old/);
    git(['branch', '-m', 'main-old', 'main'], L.bare);
    // un servidor que no contesta es «sin red» (y no «sin credencial»)
    const dead = AZ.resolve(AZ.client(L.src, AZ.credential(L.src, { env: L.env }), { env: Object.assign({}, L.env, { TYCON_AZURE_API: 'http://127.0.0.1:9' }), deadlineAt: Date.now() + 3000 }), { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(dead.ok, false); assert.equal(dead.status, 'unknown'); assert.match(dead.reason, /sin red/);
  } finally { L.stop(); }
});

// `config set azure.token` —la acción que recomiendan todos los mensajes— tiene que pasar la tabla
// del analizador de argumentos de harness.js, y un config.json que trae SÓLO el PAT de Azure se reescribe dejándolo
// para el usuario (la lista de secretos no puede ser sólo `github.token`). Las dos cosas, por el camino real.
test('TA6 TeamAzure_ConfigSetAzureToken_CliSavesByStdinUserOnlyNeverEchoes_RewriteKeepsUserOnly', () => {
  const home = casa('cli');
  const tyconHome = path.join(home, '.tycon');
  const env = { HOME: home, USERPROFILE: home, TYCON_HOME: tyconHome, PATH: process.env.PATH };
  const harness = (args, input) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup', 'harness.js'), ...args], { input, env, encoding: 'utf8' });
  const file = path.join(tyconHome, 'config.json');
  const PAT = 'pat-de-prueba-que-no-se-ve-123';
  // (1) guardar por stdin: sale 0, queda en el archivo, sólo para el usuario, y el valor no aparece en la salida
  const set = harness(['config', 'set', 'azure.token'], PAT);
  assert.equal(set.status, 0, `${set.stdout}\n${set.stderr}`);
  assert.doesNotMatch(`${set.stdout}${set.stderr}`, new RegExp(PAT));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).azure.token, PAT);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // (2) show nombra la clave y no el valor; unset la saca y sale 0 (también pasaba por la misma tabla)
  const show = harness(['config', 'show']);
  assert.equal(show.status, 0); assert.match(show.stdout, /azure\.token/); assert.doesNotMatch(show.stdout, new RegExp(PAT));
  const unset = harness(['config', 'unset', 'azure.token']);
  assert.equal(unset.status, 0, `${unset.stdout}\n${unset.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).azure && JSON.parse(fs.readFileSync(file, 'utf8')).azure.token, undefined);
  // (3) la reescritura por tycon-config de un archivo que trae SÓLO el PAT de Azure lo deja sólo para el usuario (en Windows el
  // reemplazo hereda los permisos de la carpeta; acá se mide que vuelve a 0600 aunque estuviera abierto)
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.join(tyconHome, 'state'), { recursive: true });   // la máquina vive en ~/.tycon: tycon-config escribe ahí
    fs.writeFileSync(file, JSON.stringify({ azure: { token: PAT } }), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const CFG = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
    const r = CFG.setKey(home, 'install.profile', 'minimal', { guardLib: path.join(home, 'no-hay-freno.js'), env });
    assert.equal(r.ok, true, r.reason); assert.equal(r.file, file); assert.equal(r.warning, null);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'volvió a quedar sólo para el usuario');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).azure.token, PAT, 'y el PAT sigue ahí');
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('TA5 TeamAzure_Fetch_ItemsToCacheWithManifest_SecondTimeFromCacheWithoutRequests', async () => {
  const L = await lab('fetch');
  try {
    L.savePat('pat-lab');
    const c = AZ.client(L.src, AZ.credential(L.src, { env: L.env }), { env: L.env });
    const r = AZ.resolve(c, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(r.ok, true, r.reason);
    const f = AZ.fetch(c, r, { env: L.env, ...DOWN });
    assert.equal(f.ok, true, f.reason);
    assert.equal(f.fromCache, false);
    assert.equal(f.cacheDir, TEAM.cacheDirOf(L.env, r.commit));
    const m = TEAM.readTeamManifest(f.cacheDir);
    assert.equal(m.commit, r.commit); assert.equal(m.repo, L.src.url); assert.equal(m.host, 'azure'); assert.equal(m.files.length, 2);
    assert.equal(fs.readFileSync(path.join(f.cacheDir, 'perfil-equipo.json'), 'utf8'), PROFILE);
    const before = L.requests().length;
    const again = AZ.fetch(c, r, { env: L.env, ...DOWN });
    assert.equal(again.ok, true); assert.equal(again.fromCache, true);
    assert.equal(L.requests().length, before, 'la segunda vez no pidió nada');
    // lo bajado se apila con el mismo stackTeam que la fuente de GitHub (el manifiesto apilado dice el repo de Azure)
    const incoming = path.join(L.dir, 'incoming'); fs.mkdirSync(path.join(incoming, 'scripts'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(incoming, 'scripts', 'lib'), { recursive: true });
    const st = TEAM.stackTeam(again, incoming, { home: L.home, env: L.env });
    assert.equal(st.ok, true, JSON.stringify(st));
    assert.equal(st.manifest.repo, L.src.url);
    assert.ok(fs.existsSync(path.join(incoming, 'scripts', 'metrics', 'corridas-buzon.json')));
  } finally { L.stop(); }
});

// ── T40: una punta nueva no vuelve a pedir lo que la máquina ya tiene con ese blob ─────────
test('T40 TeamAzure_NewTipReusesBlobsFromHarnessOrCache_OnlyChangedItemsRequested', async () => {
  const L = await lab('reuse');
  try {
    L.savePat('pat-lab');
    // la capa de 114 archivos: el perfil, la llave, y una skill con 112 .md
    const skill = 'skills/sola-juguete';
    L.publish(`${skill}/SKILL.md`, '---\nname: sola-juguete\ndescription: skill de juguete\n---\nUsala.\n', 'la skill');
    for (let i = 0; i < 110; i++) { const f = path.join(L.work, ...skill.split('/'), 'refs', `r${i}.md`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `# referencia ${i}\n`); }
    L.publish(`${skill}/refs/ultima.md`, '# la última\n', 'las referencias');
    const c = AZ.client(L.src, AZ.credential(L.src, { env: L.env }), { env: L.env });
    const r1 = AZ.resolve(c, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(r1.ok, true, r1.reason);
    assert.equal(r1.files.length, 114);
    const f1 = AZ.fetch(c, r1, { env: L.env, ...DOWN });
    assert.equal(f1.ok, true, f1.reason);
    // instalada: la capa apilada en harness/ (la casa del arnés de juguete)
    const harness = path.join(L.env.TYCON_HOME, 'harness');
    fs.mkdirSync(path.join(harness, 'scripts'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(harness, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(harness, '.tycon-release.json'), JSON.stringify({ schema: 1, version: '2026.10.09.1', files: [] }));
    const st1 = TEAM.stackTeam(f1, harness, { home: L.home, env: L.env });
    assert.equal(st1.ok, true, JSON.stringify(st1));
    // la caché de la primera punta no está (otra máquina, o se limpió): lo instalado alcanza (salvo la declaración, que no se
    // apila: la primera punta nueva la vuelve a pedir y queda en su caché)
    fs.rmSync(f1.cacheDir, { recursive: true, force: true });
    L.publish('README.md', '# el repo del equipo de juguete, otra vez\n', 'un papel de la raíz');
    const r1b = AZ.resolve(c, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(AZ.fetch(c, r1b, { env: L.env, ...DOWN }).ok, true);
    // (a) una punta que sólo cambia el perfil: la lista y UN item (el perfil)
    L.publish('perfil-equipo.json', PROFILE.replace('"latest"', '"stable"'), 'sólo el perfil');
    const before = L.requests().length;
    const r2 = AZ.resolve(c, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(r2.ok, true, r2.reason);
    const f2 = AZ.fetch(c, r2, { env: L.env, ...DOWN });
    assert.equal(f2.ok, true, f2.reason);
    const asked = L.requests().slice(before).map((q) => q.path);
    const items = asked.filter((p) => /\/items\?/.test(p));
    assert.deepEqual(items.map((p) => decodeURIComponent(/path=([^&]+)/.exec(p)[1])), ['/perfil-equipo.json'], asked.join('\n'));
    assert.equal(asked.length, 4, `la lista (ref, commit, árbol) más uno: ${asked.join('\n')}`);
    // lo copiado, verificado por su blob
    for (const f of f2.files) assert.equal(TEAM.blobOf(fs.readFileSync(path.join(f2.cacheDir, ...f.path.split('/')))), f.blob, f.path);
    // (b) una punta que agrega un archivo que ya está —con ese blob— en OTRA caché: no se pide
    const other = path.join(L.env.TYCON_HOME, 'team', 'abcabcabcabc');
    const extra = '# ya la tenía otra caché\n';
    fs.mkdirSync(path.join(other, 'skills', 'x'), { recursive: true });
    fs.writeFileSync(path.join(other, 'skills', 'x', 'y.md'), extra);
    fs.writeFileSync(path.join(other, '.tycon-team.json'), JSON.stringify({ schema: 1, repo: 'https://dev.azure.com/acme/proyecto/_git/otro', commit: 'a'.repeat(40), tree: 'b'.repeat(40), files: [{ path: 'skills/x/y.md', mode: '100644', blob: TEAM.blobOf(Buffer.from(extra)) }] }));
    L.publish(`${skill}/refs/nueva.md`, extra, 'una referencia que otra caché ya tiene');
    const b2 = L.requests().length;
    const r3 = AZ.resolve(c, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    const f3 = AZ.fetch(c, r3, { env: L.env, ...DOWN });
    assert.equal(f3.ok, true, f3.reason);
    assert.deepEqual(L.requests().slice(b2).filter((q) => /\/items\?/.test(q.path)), [], 'nada se pidió por items');
    assert.equal(fs.readFileSync(path.join(f3.cacheDir, ...skill.split('/'), 'refs', 'nueva.md'), 'utf8'), extra);
    // un archivo «reusable» alterado en el disco no se usa: se pide
    fs.writeFileSync(path.join(harness, ...skill.split('/'), 'refs', 'r0.md'), '# editado a mano\n');
    for (const d of fs.readdirSync(path.join(L.env.TYCON_HOME, 'team'))) if (d !== 'abcabcabcabc') fs.rmSync(path.join(L.env.TYCON_HOME, 'team', d), { recursive: true, force: true });
    const b3 = L.requests().length;
    const r4 = AZ.resolve(c, { version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    const f4 = AZ.fetch(c, r4, { env: L.env, ...DOWN });
    assert.equal(f4.ok, true, f4.reason);
    assert.ok(L.requests().slice(b3).some((q) => /refs%2Fr0\.md/.test(q.path)), 'el editado se pide al servidor');
    assert.equal(fs.readFileSync(path.join(f4.cacheDir, ...skill.split('/'), 'refs', 'r0.md'), 'utf8'), '# referencia 0\n');
  } finally { L.stop(); }
});

// ── el reloj de la BAJADA ──────────────────────────────────────────────────────────────────────────────────────
// Una capa grande no puede bajarse con el reloj de MIRAR: si el refresco bajara archivo por archivo con ese reloj,
// al archivo N le quedarían pocos ms y la salida diría «sin red». El Azure de juguete contesta al instante: acá va LENTO.
/** Una capa con `n` referencias en una skill de juguete (más el perfil, la llave y su SKILL.md). */
function publishSkill(L, n) {
  const skill = 'skills/sola-juguete';
  L.publish(`${skill}/SKILL.md`, '---\nname: sola-juguete\ndescription: skill de juguete\n---\nUsala.\n', 'la skill');
  for (let i = 0; i < n - 1; i++) { const f = path.join(L.work, ...skill.split('/'), 'refs', `r${i}.md`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `# referencia ${i}\n`); }
  L.publish(`${skill}/refs/ultima.md`, '# la última\n', 'las referencias');
}
const itemsAsked = (reqs) => reqs.filter((q) => /\/items\?/.test(q.path)).map((q) => decodeURIComponent(/path=([^&]+)/.exec(q.path)[1]));

test('T41 TeamAzure_DownloadClock_SlowServer_TheDownloadOutlivesTheLookBudget', async () => {
  const L = await lab('slow');
  try {
    L.savePat('pat-lab');
    publishSkill(L, 24);
    // mirar: 4 s de reloj, que a un servidor que contesta al instante le sobran
    const LOOK_MS = 4000;
    const open = TEAM.openSource(L.src.url, { ctx: { env: L.env, home: L.home }, deadlineAt: Date.now() + LOOK_MS });
    assert.equal(open.ok, true, open.reason);
    const r = open.resolve({ version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.files.length, 27);
    // bajar: el servidor tarda 250 ms por pedido; lo que falta (más de 20 archivos, 5 s como poco) no entra en esos 4 s
    L.setControl({ pat: 'pat-lab', latency_ms: 250 });
    const before = L.requests().length;
    const t0 = Date.now();
    const f = open.fetch(r, { env: L.env });
    assert.equal(f.ok, true, `la bajada tiene su propio reloj: ${f.reason}`);
    const asked = itemsAsked(L.requests().slice(before));
    assert.ok(asked.length > 20, `pidió ${asked.length} archivos`);
    assert.ok(Date.now() - t0 > LOOK_MS, `tardó ${Date.now() - t0} ms: más que el reloj de mirar`);
    for (const x of f.files) assert.equal(TEAM.blobOf(fs.readFileSync(path.join(f.cacheDir, ...x.path.split('/')))), x.blob, x.path);
  } finally { L.stop(); }
});

test('T41 TeamAzure_DownloadClock_WhenItRunsOut_SaysOutOfTimeNotNoNetwork_AndTheNextTryResumes', async () => {
  const L = await lab('budget');
  try {
    L.savePat('pat-lab');
    publishSkill(L, 24);
    // el reloj de la bajada, a propósito corto (3 s) contra un servidor de 350 ms por pedido: alcanza para unos pocos archivos
    const short = Object.assign({}, L.env, { TYCON_RELEASE_DOWNLOAD_BUDGET_S: '3', TYCON_UPDATE_NETWORK_BUDGET_S: '2' });
    const open = TEAM.openSource(L.src.url, { ctx: { env: short, home: L.home }, deadlineAt: Date.now() + 20000 });
    const r = open.resolve({ version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: short });
    assert.equal(r.ok, true, r.reason);
    L.setControl({ pat: 'pat-lab', latency_ms: 350 });
    const b1 = L.requests().length;
    const f = open.fetch(r, { env: short });
    assert.equal(f.ok, false);
    assert.equal(f.status, 'unknown', 'se reintenta: no es un rechazo');
    assert.match(f.reason, /se acabó el tiempo/, f.reason);
    assert.doesNotMatch(f.reason, /sin red/, f.reason);
    const m = /bajé (\d+) de (\d+) archivo/.exec(f.reason);
    assert.ok(m, f.reason);
    const got = Number(m[1]), need = Number(m[2]);
    assert.ok(got >= 1 && got < need, f.reason);
    assert.match(f.reason, /TYCON_RELEASE_DOWNLOAD_BUDGET_S/, 'dice cómo darle más tiempo');
    assert.equal(fs.existsSync(TEAM.cacheDirOf(short, r.commit)), false, 'la caché no queda a medias');
    const first = itemsAsked(L.requests().slice(b1));
    // lo bajado quedó guardado por su blob; uno alterado en el disco no se usa (se vuelve a pedir)
    const partial = `${TEAM.cacheDirOf(short, r.commit)}.partial`;
    const kept = fs.readdirSync(partial);
    assert.equal(kept.length, got, `guardados: ${kept.join(', ')}`);
    fs.writeFileSync(path.join(partial, kept[0]), '# alterado\n');
    // el intento siguiente, con el reloj de siempre y el servidor ya rápido: pide sólo lo que faltaba
    L.setControl({ pat: 'pat-lab' });
    const open2 = TEAM.openSource(L.src.url, { ctx: { env: L.env, home: L.home }, deadlineAt: Date.now() + 20000 });
    const r2 = open2.resolve({ version: '2026.10.09.1', readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(r2.ok, true, r2.reason);
    const b2 = L.requests().length;
    const f2 = open2.fetch(r2, { env: L.env });
    assert.equal(f2.ok, true, f2.reason);
    const second = itemsAsked(L.requests().slice(b2));
    assert.equal(second.length, need - got + 1, `faltaban ${need - got} más el alterado, y pidió ${second.length}`);
    assert.ok(first.length >= got, 'lo del primer intento quedó guardado');
    for (const x of f2.files) assert.equal(TEAM.blobOf(fs.readFileSync(path.join(f2.cacheDir, ...x.path.split('/')))), x.blob, x.path);
    // lo guardado a medias no queda: la caché entera lo reemplaza
    assert.deepEqual(fs.readdirSync(path.join(L.env.TYCON_HOME, 'team')).filter((n) => /partial/.test(n)), []);
  } finally { L.stop(); }
});

test('T41 GitHubClient_SameClass_AClockThatRunsOutIsNotNoNetwork_AMuteServerStillIs', async () => {
  // el cliente de GitHub contra un servidor cualquiera que contesta (acá el Azure de juguete: 404 al instante) y después tarda
  const L = await lab('github-clock');
  try {
    const R = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'release.js'));
    const env = { TYCON_RELEASE_API: L.api, TYCON_HOME: L.env.TYCON_HOME, PATH: process.env.PATH };
    L.setControl({ pat: null });
    const c = R.client({ env }, { deadlineAt: Date.now() + 3000 });
    assert.equal(c.get('/algo').ok, true, 'el servidor contesta');
    // lo que queda del reloj (menos de 2 s) no le alcanza a un servidor de 3 s: es el reloj, no la red
    while (c.deadline - Date.now() > 1500) await wait(100);
    L.setControl({ pat: null, latency_ms: 3000 });
    const slow = c.get('/otra-cosa');
    assert.equal(slow.ok, false);
    const said = R.explainFailure(c, slow, { what: 'el comprimido', probeUser: false });
    assert.equal(said.status, 'unknown');
    assert.match(said.reason, /se acabó el tiempo/, said.reason);
    assert.doesNotMatch(said.reason, /sin red/, said.reason);
    // un servidor que NUNCA contestó, con todo el reloj para él: eso sigue siendo «sin red»
    L.setControl({ pat: null, mute: true });
    const c2 = R.client({ env }, { deadlineAt: Date.now() + 1500 });
    const mute = c2.get('/nada');
    assert.equal(mute.ok, false);
    assert.match(R.explainFailure(c2, mute, { what: 'la API', probeUser: false }).reason, /sin red/);
    // el reloj se puede correr para la bajada (mirar es corto, bajar es largo)
    const c3 = R.client({ env }, { deadlineAt: Date.now() + 1000 });
    c3.setDeadline(Date.now() + 60000);
    assert.ok(c3.deadline - Date.now() > 50000);
  } finally { L.stop(); }
});
