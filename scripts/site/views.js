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
 */
const { esc, chip, umbralValido } = require('../nightly/dashboard/common.js');

const DIA = 86400000;
const PARADA_DIAS = 30;

/** La hora de una marca, en UTC: «AAAA-MM-DD HH:MM UTC». */
function hora(t) {
  const d = new Date(typeof t === 'number' ? t : Date.parse(t || ''));
  return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'sin hora';
}

/** La frase de cada estado de la lista cerrada (AC 14) y de los propios de una fuente. */
const FRASES = {
  sin_red: 'no se pudo leer la fuente: sin red o sin respuesta',
  sin_permiso: 'no se pudo leer la fuente: sin permiso',
  credencial_rechazada: 'la credencial fue rechazada (¿venció?)',
  parcial: 'la fuente se leyó a medias',
  fuente_vieja: 'la fuente es más vieja que su antigüedad máxima',
  sin_configurar: 'esta organización no configuró esta fuente',
  sin_foto: 'no hay foto de esta fuente',
  ilegible: 'la foto de esta fuente no se pudo leer',
  sin_buzon: 'esta organización no configuró un buzón de corridas',
  no_corre_banco: 'esta organización no corre el banco de controles',
  sin_ayer: 'sin la foto de ayer no se puede decir qué es nuevo',
  sin_dato: 'la fuente no publica este dato',
  sin_donde_trabaja: 'todavía no se sabe en qué proyectos trabajás: lo confirma quien mantiene el arnés',
  identidad_sin_asociar: 'no medido: tu identidad en la plataforma no es tu correo de la organización; pedile a quien mantiene que la asocie',
  no_medido_noche: 'la noche no la pudo medir',
  sin_rama: 'el repo de operaciones no tiene la rama main',
  falla_git: 'git falló al leer el repo de operaciones (el motivo está en el registro del sitio)',
  falla_interna: 'el sitio falló al leer las fuentes (el motivo está en el registro del sitio)',
  sin_paridad: 'no medido: la noche no dejó la paridad',
  sin_productos: 'sin productos para comparar',
  paridad_no_medida: 'la paridad no se pudo medir',
  sin_clon: 'sin clon',
  grupo_sin_comparar: 'grupo sin comparar',
  declaracion_incompleta: 'declaración incompleta',
};
const fraseDe = (f) => (f && f.motivo) || (f && f.codigo && FRASES[f.codigo]) || 'no medido';
const conFecha = (f) => `${fraseDe(f)}${f && f.fecha ? ` (fuente del ${f.fecha})` : ''}`;
const medida = (f) => Boolean(f && f.estado === 'medido');
const enlace = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : null);

function filaMedida(clave, titulo, valor, extra = {}) { return { clave, titulo, estado: 'medido', valor, motivo: null, ...extra }; }
function filaNoMedida(clave, titulo, motivo) { return { clave, titulo, estado: 'no_medido', valor: null, motivo }; }

/** Cuántos de `hoy` no estaban en `ayer`. */
const nuevos = (hoy, ayer) => { const a = new Set(ayer || []); return (hoy || []).filter((x) => !a.has(x)).length; };

