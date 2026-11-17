'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * smoke-measures — lo que mide un humo y la cota que escribe el criterio.
 *
 * Un humo por smoke-run.sh juzga el código de salida del comando. Un criterio con un número («responde en menos de
 * 2 s») necesita además lo que tardó el comando, o lo que el propio comando midió, y una cota contra la cual compararlo.
 * El arnés no elige umbrales ni repite corridas: mide el reloj, guarda lo que el comando dice y compara contra la cota
 * que escribió quien escribió el criterio.
 *
 *   · `duracion(t0, t1)`: el reloj de pared antes y después del comando, en ms. Si retrocedió o una lectura no es un
 *     entero, `{ ms: null, error }`: nunca un número negativo.
 *   · `leerRenglones(texto)`: los renglones `TYCON_MEASURE <nombre>=<número>[ ]<unidad>` de la salida. Un nombre
 *     repetido: gana el último. Hasta 20 nombres (`dropped`, los de más). Un renglón que empieza con `TYCON_MEASURE` y
 *     no tiene la forma, o usa el nombre reservado `duration`, se rechaza y se cuenta por su número de renglón: su texto
 *     no se guarda (puede traer cualquier cosa que imprimió el comando).
 *   · `marcas(texto)`: las marcas `@measure(...)` y `@mide(...)` del texto crudo de un criterio, fuera de código en línea,
 *     de bloques ``` y de citas. Lo que no tiene la forma va a `ilegibles`: nunca se ignora en silencio.
 *   · `comparar(medida, marca)`: `ms`, `s` y `min` se convierten entre sí; cualquier otra unidad tiene que ser igual
 *     letra por letra, y sin unidad sólo contra sin unidad.
 *
 * Una medida de `TYCON_MEASURE` es lo que el comando dice: el arnés garantiza que no se editó después de la corrida (la
 * confirma contra el espejo), no que sea una medición honesta. La duración sí la toma el arnés.
 *
 * Línea de comandos (la usa smoke-run.sh):
 *   node smoke-measures.js clock                       → la hora en ms
 *   node smoke-measures.js fields <t0> <t1> [<salida>] → el fragmento JSON del renglón (`,"duration_ms":…`), avisos
 *                                                        por la salida de error
 */
const fs = require('fs');

const NOMBRE_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
const RENGLON_RE = /^TYCON_MEASURE\s+([a-z][a-z0-9_.-]{0,39})=([+-]?\d+(?:\.\d+)?) ?([A-Za-z%/]{1,12})?\s*$/;
const RESERVADO = 'duration';
const TOPE_NOMBRES = 20;
const MARCA_RE = /@(measure|mide)\(([^)]*)\)/g;
const INTERIOR_RE = /^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*(<=|>=|<|>)\s*([+-]?\d+(?:\.\d+)?)\s*([A-Za-z%/]{1,12})?\s*$/;
const ALIAS = { duracion: 'duration' };
const TIEMPO = { ms: 1, s: 1000, min: 60000 };

function duracion(t0, t1) {
  const a = Number(t0);
  const b = Number(t1);
  if (String(t0).trim() === '' || String(t1).trim() === '' || !Number.isInteger(a) || !Number.isInteger(b)) {
    return { ms: null, error: 'una lectura del reloj no es un entero' };
  }
  if (b < a) return { ms: null, error: 'el reloj retrocedió entre las dos lecturas (un ajuste de hora)' };
  return { ms: b - a };
}

function leerRenglones(texto) {
  const porNombre = new Map();
  const rechazados = [];
  let fuera = 0;
  String(texto || '').split('\n').forEach((crudo, i) => {
    const l = crudo.replace(/\r$/, '');
    if (!/^TYCON_MEASURE\b/.test(l)) return;
    const m = RENGLON_RE.exec(l);
    if (!m || m[1] === RESERVADO) { rechazados.push(i + 1); return; }
    const medida = { name: m[1], value: Number(m[2]), unit: m[3] || null };
    if (porNombre.has(m[1])) { porNombre.set(m[1], medida); return; }
    if (porNombre.size >= TOPE_NOMBRES) { fuera++; return; }
    porNombre.set(m[1], medida);
  });
  // `fuera` cuenta renglones; lo que se informa son los NOMBRES que quedaron afuera
  const nombresFuera = new Set();
  String(texto || '').split('\n').forEach((crudo) => {
    const m = RENGLON_RE.exec(crudo.replace(/\r$/, ''));
    if (m && m[1] !== RESERVADO && !porNombre.has(m[1])) nombresFuera.add(m[1]);
  });
  return { measures: [...porNombre.values()], dropped: fuera ? nombresFuera.size : 0, rejected: rechazados };
}

/** El texto sin código en línea, sin bloques ``` y sin renglones de cita: una marca citada como ejemplo no es marca. */
function sinCitas(texto) {
  const fuera = [];
  let enBloque = false;
  for (const l of String(texto || '').split('\n')) {
    if (/^[ \t]*```/.test(l)) { enBloque = !enBloque; continue; }
    if (enBloque || /^[ \t]*>/.test(l)) continue;
    fuera.push(l);
  }
  return fuera.join('\n').replace(/`[^`\n]*`/g, ' ');
}

function marcas(texto) {
  const out = { marcas: [], ilegibles: [] };
  const limpio = sinCitas(texto);
  let m;
  MARCA_RE.lastIndex = 0;
  while ((m = MARCA_RE.exec(limpio)) !== null) {
    const i = INTERIOR_RE.exec(m[2]);
    const nombre = i ? (ALIAS[i[1]] || i[1]) : null;
    if (!i || !NOMBRE_RE.test(nombre)) { out.ilegibles.push(m[0]); continue; }
    out.marcas.push({ nombre, op: i[2], valor: Number(i[3]), unidad: i[4] || null, texto: m[0] });
  }
  return out;
}

const cumpleOp = (a, op, b) => (op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b);

/** `{ cumple: true|false }`, o `{ sinMedicion: <motivo> }` si las unidades no se pueden comparar. */
function comparar(medida, marca) {
  const um = medida.unit || null;
  const uc = marca.unidad || null;
  if (TIEMPO[um] && TIEMPO[uc]) return { cumple: cumpleOp(medida.value * TIEMPO[um], marca.op, marca.valor * TIEMPO[uc]) };
  if (um !== uc) return { sinMedicion: `unidad distinta (medido en ${um || 'sin unidad'}, la cota en ${uc || 'sin unidad'})` };
  return { cumple: cumpleOp(medida.value, marca.op, marca.valor) };
}

function textoCota(marca) {
  if (TIEMPO[marca.unidad]) return `${marca.op} ${marca.valor * TIEMPO[marca.unidad]} ms`;
  return `${marca.op} ${marca.valor}${marca.unidad ? ` ${marca.unidad}` : ''}`;
}

function textoMedido(medida) {
  if (TIEMPO[medida.unit]) return `${medida.value * TIEMPO[medida.unit]} ms`;
  return `${medida.value}${medida.unit ? ` ${medida.unit}` : ''}`;
}

/** El fragmento del renglón del registro y del espejo (los dos llevan el mismo) y los avisos. */
function campos(t0, t1, salida) {
  const avisos = [];
  const d = duracion(t0, t1);
  let frag = d.ms === null
    ? `,"duration_ms":null,"duration_error":${JSON.stringify(d.error)}`
    : `,"duration_ms":${d.ms}`;
  if (d.ms === null) avisos.push(`la duración del comando no se pudo medir: ${d.error}`);
  if (salida) {
    let texto = null;
    try { texto = fs.readFileSync(salida, 'utf8'); } catch (_e) { texto = null; }
    if (texto !== null) {
      const r = leerRenglones(texto);
      if (r.measures.length) frag += `,"measures":${JSON.stringify(r.measures)}`;
      if (r.dropped) {
        frag += `,"measures_dropped":${r.dropped}`;
        avisos.push(`el comando emitió más de ${TOPE_NOMBRES} medidas: se guardan las ${TOPE_NOMBRES} primeras y quedan afuera ${r.dropped}`);
      }
      if (r.rejected.length) {
        frag += `,"measures_rejected":${r.rejected.length}`;
        avisos.push(`renglón(es) TYCON_MEASURE que no se guardan (sin la forma «TYCON_MEASURE <nombre>=<número><unidad>», o con el nombre reservado duration): ${r.rejected.join(', ')}`);
      }
      let tope = 8192;
      try { tope = require('./smoke-secrets.js').SALIDA_MAX_BYTES || tope; } catch (_e) { /* sin el tapado, el tope de siempre */ }
      if (r.measures.length && Buffer.byteLength(texto) > tope) {
        avisos.push(`la salida pasó de ${tope} bytes y trajo medidas: la guardada se recorta (principio y final), así que su renglón TYCON_MEASURE puede no estar ahí. Imprimí las medidas al final de la salida.`);
      }
    }
  }
  return { fragmento: frag, avisos };
}

module.exports = { duracion, leerRenglones, marcas, comparar, textoCota, textoMedido, campos, TIEMPO, TOPE_NOMBRES };

if (require.main === module) {
  const [orden, ...resto] = process.argv.slice(2);
  if (orden === 'clock') {
    process.stdout.write(String(Date.now()));
  } else if (orden === 'fields') {
    const r = campos(resto[0], resto[1], resto[2]);
    for (const a of r.avisos) process.stderr.write(`[smoke-run] ⚠️ ${a}\n`);
    process.stdout.write(r.fragmento);
  } else {
    process.stderr.write('uso: smoke-measures.js clock | fields <t0> <t1> [<salida>]\n');
    process.exit(2);
  }
}
