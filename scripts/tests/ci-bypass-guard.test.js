'use strict';
/**
 * ci-bypass-guard.test.js — mergear salteando la cola y la CI de main lo aprueba una persona (regla GIT-C5).
 *
 * Mira tres capas: el lector (scripts/lib/ci-bypass.js), que dice qué comando saltea la CI o las políticas de main; el
 * freno de la sesión de verdad (scripts/hooks/safety-guard-pre.sh) con una casa de juguete; y la decisión de la ventana
 * de permiso (scripts/lib/owner-window.js) con un árbol de procesos de juguete.
 *
 * Los comandos van en las tablas de abajo, nunca en el texto de un comando: el freno de esta máquina los frenaría.
 * Correr: node --test scripts/tests/ci-bypass-guard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const HOOK = path.join(RAIZ, 'scripts', 'hooks', 'safety-guard-pre.sh');
const LECTOR = path.join(RAIZ, 'scripts', 'lib', 'ci-bypass.js');
const FIRMA = 'escape:merge-bypass';
const SID = 's-ci-bypass';

const leer = (cmd) => require(LECTOR).leer(cmd);
const formas = (cmd) => leer(cmd).map((h) => h.forma);

/** La única forma que el lector encuentra en el comando, con su firma y si se puede leer entera. */
function unaForma(cmd, forma, { legible = true } = {}) {
  const hs = leer(cmd);
  assert.ok(hs.length >= 1, `${cmd}: el lector no vio nada`);
  for (const h of hs) {
    assert.strictEqual(h.firma, FIRMA, `${cmd}: firma ${h.firma}`);
    assert.strictEqual(h.legible, legible, `${cmd}: legible ${h.legible} (${h.motivo || ''})`);
    if (legible) assert.strictEqual(h.forma, forma, `${cmd}: forma ${h.forma}`);
  }
}

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-bypass-'));
  if (t) t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  return casa;
}

