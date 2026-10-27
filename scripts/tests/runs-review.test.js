'use strict';
// stable-data: este archivo nombra `git commit` y `git push` como texto de conversaciones de mentira; no crea commits ni lee el reloj.
/*
 * runs-review.test.js — la revisión nocturna de las ejecuciones: las reglas (rules.js) y la pasada (runs-review.js).
 *
 * El buzón es una carpeta de mentira en un temporal, con la forma que deja download-runs.js; las conversaciones se arman
 * acá, línea por línea, y se comprimen en la prueba. Máquinas, stories y rutas inventadas: nada habla con la red. Cada
 * caso dice la mutación que lo pone en rojo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const RULES = require(path.join(ROOT, 'scripts', 'nightly', 'runs-review', 'rules.js'));
const RR = require(path.join(ROOT, 'scripts', 'nightly', 'runs-review', 'runs-review.js'));
const RUNS = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'runs.js'));
const FIX = path.join(__dirname, 'fixtures', 'runs-review');

const HOY = '2026-10-22';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ── Las piezas de una conversación ──────────────────────────────────────────────────────────────────────────────
let n = 0;
const ts = (min = 0) => new Date(Date.parse('2026-10-22T14:00:00Z') + min * 60000).toISOString();
/** Un comando que corrió el modelo y su resultado: dos líneas, como las deja Claude Code. */
function cmd(command, { texto = '', error = false, min = 0, name = 'Bash' } = {}) {
  n += 1;
  const id = `toolu_${n}`;
  const input = name === 'Bash' || name === 'PowerShell' ? { command } : {};
  return [
    { type: 'assistant', timestamp: ts(min), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', timestamp: ts(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: texto, is_error: error }] } },
  ];
}
const mcp = (name, opts) => cmd('', { ...opts, name });
const texto = (t, min = 0) => [{ type: 'assistant', timestamp: ts(min), message: { role: 'assistant', content: [{ type: 'text', text: t }] } }];
const copia = (lineas) => lineas.filter((l) => l.type === 'assistant').map((l) => ({ type: 'api-request-blob', message: l.message }));
const hook = (evento, categoria, textoError = 'x') => ({ type: 'attachment', timestamp: ts(1),
  attachment: { type: 'hook_non_blocking_error', hookName: evento, hookEvent: evento, exitCode: 1, categoria, texto: textoError } });

const MARKER = 'node /opt/acme/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js';
const PIPE = 'node /opt/acme/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js';

/**
 * Un volcado: lo que escribe `marker.js clear`, con lo que piden las reglas. Sin `completados`, están hechos los pasos de
 * antes del primero pendiente, como en una ejecución de verdad. `archivedAt` es posterior a la constancia del cierre
 * (8.92): antes, una ejecución sin cerrar es `derivada/arnes-anterior` (T64).
 */
function volcado({ sid, archivedAt = `${HOY}T22:19:00.000Z`, pendientes = [], completados = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((p) => !pendientes.length || p < Math.min(...pendientes)), checks = { tests: 'green' }, cierre, autonomous = true, sinCerrar } = {}) {
  const marker = { storyId: '1.1', sessionId: sid, startedAt: `${HOY}T14:00:00.000Z`, stepsCompleted: completados, stepsPending: pendientes, checks, autonomous };
  if (cierre !== undefined) marker.cierre = cierre;
  const d = { archivedAt, marker, gates: [] };
  if (sinCerrar) { d.sinCerrar = true; d.archivedAt = null; }
  return d;
}

/** Un buzón: `{ <maquina>: { corridas: [{ base, volcado, hilo, hiloRoto }], registros: { bypass, frenos } } }`. */
function buzon(def) {
  const dir = tmp('rr-buzon-');
  for (const [maq, m] of Object.entries(def)) {
    const d = path.join(dir, maq);
    fs.mkdirSync(d, { recursive: true });
    for (const c of m.corridas || []) {
      fs.writeFileSync(path.join(d, `${c.base}.json`), typeof c.volcado === 'string' ? c.volcado : JSON.stringify(c.volcado));
      if (c.hiloRoto) fs.writeFileSync(path.join(d, `${c.base}.hilo.jsonl.gz`), 'esto no es gzip');
      else if (c.hilo) fs.writeFileSync(path.join(d, `${c.base}.hilo.jsonl.gz`), zlib.gzipSync(c.hilo.map((l) => JSON.stringify(l)).join('\n') + '\n'));
    }
    if (m.registros) {
      const r = path.join(d, 'registros');
      fs.mkdirSync(r, { recursive: true });
      const fuente = (lineas) => (lineas ? { estado: 'medido' } : { estado: 'no_medido', motivo: 'el registro no existe en esta máquina' });
      const fuentes = { bypass: fuente(m.registros.bypass), frenos: fuente(m.registros.frenos) };
      fs.writeFileSync(path.join(r, 'cobertura.json'), JSON.stringify({ esquema: 1, fecha: HOY, fuentes }));
      if (m.registros.bypass) fs.writeFileSync(path.join(r, 'bypass.log.gz'), zlib.gzipSync(m.registros.bypass.map((l) => JSON.stringify(l)).join('\n') + '\n'));
      if (m.registros.frenos) fs.writeFileSync(path.join(r, 'frenos.jsonl.gz'), zlib.gzipSync(m.registros.frenos.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'));
    }
  }
  return dir;
}
/** El clon de operaciones de mentira: `operations.json` con `site.url` (o sin él) y la cola vacía. */
function ops({ url = 'https://sitio.ejemplo.test' } = {}) {
  const dir = tmp('rr-ops-');
  fs.writeFileSync(path.join(dir, 'operations.json'), JSON.stringify({ version: 1, owners: { default: 'lead@ejemplo.test' }, ...(url ? { site: { url } } : {}) }));
  return dir;
}
const correr = (mb, op, extra = {}) => RR.run({ mailbox: mb, ops: op, today: HOY, noDownload: true, ...extra });
const fichas = (op, carpeta = 'pending') => { const d = path.join(op, 'inbox', 'runs-review', carpeta); try { return fs.readdirSync(d).filter((f) => f.endsWith('.yaml')).map((f) => ({ f, ...RR.leerFicha(path.join(d, f)) })); } catch { return []; } };
const lastRun = (op) => JSON.parse(fs.readFileSync(path.join(op, 'inbox', 'runs-review', 'last-run.json'), 'utf8'));
const CYCLE = require(path.join(ROOT, 'scripts', 'nightly', 'findings', 'cycle.js'));
/** Las ejecuciones de las fichas por causa: una por (id, base), con las causas que la traen. */
const ejecucionesDe = (op, carpeta = 'pending') => {
  const m = new Map();
  for (const f of fichas(op, carpeta)) {
    for (const c of f.casos || []) {
      const k = `${c.ejecucion}|${c.base}`;
      const e = m.get(k) || { id: c.ejecucion, base: c.base, causas: [] };
      e.causas.push(f.causa);
      m.set(k, e);
    }
  }
  return [...m.values()];
};
const regla = (r, codigo, categoria) => r.reglas.filter((x) => x.regla === codigo && (categoria === undefined || x.categoria === categoria));
const revisar = (lineas, extra = {}) => RULES.revisar({ volcado: volcado({ sid: 's' }), lineasHilo: lineas, registros: null, maquina: 'acme-0000aaaa', ...extra });
const SID = (k) => `aaaaaaaa-0000-4000-8000-00000000000${k}`;

// ── Qué ejecuciones se miran ─────────────────────────────────────────────────────────────────────────────────────

// T1 VentanaYIdComoElSitio @story-4.10 @ac-1
// 🔴 Falla con: contar la ventana por otra fecha (la de hace 20 días entra), un id distinto del de la pestaña Corridas
//    (el enlace abre otra cosa), o quedarse con la versión vieja de una sesión subida dos veces.
test('T1 VentanaYIdComoElSitio @story-4.10 @ac-1', async () => {
  const mb = buzon({
    'acme-0000aaaa': { corridas: [
      { base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1), pendientes: [7], checks: { tests: 'red:exit=1' } }), hilo: [] },
      { base: '1.2-2026-10-20T1000', volcado: volcado({ sid: SID(2), archivedAt: '2026-10-20T10:00:00.000Z', pendientes: [8] }), hilo: [] },
      { base: '1.3-2026-10-02T1000', volcado: volcado({ sid: SID(3), archivedAt: '2026-10-02T10:00:00.000Z', pendientes: [8] }), hilo: [] },
      // la fecha del nombre manda sobre archivedAt; sin fecha en el nombre, cuenta archivedAt
      { base: '1.4-2026-10-21T0800', volcado: volcado({ sid: SID(5), archivedAt: '2026-10-01T08:00:00.000Z', pendientes: [8] }), hilo: [] },
      { base: '1.5-2026-10-01T0800', volcado: volcado({ sid: SID(6), pendientes: [8] }), hilo: [] },
      { base: 'raro', volcado: volcado({ sid: SID(7), pendientes: [8] }), hilo: [] },
    ] },
    'acme-0000bbbb': { corridas: [
      { base: '2.1-2026-10-21T0900', volcado: volcado({ sid: SID(4), archivedAt: '2026-10-21T09:00:00.000Z', pendientes: [8] }), hilo: [] },
      { base: '2.1-2026-10-21T1100', volcado: volcado({ sid: SID(4), archivedAt: '2026-10-21T11:00:00.000Z', pendientes: [] }), hilo: [] },
    ] },
  });
  const op = ops();
  const r = await correr(mb, op);
  assert.strictEqual(r.codigo, 0);
  const l = lastRun(op);
  assert.strictEqual(l.miradas, 6, 'la de hoy, la de hace 2 días, las dos ejecuciones de la sesión 4, la 1.4 por su nombre y la sin fecha por archivedAt');
  const ids = [...new Set(ejecucionesDe(op).map((e) => e.id))].sort();
  const reg = RUNS.leerRegistro(null, RUNS.nombresDePasos().nombres, { buzon: mb, soloBuzon: true });
  const delSitio = (sid) => reg.corridas.find((c) => c.id === RUNS.idEstable(c.maquina, sid));
  assert.deepStrictEqual(ids, [SID(1), SID(2), SID(4), SID(5), SID(7)].map((s) => delSitio(s).id).sort(), 'mismo id que la pestaña; la 1.5 queda fuera por su nombre');
});

// T2 FichaEnPendingSeActualiza @story-4.10 @ac-2 @story-4.11 @ac-8 (la ficha es de la causa)
// 🔴 Falla con: escribir una segunda ficha para la misma causa, repetir la ejecución en sus casos, o no sumar la noche.
test('T2 FichaEnPendingSeActualiza @story-4.10 @ac-2', async () => {
  const sid = SID(1);
  const base = `1.1-${HOY}T1519`;
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base, volcado: volcado({ sid, pendientes: [7] }), hilo: [] }] } });
  const op = ops();
  await correr(mb, op, { today: '2026-10-21' });
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', `${base}.hilo.jsonl.gz`), zlib.gzipSync(cmd(`${MARKER} set-autonomous false`).map((l) => JSON.stringify(l)).join('\n')));
  await correr(mb, op);
  const f = fichas(op);
  assert.deepStrictEqual(f.map((x) => x.causa).sort(), ['RR-APAGO', 'RR-CIERRE:derivada']);
  const cierre = f.find((x) => x.causa === 'RR-CIERRE:derivada');
  assert.deepStrictEqual([cierre.casos.length, cierre.apariciones, cierre.ultima_vez], [1, 2, HOY]);
});

// T3 FichaArchivadaCalla @story-4.10 @ac-2
// 🔴 Falla con: reescribir o duplicar una ficha que una persona ya decidió.
test('T3 FichaArchivadaCalla @story-4.10 @ac-2', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1), pendientes: [7] }), hilo: [] }] } });
  const op = ops();
  await correr(mb, op);
  const [f] = fichas(op);
  const arch = path.join(op, 'inbox', 'runs-review', 'archived');
  fs.mkdirSync(arch, { recursive: true });
  fs.renameSync(path.join(op, 'inbox', 'runs-review', 'pending', f.f), path.join(arch, f.f));
  const antes = fs.readFileSync(path.join(arch, f.f), 'utf8');
  await correr(mb, op);
  assert.strictEqual(fichas(op).length, 0);
  assert.strictEqual(fs.readFileSync(path.join(arch, f.f), 'utf8'), antes);
});

// T4 FichaArchivadaReapareceConReglaNueva @story-4.10 @ac-2 @story-4.11 @ac-8 (la regla nueva es otra causa)
// 🔴 Falla con: no abrir la ficha de la causa nueva, o tocar la decidida (reabrir una causa todavía no lo hace la pasada).
test('T4 FichaArchivadaReapareceConReglaNueva @story-4.10 @ac-2', async () => {
  const base = `1.1-${HOY}T1519`;
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base, volcado: volcado({ sid: SID(1), pendientes: [7] }), hilo: [] }] } });
  const op = ops();
  await correr(mb, op, { today: '2026-10-20' });
  const [f] = fichas(op);
  const arch = path.join(op, 'inbox', 'runs-review', 'archived');
  fs.mkdirSync(arch, { recursive: true });
  fs.renameSync(path.join(op, 'inbox', 'runs-review', 'pending', f.f), path.join(arch, f.f));
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', `${base}.hilo.jsonl.gz`), zlib.gzipSync(cmd(`${MARKER} set-autonomous false`).map((l) => JSON.stringify(l)).join('\n')));
  const antes = fs.readFileSync(path.join(arch, f.f), 'utf8');
  await correr(mb, op);
  assert.deepStrictEqual(fichas(op).map((x) => x.causa), ['RR-APAGO'], 'la causa nueva nace en pending/');
  assert.strictEqual(fs.readFileSync(path.join(arch, f.f), 'utf8'), antes, 'la decidida queda como está');
});

// T5 EjecucionLimpiaNoDejaFicha @story-4.10 @ac-2
// 🔴 Falla con: una ficha vacía por cada ejecución mirada.
test('T5 EjecucionLimpiaNoDejaFicha @story-4.10 @ac-2', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1) }), hilo: cmd(`${PIPE} next`) }] } });
  const op = ops();
  await correr(mb, op);
  assert.strictEqual(fichas(op).length, 0);
  const l = lastRun(op);
  assert.strictEqual(l.miradas, 1);
  assert.strictEqual(l.con_fallas, 0);
});

// ── Las reglas ──────────────────────────────────────────────────────────────────────────────────────────────────

// T6 RrHookCuentaPorEventoYCategoria @story-4.10 @ac-5
// 🔴 Falla con: un conteo único (no se sabe qué evento falló) o contar los que no son de hook.
test('T6 RrHookCuentaPorEventoYCategoria @story-4.10 @ac-5', () => {
  const lineas = [...Array(15).fill(0).map(() => hook('UserPromptSubmit', 'carga')), hook('SessionStart', 'node-viejo'), hook('SessionStart', 'node-viejo')];
  const r = revisar(lineas);
  const h = regla(r, 'RR-HOOK').map((x) => `${x.categoria}:${x.cuenta}`).sort();
  assert.deepStrictEqual(h, ['SessionStart/node-viejo:2', 'UserPromptSubmit/carga:15']);
});

// T7 RrNodeSoloConRutaDelArnes @story-4.10 @ac-6
// 🔴 Falla con: buscar el error en cualquier salida (el `node -e`, la prueba del proyecto o el `grep` cuentan).
test('T7 RrNodeSoloConRutaDelArnes @story-4.10 @ac-6', () => {
  const lineas = [
    ...cmd(`node D:\\acme\\.claude\\skills\\tycon-pipeline\\scripts\\pipeline.js next`, { texto: "D:\\acme\\.claude\\skills\\tycon-pipeline\\scripts\\pipeline.js:1809\n  x?.y\n   ^\nSyntaxError: Unexpected token '.'\n    at internal/modules/cjs/loader.js:881" }),
    ...cmd(`node -e "require(undefined)"`, { texto: 'at Module.require (node:internal/modules/cjs/loader:1520:3)', error: true }),
    ...cmd('npm test', { texto: "Error: Cannot find module 'C:\\Repos\\Acme\\Web\\tests\\deps'", error: true }),
    ...cmd('grep -rn SyntaxError ~/.tycon/harness/scripts', { texto: '/opt/acme/.tycon/harness/scripts/x.js:3: // SyntaxError: Unexpected token' }),
  ];
  const r = revisar(lineas);
  assert.deepStrictEqual(regla(r, 'RR-NODE').map((x) => `${x.categoria}:${x.cuenta}`), ['node-viejo:1']);
});

// T8 RrApagoSoloComandos @story-4.10 @ac-7
// 🔴 Falla con: buscar el texto suelto (el texto del asistente, la copia en api-request-blob, el heredoc, el echo y el
//    commit -m suman 5 más).
test('T8 RrApagoSoloComandos @story-4.10 @ac-7', () => {
  const real = cmd(`${MARKER} set-autonomous false`);
  const lineas = [
    ...real, ...copia(real),
    ...texto('voy a correr marker.js set-autonomous false'),
    ...cmd(`cat > /tmp/x <<'EOF'\n${MARKER} set-autonomous false\nEOF`),
    ...cmd(`echo "${MARKER} set-autonomous false"`),
    ...cmd(`git commit -m "${MARKER} set-autonomous false"`),
    // la forma real de Windows: el Node del arnés en una variable, y el programa es la variable
    ...cmd('N=~/.tycon/node/current/node.exe; "$N" ~/.claude/skills/tycon-pipeline/scripts/marker.js set-autonomous false 2>&1 | tail -3'),
  ];
  const r = revisar(lineas);
  const a = regla(r, 'RR-APAGO');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].cuenta, 2, 'el comando directo y el que corre el Node por su variable');
  assert.strictEqual(a[0].con_frase, null, 'sin cierre: no medido');
});

