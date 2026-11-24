/**
 * marker-sessions.js — una parte de marker.js: el despachador la carga para sus subcomandos.
 *
 * Responsabilidad: las sesiones y sus corridas: listar, buscar, recuperar, adoptar, estacionar y anotar qué hace cada una.
 *
 * El código viene de marker.js tal cual, salvo tres reescrituras mecánicas: el estado que cambia mientras corre se lee de
 * `estado` (en marker-shared.js), la carpeta y la ruta de marker.js son `SCRIPTS_DIR` y `MARKER_JS`, y los `require`
 * locales van relativos a esta carpeta.
 */
const {
  ACTIVE_DIR, STALE_HOURS, STATE_DIR, STEPS_LIB, appendLog, avisarOficina,
  cerrarEjecucion, conRutas, estado, firmaDelDueno, frenarSiIlegible,
  frenarSiPerdida, fs, huellaDelPlan, marcaDe, markerFilePath, nowIso, parkedPath, path, porDe,
  pruneStale, readMarker, sessionLiveness, syncSessionState, untilIso,
  warnPastUntil, writeMarker,
} = require('./marker-shared.js');

// ============================================================
// Cross-session discovery
// Sin esto, un pipeline iniciado en sessionA queda
// invisible para sessionB, porque `marker.js get` lee solo ESTA sesión.
// list-all + find-by-story permiten que cualquier hook detecte pipelines
// activos en otras sesiones antes de arrancar duplicado.
// ============================================================

function listAllMarkers() {
  if (!fs.existsSync(ACTIVE_DIR)) return [];
  pruneStale();
  let files = [];
  try { files = fs.readdirSync(ACTIVE_DIR); } catch (_e) { return []; }
  const markers = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, f), 'utf8'));
      if (m && m.storyId) markers.push(m);
    } catch (_e) { /* ignore */ }
  }
  return markers;
}

function cmdListAll() {
  process.stdout.write(JSON.stringify(listAllMarkers(), null, 2));
}

function cmdFindByStory(storyId) {
  if (!storyId) {
    console.error('marker.js find-by-story: storyId requerido');
    process.exit(2);
  }
  const all = listAllMarkers();
  const matches = all.filter((m) => m.storyId === storyId);
  process.stdout.write(JSON.stringify(matches, null, 2));
}
function sacarMarca(sid) {
  try { fs.unlinkSync(parkedPath(sid)); } catch (e) { if (e.code !== 'ENOENT') console.error(`⚠️  marker.js: no pude sacar la marca de la sesión ${sid} (${e.code || e.message}).`); }
}
// Las corridas abiertas de una historia, con las viejas: una dejada en fila puede llevar días sin tocarse.
function corridasDe(storyId) {
  let files = [];
  try { files = fs.readdirSync(ACTIVE_DIR).filter((f) => f.endsWith('.json')); } catch (_e) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, f), 'utf8'));
      if (m && String(m.storyId) === String(storyId)) out.push(m.sessionId || f.replace(/\.json$/, ''));
    } catch (e) { process.stderr.write(`[marker] no pude leer ${f} (${e.message}): no sé si es de la historia ${storyId}.\n`); }
  }
  return out;
}

