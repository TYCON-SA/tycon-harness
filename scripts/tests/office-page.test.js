'use strict';
// office-page.test.js — the page of the office: how it is built and drawn, the command, the desks and the link to the site. The shared toys live in lib/office-fixtures.js.
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
  OFFICE, PAGE_CODE, NOW, STEPS, run, BOARD, mixedOffice, wip, toyHome, collectWith, pageClock, buildOffice,
  page, importMap, MODULES, stateDir, openFile, deskSlots, drawKanban, buildTables
} = require('./lib/office-fixtures.js');

test('T24 Oficina_EstadoNuevo_EnLaLista @story-8.195 @ac-24 — «cerrar» está en AGENT_STATES y en la página, con su texto', () => {
  const { AGENT_STATES } = require(path.join(path.dirname(OFFICE), 'office', 'fields.js'));
  assert.ok(AGENT_STATES.includes('cerrar'));
  assert.match(PAGE_CODE(), /\bcerrar:\["Terminado, falta cerrar","#[0-9a-f]{6}"\]/);
});

test('T7 Pagina_SinNadaDeAfuera: la librería va adentro, sin importaciones relativas ni direcciones de internet', () => {
  const map = JSON.parse(importMap()).imports;
  assert.deepStrictEqual(Object.keys(map).sort(), Object.keys(MODULES).sort());
  for (const [key, url] of Object.entries(map)) {
    assert.match(url, /^data:text\/javascript;base64,/, key);
    const src = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
    assert.doesNotMatch(src, /(from|import)\s*['"]\.{1,2}\//, `${key} conserva una importación relativa`);
    for (const m of src.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) assert.ok(m[1] in map, `${key} importa ${m[1]}, que no está en el mapa`);
  }
  const html = page({ agents: [], items: [], meta: { teToca: [] }, rows: [], free: [], unreadable: [] });
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /@import|url\(\s*['"]?https?:/i);
  assert.doesNotMatch(html, /__OFFICE_(IMPORTMAP|DATA)__/);
});

test('T8 Pagina_DatosNoCierranElGuion: un «<» de los datos no puede cerrar la etiqueta del guion', () => {
  const html = page({ agents: [{ nombre: '</script><b>x', estado: 'libre' }], items: [], meta: { teToca: [] }, rows: [], free: [], unreadable: [] });
  assert.doesNotMatch(html, /<\/script><b>x/);
  assert.match(html, /\\u003c\/script>\\u003cb>x/);
});

test('T9 Comando: --json imprime los datos, sin --json escribe la página, y sin carpeta de estado sale 2', () => {
  const { home } = toyHome();
  const data = JSON.parse(run(home, ['--json', '--now', new Date(NOW).toISOString()]));
  assert.deepStrictEqual(data.agents.map((a) => [a.nombre, a.estado]), [['sesion-a', 'libre']]);
  const out = path.join(home, 'oficina.html');
  assert.match(run(home, ['--out', out, '--now', new Date(NOW).toISOString()]), /La oficina está en/);
  assert.match(fs.readFileSync(out, 'utf8'), /<title>Oficina del arnés<\/title>/);
  let code = 0;
  try { run(fs.mkdtempSync(path.join(os.tmpdir(), 'office-vacia-')), ['--json']); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
  code = 0;
  try { run(home, ['--out']); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2, '--out sin valor');
});

test('T35 SiteLink_FromProfile_OrNothing: el enlace al sitio sale del perfil, o no hay enlace', async () => {
  const { collect } = require(OFFICE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-site-'));
  for (const d of ['active', 'adhoc', 'doing']) fs.mkdirSync(path.join(stateDir(home), d), { recursive: true });
  const at = (code, out) => async () => ({ code, out });
  const ok = await collect({ home, now: new Date(NOW).toISOString(), siteUrl: at(0, 'https://sitio.example\n') });
  assert.strictEqual(ok.meta.sitio, 'https://sitio.example');
  const html = page(ok);
  assert.match(html, /target="_blank" rel="noopener"|rel="noopener"/);
  for (const [code, out, note] of [[3, '', null], [2, 'perfil roto', /sitio/], [0, 'javascript:alert(1)', null]]) {
    const d = await collect({ home, now: new Date(NOW).toISOString(), siteUrl: at(code, out) });
    assert.strictEqual(d.meta.sitio, undefined, `${code} ${out}`);
    if (note) assert.ok(d.unreadable.some((u) => note.test(u)), d.unreadable.join(' | '));
  }
});

test('T36 OpenFile_Windows_NoShell: en Windows abre con rundll32, sin cmd ni shell', () => {
  const target = 'C:\\Temp\\a&b|c^d "e"\\oficina.html';
  const calls = [];
  const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  openFile(target, { platform: 'win32', spawn: fake });
  assert.strictEqual(calls[0].cmd, 'rundll32');
  assert.deepStrictEqual(calls[0].args, ['url.dll,FileProtocolHandler', target]);
  assert.ok(!calls[0].args.includes('/c') && calls[0].cmd !== 'cmd');
  assert.ok(!calls[0].opts.shell, 'sin shell');
  openFile(target, { platform: 'darwin', spawn: fake });
  openFile(target, { platform: 'linux', spawn: fake });
  assert.deepStrictEqual(calls.slice(1).map((c) => [c.cmd, c.args]), [['open', [target]], ['xdg-open', [target]]]);
  let said = '';
  const failing = () => ({ on(ev, fn) { if (ev === 'error') fn(new Error('ENOENT')); }, unref() {} });
  const write = process.stderr.write;
  process.stderr.write = (s) => { said += s; return true; };
  try { openFile(target, { platform: 'win32', spawn: failing }); } finally { process.stderr.write = write; }
  assert.match(said, /abrila a mano: .*oficina\.html/);
});

test('T52 Desks_UpToTen_NotCappedByCoordination: hasta 10 escritorios según cuántas sesiones haya', () => {
  for (const [n, desks, extra] of [[6, 6, 0], [10, 10, 0], [12, 10, 2]]) {
    const entries = Array.from({ length: n }, (_, i) => ({ session: `s${String(i).padStart(2, '0')}`, extra: { kind: 'loose', text: `arreglo ${i}` } }));
    const { data } = buildOffice({ wip: wip(entries), nowMs: NOW });
    assert.strictEqual(data.meta.puestos.length, desks, `${n} sesiones`);
    assert.strictEqual(data.meta.extra, extra);
  }
  // hasta cinco, los cinco lugares de siempre; con seis o más, la grilla de diez; nunca más de diez
  const five = deskSlots(5);
  assert.deepStrictEqual(deskSlots(3), five.slice(0, 3));
  assert.deepStrictEqual(five[0], [5.6, 1.45, 0], 'el primero de los cinco de siempre');
  const ten = deskSlots(10);
  assert.strictEqual(ten.length, 10);
  assert.strictEqual(new Set(ten.map((s) => `${s[0]},${s[1]}`)).size, 10, 'diez lugares distintos');
  assert.ok(!ten.some((s) => five.some((f) => f[0] === s[0] && f[1] === s[1])), 'la grilla no reusa los cinco');
  assert.deepStrictEqual(deskSlots(6), ten.slice(0, 6));
  assert.strictEqual(deskSlots(12).length, 10, 'tope de diez');
  const html = page(buildOffice({ wip: wip([{ session: 'a' }]), nowMs: NOW }).data);
  assert.doesNotMatch(html, /max_working/, 'el tope de la coordinadora no cuenta');
  assert.match(html, /m\.puestos/, 'la página dibuja los puestos que le llegan');
  assert.doesNotMatch(html, /SLOTS/, 'sin los cinco lugares fijos');
});

test('T66 Page_DrawFails_Said: si una foto nueva no se puede dibujar, la página lo dice', () => {
  const handler = (PAGE_CODE().match(/ws\.onmessage=([^\n]*);\n/) || [])[1];
  assert.ok(handler, 'la página viva tiene su manejador');
  // se corre el manejador de verdad: una foto que no se puede dibujar avisa; la siguiente que se dibuja saca el aviso
  const ovl = { textContent: '', hidden: true };
  let breakIt = true;
  const errors = [];
  const run = new Function('document', 'window', 'setData', 'renderTop', 'renderCrew', 'console', 'relojTick', 'agents', 'meta', 'BORRADO', `return (${handler});`);
  const onmessage = run({ getElementById: (id) => (id === 'ovl' ? ovl : null) }, { tablero: {} },
    () => { if (breakIt) throw new Error('dibujo roto'); }, () => {}, () => {}, { error: (e) => errors.push(e) }, () => {}, [], null);
  onmessage({ data: JSON.stringify({ type: 'foto', data: {} }) });
  assert.strictEqual(ovl.hidden, false);
  assert.match(ovl.textContent, /No pude dibujar la última novedad/);
  assert.strictEqual(errors.length, 1, 'el error queda en la consola');
  breakIt = false;
  onmessage({ data: JSON.stringify({ type: 'foto', data: {} }) });
  assert.strictEqual(ovl.hidden, true, 'una foto buena saca el aviso');
});

test('T58 Page_PlaceholderInData_DoesNotBreak: un título con el nombre de un marcador de la plantilla no rompe la página', () => {
  const data = { agents: [{ nombre: 's1', titulo: 'documentar __OFFICE_LIVE__ y __OFFICE_DATA__' }], items: [], meta: { actualizado: '10:00' }, rows: [], free: [], unreadable: [] };
  // la foto fija lleva sus datos adentro; la del proceso local, sólo su token
  const fixed = page(data);
  const block = fixed.match(/<script type="application\/json" id="officeData">(.*)<\/script>/);
  assert.ok(block, 'la foto fija lleva el bloque de datos');
  assert.strictEqual(JSON.parse(block[1]).agents[0].titulo, 'documentar __OFFICE_LIVE__ y __OFFICE_DATA__');
  assert.doesNotMatch(fixed, /__OFFICE_(ATTRS|BAR|IMPORTMAP|CODE|DATA_BLOCK)__/);
  const live = page(data, { live: { token: 'abc' } });
  assert.match(live, /data-source="local"/);
  assert.match(live, /data-token="abc"/);
  assert.doesNotMatch(live, /documentar|id="officeData"/, 'los datos llegan por la conexión');
  assert.doesNotMatch(live, /__OFFICE_(ATTRS|BAR|IMPORTMAP|CODE|DATA_BLOCK)__/);
});

test('T72 SiteLink_OnlyFromPage_OnlyWeb: el enlace al sitio sale de la página armada, sólo si es web, nunca del WebSocket', () => {
  const html = page({ agents: [], items: [], meta: { actualizado: '10:00', sitio: 'https://sitio.example/x' }, rows: [], free: [], unreadable: [] }, { live: { token: 'abc' } });
  assert.match(html, /data-site="https:\/\/sitio\.example\/x"/, 'el enlace lo arma office.js');
  const code = PAGE_CODE();
  const line = (code.match(/^const SITE=(.*);$/m) || [])[1];
  assert.ok(line, 'la página calcula el enlace una vez');
  const site = (sitio) => new Function('RAIZ', `return ${line};`)({ dataset: { site: sitio } });
  assert.strictEqual(site('https://sitio.example/x'), 'https://sitio.example/x');
  for (const bad of ['javascript:alert(1)', 'data:text/html,hola', 'vbscript:x', '', undefined, 'no es una dirección']) assert.strictEqual(site(bad), null, String(bad));
  // nada de la página toma el sitio de los datos que llegan después
  assert.doesNotMatch(code, /meta\.sitio/, 'la página no mira meta.sitio');
});

test('T73 Office_FirstThenBoard: la sala 3D es lo primero que se ve; el tablero va abajo, después de las sesiones', async () => {
  const data = await collectWith(JSON.stringify(BOARD));
  const html = page(data);
  const body = html.slice(html.indexOf('<body>'));
  const at = (re) => body.search(re);
  assert.ok(at(/id="office"/) > 0 && at(/id="board"/) > 0, 'están las dos');
  assert.ok(at(/id="office"/) < at(/id="board"/), 'la sala va antes que el tablero');
  assert.ok(at(/id="office"/) < at(/id="crew"/), 'la sala va antes que las tarjetas de las sesiones');
  // en un monitor ancho la página usa el ancho: no queda en una columna angosta en el medio
  const width = Number((html.match(/main\{max-width:(\d+)px/) || [])[1]);
  assert.ok(width >= 1500, `ancho máximo ${width}`);
});

test('T43 Page_QuietClock_ConfigurableThreshold @story-2.81 @ac-39 — el reloj de la página marca las calladas con el umbral, sin pedir nada', async () => {
  const html = PAGE_CODE();
  assert.match(html, /setInterval\(\s*\(\)\s*=>\s*\{[^}]*relojTick/, 'el reloj corre cada minuto en la página');
  const { relojTick, umbral, calls } = pageClock(html);
  const people = () => [
    { nombre: 'A', estado: 'trabajando', haciendo: 'x', novedadMs: NOW - 16 * 60000, sinPid: false },
    { nombre: 'B', estado: 'trabajando', haciendo: 'y', novedadMs: NOW - 5 * 60000, sinPid: false },
    { nombre: 'C', estado: 'trabajando', haciendo: 'z', novedadMs: NOW - (2 * 3600000 + 60000), sinPid: true },
  ];
  let list = people();
  relojTick(list, NOW, { quietMin: undefined });
  assert.match(list[0].callada, /^sin novedades desde las \d\d:\d\d$/);
  assert.ok(!list[1].callada);
  assert.strictEqual(list[2].estado, 'inactiva', 'sin pid y más de 2 h: inactiva, sin foto nueva');
  assert.match(list[2].haciendo, /sin novedades desde las \d\d:\d\d/);
  list = people();
  relojTick(list, NOW, { quietMin: 30 });
  assert.ok(!list[0].callada && !list[1].callada, 'con 30, ninguna');
  for (const bad of ['abc', 0, -5, null]) assert.strictEqual(umbral({ quietMin: bad }), 15, String(bad));
  assert.strictEqual(calls.net, 0, 'el reloj no hace ningún pedido de red');
  // collect pasa el umbral del perfil del equipo, y uno roto cae al de por defecto
  const { collect } = require(OFFICE);
  const { home } = toyHome();
  const at = new Date(NOW).toISOString();
  const quiet = async (code, out) => (await collect({ home, now: at, siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code, out }) })).meta.quietMin;
  assert.strictEqual(await quiet(3, ''), 15, 'sin configurar');
  assert.strictEqual(await quiet(0, '30\n'), 30);
  assert.strictEqual(await quiet(0, 'abc'), 15, 'roto: el de por defecto');
  assert.strictEqual(await quiet(0, '0'), 15);
});

test('T113 Desks_WorkersFirst_StablePlaces @story-2.81 @ac-63: con más de 10 sesiones, los escritorios son para las que trabajan', () => {
  const work = { kind: 'pipeline', current: 'implement', steps: STEPS };
  const entries = (over = {}) => [
    { session: 'Zoe', sid: 'co', status: 'idle', extra: work },
    ...['Omar', 'Pia', 'Quim', 'Rosa'].map((session) => ({ session, status: over[session] || 'busy', extra: work })),
    ...['Vero', 'Walter'].map((session) => ({ session, status: 'waiting', extra: work })),
    ...['Tita', 'Ulises'].map((session) => ({ session, status: 'idle', extra: work })),
  ];
  const free = ['Ada', 'Bruno', 'Celia', 'Dani'];
  const build = (over) => buildOffice({ wip: wip(entries(over), { free }), coordinatorSid: 'co', nowMs: NOW }).data;
  const data = build();
  assert.deepStrictEqual(data.agents.slice(0, 10).map((a) => a.nombre), ['Zoe', 'Ada', 'Omar', 'Pia', 'Quim', 'Rosa', 'Tita', 'Ulises', 'Vero', 'Walter']);
  assert.deepStrictEqual(data.agents.slice(10).map((a) => a.nombre), ['Bruno', 'Celia', 'Dani']);
  assert.strictEqual(data.meta.extra, 3);
  assert.strictEqual(data.meta.puestos.length, 10);
  // una que pasa de ocupada a parada no mueve a nadie
  assert.deepStrictEqual(build({ Pia: 'idle' }).agents.map((a) => a.nombre), data.agents.map((a) => a.nombre));
  // con 10 o menos, el orden de hoy
  const few = buildOffice({ wip: wip(entries().slice(0, 9), { free: ['Ada'] }), coordinatorSid: 'co', nowMs: NOW }).data;
  assert.deepStrictEqual(few.agents.map((a) => a.nombre), ['Zoe', 'Ada', 'Omar', 'Pia', 'Quim', 'Rosa', 'Tita', 'Ulises', 'Vero', 'Walter']);
});

test('T212 Card_And_Panel_OneFicha: la tarjeta y el panel pintan la misma ficha, sin perder ningún dato', () => {
  const { data } = buildOffice({ wip: wip([]), nowMs: NOW });
  const html = page(data);
  assert.strictEqual((html.match(/function ficha\(a,abiertos\)/g) || []).length, 1, 'un solo lugar');
  const crew = html.slice(html.indexOf('function renderCrew()'), html.indexOf('function ficha(a,abiertos)'));
  assert.match(crew, /pintarFicha\(a,k,false\)/);
  const abrir = html.slice(html.indexOf('function abrir(nombre'), html.indexOf('const ray=new THREE.Raycaster()'));
  assert.match(abrir, /T\.pintarFicha\(a,panel,true\)/);
  assert.doesNotMatch(abrir, /row\("Trabajo"/);
  const ficha = html.slice(html.indexOf('function ficha(a,abiertos)'), html.indexOf('// sin 3D, la tabla queda abierta'));
  for (const k of ['Trabajo', 'De la historia', 'Historia', 'Encargo', 'Haciendo ahora', 'Haciendo', 'Última acción', 'Espera', 'Parada', 'Mientras tanto', 'En pausa', 'Termina', 'Por qué', 'Prometido', 'Avance', 'Carpeta', 'Pasos de la ejecución']) assert.ok(ficha.includes(`"${k}"`), k);
  assert.doesNotMatch(html, /Pasos de la corrida/);
});

test('T219 Room_Rhythm_NeverStops: la sala se dibuja con ritmo, y un error en un cuadro no la deja quieta', () => {
  const { data } = buildOffice({ wip: wip([]), nowMs: NOW });
  const html = page(data);
  assert.match(html, /const ritmo=\(\)=>reduce\?0:performance\.now\(\)<hastaTocando\?FPS_TOCANDO:T\.chica\?FPS_QUIETA:desks\.some\(/);
  assert.match(html, /FPS_TOCANDO=30,FPS_MOVIMIENTO=15,FPS_QUIETA=4/);
  assert.match(html, /function loop\(\)\{if\(apagada\|\|!enVista\|\|document\.hidden\)\{timer=null;return\}try\{dibujar\(\)\}finally\{programar\(\)\}\}/);
  assert.match(html, /setPixelRatio\(Math\.min\(devicePixelRatio,1\.25\)\)/);
  assert.match(html, /new IntersectionObserver\(/);
});

test('T310 Room_Rhythm_CameraChangeIsRealOnly: la cámara quieta no cuenta como toque, y una que se mueve o acerca sí', () => {
  // 🔴 rojo: el control de la cámara ortogonal avisa «change» en cada cuadro, cada aviso contaba como toque y la sala
  // dibujaba siempre a 30 cuadros por segundo
  const src = PAGE_CODE();
  const decl = (src.match(/const camVista=\{[^\n]*\};/) || [])[0];
  const fn = (src.match(/function camaraCambio\(\)\{[^\n]*\}return c\}/) || [])[0];
  assert.ok(decl && fn, 'la página trae camaraCambio');
  assert.match(src, /controls\.addEventListener\("change",\(\)=>\{if\(!camaraCambio\(\)\)return;tagsAlDia=false;tocar\(\)\}\);/);
  class V {
    constructor(...n) { this.n = n; }
    clone() { return new V(...this.n); }
    copy(o) { this.n = [...o.n]; return this; }
    distanceToSquared(o) { return this.n.reduce((s, x, i) => s + (x - o.n[i]) ** 2, 0); }
    dot(o) { return this.n.reduce((s, x, i) => s + x * o.n[i], 0); }
  }
  const cam = { position: new V(35, 26.9, 35), quaternion: new V(0, 0, 0, 1), zoom: 1 };
  const cambio = new Function('cam', `${decl}\n${fn}\nreturn camaraCambio;`)(cam);
  assert.strictEqual(cambio(), false, 'sin moverse, no hay cambio');
  assert.strictEqual(cambio(), false, 'ni en el cuadro siguiente');
  cam.position.n[0] += 0.5;
  assert.strictEqual(cambio(), true, 'la cámara que gira es un cambio');
  assert.strictEqual(cambio(), false, 'y queda como la nueva vista');
  cam.position.n[0] += 0.0001;
  assert.strictEqual(cambio(), false, 'un resto de la amortiguación por debajo del umbral del control no cuenta');
  cam.zoom = 1.25;
  assert.strictEqual(cambio(), true, 'acercar es un cambio');
  const a = Math.sin(0.1); cam.quaternion.n = [0, a, 0, Math.cos(0.1)];
  assert.strictEqual(cambio(), true, 'girar sin moverse también');
});

test('T224 Panel_CoversWhatIsBehind: el panel tapa lo que tiene atrás y va arriba de las etiquetas', () => {
  const css = (page(mixedOffice()).match(/\.panel3\{[^}]*\}/) || [])[0];
  assert.match(css, /background:#[0-9a-f]{6}/i, 'un fondo sin transparencia');
  assert.doesNotMatch(css, /background:rgba/);
});

test('T250 WaysOfWorking_Icon: cada caso tiene su forma, y al ícono no entra el texto de la foto', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  const src = html.slice(html.indexOf('const COMO_ICONO='), html.indexOf('function pintarFicha('));
  const fake = (tag) => ({ tag, attrs: {}, kids: [], textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, appendChild(n) { this.kids.push(n); } });
  const doc = { createElement: fake, createElementNS: (_, tag) => fake(tag) };
  const icono = new Function('document', `${src}; return iconoComo;`)(doc);
  const shape = (t) => { const s = icono(t); return s.textContent || JSON.stringify(s.kids.map((k) => [k.attrs, k.kids.map((p) => [p.tag, p.attrs])])); };
  const forms = ['Camino corto', 'Historia 8.181', 'Otra cosa', 'Coordinando'].map(shape);
  assert.strictEqual(new Set(forms).size, 4, 'una forma por caso');
  assert.strictEqual(shape('Coordinando'), '→', 'la coordinadora conserva la flecha de su estado');
  assert.strictEqual(shape('Historia'), shape('Historia 8.181'));
  assert.strictEqual(shape('<img src=x onerror=alert(1)>'), shape('Otra cosa'), 'lo desconocido es otra cosa, y su texto no entra');
  assert.doesNotMatch(forms.join(''), /fill="(?!none)|stroke="#/, 'el ícono no depende de un color: usa el del texto');
  assert.match(html, /T\.iconoComo\(a\.comoTrabaja\)/, 'la etiqueta del dibujo lo lleva');
  assert.match(html, /chips\.appendChild\(etiquetaComo\(a\.comoTrabaja,a\.tarea\)\)/, 'la tarjeta lo lleva como etiqueta, junto al estado');
  assert.match(html, /T\.etiquetaComo\(a\.comoTrabaja\)/, 'el detalle también');
  assert.doesNotMatch(html, /add\("Cómo trabaja"/, 'ya no es un renglón');
});

test('T284 Labels_Switch: siempre por defecto, y la elección se recuerda; si no puede recordarla, vuelve a «Siempre»', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /<input type="radio" name="etiquetas" value="siempre" checked>/, 'como hoy, por defecto');
  assert.match(html, /value="mouse"><span>Al pasar el mouse<\/span>/);
  assert.ok(html.indexOf('name="etiquetas"') < html.indexOf('id="stage"'), 'arriba del dibujo');
  const src = html.slice(html.indexOf('const ETIQUETAS_KEY='), html.indexOf('function modoEtiquetas('));
  const run = (storage) => new Function('localStorage', `${src}; return { etiquetasGuardadas, guardarEtiquetas };`)(storage);
  const kept = new Map();
  const ok = run({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) });
  assert.strictEqual(ok.etiquetasGuardadas(), 'siempre');
  ok.guardarEtiquetas('mouse');
  assert.strictEqual(ok.etiquetasGuardadas(), 'mouse');
  kept.set('office.etiquetas', '<raro>');
  assert.strictEqual(ok.etiquetasGuardadas(), 'siempre');
  const broken = run({ getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } });
  assert.strictEqual(broken.etiquetasGuardadas(), 'siempre');
  assert.doesNotThrow(() => broken.guardarEtiquetas('mouse'));
  assert.match(html, /\.stage\.solo-mouse \.tag\{opacity:0;pointer-events:none\}/, 'ocultas, pero el teclado llega');
  assert.match(html, /\.stage\.solo-mouse \.tag\.ver,\.stage\.solo-mouse \.tag\.sel,\.stage\.solo-mouse \.tag:focus-visible\{opacity:1/);
  assert.match(html, /e\.pointerType==="touch"&&!\(h&&\(h\.object===pnlFace\|\|h\.object===signFace\|\|h\.object===lampHit\)\)\)\{verEtiqueta/, 'al tocar, muestra la etiqueta y no abre el detalle');
  assert.doesNotMatch(html, /solo-mouse[^}]*\.sobre/, 'el avioncito no se oculta');
});

test('T295 Lamp_TogglesAndRemembers: un click la prende y la apaga con su luz, se recuerda por navegador y no le avisa a nadie', () => {
  const html = PAGE_CODE();
  const from = html.indexOf('const LAMPARA_KEY=');
  const block = html.slice(from, html.indexOf('prenderLampara(lamparaGuardada());', from));
  const load = (localStorage) => {
    const lampShade = { material: { emissiveIntensity: 9 } };
    const lampLight = { intensity: 9 };
    // eslint-disable-next-line no-new-func
    const api = new Function('localStorage', 'lampShade', 'lampLight', `${block};return{lamparaGuardada,prenderLampara,tocarLampara}`)(localStorage, lampShade, lampLight);
    api.prenderLampara(api.lamparaGuardada());
    return { ...api, lampShade, lampLight };
  };
  const store = new Map();
  const memory = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const lit = (l) => [l.lampShade.material.emissiveIntensity, l.lampLight.intensity];
  const first = load(memory);
  assert.deepStrictEqual(lit(first), [0.75, 11], 'de entrada, prendida');
  first.tocarLampara();
  assert.deepStrictEqual(lit(first), [0, 0], 'apagada, sin su luz');
  assert.deepStrictEqual(lit(load(memory)), [0, 0], 'el navegador la recuerda apagada');
  first.tocarLampara();
  assert.deepStrictEqual(lit(first), [0.75, 11]);
  assert.deepStrictEqual(lit(load(memory)), [0.75, 11]);
  const blocked = { getItem() { throw new Error('sin permiso'); }, setItem() { throw new Error('sin permiso'); } };
  const noStore = load(blocked);
  assert.deepStrictEqual(lit(noStore), [0.75, 11], 'sin dónde guardar, prendida');
  noStore.tocarLampara();
  assert.deepStrictEqual(lit(noStore), [0, 0], 'y el click anda igual');
  assert.match(html, /intersectObjects\(\[pnlFace,lampHit,/, 'se puede apuntar, y el cursor cambia con lo apuntado');
  assert.match(html, /if\(h\.object===lampHit\)\{tocarLampara\(\);return\}/, 'el click llega');
  assert.ok(!/fetch|sendBeacon|XMLHttpRequest/.test(block), 'no le avisa a nadie: las sesiones no se enteran');
});

test('T281 Summary_OneLine: dice cuánto te toca y cuánto está trabado, destaca lo tuyo, y sin nada no hay qué abrir', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  const src = html.slice(html.indexOf('const RESUMEN_KEY='), html.indexOf('function pintarResumen('));
  const run = (storage) => new Function('localStorage', `${src}; return { lineaResumen, resumenGuardado, guardarResumen };`)(storage);
  const { lineaResumen } = run({ getItem: () => null, setItem() {} });
  assert.deepStrictEqual(lineaResumen(4, 4), { texto: 'Te toca: 4 · Trabado: 4', pide: true, vacio: false });
  assert.deepStrictEqual(lineaResumen(0, 2), { texto: 'Te toca: 0 · Trabado: 2', pide: false, vacio: false });
  assert.deepStrictEqual(lineaResumen(1, 0), { texto: 'Te toca: 1 · Trabado: 0', pide: true, vacio: false });
  assert.deepStrictEqual(lineaResumen(0, 0), { texto: 'Nada por ahora', pide: false, vacio: true });
  // se recuerda en ese navegador, y si no puede, no pasa nada
  const kept = new Map();
  const memory = run({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) });
  assert.strictEqual(memory.resumenGuardado(), false, 'arranca cerrada');
  memory.guardarResumen(true);
  assert.strictEqual(memory.resumenGuardado(), true);
  memory.guardarResumen(false);
  assert.strictEqual(memory.resumenGuardado(), false);
  const broken = run({ getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } });
  assert.strictEqual(broken.resumenGuardado(), false);
  assert.doesNotThrow(() => broken.guardarResumen(true));
  assert.match(html, /pintarResumen\(you\.length,stuck\.reduce/, 'cada foto la vuelve a pintar');
});

test('T280 Titles_OneLine: en las tarjetas y el kanban, el título va en una línea; el detalle lo dice entero', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /\.una-linea\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.match(html, /r\.k==="Trabajo"&&!abiertos\)\{dd\.className="una-linea";dd\.title=r\.v\}/, 'sólo en la tarjeta, con el texto entero al pasar el mouse');
  assert.match(html, /tit=el\("b","una-linea",i\.titulo\|\|""\)/);
  assert.match(html, /T\.pintarFicha\(a,panel,true\)/, 'el detalle pinta abierto');
});

test('T312 Story_NumberAndTitle: el panel dice en un renglón fijo «Historia: número — título»; la tarjeta, sólo la historia', () => {
  const { data } = buildOffice({ wip: wip([]), nowMs: NOW });
  const html = page(data);
  const fn = (name) => html.slice(html.indexOf(`function ${name}(`), html.indexOf('\n', html.indexOf(`function ${name}(`)));
  const historiaDe = new Function(`${fn('historiaDe')}; return historiaDe;`)();
  assert.strictEqual(historiaDe({ comoTrabaja: 'Historia 8.215', historiaTitulo: 'El pase', titulo: 'Una tanda' }), '8.215 — El pase');
  assert.strictEqual(historiaDe({ comoTrabaja: 'Historia 8.215', historia: 'De una foto vieja' }), '8.215 — De una foto vieja', 'una máquina con el arnés viejo');
  assert.strictEqual(historiaDe({ comoTrabaja: 'Historia 8.215' }), '8.215', 'sin título, el número solo');
  for (const como of ['Historia', 'Camino corto', 'Otra cosa', undefined]) assert.strictEqual(historiaDe({ comoTrabaja: como, historia: 'x' }), '', String(como));
  // la etiqueta de la tarjeta no lleva el título: recortado no se lee
  const etiqueta = new Function('el', 'iconoComo', `${fn('etiquetaComo')}; return etiquetaComo;`)((t, c, x) => ({ t: x, kids: [], appendChild(k) { this.kids.push(k); } }), () => ({}));
  assert.strictEqual(etiqueta('Historia 8.218', 'T-12').kids[1].t, 'Historia 8.218 · T-12');
  assert.strictEqual(etiqueta('Historia 8.218', undefined).kids[1].t, 'Historia 8.218', 'sin número, sólo la historia');
  assert.match(html, /\.como-chip>\.txt\{[^}]*text-overflow:ellipsis/);
  // el renglón fijo va sólo abierto (el panel y la ventana), junto al trabajo
  const ficha = html.slice(html.indexOf('function ficha(a,abiertos)'), html.indexOf('add("Encargo"'));
  assert.match(ficha, /add\("Trabajo",a\.titulo\);if\(!hist\)add\("De la historia",a\.historia\);else if\(abiertos\)add\("Historia",hist\)/);
  assert.match(html, /ficha\(a,abiertos\)\.forEach/);
});

test('T313 Card_OpensWindow: tocar la tarjeta de una persona abre su ventana, igual en la oficina local y en el sitio', () => {
  const { data } = buildOffice({ wip: wip([]), nowMs: NOW });
  const html = page(data);
  const fnAt = (name) => { const at = html.indexOf(`function ${name}(`); return html.slice(at, html.indexOf('\nfunction ', at + 1)); };
  assert.match(fnAt('renderCrew'), /pintarTarjetas\(crew,agents,abrirSesion\)/, 'la local');
  const oficina = fnAt('pintarOficina');
  assert.match(oficina, /pintarTarjetas\(f\.crew,lista,\(a,k\)=>\{.*?DATA=o\.foto\|\|\{\};try\{abrirSesion\(a,k\)\}finally/, 'el sitio, con la foto de esa oficina');
  assert.doesNotMatch(oficina, /T\.abrir\(/, 'el sitio ya no abre el panel de la sala');
  const abrir = fnAt('abrirSesion');
  assert.match(abrir, /fichaEnVentana\(a,box\)/, 'el mismo contenido que la ventana del tablero');
  assert.match(fnAt('abrirTarjeta'), /if\(a\)fichaEnVentana\(a,box\)/);
  assert.match(fnAt('fichaEnVentana'), /pintarFicha\(a,box,true\)/);
  // el toque de verdad: el click y Enter abren con la sesión y su tarjeta; un botón de adentro no abre
  const node = () => { const n = { kids: [], style: { setProperty() {} }, classList: { add() {} }, attrs: {}, appendChild(k) { this.kids.push(k); return k; }, append(...k) { this.kids.push(...k); }, setAttribute(k, v) { this.attrs[k] = v; }, replaceChildren(...k) { this.kids = k; } }; return n; };
  const pintar = new Function('el', 'AST', 'SHIRT', 'etiquetaComo', 'pintarFicha', 'document', `${fnAt('pintarTarjetas')}\n; return pintarTarjetas;`)(
    () => node(), {}, ['#000'], () => node(), () => {}, { createTextNode: (t) => ({ t }) });
  const c = node(), abiertas = [], ana = { nombre: 'Ana', estado: 'trabajando' };
  pintar(c, [ana], (a, k) => abiertas.push([a, k]));
  const k = c.kids[0];
  k.onclick({ target: { closest: () => null } });
  k.onkeydown({ target: k, key: 'Enter', preventDefault() {} });
  k.onclick({ target: { closest: () => ({}) } });
  assert.deepStrictEqual(abiertas, [[ana, k], [ana, k]], 'el click y Enter abren; el botón de adentro no');
  assert.strictEqual(k.attrs.role, 'button');
  // y la ventana se abre con su nombre y la misma ficha que la del tablero
  const box = node(), v = { hidden: true, firstElementChild: box }, fichas = [];
  const abrirSesion = new Function('ventana', 'el', 'botonCerrar', 'cerrarCharla', 'fichaEnVentana', 'document', 'charlaDe', 'ultimoPedido', 'charlaVuelve', `${abrir}\n; return abrirSesion;`)(
    () => v, (tag, cls, t) => ({ tag, t }), () => ({ focus() {} }), null, (a, b) => fichas.push([a, b]), { documentElement: { classList: { add() {} } } }, null, 0, null);
  box.classList = { add() {} };
  abrirSesion(ana, k);
  assert.strictEqual(v.hidden, false, 'la ventana se abre');
  assert.deepStrictEqual(box.kids[0], { tag: 'h3', t: 'Ana' });
  assert.deepStrictEqual(fichas, [[ana, box]]);
});

// ---------- 8.251: las historias de tus proyectos, plegadas en una línea de «Sin sesión» ----------

const OFFICE_8251 = require(OFFICE);
const FIELDS_8251 = require(path.join(path.dirname(OFFICE), 'office', 'fields.js'));
const nodes8251 = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => nodes8251(c, out)); return out; };
const text8251 = (n) => (n.textContent || '') + (n.children || []).map(text8251).join('');
/** La lectura de fondo de la 8.185, ya hecha, con un proyecto y sus historias: `[id, prioridad]`. */
const reading8251 = (stories) => ({
  at: new Date(NOW - 10 * 60e3).toISOString(),
  proyectos: [{ nombre: 'Acme', traidoAt: new Date(NOW - 3 * 3600e3).toISOString(), deTuCopia: false, sinLeer: 0,
    historias: stories.map(([id, prioridad = null]) => ({ id, archivo: `story-${id}-x.md`, titulo: `La historia ${id}`, estado: 'ready-for-dev', prioridad, trabajo: null })) }],
  sinHistorias: [], commitsPropios: { medido: true },
});
/** La foto de la oficina: dos filas del tablero sin sesión y lo que traiga la lectura (`projectStories`). */
const office8251 = (projectStories, extraRow = null) => buildOffice({
  wip: wip([]), nowMs: NOW,
  board: OFFICE_8251.buildBoard({ pendientes: [
    { id: 'T-1', titulo: 'Fila uno', estado: 'espera', grupo: 'Hoy', orden: 1 },
    { id: 'T-2', titulo: 'Fila dos', estado: 'espera', grupo: 'Hoy', orden: 2 },
    ...(extraRow ? [extraRow] : []),
  ] }),
  ...(projectStories !== undefined ? { projectStories } : {}),
}).data;
const THREE_8251 = [['9.3', 'P2'], ['9.1'], ['9.2', 'P0']];
/** La columna «Sin sesión» dibujada, con su línea plegada y su lista (si las hay). */
function column8251(body) {
  const col = nodes8251(body).find((n) => n.className === 'col' && n.children.some((h) => h.tag === 'h3' && /^Sin sesión · /.test(h.textContent)));
  assert.ok(col, 'la columna «Sin sesión» se dibuja');
  const fold = col.children.find((n) => n.tag === 'button' && n.className === 'plegadas');
  const list = col.children.find((n) => n.className === 'plegadas-lista');
  return { col, fold, list };
}
const titleOf8251 = (card) => text8251(card.children.find((x) => x.tag === 'b'));

test('T1 Kanban_StoriesFolded_OneLine @story-8.251 @ac-1 — las filas como tarjetas; las tres historias en una línea cerrada, después', () => {
  const { body } = drawKanban(office8251({ snap: reading8251(THREE_8251), runs: [] }));
  const { col, fold, list } = column8251(body);
  const cards = col.children.filter((n) => /\bitem\b/.test(n.className));
  assert.deepStrictEqual(cards.map(titleOf8251), ['Fila uno', 'Fila dos'], 'las demás tarjetas, como hoy');
  assert.ok(fold, 'hay una línea plegada');
  assert.strictEqual(fold.textContent, 'Historias de tus proyectos · 3');
  assert.strictEqual(fold.attrs['aria-expanded'], 'false', 'cerrada al principio');
  assert.strictEqual(list.hidden, true, 'su lista no se ve');
  assert.ok(col.children.indexOf(fold) > col.children.indexOf(cards[cards.length - 1]), 'va después de las demás tarjetas');
  assert.strictEqual(col.children.indexOf(list), col.children.indexOf(fold) + 1, 'la lista va debajo de la línea');
});

test('T2 Kanban_FoldOpens_InOrder @story-8.251 @ac-2 — se toca y se ven las tres en el orden de la 8.185; otra vez y se cierra', () => {
  const { body } = drawKanban(office8251({ snap: reading8251(THREE_8251), runs: [] }));
  const { fold, list } = column8251(body);
  fold.onclick();
  assert.strictEqual(list.hidden, false, 'se abre');
  assert.strictEqual(fold.attrs['aria-expanded'], 'true', 'la línea dice que está abierta');
  assert.strictEqual(fold.type, 'button', 'es un botón: Enter y Espacio la abren igual');
  assert.deepStrictEqual(list.children.map(titleOf8251), ['9.2 · La historia 9.2', '9.3 · La historia 9.3', '9.1 · La historia 9.1'], 'P0, P2, sin prioridad');
  fold.onclick();
  assert.strictEqual(list.hidden, true, 'se cierra');
  assert.strictEqual(fold.attrs['aria-expanded'], 'false');
});

test('T3 Kanban_FoldStaysOpen_NewPhoto @story-8.251 @ac-3 — abierta, una foto nueva no la cierra', () => {
  const { body, redraw } = drawKanban(office8251({ snap: reading8251(THREE_8251), runs: [] }));
  column8251(body).fold.onclick();
  redraw(office8251({ snap: reading8251([...THREE_8251, ['9.4']]), runs: [] }, { id: 'T-3', titulo: 'Fila tres', estado: 'espera', grupo: 'Hoy', orden: 3 }));
  const { fold, list } = column8251(body);
  assert.strictEqual(fold.textContent, 'Historias de tus proyectos · 4', 'es la foto nueva');
  assert.strictEqual(list.hidden, false, 'sigue abierta');
  assert.strictEqual(fold.attrs['aria-expanded'], 'true');
});

test('T4 Kanban_NoStories_NoFold @story-8.251 @ac-4 — sin tarjetas de historia no hay línea, y el aviso de la lectura se ve', () => {
  const nota = 'No pude leer los pendientes de tus proyectos';
  for (const [name, projectStories] of [['sin lectura', { snap: null, nota, runs: [] }], ['sin historias', { snap: reading8251([]), runs: [] }], ['sin la parte de la lectura', undefined]]) {
    const { body } = drawKanban(office8251(projectStories));
    const { col, fold, list } = column8251(body);
    assert.strictEqual(fold, undefined, `${name}: no hay línea plegada`);
    assert.strictEqual(list, undefined, `${name}: ni su lista`);
    if (name === 'sin lectura') assert.ok(col.children.some((n) => n.textContent === nota), 'el aviso se ve como hoy');
  }
});

test('T5 Kanban_CountsUnchanged @story-8.251 @ac-5 — el encabezado y «En el kanban, de a uno» cuentan la columna entera; las historias no viajan', () => {
  const data = office8251({ snap: reading8251(THREE_8251), runs: [] });
  const { body } = drawKanban(data);
  assert.ok(column8251(body).col.children.some((n) => n.tag === 'h3' && n.textContent === 'Sin sesión · 5'), 'el encabezado cuenta las cinco');
  data.tablas = buildTables({ kanban: data.kanban, nowMs: NOW, sinModelo: true });
  assert.match(data.tablas.pendientes.cruce, /\b5 sin sesión\b/, 'la línea del kanban cuenta la columna entera');
  const sent = FIELDS_8251.pick(data, '/home/nadie');
  assert.deepStrictEqual(sent.kanban.columnas.find((c) => c.id === 'sinEmpezar').tarjetas.map((c) => c.titulo), ['Fila uno', 'Fila dos'], 'al sitio no viajan, como hoy');
});
