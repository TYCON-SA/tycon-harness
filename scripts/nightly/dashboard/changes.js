'use strict';
/*
 * changes.js — QUÉ ARCHIVOS TOCÓ UNA CORRIDA Y QUÉ LES CAMBIÓ
 *
 * Lee el hilo comprimido de la corrida (`<volcado>.hilo.jsonl.gz`, lo guarda el archivador y viaja al
 * buzón) y devuelve, en orden, cada edición y escritura de archivo con su cambio, el paso
 * en que ocurrió y los commits que la corrida hizo. Es lo que la vista de corridas muestra por cada corrida.
 *
 * Tres reglas:
 *  - Una corrida SIN hilo dice «sin hilo», nunca «no tocó nada»: sin la conversación no hay de dónde
 *    saberlo. Y un hilo ilegible dice «ilegible», con el motivo.
 *  - Rutas relativas al repo: sin la carpeta del repo, del clon descartable ni del worktree; lo que no
 *    está en un repo sale sólo con el nombre del archivo (nunca una ruta absoluta con el usuario).
 *  - El cambio pasa por el MISMO saneado que los mensajes de error (credenciales tapadas, rutas
 *    absolutas y correos fuera) y tiene tope de largo por edición, dicho en pantalla. Se importa, no se
 *    copia: dos saneados se separan solos. Sin el saneado, los cambios no se publican.
 *
 * Los commits salen del resultado de `git commit` en el hilo (`[rama abc1234] mensaje`), no del repo:
 * el repo de una corrida de otra máquina no está en ésta.
 */
const fs = require('fs');
const zlib = require('zlib');

// Sin corte para leer: cortar los cambios en unos miles de caracteres, o limitarlos por corrida para que la página
// no pese, dejaría cortada una parte grande de los cambios. Comprimidos y abiertos a pedido, mostrarlos enteros
// pesa poco. Queda sólo un límite de SEGURIDAD por cambio, para un archivo generado gigante: lo pasa uno cada
// muchas corridas, y cuando pasa se dice.
const TOPE_EDICION = 200000;
const TOPE_ESCRITURA = 200000;
const TOPE_EDICIONES_CON_CAMBIO = Infinity;
// Un comando de consola se muestra ENTERO, como una edición: un script de reemplazos trae adentro el antes y
// el después de cada uno, y es lo único que queda de ese cambio. Un tope corto cortaría justo eso.
// Rige el mismo límite de seguridad que el resto.
const TOPE_CONSOLA = 200000;
const MARGEN_CIERRE_MS = 60 * 60000;
const ESPERA_MIN_MS = 2 * 60000;

function rutaDeHilo(volcado) { return String(volcado).replace(/\.json$/, '') + '.hilo.jsonl.gz'; }
// el resumen de la corrida que guarda el sitio cuando borra su conversación y su cambio (dashboard/runs.js → RESUMEN)
function rutaDeResumen(volcado) { return String(volcado).replace(/\.json$/, '') + '.resumen.json.gz'; }

// ─── El cambio según git ────────────────────────────────────────────────────────────
// Lo arma scripts/metrics/run-change.js al archivar: los commits de la corrida y lo que quedó sin
// commitear, en cada repo donde escribió. Es el «qué» exacto y completo; el hilo queda para el «cuándo».
function rutaDeCambio(volcado) { return String(volcado).replace(/\.json$/, '') + '.cambio.json.gz'; }

/** El cambio de git de una corrida tal cual quedó en disco; `sin_cambio` o `ilegible` con motivo si no se puede. */
function leerCambioDeGit(volcado) {
  const r = rutaDeCambio(volcado);
  if (!fs.existsSync(r)) return { estado: 'sin_cambio', motivo: 'esta ejecución no tiene el cambio de git guardado (es de antes de que se guardara, o el archivador no lo pudo armar)' };
  try {
    const x = JSON.parse(zlib.gunzipSync(fs.readFileSync(r)).toString('utf8'));
    if (!x || typeof x !== 'object' || !x.estado) throw new Error('no trae estado');
    return x;
  } catch (e) {
    return { estado: 'ilegible', motivo: `el cambio de git de esta ejecución no se pudo leer (${e.code || e.message})` };
  }
}

