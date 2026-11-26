'use strict';
// office-page-english.test.js — the office page also in English (T-117, first and second part): the fixed texts of the page (titles,
// buttons, columns, the page's own notices) come out in the language of whoever looks. On the site, the language of the
// page the site built; on the local office and the fixed photo, the browser's. The texts the photo builds (states, notes,
// topics) stay in Spanish until the second part.
// The cases take the translation block out of page.js and run it alone: nothing here opens a browser.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const OFFICE_DIR = path.join(__dirname, '..', 'tools', 'office');
const CODE = fs.readFileSync(path.join(OFFICE_DIR, 'page.js'), 'utf8');
const HTML = fs.readFileSync(path.join(OFFICE_DIR, 'page.html'), 'utf8');

/** The translation block of page.js, between its two marks, run with a toy root and browser language. */
function block({ source = null, lang = 'es', browser = 'es-AR' } = {}) {
  const m = /\/\/ idioma: desde\n([\s\S]*?)\/\/ idioma: hasta\n/.exec(CODE);
  assert.ok(m, 'page.js trae el bloque del idioma entre «// idioma: desde» y «// idioma: hasta»');
  const RAIZ = { lang, dataset: source ? { source } : {} };
  return new Function('RAIZ', 'SOURCE', 'CON_OFICINAS', 'navigator', `${m[1]}; return { LANG, EN, PATRONES_EN, traducir };`)(
    RAIZ, source, source === 'site' || source === 'demo', { language: browser });
}

// The visible texts of the page template: text between tags and the labels people read (aria-label, placeholder, title).
function templateTexts() {
  const content = /<!-- contenido -->([\s\S]*?)<!-- fin del contenido -->/.exec(HTML)[1];
  const texts = new Set([/<title>([^<]*)<\/title>/.exec(HTML)[1].trim()]);
  for (const m of content.matchAll(/>([^<>]+)</g)) { const t = m[1].trim(); if (/[A-Za-zÁÉÍÓÚáéíóúñ]{2}/.test(t)) texts.add(t); }
  for (const m of content.matchAll(/\s(?:aria-label|placeholder|title)="([^"]+)"/g)) if (/[a-záéíóúñ]{2}/i.test(m[1]) && !/^T-\d+$/.test(m[1])) texts.add(m[1]);
  return [...texts];
}

test('T1 Language_SiteUsesThePageLanguage_LocalUsesTheBrowser — en el sitio, el idioma de quien mira; en la local, el del navegador', () => {
  assert.strictEqual(block({ source: 'site', lang: 'en', browser: 'es-AR' }).LANG, 'en');
  assert.strictEqual(block({ source: 'site', lang: 'es', browser: 'en-US' }).LANG, 'es', 'en el sitio manda el idioma que eligió la persona');
  assert.strictEqual(block({ source: 'local', lang: 'es', browser: 'en-US' }).LANG, 'en');
  assert.strictEqual(block({ source: 'local', lang: 'es', browser: 'es-AR' }).LANG, 'es');
  assert.strictEqual(block({ source: null, browser: 'en-GB' }).LANG, 'en', 'la foto fija, como la local');
  assert.strictEqual(block({ source: 'local', browser: 'fr-FR' }).LANG, 'es', 'otro idioma: castellano');
});

test('T2 EveryFixedTextOfThePage_HasItsEnglish — cada texto fijo de la plantilla tiene su versión en inglés', () => {
  const { EN } = block();
  const missing = templateTexts().filter((t) => !Object.prototype.hasOwnProperty.call(EN, t));
  assert.deepStrictEqual(missing, [], `sin traducción: ${missing.join(' | ')}`);
});

