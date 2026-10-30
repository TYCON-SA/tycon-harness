#!/usr/bin/env node
/**
 * manifest-engram.js — el criterio único: ¿el índice de memoria declara todos sus archivos?
 *
 * La memoria del equipo viaja por git en dos piezas: los chunks (`.engram/chunks/<id>.jsonl.gz`,
 * los datos) y el índice (`.engram/manifest.json`, la lista de cuáles existen). `engram sync
 * --import` lee EL ÍNDICE, no la carpeta: **un chunk sin entrada no existe para las demás
 * máquinas, y no da error** — el síntoma es un tranquilizador «no new chunks». Un commit puede dejar
 * 205 entradas para 210 archivos sin que nada lo objete; la entrada perdida no vuelve sola (ni `sync`, ni `--import`, ni tener el chunk en disco la recuperan).
 *
 * Tres controles preguntan lo mismo en momentos distintos —el hook del commit, el aviso diario
 * (vía harness-audit.js) y el portón de CI— así que el criterio se escribe UNA vez, acá. Si se
 * escribiera tres veces, el día que cambie habría que acordarse de cambiarlo en tres lados, y el
 * que quede viejo miente en silencio. Es la misma regla que ya está escrita en la cabecera de
 * `engram-drift-notice.js`: reusar los chequeos, no reimplementarlos.
 *
 * Qué NO hace, a propósito:
 *   · no repara dentro del commit — reparar cambia lo que se commitea sin que se vea, que es el
 *     mismo silencio que esto combate. El bloqueo NOMBRA el comando; lo corre una persona.
 *   · no borra nunca una entrada (fantasmas y duplicados se listan: borrar es otra decisión).
 *   · no inventa una entrada desde nada: si el chunk no se puede leer y la historia no la tiene,
 *     queda en `noReparadas` con su motivo.
 *   · no sabe de `~/.claude/`, ni de `harness-audit.js`, ni de `repos-root.js` — recibe un
 *     directorio y nada más, para que el portón lo pueda cargar en un agente de CI.
 *
 * Uso:
 *   node scripts/lib/manifest-engram.js cross   [--repo <dir>] [--against <ref>] [--staged] [--json]
 *   node scripts/lib/manifest-engram.js repair  [--repo <dir>] [--apply] [--json]
 *   node scripts/lib/manifest-engram.js rebuild [--repo <dir>] [--json]   (sólo en «índice local», ver `rehacer`)
 * Códigos de salida: 0 sano · 1 deriva (o algo que reparar, o que quedó afuera) · 3 no se pudo medir (o no aplica).
 * 🔴 Nunca sale 2: ése es el código con el que los hooks BLOQUEAN, y confundirlos haría que un
 * «no pude medir» del criterio se leyera como un bloqueo del hook.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const SUFIJO = '.jsonl.gz';
const REL_INDICE = '.engram/manifest.json';
const REL_CHUNKS = '.engram/chunks';
// Los mismos tres marcadores que ya valida el hook (ENGRAM-MANIFEST-1). Un índice con marcadores
// SÍ parsea a veces (si un lado quedó entero), así que se busca antes de intentar el JSON.
const MARCADORES = /^(<{7} |={7}$|>{7} )/m;

// ── git, sin shell y sin explotar ───────────────────────────────────────────────────────────────
function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitOk(dir, args) {
  try { return { ok: true, out: git(dir, args) }; }
  catch (e) {
    const err = String((e && e.stderr) || (e && e.message) || e).trim().split('\n')[0];
    return { ok: false, motivo: err || 'git falló' };
  }
}

// ── Parseo del índice — cada borde tiene su código y su motivo en castellano ─────────────────────
// 🔴 Devolver listas VACÍAS cuando no se pudo medir sería el peor error posible de esta pieza: cero
// huérfanos se lee igual que «está todo bien». Por eso un borde devuelve `{error}` y el que llama
// pone las listas en `null`, que ningún consumidor puede confundir con «miré y no hay nada».
function parsearIndice(texto) {
  if (MARCADORES.test(texto)) {
    return { error: { codigo: 'marcadores', motivo: 'el índice tiene marcadores de conflicto de git adentro (ver guides/integrations/engram-workflow.md §manifest)' } };
  }
  let m;
  try { m = JSON.parse(texto); }
  catch (e) { return { error: { codigo: 'no-parsea', motivo: `el índice no parsea como JSON: ${String(e.message).split('\n')[0]}` } }; }
  if (!m || typeof m !== 'object' || !Array.isArray(m.chunks)) {
    return { error: { codigo: 'sin-lista', motivo: 'el índice no tiene una lista `chunks` — no es el formato que escribe engram' } };
  }
  for (const c of m.chunks) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id) {
      return { error: { codigo: 'ids-invalidos', motivo: 'el índice tiene entradas sin `id` de texto — no se puede cruzar a medias' } };
    }
  }
  return { manifest: m, ids: m.chunks.map((c) => c.id) };
}

function leerIndiceDeDisco(dir) {
  const f = path.join(dir, REL_INDICE);
  if (!fs.existsSync(f)) return { error: { codigo: 'sin-manifest', motivo: `no hay ${REL_INDICE} en ${dir}` } };
  let texto;
  try { texto = fs.readFileSync(f, 'utf8'); }
  catch (e) { return { error: { codigo: 'ilegible', motivo: `no se pudo leer ${REL_INDICE}: ${e.message}` } }; }
  return parsearIndice(texto);
}

function leerChunksDeDisco(dir) {
  const d = path.join(dir, REL_CHUNKS);
  if (!fs.existsSync(d)) return { error: { codigo: 'sin-carpeta-chunks', motivo: `no hay ${REL_CHUNKS}/ en ${dir}` } };
  try {
    return { ids: fs.readdirSync(d).filter((f) => f.endsWith(SUFIJO)).map((f) => f.slice(0, -SUFIJO.length)) };
  } catch (e) { return { error: { codigo: 'chunks-ilegibles', motivo: `no se pudo leer ${REL_CHUNKS}/: ${e.message}` } }; }
}

// El portón de CI no mira el disco: mira un ÁRBOL de git (el commit del pull request, o el índice
// de git con `--staged`, que es `ref` vacío). Mismo criterio, otra fuente.
function leerIndiceDeArbol(dir, ref) {
  const r = gitOk(dir, ['show', `${ref}:${REL_INDICE}`]);
  if (!r.ok) return { error: { codigo: 'sin-manifest', motivo: `no se pudo leer ${REL_INDICE} en \`${ref || 'el índice de git'}\`: ${r.motivo}` } };
  return parsearIndice(r.out);
}
function leerChunksDeArbol(dir, ref) {
  // 🔴 `:/` ancla el pathspec a la RAÍZ del repo, igual que el `git show <ref>:<path>` con el que se lee el
  // índice. Sin eso, el pathspec es relativo al CWD: si `dir` es un subdirectorio, la lista sale vacía y TODAS las
  // entradas se reportan como fantasma.
  const r = gitOk(dir, ['ls-tree', '-r', '--name-only', ref || 'HEAD', '--', ':/' + REL_CHUNKS]);
  if (!r.ok) return { error: { codigo: 'chunks-ilegibles', motivo: `no se pudo listar ${REL_CHUNKS}/ en \`${ref || 'HEAD'}\`: ${r.motivo}` } };
  return {
    ids: r.out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith(SUFIJO))
      .map((s) => path.basename(s).slice(0, -SUFIJO.length)),
  };
}
// Con `--staged` «lo nuevo» es el índice de git: los archivos salen de ahí, no del árbol de trabajo.
function leerChunksDelIndiceDeGit(dir) {
  const r = gitOk(dir, ['ls-files', '--cached', '--', ':/' + REL_CHUNKS]);
  if (!r.ok) return { error: { codigo: 'chunks-ilegibles', motivo: `no se pudo listar ${REL_CHUNKS}/ en el índice de git: ${r.motivo}` } };
  return {
    ids: r.out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith(SUFIJO))
      .map((s) => path.basename(s).slice(0, -SUFIJO.length)),
  };
}

/**
 * cruzar(dir, {contra, arbol}) — el criterio.
 *
 *   contra: referencia de git contra la que se clasifica nuevo-vs-heredado (default 'HEAD';
 *           `null` para no comparar con nada).
 *   arbol:  de dónde sale «lo nuevo». `undefined` = el disco (el hook y el aviso diario);
 *           una ref = ese árbol de git; `''` = el índice de git (el portón con --staged).
 *
 * Devuelve SIEMPRE la misma forma. Con `estado: 'no-medido'`, las listas que no se pudieron
 * computar vienen en `null` (nunca vacías) y `motivo` dice por qué, en castellano.
 */
