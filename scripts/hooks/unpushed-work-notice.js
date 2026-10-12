#!/usr/bin/env node
'use strict';
// unpushed-work-notice.js — "trabajo commiteado que no está en origin" (2026-08-25, caso de un producto del equipo,
// Story 1.1: el commit del backend quedó SOLO local — el push nunca se ejecutó — y el frontend
// que lo consume se promovió a main; el smoke de DoD dio verde contra ese backend local, así que
// ningún control preguntó "¿esto existe en el remoto?").
//
// QUÉ HACE (un script, tres eventos + un modo CLI — patrón retro-pending.js):
//   record (PostToolUse Bash):
//     · un `git ... commit` deja constancia del repo tocado (incluye `git -C <path>`) en el
//       ledger de sesión — es lo que el Stop-check consulta (el mtime del cwd NO ve commits
//       hechos con -C ni en worktrees; hallazgo EF-H4 de la ronda adversarial del plan).
//     · un `git push` que menciona main/master en un repo bajo el arnés → escanea el GRUPO de
//       repos EN ESE MOMENTO y grita si un hermano tiene trabajo sin subir — caza la promoción
//       hecha a mano, sin pasar por /tycon-merge-to-main (EF-H1).
//   stop (Stop): si esta sesión commiteó en algún repo (ledger) y ese repo quedó con commits no
//       alcanzables desde origin → decision:block UNA vez por repo+rama por sesión ("quedó sin
//       subir — ¿es WIP a propósito?"). La segunda vez deja pasar: un WIP legítimo no come spam
//       (RU-F2). Si la sesión pusheó a main, el chequeo cubre el grupo entero, no solo el cwd.
//       🔴 ATRIBUCIÓN POR SHA (2026-08-31): el ledger guarda el sha de cada commit hecho por la
//       sesión (solo si el asunto del commit aparece en el comando — un `git commit` que no
//       commiteó no adopta el HEAD ajeno) y los shas reescritos por rebase/pull/cherry-pick/merge
//       en repos donde ya commiteó; el `cd X && git …` se sigue por segmento. Un commit sin subir
//       que no es de la sesión se reporta como AJENO ("NO lo toques"), nunca como "esta sesión
//       commiteó"; si git no responde, "autoría indeterminada". Caso: el escaneo del grupo (tras
//       un push a main) encontró el commit local de OTRA sesión y el agente lo revirtió y pusheó
//       (incident-log#revert-cruzado-entre-sesiones-2026-08-31). Pase adversarial: hallazgos A-H
//       cerrados con caso rojo-previo en el banco (23-unpushed-notice.json).
//   notice (SessionStart): escanea el repo del cwd + su grupo. Lo NUEVO (repo+rama+tip nuevo) se
//       lista expandido; lo ya-gritado se comprime a UNA línea de conteo — la memoria de lo
//       avisado es por (repo,rama,sha): un commit NUEVO en una rama vieja re-grita SIEMPRE
//       (EF-H3: el throttle por rama tapaba justo el aviso que importaba). Silencio total en verde.
//   --scan <repo> [--json] (CLI): mismo análisis, para el step-00 de /tycon-merge-to-main y para
//       humanos. IGNORA el kill-switch a propósito (RU-F5: apagar el reminder ambiental no puede
//       apagar el control del merge en silencio); el JSON lleva `scanned:true` para que "verde"
//       sea distinguible de "no corrió".
//
// GRUPO DE REPOS: `.tycon/advisors.yaml → repo_group:` (lista, relativa al parent del repo o
// absoluta) manda. Fallback: hermanos (mismo parent, depth 1) que sean repos git con `.tycon/` o
// `.advisors/` — pero SOLO si el parent tiene ≤12 repos git (un contenedor general tipo
// una raíz de repos con ~70 repos acoplaría productos ajenos — RU-F3; FRESNO/ tiene ~9 y agrupa bien).
// Lo descartado se lista con motivo: un repo excluido en silencio es invisible justo cuando
// importa (EF-H2). Se excluyen agent-skills y el arnés (drift permanente por diseño) y
// los worktrees duplicados (dedup por git-common-dir). Quién es un repo del arnés lo dice su remoto
// `origin`, no la carpeta (2026-09-17, scripts/lib/harness-repo.js): por nombre de carpeta, un
// clon descartable del arnés NO quedaba excluido, y un repo de producto bajo una carpeta llamada
// el arnés quedaba afuera de este aviso sin que nada lo dijera.
//
// CRITERIO "SIN SUBIR": commits alcanzables desde ramas locales pero NO desde ningún ref de
// `origin` (el remoto canónico — un push a un remoto secundario/backup NO cuenta como subido,
// EF-H5). Sin fetch (barato y offline): los refs remotos locales pueden estar viejos — para el
// aviso alcanza; el gate del merge corre después del fetch del step 0.4. Repo sin remoto → quiet.
//
// LÍMITES HONESTOS (declarados, no silenciosos):
//   · Multi-máquina: un commit local en la máquina A es invisible desde la máquina B — este hook
//     solo protege donde el trabajo vive. El caso disparador ocurrió en UNA máquina.
//   · Commits en detached HEAD / rebase a medias no aparecen (se enumeran ramas).
//   · Un repo que excede el timeout se reporta como "no escaneado" — nunca se omite mudo (EF-H7).
// CARRIL (story 2.7): cada commit registrado anota además POR QUÉ CARRIL entró — `pipeline` si la
// sesión tiene una corrida viva (active/<sesión>.json, con su story), `adhoc` si declaró un atajo
// (adhoc/<sesión>.json), `ninguno` si no hay ninguno de los dos — en el registro de la sesión y en una
// constancia DURABLE, `carriles.jsonl`, que sube al buzón (story 2.5). Esa línea lleva {ts, carril,
// story} y nada más: ni ruta, ni sha, ni mensaje. Un commit hecho fuera de toda sesión no pasa por
// acá: no se ve, y la página lo dice como «no medido», nunca como cero. Sólo se anota un commit que
// de verdad se creó (sha conocido): «el comando dijo commit» no alcanza — por eso un commit cuyo
// asunto no aparece en el comando (`-F archivo`, `-m "$VAR"`) tampoco se ve, y también es no medido.
// Un atajo vencido (6 h, como el portón) no es carril; un commit hasta 3 h después de CERRAR la
// corrida de la sesión sigue siendo de esa corrida (el paso 8 cierra antes del commit).
// Off: TYCON_UNPUSHED_NOTICE=0 (solo modos hook; --scan lo ignora). Fail-open total.
const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { execFileSync } = require('child_process');
// Criterio ÚNICO de "repo del arnés", compartido con retro-pending.js y el portón de carril.
// Copiado al sandbox del banco junto con el hook (setups).
const { esRepoDelArnes } = require(path.join(__dirname, '..', 'lib', 'harness-repo.js'));

