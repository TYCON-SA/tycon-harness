#!/usr/bin/env node
'use strict';
/**
 * controls-table.js — la tabla de los controles de esta máquina, armada con los registros que ya existen.
 *
 * Por cada freno y regla: cuántas veces frenó, cuántas avisó, cuántas pasó con firma (un escape autorizado) y cuántas
 * dejó pasar. Las falsas alarmas conocidas salen «no medido»: ningún registro dice todavía cuál freno se equivocó. Por
 * cada firma: cuántas se dieron y por qué vía, y cuántas fueron delegadas.
 *
 * Por cada freno y por cada modelo (el de la sesión del renglón, leído de su conversación con scripts/lib/session-model.js;
 * sin sesión o sin modelo, «sin modelo»): lo mismo, más tres marcas de cada bloqueo, que no son una prueba de nada:
 * (a) el mismo comando (la misma huella) pasó después con firma, (b) pasó después sin firma, (c) no se repitió. Al lado,
 * la clasificación propuesta del freno (scripts/metrics/controls-classification.json) y su fecha de revisión, marcada si
 * venció. Los controles del pipeline que frenaron (`gates.log`) salen con las mismas columnas, y los que no tienen
 * clasificación, en una lista aparte. Las fallas de cada freno (`hook-errors.log`): cuántas, cuántas dejaron pasar y
 * cuántas frenaron, con las marcas de scripts/hooks/hook-failures-notice.js.
 *
 * Lee `frenos.jsonl` (scripts/lib/guard-record.js), `signatures.jsonl` (scripts/lib/signature-log.js), `gates.log` y
 * `hook-errors.log` de la carpeta de estado, y las conversaciones de `~/.claude/projects`. Un registro que no está sale
 * «no medido», nunca cero: no haberlo medido no es no haber frenado. Los renglones que no se pueden leer se cuentan aparte.
 *
 * Sólo lee: no escribe en la carpeta de estado ni en el tablero. La tabla va a un archivo `.md` (`--out`) o a la salida.
 *
 * Uso: node scripts/metrics/controls-table.js [--out <archivo.md>] [--since <AAAA-MM-DD>] [--home <dir>] [--json]
 * Sale 0 si armó la tabla; 2 si no pudo escribir `--out` o un argumento no se entiende.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDirOf = (home) => require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).stateDir(home);

const VEREDICTOS = ['bloqueo', 'aviso', 'escape', 'paso'];
const NO_MEDIDO = 'no medido';
const SIN_MODELO = 'sin modelo';
// Cómo dice gates.log qué decidió un control: unos en `status`, otros en `action`. Lo que no es una de estas (no medido,
// desconocido, un estado interno) no es una decisión: no cuenta como que dejó pasar.
const FRENA_GATE = new Set(['blocked', 'bloqueo', 'block']);
const PASA_GATE = new Set(['ok', 'green', 'verde', 'cumple', 'pass', 'passed', 'paso', 'unresolved-passed', 'accepted', 'closed']);
function decisionDeGate(g) {
  const s = typeof g.status === 'string' ? g.status : '';
  const a = typeof g.action === 'string' ? g.action : '';
  if (FRENA_GATE.has(s) || FRENA_GATE.has(a)) return 'bloqueo';
  if (s.startsWith('warn') || a.startsWith('warn')) return 'aviso';
  if (PASA_GATE.has(s) || PASA_GATE.has(a)) return 'paso';
  return null;
}
const CLASIFICACION = path.join(__dirname, 'controls-classification.json');
const SELLO = /^\[(\d{4}-\d{2}-\d{2}T[^\]\s]+)\] (.*)$/s;

/** Los renglones de un registro: `{ estado: 'ok' | 'ausente' | 'ilegible', filas, malas, motivo? }`. */
function leerRegistro(file, desde) {
  let texto;
  try { texto = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { estado: 'ausente', filas: [], malas: 0 } : { estado: 'ilegible', filas: [], malas: 0, motivo: e.code || e.message };
  }
  const filas = [];
  let malas = 0;
  let sinFecha = 0;
  for (const l of texto.split('\n')) {
    if (!l.trim()) continue;
    let r;
    try { r = JSON.parse(l); } catch (_) { malas++; continue; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) { malas++; continue; }
    // con --since, un renglón sin fecha no se sabe de cuándo es: no entra, y se cuenta aparte
    if (desde && typeof r.ts !== 'string') { sinFecha++; continue; }
    if (desde && r.ts < desde) continue;
    filas.push(r);
  }
  return { estado: 'ok', filas, malas, sinFecha };
}