/** Corre el freno de la sesión con ese comando. `codex`: sin ventana de permiso, la ventana niega siempre. */
function freno(comando, { home, hook = HOOK, codex = false, env = {}, tool = 'Bash' } = {}) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, ...env };
  for (const k of Object.keys(e)) if (/^TYCON_/.test(k) && !(k in env)) delete e[k];
  const r = spawnSync('bash', [hook], {
    input: JSON.stringify({ session_id: SID, tool_use_id: 'toolu_x', tool_name: tool, tool_input: { command: comando }, cwd: home, ...(codex ? { turn_id: 'turn-1' } : {}) }),
    env: e, encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}
const pideVentana = (r) => /"permissionDecision"\s*:\s*"ask"/.test(r.stdout);

// --- el lector -------------------------------------------------------------------------------------------------------

const ADMIN = [
  'gh pr merge 5 --admin',
  'gh pr merge 5 --admin=true',
  'gh -R o/r pr merge 5 --admin',
  'sudo gh pr merge 5 --admin',
  'env A=1 gh pr merge 5 --admin',
  'time gh pr merge 5 --admin',
  'nohup gh pr merge 5 --admin',
  'git fetch && gh pr merge 5 --admin',
  'echo x; gh pr merge 5 --admin',
  'echo 5 | gh pr merge 5 --admin',
  // un valor que arma la terminal no esconde el --admin: la forma se lee entera y pide la ventana
  'gh pr merge 5 --admin --subject "$TITULO"',
  // las envolturas que corren el mismo comando, sin otros argumentos, la piden igual que sudo
  'timeout 30 gh pr merge 5 --admin',
  'nice gh pr merge 5 --admin',
  'if gh pr merge 5 --admin; then echo listo; fi',
  'while true; do gh pr merge 5 --admin; done',
  '{ gh pr merge 5 --admin; }',
  // el repo entre el grupo y el verbo, como lo acepta gh
  'gh pr -R o/r merge 5 --admin',
  'gh pr --repo o/r merge 5 --admin',
  'gh pr --repo=o/r merge 5 --admin',
];

test('T1 AdminMerge_PideLaFirma @story-8.241 @ac-1', () => {
  for (const cmd of ADMIN) unaForma(cmd, 'admin-merge');
});

const API_MERGE = [
  'gh api -X PUT repos/o/r/pulls/5/merge',
  'gh api --method=PUT repos/o/r/pulls/5/merge',
  'gh api repos/o/r/pulls/5/merge -f merge_method=merge',
  "gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'",
  "gh api graphql -f query='mutation{mergeBranch(input:{repositoryId:\"x\",base:\"main\",head:\"y\"}){clientMutationId}}'",
  // el método pegado o junto con otra opción corta, como lo acepta gh
  'gh api -X=PUT repos/o/r/pulls/5/merge',
  'gh api -XPUT repos/o/r/pulls/5/merge',
  'gh api -iX PUT repos/o/r/pulls/5/merge',
  'gh api -iXPUT repos/o/r/pulls/5/merge',
  // mergear una rama en otra por REST, y mover una rama por la API
  'gh api repos/o/r/merges -f base=main -f head=feat',
  'gh api -X POST repos/o/r/merges -f base=main -f head=feat',
  'gh api repos/o/r/pulls/5/merge --field merge_method=merge',
  'gh api repos/o/r/merges --raw-field base=main --raw-field head=feat',
  'gh api repos/o/r/pulls/5/merge --raw-field=merge_method=merge',
  'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true',
  "gh api graphql -f query='mutation{updateRefs(input:{repositoryId:\"x\",refUpdates:[]}){clientMutationId}}'",
  "gh api graphql -f query='mutation{updateRef(input:{refId:\"x\",oid:\"y\",force:true}){clientMutationId}}'",
];

test('T3 ApiMerge_PideLaFirma @story-8.241 @ac-2', () => {
  for (const cmd of API_MERGE) unaForma(cmd, 'api-merge');
});

const API_REGLAS = [
  'gh api -X PUT repos/o/r/rulesets/1',
  'gh api -X PATCH repos/o/r/rulesets/1',
  'gh api -X DELETE repos/o/r/rulesets/1',
  'gh api -X POST orgs/o/rulesets',
  'gh api -X PUT repos/o/r/branches/main/protection',
  'gh api -X DELETE repos/o/r/branches/main/protection/enforce_admins',
  'gh api repos/o/r/rulesets --input regla.json',
  'gh api repos/o/r/rulesets --field name=x',
  'gh api repos/o/r/branches/main/protection --raw-field enforce_admins=false',
  "gh api graphql -f query='mutation{createRepositoryRuleset(input:{}){clientMutationId}}'",
  "gh api graphql -f query='mutation{updateRepositoryRuleset(input:{}){clientMutationId}}'",
  "gh api graphql -f query='mutation{deleteRepositoryRuleset(input:{}){clientMutationId}}'",
  "gh api graphql -f query='mutation{updateBranchProtectionRule(input:{}){clientMutationId}}'",
  "gh api graphql -f query='mutation{deleteBranchProtectionRule(input:{}){clientMutationId}}'",
];

test('T4 ReglasDeRama_EscribirPideLaFirma @story-8.241 @ac-2', () => {
  for (const cmd of API_REGLAS) unaForma(cmd, 'api-rules');
});

const LECTURAS_GH = [
  'gh api repos/o/r/rulesets/1',
  'gh api repos/o/r/branches/main/protection',
  'gh api -X GET repos/o/r/rulesets',
  'gh pr view 5',
  'gh pr checks 5',
  "gh api graphql -f query='query{repository(owner:\"o\",name:\"r\"){pullRequest(number:5){isInMergeQueue}}}'",
  "gh api graphql -f query='mutation{enqueuePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'",
  'gh pr merge 5 --merge',
  'gh pr merge 5 --auto --merge',
  'gh pr merge 5 --admin=false',
  'gh api -X POST repos/o/r/issues/5/comments -f body=hola',
  // encolar con el id por variable de GraphQL: sólo el campo query es la consulta
  "gh api graphql -f query='mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}' -f id=\"$PR_ID\"",
  "gh api graphql -f query='query($n:Int!){repository(owner:\"o\",name:\"r\"){pullRequest(number:$n){isInMergeQueue}}}' -F n=\"$N\"",
  // una variable en la ruta de una lectura, o de una escritura que no toca la rama
  'gh api repos/$R/rulesets',
  'gh api -X POST repos/$R/issues -f title=x',
  'gh pr merge 5 --merge --subject="$T"',
  // un programa que corre gh sin saltear nada, o que sólo lo nombra
  'flock /tmp/l gh pr view 5',
  'brew install gh',
  // un alias que no guarda la forma
  "gh alias set co 'pr checkout'",
  // nombrarlo no es correrlo
  // stable-data: es el texto que se le pasa al lector, que nunca lo corre: no crea ningún commit
  'git commit -m "gh pr merge 5 --admin"',
  'echo gh pr merge 5 --admin',
  'grep -n -- --admin scripts/lib/gh-pr.js',
  'ls -la',
];

test('T5 Lecturas_Pasan @story-8.241 @ac-9', () => {
  for (const cmd of LECTURAS_GH) assert.deepStrictEqual(formas(cmd), [], cmd);
});

const AZ = [
  'az repos pr update --id 1 --bypass-policy true',
  'az repos pr update --id 1 --bypass-policy',
  'az repos pr create -s a -t main --bypass-policy true --bypass-policy-reason x',
  'az devops security permission update --id n --subject s --token t --allow-bit 32768',
  'az devops security permission update --id n --subject s --token t --allow-bit 128',
  'az devops security permission update --id n --subject s --token t --allow-bit 2048',
  'az devops security permission update --id n --subject s --token t --allow-bit 8192',
  'az devops security permission update --id n --subject s --token t --allow-bit 32896',
  'az devops security permission update --id n --subject s --token t --allow-bit $BITS',
  'az repos policy build update --id 1 --enabled false',
  'az repos policy delete --id 1',
  'az repos policy approver-count create --repository-id x --branch main --minimum-approver-count 1 --blocking true --enabled true',
  "az rest --method patch --uri https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests/1?api-version=7.1 --body '{\"status\":\"completed\"}'",
  'az devops invoke --area security --resource accessControlEntries --route-parameters securityNamespaceId=x --http-method POST',
  // la ruta completa de Windows (con espacios), el mismo programa por Python y una duración con decimales
  '"C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd" repos policy delete --id 1',
  'python3 -m azure.cli repos policy delete --id 1',
  'python -m azure.cli repos pr update --id 5 --bypass-policy true',
  'timeout 1.5 az repos policy delete --id 1',
  'timeout 0.5m az repos policy delete --id 1',
  // az acepta el prefijo único de una opción: `--met` es `--method`
  'az rest --met put --uri https://dev.azure.com/o/p/_apis/policy/configurations/1',
  'az rest --method put --ur https://dev.azure.com/o/p/_apis/policy/configurations/1',
  'az devops security permission update --id n --subject s --token t --allow 32768',
  'az devops invoke --area policy --resource configurations --http PUT',
  // un prefijo ambiguo (`--b`: body o bypass-policy) no se completa; la forma se lee por lo demás
  'az rest --b {} --method put --uri https://dev.azure.com/o/p/_apis/policy/configurations/1',
];

test('T6 AzBypass_PideLaFirma @story-8.241 @ac-3', (t) => {
  for (const cmd of AZ) unaForma(cmd, 'az-bypass');
  // el cuerpo que no se lee: frena sin ventana, como lo escondido
  for (const cmd of ['az rest --method put --uri https://x/_apis/policy/configurations/1 --body @x.json',
    'az devops invoke --area policy --resource configurations --http-method PUT --in-file x.json']) unaForma(cmd, null, { legible: false });
  const home = casaNueva(t);
  const r = freno('az rest --method put --uri https://x/_apis/policy/configurations/1 --body @x.json', { home });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /GIT-C5/);
  assert.ok(!pideVentana(r), 'pidió la ventana');
});

