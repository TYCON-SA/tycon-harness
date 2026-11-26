'use strict';

/**
 * disk-notice.test.js — con el disco libre por debajo del umbral, el arranque dice cuánto queda y las cinco cosas de la
 * lista conocida que más ocupan, con el comando que limpia cada una; por encima, calla (scripts/hooks/disk-notice.js).
 * Nunca corre un comando de limpieza.
 *
 * Dos capas:
 *   · las funciones, con el disco, la lista y la medición de juguete: el umbral, las cinco más grandes, «no medido»
 *     cuando la medición no vuelve a tiempo, una medición por día, y la lista de cada sistema;
 *   · el gancho como proceso, con un HOME de prueba, el disco fingido (TYCON_DISK_NOTICE_TEST_DISK) y, delante en el PATH,
 *     programas de juguete con el nombre de cada comando de limpieza que anotan si alguien los llama.
 *
 * Correr: node --test scripts/tests/disk-notice.test.js
 */
// stable-data: las fechas de los casos son fijas; el gancho como proceso mide con la de ahora y sólo se mira si repite.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO, 'scripts', 'hooks', 'disk-notice.js');
const { loadHogs, hogsFor, run, noticeLine } = require(HOOK);
const { stateDir } = require(path.join(REPO, 'scripts', 'setup', 'harness', 'tycon-home.js'));

const WIN = process.platform === 'win32';
const GB = 1024 * 1024 * 1024;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'disk-notice-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let serial = 0;
function lugar() {
  const base = path.join(tmp, `l${++serial}`);
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { base, home, state: path.join(base, 'disk-notice-last.json') };
}

/** Seis cosas de juguete, cada una con su carpeta en el HOME y su comando, y la medición que dice cuánto ocupa cada una. */
function juguete(home, tamanos = { a: 6, b: 5, c: 4, d: 3, e: 2, f: 1 }) {
  const hogs = Object.keys(tamanos).map((id) => {
    fs.mkdirSync(path.join(home, id), { recursive: true });
    return { id, name: `la cosa ${id}`, paths: { [process.platform]: [`~/${id}`] }, clean: `limpiar-${id} --all` };
  });
  const llamadas = [];
  const measure = async (paths) => { llamadas.push(paths); const id = path.basename(paths[0]); return tamanos[id] === null ? null : tamanos[id] * GB; };
  return { hogs, measure, llamadas };
}

const DIA = new Date('2026-11-25T13:00:00Z').getTime();
const disco = (porcentaje) => ({ free: porcentaje * 10 * GB, total: 1000 * GB });

test('T11 8.164-DebajoDelUmbral_Avisa @story-8.164 @ac-11 — con el disco al 10 % avisa con las cinco cosas que más ocupan y sus comandos; al 40 %, silencio', async () => {
  const L = lugar();
  const { hogs, measure, llamadas } = juguete(L.home);
  const bajo = await run({ home: L.home, now: DIA, platform: process.platform, disk: disco(10), threshold: 15, hogs, measure, stateFile: L.state });
  assert.ok(bajo.line, 'avisa');
  assert.match(bajo.line, /disco: quedan 100 GB libres de 1000 GB \(10 %\), menos del 15 %/);
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.ok(bajo.line.includes(`la cosa ${id}`) && bajo.line.includes(`limpiar-${id} --all`), `${id}: ${bajo.line}`);
  assert.ok(!bajo.line.includes('la cosa f'), 'sólo las cinco más grandes');
  assert.ok(bajo.line.indexOf('la cosa a') < bajo.line.indexOf('la cosa b'), 'de la más grande a la más chica');
  assert.match(bajo.line, /la cosa a 6,0 GB/);
  assert.match(bajo.line, /el arnés no corre ninguno/i);
  const M = lugar();
  const otra = juguete(M.home);
  const alto = await run({ home: M.home, now: DIA, platform: process.platform, disk: disco(40), threshold: 15, hogs: otra.hogs, measure: otra.measure, stateFile: M.state });
  assert.strictEqual(alto.line, null, 'con el disco por encima del umbral, silencio');
  assert.strictEqual(otra.llamadas.length, 0, 'y no mide nada');
  assert.strictEqual(llamadas.length, 6, 'midió cada cosa una vez');
  // lo que no existe en la máquina no se nombra
  const N = lugar();
  const sin = juguete(N.home);
  fs.rmSync(path.join(N.home, 'a'), { recursive: true });
  const r = await run({ home: N.home, now: DIA, platform: process.platform, disk: disco(10), threshold: 15, hogs: sin.hogs, measure: sin.measure, stateFile: N.state });
  assert.ok(!r.line.includes('la cosa a') && r.line.includes('la cosa f'), r.line);
});

