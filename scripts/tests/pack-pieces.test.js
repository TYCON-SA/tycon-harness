'use strict';

/**
 * pack-pieces.test.js — el paquete se activa por organización (story 8.41, tanda A1 · T1-T10 y T33).
 *
 * Qué sostiene: `packs.default` dice qué paquetes activa la organización (`all`, `none` o una lista) y los dos lectores
 * (`scripts/lib/tycon-config.js` y `lib/packs.js` del pipeline) dan lo mismo para cada forma; un paquete puede traer sus
 * skills y sus agentes en su carpeta; lo que se enlaza en la máquina sigue a lo activo para la organización, con las
 * reglas de los enlaces por entrada (lo propio gana y se nombra); un repo que declara un paquete que la organización no
 * activó frena diciendo dónde se activa; la sección «Paquetes» de la configuración valida con el lector. Sin perfil y sin
 * variable, de fábrica, ninguno.
 *
 * Cada caso corre con su propia carpeta de usuario y un perfil declarado (`TYCON_PROFILE`): nunca lee la configuración
 * de la máquina que corre la prueba.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'scripts', 'lib', 'tycon-config.js');
const PACKS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'packs.js');
const PIPELINE = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js');
const CANONICAL = path.join(ROOT, 'scripts', 'lib', 'canonical-path.js');
const PIECES = path.join(ROOT, 'scripts', 'lib', 'pack-pieces.js');
const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const W = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };

/** Una carpeta de usuario vacía (sin archivo de máquina) y un perfil con `packs.default` = valor (o sin perfil). */
function entorno(valor, extra = {}) {
  const home = tmp('pp-home-');
  let perfil = '0';
  if (valor !== undefined) { perfil = path.join(tmp('pp-perfil-'), 'team-profile.json'); W(perfil, `${JSON.stringify({ packs: { default: valor } }, null, 2)}\n`); }
  return { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_PROFILE: perfil, TYCON_GUIDES_DIR: ROOT, ...extra };
}

/** Corre un trozo de código en un proceso aparte con ese entorno; devuelve el JSON que imprime. */
function enProceso(code, env) {
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env });
  return { status: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch (_) { return null; } })() };
}

/** Lo que dicen los dos lectores de `packs.default`: `{ config: valor | {error}, packs: valor | {error} }`. */
function losDosLectores(env) {
  const r = enProceso(`
    const out = {};
    try { const C = require(${JSON.stringify(CONFIG)}); out.config = C.valor(C.leer({ env: process.env }), 'packs.default'); }
    catch (e) { out.config = { error: String(e.message) }; }
    try { out.packs = require(${JSON.stringify(PACKS)}).packsDefault({ env: process.env }).value; }
    catch (e) { out.packs = { error: String(e.message) }; }
    process.stdout.write(JSON.stringify(out));`, env);
  assert.equal(r.status, 0, r.err);
  return r.json;
}

// ── T1 · AC 1 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('PacksDefault_AcceptsList_SameInBothReaders', () => {
  for (const [valor, esperado] of [['all', 'all'], ['none', 'none'], [['bizuit', 'clients'], ['bizuit', 'clients']]]) {
    const r = losDosLectores(entorno(valor));
    assert.deepEqual(r.config, esperado, `el lector del arnés con ${JSON.stringify(valor)}`);
    assert.deepEqual(r.packs, esperado, `el lector del pipeline con ${JSON.stringify(valor)}`);
  }
  // por variable: una lista separada por comas, recortada
  const v = losDosLectores(entorno(undefined, { TYCON_PACKS_DEFAULT: ' bizuit , clients ' }));
  assert.deepEqual(v.config, ['bizuit', 'clients']);
  assert.deepEqual(v.packs, ['bizuit', 'clients']);
  // inválidos: los dos frenan nombrando la clave, nunca leen «ninguno»
  for (const malo of ['algunos', [], ['Bizuit'], ['bizuit', 'bizuit'], [3], 'all,none']) {
    const r = losDosLectores(entorno(malo));
    assert.ok(r.config && r.config.error, `el lector del arnés rechaza ${JSON.stringify(malo)}: ${JSON.stringify(r.config)}`);
    assert.ok(r.packs && r.packs.error, `el lector del pipeline rechaza ${JSON.stringify(malo)}: ${JSON.stringify(r.packs)}`);
    assert.match(r.config.error, /packs\.default/);
    assert.match(r.packs.error, /packs\.default/);
  }
  const mv = losDosLectores(entorno(undefined, { TYCON_PACKS_DEFAULT: 'Bizuit,,x' }));
  assert.ok(mv.config.error && mv.packs.error, 'una variable con un nombre inválido frena en los dos');
  assert.match(mv.packs.error, /TYCON_PACKS_DEFAULT/);
});

