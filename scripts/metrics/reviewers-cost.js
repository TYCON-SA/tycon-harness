#!/usr/bin/env node
/**
 * reviewers-cost.js — cuánto cuesta la REVISIÓN de cada corrida del pipeline.
 * Story 2.15 del arnés (2026-09-09).
 *
 * QUÉ PUBLICA, POR CORRIDA (bloque `revisores` adentro del volcado de `timing-history/`)
 * ------------------------------------------------------------------------------------
 *   · cuántos revisores se lanzaron, de qué tipo, con qué modelo y en qué vuelta;
 *   · por revisor: cuánto TARDÓ, cuánto DEVOLVIÓ (bytes del informe) y —cuando la notificación lo
 *     trae— cuántos TOKENS consumió, marcados `medido`;
 *   · cuántos no volvieron (`sin_resultado`): un revisor que no volvió NO es uno de duración cero;
 *   · un campo `estimado`, APARTE, sólo para los lanzamientos sin tokens medidos, con el supuesto
 *     a la vista (rango por lanzamiento, de dónde sale, cuándo se midió y cuándo vence).
 *
 * 🔴 LA REGLA QUE ORDENA TODO: lo medido y lo estimado no se suman en el mismo número. Ni entre sí,
 * ni al consumo del hilo del padre (`consumo.tokens`, de la story 2.13), que es OTRO consumo.
 * `verificarSeparacion()` lo chequea y `--run` sale 2 si no pasa.
 *
 * DE DÓNDE SALE CADA COSA (medido el 2026-09-09, no supuesto)
 * -----------------------------------------------------------
 *   · LANZAMIENTOS: el registro `advisor-runs/<sessionId>.jsonl` que escribe el hook del pipeline
 *     ({ts, advisor, model} por lanzamiento; {event:"step5-start", iter} por vuelta). Es el padrón.
 *     No trae identificador de lanzamiento, así que cada línea se empareja con el `tool_use`
 *     `Agent`/`Task` de la conversación del mismo tipo y hora más cercana (±2 min; el hook escribe
 *     la línea ANTES del spawn, así que suelen estar a un segundo). Sin registro (los viejos se
 *     resumen por sesión y se borran), el padrón es la conversación, y la vuelta queda «sin
 *     registro». Sin ninguna de las dos, quedan los conteos que dejó el archivador (`costo`).
 *   · RESULTADOS: por IDENTIFICADOR, nunca por orden — el pipeline lanza revisores en paralelo y
 *     las notificaciones llegan en cualquier orden. Dos formas (y la primera vive en tres lugares,
 *     ver `resultadosDeConversacion`):
 *       (a) segundo plano (el modo obligatorio desde el 2026-07-30): un mensaje `user` con
 *           `<task-notification>` que cita `<tool-use-id>` y trae `<result>` y, al final,
 *           `<usage><subagent_tokens/><tool_uses/><duration_ms/></usage>` — 338 de 341 medidas.
 *           El `tool_result` inmediato de ese lanzamiento dice «Async agent launched…»: es el
 *           acuse, no el informe, y se descarta.
 *       (b) bloqueante: el informe vuelve en el `tool_result` con `tool_use_id`. Sin bloque de
 *           uso → duración por hora de ida y vuelta, tamaño del informe, y tokens `no_medido`.
 *   · LA CONVERSACIÓN: la viva (`~/.claude/projects/<carpeta>/<sessionId>.jsonl`, ubicada por
 *     tokens-digest.js) o, si ya no está, el HILO que guardó la 2.13 (`<volcado>.hilo.jsonl.gz`),
 *     que conserva lanzamientos y notificaciones. Se dice de cuál salió (`fuente`).
 *
 * REGLA CARDINAL (la misma de toda la familia): nunca un cero donde hubo ausencia. Sin conversación
 * ni hilo, la duración, el tamaño y los tokens salen `no_medido` con motivo y SIN cifra; el conteo
 * y los tipos se publican igual, porque ésos sí están.
 *
 * USO
 *   node reviewers-cost.js --run <volcado.json> [opciones] [--json]
 *   node reviewers-cost.js --all [--history-dir D] [opciones] [--budget-ms N] [--json]
 *   opciones: --projects-dir D · --runs-dir D (advisor-runs) · --assumption <json> · --today <YYYY-MM-DD>
 *
 * Salidas: 0 procesó (aunque haya `no_medido`: eso también es medir) · 2 no pudo arrancar, no pudo
 * persistir, o la separación medido/estimado no pasó.
 *
 * Lo llama también el barrido de tokens-digest.js (`--run`/`--pending`/`--all`), con
 * `require` perezoso: sin este archivo, el rescate del hilo se escribe igual y `revisores` queda
 * con motivo.
 *
 * EL VEREDICTO DEL VALIDADOR DE STORIES (story 7.3, 2026-09-17)
 * -------------------------------------------------------------
 *   · Cada lanzamiento de `tycon-story-validator` lleva `veredicto` (el renglón `Veredicto:` con que
 *     cierra su informe, leído por `scripts/lib/validator-verdict.js`), `veredicto_reglas`,
 *     `veredicto_bloquea` y `sobre_otra_story`; `revisores.validador` lo resume por fase.
 *   · Un informe entregado por TRASPASO (la notificación sólo dice «se entregó como mensaje de
 *     <agente>») se lee del mensaje `<agent-message>` de ese agente: para el veredicto y para
 *     `devuelto_bytes`, que antes medía el aviso.
 *   · `veredictosDeConversacion` es la misma lectura para `pipeline.js` (agent-skills), que decide si
 *     relanza al validador en un re-loop: una sola lectura de la conversación, no dos.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const zlib = require('zlib');
const crypto = require('crypto');

const digest = require('./tokens-digest.js');
const { veredictoDe } = require('../lib/validator-verdict.js');

// Cuánto puede separarse la línea del registro del `tool_use` que la generó. Medido: el hook
// escribe antes del spawn, a un segundo; 2 minutos absorben una máquina cargada.
const VENTANA_EMPAREJADO_MS = 120000;
const SUPUESTO_DEFAULT = path.join(__dirname, 'reviewers-cost-assumption.json');
const SIN_DECLARAR = 'sin declarar';
const SIN_REGISTRO = 'sin registro';
const VALIDADOR = 'tycon-story-validator';
// Las fases del resumen, en orden y siempre presentes: una fase ausente y una en cero no son lo mismo.
const FASES_VALIDADOR = ['antes-de-implementar', 'vuelta-1', 're-loop', 'sin-vuelta', 'otra-story'];
const ESTADOS_VEREDICTO = ['limpio', 'hallazgos', 'inconsistente', 'sin_veredicto', 'no_medido'];
// El aviso con que Claude Code reemplaza el informe cuando el agente lo entregó por traspaso.
const AVISO_TRASPASO = /delivered to you as a message from "([^"]+)"/;
// `.md` que un prompt nombra y NO son una story (contexto de revisores, guías, planificación, evidencia).
// 🔴 Por NOMBRE EXACTO de archivo o por CARPETA, nunca por un pedazo del nombre (pase adversarial
// 2026-09-17): con `catalog`, `README` o `-pasos.md` sueltos, una story real con esa palabra en el slug
// («…-armar-el-catalogo-de-productos.md») salía «no sé», su veredicto contaba como propio y podía soltar
// al validador con la mitad de la evidencia. Lo que no se reconoce acá cuenta como OTRA story: sale de la
// racha, que es la dirección segura.
const NO_ES_STORY_NOMBRE = /^(?:readme|skill|claude|agents|todo|epics|story-format|advisor-rules-catalog|incident-log|guide-update-proposals|sprint-status|rubrica)\.md$|^step-\d{2}[a-z]?-/i;
const NO_ES_STORY_CARPETA = /\/(?:advisor-context|steps?|guides|qa|dod-runtime|pipeline-runs|tasks)\//i;
function noEsStory(ruta) {
  const r = `/${String(ruta).replace(/\\/g, '/')}`;
  return NO_ES_STORY_NOMBRE.test(path.posix.basename(r)) || NO_ES_STORY_CARPETA.test(r);
}

// ── Utilidades ───────────────────────────────────────────────────────────────────────────────────

function ms(iso) {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? t : null;
}

function mediana(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Resumen {mediana, total, n} de una lista, o `no_medido` con motivo si no hay nada que resumir. */
function resumen(xs, motivo) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return { estado: 'no_medido', motivo };
  return { mediana: mediana(v), total: v.reduce((a, b) => a + b, 0), n: v.length };
}