const LECTURAS_AZ = [
  'az repos pr update --id 1 --bypass-policy false',
  'az devops security permission reset --id n --subject s --token t --permission-bit 32768',
  'az devops security permission show --id n --subject s --token t',
  'az devops security permission update --id n --subject s --token t --deny-bit 128',
  'az repos policy list --branch main',
  'az repos policy show --id 1',
  'az repos pr create --auto-complete true --squash false --delete-source-branch true -s a -t main',
  'az rest --uri https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests/1',
  'az devops invoke --area git --resource pullRequests --http-method GET',
  'git commit -m "az repos pr update --bypass-policy true"',
  // el mensaje armado con la receta de siempre sólo nombra el comando
  "git commit -m \"$(cat <<'EOF'\naz repos policy delete --id 1\nEOF\n)\"",
  "gh pr create --title x --body \"$(cat <<'EOF'\naz repos pr update --id 1 --bypass-policy true\nEOF\n)\"",
];

test('T7 AzSinBypass_Pasan @story-8.241 @ac-9', () => {
  for (const cmd of LECTURAS_AZ) assert.deepStrictEqual(formas(cmd), [], cmd);
});

const ESCONDIDOS = [
  'bash -c "gh pr merge 5 --admin"',
  'eval "gh pr merge 5 --admin"',
  'X="$(gh pr merge 5 --admin)"',
  '$GH pr merge 5 --admin',
  'echo 5 | xargs gh pr merge --admin',
  'bash -c "gh api -X PUT repos/o/r/pulls/5/merge"',
  'sh -c "az repos pr update --id 1 --bypass-policy true"',
  'X="$(az repos policy delete --id 1)"',
  '$AZ repos pr update --id 1 --bypass-policy true',
  'echo 1 | xargs az repos policy delete --id',
  // un programa que este freno no conoce lanza la forma: frena (lo que no se entiende entero no pasa)
  'arch -arm64 gh pr merge 5 --admin',
  'flock /tmp/l gh pr merge 5 --admin',
  'setsid gh pr merge 5 --admin',
  'sudo -E gh pr merge 5 --admin',
  'sudo -u root gh pr merge 5 --admin',
  'env -i gh pr merge 5 --admin',
  'eval gh pr merge 5 --admin',
  'find . -exec gh pr merge 5 --admin \\;',
  'arch -arm64 az repos policy delete --id 1',
  'flock /tmp/l az repos policy delete --id 1',
  'su -c "az repos policy delete --id 1"',
  "bash -c 'az rest -m PUT --uri https://x/_apis/git/repositories/r/pullrequests/1 --body {}'",
  "bash -c 'az rest --method=patch --uri https://x/_apis/policy/configurations/1'",
  // un alias de gh que guarda la forma: el `gh <alias>` que sigue la corre sin nombrarla
  "gh alias set m 'pr merge --admin'",
  'gh alias set --shell m "gh pr merge $1 --admin"',
  "gh alias set m '!az rest -m put --url https://x/_apis/policy/configurations/1'",
  'gh alias set m "$X"',
  'gh alias import aliases.yml',
  "bash -c 'az rest --met put --uri https://x/_apis/policy/configurations/1'",
  "bash -c 'az devops invoke --area policy --resource configurations --http-m PUT'",
  // la red gruesa: escrito como sea adentro del texto (partido en renglones, con otro orden)
  "bash -c 'az rest --uri https://x/_apis/policy/configurations/1 \\\n --method PUT'",
  "eval 'az repos policy approver-count update --id 1 --minimum-approver-count 0'",
  "sh -c 'gh api --method=PATCH repos/o/r/git/refs/heads/main -f sha=x'",
  // la red gruesa, sin perseguir ortografías: la opción de az abreviada, y la ruta o la consulta que no se lee
  "bash -c 'az repos pr update --id 5 --bypass-pol true'",
  "eval 'az repos pr update --id 5 --bypass-p true'",
  "bash -c 'gh api repos/o/r/pulls/5/${m}ge -X PUT'",
  "bash -c 'gh api repos/o/r/pulls/5/$s -XPUT'",
  "bash -c 'gh api graphql -f query=@q.graphql'",
  "bash -c 'gh api graphql --input q.json'",
  // una palabra que arma la terminal donde puede ir la forma
  'gh pr merge $(echo 5) --admin',
  'gh pr merge `echo 5` --admin',
  'gh pr $V 5 --admin',
  'gh $G merge 5 --admin',
  'gh pr merge $X 5',
  'gh pr merge "$N" --merge $OPC',
  'gh api $M repos/o/r/pulls/5/merge',
  'gh api -X PUT repos/o/r/$X/merge',
  'gh api -X PUT repos/o/r/pulls/$N/merge',
];