/** Los conteos por freno y regla, y por firma. */
function contar({ frenos, firmas }) {
  const porControl = new Map();
  for (const f of frenos.filas) {
    const clave = `${f.freno || 'sin freno'}\u0000${f.regla || 'sin regla'}`;
    if (!porControl.has(clave)) porControl.set(clave, { freno: f.freno || 'sin freno', regla: f.regla || 'sin regla', bloqueo: 0, aviso: 0, escape: 0, paso: 0, otro: 0 });
    const c = porControl.get(clave);
    if (VEREDICTOS.includes(f.veredicto)) c[f.veredicto]++; else c.otro++;
  }
  const porFirma = new Map();
  for (const s of firmas.filas) {
    const id = s.signature || 'sin id';
    if (!porFirma.has(id)) porFirma.set(id, { firma: id, total: 0, delegadas: 0, vias: {} });
    const c = porFirma.get(id);
    c.total++;
    if (s.delegated === true) c.delegadas++;
    const via = s.via || 'sin vía';
    c.vias[via] = (c.vias[via] || 0) + 1;
  }
  const orden = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    controles: [...porControl.values()].sort((a, b) => orden(a.freno, b.freno) || orden(a.regla, b.regla)),
    firmas: [...porFirma.values()].sort((a, b) => orden(a.firma, b.firma)),
  };
}

/** La clasificación propuesta: `{ estado, entradas }`; sin archivo o ilegible, `entradas` vacío y el motivo. */
function leerClasificacion(file = CLASIFICACION) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { estado: 'ok', entradas: Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('__'))) };
  } catch (e) { return { estado: 'ilegible', entradas: {}, motivo: e.code || e.message }; }
}

/** `sesión → modelo` de las sesiones que nombran los renglones; la que no se pudo leer, «sin modelo». */
function modelosDe(sesiones, { home, modelOf } = {}) {
  const out = new Map();
  if (!sesiones.size) return out;
  let leer = modelOf;
  if (!leer) {
    const sm = require(path.join(__dirname, '..', 'lib', 'session-model.js'));
    const index = sm.transcriptIndex({ home });
    leer = (sid) => sm.modelOf(sid, { home, index });
  }
  for (const sid of sesiones) out.set(sid, leer(sid).model || SIN_MODELO);
  return out;
}

const filaVacia = () => ({ decidio: 0, bloqueo: 0, aviso: 0, escape: 0, paso: 0, a: 0, b: 0, c: 0, sinHuella: 0, sinDecision: 0 });

/**
 * Por freno y por modelo: los veredictos y las marcas de cada bloqueo. Un bloqueo cuyo mismo comando (misma huella, mismo
 * freno) aparece DESPUÉS como `escape` es (a); si sólo aparece como `paso`, (b); si no aparece, (c). Sin huella no se marca.
 */
function contarPorModelo(filas, modelos) {
  const out = new Map();
  const fila = (freno, modelo) => {
    if (!out.has(freno)) out.set(freno, new Map());
    const m = out.get(freno);
    if (!m.has(modelo)) m.set(modelo, filaVacia());
    return m.get(modelo);
  };
  const ordenadas = filas.map((f, i) => ({ f, i })).sort((x, y) => (String(x.f.ts) < String(y.f.ts) ? -1 : String(x.f.ts) > String(y.f.ts) ? 1 : x.i - y.i));
  // lo que pasó después de cada momento: por freno y huella, el último escape y el último paso
  const ultimo = new Map();
  ordenadas.forEach(({ f }, pos) => {
    if (!f.sha256 || (f.veredicto !== 'escape' && f.veredicto !== 'paso')) return;
    const k = `${f.freno}\u0000${f.sha256}`;
    const u = ultimo.get(k) || { escape: -1, paso: -1 };
    u[f.veredicto] = pos;
    ultimo.set(k, u);
  });
  ordenadas.forEach(({ f }, pos) => {
    const c = fila(f.freno || 'sin freno', (f.sesion && modelos.get(f.sesion)) || SIN_MODELO);
    c.decidio++;
    if (VEREDICTOS.includes(f.veredicto)) c[f.veredicto]++;
    if (f.veredicto !== 'bloqueo') return;
    if (!f.sha256) { c.sinHuella++; return; }
    const u = ultimo.get(`${f.freno}\u0000${f.sha256}`);
    if (u && u.escape > pos) c.a++;
    else if (u && u.paso > pos) c.b++;
    else c.c++;
  });
  return out;
}

