#!/usr/bin/env node
/** Tests de qa-guide.js (DODRT-C7) — parsers + render. Correr: node test-qa-guide.js */
'use strict';
const path = require('path');
const qa = require(path.join(__dirname, '..', 'qa-guide.js'));

let fails = 0;
function check(name, cond) { if (cond) console.log(`  ✓ ${name}`); else { fails++; console.error(`  ✗ ${name}`); } }

console.log('qa-guide — casos:');

// ACs con encabezado `### AC1 — titulo`, el formato de las stories de un producto del equipo.
// El parser local de qa-guide.js tiene que entender también el encabezado, no sólo listas
// numeradas (`1. ...`): si no, para esas stories devolvería CERO ACs y la guía saldría con el encabezado
// diciendo "4 ACs" (ese número lo calcula OTRO parser, el canónico) y el cuerpo VACÍO, sin un solo
// caso que probar. Dos parsers leyendo el mismo documento y contestando distinto.
{
  const spec = [
    '---', 'story: "S1"', '---',
    '# Story S1',
    '## Acceptance Criteria',
    '',
    '### AC1 — El control se renderiza',
    '',
    '- **Given** un schema con el tipo nuevo, **when** se renderiza, **then** aparece la lista.',
    '',
    '### AC2 — Se guarda como array',
    '',
    'El valor viaja como array de objetos, no como texto.',
    '',
    '## Tasks / Subtasks',
    '- [ ] T1 algo',
  ].join('\n');
  const acs = qa.parseAcsWithText(spec);
  check('ACs con encabezado ### ACn: los encuentra', acs.length === 2);
  check('ACs con encabezado ### ACn: numera bien', acs.length === 2 && acs[0].n === 1 && acs[1].n === 2);
  check('ACs con encabezado ### ACn: trae el texto', acs.length === 2 && /renderiza/i.test(acs[0].text));
}

// Una sola regla de «tiene pasos-tester» para la guía y su chequeo: pasos «- …» o una descripción (los pasos numerados
// quedan como descripción); un «Usuario:» suelto no son pasos.
{
  const p = qa.parsePasos('## AC 1\n- Abrí la lista.\n→ Ves 3.\n\n## AC 2\nCargá una factura.\n\n1. Entrá.\n2. Abrí la primera.\n\n## AC 3\nUsuario: cliente\n');
  check('TienePasos_NumeradosYDescripcion_SoloUsuarioNo: pasos «- …» cuentan', qa.tienePasos && qa.tienePasos(p[1]) === true);
  check('TienePasos_NumeradosYDescripcion_SoloUsuarioNo: numerados (descripción) cuentan', qa.tienePasos && qa.tienePasos(p[2]) === true);
  check('TienePasos_NumeradosYDescripcion_SoloUsuarioNo: sólo Usuario no cuenta', qa.tienePasos && qa.tienePasos(p[3]) === false);
  check('TienePasos_NumeradosYDescripcion_SoloUsuarioNo: sin bloque no cuenta', qa.tienePasos && qa.tienePasos(undefined) === false);
}

// 1. parseAcsWithText: numerados GWT + bold-label, texto multilínea.
const spec = [
  '# Story 9.9 — Test',
  '## Acceptance Criteria',
  '',
  '1. **Given** algo,',
  '   when pasa, **Then** resultado.',
  '2. **ERROR_CASE:** input inválido → 422.',
  '',
  '### Tests',
  '',
  '| ID | Test | AC | Nivel | Escenario | Esperado |',
  '|---|---|---|---|---|---|',
  '| T1 | `Caso1` | 1 | integration | hacer X | sale Y |',
  '| E1 | `spec.ts::flujo` | 1,2 | e2e | abrir y clickear | se ve Z |',
].join('\n');

// parsePasos: descripción criolla + pares hacé/ver por AC.
const pasos = qa.parsePasos([
  '## AC 1',
  'Al abrir se ve el árbol vacío y el botón.',
  '- Abrí la orden.',
  '  → Árbol vacío + botón.',
  '## AC 2',
  'Solo dos campos.',
].join('\n'));
check('parsePasos: desc criolla de AC1', pasos[1] && pasos[1].desc === 'Al abrir se ve el árbol vacío y el botón.');
check('parsePasos: par hacé/ver de AC1', pasos[1].pairs.length === 1 && /Abrí la orden/.test(pasos[1].pairs[0].escenario) && /Árbol vacío/.test(pasos[1].pairs[0].esperado));
check('parsePasos: AC2 solo desc (sin pasos)', pasos[2] && pasos[2].desc === 'Solo dos campos.' && pasos[2].pairs.length === 0);

