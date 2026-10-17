'use strict';

/**
 * npm-publish-workflow.test.js — el workflow que publica el instalador en npm (story 8.40, tanda A · T13 a T16).
 *
 * `.github/workflows/npm-publish.yml` corre en el repo PÚBLICO con un permiso que ningún otro workflow tiene: pedir la
 * identidad de la corrida (`id-token: write`) para publicar en npm sin ningún token guardado (trusted publishing, con
 * constancia de procedencia). Por eso se lee por texto con `check-public-workflow.js --publisher`, como el que etiqueta,
 * y sus pasos de shell se corren de verdad con un `npm` de mentira:
 *   · T13 — corre en un push a main que toca scripts/setup/npm/** y a mano sólo en main; nunca en un pedido.
 *   · T14 — `contents: read` arriba; en el job `contents: read` e `id-token: write` y nada más; acciones por sha; sin
 *           secretos.
 *   · T15 — npm en una versión EXACTA ≥ 11.15.0 (nunca @latest) y verificada; LICENSE copiado a la carpeta del paquete;
 *           la integridad mirada antes de publicar; `npm stage publish` desde scripts/setup/npm (nunca `npm publish`).
 *   · T16 — los pasos con un npm de mentira. La publicación se habilita con la VARIABLE de repositorio
 *           `NPM_PUBLISH_ENABLED=true` (no es un secreto): sin ella el job que publica sale salteado, en verde, con un
 *           aviso (::warning::) que dice qué falta configurar —decisión de la coordinadora, 2026-10-16: no es un rojo del
 *           repo, es una tarea del dueño— y npm no se llama. Con ella, CUALQUIER error es rojo: la versión ya publicada
 *           con OTRO contenido («subí version»), un npm viejo, el registro que no contesta, la identidad que npm no acepta
 *           (E401/E403/ENEEDAUTH/OIDC). La versión ya publicada con el MISMO contenido sale 0 «ya publicada» sin
 *           publicar; la versión nueva de un paquete que existe, y el paquete que todavía no existe (E404: la primera
 *           publicación), se publican en etapas.
 *
 * Sin red: el npm de mentira contesta lo que cada caso necesita y anota cada llamada.
 * Correr: node --test scripts/tests/npm-publish-workflow.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const YML = path.join(ROOT, '.github', 'workflows', 'npm-publish.yml');
const WF = require(path.join(ROOT, 'scripts', 'ci', 'check-public-workflow.js'));
const text = () => fs.readFileSync(YML, 'utf8');
const broken = (from, to) => {
  const t = text();
  assert.ok(t.includes(from), `el workflow trae «${from}» (la prueba lo altera)`);
  return WF.check(t.replace(from, to), { publisher: true }).map((b) => b.rule);
};

test('T13 NpmPublishWorkflow_TriggerAndPaths', () => {
  assert.deepStrictEqual(WF.check(text(), { publisher: true }), [], 'el workflow que publica cumple su forma');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'check-public-workflow.js'), '--publisher', YML], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const t = text();
  assert.match(t, /^ {2}push:\n {4}branches: \[main\]\n {4}paths:\n {6}- 'scripts\/setup\/npm\/\*\*'$/m);
  assert.match(t, /^ {2}workflow_dispatch:$/m);
  assert.match(t, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m, 'a mano, sólo en main');
  assert.ok(!/pull_request/.test(t), 'nunca en un pedido');
  assert.ok(broken('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n').includes('publisher-trigger'), 'en un pedido: rojo');
  assert.ok(broken('  push:\n', '  pull_request_target:\n  push:\n').includes('pull-request-target'));
  assert.ok(broken("      - 'scripts/setup/npm/**'\n", "      - '**'\n").includes('publisher-trigger'), 'cualquier cambio: rojo');
  assert.ok(broken("    if: github.ref == 'refs/heads/main'\n", '').includes('publisher-trigger'), 'sin el if de main: rojo');
  // los únicos workflows del repo público son tres
  assert.deepStrictEqual([...WF.WORKFLOWS].sort(), ['ci.yml', 'npm-publish.yml', 'site-image.yml', 'version-tag.yml']);
});

test('T14 NpmPublishWorkflow_PermissionsAndPins', () => {
  const t = text();
  assert.match(t, /^permissions:\n {2}contents: read$/m);
  assert.match(t, /^ {4}permissions:\n {6}contents: read\n {6}id-token: write$/m);
  assert.ok(broken('permissions:\n  contents: read\n', 'permissions: write-all\n').includes('publisher-permissions'), 'write-all: rojo');
  assert.ok(broken('      id-token: write\n', '      id-token: write\n      packages: write\n').includes('publisher-permissions'), 'un permiso de más: rojo');
  assert.ok(broken('      id-token: write\n', '').includes('publisher-permissions'), 'sin id-token: rojo');
  const checkout = /actions\/checkout@([0-9a-f]{40})/.exec(t)[1];
  assert.ok(broken(`actions/checkout@${checkout}`, 'actions/checkout@v7').includes('uses-by-sha'), 'una acción por tag: rojo');
  assert.ok(broken(`actions/checkout@${checkout}`, `actions/checkout@${'e'.repeat(40)}`).includes('shape'), 'otro sha: rojo');
  assert.ok(broken('        run: |\n          set -euo pipefail\n          npm install', '        env:\n          T: ${{ secrets.NPM }}\n        run: |\n          set -euo pipefail\n          npm install').includes('secrets'), 'un secreto: rojo');
  assert.ok(!/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/.test(t), 'ningún token de npm');
  // la habilitación es una VARIABLE de repositorio (no un secreto), leída en un job aparte sin la identidad de la corrida;
  // el que publica depende de él
  assert.match(t, /^ {10}ENABLED: \$\{\{ vars\.NPM_PUBLISH_ENABLED \}\}$/m);
  assert.match(t, /^ {4}needs: enabled\n {4}if: needs\.enabled\.outputs\.enabled == 'yes'$/m);
  assert.ok(broken("    needs: enabled\n    if: needs.enabled.outputs.enabled == 'yes'\n", '').includes('publisher-enabled'), 'publicar sin mirar la habilitación: rojo');
  assert.ok(broken('${{ vars.NPM_PUBLISH_ENABLED }}', '${{ secrets.NPM_PUBLISH_ENABLED }}').includes('secrets'), 'la habilitación como secreto: rojo');
});

test('T15 NpmPublishWorkflow_StagePublish_PinnedNpm_Integrity', () => {
  const t = text();
  const pin = /npm install -g npm@(\d+)\.(\d+)\.(\d+)$/m.exec(t);
  assert.ok(pin, 'npm se instala en una versión exacta');
  assert.ok(Number(pin[1]) > 11 || (Number(pin[1]) === 11 && Number(pin[2]) >= 15), `npm ≥ 11.15.0 (lo pide npm stage publish): ${pin.slice(1).join('.')}`);
  assert.match(t, /cp LICENSE scripts\/setup\/npm\/LICENSE/);
  assert.match(t, /^ {8}working-directory: scripts\/setup\/npm$/m);
  assert.match(t, /npm stage publish/);
  assert.ok(!/npm publish\b/.test(t.replace(/npm stage publish/g, '')), 'nunca npm publish directo');
  const code = t.split('\n').filter((l) => !/^ *(#|$)/.test(l)).join('\n');   // los pasos, sin la cabecera
  assert.ok(code.indexOf('dist.integrity') > 0 && code.indexOf('dist.integrity') < code.indexOf('npm stage publish'), 'la integridad, antes de publicar');
  assert.ok(broken(`npm install -g npm@${pin.slice(1).join('.')}`, 'npm install -g npm@latest').includes('publisher-npm'), 'npm@latest: rojo');
  assert.ok(broken(`npm install -g npm@${pin.slice(1).join('.')}`, 'npm install -g npm@11.5.1').includes('publisher-npm'), 'npm por debajo de 11.15.0: rojo');
  assert.ok(broken('          npm stage publish\n', '          npm publish\n').includes('publisher-stage'), 'npm publish directo: rojo');
  assert.ok(broken('          npm stage publish\n', '          npm stage publish || true\n').includes('shape'), 'un error al publicar que se traga: rojo');
  assert.match(t, /node-version: 24/);
});

// ── T16: los pasos de shell del workflow, de verdad, con un npm de mentira ────────────────────────────────────────────

/** Los `run: |` de cada paso con nombre: { nombre: { dir, script } }. */
function steps(t) {
  const out = {};
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {6}- name: (.+)$/.exec(lines[i]);
    if (!m) continue;
    let dir = '.'; let script = null;
    for (let j = i + 1; j < lines.length && !/^ {6}- /.test(lines[j]); j++) {
      const wd = /^ {8}working-directory: (.+)$/.exec(lines[j]);
      if (wd) dir = wd[1];
      if (/^ {8}run: \|$/.test(lines[j])) {
        const body = [];
        for (let k = j + 1; k < lines.length && (lines[k] === '' || /^ {10}/.test(lines[k])); k++) body.push(lines[k].slice(10));
        script = body.join('\n');
      }
    }
    if (script !== null) out[m[1]] = { dir, script };
  }
  return out;
}