const STATE_DIR = path.join(stateDirOf(os.homedir()));
const STATE_FILE = path.join(STATE_DIR, 'unpushed-notice.json');
const MAX_PARENT_REPOS = 12;
const MAX_GROUP = 10;
const MAX_BRANCH_LINES = 8;
const GIT_TIMEOUT_MS = 3000;

function real(p) { try { return fs.realpathSync(p); } catch { return String(p); } }
function sessionIdOf(event) {
  return event.session_id || process.env.CLAUDE_CODE_SESSION_ID || process.env.TYCON_SESSION_ID || process.env.CODEX_SESSION_ID || '_nosession';
}
function git(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).trim(); }
  catch (e) { if (e && (e.signal || /ETIMEDOUT/.test(String(e.message)))) throw e; return ''; }
}
function gitSafe(cwd, args) { try { return git(cwd, args); } catch { return ''; } }
function isGitRepo(p) { return gitSafe(p, ['rev-parse', '--show-toplevel']) !== ''; }
function underHarness(root) { return esRepoDelArnes(root); }
function underArnes(root) {
  return fs.existsSync(path.join(root, '.tycon')) || fs.existsSync(path.join(root, '.advisors'));
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(s) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch { /* fail-open */ }
}
const FORMA_STORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,24}$/;
// Vencimientos: los MISMOS que usa el portón de carril (story-gate-io.js → STALE_HOURS) y la purga de
// marker.js. Si el portón da por vencido un atajo, para el carril tampoco existe (pase adversarial 2.7).
const ADHOC_VENCE_H = 6;
const MARKER_VENCE_H = 24;
// Un commit que llega poco después de CERRAR una corrida es de esa corrida: el paso 8 cierra el marker
// antes de que el dev apruebe el commit (pase adversarial 2.7, hallazgo 12).
const CIERRE_RECIENTE_H = 3;
const vencido = (o, horas) => {
  const t = Date.parse((o && (o.lastTouch || o.declaredAt)) || '');
  return Number.isFinite(t) && Date.now() - t > horas * 3600e3;
};
const storyValida = (x) => (typeof x === 'string' && FORMA_STORY.test(x) ? x : null);
/** La corrida de esta sesión que se cerró hace poco (del archivo de corridas), o null. Nunca tira. */
function corridaRecienCerrada(sid, key) {
  try {
    const dir = path.join(STATE_DIR, 'timing-history');
    const limite = Date.now() - CIERRE_RECIENTE_H * 3600e3;
    let mejor = null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const ruta = path.join(dir, f);
      let st; try { st = fs.statSync(ruta); } catch { continue; }
      if (st.mtimeMs < limite) continue;          // sólo los archivados hace poco: barato aunque haya cientos
      let d; try { d = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { continue; }
      const m = d && d.marker;
      const t = Date.parse((d && d.archivedAt) || '');
      if (!m || (m.sessionId !== sid && String(m.sessionId || '').replace(/[/\\]/g, '_') !== key)) continue;
      if (!Number.isFinite(t) || t < limite) continue;
      if (!mejor || t > mejor.t) mejor = { t, story: storyValida(m.storyId) };
    }
    return mejor;
  } catch { return null; }
}
/** El carril de la sesión al momento del commit (story 2.7). Nunca tira. */
function carrilDeSesion(sid) {
  const key = String(sid).replace(/[/\\]/g, '_');
  // «No existe» y «existe pero no se pudo leer» NO son lo mismo: el segundo no dice nada del carril, y
  // contarlo como `ninguno` pondría un commit hecho en plena corrida del lado de «fuera del pipeline».
  const ILEGIBLE = Symbol('ilegible');
  const leer = (dir) => {
    let texto;
    try { texto = fs.readFileSync(path.join(STATE_DIR, dir, `${key}.json`), 'utf8'); }
    catch (e) { return e && e.code === 'ENOENT' ? null : ILEGIBLE; }
    try { return JSON.parse(texto); } catch { return ILEGIBLE; }
  };
  const m = leer('active');
  if (m === ILEGIBLE) return { carril: 'ilegible', story: null };
  if (m && m.storyId && !vencido(m, MARKER_VENCE_H)) return { carril: 'pipeline', story: storyValida(m.storyId) };
  const a = leer('adhoc');
  if (a === ILEGIBLE) return { carril: 'ilegible', story: null };
  const atajo = a && a.reason && !vencido(a, ADHOC_VENCE_H) ? a : null;
  const cerrada = corridaRecienCerrada(sid, key);
  // Si hay las dos cosas, gana la más nueva: un atajo declarado DESPUÉS del cierre es otro trabajo.
  if (cerrada && (!atajo || Date.parse(atajo.declaredAt || atajo.lastTouch || '') < cerrada.t)) {
    return { carril: 'pipeline', story: cerrada.story };
  }
  if (atajo) return { carril: 'adhoc', story: null };
  return { carril: 'ninguno', story: null };
}
function ledgerFile(sid) { return path.join(STATE_DIR, `unpushed-commits-${String(sid).replace(/[/\\]/g, '_')}.jsonl`); }
function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

