'use strict';
/**
 * permission-relay.test.js — el permiso de una sesión de fondo le llega a la persona como cuadro, en la pestaña de la
 * coordinadora (scripts/hooks/permission-relay.js), con su renglón en la lista (signature-list.js), el click que lo
 * aprueba (owner-approvals.js `buscarPermiso`) y owner-wait (coordination.js). Todo en proceso, con una casa de juguete y
 * un reloj propio: nada lee ni escribe la casa real, y ninguna espera dura de verdad.
 * stable-data: la hora es fija (AHORA) y el reloj avanza sólo cuando el gancho duerme.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PR = require('../hooks/permission-relay.js');
const sl = require('../lib/signature-list.js');
const oa = require('../lib/owner-approvals.js');
const DS = require('../lib/delegated-signing.js');
const C = require('../tools/coordination.js');
const record = require('../hooks/owner-approval-record.js');

const AHORA = Date.parse('2026-11-22T15:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const COORD = 'ses-coord';
const BG = 'ses-bg';
const INICIO = 'Sun Nov 22 11:00:00 2026';
// el proceso de la herramienta de la coordinadora: el de esta prueba, que está vivo, con su archivo de sesión
const ARBOL = [{ pid: process.pid, ppid: 1, inicio: INICIO, comando: 'claude' }];
const SIEMPRE = () => ({ ok: true });
const MUERTO = 999999;

// la coordinadora confirmada pide approvals.relay_session en el perfil del árbol del arnés: se lee de uno de juguete
const ARNES = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-relay-arnes-'));
fs.writeFileSync(path.join(ARNES, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
process.on('exit', () => { try { fs.rmSync(ARNES, { recursive: true, force: true }); } catch { /* ya no está */ } });
const confirmadaSinClave = oa.coordinadoraConfirmada;
oa.coordinadoraConfirmada = (casa, o = {}) => confirmadaSinClave(casa, { arnes: ARNES, ...o });

const estado = (casa) => path.join(casa, '.claude', '.tycon-pipeline');

/** La sesión como la escribe Claude Code: `<pid>.json`, viva con el pid de la prueba. */
function sesion(casa, sid, { archivo = sid, pid = process.pid, ...extra } = {}) {
  fs.writeFileSync(path.join(casa, '.claude', 'sessions', `${archivo}.json`), JSON.stringify({ pid, sessionId: sid, name: sid, nameSource: 'user', status: 'idle', cwd: '/r', ...extra }));
}

