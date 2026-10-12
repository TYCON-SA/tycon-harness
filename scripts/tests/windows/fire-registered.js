#!/usr/bin/env node
'use strict';
/**
 * fire-registered.js — disparar cada hook TAL COMO QUEDÓ REGISTRADO, por cada shell posible (story 8.17, W0 · AC 8).
 *
 * POR QUÉ EXISTE. Nadie sabe con qué shell corre Claude Code el `command` de un hook en Windows, y el código del arnés
 * supone tres cosas distintas a la vez (bash en el instalador, `cmd.exe` en la comprobación de salud y en la línea de
 * arranque). Hasta que una sesión real lo conteste, lo único honesto es medirlo de todas las formas y anotar cada una:
 * el texto exacto del `command` de `settings.json`, sin reescribirlo, con una entrada de mentira por la entrada estándar.
 *
 * LAS FORMAS (cada una es una manera en que el asistente podría lanzar el comando):
 *   bash-c         `<bash de Git> -c "<command>"`           bash-file      el comando en un archivo `.sh`
 *   pwsh-command   `pwsh -NoProfile -Command "<command>"`   pwsh-file      el comando en un archivo `.ps1`
 *   default-shell  el shell por defecto de Node: `cmd.exe /d /s /c` en Windows, `/bin/sh -c` en el resto
 *   path-bash-c    sólo en Windows y sólo si el primer `bash` del PATH no es el de Git (puede ser el lanzador de WSL);
 *                  de muestra: el primer hook y la línea de arranque
 *
 * LAS ENTRADAS. A todo hook, una entrada legítima mínima de su evento. A los que frenan —los que tienen en el banco
 * de controles un caso «tiene que frenar»—, además ese caso y uno «tiene que pasar», si el banco trae alguno que no
 * necesite preparar un repo por shell (eso lo trae W1). El comando destructivo de un caso NO se ejecuta: viaja como
 * texto dentro de la entrada y el hook decide sobre ese texto.
 *
 * ADEMÁS: los dos frenos en bash (`safety-guard-pre.sh`, `test-scope-guard-pre.sh`) lanzados sueltos bajo el bash de
 * Git, con el PATH de la máquina y con `jq` quitado del PATH; y la línea de arranque, en cada forma, sana (¿corrió
 * `bootstrap.js`?) y con el enlace del arnés roto a propósito (¿corrió el respaldo?). El enlace se repone siempre.
 *
 * CÓMO FALLA. Un hook que no frena, que se cae o que no arranca es un HECHO con su hallazgo. El paso sale «error» sólo
 * si no pudo medir: sin `settings.json`, sin laboratorio, o sin ninguna forma con la que lanzar.
 *
 * Uso: node scripts/tests/windows/fire-registered.js --lab <laboratorio> --out <carpeta del reporte>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lab.js');
const C = require('./count-hooks.js');
const PLACE = require('../../setup/harness/place.js');

const NAME = 'fire-registered';
const HOOK_TIMEOUT_MS = 60 * 1000;
const STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
const BLOCK_RX = /"decision"\s*:\s*"block"|"permissionDecision"\s*:\s*"deny"/;
const BASH_BRAKES = [
  { file: 'safety-guard-pre.sh', fallback: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } } },
  { file: 'test-scope-guard-pre.sh', fallback: { tool_name: 'Bash', tool_input: { command: 'npm test' } } },
];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return null; } };

/** Cómo se nombra un hook: `@tcg:<archivo>` los del arnés, la ruta bajo `skills/` los de las skills. */
function hookName(file, platform) {
  const p = L.comparable(file, platform);
  const tcg = /\/scripts\/hooks\/([^/]+)$/.exec(p);
  if (tcg) return `@tcg:${tcg[1]}`;
  const sk = /\/skills\/(.+)$/.exec(p);
  return sk ? sk[1] : path.posix.basename(p);
}

// ── las entradas ─────────────────────────────────────────────────────────────────────────────────────────────────

function subst(value, vars) {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (Array.isArray(value)) return value.map((x) => subst(x, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, subst(v, vars)]));
  return value;
}

/** La entrada de un evento, con la forma que arma el banco de controles (`buildStdin` de `runner.js`). */
function payload(event, extra, { cwd, home }) {
  return Object.assign({
    session_id: 'tycon-windows-probe',
    cwd,
    hook_event_name: event,
    transcript_path: path.join(home, '.claude', 'transcript.jsonl'),
    permission_mode: 'default',
  }, extra || {});
}

