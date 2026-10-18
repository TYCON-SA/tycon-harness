#!/usr/bin/env node
'use strict';
/**
 * daily-summary.js — el resumen diario de quien mantiene el arnés (story 4.3).
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * Las dos colas nocturnas (dependencias a las 04:00 UTC, vigilante a las 08:00) dejan fichas en el
 * repo, y hasta esta pieza nadie volvía a mirar las que ya tenían su pull request mergeado: las
 * aceptadas sin resolver, lo postergado por el tope de ruido, el aceptado sin story. Ninguna salía
 * en el aviso del arranque. Esto arma UN mensaje por día con lo que ya publican las dos noches y lo
 * manda por el canal que declara la organización (`operations.json → notify`), con
 * `scripts/lib/notify.js`: Telegram por el script de siempre, Slack o Teams por su webhook.
 *
 * 🔴 ES UN AVISO, NO UN SEGUIMIENTO (decisión del dev, 2026-09-10). Un mensaje de Telegram no tiene
 * estado, no se asigna y no se cierra: el estado durable es la ficha, lo asignable es el pedido de
 * la 4.4, el agregado es `report`. Telegram es la campana, no la agenda.
 *
 * ── LAS REGLAS ─────────────────────────────────────────────────────────────────────────────────
 * · **LEE, NO MIDE.** Los rubros salen de los snapshots y las fichas que dejan
 *   `nightly-dependencies.js`, `work-items.js` y `vigilante.js`. Si un rubro necesita algo
 *   que el snapshot no trae, sale `null` con el motivo — nunca se agrega al snapshot desde acá.
 * · **UN `0` DONDE NO HUBO FUENTE ES MENTIRA.** «No volvió nada» y «nadie midió» se ven iguales si el
 *   rubro sin fuente sale 0. Siempre `null` + motivo: mecánico cuando la clave no está, o el que se
 *   declara en `summary.json` (`rubros_sin_fuente`) cuando un rubro nace antes que su fuente.
 * · **SE ENTREGA TAMBIÉN LA NOCHE SIN CAMBIOS.** Tres líneas. Si el resumen callara cuando no hay
 *   novedad, «no llegó» y «no había nada» serían el mismo silencio.
 * · **SE COMPARA POR IDENTIDAD, NO POR NÚMERO.** Dos fichas nuevas que reemplazan a dos resueltas son
 *   un cambio aunque el conteo no se mueva. Y al revés: la edad de la ficha más vieja crece sola cada
 *   día — compararla por días haría que nunca hubiera «sin cambios»; se compara QUIÉN es la más vieja.
 * · **UN MENSAJE POR DÍA.** Dependencias lo manda; el vigilante lo EDITA agregando su sección (con el
 *   `message_id` que quedó en el snapshot de dependencias). Si dependencias no entregó, o si editar
 *   borraría lo que ya llegó (no quedó el id, la sección no se puede rearmar), el vigilante manda el
 *   suyo aparte y lo dice en la primera línea.
 * · **LA CONSTANCIA SE ESCRIBE DESPUÉS DEL INTENTO.** `resumen: { canal, message_id, editado,
 *   entregado_el, motivo, rubros, fallos }` (y `nota` si hay algo que decir) se agrega al snapshot recién
 *   cuando el script terminó: un corte a mitad de camino deja el snapshot SIN la clave, que el aviso del
 *   arranque lee como «no consta». La única constancia sin intento es la de un error inesperado del
 *   propio guion, y dice exactamente eso.
 *   El `chat_id` nunca se escribe (el snapshot viaja por git).
 * · **LA ÚNICA SALIDA A LA RED ES `notify.js`.** Este guion no tiene cliente HTTP ni token propio. Sin
 *   `notify` en operations.json no se manda nada: la constancia dice «canal sin configurar».
 * · **EL TEXTO LLEVA SÓLO CANTIDADES Y EL ENLACE.** Ningún nombre de proyecto, repo, paquete,
 *   producto, regla, persona, host ni id: el aviso sale a un servicio de afuera. Un rubro sin medir es `?`
 *   (nunca 0, y sin el motivo: el motivo puede nombrar un repo); los fallos son «fallos: N». El detalle sigue
 *   en el snapshot (`rubros`, `fallos`), en el registro del pipeline y en el sitio. La última línea es la del
 *   sitio: el enlace sólo si pasó la prueba sin sesión de esa mañana (`--site-check`).
 * · El `diagnostico` de un borrador del vigilante no se lee.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 *   node daily-summary.js build    --source dependencies|vigilante --today <YYYY-MM-DD> [--json]
 *   node daily-summary.js deliver  --source dependencies|vigilante --today <YYYY-MM-DD> [--dry-run] [--extra <archivo>]
 *     --extra: la línea de otro paso que va al FINAL del mismo mensaje (los PR abiertos). Sólo se toma su
 *       primera línea, y sólo si es la cantidad («PR abiertos hace más de 2 días: N»)
 *     --operations: el operations.json de donde salen el canal y `site.url` (por defecto, el de la raíz del árbol)
 *     --site-check: el resultado de scripts/site/check-deploy.js --out de esa mañana (sólo dependencias)
 *     [--out <snapshots>] [--pending <fichas>] [--config <repos.json>] [--summary-config <summary.json>]
 *     [--watcher-out <snapshots del vigilante>] [--deps-out <snapshots de dependencias>]
 *   (story 8.9: la fuente `dependencies` es, adentro, la de siempre: snapshots `dependencias-<fecha>.json` y
 *   `fuente: "dependencias"` en el `--json`)
 *
 * SALIDA: 0 hecho · 1 `build` no pudo (sin snapshot de hoy, ilegible) · 2 uso · 3 `deliver` no
 * entregó (el motivo queda en el snapshot y en stderr). El 3 es a propósito: el paso del pipeline
 * lleva `continueOnError`, así que un resumen no entregado deja la corrida naranja, nunca verde.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { proyectoDe, leerFicha, soloRepo } = require('./nightly-dependencies.js');
const NOTIFY = require('../../lib/notify.js');
const OPS = require('../../lib/operations-config.js');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
// repos.json y summary.json viven al lado de este guion desde la tanda F de la story 8.9
const CONFIG_DEPS = path.join(RAIZ, 'scripts', 'nightly', 'dependencies');

const RUBROS = {
  // `pedidos_creados` (2026-09-15): los Bugs que la noche abrió. El primer resumen con pedidos reales
  // no los nombraba — la noticia de la noche no estaba en el mensaje de la noche.
  dependencias: ['nuevos', 'pedidos_creados', 'pedidos_cerrados', 'pedidos_reabiertos', 'vivas_por_proyecto', 'edad_mas_vieja', 'aceptadas_sin_resolver', 'rechazadas_sin_deuda',
    'deuda_con_pedido_abierto', 'postergadas_por_presupuesto', 'proyectos_sin_iteracion',
    // story 4.5: el cruce «pedido cerrado, vulnerabilidad viva» — se LEEN de `cruce`, no se recalculan
    'pedidos_cerrados_con_vivas', 'resueltas_con_pedido_abierto'],
  vigilante: ['nuevos', 'pendientes', 'aceptadas_sin_story', 'no_medido', 'ignoradas_hoy'],
};
const ETIQUETA = {
  nuevos: 'nuevos', pedidos_creados: 'pedidos creados', pedidos_cerrados: 'Bugs cerrados por el arnés', pedidos_reabiertos: 'Bugs reabiertos por el arnés', vivas_por_proyecto: 'vivas', edad_mas_vieja: 'la viva más vieja',
  aceptadas_sin_resolver: 'aceptadas sin resolver', rechazadas_sin_deuda: 'rechazadas sin deuda',
  deuda_con_pedido_abierto: 'deuda con pedido abierto', postergadas_por_presupuesto: 'postergadas por presupuesto',
  proyectos_sin_iteracion: 'proyectos sin iteración', pendientes: 'pendientes',
  aceptadas_sin_story: 'aceptadas sin story', no_medido: 'no medido', ignoradas_hoy: 'ignoradas hoy',
  pedidos_cerrados_con_vivas: 'pedidos cerrados con la vulnerabilidad viva', resueltas_con_pedido_abierto: 'resueltas con pedido abierto',
};
const PREFIJO = { dependencias: 'dependencias', vigilante: 'vigilante' };
const DECIDIR = {
  dependencias: 'Decidir: en el pull request de cada ficha, o node scripts/nightly/dependencies/nightly-dependencies.js report',
  vigilante: 'Decidir: en el pull request de cada hallazgo, o /tycon-vigilante review',
};
// 🔴 Presupuesto FIJO por sección: la de dependencias se manda a las 04:00 y se vuelve a escribir en
// la edición de las 08:00; si su tope dependiera de si después viene el vigilante, el mismo resumen
// saldría recortado distinto en cada momento. 23 + 1 (renglón en blanco) + 1 (aviso de «dependencias no
// entregó») + 15 = 40 líneas; 2.000 + 1.400 + el aviso < 3.500 caracteres (Telegram corta en 4.096).
const TOPE = { dependencias: { lineas: 23, caracteres: 2000 }, vigilante: { lineas: 15, caracteres: 1400 } };
const TOPE_MENSAJE = { lineas: 40, caracteres: 3500 };
const DIA_MS = 86400000;

class NoSePuede extends Error {}

// ── Utilidades ─────────────────────────────────────────────────────────────────────────────────
const hasOwn = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T12:00:00Z`));
function diasEntre(desde, hasta) {
  if (!esFecha(desde) || !esFecha(hasta)) return null;
  return Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / DIA_MS);
}
const menosUnDia = (f) => new Date(Date.parse(`${f}T12:00:00Z`) - DIA_MS).toISOString().slice(0, 10);
function recortar(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
const nulo = (motivo, extra = {}) => ({ valor: null, de: null, motivo, ...extra });
// Orden ORDINAL y no alfabético del idioma: el orden «de diccionario» depende de la máquina (en da_DK «aa»
// va después de «z») y un resumen no puede cambiar según dónde corre (story 4.3, ADV-H).
const cmp = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
const sim = (r) => (r && r.simulado ? ' (simulado)' : '');

/** Los snapshots de una fuente, por fecha ascendente. */
function snapshots(dir, fuente) {
  const re = new RegExp(`^${PREFIJO[fuente]}-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
  let nombres;
  try { nombres = fs.readdirSync(dir); } catch { return []; }
  return nombres.map((n) => (n.match(re) || [])[1]).filter(esFecha).sort();
}
const archivoSnap = (dir, fuente, fecha) => path.join(dir, `${PREFIJO[fuente]}-${fecha}.json`);
function leerSnap(dir, fuente, fecha) {
  return JSON.parse(fs.readFileSync(archivoSnap(dir, fuente, fecha), 'utf8'));
}

/**
 * Las fichas de una cola, por carpeta. `null` si la carpeta raíz no se puede leer: eso es «no medido».
 * Una ficha suelta que no se puede leer NO tumba el resumen entero: queda en `ilegibles` y entra en los
 * fallos con su nombre (story 4.3, pase de fallos silenciosos) — callar el mensaje por un archivo roto
 * sería justo el silencio que esta pieza existe para romper.
 */
function leerFichas(dir) {
  try { fs.readdirSync(dir); } catch { return null; }
  const out = { ilegibles: [] };
  for (const c of ['pending', 'promoted', 'archived']) {
    let nombres = [];
    try { nombres = fs.readdirSync(path.join(dir, c)).filter((n) => n.endsWith('.yaml')).sort(cmp); } catch { nombres = []; }
    out[c] = [];
    for (const n of nombres) {
      try {
        out[c].push({ id: n.replace(/\.yaml$/, ''), f: leerFicha(fs.readFileSync(path.join(dir, c, n), 'utf8')) });
      } catch (e) {
        out.ilegibles.push(`no se pudo leer la ficha ${c}/${n} (${e.code || recortar(e.message, 60)})`);
      }
    }
  }
  return out;
}

/** `story_creada` vacía —ausente, `null`, `~`, `""`— no es una story (el `null` es el vacío de las fichas). */
const tieneValor = (v) => {
  const t = String(v == null ? '' : v).trim();
  return t !== '' && !/^(null|~|""|'')$/i.test(t);
};

/** ¿El resumen de ese snapshot consta como entregado? (el aviso del arranque aplica la misma regla) */
function entregado(r) {
  if (!r || typeof r !== 'object') return false;
  return !!r.entregado_el || (r.message_id !== null && r.message_id !== undefined && !r.motivo);
}

// ── Rubros de dependencias ──────────────────────────────────────────────────────────────────────
function rubrosDependencias({ snap, fichas, cfg, hoy }) {
  const R = {};
  const hallazgos = Array.isArray(snap.hallazgos) ? snap.hallazgos.filter((h) => h && h.id) : [];
  const hall = new Map(hallazgos.map((h) => [h.id, h]));
  const todas = fichas ? [...fichas.pending, ...fichas.promoted, ...fichas.archived] : [];
  const ficha = new Map(todas.map((x) => [x.id, x]));
  const paquete = (id) => (hall.get(id) && hall.get(id).paquete) || (ficha.get(id) && ficha.get(id).f.escalares.paquete) || null;
  const repos = (id) => (hall.get(id) && Array.isArray(hall.get(id).repos) ? hall.get(id).repos
    : ficha.get(id) ? ficha.get(id).f.listas.repos : []);
  const proyectos = (etiquetas) => [...new Set(etiquetas.map((e) => proyectoDe(soloRepo(e), cfg)))].sort();
  const idDe = (x) => (typeof x === 'string' ? x : x && x.id);

  if (!Array.isArray(snap.anunciados_hoy)) R.nuevos = nulo('el snapshot no trae `anunciados_hoy`');
  else {
    const ids = [...new Set([...snap.anunciados_hoy, ...(Array.isArray(snap.reaparecidos_ids) ? snap.reaparecidos_ids : [])].map(idDe).filter(Boolean))];
    R.nuevos = { valor: ids.map((id) => ({ id, paquete: paquete(id), proyectos: proyectos(repos(id)) })), de: hall.size, motivo: null };
  }

  if (!fichas) {
    const m = 'no se pudieron leer las fichas de dependencias';
    R.vivas_por_proyecto = nulo(m); R.edad_mas_vieja = nulo(m); R.aceptadas_sin_resolver = nulo(m);
  } else {
    const vivas = [
      ...fichas.pending.filter((x) => x.f.escalares.veredicto === 'pendiente'),
      ...fichas.promoted.filter((x) => !x.f.escalares.resuelto),
    ];
    const grupos = new Map();
    for (const x of vivas) {
      const ps = proyectos([...x.f.listas.repos, ...x.f.listas.declarada_en]);
      for (const p of (ps.length ? ps : ['(sin proyecto)'])) {
        if (!grupos.has(p)) grupos.set(p, new Set());
        grupos.get(p).add(x.id);
      }
    }
    R.vivas_por_proyecto = {
      valor: [...grupos.keys()].sort().map((p) => ({ proyecto: p, ids: [...grupos.get(p)].sort() })),
      de: vivas.length, motivo: null,
    };

    const conFecha = vivas.filter((x) => esFecha(x.f.escalares.detectado))
      .sort((a, b) => cmp(a.f.escalares.detectado, b.f.escalares.detectado) || cmp(a.id, b.id));
    if (!vivas.length) R.edad_mas_vieja = nulo('no hay fichas vivas');
    else if (!conFecha.length) R.edad_mas_vieja = nulo('ninguna ficha viva trae `detectado:` legible');
    else R.edad_mas_vieja = { valor: diasEntre(conFecha[0].f.escalares.detectado, hoy), de: null, motivo: null, id: conFecha[0].id };

    const aceptadas = fichas.promoted.filter((x) => !x.f.escalares.resuelto);
    R.aceptadas_sin_resolver = {
      valor: aceptadas.map((x) => ({ id: x.id, paquete: x.f.escalares.paquete || null, bloqueada_por: x.f.escalares.bloqueada_por || null })),
      de: fichas.promoted.length, motivo: null,
      bloqueadas: aceptadas.filter((x) => x.f.escalares.bloqueada_por).length,
    };
  }

  // La 4.2 ya calcula esta lista con su regla (`rechazado:` sin deuda declarada en todos sus repos):
  // se LEE, no se recalcula — dos implementaciones de la misma regla se separan solas.
  R.rechazadas_sin_deuda = Array.isArray(snap.rechazadas_sin_deuda_ids)
    ? { valor: snap.rechazadas_sin_deuda_ids.map(idDe).filter(Boolean).map((id) => ({ id, paquete: paquete(id) })), de: null, motivo: null }
    : nulo('el snapshot no trae `rechazadas_sin_deuda_ids`');

  const p = hasOwn(snap, 'pedidos') && snap.pedidos && typeof snap.pedidos === 'object' ? snap.pedidos : null;
  const deLosPedidos = (clave, mapa) => {
    if (!p) return nulo('el snapshot no trae `pedidos`');
    if (!Array.isArray(p[clave])) return nulo(`la sección \`pedidos\` no trae \`${clave}\``, { simulado: !!p.simulado });
    return { valor: p[clave].filter((x) => x && typeof x === 'object').map(mapa), de: null, motivo: null, simulado: !!p.simulado };
  };
  // Creados y adoptados son la misma noticia: un Bug del arnés que desde esta noche tiene su ficha.
  R.pedidos_creados = deLosPedidos('creados', (x) => ({ ficha: x.ficha, proyecto: x.proyecto, id: Number.isInteger(x.id) ? x.id : null, adoptado: false }));
  if (R.pedidos_creados.valor && Array.isArray(p.adoptados)) {
    R.pedidos_creados.valor.push(...p.adoptados.filter((x) => x && typeof x === 'object')
      .map((x) => ({ ficha: x.ficha, proyecto: x.proyecto, id: Number.isInteger(x.id) ? x.id : null, adoptado: true })));
  }
  // Los Bugs que el arnés cerró esta noche (el arreglo llegó a main): la única acción que cambia el estado
  // de un tablero ajeno, así que se nombra — la misma omisión que tenían los creados (2026-09-15).
  R.pedidos_cerrados = deLosPedidos('pagados_avisados', (x) => x);
  if (R.pedidos_cerrados.valor) {
    R.pedidos_cerrados.valor = R.pedidos_cerrados.valor.filter((x) => x.cerrado === true)
      .map((x) => ({ ficha: x.ficha, proyecto: x.proyecto, id: Number.isInteger(x.id) ? x.id : null }));
  }
  R.pedidos_reabiertos = deLosPedidos('reabiertos', (x) => ({ ficha: x.ficha, proyecto: x.proyecto, id: Number.isInteger(x.id) ? x.id : null }));
  R.deuda_con_pedido_abierto = deLosPedidos('deuda_avisada', (x) => ({ ficha: x.ficha, proyecto: x.proyecto, id: x.id == null ? null : x.id, vence: x.vence || null }));

  if (!Array.isArray(snap.postergados_por_presupuesto)) R.postergadas_por_presupuesto = nulo('el snapshot no trae `postergados_por_presupuesto`');
  else {
    const pp = p ? (Array.isArray(p.postergados) ? p.postergados.filter((x) => x && typeof x === 'object').map((x) => ({ ficha: x.ficha, proyectos: Array.isArray(x.proyectos) ? x.proyectos : [] })) : null) : null;
    R.postergadas_por_presupuesto = {
      valor: { hallazgos: snap.postergados_por_presupuesto.map(idDe).filter(Boolean).map((id) => ({ id, paquete: paquete(id) })), pedidos: pp },
      de: hall.size, motivo: null,
      motivo_pedidos: pp ? null : (p ? 'la sección `pedidos` no trae `postergados`' : 'el snapshot no trae `pedidos`'),
      // Sin sección `pedidos` no se sabe el modo: la clave no va (si fuera `false`, `cambioDeModo` diría
      // «encendidos» la noche en que el paso de pedidos no corrió — revisión adversarial, 2026-09-15).
      ...(p ? { simulado: !!p.simulado } : {}),
    };
  }

  R.proyectos_sin_iteracion = deLosPedidos('sin_iteracion', (x) => ({ proyecto: x.proyecto, motivo: x.motivo || null }));

  // 🔴 El cruce (story 4.5). Sin la clave, o con `consultado: false`, los dos rubros son `null` con el
  // motivo: «ningún pedido cerrado con la vulnerabilidad viva» sólo se puede decir habiendo leído el estado.
  const cr = hasOwn(snap, 'cruce') && snap.cruce && typeof snap.cruce === 'object' ? snap.cruce : null;
  const delCruce = (clave, mapa) => {
    if (!cr) return nulo('el snapshot no trae `cruce`');
    if (cr.consultado === false) return nulo(`no se leyó el estado de los pedidos: ${cr.motivo || 'sin motivo escrito'}`);
    if (!Array.isArray(cr[clave])) return nulo(`la sección \`cruce\` no trae \`${clave}\``);
    return { valor: cr[clave].filter((x) => x && typeof x === 'object').map(mapa), de: typeof cr.evaluados === 'number' ? cr.evaluados : null, motivo: null };
  };
  R.pedidos_cerrados_con_vivas = delCruce('cerrados_vivos', (x) => ({ ficha: x.ficha, proyecto: x.proyecto, pedido: x.pedido, clase: x.clase || null }));
  R.resueltas_con_pedido_abierto = delCruce('resueltas_con_pedido_abierto', (x) => ({ ficha: x.ficha, proyecto: x.proyecto, pedido: x.pedido, dias: x.dias }));
  // 🔴 El cruce corre ANTES que el cierre y ve abierto el Bug que esta misma noche se cierra: no se lo cuenta
  // como «resuelta con pedido abierto» (revisión adversarial del cierre).
  if (R.resueltas_con_pedido_abierto.valor && Array.isArray(R.pedidos_cerrados.valor)) {
    const cerradosHoy = new Set(R.pedidos_cerrados.valor.map((x) => `${x.ficha}|${x.proyecto}`));
    R.resueltas_con_pedido_abierto.valor = R.resueltas_con_pedido_abierto.valor.filter((x) => !cerradosHoy.has(`${x.ficha}|${x.proyecto}`));
  }
  return R;
}

