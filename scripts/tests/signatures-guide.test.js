'use strict';
/**
 * signatures-guide.test.js — el catálogo de firmas del dueño y su guía dicen lo mismo (@story-8.139).
 *
 * El catálogo (scripts/lib/signatures.js) es la lista de todo lo que un freno le pide firmar al dueño: lo leen el lector
 * de la configuración (qué se puede delegar y qué es sólo del dueño) y los frenos. La guía (guides/firmas-del-arnes.md)
 * es lo que lee la persona para decidir qué delega. Si una firma está en uno y no en el otro, la persona decide sobre
 * una lista que no es la que el arnés aplica.
 *
 *   T1 · una fila de la guía por entrada del catálogo, con todas sus columnas iguales; están todas las firmas de la
 *        tabla de «Origen» de la story; la tabla de grupos de la guía es la del catálogo.
 *   T2 · la guía dice en voz alta que lo delegado no está protegido contra un agente tramposo (decisión 10).
 *   8.141 T7 · `adhoc-lane` (abrir el arreglo rápido) está en el catálogo y en ningún grupo de la 8.116.
 *   8.141 T17 · la guía de firmas, la de coordinación y el «Portón de carril» dicen la firma y el relevo local; nada
 *        nombra el clasificador, sus variables ni una vía remota.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const CATALOGO = path.join(RAIZ, 'scripts', 'lib', 'signatures.js');
const GUIA = path.join(RAIZ, 'guides', 'firmas-del-arnes.md');

// todas las firmas que piden los frenos hoy, escritas a mano para que una que se pierda del catálogo se note: cada escape
// es su propia entrada
const DE_LA_STORY = ['plan-approval', 'extra-round', 'refresh-after-main', 'control-change', 'critical-waiver',
  'runtime-waiver', 'manual-test', 'browser-test', 'lost-run', 'adversarial-skip', 'pending-approval', 'adhoc-lane',
  'escape:TYCON_SAFETY_OFF', 'escape:TYCON_PROD_LINT', 'escape:TYCON_NEW_NAMES', 'escape:TYCON_TEST_GATE',
  'escape:DOD_BYPASS', 'escape:TYCON_NO_DEEP_REVIEW', 'escape:TYCON_STATUS_GATE',
  'escape:story-skill-bypass', 'escape:set-autonomous', 'escape:cerrar-la-ejecucion', 'escape:cerrar-como-deuda',
  'escape:force-manual', 'escape:trust-ran', 'escape:ALLOW_DOD_EVIDENCE_WRITE', 'escape:dod_runtime_exempt',
  'escape:no-deep-review', 'escape:cambiar-el-estado', 'save'];

const OTRA_SESION = { yes: 'sí', no: 'no, por la terminal', pending: 'todavía sin comando' };

/** Las filas de la tabla que sigue al título `titulo`, como listas de celdas (sin la cabecera ni el separador). */
function tabla(texto, titulo) {
  const i = texto.indexOf(`\n${titulo}\n`);
  assert.ok(i >= 0, `la guía no tiene la sección «${titulo}»`);
  const filas = [];
  let empezo = false;
  for (const renglon of texto.slice(i + titulo.length + 2).split('\n')) {
    if (renglon.startsWith('|')) { empezo = true; filas.push(renglon.slice(1, -1).split(' | ').map((c) => c.trim())); continue; }
    if (empezo) break;
  }
  return filas.slice(2);
}

