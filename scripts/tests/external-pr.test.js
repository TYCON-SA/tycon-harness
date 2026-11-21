'use strict';
/**
 * external-pr.test.js — encolar o mergear un pedido de alguien de afuera del equipo lo aprueba el dueño (regla GIT-C7).
 *
 * Mira tres capas: el lector (scripts/lib/external-pr.js), que dice qué pedido encola o mergea un comando y de quién es;
 * el freno de la sesión de verdad (scripts/hooks/safety-guard-pre.sh) con una casa de juguete; y el cuadro de la firma
 * (signature-sources.js). GitHub es un `gh` falso en el PATH: nada sale a la red. El autor de afuera es
 * «colaborador-externo»; el del equipo, «equipo-uno».
 *
 * Los comandos van en las tablas de abajo, nunca en el texto de un comando: el freno de esta máquina los frenaría.
 * Correr: node --test scripts/tests/external-pr.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const LECTOR = path.join(RAIZ, 'scripts', 'lib', 'external-pr.js');
const SID = 's-external-pr';
const PERFIL = { pull_requests: { team_authors: ['equipo-uno', 'app/robot-del-equipo'] } };

// El `gh` falso: el pedido 1304 es de afuera, el 77 del equipo, el 55 de un bot de afuera y el 56 de un bot del equipo.
// Con GH_FALSO_FALLA=1 sale 1, como sin red. Por GraphQL, el id PR_afuera es el 1304 y PR_equipo el 77.
const GH_FALSO = `#!/bin/bash
if [ "\${GH_FALSO_FALLA:-}" = "1" ]; then echo "error connecting to api.github.com" >&2; exit 1; fi
dato() {
  case "$1" in
    1304|PR_afuera) printf '%s' '{"number":1304,"title":"Agrega una prueba","changedFiles":3,"author":{"login":"colaborador-externo","__typename":"User"},"repository":{"nameWithOwner":"acme/arnes"}}' ;;
    77|PR_equipo) printf '%s' '{"number":77,"title":"Arreglo del equipo","changedFiles":1,"author":{"login":"equipo-uno","__typename":"User"},"repository":{"nameWithOwner":"acme/arnes"}}' ;;
    55) printf '%s' '{"number":55,"title":"Sube una dependencia","changedFiles":1,"author":{"login":"app/robot-de-afuera"}}' ;;
    56) printf '%s' '{"number":56,"title":"Sube otra dependencia","changedFiles":1,"author":{"login":"app/robot-del-equipo"}}' ;;
    *) echo "no pull requests found" >&2; exit 1 ;;
  esac
}
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then dato "$3"; exit $?; fi
# la cuenta con que está autenticado: GH_FALSO_YO (sin valor, equipo-uno); con GH_FALSO_SIN_YO=1 no se puede leer
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  if [ "\${GH_FALSO_SIN_YO:-}" = "1" ]; then echo "HTTP 401: Bad credentials" >&2; exit 1; fi
  echo "\${GH_FALSO_YO:-equipo-uno}"; exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  for a in "$@"; do case "$a" in id=*) printf '{"data":{"node":'; dato "\${a#id=}" || exit 1; printf '}}'; exit 0 ;; esac; done
fi
echo "gh falso: no sé contestar $*" >&2; exit 1
`;

function carpeta(t, prefijo) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Una carpeta con el `gh` falso, para poner delante en el PATH. */
function ghFalso(t) {
  const d = carpeta(t, 'gh-falso-');
  fs.writeFileSync(path.join(d, 'gh'), GH_FALSO, { mode: 0o755 });
  return d;
}

/** Una copia del árbol del freno con el perfil del equipo en su raíz (`perfil` null: sin perfil). */
function arbol(t, perfil = PERFIL) {
  const a = carpeta(t, 'external-pr-arbol-');
  for (const d of ['scripts/hooks', 'scripts/lib', 'scripts/setup', 'skills/tycon-pipeline/scripts/lib', 'integrations']) fs.cpSync(path.join(RAIZ, d), path.join(a, d), { recursive: true });
  if (perfil !== null) fs.writeFileSync(path.join(a, 'team-profile.json'), JSON.stringify(perfil));
  return a;
}

