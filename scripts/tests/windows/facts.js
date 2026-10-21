#!/usr/bin/env node
'use strict';
/**
 * facts.js — el reporte de una corrida, vuelto HECHOS.
 *
 * POR QUÉ EXISTE. El análisis de Windows deja quince preguntas que no se pueden contestar sin una máquina,
 * y se apoya en ocho supuestos (S1 a S8). Este guion toma `windows-report.json` y
 * contesta cada una: como HECHO, con el número de la corrida que lo midió, o como «no medido», con su motivo y quién
 * lo contesta. Nunca deja una pregunta sin fila, y nunca escribe un hecho que la corrida no trajo.
 *
 * Un supuesto que la corrida CONTRADICE se marca: el supuesto se corrige antes de apoyarse en él.
 *
 * Uso:  node scripts/tests/windows/facts.js <windows-report.json>      (imprime el markdown)
 *       … > tasks/measurement-8.17-windows/facts-w0.md
 * Sale 0 si escribió · 2 si no pudo leer el reporte o el reporte no trae pasos (un reporte vacío no dice nada).
 */
const fs = require('fs');

const stepOf = (report, name) => (Array.isArray(report.steps) ? report.steps.find((s) => s && s.name === name) : null) || null;
const measured = (step) => Boolean(step) && step.status === 'measured';
const whyNot = (step, name) => (!step ? `el paso ${name} no corrió` : (step.status === 'measured' ? null : `${step.status === 'error' ? 'error' : 'no medido'} en el paso ${name}: ${step.reason || 'sin motivo anotado'}`));
const fact = (text) => ({ state: 'fact', text });
const none = (reason) => ({ state: 'not-measured', text: reason });
const list = (xs) => (xs && xs.length ? xs.join(', ') : '—');
const yes = (v) => (v === true ? 'sí' : (v === false ? 'no' : 'no se sabe'));

