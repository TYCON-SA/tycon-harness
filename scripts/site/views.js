'use strict';
/*
 * views.js — LAS PESTAÑAS DEL SITIO, ARMADAS EN EL SERVIDOR (story 2.23, AC 17 a 23; decisiones 19, 23 y 24).
 *
 * Reciben el modelo YA FILTRADO por access.js: una vista no decide qué puede ver nadie. Cada pestaña se arma en dos
 * pasos —las filas como datos (`filas*`, `inicioDev`) y el HTML— para que las pruebas lean los números sin raspar HTML.
 *
 * REGLAS DE LA CASA:
 *   · Lee, no mide: sin la fuente, la fila dice «no medido» con su motivo; nunca la recalcula, nunca 0, nunca verde.
 *   · Lista blanca (decisión 19): cantidades, fechas, días, nombres de producto, proyecto y repo, números de PR y de
 *     pedido con su enlace, estados. Nunca texto libre de una fuente (títulos, diagnósticos, mensajes de los frenos):
 *     sources.js ya no lo copia, y todo pasa por `esc` de common.js.
 *   · Ningún <script> en línea ni nada de afuera (decisión 24): el CSS y el JS del sitio se sirven como archivos.
 *   · Los motivos que se ven son frases fijas de esta casa (la lista cerrada del AC 14); el motivo crudo va al registro.
 *   · Ningún texto visible se escribe acá: sale de la tabla de texts.js, en el idioma del pedido
 *     (`ctx.idioma`; sin él, castellano). Las funciones de filas reciben `idioma` por el mismo motivo.
 */
const { esc, chip, umbralValido } = require('../nightly/dashboard/common.js');
const fichasDelTablero = require('./tabs/cards.js');
const { compare: compararVersiones } = require('../setup/harness/version-order.js');
const { t, TEXTOS } = require('./texts.js');
/** El nombre de una fuente de la noche en un idioma; una fuente que la tabla no conoce sale con su id. */
const nombreDeFuente = (id, idioma) => (Object.prototype.hasOwnProperty.call(TEXTOS, `fuente.${id}`) ? t(idioma, `fuente.${id}`) : id);
const { IDIOMAS, POR_DEFECTO, valido } = require('./language.js');
const { MOTIVOS: MOTIVOS_ULTIMA } = require('./latest-release.js');

const DIA = 86400000;
const PARADA_DIAS = 30;

const idiomaDe = (x) => valido(x && typeof x === 'object' ? x.idioma : x) || POR_DEFECTO;

/** La hora de una marca, en UTC: «AAAA-MM-DD HH:MM UTC». */
function hora(marca, idioma = POR_DEFECTO) {
  const d = new Date(typeof marca === 'number' ? marca : Date.parse(marca || ''));
  return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : t(idioma, 'vista.sinHora');
}

/** Los códigos de estado de la lista cerrada (AC 14) y de los propios de una fuente: su frase vive en la tabla. */
const CODIGOS = ['sin_red', 'sin_permiso', 'credencial_rechazada', 'parcial', 'cargando', 'fuente_vieja', 'sin_configurar', 'sin_foto', 'ilegible',
  'sin_buzon', 'no_corre_banco', 'sin_ayer', 'sin_dato', 'sin_donde_trabaja', 'identidad_sin_asociar', 'no_medido_noche', 'sin_rama', 'falla_git',
  'falla_interna', 'sin_paridad', 'sin_productos', 'paridad_no_medida', 'sin_clon', 'grupo_sin_comparar', 'declaracion_incompleta'];
/** Las frases en un idioma: `{ codigo: frase }`. */
const frasesEn = (idioma) => Object.fromEntries(CODIGOS.map((c) => [c, t(idioma, `frase.${c}`)]));
/** Las de siempre, en castellano (las pruebas y los demás módulos las leen así). */
const FRASES = frasesEn(POR_DEFECTO);
const fraseDeCodigo = (codigo, idioma) => (CODIGOS.includes(codigo) ? t(idioma, `frase.${codigo}`) : null);
// un motivo que es la frase castellana de su código se dice en el idioma de la página; otro motivo, tal cual
const fraseDe = (f, idioma = POR_DEFECTO) => {
  if (f && f.codigo && CODIGOS.includes(f.codigo) && (!f.motivo || f.motivo === FRASES[f.codigo])) return t(idioma, `frase.${f.codigo}`);
  return (f && f.motivo) || t(idioma, 'vista.noMedido');
};
const conFecha = (f, idioma = POR_DEFECTO) => `${fraseDe(f, idioma)}${f && f.fecha ? ` ${t(idioma, 'vista.fuenteDelParen', { fecha: f.fecha })}` : ''}`;
const medida = (f) => Boolean(f && f.estado === 'medido');
const enlace = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : null);

function filaMedida(clave, titulo, valor, extra = {}) { return { clave, titulo, estado: 'medido', valor, motivo: null, ...extra }; }
function filaNoMedida(clave, titulo, motivo) { return { clave, titulo, estado: 'no_medido', valor: null, motivo }; }

/** Cuántos de `hoy` no estaban en `ayer`. */
const nuevos = (hoy, ayer) => { const a = new Set(ayer || []); return (hoy || []).filter((x) => !a.has(x)).length; };