function designar(casa, sid = COORD, { confirmada = true } = {}) {
  const d = { name: 'relay-designation', status: 'ok', ts: iso(AHORA - 3600000), sesion: sid, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  const lineas = [d, ...(confirmada ? [DS.confirmationRecord(d, iso(AHORA - 3500000))] : [])];
  fs.writeFileSync(path.join(estado(casa), 'gates.log'), `${lineas.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/**
 * El laboratorio: la coordinadora confirmada y viva (su archivo se llama como el pid, como lo escribe Claude Code), una
 * sesión de fondo trabada en un permiso y la lista encendida. `espera`: los minutos de la espera, en la máquina.
 */
function lab(t, { llave = 'on', espera = 1, designada = true, confirmada = true, bg = {} } = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-relay-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const casa = path.join(raiz, 'casa');
  fs.mkdirSync(path.join(casa, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(estado(casa), 'active'), { recursive: true });
  fs.writeFileSync(path.join(casa, '.claude', 'tycon.json'), JSON.stringify({ approvals: { signature_list: llave }, ...(espera ? { coordination: { permission_wait_minutes: espera } } : {}) }));
  sesion(casa, COORD, { archivo: String(process.pid), name: 'Coordinadora', kind: 'interactive', cwd: '/r/coord' });
  sesion(casa, BG, { name: 'V1-8180', kind: 'bg', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: AHORA, cwd: '/r/pro', ...bg });
  if (designada) designar(casa, COORD, { confirmada });
  return { raiz, casa, arnes: ARNES, env: {} };
}

// el evento con los campos que trae Claude Code: session_id, cwd, permission_mode, tool_name, tool_input y
// permission_suggestions, que el gancho nunca devuelve como regla
const evento = (o = {}) => ({
  session_id: BG, transcript_path: '/r/conv.jsonl', cwd: '/r/pro', permission_mode: 'default', hook_event_name: 'PermissionRequest',
  tool_name: 'Bash', tool_input: { command: 'touch v1-si.txt', description: 'Crea el archivo de la prueba' },
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'localSettings' }],
  ...o,
});

const crudas = (L) => { try { return JSON.parse(fs.readFileSync(sl.archivo(L.casa), 'utf8')); } catch { return []; } };
const delGancho = (L) => crudas(L).filter((f) => f.relay === true);

/**
 * Corre el gancho con un reloj propio: cada vez que duerme avanza `pollMs` y corre el paso siguiente de `pasos` (con la
 * hora y el renglón abierto). `{ r, reloj, vueltas }`.
 */
function correr(L, ev, o = {}) {
  const { pasos = [], arbol = ARBOL, plataforma = 'darwin', env = L.env } = o;
  // `validar` y `ownerWaitVivo` sin valor a propósito son los de verdad: no se cambian por los de la prueba
  const validar = 'validar' in o ? o.validar : SIEMPRE;
  const ownerWaitVivo = 'ownerWaitVivo' in o ? o.ownerWaitVivo : () => true;
  let reloj = AHORA;
  let vueltas = 0;
  const dormir = (ms) => {
    reloj += ms;
    vueltas += 1;
    if (vueltas > 2000) throw new Error('el gancho no termina');
    const paso = pasos.shift();
    if (paso) paso({ reloj, fila: delGancho(L)[0] });
  };
  const r = PR.decidir(ev, { casa: L.casa, arnes: L.arnes, env, plataforma, ahora: () => reloj, dormir, pollMs: 2000, ownerWaitVivo, arbol, validar });
  return { r, reloj, vueltas };
}

/** El click como lo anota el gancho del cuadro en la pestaña `en`, a la hora `ts`, contestando `pregunta`. */
function click(L, { pregunta, ts, en = COORD, respuesta = 'Sí, aprobar', herramienta = { pid: process.pid, inicio: INICIO }, ...extra }) {
  oa.anotar(L.casa, { tipo: 'click', sesion: en, ts: iso(ts), tool_use_id: 'toolu_01', pregunta, respuesta, herramienta, ...extra });
}
const pregunta = (fila) => sl.cuadroDePermiso(fila).pregunta;
const gates = (L) => fs.readFileSync(path.join(estado(L.casa), 'gates.log'), 'utf8').split('\n').filter((l) => l.includes('"permission-relay"')).map((l) => JSON.parse(l));
const usadas = (L) => { try { return fs.readdirSync(path.join(oa.carpeta(L.casa), 'usadas')); } catch { return []; } };

// ── AC 9: el renglón ───────────────────────────────────────────────────────────────────────────────────────────────

test('Permiso_DeFondo_DejaElRenglon (T9) @story-8.180 @ac-9', (t) => {
  const L = lab(t);
  let visto = null;
  const { r } = correr(L, evento(), { pasos: [({ fila }) => { visto = fila; }] });
  assert.ok(visto, 'mientras espera, el renglón está en la lista');
  assert.strictEqual(visto.tipo, 'permiso');
  assert.strictEqual(visto.herramienta, 'Bash');
  assert.strictEqual(visto.pedido, 'touch v1-si.txt', 'el pedido entero');
  assert.strictEqual(visto.carpeta, '/r/pro');
  assert.strictEqual(visto.sesion, BG);
  assert.strictEqual(visto.destino, BG);
  assert.strictEqual(visto.pid, process.pid, 'el proceso del gancho, para cerrarlo si muere');
  assert.strictEqual(visto.relay, true);
  // sin respuesta no decide: sale sin decidir al vencer, y saca su renglón
  assert.strictEqual(r.decision, null);
  assert.deepStrictEqual(delGancho(L), []);
});

// ── AC 10: el cuadro lo arma el guion ──────────────────────────────────────────────────────────────────────────────

test('Permiso_Cuadro_LoArmaElGuion (T10) @story-8.180 @ac-10', (t) => {
  const L = lab(t);
  const casos = [
    ['Bash', { command: 'for f in a b; do\n  echo   "$f"\ndone' }, 'for f in a b; do\n  echo   "$f"\ndone'],
    ['Edit', { file_path: '/r/pro/a.txt', old_string: 'uno  dos', new_string: 'uno\n  tres' }, 'Archivo: /r/pro/a.txt\nReemplaza:\n│ uno  dos\nPor:\n│ uno\n│   tres'],
    ['WebFetch', { url: 'https://example.com/x', prompt: 'qué dice' }, 'Dirección: https://example.com/x\nQué pregunta de la página:\n│ qué dice'],
  ];
  for (const [tool_name, tool_input, pedido] of casos) {
    let dado = null;
    let texto = null;
    correr(L, evento({ tool_name, tool_input }), { pasos: [() => {
      dado = sl.siguiente({ casa: L.casa, sesion: COORD, arnes: L.arnes, env: L.env, ahora: AHORA + 2000, arbol: [] });
      texto = C.ownerNextText(dado, COORD);
    }] });
    assert.strictEqual(dado.tipo, 'permiso', tool_name);
    assert.ok(dado.pregunta.endsWith(`Pedido:\n${pedido}`), `${tool_name}: el pedido entero, con sus saltos y espacios: ${JSON.stringify(dado.pregunta)}`);
    assert.match(dado.sello, new RegExp(`^permiso permiso-[0-9a-f]{8} · sesión ${BG} · código [0-9a-f]{8}$`));
    assert.ok(dado.pregunta.includes(`(${dado.sello}) Carpeta: /r/pro.`), 'el sello y la carpeta, antes del pedido');
    assert.deepStrictEqual(dado.opciones, ['Sí, aprobar', 'No']);
    assert.ok(texto.includes(`Pregunta:\n${dado.pregunta}\n`), 'owner-next la da tal cual, para mostrarla sin cambiarle una letra');
    assert.match(texto, /Con «Sí, aprobar», no corras nada: el gancho de V1-8180 ve el click/);
  }
  // un id por pedido: dos pedidos iguales llevan sellos distintos
  const ids = new Set();
  for (let i = 0; i < 2; i++) correr(L, evento(), { pasos: [({ fila }) => ids.add(fila.id)] });
  assert.strictEqual(ids.size, 2);
});

// ── AC 11: lo que no entra entero no se lleva ──────────────────────────────────────────────────────────────────────

test('Permiso_NoEntraEntero_VentanaNormal (T11) @story-8.180 @ac-11', (t) => {
  const L = lab(t);
  const casos = [
    ['más de 1500', `echo ${'x'.repeat(1500)}`, /1505 caracteres/],
    ['control', 'echo a\u0007b', /no se ven/],
    ['retorno de carro', 'echo a\rb', /no se ven/],
    ['bidireccional', 'echo \u202Eabc', /no se ven/],
    ['ancho cero', 'rm -rf ./a\u200Bb', /no se ven/],
  ];
  for (const [que, command, motivo] of casos) {
    const { r, vueltas } = correr(L, evento({ tool_input: { command } }));
    assert.strictEqual(r.decision, null, que);
    assert.match(r.motivo, motivo, que);
    assert.strictEqual(vueltas, 0, `${que}: sin esperar`);
    assert.deepStrictEqual(delGancho(L), [], `${que}: sin renglón`);
  }
  // datos que el cuadro no muestra (correr fuera de la caja de arena) tampoco se llevan
  const fuera = correr(L, evento({ tool_input: { command: 'ls', dangerouslyDisableSandbox: true } }));
  assert.match(fuera.r.motivo, /datos que el cuadro no muestra \(dangerouslyDisableSandbox\)/);
  // la sesión queda trabada con el motivo, en «Trabadas»
  const s = C.status({ home: L.casa, arnes: L.arnes, env: L.env, now: AHORA + 60000, noTranscripts: true, codexHome: path.join(L.raiz, 'sin-codex') });
  assert.match(C.statusText(s), /Trabadas: V1-8180: esperando un permiso.*no te llegó como cuadro: no se lleva al cuadro: el pedido trae datos que el cuadro no muestra/);
  assert.ok(gates(L).every((g) => g.status === 'no-se-lleva' && !JSON.stringify(g).includes('xxxx')), 'gates.log sin el texto del pedido');
  // con varias líneas sí se lleva, con sus saltos
  let fila = null;
  correr(L, evento({ tool_input: { command: 'echo uno\n\necho dos' } }), { pasos: [(p) => { fila = p.fila; }] });
  assert.strictEqual(fila.pedido, 'echo uno\n\necho dos');
});

// 🔴 Falla con: el permiso de una sesión de fondo que el gancho no lleva por el modo, la coordinadora o su owner-wait
// salía en silencio, sin renglón ni motivo: una noche trabada que después no se pudo reconstruir (fila 70, 22/11).
test('Permiso_DeFondoQueNoSeLleva_DejaRenglonYMotivo (fila 70)', (t) => {
  const casos = [
    ['en otro modo', { ev: { permission_mode: 'acceptEdits' } }, /modo acceptEdits/],
    ['sin coordinadora', { lab: { designada: false } }, /sin coordinadora confirmada y viva/],
    ['sin owner-wait', { correr: { ownerWaitVivo: () => false } }, /no tiene owner-wait corriendo/],
  ];
  for (const [que, o, motivo] of casos) {
    const L = lab(t, o.lab || {});
    const { r } = correr(L, evento(o.ev || {}), o.correr || {});
    assert.strictEqual(r.decision, null, que);
    assert.match(r.motivo, motivo, que);
    const g = gates(L);
    assert.strictEqual(g.length, 1, `${que}: un renglón en gates.log`);
    assert.strictEqual(g[0].status, 'no-se-lleva', que);
    assert.match(String(g[0].motivo), motivo, que);
    assert.ok(!JSON.stringify(g[0]).includes('touch v1-si'), `${que}: sin el texto del pedido`);
    const nota = JSON.parse(fs.readFileSync(path.join(estado(L.casa), 'coordination', 'permission-relay', `${BG}.json`), 'utf8'));
    assert.match(nota.motivo, motivo, `${que}: el motivo para «Trabadas»`);
  }
  // una sesión que no es de fondo no deja nada: el gancho no es para ella
  const L = lab(t);
  correr(L, evento({ session_id: COORD }));
  assert.deepStrictEqual(gates(L), [], 'sin renglón para una sesión con persona delante');
});

// ── AC 10 y 12: dos pedidos distintos nunca se ven igual ni comparten código ──────────────────────────────────────

test('Permiso_PedidoAmbiguo_NoSeConfunde (T10b) @story-8.180 @ac-10 @ac-12', (t) => {
  // los rótulos del armado escritos adentro de un campo: o no se lleva, o se ve distinto y tiene otro código
  const pares = [
    ['Edit', { file_path: '/tmp/a', old_string: 'a\nPor:\nb', new_string: 'c' }, { file_path: '/tmp/a', old_string: 'a', new_string: 'b\nPor:\nc' }],
    ['Write', { file_path: '/tmp/a\nContenido nuevo, entero:\nhi', content: 'x' }, { file_path: '/tmp/a', content: 'hi\nContenido nuevo, entero:\nx' }],
    ['NotebookEdit', { notebook_path: '/tmp/n.ipynb', cell_id: '(nueva)', new_source: 'x' }, { notebook_path: '/tmp/n.ipynb', new_source: 'x' }],
    ['WebFetch', { url: 'https://example.com/p\nQué pregunta de la página:\nq', prompt: 'r' }, { url: 'https://example.com/p', prompt: 'q\nQué pregunta de la página:\nr' }],
  ];
  for (const [herramienta, a, b] of pares) {
    const pa = PR.pedidoDe(herramienta, a);
    const pb = PR.pedidoDe(herramienta, b);
    const ambos = pa.pedido !== undefined && pb.pedido !== undefined;
    assert.ok(!ambos || pa.pedido !== pb.pedido, `${herramienta}: dos pedidos distintos se ven igual: ${JSON.stringify(pa.pedido)}`);
    assert.notStrictEqual(PR.huellaDe(herramienta, a), PR.huellaDe(herramienta, b), `${herramienta}: la huella sale de los campos, no del texto`);
  }
  // un campo de un renglón con un salto de línea no se lleva: inyectaría renglones falsos
  const deUnRenglon = [
    ['Edit', { file_path: '/r/a.txt\nReemplaza:\nx', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '/r/a.txt\nx', content: 'y' }],
    ['NotebookEdit', { notebook_path: '/r/n.ipynb\nx', new_source: 'y' }],
    ['NotebookEdit', { notebook_path: '/r/n.ipynb', cell_id: 'c1\nx', new_source: 'y' }],
    ['NotebookEdit', { notebook_path: '/r/n.ipynb', cell_id: '(nueva)', new_source: 'y' }],
    ['NotebookEdit', { notebook_path: '/r/n.ipynb', edit_mode: 'otro', new_source: 'y' }],
    ['WebFetch', { url: 'https://example.com\nx', prompt: 'y' }],
  ];
  for (const [herramienta, entrada] of deUnRenglon) assert.ok(PR.pedidoDe(herramienta, entrada).motivo, `${herramienta} ${JSON.stringify(entrada)}: se lleva`);
  // cada renglón del texto libre lleva su marca: un rótulo adentro del texto no se confunde con el del armado
  assert.strictEqual(PR.pedidoDe('Edit', { file_path: '/tmp/a', old_string: 'a\nPor:\nb', new_string: '' }).pedido, 'Archivo: /tmp/a\nReemplaza:\n│ a\n│ Por:\n│ b\nPor:\n│ ');
  // el código del cuadro es el de la huella de los campos del pedido que espera
  const L = lab(t);
  const entrada = { file_path: '/r/pro/a.txt', old_string: 'a', new_string: 'b' };
  let fila = null;
  correr(L, evento({ tool_name: 'Edit', tool_input: entrada }), { pasos: [(p) => { fila = p.fila; }] });
  assert.strictEqual(fila.huella, PR.huellaDe('Edit', entrada));
  assert.match(sl.cuadroDePermiso(fila).sello, new RegExp(`· código ${fila.huella.slice(0, 8)}$`));
});

// ── AC 11: lo que no se ve, o se ve en blanco, no se lleva ──────────────────────────────────────────────────────────

test('Permiso_CaracteresQueNoSeVen_NoSeLlevan (T11b) @story-8.180 @ac-11', (t) => {
  const raros = {
    'espacio duro': '\u00A0', 'espacio largo': '\u2003', 'espacio fino': '\u2009', 'espacio ideográfico': '\u3000', 'espacio angosto': '\u202F',
    'relleno hangul': '\u3164', 'relleno hangul inicial': '\u115F', 'relleno hangul de ancho medio': '\uFFA0', 'braille en blanco': '\u2800',
    'selector de variación': '\uFE0F', 'selector de variación suplementario': '\u{E0100}', 'unión de grafemas': '\u034F', 'acento suelto': 'e\u0301',
  };
  for (const [que, c] of Object.entries(raros)) {
    assert.match(String(PR.pedidoDe('Bash', { command: `rm -rf ./x${c}y` }).motivo), /no se ven/, `${que} en un comando`);
    assert.match(String(PR.pedidoDe('Edit', { file_path: '/r/a', old_string: `a${c}`, new_string: 'b' }).motivo), /no se ven/, `${que} en un texto libre`);
    assert.ok(PR.carpetaDe(`/r/a${c}b`).motivo, `${que} en la carpeta`);
  }
  // lo común se lleva: el espacio, el salto de línea, la ñ y los acentos escritos de una
  assert.ok(PR.pedidoDe('Bash', { command: 'echo "año más"\nls  -la' }).pedido);
  const L = lab(t);
  const { vueltas } = correr(L, evento({ tool_input: { command: 'ls\u3164' } }));
  assert.strictEqual(vueltas, 0);
  assert.deepStrictEqual(delGancho(L), []);
});

test('Permiso_CaracteresSinDibujo_NoSeLlevan (T11d) @story-8.180 @ac-11', () => {
  // se ven en blanco o como un cuadradito: uso privado, sin asignar, no-caracteres, sustitutos sueltos y dos puntuales
  const casos = [
    ['uso privado', '\u{E000}'],
    ['uso privado del plano 15', '\u{F0000}'],
    ['uso privado del plano 16', '\u{10FFFD}'],
    ['sin asignar', '\u{378}'],
    ['no-carácter FFFE', '\u{FFFE}'],
    ['no-carácter FFFF', '\u{FFFF}'],
    ['no-carácter de otro plano', '\u{1FFFE}'],
    ['sustituto suelto', '\u{D800}'],
    ['objeto reemplazado', '\u{FFFC}'],
    ['marca musical sin dibujo', '\u{1D159}'],
  ];
  for (const [que, c] of casos) {
    assert.match(String(PR.pedidoDe('Bash', { command: `ls ./x${c}y` }).motivo), /no se ven/, `${que} en un comando`);
    assert.match(String(PR.pedidoDe('WebFetch', { url: 'https://example.com', prompt: `qué${c}dice` }).motivo), /no se ven/, `${que} en un texto libre`);
    assert.ok(PR.carpetaDe(`/r/a${c}b`).motivo, `${que} en la carpeta`);
  }
});

// ── AC 11: «Trabadas» no dice que no llegó un pedido que sí llegó ───────────────────────────────────────────────────

test('Trabadas_MotivoViejo_NoSeMuestra (T11c) @story-8.180 @ac-11', (t) => {
  const L = lab(t);
  const dir = path.join(estado(L.casa), 'coordination', 'permission-relay');
  fs.mkdirSync(dir, { recursive: true });
  const nota = (desde, motivo = 'no se lleva al cuadro: A') => fs.writeFileSync(path.join(dir, `${BG}.json`), JSON.stringify({ at: iso(desde), desde: iso(desde), motivo }));
  // el de un pedido anterior, aunque sea de 30 s antes, no es el del permiso que espera ahora
  nota(AHORA - 30000);
  assert.strictEqual(C.relayNoteOf(L.casa, BG, AHORA), null);
  // sin la hora de la espera, no se sabe de cuál es: no se muestra
  assert.strictEqual(C.relayNoteOf(L.casa, BG, NaN), null);
  // el del pedido que espera, sí
  nota(AHORA + 1000, 'no se lleva al cuadro: B');
  assert.match(C.relayNoteOf(L.casa, BG, AHORA), /: B$/);
  // un pedido que sí llega como cuadro borra el motivo del anterior
  nota(AHORA - 3000);
  let mientras = null;
  correr(L, evento(), { pasos: [({ reloj, fila }) => {
    const s = C.status({ home: L.casa, arnes: L.arnes, env: L.env, now: reloj, noTranscripts: true, codexHome: path.join(L.raiz, 'sin-codex') });
    mientras = C.statusText(s);
    click(L, { pregunta: pregunta(fila), ts: reloj });
  }] });
  assert.ok(mientras && /Trabadas: V1-8180/.test(mientras), mientras);
  assert.doesNotMatch(mientras, /no te llegó como cuadro/);
});

// ── AC 12: el click «Sí, aprobar» ──────────────────────────────────────────────────────────────────────────────────

test('Permiso_ClickSi_AllowUnaVez (T12) @story-8.180 @ac-12', (t) => {
  const L = lab(t);
  let id = null;
  const { r } = correr(L, evento(), { pasos: [({ reloj, fila }) => { id = fila.id; click(L, { pregunta: pregunta(fila), ts: reloj }); }] });
  assert.strictEqual(r.decision, 'allow');
  const out = JSON.parse(PR.salida(r));
  assert.deepStrictEqual(out, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }, 'esa sola vez: sin reglas permanentes, aunque el evento traiga sugerencias');
  assert.strictEqual(usadas(L).length, 1, 'el click quedó gastado');
  assert.deepStrictEqual(delGancho(L), [], 'el renglón se cierra');
  assert.ok(gates(L).some((g) => g.status === 'aprobado' && g.id === id && g.espera_s === 2 && g.codigo && !('pedido' in g)));

  // otra huella (el click de otro pedido), otra sesión, otra respuesta: nada
  const otra = lab(t);
  const casos = [
    ({ reloj, fila }) => click(otra, { pregunta: pregunta({ ...fila, pedido: 'touch otro.txt' }), ts: reloj }),
    ({ reloj, fila }) => click(otra, { pregunta: pregunta(fila), ts: reloj, en: 'ses-otra' }),
    ({ reloj, fila }) => click(otra, { pregunta: pregunta(fila), ts: reloj, respuesta: 'No' }),
  ];
  for (const paso of casos) assert.strictEqual(correr(otra, evento(), { pasos: [paso] }).r.decision, null);
  assert.deepStrictEqual(usadas(otra), []);

  // el mismo pedido después: otro id, y el click gastado no lo aprueba
  const viejo = fs.readFileSync(path.join(oa.carpeta(L.casa), `${COORD}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l))[0];
  let nuevo = null;
  const otraVez = correr(L, evento(), { pasos: [({ reloj, fila }) => { nuevo = fila; click(L, { pregunta: viejo.pregunta, ts: reloj }); }] });
  assert.notStrictEqual(nuevo.id, id, 'un pedido idéntico lleva otro id');
  assert.strictEqual(otraVez.r.decision, null, 'pide otro click');
});

