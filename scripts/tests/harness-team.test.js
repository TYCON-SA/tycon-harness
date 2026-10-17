'use strict';
// harness-team.test.js — la capa del equipo (story 8.25, tanda A1a): lo que se decide SIN red ni laboratorio, como pruebas
// unitarias de scripts/setup/harness/team.js.
//
//   T1 · Cli_TeamOption_InstallAndMigrate_ClosedTable_EnglishNames_NoRealNames — `--team <org>/<repo>` en install y migrate,
//        la ayuda lo describe sin el nombre real del repo del equipo, la tabla de subcomandos sigue cerrada, y `parseTeam`
//        acepta sólo `org/nombre`.
//   T4 · Team_ClosedPaths_OutsideRefusedAllNamed_SymlinkSubmoduleUnsafePath_PublicCollision_OverSize — la lista cerrada
//        sobre la lista del árbol de GitHub: una ruta por causa, TODAS nombradas, nada escrito.
//   T5 · Team_Declaration_MissingBrokenUnknownKey_MinimumVersionNotMet — team-layer.json: ausente, ilegible, una clave de
//        más, sin requires, mínima mayor, otra forma de requires, name fuera del alfabeto: siete rechazos con su motivo.
//   T6u · el perfil candidato se valida con el lector del árbol dado, sobre una carpeta temporal y sin TYCON_PROFILE: un
//        valor personal, una clave desconocida y las tres llaves que no viajan lo rechazan; uno sano pasa.
//   T6w · sin la versión que va a quedar (la mudanza, antes de bajarla), el perfil y team-repos.json no se juzgan con otro
//        árbol: se difieren y vuelven nombrados; la declaración se sigue juzgando.
//   T33 · (tanda A2b-AC33) el mapa de renombres como tercera ruta exacta, validado contra la versión que va a quedar con el
//        lector de esa versión: un mapa sano pasa; cada forma mala rechaza la capa nombrando la entrada; el mapa real pasa.
//   TPN · el perfil con su nombre de hoy (team-profile.json) y el de antes (perfil-equipo.json): la capa acepta los dos, con
//        el de antes avisa cómo renombrarlo, con los dos gana el nuevo y el de antes no se apila; el refresco que renombra
//        deja el nuevo y borra el viejo.
//   T80 · (story 8.26, tanda H1c) el texto del alta del equipo, `onboarding/<nombre>.md`, entra a la lista cerrada: un nivel y
//        sólo `.md`; la charla, un guion, un dato o una subcarpeta rechazan la capa entera; se apila, se arrastra y, cuando la
//        capa deja de traerlo, se va con su carpeta vacía; no va a Codex.
//
// Uso: node --test scripts/tests/harness-team.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEAM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'team-layer-paths.json'), 'utf8'));

const casa = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `team-${name}-`));
  if (d.startsWith(ROOT) || /agent-skills|\.claude\/|\.tycon\//.test(d)) throw new Error(`el laboratorio cayó en ${d}`);
  return d;
};
const SHA = (n) => String(n).padStart(40, '0');
const blob = (p, size = 10, mode = '100644') => ({ path: p, mode, type: 'blob', sha: SHA(p.length), size });
const dir = (p) => ({ path: p, mode: '040000', type: 'tree', sha: SHA(1) });
const SANE = [dir('scripts'), dir('scripts/metrics'), blob('perfil-equipo.json', 300), blob('scripts/metrics/corridas-buzon.json', 400), blob('team-layer.json', 80), blob('README.md', 50), blob('LICENSE', 1000), blob('.gitignore', 5)];
const problemsOf = (r) => r.problems.map((p) => p.path);

/** El nombre real del repo del equipo, si el interno ya lo declara (clave `team` de public-repos.json); si no, null. */
function teamNameDeclared() {
  try { const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'publishing', 'public-repos.json'), 'utf8')); return typeof j.team === 'string' && j.team ? j.team : null; } catch (_) { return null; }
}

