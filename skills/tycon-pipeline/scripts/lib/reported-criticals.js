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

/**
 * Los críticos del texto: `[{ rule, count }]`. La cuenta sale de los renglones de veredicto (la regla repetida una vez por
 * hallazgo; con varios renglones, el mayor); una regla entre corchetes en otro renglón asegura al menos uno.
 */
function extractCriticals(text) {
  const counts = new Map();
  const mentioned = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (RE_VERDICT_LINE.test(line)) {
      // un veredicto partido en varios renglones sigue hasta el paréntesis que lo cierra
      if (/hallazgos\s*\(/i.test(line) && !/\)/.test(line.slice(line.indexOf('(')))) {
        while (i + 1 < lines.length && !/\)/.test(line)) line += ` ${lines[++i]}`;
      }
      const here = new Map();
      RE_LOOSE.lastIndex = 0;
      let m;
      while ((m = RE_LOOSE.exec(line))) here.set(m[1], (here.get(m[1]) || 0) + 1);
      for (const [rule, n] of here) counts.set(rule, Math.max(counts.get(rule) || 0, n));
      continue;
    }
    RE_BRACKETED.lastIndex = 0;
    let m;
    while ((m = RE_BRACKETED.exec(line))) mentioned.add(m[1]);
  }
  for (const rule of mentioned) if (!counts.has(rule)) counts.set(rule, 1);
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
 * Un revisor del set salió. `o`: { stateDir, sessionKey, advisor, story, run, launcher }. La vuelta es su número de
 * salida en la corrida, contado en este mismo registro. Devuelve el renglón anotado.
 */
function recordLaunched(o) {
  const previas = readSession(o.stateDir, o.sessionKey).filter((d) => d && d.kind === 'launched' && d.advisor === o.advisor
    && String(d.story) === String(o.story ?? null) && (d.run || null) === (o.run || null)).length;
  return append(o.stateDir, o.sessionKey, {
    kind: 'launched', advisor: o.advisor, iter: previas + 1, story: o.story ?? null, run: o.run ?? null, launcher: o.launcher || null,
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
  });
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
 * el revisor contestó otra vez, por ejemplo con el detalle que le pidieron) va al mismo lanzamiento; si no, la salida más
 * vieja de ese revisor que todavía no tiene reporte, entre las de la historia y la corrida de su última salida. Con dos
 * salidas del mismo revisor en vuelo, cada respuesta toma la suya: ninguna se descarta.
 */
function launchFor(lines, advisor, agentId) {
  if (agentId) {
    const previo = [...lines].reverse().find((l) => l && l.kind === 'report' && l.advisor === advisor && l.agent_id === agentId);
    if (previo) return { iter: previo.iter, story: previo.story, run: previo.run };
  }
  const launches = lines.filter((l) => l && l.kind === 'launched' && l.advisor === advisor);
  if (!launches.length) return null;
  const ultima = launches[launches.length - 1];
  const misma = (l) => String(l.story) === String(ultima.story) && (l.run || null) === (ultima.run || null);
  const conReporte = new Set(lines.filter((l) => l && l.kind === 'report' && l.advisor === advisor && misma(l)).map((r) => r.iter));
  return launches.find((l) => misma(l) && !conReporte.has(l.iter)) || null;
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
    const revisores = [...new Set(reports.filter((r) => countIn(r, c.rule) > 0).map((r) => r.advisor))];
    const bajada = Math.min(...revisores.map((a) => {
      const suyos = reports.filter((r) => r.advisor === a);
      const pico = Math.max(...suyos.map((r) => countIn(r, c.rule)));
      // el último reporte con la cuenta más alta; lo que vino después y se leyó dice cuánto bajó
      const picoTs = suyos.filter((r) => countIn(r, c.rule) === pico).map((r) => String(r.ts)).sort().pop();
      const despues = suyos.filter((r) => r.readable && String(r.ts) > picoTs);
      if (!despues.length) return 0;
      return Math.max(0, pico - countIn(despues[despues.length - 1], c.rule));
    }));
    if (arreglados <= bajada) continue;
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
    problemas.push({ tipo: 'sin-reporte', advisor: a, iter: last.iter,
      texto: `no pude leer lo que reportó ${quien(a, last.iter)} (${motivo}): no es «no reportó nada»` });
  }
  return { sinRegistro: false, problemas };
}

/** Los renglones del mensaje de un freno, con los caminos de salida. `marker`: la ruta de marker.js. */
function renglones(r, { marker }) {
  const out = r.problemas.map((p) => `   · ${p.texto}`);
  const sinReporte = r.problemas.filter((p) => p.tipo === 'sin-reporte' || p.tipo === 'registro-ilegible');
  if (sinReporte.length) {
    out.push('   Un revisor sin reporte legible vuelve a correr (y cierra con su renglón «Veredicto:»), o una persona lo exime:');
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
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return { spawns: [], error: `no pude leer ${path.join(dir, f)} (${e.code || e.message})` }; }
    let expected = [];
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      let d;
      try { d = JSON.parse(l); } catch { continue; }
      if (!d) continue;
      if (d.event === 'run-start') { expected = []; continue; }
      if (d.event === 'step5-start') { expected = Array.isArray(d.expected) ? d.expected : []; continue; }
      if (d.event || !d.advisor || !expected.includes(d.advisor)) continue;
      if (porCorrida ? !esDeLaCorrida(d, f.slice(0, -'.jsonl'.length), { story, run, sessionKeys }) : (d.story != null && String(d.story) !== String(story))) continue;
      if (since && String(d.ts) < String(since)) continue;
      spawns.push({ advisor: d.advisor, ts: d.ts });
    }
  }
  return { spawns };
}

module.exports = {
  DIR, NO_REPORT_RULE, NO_REGISTRY_NOTE, registryDir, registryFile, hashOf, extractCriticals, unreadableReason,
  recordLaunched, recordReport, readSession, readAll, linesOfRun, launchFor, cross, checkRun, renglones, waiverFor,
  spawnsOf, UNREADABLE_REGISTRY, readSessionStrict, esDeLaCorrida, corridaDelMarcador,
};
