#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Edit|Write) — DoD frontmatter gate.
 *
 * Capa 2 de defense-in-depth.
 * Atrapa el problema MÁS TEMPRANO que Capa 1 (`on-pre-commit.js`): cuando
 * Claude/dev hace Edit o Write de un spec Mary+GOLD y la modificación cambia
 * `status:` a `review`/`done` o pone `pipelines.X.status: done` sin que exista
 * la evidencia DoD.
 *
 * Diferencia con Capa 1:
 *   - Capa 1 atrapa en `git commit` — el dev no puede shipear sin evidencia.
 *   - Capa 2 atrapa en el Edit/Write mismo — al agente le impide siquiera
 *     escribir la mentira al filesystem. Mejor UX (feedback inmediato).
 *
 * Lógica:
 *   1. Lee el evento PreToolUse Edit|Write.
 *   2. Si el Edit/Write no es de un `.md` -> exit 0; que SEA una story lo decide
 *      el frontmatter, mas abajo (no se filtra por ruta).
 *   3. Si la operación es Edit → reconstruir el NEW state aplicando el patch
 *      sobre el current. Si Write → el new_string del tool_input ES el state final.
 *   4. Detectar transición de status frontmatter o líneas `status: done`/`review`
 *      en bloques `pipelines.X` que NO existían antes.
 *   4b. Una transición a review/done escrita a mano frena antes que todo lo demás: el estado lo cambia
 *      `marker.js update-story-status` (o la persona, con la firma `marker.js sign-file cambiar-el-estado <historia>`).
 *   5. Si la story requiere runtime evidence (markers Playwright/E2E/smoke
 *      detectados en el contenido) y NO existe `.advisors/dod-runtime/<storyId>-*.md`
 *      → BLOQUEAR (exit 2) con mensaje accionable.
 *
 * Exit codes:
 *   0 → permitir Edit/Write
 *   2 → BLOQUEAR (stderr = mensaje al agente)
 *
 * `handle(event)` es exportable (devuelve {block} en vez de process.exit(2)) para que
 * el dispatcher lo corra in-process. El shim CLI del fondo preserva el comportamiento
 * standalone idéntico (incl. fail-open).
 *
 * Fail-open: errores del hook propio no bloquean operaciones válidas (pero quedan
 * logueados para que un gate caído sea visible).
 */

const fs = require('fs');
const path = require('path');
const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // la carpeta del estado, de una sola pieza
const os = require('os');
const { sessionIdFileKey } = require('./lib/session-id.js');

function readEvent() {
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (!stdin) return null;
    return JSON.parse(stdin);
  } catch {
    return null;
  }
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split('\n');
  const out = {};
  for (const line of lines) {
    const mm = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.+)$/);
    if (!mm) continue;
    let val = mm[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[mm[1]] = val;
  }
  return out;
}

function storyRequiresRuntimeEvidence(content) {
  if (!content) return false;
  const markers = [
    'tests_done_playwright_spec',
    'tests_pending_runtime',
    'playwright',
    'Playwright',
    'E2E',
    'e2e-tests',
    'smoke runtime',
  ];
  return markers.some(m => content.includes(m));
}

function storyIsExempt(content) {
  return /^dod_runtime_exempt:\s*true\b/m.test(content);
}

