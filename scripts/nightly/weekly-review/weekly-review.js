#!/usr/bin/env node
'use strict';
/**
 * weekly-review.js — la revisión de la semana: un agente lee juntos los merges de siete días y propone un control por
 * cada patrón que se repite; decide una persona. Casos: scripts/tests/weekly-review.test.js.
 *
 * POR QUÉ EXISTE. Cada merge tiene su retro (el barrido de cada noche, retro-sweep.js), pero una retro mira un solo
 * merge: un error que vuelve en tres stories distintas no se ve desde ninguna. Esto los lee juntos, una vez por semana
 * (hace falta volumen para que un patrón sea real, y cuesta un séptimo de hacerlo a diario).
 *
 * QUÉ LEE. Los merges a main (primer padre) de los siete días anteriores a hoy en los repos de la organización
 * (`public`, `maintainers` y `operations` de team-repos.json, como el barrido), y de cada uno: el asunto, la story (de la
 * rama o de los commits), los mensajes de sus commits, los archivos que tocó, los `findings.json` de sus carpetas de
 * corrida, las líneas que agregó a `specs/*.md` y a `tasks/*.md`, y su archivo de retro (latido o con aprendizajes), que
 * puede estar en `.dashboard/` de cualquiera de los repos. Sin ninguna retro de la semana no llama al agente: sin el
 * barrido de cada noche (scripts/metrics/retro-sweep.js) no hay tanda. Lo que la lista declarada del barrido dice que no pide retro (`retro-sweep.json`: los
 * guardados de los nocturnos, las subidas de versión) no se lee ni cuenta contra el tope (`merges_salteados`). Lo que
 * no se pudo leer se dice: un merge a medias lleva `incompleto`, una retro ilegible o un repo sin mirar no dejan sellar.
 *
 * EL TOPE. Una sola corrida del agente, con el material recortado a `max_chars` (por defecto 600.000) y
 * `claude -p --max-budget-usd <budget_usd>` (por defecto 5): el tope en dólares lo corta la propia herramienta. Los dos
 * los fija la organización en `team-repos.json → weekly_review`. Primero entran los merges de
 * story; lo que no entra queda en `merges_no_leidos` y se dice: no se da por leído.
 *
 * LO QUE VUELVE SE VALIDA. Cada propuesta tiene que traer sus campos, una de las tres formas (regla, prueba, guía) y
 * merges que estén entre los leídos; y cumplir la regla de patrón: 3 o más merges de 2 o más stories distintas, contadas
 * acá (no las que dice el agente). La que no, se descarta y queda en el informe con el motivo.
 *
 * NUNCA APLICA NADA. Escribe dos archivos en el clon de mantenimiento (`--out`): las propuestas, al final de
 * `guides/guide-update-proposals.md`, y el informe, en `.dashboard/weekly-review/latest.json`. Viajan con un commit de
 * esas dos rutas y push con reintento (el camino del resultado del examen, periodic-exam.js). El resumen de la mañana
 * siguiente lee el informe (daily-summary.js --weekly).
 *
 * CUÁNDO. La llama periodic-exam.js, el disparador del examen en la máquina designada (martes y viernes 02:00), con
 * `--if-due`: corre si pasaron 6 días desde la última corrida completa (el sello se escribe al terminar; con 7, el martes
 * siguiente encuentra 6 días y 23 horas y se saltea). Apagado: TYCON_NO_WEEKLY_REVIEW=1, o `weekly_review.enabled: false`.
 *
 * Uso:
 *   node weekly-review.js --out <clon de mantenimiento> [--team-repos <team-repos.json>] [--repo <nombre>=<carpeta|url>]…
 *        [--org-config <team-repos.json>] [--clone-dir <dir>] [--max-chars N] [--budget <dólares>] [--model <modelo>]
 *        [--if-due] [--stamp <archivo>] [--no-push]
 *   --no-push escribe los dos archivos y no commitea ni empuja (la prueba en vivo). stdout: qué hizo.
 *   Salida: 0 hecho (con o sin propuestas, o sin retros, o no le tocaba) · 2 uso, o un repo que no se pudo mirar ·
 *   3 sin agente o con una respuesta que no se pudo leer · 5 no viajó.
 * Ambiente: TYCON_TODAY (la fecha, para pruebas) · TYCON_WEEKLY_REVIEW_NOW (la hora, para --if-due) ·
 *   TYCON_WEEKLY_REVIEW_AGENT (un guion de node que hace de agente: recibe el pedido por la entrada y contesta como
 *   `claude -p --output-format json`) · TYCON_NO_WEEKLY_REVIEW=1.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SWEEP = require(path.join(ROOT, 'scripts', 'metrics', 'retro-sweep.js'));
const RC = require(path.join(ROOT, 'scripts', 'lib', 'retro-coverage.js'));
const TEAM = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
const { readEnv } = require(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'));

const PROMPT = path.join(__dirname, 'prompt.md');
const GUIA = path.join('guides', 'guide-update-proposals.md');
const INFORME = path.join('.dashboard', 'weekly-review', 'latest.json');
const DAY = 86400000;
const PERIODO_DIAS = 6;
const FORMAS = { regla: 'regla', 'regla de revisor': 'regla', prueba: 'prueba', guia: 'guia', 'guía': 'guia', 'línea de guía': 'guia', 'linea de guia': 'guia' };
const NOMBRE_FORMA = { regla: 'regla de revisor', prueba: 'prueba', guia: 'línea de guía' };
// lo que se recorta de cada merge, para que uno solo no se coma el tope: con estos, un bloque mide ~1.000 caracteres,
// y una semana de varios cientos de merges de story entra casi entera en el tope por defecto.
const TOPE_COMMITS = 900;
const TOPE_AGREGADO = 1200;
const TOPE_ARCHIVOS = 15;
const TOPE_HALLAZGOS = 12;
const TOPE_MOTIVO = 120;

const stateDir = (() => {
  const lib = path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js');
  return fs.existsSync(lib) ? require(lib).stateDir(os.homedir()) : path.join(os.homedir(), '.claude', '.tycon-pipeline');
})();

function args(argv) {
  const a = { repos: [], out: null, teamRepos: null, orgConfig: null, clones: null, maxChars: null, budget: null, model: 'opus',
    ifDue: false, stamp: null, push: true, error: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) a.error = `${k} pide un valor`; return x; };
    if (k === '--repo') {
      const x = v() || '';
      const at = x.indexOf('=');
      if (at <= 0) a.error = `--repo pide <nombre>=<carpeta|url>: ${x}`; else a.repos.push({ nombre: x.slice(0, at), fuente: x.slice(at + 1) });
    } else if (k === '--out') a.out = v();
    else if (k === '--team-repos') a.teamRepos = v();
    else if (k === '--org-config') a.orgConfig = v();
    else if (k === '--clone-dir') a.clones = v();
    else if (k === '--max-chars') a.maxChars = Number(v());
    else if (k === '--budget') a.budget = Number(v());
    else if (k === '--model') a.model = v();
    else if (k === '--stamp') a.stamp = v();
    else if (k === '--if-due') a.ifDue = true;
    else if (k === '--no-push') a.push = false;
    else a.error = `opción desconocida: ${k}`;
  }
  if (!a.error && !a.out) a.error = 'falta --out (el clon de mantenimiento)';
  if (!a.error && a.maxChars !== null && !(Number.isInteger(a.maxChars) && a.maxChars > 0)) a.error = '--max-chars pide un entero';
  if (!a.error && a.budget !== null && !(a.budget > 0)) a.error = '--budget pide un monto en dólares mayor que 0';
  return a;
}

/** La configuración de la organización: `{ enabled, budget_usd, max_chars, aviso }`; sin archivo o con la clave mal escrita, la de por defecto. */
function orgConfig(file) {
  const def = { ...TEAM.WEEKLY_REVIEW_DEFAULTS, aviso: null };
  if (!file) return def;
  const r = TEAM.load(file);
  if (r.couldNotRead) return { ...def, aviso: `no pude leer ${path.basename(file)}: uso los valores por defecto` };
  const sec = r.sectionProblems && r.sectionProblems.weekly_review;
  if (sec && sec.length) return { ...def, aviso: `weekly_review mal escrita (${sec.map((p) => `${p.path}: ${p.message}`).join(' · ')}): uso los valores por defecto` };
  const w = (r.data && r.data.weekly_review) || {};
  return { enabled: w.enabled !== undefined ? w.enabled : def.enabled, budget_usd: w.budget_usd || def.budget_usd, max_chars: w.max_chars || def.max_chars, aviso: null };
}

