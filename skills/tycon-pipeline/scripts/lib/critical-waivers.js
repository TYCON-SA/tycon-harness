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
// Se firma en la terminal, en la ventana de permiso, o con el click o el «aprobado» de la persona, y la ata su renglón del registro del arnés. Una anterior a la
// ventana, que salió de una cita en la conversación, ya no vale: la conversación no se lee para firmar nada.
const sinCita = (via) => /terminal|ventana|delegada|click en el cuadro|«aprobado» escrito/.test(String(via || ''));
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
 * Con el perfil roto o un lector que no la conoce, nadie reenvía y se dice por qué. Lo que esté roto en otra parte (el
 * archivo de la máquina, otra clave) no la tapa: es la misma lectura para ordenar y para firmar.
 */
function sesionQueReenvia({ env = process.env, home, arnes } = {}) {
  // el lector de ESTE árbol, nunca uno señalado por una variable (TYCON_GUIDES_DIR la puede poner el agente)
  const lector = [path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'tycon-config.js')].find((f) => fs.existsSync(f));
  if (!lector) return { valor: null, aviso: 'no encontré el lector de configuración del arnés: nadie reenvía' };
  try {
    const cfg = require(lector);
    const r = cfg.cargar({ env, home, ...(arnes ? { arnes } : {}) });
    const perfiles = [cfg.NOMBRE_PERFIL, cfg.NOMBRE_PERFIL_VIEJO];
    // la clave misma, la sección que la contiene, o el archivo del perfil entero
    const delPerfil = (e) => e.clave === 'approvals' || String(e.clave || '').startsWith('approvals.relay_session')
      || (e.clave == null && perfiles.includes(path.basename(String(e.archivo || ''))));
    const roto = (r.errores || []).find(delPerfil);
    if (roto) {
      const e = roto;
      return { valor: null, aviso: `la configuración no se pudo leer (${e.archivo || '?'}${e.clave ? ` · ${e.clave}` : ''}: ${e.motivo}): nadie reenvía` };
    }
    const v = r.valores && r.valores.approvals ? r.valores.approvals.relay_session : undefined;
    if (v === undefined) return { valor: null, aviso: 'el lector de configuración de este arnés no conoce approvals.relay_session: nadie reenvía' };
    return { valor: typeof v === 'string' && v.trim() ? v.trim() : null };
  } catch (e) {
    return { valor: null, aviso: `el lector de configuración falló (${e.message}): nadie reenvía` };
  }
}

// El rol de coordinar cuando el perfil no nombra uno: sin perfil la coordinadora ordena la máquina (el tope, los turnos,
// los avisos, /coordinate) y no firma nada por el dueño. Es fijo: no se lee de una variable ni del archivo de la máquina.
const ROL_DE_FABRICA = 'coordinadora';
// La frase sin perfil puede nombrar el rol en castellano o en inglés.
const ROLES_DE_FABRICA = Object.freeze([ROL_DE_FABRICA, 'coordinator']);

/**
 * El rol de la sesión que ordena: el de `approvals.relay_session` del perfil o, sin él, «coordinadora». `{ rol, firma,
 * aviso }`: `firma` dice si la organización la deja firmar por el dueño (sólo con el rol del perfil); `aviso`, por qué no
 * se pudo leer el perfil, si fue eso.
 */
function rolDeCoordinar(o = {}) {
  const r = sesionQueReenvia(o);
  return { rol: r.valor || ROL_DE_FABRICA, firma: Boolean(r.valor), aviso: r.aviso || null };
}

// ── Cuál sesión reenvía, en cada máquina ──
// El perfil dice SI la organización usa una sesión que reenvía el ok de un dev (`approvals.relay_session`: el nombre del
// rol, por ejemplo «coordinadora»). CUÁL es se designa en la máquina: la sesión corre `marker.js designate-relay` con
// una frase que la nombra («Esta sesión es la coordinadora») y el renglón queda en el gates.log. Ese renglón no designa
// nada solo: lo confirma el dueño, con un click en esa pestaña o en su terminal (scripts/lib/delegated-signing.js `confirm-designation`). La sesión se
// reconoce por su número, que no cambia al reiniciar el proceso (sí con /clear o con un chat nuevo); el nombre visible
// no cuenta, porque lo pone el sistema y otra sesión puede llevar el mismo.
const DESIGNACION = 'relay-designation';
// el renglón con que la coordinadora deja de serlo (marker.js withdraw-relay): el registro queda completo
const RETIRADA = 'retirada';
// Las dos se aplican a la frase PLANA (ver `plana`): sin acentos y en minúsculas. «Esta sesión», «esta pestaña», «sos», y
// en inglés «this session». Las formas que no nombran la sesión («esta es la…», «eres», «te designo»…) piden el rol
// pegado: ver `formasConElRol`.
const RE_ESTA_SESION = /\besta\s+(sesion|conversacion|pestana|ventana|terminal|instancia|chat)\b|\bsos\b|\bthis\s+(session|conversation|tab|window)\b/;
const RE_NIEGA = /\b(no|nunca|jamas|tampoco|ni|not|never)\b|\bisn'?t\b|\bdej\w*\s+de\s+ser\b/;
// una letra que la terminal cambió por «?» o por el carácter de reemplazo, entre otras dos («sesi?n»)
const RE_TILDE_ROTA = /\p{L}[?�]\p{L}/u;