// ── grupo de repos ─────────────────────────────────────────────────────────────────────────────
function parseRepoGroup(root) {
  // Parser mínimo de `repo_group:` en .tycon/advisors.yaml — lista inline o con guiones.
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.tycon', 'advisors.yaml'), 'utf8'); } catch { return null; }
  const inline = text.match(/^repo_group:\s*\[([^\]]*)\]/m);
  if (inline) return inline[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const block = text.match(/^repo_group:\s*\n((?:\s+-\s+.*\n?)+)/m);
  if (block) return block[1].split('\n').map((l) => (l.match(/-\s+(.*)/) || [])[1]).filter(Boolean).map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  return null;
}
function groupOf(root) {
  const parent = path.dirname(root);
  const group = [{ path: root, why: 'repo actual' }];
  const discarded = [];
  const seen = new Set([real(gitSafe(root, ['rev-parse', '--git-common-dir']) ? path.resolve(root, gitSafe(root, ['rev-parse', '--git-common-dir'])) : root)]);
  const declared = parseRepoGroup(root);
  let source;
  if (declared) {
    source = 'repo_group declarado';
    for (const entry of declared) {
      const p = path.isAbsolute(entry) ? entry : path.join(parent, entry);
      if (!fs.existsSync(p)) { discarded.push({ path: p, reason: 'declarado en repo_group pero no existe acá' }); continue; }
      if (!isGitRepo(p)) { discarded.push({ path: p, reason: 'no es repo git' }); continue; }
      addRepo(p, 'repo_group');
    }
  } else {
    let entries = [];
    try { entries = fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(parent, d.name)); } catch { entries = []; }
    const gitSiblings = entries.filter((p) => fs.existsSync(path.join(p, '.git')));
    if (gitSiblings.length > MAX_PARENT_REPOS) {
      source = `sin repo_group y parent con ${gitSiblings.length} repos (>${MAX_PARENT_REPOS}) — solo el repo actual; declarar repo_group: en .tycon/advisors.yaml para agrupar`;
    } else {
      source = 'hermanos (mismo directorio padre)';
      for (const p of gitSiblings) {
        if (real(p) === real(root)) continue;
        if (underHarness(p)) { discarded.push({ path: p, reason: 'repo del arnés (excluido por diseño)' }); continue; }
        if (!underArnes(p)) { discarded.push({ path: p, reason: 'sin .tycon/ ni .advisors/ (no está bajo el arnés)' }); continue; }
        addRepo(p, 'hermano');
      }
    }
  }
  function addRepo(p, why) {
    if (group.length >= MAX_GROUP) { discarded.push({ path: p, reason: `cap de ${MAX_GROUP} repos` }); return; }
    const common = gitSafe(p, ['rev-parse', '--git-common-dir']);
    const key = real(common ? path.resolve(p, common) : p);
    if (seen.has(key)) { discarded.push({ path: p, reason: 'worktree del mismo repo (dedup)' }); return; }
    seen.add(key);
    group.push({ path: p, why });
  }
  return { source, repos: group, discarded };
}