/**
 * ¿A qué archivo de git corresponde un nombre que salió de la conversación? Igual, o por el final de la
 * ruta (un `sed` después de un `cd` deja `tests/x.sh` donde git dice `scripts/tests/x.sh`). Devuelve el
 * índice si hay UNO solo, -2 si hay varios (no se adivina) y -1 si ninguno (git no lo confirma).
 */
function emparejar(nombre, ids) {
  const n = String(nombre || '');
  const exacto = ids.indexOf(n);
  if (exacto >= 0) return exacto;
  const cands = [];
  ids.forEach((id, i) => { if (id.endsWith('/' + n) || n.endsWith('/' + id)) cands.push(i); });
  if (cands.length) return cands.length === 1 ? cands[0] : -2;
  // El mismo repo con otro nombre: la conversación lo nombra por su carpeta (`agent-skills/…`) y git por su
  // remoto (`AgentSkills/…`). Se compara el primer tramo sin mayúsculas ni signos, y el resto igual.
  const norma = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const corte = (s) => { const i = s.indexOf('/'); return i > 0 ? [norma(s.slice(0, i)), s.slice(i + 1)] : null; };
  const cn = corte(n);
  if (cn) ids.forEach((id, i) => { const ci = corte(id); if (ci && ci[0] === cn[0] && ci[1] === cn[1]) cands.push(i); });
  return cands.length === 1 ? cands[0] : cands.length ? -2 : -1;
}

/**
 * La ruta relativa al repo. Una story toca
 * también repos HERMANOS (el backend y el frontend en la misma corrida), el arnés, y archivos de
 * trabajo fuera de todo repo (el scratchpad de la sesión, la memoria). En orden:
 *  1. dentro del repo de la corrida → relativa;
 *  2. un clon descartable (…/scratchpad/<clon>/) o un worktree (…/<Repo>--wt-x/, …--merge/) → lo que sigue;
 *  3. un repo hermano (misma carpeta padre que el de la corrida) → «<hermano>/…»;
 *  4. los repos del arnés → «agent-skills/…», «tycon-claude-guides/…» o el nombre público;
 *  5. el mismo nombre de repo en otra carpeta (otra máquina) → lo que sigue;
 *  6. cualquier otra cosa está fuera de un repo → «fuera del repo: <nombre del archivo>», sin carpeta.
 */