/**
 * La frase como se juzga: sin acentos (también los que llegan aparte de su letra), en minúsculas, y con cada letra que una
 * terminal partió en dos («sesiÃ³n»: UTF-8 leído como Latin-1) reparada. Así una frase sin tilde, o con la tilde
 * descompuesta, dice lo mismo que con ella.
 */
function plana(texto) {
  return sinTildes(enLetrasComunes(texto));
}
// La frase con cada letra partida reparada (letra por letra: la frase puede traer otros caracteres, que no se tocan), las
// letras de ancho completo y sus parecidas en su forma común (NFKC) y sin los caracteres invisibles: una «n» y una «o» con
// un espacio de ancho cero en el medio siguen siendo «no».
function enLetrasComunes(texto) {
  return String(texto || '')
    .replace(/[Â-ß][\u0080-¿]/g, (par) => Buffer.from(par, 'latin1').toString('utf8'))
    .normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\u2018\u2019\u02BC]/g, "'").toLowerCase();
}
const sinTildes = (t) => t.normalize('NFD').replace(/\p{M}/gu, '');
// Una frase condicional o un pedido de averiguar no designa aunque no lleve «?»: «decime si eres la coordinadora»,
// «cuando seas la coordinadora…». Se mira con las tildes, para que «Sí, esta sesión es…» no cuente como «si»; un «si» seguido
// de una coma o de un signo es el «sí» escrito sin tilde.
const RE_CONDICIONAL = /(?<![\p{L}\p{N}])(si(?!\s*[,.!])|cuando|cuándo|dime|decime|avisame|avisá|if|whether|when)(?![\p{L}\p{N}])/u;

/**
 * El juez de la frase que designa: nombra el rol, dice que es ESTA sesión, no lo niega y no es una pregunta. Se aplica a
 * la cita y al mensaje entero que la trae. `retracta`: un mensaje posterior del dev que nombra el rol y lo niega («esta
 * sesión ya no es la coordinadora») tumba la designación. null = vale; si no, el motivo.
 */
function juezDesignacion(rol) {
  const r = plana(String(rol || '').trim());
  const rolRe = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // «Esta es la coordinadora», «Tú eres la coordinadora», «Quiero que seas la coordinadora», «Te designo coordinadora»,
  // «You are the coordinadora»: el rol justo después, para que «esta es la tarea que pidió la coordinadora» no designe
  const formasConElRol = new RegExp(`\\b(?:esta\\s+es|eres|seas|te\\s+designo(?:\\s+como)?|you\\s+are)\\s+(?:la\\s+|el\\s+|the\\s+)?${rolRe}(?![\\p{L}\\p{N}])`, 'u');
  const juez = (texto) => {
    // una tilde perdida no se puede reparar: se dice, para que se escriba sin tildes en vez de buscar otra frase
    if (RE_TILDE_ROTA.test(String(texto || ''))) return `la frase llegó con una letra cambiada por «?» (la terminal no pasó una tilde): escribila sin tildes, por ejemplo «Esta sesion es la ${r}»`;
    const t = plana(texto);
    if (!r || !new RegExp(`(?<![\\p{L}\\p{N}])${rolRe}(?![\\p{L}\\p{N}])`, 'u').test(t)) return `la frase no nombra el rol «${String(rol || '').trim()}»`;
    if (!RE_ESTA_SESION.test(t) && !formasConElRol.test(t)) return `la frase no dice que es esta sesión (por ejemplo «Esta sesión es la ${r}»)`;
    if (RE_NIEGA.test(t)) return 'la frase lo niega';
    if (/[?¿]/.test(t)) return 'la frase es una pregunta';
    if (RE_CONDICIONAL.test(enLetrasComunes(texto))) return 'la frase es condicional o pide averiguar (si, cuando, decime…): no afirma que esta sesión sea el rol';
    return null;
  };
  // sólo una frase que niega el rol mismo («ya no sos la coordinadora», «esta sesión ya no es la coordinadora»): un «no»
  // cualquiera de otra charla no anula la designación
  const anula = new RegExp(`\\b(?:ya\\s+)?no\\s+(?:es|sos|ser[aá]s?)\\s+(?:m[aá]s\\s+)?(?:la\\s+|el\\s+)?${rolRe}(?![\\p{L}\\p{N}])`
    + `|\\bdej[aeo]s?\\s+de\\s+ser\\s+(?:la\\s+|el\\s+)?${rolRe}(?![\\p{L}\\p{N}])`
    + `|\\bya\\s+no\\s+(?:vas\\s+a\\s+ser|eres)\\s+(?:la\\s+|el\\s+)?${rolRe}(?![\\p{L}\\p{N}])`
    + `|${rolRe}\\s+ya\\s+no\\s+(?:sos|es|eres)\\b`
    // las formas naturales, negadas: «tú no eres», «no quiero que seas», «no te designo»
    + `|\\bno\\s+(?:eres|(?:quiero\\s+que\\s+)?seas|te\\s+designo(?:\\s+como)?)\\s+(?:la\\s+|el\\s+)?${rolRe}(?![\\p{L}\\p{N}])`
    + `|\\b(?:sac|quit|anul|revoc)\\p{L}*\\s+(?:la\\s+)?designaci[oó]n\\b`
    + `|\\b(?:is|are)\\s+(?:no\\s+longer|not)\\s+(?:the\\s+)?${rolRe}(?![\\p{L}\\p{N}])`, 'iu');
  juez.retracta = (texto) => !!r && anula.test(plana(texto));
  return juez;
}