test('T3 EveryAgentState_HasItsEnglish — cada estado de una sesión dice su nombre en inglés', () => {
  const { EN } = block();
  const ast = /const AST=\{([^\n]*)\};/.exec(CODE)[1];
  const labels = [...ast.matchAll(/:\["([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 10, labels.join(','));
  const missing = labels.filter((l) => !EN[l]);
  assert.deepStrictEqual(missing, []);
});

test('T4 Translate_InEnglish — traduce el texto entero, conserva los espacios de los bordes y arma las frases con datos', () => {
  const { traducir } = block({ source: 'local', browser: 'en-US' });
  assert.strictEqual(traducir('  Te toca a vos \n'), '  Your turn \n');
  assert.strictEqual(traducir('Agrandar la oficina de mac-mini'), 'Enlarge the office of mac-mini');
  assert.strictEqual(traducir('sin novedades desde las 10:40'), 'no news since 10:40');
  assert.strictEqual(traducir('Implementar la historia 8.3'), 'Implementar la historia 8.3', 'lo que viene de la foto queda como vino');
  assert.strictEqual(traducir(''), '');
});

test('T5 Translate_InSpanish_LeavesEverythingAsIs — en castellano no cambia nada', () => {
  const { traducir } = block({ source: 'local', browser: 'es-AR' });
  for (const t of ['Te toca a vos', 'Agrandar la oficina de x', 'sin novedades desde las 10:40']) assert.strictEqual(traducir(t), t);
});

// La página compara el texto de un aviso con el suyo para saber si lo borra: traducido, la comparación tiene que seguir
// dando igual. Un texto que la página compara así y que tiene traducción se compara traducido de los dos lados.
test('T7 ComparedNotices_StillMatchInEnglish — un aviso que la página compara con su texto se compara traducido', () => {
  block();
  assert.deepStrictEqual([...CODE.matchAll(/[\w.]+\.textContent===[A-Z_]+/g)].map((m) => m[0]), [], 'una comparación de un texto pintado va traducida de los dos lados');
  assert.match(CODE, /traducir\(avisoEl\.textContent\)===traducir\(AVISO_SIN_NOVEDAD\)/);
  assert.match(CODE, /traducir\(o\.textContent\)===traducir\(FALLA\)/);
});

test('T6 EnglishTexts_AreText — ninguna traducción trae HTML ni queda vacía', () => {
  const { EN, PATRONES_EN } = block();
  for (const [es, en] of Object.entries(EN)) {
    assert.ok(typeof en === 'string' && en.trim(), `«${es}» sin traducción`);
    assert.doesNotMatch(en, /[<>]/, `«${es}»`);
  }
  for (const [re, en] of PATRONES_EN) { assert.ok(re instanceof RegExp); if (typeof en === 'string') assert.doesNotMatch(en, /[<>]/); else assert.strictEqual(typeof en, 'function'); }
});

// Pase adversarial (21/11): las frases que la página arma por partes quedaban a medio traducir.
test('T8 Translate_PhrasesBuiltByParts — las frases armadas por partes salen enteras en inglés', () => {
  const { traducir } = block({ source: 'local', browser: 'en-US' });
  const casos = {
    'Te toca: 3 · Trabado: 1': 'Your turn: 3 · Stuck: 1',
    'Al día a las 10:40 · pedidos leídos a las 10:35': 'Up to date at 10:40 · requests read at 10:35',
    'foto de las 10:40: no llegan fotos nuevas': 'photo at 10:40: no new photos arrive',
    '✋ Espera tu firma': '✋ Waits for your signature',
    'Trabajando · y algo más': 'Working · and something else',
    'La T-41 no está en el tablero.': 'T-41 is not on the board.',
    'Incluye sus 3 agentes': 'Includes its 3 agents',
    'Las otras 4': 'The other 4',
    'y 2 mensajes más': 'and 2 more message(s)',
    'Ver los 7': 'See all 7',
    'lun 10:40 · se pasó de la hora': 'Mon 10:40 · past its time',
    'Ctrl + rueda para acercar': 'Ctrl + wheel to zoom',
    'Y 2 sesión(es) más: están en las tarjetas de abajo.': 'And 2 more session(s): they are in the cards below.',
    'Se cortó la conexión con el sitio. Lo que ves es lo último que llegó; vuelvo a intentar en 4 s.': 'The connection with the site was cut. What you see is the last that arrived; trying again in 4 s.',
    'Esta máquina no tiene coordinadora designada: no hay con quién cruzar los mensajes. No se guardan en el disco. Si esta máquina está aprobada en el sitio de la organización, se ven también ahí.':
      "This machine has no designated coordinator: there is no one to cross the messages with. They are not saved to disk. If this machine is approved on the organization's site, they show there too.",
    'No pude dibujar la última novedad; la oficina muestra la anterior. Corré /office otra vez si sigue así.': 'I could not draw the latest update; the office shows the previous one. Run /office again if it keeps happening.',
  };
  for (const [es, en] of Object.entries(casos)) assert.strictEqual(traducir(es), en, es);
});

// Pase adversarial (21/11): la traducción alcanzaba lo que escribieron las personas y las sesiones.
test('T9 PeopleTexts_NotTranslated — las conversaciones y los títulos van marcados para quedar como vinieron', () => {
  assert.match(CODE, /cuerpo\.forEach\(n=>n\.setAttribute&&n\.setAttribute\("translate","no"\)\)/, 'el cuerpo de cada mensaje');
  assert.match(CODE, /tit\.setAttribute\("translate","no"\)/, 'el título de cada tarjeta');
  // segunda vuelta del pase: el mismo título aparece también en el detalle, a medio camino, la lista por tema y el panel
  for (const donde of ['el("b",null,i.titulo)', 'el("b",null,w.titulo)', 'mk("b",null,r.titulo||"")']) assert.ok(CODE.includes(`Object.assign(${donde},{translate:false})`), donde);
  assert.ok(CODE.includes('Object.assign(el("h3",null,i.titulo||"Sin título"),{translate:!i.titulo})'), 'el título del detalle');
  const sinMarca = [...CODE.matchAll(/(?<!Object\.assign\()(?:el|mk)\("(?:b|h3)",[^,]*,\s*[a-z]\.titulo\b/g)].map((m) => m[0]);
  // `g.titulo` es el nombre de un grupo de «Trabado» que arma la foto: se traduce en la segunda parte
  assert.deepStrictEqual(sinMarca.filter((x) => !x.includes('"una-linea"') && !x.includes('g.titulo')), [], 'un título sin marcar');
  assert.match(CODE, /function traducirNodo\(n\)\{\n  if\(sinTraducir\(n\)\)return;/, 'lo marcado no se traduce');
});

// Pase adversarial (21/11): en el sitio, el título de la pestaña lo escribe la página fuera de su caja.
test('T10 Site_HeadingAndTitle_Translated — el título de la pestaña del sitio sale en el idioma de quien mira', () => {
  assert.match(CODE, /textContent=traducir\("Oficinas del equipo"\);document\.title=traducir\("Oficinas del equipo"\)/);
});

// Segunda vuelta del pase (21/11): una frase con un dato no traducía lo de adentro aunque la página lo conociera.
test('T11 Translate_WhatAPhraseCaptures — lo que captura una frase también se traduce si la página lo conoce', () => {
  const { traducir } = block({ source: 'local', browser: 'en-US' });
  assert.strictEqual(traducir('Inactiva: sin novedades desde las 10:40.'), 'Inactive: no news since 10:40.');
  assert.strictEqual(traducir('No se pudo quitar: la oficina no contestó'), 'Could not remove: the office did not answer');
  assert.strictEqual(traducir('Agrandar la oficina de mac-mini'), 'Enlarge the office of mac-mini', 'un dato que no conoce queda igual');
});

// Fila 175 (24/11): los textos que arma «Lo que te necesita» (cada cosa, dónde se contesta, por qué sólo vos, la opción
// recomendada) salían en castellano: la T2 mide sólo los textos fijos de la plantilla.
test('T12 WhatNeedsYou_BuiltTexts_InEnglish — lo que arma «Lo que te necesita» sale en inglés, con el dato como vino', () => {
  const { traducir } = block({ source: 'local', browser: 'en-US' });
  const casos = {
    'Dónde se contesta: en la ventana de permiso': 'Where to answer it: en la ventana de permiso',
    'Por qué sólo vos: es tu firma': 'Why only you: es tu firma',
    'Recomendada: aprobar': 'Recommended: aprobar',
    'Sin una opción recomendada anotada.': 'No recommended option noted.',
    'Para contestarla desde acá, abrí la oficina viva con /office.': 'To answer it from here, open the live office with /office.',
    'Firma · Tandas: el plan de la 9.9': 'Signature · Tandas: el plan de la 9.9',
    'Cuadro: ¿sigo?': 'Question box: ¿sigo?',
    'Del tablero · T-41: revisar': 'From the board · T-41: revisar',
    'Pendiente: algo': 'Pending: algo',
  };
  for (const [es, en] of Object.entries(casos)) assert.strictEqual(traducir(es), en, es);
  // cada texto fijo de los renglones de esta sección tiene su inglés: un texto nuevo sin traducir hace fallar esto
  const seccion = /const NECESITA_CLASE=[\s\S]*?\nfunction pintarNecesita/.exec(CODE)[0];
  // los textos fijos: cada literal entre comillas, leído de a uno desde el principio (así no se toma código entre dos), con
  // una palabra, menos las claves y las clases (todo en minúsculas y guiones)
  const textos = [...seccion.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1])
    .filter((t) => /[A-Za-záéíóúñ]{3}/.test(t) && !/^[a-z-]+$/.test(t));
  assert.ok(textos.length >= 9, `encontré los textos de la sección (${textos.length}: ${textos.join(' | ')})`);
  // el que termina en «: » lleva un dato atrás
  for (const t of textos) { const con = t.endsWith(': ') ? `${t}dato` : t; assert.notStrictEqual(traducir(con), con, `«${t}» no tiene su inglés`); }
});

// Segunda parte (T-117): lo que arma la foto también sale en inglés — columnas, tablas, grupos, horas y lo que hace cada sesión.
const OFFICE_JS = fs.readFileSync(path.join(__dirname, '..', 'tools', 'office.js'), 'utf8');
const WIP_JS = fs.readFileSync(path.join(__dirname, '..', 'tools', 'work-in-progress.js'), 'utf8');

test('T13 PhotoWords_HaveTheirEnglish — cada columna, tabla, grupo y frase fija de la foto tiene su versión en inglés', () => {
  const { EN } = block();
  const tablas = /const TABLES = \{([\s\S]*?)\n\};/.exec(OFFICE_JS)[1];
  const palabras = new Set([...tablas.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((w) => /[A-ZÁÉÍÓÚ]/.test(w[0])));
  for (const decl of ['COLUMN_WORD', 'BOARD_GROUPS', 'KANBAN_COLUMNS']) {
    const cuerpo = new RegExp(`const ${decl} = ([^;]+);`).exec(OFFICE_JS)[1];
    for (const m of cuerpo.matchAll(/'([^']+)'/g)) if (/[A-ZÁÉÍÓÚ]/.test(m[1][0])) palabras.add(m[1]);
  }
  palabras.add(/const OVERDUE_HOUR = '([^']+)'/.exec(WIP_JS)[1]);
  palabras.add(/const SAVE_ASK = '([^']+)'/.exec(WIP_JS)[1]);
  for (const m of OFFICE_JS.matchAll(/haciendo: '([^']+)'/g)) palabras.add(m[1]);
  const faltan = [...palabras].filter((w) => !EN[w]);
  assert.deepStrictEqual(faltan, []);
});

test('T14 Translate_PhotoPhrases — las frases con datos que arma la foto salen en inglés', () => {
  const { traducir } = block({ source: 'site', lang: 'en' });
  const casos = {
    'lun 10:40 · +1 h 20 tarde': 'Mon 10:40 · +1 h 20 late',
    'mar 09:00 · 35 min antes': 'Tue 09:00 · 35 min early',
    'se pasó de la hora · sin novedades desde las 10:40': 'past its time · no news since 10:40',
    'espera 3 tareas de fondo': 'waits for 3 background tasks',
    '2 en curso · 1 en espera · 4 sin comenzar': '2 in progress · 1 waiting · 4 not started',
    'Va por el paso «Correr pruebas».': 'On the step «Correr pruebas».',
    'Tablero escrito a las 10:00 (vieja)': 'Board written at 10:00 (old)',
    'Aprobar el plan: La historia (Alfa)': 'Approve the plan: La historia (Alfa)',
    'Terminó la story 7.1: falta cerrarla.': 'Finished story 7.1: it still has to be closed.',
  };
  for (const [es, en] of Object.entries(casos)) assert.strictEqual(traducir(es), en, es);
});

test('T15 BoardNote_NotTranslated — la nota de una tarjeta la escribe una persona: va marcada', () => {
  assert.ok(CODE.includes('v===i.nota?Object.assign(el("span","n",v),{translate:false})'));
});

// Pase de la segunda parte (21/11): la nota se traducía en el detalle y en el panel; la cuenta de agentes salía mezclada; y
// las frases que llevan el título de una historia traducían el título.
test('T16 PhotoPhrases_AfterThePass — la nota en todas sus vistas, los agentes en sus tres formas y el título adentro de una frase', () => {
  assert.ok(CODE.includes('fila("Nota",i.nota?Object.assign(el("span",null,i.nota),{translate:false}):i.nota)'), 'la nota en el detalle');
  assert.ok(CODE.includes('li.append(Object.assign(mk("span","m",r.nota),{translate:false}))'), 'la nota en el panel');
  const { traducir } = block({ source: 'site', lang: 'en' });
  const casos = {
    '1 agente trabajando': '1 agent working',
    '3 agentes revisando': '3 agents reviewing',
    'Unos 4 agentes trabajando': 'About 4 agents working',
    'Aprobar el plan: Historia clínica del alta (s)': 'Approve the plan: Historia clínica del alta (s)',
    'Firma: Hoy': 'Signature: Hoy',
    'Abrir el pull request: Pase adversarial': 'Open the pull request: Pase adversarial',
    'Historia 8.3': 'Story 8.3',
    'Historia clínica': 'Historia clínica',
  };
  for (const [es, en] of Object.entries(casos)) assert.strictEqual(traducir(es), en, es);
});