/** Inicio de quien mantiene: qué decidir hoy (AC 17). Una fila por cosa, en este orden. */
function filasInicioMantenedor(m, { ahora = Date.now(), enlaceOperaciones = null } = {}) {
  const filas = [];
  const dep = m.dependencias;
  const rub = medida(dep) && dep.rubros ? dep.rubros : null;
  for (const [k, t, clave] of [['nuevos', 'Dependencias nuevas', 'dependencias_nuevas'], ['aceptadas_sin_resolver', 'Dependencias aceptadas sin resolver', 'dependencias_aceptadas_sin_resolver'], ['rechazadas_sin_deuda', 'Dependencias rechazadas sin deuda', 'dependencias_rechazadas_sin_deuda']]) {
    if (!rub) filas.push(filaNoMedida(clave, t, conFecha(dep)));
    else if (!Number.isFinite(rub[k])) filas.push(filaNoMedida(clave, t, FRASES.sin_dato));
    else filas.push(filaMedida(clave, t, rub[k], { fecha: dep.fecha }));
  }
  const vig = m.vigilante;
  for (const [k, t] of [['pendientes', 'Vigilante: pendientes'], ['aceptadas_sin_story', 'Vigilante: aceptadas sin story']]) {
    const clave = `vigilante_${k}`;
    if (!medida(vig)) filas.push(filaNoMedida(clave, t, conFecha(vig)));
    else if (!Number.isFinite(vig[k])) filas.push(filaNoMedida(clave, t, FRASES.sin_dato));
    else filas.push(filaMedida(clave, t, vig[k], { fecha: vig.fecha }));
  }
  const prs = m.prs;
  if (!medida(prs)) filas.push(filaNoMedida('prs_trabados', 'Pull requests abiertos hace más de 2 días', conFecha(prs)));
  else {
    // un PR sin fecha legible no se puede medir: se cuenta aparte, nunca se descarta (como hace la sección del resumen)
    const sinFecha = (prs.lista || []).filter((p) => !Number.isFinite(p.dias)).length;
    filas.push(filaMedida('prs_trabados', 'Pull requests abiertos hace más de 2 días', (prs.lista || []).filter((p) => Number.isFinite(p.dias) && p.dias > 2).length, { fecha: prs.fecha, detalle: sinFecha ? `${sinFecha} sin fecha: no se pudo medir su antigüedad` : null }));
  }
  if (!rub) filas.push(filaNoMedida('pedidos_cerrados_con_vivas', 'Pedidos cerrados con la vulnerabilidad viva', conFecha(dep)));
  else if (!Number.isFinite(rub.pedidos_cerrados_con_vivas)) filas.push(filaNoMedida('pedidos_cerrados_con_vivas', 'Pedidos cerrados con la vulnerabilidad viva', FRASES.sin_dato));
  else filas.push(filaMedida('pedidos_cerrados_con_vivas', 'Pedidos cerrados con la vulnerabilidad viva', rub.pedidos_cerrados_con_vivas, { fecha: dep.fecha }));
  for (const [clave, t, f, campo] of [['suites_rojas_nuevas', 'Suites rojas esta noche (nuevas)', m.suites, 'rojas'], ['banco_rojos_nuevos', 'Casos del banco rojos esta noche (nuevos)', m.banco, 'rojos']]) {
    if (!medida(f)) filas.push(filaNoMedida(clave, t, conFecha(f)));
    else if (!f.ayer || !Array.isArray(f.ayer[campo])) filas.push(filaNoMedida(clave, t, FRASES.sin_ayer));
    else filas.push(filaMedida(clave, t, nuevos(f[campo], f.ayer[campo]), { fecha: f.fecha }));
  }
  const dec = m.declarados;
  if (!medida(dec)) filas.push(filaNoMedida('declarados_por_vencer', 'Datos declarados que vencen en 7 días', conFecha(dec)));
  else filas.push(filaMedida('declarados_por_vencer', 'Datos declarados que vencen en 7 días', (dec.lista || []).filter((d) => { const t = Date.parse(`${d.review_before}T00:00:00Z`); return Number.isFinite(t) && t - ahora <= 7 * DIA; }).length, { fecha: dec.fecha }));
  if (!medida(m.corridas)) filas.push(filaNoMedida('maquinas_sin_confirmar', 'Máquinas sin confirmar con corridas', conFecha(m.corridas)));
  else filas.push(filaMedida('maquinas_sin_confirmar', 'Máquinas sin confirmar con corridas', Number.isFinite(m.maquinasSinConfirmar) ? m.maquinasSinConfirmar : 0, { fecha: m.corridas.fecha }));
  filas.push(filaNoMedida('retrospectivas', 'Retrospectivas pendientes', 'no medido: sólo existen en la máquina de quien mergeó'));
  // dónde se decide cada cosa (AC 17): lo de las colas y lo declarado, en el repo de operaciones; lo del arnés, en Arnés
  const DONDE = { dependencias_nuevas: 'ops', dependencias_aceptadas_sin_resolver: 'ops', dependencias_rechazadas_sin_deuda: 'ops', vigilante_pendientes: 'ops', vigilante_aceptadas_sin_story: 'ops', pedidos_cerrados_con_vivas: 'ops', declarados_por_vencer: 'ops', suites_rojas_nuevas: '/arnes', banco_rojos_nuevos: '/arnes' };
  for (const f of filas) {
    const d = DONDE[f.clave];
    f.enlace = d === 'ops' ? enlaceOperaciones || null : (d || null);
  }
  return filas;
}

