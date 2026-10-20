'use strict';
/**
 * critical-waivers — la constancia de que una persona eximió un CRITICAL.
 *
 * Un crítico lo decide una persona. El agente que implementa marcaba `disposition: waived` en `findings.json` y seguía,
 * firmado como `orquestador`. Un CRITICAL `waived` vale sólo con su línea en
 * `<carpeta de la corrida>/critical-waivers.jsonl`, que deja `marker.js waive-critical` con el ok de una persona:
 *   { rule_id, file, reason, tipo: 'manual' | 'automatica', quien, delegacion?, cita?, cita_cuando?, via, ts }
 * La verifican tres lugares: `pipeline.js write-findings` (no escribe), y los cierres de los pasos 7 y 8 (frenan).
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

/** Una constancia completa: regla, quién, tipo y vía; la que salió del chat, con su cita. null = válida; si no, el motivo. */
function constanciaInvalida(l) {
  if (!l || typeof l !== 'object') return 'no es un objeto';
  if (!String(l.rule_id || '').trim()) return 'no dice la regla';
  if (!['manual', 'automatica'].includes(l.tipo)) return `tipo ${JSON.stringify(l.tipo)}`;
  if (!String(l.quien || '').trim() || noEsPersona(l.tipo === 'manual' ? l.quien : (l.delegacion || ''))) return 'no nombra a la persona que dio el ok';
  if (!String(l.via || '').trim()) return 'no dice por qué vía';
  if (!/terminal/.test(l.via) && !String(l.cita || '').trim()) return 'salió del chat y no trae la cita';
  if (!/terminal/.test(l.via) && !String(l.sesion || '').trim()) return 'salió del chat y no dice de qué sesión';
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
 * Vuelve a buscar la cita de una constancia en la conversación de la sesión que la anotó (sólo si ese registro está en
 * esta máquina). `null` = se encontró, o no hay con qué comprobar (terminal, otra máquina); si no, el motivo. Es lo que
 * hace que una línea agregada a mano al archivo, con una cita que nadie escribió, no valga.
 */
function citaQueNoAparece(l, opts = {}) {
  if (/terminal/.test(String(l.via || ''))) return null;
  const pok = require('./person-ok.js');
  const o = { ...opts, sesion: l.sesion };
  const r = l.tipo === 'automatica' && l.relevo ? pok.citaReenviada(l.cita, l.relevo, o) : pok.citaDeLaPersona(l.cita, o);
  // el registro de otra sesión puede no estar en esta máquina: lo que la ata es el registro del arnés; el de ESTA sesión, sí
  if (!r.legible) {
    const actual = sesionActual(opts.env);
    if (!actual) return `no puedo volver a comprobar la cita: esta sesión no dice su identificador y la conversación de la que la anotó no se lee (${r.motivo})`;
    return l.sesion === actual ? `no puedo leer la conversación de esta sesión (${r.motivo})` : null;
  }
  return r.encontrada ? null : 'su cita no está en la conversación de la sesión que la anotó';
}

/**
 * Los CRITICAL eximidos de `hallazgos` que no tienen una constancia válida: `{ faltan: [{ rule_id, file, motivo? }],
 * ilegibles, error? }`. Con `reverificar`, cada constancia que salió del chat se vuelve a comprobar contra la conversación.
 */
function revisar(hallazgos, runDir, { reverificar = false, env, home, story } = {}) {
  const leido = leer(runDir);
  const validas = new Map();
  const malas = new Map();
  for (const l of leido.lineas) {
    const k = clave(l && l.rule_id, l && l.file);
    const mal = constanciaInvalida(l) || (reverificar ? (fueraDelRegistro(l, { home, story }) || citaQueNoAparece(l, { env, home })) : null);
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
 * Los caminos para eximir un crítico, un renglón cada uno, en el orden en que se ofrecen: el ok del dev en el chat; la
 * variante reenviada, si la organización declara la sesión que reenvía; la terminal.
 */
function caminos({ marker, ruleId, file, relaySession }) {
  // la regla y el archivo vienen de findings.json (los escribe el agente): van entre comillas simples, para que el
  // comando que copia el dev no ejecute nada que traigan adentro
  const base = `node ${sh(marker)} waive-critical --rule ${sh(ruleId)} --file ${sh(file)} --reason '<por qué>'`;
  const out = [
    `  · el ok del dev en el chat: preguntale y, con su respuesta, ${base} --approved-by '<el dev>' --quote '<sus palabras, textuales>'`,
  ];
  if (relaySession) out.push(`  · reenviado por la sesión «${relaySession}»: ${base} --approved-by '<el dev>' --quote '<sus palabras, textuales>' --relayed-by ${sh(relaySession)}`);
  out.push(`  · por la terminal (lo corre el dev): ${base} --terminal`);
  return out;
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

/**
 * El ok de una persona para eximir algo, verificado en la conversación de la sesión. Dos formas:
 *   · `approvedBy` + `quote`: la cita está textual en un mensaje escrito por el dev → manual, a su nombre;
 *   · lo mismo + `relayedBy`: la cita llegó en un mensaje de esa sesión, y la organización la declara en
 *     `approvals.relay_session` → automática, por delegación del dev, a nombre de la sesión que reenvió.
 * Con `critico` ({ rule, file, reason, storyId, sessionId, stateDir }), el ok tiene que responder a ESE crítico: a la
 * persona se le mostró (constancia `critical-shown`, lib/critical-display.js), el mensaje es posterior a la muestra y
 * nombra el crítico (su regla o su nombre en llano) sin negarlo. Sin muestra: `{ ok: false, sinMuestra: true }`.
 * Con `criterios` ({ acs: [{ ac, sha }], storyId, sessionId, stateDir }), lo mismo para los criterios que se firman como
 * imposibles de probar en vivo: la constancia `ac-shown` de cada uno (lib/waiver-display.js) y un ok que los nombra.
 * `{ ok: true, entrada: { tipo, quien, delegacion?, cita, cita_cuando, via } }` o `{ ok: false, motivo, sinConversacion? }`.
 */
function okDeUnaPersona({ approvedBy, quote, relayedBy, desde, env = process.env, home, arnes, critico, criterios } = {}) {
  const persona = noEsPersona(approvedBy);
  if (persona) return { ok: false, motivo: persona };
  // sin la hora de arranque de la corrida no se puede saber si la cita es vieja: no se aprueba (falla cerrado)
  if (!desde || Number.isNaN(Date.parse(desde))) return { ok: false, motivo: 'no sé cuándo arrancó esta corrida (el marcador no trae startedAt), así que no puedo saber si la cita es de ahora' };
  const cita = String(quote || '').trim();
  if (!cita) return { ok: false, motivo: 'falta la cita (--quote "<las palabras del dev, textuales>")' };
  const pok = require('./person-ok.js');
  const quien = String(approvedBy).trim();
  // Con `critico`, el ok tiene que responder a la muestra de ese crítico: la hora y el juez salen de ahí.
  let juzgar;
  let anterior = 'la cita es de antes de que arrancara esta corrida: no aprueba lo que todavía no existía';
  const respuestaAlCritico = () => {
    // Con `criterios` (los AC que se firman como imposibles de probar en vivo), el ok responde a la muestra de cada uno
    if (criterios) {
      const wd = require('./waiver-display.js');
      for (const c of criterios.acs) {
        const visto = wd.mostrado({ stateDir: criterios.stateDir, sessionId: criterios.sessionId, storyId: criterios.storyId, ac: c.ac, sha: c.sha });
        if (visto && visto.error) return { ok: false, motivo: `no pude leer el registro del arnés (${visto.error}): no sé si a la persona se le mostró el AC ${c.ac}` };
        if (!visto) {
          const conv = pok.leerConversacion({ env, home });
          if (!conv.legible) return { ok: false, sinConversacion: true, motivo: `no puedo leer la conversación de esta sesión (${conv.motivo})` };
          return { ok: false, sinMuestra: true, motivo: `a la persona no se le mostró el AC ${c.ac}; el arnés se lo muestra al pedir la firma con este comando (o al escribir ${wd.PEDIDO}), y después hace falta su ok a ese criterio` };
        }
        if (Date.parse(visto.ts) > Date.parse(desde)) desde = visto.ts;
      }
      juzgar = wd.juez(criterios.acs.map((c) => c.ac));
      anterior = 'el ok es de antes de que se le mostrara el criterio: hace falta su respuesta a la muestra';
      return null;
    }
    if (!critico) return null;
    const cd = require('./critical-display.js');
    const visto = cd.mostrado({ stateDir: critico.stateDir, sessionId: critico.sessionId, storyId: critico.storyId, rule: critico.rule, file: critico.file, reason: critico.reason });
    if (visto && visto.error) return { ok: false, motivo: `no pude leer el registro del arnés (${visto.error}): no sé si a la persona se le mostró este crítico` };
    if (!visto) {
      // sin la conversación el arnés no muestra nada: el motivo es ése, y el camino es la terminal
      const conv = pok.leerConversacion({ env, home });
      if (!conv.legible) return { ok: false, sinConversacion: true, motivo: `no puedo leer la conversación de esta sesión (${conv.motivo})` };
      return { ok: false, sinMuestra: true, motivo: `a la persona no se le mostró este crítico; el arnés se lo muestra al correr este comando (o al escribir ${cd.PEDIDO}), y después hace falta su ok a ese crítico` };
    }
    // la más nueva entre la muestra y el arranque de la corrida: una muestra vieja no habilita un ok de otra corrida
    if (Date.parse(visto.ts) > Date.parse(desde)) desde = visto.ts;
    const ar = cd.archivosDeLaRegla({ stateDir: critico.stateDir, sessionId: critico.sessionId, storyId: critico.storyId, rule: critico.rule, runDir: critico.runDir });
    if (ar.error) return { ok: false, motivo: `${ar.error}: no sé en cuántos archivos está abierta la regla` };
    juzgar = cd.juez({ rule: critico.rule, file: critico.file, archivos: ar.archivos, arnes: critico.arnes });
    // dicho en llano: a qué hora lo mostró el arnés y qué pedir ahora (un ok anterior se descarta siempre)
    const hora = new Date(visto.ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
    anterior = `el ok es de antes de que se le mostrara este crítico: el arnés se lo mostró a las ${hora} y lo que contestó antes no cuenta. `
      + `Pedile que conteste ahora a la muestra, por ejemplo «eximo ${String(critico.rule).trim()}»`;
    return null;
  };
  if (relayedBy !== null && relayedBy !== undefined) {
    const sesion = String(relayedBy).trim();
    const declarada = sesionQueReenvia({ env, home, arnes });
    if (!declarada.valor) {
      return { ok: false, motivo: `la organización no declara ninguna sesión que pueda reenviar el ok de un dev (approvals.relay_session del perfil del equipo)${declarada.aviso ? `: ${declarada.aviso}` : ''}` };
    }
    if (!sesion || sesion.toLowerCase() !== declarada.valor.toLowerCase()) {
      return { ok: false, motivo: `la sesión «${sesion}» no es la que la organización deja reenviar el ok de un dev («${declarada.valor}», approvals.relay_session)` };
    }
    const sinRespuesta = respuestaAlCritico();
    if (sinRespuesta) return sinRespuesta;
    const r = pok.citaReenviada(cita, sesion, { env, home, desde, juzgar });
    if (!r.legible) return { ok: false, sinConversacion: true, motivo: `no puedo leer la conversación de esta sesión (${r.motivo})` };
    if (r.corta) return { ok: false, motivo: `la cita es muy corta: tiene que tener al menos ${pok.CITA_MINIMA} letras o dígitos` };
    if (!r.encontrada) return { ok: false, motivo: r.rechazo || (r.anterior ? anterior : `la cita no la encontré en un mensaje que haya llegado de la sesión «${sesion}»`) };
    return { ok: true, entrada: { tipo: 'automatica', quien: `agente ${sesion}`, delegacion: quien, relevo: sesion, cita, cita_cuando: r.cuando || null, sesion: sesionActual(env), via: `ok de ${quien} reenviado por la sesión ${sesion}` } };
  }
  const sinRespuesta = respuestaAlCritico();
  if (sinRespuesta) return sinRespuesta;
  const r = pok.citaDeLaPersona(cita, { env, home, desde, juzgar });
  if (!r.legible) return { ok: false, sinConversacion: true, motivo: `no puedo leer la conversación de esta sesión (${r.motivo})` };
  if (r.corta) return { ok: false, motivo: `la cita es muy corta: tiene que tener al menos ${pok.CITA_MINIMA} letras o dígitos` };
  if (!r.encontrada) return { ok: false, motivo: r.rechazo || (r.anterior ? anterior : `la cita no la encontré en un mensaje escrito por ${quien} en esta conversación (no cuentan lo que escribió el agente, una herramienta, un subagente u otra sesión)`) };
  return { ok: true, entrada: { tipo: 'manual', quien, cita, cita_cuando: r.cuando || null, sesion: sesionActual(env), via: 'ok del dev en el chat' } };
}

function sesionActual(env) {
  const s = String((env || process.env).CLAUDE_CODE_SESSION_ID || '').trim();
  return /^[\w-]+$/.test(s) ? s : null;
}

module.exports = { huella, fueraDelRegistro, constanciaInvalida, renglonesDeFaltantes, sh, reglaDe, revisar, noEsPersona, okDeUnaPersona, sesionQueReenvia, FILE, clave, esCriticoEximido, anotar, leer, faltantes, verificarExenciones, caminos };