// ── Rubros del vigilante ────────────────────────────────────────────────────────────────────────
function rubrosVigilante({ snap, fichas, hoy }) {
  const R = {};
  // 🔴 `nuevos` y `marcados_ignorados` del snapshot son CONTEOS; las listas son `hallazgos` (los nuevos
  // de la noche, con id) e `ignorados_ids` (vigilante.js, al armar el resultado).
  R.nuevos = Array.isArray(snap.hallazgos)
    ? { valor: snap.hallazgos.filter((h) => h && typeof h === 'object').map((h) => ({ id: h.id, producto: h.producto, regla: h.regla, severidad: h.severidad })), de: null, motivo: null }
    : nulo('el snapshot no trae `hallazgos`');

  if (!fichas) {
    const m = 'no se pudieron leer los borradores del vigilante';
    R.pendientes = nulo(m); R.aceptadas_sin_story = nulo(m);
  } else {
    const item = (x) => ({ id: x.id, producto: x.f.escalares.producto || null, regla: x.f.escalares.regla || null, dias: diasEntre(x.f.escalares.fecha, hoy) });
    const pend = fichas.pending.filter((x) => x.f.escalares.veredicto === 'pendiente')
      .sort((a, b) => cmp(a.f.escalares.fecha, b.f.escalares.fecha) || cmp(a.id, b.id));
    const conFecha = pend.filter((x) => esFecha(x.f.escalares.fecha));
    R.pendientes = { valor: pend.map(item), de: null, motivo: null,
      edad_mas_vieja: conFecha.length ? diasEntre(conFecha[0].f.escalares.fecha, hoy) : null,
      id_mas_viejo: conFecha.length ? conFecha[0].id : null };
    const utiles = fichas.promoted.filter((x) => x.f.escalares.veredicto === 'util');
    R.aceptadas_sin_story = { valor: utiles.filter((x) => !tieneValor(x.f.escalares.story_creada)).map(item), de: utiles.length, motivo: null };
  }

  R.no_medido = Array.isArray(snap.no_medido)
    ? { valor: snap.no_medido.map((x) => String(x)), de: null, motivo: null }
    : nulo('el snapshot no trae `no_medido`');
  R.ignoradas_hoy = Array.isArray(snap.ignorados_ids)
    ? { valor: snap.ignorados_ids.map((x) => String(x)), de: null, motivo: null }
    : nulo('el snapshot no trae `ignorados_ids`');
  return R;
}