// T9 RrApagoConFraseDeLaPersona @story-4.10 @ac-7
// 🔴 Falla con: leer `con_frase` de otro lado que `marker.cierre.via`.
test('T9 RrApagoConFraseDeLaPersona @story-4.10 @ac-7', () => {
  const lineas = cmd(`${MARKER} set-autonomous false`);
  const conVia = (via) => regla(revisar(lineas, { volcado: volcado({ sid: 's', cierre: { estado: 'abortada', via } }) }), 'RR-APAGO')[0].con_frase;
  assert.strictEqual(conVia('persona'), true);
  assert.strictEqual(conVia('reenvio'), false);
});

// T10 RrBanderaSinSuAccion @story-4.10 @ac-8
// 🔴 Falla con: contar toda bandera (el 3 y el 4 son el camino normal del Arranque), no mirar `is_error` de la acción,
//    o una lista de banderas copiada en vez de la de START_PARTS.
test('T10 RrBanderaSinSuAccion @story-4.10 @ac-8', () => {
  const lineas = [
    ...mcp('mcp__clockify__create-clockify-time-entry', { texto: 'CONNECT_TIMEOUT', error: true, min: 1 }),
    ...cmd(`${MARKER} set-flag clockiStarted true`, { min: 2 }),
    ...cmd(`${MARKER} set-flag adoMarkedActive true`, { min: 3 }),
    ...cmd('az boards work-item update --organization https://dev.azure.com/acme --id 7 --state "Active"', { min: 4 }),
    ...cmd(`${MARKER} set-flag adoMarkedActive true`, { min: 5 }),
    ...cmd(`${PIPE} work-signal start`, { min: 6 }),
    ...cmd(`${MARKER} set-flag workSignalStarted true`, { min: 7 }),
    ...cmd(`${MARKER} set-flag waitingForHuman true`, { min: 8 }),
  ];
  const r = revisar(lineas);
  assert.deepStrictEqual(regla(r, 'RR-BANDERA').map((x) => `${x.categoria}:${x.cuenta}`).sort(), ['adoMarkedActive:1', 'workSignalStarted:1']);
  const STEPS = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));
  const deLaTabla = Object.values(STEPS.START_PARTS).flatMap((p) => p.flags).sort();
  assert.deepStrictEqual(RULES.banderasDePartes().sort(), deLaTabla, 'la lista sale de START_PARTS');
});

// T11 RrCierreConMarca @story-4.10 @ac-9
// 🔴 Falla con: tomar `deuda` o `completa` como falla, o no mirar `marker.cierre`.
test('T11 RrCierreConMarca @story-4.10 @ac-9', () => {
  const cat = (estado) => regla(RULES.revisar({ volcado: volcado({ sid: 's', cierre: { estado, via: 'persona' } }), lineasHilo: [], registros: null }), 'RR-CIERRE').map((x) => x.categoria);
  assert.deepStrictEqual(cat('abortada'), ['abortada']);
  assert.deepStrictEqual(cat('abandonada'), ['abandonada']);
  assert.deepStrictEqual(cat('completa'), []);
  assert.deepStrictEqual(cat('deuda'), []);
});

// T12 RrCierreIncoherente @story-4.10 @ac-9
// 🔴 Falla con: creerle a la marca sin mirar el volcado.
test('T12 RrCierreIncoherente @story-4.10 @ac-9', () => {
  const r = RULES.revisar({ volcado: volcado({ sid: 's', pendientes: [7], cierre: { estado: 'completa' } }), lineasHilo: [], registros: null });
  assert.deepStrictEqual(regla(r, 'RR-CIERRE').map((x) => x.categoria), ['incoherente']);
});

// T13 RrCierreDerivadaSinMarca @story-4.10 @ac-9
// 🔴 Falla con: no leer los campos dentro de `marker` (la ejecución del Origen sale limpia).
test('T13 RrCierreDerivadaSinMarca @story-4.10 @ac-9', () => {
  const r = RULES.revisar({ volcado: volcado({ sid: 's', completados: [0, 1, 2, 3], pendientes: [4, 5, 6, 7, 8], checks: { tests: 'red:exit=1' } }), lineasHilo: [], registros: null });
  const [c] = regla(r, 'RR-CIERRE');
  assert.strictEqual(c.categoria, 'derivada');
  assert.strictEqual(c.pendientes, 5);
  assert.strictEqual(c.rojos, 1);
});

// T14 RrCierreSinCerrarYDesconocido @story-4.10 @ac-9
// 🔴 Falla con: descartar un estado que no está en la lista, o tomar una sin cerrar por limpia.
test('T14 RrCierreSinCerrarYDesconocido @story-4.10 @ac-9', () => {
  const sc = RULES.revisar({ volcado: volcado({ sid: 's', sinCerrar: true }), lineasHilo: [], registros: null });
  assert.deepStrictEqual(regla(sc, 'RR-CIERRE').map((x) => x.categoria), ['sin-cerrar']);
  const dz = RULES.revisar({ volcado: volcado({ sid: 's', cierre: { estado: 'rara' } }), lineasHilo: [], registros: null });
  assert.deepStrictEqual(regla(dz, 'RR-CIERRE').map((x) => x.categoria), ['desconocido']);
});

// T15 RrEscapeComandos @story-4.10 @ac-10
// 🔴 Falla con: no leer `$env:` de PowerShell, contar la ayuda de marker.js, o un escape sin su categoría.
test('T15 RrEscapeComandos @story-4.10 @ac-10', () => {
  const lineas = [
    ...cmd('TYCON_SAFETY_OFF=1 git push origin main'),
    ...cmd('$env:TYCON_FULL_SUITE="1"; npm test', { name: 'PowerShell' }),
    ...cmd('git commit --no-verify -m "x"'),
    ...cmd(`${MARKER} set-flag atddBypass true`),
    ...cmd(`${MARKER} --help`, { texto: 'uso: marker.js <get|set|…|story-skill-bypass|…>' }),
  ];
  const r = revisar(lineas);
  assert.deepStrictEqual(regla(r, 'RR-ESCAPE').map((x) => x.categoria).sort(), ['--no-verify', 'TYCON_FULL_SUITE', 'TYCON_SAFETY_OFF', 'atddBypass']);
});

// T16 RrEscapeRegistroYNoMedido @story-4.10 @ac-10
// 🔴 Falla con: contar dos veces el `--no-verify` (comando y registro), tomar líneas de otra sesión, o decir 0 escapes en
//    una máquina sin registro.
test('T16 RrEscapeRegistroYNoMedido @story-4.10 @ac-10', () => {
  const registros = { bypass: [
    // on-pre-commit.js guarda el comando de la herramienta tal cual (cortado a 300)
    { ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd: '/x', command: 'git commit --no-verify -m "x"', reason: 'la persona lo pidió' },
    { ts: ts(), sessionId: 's', repoPath: '/x', kind: 'ATDD_BYPASS', story: '1.1', reason: '' },
    { ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 'otra', cwd: '/x', command: 'git commit --no-verify' },
  ], cobertura: { fuentes: { bypass: { estado: 'medido' } } } };
  const r = RULES.revisar({ volcado: volcado({ sid: 's' }), lineasHilo: cmd('git commit --no-verify -m "x"'), registros });
  const e = regla(r, 'RR-ESCAPE').map((x) => `${x.categoria}:${x.cuenta}:${x.con_motivo}`).sort();
  assert.deepStrictEqual(e, ['ATDD_BYPASS:1:false', 'GIT_NO_VERIFY:1:true']);
  const sinReg = RULES.revisar({ volcado: volcado({ sid: 's' }), lineasHilo: [], registros: { bypass: null, cobertura: { fuentes: { bypass: { estado: 'no_medido' } } } } });
  assert.strictEqual(sinReg.escapes_registro, 'no_medido');
});

// ── La ficha y el estado de la pasada ───────────────────────────────────────────────────────────────────────────

// T17 FichaSoloCamposDeLaLista @story-4.10 @ac-11 @story-4.11 @ac-8 (la ficha común, con las ejecuciones como casos)
// 🔴 Falla con: un campo de más (texto de la conversación por el costado), un caso con algo fuera de su lista, o el
//    enlace sin el id.
test('T17 FichaSoloCamposDeLaLista @story-4.10 @ac-11', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1), pendientes: [7] }), hilo: cmd(`${MARKER} set-autonomous false`) }] } });
  const op = ops();
  await correr(mb, op);
  const f = fichas(op).find((x) => x.causa === 'RR-APAGO');
  // `reglas` lo agrega el lector, vacío: la ficha común no lo trae
  for (const k of Object.keys(f)) if (k !== 'f' && k !== 'reglas') assert.ok(CYCLE.CLAVES.includes(k), `campo fuera de la lista: ${k}`);
  assert.deepStrictEqual(f.reglas, []);
  const { f: _archivo, reglas: _reglas, ...ficha } = f;
  assert.deepStrictEqual(CYCLE.problemasDeForma(ficha), []);
  for (const c of f.casos) for (const k of Object.keys(c)) assert.ok(['ejecucion', 'base', 'dia', 'maquina', 'story'].includes(k), `clave de caso fuera de la lista: ${k}`);
  assert.strictEqual(RR.enlaceDeCaso(f.casos[0], 'https://sitio.ejemplo.test'), `https://sitio.ejemplo.test/corridas?abrir=${f.casos[0].ejecucion}`);
  assert.deepStrictEqual([f.fuente, f.veredicto], ['ejecuciones', 'pendiente']);
});

// T18 SinTextoLibre @story-4.10 @ac-12
// 🔴 Falla con: copiar a la ficha o al estado un comando, una salida, un texto o una ruta.
test('T18 SinTextoLibre @story-4.10 @ac-12', async () => {
  const z = (i) => `ZZTEXTO-${String(i).padStart(2, '0')}`;
  const hilo = [
    ...cmd(`${MARKER} set-autonomous false # ${z(1)}`, { texto: z(2) }),
    ...cmd(`TYCON_SAFETY_OFF=1 git push ${z(3)}`, { texto: z(4), error: true }),
    ...cmd(`node /opt/${z(5)}/.tycon/harness/scripts/x.js`, { texto: `SyntaxError: Unexpected token ${z(6)}` }),
    ...texto(`${z(7)} ${z(8)}`),
    hook('Stop', 'carga', z(9)),
    { type: 'user', timestamp: ts(), message: { role: 'user', content: `${z(10)} ${z(11)}` } },
    { type: 'attachment', timestamp: ts(), attachment: { type: 'hook_non_blocking_error', hookName: z(17), hookEvent: 'Stop', exitCode: 1, categoria: 'otro', texto: z(18) } },
    ...mcp('mcp__clockify__create-clockify-time-entry', { texto: z(19), error: true }),
    ...cmd(`${MARKER} set-flag clockiStarted true # ${z(20)}`),
  ];
  const v = volcado({ sid: SID(1), pendientes: [7] });
  v.marker.repoPath = `/opt/${z(12)}/repo`;
  v.marker.storyPath = `/opt/${z(13)}/story.md`;
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base: `1.1-${HOY}T1519`, volcado: v, hilo }],
    registros: { bypass: [{ ts: ts(), type: 'GIT_NO_VERIFY', sessionId: SID(1), cwd: `/${z(14)}`, command: z(15), reason: z(16) }] } } });
  const op = ops();
  await correr(mb, op);
  const todo = [...fs.readdirSync(path.join(op, 'inbox', 'runs-review', 'pending')).map((f) => fs.readFileSync(path.join(op, 'inbox', 'runs-review', 'pending', f), 'utf8')),
    fs.readFileSync(path.join(op, 'inbox', 'runs-review', 'last-run.json'), 'utf8')].join('\n');
  assert.ok(todo.length > 0);
  assert.doesNotMatch(todo, /ZZTEXTO-/);
});

// T19 LastRunCompletoYParcial @story-4.10 @ac-13
// 🔴 Falla con: decir `completo: true` con una bajada parcial, o una clave fuera de la lista.
test('T19 LastRunCompletoYParcial @story-4.10 @ac-13', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [
    { base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1) }), hilo: [] },
    { base: `1.2-${HOY}T1600`, volcado: volcado({ sid: SID(2), pendientes: [7] }), hilo: [] },
  ] } });
  const op = ops();
  let destino = null;
  let desde = null;
  const ambienteAntes = JSON.stringify(process.env);
  let ambienteDurante = null;
  await RR.run({ mailbox: mb, ops: op, today: HOY, bajar: async (o) => { destino = o.dirBuzon; desde = o.hilosDesde; ambienteDurante = JSON.stringify(process.env); return { codigo: 0, res: { completo: true, estado: 'bajado' } }; } });
  // 🔴 Falla también con: bajar a otra carpeta que la que se lee (la pasada revisaría el espejo de ayer).
  assert.strictEqual(destino, mb, 'la bajada escribe donde la pasada lee');
  // la carpeta va por parámetro: el ambiente no se toca ni durante la bajada ni después
  assert.strictEqual(ambienteDurante, ambienteAntes, 'la pasada no cambia el ambiente para la bajada');
  assert.strictEqual(desde, '2026-10-15', 'conversaciones desde hoy menos la ventana');
  const a = lastRun(op);
  assert.deepStrictEqual(Object.keys(a).sort(), ['causas', 'completo', 'con_fallas', 'escapes_autorizados', 'fecha', 'hilos_sin_hooks', 'ilegibles', 'maquinas_sin_frenos', 'miradas', 'motivo', 'nuevas', 'sin_hilo']);
  assert.strictEqual(a.completo, true);
  assert.deepStrictEqual([a.miradas, a.con_fallas, a.nuevas], [2, 1, 1]);
  // la parcial, sin una pasada entera de hoy delante (con una, no se pisa: AC 13, T47)
  fs.unlinkSync(path.join(op, 'inbox', 'runs-review', 'last-run.json'));
  const r = await RR.run({ mailbox: mb, ops: op, today: HOY, bajar: async () => ({ codigo: 1, res: { completo: false, estado: 'parcial', motivo: '2 archivo(s) no se pudieron bajar' } }) });
  assert.strictEqual(r.codigo, 1);
  assert.strictEqual(lastRun(op).completo, false);
  assert.match(lastRun(op).motivo, /no fue entera \(parcial\)/, 'el estado de la bajada, sin copiar su texto');
  // una bajada que se cae: el motivo es una frase de la lista y el registro dice la clase, sin el texto del error
  fs.unlinkSync(path.join(op, 'inbox', 'runs-review', 'last-run.json'));
  const escribir = process.stderr.write;
  let registro = '';
  process.stderr.write = (s) => { registro += String(s); return true; };
  let caida;
  try { caida = await RR.run({ mailbox: mb, ops: op, today: HOY, bajar: async () => { throw new TypeError('la carpeta de alguien: dirBuzon inválido'); } }); }
  finally { process.stderr.write = escribir; }
  assert.strictEqual(caida.codigo, 1);
  assert.strictEqual(lastRun(op).motivo, 'la bajada del buzón no fue entera (error)');
  assert.ok(RR.MOTIVOS.some((m) => m.test(lastRun(op).motivo)), 'el resumen de la mañana imprime el motivo');
  assert.match(registro, /la bajada del buzón se cayó \(TypeError\)/, 'el registro dice la clase del error');
  assert.doesNotMatch(registro + fs.readFileSync(path.join(op, 'inbox', 'runs-review', 'last-run.json'), 'utf8'), /alguien|dirBuzon inválido/, 'el texto del error no sale');
});

// ── Modos de falla ──────────────────────────────────────────────────────────────────────────────────────────────

// T20 BuzonSinPermiso @story-4.10 @ac-18
// 🔴 Falla con: borrar o mover fichas cuando no se pudo leer el buzón, o salir 0.
test('T20 BuzonSinPermiso @story-4.10 @ac-18', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1), pendientes: [7] }), hilo: [] }] } });
  const op = ops();
  // la pasada de ayer dejó fichas; hoy no hubo ninguna entera (con una, no se pisa: AC 13, T47)
  await correr(mb, op, { today: '2026-10-21' });
  const antes = fichas(op).map((f) => f.f);
  const vacio = tmp('rr-vacio-');
  const r = await RR.run({ mailbox: vacio, ops: op, today: HOY, bajar: async () => ({ codigo: 1, res: { completo: false, estado: 'sin_permiso', motivo: 'el buzón contestó 403' } }) });
  assert.strictEqual(r.codigo, 1);
  assert.deepStrictEqual(fichas(op).map((f) => f.f), antes, 'ninguna ficha tocada');
  assert.strictEqual(lastRun(op).completo, false);
  assert.match(lastRun(op).motivo, /no fue entera \(sin_permiso\)/);
});

// T21 SinConversacionNoEsLimpio @story-4.10 @ac-19
// 🔴 Falla con: saltear la ejecución sin conversación, o no decir que no se midió.
test('T21 SinConversacionNoEsLimpio @story-4.10 @ac-19', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [
    { base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1), checks: { tests: 'red:exit=1' } }) },
    { base: `1.2-${HOY}T1600`, volcado: volcado({ sid: SID(2), checks: { tests: 'red:exit=1' } }), hiloRoto: true },
  ] } });
  const op = ops();
  await correr(mb, op);
  const f = fichas(op);
  assert.strictEqual(f.length, 1, 'sin conversación sólo corre la regla del volcado: una causa');
  assert.match(f[0].causa, /^RR-CIERRE/);
  assert.strictEqual(f[0].casos.length, 2, 'las dos ejecuciones, aunque no tengan conversación');
  assert.strictEqual(lastRun(op).sin_hilo, 2);
});

// T22 HiloSinLineasDeHook @story-4.10 @ac-20
// 🔴 Falla con: afirmar «0 errores de hook» (un RR-HOOK con cuenta 0), o no sumarla a `hilos_sin_hooks` de la pasada.
test('T22 HiloSinLineasDeHook @story-4.10 @ac-20', async () => {
  const r = revisar(cmd(`${PIPE} next`));
  assert.strictEqual(regla(r, 'RR-HOOK').length, 0);
  assert.strictEqual(r.hilo_sin_hooks, true);
  const mb = buzon({ 'acme-0000aaaa': { corridas: [
    { base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1) }), hilo: cmd(`${PIPE} next`) },
    { base: `1.2-${HOY}T1600`, volcado: volcado({ sid: SID(2) }), hilo: [hook('Stop', 'carga')] },
  ] } });
  const op = ops();
  await correr(mb, op);
  assert.strictEqual(lastRun(op).hilos_sin_hooks, 1);
});

