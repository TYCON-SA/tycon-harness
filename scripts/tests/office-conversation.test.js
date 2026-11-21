'use strict';
// office-conversation.test.js — the conversation with a session from the office: the envelopes, the window and who can receive. The shared toys live in lib/office-fixtures.js.
// Through that library the cases run scripts/tools/office.js and skills/tycon-pipeline/scripts/marker.js: named
// here so the dependency reader of the validation follows them from this file, as it follows what a suite names.
// Nothing here reads the real HOME: the command-line tests run with a toy HOME.
// stable-data: every date comes in by argument or by --now.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PAGE_CODE, NOW, run, shape, toySessions, om8183, toyHome, fakeDom, perSessionCode, page, markRecipients,
  conversationOf, createEnvelopes8183, stateDir8183
} = require('./lib/office-fixtures.js');

test('T247 Envelopes_OnlyInTheLiveOffice: la página sabe volar un sobre y pedir la conversación, y la foto fija no trae ni sobres ni texto', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /lanzarSobres/);
  assert.match(html, /conversacion\?t=/);
  assert.match(html, /Tus últimos 20 mensajes con sus respuestas/);
  const { home } = toyHome();
  const data = JSON.parse(run(home, ['--json', '--now', new Date(NOW).toISOString()]));
  assert.strictEqual('sobres' in data, false, '--json no crea los sobres: viven en el proceso de la oficina');
});

test('T249 MessageFormat_NodesOnly: negritas, código y listas se arman con nodos, y lo que traiga el mensaje queda como texto', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  const src = html.slice(html.indexOf('function enLinea('), html.indexOf('function msg('));
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, 'nada del mensaje se inserta como HTML');
  const formatear = new Function('document', `${src}; return formatear;`)(fakeDom());
  const fmt = (t) => formatear(t).map(shape);
  assert.deepStrictEqual(fmt('Es **importante** y `npm test` anda.'), [['p', 'Es ', ['strong', 'importante'], ' y ', ['code', 'npm test'], ' anda.']]);
  assert.deepStrictEqual(fmt('Mirá:\n- uno\n- **dos**\n\n1. tres'), [['p', 'Mirá:'], ['ul', ['li', 'uno'], ['li', ['strong', 'dos']]], ['ol', ['li', 'tres']]]);
  assert.deepStrictEqual(fmt('```js\nconst a = 1;\nconst b = 2;\n```'), [['pre', ['code', 'const a = 1;\nconst b = 2;']]]);
  assert.deepStrictEqual(fmt('## Título'), [['p', ['strong', 'Título']]]);
  assert.deepStrictEqual(fmt('<img src=x onerror=alert(1)> **<b>hola</b>**'), [['p', '<img src=x onerror=alert(1)> ', ['strong', '<b>hola</b>']]]);
  assert.deepStrictEqual(fmt('```\n<script>alert(1)</script>'), [['pre', ['code', '<script>alert(1)</script>']]], 'un bloque sin cerrar queda como código');
  assert.deepStrictEqual(fmt('5 * 3 y 2 ** 4 sin formato'), [['p', '5 * 3 y 2 ** 4 sin formato']]);
});

test('T285 PaperPlane: el mensaje vuela como avioncito, apuntando adonde va, y su rótulo lleva un dibujo sin internet', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.doesNotMatch(html, /sobreGeo|solapaGeo|✉/, 'el sobre ya no está');
  assert.match(html, /new THREE\.Mesh\(avionGeo,avionMat\)/);
  assert.match(html, /v\.m\.rotation\.set\(-Math\.cos\(k\*Math\.PI\)\*\.3,Math\.atan2\(/, 'con la nariz hacia su destino');
  assert.match(html, /dib\.append\(T\.dibujo\(T\.AVION_ICONO\)\)/);
  assert.match(html, /v\.s\.de\+" → "\+v\.s\.a/, 'el rótulo dice quién a quién, sin el texto');
});

test('T288 Conversation_ButtonAtTheBottom: el botón va abajo de cada tarjeta, alineado entre las de la misma fila', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /\.card\{[^}]*display:flex;flex-direction:column/, 'la tarjeta es una columna, y las de una fila miden lo mismo');
  assert.match(html, /\.card \.verCharla\{margin-top:auto\}/);
});

