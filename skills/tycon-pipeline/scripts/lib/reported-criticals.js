'use strict';
/**
 * reported-criticals.js — los críticos que reportó cada revisor, anotados por el arnés y no por el agente.
 *
 * El agente que implementa arma `findings.json` con `pipeline.js write-findings` desde un JSON que escribe él: podía
 * omitir un crítico, bajarle la severidad, cambiarle la regla o darlo por arreglado sin que nada lo comprobara. El tope de
 * vueltas, la exención y el cierre de «Hallazgos» se apoyaban en ese archivo.
 *
 * El registro vive en `<estado>/reported-criticals/<sesión>.jsonl`, sólo para agregar, donde el freno de escritura no deja
 * entrar al agente (como `owner-approvals/`). Dos clases de renglón:
 *   - `launched`: un revisor del set de la vuelta salió. Lo escriben el gancho de antes del lanzamiento (`recordLaunch`)
 *     o `reviewers-run`. Su `iter` es el número de salida de ese revisor en la corrida, contado acá: no el `--iter` que
 *     pasa el agente, que puede faltar o repetirse.
 *   - `report`: el arnés leyó lo que contestó, en el momento en que terminó: `readable`, su motivo si no se pudo, la huella
 *     del texto y `criticals: [{ rule, count }]`. Lo escriben `reviewers-run` (Codex) y on-advisor-done.js (Claude Code).
 *   - `verdict-retry`: a un revisor que cerró sin su renglón de veredicto se le pidió una vez, al mismo agente (Claude
 *     Code) o con una segunda corrida sobre el mismo contexto (Codex). No es una salida nueva: no cuenta para el tope.
 *
 * Un crítico se identifica por su regla y cuántas veces la reportó el revisor, del renglón de veredicto con que cierra
 * («Veredicto: hallazgos (SEC-C1, SEC-C1, SEC-W2) · bloquea: sí»: la regla una vez por hallazgo). El archivo no se anota
 * ni se compara: el revisor no lo da en su respuesta, y sólo aparece si el agente le pide el detalle. Una regla crítica
 * entre corchetes en otro renglón cuenta como al menos una: el arnés no interpreta la prosa, y «no encontré nada como
 * [SEC-C3]» también cuenta (el agente lo anota con su motivo). Un reporte sin el renglón de veredicto no se lee; un
 * veredicto con otra forma («**Veredicto**: GREEN», «## Veredicto») tampoco.
 *
 * `cross` es el cruce que corren `write-findings` y los cierres de «Hallazgos» y «Preparar el commit». Una corrida sin
 * ningún renglón (empezó antes de que existiera el registro) lo dice y sigue como antes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = 'reported-criticals';
// con su sufijo de letra si lo tiene: TEST-C1b es una regla crítica del catálogo
const CODE = '[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-C\\d+(?:\\.\\d+)?[a-z]?';
// un código crítico entre corchetes, en cualquier renglón: [SEC-C3], [DODRT-C5.1]
const RE_BRACKETED = new RegExp(`\\[(${CODE})\\]`, 'g');
// un código crítico suelto, como va en el renglón del veredicto
const RE_LOOSE = new RegExp(`(?:^|[^\\w-])(${CODE})(?![\\w.-]*\\w)`, 'g');
// el renglón que se lee: empieza con «Veredicto: limpio» o «Veredicto: hallazgos (», sin viñeta ni negrita adelante
const RE_VERDICT_LINE = /^\s*Veredicto:\s*(?:limpio\b|hallazgos\s*\()/i;
// la exención de un revisor del que no hay reporte legible: la misma constancia que la de un crítico, con el revisor en
// lugar del archivo
const NO_REPORT_RULE = 'SIN-REPORTE';

const registryDir = (stateDir) => path.join(stateDir, DIR);
const registryFile = (stateDir, sessionKey) => path.join(registryDir(stateDir), `${String(sessionKey).replace(/[/\\]/g, '_')}.jsonl`);
const hashOf = (text) => crypto.createHash('sha256').update(String(text || '')).digest('hex');

// la parte del renglón de veredicto con lo que el revisor confirma resuelto de su vuelta anterior: «· resueltos (SPEC-C3)»
const RE_RESOLVED = /·\s*resueltos\s*\(([^)]*)\)/i;

/** Cada código de un texto con cuántas veces aparece. */
function codesIn(text) {
  const here = new Map();
  RE_LOOSE.lastIndex = 0;
  let m;
  while ((m = RE_LOOSE.exec(text))) here.set(m[1], (here.get(m[1]) || 0) + 1);
  return here;
}

/** Los renglones de veredicto del texto, cada uno entero aunque venga partido hasta cerrar sus paréntesis. */
function verdictLines(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!RE_VERDICT_LINE.test(line)) continue;
    const start = i;
    if (/hallazgos\s*\(/i.test(line) && !/\)/.test(line.slice(line.search(/hallazgos\s*\(/i)))) {
      while (i + 1 < lines.length && !/\)/.test(line.slice(line.search(/hallazgos\s*\(/i)))) line += ` ${lines[++i]}`;
    }
    out.push({ i: start, j: i, line });
  }
  return out;
}