/** Inicio de un dev: lo suyo, con cantidades (AC 18). */
function inicioDev(m, { ahora = Date.now() } = {}) {
  const c = m.corridas || {};
  const lista = Array.isArray(c.lista) ? c.lista : [];
  const tiempos = lista.map((x) => Date.parse(x.inicio || '')).filter(Number.isFinite);
  const corridas = medida(c)
    ? { estado: 'medido', en7dias: tiempos.filter((t) => t <= ahora && ahora - t <= 7 * DIA).length, ultima: tiempos.length ? new Date(Math.max(...tiempos)).toISOString().slice(0, 10) : null, fecha: c.fecha }
    : { estado: 'no_medido', motivo: conFecha(c) };
  const lado = (f) => (medida(f) ? { estado: 'medido', fecha: f.fecha, lista: f.lista || [] } : { estado: 'no_medido', motivo: conFecha(f), lista: [] });
  const proyectos = Array.isArray(m.productos) && m.proyectos && m.proyectos.lista !== null
    ? { estado: 'medido', lista: m.productos.map((p) => p.producto) }
    : { estado: 'no_medido', motivo: fraseDe(m.proyectos), lista: [] };
  return { corridas, prs: lado(m.prs), pedidos: lado(m.pedidos), proyectos };
}

/** Las filas de Proyectos (AC 19): una por producto, sin sumar dos veces lo compartido. */
function filasProyectos(m) {
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
    if (!medida(par)) return { estado: 'no_medido', texto: par && par.codigo === 'sin_paridad' ? FRASES.sin_paridad : `no medido: ${fraseDe(par)}` };
    const rutas = new Set(p.rutas || []);
    const suyas = (par.por_ruta || []).filter((x) => rutas.has(x.ruta));
    if (!suyas.length) return { estado: 'sin_medir', texto: 'sin medir: la paridad no trae sus repos' };
    const sinMedir = suyas.filter((x) => x.estado !== 'medido');
    const div = suyas.filter((x) => x.estado === 'medido').reduce((a, x) => a + (Number(x.divergencias) || 0), 0);
    const ven = suyas.filter((x) => x.estado === 'medido').reduce((a, x) => a + (Number(x.vencidas) || 0), 0);
    const motivos = [...new Set(sinMedir.map((x) => FRASES[x.motivo] || x.estado.replace('_', ' ')))].join(', ');
    if (div || ven) return { estado: 'a_decidir', texto: `a decidir: ${div} divergencia${div === 1 ? '' : 's'} · ${ven} vencida${ven === 1 ? '' : 's'}${sinMedir.length ? ` · ${sinMedir.length} sin medir (${motivos})` : ''}` };
    if (sinMedir.length) return { estado: 'sin_medir', texto: `sin medir: ${motivos}` };
    return { estado: 'en_orden', texto: 'en orden' };
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
        : (viejas.length ? `la foto de sus proyectos es vieja (del ${masNuevaVieja || 'sin fecha'})`
          : (medida(m.proyectos) ? 'sin foto de sus proyectos' : conFecha(m.proyectos))),
      ...contar(stories),
      compartido: compartido > 1 ? compartido : null,
      despliegues: d ? { estado: d.estado || 'medido', staging: d.staging || null, produccion: d.produccion || null, produccion_atrasada: d.produccion_atrasada ?? null, aprobacion: d.aprobacion || null, main: d.main || null, motivo: d.estado === 'no_medido' ? (FRASES[d.motivo] || 'no medido') : null }
        : { estado: 'no_medido', motivo: medida(dep) ? 'la foto de despliegues no trae este producto' : conFecha(dep) },
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
function filasArnes(m, { ahora = Date.now(), version = null } = {}) {
  const lineas = [];
  for (const s of (m.sources && Array.isArray(m.sources.lista) ? m.sources.lista : [])) {
    lineas.push({ clave: `fuente:${s.id}`, titulo: `Fuente ${s.id}`, estado: s.estado, texto: s.estado === 'medido' ? `al día (del ${s.fecha})` : conFecha(s) });
  }
  const b = m.banco;
  lineas.push({ clave: 'banco', titulo: 'Banco de controles', estado: medida(b) ? 'medido' : 'no_medido', texto: medida(b) ? `${(b.rojos || []).length} casos rojos${Number.isFinite(b.total) ? `, de ${b.total}` : ''} (del ${b.fecha})` : conFecha(b) });
  const s = m.suites;
  lineas.push({ clave: 'suites', titulo: 'Suites de prueba', estado: medida(s) ? 'medido' : 'no_medido', texto: medida(s) ? `${(s.rojas || []).length} rojas · ${Number(s.sin_medir) || 0} sin medir, de ${s.total}` : conFecha(s) });
  const e = m.examen;
  lineas.push({ clave: 'examen', titulo: 'Examen de revisores', estado: medida(e) ? 'medido' : 'no_medido', texto: medida(e) ? `${e.fecha}: ${Number(e.fallos) || 0} fallo(s)${e.completo === false ? ' · incompleto' : ''}` : conFecha(e) });
  const t = m.tablero;
  const sello = medida(t) && t.sello ? t.sello : null;
  lineas.push({ clave: 'sello', titulo: 'La página de las seis preguntas', estado: sello ? 'medido' : 'no_medido', texto: sello ? `${String(sello.generado || '').slice(0, 10)} · ${sello.completo ? 'completa' : 'incompleta'}` : conFecha(t) });
  lineas.push({ clave: 'version', titulo: 'Versión del sitio', estado: version ? 'medido' : 'no_medido', texto: version || 'sin version.json' });
  void ahora;
  return lineas;
}

// ── HTML ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function tile(f) {
  if (f.estado !== 'medido') return `<div class="tile blind">${chip('blind', 'no medido')}<div class="t-label">${esc(f.titulo)}</div><div class="t-val">falta</div><div class="t-den">${esc(f.motivo || 'no medido')}</div></div>`;
  const est = f.valor > 0 ? 'warn' : 'ok';
  return `<div class="tile ${est}">${chip(est, f.valor > 0 ? 'decidir' : 'nada')}<div class="t-label">${esc(f.titulo)}</div><div class="t-val">${esc(f.valor)}</div>${f.fecha ? `<div class="t-den">fuente del ${esc(f.fecha)}</div>` : ''}${f.detalle ? `<div class="t-den">${esc(f.detalle)}</div>` : ''}${f.enlace ? `<div class="t-foot"><a href="${esc(f.enlace)}">dónde se decide</a></div>` : ''}</div>`;
}