// T23 VolcadoIlegibleSigue @story-4.10 @ac-22
// 🔴 Falla con: cortar la pasada en el primer JSON roto, o no bajar `completo`.
test('T23 VolcadoIlegibleSigue @story-4.10 @ac-22', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [
    { base: `1.0-${HOY}T1000`, volcado: '{ esto no es json' },
    { base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1), pendientes: [7] }), hilo: [] },
    { base: `1.2-${HOY}T1600`, volcado: volcado({ sid: SID(2) }), hilo: [] },
  ] } });
  const op = ops();
  await correr(mb, op);
  const l = lastRun(op);
  assert.strictEqual(l.ilegibles, 1);
  assert.strictEqual(l.miradas, 2);
  assert.strictEqual(l.completo, false);
});

// T24 SinSiteUrlEnlaceRelativo @story-4.10 @ac-23
// 🔴 Falla con: un enlace con `undefined`, o fallar la pasada.
test('T24 SinSiteUrlEnlaceRelativo @story-4.10 @ac-23', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1), pendientes: [7] }), hilo: [] }] } });
  const op = ops({ url: null });
  const r = await correr(mb, op);
  assert.strictEqual(r.codigo, 0);
  const [f] = fichas(op);
  // el enlace no se guarda en la ficha: se arma al leer, relativo sin el sitio
  assert.strictEqual(RR.enlaceDeCaso(f.casos[0], null), `/corridas?abrir=${f.casos[0].ejecucion}`);
  assert.doesNotMatch(fs.readFileSync(path.join(op, 'inbox', 'runs-review', 'pending', f.f), 'utf8'), /undefined/);
});

// T25 FixtureComoLaDelOrigen @story-4.10 @ac-6 @ac-7 @ac-8 @ac-9 @ac-10
// La ejecución que motivó la story, con su forma y sus hechos (scripts/tests/fixtures/runs-review/origin/).
// 🔴 Falla con: cualquier regla que cuente texto suelto (sale RR-NODE de más, RR-APAGO 3, RR-BANDERA de atddBypass) o que
//    no lea la forma real del volcado.
test('T25 FixtureComoLaDelOrigen @story-4.10 @ac-6 @ac-7 @ac-8 @ac-9 @ac-10', async () => {
  const dir = path.join(FIX, 'origin');
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'dump.json'), 'utf8'));
  const hilo = fs.readFileSync(path.join(dir, 'thread.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base: `1.1-${HOY}T1519`, volcado: v, hilo }], registros: {} } });
  const op = ops();
  await correr(mb, op);
  // una ficha por causa, cada una con la ejecución como caso; se archivó antes de la constancia del cierre (8.92)
  assert.deepStrictEqual(fichas(op).map((f) => `${f.causa}:${f.casos.length}`).sort(),
    ['RR-APAGO:1', 'RR-BANDERA:adoMarkedActive:1', 'RR-BANDERA:workSignalStarted:1', 'RR-CIERRE:derivada/arnes-anterior:1', 'RR-NODE:node-viejo:1']);
  // la cuenta de cada regla y el registro de escapes no viajan en la ficha por causa: se miran en lo que dan las reglas
  const r = RULES.revisar({ volcado: v, lineasHilo: hilo, registros: { cobertura: null, bypass: null } });
  assert.deepStrictEqual(r.reglas.map((x) => `${x.regla}/${x.categoria}:${x.cuenta}`).sort(),
    ['RR-APAGO/null:1', 'RR-BANDERA/adoMarkedActive:1', 'RR-BANDERA/workSignalStarted:1', 'RR-CIERRE/derivada/arnes-anterior:1', 'RR-NODE/node-viejo:1']);
  assert.strictEqual(r.reglas.find((x) => x.regla === 'RR-APAGO').con_frase, null);
  assert.strictEqual(r.escapes_registro, 'no_medido');
});

// T35 FichaSinReglasHoySeArchivaSola @story-4.10 @ac-2 @story-4.11 @ac-8 (la causa no se archiva por una ejecución)
// 🔴 Falla con: archivar la ficha de una causa porque UNA de sus ejecuciones hoy ya no da la regla: resolver una causa
//    son N noches medidas sin aparecer (lo prueba T16 Resuelta_TrasNNoches), no una ejecución que ya no da la regla.
test('T35 FichaSinReglasHoySeArchivaSola @story-4.10 @ac-2', async () => {
  const base = `1.1-${HOY}T1519`;
  // revisable entera: con conversación y con el registro de escapes medido (vacío)
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base, volcado: volcado({ sid: SID(1), pendientes: [7] }), hilo: [] }], registros: { bypass: [] } } });
  const op = ops();
  await correr(mb, op, { today: '2026-10-21' });
  assert.strictEqual(fichas(op).length, 1);
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', `${base}.json`), JSON.stringify(volcado({ sid: SID(1) })));
  await correr(mb, op);
  assert.strictEqual(fichas(op).length, 1, 'sigue en pending/');
  assert.strictEqual(fichas(op, 'archived').length, 0);
});

// ── Lo que confirmó el pase adversarial y lo que pidieron los revisores ─────────────────────────────────────────

// T36 DosEjecucionesDeUnaSesion @story-4.10 @ac-1 @ac-2
// 🔴 Falla con: mirar sólo el volcado más nuevo de cada sesión (la abortada de la primera story se pierde).
test('T36 DosEjecucionesDeUnaSesion @story-4.10 @ac-1 @ac-2', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [
    { base: '1.1-2026-10-21T1000', volcado: volcado({ sid: SID(1), archivedAt: '2026-10-21T10:00:00.000Z', cierre: { estado: 'abortada', via: 'persona' } }), hilo: [] },
    { base: '1.2-2026-10-21T1200', volcado: volcado({ sid: SID(1), archivedAt: '2026-10-21T12:00:00.000Z', cierre: { estado: 'completa' } }), hilo: [] },
  ] } });
  const op = ops();
  await correr(mb, op);
  assert.strictEqual(lastRun(op).miradas, 2);
  const f = fichas(op);
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual(f[0].casos.map((c) => c.base), ['1.1-2026-10-21T1000']);
});

// T37 AdoYaActivoNoEsFalla @story-4.10 @ac-8
// 🔴 Falla con: aceptar sólo `update --state` (el camino «ya estaba en Active» del Arranque es un `show`), o no leer
//    `--state=…`, `az.cmd` ni opciones antes de `boards`.
test('T37 AdoYaActivoNoEsFalla @story-4.10 @ac-8', () => {
  const caso = (accion) => regla(revisar([...cmd(accion), ...cmd(`${MARKER} set-flag adoMarkedActive true`)]), 'RR-BANDERA').length;
  assert.strictEqual(caso('az boards work-item show --id 12 --query "fields.\\"System.State\\"" --output tsv'), 0);
  assert.strictEqual(caso('az boards work-item update --id 5 --state=Active'), 0);
  assert.strictEqual(caso('az.cmd boards work-item update --id 1 --state Active'), 0);
  assert.strictEqual(caso('az --only-show-errors boards work-item update --id 1 --state Active'), 0);
  assert.strictEqual(caso('az boards query --id 3'), 1, 'otra cosa de az no es la acción');
});

// T38 ValoresQueMarkerAcepta @story-4.10 @ac-7 @ac-8 @ac-10
// 🔴 Falla con: reconocer sólo `true`/`false` (marker.js acepta `1` para prender y cualquier otra cosa apaga).
test('T38 ValoresQueMarkerAcepta @story-4.10 @ac-7 @ac-8 @ac-10', () => {
  const r = revisar([
    ...cmd(`${MARKER} set-autonomous 0`), ...cmd(`${MARKER} set-autonomous off`), ...cmd(`${MARKER} set-autonomous true`),
    ...cmd(`${MARKER} set-flag workSignalStarted 1`), ...cmd(`${MARKER} set-flag atddBypass 1`), ...cmd(`${MARKER} set-flag adoMarkedActive false`),
  ]);
  assert.strictEqual(regla(r, 'RR-APAGO')[0].cuenta, 2);
  assert.deepStrictEqual(regla(r, 'RR-BANDERA').map((x) => x.categoria), ['workSignalStarted']);
  assert.deepStrictEqual(regla(r, 'RR-ESCAPE').map((x) => x.categoria), ['atddBypass']);
});

// T39 GitCommitN @story-4.10 @ac-10
// 🔴 Falla con: no leer la forma corta `-n` de `git commit` (o tomar la de `git push`, que es otra cosa).
test('T39 GitCommitN @story-4.10 @ac-10', () => {
  const r = revisar([...cmd('git commit -n -m x'), ...cmd('git commit -nm y'), ...cmd('git push -n origin main'), ...cmd('git push --no-verify')]);
  assert.deepStrictEqual(regla(r, 'RR-ESCAPE').map((x) => `${x.categoria}:${x.cuenta}`), ['--no-verify:3']);
});

// T40 FormasDelShell @story-4.10 @ac-7 @ac-10
// 🔴 Falla con: no partir en subshells, `&` de fondo o `$( … )`; con el operador `&` y las asignaciones con espacios de
//    PowerShell; con una comilla escapada (el texto de un echo se lee como comando); o abrir un heredoc dentro de
//    comillas o en un here-string (se tragan los comandos de después).
test('T40 FormasDelShell @story-4.10 @ac-7 @ac-10', () => {
  const r = revisar([
    ...cmd(`(cd /x && ${MARKER} set-autonomous false)`),
    ...cmd(`sleep 1 & ${MARKER} set-autonomous false`),
    ...cmd(`echo $(${MARKER} set-autonomous false)`),
    ...cmd('$N = "C:/x/node.exe"; & $N C:/u/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set-autonomous false', { name: 'PowerShell' }),
    ...cmd('$env:TYCON_SAFETY_OFF = "1"; git push', { name: 'PowerShell' }),
    ...cmd('env TYCON_FULL_SUITE=1 npm test'),
    ...cmd(`echo "dice \\"; ${MARKER} set-autonomous false; \\" y nada más"`),
    ...cmd(`grep -c "<<EOF" x.txt\n${MARKER} set-autonomous false`),
    ...cmd(`cat <<<"hola"\n${MARKER} set-autonomous false`),
    ...cmd(`if true; then ${MARKER} set-autonomous false; fi`),
  ]);
  assert.strictEqual(regla(r, 'RR-APAGO')[0].cuenta, 7, 'las siete que corren; el texto del echo con comillas escapadas no');
  assert.deepStrictEqual(regla(r, 'RR-ESCAPE').map((x) => x.categoria).sort(), ['TYCON_FULL_SUITE', 'TYCON_SAFETY_OFF']);
});

// T41 RrNodeSoloSiElErrorEsDelArnes @story-4.10 @ac-6
// 🔴 Falla con: contar la salida de un comando del proyecto que el arnés retransmite (run-check), o mirar sólo el primer
//    argumento (`node --no-warnings <guion>`, `node "$P/pipeline.js"`).
test('T41 RrNodeSoloSiElErrorEsDelArnes @story-4.10 @ac-6', () => {
  const r = revisar([
    ...cmd(`${MARKER} run-check build -- npm run build`, { texto: "check build: red\nsrc/a.ts:3\nSyntaxError: Unexpected token '.'" }),
    ...cmd('node --no-warnings /opt/acme/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js next', { texto: "/opt/acme/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js:9\nSyntaxError: Unexpected token '.'" }),
    ...cmd('P=/opt/acme/.claude/agent-skills/skills/tycon-pipeline/scripts; node "$P/pipeline.js" next', { texto: "Error: Cannot find module '/opt/acme/.claude/agent-skills/skills/tycon-pipeline/scripts/lib/steps.js'" }),
  ]);
  assert.deepStrictEqual(regla(r, 'RR-NODE').map((x) => `${x.categoria}:${x.cuenta}`).sort(), ['carga:1', 'node-viejo:1']);
});

// T42 EscapesDelRegistroSinSesion @story-4.10 @ac-10
// 🔴 Falla con: cruzar sólo por `sessionId` (PR_A_MANO y FULL_SUITE_RUN no lo traen: se pierden), o tomar los de fuera
//    de la ventana de la ejecución. Con conversación, la línea es de la ejecución que corrió su comando (T63).
test('T42 EscapesDelRegistroSinSesion @story-4.10 @ac-10', () => {
  const v = volcado({ sid: 's' });
  const registros = { cobertura: { fuentes: { bypass: { estado: 'medido' } } }, bypass: [
    { ts: `${HOY}T15:00:00.000Z`, type: 'PR_A_MANO', cwd: '/x', command: 'gh pr create' },
    { ts: `${HOY}T09:00:00.000Z`, type: 'FULL_SUITE_RUN', cwd: '/x', command: 'npm test' },
  ] };
  const r = RULES.revisar({ volcado: v, lineasHilo: [...cmd('gh pr create'), ...cmd('npm test')], registros });
  assert.deepStrictEqual(regla(r, 'RR-ESCAPE').map((x) => x.categoria), ['PR_A_MANO']);
});

// T43 NoPudeNoArchivaSola @story-4.10 @ac-2 @ac-19
// 🔴 Falla con: archivar como «resuelta sola» una ficha cuya ejecución hoy no se pudo revisar entera (sin conversación).
test('T43 NoPudeNoArchivaSola @story-4.10 @ac-2 @ac-19', async () => {
  const base = `1.1-${HOY}T1519`;
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base, volcado: volcado({ sid: SID(1) }), hilo: cmd(`${MARKER} set-autonomous false`) }] } });
  const op = ops();
  await correr(mb, op, { today: '2026-10-21' });
  fs.unlinkSync(path.join(mb, 'acme-0000aaaa', `${base}.hilo.jsonl.gz`));
  await correr(mb, op);
  assert.strictEqual(fichas(op).length, 1, 'sigue pendiente');
  assert.strictEqual(fichas(op, 'archived').length, 0);
});

// T44 EntradasRarasNoRompen @story-4.10 @ac-11 @ac-13 @ac-22
// 🔴 Falla con: un volcado `null` o una ficha previa editada a mano que rompen la pasada; una ficha ilegible que se
//    pierde (sale otra con el mismo id); `archivada` con texto libre; o un motivo de la bajada copiado tal cual.
test('T44 EntradasRarasNoRompen @story-4.10 @ac-11 @ac-13 @ac-22', async () => {
  const v = volcado({ sid: SID(2), pendientes: [7] });
  v.archivedAt = 'ZZTEXTO-libre';
  const mb = buzon({ 'acme-0000aaaa': { corridas: [
    { base: `1.0-${HOY}T1000`, volcado: 'null' },
    { base: `1.1-${HOY}T1519`, volcado: v, hilo: [] },
  ] } });
  const op = ops();
  const pend = path.join(op, 'inbox', 'runs-review', 'pending');
  fs.mkdirSync(pend, { recursive: true });
  fs.writeFileSync(path.join(pend, 'rota.yaml'), 'id: {esto no es json\nreglas: "no es una lista"\n');
  const r = await correr(mb, op);
  assert.strictEqual(r.codigo, 1);
  const l = lastRun(op);
  assert.ok(l.ilegibles >= 2, 'el volcado null y la ficha rota');
  const buenas = fichas(op).filter((f) => f.fuente);
  assert.strictEqual(buenas.length, 1);
  assert.doesNotMatch(JSON.stringify(buenas[0]), /ZZTEXTO/, 'la hora de archivado con texto libre no entra');
  assert.ok(fs.existsSync(path.join(pend, 'rota.yaml')), 'la ilegible queda quieta');
  const r2 = await RR.run({ mailbox: mb, ops: op, today: HOY, bajar: async () => ({ codigo: 1, res: { completo: false, estado: 'sin_red', motivo: '/opt/ZZTEXTO-ruta/x: ECONNRESET' } }) });
  assert.strictEqual(r2.codigo, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(op, 'inbox', 'runs-review', 'last-run.json'), 'utf8'), /ZZTEXTO/);
});

// T46 RegistrosYCarpetasIlegiblesSeCuentan @story-4.10 @ac-13 @ac-22
// 🔴 Falla con: tomar un bypass.log.gz roto como «sin escapes», o saltear una carpeta de máquina que no se puede leer.
test('T46 RegistrosYCarpetasIlegiblesSeCuentan @story-4.10 @ac-13 @ac-22', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1) }), hilo: [] }], registros: { bypass: [] } } });
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', 'registros', 'bypass.log.gz'), 'esto no es gzip');
  const op = ops();
  const r = await correr(mb, op);
  assert.strictEqual(r.codigo, 1);
  assert.strictEqual(lastRun(op).ilegibles, 1);
  assert.strictEqual(lastRun(op).completo, false);
});

// T45 LaFichaSeEscribeEntera @story-4.10 @ac-2 @ac-13
// 🔴 Falla con: escribir la ficha directo, sin temporal y renombre (un corte la deja a medias).
test('T45 LaFichaSeEscribeEntera @story-4.10 @ac-2 @ac-13', async () => {
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1), pendientes: [7] }), hilo: [] }] } });
  const op = ops();
  await correr(mb, op);
  const dir = path.join(op, 'inbox', 'runs-review', 'pending');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => !f.endsWith('.yaml')), [], 'sin temporales sueltos');
  const orig = fs.renameSync;
  let renombres = 0;
  fs.renameSync = (a, b) => { renombres += 1; return orig(a, b); };
  try { await correr(mb, op); } finally { fs.renameSync = orig; }
  assert.ok(renombres >= 2, 'la ficha y last-run.json se escriben a un temporal y se renombran');
});

