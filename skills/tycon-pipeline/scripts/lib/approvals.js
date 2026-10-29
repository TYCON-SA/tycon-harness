'use strict';
/**
 * approvals — el registro de aprobaciones de una corrida: qué se aprobó, cuándo, sobre qué commit, y si lo aprobó una
 * persona con nombre (manual) o un agente o una regla (automática).
 *
 * Una línea JSON por aprobación en `<carpeta de la corrida>/approvals.jsonl`:
 *   { que, cuando, commit, tipo: 'manual' | 'automatica', quien, via, delegacion?, cita?, cita_cuando? }
 * `cita` y `cita_cuando`: las palabras de la persona tal como están en la conversación, y la hora de ese
 * mensaje, cuando la aprobación salió de un ok escrito en el chat.
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
// un bot se nombra «bot» como palabra (`ci-bot@`, `bot@`, `release.bot@`), no por terminar en esas letras (`talbot@`)
const NOREPLY = /^(no-?reply|noreply\+?[^@]*|(?:[^@]*[-_.+])?bot)@/i;
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
  // Sólo las carpetas: un archivo suelto de packs/ (su README) no es un paquete.
  try { for (const p of fs.readdirSync(path.join(raiz, 'packs'), { withFileTypes: true })) if (p.isDirectory()) carpetas.push(path.join(raiz, 'packs', p.name, 'agents')); } catch (e) { if (e.code !== 'ENOENT') avisar('packs/', e); }
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
  // la firma pedida desde otra sesión: la sesión que la pidió
  const por = texto(e && e.por);
  if (por) out.por = por;
  const cita = texto(e && e.cita);
  if (cita) {
    out.cita = cita;
    if (texto(e && e.cita_cuando)) out.cita_cuando = texto(e.cita_cuando);
  }
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

/** El día desde el que la corrida copia su registro al repo de la story (AAAAMMDD). */
const DESDE_EN_LA_STORY = '20261026';

/**
 * La fecha (AAAAMMDD) del nombre de una carpeta de corrida, o null. Hay dos formas en los repos reales:
 * `1.1-AAAAMMDDhhmmss` y `4.2-AAAAMMDD-hhmm`.
 */
function selloDeCorrida(nombre) {
  const m = String(nombre).match(/-(\d{8})(?:-?\d*)?$/);
  return m ? m[1] : null;
}

/**
 * Si la corrida de `dir` es anterior a `DESDE_EN_LA_STORY` por algo que el agente no elige: el nombre trae una fecha
 * anterior Y su `review-roster.json` entró antes de ese día en la historia de `ref` (la base del pedido en el portón,
 * `origin/main` en la máquina). Un nombre viejo sin ese rastro, una ref que no existe o un git que falla: no es anterior.
 */
