'use strict';
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
// lib/run-lines.js — los renglones de una corrida: uno por paso empezado («✓ Revisores — 2 vueltas de revisores…») y el
// renglón final («entró el pedido #12 — 52 min de trabajo, 14 min de espera, 2 vueltas, 1 firma del dueño»).
//
// Es la única pieza que arma ese texto: la sesión (`marker.js complete-step` y `clear`), /wip y el aviso del cierre lo
// piden acá, y para el mismo marcador o volcado dicen lo mismo, carácter por carácter.
//
// Cada motivo sale de un dato guardado (el marcador, la carpeta de la corrida, `.advisors/` del repo, `gates.log`);
// sin el dato dice «sin motivo registrado» o «no medido», nunca «ok». Armar los renglones no escribe nada: el tope de
// vueltas sale de `topeSinMaquina` (`tope()` puede anotar en gates.log) y `gates.log` se lee desde el final hacia atrás,
// sólo hasta el arranque de la corrida y sólo cuando un motivo lo necesita.
//
// CLI: node run-lines.js --story <ruta o id> [--final] [--json]

const fs = require('fs');
const os = require('os');
const path = require('path');
const STEPS_LIB = require('./steps.js');
const RR = require('./review-rounds.js');
const APPROVALS = require('./approvals.js');
const { stateDir: stateDirDe } = require('./state-dir.js');

const STEP_TIMES = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'metrics', 'step-times.js');
const MAX_MOTIVO = 120;
const SIN_MOTIVO = 'sin motivo registrado';
// lo que se lee de gates.log hacia atrás, como mucho: más que eso es una corrida de días y lo que falte queda «no medido»
const MAX_GATES_BYTES = 32 * 1024 * 1024;
const BLOQUE = 256 * 1024;
// los frenos de «Preparar el pull request» que dicen por qué no salió
const FRENOS_DEL_PEDIDO = new Set(['prepare-commit-controls', 'unreviewed-code', 'red-check', 'expected-red', 'step-order']);

/** El motivo en una frase de 120 caracteres como mucho, cortada con «…». */
function recortar(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= MAX_MOTIVO ? t : `${t.slice(0, MAX_MOTIVO - 1)}…`;
}

const aMs = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Una duración en palabras: «52 min», «1 h 12 min», «menos de 1 min». */
function duracion(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

const leerJson = (archivo) => { try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (_) { return null; } };

/**
 * Las líneas de `gates.log` desde `since` (ISO) hasta el final, leídas de atrás hacia adelante: `{ lineas, completo }`.
 * `completo: false` si se cortó por el tope de bytes o el archivo no se pudo leer (lo que falte queda «no medido»). Nunca
 * escribe.
 */
function gatesSince({ stateDir, since, maxBytes = MAX_GATES_BYTES }) {
  const archivo = path.join(stateDir, 'gates.log');
  const desde = aMs(since);
  let fd;
  try { fd = fs.openSync(archivo, 'r'); } catch (e) { return { lineas: [], completo: e.code === 'ENOENT' }; }
  try {
    const tam = fs.fstatSync(fd).size;
    let pos = tam;
    let resto = '';
    let leidos = 0;
    const lineas = [];
    for (;;) {
      if (pos <= 0) {
        if (resto.trim()) agregar(resto);
        return { lineas: lineas.reverse(), completo: true };
      }
      if (leidos >= maxBytes) return { lineas: lineas.reverse(), completo: false };
      const n = Math.min(BLOQUE, pos);
      pos -= n;
      leidos += n;
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, pos);
      const partes = (buf.toString('utf8') + resto).split('\n');
      resto = partes.shift();
      for (let i = partes.length - 1; i >= 0; i -= 1) if (partes[i].trim() && agregar(partes[i]) === 'antes') return { lineas: lineas.reverse(), completo: true };
    }
    function agregar(l) {
      let g; try { g = JSON.parse(l); } catch (_) { return null; }
      const t = aMs(g && g.ts);
      if (desde !== null && t !== null && t < desde) return 'antes';
      lineas.push(g);
      return null;
    }
  } catch (_e) {
    return { lineas: [], completo: false };
  } finally { try { fs.closeSync(fd); } catch (_) { /* nada */ } }
}

