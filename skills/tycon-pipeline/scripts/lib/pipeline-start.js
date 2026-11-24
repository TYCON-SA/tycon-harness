/**
 * pipeline-start.js — una parte de pipeline.js (el despachador la carga para sus subcomandos).
 *
 * Responsabilidad: el arranque de una corrida y las herramientas que espera.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, MODELOS, RUNS_DIR, STEPS_TABLE, at, ejecucionDeLaCorrida, esCodex, evidenceDirForStory, exists, fs, harnessWorkSignal, os, packsLib, parseFrontmatterPipeline, path, pedidoDeSalteo, readSessionMarker, readText, resolveSessionId, runDirKey, sessionIdFileKey, sessionLogPath, stateDirOf } = require('./pipeline-shared.js');
const { computeModelHint, conModelosDeLaCorrida, decirModelos } = require('./pipeline-models.js');
const { computeGitignoreNeeds, e2eConfig, gitIgnoraProbe } = require('./pipeline-reports.js');
const { computeRiskClass, computeRunSize, runSizeLib } = require('./pipeline-risk.js');
// `run-start`: la corrida nueva corta la ronda de la anterior en el mismo registro (lib/advisor-round.js →
// inicioDeLaRonda). Sin la marca, el set esperado de la última vuelta de la corrida anterior seguía abierto.
function logRunStart(story) {
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.appendFileSync(sessionLogPath(), JSON.stringify({
      ts: new Date().toISOString(),
      event: 'run-start',
      story: story || null,
    }) + '\n', 'utf8');
  } catch (e) {
    // no frena el arranque, pero se dice: sin la marca, la ronda de la corrida anterior sigue abierta en ésta
    process.stderr.write(`⚠️ start: no pude anotar el inicio de la ejecución en el registro de revisores (${e && e.message}); ` +
      'la última ronda de la ejecución anterior de esta sesión puede tomarse como de ésta.\n');
  }
}

/**
 * PIPE-C2 · el texto que se agrega al final de un `.gitignore`, con el fin de línea del archivo: el de su primer salto
 * (CRLF o LF); vacío o sin saltos, LF. Un archivo sin salto final recibe uno antes. Un LF metido en un archivo CRLF
 * hace que git en Windows lo vea reescrito entero.
 */
function gitignoreAppendText(actual, lineas) {
  const primero = /\r?\n/.exec(actual);
  const eol = primero ? primero[0] : '\n';
  const antes = actual === '' || /\n$/.test(actual) ? '' : eol;
  return antes + lineas.join(eol) + eol;
}

/**
 * El proveedor de modelos de esta máquina y lo que su entorno no dice igual que la tabla:
 * `{ models_provider: { provider, origin }, warnings }`. Con Ollama, cada `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` distinta del
 * modelo de la tabla para su nivel es un aviso (`provider-env:<VARIABLE>`); sin proveedor declarado y con
 * `ANTHROPIC_BASE_URL` en otro host que api.anthropic.com, un aviso que dice cómo declararlo (`provider-undeclared`). El
 * arnés no cambia el proveedor ni el entorno: avisa. Nunca tira ni frena. opts: env · home · tree.
 */
const VARIABLES_DE_NIVEL = [['economy', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], ['balanced', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], ['strong', 'ANTHROPIC_DEFAULT_OPUS_MODEL']];
function proveedorDeModelos(org, opts = {}) {
  const env = opts.env || process.env;
  const warnings = [];
  let prov;
  try {
    const dir = opts.tree || require('./harness-path.js').rutaArnesHook({ env, home: opts.home }).dir;
    const lector = dir ? path.join(dir, 'scripts', 'lib', 'tycon-config.js') : null;
    // sin el lector, «no pude consultar» no se lee como «Anthropic»: se dice
    if (lector && fs.existsSync(lector)) prov = require(lector).modelProvider({ env, home: opts.home });
    else prov = { provider: 'anthropic', origin: 'derivado', problem: `no encontré el lector de la configuración de la máquina (${lector || 'sin arnés'})` };
  } catch (e) {
    prov = { provider: null, origin: 'rota', problem: String((e && e.message) || e).split('\n')[0] };
  }
  if (prov.problem) {
    warnings.push({ key: 'provider-unreadable', message: `el proveedor de modelos de la máquina no se pudo leer (${prov.problem}): sigo como Anthropic` });
    prov = { ...prov, provider: 'anthropic' };
  }
  const data = org && org.declared ? org.data : null;
  if (prov.provider === 'ollama') {
    for (const [level, variable] of VARIABLES_DE_NIVEL) {
      const r = MODELOS.resolveProviderModel({ org: data, provider: 'ollama', level, warnings });
      if (!r.model || r.model === MODELOS.INHERIT) continue;
      const tiene = env[variable];
      if (tiene !== r.model) {
        warnings.push({ key: `provider-env:${variable}`, message: `${variable} es ${tiene ? tiene : '(sin poner)'} y la tabla de Ollama dice ${r.model} para ${level}: abrí la sesión con la función claude-ollama de la guía (usa \`eval "$(node scripts/lib/models-env.js)"\`)` });
      }
    }
  }
  if (prov.origin === 'derivado' && env.ANTHROPIC_BASE_URL) {
    let host = null;
    try { host = new URL(env.ANTHROPIC_BASE_URL).hostname; } catch (_) { host = String(env.ANTHROPIC_BASE_URL); }
    if (host && host !== 'api.anthropic.com') {
      warnings.push({ key: 'provider-undeclared', message: `ANTHROPIC_BASE_URL apunta a ${host}: si es Ollama, declaralo con \`node scripts/lib/tycon-config.js set models.provider ollama\`` });
    }
  }
  return { models_provider: { provider: prov.provider, origin: prov.origin }, warnings };
}

