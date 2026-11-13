'use strict';
/**
 * source-signals.test.js — el freno del camino corto que no deja guardar un cambio de dónde sale un dato o quién lo
 * ve: las señales que declara un paquete, buscadas sólo en las líneas que el carril agrega o borra, cada repo
 * contra su propia base; el freno de guardar que las usa, y la huella que levanta el click del dueño.
 *
 * Laboratorio por prueba: un repo con su `origin` (un repo desnudo local), `main` empujada y la rama del arreglo; la HOME
 * vacía con el registro del carril, como lo deja `marker.js adhoc set`. Las señales de la prueba tienen la forma de las del
 * paquete del stack; las del paquete real las mide T18 en packs.test.js.
 *
 * stable-data: ninguna hora se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const SS = () => require(path.join(SCRIPTS, 'lib', 'source-signals.js'));
const brake = () => require(path.join(SCRIPTS, 'lib', 'save-brake.js'));
const SID = 'ses-datos';
const RAMA = 'fix/el-boton';

const GIT_ENV = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.com' };
function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const tmp = (t, pre) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), pre)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function escribir(d, r, c) {
  const f = path.join(d, r);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, c);
}

/** Un repo con `origin`, `main` empujada con los archivos de `base`, y la rama del arreglo. */
function repo(t, base = {}, nombre = 'app') {
  const raiz = tmp(t, `datos-${nombre}-`);
  const origen = path.join(raiz, 'origen.git');
  const d = path.join(raiz, nombre);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  escribir(d, 'LEEME.md', 'hola\n');
  for (const [r, c] of Object.entries(base)) escribir(d, r, c);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  sh(d, 'remote', 'add', 'origin', origen);
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', '-b', RAMA);
  return d;
}

// las tres señales fuertes, con la forma de las del paquete del stack
const SENALES = [
  { id: 'proceso', strength: 'strong', files: ['**/*.ts', '**/*.tsx'], exclude: ['**/sdk.config.ts', '**/*.test.*', '**/*.spec.*'],
    pattern: '\\.process\\.\\w+\\(|processName\\s*:|executeQuery\\(|raiseEvent\\(|getParameters\\(', says: 'una llamada a un proceso' },
  { id: 'rol-en-pantalla', strength: 'strong', files: ['**/*.ts', '**/*.tsx'], exclude: ['**/*.test.*', '**/*.spec.*'],
    pattern: '\\b(?:tieneRol\\w*|esAdmin\\w*|hasRole\\w*)\\(|\\broles\\.(?:some|includes|find)\\(', says: 'un chequeo de rol en la pantalla' },
  { id: 'autorizacion', strength: 'strong', files: ['**/*.cs'], exclude: ['**/*Tests/**', '**/*.Tests.cs'],
    pattern: 'RequireAuthorization|\\[Authorize|AllowAnonymous|RequireRole|\\bRoles\\s*=|\\bPolicy\\s*=|AddPolicy|IsInRole|RoleConstants',
    says: 'la autorización de un endpoint del backend' },
];
const conDebiles = (lista = SENALES) => [...lista, ...SS().DEBILES];

/** El carril de la prueba sobre `repos`, con la base de cada uno anotada. */
function carril(repos, extra = {}) {
  return { reason: 'el botón del comprobante', maxFiles: 8, files: [], bases: Object.fromEntries(repos.map((r) => [r, { sha: sh(r, 'rev-parse', 'origin/main'), traida: true }])), ...extra };
}
const buscar = (a, senales = conDebiles(), o = {}) => SS().buscar(a, senales, { sinSeguir: true, ...o });
const fuertes = (r) => r.hallazgos.filter((h) => h.strength === 'strong');

// 🔴 Falla con: una señal contada en una línea que el carril no tocó (el freno leería el archivo entero).
test('T6 Signals_SoloLoPropioDelCarril @story-8.196 @ac-6', (t) => {
  const d = repo(t, { 'src/Detalle.tsx': 'const a = sdk.process.start({ processName: "Viejo" });\nexport const titulo = "Hola";\n' });
  escribir(d, 'src/Detalle.tsx', 'const a = sdk.process.start({ processName: "Viejo" });\nexport const titulo = "Chau";\n');
  const r = buscar(carril([d]));
  assert.deepStrictEqual(r.fallas, []);
  assert.deepStrictEqual(fuertes(r), [], 'la llamada ya estaba en la base: no es del carril');
});

