'use strict';
/*
 * access.js — EL ROL DE QUIEN PIDE Y EL FILTRO POR PERSONA (story 2.23, AC 10 a 12; decisiones 14, 18 y 22).
 *
 * Todo dato que el sitio muestra pasa por `filtrar()` antes de llegar a una vista: la pantalla nunca recibe lo que la
 * persona no puede ver (S6). El rol se decide en CADA pedido con la configuración vigente, y sale SÓLO de la lista de
 * quién entra (`site.access` de operations.json; sin ella, la lista armada con lo de antes):
 *   · mantenedor  su entrada tiene `role: maintainer`; o, SÓLO mientras la lista no tiene ningún maintainer, es
 *                 `SITE_FIRST_MAINTAINER` (decisión 14). Con alguno, la variable no cuenta y quien mantiene ve un aviso
 *                 para sacarla.
 *   · persona     su entrada tiene `role: dev`.
 *   · sin rol     lo demás: una página que dice que su cuenta no está en la lista, sin datos y con cómo entrar con otra cuenta.
 * Una persona puede tener varios correos: entra con cualquiera y lo suyo se calcula con todos.
 *
 * QUÉ ES DE QUIÉN (AC 12):
 *   · una corrida es de la persona confirmada para su máquina. La máquina es su carpeta nueva del buzón; una carpeta
 *     vieja `unida` (`.carpetas-de-maquina.json`, 2.28) sigue la confirmación de su nueva, y una entrada de
 *     `people.machines` con el nombre viejo no cuenta; una vieja `compartida` o `siguio_recibiendo`, y toda máquina sin
 *     confirmar o caída, la ven SÓLO quienes mantienen. Una corrida sin máquina, también.
 *   · un pull request es de su autor y un pedido de su asignado, si la identidad de la plataforma es el correo de la
 *     persona o una de las suyas en `people.<correo>.identities`, sin distinguir mayúsculas. Si ninguna de sus
 *     identidades aparece en la fuente y no tiene alias, la fila dice «no medido» con la frase de asociarla.
 *   · un proyecto es de la persona si «donde trabaja» (2.28) lo nombra; sin esa lista, la frase de que todavía no se sabe.
 *
 * LA REGLA ES LA DE scripts/lib/people.js (2.28), y no se copia acá: quién es persona (`esPersona`), el estado de cada
 * máquina (`estadoDeMaquina`, con la unión de carpetas), quién ve una corrida (`puedeVer`), las máquinas por confirmar
 * (`maquinasPorConfirmar`) y dónde trabaja cada uno (`dondeTrabaja`). Lo que la máquina informa (su correo) llega en
 * `personas.informados`, FUERA del modelo: el modelo va entero a quien mantiene, y ningún correo informado puede llegar a
 * una pantalla. Lo único propio del sitio es la lista de mantenedores (con `SITE_FIRST_MAINTAINER`).
 */
const people = require('../lib/people.js');

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (c) => String(c || '').trim().toLowerCase();
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

const FRASE_IDENTIDAD = 'no medido: tu identidad en la plataforma no es tu correo de la organización; pedile a quien mantiene que la asocie';
const FRASE_PROYECTOS = 'quien mantiene todavía no te asignó productos';
const FRASE_INEXISTENTES = 'lo que te asignaron no está en la lista de productos: avisale a quien mantiene';

/** El contexto de la regla: la configuración vigente (o el último bueno) y lo informado por las máquinas. */
const contextoDe = (config, personas) => people.contexto({ operations: isObject(config) ? config : {}, informados: personas && isObject(personas.informados) ? personas.informados : null });

/** La lista de quién entra: `site.access`, o la migración desde lo de antes. La regla vive en people.js. */
const listaDeAcceso = (config) => people.listaDeAcceso(isObject(config) ? config : {});

/** Los correos de quienes mantienen y de dónde salen: la lista, o `SITE_FIRST_MAINTAINER` mientras la lista no tiene ninguno. */
function mantenedores(config, firstMaintainer) {
  const lista = listaDeAcceso(config).entradas.filter((e) => e.role === 'maintainer').flatMap((e) => e.emails);
  if (lista.length) return { lista: new Set(lista), origen: 'lista', variableSobrante: Boolean(firstMaintainer) };
  if (firstMaintainer && CORREO.test(norm(firstMaintainer))) return { lista: new Set([norm(firstMaintainer)]), origen: 'variable', variableSobrante: false };
  return { lista: new Set(), origen: 'ninguno', variableSobrante: false };
}