/** Inicio de quien mantiene: qué decidir hoy (AC 17). Una fila por cosa, en este orden. */
function filasInicioMantenedor(m, { ahora = Date.now(), enlaceOperaciones = null, idioma = POR_DEFECTO } = {}) {
  const T = (k, v) => t(idioma, k, v);
  const cf = (f) => conFecha(f, idioma);
  const sinDato = fraseDeCodigo('sin_dato', idioma);
  const filas = [];
  const dep = m.dependencias;
  const rub = medida(dep) && dep.rubros ? dep.rubros : null;
  for (const [k, clave] of [['nuevos', 'dependencias_nuevas'], ['aceptadas_sin_resolver', 'dependencias_aceptadas_sin_resolver'], ['rechazadas_sin_deuda', 'dependencias_rechazadas_sin_deuda']]) {
    const titulo = T(`inicio.${clave}`);
    if (!rub) filas.push(filaNoMedida(clave, titulo, cf(dep)));
    else if (!Number.isFinite(rub[k])) filas.push(filaNoMedida(clave, titulo, sinDato));
    else filas.push(filaMedida(clave, titulo, rub[k], { fecha: dep.fecha }));
  }
  const vig = m.vigilante;
  for (const k of ['pendientes', 'aceptadas_sin_story']) {
    const clave = `vigilante_${k}`;
    const titulo = T(`inicio.${clave}`);
    if (!medida(vig)) filas.push(filaNoMedida(clave, titulo, cf(vig)));
    else if (!Number.isFinite(vig[k])) filas.push(filaNoMedida(clave, titulo, sinDato));
    else filas.push(filaMedida(clave, titulo, vig[k], { fecha: vig.fecha }));
  }
  const prs = m.prs;
  const tPrs = T('inicio.prs_trabados');
  if (!medida(prs)) filas.push(filaNoMedida('prs_trabados', tPrs, cf(prs)));
  else {
    // un PR sin fecha legible no se puede medir: se cuenta aparte, nunca se descarta (como hace la sección del resumen)
    const sinFecha = (prs.lista || []).filter((p) => !Number.isFinite(p.dias)).length;
    filas.push(filaMedida('prs_trabados', tPrs, (prs.lista || []).filter((p) => Number.isFinite(p.dias) && p.dias > 2).length, { fecha: prs.fecha, detalle: sinFecha ? T('inicio.prsSinFecha', { n: sinFecha }) : null }));
  }
  const tCerrados = T('inicio.pedidos_cerrados_con_vivas');
  if (!rub) filas.push(filaNoMedida('pedidos_cerrados_con_vivas', tCerrados, cf(dep)));
  else if (!Number.isFinite(rub.pedidos_cerrados_con_vivas)) filas.push(filaNoMedida('pedidos_cerrados_con_vivas', tCerrados, sinDato));
  else filas.push(filaMedida('pedidos_cerrados_con_vivas', tCerrados, rub.pedidos_cerrados_con_vivas, { fecha: dep.fecha }));
  for (const [clave, f, campo] of [['suites_rojas_nuevas', m.suites, 'rojas'], ['banco_rojos_nuevos', m.banco, 'rojos']]) {
    const titulo = T(`inicio.${clave}`);
    if (!medida(f)) filas.push(filaNoMedida(clave, titulo, cf(f)));
    else if (!f.ayer || !Array.isArray(f.ayer[campo])) filas.push(filaNoMedida(clave, titulo, fraseDeCodigo('sin_ayer', idioma)));
    else filas.push(filaMedida(clave, titulo, nuevos(f[campo], f.ayer[campo]), { fecha: f.fecha }));
  }
  const dec = m.declarados;
  const tDec = T('inicio.declarados_por_vencer');
  if (!medida(dec)) filas.push(filaNoMedida('declarados_por_vencer', tDec, cf(dec)));
  else filas.push(filaMedida('declarados_por_vencer', tDec, (dec.lista || []).filter((d) => { const x = Date.parse(`${d.review_before}T00:00:00Z`); return Number.isFinite(x) && x - ahora <= 7 * DIA; }).length, { fecha: dec.fecha }));
  const tMaq = T('inicio.maquinas_sin_confirmar');
  if (!medida(m.corridas)) filas.push(filaNoMedida('maquinas_sin_confirmar', tMaq, cf(m.corridas)));
  // sin lo que informa cada máquina la cuenta no se sabe (2.28): «no medido», nunca 0
  else if (!Number.isFinite(m.maquinasSinConfirmar)) filas.push(filaNoMedida('maquinas_sin_confirmar', tMaq, T('inicio.maquinasSinInforme')));
  else filas.push(filaMedida('maquinas_sin_confirmar', tMaq, m.maquinasSinConfirmar, { fecha: m.corridas.fecha }));
  filas.push(filaNoMedida('retrospectivas', T('inicio.retrospectivas'), T('inicio.retrospectivasMotivo')));
  // dónde se decide cada cosa (AC 17): lo de las colas y lo declarado, en el repo de operaciones; lo del arnés, en Arnés;
  // los PR, en su lista de abajo, cada uno con su enlace (pueden estar en varios repos y proyectos)
  const DONDE = { dependencias_nuevas: 'ops', dependencias_aceptadas_sin_resolver: 'ops', dependencias_rechazadas_sin_deuda: 'ops', vigilante_pendientes: 'ops', vigilante_aceptadas_sin_story: 'ops', prs_trabados: '#prs-trabados', pedidos_cerrados_con_vivas: 'ops', declarados_por_vencer: 'ops', suites_rojas_nuevas: '/arnes', banco_rojos_nuevos: '/arnes' };
  for (const f of filas) {
    const d = DONDE[f.clave];
    f.enlace = d === 'ops' ? enlaceOperaciones || null : (d || null);
  }
  return filas;
}

/** Inicio de un dev: lo suyo, con cantidades (AC 18). */
function inicioDev(m, { ahora = Date.now(), idioma = POR_DEFECTO } = {}) {
  const c = m.corridas || {};
  const lista = Array.isArray(c.lista) ? c.lista : [];
  const tiempos = lista.map((x) => Date.parse(x.inicio || '')).filter(Number.isFinite);
  const corridas = medida(c)
    ? { estado: 'medido', en7dias: tiempos.filter((x) => x <= ahora && ahora - x <= 7 * DIA).length, ultima: tiempos.length ? new Date(Math.max(...tiempos)).toISOString().slice(0, 10) : null, fecha: c.fecha }
    : { estado: 'no_medido', motivo: conFecha(c, idioma) };
  const lado = (f) => (medida(f) ? { estado: 'medido', fecha: f.fecha, lista: f.lista || [] } : { estado: 'no_medido', motivo: conFecha(f, idioma), lista: [] });
  const proyectos = Array.isArray(m.productos) && m.proyectos && m.proyectos.lista !== null
    ? { estado: 'medido', lista: m.productos.map((p) => p.producto) }
    : { estado: 'no_medido', motivo: fraseDe(m.proyectos, idioma), lista: [] };
  return { corridas, prs: lado(m.prs), pedidos: lado(m.pedidos), proyectos };
}