function textoDe(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '').join('');
  }
  return '';
}

function hashDe(v) {
  return crypto.createHash('sha256').update(JSON.stringify(v === undefined ? null : v)).digest('hex').slice(0, 16);
}

// ── Funciones puras (lo que los casos ejercitan) ─────────────────────────────────────────────────

/**
 * Los lanzamientos según el REGISTRO del hook: [{ts, tipo, modelo, vuelta}], en orden.
 * La vuelta es el `iter` del último `step5-start` anterior; 0 si no hubo ninguno todavía.
 */
function lanzamientosDelRegistro(lineas) {
  const out = [];
  let vuelta = 0;
  for (const l of lineas) {
    if (!l || typeof l !== 'object') continue;
    if (l.event === 'step5-start') {
      if (Number.isFinite(Number(l.iter))) vuelta = Number(l.iter);
      continue;
    }
    if (typeof l.advisor !== 'string' || !l.advisor) continue;
    out.push({ ts: l.ts || null, tipo: l.advisor, modelo: (typeof l.model === 'string' && l.model) ? l.model : null, vuelta });
  }
  return out;
}

/** Los lanzamientos según la CONVERSACIÓN: cada `tool_use` de `Agent`/`Task`, con su identificador. */
function lanzamientosDeConversacion(lineas) {
  const out = [];
  for (const o of lineas) {
    const c = o && o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const it of c) {
      if (!it || it.type !== 'tool_use' || (it.name !== 'Agent' && it.name !== 'Task')) continue;
      const inp = it.input && typeof it.input === 'object' ? it.input : {};
      out.push({
        id: String(it.id || ''),
        ts: o.timestamp || null,
        tipo: typeof inp.subagent_type === 'string' && inp.subagent_type ? inp.subagent_type : 'sin tipo',
        modelo: typeof inp.model === 'string' && inp.model ? inp.model : null,
        // Sólo en memoria (para saber sobre qué story es): `medir` copia campos uno por uno y el prompt
        // no se publica — trae rutas y lo que el orquestador le pidió al agente.
        prompt: typeof inp.prompt === 'string' ? inp.prompt : '',
      });
    }
  }
  return out;
}

