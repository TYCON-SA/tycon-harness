'use strict';
/**
 * guided-page.js — leer la página pública de Windows (`getting-started/windows.md`) para ENSAYARLA: sacar el bloque que
 * la persona copia, comprobar que cada comando de la ficha (`guided-steps.json`) está escrito en él letra por letra, y
 * juzgar lo que devolvió cada comando.
 *
 * POR QUÉ EXISTE. El ensayo de Windows seguía un texto interno eligiendo sus bloques por título y por posición: un
 * párrafo nuevo cambiaba qué se corría y nadie se enteraba. La página pública es además UN solo bloque de texto que la
 * persona le pega al asistente: una marca puesta adentro dejaría de ser invisible. Por eso:
 *   · la página lleva una marca sola, envolviendo el bloque desde afuera (la convención de las portadas, que ya lee
 *     `lab.coverBlock`), y la identidad de cada paso vive en la ficha;
 *   · antes de correr nada se comprueba la ficha contra la página. Si un comando ya no está, o la cuenta de pasos
 *     cambió, no se ensaya nada: se dice qué paso dejó de calzar. Nunca a medias;
 *   · lo esperado de cada comando es un DATO de la ficha, no prosa: se compara, y lo que no se puede comparar se dice
 *     («no comparable», con su motivo) en vez de saltearse callado.
 *
 * Este archivo no corre nada ni toca el disco fuera de leer la ficha: recibe textos y devuelve datos. Quien corre los
 * comandos es `guided-install.js`. Sin dependencias.
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');
const PLACE = require('../../setup/harness/place.js');

const MANIFEST_FILE = path.join(__dirname, 'guided-steps.json');
// donde un comando de la página nombra la carpeta del arnés dentro de la de Claude Code, la ficha lleva este marcador
const PLACE_MARK = '{{harness-place}}';
const KINDS = Object.freeze(['match', 'min', 'equals', 'file']);
const RUNNERS = Object.freeze(['machine', 'person']);
const SEVERITIES = Object.freeze(['breaks', 'loses-control', 'noise']);
const RUN_WHEN = Object.freeze(['previous-output-empty']);
// cómo sirve el GitHub de juguete el árbol que se ensaya (`lab.auth`): `none` = repo público, sin permiso (lo que la
// página supone: baja el guion sin credencial); `token` = repo privado, con un permiso de juguete en el ambiente de los
// pasos que bajan e instalan. Lo lee `guided-install.js`: es un dato de la ficha, no una decisión del guion
const AUTH_MODES = Object.freeze(['none', 'token']);
const NAME_MARKS = Object.freeze({ org: '{{public-org}}', repo: '{{public-repo}}' });
const TEAM_HOLES = Object.freeze(['<team-url>']);

/** La ficha, leída del archivo de al lado (o del que se pase). Tira si no es JSON. */
function loadManifest(file = MANIFEST_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Lo que una ficha tiene mal, como lista de textos (vacía = bien formada). */
function manifestProblems(m) {
  const out = [];
  if (!m || typeof m !== 'object') return ['la ficha no es un objeto'];
  if (!m.page || !m.page.published || !m.page.mark || !m.page.fence) out.push('falta `page` con `published`, `mark` y `fence`');
  if (!m.needs || !m.needs.entry_script || !m.needs.names) out.push('falta `needs` con `entry_script` y `names`');
  if (!m.lab || !m.lab.api_origin) out.push('falta `lab.api_origin`: el único origen que el laboratorio reemplaza');
  // sin este dato el laboratorio tendría que adivinar si sirve el repo con permiso o sin él: se dice, no se supone
  if (!m.lab || !AUTH_MODES.includes(m.lab.auth)) out.push(`\`lab.auth\` tiene que decir cómo sirve el repo el GitHub de juguete (${AUTH_MODES.join(' o ')}); dice ${JSON.stringify(m.lab && m.lab.auth)}`);
  const seen = new Set();
  for (const s of Array.isArray(m.steps) ? m.steps : []) {
    const id = s && s.id;
    if (!/^[a-z][a-z-]*$/.test(String(id || ''))) { out.push(`un paso sin identificador en inglés (${JSON.stringify(id)})`); continue; }
    if (seen.has(id)) out.push(`el paso ${id} está repetido`);
    seen.add(id);
    if (!RUNNERS.includes(s.runs)) { out.push(`${id}: \`runs\` tiene que ser ${RUNNERS.join(' o ')}`); continue; }
    if (s.runs === 'person') { if (!s.why) out.push(`${id}: un paso de la persona lleva el motivo por el que no se ensaya`); continue; }
    if (!SEVERITIES.includes(s.severity)) out.push(`${id}: falta la gravedad de que falle (${SEVERITIES.join(', ')})`);
    if (!Array.isArray(s.commands) || !s.commands.length) { out.push(`${id}: un paso de la máquina lleva sus comandos`); continue; }
    for (const c of s.commands) {
      if (!c || typeof c.text !== 'string' || !c.text.trim() || c.text.trim() !== c.text) { out.push(`${id}: un comando sin su texto, o con espacios de más en las puntas`); continue; }
      if (!Array.isArray(c.expect)) out.push(`${id}: «${c.text}» no dice qué se espera de él (\`expect\`, aunque sea vacío)`);
      for (const e of Array.isArray(c.expect) ? c.expect : []) {
        if (!e || !KINDS.includes(e.kind)) { out.push(`${id}: lo esperado de «${c.text}» es de un tipo que no conozco (${e && e.kind}); los que hay: ${KINDS.join(', ')}`); continue; }
        // cada tipo, con lo suyo: una ficha mal escrita se dice acá, antes de correr nada, y no a mitad del ensayo
        const bad = expectProblem(e);
        if (bad) out.push(`${id}: lo esperado de «${c.text}» (${e.kind}) ${bad}`);
      }
      for (const n of Array.isArray(c.notes) ? c.notes : []) {
        if (!n || !/^[a-z][a-z-]*$/.test(String(n.id || '')) || !compiles(n.pattern)) out.push(`${id}: una anotación de «${c.text}» no trae un \`id\` en inglés y una expresión que se pueda leer`);
      }
      if (c.notes !== undefined && !Array.isArray(c.notes)) out.push(`${id}: \`notes\` de «${c.text}» tiene que ser una lista`);
      if (c.ok_exits !== undefined && !(Array.isArray(c.ok_exits) && c.ok_exits.length && c.ok_exits.every(Number.isInteger))) out.push(`${id}: \`ok_exits\` de «${c.text}» tiene que ser una lista de códigos`);
      if (c.run_when !== undefined && !RUN_WHEN.includes(c.run_when)) out.push(`${id}: no sé cuándo es «${c.run_when}» (\`run_when\`: ${RUN_WHEN.join(', ')})`);
      if (c.windows_only !== undefined && !(typeof c.windows_only === 'string' && c.windows_only.trim())) out.push(`${id}: \`windows_only\` de «${c.text}» lleva su motivo`);
    }
  }
  if (!seen.size) out.push('la ficha no trae ningún paso');
  const team = m.team && Array.isArray(m.team.commands) ? m.team.commands : null;
  if (!team || !team.length) out.push('falta `team.commands`: los comandos de la capa del equipo');
  for (const c of team || []) {
    const holes = String((c && c.text) || '').match(/<[a-z-]+>/g) || [];
    if (!c || !/^harness\.js /.test(String(c.text || ''))) out.push(`la capa del equipo: «${c && c.text}» no es un comando de harness.js`);
    for (const h of holes) if (!TEAM_HOLES.includes(h)) out.push(`la capa del equipo: «${c.text}» trae un hueco que no conozco (${h})`);
  }
  // los dos comandos de la capa, por lo que SON y no por su lugar en la lista: el que guarda el permiso (que entra por
  // la entrada estándar: lo dice `stdin`) y el que instala con la capa (el único con la dirección del repo como hueco)
  if (team && team.length) {
    const parts = teamCommands(m);
    if (parts.problem) out.push(`la capa del equipo: ${parts.problem}`);
  }
  if (!Array.isArray(m.not_rehearsed) || m.not_rehearsed.some((n) => !n || !n.what || !n.why)) out.push('`not_rehearsed`: cada cosa que no se ensaya lleva qué es y por qué');
  return out;
}

const compiles = (pattern, flags = 'm') => { try { return typeof pattern === 'string' && pattern.length > 0 && Boolean(new RegExp(pattern, flags)); } catch (_) { return false; } };
/** Lo que le falta a UNA cosa esperada para poder compararse, o `null`. */
function expectProblem(e) {
  if (e.kind === 'match') {
    if (!compiles(e.pattern, e.flags || 'm')) return `no trae una expresión que se pueda leer (\`pattern\`${e.flags ? `, con \`flags\` ${e.flags}` : ''})`;
    if (e.in !== undefined && !['stdout', 'any'].includes(e.in)) return `dice buscar en «${e.in}»: es \`stdout\` (lo de siempre) o \`any\``;
  }
  if ((e.kind === 'min' || e.kind === 'equals') && !(typeof e.value === 'number' && Number.isFinite(e.value)) && !(e.kind === 'equals' && typeof e.value === 'string' && e.value)) return 'no trae el valor contra el que se compara (`value`)';
  if (e.kind === 'file' && (!['home', 'cwd'].includes(e.in) || typeof e.path !== 'string' || !e.path || e.path.startsWith('/') || e.path.split('/').includes('..'))) return 'no dice dónde (`in`: `home` o `cwd`) ni qué archivo (`path`, relativo y sin salir de la carpeta)';
  if (e.lab_gap !== undefined && !(typeof e.lab_gap === 'string' && e.lab_gap.trim())) return 'trae `lab_gap` sin su motivo';
  return null;
}
/**
 * Los dos comandos de la capa del equipo, por lo que son: `{ token, install }`, o `{ problem }`. `token` es el que
 * guarda el permiso (declara `stdin`: el permiso nunca va por argumento); `install`, el que lleva la dirección del repo.
 */
