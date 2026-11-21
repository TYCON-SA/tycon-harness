#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * project-stories.js — los pendientes de cada proyecto donde trabajaste esta semana, para la oficina.
 * Casos: scripts/tests/office-project-stories.test.js y scripts/tests/office-project-stories-live.smoke.js
 *
 *   node project-stories.js --refresh             lee y deja <estado>/office/project-stories.json (con candado)
 *   node project-stories.js --refresh-if-moved    relee sólo si la rama principal de algún proyecto se movió
 *
 * Cada proyecto trae también `abiertas` (las historias de los grupos «backlog», «en curso» y «bloqueado», con su archivo y
 * su estado, de donde la oficina saca el número de abiertas), `remoto`, `lugar` y `commit` (el commit leído de la rama
 * principal, null si se leyó de la copia).
 *
 * Qué proyectos: un repo donde abriste una sesión de Claude o de Codex, o donde hiciste un commit propio, en los
 * últimos 7 días (WORK_DAYS). Tener el clon no cuenta, ni una ejecución automática.
 *
 * Dónde están sus historias: projectStoryPlaces de story-without-bmad.js, los mismos lugares que mira el arnés al crear
 * una historia; si no da ninguno, el repo trabajado que lo nombra en evidence.companion_repos, comparado por su remoto.
 * Se leen de la rama principal traída (origin/HEAD, origin/main u origin/master), no de la copia de trabajo; sin
 * ninguna, de la copia, y se dice. Entran las del grupo «en curso» del vocabulario de estados y las listas para
 * programar.
 *
 * No sale a la red ni escribe en ningún clon: sólo lee (rev-parse, log, ls-tree, cat-file) y la hora del FETCH_HEAD.
 * Quién tiene cada historia no se guarda acá: lo dice la oficina al armar su foto, con las ejecuciones de esta máquina
 * (runsOfThisMachine, whoOf), porque este archivo puede tener media hora.
 *
 * Cada proyecto trae `repos` (el remoto del lugar y los de los repos trabajados que leen de ahí), y cada historia que
 * declara `depends_on:` trae `pendientes` con lo que todavía no está en `done` ni en revisión en ese mismo lugar (sin
 * rama principal traída, todo lo declarado queda pendiente: lo leído es de la copia), y `pausa` con la fecha de
 * `paused_until:` si la tiene. Lo lee el freno del cierre del turno de la coordinadora (scripts/tools/coordination.js
 * `fillCheck`); la oficina no muestra esos campos.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
// los lugares de las historias los dice la pieza de crear historias; se carga recién al leer, no cuando la oficina carga esto
const swb = () => require(path.join(ROOT, 'skills', 'tycon-create-story', 'scripts', 'story-without-bmad.js'));
const STATES = require(path.join(ROOT, 'scripts', 'metrics', 'states.json'));
const wip = () => require(path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js'));
const evidence = () => require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'evidence-config.js'));

const WORK_DAYS = 7;
const DAY_MS = 24 * 3600e3;
const GIT_MS = 8000;
const COMMITS_MS = 20000;
const LOCK_MS = 5 * 60e3;
const RUNS_MS = DAY_MS;
// cómo se abrió una conversación que no abrió una persona
const AUTOMATIC = new Set(['sdk-cli', 'codex_exec']);
// lo que entra: el grupo «en curso» del vocabulario y las listas para programar (la única constante)
const READY = 'ready-for-dev';
const ENTER = new Set([...STATES.groups.en_curso, READY]);
// lo que cuenta como abierta: los grupos «backlog», «en curso» y «bloqueado» del vocabulario (borradores incluidos)
const OPEN = new Set([...STATES.groups.backlog, ...STATES.groups.en_curso, ...STATES.groups.bloqueado]);
// Una dependencia está resuelta con su historia cerrada o en revisión (en `main`: varias quedan en revisión por el papeleo
// de cierre). La revisión se nombra por su alias del vocabulario: el canónico escrito a mano lo frena la prueba de la oficina.
const RESOLVED = new Set([...STATES.groups.cerrado, STATES.alias['ready-for-review']].filter(Boolean));
const BRANCHES = ['origin/HEAD', 'origin/main', 'origin/master'];

/** El estado canónico de un valor del encabezado, o null si el vocabulario no lo conoce. */
function canonical(v) {
  const s = String(v || '').trim().toLowerCase();
  if (STATES.canonical.includes(s)) return s;
  return STATES.alias[s] || null;
}

