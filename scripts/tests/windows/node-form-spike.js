#!/usr/bin/env node
'use strict';
/**
 * node-form-spike.js — la medición E1: ¿un hook `.js` registrado con la ruta del
 * Node del arnés SIN comillas (`C:/…/node/current/node.exe "<guion>"`) corre por los cinco lanzadores con que se dispara
 * un hook en Windows?
 *
 * POR QUÉ EXISTE. Cada hook `.js` arranca con el Node propio del arnés en vez del `node` del PATH. La
 * ruta del intérprete va escrita en el comando del hook, y en Windows eso tiene una trampa medida: con la ruta del bash de
 * Git entre comillas, PowerShell lee el comando como dos textos y no ejecuta nada. La forma elegida es sin
 * comillas, y sólo se puede escribir en el aplicador si los cinco lanzadores la corren. Si alguno no la corre, todas las
 * Windows quedan con `node "<guion>"`.
 *
 * QUÉ MIDE, en una carpeta del laboratorio (nunca en la carpeta del usuario del agente):
 *   · copia el Node con que corre este sondeo a `<lab>/node-form/node/current/node.exe` (ruta con barras normales y sin
 *     espacios: la forma que el aplicador escribiría);
 *   · escribe un freno `.js` de prueba que sale 2 si la entrada dice BLOQUEAR y 0 si no, y anota con qué Node corrió;
 *   · lo dispara con `<ruta>/node.exe "<guion>"` SIN comillas por los cinco lanzadores de fire-registered.js
 *     (`bash-c`, `bash-file`, `pwsh-command`, `pwsh-file`, `default-shell`), con una entrada que tiene que frenar y otra
 *     que tiene que pasar;
 *   · control positivo del motivo: la misma ruta CON comillas por los lanzadores de PowerShell (se espera que no corra).
 * Fuera de Windows corre igual con el binario de Node y `/bin/sh`, en «modo de laboratorio»: la forma posix.
 *
 * Lo llama no-clone-probe.js como paso, después de links-spike.js. Deja los datos en `rec.fact('node_form_spike', …)` y
 * un hallazgo `no-clone:node-form-unquoted-fails` («rompe») si en Windows algún lanzador no frenó o no dejó pasar con la
 * forma sin comillas. Nunca tira: un problema del sondeo es una nota.
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');
const FR = require('./fire-registered.js');

const UNQUOTED_WIN = /^[A-Za-z]:\/[A-Za-z0-9._/+-]+$/;
const UNQUOTED_POSIX = /^[A-Za-z0-9._/+-]+$/;

/** El freno de prueba: lee la entrada, anota el Node que lo corrió y sale 2 con «BLOQUEAR». */
const BRAKE = [
  "'use strict';",
  "const fs = require('fs');",
  "let raw = ''; try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { raw = ''; }",
  "process.stderr.write(`node=${process.execPath}\\n`);",
  "if (raw.includes('BLOQUEAR')) { process.stderr.write('freno de prueba: BLOQUEADO\\n'); process.exit(2); }",
  'process.exit(0);',
  '',
].join('\n');