// T47 CausasConocidasYNuevas @story-4.10 @ac-13
// 🔴 Falla con: tomar como conocida una causa que sólo trae una ficha escrita hoy (todo lo nuevo se pierde si la pasada
//    corre dos veces), mirar sólo `pending/` (lo ya decidido sale como nuevo cada noche), contar reglas en vez de
//    ejecuciones, o dejar las causas de ayer en una pasada cortada.
test('T47 CausasConocidasYNuevas @story-4.10 @ac-13', async () => {
  const maq = 'acme-0000aaaa';
  const A = `1.1-${HOY}T1519`;
  const mb = buzon({ [maq]: { corridas: [{ base: A, volcado: volcado({ sid: SID(1) }), hilo: cmd(`${MARKER} set-flag adoMarkedActive true`) }] } });
  const op = ops();
  // ayer: la ejecución A dejó su ficha con la bandera; lo ya decidido vive en archived/ y promoted/
  await correr(mb, op, { today: '2026-10-21' });
  assert.strictEqual(fichas(op).length, 1);
  const raiz = path.join(op, 'inbox', 'runs-review');
  const previa = (carpeta, id, reglas) => {
    fs.mkdirSync(path.join(raiz, carpeta), { recursive: true });
    fs.writeFileSync(path.join(raiz, carpeta, `2026-10-20-${maq}-${id}-abcdef.yaml`),
      [`id: ${JSON.stringify(id)}`, 'fecha: "2026-10-20"', `maquina: ${JSON.stringify(maq)}`, 'story: "9.9"', 'base: "9.9-2026-10-20T1000"',
        `reglas: ${JSON.stringify(reglas)}`, 'veredicto: "pendiente"', 'vista_por_ultima_vez: "2026-10-20"'].join('\n') + '\n');
  };
  const NV = ['--no', 'verify'].join('-');
  previa('archived', 'ffff000000000001', [{ regla: 'RR-ESCAPE', categoria: NV, cuenta: 1 }]);
  previa('promoted', 'ffff000000000002', [{ regla: 'RR-APAGO', categoria: null, cuenta: 1 }]);
  // hoy: A suma un cierre con pasos pendientes; B y C traen las causas ya vistas, B también el cierre
  const d = path.join(mb, maq);
  const conHilo = (base, v, lineas) => {
    fs.writeFileSync(path.join(d, `${base}.json`), JSON.stringify(v));
    fs.writeFileSync(path.join(d, `${base}.hilo.jsonl.gz`), zlib.gzipSync(lineas.map((l) => JSON.stringify(l)).join('\n') + '\n'));
  };
  conHilo(A, volcado({ sid: SID(1), pendientes: [7] }), cmd(`${MARKER} set-flag adoMarkedActive true`));
  conHilo(`1.2-${HOY}T1600`, volcado({ sid: SID(2), pendientes: [7] }), cmd(`git commit ${NV} -m x`));
  conHilo(`1.3-${HOY}T1700`, volcado({ sid: SID(3) }), cmd(`${MARKER} set-autonomous false`));
  const esperado = [
    { regla: 'RR-CIERRE', categoria: 'derivada', ejecuciones: 2, nueva: true },
    { regla: 'RR-APAGO', categoria: null, ejecuciones: 1, nueva: false },
    { regla: 'RR-BANDERA', categoria: 'adoMarkedActive', ejecuciones: 1, nueva: false },
    { regla: 'RR-ESCAPE', categoria: NV, ejecuciones: 1, nueva: false },
  ];
  await correr(mb, op);
  assert.deepStrictEqual(lastRun(op).causas, esperado);
  const vistas = JSON.parse(fs.readFileSync(path.join(raiz, 'causas-vistas.json'), 'utf8'));
  assert.strictEqual(vistas.pares['RR-CIERRE|derivada'], HOY, 'lo nuevo queda con la fecha de hoy');
  assert.strictEqual(vistas.pares['RR-BANDERA|adoMarkedActive'], '2026-10-21', 'una fecha escrita no cambia');
  // la misma pasada otra vez: la ficha de A (de ayer) ya trae el cierre, y sigue siendo nuevo
  await correr(mb, op);
  assert.deepStrictEqual(lastRun(op).causas, esperado, 'una pasada repetida no pierde lo nuevo');
  // una pasada cortada después de una entera no la pisa, y la siguiente entera sigue dando lo nuevo por nuevo
  const entera = fs.readFileSync(path.join(raiz, 'last-run.json'), 'utf8');
  const cortada = () => RR.run({ mailbox: mb, ops: op, today: HOY, bajar: async () => ({ codigo: 1, res: { completo: false, estado: 'sin_permiso' } }) });
  assert.strictEqual((await cortada()).codigo, 1);
  assert.strictEqual(fs.readFileSync(path.join(raiz, 'last-run.json'), 'utf8'), entera, 'la cortada no pisa la entera de hoy');
  await correr(mb, op);
  assert.deepStrictEqual(lastRun(op).causas, esperado, 'entera, cortada, entera: lo nuevo sigue nuevo');
  // un error antes de revisar ninguna ejecución tampoco pisa la entera de hoy
  const leerOrig = RUNS.leerRegistro;
  RUNS.leerRegistro = () => { const e = new Error('roto'); e.code = 'EIO'; throw e; };
  let rErr;
  try { rErr = await correr(mb, op); } finally { RUNS.leerRegistro = leerOrig; }
  assert.strictEqual(rErr.codigo, 1);
  assert.deepStrictEqual(lastRun(op).causas, esperado, 'un error antes de revisar no pisa la entera de hoy');
  assert.strictEqual(lastRun(op).completo, true);
  // sin una entera de hoy, la cortada deja causas vacías (no las de ayer)
  fs.writeFileSync(path.join(raiz, 'last-run.json'), JSON.stringify({ ...JSON.parse(entera), fecha: '2026-10-21' }));
  assert.strictEqual((await cortada()).codigo, 1);
  assert.deepStrictEqual(lastRun(op).causas, [], 'una pasada cortada no deja las causas de antes');
  // un last-run.json de hoy ilegible al empezar se cuenta
  fs.writeFileSync(path.join(raiz, 'last-run.json'), '{ roto');
  await correr(mb, op);
  assert.strictEqual(lastRun(op).completo, false);
  assert.ok(lastRun(op).ilegibles >= 1, 'el last-run.json roto cuenta en ilegibles');
});

// T49 UnaEjecucionEnDosCarpetas @story-4.10 @ac-1 @ac-13
// 🔴 Falla con: mirar dos veces la misma ejecución cuando está en la carpeta vieja de la máquina y en la de código (el
//    resumen de la mañana infla los números respecto de las fichas).
test('T49 UnaEjecucionEnDosCarpetas @story-4.10 @ac-1 @ac-13', async () => {
  const misma = { base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1), pendientes: [7] }), hilo: [] };
  const mb = buzon({
    acme: { corridas: [misma, { base: `1.2-${HOY}T1600`, volcado: volcado({ sid: SID(2), pendientes: [7] }), hilo: [] }] },
    'acme-b274e100': { corridas: [misma] },
  });
  const op = ops();
  await correr(mb, op);
  const a = lastRun(op);
  // `nuevas` son las fichas por causa que nacieron: una causa, dos ejecuciones
  assert.deepStrictEqual([a.miradas, a.con_fallas, a.nuevas], [2, 2, 1]);
  assert.strictEqual(fichas(op).length, 1);
  assert.strictEqual(fichas(op)[0].casos.length, 2);
  assert.deepStrictEqual(a.causas.map((c) => `${c.regla} ${c.categoria} ${c.ejecuciones}`), ['RR-CIERRE derivada 2']);
});

// T50 SinCerrarSoloSuSesion @story-4.10 @ac-10
// 🔴 Falla con: cerrar la ventana de una ejecución sin cerrar con la hora de la pasada (cada noche se queda con más
//    escapes ajenos, y el resultado depende del reloj).
test('T50 SinCerrarSoloSuSesion @story-4.10 @ac-10', () => {
  const registros = { bypass: [
    { ts: ts(5), type: 'ATDD_BYPASS', sessionId: 's', reason: 'x' },
    { ts: ts(60), type: 'FULL_SUITE_RUN' },
    { ts: '2026-11-20T10:00:00.000Z', type: 'PR_A_MANO' },
  ], cobertura: { fuentes: { bypass: { estado: 'medido' } } } };
  const una = (ahora) => {
    const orig = Date.now;
    Date.now = () => Date.parse(ahora);
    try { return regla(RULES.revisar({ volcado: volcado({ sid: 's', sinCerrar: true }), lineasHilo: [], registros }), 'RR-ESCAPE').map((x) => x.categoria).sort(); }
    finally { Date.now = orig; }
  };
  assert.deepStrictEqual(una('2026-10-23T03:00:00Z'), ['ATDD_BYPASS']);
  assert.deepStrictEqual(una('2026-12-01T03:00:00Z'), ['ATDD_BYPASS'], 'igual a otra hora');
});

// T51 ReapareceConCategoriaNueva @story-4.10 @ac-2 @story-4.11 @ac-8 (la categoría nueva es otra causa)
// 🔴 Falla con: comparar sólo el código de regla (una categoría nueva de la misma regla no abre su ficha).
test('T51 ReapareceConCategoriaNueva @story-4.10 @ac-2', async () => {
  const base = `1.1-${HOY}T1519`;
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base, volcado: volcado({ sid: SID(1) }), hilo: cmd(`${MARKER} set-flag adoMarkedActive true`) }] } });
  const op = ops();
  await correr(mb, op, { today: '2026-10-21' });
  const [f] = fichas(op);
  const arch = path.join(op, 'inbox', 'runs-review', 'archived');
  fs.mkdirSync(arch, { recursive: true });
  fs.renameSync(path.join(op, 'inbox', 'runs-review', 'pending', f.f), path.join(arch, f.f));
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', `${base}.hilo.jsonl.gz`),
    zlib.gzipSync(cmd(`${MARKER} set-flag workSignalStarted true`).map((l) => JSON.stringify(l)).join('\n') + '\n'));
  await correr(mb, op);
  assert.deepStrictEqual(fichas(op).map((x) => x.causa), ['RR-BANDERA:workSignalStarted'], 'la categoría nueva abre su ficha');
  assert.strictEqual(fichas(op, 'archived').length, 1, 'la decidida queda donde está');
});

// T48 CategoriasCerradas @story-4.10 @ac-12
// 🔴 Falla con: dejar pasar a la ficha (y de ahí a Telegram) un evento o un `type` con forma de ruta o de comando que
//    vino de la conversación o de bypass.log.
test('T48 CategoriasCerradas @story-4.10 @ac-12', () => {
  const r = revisar([hook('Inventado', 'zz'), hook('SessionStart', 'carga')]);
  assert.deepStrictEqual(regla(r, 'RR-HOOK').map((x) => x.categoria).sort(), ['SessionStart/carga', 'otro/otro']);
  const registros = { bypass: [
    { ts: ts(), type: '../acme/secret.sh --force', sessionId: 's', reason: 'x' },
    { ts: ts(), type: 'SIZE_FORCED_LIGHT', sessionId: 's', reason: 'x' },
  ], cobertura: { fuentes: { bypass: { estado: 'medido' } } } };
  const e = RULES.revisar({ volcado: volcado({ sid: 's' }), lineasHilo: [], registros });
  assert.deepStrictEqual(regla(e, 'RR-ESCAPE').map((x) => x.categoria).sort(), ['SIZE_FORCED_LIGHT', 'otro']);
});

// ── El detector sin ruido: lo esperable cuenta aparte ───────────────────────────────────────────────────────────
const medido = (bypass) => ({ bypass, cobertura: { fuentes: { bypass: { estado: 'medido' } } } });
const rv = ({ v = volcado({ sid: 's' }), hilo = [], bypass = null } = {}) => RULES.revisar({ volcado: v, lineasHilo: hilo, registros: bypass ? medido(bypass) : null });
const cats = (r, codigo) => regla(r, codigo).map((x) => `${x.categoria}:${x.cuenta}`).sort();

// T61 NoVerifyEnLaboratorio @story-4.10 @ac-29
// 🔴 Falla con: contar en GIT_NO_VERIFY el commit de un clon de laboratorio (46 de 52 líneas de la semana).
test('T61 NoVerifyEnLaboratorio @story-4.10 @ac-29', () => {
  const linea = (cwd) => ({ ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd, command: 'git commit --no-verify -m x', reason: 'r' });
  assert.deepStrictEqual(cats(rv({ bypass: [linea('/private/tmp/acme/tienda')] }), 'RR-ESCAPE'), ['GIT_NO_VERIFY/laboratorio:1']);
  assert.deepStrictEqual(cats(rv({ hilo: cmd('cd /tmp/ensayo && git commit --no-verify -m x') }), 'RR-ESCAPE'), ['GIT_NO_VERIFY/laboratorio:1']);
  assert.deepStrictEqual(cats(rv({ hilo: cmd('git -C /Users/dev/SourceCode/acme-lab commit -n -m x') }), 'RR-ESCAPE'), ['GIT_NO_VERIFY/laboratorio:1']);
  assert.deepStrictEqual(cats(rv({ bypass: [linea('/Users/dev/SourceCode/arnes')] }), 'RR-ESCAPE'), ['GIT_NO_VERIFY:1']);
  assert.ok(RULES.APARTE['RR-ESCAPE:GIT_NO_VERIFY/laboratorio'], 'aparte: el resumen no la suma a las nuevas');
  // sin certeza de que corrió en el laboratorio, es del repo real (el pase adversarial, objetivos 1-3)
  const real = (v) => volcado({ sid: 's' }) && Object.assign(volcado({ sid: 's' }), { marker: { ...volcado({ sid: 's' }).marker, repoPath: '/Users/dev/SourceCode/prod' } });
  const dudosos = [
    'cd /tmp/x/../../Users/dev/arnes && git commit --no-verify -m x',
    'git -C /tmp/../Users/dev/arnes commit --no-verify -m x',
    'git -C /tmp/lab -C /Users/dev/prod commit --no-verify -m x',
    'cd /tmp/lab && cd - && git commit -n -m x',
    'cd /tmp/lab && cd && git commit -n -m x',
    '(cd /tmp/lab && ls) && git commit --no-verify -m x',
    'cd /tmp/lab && pushd /Users/dev/prod && git commit --no-verify -m x',
    'cd /tmp/lab && sudo -u dev git -C /Users/dev/prod commit --no-verify -m x',
    'cd /tmp/lab && timeout 60 git commit --no-verify -m x',
    'cd /tmp/lab && git -C x commit --no-verify -m x',
    // el `cd` puede no valer para lo que sigue: segundo plano, tubería, «o si no»
    'cd /tmp/lab & git commit -n -m x',
    'cd /tmp/lab | git commit -n -m x',
    'cd /tmp/lab || git commit -n -m x',
    // git nombra otro repo
    'cd /tmp/lab && git --work-tree /Users/dev/prod commit -n -m x',
    'cd /tmp/lab && git --git-dir=/Users/dev/prod/.git commit -n -m x',
    'cd /tmp/lab && GIT_DIR=/Users/dev/prod/.git git commit -n -m x',
  ];
  for (const c of dudosos) assert.deepStrictEqual(cats(rv({ v: real(), hilo: cmd(c) }), 'RR-ESCAPE'), ['--no-verify:1'], c);
  assert.deepStrictEqual(cats(rv({ v: real(), hilo: cmd('cd /tmp/x/../../Users/dev/prod && TYCON_FULL_SUITE=1 npm test') }), 'RR-ESCAPE'), ['TYCON_FULL_SUITE:1']);
  assert.deepStrictEqual(cats(rv({ v: real(), bypass: [linea('/tmp/../Users/dev/arnes')] }), 'RR-ESCAPE'), ['GIT_NO_VERIFY:1'], 'el cwd con .. tampoco');
  // `commit -C HEAD` es la opción de commit (reusar el mensaje), no la carpeta; y `git log -n 3` no saltea hooks
  assert.deepStrictEqual(cats(rv({ v: real(), hilo: cmd('cd /tmp/lab && git commit -C HEAD --no-verify') }), 'RR-ESCAPE'), ['GIT_NO_VERIFY/laboratorio:1']);
  assert.deepStrictEqual(cats(rv({ v: real(), hilo: cmd('git log -n 3 --format=%s commit') }), 'RR-ESCAPE'), []);
  // una redirección (`2>&1`) no separa nada: la carpeta sigue siendo cierta
  assert.deepStrictEqual(cats(rv({ v: real(), hilo: cmd('cd /tmp/lab && git commit --no-verify -m x 2>&1') }), 'RR-ESCAPE'), ['GIT_NO_VERIFY/laboratorio:1']);
  // el `--no-verify` dentro de un `bash -c` corrió: la línea sin pareja cuenta
  assert.deepStrictEqual(cats(rv({ v: real(), hilo: null, bypass: [{ ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd: '/Users/dev/SourceCode/prod', command: 'bash -c "git commit --no-verify -m x"' }] }), 'RR-ESCAPE'), ['GIT_NO_VERIFY:1']);
  // emparejada y sin `cd`: manda el `cwd` exacto de la línea, no el repo de la ejecución
  const enLab = volcado({ sid: 's' }); enLab.marker.repoPath = '/private/tmp/acme/x';
  assert.deepStrictEqual(cats(rv({ v: enLab, hilo: cmd('git commit --no-verify -m x'), bypass: [{ ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd: '/Users/dev/SourceCode/prod', command: 'git commit --no-verify -m x' }] }), 'RR-ESCAPE'), ['GIT_NO_VERIFY:1']);
  // la línea cortada a 300 sin la opción a la vista: el corte se la llevó y cuenta
  const largo = `git commit -m "${'a'.repeat(370)}" --no-verify`;
  assert.deepStrictEqual(cats(rv({ v: real(), hilo: null, bypass: [{ ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd: '/Users/dev/SourceCode/prod', command: largo.slice(0, 300) }] }), 'RR-ESCAPE'), ['GIT_NO_VERIFY:1']);
});