test('T1 Cli_TeamOption_InstallAndMigrate_ClosedTable_EnglishNames_NoRealNames', () => {
  // la forma org/nombre
  assert.deepEqual(TEAM.parseTeam('acme/equipo-perfil'), { ok: true, host: 'github', org: 'acme', name: 'equipo-perfil', repo: 'acme/equipo-perfil', url: 'https://github.com/acme/equipo-perfil' });
  // las tres formas (story 8.25, fuente Azure): org/nombre y la URL de GitHub son la misma fuente; la URL de Azure DevOps, la otra
  assert.deepEqual(TEAM.parseTeam('https://github.com/acme/equipo-perfil.git'), TEAM.parseTeam('acme/equipo-perfil'));
  const az = TEAM.parseTeam('https://dev.azure.com/acme/proyecto/_git/equipo-perfil');
  assert.deepEqual(az, { ok: true, host: 'azure', org: 'acme', project: 'proyecto', name: 'equipo-perfil', repo: 'https://dev.azure.com/acme/proyecto/_git/equipo-perfil', url: 'https://dev.azure.com/acme/proyecto/_git/equipo-perfil' });
  assert.equal(TEAM.parseTeam('https://dev.azure.com/acme/_git/x').ok, false);
  for (const bad of ['', 'acme', 'a/b/c', 'acme/', '/x', 'ac me/x', 'acme/x y', 'http://github.com/acme/x', 'https://gitlab.com/acme/x', 'acme/x.git/']) {
    const r = TEAM.parseTeam(bad);
    assert.equal(r.ok, false, `«${bad}» tendría que rechazarse`);
    assert.match(r.problem, /org\/nombre/);
  }
  assert.equal(TEAM.parseTeam('acme/x.git').ok, true, 'un nombre que termina en .git es un nombre válido de GitHub');
  // la tabla de subcomandos: sin subcomando nuevo; install y migrate ganan --team
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness.js'), 'utf8');
  const tableStart = src.indexOf('const COMMANDS = {');
  const tableEnd = src.indexOf('\n};', tableStart);
  const table = src.slice(tableStart, tableEnd);
  const names = [...table.matchAll(/^\s{2}([a-z]+):\s+\{/gm)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['apply', 'channel', 'config', 'doctor', 'install', 'layer', 'link', 'migrate', 'relocate', 'rollback', 'startup', 'uninstall', 'update', 'version'].sort(), 'la tabla de subcomandos no gana ninguno');
  const optsOf = (cmd) => { const m = new RegExp(`^\\s{2}${cmd}:\\s+\\{ opts: \\{([^}]*)\\}`, 'm').exec(table); return m ? m[1] : ''; };
  assert.match(optsOf('install'), /'--team': 'value'/, 'install --team <org>/<repo>');
  assert.match(optsOf('migrate'), /'--team': 'value'/, 'migrate --team <org>/<repo>');
  // la ayuda lo describe, con la forma y sin el nombre real
  const home = casa('help');
  const h = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup', 'harness.js'), '--help'], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon') }) });
  assert.match(`${h.stdout}\n${h.stderr}`, /--team <org>\/<repo>/, 'la ayuda describe --team <org>/<repo>');
  // un --team sin forma sale 2 sin escribir y antes de la red (install; la mudanza, que necesita una máquina con clon, lo
  // mide T13 en harness-move-home.test.sh)
  // (la máquina de juguete «tiene» Claude Code por su llave, como en el laboratorio: en el agente de la validación, sin ninguna
  // herramienta instalada, `install` saldría 1 por «sin herramienta» antes de leer la opción — 170 #12506)
  const toolsBin = path.join(home, 'tools-bin'); fs.mkdirSync(toolsBin);
  for (const cmd of [['install', '--version', 'latest', '--team', 'a/b/c', '--yes'], ['install', '--team', 'sin-barra', '--yes']]) {
    const before = fs.readdirSync(home).sort().join(',');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup', 'harness.js'), ...cmd], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_SETTINGS_PATH: path.join(home, 'settings.json'), TYCON_RELEASE_API: 'http://127.0.0.1:9', TYCON_CLAUDE: '1', TYCON_CODEX: '0', TYCON_TOOLS_DETECT_PATH: toolsBin }) });
    assert.equal(r.status, 2, `${cmd[0]} --team mal formado sale 2: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /org\/nombre/);
    assert.equal(fs.readdirSync(home).sort().join(','), before, `${cmd[0]} con --team mal formado no escribió`);
  }
  // el nombre real del repo del equipo (si el interno ya lo declara) no está en nada que viaje en la copia pública
  const name = teamNameDeclared();
  if (name) {
    for (const f of ['scripts/setup/harness.js', 'scripts/setup/harness/team.js', 'scripts/setup/harness/release.js', 'scripts/setup/harness/move-home.js', 'scripts/setup/harness/github-auth.js', 'scripts/tests/harness-team.test.js', 'scripts/tests/harness-team.test.sh', 'scripts/tests/lib/harness-lab.sh', 'scripts/tests/fixtures/toy-release-server.js', 'guides/mecanismo-de-instalacion.md']) {
      const p = path.join(ROOT, f);
      if (!fs.existsSync(p)) continue;
      assert.equal(fs.readFileSync(p, 'utf8').includes(name), false, `${f} nombra el repo del equipo: ese nombre vive sólo en public-repos.json, onboarding/ y specs/`);
    }
    assert.equal(`${h.stdout}${h.stderr}`.includes(name), false, 'la ayuda no nombra el repo del equipo');
  }
  // la lista cerrada del programa es la del archivo que leen las personas y las pruebas
  assert.deepEqual([...TEAM.CLOSED_PATHS], FIXTURE.paths);
  assert.equal(TEAM.MAX_TOTAL_BYTES, FIXTURE.max_total_bytes);
});

test('T4 Team_ClosedPaths_OutsideRefusedAllNamed_SymlinkSubmoduleUnsafePath_PublicCollision_OverSize', () => {
  // sana: las dos rutas entran, la declaración y los papeles de la raíz no se apilan, nada se rechaza
  const ok = TEAM.planTeam(SANE);
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.deepEqual(ok.files.map((f) => f.path), ['perfil-equipo.json', 'scripts/metrics/corridas-buzon.json']);
  assert.equal(ok.declaration && ok.declaration.sha, SHA('team-layer.json'.length));
  assert.equal(ok.totalBytes, 700);
  // una ruta por causa, todas nombradas con su motivo, la capa ENTERA rechazada
  const bad = TEAM.planTeam([
    ...SANE,
    blob('scripts/hooks/x.js', 10),                                   // fuera de la lista (un guion)
    blob('version.json', 10),                                         // fuera de la lista (la raíz)
    { path: 'enlace', mode: '120000', type: 'blob', sha: SHA(3), size: 5 },   // un enlace
    { path: 'vendor/otro', mode: '160000', type: 'commit', sha: SHA(4) },     // un submódulo
    blob('../x', 10),                                                 // no pasa isSafeLayerPath
    blob('scripts/lib/tycon-config.js', 10),                          // la versión pública ya la trae
  ], { publicPaths: ['scripts/lib/tycon-config.js', 'version.json'] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.files, [], 'con un rechazo no queda nada para apilar');
  const named = problemsOf(bad);
  for (const p of ['scripts/hooks/x.js', 'version.json', 'enlace', 'vendor/otro', '../x', 'scripts/lib/tycon-config.js']) assert.ok(named.includes(p), `${p} tendría que estar nombrada: ${JSON.stringify(bad.problems)}`);
  const reason = (p) => bad.problems.find((x) => x.path === p).reason;
  assert.match(reason('scripts/hooks/x.js'), /lista cerrada/);
  assert.match(reason('enlace'), /enlace/);
  assert.match(reason('vendor/otro'), /submódulo/);
  assert.match(reason('../x'), /segura|fuera del árbol/);
  assert.match(reason('scripts/lib/tycon-config.js'), /versión pública/);
  assert.match(reason('version.json'), /lista cerrada|versión pública/);
  // más que el tope en total (2 MB): una causa más, dicha una vez
  const big = TEAM.planTeam([dir('scripts'), dir('scripts/metrics'), blob('perfil-equipo.json', 1100 * 1024), blob('scripts/metrics/corridas-buzon.json', 1000 * 1024), blob('team-layer.json', 80)]);
  assert.equal(big.ok, false);
  assert.equal(big.problems.filter((p) => /MB en total|tamaño/.test(p.reason)).length, 1);
  // sin la declaración, la capa no vale
  const noDecl = TEAM.planTeam(SANE.filter((e) => e.path !== 'team-layer.json'));
  assert.equal(noDecl.ok, false);
  assert.ok(noDecl.problems.some((p) => p.path === 'team-layer.json' && /falta|no está/.test(p.reason)));
  // una lista cortada por GitHub (truncated) no se juzga
  const cut = TEAM.planTeam(SANE, { truncated: true });
  assert.equal(cut.ok, false);
  assert.ok(cut.problems.some((p) => /cortada|truncated/.test(p.reason)));
});

test('T4b Team_ShaShapeFromGitHub_RefOrTreeNotHex_RefusedBeforeAnyUrlOrPath', () => {
  // lo que GitHub contesta se usa en la URL siguiente y en la ruta de la caché: sin forma de sha, no se usa (revisor de seguridad)
  const home = casa('sha');
  const fake = (refSha, treeSha) => ({
    token: null, repos: null,
    get: (route) => {
      if (/git\/ref\/heads\/main$/.test(route)) return { ok: true, status: 200, headers: {}, json: { object: { sha: refSha } } };
      if (/git\/commits\//.test(route)) return { ok: true, status: 200, headers: {}, json: { sha: refSha, tree: { sha: treeSha } } };
      return { ok: true, status: 404, headers: {}, json: null };
    },
  });
  const bad = TEAM.resolveTeam(fake('../../fuera', SHA(1)), 'acme/equipo', { version: '2026.10.09.1', readerTree: ROOT, home });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /forma de commit/);
  const badTree = TEAM.resolveTeam(fake(SHA(2), 'x/../y'), 'acme/equipo', { version: '2026.10.09.1', readerTree: ROOT, home });
  assert.equal(badTree.ok, false);
  assert.match(badTree.reason, /árbol sin forma de sha/);
  assert.throws(() => TEAM.cacheDirOf({ TYCON_HOME: path.join(home, '.tycon') }, '../../fuera'), /forma de commit/);
  assert.equal(TEAM.fetchTeam(fake(SHA(2), SHA(3)), { repo: 'acme/equipo', commit: 'abc', tree: SHA(3), files: [], declaration: { name: 'e', requires: '2026.10.09.1' } }, { env: { TYCON_HOME: path.join(home, '.tycon') } }).ok, false);
  assert.equal(fs.existsSync(path.join(home, '.tycon')), false, 'no armó ninguna ruta en el disco');
});

test('T4c AdversarialPass_ParseDots_GitattributesRefused_RequiresExtraKey_CarryValidatesWithNewReader_CacheNeverOverridesResolved_StateSyncedWithTree', () => {
  // clase 7: «.» y «..» pasan la forma pero no son nombres
  for (const bad of ['../..', './x', 'acme/..', '../acme']) assert.equal(TEAM.parseTeam(bad).ok, false, `«${bad}»`);
  // clases 9 y 10: un .gitattributes rompe el comprimido que GitHub arma → se rechaza nombrándolo
  const ga = TEAM.planTeam([...SANE, blob('.gitattributes', 20)]);
  assert.equal(ga.ok, false);
  assert.match(ga.problems.find((p) => p.path === '.gitattributes').reason, /gitattributes|comprimido/);
  // clase 6: una clave de más adentro de requires
  const r6 = TEAM.validateDeclaration('{ "schema": 1, "name": "e", "requires": { "harness": ">= 2026.10.01.1", "node": ">= 20" } }', '2026.10.09.1');
  assert.equal(r6.ok, false); assert.match(r6.reason, /requires.*node/);
  // clases 1, 4 y 12: la capa arrastrada se valida con el lector de la versión que VA A QUEDAR (y por la lista cerrada)
  const GH = require(path.join(ROOT, 'scripts', 'lib', 'git-tree-hash.js'));
  const lab = casa('carry');
  const harness = path.join(lab, 'harness'); const incoming = path.join(lab, 'incoming');
  fs.mkdirSync(path.join(incoming, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(incoming, 'scripts', 'lib'), { recursive: true });
  // el lector de la versión nueva ya no conoce la sección `packs`: un perfil que hoy vale queda «roto» ahí
  const reader = path.join(incoming, 'scripts', 'lib', 'tycon-config.js');
  fs.writeFileSync(reader, fs.readFileSync(reader, 'utf8').replace(/\n\s*packs:\s*Object\.freeze\([^\n]*\n/, '\n'));
  const makeHarness = (profileText) => {
    fs.rmSync(harness, { recursive: true, force: true }); fs.mkdirSync(harness, { recursive: true });
    fs.writeFileSync(path.join(harness, 'perfil-equipo.json'), profileText);
    const files = [{ path: 'perfil-equipo.json', mode: '100644', blob: GH.blobSha(Buffer.from(profileText)) }];
    fs.writeFileSync(path.join(harness, TEAM.MANIFEST_NAME), JSON.stringify({ schema: 1, repo: 'acme/equipo', ref: 'main', commit: SHA(7), tree: SHA(8), name: 'e', requires: '2026.10.01.1', files }));
  };
  makeHarness('{ "integrations": { "engram": true }, "packs": { "default": "all" } }\n');
  const carried = TEAM.carryTeam(harness, incoming, { home: lab, env: {} });
  assert.equal(carried.ok, false, 'un perfil que el lector nuevo rechaza no se arrastra');
  assert.match(carried.reason, /no vale para la versión que va a quedar/);
  assert.equal(fs.existsSync(path.join(incoming, 'perfil-equipo.json')), false, 'no escribió nada');
  makeHarness('{ "integrations": { "engram": true } }\n');
  assert.equal(TEAM.carryTeam(harness, incoming, { home: lab, env: {} }).ok, true, 'un perfil que el lector nuevo acepta sí se arrastra');
  // clase 3: el manifiesto apilado dice lo RESUELTO ahora, no lo que la caché traía de otra corrida
  const cacheDir = path.join(lab, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
  const text = '{ "integrations": { "engram": true } }\n';
  fs.writeFileSync(path.join(cacheDir, 'perfil-equipo.json'), text);
  fs.writeFileSync(path.join(cacheDir, TEAM.MANIFEST_NAME), JSON.stringify({ schema: 1, repo: 'otro/repo', ref: 'main', commit: SHA(9), tree: SHA(10), etag: '"viejo"', name: 'otro', requires: '2026.01.01.1', files: [], fetched_at: '2026-01-01T00:00:00.000Z' }));
  const inc2 = path.join(lab, 'incoming2'); fs.mkdirSync(path.join(inc2, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(inc2, 'scripts', 'lib'), { recursive: true });
  const resolved = { repo: 'acme/equipo', ref: 'main', commit: SHA(9), tree: SHA(10), etag: '"nuevo"', files: [{ path: 'perfil-equipo.json', mode: '100644', sha: GH.blobSha(Buffer.from(text)) }], declaration: { name: 'equipo', requires: '2026.10.01.1' } };
  const st = TEAM.stackTeam({ resolved, cacheDir, files: [{ path: 'perfil-equipo.json', mode: '100644', blob: GH.blobSha(Buffer.from(text)) }] }, inc2, { home: lab, env: {} });
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.manifest.repo, 'acme/equipo'); assert.equal(st.manifest.etag, '"nuevo"'); assert.equal(st.manifest.name, 'equipo');
  assert.equal(st.manifest.fetched_at, '2026-01-01T00:00:00.000Z', 'de la caché sólo cuándo se bajó');
  // clase 2: tras una vuelta a previous/ que el estado no vio, state.team pasa a ser lo que hay en el árbol
  const state = { team: { repo: 'acme/equipo', ref: 'main', commit: SHA(11), tree: null, etag: null, name: 'e', files: 2, applied_at: 'x' } };
  assert.equal(TEAM.syncStateWithTree(state, inc2), true); assert.equal(state.team.commit, SHA(9), 'la capa del árbol que quedó');
  assert.equal(TEAM.syncStateWithTree(state, inc2), false, 'ya coincide: nada cambia');
  const bare = path.join(lab, 'sin-capa'); fs.mkdirSync(bare);
  assert.equal(TEAM.syncStateWithTree(state, bare), true); assert.equal(state.team.commit, null); assert.equal(state.team.repo, 'acme/equipo', 'el repo se recuerda para que update la vuelva a traer');
  assert.equal(TEAM.syncStateWithTree({ team: null }, bare), false);
});

test('T5 Team_Declaration_MissingBrokenUnknownKey_MinimumVersionNotMet', () => {
  const V = '2026.10.09.3';
  const good = TEAM.validateDeclaration('{ "schema": 1, "name": "equipo", "requires": { "harness": ">= 2026.10.09.1" } }', V);
  assert.deepEqual(good, { ok: true, name: 'equipo', requires: '2026.10.09.1' });
  assert.equal(TEAM.validateDeclaration('{ "schema": 1, "name": "equipo", "requires": { "harness": ">=2026.10.09.3" } }', V).ok, true, 'la misma versión cumple');
  const cases = [
    [null, /falta|no existe/],
    ['{ no es json', /ilegible|JSON/],
    ['{ "schema": 1, "name": "equipo", "requires": { "harness": ">= 2026.10.09.1" }, "extra": 1 }', /clave.*extra|extra/],
    ['{ "schema": 1, "name": "equipo" }', /requires/],
    ['{ "schema": 1, "name": "equipo", "requires": { "harness": ">= 2026.10.10.1" } }', /2026\.10\.10\.1/],
    ['{ "schema": 1, "name": "equipo", "requires": { "harness": "^2026.10.09.1" } }', />= YYYY\.MM\.DD\.N/],
    ['{ "schema": 1, "name": "equipo", "requires": { "harness": "2026.10.09.1" } }', />= YYYY\.MM\.DD\.N/],
    ['{ "schema": 1, "name": "equipo con espacios y ñ", "requires": { "harness": ">= 2026.10.09.1" } }', /name/],
    ['{ "schema": 1, "name": "' + 'a'.repeat(41) + '", "requires": { "harness": ">= 2026.10.09.1" } }', /name/],
    ['{ "schema": 2, "name": "equipo", "requires": { "harness": ">= 2026.10.09.1" } }', /schema/],
    ['[1]', /objeto/],
  ];
  for (const [text, re] of cases) {
    const r = TEAM.validateDeclaration(text, V);
    assert.equal(r.ok, false, `tendría que rechazarse: ${text}`);
    assert.match(r.reason, re, `motivo de ${text}: ${r.reason}`);
  }
});

test('T6u Team_ProfileValidatedWithReaderOfTree_TempDir_NoProfileVar_PersonalAndForbiddenKeysRefused', () => {
  const home = casa('perfil');
  const env = { TYCON_PROFILE: path.join(home, 'otro-perfil.json') };   // la variable del laboratorio NO desvía la lectura
  fs.writeFileSync(env.TYCON_PROFILE, '{ "integrations": { "engram": false } }\n');
  const sane = JSON.stringify({ ado: { org: 'https://dev.azure.com/acme' }, integrations: { engram: true, nightly: true }, update: { channel: 'latest', apply: 'auto' }, packs: { default: 'all' }, install: { profile: 'full' } });
  const ok = TEAM.validateProfile(sane, { readerTree: ROOT, home, env });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(ok.entries.some((e) => e.ruta === 'integraciones.engram' && e.valor === true), 'lee lo que el candidato declara, no la variable');
  assert.equal(fs.readdirSync(home).filter((n) => n !== 'otro-perfil.json').length, 0, 'no deja nada en la HOME');
  const bad = [
    ['{ "integrations": { "engram": true }, "telegram": { "chat_id": "123456789" } }', /chat_id|personal/],
    // (por el NOMBRE de la clave; el valor no tiene forma de token a propósito: el detector de la publicación lo contaría como secreto)
    ['{ "integrations": { "engram": true }, "github": { "token": "un-valor-cualquiera" } }', /token|personal|secreto/],
    ['{ "integrations": { "engram": true }, "inventada": { "x": 1 } }', /inventada|desconocid/],
    ['{ "integrations": { "engram": true }, "update": { "source": "internal" } }', /update\.source/],
    ['{ "integrations": { "engram": true }, "update": { "skills_source": "unified" } }', /update\.skills_source/],
    ['{ "integrations": { "engram": true }, "install": { "home": "tycon" } }', /install\.home/],
    ['{ roto', /ilegible|JSON/],
  ];
  for (const [text, re] of bad) {
    const r = TEAM.validateProfile(text, { readerTree: ROOT, home, env });
    assert.equal(r.ok, false, `tendría que rechazarse: ${text}`);
    assert.match(r.reason, re, `motivo de ${text}: ${r.reason}`);
  }
  // un árbol sin lector (una versión que no sabe leer el perfil solo) es un rechazo dicho, no una excepción
  const old = casa('viejo');
  const r = TEAM.validateProfile(sane, { readerTree: old, home, env });
  assert.equal(r.ok, false);
  assert.match(r.reason, /lector/);
});

test('T6v Team_TeamReposInTheClosedList_ValidatedWithReaderOfTree — dónde vive cada repo viaja en la capa, validado por la versión que va a quedar', () => {
  // story 8.26, tanda J: sin esta ruta en la lista cerrada, una capa con team-repos.json se rechazaba ENTERA en cada máquina
  assert.equal(TEAM.layerPathProblem(TEAM.TEAM_REPOS_PATH), null, 'team-repos.json entra en la capa');
  assert.equal(TEAM.isContentChecked(TEAM.TEAM_REPOS_PATH), true, 'y se juzga por su contenido antes de escribir nada');
  const repo = (r) => ({ platform: 'azure', org: 'acme', project: 'Main', repo: r });
  const sane = JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' }, profile: repo('profile'), operations: repo('ops') });
  assert.deepEqual(TEAM.validateTeamRepos(sane, { readerTree: ROOT }), { ok: true });
  const bad = TEAM.validateTeamRepos(JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' }, profile: repo('profile'), owners: ['x'] }), { readerTree: ROOT });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /operations · falta/, 'el motivo nombra la clave');
  assert.match(bad.reason, /owners · la lista de responsables no va acá/, 'y la lista de responsables no entra en la capa');
  assert.match(TEAM.validateTeamRepos('{ roto', { readerTree: ROOT }).reason, /el archivo/);
  // una versión que no trae el lector no lo puede validar: rechazo dicho, no una excepción
  const old = casa('sin-lector-de-repos');
  const r = TEAM.validateTeamRepos(sane, { readerTree: old });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no trae su lector/);
});

test('T6w Team_DeferReaders_ProfileAndTeamReposLeftForTheVersionThatStays — sin la versión que va a quedar, los lectores no juzgan: se difieren y se dicen', () => {
  // la mudanza de un clon viejo (sin scripts/lib/team-repos.js): juzgar con los lectores del clon frenaba una capa válida.
  // Con deferReaders, el perfil y team-repos.json NO se juzgan con readerTree y vuelven nombrados en readersDeferred; todo
  // lo demás (la declaración) se sigue juzgando
  const repo = (r) => ({ platform: 'github', org: 'acme', repo: r });
  const files = {
    'team-layer.json': JSON.stringify({ schema: 1, name: 'equipo', requires: { harness: '>= 2026.10.01.1' } }),
    'perfil-equipo.json': JSON.stringify({ install: { profile: 'full' } }),
    'team-repos.json': JSON.stringify({ version: 1, public: repo('arnes'), profile: repo('perfil'), operations: repo('operaciones') }),
  };
  const plan = { declaration: { sha: null }, files: [{ path: 'perfil-equipo.json', sha: null }, { path: 'team-repos.json', sha: null }] };
  const read = (p) => ({ ok: true, buf: Buffer.from(files[p], 'utf8') });
  const old = casa('clon-sin-lectores');   // un árbol sin ninguno de los dos lectores, como el clon viejo
  const opts = { head: 'capa de prueba', version: '2026.10.09.1', commit: 'c'.repeat(40), home: casa('home-6w'), env: {} };
  const judged = TEAM.judgeContent(plan, read, Object.assign({}, opts, { readerTree: old }));
  assert.equal(judged.ok, false, 'sin diferir, el árbol sin lector rechaza la capa (lo de antes: la mudanza no arrancaba)');
  assert.match(judged.reason, /lector/);
  const deferred = TEAM.judgeContent(plan, read, Object.assign({}, opts, { readerTree: null, deferReaders: true }));
  assert.equal(deferred.ok, true, `difiriendo, la capa pasa lo que no depende de los lectores: ${deferred.reason}`);
  assert.deepEqual(deferred.readersDeferred, ['perfil-equipo.json', 'team-repos.json'], 'y nombra los dos archivos que quedan por juzgar');
  assert.equal(deferred.profileEntries, null, 'el perfil no se leyó: no hay entradas que dar por buenas');
  TEAM.dropStaged(deferred.dir);
  // la declaración se sigue juzgando aunque se difieran los lectores
  const tooNew = Object.assign({}, files, { 'team-layer.json': JSON.stringify({ schema: 1, name: 'equipo', requires: { harness: '>= 2099.01.01.1' } }) });
  const r = TEAM.judgeContent(plan, (p) => ({ ok: true, buf: Buffer.from(tooNew[p], 'utf8') }), Object.assign({}, opts, { readerTree: null, deferReaders: true }));
  assert.equal(r.ok, false, 'una declaración que pide una versión posterior sigue frenando');
  // y juzgado con los lectores de una versión que los trae (este árbol), no difiere nada
  const full = TEAM.judgeContent(plan, read, Object.assign({}, opts, { readerTree: ROOT }));
  assert.equal(full.ok, true, `con los lectores de la versión: ${full.reason}`);
  assert.deepEqual(full.readersDeferred, []);
  TEAM.dropStaged(full.dir);
});

// tanda A1b (T10 en unidad; revisión adversarial C1, C2, W5, W7, W8, W9): el refresco en el lugar como transacción, sobre
// carpetas temporales y sin red; y la copia de lo editado que hace `uninstall`
test('T10u RefreshInPlace_Transaction_EditedKept_RemovedOnlyClosedAndIntact_PublicNeverTouched_KeepEditedNeverThrows', () => {
  const GH = require(path.join(ROOT, 'scripts', 'lib', 'git-tree-hash.js'));
  const b = (s) => GH.blobSha(Buffer.from(s));
  assert.equal(TEAM.blobOf(Buffer.from('hola\n')), b('hola\n'), 'el blob de team.js (sin scripts/lib/) es el de git');
  const lab = casa('refresh');
  const harness = path.join(lab, 'harness');
  fs.mkdirSync(path.join(harness, 'scripts', 'metrics'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(harness, 'scripts', 'lib'), { recursive: true });
  const P0 = '{ "integrations": { "engram": true } }\n', P1 = '{ "integrations": { "engram": true, "nightly": true } }\n';
  const K0 = '{ "cuenta": "x" }\n', K1 = '{ "cuenta": "y" }\n';
  // el manifiesto público de la versión instalada trae version.json: el refresco no lo toca aunque el manifiesto de la capa lo nombre
  fs.writeFileSync(path.join(harness, 'version.json'), '{ "version": "2026.10.09.1" }\n');
  fs.writeFileSync(path.join(harness, '.tycon-release.json'), JSON.stringify({ version: '2026.10.09.1', files: [{ path: 'version.json', blob: b('{ "version": "2026.10.09.1" }\n') }] }));
  const install = (perfil, llave) => {
    fs.writeFileSync(path.join(harness, 'perfil-equipo.json'), perfil);
    if (llave !== null) fs.writeFileSync(path.join(harness, 'scripts', 'metrics', 'corridas-buzon.json'), llave);
    const files = [{ path: 'perfil-equipo.json', mode: '100644', blob: b(P0) }, { path: 'scripts/metrics/corridas-buzon.json', mode: '100644', blob: b(K0) }, { path: 'version.json', mode: '100644', blob: b('{ "version": "2026.10.09.1" }\n') }];
    fs.writeFileSync(path.join(harness, TEAM.MANIFEST_NAME), JSON.stringify({ schema: 1, repo: 'acme/equipo', ref: 'main', commit: SHA(1), tree: SHA(2), name: 'e', requires: '2026.10.01.1', files }));
  };
  const fetched = (files) => {
    const cacheDir = fs.mkdtempSync(path.join(lab, 'cache-'));
    for (const [p, t] of files) { fs.mkdirSync(path.dirname(path.join(cacheDir, p)), { recursive: true }); fs.writeFileSync(path.join(cacheDir, p), t); }
    return { cacheDir, files: files.map(([p, t]) => ({ path: p, mode: '100644', blob: b(t) })), resolved: { repo: 'acme/equipo', host: 'github', ref: 'main', commit: SHA(3), tree: SHA(4), etag: null, declaration: { name: 'e', requires: '2026.10.01.1' } } };
  };
  // (1) sano: el perfil nuevo entra, la llave que ya no viene se borra (tenía su blob), version.json NUNCA (no es de la lista cerrada)
  install(P0, K0);
  let r = TEAM.refreshInPlace(fetched([['perfil-equipo.json', P1]]), harness, { home: lab, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(harness, 'perfil-equipo.json'), 'utf8'), P1);
  assert.equal(fs.existsSync(path.join(harness, 'scripts', 'metrics', 'corridas-buzon.json')), false, 'lo que ya no viene, borrado');
  assert.equal(fs.existsSync(path.join(harness, 'version.json')), true, 'una ruta pública nombrada en el manifiesto local no se borra');
  assert.equal(TEAM.readTeamManifest(harness).commit, SHA(3), 'el manifiesto nuevo');
  assert.deepEqual(fs.readdirSync(harness).filter((n) => n.startsWith('.tycon-team.tmp-')), [], 'sin temporales');
  // (2) editado a mano: no se pisa; uno editado que ya no viene: no se borra y queda en `kept`
  install('{ "a": 1 }\n', '{ "editada": 1 }\n');
  r = TEAM.refreshInPlace(fetched([['perfil-equipo.json', P1]]), harness, { home: lab, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.kept, ['perfil-equipo.json']); assert.deepEqual(r.keptRemoved, ['scripts/metrics/corridas-buzon.json']);
  assert.equal(fs.readFileSync(path.join(harness, 'perfil-equipo.json'), 'utf8'), '{ "a": 1 }\n');
  assert.deepEqual(TEAM.readTeamManifest(harness).kept, ['scripts/metrics/corridas-buzon.json']);
  assert.ok(TEAM.layerPaths(harness).includes('scripts/metrics/corridas-buzon.json'), 'lo conservado no cuenta «de más»');
  // (3) tras un corte (manifiesto viejo con el archivo YA nuevo): el blob del commit nuevo es «bien puesto», no «editado»
  install(P1, K0);
  r = TEAM.refreshInPlace(fetched([['perfil-equipo.json', P1], ['scripts/metrics/corridas-buzon.json', K1]]), harness, { home: lab, env: {} });
  assert.equal(r.ok, true); assert.deepEqual(r.kept, []);
  assert.equal(fs.readFileSync(path.join(harness, 'scripts', 'metrics', 'corridas-buzon.json'), 'utf8'), K1);
  // (4) transacción: el segundo archivo no se puede reemplazar (un directorio en su lugar) → el primero vuelve, el manifiesto no cambia
  install(P0, null);
  fs.rmSync(path.join(harness, 'scripts', 'metrics', 'corridas-buzon.json'), { force: true });
  fs.mkdirSync(path.join(harness, 'scripts', 'metrics', 'corridas-buzon.json', 'tapon'), { recursive: true });
  const before = fs.readFileSync(path.join(harness, TEAM.MANIFEST_NAME), 'utf8');
  r = TEAM.refreshInPlace(fetched([['perfil-equipo.json', P1], ['scripts/metrics/corridas-buzon.json', K1]]), harness, { home: lab, env: {} });
  assert.equal(r.ok, false); assert.match(r.reason, /no pude reemplazar.*corridas-buzon\.json/);
  assert.equal(fs.readFileSync(path.join(harness, 'perfil-equipo.json'), 'utf8'), P0, 'lo ya cambiado se repuso');
  assert.equal(fs.readFileSync(path.join(harness, TEAM.MANIFEST_NAME), 'utf8'), before, 'el manifiesto no cambió');
  assert.deepEqual(fs.readdirSync(harness).filter((n) => n.startsWith('.tycon-team.tmp-')), [], 'sin temporales');
  fs.rmSync(path.join(harness, 'scripts', 'metrics', 'corridas-buzon.json'), { recursive: true, force: true });
  // (5) un manifiesto con una entrada sin forma es «sin capa» (W5): nunca tira
  fs.writeFileSync(path.join(harness, TEAM.MANIFEST_NAME), JSON.stringify({ schema: 1, repo: 'acme/equipo', commit: SHA(1), files: [null] }));
  assert.equal(TEAM.readTeamManifest(harness), null);
  assert.deepEqual(TEAM.layerPaths(harness), []);
  // (6) keepEdited: la misma ruta editada en dos árboles no se pisa; una ruta fuera de la lista no se copia; nunca tira
  install('{ "editado": "harness" }\n', K0);
  const prev = path.join(lab, 'previous'); fs.mkdirSync(prev);
  fs.writeFileSync(path.join(prev, 'perfil-equipo.json'), '{ "editado": "previous" }\n');
  fs.writeFileSync(path.join(prev, TEAM.MANIFEST_NAME), JSON.stringify({ schema: 1, repo: 'acme/equipo', commit: SHA(1), files: [{ path: 'perfil-equipo.json', blob: b(P0) }, { path: '../fuera.json', blob: b('x') }] }));
  const keepRoot = path.join(lab, 'team');
  const k = TEAM.keepEdited([['harness', harness], ['previous', prev], ['nada', path.join(lab, 'no-existe')]], keepRoot, { now: new Date('2026-10-09T08:09:10Z') });
  assert.equal(k.ok, true, JSON.stringify(k));
  assert.match(path.basename(k.dir), /^kept-20261009-080910$/, 'sin «:» en el nombre (Windows)');
  assert.equal(fs.readFileSync(path.join(k.dir, 'harness', 'perfil-equipo.json'), 'utf8'), '{ "editado": "harness" }\n');
  assert.equal(fs.readFileSync(path.join(k.dir, 'previous', 'perfil-equipo.json'), 'utf8'), '{ "editado": "previous" }\n');
  assert.deepEqual(k.copied.sort(), ['harness/perfil-equipo.json', 'previous/perfil-equipo.json']);
  const k2 = TEAM.keepEdited([['harness', harness]], keepRoot, { now: new Date('2026-10-09T08:09:10Z') });
  assert.notEqual(k2.dir, k.dir, 'una segunda copia en el mismo segundo no pisa la primera');
  assert.equal(TEAM.keepEdited([['harness', path.join(lab, 'no-existe')]], keepRoot).copied.length, 0, 'sin capa: nada');

  // (7 · pase adversarial FP-1) un refresco que murió entre los renames y el manifiesto: el archivo YA es del commit B y el
  // manifiesto dice A. Con el pendiente, ni doctor ni uninstall lo llaman «editado», y si la punta pasa a C, el refresco lo pisa
  // (no queda en `kept` para siempre)
  const K2 = '{ "cuenta": "z" }\n';
  install(P0, K1);   // la llave ya es la de B; el manifiesto (A) dice K0
  fs.writeFileSync(path.join(harness, TEAM.PENDING_NAME), JSON.stringify({ schema: 1, commit: SHA(5), files: [{ path: 'scripts/metrics/corridas-buzon.json', blob: b(K1) }] }));
  const st7 = TEAM.teamStatus(harness);
  assert.deepEqual(st7.edited, [], 'a medio refrescar no es «editado»'); assert.deepEqual(st7.halfDone, ['scripts/metrics/corridas-buzon.json']);
  const k7 = TEAM.keepEdited([['harness', harness]], path.join(lab, 'team7'));
  assert.deepEqual(k7.copied, [], 'uninstall no lo conserva como edición');
  r = TEAM.refreshInPlace(fetched([['perfil-equipo.json', P0], ['scripts/metrics/corridas-buzon.json', K2]]), harness, { home: lab, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(r.kept, [], 'la punta C pisa el archivo a medio refrescar');
  assert.equal(fs.readFileSync(path.join(harness, 'scripts', 'metrics', 'corridas-buzon.json'), 'utf8'), K2);
  assert.equal(fs.existsSync(path.join(harness, TEAM.PENDING_NAME)), false, 'el pendiente se borra con el manifiesto');

  // (8 · pase adversarial S-1) lo que doctor no ve: `kept` del manifiesto local sólo cuenta si es de la lista cerrada, y el
  // prefijo de los temporales sólo vale para ARCHIVOS al lado de un destino de la capa
  fs.writeFileSync(path.join(harness, TEAM.MANIFEST_NAME), JSON.stringify({ schema: 1, repo: 'acme/equipo', commit: SHA(1), files: [{ path: 'version.json', blob: b('x') }], kept: ['scripts'] }));
  assert.deepEqual(TEAM.layerPaths(harness), [TEAM.MANIFEST_NAME], 'ni «scripts» ni version.json se esconden');
  assert.equal(TEAM.isLayerTemp(`${TEAM.TMP_PREFIX}perfil-equipo.json-1-a`), true);
  assert.equal(TEAM.isLayerTemp(`scripts/metrics/${TEAM.TMP_PREFIX}x`), true);
  assert.equal(TEAM.isLayerTemp(`scripts/setup/${TEAM.TMP_PREFIX}x/harness.js`), false, 'ni en otra carpeta ni adentro de una carpeta con el prefijo');
  assert.equal(TEAM.isLayerTemp(`scripts/setup/${TEAM.TMP_PREFIX}x`), false);
  // el refresco borra sólo ARCHIVOS temporales: una carpeta con el prefijo no se toca (y doctor la ve)
  install(P0, K0);
  fs.mkdirSync(path.join(harness, `${TEAM.TMP_PREFIX}carpeta`)); fs.writeFileSync(path.join(harness, `${TEAM.TMP_PREFIX}carpeta`, 'x.js'), 'x');
  fs.writeFileSync(path.join(harness, `${TEAM.TMP_PREFIX}perfil-equipo.json-1-a`), 'resto de un corte');
  assert.equal(TEAM.refreshInPlace(fetched([['perfil-equipo.json', P1]]), harness, { home: lab, env: {} }).ok, true);
  assert.equal(fs.existsSync(path.join(harness, `${TEAM.TMP_PREFIX}carpeta`, 'x.js')), true, 'la carpeta con el prefijo sigue');
  assert.equal(fs.existsSync(path.join(harness, `${TEAM.TMP_PREFIX}perfil-equipo.json-1-a`)), false, 'el temporal de un corte se borró');
  // un pendiente ilegible: teamStatus lo dice (no lo calla como «sin pendiente»)
  fs.writeFileSync(path.join(harness, TEAM.PENDING_NAME), '{ roto');
  assert.equal(TEAM.teamStatus(harness).pendingCorrupt, true);
});

// ── tanda A2a · los revisores y las skills del equipo ─────────────────────────────────────────────────────────────────────
//   T17 · la lista cerrada por patrón (paquete, agentes, skills de una a tres carpetas, sólo `.md` bajo skills/ y agents/), la
//         regla del conjunto (cada archivo de skills/ con su SKILL.md; nada dentro de una skill de la versión ni de terceros;
//         rutas iguales sin caja), `hooks:` en un frontmatter, los topes, y la función contra team-layer-paths.json.
//   T18 · los nombres: entre sí (frontmatter = archivo o carpeta) y contra la versión que va a quedar (sin caja ni acentos;
//         un revisor del núcleo; la capa vieja no cuenta).
//   (y las unidades que T19/T26 usan: validateTree de packs.js y checkAgainstVersion de team.js)

const PACKS = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'packs.js'));
const A2 = [
  blob('packs/equipo-juguete/pack.json', 300), dir('packs'), dir('packs/equipo-juguete'),
  blob('agents/rev-base.md', 200), blob('agents/rev-cond.md', 200),
  blob('skills/sola/SKILL.md', 100), blob('skills/sola/references/uno.md', 100),
  blob('skills/infra-juguete/red/SKILL.md', 100),
  blob('skills/projects/cliente-x/arquitectura/SKILL.md', 100), blob('skills/projects/cliente-x/arquitectura/references/a.md', 100),
];
const A2_SANE = [...SANE, ...A2];

test('T17 Team_ClosedPatterns_A2a_PacksAgentsNestedSkillsMdOnly_NoSkillInsidePublicOrThirdParty_CaseFolded_HooksFrontmatterRefused', () => {
  const ok = TEAM.planTeam(A2_SANE, { publicPaths: ['skills/tycon-pipeline/SKILL.md', 'agents/tycon-core.md'], thirdPartyRoots: ['skills/tercera'] });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(ok.files.length, 2 + A2.filter((e) => e.type === 'blob').length);
  // una ruta por causa, cada una sola sobre la capa sana: rechazo entero, la ruta nombrada con su motivo
  const one = (extra, opts = {}) => { const r = TEAM.planTeam([...A2_SANE, ...extra], opts); assert.equal(r.ok, false, `tendría que rechazar ${JSON.stringify(extra.map((e) => e.path))}`); assert.deepEqual(r.files, []); return r; };
  const cases = [
    ['scripts/x.js', /lista cerrada/], ['commands/x.md', /lista cerrada/], ['adapters/codex/agents/rev-base.toml', /lista cerrada/],
    ['.githooks/pre-commit', /lista cerrada/], ['build/x.js', /lista cerrada/], ['packs/equipo-juguete/cases.js', /lista cerrada/],
    ['packs/equipo-juguete/notas.md', /lista cerrada/], ['skills/sola/run.sh', /lista cerrada/], ['skills/sola/x.json', /lista cerrada/],
    ['skills/huerfana/notas.md', /SKILL\.md/], ['skills/a/b/c/d/SKILL.md', /SKILL\.md|carpetas/],
  ];
  for (const [p, why] of cases) {
    const r = one([blob(p, 10)]);
    const hit = r.problems.find((x) => x.path === p);
    assert.ok(hit, `${p} tendría que estar nombrada: ${JSON.stringify(r.problems)}`);
    assert.match(hit.reason, why, `${p}: ${hit.reason}`);
  }
  // una skill de la capa dentro de una skill del árbol, en una carpeta que la versión ya trae, o dentro de una de terceros
  let r = one([blob('skills/tycon-pipeline/extra/SKILL.md', 10)], { publicPaths: ['skills/tycon-pipeline/SKILL.md'] });
  assert.match(r.problems.find((x) => x.path === 'skills/tycon-pipeline/extra/SKILL.md').reason, /versión|pública/);
  r = one([blob('skills/pub/SKILL.md', 10)], { publicPaths: ['skills/pub/README.md'] });
  assert.match(r.problems.find((x) => x.path === 'skills/pub/SKILL.md').reason, /versión|pública/);
  r = one([blob('skills/tercera/extra/SKILL.md', 10)], { thirdPartyRoots: ['skills/tercera'] });
  assert.match(r.problems.find((x) => x.path === 'skills/tercera/extra/SKILL.md').reason, /terceros/);
  // sin caja: contra la versión (en Mac y Windows `Pub2` cae sobre `pub2`) y entre rutas de la propia capa
  r = one([blob('skills/Pub2/SKILL.md', 10)], { publicPaths: ['skills/pub2/SKILL.md'] });
  assert.ok(r.problems.some((x) => x.path === 'skills/Pub2/SKILL.md'), JSON.stringify(r.problems));
  r = one([blob('agents/Rev-Base.md', 10)]);
  assert.ok(r.problems.some((x) => /agents\/Rev-Base\.md|agents\/rev-base\.md/.test(x.path) && /caja|mayúsculas/.test(x.reason)), JSON.stringify(r.problems));
  // una skill de la capa dentro de otra skill de la capa: un SKILL.md con otro arriba
  r = one([blob('skills/sola/sub/SKILL.md', 10)]);
  assert.ok(r.problems.some((x) => x.path === 'skills/sola/sub/SKILL.md' && /SKILL\.md/.test(x.reason)), JSON.stringify(r.problems));
  // el tope de 300 archivos (además del de bytes)
  const many = Array.from({ length: 300 }, (_, i) => blob(`skills/sola/references/r${i}.md`, 1));
  r = one(many);
  assert.ok(r.problems.some((x) => /300 archivos/.test(x.reason)), JSON.stringify(r.problems.slice(-2)));
  // `hooks:` en el frontmatter de un agente o de un SKILL.md: Claude Code los corre (momento 1, sobre lo bajado)
  const lab = casa('t17');
  const put = (p, txt) => { const f = path.join(lab, ...p.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
  put('agents/rev-base.md', '---\nname: rev-base\ndescription: x\nhooks:\n  PreToolUse: []\n---\ncuerpo\n');
  put('skills/sola/SKILL.md', '---\nname: sola\ndescription: x\n---\n');
  const cp = TEAM.contentProblems(lab, [{ path: 'agents/rev-base.md' }, { path: 'skills/sola/SKILL.md' }]);
  assert.ok(cp.some((x) => x.path === 'agents/rev-base.md' && /hooks/.test(x.reason)), JSON.stringify(cp));
  assert.equal(cp.length, 1, JSON.stringify(cp));
  // la función de pertenencia contra la copia que leen las personas (team-layer-paths.json: exactas + expresiones regulares)
  assert.ok(Array.isArray(FIXTURE.patterns) && FIXTURE.patterns.length >= 3, 'team-layer-paths.json trae los patrones');
  // (story 8.26, H1c · AC 66) el texto del alta: la copia trae su patrón y muestras de los dos lados
  assert.ok(FIXTURE.patterns.some((re) => new RegExp(re).test('onboarding/step-0-mac.md')), 'la copia trae el patrón del texto del alta');
  assert.ok(FIXTURE.samples.in.includes('onboarding/step-0-mac.md'), 'una muestra del alta adentro');
  for (const sample of ['onboarding/mini-class/charla.md', 'onboarding/mini-class/index.html', 'onboarding/x.sh', 'onboarding/x.json', 'onboarding/sub/x.md', 'Onboarding/x.md']) assert.ok(FIXTURE.samples.out.includes(sample), `la copia muestra ${sample} afuera`);
  for (const sample of FIXTURE.samples.in) assert.equal(TEAM.layerPathProblem(sample), null, `${sample} entra`);
  for (const sample of FIXTURE.samples.out) assert.notEqual(TEAM.layerPathProblem(sample), null, `${sample} no entra`);
  for (const sample of [...FIXTURE.samples.in, ...FIXTURE.samples.out]) {
    const byFixture = FIXTURE.paths.includes(sample) || FIXTURE.patterns.some((re) => new RegExp(re).test(sample));
    assert.equal(byFixture, TEAM.layerPathProblem(sample) === null, `la copia y el programa no coinciden en ${sample}`);
  }
  assert.equal(TEAM.MAX_FILES, FIXTURE.max_files);
  // los temporales del refresco al lado de un archivo de la capa (también en una skill anidada), y en ningún otro lado
  assert.equal(TEAM.isLayerTemp(`skills/projects/cliente-x/arquitectura/references/${TEAM.TMP_PREFIX}a.md-1-a`), true);
  assert.equal(TEAM.isLayerTemp(`agents/${TEAM.TMP_PREFIX}rev.md-1-a`), true);
  assert.equal(TEAM.isLayerTemp(`scripts/setup/${TEAM.TMP_PREFIX}x`), false);
});

// ── story 8.25, tanda A2c · T31: la lista fija de skills con algo más que texto ───────────────────────────────────────
const EXTRAS_FILE = path.join(ROOT, 'scripts', 'setup', 'harness', 'team-skill-extras.json');
const EXTRAS = JSON.parse(fs.readFileSync(EXTRAS_FILE, 'utf8'));

test('T31 Team_FixedSkillList_FolderWhitelistAndDataFiles_ProcessesCustomPilotsTestsScriptsConfigRefused_Mode100644Only_NotDeclarableByLayer_MaxThreeEntries_PerEntryBudget_RetireDateOnlyWarns', () => {
  // la lista de la versión: como máximo 3 entradas, hoy una, con todo lo que el AC 31 pide
  assert.deepEqual(TEAM.validateExtras(EXTRAS), [], 'la lista de la versión se valida sola');
  assert.equal(EXTRAS.entries.length, 1);
  const E = EXTRAS.entries[0];
  assert.equal(E.skill, 'skills/bizuit-sdd');
  for (const k of ['reason', 'review', 'folders', 'data', 'maxBytes', 'dataHome', 'legacyData']) assert.ok(E[k] !== undefined, `la entrada trae ${k}`);
  assert.equal(TEAM.loadExtras().ok, true);
  // una cuarta entrada hace fallar la lista (y una sin motivo, también)
  const four = { ...EXTRAS, entries: ['a', 'b', 'c', 'd'].map((n) => ({ ...E, skill: `skills/${n}` })) };
  assert.ok(TEAM.validateExtras(four).some((x) => /3/.test(x)), JSON.stringify(TEAM.validateExtras(four)));
  assert.ok(TEAM.validateExtras({ ...EXTRAS, entries: [{ ...E, reason: '' }] }).length > 0);
  // la skill sana: sus .md en las carpetas admitidas y sus dos archivos de datos
  const S = 'skills/bizuit-sdd';
  const sane = [blob(`${S}/SKILL.md`, 100), blob(`${S}/CHANGELOG.md`, 100), blob(`${S}/docs/guia.md`, 100), blob(`${S}/rules/a/b/c.md`, 100),
    blob(`${S}/rules/custom/README.md`, 100), blob(`${S}/templates/t.md`, 100), blob(`${S}/workflows/w.md`, 100), blob(`${S}/VERSION`, 6), blob(`${S}/templates/shared-styles.css`, 100)];
  const base = [...SANE, ...sane];
  const ok = TEAM.planTeam(base);
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(ok.files.length, 2 + sane.length);
  // cada rechazo nombra su ruta y su motivo (×10 por ruta; la declaración y la lista de cuatro, arriba y abajo)
  const refused = [`${S}/scripts/install-skill.sh`, `${S}/tests/x.md`, `${S}/.gitignore`, `${S}/.bizuit-config.yaml`, `${S}/dist/x.zip`,
    `${S}/processes/x/spec.md`, `${S}/rules/custom/cliente.md`, `${S}/docs/pilots/x.md`];
  for (const p of refused) {
    const r = TEAM.planTeam([...base, blob(p, 10)]);
    assert.equal(r.ok, false, `${p} tendría que rechazar la capa`);
    assert.deepEqual(r.files, []);
    const hit = r.problems.find((x) => x.path === p);
    assert.ok(hit && /lista fija|bizuit-sdd/.test(hit.reason), `${p}: ${JSON.stringify(r.problems)}`);
  }
  // el archivo de datos con modo ejecutable, y el mismo archivo de datos en una skill que no está en la lista
  let r = TEAM.planTeam([...SANE, ...sane.filter((e) => e.path !== `${S}/VERSION`), blob(`${S}/VERSION`, 6, '100755')]);
  assert.ok(r.problems.some((x) => x.path === `${S}/VERSION` && /100755/.test(x.reason)), JSON.stringify(r.problems));
  r = TEAM.planTeam([...base, blob('skills/otra/SKILL.md', 10), blob('skills/otra/VERSION', 6)]);
  assert.ok(r.problems.some((x) => x.path === 'skills/otra/VERSION'), JSON.stringify(r.problems));
  // la capa no puede pedir una excepción: team-layer.json no gana claves
  assert.equal(TEAM.validateDeclaration('{ "schema": 1, "name": "equipo", "requires": { "harness": ">= 2026.10.01.1" }, "extras": ["skills/otra"] }', '2026.10.09.1').ok, false);
  // el presupuesto por entrada: 0,9 MB de la skill más 0,9 MB del resto entran; la skill pasada de su maxBytes, no
  const big = (n) => Math.round(n * 1024 * 1024);
  r = TEAM.planTeam([...base, blob(`${S}/docs/grande.md`, big(0.9)), blob('skills/sola/SKILL.md', 10), blob('skills/sola/grande.md', big(0.9))]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  r = TEAM.planTeam([...base, blob(`${S}/docs/grande.md`, E.maxBytes + 1)]);
  assert.ok(r.problems.some((x) => /bizuit-sdd/.test(x.path + x.reason) && /maxBytes|presupuesto/.test(x.reason)), JSON.stringify(r.problems));
  // y el resto de la capa sigue con su tope (2 MB) sin contar la skill de la lista
  r = TEAM.planTeam([...base, blob('skills/sola/SKILL.md', 10), blob('skills/sola/grande.md', big(2.1))]);
  assert.ok(r.problems.some((x) => /MB en total/.test(x.reason)), JSON.stringify(r.problems));
  // la revisión es informativa: vencida no rechaza nada, sólo se dice
  assert.equal(TEAM.extrasReviewDue(E, new Date('2099-01-01')), true);
  assert.equal(TEAM.extrasReviewDue(E, new Date('2000-01-01')), false);
  assert.equal(TEAM.planTeam(base).ok, true);
  // la casa de los datos de la entrada es la que dice el texto de la skill
  const home = path.join(os.tmpdir(), 'casa-juguete');
  const dh = TEAM.dataHomeOf(E, { home, env: {} });
  assert.equal(dh.file, path.join(home, E.dataHome.dir, E.dataHome.file));
  // 🔴 el texto de la skill sólo está en el clon interno: `skills/bizuit-sdd` no viaja en la copia pública (la trae la capa
  // del equipo). Allá este cruce no se mide, y se dice; antes la prueba entera daba rojo sobre la copia por leer ese archivo.
  const authFile = path.join(ROOT, S, 'rules', 'bizuit', 'common', 'api-auth.md');
  if (fs.existsSync(path.join(ROOT, S, 'SKILL.md'))) {
    const auth = fs.readFileSync(authFile, 'utf8');
    assert.ok(auth.includes(`~/${E.dataHome.dir}/${E.dataHome.file}`), 'api-auth.md nombra la misma casa');
    assert.ok(auth.includes(E.dataHome.env), 'api-auth.md nombra la misma variable');
  } else {
    console.log(`⏭ T31: NO MEDIDO — ${S} no está en este árbol (la copia pública): el cruce con su api-auth.md se mide en el clon interno`);
  }
  // la variable: absoluta la cambia; relativa se ignora y se dice
  const abs = path.join(os.tmpdir(), 'otra-casa');
  assert.equal(TEAM.dataHomeOf(E, { home, env: { [E.dataHome.env]: abs } }).file, path.join(abs, E.dataHome.file));
  const rel = TEAM.dataHomeOf(E, { home, env: { [E.dataHome.env]: 'relativa' } });
  assert.equal(rel.file, dh.file);
  assert.match(rel.ignored, /absoluta/);
  // la copia que leen las personas (team-layer-paths.json) nombra la lista y sus ejemplos coinciden con el programa
  assert.equal(FIXTURE.extras_file, 'scripts/setup/harness/team-skill-extras.json');
  for (const s of FIXTURE.extras_samples.in) assert.equal(TEAM.layerPathProblem(s), null, `${s} entra`);
  for (const s of FIXTURE.extras_samples.out) assert.notEqual(TEAM.layerPathProblem(s), null, `${s} no entra`);
});

// ── tanda A2c · AC 35 (la parte unitaria de T35): la conexión vieja llega a la casa nueva, una vez, sin pisar ni mostrarse ──
test('A2c MoveSkillData_FixedOrder_OncePerSkill_NeverOverwrites_RegularUnder64K_SensitiveKeySaid_ContentNeverShown_DryRunWritesNothing', () => {
  const E = EXTRAS.entries[0];
  const SUB = E.skill.slice('skills/'.length);
  const OLD = E.legacyData[0];
  const SENT = 'CENTINELA-que-no-se-muestra-7f3a';
  const lab = casa('a2c-move');
  const home = path.join(lab, 'home');
  const env = { TYCON_HOME: path.join(home, '.tycon') };
  const put = (f, txt) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
  const own = path.join(home, '.claude', 'skills', SUB, OLD);
  const aside = path.join(home, '.claude', `agent-skills.before-migrate-20261001-000000-1-1`, E.skill, OLD);
  const asideNew = path.join(home, '.claude', `agent-skills.before-migrate-20261005-000000-1-1`, E.skill, OLD);
  const clone = path.join(lab, 'clon', E.skill, OLD);
  const prev = path.join(home, '.tycon', 'previous', E.skill, OLD);
  const layerPaths = [`${E.skill}/SKILL.md`];
  const body = (n) => `environments:\n  active: dev\n  dev:\n    url: https://bpm.example.test/${n}\n    user: ${SENT}\n`;
  const run = (team, extra = {}) => TEAM.moveSkillData({ home, env, team, layerPaths, migrateHome: { from: path.join(lab, 'clon') }, previousDir: path.join(home, '.tycon', 'previous'), ...extra });
  const dest = TEAM.dataHomeOf(E, { home, env }).file;
  const shown = (r, team) => [...r.lines, JSON.stringify(team)].join('\n');
  // el orden fijo: la carpeta propia gana; después la apartada más nueva, la vieja, el clon y previous/ —los demás se nombran—
  put(own, body('propia')); put(aside, body('apartada-vieja')); put(asideNew, body('apartada-nueva')); put(clone, body('clon')); put(prev, body('previous'));
  let team = {};
  let r = run(team, { dryRun: true });
  assert.equal(fs.existsSync(dest), false, '--dry-run no escribe');
  assert.ok(r.lines.some((l) => l.includes(own) && l.includes(dest)), r.lines.join('\n'));
  assert.equal(team.data_moved, undefined, '--dry-run no registra');
  r = run(team);
  assert.equal(fs.readFileSync(dest, 'utf8'), body('propia'), 'byte a byte, desde la carpeta propia');
  if (process.platform !== 'win32') { assert.equal(fs.statSync(dest).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(dest)).mode & 0o777, 0o700); }
  assert.ok(fs.existsSync(own), 'el original queda');
  const others = r.lines.join('\n');
  for (const f of [asideNew, aside, clone, prev]) assert.ok(others.includes(f), `nombra ${f}: ${others}`);
  assert.ok(others.indexOf(asideNew) < others.indexOf(aside), 'la apartada más nueva primero');
  assert.equal(team.data_moved[SUB].from, own);
  assert.ok(!shown(r, team).includes(SENT), 'el contenido no aparece en la salida ni en el estado');
  // una vez por skill: la segunda corrida no copia ni dice nada, aunque la casa se haya borrado
  fs.rmSync(dest);
  r = run(team);
  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(r.lines, []);
  // nunca se pisa: con la casa ya escrita y distinta, gana la casa y se dice una vez
  team = {};
  put(dest, 'environments: {}\n');
  r = run(team);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'environments: {}\n');
  assert.ok(r.lines.some((l) => /gana la casa nueva/.test(l)), r.lines.join('\n'));
  fs.rmSync(dest);
  // un enlace no se sigue; uno de 100 KB no se copia; los dos se dicen
  for (const f of [aside, asideNew, clone, prev]) fs.rmSync(f);
  fs.rmSync(own);
  if (process.platform !== 'win32') {
    fs.symlinkSync(put(path.join(lab, 'otro.yaml'), body('enlace')), own);
    team = {}; r = run(team);
    assert.equal(fs.existsSync(dest), false); assert.ok(r.lines.some((l) => /enlace/.test(l)), r.lines.join('\n'));
    fs.rmSync(own);
  }
  put(own, `${body('grande')}${'#'.repeat(100 * 1024)}\n`);
  team = {}; r = run(team);
  assert.equal(fs.existsSync(dest), false); assert.ok(r.lines.some((l) => /64 KB/.test(l)), r.lines.join('\n'));
  // una clave sensible de primer nivel: se copia y se dice, sin el valor
  put(own, `password: ${SENT}\n${body('sensible')}`);
  team = {}; r = run(team);
  assert.ok(fs.existsSync(dest)); assert.ok(r.lines.some((l) => /clave sensible/.test(l)), r.lines.join('\n'));
  assert.ok(!shown(r, team).includes(SENT));
  fs.rmSync(dest);
  // la casa que no se puede escribir: se dice, no queda nada escrito y no se registra (la próxima vez se intenta)
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    const blocked = path.join(lab, 'bloqueada'); fs.mkdirSync(blocked, { mode: 0o500 });
    team = {}; r = run(team, { env: { ...env, [E.dataHome.env]: path.join(blocked, 'casa') } });
    assert.ok(r.lines.some((l) => /no pude/.test(l)), r.lines.join('\n'));
    assert.equal(fs.existsSync(path.join(blocked, 'casa')), false);
    assert.equal(team.data_moved, undefined);
    fs.chmodSync(blocked, 0o700);
  }
  // la variable relativa se ignora y se dice; una capa sin la skill de la lista no hace nada
  team = {}; r = run(team, { env: { ...env, [E.dataHome.env]: 'relativa' } });
  assert.ok(r.lines.some((l) => /no es una ruta absoluta/.test(l)), r.lines.join('\n'));
  assert.deepEqual(run({}, { layerPaths: ['skills/sola/SKILL.md'] }).lines, []);
  // stateEntry conserva lo mudado al reemplazar la capa del estado
  const st = TEAM.stateEntry({ repo: 'acme/equipo', commit: SHA(1), files: [] }, { data_moved: { [SUB]: { at: 'x', from: own } } });
  assert.deepEqual(st.data_moved, { [SUB]: { at: 'x', from: own } });
  fs.rmSync(lab, { recursive: true, force: true });
});

