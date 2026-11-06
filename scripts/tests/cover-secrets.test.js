'use strict';
// cover-secrets.test.js — los valores reales de la máquina se tapan en lo que devuelven las herramientas (historia 8.188).
// Valores inventados y HOME de juguete: nada de acá lee la configuración real. Las sesiones reales, en
// cover-secrets-real.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'cover-secrets.js');
const LIB = path.join(ROOT, 'scripts', 'lib', 'known-secrets.js');
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'safety-guard-pre.sh');
const CONFIG = path.join(ROOT, 'scripts', 'lib', 'tycon-config.js');

const VALUE = 'valor.inventado-del-entorno-1234';
const COVERED = '«tapado»';
const NOTICE = 'Se tapó un valor real de la configuración de esta máquina: no hace falta verlo.';

const toyHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cover-secrets-'));
const write = (home, rel, body) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const stateFile = (home, name) => path.join(home, '.claude', '.tycon-pipeline', name);
const logLines = (home) => {
  try { return fs.readFileSync(stateFile(home, 'cover-secrets.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};
const errorsOf = (home) => {
  try { return fs.readFileSync(stateFile(home, 'cover-secrets-errors.log'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
};

const runHook = (input, { home = toyHome(), env = { PRUEBA_TOKEN: VALUE } } = {}) => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ...env },
  });
  return { ...res, home };
};
const claudeInput = (toolName, response) => ({
  session_id: 's1', hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: { command: 'lo que sea' }, tool_response: response,
});
const bash = (stdout, stderr = '', more = {}) => ({ stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false, ...more });

test('T1 CoverSecrets_BashOutput_CoversEveryOccurrence @story-8.188 @ac-1', () => {
  const res = runHook(claudeInput('Bash', bash(`A=${VALUE}\nB=${VALUE}\nfin`, `error ${VALUE}`)));
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout).hookSpecificOutput;
  assert.strictEqual(out.hookEventName, 'PostToolUse');
  assert.deepStrictEqual(out.updatedToolOutput, bash(`A=${COVERED}\nB=${COVERED}\nfin`, `error ${COVERED}`));
  assert.ok(!res.stdout.includes(VALUE));
});

test('T3 CoverSecrets_ReadAndGrep_KeepTheirShape @story-8.188 @ac-2', () => {
  const read = { type: 'text', file: { filePath: '/x/.env', content: `1\tTOKEN=${VALUE}\n`, numLines: 1, startLine: 1, totalLines: 1 } };
  const outRead = JSON.parse(runHook(claudeInput('Read', read)).stdout).hookSpecificOutput.updatedToolOutput;
  assert.deepStrictEqual(outRead, { ...read, file: { ...read.file, content: `1\tTOKEN=${COVERED}\n` } });

  const grep = { mode: 'content', numFiles: 0, filenames: [], content: `1:TOKEN=${VALUE}`, numLines: 1, totalLines: 1 };
  const outGrep = JSON.parse(runHook(claudeInput('Grep', grep)).stdout).hookSpecificOutput.updatedToolOutput;
  assert.deepStrictEqual(outGrep, { ...grep, content: `1:TOKEN=${COVERED}` });
});

test('T4 CoverSecrets_NoValue_SaysNothing @story-8.188 @ac-3', () => {
  const res = runHook(claudeInput('Bash', bash('nada de nada')));
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '');
  assert.deepStrictEqual(logLines(res.home), []);
});

test('T5 CoverSecrets_ExampleKeysInATestFile_StayAsTheyAre @story-8.188 @ac-4', () => {
  const ghp = `ghp_${'x'.repeat(36)}`;
  const sk = `sk-${'y'.repeat(40)}`;
  const res = runHook(claudeInput('Read', { type: 'text', file: { filePath: '/x/a.test.js', content: `${ghp} ${sk}` } }));
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '');
});