function teamCommands(m) {
  const list = (m.team && Array.isArray(m.team.commands) ? m.team.commands : []).filter((c) => c && typeof c.text === 'string');
  const token = list.filter((c) => c.stdin);
  const install = list.filter((c) => c.text.includes('<team-url>'));
  if (token.length !== 1 || install.length !== 1 || token[0] === install[0] || list.length !== 2) return { problem: 'tiene que traer dos comandos: el que guarda el permiso (con `stdin`) y el que instala con la capa (con `<team-url>`)' };
  if (!/ config set [a-z.]+$/.test(token[0].text)) return { problem: `«${token[0].text}» declara \`stdin\` y no es un «config set»: el permiso entraría a otro comando` };
  return { token: token[0], install: install[0] };
}

const machineSteps = (m) => m.steps.filter((s) => s.runs === 'machine');
const personSteps = (m) => m.steps.filter((s) => s.runs === 'person');

/** Lo que el ensayo NO corre, con el motivo de la ficha: los pasos de la persona y el bloque `not_rehearsed`. */
function notRehearsed(m) {
  return [
    ...personSteps(m).map((s) => ({ step: s.id, what: s.what || s.id, why: s.why })),
    ...m.not_rehearsed.map((n) => ({ step: n.step || null, what: n.what, why: n.why })),
  ];
}