/** Un git que sólo lee: `(cwd, args, { timeout, input, buffer })` → `{ ok, out, err, timedOut }`. */
function gitRunner() {
  return (cwd, args, { timeout = GIT_MS, input, buffer = false } = {}) => {
    const o = { cwd, timeout, input, windowsHide: true, maxBuffer: 256 * 1024 * 1024 };
    if (!buffer) o.encoding = 'utf8';
    const r = spawnSync('git', ['-c', 'maintenance.auto=false', ...args], { windowsHide: true, ...o });
    return { ok: !r.error && r.status === 0, out: buffer ? r.stdout : String(r.stdout || ''), err: r.error ? r.error.message : String(r.stderr || '').trim(), timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT') };
  };
}

/** Las carpetas donde la persona abrió una sesión de Claude o de Codex desde `since`, de la cabeza de cada conversación. */
function sessionFolders(home, since, env = process.env) {
  const out = new Set();
  const look = (f) => {
    let head;
    try {
      if (fs.statSync(f).mtimeMs < since) return;
      const fd = fs.openSync(f, 'r');
      const b = Buffer.alloc(65536);
      const n = fs.readSync(fd, b, 0, b.length, 0);
      fs.closeSync(fd);
      head = b.slice(0, n).toString('utf8').split('\n');
    } catch { return; }
    let cwd = null;
    let how = null;
    for (const l of head) {
      let j;
      try { j = JSON.parse(l); } catch { continue; }
      const p = j.payload || {};
      cwd = cwd || p.cwd || j.cwd || null;
      how = how || j.entrypoint || p.originator || null;
      if (cwd && how) break;
    }
    if (cwd && !AUTOMATIC.has(how)) out.add(cwd);
  };
  const walk = (d) => {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) look(p);
    }
  };
  // en las de Claude, las conversaciones de los subagentes viven más abajo y no son sesiones
  const projects = path.join(home, '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch { /* sin Claude en esta máquina */ }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(projects, d)); } catch { continue; }
    for (const n of names) if (n.endsWith('.jsonl')) look(path.join(projects, d, n));
  }
  walk(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'));
  return out;
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

/** El repo de una carpeta: `{ root, common }`, con la raíz del checkout principal (los worktrees son el mismo repo). */
function repoOfFolder(folder, run) {
  if (!folder || !fs.existsSync(folder)) return null;
  const c = run(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!c.ok) return null;
  const common = real(c.out.trim());
  if (!common) return null;
  if (path.basename(common) === '.git') return { root: path.dirname(common), common };
  const t = run(folder, ['rev-parse', '--show-toplevel']);
  return t.ok ? { root: real(t.out.trim()), common } : null;
}

/** La identidad de un repo por su remoto (sólo si se reconoce), o null. */
function remoteKey(folder) {
  let q = null;
  try { q = wip().remoteOfFolder(folder); } catch { return null; }
  if (!q || !q.kind) return null;
  const id = wip().identityOf(q);
  return [id.platform, id.org, id.project, id.repo].filter(Boolean).join('/').toLowerCase();
}

/** Los repos con un commit propio desde `since`, recorriendo las raíces de repos a uno y dos niveles. */
function ownCommitRepos({ roots, rootsProblem, email, since, run, budgetMs = COMMITS_MS }) {
  if (!roots) return { repos: [], medido: false, motivo: rootsProblem || 'sin raíz de repos' };
  if (!email) return { repos: [], medido: false, motivo: 'sin el correo de git de la persona' };
  const t0 = Date.now();
  const folders = [];
  for (const r of roots) {
    let a;
    try { a = fs.readdirSync(r, { withFileTypes: true }); } catch { continue; }
    for (const e of a) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const d = path.join(r, e.name);
      if (fs.existsSync(path.join(d, '.git'))) { folders.push(d); continue; }
      let b;
      try { b = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const f of b) if (f.isDirectory() && !f.name.startsWith('.') && fs.existsSync(path.join(d, f.name, '.git'))) folders.push(path.join(d, f.name));
    }
  }
  const seen = new Set();
  const repos = [];
  let left = 0;
  for (const f of folders) {
    if (Date.now() - t0 > budgetMs) { left += 1; continue; }
    const r = repoOfFolder(f, run);
    if (!r || seen.has(r.common)) continue;
    seen.add(r.common);
    const log = run(r.root, ['log', '--all', `--since=@${Math.floor(since / 1000)}`, `--author=${email}`, '-1', '--format=%h']);
    if (log.ok && log.out.trim()) repos.push(r);
  }
  return left ? { repos, medido: false, motivo: `no llegué a mirar ${left} carpetas en ${budgetMs / 1000} s` } : { repos, medido: true, motivo: null };
}

