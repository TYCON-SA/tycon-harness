'use strict';
// cover-secrets-real.test.js — el gancho en una sesión real de un modelo chico (historia 8.188). Son las únicas pruebas de lo
// que ve el modelo (AC 1) y de que otro gancho sigue actuando (AC 15). Sin `claude` se saltan diciéndolo: esos criterios
// quedan sin comprobar, no en verde.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'cover-secrets.js');

const hasClaude = () => spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;

function realSession(prompt, { otherHook = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-secrets-real-'));
  const value = 'valor-inventado-de-la-sesion-5678';
  const mark = path.join(dir, 'otro-gancho.txt');
  const hooks = [{ type: 'command', command: `"${process.execPath}" "${HOOK}"` }];
  if (otherHook) hooks.push({ type: 'command', command: `"${process.execPath}" -e "require('fs').appendFileSync(process.argv[1],'x')" "${mark}"` });
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(path.join(dir, 'archivo.txt'), `una linea\nTOKEN=${value}\n`);
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash|Read|Grep', hooks }] } }));
  const res = spawnSync('claude', ['-p', prompt, '--settings', settings, '--model', 'haiku', '--allowedTools', 'Bash', 'Read', 'Grep', '--output-format', 'json'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, PRUEBA_TOKEN: value, TYCON_EVAL_SANDBOX: '1' },
  });
  assert.strictEqual(res.status, 0, `claude -p salió ${res.status}`);
  const answer = JSON.parse(res.stdout);
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const folder = fs.readdirSync(projects).find((d) => fs.existsSync(path.join(projects, d, `${answer.session_id}.jsonl`)));
  assert.ok(folder, 'la conversación guardada no apareció');
  const saved = fs.readFileSync(path.join(projects, folder, `${answer.session_id}.jsonl`), 'utf8');
  return { value, result: answer.result || '', saved, otherHookRan: fs.existsSync(mark) };
}

test('T2 CoverSecrets_RealClaudeSession_ModelAndSavedConversationCovered @story-8.188 @ac-1 @ac-2', (t) => {
  if (!hasClaude()) { t.skip('sin `claude`: los AC 1 y 2 quedan sin comprobar en lo que ve el modelo'); return; }
  // el valor vive sólo en la variable y en el archivo: armado por partes en el comando, el modelo lo deduce y lo escribe él mismo
  const real = realSession('Hacé estos tres pasos, sin nada más: con Bash, exactamente printenv PRUEBA_TOKEN; con Read, archivo.txt; con Grep, TOKEN en archivo.txt con output_mode content. Después repetí tal cual lo que devolvió cada uno.');
  assert.ok(!real.result.includes(real.value), 'la respuesta del modelo no trae el valor');
  assert.strictEqual(real.saved.split(real.value).length - 1, 0, 'la conversación guardada no trae el valor');
  assert.ok(real.saved.split('tapado').length - 1 >= 3, 'las tres herramientas salieron tapadas');
  for (const tool of ['"name":"Bash"', '"name":"Read"', '"name":"Grep"']) assert.ok(real.saved.includes(tool), `se usó ${tool}`);
});

test('T20 CoverSecrets_RealClaudeSession_OtherHookStillActs @story-8.188 @ac-15', (t) => {
  if (!hasClaude()) { t.skip('sin `claude`: el AC 15 queda sin comprobar'); return; }
  const real = realSession('Ejecutá con Bash exactamente: printenv PRUEBA_TOKEN. Contestá sólo «listo».', { otherHook: true });
  assert.strictEqual(real.saved.split(real.value).length - 1, 0, 'sale tapado');
  assert.match(real.saved, /tapado/);
  assert.ok(real.otherHookRan, 'el otro gancho anotó');
});