/** La entrada legítima mínima de cada evento y matcher: algo que ningún hook tiene por qué frenar. */
function genericInput(event, matcher, cwd) {
  const first = String(matcher || '').split('|')[0];
  if (event === 'SessionStart') return { source: 'startup' };
  if (event === 'UserPromptSubmit') return { prompt: 'hola' };
  if (event === 'Stop' || event === 'SubagentStop') return { stop_hook_active: false };
  const tool = first || 'Bash';
  const inputs = {
    Bash: { command: 'echo hola' },
    Edit: { file_path: path.join(cwd, 'notes.txt'), old_string: 'a', new_string: 'b' },
    Write: { file_path: path.join(cwd, 'notes.txt'), content: 'hola\n' },
    Task: { subagent_type: 'general-purpose', description: 'prueba', prompt: 'hola' },
    Agent: { subagent_type: 'general-purpose', description: 'prueba', prompt: 'hola' },
    Skill: { skill: 'ejemplo' },
    Artifact: { action: 'list' },
  };
  const out = { tool_name: tool, tool_input: inputs[tool] || {} };
  if (event === 'PostToolUse') out.tool_response = tool === 'Bash' ? { stdout: 'hola\n', stderr: '', interrupted: false } : { success: true };
  return out;
}

/**
 * Los casos del banco que se pueden disparar sin preparar nada por shell, por hook y evento:
 * `{ '<nombre>::<evento>': { brakes: true, block: caso|null, pass: caso|null } }`. `brakes` = el banco le pide frenar.
 */
function benchCases(casesDir, platform) {
  const out = {};
  let files;
  try { files = fs.readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort(); } catch (_) { return null; }
  for (const f of files) {
    let raw;
    try { raw = readJson(path.join(casesDir, f)); } catch (_) { continue; }
    for (const h of Array.isArray(raw.hooks) ? raw.hooks : [raw]) {
      for (const c of (h && h.cases) || []) {
        const key = `${hookName(String(c.script || h.script || ''), platform)}::${h.event}`;
        const slot = out[key] || (out[key] = { brakes: false, block: null, pass: null });
        if (c.type === 'must-block') slot.brakes = true;
        const portable = !((c.setup && c.setup.length) || (h.setup && h.setup.length));
        if (!portable) continue;
        const item = { id: c.id, stdin: c.stdin || {}, files: c.files || {}, env: Object.assign({}, h.env || {}, c.env || {}) };
        if (c.type === 'must-block' && !slot.block) slot.block = item;
        if (c.type === 'must-not-block' && !slot.pass) slot.pass = item;
      }
    }
  }
  return out;
}

// ── las formas ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Las formas con que se puede lanzar un comando en esta máquina: `[{ id, shell, launch(command, n) → [bin, args, opts] }]`. */
function shellForms({ platform = process.platform, gitBash, firstBash, pwsh, scratch }) {
  const dir = path.join(scratch, 'fire');
  const file = (n, ext, command) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, `command-${n}.${ext}`); fs.writeFileSync(f, `${command}\n`); return f; };
  const forms = [];
  if (gitBash) {
    forms.push({ id: 'bash-c', shell: gitBash, launch: (command) => [gitBash, ['-c', command], {}] });
    forms.push({ id: 'bash-file', shell: gitBash, launch: (command, n) => [gitBash, [file(n, 'sh', command)], {}] });
  }
  if (pwsh) {
    forms.push({ id: 'pwsh-command', shell: pwsh, launch: (command) => [pwsh, ['-NoProfile', '-NonInteractive', '-Command', command], {}] });
    forms.push({ id: 'pwsh-file', shell: pwsh, launch: (command, n) => [pwsh, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file(n, 'ps1', command)], {}] });
  }
  forms.push({ id: 'default-shell', shell: L.isWin(platform) ? 'cmd.exe /d /s /c' : '/bin/sh -c', launch: (command) => [command, [], { shell: true }] });
  if (L.isWin(platform) && firstBash && gitBash && !L.samePath(firstBash, gitBash, platform)) {
    // una muestra alcanza: con el primer hook y con la línea de arranque se sabe si ese bash puede correr un comando
    forms.push({ id: 'path-bash-c', shell: firstBash, sample: true, launch: (command) => [firstBash, ['-c', command], {}] });
  }
  return forms;
}