/** El contexto de una corrida: lo que leen los motivos, cargado una vez y a demanda. */
function contexto({ marker, runDir, stateDir, gatesLog, home, env }) {
  const m = marker || {};
  const dir = runDir || m.runDir || null;
  const estado = stateDir || stateDirDe(home || os.homedir());
  let gates = Array.isArray(gatesLog) ? { lineas: gatesLog, completo: true } : null;
  return {
    m, dir, estado, home: home || os.homedir(), env: env || process.env,
    gates() {
      if (!gates) gates = gatesSince({ stateDir: estado, since: m.startedAt });
      return gates;
    },
  };
}

// ── Los motivos ──────────────────────────────────────────────────────────────────────────────

function enCurso(c, id) {
  const t = c.m.stepTimings && c.m.stepTimings[id] && aMs(c.m.stepTimings[id].startedAt);
  return t === null || t === undefined ? SIN_MOTIVO : `en curso desde las ${hhmm(t)}`;
}

function hecho(c, id) {
  const st = c.m.stepTimings && c.m.stepTimings[id];
  const ini = st && aMs(st.startedAt);
  const fin = st && aMs(st.completedAt);
  return ini !== null && fin !== null && ini !== undefined && fin !== undefined && fin >= ini ? `hecho en ${duracion(fin - ini)}` : SIN_MOTIVO;
}

function aprobacionDelPlan(c) {
  if (!c.dir) return null;
  const r = APPROVALS.leer(c.dir);
  const plan = r.lineas.filter((l) => l && l.que === 'plan').pop();
  if (!plan) return null;
  if (plan.tipo === 'manual') return `aprobado por ${plan.quien}`;
  // lo que dice el registro, sin completar: una firma automática sin nombre no se atribuye a nadie
  const quien = String(plan.quien || '').trim();
  if (/^revisi[oó]n autom[aá]tica/i.test(quien)) return 'aprobado por la revisión automática';
  if (plan.delegacion) return `aprobado por ${quien || 'un agente'}, por delegación de ${plan.delegacion}`;
  if (!quien || quien === 'sin nombrar') return 'aprobado; quién, sin registrar';
  return `aprobado por ${quien}`;
}

function resultadoDePruebas(c) {
  if (!c.m.repoPath) return null;
  const r = leerJson(path.join(c.m.repoPath, '.advisors', 'tests-result.json'));
  if (!r || String(r.story_id) !== String(c.m.storyId) || !r.totals) return null;
  return r.totals;
}

function hallazgos(c) {
  const h = RR.hallazgosDe(c.dir);
  if (h.error) return { error: h.error, lista: [] };
  return { lista: RR.abiertos(h.lista, { home: c.home, env: c.env }) };
}

function extras(c) {
  const g = c.gates();
  return { n: g.lineas.filter((l) => l && l.name === 'extra-round' && String(l.story) === String(c.m.storyId)).length, completo: g.completo };
}

function tope(c) {
  try { return RR.topeSinMaquina({ repo: c.m.repoPath, env: c.env, home: c.home }).value; } catch (_) { return null; }
}

function matriz(c) {
  const dir = c.m.evidenceDir || (c.m.repoPath ? path.join(c.m.repoPath, '.advisors', 'dod-runtime') : null);
  if (!dir) return null;
  let txt;
  try { txt = fs.readFileSync(path.join(dir, `${c.m.storyId}-runtime-matrix.md`), 'utf8'); } catch (_) { return null; }
  const filas = [];
  for (const l of txt.split('\n')) {
    const f = /^\|\s*#(\d+)\s*\|\s*[^|]*?\b(RUNTIME|CODE-ONLY|SIN-EVIDENCIA|NOT-RUN|NOT-VERIFIABLE|WAIVED[\w-]*)\b/.exec(l);
    if (f) filas.push({ ac: f[1], verde: f[2] === 'RUNTIME' || f[2].startsWith('WAIVED') });
  }
  return filas.length ? filas : null;
}

