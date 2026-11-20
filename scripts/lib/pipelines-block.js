'use strict';
// pipelines-block.js — el lector del bloque `pipelines:` de una historia, por sangría.
//
// Lo usan el control de frontmatter (la regla de las tandas `done` con pendientes) y el cierre de tanda del pipeline
// (`marker.js update-pipeline-status`): los dos tienen que ver las mismas tandas, con los mismos límites, o el cierre
// mueve lo de una tanda a otra y el control no lo ve.
//
// Las dos formas del bloque:
//   · lista: cada `- clave: valor` a la sangría de la primera entrada abre una tanda, empiece o no por `name`. Sus claves
//     propias están a esa sangría + 2 (la primera, en el mismo renglón del guion).
//   · mapa: cada `nombre:` a la sangría de la primera entrada abre una tanda; el nombre es esa clave. Sus claves propias
//     están a la sangría de su primer renglón hijo.
// Todo lo que está más adentro que las claves propias (una lista anidada, un mapa anidado) es valor de la clave anterior:
// no abre tandas ni pisa `status:` o `name:`.
//
// Los valores en el renglón se leen con las comillas en cuenta: un `#` o una `,` entre comillas no cortan nada.

/** El valor sin su comentario: un `#` precedido de espacio y fuera de comillas. */
function sinComentario(v) {
  let q = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(v[i - 1]))) return v.slice(0, i).trim();
  }
  return v.trim();
}

/** Un escalar sin sus comillas. */
const sinComillas = (s) => { const m = /^(["'])([\s\S]*)\1$/.exec(s.trim()); return m ? m[2] : s.trim(); };

/**
 * Una lista entre corchetes, que puede seguir en varios renglones: `{ items, cerrada }`. `items` son los elementos sin
 * comillas; `cerrada` dice si apareció el `]` que la cierra (fuera de comillas).
 */
function listaEnLinea(texto) {
  const items = [];
  let q = null;
  let cur = '';
  let empezo = false;
  for (const c of texto) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (!empezo) { if (c === '[') empezo = true; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ',' || c === ']') {
      if (cur.trim() && sinComillas(cur) !== '') items.push(sinComillas(cur));
      cur = '';
      if (c === ']') return { items, cerrada: true };
      continue;
    }
    cur += c;
  }
  if (cur.trim() && sinComillas(cur) !== '') items.push(sinComillas(cur));
  return { items, cerrada: false };
}

const sangria = (l) => l.length - l.trimStart().length;
const vacia = (l) => /^\s*(#.*)?$/.test(l);

/**
 * Las tandas del bloque: `[{ name, inicio, fin, claveSangria, claves }]`. `inicio` y `fin` son índices de `lines` (el fin
 * no incluido); `claves` es `[{ clave, linea, valor, hijos }]` con las claves propias de la tanda, su valor en el renglón
 * (sin comentario) y los índices de los renglones de abajo que le pertenecen. `start`: el índice del renglón `pipelines:`.
 */
function leerTandas(lines, start) {
  if (start < 0) return [];
  let fin = start + 1;
  while (fin < lines.length && (vacia(lines[fin]) || !/^\S/.test(lines[fin]) || /^-\s/.test(lines[fin]))) fin++;
  let primera = start + 1;
  while (primera < fin && vacia(lines[primera])) primera++;
  if (primera >= fin) return [];
  const entrada = sangria(lines[primera]);
  const esLista = /^\s*-\s/.test(lines[primera]);
  const tandas = [];
  let t = null;
  for (let i = primera; i < fin; i++) {
    const l = lines[i];
    if (vacia(l)) continue;
    const s = sangria(l);
    if (s < entrada) break;
    if (s === entrada) {
      if (esLista) {
        const m = /^(\s*)-\s+(.*)$/.exec(l);
        if (!m) break;
        t = { name: null, inicio: i, fin, claveSangria: s + 2, claves: [] };
        tandas.push(t);
        const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(m[2]);
        if (kv) t.claves.push({ clave: kv[1], linea: i, valor: sinComentario(kv[2]), hijos: [] });
      } else {
        const m = /^\s*([^\s:#][^:#]*?)\s*:\s*(#.*)?$/.exec(l);
        if (!m) break;
        t = { name: sinComillas(m[1]), inicio: i, fin, claveSangria: null, claves: [] };
        tandas.push(t);
      }
      if (tandas.length > 1) tandas[tandas.length - 2].fin = i;
      continue;
    }
    if (!t) continue;
    if (t.claveSangria === null) t.claveSangria = s;
    const kv = s === t.claveSangria && /^\s*([\w-]+)\s*:\s*(.*)$/.exec(l);
    if (kv) { t.claves.push({ clave: kv[1], linea: i, valor: sinComentario(kv[2]), hijos: [] }); continue; }
    if (s > t.claveSangria && t.claves.length) t.claves[t.claves.length - 1].hijos.push(i);
  }
  for (const x of tandas) {
    if (esLista) {
      const n = x.claves.find((c) => c.clave === 'name');
      x.name = n ? sinComillas(n.valor) : null;
    }
  }
  return tandas;
}

/**
 * Los elementos de una clave de lista (`acs_pending`, `tests`…): `{ items, forma }`. `forma`: 'vacia' (sin valor y sin
 * renglones, o `null`, `~`, `""`, `[]`), 'renglon' (entre corchetes en un renglón), 'partida' (entre corchetes en varios),
 * 'renglones' (un `- x` por renglón) u 'otra' (un escalar suelto, o algo que no se lee como lista).
 */
function elementos(lines, c) {
  const v = c.valor;
  if (/^(null|~|""|'')?$/.test(v) && !c.hijos.some((i) => !vacia(lines[i]))) return { items: [], forma: 'vacia' };
  if (v.startsWith('[')) {
    let texto = v;
    let r = listaEnLinea(texto);
    if (r.cerrada) return { items: r.items, forma: r.items.length ? 'renglon' : 'vacia' };
    for (const i of c.hijos) { texto += ` ${sinComentario(lines[i].trim())}`; r = listaEnLinea(texto); if (r.cerrada) break; }
    return { items: r.items, forma: r.cerrada ? 'partida' : 'otra' };
  }
  if (!v) {
    const items = c.hijos.map((i) => /^\s*-\s+(.*)$/.exec(lines[i])).filter(Boolean).map((m) => sinComillas(sinComentario(m[1])));
    return { items, forma: items.length ? 'renglones' : 'otra' };
  }
  return { items: [sinComillas(v)], forma: 'otra' };
}

/** El renglón donde empieza el bloque `pipelines:` en el frontmatter partido en renglones, o -1. */
const inicioDelBloque = (lines) => lines.findIndex((l) => /^pipelines\s*:\s*(#.*)?$/.test(l));

module.exports = { leerTandas, elementos, inicioDelBloque, listaEnLinea, sinComentario, sinComillas };
