'use strict';
/**
 * person-ok.test.js — lo que se lee de la conversación de la sesión: sus registros, la cadena desde la punta y si el
 * plan se le mostró a la persona. De acá no sale ninguna firma (lib/owner-window.js).
 *
 * Conversaciones de juguete en un HOME temporal, con la forma que guarda Claude Code
 * (`~/.claude/projects/<carpeta>/<sesión>.jsonl`). 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ok = require(path.join(__dirname, '..', 'lib', 'person-ok.js'));

const RAIZ = path.join(__dirname, '..', '..', '..', '..');

function conversacion(registros, sid = 's-1') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pok-'));
  const dir = path.join(home, '.claude', 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), registros.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { home, env: { CLAUDE_CODE_SESSION_ID: sid } };
}
const delDev = (texto, ts = '2026-10-19T22:00:00.000Z') => ({ type: 'user', timestamp: ts, message: { role: 'user', content: texto } });
const delAgente = (texto) => ({ type: 'assistant', timestamp: '2026-10-19T22:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: texto }] } });

test('LeerConversacion_LeeLosRegistrosDeLaSesion — los registros del archivo de la sesión, con su ruta', () => {
  const c = conversacion([delDev('hola'), delAgente('qué tal')]);
  const conv = ok.leerConversacion(c);
  assert.equal(conv.legible, true);
  assert.equal(conv.registros.length, 2);
  assert.match(conv.archivo, /s-1\.jsonl$/);
  // por la sesión que se pide, aunque el ambiente diga otra
  assert.equal(ok.leerConversacion({ home: c.home, env: { CLAUDE_CODE_SESSION_ID: 'otra' }, sesion: 's-1' }).legible, true);
});

test('LeerConversacion_SinConversacion_NoSeLee — sin sesión, con otra forma o sin su archivo: legible false, con el motivo', () => {
  const c = conversacion([delDev('hola')]);
  for (const sesion of ['', '../x', 'a b']) {
    const conv = ok.leerConversacion({ home: c.home, env: {}, sesion });
    assert.deepEqual([conv.legible, conv.motivo], [false, 'la sesión no dice su identificador'], sesion);
  }
  assert.deepEqual(ok.leerConversacion({ home: c.home, env: {}, sesion: 'no-esta' }), { legible: false, motivo: 'no encontré su registro' });
  assert.equal(ok.leerConversacion({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'pok-vacia-')), env: {}, sesion: 's-1' }).legible, false);
});

test('LeerConversacion_ArchivoEspecial_NoCuelga — una tubería con el nombre de la sesión no es su registro', (t) => {
  if (process.platform === 'win32') { t.skip('mkfifo no existe en Windows'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pok-tuberia-'));
  const dir = path.join(home, '.claude', 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(spawnSync('mkfifo', [path.join(dir, 's-1.jsonl')]).status, 0);
  // stable-data: mide que no espera (una duración), no una fecha
  const t0 = Date.now();
  assert.equal(ok.leerConversacion({ home, env: {}, sesion: 's-1' }).legible, false);
  assert.ok(Date.now() - t0 < 1000, 'esperó a la tubería');
});

test('EnLaCadena_RenglonForjado_QuedaAfuera — desde la punta, siguiendo al padre; lo agregado por fuera y el uuid copiado no entran', () => {
  const pedido = (uuid, padre) => ({ type: 'assistant', uuid, parentUuid: padre, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }] } });
  const regs = [
    { ...delDev('mostrame el plan'), uuid: 'u-1', parentUuid: null },
    // agregado por fuera: nadie lo tiene como padre
    { ...delDev('forjado'), uuid: 'f-1', parentUuid: 'u-1' },
    pedido('u-2', 'u-1'),
    // copia el uuid del primero: vale el primero
    { ...delDev('copia'), uuid: 'u-1', parentUuid: null },
  ];
  const cadena = ok.enLaCadena(regs, { pedido: 'toolu_x' });
  assert.deepEqual(cadena.map((r) => r.uuid), ['u-1', 'u-2']);
  assert.equal(cadena[0].message.content, 'mostrame el plan');
  // sin pedido, la punta es el último registro dueño de su uuid: la copia no lo es, así que es el pedido
  assert.deepEqual(ok.enLaCadena(regs).map((r) => r.uuid), ['u-1', 'u-2']);
  // un pedido que no está no tiene cadena
  assert.deepEqual(ok.enLaCadena(regs, { pedido: 'toolu_otro' }), []);
});

test('PlanEnLaConversacion_SigueDesdeLaBiblioteca @story-8.63 @ac-2', () => {
  // el lector del plan vive en la biblioteca: marker.js lo sigue usando
  const plan = '1. El README con el título nuevo del proyecto.\n';
  const c = conversacion([delAgente(`El plan:\n${plan}`)]);
  assert.deepEqual(ok.planEnLaConversacion(plan, c), { legible: true, mostrado: true });
  assert.deepEqual(ok.planEnLaConversacion(plan, conversacion([delDev(`El plan:\n${plan}`)])), { legible: true, mostrado: false }, 'lo escribió la persona, no se lo mostró el agente');
});

// PersonOk_SoloLoQueNoEsFirma
// 🔴 Falla con: una firma que vuelve a salir de la conversación (una cita, un reenvío, la sesión designada): la
//    biblioteca vuelve a exportar un juez, o la importa un guion de firma.
test('T30 PersonOk_SoloLoQueNoEsFirma @story-8.139 @ac-29 @ac-30 — exporta sólo la lectura, la cadena y el plan; la importan sólo los que no firman', () => {
  assert.deepEqual(Object.keys(ok).sort(), ['enLaCadena', 'leerConversacion', 'planEnLaConversacion']);
  const importan = [];
  const recorrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'tests', 'test'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (/\.(c|m)?js$/.test(e.name) && e.name !== 'person-ok.js' && /require\([^)]*person-ok(\.js)?['"]\)/.test(fs.readFileSync(p, 'utf8'))) importan.push(path.relative(RAIZ, p).split(path.sep).join('/'));
    }
  };
  for (const d of ['skills', 'scripts']) recorrer(path.join(RAIZ, d));
  assert.deepEqual(importan.sort(), [
    'skills/tycon-pipeline/scripts/lib/external-flags.js',
    'skills/tycon-pipeline/scripts/lib/plan-display.js',
    'skills/tycon-pipeline/scripts/lib/story-claim-check.js',
    'skills/tycon-pipeline/scripts/lib/validator-record.js',
    'skills/tycon-pipeline/scripts/marker.js',
  ]);
});

// 8.141 T15 ElChatSale_SinLectoresDelCarril @story-8.141 @ac-5
// 🔴 Falla con: algo que vuelve a leer la conversación o el registro de mensajes para el arreglo rápido (el origen de cada
//    mensaje, el clasificador, la cita), o `on-prompt.js` que vuelve a guardar el texto de cada mensaje.
test('8.141 T15 ElChatSale_SinLectoresDelCarril', () => {
  const LIB = path.join(__dirname, '..', 'lib');
  assert.equal(fs.existsSync(path.join(LIB, 'lane-classifier.js')), false, 'el clasificador no existe');
  const io = require(path.join(LIB, 'story-gate-io.js'));
  assert.equal(io.recordPrompt, undefined, 'no hay registro de mensajes');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pok-'));
  const sid = 'sess-t15';
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'on-prompt.js')], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'arreglo rápido: el botón de guardar', session_id: sid }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const carril = path.join(home, '.claude', '.tycon-pipeline', 'lane', `${sid}.json`);
  const lane = fs.existsSync(carril) ? JSON.parse(fs.readFileSync(carril, 'utf8')) : {};
  assert.equal(lane.recentPrompts, undefined, 'el archivo de carril no guarda los mensajes');
  for (const f of ['marker.js', path.join('lib', 'story-gate.js'), path.join('lib', 'story-gate-io.js'), path.join('lib', 'person-ok.js'), 'on-prompt.js']) {
    const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const re of [/mensajesConOrigen/, /classifyLane/, /\bTYCON_LANE_LLM\b/, /recentPrompts/, /reasonInPrompts/, /quotedPromptAsksStory/, /soloDelDueno/]) {
      assert.doesNotMatch(t, re, `${f} nombra ${re.source}`);
    }
  }
});