let fileCounter = 0;
/** Un disparo: el comando tal cual, la entrada por la entrada estándar. Devuelve una fila del reporte. */
function fire(form, command, input, { cwd, env, timeoutMs = HOOK_TIMEOUT_MS }) {
  const [bin, args, opts] = form.launch(command, ++fileCounter);
  const r = L.run(bin, args, Object.assign({ cwd, env, input: JSON.stringify(input), timeoutMs, cap: 500 }, opts));
  return { form: form.id, exit: r.exit, error: r.error, timed_out: r.timed_out, blocked: r.exit === 2 || BLOCK_RX.test(r.stdout), ms: r.ms, out: r.stdout, err: r.stderr };
}

const closesFor = (form, runner) => (/^bash/.test(form) ? (runner === 'bash' ? 'W2' : 'W4') : 'W5');

// ── los hooks ────────────────────────────────────────────────────────────────────────────────────────────────────

function measureHooks({ hooks, forms, cases, home, clone, skills, scratch, env, platform, rec }) {
  const rows = [];
  const repo = path.join(scratch, 'fire-repo');
  fs.mkdirSync(repo, { recursive: true });
  L.run('git', ['init', '-q', repo], { env, timeoutMs: 30000 });
  const baseEnv = Object.assign({}, env, { CLAUDE_PROJECT_DIR: repo });
  // en la copia pública las skills viven en el mismo clon; en la instalación del equipo, en su propio clon (`skills`)
  const vars = { FIXTURE: repo, SANDBOX_HOME: home, HOME: home, REAL_HOME: home, TCG: clone, SKILLS: skills || clone };
  const brakes = [];
  for (const [index, h] of hooks.entries()) {
    const name = h.file ? hookName(h.file, platform) : L.clip(h.command, 80);
    const slot = cases ? cases[`${name}::${h.event}`] : null;
    // el id de cada hallazgo lleva el evento, y el matcher cuando el mismo archivo está más de una vez en ese evento
    // (rebuild-before-verify.js en PostToolUse: Edit|Write y Bash): si no, los dos registros son un solo hallazgo
    const twice = h.file && hooks.filter((x) => x.event === h.event && x.file === h.file).length > 1;
    const key = `${h.event}:${name}${twice && h.matcher ? ` [${h.matcher}]` : ''}`;
    const inputs = [{ kind: 'generic', id: null, input: payload(h.event, genericInput(h.event, h.matcher, repo), { cwd: repo, home }), env: baseEnv }];
    if (slot && slot.brakes) {
      for (const [kind, item] of [['must-block', slot.block], ['must-not-block', slot.pass]]) {
        if (!item) continue;
        for (const [rel, content] of Object.entries(item.files)) { const p = path.join(repo, subst(rel, vars)); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, subst(content, vars)); }
        inputs.push({ kind, id: item.id, input: payload(h.event, subst(item.stdin, vars), { cwd: repo, home }), env: Object.assign({}, baseEnv, subst(item.env, vars)) });
      }
      if (!slot.block || !slot.pass) rec.finding(`fire:no-portable-case:${key}`, 'fire-no-case', `${name} frena (el banco le pide frenar) y el banco no trae, para ${h.event}, ${!slot.block ? 'un caso «tiene que frenar»' : 'un caso «tiene que pasar»'} que se pueda disparar sin preparar un repo por shell: su freno se mide con el banco en Windows`, 'W1');
      brakes.push(name);
    }
    for (const it of inputs) {
      for (const form of forms) {
        if (form.sample && (index > 0 || it.kind !== 'generic')) continue;
        const row = Object.assign({ hook: name, event: h.event, matcher: h.matcher, runner: h.runner, case: it.kind, case_id: it.id }, fire(form, h.command, it.input, { cwd: repo, env: it.env }));
        rows.push(row);
        const said = L.firstLine(row.err) || L.firstLine(row.out);
        if (it.kind === 'must-block' && !row.blocked) rec.finding(`fire:brake-passes:${key}:${form.id}`, 'fire-brake', `${name}, lanzado por ${form.id}, NO frenó la entrada que tiene que frenar (caso ${it.id}): salió ${row.error || row.exit}${said ? ` — ${said}` : ''}`, closesFor(form.id, h.runner));
        else if (it.kind === 'must-not-block' && (row.blocked || row.exit !== 0)) rec.finding(`fire:legit-blocked:${key}:${form.id}`, 'fire-brake', `${name}, lanzado por ${form.id}, no dejó pasar la entrada legítima (caso ${it.id}): salió ${row.error || row.exit}${said ? ` — ${said}` : ''}`, closesFor(form.id, h.runner));
        // frenar una entrada legítima es un hallazgo aunque salga 0: un hook frena también imprimiendo el bloqueo en JSON
        else if (it.kind === 'generic' && (row.error || row.exit !== 0 || row.blocked)) rec.finding(`fire:fails:${key}:${form.id}`, 'fire-hook', `${name} (${h.event}), lanzado por ${form.id} con una entrada legítima, salió ${row.error || row.exit}${row.blocked ? ' (frenó)' : ''}${said ? ` — ${said}` : ''}`, closesFor(form.id, h.runner));
      }
    }
    rec.fact('fires', rows);
  }
  const byForm = {};
  for (const r of rows) {
    const s = byForm[r.form] || (byForm[r.form] = { fired: 0, exit_0: 0, exit_2: 0, other_exit: 0, did_not_start: 0, timed_out: 0, slowest_ms: 0 });
    s.fired++;
    if (r.timed_out) s.timed_out++; else if (r.error) s.did_not_start++; else if (r.exit === 0) s.exit_0++; else if (r.exit === 2) s.exit_2++; else s.other_exit++;
    s.slowest_ms = Math.max(s.slowest_ms, r.ms);
  }
  rec.fact('by_form', byForm);
  rec.fact('brakes_registered', brakes);
}