// parsePasos: rol por AC (Usuario:) — single, multi (;), none (—), y que NO contamine la desc.
const pasosRoles = qa.parsePasos([
  '## AC 1',
  'Usuario: Encargado general',
  'Al abrir se ve el árbol.',
  '- Abrí la orden.',
  '  → Árbol vacío.',
  '## AC 6',
  'Usuario: Encargado general (pestaña 1); Admin (pestaña 2)',
  'Dos pestañas.',
  '## AC 17',
  'Usuario: —',
  'Verificado por el sistema.',
].join('\n'));
check('parsePasos: rol single de AC1', JSON.stringify(pasosRoles[1].role) === JSON.stringify(['Encargado general']));
check('parsePasos: rol NO ensucia la desc', pasosRoles[1].desc === 'Al abrir se ve el árbol.');
check('parsePasos: rol multi (;) de AC6', JSON.stringify(pasosRoles[6].role) === JSON.stringify(['Encargado general (pestaña 1)', 'Admin (pestaña 2)']));
check('parsePasos: rol none (—) → centinela', JSON.stringify(pasosRoles[17].role) === JSON.stringify(['__none__']));
// parseDefaultRole: default a nivel archivo.
check('parseDefaultRole: lee el default del tope', JSON.stringify(qa.parseDefaultRole('Usuario por defecto: Encargado general\n\n## AC 1\n...')) === JSON.stringify(['Encargado general']));
check('parseDefaultRole: sin línea → null', qa.parseDefaultRole('## AC 1\nsin default') === null);

// resolveRoles: rol explícito gana; wv→sin login; pend/run heredan default.
const DEF = ['Encargado general'];
check('resolveRoles: explícito gana sobre default', JSON.stringify(qa.resolveRoles(['Técnico'], 'pend', DEF)) === JSON.stringify({ roles: ['Técnico'], roleNone: false }));
check('resolveRoles: pend SIN evidencia hereda el default (no sin-login)', JSON.stringify(qa.resolveRoles(null, 'pend', DEF)) === JSON.stringify({ roles: ['Encargado general'], roleNone: false }));
check('resolveRoles: run hereda el default', JSON.stringify(qa.resolveRoles(null, 'run', DEF)) === JSON.stringify({ roles: ['Encargado general'], roleNone: false }));
check('resolveRoles: wv → sin login (roleNone)', JSON.stringify(qa.resolveRoles(null, 'wv', DEF)) === JSON.stringify({ roles: [], roleNone: true }));
check('resolveRoles: explícito "—" → sin login', JSON.stringify(qa.resolveRoles(['__none__'], 'pend', DEF)) === JSON.stringify({ roles: [], roleNone: true }));
check('resolveRoles: sin default y no-wv → vacío (needsRole lo flaggea)', JSON.stringify(qa.resolveRoles(null, 'pend', null)) === JSON.stringify({ roles: [], roleNone: false }));

const acs = qa.parseAcsWithText(spec);
check('parsea 2 ACs', acs.length === 2);
check('AC#1 une líneas multilínea', acs[0].n === 1 && /when pasa/.test(acs[0].text));
check('AC#2 (bold-label) parseado', acs[1].n === 2 && /ERROR_CASE/.test(acs[1].text));

// 2. parseTestsFull: columnas Escenario/Esperado + acRefs multi.
const tests = qa.parseTestsFull(spec);
check('parsea 2 filas de tests', tests.length === 2);
check('E1 mapea AC 1 y 2', tests[1].acRefs.includes(1) && tests[1].acRefs.includes(2));
check('extrae Escenario', tests[1].escenario === 'abrir y clickear');
check('extrae Esperado', tests[1].esperado === 'se ve Z');