test('T8 Escondido_FrenaSinVentana @story-8.241 @ac-4', (t) => {
  for (const cmd of ESCONDIDOS) unaForma(cmd, null, { legible: false });
  const home = casaNueva(t);
  for (const cmd of ESCONDIDOS) {
    const r = freno(cmd, { home });
    assert.strictEqual(r.status, 2, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /GIT-C5/, cmd);
    assert.match(r.stderr, /forma exacta/, cmd);
    assert.ok(!pideVentana(r), `${cmd}: pidió la ventana`);
  }
});

test('T15 PrPorMano_NoAbreLaRegla @story-8.241 @ac-9', () => {
  unaForma('TYCON_PR_BY_HAND=1 gh pr merge 5 --admin', 'admin-merge');
  // el método de lectura, o sin valor, no es una forma (ni a la vista ni adentro de un texto)
  for (const cmd of ['az rest -m GET --uri https://x/_apis/policy/configurations/1', 'az rest -m --uri https://x/_apis/policy/configurations/1',
    "bash -c 'az rest -m get --uri https://x/_apis/policy/configurations/1'"]) assert.deepStrictEqual(formas(cmd), [], cmd);
  // un texto armado para trabar la lectura no la cuelga: se lee enseguida, y con una escritura frena
  for (const [largo, frena] of [[`bash -c '${'az rest '.repeat(3000)} -m PUT'`, true], [`bash -c '${'az rest '.repeat(3000)}'`, false],
    [`bash -c '${'gh api '.repeat(3000)} -X PUT repos/o/r/rulesets/1'`, true],
    // una ruta de gh api enorme, armada para trabar las regex de ruta (medido: 760 KB tardaban 20 s)
    [`gh api -X PUT ${'repos/a/b/branches/'.repeat(40000)}`, true], [`gh pr view 5 ${'x'.repeat(300000)}`, false]]) {
    const t0 = Date.now();
    const hs = leer(largo);
    assert.ok(Date.now() - t0 < 2000, `tardó ${Date.now() - t0} ms`);
    assert.strictEqual(hs.length >= 1 && hs.every((h) => !h.legible), frena, JSON.stringify(hs).slice(0, 200));
  }
  // la red gruesa de lo escondido: lo que lee sin escribir, y el camino normal, pasan
  for (const cmd of ["bash -c 'gh pr merge 5 --merge'", "bash -c 'az repos policy list --branch main'", "bash -c 'gh api repos/o/r/rulesets'",
    "bash -c 'az repos pr update --id 1 --bypass-policy false'", "bash -c 'az repos pr create -s a -t main --bypass-policy false --bypass-policy-reason x'",
    "bash -c 'gh api -X POST repos/o/r/issues -f title=x'"]) assert.deepStrictEqual(formas(cmd), [], cmd);
});