// ── los dos frenos en bash, con jq y sin jq ──────────────────────────────────────────────────────────────────────

function measureBashBrakes({ clone, gitBash, cases, home, scratch, env, platform, rec }) {
  const out = [];
  if (!gitBash) { rec.fact('bash_brakes', { not_measured: 'no hay bash de Git con qué lanzarlos' }); return; }
  const repo = path.join(scratch, 'fire-repo');
  const key = L.pathKey(env);
  const dirs = String(env[key] || '').split(path.delimiter).filter(Boolean);
  const hasJq = (d) => ['jq', 'jq.exe'].some((n) => { try { return fs.statSync(path.join(d, n)).isFile(); } catch (_) { return false; } });
  const without = dirs.filter((d) => !hasJq(d));
  const seesJq = (e) => { const r = L.run(gitBash, ['-c', 'command -v jq || true'], { env: e, timeoutMs: 30000, cap: 600 }); return r.error ? null : (L.firstLine(r.stdout) || ''); };
  for (const b of BASH_BRAKES) {
    const script = path.join(clone, 'scripts', 'hooks', b.file);
    const item = { hook: `@tcg:${b.file}`, exists: fs.existsSync(script) };
    out.push(item);
    if (!item.exists) { item.not_measured = 'el clon no trae ese archivo'; continue; }
    try { item.has_cr = fs.readFileSync(script).includes('\r\n'); } catch (_) { item.has_cr = null; }
    const slot = cases ? cases[`@tcg:${b.file}::PreToolUse`] : null;
    const input = payload('PreToolUse', slot && slot.block ? slot.block.stdin : b.fallback, { cwd: repo, home });
    item.case_id = slot && slot.block ? slot.block.id : 'built-in';
    for (const [label, pathValue] of [['with_agent_path', dirs.join(path.delimiter)], ['without_jq', without.join(path.delimiter)]]) {
      const e = Object.assign({}, env, { [key]: pathValue, CLAUDE_PROJECT_DIR: repo });
      const jq = seesJq(e);
      const r = L.run(gitBash, [script], { cwd: repo, env: e, input: JSON.stringify(input), timeoutMs: HOOK_TIMEOUT_MS, cap: 500 });
      item[label] = { jq_seen: jq, exit: r.exit, error: r.error, blocked: r.exit === 2 || BLOCK_RX.test(r.stdout), ms: r.ms, out: r.stdout, err: r.stderr };
      if (label === 'without_jq' && jq) { item[label].not_measured = `no pude quitar jq del PATH: el bash de Git lo sigue viendo en ${jq}`; continue; }
      if (!item[label].blocked) {
        const withJq = label === 'with_agent_path' && jq;
        rec.finding(`brakes:${b.file}:${label === 'without_jq' ? 'passes-without-jq' : (withJq ? 'passes-with-jq' : 'passes-with-agent-path')}`, 'bash-brake',
          `${b.file} bajo el bash de Git, ${label === 'without_jq' ? 'con jq quitado del PATH' : `con el PATH de la máquina (jq ${jq ? `en ${jq}` : 'no está'})`}, NO frenó «${(input.tool_input || {}).command}»: salió ${r.error || r.exit}${L.firstLine(r.stderr) ? ` — ${L.firstLine(r.stderr)}` : ''}`, 'W2');
      }
    }
    rec.fact('bash_brakes', out);
  }
  rec.fact('bash_brakes', out);
}

