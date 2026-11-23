'use strict';
/**
 * failed-query-connectors.test.js — el aviso de consultas fallidas (scripts/hooks/failed-query-notice.js) es neutro: qué
 * comando de una plataforma es una consulta, y su aviso propio, los trae el conector en `scripts/query-notice.js`.
 * Sin red: sólo textos y una casa de juguete.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'failed-query-notice.js');

// 🔴 Falla con: el gancho del núcleo escribe qué comando de cada plataforma es una consulta (`az … list`, `gh pr list`) y
// el aviso del proyecto de una de ellas, en vez de leerlo de su conector
test('FailedQuery_LoDeCadaPlataformaLoTraeSuConector: el gancho no nombra ninguna plataforma y clasifica igual', () => {
  const fuente = fs.readFileSync(HOOK, 'utf8');
  assert.doesNotMatch(fuente, /cmd === 'az'|cmd === 'gh'|AZ_LEE|GH_LEE|devops|'az-projects\.json'/, 'el gancho no escribe lo de una plataforma');
  for (const c of ['azure-devops', 'github']) assert.ok(fs.existsSync(path.join(ROOT, 'integrations', c, 'scripts', 'query-notice.js')), `${c} trae su query-notice.js`);
  const H = require(HOOK);
  const clase = (s) => H.clasificar(s).clase;
  assert.strictEqual(clase('az repos pr list --project X'), 'consulta');
  assert.strictEqual(clase('az repos pr create --title t'), 'otro');
  assert.strictEqual(clase('az devops invoke --area git'), 'consulta');
  assert.strictEqual(clase('gh pr list'), 'consulta');
  assert.strictEqual(clase('gh api repos/acme/x'), 'consulta');
  assert.strictEqual(clase('gh api -X POST repos/acme/x'), 'otro');
  assert.strictEqual(clase('curl https://acme.invalid/x'), 'consulta');
});

test('FailedQuery_ElAvisoDelProyectoYElRefrescoSiguenAndando: con la lista guardada, el proyecto que no existe se avisa', () => {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'fq-conectores-'));
  const estado = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(casa);
  fs.mkdirSync(estado, { recursive: true });
  // stable-data: la lista vale 30 días contados con el reloj del gancho, que corre en otro proceso: se guarda con la de hoy
  fs.writeFileSync(path.join(estado, 'az-projects.json'), JSON.stringify({ org: 'https://acme.invalid', fecha: new Date().toISOString(), proyectos: ['Acme Logistica', 'Otro'] }));
  const correr = (command) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '' } }), encoding: 'utf8', env: { ...process.env, HOME: casa, USERPROFILE: casa } });
  const r = correr('az repos pr list --project Acme | sed 1d');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /no existe en la organización/);
  assert.match(r.stderr, /Acme Logistica/);
  assert.strictEqual(correr('az repos pr list --project "Acme Logistica" --output table').status, 0);
  // el refresco que lanza el instalador: `--refresh` lo corre el conector que sabe hacerlo, con el `az` que encuentra (acá
  // uno de mentira), y la lista que queda es la que devolvió, no la guardada a mano
  if (process.platform !== 'win32') {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fq-az-'));
    fs.writeFileSync(path.join(bin, 'az'), '#!/bin/sh\ncase "$*" in *"project list"*) echo \'[{"name":"Recien Creado"}]\' ;; *) exit 1 ;; esac\n', { mode: 0o755 });
    const ref = spawnSync(process.execPath, [HOOK, '--refresh', '--org', 'https://acme.invalid'], { encoding: 'utf8', env: { ...process.env, HOME: casa, USERPROFILE: casa, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.strictEqual(ref.status, 0, ref.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(estado, 'az-projects.json'), 'utf8')).proyectos, ['Recien Creado'], 'el refresco no dejó la lista del az');
  }
  // sin conectores al lado (el gancho suelto), lo de la plataforma no se juzga y el resto sigue
  const suelto = fs.mkdtempSync(path.join(os.tmpdir(), 'fq-suelto-'));
  fs.mkdirSync(path.join(suelto, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(suelto, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(HOOK, path.join(suelto, 'scripts', 'hooks', 'failed-query-notice.js'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', 'shell-parse.js'), path.join(suelto, 'scripts', 'lib', 'shell-parse.js'));
  const S = require(path.join(suelto, 'scripts', 'hooks', 'failed-query-notice.js'));
  assert.strictEqual(S.clasificar('az repos pr list').clase, 'otro');
  assert.strictEqual(S.clasificar('curl https://acme.invalid/x').clase, 'consulta');
});

// 🔴 Falla con: la lista de palabras del comando se corta en la primera opción (`gh -R o/r pr list`, `az --only-show-errors
// repos …` no son consultas), `gh search` y `az rest` no están, el proyecto de `az.cmd`/`az.exe` no se mira, y un método de
// escritura pegado a su opción (`--method=POST`, `-XPOST`) pasa por lectura
test('FailedQuery_FormasQueNoSeVeian: opción antes del subcomando, search, rest, az.cmd y método con «=»', () => {
  const H = require(HOOK);
  const clase = (s) => H.clasificar(s).clase;
  for (const c of ['gh -R o/r pr list', 'gh --repo o/r pr view 3', 'gh search prs foo', 'gh search issues --owner acme x',
    'az --only-show-errors repos pr list', 'az -o json repos pr list', 'az rest --url https://x', 'az rest --method get --url https://x',
    'az rest -m GET --url https://x', 'AZ.CMD repos pr list']) assert.strictEqual(clase(c), 'consulta', c);
  for (const c of ['gh api repos/x --method=POST', 'gh api -XPOST x', 'gh api -X post x', 'gh -R o/r pr create --title t',
    'az devops invoke --area wit --http-method=POST', 'az rest --method post --url https://x', 'az rest --method=PUT --url https://x',
    'az rest -m delete --url https://x', 'gh api repos/x -X=POST', 'gh api x -fname=v', 'gh api x -Fa=b', 'az rest -mput --url u',
    'az rest -m=patch --url u']) assert.strictEqual(clase(c), 'otro', c);
  // las de siempre no cambian
  for (const c of ['gh pr list -R o/r', 'gh api repos/x --method GET', 'gh api -XGET x', 'gh api x -X=GET', 'az rest -mget --url u',
    'az repos pr list --project X']) assert.strictEqual(clase(c), 'consulta', c);
  const A = require(path.join(ROOT, 'integrations', 'azure-devops', 'scripts', 'query-notice.js'));
  const AY = H.AYUDA;
  for (const c of ['az repos pr list --project Inexistente', 'az.cmd repos pr list --project Inexistente', 'C:\\x\\az.exe repos pr list --project Inexistente',
    'az --only-show-errors repos pr list --project Inexistente']) assert.deepStrictEqual(A.proyectos(c, AY), ['Inexistente'], c);
});
