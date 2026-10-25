'use strict';

/**
 * installed-packs.test.js — T13: lo que lee los manifiestos además del pipeline.
 *
 * `harness-audit.js` (¿están instalados los revisores que el equipo espera?) e `instinct-draft.js`
 * (¿a qué revisor le toca una regla nueva por su prefijo?) no llevan a los revisores de Bizuit ni de
 * clientes escritos a mano: los dos leen `scripts/lib/installed-packs.js`, que
 * descubre los manifiestos en `TYCON_PACKS_DIR` o en `~/.claude/agent-skills/packs`.
 *
 * Lo que sostiene: un paquete de prueba con un revisor y un prefijo NUEVOS → la auditoría exige su
 * agente e `instinct-draft` le asigna el prefijo; sin el paquete, ninguno lo nombra. Y un manifiesto
 * ilegible sale como FALLA de la auditoría, no como «sin paquete».
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const LIB = path.join(SCRIPTS, 'lib', 'installed-packs.js');
const AUDIT = path.join(SCRIPTS, 'lib', 'harness-audit.js');
const DRAFT = path.join(SCRIPTS, 'instincts', 'instinct-draft.js');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

const PRUEBA = {
  name: 'prueba',
  description: 'paquete de prueba',
  guides: ['guides/prueba.md'],
  reviewers: [
    { agent: 'rev-nuevo', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'standard', prefixes: ['NUEVO'] },
  ],
};

function paquetes(mapa) {
  const d = tmp('paq-inst-');
  for (const [nombre, contenido] of Object.entries(mapa)) {
    fs.mkdirSync(path.join(d, nombre));
    fs.writeFileSync(path.join(d, nombre, 'pack.json'),
      typeof contenido === 'string' ? contenido : JSON.stringify(contenido, null, 2) + '\n');
  }
  return d;
}
function agentes(...nombres) {
  const d = tmp('paq-agents-');
  for (const n of nombres) fs.writeFileSync(path.join(d, `${n}.md`), `---\nname: ${n}\n---\n`);
  return d;
}

/** Corre un `node -e` con el ambiente dado y devuelve el JSON que imprime. */
function nodeJson(codigo, env) {
  const r = spawnSync(process.execPath, ['-e', codigo], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('el lector descubre el paquete y devuelve revisores con sus prefijos', () => {
  const { leerPaquetes } = require(LIB);
  const packsDir = paquetes({ prueba: PRUEBA });
  const r = leerPaquetes({ packsDir });
  assert.equal(r.dir, packsDir);
  assert.deepEqual(r.errores, []);
  assert.equal(r.paquetes.length, 1);
  assert.equal(r.paquetes[0].nombre, 'prueba');
  assert.deepEqual(r.paquetes[0].revisores.map((x) => [x.agente, x.grupo, x.prefijos]), [['rev-nuevo', 'base', ['NUEVO']]]);
  assert.deepEqual(r.paquetes[0].guias, ['guides/prueba.md']);
  // una carpeta vacía: cero paquetes, cero errores
  const vacio = tmp('paq-vacio-');
  assert.deepEqual(leerPaquetes({ packsDir: vacio }), { dir: vacio, paquetes: [], errores: [] });
  // la carpeta POR DEFECTO ausente (máquina sin agent-skills): cero paquetes, sin error, sin tirar
  const noExiste = path.join(vacio, 'no-existe');
  assert.deepEqual(leerPaquetes({ packsDir: noExiste, explicito: false }), { dir: noExiste, paquetes: [], errores: [] });
  // pero una carpeta EXPLÍCITA (TYCON_PACKS_DIR o packsDir) que no existe es configuración rota: error con la ruta
  const roto = leerPaquetes({ packsDir: noExiste });
  assert.deepEqual(roto.paquetes, []);
  assert.equal(roto.errores.length, 1);
  assert.equal(roto.errores[0].archivo, noExiste);
  assert.match(roto.errores[0].motivo, /no existe/);
});

test('un manifiesto ilegible sale como error con archivo y motivo, no como «sin paquete»', () => {
  const { leerPaquetes } = require(LIB);
  const packsDir = paquetes({ roto: '{ "name": ', sano: PRUEBA });
  const r = leerPaquetes({ packsDir });
  assert.equal(r.paquetes.length, 1, 'el sano se lee igual');
  assert.equal(r.errores.length, 1);
  assert.equal(r.errores[0].archivo, path.join(packsDir, 'roto', 'pack.json'));
  assert.match(r.errores[0].motivo, /JSON/i);
});

// T36: los hermanos del corral del banco viven en el paquete que los usa, no en el núcleo.
test('PackReader_DeliversSiblings', () => {
  const { leerPaquetes, siblingsFromPacks } = require(LIB);
  const siblings = [
    { path: 'AcmeCorp/Backend/src/AcmeCorpBackend', name: 'AcmeCorp' },
    { path: 'Zorblax/Backend/src/ZorblaxBackend', name: 'Zorblax' },
  ];
  // lo que entrega el lector conserva su forma de siempre
  const hermanos = siblings.map((s) => ({ ruta: s.path, nombre: s.name }));
  const packsDir = paquetes({ clientes: { ...PRUEBA, name: 'clientes', siblings }, sinHermanos: PRUEBA });
  const r = leerPaquetes({ packsDir });
  assert.deepEqual(r.errores, []);
  assert.deepEqual(r.paquetes.find((p) => p.nombre === 'clientes').hermanos, hermanos, 'el paquete entrega sus hermanos');
  assert.deepEqual(r.paquetes.find((p) => p.nombre === 'prueba').hermanos, [], 'sin el campo, una lista vacía');
  assert.deepEqual(siblingsFromPacks({ packsDir }), hermanos, 'la lista de todos los paquetes instalados');
  assert.deepEqual(siblingsFromPacks({ packsDir: tmp('paq-sin-') }), [], 'sin paquetes, sin hermanos');
  // un «hermanos» mal formado es un error del paquete con su motivo, no una lista a medias
  for (const malo of ['AcmeCorp', [{ path: '../fuera', name: 'AcmeCorp' }], [{ path: 'AcmeCorp/Backend', name: 'Acme Corp' }]]) {
    const d = paquetes({ clientes: { ...PRUEBA, name: 'clientes', siblings: malo } });
    const m = leerPaquetes({ packsDir: d });
    assert.equal(m.paquetes.length, 0, `un paquete con «hermanos» mal formado no se entrega (${JSON.stringify(malo)})`);
    assert.match(m.errores[0].motivo, /hermanos/);
    // y el corral no se arma a medias: un paquete roto frena, no se lee como «sin paquete»
    assert.throws(() => siblingsFromPacks({ packsDir: d }), /hermanos/, 'un paquete roto frena el corral y dice por qué');
  }
  assert.throws(() => siblingsFromPacks({ packsDir: path.join(tmp('paq-x-'), 'no-existe') }), /no existe/,
    'una carpeta de paquetes explícita que no existe también frena');
});

test('HarnessAuditEInstinctDraft_LeenManifiestos', () => {
  const packsDir = paquetes({ prueba: PRUEBA });
  const conAgente = agentes('rev-nuevo');
  const sinAgente = agentes();
  // (la auditoría exige los revisores de los paquetes que la organización ACTIVA: estas pruebas los activan todos)
  const audit = (env) => nodeJson(`process.stdout.write(JSON.stringify(require(${JSON.stringify(AUDIT)}).checkAdvisorCoverage().checks))`, { TYCON_PACKS_DEFAULT: 'all', ...env });

  // la auditoría exige el agente del paquete
  const checks = audit({ TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: conAgente });
  const delPaquete = checks.filter((c) => c.name.includes('rev-nuevo'));
  assert.equal(delPaquete.length, 1, `un check para el revisor del paquete: ${JSON.stringify(checks.map((c) => c.name))}`);
  assert.equal(delPaquete[0].passed, true);
  assert.equal(delPaquete[0].severity, 'critical');
  assert.match(delPaquete[0].name, /prueba/, 'nombra al paquete');
  // y falla si el agente no está
  const rojos = audit({ TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: sinAgente }).filter((c) => c.name.includes('rev-nuevo'));
  assert.equal(rojos[0].passed, false);
  // un manifiesto roto es una falla de la auditoría
  const rotoDir = paquetes({ roto: '{ nada' });
  const conRoto = audit({ TYCON_PACKS_DIR: rotoDir, TYCON_AGENTS_DIR: conAgente }).filter((c) => /paquete/i.test(c.name) && c.passed === false);
  assert.ok(conRoto.length >= 1, 'el manifiesto roto aparece como check en rojo');
  assert.ok(conRoto[0].name.includes('roto'));
  // sin paquetes, la auditoría no lo exige
  const sinPaquete = audit({ TYCON_PACKS_DIR: tmp('paq-vacio-'), TYCON_AGENTS_DIR: conAgente });
  assert.equal(sinPaquete.filter((c) => c.name.includes('rev-nuevo')).length, 0);
  // instalado = enlazado donde Claude lo carga. Con el fuente en la carpeta de agentes del
  // paquete y sin enlace, sigue en rojo; un paquete que la organización no activa no se exige; uno activado que no está, sí
  const conCarpeta = paquetes({ prueba: { ...PRUEBA, agents: 'agents' } });
  fs.mkdirSync(path.join(conCarpeta, 'prueba', 'agents'));
  fs.writeFileSync(path.join(conCarpeta, 'prueba', 'agents', 'rev-nuevo.md'), '---\nname: rev-nuevo\n---\n');
  const sinEnlace = audit({ TYCON_PACKS_DIR: conCarpeta, TYCON_AGENTS_DIR: sinAgente }).filter((c) => c.name.includes('rev-nuevo'));
  assert.equal(sinEnlace[0].passed, false, 'el fuente en el paquete no prueba que esté instalado');
  assert.equal(sinEnlace[0].file, path.join(sinAgente, 'rev-nuevo.md'));
  const apagado = audit({ TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: sinAgente, TYCON_PACKS_DEFAULT: 'none' });
  assert.equal(apagado.filter((c) => c.name.includes('rev-nuevo')).length, 0, 'un paquete apagado no se exige');
  const pedidoQueFalta = audit({ TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: conAgente, TYCON_PACKS_DEFAULT: 'prueba,otro' });
  assert.ok(pedidoQueFalta.some((c) => /activa otro y no está/.test(c.name) && c.passed === false), JSON.stringify(pedidoQueFalta.map((c) => c.name)));

  // instinct-draft asigna el prefijo al revisor del paquete
  const owner = (env) => nodeJson(`process.stdout.write(JSON.stringify(require(${JSON.stringify(DRAFT)}).ownerDePrefijo('NUEVO')))`, env);
  assert.equal(owner({ TYCON_PACKS_DIR: packsDir }), 'rev-nuevo');
  assert.equal(owner({ TYCON_PACKS_DIR: tmp('paq-vacio-') }), 'UNKNOWN-ADVISOR');
  // los prefijos del núcleo siguen resolviendo sin paquetes
  assert.equal(nodeJson(`process.stdout.write(JSON.stringify(require(${JSON.stringify(DRAFT)}).ownerDePrefijo('SEC')))`, { TYCON_PACKS_DIR: tmp('paq-vacio-') }), 'tycon-plugin-security-basics');
  // el prefijo se extrae con dígitos también (el vocabulario de los manifiestos los admite)
  const { prefijoDeRegla } = require(DRAFT);
  assert.equal(prefijoDeRegla('V2-C1'), 'V2');
  assert.equal(prefijoDeRegla('DODRT-C5.1'), 'DODRT');
  assert.equal(prefijoDeRegla('nada'), 'UNKNOWN');
});

test('ninguna de las dos listas escribe a mano a los cinco', (t) => {
  // («los cinco» son los revisores que declaran los manifiestos de `packs/` de este repo; esta prueba
  // tampoco los escribe a mano. La copia pública no trae paquetes —llegan con el perfil del equipo—, y ahí
  // no hay a quién buscar: se dice)
  const packs = path.resolve(SCRIPTS, '..', 'packs');
  const LOS_CINCO = [...new Set((fs.existsSync(packs) ? fs.readdirSync(packs) : [])
    .filter((p) => fs.existsSync(path.join(packs, p, 'pack.json')))
    .flatMap((p) => JSON.parse(fs.readFileSync(path.join(packs, p, 'pack.json'), 'utf8')).reviewers.map((r) => r.agent)))];
  if (!LOS_CINCO.length) { t.diagnostic(`NO MEDIDO: ${packs} no trae paquetes (copia pública); se mide en el repo del equipo`); return; }
  for (const f of [AUDIT, DRAFT, LIB]) {
    const src = fs.readFileSync(f, 'utf8');
    for (const n of LOS_CINCO) assert.ok(!src.includes(n), `${path.basename(f)} nombra a ${n}`);
  }
});

// Las claves del manifiesto en inglés. agent-skills se actualiza con su propio pull y un paquete
// puede vivir afuera (TYCON_PACKS_DIR): uno con las claves anteriores se lee igual; las dos distintas, manifiesto roto.
// Las claves viejas salen del mapa en tiempo de ejecución (escritas acá, las contaría el termómetro).
test('D1 PackReader_OldKeysSameAsNew_DifferentIsBroken', (t) => {
  const MAP = process.env.TYCON_LEGACY_NAMES_MAP || path.join(SCRIPTS, 'lib', 'renames.json');   // el mismo que lee legacy-names.js
  let entradas = [];
  try { entradas = JSON.parse(fs.readFileSync(MAP, 'utf8')).entries.filter((e) => e && e.kind === 'key' && e.where === 'packs/pack.json'); } catch (_) { entradas = []; }
  if (!entradas.length) { t.skip('el mapa no tiene (todavía) las claves de packs/pack.json: copia pública o mapa anterior a la D1'); return; }
  const vieja = new Map(entradas.map((e) => [e.new, e.old]));
  const aViejas = (v) => {
    if (Array.isArray(v)) return v.map(aViejas);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [vieja.get(k) || k, aViejas(x)]));
  };
  const conHermanos = { ...PRUEBA, agents: 'agents', siblings: [{ path: 'AcmeCorp/Backend/src/AcmeCorpBackend', name: 'AcmeCorp' }] };
  const { leerPaquetes } = require(LIB);
  // cada lectura arma su carpeta: la de agentes se compara relativa a la del paquete, no entera
  const sinRutas = (r) => ({ errores: r.errores, paquetes: r.paquetes.map(({ dir, archivo, ...p }) => ({ ...p, agentes: path.relative(dir, p.agentes) })) });
  const home = tmp('paq-home-');
  const prev = process.env.HOME;
  process.env.HOME = home;   // el uso del nombre viejo se anota en la HOME: la de laboratorio
  try {
    const nuevo = sinRutas(leerPaquetes({ packsDir: paquetes({ prueba: conHermanos }) }));
    assert.deepEqual(nuevo.errores, []);
    assert.deepEqual(sinRutas(leerPaquetes({ packsDir: paquetes({ prueba: aViejas(conHermanos) }) })), nuevo, 'con las claves viejas: lo mismo');
    const roto = leerPaquetes({ packsDir: paquetes({ prueba: { ...PRUEBA, [vieja.get('description')]: 'otra' } }) });
    assert.equal(roto.paquetes.length, 0, 'las dos claves con valores distintos: no se entrega');
    assert.match(roto.errores[0].motivo, /valores distintos/);
  } finally {
    process.env.HOME = prev;
  }
});