/**
 * El bloque que la persona copia, por su marca: `{ block }`, o `{ problem }`. La marca y su cierre tienen que estar una
 * sola vez cada una, solas en su renglón y FUERA del bloque de código.
 */
function readBlock(pageText, m) {
  const { mark, fence } = m.page;
  const lines = String(pageText).replace(/\r\n/g, '\n').split('\n');
  const opens = lines.filter((l) => l === `<!-- ${mark} -->`).length;
  const closes = lines.filter((l) => l === `<!-- /${mark} -->`).length;
  if (opens !== 1 || closes !== 1) return { problem: `la marca <!-- ${mark} --> y su cierre tienen que estar una sola vez cada una, solas en su renglón (abre ${opens}, cierra ${closes}${opens > 1 || closes > 1 ? ': más de una vez' : ''})` };
  const open = lines.indexOf(`<!-- ${mark} -->`);
  const close = lines.indexOf(`<!-- /${mark} -->`);
  // afuera del bloque de código: hasta la marca, las vallas abiertas están todas cerradas
  const fencesBefore = lines.slice(0, open).filter((l) => /^```/.test(l)).length;
  if (fencesBefore % 2 !== 0) return { problem: `la marca <!-- ${mark} --> está DENTRO de un bloque de código: ahí deja de ser invisible, se copia con el bloque` };
  const block = L.coverBlock(lines.join('\n'), mark, fence);
  if (block === null || !block.trim()) return { problem: `entre <!-- ${mark} --> y su cierre no hay un bloque \`\`\`${fence} con su cierre` };
  if (block.includes(`<!-- ${mark}`) || block.includes(`<!-- /${mark}`)) return { problem: `la marca <!-- ${mark} --> aparece dentro del bloque que se copia` };
  return { block };
}