/**
 * Lo que el revisor confirma resuelto de su vuelta anterior: `[{ rule, count }]`, de la parte «resueltos (…)» del último renglón
 * de veredicto. Sólo cuenta ahí: en otro renglón es prosa.
 */
function extractResolved(text) {
  // sólo el último renglón de veredicto, el que cierra el reporte: uno citado de la vuelta anterior no confirma nada
  const todos = verdictLines(text);
  const ultimo = todos.length ? todos[todos.length - 1].line : '';
  const m = RE_RESOLVED.exec(ultimo);
  return m ? [...codesIn(m[1])].map(([rule, count]) => ({ rule, count })) : [];
}

/**
 * Los críticos del texto: `[{ rule, count }]`. La cuenta sale de los renglones de veredicto (la regla repetida una vez por
 * hallazgo; con varios renglones, el mayor); una regla entre corchetes en otro renglón asegura al menos uno.
 */
function extractCriticals(text) {
  const counts = new Map();
  const mentioned = new Set();
  const lines = String(text || '').split(/\r?\n/);
  const tapados = new Set();
  for (const v of verdictLines(text)) {
    // un veredicto partido en varios renglones sigue hasta el paréntesis que lo cierra; lo que confirma resuelto no es
    // un hallazgo
    for (const [rule, n] of codesIn(v.line.replace(RE_RESOLVED, ''))) counts.set(rule, Math.max(counts.get(rule) || 0, n));
    for (let k = v.i; k <= v.j; k++) tapados.add(k);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (tapados.has(i)) continue;
    RE_BRACKETED.lastIndex = 0;
    let m;
    while ((m = RE_BRACKETED.exec(line))) mentioned.add(m[1]);
  }
  const resueltos = new Set(extractResolved(text).map((r) => r.rule));
  for (const rule of mentioned) if (!counts.has(rule) && !resueltos.has(rule)) counts.set(rule, 1);
  return [...counts].map(([rule, count]) => ({ rule, count }));
}

/** Por qué no se puede leer un reporte, o null si se lee: sin texto, o sin el renglón de veredicto. */
function unreadableReason(text) {
  const t = String(text || '');
  if (!t.trim()) return 'el reporte vino vacío';
  if (!t.split(/\r?\n/).some((l) => RE_VERDICT_LINE.test(l))) return 'el reporte no trae el renglón «Veredicto: limpio» ni «Veredicto: hallazgos (…)»';
  return null;
}