// --- el freno de la sesión -------------------------------------------------------------------------------------------

test('T2 AdminMerge_SinVentanaNoCorre @story-8.241 @ac-1 @ac-5', (t) => {
  const home = casaNueva(t);
  // Codex no tiene ventana de permiso: el freno niega y dice el camino normal
  const r = freno('gh pr merge 7 --admin', { home, codex: true });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /GIT-C5/);
  assert.match(r.stderr, /gh pr merge <n> --merge/);
  // con la herramienta, nunca deja pasar sola: pide la ventana o, sin ella (esta casa de juguete), frena con GIT-C5
  const r2 = freno('gh pr merge 7 --admin', { home });
  assert.ok(r2.status === 2 || pideVentana(r2), `dejó pasar: ${r2.stderr}`);
  if (r2.status === 2) assert.match(r2.stderr, /GIT-C5/);
  // lo que no saltea nada sigue pasando
  assert.strictEqual(freno('gh pr view 7', { home }).status, 0);
  // en Windows la herramienta de PowerShell corre el mismo comando con la ruta completa: también lo lee
  for (const cmd of ['& "C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 7 --admin', 'C:\\tools\\gh.exe pr merge 7 --admin']) {
    const ps = freno(cmd, { home, tool: 'PowerShell' });
    assert.ok(ps.status === 2 || pideVentana(ps), `${cmd}: dejó pasar en PowerShell: ${ps.stderr}`);
    assert.ok(ps.status === 2 ? /GIT-C5/.test(ps.stderr) : true, ps.stderr);
  }
});

