#!/usr/bin/env node
/**
 * pipeline-command-paths.test.js — las instrucciones dan el comando del pipeline con su ruta entera.
 *
 * El caso: con Codex, gemma corrió `pipeline.js start` sin ruta (command not found) y después lo buscó con `find` donde
 * decía el AGENTS.md. Las skills de Codex son enlaces al arnés y `find` sin `-L` no entra en un enlace: concluyó «no
 * existe» y nunca arrancó el pipeline. Con el comando entero no hay nada que buscar.
 *
 * T1-T3, T7 y T8 generan el bloque del índice de Codex (agents-md-blocks.js) con HOME temporal; T3 despliega la skill
 * como enlace, igual que build/deploy-shared-skills.js, y corre los guiones por la ruta dada; T7 y T8 pasan el comando
 * por la terminal con rutas raras (espacios, `$(…)`, acento grave, comillas) y miran que llegue entero sin ejecutar
 * nada. T4-T6 revisan los textos que lee el modelo: ninguna orden del pipeline sin ruta.
 *
 * Correr: node --test scripts/tests/pipeline-command-paths.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const A = () => require(path.join(ROOT, 'scripts', 'setup', 'agents-md-blocks.js'));
const SKILL = path.join(ROOT, 'skills', 'tycon-pipeline');

// Una orden del pipeline es un texto entre comillas invertidas, o una línea de un bloque de código, que empieza con el
// nombre del guion (con `node ` delante o sin él): sin carpeta delante, el modelo no sabe dónde está.
const ORDEN_SIN_RUTA = /^(?:node\s+)?(?:pipeline|marker)\.js(?:\s|$)/;
function ordenesSinRuta(texto) {
  const malas = [];
  let enBloque = false;
  texto.split('\n').forEach((linea, i) => {
    if (/^\s*```/.test(linea)) { enBloque = !enBloque; return; }
    const trozos = enBloque ? [linea.trim()] : [...linea.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    for (const t of trozos) if (ORDEN_SIN_RUTA.test(t)) malas.push({ linea: i + 1, orden: t });
  });
  return malas;
}

function lab() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-paths-')));
  const blocks = path.join(dir, 'claude-md-blocks');
  fs.mkdirSync(path.join(blocks, 'names'), { recursive: true });
  fs.writeFileSync(path.join(blocks, 'style.md'), '# Estilo\nregla de estilo\n');
  fs.writeFileSync(path.join(blocks, 'tool-names.md'), '# Nombres (lado Claude)\nAskUserQuestion\n');
  fs.writeFileSync(path.join(blocks, 'names', 'tool-names.codex.md'), '# Nombres (lado Codex)\nrequest_user_input\n');
  fs.writeFileSync(path.join(dir, 'INDEX.md'), '# Índice\n');
  const home = path.join(dir, 'casa');
  fs.mkdirSync(home, { recursive: true });
  return { dir, blocks, home, target: path.join(home, '.codex', 'AGENTS.md') };
}
function bloque(l, extra = {}) {
  A().sync(Object.assign({ blocksDir: l.blocks, target: l.target, integrations: {}, profile: 'minimal', tree: l.dir, home: l.home, env: {}, quiet: true }, extra));
  const t = fs.readFileSync(l.target, 'utf8');
  const i = t.indexOf('<!-- TYCON_BLOCK:harness-index START');
  const j = t.indexOf('<!-- TYCON_BLOCK:harness-index END -->', i);
  assert.ok(i !== -1 && j !== -1, 'el bloque del índice está en el AGENTS.md');
  return t.slice(t.indexOf('\n', i) + 1, j);
}

test('Bloque_DaElComandoEntero @story-8.110 @ac-1', () => {
  const l = lab();
  const b = bloque(l);
  assert.ok(b.includes('`node ~/.codex/skills/tycon-pipeline/scripts/pipeline.js <subcomando>`'), b);
  assert.ok(b.includes('`node ~/.codex/skills/tycon-pipeline/scripts/marker.js <subcomando>`'), b);
  assert.match(b, /enlaces/);
  assert.match(b, /find -L/);
  // con CODEX_HOME, las skills de esa carpeta
  const l2 = lab();
  const b2 = bloque(l2, { env: { CODEX_HOME: path.join(l2.home, 'codex-propio') } });
  assert.ok(b2.includes('`node ~/codex-propio/skills/tycon-pipeline/scripts/pipeline.js <subcomando>`'), b2);
});

test('Bloque_CarpetaConEspacios_ElComandoAnda @story-8.110 @ac-1', () => {
  // el pase adversarial: en macOS/Linux el comando iba sin comillas y una carpeta de skills con espacios lo partía
  const argumentos = (cmd, home) => spawnSync('bash', ['-c', cmd.replace(/^node /, 'printf "%s\\n" ')], { encoding: 'utf8', env: { ...process.env, HOME: home } })
    .stdout.split('\n').filter(Boolean);
  for (const sub of [['afuera', 'otro disco/codex'], ['adentro', 'mi codex']]) {
    const l = lab();
    const codexHome = sub[0] === 'afuera' ? path.join(l.dir, sub[1]) : path.join(l.home, sub[1]);
    const b = bloque(l, { platform: 'linux', env: { CODEX_HOME: codexHome } });
    const m = b.match(/`(node [^`]*pipeline\.js[^`]*) <subcomando>`/);
    assert.ok(m, b);
    const a = argumentos(m[1], l.home);
    assert.deepStrictEqual(a, [path.join(codexHome, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js')], `${sub[0]}: ${m[1]}`);
  }
  // sin espacios queda la forma corta con ~
  assert.ok(bloque(lab(), { platform: 'linux' }).includes('`node ~/.codex/skills/tycon-pipeline/scripts/pipeline.js <subcomando>`'));
});

test('Bloque_RutaConDolarOAcento_NoEjecutaNada @story-8.110 @ac-1 @ac-2', () => {
  // el revisor de seguridad: entre comillas dobles, `$(…)` y el acento grave se ejecutan al pegar el comando
  const l = lab();
  const testigo = path.join(l.dir, 'testigo');
  const raro = path.join(l.dir, `a $(touch ${testigo}) \`touch ${testigo}\` b'c`);
  const b = bloque(l, { platform: 'linux', env: { CODEX_HOME: raro } });
  // el nombre trae un acento grave: el bloque lo pone entre dobles comillas invertidas de Markdown
  const m = b.match(/`` (node '.*?pipeline\.js') <subcomando> ``/);
  assert.ok(m, b);
  const a = spawnSync('bash', ['-c', m[1].replace(/^node /, 'printf "%s\\n" ')], { encoding: 'utf8', env: { ...process.env, HOME: l.home } }).stdout.split('\n').filter(Boolean);
  assert.deepStrictEqual(a, [path.join(raro, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js')], m[1]);
  assert.strictEqual(fs.existsSync(testigo), false, 'el comando pegado no ejecutó nada');
  // en Windows, la misma ruta va entre comillas simples de PowerShell (literales), con la comilla simple doblada
  const w = bloque(lab(), { platform: 'win32', env: { CODEX_HOME: 'D:\\otro\\a $(calc) `b c\'d' } });
  assert.ok(w.includes("`` node 'D:\\otro\\a $(calc) `b c''d\\skills\\tycon-pipeline\\scripts\\pipeline.js' <subcomando> ``"), w);
  assert.ok(!/node "[^"]*\$\(/.test(w), 'ningún $( dentro de comillas dobles');
  // PowerShell toma también las comillas tipográficas como comillas: van dobladas, y ninguna ruta rara usa comillas dobles
  const t = bloque(lab(), { platform: 'win32', env: { CODEX_HOME: 'D:\\x ”; calc; “ y ‘z’' } });
  assert.ok(t.includes("`node 'D:\\x ”; calc; “ y ‘‘z’’\\skills\\tycon-pipeline\\scripts\\pipeline.js' <subcomando>`"), t);
  // una ruta con caracteres seguros (letras, números, espacio, punto, guiones) sigue con la forma de comillas dobles
  const s = bloque(lab(), { platform: 'win32', env: { CODEX_HOME: 'D:\\mi carpeta\\codex-1.2' } });
  assert.ok(s.includes('`node "D:\\mi carpeta\\codex-1.2\\skills\\tycon-pipeline\\scripts\\pipeline.js" <subcomando>`'), s);
});

test('Bloque_EnWindows_UsaUSERPROFILE @story-8.110 @ac-2', () => {
  const l = lab();
  const b = bloque(l, { platform: 'win32' });
  assert.ok(b.includes('`node "$env:USERPROFILE\\.codex\\skills\\tycon-pipeline\\scripts\\pipeline.js" <subcomando>`'), b);
  assert.ok(b.includes('`node "$env:USERPROFILE\\.codex\\skills\\tycon-pipeline\\scripts\\marker.js" <subcomando>`'), b);
  // las skills fuera de la carpeta del usuario: la ruta absoluta, sin $env
  const l2 = lab();
  const afuera = path.join(l2.dir, 'otro-disco', 'codex');
  const b2 = bloque(l2, { platform: 'win32', env: { CODEX_HOME: afuera } });
  const abs = path.join(afuera, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js').split('/').join('\\');
  assert.ok(b2.includes(`\`node "${abs}" <subcomando>\``), b2);
  assert.ok(!b2.includes('$env:USERPROFILE'), b2);
});

test('RutaDada_AndaAtravesDeUnEnlace @story-8.110 @ac-3', () => {
  const l = lab();
  // la skill desplegada como enlace, como build/deploy-shared-skills.js
  fs.mkdirSync(path.join(l.home, '.codex', 'skills'), { recursive: true });
  fs.symlinkSync(SKILL, path.join(l.home, '.codex', 'skills', 'tycon-pipeline'));
  const b = bloque(l);
  const comando = (guion) => {
    const m = b.match(new RegExp('`node (~/\\.codex/skills/tycon-pipeline/scripts/' + guion + ') <subcomando>`'));
    assert.ok(m, `el bloque da el comando de ${guion}`);
    return m[1].replace(/^~/, l.home);
  };
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-paths-repo-'));
  const env = { ...process.env, HOME: l.home, USERPROFILE: l.home, CODEX_SESSION_ID: 'cmd-paths' };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.TYCON_SESSION_ID; delete env.CLAUDE_CONFIG_DIR;
  const marker = spawnSync(process.execPath, [comando('marker.js'), 'get'], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(marker.status, 0, marker.stderr);
  const next = spawnSync(process.execPath, [comando('pipeline.js'), 'next'], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
  assert.doesNotMatch(next.stderr + next.stdout, /Cannot find module/, 'el guion se encontró por la ruta dada');
  assert.ok(next.stdout.trim().length > 0, `pipeline.js next contestó: ${next.stderr}`);
  // el caso de gemma: find sin -L no entra en el enlace; con -L sí
  const sinL = spawnSync('find', [path.join(l.home, '.codex', 'skills', 'tycon-pipeline'), '-name', 'pipeline.js'], { encoding: 'utf8' });
  const conL = spawnSync('find', ['-L', path.join(l.home, '.codex', 'skills', 'tycon-pipeline'), '-name', 'pipeline.js'], { encoding: 'utf8' });
  assert.strictEqual(sinL.stdout.trim(), '', 'find sin -L no entra en el enlace');
  assert.match(conL.stdout, /scripts\/pipeline\.js/, 'find -L sí');
});

test('Guias_SinOrdenesSinRuta @story-8.110 @ac-4 @ac-5', () => {
  const textos = {
    'INDEX.md': fs.readFileSync(path.join(ROOT, 'INDEX.md'), 'utf8'),
    'guides/integrations/ollama.md': fs.readFileSync(path.join(ROOT, 'guides', 'integrations', 'ollama.md'), 'utf8'),
    'guides/integrations/ollama.en.md': fs.readFileSync(path.join(ROOT, 'guides', 'integrations', 'ollama.en.md'), 'utf8'),
  };
  // el bloque generado con el INDEX.md real: cubre lo que se agregue al índice después
  const l = lab();
  fs.copyFileSync(path.join(ROOT, 'INDEX.md'), path.join(l.dir, 'INDEX.md'));
  textos['bloque del índice de Codex'] = bloque(l);
  for (const [nombre, t] of Object.entries(textos)) {
    const malas = ordenesSinRuta(t);
    assert.deepStrictEqual(malas, [], `${nombre}: órdenes del pipeline sin ruta:\n${malas.map((m) => `  línea ${m.linea}: ${m.orden}`).join('\n')}`);
  }
  // la skill dice, donde da la carpeta de los guiones, el comando entero con que se corren
  const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('`node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js <subcomando>`'), 'SKILL.md da el comando entero');
});

test('Prueba_FrenaUnaOrdenSinRuta @story-8.110 @ac-5', () => {
  const juguete = ['# Guía', '', 'Arrancá con `pipeline.js start --story x`.', '', 'Mirá el estado: `node marker.js get`.', '',
    '`pipeline.js start` avisa si algo falta.', '', 'Con ruta: `node ~/.codex/skills/tycon-pipeline/scripts/pipeline.js start`.',
    '```bash', 'pipeline.js next', '```'].join('\n');
  assert.deepStrictEqual(ordenesSinRuta(juguete).map((m) => m.linea), [3, 5, 7, 11]);
  assert.deepStrictEqual(ordenesSinRuta('`node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js get`'), []);
});

test('Ollama_ArranqueEnLasDosFormas @story-8.110 @ac-4', () => {
  for (const g of ['ollama.md', 'ollama.en.md']) {
    const t = fs.readFileSync(path.join(ROOT, 'guides', 'integrations', g), 'utf8');
    assert.match(t, /node ~\/\.codex\/skills\/tycon-pipeline\/scripts\/pipeline\.js start [^`\n]*--codex-session/, `${g}: el arranque con ~`);
    assert.match(t, /node "\$env:USERPROFILE\\\.codex\\skills\\tycon-pipeline\\scripts\\pipeline\.js" start [^`\n]*--codex-session/, `${g}: el arranque de Windows`);
  }
});