/** Cuántos pasos numerados trae el bloque (`1. `, `2. `… al principio del renglón). */
const countSteps = (block) => String(block).split('\n').filter((l) => /^\d+\. /.test(l)).length;

/** La organización y el nombre del repo público, del archivo de nombres del árbol: `{ org, repo }` o `{ problem }`. */
function namesOf(remotesText) {
  let parsed;
  try { parsed = JSON.parse(String(remotesText)); } catch (e) { return { problem: `no es JSON (${e.message})` }; }
  const first = parsed && Array.isArray(parsed.remotes) ? parsed.remotes[0] : null;
  const hit = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(first || ''));
  if (!hit) return { problem: 'no trae en `remotes` la dirección del repo público (https://github.com/<organización>/<nombre>)' };
  return { org: hit[1], repo: hit[2] };
}

/**
 * El texto de un comando de la ficha como lo dice la página: con el nombre de la carpeta del arnés en su marcador
 * (siempre: lo da `place.js`, y no se escribe en estos guiones) y, con `names` (una copia publicada), con los dos
 * marcadores del nombre público reemplazados, que es lo mismo que hizo el exportador al publicar.
 */
function withNames(text, names) {
  const placed = String(text).split(PLACE_MARK).join(PLACE.PLACE_NAME);
  if (!names) return placed;
  return placed.split(NAME_MARKS.org).join(names.org).split(NAME_MARKS.repo).join(names.repo);
}

/**
 * ¿La página y la ficha dicen lo mismo? `{ ok, problems: [{ step, what }], page_steps, manifest_steps }`. En los dos
 * sentidos: cada comando de la ficha está en la página, dentro de su paso y en el mismo orden; y la página no trae, en
 * un paso de la máquina, un comando que la ficha no conozca.
 * Con `names` (una copia publicada) los marcadores de la ficha se reemplazan antes de comparar; sin ellos (el árbol de
 * origen) se compara tal cual.
 */