/** Paquetes instalados de juguete (`{ nombre }` con un revisor cada uno) y su carpeta de agentes. */
function instalados(...nombres) {
  const dir = tmp('pp-packs-');
  const agentes = tmp('pp-agents-');
  for (const n of nombres) {
    W(path.join(dir, n, 'pack.json'), JSON.stringify({ name: n, description: n, reviewers: [{ agent: `rev-${n}`, group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: [n.toUpperCase().replace(/[^A-Z]/g, '') || 'P'] }] }));
    W(path.join(agentes, `rev-${n}.md`), `# rev-${n}\n`);
  }
  return { dir, agentes };
}
/** Los activos en un repo, preguntados en un proceso aparte. */
function activos({ yaml = null, valor, packs }) {
  const repo = tmp('pp-repo-');
  if (yaml !== null) W(path.join(repo, '.tycon', 'advisors.yaml'), yaml);
  return enProceso(`
    const P = require(${JSON.stringify(PACKS)});
    try {
      const inst = P.cargarPaquetes({ packsDir: ${JSON.stringify(packs.dir)}, agentsDir: ${JSON.stringify(packs.agentes)}, banderas: P.BANDERAS });
      process.stdout.write(JSON.stringify({ ok: P.paquetesActivos({ repo: ${JSON.stringify(repo)}, instalados: inst, packsDir: ${JSON.stringify(packs.dir)} }).map((p) => p.nombre) }));
    } catch (e) { process.stdout.write(JSON.stringify({ error: String(e.message) })); }`, entorno(valor));
}

// ── T2 · AC 2 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('PacksDefault_ListActivatesOnlyListed', () => {
  const packs = instalados('alfa', 'beta', 'gamma');
  assert.deepEqual(activos({ valor: ['beta'], packs }).json, { ok: ['beta'] });
  assert.deepEqual(activos({ valor: ['gamma', 'alfa'], packs }).json, { ok: ['alfa', 'gamma'] }, 'en el orden de instalación');
  assert.deepEqual(activos({ valor: 'all', packs }).json, { ok: ['alfa', 'beta', 'gamma'] });
  assert.deepEqual(activos({ valor: 'none', packs }).json, { ok: [] });
});

// ── T3 · AC 2 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('PacksDefault_ListedNotInstalled_Stops', () => {
  const packs = instalados('alfa');
  const r = activos({ valor: ['alfa', 'zeta'], packs }).json;
  assert.ok(r.error, `frena: ${JSON.stringify(r)}`);
  assert.match(r.error, /zeta/);
  assert.ok(r.error.includes(packs.dir), `nombra la carpeta donde se buscó: ${r.error}`);
});

/** Un paquete con carpetas propias: `{ skills, agents }` en el manifiesto y lo que haya adentro. */
function paqueteConCarpetas({ nombre = 'prueba', skills = ['s-uno'], agentes = ['rev-propio'], manifiesto = {}, raiz = [] } = {}) {
  const packsDir = tmp('pp-packs-');
  const agentsDir = tmp('pp-root-agents-');
  const d = path.join(packsDir, nombre);
  for (const s of skills) W(path.join(d, 'skills', s, 'SKILL.md'), `---\nname: ${s}\n---\n`);
  for (const a of agentes) W(path.join(d, 'agents', `${a}.md`), `# ${a}\n`);
  for (const a of raiz) W(path.join(agentsDir, `${a}.md`), `# ${a}\n`);
  const reviewers = agentes.map((a) => ({ agent: a, group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: ['PRO'] }));
  W(path.join(d, 'pack.json'), JSON.stringify({ name: nombre, description: 'x', skills: 'skills', agents: 'agents', reviewers, ...manifiesto }, null, 2));
  return { packsDir, agentsDir, dir: d };
}
function validar({ packsDir, agentsDir }) {
  const P = require(PACKS);
  return P.validateTree({ packsDir, agentsDir, banderas: P.BANDERAS });
}

