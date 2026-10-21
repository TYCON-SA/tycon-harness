'use strict';

/**
 * equivalence-cases.js — los casos armados de la equivalencia de paquetes y cómo se
 * mide un pipeline sobre un repo.
 *
 * Lo comparten dos consumidores para que midan EXACTAMENTE lo mismo:
 *   · `package-equivalence.js snapshot` — corre el pipeline.js de `main` (el de antes del cambio) sobre
 *     cada caso y guarda la foto dorada en tests/fixtures/equivalence-main.json;
 *   · `tests/package-equivalence.test.js` (T10) — corre el pipeline NUEVO con los paquetes
 *     instalados y compara contra esa foto, caso por caso.
 *
 * Cada caso arma un repo git efímero con un commit base y un diff SIN commitear (así es como el
 * pipeline ve un diff en una corrida real: `git diff -U0 HEAD` + archivos nuevos untracked), y
 * devuelve la lista de archivos que se le pasa a `pipeline.js advisors --files`. Los casos recorren
 * cada rama de la matriz que el pipeline tiene escrita en su código.
 * Los casos que dependen de un paquete en particular los trae ese paquete (`casosDePaquetes`, abajo).
 *
 * `medir()` devuelve lo que se declara como equivalencia: el set por grupo (como conjuntos:
 * el orden no es contrato), las indicaciones de modelo con `--cost-tier lean`, las de re-loop
 * (`reloopHintsFor(all, 2)`) y la superficie de vuelta (`advisorAffectedByDelta`) de cada revisor
 * del set contra los archivos del diff.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`git no se pudo ejecutar (${r.error.code || r.error.message})`);   // binario ausente ≠ comando fallido
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} en ${dir}: ${r.stderr}`);
  return r.stdout;
}

const STORY_EQ = [
  '---', 'epic: 9', 'story: "9.9"', 'title: "equivalencia"', 'status: in-progress',
  'files_to_modify:', '  - src/A.cs', '---', '',
  '## Acceptance Criteria', '', '1. **Given** un diff **When** corre el pipeline **Then** elige el mismo set', '',
  '### Tests', '', '| # | Test | AC |', '|---|------|----|', '| T1 | `Equivalencia` | 1 |', '',
].join('\n');

function pkg(deps) {
  return JSON.stringify({ name: 'caso', version: '1.0.0', dependencies: deps, scripts: { build: 'echo build' } }, null, 2) + '\n';
}

/** Repo efímero con un commit base. `archivos`: { ruta: contenido }. */
function base(dir, archivos) {
  const todos = { 'specs/story-eq.md': STORY_EQ, 'README.md': 'docs\n', ...archivos };
  for (const [ruta, contenido] of Object.entries(todos)) {
    const abs = path.join(dir, ruta);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contenido);
  }
  git(dir, 'init', '-q', '-b', 'main', '.');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=eq@eq', '-c', 'user.name=eq', 'commit', '-q', '-m', 'base');
}
function escribir(dir, ruta, contenido) {
  const abs = path.join(dir, ruta);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contenido);
}
function agregar(dir, ruta, texto) { fs.appendFileSync(path.join(dir, ruta), texto); }
function cambiarDependencia(dir, nombre, version) {
  const p = path.join(dir, 'package.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.dependencies[nombre] = version;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
}

const CS = 'namespace X { public class A { public void M() { } } }\n';
const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n  </ItemGroup>\n</Project>\n';
const TSX = 'export const App = () => null;\n';
const TS = 'export const a = 1;\n';
const PLUGIN_JSON = '{ "name": "x", "defaultSettings": { "a": 1 } }\n';
const APPSETTINGS = '{ "Logging": { "LogLevel": "Information" } }\n';
const SH = '#!/bin/bash\necho hola\n';

const NUCLEO = [
  { nombre: 'solo-cs', armar(d) {
    base(d, { 'src/A.cs': CS });
    agregar(d, 'src/A.cs', 'public class B { }\n');
    return { files: ['src/A.cs'] };
  } },
  { nombre: 'solo-tsx-react', armar(d) {
    base(d, { 'package.json': pkg({ react: '18.2.0' }), 'src/App.tsx': TSX });
    agregar(d, 'src/App.tsx', 'export const B = () => null;\n');
    return { files: ['src/App.tsx'] };
  } },
  { nombre: 'solo-tsx-next', armar(d) {
    base(d, { 'package.json': pkg({ react: '18.2.0', next: '14.0.0' }), 'src/App.tsx': TSX });
    agregar(d, 'src/App.tsx', 'export const B = () => null;\n');
    return { files: ['src/App.tsx'] };
  } },
  { nombre: 'solo-ts-sin-framework', armar(d) {
    base(d, { 'package.json': pkg({ zod: '3.0.0' }), 'src/a.ts': TS });
    agregar(d, 'src/a.ts', 'export const b = 2;\n');
    return { files: ['src/a.ts'] };
  } },
  { nombre: 'cs-y-tsx-react', armar(d) {
    base(d, { 'package.json': pkg({ react: '18.2.0' }), 'src/A.cs': CS, 'src/App.tsx': TSX });
    agregar(d, 'src/A.cs', 'public class B { }\n');
    agregar(d, 'src/App.tsx', 'export const B = () => null;\n');
    return { files: ['src/A.cs', 'src/App.tsx'] };
  } },
  { nombre: 'cs-y-tsx-next', armar(d) {
    base(d, { 'package.json': pkg({ react: '18.2.0', next: '14.0.0' }), 'src/A.cs': CS, 'src/App.tsx': TSX });
    agregar(d, 'src/A.cs', 'public class B { }\n');
    agregar(d, 'src/App.tsx', 'export const B = () => null;\n');
    return { files: ['src/A.cs', 'src/App.tsx'] };
  } },
  { nombre: 'cs-y-ts-sin-framework', armar(d) {
    base(d, { 'package.json': pkg({ zod: '3.0.0' }), 'src/A.cs': CS, 'src/a.ts': TS });
    agregar(d, 'src/A.cs', 'public class B { }\n');
    agregar(d, 'src/a.ts', 'export const b = 2;\n');
    return { files: ['src/A.cs', 'src/a.ts'] };
  } },
  { nombre: 'solo-config-plugin', armar(d) {
    base(d, { 'src/A.cs': CS, 'plugin.json': PLUGIN_JSON });
    escribir(d, 'plugin.json', '{ "name": "x", "defaultSettings": { "a": 1, "b": 2 } }\n');
    return { files: ['plugin.json'] };
  } },
  { nombre: 'dependencia-nueva-react', armar(d) {
    base(d, { 'package.json': pkg({ react: '18.2.0' }), 'src/App.tsx': TSX });
    cambiarDependencia(d, 'react', '18.3.0');
    return { files: ['package.json'] };
  } },
  { nombre: 'dependencia-nueva-next', armar(d) {
    base(d, { 'package.json': pkg({ react: '18.2.0', next: '14.0.0' }), 'src/App.tsx': TSX });
    cambiarDependencia(d, 'zod', '3.0.0');
    return { files: ['package.json'] };
  } },
  { nombre: 'dependencia-y-cs', armar(d) {
    base(d, { 'package.json': pkg({ react: '18.2.0' }), 'src/A.cs': CS, 'src/App.tsx': TSX });
    cambiarDependencia(d, 'react', '18.3.0');
    agregar(d, 'src/A.cs', 'public class B { }\n');
    return { files: ['package.json', 'src/A.cs'] };
  } },
  { nombre: 'solo-sh', armar(d) {
    base(d, { 'scripts/deploy.sh': SH });
    agregar(d, 'scripts/deploy.sh', 'echo deploy || true\n');
    return { files: ['scripts/deploy.sh'] };
  } },
  { nombre: 'secretos', armar(d) {
    base(d, { 'src/A.cs': CS, 'appsettings.json': APPSETTINGS, '.env': 'X=1\n' });
    escribir(d, 'appsettings.json', '{ "Logging": { "LogLevel": "Debug" }, "ConnectionStrings": { "Db": "Server=x" } }\n');
    agregar(d, '.env', 'Y=2\n');
    return { files: ['appsettings.json', '.env'] };
  } },
  { nombre: 'plugin-bizuit-ibackendplugin', armar(d) {
    base(d, { 'src/A.cs': CS, 'src/Foo.csproj': CSPROJ });
    escribir(d, 'src/FooPlugin.cs', 'using Bizuit; public class FooPlugin : IBackendPlugin { }\n');   // archivo nuevo, untracked
    return { files: ['src/FooPlugin.cs'] };
  } },
  { nombre: 'plugin-bizuit-csproj', armar(d) {
    base(d, { 'src/A.cs': CS, 'src/Foo.csproj': CSPROJ });
    escribir(d, 'src/Foo.csproj', CSPROJ.replace('  <ItemGroup>\n', '  <ItemGroup>\n    <PackageReference Include="Bizuit.Backend.Sdk" Version="1.0.0" />\n'));
    return { files: ['src/Foo.csproj'] };
  } },
  { nombre: 'tsx-y-plugin-json', armar(d) {
    base(d, { 'package.json': pkg({ react: '18.2.0' }), 'src/App.tsx': TSX, 'plugin.json': PLUGIN_JSON });
    agregar(d, 'src/App.tsx', 'export const B = () => null;\n');
    escribir(d, 'plugin.json', '{ "name": "x", "defaultSettings": { "a": 1, "b": 2 } }\n');
    return { files: ['src/App.tsx', 'plugin.json'] };
  } },
  { nombre: 'sh-y-plugin-json', armar(d) {
    base(d, { 'src/A.cs': CS, 'scripts/deploy.sh': SH, 'plugin.json': PLUGIN_JSON });
    agregar(d, 'scripts/deploy.sh', 'echo deploy\n');
    escribir(d, 'plugin.json', '{ "name": "x", "defaultSettings": { "a": 1, "b": 2 } }\n');
    return { files: ['scripts/deploy.sh', 'plugin.json'] };
  } },
  { nombre: 'solo-docs', armar(d) {
    base(d, { 'src/A.cs': CS });
    agregar(d, 'README.md', 'más docs\n');
    return { files: ['README.md'] };
  } },
  { nombre: 'cs-hub-con-try', armar(d) {
    base(d, { 'src/A.cs': CS, 'src/Hubs/ChatHub.cs': 'public class ChatHub : Hub { }\n' });
    agregar(d, 'src/Hubs/ChatHub.cs', 'public class X { IHubContext<ChatHub> h; void M() { try { } catch { } } }\n');
    return { files: ['src/Hubs/ChatHub.cs'] };
  } },
];

/**
 * Los casos que trae un paquete de revisores. Un paquete que elige a un revisor por
 * algo propio —una ruta de su producto— trae sus casos y su foto en su carpeta, no acá:
 *   · `<packs>/<paquete>/equivalence-cases.js` exporta una función que recibe las piezas de armado de este archivo y
 *     devuelve `[{ nombre, armar }]`;
 *   · `<packs>/<paquete>/equivalence-main.json` guarda la foto de esos casos (`{ casos }`).
 * Así un paquete privado mide lo suyo sin que el núcleo lo nombre: donde el paquete no está instalado, sus casos no
 * existen. Un archivo de casos mal formado frena con su ruta; nunca se sigue «sin esos casos».
 */
const PACKS = path.resolve(__dirname, '..', '..', '..', '..', 'packs');
const PIEZAS = Object.freeze({ base, escribir, agregar, cambiarDependencia, pkg, CS, CSPROJ, TSX, TS, PLUGIN_JSON, APPSETTINGS, SH });
function casosDePaquetes(packsDir = PACKS) {
  let carpetas;
  try {
    carpetas = fs.readdirSync(packsDir).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];   // sin carpeta de paquetes no hay casos de paquete
    throw new Error(`no pude leer la carpeta de paquetes ${packsDir} (${e.code || e.message})`);
  }
  const out = [];
  for (const paquete of carpetas) {
    const archivo = path.join(packsDir, paquete, 'equivalence-cases.js');
    if (!fs.existsSync(archivo)) continue;
    const armarCasos = require(archivo);
    if (typeof armarCasos !== 'function') throw new Error(`${archivo}: tiene que exportar una función que reciba las piezas de armado y devuelva los casos`);
    const casos = armarCasos(PIEZAS);
    if (!Array.isArray(casos) || casos.some((c) => !c || typeof c.nombre !== 'string' || typeof c.armar !== 'function')) {
      throw new Error(`${archivo}: cada caso lleva "nombre" y "armar"`);
    }
    for (const c of casos) out.push({ ...c, paquete, foto: path.join(packsDir, paquete, 'equivalence-main.json') });
  }
  return out;
}

