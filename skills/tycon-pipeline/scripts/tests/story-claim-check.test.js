#!/usr/bin/env node
/**
 * story-claim-check.test.js — no se cierra el turno diciendo «creé la historia» sin la historia escrita.
 *
 * El caso que lo motivó: un modelo corrió la skill de historias, mandó la escritura como si fuera un comando de la
 * terminal («Write {…}» por Bash), falló y cerró con «He creado la historia». Los transcripts de acá reproducen esa
 * forma con nombres inventados.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/story-claim-check.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { claimWithoutStory } = require('../lib/story-claim-check.js');
const GATE = path.join(__dirname, '..', 'on-stop-dod-gate.js');

const STORY = '---\nepic: 6\nstory: "6.6"\nstatus: draft\n---\n# Historia\n';
const CLAIM = 'He creado la historia para la funcionalidad de CBU/CVU y Alias en la gestión de gestores.';

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'claim-')); }
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const assistant = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
const result = (id, text, isError) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
function transcript(d, records) {
  const p = path.join(d, 'sesion.jsonl');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
/** El turno del caso: la skill, la escritura mandada por la terminal que falla y el «creé». */
function turnoFallido(d, final = CLAIM) {
  const f = path.join(d, 'specs', 'story-6.6-cbu.md');
  return transcript(d, [
    user('creá una historia para el CBU de los gestores'),
    assistant([{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'tycon-create-story' } }]),
    result('t1', 'Launching skill', false),
    assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: `Write {"file_path": "${f}", "content": "..."}` } }]),
    result('t2', '(eval):1: command not found: Write', true),
    assistant([{ type: 'text', text: final }]),
  ]);
}

test('T1 Claim_EscrituraFallida_Frena: «he creado» con la escritura fallida no deja cerrar', () => {
  const d = dir();
  const r = claimWithoutStory({ transcript_path: turnoFallido(d), cwd: d }, { hasMark: true });
  assert.match(r || '', /no se escribió ningún archivo de historia/);
  assert.match(r, /tool Write/);
});

test('T2 Claim_HistoriaEscrita_Pasa: con un Write que no falló y el archivo en disco, cierra', () => {
  const d = dir();
  const f = path.join(d, 'specs', 'story-6.6-cbu.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, STORY);
  const p = transcript(d, [
    user('creá una historia para el CBU de los gestores'),
    assistant([{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: f, content: STORY } }]),
    result('t1', 'File created successfully', false),
    assistant([{ type: 'text', text: CLAIM }]),
  ]);
  assert.strictEqual(claimWithoutStory({ transcript_path: p, cwd: d }, { hasMark: true }), null);
  // escribir otro .md (unas notas) no es escribir la historia
  const notas = path.join(d, 'notas.md');
  fs.writeFileSync(notas, '# notas\n');
  const p2 = transcript(d, [
    user('creá una historia para el CBU de los gestores'),
    assistant([{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: notas, content: '# notas\n' } }]),
    result('t1', 'File created successfully', false),
    assistant([{ type: 'text', text: CLAIM }]),
  ]);
  assert.notStrictEqual(claimWithoutStory({ transcript_path: p2, cwd: d }, { hasMark: true }), null);
  // un transcript que no se puede leer deja cerrar: no se toma por «no escribió»
  assert.strictEqual(claimWithoutStory({ transcript_path: path.join(d, 'no-existe.jsonl'), cwd: d }, { hasMark: true }), null);
});

test('T3 Claim_NombraHistoriaQueExiste_Pasa: escrita en otro turno y nombrada en el mensaje, cierra', () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'specs'));
  fs.writeFileSync(path.join(d, 'specs', 'story-6.6-cbu.md'), STORY);
  const p = turnoFallido(d, `${CLAIM} Está en specs/story-6.6-cbu.md.`);
  assert.strictEqual(claimWithoutStory({ transcript_path: p, cwd: d }, { hasMark: true }), null);
  // la misma ruta sin el archivo: frena y la nombra
  const d2 = dir();
  assert.match(claimWithoutStory({ transcript_path: turnoFallido(d2, `${CLAIM} Está en specs/story-6.6-cbu.md.`), cwd: d2 }, { hasMark: true }), /story-6\.6-cbu\.md no existe/);
});

