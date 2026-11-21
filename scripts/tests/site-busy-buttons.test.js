'use strict';
// Los botones del sitio dicen que trabajan: el ayudante común (`scripts/site/busy.js`), cada botón medido
// que lo usa, y la regla que hace que una llamada nueva al servidor nazca con él.
// Correr: node --test scripts/tests/site-busy-buttons.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BUSY = require(path.join(ROOT, 'scripts', 'site', 'busy.js'));
const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));

/** Un botón del DOM, lo justo para el ayudante: atributos, texto y un padre donde dejar el motivo. */
function botonFalso(texto) {
  const padre = { hijos: [], insertBefore(n, ref) { const i = ref ? padre.hijos.indexOf(ref) : -1; n.parentNode = padre; if (i < 0) padre.hijos.push(n); else padre.hijos.splice(i, 0, n); return n; }, removeChild(n) { padre.hijos = padre.hijos.filter((x) => x !== n); n.parentNode = null; return n; } };
  const b = {
    tag: 'button', textContent: texto, attrs: {}, parentNode: padre,
    setAttribute(k, v) { b.attrs[k] = String(v); }, getAttribute(k) { return k in b.attrs ? b.attrs[k] : null; }, removeAttribute(k) { delete b.attrs[k]; },
    get nextSibling() { const i = padre.hijos.indexOf(b); return i >= 0 ? padre.hijos[i + 1] || null : null; },
  };
  padre.hijos.push(b);
  return b;
}
const documentoFalso = { createElement: (tag) => ({ tag, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } }) };
/** Un reloj de mentira: los temporizadores corren cuando la prueba avanza el tiempo. */
function relojFalso() {
  let ahora = 0; let id = 0; const pendientes = new Map();
  return {
    setTimeout(fn, ms) { id += 1; pendientes.set(id, { fn, en: ahora + ms }); return id; },
    clearTimeout(i) { pendientes.delete(i); },
    avanzar(ms) { ahora += ms; for (const [i, p] of [...pendientes]) if (p.en <= ahora) { pendientes.delete(i); p.fn(); } },
  };
}
const esperar = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const ayudante = (reloj) => BUSY.crear({ document: documentoFalso, setTimeout: reloj.setTimeout, clearTimeout: reloj.clearTimeout, textos: { sigue: t('es', 'pantalla.sigueTrabajando') } });

test('T1 Trabajando_AlTocar_DeshabilitaYDiceQueHace @story-8.203 @ac-1 — desde el toque, apagado, ocupado y con lo que hace; el segundo toque no hace nada', async () => {
  const reloj = relojFalso();
  const h = ayudante(reloj);
  const b = botonFalso('Revisar cambios');
  let llamadas = 0;
  const accion = () => { llamadas += 1; return new Promise(() => {}); };
  h.trabajando(b, 'Revisando…', accion);
  // en el mismo momento, sin esperar a la promesa
  assert.strictEqual(b.getAttribute('disabled'), 'disabled');
  assert.strictEqual(b.getAttribute('aria-busy'), 'true');
  assert.strictEqual(b.textContent, 'Revisando…');
  h.trabajando(b, 'Revisando…', accion);
  await esperar();
  assert.strictEqual(llamadas, 1, 'el segundo toque no vuelve a llamar');
});

test('T2 Trabajando_DiezSegundos_SigueTrabajando @story-8.203 @ac-2 — a los 10 s suma «sigue trabajando»', async () => {
  const reloj = relojFalso();
  const h = ayudante(reloj);
  const b = botonFalso('Revisar cambios');
  h.trabajando(b, 'Revisando…', () => new Promise(() => {}));
  reloj.avanzar(9999);
  assert.strictEqual(b.textContent, 'Revisando…');
  reloj.avanzar(1);
  assert.match(b.textContent, /^Revisando… · sigue trabajando$/);
  assert.strictEqual(b.getAttribute('disabled'), 'disabled');
});