function cmdPark(storyId, rest = []) {
  const uso = 'uso: marker.js park <historia> --queue | --until AAAA-MM-DD [--session <id>]';
  if (!storyId || String(storyId).startsWith('--')) { console.error(`marker.js park: falta la historia — ${uso}`); process.exit(2); }
  const queue = rest.includes('--queue');
  const u = rest.indexOf('--until');
  const until = u >= 0 ? rest[u + 1] : null;
  if (queue === (u >= 0)) { console.error(`marker.js park: va con --queue o con --until, uno de los dos — ${uso}`); process.exit(2); }
  // una fecha de verdad: un 31 de febrero no es una. Se compara en UTC, así da lo mismo el huso de la máquina
  const when = until && /^\d{4}-\d\d-\d\d$/.test(until) ? new Date(`${until}T00:00:00Z`) : null;
  if (u >= 0 && !(when && !Number.isNaN(when.getTime()) && when.toISOString().slice(0, 10) === until)) { console.error(`marker.js park: --until va con una fecha AAAA-MM-DD (es ${until}) — ${uso}`); process.exit(2); }
  const s = rest.indexOf('--session');
  const pedida = s >= 0 ? String(rest[s + 1] || '').replace(/[/\\]/g, '_') : null;
  const corridas = corridasDe(storyId);
  const elegidas = pedida ? corridas.filter((c) => c === pedida) : corridas;
  if (!elegidas.length) { console.error(`marker.js park: no hay una corrida de la historia ${storyId}${pedida ? ` en la sesión ${pedida}` : ''}: no se marcó nada.`); process.exit(1); }
  if (elegidas.length > 1) { console.error(`marker.js park: hay ${elegidas.length} corridas de la historia ${storyId}: ${elegidas.join(', ')}. Decí cuál con --session <id>: no se marcó nada.`); process.exit(1); }
  const file = parkedPath(elegidas[0]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ story: String(storyId), kind: queue ? 'queue' : 'until', until: queue ? null : until, at: nowIso(), by: estado.SID })}\n`);
  fs.renameSync(tmp, file);
  appendLog('parked.log', { kind: 'PARK', story: String(storyId), sessionId: elegidas[0], until: queue ? null : until, by: estado.SID });
  process.stdout.write(`park: la corrida de la historia ${storyId} (sesión ${elegidas[0]}) queda ${queue ? 'en fila para pruebas' : `en pausa hasta ${until}`}\n`);
}

function cmdUnpark(storyId) {
  if (!storyId) { console.error('marker.js unpark: falta la historia — uso: marker.js unpark <historia>'); process.exit(2); }
  const dir = path.join(STATE_DIR, 'parked');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_e) { /* sin carpeta, ninguna marca */ }
  const marcadas = files.filter((f) => { try { return String(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).story) === String(storyId); } catch (_e) { return false; } });
  if (!marcadas.length) { console.error(`marker.js unpark: no hay una marca de la historia ${storyId}.`); process.exit(1); }
  for (const f of marcadas) sacarMarca(f.replace(/\.json$/, ''));
  appendLog('parked.log', { kind: 'UNPARK', story: String(storyId), by: estado.SID });
  process.stdout.write(`unpark: la corrida de la historia ${storyId} ya no está marcada\n`);
}

function cmdClearSession(sid, rest = []) {
  if (!sid) {
    console.error('marker.js clear-session: sessionId requerido');
    process.exit(2);
  }
  const safe = String(sid).replace(/[/\\]/g, '_');
  if (rest.includes('--lost')) return cmdSalidaPerdida('lost', safe);
  const p = path.join(ACTIVE_DIR, `${safe}.json`);
  if (!fs.existsSync(p)) {
    console.error(`marker.js clear-session: no había marcador de esa sesión (${safe}): no se borró nada.`);
    console.error('  Si su ejecución quedó perdida (frena con «EJECUCIÓN PERDIDA»), la salida es clear-session <sesión> --lost, con la firma de una persona.');
    process.exit(1);
  }
  frenarSiIlegible(p, safe, `clear-session ${safe}`);
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  frenarSiPerdida(safe, 'clear-session', m.repoPath);
  // una ejecución detenida espera la decisión del dueño: desde otra sesión no se borra; la cierra él o la retoma
  if (m.needs_human === true) {
    console.error(`marker.js clear-session: esa ejecución espera la decisión de una persona: la cierra ella (clear-session ${safe} --lost, con su firma) o la retoma (resume-autonomy). No se borró nada.`);
    process.exit(1);
  }
  // limpiar una corrida dejada a propósito pierde el trabajo: primero se saca la marca, a conciencia
  const marca = marcaDe(safe, m);
  if (marca) {
    console.error(`marker.js clear-session: la corrida de la historia ${m.storyId} está marcada (en fila o en pausa) y limpiarla pierde su trabajo: no se borró nada.`);
    if (marca.kind === 'historia') console.error(`  La pausa viene de \`paused_until: ${marca.until}\` de su historia: si de verdad hay que limpiarla, primero sacá esa línea.`);
    else if (marca.kind === 'ilegible') console.error(`  Su marca no se puede leer: mirá ${parkedPath(safe)} y, si de verdad hay que limpiarla, sacala primero.`);
    else console.error(`  Si de verdad hay que limpiarla, primero: marker.js unpark ${m.storyId}`);
    process.exit(1);
  }
  try { fs.unlinkSync(p); } catch (e) {
    console.error(`marker.js clear-session: no pude borrar ${p}: ${e.message}`);
    process.exit(1);
  }
  avisarOficina(safe);
  cerrarEjecucion(safe, m, { registrar: false, estado: 'abortada', motivo: estado.SID === safe ? 'clear-session de la propia sesión' : `clear-session desde la sesión ${estado.SID}` });
  syncSessionState(safe);
  process.stdout.write(`cleared: ${safe}.json\n`);
}

/**
 * ¿La partición de la historia dejó sin objeto la ejecución de `sesion`? `{ ok }` o `{ ok: false, motivo }`. Con la tanda
 * del marcador (el vivo o el podado), si la historia de ahora ya no la nombra. Sin tanda, si la historia no traía bloque
 * `pipelines:` al arrancar y ahora sí. La historia de arranque sale del repo de la historia, por fecha: el último commit
 * que la tocó antes de la apertura. El `baseSha` del marcador no sirve: es del repo del código.
 */