// T1 SignaturesGuide_UnaFilaPorFirma @story-8.139 @ac-1 @ac-2
// 🔴 Falla con: una firma del catálogo sin su fila en la guía, una columna distinta, o una firma de la story sin entrada.
test('8.139 T1 SignaturesGuide_UnaFilaPorFirma', () => {
  const cat = require(CATALOGO);
  const ids = cat.SIGNATURES.map((s) => s.id);
  assert.deepStrictEqual([...ids].sort(), [...DE_LA_STORY].sort(), 'el catálogo trae exactamente las firmas de la story');
  for (const s of cat.SIGNATURES) {
    for (const k of ['id', 'approves', 'command', 'otherSession']) assert.ok(typeof s[k] === 'string' && s[k].trim(), `${s.id}: falta ${k}`);
    assert.ok(Object.keys(OTRA_SESION).includes(s.otherSession), `${s.id}: otherSession ${s.otherSession}`);
    assert.ok(s.terminal === null ? s.otherSession === 'pending' : typeof s.terminal === 'string' && s.terminal.trim(), `${s.id}: terminal`);
  }
  const texto = fs.readFileSync(GUIA, 'utf8');
  const filas = tabla(texto, '## Las firmas');
  assert.deepStrictEqual(filas.map((f) => f[0]), ids.map((id) => `\`${id}\``), 'una fila por firma, en el orden del catálogo');
  for (const [i, s] of cat.SIGNATURES.entries()) {
    assert.deepStrictEqual(filas[i], [`\`${s.id}\``, s.approves, `\`${s.command}\``, OTRA_SESION[s.otherSession], s.terminal === null ? '—' : `\`${s.terminal}\``], s.id);
  }
  const grupos = tabla(texto, '## Los grupos de la 8.116');
  assert.deepStrictEqual(grupos.map((f) => f[0]), Object.keys(cat.GROUPS).map((g) => `\`${g}\``));
  for (const [i, g] of Object.keys(cat.GROUPS).entries()) {
    assert.strictEqual(grupos[i][1], cat.GROUPS[g].map((id) => `\`${id}\``).join(', '), g);
  }
  assert.ok(!Object.keys(cat.GROUPS).includes('off'), '«off» no es un grupo');
  assert.strictEqual(Object.keys(cat.GROUPS).length, 11);
});

// T2 SignaturesGuide_DiceLoDelegadoNoEstaProtegido @story-8.139 @ac-2
// 🔴 Falla con: la guía sin la sección, o una sección que no dice que la coordinadora es un agente que puede aprobar sola.
test('8.139 T2 SignaturesGuide_DiceLoDelegadoNoEstaProtegido', () => {
  const texto = fs.readFileSync(GUIA, 'utf8');
  const i = texto.indexOf('\n## Lo delegado no está protegido\n');
  assert.ok(i >= 0, 'falta la sección');
  const seccion = texto.slice(i + 1).split('\n## ')[0];
  for (const frase of ['La sesión de la coordinadora es un agente', 'el arnés no lo distingue de un ok del dueño',
    'sólo va lo de bajo riesgo']) {
    assert.ok(seccion.includes(frase), `la sección no dice «${frase}»`);
  }
});

const TRES = ['escape:force-manual', 'escape:trust-ran', 'runtime-waiver'];

// T14 Catalogo_TresFirmas_OtraSesionSi @story-8.142 @ac-5 @ac-6 @ac-7
// 🔴 Falla con: una de las tres sin «sí, desde otra sesión», o los dos escapes que siguen pidiéndose por el freno.
test('8.142 T14 Catalogo_TresFirmas_OtraSesionSi', () => {
  const cat = require(CATALOGO);
  const de = (id) => cat.SIGNATURES.find((s) => s.id === id);
  for (const id of TRES) assert.strictEqual(de(id).otherSession, 'yes', id);
  for (const id of ['escape:force-manual', 'escape:trust-ran']) {
    assert.strictEqual(de(id).kind, 'guion', id);
    assert.match(de(id).command, /--for-session <D>/, `${id}: la forma canónica nombra la sesión destino`);
    assert.match(de(id).terminal, /--terminal/, `${id}: la terminal`);
  }
  assert.match(de('escape:force-manual').command, /^marker\.js set-check <control> <estado> --force-manual/);
  assert.match(de('escape:trust-ran').command, /^pipeline\.js check-count --repo <r> --story <s> --trust-ran/);
});