/** Las quince preguntas, cada una con su respuesta: `[{ n, question, state, text, run }]`. */
function points(report) {
  const run = report.run && report.run.id !== undefined && report.run.id !== null ? String(report.run.id) : 'sin número';
  const inv = stepOf(report, 'inventory');
  const ins = stepOf(report, 'install');
  const fire = stepOf(report, 'fire-registered');
  const ses = stepOf(report, 'session-probe');
  const F = (s) => (s && s.facts) || {};
  const answers = F(ses).answers || null;
  const variants = F(ins).variants || {};
  const session = (pick) => (measured(ses) && answers ? pick(answers) : none(whyNot(ses, 'session-probe') || 'la sesión no dejó respuestas'));
  const out = [];
  const add = (question, answer) => out.push(Object.assign({ n: out.length + 1, question, run: answer.state === 'fact' ? run : null }, answer));

  add('Con qué shell corre Claude Code el `command` de un hook, con y sin Git for Windows',
    session((a) => (a.hook_shell ? fact(`lo lanzó: ${list(a.hook_shell)}; con el bash de Git fuera del PATH: ${list(a.hook_shell_without_git_bash_in_path)} (Git seguía instalado: desinstalarlo no se midió)`) : none('la sesión no disparó el hook marcador'))));
  add('Cómo se llama la herramienta de terminal en los eventos, y si un matcher `Bash` ve la herramienta `PowerShell`',
    session((a) => (a.terminal_tool_names ? fact(`herramientas de terminal vistas: ${list(a.terminal_tool_names)}; un matcher Bash ve lo que corre por PowerShell: ${a.bash_matcher_sees_powershell_tool === null ? 'no se midió (el asistente no usó esa herramienta)' : yes(a.bash_matcher_sees_powershell_tool)}`) : none('la sesión no usó ninguna herramienta de terminal'))));
  add('Qué forma tienen `cwd`, `file_path` y `transcript_path` en el evento',
    session((a) => (a.path_shapes ? fact(`cwd ${list(a.path_shapes.cwd)} · file_path ${list(a.path_shapes.file_path)} · transcript_path ${list(a.path_shapes.transcript_path)}`) : none('la sesión no dejó rutas'))));

  const startup = F(fire).startup;
  add('Si la línea de arranque de Windows arranca, y si su respaldo corre alguna vez',
    measured(fire) && startup && startup.by_form && startup.by_form.length
      ? fact(startup.by_form.map((f) => `${f.form}: arranca ${yes(f.healthy && f.healthy.bootstrap_ran)}, el respaldo corre ${f.broken && f.broken.not_measured ? `no medido (${f.broken.not_measured})` : yes(f.broken && f.broken.fallback_ran)}`).join(' · '))
      : none(whyNot(fire, 'fire-registered') || (startup && startup.not_measured) || 'el paso no midió la línea de arranque'));

  const gb = F(inv).git_bash;
  const bash = (F(inv).tools || {}).bash;
  add('Qué `bash` aparece primero en el PATH: el de Git o el lanzador de WSL',
    inv && bash && bash.state !== 'error'
      ? fact(bash.state === 'absent' ? 'no hay ningún bash en el PATH' : `el primero es ${bash.locations[0]}${gb && gb.first_bash_is_wsl_launcher ? ' (el lanzador de WSL)' : ''}; en orden: ${bash.locations.join(' → ')}; el bash de Git: ${gb && gb.path ? gb.path : `no encontrado (${gb ? gb.reason : '—'})`}`)
      : none(whyNot(inv, 'inventory') || (bash && bash.reason) || 'el inventario no ubicó bash'));
  const inside = gb && gb.tools && !gb.tools.problem ? gb.tools : null;
  add('Qué trae Git for Windows: `jq`, `timeout`, `realpath`, `lsof`, `python3`',
    inside ? fact(`trae: ${list(Object.keys(inside).filter((k) => inside[k]))}; no trae: ${list(Object.keys(inside).filter((k) => !inside[k]))}`)
      : none(whyNot(inv, 'inventory') || (gb && (gb.reason || (gb.tools && gb.tools.problem))) || 'el inventario no pudo mirar adentro del bash de Git'));

  const crlf = F(inv).autocrlf;
  const eol = Object.entries(variants).filter(([, v]) => v.eol && typeof v.eol.with_cr === 'number').map(([id, v]) => `${id}: ${v.eol.with_cr} de ${v.eol.total} .sh con \\r (en el clon, core.autocrlf: ${v.eol.autocrlf_in_clone})`);
  add('El valor de `core.autocrlf` en el agente, y si los `.sh` llegan rotos',
    crlf && !crlf.problem ? fact(`core.autocrlf ${crlf.set ? `= ${crlf.effective} (${list(crlf.entries)})` : 'sin fijar'}; ${eol.length ? eol.join(' · ') : 'ninguna instalación dejó un clon donde contar los .sh'}`)
      : none(whyNot(inv, 'inventory') || (crlf && crlf.problem) || 'el inventario no leyó core.autocrlf'));

  const homes = F(inv).homes;
  const seen = Object.entries(variants).filter(([, v]) => v.seen_homes).map(([id, v]) => `${id}: node ${yes(v.seen_homes.node_is_lab)}, PowerShell ${yes(v.seen_homes.pwsh_is_lab)}, bash de Git ${yes(v.seen_homes.git_bash_is_lab)}`);
  add('Si `$HOME` de PowerShell, `USERPROFILE`, la `HOME` de Git Bash y `os.homedir()` coinciden',
    homes ? fact(`en el agente: ${homes.agree === null ? `no se sabe (faltó: ${list(homes.unknown)})` : (homes.agree ? 'coinciden' : `NO coinciden (${Object.entries(homes.compared).map(([k, v]) => `${k}=${v}`).join(' · ')})`)}${seen.length ? `; con la carpeta de laboratorio puesta, ¿cada uno la ve? ${seen.join(' · ')}` : ''}`)
      : none(whyNot(inv, 'inventory') || 'el inventario no midió las carpetas de usuario'));

  const links = Object.entries(variants).filter(([, v]) => Array.isArray(v.links)).map(([id, v]) => `${id}: ${v.links.map((l) => `${l.name} ${l.present ? `${l.link_type || l.kind}${l.to_clone ? '' : ' (no resuelve al clon)'}` : 'ausente'}`).join(', ')}`);
  const removed = Object.entries(variants).filter(([, v]) => v.uninstall).map(([id, v]) => `${id}: uninstall salió ${v.uninstall.error || v.uninstall.exit}, quedaron ${list(v.uninstall.links_left)}`);
  add('Si el junction se crea, se lee y se borra; y el enlace de archivo sin «modo desarrollador»',
    links.length ? fact(`creados y leídos — ${links.join(' · ')}; borrados — ${removed.length ? removed.join(' · ') : 'no se midió (ninguna variante se desinstaló)'}; el enlace de archivo sin modo desarrollador NO se mide acá (administrador: ${yes((F(inv).administrator || {}).value)}, modo desarrollador: ${yes((F(inv).developer_mode || {}).value)}): lo contesta la máquina real`)
      : none(whyNot(ins, 'install') || 'ninguna instalación dejó enlaces que mirar'));

  add('Si los portones que deciden por ruta aciertan con una ruta `C:\\…`', none('lo contesta W1: el banco de controles todavía no corre en Windows'));
  add('Si un guion pasado por la entrada estándar con acentos llega bien', none('lo contesta W6, ya sin Python: se mide con Node'));

  const tools = F(inv).tools || {};
  const kind = (name) => (tools[name] ? (tools[name].state === 'present' ? `${name} es ${tools[name].launch_kind} (${tools[name].locations[0]})` : (tools[name].state === 'absent' ? `${name} no está en el agente` : `${name}: no pude preguntar`)) : null);
  // «no pude preguntar» no es un hecho: hace falta que al menos uno se haya podido ubicar o descartar
  const answered = ['az', 'claude'].some((n) => tools[n] && ['present', 'absent'].includes(tools[n].state));
  add('Si `claude` y `az` son un `.exe` o un `.cmd`',
    answered ? fact([kind('az'), kind('claude')].filter(Boolean).join(' · ')) : none(whyNot(inv, 'inventory') || 'el inventario no ubicó az ni claude'));

  add('Cómo se comporta el reemplazo atómico de `settings.json` con el archivo abierto por otra sesión o un antivirus', none('lo contesta W8: dos sesiones durante una actualización, en una máquina real'));
  add('Si `-ExecutionPolicy Bypass` alcanza en una máquina con políticas de empresa', none('nadie en esta story: queda declarado como no medido'));
  add('Si el equipo tuvo alguna vez una sesión de Claude Code en Windows con el arnés andando', none('W8 es la primera con constancia'));
  return out;
}