function reemplazadaPorParticion(apertura, sesion, podada) {
  const checks = require('./story-checks.js');
  const storyPath = apertura.storyPath ? path.resolve(apertura.repo || process.cwd(), apertura.storyPath) : null;
  if (!storyPath) return { ok: false, motivo: 'la apertura no dice qué historia era' };
  let ahora;
  try { ahora = fs.readFileSync(storyPath, 'utf8'); } catch (e) { return { ok: false, motivo: `no pude leer la historia ${storyPath} (${e.code || e.message})` }; }
  const tandas = checks.parsePipelinesBlock(ahora).map((t) => t.name);
  if (!tandas.length) return { ok: false, motivo: 'la historia de ahora no está partida en tandas' };
  let m = null;
  try { m = JSON.parse(fs.readFileSync(markerFilePath(sesion), 'utf8')); } catch (_e) { m = podada || null; }
  if (m && m.batch) {
    return tandas.includes(String(m.batch)) ? { ok: false, motivo: `su tanda ${m.batch} sigue en la historia` } : { ok: true };
  }
  const dir = path.dirname(storyPath);
  const git = (args) => require('child_process').execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let alArrancar;
  try {
    const sha = git(['log', '-1', `--before=${apertura.ts}`, '--format=%H', '--', path.basename(storyPath)]);
    if (!sha) return { ok: false, motivo: 'la historia no tiene un commit anterior a la apertura de la ejecución' };
    alArrancar = git(['show', `${sha}:./${path.basename(storyPath)}`]);
  } catch (e) { return { ok: false, motivo: `no pude leer la historia de antes de la apertura (${String(e.message).split('\n')[0]})` }; }
  if (checks.parsePipelinesBlock(alArrancar).length) return { ok: false, motivo: 'la historia ya estaba partida en tandas cuando arrancó la ejecución' };
  return { ok: true };
}