/**
 * Designar la sesión que corre el comando como la coordinadora de esta máquina, con una frase que nombra el rol (el del
 * perfil o, sin él, «coordinadora» o «coordinator»). La frase no se busca en la conversación. Con el rol del perfil, la
 * designación firma por el dueño cuando él la confirma; sin él, sólo ordena.
 * `{ ok: true, entrada: { sesion, rol, quien, cita, cita_cuando }, firma, aviso }` o `{ ok: false, motivo }`.
 */
function designar({ approvedBy, quote, env = process.env, home, arnes } = {}) {
  const persona = noEsPersona(approvedBy);
  if (persona) return { ok: false, motivo: persona };
  const cita = String(quote || '').trim();
  if (!cita) return { ok: false, motivo: 'falta la frase del dev (--quote "<sus palabras, textuales>")' };
  const declarada = rolDeCoordinar({ env, home, arnes });
  const sesion = String(env.CLAUDE_CODE_SESSION_ID || '');
  if (!/^[\w-]+$/.test(sesion)) return { ok: false, sinConversacion: true, motivo: 'la sesión no dice su identificador' };
  // sin rol del perfil, vale la frase que nombra cualquiera de los de fábrica; el motivo es el del que la frase nombra
  const motivos = (declarada.firma ? [declarada.rol] : ROLES_DE_FABRICA).map((rol) => juezDesignacion(rol)(cita));
  if (!motivos.includes(null)) return { ok: false, motivo: motivos.find((m) => !/no nombra el rol/.test(m)) || motivos[0] };
  return { ok: true, firma: declarada.firma, aviso: declarada.aviso, entrada: { sesion, rol: declarada.rol, quien: String(approvedBy).trim(), cita, cita_cuando: null } };
}

/**
 * La última designación anotada en el gates.log de esta máquina: `{ sesion, rol, quien, cita, via, ts }`, null o
 * `{ error }`. Una designación por frase trae `cita`; una por click (marker.js designate-relay sin frase), `via` y
 * `cita: null`. Si el último renglón de la designación es una retirada (`status: 'retirada'`), no hay coordinadora.
 */
function designacionVigente({ home, dir } = {}) {
  let raw;
  // `dir`: la carpeta del estado ya resuelta, para quien no la lee del ambiente (scripts/lib/delegated-signing.js)
  try { raw = fs.readFileSync(path.join(dir || require('./state-dir.js').stateDir(home), 'gates.log'), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? null : { error: `no pude leer el registro del arnés (${e.code || e.message})` };
  }
  const lineas = raw.split('\n');
  // una retirada anula sólo la designación de su propia sesión: la de otra sesión nombrada antes sigue vigente
  const retiradas = new Set();
  for (let i = lineas.length - 1; i >= 0; i--) {
    if (!lineas[i].includes(DESIGNACION)) continue;
    let g;
    try { g = JSON.parse(lineas[i]); } catch (_e) { continue; }
    if (g && g.name === DESIGNACION && g.status === RETIRADA) { retiradas.add(String(g.sesion || '')); continue; }
    if (g && g.name === DESIGNACION && g.status === 'ok' && /^[\w-]+$/.test(String(g.sesion || '')) && (g.cita || g.via)) {
      if (retiradas.has(g.sesion)) return null;
      return { sesion: g.sesion, rol: g.rol || null, quien: g.quien || null, cita: g.cita || null, via: g.via || null, ts: g.ts || null };
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

module.exports = { DESIGNACION, RETIRADA, RE_NIEGA, juezDesignacion, designar, designacionVigente, huella, fueraDelRegistro, constanciaInvalida, renglonesDeFaltantes, sh, reglaDe, revisar, noEsPersona, sesionQueReenvia, rolDeCoordinar, ROL_DE_FABRICA, FILE, clave, esCriticoEximido, anotar, leer, faltantes, verificarExenciones, caminos };