/** Aplica `rubros_sin_fuente`: lo declarado gana sobre lo medido, con su motivo. */
function aplicarSinFuente(fuente, R, cfgResumen, fallos) {
  const declarados = cfgResumen && cfgResumen.rubros_sin_fuente && typeof cfgResumen.rubros_sin_fuente === 'object'
    ? cfgResumen.rubros_sin_fuente : {};
  for (const [nombre, motivo] of Object.entries(declarados)) {
    if (!RUBROS.dependencias.includes(nombre) && !RUBROS.vigilante.includes(nombre)) {
      fallos.push(`summary.json declara un rubro que no existe: ${nombre}`);
      continue;
    }
    if (RUBROS[fuente].includes(nombre)) R[nombre] = nulo(String(motivo), { sin_fuente: true });
  }
}

// ── Comparación por identidad ──────────────────────────────────────────────────────────────────
// 🔴 `simulado` NO es parte de la identidad (2026-09-15): la noche que se encendieron los pedidos, tres
// rubros en 0 «cambiaron» sólo por esa marca y el mensaje dijo «5 cambios» sin que se moviera nada. El
// paso de simulado a real (o al revés) se dice UNA vez, en su propia línea (`cambioDeModo`).
function identidad(nombre, r) {
  if (!r || typeof r !== 'object' || r.valor === null || r.valor === undefined) return 'null';
  const v = r.valor;
  const orden = (xs) => JSON.stringify([...xs].map(String).sort());
  try {
    switch (nombre) {
      case 'edad_mas_vieja': return `id:${r.id}`;
      case 'vivas_por_proyecto': return orden(v.flatMap((g) => g.ids.map((id) => `${g.proyecto}:${id}`)));
      case 'aceptadas_sin_resolver': return orden(v.map((x) => `${x.id}:${x.bloqueada_por || ''}`));
      case 'deuda_con_pedido_abierto': return orden(v.map((x) => `${x.ficha}:${x.proyecto}`));
      case 'pedidos_creados': case 'pedidos_cerrados': case 'pedidos_reabiertos': return orden(v.map((x) => `${x.ficha}:${x.proyecto}:${x.id}`));
      // La edad de una resuelta con pedido abierto crece sola: se compara QUIÉN está, no hace cuánto.
      case 'pedidos_cerrados_con_vivas': case 'resueltas_con_pedido_abierto': return orden(v.map((x) => `${x.ficha}:${x.proyecto}`));
      case 'proyectos_sin_iteracion': return orden(v.map((x) => x.proyecto));
      case 'postergadas_por_presupuesto':
        return JSON.stringify([JSON.parse(orden(v.hallazgos.map((h) => h.id))),
          v.pedidos === null ? null : JSON.parse(orden(v.pedidos.map((x) => `${x.ficha}:${[...x.proyectos].sort().join('+')}`)))]);
      // El texto de un «no medido» del vigilante trae números que cambian cada noche («129 pedidos con
      // error»): la identidad es QUÉ producto no se pudo medir, no la frase.
      case 'no_medido': return orden(v.map((x) => String(x).split(':')[0].trim()));
      case 'ignoradas_hoy': return orden(v);
      default: return orden(v.map((x) => (x && typeof x === 'object' ? x.id : x)));
    }
  } catch {
    return `forma-inesperada:${JSON.stringify(v)}`;
  }
}