function append(stateDir, sessionKey, line) {
  const full = { ts: new Date().toISOString(), ...line };
  fs.mkdirSync(registryDir(stateDir), { recursive: true });
  fs.appendFileSync(registryFile(stateDir, sessionKey), `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

function readFileLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return { lines: [], unreadable: 0 }; throw e; }
  const lines = [];
  let unreadable = 0;
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { lines.push(JSON.parse(l)); } catch { unreadable++; }
  }
  return { lines, unreadable };
}

/** Los renglones del registro de una sesión, en orden. Un registro que no se lee devuelve [] (para contar salidas). */
function readSession(stateDir, sessionKey) {
  try { return readSessionStrict(stateDir, sessionKey); } catch { return []; }
}

/** Lo mismo, pero un registro que existe y no se lee lanza su error: quien necesita distinguirlo de «vacío». */
function readSessionStrict(stateDir, sessionKey) {
  return readFileLines(registryFile(stateDir, sessionKey)).lines;
}

/**
 * Un revisor del set salió. `o`: { stateDir, sessionKey, advisor, story, run, launcher, toolUseId }. La vuelta es su
 * número de salida en la corrida, contado en este mismo registro. `toolUseId` (el del lanzamiento en Claude Code) ata la
 * salida con el agente que le toca (`recordLaunchAgent`). Devuelve el renglón anotado.
 */
function recordLaunched(o) {
  const previas = readSession(o.stateDir, o.sessionKey).filter((d) => d && d.kind === 'launched' && d.advisor === o.advisor
    && String(d.story) === String(o.story ?? null) && (d.run || null) === (o.run || null)).length;
  return append(o.stateDir, o.sessionKey, {
    kind: 'launched', advisor: o.advisor, iter: previas + 1, story: o.story ?? null, run: o.run ?? null, launcher: o.launcher || null,
    ...(o.toolUseId ? { tool_use_id: o.toolUseId } : {}),
  });
}

/**
 * La herramienta devolvió el agente de una salida: `launch-agent` con la vuelta, la historia y la corrida del `launched`
 * del mismo `tool_use_id`. `o`: { stateDir, sessionKey, advisor, agentId, toolUseId }. Sin ese `launched` (una salida
 * fuera del set de la ronda, o sin el dato) no anota nada, y esa salida empareja como antes. Devuelve el renglón o null.
 * Así una salida que murió al arrancar no se queda con el reporte de la que la reemplazó.
 */
function recordLaunchAgent(o) {
  if (!o.agentId || !o.toolUseId) return null;
  const lines = readSession(o.stateDir, o.sessionKey);
  const salida = lines.find((d) => d && d.kind === 'launched' && d.advisor === o.advisor && d.tool_use_id === o.toolUseId);
  if (!salida) return null;
  if (lines.some((d) => d && d.kind === 'launch-agent' && d.tool_use_id === o.toolUseId)) return null;
  return append(o.stateDir, o.sessionKey, {
    kind: 'launch-agent', advisor: o.advisor, iter: salida.iter, story: salida.story ?? null, run: salida.run ?? null,
    agent_id: o.agentId, tool_use_id: o.toolUseId,
  });
}

/**
 * Lo que contestó un revisor, leído en el momento en que terminó. `o`: { stateDir, sessionKey, advisor, agentId, iter,
 * story, run, source, text, error }. `error` (no hay texto que leer: la transcripción no se abrió, el proceso falló) gana
 * sobre el texto. Devuelve el renglón anotado.
 */
function recordReport(o) {
  const motivo = o.error ? String(o.error) : unreadableReason(o.text);
  return append(o.stateDir, o.sessionKey, {
    kind: 'report', advisor: o.advisor, iter: o.iter ?? null, story: o.story ?? null, run: o.run ?? null, source: o.source || null,
    ...(o.agentId ? { agent_id: o.agentId } : {}),
    readable: !motivo, ...(motivo ? { reason: motivo } : {}),
    hash: o.text ? hashOf(o.text) : null,
    // un reporte que no se lee entero igual deja sus críticos: del lado seguro
    criticals: extractCriticals(o.text),
    // lo que confirma resuelto de su vuelta anterior (fila 55): sólo si lo dice
    ...(extractResolved(o.text).length ? { resolved: extractResolved(o.text) } : {}),
  });
}

// lo que se le pide a un revisor que cerró sin su renglón de veredicto: sólo el renglón, sin tocar su revisión
const VERDICT_REQUEST = 'Tu reporte no trae el renglón de veredicto. Sin cambiar tu revisión, cerrá con un solo renglón: '
  + '«Veredicto: limpio» o «Veredicto: hallazgos (REGLA, REGLA) · bloquea: sí|no».';

/** Se le pidió el renglón de veredicto. `o`: { stateDir, sessionKey, advisor, agentId, iter, story, run }. */
function recordVerdictRetry(o) {
  return append(o.stateDir, o.sessionKey, {
    kind: 'verdict-retry', advisor: o.advisor, agent_id: o.agentId || null, iter: o.iter ?? null, story: o.story ?? null, run: o.run ?? null,
  });
}

/**
 * ¿Ya se le pidió el renglón? Con `agentId`, a ese agente (Claude Code: el pedido es una vez por agente); sin él, al
 * revisor en esa vuelta (Codex, que no tiene agente).
 */
function yaSePidio(lines, { advisor, agentId, iter }) {
  return (lines || []).some((l) => l && l.kind === 'verdict-retry' && l.advisor === advisor
    && (agentId ? l.agent_id === agentId : (iter == null || l.iter === iter)));
}

/**
 * Los renglones de todo el registro, en orden de hora: `{ lines, unreadable, error? }`. Un renglón roto se cuenta. Cada
 * renglón lleva `sessionKey`, el archivo del que salió: sin corrida anotada, es lo que dice de qué corrida es.
 */
function readAll(stateDir) {
  const dir = registryDir(stateDir);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (e) {
    if (e && e.code === 'ENOENT') return { lines: [], unreadable: 0 };
    return { lines: [], unreadable: 0, error: `no pude leer ${dir} (${e.code || e.message})` };
  }
  const lines = [];
  let unreadable = 0;
  for (const f of files) {
    try {
      const r = readFileLines(path.join(dir, f));
      const sessionKey = f.slice(0, -'.jsonl'.length);
      for (const l of r.lines) lines.push(l && typeof l === 'object' ? { ...l, sessionKey } : l);
      unreadable += r.unreadable;
    } catch (e) { return { lines: [], unreadable, error: `no pude leer ${path.join(dir, f)} (${e.code || e.message})` }; }
  }
  lines.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return { lines, unreadable };
}

/**
 * ¿El renglón es de la corrida? Con otra historia, nunca. Sin `run` ni `sessionKeys` (quien no los pasa), cuenta como
 * antes: toda la historia. Con la corrida: un renglón que la anota cuenta si es la misma (una ayudante que comparte el
 * marcador la escribe igual); uno sin corrida (de antes, o sin marcador) cuenta sólo si su archivo es de una sesión de la
 * corrida. `archivo`: la sesión del archivo del que salió el renglón.
 */
function esDeLaCorrida(renglon, archivo, { story, run, sessionKeys }) {
  if (!renglon || String(renglon.story) !== String(story)) return false;
  if (!run && !(sessionKeys && sessionKeys.length)) return true;
  // con la carpeta, el renglón que la nombra manda; sin ella, el archivo de una sesión de la corrida
  if (renglon.run && run) return renglon.run === run;
  return (sessionKeys || []).includes(archivo);
}

/**
 * La corrida para el cruce, desde el marcador y su carpeta: `{ run, sessionKeys }`. `run` es el nombre de la carpeta (la
 * ruta cambia entre máquinas y entre repos), y las sesiones son la del marcador, la adoptada y la restaurada, con el
 * nombre de su archivo en el registro. Sin marcador, nada: el cruce sigue como antes.
 */
function corridaDelMarcador(marker, runDir) {
  if (!marker) return { run: null, sessionKeys: [] };
  const sessionKeys = [marker.sessionId, marker.adoptedFrom, marker.restoredFrom].filter(Boolean)
    .map((s) => path.basename(registryFile('.', s), '.jsonl'));
  return { run: runDir ? path.basename(runDir) : null, sessionKeys };
}

/** Los renglones de una corrida: los de la historia y la corrida, desde que arrancó la corrida si se sabe. */
function linesOfRun(lines, { story, since, run, sessionKeys }) {
  return lines.filter((l) => l && esDeLaCorrida(l, l.sessionKey, { story, run, sessionKeys }) && (!since || String(l.ts) >= String(since)));
}

/**
 * El lanzamiento al que corresponde una respuesta de `advisor`, o null. Una respuesta nueva del mismo agente (`agentId`:
 * el revisor contestó otra vez, por ejemplo con el detalle que le pidieron) va al mismo lanzamiento; la de un agente que
 * quedó atado a su salida al salir (`launch-agent`), a esa salida. Si no, la salida más vieja de ese revisor que
 * todavía no tiene reporte ni está atada a otro agente, entre las de la historia y la corrida de su última salida. Con
 * dos salidas del mismo revisor en vuelo, cada respuesta toma la suya: ninguna se descarta.
 */
function launchFor(lines, advisor, agentId) {
  const atadas = lines.filter((l) => l && l.kind === 'launch-agent' && l.advisor === advisor);
  if (agentId) {
    const previo = [...lines].reverse().find((l) => l && l.kind === 'report' && l.advisor === advisor && l.agent_id === agentId);
    if (previo) return { iter: previo.iter, story: previo.story, run: previo.run };
    const suya = [...atadas].reverse().find((l) => l.agent_id === agentId);
    if (suya) return { iter: suya.iter, story: suya.story, run: suya.run };
  }
  const launches = lines.filter((l) => l && l.kind === 'launched' && l.advisor === advisor);
  if (!launches.length) return null;
  const ultima = launches[launches.length - 1];
  const misma = (l) => String(l.story) === String(ultima.story) && (l.run || null) === (ultima.run || null);
  const conReporte = new Set(lines.filter((l) => l && l.kind === 'report' && l.advisor === advisor && misma(l)).map((r) => r.iter));
  // una salida atada a otro agente es de ése: una respuesta sin atar no se la lleva
  const deOtro = new Set(atadas.filter((l) => misma(l) && l.agent_id !== agentId).map((l) => l.iter));
  return launches.find((l) => misma(l) && !conReporte.has(l.iter) && !deOtro.has(l.iter)) || null;
}

// la severidad, la disposición y la regla como las normaliza write-findings
const sevOf = (f) => String((f && f.severity) || '').trim().toUpperCase();
const dispOf = (f) => String((f && f.disposition) || '').trim().toLowerCase();
const ruleOf = (f) => String((f && (f.rule_id || f.ruleId || f.rule)) || '').trim();
const countIn = (rep, rule) => ((rep.criticals || []).find((c) => c.rule === rule) || { count: 0 }).count;

/**
 * ¿Una constancia de `waive-critical` vale para esta regla? Con `reviewer`, la de un revisor sin reporte (`SIN-REPORTE`,
 * su `file` es el revisor). `ownerOnly`: sólo la manual (la del dueño; la de la coordinadora por delegación,
 * `tipo: 'automatica'` con `delegacion`, no). Se comprueba contra el registro del arnés (`fueraDelRegistro`): una copiada a
 * mano a la carpeta de la corrida no vale.
 */
function waiverFor({ runDir, rule, reviewer, ownerOnly, home, story }) {
  if (!runDir) return null;
  const cw = require('./critical-waivers.js');
  const { lineas } = cw.leer(runDir);
  return lineas.find((l) => l && l.rule_id === rule && (reviewer == null || String(l.file || '') === String(reviewer))
    && (!ownerOnly || l.tipo === 'manual')
    && !cw.constanciaInvalida(l) && !cw.fueraDelRegistro(l, { home, story })) || null;
}

/**
 * Cuánto comprueban los reportes posteriores de una regla crítica: `{ revisores, bajada }`. `revisores`, los que la
 * reportaron; `bajada`, lo que bajó la cuenta en un reporte legible posterior al pico, en el revisor que menos bajó.
 */
/** Los reportes legibles de un revisor, el último de cada vuelta, en orden: dos de la misma vuelta no suman dos veces. */
function porVuelta(suyos) {
  const leidos = suyos.filter((r) => r.readable).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const ultimo = new Map();
  leidos.forEach((r, i) => ultimo.set(r.iter != null ? `v${r.iter}` : `r${i}`, r));
  return [...ultimo.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/**
 * Cuántos críticos de la regla tiene que traer findings.json por lo que dijo un revisor: los que su último reporte
 * legible sigue viendo más los que confirmó resueltos (un hallazgo nuevo con el mismo código no es el mismo). Así un
 * «resueltos» nunca tapa uno abierto.
 */
function requeridosDe(reports, rule) {
  let max = 0;
  for (const a of new Set(reports.filter((r) => countIn(r, rule) > 0).map((r) => r.advisor))) {
    const ordenados = porVuelta(reports.filter((r) => r.advisor === a));
    if (!ordenados.length) continue;
    let resueltos = 0;
    ordenados.forEach((r, i) => { if (i) resueltos += Math.min(resolvedIn(r, rule), countIn(ordenados[i - 1], rule)); });
    max = Math.max(max, countIn(ordenados[ordenados.length - 1], rule) + resueltos);
  }
  return max;
}

/** Lo que sigue viendo el último reporte legible de cada revisor que reportó la regla: el mayor. */
function abiertosDe(reports, rule) {
  let max = 0;
  for (const a of new Set(reports.filter((r) => countIn(r, rule) > 0).map((r) => r.advisor))) {
    const ordenados = porVuelta(reports.filter((r) => r.advisor === a));
    if (ordenados.length) max = Math.max(max, countIn(ordenados[ordenados.length - 1], rule));
  }
  return max;
}

function resolvedIn(r, rule) {
  const c = (r && Array.isArray(r.resolved) ? r.resolved : []).find((x) => x && x.rule === rule);
  return c && Number.isInteger(c.count) && c.count > 0 ? c.count : 0;
}

function comprobadoDe(reports, rule) {
  const revisores = [...new Set(reports.filter((r) => countIn(r, rule) > 0).map((r) => r.advisor))];
  const bajadas = revisores.map((a) => {
    const suyos = reports.filter((r) => r.advisor === a);
    const pico = Math.max(...suyos.map((r) => countIn(r, rule)));
    // el último reporte con la cuenta más alta; lo que vino después y se leyó dice cuánto bajó
    const picoTs = suyos.filter((r) => countIn(r, rule) === pico).map((r) => String(r.ts)).sort().pop();
    const despues = suyos.filter((r) => r.readable && String(r.ts) > picoTs);
    const porCuenta = despues.length ? Math.max(0, pico - countIn(despues[despues.length - 1], rule)) : 0;
    // lo que confirma resuelto en un reporte legible, hasta lo que reportó en su reporte legible anterior: un hallazgo
    // nuevo con el mismo código no tapa el arreglo de uno viejo, y repetir una confirmación no suma
    // lo que confirma en las vueltas después de la cuenta más alta ya lo puede decir la bajada: se descuenta de ella
    const ordenados = porVuelta(suyos);
    let porResueltos = 0;
    let despuesDelPico = 0;
    ordenados.forEach((r, i) => {
      if (!i) return;
      const n = Math.min(resolvedIn(r, rule), countIn(ordenados[i - 1], rule));
      porResueltos += n;
      if (String(r.ts) > picoTs) despuesDelPico += n;
    });
    return porResueltos + Math.max(0, porCuenta - despuesDelPico);
  });
  return { revisores, bajada: Math.min(...bajadas), bajadas };
}

/**
 * Los revisores que tienen que volver a la vuelta siguiente: los que reportaron una regla crítica que sigue abierta y que
 * ningún reporte suyo posterior comprueba todavía (la misma cuenta del tercer control del cruce), sin la exención del
 * dueño. Sin ellos en la vuelta, el cruce pide esa exención. Los pendientes de una regla son el mayor entre lo que
 * `findings.json` trae `fixed` u `open` (un crítico arreglado queda `open` hasta que su revisor lo confirma) y el pico
 * reportado menos los destinos que se sostienen: un `refuted` con la constancia del verificador (`refutedHolds`) y un
 * `deferred`. Así el revisor vuelve también cuando el agente todavía no escribió los hallazgos. Un `waived` no resta:
 * con la exención del dueño la regla entera ya no pide nada, y sin ella no es un destino.
 * `o`: { lines, findings, runDir, home, story, eximido?, refutedHolds? }; `eximido(consulta)` dice si hay exención (sin
 * él, `waiverFor`, la misma consulta que el cruce); `refutedHolds(f)`, como en el cruce (sin él, todo `refuted` vale).
 * Devuelve `{ revisores: [{ name, rules }] }`; sin reportes, ninguno.
 */
function porConfirmar(o) {
  const eximido = typeof o.eximido === 'function' ? o.eximido : waiverFor;
  const refutedHolds = typeof o.refutedHolds === 'function' ? o.refutedHolds : () => true;
  const reports = (o.lines || []).filter((l) => l.kind === 'report');
  const findings = Array.isArray(o.findings) ? o.findings : [];
  const porRevisor = new Map();
  const reglas = new Set(reports.flatMap((r) => (r.criticals || []).map((c) => c.rule)));
  for (const rule of reglas) {
    const criticos = findings.filter((f) => ruleOf(f) === rule && sevOf(f) === 'CRITICAL');
    const arreglados = criticos.filter((f) => ['fixed', 'open'].includes(dispOf(f))).length;
    // refutado (con su constancia) o diferido ya tiene su destino: volver lo haría reportar de nuevo
    const conDestino = criticos.filter((f) => (dispOf(f) === 'refuted' && refutedHolds(f)) || dispOf(f) === 'deferred').length;
    const pico = Math.max(0, ...reports.map((r) => countIn(r, rule)));
    const pendientes = Math.max(arreglados, pico - conDestino);
    if (pendientes <= 0) continue;
    const { revisores, bajadas } = comprobadoDe(reports, rule);
    if (pendientes <= Math.min(...bajadas)) continue;
    if (eximido({ runDir: o.runDir, rule, ownerOnly: true, home: o.home, story: o.story })) continue;
    // vuelve cada revisor que todavía no bajó lo suficiente: el cruce mira al que menos bajó
    revisores.forEach((a, i) => {
      if (bajadas[i] >= pendientes) return;
      porRevisor.set(a, [...(porRevisor.get(a) || []), rule]);
    });
  }
  return { revisores: [...porRevisor].map(([name, rules]) => ({ name, rules })) };
}

/**
 * El cruce. `o`: { lines (de la corrida), findings, runDir, home, story, refutedHolds? }. `refutedHolds(f)` dice si un
 * hallazgo `refuted` tiene la constancia del verificador (la misma comprobación que write-findings); sin ella, todo
 * `refuted` se toma por válido (write-findings ya lo normalizó).
 * Devuelve { sinRegistro, problemas: [{ tipo, rule?, advisor, iter, texto }] }. `tipo`: falta · rebajado ·
 * arreglado-sin-comprobar · refutado-sin-constancia · sin-reporte.
 */
function cross(o) {
  const lines = o.lines || [];
  const findings = Array.isArray(o.findings) ? o.findings : [];
  if (!lines.length) return { sinRegistro: true, problemas: [] };
  const reports = lines.filter((l) => l.kind === 'report');
  const problemas = [];
  const quien = (advisor, iter) => `${advisor}${iter != null ? `, vuelta ${iter}` : ''}`;
  const refutedHolds = typeof o.refutedHolds === 'function' ? o.refutedHolds : () => true;

  // las reglas críticas reportadas, con el reporte de mayor cuenta (el que pide más hallazgos)
  const porRegla = new Map();
  for (const r of reports) {
    for (const c of r.criticals || []) {
      const prev = porRegla.get(c.rule);
      if (!prev || c.count > prev.count) porRegla.set(c.rule, { rule: c.rule, count: c.count, rep: r });
    }
  }
  for (const c of porRegla.values()) {
    c.count = Math.max(c.count, requeridosDe(reports, c.rule));
    const de = quien(c.rep.advisor, c.rep.iter);
    const misma = findings.filter((f) => ruleOf(f) === c.rule);
    const criticos = misma.filter((f) => sevOf(f) === 'CRITICAL');
    // 1. tantos hallazgos críticos con la regla como la mayor cuenta de un reporte, con cualquier disposición
    if (criticos.length < c.count) {
      const rebajados = misma.length - criticos.length;
      problemas.push({ tipo: rebajados ? 'rebajado' : 'falta', rule: c.rule, advisor: c.rep.advisor, iter: c.rep.iter,
        texto: rebajados
          ? `${c.rule} rebajado: lo reportó ${de} como crítico ${c.count} vez/veces, y findings.json trae ${criticos.length} como CRITICAL y ${rebajados} con otra severidad`
          : `falta ${c.rule}: lo reportó ${de} ${c.count} vez/veces y findings.json trae ${criticos.length}` });
      continue;
    }
    // 2. un «refutado» vale sólo con la constancia del verificador
    const sinConstancia = criticos.filter((f) => dispOf(f) === 'refuted' && !refutedHolds(f)).length;
    if (sinConstancia) {
      problemas.push({ tipo: 'refutado-sin-constancia', rule: c.rule, advisor: c.rep.advisor, iter: c.rep.iter,
        texto: `${c.rule}: ${sinConstancia} figura(n) como refutado(s) sin la constancia del verificador (lo reportó ${de}): un «es falso» vale sólo si otro agente corrió el código (pipeline.js verify-finding y record-refutation)` });
    }
    // 3. «arreglado»: no más que lo que bajó la cuenta en un reporte posterior y legible de cada revisor que la reportó,
    // salvo la exención del dueño. El pase adversarial no prueba nada: sus hallazgos no traen la regla.
    const arreglados = criticos.filter((f) => dispOf(f) === 'fixed').length;
    if (!arreglados) continue;
    const { bajada } = comprobadoDe(reports, c.rule);
    // y nunca más arreglados de los que deja lo que el último reporte del revisor todavía ve: ni un «resueltos» ni una
    // cuenta que bajó tapan un hallazgo abierto
    const abiertos = abiertosDe(reports, c.rule);
    if (arreglados <= bajada && criticos.length - arreglados >= abiertos) continue;
    if (waiverFor({ runDir: o.runDir, rule: c.rule, ownerOnly: true, home: o.home, story: o.story })) continue;
    problemas.push({ tipo: 'arreglado-sin-comprobar', rule: c.rule, advisor: c.rep.advisor, iter: c.rep.iter,
      texto: `${c.rule}: ${arreglados} figura(n) como arreglado(s) y una vuelta posterior del mismo revisor comprueba ${bajada} (lo reportó ${de}): `
        + 'vale con otra vuelta legible del mismo revisor que ya no lo reporte, o con la exención que firma una persona (la de la coordinadora por delegación no alcanza)' });
  }

  // 4. cada revisor que salió: un reporte legible de su última salida. Se empareja por la vuelta, no por la hora: la
  // respuesta tardía del agente de una vuelta anterior no dice nada de la nueva
  const advisors = [...new Set(lines.filter((l) => l.kind === 'launched').map((l) => l.advisor))];
  for (const a of advisors) {
    const launches = lines.filter((l) => l.kind === 'launched' && l.advisor === a);
    const last = launches[launches.length - 1];
    const after = reports.filter((r) => r.advisor === a
      && (last.iter != null ? r.iter === last.iter : String(r.ts) >= String(last.ts)));
    if (after.some((r) => r.readable)) continue;
    if (waiverFor({ runDir: o.runDir, rule: NO_REPORT_RULE, reviewer: a, ownerOnly: false, home: o.home, story: o.story })) continue;
    const motivo = after.length ? after[after.length - 1].reason : 'no hay reporte suyo en el registro';
    // el renglón de veredicto se le pide una vez: si ya se le pidió en esta salida, lo que queda es la exención
    const pedido = yaSePidio(lines, { advisor: a, iter: last.iter });
    problemas.push({ tipo: 'sin-reporte', advisor: a, iter: last.iter, pedido,
      texto: `no pude leer lo que reportó ${quien(a, last.iter)} (${motivo}): no es «no reportó nada»`
        + (pedido ? '; ya se le pidió el renglón una vez y no lo dio' : '') });
  }
  return { sinRegistro: false, problemas };
}

/** Los renglones del mensaje de un freno, con los caminos de salida. `marker`: la ruta de marker.js. */
function renglones(r, { marker }) {
  const out = r.problemas.map((p) => `   · ${p.texto}`);
  const sinReporte = r.problemas.filter((p) => p.tipo === 'sin-reporte' || p.tipo === 'registro-ilegible');
  if (sinReporte.length) {
    // a quien todavía no se le pidió el renglón, primero se le pide al mismo agente: suele ser lo único que falta
    const sinPedir = sinReporte.filter((p) => p.tipo === 'sin-reporte' && !p.pedido);
    if (sinPedir.length) {
      out.push(`   Primero, a ${sinPedir.map((p) => p.advisor).join(', ')}: continuá al mismo agente con un mensaje que pida sólo el renglón de veredicto`
        + ' («Veredicto: limpio» o «Veredicto: hallazgos (REGLA, REGLA) · bloquea: sí|no»), sin cambiar su revisión.');
    }
    out.push(`   ${sinPedir.length ? 'Si no lo da, una' : 'Una'} persona lo exime:`);
    for (const p of sinReporte) out.push(`     node ${marker} waive-critical --rule ${NO_REPORT_RULE} --file ${p.advisor} --reason '<por qué>'`);
  }
  if (r.problemas.length > sinReporte.length) {
    out.push('   Cada crítico que reportó un revisor va en findings.json como CRITICAL con su regla, tantas veces como lo reportó (pipeline.js write-findings).');
  }
  return out;
}

/** El aviso de una corrida sin registro: sigue como antes, y se dice. */
const NO_REGISTRY_NOTE = 'esta corrida no tiene registro de críticos reportados (empezó antes de que el arnés los anotara): sigue como antes, sin el cruce';

/**
 * El cruce de una corrida contra todo el registro: `o` = { stateDir, story, since, run, sessionKeys, findings, runDir,
 * home, refutedHolds }. `since` es la hora de arranque de la corrida (sin ella, todos los renglones de la historia);
 * `run`, el nombre de la carpeta de la corrida, y `sessionKeys`, sus sesiones (la del marcador, la adoptada y la
 * restaurada): con ellos, lo de otra corrida de la misma historia no entra (`esDeLaCorrida`). Un registro que no se puede
 * leer devuelve `error`: quien llama frena, porque «no lo pude leer» no es «no hay críticos».
 */
function checkRun(o) {
  const all = readAll(o.stateDir);
  if (all.error) return { error: all.error, sinRegistro: false, problemas: [] };
  const lines = linesOfRun(all.lines, { story: o.story, since: o.since, run: o.run, sessionKeys: o.sessionKeys });
  const r = { ...cross({ ...o, lines }), unreadable: all.unreadable };
  // un registro con renglones y ninguno legible de esta corrida no es una corrida de antes del control: no sé qué
  // reportaron los revisores
  if (!lines.length && all.unreadable) {
    r.sinRegistro = false;
    if (!waiverFor({ runDir: o.runDir, rule: NO_REPORT_RULE, reviewer: UNREADABLE_REGISTRY, ownerOnly: false, home: o.home, story: o.story })) {
      r.problemas.push({ tipo: 'registro-ilegible', advisor: UNREADABLE_REGISTRY, iter: null,
        texto: `el registro de críticos reportados tiene ${all.unreadable} renglón(es) ilegible(s) y ninguno legible de esta corrida: no sé qué reportaron los revisores, y eso no es «sin registro»` });
    }
  }
  // un revisor del set que salió (lo dice el registro de lanzamientos de la sesión, el que cuenta check-count) más veces
  // de las que anotó el registro de críticos: su salida se perdió, y sin esto el cierre no lo vería. Sólo desde el primer
  // renglón del registro en esta máquina: lo de antes es de cuando el control no existía
  if (all.lines.length) {
    const desde = [o.since, all.lines[0].ts].filter(Boolean).sort().pop();
    const salidas = spawnsOf(o.stateDir, { story: o.story, since: desde, run: o.run, sessionKeys: o.sessionKeys });
    if (salidas.error) return { error: salidas.error, sinRegistro: false, problemas: [] };
    if (salidas.unreadable) r.unreadableSpawns = salidas.unreadable;
    const porRevisor = new Map();
    for (const s of salidas.spawns) porRevisor.set(s.advisor, (porRevisor.get(s.advisor) || 0) + 1);
    for (const [a, n] of porRevisor) {
      const anotadas = lines.filter((l) => l.kind === 'launched' && l.advisor === a).length;
      if (n <= anotadas) continue;
      if (r.problemas.some((p) => p.tipo === 'sin-reporte' && p.advisor === a)) continue;
      if (waiverFor({ runDir: o.runDir, rule: NO_REPORT_RULE, reviewer: a, ownerOnly: false, home: o.home, story: o.story })) continue;
      r.sinRegistro = false;
      r.problemas.push({ tipo: 'sin-reporte', advisor: a, iter: null,
        texto: `no pude leer lo que reportó ${a} (salió ${n} vez/veces y el registro de críticos tiene ${anotadas} salida(s) anotada(s)): no es «no reportó nada»` });
    }
  }
  return r;
}

/** El nombre con que se exime un registro ilegible, en lugar del revisor. */
const UNREADABLE_REGISTRY = 'registro';

/**
 * Las salidas de revisores del set de su vuelta, del registro de lanzamientos (`<estado>/advisor-runs/*.jsonl`), desde
 * `since`. `{ spawns: [{ advisor, ts }], error? }`. Con `run` o `sessionKeys`, la misma regla que el cruce
 * (`esDeLaCorrida`): lo contado y lo anotado se miden igual. Sin ellos, como antes: las de la historia y las sin historia.
 */
function spawnsOf(stateDir, { story, since, run, sessionKeys }) {
  const porCorrida = !!run || !!(sessionKeys && sessionKeys.length);
  const dir = path.join(stateDir, 'advisor-runs');
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (e) {
    if (e && e.code === 'ENOENT') return { spawns: [] };
    return { spawns: [], error: `no pude leer ${dir} (${e.code || e.message})` };
  }
  const spawns = [];
  // un renglón que no se lee no se cruza: se cuenta, como `readAll` con el registro de críticos
  let unreadable = 0;
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return { spawns: [], error: `no pude leer ${path.join(dir, f)} (${e.code || e.message})` }; }
    let expected = [];
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      let d;
      try { d = JSON.parse(l); } catch { unreadable += 1; continue; }
      if (!d) continue;
      if (d.event === 'run-start') { expected = []; continue; }
      if (d.event === 'step5-start') { expected = Array.isArray(d.expected) ? d.expected : []; continue; }
      if (d.event || !d.advisor || !expected.includes(d.advisor)) continue;
      if (porCorrida ? !esDeLaCorrida(d, f.slice(0, -'.jsonl'.length), { story, run, sessionKeys }) : (d.story != null && String(d.story) !== String(story))) continue;
      if (since && String(d.ts) < String(since)) continue;
      spawns.push({ advisor: d.advisor, ts: d.ts });
    }
  }
  return { spawns, unreadable };
}

module.exports = {
  DIR, NO_REPORT_RULE, NO_REGISTRY_NOTE, VERDICT_REQUEST, registryDir, registryFile, hashOf, extractCriticals, extractResolved, unreadableReason,
  recordLaunched, recordLaunchAgent, recordReport, recordVerdictRetry, yaSePidio, readSession, readAll, linesOfRun, launchFor, cross, porConfirmar, checkRun, renglones, waiverFor,
  spawnsOf, UNREADABLE_REGISTRY, readSessionStrict, esDeLaCorrida, corridaDelMarcador,
};