// ── tanda A2c · lo que sumaron los revisores (vuelta 1): nada se calla, kept- no sigue enlaces y queda sólo para el usuario ──
test('A2c Review_UnreadableIsSaid_KeptStraysNoLinksUserOnlyBudget_CompareFailureSaid_HomeLineIsWarn', { skip: process.platform === 'win32' && 'los permisos que se niegan a leer se miden en posix' }, () => {
  const E = EXTRAS.entries[0];
  const SUB = E.skill.slice('skills/'.length);
  const lab = casa('a2c-review');
  const home = path.join(lab, 'home');
  const env = { TYCON_HOME: path.join(home, '.tycon') };
  const tree = path.join(home, '.tycon', 'harness');
  const put = (f, txt) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
  const skillMdTxt = '---\nname: bizuit-sdd\ndescription: de juguete\n---\n';
  put(path.join(tree, E.skill, 'SKILL.md'), skillMdTxt);
  put(path.join(tree, E.skill, 'VERSION'), '2.0.0\n');
  fs.writeFileSync(path.join(tree, '.tycon-release.json'), JSON.stringify({ schema: 1, version: '2026.10.09.1', files: [] }));
  fs.writeFileSync(path.join(tree, TEAM.MANIFEST_NAME), JSON.stringify({ schema: 1, repo: 'acme/equipo', commit: SHA(7), files: [
    { path: `${E.skill}/SKILL.md`, mode: '100644', blob: TEAM.blobOf(Buffer.from(skillMdTxt)) }, { path: `${E.skill}/VERSION`, mode: '100644', blob: TEAM.blobOf(Buffer.from('2.0.0\n')) }] }));
  // los casos con permisos que niegan leer sólo se miden sin root (root lee igual)
  const notRoot = !(process.getuid && process.getuid() === 0);
  try {
    // (1) lo ajeno: un enlace no se sigue, lo que pasa del presupuesto no se lee, lo copiado queda 0600/0700, y ese árbol no se quita
    put(path.join(lab, 'llave-ajena'), 'una llave que no es de la skill\n');
    fs.symlinkSync(path.join(lab, 'llave-ajena'), path.join(tree, E.skill, E.legacyData[0]));
    put(path.join(tree, E.skill, 'processes', 'x', 'spec.md'), '# una spec escrita acá por error\n');
    let k = TEAM.keepEdited([['previous', tree]], path.join(home, '.tycon', 'team'), { edited: false, foreign: true });
    assert.deepEqual(k.copied, [`previous/${E.skill}/processes/x/spec.md`]);
    assert.ok(k.problems.some((p) => p.includes(E.legacyData[0]) && /enlace/.test(p)), JSON.stringify(k.problems));
    assert.deepEqual(k.failedTrees, ['previous']);
    const keptFile = path.join(k.dir, 'previous', E.skill, 'processes', 'x', 'spec.md');
    assert.equal(fs.statSync(keptFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(k.dir).mode & 0o777, 0o700);
    assert.ok(!fs.readdirSync(path.join(k.dir, 'previous', E.skill)).includes(E.legacyData[0]), 'el contenido del enlace no se copió');
    fs.rmSync(path.join(tree, E.skill, E.legacyData[0]));
    fs.writeFileSync(path.join(tree, E.skill, 'processes', 'x', 'spec.md'), Buffer.alloc(E.maxBytes + 1, 0x23));
    k = TEAM.keepEdited([['previous', tree]], path.join(home, '.tycon', 'team'), { edited: false, foreign: true });
    assert.ok(k.problems.some((p) => /presupuesto/.test(p)), JSON.stringify(k.problems));
    fs.rmSync(path.join(tree, E.skill, 'processes'), { recursive: true });
    // (2) una carpeta de la skill que no se puede listar: no es «nada ajeno» — keepEdited no quita ese árbol y doctor lo dice
    if (notRoot) {
      const locked = path.join(tree, E.skill, 'cerrada');
      fs.mkdirSync(locked); fs.writeFileSync(path.join(locked, 'spec.md'), '# x\n'); fs.chmodSync(locked, 0o000);
      try {
        k = TEAM.keepEdited([['previous', tree]], path.join(home, '.tycon', 'team'), { edited: false, foreign: true });
        assert.ok(k.problems.some((p) => /cerrada/.test(p) && /no se pudo listar/.test(p)), JSON.stringify(k.problems));
        assert.deepEqual(k.failedTrees, ['previous']);
        const doc = TEAM.skillDataDoctor({ home, env, tree });
        assert.ok(doc.items.some((i) => i.level === 'warn' && /cerrada/.test(i.text) && /no se pudo listar/.test(i.text)), JSON.stringify(doc.items));
      } finally { fs.chmodSync(locked, 0o755); fs.rmSync(locked, { recursive: true }); }
      // (3) una conexión vieja que está y no se puede mirar: se dice («no pude mirar»), no se calla como «no está»
      const ownDir = path.join(home, '.claude', 'skills', SUB);
      put(path.join(ownDir, E.legacyData[0]), 'environments: {}\n');
      fs.chmodSync(ownDir, 0o000);
      try {
        const team = {};
        const r = TEAM.moveSkillData({ home, env, team, harnessDir: tree });
        assert.ok(r.lines.some((l) => /no pude mirar/.test(l)), JSON.stringify(r.lines));
        assert.equal(team.data_moved, undefined, 'no se registra: la próxima vuelve a mirar');
      } finally { fs.chmodSync(ownDir, 0o755); }
      // (4) la casa nueva que no se puede leer para comparar: no se afirma que difieren
      const dest = TEAM.dataHomeOf(E, { home, env }).file;
      put(dest, 'environments: {}\n'); fs.chmodSync(dest, 0o000);
      try {
        const r = TEAM.moveSkillData({ home, env, team: {}, harnessDir: tree });
        assert.ok(r.lines.some((l) => /no pude compararla/.test(l)), JSON.stringify(r.lines));
        assert.ok(!r.lines.some((l) => /es distinta/.test(l)), JSON.stringify(r.lines));
      } finally { fs.chmodSync(dest, 0o600); }
    }
    // (5) la casa resuelta se dice con `warn` (AC 36), nunca `fail`
    const doc = TEAM.skillDataDoctor({ home, env, tree });
    assert.ok(doc.items.some((i) => i.level === 'warn' && /la casa de sus datos es/.test(i.text)), JSON.stringify(doc.items));
    assert.ok(doc.items.every((i) => i.level !== 'fail'));
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

// ── tanda A2c · lo que confirmó el pase adversarial (opus): cada clase con la prueba que la reproduce ─────────────────────
test('A2c Adversarial_CaseFoldedWhitelist_WindowsSafeCharsAndDepth_RealDates_BomSensitive_KeptOnlyWithLayer_UnsafeStrayNamesSaid', () => {
  const E = EXTRAS.entries[0];
  const S = E.skill;
  // (1) la lista blanca sin caja: una carpeta excluida escrita con otra caja sigue excluida (en Mac y Windows es la misma)
  for (const p of [`${S}/rules/Custom/cliente.md`, `${S}/docs/Pilots/piloto.md`, `${S}/RULES/custom/x.md`, `${S}/docs/pilots /a.md`, `Skills/Bizuit-SDD/rules/Custom/x.md`]) {
    assert.notEqual(TEAM.layerPathProblem(p), null, `${p} no entra`);
  }
  // …y una ruta admitida con otra caja también se reconoce como de su carpeta y sus datos
  assert.equal(TEAM.layerPathProblem(`${S}/Docs/guia.md`), null);
  assert.equal(TEAM.layerPathProblem(`${S}/Templates/Shared-Styles.css`), null);
  // (7) el juego de caracteres y la profundidad de las demás skills: lo que Windows no puede escribir no entra
  for (const p of [`${S}/docs/a?b.md`, `${S}/docs/a<b>.md`, `${S}/docs/a|b.md`, `${S}/docs/a"b.md`, `${S}/docs/a*b.md`, `${S}/docs/x\ny.md`, `${S}/docs/ñ.md`, `${S}/docs/a/b/c/d/e/f/g/h.md`]) {
    assert.notEqual(TEAM.layerPathProblem(p), null, `${JSON.stringify(p)} no entra`);
  }
  // (5) una fecha de revisión imposible no pasa la lista (si no, el aviso de doctor quedaría apagado para siempre)
  for (const next of ['2027-13-45', '0000-00-00', '2027-02-30']) {
    assert.ok(TEAM.validateExtras({ ...EXTRAS, entries: [{ ...E, review: { every_months: 3, next } }] }).some((x) => /review/.test(x)), next);
  }
  assert.deepEqual(TEAM.validateExtras(EXTRAS), []);
  // (6) la clave sensible se avisa también con BOM
  const lab = casa('a2c-adv');
  try {
    const home = path.join(lab, 'home');
    const env = { TYCON_HOME: path.join(home, '.tycon') };
    const own = path.join(home, '.claude', 'skills', S.slice('skills/'.length), E.legacyData[0]);
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, '﻿password: x\nurl: y\n');
    const r = TEAM.moveSkillData({ home, env, team: {}, layerPaths: [`${S}/SKILL.md`] });
    assert.ok(r.lines.some((l) => /clave sensible/.test(l)), JSON.stringify(r.lines));
    // (8) un árbol SIN capa del equipo: kept- no recorre la skill (AC 16: sin team, nada nuevo)
    const tree = path.join(home, '.tycon', 'harness');
    fs.mkdirSync(path.join(tree, S, 'processes', 'x'), { recursive: true });
    fs.writeFileSync(path.join(tree, '.tycon-release.json'), JSON.stringify({ schema: 1, version: '2026.10.09.1', files: [] }));
    fs.writeFileSync(path.join(tree, S, 'processes', 'x', 'spec.md'), '# vieja\n');
    let k = TEAM.keepEdited([['harness', tree]], path.join(home, '.tycon', 'team'), { foreign: true });
    assert.deepEqual([k.copied, k.problems, k.failedTrees, k.dir], [[], [], [], null], 'sin capa no se guarda ni se frena nada');
    // (2) con la capa: un ajeno con «:» o «\» en el nombre (válidos en Mac y Linux) no se saltea callado
    const skillMdTxt = '---\nname: bizuit-sdd\ndescription: de juguete\n---\n';
    fs.writeFileSync(path.join(tree, S, 'SKILL.md'), skillMdTxt);
    fs.writeFileSync(path.join(tree, TEAM.MANIFEST_NAME), JSON.stringify({ schema: 1, repo: 'acme/equipo', commit: SHA(9), files: [{ path: `${S}/SKILL.md`, mode: '100644', blob: TEAM.blobOf(Buffer.from(skillMdTxt)) }] }));
    if (process.platform !== 'win32') {
      fs.writeFileSync(path.join(tree, S, 'processes', 'x', 'notas 10:00.md'), '# con dos puntos\n');
      k = TEAM.keepEdited([['harness', tree]], path.join(home, '.tycon', 'team'), { foreign: true });
      assert.ok(k.copied.includes(`harness/${S}/processes/x/spec.md`), JSON.stringify(k));
      assert.ok(k.problems.some((p) => p.includes('notas 10:00.md')), JSON.stringify(k.problems));
      assert.deepEqual(k.failedTrees, ['harness'], 'ese árbol no se quita');
    }
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

// (revisores, vuelta 2) una lista fija que no se lee no se calla en la mudanza: lo dice y no registra nada
test('A2c Review2_BrokenFixedListIsSaidByTheMove_NothingRecorded', () => {
  const lab = casa('a2c-broken-list');
  try {
    // una copia de la carpeta del programa con la lista rota (el módulo lee la lista de SU carpeta)
    const prog = path.join(lab, 'harness');
    fs.cpSync(path.join(ROOT, 'scripts', 'setup', 'harness'), prog, { recursive: true });
    fs.writeFileSync(path.join(prog, 'team-skill-extras.json'), '{ roto');
    const T2 = require(path.join(prog, 'team.js'));
    assert.equal(T2.loadExtras().ok, false);
    const team = {};
    const r = T2.moveSkillData({ home: path.join(lab, 'home'), env: { TYCON_HOME: path.join(lab, 'home', '.tycon') }, team, layerPaths: ['skills/bizuit-sdd/SKILL.md'] });
    assert.ok(r.lines.some((l) => /lista fija/.test(l) && /no se revisó/.test(l)), JSON.stringify(r.lines));
    assert.equal(team.data_moved, undefined);
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

/** Una versión de juguete en disco: `.tycon-release.json` con su lista, los agentes y paquetes que nombra, y las skills de terceros. */
function toyVersion(lab, { agents = [], skills = [], packs = {}, thirdParty = [] } = {}) {
  const v = path.join(lab, 'version');
  const files = [];
  const put = (p, txt) => { const f = path.join(v, ...p.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); files.push({ path: p, blob: TEAM.blobOf(Buffer.from(txt)) }); };
  for (const a of agents) put(`agents/${a}.md`, `---\nname: ${a}\ndescription: núcleo\n---\n`);
  for (const s of skills) put(`skills/${s}/SKILL.md`, `---\nname: ${path.posix.basename(s)}\ndescription: pública\n---\n`);
  for (const [n, revs] of Object.entries(packs)) put(`packs/${n}/pack.json`, JSON.stringify({ name: n, description: 'paquete público de juguete', reviewers: revs.map((r) => ({ agent: r, group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: ['PUB'] })) }));
  put('scripts/publishing/third-party-skills.json', JSON.stringify({ thirdParty: thirdParty.map((t) => ({ target: t, install: 'download', commit: SHA(9) })) }));
  // el cargador de paquetes de ESTA versión (el del árbol bajo prueba), en su lugar
  const lib = path.join(v, 'skills', 'tycon-pipeline', 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib'))) if (f.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', f), path.join(lib, f));
  fs.writeFileSync(path.join(v, '.tycon-release.json'), JSON.stringify({ schema: 1, version: '2026.10.09.9', files }));
  return v;
}
/** Una capa bajada de juguete: los archivos en una carpeta y su lista `{ path, blob }`. */
function toyLayer(lab, entries) {
  const d = path.join(lab, 'layer');
  const files = [];
  for (const [p, txt] of entries) { const f = path.join(d, ...p.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); files.push({ path: p, mode: '100644', blob: TEAM.blobOf(Buffer.from(txt)) }); }
  return { dir: d, files };
}
const agentMd = (name) => `---\nname: ${name}\ndescription: revisor del equipo de juguete\n---\nRevisa cosas.\n`;
const skillMd = (name) => `---\nname: ${name}\ndescription: skill del equipo de juguete\n---\n`;
const reviewerOf = (agent, group) => ({ agent, group, when: { detection: 'codeModified' }, surface: { paths: ['**/*.ts'] }, depth: 'standard', prefixes: ['JUG'] });
const packJson = (name, revs) => JSON.stringify({ name, description: 'paquete del equipo de juguete', reviewers: revs.map(([agent, group]) => reviewerOf(agent, group)) });

test('T18 Team_Names_FrontmatterMatchesFileAndFolder_NoCollisionWithVersionToStayOrCore_FoldedCaseAccents_SameAgentRefreshDoesNotCollide', () => {
  const lab = casa('t18');
  // entre sí: el name: del agente con su archivo, el de SKILL.md con su carpeta, el de pack.json con la suya
  const bad = toyLayer(lab, [
    ['agents/rev-a.md', agentMd('otro-nombre')],
    ['skills/sola/SKILL.md', skillMd('no-sola')],
    ['packs/equipo-juguete/pack.json', packJson('otro-paquete', [['rev-a', 'base']])],
  ]);
  const cp = TEAM.contentProblems(bad.dir, bad.files);
  for (const p of ['agents/rev-a.md', 'skills/sola/SKILL.md', 'packs/equipo-juguete/pack.json']) assert.ok(cp.some((x) => x.path === p && /name|nombre/.test(x.reason)), `${p}: ${JSON.stringify(cp)}`);
  // contra la versión que va a quedar: un revisor del núcleo, un agente que difiere sólo en la caja, una skill sólo en un acento
  fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true });
  const v = toyVersion(lab, { agents: ['tycon-core', 'Revisor-Publico'], skills: ['diseño'] });
  const clash = toyLayer(lab, [
    ['agents/tycon-core.md', agentMd('tycon-core')],
    ['agents/revisor-publico.md', agentMd('revisor-publico')],
    ['skills/diseno/SKILL.md', skillMd('diseno')],
  ]);
  const r = TEAM.checkAgainstVersion(clash.dir, clash.files, v, { env: {} });
  assert.equal(r.ok, false);
  for (const p of ['agents/tycon-core.md', 'agents/revisor-publico.md', 'skills/diseno/SKILL.md']) assert.ok(r.problems.some((x) => x.path === p), `${p} tendría que chocar: ${JSON.stringify(r.problems)}`);
  // el refresco del MISMO agente: la capa vieja está en el árbol instalado pero no en su lista pública → no choca consigo misma
  const installed = toyVersion(path.join(lab, 'inst'), { agents: ['tycon-core'] });
  fs.writeFileSync(path.join(installed, 'agents', 'rev-equipo.md'), agentMd('rev-equipo'));   // la capa vieja, fuera de la lista
  fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true });
  const same = toyLayer(lab, [['agents/rev-equipo.md', agentMd('rev-equipo')]]);
  const r2 = TEAM.checkAgainstVersion(same.dir, same.files, installed, { env: {} });
  assert.equal(r2.ok, true, JSON.stringify(r2.problems));
});

// ── story 8.41 · AC 46 (T41): la capa trae un paquete ENTERO en texto — su manifiesto y los .md de sus skills/, agents/ y
//    guides/ — y vale igual que uno de la versión; lo que no es texto, o está fuera de esas carpetas, rechaza la capa ──────
test('T41 TeamLayer_WholePack_StackedAndLinked', () => {
  const whole = [
    blob('packs/eq/pack.json', 300), blob('packs/eq/skills/s-eq/SKILL.md', 100), blob('packs/eq/skills/s-eq/references/a.md', 50),
    blob('packs/eq/agents/rev-eq.md', 100), blob('packs/eq/guides/guia.md', 100), blob('packs/eq/guides/sub/otra.md', 100),
  ];
  const ok = TEAM.planTeam([...SANE, ...whole], { publicPaths: ['skills/tycon-pipeline/SKILL.md'] });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  for (const [p, why] of [
    ['packs/eq/skills/s-eq/run.sh', /lista cerrada/], ['packs/eq/templates/run.sh', /lista cerrada/],
    ['packs/eq/agents/rev.json', /lista cerrada/], ['packs/eq/guides/x.js', /lista cerrada/],
    ['packs/eq/skills/huerfana/notas.md', /SKILL\.md/], ['packs/eq/agents/sub/rev.md', /lista cerrada/],
  ]) {
    const r = TEAM.planTeam([...SANE, ...whole, blob(p, 10)], {});
    assert.equal(r.ok, false, `tendría que rechazar ${p}`);
    const hit = r.problems.find((x) => x.path === p);
    assert.ok(hit && why.test(hit.reason), `${p}: ${JSON.stringify(r.problems)}`);
  }
  // los nombres de adentro del paquete se juzgan como los de agents/ y skills/ de la raíz
  const lab = casa('t41');
  const bad = toyLayer(lab, [['packs/eq/agents/rev-eq.md', agentMd('otro')], ['packs/eq/skills/s-eq/SKILL.md', `---\nname: s-eq\ndescription: x\nhooks:\n  Stop: []\n---\n`]]);
  const cp = TEAM.contentProblems(bad.dir, bad.files);
  assert.ok(cp.some((x) => x.path === 'packs/eq/agents/rev-eq.md' && /name/.test(x.reason)), JSON.stringify(cp));
  assert.ok(cp.some((x) => x.path === 'packs/eq/skills/s-eq/SKILL.md' && /hooks/.test(x.reason)), JSON.stringify(cp));
  // contra la versión: el paquete con sus agentes adentro lo valida el cargador de ESA versión; un nombre que choca, no pasa
  fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true });
  const v = toyVersion(lab, { agents: ['tycon-core', 'pub-rev'], skills: ['publica'], packs: { publico: ['pub-rev'] } });
  // un paquete de la versión con algo más que su manifiesto (plantillas, un README): eso no se lee como manifiesto
  // (el ensayo de actualización lo destapó: la capa entera se rechazaba)
  const rm = JSON.parse(fs.readFileSync(path.join(v, '.tycon-release.json'), 'utf8'));
  fs.mkdirSync(path.join(v, 'packs', 'publico', 'templates'), { recursive: true });
  fs.writeFileSync(path.join(v, 'packs', 'publico', 'templates', 'README.md'), '# plantillas\n');
  rm.files.push({ path: 'packs/publico/templates/README.md', blob: TEAM.blobOf(Buffer.from('# plantillas\n')) });
  fs.writeFileSync(path.join(v, '.tycon-release.json'), JSON.stringify(rm));
  const pack = JSON.stringify({ name: 'eq', description: 'paquete entero de juguete', skills: 'skills', agents: 'agents', reviewers: [reviewerOf('rev-eq', 'base')] });
  const sane = toyLayer(lab, [['packs/eq/pack.json', pack], ['packs/eq/agents/rev-eq.md', agentMd('rev-eq')], ['packs/eq/skills/s-eq/SKILL.md', skillMd('s-eq')], ['packs/eq/guides/guia.md', '# guía\n']]);
  const r = TEAM.checkAgainstVersion(sane.dir, sane.files, v, { env: {} });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(TEAM.contentProblems(sane.dir, sane.files), []);
  fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true });
  const clash = toyLayer(lab, [['packs/eq/pack.json', pack.replace('rev-eq', 'tycon-core')], ['packs/eq/agents/tycon-core.md', agentMd('tycon-core')], ['packs/eq/skills/publica/SKILL.md', skillMd('publica')]]);
  const rc = TEAM.checkAgainstVersion(clash.dir, clash.files, v, { env: {} });
  assert.equal(rc.ok, false);
  assert.ok(rc.problems.some((x) => x.path === 'packs/eq/agents/tycon-core.md'), JSON.stringify(rc.problems));
  assert.ok(rc.problems.some((x) => x.path === 'packs/eq/skills/publica/SKILL.md'), JSON.stringify(rc.problems));
  // dentro de la misma capa, un agente o una skill con el mismo nombre en dos lugares (la raíz y un paquete, o dos
  // paquetes) se enlazarían en el mismo lugar de ~/.claude: la capa no pasa (pase adversarial, clase 6)
  fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true });
  const twice = toyLayer(lab, [['packs/eq/pack.json', pack], ['packs/eq/agents/rev-eq.md', agentMd('rev-eq')], ['agents/rev-eq.md', agentMd('rev-eq')], ['packs/eq/skills/s-eq/SKILL.md', skillMd('s-eq')], ['skills/s-eq/SKILL.md', skillMd('s-eq')]]);
  const rt = TEAM.checkAgainstVersion(twice.dir, twice.files, v, { env: {} });
  assert.equal(rt.ok, false);
  assert.ok(rt.problems.some((x) => /rev-eq/.test(`${x.path} ${x.reason}`) && /dos lugares|otra ruta de la capa/.test(x.reason)), JSON.stringify(rt.problems));
  assert.ok(rt.problems.some((x) => /s-eq/.test(`${x.path} ${x.reason}`) && /dos lugares|otra ruta de la capa/.test(x.reason)), JSON.stringify(rt.problems));
});