/** Corre el freno de la sesión con ese comando. `codex`: sin ventana de permiso, la ventana niega siempre. */
function freno(t, comando, { home, tree, gh, codex = false, env = {} } = {}) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${gh}${path.delimiter}${process.env.PATH}`, ...env };
  for (const k of Object.keys(e)) if (/^TYCON_/.test(k) && !(k in env)) delete e[k];
  const r = spawnSync('bash', [path.join(tree, 'scripts', 'hooks', 'safety-guard-pre.sh')], {
    input: JSON.stringify({ session_id: SID, tool_use_id: 'toolu_x', tool_name: 'Bash', tool_input: { command: comando }, cwd: home, ...(codex ? { turn_id: 'turn-1' } : {}) }),
    env: e, encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}
const pideVentana = (r) => /"permissionDecision"\s*:\s*"ask"/.test(r.stdout);

/** El lector, con el `gh` falso y el perfil de juguete. */
function decidir(t, comando, { gh, tree, env = {} } = {}) {
  const E = require(path.join(tree, 'scripts', 'lib', 'external-pr.js'));
  return E.decidir(comando, { cwd: os.tmpdir(), home: carpeta(t, 'external-pr-casa-'), arnes: tree, env: { ...process.env, PATH: `${gh}${path.delimiter}${process.env.PATH}`, ...env } });
}

// --- el lector -------------------------------------------------------------------------------------------------------

test('T1 Lector_LasFormasQueEncolanOMergean — y lo que no encola nada', () => {
  const leer = require(LECTOR).leer;
  const tabla = [
    ['gh pr merge 1304 -R acme/arnes --merge', [{ repo: 'acme/arnes', numero: 1304 }]],
    ['gh pr merge 1304 -R acme/arnes --merge --auto', [{ repo: 'acme/arnes', numero: 1304 }]],
    ['gh pr merge 1304 --squash', [{ repo: null, numero: 1304 }]],
    ['gh pr merge https://github.com/acme/arnes/pull/1304', [{ repo: 'acme/arnes', numero: 1304 }]],
    ['gh api -X PUT repos/acme/arnes/pulls/1304/merge', [{ repo: 'acme/arnes', numero: 1304 }]],
    ['gh api graphql -f query=\'mutation{enqueuePullRequest(input:{pullRequestId:"PR_afuera"}){clientMutationId}}\'', [{ id: 'PR_afuera' }]],
    ['gh api graphql -f query=\'mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}\' -f id=PR_afuera', [{ id: 'PR_afuera' }]],
    ['gh api graphql -f query=\'mutation($p:ID!){mergePullRequest(input:{pullRequestId:$p}){clientMutationId}}\' -F p=PR_afuera', [{ id: 'PR_afuera' }]],
  ];
  // sólo lo que identifica al pedido: el repo, el número o el id
  const pedido = (x) => JSON.parse(JSON.stringify({ repo: x.repo === undefined ? undefined : x.repo && x.repo.toLowerCase(), numero: x.numero, id: x.id }));
  for (const [cmd, esperado] of tabla) assert.deepStrictEqual(leer(cmd).map(pedido), esperado, cmd);
  for (const cmd of ['gh pr view 1304', 'gh pr merge --disable-auto 1304 -R acme/arnes', 'echo gh pr merge 1304', 'grep -n "gh pr merge" notas.md',
    'gh pr list --state open', 'gh api repos/acme/arnes/pulls/1304']) {
    assert.deepStrictEqual(leer(cmd), [], cmd);
  }
  // lo que no se lee entero: no se sabe qué pedido es
  for (const cmd of ['gh pr merge $N', 'gh pr merge', 'bash -c "gh pr merge 1304"', 'cd $OTRA && gh pr merge 1304', 'gh pr merge mi-rama',
    'gh api graphql -f query="$Q" -f x=enqueuePullRequest', 'gh api graphql -f query=\'mutation{enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}\'']) {
    const l = leer(cmd);
    assert.ok(l.length && l.every((x) => x.ilegible), `${cmd}: ${JSON.stringify(l)}`);
  }
});

test('T2 Decidir_DeAfueraPideFirma_DelEquipoPasa — con el detalle que ve el dueño', (t) => {
  const gh = ghFalso(t);
  const tree = arbol(t);
  const r = decidir(t, 'gh pr merge 1304 -R acme/arnes --merge', { gh, tree });
  assert.ok(r && r.firmas, JSON.stringify(r));
  assert.match(r.firmas[0], /acme\/arnes#1304 de colaborador-externo/);
  assert.match(r.firmas[0], /«Agrega una prueba», 3 archivos/);
  assert.strictEqual(decidir(t, 'gh pr merge 77 -R acme/arnes --merge', { gh, tree }), null, 'del equipo');
  // por GraphQL, por el id del pedido
  assert.ok(decidir(t, 'gh api graphql -f query=\'mutation{enqueuePullRequest(input:{pullRequestId:"PR_afuera"}){clientMutationId}}\'', { gh, tree }).firmas);
  assert.strictEqual(decidir(t, 'gh api graphql -f query=\'mutation{enqueuePullRequest(input:{pullRequestId:"PR_equipo"}){clientMutationId}}\'', { gh, tree }), null);
  // un bot es de afuera salvo que el perfil lo nombre
  assert.ok(decidir(t, 'gh pr merge 55 -R acme/arnes --merge', { gh, tree }).firmas, 'bot de afuera');
  assert.strictEqual(decidir(t, 'gh pr merge 56 -R acme/arnes --merge', { gh, tree }), null, 'bot del equipo');
  // dos pedidos en un comando: alcanza con uno de afuera
  assert.strictEqual(decidir(t, 'gh pr merge 77 -R acme/arnes --merge && gh pr merge 1304 -R acme/arnes --merge', { gh, tree }).firmas.length, 1);
});

test('T3 Decidir_NoSeSabeDeQuienEs_Frena — sin red, sin perfil que se lea, sin lista', (t) => {
  const gh = ghFalso(t);
  const r = decidir(t, 'gh pr merge 1304 -R acme/arnes --merge', { gh, tree: arbol(t), env: { GH_FALSO_FALLA: '1' } });
  assert.match(r.frena, /no pude preguntarle a GitHub/);
  assert.match(decidir(t, 'gh pr merge 9999 -R acme/arnes --merge', { gh, tree: arbol(t) }).frena, /no pude preguntarle/, 'un pedido que no existe');
  // el perfil roto: no se sabe quién es del equipo
  const roto = decidir(t, 'gh pr merge 77 -R acme/arnes --merge', { gh, tree: arbol(t, { pull_requests: { team_authors: 'equipo-uno' } }) });
  assert.match(roto.frena, /no sé quién es del equipo/);
  // sin lista en el perfil y sin poder leer la cuenta del CLI: no se sabe quién es del equipo
  assert.match(decidir(t, 'gh pr merge 77 -R acme/arnes --merge', { gh, tree: arbol(t, null), env: { GH_FALSO_SIN_YO: '1' } }).frena, /no pude leer con qué cuenta/);
  // un `gh` que contesta algo que no se lee
  const raro = carpeta(t, 'gh-raro-');
  fs.writeFileSync(path.join(raro, 'gh'), '#!/bin/bash\necho no-es-json\n', { mode: 0o755 });
  assert.match(decidir(t, 'gh pr merge 1304 -R acme/arnes --merge', { gh: raro, tree: arbol(t) }).frena, /no se lee/);
});

// --- el freno de la sesión -------------------------------------------------------------------------------------------

test('T4 Freno_PedidoDeAfuera_SinVentanaNoCorre_ConVentanaLaPide', (t) => {
  const home = carpeta(t, 'external-pr-casa-');
  const gh = ghFalso(t);
  const tree = arbol(t);
  // Codex no tiene ventana de permiso: el freno niega y dice de quién es el pedido
  const r = freno(t, 'gh pr merge 1304 -R acme/arnes --merge', { home, tree, gh, codex: true });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /GIT-C7/);
  assert.match(r.stderr, /colaborador-externo/);
  // con la herramienta, nunca deja pasar sola: pide la ventana o, sin ella (esta casa de juguete), frena con GIT-C7
  for (const cmd of ['gh pr merge 1304 -R acme/arnes --merge', 'gh pr merge 1304 -R acme/arnes --merge --auto',
    'gh api graphql -f query=\'mutation{enqueuePullRequest(input:{pullRequestId:"PR_afuera"}){clientMutationId}}\'']) {
    const r2 = freno(t, cmd, { home, tree, gh });
    assert.ok(r2.status === 2 || pideVentana(r2), `${cmd}: dejó pasar: ${r2.stderr}`);
    if (r2.status === 2) assert.match(r2.stderr, /GIT-C7/);
  }
});

test('T5 Freno_PedidoDelEquipo_PasaSinPregunta — y lo que no encola nada tampoco pregunta', (t) => {
  const home = carpeta(t, 'external-pr-casa-');
  const gh = ghFalso(t);
  const tree = arbol(t);
  for (const cmd of ['gh pr merge 77 -R acme/arnes --merge', 'gh pr merge 77 -R acme/arnes --merge --auto', 'gh pr view 1304 -R acme/arnes', 'gh pr merge --disable-auto 1304 -R acme/arnes']) {
    const r = freno(t, cmd, { home, tree, gh });
    assert.strictEqual(r.status, 0, `${cmd}: ${r.stderr}`);
    assert.ok(!pideVentana(r), `${cmd}: pidió la ventana`);
  }
});

test('T6 Freno_NoSabeDeQuienEs_FrenaSinVentana — sin red, escondido, sin repo tras un cd', (t) => {
  const home = carpeta(t, 'external-pr-casa-');
  const gh = ghFalso(t);
  const tree = arbol(t);
  const sinRed = freno(t, 'gh pr merge 77 -R acme/arnes --merge', { home, tree, gh, env: { GH_FALSO_FALLA: '1' } });
  assert.strictEqual(sinRed.status, 2, sinRed.stderr);
  assert.match(sinRed.stderr, /GIT-C7/);
  assert.match(sinRed.stderr, /no pude preguntarle a GitHub/);
  assert.ok(!pideVentana(sinRed));
  for (const cmd of ['gh pr merge $N -R acme/arnes --merge', 'cd /otra && gh pr merge 77 --merge', 'gh pr merge --merge']) {
    const r = freno(t, cmd, { home, tree, gh });
    assert.strictEqual(r.status, 2, `${cmd}: ${r.stderr}`);
    // el número armado por la terminal ya lo frena antes la regla de mergear salteando la cola (GIT-C5)
    assert.match(r.stderr, /GIT-C[57]/, cmd);
    assert.ok(!pideVentana(r), `${cmd}: pidió la ventana`);
  }
  // un lector que no está: frena, no deja pasar
  fs.rmSync(path.join(tree, 'scripts', 'lib', 'external-pr.js'));
  const sinLector = freno(t, 'gh pr merge 77 -R acme/arnes --merge', { home, tree, gh });
  assert.strictEqual(sinLector.status, 2, sinLector.stderr);
  assert.match(sinLector.stderr, /GIT-C7/);
});

// --- la firma y su cuadro --------------------------------------------------------------------------------------------

test('T7 Firma_NivelTresNuncaDelegada_YElCuadroDiceElPedido', (t) => {
  const S = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  const f = S.SIGNATURES.find((s) => s.id === 'escape:external-pr');
  assert.ok(f, 'la firma está en el catálogo');
  assert.strictEqual(f.level, 3);
  assert.strictEqual(f.kind, 'freno');
  assert.ok(!S.GROUPS['escape-phrases'].includes('escape:external-pr'), 'no entra al grupo que se delega junto');
  const DS = fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'), 'utf8');
  assert.match(DS, /\['escape:external-pr', '[^']*no se delega'\]/);
  // el cuadro: el autor, el número, el título y los archivos, preguntados al `gh` falso
  const gh = ghFalso(t);
  const tree = arbol(t);
  const antes = process.env.PATH;
  process.env.PATH = `${gh}${path.delimiter}${antes}`;
  t.after(() => { process.env.PATH = antes; });
  const fuentes = require(path.join(tree, 'scripts', 'lib', 'signature-sources.js'));
  const p = fuentes.partesDe({ firma: 'escape:external-pr', palabras: ['gh', 'pr', 'merge', '1304', '-R', 'acme/arnes', '--merge'], cwd: os.tmpdir(), casa: carpeta(t, 'external-pr-casa-') });
  assert.ok(!p.error, p.error);
  assert.match(p.queHace[0], /#1304 de colaborador-externo.*«Agrega una prueba», 3 archivos/);
  assert.match(p.fuente, /colaborador-externo/);
  // un pedido del equipo no tiene cuadro: no hay nada que firmar
  assert.ok(fuentes.partesDe({ firma: 'escape:external-pr', palabras: ['gh', 'pr', 'merge', '77', '-R', 'acme/arnes'], cwd: os.tmpdir(), casa: carpeta(t, 'external-pr-casa-') }).error);
});

test('T8 Configuracion_LasCuentasDelEquipo_SoloDesdeElPerfil', () => {
  const C = require(path.join(RAIZ, 'scripts', 'lib', 'tycon-config.js'));
  assert.ok(C.PROFILE_ONLY.includes('pull_requests.team_authors'), 'la máquina no se puede sumar a la lista');
  assert.strictEqual(C.validarTipo('cuentas', ['equipo-uno', 'app/robot-del-equipo', 'robot[bot]']), null);
  for (const malo of ['equipo-uno', [], ['dos palabras'], [7]]) assert.ok(C.validarTipo('cuentas', malo), JSON.stringify(malo));
});

// --- lo que encontró el pase adversarial -----------------------------------------------------------------------------

test('T9 Pase_LoQueSeEscapaba — el verbo con comillas o tras -R, el repo armado, dos pedidos en una consulta', (t) => {
  const gh = ghFalso(t);
  const tree = arbol(t);
  const firma = (cmd) => { const r = decidir(t, cmd, { gh, tree }); assert.ok(r && r.firmas, `${cmd}: ${JSON.stringify(r)}`); };
  const frena = (cmd) => { const r = decidir(t, cmd, { gh, tree }); assert.ok(r && r.frena, `${cmd}: ${JSON.stringify(r)}`); };
  firma('gh pr "merge" 1304 -R acme/arnes --merge');
  firma('gh pr -R acme/arnes merge 1304');
  firma('gh pr merge "#1304" -R acme/arnes');
  for (const cmd of ['gh pr merge 1304 -R $R', 'GH_REPO=$R gh pr merge 1304', 'GH_HOST=otro.example gh pr merge 1304 -R acme/arnes',
    'gh repo set-default acme/otro && gh pr merge 1304', 'cd $X && gh pr merge 1304']) frena(cmd);
  // dos mutaciones: la primera del equipo no tapa la segunda
  firma('gh api graphql -f query=\'mutation{a:enqueuePullRequest(input:{pullRequestId:"PR_equipo"}){clientMutationId} b:enqueuePullRequest(input:{pullRequestId:"PR_afuera"}){clientMutationId}}\'');
  // el mismo campo dos veces: no se sabe cuál usa gh
  frena('gh api graphql -f query=\'mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}\' -f id=PR_equipo -f id=PR_afuera');
});

test('T10 Pase_LoQueMolestaba — el cd a la carpeta del repo, leer si ya entró, un bot con su sufijo', (t) => {
  const gh = ghFalso(t);
  const tree = arbol(t, { pull_requests: { team_authors: ['equipo-uno', 'robot-del-equipo[bot]'] } });
  const dir = carpeta(t, 'external-pr-repo-');
  assert.strictEqual(decidir(t, `cd ${dir} && gh pr merge 77 --merge`, { gh, tree }), null, 'del equipo, desde la carpeta del repo');
  assert.strictEqual(decidir(t, 'gh api repos/acme/arnes/pulls/1304/merge', { gh, tree }), null, 'leer si ya entró no mergea');
  assert.strictEqual(decidir(t, 'gh pr merge 56 -R acme/arnes --merge', { gh, tree }), null, 'el bot del equipo escrito con [bot]');
  assert.ok(decidir(t, 'gh api --method PUT repos/acme/arnes/pulls/1304/merge', { gh, tree }).firmas);
});

test('T11 SinListaEnElPerfil_LaCuentaDelCLIEsDelEquipo — y sin poder leerla, frena', (t) => {
  const home = carpeta(t, 'external-pr-casa-');
  const gh = ghFalso(t);
  const tree = arbol(t, null);
  // la cuenta autenticada abre los pedidos del equipo: pasan sin pregunta
  assert.strictEqual(decidir(t, 'gh pr merge 77 -R acme/arnes --merge', { gh, tree }), null);
  // un autor de afuera nunca es esa cuenta: pide la firma
  assert.ok(decidir(t, 'gh pr merge 1304 -R acme/arnes --merge', { gh, tree }).firmas);
  // otra cuenta autenticada: el pedido de equipo-uno ya no es «suyo»
  assert.ok(decidir(t, 'gh pr merge 77 -R acme/arnes --merge', { gh, tree, env: { GH_FALSO_YO: 'otra-cuenta' } }).firmas);
  // una respuesta que no es una cuenta tampoco vale
  assert.ok(decidir(t, 'gh pr merge 77 -R acme/arnes --merge', { gh, tree, env: { GH_FALSO_YO: 'no es una cuenta' } }).frena);
  // con lista en el perfil, la cuenta del CLI no cuenta: sólo la lista
  assert.ok(decidir(t, 'gh pr merge 77 -R acme/arnes --merge', { gh, tree: arbol(t, { pull_requests: { team_authors: ['otra-cuenta'] } }) }).firmas);
  // el freno de verdad: sin la cuenta, frena con GIT-C7; con ella, el pedido del equipo pasa
  const sinYo = freno(t, 'gh pr merge 77 -R acme/arnes --merge', { home, tree, gh, env: { GH_FALSO_SIN_YO: '1' } });
  assert.strictEqual(sinYo.status, 2, sinYo.stderr);
  assert.match(sinYo.stderr, /GIT-C7/);
  assert.strictEqual(freno(t, 'gh pr merge 77 -R acme/arnes --merge', { home, tree, gh }).status, 0);
});

test('T12 Pase_CambiarDeCuentaEnLaMismaLinea_Frena — el freno miró con la cuenta de antes', (t) => {
  const gh = ghFalso(t);
  const tree = arbol(t, null);
  for (const cmd of ['gh auth switch -u equipo-uno && gh pr merge 1304 -R acme/arnes --merge',
    'gh auth login --with-token < llave.txt; gh pr merge 77 -R acme/arnes --merge',
    'GH_TOKEN=x gh pr merge 77 -R acme/arnes --merge', 'GH_CONFIG_DIR=/otra gh pr merge 77 -R acme/arnes --merge']) {
    const r = decidir(t, cmd, { gh, tree, env: { GH_FALSO_YO: 'colaborador-externo' } });
    assert.ok(r && r.frena, `${cmd}: ${JSON.stringify(r)}`);
  }
  // una cuenta que dice `null` no es una cuenta
  assert.ok(decidir(t, 'gh pr merge 77 -R acme/arnes --merge', { gh, tree, env: { GH_FALSO_YO: 'null' } }).frena);
});

// Caso: el freno frenaba una consulta que sólo lee, `gh pr view N --json state,mergedAt` dentro de `$( … )`: la red gruesa
// contaba la palabra «merge» de un campo como un merge que no se leía entero. Lo que encola o mergea sigue frenando
// aunque esa palabra también aparezca en un --json o un --jq.
test('T13 SoloLee_ConLaPalabraMerge_NoFrena — y lo que encola o mergea sigue frenando', () => {
  const leer = require(LECTOR).leer;
  for (const cmd of [
    'gh pr view 1320 -R acme/arnes --json state,mergedAt',
    's=$(gh pr view 1320 -R acme/arnes --json state,mergedAt --jq .mergedAt)',
    'for n in 1320 1322; do echo "$(gh pr view $n -R acme/arnes --json state,mergedAt --jq \'"\\(.state) \\(.mergedAt)"\')"; done',
    'gh pr list -R acme/arnes --json number,mergeable,mergeStateStatus',
  ]) assert.deepStrictEqual(leer(cmd), [], cmd);
  // lo que encola o mergea, con la palabra también en un --json o un --jq, sigue apareciendo
  const pedido = (x) => JSON.parse(JSON.stringify({ repo: x.repo === undefined ? undefined : x.repo && x.repo.toLowerCase(), numero: x.numero, id: x.id }));
  for (const [cmd, esperado] of [
    ['gh pr view 1320 -R acme/arnes --json mergedAt && gh pr merge 1320 -R acme/arnes --merge', [{ repo: 'acme/arnes', numero: 1320 }]],
    ['x=$(gh pr merge 1320 -R acme/arnes --merge --json mergedAt)', [{ repo: 'acme/arnes', numero: 1320 }]],
    ['s=$(gh api graphql -f query=\'mutation{enqueuePullRequest(input:{pullRequestId:"PR_afuera"}){clientMutationId}}\' --jq .data)', [{ id: 'PR_afuera' }]],
    ['gh api graphql -f query=\'mutation{enqueuePullRequest(input:{pullRequestId:"PR_afuera"}){mergeQueueEntry{id}}}\' --jq .data.enqueuePullRequest', [{ id: 'PR_afuera' }]],
  ]) assert.deepStrictEqual(leer(cmd).map(pedido), esperado, cmd);
  // el pase adversarial: lo que lanza otro programa, o se llena al correr, no cuenta como leído; y una consulta a la API
  // que escribe o lee un archivo tampoco
  for (const cmd of ['cat n | xargs -I{} gh api -X PUT repos/acme/arnes/pulls/{}/merge', 'xargs -I{} gh pr {} 5 -R acme/arnes --merge <<< merge',
    'x=$(gh api repos/acme/arnes/pulls/5/merge --input cuerpo.json)', 'timeout 30 gh api graphql -F query=@merge.graphql',
    'x=$(timeout 30 gh api -X PUT repos/acme/arnes/pulls/5/merge)', 's=$(gh pr view 5 --json mergedAt | xargs gh pr merge 5 -R acme/arnes)',
    // la vuelta 2: opciones pegadas de la API dentro de una sustitución, y la salida de una lectura que corre otra terminal
    'jq . <<< "$(gh api -iX PUT repos/acme/arnes/pulls/5/merge)"', 'jq . <<< "$(gh api -H a graphql -ifquery=\'mutation{enqueuePullRequest(input:{pullRequestId:"PR_x"}){clientMutationId}}\')"',
    'x="$(gh pr status --json merged | bash)"']) {
    assert.ok(leer(cmd).length > 0, `${cmd}: tendría que frenar o nombrar el pedido`);
  }
  // con el verbo armado por la terminal, no se sabe si mergea: frena
  for (const cmd of ['y=$(gh pr $V 1320 -R acme/arnes --json mergedAt)', 'gh pr $V 1320 -R acme/arnes --json mergedAt']) {
    const l = leer(cmd);
    assert.ok(l.length && l.every((x) => x.ilegible), `${cmd}: ${JSON.stringify(l)}`);
  }
});