test('T3 Trabajando_Falla_DiceElMotivoYRehabilita @story-8.203 @ac-3 — error del servidor, sin red, respuesta ilegible: el motivo al lado y el botón como estaba', async () => {
  const casos = [
    [() => Promise.resolve({ ok: false, message: 'el lector rechaza la sección: falta «owners»' }), /el lector rechaza la sección: falta «owners»/],
    [() => Promise.reject(new TypeError('Failed to fetch')), /Failed to fetch/],
    [() => Promise.resolve({ ok: false, sinRespuesta: true, message: 'el sitio contestó con un error (502)' }), /el sitio contestó con un error \(502\)/],
  ];
  for (const [accion, rx] of casos) {
    const reloj = relojFalso();
    const h = ayudante(reloj);
    const b = botonFalso('Revisar cambios');
    await h.trabajando(b, 'Revisando…', accion);
    assert.strictEqual(b.getAttribute('disabled'), null, 'habilitado otra vez');
    assert.strictEqual(b.getAttribute('aria-busy'), null);
    assert.strictEqual(b.textContent, 'Revisar cambios', 'con su texto de siempre');
    const motivo = b.nextSibling;
    assert.ok(motivo && motivo.getAttribute('data-motivo') === 'trabajando', 'el motivo va al lado del botón');
    assert.match(motivo.textContent, rx);
    // al volver a tocarlo, el motivo viejo se va
    const p = h.trabajando(b, 'Revisando…', () => Promise.resolve({ ok: true }));
    assert.ok(!b.nextSibling || b.nextSibling.getAttribute('data-motivo') !== 'trabajando');
    await p;
  }
});

test('T4 Trabajando_SaleBien_VuelveComoEstaba @story-8.203 @ac-3 — bien: el texto y el estado de siempre, y la respuesta intacta para quien llamó', async () => {
  const reloj = relojFalso();
  const h = ayudante(reloj);
  const b = botonFalso('Proponer el cambio');
  const respuesta = { ok: true, codigo: 'abierto', enlace: 'https://example.invalid/pr/1' };
  const r = await h.trabajando(b, 'Proponiendo…', () => Promise.resolve(respuesta));
  assert.strictEqual(r, respuesta);
  assert.strictEqual(b.textContent, 'Proponer el cambio');
  assert.strictEqual(b.getAttribute('disabled'), null);
  assert.strictEqual(b.getAttribute('aria-busy'), null);
  assert.strictEqual(b.nextSibling, null, 'sin motivo');
  // un botón que ya nació apagado vuelve apagado
  const apagado = botonFalso('Proponer el cambio'); apagado.setAttribute('disabled', 'disabled');
  await h.trabajando(apagado, 'Proponiendo…', () => Promise.resolve({ ok: true }));
  assert.strictEqual(apagado.getAttribute('disabled'), 'disabled');
  // el temporizador de «sigue trabajando» no queda vivo
  reloj.avanzar(20000);
  assert.strictEqual(b.textContent, 'Proponer el cambio');
});

// ── T5: cada botón medido usa el ayudante ──────────────────────────────────────────────────────────────────────────────

/**
 * La pantalla de Configuración en un DOM falso. `respuestas[ruta]` contesta esa ruta; una ruta sin respuesta no termina
 * nunca (el servidor callado), para ver el botón mientras trabaja.
 */