function cruzar(dir, opciones) {
  const o = opciones || {};
  const contra = o.contra === undefined ? 'HEAD' : o.contra;
  const deArbol = o.arbol !== undefined;
  const base = {
    repo: dir,
    estado: 'no-medido',
    codigo: null,
    motivo: null,
    regla: 'no-pude-medir',
    archivos: null,
    archivosIds: null,
    declarados: null,
    declaradosIds: null,
    huerfanos: null,
    fantasmas: null,
    duplicados: null,
    perdidas: null,
    chunksSinEntrada: null,
    huerfanosNuevos: null,
    huerfanosHeredados: null,
    razones: {},
    contra: { ref: contra, legible: false, motivo: 'no se comparó contra ninguna referencia' },
  };

  const ind = deArbol ? leerIndiceDeArbol(dir, o.arbol) : leerIndiceDeDisco(dir);
  const dis = deArbol
    ? (o.arbol === '' ? leerChunksDelIndiceDeGit(dir) : leerChunksDeArbol(dir, o.arbol))
    : leerChunksDeDisco(dir);

  // Lo que SÍ se pudo contar se informa aunque el otro lado haya fallado: «2 archivos y no pude
  // leer el índice» es más útil que dos `null`. `declaradosIds` / `archivosIds` son DATO, no
  // criterio: el consumidor que necesite nombrar lo que había (el aviso diario, con un índice que
  // apunta a una carpeta que no existe) no tiene que releer el archivo por su cuenta.
  if (dis.ids) { base.archivos = dis.ids.length; base.archivosIds = [...dis.ids].sort(); }
  if (ind.ids) { base.declarados = ind.ids.length; base.declaradosIds = [...ind.ids].sort(); }
  const fallo = ind.error || dis.error;
  if (fallo) return { ...base, codigo: fallo.codigo, motivo: fallo.motivo };

  const enIndice = new Set(ind.ids);
  const enDisco = new Set(dis.ids);
  const huerfanos = dis.ids.filter((id) => !enIndice.has(id)).sort();
  const fantasmas = ind.ids.filter((id) => !enDisco.has(id)).sort();
  const vistos = new Set();
  const duplicados = [...new Set(ind.ids.filter((id) => (vistos.has(id) ? true : (vistos.add(id), false))))].sort();

  // La referencia: si no se puede leer, TODO huérfano se clasifica heredado. Nunca se frena por lo
  // que no se pudo comparar — es la diferencia entre «este commit rompe algo» y «no sé».
  let ref = { ref: contra, legible: false, motivo: 'no se comparó contra ninguna referencia' };
  let idxRef = null;
  let discoRef = null;
  if (contra !== null && contra !== undefined) {
    const iRef = leerIndiceDeArbol(dir, contra);
    const dRef = leerChunksDeArbol(dir, contra);
    if (iRef.error || dRef.error) {
      ref = { ref: contra, legible: false, motivo: (iRef.error || dRef.error).motivo };
    } else {
      ref = { ref: contra, legible: true, motivo: null };
      idxRef = new Set(iRef.ids);
      discoRef = new Set(dRef.ids);
    }
  }

  const razones = {};
  let perdidas = [];
  let chunksSinEntrada = [];
  if (ref.legible) {
    for (const id of huerfanos) {
      if (idxRef.has(id)) { perdidas.push(id); razones[id] = 'entradas-perdidas'; }
      else if (!discoRef.has(id)) { chunksSinEntrada.push(id); razones[id] = 'chunk-sin-entrada'; }
      else razones[id] = 'deriva-heredada';
    }
  } else {
    for (const id of huerfanos) razones[id] = 'deriva-heredada';
  }
  const nuevos = [...new Set([...perdidas, ...chunksSinEntrada])].sort();
  const heredados = huerfanos.filter((id) => !nuevos.includes(id));

  const sano = !huerfanos.length && !fantasmas.length && !duplicados.length;
  // La regla que el hook escribe en su constancia. Se decide acá (no en bash) para que el
  // vocabulario viva en un solo lado, junto al criterio que lo produce.
  const regla = perdidas.length ? 'entradas-perdidas'
    : chunksSinEntrada.length ? 'chunk-sin-entrada'
      : sano ? 'sano' : 'deriva-heredada';

  return {
    ...base,
    estado: sano ? 'sano' : 'deriva',
    codigo: null,
    motivo: null,
    regla,
    huerfanos,
    fantasmas,
    duplicados,
    perdidas,
    chunksSinEntrada,
    huerfanosNuevos: nuevos,
    huerfanosHeredados: heredados,
    razones,
    contra: ref,
  };
}

