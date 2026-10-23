'use strict';

/**
 * models-env.test.js — las variables que Claude Code necesita para que cada nivel use el modelo de la tabla del
 * proveedor de la máquina (scripts/lib/models-env.js).
 *
 * Lo que no se puede perder: con Ollama imprime las tres variables de los alias (haiku, sonnet, opus) desde la tabla y
 * nada más (ni la dirección base ni el token, que los pone la función de la guía); un nivel en «inherit» toma el modelo
 * de la sesión; con Anthropic o Cursor no imprime variables y dice por qué; el nivel máximo no tiene variable conocida.
 * Todo en laboratorios: el `team-repos.json` es de mentira (acme) y el ambiente se arma por argumento.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'lib', 'models-env.js');

/** Un laboratorio con el `team-repos.json` de la organización acme y la tabla de Ollama que se pasa. */
function laboratorio(ollama) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'models-env-'));
  const doc = {
    version: 1,
    public: { platform: 'github', org: 'acme', repo: 'harness' },
    profile: { platform: 'github', org: 'acme', repo: 'harness-profile' },
    operations: { platform: 'github', org: 'acme', repo: 'harness-ops' },
    models: { providers: { ollama } },
  };
  const file = path.join(d, 'team-repos.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}
function correr(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'models-env-home-')), ...env } });
}
const TRES = { economy: 'gemma4:31b-cloud', balanced: 'gpt-oss:120b-cloud', strong: 'gpt-oss:120b-cloud' };

test('T21 ModelsEnv_Ollama_ExportaLosTresAlias @story-2.73 @ac-17', () => {
  const r = correr(['--provider', 'ollama', '--org-config', laboratorio(TRES)]);
  assert.strictEqual(r.status, 0, r.stderr);
  const lineas = r.stdout.trim().split('\n');
  assert.deepStrictEqual(lineas, [
    'export ANTHROPIC_DEFAULT_HAIKU_MODEL="gemma4:31b-cloud"',
    'export ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-oss:120b-cloud"',
    'export ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-oss:120b-cloud"',
  ]);
  assert.doesNotMatch(r.stdout + r.stderr, /ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY/, 'ni la dirección base ni el token');
  // el proveedor también sale de la máquina (la variable)
  const porMaquina = correr(['--org-config', laboratorio(TRES)], { TYCON_MODEL_PROVIDER: 'ollama' });
  assert.strictEqual(porMaquina.stdout, r.stdout);
});

test('T22 ModelsEnv_Inherit_UsaElModeloDeLaSesion @story-2.73 @ac-18', () => {
  const org = laboratorio({ economy: 'gemma4:31b-cloud', balanced: 'inherit' });
  const shell = correr(['--provider', 'ollama', '--org-config', org]);
  assert.strictEqual(shell.status, 0, shell.stderr);
  assert.match(shell.stdout, /^export ANTHROPIC_DEFAULT_SONNET_MODEL="\$\{ANTHROPIC_MODEL\}"$/m, 'inherit: el de la sesión');
  assert.match(shell.stdout, /^export ANTHROPIC_DEFAULT_OPUS_MODEL="\$\{ANTHROPIC_MODEL\}"$/m, 'sin cargar: también');
  for (const formato of ['json', 'vscode']) {
    const r = correr(['--provider', 'ollama', '--org-config', org, '--format', formato]);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    const nombres = formato === 'json' ? Object.keys(j.variables) : j['claudeCode.environmentVariables'].map((v) => v.name);
    assert.deepStrictEqual(nombres, ['ANTHROPIC_DEFAULT_HAIKU_MODEL'], `${formato}: la variable en inherit se omite`);
    assert.ok(j.notes.some((n) => /ANTHROPIC_DEFAULT_SONNET_MODEL/.test(n)), `${formato}: va en notes`);
    assert.ok(j.notes.some((n) => /ANTHROPIC_DEFAULT_OPUS_MODEL/.test(n)), formato);
  }
});

test('T23 ModelsEnv_AnthropicYMax @story-2.73 @ac-18', () => {
  for (const prov of ['anthropic', 'cursor']) {
    const r = correr(['--provider', prov, '--org-config', laboratorio(TRES)]);
    assert.strictEqual(r.status, 0, `${prov}: ${r.stderr}`);
    assert.strictEqual(r.stdout, '', `${prov}: sin variables`);
    assert.match(r.stderr, prov === 'anthropic' ? /Anthropic.*no hace falta/ : /Cursor/, r.stderr);
  }
  const conMax = correr(['--provider', 'ollama', '--org-config', laboratorio({ ...TRES, max: 'qwen3:480b-cloud' })]);
  assert.strictEqual(conMax.status, 0, conMax.stderr);
  assert.doesNotMatch(conMax.stdout, /qwen3/, 'max no genera variable');
  assert.match(conMax.stderr, /máximo.*no tiene variable conocida/);
  assert.strictEqual(correr(['--provider', 'gemma', '--org-config', laboratorio(TRES)]).status, 2, 'un proveedor desconocido');
});

test('T23b ModelsEnv_ArgumentoSinValor_Y_LectorQueNoCarga @story-2.73 @ac-17 — sin valor o con un lector roto sale 2, no cae a otra cosa', () => {
  for (const args of [['--provider'], ['--provider', '--org-config', laboratorio(TRES)], ['--org-config'], ['--format']]) {
    const r = correr(args, { TYCON_MODEL_PROVIDER: 'ollama' });
    assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /sin valor/);
  }
  const org = laboratorio(TRES);
  const lib = path.join(path.dirname(org), 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'team-repos.js'), "require('./no-existe-acme.js');\n");
  const roto = correr(['--provider', 'ollama', '--org-config', org]);
  assert.strictEqual(roto.status, 2);
  assert.match(roto.stderr, /no-existe-acme/);
});
