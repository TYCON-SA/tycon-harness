#!/usr/bin/env node
/**
 * steps-no-skill-no-screen.test.js — «Armar el plan» y «Probar en vivo» dicen qué hacer en los casos donde un
 * modelo chico se trababa.
 *
 * El caso: midiendo gemma con la historia de juguete (una función `resta`), con Codex copió la invocación de Claude
 * Code (`Skill(…, args: "Cargar story en …")`) y corrió la skill como programa con `node`; con Claude Code se trabó dos
 * veces en «Probar en vivo», porque el paso no traía la prueba real de una función sin pantalla ni servidor.
 *
 * T1-T3 leen los pasos. T4 y T5 corren el ejemplo de «Probar en vivo», sacado del paso tal cual, sobre un repo de
 * juguete con HOME temporal: smoke-run.sh y runtime-matrix.js de verdad.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/steps-no-skill-no-screen.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const STEPS = path.join(SCRIPTS, '..', 'steps');
const leer = (f) => fs.readFileSync(path.join(STEPS, f), 'utf8');

// el cuerpo de una sección hasta la próxima del mismo nivel o mayor; un `#` dentro de un bloque de código no es título
function seccion(texto, titulo) {
  const i = texto.indexOf(titulo);
  assert.ok(i !== -1, `falta la sección «${titulo}»`);
  const nivel = /^#+/.exec(titulo)[0].length;
  const lineas = texto.slice(i + titulo.length).split('\n');
  let enBloque = false;
  const fin = lineas.findIndex((l) => {
    if (/^\s*```/.test(l)) enBloque = !enBloque;
    return !enBloque && new RegExp(`^#{1,${nivel}} `).test(l);
  });
  return (fin === -1 ? lineas : lineas.slice(0, fin)).join('\n');
}

test('Plan_ConCodex_SinHerramientaSkill @story-8.114 @ac-1', () => {
  const inv = seccion(leer('step-03-plan.md'), '## Invocación');
  const antes = inv.slice(0, inv.indexOf('Skill('));
  assert.match(antes, /Codex/);
  assert.match(antes, /~\/\.codex\/skills\/<skill>\/SKILL\.md/);
  assert.match(antes, /no se corre con `node`/);
  assert.doesNotMatch(inv, /node [^\n`]*index\.js/, 'nada invita a correr una skill como programa');
});

test('Plan_SinMetodo_LoEscribeElOrquestador @story-8.114 @ac-2', () => {
  const inv = seccion(leer('step-03-plan.md'), '## Invocación');
  assert.match(inv, /_bmad\/bmm\/config\.yaml/);
  assert.match(inv, /lo escribe el orquestador/);
  assert.match(inv, /step-02-bmad-plan\.md/);
  assert.match(inv, /node ~\/\.claude\/agent-skills\/skills\/tycon-pipeline\/scripts\/pipeline\.js run-dir --story <ruta> --repo <repo> --create/);
});

const ejemplo = () => {
  const s = seccion(leer('step-10-live-check.md'), '#### Una función sin pantalla ni servidor');
  const m = s.match(/```bash\n([\s\S]*?)```/);
  assert.ok(m, 'el apartado trae su ejemplo en un bloque de código');
  return { texto: s, comando: m[1].split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n') };
};

test('EnVivo_FuncionSinPantalla_Ejemplo @story-8.114 @ac-3', () => {
  const { texto, comando } = ejemplo();
  assert.match(comando, /smoke-run\.sh <evidence-dir> <ruta-de-la-story\.md> --acs 1/);
  assert.match(comando, /--pass-if '/);
  assert.match(comando, /-- node -e "/);
  assert.match(texto, /después del último cambio de código/);
  assert.match(texto, /`node --test`[^\n]*no cuenta/);
  assert.match(texto, /no es una salida/);
  assert.match(texto, /runtime_not_verifiable:/);
});

// un repo de juguete con `resta` y una story de dos criterios; corre el ejemplo con cada criterio y devuelve la matriz
function juguete(armarComando) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'en-vivo-8114-')));
  const casa = path.join(raiz, 'casa');
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(casa, { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'resta.js'), "'use strict';\nfunction resta(a, b) { return a - b; }\nmodule.exports = { resta };\n");
  const story = path.join(repo, 'specs', 'story-1.1.md');
  fs.writeFileSync(story, ['---', 'epic: 1', 'story: "1.1"', 'title: "Restar"', 'status: in-progress', '---', '# Story 1.1: Restar', '',
    '## Acceptance Criteria', '', '1. **Given** dos números **When** se llama a `resta(5, 3)` **Then** devuelve 2.',
    '2. **Given** un resultado negativo **When** se llama a `resta(2, 5)` **Then** devuelve -3.', ''].join('\n'));
  spawnSync('git', ['init', '-q', repo]);
  const env = { ...process.env, HOME: casa, USERPROFILE: casa };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_SESSION_ID; delete env.TYCON_SESSION_ID;
  const evid = path.join(repo, '.advisors', 'dod-runtime');
  for (const [ac, args] of [[1, '5, 3'], [2, '2, 5']]) {
    const cmd = armarComando(ac, args)
      .replace('~/.claude/agent-skills/skills/tycon-pipeline/scripts/smoke-run.sh', path.join(SCRIPTS, 'smoke-run.sh'))
      .replace('<evidence-dir>', evid).replace('<ruta-de-la-story.md>', story);
    const r = spawnSync('bash', ['-c', cmd], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, `el humo del criterio ${ac}: ${r.stdout}${r.stderr}`);
  }
  return spawnSync(process.execPath, [path.join(SCRIPTS, 'runtime-matrix.js'), '--story', story], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
}

test('EnVivo_ElEjemploDaVerde @story-8.114 @ac-4', () => {
  const { comando } = ejemplo();
  // el ejemplo, tal cual: para el criterio 2 cambian el número de criterio y los datos de ejemplo
  const m = juguete((ac, args) => comando.replace('--acs 1', `--acs ${ac}`).split('5, 3').join(args));
  assert.strictEqual(m.status, 0, m.stdout + m.stderr);
  assert.match(m.stdout + m.stderr, /2\/2 ACs corridos en runtime/);
});

test('EnVivo_NodeTestNoCuenta @story-8.114 @ac-3', () => {
  // el mismo humo con una prueba unitaria como comando: la matriz no lo da por corrido
  const m = juguete((ac) => `bash ~/.claude/agent-skills/skills/tycon-pipeline/scripts/smoke-run.sh <evidence-dir> <ruta-de-la-story.md> --acs ${ac} --pass-if 'las pruebas pasan' -- node --test --test-reporter=dot src/resta.js`);
  assert.notStrictEqual(m.status, 0, `una prueba unitaria no cuenta como ejecución:\n${m.stdout}`);
  assert.doesNotMatch(m.stdout + m.stderr, /2\/2 ACs corridos en runtime/);
});
