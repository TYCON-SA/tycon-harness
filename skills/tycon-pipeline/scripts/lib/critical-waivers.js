'use strict';
/**
 * critical-waivers — la constancia de que una persona eximió un CRITICAL.
 *
 * Un crítico lo decide una persona. El agente que implementa marcaba `disposition: waived` en `findings.json` y seguía,
 * firmado como `orquestador`. Un CRITICAL `waived` vale sólo con su línea en
 * `<carpeta de la corrida>/critical-waivers.jsonl`, que deja `marker.js waive-critical` con el ok de una persona:
 *   { rule_id, file, reason, tipo: 'manual' | 'automatica', quien, delegacion?, cita?, cita_cuando?, via, ts }
 * La verifican tres lugares: `pipeline.js write-findings` (no escribe), y los cierres de «Hallazgos» y «Preparar el commit» (frenan).
 */
const fs = require('fs');
const path = require('path');

const FILE = 'critical-waivers.jsonl';

const clave = (ruleId, file) => `${String(ruleId || '').trim()}|${String(file || '').trim()}`;
// la regla del hallazgo con los nombres que aceptan los demás lectores (`rule_id`, `ruleId`, `rule`)
const reglaDe = (f) => String((f && (f.rule_id || f.ruleId || f.rule)) || '').trim();
// normalizado como `write-findings` (un findings.json reescrito a mano con «Waived» o « waived » no se escapa)
const esCriticoEximido = (f) => !!f && String(f.severity || '').trim().toUpperCase() === 'CRITICAL'
  && String(f.disposition || '').trim().toLowerCase() === 'waived';

/** Una constancia completa: regla, quién, tipo y vía. null = válida; si no, el motivo. */
// Se firma en la terminal o en la ventana de permiso y la ata su renglón del registro del arnés. Una anterior a la
// ventana, que salió de una cita en la conversación, ya no vale: la conversación no se lee para firmar nada.
const sinCita = (via) => /terminal|ventana|delegada/.test(String(via || ''));
const CITA_VIEJA = 'esta exención se firmó con una cita en la conversación, que ya no cuenta: firmala en la ventana';

function constanciaInvalida(l) {
  if (!l || typeof l !== 'object') return 'no es un objeto';
  if (!String(l.rule_id || '').trim()) return 'no dice la regla';
  if (!['manual', 'automatica'].includes(l.tipo)) return `tipo ${JSON.stringify(l.tipo)}`;
  if (!String(l.quien || '').trim() || noEsPersona(l.tipo === 'manual' ? l.quien : (l.delegacion || ''))) return 'no nombra a la persona que dio el ok';
  if (!String(l.via || '').trim()) return 'no dice por qué vía';
  if (!sinCita(l.via)) return CITA_VIEJA;
  if (!String(l.ts || '').trim()) return 'no dice cuándo se anotó';
  return null;
}

/**
 * ¿La constancia la anotó `marker.js waive-critical` en esta máquina? Cada una deja su renglón en el `gates.log` de la
 * carpeta de estado del arnés, donde el freno de escritura no deja escribir al agente (on-story-gate / on-bash-write-gate):
 * es lo que el agente no puede fabricar copiando una línea al archivo de la corrida. `null` = está; si no, el motivo.
 */
// la huella de lo que se eximió y por qué: el renglón del registro y la constancia tienen que decir lo mismo
const huella = (l) => require('crypto').createHash('sha256').update(JSON.stringify([l.rule_id || '', l.file || '', l.reason || '', l.tipo || '', l.quien || '', l.delegacion || '', l.via || '', l.cita || ''])).digest('hex').slice(0, 16);

function fueraDelRegistro(l, { home, story } = {}) {
  let raw;
  try { raw = fs.readFileSync(path.join(require('./state-dir.js').stateDir(home), 'gates.log'), 'utf8'); } catch (e) {
    return `no pude leer el registro del arnés de esta máquina (${e.code || e.message})`;
  }
  for (const linea of raw.split('\n')) {
    if (!linea.includes('"critical-waiver"')) continue;
    let g; try { g = JSON.parse(linea); } catch (_e) { continue; }
    // la misma regla, el mismo archivo, la misma hora, la misma historia y la misma huella (quién, por qué vía, con qué
    // cita): una constancia de otra corrida, o una con otro «quién» o vía, no se puede copiar a ésta
    if (g.name === 'critical-waiver' && g.status === 'ok' && g.rule === l.rule_id && (g.file || '') === (l.file || '') && g.ts === l.ts
      && g.huella === huella(l) && (story == null || String(g.story) === String(story))) return null;
  }
  return 'no la anotó waive-critical en esta máquina para esta historia (no está en el registro del arnés)';
}