/**
 * Quién pide: { email, correos, correoDeIngreso, sub, rol, sinMantenedores, variableSobrante }. La sesión no trae rol:
 * sale SÓLO de la lista, con cualquier proveedor. `email` es el primer correo de su entrada (el de la persona), así entra
 * con cualquiera de los suyos y ve lo mismo; `correoDeIngreso`, con el que entró.
 */
function quienPide(ses, { config, firstMaintainer } = {}) {
  const correoDeIngreso = norm(ses.email);
  const c = contextoDe(config, null);
  const correos = people.correosDe(correoDeIngreso, c);
  const m = mantenedores(config, firstMaintainer);
  let rol = 'none';
  if (correos.some((x) => m.lista.has(x))) rol = 'maintainer';
  else if (people.esPersona(correoDeIngreso, c)) rol = 'person';
  return { email: correos[0] || correoDeIngreso, correos, correoDeIngreso, sub: ses.sub, rol, sinMantenedores: m.origen === 'ninguno', variableSobrante: rol === 'maintainer' && m.variableSobrante };
}

/** Las reglas de qué es de quién para una configuración, un modelo y lo informado (`personas`, de sources.js). */
function crearReglas({ config, modelo, personas } = {}) {
  const c = contextoDe(config, personas);
  const m = isObject(modelo) ? modelo : {};
  const peopleCfg = config && isObject(config.people) ? config.people : {};
  // lo informado que no se pudo leer NO es «ninguna máquina informa nada»: sin eso, una máquina que hoy informa otro
  // correo pasaría por confirmada. Falla hacia cerrar: la persona no ve corridas y la cuenta de quien mantiene no se sabe
  const inf = personas && isObject(personas.informados) ? personas.informados : null;
  // las uniones de carpetas sin calcular, tampoco: una carpeta vieja compartida pasaría por carpeta propia (revisores)
  const informadosOk = Boolean(inf) && !inf.no_medido && !(isObject(inf.uniones) && inf.uniones.no_medido);
  // la carpeta real de la corrida: `maquina` ya viene unida a la nueva (runs.js), y people.js juzga la unión desde la vieja
  const carpetaDe = (x) => (isObject(x) ? x.carpeta || x.maquina || null : null);

  /** La máquina de una carpeta del buzón: { carpeta (la nueva, si es una vieja unida), estado, motivo, person }. */
  function maquina(nombre) {
    if (!nombre) return { carpeta: null, estado: 'sin_maquina', motivo: 'una corrida sin máquina', person: null };
    const e = people.estadoDeMaquina(nombre, c);
    return { carpeta: e.antes_de || nombre, estado: e.estado, motivo: e.motivo || null, person: e.person || null };
  }

  /** Las identidades de la plataforma de una persona: todos sus correos de la lista y sus alias confirmados. */
  function identidades(email) {
    const suyos = people.correosDe(email, c);
    const alias = Object.entries(peopleCfg).filter(([k, p]) => suyos.includes(norm(k)) && isObject(p) && Array.isArray(p.identities))
      .flatMap(([, p]) => p.identities.map(norm).filter(Boolean));
    return { todas: new Set([...suyos, ...alias]), conAlias: alias.length > 0 };
  }

  const existentes = new Set((Array.isArray(m.productos) ? m.productos : []).filter(isObject).map((p) => p.producto));
  /** Lo declarado en Configuración (`people.projects.<correo>.add`, con todos los correos de la persona), sólo los productos que existen. */
  function declaradosCrudos(email) {
    const suyos = people.correosDe(email, c);
    const add = Object.entries(c.projects || {}).filter(([k]) => suyos.includes(norm(k)))
      .flatMap(([, v]) => (isObject(v) && Array.isArray(v.add) ? v.add : [])).filter((p) => typeof p === 'string');
    return [...new Set(add)];
  }
  function declaradosDe(email) { return declaradosCrudos(email).filter((p) => existentes.has(p)).sort(); }

  /**
   * Los productos que ve una persona: SÓLO lo declarado. Deducirlo de corridas o pedidos mostraba productos donde no
   * trabaja (un pedido asignado alcanzaba). Sin nada declarado, null: la tabla cerrada con su frase, nunca todos.
   */
  function proyectosDe(email) {
    const d = declaradosDe(email);
    return d.length ? d : null;
  }

  /** Lo deducido de sus corridas y sus pedidos que todavía no está declarado: una sugerencia para quien mantiene. */
  function sugeridosDe(email) {
    const lista = (f) => (isObject(f) && Array.isArray(f.lista) ? f.lista : []);
    const d = people.dondeTrabaja(email, c, {
      repos: personas && Array.isArray(personas.repos) ? personas.repos : null,
      fotos: lista(m.proyectos).filter(isObject).map((x) => ({ proyecto: x.proyecto, repo: x.repo })),
      // sin lo informado no se sabe de quién es cada corrida: no sugieren productos (los pedidos, sí)
      corridas: informadosOk ? lista(m.corridas).filter(isObject).map((x) => ({ maquina: carpetaDe(x), producto: x.producto || null, cambio: null })) : [],
      pedidos: lista(m.pedidos).filter(isObject).map((x) => ({ proyecto: x.proyecto, asignado: x.asignado })),
    });
    if (d.estado !== 'medido') return [];
    const ya = new Set(declaradosDe(email));
    // los deducidos salen de repos.json: son productos que existen
    return d.productos.map((p) => p.producto).filter((p) => !ya.has(p)).sort();
  }

  return {
    maquina,
    identidades,
    proyectosDe,
    sugeridosDe,
    /** ¿Tiene algo declarado que no está en la lista de productos? Sin esto la frase diría «no te asignó», que es falso. */
    declaradoSinExistir: (email) => declaradosCrudos(email).some((p) => !existentes.has(p)),
    /** ¿Se sabe de quién es cada máquina? Sin lo informado (o sin las uniones), nadie que no mantenga ve corridas (story 2.27). */
    quienEsQuienMedido: informadosOk,
    /** Las máquinas confirmadas de una persona (la ficha gris de quien todavía no tiene corridas, story 2.27 AC 11). */
    maquinasDe: (email) => {
      const suyos = people.correosDe(email, c);
      if (!informadosOk) return [];
      return Object.keys(c.machines).filter((k) => { const x = people.estadoDeMaquina(k, c); return x.estado === 'confirmada' && suyos.includes(x.person); }).sort();
    },
    /** ¿Ve `email` esta corrida? La regla de people.js sobre la carpeta real de la corrida. */
    puedeVer: (email, corrida) => informadosOk && people.puedeVer(email, carpetaDe(corrida), c),
    // las máquinas sin confirmar CON CORRIDAS (la fila del Inicio de quien mantiene, sólo la cuenta): las de
    // `people.maquinasPorConfirmar` que tienen alguna corrida, por su carpeta real o la nueva a la que se une; una
    // corrida sin máquina no es una máquina. Sin lo informado, null: la cuenta no se sabe.
    sinConfirmar: (lista) => {
      if (!informadosOk) return null;
      const conCorridas = new Set();
      for (const x of lista) {
        const k = carpetaDe(x);
        if (!k) continue;
        conCorridas.add(k);
        const e = people.estadoDeMaquina(k, c);
        if (e.antes_de) conCorridas.add(e.antes_de);
      }
      return people.maquinasPorConfirmar(c).filter((x) => conCorridas.has(x.maquina)).length;
    },
  };
}