function git(cwd, argv) {
  return spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8', timeout: 600000, maxBuffer: 256 * 1024 * 1024 });
}
const recortar = (t, n) => { const s = String(t || ''); return s.length > n ? `${s.slice(0, n)}…` : s; };
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * El número de story de un merge: de la rama del asunto («Merge pull request N from <prefijo>/<número>-<tema>»), del
 * título de un merge de Azure DevOps («Merged PR N: Story <número> — …»), de la retro, o de los commits
 * («docs(<número>): …»). Casos: scripts/tests/weekly-review.test.js T13.
 */
function storyDe(asunto, commits, retroStory) {
  const rama = /\bfrom\s+(\S+)/.exec(asunto || '');
  const m = rama && /(?:^|[/_-])(\d+\.\d+(?:\.\d+)?)(?=[-_/]|$)/.exec(rama[1]);
  if (m) return m[1];
  const azure = /^Merged PR \d+:.*?\bstory[\s-]+(\d+\.\d+(?:\.\d+)?)\b/i.exec(asunto || '');
  if (azure) return azure[1];
  if (typeof retroStory === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(retroStory)) return retroStory;
  const c = /^\w+\((\d+\.\d+(?:\.\d+)?)\)/m.exec(commits || '');
  return c ? c[1] : null;
}

