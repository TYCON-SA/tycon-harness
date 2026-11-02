'use strict';
// context-size-notice.test.js — el aviso de contexto: cuando el último turno del asistente suma el
// umbral de tokens (300 mil de fábrica), el gancho le dice al agente que recomiende `/clear` o una sesión nueva al
// terminar el paso en curso.
//
// Lo que no se puede perder:
//   · avisa, nunca frena: sale 0 siempre;
//   · una vez al cruzar el umbral y otra cada 100 mil más; después de `/clear` o `compact` cuentan sólo los turnos nuevos;
//   · sin turno que contar no dice nada; lo que no puede medir lo dice, sin inventar un número;
//   · el umbral: la máquina, después la organización, después la fábrica; un valor fuera de rango se salta y se dice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'context-size-notice.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const VIEJO = '2026-01-01T10:00:00.000Z';
// la hora de ahora: un turno escrito después de que corrió un reinicio queda posterior a él, y anterior al siguiente
// stable-data: sólo se compara con la hora del reinicio, que el gancho también toma del reloj; no depende del día ni del huso
const NUEVO = () => new Date().toISOString();

/** Un turno del asistente que suma `total` tokens de contexto. */
function turno(total, ts = VIEJO) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { role: 'assistant', usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: total - 3000, output_tokens: 500 } },
  });
}
const pedido = (ts = VIEJO) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: 'seguí' } });

function transcript(dir, lineas) {
  const f = path.join(dir, 'sesion.jsonl');
  fs.writeFileSync(f, lineas.join('\n') + '\n');
  return f;
}
function agregar(f, lineas) { fs.appendFileSync(f, lineas.join('\n') + '\n'); }

/** Corre el gancho con una casa temporal (sin el arnés de la máquina). */
function correr(evento, { home, env = {} } = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^TYCON_/.test(k)) delete base[k];
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(evento), encoding: 'utf8',
    env: { ...base, HOME: home, USERPROFILE: home, ...env },
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: r.stderr || '' };
}
const prompt = (sid, tp, cwd) => ({ hook_event_name: 'UserPromptSubmit', session_id: sid, transcript_path: tp, cwd: cwd || os.tmpdir(), prompt: 'seguí' });
const arranque = (sid, tp, source) => ({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: tp, source });

test('ContextNotice_AtThreshold_Says_Below_Silent @story-7.54 @ac-1 — a los 300.000 avisa en una línea; con 299.999, nada', () => {
  // 🔴 rojo: el gancho no existe, no suma los tres campos, o avisa debajo del umbral.
  const home = tmp('ctx-home-');
  const d = tmp('ctx-t1-');
  const r = correr(prompt('t1-a', transcript(d, [pedido(), turno(300000)])), { home });
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out.split('\n').length, 1, `una línea: ${r.out}`);
  assert.match(r.out, /300 mil/);
  assert.match(r.out, /\/clear/);
  assert.match(r.out, /sesión nueva/);
  assert.match(r.out, /nunca en el medio/);
  const d2 = tmp('ctx-t1b-');
  const r2 = correr(prompt('t1-b', transcript(d2, [pedido(), turno(299999)])), { home });
  assert.strictEqual(r2.code, 0, r2.err);
  assert.strictEqual(r2.out, '', 'debajo del umbral no dice nada');
});

test('ContextNotice_OncePerStep_ResetsAfterClear @story-7.54 @ac-2 — avisa, calla, avisa cada 100 mil; tras compact cuentan sólo los turnos nuevos', () => {
  // 🔴 rojo: repite en cada turno, no vuelve a avisar a los 400 mil, cuenta el turno viejo después de compact, o dice
  // «no pude medir» en una sesión sin turnos.
  const home = tmp('ctx-home-');
  const d = tmp('ctx-t2-');
  const f = transcript(d, [pedido(), turno(310000)]);
  const sid = 't2';
  assert.match(correr(prompt(sid, f), { home }).out, /310 mil/, 'cruza el umbral: avisa');
  agregar(f, [pedido(), turno(350000)]);
  assert.strictEqual(correr(prompt(sid, f), { home }).out, '', 'dentro del mismo tramo: calla');
  agregar(f, [pedido(), turno(405000)]);
  assert.match(correr(prompt(sid, f), { home }).out, /405 mil/, '100 mil más: avisa otra vez');
  // compactar: el último turno de antes (410 mil) ya no cuenta
  agregar(f, [pedido(), turno(410000)]);
  assert.strictEqual(correr(arranque(sid, f, 'compact'), { home }).code, 0);
  const tras = correr(prompt(sid, f), { home });
  assert.strictEqual(tras.code, 0, tras.err);
  assert.strictEqual(tras.out, '', 'sin turno nuevo después de compactar: nada, ni «no pude medir»');
  // una sesión nueva, sin turnos del asistente
  const nueva = correr(prompt('t2-nueva', transcript(tmp('ctx-t2n-'), [pedido(NUEVO())])), { home });
  assert.strictEqual(nueva.out, '', 'sesión sin turnos: nada');
  // después del reinicio vuelve a avisar recién al cruzar el umbral de nuevo
  agregar(f, [pedido(NUEVO()), turno(250000, NUEVO())]);
  assert.strictEqual(correr(prompt(sid, f), { home }).out, '', 'turno nuevo debajo del umbral: nada');
  agregar(f, [pedido(NUEVO()), turno(310000, NUEVO())]);
  assert.match(correr(prompt(sid, f), { home }).out, /310 mil/, 'cruza de nuevo: avisa');
  // `/clear` también reinicia
  assert.strictEqual(correr(arranque(sid, f, 'clear'), { home }).code, 0);
  assert.strictEqual(correr(prompt(sid, f), { home }).out, '', 'tras /clear, el turno de antes no cuenta');
});

