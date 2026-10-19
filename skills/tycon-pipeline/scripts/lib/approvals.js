'use strict';
/**
 * approvals — el registro de aprobaciones de una corrida: qué se aprobó, cuándo, sobre qué commit, y si lo aprobó una
 * persona con nombre (manual) o un agente o una regla (automática).
 *
 * Una línea JSON por aprobación en `<carpeta de la corrida>/approvals.jsonl`:
 *   { que, cuando, commit, tipo: 'manual' | 'automatica', quien, via, delegacion? }
 *
 * La regla del tipo, la que el portón de CI vuelve a mirar:
 *   - manual exige una persona con nombre (su correo o su usuario);
 *   - un agente, una regla o una delegación de una persona a un agente es siempre automática: la aprobación de un
 *     agente nunca cuenta como la de una persona, aunque actúe por delegación;
 *   - sin tipo o sin quién, automática con quien «sin nombrar».
 *
 * Quien escribe (marker.js) normaliza: un agente anotado como manual se guarda automático. Quien lee (el portón)
 * valida: una línea escrita a mano con un agente como manual frena el merge.
 */

const fs = require('fs');
const path = require('path');

const FILE = 'approvals.jsonl';
const SIN_NOMBRAR = 'sin nombrar';
const TIPOS = new Set(['manual', 'automatica']);

// Un «quién» que nombra a un agente, un modelo o una regla. Una persona se nombra con su correo o su usuario. Ante la
// duda la línea queda automática (decisión de la story: la opción más segura). Por eso un usuario que se llama como un
// rol de agente («coordinadora», «claude») queda automático; un correo de persona no (salvo los `noreply`).
const ES_AGENTE = [
  /^(agente|agent|regla|subagente|bot)\b/i,
  /\b(claude|opus|sonnet|haiku|fable|codex|gpt|gemini|llm|coordinadora|coordinador|subagente|agente)\b/i,
  /(^|[-_.\s])bot$/i,
  /^tycon-/i,
  /-(reviewer|checker|hunter|auditor|advisor|validator|capturer|analyzer|tracker|agent)$/i,
];
// Los agentes que trae Claude Code y no viven en una carpeta `agents/`.
const AGENTES_DE_FABRICA = ['general-purpose', 'explore', 'plan', 'statusline-setup', 'claude-code-guide'];
const NOREPLY = /^(no-?reply|noreply\+?[^@]*|.*bot)@/i;
const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

let conocidos = null;
// Los nombres de los agentes del arnés: `agents/*.md` y `packs/*/agents/*.md` del mismo checkout. Así un revisor nuevo
// no necesita entrar a una lista escrita a mano para no pasar por persona.
function agentesConocidos() {
  if (conocidos) return conocidos;
  conocidos = new Set(AGENTES_DE_FABRICA);
  const raiz = path.join(__dirname, '..', '..', '..', '..');
  const carpetas = [path.join(raiz, 'agents')];
  // Una carpeta ausente es normal (un checkout sin paquetes). Cualquier otro error achica la lista y deja pasar a un
  // agente conocido sólo por su nombre: se dice, una vez (los patrones de arriba siguen valiendo).
  const avisar = (donde, e) => { process.stderr.write(`⚠️  approvals: no pude leer ${donde} (${e.code || e.message}): la lista de agentes conocidos queda incompleta.\n`); };
  try { for (const p of fs.readdirSync(path.join(raiz, 'packs'))) carpetas.push(path.join(raiz, 'packs', p, 'agents')); } catch (e) { if (e.code !== 'ENOENT') avisar('packs/', e); }
  for (const c of carpetas) {
    try { for (const f of fs.readdirSync(c)) if (f.endsWith('.md')) conocidos.add(f.slice(0, -3).toLowerCase()); } catch (e) { if (e.code !== 'ENOENT') avisar(path.relative(raiz, c) || c, e); }
  }
  return conocidos;
}

function texto(v) { return typeof v === 'string' ? v.trim() : ''; }

function esAgente(quien) {
  const q = texto(quien);
  if (!q) return false;
  if (CORREO.test(q)) return NOREPLY.test(q);
  if (agentesConocidos().has(q.toLowerCase())) return true;
  return ES_AGENTE.some((re) => re.test(q));
}

/** Las líneas de una firma por terminal (`marker.js runtime-waiver`): manual, una por AC, a nombre de quien firmó. */
function lineasDeFirmaPorTerminal(acs, firmante) {
  return (acs || []).map((n) => ({ que: `AC ${n} imposible de verificar en vivo`, via: 'runtime-waiver (terminal)', tipo: 'manual', quien: firmante }));
}

