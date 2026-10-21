'use strict';

/**
 * installed-packs.js —el lector LIVIANO de los paquetes de revisores, del lado del arnés
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * Los revisores de un producto o de un cliente (convenciones de plugins Bizuit; plugins hermanos;
 * el adaptador de un cliente) viven en `packs/<nombre>/pack.json` de agent-skills, no en el código. Dos
 * scripts de este repo necesitan leerlos: `harness-audit.js` (¿está instalado cada revisor
 * que el equipo espera?) e `scripts/instincts/instinct-draft.js` (¿a qué revisor le toca una regla nueva, por su
 * prefijo?). Los dos leen de acá.
 *
 * ── POR QUÉ NO USA EL CARGADOR DEL PIPELINE ─────────────────────────────────────────────────────
 * `lib/packs.js` de tycon-pipeline valida el vocabulario cerrado y evalúa condiciones; para eso
 * necesita las banderas de `detectStack` y la carpeta de agentes. Un script del arnés no puede
 * depender de dónde está agent-skills en cada máquina (hay máquinas con otra estructura), y para
 * auditar o asignar un prefijo alcanza con descubrir y parsear. Este lector NO evalúa condiciones.
 *
 * ── LO QUE NO HACE EN SILENCIO ──────────────────────────────────────────────────────────────────
 * Un manifiesto ilegible sale en `errores` con archivo y motivo; la auditoría lo muestra como falla.
 * «No pude leerlo» nunca se convierte en «no hay paquete». La carpeta POR DEFECTO ausente (máquina sin
 * agent-skills) sí es cero paquetes, sin error: es un estado legítimo. Una `TYCON_PACKS_DIR` (o un
 * `packsDir` explícito) que apunta a una carpeta inexistente es un error: configuración rota, no «sin
 * paquetes» — el mismo criterio que el cargador del pipeline.
 *
 * Uso:
 *   const { leerPaquetes, prefijosDePaquetes } = require('./lib/installed-packs.js');
 *   leerPaquetes()  → { dir, paquetes: [{ nombre, dir, archivo, descripcion, guias, revisores: [{ agente, grupo, prefijos }], hermanos: [{ ruta, nombre }] }], errores: [{ archivo, motivo }] }
 *   prefijosDePaquetes() → { PREFIJO: agente }   (lo usa scripts/instincts/instinct-draft.js; harness-audit.js recorre leerPaquetes())
 *   siblingsFromPacks() → [{ ruta, nombre }]   (los hermanos del corral del banco; lo usa controls-bench/advisor-runner.js)
 *
 * Dónde busca: `TYCON_PACKS_DIR`, o `~/.claude/agent-skills/packs` (misma resolución que
 * `lib/packs.js` del pipeline, que toma la raíz de agent-skills desde su propia ruta).
 *
 * Las claves del manifiesto están en inglés. agent-skills se actualiza con su propio
 * pull y un paquete puede vivir fuera (`TYCON_PACKS_DIR`): un manifiesto con las claves en castellano se lee igual,
 * traducido con `readKeysDeep` (where `packs/pack.json`, el mismo del cargador del pipeline). Una clave vieja y su nueva
 * con valores distintos es un manifiesto roto (sale en `errores`). Lo que devuelve conserva su forma de siempre.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readKeysDeep } = require('./legacy-names.js');

/** El `where` de las claves del manifiesto en el mapa de nombres viejos (el mismo que usa `lib/packs.js`). */
const PACK_KEYS_WHERE = 'packs/pack.json';

function dirPaquetes() {
  return process.env.TYCON_PACKS_DIR || path.join(os.homedir(), '.claude', 'agent-skills', 'packs');
}