// ── T4 · AC 3 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Manifest_SkillsAndAgentsKeys_Validated', () => {
  assert.deepEqual(validar(paqueteConCarpetas()), [], 'skills y agents dentro del paquete: válido');
  const sinSkills = paqueteConCarpetas({ skills: [] });
  fs.rmSync(path.join(sinSkills.dir, 'skills'), { recursive: true, force: true });
  const e1 = validar(sinSkills);
  assert.equal(e1.length, 1, JSON.stringify(e1));
  assert.match(e1[0].motivo, /skills/);
  assert.match(e1[0].motivo, /no existe/);
  const fuera = validar(paqueteConCarpetas({ manifiesto: { agents: '../afuera' } }));
  assert.ok(fuera.some((e) => /agents/.test(e.motivo)), `una ruta que sale del paquete es un paquete roto: ${JSON.stringify(fuera)}`);
  const tipo = validar(paqueteConCarpetas({ manifiesto: { skills: ['skills'] } }));
  assert.ok(tipo.some((e) => /skills/.test(e.motivo)), 'tiene que ser una ruta (texto)');
  // y el lector liviano del arnés dice lo mismo
  const PP = require(PIECES);
  const ok = paqueteConCarpetas();
  const r = PP.piecesOf({ packsDir: ok.packsDir, agentsDir: ok.agentsDir, names: ['prueba'] });
  assert.deepEqual(r.errores, []);
  assert.deepEqual(r.skills.map((x) => x.name), ['s-uno']);
  assert.deepEqual(r.agents.map((x) => x.name), ['rev-propio.md']);
  const roto = PP.piecesOf({ packsDir: sinSkills.packsDir, agentsDir: sinSkills.agentsDir, names: ['prueba'] });
  assert.equal(roto.errores.length, 1);
});

// ── T5 · AC 4 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Agents_PackFirstThenRoot_DuplicateBreaks', () => {
  // en el paquete, sin copia en la raíz: se encuentra
  assert.deepEqual(validar(paqueteConCarpetas({ agentes: ['rev-propio'] })), []);
  // un revisor del paquete que vive en la raíz (el paquete trae agents/ pero no a ése): se encuentra después
  const enRaiz = paqueteConCarpetas({ agentes: [], raiz: ['rev-raiz'], manifiesto: { reviewers: [{ agent: 'rev-raiz', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: ['RR'] }] } });
  fs.mkdirSync(path.join(enRaiz.dir, 'agents'), { recursive: true });
  assert.deepEqual(validar(enRaiz), []);
  // el mismo nombre en los dos lugares: roto
  const doble = validar(paqueteConCarpetas({ agentes: ['rev-doble'], raiz: ['rev-doble'] }));
  assert.equal(doble.length, 1, JSON.stringify(doble));
  assert.match(doble[0].motivo, /rev-doble/);
  assert.match(doble[0].motivo, /dos lugares|raíz/);
});

