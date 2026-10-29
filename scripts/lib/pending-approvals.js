'use strict';
/**
 * pending-approvals.js — un pendiente nuevo en la lista de pendientes lleva una aprobación firmada.
 *
 * La lista (`tasks/todo.md`) tiene un renglón `- [ ] [CÓDIGO] …` por pendiente abierto, al principio de la línea. Un
 * pendiente abierto vale sólo si su código está en el registro de aprobaciones (`tasks/pending-approvals.jsonl`), y un
 * código va abierto una sola vez. Las líneas son de dos clases:
 *   · de base (`via: "base"`): los pendientes que ya estaban abiertos cuando nació el registro. La base sólo se achica:
 *     el commit frena una línea de base nueva, salvo en el commit que crea el registro, y ahí sólo para un pendiente
 *     que ya estaba abierto antes de ese commit.
 *   · firmadas: las escribe `marker.js approve-pending --id <CÓDIGO>` después de la firma `pending-approval` (la
 *     coordinadora por la delegación del perfil, o la persona en la ventana de permiso o en su terminal). La huella de
 *     la línea va en el renglón `pending-approval-signed` del registro del arnés de la cuenta.
 * Un renglón abierto sin código no tiene cómo aprobarse: se le pone uno. Los cuatro sin código que ya estaban entran a
 * la base por la huella de su texto.
 *
 * Dos lecturas:
 *   · `revisar`: todo pendiente abierto tiene su línea, y toda línea está sana (sus campos, su huella). La corre la
 *     revisión de la noche, que no ve el registro del arnés de ninguna máquina.
 *   · `revisarNuevas`: lo que trae un commit. Cada pendiente que se abre en el commit —un renglón nuevo, o uno tachado
 *     que vuelve a `- [ ]`— trae su aprobación firmada en el mismo commit, con su renglón en el registro del arnés de
 *     esta cuenta: un código que ya tenía aprobación no sirve para abrir otro pendiente. La corre el pre-commit, junto
 *     con `revisar` sobre lo que se va a commitear.
 * La revisión de la noche no ve el registro del arnés ni la historia: una línea fabricada, o un pendiente reabierto con
 * un código ya aprobado, que llegan a main sin el pre-commit, no los ve.
 *
 * Límite: un proceso con el mismo usuario puede escribir el registro del arnés. El freno de la herramienta de edición y
 * el de la terminal paran la escritura a mano del registro de aprobaciones (`story-gate.js` `signedRecordKind`); un
 * `open()` desde un intérprete, no.
 */
const crypto = require('crypto');

const TODO = 'tasks/todo.md';
const RECORD = 'tasks/pending-approvals.jsonl';
const FIRMA = 'pending-approval';
const FIRMADA = `${FIRMA}-signed`;
const VIAS = ['delegacion', 'ventana', 'terminal'];
// el código de un pendiente: lo que va entre corchetes al principio del renglón
const CODIGO = /^[A-Za-z0-9._-]+$/;
// una casilla abierta de primer nivel, con cualquiera de las tres viñetas de markdown; con dos espacios o más adelante es
// un paso de otro pendiente
const ABIERTO = /^ ?[-*+][ \t]+\[ \][ \t]+(.*)$/;

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/** La clave de un renglón abierto sin código: la huella de su texto, sin los espacios de más. */
const claveSinCodigo = (texto) => `sin-codigo:${sha(String(texto).replace(/\s+/g, ' ').trim()).slice(0, 12)}`;

/** Los pendientes abiertos de la lista: `[{ clave, codigo, linea, numero }]`, con `codigo` null en los que no tienen. */
function pendientesAbiertos(texto) {
  const out = [];
  String(texto || '').split('\n').forEach((l, i) => {
    const m = ABIERTO.exec(l.replace(/\r$/, ''));
    if (!m) return;
    const c = /^\[([^\]]+)\]/.exec(m[1]);
    const codigo = c && CODIGO.test(c[1]) ? c[1] : null;
    out.push({ clave: codigo || claveSinCodigo(m[1]), codigo, linea: l.replace(/\r$/, ''), numero: i + 1 });
  });
  return out;
}

/** El registro: `{ lineas: [{ texto, valor, numero }], ilegibles: [número de renglón] }`. */
function leerRegistro(texto) {
  const lineas = [];
  const ilegibles = [];
  String(texto || '').split('\n').forEach((l, i) => {
    const t = l.replace(/\r$/, '');
    if (!t.trim()) return;
    try { lineas.push({ texto: t, valor: JSON.parse(t), numero: i + 1 }); } catch (_) { ilegibles.push(i + 1); }
  });
  return { lineas, ilegibles };
}

/** La huella de una línea firmada: el código, la hora y la máquina, 16 hex. */
const huella = (l) => sha(JSON.stringify([l && l.id, l && l.ts, (l && l.maquina) || null].map((v) => (v == null ? null : String(v))))).slice(0, 16);

/** La línea firmada que escribe `approve-pending`, sin la vía ni quién (los pone la firma). */
function lineaNueva({ id, maquina = null, ahora = Date.now() }) {
  const l = { id: String(id), ts: new Date(ahora).toISOString(), maquina: maquina || null };
  l.huella = huella(l);
  return l;
}