/** Una copia del árbol del freno, para romperle el lector sin tocar el de verdad. */
function arbolCopiado(t) {
  const arbol = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-bypass-arbol-'));
  t.after(() => fs.rmSync(arbol, { recursive: true, force: true }));
  for (const d of ['scripts/hooks', 'scripts/lib', 'skills/tycon-pipeline/scripts/lib']) fs.cpSync(path.join(RAIZ, d), path.join(arbol, d), { recursive: true });
  return arbol;
}

test('T10 LectorQueFalla_Frena @story-8.241 @ac-6', (t) => {
  const home = casaNueva(t);
  for (const romper of [(f) => fs.rmSync(f), (f) => fs.writeFileSync(f, "'use strict';\nthrow new Error('roto a propósito');\n")]) {
    const arbol = arbolCopiado(t);
    const lector = path.join(arbol, 'scripts', 'lib', 'ci-bypass.js');
    romper(lector);
    const hook = path.join(arbol, 'scripts', 'hooks', 'safety-guard-pre.sh');
    const r = freno('gh pr merge 5 --merge', { home, hook });
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /no pude leer este comando/i);
    assert.match(r.stderr, /GIT-C5/);
    // un comando que no nombra gh ni az no llama al lector
    assert.strictEqual(freno('ls -la', { home, hook }).status, 0);
  }
});

// --- la firma: una vez, nunca delegada, y dónde queda anotada ---------------------------------------------------------