/** Los repos de los proyectos de la persona: `{ repos: [{ root, common }], ownCommits }`. */
function projectsOf({ home = os.homedir(), now = Date.now(), env = process.env, email, roots, rootsProblem, git } = {}) {
  const run = git || gitRunner();
  const since = now - WORK_DAYS * DAY_MS;
  const seen = new Map();
  for (const f of sessionFolders(home, since, env)) {
    const r = repoOfFolder(f, run);
    if (r && !seen.has(r.common)) seen.set(r.common, r);
  }
  const own = ownCommitRepos({ roots, rootsProblem, email, since, run });
  for (const r of own.repos) if (!seen.has(r.common)) seen.set(r.common, r);
  return { repos: [...seen.values()], ownCommits: { medido: own.medido, motivo: own.motivo } };
}

/** Dónde están las historias de un repo trabajado: sus lugares, o los del repo trabajado que lo nombra como compañero. */
function placesFor(repo, worked = []) {
  const own = swb().projectStoryPlaces(repo);
  if (own.problem || own.places.length) return own;
  const mine = remoteKey(repo);
  const me = real(repo);
  for (const w of worked) {
    if (!w || !w.root || real(w.root) === me) continue;
    let cfg;
    try { cfg = evidence().parseEvidenceConfig(w.root); } catch { continue; }
    const names = (cfg.roots || []).some((r) => real(r) === me || (mine && fs.existsSync(r) && remoteKey(r) === mine));
    if (!names) continue;
    const theirs = swb().projectStoryPlaces(w.root);
    if (theirs.places.length) return { places: theirs.places, problem: null };
  }
  return { places: [], problem: null };
}