/** ¿El rubro trae un valor medido y vacío? (`null` no es vacío: es «no medido»). */
function vacio(nombre, r) {
  if (!r || typeof r !== 'object' || r.valor === null || r.valor === undefined) return false;
  if (nombre === 'postergadas_por_presupuesto') return r.valor.hallazgos.length === 0 && Array.isArray(r.valor.pedidos) && r.valor.pedidos.length === 0;
  return Array.isArray(r.valor) && r.valor.length === 0;
}

/** Los pedidos pasaron de simulados a reales (`on`), al revés (`off`), o nada (`null`). */
function cambioDeModo(rubros, base) {
  for (const n of Object.keys(rubros || {})) {
    const h = rubros[n];
    const b = base && base[n];
    if (h && b && typeof h.simulado === 'boolean' && typeof b.simulado === 'boolean' && h.simulado !== b.simulado) {
      return h.simulado ? 'off' : 'on';
    }
  }
  return null;
}

/**
 * Contra el último snapshot ANTERIOR de la misma fuente que trae `resumen.rubros`.
 *
 * 🔴 Un rubro que la constancia anterior NO TENÍA (nació después) y hoy viene medido y vacío no es un
 * cambio: va a `empezaron`, que el mensaje dice en una línea. El 2026-09-15 dos rubros nuevos en 0
 * salieron como «cambios (antes no medido)». Si el rubro nuevo trae algo, sí es un cambio.
 */
function comparar(fuente, dir, hoy, rubros) {
  const anteriores = snapshots(dir, fuente).filter((f) => f < hoy).reverse();
  for (const f of anteriores) {
    let s;
    try { s = leerSnap(dir, fuente, f); } catch { continue; }
    if (s && s.resumen && s.resumen.rubros && typeof s.resumen.rubros === 'object') {
      const base = s.resumen.rubros;
      const empezaron = RUBROS[fuente].filter((n) => !hasOwn(base, n) && vacio(n, rubros[n]));
      const cambios = RUBROS[fuente].filter((n) => !empezaron.includes(n) && identidad(n, rubros[n]) !== identidad(n, base[n]));
      return { cambios, cambios_motivo: null, comparado_con: f, base, empezaron, modo: cambioDeModo(rubros, base) };
    }
  }
  return { cambios: null, cambios_motivo: 'sin ayer con qué comparar', comparado_con: null, base: null, empezaron: [], modo: null };
}

// ── Fallos: lo que la noche NO pudo ──────────────────────────────────────────────────────────────
const NOCHES_HACIA_ATRAS = 7;

/**
 * Las noches ANTERIORES cuyo resumen no llegó, desde la última que sí se entregó. Es la garantía del AC 6
 * —«un fallo de entrega queda escrito en el primer resumen que sí llega»—, y tiene tres formas que la
 * primera versión perdía (story 4.3, ADV-A): la noche que no dejó constancia (sin la clave `resumen`: el
 * paso murió o faltó la fecha), la que dejó `resumen: null`, y la CADENA de varias noches seguidas (mirar
 * sólo la inmediata perdía la primera). El aviso del arranque sólo ve el último snapshot, así que sin esto
 * una noche fallida desaparecía de todos lados en cuanto la siguiente entregaba.
 *
 * 🔴 «Sin la clave» cuenta como fallo SÓLO desde la primera noche que dejó constancia: antes de que la
 * pieza existiera ninguna noche la tenía, y eso no es una cadena de fallas.
 */
function fallosDeResumenAnterior(dir, fuente, hoy) {
  const leidos = snapshots(dir, fuente).filter((f) => f < hoy).map((f) => {
    try { return { f, s: leerSnap(dir, fuente, f) }; } catch (e) { return { f, error: e }; }
  });
  const esObjeto = (x) => x.s && typeof x.s === 'object' && !Array.isArray(x.s);
  const primera = leidos.find((x) => esObjeto(x) && hasOwn(x.s, 'resumen'));
  if (!primera) return [];
  const F = [];
  for (const x of leidos.filter((y) => y.f >= primera.f).reverse()) {
    if (x.error || !esObjeto(x)) { F.push(`no se pudo leer el snapshot del ${x.f}${x.error ? `: ${recortar(x.error.message, 120)}` : ''}`); continue; }
    if (!hasOwn(x.s, 'resumen')) { F.push(`el resumen del ${x.f} no consta como entregado (el paso no dejó constancia)`); continue; }
    if (entregado(x.s.resumen)) break;   // hasta la última noche que sí llegó
    F.push(`el resumen del ${x.f} no se entregó: ${recortar((x.s.resumen && x.s.resumen.motivo) || 'sin motivo escrito', 220)}`);
  }
  if (F.length > NOCHES_HACIA_ATRAS) return [...F.slice(0, NOCHES_HACIA_ATRAS), `(+${F.length - NOCHES_HACIA_ATRAS} noche(s) más sin resumen entregado)`];
  return F;
}

function fallosDependencias({ snap, dir, hoy, vigOut }) {
  const F = [];
  for (const x of Array.isArray(snap.no_medidos) ? snap.no_medidos : []) {
    F.push(`no medido: ${(x && (x.ruta || x.repo)) || '(repo sin nombre)'} — ${recortar((x && x.motivo) || 'sin motivo', 160)}`);
  }
  if (snap.corrida_completa === false) F.push('la corrida quedó incompleta');
  F.push(...fallosDeResumenAnterior(dir, 'dependencias', hoy));
  const p = hasOwn(snap, 'pedidos') && snap.pedidos && typeof snap.pedidos === 'object' ? snap.pedidos : null;
  if (p) {
    // Se cuentan PEDIDOS (pares ficha+proyecto), no entradas — la misma cuenta que el aviso de la 4.4.
    const fallidos = (Array.isArray(p.fallidos) ? p.fallidos : []).filter((x) => x && typeof x === 'object');
    const pares = new Set(fallidos.map((x) => `${x.ficha}|${x.proyecto}`));
    if (fallidos.length) F.push(`pedidos: ${pares.size} pedido(s) con fallos — ${fallidos[0].paso}: ${recortar(fallidos[0].motivo, 160)}`);
    const sinDueno = (Array.isArray(p.sin_dueno_unico) ? p.sin_dueno_unico : []).filter((x) => x && typeof x === 'object');
    if (sinDueno.length) F.push(`pedidos: ${sinDueno.length} proyecto(s) sin dueño único — ${sinDueno[0].proyecto}: ${recortar(sinDueno[0].motivo, 120)}`);
  }
  // story 4.5: lo que el cruce no pudo mirar es un fallo de la noche, no un rubro en cero.
  const cr = hasOwn(snap, 'cruce') && snap.cruce && typeof snap.cruce === 'object' ? snap.cruce : null;
  if (cr) {
    const noLeidos = (Array.isArray(cr.no_leidos) ? cr.no_leidos : []).filter((x) => x && typeof x === 'object');
    if (noLeidos.length) F.push(`cruce: ${noLeidos.length} pedido(s) no leído(s) — ${recortar(noLeidos[0].motivo || 'sin motivo', 160)}`);
    const sueltos = (Array.isArray(cr.huerfanos) ? cr.huerfanos : []).filter((x) => x && typeof x === 'object');
    if (sueltos.length) F.push(`cruce: ${sueltos.length} Bug(s) del arnés que ninguna ficha nombra — ${sueltos.slice(0, 3).map((x) => `${x.id} en ${x.proyecto}`).join(', ')}`);
    const sinBuscar = (Array.isArray(cr.huerfanos_no_consultados) ? cr.huerfanos_no_consultados : []).filter((x) => x && typeof x === 'object');
    if (sinBuscar.length) F.push(`cruce: no se pudo buscar Bugs sueltos en ${sinBuscar.length} proyecto(s) — ${sinBuscar[0].proyecto}: ${recortar(sinBuscar[0].motivo || 'sin motivo', 120)}`);
  }
  // La única mención cruzada: el vigilante corre DESPUÉS y no puede hablar de sí mismo a las 04:00.
  const ultimoVig = snapshots(vigOut, 'vigilante').filter((f) => f <= hoy).pop();
  if (ultimoVig) {
    const d = diasEntre(ultimoVig, hoy);
    if (d !== null && d > 1) F.push(`vigilante: último snapshot del ${ultimoVig} (hace ${d} días)`);
  }
  return F;
}