test('T6 KnownSecrets_ReadsEveryOrigin @story-8.188 @ac-5', () => {
  const { readKnownSecrets } = require(LIB);
  const home = toyHome();
  write(home, '.zshrc', 'export MI_API_KEY="valor.inventado-del-shell-1234"\n');
  write(home, '.claude/channels/canal/.env', 'CANAL_BOT_TOKEN=valor.inventado-del-canal-1234\n');
  write(home, '.tycon/config.json', JSON.stringify({ github: { token: 'valor.inventado-de-la-config-12' } }));
  const { secrets, problems } = readKnownSecrets({ home, env: { PRUEBA_SECRET: 'valor.inventado-del-entorno-12', INVENTADA_PAT_DE_PRUEBA: 'valor.inventado-del-pat-12345' } });
  const found = Object.fromEntries(secrets.map((s) => [s.value, s.origin]));
  assert.deepStrictEqual(found, {
    'valor.inventado-del-entorno-12': 'entorno',
    'valor.inventado-del-pat-12345': 'entorno',
    'valor.inventado-del-shell-1234': 'shell',
    'valor.inventado-del-canal-1234': 'canal',
    'valor.inventado-de-la-config-12': 'configuración',
  });
  assert.deepStrictEqual(problems, []);
});

test('T7 KnownSecrets_NamesThatAreNotSecrets_Ignored @story-8.188 @ac-5', () => {
  const { readKnownSecrets } = require(LIB);
  const long = 'un-valor.largo-que-no-es-secreto';
  const { secrets } = readKnownSecrets({ home: toyHome(), env: { PATH: long, HOME: long, CLAUDE_CODE_SESSION_ID: long, COMPATIBLE: long } });
  assert.deepStrictEqual(secrets, []);
});

test('T8 KnownSecrets_ShortPathsAndPlainUrls_Ignored @story-8.188 @ac-6', () => {
  const { readKnownSecrets } = require(LIB);
  const { secrets } = readKnownSecrets({
    home: toyHome(),
    env: {
      CORTO_TOKEN: 'quince-letras-x',
      RUTA_TOKEN: '/una/ruta.bastante/larga/de/verdad',
      TILDE_TOKEN: '~/una/ruta/bastante/larga/de/verdad',
      DIRECCION_TOKEN: 'https://example.com/una/direccion/larga',
      CON_CLAVE_TOKEN: 'https://usuario:clave-inventada@example.com/x',
      DIECISEIS_TOKEN: 'dieciseis.letras',
    },
  });
  assert.deepStrictEqual(secrets.map((s) => s.value).sort(), ['dieciseis.letras', 'https://usuario:clave-inventada@example.com/x']);
});

test('T9 CoverSecrets_Notice_TellsTheAgentNeverTheValue @story-8.188 @ac-7', () => {
  const res = runHook(claudeInput('Bash', bash(`${VALUE} y ${VALUE}`)));
  const out = JSON.parse(res.stdout).hookSpecificOutput;
  assert.ok(out.additionalContext.startsWith(NOTICE));
  assert.ok(out.additionalContext.includes('tycon-config.js get <clave>'));
  assert.ok(out.additionalContext.includes('[ -n "$VARIABLE" ] && echo está'));
  const lines = logLines(res.home);
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(Object.keys(lines[0]).sort(), ['count', 'origins', 'session', 'tool', 'ts']);
  assert.strictEqual(lines[0].count, 2);
  assert.deepStrictEqual(lines[0].origins, ['entorno']);
  assert.strictEqual(lines[0].tool, 'Bash');
  const raw = fs.readFileSync(stateFile(res.home, 'cover-secrets.jsonl'), 'utf8');
  assert.ok(!raw.includes(VALUE) && !raw.includes('lo que sea'), 'sin el valor ni el comando');
});

test('T10 CoverSecrets_Commands_NotBlocked @story-8.188 @ac-8', () => {
  const res = runHook(claudeInput('Bash', bash(VALUE, 'salió mal: exit 3', { interrupted: true })));
  assert.strictEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.ok(!('decision' in parsed), 'en Claude no agrega una decisión');
  assert.strictEqual(parsed.hookSpecificOutput.updatedToolOutput.stderr, 'salió mal: exit 3');
  assert.strictEqual(parsed.hookSpecificOutput.updatedToolOutput.interrupted, true);
});

test('T11 CoverSecrets_Codex_BlockWithCoveredOutput @story-8.188 @ac-9', () => {
  const input = { ...claudeInput('Bash', `A=${VALUE}\n`), turn_id: 'turn-1' };
  const res = runHook(input);
  assert.strictEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.strictEqual(parsed.decision, 'block');
  assert.ok(parsed.reason.startsWith(`A=${COVERED}\n`));
  assert.ok(!res.stdout.includes(VALUE));
  assert.strictEqual(logLines(res.home)[0].count, 1);
  // la misma salida, si llega como campos
  const fields = JSON.parse(runHook({ ...claudeInput('Bash', bash(VALUE, 'aviso')), turn_id: 'turn-1' }).stdout);
  assert.strictEqual(fields.decision, 'block');
  assert.ok(fields.reason.includes(COVERED) && fields.reason.includes('aviso') && !fields.reason.includes(VALUE));
});