/**
 * serializar(manifest) — EXACTAMENTE como lo escribe engram 1.20.0: JSON con indentación de 2 y
 * **sin salto de línea final** (el archivo termina en `]\n}`).
 *
 * 🔴 El salto final importa: si se escribiera uno, cada sync posterior lo sacaría y el archivo aparecería
 * modificado en cada commit sin que nadie lo tocara. Sobre un índice real (227 entradas, 40.677 bytes) la ida y
 * vuelta es idéntica byte a byte. Si engram algún día cambia el formato, el caso T12 de la suite es
 * el que avisa.
 */
function serializar(manifest) {
  return JSON.stringify(manifest, null, 2);
}

// Cuenta lo que trae un chunk, por línea, igual que `contarChunk` de engram-rescue-unexported.js.
function contarChunk(f) {
  try {
    let obs = 0, ses = 0, prompts = 0;
    for (const linea of zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n')) {
      if (!linea.trim()) continue;
      const d = JSON.parse(linea);
      obs += (d.observations || []).length;
      ses += (d.sessions || []).length;
      prompts += (d.prompts || []).length;
    }
    return { obs, ses, prompts };
  } catch { return null; }
}

// La fecha que engram escribe adentro de un registro («AAAA-MM-DD hh:mm:ss», en UTC y sin zona) como ISO, o null si
// no se puede leer. Sin zona se lee como UTC: `new Date` la tomaría en la hora local de la máquina.
function fechaDeAdentro(v) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(String(v || '').trim());
  if (!m) return null;
  return fechaUtc(`${m[1]}T${m[2]}${m[3] || ''}${m[4] || 'Z'}`);
}

// Lee un chunk una vez: lo que cuenta `contarChunk` y la fecha más nueva de sus registros, que es el orden en que
// engram los exportó. Las observaciones y los prompts traen `updated_at`/`created_at`; las sesiones, `started_at` y
// `ended_at` (en el privado hay chunks de sólo sesiones). `fecha: null` si ningún registro trae una legible.
function leerChunk(f) {
  try {
    let obs = 0, ses = 0, prompts = 0, fecha = null;
    for (const linea of zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n')) {
      if (!linea.trim()) continue;
      const d = JSON.parse(linea);
      obs += (d.observations || []).length;
      ses += (d.sessions || []).length;
      prompts += (d.prompts || []).length;
      for (const k of ['observations', 'sessions', 'prompts']) {
        for (const x of (Array.isArray(d[k]) ? d[k] : [])) {
          for (const campo of ['updated_at', 'created_at', 'ended_at', 'started_at']) {
            const iso = x && fechaDeAdentro(x[campo]);
            if (iso && (!fecha || iso > fecha)) fecha = iso;
          }
        }
      }
    }
    return { obs, ses, prompts, fecha };
  } catch { return null; }
}

// Las entradas de engram tienen sus claves en este orden. Se respeta al reconstruir para que el
// diff de una reparación no sea un baile de líneas.
function entradaEngram({ id, created_by, created_at, sessions, memories, prompts }) {
  return { id, created_by, created_at, sessions, memories, prompts };
}

function fechaUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * rescatarDeLaHistoria(dir, ids) — busca la entrada EXACTA que engram escribió alguna vez.
 *
 * Recorre todos los commits que tocaron el índice, en TODAS las referencias (`--all`: el otro
 * lado de un merge y las ramas sin mergear también cuentan — de ahí salieron las 6 entradas de
 * FRESNOProyecto), de la más nueva a la más vieja, y se queda con la primera que declare cada id.
 * Nunca inventa: si nadie la tuvo, el id no aparece en el resultado.
 *
 * Costo: un `git show` por versión del índice, cortando apenas no quedan pendientes. Medido con
 * 197 versiones: **3,8 s en el peor caso** — un id que nadie tuvo nunca, que
 * obliga a recorrerlas todas. Lo paga sólo la REPARACIÓN, que corre una persona y una vez; el cruce
 * del commit no entra acá y cuesta ~70 ms.
 */