/**
 * Un npm de mentira: `--version` dice NPM_FAKE_VERSION; `view <paquete> versions --json` contesta NPM_FAKE_VERSIONS (un
 * JSON; «E404» = el paquete no existe, como el registro; «E500» = el registro falla); `view <paquete>@<v> dist.integrity`
 * contesta NPM_FAKE_SEEN; `pack --dry-run --json` da la integridad NPM_FAKE_MINE; `stage publish` sale NPM_FAKE_PUBLISH_RC
 * (con NPM_FAKE_PUBLISH_OUT en la salida). Cada llamada, al registro.
 */
function fakeNpm(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${path.join(dir, 'npm-calls.log')}"
case "$1" in
  --version) echo "\${NPM_FAKE_VERSION}" ;;
  install) exit 0 ;;
  view)
    if [ "$3" = versions ]; then
      case "\${NPM_FAKE_VERSIONS}" in
        E404) printf '{"error":{"code":"E404","summary":"Not Found - GET https://registry.npmjs.org/@tyconsa%%2fharness"}}\\n'; echo "npm error code E404" >&2; exit 1 ;;
        E500) echo "npm error code E500" >&2; echo "npm error 500 Internal Server Error" >&2; exit 1 ;;
      esac
      printf '%s\\n' "\${NPM_FAKE_VERSIONS}"; exit 0
    fi
    printf '%s\\n' "\${NPM_FAKE_SEEN}" ;;
  pack) printf '[{"integrity":"%s","files":[]}]\\n' "\${NPM_FAKE_MINE}" ;;
  stage) printf '%s\\n' "\${NPM_FAKE_PUBLISH_OUT:-+ @tyconsa/harness}"; exit "\${NPM_FAKE_PUBLISH_RC:-0}" ;;
  *) echo "npm de mentira: no sé hacer $*" >&2; exit 9 ;;