async function pantallaColgada(secciones, { extras = {}, respuestas = {} } = {}) {
  const creados = [];
  const nodo = (tag) => { const n = { tag, hijos: [], textContent: '', attrs: {}, on: {}, value: undefined, setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; }, removeAttribute(k) { delete n.attrs[k]; }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener(e, f) { n.on[e] = f; }, replaceChildren(...cs) { n.hijos = cs; } }; creados.push(n); return n; };
  const app = nodo('div');
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: (tg) => nodo(tg) };
  const respuesta = { ok: true, secciones, proponer: { operaciones: { habilitado: true }, perfil: { habilitado: true } }, versiones: [], productos: [], ...extras };
  const pedidos = [];
  const fetch = (ruta, o) => {
    pedidos.push(ruta);
    const cuerpo = o && o.body ? JSON.parse(o.body) : null;
    if (ruta === '/api/config') return Promise.resolve({ status: 200, json: () => Promise.resolve(respuesta) });
    if (respuestas[ruta]) return Promise.resolve({ status: 200, json: () => Promise.resolve(respuestas[ruta](cuerpo)) });
    return new Promise(() => {});
  };
  new Function('document', 'fetch', ORG.pantalla('es'))(document, fetch);
  await esperar();
  const todo = (n) => { const out = []; const walk = (x) => { out.push(x); (x.hijos || []).forEach(walk); }; walk(n); return out; };
  // la pantalla se vuelve a dibujar entera: siempre se busca desde la raíz, en lo dibujado ahora
  const botones = (dentroDe) => {
    const raiz = dentroDe ? todo(app).filter((n) => n.attrs.id === dentroDe).pop() : app;
    return raiz ? todo(raiz).filter((n) => n.tag === 'button') : [];
  };
  const boton = (texto, dentroDe) => botones(dentroDe).filter((n) => n.textContent === texto).pop();
  const tocar = async (texto, dentroDe) => { const b = boton(texto, dentroDe); assert.ok(b, `hay «${texto}»${dentroDe ? ` en ${dentroDe}` : ''}`); b.on.click({}); await esperar(); };
  const ocupados = (dentroDe) => botones(dentroDe).filter((n) => n.attrs['aria-busy'] === 'true');
  return { boton, tocar, botones, ocupados, pedidos };
}
const SEC = (id, extra = {}) => Object.assign({ id, titulo: id, repo: 'operaciones', estado: 'cargado', soloLectura: false, borrador: {}, problems: [], avisos: [] }, extra);
/** El único botón ocupado del lugar: apagado, `aria-busy` y el texto de lo que hace. */
function unoOcupado(p, texto, dentroDe) {
  const os = p.ocupados(dentroDe);
  assert.strictEqual(os.length, 1, `un botón trabajando en ${dentroDe || 'la pantalla'} (hay ${os.length})`);
  assert.strictEqual(os[0].attrs.disabled, 'disabled');
  assert.strictEqual(os[0].textContent, texto);
  return os[0];
}
const es = (k) => t('es', k);
const revisadoBien = () => ({ ok: true, texto: '{\n  "owners": {}\n}\n', diferencia: [], resumen: [], problems: [], avisos: [] });