function rescatarDeLaHistoria(dir, ids) {
  const pendientes = new Set(ids);
  const encontradas = new Map();
  if (!pendientes.size) return encontradas;
  // 🔴 `--full-history`: sin él, git SIMPLIFICA la historia y en un merge TREESAME a un padre para ESTE path poda
  // el otro lado entero — que es exactamente donde vive la entrada perdida. La maniobra que la propia guía prescribe
  // para un conflicto del índice (`git checkout --theirs`) produce ese merge. Sin la bandera, `reparar` reconstruye
  // desde el chunk (autor y fecha equivocados) una entrada que git tiene entera; y con el chunk ilegible la declara
  // irreparable.
  const log = gitOk(dir, ['log', '--all', '--full-history', '--format=%H', '--', REL_INDICE]);
  if (!log.ok) return encontradas;
  for (const sha of log.out.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (!pendientes.size) break;
    const r = gitOk(dir, ['show', `${sha}:${REL_INDICE}`]);
    if (!r.ok) continue;
    const p = parsearIndice(r.out);
    if (p.error) continue;
    for (const c of p.manifest.chunks) {
      if (!pendientes.has(c.id)) continue;
      encontradas.set(c.id, { entrada: entradaEngram(c), origen: `git:${sha}` });
      pendientes.delete(c.id);
    }
  }
  return encontradas;
}

// Reconstruye desde el propio chunk y el commit que lo trajo. Es el método de
// `engram-rescue-unexported.js`: los contadores salen del archivo, el autor y la fecha del commit.
function reconstruirDelChunk(dir, id) {
  const f = path.join(dir, REL_CHUNKS, id + SUFIJO);
  const c = contarChunk(f);
  if (!c) return { error: 'el chunk no se puede leer (¿no es gzip, o está truncado?) — no se inventa una entrada' };
  let autor = '', fecha = '';
  const r = gitOk(dir, ['log', '--format=%an|%aI', '-1', '--', path.join(REL_CHUNKS, id + SUFIJO)]);
  if (r.ok && r.out.trim()) {
    // 🔴 Por el ÚLTIMO separador, no el primero: un autor con `|` en el nombre truncaría el autor y dejaría la
    // fecha ilegible → created_at de 1970. La fecha ISO
    // nunca trae `|`, así que el último separador siempre es el que divide.
    const linea = r.out.trim().split('\n')[0];
    const i = linea.lastIndexOf('|');
    autor = linea.slice(0, i);
    fecha = linea.slice(i + 1);
  }
  if (!autor) {
    const cfg = gitOk(dir, ['config', 'user.name']);
    autor = (cfg.ok && cfg.out.trim()) || 'desconocido';
  }
  if (!fecha) {
    try { fecha = new Date(fs.statSync(f).mtime).toISOString(); } catch { fecha = new Date(0).toISOString(); }
  }
  return {
    entrada: entradaEngram({
      id, created_by: autor, created_at: fechaUtc(fecha) || new Date(0).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      sessions: c.ses, memories: c.obs, prompts: c.prompts,
    }),
    origen: 'chunk',
  };
}

// Inserta cada entrada nueva en su lugar por `created_at` SIN mover las que ya están. Si el índice
// venía desordenado (el real tiene 2 inversiones), se queda como está: reordenarlo entero haría que
// el diff de una reparación toque líneas que nadie pidió tocar.
function insertarPorFecha(chunks, entrada) {
  const f = String(entrada.created_at || '');
  let i = chunks.length;
  for (let k = 0; k < chunks.length; k++) {
    if (String(chunks[k].created_at || '') > f) { i = k; break; }
  }
  chunks.splice(i, 0, entrada);
}

/**
 * reparar(dir, {apply}) — rescata las entradas que faltan y, con `apply`, las escribe y las stagea.
 *
 * Primero busca la entrada exacta en la historia; sólo si nadie la tuvo la reconstruye desde el
 * chunk. Nunca borra (fantasmas y duplicados se listan para que decida una persona) y nunca
 * inventa. Con `apply` verifica después: vuelve a cruzar, y si `engram` está en el PATH además
 * importa sobre una copia aislada (`ENGRAM_DATA_DIR` a un directorio temporal, para no tocar la
 * base del dev) y compara cuántos chunks vio contra los archivos que hay.
 */