/** Un clon de juguete del repo único (skills/tycon-pipeline y agents/) con un paquete con carpetas propias. */
function clonDeJuguete() {
  const c = tmp('pp-clon-');
  W(path.join(c, 'skills', 'tycon-pipeline', 'SKILL.md'), '# p\n');
  W(path.join(c, 'agents', 'rev-nucleo.md'), '# n\n');
  const d = path.join(c, 'packs', 'prueba');
  W(path.join(d, 'skills', 's-paquete', 'SKILL.md'), '# s\n');
  W(path.join(d, 'agents', 'rev-paquete.md'), '# r\n');
  W(path.join(d, 'pack.json'), JSON.stringify({ name: 'prueba', description: 'x', skills: 'skills', agents: 'agents', reviewers: [{ agent: 'rev-paquete', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: ['PRU'] }] }));
  return c;
}
function enlazar(clon, env) {
  const r = spawnSync(process.execPath, [CANONICAL, '--ensure-repo-links', '--clone', clon, '--home', env.HOME, '--only', 'entries'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// ── T6 · AC 5 (y AC 13 en chico: el paquete que deja de estar activo sale, en una línea) ────────────────────────────
test('RepoLinks_PackEntries_LinkedWhenActive', () => {
  const clon = clonDeJuguete();
  const env = entorno('all');
  enlazar(clon, env);
  const at = (...p) => path.join(env.HOME, '.claude', ...p);
  assert.equal(real(at('skills', 's-paquete')), real(path.join(clon, 'packs', 'prueba', 'skills', 's-paquete')), 'la skill del paquete activo');
  assert.equal(real(at('agents', 'rev-paquete.md')), real(path.join(clon, 'packs', 'prueba', 'agents', 'rev-paquete.md')), 'el agente del paquete activo');
  assert.equal(real(at('skills', 'tycon-pipeline')), real(path.join(clon, 'skills', 'tycon-pipeline')), 'las del núcleo, como siempre');
  // la organización deja de activarlo: salen sólo las del paquete, y se dice en UNA línea con el motivo y dónde se activa
  const env2 = { ...env, TYCON_PROFILE: entorno('none').TYCON_PROFILE };
  const out = enlazar(clon, env2);
  assert.ok(!lexists(at('skills', 's-paquete')) && !lexists(at('agents', 'rev-paquete.md')), 'las del paquete inactivo salieron');
  assert.ok(lexists(at('skills', 'tycon-pipeline')) && lexists(at('agents', 'rev-nucleo.md')), 'lo del núcleo quedó');
  const lineas = out.split('\n').filter((l) => /paquete/.test(l) && /prueba/.test(l));
  assert.equal(lineas.length, 1, `una sola línea: ${out}`);
  assert.match(lineas[0], /no activa|no está activo|inactivo/);
  assert.match(lineas[0], /Configuración del sitio|perfil del equipo/);
  // una skill del núcleo que la versión nueva muda a un paquete que la organización no activa: su enlace viejo sale y
  // cuenta en la misma línea
  const c2 = clonDeJuguete();
  W(path.join(c2, 'skills', 's-movida', 'SKILL.md'), '# m\n');
  const env3 = entorno('none');
  enlazar(c2, env3);
  assert.ok(lexists(path.join(env3.HOME, '.claude', 'skills', 's-movida')), 'en el núcleo, enlazada');
  fs.renameSync(path.join(c2, 'skills', 's-movida'), path.join(c2, 'packs', 'prueba', 'skills', 's-movida'));
  const out3 = enlazar(c2, env3);
  assert.ok(!lexists(path.join(env3.HOME, '.claude', 'skills', 's-movida')), 'mudada a un paquete inactivo: salió');
  const l3 = out3.split('\n').filter((l) => /paquete/.test(l) && /prueba/.test(l));
  assert.equal(l3.length, 1, out3);
  assert.match(l3[0], /skills\/s-movida/);
  // la frase de la línea es una sola, compartida: la que reconoce quien se la dice a la persona (harness.js, release.js)
  assert.match(l3[0], require(PIECES).RETIRED_RX);
  // sin paquete activo de entrada (de fábrica): no se enlaza nada del paquete
  const virgen = entorno(undefined);
  enlazar(clonDeJuguete(), virgen);
  assert.ok(!lexists(path.join(virgen.HOME, '.claude', 'skills', 's-paquete')));
});

// ── T6 (Codex) · AC 5 — las skills del paquete activo también van a ~/.codex/skills; si deja de estar activo, salen ──
test('RepoLinks_PackEntries_LinkedWhenActive_Codex', () => {
  const { deploySkills } = require(path.join(ROOT, 'build', 'deploy-shared-skills.js'));
  const clon = clonDeJuguete();
  const dst = path.join(tmp('pp-codex-'), 'skills');
  const root = path.join(clon, 'packs');
  const extra = [{ name: 's-paquete', src: path.join(root, 'prueba', 'skills', 's-paquete') }];
  deploySkills(path.join(clon, 'skills'), dst, { root, extra, retire: [] });
  assert.equal(real(path.join(dst, 's-paquete')), real(extra[0].src));
  assert.equal(real(path.join(dst, 'tycon-pipeline')), real(path.join(clon, 'skills', 'tycon-pipeline')));
  const r = deploySkills(path.join(clon, 'skills'), dst, { root, extra: [], retire: [path.join(root, 'prueba', 'skills')] });
  assert.ok(!lexists(path.join(dst, 's-paquete')), 'salió la del paquete inactivo');
  assert.deepEqual(r.actions.cleaned, ['s-paquete']);
  assert.ok(lexists(path.join(dst, 'tycon-pipeline')));
  // una skill de paquete con el nombre de una del núcleo no se enlaza, y se nombra
  const tapada = deploySkills(path.join(clon, 'skills'), dst, { root, extra: [{ pack: 'prueba', name: 'tycon-pipeline', src: extra[0].src }], retire: [] });
  assert.deepEqual(tapada.actions.clashes, ['tycon-pipeline (del paquete prueba)']);
  // un paquete roto lo dice el despliegue de Codex, no lo calla
  const { packSkills } = require(path.join(ROOT, 'build', 'deploy-shared-skills.js'));
  const roto = clonDeJuguete();
  W(path.join(roto, 'scripts', 'lib', 'pack-pieces.js'), fs.readFileSync(PIECES, 'utf8'));
  W(path.join(roto, 'scripts', 'lib', 'tycon-config.js'), fs.readFileSync(CONFIG, 'utf8'));
  W(path.join(roto, 'packs', 'roto', 'pack.json'), '{ roto');
  const errs = []; const orig = console.error; console.error = (m) => errs.push(String(m));
  try { packSkills(roto); } finally { console.error = orig; }
  assert.ok(errs.some((m) => /roto/.test(m) && /pack\.json/.test(m)), JSON.stringify(errs));
});

// ── pase adversarial (clases 1, 9, 13): un paquete que se borra del árbol no deja enlaces colgando; con la configuración
//    rota no se saca nada de ningún paquete ──────────────────────────────────────────────────────────────────────────
test('RepoLinks_DeletedPack_CleanedAndBrokenConfigTouchesNothing', () => {
  const clon = clonDeJuguete();
  const env = entorno('all');
  const at = (...p) => path.join(env.HOME, '.claude', ...p);
  enlazar(clon, env);
  assert.ok(lexists(at('skills', 's-paquete')) && lexists(at('agents', 'rev-paquete.md')));
  fs.rmSync(path.join(clon, 'packs'), { recursive: true, force: true });
  enlazar(clon, env);
  assert.ok(!lexists(at('skills', 's-paquete')) && !lexists(at('agents', 'rev-paquete.md')), 'el paquete que ya no está no deja enlaces colgando');
  // configuración rota: lo del paquete queda como estaba (ni se agrega ni se saca)
  const c2 = clonDeJuguete();
  const env2 = entorno('all');
  enlazar(c2, env2);
  const roto = path.join(tmp('pp-perfil-'), 'team-profile.json'); W(roto, '{ "packs": { "default": "algunos!" } }');
  fs.rmSync(path.join(c2, 'packs', 'prueba', 'skills', 's-paquete'), { recursive: true, force: true });
  const out = enlazar(c2, { ...env2, TYCON_PROFILE: roto });
  assert.match(out, /no agrego ni saco/);
  assert.ok(lexists(path.join(env2.HOME, '.claude', 'skills', 's-paquete')), 'con la configuración rota no se saca nada de un paquete');
});

// ── pase adversarial (clase 2): la misma pieza en dos paquetes activos, o una de paquete con el nombre de una del núcleo ──
test('PiecesOf_DuplicatesAcrossPacksOrCore_SaidAndLinkedOnce', () => {
  const clon = clonDeJuguete();
  const d = path.join(clon, 'packs', 'otro');
  W(path.join(d, 'skills', 's-paquete', 'SKILL.md'), '# dup\n');
  W(path.join(d, 'skills', 'tycon-pipeline', 'SKILL.md'), '# choca con el núcleo\n');
  W(path.join(d, 'agents', 'rev-paquete.md'), '# dup\n');
  W(path.join(d, 'pack.json'), JSON.stringify({ name: 'otro', description: 'x', skills: 'skills', agents: 'agents', reviewers: [{ agent: 'rev-paquete', group: 'condicional', when: { files: '^nunca/' }, surface: { paths: ['nunca/**'] }, depth: 'standard', prefixes: ['OTR'] }] }));
  const PP = require(PIECES);
  const r = PP.piecesOf({ packsDir: path.join(clon, 'packs'), agentsDir: path.join(clon, 'agents'), coreSkillsDir: path.join(clon, 'skills'), names: ['otro', 'prueba'] });
  assert.deepEqual(r.skills.map((x) => `${x.pack}/${x.name}`), ['otro/s-paquete'], 'cada nombre una vez; el que choca con el núcleo, ninguna');
  assert.deepEqual(r.agents.map((x) => `${x.pack}/${x.name}`), ['otro/rev-paquete.md']);
  assert.ok(r.errores.some((e) => /s-paquete/.test(e.motivo) && /otro/.test(e.motivo) && /prueba/.test(e.motivo)), JSON.stringify(r.errores));
  assert.ok(r.errores.some((e) => /tycon-pipeline/.test(e.motivo) && /núcleo/.test(e.motivo)), JSON.stringify(r.errores));
  const out = enlazar(clon, entorno('all'));
  assert.doesNotMatch(out, /del paquete prueba: el núcleo/, 'un choque entre paquetes no se le atribuye al núcleo');
});

// ── pase adversarial (clase 4): dos listas con los mismos paquetes en otro orden dicen lo mismo ───────────────────────
test('SamePacks_IsASet', () => {
  const Q = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'questions.js'));
  assert.equal(Q.samePacks(['a', 'b'], ['b', 'a']), true);
  assert.equal(Q.samePacks(['a'], ['a', 'b']), false);
  assert.equal(Q.samePacks('all', 'all'), true);
  assert.equal(Q.samePacks('all', ['a']), false);
});

// ── pase adversarial (clase 5): sin ningún paquete instalado, una lista de la organización que nombra uno frena ──────
test('PacksDefault_ListWithNothingInstalled_Stops', () => {
  const vacio = { dir: tmp('pp-packs-vacio-'), agentes: tmp('pp-agents-vacio-') };
  const r = activos({ valor: ['bizuit'], packs: vacio }).json;
  assert.ok(r.error, JSON.stringify(r));
  assert.match(r.error, /bizuit/);
  assert.deepEqual(activos({ valor: 'all', packs: vacio }).json, { ok: [] }, 'con all o none no hay nada que pedir');
});

// ── pase adversarial (clase 14): un enlace duro (Windows sin modo desarrollador) cuenta como enlazado ─────────────────
test('LinkedTo_HardLinkCounts', () => {
  const PP = require(PIECES);
  const d = tmp('pp-hard-');
  W(path.join(d, 'src.md'), '# a\n');
  fs.linkSync(path.join(d, 'src.md'), path.join(d, 'duro.md'));
  fs.symlinkSync(path.join(d, 'src.md'), path.join(d, 'blando.md'));
  W(path.join(d, 'otro.md'), '# a\n');
  assert.equal(PP.linkedTo(path.join(d, 'duro.md'), path.join(d, 'src.md')), true);
  assert.equal(PP.linkedTo(path.join(d, 'blando.md'), path.join(d, 'src.md')), true);
  assert.equal(PP.linkedTo(path.join(d, 'otro.md'), path.join(d, 'src.md')), false);
  assert.equal(PP.linkedTo(path.join(d, 'falta.md'), path.join(d, 'src.md')), false);
});

// ── pase adversarial (clases 3, 8, 15): el modelo de un revisor que vive en la carpeta de su paquete ─────────────────
test('Models_ReviewerInPackAgents_Found', () => {
  const M = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'models.js'));
  const clon = clonDeJuguete();
  W(path.join(clon, 'packs', 'prueba', 'agents', 'rev-paquete.md'), '---\nname: rev-paquete\nmodel: haiku\n---\n');
  const agentsDir = path.join(clon, 'agents');
  assert.equal(M.reviewerExists('rev-paquete', { agentsDir }), true);
  assert.equal(M.frontmatterModel('rev-paquete', { agentsDir }), 'haiku');
  assert.equal(M.reviewerExists('rev-que-no-existe', { agentsDir }), false);
  // un paquete en otra carpeta (TYCON_PACKS_DIR) y con su carpeta de agentes con otro nombre (la clave `agents`)
  const afuera = tmp('pp-packs-afuera-');
  W(path.join(afuera, 'lejos', 'pack.json'), JSON.stringify({ name: 'lejos', agents: 'revisores' }));
  W(path.join(afuera, 'lejos', 'revisores', 'rev-lejos.md'), '---\nname: rev-lejos\nmodel: sonnet\n---\n');
  const antes = process.env.TYCON_PACKS_DIR;
  process.env.TYCON_PACKS_DIR = afuera;
  try {
    assert.equal(M.reviewerExists('rev-lejos', { agentsDir }), true);
    assert.equal(M.frontmatterModel('rev-lejos', { agentsDir }), 'sonnet');
  } finally { if (antes === undefined) delete process.env.TYCON_PACKS_DIR; else process.env.TYCON_PACKS_DIR = antes; }
  // negativos: un nombre que no es de revisor no arma rutas, y una carpeta `agents` que sale del paquete no se sigue
  assert.equal(M.reviewerExists('../rev-paquete', { agentsDir }), false);
  const fuera = clonDeJuguete();
  W(path.join(fuera, 'afuera', 'rev-escapado.md'), '---\nname: rev-escapado\nmodel: opus\n---\n');
  W(path.join(fuera, 'packs', 'prueba', 'pack.json'), JSON.stringify({ name: 'prueba', agents: '../../afuera' }));
  assert.equal(M.reviewerExists('rev-escapado', { agentsDir: path.join(fuera, 'agents') }), false, 'no sigue una carpeta fuera del paquete');
  assert.equal(M.frontmatterModel('rev-escapado', { agentsDir: path.join(fuera, 'agents') }), null);
  // un pack.json ilegible no se toma por «sin carpeta de agentes» en silencio: la resolución de modelos lo avisa
  const roto = clonDeJuguete();
  W(path.join(roto, 'packs', 'prueba', 'pack.json'), '{ roto');
  const r = M.resolveModels({ org: {}, requests: {}, set: ['rev-x-inexistente'], iter: 1, agentsDir: path.join(roto, 'agents') });
  assert.ok(r.warnings.some((w) => /pack\.json/.test(w.message) && /no se pudo leer|ilegible/.test(w.message)), JSON.stringify(r.warnings));
});