/** Un valor del encabezado: sin comillas y sin el comentario de un valor sin comillas. */
function scalar(fm, key) {
  const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(fm);
  if (!m) return null;
  let v = m[1].trim();
  const q = /^(['"])(.*)\1(\s+#.*)?$/.exec(v);
  v = q ? q[2] : v.replace(/\s+#.*$/, '').trim();
  return v || null;
}

// El comentario de un valor sin comillas (`[]  # no espera a otra`) se saca antes de leer la lista, como hace `scalar`.
const uncommented = (v) => String(v).replace(/\s+#.*$/, '').trim();
const unquoted = (v) => String(v).trim().replace(/^(['"])(.*)\1$/, '$2').trim();

// `null`, `~` y vacío son el nulo de YAML: ni una dependencia ni una lista
const yamlNull = (v) => v === '' || v === '~' || /^null$/i.test(v);

/**
 * La lista de `depends_on:` del encabezado: en la misma línea (`["8.9", "8.12"]`, también `[]`) o con guiones debajo;
 * `null` si no la declara. El bloque de guiones llega hasta la próxima clave de primer nivel (el mismo lector que
 * `followup_of:`, scripts/lib/followup-of.js): los guiones van con o sin sangría, y un comentario o un renglón vacío en
 * el medio no lo corta; los finales de línea de Windows se leen igual. Lo que no se entiende (una lista sin cerrar, un
 * valor suelto, un renglón del bloque que no es un item) queda como texto: cuenta pendiente.
 */
function dependsList(fm) {
  const text = String(fm).replace(/\r\n?/g, '\n');
  const m = /^depends_on[ \t]*:(.*)$/m.exec(text);
  if (!m) return null;
  const value = uncommented(m[1]);
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) return [value];
    return value.slice(1, -1).split(',').map(unquoted).filter((x) => !yamlNull(x));
  }
  if (value !== '') return yamlNull(unquoted(value)) ? [] : [unquoted(value)];
  // si el lector del bloque no se puede cargar, la dependencia queda pendiente con el motivo: no se cae la lectura entera
  let body;
  try { body = require(path.join(ROOT, 'scripts', 'lib', 'followup-of.js')).cuerpoBloque(text.slice(m.index + m[0].length)); } catch (e) { return [`depends_on sin leer (${e.code || e.message})`]; }
  const out = [];
  for (const line of body.split('\n')) {
    if (!line.trim() || /^[ \t]*#/.test(line)) continue;
    const it = /^[ \t]*-[ \t]*(.*)$/.exec(line);
    if (!it) return [line.trim()];
    const item = unquoted(uncommented(it[1]));
    if (item && !yamlNull(item)) out.push(item);
  }
  return out;
}

/** La fecha de `paused_until:` (AAAA-MM-DD), o null. */
function pausedDate(fm) {
  const m = /^(\d{4}-\d\d-\d\d)/.exec(scalar(fm, 'paused_until') || '');
  return m ? m[1] : null;
}

/**
 * Lo que dice una historia: `{ story, dependsOn, abierta }` si entra como tarjeta, `{ out: true, id, estado }` si no entra
 * (su número y su estado resuelven las dependencias de las que sí entran; si está abierta, trae además `abierta` y
 * `dependsOn`), `{ unread: true }` si dice ser historia y no se puede leer, o null si no es una historia (un .md sin
 * `story:` en el encabezado). `abierta` es lo que cuenta el número de abiertas: `{ id, archivo, estado, pausa? }`.
 */
function parseStory(text, archivo) {
  // un archivo guardado con BOM sigue siendo una historia
  const t = String(text || '').replace(/^﻿/, '');
  if (!t.startsWith('---')) return null;
  const end = t.indexOf('\n---', 3);
  if (end < 0) return /^story\s*:/m.test(t.slice(0, 4000)) ? { unread: true } : null;
  const fm = t.slice(3, end);
  const id = scalar(fm, 'story');
  if (!id) return null;
  const estado = canonical(scalar(fm, 'status'));
  if (!estado) return { unread: true };
  const numero = id.replace(/\s+#.*$/, '');
  if (!OPEN.has(estado)) return { out: true, id: numero, estado };
  const pausa = pausedDate(fm);
  const abierta = { id: numero, archivo, estado, ...(pausa ? { pausa } : {}) };
  if (!ENTER.has(estado)) return { out: true, id: numero, estado, abierta, dependsOn: dependsList(fm) };
  const story = { id: numero, archivo, titulo: scalar(fm, 'title'), estado, prioridad: scalar(fm, 'priority'), trabajo: scalar(fm, 'work_item') };
  if (pausa) story.pausa = pausa;
  return { story, dependsOn: dependsList(fm), abierta };
}

/** La rama principal traída y su commit: la primera que existe de origin/HEAD, origin/main y origin/master; null si ninguna. */
function mainRef(repo, run) {
  for (const b of BRANCHES) {
    const r = run(repo, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`]);
    if (r.ok) return { ref: b, commit: r.out.trim() };
  }
  return null;
}

/** La hora del FETCH_HEAD más nuevo del repo: el de la carpeta común y el de cada worktree. */
function fetchedAt(common) {
  const files = [path.join(common, 'FETCH_HEAD')];
  try { for (const w of fs.readdirSync(path.join(common, 'worktrees'))) files.push(path.join(common, 'worktrees', w, 'FETCH_HEAD')); } catch { /* sin worktrees */ }
  let best = 0;
  for (const f of files) { try { best = Math.max(best, fs.statSync(f).mtimeMs); } catch { /* no está */ } }
  return best ? new Date(best).toISOString() : null;
}

/** Los .md de una carpeta de la copia de trabajo, recorriéndola entera. */
function workingMarkdown(dir, depth = 0, out = []) {
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 8) workingMarkdown(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * Las historias de un lugar: `{ historias, abiertas, sinLeer, traidoAt, deTuCopia, commit, ref, problem }`, sin tocar la
 * copia. `commit` y `ref` son los de la rama principal leída; leído de la copia, los dos son null.
 */
function readPlace(place, run) {
  const r = repoOfFolder(place.repo, run);
  if (!r) return { problem: 'no es un repo de git' };
  const rel = path.relative(place.repo, place.dir).split(path.sep).join('/');
  const historias = [];
  const abiertas = [];
  // las dependencias declaradas y el estado de TODAS las historias leídas: resuelven `pendientes` y no se guardan
  const declared = [];
  const estados = new Map();
  let sinLeer = 0;
  const add = (text, archivo) => {
    const s = parseStory(text, archivo);
    if (!s) return;
    if (s.unread) { sinLeer += 1; return; }
    const deps = Array.isArray(s.dependsOn) && s.dependsOn.length ? s.dependsOn : null;
    if (s.abierta) {
      abiertas.push(s.abierta);
      if (deps) declared.push([s.abierta, deps]);
    }
    if (s.out) { estados.set(String(s.id), s.estado); return; }
    estados.set(String(s.story.id), s.story.estado);
    historias.push(s.story);
    if (deps) declared.push([s.story, deps]);
  };
  const main = mainRef(place.repo, run);
  const ref = main ? main.ref : null;
  if (ref) {
    // con -z git no pone comillas ni escapes a los nombres con tildes o ñ; la raíz del repo se pide como «.»
    const ls = run(place.repo, ['ls-tree', '-r', '-z', ref, '--', rel ? `${rel}/` : '.']);
    if (!ls.ok) return { problem: ls.timedOut ? 'git no contestó a tiempo' : `git ls-tree: ${ls.err}` };
    const blobs = ls.out.split('\0').map((l) => /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(l)).filter((m) => m && m[2].endsWith('.md')).map((m) => ({ sha: m[1], archivo: path.posix.basename(m[2]) }));
    if (blobs.length) {
      const cat = run(place.repo, ['cat-file', '--batch'], { input: `${blobs.map((b) => b.sha).join('\n')}\n`, buffer: true });
      if (!cat.ok) return { problem: cat.timedOut ? 'git no contestó a tiempo' : `git cat-file: ${cat.err}` };
      let i = 0;
      const buf = cat.out;
      for (const b of blobs) {
        const nl = buf.indexOf(10, i);
        if (nl < 0) break;
        const size = Number(buf.slice(i, nl).toString('utf8').split(' ')[2]);
        add(buf.slice(nl + 1, nl + 1 + size).toString('utf8'), b.archivo);
        i = nl + 1 + size + 1;
      }
    }
  } else {
    for (const f of workingMarkdown(place.dir)) { try { add(fs.readFileSync(f, 'utf8'), path.basename(f)); } catch { sinLeer += 1; } }
  }
  // sin rama principal traída, lo leído es de la copia y no confirma nada en main: toda dependencia declarada queda pendiente
  for (const [story, deps] of declared) {
    const pendientes = ref ? deps.filter((d) => !RESOLVED.has(estados.get(String(d)))) : deps.slice();
    if (pendientes.length) story.pendientes = pendientes;
  }
  return { historias, abiertas, sinLeer, traidoAt: fetchedAt(r.common), deTuCopia: !ref, commit: main ? main.commit : null, ref, problem: null, common: r.common, root: r.root };
}

/** La lista de productos de la organización (la que elige configPorDefecto), plana: `[{ producto, ado?, github? }]`. */
function loadProducts() {
  try {
    const PP = require(path.join(ROOT, 'scripts', 'ci', 'check-product-parity.js'));
    const c = PP.configPorDefecto();
    if (!c.ruta) return [];
    const j = JSON.parse(fs.readFileSync(c.ruta, 'utf8'));
    const out = [];
    for (const g of Object.values(j.grupos || {})) {
      const n = PP.normalizarGrupo(g);
      for (const r of (n && n.repos) || []) if (r && typeof r === 'object' && r.producto) out.push(r);
    }
    return out;
  } catch { return []; }
}

/** El producto de un repo por su remoto, o null. */
function productOf(key, products) {
  if (!key) return null;
  const dec = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
  for (const p of products || []) {
    if (p.github && key === `github/${String(p.github).toLowerCase()}`) return p.producto;
    if (p.ado && key.startsWith('azure/') && key.endsWith(`/${dec(String(p.ado)).toLowerCase()}`)) return p.producto;
  }
  return null;
}

/** La lectura entera: `{ at, proyectos, sinHistorias, commitsPropios }`. */
function collect({ home = os.homedir(), now = Date.now(), env = process.env, email, roots, rootsProblem, products = [], git } = {}) {
  const run = git || gitRunner();
  const p = projectsOf({ home, now, env, email, roots, rootsProblem, git: run });
  const rows = new Map();
  const sinHistorias = [];
  for (const repo of p.repos) {
    const found = placesFor(repo.root, p.repos);
    if (found.problem || !found.places.length) { sinHistorias.push(path.basename(repo.root)); continue; }
    let any = false;
    for (const place of found.places) {
      const read = readPlace(place, run);
      if (read.problem) continue;
      any = true;
      const rel = path.relative(place.repo, place.dir).split(path.sep).join('/');
      const key = `${remoteKey(place.repo) || read.common}|${rel}`;
      const row = rows.get(key) || { key, remote: remoteKey(place.repo), repoName: path.basename(read.root), worked: new Set(), read, place };
      row.worked.add(remoteKey(repo.root));
      rows.set(key, row);
    }
    if (!any) sinHistorias.push(path.basename(repo.root));
  }
  const named = [...rows.values()].map((r) => ({ ...r, producto: productOf(r.remote, products) || [...r.worked].map((k) => productOf(k, products)).find(Boolean) || null }));
  const perProduct = new Map();
  for (const r of named) if (r.producto) perProduct.set(r.producto, (perProduct.get(r.producto) || 0) + 1);
  // todo proyecto leído entra, aunque no tenga nada abierto: su número de abiertas es 0, no «no lo leí». La tabla y el
  // kanban saltean los que no tienen tarjetas ni historias sin leer (`view`)
  const proyectos = named.map((r) => ({
    nombre: r.producto ? (perProduct.get(r.producto) > 1 ? `${r.producto} · ${r.repoName}` : r.producto) : r.repoName,
    traidoAt: r.read.traidoAt,
    deTuCopia: r.read.deTuCopia,
    sinLeer: r.read.sinLeer,
    // el remoto del lugar y los de los repos trabajados que leen de ahí: así el freno sabe de qué proyecto es cada historia
    repos: [...new Set([r.remote, ...r.worked].filter(Boolean))],
    // el remoto del lugar, para elegir el proyecto de la coordinadora; el lugar y el commit leído, para saber si main se
    // movió (el lugar es de esta máquina: la foto no lo copia)
    remoto: r.remote,
    lugar: { repo: r.place.repo, ref: r.read.ref, common: r.read.common },
    commit: r.read.commit,
    historias: r.read.historias,
    abiertas: r.read.abiertas,
  }));
  return { at: new Date(now).toISOString(), proyectos, sinHistorias: [...new Set(sinHistorias)], commitsPropios: p.ownCommits };
}

/**
 * Corre la lectura con candado y deja el archivo: `{ ran }`. Con un candado de menos de 5 minutos no corre; escribe
 * primero en un archivo aparte y lo renombra.
 */
function refresh({ stateDir, now = Date.now(), read }) {
  const dir = path.join(stateDir, 'office');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'project-stories.lock');
  try {
    if (now - fs.statSync(lock).mtimeMs < LOCK_MS) return { ran: false, why: 'otra lectura en curso' };
    fs.unlinkSync(lock);
  } catch (e) { if (e.code !== 'ENOENT') return { ran: false, why: e.message }; }
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch { return { ran: false, why: 'otra lectura en curso' }; }
  const out = path.join(dir, 'project-stories.json');
  const part = `${out}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(part, `${JSON.stringify(read(), null, 2)}\n`);
    fs.renameSync(part, out);
    return { ran: true };
  } finally {
    try { fs.unlinkSync(part); } catch { /* ya renombrado */ }
    try { fs.unlinkSync(lock); } catch { /* ya no está */ }
  }
}

/**
 * ¿Se movió la rama principal de algún proyecto desde la lectura guardada? Si sí (o no hay lectura), relee con `refresh`:
 * `{ ran, moved, why? }`. Un proyecto sin el campo `commit` o sin `lugar` (una lectura de antes del número de abiertas)
 * cuenta como movido; uno leído de la copia (`lugar.ref` null) no tiene con qué comparar y no cuenta; un repo que no
 * contesta tampoco, y los demás se comparan igual. Si la lectura nueva se cae, el error sube y queda el archivo anterior.
 */
function refreshIfMoved({ stateDir, read, git, now = Date.now() }) {
  const run = git || gitRunner();
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(path.join(stateDir, 'office', 'project-stories.json'), 'utf8')); } catch { /* sin lectura: se lee */ }
  const movedOne = (p) => {
    if (!p || !p.lugar || !('commit' in p)) return true;
    if (!p.lugar.ref) return false;
    const r = run(p.lugar.repo, ['rev-parse', '--verify', '--quiet', `${p.lugar.ref}^{commit}`]);
    return r.ok && r.out.trim() !== p.commit;
  };
  // se comparan todos, aunque uno ya se haya movido: así un repo que no contesta nunca frena a los demás
  const moved = !snap || !Array.isArray(snap.proyectos) || snap.proyectos.map(movedOne).some(Boolean);
  if (!moved) return { ran: false, moved: false, why: 'ninguna rama principal se movió' };
  return { ...refresh({ stateDir, now, read }), moved: true };
}

/**
 * Las ejecuciones de esta máquina: los marcadores de active/ (`activo: true`, con el `repoPath` de su ejecución) y los
 * cierres de timing-history/ de las últimas 24 h. Lo que no se pudo leer (una carpeta sin permiso, un archivo roto) va a
 * `problems` si quien llama lo pasa: el freno del cierre del turno no cuenta ninguna historia con una corrida en duda.
 */
function runsOfThisMachine({ stateDir, now = Date.now(), problems = null }) {
  const out = [];
  const doubt = (what) => { if (problems) problems.push(what); };
  const take = (m, activo = false) => { if (m && m.storyPath) out.push({ archivo: path.basename(String(m.storyPath)), sessionId: m.sessionId || null, ...(activo ? { activo: true, repoPath: m.repoPath ? String(m.repoPath) : null } : {}) }); };
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { doubt(`la ejecución ${path.basename(f)} (${e.code || 'rota'})`); return null; } };
  try { for (const f of fs.readdirSync(path.join(stateDir, 'active'))) if (f.endsWith('.json')) take(read(path.join(stateDir, 'active', f)), true); } catch (e) { if (e.code !== 'ENOENT') doubt(`las ejecuciones de active/ (${e.code || e.message})`); }
  const hist = path.join(stateDir, 'timing-history');
  let names = [];
  try { names = fs.readdirSync(hist); } catch (e) { if (e.code !== 'ENOENT') doubt(`los cierres de timing-history/ (${e.code || e.message})`); }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try { if (now - fs.statSync(path.join(hist, f)).mtimeMs > RUNS_MS) continue; } catch { continue; }
    const j = read(path.join(hist, f));
    take(j && j.marker);
  }
  return out;
}

/** La ejecución de esta máquina de una historia, por el nombre de su archivo (no por su número). */
const runOf = (story, runs) => runs.find((r) => r.archivo === story.archivo) || null;

/** Quién tiene una historia: la sesión de su ejecución en esta máquina, o «sin asignar». */
function whoOf(story, runs, { nameOf = () => null } = {}) {
  const r = runOf(story, runs);
  return r ? `${nameOf(r.sessionId) || r.sessionId || 'una sesión'}, en esta máquina` : 'sin asignar';
}

// Una lectura de más de una hora no se muestra: una historia pudo terminar desde entonces.
const STALE_MS = 3600e3;
const NOT_READ = 'No pude leer los pendientes de tus proyectos';
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SECTION = 'De tus proyectos';
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** La última lectura de fondo, si sirve: `{ snap, nota }`. Sin archivo, rota o de más de una hora, `snap` es null y `nota` lo dice. */
function readSnapshot(stateDir, now = Date.now()) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(stateDir, 'office', 'project-stories.json'), 'utf8')); } catch { /* sin lectura */ }
  const at = j ? Date.parse(j.at) : NaN;
  if (!j || !Array.isArray(j.proyectos) || !Number.isFinite(at)) return { snap: null, nota: NOT_READ };
  if (now - at > STALE_MS) return { snap: null, nota: `Los pendientes de tus proyectos se leyeron a las ${hhmm(at)}: hace más de una hora, no los muestro` };
  return { snap: j, nota: null };
}

