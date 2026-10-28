'use strict';

/**
 * controls-off.test.js — sacar un control del arnés desde la configuración de la herramienta frena antes (HARNESS-C2).
 *
 * Los controles del arnés viven como hooks en la configuración de Claude Code (`settings.json` y `settings.local.json`
 * de `~/.claude/` o de `<repo>/.claude/`). Esa misma configuración los apaga: `disableAllHooks`, un interruptor `TYCON_*`
 * en `env`, o el hook sacado. Un comando o una edición que hace eso frena antes, y dice por qué. Cada caso que frena
 * tiene al lado su gemelo inofensivo, parecido, que pasa: leer la configuración, cambiar otra clave, agregar un hook,
 * una variable que no apaga nada, un archivo sin hooks del arnés.
 *
 * Cada caso con su casa (HOME) de juguete: nada toca la configuración de la máquina. Los comandos van como datos.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/controls-off.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const ROOT = path.resolve(SCRIPTS, '..', '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'safety-guard-pre.sh');
const DISPATCH = path.join(SCRIPTS, 'dispatch.js');
const { fakeHomeEnv } = require('./lib/fake-home.js');
const CO = require('../lib/controls-off.js');

const HOOK_ARNES = 'node "/h/.tycon/harness/scripts/hooks/retro-pending.js"';
const HOOK_PIPELINE = 'node "/h/.claude/agent-skills/skills/tycon-pipeline/scripts/hook-pre-edit.js"';
const HOOK_AJENO = 'python3 ~/mis-scripts/aviso.py';

function config({ hooks = true, ajeno = false, extra = {} } = {}) {
  const c = { permissions: { allow: ['Bash(ls:*)'] }, env: { TYCON_REPOS_ROOT: '/h/src' }, ...extra };
  c.hooks = {};
  if (hooks) {
    c.hooks.PreToolUse = [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: HOOK_PIPELINE }] }];
    c.hooks.Stop = [{ hooks: [{ type: 'command', command: HOOK_ARNES }] }];
  }
  if (ajeno) c.hooks.Notification = [{ hooks: [{ type: 'command', command: HOOK_AJENO }] }];
  return c;
}
const texto = (c) => JSON.stringify(c, null, 2) + '\n';

function casa({ conf = config(), local = null } = {}) {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-off-')));
  fs.mkdirSync(path.join(h, '.claude', 'projects'), { recursive: true });
  if (conf) fs.writeFileSync(path.join(h, '.claude', 'settings.json'), texto(conf));
  const repo = path.join(h, 'repo');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  if (local) fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), texto(local));
  return { h, repo };
}

function comando(cmd, { h, repo }, tool = 'Bash') {
  const input = JSON.stringify({ tool_name: tool, tool_input: { command: cmd }, cwd: repo, session_id: 's-ctl', tool_use_id: 'toolu_x' });
  const r = spawnSync('bash', [GUARD], { input, encoding: 'utf8', env: { ...process.env, ...fakeHomeEnv(h), TYCON_SAFETY_OFF: '' } });
  return { code: r.status, err: r.stderr || '' };
}

function edicion(toolName, toolInput, { h, repo }) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd: repo, session_id: 's-ctl' });
  const r = spawnSync(process.execPath, [DISPATCH, 'pre-edit'], { input, encoding: 'utf8', env: { ...process.env, ...fakeHomeEnv(h) } });
  return { code: r.status, err: r.stderr || '' };
}

const frena = (r, que) => { assert.strictEqual(r.code, 2, `tenía que frenar (${que}); salió ${r.code}\n${r.err}`); assert.match(r.err, /HARNESS-C2/); };
const pasa = (r, que) => assert.notStrictEqual(r.code, 2, `no tenía que frenar (${que})\n${r.err}`);

// ── la comparación: lo que la configuración nueva le saca a la de antes ─────────────────────────────────────────────

test('T1 ControlsOff_DisableAllHooks_Frena_ConFalseNoFrena', () => {
  assert.ok(CO.apagados(config(), config({ extra: { disableAllHooks: true } })).length);
  assert.deepStrictEqual(CO.apagados(config(), config({ extra: { disableAllHooks: false } })), []);
});

test('T2 ControlsOff_HookDelArnesSacado_Frena_HookAjenoSacadoNoFrena', () => {
  const sinStop = config(); delete sinStop.hooks.Stop;
  assert.ok(CO.apagados(config(), sinStop).some((m) => /retro-pending/.test(m)));
  // el hook de la persona es suyo: sacarlo no saca un control del arnés
  assert.deepStrictEqual(CO.apagados(config({ ajeno: true }), config()), []);
  // agregar uno no saca nada
  assert.deepStrictEqual(CO.apagados(config(), config({ ajeno: true })), []);
});

test('T3 ControlsOff_MatcherQueYaNoCalza_Frena_ReordenarNoFrena', () => {
  const otro = config(); otro.hooks.PreToolUse[0].matcher = 'NadaQueCalce';
  assert.ok(CO.apagados(config(), otro).length);
  const reordenada = config(); reordenada.hooks = { Stop: reordenada.hooks.Stop, PreToolUse: reordenada.hooks.PreToolUse };
  assert.deepStrictEqual(CO.apagados(config(), reordenada), []);
});

test('T4 ControlsOff_InterruptorQueApaga_Frena_VariableQueNoApagaNoFrena', () => {
  for (const [k, v] of [['TYCON_SAFETY_OFF', '1'], ['TYCON_TEST_GATE', 'skip'], ['DOD_BYPASS', '1'], ['TYCON_PROD_LINT', '0'], ['TYCON_SAFETY_GUARD', 'off'], ['TYCON_NO_AUTOINSTALL', '1']]) {
    assert.ok(CO.apagados(config(), config({ extra: { env: { [k]: v } } })).length, `${k}=${v}`);
  }
  for (const [k, v] of [['TYCON_REPOS_ROOT', '/otra'], ['TYCON_SAFETY_OFF', '0'], ['TYCON_TEST_GATE', '0'], ['TYCON_PROD_LINT', '1'], ['MI_VARIABLE', '0']]) {
    assert.deepStrictEqual(CO.apagados(config(), config({ extra: { env: { [k]: v } } })), [], `${k}=${v}`);
  }
  // un apagado que ya estaba no lo pone esta edición
  const ya = config({ extra: { env: { TYCON_SAFETY_GUARD: '0' } } });
  assert.deepStrictEqual(CO.apagados(ya, ya), []);
});

test('T5 ControlsOff_ConfigQueQuedaIlegible_FrenaSiTeniaControles', () => {
  assert.ok(CO.juzgarTexto(texto(config()), '{ "hooks": ').length);
  assert.deepStrictEqual(CO.juzgarTexto(texto(config({ hooks: false })), '{ "hooks": '), []);
});

test('T6 ControlsOff_EsConfigDeLaHerramienta_SoloLosArchivosDeClaude', () => {
  assert.ok(CO.esConfig('/h/.claude/settings.json'));
  assert.ok(CO.esConfig('/h/repo/.claude/settings.local.json'));
  assert.ok(!CO.esConfig('/h/repo/settings.json'));
  assert.ok(!CO.esConfig('/h/repo/.vscode/settings.json'));
});

// ── por la terminal (el freno de seguridad) ─────────────────────────────────────────────────────────────────────────

test('T7 Terminal_PrenderDisableAllHooks_Frena_LeerloNoFrena', () => {
  const c = casa();
  frena(comando("jq '.disableAllHooks=true' ~/.claude/settings.json > /tmp/s && mv /tmp/s ~/.claude/settings.json", c), 'jq true');
  frena(comando(`python3 -c "import json;p='${c.h}/.claude/settings.json';d=json.load(open(p));d['disableAllHooks']=True;json.dump(d,open(p,'w'))"`, c), 'python');
  pasa(comando("jq '.disableAllHooks' ~/.claude/settings.json", c), 'leer');
  pasa(comando("jq '.disableAllHooks=false' ~/.claude/settings.json > /tmp/s && mv /tmp/s ~/.claude/settings.json", c), 'false');
  pasa(comando('grep -n disableAllHooks ~/.claude/settings.json', c), 'grep');
});

test('T8 Terminal_InterruptorEnEnv_Frena_OtraVariableNoFrena', () => {
  const c = casa();
  frena(comando('jq \'.env.TYCON_SAFETY_OFF="1"\' ~/.claude/settings.json | sponge ~/.claude/settings.json', c), 'escape en env');
  pasa(comando('jq \'.env.TYCON_REPOS_ROOT="/otra"\' ~/.claude/settings.json | sponge ~/.claude/settings.json', c), 'otra variable');
  pasa(comando("jq '.env' ~/.claude/settings.json", c), 'leer env');
});

test('T9 Terminal_SacarLosHooks_FrenaConControles_SinControlesNoFrena', () => {
  const c = casa({ local: config({ hooks: false, ajeno: true }) });
  frena(comando("jq 'del(.hooks.Stop)' ~/.claude/settings.json > /tmp/s && mv /tmp/s ~/.claude/settings.json", c), 'del hooks');
  frena(comando("sed -i '' '/retro-pending/d' ~/.claude/settings.json", c), 'sed borra la línea del hook');
  // la configuración del repo no tiene hooks del arnés: sacarle los suyos es asunto de la persona
  pasa(comando("jq 'del(.hooks)' .claude/settings.local.json > /tmp/s && mv /tmp/s .claude/settings.local.json", c), 'sin controles');
  pasa(comando('jq \'.hooks.Stop += [{"hooks":[{"type":"command","command":"echo"}]}]\' ~/.claude/settings.json > /tmp/s && mv /tmp/s ~/.claude/settings.json', c), 'agregar');
  pasa(comando("jq '.hooks | keys' ~/.claude/settings.json", c), 'leer hooks');
});

test('T10 Terminal_BorrarOMoverLaConfig_FrenaConControles_CopiarNoFrena', () => {
  const c = casa({ local: config({ hooks: false }) });
  frena(comando('rm ~/.claude/settings.json', c), 'rm');
  frena(comando('mv ~/.claude/settings.json ~/.claude/settings.viejo', c), 'mv');
  pasa(comando('cp ~/.claude/settings.json /tmp/respaldo.json', c), 'copia de respaldo');
  pasa(comando('rm .claude/settings.local.json', c), 'rm sin controles');
});

test('T11 Terminal_ReemplazarEntera_FrenaSiPierdeLosControles_ConLosControlesNoFrena', () => {
  const c = casa();
  frena(comando("echo '{}' > ~/.claude/settings.json", c), 'echo vacío');
  const conTodo = texto({ ...config(), model: 'opus' });
  pasa(comando(`cat > ~/.claude/settings.json <<'FIN'\n${conTodo}FIN`, c), 'heredoc con los controles');
  const respaldo = path.join(c.h, 'respaldo.json');
  fs.writeFileSync(respaldo, texto(config()));
  pasa(comando(`cp ${respaldo} ~/.claude/settings.json`, c), 'restaurar un respaldo con los controles');
  fs.writeFileSync(respaldo, texto(config({ hooks: false })));
  frena(comando(`cp ${respaldo} ~/.claude/settings.json`, c), 'restaurar uno sin los controles');
});

test('T12 Terminal_ElComandoNoNombraLaConfig_NoMira', () => {
  const c = casa();
  pasa(comando('echo disableAllHooks=true > /tmp/nota.txt', c), 'otro archivo');
  pasa(comando('rm -f /tmp/settings.json', c), 'un settings.json fuera de .claude');
});

// ── por las herramientas de edición (el despachador de antes de editar) ─────────────────────────────────────────────

test('T13 Edicion_PrenderDisableAllHooks_Frena_OtraClaveNoFrena', () => {
  const c = casa();
  const fp = path.join(c.h, '.claude', 'settings.json');
  const actual = fs.readFileSync(fp, 'utf8');
  frena(edicion('Edit', { file_path: fp, old_string: '"permissions": {', new_string: '"disableAllHooks": true,\n  "permissions": {' }, c), 'Edit');
  pasa(edicion('Edit', { file_path: fp, old_string: '"permissions": {', new_string: '"model": "opus",\n  "permissions": {' }, c), 'Edit otra clave');
  frena(edicion('Write', { file_path: fp, content: texto(config({ hooks: false })) }, c), 'Write sin hooks');
  pasa(edicion('Write', { file_path: fp, content: actual.replace('Bash(ls:*)', 'Bash(git status:*)') }, c), 'Write con los hooks');
});

test('T14 Edicion_InterruptorYMultiEdit_Frena_VariableInofensivaNoFrena', () => {
  const c = casa();
  const fp = path.join(c.h, '.claude', 'settings.json');
  frena(edicion('Edit', { file_path: fp, old_string: '"TYCON_REPOS_ROOT": "/h/src"', new_string: '"TYCON_REPOS_ROOT": "/h/src",\n    "TYCON_TEST_GATE": "skip"' }, c), 'escape');
  pasa(edicion('Edit', { file_path: fp, old_string: '"TYCON_REPOS_ROOT": "/h/src"', new_string: '"TYCON_REPOS_ROOT": "/h/otra"' }, c), 'otra ruta');
  frena(edicion('MultiEdit', { file_path: fp, edits: [{ old_string: '"Bash(ls:*)"', new_string: '"Bash(ls:*)", "Bash(pwd)"' }, { old_string: HOOK_ARNES.replace(/"/g, '\\"'), new_string: 'true' }] }, c), 'MultiEdit que cambia el hook');
});

test('T15 Edicion_OtroArchivoOConfigSinControles_NoMira', () => {
  const c = casa({ local: config({ hooks: false, ajeno: true }) });
  const local = path.join(c.repo, '.claude', 'settings.local.json');
  pasa(edicion('Write', { file_path: local, content: texto({ permissions: {} }) }, c), 'local sin controles');
  pasa(edicion('Write', { file_path: path.join(c.repo, 'notas.json'), content: '{"disableAllHooks": true}' }, c), 'otro archivo');
});

// ── las formas que la primera versión leía mal (cada una con su gemela) ─────────────────────────────────────────────

const enTmp = (c) => `> ${c.h}/s.json && mv ${c.h}/s.json ~/.claude/settings.json`;

test('T16 Terminal_SacarEsUnComando_ElTextoDeUnMensajeNoBorra', () => {
  const c = casa();
  // stable-data: el commit no se corre; el comando va como texto al freno, que sólo lo lee
  pasa(comando('git commit -m "fix: del ~/.claude/settings.json viejo y move ~/.claude/settings.local.json"', c), 'mensaje de commit');
  pasa(comando('echo "move ~/.claude/settings.json later" >> /tmp/notas.txt', c), 'texto de un echo');
  pasa(comando('git checkout -- ~/.claude/settings.json', c), 'git checkout');
  pasa(comando('git restore .claude/settings.local.json', c), 'git restore');
  frena(comando('unlink ~/.claude/settings.json', c), 'unlink');
  frena(comando('cd ~/.claude && rm -f settings.json', c), 'rm después de un cd');
  frena(comando('rm "$HOME/.claude//settings.json"', c), 'ruta con $HOME y doble barra');
  frena(comando('Remove-Item -Force $env:USERPROFILE/.claude/settings.json', c, 'PowerShell'), 'Remove-Item');
  pasa(comando('Get-Content $env:USERPROFILE/.claude/settings.json', c, 'PowerShell'), 'Get-Content');
});

test('T17 Terminal_AgregarUnHookPorAsignacion_NoFrena_VaciarlosFrena', () => {
  const c = casa();
  const p = `${c.h}/.claude/settings.json`;
  pasa(comando(`python3 -c "import json;p='${p}';d=json.load(open(p));d['hooks']['Notification']=[{'hooks':[{'type':'command','command':'say hola'}]}];json.dump(d,open(p,'w'),indent=2)"`, c), 'python agrega un hook');
  pasa(comando(`jq '.hooks.Notification = [{"hooks":[{"type":"command","command":"say"}]}]' ~/.claude/settings.json ${enTmp(c)}`, c), 'jq agrega un hook');
  frena(comando(`python3 -c "import json;p='${p}';d=json.load(open(p));d['hooks']['Stop']=[];json.dump(d,open(p,'w'))"`, c), 'python vacía Stop');
  frena(comando(`jq '.hooks.Stop = []' ~/.claude/settings.json ${enTmp(c)}`, c), 'jq vacía Stop');
});

test('T18 Terminal_CatQueEscribeLaConfig_SeJuzgaPorLoQueDeja', () => {
  const c = casa();
  frena(comando(`cat > ~/.claude/settings.json <<'EOF'\n{"model":"sonnet"}\nEOF`, c), 'cat heredoc sin los hooks');
  const sin = path.join(c.h, 'sin.json'); fs.writeFileSync(sin, texto(config({ hooks: false })));
  const con = path.join(c.h, 'con.json'); fs.writeFileSync(con, texto(config()));
  frena(comando(`cat ${sin} > ~/.claude/settings.json`, c), 'cat de un archivo sin los hooks');
  pasa(comando(`cat ${con} > ~/.claude/settings.json`, c), 'cat de un archivo con los hooks');
  pasa(comando('cat ~/.claude/settings.json', c), 'leerla');
});

test('T19 ControlsOff_CadaEscapeDelArnesEnEnv_Apaga', () => {
  const { ESCAPES, VALOR_QUE_APAGA } = require(path.join(ROOT, 'scripts', 'nightly', 'runs-review', 'rules.js'));
  // TYCON_EVAL_SANDBOX calla los avisos de los hooks de arranque: en la configuración, los calla en cada sesión
  for (const k of [...ESCAPES, 'TYCON_EVAL_SANDBOX']) {
    // los que apagan con su propio valor (`off`) no se apagan con 1, y se prenden con `on`
    const [off, on] = VALOR_QUE_APAGA[k] ? [VALOR_QUE_APAGA[k], 'on'] : ['1', '0'];
    assert.ok(CO.apaga(k, off), `${k}=${off}`);
    assert.ok(!CO.apaga(k, on), `${k}=${on}`);
  }
  const c = casa();
  frena(comando('jq \'.env.STOP_AUTONOMY="1"\' ~/.claude/settings.json | sponge ~/.claude/settings.json', c), 'STOP_AUTONOMY');
  pasa(comando('jq \'.env.TYCON_PR_BY_HAND="0"\' ~/.claude/settings.json | sponge ~/.claude/settings.json', c), 'escape en 0');
});

test('T20 Terminal_FiltrosQueSacanHooks_Frenan_LosQueNoSacanPasan', () => {
  const c = casa();
  for (const f of ['.hooks.Stop |= []', '. + {hooks:{}}', '{model,permissions}', 'with_entries(select(.key!="hooks"))']) {
    frena(comando(`jq '${f}' ~/.claude/settings.json ${enTmp(c)}`, c), `jq ${f}`);
  }
  for (const f of ['. + {model:"opus"}', '.permissions.allow += ["Bash(pwd)"]', 'with_entries(select(.key!="model"))']) {
    pasa(comando(`jq '${f}' ~/.claude/settings.json ${enTmp(c)}`, c), `jq ${f}`);
  }
  const p = `${c.h}/.claude/settings.json`;
  frena(comando(`python3 -c "import json;p='${p}';d=json.load(open(p));d['hooks'].clear();json.dump(d,open(p,'w'))"`, c), 'python clear');
  pasa(comando(`python3 -c "import json;p='${p}';d=json.load(open(p));d['permissions']['allow'].clear();json.dump(d,open(p,'w'))"`, c), 'python clear de otra clave');
  frena(comando(`node -e "const fs=require('fs');const p='${p}';const d=JSON.parse(fs.readFileSync(p));d.hooks.Stop.splice(0);fs.writeFileSync(p,JSON.stringify(d))"`, c), 'node splice');
  frena(comando("sed -i '' 's#retro-pending.js#true#' ~/.claude/settings.json", c), 'sed cambia el comando del hook');
  pasa(comando("sed -i '' 's#Bash(ls:\\*)#Bash(pwd)#' ~/.claude/settings.json", c), 'sed cambia otra cosa');
  frena(comando(`python3 -c "open('${p}','w').write('{}')"`, c), 'python la reemplaza sin leerla');
  pasa(comando(`python3 -c "import json;d=json.load(open('${p}'));open('${c.h}/copia.json','w').write(json.dumps(d))"`, c), 'python escribe otro archivo');
});

test('T21 ControlsOff_HookPorPresencia_DuplicadoYMatcherMasAncho', () => {
  const doble = config(); doble.hooks.Stop[0].hooks.push({ type: 'command', command: HOOK_ARNES });
  assert.deepStrictEqual(CO.apagados(doble, config()), [], 'sacar el duplicado');
  for (const m of ['Edit|Write|MultiEdit', '', '*']) {
    const ancho = config(); ancho.hooks.PreToolUse[0].matcher = m;
    assert.deepStrictEqual(CO.apagados(config(), ancho), [], `matcher ${m}`);
  }
  const angosto = config(); angosto.hooks.PreToolUse[0].matcher = 'Edit';
  assert.ok(CO.apagados(config(), angosto).length, 'matcher más angosto');
  const conTilde = config(); conTilde.hooks.Stop[0].hooks[0].command = 'node ~/.tycon/harness/scripts/hooks/retro-pending.js';
  assert.deepStrictEqual(CO.apagados(config(), conTilde, { home: '/h' }), [], 'la misma ruta escrita con ~');
});

test('T22 Terminal_CopiasPorEnlaceOSincronizacion_SeJuzganPorElOrigen', () => {
  const c = casa();
  const sin = path.join(c.h, 'sin.json'); fs.writeFileSync(sin, texto(config({ hooks: false })));
  frena(comando(`ln -sf ${sin} ~/.claude/settings.json`, c), 'ln a uno sin los hooks');
  frena(comando(`rsync -a ${sin} ~/.claude/settings.json`, c), 'rsync de uno sin los hooks');
  pasa(comando(`ln -s ~/.claude/settings.json ${c.h}/enlace.json`, c), 'enlace que apunta a la config');
  pasa(comando(`rsync -a ~/.claude/settings.json ${c.h}/respaldo.json`, c), 'respaldo con rsync');
});

test('T23 Edicion_ConfigQueEsUnEnlace_SeMiraPorElArchivoReal', () => {
  const c = casa({ conf: null });
  const real = path.join(c.h, 'dotfiles', 'claude-settings.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, texto(config()));
  fs.symlinkSync(real, path.join(c.h, '.claude', 'settings.json'));
  frena(edicion('Edit', { file_path: real, old_string: '"permissions": {', new_string: '"disableAllHooks": true,\n  "permissions": {' }, c), 'Edit al archivo real');
  const otro = path.join(c.h, 'dotfiles', 'otro.json'); fs.writeFileSync(otro, '{"a":1}\n');
  pasa(edicion('Write', { file_path: otro, content: '{"disableAllHooks": true}' }, c), 'otro archivo de la misma carpeta');
});

test('T24 Terminal_EscriturasArmadasYCopiasAUnaCarpeta_SeJuzganIgual', () => {
  const c = casa();
  frena(comando(`python3 -c "import os;open(os.path.expanduser('~/.claude/settings.json'),'w').write('{}')"`, c), 'python con expanduser');
  pasa(comando(`python3 -c "import os;open(os.path.expanduser('~/notas.txt'),'w').write('{}')"`, c), 'python escribe otro archivo de la casa');
  frena(comando(`node -e "require('fs').writeFileSync('${c.h}/.claude/settings.json','{}')"`, c), 'node la reemplaza sin leerla');
  pasa(comando(`node -e "require('fs').writeFileSync('${c.h}/.claude/settings.json', JSON.stringify(require('${c.h}/.claude/settings.json')))"`, c), 'node la reescribe igual');
  frena(comando(`node -e "const f=process.env.HOME+'/.claude/settings.json';const s=require(f);s.hooks.Stop.splice(0);require('fs').writeFileSync(f,JSON.stringify(s))"`, c), 'node con HOME+');
  const sin = path.join(c.h, 'tmp', 'settings.json');
  fs.mkdirSync(path.dirname(sin), { recursive: true });
  fs.writeFileSync(sin, texto(config({ hooks: false })));
  fs.mkdirSync(path.join(c.h, 'otra'));
  frena(comando(`dd if=${sin} of=~/.claude/settings.json`, c), 'dd');
  pasa(comando(`dd if=~/.claude/settings.json of=${c.h}/respaldo.json`, c), 'dd de respaldo');
  frena(comando(`cp -t ~/.claude/ ${sin}`, c), 'cp -t a la carpeta');
  frena(comando(`cp ${sin} ~/.claude/`, c), 'cp a la carpeta');
  pasa(comando(`cp ${sin} ${c.h}/otra/`, c), 'cp a otra carpeta');
});