// ── vuelta 2: Codex dice el nombre repetido; sin paquetes instalados, una configuración rota no se lee como «ninguno» ──
test('Codex_DuplicateSaid_And_NoPacksBrokenConfigStops', () => {
  const { packSkills } = require(path.join(ROOT, 'build', 'deploy-shared-skills.js'));
  const clon = clonDeJuguete();
  W(path.join(clon, 'scripts', 'lib', 'pack-pieces.js'), fs.readFileSync(PIECES, 'utf8'));
  W(path.join(clon, 'scripts', 'lib', 'tycon-config.js'), fs.readFileSync(CONFIG, 'utf8'));
  W(path.join(clon, 'packs', 'prueba', 'skills', 'tycon-pipeline', 'SKILL.md'), '# choca\n');
  const errs = []; const orig = console.error; console.error = (m) => errs.push(String(m));
  const antes = { P: process.env.TYCON_PROFILE, D: process.env.TYCON_PACKS_DEFAULT };
  process.env.TYCON_PACKS_DEFAULT = 'all';
  try { packSkills(clon); } finally {
    console.error = orig;
    for (const [k, v] of [['TYCON_PROFILE', antes.P], ['TYCON_PACKS_DEFAULT', antes.D]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  assert.ok(errs.some((m) => /tycon-pipeline/.test(m) && /núcleo/.test(m)), JSON.stringify(errs));
  // sin ningún paquete instalado y con la configuración rota: frena (antes daba «ninguno»)
  const vacio = { dir: tmp('pp-packs-vacio-'), agentes: tmp('pp-agents-vacio-') };
  const r = activos({ valor: 'algunos!', packs: vacio }).json;
  assert.ok(r.error, JSON.stringify(r));
  assert.match(r.error, /packs\.default/);
  // …y sin arnés que preguntar (lo único que se lee como antes): ninguno, sin frenar
  const repo = tmp('pp-repo-sin-arnes-');
  const sinArnes = enProceso(`
    const P = require(${JSON.stringify(PACKS)});
    process.stdout.write(JSON.stringify(P.paquetesActivos({ repo: ${JSON.stringify(repo)}, instalados: [], packsDir: ${JSON.stringify(vacio.dir)} })));`,
  { ...entorno(undefined), TYCON_GUIDES_DIR: path.join(tmp('pp-nada-'), 'no-existe') });
  assert.equal(sinArnes.status, 0, sinArnes.err);
  assert.deepEqual(sinArnes.json, []);
  // (Codex sólo enlaza skills: lo que piecesOf dice de los agentes no le toca; de las skills, el roto y el repetido ya
  // tienen su caso arriba)
});

// ── AC 2 — un paquete de la lista que está roto se dice roto, no «no instalado» ──────────────────────────────────────
test('OrgActive_ListedBrokenPack_SaysBroken', () => {
  const clon = clonDeJuguete();
  W(path.join(clon, 'packs', 'roto', 'pack.json'), '{ roto');
  const r = enProceso(`process.stdout.write(JSON.stringify(require(${JSON.stringify(PIECES)}).orgActive({ tree: ${JSON.stringify(clon)} })))`, entorno(['prueba', 'roto']));
  assert.equal(r.status, 0, r.err);
  assert.equal(r.json.names, null);
  assert.match(r.json.error, /roto/);
  assert.match(r.json.error, /pack\.json/);
  assert.doesNotMatch(r.json.error, /no está instalado/);
});

// ── T7 · AC 5 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('RepoLinks_PackEntries_OwnWins', () => {
  const clon = clonDeJuguete();
  const env = entorno('all');
  const mia = path.join(env.HOME, '.claude', 'skills', 's-paquete');
  W(path.join(mia, 'SKILL.md'), '# la mía\n');
  const out = enlazar(clon, env);
  assert.ok(fs.lstatSync(mia).isDirectory() && !fs.lstatSync(mia).isSymbolicLink(), 'la propia queda');
  assert.equal(fs.readFileSync(path.join(mia, 'SKILL.md'), 'utf8'), '# la mía\n');
  assert.match(out, /skills\/s-paquete/, `y se nombra: ${out}`);
  // con la organización apagándolo, la propia tampoco se toca
  enlazar(clon, { ...env, TYCON_PROFILE: entorno('none').TYCON_PROFILE });
  assert.equal(fs.readFileSync(path.join(mia, 'SKILL.md'), 'utf8'), '# la mía\n');
});

// ── T8 · AC 6 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('RepoPacks_NotActiveForOrg_SaysWhere', () => {
  const packs = instalados('alfa', 'beta');
  const r = activos({ yaml: 'packs: [beta]\n', valor: ['alfa'], packs }).json;
  assert.ok(r.error, JSON.stringify(r));
  assert.match(r.error, /beta/);
  assert.match(r.error, /Configuración del sitio, sección Paquetes, o en el perfil del equipo/);
  assert.equal(activos({ yaml: 'packs: [beta]\n', valor: 'none', packs }).json.error ? 'frena' : 'no', 'frena', 'con none también');
  // achicar la lista de la organización sigue valiendo
  assert.deepEqual(activos({ yaml: 'packs: [alfa]\n', valor: 'all', packs }).json, { ok: ['alfa'] });
  assert.deepEqual(activos({ yaml: 'packs: []\n', valor: ['alfa'], packs }).json, { ok: [] });
  // y el comando del pipeline sale 2 con la línea
  const repo = tmp('pp-repo-cli-');
  W(path.join(repo, '.tycon', 'advisors.yaml'), 'packs: [beta]\n');
  W(path.join(repo, 'A.cs'), 'class A {}\n');
  for (const a of [['init', '-q', '-b', 'main', '.'], ['add', '-A'], ['-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base']]) spawnSync('git', ['-C', repo, '-c', 'maintenance.auto=false', ...a], { env: { ...process.env, GIT_AUTHOR_DATE: '2030-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' } });
  fs.appendFileSync(path.join(repo, 'A.cs'), 'class B {}\n');
  const cli = spawnSync(process.execPath, [PIPELINE, 'advisors', '--repo', repo, '--files', 'A.cs'], { encoding: 'utf8', timeout: 60000, env: { ...entorno(['alfa']), LANG: 'en_US.UTF-8', TYCON_PACKS_DIR: packs.dir, TYCON_AGENTS_DIR: packs.agentes, TYCON_SESSION_ID: 'pack-pieces-test' } });
  assert.equal(cli.status, 2, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /activalo en Configuración del sitio/);
});