/** Los ocho supuestos: `[{ id, text, verdict: 'confirmed'|'contradicted'|'not-measured', detail }]`. */
function assumptions(report) {
  const F = (name) => (stepOf(report, name) || {}).facts || {};
  const a = F('session-probe').answers || null;
  const inv = F('inventory');
  const variants = F('install').variants || {};
  const out = [];
  const add = (id, text, verdict, detail) => out.push({ id, text, verdict, detail });
  const v = (known, ok) => (known ? (ok ? 'confirmed' : 'contradicted') : 'not-measured');
  const noSession = 'falta la sesión real';

  add('S1', 'Con Git for Windows instalado, Claude Code corre el `command` de un hook con Git Bash',
    v(Boolean(a && a.hook_shell && a.hook_shell.length), Boolean(a && a.hook_shell && a.hook_shell.every((s) => s === 'bash'))), a && a.hook_shell ? `lo lanzó: ${list(a.hook_shell)}` : noSession);
  add('S2', 'Sin Git for Windows el asistente no tiene la herramienta `Bash`', 'not-measured', 'el agente no puede quedarse sin Git: sólo se midió con su bash fuera del PATH');
  add('S3', '`CLAUDE_CODE_USE_POWERSHELL_TOOL=0` en `env` de `settings.json` apaga la herramienta `PowerShell`',
    v(Boolean(a) && a.variable_turns_powershell_tool_off !== null, Boolean(a && a.variable_turns_powershell_tool_off)), a ? (a.variable_turns_powershell_tool_off === null ? 'el asistente no usó la herramienta PowerShell: no hay con qué comparar' : `con la variable, la herramienta ${a.variable_turns_powershell_tool_off ? 'no se usó' : 'se siguió usando'}`) : noSession);
  add('S4', 'Un matcher `Bash` no ve lo que corre por la herramienta `PowerShell`',
    v(Boolean(a) && a.bash_matcher_sees_powershell_tool !== null, Boolean(a && a.bash_matcher_sees_powershell_tool === false)), a ? (a.bash_matcher_sees_powershell_tool === null ? 'el asistente no usó la herramienta PowerShell' : `el matcher Bash ${a.bash_matcher_sees_powershell_tool ? 'SÍ la vio' : 'no la vio'}`) : noSession);
  const crlf = inv.autocrlf;
  add('S5', 'El agente trae `core.autocrlf=true`', v(Boolean(crlf && !crlf.problem), Boolean(crlf && crlf.effective === 'true')), crlf && !crlf.problem ? (crlf.set ? `vale ${crlf.effective}` : 'sin fijar') : 'el inventario no lo leyó');
  const inside = inv.git_bash && inv.git_bash.tools && !inv.git_bash.tools.problem ? inv.git_bash.tools : null;
  add('S6', 'Git for Windows no trae `jq`', v(Boolean(inside), Boolean(inside && !inside.jq)), inside ? `jq: ${inside.jq || 'no está'} · timeout: ${inside.timeout || 'no está'} · realpath: ${inside.realpath || 'no está'}` : 'el inventario no miró adentro del bash de Git');
  // toda variante que miró sus enlaces cuenta, también la que no dejó ninguno: que no se cree ni uno contradice
  // el supuesto más que que falte uno
  const linkSets = Object.values(variants).filter((x) => Array.isArray(x.links) && x.links.length);
  add('S7', 'El junction se crea, se lee y se borra como espera `canonical-path.js`',
    v(linkSets.length > 0, linkSets.every((x) => x.links.every((l) => l.present && l.to_clone)) && Object.values(variants).filter((x) => x.uninstall).every((x) => !x.uninstall.links_left.length)),
    linkSets.length ? `enlaces que resuelven al clon: ${linkSets.map((x) => `${x.links.filter((l) => l.to_clone).length} de ${x.links.length}`).join(' · ')}` : 'ninguna instalación dejó enlaces');
  const tools = inv.tools || {};
  const present = ['az', 'claude'].filter((n) => tools[n] && tools[n].state === 'present');
  add('S8', '`az` y `claude` son un `.cmd` que Node no lanza sin shell', v(present.length > 0, present.every((n) => ['cmd', 'bat'].includes(tools[n].launch_kind))), present.length ? present.map((n) => `${n}: ${tools[n].launch_kind}`).join(' · ') : 'ninguno de los dos está en el agente');
  return out;
}