test('ContextNotice_MachineOverOrg_BadValueSaid @story-7.54 @ac-3 — la máquina gana a la organización; un valor fuera de rango no se usa y se dice', () => {
  // 🔴 rojo: la organización gana, un valor fuera de rango se usa, o se saltea sin decirlo.
  const { thresholdTokens } = require(HOOK);
  const TR = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  const base = {
    version: 1,
    public: { platform: 'github', org: 'acme', repo: 'harness' },
    profile: { platform: 'azure', org: 'acme', project: 'p', repo: 'profile' },
    operations: { platform: 'azure', org: 'acme', project: 'p', repo: 'ops' },
  };
  const arbol = (cn) => {
    const d = tmp('ctx-org-');
    fs.writeFileSync(path.join(d, 'team-repos.json'), JSON.stringify(cn === undefined ? base : { ...base, context_notice: cn }));
    return d;
  };
  const org200 = arbol({ tokens: 200000 });
  assert.ok(TR.parse(fs.readFileSync(path.join(org200, 'team-repos.json'), 'utf8')).ok, 'la base es válida');
  assert.strictEqual(thresholdTokens({ env: { TYCON_CONTEXT_NOTICE_TOKENS: '250000' }, tree: org200 }).tokens, 250000, 'la máquina gana');
  assert.strictEqual(thresholdTokens({ env: {}, tree: org200 }).tokens, 200000, 'sin máquina, la organización');
  assert.strictEqual(thresholdTokens({ env: {}, tree: arbol(undefined) }).tokens, 300000, 'sin nada, la fábrica');
  const malaMaquina = thresholdTokens({ env: { TYCON_CONTEXT_NOTICE_TOKENS: '50000' }, tree: org200 });
  assert.strictEqual(malaMaquina.tokens, 200000, '50.000 no se usa: se toma la organización');
  assert.match(malaMaquina.problem, /TYCON_CONTEXT_NOTICE_TOKENS/);
  assert.match(malaMaquina.problem, /100\.000 a 900\.000/);
  const malaOrg = thresholdTokens({ env: {}, tree: arbol({ tokens: 950000 }) });
  assert.strictEqual(malaOrg.tokens, 300000, 'la organización fuera de rango: la fábrica');
  assert.match(malaOrg.problem, /context_notice\.tokens/);
  // y el aviso lo dice
  const home = tmp('ctx-home-');
  const r = correr(prompt('t3', transcript(tmp('ctx-t3-'), [pedido(), turno(310000)])), { home, env: { TYCON_CONTEXT_NOTICE_TOKENS: '50000' } });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /310 mil/);
  assert.match(r.out, /TYCON_CONTEXT_NOTICE_TOKENS/, 'el aviso dice que el valor de la máquina no se usó');
});

test('ContextNotice_Unreadable_SaysNotMeasured @story-7.54 @ac-4 — lo que no se puede medir se dice, sin inventar; sale 0', () => {
  // 🔴 rojo: inventa un número, calla, o frena el mensaje.
  const home = tmp('ctx-home-');
  const carpeta = tmp('ctx-t4dir-');
  const noLee = correr(prompt('t4-a', carpeta), { home });
  assert.strictEqual(noLee.code, 0, noLee.err);
  assert.match(noLee.out, /no pude medir/);
  const sinUsage = transcript(tmp('ctx-t4b-'), [pedido(), JSON.stringify({ type: 'assistant', timestamp: VIEJO, message: { role: 'assistant', content: [] } })]);
  const r2 = correr(prompt('t4-b', sinUsage), { home });
  assert.strictEqual(r2.code, 0, r2.err);
  assert.match(r2.out, /no pude medir/);
  assert.doesNotMatch(r2.out, /\d+ mil/, 'sin número inventado');
  const rota = transcript(tmp('ctx-t4c-'), [pedido(), turno(310000), '{"type":"assistant","timestamp":"2026-01-01T10:05:00.000Z","message":{"usa']);
  const r3 = correr(prompt('t4-c', rota), { home });
  assert.strictEqual(r3.code, 0, r3.err);
  assert.match(r3.out, /no pude medir/);
  // un transcript que todavía no existe es una sesión nueva: nada
  const r4 = correr(prompt('t4-d', path.join(tmp('ctx-t4d-'), 'no-existe.jsonl')), { home });
  assert.strictEqual(r4.code, 0, r4.err);
  assert.strictEqual(r4.out, '');
});