test('T12 8.164-NoMedido_NoEsCero @story-8.164 @ac-12 — la medición que no vuelve a tiempo sale «no medido»; el mismo día se repite la medición sin volver a medir', async () => {
  const L = lugar();
  const { hogs, llamadas } = juguete(L.home);
  // la cosa «b» no vuelve nunca; las demás, enseguida
  const measure = (paths) => { llamadas.push(paths); return path.basename(paths[0]) === 'b' ? new Promise(() => {}) : Promise.resolve(GB); };
  const r1 = await run({ home: L.home, now: DIA, platform: process.platform, disk: disco(10), threshold: 15, hogs, measure, stateFile: L.state, timeoutMs: 100 });
  assert.match(r1.line, /la cosa b no medido/, r1.line);
  assert.doesNotMatch(r1.line, /la cosa b 0/);
  assert.strictEqual(r1.measured, true);
  const antes = llamadas.length;
  const r2 = await run({ home: L.home, now: DIA + 3 * 3600 * 1000, platform: process.platform, disk: disco(9), threshold: 15, hogs, measure, stateFile: L.state, timeoutMs: 100 });
  assert.strictEqual(llamadas.length, antes, 'el segundo arranque del día no mide');
  assert.strictEqual(r2.measured, false);
  assert.match(r2.line, /la cosa b no medido/);
  assert.match(r2.line, /quedan 90 GB libres/, 'lo libre sí se mide en cada arranque');
  const r3 = await run({ home: L.home, now: DIA + 24 * 3600 * 1000, platform: process.platform, disk: disco(9), threshold: 15, hogs, measure, stateFile: L.state, timeoutMs: 100 });
  assert.strictEqual(r3.measured, true, 'al otro día mide de nuevo');
  // una medición que falla también es «no medido», nunca 0
  assert.match(noticeLine({ disk: disco(5), threshold: 15, items: [{ id: 'x', name: 'la cosa x', clean: 'c', bytes: null }], measuredAt: DIA }), /la cosa x no medido/);
});

test('T13 8.164-NoCorreNada @story-8.164 @ac-13 — el gancho muestra los comandos de limpieza y no corre ninguno', { skip: WIN }, () => {
  const L = lugar();
  const bin = path.join(L.base, 'bin');
  fs.mkdirSync(bin);
  const marca = path.join(L.base, 'alguien-corrio');
  // un programa de juguete por cada comando de la lista: si alguien lo llama, deja la marca
  for (const p of ['npx', 'docker', 'npm', 'dotnet', 'brew', 'git']) {
    fs.writeFileSync(path.join(bin, p), `#!/bin/sh\necho "${p} $*" >> "${marca}"\n`);
    fs.chmodSync(path.join(bin, p), 0o755);
  }
  // cinco cosas de la lista conocida, con algo adentro
  const cosas = process.platform === 'darwin'
    ? ['Library/Caches/ms-playwright', 'Library/Containers/com.docker.docker/Data/vms', '.npm/_cacache', '.nuget/packages', 'Library/Caches/Homebrew']
    : ['.cache/ms-playwright', '.docker/desktop/vms', '.npm/_cacache', '.nuget/packages', '.cache/Homebrew'];
  for (const c of cosas) { fs.mkdirSync(path.join(L.home, c), { recursive: true }); fs.writeFileSync(path.join(L.home, c, 'dato'), 'x'.repeat(4096)); }
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: L.base, encoding: 'utf8', input: '{"source":"startup"}',
    env: { ...process.env, HOME: L.home, USERPROFILE: L.home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TYCON_DISK_NOTICE_TEST_DISK: `${50 * GB}/${1000 * GB}`, TYCON_DISK_NOTICE: '', TYCON_EVAL_SANDBOX: '', TYCON_REPOS_ROOT: path.join(L.base, 'repos'), TYCON_PROFILE: path.join(L.base, 'sin-perfil.json') },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  for (const c of ['npx playwright uninstall --all', 'docker system prune -a', 'npm cache clean --force', 'dotnet nuget locals all --clear', 'brew cleanup --prune=all']) assert.ok(r.stdout.includes(c), `${c}: ${r.stdout}`);
  assert.ok(!fs.existsSync(marca), `nadie corrió nada: ${fs.existsSync(marca) ? fs.readFileSync(marca, 'utf8') : ''}`);
  assert.ok(fs.existsSync(path.join(stateDir(L.home), 'disk-notice-last.json')), 'guarda la medición del día');
  // con el disco alto, el gancho calla
  const alto = spawnSync(process.execPath, [HOOK], { cwd: L.base, encoding: 'utf8', input: '{"source":"startup"}', env: { ...process.env, HOME: L.home, USERPROFILE: L.home, TYCON_DISK_NOTICE_TEST_DISK: `${500 * GB}/${1000 * GB}`, TYCON_DISK_NOTICE: '', TYCON_EVAL_SANDBOX: '', TYCON_PROFILE: path.join(L.base, 'sin-perfil.json') } });
  assert.strictEqual(alto.status, 0);
  assert.strictEqual(alto.stdout, '');
  // apagado, calla aunque el disco esté bajo
  const apagado = spawnSync(process.execPath, [HOOK], { cwd: L.base, encoding: 'utf8', input: '{"source":"startup"}', env: { ...process.env, HOME: L.home, USERPROFILE: L.home, TYCON_DISK_NOTICE_TEST_DISK: `${10 * GB}/${1000 * GB}`, TYCON_DISK_NOTICE: '0' } });
  assert.strictEqual(apagado.stdout, '');
});