/**
 * Los archivos de retro guardados en `.dashboard/` de main de un repo, por sha del merge que cubren. Sin `.dashboard/`
 * no hay nada (devuelve 0 ilegibles); un git que falla o un archivo que no es JSON NO es «no hay retro»: se cuentan
 * en `ilegibles` y el llamador lo dice.
 */
function retrosDe(dir, ref, into, ilegibles) {
  // `--verify --quiet` sale 1 cuando no está; cualquier otra cosa es un git que no pudo contestar
  const hay = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}:.dashboard`]);
  if (hay.status === 1) return;
  if (hay.status !== 0) { ilegibles.push(`${path.basename(dir)}: no se pudo ver si tiene .dashboard/ (${SWEEP.clean(String(hay.stderr).trim().split('\n').pop()) || `código ${hay.status}`})`); return; }
  const ls = git(dir, ['ls-tree', '-r', '--name-only', ref, '--', '.dashboard']);
  if (ls.status !== 0) { ilegibles.push(`${path.basename(dir)}: no se pudo listar .dashboard/ (${SWEEP.clean(String(ls.stderr).trim().split('\n').pop())})`); return; }
  const names = ls.stdout.split('\n').filter((f) => /\.json$/.test(f) && /metrics-/.test(path.basename(f)));
  if (!names.length) return;
  const cat = spawnSync('git', ['-C', dir, 'cat-file', '--batch'], { input: names.map((f) => `${ref}:${f}`).join('\n') + '\n', maxBuffer: 512 * 1024 * 1024 });
  if (cat.status !== 0) { ilegibles.push(`${path.basename(dir)}: no se pudieron leer sus ${names.length} retros (${SWEEP.clean(String(cat.stderr).trim().split('\n').pop())})`); return; }
  const buf = cat.stdout;
  let rotas = 0;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) break;
    const head = buf.slice(i, nl).toString('utf8').split(' ');
    if (head[1] !== 'blob') { i = nl + 1; continue; }
    const size = Number(head[2]);
    const body = buf.slice(nl + 1, nl + 1 + size).toString('utf8');
    i = nl + 1 + size + 1;
    let d;
    try { d = JSON.parse(body); } catch { rotas++; continue; }
    const sha = d && String(d.merge_commit || d.mergeCommit || d.commit || '');
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const tipo = RC.kindOf({ generatedBy: typeof d.generated_by === 'string' ? d.generated_by : null });
    const prev = into.get(sha);
    // una retro con aprendizajes gana sobre un latido del mismo merge
    if (prev && prev.tipo === 'aprendizajes' && tipo !== 'aprendizajes') continue;
    const resto = { ...d };
    for (const k of ['schema_version', 'repo', 'repo_path', 'repoPath', 'merge_commit', 'ts', 'captured_at', 'run_dir']) delete resto[k];
    // del latido sólo importa que exista: sus métricas son casi todas «no disponible»
    into.set(sha, { tipo, story: d.story || null, contenido: tipo === 'aprendizajes' ? recortar(JSON.stringify(resto), 2000) : null });
  }
  if (rotas) ilegibles.push(`${path.basename(dir)}: ${rotas} archivo(s) de retro no son JSON`);
}

/**
 * Los merges de la semana de un repo, con todo lo que se le pasa al agente. Los que la lista declarada del barrido dice
 * que no piden retro (los guardados de los nocturnos, las subidas de versión, los resultados del examen y de esta misma
 * revisión) no se leen: van a `salteados`, por motivo (decisión 14). Lo que no se pudo leer de un merge (un git que
 * falla, un `findings.json` roto) queda en su `incompleto`, y el agente lo ve: no es «no tiene».
 */
function mergesDe(repo, got, desde, hasta, reglas, salteados) {
  const log = git(got.dir, ['log', '--first-parent', `--since=${desde}T00:00:00`, `--until=${hasta}T00:00:00`, '--format=%H%x09%cI%x09%an%x09%P%x09%s', got.ref]);
  if (log.status !== 0) throw new Error(`no se pudo leer la historia: ${SWEEP.clean(log.stderr)}`);
  const out = [];
  for (const line of log.stdout.split('\n').filter(Boolean)) {
    const [sha, fecha, autor, padres, ...rest] = line.split('\t');
    const asunto = rest.join('\t');
    const motivo = SWEEP.exclusion(reglas, autor, asunto);
    if (motivo) { salteados[motivo] = (salteados[motivo] || 0) + 1; continue; }
    const incompleto = [];
    const ps = padres.split(' ').filter(Boolean);
    const rango = ps.length > 1 ? [`${ps[0]}..${sha}`] : ['-1', sha];
    const cl = git(got.dir, ['log', '--format=%an%x09%s%n%b%x00', ...rango]);
    if (cl.status !== 0) incompleto.push('commits');
    const autores = new Set([autor]);
    const commits = [];
    for (const c of (cl.stdout || '').split('\0').map((x) => x.trim()).filter(Boolean)) {
      const [quien, ...texto] = c.split('\t');
      autores.add(quien);
      commits.push(recortar(texto.join('\t').trim(), 300));
    }
    const base = ps[0] || `${sha}^`;
    let archivos = [];
    if (ps.length) {
      const nombres = git(got.dir, ['diff', '--name-only', base, sha]);
      if (nombres.status !== 0) incompleto.push('archivos'); else archivos = nombres.stdout.split('\n').filter(Boolean);
    }
    const hallazgos = [];
    for (const f of archivos.filter((x) => /^\.advisors\/pipeline-runs\/[^/]+\/findings\.json$/.test(x))) {
      let d;
      try { d = JSON.parse(git(got.dir, ['show', `${sha}:${f}`]).stdout); } catch { if (!incompleto.includes('hallazgos')) incompleto.push('hallazgos'); continue; }
      for (const h of Array.isArray(d) ? d : []) {
        if (hallazgos.length >= TOPE_HALLAZGOS) break;
        // una línea por hallazgo: regla, gravedad, qué se hizo y por qué
        if (h && typeof h === 'object') hallazgos.push(`${h.rule_id || '?'} ${h.severity || '?'} ${h.disposition || '?'}: ${recortar(h.reason, TOPE_MOTIVO)}`);
      }
    }
    let agregado = '';
    if (ps.length) {
      const d = git(got.dir, ['diff', '--unified=0', '--no-color', base, sha, '--', 'specs/*.md', 'tasks/*.md', 'specs/**/*.md', 'tasks/**/*.md']);
      if (d.status !== 0) incompleto.push('agregado');
      agregado = recortar((d.stdout || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n'), TOPE_AGREGADO);
    }
    out.push({ repo: repo.nombre, sha, fecha: fecha.slice(0, 10), asunto: recortar(asunto, 300), autores: [...autores],
      commitsTexto: recortar(commits.join('\n---\n'), TOPE_COMMITS), archivos, hallazgos, agregado, incompleto });
  }
  return out;
}

/** El bloque de un merge tal como lo lee el agente. */
function bloque(m) {
  return JSON.stringify({ repo: m.repo, sha: m.sha, fecha: m.fecha, story: m.story, asunto: m.asunto, commits: m.commitsTexto,
    archivos: m.archivos.slice(0, TOPE_ARCHIVOS).concat(m.archivos.length > TOPE_ARCHIVOS ? [`… y ${m.archivos.length - TOPE_ARCHIVOS} más`] : []),
    hallazgos: m.hallazgos, agregado: m.agregado, retro: m.retro ? { tipo: m.retro.tipo, ...(m.retro.contenido ? { contenido: m.retro.contenido } : {}) } : null,
    ...(m.incompleto && m.incompleto.length ? { incompleto: m.incompleto } : {}) });
}

/**
 * El orden en que entran al tope: primero los de story, por vueltas —el primer merge de cada story, después el segundo de
 * cada una, y así—, para que con una semana más grande que el tope estén todas las stories antes que el quinto merge
 * de una (la regla de patrón pide stories distintas); dentro de cada vuelta, por fecha. Después, los que no son de story.
 */
function ordenDeLectura(merges) {
  const porStory = new Map();
  for (const m of [...merges].filter((x) => x.story).sort((x, y) => x.fecha.localeCompare(y.fecha) || x.sha.localeCompare(y.sha))) {
    if (!porStory.has(m.story)) porStory.set(m.story, []);
    porStory.get(m.story).push(m);
  }
  const orden = [];
  for (let vuelta = 0; orden.length < [...porStory.values()].reduce((n, l) => n + l.length, 0); vuelta++) {
    orden.push(...[...porStory.values()].filter((l) => l[vuelta]).map((l) => l[vuelta]).sort((x, y) => x.fecha.localeCompare(y.fecha)));
  }
  return orden.concat(merges.filter((x) => !x.story).sort((x, y) => x.fecha.localeCompare(y.fecha)));
}

/** Los merges que entran en el tope, en `ordenDeLectura`. `{ leidos, noLeidos, material }`. */
function armarMaterial(merges, maxChars) {
  const orden = ordenDeLectura(merges);
  const leidos = [];
  const noLeidos = [];
  const partes = [];
  let usados = 0;
  for (const m of orden) {
    const b = bloque(m);
    if (usados + b.length + 1 <= maxChars) { partes.push(b); usados += b.length + 1; leidos.push(m); } else noLeidos.push(m);
  }
  return { leidos, noLeidos, material: partes.join('\n') };
}

/** La línea en llano para el resumen: sin nombres de repos ni de personas, reglas, rutas, archivos, números de story ni direcciones. `null` si no pasa. */
function lineaLlana(t, nombres = {}) {
  if (typeof t !== 'string') return null;
  const s = t.trim().replace(/\s+/g, ' ');
  if (!s || s.length > 140) return null;
  if (/[/\\`@<>]|https?:|www\./i.test(s)) return null;
  // hosts escritos sin esquema (api.interno.ejemplo, acme.corp) y nombres de archivo sueltos
  if (/\b[\p{L}\d-]+\.[\p{L}][\p{L}\d-]*/u.test(s)) return null;   // cualquier palabra.palabra pegada: un host, un archivo
  if (/\b\d+\.\d+/.test(s)) return null;                                  // números de story, versiones
  if (/\b[A-Z]{2,}[-_]?[A-Z]?\d+\b/.test(s)) return null;                 // reglas (TEST-C1, DOTNET-W3)
  if (/\w\.(js|ts|tsx|jsx|md|json|ya?ml|sh|ps1|cs|py|html)\b/i.test(s)) return null;
  const low = s.toLowerCase();
  for (const r of nombres.repos || []) if (r && low.includes(String(r).toLowerCase())) return null;
  for (const p of nombres.personas || []) {
    if (!p) continue;
    if (low.includes(String(p).toLowerCase())) return null;
    for (const w of String(p).split(/\s+/)) if (w.length >= 4 && /^\p{Lu}/u.test(w) && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s)) return null;
  }
  return s;
}