// 🔴 Falla con: el caso real sin freno: un formulario que pasa a pedir el dato a un proceso.
test('T7 Signals_ProcesoAgregado_Frena @story-8.196 @ac-7 @ac-8', (t) => {
  const d = repo(t, { 'src/pantallas/Detalle.tsx': 'import { pedirComprobante } from "../servicios";\nconst c = await pedirComprobante(id);\n' });
  escribir(d, 'src/pantallas/Detalle.tsx', 'import { sdk } from "../sdk";\nconst c = await sdk.process.start({ processName: "Comprobante", id });\n');
  const f = fuertes(buscar(carril([d])));
  assert.strictEqual(f.length, 1, JSON.stringify(f));
  assert.deepStrictEqual([f[0].id, f[0].file, f[0].line, f[0].borrada], ['proceso', 'src/pantallas/Detalle.tsx', 2, false]);
  assert.strictEqual(f[0].says, 'una llamada a un proceso');
});

test('T8 Signals_ChequeoDeRolBorrado_Frena @story-8.196 @ac-7', (t) => {
  const d = repo(t, { 'src/Boton.tsx': 'export function Boton({ roles }) {\n  if (!tieneRolAdministrativo(roles)) return null;\n  return <b/>;\n}\n' });
  escribir(d, 'src/Boton.tsx', 'export function Boton({ roles }) {\n  return <b/>;\n}\n');
  const f = fuertes(buscar(carril([d])));
  assert.deepStrictEqual(f.map((h) => [h.id, h.line, h.borrada]), [['rol-en-pantalla', 2, true]]);
});

test('T9 Signals_AutorizacionCambiada_Frena @story-8.196 @ac-7', (t) => {
  const d = repo(t, { 'Api/Endpoints.cs': 'app.MapGet("/deudas", H).RequireAuthorization(RoleConstants.Gestor);\n' });
  escribir(d, 'Api/Endpoints.cs', 'app.MapGet("/deudas", H).RequireAuthorization(RoleConstants.Lector);\n');
  const f = fuertes(buscar(carril([d])));
  assert.deepStrictEqual(f.map((h) => [h.id, h.borrada]).sort(), [['autorizacion', false], ['autorizacion', true]]);
});

test('T10 Signals_EndpointNuevoConRoles_Frena @story-8.196 @ac-9', (t) => {
  const d = repo(t, { 'Api/Endpoints.cs': '// los endpoints\n', 'src/servicios/pagos.ts': 'export const x = 1;\n' });
  escribir(d, 'Api/Endpoints.cs', '// los endpoints\napp.MapPost("/pagos", P).RequireAuthorization("Pagos");\n');
  escribir(d, 'src/servicios/permisosDePago.ts', 'export const puede = (u) => u.roles.includes("pagos");\n');
  const f = fuertes(buscar(carril([d])));
  assert.deepStrictEqual(f.map((h) => h.id).sort(), ['autorizacion', 'rol-en-pantalla']);
});

test('T13 Signals_ExcluidosConfigPruebaMd_NoCuentan @story-8.196 @ac-11', (t) => {
  const d = repo(t);
  escribir(d, 'src/sdk.config.ts', 'export const c = { processName: "x" };\n');
  escribir(d, 'src/Detalle.test.ts', 'sdk.process.start({ processName: "x" });\n');
  escribir(d, 'docs/proceso.md', 'Se llama con `sdk.process.start({ processName })`.\n');
  assert.deepStrictEqual(fuertes(buscar(carril([d]))), []);
});

test('T14 Signals_SinPaquete_SoloDebiles @story-8.196 @ac-12', (t) => {
  const d = repo(t);
  escribir(d, 'src/roles.ts', 'sdk.process.start({ processName: "x" });\n');
  const r = buscar(carril([d]), SS().DEBILES);
  assert.deepStrictEqual(fuertes(r), []);
  assert.deepStrictEqual(r.hallazgos.map((h) => [h.strength, h.file]), [['weak', 'src/roles.ts']]);
  // y sin paquetes instalados, cargar devuelve sólo las del núcleo
  const vacio = tmp(t, 'datos-packs-');
  const c = SS().cargar({ repo: d, packsDir: vacio });
  assert.deepStrictEqual(c.senales.map((s) => s.strength), SS().DEBILES.map(() => 'weak'));
});

// 🔴 Falla con: el freno que sólo mira lo agregado, o lo preparado para guardar, o lo que git ya sigue.
test('T24 Signals_LineasDelDiff_AgregadaBorradaYArchivoNuevo @story-8.196 @ac-6 @ac-7', (t) => {
  const d = repo(t, { 'src/a.tsx': 'uno\ndos\nif (esAdmin(u)) x();\ntres\n', 'src/b.tsx': 'b\n' });
  escribir(d, 'src/a.tsx', 'uno\nexecuteQuery("x");\ndos\ntres\n');
  escribir(d, 'src/b.tsx', 'b\nraiseEvent("y");\n');
  sh(d, 'add', 'src/b.tsx');
  escribir(d, 'src/nuevo.tsx', 'const p = getParameters("z");\n');
  const f = fuertes(buscar(carril([d]))).map((h) => [h.file, h.line, h.borrada]).sort();
  assert.deepStrictEqual(f, [['src/a.tsx', 2, false], ['src/a.tsx', 3, true], ['src/b.tsx', 2, false], ['src/nuevo.tsx', 1, false]]);
});