// ── La forma: la ÚNICA función que decide cómo se ve el mensaje ─────────────────────────────────
/**
 * Un rubro en una línea: SÓLO cantidades. Ni ids, ni paquetes, ni proyectos, ni el motivo de un rubro
 * sin medir (puede nombrar un repo): el detalle queda en el snapshot.
 */
// Un número del texto, o «?»: los rubros también se releen del snapshot (la edición del vigilante), y un archivo con otra
// forma no puede meter texto libre en el aviso.
const numero = (x) => (typeof x === 'number' && Number.isFinite(x) ? String(x) : '?');
const largo = (x) => numero(Array.isArray(x) ? x.length : NaN);

function detalle(nombre, r) {
  if (!r || r.valor === null || r.valor === undefined) return `${ETIQUETA[nombre]}: ?`;
  const v = r.valor;
  switch (nombre) {
    case 'vivas_por_proyecto': return `vivas: ${numero(r.de)} en ${largo(v)} proyecto(s)`;
    case 'edad_mas_vieja': return `la viva más vieja: ${numero(v)} día(s)`;
    case 'aceptadas_sin_resolver':
      return `aceptadas sin resolver: ${largo(v)} de ${numero(r.de)}${r.bloqueadas ? ` (${numero(r.bloqueadas)} bloqueada(s))` : ''}`;
    case 'pedidos_creados':
      return r.simulado ? `pedidos que habrían salido (simulado): ${largo(v)}` : `pedidos creados: ${largo(v)}`;
    case 'deuda_con_pedido_abierto': case 'proyectos_sin_iteracion': return `${ETIQUETA[nombre]}: ${largo(v)}${sim(r)}`;
    case 'postergadas_por_presupuesto':
      return `postergadas por presupuesto: ${largo(v && v.hallazgos)} hallazgo(s) · pedidos: ${!v || v.pedidos === null ? '?' : `${largo(v.pedidos)}${sim(r)}`}`;
    case 'pendientes':
      return `pendientes: ${largo(v)}${r.edad_mas_vieja !== null && r.edad_mas_vieja !== undefined ? ` — la más vieja ${numero(r.edad_mas_vieja)} día(s)` : ''}`;
    default: return `${ETIQUETA[nombre] || nombre}: ${largo(v)}`;
  }
}

/** Lo que había antes, corto: el número (o quién), sin la lista. `?` si la forma vieja no se entiende. */
function antes(nombre, r) {
  try {
    const v = r.valor;
    switch (nombre) {
      case 'vivas_por_proyecto': return numero(r.de);
      case 'edad_mas_vieja': return `${numero(v)} día(s)`;
      case 'postergadas_por_presupuesto': return `${largo(v.hallazgos)} hallazgo(s) · pedidos: ${v.pedidos === null ? 'no medido' : largo(v.pedidos)}`;
      default: return largo(v);
    }
  } catch { return '?'; }
}

// 🔴 Un cambio dice qué había antes (2026-09-15): «postergadas: pedidos 0» no decía que ayer había uno
// esperando, que era justo el Bug que salió esa noche.
function detalleCambio(nombre, hoyR, antesR) {
  const hoyNulo = !hoyR || hoyR.valor === null || hoyR.valor === undefined;
  const antesNulo = !antesR || antesR.valor === null || antesR.valor === undefined;
  if (hoyNulo && !antesNulo) return `${ETIQUETA[nombre]}: ? (pasó a no medido)`;
  if (!hoyNulo && !antesR) return detalle(nombre, hoyR);   // el rubro nació después: no hay «antes» que decir
  if (!hoyNulo && antesNulo) return `${detalle(nombre, hoyR)} (antes no medido)`;
  return `${detalle(nombre, hoyR)} (antes ${antes(nombre, antesR)})`;
}

const cuenta = (r, fn, noMedido) => {
  if (!r || r.valor === null || r.valor === undefined) return noMedido;
  try { return numero(fn(r)); } catch { return '?'; }
};

function veredicto(fuente, rubros, cambios, fallos, cuando) {
  const cab = cambios === null ? 'Foto completa'
    : cambios.length ? `${cambios.length} cambio(s) desde ${cuando}` : `Sin cambios desde ${cuando}`;
  const partes = [];
  if (fuente === 'dependencias') {
    partes.push(cab,
      `${cuenta(rubros.vivas_por_proyecto, (r) => r.de, '?')} vivas`,
      `${cuenta(rubros.aceptadas_sin_resolver, (r) => r.valor.length, '?')} aceptadas sin resolver`,
      `${cuenta(rubros.postergadas_por_presupuesto, (r) => r.valor.hallazgos.length, '?')} postergadas`);
  } else {
    const pend = rubros.pendientes;
    partes.push(`🌙 vigilante`, cab,
      `${cuenta(pend, (r) => r.valor.length, '?')} pendientes${pend && pend.edad_mas_vieja != null ? ` (la más vieja ${numero(pend.edad_mas_vieja)} días)` : ''}`,
      `${cuenta(rubros.aceptadas_sin_story, (r) => r.valor.length, '?')} aceptadas sin story`);
    const n = rubros.nuevos && Array.isArray(rubros.nuevos.valor) ? rubros.nuevos.valor.length : 0;
    if (n) partes.push(`${n} nuevo(s)`);
  }
  if (fallos.length) partes.push(`⚠️ ${fallos.length} fallo(s)`);
  return recortar(partes.join(' · '), 120);
}

function componer({ fuente, rubros, cambios, base, fallos, comparadoCon, hoy, empezaron = [], modo = null }) {
  const cuando = comparadoCon === null ? null : comparadoCon === menosUnDia(hoy) ? 'ayer' : `el ${comparadoCon}`;
  const nombres = RUBROS[fuente];
  const L = [veredicto(fuente, rubros, cambios, fallos, cuando)];
  if (cambios === null) {
    L.push('Foto completa (sin ayer con qué comparar):');
    for (const n of nombres) L.push(`• ${detalle(n, rubros[n])}`);
  } else if (cambios.length) {
    L.push(`Cambió desde ${cuando}:`);
    for (const n of cambios) L.push(`• ${detalleCambio(n, rubros[n], base && base[n])}`);
  }
  if (cambios !== null && modo === 'on') L.push(`Pedidos de trabajo: encendidos (${cuando} estaban en simulado).`);
  if (cambios !== null && modo === 'off') L.push(`Pedidos de trabajo: volvieron a simulado (${cuando} estaban encendidos).`);
  if (cambios !== null && empezaron.length) L.push(`Empezó a medirse, sin novedad: ${empezaron.map((n) => ETIQUETA[n]).join(', ')}`);
  // Los fallos NUNCA se resumen como «ok», y el texto sólo los cuenta: cada uno nombra un repo, un
  // proyecto o un motivo libre. El detalle queda en el snapshot y en el registro del pipeline.
  if (fallos.length) L.push(`fallos: ${fallos.length}`);
  if (cambios !== null) {
    const iguales = nombres.length - cambios.length - empezaron.length;
    if (iguales > 0) L.push(`Sigue igual (${iguales} rubros)`);
  }
  L.push(DECIDIR[fuente]);
  return L;
}

/** Recorta un texto ya compuesto a un tope, sin perder la primera línea ni la última. */
function acotar(textoCompleto, tope) {
  let L = textoCompleto.split('\n');
  if (L.length > tope.lineas) {
    const quitar = L.length - tope.lineas + 1;
    L = [...L.slice(0, L.length - 1 - quitar), `(+${quitar} línea(s) recortadas)`, L[L.length - 1]];
  }
  let t = L.join('\n');
  if (t.length > tope.caracteres) {
    L = L.map((l) => recortar(l, 110));
    t = L.join('\n');
    if (t.length > tope.caracteres) t = `${t.slice(0, tope.caracteres - 2)}…`;
  }
  return t;
}

function texto(entrada) {
  return acotar(componer(entrada).join('\n'), TOPE[entrada.fuente]);
}

// ── armar ──────────────────────────────────────────────────────────────────────────────────────
function leerConfig(archivo, nombre, fallos) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) {
    fallos.push(`no se pudo leer ${nombre} (${recortar(e.code || e.message, 80)})`);
    return null;
  }
}