function leerPaquetes({ packsDir, explicito } = {}) {
  const dir = packsDir || dirPaquetes();
  const esExplicito = explicito != null ? !!explicito : (!!packsDir || !!process.env.TYCON_PACKS_DIR);
  const out = { dir, paquetes: [], errores: [] };
  let entradas;
  try {
    entradas = fs.readdirSync(dir);
  } catch (e) {
    const noExiste = e && e.code === 'ENOENT';
    if (noExiste && !esExplicito) return out;   // la carpeta por defecto ausente: cero paquetes, sin error
    out.errores.push({
      archivo: dir,
      motivo: noExiste
        ? 'la carpeta de paquetes no existe (TYCON_PACKS_DIR apunta a una carpeta inexistente: configuración rota, no «sin paquetes»)'
        : `no se pudo leer la carpeta de paquetes (${(e && e.code) || e.message})`,
    });
    return out;
  }
  for (const nombre of entradas.sort()) {
    const carpeta = path.join(dir, nombre);
    const archivo = path.join(carpeta, 'pack.json');
    let esDir = false;
    try { esDir = fs.statSync(carpeta).isDirectory(); } catch (_e) { esDir = false; }
    if (!esDir || !fs.existsSync(archivo)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    } catch (e) {
      out.errores.push({ archivo, motivo: `JSON inválido o ilegible: ${e.message}` });
      continue;
    }
    try {
      json = readKeysDeep(json, PACK_KEYS_WHERE);
    } catch (e) {
      out.errores.push({ archivo, motivo: `claves viejas y nuevas en conflicto: ${e.message}` });
      continue;
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.reviewers)) {
      out.errores.push({ archivo, motivo: 'el manifiesto no tiene la lista «reviewers»' });
      continue;
    }
    // lo que devuelve conserva la forma de siempre (la usan harness-audit, instinct-draft y el banco)
    const revisores = [];
    let roto = null;
    // lo que el manifiesto nombra no saca a nadie del árbol (la misma regla que el cargador del pipeline): un agente con
    // la forma de un nombre, la carpeta de agentes adentro del paquete y las guías relativas al árbol
    const fueraDelArbol = (r) => typeof r !== 'string' || !r.trim() || path.isAbsolute(r) || r.includes('\\') || r.split('/').some((t) => t === '..' || t === '');
    if (json.agents != null && fueraDelArbol(json.agents)) roto = `«agents» (${json.agents}) tiene que ser una carpeta del paquete, sin «..»`;
    for (const g of Array.isArray(json.guides) ? json.guides : []) if (!roto && fueraDelArbol(g)) roto = `«guides»: «${g}» tiene que ser relativa al árbol, sin «..»`;
    for (const r of roto ? [] : json.reviewers) {
      if (!r || typeof r.agent !== 'string' || typeof r.group !== 'string') { roto = 'un revisor sin «agent» o sin «group»'; break; }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.agent)) { roto = `el revisor «${r.agent}» no tiene la forma de un nombre de agente`; break; }
      revisores.push({
        agente: r.agent,
        grupo: r.group,
        prefijos: Array.isArray(r.prefixes) ? r.prefixes.filter((p) => typeof p === 'string') : [],
      });
    }
    if (roto) { out.errores.push({ archivo, motivo: roto }); continue; }
    const hermanos = leerHermanos(json.siblings);
    if (hermanos.motivo) { out.errores.push({ archivo, motivo: hermanos.motivo }); continue; }
    out.paquetes.push({
      nombre: typeof json.name === 'string' && json.name ? json.name : nombre,
      dir: carpeta,
      archivo,
      descripcion: typeof json.description === 'string' ? json.description : '',
      guias: Array.isArray(json.guides) ? json.guides.filter((g) => typeof g === 'string') : [],
      // la carpeta de agentes DEL paquete (clave `agents`), o null: sus revisores se buscan ahí antes que en la raíz
      agentes: typeof json.agents === 'string' && json.agents ? path.join(carpeta, json.agents) : null,
      revisores,
      hermanos: hermanos.lista,
    });
  }
  return out;
}

/**
 * `siblings` del manifiesto: los plugins hermanos que el banco fabrica en su corral. Las mismas
 * reglas que valida `packs.js` en agent-skills: una lista de { path relativa sin «..», name identificador }. Mal
 * formado es un error del paquete (con su motivo), no una lista a medias. Devuelve { ruta, nombre } (la forma de siempre).
 */
function leerHermanos(valor) {
  if (valor == null) return { lista: [] };
  if (!Array.isArray(valor)) return { motivo: '«siblings» (los hermanos) tiene que ser una lista de { path, name }' };
  const lista = [];
  for (const [i, h] of valor.entries()) {
    const ruta = h && typeof h.path === 'string' ? h.path : '';
    if (!ruta.trim() || path.isAbsolute(ruta) || ruta.includes('\\') || ruta.split('/').some((s) => s === '..' || s === '')) {
      return { motivo: `«siblings»[${i}] (hermanos): la ruta tiene que ser relativa, sin «..» ni tramos vacíos` };
    }
    if (!(h && typeof h.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(h.name))) {
      return { motivo: `«siblings»[${i}] (hermanos): el nombre tiene que ser un identificador` };
    }
    lista.push({ ruta, nombre: h.name });
  }
  return { lista };
}

/**
 * Los hermanos del corral del banco: los de todos los paquetes instalados, en orden. Sin paquetes, ninguno.
 * Un paquete roto (o una carpeta explícita que no existe) TIRA nombrando archivo y motivo: un corral armado a
 * medias se ve igual que «no hay paquete de clientes», y el revisor de hermanos correría sin hermanos sin que nada lo
 * diga (un paquete roto no degrada a «sin ese paquete»).
 */
function siblingsFromPacks(opts) {
  const { paquetes, errores } = leerPaquetes(opts);
  if (errores.length) {
    throw new Error(`paquetes de revisores rotos — el corral de hermanos no se arma a medias: ${errores.map((e) => `${e.archivo}: ${e.motivo}`).join(' · ')}`);
  }
  return paquetes.flatMap((p) => p.hermanos);
}

/** Mapa prefijo de regla → agente, según los manifiestos instalados. El primero que lo declara gana. */
function prefijosDePaquetes(opts) {
  const { paquetes } = leerPaquetes(opts);
  const mapa = {};
  for (const p of paquetes) {
    for (const r of p.revisores) {
      for (const pref of r.prefijos) if (!(pref in mapa)) mapa[pref] = r.agente;
    }
  }
  return mapa;
}

module.exports = { dirPaquetes, leerPaquetes, prefijosDePaquetes, siblingsFromPacks };
