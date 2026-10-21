'use strict';
/**
 * declared-siblings.test.js — el revisor de hermanos entra sólo en un plugin y compara con los hermanos declarados.
 *
 * Lo que no se puede perder:
 *   - El núcleo resuelve los `siblings` de los paquetes activos contra la raíz de repos sin recorrer nada: sólo mira si
 *     la ruta esperada existe. Un hermano ausente se dice con su ruta esperada.
 *   - El pedido de validación de un paquete recibe esa lista en `{siblings}`; `pipeline.js siblings` la da para el resto.
 *   - Con el paquete de clientes real (del perfil del equipo, `TYCON_TEAM_PROFILE_DIR`): un repo que no es un plugin no
 *     activa el revisor; uno que sí, lo activa con los dos hermanos. Sin esa carpeta, esos casos se saltean y lo dicen.
 *
 * 0 deps (node:test). Todo corre con un HOME de laboratorio y carpetas temporales.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const PERFIL = process.env.TYCON_TEAM_PROFILE_DIR || '';
const HAY_PERFIL = !!PERFIL && fs.existsSync(path.join(PERFIL, 'packs', 'clients', 'pack.json'));
const SIN_PERFIL = HAY_PERFIL ? false : 'sin el perfil del equipo (TYCON_TEAM_PROFILE_DIR): el paquete de clientes no viaja con el núcleo';
const REVISOR = 'tycon-sibling-pattern-reviewer';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hermanos-${p}-`)));
const HOME = tmp('home');
const escribir = (base, rel, txt) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };

/** Un paquete de juguete con hermanos declarados, y su agente. */
function paqueteDeJuguete(hermanos) {
  const packs = tmp('packs');
  const agents = tmp('agents');
  escribir(packs, 'prueba/agents/revisor-de-prueba.md', '---\nname: revisor-de-prueba\ndescription: prueba\ntools: Read\n---\n# prueba\n');
  escribir(packs, 'prueba/pack.json', JSON.stringify({
    name: 'prueba', description: 'de prueba', guides: [],
    reviewers: [{ agent: 'revisor-de-prueba', group: 'validacion', when: { files: '\\.cs$' }, prompt: 'Story {story_path} en {repo_path}. Hermanos:\n{siblings}', prefixes: ['PRB'] }],
    siblings: hermanos,
  }));
  return { packs, agents };
}

/** El paquete de clientes REAL del perfil, con las instrucciones de su revisor, copiado a una carpeta de paquetes
 *  propia (sin el de bizuit). */
function paqueteDeClientes() {
  const packs = tmp('packs-clients');
  escribir(packs, 'clients/pack.json', fs.readFileSync(path.join(PERFIL, 'packs', 'clients', 'pack.json'), 'utf8'));
  escribir(packs, `clients/agents/${REVISOR}.md`, fs.readFileSync(path.join(PERFIL, 'packs', 'clients', 'agents', `${REVISOR}.md`), 'utf8'));
  return { packs, agents: tmp('agents-raiz') };
}

function raizConHermanos(rutas) {
  const r = tmp('repos');
  for (const p of rutas) fs.mkdirSync(path.join(r, p), { recursive: true });
  return r;
}

function repoDeJuguete(archivos) {
  const d = tmp('repo');
  for (const [rel, txt] of Object.entries(archivos)) escribir(d, rel, txt);
  const story = escribir(d, 'specs/story-9.94-juguete.md', ['---', 'story: "9.94"', 'title: "juguete"', 'status: ready-for-dev',
    'files_to_modify:', ...Object.keys(archivos).filter((f) => f.endsWith('.cs')).map((f) => `  - ${f}`), '---', '', '# Story 9.94', ''].join('\n'));
  return { d, story };
}

function pipeline(cmd, args, env) {
  const r = spawnSync(process.execPath, [PIPELINE, cmd, ...args], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME, USERPROFILE: HOME, LANG: 'en_US.UTF-8', TYCON_SESSION_ID: 'hermanos-test', TYCON_PACKS_DEFAULT: 'all', ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_e) { /* el caso mira la salida */ }
  return { ...r, json };
}

// hermanos de juguete, con nombres neutros (los reales viven sólo en el paquete del perfil del equipo)
const ALFA = 'Alfa/AlfaBackend/src/AlfaApi';
const BETA = 'Beta/Backend/src/BetaApi';
/** Los hermanos que declara el paquete de clientes real, tal cual (con el perfil). */
const DECLARADOS = HAY_PERFIL ? JSON.parse(fs.readFileSync(path.join(PERFIL, 'packs', 'clients', 'pack.json'), 'utf8')).siblings : [];

