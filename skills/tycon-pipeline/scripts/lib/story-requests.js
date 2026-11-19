'use strict';
/**
 * story-requests.js — el registro de los pedidos de cada historia: `<clave>-pedidos.jsonl`, en su carpeta de evidencia.
 *
 * Git no dice de qué historia es una fusión, y una rama `wt/<sesión>` tampoco. El número de pedido sí lo escribe la
 * plataforma en el asunto, así que anotarlo al abrir el pedido deja esa respuesta guardada, y viaja por git con la evidencia.
 *
 * Es un archivo editable. Por eso lo lee sólo la regla de la entrada (lib/evidence-vs-commit.js), donde únicamente puede
 * decir «esta fusión es propia» y vencer de más: las reglas que aflojan el control no lo miran.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SUFIJO = '-pedidos.jsonl';

const archivoDe = (dir, clave) => path.join(dir, `${clave}${SUFIJO}`);
const claveDePedido = (repo, pedido) => `${repo}#${pedido}`;

/** El nombre del repo: el de su checkout principal, también desde un worktree. El mismo que usa el ancla de un humo. */
function nombreDelRepo(carpeta) {
  try {
    const comun = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: carpeta, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    const dir = path.resolve(carpeta, comun);
    return path.basename(path.basename(dir) === '.git' ? path.dirname(dir) : dir);
  } catch (_) {
    return null;
  }
}

const renglonValido = (r) => Boolean(r) && typeof r.historia === 'string' && typeof r.clave === 'string' && typeof r.repo === 'string'
  && Number.isInteger(r.pedido) && r.pedido > 0;

function renglonesDe(archivo) {
  return fs.readFileSync(archivo, 'utf8').split('\n').filter((l) => l.trim());
}

/** Agrega el renglón si no está. `{ escrito, archivo }`. La carpeta tiene que existir: quien llama decide qué hacer si no. */
function anotar({ dir, clave, historia, repo, pedido, ahora = new Date() }) {
  const archivo = archivoDe(dir, clave);
  let texto = '';
  try { texto = fs.readFileSync(archivo, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const repetido = texto.split('\n').filter((l) => l.trim()).some((l) => {
    try { const r = JSON.parse(l); return r.clave === clave && r.repo === repo && r.pedido === pedido; } catch (_) { return false; }
  });
  if (repetido) return { escrito: false, archivo };
  // un archivo editado a mano puede quedar sin salto final: pegado al anterior, se perderían los dos renglones
  const separador = texto && !texto.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(archivo, `${separador}${JSON.stringify({ historia, clave, repo, pedido, ts: ahora.toISOString() })}\n`);
  return { escrito: true, archivo };
}

/**
 * Todos los registros de esas carpetas. `porPedido`: Map de `<repo>#<número>` a `[{ historia, clave, ts }]`, con la hora
 * más nueva de esa historia. `ilegibles`: `[{ archivo, linea }]`, con `linea` null si no se pudo leer el archivo o la
 * carpeta entera. Una carpeta que no existe no es ilegible: la historia no tiene evidencia. Un renglón roto no tapa a los demás.
 */
function leer({ dirs }) {
  const porPedido = new Map();
  const ilegibles = [];
  for (const dir of dirs) {
    let nombres;
    try { nombres = fs.readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') ilegibles.push({ archivo: dir, linea: null }); continue; }
    for (const nombre of nombres.filter((n) => n.endsWith(SUFIJO)).sort()) {
      const archivo = path.join(dir, nombre);
      let lineas;
      try { lineas = renglonesDe(archivo); } catch (_) { ilegibles.push({ archivo, linea: null }); continue; }
      lineas.forEach((l, i) => {
        let r = null;
        try { r = JSON.parse(l); } catch (_) { r = null; }
        if (!renglonValido(r)) { ilegibles.push({ archivo, linea: i + 1 }); return; }
        const k = claveDePedido(r.repo, r.pedido);
        if (!porPedido.has(k)) porPedido.set(k, []);
        const ya = porPedido.get(k).find((x) => x.clave === r.clave);
        const ts = typeof r.ts === 'string' ? r.ts : null;
        if (!ya) porPedido.get(k).push({ historia: r.historia, clave: r.clave, ts });
        else if (ts && (!ya.ts || ts > ya.ts)) ya.ts = ts;
      });
    }
  }
  return { porPedido, ilegibles };
}

module.exports = { SUFIJO, archivoDe, claveDePedido, nombreDelRepo, anotar, leer };