// ── scan de un repo ────────────────────────────────────────────────────────────────────────────
function scanRepo(repoPath) {
  const out = { path: repoPath, scanned: false, branches: [] };
  try {
    const remotes = git(repoPath, ['remote']).split('\n').filter(Boolean);
    if (!remotes.length) { out.scanned = true; out.noRemote = true; return out; }
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    out.remote = remote;
    // 1 invocación para el "¿hay algo?"; el detalle por rama solo si dio positivo (EF-H7).
    const any = git(repoPath, ['log', '--branches', '--not', `--remotes=${remote}`, '--max-count=1', '--format=%H']);
    out.scanned = true;
    if (!any) return out;
    const refs = git(repoPath, ['for-each-ref', 'refs/heads', '--format=%(refname:short)\t%(objectname:short)\t%(contents:subject)']);
    for (const line of refs.split('\n').filter(Boolean)) {
      const [branch, tip, ...rest] = line.split('\t');
      const subject = rest.join('\t');
      const unpushed = git(repoPath, ['rev-list', '-1', branch, '--not', `--remotes=${remote}`]);
      if (!unpushed) continue;
      const count = Number(git(repoPath, ['rev-list', '--count', branch, '--not', `--remotes=${remote}`])) || 1;
      out.branches.push({ branch, tip, count, subject: subject.slice(0, 90), wip: /\bwip\b|\bparked\b/i.test(subject + branch) });
    }
  } catch (e) {
    out.error = /ETIMEDOUT|SIGTERM/.test(String(e && e.message)) ? 'timeout' : 'error git';
  }
  return out;
}
function scanGroup(root) {
  const g = groupOf(root);
  return { scanned: true, groupSource: g.source, repos: g.repos.map((r) => Object.assign(scanRepo(r.path), { why: r.why })), discarded: g.discarded };
}

// ── render del aviso (con memoria de lo ya gritado: clave repo|rama|tipSha) ────────────────────
function renderNotice(scan, state, opts) {
  const reported = state.reported || {};
  const fresh = []; let known = 0; const problems = [];
  for (const repo of scan.repos) {
    if (repo.error) { problems.push(`⚠ ${short(repo.path)}: no escaneado (${repo.error}) — indistinguible de verde NO es (correr --scan a mano)`); continue; }
    if (repo.noRemote || !repo.branches) continue;
    // TODAS las ramas entran a la memoria (también las que exceden el cap de líneas) — si no,
    // la línea de overflow re-gritaba para siempre en repos con >8 ramas crónicas.
    const nuevas = [];
    for (const b of repo.branches) {
      const key = `${real(repo.path)}|${b.branch}|${b.tip}`;
      if (reported[key] && !opts.expandAll) { known++; continue; }
      nuevas.push(b);
      reported[key] = { ts: new Date().toISOString() };
    }
    for (const b of nuevas.slice(0, MAX_BRANCH_LINES))
      fresh.push(`  - ${short(repo.path)} → ${b.branch} @ ${b.tip}: ${b.count} commit(s) que NO están en ${repo.remote}${b.wip ? ' (wip)' : ''} — "${b.subject}"`);
    if (nuevas.length > MAX_BRANCH_LINES) fresh.push(`  - ${short(repo.path)}: +${nuevas.length - MAX_BRANCH_LINES} rama(s) nuevas más — ver --scan`);
  }
  state.reported = prune(reported);
  return { fresh, known, problems };
}
function prune(reported) {
  // Retención 90 días: una clave vieja cuyo tip cambió ya no matchea; la que no cambió no re-grita.
  const cutoff = Date.now() - 90 * 86400000;
  const out = {};
  for (const [k, v] of Object.entries(reported)) if ((Date.parse(v.ts) || 0) >= cutoff) out[k] = v;
  return out;
}
function short(p) { return path.basename(path.dirname(p)) + '/' + path.basename(p); }
function scanCmd() { return `node ${path.join(__dirname, 'unpushed-work-notice.js')} --scan <repo>`; }

