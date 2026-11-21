'use strict';
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
// lib/run-lines.js — los renglones de una corrida: uno por paso empezado («✓ Revisores — 2 vueltas de revisores…») y el
// renglón final («entró el pedido #12 — 52 min de trabajo, 14 min de espera, 2 vueltas, 1 firma de una persona»).
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
const SECRET_SHAPES = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'provider-secret-shapes.js');
const SANEADOR = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'metrics', 'tokens-digest.js');
const MAX_MOTIVO = 120;
const SIN_MOTIVO = 'sin motivo registrado';
// lo que se lee de gates.log hacia atrás, como mucho: más que eso es una corrida de días y lo que falte queda «no medido»
const MAX_GATES_BYTES = 32 * 1024 * 1024;
const BLOQUE = 256 * 1024;
// los frenos de «Preparar el pull request»: los que se anotan con su paso (el nombre del paso, o su número viejo) y los
// que se anotan sin él
const PASO_DEL_PEDIDO = new Set(['prepare-commit', '8']);
const FRENOS_SIN_PASO = new Set(['prepare-commit-controls', 'red-check', 'expected-red']);
// quién firma en findings.json lo que encontró el pase adversarial, y qué hallazgo sigue sin cerrar
const FIRMA_DEL_PASE = /^(adversarial-verify|pase adversarial)/i;
const SIN_CERRAR = new Set(['open', 'deferred']);

/**
 * El texto saneado: sin secretos, rutas ni ids de sesión. Un motivo es texto libre y sale a la terminal y a un canal
 * externo. Sin saneador legible no se publica.
 */
function tapar(s) {
  try {
    const sinClaves = require(SECRET_SHAPES).redactShapes(require('./smoke-secrets.js').redact(s).text);
    return require(SANEADOR).sanear(sinClaves);
  } catch (_) { return SIN_MOTIVO; }
}

/** El motivo en una frase de 120 caracteres como mucho, sin secretos y cortada con «…». */
function recortar(s) {
  const t = tapar(s).replace(/\s+/g, ' ').trim();
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
 * Las líneas de `gates.log` desde `since` (ISO) hasta `until` (ISO, opcional), leídas de atrás hacia adelante:
 * `{ lineas, completo }`. El registro no está del todo en orden: una línea con hora vieja no corta la lectura, que sigue
 * hasta pasar un bloque entero sin nada de la corrida. `completo: false` si se cortó por el tope de bytes o el archivo no
 * se pudo leer (lo que falte queda «no medido»). Nunca escribe.
 */
function gatesSince({ stateDir, since, until = null, maxBytes = MAX_GATES_BYTES }) {
  const archivo = path.join(stateDir, 'gates.log');
  const desde = aMs(since);
  const hasta = aMs(until);
  let fd;
  try { fd = fs.openSync(archivo, 'r'); } catch (e) { return { lineas: [], completo: e.code === 'ENOENT' }; }
  try {
    let pos = fs.fstatSync(fd).size;
    let resto = Buffer.alloc(0);
    let leidos = 0;
    let vioAnteriores = false;
    let sinLaCorrida = 0;
    const lineas = [];
    const agregar = (crudo) => {
      const l = crudo.toString('utf8');
      if (!l.trim()) return;
      let g; try { g = JSON.parse(l); } catch (_) { return; }
      const t = aMs(g && g.ts);
      if (desde !== null && t !== null && t < desde) { vioAnteriores = true; return; }
      sinLaCorrida = 0;
      if (hasta === null || t === null || t <= hasta) lineas.push(g);
    };
    for (;;) {
      if (pos <= 0) {
        agregar(resto);
        return { lineas: lineas.reverse(), completo: true };
      }
      if (vioAnteriores && sinLaCorrida >= BLOQUE) return { lineas: lineas.reverse(), completo: true };
      if (leidos >= maxBytes) return { lineas: lineas.reverse(), completo: false };
      const n = Math.min(BLOQUE, pos);
      pos -= n;
      leidos += n;
      sinLaCorrida += n;
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, pos);
      // se parte por bytes: un carácter de varios bytes puede caer justo en el borde del bloque
      const junto = Buffer.concat([buf, resto]);
      let fin = junto.length;
      for (let i = junto.length - 1; i >= 0; i -= 1) {
        if (junto[i] === 0x0a) { agregar(junto.subarray(i + 1, fin)); fin = i; }
      }
      resto = junto.subarray(0, fin);
    }
  } catch (_e) {
    return { lineas: [], completo: false };
  } finally { try { fs.closeSync(fd); } catch (_) { /* nada */ } }
}