/**
 * Los controles del pipeline que frenaron en el período, por nombre y por modelo (`decisionDeGate`). Un renglón que no es
 * una decisión va a `sinDecision`, aparte de lo que dejó pasar.
 */
function contarGates(gates, modelos) {
  const frenaron = new Set(gates.filas.filter((g) => decisionDeGate(g) === 'bloqueo').map((g) => g.name || 'sin nombre'));
  const out = new Map();
  for (const g of gates.filas) {
    const nombre = g.name || 'sin nombre';
    if (!frenaron.has(nombre)) continue;
    if (!out.has(nombre)) out.set(nombre, new Map());
    const m = out.get(nombre);
    const modelo = (g.sessionId && modelos.get(g.sessionId)) || SIN_MODELO;
    if (!m.has(modelo)) m.set(modelo, filaVacia());
    const c = m.get(modelo);
    const d = decisionDeGate(g);
    if (!d) { c.sinDecision++; continue; }
    c.decidio++;
    c[d]++;
  }
  return out;
}

/**
 * Las fallas de cada freno en `hook-errors.log`: `{ estado, porFreno: Map(freno → { total, abiertas, cerradas, primera,
 * ultima, recientes, ultimaAbierta, abiertasRecientes }) }`. `primera` y `ultima` son las fechas de la primera y la última
 * falla; `recientes`, las de los 7 días antes de `ahora`; `ultimaAbierta` y `abiertasRecientes`, lo mismo para las que
 * dejaron pasar. Un agujero ya cerrado tiene su última falla que dejó pasar vieja y ninguna reciente.
 */
function contarFallas(file, desde, ahora = new Date().toISOString()) {
  const semana = new Date(Date.parse(ahora) - 7 * 24 * 3600 * 1000).toISOString();
  let texto;
  try { texto = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { estado: 'ausente', porFreno: new Map() } : { estado: 'ilegible', porFreno: new Map(), motivo: e.code || e.message };
  }
  const { clasificar } = require(path.join(__dirname, '..', 'hooks', 'hook-failures-notice.js'));
  const porFreno = new Map();
  let renglones = 0;
  for (const r of texto.split(/\r?\n/)) {
    const m = SELLO.exec(r);
    if (!m || (desde && m[1] < desde)) continue;
    renglones++;
    const falla = clasificar(m[2]);
    const freno = falla ? falla.control : (m[2].split(/\s/)[0] || 'sin nombre').replace(/:$/, '').replace(/\.js$/, '');
    const c = porFreno.get(freno) || { total: 0, abiertas: 0, cerradas: 0, primera: m[1], ultima: m[1], recientes: 0, ultimaAbierta: null, abiertasRecientes: 0 };
    c.total++;
    if (m[1] < c.primera) c.primera = m[1];
    if (m[1] > c.ultima) c.ultima = m[1];
    if (m[1] >= semana && m[1] <= ahora) c.recientes++;
    if (falla && falla.frena) c.cerradas++;
    else if (falla) {
      c.abiertas++;
      if (!c.ultimaAbierta || m[1] > c.ultimaAbierta) c.ultimaAbierta = m[1];
      if (m[1] >= semana && m[1] <= ahora) c.abiertasRecientes++;
    }
    porFreno.set(freno, c);
  }
  return { estado: 'ok', porFreno, renglones };
}

function estadoDe(r, nombre) {
  if (r.estado === 'ausente') return `${NO_MEDIDO} (no hay ${nombre})`;
  if (r.estado === 'ilegible') return `${NO_MEDIDO} (no se pudo leer ${nombre}: ${r.motivo})`;
  return `${r.filas.length} renglón(es)${r.malas ? `, ${r.malas} ilegible(s)` : ''}${r.sinFecha ? `, ${r.sinFecha} sin fecha (fuera del período)` : ''}`;
}

/** La tabla en markdown. */
/** La fecha de revisión de un control, marcada si venció; sin entrada, «sin clasificar». */
function revision(entrada, hoy) {
  if (!entrada) return { tipo: 'sin clasificar', fecha: '—' };
  const vencida = typeof entrada.review_before === 'string' && entrada.review_before < hoy;
  return { tipo: `${entrada.tipo} (${entrada.estado})`, fecha: `${entrada.review_before}${vencida ? ' — revisión vencida' : ''}` };
}

