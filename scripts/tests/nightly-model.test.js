'use strict';

/**
 * nightly-model.test.js — cómo un proceso de la noche elige proveedor y modelo (scripts/lib/nightly-model.js). Lo
 * consume el proceso de la noche que redacta los aprendizajes del equipo.
 *
 * Lo que no se puede perder: el modelo sale de `models.nightly` y de la tabla de su proveedor, con el tope y la lista
 * de permitidos; sin configuración, sin modelo, fuera de la lista o sin llave no cae en otra cosa (un estado y una
 * salida); el JSON trae siempre las mismas nueve claves; el valor de la llave no se imprime nunca. Todo en laboratorios
 * (`team-repos.json` de acme); el ambiente de cada caso se pasa por argumento, nunca el de la máquina.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'lib', 'nightly-model.js');
const NM = require(CLI);
const CLAVES = ['ok', 'status', 'provider', 'level', 'model', 'capped_from', 'secret', 'warnings', 'message'];

/** Un `team-repos.json` de laboratorio (acme) con `models`; un texto se escribe tal cual. */
function org(models, nombre = 'team-repos.json') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-model-'));
  const doc = {
    version: 1,
    public: { platform: 'github', org: 'acme', repo: 'harness' },
    profile: { platform: 'github', org: 'acme', repo: 'harness-profile' },
    operations: { platform: 'github', org: 'acme', repo: 'harness-ops' },
    ...(models !== undefined ? { models } : {}),
  };
  const file = path.join(d, nombre);
  fs.writeFileSync(file, typeof models === 'string' ? models : JSON.stringify(doc, null, 2));
  return file;
}
function correr(orgConfig, env = {}) {
  const r = spawnSync(process.execPath, [CLI, '--org-config', orgConfig, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no es JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const OLLAMA = { providers: { ollama: { economy: 'gemma4:31b-cloud', balanced: 'gpt-oss:120b-cloud' } } };

test('T27 Nightly_OllamaEconomy_Gemma @story-2.73 @ac-21', () => {
  const r = correr(org({ ...OLLAMA, nightly: { provider: 'ollama', level: 'economy' } }), { OLLAMA_API_KEY: 'x' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual([r.json.ok, r.json.status, r.json.provider, r.json.level, r.json.model], [true, 'ok', 'ollama', 'economy', 'gemma4:31b-cloud']);
  assert.deepStrictEqual(r.json.secret, { env: 'OLLAMA_API_KEY', present: true });
  // la función, con la ruta del archivo y el ambiente por argumento
  const f = NM.resolveNightly({ orgConfig: org({ ...OLLAMA, nightly: { provider: 'ollama' } }), env: { OLLAMA_API_KEY: 'x' } });
  assert.deepStrictEqual([f.ok, f.level, f.model], [true, 'economy', 'gemma4:31b-cloud'], 'sin nivel, economy');
  assert.deepStrictEqual(NM.NIGHTLY_SECRETS, { anthropic: 'ANTHROPIC_API_KEY', ollama: 'OLLAMA_API_KEY' });
});

test('T28 Nightly_CambioAAnthropic_Haiku @story-2.73 @ac-22', () => {
  const file = org({ ...OLLAMA, nightly: { provider: 'anthropic' } });
  const antes = fs.readFileSync(file, 'utf8');
  const r = correr(file, { ANTHROPIC_API_KEY: 'x' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual([r.json.provider, r.json.model, r.json.secret.env], ['anthropic', 'haiku', 'ANTHROPIC_API_KEY']);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), antes, 'no toca el archivo');
});

test('T29 Nightly_SinConfigurar_Sale3 @story-2.73 @ac-23', () => {
  for (const models of [OLLAMA, undefined]) {
    const r = correr(org(models), { OLLAMA_API_KEY: 'x', ANTHROPIC_API_KEY: 'x' });
    assert.strictEqual(r.status, 3, r.stdout);
    assert.deepStrictEqual([r.json.ok, r.json.status, r.json.model], [false, 'not-configured', null], 'sin modelo por defecto');
    assert.match(r.json.message, /models\.nightly/);
  }
});

test('T30 Nightly_SinModeloOFueraDeLaLista_Sale3 @story-2.73 @ac-23', () => {
  const casos = [
    [{ providers: { ollama: { balanced: 'gpt-oss:120b-cloud' } }, nightly: { provider: 'ollama' } }, 'no-model'],
    [{ providers: { ollama: { economy: 'inherit' } }, nightly: { provider: 'ollama' } }, 'no-model'],
    [{ ...OLLAMA, allowed: { ollama: ['gpt-oss:120b-cloud'] }, nightly: { provider: 'ollama' } }, 'not-allowed'],
    [{ allowed: { anthropic: ['sonnet'] }, nightly: { provider: 'anthropic' } }, 'not-allowed'],
  ];
  for (const [models, status] of casos) {
    const r = correr(org(models), { OLLAMA_API_KEY: 'x', ANTHROPIC_API_KEY: 'x' });
    assert.strictEqual(r.status, 3, JSON.stringify(models));
    assert.deepStrictEqual([r.json.ok, r.json.status], [false, status], JSON.stringify(models));
    assert.ok(r.json.message, 'dice qué falta');
  }
});

test('T31 Nightly_SinLlave_Sale4_NoImprimeElValor @story-2.73 @ac-24', () => {
  const file = org({ ...OLLAMA, nightly: { provider: 'ollama' } });
  for (const env of [{}, { OLLAMA_API_KEY: '' }, { OLLAMA_API_KEY: '$(OLLAMA_API_KEY)' }]) {
    const r = correr(file, env);
    assert.strictEqual(r.status, 4, JSON.stringify(env));
    assert.deepStrictEqual([r.json.status, r.json.provider, r.json.model, r.json.secret.env, r.json.secret.present], ['no-secret', 'ollama', 'gemma4:31b-cloud', 'OLLAMA_API_KEY', false]);
  }
  const con = correr(file, { OLLAMA_API_KEY: 's3cr3t' });
  assert.strictEqual(con.status, 0);
  for (const r of [con, correr(file, { OLLAMA_API_KEY: '$(OLLAMA_API_KEY)' })]) assert.doesNotMatch(r.stdout + r.stderr, /s3cr3t/);
  const texto = spawnSync(process.execPath, [CLI, '--org-config', file], { encoding: 'utf8', env: { PATH: process.env.PATH, OLLAMA_API_KEY: 's3cr3t' } });
  assert.doesNotMatch(texto.stdout + texto.stderr, /s3cr3t/, 'tampoco en texto');
});

test('T32 Nightly_ArchivoIlegible_Sale2 @story-2.73 @ac-24', () => {
  const casos = [org('{ roto'), path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-model-')), 'team-repos.json'), org({ nightly: { provider: 'ollama' } }, 'otro.json')];
  for (const file of casos) {
    const r = correr(file, { OLLAMA_API_KEY: 'x' });
    assert.strictEqual(r.status, 2, `${file}: ${r.stdout}`);
    assert.deepStrictEqual([r.json.ok, r.json.status, r.json.model], [false, 'unreadable', null], file);
    assert.ok(r.json.message, file);
  }
});

test('T32b Nightly_LectorQueNoCarga_Sale2 @story-2.73 @ac-24 — un lector que está y pide un módulo que falta no se reemplaza callado', () => {
  const file = org({ ...OLLAMA, nightly: { provider: 'ollama' } });
  const lib = path.join(path.dirname(file), 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'team-repos.js'), "require('./no-existe-acme.js');\n");
  const r = correr(file, { OLLAMA_API_KEY: 'x' });
  assert.strictEqual(r.status, 2, r.stdout);
  assert.strictEqual(r.json.status, 'unreadable');
  assert.match(r.json.message, /no-existe-acme/);
});

test('T33 Nightly_TechoRecortaElNivel @story-2.73 @ac-25', () => {
  const models = { mandatory_ceiling: true, ceiling: 'economy', providers: { ollama: { economy: 'gemma4:31b-cloud', strong: 'qwen3:480b-cloud' } }, nightly: { provider: 'ollama', level: 'strong' } };
  const r = correr(org(models), { OLLAMA_API_KEY: 'x' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual([r.json.level, r.json.capped_from, r.json.model], ['economy', 'strong', 'gemma4:31b-cloud']);
  assert.strictEqual(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /tope/);
});

test('T34 Nightly_JsonContrato_ClavesFijas @story-2.73 @ac-26', () => {
  const ok = correr(org({ ...OLLAMA, nightly: { provider: 'ollama' } }), { OLLAMA_API_KEY: 'x' }).json;
  const mal = correr(org(OLLAMA), {}).json;
  for (const j of [ok, mal]) assert.deepStrictEqual(Object.keys(j), CLAVES);
  assert.strictEqual(ok.capped_from, null);
  assert.deepStrictEqual([mal.provider, mal.level, mal.model, mal.capped_from, mal.secret], [null, null, null, null, null]);
  assert.deepStrictEqual(mal.warnings, []);
});