// T15 SignaturesGuide_TresFilas @story-8.142 @ac-10
// 🔴 Falla con: la guía que todavía dice «no, por la terminal» para alguna de las tres, o sin su forma nueva.
test('8.142 T15 SignaturesGuide_TresFilas', () => {
  const cat = require(CATALOGO);
  const filas = tabla(fs.readFileSync(GUIA, 'utf8'), '## Las firmas');
  for (const id of TRES) {
    const f = filas.find((x) => x[0] === `\`${id}\``);
    assert.ok(f, `${id}: sin fila`);
    assert.strictEqual(f[3], 'sí', id);
    assert.strictEqual(f[2], `\`${cat.SIGNATURES.find((s) => s.id === id).command}\``, id);
  }
});

// T14 SignaturesGuide_FilaSave @story-8.143 @ac-10
// 🔴 Falla con: el ok de guardar en el catálogo sin su fila en la guía, o con la fila que dice que no se da desde otra sesión.
test('8.143 T14 SignaturesGuide_FilaSave', () => {
  const cat = require(CATALOGO);
  const f = tabla(fs.readFileSync(GUIA, 'utf8'), '## Las firmas').find((x) => x[0] === '`save`');
  assert.ok(f, 'la guía trae la fila de «save»');
  assert.strictEqual(f[3], 'sí');
  assert.strictEqual(f[2], `\`${cat.SIGNATURES.find((s) => s.id === 'save').command}\``);
});

// 8.141 T7 Signatures_AdhocLane_FueraDeLosGrupos @story-8.141 @ac-3 @ac-10
// 🔴 Falla con: la firma ausente, con otra forma, o traída por algún grupo (un perfil que delega un grupo la delegaría
// sin nombrarla).
test('8.141 T7 Signatures_AdhocLane_FueraDeLosGrupos', () => {
  const cat = require(CATALOGO);
  const s = cat.SIGNATURES.find((x) => x.id === 'adhoc-lane');
  assert.ok(s, 'adhoc-lane está en el catálogo');
  assert.strictEqual(s.kind, 'guion');
  assert.strictEqual(s.otherSession, 'yes');
  assert.strictEqual(s.approves, 'abrir el arreglo rápido de una sesión, sin historia');
  assert.strictEqual(s.approvesEn, "open a session's quick fix, with no story");
  assert.strictEqual(s.command, "marker.js adhoc set '<json>'");
  assert.strictEqual(s.terminal, "marker.js adhoc set '<json>' --terminal --for-session <id>");
  for (const g of cat.groupNames()) assert.ok(!cat.expand(g).includes('adhoc-lane'), `el grupo ${g} no la trae`);
  assert.deepStrictEqual(cat.expand('adhoc-lane'), ['adhoc-lane'], 'por su nombre sí');
});

// Los archivos de texto del repo (sin node_modules, .git ni lo local de cada máquina), con su ruta relativa.
function archivosDelRepo(dir = RAIZ, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.advisors', '.codegraph'].includes(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...archivosDelRepo(path.join(dir, e.name), r));
    else if (/\.(js|sh|ps1|json|md|yaml|yml|html)$/.test(e.name)) out.push(r);
  }
  return out;
}