test('T12 CoverSecrets_BrokenOrigins_ExitZeroAndUseTheRest @story-8.188 @ac-10', () => {
  const home = toyHome();
  const brokenSecret = 'valor.inventado-de-config-rota-1';
  write(home, '.tycon/config.json', `{ "github": { "token": "${brokenSecret}"`);
  fs.mkdirSync(path.join(home, '.zshrc'));
  const res = runHook(claudeInput('Bash', bash(VALUE)), { home });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(JSON.parse(res.stdout).hookSpecificOutput.updatedToolOutput.stdout, COVERED);
  const errors = errorsOf(home);
  assert.match(errors, /config\.json/);
  assert.match(errors, /\.zshrc/);
  assert.ok(!errors.includes(brokenSecret) && !errors.includes(VALUE), 'el error no lleva valores');
  assert.ok(!errors.includes('channels') && !errors.includes('.bashrc'), 'lo que no existe no es un error');
});

test('T13 CoverSecrets_BadInput_ExitZeroSilent @story-8.188 @ac-10', () => {
  const res = runHook(`esto no es JSON ${VALUE}`);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '');
  assert.strictEqual(res.stderr, '');
  assert.ok(errorsOf(res.home).length > 0, 'anota el motivo');
  assert.ok(!errorsOf(res.home).includes(VALUE), 'el motivo no copia la entrada');
  // JSON válido sin la respuesta: si la herramienta cambia el nombre del campo, el gancho dejaría de tapar sin que nadie lo sepa
  for (const input of [{ session_id: 's1', tool_name: 'Bash' }, { session_id: 's1', tool_name: 'Bash', tool_response: null }]) {
    const noField = runHook(input);
    assert.strictEqual(noField.status, 0);
    assert.strictEqual(noField.stdout, '');
    assert.match(errorsOf(noField.home), /no trae la respuesta/);
  }
});

test('T14 SafetyGuard_SecC1SecC2_StillBlock @story-8.188 @ac-13', () => {
  const ask = (command) => spawnSync('bash', [GUARD], {
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: { HOME: toyHome(), PATH: process.env.PATH },
  });
  const env = ask('cat .env');
  assert.strictEqual(env.status, 2);
  assert.match(env.stderr, /SEC-C2/);
  const key = ask('cat ~/.ssh/id_rsa');
  assert.strictEqual(key.status, 2);
  assert.match(key.stderr, /SEC-C1/);
});

test('T15 TyconConfig_GetSecret_SaysOnlyThatItIsThere @story-8.188 @ac-14', () => {
  const home = toyHome();
  const secret = 'valor.inventado-de-la-config-12';
  write(home, '.claude/tycon.json', JSON.stringify({ github: { token: secret } }));
  const res = spawnSync(process.execPath, [CONFIG, 'get', 'github.token'], { encoding: 'utf8', env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH } });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), '1');
  assert.ok(!res.stdout.includes(secret) && !res.stderr.includes(secret));
});

test('T21 CoverSecrets_TurnedOff_SaysNothing @story-8.188 @ac-17', () => {
  const res = runHook(claudeInput('Bash', bash(VALUE)), { env: { PRUEBA_TOKEN: VALUE, TYCON_COVER_SECRETS: '0' } });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '');
  assert.deepStrictEqual(logLines(res.home), []);
});

// ── Lo que confirmó el pase adversarial ───────────────────────────────────────────────────────
test('T23 KnownSecrets_UrlWithAnyCredentialForm_IsCovered @story-8.188 @ac-6', () => {
  const { readKnownSecrets } = require(LIB);
  const urls = {
    SIN_USUARIO_TOKEN: 'https://:clave-inventada@dev.example.com/org',
    SOLO_CLAVE_TOKEN: 'https://clave-inventada@git.example.com/repo',
    CONSULTA_TOKEN: 'https://cuenta.example.net/caja?sv=2024&sig=firma-inventada',
  };
  const { secrets } = readKnownSecrets({ home: toyHome(), env: urls });
  assert.deepStrictEqual(secrets.map((s) => s.value).sort(), Object.values(urls).sort());
});