/** Las filas de Proyectos (AC 19): una por producto, sin sumar dos veces lo compartido. */
function filasProyectos(m, { idioma = POR_DEFECTO } = {}) {
  const T = (k, v) => t(idioma, k, v);
  const productos = Array.isArray(m.productos) ? m.productos : [];
  // las fotos por proyecto se cruzan por el NOMBRE DEL PROYECTO (los productos nombran sus repos de código; las fotos son
  // de los repos de stories); una foto vieja no cuenta como al día
  const snaps = medida(m.proyectos) && Array.isArray(m.proyectos.lista) ? m.proyectos.lista : [];
  const frescasDe = (proyecto) => snaps.filter((s) => s.proyecto === proyecto && !s.vieja);
  const viejasDe = (proyecto) => snaps.filter((s) => s.proyecto === proyecto && s.vieja);
  const cuantos = new Map();
  for (const p of productos) for (const k of p.proyectos || []) cuantos.set(k, (cuantos.get(k) || 0) + 1);
  const dep = m.despliegues;
  const vig = m.vigilante;
  const vigilados = new Set(medida(vig) || (vig && Array.isArray(vig.productos)) ? (vig.productos || []).map((x) => String(x).toLowerCase().replace(/\s+/g, '')) : []);
  const contar = (stories) => {
    const r = { en_curso: 0, en_revision: 0, paradas: 0, sin_medir: 0, bloqueadas: 0 };
    for (const s of stories) {
      if (s.grupo === 'en_curso') {
        r.en_curso += 1;
        if (s.canonico === 'review') r.en_revision += 1;
        if (s.dias_en_estado === null || s.dias_en_estado === undefined || !Number.isFinite(s.dias_en_estado)) r.sin_medir += 1;
        else if (s.dias_en_estado > PARADA_DIAS) r.paradas += 1;
      } else if (s.grupo === 'bloqueado') r.bloqueadas += 1;
    }
    return r;
  };
  /** La paridad de un producto (2.25): sus repos en `por_ruta`, sólo cantidades, estados y motivos de lista cerrada. */
  const par = m.paridad;
  const paridadDe = (p) => {
    if (!medida(par)) return { estado: 'no_medido', texto: par && par.codigo === 'sin_paridad' ? fraseDeCodigo('sin_paridad', idioma) : T('vista.noMedidoCon', { motivo: fraseDe(par, idioma) }) };
    const rutas = new Set(p.rutas || []);
    const suyas = (par.por_ruta || []).filter((x) => rutas.has(x.ruta));
    if (!suyas.length) return { estado: 'sin_medir', texto: T('proyectos.paridadSinRepos') };
    const sinMedir = suyas.filter((x) => x.estado !== 'medido');
    const div = suyas.filter((x) => x.estado === 'medido').reduce((a, x) => a + (Number(x.divergencias) || 0), 0);
    const ven = suyas.filter((x) => x.estado === 'medido').reduce((a, x) => a + (Number(x.vencidas) || 0), 0);
    const motivos = [...new Set(sinMedir.map((x) => fraseDeCodigo(x.motivo, idioma) || x.estado.replace('_', ' ')))].join(', ');
    if (div || ven) {
      const sm = sinMedir.length ? T('proyectos.paridadYSinMedir', { n: sinMedir.length, motivos }) : '';
      return { estado: 'a_decidir', texto: `${T(div === 1 ? 'proyectos.paridadADecidirUna' : 'proyectos.paridadADecidir', { div, ven })}${T(ven === 1 ? 'proyectos.paridadVencidaUna' : 'proyectos.paridadVencidas', { ven })}${sm}` };
    }
    if (sinMedir.length) return { estado: 'sin_medir', texto: T('proyectos.paridadSinMedir', { motivos }) };
    return { estado: 'en_orden', texto: T('proyectos.paridadEnOrden') };
  };
  const filas = productos.map((p) => {
    const frescas = (p.proyectos || []).flatMap(frescasDe);
    const viejas = (p.proyectos || []).flatMap(viejasDe);
    const stories = frescas.flatMap((s) => s.stories || []);
    const compartido = Math.max(1, ...(p.proyectos || []).map((k) => cuantos.get(k) || 1));
    let vivas = null;
    if (m.dependencias && medida(m.dependencias) && m.dependencias.vivas_por_proyecto) vivas = (p.proyectos || []).reduce((a, n) => a + (Number(m.dependencias.vivas_por_proyecto[n]) || 0), 0);
    const d = medida(dep) && dep.productos ? dep.productos[p.producto] : null;
    const masNuevaVieja = viejas.map((s) => s.fecha).filter(Boolean).sort().pop();
    return {
      producto: p.producto,
      medido: frescas.length > 0,
      motivo: frescas.length ? null
        : (viejas.length ? T('proyectos.fotoVieja', { fecha: masNuevaVieja || T('proyectos.sinFecha') })
          : (medida(m.proyectos) ? T('proyectos.sinFoto') : conFecha(m.proyectos, idioma))),
      ...contar(stories),
      compartido: compartido > 1 ? compartido : null,
      despliegues: d ? { estado: d.estado || 'medido', staging: d.staging || null, produccion: d.produccion || null, produccion_atrasada: d.produccion_atrasada ?? null, aprobacion: d.aprobacion || null, main: d.main || null, motivo: d.estado === 'no_medido' ? (fraseDeCodigo(d.motivo, idioma) || T('vista.noMedido')) : null }
        : { estado: 'no_medido', motivo: medida(dep) ? T('proyectos.despliegueSinProducto') : conFecha(dep, idioma) },
      vigilado: medida(vig) || (vig && Array.isArray(vig.productos)) ? vigilados.has(String(p.producto).toLowerCase().replace(/\s+/g, '')) : null,
      vivas,
      paridad: paridadDe(p),
    };
  });
  const unicos = [...new Set(productos.flatMap((p) => p.proyectos || []))];
  const tot = contar(unicos.flatMap(frescasDe).flatMap((s) => s.stories || []));
  return { filas, totales: { en_curso_total: tot.en_curso, paradas_total: tot.paradas, sin_medir_total: tot.sin_medir, bloqueadas_total: tot.bloqueadas } };
}