function frenoDelPedido(c) {
  const sid = c.m.sessionId;
  const g = c.gates().lineas.filter((l) => l && l.status === 'blocked' && FRENOS_DEL_PEDIDO.has(l.name) && (!sid || l.sessionId === sid)).pop();
  if (!g) return null;
  return g.motivo || g.reason || g.name;
}

/** `{ mark, motive }` de un paso empezado; null si no tiene renglón. */
function renglonDe(c, s, actual) {
  const m = c.m;
  const done = STEPS_LIB.isDone(m, s.id);
  const empezado = done || !!(m.stepTimings && m.stepTimings[s.id] && m.stepTimings[s.id].startedAt);
  const checks = m.checks || {};
  const rojo = (k) => /^red\b/.test(String(checks[k] || ''));

  if (s.id === 'adversarial-pass' && !done && m.adversarialSkip) {
    const sk = m.adversarialSkip;
    return { mark: '–', motive: `salteado: ${sk.motivo || sk.reason || sk.why || SIN_MOTIVO}` };
  }
  if (!empezado && s.id !== actual) {
    // un intento que falló sin cerrar el paso también tiene renglón
    if (s.id === 'run-tests' && rojo('tests')) return { mark: '✗', motive: motivoPruebas(c, true) };
    return null;
  }

  switch (s.id) {
    case 'validate-story':
      return done ? { mark: '✓', motive: 'validada; avisos sin registrar' } : { mark: '●', motive: enCurso(c, s.id) };
    case 'approve-plan': {
      if (done) return { mark: '✓', motive: aprobacionDelPlan(c) || SIN_MOTIVO };
      return { mark: '●', motive: 'espera la firma de quien aprueba el plan' };
    }
    case 'run-tests': {
      if (rojo('tests')) return { mark: '✗', motive: motivoPruebas(c, true) };
      return done ? { mark: '✓', motive: motivoPruebas(c, false) } : { mark: '●', motive: enCurso(c, s.id) };
    }
    case 'reviewers': {
      const h = hallazgos(c);
      const bloq = h.lista.filter((a) => a.bloquea);
      const n = RR.vueltas(m);
      if (bloq.length) {
        const max = tope(c);
        const ex = extras(c);
        const total = max === null || !ex.completo ? 'no medido' : String(max + ex.n);
        return { mark: '✗', motive: `vuelta ${n} de ${total}: ${bloq[0].regla}` };
      }
      if (!done) return { mark: '●', motive: enCurso(c, s.id) };
      const max = tope(c);
      if (max === null) return { mark: '✓', motive: SIN_MOTIVO };
      return { mark: '✓', motive: RR.linea({ n, max, abiertos: h.lista, noMirado: h.error || null }) };
    }
    case 'adversarial-pass': {
      if (!done) return { mark: '●', motive: enCurso(c, s.id) };
      const pase = (m.adversarialPasses || []).filter((p) => p && Number.isInteger(p.confirmados)).pop();
      return { mark: '✓', motive: pase ? `${pase.confirmados} hallazgos confirmados` : SIN_MOTIVO };
    }
    case 'live-check': {
      const f = matriz(c);
      const faltan = f ? f.filter((x) => !x.verde) : [];
      if (rojo('acmatrix') || (done && faltan.length)) {
        return { mark: '✗', motive: f && faltan.length ? `${faltan.length} criterios sin evidencia: AC ${faltan.map((x) => x.ac).join(', ')}` : SIN_MOTIVO };
      }
      if (!done) return { mark: '●', motive: enCurso(c, s.id) };
      return { mark: '✓', motive: f ? `${f.filter((x) => x.verde).length}/${f.length} criterios en verde` : SIN_MOTIVO };
    }
    case 'prepare-commit': {
      if (done) return { mark: '✓', motive: m.pr && Number.isInteger(m.pr.number) ? `pedido #${m.pr.number} abierto` : SIN_MOTIVO };
      const freno = frenoDelPedido(c);
      return freno ? { mark: '✗', motive: freno } : { mark: '●', motive: enCurso(c, s.id) };
    }
    default:
      return done ? { mark: '✓', motive: hecho(c, s.id) } : { mark: '●', motive: enCurso(c, s.id) };
  }
}