function anteriorAlControl(dir, nombre, ref = 'origin/main') {
  const sello = selloDeCorrida(nombre);
  if (!sello || sello >= DESDE_EN_LA_STORY || !ref) return false;
  let salida;
  try {
    salida = require('child_process').execFileSync('git', ['-C', dir, 'log', ref, '--diff-filter=A', '--format=%cs', '--', 'review-roster.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_e) { return false; }
  const fechas = salida.split('\n').map((l) => l.trim().replace(/-/g, '')).filter((l) => /^\d{8}$/.test(l));
  return fechas.length > 0 && fechas[fechas.length - 1] < DESDE_EN_LA_STORY;
}

/**
 * Lo que le falta al registro de una corrida, con la regla que aplican el portón de CI y el cierre del pipeline.
 * `registro` es lo que devuelve `leer`; `roster`, el `review-roster.json` de la misma carpeta (o null). La ausencia
 * cuenta sólo si la corrida declara que la hizo un arnés que anota aprobaciones (`roster.registro_aprobaciones`) y no
 * es `anterior` al control (`anteriorAlControl`): antes de `DESDE_EN_LA_STORY` el registro quedaba sólo en el repo del
 * código y el repo de la story no pudo recibirlo. Un registro presente y malo cuenta siempre.
 * Devuelve la lista en orden: registro ilegible, registro ausente, plan sin anotar. Vacía = no falta nada.
 */
function problemasDelRegistro({ registro, roster, anterior = false }) {
  const p = [];
  const exigible = !!(roster && roster.registro_aprobaciones) && !anterior;
  if (registro.error || registro.ilegibles) {
    p.push({ regla: 'registro-de-aprobaciones-invalido',
      detalle: registro.error ? `no se puede leer (${registro.error})` : `tiene ${registro.ilegibles} línea(s) que no son JSON` });
  }
  if (!registro.existe) {
    if (exigible) p.push({ regla: 'sin-registro-de-aprobaciones', detalle: `no trae \`${FILE}\`` });
    return p;
  }
  if (exigible && !registro.lineas.some((l) => l && l.que === 'plan')) {
    p.push({ regla: 'sin-aprobacion-del-plan', detalle: 'no trae la aprobación del plan' });
  }
  return p;
}

/** Las reglas que perdona `advisors_exempt`: la falta del registro, no un registro presente y malo. */
const POR_FALTA = new Set(['sin-registro-de-aprobaciones', 'sin-aprobacion-del-plan']);

/**
 * Las carpetas de corrida de una story en `repo`: las de `<repo>/.advisors/pipeline-runs` y las de cada subcarpeta de
 * primer nivel (`<repo>/<sub>/.advisors/pipeline-runs`), con nombre `<clave>` o `<clave>-…`. La usan el portón de CI y
 * el cierre del pipeline. Con `estricto`, una carpeta de corridas que existe y no se lista lanza; sin él, se saltea.
 * Devuelve [{ dir, nombre }].
 */
function carpetasDeCorrida(repo, clave, { estricto = false } = {}) {
  if (!clave) return [];
  const bases = [path.join(repo, '.advisors', 'pipeline-runs')];
  try {
    for (const e of fs.readdirSync(repo, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      bases.push(path.join(repo, e.name, '.advisors', 'pipeline-runs'));
    }
  } catch (e) {
    if (estricto) throw new Error(`no pude listar ${repo} (${(e && (e.code || e.message)) || e})`);
  }
  const out = [];
  for (const b of bases) {
    let entradas = [];
    try { entradas = fs.readdirSync(b); } catch (e) {
      if (estricto && e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new Error(`no pude listar ${b} (${e.code || e.message})`);
      continue;
    }
    for (const n of entradas) {
      if (n !== clave && !n.startsWith(`${clave}-`)) continue;
      out.push({ dir: path.join(b, n), nombre: n });
    }
  }
  return out;
}

/** El primer problema de `problemasDelRegistro`, o null. */
function faltaElPlan(args) {
  return problemasDelRegistro(args)[0] || null;
}

/** Con la maqueta aprobada en el marcador: el registro tiene que traer su línea. Devuelve el problema o null. */
function faltaLaMaqueta(registro) {
  if (registro.existe && registro.lineas.some((l) => l && l.que === 'maqueta')) return null;
  return { regla: 'sin-aprobacion-de-la-maqueta', detalle: 'la maqueta se aprobó y el registro no lo anota' };
}

/**
 * Suma al registro de `destinoDir` las líneas de `origenDir` que no tiene (por línea exacta), al final y en el orden
 * del origen. Nunca borra ni reordena las del destino. Escribe por un archivo temporal y lo renombra: un corte no
 * deja el registro a medias. Un destino que existe y no se puede leer lanza sin escribir.
 * Devuelve { agregadas }.
 */
function unir(origenDir, destinoDir) {
  let origen;
  try { origen = fs.readFileSync(path.join(origenDir, FILE), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { agregadas: 0 };
    throw e;
  }
  const destino = path.join(destinoDir, FILE);
  let actual = '';
  try { actual = fs.readFileSync(destino, 'utf8'); } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  // El `\r` final no cuenta: un registro sacado de git con CRLF trae las mismas líneas.
  const sinCr = (l) => l.replace(/\r$/, '');
  const tiene = new Set(actual.split('\n').map(sinCr).filter((l) => l.trim()));
  const nuevas = [];
  for (const crudo of origen.split('\n')) {
    const l = sinCr(crudo);
    if (!l.trim() || tiene.has(l)) continue;
    tiene.add(l);
    nuevas.push(l);
  }
  if (!nuevas.length) return { agregadas: 0 };
  const base = actual && !actual.endsWith('\n') ? `${actual}\n` : actual;
  fs.mkdirSync(destinoDir, { recursive: true });
  const tmp = `${destino}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${base}${nuevas.join('\n')}\n`);
  fs.renameSync(tmp, destino);
  return { agregadas: nuevas.length };
}

module.exports = {
  FILE, SIN_NOMBRAR, esAgente, lineasDeFirmaPorTerminal, quienDesdeOpciones, normalizar, validar, anotar, leer, resumir,
  problemasDelRegistro, faltaElPlan, faltaLaMaqueta, unir, carpetasDeCorrida, POR_FALTA, DESDE_EN_LA_STORY, selloDeCorrida, anteriorAlControl,
};