function relativa(ruta, repoPath) {
  const p = String(ruta || '');
  const repo = String(repoPath || '').replace(/\/+$/, '');
  if (repo && p.startsWith(repo + '/')) return p.slice(repo.length + 1);
  // Un archivo suelto en el scratchpad de la sesión no es de ningún repo.
  if (/\/scratchpad\/[^/]+$/.test(p)) return `fuera del repo: ${p.split('/').pop()}`;
  let m = p.match(/\/scratchpad\/[^/]+\/(.+)$/);
  if (m) return m[1];
  m = p.match(/\/[^/]+--(?:wt-[^/]+|merge)\/(.+)$/);
  if (m) return m[1];
  const padre = repo.split('/').slice(0, -1).join('/');
  // Sólo si el padre es una carpeta de proyectos de verdad: bajo una carpeta temporal, el «hermano» es otra sesión.
  if (padre && padre.split('/').length > 3 && !/(^|\/)(tmp|claude-\d+)(\/|$)/.test(padre) && p.startsWith(padre + '/')) return p.slice(padre.length + 1);
  // (los dos nombres del arnés, como segmento: reconocedor declarado en harness-place-names.json)
  m = p.match(/\/(agent-skills|tycon-claude-guides|tycon-harness)\/(.+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  const nombre = repo.split('/').pop();
  if (nombre) {
    const i = p.indexOf('/' + nombre + '/');
    if (i >= 0) return p.slice(i + nombre.length + 2);
  }
  return `fuera del repo: ${p.split('/').pop()}`;
}

/**
 * Los archivos que un comando de consola VA A ESCRIBIR, por aproximación (la misma idea que la segunda
 * puerta del portón, `on-bash-write-gate.js`): el destino de `>`/`>>`/`tee`, el archivo de `sed -i` /
 * `perl -i`, y las rutas entre comillas de un script que abre para escribir. Lo que no se reconoce
 * devuelve vacío y el comando sale como «script por consola»: mejor sin nombre que con uno inventado.
 */
// Con los archivos fuente de skills/tycon-pipeline/scripts/lib/code-files.js (Svelte, Vue, Go, Java…).
const EXT_ARCHIVO = /\.(cs|csproj|sln|ts|tsx|js|jsx|mjs|cjs|mts|cts|json|ya?ml|md|sql|sh|ps1|py|go|rb|java|kt|swift|vue|svelte|html?|css|scss|xml|bpmn|toml|txt|config|props|razor|cshtml)$/i;
const ESCRIBE = /open\([^)]*['"][wa]['"]|\.write_text\(|writeFileSync\(|appendFileSync\(|\.write\(/;
function destinosDeConsola(cmd) {
  const c = String(cmd || '');
  const out = new Set();
  const ext = '[\\w./~$-]+\\.[A-Za-z]{1,6}';
  for (const m of c.matchAll(new RegExp(`(?:>>?|\\btee(?:\\s+-a)?)\\s*["']?(${ext})["']?`, 'g'))) out.add(m[1]);
  for (const m of c.matchAll(new RegExp(`\\b(?:sed|perl)\\s+-[a-zA-Z]*i[^\\n|;&]*?\\s["']?(${ext})["']?\\s*(?:$|[\\n|;&])`, 'gm'))) out.add(m[1]);
  if (ESCRIBE.test(c)) {
    // Una ruta entre comillas de un script: con barra, o con extensión de archivo de verdad (`d.type` no lo es).
    for (const m of c.matchAll(new RegExp(`["'](${ext})["']`, 'g'))) if (m[1].includes('/') || EXT_ARCHIVO.test(m[1])) out.add(m[1]);
  }
  return [...out].filter((x) => !/^\/dev\//.test(x)).slice(0, 8);
}

/** Tramos [desde, hasta] en ms, ordenados y sin superponerse. */
function unirTramos(tramos) {
  const out = [];
  for (const [a, b] of [...tramos].sort((x, y) => x[0] - y[0])) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

function lineasDe(x) { return x ? String(x).split('\n').length : 0; }

/**
 * Los renglones de un buffer, de a uno: sin armar el texto entero ni la lista de renglones. Una conversación de 110 MB
 * comprimidos son 224 MB de texto; como string y partida en renglones ocupaba más de 1 GB a la vez, y el contenedor del
 * sitio (1 GiB) moría al resumirla.
 */
function* renglonesDe(buf) {
  let i = 0;
  while (i < buf.length) {
    let j = buf.indexOf(10, i);
    if (j < 0) j = buf.length;
    yield buf.toString('utf8', i, j);
    i = j + 1;
  }
}

function cortar(x, tope) {
  const s = String(x || '');
  return s.length <= tope ? { txt: s, cortado: 0 } : { txt: s.slice(0, tope), cortado: s.length - tope };
}

/**
 * @param {string} volcado ruta del volcado .json de la corrida
 * @param {object} marker el marker del volcado (startedAt, repoPath, stepTimings)
 * @param {object} deps { sanear, cortesDePaso }
 * El paso sale como su número (`5`, `5+6` si las marcas se fusionaron, `después` si fue tras el último):
 * el nombre lo pone la página.
 */
function cambiosDeCorrida(volcado, marker, deps = {}) {
  const hiloRuta = rutaDeHilo(volcado);
  if (!fs.existsSync(hiloRuta)) return { estado: 'sin_hilo', motivo: 'esta ejecución no tiene su conversación guardada (es de antes de que se guardara, o la conversación ya se había borrado): no se sabe qué archivos tocó' };
  if (!deps.sanear) return { estado: 'no_publicado', motivo: 'el saneado (scripts/metrics/tokens-digest.js) no está en esta máquina: los cambios no se publican sin sanear' };
  let crudo;
  try { crudo = zlib.gunzipSync(fs.readFileSync(hiloRuta)); }
  catch (e) { return { estado: 'ilegible', motivo: `la conversación no se pudo leer (${e.code || e.message})` }; }

  const m = marker || {};
  const ini = Date.parse(m.startedAt || '');
  // 🔴 La conversación SIGUE después de la corrida (otra story, un diagnóstico): el hilo puede llegar días más allá
  //    y traer los archivos de otro trabajo. Lo posterior al cierre (último toque
  //    + 1 h, para el commit y el merge) se cuenta aparte y no se muestra, igual que lo anterior al inicio.
  const finRaw = Date.parse(m.lastTouch || '');
  const fin = Number.isFinite(finRaw) ? finRaw + MARGEN_CIERRE_MS : Infinity;
  let posteriores = 0;
  const cortes = deps.cortesDePaso ? deps.cortesDePaso(m.stepTimings || {}) : [];
  const pasoDe = (t) => {
    if (!Number.isFinite(t)) return null;
    const c = cortes.find((x) => t <= x.hasta);
    if (!c) return cortes.length ? 'después' : null;
    return String(c.paso);
  };

  const ediciones = [];
  const commits = [];
  // El consumo minuto a minuto y qué se estaba haciendo (sólo NOMBRES de herramienta y tipos de agente,
  // nunca el comando ni el prompt). Tokens NUEVOS, como el reparto por paso, y una vez por
  // respuesta: Claude Code parte una respuesta en varias líneas con el mismo `usage` (contarlo en cada una lo inflaría).
  const serie = {};
  const que = {};
  const respuestas = new Set();
  // El título de la story, leído del frontmatter cuando la corrida lo tuvo a la vista.
  const idStory = String(m.storyId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reTitulo = idStory ? new RegExp(`story:\\s*["']?${idStory}["']?\\s*\\n(?:[^\\n]*\\n){0,8}?\\s*\\d*\\s*title:\\s*["']?([^\\n]+?)["']?\\s*\\n`) : null;
  let titulo = null;
  // 🔴 La espera por una persona, leída del hilo. La cuenta por pasos sólo sabe qué pasos
  //    esperan; una pregunta al dev en medio de un paso que se responde horas después contaría como TRABAJO esas
  //    horas. Dos formas de esperar: una pregunta con opciones
  //    (del uso de AskUserQuestion a su resultado) y un turno que termina (del último evento al mensaje del dev,
  //    si pasaron 2 minutos o más). Sólo horas: ni la pregunta ni la respuesta.
  const esperas = [];
  const preguntas = new Map();
  let ultimo = null;
  let previas = 0;
  let porConsola = 0;
  let ilegibles = 0;
  for (const linea of renglonesDe(crudo)) {
    if (!linea) continue;
    const esUso = linea.includes('"tool_use"');
    const esResultado = linea.includes('"tool_result"');
    const conConsumo = linea.includes('"usage"');
    const esHumano = /"kind":\s*"human"/.test(linea);
    if (!esUso && !esResultado && !conConsumo && !esHumano) {
      const mt = linea.match(/"timestamp":\s*"([^"]+)"/);
      if (mt) { const tt = Date.parse(mt[1]); if (Number.isFinite(tt)) ultimo = tt; }
      continue;
    }
    let o; try { o = JSON.parse(linea); } catch (e) { ilegibles += 1; continue; }
    const msg = o.message || {};
    const cont = Array.isArray(msg.content) ? msg.content : [];
    const t = Date.parse(o.timestamp || '');
    if (Number.isFinite(t)) {
      if (o.type === 'user' && o.origin && o.origin.kind === 'human' && ultimo !== null && t - ultimo >= ESPERA_MIN_MS) esperas.push([ultimo, t]);
      for (const b of cont) {
        if (b && b.type === 'tool_use' && b.name === 'AskUserQuestion') preguntas.set(b.id, t);
        if (b && b.type === 'tool_result' && preguntas.has(b.tool_use_id)) { esperas.push([preguntas.get(b.tool_use_id), t]); preguntas.delete(b.tool_use_id); }
      }
      ultimo = t;
    }
    if (reTitulo && !titulo && esResultado) {
      for (const b of cont) {
        if (!b || b.type !== 'tool_result') continue;
        const txt = Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('\n') : String(b.content || '');
        const mt = txt.match(reTitulo);
        if (mt) { titulo = deps.sanear(mt[1]).slice(0, 240); break; }
      }
    }
    if (Number.isFinite(t) && Number.isFinite(ini) && t >= ini && t <= fin) {
      const minuto = Math.round((t - ini) / 60000);
      const u = msg.usage;
      if (u && msg.model !== '<synthetic>' && !(msg.id && respuestas.has(msg.id))) {
        if (msg.id) respuestas.add(msg.id);
        const q = que[minuto] || (que[minuto] = { h: {}, ag: {}, out: 0, cache: 0 });
        q.out += u.output_tokens || 0; q.cache += u.cache_creation_input_tokens || 0;
        serie[minuto] = (serie[minuto] || 0) + (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
      }
      for (const b of cont) {
        if (!b || b.type !== 'tool_use') continue;
        const q = que[minuto] || (que[minuto] = { h: {}, ag: {}, out: 0, cache: 0 });
        const nombre = String(b.name || '').replace(/^mcp__[a-z_]+__/, '').slice(0, 40);
        q.h[nombre] = (q.h[nombre] || 0) + 1;
        if (b.name === 'Agent' && b.input && b.input.subagent_type) { const a = String(b.input.subagent_type).slice(0, 60); q.ag[a] = (q.ag[a] || 0) + 1; }
      }
    }
    // Lo anterior al inicio es de otro trabajo de la misma sesión: se cuenta aparte, no se muestra.
    if (Number.isFinite(t) && Number.isFinite(ini) && t < ini) {
      if (cont.some((b) => b && b.type === 'tool_use' && (b.name === 'Edit' || b.name === 'Write'))) previas += 1;
      continue;
    }
    if (Number.isFinite(t) && t > fin) {
      if (cont.some((b) => b && b.type === 'tool_use' && (b.name === 'Edit' || b.name === 'Write'))) posteriores += 1;
      continue;
    }
    const min = (Number.isFinite(t) && Number.isFinite(ini)) ? Math.round((t - ini) / 60000) : null;
    for (const b of cont) {
      if (!b) continue;
      // 🔴 Una corrida puede cambiar archivos SIN las herramientas de edición: desde la consola (un heredoc,
      //    `sed -i`, un script). Hay corridas con hilo sin una sola edición que
      //    igual commitearon archivos. De eso el hilo
      //    guarda el comando, no un antes y después: se CUENTA, para no decir «no tocó nada».
      const esConsola = b.type === 'tool_use' && b.name === 'Bash' && /<<-?\s*['"]?\w|\bsed\s+-i|\btee\b|\.write\(|\bgit apply\b|\bpatch\b|>\s*[\w./~"$-]+\.\w{1,5}\b/.test(String((b.input || {}).command || ''));
      if (esConsola) {
        // El comando ES el cambio que queda de una escritura por consola: se muestra, saneado. Los que sólo
        // escriben fuera de todo repo (el timer, un temporal del scratchpad) no son cambios de código: no entran.
        const cmd = String(b.input.command);
        const base = (cmd.match(/^\s*cd\s+["']?([^\s"';&]+)/) || [])[1] || '';
        // Una ruta relativa sin `cd` adelante es relativa al repo (el comando arranca ahí); con `cd`, a esa carpeta.
        const dest = destinosDeConsola(cmd).map((d) => {
          if (/^[/~$]/.test(d)) return relativa(d, m.repoPath);
          return base ? relativa(`${base.replace(/\/+$/, '')}/${d}`, m.repoPath) : d.replace(/^\.\//, '');
        // `../x.log`, `$T/o.html`, un `.log`/`.png`/`.tmp`: salidas de trabajo, no cambios de código.
        }).map((d) => ((/^[/~$]/.test(d) || /(^|\/)\.\.\/|\$/.test(d) || /\.(log|png|jpe?g|tmp|bak|out|gz|zip|pid)$/i.test(d)) ? `fuera del repo: ${d.split('/').pop()}` : d));
        const enRepo = dest.filter((d) => !d.startsWith('fuera del repo'));
        // Sin destino reconocido sólo cuenta si el script ABRE PARA ESCRIBIR: un heredoc que sólo analiza no es un cambio.
        if ((!dest.length && ESCRIBE.test(cmd)) || enRepo.length) {
          porConsola += 1;
          // Un comando que escribe varios archivos: el texto va UNA vez (en el primero); los demás lo citan.
          const primero = ediciones.length;
          (enRepo.length ? enRepo : ['script por consola (archivo no identificado)']).forEach((f, j) => {
            ediciones.push({ t: min, paso: pasoDe(t), f, w: 0, k: 1, mas: 0, menos: 0, _nuevo: j ? '' : cmd, _viejo: '', ref: j ? primero : undefined });
          });
        }
      }
      if (b.type === 'tool_use' && (b.name === 'Edit' || b.name === 'Write')) {
        const i = b.input || {};
        if (!i.file_path) continue;
        const esEscritura = b.name === 'Write';
        const nuevo = esEscritura ? i.content : i.new_string;
        const viejo = esEscritura ? '' : i.old_string;
        ediciones.push({ t: min, paso: pasoDe(t), f: relativa(i.file_path, m.repoPath), w: esEscritura ? 1 : 0,
          mas: lineasDe(nuevo), menos: lineasDe(viejo), _nuevo: nuevo, _viejo: viejo });
      } else if (b.type === 'tool_result') {
        const txt = Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('\n') : String(b.content || '');
        // `[rama abc1234] asunto` y, en la línea siguiente, ` N files changed`: cuántos archivos llevó el commit.
        for (const r of txt.matchAll(/^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)(?:\n\s*(\d+) files? changed)?/gm)) {
          commits.push({ t: min, paso: pasoDe(t), rama: deps.sanear(r[1]), h: r[2], s: deps.sanear(r[3]).slice(0, 300), archivos: r[4] ? Number(r[4]) : null });
        }
      }
    }
  }

  // El cambio completo, saneado y con tope, sólo para las primeras ediciones; el resto, con sus números.
  let conCambio = 0;
  for (const e of ediciones) {
    if (conCambio < TOPE_EDICIONES_CON_CAMBIO) {
      const N = cortar(deps.sanear(e._nuevo), e.k ? TOPE_CONSOLA : e.w ? TOPE_ESCRITURA : TOPE_EDICION);
      const V = cortar(deps.sanear(e._viejo), TOPE_EDICION);
      Object.assign(e, { nuevo: N.txt, nuevo_cortado: N.cortado, viejo: V.txt, viejo_cortado: V.cortado });
      conCambio += 1;
    }
    delete e._nuevo; delete e._viejo;
  }
  return {
    estado: 'leido', motivo: null, ediciones, commits, titulo, por_consola: porConsola,
    esperas: unirTramos(esperas.map(([a, b]) => [Math.max(a, Number.isFinite(ini) ? ini : a), Math.min(b, Number.isFinite(finRaw) ? finRaw : b)]).filter(([a, b]) => b > a)),
    consumo: { serie, que },
    anteriores_al_inicio: previas, posteriores_al_cierre: posteriores, lineas_ilegibles: ilegibles,
    sin_cambio_por_tope: Number.isFinite(TOPE_EDICIONES_CON_CAMBIO) ? Math.max(0, ediciones.length - TOPE_EDICIONES_CON_CAMBIO) : 0,
    topes: { edicion: TOPE_EDICION, escritura: TOPE_ESCRITURA },
  };
}

module.exports = { unirTramos, cambiosDeCorrida, renglonesDe, relativa, destinosDeConsola, rutaDeHilo, rutaDeCambio, rutaDeResumen, leerCambioDeGit, emparejar, TOPE_EDICION, TOPE_ESCRITURA, TOPE_EDICIONES_CON_CAMBIO };