const VERDICT_TEXT = { confirmed: 'confirmado', contradicted: '🔴 CONTRADICHO: corregir la story antes de la tanda que se apoya en él', 'not-measured': 'no medido' };
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/[\n\t]/g, ' ');

/** El markdown de los hechos. */
function render(report) {
  const run = report.run || {};
  const L = [];
  L.push('# Windows — los hechos de W0 (story 8.17)', '');
  L.push(`Corrida **${run.id !== undefined && run.id !== null ? run.id : 'sin número'}**${run.number ? ` (${run.number})` : ''} · ${run.finished || run.started || 'sin fecha'} · arnés \`${run.harness_ref || '—'}\` · ${run.platform || '—'}${run.lab_mode ? ' (modo de laboratorio: NO es un Windows)' : ''} · sesión real: ${run.real_session ? 'sí' : 'no'}`, '');
  L.push('Generado por `scripts/tests/windows/facts.js` desde `windows-report.json`. No se edita a mano.', '');
  L.push('## Lo que no se sabía sin una máquina Windows', '');
  L.push('| # | Qué no se sabía | Respuesta |', '|---|---|---|');
  for (const p of points(report)) L.push(`| ${p.n} | ${cell(p.question)} | ${p.state === 'fact' ? `**Hecho (corrida ${p.run})** — ${cell(p.text)}` : `**No medido** — ${cell(p.text)}`} |`);
  L.push('', '## Los supuestos de la story', '');
  L.push('| # | Supuesto | Qué dijo la corrida | Detalle |', '|---|---|---|---|');
  for (const s of assumptions(report)) L.push(`| ${s.id} | ${cell(s.text)} | ${VERDICT_TEXT[s.verdict]} | ${cell(s.detail)} |`);
  const findings = (report.steps || []).flatMap((s) => (s.findings || []).map((f) => Object.assign({ step: s.name }, f)));
  L.push('', `## Hallazgos (${findings.length})`, '');
  if (!findings.length) L.push('Ninguno.');
  for (const f of findings) L.push(`- \`${f.id}\` (${f.step}${f.closes_hint ? ` · la cierra ${f.closes_hint}` : ''}) — ${f.detail}`);
  L.push('');
  return L.join('\n');
}

function main(argv) {
  if (argv.length !== 1) { process.stderr.write('uso: node scripts/tests/windows/facts.js <windows-report.json>\n'); return 2; }
  let report;
  try { report = JSON.parse(fs.readFileSync(argv[0], 'utf8')); } catch (e) { process.stderr.write(`facts.js: no pude leer el reporte ${argv[0]}: ${e.message}\n`); return 2; }
  if (!report || !Array.isArray(report.steps) || !report.steps.length) { process.stderr.write('facts.js: el reporte no trae ningún paso: no hay hechos que escribir\n'); return 2; }
  process.stdout.write(render(report));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { points, assumptions, render, stepOf };