/** Parsea una notificación de tarea. → {id, bytes, tokens, tool_uses, duracion_ms} | null */
function notificacionDe(txt) {
  if (typeof txt !== 'string' || !txt.includes('<task-notification>') || !txt.includes('<tool-use-id>')) return null;
  // 🔴 El informe del revisor es texto LIBRE y puede contener `</result>` o un `<usage>` de ejemplo
  // (pase adversarial 2026-09-10: en este mismo repo los revisores citan los fixtures de esta
  // pieza). Por eso: el identificador se busca sólo ANTES del primer `<result>`, el informe va del
  // primer `<result>` al ÚLTIMO `</result>`, y el uso se busca sólo DESPUÉS de ese cierre — que es
  // donde Claude Code lo escribe.
  const ini = txt.indexOf('<result>');
  const fin = txt.lastIndexOf('</result>');
  const cabecera = ini >= 0 ? txt.slice(0, ini) : txt;
  const idM = cabecera.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
  if (!idM) return null;
  const hayResultado = ini >= 0 && fin > ini;
  const informe = hayResultado ? txt.slice(ini + '<result>'.length, fin) : '';
  const cola = hayResultado ? txt.slice(fin + '</result>'.length) : txt.slice(cabecera.length);
  const uso = cola.match(/<usage>([\s\S]*?)<\/usage>/);
  const num = (tag) => {
    const m = uso && uso[1].match(new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`));
    return m ? Number(m[1]) : null;
  };
  const tareaM = cabecera.match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/);
  return {
    id: idM[1],
    tarea: tareaM ? tareaM[1] : null,
    informe,
    bytes: Buffer.byteLength(informe, 'utf8'),
    tokens: num('subagent_tokens'),
    tool_uses: num('tool_uses'),
    duracion_ms: num('duration_ms'),
  };
}

/**
 * El informe de un agente entregado por TRASPASO: `{ agente, texto }` o `null`.
 *
 * Forma real (hilo `equipo-deva/2.5-2026-09-15T1840`): un mensaje «Another Claude session sent a
 * message: <agent-message from="<id>"> [Subagent hand-back] … The report follows:» con cada renglón
 * del informe sangrado dos espacios, cerrado por `</agent-message>`; después del cierre el arnés agrega
 * texto propio. 🔴 Se lee SÓLO de adentro del marco (ese texto de después podría decir cualquier cosa) y
 * un marco sin cierre o sin «The report follows:» no se adivina: `null`, y el aviso queda como informe.
 * 🔴 El cierre es el renglón `</agent-message>` SIN sangría (medido 2026-09-17: 78 de 78 traspasos reales
 * cierran así y 353 de 353 renglones del informe van sangrados). Ni el primero a secas —un informe que cita
 * el tag perdía su renglón `Veredicto:`— ni el último, que fundiría dos marcos seguidos.
 */
function traspasoDe(txt) {
  if (typeof txt !== 'string' || !txt.includes('<agent-message from=') || !txt.includes('[Subagent hand-back]')) return null;
  const ini = txt.indexOf('<agent-message from=');
  const agenteM = txt.slice(ini).match(/^<agent-message from="([^"]+)">/);
  const cierre = /\n<\/agent-message>/g;
  cierre.lastIndex = ini;
  const mc = cierre.exec(txt);
  const fin = mc ? mc.index : -1;
  if (!agenteM || fin < 0) return null;
  const marco = txt.slice(ini, fin);
  const k = marco.indexOf('The report follows:');
  if (k < 0) return null;
  const texto = marco.slice(k + 'The report follows:'.length)
    .replace(/^\r?\n/, '')
    .split('\n').map((r) => (r.startsWith('  ') ? r.slice(2) : r)).join('\n')
    .replace(/\s+$/, '');
  return { agente: agenteM[1], texto };
}

/**
 * ¿El prompt de un lanzamiento es sobre OTRA story que la de la corrida? `true` · `false` · `null`.
 * `false` si nombra el `.md` de la corrida; `true` si nombra otro `.md` que no es contexto, guía ni
 * planificación; `null` si no nombra ninguno (o no se sabe cuál es la story de la corrida).
 */
function sobreOtraStory(prompt, storyPath) {
  if (typeof prompt !== 'string' || !prompt) return null;
  const base = storyPath ? path.basename(String(storyPath)) : null;
  if (base && prompt.includes(base)) return false;
  const mds = (prompt.match(/[^\s`'"()<>[\]]+\.md\b/g) || []).filter((p) => !noEsStory(p));
  if (!mds.length || !base) return null;
  return true;
}

// ¿Es la línea con que Claude Code ENCOLA una notificación de agente? Vive en tokens-digest.js
// (el hilo la conserva por esa misma regla) y se IMPORTA: dos copias se separan solas.
const { esNotificacionEncolada } = digest;

/**
 * Los resultados de la conversación, por identificador de lanzamiento.
 * Map id → {ts, bytes, tokens|null, tool_uses|null, duracion_ms|null, fuente}.
 *
 * 🔴 La notificación de un agente vive en TRES lugares posibles, medido el 2026-09-10 sobre las 300
 * conversaciones más recientes: como mensaje `user` (273) cuando el padre estaba libre, y —cuando
 * estaba ocupado— ENCOLADA: una línea `queue-operation` (`operation: enqueue`, el texto en
 * `content`) y una `attachment` (`attachment.type: queued_command`, el texto en `prompt`), sin
 * ninguna línea `user` (173 sólo así: el 39 %). Leer sólo los mensajes `user` daba 769 «sin
 * resultado» sobre 1930 lanzamientos reales. La misma notificación puede aparecer hasta tres
 * veces (encolada, adjunta, quitada de la cola): cuenta UNA, con la hora más temprana.
 * La notificación gana sobre el tool_result; el acuse «Async agent launched» no cuenta.
 */
function resultadosDeConversacion(lineas) {
  const out = new Map();
  const traspasos = new Map(); // agente → texto del informe entregado por traspaso (story 7.3)
  const anotar = (n, ts, fuente) => {
    const prev = out.get(n.id);
    if (prev && prev.fuente !== 'tool_result') {
      const t = ms(ts);
      const tp = ms(prev.ts);
      if (t !== null && (tp === null || t < tp)) prev.ts = ts;
      if (!Number.isFinite(prev.tokens) && Number.isFinite(n.tokens)) {
        prev.tokens = n.tokens; prev.tool_uses = n.tool_uses; prev.duracion_ms = n.duracion_ms;
      }
      if (!prev.informe && n.informe) prev.informe = n.informe; // para el veredicto; los bytes medidos no cambian
      if (fuente === 'notificacion') prev.fuente = 'notificacion';
      return;
    }
    out.set(n.id, { ts: ts || null, bytes: n.bytes, tokens: n.tokens, tool_uses: n.tool_uses, duracion_ms: n.duracion_ms, fuente, informe: n.informe });
  };
  // El traspaso también puede llegar encolado, igual que una notificación: se mira en los tres lugares.
  const tomarTraspaso = (txt) => { const tr = traspasoDe(txt); if (tr && !traspasos.has(tr.agente)) traspasos.set(tr.agente, tr.texto); return !!tr; };
  for (const o of lineas) {
    if (!o) continue;
    if (o.type === 'queue-operation') {
      if (esNotificacionEncolada(o)) { const n = notificacionDe(o.content); if (n) anotar(n, o.timestamp, 'notificacion_encolada'); }
      else if (o.operation === 'enqueue' && typeof o.content === 'string') tomarTraspaso(o.content);
      continue;
    }
    if (o.type === 'attachment') {
      const a = o.attachment;
      // Sólo el adjunto que Claude Code usa para entregar lo encolado (`queued_command`): otro adjunto
      // cuyo texto se parezca a una notificación no es una notificación (pase adversarial 2026-09-10).
      const prompt = a && typeof a === 'object' && a.type === 'queued_command' && typeof a.prompt === 'string' ? a.prompt : null;
      const n = prompt ? notificacionDe(prompt) : null;
      if (n) anotar(n, o.timestamp, 'notificacion_encolada');
      else if (prompt) tomarTraspaso(prompt);
      continue;
    }
    if (!o.message) continue;
    const c = o.message.content;
    const txt = textoDe(c);
    const n = notificacionDe(txt);
    if (n) { anotar(n, o.timestamp, 'notificacion'); continue; }
    if (tomarTraspaso(txt)) continue;
    if (!Array.isArray(c)) continue;
    for (const it of c) {
      if (!it || it.type !== 'tool_result' || !it.tool_use_id) continue;
      const t = textoDe(it.content);
      if (/^\s*Async agent launched/.test(t)) continue; // el acuse del lanzamiento, no el informe
      const id = String(it.tool_use_id);
      if (out.has(id)) continue;
      out.set(id, { ts: o.timestamp || null, bytes: Buffer.byteLength(t, 'utf8'), tokens: null, tool_uses: null, duracion_ms: null, fuente: 'tool_result', informe: t });
    }
  }
  // 🔴 El informe por traspaso reemplaza al aviso: sin esto, el tamaño medido era el del aviso y el
  // veredicto se buscaba en un texto que dice «leelo en otro lado» (story 7.3).
  for (const r of out.values()) {
    const m = typeof r.informe === 'string' ? r.informe.match(AVISO_TRASPASO) : null;
    if (!m || !traspasos.has(m[1])) continue;
    r.informe = traspasos.get(m[1]);
    r.bytes = Buffer.byteLength(r.informe, 'utf8');
    r.traspaso = true;
  }
  return out;
}

/**
 * Los veredictos de los lanzamientos de un tipo de revisor (por default, el validador de stories), en
 * el orden en que se lanzaron. Lo usan `medir` y `pipeline.js` (agent-skills), para decidir si en un
 * re-loop hace falta relanzarlo.
 * → [{ id, ts, veredicto, reglas, bloquea, sobre_otra_story, con_resultado, fuente }]
 * `veredicto` es `no_medido` si el lanzamiento no volvió: un revisor que no volvió no dijo nada.
 */
function veredictosDeConversacion(lineas, { tipo = VALIDADOR, storyPath = null } = {}) {
  const res = resultadosDeConversacion(lineas);
  return lanzamientosDeConversacion(lineas)
    .filter((l) => l.tipo === tipo)
    .map((l, i) => {
      const r = res.get(l.id);
      const v = r ? veredictoDe(r.informe) : null;
      return {
        id: l.id,
        ts: l.ts,
        veredicto: v ? v.estado : 'no_medido',
        reglas: v ? v.reglas : [],
        bloquea: v ? v.bloquea : null,
        sobre_otra_story: sobreOtraStory(l.prompt, storyPath),
        con_resultado: !!r,
        fuente: r ? (r.traspaso ? 'traspaso' : r.fuente) : null,
        orden: i,
      };
    })
    .sort((a, b) => ((ms(a.ts) ?? Infinity) - (ms(b.ts) ?? Infinity)) || (a.orden - b.orden))
    .map(({ orden, ...resto }) => resto);
}

/**
 * Empareja cada línea del registro con un `tool_use` de la conversación: mismo tipo, dentro de la
 * ventana, cada `tool_use` una sola vez — y de CARDINALIDAD MÁXIMA (Kuhn con caminos aumentantes,
 * candidatos ordenados por cercanía). El greedy «el más cercano primero» dejaba `no_ubicado` a un
 * lanzamiento cuya única pareja se la había llevado el anterior aunque éste tuviera otra (pase
 * adversarial 2026-09-10). Los grafos son chicos (≤ decenas por corrida): el costo es nulo.
 *
 * Devuelve {lanzamientos: [{...reg, id|null, en_registro: true}], fuera_del_registro: [conv...]} —
 * los `tool_use` que ningún registro reclama se DEVUELVEN (no sólo se cuentan): son lanzamientos
 * reales que el hook no anotó, y su costo tiene que entrar al padrón (el archivador los cuenta del
 * mismo registro incompleto, así que sin esto nadie los vería).
 */
function emparejar(registro, conversacion) {
  const conv = conversacion.map((l) => ({ ...l, t: ms(l.ts) }));
  const candidatos = registro.map((r) => {
    const t = ms(r.ts);
    return conv
      .map((c, j) => ({ j, dist: (t === null || c.t === null) ? Infinity : Math.abs(c.t - t) }))
      .filter((x) => conv[x.j].tipo === r.tipo && x.dist <= VENTANA_EMPAREJADO_MS)
      .sort((a, b) => a.dist - b.dist)
      .map((x) => x.j);
  });
  const duenoDe = new Array(conv.length).fill(-1); // índice de conversación → índice de registro
  const intentar = (i, visto) => {
    for (const j of candidatos[i]) {
      if (visto.has(j)) continue;
      visto.add(j);
      if (duenoDe[j] === -1 || intentar(duenoDe[j], visto)) { duenoDe[j] = i; return true; }
    }
    return false;
  };
  const idDe = new Array(registro.length).fill(null);
  for (let i = 0; i < registro.length; i += 1) intentar(i, new Set());
  for (let j = 0; j < conv.length; j += 1) if (duenoDe[j] !== -1) idDe[duenoDe[j]] = conv[j].id;
  const lanzamientos = registro.map((r, i) => {
    const c = idDe[i] !== null ? conv.find((x) => x.id === idDe[i]) : null;
    return { ...r, id: idDe[i], modelo: r.modelo || (c && c.modelo) || null, en_registro: true };
  });
  const fuera = conv.filter((c, j) => duenoDe[j] === -1)
    .map((c) => ({ ts: c.ts, tipo: c.tipo, modelo: c.modelo, vuelta: null, id: c.id, en_registro: false }));
  return { lanzamientos, fuera_del_registro: fuera };
}

/** El estimado, sólo sobre lo que NO se midió. Con el supuesto vencido o ilegible, `no_medido`. */
function estimar(sinMedir, supuesto, hoy) {
  if (sinMedir === 0) return { estado: 'vacio', motivo: 'todos los lanzamientos tienen tokens medidos: no hay nada que estimar', lanzamientos_cubiertos: 0 };
  if (!supuesto || supuesto.error) {
    return { estado: 'no_medido', motivo: `sin supuesto no hay estimación: ${supuesto ? supuesto.error : 'no se cargó'}`, lanzamientos_sin_medir: sinMedir };
  }
  const s = supuesto.valor;
  const rango = Array.isArray(s.tokens_per_launch_range) ? s.tokens_per_launch_range.map(Number) : null;
  if (!rango || rango.length !== 2 || !rango.every(Number.isFinite) || rango[0] > rango[1]) {
    return { estado: 'no_medido', motivo: 'el supuesto no trae un rango válido (`tokens_per_launch_range: [min, max]`)', lanzamientos_sin_medir: sinMedir };
  }
  const vence = ms(s.review_before);
  const ahora = ms(hoy);
  if (vence === null || ahora === null) {
    return { estado: 'no_medido', motivo: 'el supuesto no tiene una fecha de revisión legible (`review_before`), y sin fecha no ampara ninguna cuenta', lanzamientos_sin_medir: sinMedir };
  }
  if (ahora > vence) {
    return {
      estado: 'no_medido',
      motivo: `el supuesto venció el ${s.review_before} (medido el ${s.measured_on || '?'}): hay que re-medir o renovar la fecha en reviewers-cost-assumption.json`,
      lanzamientos_sin_medir: sinMedir,
    };
  }
  // La salida conserva sus claves de siempre (story 8.9, pregunta decidida 2): el archivo se lee en inglés.
  return {
    estado: 'estimado',
    lanzamientos_cubiertos: sinMedir,
    tokens_min: sinMedir * rango[0],
    tokens_max: sinMedir * rango[1],
    supuesto: { rango_tokens_por_lanzamiento: rango, fuente: s.source || null, medido_el: s.measured_on || null, revisar_antes_de: s.review_before },
  };
}

/**
 * Arma el bloque `revisores`.
 *   registro: líneas del advisor-runs (o null si no hay archivo)
 *   conversacion: {lineas, fuente:'conversacion'|'hilo_guardado'} o {estado, motivo} si no hay
 *   costo: el `costo` que dejó el archivador (padrón de último recurso)
 */
/** La fase de un lanzamiento del validador para el resumen: la otra story gana sobre la vuelta. */
function faseDelValidador(item) {
  if (item.sobre_otra_story === true) return 'otra-story';
  const v = Number(item.vuelta);
  if (item.vuelta === null || item.vuelta === undefined || !Number.isFinite(v)) return 'sin-vuelta';
  if (v >= 2) return 're-loop';
  if (v >= 1) return 'vuelta-1';
  return 'antes-de-implementar';
}

/** `revisores.validador`: conteos por fase y por veredicto, con todas las fases presentes. */
function resumenDelValidador(detalle, hayConv, motivoSinConv) {
  const vacio = () => Object.fromEntries([['lanzamientos', 0], ...ESTADOS_VEREDICTO.map((e) => [e, 0])]);
  const porFase = Object.fromEntries(FASES_VALIDADOR.map((f) => [f, vacio()]));
  const propios = detalle.filter((d) => d.tipo === VALIDADOR);
  for (const d of propios) {
    const f = porFase[faseDelValidador(d)];
    f.lanzamientos += 1;
    f[ESTADOS_VEREDICTO.includes(d.veredicto) ? d.veredicto : 'no_medido'] += 1;
  }
  return hayConv
    ? { estado: 'medido', lanzamientos: propios.length, por_fase: porFase }
    : { estado: 'no_medido', motivo: motivoSinConv, lanzamientos: propios.length, por_fase: porFase };
}

function medir({ registro, conversacion, costo, supuesto, hoy, consumo, storyPath = null }) {
  const hayConv = conversacion && Array.isArray(conversacion.lineas);
  const out = {
    estado: hayConv ? 'medido' : (conversacion && conversacion.estado) || 'no_medido',
    fuente: hayConv ? conversacion.fuente : null,
    fuente_lanzamientos: null,
    medido_en: new Date().toISOString(),
  };
  if (!hayConv) out.motivo = (conversacion && conversacion.motivo) || 'sin conversación ni hilo guardado';

  // ── El padrón de lanzamientos ──
  let lanzamientos;
  let fueraDelRegistro = 0;
  const convLanz = hayConv ? lanzamientosDeConversacion(conversacion.lineas) : [];
  if (Array.isArray(registro)) {
    out.fuente_lanzamientos = 'registro';
    const reg = lanzamientosDelRegistro(registro);
    if (hayConv) {
      const e = emparejar(reg, convLanz);
      // Los lanzamientos que la conversación muestra y el registro no tiene ENTRAN al padrón
      // (vuelta «sin registro»): un revisor real que el hook no anotó no puede quedar fuera de
      // todos los totales sin que nada lo diga (pase adversarial 2026-09-10).
      lanzamientos = e.lanzamientos.concat(e.fuera_del_registro);
      fueraDelRegistro = e.fuera_del_registro.length;
      if (fueraDelRegistro) out.fuente_lanzamientos = 'registro+conversacion';
    } else {
      lanzamientos = reg.map((r) => ({ ...r, id: null, en_registro: true }));
    }
  } else if (hayConv) {
    out.fuente_lanzamientos = 'conversacion';
    lanzamientos = convLanz.map((l) => ({ ts: l.ts, tipo: l.tipo, modelo: l.modelo, vuelta: null, id: l.id, en_registro: false }));
  } else if (costo && Number.isFinite(costo.spawns)) {
    out.fuente_lanzamientos = 'archivador';
    lanzamientos = null;
  } else {
    out.fuente_lanzamientos = null;
    out.estado = 'no_medido';
    out.motivo = `${out.motivo ? `${out.motivo}; ` : ''}tampoco hay registro de lanzamientos ni conteo del archivador: no se sabe cuántos revisores corrieron`;
    out.lanzamientos = null;
    out.estimado = { estado: 'no_medido', motivo: 'sin cantidad de lanzamientos no se puede estimar' };
    out.validador = { estado: 'no_medido', motivo: 'sin registro de lanzamientos ni conversación: no se sabe cuántas veces corrió el validador ni qué dijo' };
    out.consumo_visto = consumo && consumo.tokens ? hashDe(consumo.tokens) : null;
    return out;
  }

  // ── Conteos ──
  const cuenta = (xs, f) => xs.reduce((acc, x) => { const k = f(x); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  if (lanzamientos) {
    out.lanzamientos = lanzamientos.length;
    out.por_tipo = cuenta(lanzamientos, (l) => l.tipo);
    out.por_modelo = cuenta(lanzamientos, (l) => l.modelo || SIN_DECLARAR);
    out.por_vuelta = cuenta(lanzamientos, (l) => (l.vuelta === null || l.vuelta === undefined) ? SIN_REGISTRO : String(l.vuelta));
  } else {
    out.lanzamientos = costo.spawns;
    out.por_tipo = costo.por_tipo && typeof costo.por_tipo === 'object' ? { ...costo.por_tipo } : {};
    out.por_modelo = { [SIN_REGISTRO]: costo.spawns };
    out.por_vuelta = { [SIN_REGISTRO]: costo.spawns };
    out.motivo = `${out.motivo ? `${out.motivo}; ` : ''}los lanzamientos salen del conteo del archivador (sin registro por lanzamiento ni conversación): sin tipo por revisor ni vuelta`;
  }

  // ── Resultados, por identificador ──
  const resultados = hayConv ? resultadosDeConversacion(conversacion.lineas) : new Map();
  const promptPorId = new Map(convLanz.map((l) => [l.id, l.prompt]));
  const detalle = [];
  let sinResultado = 0;
  let noUbicados = 0;
  for (const l of (lanzamientos || [])) {
    const item = { tipo: l.tipo, modelo: l.modelo, vuelta: l.vuelta, lanzado: l.ts || null, en_registro: l.en_registro !== false };
    // Story 7.3: el validador de stories deja su veredicto. Se decide ANTES de medir y se completa
    // abajo; los demás revisores no ganan campos.
    const esValidador = l.tipo === VALIDADOR;
    if (!hayConv) {
      item.estado = 'no_medido';
      item.duracion_ms = null; item.devuelto_bytes = null; item.tokens = null; item.tool_uses = null; item.resultado_fuente = null;
    } else if (!l.id) {
      item.estado = 'no_ubicado';
      noUbicados += 1;
      item.duracion_ms = null; item.devuelto_bytes = null; item.tokens = null; item.tool_uses = null; item.resultado_fuente = null;
    } else {
      const r = resultados.get(l.id);
      if (!r) {
        item.estado = 'sin_resultado';
        sinResultado += 1;
        item.duracion_ms = null; item.devuelto_bytes = null; item.tokens = null; item.tool_uses = null; item.resultado_fuente = null;
      } else {
        const t0 = ms(l.ts);
        const t1 = ms(r.ts);
        const idaYVuelta = (t0 !== null && t1 !== null && t1 >= t0) ? t1 - t0 : null;
        item.estado = 'medido';
        item.duracion_ms = Number.isFinite(r.duracion_ms) ? r.duracion_ms : idaYVuelta;
        item.devuelto_bytes = r.bytes;
        item.tokens = Number.isFinite(r.tokens) ? r.tokens : null;
        item.tool_uses = Number.isFinite(r.tool_uses) ? r.tool_uses : null;
        item.resultado_fuente = r.fuente;
      }
    }
    if (esValidador) {
      // Sin resultado medido no hay veredicto: `no_medido`, nunca `limpio` ni `sin_veredicto` inventados.
      const r = item.estado === 'medido' ? resultados.get(l.id) : null;
      const v = r ? veredictoDe(r.informe) : null;
      item.veredicto = v ? v.estado : 'no_medido';
      item.veredicto_reglas = v ? v.reglas : [];
      item.veredicto_bloquea = v ? v.bloquea : null;
      item.sobre_otra_story = l.id && promptPorId.has(l.id) ? sobreOtraStory(promptPorId.get(l.id), storyPath) : null;
    }
    detalle.push(item);
  }
  out.con_resultado = detalle.filter((d) => d.estado === 'medido').length;
  out.sin_resultado = sinResultado;
  out.no_ubicados = noUbicados;
  out.fuera_del_registro = fueraDelRegistro;
  const conTokens = detalle.filter((d) => Number.isFinite(d.tokens));
  out.con_tokens = conTokens.length;

  const motivoSinConv = hayConv
    ? 'ningún revisor volvió con resultado en la conversación'
    : `sin conversación ni hilo guardado no se sabe cuánto tardaron ni qué devolvieron (${out.motivo || 'motivo no anotado'})`;
  out.duracion_ms = resumen(detalle.map((d) => d.duracion_ms), motivoSinConv);
  out.devuelto_bytes = resumen(detalle.map((d) => d.devuelto_bytes), motivoSinConv);
  out.tokens_medidos = conTokens.length
    ? { total: conTokens.reduce((a, d) => a + d.tokens, 0), n: conTokens.length }
    : { estado: 'no_medido', motivo: hayConv ? 'ninguna notificación trajo `subagent_tokens` (lanzamientos bloqueantes, o sin resultado)' : motivoSinConv };
  out.detalle = detalle;
  out.validador = lanzamientos
    ? resumenDelValidador(detalle, hayConv, motivoSinConv)
    : { estado: 'no_medido', motivo: 'los lanzamientos salen del conteo del archivador (sin detalle por lanzamiento): no se sabe qué dijo el validador en cada fase' };
  if (hayConv && lanzamientos && (sinResultado || noUbicados || !conTokens.length)) out.estado = 'parcial';
  if (lanzamientos === null && hayConv) out.estado = 'parcial';

  // ── Lo estimado, APARTE ──
  out.estimado = estimar(out.lanzamientos - out.con_tokens, supuesto, hoy);
  // La foto del consumo del hilo al momento de medir: si alguien le suma el estimado después, el
  // chequeo de separación lo ve.
  out.consumo_visto = consumo && consumo.tokens ? hashDe(consumo.tokens) : null;
  return out;
}

/**
 * ¿Lo medido y lo estimado siguen separados? {ok, motivos[]}.
 * Se chequea sobre el volcado ENTERO: el estimado no puede haber entrado ni en los tokens medidos
 * de los revisores ni en el consumo del hilo del padre.
 */
function verificarSeparacion(dump) {
  const motivos = [];
  const r = dump && dump.revisores;
  if (!r || typeof r !== 'object') return { ok: false, motivos: ['el volcado no tiene bloque `revisores`'] };
  const est = r.estimado && typeof r.estimado === 'object' ? r.estimado : null;
  const tm = r.tokens_medidos && typeof r.tokens_medidos === 'object' ? r.tokens_medidos : null;

  if (tm && Number.isFinite(tm.total)) {
    const suma = (r.detalle || []).filter((d) => d && Number.isFinite(d.tokens)).reduce((a, d) => a + d.tokens, 0);
    if (suma !== tm.total) motivos.push(`tokens_medidos.total (${tm.total}) no es la suma de los tokens medidos del detalle (${suma}): algo ajeno entró`);
  }
  if (est && est.estado === 'estimado') {
    if (Number.isFinite(r.lanzamientos) && Number.isFinite(r.con_tokens) && est.lanzamientos_cubiertos + r.con_tokens !== r.lanzamientos) {
      motivos.push(`el estimado cubre ${est.lanzamientos_cubiertos} y hay ${r.con_tokens} con tokens medidos, pero los lanzamientos son ${r.lanzamientos}: se solapan o falta alguno`);
    }
    if (tm && Number.isFinite(tm.total)) {
      const prohibidos = new Set([tm.total + est.tokens_min, tm.total + est.tokens_max]);
      const recorrer = (v, ruta) => {
        if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            if (ruta === 'revisores' && k === 'estimado') continue;
            recorrer(x, `${ruta}.${k}`);
          }
        } else if (typeof v === 'number' && prohibidos.has(v)) {
          motivos.push(`${ruta} vale medido + estimado (${v}): los dos se sumaron`);
        }
      };
      recorrer(r, 'revisores');
    }
  }
  if (dump.consumo && dump.consumo.tokens) {
    const h = hashDe(dump.consumo.tokens);
    if (!r.consumo_visto) {
      // Sin huella no hay contra qué comparar: no es «pasa», es «no se puede saber» (pase adversarial
      // 2026-09-10: se medía sin consumo, el consumo aparecía después, y el chequeo se salteaba).
      motivos.push('los revisores se midieron cuando el consumo del hilo todavía no existía (sin huella `consumo_visto`): no se puede verificar la separación — hay que re-medir los revisores');
    } else if (h !== r.consumo_visto) {
      motivos.push('el consumo del hilo (`consumo.tokens`) cambió después de medir los revisores: si le sumaron el estimado, esto lo detecta; si el rescate volvió a correr, hay que re-medir los revisores');
    }
  }
  return { ok: motivos.length === 0, motivos };
}

// ── Borde: disco ─────────────────────────────────────────────────────────────────────────────────

function leerSupuesto(ruta) {
  try {
    const v = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (!v || typeof v !== 'object') return { error: `el supuesto (${path.basename(ruta)}) no es un objeto` };
    return { valor: v };
  } catch (e) {
    return { error: `no pude leer el supuesto (${path.basename(ruta)}): ${e.code || e.message}` };
  }
}

function leerRegistro(runsDir, sessionId) {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(String(sessionId))) return null;
  const p = path.join(runsDir, `${sessionId}.jsonl`);
  let crudo;
  try { crudo = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const out = [];
  for (const l of crudo.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* línea corrupta del registro: se salta, el resto vale */ }
  }
  return out;
}

function leerHilo(rutaGz) {
  let crudo;
  try { crudo = zlib.gunzipSync(fs.readFileSync(rutaGz)).toString('utf8'); } catch (e) { return { error: `${e.code || e.message}` }; }
  const lineas = [];
  let ilegibles = 0;
  for (const l of crudo.split('\n')) {
    if (!l.trim()) continue;
    try { lineas.push(JSON.parse(l)); } catch { ilegibles += 1; }
  }
  return { lineas, ilegibles };
}

/** La conversación de la corrida: la viva, si no el hilo guardado, si no la ausencia con motivo. */
function conversacionDe(volcado, sessionId, projectsDir) {
  const ubi = digest.ubicarTranscripcion(sessionId, projectsDir);
  if (ubi.ruta) {
    const leido = digest.leerTranscripcion(ubi.ruta);
    if (!leido.error) return { lineas: leido.lineas, fuente: 'conversacion', ilegibles: leido.ilegibles };
  }
  const gz = `${volcado.replace(/\.json$/, '')}.hilo.jsonl.gz`;
  if (fs.existsSync(gz)) {
    const h = leerHilo(gz);
    if (!h.error) return { lineas: h.lineas, fuente: 'hilo_guardado', ilegibles: h.ilegibles };
    return { estado: 'no_medido', motivo: `la conversación no está y el hilo guardado no se pudo leer (${h.error})` };
  }
  return { estado: ubi.estado || 'no_medido', motivo: `${ubi.motivo || 'conversación no ubicada'}; tampoco hay hilo guardado al lado del volcado` };
}

function escribirVolcado(ruta, dump) {
  const tmp = `${ruta}.${process.pid}.rev.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(dump, null, 2), 'utf8');
    fs.renameSync(tmp, ruta);
    return null;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* el temporal puede no haberse creado */ }
    return `no pude escribir el volcado: ${e.code || e.message}`;
  }
}

/** Una corrida. Devuelve {volcado, story, sessionId, revisores, separacion, no_persistido} o {error}. */
function procesarCorrida(volcado, opciones) {
  const o = opciones || {};
  const home = o.home || os.homedir();
  const projectsDir = o.projectsDir || path.join(home, '.claude', 'projects');
  const runsDir = o.runsDir || path.join(stateDirOf(home), 'advisor-runs');
  const supuesto = leerSupuesto(o.supuesto || SUPUESTO_DEFAULT);
  const hoy = o.hoy || new Date().toISOString().slice(0, 10);

  let dump;
  try {
    dump = JSON.parse(fs.readFileSync(volcado, 'utf8'));
  } catch (e) {
    return { volcado, error: `volcado ilegible: ${e.code || e.message}` };
  }
  const marker = dump.marker || {};
  const sessionId = marker.sessionId || null;
  const res = { volcado, story: marker.storyId || null, sessionId };

  const conversacion = sessionId
    ? conversacionDe(volcado, sessionId, projectsDir)
    : { estado: 'no_medido', motivo: 'la corrida no anotó a qué sesión pertenece' };
  const registro = leerRegistro(runsDir, sessionId);
  dump.revisores = medir({ registro, conversacion, costo: dump.costo, supuesto, hoy, consumo: dump.consumo, storyPath: marker.storyPath || null });
  res.revisores = dump.revisores;
  res.separacion = verificarSeparacion(dump);
  res.no_persistido = escribirVolcado(volcado, dump);
  return res;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

function opcionesDe(argv) {
  const arg = (n, def) => {
    const i = argv.indexOf(n);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const home = os.homedir();
  return {
    home,
    projectsDir: arg('--projects-dir', path.join(home, '.claude', 'projects')),
    runsDir: arg('--runs-dir', path.join(stateDirOf(home), 'advisor-runs')),
    historyDir: arg('--history-dir', path.join(stateDirOf(home), 'timing-history')),
    supuesto: arg('--assumption', SUPUESTO_DEFAULT),
    hoy: arg('--today', new Date().toISOString().slice(0, 10)),
    budgetMs: parseInt(arg('--budget-ms', '60000'), 10),
    corrida: arg('--run', null),
    json: argv.includes('--json'),
    todas: argv.includes('--all'),
  };
}

function resumenLegible(r) {
  if (r.error) return `${path.basename(r.volcado)}: ${r.error}\n`;
  const v = r.revisores;
  const n = v.lanzamientos === null ? '?' : v.lanzamientos;
  const d = v.duracion_ms && Number.isFinite(v.duracion_ms.mediana) ? `${Math.round(v.duracion_ms.mediana / 1000)} s (mediana, n=${v.duracion_ms.n})` : 'no medida';
  const t = v.tokens_medidos && Number.isFinite(v.tokens_medidos.total) ? `${v.tokens_medidos.total} (n=${v.tokens_medidos.n} de ${n})` : 'no medidos';
  const e = v.estimado.estado === 'estimado'
    ? `estimado ${v.estimado.tokens_min}–${v.estimado.tokens_max} para ${v.estimado.lanzamientos_cubiertos} sin medir`
    : `estimado: ${v.estimado.estado} — ${v.estimado.motivo}`;
  return `${path.basename(r.volcado)}: ${v.estado}${v.fuente ? ` (${v.fuente})` : ''} · ${n} lanzamientos · `
    + `sin resultado ${v.sin_resultado == null ? '?' : v.sin_resultado} · duración ${d} · tokens medidos ${t} · ${e}`
    + (r.no_persistido ? ` · 🔴 ${r.no_persistido}` : '')
    + (r.separacion && !r.separacion.ok ? ` · 🔴 SEPARACIÓN ROTA: ${r.separacion.motivos.join(' | ')}` : '')
    + '\n';
}

function resumenBarrido(s) {
  return `corridas archivadas: ${s.total} · procesadas: ${s.procesadas}\n`
    + `  con duración medida: ${s.con_duracion_medida}\n`
    + `  con tokens medidos (la notificación los trajo): ${s.con_tokens_medidos}\n`
    + `  sólo con estimación (nada medido): ${s.solo_estimacion}\n`
    + `  sin nada que medir ni estimar: ${s.sin_medir_ni_estimar}\n`
    + `  revisores que no volvieron: ${s.revisores_sin_resultado}\n`
    + (s.separacion_rota ? `  🔴 con la separación medido/estimado ROTA: ${s.separacion_rota}\n` : '')
    + (s.no_persistidas ? `  🔴 NO PUDE ESCRIBIR: ${s.no_persistidas}\n` : '')
    + (s.no_medidas ? `  no medidas (volcado ilegible): ${s.no_medidas}\n` : '')
    + (s.fallas_del_medidor ? `  🔴 EL MEDIDOR FALLÓ (defecto propio, no del volcado): ${s.fallas_del_medidor} — ${s.errores.join(' | ')}\n` : '')
    + (s.sin_tiempo ? `  sin tiempo en este barrido: ${s.sin_tiempo}\n` : '');
}

/**
 * El barrido de `--all`: procesa cada volcado y arma el resumen del AC7.
 * `procesar` es inyectable (default `procesarCorrida`) para que la prueba pueda forzar la rama del
 * fallo PROPIO del medidor, que con volcados reales no se provoca a voluntad (Step 5, iter 2).
 */
function barrer(volcados, o, procesar = procesarCorrida) {
  const t0 = Date.now();
  const s = {
    total: volcados.length, procesadas: 0, con_duracion_medida: 0, con_tokens_medidos: 0, solo_estimacion: 0,
    sin_medir_ni_estimar: 0, revisores_sin_resultado: 0, separacion_rota: 0, no_persistidas: 0, no_medidas: 0, sin_tiempo: 0,
    fallas_del_medidor: 0, errores: [],
  };
  for (const v of volcados) {
    if (Date.now() - t0 > o.budgetMs) { s.sin_tiempo += 1; continue; }
    let r;
    try {
      r = procesar(v, o);
    } catch (e) {
      // 🔴 Un fallo del PROPIO medidor no es un volcado ilegible (Step 5, cazador de fallos
      // silenciosos): se cuenta aparte, con el mensaje, y el resumen lo dice. Antes caía en
      // «no medidas (volcado ilegible)», que es cierto sólo para el camino `r.error`.
      s.fallas_del_medidor += 1;
      s.errores.push(`${path.basename(v)}: ${e && e.message ? e.message : String(e)}`);
      continue;
    }
    s.procesadas += 1;
    if (r.error) { s.no_medidas += 1; continue; }
    if (r.no_persistido) { s.no_persistidas += 1; continue; }
    const rv = r.revisores;
    if (!r.separacion.ok) s.separacion_rota += 1;
    const conDur = rv.duracion_ms && Number.isFinite(rv.duracion_ms.mediana);
    const conTok = rv.tokens_medidos && Number.isFinite(rv.tokens_medidos.total);
    if (conDur) s.con_duracion_medida += 1;
    if (conTok) s.con_tokens_medidos += 1;
    if (!conTok && rv.estimado && rv.estimado.estado === 'estimado') s.solo_estimacion += 1;
    if (!conTok && !(rv.estimado && rv.estimado.estado === 'estimado')) s.sin_medir_ni_estimar += 1;
    s.revisores_sin_resultado += Number.isFinite(rv.sin_resultado) ? rv.sin_resultado : 0;
  }
  return s;
}

function main(argv) {
  const o = opcionesDe(argv);
  if (argv.includes('--run')) {
    if (!o.corrida || !fs.existsSync(o.corrida)) {
      process.stderr.write('costo-revisores: --run necesita la ruta de un volcado que exista\n');
      return 2;
    }
    const r = procesarCorrida(o.corrida, o);
    process.stdout.write(o.json ? `${JSON.stringify(r, null, 2)}\n` : resumenLegible(r));
    if (r.error || r.no_persistido) return 2;
    return r.separacion.ok ? 0 : 2;
  }
  if (!o.todas) {
    process.stderr.write('costo-revisores: usá --run <volcado> | --all\n');
    return 2;
  }
  let volcados;
  try {
    volcados = fs.readdirSync(o.historyDir).filter((f) => f.endsWith('.json')).map((f) => path.join(o.historyDir, f)).sort();
  } catch (e) {
    process.stderr.write(`costo-revisores: no pude leer ${o.historyDir}: ${e.code || e.message}\n`);
    return 2;
  }
  const s = barrer(volcados, o);
  process.stdout.write(o.json ? `${JSON.stringify(s, null, 2)}\n` : resumenBarrido(s));
  return 0;
}

module.exports = {
  lanzamientosDelRegistro, lanzamientosDeConversacion, resultadosDeConversacion, notificacionDe, esNotificacionEncolada, emparejar, estimar,
  medir, verificarSeparacion, leerSupuesto, leerHilo, conversacionDe, procesarCorrida, barrer, resumenBarrido, mediana,
  // story 7.3 — el veredicto del validador de stories
  traspasoDe, sobreOtraStory, veredictosDeConversacion, faseDelValidador, VALIDADOR,
};

if (require.main === module) {
  require('../lib/legacy-names.js').aliasArgv('scripts/metrics/reviewers-cost.js', { exitCode: 2, prefix: 'costo-revisores: ' });
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`costo-revisores: ${e && e.stack ? e.stack : e}\n`);
    process.exit(2);
  }
}