test('A2a validateTree_AndCheckAgainstVersion_PackLoaderOfVersion_EnvIgnored_NoValidateTreeSaid', () => {
  // packs.js: el contrato chico que el instalador carga de la versión que va a quedar
  assert.equal(typeof PACKS.validateTree, 'function');
  assert.ok(Array.isArray(PACKS.BANDERAS) && PACKS.BANDERAS.includes('codeModified'));
  const lab = casa('vt');
  const v = toyVersion(lab, { agents: ['tycon-core', 'pub-rev'], packs: { publico: ['pub-rev'] } });
  // una capa con un paquete que nombra un revisor que no existe: el cargador de la versión lo frena, nombrando paquete y revisor
  const broken = toyLayer(lab, [['packs/equipo-juguete/pack.json', packJson('equipo-juguete', [['rev-fantasma', 'base']])], ['agents/rev-a.md', agentMd('rev-a')]]);
  const saved = { P: process.env.TYCON_PACKS_DIR, A: process.env.TYCON_AGENTS_DIR };
  process.env.TYCON_PACKS_DIR = path.join(lab, 'vacia'); process.env.TYCON_AGENTS_DIR = path.join(lab, 'vacia');
  try {
    const r = TEAM.checkAgainstVersion(broken.dir, broken.files, v, { env: {} });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((x) => /equipo-juguete/.test(`${x.path} ${x.reason}`) && /rev-fantasma/.test(x.reason)), JSON.stringify(r.problems));
    // sana: el paquete con su revisor
    fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true });
    const sane = toyLayer(lab, [['packs/equipo-juguete/pack.json', packJson('equipo-juguete', [['rev-a', 'base']])], ['agents/rev-a.md', agentMd('rev-a')]]);
    const ok = TEAM.checkAgainstVersion(sane.dir, sane.files, v, { env: {} });
    assert.equal(ok.ok, true, JSON.stringify(ok.problems));
    // directo: validateTree con carpetas explícitas no lee las variables
    const errs = PACKS.validateTree({ packsDir: path.join(v, 'packs'), agentsDir: path.join(v, 'agents'), nucleo: ['tycon-core'] });
    assert.deepEqual(errs, []);
  } finally {
    if (saved.P === undefined) delete process.env.TYCON_PACKS_DIR; else process.env.TYCON_PACKS_DIR = saved.P;
    if (saved.A === undefined) delete process.env.TYCON_AGENTS_DIR; else process.env.TYCON_AGENTS_DIR = saved.A;
  }
  // una versión sin validateTree (anterior a la A2a) no acepta una capa con paquetes, y lo dice
  fs.writeFileSync(path.join(v, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'packs.js'), "'use strict';\nmodule.exports = { cargarPaquetes() { return []; } };\n");
  fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true });
  const withPack = toyLayer(lab, [['packs/equipo-juguete/pack.json', packJson('equipo-juguete', [['rev-a', 'base']])], ['agents/rev-a.md', agentMd('rev-a')]]);
  const old = TEAM.checkAgainstVersion(withPack.dir, withPack.files, v, { env: {} });
  assert.equal(old.ok, false);
  assert.ok(old.problems.some((x) => /validar paquetes|validateTree/.test(x.reason)), JSON.stringify(old.problems));
  // …y una capa SIN paquetes no necesita el cargador
  fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true });
  const noPack = toyLayer(lab, [['skills/sola/SKILL.md', skillMd('sola')]]);
  assert.equal(TEAM.checkAgainstVersion(noPack.dir, noPack.files, v, { env: {} }).ok, true);
});