/** Lo que devolvió el agente, validado. `{ propuestas, descartadas }`. */
function validar(respuesta, leidos) {
  const propuestas = [];
  const descartadas = [];
  const lista = respuesta && Array.isArray(respuesta.patrones) ? respuesta.patrones : null;
  if (!lista) return { propuestas, descartadas: [{ patron: null, motivo: 'la respuesta no trae la lista «patrones»' }] };
  for (const p of lista) {
    const nombre = p && typeof p.patron === 'string' ? recortar(p.patron, 300) : null;
    const descartar = (motivo) => descartadas.push({ patron: nombre, motivo });
    if (!p || typeof p !== 'object') { descartar('no es un objeto'); continue; }
    const falta = ['patron', 'texto', 'por_que'].filter((k) => typeof p[k] !== 'string' || !p[k].trim());
    if (falta.length) { descartar(`le falta ${falta.join(', ')}`); continue; }
    const forma = FORMAS[String(p.forma || '').trim().toLowerCase()];
    if (!forma) { descartar(`la forma «${recortar(p.forma, 40)}» no es regla, prueba ni guía`); continue; }
    const citados = Array.isArray(p.merges) ? p.merges : [];
    const resueltos = [];
    let inexistente = null;
    for (const c of citados) {
      const sha = c && typeof c.sha === 'string' ? c.sha.trim().toLowerCase() : '';
      const repo = c && typeof c.repo === 'string' ? c.repo.trim() : '';
      const hits = sha.length >= 7 ? leidos.filter((m) => m.repo === repo && m.sha.startsWith(sha)) : [];
      if (hits.length !== 1) { inexistente = `${repo || '?'} ${sha.slice(0, 7) || '?'}`; break; }
      if (!resueltos.includes(hits[0])) resueltos.push(hits[0]);
    }
    if (inexistente) { descartar(`el merge ${inexistente} no está entre los leídos de la semana`); continue; }
    if (resueltos.length < 3) { descartar(`la regla de patrón pide 3 o más merges (trae ${resueltos.length})`); continue; }
    const stories = [...new Set(resueltos.map((m) => m.story).filter(Boolean))].sort();
    if (stories.length < 2) { descartar(`la regla de patrón pide 2 o más stories distintas (trae ${stories.length})`); continue; }
    propuestas.push({ patron: p.patron.trim(), titulo_llano: typeof p.titulo_llano === 'string' ? p.titulo_llano.trim() : null, forma,
      texto: p.texto.trim(), por_que: p.por_que.trim(), merges: resueltos.map((m) => ({ repo: m.repo, sha: m.sha, story: m.story })), stories });
  }
  return { propuestas, descartadas };
}