/** La historia de la corrida como ruta absoluta, o null. */
function rutaDeLaHistoria(m) {
  if (!m.storyPath) return null;
  return path.isAbsolute(m.storyPath) || !m.repoPath ? m.storyPath : path.join(m.repoPath, m.storyPath);
}

/** La carpeta de la corrida: la del marcador o, sin ella, la que encuentra el resto del arnés. */
function carpetaDe(m) {
  if (m.runDir) return m.runDir;
  if (!m.repoPath || !m.storyId) return null;
  try { return require('./run-dir.js').resolveRunDir(m.repoPath, m.storyId, false, rutaDeLaHistoria(m), { marker: m }); } catch (_) { return null; }
}

/** El contexto de una corrida: lo que leen los motivos, cargado una vez y a demanda. */
function contexto({ marker, runDir, stateDir, gatesLog, home, env, until }) {
  const m = marker || {};
  const dir = runDir || carpetaDe(m);
  const estado = stateDir || stateDirDe(home || os.homedir());
  let gates = Array.isArray(gatesLog) ? { lineas: gatesLog, completo: true } : null;
  return {
    m, dir, estado, home: home || os.homedir(), env: env || process.env,
    gates() {
      if (!gates) gates = gatesSince({ stateDir: estado, since: m.startedAt, until });
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
  if (h.error) return { error: h.error, lista: [], existe: true };
  return { lista: RR.abiertos(h.lista, { home: c.home, env: c.env }), existe: h.existe };
}

function extras(c) {
  const g = c.gates();
  return { n: g.lineas.filter((l) => l && l.name === 'extra-round' && String(l.story) === String(c.m.storyId) && Number.isInteger(l.iter)).length, completo: g.completo };
}

function tope(c) {
  try { return RR.topeSinMaquina({ repo: c.m.repoPath, env: c.env, home: c.home }).value; } catch (_) { return null; }
}

function matriz(c) {
  const dir = c.m.evidenceDir || (c.m.repoPath ? path.join(c.m.repoPath, '.advisors', 'dod-runtime') : null);
  if (!dir) return null;
  // el nombre lleva la clave de la evidencia: con un número repetido en el repo no es el número solo
  let prefijo;
  try { prefijo = require('./evidence-key.js').evidencePrefix(rutaDeLaHistoria(c.m), c.m.storyId).prefix; } catch (_) { return null; }
  if (!prefijo) return null;
  let txt;
  try { txt = fs.readFileSync(path.join(dir, `${prefijo}runtime-matrix.md`), 'utf8'); } catch (_) { return null; }
  const filas = [];
  for (const l of txt.split('\n')) {
    const f = /^\|\s*#(\d+)\s*\|\s*[^|]*?\b(RUNTIME-PARCIAL|RUNTIME|CODE-ONLY|SIN-EVIDENCIA|NOT-RUN|NOT-VERIFIABLE|WAIVED[\w-]*)\b/.exec(l);
    if (f) filas.push({ ac: f[1], verde: f[2] === 'RUNTIME' || f[2].startsWith('WAIVED') });
  }
  return filas.length ? filas : null;
}

/** El último freno de este cierre de «Preparar el pull request»: de esta historia y este repo, desde que arrancó el paso. */
function frenoDelPedido(c) {
  const m = c.m;
  const st = m.stepTimings && m.stepTimings['prepare-commit'];
  const desde = st ? aMs(st.startedAt) : null;
  const g = c.gates().lineas.filter((l) => {
    if (!l || l.status !== 'blocked') return false;
    if (l.story !== undefined && l.story !== null && String(l.story) !== String(m.storyId)) return false;
    if (l.repoPath && m.repoPath && l.repoPath !== m.repoPath) return false;
    if (!(l.step !== undefined ? PASO_DEL_PEDIDO.has(String(l.step)) : FRENOS_SIN_PASO.has(l.name))) return false;
    const t = aMs(l.ts);
    return desde === null || t === null || t >= desde;
  }).pop();
  if (!g) return null;
  return g.motivo || g.reason || g.error || g.name;
}

/** Los pases del pipeline de esta corrida; una revisión a mano (`--type revision`) no es el pase. */
const pasesDelPipeline = (m) => (m.adversarialPasses || []).filter((p) => p && (!p.tipo || p.tipo === '5b'));

/** ¿Hay otra vuelta de revisores pendiente? `{ round, archivos }`, null, o `{ noMedida: true }` si no se pudo saber. */
function otraVuelta(m) {
  try { return STEPS_LIB.reviewersRound(m); } catch (_) { return { noMedida: true }; }
}

/**
 * El paso en el que está la corrida: el primero sin hacer, o los revisores si un arreglo pide otra vuelta. Si no se pudo
 * saber si falta otra vuelta, es el primero sin hacer: el renglón de los revisores ya dice que no se midió.
 */
function pasoActual(m) {
  const vuelta = otraVuelta(m);
  if (vuelta && !vuelta.noMedida) return 'reviewers';
  return (STEPS_LIB.STEPS.find((s) => !STEPS_LIB.isDone(m, s.id) && !(s.id === 'adversarial-pass' && m.adversarialSkip)) || {}).id || null;
}

/** ¿La última validación de esta versión de la historia salió con críticos? */
function validacionEnRojo(c) {
  const sp = rutaDeLaHistoria(c.m);
  if (!sp) return false;
  try {
    const r = require('./validation-record.js').readRecord(c.home, sp);
    return r.estado === 'current' && r.record.resultado === 'rojo';
  } catch (_) { return false; }
}

/** El resumen del primer hallazgo confirmado por el pase que `findings.json` no da por cerrado, o null. */
function hallazgoDelPaseSinCerrar(c) {
  if (!c.dir) return null;
  const r = leerJson(path.join(c.dir, 'step-05b-adversarial.json'));
  const confirmados = r && Array.isArray(r.confirmed) ? r.confirmed : [];
  const delPase = RR.hallazgosDe(c.dir).lista.filter((f) => f && FIRMA_DEL_PASE.test(String(f.advisor || '')));
  const norma = (p) => String(p || '').split(path.sep).join('/').replace(/^\.\//, '');
  const mismoArchivo = (a, b) => { const x = norma(a); const y = norma(b); return !!x && !!y && (x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)); };
  const sinCerrar = (f) => SIN_CERRAR.has(String(f.disposition || 'open').trim().toLowerCase());
  const h = confirmados.find((x) => {
    const suyos = delPase.filter((f) => mismoArchivo(f.file, x && x.file));
    return !suyos.length || suyos.some(sinCerrar);
  });
  return h ? h.summary || SIN_MOTIVO : null;
}

/** `{ mark, motive }` de un paso empezado; null si no tiene renglón. */
function renglonDe(c, s, actual) {
  const m = c.m;
  const done = STEPS_LIB.isDone(m, s.id);
  const empezado = done || !!(m.stepTimings && m.stepTimings[s.id] && m.stepTimings[s.id].startedAt);
  const checks = m.checks || {};
  const rojo = (k) => /^(red\b|rojo-esperado)/.test(String(checks[k] || ''));

  if (s.id === 'adversarial-pass' && m.adversarialSkip && !pasesDelPipeline(m).length) {
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
      if (done) return { mark: '✓', motive: 'validada; avisos sin registrar' };
      return { mark: validacionEnRojo(c) ? '✗' : '●', motive: SIN_MOTIVO };
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
      const pendiente = otraVuelta(m);
      if (pendiente && pendiente.noMedida) return { mark: '●', motive: 'si falta otra vuelta: no medido' };
      if (pendiente) return { mark: '●', motive: `falta la vuelta ${pendiente.round}: ${pendiente.archivos.length === 1 ? '1 archivo cambió' : `${pendiente.archivos.length} archivos cambiaron`} después de los revisores` };
      if (!done) return { mark: '●', motive: enCurso(c, s.id) };
      const max = tope(c);
      if (max === null) return { mark: '✓', motive: SIN_MOTIVO };
      // findings.json lo escribe «Hallazgos», después: sin él nadie miró lo abierto, y no se dice «nada»
      const noMirado = h.error || (h.existe ? null : 'todavía no hay hallazgos anotados');
      return { mark: '✓', motive: RR.linea({ n, max, abiertos: h.lista, noMirado }) };
    }
    case 'adversarial-pass': {
      const pase = pasesDelPipeline(m).filter((p) => Number.isInteger(p.confirmados)).pop();
      const abierto = hallazgoDelPaseSinCerrar(c);
      if (!done) {
        if (pase && pase.veredicto === 'no-medido') return { mark: '●', motive: `no medido: ${pase.motivo_no_medido || SIN_MOTIVO}` };
        return { mark: '●', motive: abierto || enCurso(c, s.id) };
      }
      if (abierto) return { mark: '✗', motive: abierto };
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
  const actual = pasoActual(c.m);
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

/** El renglón para el Estado de /wip: el del último paso cerrado si salió ✗; si no, el del paso actual; null si no hay. */
function stateLine(opts) {
  const m = (opts && opts.marker) || {};
  const ls = lines(opts);
  const cerrado = ls.filter((l) => STEPS_LIB.isDone(m, l.id)).pop();
  if (cerrado && cerrado.mark === '✗') return cerrado.text;
  const actual = pasoActual(m);
  const enCursoAhora = ls.find((l) => l.id === actual);
  if (enCursoAhora) return enCursoAhora.text;
  const rojo = ls.filter((l) => l.mark === '✗').pop();
  return rojo ? rojo.text : null;
}

function plural(n, uno, varios) { return `${n} ${n === 1 ? uno : varios}`; }

/** El renglón final de una corrida, de su volcado (o de un marcador en `dump.marker`). */
function final(opts) {
  const { dump } = opts || {};
  const m = (dump && dump.marker) || {};
  // lo de `gates.log` hasta el cierre: una corrida posterior de la misma historia no cambia este renglón
  const c = contexto({ ...opts, marker: m, until: dump && dump.archivedAt });
  const partes = [];

  // qué entró
  let entro;
  if (m.pr && Number.isInteger(m.pr.number)) entro = m.pr.merged ? `entró el pedido #${m.pr.number}` : `pedido #${m.pr.number} abierto, compilación sin ver: no está listo todavía`;
  else if (m.cierre && m.cierre.estado && m.cierre.estado !== 'completa') entro = `no entró: ${recortar(m.cierre.motivo || m.cierre.estado)}`;
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

  // firmas de una persona y de la coordinadora
  const r = c.dir ? APPROVALS.leer(c.dir) : { existe: false, lineas: [] };
  // una línea ilegible puede ser justo otra firma: el número no se puede dar
  if (!r.existe || r.error || r.ilegibles) partes.push('firmas de una persona no medidas');
  else {
    const persona = r.lineas.filter((l) => l && l.tipo === 'manual').length;
    const coord = r.lineas.filter((l) => l && l.tipo !== 'manual' && l.delegacion).length;
    partes.push(`${plural(persona, 'firma de una persona', 'firmas de una persona')}${coord ? ` y ${coord} de la coordinadora` : ''}`);
  }
  return `${entro} — ${partes.join(', ')}`;
}

/** El texto del aviso del cierre: el título, los renglones en ✗ y el renglón final. */
function noticeText({ storyId, title, lines: ls, final: fin }) {
  const rojos = (ls || []).filter((l) => l.mark === '✗').map((l) => l.text);
  return [`${storyId || '?'} · ${title ? tapar(title) : '(sin título)'}`, ...rojos, fin].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

const canonica = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };

function repoDe(dir) {
  try { return dir ? require('./repo-attrib.js').realRepo(dir) : null; } catch (_) { return null; }
}
const mismoRepo = (a, b) => (a.remote && b.remote ? a.remote === b.remote : canonica(a.path) === canonica(b.path));

/**
 * El volcado de la última corrida de una historia en este repo: `{ archivo, dump }` o null. Va por la fecha del cierre, no
 * por el nombre (los `-sin-cerrar` ordenan siempre últimos). Con `pr`, primero el que trae ese pedido; una corrida
 * abandonada (`-sin-cerrar`) sólo si no hay otra. Un volcado de otro repo con el mismo número es otra historia.
 */
function ultimoVolcado({ stateDir, storyId, repoDir = null, pr = null }) {
  const dir = path.join(stateDir, 'timing-history');
  const prefijo = `${String(storyId).replace(/[^\w.-]/g, '_')}-`;
  let nombres = [];
  try { nombres = fs.readdirSync(dir).filter((f) => f.startsWith(prefijo) && f.endsWith('.json')); } catch (_) { return null; }
  const propio = repoDe(repoDir);
  const todos = [];
  for (const f of nombres) {
    const archivo = path.join(dir, f);
    const dump = leerJson(archivo);
    if (!dump || !dump.marker || String(dump.marker.storyId) !== String(storyId)) continue;
    const suyo = dump.repo || repoDe(dump.marker.repoPath);
    if (propio && suyo && !mismoRepo(propio, suyo)) continue;
    let ms = aMs(dump.archivedAt);
    if (ms === null) { try { ms = fs.statSync(archivo).mtimeMs; } catch (_) { ms = 0; } }
    todos.push({ archivo, dump, ms, sinCerrar: dump.sinCerrar === true || f.endsWith('-sin-cerrar.json') });
  }
  todos.sort((a, b) => a.ms - b.ms);
  const conPedido = pr ? todos.filter((v) => v.dump.marker.pr && v.dump.marker.pr.number === pr) : [];
  const cerrados = todos.filter((v) => !v.sinCerrar);
  const v = (conPedido.length ? conPedido : cerrados.length ? cerrados : todos).pop();
  return v ? { archivo: v.archivo, dump: v.dump } : null;
}

/** El marcador vivo que pide la línea de comandos: el de esta sesión si está entre los que coinciden; si no, el más reciente. */
function marcadorPedido(estado, story, id) {
  const porRuta = /\.md$/.test(story) ? canonica(story) : null;
  const sid = process.env.CLAUDE_CODE_SESSION_ID || process.env.TYCON_SESSION_ID || process.env.CODEX_SESSION_ID || null;
  const vivos = [];
  let nombres = [];
  try { nombres = fs.readdirSync(path.join(estado, 'active')).filter((f) => f.endsWith('.json')); } catch (_) { return null; }
  for (const f of nombres) {
    const m = leerJson(path.join(estado, 'active', f));
    if (!m) continue;
    const sp = rutaDeLaHistoria(m);
    if (porRuta ? sp && canonica(sp) === porRuta : String(m.storyId) === String(id)) vivos.push({ m, propio: path.basename(f, '.json') === sid });
  }
  const propio = vivos.find((v) => v.propio);
  if (propio) return propio.m;
  vivos.sort((a, b) => (aMs(b.m.lastTouch) || 0) - (aMs(a.m.lastTouch) || 0));
  return vivos.length ? vivos[0].m : null;
}

function main(argv) {
  const i = argv.indexOf('--story');
  const story = i >= 0 ? argv[i + 1] : null;
  if (!story) { process.stderr.write('uso: node run-lines.js --story <ruta o id> [--final] [--json]\n'); return 2; }
  const estado = stateDirDe(os.homedir());
  const id = /\.md$/.test(story) ? ((/story-([\w.]+?)-/.exec(path.basename(story)) || [])[1] || story) : story;
  const marker = marcadorPedido(estado, story, id);
  let dump = null;
  if (!marker) {
    let repoDir = null;
    try { repoDir = require('./repo-attrib.js').gitRoot(/\.md$/.test(story) ? path.dirname(path.resolve(story)) : process.cwd()); } catch (_) { repoDir = null; }
    const v = ultimoVolcado({ stateDir: estado, storyId: id, repoDir });
    dump = v ? v.dump : null;
    if (!dump) { process.stderr.write(`run-lines: no hay corrida viva ni volcado de la historia ${id}\n`); return 1; }
  }
  const m = marker || dump.marker;
  const ls = lines({ marker: m, stateDir: estado });
  const fin = argv.includes('--final') ? final({ dump: dump || { marker: m }, stateDir: estado }) : null;
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ lines: ls, final: fin }, null, 2)}\n`);
  else process.stdout.write(`${[...ls.map((l) => l.text), ...(fin ? [fin] : [])].join('\n')}\n`);
  return 0;
}

module.exports = { lines, stepLine, stateLine, final, noticeText, gatesSince, ultimoVolcado, carpetaDe, recortar, duracion, SIN_MOTIVO };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