// ── la línea de arranque ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * ¿La instalación de esta carpeta de usuario es una VERSIÓN BAJADA (archivos, sin clon)? Lo dice el estado del arnés,
 * por su fuente; se mira donde el arnés lo guarda: su casa propia si la máquina vive ahí, o la carpeta de siempre.
 * `true` / `false`, o `null` si el estado ESTÁ y no se pudo leer: «no sé» no es «no» (con un «no» se rompería a
 * propósito el enlace de una versión bajada, y saldría un hallazgo falso por cada forma de lanzar). Quien llama deja
 * esa parte en «no medido», con el motivo.
 */
function installedAsRelease(home) {
  for (const file of [path.join(home, '.tycon', 'state', 'harness-state.json'), path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json')]) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') continue; return null; }
    let state;
    try { state = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (_) { return null; }
    return Array.isArray(state && state.sources) && state.sources.some((s) => s && s.kind === 'release');
  }
  return false;
}

function measureStartup({ line, forms, home, clone, env, rec }) {
  const facts = { registered: Boolean(line), by_form: [] };
  rec.fact('startup', facts);
  if (!line) { facts.not_measured = 'settings.json no trae la línea de arranque (la que llama a bootstrap.js)'; return; }
  facts.is_async = line.is_async;
  const harnessDir = path.join(home, '.claude', '.tycon-pipeline', 'harness');
  const logFile = path.join(harnessDir, 'startup.log');
  // los dos nombres del lugar del arnés: desde la 8.19 A, bootstrap.js prueba primero el nuevo y después el viejo.
  // Romper sólo uno no rompe nada: el arranque encuentra el otro y el respaldo nunca hace falta (182 #12030, 5 hallazgos
  // falsos). Se rompen los que estén; un arnés de antes de la 8.19 trae sólo el viejo.
  const links = [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME].map((n) => path.join(home, '.claude', n)).filter((p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } });
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const log = () => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
  const input = payload('SessionStart', { source: 'startup' }, { cwd: clone, home });
  const settingsBefore = sha(settingsFile);
  const release = installedAsRelease(home);
  const shoot = (form, extra) => {
    const before = log().length;
    const row = fire(form, line.command, input, { cwd: home, env: Object.assign({}, env, extra), timeoutMs: STARTUP_TIMEOUT_MS });
    return Object.assign(row, { log_lines: log().slice(before).map((l) => L.clip(l, 300)) });
  };
  for (const form of forms) {
    const item = { form: form.id, shell: form.shell };
    facts.by_form.push(item);
    // sana: con la actualización apagada, `harness.js startup` deja siempre una línea en su registro
    item.healthy = shoot(form, { TYCON_UPDATE: '0' });
    item.healthy.bootstrap_ran = item.healthy.log_lines.some((l) => /\b(startup|bootstrap):/.test(l));
    if (!item.healthy.bootstrap_ran) rec.finding(`startup:did-not-run:${form.id}`, 'startup-line', `la línea de arranque, lanzada por ${form.id}, no dejó rastro de que bootstrap.js corriera (salió ${item.healthy.error || item.healthy.exit}${L.firstLine(item.healthy.err) ? ` — ${L.firstLine(item.healthy.err)}` : ''})`, 'W5');
    // rota a propósito: sin los enlaces, bootstrap.js sale distinto de 0 y la línea tiene que caer al respaldo.
    // Con una versión bajada esa parte no aplica: el arranque encuentra el árbol por el estado aunque el lugar no
    // resuelva, el respaldo no corre, y saldría un hallazgo falso por cada forma de lanzar.
    if (release === null) {
      item.broken = { not_measured: 'el estado del arnés de esta carpeta de usuario existe y no se pudo leer: no sé si la instalación es una versión bajada, y romper el enlace a ciegas daría hallazgos falsos' };
      // queda también como nota del paso: sin hallazgos, un reporte no imprime nada más de él
      rec.note(`la línea de arranque lanzada por ${form.id}: la parte del enlace roto NO se midió — ${item.broken.not_measured}`);
      rec.fact('startup', facts);
      continue;
    }
    if (release) { item.broken = { not_applicable: 'la instalación es una versión bajada: el arranque encuentra el árbol por el estado del arnés aunque el enlace no resuelva, así que el respaldo no corre y romper el enlace no mide nada' }; rec.fact('startup', facts); continue; }
    const moved = [];
    let broken = links.length > 0;
    if (!broken) item.broken = { not_measured: `no hay enlace del arnés que romper (ni ~/.claude/${PLACE.PLACE_NAME} ni ~/.claude/${PLACE.LEGACY_PLACE_NAME})` };
    for (const link of links) {
      try { fs.renameSync(link, `${link}.off`); moved.push(link); } catch (e) { broken = false; item.broken = { not_measured: `no pude romper el enlace ${link} a propósito: ${e.code || e.message}` }; break; }
    }
    if (broken) item.broken_links = moved.map((p) => path.basename(p));
    try {
      if (broken) {
        item.broken = shoot(form, { TYCON_UPDATE: '0', TYCON_NO_AUTOINSTALL: '1' });
        item.broken.bootstrap_said_broken = item.broken.log_lines.some((l) => /bootstrap:/.test(l));
        item.broken.fallback_ran = item.broken.log_lines.some((l) => /respaldo en shell/.test(l));
        if (!item.broken.fallback_ran) rec.finding(`startup:fallback-did-not-run:${form.id}`, 'startup-line', `con el enlace del arnés roto, la línea de arranque lanzada por ${form.id} no corrió el respaldo${item.broken.bootstrap_said_broken ? ' (bootstrap.js sí corrió y avisó que no arranca)' : ' (ni bootstrap.js dejó rastro)'}: salió ${item.broken.error || item.broken.exit}${L.firstLine(item.broken.err) ? ` — ${L.firstLine(item.broken.err)}` : ''}`, 'W5');
      }
    } finally {
      for (const link of moved) {
        try { fs.renameSync(`${link}.off`, link); } catch (e) { item.restore_problem = e.code || e.message; rec.note(`no pude reponer el enlace ${link} después de romperlo: ${e.code || e.message}`); }
      }
    }
    rec.fact('startup', facts);
  }
  facts.link_restored = links.every((p) => fs.existsSync(p));
  facts.settings_changed = settingsBefore !== sha(settingsFile);
  rec.fact('startup', facts);
}