// 🔴 Falla con: un renglón del tramo que empieza como una cabecera («-- », «++ ») leído como otro archivo, o el nombre
// de un archivo con espacio (git le pone un tab al final) o entre comillas: la señal se pierde sin aviso.
test('T24 Signals_LineasDelDiff_CabecerasYNombresRaros @story-8.196 @ac-6 @ac-7', () => {
  // como lo pide el lector: con --no-prefix, la ruta va tal cual en las cabeceras
  const diff = [
    'diff --git src/a.ts src/a.ts',
    'index 1111111..2222222 100644',
    '--- src/a.ts',
    '+++ src/a.ts',
    '@@ -2,2 +1,0 @@',
    '--- keep',
    '-const y = tieneRol("x");',
    '@@ -5,0 +4,2 @@',
    '+++ z',
    '+executeQuery("q");',
    'diff --git src/my file.ts src/my file.ts',
    '--- src/my file.ts\t',
    '+++ src/my file.ts\t',
    '@@ -0,0 +1 @@',
    '+executeQuery("e");',
    'diff --git "src/t\\"x.ts" "src/t\\"x.ts"',
    '--- "src/t\\"x.ts"',
    '+++ "src/t\\"x.ts"',
    '@@ -1 +1 @@',
    '-a',
    '+executeQuery("t");',
    'diff --git img/logo.png img/logo.png',
    'Binary files img/logo.png and img/logo.png differ',
  ].join('\n');
  const l = SS().lineasDelDiff(diff);
  assert.deepStrictEqual(l.map((x) => [x.file, x.line, x.borrada, x.texto]), [
    ['src/a.ts', 2, true, '-- keep'],
    ['src/a.ts', 3, true, 'const y = tieneRol("x");'],
    ['src/a.ts', 4, false, '++ z'],
    ['src/a.ts', 5, false, 'executeQuery("q");'],
    ['src/my file.ts', 1, false, 'executeQuery("e");'],
    ['src/t"x.ts', 1, true, 'a'],
    ['src/t"x.ts', 1, false, 'executeQuery("t");'],
  ]);
  assert.deepStrictEqual(l.binarios, ['img/logo.png'], 'el binario no se midió, y se dice');
});

// 🔴 Falla con: un archivo con espacio en el nombre, o la configuración del dev sin los prefijos a/ y b/, que dejan la
// señal fuera de los archivos del paquete.
test('T24 Signals_NombreConEspacioYSinPrefijos_Frena @story-8.196 @ac-7', (t) => {
  const d = repo(t, { 'src/my file.ts': 'export const a = 1;\n', 'src/a.ts': 'export const b = 1;\n' });
  sh(d, 'config', 'diff.noprefix', 'true');
  escribir(d, 'src/my file.ts', 'export const a = 1;\nconst c = sdk.process.start(x);\n');
  escribir(d, 'src/a.ts', 'export const b = 1;\nif (esAdmin(u)) x();\n');
  const f = fuertes(buscar(carril([d]))).map((h) => [h.id, h.file]).sort();
  assert.deepStrictEqual(f, [['proceso', 'src/my file.ts'], ['rol-en-pantalla', 'src/a.ts']]);
});

// 🔴 Falla con: un archivo renombrado y editado, medido sólo con su nombre nuevo (la línea borrada al moverlo no se ve),
// o un archivo sólo movido que cuenta todas sus señales como agregadas.
test('T24 Signals_ArchivoRenombrado_MideLoQueCambio @story-8.196 @ac-6 @ac-7', (t) => {
  const cuerpo = 'namespace Api;\npublic class Users {\n  [Authorize(Roles = "Admin")]\n  public void Get() {}\n  public void Put() {}\n  public void Del() {}\n}\n';
  const d = repo(t, { 'src/Api/UsersController.cs': cuerpo });
  sh(d, 'mv', 'src/Api/UsersController.cs', 'src/Api/PeopleController.cs');
  escribir(d, 'src/Api/PeopleController.cs', cuerpo.replace('  [Authorize(Roles = "Admin")]\n', ''));
  sh(d, 'add', '-A');
  const f = fuertes(buscar(carril([d])));
  assert.deepStrictEqual(f.map((h) => [h.id, h.borrada]), [['autorizacion', true]], JSON.stringify(f));
  // sólo movido: nada cambió de dónde sale un dato
  const e = repo(t, { 'src/Api/UsersController.cs': cuerpo }, 'movido');
  sh(e, 'mv', 'src/Api/UsersController.cs', 'src/Api/PeopleController.cs');
  assert.deepStrictEqual(fuertes(buscar(carril([e]))), []);
});