test('T4 Claim_FueraDeAlcance_Pasa: sin la skill, en el segundo cierre o sin decir «creé», no frena', () => {
  const d = dir();
  const p = turnoFallido(d);
  assert.strictEqual(claimWithoutStory({ transcript_path: p, cwd: d }, { hasMark: false }), null);
  assert.strictEqual(claimWithoutStory({ transcript_path: p, cwd: d, stop_hook_active: true }, { hasMark: true }), null);
  assert.strictEqual(claimWithoutStory({ transcript_path: turnoFallido(d, 'La historia NO quedó escrita: falló la escritura.'), cwd: d }, { hasMark: true }), null);
  // una negación en una oración no tapa la afirmación de la otra
  assert.notStrictEqual(claimWithoutStory({ transcript_path: turnoFallido(d, `No encontré la tabla. ${CLAIM}`), cwd: d }, { hasMark: true }), null);
});

test('T5 Claim_HookDeCierre_Frena: el cierre de Claude Code devuelve «block» con la constancia de la skill', () => {
  const home = dir();
  const d = dir();
  const sid = 'sesion-claim';
  const marks = path.join(home, '.claude', '.tycon-pipeline', 'skill-marks');
  fs.mkdirSync(marks, { recursive: true });
  // stable-data: la constancia tiene que ser de ahora: el cierre la compara con su propio reloj y vence a las 2 horas
  fs.writeFileSync(path.join(marks, `${sid}.json`), JSON.stringify({ skill: 'tycon-create-story', at: new Date().toISOString(), sessionId: sid }));
  const input = JSON.stringify({ session_id: sid, transcript_path: turnoFallido(d), cwd: d, hook_event_name: 'Stop' });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const r = spawnSync(process.execPath, [GATE], { input, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).decision, 'block');
  // sin la constancia, el mismo cierre pasa callado
  fs.rmSync(path.join(marks, `${sid}.json`));
  const r2 = spawnSync(process.execPath, [GATE], { input, env, encoding: 'utf8' });
  assert.strictEqual(r2.stdout, '');
});

// ── El cierre insiste mientras quede un borrador sin validar ───────────────────────────────────────────────────
// El caso: un modelo abierto escribió la historia en borrador, nunca corrió el validador y cerró con «creada y
// verificada». El cierre le da la orden concreta, hasta un tope; si no avanza, deja cerrar y se lo dice a la persona.
const { insistir } = require('../lib/story-claim-check.js');

/** Un laboratorio: HOME con la conversación de la sesión (encadenada) y un repo bajo el arnés con las historias. */
function laboratorio(sid, historias) {
  const home = dir();
  const repo = fs.realpathSync(dir());
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.mkdirSync(path.join(repo, 'specs'));
  const rutas = historias.map(([nombre, estado]) => {
    const f = path.join(repo, 'specs', nombre);
    fs.writeFileSync(f, STORY.replace('status: draft', `status: ${estado}`));
    return f;
  });
  const conv = path.join(home, '.claude', 'projects', '-lab');
  fs.mkdirSync(conv, { recursive: true });
  const st = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(st, { recursive: true });
  return { home, repo, rutas, st, archivo: path.join(conv, `${sid}.jsonl`) };
}
/** Escribe la conversación encadenada y devuelve el evento del cierre. */
function conversacionDeCierre(lab, sid, registros) {
  let padre = null;
  const out = registros.map((r, i) => { const u = `${sid}-${i}`; const x = { ...r, uuid: u, parentUuid: padre }; padre = u; return x; });
  fs.writeFileSync(lab.archivo, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { session_id: sid, transcript_path: lab.archivo, cwd: lab.repo, hook_event_name: 'Stop' };
}
const escribe = (id, f) => [assistant([{ type: 'tool_use', id, name: 'Write', input: { file_path: f, content: STORY } }]), result(id, 'File created successfully', false)];
const valida = (id, f) => [assistant([{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'tycon-story-validator', prompt: `Validar la story en ${f}` } }]), result(id, 'Veredicto: limpio', false)];
const cierre = (lab, ev) => insistir(ev, { stateDir: lab.st, home: lab.home });

