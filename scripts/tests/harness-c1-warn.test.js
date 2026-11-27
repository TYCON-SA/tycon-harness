'use strict';
// harness-c1-warn.test.js — HARNESS-C1 también frena dejar fijo un control BAJADO A AVISO (`=warn`) en el archivo de
// arranque del shell, no sólo uno apagado (`=0`, `off`).
//
// `TYCON_INTERNAL_HISTORY=warn` deja el control de historia interna del commit diciendo lo que encuentra sin frenar. Por
// sesión es la escotilla del dev, a la vista; escrito en el archivo de arranque del shell queda bajado en todas las
// sesiones futuras, que es lo que HARNESS-C1 no deja hacer al agente. El freno sólo miraba `0`/`off`.
// Los comandos se arman por partes: escritos enteros en este archivo, el propio freno frenaría su edición por consola.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'safety-guard-pre.sh');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

const VAR = ['TYCON', 'INTERNAL', 'HISTORY'].join('_');
const RC = ['~/.', 'zshrc'].join('');

/** Corre el freno sobre un comando de consola, con una casa de juguete. */
function frena(cmd) {
  const h = tmp('hc1-warn-');
  try {
    const input = JSON.stringify({ session_id: 's-hc1', tool_name: 'Bash', tool_input: { command: cmd }, cwd: h, permission_mode: 'bypassPermissions' });
    const r = spawnSync('bash', [GUARD], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h, USERPROFILE: h } });
    return { status: r.status, stderr: r.stderr || '' };
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
}

// 🔴 Falla con: HARNESS-C1 que deja escribir `warn` (en cualquier mayúscula o entre comillas) al archivo de arranque.
test('T1 HarnessC1_PersistirUnControlBajadoAAviso_EnElArranqueDelShell_Frena', () => {
  for (const valor of ['warn', 'WARN', 'Warn', '"warn"']) {
    const cmd = `echo 'export ${VAR}=${valor}' >> ${RC}`;
    const r = frena(cmd);
    assert.strictEqual(r.status, 2, `${cmd} no frenó\n${r.stderr}`);
    assert.match(r.stderr, /HARNESS-C1/, cmd);
  }
  const tee = `echo 'export ${VAR}=warn' | tee -a ~/.bashrc`;
  assert.strictEqual(frena(tee).status, 2, tee);
});

// 🔴 Falla con: las formas de Windows (setx, la variable de usuario, el perfil de PowerShell) que dejan pasar `warn`.
test('T2 HarnessC1_LasFormasDeWindows_TambienFrenanWarn', () => {
  const cmds = [
    `setx ${VAR} warn`,
    `[Environment]::SetEnvironmentVariable('${VAR}', 'warn', 'User')`,
    `Add-Content $PROFILE '$env:${VAR}="warn"'`,
  ];
  for (const cmd of cmds) {
    const r = frena(cmd);
    assert.strictEqual(r.status, 2, `${cmd} no frenó\n${r.stderr}`);
    assert.match(r.stderr, /HARNESS-C1/, cmd);
  }
});

// 🔴 Falla con: un freno que toma por apagado lo que lo SUBE (`block`) o cualquier mención de la palabra.
test('T3 HarnessC1_SubirElControlOMencionarWarn_NoFrena', () => {
  for (const cmd of [
    `echo 'export ${VAR}=block' >> ${RC}`,
    `echo 'export ${VAR}=warn' > /tmp/nota.txt`,
    `echo '# warn: nada' >> ${RC}`,
    `setx ${VAR} block`,
  ]) {
    const r = frena(cmd);
    assert.ok(!/HARNESS-C1/.test(r.stderr), `${cmd} frenó por HARNESS-C1\n${r.stderr}`);
  }
});
