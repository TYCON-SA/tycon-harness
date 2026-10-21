'use strict';
/**
 * windows-support.test.js — lo que el arnés promete en Windows sale de un archivo, y el archivo no puede prometer
 * sin evidencia.
 *
 * POR QUÉ EXISTE. Un instalador de Windows que no se midió en un Windows puede dejar hooks sin registrar, entre ellos los
 * dos frenos de comandos. La promesa no puede vivir en una frase, porque una frase no se puede cruzar con una medición:
 * es `scripts/setup/windows-support.json`, y estas reglas la atan a su evidencia:
 *   · `native` sólo vale `preparing`, `agent-measured` o `supported`; `recommended`, `wsl` o `native`;
 *   · `agent-measured` pide al menos una medición en un agente de Azure, con su número de corrida;
 *   · `supported` pide además una medición en una máquina real;
 *   · `recommended: native` sólo vale con `supported`;
 *   · cada pieza que queda afuera (`excluded`) dice qué es y por qué; cada «no medido» dice por qué.
 * Un archivo ilegible o con una clave que nadie conoce es un rojo: una lista rota no se lee como «no promete nada».
 *
 * No usa bash. Correr:   node scripts/tests/windows-support.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'setup', 'windows-support.json');
const STATES = ['preparing', 'agent-measured', 'supported'];
const PATHS = ['wsl', 'native'];
const HOW = ['azure-agent', 'real-machine'];
const KEYS = ['__doc', 'native', 'recommended', 'requirements', 'measured', 'excluded', 'not_measured'];

const text = (v) => typeof v === 'string' && v.trim().length > 0;

/** Las reglas que el archivo rompe, cada una por su nombre. Vacío = cumple. */
function supportProblems(s) {
  const problems = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['shape: el archivo no es un objeto'];
  for (const k of Object.keys(s)) if (!KEYS.includes(k)) problems.push(`unknown-key: «${k}» no es una clave de este archivo`);
  for (const k of KEYS) if (k !== '__doc' && !(k in s)) problems.push(`missing-key: falta «${k}»`);
  if (!STATES.includes(s.native)) problems.push(`closed-states: native vale ${JSON.stringify(s.native)} y sólo puede ser ${STATES.join(', ')}`);
  if (!PATHS.includes(s.recommended)) problems.push(`closed-states: recommended vale ${JSON.stringify(s.recommended)} y sólo puede ser ${PATHS.join(' o ')}`);

  const req = s.requirements;
  if (!req || typeof req !== 'object' || Array.isArray(req)) problems.push('requirements: tiene que ser un objeto con una lista por camino');
  else {
    for (const p of PATHS) {
      if (!Array.isArray(req[p]) || !req[p].length || !req[p].every(text)) problems.push(`requirements: «${p}» tiene que ser una lista no vacía de nombres`);
    }
    for (const k of Object.keys(req)) if (!PATHS.includes(k)) problems.push(`requirements: «${k}» no es un camino (${PATHS.join(', ')})`);
  }

  const measured = Array.isArray(s.measured) ? s.measured : null;
  if (!measured) problems.push('measured: tiene que ser una lista');
  for (const [i, m] of (measured || []).entries()) {
    if (!m || typeof m !== 'object') { problems.push(`measured[${i}]: no es una medición`); continue; }
    for (const k of ['os', 'arch']) if (!text(m[k])) problems.push(`measured[${i}]: falta «${k}»`);
    if (!HOW.includes(m.how)) problems.push(`measured[${i}]: how vale ${JSON.stringify(m.how)} y sólo puede ser ${HOW.join(' o ')}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.date || ''))) problems.push(`measured[${i}]: date tiene que ser una fecha AAAA-MM-DD`);
    if (m.how === 'azure-agent' && !(Number.isInteger(m.run) && m.run > 0)) problems.push(`measured[${i}]: una medición en un agente lleva su número de ejecución en «run»`);
  }
  const onAgent = (measured || []).some((m) => m && m.how === 'azure-agent' && Number.isInteger(m.run) && m.run > 0);
  const onRealMachine = (measured || []).some((m) => m && m.how === 'real-machine');
  if ((s.native === 'agent-measured' || s.native === 'supported') && !onAgent) {
    problems.push(`evidence-agent: native es «${s.native}» y no hay ninguna medición azure-agent con su número de ejecución`);
  }
  if (s.native === 'supported' && !onRealMachine) problems.push('evidence-real-machine: native es «supported» y no hay ninguna medición real-machine');
  if (s.recommended === 'native' && s.native !== 'supported') {
    problems.push(`recommended-native: recommended es «native» y native es «${s.native}»: sólo se recomienda el nativo cuando está «supported»`);
  }

  const named = (list, name, fields) => {
    if (!Array.isArray(list)) { problems.push(`${name}: tiene que ser una lista`); return; }
    const seen = new Set();
    for (const [i, e] of list.entries()) {
      if (!e || typeof e !== 'object') { problems.push(`${name}[${i}]: no es una entrada`); continue; }
      for (const f of fields) {
        if (!text(e[f])) problems.push(f === 'reason' ? `${name}-reason: ${name}[${i}] (${e.id || 'sin id'}) no dice por qué` : `${name}[${i}]: falta «${f}»`);
      }
      if (text(e.id) && seen.has(e.id)) problems.push(`${name}: «${e.id}» está dos veces`);
      seen.add(e.id);
    }
  };
  named(s.excluded, 'excluded', ['id', 'kind', 'reason']);
  named(s.not_measured, 'not_measured', ['id', 'reason']);
  return problems;
}

const real = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const copy = (change) => { const c = real(); change(c); return c; };
const AGENT = { os: 'Windows Server 2025', arch: 'x64', how: 'azure-agent', date: '2026-10-03', run: 12345 };
const MACHINE = { os: 'Windows 11', arch: 'x64', how: 'real-machine', date: '2026-10-05', run: null };

// ── T23 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('T23a WindowsSupport_RealFile — el archivo real cumple, con WSL recomendado', () => {
  const s = real();
  assert.deepStrictEqual(supportProblems(s), []);
  assert.strictEqual(s.recommended, 'wsl');
  assert.ok(text(s.__doc), 'el archivo dice qué es y quién lo lee');
  assert.ok(s.not_measured.length > 0, 'lo que nadie midió está dicho, no callado');
});

// ── T94 · el camino nativo medido por el agente ───────────────────────────────────────────────────────────────────────────
// El instalador de Windows registra los controles que puede, lo que queda
// afuera está acá con su motivo, y el camino nativo es «agent-measured» con la corrida que lo respalda. `recommended`
// no se toca sin una medición en una máquina real.
test('T94 WindowsSupport_ExcludedWithReasons_AgentMeasured — lo que queda afuera en Windows dice por qué, y «agent-measured» trae su ejecución', () => {
  const s = real();
  assert.deepStrictEqual(supportProblems(s), []);
  assert.strictEqual(s.native, 'agent-measured');
  assert.strictEqual(s.recommended, 'wsl', 'recommended no cambia sin una medición en una máquina real');
  const onAgent = s.measured.filter((m) => m.how === 'azure-agent');
  assert.ok(onAgent.length >= 1 && onAgent.every((m) => Number.isInteger(m.run) && m.run > 0), 'cada medición en un agente trae su número de ejecución');
  assert.ok(!s.measured.some((m) => m.how === 'real-machine'), 'ninguna máquina real midió todavía: si aparece una, esta prueba y `recommended` se revisan juntas');
  // los controles que el instalador de Windows NO registra: cada uno, un hook con su motivo escrito (no una palabra suelta)
  const hooks = s.excluded.filter((e) => e.kind === 'hook');
  for (const id of ['harness-bootstrap-heal.sh', 'pr-one-per-repo-guard.js', 'telegram-zombie-sweep.sh']) {
    const e = hooks.find((x) => x.id === id);
    assert.ok(e, `«${id}» queda afuera en Windows y no está en excluded`);
    assert.ok(e.reason.trim().length >= 40, `«${id}»: el motivo tiene que decir qué le falta en Windows, no «${e.reason}»`);
  }
  for (const e of s.excluded) assert.ok(text(e.id) && text(e.kind) && text(e.reason), `excluded: ${JSON.stringify(e)} no trae id, kind y reason`);
  // los espejos: sin la corrida, o con un motivo borrado, el mismo archivo deja de cumplir
  assert.match(supportProblems(copy((c) => { c.measured = []; })).join('\n'), /evidence-agent/);
  assert.match(supportProblems(copy((c) => { c.measured = c.measured.map((m) => ({ ...m, run: null })); })).join('\n'), /evidence-agent/);
  assert.match(supportProblems(copy((c) => { c.excluded[0].reason = ''; })).join('\n'), /excluded-reason: excluded\[0\]/);
  assert.match(supportProblems(copy((c) => { c.recommended = 'native'; })).join('\n'), /recommended-native/);
});

test('T23b WindowsSupport_ClosedStates — un estado o un camino que no existe es un rojo', () => {
  assert.match(supportProblems(copy((c) => { c.native = 'works'; })).join('\n'), /closed-states: native/);
  assert.match(supportProblems(copy((c) => { c.recommended = 'powershell'; })).join('\n'), /closed-states: recommended/);
  assert.match(supportProblems(copy((c) => { c.nativo = 'supported'; })).join('\n'), /unknown-key: «nativo»/);
  assert.match(supportProblems(copy((c) => { delete c.measured; })).join('\n'), /missing-key: falta «measured»/);
  assert.deepStrictEqual(supportProblems([]), ['shape: el archivo no es un objeto']);
});

test('T23c WindowsSupport_EvidenceRules — sin la medición que lo respalda, el estado no vale', () => {
  // agent-measured sin corrida
  assert.match(supportProblems(copy((c) => { c.native = 'agent-measured'; c.measured = []; })).join('\n'), /evidence-agent/);
  assert.match(supportProblems(copy((c) => { c.native = 'agent-measured'; c.measured = [{ ...AGENT, run: null }]; })).join('\n'), /evidence-agent/);
  assert.deepStrictEqual(supportProblems(copy((c) => { c.native = 'agent-measured'; c.measured = [AGENT]; })), []);
  // supported sin máquina real
  const sinMaquina = supportProblems(copy((c) => { c.native = 'supported'; c.measured = [AGENT]; }));
  assert.deepStrictEqual(sinMaquina.map((p) => p.split(':')[0]), ['evidence-real-machine']);
  // supported sólo con la máquina real: le falta la del agente
  assert.match(supportProblems(copy((c) => { c.native = 'supported'; c.measured = [MACHINE]; })).join('\n'), /evidence-agent/);
  assert.deepStrictEqual(supportProblems(copy((c) => { c.native = 'supported'; c.recommended = 'native'; c.measured = [AGENT, MACHINE]; })), []);
  // recommended: native sin supported
  assert.match(supportProblems(copy((c) => { c.recommended = 'native'; })).join('\n'), /recommended-native/);
  assert.match(supportProblems(copy((c) => { c.recommended = 'native'; c.native = 'agent-measured'; c.measured = [AGENT]; })).join('\n'), /recommended-native/);
  // una medición mal escrita
  assert.match(supportProblems(copy((c) => { c.measured = [{ ...AGENT, how: 'laptop' }]; })).join('\n'), /how vale "laptop"/);
  assert.match(supportProblems(copy((c) => { c.measured = [{ ...AGENT, date: 'ayer' }]; })).join('\n'), /date tiene que ser una fecha/);
});

test('T23d WindowsSupport_ExcludedHasReason — lo que queda afuera dice qué es y por qué', () => {
  const sinMotivo = supportProblems(copy((c) => { c.excluded = [{ id: 'scheduled-exam', kind: 'scheduled-task', reason: '  ' }]; }));
  assert.deepStrictEqual(sinMotivo, ['excluded-reason: excluded[0] (scheduled-exam) no dice por qué']);
  assert.match(supportProblems(copy((c) => { c.excluded = [{ id: 'x', reason: 'porque sí' }]; })).join('\n'), /excluded\[0\]: falta «kind»/);
  const repetido = { id: 'x', kind: 'hook', reason: 'usa ps y lsof' };
  assert.match(supportProblems(copy((c) => { c.excluded = [repetido, repetido]; })).join('\n'), /«x» está dos veces/);
  assert.deepStrictEqual(supportProblems(copy((c) => { c.excluded = [repetido]; })), []);
  assert.match(supportProblems(copy((c) => { c.not_measured = [{ id: 'arm64' }]; })).join('\n'), /not_measured-reason/);
  assert.match(supportProblems(copy((c) => { c.requirements = { wsl: ['wsl'], native: [] }; })).join('\n'), /requirements: «native»/);
});

module.exports = { supportProblems, STATES };