/** Por qué una línea del registro no vale, o null. */
function motivoDe(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return 'no es una aprobación';
  if (typeof l.id !== 'string' || !(CODIGO.test(l.id) || /^sin-codigo:[0-9a-f]{12}$/.test(l.id))) return 'no nombra el código del pendiente';
  if (l.via === 'base') return null;
  if (!VIAS.includes(l.via) || !l.quien || !l.ts) return 'le falta un campo (vía, quién u hora)';
  if (l.huella !== huella(l)) return 'su huella no coincide con lo que dice (se cambió después de firmarla)';
  return null;
}

/**
 * Lo que la lista tiene abierto sin aprobación, y lo que el registro tiene roto. `{ ok, faltan: [pendiente], rotas:
 * [{ numero, motivo }], sinCodigo: [pendiente], repetidos: [pendiente] }`; `sinCodigo` son los abiertos sin código que
 * tampoco están en la base; `repetidos`, los renglones abiertos con un código que ya va abierto más arriba.
 */
function revisar({ todo, registro }) {
  const r = leerRegistro(registro);
  const rotas = r.ilegibles.map((numero) => ({ numero, motivo: 'no se lee (no es JSON)' }));
  const aprobados = new Set();
  r.lineas.forEach((x) => {
    const m = motivoDe(x.valor);
    if (m) rotas.push({ numero: x.numero, motivo: m, id: x.valor && x.valor.id });
    else aprobados.add(x.valor.id);
  });
  const todos = pendientesAbiertos(todo);
  const vistos = new Set();
  const repetidos = todos.filter((p) => (vistos.has(p.clave) ? true : (vistos.add(p.clave), false)));
  const abiertos = todos.filter((p) => !aprobados.has(p.clave));
  const faltan = abiertos.filter((p) => p.codigo);
  const sinCodigo = abiertos.filter((p) => !p.codigo);
  return { ok: !faltan.length && !sinCodigo.length && !rotas.length && !repetidos.length, faltan, rotas, sinCodigo, repetidos };
}

/** ¿El registro del arnés tiene el renglón firmado de esta línea? */
function firmadaEnElRegistro(l, renglones) {
  return renglones.some((g) => g && g.name === FIRMADA && g.status === 'ok' && g.via === l.via
    && String(g.resumen || '').startsWith(`huella ${l.huella} `));
}

/** Los renglones de la firma en el texto del registro del arnés (los demás no se leen). */
function renglonesDeFirma(texto) {
  const out = [];
  for (const l of String(texto || '').split('\n')) {
    if (!l.includes(FIRMADA)) continue;
    try { out.push(JSON.parse(l)); } catch (_) { /* un renglón roto no firma */ }
  }
  return out;
}

/**
 * Lo que trae un commit que no vale: `[{ id, motivo }]`. `antes`/`despues` son el registro en el último commit y en el
 * que se arma; `todoAntes`/`todoDespues`, la lista. Una línea nueva del registro vale firmada con su renglón en
 * `renglones`, o de base sólo en el commit que crea el registro y para un pendiente abierto en `todoAntes`. Cada
 * pendiente que se abre en el commit necesita una línea firmada nueva, válida, con su código.
 */
function revisarNuevas({ antes, despues, renglones, todoAntes = '', todoDespues = '' }) {
  const previas = new Set(leerRegistro(antes).lineas.map((x) => x.texto));
  const nacimiento = !leerRegistro(antes).lineas.length;
  const abiertosAntes = new Set(pendientesAbiertos(todoAntes).map((p) => p.clave));
  const malas = [];
  const firmadasNuevas = new Set();
  for (const x of leerRegistro(despues).lineas) {
    if (previas.has(x.texto)) continue;
    const l = x.valor;
    const id = l && l.id;
    const m = motivoDe(l);
    if (m) malas.push({ id, motivo: m });
    else if (l.via === 'base') {
      if (!nacimiento) malas.push({ id, motivo: 'es una línea de base nueva, y la base sólo se achica' });
      else if (!abiertosAntes.has(id)) malas.push({ id, motivo: 'es una línea de base para un pendiente que no estaba abierto antes de este commit' });
    } else if (!firmadaEnElRegistro(l, renglones)) malas.push({ id, motivo: `no tiene su renglón ${FIRMADA} en el registro del arnés de esta cuenta (no se firmó en esta máquina)` });
    else firmadasNuevas.add(id);
  }
  for (const p of pendientesAbiertos(todoDespues)) {
    if (abiertosAntes.has(p.clave) || firmadasNuevas.has(p.clave)) continue;
    // sin código ya lo nombra `revisar`; acá, el código que se abre con una aprobación vieja
    if (p.codigo) malas.push({ id: p.codigo, motivo: `se abre en este commit (renglón ${p.numero}) y no trae su aprobación firmada en este commit: una aprobación vieja de ese código no abre otro pendiente` });
  }
  return malas;
}

/** Los comandos que piden la firma de un pendiente: el de la coordinadora (delegación) o la ventana, y el de la terminal. */
function comandos(id, repo, sesion) {
  const base = `marker.js approve-pending --id ${id}${repo ? ` --repo ${repo}` : ''}`;
  return [`${base} --for-session ${sesion || '<tu sesión>'}`, `${base} --terminal`];
}

module.exports = {
  TODO, RECORD, FIRMA, FIRMADA, VIAS, claveSinCodigo, pendientesAbiertos, leerRegistro, huella, lineaNueva, motivoDe,
  revisar, revisarNuevas, renglonesDeFirma, firmadaEnElRegistro, comandos,
};