const copia = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/**
 * El modelo que puede ver quien pide. Quien mantiene recibe todo (que ya viene sin texto libre desde sources.js) más la
 * cuenta de máquinas sin confirmar; una persona, sólo lo suyo; sin rol, nada.
 */
function filtrar(modelo, quien, reglas) {
  const m = modelo || {};
  if (quien.rol === 'maintainer') {
    const out = copia(m);
    const lista = (m.corridas && Array.isArray(m.corridas.lista)) ? m.corridas.lista : [];
    out.maquinasSinConfirmar = reglas.sinConfirmar(lista);
    out.rol = 'maintainer';
    return out;
  }
  if (quien.rol !== 'person') return { rol: 'none' };

  const out = { rol: 'person', fuentes: copia(m.fuentes) || {} };
  const corridas = m.corridas || {};
  out.corridas = { estado: corridas.estado || 'no_medido', codigo: corridas.codigo || null, motivo: corridas.motivo || null, fecha: corridas.fecha || null,
    lista: (Array.isArray(corridas.lista) ? corridas.lista : []).filter((c) => reglas.puedeVer(quien.email, c)).map(copia) };

  const ids = reglas.identidades(quien.email);
  const prs = m.prs || {};
  const pedidos = m.pedidos || {};
  const listaPrs = Array.isArray(prs.lista) ? prs.lista : [];
  const listaPedidos = Array.isArray(pedidos.lista) ? pedidos.lista : [];
  const aparece = listaPrs.some((p) => ids.todas.has(norm(p.autor))) || listaPedidos.some((p) => ids.todas.has(norm(p.asignado)));
  const propia = (fuente, lista, campo) => {
    if (fuente.estado !== 'medido') return { estado: 'no_medido', codigo: fuente.codigo || null, motivo: fuente.motivo || null, fecha: fuente.fecha || null, lista: [] };
    if (!aparece && !ids.conAlias) return { estado: 'no_medido', codigo: 'identidad_sin_asociar', motivo: FRASE_IDENTIDAD, fecha: fuente.fecha || null, lista: [] };
    return { estado: 'medido', codigo: null, motivo: null, fecha: fuente.fecha || null, lista: lista.filter((x) => ids.todas.has(norm(x[campo]))).map(copia) };
  };
  out.prs = propia(prs, listaPrs, 'autor');
  out.pedidos = propia(pedidos, listaPedidos, 'asignado');

  const suyos = reglas.proyectosDe(quien.email);
  if (!Array.isArray(suyos)) {
    out.proyectos = reglas.declaradoSinExistir && reglas.declaradoSinExistir(quien.email)
      ? { estado: 'no_medido', codigo: 'declarados_inexistentes', motivo: FRASE_INEXISTENTES, lista: null }
      : { estado: 'no_medido', codigo: 'sin_donde_trabaja', motivo: FRASE_PROYECTOS, lista: null };
    out.productos = [];
  } else {
    const set = new Set(suyos);
    out.productos = (Array.isArray(m.productos) ? m.productos : []).filter((p) => set.has(p.producto)).map(copia);
    out.productosFuente = copia(m.productosFuente);
    // el cruce es por el nombre del PROYECTO (decodificado en sources.js), como en la pestaña de quien mantiene
    const proyectosSuyos = new Set(out.productos.flatMap((p) => p.proyectos || []));
    const pr = m.proyectos || {};
    out.proyectos = { estado: pr.estado || 'no_medido', codigo: pr.codigo || null, motivo: pr.motivo || null, fecha: pr.fecha || null, hay_al_dia: pr.hay_al_dia === true,
      lista: (Array.isArray(pr.lista) ? pr.lista : []).filter((x) => proyectosSuyos.has(x.proyecto)).map(copia) };
    if (m.despliegues) {
      const d = copia(m.despliegues);
      d.productos = Object.fromEntries(Object.entries(d.productos || {}).filter(([k]) => set.has(k)));
      out.despliegues = d;
    }
    // los proyectos que la noche no pudo medir: sólo los suyos (el nombre de un proyecto ajeno es de otra persona)
    out.pedidos.sin_medir = (Array.isArray(pedidos.sin_medir) ? pedidos.sin_medir : []).filter((x) => proyectosSuyos.has(x));
    if (m.dependencias && m.dependencias.vivas_por_proyecto) {
      out.dependencias = { estado: m.dependencias.estado, codigo: m.dependencias.codigo || null, fecha: m.dependencias.fecha || null,
        vivas_por_proyecto: Object.fromEntries(Object.entries(m.dependencias.vivas_por_proyecto).filter(([k]) => proyectosSuyos.has(k))) };
    }
    if (m.paridad) {
      const rutas = new Set(out.productos.flatMap((p) => p.rutas || []));
      out.paridad = { ...copia(m.paridad), por_ruta: Array.isArray(m.paridad.por_ruta) ? m.paridad.por_ruta.filter((x) => rutas.has(x.ruta)).map(copia) : undefined };
    }
    // el vigilante nombra los productos a su manera (minúsculas, a veces con espacios): se compara como en la vista
    const forma = (s) => String(s).toLowerCase().replace(/\s+/g, '');
    const formas = new Set([...set].map(forma));
    if (m.vigilante && Array.isArray(m.vigilante.productos)) out.vigilante = { estado: m.vigilante.estado, fecha: m.vigilante.fecha || null, productos: m.vigilante.productos.filter((p) => formas.has(forma(p))) };
  }
  out.umbrales = copia(m.umbrales);
  return out;
}