test('T24 KnownSecrets_MachineWithItsOwnHome_ReadsThatConfig @story-8.188 @ac-5', () => {
  const home = toyHome();
  const own = toyHome();
  const secret = 'valor.inventado-de-la-casa-propia';
  write(own, 'config.json', JSON.stringify({ github: { token: secret } }));
  const res = runHook(claudeInput('Bash', bash(secret)), { home, env: { TYCON_HOME: own } });
  assert.strictEqual(JSON.parse(res.stdout).hookSpecificOutput.updatedToolOutput.stdout, COVERED);
});

test('T25 KnownSecrets_ShellForms_ReadLikeTheShell @story-8.188 @ac-5', () => {
  const { readKnownSecrets } = require(LIB);
  const home = toyHome();
  write(home, '.zshrc', [
    'export UNO_TOKEN=valor.del-primero-1234 DOS_TOKEN=valor.del-segundo-1234',
    'TRES_TOKEN=valor.con-punto-y-coma-1234; export TRES_TOKEN',
    'declare -x CUATRO_TOKEN=valor.con-declare-1234',
    'typeset -x CINCO_TOKEN="valor.con-typeset-1234"',
    'readonly SEIS_TOKEN=valor.con-readonly-1234',
    '[ -n "$X" ] && export SIETE_TOKEN=valor.con-condicion-1234',
    'export OCHO_TOKEN="valor.entre comillas-1234" # comentario',
    'export NUEVE_TOKEN=$(comando) DIEZ_TOKEN=valor.junto-a-un-comando-1234',
    '# export ONCE_TOKEN=valor.en-un-comentario-1234',
    '',
  ].join('\n'));
  const values = readKnownSecrets({ home, env: {} }).secrets.map((s) => s.value).sort();
  assert.deepStrictEqual(values, [
    'valor.con-condicion-1234', 'valor.con-declare-1234', 'valor.con-punto-y-coma-1234', 'valor.con-readonly-1234', 'valor.con-typeset-1234',
    'valor.del-primero-1234', 'valor.del-segundo-1234', 'valor.entre comillas-1234', 'valor.junto-a-un-comando-1234',
  ].sort());
});

test('T26 CoverSecrets_ValueWithJsonEscapes_IsCovered @story-8.188 @ac-8', () => {
  const { coverIn, coverInLatin1 } = require(LIB);
  const value = 'valor"inventado\\con-escapes-1234';
  const secrets = [{ value, origin: 'configuración' }];
  const shown = JSON.stringify({ github: { token: value } });
  assert.strictEqual(coverIn(shown, secrets).value, `{"github":{"token":"${COVERED}"}}`, 'lo que imprime `cat` del JSON');
  const saved = JSON.stringify({ salida: shown });
  assert.ok(!coverIn(saved, secrets).value.includes('inventado'), 'y lo que queda guardado en una conversación');
  const latin1 = Buffer.from(saved, 'utf8').toString('latin1');
  assert.ok(!coverInLatin1(latin1, secrets).includes('inventado'), 'también al subir');
});

test('T27 KnownSecrets_Base64KeyStartingWithASlash_IsCovered @story-8.188 @ac-6', () => {
  const { readKnownSecrets } = require(LIB);
  const key = '/a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w==';
  const pair = '/Qx7Zk2Lm9Pw4Rt8Vb3Nc6Jh1Gf5Ds0Ay/Xe7Ui2Oq4Tr9Ym';
  const { secrets } = readKnownSecrets({ home: toyHome(), env: { CLAVE_KEY: key, OTRA_KEY: pair } });
  assert.deepStrictEqual(secrets.map((s) => s.value).sort(), [key, pair].sort());
});

test('T28 KnownSecrets_PathsWithoutADriveOrALeadingSlash_Ignored @story-8.188 @ac-6', () => {
  const { readKnownSecrets } = require(LIB);
  const { secrets } = readKnownSecrets({
    home: toyHome(),
    env: { RELATIVA_TOKEN: 'carpeta/otra.dir/archivo-largo.txt', UNC_TOKEN: '\\\\servidor\\carpeta\\archivo', SIN_ESQUEMA_TOKEN: 'example.com/una/direccion' },
  });
  assert.deepStrictEqual(secrets, []);
});

test('T29 KnownSecrets_ConfigWithBom_IsRead @story-8.188 @ac-5', () => {
  const { readKnownSecrets } = require(LIB);
  const home = toyHome();
  write(home, '.tycon/config.json', `﻿${JSON.stringify({ github: { token: 'valor.inventado-con-marca-bom' } })}`);
  const { secrets, problems } = readKnownSecrets({ home, env: {} });
  assert.deepStrictEqual(secrets.map((s) => s.value), ['valor.inventado-con-marca-bom']);
  assert.deepStrictEqual(problems, []);
});