// ── modos ──────────────────────────────────────────────────────────────────────────────────────
function notice(event) {
  const cwd = event.cwd || process.cwd();
  const root = gitSafe(cwd, ['rev-parse', '--show-toplevel']);
  if (!root || underHarness(root) || !underArnes(root)) return;
  const scan = scanGroup(root);
  const state = loadState();
  const { fresh, known, problems } = renderNotice(scan, state, { expandAll: false });
  saveState(state);
  if (!fresh.length && !problems.length) return; // silencio en verde (lo conocido no re-grita solo)
  const lines = [...fresh, ...problems];
  if (known) lines.push(`  (+${known} rama(s) ya avisadas antes siguen sin subir — \`${scanCmd()}\` para verlas)`);
  // ⚠️ Este aviso corre en SessionStart, donde stdout SÍ se inyecta al contexto — acá stdout es
  // EL canal correcto (la revisión adversarial lo marcó como inerte junto a los de PostToolUse y
  // el banco cazó el error: exit 2 en SessionStart rompería el arranque de la sesión).
  process.stdout.write(`<system-reminder>\n🔴 trabajo sin subir (commits locales que no están en el remoto) — grupo: ${scan.groupSource}:\n${lines.join('\n')}\nSi es WIP a propósito, seguí; si es una entrega, el push falta. Off: TYCON_UNPUSHED_NOTICE=0 (no afecta el chequeo del merge).\n</system-reminder>\n`);
}

