'use strict';
/**
 * compare-waiver — la constancia de que una persona eximió a un comando de la comparación con main (historia 8.167).
 *
 * Un candidato de la comparación (un comando que la historia modifica y que existe en main) necesita un humo comparado
 * que lo cubra o esta constancia. La escribe sólo `marker.js compare-waiver --story <historia> --command <candidato>
 * --reason <motivo>`, con la firma `compare-waiver` (nivel 1): la da el dueño, o la coordinadora cuando el perfil del
 * equipo la suma a `approvals.delegated_signing`. Nunca es una línea del frontmatter.
 *
 * Vive en `<carpeta de la corrida>/compare-waivers.jsonl`:
 *   { ts, story, command, reason, tipo: 'manual' | 'automatica', quien, delegacion?, via }
 * y vale sólo con su renglón en el `gates.log` del arnés (donde el agente no escribe), con la misma huella: una línea
 * copiada a mano al archivo de la corrida no exime.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = 'compare-waivers.jsonl';
const REGISTRO = 'compare-waiver';

const huella = (l) => crypto.createHash('sha256').update(JSON.stringify([l.story || '', l.command || '', l.reason || '', l.tipo || '', l.quien || '', l.delegacion || '', l.via || ''])).digest('hex').slice(0, 16);

/** Una constancia completa. null = válida; si no, el motivo. */
function constanciaInvalida(l) {
  if (!l || typeof l !== 'object') return 'no es un objeto';
  if (!String(l.command || '').trim()) return 'no dice el candidato';
  if (!String(l.reason || '').trim()) return 'no dice el motivo';
  if (!['manual', 'automatica'].includes(l.tipo)) return `tipo ${JSON.stringify(l.tipo)}`;
  if (!String(l.quien || '').trim()) return 'no dice quién firmó';
  if (!/terminal|ventana|delegada|click en el cuadro|«aprobado» escrito/.test(String(l.via || ''))) return 'no dice por qué vía se firmó';
  if (!String(l.ts || '').trim()) return 'no dice cuándo se anotó';
  return null;
}

/** El renglón del registro del arnés, con lo que lo ata a la constancia. */
const renglonDelRegistro = (l) => ({ ts: l.ts, name: REGISTRO, status: 'ok', story: l.story, command: l.command, tipo: l.tipo, quien: l.quien, via: l.via, huella: huella(l) });

/** ¿La anotó `marker.js compare-waiver` en esta máquina para esta historia? null = sí; si no, el motivo. */
function fueraDelRegistro(l, { stateDir, story } = {}) {
  let raw;
  try { raw = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'); } catch (e) {
    return `no pude leer el registro del arnés (${e.code || e.message})`;
  }
  for (const linea of raw.split('\n')) {
    if (!linea.includes(`"${REGISTRO}"`)) continue;
    let g; try { g = JSON.parse(linea); } catch (_) { continue; }
    if (g.name === REGISTRO && g.status === 'ok' && g.command === l.command && g.ts === l.ts && g.huella === huella(l)
      && (story == null || String(g.story) === String(story))) return null;
  }
  return 'no la anotó marker.js compare-waiver en esta máquina para esta historia';
}

/** Agrega una constancia al archivo de la corrida. Devuelve la línea guardada; lanza si no puede escribir. */
function anotar(runDir, l) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(path.join(runDir, FILE), `${JSON.stringify(l)}\n`);
  return l;
}

/** Las constancias de la corrida: `{ lineas, ilegibles }`. */
function leer(runDir) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(runDir, FILE), 'utf8'); } catch (_) { return { lineas: [], ilegibles: 0 }; }
  const lineas = [];
  let ilegibles = 0;
  for (const t of raw.split('\n')) {
    if (!t.trim()) continue;
    try { lineas.push(JSON.parse(t)); } catch (_) { ilegibles++; }
  }
  return { lineas, ilegibles };
}

/** Las exenciones que valen: Map candidato → constancia (la última válida y registrada de cada uno). */
function vigentes(runDir, { stateDir, story } = {}) {
  const out = new Map();
  if (!runDir) return out;
  for (const l of leer(runDir).lineas) {
    if (constanciaInvalida(l)) continue;
    if (story != null && String(l.story) !== String(story)) continue;
    if (fueraDelRegistro(l, { stateDir, story })) continue;
    out.set(l.command, l);
  }
  return out;
}

module.exports = { FILE, REGISTRO, huella, constanciaInvalida, renglonDelRegistro, fueraDelRegistro, anotar, leer, vigentes };