// ── pipeline.js start — preflight mecánico en UN comando ─
// Colapsa los 5 checks del Arranque (PIPE-C0 cross-session, C1 branch guard,
// C2 gitignore, C4 marker, C5 status in-progress) que el LLM ejecutaría
// check-por-check en prosa (5 turnos → 1). PAUSA (ready:false, sin mutar nada)
// solo ante conflicto cross-session, rama protegida o pipeline abandonado.
// ── Specs que envejecen sin revalidar ────────────────
// Una story queda `ready-for-dev` y se implementa MESES después. El spec no envejece solo: el
// código que cita se mueve abajo. Ejemplo: tras 2.5 meses en
// `ready-for-dev`, una revalidación puede encontrar correcciones de fondo, como un esqueleto que
// manda a llamar `PluginManager.GetLoadedPlugin(name)`, un método que NO EXISTE.
// Sin esa revisión, la story manda a escribir código que no compila. También pueden cambiar los
// hechos del dominio (un 3er plugin afectado que la story da por inexistente) y un bug que la
// story documenta como abierto puede estar cerrado.
//
// Esto AVISA, no frena: la antigüedad no es un defecto, es una señal de que conviene reverificar
// las anclas `archivo:línea` antes de codear. Frenar por una fecha sería castigar el backlog.
// Umbral configurable: TYCON_STALE_SPEC_DAYS (default 75). Apagado con 0.
function computeSpecStaleness(fm, hoyMs) {
  const dias = Number(process.env.TYCON_STALE_SPEC_DAYS || 75);
  if (!Number.isFinite(dias) || dias <= 0) return null;

  // `revalidated:` gana sobre `created:` — es exactamente el sello que deja esta revisión, así que
  // una story revalidada la semana pasada NO vuelve a avisar aunque se haya escrito hace un año.
  const campo = fm.revalidated ? 'revalidated' : 'created';
  const crudo = String(fm[campo] || '').trim().replace(/^["']|["']$/g, '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(crudo)) return null;   // sin fecha legible no se inventa antigüedad
  const t = Date.parse(crudo.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;

  const edad = Math.floor((hoyMs - t) / 86400000);
  if (edad < dias) return null;
  return {
    dias_sin_revalidar: edad,
    umbral: dias,
    campo_usado: campo,
    fecha: crudo.slice(0, 10),
    aviso: `Esta story tiene ${edad} días desde \`${campo}: ${crudo.slice(0, 10)}\` y todavía no se implementó. `
      + 'ANTES de codear, reverificá que las anclas `archivo:línea` del spec sigan resolviendo y que '
      + 'los hechos del dominio no hayan cambiado (métodos que ya no existen, casos nuevos que el spec '
      + 'no contempla, bugs que se cerraron por otra vía). No hace falta reescribir la story: alcanza '
      + 'con confirmar lo que cita y anotar las correcciones inline. Al terminar, sellá el frontmatter '
      + 'con `revalidated: <hoy>` para que este aviso no vuelva a salir. '
      + 'Caso de referencia (qué se encontró y cómo se documentó): epic-9 del repo del framework, §Revalidación.',
  };
}

// El marker.js que corre el arranque: el instalado, no el del repo.
const markerInstalado = () => path.join(os.homedir(), '.claude', 'agent-skills', 'skills', 'tycon-pipeline', 'scripts', 'marker.js');

/** Anota la tanda en el marcador de esta sesión con `marker.js set-batch`. `{ ok, motivo }`; nunca tira. */
function anotarTanda(nombre) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync(process.execPath, [markerInstalado(), 'set-batch', nombre], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e) {
    return { ok: false, motivo: String((e.stderr || e.message || e)).trim().split('\n')[0] };
  }
}

/** La pausa de una tanda que no se pudo anotar: el comando a mano y lo que mide la matriz mientras tanto. */
const pausaSinTanda = (nombre, motivo) => ({
  id: 'PIPE-C4-batch-failed',
  detail: `No pude anotar la tanda ${nombre} (${motivo}). Anotala a mano: node ${markerInstalado()} set-batch ${nombre}. `
    + 'Hasta anotarla, la matriz mide todas las tandas.',
});

/**
 * `start --batch <tanda>`, antes de tocar nada: la tanda tiene que estar en el bloque `pipelines`, sin estar hecha y sin
 * nombres repetidos. La misma sesión con su ejecución abierta de esta historia no rearranca: con la misma tanda sale
 * sin cambios, con otra pausa, y sin tanda anotada la anota. Devuelve `{ salida }` cuando el arranque termina acá, o
 * `{ nombre }` para seguir.
 */
function tandaDelArranque(content, storyId, storyPath, nombre) {
  const tandas = require('./story-checks.js').parsePipelinesBlock(content);
  const lista = tandas.map((t) => `${t.name} (${t.status || 'sin estado'})`).join(', ') || '(la historia no tiene bloque pipelines)';
  const nombres = tandas.map((t) => t.name);
  const repetidos = [...new Set(nombres.filter((n, i) => nombres.indexOf(n) !== i))];
  const t = tandas.find((x) => x.name === nombre);
  const motivo = !nombre ? 'falta el nombre de la tanda'
    : repetidos.length ? `el bloque pipelines tiene nombres repetidos (${repetidos.join(', ')}): no sé cuál es la tanda ${nombre}`
      : !t ? `la tanda «${nombre}» no está en la historia`
        : String(t.status || '').toLowerCase() === 'done' ? `la tanda ${nombre} está done: una tanda hecha no se entrega de nuevo` : null;
  const pausa = (id, detail) => ({ salida: { ready: false, story_id: storyId, pauses: [{ id, detail }], actions_done: [], note: 'NADA mutado. Resolvé la pausa y re-corré start.' } });
  if (motivo) return pausa('PIPE-C0-batch', `${motivo}. Tandas: ${lista}. No arranqué nada.`);
  const propio = readSessionMarker();
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const suya = propio && propio.storyPath
    ? (path.isAbsolute(propio.storyPath) ? propio.storyPath : path.join(propio.repoPath || process.cwd(), propio.storyPath)) : null;
  if (!propio || String(propio.storyId) !== String(storyId) || !suya || real(suya) !== real(storyPath)) return { nombre };
  if (propio.batch) {
    if (String(propio.batch) === nombre) {
      return { salida: { ready: true, story_id: storyId, actions_done: [`TANDA: esta ejecución ya tenía anotada la tanda ${nombre}; no cambié nada.`], next: 'pipeline.js next te dice el próximo paso' } };
    }
    return pausa('PIPE-C0-batch-other', `Esta ejecución ya anotó la tanda ${propio.batch}; para otra tanda, marker.js clear y arrancar de nuevo. No cambié nada.`);
  }
  const r = anotarTanda(nombre);
  if (!r.ok) return { salida: { ready: false, story_id: storyId, pauses: [pausaSinTanda(nombre, r.motivo)], actions_done: [] } };
  return { salida: { ready: true, story_id: storyId, actions_done: [`TANDA: anoté la tanda ${nombre} en la ejecución abierta de esta sesión.`], next: 'pipeline.js next te dice el próximo paso' } };
}

// ── PIPE-C10: la copia propia de la historia ───────────────────────────────────────────────────────────────────────
// Con otra sesión viva en el checkout donde corre start (scripts/lib/live-sessions.js: su transcripción, sus subagentes
// o su corrida abierta), sin coordinadora viva y fuera del arnés y agent-skills, la historia arranca en
// `<principal>--wt-<clave>`. La copia nace de origin/main si la historia está ahí igual; si no, de HEAD si está
// commiteada igual; sin commitear no se crea nada (no se mueve, ni se copia, ni se guarda en un stash ningún archivo).
// `{}` (nadie más, como siempre) · `{ warning }` · `{ pause }` · `{ copy, storyInCopy, baseLabel, because }`.
function copiaPropiaDelArranque({ storyId, storyPath, repo }) {
  const SCRIPTS_DIR = path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'scripts');
  let live, sib, coord;
  try {
    live = require(path.join(SCRIPTS_DIR, 'lib', 'live-sessions.js'));
    sib = require(path.join(SCRIPTS_DIR, 'lib', 'sibling-copy.js'));
    coord = require(path.join(SCRIPTS_DIR, 'tools', 'coordination.js'));
  } catch (e) {
    return { warning: `no pude mirar si hay otra sesión viva en este checkout (${String(e.message).split('\n')[0]}): sigo como siempre` };
  }
  const raiz = live.raizDelRepo(repo);
  if (!raiz) return {};
  const r = live.others({ root: raiz, selfSessionId: sessionIdFileKey(), home: os.homedir() });
  // la otra sesión de la MISMA historia ya la juzgó PIPE-C0 (pausa, o tanda en paralelo declarada): no cuenta acá
  r.sessions = r.sessions.filter((s) => s.story !== String(storyId));
  if (!r.sessions.length) {
    // con una sola fuente ilegible tampoco se puede decir que no hay nadie
    return r.problems.length ? { warning: `no pude ver si hay otra sesión viva en este checkout (${r.problems.join('; ')}): sigo como siempre` } : {};
  }
  const quien = r.sessions.map((s) => `la sesión ${s.id.slice(0, 8)}${s.story ? ` (historia ${s.story})` : s.lastPrompt ? ` («${s.lastPrompt}»)` : ''}`).join(' y ');
  if (live.noOwnCopy(raiz)) {
    return { warning: `hay otra sesión viva en este checkout (${quien}); en ${path.basename(raiz)} una sola sesión toca git a la vez (guides/git-worktrees.md §1): coordinala o esperala` };
  }
  let coordinadora = null;
  try { coordinadora = coord.liveCoordinator({ home: os.homedir(), env: process.env }, null); } catch (e) {
    return { warning: `hay otra sesión viva en este checkout (${quien}) y no pude saber si hay coordinadora (${String(e.message).split('\n')[0]}): no creo una copia; coordinala o esperala` };
  }
  if (coordinadora) {
    return { warning: `hay otra sesión viva en este checkout (${quien}); la coordinadora (${coordinadora.name}) decide dónde trabaja cada sesión: no creo una copia` };
  }
  const pausa = (detail) => ({ pause: { id: 'PIPE-C10-own-copy', detail } });
  const main = sib.mainOf(raiz);
  if (!main) return pausa(`Hay otra sesión viva en este checkout (${quien}) y no pude ver el repo ${raiz}. No creé una copia ni escribí el marcador.`);
  const because = `hay otra sesión viva en este checkout (${quien})`;
  const ya = copiaYaAbierta({ storyId, storyPath, raiz, main, sib });
  if (ya && ya.copy) return { ...ya, because };
  const avisoYa = ya && ya.warning ? { warning: ya.warning } : {};
  // un repo sin `origin` (uno local, de juguete) no tiene una main que traer ni adonde empujar la copia: sigue como
  // siempre, con el aviso. Un `origin` que existe y no responde sí pausa (abajo)
  if (sib.gitIn(raiz, ['remote', 'get-url', 'origin']).code !== 0) {
    return { warning: `hay otra sesión viva en este checkout (${quien}) y el repo no tiene origin: no creo una copia; coordinala o esperala` };
  }
  // de dónde nace: se trae main antes de comparar (sin red no se compara contra una punta vieja)
  const fetched = sib.gitIn(main, ['fetch', '--quiet', '--no-tags', 'origin', 'main']);
  if (fetched.code !== 0) return pausa(`Hay otra sesión viva en este checkout (${quien}) y no pude traer main de origin para crear la copia de la historia: ${fetched.err || `git salió con código ${fetched.code}`}. No creé una copia ni escribí el marcador.`);
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const abs = real(path.resolve(storyPath));
  const dentro = abs.startsWith(real(raiz) + path.sep);
  const rel = dentro ? path.relative(real(raiz), abs).split(path.sep).join('/') : null;
  let baseLabel = 'origin/main';
  if (dentro) {
    const texto = fs.readFileSync(abs, 'utf8');
    const en = (ref) => { const s = sib.gitIn(raiz, ['show', `${ref}:${rel}`]); return s.code === 0 ? s.out : null; };
    const limpio = sib.gitIn(raiz, ['status', '--porcelain', '--', rel]);
    const igual = (otro) => otro != null && otro === texto.trim();
    if (igual(en('origin/main'))) baseLabel = 'origin/main';
    else if (limpio.code === 0 && !limpio.out && igual(en('HEAD'))) baseLabel = 'HEAD';
    else return pausa(`Hay otra sesión viva en este checkout (${quien}) y la historia ${rel} no está commiteada (o tiene cambios sin commitear): la copia propia no la tendría. Commiteá la historia primero en su rama y volvé a correr start, o trabajá coordinado con la otra sesión. No creé una copia, no moví ni guardé en un stash ningún archivo, y no escribí el marcador.`);
  }
  const base = sib.gitIn(raiz, ['rev-parse', '--verify', `${baseLabel}^{commit}`]);
  if (base.code !== 0) return pausa(`Hay otra sesión viva en este checkout (${quien}) y no pude leer ${baseLabel}: ${base.err}. No creé una copia ni escribí el marcador.`);
  const clave = String(runDirKey(storyId, storyPath).key || storyId).replace(/[^\w.-]/g, '-');
  const libre = sib.freeName(raiz, clave);
  if (!libre.name) return pausa(`Hay otra sesión viva en este checkout (${quien}) y no encontré un nombre libre para la copia: ${libre.problem}. No creé una copia ni escribí el marcador.`);
  const copy = sib.siblingCopy({ repo: raiz, name: libre.name, branch: `wt/${libre.name}`, base: base.out, closing: 'no la creé' });
  if (!copy.ok) return pausa(`Hay otra sesión viva en este checkout (${quien}). ${copy.message} No escribí el marcador.`);
  return { copy, baseLabel, because, storyInCopy: dentro ? path.join(copy.path, rel) : abs, ...avisoYa };
}