test('DeclaredSiblings_Resolver_SinRecorrer @story-8.81 @ac-4 — está si la ruta esperada existe; nada se busca más hondo', () => {
  const packs = require('../lib/packs.js');
  const raiz = raizConHermanos([ALFA, path.join('otra', 'carpeta', BETA)]);
  const lista = packs.hermanosResueltos({ paquetes: [{ nombre: 'p', hermanos: [{ ruta: ALFA, nombre: 'Alfa' }, { ruta: BETA, nombre: 'Beta' }] }], reposRoot: raiz });
  assert.deepEqual(lista.map((h) => [h.nombre, h.esta]), [['Alfa', true], ['Beta', false]]);
  assert.equal(lista[1].rutaEsperada, path.join(raiz, BETA));
  // sin raíz de repos: ninguno «está», y se dice por qué
  const sinRaiz = packs.hermanosResueltos({ paquetes: [{ nombre: 'p', hermanos: [{ ruta: ALFA, nombre: 'Alfa' }] }], reposRoot: null });
  assert.equal(sinRaiz[0].esta, false);
  assert.match(packs.textoDeHermanos(sinRaiz, { reposRoot: null }), /no sé cuál es la raíz de repos/);
});

test('DeclaredSiblings_HermanoAusente_LoDice @story-8.81 @ac-5 — el pedido nombra cada hermano y dice cuál no está', () => {
  const { packs, agents } = paqueteDeJuguete([{ path: ALFA, name: 'Alfa' }, { path: BETA, name: 'Beta' }]);
  const raiz = raizConHermanos([ALFA]);
  const { d, story } = repoDeJuguete({ 'src/A.cs': 'class A {}' });
  const r = pipeline('validators', ['--story', story, '--repo', d], { TYCON_PACKS_DIR: packs, TYCON_AGENTS_DIR: agents, TYCON_REPOS_ROOT: raiz });
  assert.equal(r.status, 0, r.stderr);
  const l = r.json.lanzamientos.find((x) => x.agente === 'revisor-de-prueba');
  assert.ok(l, JSON.stringify(r.json.lanzamientos));
  assert.match(l.prompt, new RegExp(`Alfa: ${path.join(raiz, ALFA).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(está\\)`));
  assert.match(l.prompt, /Beta: .*BetaApi \(NO está en esta máquina: no lo busques en otro lado\)/);
  // sin hermanos declarados: lo dice
  const vacio = paqueteDeJuguete([]);
  const r2 = pipeline('validators', ['--story', story, '--repo', d], { TYCON_PACKS_DIR: vacio.packs, TYCON_AGENTS_DIR: vacio.agents, TYCON_REPOS_ROOT: raiz });
  assert.match(r2.json.lanzamientos[0].prompt, /no hay hermanos declarados: no se buscan/);
});

test('DeclaredSiblings_Comando @story-8.81 @ac-6 — pipeline.js siblings da los hermanos resueltos de los paquetes activos', () => {
  const { packs, agents } = paqueteDeJuguete([{ path: ALFA, name: 'Alfa' }, { path: BETA, name: 'Beta' }]);
  const raiz = raizConHermanos([ALFA, BETA]);
  const { d } = repoDeJuguete({ 'src/A.cs': 'class A {}' });
  const r = pipeline('siblings', ['--repo', d], { TYCON_PACKS_DIR: packs, TYCON_AGENTS_DIR: agents, TYCON_REPOS_ROOT: raiz });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.hermanos.map((h) => [h.nombre, h.esta]), [['Alfa', true], ['Beta', true]]);
  assert.equal(r.json.raiz, raiz);
  // sin paquetes: lista vacía
  const sin = tmp('sin-packs');
  const r2 = pipeline('siblings', ['--repo', d], { TYCON_PACKS_DIR: sin, TYCON_AGENTS_DIR: agents, TYCON_REPOS_ROOT: raiz });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(r2.json.hermanos, []);
  // un paquete roto frena como en validators
  const roto = tmp('roto');
  escribir(roto, 'x/pack.json', '{ no es json');
  const r3 = pipeline('siblings', ['--repo', d], { TYCON_PACKS_DIR: roto, TYCON_AGENTS_DIR: agents, TYCON_REPOS_ROOT: raiz });
  assert.equal(r3.status, 2, `${r3.stdout}${r3.stderr}`);
});

test('DeclaredSiblings_RepoNoPlugin_NoEntra @story-8.81 @ac-1', { skip: SIN_PERFIL }, () => {
  const { packs, agents } = paqueteDeClientes();
  const raiz = raizConHermanos(DECLARADOS.map((h) => h.path));
  // como el repo de la API del producto: proyectos .NET y una clase con «Plugin» en el nombre, sin IBackendPlugin
  const { d, story } = repoDeJuguete({
    'Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.1" /></ItemGroup></Project>\n',
    'Api/Services/ExportPlugin.cs': 'namespace Api.Services { public class ExportPlugin { } }\n',
    'Api/Program.cs': 'class Program { }\n',
  });
  const r = pipeline('validators', ['--story', story, '--repo', d], { TYCON_PACKS_DIR: packs, TYCON_AGENTS_DIR: agents, TYCON_REPOS_ROOT: raiz });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.json.validadores.includes(REVISOR), JSON.stringify(r.json.validadores));
});