test('ContextNotice_HugeTranscript_StillMeasures @story-7.54 @ac-1 — una sesión de más de 512 MB se mide igual: se lee la cola', (t) => {
  // 🔴 rojo: si el transcript se lee entero, Node no convierte a texto un archivo de más de ~512 MB y el aviso queda ciego
  // justo en las sesiones más largas.
  const d = tmp('ctx-grande-');
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'sesion.jsonl');
  // un archivo disperso de 600 MB (no ocupa disco) con los turnos al final
  fs.writeFileSync(f, '');
  fs.truncateSync(f, 600 * 1024 * 1024);
  fs.appendFileSync(f, '\n' + [pedido(), turno(310000)].join('\n') + '\n');
  const r = correr(prompt('t-grande', f), { home: tmp('ctx-home-') });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /310 mil/);
  assert.doesNotMatch(r.out, /no pude medir/);
  // y la lectura por la cola cruza los bloques: el turno queda partido entre dos lecturas
  const { medir } = require(HOOK);
  const chico = transcript(tmp('ctx-bloques-'), [pedido(), turno(310000), pedido()]);
  assert.deepStrictEqual(medir(chico, null, { chunk: 16 }), { tokens: 310000 });
});

test('ContextNotice_CodexAndSkippedTurns @story-7.54 @ac-1 — el conteo de Codex cuenta; los turnos de subagentes y los sintéticos no', () => {
  const { medir } = require(HOOK);
  const codex = transcript(tmp('ctx-codex-'), [
    JSON.stringify({ type: 'event_msg', timestamp: VIEJO, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 320000, output_tokens: 10 } } } }),
  ]);
  assert.deepStrictEqual(medir(codex, null), { tokens: 320000 });
  const saltea = transcript(tmp('ctx-saltea-'), [
    turno(310000),
    JSON.stringify({ type: 'assistant', timestamp: VIEJO, isSidechain: true, message: { role: 'assistant', usage: { input_tokens: 5 } } }),
    JSON.stringify({ type: 'assistant', timestamp: VIEJO, message: { role: 'assistant', model: '<synthetic>', usage: { input_tokens: 0 } } }),
  ]);
  assert.deepStrictEqual(medir(saltea, null), { tokens: 310000 }, 'el último turno que cuenta es el de 310 mil');
});

test('ContextNotice_BrokenOrgFile_SaysIt @story-7.54 @ac-3 — un team-repos.json que no se puede usar cae a la fábrica y lo dice', () => {
  // 🔴 rojo: con el archivo roto, el umbral cae a 300.000 sin decirlo.
  const { thresholdTokens } = require(HOOK);
  const d = tmp('ctx-org-roto-');
  fs.writeFileSync(path.join(d, 'team-repos.json'), '{ "context_notice": { "tokens": 200000 ');
  const r = thresholdTokens({ env: {}, tree: d });
  assert.strictEqual(r.tokens, 300000);
  assert.match(r.problem || '', /team-repos\.json/);
});

test('ContextNotice_OpenRun_SaysHowToResume — con una ejecución abierta, dice cómo seguirla en otra sesión; sin ella, no', () => {
  // 🔴 rojo: el aviso no nombra adopt-session ni el id de esta sesión, o lo dice sin ejecución abierta.
  const { stateDir } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));
  const home = tmp('ctx-home-');
  const active = path.join(stateDir(home), 'active');
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, 'r1-con.json'), JSON.stringify({ sessionId: 'r1-con', storyId: '9.99' }));
  const r = correr(prompt('r1-con', transcript(tmp('ctx-r1-'), [pedido(), turno(310000)])), { home });
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out.split('\n').length, 1, `una línea: ${r.out}`);
  assert.match(r.out, /la 9\.99/);
  assert.match(r.out, /marker\.js" adopt-session r1-con/, 'con la ruta entre comillas: puede traer espacios');
  assert.match(r.out, /pipeline\.js start/);
  const r2 = correr(prompt('r1-sin', transcript(tmp('ctx-r1b-'), [pedido(), turno(310000)])), { home });
  assert.strictEqual(r2.code, 0, r2.err);
  assert.match(r2.out, /300 mil/);
  assert.doesNotMatch(r2.out, /adopt-session/, 'sin ejecución abierta no la menciona');
});
