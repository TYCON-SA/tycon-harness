'use strict';
/**
 * commit-story.js — ¿de qué historia es la rama de una fusión?
 *
 * Git no guarda de qué historia es un commit. Lo más firme es el asunto que escribe la plataforma al fusionar un pedido, que
 * nombra la rama, y que esa rama nombre a una sola historia del catálogo. Hay tres respuestas: la propia, otra o no se sabe.
 * Quien pregunta trata «no se sabe» como un cambio que la evidencia no probó.
 *
 * El nombre de la rama lo escribe una persona: una rama mal nombrada engaña a esta respuesta. El título de `Merged PR N:` no
 * cuenta, porque es texto libre: `fix 1.2 redondeo` no dice que sea de la historia 1.2.
 *
 * Con las ramas por sesión (`wt/<sesión>`) la rama no dice nada. La regla de la entrada (lib/evidence-vs-commit.js) suma dos
 * datos: el número de pedido del asunto, cruzado con el registro de pedidos, y los asuntos de los commits de la fusión. Esos
 * asuntos son texto libre, así que `nombraLaHistoria` sólo sirve para decir «es propia», que vence de más y nunca deja pasar.
 */
const path = require('path');
const { ramaNombraLaStory } = require('./companion-repos.js');
const { claveDePedido } = require('./story-requests.js');

const ASUNTO_DE_PEDIDO = /^Merge pull request (#?)\d+ from (\S+?)(?: into \S+)?$/;
const ASUNTOS_CON_NUMERO = [/^Merge pull request #?(\d+) from \S/, /^Merged PR (\d+):/];

/** La rama del asunto que escribe la plataforma al fusionar un pedido, o null. En GitHub va precedida por la organización. */
function ramaDelAsunto(asunto) {
  const m = String(asunto || '').match(ASUNTO_DE_PEDIDO);
  if (!m || m[2].includes(':')) return null;
  return m[1] ? m[2].replace(/^[^/]+\//, '') : m[2];
}

const palabrasDe = (texto) => String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** Las palabras que siguen al número en un nombre: `<rama>-6-1-fondos` y `6.1` dan `['fondos']`. Con otro orden, nada. */
function palabrasTrasElNumero(nombre, numero) {
  const todas = palabrasDe(nombre);
  const delNumero = palabrasDe(numero);
  for (let i = 0; i + delNumero.length <= todas.length; i += 1) {
    if (delNumero.every((p, j) => todas[i + j] === p)) return todas.slice(i + delNumero.length);
  }
  return [];
}

/** ¿Una lista de palabras es el principio de la otra? Con al menos una palabra, y por palabras enteras. */
function coinciden(a, b) {
  const corta = a.length <= b.length ? a : b;
  const larga = corta === a ? b : a;
  return corta.length > 0 && corta.every((p, i) => larga[i] === p);
}

/**
 * De qué historia es una rama: 'propia', `{ numero }` si es otra, o null si no se sabe. `catalogo`: `[{ numero, archivo }]`.
 * Si el número se repite entre temas, las palabras de la rama tienen que coincidir con las del archivo de una sola.
 */
function historiaDeLaRama(rama, { propia, catalogo }) {
  // sin la propia en el catálogo, una rama con su número parecería de otra historia
  if (!rama || !Array.isArray(catalogo) || !catalogo.some((h) => h.archivo === propia.archivo)) return null;
  const nombradas = catalogo.filter((h) => ramaNombraLaStory(rama, h.numero));
  const numeros = new Set(nombradas.map((h) => palabrasDe(h.numero).join('.')));
  if (numeros.size !== 1) return null;
  let elegida = nombradas[0];
  if (nombradas.length > 1) {
    const deLaRama = palabrasTrasElNumero(rama, elegida.numero);
    const coincidentes = nombradas.filter((h) => coinciden(deLaRama, palabrasTrasElNumero(path.basename(h.archivo, '.md'), h.numero)));
    if (coincidentes.length !== 1) return null;
    [elegida] = coincidentes;
  }
  return elegida.archivo === propia.archivo ? 'propia' : { numero: elegida.numero };
}

/** El número de pedido del asunto que escribe la plataforma, o null. */
function pedidoDelAsunto(asunto) {
  for (const re of ASUNTOS_CON_NUMERO) {
    const m = String(asunto || '').match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * De qué historia es una fusión: 'propia' si el registro o la rama lo dicen; si no, `{ numero }` de la que digan; si no,
 * null. Un renglón de otra historia no le quita a la fusión lo que su rama dice que es propio. `pedidos`: el `porPedido` de
 * lib/story-requests.js. `propia`: `{ numero, archivo, clave }`.
 */
function historiaDeLaFusion(asunto, { repo, propia, catalogo, pedidos }) {
  const numero = pedidoDelAsunto(asunto);
  const filas = (numero && pedidos && pedidos.get(claveDePedido(repo, numero))) || [];
  if (filas.some((f) => f.clave === propia.clave)) return 'propia';
  const porRama = historiaDeLaRama(ramaDelAsunto(asunto), { propia, catalogo });
  if (porRama === 'propia') return 'propia';
  return filas.length ? { numero: filas[0].historia } : porRama;
}

/**
 * ¿El asunto de un commit nombra a la historia? Por el número entero: `9.9` no está en `9.91`, `19.9` ni `9.9.1`. Como en una
 * rama, sin distinguir mayúsculas y con punto o guion entre las partes: `8-310` es la `8.310`.
 */
function nombraLaHistoria(asunto, numero) {
  const n = String(numero).split(/[.-]/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[.-]');
  return new RegExp(`(^|[^\\w.-])${n}(?![\\w]|[.-]\\d)`, 'i').test(String(asunto || ''));
}

module.exports = { ramaDelAsunto, historiaDeLaRama, pedidoDelAsunto, historiaDeLaFusion, nombraLaHistoria };