test('T15 Cierre_BorradorSinValidar_Insiste: frena con la orden y la ruta de la que falta, hasta 3 veces; la ya pasada a ready-for-dev no se nombra', () => {
  const sid = 's-insiste';
  const lab = laboratorio(sid, [['story-6.6-cbu.md', 'draft'], ['story-6.7-alias.md', 'ready-for-dev']]);
  const [borrador, autorizada] = lab.rutas;
  // la segunda la pasó a ready-for-dev la persona con su frase: ya no es un borrador y no cuenta como pendiente
  let regs = [user('creá dos historias'), ...escribe('w1', borrador), ...escribe('w2', autorizada), assistant([{ type: 'text', text: 'Listo.' }])];
  let ev = conversacionDeCierre(lab, sid, regs);
  for (let i = 1; i <= 3; i++) {
    // cada vuelta aparece una constancia nueva (de otra historia): hay avance, y el tope es el que corta
    if (i > 1) { regs = [...regs, ...valida(`v${i}`, path.join(lab.repo, 'specs', `otra-${i}.md`))]; ev = conversacionDeCierre(lab, sid, regs); }
    const r = cierre(lab, { ...ev, stop_hook_active: i > 1 });
    assert.ok(r && r.block, `vuelta ${i}: tenía que frenar`);
    assert.match(r.block, /falta validar/);
    assert.ok(r.block.includes(borrador), r.block);
    assert.match(r.block, /tycon-story-validator/);
    assert.ok(!r.block.includes(autorizada), 'la que no está en borrador no se nombra');
  }
  regs = [...regs, ...valida('v4', path.join(lab.repo, 'specs', 'otra-4.md'))];
  const cuarta = cierre(lab, { ...conversacionDeCierre(lab, sid, regs), stop_hook_active: true });
  assert.ok(cuarta && !cuarta.block && cuarta.aviso, 'agotado el tope deja cerrar y avisa');
  // con la constancia de la historia, el cierre no insiste más
  const sid2 = 's-validada';
  const lab2 = laboratorio(sid2, [['story-6.6-cbu.md', 'draft']]);
  const ev2 = conversacionDeCierre(lab2, sid2, [user('creá una historia'), ...escribe('w1', lab2.rutas[0]), ...valida('v1', lab2.rutas[0])]);
  assert.strictEqual(cierre(lab2, ev2), null);
  // la conversación es la del cierre (transcript_path); sin ella, la de la sesión
  const sid3 = 's-fuente';
  const lab3 = laboratorio(sid3, [['story-6.6-cbu.md', 'draft']]);
  const sinValidar = conversacionDeCierre(lab3, sid3, [user('creá una historia'), ...escribe('w1', lab3.rutas[0])]);
  const copia = path.join(dir(), 'cierre.jsonl');
  fs.copyFileSync(lab3.archivo, copia);
  const conValidar = [user('creá una historia'), ...escribe('w1', lab3.rutas[0]), ...valida('v1', lab3.rutas[0])];
  let padre = null;
  fs.writeFileSync(copia, conValidar.map((r, i) => { const x = { ...r, uuid: `c-${i}`, parentUuid: padre }; padre = x.uuid; return JSON.stringify(x); }).join('\n') + '\n');
  assert.strictEqual(cierre(lab3, { ...sinValidar, transcript_path: copia }), null, 'manda la conversación del cierre');
  assert.ok(cierre(lab3, { ...sinValidar, transcript_path: undefined }).block, 'sin transcript_path, la de la sesión');
  // no cuentan: una escritura que falló, un archivo que no es .md, ni un borrador en un repo fuera del arnés
  const sid4 = 's-no-cuentan';
  const lab4 = laboratorio(sid4, [['story-6.6-cbu.md', 'draft'], ['story-6.8-notas.txt', 'draft']]);
  const suelto = path.join(fs.realpathSync(dir()), 'story-9.9.md');
  fs.writeFileSync(suelto, STORY);
  const ev4 = conversacionDeCierre(lab4, sid4, [user('creá una historia'),
    assistant([{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: lab4.rutas[0], content: STORY } }]), result('w1', 'permission denied', true),
    ...escribe('w2', lab4.rutas[1]), ...escribe('w3', suelto)]);
  assert.strictEqual(cierre(lab4, ev4), null);
  // ni un archivo que dice `story:` sólo en el cuerpo
  const sid4b = 's-cuerpo';
  const lab4b = laboratorio(sid4b, [['notas.md', 'draft']]);
  fs.writeFileSync(lab4b.rutas[0], '---\ntitle: notas\nstatus: draft\n---\nstory: no es una historia\n');
  assert.strictEqual(cierre(lab4b, conversacionDeCierre(lab4b, sid4b, [user('anotá'), ...escribe('w1', lab4b.rutas[0])])), null);
  // el borrador creado por la terminal también cuenta: un heredoc y el guion del camino sin BMAD
  const sid5 = 's-terminal';
  const lab5 = laboratorio(sid5, [['story-6.6-cbu.md', 'draft'], ['story-6.9-guion.md', 'draft']]);
  const heredoc = { ...assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: `cat > specs/story-6.6-cbu.md <<'EOF'\n${STORY}EOF` } }]), cwd: lab5.repo };
  const guion = assistant([{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'node ~/.claude/skills/tycon-create-story/scripts/story-without-bmad.js write --repo . --answers a.json' } }]);
  const r5 = cierre(lab5, conversacionDeCierre(lab5, sid5, [user('creá dos historias'), heredoc, result('b1', '', false), guion, result('b2', JSON.stringify({ path: lab5.rutas[1], story: '6.9' }), false)]));
  assert.ok(r5 && r5.block && r5.block.includes(lab5.rutas[0]) && r5.block.includes(lab5.rutas[1]), r5 && r5.block);
  // el apagado commiteado del repo (pipeline.story_skill_gate: false) apaga también el cierre
  const sid6 = 's-repo-off';
  const lab6 = laboratorio(sid6, [['story-6.6-cbu.md', 'draft']]);
  fs.rmSync(path.join(lab6.repo, '.git'), { recursive: true });
  const git = (...a) => spawnSync('git', ['-C', lab6.repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...a], { stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(lab6.repo, '.tycon', 'advisors.yaml'), 'pipeline:\n  story_skill_gate: false\n');
  git('add', '.tycon'); git('commit', '-qm', 'off');
  assert.strictEqual(cierre(lab6, conversacionDeCierre(lab6, sid6, [user('creá una historia'), ...escribe('w1', lab6.rutas[0])])), null);
});