// Parsea un comando compuesto en invocaciones git: por segmento (| ; &&), tokenizando las
// opciones globales de git para que `-C <path>` (repo target) no se confunda con el `-C <sha>`
// de `git commit` (reuse-message) ni `git config commit.x` cuente como commit.
// Además lleva el cwd EFECTIVO por segmento: `cd X && git commit` es el patrón más común de los
// agentes (el cwd se resetea entre llamadas) y resolverlo con el cwd del evento anotaba el sha
// del repo EQUIVOCADO (hallazgo B de la revisión adversarial 2026-08-31).
function gitInvocations(cmd, baseCwd) {
  const out = [];
  let cur = baseCwd || process.cwd(); let prev = cur; const stack = [];
  const unq = (t) => String(t || '').replace(/^['"]|['"]$/g, '');
  for (const seg of String(cmd).split(/\|\||&&|[|;\n]/)) {
    const toks = seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (!toks.length) continue;
    if (toks[0] === 'cd' || toks[0] === 'pushd') {
      const arg = unq(toks[1]);
      let next;
      if (!arg || arg === '~') next = os.homedir();
      else if (arg === '-') next = prev;
      else next = path.resolve(cur, arg.replace(/^~(?=\/|$)/, os.homedir()));
      if (toks[0] === 'pushd') stack.push(cur);
      prev = cur; cur = next; continue;
    }
    if (toks[0] === 'popd') { if (stack.length) { prev = cur; cur = stack.pop(); } continue; }
    const gi = toks.findIndex((t) => t === 'git' || t.endsWith('/git'));
    if (gi < 0) continue;
    let i = gi + 1; let repoArg = null; let sub = null;
    while (i < toks.length) {
      const t = toks[i];
      if (t === '-C') { repoArg = unq(toks[i + 1]); i += 2; continue; }
      if (t === '-c' || t === '--exec-path' || t === '--git-dir' || t === '--work-tree') { i += 2; continue; }
      if (t.startsWith('-')) { i += 1; continue; }
      sub = t; break;
    }
    if (sub) out.push({ sub, repoArg, seg, cwd: cur });
  }
  return out;
}

// ¿HEAD es un commit que ESTE comando acaba de crear? Sin estado previo ("HEAD antes") se decide
// por el CONTENIDO: el asunto del commit de HEAD tiene que aparecer en el comando (`-m "…"`,
// heredoc `$(cat <<'EOF' …)`), o la última entrada del reflog es un `commit (amend)` reciente.
// Un `git commit` que NO commiteó (nada que commitear, pre-commit rechazado, exit enmascarado por
// `| tail`) NO puede anotar el HEAD actual: puede ser el commit AJENO del incidente — y "reciente"
// no alcanza para distinguirlo (en el incidente el commit ajeno tenía 3 minutos) — hallazgo A.
function freshCommitSha(root, cmd) {
  try {
    const what = git(root, ['reflog', '-1', '--format=%gs']);
    if (!/^commit\b/.test(what)) return null;
    const ct = Number(git(root, ['log', '-1', '--format=%ct'])) || 0;
    const ageOk = Math.abs(Date.now() / 1000 - ct) <= 600;
    const subject = git(root, ['log', '-1', '--format=%s']).trim();
    const subjectInCmd = subject.length >= 3 && String(cmd).includes(subject);
    const amend = /^commit \(amend\)/.test(what) && ageOk;
    if (!subjectInCmd && !amend) return null;
    return git(root, ['rev-parse', 'HEAD']) || null;
  } catch { return null; }
}
function unpushedShas(root, remote, ref) {
  return git(root, ['rev-list', ref, '--not', `--remotes=${remote}`]).split('\n').filter(Boolean);
}
const REWRITE_SUBS = new Set(['rebase', 'pull', 'cherry-pick', 'merge']);

function record(event) {
  const cmd = String((event.tool_input && event.tool_input.command) || '');
  if (!/\bgit\b/.test(cmd)) return;
  const cwd = event.cwd || process.cwd();
  const sid = sessionIdOf(event);
  for (const inv of gitInvocations(cmd, cwd)) {
    if (inv.sub !== 'commit' && inv.sub !== 'push' && !REWRITE_SUBS.has(inv.sub)) continue;
    const target = inv.repoArg || inv.cwd;
    const root = gitSafe(path.isAbsolute(target) ? target : path.resolve(inv.cwd, target), ['rev-parse', '--show-toplevel']);
    // Mismo gating que el notice: solo repos bajo el arnés (un Stop-block en un repo personal
    // que el arnés no mira en ningún otro lado sería ruido sin control que lo respalde).
    if (!root || underHarness(root) || !underArnes(root)) continue;
    if (inv.sub === 'commit') {
      try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        // El sha del commit recién hecho es lo que permite ATRIBUIR en el Stop (2026-08-31,
        // incident-log#revert-cruzado-entre-sesiones-2026-08-31): anotar solo el repo hacía que
        // un commit local de OTRA sesión en el mismo grupo se reportara como "esta sesión
        // commiteó" — y el agente lo revirtió y pusheó. `sha: null` = el comando dijo commit pero
        // no creó ninguno (distinto de una entrada legacy sin la clave, que se trata como propia).
        const ts = new Date().toISOString();
        const sha = freshCommitSha(root, cmd);
        const { carril, story } = carrilDeSesion(sid);
        fs.appendFileSync(ledgerFile(sid), JSON.stringify({ ts, repo: root, kind: 'commit', sha, carril, story }) + '\n');
        // La constancia durable, sin ruta ni sha: sube al buzón. Sólo si el commit existe.
        if (sha) fs.appendFileSync(path.join(STATE_DIR, 'carriles.jsonl'), JSON.stringify({ ts, carril, story }) + '\n');
      } catch { /* fail-open: la constancia es ayuda, no evidencia */ }
      continue;
    }
    if (REWRITE_SUBS.has(inv.sub)) {
      // rebase/pull --rebase/cherry-pick/merge REESCRIBEN los shas: el commit propio pasaría a
      // "ajeno" justo antes del push (hallazgo C). Solo si la sesión ya commiteó en ese repo, los
      // commits sin subir de HEAD siguen siendo suyos con otro sha.
      try {
        const mineHere = readJsonl(ledgerFile(sid)).some((e) => e.kind === 'commit' && real(e.repo) === real(root));
        if (!mineHere) continue;
        const remotes = git(root, ['remote']).split('\n').filter(Boolean);
        const remote = remotes.includes('origin') ? 'origin' : remotes[0];
        if (!remote) continue;
        const shas = unpushedShas(root, remote, 'HEAD');
        if (shas.length) fs.appendFileSync(ledgerFile(sid), JSON.stringify({ ts: new Date().toISOString(), repo: root, kind: 'rewrite', shas }) + '\n');
      } catch { /* fail-open */ }
      continue;
    }
    const branch = gitSafe(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const pushMain = /\bpush\b[^\n]*\b(main|master)\b/.test(inv.seg)
      || (/^(main|master)$/.test(branch) && !/\bpush\b[^\n]*\b(dev|develop|feat|feature|fix|hotfix|release)\b/.test(inv.seg));
    if (!pushMain) continue;
    try { fs.appendFileSync(ledgerFile(sid), JSON.stringify({ ts: new Date().toISOString(), repo: root, kind: 'push-main' }) + '\n'); } catch { /* fail-open */ }
    // Promoción en curso: escanear el grupo YA — este es el momento del incidente (EF-H1).
    const scan = scanGroup(root);
    const bad = scan.repos.filter((r) => (r.branches || []).length);
    const probs = scan.repos.filter((r) => r.error);
    if (!bad.length && !probs.length) continue;
    // Misma atribución que el Stop (hallazgo F): este aviso llega ANTES y es el que el agente lee
    // mientras todavía opera — sin la marca, el commit ajeno se presenta como "de la entrega".
    const ctx = mineContext(sid);
    const lines = bad.flatMap((r) => r.branches.slice(0, MAX_BRANCH_LINES).map((b) => `  - ${short(r.path)} → ${b.branch} @ ${b.tip}: ${b.count} commit(s) solo locales${b.wip ? ' (wip)' : ''} ${ownerTag(classifyBranch(r.path, b.branch, r.remote, ctx))}`))
      .concat(probs.map((r) => `  - ⚠ ${short(r.path)}: no escaneado (${r.error})`));
    // stderr + exit 2, no stdout (2026-08-27): en PostToolUse el stdout va SOLO al debug log — el
  // agente jamás lo veía. Canal documentado que sí llega al modelo: stderr con exit 2 (la
  // herramienta ya corrió; no bloquea nada, sólo hace visible el aviso). Mismo arreglo que
  // missing-path-notice; el hallazgo fue de la revisión adversarial del 35737a8.
  process.stderr.write(`🔴 estás promoviendo a main y hay trabajo SIN SUBIR en el grupo de repos (${scan.groupSource}) — ¿la entrega está completa? (caso FRESNO 2026-08-25: se promovió el front con el backend solo local):\n${lines.join('\n')}\nMostrale esto al dev ANTES de seguir.\n`);
    process.exit(2); // un aviso por comando alcanza — y por el único canal que el agente LEE
  }
}

function cleanOldLedgers() {
  try {
    const cutoff = Date.now() - 7 * 86400000;
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!/^unpushed-commits-.*\.jsonl$/.test(f)) continue;
      const fp = path.join(STATE_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch { /* fail-open */ }
    }
  } catch { /* fail-open */ }
}

function stop(event) {
  cleanOldLedgers();
  const sid = sessionIdOf(event);
  const entries = readJsonl(ledgerFile(sid));
  if (!entries.length) return;
  const repos = new Map();
  for (const e of entries) if (e.repo) repos.set(real(e.repo), e.repo);
  // Si la sesión pusheó a main, el chequeo cubre el grupo de ese repo (la sesión que solo mergea
  // no commitea — EF-H4.1).
  for (const e of entries.filter((x) => x.kind === 'push-main')) {
    for (const r of groupOf(e.repo).repos) repos.set(real(r.path), r.path);
  }
  // Atribución por sha (2026-08-31): los commits que ESTA sesión hizo son los del ledger. Un
  // commit sin subir que no está ahí es de otra sesión (o anterior al ledger): se avisa con otras
  // palabras y con la prohibición explícita de tocarlo —
  // incident-log#revert-cruzado-entre-sesiones-2026-08-31: el aviso decía "esta sesión commiteó" sobre un commit ajeno y el agente
  // lo revirtió y pusheó.
  const ctx = mineContext(sid);
  const state = loadState();
  const seen = state.stopSeen || {};
  const own = []; const foreign = []; const unknown = []; const problems = [];
  for (const repoPath of repos.values()) {
    const scan = scanRepo(repoPath);
    if (scan.error) { problems.push(`  - ⚠ ${short(repoPath)}: no escaneado (${scan.error}) — no se pudo mirar; correr --scan a mano`); continue; }
    for (const b of scan.branches || []) {
      const cls = classifyBranch(repoPath, b.branch, scan.remote, ctx);
      // 1 aviso por repo+rama+CLASE por sesión (hallazgo E): un WIP legítimo no come spam, pero si
      // la rama pasa de "ajena" a "propia" (la sesión commiteó encima) el aviso propio SÍ sale.
      const key = `${sid}|${real(repoPath)}|${b.branch}|${cls}`;
      if (seen[key]) continue;
      seen[key] = { ts: new Date().toISOString() };
      const line = `  - ${short(repoPath)} → ${b.branch} @ ${b.tip}: ${b.count} commit(s) que NO están en ${scan.remote}${b.wip ? ' (wip)' : ''}${cls === 'own-rewritten' ? ' (shas reescritos por rebase/cherry-pick; la rama la commiteó esta sesión)' : ''}`;
      ({ own, 'own-rewritten': own, foreign, unknown })[cls].push(line);
    }
  }
  state.stopSeen = prune(seen);
  saveState(state);
  if (!own.length && !foreign.length && !unknown.length && !problems.length) return;
  const parts = [];
  if (own.length) parts.push(`⛔ trabajo sin subir: esta sesión commiteó y quedaron commits que NO están en el remoto:\n${own.join('\n')}\nSi es WIP a propósito, decíselo al dev en una línea y cerrá (este aviso no se repite para la misma rama). Si es una entrega, falta el push: decíselo al dev y pusheá sólo con su OK — caso FRESNO Story 1.1 (2026-08-25): el backend quedó solo local y el front se promovió igual.`);
  if (foreign.length) parts.push(`⚠️ hay commits sin subir que esta sesión NO hizo (otra sesión de Claude/Codex, el dev desde la terminal, o commits anteriores a este registro):\n${foreign.join('\n')}\n🔴 NO los revertas, NO los pushees ni los toques: no son tuyos. Decíselo al dev en una línea y cerrá — si SABÉS que los hiciste vos (p. ej. con sha reescrito), decíselo igual y que decida él; no decidas solo. Caso 2026-08-31: un agente revirtió y pusheó el commit de prueba de otra sesión porque este aviso lo llamaba suyo.`);
  if (unknown.length) parts.push(`⚠️ commits sin subir cuya autoría no se pudo determinar (git no respondió a tiempo):\n${unknown.join('\n')}\nNo los toques; decíselo al dev y que decida.`);
  if (problems.length) parts.push(`⚠️ repos que no se pudieron escanear (esto NO es verde):\n${problems.join('\n')}`);
  process.stdout.write(JSON.stringify({ decision: 'block', reason: parts.join('\n\n') }) + '\n');
}

// ── atribución propio/ajeno (compartida por el Stop y el aviso del push a main) ─────────────────
// ctx = { mine: Set<sha>, legacyRepos: Set<realpath>, committedRepos: Set<realpath> }
//   mine: shas anotados por esta sesión (commits + reescrituras).
//   legacyRepos: repos con entradas `commit` SIN la clave `sha` (formato anterior al 2026-08-31,
//     ledger vivo 7 días) → se tratan como propias: la transición no puede convertir "pusheá" en
//     "no pushees" (hallazgo D).
//   committedRepos: repos donde la sesión commiteó de verdad → criterio de respaldo para la rama
//     ACTUAL de ese repo cuando ningún sha matchea (rebase fuera de este registro, hallazgo C).
function mineContext(sid) {
  const entries = readJsonl(ledgerFile(sid));
  const mine = new Set(); const legacyRepos = new Set(); const committedRepos = new Set();
  for (const e of entries) {
    if (e.kind === 'commit') {
      if (!('sha' in e)) { legacyRepos.add(real(e.repo)); committedRepos.add(real(e.repo)); }
      else if (e.sha) { mine.add(e.sha); committedRepos.add(real(e.repo)); }
    } else if (e.kind === 'rewrite') {
      for (const s of e.shas || []) mine.add(s);
    }
  }
  return { mine, legacyRepos, committedRepos };
}
// → 'own' | 'own-rewritten' | 'foreign' | 'unknown'
function classifyBranch(repoPath, branch, remote, ctx) {
  const rp = real(repoPath);
  if (ctx.legacyRepos.has(rp)) return 'own';
  if (ctx.mine.size) {
    let shas;
    try { shas = unpushedShas(repoPath, remote, branch); } catch { return 'unknown'; }
    if (shas.some((s) => ctx.mine.has(s))) return 'own';
  }
  if (ctx.committedRepos.has(rp) && gitSafe(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']) === branch) return 'own-rewritten';
  return 'foreign';
}
function ownerTag(cls) {
  return cls === 'foreign' ? '(NO es de esta sesión — no tocar)'
    : cls === 'unknown' ? '(autoría indeterminada — no tocar)'
      : cls === 'own-rewritten' ? '(propio, shas reescritos)' : '(propio)';
}

function scanCli(argv) {
  const i = argv.indexOf('--scan');
  const repoArg = argv[i + 1];
  const asJson = argv.includes('--json');
  const root = gitSafe(repoArg || process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!root) {
    const msg = { scanned: false, error: `no es un repo git: ${repoArg || process.cwd()}` };
    process.stdout.write(asJson ? JSON.stringify(msg) + '\n' : `⚠ ${msg.error}\n`);
    process.exitCode = 2;
    return;
  }
  const scan = scanGroup(root);
  if (asJson) { process.stdout.write(JSON.stringify(scan, null, 1) + '\n'); return; }
  process.stdout.write(`grupo (${scan.groupSource}):\n`);
  for (const r of scan.repos) {
    if (r.error) { process.stdout.write(`  ⚠ ${r.path}: NO ESCANEADO (${r.error})\n`); continue; }
    if (r.noRemote) { process.stdout.write(`  - ${r.path}: sin remoto (local puro)\n`); continue; }
    if (!r.branches.length) { process.stdout.write(`  ✓ ${r.path}: todo en ${r.remote}\n`); continue; }
    process.stdout.write(`  🔴 ${r.path}:\n`);
    for (const b of r.branches) process.stdout.write(`      ${b.branch} @ ${b.tip}: ${b.count} commit(s) solo locales${b.wip ? ' (wip)' : ''} — "${b.subject}"\n`);
  }
  for (const d of scan.discarded) process.stdout.write(`  (descartado: ${d.path} — ${d.reason})\n`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--scan')) return scanCli(argv); // el CLI ignora el kill-switch a propósito (RU-F5)
  if (process.env.TYCON_UNPUSHED_NOTICE === '0') return;
  let event = {};
  try { const s = fs.readFileSync(0, 'utf8'); event = s ? JSON.parse(s) : {}; } catch { event = {}; }
  const argMode = (argv.indexOf('--mode') >= 0) ? argv[argv.indexOf('--mode') + 1] : null;
  const evName = event.hook_event_name || '';
  const mode = argMode
    || (event.tool_name ? 'record' : null)
    || (evName === 'SessionStart' || event.source ? 'notice' : null)
    || (evName === 'Stop' || ('stop_hook_active' in event) ? 'stop' : null);
  if (mode === 'record') return record(event);
  if (mode === 'stop') return stop(event);
  if (mode === 'notice') return notice(event);
}
try { main(); } catch { /* fail-open: nunca rompe un push, un stop ni un arranque */ }
