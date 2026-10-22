'use strict';
// decision-shape.test.js — el pedido de una decisión importante trae el contexto, cada opción con lo que gana y lo que
// cuesta, y la recomendación primero.
//
// Lo que no se puede perder:
//   · en el bloque de estilo, la forma arranca por la recomendación — T2;
//   · la portada del pipeline (COMM.i) remite a esa forma y mantiene la recomendación primero — T3;
//   · los pasos que piden una decisión (validar la historia, aprobar el plan, los hallazgos) la repiten en su plantilla — T4;
//   · Claude y Codex reciben el mismo texto, por sus sincronizadores — T5.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BLOCKS = path.join(ROOT, 'claude-md-blocks', 'response-style');
const PIPELINE = path.join(ROOT, 'skills', 'tycon-pipeline');
const SYNC_SH = path.join(ROOT, 'scripts', 'setup', 'sync-claude-md-blocks.sh');
const AGENTS = path.join(ROOT, 'scripts', 'setup', 'agents-md-blocks.js');
const read = (f) => fs.readFileSync(f, 'utf8');

const TITULO = { es: '**Decisión importante**', en: '**Important decision**' };
const RECOMENDACION = { es: 'recomendación en una línea', en: 'recommendation in one line' };

/** El párrafo de la decisión importante de un texto: desde su título hasta el renglón en blanco. */
function parrafo(texto, lang) {
  const i = texto.indexOf(TITULO[lang]);
  if (i < 0) return null;
  const j = texto.indexOf('\n\n', i);
  return llano(texto.slice(i, j < 0 ? undefined : j));
}
/** El texto en un renglón: los cortes de línea del archivo no parten una frase. */
const llano = (s) => s.replace(/\s+/g, ' ');

test('T2 Bloques_LaRecomendacionSigueArriba @story-1.28 @ac-2 — en cada variante la forma arranca por la recomendación', () => {
  for (const style of ['executive', 'detailed', 'neutral']) {
    for (const lang of ['es', 'en']) {
      const p = parrafo(read(path.join(BLOCKS, `${style}.${lang}.md`)), lang);
      assert.ok(p, `${style}.${lang}: trae el párrafo`);
      // la lista cerrada va entre paréntesis; lo primero después de ella es la recomendación
      const forma = p.slice(p.indexOf(')') + 1).replace(/^[\s:]+/, '');
      assert.ok(forma.startsWith(RECOMENDACION[lang]), `${style}.${lang}: la forma empieza por «${RECOMENDACION[lang]}» — «${forma.slice(0, 60)}»`);
    }
  }
});

test('T3 Pipeline_COMMi_NombraLaForma @story-1.28 @ac-3 — COMM.i remite a la forma y mantiene la recomendación primero', () => {
  const skill = read(path.join(PIPELINE, 'SKILL.md'));
  const i = skill.indexOf('**COMM.i');
  assert.ok(i >= 0, 'SKILL.md trae COMM.i');
  const comm = llano(skill.slice(i, skill.indexOf('\n- **', i + 1)));
  assert.match(comm, /la recomendación primero/, 'COMM.i sigue con la recomendación primero');
  assert.match(comm, /decisión importante/, 'COMM.i nombra la decisión importante');
  assert.match(comm, /contexto/, 'con su contexto');
  assert.match(comm, /lo que gana y lo que cuesta/, 'y cada opción con lo que gana y lo que cuesta');
});

test('T4 Pasos_PlantillasConContextoYProsContras @story-1.28 @ac-4 — validar la historia, aprobar el plan y los hallazgos piden contexto y pros y contras', () => {
  for (const f of ['step-01-validate-story.md', 'step-03-hitl-plan.md', 'step-07-hitl-approve.md']) {
    const t = read(path.join(PIPELINE, 'steps', f));
    const i = t.indexOf('decisión importante');
    assert.ok(i >= 0, `${f}: nombra la decisión importante`);
    // la plantilla misma de la pregunta: arranca por «Recomiendo» y, antes de la pregunta, trae el contexto y lo que gana
    // y lo que cuesta cada opción (no alcanza con que la prosa de al lado lo mencione)
    const r = t.indexOf('Recomiendo', i);
    assert.ok(r > i, `${f}: la plantilla de la pregunta arranca por la recomendación («Recomiendo …»)`);
    // hasta el fin del bloque de la plantilla (las opciones van después de la pregunta) o, si va en línea, hasta la pregunta
    const fence = t.indexOf('```', r);
    const plantilla = llano(fence > r && fence < r + 1500 ? t.slice(r, fence) : t.slice(r, t.indexOf('?', r) + 1));
    assert.ok(plantilla.length > 20, `${f}: la plantilla termina en la pregunta`);
    assert.match(plantilla, /contexto/, `${f}: la plantilla pide el contexto — «${plantilla.slice(0, 160)}»`);
    assert.match(plantilla, /gana/, `${f}: la plantilla pide lo que gana cada opción`);
    assert.match(plantilla, /cuesta/, `${f}: la plantilla pide lo que cuesta cada opción`);
    assert.ok(plantilla.indexOf('contexto') > 0, `${f}: la recomendación va antes que el contexto`);
  }
});

test('T5 Codex_RecibeLoMismo @story-1.28 @ac-1 @ac-2 — en las tres variantes, el bloque que escriben los dos sincronizadores trae el mismo párrafo', () => {
  for (const [style, lang] of ['executive', 'detailed', 'neutral'].flatMap((s) => [[s, 'es'], [s, 'en']])) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-shape-'));
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      const perfil = path.join(home, 'team-profile.json');
      fs.writeFileSync(perfil, JSON.stringify({ response: { language: lang, style, max_chars: 1300 }, integrations: { codex: true }, install: { profile: 'full' } }));
      const limpio = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TYCON_|CLAUDE_MD_PATH|CODEX_AGENTS_MD_PATH)/.test(k)));
      const env = Object.assign(limpio, { HOME: home, USERPROFILE: home, TYCON_PROFILE: perfil,
        CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'), CODEX_AGENTS_MD_PATH: path.join(home, '.codex', 'AGENTS.md') });
      const a = spawnSync('bash', [SYNC_SH], { env, encoding: 'utf8' });
      assert.strictEqual(a.status, 0, `Claude: ${a.stdout}${a.stderr}`);
      const b = spawnSync(process.execPath, [AGENTS], { env, encoding: 'utf8' });
      assert.strictEqual(b.status, 0, `Codex: ${b.stdout}${b.stderr}`);
      const deClaude = parrafo(read(env.CLAUDE_MD_PATH), lang);
      const deCodex = parrafo(read(env.CODEX_AGENTS_MD_PATH), lang);
      assert.ok(deClaude, `${style}.${lang}: CLAUDE.md trae el párrafo`);
      assert.strictEqual(deCodex, deClaude, `${style}.${lang}: AGENTS.md trae el mismo párrafo`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});