function measureNodeForm({ base, env, rec, isWin = L.isWin(), platform = process.platform }) {
  const out = { lab_mode: !isWin, interpreter: null, unquoted_ok: null, rows: [], quoted_control: [] };
  try {
    const root = path.join(base, 'node-form');
    const current = path.join(root, 'node', 'current');
    fs.mkdirSync(current, { recursive: true });
    const bin = path.join(current, isWin ? 'node.exe' : 'node');
    fs.copyFileSync(process.execPath, bin);
    if (!isWin) fs.chmodSync(bin, 0o755);
    const guion = path.join(root, 'brake.js');
    fs.writeFileSync(guion, BRAKE);
    const binFwd = bin.replace(/\\/g, '/');
    const guionFwd = guion.replace(/\\/g, '/');
    out.interpreter = binFwd;
    if (!(isWin ? UNQUOTED_WIN : UNQUOTED_POSIX).test(binFwd)) {
      out.not_measured = `la carpeta del laboratorio (${binFwd}) no entra en la forma sin comillas: no mide nada`;
      rec.note(`node-form-spike: ${out.not_measured}`);
      rec.fact('node_form_spike', out);
      return out;
    }
    const bashes = L.scanPath('bash', { env, platform });
    const gitBash = L.findGitBash({ platform, env, gitLocations: L.scanPath('git', { env, platform }), bashLocations: bashes }).path;
    const pwsh = L.scanPath('pwsh', { env, platform })[0] || null;
    const forms = FR.shellForms({ platform, gitBash, firstBash: bashes[0] || null, pwsh, scratch: root }).filter((f) => !f.sample);
    out.forms = forms.map((f) => f.id);
    const cases = [
      { kind: 'must-block', input: { tool_name: 'Bash', tool_input: { command: 'echo BLOQUEAR' } } },
      { kind: 'must-not-block', input: { tool_name: 'Bash', tool_input: { command: 'echo hola' } } },
    ];
    const unquoted = `${binFwd} "${guionFwd}"`;
    // la vara es la forma actual (`node "<guion>"`) por el mismo lanzador: PowerShell no devuelve el 2 de un programa
    // tal cual (`-Command` sale 1, `-File` sale 0, medido en Mac con pwsh 7) y eso ya pasa con la forma actual; lo que
    // la forma nueva no puede hacer es salir DISTINTO que ella
    const today = `node "${guionFwd}"`;
    const realBin = L.realOrSelf(bin).replace(/\\/g, '/').toLowerCase();
    const bad = [];
    for (const form of forms) {
      for (const c of cases) {
        const base = FR.fire(form, today, c.input, { cwd: root, env });
        const row = FR.fire(form, unquoted, c.input, { cwd: root, env });
        const said = String(row.err || '').replace(/\\/g, '/').toLowerCase();
        const ranOurs = said.includes(`node=${binFwd.toLowerCase()}`) || said.includes(`node=${realBin}`);
        const ok = !row.error && !row.timed_out && row.exit === base.exit && ranOurs;
        out.rows.push({ form: form.id, case: c.kind, exit: row.exit, today_exit: base.exit, error: row.error || null, ok, ran_harness_node: ranOurs, said: L.firstLine(row.err) || null });
        if (!ok) bad.push(`${form.id}/${c.kind} salió ${row.error || row.exit} (la forma de hoy, ${base.error || base.exit}${ranOurs ? '' : '; no corrió con el Node copiado'})`);
      }
    }
    out.unquoted_ok = bad.length === 0;
    // control positivo: con comillas, PowerShell lee dos textos y no ejecuta el guion (el motivo de la forma sin comillas)
    const quoted = `"${binFwd}" "${guionFwd}"`;
    for (const form of forms.filter((f) => /^pwsh/.test(f.id))) {
      const row = FR.fire(form, quoted, cases[0].input, { cwd: root, env });
      out.quoted_control.push({ form: form.id, exit: row.exit, error: row.error || null, blocked: row.exit === 2 });
    }
    rec.fact('node_form_spike', out);
    if (isWin && bad.length) rec.finding('no-clone:node-form-unquoted-fails', 'node-form-spike', `un hook .js registrado con la ruta del Node del arnés sin comillas no corrió bien por todos los lanzadores (${bad.join(', ')}): todas las Windows quedan con node "<guion>" (decisión 22 de la story 8.39)`, 'W8', { severity: 'breaks' });
    try { fs.rmSync(bin, { force: true }); } catch (_) { /* el laboratorio se borra entero */ }
  } catch (e) {
    rec.note(`node-form-spike: el sondeo no pudo terminar (${(e && e.message) || e})`);
    rec.fact('node_form_spike', out);
  }
  return out;
}

module.exports = { measureNodeForm, BRAKE, UNQUOTED_WIN, UNQUOTED_POSIX };