test('T283 Conversation_CoordinatorTabs: la coordinadora tiene dos pestañas y abre en «Con vos»; una sesión común también abre en «Con vos» (8.183)', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  const paint = html.slice(html.indexOf('function pintarCharla('), html.indexOf('\n// ', html.indexOf('function pintarCharla(')));
  assert.match(paint, /pestanasCharla\(\[\["Con vos",vos\],\s*\["Con las sesiones",charlaPorSesion\(/);
  assert.match(paint, /pestanasCharla\(\[\["Con vos",vos\],\["Con la coordinadora",listaCharla\(filas/, 'las sesiones comunes suman «Con vos» a su lista con la coordinadora');
  const src = html.slice(html.indexOf('function listaCharla('), html.indexOf('function pintarCharla('));
  const node = (tag) => { const n = { tag, kids: [], dataset: {}, attrs: {}, classList: { contains: (c) => (n.className || '').split(' ').includes(c) }, append(...k) { n.kids.push(...k); }, setAttribute(k, v) { n.attrs[k] = v; } }; return n; };
  const el = (tag, className, text) => { const n = node(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
  const { pestanasCharla, listaCharla } = new Function('el', 'document', `${src}; return { pestanasCharla, listaCharla };`)(el, { createElement: node });
  const una = listaCharla([node('m')], 'vacío');
  una.scrollHeight = 900;
  const otra = listaCharla([node('m')], 'vacío');
  otra.scrollHeight = 700;
  const [tabs, primera, segunda] = pestanasCharla([['Con vos', una], ['Con las sesiones', otra]]);
  const radios = tabs.kids.map((l) => l.kids[0]);
  assert.deepStrictEqual(radios.map((r) => r.checked), [true, false], 'abre en «Con vos»');
  assert.deepStrictEqual([primera.hidden, segunda.hidden], [false, true]);
  radios[1].onchange();
  assert.deepStrictEqual([primera.hidden, segunda.hidden], [true, false], 'una por vez');
  assert.strictEqual(otra.scrollTop, 700, 'arranca en lo último');
  otra.scrollTop = 10;
  radios[0].onchange();
  radios[1].onchange();
  assert.strictEqual(otra.scrollTop, 10, 'volver no le mueve lo que estaba leyendo');
  assert.strictEqual(listaCharla([], 'vacío').textContent, 'vacío');
});

test('T282 Conversation_PageStaysStill: con la ventana abierta la página de atrás no se mueve, y al cerrarla vuelve a moverse', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /html\.con-ventana\{overflow:hidden\}/);
  assert.match(html, /\.ventana \.panel3,\.ventana \.chat\{overscroll-behavior:contain\}/, 'llegar al final de la lista no pasa la rueda a la página');
  const fn = (name) => { const at = html.indexOf(`function ${name}(`); return html.slice(at, html.indexOf('\n', at)); };
  assert.match(html.slice(html.indexOf('function abrirCharla('), html.indexOf('function cerrarCharla(')), /classList\.add\("con-ventana"\)/);
  assert.match(fn('cerrarCharla'), /classList\.remove\("con-ventana"\)/);
});

test('T267 Conversation_OnlyInItsWindow: el botón va sólo con la oficina viva, la ventana se cierra con Esc y la foto no trae el texto', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  // el botón va con de dónde pedirla: la oficina viva o el sitio; la foto fija no tiene
  assert.match(html, /if\(a\.nombre&&pedidoDeCharla\(p\)\)box\.appendChild\(botonCharla\(a\.nombre,p\)\)/, 'sin de dónde pedirla no hay botón');
  assert.match(html, /createTextNode\("Ver conversación"\)/);
  assert.match(html, /s\.appendChild\(dibujo\(CHARLA_ICONO\)\)/, 'lleva su ícono, dibujado en la página');
  assert.match(html, /\.ventana \.panel3\{[^}]*height:min\(920px,calc\(100dvh - 32px\)\)/, 'la ventana entra en la pantalla');
  assert.match(html, /\.ventana \.panel3 \.chat\{[^}]*overflow:hidden auto/, 'y los mensajes suben y bajan adentro');
  // Escape cierra la de arriba, y tocar afuera cierra sólo con un toque que empieza afuera (8.198, AC 33 y 34)
  assert.match(html, /e\.key!=="Escape"\)return;if\(!ventana\(\)\.hidden\)\{cerrarCharla\(\);return\}/);
  assert.match(html, /id="ventana" hidden/, 'arranca cerrada');
  assert.match(html, /v\.addEventListener\("click",e=>\{if\(e\.target===e\.currentTarget&&empezoAfuera\)cerrarCharla\(\)/, 'tocando afuera se cierra');
  const opensAt = html.indexOf('function abrirCharla(');
  assert.ok(opensAt >= 0);
  assert.strictEqual(html.indexOf('fetch(pedidoDeCharla('), html.indexOf('fetch(pedidoDeCharla(', opensAt), 'se lee sólo al abrirla');
  assert.doesNotMatch(html.slice(html.indexOf('function abrir(nombre'), html.indexOf('los sobres: quién')), /conversacion|pintarCharla/, 'el detalle ya no la lee');
});

test('T303 PerSession_Buttons: la más reciente abierta, en orden, y sus mensajes con los propios marcados', () => {
  const { charlaPorSesion } = perSessionCode();
  const box = charlaPorSesion('Coordinadora', toySessions(3), 'nada');
  const [fila, chat] = box.children;
  assert.deepStrictEqual(fila.children.map((b) => b.textContent), ['S0', 'S1', 'S2']);
  assert.deepStrictEqual(fila.children.map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  assert.deepStrictEqual(chat.children.map((m) => [m.quien, m.mio]), [['S0', false], ['Coordinadora', true]]);
  assert.strictEqual(fila.children[0].children[0].textContent.length, 5, 'el botón dice su hora');
});

test('T304 PerSession_Choosing: tocar otra sesión cambia los mensajes y cuál está elegida', () => {
  const { charlaPorSesion } = perSessionCode();
  const box = charlaPorSesion('Coordinadora', toySessions(3), 'nada');
  const fila = box.children[0];
  fila.children[2].onclick();
  assert.deepStrictEqual(fila.children.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  assert.strictEqual(box.children[1].children[0].texto, 'de S2');
  assert.strictEqual(box.children.length, 2, 'una sola conversación a la vista');
});

test('T305 PerSession_TheOthers: de más de 8 quedan «Las otras N», que al tocarlo muestra el resto y se va; con 8 no aparece', () => {
  const { charlaPorSesion } = perSessionCode();
  const fila = charlaPorSesion('Coordinadora', toySessions(13), 'nada').children[0];
  assert.strictEqual(fila.children.length, 9);
  const mas = fila.children[8];
  assert.strictEqual(mas.textContent, 'Las otras 5');
  mas.onclick();
  assert.deepStrictEqual(fila.children.map((b) => b.textContent), Array.from({ length: 13 }, (_, i) => `S${i}`));
  fila.children[12].onclick();
  assert.strictEqual(fila.children[12].getAttribute('aria-pressed'), 'true', 'una de las otras se puede elegir');
  assert.ok(!charlaPorSesion('Coordinadora', toySessions(8), 'nada').children[0].children.some((b) => b.className === 'mas'));
});

test('T306 PerSession_Empty_AndTheHour: sin mensajes lo dice; la hora lleva el día si no es de hoy', () => {
  const { charlaPorSesion, horaDeSesion } = perSessionCode();
  const empty = charlaPorSesion('Coordinadora', [], 'No hay mensajes con las sesiones en lo último de su conversación.');
  assert.match(empty.textContent, /^No hay mensajes con las sesiones/);
  const hoy = new Date();
  hoy.setHours(9, 5, 0, 0);
  assert.strictEqual(horaDeSesion(hoy.getTime()), '09:05');
  const otro = new Date(hoy.getTime() - 3 * 86400000);
  assert.match(horaDeSesion(otro.getTime()), /^(dom|lun|mar|mié|jue|vie|sáb) 09:05$/);
  assert.strictEqual(horaDeSesion(null), '');
});

test('T307 PerSession_Page: la ventana usa la conversación por sesión y la nota habla de cada sesión', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /\["Con las sesiones",charlaPorSesion\(nombre,d\.conSesiones\|\|\[\],/);
  assert.match(html, /los últimos 10 con cada sesión, en orden; primero la que habló último\./);
  assert.match(html, /@media \(max-width:600px\)\{\.ventana \.quienes\{flex-wrap:nowrap;overflow-x:auto/, 'en un teléfono, una sola fila');
});

test('T23 Foto_PuedeRecibir_SegunElVigilante @story-8.183 @ac-22 @ac-25: vivo «si», muerto o sin candado «sin-vigilante», Codex «codex», recién entregado «espera-cierre»', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-recibe-'));
  const sdir = stateDir8183(home);
  const env = createEnvelopes8183();
  for (const [name, sid] of [['Vivo', 's1'], ['Muerto', 's2'], ['Nada', 's3'], ['Entrego', 's4']]) env.files.set(name, { file: '/x', sid });
  fs.mkdirSync(om8183.paths(sdir).watchers, { recursive: true });
  fs.writeFileSync(om8183.paths(sdir).watcher('s1'), JSON.stringify({ pid: 111, started: 'arranque-111' }));
  fs.writeFileSync(om8183.paths(sdir).watcher('s2'), JSON.stringify({ pid: 222, started: 'arranque-222' }));
  fs.writeFileSync(om8183.paths(sdir).watcher('s4'), JSON.stringify({ pid: null, deliveredAt: NOW }));
  const data = { agents: [{ nombre: 'Vivo', estado: 'libre' }, { nombre: 'Muerto', estado: 'trabajando' }, { nombre: 'Nada', estado: 'pregunta' }, { nombre: 'Entrego', estado: 'trabajando' }, { nombre: 'Cx', estado: 'libre' }, { nombre: 'SinConversacion', estado: 'libre' }] };
  const saved = process.env.TYCON_OFFICE_MESSAGES;
  delete process.env.TYCON_OFFICE_MESSAGES;
  try {
    markRecipients(data, env, [{ name: 'Cx', tool: 'codex' }], sdir, { isAlive: (pid) => pid === 111, startOf: (pid) => `arranque-${pid}` });
  } finally { if (saved !== undefined) process.env.TYCON_OFFICE_MESSAGES = saved; }
  assert.deepStrictEqual(data.agents.map((a) => [a.nombre, a.recibe]), [['Vivo', 'si'], ['Muerto', 'sin-vigilante'], ['Nada', 'sin-vigilante'], ['Entrego', 'espera-cierre'], ['Cx', 'codex'], ['SinConversacion', undefined]]);
  assert.strictEqual(env.recipients.get('Nada').cuadro, true);
  assert.strictEqual(env.recipients.get('Muerto').ocupada, true);
  // lo que viaja al sitio es una lista cerrada: `recibe` no está
  const { FIELDS } = require(path.join(__dirname, '..', 'tools', 'office', 'fields.js'));
  assert.ok(!JSON.stringify(FIELDS).includes('recibe'));
});

test('T52 Foto_CodexSinNombre_DiceCodex @story-8.183 @ac-25: una sesión de Codex sin nombre en su archivo, con el nombre que le pone la oficina, recibe «codex»', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-codex-'));
  const sdir = stateDir8183(home);
  const sid = 'cx-sin-nombre-de-prueba';
  for (const [states, nombre, cxNames] of [[[{ tool: 'codex', session: sid }], sid.slice(0, 8), new Map()], [[{ tool: 'codex', session: sid }], 'Delta', new Map([[sid, 'Delta']])]]) {
    const env = createEnvelopes8183();
    const data = { agents: [{ nombre, estado: 'libre' }] };
    const saved = process.env.TYCON_OFFICE_MESSAGES;
    delete process.env.TYCON_OFFICE_MESSAGES;
    try { markRecipients(data, env, states, sdir, { cxNames }); } finally { if (saved !== undefined) process.env.TYCON_OFFICE_MESSAGES = saved; }
    assert.strictEqual(data.agents[0].recibe, 'codex', nombre);
    assert.strictEqual(env.recipients.get(nombre).recibe, 'codex', nombre);
  }
});

test('T24 FotoFija_NoOfreceMandar @story-8.183 @ac-37: la foto fija no trae token ni oficina viva, y el campo sólo se arma con la oficina viva', () => {
  const html = page({ agents: [{ nombre: 'Alfa', estado: 'libre', recibe: 'si' }], items: [], meta: {}, unreadable: [] });
  assert.ok(!/data-token=/.test(html));
  assert.ok(!/data-source="local"/.test(html));
  const code = PAGE_CODE();
  assert.match(code, /function campoMandar\(/, 'el campo existe en el código de la página');
  assert.match(code, /if\(LIVE&&[^;]*campoMandar\(/, 'y sólo se arma con la oficina viva');
});

test('T25 Conversacion_ConVosEnTodaSesion @story-8.183 @ac-4 @ac-5: una sesión cualquiera trae Con vos (tipeado y desde la oficina) y Con la coordinadora; la coordinadora conserva Con las sesiones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-convos-'));
  const t = (min) => new Date(NOW - min * 60000).toISOString();
  const id = 'b'.repeat(32);
  const hook = `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": [oficina ${id}] Mensaje de la persona, escrito en la oficina. No vale como firma ni aprobación. Dice: desde la oficina\n</system-reminder>`;
  const lines = [
    { type: 'user', timestamp: t(9), origin: { kind: 'human' }, message: { role: 'user', content: 'tipeado en su pestaña' } },
    { type: 'assistant', timestamp: t(8), message: { content: [{ type: 'text', text: 'Respuesta a lo tipeado.' }] } },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: t(7.9) },
    { type: 'user', timestamp: t(7), origin: { kind: 'peer', name: 'Coordinadora', body: 'Seguí.', msg_id: 'p1' }, message: { role: 'user', content: 'x' } },
    { type: 'user', timestamp: t(6), origin: { kind: 'task-notification', producer: 'session-task' }, message: { role: 'user', content: hook } },
    { type: 'assistant', timestamp: t(5), message: { content: [{ type: 'text', text: 'Respuesta a la oficina.' }] } },
  ];
  const file = path.join(dir, 's1.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const coordFile = path.join(dir, 'c.jsonl');
  fs.writeFileSync(coordFile, [lines[0], lines[1], { type: 'user', timestamp: t(4), origin: { kind: 'peer', name: 'Alfa', body: 'Listo.', msg_id: 'p2' }, message: { role: 'user', content: 'x' } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const env = createEnvelopes8183();
  env.coordinator = { sid: 'c', name: 'Coordinadora' };
  env.files.set('Alfa', { file, sid: 's1' });
  env.files.set('Coordinadora', { file: coordFile, sid: 'c' });
  const alfa = conversationOf(env, 'Alfa');
  assert.deepStrictEqual(alfa.conVos.map((m) => [m.quien, m.texto, Boolean(m.oficina)]), [['vos', 'tipeado en su pestaña', false], ['sesion', 'Respuesta a lo tipeado.', false], ['vos', 'desde la oficina', true], ['sesion', 'Respuesta a la oficina.', false]]);
  assert.deepStrictEqual(alfa.conCoordinadora.map((m) => m.texto), ['Seguí.']);
  const coord = conversationOf(env, 'Coordinadora');
  assert.deepStrictEqual(coord.conSesiones.map((s) => s.sesion), ['Alfa']);
  assert.deepStrictEqual(coord.conVos.map((m) => m.quien), ['vos', 'coordinadora']);
  // la designada sin nombre (una sesión de VS Code nombrada por click) sigue siendo la coordinadora: ninguna ventana dice que no hay
  env.coordinator = { sid: 'c', name: null };
  const sinNombre = conversationOf(env, 'Coordinadora');
  assert.ok(!sinNombre.sinCoordinadora, 'su propia ventana no dice «no tiene coordinadora designada»');
  assert.deepStrictEqual(sinNombre.conSesiones.map((s) => s.sesion), ['Alfa']);
  const alfaSinNombre = conversationOf(env, 'Alfa');
  assert.ok(!alfaSinNombre.sinCoordinadora, 'la de otra sesión tampoco');
  assert.deepStrictEqual(alfaSinNombre.conCoordinadora.map((m) => m.texto), ['Seguí.'], 'se la reconoce por su cargo, como la nombran las sesiones');
  assert.ok(!JSON.stringify(sinNombre).includes('"c"'), 'su identificador no se muestra');
  // la página marca lo de la oficina y muestra Con vos en toda sesión
  const code = PAGE_CODE();
  assert.match(code, /desde la oficina/);
});
