#!/usr/bin/env node
/**
 * smoke-secrets.test.js — los registros de prueba de humo nunca guardan una contraseña.
 *
 * El riesgo: contraseñas SQL escritas tal cual en `.advisors/dod-runtime/*-smoke-ledger.jsonl`, incluso la de
 * la base de producción. Un tapado que sólo reconozca valores de letras y números deja pasar enteros
 * `SQLCMDPASSWORD='…'` con un símbolo y el `-P` de sqlcmd.
 *
 * Se prueba el módulo (lib/smoke-secrets.js) y su uso por smoke-run.sh. Que el freno de on-pre-commit.js frena con
 * estas formas lo mide el banco de controles (47-secretos-en-la-evidencia.json).
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib', 'smoke-secrets.js');
const SMOKE_RUN = path.join(__dirname, '..', 'smoke-run.sh');
const s = require(LIB);

// Inventada: lo que se prueba es la forma, no el valor.
const PW = 'Inventada#Pw1!';
// Armados por partes: escritos enteros, el detector de la copia pública (scripts/publishing/detector.js) los lee como
// una clave en una cadena de conexión, que es justamente la forma que se prueba.
const PASSWORD = ['Pass', 'word'].join('');
const PWD_COL = ['p', 'wd'].join('');
const Q = "'";

// [comando, forma que lo atrapa, lo que tiene que quedar a la vista]
const CON_SECRETO = [
  [`SQLCMDPASSWORD=${Q}${PW}${Q} sqlcmd -S srv -Q "select 1"`, 'env-var', `SQLCMDPASSWORD=${Q}***${Q}`],
  [`out=$(SQLCMDPASSWORD="${PW}" sqlcmd -S srv)`, 'env-var', 'SQLCMDPASSWORD="***"'],
  [`env SQLCMDPASSWORD=${PW} sqlcmd -S srv`, 'env-var', 'SQLCMDPASSWORD=***'],
  [`bash -c SQLCMDPASSWORD="${PW}" sqlcmd -S srv`, 'env-var', 'SQLCMDPASSWORD="***"'],
  [`GITHUB_TOKEN=${PW} curl http://x`, 'env-var', 'GITHUB_TOKEN=***'],
  [`CLIENT_SECRET=${PW} node x.js`, 'env-var', 'CLIENT_SECRET=***'],
  [`ACME_PASS=${PW} bash x.sh`, 'env-var', 'ACME_PASS=***'],
  [`sqlcmd -S srv -U sa -P ${Q}${PW}${Q} -Q "select 1"`, 'sqlcmd-P', `-P ${Q}***${Q}`],
  [`sqlcmd -S srv -U sa -P${PW} -Q "select 1"`, 'sqlcmd-P', '-P***'],
  [`sqlcmd.exe -S srv -U sa -P "${PW}"`, 'sqlcmd-P', '-P "***"'],
  [`dotnet run -- "Server=srv;User Id=u;Password=${PW};Encrypt=True"`, 'connection-string', 'Password=***;'],
  [`dotnet run -- "Server=srv;User Id=u;Password=con espacio;Encrypt=True"`, 'connection-string', 'Password=***;'],
  [`node x.js "Data Source=srv;pwd={${PW}};"`, 'connection-string', 'pwd={***}'],
  [`az x "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abc+/def==;EndpointSuffix=e"`, 'connection-string', 'AccountKey=***;'],
  ['curl -H "Authorization: Bearer abc.def" http://x', 'bearer', 'Authorization: Bearer ***'],
  ['curl "https://a.blob/c/f?sv=2022&sig=AbC%2Bd%3D&se=1"', 'sas-sig', '&sig=***&se=1'],
];

// Mutación: sacar una forma de FORMS (o romper su valor) → su fila sale con el valor a la vista.
for (const [cmd, form, visible] of CON_SECRETO) {
  test(`tapa la forma ${form}: ${visible}`, () => {
    const r = s.redact(cmd);
    assert.ok(r.text.includes(visible), `quedó: ${r.text}`);
    assert.ok(!r.text.includes(PW) && !r.text.includes('con espacio') && !r.text.includes('abc+/def') && !r.text.includes('abc.def') && !r.text.includes('AbC%2B'),
      `el valor no puede quedar: ${r.text}`);
    assert.ok(r.count >= 1);
    assert.deepEqual(s.findLeaks(cmd).map((l) => l.form).filter((f) => f === form), [form], 'el freno ve la forma antes');
    assert.deepEqual(s.findLeaks(r.text), [], 'y no ve nada después de tapar');
  });
}

// Mutación: que isSafeValue no acepte `***` o `$X` → estas filas salen tocadas o como hallazgo.
const LIMPIOS = [
  `SQLCMDPASSWORD=${Q}***${Q} sqlcmd -S srv -P "$DB_PASS" -Q x`,
  'SQLCMDPASSWORD="$DB_PASS" sqlcmd -S srv',
  'SQLCMDPASSWORD=${DB_PASS} sqlcmd -S srv -P ***',
  'TOKEN=$(az account get-access-token) curl -H "Authorization: Bearer $TOKEN" http://x',
  'node x.js "Server=srv;Password=***;"',
  'node x.js "Server=srv;Password=$DB_PASS;"',
  'curl "https://a.blob/c/f?sv=2022&sig=***"',
  'curl -sf http://localhost:5001/api/acciones/pendientes?page=1&pageSize=3',
  'PATH=/usr/bin NODE_ENV=test npm run smoke',
  'sqlcmd -S srv -E -Q "select 1" -p',
];
for (const cmd of LIMPIOS) {
  test(`limpio queda intacto y sin hallazgo: ${cmd.slice(0, 50)}`, () => {
    const r = s.redact(cmd);
    assert.equal(r.text, cmd);
    assert.equal(r.count, 0);
    assert.deepEqual(s.findLeaks(cmd), []);
  });
}

// Mutación: correr el tapado general ANTES de las formas → `$VAL!x` deja la cola de la contraseña a la vista.
test('las formas corren antes que el tapado general: no queda la cola de la contraseña', () => {
  const r = s.redact(`PGPASSWORD=${Q}Ab1234!xyz${Q} psql`);
  assert.equal(r.text, `PGPASSWORD=${Q}***${Q} psql`);
});

// Mutación: que `legacy: false` (TYCON_SMOKE_REDACT=0) apague también las formas de la lista.
test('TYCON_SMOKE_REDACT=0 apaga sólo el tapado general, nunca las formas de la lista', () => {
  const r = s.redact(`SQLCMDPASSWORD=${Q}${PW}${Q} sqlcmd -H "X-Api-Key: abcdefghij0123456789"`, { legacy: false });
  assert.ok(r.text.includes(`SQLCMDPASSWORD=${Q}***${Q}`));
  assert.ok(r.text.includes('abcdefghij0123456789'), 'el tapado general quedó apagado');
});

// Mutación: cortar a 300 sin la guarda → un `**` suelto que el freno lee como un valor.
test('cortar no parte un *** a la mitad', () => {
  const pre = 'x'.repeat(296);
  const out = s.truncate(`${pre}=***;`, 298);
  assert.equal(out, `${pre}=`);
  assert.equal(s.truncate('corto', 300), 'corto');
});

// Mutación: cortar ANTES de tapar → la comilla de cierre queda afuera y la contraseña pasa.
test('el cmd del registro se tapa antes de cortarse', () => {
  const cmd = `${'a'.repeat(280)} SQLCMDPASSWORD=${Q}${PW}${'z'.repeat(40)}${Q} sqlcmd`;
  const r = s.ledgerCmd(cmd);
  assert.ok(r.text.length <= 300);
  assert.ok(!r.text.includes('Inventada'), r.text);
});

// Mutación: unir con espacios a secas → `-P mi clave` y sólo se tapa `mi`.
test('un argumento con blancos se arma entre comillas y se tapa entero', () => {
  assert.equal(s.joinArgs(['sqlcmd', '-P', 'mi clave larga']), `sqlcmd -P ${Q}mi clave larga${Q}`);
  assert.equal(s.joinArgs(['bash', '-c', `X=${Q}a${Q} y`]), `bash -c X=${Q}a${Q} y`, 'el guion de un -c va tal cual');
  assert.equal(s.joinArgs(['curl', '-sf', 'http://x']), 'curl -sf http://x');
  assert.ok(!s.ledgerCmd(s.joinArgs(['sqlcmd', '-S', 'srv', '-P', 'mi clave larga'])).text.includes('clave'));
});

// Mutación: mirar la línea JSON en crudo → `\"` corre el final del valor y aparecen falsos hallazgos o se pierden.
test('findLeaksInContent: lee el registro por sus textos decodificados y da línea y forma, sin el valor', () => {
  const ledger = [
    JSON.stringify({ ts: 't1', story: '9.9', acs: [1], cmd: `SQLCMDPASSWORD="***" sqlcmd -P "$DB_PASS"`, exit: 0 }),
    JSON.stringify({ ts: 't2', story: '9.9', acs: [2], cmd: `sqlcmd -S srv -P "${PW}"`, exit: 0 }),
    '',
  ].join('\n');
  const h = s.findLeaksInContent(ledger);
  assert.deepEqual(h.map((x) => [x.line, x.form]), [[2, 'sqlcmd-P']]);
  assert.ok(!JSON.stringify(h).includes(PW), 'el hallazgo no lleva el valor');
  const md = `# Smoke\n\`Server=srv;Password=${PW};\`\n`;
  assert.deepEqual(s.findLeaksInContent(md).map((x) => [x.line, x.form]), [[2, 'connection-string']]);
});

// Mutación: que isEvidencePath acepte cualquier `.advisors/` o pida la carpeta en la raíz.
test('isEvidencePath: la carpeta de evidencia, en la raíz o en un subproyecto', () => {
  assert.ok(s.isEvidencePath('.advisors/dod-runtime/9.9-smoke-ledger.jsonl'));
  assert.ok(s.isEvidencePath('frontend/.advisors/dod-runtime/9.9-20261004.md'));
  assert.ok(s.isEvidencePath('frontend\\.advisors\\dod-runtime\\x.md'));
  assert.ok(!s.isEvidencePath('.advisors/pipeline-runs/x/findings.json'));
  assert.ok(!s.isEvidencePath('docs/dod-runtime.md'));
});

function correrSmoke(script, args, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-secretos-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const evidence = path.join(repo, '.advisors', 'dod-runtime');
  const res = spawnSync('bash', [script, evidence, '9.9', '--acs', '1', '--pass-if', 'el comando termina bien', '--', ...args], {
    env: { ...process.env, HOME: home, ...env }, cwd: os.tmpdir(), encoding: 'utf8',
  });
  const entry = JSON.parse(fs.readFileSync(path.join(evidence, '9.9-smoke-ledger.jsonl'), 'utf8').split('\n')[0]);
  return { res, entry, home };
}

// Mutación: volver a `$*` en smoke-run.sh, o no llamar al módulo → la contraseña queda en el registro.
test('smoke-run.sh: el -P de sqlcmd con espacios no llega al registro, ni con TYCON_SMOKE_REDACT=0', () => {
  const { res, entry, home } = correrSmoke(SMOKE_RUN, ['true', 'sqlcmd', '-S', 'srv', '-P', 'mi clave larga', '-Q', 'select 1'],
    { TYCON_SMOKE_REDACT: '0' });
  assert.equal(res.status, 0);
  assert.ok(!entry.cmd.includes('clave'), entry.cmd);
  assert.match(entry.cmd, /-P '\*\*\*'/);
  assert.match(res.stderr, /taparon 1 valor/);
  const espejo = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  assert.match(espejo, /"repoPath":"[^"]+repo"/, 'el espejo sigue llevando el repo (sin python)');
  fs.rmSync(home, { recursive: true, force: true });
});

// Mutación: usar `|| CMD_SAFE="$CMD_STR"` → sin el módulo, el comando se escribe tal cual.
test('smoke-run.sh: si el tapado no puede correr, el comando NO se escribe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-sin-lib-'));
  const copia = path.join(dir, 'smoke-run.sh');
  fs.copyFileSync(SMOKE_RUN, copia);
  const { res, entry, home } = correrSmoke(copia, ['true', `SQLCMDPASSWORD=${PW}`]);
  assert.equal(res.status, 0, 'el exit es el del comando');
  assert.ok(!entry.cmd.includes(PW));
  assert.match(entry.cmd, /comando no registrado/);
  assert.equal(entry.exit, 0);
  assert.match(res.stderr, /NO se escribe/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Lo que una versión simple del tapado deja a la vista ──────────────────────────────
// Cada fila es el argv tal como lo recibe smoke-run.sh (el shell ya quitó las comillas y expandió las variables).
// Mutación: volver a citar sólo los argumentos con blancos, o leer el valor como UN tramo → la cola queda detrás de `***`.
const ARGV_CON_SECRETO = [
  [['sqlcmd', '-S', 'srv', '-P', 'Ab;cd9X', '-Q', 'select 1'], 'cd9X'],
  [['sqlcmd', '-P', 'Ab(1)Cd'], '(1)Cd'],
  [['sqlcmd', '-P', "Ab'cd12"], 'cd12'],
  [['sqlcmd', '-P', 'Ab\\cd12'], 'cd12'],
  [['sqlcmd', '-PAb;cd9X'], 'cd9X'],
  [['env', 'SQLCMDPASSWORD=Ab;cd9X', 'sqlcmd'], 'cd9X'],
  [['env', `DB_PASSWORD=a'b "c d`, 'x'], 'c d'],
  [['dotnet', 'run', '--', "Server=srv;User Id=sa;Password=Ab'cd;"], "'cd"],
  [['bash', '-c', 'sqlcmd -S srv -U sa \\\n  -P Secr3tX -Q "select 1"'], 'Secr3tX'],
  [['curl', '-H', "Authorization: Bearer abc'def"], 'def'],
  // Casos límite: un `|` entre comillas antes del -P, `$` y comillas dentro de una cadena de
  // conexión, valores que empiezan como un marcador, y un nombre de configuración que igual dice PASSWORD.
  [['sqlcmd', '-S', 'srv', '-s', '|', '-W', '-P', 'Secr3tX9'], 'Secr3tX9'],
  [['sqlcmd', '-Q', "print 'a && b'", '-P', 'Secr3tX9'], 'Secr3tX9'],
  [['dotnet', 'run', '--', 'Server=srv;User Id=sa;Password=$ecret9X;'], 'ecret9X'],
  [['dotnet', 'run', '--', `Server=srv;${PASSWORD}='Ab;cd9X';`], 'cd9X'],
  [['dotnet', 'run', '--', `Server=srv;${PASSWORD}=(xY9#k2;`], 'xY9#k2'],
  [['dotnet', 'run', '--', `Server=srv;${PASSWORD}=***xY9k2;`], 'xY9k2'],
  [['env', 'DB_PASSWORD_MAX=Secr3tX9', 'x'], 'Secr3tX9'],
  [['dotnet', 'run', '--', "Server=srv;Password=Ab' cd9X;"], 'cd9X'],
  [['sqlcmd', '-v', 'Password=Ab;cd9X'], 'cd9X'],
  // Caso límite: `--opción=NAME=valor` en un solo argumento, y `-eNAME=` pegado.
  [['docker', 'run', '--env=SQLCMDPASSWORD=Ab;cd9X', 'img'], 'cd9X'],
  [['docker', 'build', '--build-arg=DB_PASSWORD=Ab;cd9X', '.'], 'cd9X'],
  [['docker', 'run', '-eSQLCMDPASSWORD=Ab;cd9X', 'img'], 'cd9X'],
];
for (const [argv, cola] of ARGV_CON_SECRETO) {
  test(`argv con símbolo: no queda «${cola}»`, () => {
    const out = s.ledgerCmdFromArgs(argv).text;
    assert.ok(!out.includes(cola), out);
    assert.deepEqual(s.findLeaks(out), [], 'y el freno no ve nada después');
  });
}

// Mutación: volver a tratar como variable todo valor que empieza con `$` → la contraseña `$ecret9X` pasa entera.
test('un $ que el shell ya expandió es parte de la contraseña, no una variable', () => {
  assert.equal(s.ledgerCmdFromArgs(['sqlcmd', '-P', '$ecret9X']).text, `sqlcmd -P ${Q}***${Q}`);
  assert.equal(s.ledgerCmdFromArgs(['env', 'SQLCMDPASSWORD=$ecret9X', 'x']).text, `env SQLCMDPASSWORD=${Q}***${Q} x`);
  assert.ok(!s.isSafeValue(`${Q}$ecret${Q}`), 'entre comillas simples, `$` es literal');
  assert.ok(s.isSafeValue('"$DB_PASS"'), 'entre comillas dobles, es una variable');
});

// Mutación: sacar los marcadores de documentación, el sufijo de configuración o el corte en `&&` → el freno frena sin secreto.
const SIN_SECRETO_PARA_EL_FRENO = [
  'El header es `Authorization: Bearer <token>`.',
  'curl -H "Authorization: Bearer ..." http://localhost:5001/api/x',
  'Se probó con TOKEN_TTL=60 y PASSWORD_MIN_LENGTH=8.',
  'env MAX_TOKENS=50 node scripts/smoke.js',
  `sqlcmd -Q "SELECT COUNT(*) FROM Usuarios WHERE ${PWD_COL} = NULL"`,
  'sqlcmd -S srv -E -Q "x" && git -P log',
  'PASSWORD_MAX_AGE=90 node smoke.js',
  'DB_PASSWORD_FILE=/run/secrets/db node smoke.js',
];
for (const linea of SIN_SECRETO_PARA_EL_FRENO) {
  test(`sin secreto, el freno no ve nada: ${linea.slice(0, 50)}`, () => {
    assert.deepEqual(s.findLeaks(linea), []);
  });
}

// Caso límite: el `-P` de sqlcmd con muchos tramos entre comillas y sin `-P` tarda minutos
// (retroceso exponencial), y un freno pasado de tiempo deja pasar el commit.
// Mutación: volver a aceptar comillas en el carácter suelto de esa regla → esta prueba no termina en 2 s.
test('el -P de sqlcmd no se cuelga con muchos tramos entre comillas', () => {
  const valores = Array.from({ length: 30 }, (_, i) => `'v${i}'`).join(',');
  const linea = `sqlcmd -S srv -E -Q "INSERT INTO T VALUES (${valores})" && echo fin`;
  const t0 = Date.now();
  assert.deepEqual(s.findLeaks(linea), []);
  s.ledgerCmdFromArgs(['sqlcmd', '-S', 'srv', '-E', '-Q', `INSERT INTO T VALUES (${valores})`]);
  s.findLeaksInContent(JSON.stringify({ cmd: linea }));
  assert.ok(Date.now() - t0 < 2000, `tardó ${Date.now() - t0} ms`);
});

// Mutación: reconocer sólo `-c` exacto → el guion de `bash -lc` se toma como argumento literal y se pierde.
test('el guion de bash -lc va tal cual, y se tapa como texto', () => {
  const out = s.ledgerCmdFromArgs(['bash', '-lc', 'X=1 sqlcmd -S srv -P Secr3tX9 -Q "select 1"']).text;
  assert.ok(out.includes('X=1 sqlcmd -S srv -P *** -Q'), out);
});

// ── La expectativa y la salida de un humo pasan por el MISMO tapado ─────────────────────────────────

// Mutación: guardar la salida entera, o recortar sólo por el principio → el archivo pasa de 8 KB o pierde el final.
test('la salida se recorta a 8 KB con las primeras y las últimas líneas y la marca en el medio', () => {
  const texto = Array.from({ length: 5000 }, (_, i) => `linea ${i}`).join('\n');
  const out = s.recortarSalida(texto);
  assert.ok(Buffer.byteLength(out) <= s.SALIDA_MAX_BYTES, `${Buffer.byteLength(out)} bytes`);
  assert.match(out, /^linea 0\n/);
  assert.match(out, /\nlinea 4999$/);
  assert.match(out, /\[… \d+ líneas omitidas …\]/);
  assert.equal(s.recortarSalida('corta\n'), 'corta\n', 'una salida dentro del tope queda igual');
});

// Mutación: cortar la línea larga sin tope → una sola línea de 1 MB entra entera.
test('una sola línea enorme también queda dentro del tope', () => {
  const out = s.salidaParaGuardar(Buffer.from('x'.repeat(1024 * 1024))).text;
  assert.ok(Buffer.byteLength(out) <= s.SALIDA_MAX_BYTES, `${Buffer.byteLength(out)} bytes`);
});

// Mutación: guardar la salida sin pasar por `redact` → la contraseña queda en el archivo que viaja por git.
test('la salida guardada se tapa con las formas de la lista', () => {
  const out = s.salidaParaGuardar(Buffer.from(`Server=acme;${PASSWORD}=${PW};\nlisto\n`)).text;
  assert.ok(!out.includes(PW), out);
  assert.ok(out.includes(`${PASSWORD}=***`), out);
});

// Mutación: decodificar con `latin1` o tirar los bytes inválidos → el sha deja de ser el del texto guardado.
test('bytes que no son texto se guardan como texto con reemplazo', () => {
  const out = s.salidaParaGuardar(Buffer.from([0xff, 0xfe, 0x41, 0x0a])).text;
  assert.equal(out, '��A\n');
});

// Mutación: no tapar `--pass-if` → la credencial que alguien escribió en la expectativa llega al registro.
test('la expectativa se tapa y se corta', () => {
  assert.equal(s.expectativaParaGuardar(`conecta con ${PASSWORD}=${PW}`).text, `conecta con ${PASSWORD}=***`);
  assert.ok(s.expectativaParaGuardar('x'.repeat(5000)).text.length <= 1000);
});

// Mutación: escribir la salida aunque la carpeta no se pueda crear (o dejar el sha) → la matriz contaría un archivo que
// no existe; o no escribirla con apertura exclusiva → dos humos del mismo segundo se pisan.
test('ledgerExtras: escribe la salida con su sha, y con la carpeta bloqueada deja output: null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-extras-'));
  const tmp = path.join(dir, 'salida.tmp');
  fs.writeFileSync(tmp, 'HTTP 200\n');
  const a = s.ledgerExtras({ pasaSi: 'responde 200', salidaTmp: tmp, evidenceDir: dir, key: '9.9', ts: '2026-10-15T21:45:00Z' });
  const b = s.ledgerExtras({ pasaSi: 'responde 200', salidaTmp: tmp, evidenceDir: dir, key: '9.9', ts: '2026-10-15T21:45:00Z' });
  assert.match(a.ledger.output, /^9\.9-smoke-outputs\/20261015T214500Z-[0-9a-f]{6}\.txt$/);
  assert.notEqual(a.ledger.output, b.ledger.output, 'el mismo segundo no pisa');
  assert.equal(a.mirror.output_sha, a.ledger.output_sha);
  assert.equal(a.mirror.pass_if_sha, require('crypto').createHash('sha256').update('responde 200').digest('hex'));
  fs.writeFileSync(path.join(dir, '9.8-smoke-outputs'), '');
  const c = s.ledgerExtras({ pasaSi: 'x', salidaTmp: tmp, evidenceDir: dir, key: '9.8', ts: '2026-10-15T21:45:00Z' });
  assert.equal(c.ledger.output, null);
  assert.equal(c.mirror.output_sha, undefined);
  assert.equal(s.fragmento({ a: 1, b: 'x' }), ',"a":1,"b":"x"');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Casos límite ───────────────────────────────────────────────────

// Mutación: tapar la expectativa o la salida en modo guion (sin `literal`) → un valor que empieza con `$` se toma por
// una variable y la contraseña queda tal cual. Son textos ya resueltos, como los argumentos de `cmd`.
test('una contraseña que empieza con $ se tapa en la expectativa y en la salida', () => {
  const pw = '$' + 'ecret9X';
  assert.ok(!s.expectativaParaGuardar(`conecta con ${PASSWORD}=${pw}`).text.includes(pw));
  const out = s.salidaParaGuardar(Buffer.from(`${PASSWORD}=${pw}\nDB_PASSWORD=${pw}\n`)).text;
  assert.ok(!out.includes(pw), out);
});

// Mutación: sacar la red final por línea → una línea JSON con `\n` justo antes de la forma pasa el tapado (en crudo ve
// una `n` delante) y el freno del commit, que decodifica el JSON, la frena.
test('la salida guardada no deja nada que el freno del commit vea como secreto', () => {
  const linea = JSON.stringify({ log: `inicio\n${PASSWORD}=${PW};\nfin` });
  const out = s.salidaParaGuardar(Buffer.from(`${linea}\nlisto\n`)).text;
  assert.deepEqual(s.findLeaksInContent(out), [], out);
  assert.ok(!out.includes(PW), out);
});

// Mutación: guardar los `\r\n` tal cual → git los reescribe al hacer checkout y la matriz da la salida por editada.
test('la salida se guarda con finales de línea \\n', () => {
  assert.equal(s.salidaParaGuardar(Buffer.from('HTTP/1.1 200 OK\r\nx: 1\r\n')).text, 'HTTP/1.1 200 OK\nx: 1\n');
});

// Mutación: recortar ANTES de tapar → si el corte cae entre `sqlcmd … \` y su `-P '<clave>'`, la cola guarda la línea
// del -P sin su sqlcmd y nadie la reconoce. Se prueba en todos los puntos de corte de la zona.
test('recortar no parte una credencial de dos líneas', () => {
  const relleno = (n) => Array.from({ length: n }, (_, i) => `relleno ${String(i).padStart(4, '0')} ${'x'.repeat(24)}`);
  for (let i = 80; i <= 330; i += 3) {
    const lineas = relleno(400);
    lineas.splice(i, 0, 'sqlcmd -S acme -U sa \\', `  -P '${PW}' -Q "select 1"`);
    const out = s.salidaParaGuardar(Buffer.from(lineas.join('\n'))).text;
    assert.ok(!out.includes(PW), `con el par en la línea ${i} la contraseña quedó: ${out.slice(0, 200)}`);
  }
});

// Mutación: ventanas que se pisan con 400 líneas esconden el caso en que son disjuntas → con 5.000 líneas, el par en
// las dos puntas del corte.
test('recortar no parte una credencial de dos líneas en una salida larga', () => {
  const relleno = Array.from({ length: 5000 }, (_, i) => `relleno ${String(i).padStart(4, '0')} ${'x'.repeat(24)}`);
  for (const i of [...Array.from({ length: 25 }, (_, k) => 85 + k), ...Array.from({ length: 25 }, (_, k) => 4880 + k)]) {
    const lineas = relleno.slice();
    lineas.splice(i, 0, 'sqlcmd -S acme -U sa \\', `  -P '${PW}' -Q "select 1"`);
    const out = s.salidaParaGuardar(Buffer.from(lineas.join('\n'))).text;
    assert.ok(!out.includes(PW), `con el par en la línea ${i} la contraseña quedó`);
  }
});

// Mutación: cortar sin mirar si parte un `***` → queda un `**` suelto que el freno del commit lee como un valor.
test('cortar no deja un *** partido', () => {
  assert.equal(s.cortaSinPartirMascara('aaa***bbb', 4), 'aaa');
  assert.equal(s.cortaSinPartirMascara('aaa***bbb', 6), 'aaa***');
  assert.equal(s.cortaSinPartirMascara('corto', 100), 'corto');
});

// Mutación: sacar el tope final → el tapado general alarga los valores cortos (`a:bcde` → `$USUARIO:$VAL`) y una salida
// que entraba justa queda pasada de 8 KB.
test('el tapado que alarga los valores no deja la salida pasada del tope', () => {
  const linea = 'curl -u a:bcde http://x';
  const n = Math.floor((s.SALIDA_MAX_BYTES - 10) / (linea.length + 1));
  const texto = Array.from({ length: n }, () => linea).join('\n');
  assert.ok(Buffer.byteLength(texto) <= s.SALIDA_MAX_BYTES, 'la entrada entra justa');
  const out = s.salidaParaGuardar(Buffer.from(texto)).text;
  assert.ok(Buffer.byteLength(out) <= s.SALIDA_MAX_BYTES, `${Buffer.byteLength(out)} bytes`);
  assert.ok(!out.includes('a:bcde'));
});

// Mutación: cortar una línea larga antes de taparla → un token partido queda más corto que lo que reconoce el tapado.
test('una línea larga no deja un pedazo de token sin tapar', () => {
  for (let pos = 3880; pos <= 4060; pos += 11) {
    const json = `{"datos":"${'d'.repeat(pos)}","token":"Zq9Xw7${'k'.repeat(30)}","mas":"${'m'.repeat(20000)}"}`;
    const out = s.salidaParaGuardar(Buffer.from(json + '\nfin\n')).text;
    assert.ok(!out.includes('Zq9'), `con el token en ${pos} quedó un pedazo`);
    assert.ok(Buffer.byteLength(out) <= s.SALIDA_MAX_BYTES);
  }
});