/** Comillas simples para la terminal: lo que se imprime para copiar no ejecuta nada de lo que trae adentro. */
const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/** Agrega una constancia. Devuelve la línea guardada; lanza si no puede escribir. */
function anotar(runDir, e) {
  const linea = { ts: new Date().toISOString(), ...e };
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(path.join(runDir, FILE), `${JSON.stringify(linea)}\n`);
  return linea;
}

/** Las constancias de la corrida: `{ lineas, ilegibles, error? }`. Una línea que no es JSON se cuenta, no se tapa. */
function leer(runDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(runDir, FILE), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { lineas: [], ilegibles: 0 };
    return { lineas: [], ilegibles: 0, error: e.code || e.message };
  }
  const lineas = [];
  let ilegibles = 0;
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { lineas.push(JSON.parse(l)); } catch (_e) { ilegibles++; }
  }
  return { lineas, ilegibles };
}

/**
 * Los CRITICAL eximidos de `hallazgos` que no tienen una constancia válida: `{ faltan: [{ rule_id, file, motivo? }],
 * ilegibles, error? }`. Con `reverificar`, cada constancia se busca además en el registro del arnés de esta máquina.
 */
function revisar(hallazgos, runDir, { reverificar = false, home, story } = {}) {
  const leido = leer(runDir);
  const validas = new Map();
  const malas = new Map();
  for (const l of leido.lineas) {
    const k = clave(l && l.rule_id, l && l.file);
    const mal = constanciaInvalida(l) || (reverificar ? fueraDelRegistro(l, { home, story }) : null);
    if (mal) { if (!validas.has(k)) malas.set(k, mal); } else { validas.set(k, l); malas.delete(k); }
  }
  const faltan = (hallazgos || []).filter(esCriticoEximido).filter((f) => !validas.has(clave(reglaDe(f), f.file)))
    .map((f) => {
      const k = clave(reglaDe(f), f.file);
      return { rule_id: reglaDe(f) || '(sin regla)', file: f.file || '', ...(malas.has(k) ? { motivo: `la constancia no vale: ${malas.get(k)}` } : {}) };
    });
  return { faltan, ilegibles: leido.ilegibles, ...(leido.error ? { error: `${FILE} no se lee (${leido.error})` } : {}) };
}

/** Los CRITICAL eximidos de `hallazgos` sin constancia válida: `[{ rule_id, file, motivo? }]`. */
function faltantes(hallazgos, runDir, opts) { return revisar(hallazgos, runDir, opts).faltan; }

/**
 * La verificación de los cierres: lee `findings.json` de la corrida y vuelve a comprobar las citas. `{ faltan,
 * ilegibles, existe, error? }`; sin archivo, nada falta (`existe: false`). Un archivo roto es `error`: quien llama frena.
 */
function verificarExenciones(runDir, opts = {}) {
  let lista;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
    lista = Array.isArray(data) ? data : (data && Array.isArray(data.findings) ? data.findings : null);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { faltan: [], ilegibles: 0, existe: false };
    return { faltan: [], ilegibles: 0, existe: true, error: `findings.json no se lee (${e.message || e})` };
  }
  if (!lista) return { faltan: [], ilegibles: 0, existe: true, error: 'findings.json no es una lista de hallazgos' };
  return { ...revisar(lista, runDir, { reverificar: true, ...opts }), existe: true };
}

/**
 * Los caminos para eximir un crítico, un renglón cada uno, en el orden en que se ofrecen: la ventana de permiso (el
 * agente corre el comando y el dev lo aprueba ahí); la terminal.
 */
function caminos({ marker, ruleId, file }) {
  // la regla y el archivo vienen de findings.json (los escribe el agente): van entre comillas simples, para que el
  // comando que copia el dev no ejecute nada que traigan adentro
  const base = `node ${sh(marker)} waive-critical --rule ${sh(ruleId)} --file ${sh(file)} --reason '<por qué>'`;
  return [
    `  · en la ventana de permiso: corré ${base} y el dev lo aprueba ahí`,
    `  · por la terminal (lo corre el dev): ${base} --terminal`,
  ];
}