// T62 NoVerifySoloEnTexto @story-4.10 @ac-29
// 🔴 Falla con: contar el texto de una historia o de un guion que NOMBRA la opción (4 de 52), en la conversación o en
//    la línea del registro.
test('T62 NoVerifySoloEnTexto @story-4.10 @ac-29', () => {
  const texto = "cat > specs/s.md <<'EOF'\ngit commit --no-verify\nEOF\ngrep -n -- '--no-verify' x.sh\npython3 - <<'PY'\nprint('git commit --no-verify')\nPY";
  assert.deepStrictEqual(cats(rv({ hilo: cmd(texto) }), 'RR-ESCAPE'), []);
  assert.deepStrictEqual(cats(rv({ hilo: cmd(`${texto}\ngit commit --no-verify -m x`) }), 'RR-ESCAPE'), ['--no-verify:1']);
  const linea = { ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd: '/Users/dev/SourceCode/arnes', command: texto };
  assert.deepStrictEqual(cats(rv({ bypass: [linea] }), 'RR-ESCAPE'), [], 'la línea cuyo comando no corre la opción no cuenta');
});

// T63 PrefijoDeMasYHechoUnaVez @story-4.10 @ac-30
// 🔴 Falla con: contar como escape un pedido que pasaba sin el prefijo (19 de 40), o el mismo hecho dos veces (67 fichas
//    de 39 pedidos), o una línea sin sesión en una ejecución que sólo la cubre por la hora.
test('T63 PrefijoDeMasYHechoUnaVez @story-4.10 @ac-30', () => {
  const P = 'TYCON_PR_BY_HAND=1 az repos pr';
  const comandos = [
    `${P} create --source-branch x --target-branch main --draft true --title t`,
    `${P} create --source-branch x --target-branch main --auto-complete true --squash false --title t`,
    `${P} update --id 5 --draft false --auto-complete true --squash false`,
    `${P} create --source-branch x --target-branch main --title t`,
  ];
  const lineas = comandos.map((command) => ({ ts: ts(), type: 'PR_A_MANO', command }));
  const r = rv({ hilo: comandos.flatMap((c) => cmd(c)), bypass: lineas });
  assert.deepStrictEqual(cats(r, 'RR-ESCAPE'), ['PR_A_MANO/sobra:3', 'PR_A_MANO:1']);
  const suite = 'TYCON_FULL_SUITE=1 npx vitest run';
  assert.deepStrictEqual(cats(rv({ hilo: cmd(suite), bypass: [{ ts: ts(), type: 'FULL_SUITE_RUN', command: suite }] }), 'RR-ESCAPE'), ['FULL_SUITE_RUN:1']);
  const otra = rv({ v: volcado({ sid: 'otra' }), hilo: cmd('ls'), bypass: [lineas[3]] });
  assert.deepStrictEqual(cats(otra, 'RR-ESCAPE'), [], 'la ejecución sin el comando en su conversación no la cuenta');
  // sin el registro, el prefijo de la conversación se juzga igual
  assert.deepStrictEqual(cats(rv({ hilo: comandos.flatMap((c) => cmd(c)) }), 'RR-ESCAPE'), ['PR_A_MANO/sobra:3', 'TYCON_PR_BY_HAND:1']);
  // una línea tapa el comando que la dejó, no los otros del mismo escape
  assert.deepStrictEqual(cats(rv({ hilo: comandos.flatMap((c) => cmd(c)), bypass: [lineas[3]] }), 'RR-ESCAPE'), ['PR_A_MANO/sobra:3', 'PR_A_MANO:1']);
  // cada pedido se juzga solo: junto a uno bueno, el malo cuenta; y no sobra ninguno si el comando le pasa código a un
  // intérprete, ni el de un destino que es una expansión de la terminal
  assert.deepStrictEqual(cats(rv({ hilo: cmd(`${comandos[1]} && ${comandos[3]}`) }), 'RR-ESCAPE'), ['PR_A_MANO/sobra:1', 'TYCON_PR_BY_HAND:1']);
  const malos = [
    `${comandos[1]} && ${P.replace(' az repos pr', '')} bash -c "az repos pr create --target-branch main --title t"`,
    `${P} create --source-branch x --target-branch "$DESTINO" --title t`,
  ];
  for (const c of malos) assert.deepStrictEqual(cats(rv({ hilo: cmd(c) }), 'RR-ESCAPE').filter((x) => x.startsWith('PR_A_MANO/sobra')), [], c);
  // la línea del pedido bueno tapa sólo ese pedido: el malo del mismo comando cuenta igual
  assert.deepStrictEqual(cats(rv({ hilo: cmd(`${comandos[1]} && ${comandos[3]}`), bypass: [lineas[1]] }), 'RR-ESCAPE'), ['PR_A_MANO/sobra:1', 'TYCON_PR_BY_HAND:1']);
  // uno a uno: una línea tapa una vez; una línea sin texto tapa una sola; la cortada (500) se empareja con su pedido
  const dos = [...cmd(comandos[1]), ...cmd(comandos[1])];
  // (la del registro y la de la conversación van en renglones distintos: la del registro dice si trae motivo)
  assert.deepStrictEqual(cats(rv({ hilo: dos, bypass: [lineas[1]] }), 'RR-ESCAPE'), ['PR_A_MANO/sobra:1', 'PR_A_MANO/sobra:1']);
  const suiteDos = [...cmd('TYCON_FULL_SUITE=1 npm test'), ...cmd('TYCON_FULL_SUITE=1 npm test')];
  assert.deepStrictEqual(cats(rv({ hilo: suiteDos, bypass: [{ ts: ts(), type: 'FULL_SUITE_RUN' }] }), 'RR-ESCAPE'), ['FULL_SUITE_RUN:1', 'TYCON_FULL_SUITE:1']);
  const largo = `${P} create --source-branch x --target-branch main --description "${'d'.repeat(600)}" --auto-complete true --squash false`;
  const cortada = { ts: ts(), type: 'PR_A_MANO', command: largo.slice(0, 500) };
  assert.deepStrictEqual(cats(rv({ hilo: cmd(largo), bypass: [cortada] }), 'RR-ESCAPE'), ['PR_A_MANO/sobra:1']);
  assert.deepStrictEqual(cats(rv({ hilo: null, bypass: [cortada] }), 'RR-ESCAPE'), ['PR_A_MANO:1'], 'sin la conversación, un texto cortado no da el pedido por bueno');
  // una línea tapa su comando igual, no uno parecido con más banderas
  const parecido = `${comandos[1]} --delete-source-branch true`;
  // una línea que es el comienzo de un pedido más largo se empareja con él (los frenos cortan el texto): cuenta una vez,
  // por el registro (trae `con_motivo`, la de la conversación no)
  const p = regla(rv({ hilo: cmd(parecido), bypass: [lineas[1]] }), 'RR-ESCAPE');
  assert.deepStrictEqual(p.map((x) => `${x.categoria}:${x.cuenta}:${x.con_motivo}`), ['PR_A_MANO/sobra:1:false']);
  // la decisión es la del freno de pedidos
  const AZ = require(path.join(ROOT, 'scripts', 'lib', 'az-pr.js'));
  assert.deepStrictEqual(comandos.map((c) => AZ.faltasDe(AZ.segmentos(c)[0]).faltas.length), [0, 0, 0, 2]);
});

// T64 CierreSinConstancia @story-4.10 @ac-31
// 🔴 Falla con: contar el paso viejo 9 o el 7 con el 8 hecho, o pedir la constancia del cierre antes de que existiera.
test('T64 CierreSinConstancia @story-4.10 @ac-31', () => {
  const cierre = (o) => cats(RULES.revisar({ volcado: volcado({ sid: 's', ...o }), lineasHilo: [], registros: null }), 'RR-CIERRE');
  assert.deepStrictEqual(cierre({ pendientes: [9] }), []);
  assert.deepStrictEqual(cierre({ pendientes: ['close-work-item'] }), [], 'el 9 por su nombre');
  assert.deepStrictEqual(cierre({ completados: [0, 1, 2, 3, 4, 5, 6, 8], pendientes: [7] }), []);
  assert.deepStrictEqual(cierre({ completados: [0, 1, 2, 3], pendientes: [4, 5, 6, 7, 8], archivedAt: '2026-10-20T10:00:00.000Z' }), ['derivada/arnes-anterior:1']);
  assert.deepStrictEqual(cierre({ completados: [0, 1, 2, 3], pendientes: [4, 5, 6, 7, 8], archivedAt: '2026-10-23T10:00:00.000Z' }), ['derivada:1']);
  assert.deepStrictEqual(cierre({ pendientes: [9], checks: { tests: 'red:exit=1' }, archivedAt: '2026-10-23T10:00:00.000Z' }), ['derivada:1']);
});

// T65 RelanzamientoEsDato @story-4.10 @ac-32
// 🔴 Falla con: contar como escape el relanzamiento del pase (12 en la semana; el pase corre igual).
test('T65 RelanzamientoEsDato @story-4.10 @ac-32', () => {
  const linea = { ts: ts(), kind: 'ADVERSARIAL_RELAUNCH', story: '1.1', prevRunId: 'codex-1', newRunId: 'claude-2' };
  assert.deepStrictEqual(cats(rv({ hilo: null, bypass: [linea] }), 'RR-ESCAPE'), ['ADVERSARIAL_RELAUNCH/dato:1']);
  assert.deepStrictEqual(cats(rv({ hilo: cmd('ls'), bypass: [linea] }), 'RR-ESCAPE'), ['ADVERSARIAL_RELAUNCH/dato:1'], 'una línea sin comando sigue la ventana de hora');
});

// T66 LivianaConMotivo @story-4.10 @ac-33
// 🔴 Falla con: contar como falla la corrida liviana que trae su motivo (las 17 de la semana).
test('T66 LivianaConMotivo @story-4.10 @ac-33', () => {
  const bypass = [
    { ts: ts(), sessionId: 's', kind: 'SIZE_FORCED_LIGHT_WITH_CODE', storyId: '1.1', reason: 'la coordinadora lo decidió' },
    { ts: ts(), sessionId: 's', kind: 'SIZE_FORCED_LIGHT_WITH_CODE', storyId: '1.1', reason: '' },
  ];
  assert.deepStrictEqual(cats(rv({ bypass }), 'RR-ESCAPE'), ['SIZE_FORCED_LIGHT_WITH_CODE/con-motivo:1', 'SIZE_FORCED_LIGHT_WITH_CODE:1']);
});

// T67 SuiteCompletaEnLaboratorioOTexto @story-4.10 @ac-34
// 🔴 Falla con: contar la suite completa de un laboratorio (21 de 27) o de un texto (6 de 27); la línea no trae `cwd`.
test('T67 SuiteCompletaEnLaboratorioOTexto @story-4.10 @ac-34', () => {
  const linea = (command) => ({ ts: ts(), type: 'FULL_SUITE_RUN', command });
  const enRepo = (repoPath) => { const v = volcado({ sid: 's' }); v.marker.repoPath = repoPath; return v; };
  const arnes = '/Users/dev/SourceCode/arnes';
  assert.deepStrictEqual(cats(rv({ v: enRepo(arnes), hilo: null, bypass: [linea('cd /tmp/probe.x && TYCON_FULL_SUITE=1 npm test')] }), 'RR-ESCAPE'), ['FULL_SUITE_RUN/laboratorio:1']);
  assert.deepStrictEqual(cats(rv({ v: enRepo('/private/tmp/acme/x'), hilo: null, bypass: [linea('TYCON_FULL_SUITE=1 npm test')] }), 'RR-ESCAPE'), ['FULL_SUITE_RUN/laboratorio:1']);
  assert.deepStrictEqual(cats(rv({ v: enRepo(arnes), hilo: null, bypass: [linea("cat > p.md <<'EOF'\nTYCON_FULL_SUITE=1 npm test\nEOF")] }), 'RR-ESCAPE'), []);
  assert.deepStrictEqual(cats(rv({ v: enRepo(arnes), hilo: null, bypass: [linea('TYCON_FULL_SUITE=1 npx vitest run')] }), 'RR-ESCAPE'), ['FULL_SUITE_RUN:1']);
  // en la conversación, sin el registro: el mismo juicio
  assert.deepStrictEqual(cats(rv({ v: enRepo(arnes), hilo: cmd('cd /tmp/probe.x && TYCON_FULL_SUITE=1 npm test') }), 'RR-ESCAPE'), ['FULL_SUITE_RUN/laboratorio:1']);
  assert.deepStrictEqual(cats(rv({ v: enRepo(arnes), hilo: cmd("cat > p.md <<'EOF'\nTYCON_FULL_SUITE=1 npm test\nEOF") }), 'RR-ESCAPE'), []);
  assert.deepStrictEqual(cats(rv({ v: enRepo(arnes), hilo: cmd('TYCON_FULL_SUITE=1 npx vitest run') }), 'RR-ESCAPE'), ['TYCON_FULL_SUITE:1']);
});

// T68 RrNodeEnObraYEnTexto @story-4.10 @ac-35
// 🔴 Falla con: contar como guion instalado que no carga la prueba de una story del arnés en obra (9 de la Mac mini), o
//    el texto de una historia.
test('T68 RrNodeEnObraYEnTexto @story-4.10 @ac-35', () => {
  const carga = (guion) => cmd(`node ${guion}`, { texto: `Error: Cannot find module '${guion}'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1)`, error: true });
  const lineas = [
    ...carga('/Users/dev/SourceCode/tycon-harness/scripts/tests/a.test.js'),
    ...carga('/Users/dev/SourceCode/tycon-harness-wt-x/skills/tycon-pipeline/scripts/tests/b.test.js'),
    ...cmd("cat > specs/s.md <<'EOF'\nnode /Users/dev/.tycon/harness/scripts/lib/x.js\nEOF", { texto: "Error: Cannot find module '/Users/dev/.tycon/harness/scripts/lib/x.js'\n at cjs/loader" }),
    ...carga('/Users/dev/.tycon/harness/scripts/lib/x.js'),
    ...carga('/Users/dev/.claude/agent-skills/skills/tycon-pipeline/scripts/y.js'),
    // de donde Claude Code y Codex cargan las skills, también con la barra de Windows
    ...carga('/Users/dev/.claude/skills/tycon-pipeline/scripts/z.js'),
    ...carga('C:\\Users\\dev\\.codex\\skills\\tycon-pipeline\\scripts\\w.js'),
  ];
  assert.deepStrictEqual(cats(revisar(lineas), 'RR-NODE'), ['carga:4', 'en-obra:2']);
});

// T69 ListaAparte @story-4.10 @ac-36
// 🔴 Falla con: que el resumen o el ciclo sumen como nueva una categoría aparte, o que una inventada pase por aparte.
test('T69 ListaAparte @story-4.10 @ac-36', () => {
  const esperadas = ['RR-ESCAPE:GIT_NO_VERIFY/laboratorio', 'RR-ESCAPE:PR_A_MANO/sobra', 'RR-CIERRE:derivada/arnes-anterior',
    'RR-ESCAPE:ADVERSARIAL_RELAUNCH/dato', 'RR-ESCAPE:SIZE_FORCED_LIGHT_WITH_CODE/con-motivo', 'RR-ESCAPE:FULL_SUITE_RUN/laboratorio', 'RR-NODE:en-obra'];
  assert.deepStrictEqual(Object.keys(RULES.APARTE).sort(), esperadas.sort());
  for (const k of esperadas) assert.ok(typeof RULES.APARTE[k] === 'string' && RULES.APARTE[k].length > 10, `${k} trae su motivo`);
  assert.strictEqual(RULES.APARTE['RR-ESCAPE:INVENTADA/x'], undefined);
  assert.ok(Object.isFrozen(RULES.APARTE), 'nadie la cambia al usarla');
});

// ── Qué es un escape: la misma definición que los frenos ────────────────────────────────────────────────────────
const NV = ['--no', 'verify'].join('-');
const enRepoReal = () => { const v = volcado({ sid: 's' }); v.marker.repoPath = '/Users/dev/SourceCode/prod'; return v; };