/** Saca el objeto JSON del texto del agente (puede venir con un bloque de código alrededor). */
function leerRespuesta(texto) {
  const s = String(texto || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/** La línea del agente de verdad: el tope en dólares, sin herramientas, sin servidores MCP ni ganchos, sin sesión guardada. */
function comandoDelAgente(conf) {
  return ['claude', '-p', '--model', conf.model, '--max-budget-usd', String(conf.budget), '--output-format', 'json',
    '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--settings', JSON.stringify({ disableAllHooks: true })];
}

/** Una sola corrida del agente. `{ ok, texto, costo, motivo }`. */
function llamarAgente(pedido, conf) {
  const falso = readEnv('TYCON_WEEKLY_REVIEW_AGENT', { where: 'scripts/nightly/weekly-review/weekly-review.js' });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-review-agente-'));
  try {
    let r;
    if (falso) {
      if (!fs.existsSync(falso)) return { ok: false, motivo: 'el agente de prueba no existe' };
      r = spawnSync(process.execPath, [falso], { input: pedido, cwd, encoding: 'utf8', timeout: 30 * 60000, maxBuffer: 64 * 1024 * 1024 });
    } else {
      const [bin, ...argv] = comandoDelAgente(conf);
      r = spawnSync(bin, argv, { input: pedido, cwd, encoding: 'utf8', timeout: 30 * 60000, maxBuffer: 64 * 1024 * 1024 });
    }
    if (r.error) return { ok: false, motivo: `no se pudo lanzar el agente: ${r.error.code || r.error.message}` };
    let j;
    try { j = JSON.parse(r.stdout); } catch { return { ok: false, motivo: `el agente salió ${r.status} sin su respuesta: ${SWEEP.clean(String(r.stderr || r.stdout).trim().split('\n').pop())}` }; }
    const costo = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null;
    if (j.is_error || typeof j.result !== 'string') return { ok: false, costo, motivo: `el agente no terminó: ${SWEEP.clean(j.subtype || j.result || 'sin resultado')}` };
    return { ok: true, texto: j.result, costo };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

/** La sección de una propuesta en la lista. */
function seccion(p, hoy, desde, hasta, n) {
  const merges = p.merges.map((m) => `${m.repo} ${m.sha.slice(0, 7)}${m.story ? ` (story ${m.story})` : ''}`).join(' · ');
  return [
    `## Revisión semanal ${hoy} — ${p.patron.replace(/\n+/g, ' ')} — ⏳ PENDIENTE`,
    `<!-- revision-semanal:${hoy}:${n} -->`,
    '',
    '**Estado**: ⏳ PENDIENTE — la decide una persona (se aprueba, se descarta o se pasa a una story).',
    '',
    `**Fecha**: ${hoy}`,
    `**Origen**: revisión semanal (\`scripts/nightly/weekly-review/weekly-review.js\`), merges del ${desde} al ${hasta}`,
    `**Forma**: ${NOMBRE_FORMA[p.forma]}`,
    `**Merges que la sostienen**: ${merges}`,
    `**Por qué la habría frenado**: ${p.por_que.replace(/\n+/g, ' ')}`,
    '',
    '**Propuesta**:',
    '',
    '```',
    p.texto.replace(/```/g, "'''"),
    '```',
    '',
    '---',
    '',
  ].join('\n');
}

function escribirAtomico(destino, texto) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const tmp = `${destino}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, texto);
  fs.renameSync(tmp, destino);
}

/** ¿Le toca? `{ toca, motivo }`. El sello es la hora de la última corrida completa. */
function leToca(sello, ahora) {
  const t = Date.parse(String(sello || '').trim());
  if (!Number.isFinite(t)) return { toca: true, motivo: 'no hay corrida completa anterior' };
  const dias = (ahora - t) / DAY;
  return dias >= PERIODO_DIAS ? { toca: true, motivo: `la última fue hace ${dias.toFixed(1)} días` }
    : { toca: false, motivo: `la última fue hace ${dias.toFixed(1)} días; corre cada ${PERIODO_DIAS}` };
}

function main() {
  const a = args(process.argv.slice(2));
  if (a.error) { console.error(`weekly-review: ${a.error}`); return 2; }
  const log = (m) => console.log(`revisión semanal: ${m}`);
  if (readEnv('TYCON_NO_WEEKLY_REVIEW', { where: 'scripts/nightly/weekly-review/weekly-review.js' }) === '1') { log('apagada (TYCON_NO_WEEKLY_REVIEW=1)'); return 0; }
  const org = orgConfig(a.orgConfig || a.teamRepos);
  if (org.aviso) log(org.aviso);
  if (org.enabled === false) { log('apagada por la organización (weekly_review.enabled: false)'); return 0; }
  const stamp = a.stamp || path.join(stateDir, 'weekly-review-last-run');
  const ahora = (() => { const n = Date.parse(readEnv('TYCON_WEEKLY_REVIEW_NOW', { where: 'scripts/nightly/weekly-review/weekly-review.js' }) || ''); return Number.isFinite(n) ? n : Date.now(); })();
  if (a.ifDue) {
    let sello = null;
    try { sello = fs.readFileSync(stamp, 'utf8'); } catch { sello = null; }
    const t = leToca(sello, ahora);
    if (!t.toca) { log(`no le toca (${t.motivo})`); return 0; }
  }
  const conf = { model: a.model, budget: a.budget || org.budget_usd, maxChars: a.maxChars || org.max_chars };
  const hoy = readEnv('TYCON_TODAY', { where: 'scripts/nightly/weekly-review/weekly-review.js' }) || iso(ahora);
  const desde = iso(Date.parse(`${hoy}T12:00:00Z`) - 7 * DAY);
  const hasta = iso(Date.parse(`${hoy}T12:00:00Z`) - DAY);
  const out = path.resolve(a.out);
  const informe = { schema: 1, hecho: new Date(ahora).toISOString(), desde, hasta, estado: null, motivo: null, modelo: conf.model,
    tope: { max_chars: conf.maxChars, material_chars: 0, budget_usd: conf.budget, costo_usd: null },
    repos: [], repos_sin_mirar: 0, retros_ilegibles: [], merges_salteados: {}, merges_leidos: [], merges_no_leidos: [],
    propuestas: [], descartadas: [], linea_llana: null, motivo_corto: null };

  let repos;
  try { repos = [...(a.teamRepos ? SWEEP.teamRepos(a.teamRepos) : []), ...a.repos]; } catch (e) { console.error(`weekly-review: ${e.message}`); return 2; }
  if (!repos.length) { console.error('weekly-review: ningún repo para leer (--repo o --team-repos)'); return 2; }
  let reglas;
  try { reglas = SWEEP.loadConfig(path.join(ROOT, 'scripts', 'metrics', 'retro-sweep.json')); } catch (e) { console.error(`weekly-review: la lista de lo que no pide retro no se pudo leer: ${e.message}`); return 2; }
  const clones = path.resolve(a.clones || path.join(stateDir, 'weekly-review', 'clones'));
  const retros = new Map();
  const merges = [];
  const got = repos.map((r) => SWEEP.obtain(r, clones));
  for (const g of got) if (g.dir) retrosDe(g.dir, g.ref, retros, informe.retros_ilegibles);
  repos.forEach((r, i) => {
    const g = got[i];
    if (!g.dir) { informe.repos.push({ nombre: r.nombre, mirado: false, motivo: SWEEP.clean(g.motivo) }); return; }
    try { merges.push(...mergesDe(r, g, desde, hoy, reglas, informe.merges_salteados)); informe.repos.push({ nombre: r.nombre, mirado: true }); } catch (e) { informe.repos.push({ nombre: r.nombre, mirado: false, motivo: SWEEP.clean(e.message) }); }
  });
  for (const m of merges) { m.retro = retros.get(m.sha) || null; m.story = storyDe(m.asunto, m.commitsTexto, m.retro && m.retro.story); }
  const sinMirar = informe.repos.filter((r) => !r.mirado);
  informe.repos_sin_mirar = sinMirar.length;
  const salteados = Object.entries(informe.merges_salteados);
  if (salteados.length) log(`${salteados.reduce((n, [, c]) => n + c, 0)} merges salteados, no piden retro (${salteados.map(([k, c]) => `${k}: ${c}`).join(' · ')}): no cuentan contra el tope`);
  for (const x of informe.retros_ilegibles) log(`retros que no se pudieron leer — ${x}`);

  // `corto` es la causa en una palabra, para el resumen de la mañana (que no copia el motivo: puede nombrar algo)
  const terminar = (estado, motivo, code, sellar, corto = null) => {
    informe.estado = estado;
    informe.motivo = motivo;
    informe.motivo_corto = corto;
    escribirAtomico(path.join(out, INFORME), `${JSON.stringify(informe, null, 2)}\n`);
    if (motivo) log(motivo);
    if (a.push) {
      const v = require(path.join(ROOT, 'scripts', 'controls-bench', 'periodic-exam.js')).viajar(out, log, [GUIA, INFORME],
        `chore(revision-semanal): propuestas de la semana del ${desde} al ${hasta}`);
      if (!v.ok) { log(`NO VIAJÓ: ${v.motivo}`); return 5; }
    }
    // una semana leída a medias (un repo sin mirar, retros ilegibles) no se sella: la próxima vuelta del disparador la reintenta
    const aMedias = sinMirar.length || informe.retros_ilegibles.length;
    if (sellar && !aMedias) { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, `${new Date(ahora).toISOString()}\n`); }
    if (sinMirar.length) { console.error(`🔴 weekly-review: no pude mirar: ${sinMirar.map((r) => `${r.nombre} (${r.motivo})`).join(' · ')}`); return 2; }
    if (informe.retros_ilegibles.length && code === 0) return 2;
    return code;
  };

  const guia = path.join(out, GUIA);
  if (!fs.existsSync(guia)) return terminar('no_pudo', `no está la lista de propuestas (${GUIA}) en ${path.basename(out)}`, 2, false, 'sin_lista');
  if (a.push) {
    // la lista se edita sobre la punta de main, y nunca encima de cambios sin commitear de una persona
    if (git(out, ['diff', '--quiet', 'HEAD', '--', GUIA]).status !== 0) return terminar('no_pudo', 'la lista de propuestas tiene cambios sin commitear en el clon: no la toco', 5, false, 'lista_sucia');
    const p = spawnSync('git', ['-C', out, 'pull', '--ff-only', '--quiet'], { encoding: 'utf8', timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (p.status !== 0) log(`no pude poner al día el clon (${SWEEP.clean(String(p.stderr).trim().split('\n').pop())}): sigo con lo que tiene`);
  }

  if (!merges.some((m) => m.retro)) {
    // sin ninguna retro legible: si hubo retros que no se pudieron leer, es «no pude leer», no «no hay»
    if (informe.retros_ilegibles.length) return terminar('no_pudo', `ninguna retro de la semana se pudo leer (${informe.retros_ilegibles.length} lugar(es) con retros ilegibles): no propongo nada`, 2, false, 'retros_ilegibles');
    return terminar('sin_retros', `no hay retros de la semana (${merges.length} merges del ${desde} al ${hasta}): ¿corrió el barrido de cada noche? No propongo nada`, 0, true);
  }
  const { leidos, noLeidos, material } = armarMaterial(merges, conf.maxChars);
  informe.tope.material_chars = material.length;
  informe.merges_leidos = leidos.map((m) => ({ repo: m.repo, sha: m.sha, fecha: m.fecha, story: m.story, retro: m.retro ? m.retro.tipo : null, hallazgos: m.hallazgos.length,
    ...(m.incompleto.length ? { incompleto: m.incompleto } : {}) }));
  informe.merges_no_leidos = noLeidos.map((m) => ({ repo: m.repo, sha: m.sha, fecha: m.fecha, story: m.story, asunto: m.asunto }));
  if (noLeidos.length) log(`${noLeidos.length} de ${merges.length} merges no entraron en el tope de ${conf.maxChars} caracteres: no leídos, y así lo dice el informe`);
  if (!leidos.length) return terminar('no_pudo', 'ningún merge entró en el tope de material', 3, false, 'tope_vacio');

  const aviso = noLeidos.length ? `\nOJO: ${noLeidos.length} merges de la semana NO entraron en el material (el tope). No hables de ellos.\n` : '';
  const pedido = fs.readFileSync(PROMPT, 'utf8').replace('{{DESDE}}', desde).replace('{{HASTA}}', hasta)
    .replace('{{NO_LEIDOS}}', aviso).replace('{{MATERIAL}}', () => material);
  const r = llamarAgente(pedido, conf);
  informe.tope.costo_usd = r.costo === undefined ? null : r.costo;
  if (!r.ok) return terminar('sin_agente', `no pude correr al agente: ${r.motivo}`, 3, false);
  const resp = leerRespuesta(r.texto);
  if (!resp) return terminar('respuesta_ilegible', 'la respuesta del agente no es el JSON pedido', 3, false);
  const v = validar(resp, leidos);
  informe.propuestas = v.propuestas;
  informe.descartadas = v.descartadas;
  // la línea del resumen: la del patrón que más merges sostienen, si pasa el filtro de nombres
  const nombres = { repos: repos.map((x) => x.nombre), personas: [...new Set(merges.flatMap((m) => m.autores))] };
  const mayor = [...v.propuestas].sort((x, y) => y.merges.length - x.merges.length)[0];
  informe.linea_llana = mayor ? lineaLlana(mayor.titulo_llano || mayor.patron, nombres) : null;

  // a la lista, una vez por fecha (la misma noche dos veces no duplica)
  const lista = fs.readFileSync(guia, 'utf8');
  if (v.propuestas.length && !lista.includes(`<!-- revision-semanal:${hoy}:`)) {
    const nuevas = v.propuestas.map((p, i) => seccion(p, hoy, desde, hasta, i + 1)).join('\n');
    escribirAtomico(guia, `${lista.replace(/\s*$/, '\n')}\n${nuevas}`);
  } else if (v.propuestas.length) log(`las propuestas del ${hoy} ya estaban en la lista`);
  for (const d of v.descartadas) log(`descartada: ${recortar(d.patron || '(sin nombre)', 80)} — ${d.motivo}`);
  log(`${leidos.length} merges leídos · ${v.propuestas.length} propuesta(s) · ${v.descartadas.length} descartada(s)${informe.tope.costo_usd !== null ? ` · US$${informe.tope.costo_usd}` : ''}`);
  return terminar('hecho', null, 0, true);
}

if (require.main === module) process.exitCode = main();
module.exports = { args, orgConfig, storyDe, ordenDeLectura, armarMaterial, lineaLlana, comandoDelAgente, validar, leerRespuesta, leToca, PERIODO_DIAS, INFORME, GUIA };