// T37: las guías Bizuit viven en guides/bizuit/, pero el paquete `bizuit` de agent-skills
// puede seguir nombrando la ruta vieja. Lo que se puede romper sin que nadie lo vea: una guía del
// paquete que ya no está en la ruta que nombra (el revisor la abre y no encuentra nada), o un reemplazo que apunta a una
// ruta que no existe. Las rutas nuevas salen del mapa; el paquete real, de agent-skills (TYCON_SKILLS_DIR o la HOME).
test('T37 R5_CrossRepo_PackOldPathResolvesViaShim', (t) => {
  const ROOT = path.resolve(SCRIPTS, '..');
  const MAP = path.join(SCRIPTS, 'lib', 'renames.json');
  if (!fs.existsSync(MAP)) { t.skip('NO MEDIDO — copia pública sin el mapa'); return; }
  const skillsRoot = process.env.TYCON_SKILLS_DIR
    ? path.dirname(path.resolve(process.env.TYCON_SKILLS_DIR))
    : path.join(os.homedir(), '.claude', 'agent-skills');
  const packsDir = path.join(skillsRoot, 'packs');
  if (!fs.existsSync(path.join(packsDir, 'bizuit', 'pack.json'))) { t.skip(`NO MEDIDO — sin el paquete bizuit de agent-skills (${packsDir})`); return; }
  const L = require(path.join(SCRIPTS, 'lib', 'legacy-names.js'));
  const r5 = JSON.parse(fs.readFileSync(MAP, 'utf8')).entries.filter((e) => e && e.batch === 'R5' && e.kind === 'file');
  assert.ok(r5.length > 0, 'el mapa no tiene entradas de la tanda R5');
  const { leerPaquetes } = require(LIB);
  const r = leerPaquetes({ packsDir });
  assert.deepEqual(r.errores, [], 'los paquetes reales se leen sin errores');
  const bizuit = r.paquetes.find((p) => p.nombre === 'bizuit');
  assert.ok(bizuit && bizuit.guias.length > 0, 'el paquete bizuit trae guías');
  let porReemplazo = 0;
  for (const g of bizuit.guias) {
    const abs = path.join(ROOT, g);
    assert.ok(fs.existsSync(abs), `${g}: la guía que nombra el paquete se encuentra en el arnés`);
    const e = r5.find((x) => x.old === g);
    if (!e) continue;   // una guía que el paquete ya nombra en su ruta nueva, o que no se movió
    porReemplazo += 1;
    const text = fs.readFileSync(abs, 'utf8');
    assert.ok(L.isGeneratedShim(g, text), `${g}: en la ruta vieja está el reemplazo generado`);
    const target = L.shimTarget(abs);
    assert.strictEqual(target, path.join(ROOT, e.new), `${g}: el reemplazo nombra ${e.new}`);
    assert.ok(fs.existsSync(target), `${e.new} existe`);
    assert.ok(text.split('\n')[0].includes(e.new), `${g}: quien la abre lee en la primera línea «movida a ${e.new}»`);
  }
  if (porReemplazo === 0) t.diagnostic('el paquete bizuit ya nombra las rutas nuevas: no queda nada que resolver por reemplazo');
  // la auditoría del arnés, con los paquetes y agentes reales: ningún chequeo en rojo por una guía que falta
  const audit = spawnSync(process.execPath, [AUDIT, '--json'], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TYCON_PACKS_DIR: packsDir, TYCON_AGENTS_DIR: path.join(skillsRoot, 'agents') },
  });
  let rep;
  try { rep = JSON.parse(audit.stdout); } catch (err) { assert.fail(`harness-audit --json no devolvió JSON (${audit.status}): ${(audit.stderr || '').slice(0, 400)}`); }
  const guidesDir = path.join(ROOT, 'guides') + path.sep;
  const nombres = [...bizuit.guias, ...r5.flatMap((e) => [e.old, e.new])];
  const faltantes = rep.categories.flatMap((c) => c.checks || [])
    .filter((c) => (typeof c.file === 'string' && c.file.startsWith(guidesDir) && !fs.existsSync(c.file))
      || (!c.passed && nombres.some((n) => `${c.name} ${c.file || ''}`.includes(n))))
    .map((c) => `${c.name} (${c.file})`);
  assert.deepEqual(faltantes, [], 'harness-audit no reporta ninguna guía faltante');
});