// T1 EscapeDetrasDeUnEnvoltorio @story-4.12 @ac-1
// 🔴 Falla con: tomar el envoltorio por el programa (el escape no se ve), o contar como escape una asignación que el
//    envoltorio no pasa (`nice X=1 cmd` corre `X=1` como programa).
test('T1 EscapeDetrasDeUnEnvoltorio @story-4.12 @ac-1', () => {
  const r = (hilo, bypass = null) => cats(rv({ v: enRepoReal(), hilo, bypass }), 'RR-ESCAPE');
  assert.deepStrictEqual(r(cmd('env -i PATH=/usr/bin TYCON_FULL_SUITE=1 npm test')), ['TYCON_FULL_SUITE:1']);
  assert.deepStrictEqual(r(cmd('sudo -E TYCON_SAFETY_OFF=1 rm -rf x')), ['TYCON_SAFETY_OFF:1']);
  assert.deepStrictEqual(r(cmd(`bash -c "git commit ${NV} -m a"`)), ['--no-verify:1']);
  assert.deepStrictEqual(r(cmd(`cd /tmp/lab && sh -c "git commit ${NV} -m a"`)), ['--no-verify:1'], 'envuelto: del repo real');
  assert.deepStrictEqual(r(cmd(`eval "git commit ${NV} -m a"`)), ['--no-verify:1']);
  // con su línea del registro: una vez, por el registro
  const bash = `bash -c "git commit ${NV} -m a"`;
  assert.deepStrictEqual(r(cmd(bash), [{ ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd: '/Users/dev/SourceCode/prod', command: bash }]), ['GIT_NO_VERIFY:1']);
  const env = 'env -i PATH=/usr/bin TYCON_FULL_SUITE=1 npm test';
  assert.deepStrictEqual(r(null, [{ ts: ts(), type: 'FULL_SUITE_RUN', command: env }]), ['FULL_SUITE_RUN:1']);
  // los que no pasan la asignación: no hay escape
  for (const c of ['nice TYCON_FULL_SUITE=1 npm test', 'timeout 60 TYCON_FULL_SUITE=1 npm test', 'nohup TYCON_SAFETY_OFF=1 rm x']) assert.deepStrictEqual(r(cmd(c)), [], c);
  // el pase adversarial: la asignación del segmento que llama al intérprete cuenta; el envoltorio por su ruta, con
  // opciones juntas o delante de otro envoltorio; el intérprete detrás de un envoltorio, anidado, por heredoc o `env -S`
  const cuentan = [
    ['TYCON_SAFETY_OFF=1 bash -c "rm x"', 'TYCON_SAFETY_OFF:1'],
    ['TYCON_FULL_SUITE=1 sh -c "npm test"', 'TYCON_FULL_SUITE:1'],
    ['sudo -iu bob TYCON_SAFETY_OFF=1 rm x', 'TYCON_SAFETY_OFF:1'],
    ['sudo -ubob TYCON_SAFETY_OFF=1 rm x', 'TYCON_SAFETY_OFF:1'],
    ['/usr/bin/env TYCON_FULL_SUITE=1 npm test', 'TYCON_FULL_SUITE:1'],
    ['/usr/bin/sudo -E TYCON_SAFETY_OFF=1 rm x', 'TYCON_SAFETY_OFF:1'],
    ['timeout 600 env TYCON_FULL_SUITE=1 npm test', 'TYCON_FULL_SUITE:1'],
    ['env -S "TYCON_FULL_SUITE=1 npm test"', 'TYCON_FULL_SUITE:1'],
    [`timeout 60 bash -c "git commit ${NV} -m a"`, '--no-verify:1'],
    [`nohup sh -c 'git commit ${NV} -m a'`, '--no-verify:1'],
    [`nice -n 5 bash -c 'git commit ${NV} -m a'`, '--no-verify:1'],
    [`bash -c "bash -c \\"bash -c 'git commit ${NV} -m a'\\""`, '--no-verify:1'],
    [`bash <<'EOS'\ngit commit ${NV} -m a\nEOS`, '--no-verify:1'],
    ['sh -s <<EOS\nTYCON_FULL_SUITE=1 npm test\nEOS', 'TYCON_FULL_SUITE:1'],
    // vuelta 2 de revisores: más formas de los envoltorios
    ['env - TYCON_FULL_SUITE=1 npm test', 'TYCON_FULL_SUITE:1'],
    ['env -P /usr/bin TYCON_FULL_SUITE=1 npm test', 'TYCON_FULL_SUITE:1'],
    ['doas TYCON_SAFETY_OFF=1 rm x', 'TYCON_SAFETY_OFF:1'],
    [`chrt -f 1 git commit ${NV} -m a`, '--no-verify:1'],
    [`taskset -c 0 git commit ${NV} -m a`, '--no-verify:1'],
    [`time -p git commit ${NV} -m a`, '--no-verify:1'],
    [`exec -a x git commit ${NV} -m a`, '--no-verify:1'],
    [`xargs -0 git commit ${NV} -m a`, '--no-verify:1'],
  ];
  for (const [c, esperada] of cuentan) assert.deepStrictEqual(r(cmd(c)), [esperada], c);
  // `env -S` seguido de un `bash -c`: cuentan los dos
  assert.deepStrictEqual(r(cmd(`env -S "TYCON_SAFETY_OFF=1" bash -c "git commit ${NV} -m a"`)), ['--no-verify:1', 'TYCON_SAFETY_OFF:1'].sort());
  // un heredoc a un shell metido en otro, o en una cadena, cuenta una vez
  assert.deepStrictEqual(r(cmd(`bash -c "echo; bash <<'E'\ngit commit ${NV} -m a\nE\n"`)), ['--no-verify:1']);
  assert.deepStrictEqual(r(cmd(`bash <<'A'\nbash <<'B'\ngit commit ${NV} -m a\nB\nA`)), ['--no-verify:1']);
  // la línea con la opción dada a un shell por un tubo o por `<<<` corrió: cuenta
  for (const c of [`echo "git commit ${NV} -m a" | bash`, `bash <<< "git commit ${NV} -m a"`]) {
    assert.deepStrictEqual(r(null, [{ ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd: '/Users/dev/SourceCode/prod', command: c }]), ['GIT_NO_VERIFY:1'], c);
  }
  const heredoc = `bash <<'EOS'\ngit commit ${NV} -m a\nEOS`;
  assert.deepStrictEqual(r(cmd(heredoc), [{ ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd: '/Users/dev/SourceCode/prod', command: heredoc }]), ['GIT_NO_VERIFY:1']);
  assert.deepStrictEqual(r(cmd(`cat <<'EOS'\ngit commit ${NV} -m a\nEOS`)), [], 'cat no corre su heredoc');
});

// T2 OpcionAbreviada @story-4.12 @ac-2
// 🔴 Falla con: reconocer sólo la opción entera (la abreviada saltea los hooks sin contarse), contar la ambigua, o
//    tomar el `-n` de push (--dry-run) o de log (la cantidad) por el de commit.
test('T2 OpcionAbreviada @story-4.12 @ac-2', () => {
  const r = (c) => cats(rv({ v: enRepoReal(), hilo: cmd(c) }), 'RR-ESCAPE');
  for (const c of [`git commit ${NV.slice(0, -1)} -m a`, `git commit ${NV.slice(0, -2)} -m a`, `git push ${NV.slice(0, -2)}`,
    'git commit -an', 'git commit -nm "x"', 'git commit -anm "x"']) assert.deepStrictEqual(r(c), ['--no-verify:1'], c);
  for (const c of [`git commit ${NV.slice(0, -3)} -m a`, `git merge ${NV.slice(0, -2)} x`, 'git commit --no-edit',
    'git push -n', 'git log -n 3']) assert.deepStrictEqual(r(c), [], c);
  // la `n` del valor pegado de una opción que lleva valor no es `-n` (el pase adversarial)
  for (const c of ['git commit -m"done"', 'git commit -mfinal', 'git commit -uno -m x', 'git commit -Fnotes', 'git commit -am"nada"']) assert.deepStrictEqual(r(c), [], c);
  // la línea del freno del commit con la abreviada en un `merge` (git la rechaza) no cuenta, como el detector
  const linea = { ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd: '/Users/dev/SourceCode/prod', command: `git merge ${NV.slice(0, -2)} x` };
  assert.deepStrictEqual(cats(rv({ v: enRepoReal(), hilo: null, bypass: [linea] }), 'RR-ESCAPE'), []);
});

// T3 ValorYFormaDeLaVariable @story-4.12 @ac-3
// 🔴 Falla con: contar la asignación sin mirar su valor ni su forma: un `=0`, o un `export` que el freno de pedidos no
//    toma, quedaban como escape.
test('T3 ValorYFormaDeLaVariable @story-4.12 @ac-3', () => {
  const r = (c) => cats(rv({ v: enRepoReal(), hilo: cmd(c) }), 'RR-ESCAPE');
  for (const c of ['TYCON_PR_BY_HAND=0 az repos pr create --target-branch dev --title t', 'TYCON_FULL_SUITE=0 npm test',
    'export TYCON_PR_BY_HAND=1; az repos pr create --target-branch main --auto-complete true --squash false --title t',
    'TYCON_SAFETY_OFF=0 rm x', 'STOP_AUTONOMY=no ls']) assert.deepStrictEqual(r(c), [], c);
  assert.deepStrictEqual(r('TYCON_FULL_SUITE=1 npm test'), ['TYCON_FULL_SUITE:1']);
  assert.deepStrictEqual(r('TYCON_FULL_SUITE="1" npm test'), ['TYCON_FULL_SUITE:1']);
  assert.deepStrictEqual(r('TYCON_PR_BY_HAND=1 az repos pr create --target-branch main --title t'), ['TYCON_PR_BY_HAND:1']);
  // la línea del registro con un valor que no activa el escape no cuenta
  assert.deepStrictEqual(cats(rv({ v: enRepoReal(), hilo: null, bypass: [{ ts: ts(), type: 'FULL_SUITE_RUN', command: 'TYCON_FULL_SUITE=0 npm test' }] }), 'RR-ESCAPE'), []);
});

// T4 TextoFielDelPedido @story-4.12 @ac-4
// 🔴 Falla con: un texto del pedido que, partido de nuevo, muestra como banderas lo que era el texto de una opción
//    (sin la conversación, el pedido malo salía «sobra» y el bueno, falla).
test('T4 TextoFielDelPedido @story-4.12 @ac-4', () => {
  const AZ = require(path.join(ROOT, 'scripts', 'lib', 'az-pr.js'));
  const P = 'TYCON_PR_BY_HAND=1 az repos pr create --target-branch main';
  const casos = [
    [`${P} --title t --description 'x " --auto-complete true --squash false "'`, 'PR_A_MANO:1'],
    [`${P} --title fix\\ --auto-complete\\ true\\ --squash\\ false`, 'PR_A_MANO:1'],
    [`${P} --auto-complete true --squash false --description 'x " --squash true "'`, 'PR_A_MANO/sobra:1'],
    [`${P} --title 'a\\b' --auto-complete true --squash false`, 'PR_A_MANO/sobra:1'],
    // el pase adversarial: una ficha que expande con comillas adentro, y una libre que sigue entre comillas con un
    // salto de línea
    [`${P} --title "$T"'x"y' --auto-complete true --squash false`, 'PR_A_MANO/sobra:1'],
    [`${P} --title a"b\nc" --auto-complete true --squash false`, 'PR_A_MANO/sobra:1'],
    [`${P} --title "it's" --description '$HOME y \`x\`' --auto-complete true --squash false`, 'PR_A_MANO/sobra:1'],
  ];
  for (const [c, esperada] of casos) {
    const seg = AZ.segmentos(c)[0];
    const texto = AZ.textoDe(seg);
    const de = (s) => s.map((f) => [f.texto, f.esBandera]);
    assert.deepStrictEqual(de(AZ.segmentos(texto)[0]), de(seg), `el texto partido de nuevo da las mismas fichas: ${c}`);
    const linea = { ts: ts(), type: 'PR_A_MANO', command: texto };
    assert.deepStrictEqual(cats(rv({ hilo: null, bypass: [linea] }), 'RR-ESCAPE'), [esperada], `sin la conversación: ${c}`);
    assert.deepStrictEqual(cats(rv({ hilo: cmd(c), bypass: [linea] }), 'RR-ESCAPE'), [esperada], `con la conversación: ${c}`);
  }
});

// ── el control de las noches: resolver, reabrir y avisar que volvió ─────────────────────────────────────────────

/** Un buzón con una ejecución de la causa `RR-CIERRE:derivada`; `limpiar()` la deja sin fallas (la causa no aparece). */
function buzonDeUnaCausa() {
  const base = '1.1-2026-10-19T1519';
  const archivedAt = '2026-10-19T22:19:00.000Z';
  const mb = buzon({ 'acme-0000aaaa': { corridas: [{ base, volcado: volcado({ sid: SID(1), archivedAt, pendientes: [7] }), hilo: [] }] } });
  const limpiar = () => fs.writeFileSync(path.join(mb, 'acme-0000aaaa', `${base}.json`), JSON.stringify(volcado({ sid: SID(1), archivedAt })));
  return { mb, limpiar };
}
/** Una ejecución más de la misma causa, del día `dia` (el día sale del nombre; el archivado queda igual: es la causa). */
function otraEjecucion(mb, dia, n) {
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', `1.1-${dia}T1519.json`), JSON.stringify(volcado({ sid: SID(n), archivedAt: '2026-10-19T22:19:00.000Z', pendientes: [7] })));
}
const RRDIR = (op, c) => path.join(op, 'inbox', 'runs-review', c);
/** La única ficha de la causa, cambiada con `cambio` (un `undefined` borra la clave) y movida a `carpeta`. */
function moverFicha(op, cambio, carpeta) {
  const desde = ['pending', 'promoted', 'archived'].find((c) => fichas(op, c).length);
  const [x] = fichas(op, desde);
  const f = CYCLE.parsear(fs.readFileSync(path.join(RRDIR(op, desde), x.f), 'utf8'));
  fs.unlinkSync(path.join(RRDIR(op, desde), x.f));
  fs.mkdirSync(RRDIR(op, carpeta), { recursive: true });
  const g = { ...f, ...cambio };
  for (const [k, v] of Object.entries(cambio)) if (v === undefined) delete g[k];
  fs.writeFileSync(path.join(RRDIR(op, carpeta), x.f), CYCLE.serializar(g));
  return x.f;
}
const fichaEn = (op, carpeta, nombre) => CYCLE.parsear(fs.readFileSync(path.join(RRDIR(op, carpeta), nombre), 'utf8'));
/** operations.json con dónde van los pedidos. */
function opsConPedidos() {
  const op = ops();
  fs.writeFileSync(path.join(op, 'operations.json'), JSON.stringify({ version: 1, owners: { default: 'lead@ejemplo.test' },
    site: { url: 'https://sitio.ejemplo.test' }, work_items: { org: 'acme', project: 'Operaciones' } }));
  return op;
}
/** Una plataforma de mentira que guarda cada llamado. */
function plataformaFalsa(respuesta = () => ({ ok: true, value: { id: 901, changed: false, warnings: [] } })) {
  const llamados = [];
  return { llamados, run: async (op, args) => { llamados.push({ op, args }); return respuesta(op, args, llamados.length); } };
}

// T16 Resuelta_TrasNNoches @story-4.11 @ac-27
// 🔴 Falla con: no contar las noches sin la causa, contar dos veces la misma noche (un reintento), resolver antes de N,
//    dejar la resuelta en pending/, o sin `resuelta_el` (la vista común no la ve como resuelta ese día).
test('T16 Resuelta_TrasNNoches @story-4.11 @ac-27', async () => {
  const { mb, limpiar } = buzonDeUnaCausa();
  const op = ops();
  await correr(mb, op, { today: '2026-10-19' });
  const [nueva] = fichas(op);
  limpiar();
  await correr(mb, op, { today: '2026-10-20' });
  await correr(mb, op, { today: '2026-10-21' });
  await correr(mb, op, { today: '2026-10-21' });
  let [f] = fichas(op);
  assert.deepStrictEqual([f.noches_sin_aparecer, f.noche_contada, f.estado], [2, '2026-10-21', 'viva'], 'dos noches, el reintento no cuenta');
  await correr(mb, op, { today: '2026-10-22' });
  assert.strictEqual(fichas(op).length, 0, 'sale de pending/');
  [f] = fichas(op, 'archived');
  assert.strictEqual(f.f, nueva.f, 'la misma ficha');
  assert.deepStrictEqual([f.estado, f.resuelta_el, f.noches_sin_aparecer, f.noche_contada], ['resuelta', '2026-10-22', undefined, undefined]);
  const SOURCES = require(path.join(ROOT, 'scripts', 'nightly', 'findings', 'sources.js'));
  const v = SOURCES.comoFicha('ejecuciones', fs.readFileSync(path.join(RRDIR(op, 'archived'), f.f), 'utf8'));
  assert.deepStrictEqual([v.estado, v.resuelto, v.reaparecido], ['resuelta', '2026-10-22', null]);
  // con N de operations.json: 1 resuelve la primera noche medida
  const op1 = ops();
  const o = JSON.parse(fs.readFileSync(path.join(op1, 'operations.json'), 'utf8'));
  fs.writeFileSync(path.join(op1, 'operations.json'), JSON.stringify({ ...o, findings: { resolve_after_nights: 1 } }));
  const b = buzonDeUnaCausa();
  await correr(b.mb, op1, { today: '2026-10-19' });
  b.limpiar();
  await correr(b.mb, op1, { today: '2026-10-20' });
  assert.deepStrictEqual(fichas(op1, 'archived').map((x) => x.resuelta_el), ['2026-10-20']);
});

// T17 Reaparecio_Reabre @story-4.11 @ac-28
// 🔴 Falla con: dejar callada en archived/ una resuelta o una ignorada que vuelve, perder el veredicto de antes o las
//    apariciones, conservar la propuesta vieja, o reabrir una migrada.
test('T17 Reaparecio_Reabre @story-4.11 @ac-28', async () => {
  for (const [antes, cambio] of [['arreglo', { estado: 'resuelta', resuelta_el: '2026-10-20', veredicto: 'arreglo' }], ['ignorada', { veredicto: 'ignorada' }]]) {
    const { mb } = buzonDeUnaCausa();
    const op = ops();
    await correr(mb, op, { today: '2026-10-19' });
    const nombre = moverFicha(op, { ...cambio, apariciones: 4, propuesta: { accion: 'arreglar', razon: 'la de antes' } }, 'archived');
    await correr(mb, op);
    assert.strictEqual(fichas(op, 'archived').length, 0, `${antes}: sale de archived/`);
    const f = fichaEn(op, 'pending', nombre);
    assert.deepStrictEqual([f.estado, f.veredicto, f.veredicto_anterior, f.reaparecio_el, f.apariciones, f.propuesta, f.resuelta_el],
      ['reaparecio', 'pendiente', antes, HOY, 5, null, undefined], antes);
  }
  // una migrada no se reabre
  const { mb } = buzonDeUnaCausa();
  const op = ops();
  await correr(mb, op, { today: '2026-10-19' });
  const nombre = moverFicha(op, { veredicto: 'migrada' }, 'archived');
  const antes = fs.readFileSync(path.join(RRDIR(op, 'archived'), nombre), 'utf8');
  await correr(mb, op);
  assert.strictEqual(fs.readFileSync(path.join(RRDIR(op, 'archived'), nombre), 'utf8'), antes, 'la migrada queda como está');
});