test('DeclaredSiblings_Plugin_EntraConHermanos @story-8.81 @ac-2 @ac-5', { skip: SIN_PERFIL }, () => {
  const { packs, agents } = paqueteDeClientes();
  const raiz = raizConHermanos(DECLARADOS.map((h) => h.path));
  for (const archivos of [
    { 'src/Acme/AcmePlugin.cs': 'namespace Acme { public class AcmePlugin : IBackendPlugin { } }\n', 'src/Acme/Acme.csproj': '<Project />\n' },
    { 'src/Acme/Acme.csproj': '<Project><ItemGroup><PackageReference Include="Bizuit.Backend.Core" Version="1.0.0" /></ItemGroup></Project>\n', 'src/Acme/Startup.cs': 'class S { }\n' },
  ]) {
    const { d, story } = repoDeJuguete(archivos);
    const r = pipeline('validators', ['--story', story, '--repo', d], { TYCON_PACKS_DIR: packs, TYCON_AGENTS_DIR: agents, TYCON_REPOS_ROOT: raiz });
    assert.equal(r.status, 0, r.stderr);
    const l = r.json.lanzamientos.find((x) => x.agente === REVISOR);
    assert.ok(l, `${Object.keys(archivos)}: ${JSON.stringify(r.json.validadores)}`);
    assert.ok(DECLARADOS.length >= 2, 'el paquete declara al menos dos hermanos');
    for (const h of DECLARADOS) assert.ok(l.prompt.includes(`${h.name}: ${path.join(raiz, ...h.path.split('/'))} (está)`), `${h.name}: ${l.prompt}`);
    assert.doesNotMatch(l.prompt, /maxdepth|FULL-DEPTH|find /i);
  }
});

test('DeclaredSiblings_CondicionalSinClasePlugin @story-8.81 @ac-3', { skip: SIN_PERFIL }, () => {
  const packs = require('../lib/packs.js');
  const json = JSON.parse(fs.readFileSync(path.join(PERFIL, 'packs', 'clients', 'pack.json'), 'utf8'));
  const cond = json.reviewers.find((r) => r.agent === REVISOR && r.group === 'condicional').when;
  const ctx = (file, content) => ({ det: {}, files: [file], agregado: (exts) => (exts.some((e) => file.endsWith(e)) ? [{ file, content }] : []) });
  assert.equal(packs.evaluarCondicion(cond, ctx('src/ExportPlugin.cs', 'public class ExportPlugin { }')), false);
  assert.equal(packs.evaluarCondicion(cond, ctx('src/AcmePlugin.cs', 'public class AcmePlugin : IBackendPlugin { }')), true);
  assert.equal(packs.evaluarCondicion(cond, ctx('src/Acme.csproj', '<PackageReference Include="Bizuit.Backend.Core" />')), true);
});

test('DeclaredSiblings_AgenteSinDiscovery @story-8.81 @ac-7', { skip: SIN_PERFIL }, () => {
  const agente = fs.readFileSync(path.join(PERFIL, 'packs', 'clients', 'agents', `${REVISOR}.md`), 'utf8');
  for (const re of [/maxdepth/i, /full-depth/i, /\bfind\s+"\$RAIZ"/, /grep\s+-r[l]?\b[^\n]*"\$RAIZ"/]) assert.doesNotMatch(agente, re, String(re));
  assert.match(agente, /hermanos declarados/i);
  assert.match(agente, /pipeline\.js siblings/);
  assert.match(agente, /NO está en esta máquina/);
});

test('DeclaredSiblings_RutasDelPaquete @story-8.81 @ac-8', { skip: SIN_PERFIL }, () => {
  // las rutas declaradas son relativas a la raíz de repos y el corral del banco fabrica exactamente esas
  assert.ok(DECLARADOS.length >= 2);
  for (const h of DECLARADOS) assert.ok(h.path.split('/').length >= 2 && !h.path.includes('..') && !path.isAbsolute(h.path), h.path);
  const { packs } = paqueteDeClientes();
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(RAIZ, 'scripts', 'lib', 'installed-packs.js'))}).siblingsFromPacks()))`],
    { encoding: 'utf8', env: { ...process.env, TYCON_PACKS_DIR: packs } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((h) => h.ruta), DECLARADOS.map((h) => h.path));
});