function checkPage(m, block, { names = null } = {}) {
  const problems = [];
  const raw = String(block).split('\n');
  const lines = raw.map((l) => l.trimStart());
  const pageSteps = countSteps(block);
  if (pageSteps !== m.steps.length) problems.push({ step: null, what: `el bloque marcado trae ${pageSteps} pasos numerados y la ficha ${m.steps.length}` });
  // dónde empieza cada paso numerado: el paso número k de la página es el k-ésimo de la ficha (la cuenta ya se comparó)
  const starts = raw.map((l, i) => (/^\d+\. /.test(l) ? i : -1)).filter((i) => i >= 0);
  const aligned = pageSteps === m.steps.length;
  const wanted = (c) => (c.line_prefix ? `${c.line_prefix}${withNames(c.text, names)}` : withNames(c.text, names));
  const missing = (s, c) => (c.line_prefix
    ? `no encuentro, en el bloque marcado, un renglón que empiece con «${c.line_prefix}» y termine con «${withNames(c.text, names)}»`
    : `no encuentro, como renglón entero del bloque marcado, «${withNames(c.text, names)}»`);
  for (const [k, s] of m.steps.entries()) {
    const from = aligned ? starts[k] : 0;
    const to = aligned ? (k + 1 < starts.length ? starts[k + 1] : lines.length) : lines.length;
    const known = new Set();
    let last = -1;
    for (const c of s.runs === 'machine' ? s.commands : []) {
      const at = lines.findIndex((l, i) => i >= from && i < to && l === wanted(c));
      if (at < 0) {
        // no está en su paso: ¿está en otro, o no está?
        const elsewhere = aligned ? lines.indexOf(wanted(c)) : -1;
        problems.push({ step: s.id, what: elsewhere >= 0 ? `«${withNames(c.text, names)}» está en la página, pero fuera del paso ${k + 1}, que es el suyo en la ficha` : missing(s, c) });
        continue;
      }
      known.add(at);
      // el ensayo corre los comandos en el orden de la ficha: tiene que ser el de la página
      if (at < last) problems.push({ step: s.id, what: `«${withNames(c.text, names)}» está en la página antes que el comando que lo precede en la ficha: el orden no es el mismo` });
      last = Math.max(last, at);
    }
    // y al revés: un comando que la página trae en un paso de la máquina y la ficha no conoce no se correría, y nadie
    // se enteraría. (En un paso de la persona no hay nada que comparar: sus comandos no se ensayan.)
    if (aligned && s.runs === 'machine') {
      for (let i = from; i < to; i++) {
        if (known.has(i) || !looksLikeCommand(raw[i])) continue;
        problems.push({ step: s.id, what: `la página trae en el paso ${k + 1} un comando que la ficha no conoce: «${L.clip(lines[i], 200)}»` });
      }
    }
  }
  return { ok: problems.length === 0, problems, page_steps: pageSteps, manifest_steps: m.steps.length };
}
/**
 * ¿Este renglón del bloque es un comando? En la página los comandos van sangrados: los que la persona corre en su
 * ventana, con 7 espacios o más (ahí no hay prosa); los que corre el asistente, con 3, mezclados con prosa — de ésos
 * cuenta el que empieza como un comando (una variable, un cmdlet, o un programa con sus opciones).
 */