function armar(a) {
  // Sólo para la suite: prueba que un error inesperado llega en UNA línea y con constancia (T14b, T17, T18).
  if (process.env.TYCON_SUMMARY_INJECT_FAILURE === '1') throw new Error('falla inyectada por TYCON_SUMMARY_INJECT_FAILURE');
  const archivo = archivoSnap(a.out, a.fuente, a.hoy);
  if (!fs.existsSync(archivo)) throw new NoSePuede(`no hay snapshot de ${a.fuente} para ${a.hoy} (${archivo})`);
  let snap;
  try { snap = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { throw new NoSePuede(`el snapshot ${archivo} está ilegible: ${e.message}`); }
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) throw new NoSePuede(`el snapshot ${archivo} no es un objeto`);

  const avisosConfig = [];
  const fichas = leerFichas(a.pending);
  let rubros;
  let fallos;
  if (a.fuente === 'dependencias') {
    const cfg = leerConfig(a.config, 'repos.json', avisosConfig);
    const cfgResumen = leerConfig(a.resumenConfig, 'summary.json', avisosConfig);
    rubros = rubrosDependencias({ snap, fichas, cfg, hoy: a.hoy });
    aplicarSinFuente('dependencias', rubros, cfgResumen, avisosConfig);
    fallos = [...fallosDependencias({ snap, dir: a.out, hoy: a.hoy, vigOut: a.vigOut }), ...avisosConfig];
  } else {
    const cfgResumen = leerConfig(a.resumenConfig, 'summary.json', avisosConfig);
    rubros = rubrosVigilante({ snap, fichas, hoy: a.hoy });
    aplicarSinFuente('vigilante', rubros, cfgResumen, avisosConfig);
    fallos = [...fallosDeResumenAnterior(a.out, 'vigilante', a.hoy), ...avisosConfig];
  }
  if (!fichas) fallos.push(`no se pudieron leer las fichas en ${a.pending}`);
  else fallos.push(...fichas.ilegibles);
  const comp = comparar(a.fuente, a.out, a.hoy, rubros);
  const t = texto({ fuente: a.fuente, rubros, cambios: comp.cambios, base: comp.base, fallos, comparadoCon: comp.comparado_con, hoy: a.hoy,
    empezaron: comp.empezaron, modo: comp.modo });
  return { fuente: a.fuente, fecha: a.hoy, rubros, cambios: comp.cambios, cambios_motivo: comp.cambios_motivo,
    comparado_con: comp.comparado_con, empezaron: comp.empezaron, modo_pedidos: comp.modo, fallos, texto: t };
}

/**
 * La sección de dependencias de HOY, reconstruida desde lo que quedó en su snapshot (no se guarda el
 * texto): los rubros y los fallos tal cual se mandaron a las 04:00, y la comparación contra su anterior.
 * Es lo que el vigilante pone arriba de la suya al editar el mensaje.
 */