/** El tipo, el quién y la delegación a partir de las opciones del marcador (`--approved-by`, `--delegated-by`, `--agent`). */
function quienDesdeOpciones({ approvedBy, delegatedBy, agent, regla } = {}) {
  const deleg = texto(delegatedBy);
  if (deleg) {
    const ag = texto(agent);
    return { tipo: 'automatica', quien: ag ? (/^agente\b/i.test(ag) ? ag : `agente ${ag}`) : `agente ${SIN_NOMBRAR}`, delegacion: deleg };
  }
  if (texto(regla)) return { tipo: 'automatica', quien: `regla ${texto(regla)}` };
  const persona = texto(approvedBy);
  if (persona) return { tipo: esAgente(persona) ? 'automatica' : 'manual', quien: persona };
  return { tipo: 'automatica', quien: SIN_NOMBRAR };
}

/** La línea tal como se guarda: con la regla del tipo aplicada. */
function normalizar(e) {
  const quien = texto(e && e.quien);
  const delegacion = texto(e && e.delegacion);
  let tipo = e && e.tipo === 'manual' && quien && !delegacion && !esAgente(quien) && quien !== SIN_NOMBRAR ? 'manual' : 'automatica';
  if (!quien) tipo = 'automatica';
  const out = {
    que: texto(e && e.que) || '(sin decir)',
    cuando: texto(e && e.cuando) || new Date().toISOString(),
    commit: texto(e && e.commit) || null,
    tipo,
    quien: quien || SIN_NOMBRAR,
    via: texto(e && e.via) || null,
  };
  if (delegacion) out.delegacion = delegacion;
  return out;
}

/** Los problemas de una línea leída del registro. Vacío = válida. */
function validar(e) {
  const p = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [{ regla: 'registro-de-aprobaciones-invalido', detalle: 'una línea no es un objeto' }];
  if (!texto(e.que)) p.push({ regla: 'registro-de-aprobaciones-invalido', detalle: 'una línea no dice qué se aprobó' });
  if (!texto(e.cuando)) p.push({ regla: 'registro-de-aprobaciones-invalido', detalle: `«${texto(e.que) || '?'}» no dice cuándo` });
  if (!TIPOS.has(e.tipo)) p.push({ regla: 'registro-de-aprobaciones-invalido', detalle: `«${texto(e.que) || '?'}» tiene tipo ${JSON.stringify(e.tipo)} (es manual o automatica)` });
  if (e.tipo === 'manual') {
    const quien = texto(e.quien);
    if (!quien || quien === SIN_NOMBRAR) {
      p.push({ regla: 'aprobacion-de-agente-como-manual', detalle: `«${texto(e.que)}» figura manual sin una persona con nombre` });
    } else if (texto(e.delegacion)) {
      p.push({ regla: 'aprobacion-de-agente-como-manual', detalle: `«${texto(e.que)}» figura manual y la dio un agente por delegación de ${texto(e.delegacion)}` });
    } else if (esAgente(quien)) {
      p.push({ regla: 'aprobacion-de-agente-como-manual', detalle: `«${texto(e.que)}» figura manual y la dio un agente o una regla («${quien}»)` });
    }
  }
  return p;
}

/** Agrega una línea al registro de la carpeta de la corrida. Devuelve la línea guardada; lanza si no puede escribir. */
function anotar(runDir, e) {
  const linea = normalizar(e);
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(path.join(runDir, FILE), JSON.stringify(linea) + '\n');
  return linea;
}

/** Lee el registro: { existe, lineas, ilegibles } — una línea que no es JSON se cuenta, no se descarta en silencio. */
function leer(runDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(runDir, FILE), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { existe: false, lineas: [], ilegibles: 0 };
    return { existe: true, lineas: [], ilegibles: 0, error: e.code || e.message };
  }
  const lineas = [];
  let ilegibles = 0;
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { lineas.push(JSON.parse(l)); } catch (_e) { ilegibles++; }
  }
  return { existe: true, lineas, ilegibles };
}

function resumir(lineas) {
  const r = { manual: 0, automatica: 0, sinNombrar: 0 };
  for (const l of lineas) {
    if (l && l.tipo === 'manual') r.manual++; else r.automatica++;
    if (l && l.tipo !== 'manual' && (!texto(l.quien) || texto(l.quien) === SIN_NOMBRAR)) r.sinNombrar++;
  }
  return r;
}

module.exports = { FILE, SIN_NOMBRAR, esAgente, lineasDeFirmaPorTerminal, quienDesdeOpciones, normalizar, validar, anotar, leer, resumir };