function banda(texto) { return `<div class="banda">${esc(texto)}</div>`; }

function layout(ctx, titulo, cuerpo) {
  const quien = ctx && ctx.quien;
  const pest = (ctx && ctx.pestanas) || [];
  const nav = pest.length ? `<nav class="tabs">${pest.map((p) => `<a href="${esc(p.path)}"${ctx.activa === p.id ? ' class="activa" aria-current="page"' : ''}>${esc(p.titulo)}</a>`).join('')}</nav>` : '';
  const sesion = quien && quien.email ? `<form class="salir" method="post" action="/auth/logout"><span>Entraste como ${esc(quien.email)}</span> <button type="submit">Salir</button></form>` : '';
  const bandas = [
    ctx && ctx.bandaConfig ? banda(`la configuración de la organización no se pudo releer desde ${hora(ctx.bandaConfig.desde)}: ${ctx.bandaConfig.motivo}`) : '',
    ctx && ctx.bandaRefresco ? banda(`no se pudo actualizar desde ${hora(ctx.bandaRefresco.desde)}: ${FRASES[ctx.bandaRefresco.estado] || ctx.bandaRefresco.estado}`) : '',
    ctx && ctx.avisoVariable ? banda('la variable de arranque sigue puesta: sacala de la configuración de la instalación (SITE_FIRST_MAINTAINER)') : '',
  ].join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} · Sitio de la organización</title><link rel="stylesheet" href="/static/site.css"><script src="/static/site.js" defer></script></head><body><div class="wrap"><header class="head"><div class="eyebrow">Sitio de la organización</div><h1>${esc(titulo)}</h1>${sesion}${nav}${bandas}</header><main>${cuerpo}</main></div></body></html>`;
}

function seccion(titulo, html) { return `<section class="q"><div class="q-head"><h2>${esc(titulo)}</h2></div>${html}</section>`; }

function paginaInicio(ctx) {
  const m = ctx.modelo || {};
  if (ctx.quien.rol === 'maintainer') {
    const filas = filasInicioMantenedor(m, { ahora: ctx.ahora, enlaceOperaciones: ctx.enlaceOperaciones });
    return layout(ctx, 'Inicio', seccion('Qué decidir hoy', `<div class="grid">${filas.map(tile).join('')}</div>`));
  }
  const d = inicioDev(m, { ahora: ctx.ahora });
  const corridasPestana = (ctx.pestanas || []).some((p) => p.id === 'corridas');
  const filaNo = (titulo, motivo) => `<div class="tile blind">${chip('blind', 'no medido')}<div class="t-label">${esc(titulo)}</div><div class="t-den">${esc(motivo)}</div></div>`;
  const corr = d.corridas.estado === 'medido'
    ? `<div class="tile">${chip('', 'tuyas')}<div class="t-label">Tus corridas</div><div class="t-val">${esc(d.corridas.en7dias)} corridas en 7 días</div><div class="t-den">${d.corridas.ultima ? `la última, el ${esc(d.corridas.ultima)}` : 'ninguna todavía'}</div>${corridasPestana ? '<div class="t-foot"><a href="/corridas">ver en Corridas</a></div>' : ''}</div>`
    : filaNo('Tus corridas', d.corridas.motivo);
  const lista = (items, fmt) => (items.length ? `<ul class="lista">${items.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>` : '<p class="q-note">Ninguno.</p>');
  const link = (u, texto) => (enlace(u) ? `<a href="${esc(u)}">${texto}</a>` : texto);
  const prs = d.prs.estado === 'medido'
    ? lista(d.prs.lista, (p) => `${link(p.enlace, `#${esc(p.numero)}`)} · ${esc(p.repo)} · ${esc(p.dias)} días`)
    : filaNo('Tus pull requests abiertos', d.prs.motivo);
  const ped = d.pedidos.estado === 'medido'
    ? lista(d.pedidos.lista, (p) => `${link(p.enlace, `#${esc(p.id)}`)} · ${esc(p.tipo)} · ${esc(p.estado)} · ${esc(p.dias)} días${p.dependencias ? ' · <b>dependencias</b>' : ''}`)
    : filaNo('Lo que tenés asignado', d.pedidos.motivo);
  const proy = d.proyectos.estado === 'medido' ? lista(d.proyectos.lista, (p) => esc(p)) : filaNo('Tus proyectos', d.proyectos.motivo);
  return layout(ctx, 'Inicio', [
    seccion('Tus corridas', `<div class="grid">${corr}</div>`),
    seccion('Tus pull requests abiertos', prs),
    seccion('Lo que tenés asignado', `${ped}<p class="q-note">Lo asignado se ve con hasta un día de atraso: sale de la foto de cada noche.</p>`),
    seccion('Tus proyectos', proy),
  ].join(''));
}

function paginaProyectos(ctx) {
  const m = ctx.modelo || {};
  if (m.proyectos && m.proyectos.lista === null) return layout(ctx, 'Proyectos', seccion('Proyectos', `<p class="q-note">${esc(fraseDe(m.proyectos))}</p>`));
  // sin repos.json (o ilegible) no se sabe qué productos hay: «no medido», nunca «ningún producto»
  if (m.productosFuente && m.productosFuente.estado === 'no_medido') return layout(ctx, 'Proyectos', seccion('Proyectos', `<p class="q-note">no medido: la lista de productos (repos.json) ${esc(fraseDe(m.productosFuente))}</p>`));
  const { filas, totales } = filasProyectos(m);
  const celdaDep = (d) => {
    if (d.estado === 'no_medido') return `<td class="nm" colspan="3">no medido: ${esc(d.motivo)}</td>`;
    const fecha = (x) => (x && x.fecha ? esc(String(x.fecha).slice(0, 10)) : '—');
    const prod = `${fecha(d.produccion)}${d.produccion_atrasada === true ? ' · <b>atrasada</b>' : (d.produccion_atrasada === null ? ' · atraso sin medir' : '')}`;
    const apr = d.aprobacion && d.aprobacion.estado ? esc(d.aprobacion.estado) : (d.aprobacion ? esc(d.aprobacion) : '—');
    return `<td>${fecha(d.staging)}</td><td>${prod}</td><td>${apr}${d.main === 'roto' ? ' · <b>main roto</b>' : ''}</td>`;
  };
  const filasHtml = filas.map((f) => `<tr><th scope="row">${esc(f.producto)}${f.compartido ? ` <span class="nota">compartido con ${esc(f.compartido)}</span>` : ''}</th>${f.medido
    ? `<td>${f.en_curso} (${f.en_revision} en revisión)</td><td>${f.paradas} paradas · ${f.sin_medir} sin medir</td><td>${f.bloqueadas}</td>`
    : `<td class="nm" colspan="3">no medido: ${esc(f.motivo)}</td>`}${celdaDep(f.despliegues)}<td>${f.vigilado === null ? 'no medido' : (f.vigilado ? 'sí' : 'no')}</td><td>${f.vivas === null ? 'no medido' : esc(f.vivas)}</td><td${f.paridad.estado === 'no_medido' ? ' class="nm"' : ''}>${esc(f.paridad.texto)}</td></tr>`).join('');
  const tabla = `<label class="filtro">Filtrar <input type="search" data-filtro="proyectos"></label><table class="tabla" id="proyectos"><thead><tr><th>Producto</th><th>En curso</th><th>Paradas (más de ${PARADA_DIAS} días)</th><th>Bloqueadas</th><th>Staging</th><th>Producción</th><th>Aprobación</th><th>Vigilado</th><th>Vulnerabilidades vivas</th><th>Paridad</th></tr></thead><tbody>${filasHtml}</tbody></table>`;
  const pie = `<p class="q-note">En total, sin contar dos veces lo compartido: ${totales.en_curso_total} en curso, ${totales.paradas_total} paradas, ${totales.sin_medir_total} sin medir.</p>`;
  return layout(ctx, 'Proyectos', seccion('Cómo va cada producto', filas.length ? tabla + pie : '<p class="q-note">Ningún producto declarado.</p>'));
}

function paginaArnes(ctx) {
  const lineas = filasArnes(ctx.modelo || {}, { ahora: ctx.ahora, version: ctx.version });
  const li = lineas.map((l) => `<li class="${l.estado === 'medido' ? '' : 'nm'}"><b>${esc(l.titulo)}</b>: ${esc(l.texto)}</li>`).join('');
  return layout(ctx, 'Arnés', seccion('Cómo está el arnés', `<ul class="lista">${li}</ul><p><a href="/arnes/tablero">La página de las seis preguntas</a></p>`));
}

/** La página de las seis preguntas, tal cual pero sin nada de afuera ni scripts en línea (AC 20, 23). */
function tableroServido(ctx) {
  const t = ctx.modelo && ctx.modelo.tablero;
  if (!medida(t) || typeof t.html !== 'string') return layout(ctx, 'La página de las seis preguntas', seccion('No medido', `<p class="q-note">${esc(conFecha(t))}</p>`));
  return t.html
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
  if (ctx.quien.rol === 'maintainer') return { rol: 'maintainer', filas: filasInicioMantenedor(ctx.modelo || {}, { ahora: ctx.ahora, enlaceOperaciones: ctx.enlaceOperaciones }) };
  return { rol: 'person', ...inicioDev(ctx.modelo || {}, { ahora: ctx.ahora }) };
}

function paginaSimple(titulo, texto, ctx = {}) { return layout(ctx, titulo, `<p class="lede">${esc(texto)}</p>`); }
const paginaSinRol = (ctx) => layout({ quien: ctx.quien }, 'Bienvenida', '<p class="lede">tu cuenta todavía no está confirmada; pedíselo a quien mantiene el arnés.</p>');
const paginaSinMantenedores = (ctx) => layout({ quien: ctx.quien }, 'Bienvenida', '<p class="lede">este sitio todavía no tiene mantenedores: quien lo instaló tiene que poner SITE_FIRST_MAINTAINER.</p>');
const paginaFrenado = ({ desde }) => layout({}, 'Sitio frenado', `<p class="lede">el sitio está frenado desde ${esc(hora(desde))}: la configuración de la organización no valida; se destraba cuando un refresco la lee bien.</p>`);
const paginaCargando = () => layout({}, 'Cargando', '<p class="lede">cargando las fuentes: probá de nuevo en unos segundos.</p>');

module.exports = {
  hora, FRASES, filasInicioMantenedor, inicioDev, filasProyectos, filasArnes,
  paginaInicio, paginaProyectos, paginaArnes, tableroServido, inicioJson,
  paginaSimple, paginaSinRol, paginaSinMantenedores, paginaFrenado, paginaCargando, layout, umbralValido,
};