test('A2a Review_HooksAnyForm_McpServers_TrailingDotAndReservedNames_ThirdPartyUnreadableSaid_PruneEmptyDirsNested', () => {
  // (revisor de seguridad) lo que Claude Code ejecuta desde un frontmatter, escrito de cualquier forma
  const lab = casa('rev');
  const cases = {
    'agents/a1.md': '---\nname: a1\n"hooks":\n  PreToolUse: []\n---\n',
    'agents/a2.md': "---\nname: a2\n'hooks' :\n  x: 1\n---\n",
    'agents/a3.md': '---\nname: a3\nhooks : []\n---\n',
    'agents/a4.md': '---\nname: a4\nmcpServers:\n  x:\n    command: "algo"\n---\n',
    'agents/a6.md': '---\nname: a6\nHooks: []\n---\n',
  };
  for (const [p, txt] of Object.entries(cases)) { const f = path.join(lab, ...p.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); }
  const cp = TEAM.contentProblems(lab, Object.keys(cases).map((p) => ({ path: p })));
  for (const p of Object.keys(cases)) assert.ok(cp.some((x) => x.path === p && /hooks|mcpServers/i.test(x.reason)), `${p}: ${JSON.stringify(cp)}`);
  // (pase adversarial, clases 4, 8, 10, 11) el frontmatter leído como YAML en lo que importa: lo que está DENTRO de un valor
  // no es una clave, el comentario no es parte del nombre, el cierre admite espacios; un name repetido o escondido en un texto
  // de varias líneas no engaña al chequeo de nombres
  const fmCase = (name, txt) => { const f = path.join(lab, 'agents', `${name}.md`); fs.writeFileSync(f, txt); return TEAM.contentProblems(lab, [{ path: `agents/${name}.md` }]); };
  assert.deepEqual(fmCase('sano', '---\nname: sano\ndescription: revisa hooks de git\n---\nLos hooks: se revisan.\n'), [], 'la palabra en el cuerpo no cuenta');
  assert.deepEqual(fmCase('anidado', '---\nname: anidado\nmeta: { hooks: [] }\nextra:\n  hooks: []\n---\n'), [], 'una clave anidada no es la de primer nivel que corre Claude Code');
  assert.deepEqual(fmCase('bloque', '---\nname: bloque\ndescription: |\n  Cómo configurar los Hooks: de Claude Code.\n  mcpServers: se explica acá\n---\n'), [], 'un texto en bloque no es una clave');
  assert.deepEqual(fmCase('citado', '---\nname: citado\ndescription: "Explica la clave mcpServers: y hooks: en una línea"\n---\n'), [], 'un texto entre comillas no es una clave');
  assert.deepEqual(fmCase('coment', '---\nname: coment # el revisor de juguete\n---\n'), [], 'el comentario no es parte del nombre');
  assert.deepEqual(fmCase('cierre', '---\nname: cierre\n---   \ncuerpo\n'), [], 'el cierre con espacios al final vale');
  let bad = fmCase('foo', '---\nname: tycon-story-validator\ndescription: "a\nname: foo\nb"\n---\n');
  assert.ok(bad.some((x) => /tycon-story-validator/.test(x.reason)), `el name escondido en un texto de varias líneas no engaña: ${JSON.stringify(bad)}`);
  bad = fmCase('dos', '---\nname: dos\nname: otro\n---\n');
  assert.ok(bad.some((x) => /repite/.test(x.reason)), `un name repetido se rechaza: ${JSON.stringify(bad)}`);
  bad = fmCase('flujo', '---\n{ name: flujo, hooks: [] }\n---\n');
  assert.ok(bad.length > 0, 'un frontmatter en forma de flujo no se juzga ni se apila');
  // (revisor de seguridad, vuelta 2) lo que un lector de YAML vuelve clave de primer nivel sin que se vea: ancla, tag, escape,
  // clave compleja, fusión
  for (const [nm, body] of [['ancla', '&a hooks:\n  x: 1'], ['tag', '!!str hooks: []'], ['escape', '"\\x68ooks": []'], ['compleja', '? hooks\n: []'], ['fusion', 'x: &a\n  hooks: []\n<<: *a']]) {
    bad = fmCase(nm, `---\nname: ${nm}\n${body}\n---\n`);
    assert.ok(bad.some((x) => /complejas|anclas|no se juzga/.test(x.reason)), `${nm}: ${JSON.stringify(bad)}`);
  }
  // (cobertura, vuelta 2) las comillas con escape no esconden ni inventan una clave; CRLF y BOM se leen igual
  assert.deepEqual(fmCase('esc1', '---\nname: esc1\ndescription: "dice \\"hooks: x\\" y sigue"\n---\n'), [], 'un \\" dentro del valor no cierra la comilla');
  assert.deepEqual(fmCase('esc2', "---\nname: esc2\ndescription: 'it''s hooks: nada'\n---\n"), [], "un '' dentro de comillas simples no cierra");
  bad = fmCase('esc3', "---\nname: esc3\n'ho''oks': x\n'hooks': []\n---\n");
  assert.ok(bad.some((x) => /hooks/.test(x.reason)), `una clave entre comillas simples se lee: ${JSON.stringify(bad)}`);
  assert.deepEqual(fmCase('crlf', '﻿---\r\nname: crlf\r\ndescription: x\r\n---\r\ncuerpo\r\n'), [], 'CRLF y BOM');
  bad = fmCase('crlf2', '---\r\nname: crlf2\r\nhooks: []\r\n---\r\n');
  assert.ok(bad.some((x) => /hooks/.test(x.reason)), 'con CRLF también se ve hooks');
  // (revisor de seguridad, vuelta 3) un \r suelto es salto de línea para un lector de YAML: no se juzga
  for (const [nm, body] of [['cr1', 'description: x\rhooks: []'], ['cr2', '# c\rhooks: []'], ['cr3', '# nota hooks:\n  - command: x'], ['cr4', '# nota\u0085mcpServers: {}']]) {
    bad = fmCase(nm, `---\nname: ${nm}\n${body}\n---\n`);
    assert.ok(bad.some((x) => /no se juzga/.test(x.reason)), `${nm}: ${JSON.stringify(bad)}`);
  }
  // (a verificar aparte) un manifiesto de paquete con su clave vieja `nombre` vale, como lo acepta el cargador
  fs.mkdirSync(path.join(lab, 'packs', 'viejo'), { recursive: true });
  fs.writeFileSync(path.join(lab, 'packs', 'viejo', 'pack.json'), JSON.stringify({ nombre: 'viejo', descripcion: 'x', revisores: [] }));
  assert.deepEqual(TEAM.contentProblems(lab, [{ path: 'packs/viejo/pack.json' }]), []);
  // (pase adversarial, clase 7) el revisor del paquete y su agente con distinta caja: rechazado igual en cualquier disco
  const vv = toyVersion(path.join(lab, 'vv'), { agents: ['tycon-core'] });
  fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true });
  const caseL = toyLayer(lab, [['packs/eq/pack.json', packJson('eq', [['team-rev', 'base']])], ['agents/Team-Rev.md', agentMd('Team-Rev')]]);
  const rc = TEAM.checkAgainstVersion(caseL.dir, caseL.files, vv, { env: {} });
  assert.equal(rc.ok, false); assert.ok(rc.problems.some((x) => /caja/.test(x.reason)), JSON.stringify(rc.problems));
  // (fallos silenciosos, vuelta 2) un paquete PÚBLICO de la versión con sus claves viejas (`revisores`/`agente`): su agente no
  // es del núcleo, y una capa sana no choca falsamente con él
  const vOld = toyVersion(path.join(lab, 'vold'), { agents: ['tycon-core', 'pub-viejo'] });
  const oldPack = JSON.stringify({ nombre: 'publico', descripcion: 'público con claves viejas', revisores: [{ agente: 'pub-viejo', grupo: 'base', cuando: { deteccion: 'csModified' }, superficie: { paths: ['**/*.cs'] }, profundidad: 'standard', prefijos: ['PUB'] }] });
  fs.mkdirSync(path.join(vOld, 'packs', 'publico'), { recursive: true }); fs.writeFileSync(path.join(vOld, 'packs', 'publico', 'pack.json'), oldPack);
  const relmOld = JSON.parse(fs.readFileSync(path.join(vOld, '.tycon-release.json'), 'utf8')); relmOld.files.push({ path: 'packs/publico/pack.json', blob: TEAM.blobOf(Buffer.from(oldPack)) });
  fs.writeFileSync(path.join(vOld, '.tycon-release.json'), JSON.stringify(relmOld));
  fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true });
  const saneL = toyLayer(lab, [['packs/eq/pack.json', packJson('eq', [['rev-a', 'base']])], ['agents/rev-a.md', agentMd('rev-a')]]);
  const ro = TEAM.checkAgainstVersion(saneL.dir, saneL.files, vOld, { env: {} });
  assert.equal(ro.ok, true, `un paquete público con claves viejas no vuelve núcleo a su agente: ${JSON.stringify(ro.problems)}`);
  // (revisor de seguridad) un tramo con punto final o un nombre reservado de Windows pisaría otro archivo en ese disco
  for (const p of ['packs/clients./pack.json', 'agents/con.md', 'skills/aux/SKILL.md', 'skills/x./SKILL.md']) assert.notEqual(TEAM.layerPathProblem(p), null, `${p} no entra`);
  assert.equal(TEAM.layerPathProblem('agents/consola.md'), null, 'un nombre que sólo empieza como uno reservado entra');
  // (fallos silenciosos) un third-party-skills.json ilegible en la versión se dice; ausente, no
  const v = toyVersion(path.join(lab, 'v'), { agents: ['tycon-core'] });
  fs.writeFileSync(path.join(v, 'scripts', 'publishing', 'third-party-skills.json'), '{ roto');
  fs.mkdirSync(path.join(lab, 'L', 'skills', 'sola'), { recursive: true }); fs.writeFileSync(path.join(lab, 'L', 'skills', 'sola', 'SKILL.md'), skillMd('sola'));
  const r = TEAM.checkAgainstVersion(path.join(lab, 'L'), [{ path: 'skills/sola/SKILL.md' }], v, { env: {} });
  assert.equal(r.ok, false); assert.ok(r.problems.some((x) => /third-party-skills\.json/.test(x.reason)), JSON.stringify(r.problems));
  fs.mkdirSync(path.join(lab, 'L2', 'agents'), { recursive: true }); fs.writeFileSync(path.join(lab, 'L2', 'agents', 'rev-x.md'), agentMd('rev-x'));
  assert.equal(TEAM.checkAgainstVersion(path.join(lab, 'L2'), [{ path: 'agents/rev-x.md' }], v, { env: {} }).ok, true, 'una capa sin skills no depende de las skills de terceros');
  fs.rmSync(path.join(v, 'scripts', 'publishing', 'third-party-skills.json'));
  assert.equal(TEAM.checkAgainstVersion(path.join(lab, 'L'), [{ path: 'skills/sola/SKILL.md' }], v, { env: {} }).ok, true);
  // (cobertura) pruneEmptyDirs: sube varios niveles en una skill anidada y se para en una carpeta con otra skill o con un editado
  const h = path.join(lab, 'h');
  const mk = (p) => { const f = path.join(h, ...p.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
  mk('skills/projects/cli/otra/SKILL.md'); mk('skills/projects/cli2/conservada/notas.md');
  fs.mkdirSync(path.join(h, 'skills', 'projects', 'cli', 'sacada', 'references'), { recursive: true });
  fs.mkdirSync(path.join(h, 'skills', 'projects', 'solo', 'sacada2', 'references'), { recursive: true });
  TEAM.pruneEmptyDirs(h, ['skills/projects/cli/sacada/references/a.md', 'skills/projects/solo/sacada2/references/b.md', 'skills/projects/cli2/conservada/SKILL.md'], { files: [{ path: 'skills/publica/SKILL.md' }] });
  assert.equal(fs.existsSync(path.join(h, 'skills', 'projects', 'cli', 'sacada')), false, 'la skill anidada sacada no deja carpetas');
  assert.equal(fs.existsSync(path.join(h, 'skills', 'projects', 'cli', 'otra', 'SKILL.md')), true, 'la carpeta del cliente sigue: tiene otra skill');
  assert.equal(fs.existsSync(path.join(h, 'skills', 'projects', 'solo')), false, 'un cliente que se queda sin skills no deja su carpeta');
  assert.equal(fs.existsSync(path.join(h, 'skills', 'projects', 'cli2', 'conservada', 'notas.md')), true, 'una carpeta con un editado conservado se queda');
  assert.equal(fs.existsSync(path.join(h, 'skills')), true, 'skills/ nunca se borra');
  // (cobertura, vuelta 3) las ramas de error del disco, forzadas sin mocks: la temporal del momento 1 en una ruta que es un
  // archivo (TMPDIR apunta a un archivo) da un motivo, no un volcado
  const notDir = path.join(lab, 'no-es-carpeta'); fs.writeFileSync(notDir, 'x');
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = notDir;
  try {
    const jc = TEAM.judgeContent({ files: [], declaration: { sha: null } }, () => ({ ok: true, buf: null }), { head: 'capa de prueba', version: '2026.10.09.9' });
    assert.equal(jc.ok, false); assert.match(jc.reason, /carpeta temporal/);
  } finally { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; }
  // (fallos silenciosos, vuelta 3) uninstall: un archivo de la capa que está y no se puede leer no se saltea callado — su árbol
  // queda en failedTrees (no se quita) y el motivo en problems
  if (process.getuid && process.getuid() !== 0) {
    const t = path.join(lab, 'tree-ilegible');
    fs.mkdirSync(path.join(t, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(t, 'agents', 'rev.md'), agentMd('rev'));
    fs.writeFileSync(path.join(t, TEAM.MANIFEST_NAME), JSON.stringify({ schema: 1, repo: 'acme/equipo', commit: SHA(3), files: [{ path: 'agents/rev.md', blob: SHA(4) }] }));
    fs.chmodSync(path.join(t, 'agents', 'rev.md'), 0o000);
    try {
      const k = TEAM.keepEdited([['harness', t]], path.join(lab, 'kept-ilegible'));
      assert.deepEqual(k.failedTrees, ['harness'], JSON.stringify(k)); assert.ok(k.problems.some((x) => /agents\/rev\.md/.test(x)), JSON.stringify(k.problems));
    } finally { fs.chmodSync(path.join(t, 'agents', 'rev.md'), 0o644); }
  }
});

// ── story 8.26, tanda H1c · T80: el texto del alta del equipo viaja con la capa (AC 66) ────────────────────────────────────
// Los `.md` de la RAÍZ de onboarding/ —lo que un dev nuevo le pega al asistente— entran a la lista cerrada. La charla
// (onboarding/mini-class/, con HTML) y cualquier otra cosa bajo onboarding/ siguen afuera: una sola de esas rutas rechaza la
// capa ENTERA, como toda ruta fuera de la lista. Es lo que una máquina ACEPTA de un repo privado: un patrón, un nivel, sólo `.md`.
const T80 = 'T80 TeamOnboardingText_InTeamLayer_GettingStartedWithoutRepoPermission';
const TEAM_TEXT = '# El alta del equipo de juguete\n\nPegale este texto al asistente.\n';
/** Una capa ya bajada de juguete (la forma que devuelve `fetchTeam`): los archivos en una caché y lo resuelto, con el commit `n`. */
// ── story 8.41 · AC 49 (T44): las plantillas de un paquete viajan en la capa como datos — una lista cerrada de extensiones,
//    sin permiso de ejecución; lo que no es de la lista rechaza la capa entera nombrando la ruta ─────────────────────────
test('T44 TeamLayer_PackTemplates_ClosedExtensionsNoExec', () => {
  const pack = [blob('packs/eq/pack.json', 300), blob('packs/eq/agents/rev-eq.md', 100)];
  const templates = ['packs/eq/templates/README.md', 'packs/eq/templates/pipelines/ci.yml', 'packs/eq/templates/forms/advisors.yaml',
    'packs/eq/templates/forms/declared.json', 'packs/eq/templates/backend/coverlet.runsettings',
    'packs/eq/templates/backend/catalog.json.template', 'packs/eq/templates/stories/githooks-pre-commit.template',
    'packs/eq/templates/forms/CLAUDE.md.template', 'packs/eq/templates/common/AGENTS.md.template'];
  const ok = TEAM.planTeam([...SANE, ...pack, ...templates.map((p) => blob(p, 100))], {});
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  for (const p of templates) assert.ok(ok.files.some((f) => f.path === p), `${p} tendría que apilarse`);
  for (const [p, why] of [
    ['packs/eq/templates/stories/githooks-pre-commit', /lista cerrada/],   // sin extensión: el hook viaja como .template
    ['packs/eq/templates/run.sh', /lista cerrada/], ['packs/eq/templates/x.js', /lista cerrada/],
    ['packs/eq/templates/x.ps1', /lista cerrada/], ['packs/eq/templates/x.YML', /lista cerrada/],
    ['packs/eq/templates/a/b/c/d/e/f/g.yml', /lista cerrada/],             // la misma profundidad que las guías de un paquete
    ['packs/eq/plantillas/x.yml', /lista cerrada/],                        // sólo la carpeta templates/
    ['packs/eq/templates/forms/CLAUDE.md', /lista cerrada/],               // un asistente lo carga solo: viaja como CLAUDE.md.template
    ['packs/eq/templates/common/AGENTS.md', /lista cerrada/],
    ['packs/eq/templates/.claude/skills/s/SKILL.md', /lista cerrada/],   // un tramo con punto: un asistente lo descubre solo
    ['packs/eq/templates/.mcp.json', /lista cerrada/],
    ['packs/eq/templates/forms/.hidden.yml', /lista cerrada/],
    ['packs/eq/guides/CLAUDE.md', /lista cerrada/],                      // tampoco en las guías de un paquete
    ['packs/eq/guides/sub/agents.md', /lista cerrada/],
  ]) {
    const r = TEAM.planTeam([...SANE, ...pack, blob(p, 10)], {});
    assert.equal(r.ok, false, `tendría que rechazar ${p}`);
    assert.deepEqual(r.files, [], `${p}: con un rechazo no queda nada para apilar`);
    const hit = r.problems.find((x) => x.path === p);
    assert.ok(hit && why.test(hit.reason), `${p}: ${JSON.stringify(r.problems)}`);
  }
  // sin permiso de ejecución: el modo lo juzga la regla de toda la capa
  const exec = TEAM.planTeam([...SANE, ...pack, blob('packs/eq/templates/pipelines/ci.yml', 10, '100755')], {});
  assert.equal(exec.ok, false);
  assert.ok(exec.problems.some((x) => x.path === 'packs/eq/templates/pipelines/ci.yml' && /100644/.test(x.reason)), JSON.stringify(exec.problems));
  // el motivo dice qué sí entra en templates/
  assert.match(TEAM.layerPathProblem('packs/eq/templates/run.sh'), /templates/);
  // el tope de la capa entera es 2 MB (decisión 12): con los paquetes de un equipo, 1,5 MB entra; más de 2 MB no
  assert.equal(TEAM.MAX_TOTAL_BYTES, 2 * 1024 * 1024);
  const big = TEAM.planTeam([...SANE, ...pack, blob('packs/eq/templates/grande.yml', 1.5 * 1024 * 1024)], {});
  assert.equal(big.ok, true, JSON.stringify(big.problems));
  const over = TEAM.planTeam([...SANE, ...pack, blob('packs/eq/templates/grande.yml', 2 * 1024 * 1024)], {});
  assert.ok(over.problems.some((x) => x.path === '(total)' && /2 MB/.test(x.reason)), JSON.stringify(over.problems));
  // las plantillas no se juzgan como agente ni como skill (un .md de plantillas puede no tener frontmatter), y contra la versión pasan
  const lab = casa('t44');
  const v = toyVersion(lab, { agents: ['tycon-core'] });
  const packText = JSON.stringify({ name: 'eq', description: 'paquete con plantillas de juguete', agents: 'agents', reviewers: [reviewerOf('rev-eq', 'base')] });
  const layer = toyLayer(lab, [['packs/eq/pack.json', packText], ['packs/eq/agents/rev-eq.md', agentMd('rev-eq')],
    ['packs/eq/templates/README.md', '# plantillas\n'], ['packs/eq/templates/pipelines/ci.yml', 'trigger: none\n']]);
  assert.deepEqual(TEAM.contentProblems(layer.dir, layer.files), []);
  const r = TEAM.checkAgainstVersion(layer.dir, layer.files, v, { env: {} });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

function toyFetched(lab, entries, n) {
  const cacheDir = fs.mkdtempSync(path.join(lab, 'cache-'));
  const files = entries.map(([p, txt]) => {
    const f = path.join(cacheDir, ...p.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, txt);
    return { path: p, mode: '100644', blob: TEAM.blobOf(Buffer.from(txt)) };
  });
  return { cacheDir, files, resolved: { repo: 'acme/equipo', host: 'github', ref: 'main', commit: SHA(n), tree: SHA(n + 1), etag: null, declaration: { name: 'e', requires: '2026.10.01.1' } } };
}

test(`${T80} — onboarding/<nombre>.md entra a la lista cerrada; la charla, un guion, un dato o una subcarpeta rechazan la capa ENTERA nombrando la ruta`, () => {
  const base = TEAM.planTeam(A2_SANE);
  const ok = TEAM.planTeam([...A2_SANE, dir('onboarding'), blob('onboarding/alta.md', 2000), blob('onboarding/step-0-mac.md', 2000)]);
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  for (const p of ['onboarding/alta.md', 'onboarding/step-0-mac.md']) assert.ok(ok.files.some((f) => f.path === p), `${p} tendría que apilarse`);
  assert.equal(ok.totalBytes, base.totalBytes + 4000, 'el alta cuenta contra el tope de la capa, como el resto');
  // una ruta por causa, sobre una capa sana que YA trae un texto del alta: rechazo entero, la ruta nombrada con su motivo
  const refused = [
    ['onboarding/mini-class/x.md', /lista cerrada/],            // la charla: queda en mantenimiento
    ['onboarding/mini-class/index.html', /lista cerrada/],
    ['onboarding/sub/x.md', /lista cerrada/],                   // un solo nivel
    ['onboarding/x.sh', /lista cerrada/],                       // sólo texto: ni un guion…
    ['onboarding/x.json', /lista cerrada/],                     // …ni un dato
    ['onboarding/x.md.sh', /lista cerrada/],
    ['onboarding/x.MD', /lista cerrada/],                       // con caja, como los demás patrones
    ['Onboarding/x.md', /lista cerrada/],
    ['onboarding/x y.md', /lista cerrada/],                     // el mismo juego de caracteres que un agente
    ['onboarding.md', /lista cerrada/],                         // la carpeta, no un archivo con su nombre
    ['onboarding/con.md', /reservado/],                         // en Windows `con.md` es un dispositivo
  ];
  for (const [p, why] of refused) {
    const r = TEAM.planTeam([...A2_SANE, blob('onboarding/alta.md', 100), blob(p, 10)]);
    assert.equal(r.ok, false, `${p} tendría que rechazar la capa`);
    assert.deepEqual(r.files, [], `${p}: con un rechazo no queda nada para apilar (tampoco el alta sana)`);
    const hit = r.problems.find((x) => x.path === p);
    assert.ok(hit, `${p} tendría que estar nombrada: ${JSON.stringify(r.problems)}`);
    assert.match(hit.reason, why, `${p}: ${hit.reason}`);
  }
  // el motivo le dice a quien arma la capa qué SÍ entra bajo onboarding/
  assert.match(TEAM.layerPathProblem('onboarding/x.sh'), /onboarding\/<nombre>\.md/);
  // lo que vale para toda ruta de la capa vale para el alta: sólo un archivo común, sin choque de caja, sin pisar la versión, bajo el tope
  const one = (extra, opts) => { const r = TEAM.planTeam([...SANE, ...extra], opts); assert.equal(r.ok, false, JSON.stringify(extra.map((e) => e.path))); return r.problems; };
  assert.ok(one([blob('onboarding/alta.md', 10, '100755')]).some((x) => x.path === 'onboarding/alta.md' && /100644/.test(x.reason)), 'un alta ejecutable no entra');
  assert.ok(one([{ path: 'onboarding/alta.md', mode: '120000', type: 'blob', sha: SHA(7), size: 5 }]).some((x) => x.path === 'onboarding/alta.md' && /enlace/.test(x.reason)), 'un enlace no entra');
  assert.ok(one([blob('onboarding/alta.md', 10), blob('onboarding/Alta.md', 10)]).some((x) => /caja/.test(x.reason)), 'dos altas que difieren sólo en la caja');
  assert.ok(one([blob('onboarding/alta.md', 10)], { publicPaths: ['Onboarding/ALTA.md'] }).some((x) => x.path === 'onboarding/alta.md' && /versión pública/.test(x.reason)), 'la capa no pisa un archivo de la versión');
  assert.ok(one([blob('onboarding/alta.md', TEAM.MAX_TOTAL_BYTES)]).some((x) => /MB en total/.test(x.reason)), 'el alta no tiene presupuesto propio');
});

test(`${T80} — el texto del alta no se juzga como agente ni skill, sus temporales y sus ediciones se tratan como los del resto de la capa, y no va a Codex`, () => {
  const lab = casa('t80-texto');
  // los `.md` reales no traen frontmatter ni `name:`: si se juzgaran como un agente, la capa entera se rechazaría
  fs.mkdirSync(path.join(lab, 'onboarding'), { recursive: true });
  fs.writeFileSync(path.join(lab, 'onboarding', 'alta.md'), TEAM_TEXT);
  assert.equal(TEAM.isContentChecked('onboarding/alta.md'), false);
  assert.deepEqual(TEAM.contentProblems(lab, [{ path: 'onboarding/alta.md' }]), []);
  // los temporales de un refresco cortado, al lado del alta y en ningún otro lado bajo onboarding/
  assert.equal(TEAM.isLayerTemp(`onboarding/${TEAM.TMP_PREFIX}alta.md-1-a`), true);
  assert.equal(TEAM.isLayerTemp(`onboarding/mini-class/${TEAM.TMP_PREFIX}x.md-1-a`), false);
  // doctor: el alta es de la capa (no «de más»); lo que un manifiesto local nombre fuera de la lista no se esconde
  const tree = path.join(lab, 'tree');
  fs.mkdirSync(path.join(tree, 'onboarding', 'mini-class'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'onboarding', 'alta.md'), TEAM_TEXT);
  fs.writeFileSync(path.join(tree, 'onboarding', 'mini-class', 'charla.md'), '# la charla\n');
  fs.writeFileSync(path.join(tree, 'agents', 'rev-a.md'), agentMd('rev-a'));
  const manifest = { schema: 1, repo: 'acme/equipo', commit: SHA(3), files: [
    { path: 'onboarding/alta.md', blob: TEAM.blobOf(Buffer.from(TEAM_TEXT)) },
    { path: 'onboarding/mini-class/charla.md', blob: TEAM.blobOf(Buffer.from('# la charla\n')) },
    { path: 'agents/rev-a.md', blob: TEAM.blobOf(Buffer.from(agentMd('rev-a'))) },
  ] };
  fs.writeFileSync(path.join(tree, TEAM.MANIFEST_NAME), JSON.stringify(manifest));
  assert.deepEqual(TEAM.layerPaths(tree).sort(), [TEAM.MANIFEST_NAME, 'agents/rev-a.md', 'onboarding/alta.md'].sort());
  // un alta editada a mano: doctor la dice editada y `uninstall` la conserva antes de quitar el árbol
  fs.writeFileSync(path.join(tree, 'onboarding', 'alta.md'), `${TEAM_TEXT}\nuna nota mía\n`);
  assert.deepEqual(TEAM.teamStatus(tree).edited, ['onboarding/alta.md']);
  const k = TEAM.keepEdited([['harness', tree]], path.join(lab, 'kept'));
  assert.deepEqual(k.copied, ['harness/onboarding/alta.md'], JSON.stringify(k));
  // Codex: de la capa se despliegan sus AGENTES, por su ruta; el alta no es un revisor ni una skill
  const GEN = require(path.join(ROOT, 'build', 'generate.js'));
  assert.deepEqual(GEN.advisorsToDeploy(tree).team, ['rev-a']);
});

test(`${T80} — apilar y desapilar: el alta queda en el árbol al apilar; cuando la capa deja de traerla se va, y la carpeta onboarding/ vacía también`, () => {
  const lab = casa('t80-apilar');
  const v = toyVersion(lab, { agents: ['tycon-core'] });
  const withText = [['agents/rev-a.md', agentMd('rev-a')], ['onboarding/alta.md', TEAM_TEXT], ['onboarding/step-0-mac.md', '# paso 0\n']];
  const st = TEAM.stackTeam(toyFetched(lab, withText, 3), v, { home: lab, env: {} });
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(fs.readFileSync(path.join(v, 'onboarding', 'alta.md'), 'utf8'), TEAM_TEXT, 'apilada en el árbol');
  assert.ok(TEAM.readTeamManifest(v).files.some((f) => f.path === 'onboarding/alta.md'), 'y nombrada en el manifiesto de la capa');
  // sin acceso al repo del equipo, la capa instalada (con su alta) se arrastra a la versión nueva
  const next = toyVersion(path.join(lab, 'next'), { agents: ['tycon-core'] });
  const carried = TEAM.carryTeam(v, next, { home: lab, env: {} });
  assert.equal(carried.ok, true, JSON.stringify(carried));
  assert.equal(fs.readFileSync(path.join(next, 'onboarding', 'alta.md'), 'utf8'), TEAM_TEXT);
  // una versión que YA trae esa ruta choca: la capa no la pisa (ni al apilar ni al refrescar)
  const clash = toyVersion(path.join(lab, 'clash'), { agents: ['tycon-core'] });
  const relm = JSON.parse(fs.readFileSync(path.join(clash, '.tycon-release.json'), 'utf8'));
  fs.mkdirSync(path.join(clash, 'onboarding'), { recursive: true });
  fs.writeFileSync(path.join(clash, 'onboarding', 'Alta.md'), 'de la versión\n');
  relm.files.push({ path: 'onboarding/Alta.md', blob: TEAM.blobOf(Buffer.from('de la versión\n')) });
  fs.writeFileSync(path.join(clash, '.tycon-release.json'), JSON.stringify(relm));
  const c = TEAM.stackTeam(toyFetched(lab, withText, 3), clash, { home: lab, env: {} });
  assert.equal(c.ok, false); assert.deepEqual(c.collision, ['onboarding/alta.md'], JSON.stringify(c));
  assert.equal(fs.readFileSync(path.join(clash, 'onboarding', 'Alta.md'), 'utf8'), 'de la versión\n', 'el archivo de la versión no se tocó');
  // (1) la capa deja de traer UNO: se va ese, la carpeta sigue (tiene el otro)
  let r = TEAM.refreshInPlace(toyFetched(lab, withText.filter(([p]) => p !== 'onboarding/step-0-mac.md'), 5), v, { home: lab, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.removed, ['onboarding/step-0-mac.md']);
  assert.equal(fs.existsSync(path.join(v, 'onboarding', 'alta.md')), true);
  // (2) deja de traer el alta: se va, y la carpeta que existía sólo por la capa no queda vacía en el árbol
  r = TEAM.refreshInPlace(toyFetched(lab, [['agents/rev-a.md', agentMd('rev-a')]], 7), v, { home: lab, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.removed, ['onboarding/alta.md']);
  assert.equal(fs.existsSync(path.join(v, 'onboarding')), false, 'onboarding/ vacía no queda en el árbol');
  assert.equal(fs.existsSync(path.join(v, 'agents', 'rev-a.md')), true, 'el resto de la capa sigue');
  // (3) vuelve a traerla y alguien la edita a mano: cuando la capa la saca, la edición se conserva y la carpeta la sostiene
  r = TEAM.refreshInPlace(toyFetched(lab, withText, 9), v, { home: lab, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  fs.writeFileSync(path.join(v, 'onboarding', 'alta.md'), `${TEAM_TEXT}\nuna nota mía\n`);
  r = TEAM.refreshInPlace(toyFetched(lab, [['agents/rev-a.md', agentMd('rev-a')]], 11), v, { home: lab, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.keptRemoved, ['onboarding/alta.md'], 'lo editado a mano no se borra');
  assert.deepEqual(fs.readdirSync(path.join(v, 'onboarding')), ['alta.md'], 'la carpeta sigue: la sostiene el archivo conservado');
  // la limpieza, directa: nunca una carpeta que la versión trae, y nunca fuera de las carpetas de la capa
  const h = path.join(lab, 'h');
  for (const d of ['onboarding', 'scripts/metrics', 'guides']) fs.mkdirSync(path.join(h, ...d.split('/')), { recursive: true });
  TEAM.pruneEmptyDirs(h, ['onboarding/alta.md', 'scripts/metrics/corridas-buzon.json', 'guides/x.md'], { files: [{ path: 'Onboarding/de-la-version.md' }] });
  assert.equal(fs.existsSync(path.join(h, 'onboarding')), true, 'una carpeta que la versión trae no se borra aunque quede vacía');
  assert.equal(fs.existsSync(path.join(h, 'scripts', 'metrics')), true, 'scripts/ no es una carpeta de la capa');
  assert.equal(fs.existsSync(path.join(h, 'guides')), true);
  TEAM.pruneEmptyDirs(h, ['onboarding/alta.md'], { files: [] });
  assert.equal(fs.existsSync(path.join(h, 'onboarding')), false, 'sin la versión de por medio, vacía se va');
});

// ── tanda A2b-AC33 · T33: el mapa de renombres, tercera ruta exacta, validado contra la versión que va a quedar ─────────────
const MAP_PATH = 'scripts/lib/renames.json';
/** Una versión de juguete con el lector del mapa de ESTA rama (scripts/lib/legacy-names.js) y un guion que lee una opción. */
function mapVersion(lab, { reader = true, readerText = null } = {}) {
  const v = toyVersion(lab);
  const relmFile = path.join(v, '.tycon-release.json');
  const relm = JSON.parse(fs.readFileSync(relmFile, 'utf8'));
  const put = (p, buf) => { const f = path.join(v, ...p.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); relm.files.push({ path: p, blob: TEAM.blobOf(Buffer.from(buf)) }); };
  if (reader) put('scripts/lib/legacy-names.js', readerText !== null ? readerText : fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js')));
  put('scripts/ci/tool.js', "'use strict';\n// lee --type y --json; subcomandos check y run; --mode fast\nconst OPTIONS = ['type', 'json'];\nmodule.exports = OPTIONS;\n");
  // en la lista de la versión y no en el disco: un `where` que no se puede leer
  relm.files.push({ path: 'scripts/ci/ghost.js', blob: SHA(7) });
  fs.writeFileSync(relmFile, JSON.stringify(relm));
  return v;
}
/** El mapa sano de juguete: una entrada por clase de la regla del AC 33 (c). */
const saneMap = () => ({
  retire_after: '2026-11-17',
  entries: [
    { kind: 'file', old: 'scripts/ci/old-tool.js', new: 'scripts/ci/tool.js', batch: 'X', callers: ['same-repo'] },
    { kind: 'file', old: 'scripts/keeper/old-thing.js', new: 'scripts/keeper/thing.js', batch: 'X', callers: ['same-repo'] },
    { kind: 'folder', old: 'scripts/ci-old', new: 'scripts/ci', batch: 'X', callers: ['docs'] },
    { kind: 'option', old: 'kind', new: 'type', where: 'scripts/ci/tool.js', batch: 'X' },
    { kind: 'option', old: 'old-flag', new: 'fresh-flag', where: 'scripts/keeper/thing.js', batch: 'X' },
    { kind: 'env', old: 'TYCON_OLD_SETTING', new: 'TYCON_NEW_SETTING', batch: 'X' },
    { kind: 'state-file', old: '~/.claude/.tycon-pipeline/old-seal.json', new: '~/.claude/.tycon-pipeline/new-seal.json', batch: 'X' },
    { kind: 'key', old: 'hosts', new: 'servers', where: '.tycon/production.json', batch: 'X' },
  ],
});
const mapLayer = (lab, map) => toyLayer(lab, [[MAP_PATH, typeof map === 'string' ? map : JSON.stringify(map)]]);

test('T33 Team_RenamesMapThirdExactPath_ShapeValidated_OldVariableOptionAndStateFileResolvedOnLayerMachine_UnderSizeCap · la ruta y su copia', () => {
  assert.ok(TEAM.CLOSED_PATHS.includes(MAP_PATH), 'el mapa es una ruta exacta de la lista cerrada');
  assert.equal(TEAM.layerPathProblem(MAP_PATH), null);
  assert.ok(FIXTURE.paths.includes(MAP_PATH), 'team-layer-paths.json trae la tercera ruta');
  assert.ok(FIXTURE.samples.in.includes(MAP_PATH), 'y su muestra');
  // sólo esa ruta: otro .json de scripts/lib sigue afuera
  assert.notEqual(TEAM.layerPathProblem('scripts/lib/other.json'), null);
  const r = TEAM.planTeam([...SANE, dir('scripts/lib'), blob(MAP_PATH, 144505)]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('T33 Team_RenamesMapThirdExactPath_ShapeValidated_OldVariableOptionAndStateFileResolvedOnLayerMachine_UnderSizeCap · el mapa contra la versión', () => {
  const lab = casa('t33');
  const v = mapVersion(lab);
  const judge = (map) => { fs.rmSync(path.join(lab, 'layer'), { recursive: true, force: true }); const l = mapLayer(lab, map); return TEAM.checkAgainstVersion(l.dir, l.files, v, { env: {} }); };
  const ok = judge(saneMap());
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  // cada mapa malo, solo: rechaza la capa nombrando la entrada (o el mapa) con su motivo
  const bad = (mutate, re) => {
    const m = saneMap(); mutate(m);
    const r = judge(m);
    assert.equal(r.ok, false, `tendría que rechazar: ${JSON.stringify(m).slice(0, 200)}`);
    const hit = r.problems.find((x) => x.path === MAP_PATH);
    assert.ok(hit, JSON.stringify(r.problems));
    assert.match(hit.reason, re);
    return hit;
  };
  bad((m) => { m.entries[0].kind = 'banana'; }, /entries\[0\].*banana/);
  bad((m) => { m.entries.push({ kind: 'file', old: 'scripts/ci/tool.js', new: 'scripts/ci/gone.js', batch: 'X', callers: ['same-repo'] }); }, /entries\[8\].*scripts\/ci\/gone\.js/);
  bad((m) => { m.entries.push({ kind: 'folder', old: 'scripts/ci', new: 'scripts/gone-dir', batch: 'X', callers: ['docs'] }); }, /entries\[8\].*scripts\/gone-dir/);
  bad((m) => { m.entries.push({ kind: 'option', old: 'nope', new: 'never-there', where: 'scripts/ci/tool.js', batch: 'X' }); }, /entries\[8\].*never-there.*scripts\/ci\/tool\.js/);
  bad((m) => { m.retire_after = '2026-13-45'; }, /retire_after/);
  bad((m) => { m.entries = { a: 1 }; }, /entries/);
  bad((m) => { m.entries[5].new = m.entries[5].old; }, /entries\[5\].*(iguales|distint)/);
  bad((m) => { m.entries[1].new = '../outside.js'; }, /entries\[1\]/);
  bad((m) => { delete m.entries[3].new; }, /entries\[3\]/);
  bad((m) => { m.entries[2] = 'texto'; }, /entries\[2\]/);
  // la forma más estricta (revisor de seguridad de la tanda): la HOME sólo bajo ~/.claude, ningún tramo .git, nombres con la
  // forma de su tipo, `where` y `repo` sanos
  bad((m) => { m.entries[6].new = '~/.ssh/config'; }, /entries\[6\].*~\/\.claude/);
  bad((m) => { m.entries.push({ kind: 'config-file', old: '~/.zshrc', new: '~/.claude/zshrc', batch: 'X' }); }, /entries\[8\].*~\/\.claude/);
  bad((m) => { m.entries[0].new = '.git/hooks/pre-commit'; }, /entries\[0\].*\.git/);
  bad((m) => { m.entries[2].new = 'scripts/.git'; }, /entries\[2\].*\.git/);
  bad((m) => { m.entries[5].new = 'tycon-lower'; }, /entries\[5\].*forma/);
  bad((m) => { m.entries[3].new = 'two words'; }, /entries\[3\].*forma/);
  bad((m) => { m.entries[7].new = 'a b'; }, /entries\[7\].*forma/);
  // el lado viejo se juzga igual que el nuevo (revisor de cobertura, vuelta 2): forma por tipo, `.git` y la HOME
  bad((m) => { m.entries[5].old = 'tycon old'; }, /entries\[5\].*old.*forma/);
  bad((m) => { m.entries.push({ kind: 'subcommand', old: 'bad sub', new: 'check', where: 'scripts/ci/tool.js', batch: 'X' }); }, /entries\[8\].*forma/);
  bad((m) => { m.entries.push({ kind: 'value', old: 'quick', new: 'two words', where: 'scripts/ci/tool.js', option: 'mode', batch: 'X' }); }, /entries\[8\].*forma/);
  bad((m) => { m.entries[0].old = 'scripts/.Git./x.js'; }, /entries\[0\].*old.*\.git/);
  bad((m) => { m.entries[6].old = '~/.config/old.json'; }, /entries\[6\].*old.*~\/\.claude/);
  bad((m) => { m.entries[4].where = '../outside.js'; }, /entries\[4\].*where/);
  bad((m) => { m.entries[4].where = 7; }, /entries\[4\].*where/);
  bad((m) => { m.entries[0].repo = 'other'; }, /entries\[0\].*repo/);
  bad((m) => { m.entries.push({ kind: 'config-file', old: '/etc/x.json', new: '.tycon/x.json', batch: 'X' }); }, /entries\[8\]/);
  // subcomando y valor: su nombre nuevo en el texto de su guion de la versión
  const withMore = (extra) => { const m = saneMap(); m.entries.push(...extra); return judge(m); };
  assert.equal(withMore([{ kind: 'subcommand', old: 'verify', new: 'check', where: 'scripts/ci/tool.js', batch: 'X' }, { kind: 'value', old: 'quick', new: 'fast', where: 'scripts/ci/tool.js', option: 'mode', batch: 'X' }]).ok, true);
  let r = withMore([{ kind: 'subcommand', old: 'nope-sub', new: 'never-sub', where: 'scripts/ci/tool.js', batch: 'X' }]);
  assert.ok(r.problems.some((x) => /entries\[8\].*never-sub/.test(x.reason)), JSON.stringify(r.problems));
  r = withMore([{ kind: 'value', old: 'slow', new: 'slowest', where: 'scripts/ci/tool.js', option: 'mode', batch: 'X' }]);
  assert.ok(r.problems.some((x) => /entries\[8\].*slowest/.test(x.reason)), JSON.stringify(r.problems));
  // un `where` de la lista de la versión que no se puede leer del disco: se dice, no se toma por «no está»
  r = withMore([{ kind: 'option', old: 'stale', new: 'fresh', where: 'scripts/ci/ghost.js', batch: 'X' }]);
  assert.ok(r.problems.some((x) => /entries\[8\].*no pude leer scripts\/ci\/ghost\.js/.test(x.reason)), JSON.stringify(r.problems));
  // JSON válido que no es un objeto
  r = judge('[]');
  assert.ok(r.problems.some((x) => x.path === MAP_PATH && /objeto/.test(x.reason)), JSON.stringify(r.problems));
  // ilegible
  r = judge('{ no es json');
  assert.equal(r.ok, false); assert.ok(r.problems.some((x) => x.path === MAP_PATH && /JSON|ilegible/.test(x.reason)), JSON.stringify(r.problems));
  // el lector de la versión: no carga, no expone lo que se usa, o tira al validar → un problema del mapa, nunca una excepción
  const readerCase = (name, text, re) => {
    const l3 = casa(`t33-${name}`);
    const v3 = mapVersion(l3, { readerText: text });
    const ly = mapLayer(l3, saneMap());
    let out;
    assert.doesNotThrow(() => { out = TEAM.checkAgainstVersion(ly.dir, ly.files, v3, { env: {} }); }, name);
    assert.equal(out.ok, false, name);
    assert.ok(out.problems.some((x) => x.path === MAP_PATH && re.test(x.reason)), `${name}: ${JSON.stringify(out.problems)}`);
  };
  readerCase('no-carga', "throw new Error('lector roto');\n", /no carga/);
  readerCase('sin-kinds', 'module.exports = {};\n', /KINDS/);
  readerCase('tira', "module.exports = { KINDS: ['file', 'folder', 'option', 'env', 'state-file', 'key'], pathProblem() { throw new Error('boom'); } };\n", /boom/);
  // pase adversarial de la tanda (5 confirmados, 4 clases), cada uno con su prueba:
  // (1) `.git` con puntos al final o en otra caja: en Windows es la misma carpeta
  bad((m) => { m.entries[0].new = 'scripts/.git./x'; }, /entries\[0\].*\.git/);
  bad((m) => { m.entries[0].new = 'scripts/.GIT../x'; }, /entries\[0\].*\.git/);
  bad((m) => { m.entries[6].new = '~/.claude/agent-skills/.git./hooks/pre-commit'; }, /entries\[6\].*\.git/);
  // (3) una opción que sólo cambia sus guiones es la misma opción para el lector (la compara sin ellos)
  bad((m) => { m.entries.push({ kind: 'option', old: '--type', new: 'type', where: 'scripts/ci/tool.js', batch: 'X' }); }, /entries\[8\].*iguales/);
  // (4) un mapa con BOM: el lector de la versión no lo lee, así que tampoco pasa la validación
  r = judge(`﻿${JSON.stringify(saneMap())}`);
  assert.equal(r.ok, false); assert.ok(r.problems.some((x) => x.path === MAP_PATH && /BOM/.test(x.reason)), JSON.stringify(r.problems));
  // (2) un tipo que el lector de una versión futura conoce y este instalador no sabe juzgar: no entra sin sus frenos
  const real = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'), 'utf8');
  {
    const l4 = casa('t33-tipo-nuevo-mapa');
    const v4 = mapVersion(l4, { readerText: `${real}\nmodule.exports.KINDS.push('hook-file');\n` });
    const m4 = saneMap(); m4.entries.push({ kind: 'hook-file', old: '~/.claude/a.sh', new: '~/.claude/b.sh', batch: 'X' });
    const ly4 = mapLayer(l4, m4);
    const out4 = TEAM.checkAgainstVersion(ly4.dir, ly4.files, v4, { env: {} });
    assert.equal(out4.ok, false);
    assert.ok(out4.problems.some((x) => /entries\[8\].*hook-file/.test(x.reason)), JSON.stringify(out4.problems));
  }
  // una versión sin su lector no acepta una capa con el mapa, y lo dice
  const lab2 = casa('t33-sin-lector');
  const v2 = mapVersion(lab2, { reader: false });
  const l2 = mapLayer(lab2, saneMap());
  const r2 = TEAM.checkAgainstVersion(l2.dir, l2.files, v2, { env: {} });
  assert.equal(r2.ok, false); assert.ok(r2.problems.some((x) => /legacy-names\.js/.test(x.reason)), JSON.stringify(r2.problems));
  // una versión sin manifiesto acepta el perfil y la llave (A1) pero no el mapa: no hay contra qué validarlo
  const bare = path.join(lab2, 'sin-manifiesto'); fs.mkdirSync(bare, { recursive: true });
  const r3 = TEAM.checkAgainstVersion(l2.dir, [{ path: 'perfil-equipo.json' }, ...l2.files], bare, { env: {} });
  assert.equal(r3.ok, false, 'sin manifiesto el mapa no pasa');
  assert.ok(r3.problems.some((x) => /manifiesto/.test(x.reason) && /mapa de renombres/.test(x.reason)), JSON.stringify(r3.problems));
  assert.equal(TEAM.checkAgainstVersion(l2.dir, [{ path: 'perfil-equipo.json' }, { path: 'scripts/metrics/corridas-buzon.json' }], bare, { env: {} }).ok, true, 'la capa de la A1 sigue pasando');
});

// el árbol real: sólo en el clon del equipo (el reparto no viaja en la copia)
const IN_REPO_33 = fs.existsSync(path.join(ROOT, 'scripts', 'publishing', 'replacements.json')) && fs.existsSync(path.join(ROOT, MAP_PATH));
test('T33 Team_RenamesMapThirdExactPath_ShapeValidated_OldVariableOptionAndStateFileResolvedOnLayerMachine_UnderSizeCap · el mapa real contra lo que publica HEAD', { skip: !IN_REPO_33 && 'el mapa y el reparto no viajan en la copia' }, () => {
  const split = require(path.join(ROOT, 'scripts', 'publishing', 'split.js'));
  const plan = split.planCommit({ repo: ROOT, commit: 'HEAD', rules: split.readRulesFile(path.join(ROOT, 'scripts', 'publishing', 'split.json')) });
  const lab = casa('t33-real');
  const v = path.join(lab, 'version');
  const files = [];
  for (const e of plan.entries.filter((x) => x.to === 'public')) {
    const raw = spawnSync('git', ['-C', ROOT, 'cat-file', 'blob', e.blob], { maxBuffer: 1 << 28 }).stdout;
    for (const dest of [e.dest || e.path, ...(e.copyTo || [])]) { const f = path.join(v, ...dest.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, raw); files.push({ path: dest, blob: TEAM.blobOf(raw) }); }
  }
  fs.writeFileSync(path.join(v, '.tycon-release.json'), JSON.stringify({ schema: 1, version: '2026.10.09.9', files }));
  assert.equal(files.some((f) => f.path === MAP_PATH), false, 'la versión no trae el mapa');
  const l = mapLayer(lab, fs.readFileSync(path.join(ROOT, MAP_PATH), 'utf8'));
  const r = TEAM.checkAgainstVersion(l.dir, l.files, v, { env: {} });
  assert.deepEqual(r.problems, [], 'el mapa real pasa contra la versión');
});

test('TPN Team_ProfileName_NewOldBoth_LayerAcceptsBoth_OldSaysHowToRename_BothNewWinsOldNotStacked_RefreshRenames', () => {
  const GH = require(path.join(ROOT, 'scripts', 'lib', 'git-tree-hash.js'));
  const b = (t) => GH.blobSha(Buffer.from(t));
  assert.equal(TEAM.PROFILE_PATH, 'team-profile.json');
  assert.equal(TEAM.LEGACY_PROFILE_PATH, 'perfil-equipo.json');
  for (const p of ['team-profile.json', 'perfil-equipo.json']) {
    assert.equal(TEAM.layerPathProblem(p), null, `${p} es de la lista cerrada`);
    assert.equal(TEAM.isContentChecked(p), true, `${p} se juzga por su contenido`);
  }
  const base = [dir('scripts'), dir('scripts/metrics'), blob('scripts/metrics/corridas-buzon.json', 400), blob('team-layer.json', 80)];
  // (1) el nombre nuevo: entra, sin aviso
  const fresh = TEAM.planTeam([...base, blob('team-profile.json', 300)]);
  assert.equal(fresh.ok, true, JSON.stringify(fresh.problems));
  assert.deepEqual(fresh.files.map((f) => f.path).sort(), ['scripts/metrics/corridas-buzon.json', 'team-profile.json']);
  assert.deepEqual(fresh.notes, []);
  // (2) el de antes: entra igual, con un aviso de una línea que dice cómo renombrarlo y que suba la versión mínima
  const old = TEAM.planTeam([...base, blob('perfil-equipo.json', 300)]);
  assert.equal(old.ok, true, JSON.stringify(old.problems));
  assert.ok(old.files.some((f) => f.path === 'perfil-equipo.json'));
  assert.equal(old.notes.length, 1);
  assert.match(old.notes[0], /nombre de antes \(perfil-equipo\.json\): sigue andando.*git mv perfil-equipo\.json team-profile\.json.*requires\.harness de team-layer\.json/);
  assert.equal(old.notes[0].includes('\n'), false, 'una sola línea');
  // (3) los dos: gana el nuevo, el de antes no se apila (ni cuenta en el tope) y se avisa
  const both = TEAM.planTeam([...base, blob('team-profile.json', 300), blob('perfil-equipo.json', 300)]);
  assert.equal(both.ok, true, JSON.stringify(both.problems));
  assert.deepEqual(both.files.map((f) => f.path).sort(), ['scripts/metrics/corridas-buzon.json', 'team-profile.json']);
  assert.equal(both.totalBytes, 700, 'el de antes no cuenta en el tope');
  assert.match(both.notes[0], /los dos nombres: vale team-profile\.json y perfil-equipo\.json no se usa.*git rm perfil-equipo\.json/);
  // la línea del plan (install/update/--dry-run) dice el aviso; sin aviso, la línea de siempre
  const resolvedOf = (plan) => ({ repo: 'acme/equipo', commit: SHA(5), files: plan.files, declaration: { name: 'e', requires: '2026.10.01.1' }, notes: plan.notes });
  assert.match(TEAM.planLine(resolvedOf(old)), / — aviso: el perfil del equipo usa el nombre de antes/);
  assert.doesNotMatch(TEAM.planLine(resolvedOf(fresh)), /aviso/);
  // (4) el perfil del árbol: los dos nombres
  const lab = casa('pname');
  const t0 = path.join(lab, 't0'); fs.mkdirSync(t0);
  assert.deepEqual(TEAM.profileIn(t0), { file: path.join(t0, 'team-profile.json'), name: 'team-profile.json', exists: false, legacy: false, both: false });
  fs.writeFileSync(path.join(t0, 'perfil-equipo.json'), '{}\n');
  assert.equal(TEAM.profileIn(t0).name, 'perfil-equipo.json'); assert.equal(TEAM.profileIn(t0).legacy, true);
  fs.writeFileSync(path.join(t0, 'team-profile.json'), '{}\n');
  assert.equal(TEAM.profileIn(t0).name, 'team-profile.json'); assert.equal(TEAM.profileIn(t0).both, true);
  // (5) validar: el motivo nombra el archivo que trae la capa
  const readerTree = path.join(lab, 'reader'); fs.mkdirSync(path.join(readerTree, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(readerTree, 'scripts', 'lib'), { recursive: true });
  const bad = TEAM.validateProfile('{ roto', { readerTree, home: lab, name: 'team-profile.json' });
  assert.equal(bad.ok, false); assert.match(bad.reason, /^team-profile\.json es ilegible/);
  const badKey = TEAM.validateProfile('{ "inventada": { "x": 1 } }\n', { readerTree, home: lab, name: 'team-profile.json' });
  assert.equal(badKey.ok, false); assert.match(badKey.reason, /^team-profile\.json de la capa: /);
  assert.equal(TEAM.validateProfile('{ "integrations": { "engram": true } }\n', { readerTree, home: lab, name: 'team-profile.json' }).ok, true);
  // …y con un lector de una versión anterior, que sólo conoce el nombre de antes, el perfil nuevo también se valida
  const oldReader = path.join(lab, 'old-reader'); fs.mkdirSync(path.join(oldReader, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(oldReader, 'scripts', 'lib'), { recursive: true });
  const oldTc = path.join(oldReader, 'scripts', 'lib', 'tycon-config.js');
  const src = fs.readFileSync(oldTc, 'utf8').replace("const NOMBRE_PERFIL = 'team-profile.json';", "const NOMBRE_PERFIL = 'perfil-equipo.json';");
  assert.ok(src.includes("const NOMBRE_PERFIL = 'perfil-equipo.json';"), 'el lector de juguete busca sólo el nombre de antes');
  fs.writeFileSync(oldTc, src);
  assert.equal(TEAM.validateProfile('{ "integrations": { "engram": true } }\n', { readerTree: oldReader, home: lab, name: 'team-profile.json' }).ok, true);
  // (6) apilar con el nombre nuevo: queda team-profile.json; un perfil nuevo inválido rechaza la capa nombrándolo
  const P = '{ "integrations": { "engram": true } }\n';
  const cacheDir = path.join(lab, 'cache'); fs.mkdirSync(cacheDir);
  fs.writeFileSync(path.join(cacheDir, 'team-profile.json'), P);
  const inc = path.join(lab, 'incoming'); fs.mkdirSync(path.join(inc, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(inc, 'scripts', 'lib'), { recursive: true });
  const files = [{ path: 'team-profile.json', mode: '100644', blob: b(P) }];
  const resolved = { repo: 'acme/equipo', ref: 'main', commit: SHA(9), tree: SHA(10), etag: null, files: files.map((f) => ({ path: f.path, mode: f.mode, sha: f.blob })), declaration: { name: 'e', requires: '2026.10.01.1' } };
  const st = TEAM.stackTeam({ resolved, cacheDir, files }, inc, { home: lab, env: {} });
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(fs.readFileSync(path.join(inc, 'team-profile.json'), 'utf8'), P);
  assert.equal(fs.existsSync(path.join(inc, 'perfil-equipo.json')), false);
  const TC = require(path.join(inc, 'scripts', 'lib', 'tycon-config.js'));
  const read = TC.cargar({ env: {}, home: lab, arnes: inc });
  assert.equal(read.valores.integraciones.engram, true); assert.equal(read.origenes['integraciones.engram'], 'perfil');
  const inc2 = path.join(lab, 'incoming2'); fs.mkdirSync(path.join(inc2, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(inc2, 'scripts', 'lib'), { recursive: true });
  const cacheBad = path.join(lab, 'cache-bad'); fs.mkdirSync(cacheBad);
  const PB = '{ "install": { "home": true } }\n';
  fs.writeFileSync(path.join(cacheBad, 'team-profile.json'), PB);
  const filesBad = [{ path: 'team-profile.json', mode: '100644', blob: b(PB) }];
  const stBad = TEAM.stackTeam({ resolved: Object.assign({}, resolved, { files: filesBad.map((f) => ({ path: f.path, mode: f.mode, sha: f.blob })) }), cacheDir: cacheBad, files: filesBad }, inc2, { home: lab, env: {} });
  assert.equal(stBad.ok, false); assert.match(stBad.reason, /team-profile\.json de la capa/);
  assert.equal(fs.existsSync(path.join(inc2, 'team-profile.json')), false, 'no escribió nada');
  // (7) el refresco en el lugar cuando el repo del equipo renombra: queda el nuevo y el de antes (con su blob) se borra
  const harness = path.join(lab, 'harness'); fs.mkdirSync(path.join(harness, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(harness, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(harness, 'perfil-equipo.json'), P);
  fs.writeFileSync(path.join(harness, TEAM.MANIFEST_NAME), JSON.stringify({ schema: 1, repo: 'acme/equipo', ref: 'main', commit: SHA(1), tree: SHA(2), name: 'e', requires: '2026.10.01.1', files: [{ path: 'perfil-equipo.json', mode: '100644', blob: b(P) }] }));
  const rf = TEAM.refreshInPlace({ cacheDir, files, resolved: Object.assign({}, resolved, { commit: SHA(3), tree: SHA(4) }) }, harness, { home: lab, env: {} });
  assert.equal(rf.ok, true, JSON.stringify(rf));
  assert.equal(fs.readFileSync(path.join(harness, 'team-profile.json'), 'utf8'), P);
  assert.equal(fs.existsSync(path.join(harness, 'perfil-equipo.json')), false, 'el nombre de antes se fue con el refresco');
  assert.deepEqual(TEAM.readTeamManifest(harness).files.map((f) => f.path), ['team-profile.json']);
});