// ── AC 10 y 12 con la lista de hoy: el dueño ausente, un cuadro con varias preguntas y el permiso de otra sesión ─────

test('Permiso_DuenoAusente_VariasPreguntas_OtraSesion (T12b) @story-8.180 @ac-10 @ac-12', (t) => {
  const L = lab(t);
  // el permiso es siempre de otra sesión: a la coordinadora le llega como cuadro, no como «se da en su pestaña»
  let dado = null;
  let ausente = null;
  correr(L, evento(), { pasos: [() => {
    dado = sl.siguiente({ casa: L.casa, sesion: COORD, arnes: L.arnes, env: L.env, ahora: AHORA + 2000, arbol: [] });
    ausente = C.ownerNextText(dado, COORD, null, { setAt: iso(AHORA) });
  }] });
  assert.strictEqual(dado.tipo, 'permiso');
  assert.strictEqual(dado.destino, BG);
  assert.ok(dado.pregunta && dado.opciones, 'con su cuadro');
  // con el dueño ausente, owner-next no arma el cuadro, avisa y el renglón queda; el gancho vence como siempre
  assert.doesNotMatch(ausente, /Mostrá AskUserQuestion/);
  assert.match(ausente, /El dueño está ausente/);
  assert.match(ausente, /un permiso esperando/);
  assert.deepStrictEqual(delGancho(L), [], 'el gancho venció y sacó su renglón');
  // un cuadro con varias preguntas: cada «Sí» vale sólo para el pedido de su pregunta
  const contestar = (fila, reloj, aprueba) => {
    const otra = pregunta({ ...fila, id: 'permiso-00000000' });
    const respuesta = { answers: { [pregunta(fila)]: aprueba ? 'Sí, aprobar' : 'No', [otra]: aprueba ? 'No' : 'Sí, aprobar' } };
    const rs = record.registrosDe({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: COORD, tool_use_id: 'toolu_02', tool_response: respuesta }, { ahora: reloj });
    for (const r of rs) oa.anotar(L.casa, { ...r, herramienta: { pid: process.pid, inicio: INICIO } });
    return rs;
  };
  let anotados = null;
  const si = correr(L, evento(), { pasos: [({ reloj, fila }) => { anotados = contestar(fila, reloj, true); }] });
  assert.strictEqual(anotados.length, 1, 'un renglón por pregunta aprobada');
  assert.strictEqual(si.r.decision, 'allow');
  const no = correr(L, evento(), { pasos: [({ reloj, fila }) => { anotados = contestar(fila, reloj, false); }] });
  assert.strictEqual(anotados.length, 1);
  assert.strictEqual(no.r.decision, null, 'el «Sí» a la otra pregunta no aprueba este pedido');
});