/** Los del núcleo y, al final, los de cada paquete instalado. Un nombre repetido es un error: la foto va por nombre. */
function todosLosCasos(packsDir = PACKS) {
  const todos = [...NUCLEO, ...casosDePaquetes(packsDir)];
  const vistos = new Set();
  for (const c of todos) {
    if (vistos.has(c.nombre)) throw new Error(`el caso de equivalencia «${c.nombre}» está dos veces${c.paquete ? ` (lo repite el paquete ${c.paquete})` : ''}`);
    vistos.add(c.nombre);
  }
  return todos;
}
const CASOS = todosLosCasos();

/**
 * La foto entera: la que viaja (`fotoPublica`) más la de cada paquete que trae casos. Un caso que está en las dos, o una
 * foto de paquete que no se deja leer, es un error: nunca «gana una» ni se sigue sin ella.
 */
function leerFoto(fotoPublica, casos = CASOS) {
  const foto = JSON.parse(fs.readFileSync(fotoPublica, 'utf8'));
  const juntos = { ...(foto.casos || {}) };
  for (const archivo of new Set(casos.filter((c) => c.foto).map((c) => c.foto))) {
    let delPaquete;
    try {
      delPaquete = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    } catch (e) {
      throw new Error(`la foto de los casos de un paquete no se deja leer: ${archivo} (${e.code || e.message})`);
    }
    // las dos fotos se comparan como una sola: tienen que salir del mismo pipeline de antes
    if (delPaquete.base_sha !== foto.base_sha) {
      throw new Error(`la foto de un paquete y la que viaja son de bases distintas (${String(delPaquete.base_sha).slice(0, 7)} y ${String(foto.base_sha).slice(0, 7)}): ${archivo} — se sacan juntas, con el mismo --base`);
    }
    for (const [nombre, medido] of Object.entries(delPaquete.casos || {})) {
      if (Object.prototype.hasOwnProperty.call(juntos, nombre)) throw new Error(`el caso «${nombre}» está en la foto que viaja y en la de un paquete (${archivo})`);
      juntos[nombre] = medido;
    }
    for (const c of casos.filter((x) => x.foto === archivo)) {
      if (!Object.prototype.hasOwnProperty.call(delPaquete.casos || {}, c.nombre)) throw new Error(`el caso «${c.nombre}» del paquete ${c.paquete} no está en la foto de su paquete (${archivo})`);
    }
  }
  return { ...foto, casos: juntos };
}