function reparar(dir, opciones) {
  const o = opciones || {};
  const apply = !!o.apply;
  const cruce = cruzar(dir, { contra: o.contra === undefined ? 'HEAD' : o.contra });
  // 🔴 `null`, NO listas vacías. Devolver `reparadas: []` cuando no se pudo medir es indistinguible de
  // «miré y no había nada que reparar» — y así `reindexar()` imprimiría «✅ Todo chunk está en el
  // índice» y saldría 0 sobre un índice que nunca pudo leer. Es EXACTAMENTE el daño que este criterio
  // combate, adentro de la herramienta que recomienda para repararlo. Con `null`, el
  // consumidor que no mire `estado` se rompe ruidosamente en vez de mentir en silencio.
  if (cruce.estado === 'no-medido') return { ...cruce, aplicado: false, reparadas: null, noReparadas: null };

  const faltantes = cruce.huerfanos;
  // 🔴 Sin huérfanos NO quiere decir «sano»: puede haber fantasmas o duplicados, que esta función no repara a
  // propósito (borrar es otra decisión) pero SÍ tiene que listar. Cortar acá con «no hay nada que reparar» y exit 0
  // daría por bueno un índice que el cruce acaba de declarar en deriva — y es el comando que el hook y el aviso
  // diario recomiendan.
  if (!faltantes.length) {
    return { ...cruce, aplicado: false, reparadas: [], noReparadas: [], verificado: null };
  }

  const deGit = rescatarDeLaHistoria(dir, faltantes);
  const reparadas = [];
  const noReparadas = [];
  for (const id of faltantes) {
    if (deGit.has(id)) { reparadas.push({ id, ...deGit.get(id) }); continue; }
    const r = reconstruirDelChunk(dir, id);
    if (r.error) noReparadas.push({ id, motivo: r.error });
    else reparadas.push({ id, ...r });
  }

  if (!apply) {
    return { ...cruce, aplicado: false, reparadas, noReparadas, verificado: null };
  }

  const avisos = [];
  const fIndice = path.join(dir, REL_INDICE);
  const leido = leerIndiceDeDisco(dir);
  if (leido.error) {
    return { ...cruce, aplicado: false, reparadas, noReparadas, estado: 'no-medido', ...leido.error };
  }
  const manifest = leido.manifest;
  // 🔴 Si no hay nada que agregar (todo lo huérfano quedó en `noReparadas`), NO se toca el archivo.
  // Reescribirlo «por las dudas» es un cambio que nadie pidió, y decir «índice escrito» cuando no
  // se escribió nada es la clase de mensaje que hace desconfiar de todo el resto.
  if (reparadas.length) {
    for (const r of reparadas) insertarPorFecha(manifest.chunks, r.entrada);
    fs.writeFileSync(fIndice, serializar(manifest));
    // 🔴 Se stagea el índice Y cada chunk que acaba de declarar.
    // En el caso `chunk-sin-entrada` el archivo todavía no está en git: stagear sólo el índice
    // produciría el commit INVERSO al que este criterio combate — una entrada cuyo archivo no viaja — y
    // el cruce local diría «sano» porque en disco están los dos.
    const aStagear = [REL_INDICE, ...reparadas.map((r) => path.join(REL_CHUNKS, r.id + SUFIJO))];
    // 🔴 Y se mira si el `git add` salió bien: un chunk que un `.gitignore` excluye, o un permiso, dejarían el
    // mensaje diciendo «stageado» sin haberlo corroborado. Si falla, se dice y `reparado` queda en false: el índice quedó escrito, pero el
    // commit no se lo va a llevar entero.
    const add = gitOk(dir, ['add', '--', ...aStagear]);
    if (!add.ok) avisos.push(`no pude stagear todo lo reparado (el índice puede haber quedado stageado y algún archivo no): ${add.motivo}`);
  }

  // Verificación: el mismo criterio, otra vez, sobre lo que quedó escrito.
  const despues = cruzar(dir, { contra: null });
  const verificado = {
    huerfanos: despues.huerfanos === null ? null : despues.huerfanos.length,
    importador: null,
  };
  verificado.importador = verificarConImportador(dir, despues.archivos);
  return {
    ...cruce, aplicado: true, reparadas, noReparadas, verificado, avisos,
    reparado: despues.huerfanos !== null && despues.huerfanos.length === 0 && !noReparadas.length && !avisos.length,
  };
}

/**
 * indiceLocal(dir) — ¿el repo está en «índice local»? Lo declara el propio repo: `.engram/manifest.json` ignorado
 * por su `.gitignore` y fuera de `git ls-files`. Entonces el índice no viaja por git y cada clon lo rehace desde sus
 * chunks (`rehacer`). Sin git que conteste, `false`: se sigue como un repo con el índice versionado, que es lo de
 * siempre.
 */
function indiceLocal(dir) {
  if (!gitOk(dir, ['check-ignore', '-q', '--', REL_INDICE]).ok) return false;
  return !gitOk(dir, ['ls-files', '--error-unmatch', '--', REL_INDICE]).ok;
}

// Autor y fecha de cada chunk en UNA pasada de `git log` (la última vez que un commit lo tocó, como
// `reconstruirDelChunk`). Un chunk que ningún commit trajo todavía no aparece: lo completa quien llama.
function autoresDeLosChunks(dir) {
  const r = gitOk(dir, ['log', '--format=%x00%an|%aI', '--name-only', '--', ':/' + REL_CHUNKS]);
  const mapa = new Map();
  if (!r.ok) return { mapa, motivo: r.motivo };
  let actual = null;
  for (const linea of r.out.split('\n')) {
    if (linea.startsWith('\0')) {
      const s = linea.slice(1);
      const i = s.lastIndexOf('|');   // por el último separador: un autor puede traer `|`
      actual = { autor: s.slice(0, i), fecha: s.slice(i + 1) };
      continue;
    }
    const f = linea.trim();
    if (!actual || !f.endsWith(SUFIJO)) continue;
    const id = path.basename(f).slice(0, -SUFIJO.length);
    if (!mapa.has(id)) mapa.set(id, actual);   // el log va del más nuevo al más viejo
  }
  return { mapa, motivo: null };
}

/**
 * rehacer(dir) — el índice local, al día con la carpeta de chunks. Quien llama ya decidió que el repo está en índice
 * local (`indiceLocal`).
 *
 * Agrega una entrada por cada chunk que el índice no declara y nunca borra: las que estaban quedan en su orden y las
 * nuevas entran por fecha (`insertarPorFecha`). Escribe con `serializar` y no stagea (el índice no viaja). Sin chunks
 * nuevos no lee ningún chunk, no llama a git y no toca el archivo: es el caso de todos los arranques. Un chunk
 * ilegible no se inventa: queda en `noAgregadas` con su motivo. Un índice local ilegible se rehace entero desde los
 * chunks y se dice en `avisos`: a diferencia del versionado, romperlo no pierde nada que no esté en la carpeta.
 */