esac
`, { mode: 0o755 });
  return bin;
}

/**
 * Corre los pasos de shell del workflow, en orden, como el runner: el primero es el job `enabled` (lee la variable de
 * repositorio, que acá llega como ENABLED); si no deja `enabled=yes`, el job que publica sale salteado. El `if:` del paso de
 * publicar lo decide la salida del previo.
 */
function runWorkflow(env) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-publish-'));
  const repo = path.join(box, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts', 'setup', 'npm'), { recursive: true });
  for (const f of ['package.json', 'index.js', 'home-paths.json', 'README.md']) fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'npm', f), path.join(repo, 'scripts', 'setup', 'npm', f));
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(repo, 'LICENSE'));
  const bin = fakeNpm(box);
  const output = path.join(box, 'github-output');
  fs.writeFileSync(output, '');
  const all = steps(text());
  const order = Object.keys(all);
  let log = ''; let code = 0; let published = false; let skipped = false;
  for (const name of order) {
    const s = all[name];
    if (/^Publicar/.test(name)) {
      const outs = fs.readFileSync(output, 'utf8');
      if (!/^publish=yes$/m.test(outs)) continue;
      published = true;
    }
    const r = spawnSync('bash', ['-c', s.script], { cwd: path.join(repo, s.dir), encoding: 'utf8', env: Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, RUNNER_TEMP: box }, env) });
    log += `── ${name}\n${r.stdout}${r.stderr}`;
    if (r.status !== 0) { code = r.status; break; }
    if (name === order[0] && !/^enabled=yes$/m.test(fs.readFileSync(output, 'utf8'))) { skipped = true; break; }   // el job publish, salteado
  }
  const calls = fs.existsSync(path.join(box, 'npm-calls.log')) ? fs.readFileSync(path.join(box, 'npm-calls.log'), 'utf8') : '';
  const license = fs.existsSync(path.join(repo, 'scripts', 'setup', 'npm', 'LICENSE'));
  fs.rmSync(box, { recursive: true, force: true });
  return { code, log, calls, published, license, skipped };
}

test('T16 NpmPublishWorkflow_ToyRun_SameOrOtherContent', () => {
  const pin = /npm install -g npm@(\d+\.\d+\.\d+)$/m.exec(text())[1];
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'npm', 'package.json'), 'utf8')).version;
  const base = { ENABLED: 'true', NPM_FAKE_VERSION: pin, NPM_FAKE_MINE: 'sha512-mio', NPM_FAKE_VERSIONS: JSON.stringify(['0.9.0', version]) };
  const stage = (r) => /^stage/m.test(r.calls);
  // (0) sin la variable de repositorio: el job que publica sale salteado, VERDE con un aviso de qué falta; npm no se llama
  for (const off of [{ ENABLED: '' }, { ENABLED: 'false' }]) {
    const r = runWorkflow(Object.assign({}, base, off));
    assert.strictEqual(r.code, 0, r.log); assert.ok(r.skipped, 'salteado');
    assert.match(r.log, /::warning::falta configurar npm/); assert.match(r.log, /NPM_PUBLISH_ENABLED=true/); assert.match(r.log, /publicador de confianza/);
    assert.strictEqual(r.calls, '', 'sin la variable, npm no se llama');
  }
  // (a) la versión ya está, con la misma integridad: 0 «ya publicada», no publica
  let r = runWorkflow(Object.assign({}, base, { NPM_FAKE_SEEN: 'sha512-mio' }));
  assert.strictEqual(r.code, 0, r.log); assert.match(r.log, /ya publicada/); assert.ok(!stage(r), 'no publicó');
  assert.ok(r.license, 'LICENSE copiado a la carpeta del paquete');
  // (b) la versión ya está con OTRO contenido: rojo, no publica
  r = runWorkflow(Object.assign({}, base, { NPM_FAKE_SEEN: 'sha512-otro' }));
  assert.notStrictEqual(r.code, 0, r.log); assert.match(r.log, /otro contenido: subí version/); assert.ok(!stage(r));
  // (c) npm viejo: rojo antes de preguntarle nada al registro
  r = runWorkflow(Object.assign({}, base, { NPM_FAKE_VERSION: '11.5.1' }));
  assert.notStrictEqual(r.code, 0, r.log); assert.match(r.log, /npm viejo/); assert.ok(!/^view/m.test(r.calls) && !stage(r));
  // (d) el paquete todavía no existe en npm (E404): la primera publicación, en etapas (rama A de las tareas del dueño)
  r = runWorkflow(Object.assign({}, base, { NPM_FAKE_VERSIONS: 'E404' }));
  assert.strictEqual(r.code, 0, r.log); assert.ok(r.published && /^stage publish$/m.test(r.calls), `publicó en etapas: ${r.calls}`);
  assert.match(r.log, /todavía no existe en npm/);
  // (e) versión nueva de un paquete que existe (una sola versión publicada: npm devuelve un texto, no una lista): publica
  r = runWorkflow(Object.assign({}, base, { NPM_FAKE_VERSIONS: JSON.stringify('0.9.0') }));
  assert.strictEqual(r.code, 0, r.log); assert.ok(r.published && /^stage publish$/m.test(r.calls), `publicó en etapas: ${r.calls}`);
  assert.ok(!/dist\.integrity/.test(r.calls), 'una versión nueva no pide la integridad');
  // (f) con la variable puesta, la identidad que npm no acepta es ROJO (nada de avisos en verde)
  for (const out of ['npm error code E403 403 Forbidden', 'npm error code E401', 'npm error code ENEEDAUTH', 'npm error OIDC token exchange failed']) {
    r = runWorkflow(Object.assign({}, base, { NPM_FAKE_VERSIONS: JSON.stringify(['0.9.0']), NPM_FAKE_PUBLISH_RC: '1', NPM_FAKE_PUBLISH_OUT: out }));
    assert.notStrictEqual(r.code, 0, `${out}: ${r.log}`); assert.ok(!/::warning::/.test(r.log), `${out}: sin aviso en verde`);
  }
  // (g) el registro que falla al preguntar: rojo, no publica
  r = runWorkflow(Object.assign({}, base, { NPM_FAKE_VERSIONS: 'E500' }));
  assert.notStrictEqual(r.code, 0, r.log); assert.match(r.log, /no pude preguntarle al registro/); assert.ok(!stage(r));
  // (h) una lista de versiones que no se lee: rojo, nunca «es nueva»
  r = runWorkflow(Object.assign({}, base, { NPM_FAKE_VERSIONS: '<html>proxy</html>' }));
  assert.notStrictEqual(r.code, 0, r.log); assert.ok(!stage(r), 'no publica con una respuesta que no entiende');
});