/** Los renglones de lo que falta, para los mensajes de write-findings y de los cierres. */
function renglonesDeFaltantes(r) {
  const out = r.faltan.map((f) => `   · ${f.rule_id}${f.file ? ` en ${f.file}` : ''}${f.motivo ? ` — ${f.motivo}` : ''}`);
  if (r.ilegibles) out.push(`   (${FILE} tiene ${r.ilegibles} renglón(es) ilegible(s): no cuentan como constancia)`);
  if (r.error) out.push(`   (${r.error})`);
  return out;
}

/**
 * La sesión que la organización deja reenviar el ok de un dev: `approvals.relay_session` del perfil del equipo (sólo
 * de ahí: el lector ignora la variable y el archivo de la máquina). `{ valor, aviso? }`; sin clave, `valor: null`.
 * Con la configuración rota o un lector que no la conoce, nadie reenvía y se dice por qué.
 */
function sesionQueReenvia({ env = process.env, home, arnes } = {}) {
  // el lector de ESTE árbol, nunca uno señalado por una variable (TYCON_GUIDES_DIR la puede poner el agente)
  const lector = [path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'tycon-config.js')].find((f) => fs.existsSync(f));
  if (!lector) return { valor: null, aviso: 'no encontré el lector de configuración del arnés: nadie reenvía' };
  try {
    const r = require(lector).cargar({ env, home, ...(arnes ? { arnes } : {}) });
    if (r.errores && r.errores.length) {
      const e = r.errores[0];
      return { valor: null, aviso: `la configuración no se pudo leer (${e.archivo || '?'}${e.clave ? ` · ${e.clave}` : ''}: ${e.motivo}): nadie reenvía` };
    }
    const v = r.valores && r.valores.approvals ? r.valores.approvals.relay_session : undefined;
    if (v === undefined) return { valor: null, aviso: 'el lector de configuración de este arnés no conoce approvals.relay_session: nadie reenvía' };
    return { valor: typeof v === 'string' && v.trim() ? v.trim() : null };
  } catch (e) {
    return { valor: null, aviso: `el lector de configuración falló (${e.message}): nadie reenvía` };
  }
}

// ── Cuál sesión reenvía, en cada máquina ──
// El perfil dice SI la organización usa una sesión que reenvía el ok de un dev (`approvals.relay_session`: el nombre del
// rol, por ejemplo «coordinadora»). CUÁL es se designa en la máquina: la sesión corre `marker.js designate-relay` con
// una frase que la nombra («Esta sesión es la coordinadora») y el renglón queda en el gates.log. Ese renglón no designa
// nada solo: lo confirma el dueño en su terminal (scripts/lib/delegated-signing.js `confirm-designation`). La sesión se
// reconoce por su número, que no cambia al reiniciar el proceso (sí con /clear o con un chat nuevo); el nombre visible
// no cuenta, porque lo pone el sistema y otra sesión puede llevar el mismo.
const DESIGNACION = 'relay-designation';
const RE_ESTA_SESION = /(esta\s+(sesi[oó]n|conversaci[oó]n)|\bsos\b|this\s+(session|conversation))/i;
const RE_NIEGA = /\b(no|nunca|jam[aá]s|not|never)\b|\bisn'?t\b|\bdeja\s+de\s+ser\b/i;

/**
 * El juez de la frase que designa: nombra el rol, dice que es ESTA sesión, no lo niega y no es una pregunta. Se aplica a
 * la cita y al mensaje entero que la trae. `retracta`: un mensaje posterior del dev que nombra el rol y lo niega («esta
 * sesión ya no es la coordinadora») tumba la designación. null = vale; si no, el motivo.
 */
function juezDesignacion(rol) {
  const r = String(rol || '').trim().toLowerCase();
  const juez = (texto) => {
    const t = String(texto || '').toLowerCase();
    if (!r || !t.includes(r)) return `la frase no nombra el rol «${String(rol || '').trim()}»`;
    if (!RE_ESTA_SESION.test(t)) return `la frase no dice que es esta sesión (por ejemplo «Esta sesión es la ${r}»)`;
    if (RE_NIEGA.test(t)) return 'la frase lo niega';
    if (/[?¿]/.test(t)) return 'la frase es una pregunta';
    return null;
  };
  // sólo una frase que niega el rol mismo («ya no sos la coordinadora», «esta sesión ya no es la coordinadora»): un «no»
  // cualquiera de otra charla no anula la designación
  const rolRe = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anula = new RegExp(`\\b(?:ya\\s+)?no\\s+(?:es|sos|ser[aá]s?)\\s+(?:m[aá]s\\s+)?(?:la\\s+|el\\s+)?${rolRe}(?![\\p{L}\\p{N}])`
    + `|\\bdej[aáeó]s?\\s+de\\s+ser\\s+(?:la\\s+|el\\s+)?${rolRe}(?![\\p{L}\\p{N}])`
    + `|\\bya\\s+no\\s+(?:vas\\s+a\\s+ser|eres)\\s+(?:la\\s+|el\\s+)?${rolRe}(?![\\p{L}\\p{N}])`
    + `|${rolRe}\\s+ya\\s+no\\s+(?:sos|es|eres)\\b`
    + `|\\b(?:sac|quit|anul|revoc)\\p{L}*\\s+(?:la\\s+)?designaci[oó]n\\b`
    + `|\\b(?:is|are)\\s+(?:no\\s+longer|not)\\s+(?:the\\s+)?${rolRe}(?![\\p{L}\\p{N}])`, 'iu');
  juez.retracta = (texto) => !!r && anula.test(String(texto || ''));
  return juez;
}