function dependenciasDeHoy(a) {
  const archivo = archivoSnap(a.depsOut, 'dependencias', a.hoy);
  if (!fs.existsSync(archivo)) return { existe: false };
  let s;
  try { s = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { return { existe: true, ilegible: e.message }; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { existe: true, ilegible: 'no es un objeto' };
  const r = hasOwn(s, 'resumen') && s.resumen && typeof s.resumen === 'object' ? s.resumen : null;
  let seccion = null;
  let sinSeccion = null;
  const rubrosOk = r && r.rubros && typeof r.rubros === 'object'
    && RUBROS.dependencias.every((n) => r.rubros[n] && typeof r.rubros[n] === 'object');
  if (!r) sinSeccion = 'su snapshot no dejó constancia';
  else if (!rubrosOk) sinSeccion = 'su constancia no trae los rubros de hoy';
  else {
    try {
      const c = comparar('dependencias', a.depsOut, a.hoy, r.rubros);
      // 🔴 Los fallos son los que se DIJERON a las 04:00 (guardados en la constancia), no recalculados: los
      // de config o fichas ilegibles no se pueden volver a ver desde acá, y la edición reemplaza el mensaje
      // entero — recalcularlos borraba del teléfono lo que la noche sí había dicho (story 4.3, ADV-D).
      const fallos = Array.isArray(r.fallos) ? r.fallos.map(String)
        : fallosDependencias({ snap: s, dir: a.depsOut, hoy: a.hoy, vigOut: a.out });
      seccion = texto({ fuente: 'dependencias', rubros: r.rubros, cambios: c.cambios, base: c.base, fallos, comparadoCon: c.comparado_con, hoy: a.hoy,
        empezaron: c.empezaron, modo: c.modo });
    } catch (e) {
      sinSeccion = `sus rubros no se pudieron volver a escribir (${recortar(e.message, 80)})`;
    }
  }
  return { existe: true, resumen: r, seccion, sinSeccion };
}

// ── entregar ───────────────────────────────────────────────────────────────────────────────────
// el motivo que vuelve del canal, sin el token del bot ni la dirección del webhook (los tapa notify.js)
const limpiar = (t) => NOTIFY.limpiar(t);

/**
 * La línea del sitio, la última del mensaje: el enlace sólo si el sitio pasó la prueba sin
 * sesión de ESTA mañana. `{ linea, resultado, motivo, hora }`. Sin `site.url`, «sin configurar»; con un operations.json
 * que no se pudo leer, o sin un resultado de hoy que se pueda leer, «no se pudo probar desde el nocturno» (no se sabe si
 * hay sitio: no es «sin configurar»). El motivo de una falla sale del vocabulario cerrado de check-deploy.js: cualquier
 * otro texto se toma como que no se pudo probar (puede traer la dirección). Un aviso del vocabulario de `AVISOS` en una
 * prueba que pasó se suma al final de la línea; uno que no es de la lista se ignora.
 */
function lineaDe({ operations, prueba, hoy }) {
  const ops = OPS.load(operations);
  const noPudo = { linea: 'sitio: no se pudo probar desde el nocturno', resultado: 'no_pudo', motivo: null, hora: null };
  if (!ops.ok) return noPudo;
  const url = ops.data.site && typeof ops.data.site.url === 'string' ? ops.data.site.url : null;
  if (!url) return { linea: 'sitio: sin configurar', resultado: null, motivo: null, hora: null };
  const r = prueba;
  const hora = r && typeof r.hora === 'string' && Number.isFinite(Date.parse(r.hora)) ? new Date(r.hora).toISOString() : null;
  if (!hora || hora.slice(0, 10) !== hoy) return noPudo;
  const cuando = `(probado ${hora.slice(11, 16)} UTC)`;
  const { MOTIVOS, AVISOS } = require('../../site/check-deploy.js');
  if (r.resultado === 'paso') {
    // sólo un aviso del vocabulario cerrado entra a la línea: otro texto puede traer la dirección
    const aviso = Array.isArray(r.avisos) ? AVISOS.find((a) => r.avisos.includes(a)) : null;
    return { linea: `sitio: ${url} ${cuando}${aviso ? ` · aviso: ${aviso}` : ''}`, resultado: 'paso', motivo: null, hora };
  }
  if (r.resultado === 'fallo' && MOTIVOS.includes(r.motivo)) return { linea: `sitio: no pasó la prueba sin sesión (${r.motivo}) ${cuando}`, resultado: 'fallo', motivo: r.motivo, hora };
  return { ...noPudo, hora };
}

/**
 * La línea de la versión del sitio: con el resultado del nocturno que lo mantiene al día (`--site-update`, de
 * scripts/site/deploy/update-site.js). Sólo versiones con forma de número publicado y un motivo de la lista cerrada del
 * actualizador (el comienzo del texto: lo que sigue puede nombrar una dirección y no entra). Sin un resultado de hoy, no
 * inventa: dice que el sitio lo cuenta al entrar.
 */
function lineaVersion({ actualizacion, hoy }) {
  const sinResultado = 'sitio: sin el resultado del nocturno de hoy; el sitio dice al entrar si hay una versión nueva';
  if (actualizacion && actualizacion.ilegible) return 'sitio: el resultado del nocturno de hoy no se pudo leer';
  const r = actualizacion;
  const hora = r && typeof r.hora === 'string' && Number.isFinite(Date.parse(r.hora)) ? new Date(r.hora).toISOString() : null;
  if (!hora || hora.slice(0, 10) !== hoy) return sinResultado;
  const ver = (v) => (typeof v === 'string' && /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(v) ? v : null);
  const desde = ver(r.desde);
  const hacia = ver(r.hacia);
  const { MOTIVOS } = require('../../site/deploy/update-site.js');
  const motivo = typeof r.motivo === 'string' ? MOTIVOS.find((m) => r.motivo.startsWith(m)) || null : null;
  if (r.resultado === 'actualizado' && hacia) return desde ? `sitio: actualizado de ${desde} a ${hacia}` : `sitio: actualizado a ${hacia}`;
  if (r.resultado === 'al_dia' && hacia) return `sitio: al día con la última publicada (${hacia})`;
  if (r.resultado === 'aviso' && hacia) return `sitio: hay una versión nueva, ${hacia}; se actualiza a mano`;
  if (r.resultado === 'pedido' && hacia) return `sitio: pedido de actualización a ${hacia} mandado`;
  if (motivo === 'no se pudo leer stable') return 'sitio: no se pudo mirar la última publicada';
  if (motivo === 'no se pudo leer site.update') return 'sitio: no se pudo leer site.update; revisar operations.json';
  if (motivo === 'no se pudo leer el estado del actualizador') return 'sitio: no se pudo leer el estado del actualizador; no se tocó nada';
  if ((r.resultado === 'vuelto_atras' || r.resultado === 'no_pudo') && hacia) return `sitio: no se pudo actualizar a ${hacia}${desde ? `, sigue en ${desde}` : ''}${motivo ? ` (${motivo})` : ''}`;
  return sinResultado;
}

/** La línea del sitio de dependencias: con el resultado de check-deploy.js de esta mañana (`--site-check`). */
function lineaSitio(a) {
  let prueba = null;
  if (a.siteCheck) { try { prueba = JSON.parse(fs.readFileSync(a.siteCheck, 'utf8')); } catch { prueba = null; } }
  return lineaDe({ operations: a.operations, prueba, hoy: a.hoy });
}

function escribirConstancia(archivo, resumen) {
  const s = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  s.resumen = resumen;
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  fs.renameSync(tmp, archivo);
}

/**
 * La sección que otro paso dejó en un archivo (story 4.6: `open-prs.js`), para el FINAL del mismo mensaje.
 * 🔴 Si el archivo no está o no se puede leer, el mensaje sale igual pero LO DICE: que el paso de los PR haya
 * fallado antes de escribir no puede leerse como «no hay PR trabados». No toca rubros, comparación ni snapshot.
 */
function seccionExtra(archivo) {
  const SIN = 'PR abiertos: ? (no se pudo consultar)';
  let t;
  try { t = fs.readFileSync(archivo, 'utf8'); } catch { return SIN; }
  // sólo la cantidad, con el plazo que se haya pedido (`open-prs.js --days N`) y, si los hay, los PR que no se
  // pudieron medir. Una lista (repos, títulos, autores) no entra al mensaje aunque venga en el archivo.
  const primera = String(t).split('\n')[0].trim();
  return /^PR abiertos hace más de \d+ días: (\d+( \(\+\d+ sin fecha legible\))?|\? \((no se pudo consultar|Azure DevOps apagado|GitHub todavía no se lee)\))$/.test(primera) ? primera : SIN;
}

/**
 * La línea de las retrospectivas, del informe del barrido de la noche (scripts/metrics/retro-sweep.js
 * `--report`). «Latido sin modelo» y «retro con aprendizajes» van por separado: un latido de un segundo no es una
 * retrospectiva. Sólo números, nombres de repo con forma de nombre y shas: nada de texto libre del informe (los motivos
 * pueden nombrar una dirección). Sin informe, lo dice: no es «faltan 0».
 */
function lineaRetros(archivo) {
  let r;
  try { r = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return 'retros: ? (el barrido de la noche no dejó su informe)'; }
  const n = (x) => (Number.isInteger(x) && x >= 0 ? x : null);
  // un nombre de repo: letras (con acentos), números, espacios y . _ - (Azure acepta espacios); nada más pasa al mensaje
  const nombre = (x) => (typeof x === 'string' && /^[\p{L}\p{N}._ -]{1,80}$/u.test(x) && x.trim() === x ? x : '?');
  if (!r || !Array.isArray(r.repos)) return 'retros: ? (el informe del barrido no se pudo leer)';
  const t = { merges: 0, latido: 0, aprendizajes: 0, no_piden: 0 };
  const faltan = [];
  const sinMirar = [];
  for (const x of r.repos) {
    if (!x || x.mirado !== true) { sinMirar.push(nombre(x && x.nombre)); continue; }
    const vals = [n(x.merges), n(x.latido), n(x.aprendizajes)];
    // cada cuenta tiene que estar: una que falta no es «0» (el informe vino incompleto)
    const np = x.no_piden && typeof x.no_piden === 'object' && !Array.isArray(x.no_piden) ? Object.values(x.no_piden).map(n) : null;
    if (vals.includes(null) || !np || np.includes(null) || !Array.isArray(x.faltan)) return 'retros: ? (el informe del barrido no se pudo leer)';
    t.merges += vals[0]; t.latido += vals[1]; t.aprendizajes += vals[2]; t.no_piden += np.reduce((a, b) => a + b, 0);
    for (const f of x.faltan) faltan.push(`${nombre(x.nombre)} ${f && typeof f.sha === 'string' && /^[0-9a-f]{7,40}$/.test(f.sha) ? f.sha.slice(0, 7) : '?'}`);
  }
  const lista = faltan.length ? ` (${faltan.slice(0, 3).join(', ')}${faltan.length > 3 ? ` y ${faltan.length - 3} más` : ''})` : '';
  return `retros: ${t.merges} merges a main · latido sin modelo ${t.latido} · retro con aprendizajes ${t.aprendizajes} · no piden retro ${t.no_piden} · faltan ${faltan.length}${lista}${sinMirar.length ? ` · sin mirar: ${sinMirar.join(', ')}` : ''}`;
}

function entregar(a) {
  let res;
  try { res = armar(a); } catch (e) {
    if (e instanceof NoSePuede) { console.error(`🔴 resumen-diario: ${e.message} — no se entregó nada (no hay dónde dejar constancia)`); return 3; }
    throw e;
  }
  // El canal sale de operations.json → notify. Sin canal no se manda nada, y la constancia lo dice.
  const { canal, motivo: sinCanal } = NOTIFY.canalDe(a.operations);
  let final = res.texto;
  let editarId = null;
  let notaArmado = null;
  let sitio = a.fuente === 'dependencias' ? lineaSitio(a) : null;
  if (a.fuente === 'vigilante') {
    const d = dependenciasDeHoy(a);
    const r = d.resumen;
    const mid = r && r.message_id != null && /^\d+$/.test(String(r.message_id)) ? String(r.message_id) : null;
    const yaLlego = d.existe && !d.ilegible && r && entregado(r);
    // la línea del sitio es la que dejó dependencias esa mañana, tal cual y con su hora: el vigilante no prueba de nuevo
    // la línea del sitio se REARMA con lo que probó dependencias esa mañana (resultado, motivo, hora) y site.url: el
    // vigilante no prueba de nuevo, y tampoco copia el texto guardado (un snapshot cambiado no llega al aviso)
    sitio = lineaDe({ operations: a.operations, prueba: r && r.sitio && typeof r.sitio === 'object' ? r.sitio : null, hoy: a.hoy });
    if (yaLlego && mid && d.seccion && canal === 'telegram') {
      editarId = mid;
      final = `${d.seccion}\n\n${res.texto}`;
    } else if (yaLlego) {
      // 🔴 El resumen de dependencias SÍ llegó: no se dice que no, y no se edita a ciegas. Editar reemplaza el
      // mensaje entero, así que sin su sección rearmada la edición BORRABA lo que el responsable ya había recibido a
      // las 04:00. Esta sección va aparte, diciéndolo. En Slack o Teams no hay edición.
      const porque = canal && canal !== 'telegram' ? `${canal} no edita`
        : !mid ? 'no quedó su message_id para editarlo' : d.sinSeccion || 'no se pudo volver a escribir su sección';
      notaArmado = `la sección del vigilante fue en un mensaje aparte: ${porque}`;
      final = [recortar(`ℹ️ dependencias ya entregó su resumen hoy; el del vigilante va aparte (${porque})`, 200), res.texto].join('\n');
    } else {
      // el motivo de una entrega fallida es texto libre (puede nombrar algo): el mensaje dice sólo cuál de los casos fue
      const motivo = !d.existe ? 'no hay snapshot de dependencias de hoy'
        : d.ilegible ? 'su snapshot de hoy está ilegible'
        : !r ? 'su snapshot de hoy no dejó constancia'
        : 'no se entregó';
      const aviso = `⚠️ dependencias no entregó su resumen hoy: ${motivo}`;
      final = [aviso, ...(d.seccion ? [d.seccion, ''] : []), res.texto].join('\n');
    }
  }
  final = acotar(final, TOPE_MENSAJE);
  if (a.extra !== null) final = `${final}\n\n${seccionExtra(a.extra)}`;
  if (a.retros !== null) final = `${final}\n${lineaRetros(a.retros)}`;
  // la versión del sitio, en su lugar fijo: antes de la línea del sitio, que sigue siendo la última
  if (a.siteUpdate) {
    let actualizacion = null;
    try { actualizacion = JSON.parse(fs.readFileSync(a.siteUpdate, 'utf8')); }
    catch (e) {
      actualizacion = null;
      // ausente es «sin resultado»; uno que está y no se lee se dice aparte (no es lo mismo que un nocturno que no corrió)
      if (!(e && e.code === 'ENOENT')) { console.error(`resumen-diario: el resultado del nocturno del sitio no se pudo leer (${(e && e.code) || 'no es JSON'})`); actualizacion = { ilegible: true }; }
    }
    final = `${final}\n${lineaVersion({ actualizacion, hoy: a.hoy })}`;
  }
  final = `${final}\n${sitio.linea}`;

  if (a.dryRun) {
    console.log(final);
    if (!canal) { console.error(`🔴 resumen-diario: ${sinCanal} (ensayo: no se mandó nada)`); return 3; }
    const e = NOTIFY.ensayo({ canal, texto: final, editarId });
    if (e.salida) console.log(`— ${e.salida} (ensayo: no se mandó nada ni se escribió el snapshot)`);
    if (e.codigo !== 0) { console.error(limpiar(e.error)); return 3; }
    return 0;
  }

  const intento = canal ? NOTIFY.entregar({ canal, texto: final, editarId })
    : { canal: null, entregado: false, message_id: null, editado: false, motivo: sinCanal, nota: null };
  const resumen = {
    canal: intento.canal,
    message_id: intento.message_id,
    editado: a.fuente === 'vigilante' ? intento.editado : null,
    entregado_el: intento.entregado ? new Date().toISOString() : null,
    motivo: intento.entregado ? null : limpiar(intento.motivo),
    rubros: res.rubros,
    fallos: res.fallos,
    sitio: { linea: sitio.linea, resultado: sitio.resultado, motivo: sitio.motivo, hora: sitio.hora },
  };
  const nota = [notaArmado, intento.nota].filter(Boolean).join(' · ');
  if (nota) resumen.nota = nota;
  try {
    escribirConstancia(archivoSnap(a.out, a.fuente, a.hoy), resumen);
  } catch (e) {
    console.error(`🔴 resumen-diario: ${intento.entregado ? 'el resumen SE ENTREGÓ pero' : 'el resumen no se entregó y'} no se pudo dejar constancia en el snapshot: ${e.message}`);
    return 3;
  }
  if (intento.entregado) {
    console.log(`✅ resumen de ${a.fuente} ${a.hoy} entregado por ${intento.canal} (${intento.editado ? 'editado' : 'mensaje nuevo'}${intento.message_id !== null ? `, message_id ${intento.message_id}` : ''})${intento.nota ? ` — ${intento.nota}` : ''}`);
    return 0;
  }
  console.error(`🔴 resumen de ${a.fuente} ${a.hoy} NO se entregó: ${limpiar(intento.motivo)}`);
  return 3;
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { cmd: argv[0], fuente: null, hoy: null, out: null, pending: null, config: null, resumenConfig: null,
    vigOut: null, depsOut: null, extra: null, retros: null, operations: null, siteCheck: null, siteUpdate: null, json: false, dryRun: false, ayuda: false, error: null };
  const valor = (i) => { if (i >= argv.length || String(argv[i]).startsWith('--')) { a.error = `falta el valor de ${argv[i - 1]}`; return null; } return argv[i]; };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--source') a.fuente = valor(++i);
    else if (v === '--today') a.hoy = valor(++i);
    else if (v === '--out') a.out = valor(++i);
    else if (v === '--pending') a.pending = valor(++i);
    else if (v === '--config') a.config = valor(++i);
    else if (v === '--summary-config') a.resumenConfig = valor(++i);
    else if (v === '--watcher-out') a.vigOut = valor(++i);
    else if (v === '--deps-out') a.depsOut = valor(++i);
    else if (v === '--extra') a.extra = valor(++i);
    else if (v === '--retros') a.retros = valor(++i);
    else if (v === '--operations') a.operations = valor(++i);
    else if (v === '--site-check') a.siteCheck = valor(++i);
    else if (v === '--site-update') a.siteUpdate = valor(++i);
    else if (v === '--json') a.json = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '-h' || v === '--help') a.ayuda = true;
    else a.error = `opción desconocida: ${v}`;
  }
  return a;
}

