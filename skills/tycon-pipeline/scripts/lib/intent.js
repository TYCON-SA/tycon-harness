'use strict';
/**
 * lib/intent.js — el único lector de intenciones.
 *
 * Una intención dice qué se quiere resolver y por qué, sin el cómo, antes de la historia. Es un archivo IntentSpec 1.2
 * (frontmatter `id`, `status`, `objective`, `outcomes`; el esquema oficial, copiado sin cambios, vive en
 * scripts/lib/vendor/intent-spec/) con dos secciones propias que IntentSpec no lee: las preguntas abiertas (lo que no se
 * sabe) y las decisiones reservadas (lo que decide una persona). Vive al lado de su historia (`<historia>.intent.md`) o
 * en la carpeta de una corrida (`intent.md`).
 *
 * `readIntent(texto, { raiz, constancia })` devuelve
 *   { frontmatter, modelo, preguntas, reservadas, entrevista, marcas, bloqueantes, problemas, avisos }
 *   - `frontmatter`: lo escrito arriba; `modelo`: el objeto que IntentSpec valida (frontmatter más las secciones del
 *     cuerpo que reconoce, con su regla de precedencia, §2 de su especificación).
 *   - `preguntas` / `reservadas`: una fila por renglón, cada celda por el nombre de su columna, más `linea`.
 *   - `problemas` / `avisos`: `{ fila, columna, linea, mensaje }` (fila y columna nulas cuando no aplican).
 *   - `bloqueantes`: `{ id, motivo }`; `id` es la fila, o el nombre de la sección si el problema es de la sección.
 *
 * Qué bloquea: una pregunta con `Bloquea: sí` deja de bloquear sólo `encontrada` con `repo:<archivo:línea>` que existe
 * bajo `raiz`, o `contestada`/`descartada` con `persona:<nombre>`; una decisión reservada bloquea siempre, salvo
 * `tomada`/`descartada` con `persona:<nombre>`. `constancia({ seccion, fila })` es la consulta de la constancia de la
 * persona: sólo la pasan quien aprueba y los frenos de la máquina. Sin ella, una fila cerrada por `persona:` se toma
 * por su forma (la intención aprobada en una máquina no vuelve a bloquear en otra); con ella, una fila sin constancia
 * bloquea con «falta la constancia». Un problema de forma bloquea siempre, sea cual sea su `Bloquea`: lo que no se
 * puede leer no se da por resuelto. Nada se normaliza: `Si` no es `sí`.
 *
 * Puro y determinista: sin reloj ni red. La única lectura de disco es la de `raiz` para comprobar las fuentes `repo:`.
 */
const fs = require('fs');
const path = require('path');
const { TITLE_WORDS } = require('./story-checks.js');

// Hasta esta fecha una historia vieja sin intención recibe un aviso; desde ese día, frena.
const INTENT_NOTICE_UNTIL = '2026-12-15';

const SCHEMA_PATH = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'vendor', 'intent-spec', 'schema.json');

const QUESTION_COLUMNS = ['#', 'Pregunta', 'Por qué importa', 'Quién contesta', 'Bloquea', 'Estado', 'Respuesta', 'Fuente'];
const RESERVED_COLUMNS = ['#', 'Decisión', 'Por qué es de una persona', 'Quién decide', 'Propuesta del agente', 'Estado', 'Respuesta', 'Fuente'];

// Los vocabularios cerrados, como los escribe story-format.md (la prueba de las guías los compara).
const VOCABULARIES = {
  bloquea: ['sí', 'no'],
  estadoPregunta: ['abierta', 'supuesta', 'encontrada', 'contestada', 'descartada'],
  fuentePregunta: ['persona:<nombre>', 'repo:<archivo:línea>', 'memoria:<id>', 'pedido:<número>', '—'],
  estadoReservada: ['abierta', 'tomada', 'descartada'],
  fuenteReservada: ['persona:<nombre>', '—'],
};
const FUENTES = {
  persona: /^persona:\S.*$/,
  repo: /^repo:(.+):(\d+)$/,
  memoria: /^memoria:\S+$/,
  pedido: /^pedido:\d+$/,
  ninguna: /^—$/,
};
const tipoDeFuente = (f) => Object.keys(FUENTES).find((k) => FUENTES[k].test(f)) || null;