function tablaPorModelo(l, porNombre, clasif, hoy, marcas) {
  const resto = marcas ? ' | (a) pasó con firma después | (b) pasó sin firma después | (c) no se repitió | sin huella' : ' | Sin decisión (no medido, desconocido)';
  l.push(`| Control | Clasificación | Revisar antes de | Modelo | Tuvo que decidir | Frenó | Avisó | Pasó con firma | Dejó pasar${resto} |`);
  l.push(`|---|---|---|---|---:|---:|---:|---:|---:${marcas ? '|---:|---:|---:|---:' : '|---:'}|`);
  for (const nombre of [...porNombre.keys()].sort()) {
    const r = revision(clasif.entradas[nombre], hoy);
    for (const [modelo, c] of [...porNombre.get(nombre).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      l.push(`| ${nombre} | ${r.tipo} | ${r.fecha} | ${modelo} | ${c.decidio} | ${c.bloqueo} | ${c.aviso} | ${c.escape} | ${c.paso}${marcas ? ` | ${c.a} | ${c.b} | ${c.c} | ${c.sinHuella}` : ` | ${c.sinDecision}`} |`);
    }
  }
}

function markdown({ frenos, firmas, conteo, desde, ahora, extra }) {
  const l = ['# Tabla de controles', '', `Armada el ${ahora} con los registros de esta máquina${desde ? `, desde el ${desde}` : ''}. Sólo lee.`, '',
    `- Frenos (frenos.jsonl): ${estadoDe(frenos, 'frenos.jsonl')}`, `- Firmas (signatures.jsonl): ${estadoDe(firmas, 'signatures.jsonl')}`, '',
    '## Frenos', ''];
  if (frenos.estado !== 'ok') l.push(`${NO_MEDIDO}: ${estadoDe(frenos, 'frenos.jsonl')}.`);
  else if (!conteo.controles.length) l.push('Ningún freno anotó una decisión en el período.');
  else {
    l.push('| Freno | Regla | Frenó | Avisó | Pasó con firma | Dejó pasar | Falsas alarmas conocidas |', '|---|---|---:|---:|---:|---:|---|');
    for (const c of conteo.controles) l.push(`| ${c.freno} | ${c.regla} | ${c.bloqueo} | ${c.aviso} | ${c.escape} | ${c.paso} | ${NO_MEDIDO} |`);
    const otros = conteo.controles.reduce((n, c) => n + c.otro, 0);
    if (otros) l.push('', `${otros} renglón(es) con un veredicto que no es ninguno de ${VEREDICTOS.join(', ')}.`);
  }
  l.push('', '## Firmas', '');
  if (firmas.estado !== 'ok') l.push(`${NO_MEDIDO}: ${estadoDe(firmas, 'signatures.jsonl')}.`);
  else if (!conteo.firmas.length) l.push('No se dio ninguna firma en el período.');
  else {
    l.push('| Firma | Total | Delegadas | Por vía |', '|---|---:|---:|---|');
    for (const f of conteo.firmas) l.push(`| ${f.firma} | ${f.total} | ${f.delegadas} | ${Object.entries(f.vias).sort().map(([v, n]) => `${v}: ${n}`).join(', ')} |`);
  }
  if (extra) markdownExtra(l, { frenos, desde, ahora, ...extra });
  return `${l.join('\n')}\n`;
}

function markdownExtra(l, { frenos, gates, fallas, clasif, porModelo, porGate, ahora }) {
  const hoy = String(ahora).slice(0, 10);
  l.push('', '## Por freno y por modelo', '',
    'Las marcas de cada bloqueo no son una prueba: (a) el mismo comando pasó después con firma (puede ser el camino previsto, como una firma que llega), (b) pasó después sin firma (el freno cambió de opinión o lo esquivaron), (c) no se repitió (el agente cambió de camino: candidato a atajo, no prueba). Ningún registro dice todavía si un bloqueo atajó algo de verdad.', '');
  if (clasif.estado !== 'ok') l.push(`Clasificación: ${NO_MEDIDO} (no se pudo leer controls-classification.json: ${clasif.motivo}).`, '');
  if (frenos.estado !== 'ok') l.push(`${NO_MEDIDO}: ${estadoDe(frenos, 'frenos.jsonl')}.`);
  else if (!porModelo.size) l.push('Ningún freno anotó una decisión en el período.');
  else tablaPorModelo(l, porModelo, clasif, hoy, true);
  l.push('', '## Controles del pipeline que frenaron', '', `- gates.log: ${estadoDe(gates, 'gates.log')}`, '');
  if (gates.estado === 'ok' && porGate.size) {
    tablaPorModelo(l, porGate, clasif, hoy, false);
    const sin = [...porGate.keys()].filter((n) => !clasif.entradas[n]).sort();
    l.push('', '### Sin clasificar', '', sin.length ? sin.map((n) => `- ${n}`).join('\n') : 'Ninguno.');
  } else if (gates.estado === 'ok') l.push('Ningún control del pipeline frenó en el período.');
  l.push('', '## Fallas de los frenos mismos', '');
  if (fallas.estado === 'ausente') l.push(`${NO_MEDIDO} (no hay hook-errors.log).`);
  else if (fallas.estado === 'ilegible') l.push(`${NO_MEDIDO} (no se pudo leer hook-errors.log: ${fallas.motivo}).`);
  else if (!fallas.porFreno.size) l.push('Ningún freno falló en el período.');
  else {
    l.push('Una falla vieja sin ninguna en los últimos 7 días es, casi siempre, un agujero que ya se cerró: la fecha de la última lo dice.', '',
      '| Freno | Fallas | Dejaron pasar | Frenaron por la falla | Sin marca | Primera | Última | Últimos 7 días | Última que dejó pasar | Dejaron pasar, últimos 7 días |', '|---|---:|---:|---:|---:|---|---|---:|---|---:|');
    for (const [f, c] of [...fallas.porFreno.entries()].sort((x, y) => y[1].total - x[1].total)) {
      l.push(`| ${f} | ${c.total} | ${c.abiertas} | ${c.cerradas} | ${c.total - c.abiertas - c.cerradas} | ${c.primera.slice(0, 10)} | ${c.ultima.slice(0, 10)} | ${c.recientes} | ${c.ultimaAbierta ? c.ultimaAbierta.slice(0, 10) : '—'} | ${c.abiertasRecientes} |`);
    }
  }
  const vencidas = Object.entries(clasif.entradas).filter(([, e]) => typeof e.review_before === 'string' && e.review_before < hoy).map(([k]) => k).sort();
  l.push('', '## Revisión vencida', '', vencidas.length ? vencidas.map((k) => `- ${k}`).join('\n') : 'Ninguna.');
}

function tabla({ home = os.homedir(), desde = null, ahora = new Date().toISOString(), modelOf, clasificacion = CLASIFICACION } = {}) {
  const dir = stateDirOf(home);
  const frenos = leerRegistro(path.join(dir, 'frenos.jsonl'), desde);
  const firmas = leerRegistro(path.join(dir, 'signatures.jsonl'), desde);
  const gates = leerRegistro(path.join(dir, 'gates.log'), desde);
  const fallas = contarFallas(path.join(dir, 'hook-errors.log'), desde, ahora);
  const clasif = leerClasificacion(clasificacion);
  const conteo = contar({ frenos, firmas });
  const sesiones = new Set([...frenos.filas.map((f) => f.sesion), ...gates.filas.filter((g) => g.name).map((g) => g.sessionId)].filter((s) => typeof s === 'string' && s));
  const modelos = modelosDe(sesiones, { home, modelOf });
  const porModelo = contarPorModelo(frenos.filas, modelos);
  const porGate = contarGates(gates, modelos);
  const extra = { gates, fallas, clasif, porModelo, porGate };
  return { frenos, firmas, conteo, gates, fallas, clasif, porModelo, porGate, md: markdown({ frenos, firmas, conteo, desde, ahora, extra }) };
}

module.exports = { leerRegistro, contar, markdown, tabla, contarPorModelo, contarGates, decisionDeGate, contarFallas, leerClasificacion, SIN_MODELO };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const valor = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const no = (m) => { process.stderr.write(`controls-table: ${m}\n`); process.exit(2); };
  for (const f of ['--out', '--since', '--home']) if (argv.includes(f) && !valor(f)) no(`${f} va con un valor`);
  const desde = valor('--since') || null;
  if (desde && !/^\d{4}-\d\d-\d\d/.test(desde)) no('--since va con una fecha AAAA-MM-DD');
  const t = tabla({ home: valor('--home') || os.homedir(), desde });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ frenos: { estado: t.frenos.estado, malas: t.frenos.malas }, firmas: { estado: t.firmas.estado, malas: t.firmas.malas }, ...t.conteo }, null, 2)}\n`);
  }
  const out = valor('--out');
  if (out) {
    try { fs.writeFileSync(out, t.md); } catch (e) { no(`no pude escribir ${out} (${e.code || e.message})`); }
    process.stderr.write(`controls-table: la tabla quedó en ${out}\n`);
  } else if (!argv.includes('--json')) process.stdout.write(t.md);
}