const ago = (ms) => {
  const min = Math.max(1, Math.round(ms / 60e3));
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
};
const priorityRank = (s) => { const i = PRIORITIES.indexOf(String(s.prioridad || '').toUpperCase()); return i < 0 ? PRIORITIES.length : i; };
const byNumber = (a, b) => {
  const x = String(a.id).split('.'); const y = String(b.id).split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (Number(x[i]) || 0) - (Number(y[i]) || 0);
    if (d) return d;
  }
  return String(a.id).localeCompare(String(b.id));
};
const inOrder = (list) => [...list].sort((a, b) => priorityRank(a) - priorityRank(b) || byNumber(a, b));
/**
 * Lo que la oficina dibuja de la lectura, sin leer nada: `{ cards, rows, pie }`. `cards`, las tarjetas de «Sin sesión» (las
 * historias sin ejecución en esta máquina y sin una fila abierta del tablero que las nombre); `rows`, una fila por proyecto
 * para «Pendientes»; `pie`, lo que la tabla dice abajo. Todo va con `local: true`: es de esta máquina y no viaja al sitio.
 * `wordOf` dice el estado en palabras: las pone la oficina, que es la que habla.
 */
function view({ snap, nota = null, runs = [], filas = [], nameOf = () => null, wordOf = (e) => e, now = Date.now() }) {
  const howItGoes = (s) => [wordOf(s.estado), s.trabajo ? `pedido de trabajo ${s.trabajo}` : ''].filter(Boolean).join(' · ');
  const pie = nota ? [nota] : [];
  if (!snap) return { cards: [], rows: [], pie };
  const onBoard = new Set(filas.filter((f) => f.historia && f.estado !== 'hecho').map((f) => String(f.historia)));
  const cards = [];
  const rows = [];
  for (const p of snap.proyectos || []) {
    const hs = inOrder(p.historias || []);
    if (!hs.length && !p.sinLeer) continue;
    const mine = hs.filter((s) => runOf(s, runs)).length;
    const parts = [];
    if (mine) parts.push(`${mine} en esta máquina`);
    if (hs.length - mine) parts.push(`${hs.length - mine} sin asignar`);
    if (p.sinLeer) parts.push(p.sinLeer === 1 ? '1 no se pudo leer' : `${p.sinLeer} no se pudieron leer`);
    const fetched = Date.parse(p.traidoAt);
    if (p.deTuCopia) parts.push('de tu copia');
    else if (Number.isFinite(fetched)) parts.push(`traído ${ago(now - fetched)}`);
    const titles = hs.map((s) => s.titulo || s.archivo);
    const que = [...titles.slice(0, 2), ...(titles.length > 2 ? [`y ${titles.length - 2} más`] : [])].join('; ');
    rows.push({ grupo: p.nombre, que, col: parts.join(' · '), seccion: SECTION, local: true, trabajos: hs.map((s) => ({ numero: String(s.id), titulo: s.titulo || s.archivo, quien: whoOf(s, runs, { nameOf }), como: howItGoes(s) })) });
    for (const s of hs) if (!runOf(s, runs) && !onBoard.has(String(s.id))) cards.push(s);
  }
  for (const repo of snap.sinHistorias || []) pie.push(`En ${repo} no encontré sus historias`);
  return { cards: inOrder(cards).map((s) => ({ titulo: `${s.id} · ${s.titulo || s.archivo}`, quien: 'sin asignar', hora: '', grupo: 'Historias', nota: howItGoes(s), local: true })), rows, pie };
}