/** Arnés (AC 20): una línea por pieza. */
function filasArnes(m, { ahora = Date.now(), version = null, ultima = null, idioma = POR_DEFECTO } = {}) {
  const T = (k, v) => t(idioma, k, v);
  const cf = (f) => conFecha(f, idioma);
  const lineas = [];
  for (const s of (m.sources && Array.isArray(m.sources.lista) ? m.sources.lista : [])) {
    lineas.push({ clave: `fuente:${s.id}`, titulo: T('arnes.fuente', { id: nombreDeFuente(s.id, idioma) }), estado: s.estado, texto: s.estado === 'medido' ? T('arnes.alDia', { fecha: s.fecha }) : cf(s) });
  }
  const b = m.banco;
  lineas.push({ clave: 'banco', titulo: T('arnes.banco'), estado: medida(b) ? 'medido' : 'no_medido', texto: medida(b) ? T(Number.isFinite(b.total) ? 'arnes.bancoRojosDe' : 'arnes.bancoRojos', { n: (b.rojos || []).length, total: b.total, fecha: b.fecha }) : cf(b) });
  const s = m.suites;
  lineas.push({ clave: 'suites', titulo: T('arnes.suites'), estado: medida(s) ? 'medido' : 'no_medido', texto: medida(s) ? T('arnes.suitesRojas', { rojas: (s.rojas || []).length, sinMedir: Number(s.sin_medir) || 0, total: s.total }) : cf(s) });
  const e = m.examen;
  lineas.push({ clave: 'examen', titulo: T('arnes.examen'), estado: medida(e) ? 'medido' : 'no_medido', texto: medida(e) ? `${T('arnes.examenFallos', { fecha: e.fecha, n: Number(e.fallos) || 0 })}${e.completo === false ? T('arnes.examenIncompleto') : ''}` : cf(e) });
  const tb = m.tablero;
  const sello = medida(tb) && tb.sello ? tb.sello : null;
  lineas.push({ clave: 'sello', titulo: T('arnes.sello'), estado: sello ? 'medido' : 'no_medido', texto: sello ? `${String(sello.generado || '').slice(0, 10)} · ${T(sello.completo ? 'arnes.completa' : 'arnes.incompleta')}` : cf(tb) });
  lineas.push({ clave: 'version', titulo: T('arnes.version'), estado: version ? 'medido' : 'no_medido', texto: version || T('arnes.sinVersion') });
  // la última publicada: nunca «al día» sin haber mirado
  if (ultima) {
    if (ultima.estado === 'medido') lineas.push({ clave: 'ultima', titulo: T('arnes.ultima'), estado: 'medido', texto: `${ultima.version}${ultima.creada ? ` ${T('vista.delParen', { fecha: String(ultima.creada).slice(0, 10) })}` : ''}` });
    else {
      // el motivo es de la lista cerrada de latest-release.js: se dice en el idioma de la página
      const i = MOTIVOS_ULTIMA.indexOf(ultima.motivo);
      const motivo = i >= 0 ? T(`arnes.motivoUltima${i}`) : ultima.motivo;
      lineas.push({ clave: 'ultima', titulo: T('arnes.ultima'), estado: 'no_medido', texto: ultima.estado === 'no_pudo' ? T('arnes.ultimaNoPudo', { motivo }) : T('arnes.ultimaSinMirar') });
    }
  }
  void ahora;
  return lineas;
}

// ── HTML ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function tile(f, idioma) {
  const T = (k, v) => t(idioma, k, v);
  if (f.estado !== 'medido') return `<div class="tile blind">${chip('blind', T('vista.noMedido'))}<div class="t-label">${esc(f.titulo)}</div><div class="t-val">${esc(T('vista.falta'))}</div><div class="t-den">${esc(f.motivo || T('vista.noMedido'))}</div></div>`;
  const est = f.valor > 0 ? 'warn' : 'ok';
  return `<div class="tile ${est}">${chip(est, T(f.valor > 0 ? 'vista.decidir' : 'vista.nada'))}<div class="t-label">${esc(f.titulo)}</div><div class="t-val">${esc(f.valor)}</div>${f.fecha ? `<div class="t-den">${esc(T('vista.fuenteDel', { fecha: f.fecha }))}</div>` : ''}${f.detalle ? `<div class="t-den">${esc(f.detalle)}</div>` : ''}${f.enlace ? `<div class="t-foot"><a href="${esc(f.enlace)}">${esc(T('vista.dondeSeDecide'))}</a></div>` : ''}</div>`;
}

function banda(texto) { return `<div class="banda">${esc(texto)}</div>`; }

/** ¿La última publicada es mayor que la del sitio? Sólo con las dos versiones con forma de número publicado. */
function hayVersionNueva(ultima, version) {
  if (!ultima || ultima.estado !== 'medido' || !version) return false;
  return compararVersiones(ultima.version, version) === 1;
}

/**
 * El cartel de versión nueva: sólo para quienes mantienen (el servidor no le pasa `ultima` a nadie más),
 * con lo que hay que hacer según el modo. El enlace a la receta sale del repo que declara la imagen (su etiqueta
 * `source`): sin ella, el texto sin enlace. La receta, en la guía del idioma de la página.
 */
function cartelVersionNueva(ctx) {
  if (!ctx || !hayVersionNueva(ctx.ultima, ctx.version)) return '';
  const idioma = idiomaDe(ctx);
  const T = (k, v) => t(idioma, k, v);
  const u = ctx.ultima;
  const que = esc(T('cartel.versionNueva', { nueva: u.version, tuya: ctx.version }));
  if (ctx.modoActualizacion === 'auto') return `<div class="banda">${que}${esc(T('cartel.seInstalaSola'))}</div>`;
  const guia = idioma === 'en' ? 'organization-site.en.md#how-it-keeps-itself-up-to-date' : 'organization-site.md#c%C3%B3mo-se-mantiene-al-d%C3%ADa';
  const receta = u.fuente ? `<a href="${esc(`${u.fuente}/blob/main/guides/${guia}`)}">${esc(T('cartel.laReceta'))}</a>` : esc(T('cartel.laRecetaSinEnlace'));
  return `<div class="banda">${que}${esc(T('cartel.comoSeActualiza'))}${receta}</div>`;
}