function motivoPruebas(c, enRojo) {
  const t = resultadoDePruebas(c);
  if (!t) return SIN_MOTIVO;
  if (enRojo) {
    const primera = Array.isArray(t.failures) && t.failures.length ? String(t.failures[0].suite || t.failures[0].file || t.failures[0]) : null;
    return Number.isInteger(t.failed) && primera ? `${t.failed} rojas: ${primera}` : SIN_MOTIVO;
  }
  return Number.isInteger(t.passed) ? `${t.passed} verdes` : SIN_MOTIVO;
}

/** Un renglón por paso empezado, en el orden de `STEPS`: `[{ id, name, mark, text }]`. */
function lines(opts) {
  const c = contexto(opts || {});
  if (STEPS_LIB.schemeOf(c.m) !== STEPS_LIB.SCHEME) return [];
  const actual = (STEPS_LIB.STEPS.find((s) => !STEPS_LIB.isDone(c.m, s.id) && !(s.id === 'adversarial-pass' && c.m.adversarialSkip)) || {}).id || null;
  const out = [];
  for (const s of STEPS_LIB.STEPS) {
    let r;
    try { r = renglonDe(c, s, actual); } catch (_e) { r = { mark: STEPS_LIB.isDone(c.m, s.id) ? '✓' : '●', motive: SIN_MOTIVO }; }
    if (r) out.push({ id: s.id, name: s.name, mark: r.mark, text: `${r.mark} ${s.name} — ${recortar(r.motive)}` });
  }
  return out;
}

/** El renglón de un paso, o null. */
function stepLine(opts, id) {
  const l = lines(opts).find((x) => x.id === id);
  return l ? l.text : null;
}

/** El renglón para el Estado de /wip: el del último paso en ✗ si lo hay, si no el ●; null si no hay ninguno. */
function stateLine(opts) {
  const ls = lines(opts);
  const rojo = ls.filter((l) => l.mark === '✗').pop();
  if (rojo) return rojo.text;
  const curso = ls.find((l) => l.mark === '●');
  return curso ? curso.text : null;
}

function plural(n, uno, varios) { return `${n} ${n === 1 ? uno : varios}`; }