if (require.main === module) {
  const ifMoved = process.argv.includes('--refresh-if-moved');
  if (!ifMoved && !process.argv.includes('--refresh')) {
    process.stderr.write('uso: project-stories.js --refresh | --refresh-if-moved\n');
    process.exit(2);
  }
  const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const read = () => {
    let roots = null; let rootsProblem = null;
    try {
      const r = require(path.join(ROOT, 'scripts', 'lib', 'repos-root.js')).resolveReposRoot();
      roots = r.roots || (r.root ? [r.root] : null);
      if (!roots) rootsProblem = r.motivo || 'sin raíz de repos';
    } catch (e) { rootsProblem = `la raíz de repos no se pudo leer (${e.message})`; }
    // el correo de la persona sale de su configuración de git (una lectura, no del clon): sólo se pide al releer
    const email = gitRunner()(os.homedir(), ['config', '--global', 'user.email']).out.trim() || null;
    return collect({ email, roots, rootsProblem, products: loadProducts() });
  };
  try {
    const r = ifMoved ? refreshIfMoved({ stateDir: stateDir(os.homedir()), read }) : refresh({ stateDir: stateDir(os.homedir()), read });
    process.stdout.write(`${JSON.stringify(r)}\n`);
  } catch (e) {
    // la lectura nueva se cayó: queda la anterior, y la oficina lo dice por el código de salida
    process.stderr.write(`project-stories.js: la lectura no se pudo hacer (${e.message})\n`);
    process.exit(1);
  }
}

module.exports = { WORK_DAYS, READY, OPEN, gitRunner, sessionFolders, projectsOf, placesFor, remoteKey, parseStory, readPlace, collect, refresh, refreshIfMoved, runsOfThisMachine, runOf, whoOf, loadProducts, readSnapshot, inOrder, view, fetchedAt, ago };