const ENTREVISTA = /^Entrevista: nivel (bajo|normal|alto), corrida (\S+)$/;
const NINGUNA = /^Ninguna\.$/;
const NINGUNA_PORQUE = /^Ninguna, porque (.*)\.$/;
const MARCA = /\[falta: ([QR]\d+)\]/g;

/** ¿Es una intención? `*.intent.md`, o el `intent.md` de una carpeta de corrida (`pipeline-runs/`). */
function isIntentFile(p) {
  const norm = String(p).split(path.sep).join('/');
  const base = norm.split('/').pop();
  return base.endsWith('.intent.md') || (base === 'intent.md' && norm.includes('/pipeline-runs/'));
}

// ── El frontmatter: un lector YAML chico, sólo de lo que IntentSpec usa ─────────────────────────────────────────────
// Escalares (con o sin comillas), `[]` y listas en línea de textos, listas de textos, listas de objetos de un nivel y
// un objeto de un nivel (`scope`). Lo que no sabe leer lo dice: nunca adivina.

// Los escapes de las comillas dobles: los de JSON, que son los que escribe JSON.stringify (y un subconjunto de YAML).
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function escalar(v) {
  const s = v.trim();
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(s);
    if (!m) throw new Error(`comillas sin cerrar: ${s}`);
    return m[1].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e) => {
      if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
      if (Object.prototype.hasOwnProperty.call(ESCAPES, e)) return ESCAPES[e];
      throw new Error(`escape que no sé leer: \\${e}`);
    });
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(s);
    if (!m) throw new Error(`comillas sin cerrar: ${s}`);
    return m[1].replace(/''/g, "'");
  }
  const sinComentario = s.replace(/\s+#.*$/, '');
  if (sinComentario === '[]') return [];
  const enLinea = /^\[(.*)\]$/.exec(sinComentario);
  if (enLinea) return enLinea[1].split(',').map((x) => escalar(x)).filter((x) => x !== '');
  // los escalares sin comillas de YAML que no son texto: así el esquema los juzga por lo que son
  if (/^(?:null|Null|NULL|~)$/.test(sinComentario)) return null;
  if (/^(?:true|True|TRUE)$/.test(sinComentario)) return true;
  if (/^(?:false|False|FALSE)$/.test(sinComentario)) return false;
  if (/^-?\d+$/.test(sinComentario)) return Number(sinComentario);
  if (/^-?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(sinComentario)) return Number(sinComentario);
  return sinComentario;
}

const indent = (l) => l.length - l.trimStart().length;
const CLAVE = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;

// Una clave repetida no se pisa en silencio: el valor que valdría depende del orden, y un `status:` doble esconde uno.
function poner(obj, clave, valor) {
  if (Object.prototype.hasOwnProperty.call(obj, clave)) throw new Error(`la clave «${clave}» está repetida`);
  obj[clave] = valor;
}

function leerYaml(texto) {
  const lineas = texto.split('\n').filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
  const out = {};
  let i = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (indent(l) !== 0) throw new Error(`renglón con sangría fuera de lugar: ${l.trim()}`);
    const m = CLAVE.exec(l);
    if (!m) throw new Error(`no es «clave: valor»: ${l.trim()}`);
    i++;
    if (m[2] !== undefined && m[2].trim() !== '') { poner(out, m[1], escalar(m[2])); continue; }
    const hijos = [];
    while (i < lineas.length && indent(lineas[i]) > 0) hijos.push(lineas[i++]);
    poner(out, m[1], hijos.length ? bloque(hijos) : null);
  }
  return out;
}

