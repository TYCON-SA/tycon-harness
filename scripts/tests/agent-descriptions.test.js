'use strict';
// agent-descriptions.test.js — la descripción de cada agente es corta y conserva cuándo invocarlo.
//
// La descripción viaja en cada sesión (la lista de agentes que ve el agente principal) y sólo sirve para elegir uno a
// mano: el pipeline los lanza por su nombre. Por eso va en 200 caracteres o menos. Lo que no se puede perder al
// acortarla es el disparador: fuera del pipeline, el agente principal decide con él si corresponde invocar al revisor.
// El examen de revisores no la mide (arma cada revisor con su cuerpo, su modelo y sus herramientas).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MAX = 200;

/** La descripción del frontmatter de un agente, o null. */
function descriptionOf(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const line = m[1].split('\n').find((l) => /^description:/.test(l));
  return line ? line.replace(/^description:\s*/, '').trim() : null;
}
/** Los agentes del árbol: los de agents/ y, si la capa del equipo está puesta, los de cada paquete. */
function agentFiles() {
  const out = [];
  const list = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)); } catch (_) { return []; } };
  out.push(...list(path.join(ROOT, 'agents')));
  let packs = [];
  try { packs = fs.readdirSync(path.join(ROOT, 'packs'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { packs = []; }
  for (const p of packs) out.push(...list(path.join(ROOT, 'packs', p, 'agents')));
  return out;
}

// el disparador de cada agente condicional del núcleo: palabras que la descripción corta tiene que seguir nombrando
const TRIGGERS = {
  'tycon-dod-runtime-checker': ['review', 'commit-prep'],
  'tycon-silent-failure-hunter': ['.cs', '.tsx', 'catch'],
  'tycon-e2e-realness-checker': ['tests/e2e', 'spec.ts'],
  'tycon-signed-scope-audit': ['sprint-plan.md'],
  'i18n-hardcoded-text-reviewer': ['i18n.required'],
  'tycon-spec-first-checker': ['«Implementar»'],
  'llm-cost-reviewer': ['@anthropic-ai/sdk'],
  'tycon-story-validator': ['«Implementar»'],
  'tycon-deferral-tracker': ['pipelines', '.skip()'],
  'tycon-ac-coverage-checker': ['review', 'done'],
  'tycon-retrospective-capturer': ['post-merge'],
  'tycon-plugin-tests-coverage': ['post-implementación'],
  'tycon-plugin-security-basics': ['post-implementación'],
};

test('DescripcionDeAgente_DoscientosCaracteresOMenos', () => {
  const files = agentFiles();
  assert.ok(files.length > 0, 'hay agentes en el árbol');
  const largas = files.map((f) => [path.relative(ROOT, f), descriptionOf(f)]).filter(([, d]) => d !== null && [...d].length > MAX)
    .map(([f, d]) => `${f} (${[...d].length})`);
  assert.deepStrictEqual(largas, [], `descripciones de más de ${MAX} caracteres`);
});

test('DescripcionCondicional_ConservaSuDisparador', () => {
  for (const [name, words] of Object.entries(TRIGGERS)) {
    const file = path.join(ROOT, 'agents', `${name}.md`);
    const d = descriptionOf(file);
    assert.ok(d, `${name}: tiene descripción`);
    for (const w of words) assert.ok(d.includes(w), `${name}: la descripción nombra su disparador «${w}» (${d})`);
  }
});

// Desde que el pipeline arma el plan e implementa sin las skills de BMAD, tres revisores seguían diciendo
// que BMAD planifica o implementa: una instrucción falsa sobre el camino que revisan.
test('Revisores_NoDicenQueBmadPlanificaOImplementa @story-8.305', () => {
  const FALSO = /bmad-dev-story|bmad-create-architecture|BMAD genera el plan|ejecutor BMAD|pre-BMAD/i;
  for (const name of ['tycon-spec-first-checker', 'tycon-story-validator', 'tycon-plugin-tests-coverage']) {
    const lineas = fs.readFileSync(path.join(ROOT, 'agents', `${name}.md`), 'utf8').split('\n')
      .map((l, i) => [i + 1, l]).filter(([, l]) => FALSO.test(l)).map(([n, l]) => `${n}: ${l.trim().slice(0, 100)}`);
    assert.deepStrictEqual(lineas, [], `${name}: todavía nombra a BMAD como quien planifica o implementa`);
  }
});