// T20 NocheQueNoCorrio_NoAvanza @story-4.11 @ac-36
// 🔴 Falla con: contar días de calendario en vez de noches medidas (la que no corrió sumaría), o contar una pasada
//    con archivos ilegibles (una noche a medias).
test('T20 NocheQueNoCorrio_NoAvanza @story-4.11 @ac-36', async () => {
  const { mb, limpiar } = buzonDeUnaCausa();
  const op = ops();
  await correr(mb, op, { today: '2026-10-19' });
  limpiar();
  await correr(mb, op, { today: '2026-10-20' });
  // la del 21 no corrió
  await correr(mb, op, { today: '2026-10-22' });
  let [f] = fichas(op);
  assert.deepStrictEqual([f.noches_sin_aparecer, f.estado], [2, 'viva'], 'dos noches medidas, no tres días');
  // una noche con un volcado ilegible no es entera: no cuenta
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', '1.9-2026-10-23T1000.json'), '{ roto');
  await correr(mb, op, { today: '2026-10-23' });
  [f] = fichas(op);
  assert.deepStrictEqual([f.noches_sin_aparecer, f.noche_contada], [2, '2026-10-22'], 'la noche a medias no avanza');
});

// T52 Aceptada_SigueViva_NoSeReproponeNiSeRepite @story-4.11 @ac-28
// 🔴 Falla con: sacar de promoted/ una aceptada que sigue apareciendo, borrarle la propuesta, o no sumar la aparición.
test('T52 Aceptada_SigueViva_NoSeReproponeNiSeRepite @story-4.11 @ac-28', async () => {
  const { mb } = buzonDeUnaCausa();
  const op = ops();
  await correr(mb, op, { today: '2026-10-19' });
  const propuesta = { accion: 'aceptar', razon: 'es esperable' };
  const nombre = moverFicha(op, { veredicto: 'aceptada', propuesta }, 'promoted');
  await correr(mb, op, { today: '2026-10-20' });
  const f = fichaEn(op, 'promoted', nombre);
  assert.deepStrictEqual([f.veredicto, f.estado, f.apariciones, f.propuesta, f.reaparecio_el], ['aceptada', 'viva', 2, propuesta, undefined]);
  assert.strictEqual(fichas(op).length, 0, 'no vuelve a pending/');
});

// T77 Ejecuciones_BuzonIncompleto_NoAvanza @story-4.11 @ac-36
// 🔴 Falla con: contar la noche con la bajada del buzón a medias (la causa pudo estar en lo que no bajó).
test('T77 Ejecuciones_BuzonIncompleto_NoAvanza @story-4.11 @ac-36', async () => {
  const { mb, limpiar } = buzonDeUnaCausa();
  const op = ops();
  await correr(mb, op, { today: '2026-10-19' });
  limpiar();
  await correr(mb, op, { today: '2026-10-20' });
  const r = await RR.run({ mailbox: mb, ops: op, today: '2026-10-21', bajar: async () => ({ codigo: 1, res: { completo: false, estado: 'parcial' } }) });
  assert.strictEqual(r.codigo, 1);
  const [f] = fichas(op);
  assert.deepStrictEqual([f.noches_sin_aparecer, f.noche_contada], [1, '2026-10-20']);
});

// T79 Reaparecio_ConPedido_AvisaQueVolvio @story-4.11 @ac-28
// 🔴 Falla con: no avisarle al pedido que la falla volvió, avisarle dos veces, cambiarle el estado, no reintentar con la
//    plataforma caída, o llamar por una que volvió sin pedido.
test('T79 Reaparecio_ConPedido_AvisaQueVolvio @story-4.11 @ac-28', async () => {
  const { mb } = buzonDeUnaCausa();
  const op = opsConPedidos();
  await correr(mb, op, { today: '2026-10-19' });
  const nombre = moverFicha(op, { estado: 'resuelta', resuelta_el: '2026-10-20', veredicto: 'arreglo', pedido: 901 }, 'archived');
  const caida = plataformaFalsa(() => ({ ok: false, reason: 'error', detail: 'se cayó' }));
  await correr(mb, op, { today: '2026-10-21', plataforma: caida.run });
  assert.deepStrictEqual(caida.llamados.map((x) => [x.op, x.args.id]), [['work-item.update', 901]]);
  let f = fichaEn(op, 'pending', nombre);
  assert.deepStrictEqual([f.estado, f.pedido, f.aviso_volvio_el], ['reaparecio', 901, undefined], 'caída: se intenta mañana');
  const p = plataformaFalsa();
  await correr(mb, op, { today: '2026-10-22', plataforma: p.run });
  await correr(mb, op, { today: '2026-10-22', plataforma: p.run });
  await correr(mb, op, { today: '2026-10-23', plataforma: p.run });
  assert.strictEqual(p.llamados.length, 1, 'un solo comentario');
  const { args } = p.llamados[0];
  assert.deepStrictEqual([args.id, args.org, args.project, 'state' in args, 'reopen' in args], [901, 'acme', 'Operaciones', false, false], 'sólo comenta');
  assert.match(args.comment, /volvió/);
  assert.match(args.comment, /RR-CIERRE:derivada/);
  f = fichaEn(op, 'pending', nombre);
  assert.strictEqual(f.aviso_volvio_el, '2026-10-22');
  // una que vuelve sin pedido no llama
  const b = buzonDeUnaCausa();
  const op2 = opsConPedidos();
  await correr(b.mb, op2, { today: '2026-10-19' });
  moverFicha(op2, { estado: 'resuelta', resuelta_el: '2026-10-20', veredicto: 'arreglo' }, 'archived');
  const q = plataformaFalsa();
  await correr(b.mb, op2, { today: '2026-10-21', plataforma: q.run });
  assert.strictEqual(q.llamados.filter((x) => x.op === 'work-item.update').length, 0);
});

// T86 Reaparecio_IgnoradaQueYaHabiaVuelto_SeReabre @story-4.11 @ac-28
// 🔴 Falla con: dejar callada en archived/ una ignorada que ya había vuelto una vez (guarda `reaparecio` porque ignorar
//    cambia el veredicto y no el estado): sin reabrirla, no suma la aparición y su pedido no se entera.
test('T86 Reaparecio_IgnoradaQueYaHabiaVuelto_SeReabre @story-4.11 @ac-28', async () => {
  const { mb } = buzonDeUnaCausa();
  const op = opsConPedidos();
  await correr(mb, op, { today: '2026-10-19' });
  const nombre = moverFicha(op, { estado: 'reaparecio', reaparecio_el: '2026-10-20', veredicto: 'ignorada', veredicto_anterior: 'arreglo',
    pedido: 901, aviso_volvio_el: '2026-10-20' }, 'archived');
  const p = plataformaFalsa();
  await correr(mb, op, { today: '2026-10-25', plataforma: p.run });
  assert.deepStrictEqual([fichas(op, 'archived').length, fichas(op, 'pending').length], [0, 1], 'vuelve a pending/');
  const f = fichaEn(op, 'pending', nombre);
  assert.deepStrictEqual([f.estado, f.veredicto, f.veredicto_anterior, f.reaparecio_el, f.ultima_vez], ['reaparecio', 'pendiente', 'ignorada', '2026-10-25', '2026-10-25']);
  assert.deepStrictEqual(p.llamados.filter((x) => x.op === 'work-item.update').map((x) => x.args.id), [901], 'y su pedido se entera otra vez');
});

// T96 Ejecuciones_PedidoCerradoFallaViva_Cableado @story-4.11 @ac-29
// 🔴 Falla con: que la noche de ejecuciones no lea el estado del pedido que creó, no le comente al cerrado, le mande un
//    estado, avise dos veces, o que el resumen de esa noche no lo diga.
test('T96 Ejecuciones_PedidoCerradoFallaViva_Cableado @story-4.11 @ac-29', async () => {
  const { mb } = buzonDeUnaCausa();
  const op = opsConPedidos();
  await correr(mb, op, { today: '2026-10-19' });
  const nombre = moverFicha(op, { veredicto: 'arreglo', pedido: 901 }, 'pending');
  const p = plataformaFalsa((o, args) => (o === 'work-item.read'
    ? { ok: true, value: { id: args.id, estado: 'Closed', cerrado: true } }
    : { ok: true, value: { id: args.id, changed: false, commented: true } }));
  otraEjecucion(mb, '2026-10-20', 2);
  await correr(mb, op, { today: '2026-10-20', plataforma: p.run });
  otraEjecucion(mb, '2026-10-21', 3);
  await correr(mb, op, { today: '2026-10-21', plataforma: p.run });
  assert.deepStrictEqual(p.llamados.map((x) => [x.op, x.args.id]), [['work-item.read', 901], ['work-item.update', 901]], 'un solo aviso');
  const { args } = p.llamados[1];
  assert.deepStrictEqual([args.org, args.project, 'state' in args, 'reopen' in args], ['acme', 'Operaciones', false, false], 'sólo comenta');
  assert.match(args.comment, /cerrado/);
  assert.strictEqual(fichaEn(op, 'pending', nombre).aviso_cerrado_el, '2026-10-20');
  const DS = require(path.join(ROOT, 'scripts', 'nightly', 'dependencies', 'daily-summary.js'));
  const lineas = DS.lineasFichasDelClon(op, '2026-10-20').filter((l) => l.startsWith('🔒'));
  assert.strictEqual(lineas.length, 1, lineas.join('\n'));
  assert.match(lineas[0], /^🔒 pedido cerrado con la falla viva en ejecuciones: .+ — avisado en el pedido 901$/);
});

// T96b Ejecuciones_PedidoCerrado_SoloConEjecucionNueva @story-4.11 @ac-29
// 🔴 Falla con: avisarle al pedido cerrado porque la ejecución vieja sigue en la ventana de días (la falla no volvió
//    desde el arreglo) y gastar así el único aviso, que después falta cuando la falla vuelve de verdad.
test('T96b Ejecuciones_PedidoCerrado_SoloConEjecucionNueva @story-4.11 @ac-29', async () => {
  const { mb } = buzonDeUnaCausa();
  const op = opsConPedidos();
  await correr(mb, op, { today: '2026-10-19' });
  const nombre = moverFicha(op, { veredicto: 'arreglo', pedido: 901 }, 'pending');
  const p = plataformaFalsa((o, args) => (o === 'work-item.read'
    ? { ok: true, value: { id: args.id, estado: 'Closed', cerrado: true } }
    : { ok: true, value: { id: args.id, changed: false, commented: true } }));
  for (const d of ['2026-10-20', '2026-10-21', '2026-10-22']) await correr(mb, op, { today: d, plataforma: p.run });
  assert.deepStrictEqual(p.llamados.filter((x) => x.op.startsWith('work-item.')).map((x) => x.op), [], 'sin ejecución nueva no se mira el pedido');
  assert.ok(!fichaEn(op, 'pending', nombre).aviso_cerrado_el);
  otraEjecucion(mb, '2026-10-23', 2);
  await correr(mb, op, { today: '2026-10-23', plataforma: p.run });
  assert.deepStrictEqual(p.llamados.map((x) => [x.op, x.args.id]), [['work-item.read', 901], ['work-item.update', 901]], 'la que volvió de verdad avisa');
  assert.strictEqual(fichaEn(op, 'pending', nombre).aviso_cerrado_el, '2026-10-23');
});

// ── Los escapes autorizados ──────────────────────────────────────────────────────────────────────────────────────

/** Una línea de frenos.jsonl con el escape autorizado por una persona en la sesión `s`, dentro de la ventana. */
const freno = (escape, extra = {}) => ({ ts: `${HOY}T15:00:00.000Z`, freno: 'safety-guard', regla: 'ESC-C1', veredicto: 'escape', sha256: null, via: 'persona', sesion: 's', escape, ...extra });
const conFrenos = (frenos, bypass = [], estado = 'medido') => ({ cobertura: { fuentes: { bypass: { estado: 'medido' }, frenos: { estado } } }, bypass, frenos });
const NO_DEEP = `TYCON_NO_DEEP_REVIEW=1 ${PIPE} next`;

// T47 Escape_AutorizadoNoCreaFicha @story-4.11 @ac-38
// 🔴 Falla con: no cruzar con frenos.jsonl (los cinco escapes siguen con ficha); aceptar la vía `ambiente` o
//    `sin-conversacion`, otra sesión, una hora fuera de la ventana, una línea sin nombre o con el de otro escape; autorizar
//    un escape fuera de la tabla (la suite completa); autorizar sin el registro medido; dejar que una línea tape dos
//    escapes; o tomar la línea de otra máquina con la misma sesión.
test('T47 Escape_AutorizadoNoCreaFicha @story-4.11 @ac-38', async () => {
  const conversacion = [...cmd(NO_DEEP), ...cmd(`${MARKER} story-skill-bypass --reason x`), ...cmd(`${MARKER} set-autonomous false`)];
  const bypass = [
    { ts: `${HOY}T15:00:00.000Z`, type: 'DOD_BYPASS_UI', sessionId: 's' },
    { ts: `${HOY}T15:00:00.000Z`, type: 'ADVERSARIAL_SKIP_FORZADO', sessionId: 's' },
  ];
  const autorizadas = [freno('TYCON_NO_DEEP_REVIEW'), freno('story-skill-bypass', { via: 'reenvio' }), freno('set-autonomous', { regla: 'ESC-C3' }),
    freno('DOD_BYPASS'), freno('no-deep-review')];
  // el salteo del pase visto en el comando y en bypass.log es un solo hecho: tres escapes y un apagado
  const sinFrenos = revisar(conversacion, { registros: conFrenos([], bypass) });
  assert.strictEqual(regla(sinFrenos, 'RR-ESCAPE').length, 3, 'sin autorización, los tres escapes tienen ficha');
  assert.strictEqual(sinFrenos.escapes_autorizados, 0);
  const ok = revisar(conversacion, { registros: conFrenos(autorizadas, bypass) });
  assert.deepStrictEqual(ok.reglas, [], 'cada escape con su línea: nada para la ficha');
  assert.strictEqual(ok.escapes_autorizados, 4);
  assert.deepStrictEqual(revisar(cmd(NO_DEEP), { registros: conFrenos([freno('no-deep-review')]) }).reglas, [], 'el nombre de la bandera también autoriza');
  // el Sí del dueño en la ventana de permiso también autoriza
  assert.deepStrictEqual(revisar(cmd(NO_DEEP), { registros: conFrenos([freno('TYCON_NO_DEEP_REVIEW', { via: 'ventana' })]) }).reglas, [], 'la vía ventana autoriza');
  // el salteo autorizado con la variable en línea: el freno deja UNA línea y marker.js una en bypass.log
  const salteo = cmd(`TYCON_NO_DEEP_REVIEW=1 node ${MARKER} mark-adversarial-skipped --files a.js`);
  const lineaSalteo = [{ ts: `${HOY}T15:00:01.000Z`, kind: 'ADVERSARIAL_SKIP_FORZADO', sessionId: 's' }];
  assert.deepStrictEqual(regla(revisar(salteo, { registros: conFrenos([], lineaSalteo) }), 'RR-ESCAPE').map((x) => x.cuenta), [1], 'sin autorización, una sola ficha');
  const salteoOk = revisar(salteo, { registros: conFrenos([freno('TYCON_NO_DEEP_REVIEW')], lineaSalteo) });
  assert.deepStrictEqual([salteoOk.reglas, salteoOk.escapes_autorizados], [[], 1]);
  // sin archivar, la ventana va desde el arranque
  const abierta = revisar(cmd(NO_DEEP), { volcado: volcado({ sid: 's', sinCerrar: true }), registros: conFrenos([freno('TYCON_NO_DEEP_REVIEW', { ts: `${HOY}T23:59:00.000Z` })]) });
  assert.deepStrictEqual(regla(abierta, 'RR-ESCAPE'), []);

  // las líneas que no autorizan: el escape sigue con su ficha
  const contrarias = {
    'vía ambiente': freno('TYCON_NO_DEEP_REVIEW', { via: 'ambiente' }),
    'vía sin-conversacion': freno('TYCON_NO_DEEP_REVIEW', { via: 'sin-conversacion' }),
    'otra sesión': freno('TYCON_NO_DEEP_REVIEW', { sesion: 'otra' }),
    'antes del arranque': freno('TYCON_NO_DEEP_REVIEW', { ts: `${HOY}T09:00:00.000Z` }),
    'después del archivo': freno('TYCON_NO_DEEP_REVIEW', { ts: `${HOY}T23:00:00.000Z` }),
    'sin nombre': freno(undefined),
    'el nombre de otro escape': freno('DOD_BYPASS'),
    'un paso, no un escape': freno('TYCON_NO_DEEP_REVIEW', { veredicto: 'paso' }),
  };
  for (const [caso, l] of Object.entries(contrarias)) {
    const r = revisar(cmd(NO_DEEP), { registros: conFrenos([l]) });
    assert.deepStrictEqual(regla(r, 'RR-ESCAPE').map((x) => `${x.categoria}:${x.cuenta}`), ['TYCON_NO_DEEP_REVIEW:1'], caso);
    assert.strictEqual(r.escapes_autorizados, 0, caso);
  }
  const suite = revisar(cmd('TYCON_FULL_SUITE=1 npm test'), { registros: conFrenos([freno('TYCON_FULL_SUITE')]) });
  assert.deepStrictEqual(regla(suite, 'RR-ESCAPE').map((x) => x.categoria), ['TYCON_FULL_SUITE'], 'la suite completa no está en la tabla');
  for (const registros of [conFrenos([freno('TYCON_NO_DEEP_REVIEW')], [], 'no_medido'), { cobertura: { fuentes: { bypass: { estado: 'medido' }, frenos: { estado: 'medido' } } }, bypass: [] }, null]) {
    const r = revisar(cmd(NO_DEEP), { registros });
    assert.strictEqual(regla(r, 'RR-ESCAPE').length, 1, 'sin el registro medido no se autoriza');
    assert.strictEqual(r.escapes_autorizados, null, 'sin el registro, la cuenta no se sabe');
  }

  // uno a uno: dos escapes y una línea dejan uno con ficha; el apagado conserva su `con_frase`
  const dos = revisar([...cmd(NO_DEEP), ...cmd(NO_DEEP), ...cmd(`${MARKER} set-autonomous false`), ...cmd(`${MARKER} set-autonomous off`)],
    { registros: conFrenos([freno('TYCON_NO_DEEP_REVIEW'), freno('set-autonomous')]) });
  assert.strictEqual(regla(dos, 'RR-ESCAPE')[0].cuenta, 1);
  assert.deepStrictEqual(regla(dos, 'RR-APAGO').map((x) => [x.cuenta, x.con_frase]), [[1, null]]);
  assert.strictEqual(dos.escapes_autorizados, 2);

  // otra máquina: la misma sesión en el registro de otra carpeta del buzón no autoriza
  const mb = buzon({
    'acme-0000aaaa': { corridas: [{ base: `1.1-${HOY}T1519`, volcado: volcado({ sid: SID(1) }), hilo: cmd(NO_DEEP) }], registros: { bypass: [], frenos: [] } },
    'acme-0000bbbb': { registros: { bypass: [], frenos: [freno('TYCON_NO_DEEP_REVIEW', { sesion: SID(1) })] } },
  });
  const op = ops();
  await correr(mb, op);
  assert.deepStrictEqual(fichas(op).map((f) => f.causa), ['RR-ESCAPE:TYCON_NO_DEEP_REVIEW'], 'la línea de la otra máquina no cuenta');
  assert.strictEqual(lastRun(op).escapes_autorizados, 0);

  // la misma ejecución en la carpeta vieja de la máquina y en la de código: cuentan los registros de las dos, si el
  // archivo de uniones del bajador dice que la vieja es de esa máquina
  const dobles = (hilo = cmd(NO_DEEP)) => ({ base: `1.8-${HOY}T1519`, volcado: volcado({ sid: SID(8) }), hilo });
  const UNIONES = {
    unida: JSON.stringify({ schema: 1, carpetas: { acme: { estado: 'unida', nueva: 'acme-0000aaaa', declarantes: 1, desde: null } } }),
    ninguna: JSON.stringify({ schema: 1, carpetas: {} }),
    rota: '{ esto no es json',
  };
  const dosCarpetas = async (vieja, nueva, { hilo, union = 'unida' } = {}) => {
    const o = ops();
    const mb = buzon({ acme: { corridas: [dobles(hilo)], registros: { bypass: [], frenos: vieja } }, 'acme-0000aaaa': { corridas: [dobles(hilo)], registros: { bypass: [], frenos: nueva } } });
    if (union) fs.writeFileSync(path.join(mb, '.carpetas-de-maquina.json'), UNIONES[union]);
    await correr(mb, o);
    return { fichas: fichas(o).map((f) => f.causa), cuenta: [lastRun(o).escapes_autorizados, lastRun(o).maquinas_sin_frenos] };
  };
  const L8 = freno('TYCON_NO_DEEP_REVIEW', { sesion: SID(8) });
  assert.deepStrictEqual(await dosCarpetas([], [L8]), { fichas: [], cuenta: [1, 0] }, 'la autorización de la carpeta de código cuenta');
  // las uniones medidas y sin esa carpeta: es otra máquina con la misma sesión, y no autoriza
  assert.deepStrictEqual(await dosCarpetas([], [L8], { union: 'ninguna' }), { fichas: ['RR-ESCAPE:TYCON_NO_DEEP_REVIEW'], cuenta: [0, 0] }, 'otra máquina: no se juntan');
  // sin poder leer las uniones no se sabe si son la misma máquina: no se juntan, y la cuenta queda sin medir
  for (const union of [false, 'rota']) {
    assert.deepStrictEqual(await dosCarpetas([], [L8], { union }), { fichas: ['RR-ESCAPE:TYCON_NO_DEEP_REVIEW'], cuenta: [null, 1] }, `uniones ${union || 'ausentes'}: no medido`);
  }
  // una carpeta con el registro roto pudo perder una autorización: la máquina queda sin medir aunque la otra mida
  assert.deepStrictEqual(await dosCarpetas(['esto no es json'], [L8]), { fichas: ['RR-ESCAPE:TYCON_NO_DEEP_REVIEW'], cuenta: [null, 1] }, 'una carpeta rota: no medido');
  assert.deepStrictEqual(await dosCarpetas(undefined, [L8]), { fichas: ['RR-ESCAPE:TYCON_NO_DEEP_REVIEW'], cuenta: [null, 1] }, 'una carpeta sin los frenos: no medido');
  // dos autorizaciones iguales en una carpeta son dos; la misma línea en las dos carpetas es una
  const dosSalteos = [...cmd(NO_DEEP), ...cmd(NO_DEEP)];
  assert.deepStrictEqual(await dosCarpetas([], [L8, L8], { hilo: dosSalteos }), { fichas: [], cuenta: [2, 0] }, 'dos iguales en una carpeta');
  assert.deepStrictEqual(await dosCarpetas([L8], [L8], { hilo: dosSalteos }), { fichas: ['RR-ESCAPE:TYCON_NO_DEEP_REVIEW'], cuenta: [1, 0] }, 'la misma en las dos carpetas');

  // sin la hora de arranque, o con una línea de la sesión sin hora legible, la ventana no se sabe: no medido
  const sinArranque = volcado({ sid: 's' });
  delete sinArranque.marker.startedAt;
  const cierreIlegible = volcado({ sid: 's' });
  cierreIlegible.archivedAt = 'mañana';
  for (const [caso, v, l] of [['sin arranque', sinArranque, freno('TYCON_NO_DEEP_REVIEW')], ['hora ilegible', undefined, freno('TYCON_NO_DEEP_REVIEW', { ts: 'ayer' })],
    ['cierre ilegible', cierreIlegible, freno('TYCON_NO_DEEP_REVIEW', { ts: `${HOY}T23:59:00.000Z` })]]) {
    const r = revisar(cmd(NO_DEEP), { ...(v ? { volcado: v } : {}), registros: conFrenos([l]) });
    assert.deepStrictEqual([regla(r, 'RR-ESCAPE').length, r.escapes_autorizados], [1, null], caso);
  }
});

// T48 Resumen_EscapesAutorizados_SinRegistroNoMedido @story-4.11 @ac-39
// 🔴 Falla con: no sumar las autorizaciones de cada máquina en last-run.json; dar 0 cuando una máquina con ejecuciones
//    miradas no tiene el registro (o contarla una vez por ejecución); contar una máquina sin ejecuciones miradas; o
//    copiar texto de una línea de frenos.jsonl a la ficha o a last-run.json.
test('T48 Resumen_EscapesAutorizados_SinRegistroNoMedido @story-4.11 @ac-39', async () => {
  const corrida = (k, hilo) => ({ base: `1.${k}-${HOY}T1519`, volcado: volcado({ sid: SID(k) }), hilo });
  const centinela = { regla: 'ZZCENTINELA-regla', relevo: 'ZZCENTINELA-relevo', freno: 'ZZCENTINELA-freno' };
  const def = {
    'acme-0000aaaa': { corridas: [corrida(1, cmd(NO_DEEP))], registros: { bypass: [], frenos: [freno('TYCON_NO_DEEP_REVIEW', { sesion: SID(1), ...centinela })] } },
    'acme-0000bbbb': { corridas: [corrida(2, cmd(`${MARKER} set-autonomous false`))], registros: { bypass: [],
      frenos: [freno('set-autonomous', { sesion: SID(2) }), freno('ZZCENTINELA-escape', { sesion: SID(2), ...centinela })] } },
    // sin ejecuciones miradas: no cuenta aunque no tenga el registro
    'acme-0000cccc': { corridas: [] },
  };
  const op = ops();
  await correr(buzon(def), op);
  const a = lastRun(op);
  assert.deepStrictEqual([a.escapes_autorizados, a.maquinas_sin_frenos], [2, 0]);
  assert.deepStrictEqual(fichas(op), [], 'las dos autorizadas: ninguna ficha');

  // una máquina con dos ejecuciones miradas y sin el registro: «no se sabe», contada una vez
  def['acme-0000dddd'] = { corridas: [corrida(3, cmd(NO_DEEP)), corrida(4, [])] };
  def['acme-0000bbbb'].corridas.push(corrida(5, cmd(NO_DEEP)));
  const op2 = ops();
  await correr(buzon(def), op2);
  const b = lastRun(op2);
  assert.deepStrictEqual([b.escapes_autorizados, b.maquinas_sin_frenos], [null, 1]);
  assert.deepStrictEqual(fichas(op2).map((f) => [f.causa, f.casos.length]), [['RR-ESCAPE:TYCON_NO_DEEP_REVIEW', 2]], 'la de la máquina sin registro y la que no tiene línea');

  // un registro con una línea rota es un registro a medias: «no se sabe», y su escape no se da por autorizado
  const op3 = ops();
  await correr(buzon({ 'acme-0000eeee': { corridas: [corrida(6, cmd(NO_DEEP))],
    registros: { bypass: [], frenos: [freno('TYCON_NO_DEEP_REVIEW', { sesion: SID(6) }), '{"ts":'] } } }), op3);
  const c = lastRun(op3);
  assert.deepStrictEqual([c.escapes_autorizados, c.maquinas_sin_frenos], [null, 1]);
  assert.deepStrictEqual(fichas(op3).map((f) => f.causa), ['RR-ESCAPE:TYCON_NO_DEEP_REVIEW']);

  // un registro que descomprimido pasa el tope de 64 MiB es ilegible: no se lee entero ni autoriza
  const dirGrande = buzon({ 'acme-0000ffff': { corridas: [corrida(7, cmd(NO_DEEP))], registros: { bypass: [], frenos: [] } } });
  const linea = JSON.stringify(freno('TYCON_NO_DEEP_REVIEW', { sesion: SID(7) })) + '\n';
  fs.writeFileSync(path.join(dirGrande, 'acme-0000ffff', 'registros', 'frenos.jsonl.gz'),
    zlib.gzipSync(Buffer.concat([Buffer.from(linea), Buffer.alloc(64 * 1024 * 1024 + 1, '\n')])));
  const op4 = ops();
  await correr(dirGrande, op4);
  const g = lastRun(op4);
  assert.deepStrictEqual([g.escapes_autorizados, g.maquinas_sin_frenos, g.ilegibles], [null, 1, 1]);
  assert.deepStrictEqual(fichas(op4).map((f) => f.causa), ['RR-ESCAPE:TYCON_NO_DEEP_REVIEW']);
  // el tope es de los registros: una conversación que pasa los 64 MiB se lee entera
  const dirHilo = buzon({ 'acme-0000ffff': { corridas: [corrida(9, [])], registros: { bypass: [], frenos: [] } } });
  const hilo = cmd(NO_DEEP).map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(path.join(dirHilo, 'acme-0000ffff', `1.9-${HOY}T1519.hilo.jsonl.gz`), zlib.gzipSync(Buffer.concat([Buffer.from(hilo), Buffer.alloc(64 * 1024 * 1024 + 1, '\n')])));
  const op5 = ops();
  await correr(dirHilo, op5);
  const gh = lastRun(op5);
  assert.deepStrictEqual([gh.sin_hilo, gh.ilegibles, gh.completo], [0, 0, true]);
  assert.deepStrictEqual(fichas(op5).map((f) => f.causa), ['RR-ESCAPE:TYCON_NO_DEEP_REVIEW']);
  for (const o of [op, op2]) {
    const d = path.join(o, 'inbox', 'runs-review');
    const todo = fs.readdirSync(d, { recursive: true }).filter((f) => /\.(ya?ml|json)$/.test(f)).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n');
    assert.doesNotMatch(todo, /ZZCENTINELA/, 'del registro de frenos sólo salen cuentas');
  }
});

// ── La clase de error de cada causa (Mantenimiento) ─────────────────────────────────────────────────────────────

// M1 ClaseDeError_ListaCerrada @mantenimiento
// 🔴 Falla con: una clase fuera de la lista, el texto del error en lugar de la clase, o «otro» para un código de salida.
test('M1 ClaseDeError_ListaCerrada @mantenimiento', () => {
  const c = (texto, extra = {}) => RULES.claseDeError({ texto, ...extra });
  assert.deepStrictEqual(c('fork: Resource temporarily unavailable'), { clase: 'sin-procesos' });
  assert.deepStrictEqual(c('cualquier cosa', { tipo: 'hook_cancelled' }), { clase: 'tiempo' });
  assert.deepStrictEqual(c('Error: Command timed out after 10s'), { clase: 'tiempo' });
  assert.deepStrictEqual(c('SyntaxError: Unexpected token < in JSON at position 0'), { clase: 'json-ilegible' });
  assert.deepStrictEqual(c("Error: Cannot find module '/opt/acme/x.js'"), { clase: 'archivo-no-encontrado' });
  assert.deepStrictEqual(c('ENOENT: no such file or directory'), { clase: 'archivo-no-encontrado' });
  assert.deepStrictEqual(c('x', { categoria: 'node-viejo' }), { clase: 'node-viejo' });
  assert.deepStrictEqual(c('EACCES: permission denied, open'), { clase: 'permiso' });
  assert.deepStrictEqual(c('connect ECONNREFUSED 127.0.0.1:443'), { clase: 'red' });
  assert.deepStrictEqual(c('algo raro', { exitCode: 2 }), { clase: 'salida', codigo: 2 });
  // «timeout» suelto en una traza no es «se pasó de tiempo»; sin Node, no encontró lo que necesitaba
  assert.deepStrictEqual(c("Error: Cannot find module 'x'\n    at listOnTimeout (node:internal/timers:573:17)"), { clase: 'archivo-no-encontrado' });
  assert.deepStrictEqual(c('env: node: No such file or directory', { exitCode: 127, categoria: 'node-ausente' }), { clase: 'archivo-no-encontrado' });
  assert.deepStrictEqual(c('/bin/sh: node: command not found', { exitCode: 127 }), { clase: 'archivo-no-encontrado' });
  assert.deepStrictEqual(c('algo raro'), { clase: 'otro' });
  assert.deepStrictEqual(c(undefined, { exitCode: 'x' }), { clase: 'otro' });
  for (const k of ['sin-procesos', 'tiempo', 'archivo-no-encontrado', 'json-ilegible', 'node-viejo', 'permiso', 'red', 'salida', 'otro']) assert.ok(CYCLE.CLASES_DE_ERROR.includes(k), k);
});

// M2 Reglas_TraenSusErrores @mantenimiento
// 🔴 Falla con: contar los errores de RR-HOOK o RR-NODE sin su clase, o mezclar las clases de dos causas.
test('M2 Reglas_TraenSusErrores @mantenimiento', () => {
  const lineas = [hook('UserPromptSubmit', 'carga', 'fork: resource temporarily unavailable'), hook('UserPromptSubmit', 'carga', 'fork: resource temporarily unavailable'),
    hook('UserPromptSubmit', 'carga', 'raro'), hook('Stop', 'otro', 'connect ECONNREFUSED')];
  const r = revisar(lineas);
  assert.deepStrictEqual(regla(r, 'RR-HOOK', 'UserPromptSubmit/carga')[0].errores, { 'sin-procesos': 2, salida: 1 });
  assert.deepStrictEqual(regla(r, 'RR-HOOK', 'UserPromptSubmit/carga')[0].codigo, 1);
  assert.deepStrictEqual(regla(r, 'RR-HOOK', 'Stop/otro')[0].errores, { red: 1 });
  const n = revisar(cmd(`node D:\\acme\\.claude\\skills\\tycon-pipeline\\scripts\\pipeline.js next`, { texto: "D:\\acme\\.claude\\skills\\tycon-pipeline\\scripts\\pipeline.js:1809\nSyntaxError: Unexpected token '.'" }));
  assert.deepStrictEqual(regla(n, 'RR-NODE')[0].errores, { 'node-viejo': 1 });
});

// M3 Ficha_ClaseMasComun_SoloCasosNuevos @mantenimiento
// 🔴 Falla con: sumar dos veces los errores de una ejecución ya vista, guardar el texto del error, o una ficha vieja
//    sin `hechos` que no los gana cuando la causa vuelve.
test('M3 Ficha_ClaseMasComun_SoloCasosNuevos @mantenimiento', async () => {
  const corrida = (k, hilo) => ({ base: `1.${k}-${HOY}T1519`, volcado: volcado({ sid: SID(k) }), hilo });
  const h = (t) => hook('UserPromptSubmit', 'carga', t);
  const mb = buzon({ 'acme-0000aaaa': { corridas: [corrida(1, [h('fork: resource temporarily unavailable ZZSECRETO'), h('fork: resource temporarily unavailable'), h('raro')])] } });
  const op = ops();
  await correr(mb, op, { today: '2026-10-21' });
  const f1 = fichas(op).find((x) => x.causa === 'RR-HOOK:UserPromptSubmit/carga');
  assert.deepStrictEqual(f1.hechos, { errores: { 'sin-procesos': 2, salida: 1 }, error_clase: 'sin-procesos', error_clase_veces: 2, error_veces: 3, error_codigo: 1 });
  // la misma ejecución otra noche no suma; una nueva sí
  await correr(mb, op);
  assert.deepStrictEqual(fichas(op).find((x) => x.causa === f1.causa).hechos.error_veces, 3);
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', `1.2-${HOY}T1519.json`), JSON.stringify(volcado({ sid: SID(2) })));
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', `1.2-${HOY}T1519.hilo.jsonl.gz`), zlib.gzipSync([h('raro'), h('raro'), h('raro')].map((l) => JSON.stringify(l)).join('\n')));
  await correr(mb, op);
  const f2 = fichas(op).find((x) => x.causa === f1.causa);
  assert.deepStrictEqual(f2.hechos, { errores: { 'sin-procesos': 2, salida: 4 }, error_clase: 'salida', error_clase_veces: 4, error_veces: 6, error_codigo: 1 });
  const d = path.join(op, 'inbox', 'runs-review');
  const todo = fs.readdirSync(d, { recursive: true }).filter((x) => /\.ya?ml$/.test(x)).map((x) => fs.readFileSync(path.join(d, x), 'utf8')).join('\n');
  assert.doesNotMatch(todo, /ZZSECRETO|temporarily/, 'la ficha guarda la clase, nunca el texto');
  // una ficha sin hechos (de antes) los gana con el caso nuevo
  const ruta = path.join(d, 'pending', f2.f);
  const { f: _a, reglas: _r, hechos: _h, ...vieja } = f2;
  fs.writeFileSync(ruta, CYCLE.serializar(vieja));
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', `1.3-${HOY}T1519.json`), JSON.stringify(volcado({ sid: SID(3) })));
  fs.writeFileSync(path.join(mb, 'acme-0000aaaa', `1.3-${HOY}T1519.hilo.jsonl.gz`), zlib.gzipSync([h('ECONNRESET')].map((l) => JSON.stringify(l)).join('\n')));
  await correr(mb, op);
  assert.deepStrictEqual(fichas(op).find((x) => x.causa === f1.causa).hechos, { errores: { red: 1 }, error_clase: 'red', error_clase_veces: 1, error_veces: 1 });
});
