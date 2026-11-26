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
function leerTandas(lineas, start) {
  if (start < 0) return [];
  // un final CRLF no es parte del renglón: con el `\r`, ninguna clave se reconoce y no aparece ninguna tanda
  const lines = lineas.map((l) => String(l).replace(/\r$/, ''));
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
        // las claves van donde empieza la del guion (`- name`, o `-  name` con más espacios)
        t = { name: null, inicio: i, fin, claveSangria: l.length - m[2].length, claves: [] };
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
    const ultima = t.claves[t.claves.length - 1];
    // la secuencia compacta de YAML: los `- x` a la misma sangría que su clave, si la clave quedó sin valor en su renglón
    const compacta = s === t.claveSangria && /^\s*-(\s|$)/.test(l) && ultima && !ultima.valor && ultima.hijos.every((h) => /^\s*-(\s|$)/.test(lines[h]) || vacia(lines[h]));
    if ((s > t.claveSangria || compacta) && ultima) ultima.hijos.push(i);
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
    // la lista entre corchetes en el renglón de abajo
    const primero = c.hijos.find((i) => !vacia(lines[i]));
    if (primero !== undefined && lines[primero].trim().startsWith('[')) {
      let texto = '';
      let r = { items: [], cerrada: false };
      for (const i of c.hijos) { if (i < primero) continue; texto += ` ${sinComentario(lines[i].trim())}`; r = listaEnLinea(texto); if (r.cerrada) break; }
      return { items: r.items, forma: r.cerrada ? 'partida' : 'otra' };
    }
    const items = c.hijos.map((i) => /^\s*-\s+(.*)$/.exec(lines[i])).filter(Boolean).map((m) => sinComillas(sinComentario(m[1])));
    return { items, forma: items.length ? 'renglones' : 'otra' };
  }
  return { items: [sinComillas(v)], forma: 'otra' };
}

/** El renglón donde empieza el bloque `pipelines:` en el frontmatter partido en renglones, o -1. */
const inicioDelBloque = (lines) => lines.findIndex((l) => /^pipelines\s*:\s*(#.*)?$/.test(l));

/** Los pendientes de una tanda: `{ acs, tasks, tests }`, cada uno con sus elementos (vacío si no hay). */
function pendientesDe(lines, t) {
  const out = { acs: [], tasks: [], tests: [] };
  for (const c of t.claves) {
    const m = /^(acs|tasks|tests)_pending$/.exec(c.clave);
    if (m) out[m[1]].push(...elementos(lines, c).items);
  }
  return out;
}

/**
 * Las tandas `done` de una historia que todavía declaran criterios, tareas o pruebas pendientes: `[{ name, cuantos }]`.
 * Lo usan el control de historias (la regla de las tandas done con pendientes) y el cierre de tanda.
 */
function tandasDoneConPendientes(content) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || '');
  if (!fm) return [];
  const lines = fm[1].split(/\r?\n/);
  const out = [];
  for (const t of leerTandas(lines, inicioDelBloque(lines))) {
    const st = t.claves.find((c) => c.clave === 'status');
    if (!st || sinComillas(st.valor) !== 'done') continue;
    const p = pendientesDe(lines, t);
    const cuantos = p.acs.length + p.tasks.length + p.tests.length;
    if (cuantos > 0) out.push({ name: t.name || '(sin nombre)', cuantos });
  }
  return out;
}

module.exports = { leerTandas, elementos, inicioDelBloque, listaEnLinea, sinComentario, sinComillas, pendientesDe, tandasDoneConPendientes };