// 8.141 T17 SignaturesGuide_TraeAdhocLane @story-8.141 @ac-7 @ac-11
// 🔴 Falla con: la guía de coordinación sin el relevo local, el portón pidiendo la cita, o un archivo que todavía nombra
// el clasificador, sus variables o la vía remota que el dueño descartó.
test('8.141 T17 SignaturesGuide_TraeAdhocLane', () => {
  const guia = fs.readFileSync(GUIA, 'utf8');
  assert.match(guia, /\| `adhoc-lane` \|/, 'la fila de adhoc-lane (T1 compara sus columnas)');
  for (const g of ['guides/coordination.md', 'guides/coordination.en.md']) {
    const t = fs.readFileSync(path.join(RAIZ, g), 'utf8');
    assert.match(t, /adhoc-lane/, `${g} nombra la firma`);
    assert.match(t, /adhoc set '<json>' --for-session/, `${g} dice cómo la declara la designada`);
  }
  assert.match(fs.readFileSync(path.join(RAIZ, 'guides', 'coordination.md'), 'utf8'), /coordinadora de otra máquina[^\n]*designada de la máquina destino/,
    'coordination.md: la coordinadora de otra máquina se la pide a la designada de la máquina destino');
  assert.match(fs.readFileSync(path.join(RAIZ, 'guides', 'coordination.en.md'), 'utf8'), /coordinator on another machine[^\n]*designated session of the target machine/,
    'coordination.en.md: lo mismo en inglés');
  const skill = fs.readFileSync(path.join(RAIZ, 'skills', 'tycon-pipeline', 'SKILL.md'), 'utf8');
  const i = skill.indexOf('## 🔒 Portón de carril');
  assert.ok(i >= 0, 'SKILL.md tiene la sección «Portón de carril»');
  const porton = skill.slice(i).split('\n## ')[0];
  assert.doesNotMatch(porton, /fragmento LITERAL/i);
  assert.match(porton, /ventana de permiso/);
  // el código y las guías: ni el clasificador, ni sus variables (palabra entera: el apagado del aviso sigue), ni la vía
  // remota. Afuera: las pruebas y los casos del banco que sólo ponen la variable, las constancias y las capturas. Con el
  // repo del equipo debajo, también su historia, que no se publica: cuenta cómo era antes, no lo nombra como vigente; y en
  // el árbol armado, lo que la superposición no trajo, que es del privado (lo del público se mide en su CI).
  const historia = ['specs/', 'tasks/', '.dashboard/', 'artifacts/', 'inbox/', 'onboarding/mini-class/'];
  const traidos = require(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.js')).broughtByOverlay(RAIZ);
  const afuera = (r) => /(^|\/)tests\//.test(r) || r.startsWith('scripts/controls-bench/') || r.startsWith('.github/control-changes/')
    || r.startsWith('guides/sitio-de-la-organizacion/capturas/') || historia.some((d) => r.startsWith(d))
    || (traidos && !traidos.has(r));
  const prohibidos = [/\bTYCON_LANE_LLM\b/, /\bTYCON_LANE_LLM_MODEL\b/, /\bTYCON_LANE_LLM_MS\b/, /lane-classifier/, /classifyLane/,
    /designate-remote-relay/, /adhoc set --remote/, /arreglo rápido delegado:/];
  const malos = [];
  for (const r of archivosDelRepo()) {
    if (afuera(r)) continue;
    const t = fs.readFileSync(path.join(RAIZ, r), 'utf8');
    for (const re of prohibidos) if (re.test(t)) malos.push(`${r}: ${re.source}`);
  }
  assert.deepStrictEqual(malos, [], 'nadie nombra el clasificador, sus variables ni la vía remota');
});

// La tabla de niveles del esquema de firmas, escrita a mano para que un cambio de nivel en el catálogo se note:
// id, nivel, perfiles. 7 de rutina, 15 de excepción, 4 irreversibles.
const TABLA_DE_NIVELES = [
  ['plan-approval', 1, ['dev', 'mant']], ['extra-round', 1, ['dev', 'mant']], ['pending-approval', 1, ['dev', 'mant']],
  ['save', 1, ['dev', 'mant']], ['browser-test:prepare', 1, ['dev', 'mant']], ['adhoc-lane', 1, ['dev', 'mant']],
  ['refresh-after-main', 1, ['mant']],
  ['save:sensible', 2, ['dev', 'mant']], ['adhoc-lane:sobre-cupo', 2, ['dev', 'mant']], ['escape:DOD_BYPASS', 2, ['dev', 'mant']],
  ['critical-waiver', 2, ['dev', 'mant']], ['runtime-waiver', 2, ['dev', 'mant']], ['manual-test', 2, ['dev', 'mant']],
  ['browser-test:no', 2, ['dev', 'mant']], ['adversarial-skip', 2, ['dev', 'mant']], ['lost-run', 2, ['dev', 'mant']],
  ['escape:force-manual', 2, ['dev', 'mant']], ['escape:trust-ran', 2, ['dev', 'mant']],
  ['escape:TYCON_TEST_GATE', 2, ['dev', 'mant']], ['escape:TYCON_STATUS_GATE', 2, ['dev', 'mant']],
  ['escape:story-skill-bypass', 2, ['dev', 'mant']], ['escape:set-autonomous', 2, ['dev', 'mant']],
  ['control-change', 3, ['mant']], ['escape:TYCON_SAFETY_OFF', 3, ['dev', 'mant']], ['escape:TYCON_PROD_LINT', 3, ['dev', 'mant']],
  ['escape:TYCON_NEW_NAMES', 3, ['mant']],
];

// Lo que cubre cada firma de hoy que no es su propio id de la tabla: las tres que se parten y los siete escapes que se
// unen a otra firma. Las demás cubren el id de la tabla con su mismo nombre.
const CUBRE = {
  'save': ['save', 'save:sensible'],
  'browser-test': ['browser-test:prepare', 'browser-test:no'],
  'escape:dod_runtime_exempt': ['runtime-waiver'],
  'escape:ALLOW_DOD_EVIDENCE_WRITE': ['manual-test'],
  'escape:TYCON_NO_DEEP_REVIEW': ['adversarial-skip'],
  'escape:no-deep-review': ['adversarial-skip'],
  'escape:cerrar-la-ejecucion': ['lost-run'],
  'escape:cerrar-como-deuda': ['lost-run'],
  'escape:cambiar-el-estado': ['escape:TYCON_STATUS_GATE'],
};

// niveles T1 Catalogo_TablaDeNiveles
// 🔴 Falla con: un id de la tabla que falta, sobra, o cambió de nivel o de perfil.
test('niveles T1 Catalogo_TablaDeNiveles', () => {
  const cat = require(CATALOGO);
  assert.deepStrictEqual(cat.LEVELS.map((l) => [l.id, l.level, [...l.profiles]]), TABLA_DE_NIVELES);
  const cuenta = [1, 2, 3].map((n) => cat.LEVELS.filter((l) => l.level === n).length);
  assert.deepStrictEqual(cuenta, [7, 15, 4], '7 de rutina, 15 de excepción, 4 irreversibles');
  for (const l of cat.LEVELS) assert.ok(typeof l.approves === 'string' && l.approves.trim(), `${l.id}: falta qué aprueba`);
});

// niveles T2 Catalogo_CadaFirmaApuntaASuNivel
// 🔴 Falla con: una firma de hoy sin su id de la tabla, con otro, o con un nivel o perfil que no es el que sale de él.
test('niveles T2 Catalogo_CadaFirmaApuntaASuNivel', () => {
  const cat = require(CATALOGO);
  const nivel = Object.fromEntries(TABLA_DE_NIVELES.map(([id, n, p]) => [id, { n, p }]));
  for (const s of cat.SIGNATURES) {
    const cubre = CUBRE[s.id] || [s.id];
    assert.deepStrictEqual([...s.covers], cubre, `${s.id}: lo que cubre`);
    assert.strictEqual(s.level, Math.max(...cubre.map((id) => nivel[id].n)), `${s.id}: su nivel es el mayor de lo que cubre`);
    assert.deepStrictEqual([...s.profiles], ['dev', 'mant'].filter((p) => cubre.some((id) => nivel[id].p.includes(p))), `${s.id}: perfiles`);
  }
  // cada id de la tabla lo pide alguna firma de hoy, salvo pasarse del cupo diario, que todavía no existe
  const pedidos = new Set(cat.SIGNATURES.flatMap((s) => s.covers));
  assert.deepStrictEqual(TABLA_DE_NIVELES.map(([id]) => id).filter((id) => !pedidos.has(id)), ['adhoc-lane:sobre-cupo']);
});

// niveles T3 Catalogo_NivelPorDelegacion
// 🔴 Falla con: el ok de guardar contado como excepción (la delegación ya no firma un cambio sensible), o una firma que
// cubre una excepción contada como rutina.
test('niveles T3 Catalogo_NivelPorDelegacion', () => {
  const cat = require(CATALOGO);
  const esperado = { 'save': 1, 'adhoc-lane': 1, 'plan-approval': 1, 'refresh-after-main': 1, 'pending-approval': 1,
    'extra-round': 1, 'browser-test': 2, 'runtime-waiver': 2, 'escape:force-manual': 2, 'escape:trust-ran': 2,
    'escape:no-deep-review': 2, 'control-change': 3, 'escape:TYCON_SAFETY_OFF': 3 };
  for (const [id, n] of Object.entries(esperado)) assert.strictEqual(cat.delegatedLevel(id), n, id);
  assert.strictEqual(cat.delegatedLevel('no-existe'), null);
});

// niveles T4 SignaturesGuide_GeneradaDelCatalogo
// 🔴 Falla con: la guía con una tabla escrita a mano que ya no es la que sale del catálogo.
test('niveles T4 SignaturesGuide_GeneradaDelCatalogo', () => {
  const gen = require(path.join(RAIZ, 'scripts', 'tools', 'signatures-guide.js'));
  const texto = fs.readFileSync(GUIA, 'utf8');
  assert.strictEqual(gen.render(texto), texto, 'la guía no es la que genera el catálogo: correr node scripts/tools/signatures-guide.js --write');
  const filas = tabla(texto, '## Los niveles');
  assert.deepStrictEqual(filas.map((f) => f[0]), TABLA_DE_NIVELES.map(([id]) => `\`${id}\``), 'una fila por id de la tabla');
  // la tabla generada se corta si se borra un marcador: no se genera a ciegas
  assert.throws(() => gen.render(texto.replace(/<!-- generado: niveles -->/, '')), /marcador/);
});

// niveles T5 Catalogo_ElPerfilSoloSube
// 🔴 Falla con: un nivel del perfil que baja el de la tabla, o una firma delegada que no mira el nivel que el perfil subió.
test('niveles T5 Catalogo_ElPerfilSoloSube', () => {
  const cat = require(CATALOGO);
  assert.strictEqual(cat.effectiveLevel('plan-approval'), 1);
  assert.strictEqual(cat.effectiveLevel('plan-approval', { 'plan-approval': 2 }), 2, 'el perfil sube');
  assert.strictEqual(cat.effectiveLevel('control-change', { 'control-change': 1 }), 3, 'el perfil no baja: gana la tabla');
  assert.strictEqual(cat.effectiveLevel('extra-round', { 'plan-approval': 3 }), 1, 'subir uno no toca otro');
  assert.strictEqual(cat.effectiveLevel('no-existe', { 'no-existe': 2 }), null);
  assert.strictEqual(cat.delegatedLevel('plan-approval', { 'plan-approval': 2 }), 2);
  assert.strictEqual(cat.delegatedLevel('save', { 'save:sensible': 3 }), 1, 'lo que la delegación no firma sigue afuera');
  assert.strictEqual(cat.delegatedLevel('save', { 'save': 2 }), 2);
  assert.strictEqual(cat.delegatedLevel('escape:no-deep-review', { 'adversarial-skip': 3 }), 3, 'el escape sube con la firma que cubre');
  assert.strictEqual(cat.delegatedLevel('extra-round', null), 1, 'sin perfil, la tabla');
});