// 🔴 Falla con: la señal preparada para guardar y sacada sólo de la copia de trabajo: el commit la guarda sin freno.
test('T24 Signals_PreparadoParaGuardar_Cuenta @story-8.196 @ac-6', (t) => {
  const d = repo(t, { 'src/a.ts': 'export const a = 1;\n' });
  escribir(d, 'src/a.ts', 'export const a = 1;\nexport const b = sdk.process.start(x);\n');
  sh(d, 'add', 'src/a.ts');
  escribir(d, 'src/a.ts', 'export const a = 1;\n');
  const f = fuertes(buscar(carril([d])));
  assert.deepStrictEqual(f.map((h) => [h.id, h.file, h.borrada]), [['proceso', 'src/a.ts', false]]);
});

// 🔴 Falla con: un git caído que se lee como «sin señales» (el freno fallaría abierto).
test('T30 Signals_GitNoContestaOExcepcion_NoGuarda @story-8.196 @ac-6', (t) => {
  const d = repo(t);
  escribir(d, 'src/a.tsx', 'executeQuery("x");\n');
  const a = carril([d]);
  const roto = buscar(a, conDebiles(), { git: () => { throw new Error('git no contestó'); } });
  assert.ok(roto.fallas.length, 'git caído es una falla');
  // el freno: sin medir no guarda
  const h = tmp(t, 'datos-home-');
  const freno = brake().frenoDeDatos(a, SID, h, [d], { medir: () => { throw new Error('se rompió adentro'); } });
  assert.ok(freno && freno.texto, JSON.stringify(freno));
  assert.match(freno.texto, /no pude medir/);
  // un repo sin base (sin origin): mide contra el último commit y lo avisa
  const solo = tmp(t, 'datos-solo-');
  sh(solo, 'init', '-q', '-b', 'main');
  escribir(solo, 'x.md', 'x\n');
  sh(solo, 'add', '-A');
  sh(solo, 'commit', '-q', '-m', 'x');
  escribir(solo, 'src/a.tsx', 'executeQuery("x");\n');
  const r = buscar({ reason: 'x', files: [path.join(solo, 'src', 'a.tsx')], bases: {} });
  assert.strictEqual(fuertes(r).length, 1);
  assert.ok(r.avisos.some((m) => /no se midió/.test(m)), r.avisos.join('\n'));
  // y el aviso queda en el registro del freno
  const hs = home(t);
  frenar({ reason: 'x', files: [path.join(solo, 'src', 'a.tsx')], bases: {} }, hs, [solo]);
  const registro = fs.readFileSync(path.join(hs, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  assert.ok(registro.split('\n').some((l) => /no se midió/.test(l) && /"status":"unknown"/.test(l)), registro);
});

// 🔴 Falla con: un archivo nuevo que no se puede leer, saltado en silencio: el freno lo da por limpio y guarda.
test('T30 Signals_ArchivoNuevoIlegible_NoGuarda @story-8.196 @ac-6', (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return console.log('⏭ un archivo sin permiso de lectura: NO MEDIDO — en Windows o como root se lee igual');
  const d = repo(t);
  escribir(d, 'src/nuevo.ts', 'executeQuery("x");\n');
  const f = path.join(d, 'src', 'nuevo.ts');
  fs.chmodSync(f, 0o000);
  t.after(() => { try { fs.chmodSync(f, 0o644); } catch (_) { /* el laboratorio ya se borró */ } });
  const r = buscar(carril([d]));
  assert.ok(r.fallas.some((m) => /src\/nuevo\.ts/.test(m)), JSON.stringify(r));
});

test('T31 Signals_DosRepos_CadaUnoConSuBase @story-8.196 @ac-6', (t) => {
  const front = repo(t, { 'src/a.tsx': 'executeQuery("vieja");\n' }, 'front');
  const back = repo(t, { 'Api/E.cs': 'app.MapGet("/a", A).RequireAuthorization("Vieja");\n' }, 'back');
  escribir(front, 'src/a.tsx', 'executeQuery("vieja");\nexecuteQuery("nueva");\n');
  escribir(back, 'Api/E.cs', 'app.MapGet("/a", A).RequireAuthorization("Vieja");\napp.MapGet("/b", B).RequireAuthorization("Nueva");\n');
  const f = fuertes(buscar(carril([front, back])));
  assert.deepStrictEqual(f.map((h) => [path.basename(h.repo), h.line, /nueva|Nueva/.test(h.texto)]).sort(), [['back', 2, true], ['front', 2, true]]);
});

test('T32 Signals_RuidoMedido_NoCuenta @story-8.196 @ac-6 @ac-7', (t) => {
  const d = repo(t);
  escribir(d, 'src/Modal.tsx', '<div role="dialog" aria-modal="true">No tenés permiso para ver esto</div>\n');
  escribir(d, 'Api/Consultas.cs', 'var r = executeQuery("select 1");\n');
  assert.deepStrictEqual(fuertes(buscar(carril([d]))), []);
});

test('T17 Signals_SenalRota_LoDiceYNoFrena @story-8.196 @ac-15', () => {
  const v = SS().validarSenales([{ strength: 'strong', pattern: 'x' }, { id: 'mala', strength: 'strong', pattern: '(' }, { id: 'sin', strength: 'strong' }, SENALES[0]], 'acme');
  assert.deepStrictEqual(v.validas.map((s) => s.id), ['proceso']);
  assert.strictEqual(v.avisos.length, 3);
  for (const m of v.avisos) assert.match(m, /acme/);
  assert.deepStrictEqual(SS().validarSenales('no es lista', 'acme').validas, []);
});

// ── el freno de guardar ─────────────────────────────────────────────────────────────────────────────────────────────
function home(t) {
  const h = tmp(t, 'datos-home-');
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  return h;
}
const conSenales = (lista) => ({ cargar: () => ({ senales: conDebiles(lista), avisos: [] }) });
const frenar = (a, h, repos, o = {}) => brake().frenoDeDatos(a, SID, h, repos, { sinSeguir: true, ...conSenales(SENALES), ...o });

test('T11 Signals_DeclaroQueNo_LoDice @story-8.196 @ac-7', (t) => {
  const d = repo(t);
  escribir(d, 'src/pantallas/Detalle.tsx', 'const c = sdk.process.start({ processName: "Comprobante" });\n');
  const h = home(t);
  const r = frenar(carril([d], { datos: 'sin-cambio' }), h, [d]);
  assert.ok(r && r.texto, JSON.stringify(r));
  assert.match(r.texto, /cambia de dónde sale un dato o quién lo ve/);
  assert.match(r.texto, /una llamada a un proceso, src\/pantallas\/Detalle\.tsx:1/);
  assert.match(r.texto, /va por historia/);
  assert.match(r.texto, /declaraste que no/);
  assert.match(r.texto, /adhoc allow-data-change --changed/);
  const sin = frenar(carril([d]), h, [d]);
  assert.doesNotMatch(sin.texto, /declaraste que no/);
});

test('T12 Signals_SoloNombreDeArchivo_AvisaYGuarda @story-8.196 @ac-10', (t) => {
  const d = repo(t, { 'src/viejo/RoleGuard.tsx': 'export const g = 1;\n' });
  escribir(d, 'src/PermisosTab.tsx', 'export const titulo = "Permisos";\n');
  sh(d, 'mv', 'src/viejo/RoleGuard.tsx', 'src/RoleGuard.tsx');
  const r = frenar(carril([d]), home(t), [d]);
  assert.ok(r && !r.texto, JSON.stringify(r));
  assert.match(r.mostrar, /PermisosTab\.tsx/);
  assert.match(r.mostrar, /RoleGuard\.tsx/, 'un archivo movido, sin líneas cambiadas, también');
});

// 🔴 Falla con: un click que cubre más de lo que se mostró: otra línea, la misma editada o repetida.
test('T26 Cuadro_DejarPasar_OtraLineaConSenal_FrenaDeNuevo @story-8.196 @ac-13', (t) => {
  const d = repo(t, { 'src/a.tsx': 'uno\ndos\ntres\n' });
  escribir(d, 'src/a.tsx', 'uno\nexecuteQuery("x");\ndos\ntres\n');
  const h = home(t);
  const a = carril([d]);
  const primero = frenar(a, h, [d]);
  assert.ok(primero.texto && primero.huella, JSON.stringify(primero));
  const permitido = { ...a, datosPermitido: { huella: primero.huella } };
  assert.strictEqual(frenar(permitido, h, [d]), null, 'con el click sobre esa huella, guarda');
  // la corre de lugar: guarda
  escribir(d, 'src/a.tsx', 'uno\ndos\nexecuteQuery("x");\ntres\n');
  assert.strictEqual(frenar(permitido, h, [d]), null, 'mover la línea no vence el click');
  // otra línea, la misma editada, la misma repetida: frena
  for (const c of ['uno\ndos\nexecuteQuery("x");\nraiseEvent("y");\ntres\n', 'uno\ndos\nexecuteQuery("otra");\ntres\n', 'uno\nexecuteQuery("x");\ndos\nexecuteQuery("x");\ntres\n']) {
    escribir(d, 'src/a.tsx', c);
    const r = frenar(permitido, h, [d]);
    assert.ok(r && r.texto, c);
    // las señales cambiaron entre el click y la repetición: otra huella, otro código del cuadro, y el carril la anota
    assert.ok(r.huella && r.huella !== primero.huella, c);
    const anotado = JSON.parse(fs.readFileSync(path.join(h, '.claude', '.tycon-pipeline', 'adhoc', `${SID}.json`), 'utf8'));
    assert.strictEqual(anotado.frenoDatos.huella, r.huella, c);
  }
});

// El freno entero, como lo corre el gancho de guardar: el paquete de la prueba se instala en una carpeta propia.
function conPaquete(t) {
  const dir = tmp(t, 'datos-packs-');
  fs.mkdirSync(path.join(dir, 'acme', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'acme', 'agents', 'rev-acme.md'), '---\nname: rev-acme\n---\n# rev-acme\n');
  fs.writeFileSync(path.join(dir, 'acme', 'pack.json'), JSON.stringify({ name: 'acme', description: 'señales de la prueba',
    reviewers: [{ agent: 'rev-acme', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'lean', prefixes: ['ACM'] }],
    shortPathSignals: SENALES }));
  const antes = { dir: process.env.TYCON_PACKS_DIR, def: process.env.TYCON_PACKS_DEFAULT };
  process.env.TYCON_PACKS_DIR = dir;
  process.env.TYCON_PACKS_DEFAULT = 'all';
  t.after(() => {
    for (const [k, v] of [['TYCON_PACKS_DIR', antes.dir], ['TYCON_PACKS_DEFAULT', antes.def]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}
function carrilFirmado(h, a) {
  const estado = path.join(h, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'adhoc'), { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(estado, 'adhoc', `${SID}.json`), JSON.stringify({ maxFiles: 8, declaredAt: ts, lastTouch: ts, firmadaEn: ts, ...a }));
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify({ ts, name: 'adhoc-lane-signed', status: 'ok', destino: SID })}\n`);
  return path.join(estado, 'adhoc', `${SID}.json`);
}
// un pedido: los frenos del carril lo miran como al commit, y es lo que pregunta (desde que la persona aprueba el pedido
// y no el commit, el commit del carril pasa sin pregunta)
const guardar = (d, h) => brake().decidir({ command: 'gh pr create --fill', cwd: d, sid: SID, home: h });

// 🔴 Falla con: el riesgo que frena antes que los datos, o el click de los datos que también saltea el riesgo.
test('T16 SaveBrake_DatosAntesQueElRiesgo_YElClickNoSalteaElRiesgo @story-8.196 @ac-13 @ac-14', (t) => {
  conPaquete(t);
  const d = repo(t, { 'src/auth/sesion.ts': 'export const a = 1;\n' });
  escribir(d, 'src/auth/sesion.ts', 'export const a = 1;\nexport const b = executeQuery("x");\n');
  const h = home(t);
  const archivo = carrilFirmado(h, { reason: 'la sesión', datos: 'sin-cambio', files: [path.join(d, 'src', 'auth', 'sesion.ts')], bases: { [d]: { sha: sh(d, 'rev-parse', 'origin/main'), traida: true } } });
  const primero = guardar(d, h);
  assert.ok(primero && primero.texto, JSON.stringify(primero));
  assert.match(primero.texto, /cambia de dónde sale un dato o quién lo ve/, 'los datos frenan antes que el riesgo');
  assert.doesNotMatch(primero.texto, /faltan los revisores/);
  // con el click del dueño sobre esa huella, el riesgo sigue frenando
  const a = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  fs.writeFileSync(archivo, JSON.stringify({ ...a, datosPermitido: { huella: a.frenoDatos.huella } }));
  const despues = guardar(d, h);
  assert.ok(despues && despues.texto, JSON.stringify(despues));
  assert.match(despues.texto, /faltan los revisores y el pase/);
});

// 🔴 Falla con: el click que no deja guardar, o los datos medidos antes que la pantalla.
test('T16 SaveBrake_PantallaAntesQueLosDatos_YConElClickGuarda @story-8.196 @ac-13 @ac-14', (t) => {
  conPaquete(t);
  const d = repo(t, { 'src/servicios/comprobante.ts': 'export const a = 1;\n', 'src/pantallas/Detalle.tsx': 'export const D = () => <p>hola</p>;\n' });
  escribir(d, 'src/servicios/comprobante.ts', 'export const a = 1;\nexport const b = executeQuery("x");\n');
  const h = home(t);
  const files = [path.join(d, 'src', 'servicios', 'comprobante.ts')];
  const bases = { [d]: { sha: sh(d, 'rev-parse', 'origin/main'), traida: true } };
  // con una pantalla sin su maqueta, frena la pantalla y todavía no se miden los datos
  escribir(d, 'src/pantallas/Detalle.tsx', 'export const D = () => <p>chau</p>;\n');
  let archivo = carrilFirmado(h, { reason: 'el comprobante', datos: 'sin-cambio', files: [...files, path.join(d, 'src', 'pantallas', 'Detalle.tsx')], bases });
  const conPantalla = guardar(d, h);
  assert.ok(conPantalla && conPantalla.texto, JSON.stringify(conPantalla));
  assert.match(conPantalla.texto, /toca una pantalla/);
  assert.strictEqual(JSON.parse(fs.readFileSync(archivo, 'utf8')).frenoDatos, undefined, 'los datos todavía no se midieron');
  // sin la pantalla: frenan los datos, y con el click sobre esa huella guarda (pregunta como siempre)
  sh(d, 'checkout', '--', 'src/pantallas/Detalle.tsx');
  archivo = carrilFirmado(h, { reason: 'el comprobante', datos: 'sin-cambio', files, bases });
  const datos = guardar(d, h);
  assert.match((datos && datos.texto) || '', /cambia de dónde sale un dato/, JSON.stringify(datos));
  const a = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  fs.writeFileSync(archivo, JSON.stringify({ ...a, datosPermitido: { huella: a.frenoDatos.huella } }));
  const guarda = guardar(d, h);
  assert.ok(guarda && !guarda.texto && guarda.pregunta, JSON.stringify(guarda));
});

// ── el paquete roto, nombrado en la falla ───────────────────────────────────────────────────────────────────────────

/** Un paquete de juguete en `dir/<nombre>` con un revisor; `extra` le cambia campos (una bandera inválida, por ejemplo). */
function paqueteDeJuguete(dir, nombre, extra = {}) {
  fs.mkdirSync(path.join(dir, nombre, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, nombre, 'agents', 'rev-acme.md'), '---\nname: rev-acme\n---\n# rev-acme\n');
  fs.writeFileSync(path.join(dir, nombre, 'pack.json'), JSON.stringify({ name: nombre, description: 'señales de la prueba',
    reviewers: [{ agent: 'rev-acme', group: 'base', surface: { paths: ['**/*.cs'] }, depth: 'lean', prefixes: ['ACM'], ...extra }] }));
}
/** `buscar` con las señales cargadas de `packsDir`, como las carga el freno de guardar; `env` se pone sólo mientras mide. */
function fallaDeCarga(t, packsDir, env = {}) {
  const antes = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  require(path.join(SCRIPTS, 'lib', 'packs.js')).resetCache();
  const d = repo(t);
  escribir(d, 'src/a.tsx', 'export const a = 1;\n');
  const r = buscar(carril([d]), (r2) => SS().cargar({ repo: r2, packsDir }).senales);
  assert.strictEqual(r.fallas.length, 1, JSON.stringify(r));
  return r.fallas[0];
}
const PRIMER_RENGLON = /no pude leer las líneas cambiadas en .* \(🛑 paquetes de revisores: \d+ error\(es\)\. .*\)$/;

// 🔴 Falla con: «1 error(es)» sin decir qué paquete, qué revisor ni por qué; o un campo que el error no trae.
test('T1 SourceSignals_PackError_KeepsFirstErrorInFailure @story-8.268 @ac-1 @ac-15', (t) => {
  const uno = tmp(t, 'datos-packs-uno-');
  paqueteDeJuguete(uno, 'acme', { when: { detection: 'noExiste' } });
  const conRevisor = fallaDeCarga(t, uno, { TYCON_PACKS_DEFAULT: 'all' });
  assert.ok(conRevisor.includes(`${path.join(uno, 'acme', 'pack.json')} · revisor rev-acme · when.detection: la bandera «noExiste»`), conRevisor);
  assert.doesNotMatch(conRevisor, /· clave |y \d+ más|undefined/);

  const conClave = fallaDeCarga(t, (() => { const d = tmp(t, 'datos-packs-default-'); paqueteDeJuguete(d, 'acme', { when: { detection: 'csModified' } }); return d; })(), { TYCON_PACKS_DEFAULT: 'Mal_Nombre' });
  assert.match(conClave, /— variable de entorno TYCON_PACKS_DEFAULT · clave packs\.default · "Mal_Nombre" no es un nombre de paquete/);
  assert.doesNotMatch(conClave, /· revisor |undefined/);

  const dos = tmp(t, 'datos-packs-dos-');
  paqueteDeJuguete(dos, 'acme', { when: { detection: 'noExiste' } });
  paqueteDeJuguete(dos, 'beta', { when: { detection: 'tampoco' } });
  const conDos = fallaDeCarga(t, dos, { TYCON_PACKS_DEFAULT: 'all' });
  assert.ok(conDos.includes(`${path.join(dos, 'acme', 'pack.json')} · revisor rev-acme`), conDos);
  assert.match(conDos, /\(y 1 más\)\)$/);
  assert.doesNotMatch(conDos, /beta/, 'sólo el primero; los demás, contados');

  const sinCarpeta = fallaDeCarga(t, path.join(uno, 'no-hay'), { TYCON_PACKS_DEFAULT: 'all' });
  assert.ok(sinCarpeta.includes(`— ${path.join(uno, 'no-hay')} · no se pudo leer la carpeta de paquetes (ENOENT)`), sinCarpeta);

  // lo que no es un PackError con su lista queda como hoy: el primer renglón
  const d = repo(t);
  escribir(d, 'src/a.tsx', 'export const a = 1;\n');
  const comun = buscar(carril([d]), () => { throw new Error('se rompió\nsegundo renglón'); });
  assert.deepStrictEqual(comun.fallas, [`camino corto: no pude leer las líneas cambiadas en ${d} (se rompió)`]);
  const { PackError } = require(path.join(SCRIPTS, 'lib', 'packs.js'));
  const vacio = buscar(carril([d]), () => { throw new PackError([]); });
  assert.strictEqual(vacio.fallas.length, 1);
  assert.match(vacio.fallas[0], PRIMER_RENGLON);
  assert.doesNotMatch(vacio.fallas[0], / — |undefined/);
  // un motivo que trae el mensaje de otro error (un JSON roto, un módulo que no carga) no le suma renglones a la falla
  const largo = buscar(carril([d]), () => { throw new PackError([{ archivo: '/x/pack.json', revisor: null, motivo: 'JSON inválido o ilegible: Unexpected token\n  "x": }\nis not valid JSON' }]); });
  assert.strictEqual(largo.fallas[0].split('\n').length, 1, largo.fallas[0]);
  assert.match(largo.fallas[0], /— \/x\/pack\.json · JSON inválido o ilegible: Unexpected token\)$/);
  const sinMotivo = buscar(carril([d]), () => { throw new PackError([{ archivo: '/x/pack.json', revisor: null }]); });
  assert.doesNotMatch(sinMotivo.fallas[0], /undefined/);
  const sinArchivo = buscar(carril([d]), () => { throw new PackError([{ revisor: null, motivo: 'sin archivo' }]); });
  assert.match(sinArchivo.fallas[0], PRIMER_RENGLON);
  assert.doesNotMatch(sinArchivo.fallas[0], / — |undefined|sin archivo/);
});

// ── los textos ──────────────────────────────────────────────────────────────────────────────────────────────────────
// el texto en un renglón: las guías cortan las frases a 120 columnas
const leer = (r) => fs.readFileSync(path.join(RAIZ, r), 'utf8').replace(/\s+/g, ' ');

test('T19 Textos_LaExcepcionEnLosDosReadme @story-8.196 @ac-16', () => {
  const es = leer('README.es.md');
  const i = es.indexOf('Una función chica de riesgo alto también va por camino corto');
  assert.ok(i > 0);
  const despues = es.slice(i, i + 900);
  assert.match(despues, /de dónde sale un dato o quién lo puede ver va por historia/);
  assert.match(despues, /ante la duda, historia/i);
  const en = leer('README.md');
  const j = en.search(/Risk is another matter/);
  assert.ok(j > 0);
  assert.match(en.slice(j, j + 1200), /where a piece of data comes from, or who can see it, goes through a story/);
  assert.match(en.slice(j, j + 1200), /when in doubt, a story/i);
});

test('T20 Textos_GuiasYSkill_PreguntaYFreno @story-8.196 @ac-17', () => {
  for (const r of ['guides/que-hace-el-arnes.md', 'guides/coordination.md', 'guides/firmas-del-arnes.md', 'skills/tycon-pipeline/SKILL.md']) {
    const txt = leer(r);
    assert.match(txt, /de dónde sale(n)? (un dato|los datos)/, `${r}: la pregunta`);
    assert.match(txt, /click del dueño/, `${r}: lo destraba el click del dueño`);
    assert.match(txt, /[Aa]nte la duda, historia/, `${r}: la regla`);
  }
  assert.match(leer('guides/coordination.en.md'), /when in doubt, a story/i);
  assert.match(leer('guides/firmas-del-arnes.md'), /adhoc-lane:datos/);
  assert.match(leer('guides/coordination.md'), /«Sí, aprobar».*«No»|«No».*«Sí, aprobar»/s);
});