/** El selector de tema: lo atiende site.js (sin él, la página queda con el tema del sistema). */
function selectorDeTema(idioma) {
  const T = (k) => esc(t(idioma, k));
  return `<div class="theme" role="group" aria-label="${T('barra.tema')}"><button type="button" data-tema="auto" aria-pressed="true">${T('barra.temaAuto')}</button><button type="button" data-tema="light" aria-pressed="false">${T('barra.temaClaro')}</button><button type="button" data-tema="dark" aria-pressed="false">${T('barra.temaOscuro')}</button></div>`;
}

// el nombre de cada idioma en el selector, escrito en su propio idioma (igual en las dos páginas)
const NOMBRE_DEL_IDIOMA = { es: 'Español', en: 'English' };

/**
 * El selector de idioma: un formulario que postea a /idioma con el elegido y la página a la que
 * volver. Anda sin JavaScript; el actual va marcado con `aria-pressed`.
 */
function selectorDeIdioma(idioma, volver) {
  const botones = IDIOMAS.map((i) => `<button type="submit" name="idioma" value="${i}" lang="${i}" aria-pressed="${i === idioma}">${NOMBRE_DEL_IDIOMA[i]}</button>`).join('');
  return `<form class="idioma" method="post" action="/idioma" aria-label="${esc(t(idioma, 'barra.idioma'))}"><input type="hidden" name="volver" value="${esc(volver || '/')}">${botones}</form>`;
}

/** La ruta a la que vuelve el selector: la de la página, si es una ruta propia. */
function rutaDe(ctx) {
  const u = ctx && ctx.url;
  const r = u && typeof u.pathname === 'string' ? `${u.pathname}${u.search || ''}` : (ctx && typeof ctx.ruta === 'string' ? ctx.ruta : '/');
  return /^\/(?![/\\])/.test(r) ? r : '/';
}

/** El armazón de toda página: el menú al costado (arriba en teléfono) y el encabezado con su bajada (`lede`, opcional). */
function layout(ctx, titulo, cuerpo, lede = null) {
  const idioma = idiomaDe(ctx);
  const T = (k, v) => t(idioma, k, v);
  const quien = ctx && ctx.quien;
  // `ctx.recargar` (segundos): la página se recarga sola (una de carga). Es una etiqueta meta, no un script: la política del
  // sitio no deja scripts en línea
  const recargar = ctx && Number.isInteger(ctx.recargar) && ctx.recargar > 0 ? `<meta http-equiv="refresh" content="${ctx.recargar}">` : '';
  const pest = (ctx && ctx.pestanas) || [];
  const nav = pest.length ? `<nav class="tabs" aria-label="${esc(T('barra.pestanas'))}">${pest.map((p, i) => `<a href="${esc(p.path)}"${ctx.activa === p.id ? ' class="activa" aria-current="page"' : ''}><span class="ix">${String(i + 1).padStart(2, '0')}</span>${esc(p.titulo)}</a>`).join('')}</nav>` : '';
  // la cuenta con la que entró (una persona con varios correos ve cuál usó)
  const cuenta = quien ? quien.correoDeIngreso || quien.email : '';
  const tokSesion = ctx && ctx.sesion && typeof ctx.sesion.tok === 'string' ? ctx.sesion.tok : '';
  const sesion = cuenta ? `<form class="salir" method="post" action="/auth/logout"><span>${esc(cuenta)}</span> <input type="hidden" name="tok" value="${esc(tokSesion)}"> <button type="submit">${esc(T('barra.salir'))}</button></form>` : '';
  const bandas = [
    ctx && ctx.bandaConfig ? banda(T('banda.config', { desde: hora(ctx.bandaConfig.desde, idioma), motivo: ctx.bandaConfig.motivo })) : '',
    ctx && ctx.bandaRefresco ? banda(T('banda.refresco', { desde: hora(ctx.bandaRefresco.desde, idioma), motivo: fraseDeCodigo(ctx.bandaRefresco.estado, idioma) || ctx.bandaRefresco.estado })) : '',
    ctx && ctx.avisoVariable ? banda(T('banda.variable')) : '',
    ctx && ctx.avisoSesiones ? banda(T('banda.sesiones')) : '',
    cartelVersionNueva(ctx),
  ].join('');
  // la barra de arriba: la marca de la organización (su logo, o su nombre), el producto y quién entró
  const m = (ctx && ctx.marca) || {};
  const org = m.logo ? `<img class="logo${m.oscuro === 'keep' ? '' : ' invierte'}" src="/marca/logo" alt="${esc(m.nombre || T('barra.laOrganizacion'))}">` : m.nombre ? `<span class="org">${esc(m.nombre)}</span>` : '';
  const barra = `<header class="barra">${org}${org ? '<span class="sep" aria-hidden="true"></span>' : ''}<span class="producto">${esc(T('barra.producto'))}</span><span class="lema">${esc(T('barra.lema'))}</span><span class="esp"></span>${sesion}</header>`;
  // el pie: la versión que corre, su licencia, sus créditos y de quién es el sitio
  const pie = `<footer class="pie"><span>${esc(T('barra.producto'))}${ctx && ctx.version ? ` v${esc(ctx.version)}` : ''}</span><a href="/licencia">${esc(T('pie.licencia'))}</a><a href="/creditos">${esc(T('pie.creditos'))}</a><span class="esp"></span>${m.nombre ? `<span>© ${esc(m.nombre)}</span>` : ''}</footer>`;
  const pieLateral = `<div class="side-foot"><span class="lab-tema">${esc(T('barra.tema'))}</span>${selectorDeTema(idioma)}<span class="lab-tema">${esc(T('barra.idioma'))}</span>${selectorDeIdioma(idioma, rutaDe(ctx))}</div>`;
  return `<!doctype html><html lang="${idioma}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${recargar}<title>${esc(titulo)} · ${esc(T('barra.lema'))}</title><link rel="stylesheet" href="/static/site.css"><script src="/static/site.js"></script></head><body>${barra}<div class="shell"><aside class="side">${nav}${pieLateral}</aside><main><header class="s-head"><div><h1>${esc(titulo)}</h1>${lede ? `<p>${esc(lede)}</p>` : ''}</div></header>${bandas}${cuerpo}${pie}</main></div></body></html>`;
}