// La exención como la reconoce el más ancho de los lectores que la conceden (este hook, on-pre-commit, el portón de CI,
// runtime-matrix, pipeline.js): en cualquier renglón del archivo, con sangría, con o sin comillas y con lo que siga
// (un comentario). Si este control mirara menos que ellos, una forma que no ve pasaría sin la frase y valdría igual.
const EXENTA = /^\s*dod_runtime_exempt:\s*["']?true\b/m;
// la regla del cambio de estado a mano es la misma para la herramienta de edición y para la consola
const { transicionAMano, isCriticalStatus, EN_IMPLEMENTACION } = require('./lib/story-transition.js');
// El estado del encabezado, con fines de renglón de Windows y comillas simples o dobles.
const estadoDe = (c) => { const m = /^status:\s*["']?([\w-]+)/m.exec(fmBlock(c)); return m ? m[1].toLowerCase() : ''; };
// Una historia: un encabezado con `story:` o `status:`. Una guía que nombra la exención no lo tiene.
const esHistoria = (c) => /^(?:story|status):/m.test(fmBlock(c));

/**
 * La firma de la ventana sobre este archivo (`marker.js sign-file <firma> <archivo>`, scripts/lib/owner-window.js):
 * `{ ok: true, constancia }` la consume; `{ ok: false, motivo }` si no la hay. `casa`: la de las pruebas.
 */
function firmaDeLaVentana(firma, event, filePath, casa) {
  try {
    const ow = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
    return { ...ow.consumirArchivo({ firma, sesion: event.session_id, archivo: filePath, cwd: event.cwd, casa }), comando: ow.comoSeFirma(firma, filePath) };
  } catch (e) {
    return { ok: false, motivo: `no pude consultar la ventana (${e.message})`, comando: `marker.js sign-file ${firma} ${filePath}` };
  }
}

/**
 * La exención de la prueba en vivo que se agrega a una historia (pasa de ausente o `false` a `true`, también al crearla)
 * la decide la persona, en cualquier estado: sin su firma en la ventana sobre esta historia, `{ block }` que nombra el
 * comando; con ella, pasa (null) y queda la constancia con la sesión. El agente que escribe la historia no se exime solo.
 */
function exencionNueva(event, oldContent, newContent, casa) {
  if (!EXENTA.test(newContent) || (oldContent && EXENTA.test(oldContent)) || !esHistoria(newContent)) return null;
  // el estado de antes o el de después, para el mensaje; la historia nueva no tiene estado de antes
  const antes = estadoDe(oldContent || '');
  const estado = EN_IMPLEMENTACION.has(antes) ? antes : (estadoDe(newContent) || antes || 'sin estado');
  const sid = event.session_id;
  const r = firmaDeLaVentana('dod_runtime_exempt', event, event.tool_input.file_path, casa);
  const ok = r.ok === true;
  const storyId = parseFrontmatter(newContent).story || '';
  try {
    const { rutaDeLaLib } = require('./lib/closing-record.js');
    // el camino es el de la firma: la ventana, la delegación o la terminal
    require(rutaDeLaLib()).anotar({ freno: 'on-frontmatter-write', regla: 'exencion-nueva', veredicto: ok ? 'escape' : 'bloqueo',
      cmd: `${storyId}\0${estado}`, ...(ok ? { via: r.constancia.via, sesion: sid, escape: 'dod_runtime_exempt' } : {}) });
  } catch { /* ayuda, no evidencia */ }
  if (ok) return null;
  const titulo = `🚨 BLOQUEADO — agregar la exención dod_runtime_exempt a la story ${storyId} (estado ${estado}) la exime de la prueba en vivo.`;
  return {
    block: [
      titulo,
      '',
      'Eximir una historia lo decide la persona, no el agente, también mientras se escribe. Si la persona quiere,',
      `la firma en la ventana de permiso: corré ${r.comando} y, con su «Sí», repetí esta escritura.`,
      'El camino normal es correr la prueba en vivo; si la historia no se puede terminar, dejarla como deuda',
      '(marker.js close-as-debt).',
      `(No hay firma: ${r.motivo}.)`,
    ].join('\n') + '\n',
  };
}

// 🔴 Qué es «evidencia de cierre» lo decide UNA función compartida. Un hook que aceptara cualquier
// `<id>-*.md` (matriz y self-audit incluidos) dejaría pasar una story que el freno del commit y el
// portón de CI rechazan después. Ver `lib/closing-evidence.js` (criterio y motivo de cada exclusión).
const { esEvidenciaDeCierre } = require('./lib/closing-evidence.js');

// El prefijo de la evidencia de una story: con la ruta de la story, su CLAVE
// (lib/evidence-key.js) — con un número repetido en el repo, `<id>-*` es la evidencia de cualquiera de las
// stories que lo comparten. Si la clave no se puede decidir: null = no hay evidencia (fail-closed). Sin ruta, el id.
// La regla es `evidencePrefix`, la MISMA que el portón de Azure: con la story todavía fuera del disco
// (un Write que la crea ya en `done`) no se cae al número solo, que aceptaría la evidencia de otra story.
function prefijoDe(storyId, storyPath) {
  const { prefix, error } = require('./lib/evidence-key.js').evidencePrefix(storyPath, storyId);
  // «No pude calcular la clave» no es «no hay evidencia»: el motivo se dice (y el bloqueo lo repite).
  if (!prefix) process.stderr.write(`⚠️ tycon-dod-runtime (frontmatter): ${error} — sin clave no doy evidencia por buena.\n`);
  return prefix;
}

function hasDodEvidence(repoRoots, storyId, storyPath) {
  const expectedPrefix = prefijoDe(storyId, storyPath);
  if (!expectedPrefix) return false;
  for (const root of repoRoots) {
    const dir = path.join(root, '.advisors', 'dod-runtime');
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      if (files.some(f => f.startsWith(expectedPrefix) && esEvidenciaDeCierre(f))) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

// Story con E2E reales (markers fuertes de test IDs Playwright en el frontmatter).
// Distinto de storyRequiresRuntimeEvidence (que matchea cualquier mención de "E2E"):
// acá buscamos IDs concretos de tests E2E declarados como cobertura.
function storyNeedsPlaywrightRun(content) {
  if (!content) return false;
  // Test IDs E2E típicos: E1, E6, FullUI-2, E2E-4.3.1, etc. en tests_done/tests del frontmatter.
  return /\b(FullUI-\d|E2E-\d|E\d+-[a-z])/.test(content) ||
         /tests_done_playwright_spec/.test(content) ||
         /tests\/e2e\//.test(content);
}

// FRESHNESS floor: sin piso de frescura, evidencia VIEJA satisfaría el gate para siempre
// (un run verde de hace 3 iteraciones "validaría" código que cambió después).
// El floor = mtime más nuevo de los archivos de CÓDIGO tocados por el pipeline
// (marker.filesTouched de la sesión). Evidencia con mtime anterior al último
// cambio de código = STALE → no satisface el gate. Sin marker → sin floor
// (no rompe edits fuera de pipeline).
/**
 * ¿Cuándo cambió DE VERDAD el código que esta sesión tocó? (el «piso de frescura»)
 *
 * 🔴 Se decide por CONTENIDO, no por fechas. Las fechas fallan en las dos direcciones:
 *   - la fecha del DISCO (mtime) sube sola con un `git checkout`, un rebase o un `stash pop` que
 *     dejan el MISMO contenido → el freno rechazaría una corrida de Playwright válida;
 *   - la fecha del COMMIT (%ct) es cuándo ALGUIEN commiteó, no cuándo ese contenido llegó a este
 *     disco: un `pull` que trae un commit ajeno fechado antes de la corrida dejaría pasar evidencia
 *     vieja como fresca (verde falso), un rebase o un --amend la pondrían en «hoy», y un commit
 *     posterior a la evidencia —el orden normal del pipeline— la invalidaría.
 *
 * El dato que sí responde la pregunta lo escribe `on-edit.js` en el marker en cada toque:
 * `filesTouchedAt[archivo] = { hash, ts }` — el sello del contenido que ESA edición dejó y su hora.
 * Entonces, por archivo:
 *   - si el contenido actual tiene el MISMO hash que el último toque de la sesión → cambió en ese
 *     toque (`ts`): un checkout, un rebase, un amend, un stash pop o un commit posterior no lo mueven;
 *   - si el hash es OTRO → alguien más lo cambió después (un pull, un script, una mano ajena) y
 *     la única señal de cuándo es la fecha del disco, que en ese caso es verdad;
 *   - sin sello (marker viejo, archivo tocado por Bash) → fecha del disco, el comportamiento
 *     conservador de siempre.
 * Cero llamadas a git: un hash por archivo. Un archivo ignorado por git cuenta igual que cualquiera.
 * Como dice `ACCOV-C11`, la fecha del archivo no prueba frescura: acá sólo se usa
 * cuando el contenido demuestra que cambió.
 */
function pisoDeArchivos(files, registro) {
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const { selloDeArchivo, soloCambioElFinDeLinea } = require('./lib/content-seal.js');
  const sello = (f) => { try { return selloDeArchivo(f).hash; } catch { return null; } };
  const reg = registro && typeof registro === 'object' ? registro : {};
  let piso = 0;
  for (const f of files) {
    const r = reg[f] || reg[(() => { try { return fs.realpathSync(f); } catch { return f; } })()];
    if (r && typeof r.hash === 'string' && Number.isFinite(Number(r.ts))) {
      const h = sello(f);
      if (h === null) continue;                                 // borrado: no cuenta
      // los bytes cambiaron sólo en el fin de línea (un checkout con autocrlf=true): el mismo contenido del toque
      piso = Math.max(piso, h === r.hash || soloCambioElFinDeLinea(f, r) ? Number(r.ts) : mtime(f));
    } else {
      piso = Math.max(piso, mtime(f));
    }
  }
  return piso;
}

/** La fecha de cambio de UN archivo — el mismo criterio, para poder probarlo de a uno. */
function fechaDeCambio(f, registro) {
  try { fs.statSync(f); } catch { return 0; }   // borrado: no cuenta
  return pisoDeArchivos([f], registro);
}

function computeFreshnessFloor(sessionId) {
  try {
    const sid = sessionIdFileKey(sessionId);
    const markerPath = path.join(stateDirOf(os.homedir()), 'active', `${sid}.json`);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const codeFiles = (marker.filesTouched || [])
      .filter((f) => !/\.md$/i.test(f) && !/\/specs\//.test(f))
      .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    return pisoDeArchivos(codeFiles, marker.filesTouchedAt) || null;
  } catch {
    return null;
  }
}

// Verifica que exista AL MENOS un archivo de evidencia con un bloque
// "## Playwright Run" verdict=PASS + failed=0 (macro backend) o "- failed: 0" (e2e-gate.sh genérico:
// el regex acepta las dos formas)
// Y (si hay freshnessFloor) con mtime POSTERIOR al último cambio de código.
/**
 * ¿Cuándo se GENERÓ la evidencia? No es la fecha del archivo: un merge o un checkout la reescriben y
 * la rejuvenecen, y una corrida vieja pasaría en main lo que en dev es STALE. La evidencia lleva su hora adentro (`**Generado**: <iso>`, `ts: <iso>`, o el
 * sello compacto del nombre o del encabezado, `20260710T031538Z`, que es el que escribe e2e-gate.sh):
 * la más nueva de las que trae es la de generación, y la fecha del archivo sólo
 * puede ser POSTERIOR a ésa — así que vale la menor de las dos. Sin hora adentro, la del archivo.
 */
function tiempoDeEvidencia(full, contenido) {
  let t = Infinity;
  try { t = fs.statSync(full).mtimeMs; } catch { /* sin stat: sólo lo de adentro */ }
  const texto = `${path.basename(full)}\n${contenido || ''}`;
  const isos = texto.match(/\b20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?\b/g) || [];
  // 🔴 El sello COMPACTO `20260710T031538Z` es el que escribe `e2e-gate.sh` —el único productor de
  // evidencia Playwright del pipeline— en el nombre del archivo y en su encabezado, y no lo escribe
  // en ningún otro formato. Sin esto, la mayoría de las evidencias caería al mtime y el defecto que
  // esta función cierra quedaría abierto.
  for (const c of texto.match(/\b(20\d\d)(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z?\b/g) || []) {
    isos.push(`${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T${c.slice(9, 11)}:${c.slice(11, 13)}:${c.slice(13, 15)}Z`);
  }
  // y el sello con guion (`20260603-194420`) que usan otros escritores
  for (const c of texto.match(/\b(20\d\d)(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\b/g) || []) {
    isos.push(`${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T${c.slice(9, 11)}:${c.slice(11, 13)}:${c.slice(13, 15)}Z`);
  }
  // y la fecha con guiones pero la hora pegada (`2026-05-27T003941`), del DoD checker
  for (const c of texto.match(/\b20\d\d-\d\d-\d\dT\d{6}\b/g) || []) {
    isos.push(`${c.slice(0, 11)}${c.slice(11, 13)}:${c.slice(13, 15)}:${c.slice(15, 17)}Z`);
  }
  const dentro = isos.map((x) => Date.parse(x)).filter((x) => Number.isFinite(x));
  if (dentro.length) t = Math.min(t, Math.max(...dentro));
  return Number.isFinite(t) ? t : 0;
}

function hasFreshPlaywrightPass(repoRoots, storyId, freshnessFloor, storyPath) {
  const expectedPrefix = prefijoDe(storyId, storyPath);
  if (!expectedPrefix) return { pass: false, stale: false };
  let foundStale = false;
  for (const root of repoRoots) {
    const dir = path.join(root, '.advisors', 'dod-runtime');
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(expectedPrefix) || !f.endsWith('.md')) continue;
        const full = path.join(dir, f);
        const c = fs.readFileSync(full, 'utf8');
        if (/##\s*Playwright Run/i.test(c) && /verdict=PASS/.test(c) && /failed(?:=|:\s*)0\b/.test(c)) {
          if (freshnessFloor && tiempoDeEvidencia(full, c) < freshnessFloor) {
            foundStale = true;
            continue; // verde pero STALE — seguir buscando una fresca
          }
          return { pass: true };
        }
      }
    } catch {
      // ignore
    }
  }
  return { pass: false, stale: foundStale };
}

// Roots donde puede vivir la evidencia de ESTA story: el repo git
// que contiene el spec + sus companions declarados (`.tycon/advisors.yaml →
// evidence.companion_repos`) + subproyectos con evidencia — criterio único en
// lib/evidence-config.js, el mismo de runtime-matrix.js y on-pre-commit.js. No se suman TODOS los
// hermanos git del padre: los story-id colisionan entre productos y un `<sid>-*.md` ajeno
// satisfaría el check de evidencia.
function findRepoRoots(filePath) {
  const ec = require('./lib/evidence-config.js');
  const repo = ec.discoverRepoRoot(filePath);
  if (!repo) return []; // sin repo no hay atribución segura: el hook queda fail-closed
  // Modo FRENO: los hermanos declarados sólo cuentan si están commiteados.
  for (const aviso of ec.parseEvidenceConfig(repo, { freno: true }).warnings) process.stderr.write(`${aviso}\n`);
  return ec.productEvidenceRoots(repo, { freno: true });
}

/**
 * El archivo como queda después del `apply_patch` de Codex (`scripts/lib/hook-io.js` lo pasa como un Edit por archivo,
 * con el parche entero en `tool_input`): cada tramo `@@` reemplaza sus renglones ` `/`-` por los ` `/`+`, en orden. Si un
 * tramo no se encuentra, el resultado es el archivo de antes con los renglones `status:` que el parche agrega puestos en
 * el encabezado: lo que no se pudo aplicar se juzga por lo que el parche escribe.
 */
function contenidoPorParche(event, filePath, oldContent) {
  const ti = event.tool_input || {};
  const parche = String(ti.command || ti.patch || ti.input || '').replace(/\r\n/g, '\n');
  const cwd = (event.cwd && String(event.cwd)) || process.cwd();
  const bloque = parche.split(/\n(?=\*\*\* (?:Add|Update|Delete) File: )/).find((b) => {
    const m = b.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
    return m && path.resolve(cwd, m[1].trim()) === path.resolve(filePath);
  });
  if (!bloque) return oldContent;
  // un archivo agregado entero: sus renglones `+` son el archivo
  if (/^\*\*\* Add File: /.test(bloque)) {
    return bloque.replace(/\n\*\*\* End Patch[\s\S]*$/, '').split('\n').filter((r) => r.startsWith('+')).map((r) => r.slice(1)).join('\n');
  }
  let texto = oldContent;
  let desde = 0;
  const tramos = bloque.split(/^@@.*$/m).slice(1);
  // sin tramos no hay de dónde leer el cambio: se juzga por lo que escribe
  let aplicado = tramos.length > 0;
  for (const tramo of tramos) {
    const renglones = tramo.replace(/\n\*\*\* End Patch[\s\S]*$/, '').split('\n').filter((r) => /^[ +-]/.test(r));
    const antes = renglones.filter((r) => r[0] !== '+').map((r) => r.slice(1)).join('\n');
    const despues = renglones.filter((r) => r[0] !== '-').map((r) => r.slice(1)).join('\n');
    const i = texto.indexOf(antes, desde);
    if (!antes || i < 0) { aplicado = false; break; }
    texto = texto.slice(0, i) + despues + texto.slice(i + antes.length);
    desde = i + despues.length;
  }
  if (aplicado) return texto;
  const agregados = bloque.split('\n').filter((r) => /^\+\s*status:/.test(r)).map((r) => r.slice(1));
  if (!agregados.length) return oldContent;
  // el estado nuevo reemplaza al del encabezado; uno con sangría es del bloque pipelines: se suma al final del encabezado
  let fm = oldContent;
  for (const r of agregados) {
    fm = /^\s/.test(r) ? fm.replace(/\n---/, () => `\n${r}\n---`) : fm.replace(/^status:.*$/m, () => r);
  }
  return fm;
}

/**
 * Una historia cuyo estado cambia con la herramienta de edición (ver `transicionAMano`). El estado lo cambia el
 * orquestador, que corre los controles del cierre: `marker.js update-story-status`, `update-pipeline-status` o
 * `/tycon-pipeline close`. A mano lo decide la persona, con su firma en la ventana sobre esta historia
 * (`marker.js sign-file cambiar-el-estado <historia>`): con ella pasa, queda la constancia y siguen las reglas de la evidencia. `TYCON_STATUS_GATE=off` en el ambiente del gancho lo apaga, y queda
 * anotado; escrito en un comando, lo frena el freno de seguridad.
 */
function estadoAMano(event, filePath, oldContent, newContent, casa) {
  const apagado = String(process.env.TYCON_STATUS_GATE || '').toLowerCase() === 'off';
  const t = transicionAMano(filePath, oldContent, newContent);
  if (!t) return null;
  const sid = event.session_id;
  const r = apagado ? { ok: false } : firmaDeLaVentana('cambiar-el-estado', event, filePath, casa);
  const ok = apagado || r.ok === true;
  const via = apagado ? 'ambiente' : (r.constancia && r.constancia.via);
  // La constancia con las reglas de la biblioteca del cierre: apagada con TYCON_CLOSURE_RECORD=off (las suites que
  // llaman al gancho con el HOME real) y callada sin la biblioteca (el gancho decide igual). Con la biblioteca, un escape
  // que no quedó anotado no pasa callado
  try {
    const legacy = require('./lib/legacy-names.js');
    const apagada = String(legacy.readEnv('TYCON_CLOSURE_RECORD', { where: 'skills/tycon-pipeline/scripts/on-frontmatter-write.js' }) || '').toLowerCase() === 'off';
    const { rutaDeLaLib } = require('./lib/closing-record.js');
    const lib = rutaDeLaLib();
    if (!apagada && fs.existsSync(lib)) {
      const res = require(lib).anotar({ freno: 'on-frontmatter-write', regla: 'estado-a-mano', veredicto: ok ? 'escape' : 'bloqueo',
        cmd: `${t.storyId}\0${t.estado}`,
        ...(ok ? { via, sesion: sid, escape: apagado ? 'TYCON_STATUS_GATE' : 'cambiar-el-estado' } : {}) });
      if (ok && res && res.escrito === false) {
        process.stderr.write(`⚠️ on-frontmatter-write: no pude anotar el escape del estado a mano (${res.motivo || 'el registro no se escribió'}).\n`);
      }
    }
  } catch (e) {
    try {
      fs.mkdirSync(stateDirOf(os.homedir()), { recursive: true });
      fs.appendFileSync(path.join(stateDirOf(os.homedir()), 'hook-errors.log'),
        `[${new Date().toISOString()}] on-frontmatter-write estado-a-mano: la constancia no se anotó (${(e && e.message) || e})\n`, 'utf8');
    } catch { /* ayuda, no evidencia */ }
  }
  if (ok) return null;
  const marker = '~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js';
  const destino = isCriticalStatus(t.estado) || !/^pipelines\./.test(t.estado) ? t.estado : `done en ${t.estado}`;
  const titulo = `🚨 BLOQUEADO — la story ${t.storyId} pasa a ${destino} escribiendo el archivo a mano.`;
  return {
    block: [
      titulo,
      '',
      'El estado de una historia lo cambia el orquestador, que corre los controles del cierre. Usá en su lugar:',
      `  · node ${marker} update-story-status ${filePath} <estado>`,
      `  · node ${marker} update-pipeline-status ${filePath} <tanda|--all> <estado>   (el bloque pipelines)`,
      '  · /tycon-pipeline close <id> para pasarla a done después del merge',
      'Si el comando frena porque la ejecución está en rojo, cerrarla igual lo decide la persona; si la historia no',
      'se puede terminar, la salida es dejarla como deuda (marker.js close-as-debt).',
      `Escribirla a mano lo decide la persona: la firma en la ventana de permiso con ${r.comando},`,
      'y con su «Sí» se repite esta escritura.',
    ].join('\n') + '\n',
  };
}

// ── Constancia ───────────────────────────────────────────────────────────────────────────────
// Cada decisión sobre una transición a review/done deja UNA línea en frenos.jsonl (sólo la huella:
// id de story + estado nuevo). Ayuda, no evidencia: no toca la decisión ni la salida del hook.
// La lib se carga acá adentro y envuelta: si faltara (instalación a medias), el hook frena igual.
function anotarDecision(regla, veredicto, storyId, estado) {
  try {
    require('./lib/closing-record.js').anotarCierre({ freno: 'on-frontmatter-write', regla, veredicto, huella: `${storyId}\0${estado || ''}` });
  } catch { /* ayuda, no evidencia */ }
}

const fmBlock = (c) => { const m = c.match(/^---\r?\n([\s\S]*?)\r?\n---/); return m ? m[1] : ''; };

/**
 * ¿El Edit/Write transiciona una STORY a review/done? Pura y sin salida: la usa la constancia de la
 * rama de exención, que corta ANTES de que el flujo principal lea la config del repo (y sus avisos).
 * Mismo criterio que el flujo principal: story declarada + id con forma de trabajo + transición de
 * `status:` o un `status: done` nuevo en el bloque `pipelines`.
 */
function transicionDeStory(filePath, oldContent, newContent) {
  try {
    const oldFm = parseFrontmatter(oldContent);
    const newFm = parseFrontmatter(newContent);
    const declaredId = newFm.story;
    if (!declaredId || !newFm.status) return null;
    const { isWorkStoryId, storiesConfigForGate, findRepoRoot } = require('./lib/story-discovery.js');
    if (!isWorkStoryId(String(declaredId), storiesConfigForGate(findRepoRoot(filePath)).idPattern)) return null;
    const oldS = (oldFm.status || '').toLowerCase();
    const newS = (newFm.status || '').toLowerCase();
    const statusTransition = isCriticalStatus(newS) && newS !== oldS;
    const pipelineTransition = (fmBlock(newContent).match(/^\s+status:\s*done\b/gm) || []).length
      > (fmBlock(oldContent).match(/^\s+status:\s*done\b/gm) || []).length;
    return statusTransition || pipelineTransition ? { storyId: String(declaredId), estado: newS } : null;
  } catch {
    return null; // la constancia nunca decide nada: ante la duda, no anota
  }
}

/**
 * Handler dispatchable. Recibe el evento RAW y devuelve:
 *   null              → permitir (exit 0)
 *   { block: msg }    → BLOQUEAR (el caller escribe msg a stderr + exit 2)
 * Lee el archivo del filesystem (oldContent) — eso es intencional.
 */
function handle(event, { casa } = {}) {
  if (!event) return null;

  const tool = event.tool_name;
  if (tool !== 'Edit' && tool !== 'Write') return null;

  const filePath = event.tool_input?.file_path;
  if (!filePath) return null;

  // Sólo `.md`; que SEA una story lo decide el frontmatter, más abajo. No se filtra por ruta: un
  // filtro tipo `specs/stories/` apagaría el freno en los repos con otro layout, sin un solo mensaje.
  if (!/\.md$/i.test(filePath)) return null;

  // Reconstruir el NEW state.
  let newContent;
  const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  if (tool === 'Write') {
    newContent = event.tool_input.content || '';
  } else if (event.tool_name_raw === 'apply_patch') {
    // Codex: el Edit trae el parche, no el reemplazo. Sin poder aplicarlo, un `+status: review|done` cuenta como el
    // paso a ese estado (del lado que frena)
    newContent = contenidoPorParche(event, filePath, oldContent);
  } else {
    // Edit — aplicar mentalmente el reemplazo.
    const oldStr = event.tool_input.old_string || '';
    const newStr = event.tool_input.new_string || '';
    if (!oldContent.includes(oldStr)) {
      // El Edit va a fallar de todas formas (old_string no matchea). Dejá pasar
      // — Claude Code va a reportar el error real.
      return null;
    }
    // Usar función de reemplazo — `String.replace(str, newStr)` interpreta
    // `$&`/`$1`/`$$` en newStr como patrones especiales, así que un new_string con `$` daría
    // un newContent distinto al que Edit escribe realmente. La forma `() => newStr` lo evita.
    newContent = event.tool_input.replace_all === true
      ? oldContent.split(oldStr).join(newStr)
      : oldContent.replace(oldStr, () => newStr);
  }

  // La exención nueva en una historia la decide la persona, en cualquier estado.
  const exencion = exencionNueva(event, oldContent, newContent, casa);
  if (exencion) return exencion;

  // Pasar una historia a review o done a mano también: el camino es el comando del orquestador.
  const aMano = estadoAMano(event, filePath, oldContent, newContent, casa);
  if (aMano) return aMano;

  // Exención explícita.
  if (storyIsExempt(newContent)) {
    const t = transicionDeStory(filePath, oldContent, newContent);
    if (t) anotarDecision('exenta', 'paso', t.storyId, t.estado);
    return null;
  }

  const oldFm = parseFrontmatter(oldContent);
  const newFm = parseFrontmatter(newContent);

  // El criterio ESTRUCTURAL de "esto es una story": su frontmatter declara `story:` y `status:`,
  // y el id tiene FORMA de trabajo. Un `.md` de documentación con `status: publicado` no entra
  // (le falta `story:`), y el material de un banco de evals tampoco (`story: "EV-1"` no es un id
  // de trabajo) — el repo puede declarar otra forma en `.tycon/advisors.yaml → stories.id_pattern`.
  const declaredId = newFm.story;
  if (!declaredId || !newFm.status) return null;
  const { isWorkStoryId, storiesConfigForGate, findRepoRoot } = require('./lib/story-discovery.js');
  const repoOfStory = findRepoRoot(filePath);
  // Modo FRENO — misma razón que en on-pre-commit.js: este hook es la SEGUNDA
  // capa del mismo control, y se apagaría con el mismo archivo sin commitear.
  const cfgFreno = storiesConfigForGate(repoOfStory);
  for (const aviso of cfgFreno.warnings) process.stderr.write(`${aviso}\n`);
  if (!isWorkStoryId(String(declaredId), cfgFreno.idPattern)) return null;

  // Trigger 1: top-level status transition. Atrapamos:
  //   - in-progress/ready-for-dev/blocked → review  (entrar a review)
  //   - in-progress/ready-for-dev/blocked → done    (entrar a done)
  //   - review → done                                (escalar a done)
  // No atrapamos done → review (revertir) ni review → review (no-op).
  const oldS = (oldFm.status || '').toLowerCase();
  const newS = (newFm.status || '').toLowerCase();
  const statusTransition =
    isCriticalStatus(newS) && newS !== oldS;

  // Trigger 2: pipeline.X.status: done en el new state que NO estaba antes.
  // Heurística: contamos ocurrencias de `status: done` indentado (block pipelines).
  // Contar SOLO dentro del bloque frontmatter (entre los dos `---`),
  // no en todo el contenido — un spec que documente el pipeline con un `status: done`
  // indentado en prosa/code-block NO debe disparar el gate (falso positivo que bloquearía
  // edits no relacionados).
  const oldDoneCount = (fmBlock(oldContent).match(/^\s+status:\s*done\b/gm) || []).length;
  const newDoneCount = (fmBlock(newContent).match(/^\s+status:\s*done\b/gm) || []).length;
  const pipelineTransition = newDoneCount > oldDoneCount;

  if (!statusTransition && !pipelineTransition) return null;

  const storyId = newFm.story || path.basename(filePath, '.md');

  // Story requiere runtime evidence?
  if (!storyRequiresRuntimeEvidence(newContent)) {
    anotarDecision('sin-superficie-runtime', 'paso', storyId, newS);
    return null;
  }

  const repoRoots = findRepoRoots(filePath);
  const needsPlaywright = storyNeedsPlaywrightRun(newContent);

  if (hasDodEvidence(repoRoots, storyId, filePath)) {
    // Evidencia genérica existe. Pero si la story tiene E2E reales, ADEMÁS exigir
    // un bloque "## Playwright Run" verdict=PASS (escrito por el gate E2E del proyecto)
    // FRESCO (posterior al último cambio de código de esta corrida).
    const freshnessFloor = computeFreshnessFloor(event.session_id);
    const pw = needsPlaywright ? hasFreshPlaywrightPass(repoRoots, storyId, freshnessFloor, filePath) : { pass: true };
    if (needsPlaywright && !pw.pass && deudaDeNavegador(newContent, filePath, storyId, newS)) return null;
    if (needsPlaywright && !pw.pass) {
      const pl = [];
      pl.push('🚨 BLOQUEADO — story con E2E reales pasa a review/done SIN suite Playwright verde' + (pw.stale ? ' FRESCA' : ''));
      pl.push('');
      pl.push(`  File: ${filePath}`);
      pl.push(`  Story: ${storyId}`);
      pl.push('');
      if (pw.stale) {
        pl.push('Hay evidencia Playwright verde pero es STALE: su mtime es ANTERIOR al último');
        pl.push('cambio de código de esta corrida (marker.filesTouched). Un run verde de hace');
        pl.push('N iteraciones no valida el código que cambió después — re-corré el gate.');
      } else {
        pl.push('Existe evidencia DoD genérica, PERO la story declara tests E2E (FullUI-/E2E-/');
        pl.push('tests_done_playwright_spec) y NO hay un bloque "## Playwright Run" con verdict=PASS');
        pl.push(`en .advisors/dod-runtime/${prefijoDe(storyId, filePath) || '(sin clave: ver el aviso de arriba) '}*.md.`);
      }
      pl.push('');
      pl.push('Correr el gate determinístico del PROYECTO (.tycon/advisors.yaml → e2e.gate):');
      pl.push('');
      // La ruta del archivo sale de tmp-path.js: con una ruta fija bajo /tmp, en Windows bash escribiría
      // en la carpeta temporal del usuario y Node leería C:\tmp — quien escribe y quien lee usan "$E2ECFG".
      pl.push('  E2ECFG=$(node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/lib/tmp-path.js e2ecfg <repo>)');
      pl.push('  node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js e2e-config --repo <repo> > "$E2ECFG"');
      pl.push('  GATE=$(node -e \'process.stdout.write(require(process.argv[1]).gate||"")\' "$E2ECFG")');
      pl.push('  FE=$(node -e \'process.stdout.write(require(process.argv[1]).frontend_dir||"")\' "$E2ECFG")');
      // En un monorepo `APPS` puede traer MÁS DE UNA app: el gate va una vez por app tocada.
      // Sugerir el comando de una sola app dejaría sin gate a las demás.
      pl.push(`  EVID=$(node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js evidence-dir --story <spec> --repo <repo> --plain)   # el repo de la STORY`);
      pl.push(`  echo "$APPS" | while read -r FE; do [ -n "$FE" ] || continue; \\`);
      pl.push(`    bash "$GATE" "$FE" ${storyId} "$EVID" || exit 1; done   # [spec-filter...] = scoped`);
      pl.push('');
      pl.push('Por default corre los specs SCOPED a la story (two-tier 2026-06-09); la suite');
      pl.push('COMPLETA corre 1 vez en /tycon-merge-to-main. Exit !=0 si hay rojos → fix antes de done.');
      pl.push('');
      pl.push('Única salida sin correrla: eximir la story (sólo si NO tiene UI/E2E reales), que lo decide la persona: lo firma con marker.js sign-file dod_runtime_exempt <historia>.');
      pl.push('');
      pl.push('Caso disparador: Ceibo Stories 4.2 + 4.3.1 (2026-05-20) — E2E declarados "PASS"');
      pl.push('sin correrse / con mocks. Freshness agregada 2026-06-09 (evidencia vieja');
      pl.push('satisfacía el gate para siempre).');
      anotarDecision(pw.stale ? 'evidencia-vieja' : 'e2e-gate-rojo', 'bloqueo', storyId, newS);
      return { block: pl.join('\n') + '\n' };
    }
    anotarDecision('evidencia-ok', 'paso', storyId, newS);
    return null;
  }

  // ============================================================
  // BLOQUEAR (exit 2)
  // ============================================================
  const lines = [];
  lines.push('🚨 BLOQUEADO — Edit/Write transiciona story a review/done sin DoD evidence');
  lines.push('');
  lines.push(`  File: ${filePath}`);
  lines.push(`  Story: ${storyId}`);
  lines.push(`  ${statusTransition ? '→ status: ' + (oldFm.status || '?') + ' → ' + (newFm.status || '?') : ''}`);
  lines.push(`  ${pipelineTransition ? `→ pipelines.*.status: done added (${oldDoneCount} → ${newDoneCount})` : ''}`);
  lines.push('');
  lines.push('La story declara tests runtime-dependent (Playwright/E2E/smoke) pero no');
  lines.push(`existe archivo de evidencia .advisors/dod-runtime/${prefijoDe(storyId, filePath) || '(sin clave: no se pudo calcular, ver el aviso de arriba) '}*.md en:`);
  for (const r of repoRoots) {
    lines.push(`  - ${path.join(r, '.advisors', 'dod-runtime')}`);
  }
  lines.push('');
  lines.push('Acciones (en orden de preferencia):');
  lines.push('  (a) Invocar tycon-dod-runtime-checker advisor (auto-captura evidencia).');
  lines.push('  (b) Ejecutar E2E specs + capturar log → escribir manualmente el archivo.');
  lines.push('  (c) Si la story NO tiene UI/E2E reales: eximirla de la prueba en vivo lo decide la persona,');
  lines.push('      no el agente (lo firma con marker.js sign-file dod_runtime_exempt <historia>).');
  lines.push('');
  lines.push('Caso disparador: Ceibo Story 4.2 2026-05-20 — Claude marcó done sin');
  lines.push('ejecutar E2E. Este hook es la infra que lo enforce. Docs:');
  lines.push('  ~/.claude/tycon-harness/guides/definition-of-done.md');

  anotarDecision('evidencia-ausente', 'bloqueo', storyId, newS);
  return { block: lines.join('\n') + '\n' };
}

// La prueba con navegador que la persona dejó pendiente (lib/browser-test.js): vale sólo con la marca de la historia y
// la constancia que escribió e2e-setup.js en gates.log. Si vale, se dice y queda anotada.
function deudaDeNavegador(content, filePath, storyId, newS) {
  const bt = require('./lib/browser-test.js');
  const d = require('./lib/browser-test.js').debtDeclared({ stateDir: stateDirOf(os.homedir()), storyPath: filePath, content });
  if (!d.declared) {
    if (d.motivo && !/no declara/.test(d.motivo)) process.stderr.write(`La prueba con navegador pendiente de la historia ${storyId} no vale — ${d.motivo}.\n`);
    return false;
  }
  process.stderr.write(`${bt.debtLine(d)}\n`);
  bt.recordDebtUse(stateDirOf(os.homedir()), d, 'review');
  anotarDecision('prueba-con-navegador-pendiente', 'paso', storyId, newS);
  return true;
}

module.exports = { handle, prefijoDe, findRepoRoots, hasFreshPlaywrightPass, hasDodEvidence, fechaDeCambio, computeFreshnessFloor, tiempoDeEvidencia };

// ── CLI shim (standalone) — preserva exit 2 (block) + fail-open logueado ──
if (require.main === module) {
  try {
    const r = handle(readEvent());
    if (r && r.block) {
      process.stderr.write(r.block);
      process.exit(2);
    }
    process.exit(0);
  } catch (e) {
    // Fail-open (no bloquear edits válidos por un bug del hook) PERO visible:
    // un gate desactivado en silencio es un riesgo.
    const msg = (e && (e.stack || e.message)) || String(e);
    process.stderr.write(`⚠ tycon-dod-runtime (frontmatter): hook error (FAILING OPEN — gate NO aplicado): ${msg}\n`);
    try {
      const logDir = path.join(stateDirOf(os.homedir()));
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, 'hook-errors.log'),
        `[${new Date().toISOString()}] on-frontmatter-write.js FAILED OPEN — DoD gate NO aplicado:\n${msg}\n\n`,
        'utf8',
      );
    } catch { /* stderr ya quedó emitido */ }
    process.exit(0);
  }
}