function looksLikeCommand(rawLine) {
  const indent = rawLine.length - rawLine.trimStart().length;
  const text = rawLine.trim();
  if (!text) return false;
  if (indent >= 7) return true;
  if (indent < 3) return false;
  return /^(\$[A-Za-z]|@\(|\((?:[A-Z][a-z]+-[A-Z])|[A-Z][a-z]+-[A-Z][A-Za-z]+(\s|$)|(?:git|node|pwsh|powershell|tar|winget)\s+(?:\S+\s+)?(?:-{1,2}[A-Za-z]|"|\$))/.test(text);
}

/**
 * Todo lo que el ensayo necesita de una COPIA PUBLICADA antes de correr nada: `{ block, names, page_name_from,
 * entry_script, page_steps }`, o `{ problem }` con lo que buscó y dónde. `read(rel)` devuelve el texto de un archivo del
 * commit que se ensaya, o `null` si no está; si tira (no pudo leer), el problema sube tal cual: no saber no es «no está».
 */
function prepare({ read, manifest }) {
  const bad = manifestProblems(manifest);
  if (bad.length) return { problem: `la ficha del ensayo (guided-steps.json) está mal: ${bad.join(' · ')}` };
  const page = manifest.page.published;
  let pageText; let script; let remotes;
  try {
    pageText = read(page);
    script = read(manifest.needs.entry_script);
    remotes = read(manifest.needs.names);
  } catch (e) { return { problem: `no pude leer la copia publicada que se ensaya: ${e.message}` }; }
  const where = 'en el commit que se ensaya, que es una copia publicada (trae version.json)';
  if (pageText === null || pageText === undefined) return { problem: `no encuentro la página (${page}) ${where}` };
  const read1 = readBlock(pageText, manifest);
  if (read1.problem) return { problem: `la página no trae la marca como hace falta — busqué <!-- ${manifest.page.mark} --> en ${page}, ${where}: ${read1.problem}` };
  if (script === null || script === undefined) return { problem: `no encuentro el guion de entrada (${manifest.needs.entry_script}) ${where}` };
  if (remotes === null || remotes === undefined) return { problem: `no encuentro el archivo del nombre público (${manifest.needs.names}) ${where}` };
  const names = namesOf(remotes);
  if (names.problem) return { problem: `${manifest.needs.names}, ${where}, ${names.problem}` };
  const checked = checkPage(manifest, read1.block, { names });
  // (el motivo cita comandos de la página, que traen el nombre del repo público: van los nombres, para que quien llama
  // pueda tapar el motivo antes de escribirlo)
  if (!checked.ok) return { names, problem: `la página (${page}) y la ficha del ensayo no coinciden, ${where} — ${checked.problems.map((p) => (p.step ? `paso ${p.step}: ${p.what}` : p.what)).join(' · ')}` };
  return { block: read1.block, names, page_name_from: manifest.needs.names, entry_script: manifest.needs.entry_script, entry_script_text: script, page_steps: checked.page_steps };
}

/** El único cambio que el laboratorio le hace a un comando de la página: el origen de la API. `{ text, changed, from, to }`. */
function labText(text, m, labApi) {
  const from = m.lab.api_origin;
  if (!labApi || !String(text).includes(from)) return { text, changed: false };
  return { text: String(text).split(from).join(labApi), changed: true, from, to: labApi };
}

/**
 * ¿Este comando corre? `{ run: true }`, o `{ run: false }` con `skipped` (su condición no se dio) o `not_comparable`
 * (lo marcado «sólo en Windows», fuera de Windows: va al reporte con su motivo, no se saltea callado).
 */
function shouldRun(cmd, previous, { platform = process.platform } = {}) {
  if (cmd.windows_only && !L.isWin(platform)) return { run: false, not_comparable: cmd.windows_only };
  if (cmd.run_when === 'previous-output-empty') {
    const said = String((previous && previous.stdout) || '').trim();
    if (said) return { run: false, skipped: `el comando anterior ya devolvió «${L.clip(said, 120)}»: la página manda correr éste sólo si no devuelve nada` };
  }
  return { run: true };
}

const lastLine = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

/**
 * Juzga lo que devolvió un comando: `{ checks, findings, noted }`.
 *   · un código de salida que la ficha no da por bueno, un programa que no arrancó, o un programa que el comando
 *     nombra y PowerShell NO ENCONTRÓ (`result.not_found`: ahí el proceso sale 0 igual) → `guided:step-failed:<paso>`;
 *   · una diferencia con lo esperado → `guided:expected:<paso>`. En un comando que no lanza ningún programa, PowerShell
 *     sale 0 aunque falle: la falla se ve acá, no en el código;
 * los dos con la gravedad que la ficha le da al paso. Lo esperado con `lab_gap` no se compara: queda dicho.
 * Una expresión se busca en la SALIDA del comando, no en su canal de errores (ahí PowerShell repite el renglón del
 * comando: toda palabra del comando «aparecería»); con `"in": "any"` se busca en los dos.
 */
function judge(step, cmd, result, { home = '', cwd = '', exists = fs.existsSync } = {}) {
  const findings = [];
  const okExits = Array.isArray(cmd.ok_exits) ? cmd.ok_exits : [0];
  const notFound = Array.isArray(result.not_found) ? result.not_found : [];
  if (result.error || result.timed_out || !okExits.includes(result.exit) || notFound.length) {
    const how = result.timed_out ? 'no terminó (venció su tope)'
      : (result.error ? `no arrancó (${result.error})`
        : (notFound.length ? `no encontró en la máquina: ${notFound.join(', ')} (el proceso salió ${result.exit})` : `salió ${result.exit}`));
    findings.push({ id: `guided:step-failed:${step.id}`, severity: step.severity, kind: 'page', detail: `paso ${step.id}: «${L.clip(cmd.text, 160)}» ${how}${lastLine(result.stderr) || lastLine(result.stdout) ? ` — ${L.clip(lastLine(result.stderr) || lastLine(result.stdout), 300)}` : ''}` });
  }
  const checks = [];
  for (const e of cmd.expect || []) {
    const check = { kind: e.kind, what: e.what || null, comparable: !e.lab_gap, ok: null };
    if (e.kind === 'match') {
      check.expected = e.pattern;
      const output = e.in === 'any' ? `${result.stdout || ''}\n${result.stderr || ''}` : String(result.stdout || '');
      const hit = new RegExp(e.pattern, e.flags || 'm').exec(output);
      check.measured = hit ? L.clip(hit[0], 120) : L.clip(lastLine(result.stdout) || lastLine(result.stderr), 160) || '(sin salida)';
      check.ok = Boolean(hit);
    } else if (e.kind === 'min' || e.kind === 'equals') {
      check.expected = e.value;
      const said = lastLine(result.stdout);
      const n = /^-?\d+(\.\d+)?$/.test(said) ? Number(said) : null;
      check.measured = n === null ? (said || '(sin salida)') : n;
      check.ok = e.kind === 'min' ? (n !== null && n >= Number(e.value)) : (typeof e.value === 'number' ? n === e.value : said === String(e.value));
    } else if (e.kind === 'file') {
      const file = path.join(e.in === 'home' ? home : cwd, ...String(e.path).split('/'));
      check.expected = `${e.in === 'home' ? '~' : '.'}/${e.path}`;
      check.ok = Boolean(exists(file));
      check.measured = check.ok ? 'está' : 'no está';
    }
    if (e.lab_gap) check.why = e.lab_gap;
    checks.push(check);
  }
  const off = checks.filter((c) => c.comparable && c.ok === false);
  if (off.length) findings.push({ id: `guided:expected:${step.id}`, severity: step.severity, kind: 'page', detail: `paso ${step.id}: «${L.clip(cmd.text, 160)}» no dio lo que la página espera — ${off.map((c) => `${c.what || c.kind}: se esperaba ${c.kind === 'min' ? `${c.expected} o más` : c.expected} y dio ${c.measured}`).join(' · ')}` });
  const noted = {};
  for (const n of cmd.notes || []) { const hit = new RegExp(n.pattern, 'm').exec(result.stdout || ''); noted[n.id] = hit ? hit[0] : null; }
  return { checks, findings, noted };
}

module.exports = {
  MANIFEST_FILE, KINDS, RUN_WHEN, AUTH_MODES, NAME_MARKS, PLACE_MARK,
  loadManifest, manifestProblems, teamCommands, machineSteps, personSteps, notRehearsed,
  readBlock, countSteps, namesOf, withNames, checkPage, looksLikeCommand, prepare, labText, shouldRun, judge,
};