function seccion(titulo, html, aparte = null, id = null) { return `<section class="q"${id ? ` id="${esc(id)}"` : ''}><div class="q-head"><h2>${esc(titulo)}</h2>${aparte ? `<span class="aside">${esc(aparte)}</span>` : ''}</div>${html}</section>`; }

/** La lista de los PR abiertos hace más de 2 días (y los sin fecha), a donde lleva su ficha del Inicio de quien mantiene. */
function prsTrabados(prs, idioma) {
  const T = (k, v) => t(idioma, k, v);
  const titulo = T('inicio.prs_trabados');
  if (!medida(prs)) return seccion(titulo, `<p class="q-note">${esc(conFecha(prs, idioma))}</p>`, null, 'prs-trabados');
  const lista = (prs.lista || []).filter((p) => !Number.isFinite(p.dias) || p.dias > 2).sort((a, b) => (Number.isFinite(b.dias) ? b.dias : -1) - (Number.isFinite(a.dias) ? a.dias : -1));
  const fila = (p) => `<li>${enlace(p.enlace) ? `<a href="${esc(p.enlace)}">#${esc(p.numero)}</a>` : `#${esc(p.numero)}`} · ${esc(p.proyecto)} / ${esc(p.repo)} · ${esc(Number.isFinite(p.dias) ? T('vista.dias', { n: p.dias }) : T('vista.sinFecha'))}</li>`;
  return seccion(titulo, lista.length ? `<ul class="lista">${lista.map(fila).join('')}</ul>` : `<p class="q-note">${esc(T('vista.ninguno'))}</p>`, T('vista.fuenteDel', { fecha: prs.fecha }), 'prs-trabados');
}