/**
 * LAS CORRIDAS DE LA PESTAÑA (story 2.27, AC 8 a 12; decisiones 6, 7 y 13). `M` es el modelo de runs.js armado desde el
 * espejo; sale el modelo que puede ver quien pide, ANTES de armar cualquier respuesta (la lista, el detalle o los textos):
 *   · quien mantiene: todas, también las sin máquina y las de máquinas sin confirmar, con los conteos globales;
 *   · una persona: sólo las de sus máquinas confirmadas (la regla de people.js, la misma de `puedeVer`), sin los conteos
 *     globales, con las máquinas y el buzón recalculados sobre lo suyo (`{ estado, parcial }`, sin el número de carpetas);
 *   · sin rol: null.
 * Los productos se unifican sobre lo filtrado, nunca sobre todo (decisión 13): el nombre de un dev no hereda la carpeta
 * de la máquina de otro. Todo sale copiado: el modelo de la pestaña no se toca.
 */
function filtrarCorridas(M, quien, reglas) {
  if (quien.rol !== 'maintainer' && quien.rol !== 'person') return null;
  const { unificarProductos } = require('../nightly/dashboard/runs.js');
  const m = M || {};
  const lista = Array.isArray(m.corridas) ? m.corridas : [];
  const mantiene = quien.rol === 'maintainer';
  const ve = mantiene ? () => true : (c) => Boolean(c.maquina) && reglas.puedeVer(quien.email, { maquina: c.maquina, carpeta: c.maquina_origen || c.maquina });
  const corridas = lista.filter(ve).map(copia);
  unificarProductos(corridas);
  const { corridas: _todas, archivos, duplicados, ilegibles, maquinas, buzon, ...resto } = m;
  const out = { ...copia(resto), corridas };
  if (mantiene) {
    Object.assign(out, { archivos, duplicados, ilegibles, buzon: copia(buzon), maquinas: maquinas ? { ...copia(maquinas), local: null, solo_esta: false } : maquinas, varias_maquinas: true });
    return out;
  }
  const cuenta = {};
  for (const c of corridas) cuenta[c.maquina] = (cuenta[c.maquina] || 0) + 1;
  out.maquinas = { local: null, solo_esta: false, lista: Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a] || a.localeCompare(b)).map((n) => ({ nombre: n, corridas: cuenta[n] })) };
  out.varias_maquinas = out.maquinas.lista.length > 1;
  out.buzon = buzon ? { estado: buzon.estado, parcial: buzon.estado !== 'leido' || Boolean(buzon.carpetas_ilegibles) } : null;
  // sin saber de quién es cada máquina, el filtro cierra (no se ve nada), pero eso NO es «no hay corridas»: es «no
  // medido» (pase adversarial). Pasa hasta la primera bajada entera del buzón, o si lo informado no se pudo leer.
  if (reglas.quienEsQuienMedido === false) {
    out.buzon = { estado: buzon ? buzon.estado : 'no_medido', parcial: true };
    out.vacio_motivo = 'no medido: todavía no se pudo saber de quién es cada máquina (lo que informan las máquinas se lee con la primera bajada entera del buzón); tus corridas faltan, no son cero';
    return out;
  }
  if (!corridas.length) {
    const suyas = reglas.maquinasDe ? reglas.maquinasDe(quien.email) : [];
    out.vacio_motivo = `todavía no hay corridas de tus máquinas en el buzón (${suyas.join(', ') || 'ninguna confirmada'}): la primera llega sola al terminar un pipeline`;
  }
  return out;
}

module.exports = { quienPide, mantenedores, listaDeAcceso, crearReglas, filtrar, filtrarCorridas, FRASE_IDENTIDAD, FRASE_PROYECTOS };
