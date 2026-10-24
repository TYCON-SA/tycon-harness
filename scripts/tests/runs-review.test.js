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

/** Un volcado: lo que escribe `marker.js clear`, con lo que piden las reglas. */
function volcado({ sid, archivedAt = `${HOY}T15:19:00.000Z`, completados = [0, 1, 2, 3, 4, 5, 6, 7, 8], pendientes = [], checks = { tests: 'green' }, cierre, autonomous = true, sinCerrar } = {}) {
  const marker = { storyId: '1.1', sessionId: sid, startedAt: `${HOY}T14:00:00.000Z`, stepsCompleted: completados, stepsPending: pendientes, checks, autonomous };
  if (cierre !== undefined) marker.cierre = cierre;
  const d = { archivedAt, marker, gates: [] };
  if (sinCerrar) { d.sinCerrar = true; d.archivedAt = null; }
  return d;
}

/** Un buzón: `{ <maquina>: { corridas: [{ base, volcado, hilo, hiloRoto }], registros: { cobertura, bypass } } }`. */
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
      const fuentes = { bypass: m.registros.bypass ? { estado: 'medido' } : { estado: 'no_medido', motivo: 'el registro no existe en esta máquina' } };
      fs.writeFileSync(path.join(r, 'cobertura.json'), JSON.stringify({ esquema: 1, fecha: HOY, fuentes }));
      if (m.registros.bypass) fs.writeFileSync(path.join(r, 'bypass.log.gz'), zlib.gzipSync(m.registros.bypass.map((l) => JSON.stringify(l)).join('\n') + '\n'));
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
    { ts: ts(), type: 'GIT_NO_VERIFY', sessionId: 's', cwd: '/x', command: 'git commit --no-verify', reason: 'la persona lo pidió' },
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
  await RR.run({ mailbox: mb, ops: op, today: HOY, bajar: async (o) => { destino = process.env.TYCON_MAILBOX_DIR; desde = o.hilosDesde; return { codigo: 0, res: { completo: true, estado: 'bajado' } }; } });
  // 🔴 Falla también con: bajar a otra carpeta que la que se lee (la pasada revisaría el espejo de ayer).
  assert.strictEqual(destino, mb, 'la bajada escribe donde la pasada lee');
  assert.strictEqual(desde, '2026-10-15', 'conversaciones desde hoy menos la ventana');
  const a = lastRun(op);
  assert.deepStrictEqual(Object.keys(a).sort(), ['causas', 'completo', 'con_fallas', 'fecha', 'hilos_sin_hooks', 'ilegibles', 'miradas', 'motivo', 'nuevas', 'sin_hilo']);
  assert.strictEqual(a.completo, true);
  assert.deepStrictEqual([a.miradas, a.con_fallas, a.nuevas], [2, 1, 1]);
  // la parcial, sin una pasada entera de hoy delante (con una, no se pisa: AC 13, T47)
  fs.unlinkSync(path.join(op, 'inbox', 'runs-review', 'last-run.json'));
  const r = await RR.run({ mailbox: mb, ops: op, today: HOY, bajar: async () => ({ codigo: 1, res: { completo: false, estado: 'parcial', motivo: '2 archivo(s) no se pudieron bajar' } }) });
  assert.strictEqual(r.codigo, 1);
  assert.strictEqual(lastRun(op).completo, false);
  assert.match(lastRun(op).motivo, /no fue entera \(parcial\)/, 'el estado de la bajada, sin copiar su texto');
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
  // una ficha por causa, cada una con la ejecución como caso
  assert.deepStrictEqual(fichas(op).map((f) => `${f.causa}:${f.casos.length}`).sort(),
    ['RR-APAGO:1', 'RR-BANDERA:adoMarkedActive:1', 'RR-BANDERA:workSignalStarted:1', 'RR-CIERRE:derivada:1', 'RR-NODE:node-viejo:1']);
  // la cuenta de cada regla y el registro de escapes no viajan en la ficha por causa: se miran en lo que dan las reglas
  const r = RULES.revisar({ volcado: v, lineasHilo: hilo, registros: { cobertura: null, bypass: null } });
  assert.deepStrictEqual(r.reglas.map((x) => `${x.regla}/${x.categoria}:${x.cuenta}`).sort(),
    ['RR-APAGO/null:1', 'RR-BANDERA/adoMarkedActive:1', 'RR-BANDERA/workSignalStarted:1', 'RR-CIERRE/derivada:1', 'RR-NODE/node-viejo:1']);
  assert.strictEqual(r.reglas.find((x) => x.regla === 'RR-APAGO').con_frase, null);
  assert.strictEqual(r.escapes_registro, 'no_medido');
});

// T35 FichaSinReglasHoySeArchivaSola @story-4.10 @ac-2 @story-4.11 @ac-8 (la causa no se archiva por una ejecución)
// 🔴 Falla con: archivar la ficha de una causa porque UNA de sus ejecuciones hoy ya no da la regla: resolver una causa
//    son N noches medidas sin aparecer, y eso todavía no lo hace la pasada.
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
//    de la ventana de la ejecución.
test('T42 EscapesDelRegistroSinSesion @story-4.10 @ac-10', () => {
  const v = volcado({ sid: 's' });
  const registros = { cobertura: { fuentes: { bypass: { estado: 'medido' } } }, bypass: [
    { ts: `${HOY}T15:00:00.000Z`, type: 'PR_A_MANO', cwd: '/x', command: 'gh pr create' },
    { ts: `${HOY}T09:00:00.000Z`, type: 'FULL_SUITE_RUN', cwd: '/x', command: 'npm test' },
  ] };
  const r = RULES.revisar({ volcado: v, lineasHilo: [], registros });
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