function paginaInicio(ctx) {
  const idioma = idiomaDe(ctx);
  const T = (k, v) => t(idioma, k, v);
  const m = ctx.modelo || {};
  if (ctx.quien.rol === 'maintainer') {
    const filas = filasInicioMantenedor(m, { ahora: ctx.ahora, enlaceOperaciones: ctx.enlaceOperaciones, idioma });
    return layout(ctx, T('pestana.inicio'), seccion(T('inicio.queDecidir'), `<div class="grid">${filas.map((f) => tile(f, idioma)).join('')}</div>`, T('inicio.cadaFicha')) + prsTrabados(m.prs, idioma), T('inicio.ledeMantiene'));
  }
  const d = inicioDev(m, { ahora: ctx.ahora, idioma });
  const corridasPestana = (ctx.pestanas || []).some((p) => p.id === 'corridas');
  const filaNo = (titulo, motivo) => `<div class="tile blind">${chip('blind', T('vista.noMedido'))}<div class="t-label">${esc(titulo)}</div><div class="t-den">${esc(motivo)}</div></div>`;
  const corr = d.corridas.estado === 'medido'
    ? `<div class="tile">${chip('', T('inicio.tuyas'))}<div class="t-label">${esc(T('inicio.tusCorridas'))}</div><div class="t-val">${esc(T('inicio.corridasEn7', { n: d.corridas.en7dias }))}</div><div class="t-den">${esc(d.corridas.ultima ? T('inicio.laUltima', { fecha: d.corridas.ultima }) : T('inicio.ningunaTodavia'))}</div>${corridasPestana ? `<div class="t-foot"><a href="/corridas">${esc(T('inicio.verEnCorridas'))}</a></div>` : ''}</div>`
    : filaNo(T('inicio.tusCorridas'), d.corridas.motivo);
  const lista = (items, fmt) => (items.length ? `<ul class="lista">${items.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>` : `<p class="q-note">${esc(T('vista.ninguno'))}</p>`);
  const link = (u, texto) => (enlace(u) ? `<a href="${esc(u)}">${texto}</a>` : texto);
  const prs = d.prs.estado === 'medido'
    ? lista(d.prs.lista, (p) => `${link(p.enlace, `#${esc(p.numero)}`)} · ${esc(p.repo)} · ${esc(T('vista.dias', { n: p.dias }))}`)
    : filaNo(T('inicio.tusPrs'), d.prs.motivo);
  const ped = d.pedidos.estado === 'medido'
    ? lista(d.pedidos.lista, (p) => `${link(p.enlace, `#${esc(p.id)}`)} · ${esc(p.tipo)} · ${esc(p.estado)} · ${esc(T('vista.dias', { n: p.dias }))}${p.dependencias ? ` · <b>${esc(T('inicio.dependencias'))}</b>` : ''}`)
    : filaNo(T('inicio.loAsignado'), d.pedidos.motivo);
  const proy = d.proyectos.estado === 'medido' ? lista(d.proyectos.lista, (p) => esc(p)) : filaNo(T('inicio.tusProyectos'), d.proyectos.motivo);
  return layout(ctx, T('pestana.inicio'), [
    seccion(T('inicio.tusCorridas'), `<div class="grid">${corr}</div>`),
    seccion(T('inicio.tusPrs'), prs),
    seccion(T('inicio.loAsignado'), `${ped}<p class="q-note">${esc(T('inicio.asignadoAtraso'))}</p>`),
    seccion(T('inicio.tusProyectos'), proy),
  ].join(''), T('inicio.ledePersona'));
}

function paginaProyectos(ctx) {
  const idioma = idiomaDe(ctx);
  const T = (k, v) => t(idioma, k, v);
  const titulo = T('pestana.proyectos');
  const m = ctx.modelo || {};
  if (m.proyectos && m.proyectos.lista === null) return layout(ctx, titulo, seccion(titulo, `<p class="q-note">${esc(fraseDe(m.proyectos, idioma))}</p>`));
  // sin repos.json (o ilegible) no se sabe qué productos hay: «no medido», nunca «ningún producto»
  if (m.productosFuente && m.productosFuente.estado === 'no_medido') return layout(ctx, titulo, seccion(titulo, `<p class="q-note">${esc(T('proyectos.sinLista', { motivo: fraseDe(m.productosFuente, idioma) }))}</p>`));
  const { filas, totales } = filasProyectos(m, { idioma });
  const noMedido = (motivo) => esc(T('vista.noMedidoCon', { motivo }));
  const celdaDep = (d) => {
    if (d.estado === 'no_medido') return `<td class="nm" colspan="3">${noMedido(d.motivo)}</td>`;
    const fecha = (x) => (x && x.fecha ? esc(String(x.fecha).slice(0, 10)) : '—');
    const prod = `${fecha(d.produccion)}${d.produccion_atrasada === true ? ` · <b>${esc(T('proyectos.atrasada'))}</b>` : (d.produccion_atrasada === null ? ` · ${esc(T('proyectos.atrasoSinMedir'))}` : '')}`;
    const apr = d.aprobacion && d.aprobacion.estado ? esc(d.aprobacion.estado) : (d.aprobacion ? esc(d.aprobacion) : '—');
    return `<td>${fecha(d.staging)}</td><td>${prod}</td><td>${apr}${d.main === 'roto' ? ` · <b>${esc(T('proyectos.mainRoto'))}</b>` : ''}</td>`;
  };
  const filasHtml = filas.map((f) => `<tr><th scope="row">${esc(f.producto)}${f.compartido ? ` <span class="nota">${esc(T('proyectos.compartido', { n: f.compartido }))}</span>` : ''}</th>${f.medido
    ? `<td>${esc(T('proyectos.enCursoCelda', { n: f.en_curso, revision: f.en_revision }))}</td><td>${esc(T('proyectos.paradasCelda', { paradas: f.paradas, sinMedir: f.sin_medir }))}</td><td>${f.bloqueadas}</td>`
    : `<td class="nm" colspan="3">${noMedido(f.motivo)}</td>`}${celdaDep(f.despliegues)}<td>${esc(f.vigilado === null ? T('vista.noMedido') : T(f.vigilado ? 'vista.si' : 'vista.no'))}</td><td>${f.vivas === null ? esc(T('vista.noMedido')) : esc(f.vivas)}</td><td${f.paridad.estado === 'no_medido' ? ' class="nm"' : ''}>${esc(f.paridad.texto)}</td></tr>`).join('');
  const cab = ['producto', 'enCurso', 'paradas', 'bloqueadas', 'enPrueba', 'enProduccion', 'aprobacion', 'vigilado', 'vivas', 'paridad'].map((k) => `<th>${esc(T(`proyectos.col.${k}`, { dias: PARADA_DIAS }))}</th>`).join('');
  const tabla = `<label class="filtro">${esc(T('proyectos.filtrar'))} <input type="search" data-filtro="proyectos"></label><div class="card tbl-wrap"><table class="tabla" id="proyectos"><thead><tr>${cab}</tr></thead><tbody>${filasHtml}</tbody></table></div>`;
  const pie = `<p class="q-note">${esc(T('proyectos.totales', { enCurso: totales.en_curso_total, paradas: totales.paradas_total, sinMedir: totales.sin_medir_total }))}</p>`;
  return layout(ctx, titulo, seccion(T('proyectos.comoVa'), filas.length ? tabla + pie : `<p class="q-note">${esc(T('proyectos.ninguno'))}</p>`), T('proyectos.lede'));
}

function paginaArnes(ctx) {
  const idioma = idiomaDe(ctx);
  const T = (k, v) => t(idioma, k, v);
  const lineas = filasArnes(ctx.modelo || {}, { ahora: ctx.ahora, version: ctx.version, ultima: ctx.ultima, idioma });
  const li = lineas.map((l) => `<li class="${l.estado === 'medido' ? '' : 'nm'}"><span class="pieza">${esc(l.titulo)}</span><span class="estado">${esc(l.texto)}</span><span class="marca">${l.estado === 'medido' ? `<span class="pill">${esc(T('vista.medido'))}</span>` : `<span class="pill nm">${esc(T('vista.noMedido'))}</span>`}</span></li>`).join('');
  // las fichas del tablero nocturno, por pregunta; sin el modelo de fichas (una prueba que no las pide) no hay nada
  const m = ctx.modelo || {};
  const porPregunta = fichasDelTablero.seccionesDe(m.fichas, 'arnes', idioma).map((s) => seccion(s.titulo, s.html)).join('');
  const ocultas = fichasDelTablero.avisoDeOcultas(m.fichas, idioma);
  // `null`: el sitio todavía no las calculó (el primer refresco); aparecen solas
  const calculando = m.fichas === null ? `<p class="q-note" id="fichas-calculando">${esc(T('fichas.calculando'))}</p>` : '';
  const fichas = calculando + porPregunta + (ocultas ? `<p class="q-note" id="fichas-ocultas">${esc(ocultas)}</p>` : '');
  return layout(ctx, T('pestana.arnes'), seccion(T('arnes.comoEsta'), `<ul class="lista">${li}</ul><a class="enlace-fuerte" href="/arnes/tablero">${esc(T('arnes.enlaceTablero'))}</a>`) + fichas, T('arnes.lede'));
}

/** La página de las seis preguntas, tal cual pero sin nada de afuera ni scripts en línea (AC 20, 23). */
function tableroServido(ctx) {
  const idioma = idiomaDe(ctx);
  const tb = ctx.modelo && ctx.modelo.tablero;
  if (!medida(tb) || typeof tb.html !== 'string') return layout(ctx, t(idioma, 'arnes.sello'), seccion(t(idioma, 'vista.noMedidoTitulo'), `<p class="q-note">${esc(conFecha(tb, idioma))}</p>`));
  // la página de la noche es de afuera del sitio (decisión 10): se sirve como la armó el nocturno
  return tb.html
    .replace(/<link\b[^>]*>/gi, (tag) => (/href\s*=\s*["']?(https?:)?\/\//i.test(tag) ? '' : tag))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (tag) => (/^<script\b[^>]*\bsrc\s*=\s*["']\/(?!\/)/i.test(tag) ? tag : ''))
    // el separador de un atributo puede ser un espacio o una `/` (`<img/src=…>`); el valor, con o sin comillas y con
    // espacios adelante
    .replace(/([\s/](?:src|href)\s*=\s*["']\s*)(https?:)?\/\/[^"']*(["'])/gi, '$1#$3')
    .replace(/([\s/](?:src|href)\s*=\s*)(https?:)?\/\/[^\s>]*/gi, '$1#')
    // ningún <meta http-equiv>, sin mirar su valor: escrito con entidades («&#114;efresh») también redirige
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    // un manejador `on…=` con comillas o sin ellas, pegado con espacio o con `/` (`<img/src=x/onerror=…>`): fuera. La
    // política de contenido ya bloquea los manejadores en línea; esto es la segunda capa.
    .replace(/[\s/]on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/** Lo mismo que Inicio, como datos (para /api/inicio). */
function inicioJson(ctx) {
  const idioma = idiomaDe(ctx);
  if (ctx.quien.rol === 'maintainer') return { rol: 'maintainer', filas: filasInicioMantenedor(ctx.modelo || {}, { ahora: ctx.ahora, enlaceOperaciones: ctx.enlaceOperaciones, idioma }) };
  return { rol: 'person', ...inicioDev(ctx.modelo || {}, { ahora: ctx.ahora, idioma }) };
}

function paginaSimple(titulo, texto, ctx = {}) { return layout(ctx, titulo, `<p class="lede">${esc(texto)}</p>`); }
// la entrada de un proveedor con más de una puerta (la de los invitados del directorio). Sólo direcciones del
// propio sitio: `id` elige la vía
const paginaEntrar = (vias, ctx = {}) => layout(ctx, t(idiomaDe(ctx), 'entrar.titulo'), `<ul class="lista">${vias.map((v) => `<li><a href="/auth/login${v.id ? `?via=${encodeURIComponent(v.id)}` : ''}">${esc(v.texto)}</a></li>`).join('')}</ul>`,
  t(idiomaDe(ctx), 'entrar.lede'));
// un ingreso rechazado, con la frase del proveedor y, si la hay, por dónde seguir (una dirección del propio sitio)
const paginaNoEntro = (pantalla, enlace, ctx = {}) => layout(ctx, t(idiomaDe(ctx), 'noEntro.titulo'), `<p class="lede">${esc(pantalla)}</p>${enlace && /^\/[^/\\]/.test(enlace.href) ? `<p><a href="${esc(enlace.href)}">${esc(enlace.texto)}</a></p>` : ''}`);
// quien pasó el proveedor y no está en la lista del sitio: con qué cuenta entró, a quién
// pedírselo (sin nombrar a nadie: no ve ningún dato) y cómo entrar con otra
const paginaSinRol = (ctx) => {
  const idioma = idiomaDe(ctx);
  const T = (k, v) => t(idioma, k, v);
  const cuenta = ctx.quien ? ctx.quien.correoDeIngreso || ctx.quien.email : '';
  return layout({ quien: ctx.quien, sesion: ctx.sesion, idioma, url: ctx.url }, T('sinRol.titulo'), [
    `<p class="lede">${esc(T('sinRol.entraste', { cuenta }))}</p>`,
    `<p>${esc(T('sinRol.pedile'))}</p>`,
    `<p>${esc(T('sinRol.otraAntes'))}<a href="/auth/login?otra=1">${esc(T('sinRol.otraEnlace'))}</a>${esc(T('sinRol.otraDespues'))}</p>`,
  ].join(''));
};
// la vuelta de Salir: no redirige sola (con una sola puerta, entrar de nuevo sería automático) y ofrece las entradas:
// con más de una puerta (`ctx.vias`), cada puerta en vez de «Entrar de nuevo»
const paginaSaliste = (ctx = {}) => {
  const idioma = idiomaDe(ctx);
  const entradas = Array.isArray(ctx.vias) && ctx.vias.length > 1
    ? ctx.vias.map((v) => `<li><a href="/auth/login${v.id ? `?via=${encodeURIComponent(v.id)}` : ''}">${esc(v.texto)}</a></li>`).join('')
    : `<li><a href="/auth/login">${esc(t(idioma, 'saliste.entrarDeNuevo'))}</a></li>`;
  return layout({ idioma, url: ctx.url }, t(idioma, 'saliste.titulo'), [
    `<p class="lede">${esc(t(idioma, 'saliste.texto'))}</p>`,
    ctx.sinInvalidar ? `<p class="q-note">${esc(t(idioma, 'saliste.sinInvalidar'))}</p>` : '',
    `<ul class="lista">${entradas}<li><a href="/auth/login?otra=1">${esc(t(idioma, 'saliste.otraCuenta'))}</a></li></ul>`,
  ].join(''));
};
const paginaSinMantenedores = (ctx) => layout({ quien: ctx.quien, sesion: ctx.sesion, idioma: idiomaDe(ctx), url: ctx.url }, t(idiomaDe(ctx), 'sinMantenedores.titulo'), `<p class="lede">${esc(t(idiomaDe(ctx), 'sinMantenedores.texto'))}</p>`);
const paginaFrenado = ({ desde, idioma = POR_DEFECTO, url = null }) => layout({ idioma, url }, t(idioma, 'frenado.titulo'), `<p class="lede">${esc(t(idioma, 'frenado.texto', { desde: hora(desde, idioma) }))}</p>`);
// se recarga sola cada 5 segundos hasta que el sitio tenga lo que necesita
const paginaCargando = (ctx = {}) => layout({ ...ctx, recargar: 5 }, t(idiomaDe(ctx), 'cargando.titulo'), `<p class="lede">${esc(t(idiomaDe(ctx), 'cargando.texto'))}</p>`);

module.exports = {
  hora, FRASES, frasesEn, fraseDe, conFecha, filasInicioMantenedor, inicioDev, filasProyectos, filasArnes,
  paginaInicio, paginaProyectos, paginaArnes, tableroServido, inicioJson,
  paginaSimple, paginaEntrar, paginaNoEntro, paginaSinRol, paginaSaliste, paginaSinMantenedores, paginaFrenado, paginaCargando, layout, umbralValido,
  idiomaDe, selectorDeIdioma,
};