// 3. renderHtml: escapa, muestra badge por tier, incluye razón de NOT-VERIFIABLE.
const html = qa.renderHtml({
  sid: '9.9', title: 'T', preambleHtml: '<p>setup</p>', generatedAt: 'x', embeddedState: { v1: 'pass' },
  stats: { total: 3, runtime: 2, waived: 0, notVerifiable: 1 },
  cards: [
    { n: 1, text: 'Titular en criollo <script>', acTextTech: 'AC tecnico crudo', tier: 'run', badge: 'verificado corriendo', tierNote: null, pruebas: [{ escenario: 'hacer X', esperado: 'ver Y' }], tecnica: [{ escenario: 'dev esc', esperado: 'dev esp' }], cmds: ['curl x'], needsPasos: false, needsDesc: false },
    { n: 2, text: 'otro', acTextTech: null, tier: 'wv', badge: 'no verificable por la app', tierNote: 'No se puede: razón X. Cubierto por **T2**.', pruebas: [], tecnica: [], cmds: [], needsPasos: false, needsDesc: false },
    { n: 3, text: 'sin pasos', acTextTech: null, tier: 'run', badge: 'verificado corriendo', tierNote: null, pruebas: [], tecnica: [{ escenario: 'e', esperado: 'x' }], cmds: [], needsPasos: true, needsDesc: true, roles: ['Encargado general'], roleNone: false },
    { n: 4, text: 'sistema', acTextTech: null, tier: 'run', badge: 'verificado corriendo', tierNote: null, pruebas: [], tecnica: [], cmds: [], needsPasos: false, needsDesc: false, roles: [], roleNone: true },
  ],
});
check('es HTML self-contained', /<!doctype html>/i.test(html) && /<style>/.test(html) && !/https?:\/\//.test(html.replace(/lang="es"/, '')));
check('escapa el <script> del texto', /criollo &lt;script&gt;/.test(html) && !/criollo <script>/.test(html));
check('muestra badge runtime y waived', /badge-run/.test(html) && /badge-wv/.test(html));
check('titular en criollo (no el texto técnico)', /class="actext">Titular en criollo /.test(html) && !/class="actext">AC tecnico crudo</.test(html));
check('texto técnico del AC baja al <details>', /AC \(texto técnico\):<\/span> AC tecnico crudo/.test(html));
check('separa hacé/tenés-que-ver por prueba (tester)', /Hac[eé]:<\/span> hacer X/.test(html) && /ver:<\/span> ver Y/.test(html));
check('detalle técnico va a un <details>', /Detalle t[eé]cnico \(para el dev\)/.test(html) && /dev esc/.test(html));
check('AC sin pasos-tester avisa "faltan"', /Faltan los pasos en lenguaje de tester/.test(html));
check('incluye la razón del NOT-VERIFIABLE', /No se puede: razón X/.test(html));
check('botón Guardar + Limpiar por-AC', /onclick="guardar\(\)"/.test(html) && /onclick="limpiar\(1\)"/.test(html));
check('NO tiene botón imprimir', !/window\.print/.test(html));
check('embebe el estado guardado (qa-state)', /id="qa-state"[^>]*>\{"v1":"pass"\}</.test(html));
check('la nota dice que Guardar escribe el HTML', /este mismo archivo HTML/.test(html));
check('incluye el preámbulo', /setup/.test(html));
// Guardar usa el filename real generado (no un derivado del SID).
const htmlFn = qa.renderHtml({ sid: '10.4', title: 'T', cards: [], stats: { total: 0, runtime: 0, waived: 0, notVerifiable: 0 }, generatedAt: 'x', outFileName: '10-4-flujo-devolucion-guia-qa.html' });
check('Guardar usa el outFileName real (no SID-based)', /var FNAME="10-4-flujo-devolucion-guia-qa\.html"/.test(htmlFn) && /var fname=FNAME/.test(htmlFn));
check('sin outFileName → fallback SID-based', /var FNAME="9-9-guia-qa\.html"/.test(qa.renderHtml({ sid: '9.9', title: 'T', cards: [], stats: { total: 0, runtime: 0, waived: 0, notVerifiable: 0 }, generatedAt: 'x' })));
check('renderiza badge de rol (Encargado general)', /badge-role[^>]*>Encargado general</.test(html));
check('renderiza badge "sin login" cuando roleNone', /badge-none">Sin login — lo verifica el sistema</.test(html));

// detectJargon: caza jerga de software, deja pasar el vocabulario del dominio.
check('detectJargon caza el dev-wall', qa.detectJargon('authorized with RoleConstants.AdminRoles get 403 .RequireAuthorization() PedidosService:891 CEIX_Articulos').length >= 4);
check('detectJargon deja pasar criollo del dominio', qa.detectJargon('Agregá Tornillos, tenés que ver 3 bolsas con etiqueta A&B; no da error.').length === 0);
check('detectJargon: HTTP crudo (422/403) es jerga', qa.detectJargon('el sistema devuelve 422').includes('422'));
check('detectJargon: números no-HTTP no son jerga', qa.detectJargon('contá 3 bolsas').length === 0);

// isUiStory
check('isUiStory: frontmatter con .tsx → UI', qa.isUiStory('', '  - src/App.tsx'));
check('isUiStory: CeiboFrontEnd → UI', qa.isUiStory('', 'files:\n  - CeiboFrontEnd/x'));
check('isUiStory: E2E-N en el body → UI', qa.isUiStory('| E2E-1 | spec |', ''));
check('isUiStory: puro backend → no UI', qa.isUiStory('nada de front', '  - src/Foo.cs') === false);
// Con listas de archivos declaradas, la prosa del frontmatter no decide; sin listas, sí.
check('isUiStory: driver con ruta HTTP /frontend + listas .cs → no UI',
  qa.isUiStory('', 'driver: "GET /api/admin/algo/frontend responde sin sesion"\nfiles_to_modify:\n  - src/AcmeBackend/Estado.cs') === false);
check('isUiStory: título de frente sin listas → UI',
  qa.isUiStory('', 'title: "Frontend: panel de estado"\nstatus: ready-for-dev') === true);

// parsePasosSequence: orden + grupos
const seq = qa.parsePasosSequence(['## GRUPO Parte 1', '## AC 3', '## AC 1', '## GRUPO Parte 2', '## AC 2'].join('\n'));
check('parsePasosSequence: orden respeta el archivo (3 antes que 1)', JSON.stringify(seq) === JSON.stringify([{ group: 'Parte 1' }, { ac: 3 }, { ac: 1 }, { group: 'Parte 2' }, { ac: 2 }]));

// --- (6) titular legible: la regla que se hace EXIGIBLE.
// El harness avisa al generar la guía y el gate lo exige: si no, una guía podría
// cerrar en verde mostrándole al tester el texto técnico del criterio. La condición que
// decide es el mismo detector de jerga: si el AC se lee solo, no se exige descripción.
{
  const conJerga = 'El criterio se evalúa con `RepartosRepository.SearchAsync` sobre DEMO_Entregas';
  const enCriollo = 'Los casos ya resueltos o cancelados no aparecen en esta cola.';
  check('(6) AC con jerga → necesita descripción en criollo', qa.detectJargon(conJerga).length > 0);
  check('(6) AC ya legible → NO se exige descripción (anti-ruido)', qa.detectJargon(enCriollo).length === 0);
  // Un AC no verificable por la app igual aparece en la guía: la regla también lo alcanza.
  const acWaiveado = 'Given un aviso **saliente** que crea una entrega automática (`ProcessOutgoingNoticeAsync`)';
  check('(6) alcanza también a los ACs no verificables', qa.detectJargon(acWaiveado).length > 0);
}

// La guía dice en llano qué probó el arnés: la insignia, cómo lo probó y el resumen.
{
  const conE2e = qa.estadoDelArnes({ verdict: 'RUNTIME', fuentes: { e2e: ['g.md'], smoke: [] } });
  const conHumo = qa.estadoDelArnes({ verdict: 'RUNTIME', fuentes: { e2e: [], smoke: ['2026-10-20T10:00:00Z'] } });
  check('QaGuide_Apagada_ElArnesYaLoProbo @story-7.46 @ac-1 — insignia', conE2e.tier === 'run' && conE2e.badge === '✓ el arnés ya lo probó');
  check('QaGuide_Apagada_ElArnesYaLoProbo @story-7.46 @ac-1 — de punta a punta', /^Lo probó corriendo la app, con una prueba de punta a punta\. Probarlo a mano es un segundo control\.$/.test(conE2e.como));
  check('QaGuide_Apagada_ElArnesYaLoProbo @story-7.46 @ac-1 — sólo humo', conHumo.como === 'Lo probó corriendo la app. Probarlo a mano es un segundo control.');
  const pend = ['NOT-RUN', 'RUNTIME-PARCIAL'].map((v) => qa.estadoDelArnes({ verdict: v }));
  const nv = ['NOT-VERIFIABLE', 'WAIVED-USER'].map((v) => qa.estadoDelArnes({ verdict: v }));
  check('QaGuide_Apagada_PendienteYNoVerificable @story-7.46 @ac-2 — pendientes', pend.every((e) => e.tier === 'pend' && e.badge === 'El arnés no lo probó: probalo a mano' && !e.como));
  check('QaGuide_Apagada_PendienteYNoVerificable @story-7.46 @ac-2 — no verificables', nv.every((e) => e.tier === 'wv' && e.badge === 'La app no lo muestra: lo cubre una prueba del código'));
  const g = qa.renderHtml({
    sid: '9.9', title: 'T', generatedAt: 'x', stats: { total: 4, runtime: 2, waived: 0, notVerifiable: 1, pending: 1 },
    cards: [
      { n: 1, text: 'uno', tier: 'run', badge: conE2e.badge, como: conE2e.como, pruebas: [], tecnica: [], cmds: [] },
      { n: 2, text: 'dos', tier: 'run', badge: conHumo.badge, como: conHumo.como, pruebas: [], tecnica: [], cmds: [] },
      { n: 3, text: 'tres', tier: 'pend', badge: pend[0].badge, pruebas: [], tecnica: [], cmds: [] },
      { n: 4, text: 'cuatro', tier: 'wv', badge: nv[0].badge, tierNote: 'Lo cubre **T6**.', pruebas: [], tecnica: [], cmds: [] },
    ],
  });
  check('QaGuide_Resumen_EnLlano @story-7.46 @ac-3 — los cuatro números', /<b>4<\/b> criterios/.test(g) && /✓ el arnés ya probó <b>2<\/b>/.test(g) && /<b>1<\/b> para probar a mano/.test(g) && /<b>1<\/b> que la app no puede mostrar/.test(g));
  check('QaGuide_Resumen_EnLlano @story-7.46 @ac-3 — «Criterio N», sin «AC #»', /Criterio 1</.test(g) && !/AC #/.test(g));
  check('QaGuide_Resumen_EnLlano @story-7.46 @ac-3 — sin «verificado corriendo»', !/verificado corriendo/i.test(g));
  check('QaGuide_Resumen_EnLlano @story-7.46 @ac-4 — radios, Guardar y qa-state siguen', /value="pass"/.test(g) && /onclick="guardar\(\)"/.test(g) && /id="qa-state"/.test(g));
  check('QaGuide_Resumen_EnLlano @story-7.46 @ac-4 — apagada: nada de la marca a mano', !/a mano por|Falta que una persona|marcados a mano/.test(g));
  const p = qa.renderHtml({
    sid: '9.9', title: 'T', generatedAt: 'x', stats: { total: 3, runtime: 1, waived: 0, notVerifiable: 1, pending: 1 },
    manual: { prendida: true, marcas: { 1: { quien: 'Ana', ts: '2026-10-20T13:31:00Z' }, 3: { quien: 'Ana', ts: '2026-10-20T13:33:00Z' } }, faltan: [{ n: 2, text: 'dos' }] },
    cards: [
      { n: 1, text: 'uno', tier: 'run', badge: conE2e.badge, pruebas: [], tecnica: [], cmds: [] },
      { n: 2, text: 'dos', tier: 'pend', badge: pend[0].badge, pruebas: [], tecnica: [], cmds: [] },
      { n: 3, text: 'tres', tier: 'wv', badge: nv[0].badge, pruebas: [], tecnica: [], cmds: [] },
    ],
  });
  check('QaGuide_Prendida_AvisoYEstadoPorTarjeta @story-7.46 @ac-12 — aviso', /Tu organización pide que una persona marque cada criterio como probado a mano\./.test(p) && /Falta marcar 1 de 3: el criterio 2\./.test(p) && /La historia no se cierra hasta que esté marcado\./.test(p));
  check('QaGuide_Prendida_AvisoYEstadoPorTarjeta @story-7.46 @ac-12 — resumen', /✋ marcados a mano <b>2<\/b> de 3/.test(p));
  check('QaGuide_Prendida_AvisoYEstadoPorTarjeta @story-7.46 @ac-12 — probado', /✋ Probado a mano por Ana, el 20\/10 a las \d\d:31\./.test(p));
  check('QaGuide_Prendida_AvisoYEstadoPorTarjeta @story-7.46 @ac-12 — revisado', /✋ Revisado a mano por Ana, el 20\/10 a las \d\d:33\./.test(p));
  check('QaGuide_Prendida_AvisoYEstadoPorTarjeta @story-7.46 @ac-12 — falta', /✋ Falta que una persona lo marque como probado a mano\./.test(p));
}

console.log('');
if (fails) { console.error(`✗ ${fails} caso(s) fallando`); process.exit(1); }
console.log('✓ qa-guide — todos los casos verdes');