test('T16 Cierre_SinAvanceOTope_AvisaALaPersona: dos cierres seguidos sin constancia nueva dejan cerrar con el aviso en llano', () => {
  const sid = 's-sin-avance';
  const lab = laboratorio(sid, [['story-6.6-cbu.md', 'draft']]);
  const ev = conversacionDeCierre(lab, sid, [user('creá una historia'), ...escribe('w1', lab.rutas[0]), assistant([{ type: 'text', text: 'Listo.' }])]);
  assert.ok(cierre(lab, ev).block, 'primer cierre: insiste');
  assert.ok(cierre(lab, { ...ev, stop_hook_active: true }).block, 'segundo cierre sin avance: insiste');
  const r = cierre(lab, { ...ev, stop_hook_active: true });
  assert.ok(r && !r.block, 'tercer cierre sin avance: deja cerrar');
  assert.match(r.aviso, /quedó en borrador porque no se validó/);
  assert.ok(r.aviso.includes(lab.rutas[0]));
  assert.match(r.aviso, /el agente no corrió el validador/);
  // ya avisada, no vuelve a insistir con esa historia
  assert.strictEqual(cierre(lab, ev), null);
  // el conteo es por historia: un borrador nuevo de la misma sesión arranca de cero (insiste, no avisa de entrada)
  const otra = path.join(lab.repo, 'specs', 'story-6.7-alias.md');
  fs.writeFileSync(otra, STORY);
  const ev3 = conversacionDeCierre(lab, sid, [user('creá una historia'), ...escribe('w1', lab.rutas[0]), ...escribe('w2', otra)]);
  const nueva = cierre(lab, ev3);
  assert.ok(nueva && nueva.block && nueva.block.includes(otra), 'la historia nueva tiene sus propias vueltas');
  // el aviso le llega a la persona por el hook del cierre de Claude Code, sin frenar
  const sid2 = 's-hook';
  const lab2 = laboratorio(sid2, [['story-6.6-cbu.md', 'draft']]);
  const input = JSON.stringify(conversacionDeCierre(lab2, sid2, [user('creá una historia'), ...escribe('w1', lab2.rutas[0])]));
  const env = { ...process.env, HOME: lab2.home, USERPROFILE: lab2.home };
  const salidas = [1, 2, 3].map(() => spawnSync(process.execPath, [GATE], { input, env, encoding: 'utf8' }));
  assert.deepStrictEqual(salidas.slice(0, 2).map((s) => JSON.parse(s.stdout).decision), ['block', 'block']);
  const ultima = JSON.parse(salidas[2].stdout);
  assert.strictEqual(ultima.decision, undefined);
  assert.match(ultima.systemMessage, /quedó en borrador/);
});

test('T17 Cierre_CreadaSinConstancia_Frena: «creada y verificada» con el archivo escrito y sin el validador frena', () => {
  const sid = 's-creada';
  const lab = laboratorio(sid, [['story-6.6-cbu.md', 'draft']]);
  const ev = conversacionDeCierre(lab, sid, [user('creá una historia'), ...escribe('w1', lab.rutas[0]),
    assistant([{ type: 'text', text: `La historia ha sido creada y verificada físicamente en el disco: ${lab.rutas[0]}` }])]);
  const r = cierre(lab, ev);
  assert.ok(r && r.block, 'tenía que frenar');
  assert.match(r.block, /no está verificada/);
  // el control de antes (#456) la dejaba pasar: el archivo existe
  assert.strictEqual(claimWithoutStory(ev, { hasMark: true }), null);
});
