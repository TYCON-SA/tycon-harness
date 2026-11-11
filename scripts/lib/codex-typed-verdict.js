'use strict';
/**
 * codex-typed-verdict.js — lee el veredicto medido de si la conversación guardada de Codex distingue un mensaje que
 * tipeó la persona de uno que metió un programa (`scripts/tests/fixtures/codex-typed/verdict.json`).
 *
 * Los casos medidos son cuatro: (a) tipeado por la persona en la terminal de Codex; (b) con `codex queue`; (c) por otro
 * programa conectado al servidor compartido; (d) tipeado por un programa en una pseudo-terminal. El veredicto dice, por
 * cada caso, el dato que lo separa y su valor.
 *
 * Falla cerrada: sin el archivo, ilegible, sin versión, con un caso sin su dato, con un caso que no se pudo correr, o con
 * la persona medida menos de dos veces, se lee como «no distingue», con el motivo. Quien decide si una respuesta escrita
 * en Codex vale como constancia de la persona usa este lector: en la duda, no vale.
 */
const fs = require('fs');
const path = require('path');

const CASES = ['a', 'b', 'c', 'd'];

/** El texto con que los datos de prueba reemplazan lo que se tipeó de verdad. */
const FIXED_TEXT = 'marca inventada de prueba';

/** Los únicos ids que pueden aparecer en los datos de prueba: los reales se cambian por éstos. */
const TOY_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
  '00000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-00000000000b',
  '00000000-0000-4000-8000-00000000000c',
];

const DEFAULT_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'codex-typed');

const no = (base, motivo) => ({ version: base.version || null, fecha: base.fecha || null, distingue: false, datos: base.datos || {}, motivo });

/**
 * Lee `verdict.json` de `dir`. Devuelve `{ version, fecha, distingue, datos, motivo? }`; `distingue` es `true` sólo si
 * el archivo lo dice y está completo. `motivo` explica por qué se lee como «no».
 */
function readVerdict(dir = DEFAULT_DIR) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8');
  } catch (e) {
    return no({}, e.code === 'ENOENT' ? 'no hay verdict.json: no está medido' : `verdict.json no se puede abrir (${e.code || e.message})`);
  }
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return no({}, `verdict.json no se puede leer: ${e.message}`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return no({}, 'verdict.json no es un objeto');
  if (typeof v.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(v.version)) return no(v, 'verdict.json no dice qué versión de Codex se midió');
  const datos = v.datos && typeof v.datos === 'object' ? v.datos : {};
  if (v.distingue !== true) return no({ ...v, datos }, v.distingue === false ? 'la medición dice que no distingue' : 'verdict.json no dice si distingue');
  for (const c of CASES) {
    const d = datos[c];
    if (!d || typeof d !== 'object') return no({ ...v, datos }, `falta el dato del caso ${c}`);
    if (d.no_ejecutado !== undefined) return no({ ...v, datos }, `el caso ${c} no ejecutado: ${d.no_ejecutado}`);
    const sinValor = d.valor === undefined || d.valor === null || (typeof d.valor === 'string' && !d.valor.trim());
    if (typeof d.dato !== 'string' || !d.dato.trim() || sinValor) return no({ ...v, datos }, `el caso ${c} no nombra el dato y su valor`);
  }
  if (!(Number.isInteger(datos.a.corridas) && datos.a.corridas >= 2)) return no({ ...v, datos }, 'el caso a se midió menos de dos veces');
  return { version: v.version, fecha: v.fecha || null, distingue: true, datos };
}

module.exports = { readVerdict, CASES, FIXED_TEXT, TOY_IDS, DEFAULT_DIR };