// La copia que esta sesión ya abrió para esta historia, si `start` se repite desde el checkout (tras compactar, por
// ejemplo): se sigue en ella. Otra copia dejaría la primera, con su corrida, sin dueño. `{ copy, … }`, null (no tenía
// ninguna) o `{ warning }` (no se puede saber o no se puede seguir en ella: se abre otra, y queda dicho).
function copiaYaAbierta({ storyId, storyPath, raiz, main, sib }) {
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(stateDirOf(os.homedir()), 'active', `${sessionIdFileKey()}.json`), 'utf8')); } catch (e) {
    return e.code === 'ENOENT' ? null : { warning: `no pude leer el marcador de esta sesión (${e.code || e.message}): si ya tenía una copia de esta historia, queda abandonada` };
  }
  if (!m || String(m.storyId) !== String(storyId) || typeof m.repoPath !== 'string' || !fs.existsSync(m.repoPath)) return null;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const dir = real(m.repoPath);
  if (dir === real(raiz) || sib.mainOf(dir) !== main) return null;
  const abs = real(path.resolve(storyPath));
  const storyInCopy = abs.startsWith(real(raiz) + path.sep) ? path.join(dir, path.relative(real(raiz), abs)) : abs;
  const rama = sib.gitIn(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (rama.code !== 0 || !fs.existsSync(storyInCopy)) {
    return { warning: `no puedo seguir en la copia ${dir} (${rama.code !== 0 ? rama.err : 'no tiene la historia'}): abro otra y esa queda abandonada` };
  }
  return { copy: { path: dir, main, branch: rama.out, created: false }, baseLabel: 'la copia que ya tenía', storyInCopy };
}

// Lo que no viaja con una copia (el `post_checklist` de scripts/tools/tycon-worktree.sh).
function checklistDeLaCopia(dir) {
  const out = [];
  if (fs.existsSync(path.join(dir, 'package.json'))) out.push('npm install (node_modules no viaja con la copia)');
  let dotnet = false;
  try { dotnet = fs.readdirSync(dir).some((f) => f.endsWith('.sln') || (fs.statSync(path.join(dir, f)).isDirectory() && fs.readdirSync(path.join(dir, f)).some((g) => g.endsWith('.csproj')))); } catch { /* sin listar */ }
  if (dotnet) out.push('dotnet restore (bin/obj no viajan)');
  out.push('.env y secretos sin trackear: copiarlos a mano si una prueba en vivo los necesita');
  return out;
}

// ¿El marcador de esta sesión quedó apuntando a la copia? (la re-entrada pudo pausar antes o después de escribirlo)
function marcadorEnLaCopia(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(stateDirOf(os.homedir()), 'active', `${sessionIdFileKey()}.json`), 'utf8'));
    return Boolean(m && m.repoPath && fs.realpathSync(m.repoPath) === fs.realpathSync(dir));
  } catch { return false; }
}

