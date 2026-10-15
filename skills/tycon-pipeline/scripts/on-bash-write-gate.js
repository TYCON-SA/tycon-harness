#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Bash|PowerShell) — la segunda puerta del portón de CARRIL.
 *
 * El portón de carril vive en PreToolUse Edit|Write (`on-story-gate.js`). Pero un archivo también se
 * escribe por Bash: `cat > src/Foo.cs <<'EOF'`, `sed -i`, `tee`, `perl -pi`, `cp`, un `python3 -c
 * "open(...,'w')"`. Y no hace falta malicia para ir por ahí: en "auto mode" el propio arnés INSTRUYE
 * editar con sed/heredocs en vez de Edit/Write (hallazgo R3 del review adversarial 2026-08-19). Sin
 * esta puerta, el portón tenía un agujero del tamaño de la puerta.
 *
 * Qué hace: extrae del comando los paths que el comando VA A ESCRIBIR (redirecciones, tee, sed -i,
 * perl -i, cp/mv destino, open(...,'w'), writeFileSync, Set-Content/Out-File), se queda con los que
 * son CÓDIGO (mismo criterio que el portón: `lib/story-gate.js#isCodeFile`), y corre sobre cada uno el
 * MISMO cálculo (`lib/story-gate-io.js#evaluate`). Si alguno bloquea, el comando se deniega con el
 * mismo mensaje (indicando que vino por Bash).
 *
 * Es BEST-EFFORT a propósito: un parser de shell completo acá sería más frágil que útil. Lo que no
 * reconoce (git apply, patch, herramientas con --write) pasa. La red de fondo sigue siendo la misma
 * que para el resto del arnés: el diff en el commit. Conservador en la extracción para no dar falsos
 * positivos: sólo el token DESPUÉS de `>`/`>>`/`tee`, sólo tokens con extensión de código tras
 * `sed -i`/`perl -i`, sólo el ÚLTIMO token de un `cp`/`mv`.
 *
 * Exit: 0 deja pasar · 2 deniega (stderr = mensaje). Fail-open VISIBLE: errores a hook-errors.log.
 * Escape: el mismo del portón (env TYCON_STORY_GATE=off · config commiteada del repo).
 *
 * ── SEGUNDA RESPONSABILIDAD (2026-08-30): la puerta Bash del freno de STORY A MANO ────────────────
 * Los dos casos reales que motivaron ese freno (Totora AS-1 y PERF-1) fueron heredocs de Bash —
 * un hook que sólo mirara Edit|Write no habría frenado nada. Sobre los MISMOS targets extraídos
 * arriba, para cada `.md` que NO existe: si el contenido (cuerpo del heredoc, o el texto inline
 * de un `printf`/`echo -e` con `\n`) declara identidad de story, o —sin contenido legible— el
 * nombre lo sugiere (`story-*.md`, `stories/*.md`), corre `lib/story-skill-gate-io.js#evaluate`.
 * Decisión explícita del handoff: por Bash se acepta ser MÁS conservador (nombre + ruta) cuando el
 * contenido no se puede parsear (`cp plantilla.md specs/story-x.md`); el costo es un `.md` con
 * nombre de story que no lo es, en un repo del arnés, escrito por Bash sin el skill — raro, y
 * con escape auditado. Kill-switch propio: TYCON_STORY_SKILL_GATE=off (independiente del carril).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const { isCodeFile } = require('./lib/story-gate.js');
const { resolveSessionId } = require('./lib/session-id.js');
// Con respaldo, como en dispatch.js y on-write-collision.js: sin la lib (un skill instalado a medias) el portón no puede
// morir al cargar —saldría 1, que no frena, y sin dejar constancia—: resuelve las rutas como antes.
let nativePath = (p) => p;
try { ({ nativePath } = require('./lib/path-shape.js')); } catch { /* sin normalización de rutas: conducta previa */ }

// ── extracción de targets de escritura ────────────────────────────────────────────────────────────

const Q = `(?:'([^']*)'|"([^"]*)"|([^\\s'"|;&<>]+))`; // token: 'x' | "x" | bare
function tok(m, i) { return m[i] ?? m[i + 1] ?? m[i + 2] ?? null; }