test('T14 8.164-ClavesDesdeElSitio @story-8.164 @ac-14 — las tres claves se proponen desde el sitio: dentro de rango quedan en el perfil y la máquina las pisa; fuera, no se guardan', () => {
  const ORG = require(path.join(REPO, 'scripts', 'lib', 'org-config.js'));
  const TC = require(path.join(REPO, 'scripts', 'lib', 'tycon-config.js'));
  const s = ORG.seccionPorId('mantenimiento');
  assert.ok(s, 'la sección existe');
  assert.deepStrictEqual([s.archivo, s.repo, s.lector, s.claves, s.rutas, s.necesita], ['team-profile.json', 'perfil', 'harness-config', ['maintenance'], ['maintenance.worktree_idle_hours', 'maintenance.temp_days', 'maintenance.disk_warn_percent'], ['maintenance']]);
  const perfil = { __doc: 'perfil de juguete', ado: { org: 'https://dev.azure.com/acme' } };
  const rev = (borrador) => ORG.revisar({ seccion: 'mantenimiento', texto: ORG.formatJson(perfil), borrador, lectores: { 'harness-config': TC } });
  const dentro = { maintenance: { worktree_idle_hours: 0, temp_days: 365, disk_warn_percent: 20 } };
  const ok = rev(dentro);
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
  assert.deepStrictEqual(JSON.parse(ok.texto).maintenance, dentro.maintenance, 'quedan en el perfil');
  for (const fuera of [{ disk_warn_percent: 0 }, { disk_warn_percent: 100 }, { temp_days: 0 }, { temp_days: 366 }, { worktree_idle_hours: -1 }, { worktree_idle_hours: 721 }, { disk_warn_percent: 'mucho' }]) {
    assert.strictEqual(rev({ maintenance: fuera }).ok, false, `fuera de rango: ${JSON.stringify(fuera)}`);
  }
  // la máquina pisa al perfil: el perfil dice 20 y la máquina 30
  const L = lugar();
  const archivoPerfil = path.join(L.base, 'team-profile.json');
  fs.writeFileSync(archivoPerfil, ok.texto);
  const cargar = () => TC.mantenimiento(TC.cargar({ home: L.home, env: { TYCON_PROFILE: archivoPerfil } }));
  assert.strictEqual(cargar().disk_warn_percent.value, 20, 'sin nada en la máquina, el del perfil');
  const maquina = require(path.join(REPO, 'scripts', 'setup', 'harness', 'tycon-home.js')).configFile(L.home);
  fs.mkdirSync(path.dirname(maquina), { recursive: true });
  fs.writeFileSync(maquina, JSON.stringify({ maintenance: { disk_warn_percent: 30 } }));
  assert.strictEqual(cargar().disk_warn_percent.value, 30, 'la máquina lo pisa');
  assert.strictEqual(cargar().temp_days.value, 365, 'lo que la máquina no dice sale del perfil');
  // la pantalla: tres campos, en los dos idiomas
  const textos = require(path.join(REPO, 'scripts', 'site', 'texts.js'));
  for (const idioma of ['es', 'en']) {
    for (const k of ['pantalla.mantenimientoTitulo', 'pantalla.mantenimientoDescripcion', 'pantalla.mantenimientoHoras', 'pantalla.mantenimientoDias', 'pantalla.mantenimientoDisco', 'pantalla.mantenimientoAyuda', 'pantalla.para.mantenimiento', 'org.capaSinMaintenance']) {
      assert.ok(textos.t(idioma, k) && textos.t(idioma, k) !== k, `${idioma} ${k}`);
    }
    assert.match(ORG.pantalla(idioma), /mantenimiento: editorMantenimiento/);
  }
});

test('T15 8.164-PorSistema @story-8.164 @ac-15 — la lista conocida cambia por sistema: Windows sin Homebrew', () => {
  const hogs = loadHogs();
  const ids = (p) => hogsFor(p, hogs).map((h) => h.id);
  assert.deepStrictEqual(ids('darwin'), ['browsers', 'docker', 'npm', 'nuget', 'homebrew', 'worktree-node-modules']);
  assert.deepStrictEqual(ids('linux'), ['browsers', 'docker', 'npm', 'nuget', 'homebrew', 'worktree-node-modules']);
  assert.deepStrictEqual(ids('win32'), ['browsers', 'docker', 'npm', 'nuget', 'worktree-node-modules']);
  const de = (p, id) => hogsFor(p, hogs).find((h) => h.id === id).paths.join(' ');
  assert.match(de('darwin', 'browsers'), /Library\/Caches\/ms-playwright/);
  assert.match(de('linux', 'browsers'), /\.cache\/ms-playwright/);
  assert.match(de('win32', 'browsers'), /%LOCALAPPDATA%/);
  for (const p of ['darwin', 'linux', 'win32']) for (const h of hogsFor(p, hogs)) assert.ok(typeof h.clean === 'string' && h.clean, `${p} ${h.id}: sin comando`);
});