/**
 * Designar la sesión que corre el comando como la que reenvía, con una frase que nombra el rol. La frase no se busca en
 * la conversación: la designación vale cuando el dueño la confirma en su terminal.
 * `{ ok: true, entrada: { sesion, rol, quien, cita, cita_cuando } }` o `{ ok: false, motivo }`.
 */
function designar({ approvedBy, quote, env = process.env, home, arnes } = {}) {
  const persona = noEsPersona(approvedBy);
  if (persona) return { ok: false, motivo: persona };
  const cita = String(quote || '').trim();
  if (!cita) return { ok: false, motivo: 'falta la frase del dev (--quote "<sus palabras, textuales>")' };
  const declarada = sesionQueReenvia({ env, home, arnes });
  if (!declarada.valor) return { ok: false, motivo: `la organización no usa una sesión que reenvía el ok de un dev (approvals.relay_session del perfil del equipo)${declarada.aviso ? `: ${declarada.aviso}` : ''}` };
  const sesion = String(env.CLAUDE_CODE_SESSION_ID || '');
  if (!/^[\w-]+$/.test(sesion)) return { ok: false, sinConversacion: true, motivo: 'la sesión no dice su identificador' };
  const juez = juezDesignacion(declarada.valor);
  const mala = juez(cita);
  if (mala) return { ok: false, motivo: mala };
  return { ok: true, entrada: { sesion, rol: declarada.valor, quien: String(approvedBy).trim(), cita, cita_cuando: null } };
}

/** La última designación anotada en el gates.log de esta máquina: `{ sesion, rol, quien, cita, ts }`, null o `{ error }`. */
function designacionVigente({ home, dir } = {}) {
  let raw;
  // `dir`: la carpeta del estado ya resuelta, para quien no la lee del ambiente (scripts/lib/delegated-signing.js)
  try { raw = fs.readFileSync(path.join(dir || require('./state-dir.js').stateDir(home), 'gates.log'), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? null : { error: `no pude leer el registro del arnés (${e.code || e.message})` };
  }
  const lineas = raw.split('\n');
  for (let i = lineas.length - 1; i >= 0; i--) {
    if (!lineas[i].includes(DESIGNACION)) continue;
    let g;
    try { g = JSON.parse(lineas[i]); } catch (_e) { continue; }
    if (g && g.name === DESIGNACION && g.status === 'ok' && /^[\w-]+$/.test(String(g.sesion || '')) && g.cita) {
      return { sesion: g.sesion, rol: g.rol || null, quien: g.quien || null, cita: g.cita, ts: g.ts || null };
    }
  }
  return null;
}

// Quién NO puede aprobar: nadie, «sin nombrar», el orquestador, una regla, o un agente (lib/approvals.js).
function noEsPersona(quien) {
  const q = String(quien || '').trim();
  if (!q) return 'falta quién aprueba (--approved-by "<el dev>")';
  const approvals = require('./approvals.js');
  if (q === approvals.SIN_NOMBRAR || /^orquestador\b/i.test(q) || /^regla\b/i.test(q) || approvals.esAgente(q)) {
    return `«${q}» no es una persona: un crítico lo decide una persona, no el agente ni una regla`;
  }
  return null;
}

module.exports = { DESIGNACION, RE_NIEGA, juezDesignacion, designar, designacionVigente, huella, fueraDelRegistro, constanciaInvalida, renglonesDeFaltantes, sh, reglaDe, revisar, noEsPersona, sesionQueReenvia, FILE, clave, esCriticoEximido, anotar, leer, faltantes, verificarExenciones, caminos };