function uso() {
  console.error('uso: daily-summary.js build|deliver --source dependencies|vigilante --today <YYYY-MM-DD> [--json] [--dry-run]\n' +
    '       [--out <dir>] [--pending <dir>] [--config <repos.json>] [--summary-config <summary.json>] [--watcher-out <dir>] [--deps-out <dir>] [--extra <archivo>] [--retros <informe de retro-sweep.js>]\n' +
    '       [--operations <operations.json>] [--site-check <resultado de check-deploy.js>] [--site-update <resultado de update-site.js>]');
}

// El nombre de la fuente en la línea de comandos (story 8.9, en inglés) → el de adentro, que no cambia: nombra los
// snapshots (`dependencias-<fecha>.json`) y es el valor de `fuente` en el `--json` y en las constancias.
const FUENTE_DE_LA_OPCION = { dependencies: 'dependencias', vigilante: 'vigilante' };

/**
 * Un error que nadie previó no puede llegar a Azure como un stack de Node: el paso del pipeline muestra la
 * ÚLTIMA línea de stderr como motivo, y la última línea de un stack es un «at …» (story 4.3, pase de
 * fallos silenciosos). Sale en UNA línea, y `deliver` deja la constancia con ese motivo si puede, para que
 * el arranque diga por qué y no sólo «NO consta».
 */
function falloInesperado(a, e) {
  const msg = recortar((e && e.message) || String(e), 200);
  if (a.cmd === 'deliver' && a.out && esFecha(a.hoy) && PREFIJO[a.fuente]) {
    try {
      escribirConstancia(archivoSnap(a.out, a.fuente, a.hoy), {
        canal: a.operations ? NOTIFY.canalDe(a.operations).canal : null, message_id: null, editado: a.fuente === 'vigilante' ? false : null, entregado_el: null,
        motivo: `error inesperado del guion: ${msg}`, rubros: null, fallos: [],
      });
    } catch { /* sin snapshot legible no hay dónde dejarla: la línea de abajo igual lo dice */ }
    console.error(`🔴 resumen de ${a.fuente} ${a.hoy} NO se entregó: error inesperado del guion: ${msg}`);
    return 3;
  }
  console.error(`🔴 resumen-diario: error inesperado del guion: ${msg}`);
  return 1;
}

function main(argv) {
  const a = parseArgs(argv);
  if (a.ayuda) { uso(); return 0; }
  if (a.error || !['build', 'deliver'].includes(a.cmd) || !hasOwn(FUENTE_DE_LA_OPCION, a.fuente) || !esFecha(a.hoy)) {
    if (a.error) console.error(a.error);
    else if (!esFecha(a.hoy)) console.error(`--today tiene que ser una fecha YYYY-MM-DD, no «${a.hoy}»`);
    uso();
    return 2;
  }
  a.fuente = FUENTE_DE_LA_OPCION[a.fuente];
  // el canal y la dirección del sitio, del operations.json de la raíz del árbol (como work-items.js)
  a.operations = a.operations || path.join(RAIZ, 'operations.json');
  if (a.fuente === 'dependencias') {
    a.out = a.out || path.join(RAIZ, '.dashboard', 'dependencias');
    a.pending = a.pending || path.join(RAIZ, 'inbox', 'dependencies');
    a.config = a.config || path.join(CONFIG_DEPS, 'repos.json');
    a.resumenConfig = a.resumenConfig || path.join(CONFIG_DEPS, 'summary.json');
    a.vigOut = a.vigOut || path.join(RAIZ, '.dashboard', 'vigilante');
  } else {
    a.out = a.out || path.join(RAIZ, '.dashboard', 'vigilante');
    a.pending = a.pending || path.join(RAIZ, 'inbox', 'watcher');
    a.depsOut = a.depsOut || path.join(RAIZ, '.dashboard', 'dependencias');
    a.resumenConfig = a.resumenConfig || path.join(CONFIG_DEPS, 'summary.json');
  }
  if (a.cmd === 'build') {
    try {
      const r = armar(a);
      console.log(a.json ? JSON.stringify(r, null, 2) : r.texto);
      return 0;
    } catch (e) {
      if (e instanceof NoSePuede) { console.error(`🔴 resumen-diario: ${e.message}`); return 1; }
      return falloInesperado(a, e);
    }
  }
  try { return entregar(a); } catch (e) { return falloInesperado(a, e); }
}

if (require.main === module) {
  let codigo;
  // story 8.9: los nombres viejos (subcomandos, opciones y el valor de la fuente) siguen andando hasta el retiro
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/dependencies/daily-summary.js', { exitCode: 2 });
  try { codigo = main(process.argv.slice(2)); } catch (e) { console.error(`🔴 resumen-diario: error inesperado del guion: ${recortar((e && e.message) || String(e), 200)}`); codigo = 1; }
  process.exit(codigo);
}
module.exports = { armar, texto, identidad, entregado, comparar, rubrosDependencias, rubrosVigilante, parseArgs, TOPE, TOPE_MENSAJE };