// La salida de una ejecución perdida (lib/open-runs.js), que decide el dueño: `clear-session <sesión> --lost` la cierra
// como perdida y `restore <sesión>` rearma el marcador desde la copia de la apertura. Lo aprueba el dueño en la ventana
// de permiso, o lo corre él con --terminal: sin esa firma, el guion no cierra ni rearma nada.
function cmdSalidaPerdida(modo, sesion) {
  const or = require('./open-runs.js');
  const nombre = modo === 'lost' ? `clear-session ${sesion} --lost` : `restore ${sesion}`;
  // la que se podó por vieja dejó su marcador guardado (lib/story-gate-io.js savePruned): restore vuelve con sus pasos
  const io = require('./story-gate-io.js');
  const podada = modo === 'restore' ? io.readPruned(STATE_DIR, sesion) : null;
  // la apertura, con la misma regla que el freno y la pregunta del cuadro (open-runs.js aperturaParaSalida): la vigente
  // del registro, la copia del repo y, al restaurar, la podada; antes que todo eso, el restore a medias o terminado de esta sesión
  const aperturaCruda = or.aperturaParaSalida(sesion, { modo: modo === 'lost' ? 'lost' : 'restore', cwd: process.cwd(), estado: STATE_DIR, propia: estado.SID });
  if (aperturaCruda && aperturaCruda.deDonde === 'terminado') {
    process.stdout.write(`ya está restaurada: la ejecución de la story ${aperturaCruda.story} sigue en la sesión ${estado.SID}. No hay nada que repetir.\n`);
    return;
  }
  const aMedias = !!aperturaCruda && aperturaCruda.deDonde === 'a-medias';
  if (!aperturaCruda) {
    console.error(`marker.js ${nombre}: la sesión ${sesion} no tiene una ejecución abierta (ni apertura en el registro ni copia en este repo): no hay nada que ${modo === 'lost' ? 'cerrar' : 'restaurar'}.`);
    process.exit(1);
  }
  // sus rutas, absolutas contra su repo, antes de leer su copia, compararla, cerrarla o escribir el marcador (lib/run-dir.js):
  // una apertura vieja con el repo «.» o una podada con la carpeta relativa no se buscan en la carpeta de este proceso
  const ubicar = (a) => {
    const r = require('./run-dir.js').rutasDeLaCorrida({ repoPath: a.repo, runDir: a.runDir, storyPath: a.storyPath });
    if (typeof r.runDir !== 'string' || !path.isAbsolute(r.runDir)) return { motivo: r.motivo || 'no trae la carpeta de la ejecución' };
    return { apertura: { ...a, ...(r.repoPath ? { repo: r.repoPath } : {}), runDir: r.runDir, ...(r.storyPath ? { storyPath: r.storyPath } : {}) } };
  };
  const ubicada = ubicar(aperturaCruda);
  if (!ubicada.apertura) {
    console.error(`marker.js ${nombre}: no puedo ubicar la ejecución de la sesión ${sesion}: ${ubicada.motivo}. No se ${modo === 'lost' ? 'cerró' : 'restauró'} nada.`);
    process.exit(1);
  }
  const apertura = ubicada.apertura;
  // restore pisa el marcador propio y --lost borra el de la sesión perdida: si el que se toca no se lee, no se puede
  // anotar lo que deja (antes de pedir la firma)
  frenarSiIlegible(markerFilePath(modo === 'lost' ? sesion : estado.SID), modo === 'lost' ? sesion : estado.SID, nombre);
  // una apertura sin hora legible está dañada: no se cierra ni se rearma a ciegas
  if (!Number.isFinite(Date.parse(apertura.ts))) {
    console.error(`marker.js ${nombre}: la apertura de la sesión ${sesion} no trae una hora legible (${apertura.ts}): está dañada, y no se ${modo === 'lost' ? 'cierra' : 'rearma'} a ciegas.`);
    process.exit(3);
  }
  // desde la terminal sin --for-session cae en `_nosession`: el marcador vivo de otra historia que vive ahí no se pisa
  // (lib/restore-steps.js), y se frena antes de la firma, sin cerrar nada
  const vivo = modo === 'restore' && !aMedias ? require('./restore-steps.js').pisaMarcadorVivo({ sid: estado.SID, previo: readMarker(), story: apertura.story, staleHours: io.STALE_HOURS }) : null;
  if (vivo) {
    console.error(`marker.js ${nombre}: la sesión ${estado.SID} ya tiene el marcador vivo de la historia ${vivo.historia} (último toque ${vivo.ultimoToque || 'sin hora'}): restaurar acá lo pisaría y lo cerraría. No se tocó nada.\n` +
      `  · repetilo para la sesión donde va: marker.js ${nombre} --terminal --for-session <sesión destino>\n` +
      `  · o, si ese marcador es de una terminal que ya no se usa, sacalo primero (marker.js clear-session _nosession) y repetí el restore`);
    process.exit(2);
  }
  // cerrarla como reemplazada por la partición de su historia es de rutina, si de verdad la historia se partió después de
  // la apertura: se comprueba antes de la firma (también en el chequeo previo), y una bandera mal puesta no cierra nada
  const porParticion = modo === 'lost' && process.argv.includes('--partition');
  if (porParticion) {
    // el marcador podado por viejo también trae su tanda: se lee acá, aunque la salida de «perdida» no lo use para la apertura
    const p = reemplazadaPorParticion(apertura, sesion, podada || io.readPruned(STATE_DIR, sesion));
    if (!p.ok) {
      console.error(`marker.js ${nombre} --partition: ${p.motivo}: se cierra con lost-run, sin --partition. No se cerró nada.`);
      process.exit(2);
    }
  }
  // el dueño lo aprueba en la ventana de permiso (o lo corre con --terminal): sin eso, el guion no cierra ni rearma nada
  // por la delegación: el cierre por partición, sólo con una historia de rutina; cerrar como perdida o restaurar, con
  // `lost-run` delegado en el perfil
  const antesDelCierre = (via) => {
    if (via !== 'delegacion') return null;
    // cerrar como perdida o restaurar: la coordinadora, si el perfil le delega `lost-run` (lo miró el freno de la firma)
    if (!porParticion) return null;
    return require('./plan-review.js').rutinaParaDelegar({ story: apertura.storyPath ? path.resolve(apertura.repo || process.cwd(), apertura.storyPath) : null, repo: apertura.repo || null });
  };
  const firma = firmaDelDueno(porParticion ? 'lost-run:particion' : 'lost-run', `${modo === 'lost' ? `cerrar como perdida${porParticion ? ' (la partición de su historia la dejó sin objeto)' : ''}` : 'restaurar'} la ejecución de la story ${apertura.story} (sesión ${sesion})`, { antes: antesDelCierre });
  const { via } = firma;
  const cita = null;
  // pedida para otra sesión, la constancia dice cuál la pidió (SID ya es la destino)
  const desde = (firma.constancia && firma.constancia.por) || estado.SID;
  if (modo === 'lost') {
    try { fs.unlinkSync(markerFilePath(sesion)); } catch (_e) { /* ya no estaba: es lo perdido */ }
    avisarOficina(sesion);
    or.cerrar({ sid: estado.SID, sesion, runDir: apertura.runDir, story: apertura.story, estado: 'perdida', via, cita, extra: porDe(firma),
      motivo: `cerrada como perdida desde la sesión ${desde}` });
    sacarMarca(sesion);
    syncSessionState(sesion);
    process.stdout.write(`cerrada como perdida: la ejecución de la story ${apertura.story} (sesión ${sesion})\n`);
    return;
  }
  // lo que hace el restore después de la firma va en orden y deja escrito lo que falta (lib/restore-steps.js): primero el
  // marcador nuevo con la lista, después cada cierre y la apertura nueva. Un paso que falla corta ahí, y repetir el mismo
  // restore corre sólo lo que quedó, con los datos guardados en la lista. Un paso que corrió y no se pudo sacar de la
  // lista sigue ahí: cada uno mira en el registro si ya está hecho, para no cerrar ni abrir dos veces
  const yaCerrada = (s, motivo) => { const v = or.vigente(s); return !!v && v.name === 'run-close' && String(v.motivo || '').startsWith(motivo); };
  const pasosDelRestore = {
    apertura: (p) => (yaCerrada(p.sesion, 'restaurada en la sesión') ? true : or.cerrar({ sid: estado.SID, sesion: p.sesion, runDir: p.runDir, story: p.story, estado: 'perdida', via, cita, extra: porDe(firma), motivo: `restaurada en la sesión ${estado.SID}${desde !== estado.SID ? ` (pedido desde la sesión ${desde})` : ''}` })),
    reemplazada: (p) => (yaCerrada(estado.SID, `reemplazada por restore ${sesion} `) ? true : cerrarEjecucion(estado.SID, p.previo, { registrar: false, estado: 'abortada', motivo: `reemplazada por restore ${sesion} (story ${p.story})`, extra: porDe(firma) })),
    abrir: (p) => {
      const v = or.vigente(estado.SID);
      if (v && v.name === 'run-open' && String(v.story) === String(p.story) && or.mismaRuta(v.runDir, p.runDir)) return true;
      return or.abrir({ sid: estado.SID, story: p.story, storyPath: p.storyPath, repo: p.repo, runDir: p.runDir, motivo: 'restaurada' });
    },
    podada: (p) => { try { fs.unlinkSync(path.join(STATE_DIR, 'pruned', `${String(p.sesion).replace(/[/\\]/g, '_')}.json`)); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
  };
  const terminar = (r, story) => {
    if (!r.ok) {
      console.error(`marker.js ${nombre}: ${require('./restore-steps.js').queFalto(r)}${r.error ? ` (${r.error})` : ''}.`);
      process.exit(1);
    }
    sacarMarca(sesion);
    syncSessionState(estado.SID);
    process.stdout.write(`restaurada: la ejecución de la story ${story} vuelve a la sesión ${estado.SID}\n`);
  };
  const guardarPendiente = (base) => (p) => {
    const { restorePendiente: _r, ...m } = base || readMarker() || {};
    base = null;
    writeMarker({ ...m, ...(p.pasos.length ? { restorePendiente: p } : {}) });
  };
  if (aMedias) {
    // la herencia del plan se calculó en la primera vuelta y viaja con lo pendiente: el renglón va cuando termina
    const pend = readMarker().restorePendiente;
    const hecho = require('./restore-steps.js').correrRestore({ pendiente: pend, pasos: pasosDelRestore, escribirMarcador: guardarPendiente(null) });
    if (hecho.ok && pend && pend.herencia) anotarHerencia({ story: pend.story, desde: sesion, ...pend.herencia, via: 'restore' });
    terminar(hecho, apertura.story);
    return;
  }
  // restore: el marcador vuelve con lo que dice la copia de la apertura, en la sesión que la pide
  let copia = null;
  try { copia = JSON.parse(fs.readFileSync(path.join(apertura.runDir, 'run-open.json'), 'utf8')); } catch (_e) { copia = null; }
  const copiaUbicada = copia && copia.sesion === sesion ? ubicar(copia) : null;
  // una copia de esta sesión que no se ubica no se usa, y se dice: se restaura con la apertura elegida
  if (copiaUbicada && !copiaUbicada.apertura) process.stderr.write(`⚠️  marker.js ${nombre}: la copia de la apertura no se puede ubicar (${copiaUbicada.motivo}): uso la apertura del registro.\n`);
  const deLaCopia = copiaUbicada ? copiaUbicada.apertura : null;
  const base = deLaCopia || apertura;
  // la ejecución propia de otra carpeta no se pisa callada: se cierra como reemplazada, como en `set`, con su cierre sin
  // ok anotado antes de tocar nada
  const previo = readMarker();
  const reemplaza = previo && previo.storyId && !(previo.runDir && or.mismaRuta(previo.runDir, base.runDir));
  const sigue = !reemplaza && previo && String(previo.storyId) === String(base.story);
  // de la podada vuelven sus pasos y lo que anotó, si es la misma historia
  const guardada = !sigue && podada && String(podada.storyId) === String(base.story) ? (({ sessionId: _s, lastTouch: _l, prunedAt: _p, ...resto }) => resto)(podada) : null;
  const nuevo = {
    ...(sigue ? previo : guardada || {}),
    storyId: String(base.story), storyPath: base.storyPath || null, repoPath: base.repo || null, runDir: base.runDir,
    sessionId: estado.SID, lastTouch: nowIso(), restoredFrom: sesion, restoredAt: nowIso(), ...porDe(firma),
    ...(sigue || guardada ? {} : { startedAt: nowIso(), stepScheme: STEPS_LIB.SCHEME, stepsCompleted: [], stepsPending: STEPS_LIB.STEPS.filter((s) => !s.flag).map((s) => s.id) }),
  };
  // lo que vuelve de la podada es de otra sesión: su aprobación del plan vale sólo con el mismo plan, como al adoptar. El
  // renglón va cuando el restore terminó: si se corta a mitad, la herencia queda con lo pendiente y repetirlo lo deja
  const herencia = guardada ? heredarElPlan(nuevo) : null;
  // el previo se guarda con sus datos: el marcador nuevo pisa el archivo del que se leyó
  const pendiente = { sesion, story: String(base.story), ts: apertura.ts, antes: !!apertura.antes, ...(herencia ? { herencia } : {}), pasos: [
    { que: 'apertura', sesion, runDir: base.runDir, story: String(base.story) },
    ...(reemplaza ? [{ que: 'reemplazada', story: String(base.story), previo: { storyId: previo.storyId, storyPath: previo.storyPath || null, repoPath: previo.repoPath || null, runDir: previo.runDir || null, sessionId: previo.sessionId || estado.SID } }] : []),
    { que: 'abrir', story: String(base.story), storyPath: base.storyPath, repo: base.repo, runDir: base.runDir },
    ...(podada ? [{ que: 'podada', sesion }] : []),
  ] };
  const hecho = require('./restore-steps.js').correrRestore({ pendiente, pasos: pasosDelRestore, escribirMarcador: guardarPendiente(nuevo) });
  if (hecho.ok && herencia) anotarHerencia({ story: nuevo.storyId, desde: sesion, ...herencia, via: 'restore' });
  terminar(hecho, base.story);
}

/**
 * Una corrida que pasa a esta sesión (`adopt-session`, o `restore` de un marcador podado) trae la aprobación del plan
 * sólo si el plan es el mismo que se aprobó. Con el plan cambiado, o sin poder compararlo, la aprobación se borra y
 * «Aprobar el plan» vuelve a pendiente, en los dos esquemas de pasos. Muta `m` y devuelve `{ hereda, huellaPlan, herencia }`:
 * `huellaPlan` es la huella del plan sólo si trajo su aprobación.
 */
function heredarElPlan(m) {
  const huella = huellaDelPlan(m);
  const ap = m.planApproval;
  if (!ap) return { hereda: false, huellaPlan: null, herencia: 'sin plan aprobado' };
  if (!ap.planSha || !huella.sha || ap.planSha !== huella.sha) {
    require('./batch-scope.js').volverAlPlan(m);
    // en el esquema viejo de pasos `volverAlPlan` no toca nada: el paso del plan es el 3
    if (STEPS_LIB.schemeOf(m) === 1) {
      m.stepsCompleted = (m.stepsCompleted || []).filter((s) => String(s) !== '3');
      if (!(m.stepsPending || []).map(String).includes('3')) m.stepsPending = ['3', ...(m.stepsPending || [])];
    }
    delete m.planApproval;
    const herencia = !huella.sha ? `no pude leer el plan (${huella.motivo}): «Aprobar el plan» vuelve a pendiente`
      : !ap.planSha ? 'la aprobación no guardó la huella del plan: «Aprobar el plan» vuelve a pendiente'
        : 'el plan cambió desde que se aprobó: «Aprobar el plan» vuelve a pendiente';
    return { hereda: false, huellaPlan: null, herencia };
  }
  return { hereda: true, huellaPlan: huella.sha, herencia: 'el plan es el que se aprobó: la aprobación sigue' };
}

// El renglón de la corrida que cambió de sesión, en gates.log: de cuál vino, por qué camino (`via`) y si trajo la
// aprobación del plan, con su huella sólo si la trajo.
function anotarHerencia({ story, desde, hereda, huellaPlan, herencia, via }) {
  appendLog('gates.log', { name: 'adopt-session', status: 'ok', via, story: story || null, desde, a: estado.SID, huellaPlan: hereda ? huellaPlan : null, herencia });
  process.stderr.write(`[marker] ${via}: ${herencia}.\n`);
}

function cmdDoing(sub, arg) {
  const dir = path.join(STATE_DIR, 'doing');
  const safe = (s) => String(s).replace(/[/\\]/g, '_');
  if (sub === 'clear-orphan') {
    if (!arg) { console.error('marker.js doing clear-orphan: falta el id de la sesión — uso: doing clear-orphan <sessionId>'); process.exit(2); }
    const sid = safe(arg);
    if (sid === safe(estado.SID)) { console.error('marker.js doing clear-orphan: es la nota de esta sesión — se borra con `marker.js doing clear`'); process.exit(3); }
    const file = path.join(dir, `${sid}.json`);
    if (!fs.existsSync(file)) { console.error('marker.js doing clear-orphan: no hay nota de esa sesión: no se borró nada'); process.exit(1); }
    const live = sessionLiveness(sid);
    if (live.unknown) { console.error(`marker.js doing clear-orphan: no se borró — no pude verificar que la sesión no esté viva (${live.unknown})`); process.exit(3); }
    if (live.alive) { console.error(`marker.js doing clear-orphan: no se borró — la sesión está viva (pid ${live.pid})`); process.exit(3); }
    // como `adhoc clear-orphan`: una sesión sin archivo de sesión (Codex no lo escribe) parece muerta; 24 h sin tocarse
    // es la segunda señal
    let at = NaN;
    try { at = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).at); } catch (_e) { /* sin fecha legible: la del archivo */ }
    if (!Number.isFinite(at)) { try { at = fs.statSync(file).mtimeMs; } catch (_e) { at = Date.now(); } }
    if (Date.now() - at < STALE_HOURS * 3600 * 1000) {
      const d = new Date(at + STALE_HOURS * 3600 * 1000);
      console.error(`marker.js doing clear-orphan: no se borró — la nota tiene menos de ${STALE_HOURS} h; se podrá borrar después de las ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
      process.exit(3);
    }
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    avisarOficina(sid);
    appendLog('doing.log', { kind: 'DOING_CLEAR_ORPHAN', sessionId: sid, by: estado.SID });
    process.stdout.write(`doing: borrada la nota de la sesión ${sid}\n`);
    return;
  }
  if (!estado.SID) { console.error('marker.js doing: no sé qué sesión es (falta CLAUDE_CODE_SESSION_ID)'); process.exit(2); }
  const file = path.join(dir, `${safe(estado.SID)}.json`);
  if (sub === 'clear') {
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    avisarOficina();
    appendLog('doing.log', { kind: 'DOING_CLEAR' });
    process.stdout.write('doing: borrada\n');
    return;
  }
  // antes de mirar la corrida: un `--kind` mal puesto es error de uso con una historia abierta o sin ella
  const kindAt = process.argv.indexOf('--kind');
  const waitingKind = kindAt >= 0 ? process.argv[kindAt + 1] : null;
  const forAt = process.argv.indexOf('--waiting-for');
  const waitsFor = forAt >= 0 && process.argv[forAt + 1] && !process.argv[forAt + 1].startsWith('--');
  const kindArgs = process.argv.filter((a) => a === '--kind' || a.startsWith('--kind='));
  if (kindArgs.length && (kindArgs.length > 1 || kindAt < 0 || !waitsFor || !['main', 'session'].includes(waitingKind))) {
    console.error('marker.js doing: --kind va una vez, con --waiting-for y su texto, y vale main o session');
    process.exit(2);
  }
  // la clase puede ir antes que la espera: es la misma espera sin texto
  const waitOnly = sub === '--waiting-for' || (sub === '--kind' && waitsFor);
  // con una ejecución abierta, su paso ya dice qué hace y a qué hora termina: una nota encima la muestra en pausa. Pasa
  // sólo la espera de un turno sin texto, que es de la historia (la respetan las podas y el aviso al dueño)
  // un marcador ilegible no es «sin historia»: frena en vez de anotar como si no hubiera
  frenarSiIlegible(markerFilePath(estado.SID), estado.SID, 'doing');
  const run = readMarker();
  if (run && !waitOnly) {
    console.error(`marker.js doing: no se anotó nada — esta sesión tiene abierta la historia ${run.storyId}, y su paso ya dice qué hace y a qué hora termina; si deja la historia por otro trabajo, eso es otra sesión (si espera un turno: marker.js doing --waiting-for "<qué espera>")`);
    process.exit(3);
  }
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { /* sin nota, o rota: no hay nada que conservar */ }
  const onlyHour = sub === '--until' || waitOnly;
  if (onlyHour && !run && !(prev && prev.text)) { console.error('marker.js doing: sin una nota anotada, la hora va con su texto — uso: marker.js doing "<qué hago>" --until HH:MM'); process.exit(2); }
  const text = run ? '' : onlyHour ? prev.text : String(sub || '').replace(/\s+/g, ' ').trim();
  if (!run && (text.length < 8 || text.length > 200)) {
    console.error('marker.js doing: el texto va de 8 a 200 caracteres — uso: marker.js doing "<qué hago>" [--until HH:MM | --waiting-for "<qué espera>"] | doing clear');
    process.exit(2);
  }
  // `--until HH:MM`: la hora a la que la sesión dice que termina, para /wip y /office
  const u = process.argv.indexOf('--until');
  const endAt = u >= 0 ? untilIso(process.argv[u + 1]) : null;
  if (u >= 0 && !endAt) {
    console.error('marker.js doing: --until va con una hora HH:MM (por ejemplo 19:30)');
    process.exit(2);
  }
  const w = process.argv.indexOf('--waiting-for');
  const waitingFor = w >= 0 ? String(process.argv[w + 1] || '').replace(/\s+/g, ' ').trim() : '';
  if (w >= 0 && (waitingFor.length < 3 || waitingFor.length > 120 || u >= 0)) {
    console.error('marker.js doing: --waiting-for va con qué espera (de 3 a 120 caracteres) y sin --until: quien espera no da una hora');
    process.exit(2);
  }
  const now = new Date().toISOString();
  // el mismo trabajo, anotado hace menos de un día: la primera hora prometida y el arranque de la misma espera se conservan
  const same = prev && (prev.text || '') === text && Date.now() - Date.parse(prev.at) < 24 * 3600 * 1000;
  const firstHourAt = (same && prev.firstHourAt) || (endAt && !(same && prev.endAt) ? new Date(Date.now()).toISOString() : null);
  // se compara la hora del reloj: la misma hora tipeada puede caer en otro día si pasó el corte de untilIso, y eso la repite, no la corrige
  const clock = (iso) => new Date(iso).toTimeString().slice(0, 5);
  const corrects = Boolean(same && endAt && prev.endAt && clock(endAt) !== clock(prev.endAt) && !prev.promisedAt && !prev.hourCorrected && prev.firstHourAt && Date.now() - Date.parse(prev.firstHourAt) <= 10 * 60000);
  const promisedAt = same && !corrects ? prev.promisedAt || prev.endAt || null : null;
  const waitingSince = !waitingFor ? null : (same && prev.waitingFor === waitingFor && prev.waitingSince) || now;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...(text ? { text } : {}), at: now, ...(endAt ? { endAt } : {}), ...(promisedAt ? { promisedAt } : {}), ...(firstHourAt ? { firstHourAt } : {}), ...(corrects || (same && prev.hourCorrected) ? { hourCorrected: true } : {}), ...(waitingFor ? { waitingFor, waitingSince, ...(waitingKind ? { waitingKind } : {}) } : {}) }));
  avisarOficina();
  appendLog('doing.log', { kind: 'DOING_SET', ...(text ? { text } : {}), ...(endAt ? { endAt } : {}), ...(waitingFor ? { waitingFor } : {}) });
  if (endAt) warnPastUntil('doing', endAt);
  process.stdout.write(`doing: ${text || `la historia ${run.storyId}`}${endAt ? ` (termina ${process.argv[u + 1]})` : waitingFor ? ` (espera ${waitingFor})` : ''}\n`);
  // quien espera a la coordinadora suele dejar la pregunta en su pestaña, que ella no lee. Sin poder leer la designación
  // se recuerda igual: sobra una línea, no se pierde un pedido
  if (waitingFor && /coordinadora|coordinator/i.test(waitingFor)) {
    let designada = null;
    try { designada = require('./plan-review.js').designadaDeVerdad(STATE_DIR); } catch (_e) { designada = null; }
    if (designada !== estado.SID) process.stdout.write('doing: la coordinadora no lee tu pestaña: si todavía no le mandaste el pedido, mandáselo por mensaje, con lo que necesita para contestar\n');
  }
}

/**
 * adopt-session — resume cross-session SIN pérdida de estado.
 *
 * Un resume manual (re-escribir el marker con `set` y un payload parcial) PERDERÍA
 * filesTouched/iterations/dodRuntimeChecked/checks (state lossy). adopt-session copia el marker COMPLETO de la otra sesión al
 * sessionId actual y borra el archivo viejo en la misma operación (atómico:
 * write-own-then-unlink-other; si el unlink falla, pruneStale lo limpia en 24h).
 *
 * Rechaza si ESTA sesión ya tiene marker activo (no pisar un pipeline propio).
 */
function cmdAdoptSession(sid) {
  if (!sid) {
    console.error('marker.js adopt-session: sessionId requerido');
    process.exit(2);
  }
  if (sid === estado.SID) {
    console.error('marker.js adopt-session: esa YA es tu sesión');
    process.exit(2);
  }
  // adoptar no tapa la ejecución perdida de la sesión que adopta
  frenarSiPerdida(estado.SID, 'adopt-session');
  const own = readMarker();
  if (own && own.storyId) {
    console.error(`marker.js adopt-session: esta sesión ya tiene marker activo (story ${own.storyId}) — clear primero si querés adoptar otro`);
    process.exit(1);
  }
  const safe = String(sid).replace(/[/\\]/g, '_');
  const otherPath = path.join(ACTIVE_DIR, `${safe}.json`);
  if (!fs.existsSync(otherPath)) {
    console.error(`marker.js adopt-session: no existe marker de la sesión ${safe}`);
    process.exit(1);
  }
  let other;
  try {
    other = conRutas(JSON.parse(fs.readFileSync(otherPath, 'utf8')));
  } catch (e) {
    console.error(`marker.js adopt-session: marker de ${safe} ilegible:`, e.message);
    process.exit(1);
  }
  frenarSiPerdida(safe, 'adopt-session', other && other.repoPath);
  const adopted = { ...other, sessionId: estado.SID, lastTouch: nowIso(), adoptedFrom: safe, adoptedAt: nowIso() };
  const herencia = heredarElPlan(adopted);
  writeMarker(adopted);
  anotarHerencia({ story: adopted.storyId, desde: safe, ...herencia, via: 'adopt-session' });
  try { fs.unlinkSync(otherPath); } catch (_e) { /* pruneStale lo limpia */ }
  // quien adopta una corrida en fila la retoma: deja de estar dejada a propósito
  sacarMarca(safe);
  // el trabajo cambia de escritorio: la sesión vieja queda sin paso y la nueva toma el suyo
  syncSessionState(safe);
  syncSessionState(estado.SID);
  avisarOficina(safe);
  // la ejecución cambia de sesión: se cierra la de la otra y se abre en ésta, con la misma carpeta
  try {
    const or = require('./open-runs.js');
    const ult = or.vigente(safe);
    const runDir = other.runDir || (ult && ult.name === 'run-open' ? ult.runDir : null);
    if (!cerrarEjecucion(safe, { ...other, runDir }, { estado: 'abortada', motivo: `adoptada por la sesión ${estado.SID}`, registrar: false })) {
      throw new Error(`no pude anotar el cierre de la sesión ${safe}`);
    }
    if (runDir) or.abrir({ sid: estado.SID, story: other.storyId, storyPath: other.storyPath, repo: other.repoPath, runDir, motivo: `adoptada de la sesión ${safe}` });
    // un marcador de antes del registro de aperturas no trae carpeta: se adopta, pero sin apertura no se verá al faltar
    else process.stderr.write(`[marker] adopt-session: el marcador de ${safe} no trae la carpeta de la ejecución: queda adoptado sin apertura (no se verá si falta).\n`);
  } catch (e) {
    // sin la apertura en esta sesión, la ejecución adoptada no se vería al faltar: se dice y sale con error
    process.stderr.write(`[marker] adopt-session: no pude pasar la apertura de la ejecución a esta sesión (${e.message})\n`);
    process.stdout.write(JSON.stringify(adopted, null, 2));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(adopted, null, 2));
}

module.exports = {
  listAllMarkers, cmdListAll, cmdFindByStory, sacarMarca, corridasDe, cmdPark, cmdUnpark, cmdClearSession,
  reemplazadaPorParticion, cmdSalidaPerdida, cmdDoing, cmdAdoptSession,
};