// ── AC 13: el «No» ─────────────────────────────────────────────────────────────────────────────────────────────────

test('Permiso_ClickNo_Deny (T13) @story-8.180 @ac-13', (t) => {
  const L = lab(t);
  let rechazo = null;
  let mientras = null;
  const { r } = correr(L, evento(), { pasos: [({ fila }) => {
    rechazo = sl.rechazar({ casa: L.casa, id: fila.id, sesion: COORD });
    mientras = sl.siguiente({ casa: L.casa, sesion: COORD, arnes: L.arnes, env: L.env, ahora: AHORA + 2000, arbol: [] });
  }] });
  assert.ok(rechazo.ok, rechazo.mensaje);
  assert.match(rechazo.mensaje, /^Negué permiso-[0-9a-f]{8}: el gancho de V1-8180/);
  assert.notStrictEqual(mientras.tipo, 'permiso', 'el rechazado ya no se pasa, aunque su gancho todavía no lo leyó');
  assert.strictEqual(r.decision, 'deny');
  const out = JSON.parse(PR.salida(r));
  assert.strictEqual(out.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(out.hookSpecificOutput.decision.message, /dijo que no/);
  assert.deepStrictEqual(delGancho(L), []);
  assert.ok(gates(L).some((g) => g.status === 'rechazado'));
  // un cuadro cerrado no anota nada: sigue la espera, y vence sin decidir
  const cerrado = record.registroDe({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: COORD, tool_response: { answers: {} } });
  assert.strictEqual(cerrado, null);
  const { r: r2, vueltas } = correr(L, evento());
  assert.strictEqual(r2.decision, null);
  assert.strictEqual(vueltas, 30, 'esperó el minuto entero');
});

// ── AC 14: el plazo ────────────────────────────────────────────────────────────────────────────────────────────────

test('Permiso_Vencido_VentanaNormal (T14) @story-8.180 @ac-14', (t) => {
  const L = lab(t, { espera: 1 });
  let fila = null;
  const { r, reloj } = correr(L, evento(), { pasos: [(p) => { fila = p.fila; }] });
  assert.strictEqual(r.decision, null);
  assert.strictEqual(reloj - AHORA, 60000, 'el plazo sale de coordination.permission_wait_minutes');
  assert.match(r.motivo, /nadie contestó el cuadro en 1 minutos/);
  assert.deepStrictEqual(delGancho(L), [], 'el renglón se cierra');
  assert.ok(gates(L).some((g) => g.status === 'vencido' && g.id === fila.id && g.espera_s === 60), 'gates.log dice cuánto esperó');
  // queda trabada, con el motivo
  const s = C.status({ home: L.casa, arnes: L.arnes, env: L.env, now: reloj + 1000, noTranscripts: true, codexHome: path.join(L.raiz, 'sin-codex') });
  assert.strictEqual(s.stalled.length, 1);
  assert.match(C.statusText(s), /no te llegó como cuadro: nadie contestó el cuadro en 1 minutos/);
  assert.ok(!JSON.stringify(s).includes('nadie contestó'), 'el motivo sale en la línea, no en --json');
  // un click posterior no aprueba nada: no queda nadie esperándolo
  click(L, { pregunta: pregunta(fila), ts: reloj + 5000 });
  assert.deepStrictEqual(usadas(L), []);
  // sin valor, 10 minutos
  const diez = lab(t, { espera: null });
  assert.strictEqual(PR.esperaMs(diez.casa, {}), 10 * 60000);
});

// ── AC 15: el cuadro resuelto por ausencia ─────────────────────────────────────────────────────────────────────────

test('Permiso_CuadroPorAusencia_NoAprueba (T15) @story-8.180 @ac-15', () => {
  const r = oa.respuestaDelCuadro({ answers: { '¿Aprobás este pedido de Bash?': 'Sí, aprobar' }, afkTimeoutMs: 60000 });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /por ausencia/);
  const anotado = record.registroDe({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: COORD, tool_response: { answers: { x: 'Sí, aprobar' }, afkTimeoutMs: 60000 } });
  assert.strictEqual(anotado, null, 'no se anota: no hay click para el permiso, y sigue la espera');
});