/** Un bloque con sangría: una lista (`- …`) o un objeto (`clave: valor`). */
function bloque(lineas) {
  const base = indent(lineas[0]);
  if (lineas[0].trim().startsWith('- ')) {
    const items = [];
    for (const l of lineas) {
      const t = l.trim();
      if (indent(l) === base && t.startsWith('- ')) {
        const resto = t.slice(2);
        const m = CLAVE.exec(resto);
        items.push(m && !/^["']/.test(resto) ? { [m[1]]: m[2] === undefined ? null : escalar(m[2]) } : escalar(resto));
      } else if (indent(l) > base && items.length && items[items.length - 1] && typeof items[items.length - 1] === 'object' && !Array.isArray(items[items.length - 1])) {
        const m = CLAVE.exec(t);
        if (!m) throw new Error(`no es «clave: valor»: ${t}`);
        poner(items[items.length - 1], m[1], m[2] === undefined ? null : escalar(m[2]));
      } else throw new Error(`lista mal formada: ${t}`);
    }
    return items;
  }
  const obj = {};
  let i = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (indent(l) !== base) throw new Error(`objeto mal formado: ${l.trim()}`);
    const m = CLAVE.exec(l.trim());
    if (!m) throw new Error(`no es «clave: valor»: ${l.trim()}`);
    i++;
    if (m[2] !== undefined && m[2].trim() !== '') { poner(obj, m[1], escalar(m[2])); continue; }
    const hijos = [];
    while (i < lineas.length && indent(lineas[i]) > base) hijos.push(lineas[i++]);
    poner(obj, m[1], hijos.length ? bloque(hijos) : null);
  }
  return obj;
}

// ── El cuerpo: secciones, como las corta IntentSpec ─────────────────────────────────────────────────────────────────

/** El cuerpo sin bloques de código ni comentarios HTML, con los renglones en su lugar (para dar la línea real). */
function cuerpoLimpio(lineas) {
  const out = [];
  let codigo = false;
  let comentario = false;
  for (const l of lineas) {
    if (!comentario && /^\s*(```|~~~)/.test(l)) { codigo = !codigo; out.push(''); continue; }
    if (codigo) { out.push(''); continue; }
    let t = l;
    let limpio = '';
    while (t.length) {
      if (comentario) {
        const fin = t.indexOf('-->');
        if (fin < 0) { t = ''; break; }
        comentario = false;
        t = t.slice(fin + 3);
      } else {
        const ini = t.indexOf('<!--');
        if (ini < 0) { limpio += t; break; }
        limpio += t.slice(0, ini);
        comentario = true;
        t = t.slice(ini + 4);
      }
    }
    out.push(limpio);
  }
  return out;
}

/** Las secciones `##`: `{ titulo, desde, lineas }`. `###` no abre sección; `#` cierra la anterior sin abrir otra. */
function secciones(lineas, offset) {
  const out = [];
  let actual = null;
  lineas.forEach((l, i) => {
    const h = /^(#{1,6})[ \t]+(.*?)\s*$/.exec(l);
    if (h && h[1].length <= 2) {
      actual = h[1].length === 2 ? { titulo: h[2], desde: offset + i + 1, lineas: [] } : null;
      if (actual) out.push(actual);
      return;
    }
    if (actual) actual.lineas.push({ texto: l, linea: offset + i + 1 });
  });
  return out;
}

const items = (sec) => sec.lineas.map((x) => /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(x.texto)).filter(Boolean).map((m) => m[1].trim());

function edgeCase(item) {
  const formas = [/^\*\*(.+?)\*\*\s*:\s*(.+)$/, /^(.+?)\s*(?:->|→)\s*(.+)$/, /^([^:]+?)\s*:\s*(.+)$/];
  for (const f of formas) {
    const m = f.exec(item);
    if (m) return { scenario: m[1].trim(), expectedBehavior: m[2].trim() };
  }
  return { scenario: item };
}

/** El objeto que valida IntentSpec: el frontmatter, con las secciones del cuerpo que reconoce (§2 de su especificación). */
function modeloDe(frontmatter, secs) {
  const modelo = { ...frontmatter };
  const primera = (...titulos) => {
    for (const t of titulos) {
      const s = secs.find((x) => x.titulo.toLowerCase() === t);
      if (s) return s;
    }
    return null;
  };
  const obj = primera('objective', 'problem', 'why');
  if (obj && modelo.objective === undefined) {
    const texto = obj.lineas.map((x) => x.texto).join('\n').trim();
    if (texto) modelo.objective = texto;
  }
  const listas = [['outcomes', ['outcomes', 'proposed outcome']], ['constraints', ['constraints']], ['healthMetrics', ['health metrics']], ['verification', ['verification']]];
  for (const [campo, titulos] of listas) {
    const s = primera(...titulos);
    const it = s ? items(s) : [];
    if (it.length) modelo[campo] = campo === 'verification' ? it.map((x) => x.replace(/^\*\*[^*]+\*\*\s*:?\s*/, '')) : it;
  }
  const casos = primera('edge cases');
  const it = casos ? items(casos) : [];
  if (it.length) modelo.edgeCases = it.map(edgeCase);
  return modelo;
}

// ── El esquema de IntentSpec: un validador chico de las palabras que el esquema usa ──────────────────────────────────

const PALABRAS = new Set(['$schema', '$id', 'title', 'description', 'default', 'type', 'required', 'properties', 'enum', 'minItems', 'items', 'pattern']);

function tipoOk(v, tipo) {
  if (tipo === 'array') return Array.isArray(v);
  if (tipo === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (tipo === 'integer') return Number.isInteger(v);
  return typeof v === tipo;
}

function validar(v, esquema, donde, problemas, avisos) {
  for (const k of Object.keys(esquema)) {
    if (!PALABRAS.has(k)) avisos.push(`el esquema usa «${k}», que este validador no conoce: esa regla no se miró (${donde || 'raíz'})`);
  }
  if (esquema.type && !tipoOk(v, esquema.type)) { problemas.push(`${donde || 'la intención'} tiene que ser ${esquema.type}`); return; }
  if (esquema.enum && !esquema.enum.includes(v)) problemas.push(`${donde} fuera de la lista: ${JSON.stringify(v)} (vale ${esquema.enum.join(', ')})`);
  if (esquema.pattern && typeof v === 'string' && !new RegExp(esquema.pattern).test(v)) problemas.push(`${donde} no tiene la forma ${esquema.pattern}`);
  if (esquema.minItems !== undefined && Array.isArray(v) && v.length < esquema.minItems) problemas.push(`${donde} necesita al menos ${esquema.minItems} elemento(s)`);
  if (esquema.items && Array.isArray(v)) v.forEach((x, i) => validar(x, esquema.items, `${donde}[${i}]`, problemas, avisos));
  if (esquema.required && tipoOk(v, 'object')) {
    for (const r of esquema.required) if (v[r] === undefined || v[r] === null) problemas.push(`falta ${donde ? `${donde}.` : ''}${r}`);
  }
  if (esquema.properties && tipoOk(v, 'object')) {
    for (const [k, sub] of Object.entries(esquema.properties)) {
      if (v[k] !== undefined && v[k] !== null) validar(v[k], sub, donde ? `${donde}.${k}` : k, problemas, avisos);
    }
  }
}

let esquemaCache = null;
function esquema() {
  if (!esquemaCache) esquemaCache = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return esquemaCache;
}

// ── Las dos tablas ───────────────────────────────────────────────────────────────────────────────────────────────────

const celdas = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/**
 * Una sección propia: su tabla, `Ninguna.` (y en las reservadas `Ninguna, porque <motivo>.`), y en las preguntas un
 * renglón de entrevista antes. Devuelve `{ filas, entrevista }` y anota los problemas de la sección.
 */
function leerSeccion(sec, { nombre, columnas, prefijo, conEntrevista, conMotivo }, p) {
  const llenas = sec.lineas.filter((x) => x.texto.trim() !== '');
  let entrevista = null;
  let resto = llenas;
  if (conEntrevista && resto.length && ENTREVISTA.test(resto[0].texto.trim())) {
    const m = ENTREVISTA.exec(resto[0].texto.trim());
    entrevista = { nivel: m[1], corrida: m[2] };
    resto = resto.slice(1);
  }
  const esNinguna = (t) => NINGUNA.test(t) || (conMotivo && NINGUNA_PORQUE.test(t));
  const ninguna = resto.filter((x) => esNinguna(x.texto.trim()));
  const tabla = resto.filter((x) => x.texto.trim().startsWith('|'));
  const sueltas = resto.filter((x) => !x.texto.trim().startsWith('|') && !esNinguna(x.texto.trim()));
  for (const s of sueltas) p(null, null, s.linea, `«${nombre}»: texto fuera de la tabla («${s.texto.trim().slice(0, 60)}»): va una tabla, o «Ninguna.»`);
  if (ninguna.length && (tabla.length || ninguna.length > 1)) p(null, null, ninguna[0].linea, `«${nombre}»: «Ninguna.» va sola, sin tabla`);
  if (!tabla.length) {
    const porque = ninguna.length ? NINGUNA_PORQUE.exec(ninguna[0].texto.trim()) : null;
    if (porque && !porque[1].trim()) p(null, null, ninguna[0].linea, `«${nombre}»: «Ninguna, porque …» sin motivo`);
    if (!ninguna.length && !sueltas.length) p(null, null, sec.desde, `«${nombre}» vacía: va una tabla con filas, o «Ninguna.»`);
    return { filas: [], entrevista };
  }
  const cabecera = celdas(tabla[0].texto);
  const faltan = columnas.filter((c) => !cabecera.includes(c));
  for (const c of faltan) p(null, c, tabla[0].linea, `«${nombre}»: falta la columna «${c}»`);
  // una columna repetida esconde una celda: la fila se leería con la última
  for (const c of new Set(cabecera.filter((x, i) => cabecera.indexOf(x) !== i))) p(null, c, tabla[0].linea, `«${nombre}»: la columna «${c}» está repetida`);
  const filas = [];
  // el separador de GFM: cada celda, uno o más guiones con dos puntos opcionales a los lados
  const cuerpo = tabla.slice(1).filter((x) => !celdas(x.texto).every((c) => /^:?-+:?$/.test(c)));
  if (!cuerpo.length) p(null, null, tabla[0].linea, `«${nombre}»: la cabecera sin filas; si no hay ninguna, va «Ninguna.»`);
  if (faltan.length) return { filas: [], entrevista };
  const vistos = new Set();
  for (const r of cuerpo) {
    const c = celdas(r.texto);
    const fila = { linea: r.linea };
    cabecera.forEach((col, i) => { fila[col] = c[i] === undefined ? '' : c[i]; });
    const id = fila['#'];
    if (c.length !== cabecera.length) p(id || null, null, r.linea, `«${nombre}»: la fila tiene ${c.length} celdas y la cabecera ${cabecera.length}`);
    if (!new RegExp(`^${prefijo}\\d+$`).test(id)) p(id || null, '#', r.linea, `«${nombre}»: el id «${id}» no tiene la forma ${prefijo}<n>`);
    else if (vistos.has(id)) p(id, '#', r.linea, `«${nombre}»: el id ${id} está repetido`);
    vistos.add(id);
    filas.push(fila);
  }
  return { filas, entrevista };
}

/**
 * Por qué una fuente `repo:<archivo:línea>` no vale, o null si vale. Se mira por la ruta real (un enlace que sale del
 * repo no cuenta como del repo) y se distingue «no existe» de «no lo pude leer»: son dos arreglos distintos.
 */
function fuenteRepoInvalida(raiz, fuente) {
  const m = FUENTES.repo.exec(fuente);
  if (!m) return 'no tiene la forma repo:<archivo:línea>';
  if (!raiz) return 'sin la carpeta del repo no puedo comprobarla';
  let base;
  let abs;
  try { base = fs.realpathSync(raiz); } catch (e) { return `no pude leer la carpeta del repo (${e.code || e.message})`; }
  try { abs = fs.realpathSync(path.resolve(raiz, m[1])); } catch (e) {
    return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'ese archivo no existe en el repo' : `no pude leer ese archivo (${e.code || e.message})`;
  }
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'ese archivo está fuera del repo';
  let lineas;
  try { lineas = fs.readFileSync(abs, 'utf8').split('\n'); } catch (e) { return `no pude leer ese archivo (${e.code || e.message})`; }
  if (lineas[lineas.length - 1] === '') lineas.pop();
  const n = Number(m[2]);
  return n >= 1 && n <= lineas.length ? null : `esa línea no existe (el archivo tiene ${lineas.length})`;
}

/** Los problemas de forma de una pregunta. */
function formaPregunta(f, raiz, p) {
  const id = f['#'];
  const v = VOCABULARIES;
  if (!v.bloquea.includes(f.Bloquea)) p(id, 'Bloquea', f.linea, `«${f.Bloquea}» no es ${v.bloquea.join(' ni ')}`);
  if (!v.estadoPregunta.includes(f.Estado)) p(id, 'Estado', f.linea, `«${f.Estado}» no está en ${v.estadoPregunta.join(', ')}`);
  const tipo = tipoDeFuente(f.Fuente);
  if (!tipo) p(id, 'Fuente', f.linea, `«${f.Fuente}» no tiene la forma de ${v.fuentePregunta.join(', ')}`);
  if (f.Estado === 'supuesta' && f.Bloquea === 'sí') p(id, 'Bloquea', f.linea, 'una pregunta supuesta no puede bloquear: o se contesta, o no bloquea');
  if (f.Estado === 'encontrada' && tipo && !['repo', 'memoria'].includes(tipo)) p(id, 'Fuente', f.linea, 'una encontrada lleva fuente repo:<archivo:línea> o memoria:<id>');
  if (['contestada', 'descartada'].includes(f.Estado) && tipo && tipo !== 'persona' && tipo !== 'pedido') p(id, 'Fuente', f.linea, `una ${f.Estado} lleva fuente persona:<nombre>`);
  if (tipo === 'pedido' && !['abierta', 'supuesta'].includes(f.Estado)) p(id, 'Fuente', f.linea, 'pedido: sólo informa: vale en una abierta o una supuesta');
  const porQueNo = tipo === 'repo' ? fuenteRepoInvalida(raiz, f.Fuente) : null;
  if (porQueNo) p(id, 'Fuente', f.linea, `${f.Fuente}: ${porQueNo}`);
  if (['supuesta', 'encontrada', 'contestada', 'descartada'].includes(f.Estado) && !f.Respuesta) p(id, 'Respuesta', f.linea, `una ${f.Estado} lleva su respuesta`);
}

/** Los problemas de forma de una decisión reservada. */
function formaReservada(f, p) {
  const id = f['#'];
  const v = VOCABULARIES;
  if (!v.estadoReservada.includes(f.Estado)) p(id, 'Estado', f.linea, `«${f.Estado}» no está en ${v.estadoReservada.join(', ')}`);
  const tipo = tipoDeFuente(f.Fuente);
  if (tipo !== 'persona' && tipo !== 'ninguna') p(id, 'Fuente', f.linea, `«${f.Fuente}» no tiene la forma de ${v.fuenteReservada.join(', ')}: lo escrito puede contestar una pregunta, no tomar una decisión de una persona`);
  if (['tomada', 'descartada'].includes(f.Estado) && tipo === 'ninguna') p(id, 'Fuente', f.linea, `una decisión ${f.Estado} lleva fuente persona:<nombre>`);
  if (['tomada', 'descartada'].includes(f.Estado) && !f.Respuesta) p(id, 'Respuesta', f.linea, `una decisión ${f.Estado} lleva su respuesta`);
}

const cerradaPregunta = (f) => ['encontrada', 'contestada', 'descartada'].includes(f.Estado);
const cerradaReservada = (f) => ['tomada', 'descartada'].includes(f.Estado);

/**
 * Lee una intención. `raiz`: la carpeta del repo de la intención (para las fuentes `repo:`). `constancia`: la consulta
 * de la constancia de la persona, `({ seccion, fila }) → boolean`; sin ella, una fila cerrada por `persona:` vale por
 * su forma.
 */
function readIntent(texto, { raiz = null, constancia = null } = {}) {
  const problemas = [];
  const avisos = [];
  const p = (fila, columna, linea, mensaje) => problemas.push({ fila, columna, linea, mensaje });
  const a = (fila, columna, linea, mensaje) => avisos.push({ fila, columna, linea, mensaje });
  const todas = String(texto).replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');

  let frontmatter = {};
  let inicioCuerpo = 0;
  if (todas[0] !== '---') p(null, null, 1, 'la intención no abre con el frontmatter (`---`)');
  else {
    const fin = todas.indexOf('---', 1);
    if (fin < 0) p(null, null, 1, 'el frontmatter no cierra (falta el `---` final)');
    else {
      inicioCuerpo = fin + 1;
      try { frontmatter = leerYaml(todas.slice(1, fin).join('\n')); } catch (e) { p(null, null, 2, `no pude leer el frontmatter: ${e.message}`); }
    }
  }

  const cuerpo = cuerpoLimpio(todas.slice(inicioCuerpo));
  const secs = secciones(cuerpo, inicioCuerpo);
  const modelo = modeloDe(frontmatter, secs);

  const esq = esquema();
  const enEsquema = [];
  const avisosEsquema = [];
  validar(modelo, esq, '', enEsquema, avisosEsquema);
  for (const m of enEsquema) p(null, null, null, `IntentSpec: ${m}`);
  for (const m of avisosEsquema) a(null, null, null, m);
  for (const k of Object.keys(frontmatter)) {
    if (!esq.properties[k]) a(null, null, null, `«${k}» no es un campo de IntentSpec: IntentSpec no lo lee`);
  }

  const reQ = new RegExp(`^(?:${TITLE_WORDS.questions})$`, 'i');
  const reR = new RegExp(`^(?:${TITLE_WORDS.reserved})$`, 'i');
  const secQ = secs.filter((s) => reQ.test(s.titulo));
  const secR = secs.filter((s) => reR.test(s.titulo));
  const una = (lista, nombre) => {
    if (!lista.length) { p(null, null, null, `falta la sección «${nombre}»`); return null; }
    if (lista.length > 1) p(null, null, lista[1].desde, `la sección «${nombre}» está dos veces`);
    return lista[0];
  };
  const sq = una(secQ, 'Preguntas abiertas');
  const sr = una(secR, 'Decisiones reservadas');
  const leidaQ = sq ? leerSeccion(sq, { nombre: 'Preguntas abiertas', columnas: QUESTION_COLUMNS, prefijo: 'Q', conEntrevista: true, conMotivo: false }, p) : { filas: [], entrevista: null };
  const leidaR = sr ? leerSeccion(sr, { nombre: 'Decisiones reservadas', columnas: RESERVED_COLUMNS, prefijo: 'R', conEntrevista: false, conMotivo: true }, p) : { filas: [] };
  const preguntas = leidaQ.filas;
  const reservadas = leidaR.filas;
  for (const f of preguntas) formaPregunta(f, raiz, p);
  for (const f of reservadas) formaReservada(f, p);

  const marcas = [];
  cuerpo.forEach((l, i) => {
    for (const m of l.matchAll(MARCA)) marcas.push({ id: m[1], linea: inicioCuerpo + i + 1 });
  });
  for (const m of marcas) {
    const lista = m.id.startsWith('Q') ? preguntas : reservadas;
    const fila = lista.find((f) => f['#'] === m.id);
    if (!fila) p(m.id, null, m.linea, `[falta: ${m.id}] nombra una fila que no existe`);
    else if ((m.id.startsWith('Q') ? cerradaPregunta : cerradaReservada)(fila)) a(m.id, null, m.linea, `[falta: ${m.id}]: la fila ya está cerrada, la marca quedó vieja`);
  }

  // Lo que bloquea, en el orden de las filas: primero las preguntas, después las reservadas.
  const bloqueantes = [];
  const conProblema = new Set(problemas.map((x) => x.fila).filter(Boolean));
  const persona = (seccion, f) => {
    if (typeof constancia !== 'function') return null;
    return constancia({ seccion, fila: f }) ? null : `falta la constancia de ${f.Fuente}`;
  };
  for (const f of preguntas) {
    const id = f['#'];
    if (conProblema.has(id)) { bloqueantes.push({ id, motivo: 'problema de forma' }); continue; }
    if (f.Bloquea !== 'sí') continue;
    if (f.Estado === 'encontrada' && tipoDeFuente(f.Fuente) === 'repo') continue;
    if (f.Estado === 'encontrada') { bloqueantes.push({ id, motivo: `${f.Fuente} no se puede comprobar desde el repo: no cierra una pregunta que bloquea` }); continue; }
    if (['contestada', 'descartada'].includes(f.Estado)) {
      const falta = persona('preguntas', f);
      if (falta) bloqueantes.push({ id, motivo: falta });
      continue;
    }
    bloqueantes.push({ id, motivo: `pregunta ${f.Estado} que bloquea` });
  }
  for (const f of reservadas) {
    const id = f['#'];
    if (conProblema.has(id)) { bloqueantes.push({ id, motivo: 'problema de forma' }); continue; }
    if (cerradaReservada(f)) {
      const falta = persona('reservadas', f);
      if (falta) bloqueantes.push({ id, motivo: falta });
      continue;
    }
    bloqueantes.push({ id, motivo: 'decisión reservada abierta: la decide una persona' });
  }
  // Un problema que nombra una fila que no está (una marca `[falta: Q9]` sin su fila) también bloquea, con ese id.
  const filas = new Set([...preguntas, ...reservadas].map((f) => f['#']));
  for (const id of conProblema) if (!filas.has(id)) bloqueantes.push({ id, motivo: 'problema de forma' });
  // Un problema que no es de una fila (la sección, el frontmatter, el esquema) también bloquea: falla cerrada.
  if (problemas.some((x) => !x.fila)) bloqueantes.push({ id: 'intención', motivo: 'problema de forma de la intención' });

  return { frontmatter, modelo, preguntas, reservadas, entrevista: leidaQ.entrevista, marcas, bloqueantes, problemas, avisos };
}

module.exports = { readIntent, isIntentFile, INTENT_NOTICE_UNTIL, SCHEMA_PATH, QUESTION_COLUMNS, RESERVED_COLUMNS, VOCABULARIES };