test('T30 KnownSecrets_LooseFileInChannels_IsNotAProblem @story-8.188 @ac-10', () => {
  const { readKnownSecrets } = require(LIB);
  const home = toyHome();
  write(home, '.claude/channels/.DS_Store', 'lo que deja el sistema');
  write(home, '.claude/channels/sin-env/otra-cosa.txt', 'nada');
  assert.deepStrictEqual(readKnownSecrets({ home, env: {} }).problems, []);
});

test('T31 CoverSecrets_Codex_TellsTheAgentToo @story-8.188 @ac-7', () => {
  const parsed = JSON.parse(runHook({ ...claudeInput('Bash', `A=${VALUE}\n`), turn_id: 'turn-1' }).stdout);
  assert.ok(parsed.reason.startsWith(`A=${COVERED}\n`), 'primero la salida');
  assert.ok(parsed.reason.includes(NOTICE), 'después el aviso');
});

test('T32 KnownSecrets_SameLengthValues_CoverTheSameWay @story-8.188 @ac-5', () => {
  const { coverIn, readKnownSecrets } = require(LIB);
  const a = 'abcdefgh-ijklmnop';
  const b = 'ijklmnop-qrstuvwx';
  const ordered = (env) => readKnownSecrets({ home: toyHome(), env }).secrets;
  const one = coverIn('abcdefgh-ijklmnop-qrstuvwx', ordered({ A_TOKEN: a, B_TOKEN: b })).value;
  const two = coverIn('abcdefgh-ijklmnop-qrstuvwx', ordered({ B_TOKEN: b, A_TOKEN: a })).value;
  assert.strictEqual(one, two);
});

test('T35 KnownSecrets_IntegrationSecretsStore_IsRead @story-8.188 @ac-5', () => {
  const { readKnownSecrets } = require(LIB);
  const home = toyHome();
  const hook = 'https://hooks.example.com/services/valor/inventado/para-el-aviso';
  write(home, '.tycon/secrets/horas.json', JSON.stringify({ token: 'valor.inventado-de-las-horas-12' }));
  write(home, '.tycon/secrets/avisos.json', JSON.stringify({ mail_password: 'valor.inventado-del-correo-12', webhook: hook, corto: 'menos-de-16' }));
  write(home, '.tycon/secrets/roto.json', '{ no es json valor.que-no-se-copia');
  const { secrets, problems } = readKnownSecrets({ home, env: {} });
  assert.deepStrictEqual(secrets.map((s) => s.value).sort(), [hook, 'valor.inventado-de-las-horas-12', 'valor.inventado-del-correo-12'].sort());
  assert.ok(secrets.every((s) => s.origin === 'configuración'));
  assert.strictEqual(problems.length, 1, 'el archivo roto se anota');
  assert.ok(problems[0].includes('roto.json') && !problems[0].includes('valor.que-no-se-copia'));
});

test('T22 KnownSecrets_LongestValueFirst_AndShellOnlyLiterals @story-8.188 @ac-5', () => {
  const { readKnownSecrets, coverIn } = require(LIB);
  const home = toyHome();
  write(home, '.zshrc', [
    'export REFERENCIA_TOKEN="$OTRA_VARIABLE_MUY_LARGA"',
    'export COMANDO_TOKEN=$(cat /un/archivo/cualquiera)',
    "export LITERAL_TOKEN='valor.literal-con-$-adentro'",
    'SIN_EXPORT_SECRET=valor.sin-export-1234 # un comentario',
    '# export COMENTADO_TOKEN=valor.de-una-linea-comentada',
    '',
  ].join('\n'));
  const { secrets } = readKnownSecrets({ home, env: { CORTO_TOKEN: 'abcdefgh.ijklmnop', LARGO_TOKEN: 'abcdefgh.ijklmnop-qrstu' } });
  assert.deepStrictEqual(secrets.filter((s) => s.origin === 'shell').map((s) => s.value).sort(), ['valor.literal-con-$-adentro', 'valor.sin-export-1234']);
  const { value, count } = coverIn({ a: 'abcdefgh.ijklmnop-qrstu y abcdefgh.ijklmnop' }, secrets);
  assert.deepStrictEqual(value, { a: `${COVERED} y ${COVERED}` });
  assert.strictEqual(count, 2);
});