function computeStart(args) {
  const { execFileSync } = require('child_process');
  const storyPath = args.story;
  // el único lugar donde vale la carpeta del proceso: el --repo de quien arranca, resuelto al entrar. De acá salen la
  // carpeta, el marcador y la apertura, absolutos, y se leen igual desde cualquier carpeta (lib/run-dir.js)
  const repo = args.repo ? path.resolve(args.repo) : args.repo;
  if (!storyPath || !fs.existsSync(storyPath)) {
    return { ready: false, error: `--story inválido o no existe: ${storyPath}` };
  }
  const content = readText(storyPath);
  const fm = parseFrontmatterPipeline(content);
  // La identidad de una story es `story:` en su frontmatter, en todo el arnés. Sin ella no se arranca: el nombre del
  // archivo como número dejaría una ejecución que ningún otro control reconoce como de esta story.
  if (!fm.story) {
    const motivo = fm.storyId
      ? `declara \`storyId:\` y no \`story:\` (la clave que lee el arnés). Renombrala a \`story:\``
      : 'no trae `story:` en su frontmatter (o no tiene frontmatter). Agregalo, con el número de la story';
    return { ready: false, error: `${path.basename(storyPath)} ${motivo}, y volvé a correr start. No arranqué nada.` };
  }
  const storyId = fm.story;
  const pauses = [];
  const actions = [];

  // `--batch`: la tanda de una historia paraguas. Se valida antes de tocar nada; la misma sesión que la vuelve a pedir
  // no rearranca su ejecución (ver tandaDelArranque).
  const tanda = args.batch != null ? tandaDelArranque(content, storyId, storyPath, String(args.batch)) : null;
  if (tanda && tanda.salida) return tanda.salida;

  // PIPE-C0: cross-session conflict.
  // «La misma story» es el mismo número Y la misma ruta dentro de su repo: en los repos que numeran por
  // tema, dos sesiones sobre dos `1.1` distintas se frenarían entre sí. La ruta va RELATIVA al repo a propósito: dos
  // copias del repo (dos clones o worktrees) trabajando la misma story se siguen frenando. Un marcador sin ruta
  // legible se compara por el número: ante la duda, pausa de más.
  // Relativa al repo de la STORY (no al del marcador: el pipeline puede correr en el repo del código con la story en
  // otro). Sin repo git que la contenga, o si el archivo ya no está (la story se movió o se renombró después de que la
  // otra sesión arrancó), no hay ruta comparable → null, y se compara por el número: ante la duda, pausa de más.
  const rutaEnRepo = (sp, rp) => {
    try {
      const abs = path.isAbsolute(sp) ? sp : path.join(rp || repo, sp);
      if (!fs.existsSync(abs)) return null;
      // Como la guarda el disco: otras mayúsculas o la tilde en otra forma Unicode no hacen «otra story».
      const real = fs.realpathSync.native(abs);
      const raiz = require('./evidence-config.js').discoverRepoRoot(path.dirname(real));
      return raiz ? path.relative(raiz, real).split(path.sep).join('/') : null;
    } catch { return null; }
  };
  const miRuta = rutaEnRepo(path.resolve(storyPath));
  const others = [];
  try {
    const sid = sessionIdFileKey();
    const activeDir = path.join(stateDirOf(os.homedir()), 'active');
    for (const f of (fs.existsSync(activeDir) ? fs.readdirSync(activeDir) : [])) {
      if (!f.endsWith('.json') || f === `${sid}.json`) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(activeDir, f), 'utf8'));
        if (!m || String(m.storyId) !== String(storyId)) continue;
        const suRuta = m.storyPath ? rutaEnRepo(m.storyPath, m.repoPath) : null;
        if (suRuta && miRuta && suRuta !== miRuta) continue; // otra story con el mismo número
        // con tanda, la otra sesión que entrega otra tanda de la paraguas no choca; la misma tanda, o sin tanda, sí
        if (tanda && m.batch && String(m.batch) !== tanda.nombre) continue;
        others.push({ sessionId: m.sessionId, lastTouch: m.lastTouch, stepsCompleted: m.stepsCompleted, repoPath: m.repoPath || null });
      } catch (e) {
        // un marcador que no se lee puede ser de esta misma historia: no lo veo para el choque, y se dice
        actions.push(`PIPE-C0: no pude leer el marcador de otra sesión (${f}: ${String((e && (e.code || e.message)) || e).split('\n')[0].slice(0, 120)}): si es de la story ${storyId}, no lo veo.`);
      }
    }
  } catch (e) {
    actions.push(`PIPE-C0: no pude listar los marcadores de las otras sesiones (${String((e && (e.code || e.message)) || e).split('\n')[0].slice(0, 120)}): no sé si otra sesión trabaja la story ${storyId}.`);
  }
  // PIPE-C0 por hechos: la otra sesión de la misma story en OTRA copia del repo (otra raíz git) y en OTRA rama es otra
  // tanda que trabaja en paralelo, no un choque: no pausa y queda dicho (`parallelWith` en el marcador). La misma copia,
  // o la misma rama en otra copia, pausa como siempre; si no se puede leer la rama de la otra, pausa y lo dice.
  let parallelWith = null;
  let ramaSinLeer = null;
  let ramaPropiaSinLeer = false;
  if (others.length) {
    const gitDe = (dir, ...a) => {
      try { return execFileSync('git', ['-C', dir, ...a], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
    };
    const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    const miRaiz = gitDe(repo, 'rev-parse', '--show-toplevel');
    const miRama = gitDe(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    const vistas = others.map((o) => {
      const raiz = o.repoPath && fs.existsSync(o.repoPath) ? gitDe(o.repoPath, 'rev-parse', '--show-toplevel') : null;
      return { sessionId: o.sessionId, repoPath: o.repoPath, raiz, rama: raiz ? gitDe(o.repoPath, 'rev-parse', '--abbrev-ref', 'HEAD') : null };
    });
    const sinLeer = vistas.filter((v) => !v.raiz || !v.rama);
    if (!miRaiz || !miRama) {
      ramaSinLeer = repo;
      ramaPropiaSinLeer = true;
    } else if (sinLeer.length) {
      ramaSinLeer = sinLeer.map((v) => `${v.sessionId} (${v.repoPath || 'sin repo en su marcador'})`).join(', ');
    } else if (vistas.every((v) => real(v.raiz) !== real(miRaiz) && v.rama !== miRama)) {
      const lista = vistas.map((v) => ({ sessionId: v.sessionId, branch: v.rama }));
      parallelWith = lista.length === 1 ? lista[0] : lista;
      actions.push(`PIPE-C0: la story ${storyId} también la trabaja ${lista.map((v) => `la sesión ${v.sessionId} en la rama ${v.branch}`).join(' y ')}, `
        + 'en otra copia del repo: es otra tanda en paralelo, no un choque.');
    }
  }
  if (others.length && !parallelWith) {
    pauses.push({
      id: 'PIPE-C0-cross-session',
      detail: `Story ${storyId} YA tiene pipeline activo en otra sesión: ${JSON.stringify(others)}`
        + (ramaSinLeer ? `. No pude leer la rama de ${ramaPropiaSinLeer ? 'esta sesión' : 'la otra sesión'} (${ramaSinLeer}): ante la duda, pauso.` : ''),
      options: 'retomar con `marker.js adopt-session <sid>` (copia el estado completo) / clear-session / trabajarla en otra copia del repo y otra rama / cancelar',
    });
  }

  // PIPE-C10: otra sesión viva en este checkout (una historia distinta, otro chat) → la historia arranca en su propia
  // copia de trabajo, antes de escribir nada acá. Se re-entra a start dentro de la copia: los chequeos de
  // siempre, el marcador y la carpeta de la corrida quedan allá, y el checkout compartido no cambia.
  const warnings = [];
  if (!pauses.length && !args.inOwnCopy) {
    const cp = copiaPropiaDelArranque({ storyId, storyPath, repo });
    if (cp.warning) warnings.push(cp.warning);
    if (cp.pause) {
      return { ready: false, story_id: storyId, pauses: [cp.pause], actions_done: actions, ...(warnings.length ? { warnings } : {}), note: 'NADA mutado: no creé una copia ni escribí el marcador. Resolvé la pausa y re-corré start.' };
    }
    if (cp.copy) {
      const inner = computeStart({ ...args, repo: cp.copy.path, story: cp.storyInCopy, inOwnCopy: true });
      const workCopy = { path: cp.copy.path, branch: cp.copy.branch, base: cp.baseLabel, created: cp.copy.created, because: cp.because, checklist: checklistDeLaCopia(cp.copy.path) };
      const linea = `PIPE-C10: ${cp.because}: la historia arranca en su propia copia de trabajo ${cp.copy.path} (rama ${cp.copy.branch}, desde ${cp.baseLabel}). Seguí desde ahí: cada comando con cd a la copia y cada archivo por su ruta en la copia (step-01-start.md).`;
      const juntos = [...warnings, ...(inner.warnings || [])];
      if (!inner.ready && cp.copy.created && !marcadorEnLaCopia(cp.copy.path)) {
        // la copia no sirve sin la corrida: se saca lo que se creó, y se dice si quedó algo
        const sacada = require(path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'sibling-copy.js')).removeCopy({ path: cp.copy.path, main: cp.copy.main, branch: cp.copy.branch, created: cp.copy.created });
        return { ...inner, ...(juntos.length ? { warnings: juntos } : {}), note: `${inner.note || 'No arrancó.'} ${sacada ? 'Saqué la copia que había creado.' : `No pude sacar la copia ${cp.copy.path}: queda para el barrido.`}` };
      }
      return { ...inner, work_copy: workCopy, actions_done: [linea, ...(inner.actions_done || [])], ...(juntos.length ? { warnings: juntos } : {}) };
    }
  }

  // PIPE-C1: branch guard.
  let branch = null;
  try {
    branch = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* repo sin git */ }
  // La historia del modo primera vez de tycon-create-story arranca sola: sin git, `git init`; en main/master (o en un repo sin
  // commits), la rama `story/<n>`. Sólo con la marca `origin: first-time` Y la constancia que deja el guion que la
  // escribió (lib/first-time-record.js): la marca sola se escribe a mano, y en un checkout que comparten varias sesiones
  // cambiar de rama solo rompe el trabajo de la otra (caso de scripts/hooks/session-collision-guard.js). Lo que se
  // decide acá se hace después de juntar todas las pausas: con cualquier pausa, nada cambia.
  let firstTimeGit = null;
  const firstTimeMark = fm.origin === 'first-time';
  const firstTimeOk = firstTimeMark && require('./first-time-record.js').isRecorded(os.homedir(), storyPath, storyId);
  if (firstTimeOk) {
    const gitOut = (...a) => execFileSync('git', ['-C', repo, ...a], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const target = `story/${storyId}`;
    let hasGit = true;
    try { gitOut('rev-parse', '--git-dir'); } catch { hasGit = false; }
    // Una carpeta adentro de otro repo no es «sin git»: es el repo de otro. Ése no se toca (ni init ni rama).
    let ownRepo = !hasGit;
    if (hasGit) { try { ownRepo = fs.realpathSync(gitOut('rev-parse', '--show-toplevel')) === fs.realpathSync(repo); } catch { ownRepo = false; } }
    let current = null;
    if (hasGit) { try { current = gitOut('symbolic-ref', '--short', 'HEAD'); } catch { /* HEAD suelto: no se toca */ } }
    let unborn = !hasGit;
    if (hasGit) { try { gitOut('rev-parse', '--verify', '--quiet', 'HEAD'); } catch { unborn = true; } }
    if (ownRepo && (!hasGit || ['main', 'master'].includes(current) || (unborn && current && current !== target))) {
      let exists = false;
      if (hasGit) { try { gitOut('rev-parse', '--verify', '--quiet', `refs/heads/${target}`); exists = true; } catch { /* no existe */ } }
      if (exists) {
        pauses.push({ id: 'PIPE-C1-branch-guard', detail: `Estás en '${current}' y la rama de esta historia, '${target}', ya existe — NO la piso ni cambio a ella solo. Pasá a esa rama (o borrala) y re-corré start.` });
      } else {
        firstTimeGit = { init: !hasGit, unborn, target };
      }
    }
  }
  // Una carpeta sin NINGÚN git (ni ella ni de arriba) se inicia aunque la historia no traiga la marca: ahí
  // no hay rama de otra sesión que pisar, que es por lo que la marca hace falta. Sin esto, una historia escrita a mano
  // llegaría al commit sin git, con el chequeo de dependencias salteado sin aviso. No en la carpeta personal, ni en la raíz,
  // ni con la historia afuera: ahí pausa y da el comando a mano.
  if (!firstTimeGit && !firstTimeOk) {
    let hasGit = true;
    try { execFileSync('git', ['-C', repo, 'rev-parse', '--git-dir'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }); } catch { hasGit = false; }
    if (!hasGit) {
      const target = `story/${storyId}`;
      const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
      const repoReal = real(repo);
      const storyReal = real(storyPath);
      const aMano = `git -C "${repo}" init && git -C "${repo}" symbolic-ref HEAD refs/heads/${target}`;
      let porque = null;
      if (repoReal === real(os.homedir())) porque = 'es tu carpeta personal';
      else if (repoReal === path.parse(repoReal).root) porque = 'es la raíz del disco';
      else if (path.relative(repoReal, storyReal).startsWith('..') || path.isAbsolute(path.relative(repoReal, storyReal))) porque = 'la historia está fuera de esa carpeta';
      if (porque) {
        pauses.push({ id: 'PIPE-C1-sin-git', detail: `La carpeta ${repo} no tiene git y no lo inicio solo: ${porque}. Si es la carpeta del proyecto, inicialo a mano y volvé a correr start: ${aMano}` });
      } else {
        firstTimeGit = { init: true, unborn: true, target, sinMarca: true };
      }
    }
  }
  if (branch && ['main', 'master'].includes(branch) && !firstTimeGit && !pauses.some((p) => p.id === 'PIPE-C1-branch-guard')) {
    const aMano = firstTimeMark && !firstTimeOk
      ? ' La marca `origin: first-time` de esta historia no la puso el guion del modo primera vez (no hay constancia): el recorrido no cambia de rama solo.'
      : '';
    pauses.push({ id: 'PIPE-C1-branch-guard', detail: `Estás en rama protegida '${branch}' — NO implementar acá. Creá/checkout una rama de trabajo primero.${aMano}` });
  }

  // PIPE-C5 (lectura): una historia en borrador no está validada; la pasa a ready-for-dev quien corre el validador.
  // El estado se lee como lo lee el freno de historia (statusOf): si leyeran distinto, un borrador arrancaría como listo.
  let draftStatus = String(fm.status || '').toLowerCase() === 'draft';
  try { draftStatus = draftStatus || require('./story-skill-gate.js').isDraftStatus(require('./story-skill-gate.js').statusOf(fs.readFileSync(storyPath, 'utf8'))); } catch (e) {
    actions.push(`PIPE-C5-draft: no pude leer el estado como lo lee el freno (${e.message}); vale sólo el del frontmatter`);
  }
  if (draftStatus) {
    pauses.push({
      id: 'PIPE-C5-draft',
      detail: `La historia está en borrador (status: draft): no está validada. Corré el validador de historias (tycon-story-validator) sobre ${storyPath} y, si pasa, pasala a ready-for-dev; después volvé a correr start.`,
    });
  }

  // PIPE-C5 (lectura): pipeline abandonado. Una paraguas en curso con su tanda no lo es: otra tanda la arrancó antes. Y el
  // marcador propio de esta misma story tampoco: es la corrida viva que se retoma (re-correr `start`).
  const propioDeEstaStory = (() => { const p = readSessionMarker(); return !!p && String(p.storyId) === String(storyId); })();
  if (fm.status === 'in-progress' && !others.length && !tanda && !propioDeEstaStory) {
    pauses.push({
      id: 'PIPE-C5-abandoned',
      detail: `La story ya está status: in-progress sin pipeline activo en otra sesión — probable pipeline abandonado (sesión que murió sin cerrar).`,
      options: 'retomar desde el último step (pipeline.js next tras adopt/re-set del marker) / resetear status y arrancar fresh',
    });
  }

  if (firstTimeGit && !pauses.length) {
    const { init, unborn, target, sinMarca } = firstTimeGit;
    try {
      const run = (...a) => execFileSync('git', ['-C', repo, ...a], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (init) run('init', '-q');
      // Sin commits no hay desde dónde ramificar: se nombra la rama de HEAD, y el primer commit nace en ella.
      if (init || unborn) run('symbolic-ref', 'HEAD', `refs/heads/${target}`);
      else run('switch', '-q', '-c', target);
      branch = target;
      actions.push(sinMarca
        ? `PIPE-C1: tu carpeta no tenía git: lo inicié (git init) y creé la rama ${target} (lo que había sigue igual, sin commitear).`
        : `PIPE-C1: historia de primera vez → ${init ? 'git init y ' : ''}rama ${target} creada y activa (lo que no estaba commiteado sigue en el árbol).`);
    } catch (e) {
      const aMano = init ? ` A mano: git -C "${repo}" init && git -C "${repo}" symbolic-ref HEAD refs/heads/${target}` : '';
      pauses.push({ id: 'PIPE-C1-branch-guard', detail: `No pude preparar la rama ${target} para ${sinMarca ? 'esta historia' : 'la historia de primera vez'}: ${String(e.stderr || e.message || e).trim().split('\n')[0]}. Creala a mano y re-corré start.${aMano}` });
    }
  }

  // PIPE-C2: .gitignore fix (mutación segura e idempotente — se hace siempre).
  // 🔴 Y también sobre el repo de la STORY cuando es otro: la evidencia de
  // cierre nace ahí (ver `evidenceDirForStory`), así que ese `.gitignore` es el que decide si
  // viaja. Un repo de specs con `.advisors/` a secas se tragaría la evidencia y el portón daría rojo.
  const evid = evidenceDirForStory(storyPath, repo);
  const reposGitignore = [repo];
  if (evid.crossRepo && evid.storyRepo) reposGitignore.push(evid.storyRepo);
  for (const r of reposGitignore) {
    try {
      const giPath = path.join(r, '.gitignore');
      const gi = readText(giPath);
      const { append, notices } = computeGitignoreNeeds(gitIgnoraProbe(r));
      const donde = r === repo ? '' : ` (repo de la story: ${r})`;
      if (append.length) {
        fs.appendFileSync(giPath, gitignoreAppendText(gi, append), 'utf8');
        actions.push(`PIPE-C2: agregado a .gitignore${donde}: ${append.filter((l) => !l.startsWith('#')).join(', ')}`);
      }
      for (const n of notices) actions.push(donde ? `${n}${donde}` : n);
    } catch (e) {
      actions.push(`PIPE-C2: no pude agregar al .gitignore de ${r} (${e.code || String(e.message || e).split('\n')[0]}): revisalo a mano`);
    }
  }
  if (evid.crossRepo) {
    actions.push(`EVIDENCIA-EN-REPO-DE-LA-STORY: la story vive en ${evid.storyRepo} y el código en ${repo} → `
      + `toda la evidencia de cierre (macro, gate E2E, smoke-run) va a ${evid.dir}, que es donde el `
      + 'portón de CI la va a buscar. Resolvela con `pipeline.js evidence-dir --story <spec> --repo <repo> --plain`.');
  } else if (evid.warning) {
    actions.push(`⚠️ EVIDENCIA: ${evid.warning}`);
  }

  // PIPE-C4 (lectura): esta sesión tiene a medias la ejecución de otra story. Reemplazarla borraría sus pasos y sus
  // controles: se decide a propósito (`marker.js set` lo frena igual, sin `--replace`).
  {
    const actual = readSessionMarker();
    const hechos = actual && Array.isArray(actual.stepsCompleted) ? actual.stepsCompleted.length : 0;
    if (actual && String(actual.storyId) !== String(storyId) && hechos > 0) {
      pauses.push({
        id: 'PIPE-C4-otra-ejecucion',
        detail: `Esta sesión tiene a medias la ejecución de la story ${actual.storyId} (${hechos} paso(s) hecho(s)). Para arrancar la ${storyId}, primero cerrala o abandonala a propósito: marker.js clear y re-corré start.`,
      });
    }
  }

  // Lo que falta antes de arrancar: sale con pausas y sin ellas, y no frena.
  const faltasNoMedidas = [];
  const faltas = computeMissingBeforeStart({ repo, fm, noMedido: faltasNoMedidas });
  const faltasOut = faltas.length ? { missing_before_start: faltas } : {};
  if (faltas.length) actions.push(missingBeforeStartLine(faltas));
  if (faltasNoMedidas.length) actions.push(`Falta antes de arrancar: no pude mirar ${faltasNoMedidas.join(' ni ')}; no es «está todo»`);

  if (pauses.length) {
    return { ready: false, story_id: storyId, branch, pauses, ...faltasOut, actions_done: actions, ...(warnings.length ? { warnings } : {}), note: 'NADA mutado (salvo .gitignore idempotente). Resolvé las pausas y re-corré start.' };
  }

  // el tamaño de la corrida y su tiempo estimado, ANTES de lanzar nada; quedan en el marcador.
  const sizeCls = computeRunSize({ story: storyPath, repo, runSize: args.runSize });
  const est = runSizeLib.estimate({ size: sizeCls.size, historyDir: path.join(stateDirOf(os.homedir()), 'timing-history') });
  const runSize = { size: sizeCls.size, reason: sizeCls.reason, estimate_min: est.minutes, estimate_source: est.source };
  actions.push(`TAMAÑO: corrida ${runSize.size} (${runSize.reason}) · estimado ${runSize.estimate_min} min (${runSize.estimate_source})`);

  // PIPE-C4: marker set (vía marker.js — único owner de writes del marker).
  const markerJs = markerInstalado();
  let tandaFallida = null;
  // Una ejecución nueva nace con los pasos por nombre (esquema 2). Retomar la misma story sobre un marcador viejo lo
  // deja viejo: no se reescribe a mitad de ejecución.
  const previo = readSessionMarker();
  const sigueVieja = !!previo && String(previo.storyId) === String(storyId) && STEPS_TABLE.schemeOf(previo) === 1;
  // La carpeta de la ejecución nace acá: guarda la copia de la apertura (lib/open-runs.js). Sin carpeta no hay apertura,
  // y una ejecución sin apertura no se vería al perder el marcador: el arranque frena.
  // Una corrida, una carpeta: retomar la misma story reusa la de su marcador (o la de su apertura, si el marcador es de
  // antes de anotarla); si no, la corrida nueva crea la suya, aunque la story ya tenga otras (otra tanda, o reabierta).
  // Sin carpeta no se escribe el marcador: no arranca una corrida sin carpeta propia.
  let runDir = null;
  const rdLib = require('./run-dir.js');
  if (previo && String(previo.storyId) === String(storyId)) {
    const d = rdLib.carpetaDelMarcador(previo, storyId, repo, { create: true });
    if (d.dir) runDir = d.dir;
    else if (d.motivo) actions.push(`CARPETA: ${d.motivo}; abro una nueva`);
  }
  if (!runDir) {
    try { runDir = rdLib.createRunDir(repo, storyId, storyPath); } catch (e) {
      return { ready: false, story_id: storyId, pauses: [{ id: 'apertura-failed', detail: `no pude crear la carpeta de la ejecución (${e.message}); sin ella la ejecución no queda anotada como abierta. No escribí el marcador.` }], actions_done: actions };
    }
    if (!runDir) {
      return { ready: false, story_id: storyId, pauses: [{ id: 'apertura-failed', detail: `no pude calcular la clave de la carpeta de la ejecución (${runDirKey(storyId, storyPath).error || 'sin motivo'}); sin carpeta propia la ejecución no arranca. No escribí el marcador.` }], actions_done: actions };
    }
  }
  const esquema = sigueVieja
    ? { stepsPending: [0, 1, 2, 3, 4, 5, 6, 7, 8], arranque: '0' }
    // los que se cierran con su bandera no van en la lista: ninguna bandera la vacía, y una ejecución terminada tiene que
    // quedar con la lista vacía para todos los que la miran (como el pase adversarial y la prueba en vivo en el marcador viejo)
    : { stepScheme: STEPS_TABLE.SCHEME, stepsPending: STEPS_TABLE.STEPS.filter((s) => !s.flag).map((s) => s.id), arranque: 'start' };
  try {
    // marker.js con el mismo Node que corre este programa, no el del PATH
    execFileSync(process.execPath, [markerJs, 'set', JSON.stringify({
      ...(esquema.stepScheme ? { stepScheme: esquema.stepScheme } : {}),
      // storyPath ABSOLUTO: si `start` lo validara contra el cwd y el marker lo guardara
      // crudo, on-advisor-run.js y marker.js lo resolverían contra repoPath — coinciden sólo si
      // cwd == --repo. Con `--repo backend --story project/specs/x.md` desde el padre, la proyección
      // del roster resolvería un path inexistente y callaría con "mismo repo". Todo lector acepta absolutos.
      storyId, storyPath: path.resolve(storyPath), repoPath: repo, runDir, sprint: fm.sprint ? parseInt(fm.sprint, 10) || null : null,
      // Dónde nace la evidencia de cierre: el repo de la story, aunque el código
      // esté en otro. Lo leen los pasos «Probar en vivo» y «Preparar el commit» para no tener que adivinarlo.
      evidenceDir: evid.dir || null,
      // Commit de partida: la base de las «líneas tocadas» que mide test-gate.sh.
      // Sin git queda null y test-gate cae a HEAD diciéndolo.
      baseSha: (() => {
        try { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null; } catch (e) {
          // No frena el arranque (test-gate cae a HEAD y lo dice), pero no se calla.
          actions.push(`⚠️ BASE DE COBERTURA: no pude leer el commit de partida (${String((e.stderr || e.message || e)).trim().split('\n')[0]}); test-gate medirá contra HEAD`);
          return null;
        }
      })(),
      stepsPending: esquema.stepsPending,
      // las vueltas de revisores son de esta ejecución: una ejecución anterior de la misma sesión no las hereda
      iterations: {},
      size: runSize.size, size_reason: runSize.reason, estimate_min: runSize.estimate_min, estimate_source: runSize.estimate_source,
      // el modelo de la sesión tal como vino (el registro de revisores lo usa antes que la conversación) y, en Codex, la
      // sesión con su proveedor: los revisores que lanza `reviewers-run` corren con el mismo
      ...(args.sessionModel ? { sessionModel: args.sessionModel } : {}),
      ...(args.codexSession ? { codexSession: args.codexSession } : {}),
      ...(parallelWith ? { parallelWith } : {}),
    })], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync(process.execPath, [markerJs, 'complete-step', esquema.arranque], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    logRunStart(storyId);
    // La apertura en el registro y su copia en la carpeta, después del marcador: con las tres piezas, si falta una, la
    // ejecución frena como perdida (lib/open-runs.js). Retomar la misma historia sobrescribe la copia.
    try {
      require('./open-runs.js').abrir({ sid: resolveSessionId(), story: storyId, storyPath: path.resolve(storyPath), repo, runDir });
    } catch (e) {
      return { ready: false, story_id: storyId, pauses: [{ id: 'apertura-failed', detail: `no pude anotar la apertura de la ejecución (${e.message}); el marcador quedó puesto, pero sin apertura no se vería al faltar` }], actions_done: actions };
    }
    actions.push(`PIPE-C4: marker seteado (Arranque cerrado${sigueVieja ? '; sigue el marcador viejo de esta ejecución' : ''})`);
    // la tanda, después del marcador: si no se puede anotar, el marcador queda sin tanda y la salida lo pausa
    if (tanda) {
      const r = anotarTanda(tanda.nombre);
      if (r.ok) actions.push(`TANDA: anotada ${tanda.nombre} (marker.js set-batch)`);
      else tandaFallida = pausaSinTanda(tanda.nombre, r.motivo);
    }
  } catch (e) {
    return { ready: false, story_id: storyId, pauses: [{ id: 'marker-set-failed', detail: String(e.message || e) }], actions_done: actions };
  }

  // PIPE-C5 (escritura): status → in-progress.
  try {
    execFileSync(process.execPath, [markerJs, 'update-story-status', storyPath, 'in-progress'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    actions.push('PIPE-C5: frontmatter status → in-progress');
  } catch (e) {
    actions.push(`PIPE-C5 FALLÓ (no bloqueante): ${String(e.message || e)}`);
  }

  if (args.autonomous) {
    try {
      execFileSync(process.execPath, [markerJs, 'set-autonomous', 'true'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      actions.push('PIPE-C6: modo autónomo Nivel 1 ACTIVO (default ON · Stop-gate DoD). Pánico: touch ~/.claude/.tycon-pipeline/STOP_AUTONOMY');
    } catch { /* ignore */ }
  } else {
    actions.push('PIPE-C6: modo autónomo OFF (--no-autonomous o TYCON_PIPELINE_NO_AUTONOMOUS=1) → HITL puro');
  }

  // PIPE-C7 (discoverability): si el repo tiene specs Playwright pero NO declaró su
  // gate E2E en .tycon/advisors.yaml → avisar FUERTE acá (si no, el pipeline saltearía los E2E
  // en silencio y el tier crítico no frenaría el merge). El orquestador relaya el warning al user.
  const e2eCfg = e2eConfig(args.repo);
  if (e2eCfg.gap) actions.push(`⚠️ PIPE-C7 E2E-GAP — ${e2eCfg.warning}`);

  // Revalidación de specs viejas: `fm` es el frontmatter leído ARRIBA, antes de que PIPE-C5 pise el
  // status a in-progress — o sea que refleja cuánto tiempo estuvo la story esperando de verdad.
  const stale = computeSpecStaleness(fm, Date.now());
  if (stale) actions.push(`⚠️ SPEC-STALE — ${stale.aviso}`);

  return {
    // la tanda que no se pudo anotar: el arranque quedó hecho, y la salida pausa con el comando a mano
    ready: !tandaFallida,
    ...(tandaFallida ? { pauses: [tandaFallida] } : {}),
    story_id: storyId,
    branch,
    run_size: runSize,
    risk: computeRiskClass({ story: storyPath, files: [], repo, runSize: args.runSize }),
    model_hint: computeModelHint({ story: storyPath, files: [], repo, runSize: args.runSize, orgModels: args.orgModels, sessionModel: args.sessionModel }),
    // El modelo de los ayudantes sueltos, con configuración de la organización o pedido
    ...((args.orgModels && args.orgModels.declared) || args.modelRequests
      ? { models: { helpers: MODELOS.resolveHelpers({ org: args.orgModels && args.orgModels.declared ? args.orgModels.data : null, requests: args.modelRequests }) } }
      : {}),
    tooling: computeToolingExpected(repo),
    ...faltasOut,
    actions_done: actions,
    ...(warnings.length ? { warnings } : {}),
    e2e_gap: e2eCfg.gap ? e2eCfg.warning : null,
    spec_stale: stale,
    next: 'pipeline.js next te dice el próximo paso (el aviso de trabajo, el pedido en ADO o validar la story)',
  };
}

/**
 * Recorta la salida de `start` a lo que el orquestador realmente consume, y deja el JSON ENTERO en
 * un archivo cuya ruta viaja en la salida.
 *
 * Por qué: `start` devuelve ~4 KB de los que el orquestador usa una docena de campos — y ese texto
 * vuelve a entrar en contexto en CADA respuesta posterior del turno. Medido en un análisis de tokens:
 * el 10 % de lo releído es el texto de las propias llamadas del agente.
 *
 * 🔴 Recortar NO es perder: sin la ruta del archivo, el que necesite el detalle vuelve a correr
 *    `start` — y `start` MUTA (frontmatter de la story, marker, .gitignore). Por eso `completo`
 *    es parte del contrato, no un extra.
 * 🔴 El código de salida NO cambia: lo gatea el llamador (`ready ? 0 : 1`) y el recorte no opina.
 * 🔴 Sin el flag, `start` se comporta EXACTAMENTE como siempre — hay orquestadores ya escritos
 *    contra la forma vieja. El contrato viejo y el nuevo conviven; los dos tienen su caso en
 *    `tests/large-output.test.js`.
 */
function recortarStart(result) {
  let completo = null;
  try {
    const dir = path.join(stateDirOf(os.homedir()), 'salidas');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    completo = path.join(dir, `start-${result.story_id || 'sin-story'}-${ts}.json`);
    fs.writeFileSync(completo, JSON.stringify(result, null, 2) + '\n');
  } catch {
    // Fail-open: si no se pudo escribir el detalle, el modo breve no se lo come — devuelve el
    // objeto entero, que es peor en tokens pero nunca peor en información.
    return result;
  }

  const breve = { ready: result.ready, story_id: result.story_id, branch: result.branch };
  if (result.pauses && result.pauses.length) {
    breve.pauses = result.pauses.map((p) => ({ id: p.id, detail: p.detail }));
  }
  if (result.risk) {
    breve.riesgo = result.risk.risk;
    if (result.risk.risk === 'NORMAL') {
      breve.riesgo_por = (result.risk.criteria || []).filter((c) => !c.pass).map((c) => c.name);
    }
  }
  if (result.run_size) {
    breve.tamano = result.run_size.size;
    breve.tamano_por = result.run_size.reason;
    breve.estimado_min = result.run_size.estimate_min;
    breve.estimado_de = result.run_size.estimate_source;
  }
  if (result.models) breve.models = result.models;
  if (result.models_problem) breve.models_problem = result.models_problem;
  if (result.models_warnings) breve.models_warnings = result.models_warnings;
  if (result.models_provider) breve.models_provider = result.models_provider;
  if (result.model_hint) {
    breve.modelo = result.model_hint.recommended_session_model;
    breve.effort = result.model_hint.effort || null;
    if (result.model_hint.session_check) breve.session_check = result.model_hint.session_check;
    if (result.model_hint.session_warning) breve.session_warning = result.model_hint.session_warning;
  }
  if (result.tooling && Array.isArray(result.tooling.expected)) {
    // Sólo los NOMBRES: el orquestador es el único que puede saber cuáles tiene en su sesión, y el
    // cómo-levantarlo (que es el grueso del texto) vive en el archivo.
    breve.tools_esperadas = result.tooling.expected.map((x) => x.name);
    // Las skills de terceros que faltan: ésas sí las sabe el script, con su acción.
    const missing = result.tooling.expected.filter((x) => (x.kind === 'skill' || x.kind === 'manifest') && x.present === false);
    if (missing.length) breve.skills_faltantes = missing.map((x) => `${x.name} → ${x.action}`);
  }
  if (result.missing_before_start) breve.missing_before_start = result.missing_before_start;
  if (result.e2e_gap) breve.e2e_gap = result.e2e_gap;
  if (result.spec_stale) breve.spec_stale = result.spec_stale;
  breve.acciones = result.actions_done || [];
  // la copia propia (PIPE-C10) y los avisos de otra sesión viva: el agente tiene que verlos sin abrir el JSON entero
  if (result.work_copy) breve.work_copy = result.work_copy;
  if (result.warnings && result.warnings.length) breve.warnings = result.warnings;
  breve.next = result.next || result.note || null;
  breve.completo = completo;
  return breve;
}

// ── pipeline.js tooling-expected — aviso de tooling no disponible ──
// El pipeline ASUME herramientas del harness (CodeGraph para symbol lookup, engram
// para memoria persistente, la tool Workflow para el pase adversarial). Si están declaradas pero
// NO disponibles en la sesión, el orquestador degrada a fallbacks (grep / sin
// memoria / sin pase adversarial), y sin aviso el user no se entera
// de que el run corre más lento o con menos cobertura. Contrato (PIPE-C9):
// este script detecta la EXPECTATIVA (mecánica, verificable); la disponibilidad
// real del MCP/tool la conoce SOLO el orquestador (las tools viven en su harness,
// no en el shell) → él la verifica y AVISA al user ANTES de degradar.
// ── Las skills de terceros que el pipeline invoca por nombre ──
// Lo ajeno sale de agent-skills y lo restituye el paso del instalador desde el manifiesto del arnés
// (scripts/publishing/third-party-skills.json). Si una skill que el pipeline invoca (los pasos «Armar el plan» e «Implementar», el portón de
// stories, el paso de revisores a pedido) no está, el pipeline no puede enterarse en silencio: se suma al tooling esperado con
// `present` y la acción. Sin manifiesto legible, una entrada que lo dice. opts: { skillsDir, manifestPath } (pruebas).
// El manifiesto vive en scripts/publishing; una copia atrasada del arnés lo tiene en scripts/publicacion (un `.json` no tiene reemplazo):
// primero publishing, luego publicacion; sin ninguna, publishing (el aviso la nombra).
function thirdPartyManifestPath(harnessDir) {
  if (!harnessDir) return null;
  const at = (dir) => path.join(harnessDir, 'scripts', dir, 'third-party-skills.json');
  if (fs.existsSync(at('publishing'))) return at('publishing');
  if (fs.existsSync(at('publicacion'))) return at('publicacion');
  return at('publishing');
}
function expectedThirdPartySkills(opts = {}) {
  const skillsDir = opts.skillsDir || path.resolve(estadoPipeline.SCRIPTS_DIR, '..', '..');
  let manifestPath = opts.manifestPath;
  if (!manifestPath) manifestPath = thirdPartyManifestPath(require('./harness-path.js').rutaArnesHook().dir);
  const common = {
    mcp_prefix: null, binary_found: null, cli_fallback: null,
    fallback: 'el paso del pipeline que la invoca no puede cargarla: se frena ahí o se sigue sin ella, con el dev avisado',
  };
  let m = null;
  let problem = manifestPath ? null : 'no encontré el arnés (TYCON_GUIDES_DIR o el enlace ~/.claude/tycon-harness)';
  if (!problem) {
    try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { problem = `no pude leer ${manifestPath} (${e.code || 'JSON inválido'})`; }
  }
  if (problem || !m || !Array.isArray(m.third_party)) {
    return [{
      ...common, name: 'third-party-manifest', kind: 'manifest', present: false,
      why: `manifiesto de skills de terceros ilegible: ${problem || 'sin la lista third_party'} — no puedo decir si están las skills que invoca el pipeline`,
      action: 'actualizá el arnés (harness.js update; en un clon, git pull) y corré su instalador',
      raise_it: 'AVISAR al user en 1 línea: sin manifiesto no se sabe si faltan skills de terceros; seguir.',
      if_unavailable: 'AVISAR al user en 1 línea y seguir: es una advertencia, no un freno.',
    }];
  }
  const usedByPipeline = (e) => Array.isArray(e.used_by) && e.used_by.includes('tycon-pipeline');
  const wanted = [
    ...m.third_party.filter(usedByPipeline).map((e) => ({ e, derived: false })),
    ...(Array.isArray(m.derived) ? m.derived : []).filter((d) => d.repo === 'agent-skills' && usedByPipeline(d)).map((e) => ({ e, derived: true })),
  ];
  return wanted.map(({ e, derived }) => {
    const name = path.basename(e.target);
    const present = fs.existsSync(path.join(skillsDir, name, 'SKILL.md'));
    const action = present ? null
      : e.install === 'official-plugin' ? `instalá el plugin oficial: /plugin install ${e.plugin}`
        : derived ? 'es del equipo y viaja en agent-skills: actualizalo (harness.js update; en un clon, git pull) y corré el instalador del arnés'
          : 'corré el instalador del arnés (install-tycon-hooks.sh): la restituye desde el manifiesto de terceros';
    return {
      ...common, name: `skill:${name}`, kind: 'skill', present, action,
      why: `tycon-pipeline la invoca por nombre (manifiesto de terceros: ${derived ? 'derivada' : e.install})`,
      raise_it: present ? 'nada que hacer' : `AVISAR al user en 1 línea: falta la skill ${name} → ${action}`,
      if_unavailable: `AVISAR al user en 1 línea ANTES del paso que la invoca: "falta la skill ${name}" y la acción.`,
    };
  });
}

/**
 * Las integraciones según el lector de configuración del arnés (`{ ado: false, engram: true, … }`), o `null` si no se
 * puede saber: arnés no encontrado, arnés sin lector o con uno anterior a las integraciones, configuración rota. Quien
 * llama trata `null` como todo esperado: no saber no es «apagada».
 * @param {object} [opts] env (default process.env) · home (default os.homedir())
 */
function harnessIntegrations(opts = {}) {
  const env = opts.env || process.env;
  const dir = require('./harness-path.js').rutaArnesHook({ env, home: opts.home }).dir;
  if (!dir) return null;
  const reader = path.join(dir, 'scripts', 'lib', 'tycon-config.js');
  if (!fs.existsSync(reader)) return null;
  try {
    const cfg = require(reader);
    if (typeof cfg.leer !== 'function' || typeof cfg.integraciones !== 'function') return null;
    const all = cfg.integraciones(cfg.leer({ env, home: opts.home }));
    return all && typeof all === 'object' ? all : null;
  } catch (_) { return null; }   // rota o lector que no carga: la configuración la reclama el instalador; acá, todo esperado
}

/**
 * Lo que la ejecución va a necesitar y esta máquina no tiene, antes de arrancar: `[{ id, falta, sin_eso, como }]`, vacía
 * si está todo. Dos cosas: el programa de la plataforma del pedido de trabajo (la primera palabra de los `rawCommands`
 * del conector que elige la capa: el núcleo no nombra herramientas), con la misma condición con que `next` pide esa
 * parte; y el servidor MCP de la herramienta de horas elegida, donde lo lee Claude Code. Un detector que no puede
 * preguntar no inventa una falta: deja su motivo en `noMedido`. Nunca frena.
 * @param {object} o repo · fm (frontmatter de la historia) · env · home · noMedido (lista donde quedan los detectores
 *   que no pudieron mirar, con su motivo)
 */
function computeMissingBeforeStart({ repo, fm, env = process.env, home = os.homedir(), noMedido = [] }) {
  const out = [];
  const motivo = (e) => (e && e.code) || String((e && e.message) || e).split('\n')[0];

  try {
    const lib = path.join(packsLib.raizAgentSkills(), 'scripts', 'lib', 'platform');
    if (require(path.join(lib, 'work-item-field.js')).idOf(fm)) {
      const platform = require(path.join(lib, 'platform.js'));
      const elegida = platform.choose('work-item.update', { env, home });
      const m = elegida.ok ? platform.connector(elegida.value.connector, env).manifest : null;
      const prog = m && m.rawCommands && m.rawCommands.length ? String(m.rawCommands[0]).trim().split(/\s+/)[0] : null;
      if (prog && !require('./portable-tools.js').findBinary(prog, { env })) {
        out.push({
          id: 'plataforma',
          falta: `\`${prog}\` en el PATH (lo usa el conector de ${m.label} para el pedido de trabajo de la historia)`,
          sin_eso: 'la parte del pedido de trabajo se declara con `marker.js start-warning ado "<motivo>"` y el pipeline sigue',
          como: `instalá \`${prog}\`, abrí una terminal nueva y volvé a correr start`,
        });
      }
    }
  } catch (e) { noMedido.push(`el programa de la plataforma (${motivo(e)})`); }

  // En Codex los servidores viven en su propia configuración, que despliega el instalador: acá no se mira.
  const esCodex = !!env.CODEX_SESSION_ID && !env.CLAUDE_CODE_SESSION_ID;
  try {
    const h = esCodex ? null : harnessWorkSignal({ env, home });
    let c = null;
    if (!esCodex) {
      if (!h) noMedido.push('el servidor MCP de la herramienta de horas (no encontré el evento de trabajo del arnés)');
      else if (h.loadError) noMedido.push(`el servidor MCP de la herramienta de horas (el evento de trabajo no carga: ${h.loadError})`);
      else {
        c = h.ws.chosen({ env, home });
        if (!c.config) { noMedido.push(`el servidor MCP de la herramienta de horas (${c.warning || 'la configuración no se lee'})`); c = null; }
      }
    }
    const server = c && c.manifest && c.manifest.mcp ? c.manifest.mcp.server : null;
    // Un archivo que no está no declara nada; uno que está y no se lee no dice que falte.
    const leer = (p) => {
      let texto;
      try { texto = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`${path.basename(p)}: ${e.code || e.message}`); }
      try { return JSON.parse(texto); } catch (e) { throw new Error(`${path.basename(p)} no es JSON válido`); }
    };
    if (server) {
      const cfg = leer(path.join(home, '.claude.json')) || {};
      const delRepo = leer(path.join(repo, '.mcp.json')) || {};
      // Claude Code guarda cada proyecto con la ruta real, con `/` en Windows, y la del repo principal en un worktree.
      const clave = (p) => { const s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };
      const candidatas = new Set([path.resolve(repo)]);
      try { candidatas.add(fs.realpathSync.native(repo)); } catch { /* sin ruta real: queda la resuelta */ }
      try {
        const comun = require('child_process').execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (path.basename(comun) === '.git') {
          candidatas.add(path.dirname(comun));
          try { candidatas.add(fs.realpathSync.native(path.dirname(comun))); } catch { /* idem */ }
        }
      } catch { /* sin git no hay repo principal que buscar */ }
      const buscadas = new Set([...candidatas].map(clave));
      const proyectos = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {};
      const deProyecto = Object.keys(proyectos).filter((k) => buscadas.has(clave(k))).map((k) => proyectos[k] && proyectos[k].mcpServers);
      const declarado = [cfg.mcpServers, ...deProyecto, delRepo.mcpServers]
        .some((s) => s && typeof s === 'object' && Object.prototype.hasOwnProperty.call(s, server));
      if (!declarado) {
        out.push({
          id: 'horas',
          falta: `el servidor MCP \`${server}\` de ${c.manifest.label}, la herramienta de horas de la organización`,
          sin_eso: 'la parte de horas se declara con `marker.js start-warning time-tracking "<motivo>"` y el pipeline sigue sin registrar',
          como: c.manifest.offer && c.manifest.offer.needs ? `${c.manifest.offer.needs}; registrado, abrí una sesión nueva` : 'registrá el servidor en Claude Code y abrí una sesión nueva',
        });
      }
    }
  } catch (e) { noMedido.push(`el servidor MCP de la herramienta de horas (${motivo(e)})`); }

  return out;
}

/** La línea de las acciones del arranque con lo que falta, o null. */
function missingBeforeStartLine(faltas) {
  return faltas.length ? `Falta antes de arrancar: ${faltas.map((f) => `${f.falta} → ${f.sin_eso}; ${f.como}`).join(' · ')}` : null;
}

/**
 * @param {string} repo
 * @param {object} [opts] skillsDir · manifestPath (las skills de terceros) · integrations: objeto del lector o `null`
 *   («no se sabe»), para las pruebas; sin la clave se le pregunta al arnés (`env` y `home` van a esa pregunta).
 */
function computeToolingExpected(repo, opts = {}) {
  const integrations = 'integrations' in opts ? opts.integrations : harnessIntegrations(opts);
  const integrationOff = (name) => !!integrations && integrations[name] === false;
  // `where` en Windows y `which` en Mac y Linux, sin ruta fija: con el `which` de Unix por su ruta, en
  // Windows todas las herramientas saldrían «no está». `opts.platform` y `opts.exec` son para las pruebas.
  const findBinary = (cmd) => require('./portable-tools.js').findBinary(cmd, { platform: opts.platform, exec: opts.exec });
  // CLIs conocidos: mismo índice/store que el MCP → sirven para ESTE run vía Bash
  // aunque el MCP server no haya levantado. `raise_install` re-cablea el MCP para
  // próximas sesiones (el server de una sesión ya iniciada solo se recarga con
  // /mcp o reiniciando la sesión — eso es acción del user, no del orquestador).
  const KNOWN_CLI = {
    codegraph: {
      bin: 'codegraph',
      cli: 'codegraph query "<símbolo>" | codegraph context "<task>" | codegraph status | codegraph affected — vía Bash, mismo índice que el MCP',
      // el instalador del arnés registra el servidor sin escribir en el repo; `codegraph install` deja .mcp.json, .claude/
      // y un enganche que corre en cada mensaje: no se recomienda
      raise_install: 'el instalador del arnés: bash scripts/setup/install-codegraph.sh desde la carpeta del arnés (en Windows, install-codegraph.ps1) — registra el servidor sin escribir en el repo; carga recién en la próxima sesión o tras /mcp',
    },
    'codebase_memory': {
      bin: path.join(os.homedir(), '.local', 'bin', 'codebase-memory-mcp'),
      cli: 'codebase-memory-mcp cli <tool> [json] — tools: search_graph, search_code, trace_path, get_code_snippet, get_architecture, index_status — vía Bash, mismo store que el MCP',
      raise_install: '`codebase-memory-mcp install` (re-cablea el MCP server) — carga en la próxima sesión o tras /mcp',
    },
    engram: {
      bin: 'engram',
      cli: 'engram search --project <name> "<query>" | engram sync --project <name> — vía Bash, mismo store',
      raise_install: null,
    },
  };
  const knownFor = (name) => KNOWN_CLI[name] || (String(name).startsWith('codegraph') ? KNOWN_CLI.codegraph : null);
  const raisePlaybook = (binFound, k) => binFound
    ? `INTENTAR LEVANTARLO — el binario ESTÁ (${binFound}): (1) para ESTE run usá el CLI vía Bash: ${(k && k.cli) || 'el CLI de la tool'}; (2) para dejar el MCP cargado: ${(k && k.raise_install) || 'revisar la config MCP del repo/proyecto'} — y AVISAR al user en 1 línea qué pasó y qué acción le queda a él (/mcp reconnect o reiniciar sesión).`
    : 'NO se puede levantar acá — el binario NO está en esta máquina: AVISAR al user con la acción concreta de instalación (codegraph: guides/integrations/codegraph-mcp.md; codebase_memory: conseguir el binario e instalar con `codebase-memory-mcp install`). Mientras tanto, fallback.';

  const expected = [];
  // CodeGraph se espera si el repo tiene su índice, o si la integración está prendida (la organización la usa): ahí,
  // una máquina sin el binario se avisa aunque el repo todavía no tenga `.codegraph/`
  const hasIndex = fs.existsSync(path.join(repo, '.codegraph'));
  if (hasIndex || (integrations && integrations.codegraph === true)) {
    const bin = findBinary(KNOWN_CLI.codegraph.bin);
    expected.push({
      name: 'codegraph',
      mcp_prefix: 'mcp__codegraph__',
      why: hasIndex
        ? `.codegraph/ presente en ${repo} — el repo tiene índice CodeGraph (regla del equipo: "CodeGraph primero" para todo lookup de símbolos)`
        : 'integrations.codegraph prendida — tu organización usa CodeGraph; el índice lo arma cada máquina (scripts/setup/install-codegraph)',
      binary_found: bin,
      cli_fallback: KNOWN_CLI.codegraph.cli,
      fallback: 'grep/Glob (más lento, sin call-graph ni impact analysis)',
      raise_it: raisePlaybook(bin, KNOWN_CLI.codegraph),
      if_unavailable: 'AVISAR al user en 1 línea ANTES de degradar: "el repo tiene CodeGraph pero el MCP no está en esta sesión". Después seguir `raise_it` (CLI si el binario está; instalación si no).',
    });
  }
  // engram se espera salvo que su integración esté apagada: afuera, sin la integración,
  // el arranque no avisa que falta una herramienta que nadie pidió.
  if (!integrationOff('engram')) {
    const bin = findBinary(KNOWN_CLI.engram.bin);
    expected.push({
      name: 'engram',
      mcp_prefix: 'mcp__plugin_engram_engram__',
      why: 'protocolo de memoria persistente SIEMPRE activo (guides/integrations/engram-workflow.md) — el paso «Armar el plan» inyecta gotchas previos del repo y el cierre guarda session_summary',
      binary_found: bin,
      cli_fallback: KNOWN_CLI.engram.cli,
      fallback: 'run sin memoria persistente (el paso «Armar el plan» pierde las lecciones previas; el cierre no guarda summary)',
      raise_it: raisePlaybook(bin, KNOWN_CLI.engram),
      if_unavailable: 'AVISAR al user en 1 línea ANTES de seguir: "engram MCP no disponible → este run pierde memoria persistente". Después seguir `raise_it` (el CLI engram cubre search/sync para este run).',
    });
  }
  expected.push({
    name: 'workflow-tool',
    mcp_prefix: 'Workflow',
    why: 'el paso «Pase adversarial» (adversarial deep-verify) corre vía la tool Workflow — sin ella el pase adversarial NO corre y se pierde la capa que cazó los bugs de E1',
    binary_found: null,
    cli_fallback: null,
    fallback: 'saltear el pase adversarial (cobertura reducida: solo los advisors single-pass)',
    raise_it: 'sin CLI alternativo (es una tool del harness) — si no está, PREGUNTAR al user si sigue sin el pase adversarial.',
    if_unavailable: 'AVISAR al user — esto NO es un skip silencioso legítimo: "la tool Workflow no está disponible → el pase adversarial no puede correr; la ejecución queda solo con los advisors single-pass. ¿Sigo igual?" El user decide.',
  });
  // Genérico: TODO MCP server que el
  // repo declare en su .mcp.json o en la config del proyecto (~/.claude.json →
  // projects[repo].mcpServers) es tooling esperado — cubre codebase_memory,
  // azure-devops, context7 y cualquier futuro sin tocar este script.
  const readJsonSafe = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const declared = {};
  const repoMcp = readJsonSafe(path.join(repo, '.mcp.json'));
  if (repoMcp && repoMcp.mcpServers) {
    for (const [n, cfg] of Object.entries(repoMcp.mcpServers)) declared[n] = { src: '.mcp.json del repo', command: (cfg && cfg.command) || null };
  }
  const userCfg = readJsonSafe(path.join(os.homedir(), '.claude.json'));
  const projCfg = userCfg && userCfg.projects && userCfg.projects[path.resolve(repo)];
  if (projCfg && projCfg.mcpServers) {
    for (const [n, cfg] of Object.entries(projCfg.mcpServers)) {
      if (!declared[n]) declared[n] = { src: 'config del proyecto (~/.claude.json)', command: (cfg && cfg.command) || null };
    }
  }
  for (const [name, info] of Object.entries(declared)) {
    if (expected.some((e) => e.name === name)) continue; // ya cubierto por una entry específica
    const k = knownFor(name);
    const bin = findBinary((k && k.bin) || info.command);
    expected.push({
      name,
      mcp_prefix: `mcp__${name}__`,
      why: `MCP server declarado en ${info.src} — el repo/equipo lo espera disponible`,
      binary_found: bin,
      cli_fallback: (k && k.cli) || null,
      fallback: 'depende de la tool (revisar qué step la usa)',
      raise_it: raisePlaybook(bin, k),
      if_unavailable: `AVISAR al user en 1 línea ANTES de degradar: "el repo declara el MCP ${name} pero no está disponible en esta sesión". Después seguir \`raise_it\`; si un step lo necesita y no hay fallback razonable → preguntar cómo seguir.`,
    });
  }
  expected.push(...expectedThirdPartySkills(opts));
  return {
    expected,
    note: 'El script detecta la EXPECTATIVA + si el BINARIO está (mecánico). La disponibilidad del MCP en el harness la verificás VOS (orquestador): tool esperada no disponible o que FALLA mid-run → avisar al user (1 línea) y seguir `raise_it` — CLI vía Bash si el binario está, aviso de instalación si no. Degradar en silencio = bug (PIPE-C9 / TOOL.i).',
  };
}

function cmdStart(cmd, args) {
  const conModelos = conModelosDeLaCorrida(args);
  const result = computeStart(conModelos);
  if (result.model_hint && result.model_hint.session_warning) process.stderr.write(`start: ${result.model_hint.session_warning}\n`);
  // Un pedido de saltear el pase al arrancar (la bandera, la variable o `deep_review: off`) no apaga nada. Con la
  // corrida abierta se anota la muestra y se dice cómo lo firma el dueño; sin ella no hay ejecución que firmar, y
  // la muestra la anota el portón del pase dentro de la corrida.
  const pedido = pedidoDeSalteo(args);
  if (pedido) {
    const ej = ejecucionDeLaCorrida(args, readSessionMarker());
    if (ej) {
      process.stderr.write(require('./adversarial-skip.js').muestra({ story: ej.story, carpeta: ej.carpeta, ejecucion: ej.ejecucion, camino: pedido }).texto);
    } else {
      process.stderr.write(`🔒 ${pedido} es un pedido de saltear el pase adversarial, no un salteo: sin la firma de una persona el pase corre.\n`
        + '   Todavía no hay una corrida abierta de esta story: la firma se pide cuando el portón del pase lo mire dentro de la corrida (pipeline.js deep-review-gate), que dice los comandos.\n');
    }
  }
  const proveedor = proveedorDeModelos(conModelos.orgModels);
  result.models_provider = proveedor.models_provider;
  decirModelos(result, conModelos.orgModels, [...((result.model_hint && result.model_hint._avisos) || []), ...proveedor.warnings]);
  const salida = args.breve ? recortarStart(result) : result;
  process.stdout.write(JSON.stringify(salida, null, 2) + '\n');
  // exitCode y no exit(): con la salida en un pipe, exit() corta lo que todavía no se
  // escribió. Con un arnés presente el JSON de `start` pasa los ~8 KB y llegaría truncado (large-output.test.js 5 y 8).
  process.exitCode = result.ready ? 0 : 1;
  return;
}

function cmdToolingExpected(cmd, args) {
  // PIPE-C9: qué tooling ESPERA el pipeline en este repo. El orquestador
  // cruza contra su harness real y avisa al user si algo esperado no está disponible.
  const result = computeToolingExpected(args.repo);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

module.exports = { cmdStart, cmdToolingExpected, gitignoreAppendText, computeMissingBeforeStart, thirdPartyManifestPath, computeSpecStaleness, computeToolingExpected };
