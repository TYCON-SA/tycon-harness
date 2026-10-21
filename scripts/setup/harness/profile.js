'use strict';
/**
 * profile.js — el perfil de instalación: `minimal` o `full`.
 *
 * Qué trae cada perfil lo dice `scripts/setup/install-effects.json` (`profiles`), y lo obedecen el aplicador y el sync
 * de bloques. Acá vive lo que `harness.js` necesita para elegirlo y cambiarlo:
 *   · `resolve()` — el perfil vigente según la configuración del arnés (`install.profile`: TYCON_INSTALL_PROFILE ›
 *     ~/.claude/tycon.json › perfil del equipo). Sin valor es `full` («sin elegir»: lo de siempre). Una configuración
 *     ROTA no es `full`: devuelve `ok: false` con el motivo, y quien llama lo dice y no decide nada por el perfil.
 *   · `checkOption()` — `--profile` de `install`: un valor fuera de la lista, o una variable que dice otra cosa, sale 2
 *     (una opción que no hace efecto no pasa en silencio).
 *   · `label()` — cómo se dice: «perfil: minimal (--profile)», «perfil: full (sin elegir)».
 *   · `toRemove()` — en un cambio de perfil, lo registrado que el reporte del aplicador del perfil nuevo ya no trae
 *     (sin las piezas propias de harness.js ni las skills de terceros): eso lo quita `removePieces`, con su copia — la
 *     mecánica de la vuelta atrás, no una segunda forma de sacar piezas.
 *
 * Este archivo viaja en la copia fija del programa: no carga `scripts/lib/` por ruta relativa, recibe el árbol.
 */
const path = require('path');

const PROFILES = Object.freeze(['minimal', 'full']);
const ENV_VAR = 'TYCON_INSTALL_PROFILE';
const KEY = 'install.profile';

/** El lector de configuración del árbol: `{ C }`, o `{ reason }` si no está, es anterior a la sección `install` o no
 *  carga — con el motivo real, no uno genérico. */
function configOf(tree) {
  const file = path.join(tree, 'scripts', 'lib', 'tycon-config.js');
  let C;
  try { C = require(file); } catch (e) {
    const first = String((e && e.message) || e).split('\n')[0];
    if (e && e.code === 'MODULE_NOT_FOUND' && first.includes('tycon-config.js')) return { reason: `el árbol ${tree} no trae el lector de configuración (scripts/lib/tycon-config.js)` };
    return { reason: `el lector de configuración de ${tree} no carga (${first})` };
  }
  if (!(C && C.VOCABULARIO && C.VOCABULARIO.install)) return { reason: `el lector de configuración de ${tree} es anterior al perfil de instalación (no conoce la sección install)` };
  return { C };
}

/**
 * El perfil vigente, sin escribir nada en la HOME (se lee sin anotar los nombres viejos: lo usa también el plan).
 * @returns {{ ok: true, value: 'minimal'|'full', origin: string, chosen: boolean } | { ok: false, reason: string }}
 *   `origin`: `env` · `maquina` · `perfil` · `sin-valor` (nadie lo dijo: `full`, `chosen: false`).
 */
function resolve({ tree, home, env = process.env } = {}) {
  const lector = configOf(tree);
  if (!lector.C) return { ok: false, reason: lector.reason };
  const C = lector.C;
  let c;
  try { c = (C.sinAnotar || ((f) => f()))(() => C.cargar({ home, env })); } catch (e) { return { ok: false, reason: `falla interna del lector de configuración (${e.message})` }; }
  if (c.errores && c.errores.length) {
    return { ok: false, reason: c.errores.map((e) => `${e.archivo}${e.clave ? ` · ${e.clave}` : ''} · ${e.motivo}`).join(' | ') };
  }
  const v = c.valores && c.valores.install ? c.valores.install.profile : null;
  const origin = (c.origenes || {})[KEY] || 'sin-valor';
  // el archivo de la máquina como se le dice a la persona: `~/.tycon/config.json` donde
  // la máquina vive ahí, el de siempre donde no. Lo usa `label`; sin él, el nombre genérico
  const file = c.archivos && c.archivos.maquina && c.archivos.maquina.ruta ? c.archivos.maquina.ruta : null;
  const h = home || require('os').homedir();
  const machineFile = file ? (file.startsWith(h + path.sep) ? `~/${file.slice(h.length + 1).split(path.sep).join('/')}` : file) : null;
  if (v === null || v === undefined) return { ok: true, value: 'full', origin: 'sin-valor', chosen: false, machineFile };
  return { ok: true, value: v, origin, chosen: true, machineFile };
}

/** `--profile` de install: null si está bien; si no, la línea del error. */
function checkOption(value, env = process.env) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (!PROFILES.includes(v)) return `perfil «${v}»: tiene que ser ${PROFILES.join(' o ')}`;
  const fromEnv = env[ENV_VAR] === undefined ? '' : String(env[ENV_VAR]).trim();
  if (fromEnv && fromEnv !== v) return `--profile ${v} y la variable ${ENV_VAR}=${fromEnv} dicen cosas distintas: la variable le ganaría a lo que escriba (sacala, o pedí --profile ${fromEnv})`;
  return null;
}

/** «perfil: <valor> (<origen>)», con el origen dicho para una persona. `via`: de dónde vino lo que se va a escribir
 *  (`--profile`, o `respuesta` si se contestó la pregunta). */
function label(r, { viaOption = false, via = '--profile' } = {}) {
  if (!r || !r.ok) return `perfil: no se pudo saber (${r ? r.reason : 'sin lector'})`;
  const origin = viaOption ? via : ({ 'sin-valor': 'sin elegir', maquina: r.machineFile || 'el archivo de la máquina', env: ENV_VAR, perfil: 'perfil' }[r.origin] || r.origin);
  return `perfil: ${r.value} (${origin})`;
}

/** El perfil que la instalación registró, o `full` si es anterior a los perfiles (se comportaba como full). */
function installedValue(state) {
  return state && state.profile && PROFILES.includes(state.profile.value) ? state.profile.value : 'full';
}

/**
 * Lo que se quita al cambiar de perfil: lo registrado (`managed`) que el reporte del perfil nuevo ya no trae Y que la
 * lista de efectos dice que el perfil nuevo no trae. Las dos condiciones valen juntas:
 * «no vino en el reporte» solo no alcanza — una pieza de los dos perfiles cuyo paso está apagado a mano
 * (`TYCON_NO_COMMANDS_SYNC=1`, `TYCON_NO_CLAUDEMD_SYNC=1`) tampoco se reporta, y no es del perfil que se va. Una pieza sin
 * entrada en la lista no se quita. Tampoco las piezas propias de harness.js (`isOwn`) ni las skills de terceros (viven
 * dentro del árbol). Sin reporte no se sabe qué quedó: no se quita nada.
 */
function toRemove(managed, reported, isOwn = () => false, { effects = [], profile = null } = {}) {
  if (!Array.isArray(reported)) return [];
  const key = (p) => `${p.kind}\u0000${p.where}\u0000${p.id}`;
  const now = new Set(reported.map(key));
  const { effectFor } = require('./plan');
  const notInProfile = (p) => {
    const e = effectFor(p, effects);
    return Boolean(e && Array.isArray(e.profiles) && profile && !e.profiles.includes(profile));
  };
  return (Array.isArray(managed) ? managed : []).filter((p) => p && p.kind && p.kind !== 'third-party' && !isOwn(p) && !now.has(key(p)) && notInProfile(p));
}

module.exports = { PROFILES, ENV_VAR, KEY, resolve, checkOption, label, installedValue, toRemove };