test('T5 Barrido_LosBotonesMedidos_UsanTrabajando @story-8.203 @ac-4 — cada botón de Configuración, tocado con el servidor callado, queda apagado diciendo qué hace', async () => {
  // «Revisar cambios» de una sección (el caso del dueño)
  {
    const p = await pantallaColgada([SEC('responsables', { borrador: { owners: { default: 'ana@acme.example' } } })]);
    await p.tocar(es('pantalla.revisarCambios'), 'seccion-responsables');
    unoOcupado(p, es('pantalla.revisando'), 'seccion-responsables');
    // un segundo toque sobre el botón ocupado no vuelve a llamar
    p.ocupados('seccion-responsables')[0].on.click({});
    assert.strictEqual(p.pedidos.filter((r) => r === '/api/config/revisar').length, 1);
  }
  // «Confirmar y proponer», con la sección ya revisada
  {
    const p = await pantallaColgada([SEC('responsables', { borrador: { owners: { default: 'ana@acme.example' } } })], { respuestas: { '/api/config/revisar': revisadoBien } });
    await p.tocar(es('pantalla.revisarCambios'), 'seccion-responsables');
    await p.tocar(es('pantalla.proponerElCambio'), 'seccion-responsables');
    await p.tocar(es('pantalla.confirmarYProponer'), 'seccion-responsables');
    unoOcupado(p, es('pantalla.proponiendoBoton'), 'seccion-responsables');
  }
  // «Ver sus pasos» de un pipeline (Despliegues)
  {
    const p = await pantallaColgada([SEC('despliegues', { borrador: { deployments: { provider: 'azure', products: {} } } })]);
    await p.tocar(es('pantalla.verSusPasos'), 'seccion-despliegues');
    unoOcupado(p, es('pantalla.abriendo'), 'seccion-despliegues');
  }
  // invitar y revocar (el sitio con acceso por invitación)
  {
    const invitaciones = { boton: true, permiso: { ok: true }, estados: { 'beto@acme.example': { estado: 'pendiente', texto: 'invitado' } } };
    const borrador = { site: { access: [{ role: 'maintainer', emails: ['ana@acme.example', 'beto@acme.example'] }] } };
    const p = await pantallaColgada([SEC('sitio', { borrador, extras: { conAcceso: true, invitaciones } })]);
    await p.tocar(es('pantalla.invitar'), 'seccion-sitio');
    unoOcupado(p, es('pantalla.invitando'), 'seccion-sitio');
    const q = await pantallaColgada([SEC('sitio', { borrador, extras: { conAcceso: true, invitaciones } })]);
    await q.tocar(es('pantalla.revocar'), 'seccion-sitio');
    unoOcupado(q, es('pantalla.proponiendoBoton'), 'seccion-sitio');
  }
  // las de «Máquinas con oficina»: una por vez, y sólo la tocada dice que trabaja
  {
    const oficinas = { conBuzon: true, pedidos: [], maquinas: [{ maquina: 'mac-1', person: 'ana@acme.example', fingerprint: 'abc', copiada: true, conectada: false }] };
    const p = await pantallaColgada([SEC('personas', { borrador: { people: {} }, extras: { oficinas } })]);
    await p.tocar(es('pantalla.oficinaBaja'), 'seccion-personas');
    unoOcupado(p, es('pantalla.guardando'), 'seccion-personas');
    const otros = p.botones('seccion-personas').filter((b) => [es('pantalla.oficinaRetirarClave'), es('pantalla.oficinaBorrarMarca')].includes(b.textContent));
    assert.strictEqual(otros.length, 2);
    assert.ok(otros.every((b) => b.attrs.disabled === 'disabled'), 'los otros, apagados mientras tanto');
  }
  // «Revisar cambios» y «Proponer el cambio» de un repo de producto
  {
    const reposDeProducto = { lista: [{ id: 'p1', nombre: 'Producto 1' }] };
    const panel = () => ({ ok: true, oid: 'o1', texto: '{}\n', proponer: { habilitado: true }, claves: [{ clave: 'k', titulo: 'K', estado: 'ok', valor: { modo: 'a' }, forma: {} }] });
    const p = await pantallaColgada([SEC('repos', { repo: 'perfil', borrador: {} })], { extras: { reposDeProducto }, respuestas: { '/api/config/repo?id=p1': panel, '/api/config/repo/revisar': () => ({ ok: true, texto: '{}\n', diferencia: [] }) } });
    await p.tocar(es('pantalla.repoAbrir'), 'repo-p1');
    await p.tocar(es('pantalla.revisarCambios'), 'repo-p1');
    await p.tocar(es('pantalla.proponerElCambio'), 'repo-p1');
    unoOcupado(p, es('pantalla.proponiendoBoton'), 'repo-p1');
    const q = await pantallaColgada([SEC('repos', { repo: 'perfil', borrador: {} })], { extras: { reposDeProducto }, respuestas: { '/api/config/repo?id=p1': panel } });
    await q.tocar(es('pantalla.repoAbrir'), 'repo-p1');
    await q.tocar(es('pantalla.revisarCambios'), 'repo-p1');
    unoOcupado(q, es('pantalla.revisando'), 'repo-p1');
  }
});