// ── T9 · AC 7 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('SiteConfig_PacksSection_ValidatesAndProposes', () => {
  const s = ORG.seccionPorId('paquetes');
  assert.ok(s, 'la sección existe');
  assert.equal(s.repo, 'perfil');
  assert.deepEqual(s.claves, ['packs']);
  const C = require(CONFIG);
  assert.equal(typeof C.parse, 'function', 'el lector valida un texto de perfil');
  const lectores = { 'harness-config': C };
  assert.equal(ORG.loadReader(ROOT, 'harness-config'), C, 'el sitio lo carga del árbol');
  const perfil = `${JSON.stringify({ ado: { org: 'https://dev.azure.com/acme' }, packs: { default: 'all' } }, null, 2)}\n`;
  const ok = ORG.revisar({ seccion: s, texto: perfil, borrador: { packs: { default: ['bizuit'] } }, lectores });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  const doc = JSON.parse(ok.texto);
  assert.deepEqual(doc.packs, { default: ['bizuit'] });
  assert.deepEqual(doc.ado, { org: 'https://dev.azure.com/acme' }, 'lo demás del perfil queda como estaba');
  const mal = ORG.revisar({ seccion: s, texto: perfil, borrador: { packs: { default: 'algunos' } }, lectores });
  assert.equal(mal.ok, false);
  assert.ok(mal.problems.some((p) => /packs\.default/.test(p.path)), JSON.stringify(mal.problems));
  // un perfil que todavía no existe se crea sólo con la sección (sin claves que el lector no conoce)
  const nuevo = ORG.revisar({ seccion: s, texto: null, borrador: { packs: { default: 'none' } }, lectores });
  assert.equal(nuevo.ok, true, JSON.stringify(nuevo.problems));
  assert.deepEqual(JSON.parse(nuevo.texto), { packs: { default: 'none' } });
  // proponer una LISTA pide que las máquinas tengan un arnés que la sepa leer: requires.harness al menos la versión del sitio
  const capa = (req) => JSON.stringify({ requires: { harness: req } });
  assert.equal(ORG.packsListGateProblem({ layerText: capa('>= 2026.10.20.1'), versionImagen: '2026.10.20.1', valor: ['bizuit'] }), null);
  assert.match(String(ORG.packsListGateProblem({ layerText: capa('>= 2026.10.1.1'), versionImagen: '2026.10.20.1', valor: ['bizuit'] })), /requires\.harness/);
  assert.equal(ORG.packsListGateProblem({ layerText: capa('>= 2026.10.1.1'), versionImagen: '2026.10.20.1', valor: 'all' }), null, 'all y none los lee cualquier versión');
  assert.match(String(ORG.packsListGateProblem({ layerText: capa('>= 2026.10.20.1'), versionImagen: null, valor: ['bizuit'] })), /versión/);
  // la pantalla trae su editor
  assert.match(ORG.pantalla(), /paquetes:\s*editorPaquetes/);
});

// ── T10 · AC 10 ──────────────────────────────────────────────────────────────────────────────────────────────────
test('FactoryDefault_StillNone', () => {
  const r = losDosLectores(entorno(undefined));
  assert.equal(r.config, 'none');
  assert.equal(r.packs, 'none');
});

// ── T33 · AC 8 ───────────────────────────────────────────────────────────────────────────────────────────────────
test('TeamProfile_StillAll_ReadByNewReader', (t) => {
  // el perfil del equipo viaja sólo con la capa del equipo (el repo interno, o la copia con lo interno encima)
  const perfil = ['team-profile.json', 'perfil-equipo.json'].map((n) => path.join(ROOT, n)).find((f) => fs.existsSync(f));
  if (!perfil) { t.skip('NO MEDIDO: esta copia no trae el perfil del equipo (la pública); corre con lo interno encima'); return; }
  const r = losDosLectores({ ...entorno(undefined), TYCON_PROFILE: perfil });
  assert.equal(r.config, 'all', 'el perfil del equipo sigue en all');
  assert.equal(r.packs, 'all');
  const C = require(CONFIG);
  const p = C.parse(fs.readFileSync(perfil, 'utf8'));
  assert.equal(p.ok, true, JSON.stringify(p.problems));
});