/**
 * Dónde se guarda la foto de un caso recién medido (`package-equivalence.js snapshot`). Con la ruta de siempre, la de un
 * caso de paquete va a la carpeta de su paquete y la del núcleo a la que viaja. Con `--out` a OTRA ruta es una foto de
 * ensayo: todo queda al lado de esa ruta (`<nombre>.<paquete>.json`) y la foto dorada de ningún paquete se toca.
 */
function destinoDeFoto(caso, out, fotoDorada) {
  if (!caso.paquete) return out;
  if (path.resolve(out) === path.resolve(fotoDorada)) return caso.foto;
  return path.join(path.dirname(out), `${path.basename(out, '.json')}.${caso.paquete}.json`);
}

const ordenado = (a) => (Array.isArray(a) ? a.slice().sort() : a);

/**
 * Mide un pipeline.js sobre un repo con un diff sin commitear.
 *
 * `story`: ruta de la story (default: la de los casos, `specs/story-eq.md` del repo); `null` = sin
 * `--story` (el grupo completitud queda vacío en los dos pipelines — así se miden los commits reales,
 * donde no hay story que valga). `orden` es el orden crudo por grupo: se informa, no es contrato —
 * las comparaciones usan `sinOrden()`.
 *
 * @returns {{ base, completitud, conditional, model_hints, reloop_model_hints, superficie, orden }}
 */