function rehacer(dir) {
  const base = { repo: dir, estado: 'no-medido', motivo: null, archivos: null, declarados: null, agregadas: [], noAgregadas: [], sinFecha: [], fantasmas: [], avisos: [] };
  const dis = leerChunksDeDisco(dir);
  if (dis.error) {
    if (dis.error.codigo === 'sin-carpeta-chunks') return { ...base, estado: 'sano', archivos: 0, declarados: 0 };
    return { ...base, motivo: dis.error.motivo };
  }
  const fIndice = path.join(dir, REL_INDICE);
  let manifest;
  if (!fs.existsSync(fIndice)) {
    manifest = { version: 1, chunks: [] };
  } else {
    const leido = leerIndiceDeDisco(dir);
    if (leido.error) {
      base.avisos.push(`el índice local no se podía leer (${leido.error.motivo}): se rehace entero desde los chunks`);
      manifest = { version: 1, chunks: [] };
    } else {
      manifest = leido.manifest;
    }
  }
  const declarados = new Set(manifest.chunks.map((c) => c.id));
  const enDisco = new Set(dis.ids);
  const faltantes = dis.ids.filter((id) => !declarados.has(id)).sort();
  const fantasmas = [...declarados].filter((id) => !enDisco.has(id)).sort();
  const res = { ...base, archivos: dis.ids.length, declarados: declarados.size, fantasmas };
  if (!faltantes.length && !base.avisos.length) return { ...res, estado: 'sano' };

  const { mapa, motivo } = faltantes.length ? autoresDeLosChunks(dir) : { mapa: new Map(), motivo: null };
  if (motivo) res.avisos.push(`no pude leer de git el autor de los chunks (${motivo}): va el del clon`);
  let autorDelClon = null;
  // 🔴 El orden del índice ES el orden en que el importador aplica los chunks, y gana la última escritura. Por eso cada
  // entrada nueva va por la fecha más nueva de ADENTRO del chunk y no por la del commit: medido sobre el privado
  // con el importador real, la del commit dejaba 3 observaciones con una versión vieja. Un chunk sin fecha adentro no
  // tiene lugar que respetar: va al final, y se dice.
  const sinFecha = [];
  for (const id of faltantes) {
    const f = path.join(dir, REL_CHUNKS, id + SUFIJO);
    const c = leerChunk(f);
    if (!c) { res.noAgregadas.push({ id, motivo: 'el chunk no se puede leer (¿no es gzip, o está truncado?): no se inventa una entrada' }); continue; }
    let { autor, fecha: fechaCommit } = mapa.get(id) || {};
    if (!autor) {
      if (autorDelClon === null) { const cfg = gitOk(dir, ['config', 'user.name']); autorDelClon = (cfg.ok && cfg.out.trim()) || 'desconocido'; }
      autor = autorDelClon;
    }
    let fecha = c.fecha;
    if (!fecha) {
      fecha = fechaUtc(fechaCommit);
      if (!fecha) { try { fecha = fechaUtc(new Date(fs.statSync(f).mtime).toISOString()); } catch { fecha = null; } }
    }
    const entrada = entradaEngram({
      id, created_by: autor, created_at: fecha || new Date(0).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      sessions: c.ses, memories: c.obs, prompts: c.prompts,
    });
    if (c.fecha) insertarPorFecha(manifest.chunks, entrada);
    else sinFecha.push(entrada);
    res.agregadas.push(id);
  }
  for (const e of sinFecha) manifest.chunks.push(e);
  res.sinFecha = sinFecha.map((e) => e.id);
  if (sinFecha.length) res.avisos.push(`${sinFecha.length} chunk(s) sin una fecha legible adentro van al final del índice: ${res.sinFecha.join(', ')}`);
  if (res.agregadas.length || base.avisos.length) {
    try { fs.writeFileSync(fIndice, serializar(manifest)); }
    catch (e) { return { ...res, estado: 'no-medido', motivo: `no pude escribir ${REL_INDICE}: ${e.message}` }; }
  }
  return { ...res, estado: res.noAgregadas.length ? 'deriva' : 'sano', declarados: manifest.chunks.length };
}