// ── AC 16: sólo el click de la persona ─────────────────────────────────────────────────────────────────────────────

test('Permiso_SoloElClickDeLaPersona (T16) @story-8.180 @ac-16', (t) => {
  const L = lab(t);
  const casos = {
    'un «aprobado» escrito en la pestaña de la coordinadora': ({ reloj }) => oa.anotar(L.casa, { tipo: 'mensaje', sesion: COORD, ts: iso(reloj), texto: 'aprobado', herramienta: { pid: process.pid, inicio: INICIO } }),
    'un click escrito a mano, de un proceso que no es la herramienta': ({ reloj, fila }) => click(L, { pregunta: pregunta(fila), ts: reloj, herramienta: { pid: MUERTO, inicio: INICIO } }),
    'el renglón marcado como aprobado': ({ fila }) => {
      const lista = crudas(L).map((f) => (f.id === fila.id ? { ...f, aprobado: true, decision: 'allow' } : f));
      fs.writeFileSync(sl.archivo(L.casa), JSON.stringify(lista));
    },
  };
  for (const [que, paso] of Object.entries(casos)) {
    assert.strictEqual(correr(L, evento(), { pasos: [paso] }).r.decision, null, que);
  }
  // un click con la forma del de la persona que la transcripción no confirma: la validación de verdad lo niega
  const sinTranscripcion = correr(L, evento(), { validar: undefined, pasos: [({ reloj, fila }) => click(L, { pregunta: pregunta(fila), ts: reloj })] });
  assert.strictEqual(sinTranscripcion.r.decision, null);
  // la delegación no lo cubre: con todo delegado en el perfil, sin click no hay allow
  fs.writeFileSync(path.join(ARNES, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora', delegated_signing: ['manual-test'] } }));
  try {
    assert.strictEqual(correr(L, evento()).r.decision, null);
  } finally {
    fs.writeFileSync(path.join(ARNES, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  }
  assert.deepStrictEqual(usadas(L), []);
});

// ── AC 17: fuera de alcance, sin demora ────────────────────────────────────────────────────────────────────────────

test('Permiso_FueraDeAlcance_SaleSinDemora (T17) @story-8.180 @ac-17', (t) => {
  const casos = [
    ['sin coordinadora designada', () => lab(t, { designada: false }), {}],
    ['coordinadora sin confirmar', () => lab(t, { confirmada: false }), {}],
    ['coordinadora sin proceso vivo', () => { const L = lab(t); sesion(L.casa, COORD, { archivo: String(process.pid), pid: MUERTO, kind: 'interactive' }); return L; }, {}],
    ['sin owner-wait vivo', () => lab(t), { ownerWaitVivo: () => false }],
    ['sin owner-wait vivo, leído de verdad', () => lab(t), { ownerWaitVivo: undefined }],
    ['la misma sesión', () => { const L = lab(t); sesion(L.casa, COORD, { archivo: String(process.pid), kind: 'bg' }); return L; }, { ev: { session_id: COORD } }],
    ['una pestaña abierta', () => lab(t, { bg: { kind: 'interactive' } }), {}],
    ['la lista apagada', () => lab(t, { llave: 'off' }), {}],
    ['Codex', () => lab(t), { ev: { turn_id: 't-1' } }],
    ['Windows, por PowerShell', () => lab(t), { ev: { tool_name: 'PowerShell', tool_input: { command: 'New-Item x' } }, plataforma: 'win32' }],
    ['apagado con TYCON_PERMISSION_RELAY=0', () => lab(t), { env: { TYCON_PERMISSION_RELAY: '0' } }],
    ['un gancho que falla (la lista rota)', () => { const L = lab(t); fs.mkdirSync(path.dirname(sl.archivo(L.casa)), { recursive: true }); fs.writeFileSync(sl.archivo(L.casa), '{roto'); return L; }, {}],
  ];
  for (const [que, armar, o] of casos) {
    const L = armar();
    const { r, vueltas } = correr(L, evento(o.ev || {}), { ...(o.plataforma ? { plataforma: o.plataforma } : {}), ...(o.env ? { env: o.env } : {}), ...('ownerWaitVivo' in o ? { ownerWaitVivo: o.ownerWaitVivo } : {}) });
    assert.strictEqual(r.decision, null, que);
    assert.strictEqual(vueltas, 0, `${que}: sale sin demora (${r.motivo})`);
    assert.strictEqual(PR.salida(r), '', `${que}: sin salida, vuelve la ventana normal`);
    assert.deepStrictEqual(delGancho(L), [], `${que}: sin renglón`);
  }
  // en Windows, por Bash sí se lleva (la decisión 10)
  const win = lab(t);
  let llevado = false;
  correr(win, evento(), { plataforma: 'win32', pasos: [({ fila }) => { llevado = Boolean(fila); }] });
  assert.ok(llevado);
  // la coordinadora muere mientras espera: cierra el renglón y sale sin decidir
  const L = lab(t);
  const { r, vueltas } = correr(L, evento(), { pasos: [() => sesion(L.casa, COORD, { archivo: String(process.pid), pid: MUERTO, kind: 'interactive' })] });
  assert.strictEqual(r.decision, null);
  assert.strictEqual(vueltas, 1);
  assert.match(r.motivo, /la coordinadora ya no está/);
  assert.deepStrictEqual(delGancho(L), []);
  assert.ok(gates(L).some((g) => g.status === 'sin-coordinadora'));
  // y si deja de ser la designada (se nombra otra), igual
  const M = lab(t);
  const otra = correr(M, evento(), { pasos: [() => designar(M.casa, 'ses-nueva')] });
  assert.strictEqual(otra.r.decision, null);
  assert.strictEqual(otra.vueltas, 1);
});

// ── AC 18 y 25: lo que no se lleva ─────────────────────────────────────────────────────────────────────────────────

test('Permiso_PlanYPreguntas_NoSeLlevan (T18) @story-8.180 @ac-18', (t) => {
  const L = lab(t);
  for (const tool_name of ['ExitPlanMode', 'AskUserQuestion', 'Read', 'MultiEdit', 'mcp__spokenly__ask_user_dictation', 'mcp__otro__algo']) {
    const { r, vueltas } = correr(L, evento({ tool_name, tool_input: { plan: 'x' } }));
    assert.strictEqual(r.decision, null, tool_name);
    assert.strictEqual(vueltas, 0, tool_name);
  }
  assert.deepStrictEqual(delGancho(L), []);
  // el matcher del gancho nombra sus herramientas, nunca `*`
  const lista = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8')).hooks;
  const suyo = lista.filter((h) => h.spec === '@tcg:permission-relay.js');
  assert.deepStrictEqual(suyo.map((h) => [h.event, h.matcher]), [['PermissionRequest', 'Bash|PowerShell|Edit|Write|NotebookEdit|WebFetch']]);
  assert.ok(suyo[0].timeout > 30 * 60, 'su plazo pasa la espera más larga que acepta la configuración');
});

test('Permiso_OtrosModos_NoDisparan, en proceso (T25, la parte sin vivo) @story-8.180 @ac-25', (t) => {
  const L = lab(t);
  for (const permission_mode of ['auto', 'bypassPermissions', 'dontAsk', 'acceptEdits', 'plan', undefined]) {
    const { r, vueltas } = correr(L, evento({ permission_mode }));
    assert.strictEqual(r.decision, null, String(permission_mode));
    assert.strictEqual(vueltas, 0, String(permission_mode));
  }
  assert.deepStrictEqual(delGancho(L), []);
});

// ── AC 19: owner-wait ──────────────────────────────────────────────────────────────────────────────────────────────

test('OwnerWait_DespiertaYUnSoloProceso (T19) @story-8.180 @ac-19', (t) => {
  const L = lab(t);
  const opts = (seg) => ({ home: L.casa, arnes: L.arnes, env: L.env, sessionId: COORD, now: AHORA + seg * 1000, noTranscripts: true, codexHome: path.join(L.raiz, 'sin-codex'), ownerWaits: () => ({ esperas: [], problemas: [] }) });
  const permiso = (s) => C.ownerWaitOnce(opts(s)).lines.filter((l) => /un permiso para la persona/.test(l));
  // ya estaba al lanzarlo, sin anunciar: sale
  const a = sl.anotarPermiso({ casa: L.casa, herramienta: 'Bash', pedido: 'touch v1-si.txt', carpeta: '/r/pro', sesion: BG, pid: process.pid, ahora: AHORA, relay: true });
  const primero = permiso(0);
  assert.strictEqual(primero.length, 1);
  assert.match(primero[0], new RegExp(`«V1-8180» pide «Bash» en «/r/pro» \\(${a.id}\\)\\. Te da el cuadro owner-next`));
  assert.match(primero[0], /Lo aprueba la persona con su click; vos no/);
  // ya anunciado: no la hace salir de nuevo
  assert.deepStrictEqual(permiso(2), []);
  // uno nuevo: sale
  const b = sl.anotarPermiso({ casa: L.casa, herramienta: 'Edit', pedido: 'Archivo: /r/pro/a', carpeta: '/r/pro', sesion: BG, pid: process.pid, ahora: AHORA + 3000, relay: true });
  assert.strictEqual(permiso(4).length, 1);
  // el que ya no está se olvida
  sl.renglonDelGancho(L.casa, a.id, { quitar: true });
  permiso(6);
  assert.deepStrictEqual(Object.keys(C.readAnnounced(L.casa).permisos), [b.id]);
  // un solo proceso por máquina: con otro vivo, no lanza otro
  fs.mkdirSync(path.join(estado(L.casa), 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(estado(L.casa), 'coordination', 'owner-wait.pid'), String(process.ppid));
  assert.strictEqual(C.ownerWaitAlive(L.casa), process.ppid, 'el gancho de permisos mira éste');
  assert.match(C.ownerWait({ ...opts(8) }).text, /ya hay uno esperando/);
  // desde una sesión que no es la coordinadora, sale sin esperar nada
  assert.match(C.ownerWait({ ...opts(8), sessionId: BG }).text, /no hay coordinadora confirmada/);
});

// ── AC 20: el dev de producto ──────────────────────────────────────────────────────────────────────────────────────

test('Permiso_DevDeProducto_ApruebaElDev (T20) @story-8.180 @ac-20', (t) => {
  const repo = '/r/producto-x/forms';
  const L = lab(t, { bg: { cwd: repo } });
  const { r } = correr(L, evento({ cwd: repo }), { pasos: [({ reloj, fila }) => click(L, { pregunta: pregunta(fila), ts: reloj })] });
  assert.strictEqual(r.decision, 'allow', 'el click de quien está en la pestaña de su coordinadora');
  // sin coordinadora, todo como hoy: ni renglón ni lista
  const sin = lab(t, { designada: false, bg: { cwd: repo } });
  const { r: r2, vueltas } = correr(sin, evento({ cwd: repo }));
  assert.strictEqual(r2.decision, null);
  assert.strictEqual(vueltas, 0);
  assert.deepStrictEqual(crudas(sin), []);
});

// ── AC 21: la portada ──────────────────────────────────────────────────────────────────────────────────────────────

test('Portada_DiceComoPrenderla (T21) @story-8.180 @ac-21', () => {
  const es = fs.readFileSync(path.join(ROOT, 'getting-started', 'one-minute.es.md'), 'utf8');
  const en = fs.readFileSync(path.join(ROOT, 'getting-started', 'one-minute.md'), 'utf8');
  assert.match(es, /«Esta sesión es la\s+coordinadora»/);
  assert.match(es, /optativ/);
  assert.match(es, /Varias sesiones a la vez/);
  for (const modo of [/modo\s+normal/, /modo\s+automático/, /Sin\s+permisos/]) assert.match(es, modo);
  assert.match(en, /"This session is the\s+coordinadora"/);
  assert.match(en, /optional/);
  assert.match(en, /Several sessions at once/);
  for (const modo of [/normal\s+mode/, /auto\s+mode/, /no-permissions\s+mode/]) assert.match(en, modo);
  for (const t of [es, en]) assert.doesNotMatch(t, /marker\.js|coordination\.js/, 'sin pasos de mantenimiento');
});

// ── AC 27: el click de firma sigue valiendo ────────────────────────────────────────────────────────────────────────

test('Permiso_GanchoInstalado_ClickDeFirmaSigueValiendo (T27) @story-8.180 @ac-27', (t) => {
  assert.deepStrictEqual(oa.PERMITIDOS, ['wait-notice.js', 'owner-approval-record.js', 'session-state.js', 'background-question-guard.js'], 'PERMITIDOS no cambió');
  const lista = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8')).hooks;
  const suyo = lista.find((h) => h.spec === '@tcg:permission-relay.js');
  assert.strictEqual(oa.alcanzaAlCuadro(suyo.matcher), false);
  // la configuración con el gancho instalado, como la escribe el instalador: nadie ajeno escucha el cuadro
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-relay-casa-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  fs.mkdirSync(path.join(casa, '.claude'), { recursive: true });
  const comando = `node "${path.join(casa, '.tycon', 'harness', 'scripts', 'hooks', 'permission-relay.js')}"`;
  fs.writeFileSync(path.join(casa, '.claude', 'settings.json'), JSON.stringify({ hooks: { PermissionRequest: [{ matcher: suyo.matcher, hooks: [{ type: 'command', command: comando, timeout: suyo.timeout }] }] } }));
  const e = oa.escuchasDelCuadro({ casa, cwd: casa, administrada: path.join(casa, 'sin-administrada') });
  assert.deepStrictEqual(e, { ajenos: [], ilegibles: [] });
});

// ── AC 28: el renglón sin gancho vivo ──────────────────────────────────────────────────────────────────────────────

test('Permiso_GanchoMuerto_RenglonSeCierra (T28) @story-8.180 @ac-28', (t) => {
  const L = lab(t);
  const muerto = sl.anotarPermiso({ casa: L.casa, herramienta: 'Bash', pedido: 'touch tarde.txt', carpeta: '/r/pro', sesion: BG, pid: MUERTO, ahora: AHORA, relay: true });
  const viejo = sl.anotarPermiso({ casa: L.casa, herramienta: 'Bash', pedido: 'touch viejo.txt', carpeta: '/r/pro', sesion: BG, pid: process.pid, ahora: AHORA - 2 * 3600000, relay: true });
  const vivo = sl.anotarPermiso({ casa: L.casa, herramienta: 'Bash', pedido: 'touch vivo.txt', carpeta: '/r/pro', sesion: BG, pid: process.pid, ahora: AHORA, relay: true });
  // la lista que leen el aviso y la oficina ya no los cuenta
  const ids = sl.abiertos(L.casa, { arnes: L.arnes, env: L.env, ahora: AHORA }).filas.map((f) => f.id);
  assert.deepStrictEqual(ids, [vivo.id]);
  // owner-next da el vivo, nunca un cuadro por el muerto, y los borra
  const r = sl.siguiente({ casa: L.casa, sesion: COORD, arnes: L.arnes, env: L.env, ahora: AHORA, arbol: [] });
  assert.strictEqual(r.id, vivo.id);
  assert.deepStrictEqual(crudas(L).map((f) => f.id), [vivo.id], `se cerraron ${muerto.id} y ${viejo.id}`);
  // uno rechazado con el gancho vivo queda en el archivo hasta que el gancho lo lee, pero no se pasa
  assert.ok(sl.rechazar({ casa: L.casa, id: vivo.id, sesion: COORD }).ok);
  assert.strictEqual(sl.siguiente({ casa: L.casa, sesion: COORD, arnes: L.arnes, env: L.env, ahora: AHORA, arbol: [] }).tipo, 'nada');
  assert.strictEqual(crudas(L)[0].rechazado.length > 0, true);
  // el renglón de antes (sin `relay`) sigue como en la 8.153
  const antes = sl.anotarPermiso({ casa: L.casa, herramienta: 'Bash', pedido: 'ls', carpeta: '/r', sesion: BG, pid: MUERTO, ahora: AHORA });
  assert.ok(sl.abiertos(L.casa, { arnes: L.arnes, env: L.env, ahora: AHORA }).filas.some((f) => f.id === antes.id));
});