function splitSegments(cmd) {
  // Separadores de comandos (no dentro de comillas — aproximación: split simple alcanza para lo
  // que buscamos; las comillas raras caen del lado conservador = no se extrae nada).
  return String(cmd).split(/\s*(?:&&|\|\||;|\||\n)\s*/).filter(Boolean);
}

function lastWord(seg) {
  const words = seg.trim().match(new RegExp(Q, 'g')) || [];
  if (!words.length) return null;
  const m = words[words.length - 1].match(new RegExp(`^${Q}$`));
  return m ? tok(m, 1) : null;
}

/**
 * Limpia del comando lo que NO es comando (hallazgos H1/H2 del review #2, 2026-08-19):
 *  - los CUERPOS de los heredocs (el mensaje de commit HEREDOC del equipo, un .md escrito por heredoc que
 *    cita `> src/x.ts` o `a.ts -> b.ts`) — se conserva la línea de apertura (`cat > f <<EOF`), que es donde
 *    está el target real;
 *  - los strings entre comillas que NO son el token inmediato tras `>`/`>>`/`tee` (`-m "..."`, `-e "..."`,
 *    `grep "sed -i"`), para que su contenido no se lea como redirecciones ni como archivos.
 */
function stripNonCommandText(s) {
  // Heredocs: <<EOF / <<-EOF / <<'EOF' / <<"EOF" … hasta la línea que es sólo el delimitador.
  let t = String(s).replace(/(<<-?[ \t]*(['"]?)([A-Za-z_][\w]*)\2[^\n]*\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
  // Strings entre comillas que no siguen a un operador de redirección / tee: se vacían (quedan las comillas).
  t = t.replace(/(^|[^>\w])(?<!tee[ \t]+)(?<!>[ \t]*)(['"])((?:\\.|(?!\2)[^\\])*)\2/g, (m, pre, q) => `${pre}${q}${q}`);
  return t;
}

/** `cd <dir> && …` al inicio: el dir contra el que resolver targets relativos (best-effort, H10). */
function leadingCd(cmd) {
  const m = String(cmd || '').match(/^\s*cd\s+(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))\s*(?:&&|;)/);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/** Devuelve los paths (tal cual aparecen) que el comando escribe. */
function extractWriteTargets(cmd) {
  const out = new Set();
  const raw = String(cmd || '');
  const s = stripNonCommandText(raw);

  // 1) redirecciones: `> f`, `>> f`, `2> f` (no `>&2`, no `<`)
  const reRedirect = new RegExp(`(?:^|[^<>&])\\d?>{1,2}[ \\t]*${Q}`, 'g');
  let m;
  while ((m = reRedirect.exec(s))) {
    const t = tok(m, 1);
    if (t && !t.startsWith('&') && !/^\/dev\//.test(t)) out.add(t);
  }

  // 2) tee [-a] f1 [f2 …]
  const reTee = /\btee\b((?:[ \t]+-[a-zA-Z]+)*)((?:[ \t]+(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+))+)/g;
  while ((m = reTee.exec(s))) {
    const args = m[2].match(new RegExp(Q, 'g')) || [];
    for (const a of args) {
      const mm = a.match(new RegExp(`^${Q}$`));
      const t = mm ? tok(mm, 1) : null;
      if (t && !t.startsWith('-')) out.add(t);
    }
  }

  // 3) sed -i / --in-place / perl -i / -pi / -ni : todo token con extensión de código del segmento
  for (const seg of splitSegments(s)) {
    // Anclados al INICIO del segmento (H3): `grep -i "sed" src/a.ts` no es un sed -i.
    const head = seg.trim().replace(/^(?:\w+=\S+\s+)*(?:sudo\s+)?/, '');
    const isSedI = /^sed\b/.test(head) && /(^|\s)(-i\b|-[a-zA-Z]*i[a-zA-Z]*\b(?=\s)|--in-place)/.test(head);
    const isPerlI = /^perl\b/.test(head) && /(^|\s)-[a-zA-Z]*i[a-zA-Z]*(\s|$)/.test(head);
    if (isSedI || isPerlI) {
      const words = seg.match(new RegExp(Q, 'g')) || [];
      for (const w of words) {
        const mm = w.match(new RegExp(`^${Q}$`));
        const t = mm ? tok(mm, 1) : null;
        if (t && !t.startsWith('-') && isCodeFile(t)) out.add(t);
      }
    }
    // 4) cp / mv → destino = último token del segmento. También sus formas de PowerShell (Copy-Item /
    //    Move-Item y sus alias copy / cpi / move / mi; no distingue mayúsculas): por la herramienta PowerShell de
    //    Windows (2026-10-04).
    if (/^(?:\w+=\S+\s+)*(?:sudo\s+)?(?:cp|mv)\b/.test(seg.trim()) || /^(?:copy-item|move-item|copy|cpi|move|mi)\b/i.test(seg.trim())) {
      const t = lastWord(seg);
      if (t) out.add(t);
    }
  }

  // 5) scripts inline: open('f','w'|'a'), writeFileSync('f'), fs.writeFile('f', Set-Content/Out-File —
  //    sobre el comando CRUDO (viven dentro de strings que stripNonCommandText vacía a propósito)
  const rePyOpen = /\bopen\(\s*(['"])([^'"]+)\1\s*,\s*(['"])[wa]/g;
  while ((m = rePyOpen.exec(raw))) out.add(m[2]);
  const reNodeWrite = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\(\s*(['"`])([^'"`]+)\1/g;
  while ((m = reNodeWrite.exec(raw))) out.add(m[2]);
  const rePs = /\b(?:Set-Content|Out-File|Add-Content)\b(?:\s+-(?:Path|LiteralPath|FilePath))?\s+(['"]?)([^\s'"]+)\1/gi;
  while ((m = rePs.exec(raw))) out.add(m[2]);
  // [IO.File]::WriteAllText / AppendAllText / WriteAllLines('f', …): escriben como Set-Content (2026-10-04)
  const reDotNet = /\[(?:system\.)?io\.file\]::(?:writealltext|appendalltext|writealllines|appendalllines|writeallbytes)\(\s*(['"])([^'"]+)\1/gi;
  while ((m = reDotNet.exec(raw))) out.add(m[2]);

  // 6) dd of=… y truncate … <file>: dos escritores que la extracción no veía (revisión
  //    adversarial 2026-08-27 — permitían escribir el estado del pipeline esquivando esta puerta).
  const reDd = /\bdd\b[^\n|;&]*?\bof=(['"]?)([^\s'"]+)\1/g;
  while ((m = reDd.exec(s))) out.add(m[2]);
  for (const seg of splitSegments(s)) {
    if (/^(?:\w+=\S+\s+)*(?:sudo\s+)?truncate\b/.test(seg.trim())) {
      const t = lastWord(seg);
      if (t && !t.startsWith('-')) out.add(t);
    }
  }

  return [...out];
}

// ── contenido escrito (para el freno de story-a-mano) ───────────────────────────────────────────

/**
 * Heredocs del comando: [{ body, target }] — el cuerpo (lo que stripNonCommandText descarta a
 * propósito) y el target de SU línea de apertura (`cat > f <<EOF` / `cat <<EOF > f` / `tee f <<EOF`),
 * o null si la línea no redirige a un archivo. La atribución importa (hallazgo F2 del pase
 * adversarial 2026-08-30): sin ella, el cuerpo de un heredoc que reescribe una story EXISTENTE se
 * le atribuía a cualquier `.md` nuevo del mismo comando y lo frenaba como "story nueva".
 */
function heredocs(cmd) {
  const out = [];
  const re = /(^|[\n;&|][ \t]*)([^\n]*?)<<-?[ \t]*(['"]?)([A-Za-z_][\w]*)\3([^\n]*)\n([\s\S]*?)\n[ \t]*\4[ \t]*(?=\n|$)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) {
    const line = `${m[2]} ${m[5]}`;
    const t = extractWriteTargets(line);
    out.push({ body: m[6], target: t.length === 1 ? t[0] : null });
  }
  return out;
}
/** Compat: sólo los cuerpos. */
function heredocBodies(cmd) { return heredocs(cmd).map((h) => h.body); }

/**
 * Frontmatter inline: `printf '---\nstory: "9.9"\n…' > f.md` / `echo -e`. Se des-escapan los `\n`
 * y se toma desde el primer `---` de línea. Devuelve el texto si declara identidad de story, si no null.
 */
function inlineStoryText(cmd, declares) {
  const t = String(cmd || '').replace(/\\n/g, '\n');
  // El `---` abre al inicio, tras un salto de línea o tras la comilla que abre el string.
  const m = t.match(/(^|[\n'"`])---\n/);
  if (!m) return null;
  const slice = t.slice(m.index + m[1].length);
  return declares(slice) ? slice : null;
}

/**
 * `mv|cp <origen> <destino>` donde el ORIGEN existe y ES una story (frontmatter con story:+status:):
 * renombrar o duplicar una story existente no es crearla a mano (hallazgo F3). Devuelve
 * { src, dest } absolutos o null. Sólo el primer segmento cp/mv del comando.
 */
/**
 * El destino de una escritura, absoluto y en la forma nativa de la máquina. En Windows un destino puede venir como
 * `C:\a\b`, `C:/a/b` o `/c/a/b` (la de Git Bash, que es con lo que corre el comando): las tres son el mismo archivo,
 * y sin pasarlas por una sola función la tercera no encontraba su repo y el portón dejaba pasar (story 8.17 del arnés,
 * W1; medido en la corrida 11694). Fuera de Windows es lo de siempre.
 */
function resolveTarget(target, cwd, platform = process.platform, { homeVariable = false } = {}) {
  const P = platform === 'win32' ? path.win32 : path;
  let expanded = String(target).replace(/^~(?=\/|$)/, os.homedir());
  // `$HOME` sólo lo expande quien ya lo expandía (los destinos de una escritura): acá no cambia qué se expande
  if (homeVariable) expanded = expanded.replace(/^\$\{?HOME\}?(?=\/|$)/, os.homedir());
  expanded = nativePath(expanded, platform);
  return P.isAbsolute(expanded) ? expanded : P.resolve(nativePath(cwd, platform), expanded);
}

// ── variables del comando (story 7.25 del arnés, 2026-10-15) ─────────────────────────────────────
// `SP=<scratchpad>; python3 -c "open('$SP/x.cs','w')"` salió frenado como «EDICIÓN INVISIBLE»: el destino se resolvía
// tal cual, `<repo>/$SP/x.cs`, y quedaba adentro del repo de la corrida (caso de un producto del equipo, 2026-10-14).
// Las variables las expande `lib/command-vars.js`: con el valor que tenían EN ESE PUNTO del comando, y si el comando no
// las asignó, con el ambiente. Lo que no se puede saber sin ejecutar (`$(…)`, `${VAR:-x}`, una variable que nadie
// define) queda «sin resolver»: se resuelve como siempre (del lado seguro: si cae en el repo, frena) y queda marcado,
// para que el mensaje diga que no se pudo resolver en vez de presentarlo como código del repo sin más.
// (La primera versión usaba el lector compartido `scripts/lib/shell-parse.js`; el pase adversarial mostró que para esto
// da rutas falsas — la cabecera de command-vars.js dice por qué.)
const { expandirRuta } = require('./lib/command-vars.js');

/**
 * Cada destino de escritura del comando, con su ruta absoluta: `[{ raw, abs, sinResolver: [nombres] }]`.
 * `sinResolver` lista lo que no se pudo resolver (vacía si se resolvió todo).
 */
function destinosResueltos(cmd, cwd, platform = process.platform) {
  return extractWriteTargets(cmd).map((raw) => {
    const { valor, sinResolver } = expandirRuta(cmd, raw);
    return { raw, abs: resolveTarget(valor, cwd, platform, { homeVariable: true }), sinResolver };
  });
}

function renameOrCopyOfExistingStory(cmd, cwd) {
  const seg = splitSegments(stripNonCommandText(cmd)).find((sg) => /^(?:\w+=\S+\s+)*(?:sudo\s+)?(?:cp|mv|git\s+mv)\b/.test(sg.trim()));
  if (!seg) return null;
  const words = (seg.match(new RegExp(Q, 'g')) || []).map((w) => { const mm = w.match(new RegExp(`^${Q}$`)); return mm ? tok(mm, 1) : null; }).filter((w) => w && !w.startsWith('-'));
  if (words.length < 3) return null;
  const abs = (t) => resolveTarget(t, cwd);
  const src = abs(words[words.length - 2]);
  const dest = abs(words[words.length - 1]);
  try {
    const { probeStoryFile } = require('./lib/story-discovery.js');
    return fs.existsSync(src) && probeStoryFile(src) ? { src, dest } : null;
  } catch { return null; }
}

/** El nombre sugiere story cuando no hay contenido legible (cp / mv / tee desde un pipe). */
function nameSuggestsStory(abs) {
  const s = String(abs || '').replace(/\\/g, '/');
  return /(^|\/)story[-_.][^/]*\.md$/i.test(s) || /\/stories\/[^/]+\.md$/i.test(s);
}

// ── hook ──────────────────────────────────────────────────────────────────────────────────────────

function logHookError(e) {
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'),
      `[${new Date().toISOString()}] on-bash-write-gate FAILED OPEN: ${(e && e.stack) || e}\n\n`, 'utf8');
  } catch { /* noop */ }
}

/**
 * Anota dónde escribe un comando de consola (story 2.19 del arnés, 2026-09-17), en
 * `<estado>/console-writes/<sesión>.jsonl`: una línea `{path, ts}` por destino. Lo lee
 * `scripts/metrics/run-change.js` (el arnés) al archivar la corrida, para saber en qué
 * repos buscar el cambio: sin esto, un repo que la corrida tocó sólo por consola no se mira nunca.
 * 🔴 NO va a `file-events/` ni al marcador: esos los leen los frenos de ATDD, y una escritura por consola
 *    ahí cambiaría sus veredictos. Es un registro, no un control: nunca cambia la decisión y un error al
 *    escribir no rompe nada. Apagado: TYCON_NO_RUN_CHANGE=1.
 * Story 8.9 del arnés, tanda D2: la carpeta tenía nombre en castellano; la primera anotación se lleva la vieja
 * entera (`prepareStateWrite` del puente) y el lector mira las dos mientras dure el renombre. Con un arnés anterior a
 * la D2 el puente devuelve la vieja (es la que lee ese arnés). Si la migración falla, queda en hook-errors.log y la
 * anotación va a la vieja: perderla sería callar.
 */
function anotarEscriturasConsola(stateDir, sessionId, rutas) {
  const legacy = require('./lib/legacy-names.js');
  const where = 'skills/tycon-pipeline/scripts/on-bash-write-gate.js';
  if (!rutas.length || legacy.readEnv('TYCON_NO_RUN_CHANGE', { where }) === '1') return;
  const nueva = path.join(stateDir, 'console-writes');
  let dir = nueva;
  try { dir = legacy.prepareStateWrite(nueva, { where }); } catch (e) {
    logHookError(e);
    try { dir = legacy.legacyStatePath(nueva) || nueva; } catch (_) { dir = nueva; }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const sid = String(sessionId || 'sin-sesion').replace(/[^\w.-]/g, '_');
    const ts = new Date().toISOString();
    fs.appendFileSync(path.join(dir, `${sid}.jsonl`), rutas.map((p) => JSON.stringify({ path: p, ts })).join('\n') + '\n', 'utf8');
  } catch (e) { logHookError(e); /* el registro no puede trabar un comando, pero no se pierde callado */ }
}

function handle(event, opts = {}) {
  const laneOff = String(process.env.TYCON_STORY_GATE || '').toLowerCase() === 'off';
  const skillOff = String(process.env.TYCON_STORY_SKILL_GATE || '').toLowerCase() === 'off';
  // Bash, o la herramienta PowerShell de Claude Code en Windows (misma entrada; 2026-10-04)
  if (event?.tool_name && event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') return null;
  const cmd = event?.tool_input?.command;
  if (!cmd) return null;
  const targets = extractWriteTargets(cmd);
  if (!targets.length) return null;

  const baseCwd = nativePath(event?.cwd || process.cwd());
  const cdDir = leadingCd(cmd);
  const cwd = cdDir ? resolveTarget(cdDir, baseCwd) : baseCwd;
  const sessionId = resolveSessionId(event?.session_id);
  const io = require('./lib/story-gate-io.js');
  const stateDir = opts.stateDir || io.DEFAULT_STATE_DIR;
  // story 7.25: con las variables del comando (y del ambiente) expandidas; lo no resuelto queda anotado para el mensaje
  const resueltos = destinosResueltos(cmd, cwd);
  const absTargets = resueltos.map((d) => d.abs);
  const sinResolverDe = new Map(resueltos.filter((d) => d.sinResolver.length).map((d) => [d.abs, d]));
  // Antes de decidir y aunque los frenos estén apagados: dónde escribió la consola es un dato de la
  // corrida, no una decisión del freno (story 2.19).
  anotarEscriturasConsola(stateDir, sessionId, absTargets);
  if (laneOff && skillOff) return null;
  const { isInside } = require('./lib/atdd-preedit.js');
  const via = `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`;

  // ── Portón de CARRIL (código + estado del pipeline) ──────────────────────────────────────────
  if (!laneOff) {
    const passedCode = [];
    for (const abs of absTargets) {
      // un destino con una variable sin resolver PUEDE ser código aunque su ruta cruda no tenga la extensión
      // (`cat > $F`, `src/x.$EXT` — vuelta 7 de revisores): para el registro cuenta como código
      // …salvo que la extensión ESCRITA (sin variables) diga que no es código: `$OUT/notes.md` pasa como cualquier .md
      const extLiteral = /\.([^./\\$`{}]+)$/.exec(path.basename(abs));
      const quizasCodigo = isCodeFile(abs) || (sinResolverDe.has(abs) && !extLiteral);
      if (!quizasCodigo && !isInside(stateDir, abs)) continue;
      if (isCodeFile(abs) || isInside(stateDir, abs)) {
        const r = io.evaluate({ filePath: abs, sessionId, cwd, via, stateDir });
        if (r.verdict.action === 'block') return { block: r.message + '\n' };
      }
      if (quizasCodigo) passedCode.push(abs);
    }
    // ── TERCERA RESPONSABILIDAD (2026-09-21): que el REGISTRO no se quede ciego ────────────────
    // El carril ya dijo que esta sesión PUEDE editar. Falta la otra mitad: si la edición va por
    // Bash con el pipeline abierto, el hook PostToolUse Edit|Write no la ve y `smart-reloop` se
    // queda sin delta (medido en la Story OC-1: 7 revisores en vez de 2-3). Es exactamente el
    // conflicto que la cabecera de este archivo ya declaraba —"en auto mode el propio arnés
    // INSTRUYE editar con sed/heredocs"— resuelto para el carril y no para el registro.
    // Decisión del dev: frenar la edición invisible, no enseñarle al arnés a adivinarla.
    if (passedCode.length) {
      const lv = require('./lib/ledger-visible.js');
      const marker = io.readMarker(stateDir, sessionId);
      const vis = lv.evaluarVisibilidad({
        marker,
        codeTargets: passedCode,
        // un destino con una variable sin resolver PUEDE caer en el repo: cuenta como adentro, aunque la ruta cruda
        // anclada al cwd quede afuera (vuelta 6: con la sesión parada en otra carpeta pasaba callado)
        dentroDelRepo: (f, repo) => isInside(repo, f) || sinResolverDe.has(f),
        off: process.env.TYCON_LEDGER_VISIBLE,
      });
      if (vis.escaped && vis.escaped.length) {
        // El escape del dev deja su línea (story 7.25): el mensaje del freno lo prometía y no se escribía nada.
        try {
          fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
            ts: new Date().toISOString(), sessionId,
            repoPath: (marker && marker.repoPath) || null, name: 'ledger-visible', status: 'escaped',
            storyId: (marker && marker.storyId) || null, files: vis.escaped.length, paths: vis.escaped, via,
            reason: 'TYCON_LEDGER_VISIBLE=off en el ambiente de la sesión',
          }) + '\n', 'utf8');
        } catch (e) { logHookError(e); }
      }
      if (vis.block) {
        try {
          // Constancia en gates.log (misma forma que el resto). El freno NO depende de esto: si el
          // log falla, igual se frena — al revés sería un control que se apaga solo.
          fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
            ts: new Date().toISOString(), sessionId,
            repoPath: (marker && marker.repoPath) || null, name: 'ledger-visible', status: 'blocked',
            storyId: (marker && marker.storyId) || null, files: vis.files.length, via,
          }) + '\n', 'utf8');
        } catch { /* el freno no depende del log */ }
        const sinResolver = vis.files.filter((f) => sinResolverDe.has(f))
          .map((f) => ({ file: f, vars: sinResolverDe.get(f).sinResolver }));
        return { block: lv.mensaje(vis.files, marker && marker.storyId, { sinResolver }) + '\n' };
      }
      // Un destino sin resolver que pasa (sin corrida abierta, o con el escape) no queda callado: constancia en
      // gates.log con la ruta (vuelta 8 de revisores). No suma al cupo ad-hoc: no se sabe qué archivo es.
      const dudosos = passedCode.filter((f) => sinResolverDe.has(f));
      if (dudosos.length) {
        try {
          fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
            ts: new Date().toISOString(), sessionId,
            repoPath: (marker && marker.repoPath) || null, name: 'ledger-visible', status: 'unresolved-passed',
            storyId: (marker && marker.storyId) || null, files: dudosos.length, paths: dudosos, via,
            reason: vis.reason || 'destino con una variable sin resolver',
          }) + '\n', 'utf8');
        } catch (e) { logHookError(e); }
      }
    }

    // Cupo ad-hoc (H9): Bash no tiene PostToolUse nuestro, así que el registro va acá (best-effort: el
    // comando puede fallar después, pero sin esto un hotfix hecho con heredocs nunca suma al cupo).
    for (const abs of passedCode.filter((f) => isCodeFile(f))) {   // un destino sin resolver no suma al cupo: no se sabe cuál es
      try { io.recordAdhocFile(stateDir, sessionId, abs); } catch { /* best-effort */ }
    }
  }

  // ── Freno de STORY A MANO — la puerta Bash (2026-08-30) ─────────────────────────────────────
  if (!skillOff) {
    const mdNew = absTargets.filter((abs) => /\.md$/i.test(abs) && !fs.existsSync(abs));
    if (mdNew.length) {
      const sio = require('./lib/story-skill-gate-io.js');
      let declares = (t) => /^---[\s\S]*?^[ \t]*story[ \t]*:/m.test(t);
      try { ({ declaresStoryIdentity: declares } = require('./lib/story-discovery.js')); } catch { /* fallback regex */ }
      const hds = heredocs(cmd);
      const sameFile = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
      // el mismo destino que se juzgó arriba, con las variables del comando expandidas (story 7.25)
      const resolveT = (t) => { const d = resueltos.find((x) => x.raw === t); return d ? d.abs : resolveTarget(t, cwd); };
      // Un cuerpo sin target atribuible sólo se usa si el comando escribe UN solo .md nuevo (F2).
      const orphanBody = hds.filter((h) => !h.target && declares(h.body)).map((h) => h.body)[0] || null;
      const inline = hds.length ? null : inlineStoryText(cmd, declares);
      const renamedStory = renameOrCopyOfExistingStory(cmd, cwd);
      for (const abs of mdNew) {
        const own = hds.find((h) => h.target && sameFile(resolveT(h.target), abs));
        let content = own ? own.body : null;
        if (!content && !own && mdNew.length === 1) content = orphanBody || inline;
        // `mv`/`cp` desde una story EXISTENTE: es renombrar/duplicar, no crear (F3). Pasa y queda medido.
        if (!content && renamedStory && sameFile(renamedStory.dest, abs)) {
          sio.logUnknown({ absPath: abs, sessionId, via, stateDir, kind: 'unknown-rename', reason: `renombrado/copia de una story existente (${path.basename(renamedStory.src)})` });
          continue;
        }
        const r = sio.evaluate({
          absPath: abs, content, nameHint: !content && nameSuggestsStory(abs),
          sessionId, via, event, stateDir,
        });
        if (r.verdict.action === 'block') return { block: r.message + '\n' };
      }
    }
  }
  return null;
}

module.exports = { handle, resolveTarget, destinosResueltos, extractWriteTargets, stripNonCommandText, leadingCd, heredocs, heredocBodies, inlineStoryText, nameSuggestsStory, renameOrCopyOfExistingStory };

if (require.main === module) {
  let event = null;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || 'null'); } catch { event = null; }
  let r = null;
  try { r = handle(event || {}); } catch (e) { logHookError(e); r = null; }
  if (r && r.block) { process.stderr.write(r.block); process.exit(2); }
  process.exit(0);
}