const INICIO = 'Tue Oct 27 10:00:00 2026';
const AHORA = Date.parse('2026-10-27T13:00:00Z');
const ARBOL = [{ pid: 1, ppid: 0, inicio: 'Mon Oct 26 08:00:00 2026', comando: '/sbin/launchd' },
  { pid: 100, ppid: 1, inicio: INICIO, comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' },
  { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
  { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
const SIN_DELEGACION = () => ({ ok: false, motivo: 'sin delegación en la prueba' });

function pedir(casa, cmd, { modo, aprobaciones, delegacion = SIN_DELEGACION } = {}) {
  const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
  const evento = { session_id: 'ses-a', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, ...(modo ? { permission_mode: modo } : {}) };
  return ow.decidir({ evento, escapes: [FIRMA], arbol: ARBOL, pid: 201, casa, ahora: AHORA, delegacion, clasificar: () => null, comprobar: () => null, aprobaciones });
}

function registroComun(casa) {
  const st = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).stateDir(casa);
  try { return fs.readFileSync(path.join(st, 'signatures.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; }
}

test('T9 Firma_UnUsoYNuncaDelegada @story-8.241 @ac-5', (t) => {
  const casa = casaNueva(t);
  const cmd = 'gh pr merge 5 --admin';
  // con la ventana: cada vez que se corre, la pide de nuevo; no queda nada vigente que la deje pasar después
  assert.strictEqual(pedir(casa, cmd).decision, 'ask');
  assert.strictEqual(pedir(casa, cmd).decision, 'ask');
  assert.deepStrictEqual(registroComun(casa), [], 'la ventana no ve el Sí: no hay renglón en el registro común');

  // sin ventana (una pestaña sin permisos), con un click: pasa una vez y queda en el registro común
  let disponibles = 1;
  const aprobaciones = {
    buscar: () => (disponibles > 0 ? { ok: true, via: 'click', aprobacion: { id: 'a-1', texto: 'Aprobar', sesion: 'ses-a' } } : { ok: false, motivo: 'no hay un click sin usar' }),
    consumir: () => { disponibles -= 1; return { ok: true }; },
    devolver: () => { disponibles += 1; },
    coordinadoraConfirmada: () => null,
  };
  const r1 = pedir(casa, cmd, { modo: 'bypassPermissions', aprobaciones });
  assert.strictEqual(r1.decision, 'allow', r1.texto);
  assert.strictEqual(r1.via, 'click');
  const r2 = pedir(casa, cmd, { modo: 'bypassPermissions', aprobaciones });
  assert.notStrictEqual(r2.decision, 'allow', 'el mismo click sirvió dos veces');
  const lineas = registroComun(casa).filter((l) => l.signature === FIRMA);
  assert.strictEqual(lineas.length, 1, JSON.stringify(registroComun(casa)));
  assert.strictEqual(lineas[0].via, 'click');

  // el registro del freno anota el escape con su nombre
  const gr = require(path.join(RAIZ, 'scripts', 'lib', 'guard-record.js'));
  gr.anotar({ freno: 'safety-guard', regla: 'GIT-C5', veredicto: 'escape', cmd, home: casa, via: 'ventana', sesion: 'ses-a', escape: 'merge-bypass' });
  const registro = () => fs.readFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'frenos.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(registro()[registro().length - 1].escape, 'merge-bypass');
  // el freno de verdad deja su renglón de GIT-C5 en ese registro (en esta casa de juguete no hay ventana: niega)
  const antes = registro().length;
  const real = freno(cmd, { home: casa });
  assert.strictEqual(real.status, 2, real.stderr);
  const nuevos = registro().slice(antes);
  assert.ok(nuevos.some((l) => l.freno === 'safety-guard' && l.regla === 'GIT-C5'), JSON.stringify(nuevos));

  // la delegación no la firma aunque el perfil la nombre, y su motivo dice que es sólo del dueño (la ventana lo calla)
  const DS = require(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'));
  const d = DS.delegaSinVentana({ firma: FIRMA, sesion: 'ses-coord', destino: 'ses-a', home: casa,
    perfil: () => ({ delegated_signing: [FIRMA, 'merge-bypass'], owner_only: [], delegated_machines: [] }) });
  assert.strictEqual(d.ok, false);
  assert.match(d.motivo, /sólo del dueño/);
  const porDelegacion = pedir(casa, cmd, { delegacion: (o) => DS.delegaSinVentana({ ...o, perfil: () => ({ delegated_signing: [FIRMA], owner_only: [], delegated_machines: [] }) }) });
  assert.strictEqual(porDelegacion.decision, 'ask', porDelegacion.texto);
});

test('T14 Guias_FirmaYRegla @story-8.241 @ac-8', () => {
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'tools', 'signatures-guide.js'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const guia = fs.readFileSync(path.join(RAIZ, 'guides', 'safety-guard.md'), 'utf8');
  const fila = guia.split('\n').find((l) => l.startsWith('|') && l.includes('GIT-C5'));
  assert.ok(fila, 'safety-guard.md no tiene la fila GIT-C5');
  assert.match(fila, /merge-bypass/);
  const firmas = fs.readFileSync(path.join(RAIZ, 'guides', 'firmas-del-arnes.md'), 'utf8');
  assert.match(firmas, /merge-bypass/);
});