test('T5c Barrido_FallaEnPantalla_HabilitadoOtraVez @story-8.203 @ac-3 — «Ver sus pasos» que falla dice el motivo y vuelve a estar habilitado', async () => {
  const p = await pantallaColgada([SEC('despliegues', { borrador: { deployments: { provider: 'azure', products: {} } } })], { respuestas: { '/api/config/stages': () => ({ ok: false, message: 'el pipeline 7 no existe' }) } });
  await p.tocar(es('pantalla.verSusPasos'), 'seccion-despliegues');
  assert.strictEqual(p.ocupados('seccion-despliegues').length, 0);
  const b = p.boton(es('pantalla.verSusPasos'), 'seccion-despliegues');
  assert.ok(b && b.attrs.disabled === undefined, 'habilitado otra vez, con su texto');
});

test('T5b Barrido_ComoTrabajaYHallazgos_UsanTrabajando @story-8.203 @ac-4 — «Cómo trabaja» y el envío de Hallazgos interpolan el ayudante; proponer revisor se rehabilita al fallar', () => {
  const HIW = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'how-it-works.js'));
  const FIN = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'findings.js'));
  const comoTrabaja = HIW.guion('es');
  for (const [nombre, codigo] of [['how-it-works', comoTrabaja], ['findings', FIN.CLIENTE]]) {
    assert.ok(codigo.includes(BUSY.FIRMA), `${nombre} trae el ayudante común`);
  }
  // «Revisar», proponer revisor y abrir un revisor van por el ayudante
  assert.match(comoTrabaja, /trabajando\(revisar,/);
  assert.match(comoTrabaja, /trabajando\(proponer,/);
  assert.match(comoTrabaja, /trabajando\(b,/);
  // proponer revisor ya no se apaga a mano (si falla, el ayudante lo devuelve habilitado)
  assert.doesNotMatch(comoTrabaja, /proponer\.setAttribute\('disabled', 'disabled'\);\s*pedir\('\/api\/como-trabaja\/proponer'/);
  // el envío de Hallazgos conserva «enviando» y «lento»
  assert.match(FIN.CLIENTE, /trabajando\(barra\.querySelector\('\.m-enviar'\)/);
  assert.match(FIN.CLIENTE, /t\('enviando'\)/);
  assert.match(FIN.CLIENTE, /t\('lento'\)/);
});

// ── T6: la regla para lo nuevo ─────────────────────────────────────────────────────────────────────────────────────────

const ARCHIVOS = () => {
  const lista = ['scripts/lib/org-config.js', 'scripts/tools/office/page.js'];
  for (const d of ['scripts/site/tabs', 'scripts/site/static']) for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith('.js')) lista.push(`${d}/${f}`);
  return lista.map((archivo) => ({ archivo, texto: fs.readFileSync(path.join(ROOT, archivo), 'utf8') }));
};

test('T6 Regla_LlamadaNuevaSinAyudante_Rojo @story-8.203 @ac-5 @ac-6 — cada llamada al servidor va por el ayudante o está en la lista con su motivo', () => {
  const reales = ARCHIVOS();
  assert.deepStrictEqual(BUSY.revisarLlamadas(reales, BUSY.EXCEPCIONES), [], 'el código de hoy cumple');
  // la conversación de la oficina está en la lista, con su motivo (AC 6)
  const charla = BUSY.EXCEPCIONES.find((x) => x.archivo === 'scripts/tools/office/page.js' && x.funcion === 'abrirCharla');
  assert.ok(charla && /Leyendo/.test(charla.motivo));
  // una llamada nueva, fuera del ayudante y de la lista: rojo con archivo y renglón
  const config = reales.find((x) => x.archivo === 'scripts/lib/org-config.js');
  const agregado = config.texto.replace('  function revisarSeccion(s, borrador) {', "  function nuevaLlamada() { return fetch('/api/config/otra'); }\n  function revisarSeccion(s, borrador) {");
  const renglon = agregado.split('\n').findIndex((l) => l.includes("fetch('/api/config/otra')")) + 1;
  const rojos = BUSY.revisarLlamadas(reales.map((x) => (x === config ? { ...x, texto: agregado } : x)), BUSY.EXCEPCIONES);
  assert.strictEqual(rojos.length, 1);
  assert.strictEqual(rojos[0].archivo, 'scripts/lib/org-config.js');
  assert.strictEqual(rojos[0].renglon, renglon);
  assert.match(rojos[0].motivo, /nuevaLlamada/);
  // una excepción sin motivo no vale
  const sinMotivo = BUSY.EXCEPCIONES.map((x) => (x.funcion === 'abrirCharla' ? { ...x, motivo: '' } : x));
  const r = BUSY.revisarLlamadas(reales, sinMotivo);
  assert.ok(r.some((x) => x.archivo === 'scripts/tools/office/page.js' && /motivo/.test(x.motivo)));
});

// ── lo que encontró el pase adversarial sobre la regla ──────────────────────────────────────────────────────────────────

const regla = (texto, excepciones = []) => BUSY.revisarLlamadas([{ archivo: 'x.js', texto }], excepciones);

test('T6b Regla_TresNivelesDeLlamadas_Alcanzable @story-8.203 @ac-5 — lo que trabajando() alcanza se sigue hasta el fondo, no sólo dos niveles', () => {
  const tres = "function a(){ return b(); }\nfunction b(){ return c(); }\nfunction c(){ return fetch('/api/x'); }\nbtn.onclick=function(){ trabajando(btn,'t',function(){ return a(); }); };";
  assert.deepStrictEqual(regla(tres), []);
  const sinAyudante = "function a(){ return b(); }\nfunction b(){ return c(); }\nfunction c(){ return fetch('/api/x'); }\nbtn.onclick=function(){ return a(); };";
  assert.strictEqual(regla(sinAyudante).length, 1);
});

test('T6c Regla_AccionPorReferencia_Alcanzable @story-8.203 @ac-5 — la acción pasada por su nombre al ayudante cuenta como alcanzada', () => {
  assert.deepStrictEqual(regla('function guardar() { return api("/x", {}); }\nfunction boton() { trabajando(b, "t", guardar); }'), []);
});

test('T6d Regla_Excepcion_NoCubreUnBotonAdentro @story-8.203 @ac-5 @ac-6 — una excepción cubre la carga, no un botón ni una función con nombre definidos adentro', () => {
  const ex = [{ archivo: 'x.js', funcion: 'cargar', motivo: 'la carga de la pestaña' }];
  assert.deepStrictEqual(regla("function cargar(){ return fetch('/api/x').then(function (r) { return api('/y'); }); }", ex), [], 'la carga y sus vueltas, cubiertas');
  assert.strictEqual(regla("function cargar(){ b.onclick = function(){ fetch('/api/borrar'); }; }", ex).length, 1, 'un botón adentro');
  assert.strictEqual(regla("function cargar(){ b.addEventListener('click', function(){ fetch('/api/borrar'); }); }", ex).length, 1, 'un escuchador adentro');
  assert.strictEqual(regla("function cargar(){ el('button', { onclick: () => api('/borrar') }); }", ex).length, 1, 'un botón con flecha adentro');
  assert.strictEqual(regla("function cargar(){ function borrar(){ fetch('/api/borrar'); } b.onclick = borrar; }", ex).length, 1, 'una función con nombre adentro');
});

test('T6e Regla_ExpresionRegularTrasPalabraClave_NoTapaLaLlamada @story-8.203 @ac-5 — una barra después de return abre una expresión regular, no divide', () => {
  assert.strictEqual(regla("function nuevo(s){ return /'/.test(s) ? fetch('/api/x') : 0; }").length, 1);
  assert.strictEqual(regla("function nuevo(s){ if (typeof /\"/ === 'object') fetch('/api/x'); }").length, 1);
  assert.deepStrictEqual(regla('function f(a, b){ return a / b; }'), [], 'una división de verdad no abre nada');
});