// Importa sobre una base DESCARTABLE (ENGRAM_DATA_DIR) y compara cuántos chunks vio contra los
// archivos que hay. Si engram no está, se DICE — callarlo haría pasar «no verifiqué» por «verifiqué».
function verificarConImportador(dir, archivos) {
  let tmpBase = null;
  try {
    const os = require('os');
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-verif-'));
    // 🔴 Con timeout: esto corre DESPUÉS de haber escrito el índice, así que un importador colgado
    // dejaría al dev esperando con la reparación ya hecha y sin saberlo. 60 s es varias veces lo
    // que tarda un import de un repo grande sobre una base vacía; pasado eso, se dice y se sigue.
    const out = execFileSync('engram', ['sync', '--import'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
      env: { ...process.env, ENGRAM_DATA_DIR: tmpBase },
    });
    // 🔴 El engram REAL (1.20.0) imprime «Imported 3 new chunk(s) from .engram/»: entre el número
    // y «chunk» hay una palabra. Con `\s+` el match sería null SIEMPRE, así que la comparación de
    // chunks no correría nunca y la alarma de desajuste sería inalcanzable — en toda máquina con engram
    // instalado esto diría «no pude leer cuántos chunks vio» tras una reparación correcta.
    const n = (out.match(/(\d+)[^\n]*?\bchunks?\b/i) || [])[1];
    if (n === undefined) return `importé sobre una base descartable y no pude leer cuántos chunks vio: ${out.trim().split('\n').slice(-1)[0] || '(sin salida)'}`;
    return Number(n) === archivos
      ? `un importador de verdad vio los ${n} chunks`
      : `🔴 un importador de verdad vio ${n} chunk(s) y en disco hay ${archivos}`;
  } catch (e) {
    const msg = String((e && e.code) === 'ENOENT' ? 'engram no está en el PATH' : ((e && e.stderr) || (e && e.message) || e)).trim().split('\n')[0];
    return `no verifiqué con un importador (${msg})`;
  } finally {
    if (tmpBase) { try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* da igual */ } }
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
const SALIDA = { SANO: 0, DERIVA: 1, NO_MEDIDO: 3 };

function repoDe(dir) {
  const r = gitOk(dir, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.out.trim() : path.resolve(dir);
}

function comandoDeReparacion(dir) {
  return `node ${JSON.stringify(path.resolve(__filename))} repair --apply --repo ${JSON.stringify(path.resolve(dir))}`;
}

function imprimirCruce(r) {
  if (r.estado === 'no-medido') {
    console.error(`⚠️  no pude medir el índice de memoria de ${r.repo}: ${r.motivo}`);
    return;
  }
  if (r.estado === 'sano') {
    console.log(`✅ ${r.repo}: el índice de memoria declara sus ${r.archivos} archivo(s).`);
    return;
  }
  console.log(`🔴 ${r.repo}: el índice de memoria NO cierra (${r.archivos} archivo(s), ${r.declarados} declarado(s)).`);
  if (r.perdidas.length) console.log(`   entradas que ${r.contra.ref} declara y el índice actual ya no: ${r.perdidas.join(', ')}`);
  if (r.chunksSinEntrada.length) console.log(`   archivos nuevos sin entrada: ${r.chunksSinEntrada.join(', ')}`);
  if (r.huerfanosHeredados.length) console.log(`   ya venían sin entrada de antes: ${r.huerfanosHeredados.join(', ')}`);
  if (r.fantasmas.length) console.log(`   entradas cuyo archivo no está: ${r.fantasmas.join(', ')}`);
  if (r.duplicados.length) console.log(`   entradas declaradas más de una vez: ${r.duplicados.join(', ')}`);
  if (!r.contra.legible && r.contra.ref !== null) console.log(`   (no se pudo comparar contra ${r.contra.ref}: ${r.contra.motivo} — todo se cuenta como heredado)`);
  console.log(`   Reparación: ${comandoDeArreglo(r.repo)}`);
}

function imprimirReparacion(r) {
  if (r.estado === 'no-medido') { console.error(`⚠️  no pude medir el índice de memoria de ${r.repo}: ${r.motivo}`); return; }
  if (!r.reparadas.length && !r.noReparadas.length) {
    // Sin huérfanos pero en deriva: fantasmas o duplicados, que este comando NO toca (borrar es
    // decisión de una persona). Decir «no hay nada que reparar» acá era un ✅ sobre un índice roto.
    if (r.estado === 'deriva') {
      console.log(`⚠️  ${r.repo}: no hay archivos sin entrada, pero el índice NO cierra — esto no lo repara este comando:`);
      if (r.fantasmas.length) console.log(`   entradas cuyo archivo no está: ${r.fantasmas.join(', ')}`);
      if (r.duplicados.length) console.log(`   entradas repetidas: ${r.duplicados.join(', ')}`);
      console.log('   Borrar una entrada es otra decisión: mirá de dónde salió cada una antes de tocarla.');
      return;
    }
    console.log(`✅ ${r.repo}: no hay nada que reparar.`); return;
  }
  for (const x of r.reparadas) console.log(`   ${r.aplicado ? '+' : '·'} ${x.id}: ${x.origen === 'chunk' ? 'reconstruida desde el propio chunk' : `rescatada de ${x.origen}`}`);
  for (const x of r.noReparadas) console.error(`   🔴 ${x.id}: ${x.motivo}`);
  if (r.fantasmas.length) console.log(`   (no se borra nada) entradas cuyo archivo no está: ${r.fantasmas.join(', ')}`);
  if (r.duplicados.length) console.log(`   (no se borra nada) entradas repetidas: ${r.duplicados.join(', ')}`);
  if (!r.aplicado) { console.log(`\nEn seco: no escribí nada. Para aplicarlo, agregá --apply`); return; }
  if (!r.reparadas.length) { console.log('   no toqué el índice: no había ninguna entrada que pudiera rescatar.'); return; }
  if ((r.avisos || []).length) for (const a of r.avisos) console.error(`   🔴 ${a}`);
  console.log(`   índice escrito${(r.avisos || []).length ? '' : ' y stageado'} (${r.reparadas.length} entrada(s) agregada(s); ninguna borrada).`);
  console.log(`   verificación: ${r.verificado.huerfanos} huérfano(s) tras reparar · ${r.verificado.importador}`);
  if (r.reparado) console.log('✅ reparado.');
}

function imprimirRehecho(r) {
  if (r.estado === 'no-medido') { console.error(`⚠️  no pude rehacer el índice de memoria de ${r.repo}: ${r.motivo}`); return; }
  for (const a of r.avisos) console.error(`   ⚠️  ${a}`);
  for (const x of r.noAgregadas) console.error(`   🔴 ${x.id}: ${x.motivo}`);
  if (r.fantasmas.length) console.log(`   (no se borra nada) entradas cuyo archivo no está: ${r.fantasmas.join(', ')}`);
  console.log(r.agregadas.length
    ? `✅ ${r.repo}: índice local rehecho (${r.agregadas.length} entrada(s) agregada(s); ninguna borrada; no viaja por git).`
    : `✅ ${r.repo}: el índice local declara sus ${r.archivos} archivo(s).`);
}

function main(argv) {
  const cmd = argv[0];
  const val = (bandera) => { const i = argv.indexOf(bandera); return i >= 0 ? argv[i + 1] : undefined; };
  const tiene = (bandera) => argv.includes(bandera);
  if (!['cross', 'repair', 'rebuild'].includes(cmd)) {
    console.error('uso: manifest-engram.js cross|repair|rebuild [--repo <dir>] [--against <ref>] [--staged] [--apply] [--json]');
    return SALIDA.NO_MEDIDO;
  }
  const dir = repoDe(val('--repo') || process.cwd());
  const contraCrudo = val('--against');
  const json = tiene('--json');

  if (cmd === 'rebuild') {
    if (!indiceLocal(dir)) {
      const r = { repo: dir, estado: 'no-aplica', motivo: `no aplica: el índice viaja por git en ${dir}, usar repair` };
      if (json) console.log(JSON.stringify(r, null, 2)); else console.error(`ℹ️  ${r.motivo} (${comandoDeReparacion(dir)})`);
      return SALIDA.NO_MEDIDO;
    }
    const r = rehacer(dir);
    if (json) console.log(JSON.stringify(r, null, 2)); else imprimirRehecho(r);
    if (r.estado === 'no-medido') return SALIDA.NO_MEDIDO;
    return r.noAgregadas.length ? SALIDA.DERIVA : SALIDA.SANO;
  }

  if (cmd === 'cross') {
    // `--staged`: «lo nuevo» es el ÍNDICE de git — lo que el commit va a llevar — y no el disco.
    // Es lo que usa el hook del commit: cruzar el árbol de trabajo dejaría MUDO un índice truncado stageado con el
    // disco sano, mientras el commit entra.
    const opciones = contraCrudo === undefined ? {} : { contra: contraCrudo };
    if (tiene('--staged')) opciones.arbol = '';
    const r = cruzar(dir, opciones);
    if (json) console.log(JSON.stringify(r, null, 2)); else imprimirCruce(r);
    return r.estado === 'no-medido' ? SALIDA.NO_MEDIDO : r.estado === 'sano' ? SALIDA.SANO : SALIDA.DERIVA;
  }

  const r = reparar(dir, { apply: tiene('--apply'), ...(contraCrudo === undefined ? {} : { contra: contraCrudo }) });
  if (json) console.log(JSON.stringify(r, null, 2)); else imprimirReparacion(r);
  if (r.estado === 'no-medido') return SALIDA.NO_MEDIDO;
  if (r.noReparadas.length) return SALIDA.DERIVA;                 // algo no se pudo reparar: no es un 0
  if (!r.reparadas.length) return r.estado === 'deriva' ? SALIDA.DERIVA : SALIDA.SANO;  // fantasmas/duplicados: no hay nada que ESTE comando repare, pero el índice no cierra
  return r.aplicado && r.reparado ? SALIDA.SANO : SALIDA.DERIVA;  // en seco, «hay algo que reparar» = 1
}

/**
 * rehacerSiLocal(dir) — lo que corre el arranque antes de `engram sync --import`: si `dir` está en un repo en índice
 * local, `rehacer` en su raíz. `{ aplica: false }` fuera de un repo o con el índice versionado (no se toca nada); si
 * aplica, el resultado de `rehacer` más `problema`: el texto de lo que no se pudo (null si quedó entero).
 */
function rehacerSiLocal(dir) {
  const top = gitOk(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { aplica: false };
  const raiz = top.out.trim();
  if (!indiceLocal(raiz)) return { aplica: false };
  const r = rehacer(raiz);
  const problema = r.estado === 'no-medido' ? r.motivo
    : r.noAgregadas.length ? `${r.noAgregadas.length} chunk(s) ilegible(s) quedaron afuera: ${r.noAgregadas.map((x) => x.id).join(', ')}`
      : null;
  return { aplica: true, ...r, problema };
}

function comandoDeRehacer(dir) {
  return `node ${JSON.stringify(path.resolve(__filename))} rebuild --repo ${JSON.stringify(path.resolve(dir))}`;
}

// El arreglo que corresponde a un repo: en índice local se rehace (`rebuild`); con el índice versionado se repara.
function comandoDeArreglo(dir) {
  return indiceLocal(dir) ? comandoDeRehacer(dir) : comandoDeReparacion(dir);
}

module.exports = { cruzar, serializar, reparar, contarChunk, parsearIndice, insertarPorFecha, comandoDeReparacion, indiceLocal, rehacer, rehacerSiLocal, comandoDeRehacer, comandoDeArreglo, REL_INDICE, REL_CHUNKS };

if (require.main === module) {
  // El subcomando y la opción viejos siguen andando. Viejo y nuevo juntos: 3, el «no se pudo
  // medir» de este criterio (nunca 2, que es el bloqueo de los hooks). Sin la biblioteca (una copia suelta), paso directo.
  try { require('./legacy-names.js').aliasArgv('scripts/lib/manifest-engram.js', { exitCode: SALIDA.NO_MEDIDO }); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; }
  // `exitCode`, no `process.exit()`: el reporte `--json` es grande, y con la salida por un caño `process.exit()` corta
  // lo que el caño todavía no tomó (en macOS llegaron 8192 bytes de 12 495: el intermitente de T34 de
  // legacy-names-b3.test.js). `main` es toda sincrónica: al volver no queda nada pendiente salvo esa salida.
  process.exitCode = main(process.argv.slice(2));
}