// ── el paso ──────────────────────────────────────────────────────────────────────────────────────────────────────

function measure({ lab, platform = process.platform, baseEnv = process.env, rec }) {
  let state;
  try { state = readJson(path.join(lab, 'lab-state.json')); } catch (_) { state = null; }
  const variant = state && state.measured_variant;
  if (!variant) return { status: L.STATUS.notMeasured, reason: 'ninguna instalación dejó un settings.json con hooks que disparar (ver el paso install)' };
  const problem = L.labHomeProblem(variant.home, { labRoot: lab, platform, allowTemp: Boolean(state.allow_temp) });
  if (problem) return { status: L.STATUS.error, reason: `no pude medir: ${problem}` };
  let settings;
  try { settings = readJson(variant.settings); } catch (e) { return { status: L.STATUS.error, reason: `no pude medir: no pude leer ${variant.settings}: ${e.message}` }; }
  rec.setRedactor(L.redactor({ publicUrl: (L.readCover(variant.clone, { fence: 'bash' }) || {}).url, secrets: L.secretValues(baseEnv) }));
  const env = L.labEnv(variant.home, { base: baseEnv, extra: Object.assign({}, variant.env || {}, { TYCON_THIRD_PARTY: '0' }), platform });
  if (variant.path_first) { const k = L.pathKey(env); env[k] = `${variant.path_first}${path.delimiter}${env[k] || ''}`; }
  const seen = L.run(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env, timeoutMs: 30000, cap: 600 });
  if (seen.exit !== 0 || !L.samePath(L.realOrSelf(seen.stdout.trim()), L.realOrSelf(variant.home), platform)) return { status: L.STATUS.error, reason: `no pude medir: os.homedir() devuelve «${seen.stdout.trim()}», no la carpeta de laboratorio` };

  const scratch = path.join(lab, 'scratch');
  const bashes = L.scanPath('bash', { env: baseEnv, platform });
  const gitBash = L.findGitBash({ platform, env: baseEnv, gitLocations: L.scanPath('git', { env: baseEnv, platform }), bashLocations: bashes }).path;
  const pwsh = L.scanPath('pwsh', { env: baseEnv, platform })[0] || null;
  const forms = shellForms({ platform, gitBash, firstBash: bashes[0] || null, pwsh, scratch });
  rec.fact('variant', variant.id);
  rec.fact('forms', forms.map((f) => ({ id: f.id, shell: f.shell, sample: Boolean(f.sample) })));
  if (!gitBash) rec.note('no hay bash de Git: las formas bash-c y bash-file no se midieron');
  // Qué `bash` ve un hook registrado como `bash "<guion>"` cuando lo lanza el bash de Git, que es como lanza Claude
  // Code en Windows. Queda anotado, no supuesto: si ahí `bash` resolviera a otro (el lanzador de WSL), un freno `.sh`
  // registrado así no correría. En Windows se anota además la ruta de Windows de ese bash.
  if (gitBash) {
    const seenBash = L.run(gitBash, ['-c', 'command -v bash'], { env, timeoutMs: 30000, cap: 600 });
    const fact = { exit: seenBash.exit, path: seenBash.stdout.trim() || null };
    if (L.isWin(platform) && fact.path) {
      const asWindows = L.run(gitBash, ['-c', 'cygpath -w "$(command -v bash)"'], { env, timeoutMs: 30000, cap: 600 });
      fact.windows_path = asWindows.exit === 0 ? asWindows.stdout.trim() : null;
      fact.is_git_bash = fact.windows_path ? /\\Git\\/i.test(fact.windows_path) : null;
    }
    rec.fact('bash_seen_by_hooks', fact);
  }
  if (!pwsh) rec.note('no hay pwsh: las formas pwsh-command y pwsh-file no se midieron');

  const all = C.registeredHooks(settings);
  const hooks = all.filter((h) => !h.startup_line);
  const cases = benchCases(path.join(variant.clone, 'scripts', 'controls-bench', 'cases', 'hooks'), platform);
  if (!cases) rec.note('el clon no trae los casos del banco de controles: sólo se disparó la entrada legítima de cada hook');
  rec.fact('hooks_fired', hooks.length);
  process.stdout.write(`fire-registered: ${hooks.length} hooks × ${forms.length} formas (${forms.map((f) => f.id).join(', ')})\n`);
  // Cada parte por separado: si una se cae, las otras se miden igual y lo que anotó queda. El paso sale «error» y dice cuál.
  const broke = [];
  const part = (name, fn) => { try { fn(); } catch (e) { broke.push(`${name} tiró: ${e.message}`); } };
  part('el disparo de los hooks', () => measureHooks({ hooks, forms, cases, home: variant.home, clone: variant.clone, skills: variant.skills || null, scratch, env, platform, rec }));
  part('los frenos en bash', () => measureBashBrakes({ clone: variant.clone, gitBash, cases, home: variant.home, scratch, env, platform, rec }));
  // al final: la línea de arranque vuelve a correr el aplicador, y nada de lo anterior tiene que medirse después de eso
  part('la línea de arranque', () => measureStartup({ line: all.find((h) => h.startup_line) || null, forms, home: variant.home, clone: variant.clone, env, rec }));
  if (broke.length) return { status: L.STATUS.error, reason: `no pude medir: ${broke.join(' · ')}` };
  return { status: L.STATUS.measured, reason: null };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`fire-registered.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`fire-registered.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, rec }); } catch (e) { result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` }; }
  rec.finish(result.status, result.reason);
  process.stdout.write(`fire-registered: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, BLOCK_RX, hookName, payload, genericInput, benchCases, shellForms, fire, installedAsRelease, measureStartup, measure };