// La sonda «cableado en pipeline.js + guardado por test-pipeline-coverage.js» de la auditoría mira
// sólo revisores del núcleo — con el árbol de esta rama, todos en verde y ninguno de los trece que viven en un paquete
test('T23 Bench_And_Audit_FindReviewers · la sonda de cableado de la auditoría es del núcleo', () => {
  const casa = tmp('audit-cableado-');
  fs.mkdirSync(path.join(casa, '.claude'), { recursive: true });
  fs.symlinkSync(path.resolve(SCRIPTS, '..'), path.join(casa, '.claude', 'agent-skills'));
  const checks = nodeJson(`process.stdout.write(JSON.stringify(require(${JSON.stringify(AUDIT)}).checkPipelineWiring().checks))`, { HOME: casa });
  const sonda = checks.filter((c) => /^Advisor ".*" cableado en pipeline\.js/.test(c.name));
  assert.equal(sonda.length, 3, JSON.stringify(checks.map((c) => c.name)));
  assert.deepEqual(sonda.filter((c) => !c.passed).map((c) => `${c.name} ${JSON.stringify(c.detail)}`), [], 'la sonda sale verde en el árbol de la rama');
  const DE_PAQUETE = ['migration-impact-analyzer', 'signalr-hub-reviewer', 'signalr-client-reviewer', 'worker-lifecycle-reviewer', 'http-resilience-reviewer',
    'tycon-feature-wiring-checker', 'tycon-plugin-dotnet-conventions', 'tycon-plugin-react-conventions', 'tycon-plugin-nextjs-conventions',
    'multi-tenant-isolation-reviewer', 'drizzle-migration-reviewer', 'nextjs-app-router-security', 'auth-session-reviewer'];
  assert.deepEqual(sonda.filter((c) => DE_PAQUETE.some((a) => c.name.includes(`"${a}"`))), [], 'la sonda no pide a un revisor de paquete en pipeline.js');
});