function medir({ pipeline, repo, files, story, env = {} }) {
  const storyPath = story === null ? null : (story || path.join(repo, 'specs', 'story-eq.md'));
  const ambiente = {
    PATH: process.env.PATH, LANG: 'en_US.UTF-8',
    HOME: env.HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-home-')),
    TYCON_SESSION_ID: 'equivalencia',
    // Sin `packs:` en el repo, el default sale de la configuración del arnés (el perfil del equipo dice
    // «todos»); con la HOME aislada el cargador no lo encuentra solo
    TYCON_GUIDES_DIR: env.TYCON_GUIDES_DIR || process.env.TYCON_GUIDES_DIR || require('./harness-path.js').rutaArnesHook().dir || '',
    // sin un arnés de quien llama, el default es el de la foto de la equivalencia («todos los instalados»): en la CI no hay perfil
    // ni enlace que lo diga. Con TYCON_GUIDES_DIR (la prueba del perfil real) manda la configuración de ese arnés.
    // (recortada, como la lee el cargador: sólo espacios = sin poner)
    ...(env.TYCON_GUIDES_DIR ? {} : { TYCON_PACKS_DEFAULT: (process.env.TYCON_PACKS_DEFAULT || '').trim() || 'all' }),
    ...env,
  };
  const args = [pipeline, 'advisors', '--repo', repo, '--cost-tier', 'lean'];
  if (storyPath) args.push('--story', storyPath);
  args.push('--files', ...files);
  const r = spawnSync(process.execPath, args,
    { encoding: 'utf8', env: ambiente, timeout: 180000, maxBuffer: 50 * 1024 * 1024 });
  if (r.error) throw new Error(`${pipeline} advisors no se pudo ejecutar (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new Error(`${pipeline} advisors salió ${r.status}:\n${r.stderr}`);
  const j = JSON.parse(r.stdout);
  const all = ordenado(j.all);
  const codigo = `const p = require(${JSON.stringify(pipeline)});
const all = ${JSON.stringify(all)}; const files = ${JSON.stringify(files)};
const superficie = {}; for (const a of all) superficie[a] = p.advisorAffectedByDelta(a, files).affected;
process.stdout.write(JSON.stringify({ superficie, reloop: p.reloopHintsFor(all, 2, 'lean') }));`;
  const r2 = spawnSync(process.execPath, ['-e', codigo], { encoding: 'utf8', env: ambiente, timeout: 60000 });
  if (r2.error) throw new Error(`superficie con ${pipeline}: node no se pudo ejecutar (${r2.error.code || r2.error.message})`);
  if (r2.status !== 0) throw new Error(`superficie con ${pipeline} salió ${r2.status}:\n${r2.stderr}`);
  const x = JSON.parse(r2.stdout);
  return {
    base: ordenado(j.base),
    completitud: ordenado(j.completitud),
    conditional: ordenado(j.conditional),
    model_hints: j.model_hints || null,
    reloop_model_hints: x.reloop || null,
    superficie: x.superficie,
    orden: { base: j.base, completitud: j.completitud, conditional: j.conditional },
  };
}

/** Lo que se compara (sin el orden crudo). */
function sinOrden(r) {
  const { orden, ...resto } = r;   // eslint-disable-line no-unused-vars
  return resto;
}

module.exports = { CASOS, NUCLEO, casosDePaquetes, todosLosCasos, leerFoto, destinoDeFoto, medir, sinOrden, git };