/** El renglón final de una corrida, de su volcado (o de un marcador en `dump.marker`). */
function final(opts) {
  const { dump } = opts || {};
  const m = (dump && dump.marker) || {};
  const c = contexto({ ...opts, marker: m });
  const partes = [];

  // qué entró
  let entro;
  if (m.pr && Number.isInteger(m.pr.number)) entro = m.pr.merged ? `entró el pedido #${m.pr.number}` : `pedido #${m.pr.number} abierto, espera la cola`;
  else if (m.cierre && m.cierre.estado && m.cierre.estado !== 'completa') entro = `no entró: ${m.cierre.motivo || m.cierre.estado}`;
  else entro = 'pedido: no medido';

  // trabajo y espera
  let t = null;
  try { t = require(STEP_TIMES).tiempos(m.stepTimings, { inicio: m.startedAt }); } catch (_) { t = null; }
  const ok = (v) => Number.isFinite(v);
  const trabajo = t && t.trabajo_medido !== false && ok(t.trabajo_ms) && Object.keys(m.stepTimings || {}).length ? t.trabajo_ms : null;
  const espera = t && ok(t.espera_humana_ms) && ok(t.entre_pasos_ms) && trabajo !== null ? t.espera_humana_ms + t.entre_pasos_ms : null;
  partes.push(trabajo === null ? 'trabajo no medido' : `${duracion(trabajo)} de trabajo`);
  partes.push(espera === null ? 'espera no medida' : `${duracion(espera)} de espera`);

  // vueltas
  const n = RR.vueltas(m);
  const ex = extras(c);
  partes.push(`${plural(n, 'vuelta', 'vueltas')}${!ex.completo ? ' (extras: no medido)' : ex.n ? ` (+${ex.n} extra)` : ''}`);

  // firmas del dueño y de la coordinadora
  const r = c.dir ? APPROVALS.leer(c.dir) : { existe: false, lineas: [] };
  if (!r.existe || r.error) partes.push('firmas del dueño no medidas');
  else {
    const duenio = r.lineas.filter((l) => l && l.tipo === 'manual').length;
    const coord = r.lineas.filter((l) => l && l.tipo !== 'manual' && l.delegacion).length;
    partes.push(`${plural(duenio, 'firma del dueño', 'firmas del dueño')}${coord ? ` y ${coord} de la coordinadora` : ''}`);
  }
  return `${entro} — ${partes.join(', ')}`;
}

/** El texto del aviso del cierre: el título, los renglones en ✗ y el renglón final. */
function noticeText({ storyId, title, lines: ls, final: fin }) {
  const rojos = (ls || []).filter((l) => l.mark === '✗').map((l) => l.text);
  return [`${storyId || '?'} · ${title || '(sin título)'}`, ...rojos, fin].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

function ultimoVolcado(estado, storyId) {
  const dir = path.join(estado, 'timing-history');
  let archivos = [];
  try { archivos = fs.readdirSync(dir).filter((f) => f.startsWith(`${String(storyId).replace(/[^\w.-]/g, '_')}-`) && f.endsWith('.json')).sort(); } catch (_) { return null; }
  const f = archivos.pop();
  return f ? path.join(dir, f) : null;
}

function main(argv) {
  const i = argv.indexOf('--story');
  const story = i >= 0 ? argv[i + 1] : null;
  if (!story) { process.stderr.write('uso: node run-lines.js --story <ruta o id> [--final] [--json]\n'); return 2; }
  const estado = stateDirDe(os.homedir());
  const id = /\.md$/.test(story) ? ((/story-([\w.]+?)-/.exec(path.basename(story)) || [])[1] || story) : story;
  let marker = null;
  try {
    for (const f of fs.readdirSync(path.join(estado, 'active'))) {
      const m = leerJson(path.join(estado, 'active', f));
      if (m && (String(m.storyId) === String(id) || (m.storyPath && path.resolve(m.storyPath) === path.resolve(story)))) { marker = m; break; }
    }
  } catch (_) { /* sin carpeta de marcadores */ }
  let dump = null;
  if (!marker) {
    const v = ultimoVolcado(estado, id);
    dump = v ? leerJson(v) : null;
    if (!dump) { process.stderr.write(`run-lines: no hay corrida viva ni volcado de la historia ${id}\n`); return 1; }
  }
  const m = marker || dump.marker;
  const ls = lines({ marker: m, stateDir: estado });
  const fin = argv.includes('--final') ? final({ dump: dump || { marker: m }, stateDir: estado }) : null;
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ lines: ls, final: fin }, null, 2)}\n`);
  else process.stdout.write(`${[...ls.map((l) => l.text), ...(fin ? [fin] : [])].join('\n')}\n`);
  return 0;
}

module.exports = { lines, stepLine, stateLine, final, noticeText, gatesSince, recortar, duracion, SIN_MOTIVO };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
