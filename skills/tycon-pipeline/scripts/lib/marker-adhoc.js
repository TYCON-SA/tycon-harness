/**
 * marker-adhoc.js — una parte de marker.js: el despachador la carga para sus subcomandos.
 *
 * Responsabilidad: los carriles de arreglo rápido (adhoc).
 *
 * El código viene de marker.js tal cual, salvo tres reescrituras mecánicas: el estado que cambia mientras corre se lee de
 * `estado` (en marker-shared.js), la carpeta y la ruta de marker.js son `SCRIPTS_DIR` y `MARKER_JS`, y los `require`
 * locales van relativos a esta carpeta.
 */
const {
  ADHOC_CUPO_MAX, ADHOC_MOTIVO_MAX, DATOS_TEXTO, DATOS_VALORES, MARKER_JS,
  PROPIA, SCRIPTS_DIR, STALE_HOURS, STATE_DIR, anotarFirma, appendLog,
  avisarOficina, citar, cupoAlDeclarar, estado, fs, nowIso, os, path,
  sessionLiveness, syncSessionState, untilIso, warnPastUntil,
} = require('./marker-shared.js');

function cmdAdhocClearOrphan(sid) {
  if (!sid) {
    console.error('marker.js adhoc clear-orphan: falta el id de la sesión — uso: adhoc clear-orphan <sessionId>');
    process.exit(2);
  }
  const io = require('./story-gate-io.js');
  // El id se compara ya saneado, igual que el nombre del archivo: un id con separadores no esquiva las comprobaciones.
  sid = String(sid).replace(/[/\\]/g, '_');
  const deny = (motivo, code = 3) => {
    appendLog('adhoc.log', { kind: 'ADHOC_CLEAR_ORPHAN_DENIED', sessionId: sid, motivo, by: estado.SID });
    console.error(`marker.js adhoc clear-orphan: no se borró — ${motivo}`);
    process.exit(code);
  };
  if (sid === String(estado.SID).replace(/[/\\]/g, '_')) deny('es el ad-hoc de esta misma sesión: se termina con `marker.js adhoc clear`');
  const file = io.adhocPath(STATE_DIR, sid);
  if (!fs.existsSync(file)) deny('no hay ad-hoc de esa sesión: no se borró nada', 1);
  let a = null;
  try { a = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { a = null; }
  const reason = a && typeof a === 'object' ? a.reason || null : '(ilegible)';
  // La última vez tocado: la primera fecha legible entre lastTouch y declaredAt; sin ninguna, la del archivo.
  let touched = [a && a.lastTouch, a && a.declaredAt].map((v) => Date.parse(v)).find(Number.isFinite);
  if (touched === undefined) {
    try { touched = fs.statSync(file).mtimeMs; } catch (e) { deny(`no pude leer la fecha del ad-hoc: ${e.message}`); }
  }
  const live = sessionLiveness(sid);
  if (live.unknown) deny(`no pude verificar que la sesión no esté viva (${live.unknown})`);
  if (live.alive) deny(`la sesión está viva (pid ${live.pid})`);
  const until = touched + STALE_HOURS * 3600 * 1000;
  if (Date.now() < until) {
    const d = new Date(until);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    deny(`lleva menos de ${STALE_HOURS} h sin tocarse: se podrá después de las ${hhmm} del ${d.toISOString().slice(0, 10)}`);
  }
  try { fs.unlinkSync(file); } catch (e) { deny(`no pude borrar ${file}: ${e.message}`, 1); }
  avisarOficina(sid);
  // appendLog no frena si no puede escribir: se mira que la línea haya quedado y, si no, se avisa.
  const logFile = path.join(STATE_DIR, 'adhoc.log');
  const size = () => { try { return fs.statSync(logFile).size; } catch (_e) { return -1; } };
  const before = size();
  appendLog('adhoc.log', { kind: 'ADHOC_CLEAR_ORPHAN', sessionId: sid, reason, lastTouch: new Date(touched).toISOString(), by: estado.SID });
  if (size() <= before) console.error(`marker.js adhoc clear-orphan: ⚠ se borró, pero no pude dejar la constancia en ${logFile}`);
  syncSessionState(sid);
  process.stdout.write(`adhoc: borrado el de la sesión ${sid} («${reason}»)\n`);
  process.exit(0);
}

/**
 * `adhoc allow-data-change --changed "<qué cambió>" --recommends <pasar|historia|descartar> --why "<por qué>"`: lo que
 * sigue a un freno de los datos (save-brake.js `frenoDeDatos`, que lo anotó en el carril). `pasar` pide la firma
 * `adhoc-lane:datos`, que aprueba sólo el click del dueño (o su terminal), y anota el click sobre la huella de ese freno;
 * `historia` y `descartar` no firman: dicen qué hacer. Ante la duda, historia.
 */
function cmdAdhocAllowDataChange(io) {
  const args = process.argv.slice(4);
  const v = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--terminal') continue;
    if (a === '--for-session') { i++; continue; }
    const clave = { '--changed': 'changed', '--recommends': 'recommends', '--why': 'why' }[a];
    if (!clave) { console.error(`marker.js adhoc allow-data-change: no conozco «${String(a).slice(0, 60)}».`); process.exit(2); }
    v[clave] = String(args[++i] == null ? '' : args[i]).trim();
  }
  const uso = 'Uso: marker.js adhoc allow-data-change --changed "<qué cambió, en una frase>" --recommends <pasar|historia|descartar> --why "<por qué>"';
  if (!v.recommends) { console.error(`marker.js adhoc allow-data-change: falta --recommends (pasar, historia o descartar). Si no sabés por qué es un falso positivo, es historia.\n  ${uso}`); process.exit(2); }
  if (!['pasar', 'historia', 'descartar'].includes(v.recommends)) { console.error(`marker.js adhoc allow-data-change: --recommends es pasar, historia o descartar.\n  ${uso}`); process.exit(2); }
  if (!v.changed) { console.error(`marker.js adhoc allow-data-change: falta --changed: qué cambió de verdad, en una frase.\n  ${uso}`); process.exit(2); }
  if (!v.why) { console.error(`marker.js adhoc allow-data-change: falta --why: por qué lo recomendás.\n  ${uso}`); process.exit(2); }
  for (const k of ['changed', 'why']) {
    if (v[k].length > ADHOC_MOTIVO_MAX) { console.error(`marker.js adhoc allow-data-change: --${k} de hasta ${ADHOC_MOTIVO_MAX} caracteres: el cuadro no muestra más.`); process.exit(2); }
  }
  const a = io.readAdhoc(STATE_DIR, estado.SID);
  if (!a) { console.error('marker.js adhoc allow-data-change: no hay un camino corto abierto en esta sesión.'); process.exit(1); }
  const f = a.frenoDatos;
  if (!f || !f.huella) { console.error('marker.js adhoc allow-data-change: no hay un freno de datos que destrabar en este carril: lo anota el freno de guardar cuando frena.'); process.exit(1); }
  if (a.datosPermitido && a.datosPermitido.huella === f.huella) { process.stdout.write('adhoc: una persona ya dejó pasar este cambio; guardá como siempre.\n'); process.exit(0); }
  if (v.recommends === 'historia') {
    process.stdout.write([
      'Escribí la historia: un cambio que cambia de dónde sale un dato o quién lo ve no es camino corto, aunque sea corto.',
      `  1. Cerrá el carril: node ${citar(MARKER_JS)} adhoc clear (lo tocado queda en la copia de trabajo, sin guardar).`,
      '  2. Creá la historia con la skill tycon-create-story, con lo que cambió y quién tiene que poder verlo.',
    ].join('\n') + '\n');
    process.exit(0);
  }
  if (v.recommends === 'descartar') {
    // sólo los archivos del carril, cada uno contra la base que usa su repo; lo que no es del carril no se toca. Vuelve a
    // la base lo que la base tiene; lo que no tiene es nuevo del carril, aunque ya esté guardado en la rama. Lo que no se
    // puede saber no se manda a borrar. Los repos son los del carril y los que midió el freno
    const base = require('./adhoc-base.js');
    const medida = base.medirLoPropio(a, { repos: Array.isArray(f.repos) ? f.repos : [] });
    // lo propio, como lo cuenta el tope sin mirar si es implementación: lo sin seguir de otra sesión no entra
    const porRepo = base.rutasDe(medida, a, { como: 'propio' });
    const lineas = ['Descartá lo del carril: vuelven a su base sólo estos archivos, y después se cierra el carril.'];
    for (const m of medida.avisos) lineas.push(`  ⚠ ${m}`);
    // un repo que no se pudo medir: lo anotado ahí queda como «no pude saber», nunca para borrar
    for (const repo of medida.sinMedir) {
      for (const f of [...(a.files || []), ...(a.rutas || [])]) {
        const rel = path.relative(repo, String(f));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) lineas.push(`  ⚠ no pude saber si ${path.join(repo, rel)} está en la base: miralo a mano antes de restaurarlo o borrarlo.`);
      }
    }
    const spawn = require('child_process').spawnSync;
    const gitEn = (args) => spawn('git', args, { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    const gitDe = (repo, args) => gitEn(['-C', repo, ...args]);
    const okDe = (r) => !r.error && r.status === 0;
    // las reglas de ignorar de la base, no las de hoy: el carril pudo cambiar un .gitignore. Sus .gitignore se copian a
    // una carpeta aparte, que hace de árbol del repo; las exclusiones del repo y de la máquina valen igual. Lo que git
    // sigue (está en el índice) no cuenta como ignorado. Devuelve true, false o null (no se pudo saber)
    const carpetas = [];
    const reglasDeLaBase = new Map();
    const ignoradoEnLaBase = (repo, sha, rel) => {
      if (!reglasDeLaBase.has(repo)) {
        let reglas = null;
        const gd = gitDe(repo, ['rev-parse', '--absolute-git-dir']);
        const ls = gitDe(repo, ['ls-tree', '-r', '-z', '--name-only', sha]);
        if (okDe(gd) && okDe(ls)) {
          const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'descartar-'));
          carpetas.push(dir);
          reglas = { gitDir: gd.stdout.trim(), dir };
          for (const f of ls.stdout.split('\0').filter((x) => x === '.gitignore' || x.endsWith('/.gitignore'))) {
            const b = gitDe(repo, ['cat-file', 'blob', `${sha}:${f}`]);
            if (!okDe(b)) { reglas = null; break; }
            fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
            fs.writeFileSync(path.join(dir, f), b.stdout);
          }
        }
        reglasDeLaBase.set(repo, reglas);
      }
      const reglas = reglasDeLaBase.get(repo);
      if (!reglas) return null;
      // «./» delante: un nombre que empieza con «:» no se lee como instrucción de git
      const ig = gitEn(['--git-dir', reglas.gitDir, '--work-tree', reglas.dir, '-C', reglas.dir, 'check-ignore', '-q', '--', `./${rel}`]);
      return ig.error || (ig.status !== 0 && ig.status !== 1) ? null : ig.status === 0;
    };
    // la ruta es un nombre, no un patrón: «src/[id].ts» no nombra src/i.ts
    const enElIndice = (repo, rel) => { const r = gitDe(repo, ['--literal-pathspecs', 'ls-files', '-z', '--', rel]); return okDe(r) ? r.stdout.split('\0').includes(rel) : null; };
    try {
      for (const repo of Object.keys(porRepo)) {
        const { sha } = medida.porRepo[repo].base;
        // un archivo movido entra con sus dos rutas: la de la base vuelve y la nueva, si la base no la tiene, se borra. La
        // ruta de la base sale del diff contra la base (movido dos veces, la medida trae la del medio)
        const delCarril = new Set(porRepo[repo]);
        const rels = new Set(delCarril);
        const movidos = [];
        for (const c of medida.porRepo[repo].cambios || []) if (c.vieja && (delCarril.has(c.ruta) || delCarril.has(c.vieja))) movidos.push([c.vieja, c.ruta]);
        if (sha) {
          const d = gitDe(repo, ['-c', 'core.quotepath=false', 'diff', '-z', '-M', '--name-status', sha, '--']);
          if (okDe(d)) {
            const t = d.stdout.split('\0');
            for (let i = 0; i < t.length - 2; i++) if (/^R\d*$/.test(t[i]) && (delCarril.has(t[i + 2]) || delCarril.has(t[i + 1]))) { movidos.push([t[i + 1], t[i + 2]]); i += 2; }
          }
        }
        for (const [vieja, nueva] of movidos) { rels.add(vieja); rels.add(nueva); }
        if (!rels.size) continue;
        // un movimiento que sólo cambia mayúsculas, en un disco que no las distingue: las dos rutas son el mismo archivo.
        // Se devuelve el nombre con git mv y después el contenido con el checkout; la ruta nueva no se borra
        const ignoraMayusculas = gitDe(repo, ['config', '--bool', 'core.ignorecase']).stdout.trim() === 'true';
        const deMayusculas = ignoraMayusculas ? movidos.filter(([v, n]) => v !== n && v.toLowerCase() === n.toLowerCase()) : [];
        for (const [, n] of deMayusculas) rels.delete(n);
        const enLaBase = [];
        const nuevos = [];
        const nuevosEnGit = [];
        const ignorados = [];
        const sinSaber = [];
        for (const rel of [...rels].sort()) {
          if (!sha) { sinSaber.push(rel); continue; }
          const r = gitDe(repo, ['--literal-pathspecs', 'ls-tree', '-z', '--name-only', sha, '--', rel]);
          if (!okDe(r)) { sinSaber.push(rel); continue; }
          if (r.stdout.split('\0').includes(rel)) { enLaBase.push(rel); continue; }
          // lo que git sigue se borra con git, para que no quede preparado y un commit lo vuelva a agregar
          const indice = enElIndice(repo, rel);
          if (indice === null) { sinSaber.push(rel); continue; }
          if (indice) { nuevosEnGit.push(rel); continue; }
          // lo que la base ignora no está en ella aunque existiera antes del carril (un .env): git no lo puede devolver
          const ig = ignoradoEnLaBase(repo, sha, rel);
          if (ig === null) sinSaber.push(rel);
          else (ig ? ignorados : nuevos).push(rel);
        }
        for (const [v, n] of deMayusculas) if (enLaBase.includes(v)) lineas.push(`  git -C ${citar(repo)} mv -f -- ${citar(n)} ${citar(v)}`);
        if (enLaBase.length) lineas.push(`  git -C ${citar(repo)} checkout ${citar(sha)} -- ${enLaBase.map((r) => citar(`:(literal)${r}`)).join(' ')}`);
        if (nuevos.length) lineas.push(`  archivos nuevos del carril, para borrar: ${nuevos.map((r) => citar(path.join(repo, r))).join(' ')}`);
        if (nuevosEnGit.length) lineas.push(`  git -C ${citar(repo)} rm -q -f -- ${nuevosEnGit.map((r) => citar(`:(literal)${r}`)).join(' ')}   # archivos nuevos del carril que git sigue, para borrar`);
        for (const rel of ignorados) lineas.push(`  ⚠ ${path.join(repo, rel)}: git lo ignora y no lo puede devolver (pudo existir antes del carril): no lo borres; deshacé a mano lo que le cambiaste.`);
        for (const rel of sinSaber) lineas.push(`  ⚠ no pude saber si ${path.join(repo, rel)} está en la base: miralo a mano antes de restaurarlo o borrarlo.`);
      }
    } finally {
      for (const dir of carpetas) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* una carpeta temporal que quedó */ } }
    }
    lineas.push(`  Después: node ${citar(MARKER_JS)} adhoc clear`);
    process.stdout.write([...new Set(lineas)].join('\n') + '\n');
    process.exit(0);
  }
  const ow = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const ss = require('./source-signals.js');
  const h = Array.isArray(f.hallazgos) && f.hallazgos[0];
  const { enUnRenglon } = require('./adhoc-screen.js');
  const r = ow.exigir({ firma: 'adhoc-lane:datos', argv: process.argv.slice(1),
    resumen: enUnRenglon(`dejar pasar el freno de los datos de la sesión ${estado.SID}${h ? `: ${ss.descripcion(h)}` : ''} · qué cambió: «${v.changed}» · la sesión recomienda pasar, porque «${v.why}»`),
    propia: PROPIA, anotar: anotarFirma });
  if (r.codigo !== 0) {
    console.error(`🔒 marker.js adhoc allow-data-change: una persona no lo dejó pasar — ${r.motivo}`);
    console.error('   Lo deja pasar sólo el click de una persona, en esta pestaña o en la de la coordinadora: pedíselo a ella con la pregunta que te da el freno, o en su terminal:');
    console.error(`     node ${citar(MARKER_JS)} adhoc allow-data-change --changed ${citar(v.changed)} --recommends pasar --why ${citar(v.why)} --terminal --for-session ${citar(estado.SID)}`);
    process.exit(r.codigo === 2 ? 2 : 1);
  }
  if (!['click', 'terminal'].includes(r.via)) {
    console.error(`🔒 marker.js adhoc allow-data-change: esto lo aprueba sólo el click de una persona o su terminal, y volvió por ${r.via}; no anoté nada.`);
    process.exit(1);
  }
  const at = nowIso();
  io.writeAdhoc(STATE_DIR, estado.SID, { ...a, datosPermitido: { huella: f.huella, hallazgos: (f.hallazgos || []).slice(0, 5), cambio: v.changed, recomienda: v.recommends, porque: v.why, via: r.via, by: r.sesion || estado.SID, at } });
  appendLog('adhoc.log', { kind: 'ADHOC_DATA_ALLOWED', huella: f.huella, senal: h ? h.id : null, archivo: h ? `${h.file}${h.line ? `:${h.line}` : ''}` : null,
    cambio: v.changed, recomienda: v.recommends, porque: v.why, via: r.via, by: r.sesion || estado.SID });
  process.stdout.write('adhoc: una persona dejó pasar este cambio de datos; guardá como siempre. Si el carril toca otra señal, frena de nuevo.\n');
  process.exit(0);
}

/**
 * `adhoc allow-foreign-save`: lo que sigue al freno de un guardado ajeno al carril (save-brake.js `guardadoAjeno`, que
 * anotó el pedido). Muestra entero lo que guarda y pide la firma `adhoc-lane:guardado-ajeno`, que aprueba sólo el click
 * de una persona (en esta pestaña o en la de la coordinadora) o su terminal. Con ella deja un permiso de un uso, atado a
 * la huella del pedido, por 30 minutos desde el click. Sin pedido anotado no pide nada.
 */
function cmdAdhocAllowForeignSave(io) {
  const args = process.argv.slice(4);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--terminal') continue;
    if (args[i] === '--for-session') { i++; continue; }
    console.error(`marker.js adhoc allow-foreign-save: no conozco «${String(args[i]).slice(0, 60)}». Uso: marker.js adhoc allow-foreign-save`);
    process.exit(2);
  }
  const a = io.readAdhoc(STATE_DIR, estado.SID);
  if (!a) { console.error('marker.js adhoc allow-foreign-save: no hay un camino corto abierto en esta sesión.'); process.exit(1); }
  const p = a.guardadoAjeno;
  if (!p || !p.huella) { console.error('marker.js adhoc allow-foreign-save: no hay un guardado ajeno frenado en este carril: lo anota el freno de guardar cuando frena. No pido nada.'); process.exit(1); }
  const fa = require('./adhoc-foreign-save.js');
  // la lista entera, antes del cuadro: el cuadro muestra hasta cinco nombres
  if (process.env[require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js')).PRECHEQUEO] !== '1') {
    process.stdout.write(['Lo que guarda, entero:', ...fa.lineasDe(p, { todo: true }).map((l) => `  ${l}`)].join('\n') + '\n');
  }
  const ow = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const { enUnRenglon } = require('./adhoc-screen.js');
  const r = ow.exigir({ firma: 'adhoc-lane:guardado-ajeno', argv: process.argv.slice(1),
    resumen: enUnRenglon(`dejar pasar una vez el guardado ajeno de la sesión ${estado.SID}: ${p.comando} en ${p.repo} (rama ${p.rama})`),
    propia: PROPIA, anotar: anotarFirma });
  if (r.codigo !== 0) {
    console.error(`🔒 marker.js adhoc allow-foreign-save: una persona no lo dejó pasar — ${r.motivo}`);
    console.error('   Lo deja pasar sólo el click de una persona, en esta pestaña o en la de la coordinadora, o en su terminal:');
    console.error(`     node ${citar(MARKER_JS)} adhoc allow-foreign-save --terminal --for-session ${citar(estado.SID)}`);
    process.exit(r.codigo === 2 ? 2 : 1);
  }
  if (!['click', 'terminal', 'delegacion'].includes(r.via)) {
    console.error(`🔒 marker.js adhoc allow-foreign-save: esto lo aprueba sólo el click de una persona o su terminal (o la coordinadora, si el perfil se lo delega), y volvió por ${r.via}; no anoté nada.`);
    process.exit(1);
  }
  // el click vale para el pedido que mostró el cuadro: si cambió mientras tanto, no se anota
  const ahora = io.readAdhoc(STATE_DIR, estado.SID);
  if (!ahora || !ahora.guardadoAjeno || ahora.guardadoAjeno.huella !== p.huella) {
    console.error('🔒 marker.js adhoc allow-foreign-save: el pedido cambió entre el cuadro y ahora; no anoté nada. Repetí el guardado y pedí el click de nuevo.');
    process.exit(1);
  }
  const at = nowIso();
  const permiso = { huella: p.huella, comando: p.comando, cwd: p.cwd, repo: p.repo, via: r.via, by: r.sesion || estado.SID, at };
  const f = fa.permisoPath(STATE_DIR, estado.SID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(permiso, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  appendLog('adhoc.log', { kind: 'ADHOC_FOREIGN_SAVE_ALLOWED', huella: p.huella, comando: p.comando, repo: p.repo, rama: p.rama, guarda: fa.lineasDe(p, { todo: true }), via: r.via, by: r.sesion || estado.SID });
  process.stdout.write(`adhoc: ${r.via === 'delegacion' ? 'la coordinadora, por delegación,' : 'una persona'} dejó pasar este guardado una vez. Repetí el mismo comando en los próximos 30 minutos, sin cambiar nada.\n`);
  process.exit(0);
}

function cmdAdhoc(sub, payloadJson) {
  if (sub === 'clear-orphan') return cmdAdhocClearOrphan(payloadJson);
  const io = require('./story-gate-io.js');
  if (sub === 'get') {
    const existing = io.readAdhoc(STATE_DIR, estado.SID);
    process.stdout.write(JSON.stringify(existing, null, 2) + '\n');
    process.exit(existing ? 0 : 1);
  }
  // `adhoc until HH:MM`: la hora a la que termina el arreglo rápido de esta sesión. No abre ni agranda el carril, así que
  // no pide firma; sin carril no hay dónde anotarla.
  if (sub === 'until') {
    const until = untilIso(payloadJson);
    if (!until) { console.error('marker.js adhoc until: va con una hora HH:MM (por ejemplo 19:30)'); process.exit(2); }
    const existing = io.readAdhoc(STATE_DIR, estado.SID);
    if (!existing) { console.error('marker.js adhoc until: esta sesión no tiene un arreglo rápido abierto: no hay dónde anotar la hora'); process.exit(1); }
    // `untilAt`: cuándo se declaró esta hora; una declaración nueva empieza su propia promesa, y una de hace rato es vieja
    io.writeAdhoc(STATE_DIR, estado.SID, { ...existing, until, untilAt: nowIso() });
    syncSessionState(estado.SID);
    avisarOficina();
    appendLog('adhoc.log', { kind: 'ADHOC_UNTIL', until });
    warnPastUntil('adhoc until', until);
    process.stdout.write(`adhoc: termina ${String(payloadJson).trim()}\n`);
    process.exit(0);
  }
  // `adhoc test -- <comando>`: corre las pruebas del camino corto y anota en el carril el final de la salida, la hora, el
  // código y la huella de lo que se probó (la de la medida única). No pide firma; el freno de guardar mide que la corrida
  // esté en verde y con la huella de hoy. Sale con el código del comando. Sin carril abierto, no corre nada.
  if (sub === 'test') {
    const i = process.argv.indexOf('--');
    const comando = i >= 0 ? process.argv.slice(i + 1) : [];
    if (!comando.length) { console.error('marker.js adhoc test: uso — adhoc test -- <comando de pruebas> (por ejemplo: adhoc test -- npm test -- src/combo)'); process.exit(2); }
    const a = io.readAdhoc(STATE_DIR, estado.SID);
    if (!a || !io.adhocFirmado(STATE_DIR, estado.SID, a)) {
      console.error('marker.js adhoc test: esta sesión no tiene un camino corto abierto: no corrí nada.');
      process.exit(2);
    }
    const adhocBase = require('./adhoc-base.js');
    // `--repo <Nombre>`: las pruebas de un repo del carril, en su carpeta. El nombre vale con las reglas de la lista (el
    // del repo de la sesión, o un hermano declarado en los dos sentidos) y tiene que ser un repo del carril
    const k = process.argv.indexOf('--repo');
    let repo = null;
    if (k >= 0 && (i < 0 || k < i)) {
      const r = require('./adhoc-list.js').repoDelCarril(a, process.argv[k + 1], { cwd: process.cwd() });
      if (r.problema) { console.error(`marker.js adhoc test --repo: ${r.problema}; no corrí nada.`); process.exit(2); }
      repo = r.raiz;
    }
    // la huella antes de correr: es lo que se probó, aunque las pruebas escriban algo
    const huella = adhocBase.huellaDelCarril(a);
    const huellaDelRepo = repo ? adhocBase.huellaDelCarril(a, undefined, { repo }) : null;
    // en Windows `npm`, `npx` o `yarn` son `.cmd` y sólo corren por la consola: ahí va con su shell, cada palabra citada
    const enWindows = process.platform === 'win32';
    const citarWin = (w) => (/[\s"&|<>^]/.test(w) ? `"${String(w).replace(/"/g, '""')}"` : w);
    const r = require('child_process').spawnSync(enWindows ? citarWin(comando[0]) : comando[0], enWindows ? comando.slice(1).map(citarWin) : comando.slice(1),
      { windowsHide: true, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, shell: enWindows, ...(repo ? { cwd: repo } : {}) });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    const codigo = r.error ? 127 : (r.status === null ? 1 : r.status);
    const salida = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`.slice(-4000);
    const pruebas = { comando: comando.join(' '), codigo, at: nowIso(), huella, salida };
    const ahora = io.readAdhoc(STATE_DIR, estado.SID) || a;
    // con `--repo`, la corrida de ese repo, con su huella; en un carril de un solo repo también vale como la general
    const conRepo = repo ? { pruebasPorRepo: { ...(ahora.pruebasPorRepo || {}), [repo]: { ...pruebas, huella: huellaDelRepo } } } : {};
    const unSoloRepo = !repo || adhocBase.reposDelCarril(ahora).length <= 1;
    if (!repo && adhocBase.reposDelCarril(ahora).length > 1) console.error('⚠ marker.js adhoc test: este camino corto es de varios repos: para guardar cuenta la corrida de cada repo con código, con --repo <Nombre>.');
    io.writeAdhoc(STATE_DIR, estado.SID, { ...ahora, ...(unSoloRepo ? { pruebas } : {}), ...conRepo });
    appendLog('adhoc.log', { kind: 'ADHOC_TEST', comando: pruebas.comando, codigo, huella, ...(repo ? { repo } : {}) });
    console.error(codigo === 0 ? 'marker.js adhoc test: en verde; anotado en el camino corto.' : `marker.js adhoc test: salió con ${codigo}; anotado: así no guarda.`);
    process.exit(codigo);
  }
  // `adhoc capture <imagen>`: la captura de la pantalla construida. No pide firma: no aprueba nada, y el freno de guardar
  // mide que sea posterior al último cambio.
  if (sub === 'capture') {
    if (!payloadJson) { console.error('marker.js adhoc capture: va con la ruta de la imagen'); process.exit(2); }
    const file = path.resolve(String(payloadJson));
    const existing = io.readAdhoc(STATE_DIR, estado.SID);
    if (!existing) { console.error('marker.js adhoc capture: esta sesión no tiene un arreglo rápido abierto: no hay dónde anotar la captura'); process.exit(1); }
    const problema = require('./adhoc-screen.js').problemaDeLaCaptura(file);
    if (problema) { console.error(`marker.js adhoc capture: ${problema}`); process.exit(2); }
    io.writeAdhoc(STATE_DIR, estado.SID, { ...existing, capture: { file, at: nowIso() } });
    appendLog('adhoc.log', { kind: 'ADHOC_CAPTURE', file });
    process.stdout.write(`adhoc: captura anotada ${file}\n`);
    process.exit(0);
  }
  // `adhoc ci-wait`: después de empujar el arreglo de un rojo de CI, la espera de la compilación del pedido con la punta
  // nueva; con verde, la espera cierra el arreglo (lib/pr-build-wait.js `--close-adhoc`). No pide firma
  if (sub === 'ci-wait') {
    const a = io.readAdhoc(STATE_DIR, estado.SID);
    if (!a || !a.ciRojo) { console.error('marker.js adhoc ci-wait: esta sesión no tiene abierto el arreglo de un rojo de CI.'); process.exit(2); }
    const pedidos = require('./ci-red-lane.js').esperaTrasEmpujar(a);
    if (!Array.isArray(pedidos)) { console.error(`marker.js adhoc ci-wait: ${(pedidos && pedidos.problema) || `no pude leer la punta de ${a.ciRojo.nombre}`}.`); process.exit(1); }
    const dir = path.join(STATE_DIR, 'pr-build-wait');
    fs.mkdirSync(dir, { recursive: true });
    const archivo = path.join(dir, `${estado.SID}-${Date.now()}.json`);
    fs.writeFileSync(archivo, JSON.stringify({ session: estado.SID, storyId: a.ciRojo.storyId || `pedido #${a.ciRojo.pedido}`, pedidos, closeAdhoc: true }), 'utf8');
    require('child_process').spawn(process.execPath, [path.join(SCRIPTS_DIR, 'lib', 'pr-build-wait.js'), '--file', archivo], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
    appendLog('gates.log', { name: 'ci-red-lane', status: 'wait', pedido: a.ciRojo.pedido, commit: pedidos[0].commit });
    console.error(`marker.js adhoc ci-wait: espero la compilación del pedido #${a.ciRojo.pedido} con ${pedidos[0].commit.slice(0, 12)}; con verde cierro el arreglo y aviso. El pedido no está listo hasta ese aviso.`);
    process.exit(0);
  }
  if (sub === 'allow-data-change') return cmdAdhocAllowDataChange(io);
  if (sub === 'allow-foreign-save') return cmdAdhocAllowForeignSave(io);
  if (sub === 'clear') {
    // sin mirar si venció: el que pasó el tope deja su cuenta aunque lleve horas sin tocarse
    let existing = io.readAdhoc(STATE_DIR, estado.SID);
    let ilegible = null;
    if (!existing) {
      try { existing = JSON.parse(fs.readFileSync(io.adhocPath(STATE_DIR, estado.SID), 'utf8')); } catch (e) {
        existing = null;
        if (e.code !== 'ENOENT') ilegible = `declaración ilegible: ${e.code || e.message}`;
      }
    }
    require('./adhoc-foreign-save.js').borrarPermiso(STATE_DIR, estado.SID);
    try { fs.unlinkSync(io.adhocPath(STATE_DIR, estado.SID)); } catch (e) {
      // sólo «no existe» es estar cerrado: otro error deja el atajo abierto, y eso se dice
      if (e.code !== 'ENOENT') { console.error(`marker.js adhoc clear: no pude borrar la declaración (${e.code || e.message}); el arreglo rápido sigue abierto.`); process.exit(1); }
    }
    avisarOficina();
    // el arreglo que pasó el tope deja lo que contó: es lo que mide si elegirlo valió la pena
    let contados = {};
    if (existing && existing.sobreCupo) {
      try {
        const c = require('./adhoc-base.js').cuentaDelCarril(existing);
        contados = { sobreCupo: true, cupoPedido: existing.cupoPedido, eligio: existing.eligio, contados: c.archivos.length, archivos: c.archivos, ...(c.avisos.length ? { medidoConMenos: c.avisos } : {}), ...(c.fallas.length ? { sinMedir: c.fallas[0] } : {}) };
      } catch (e) { contados = { sobreCupo: true, cupoPedido: existing.cupoPedido, eligio: existing.eligio, sinMedir: e.message }; }
    }
    if (ilegible) contados = { sinMedir: ilegible };
    appendLog('adhoc.log', { kind: 'ADHOC_CLEAR', reason: existing ? existing.reason : null, files: existing ? (existing.files || []).length : 0, ...contados });
    syncSessionState(estado.SID);
    process.stdout.write('adhoc: cleared\n');
    process.exit(0);
  }
  if (sub === 'set') {
    let payload;
    const porBanderas = String(payloadJson || '').startsWith('--');
    if (porBanderas) {
      const p = require('./adhoc-screen.js').pedidoPorBanderas(process.argv.slice(4));
      if (p.problema) {
        console.error(`marker.js adhoc set: ${p.problema}.`);
        console.error('  Uso: marker.js adhoc set --reason "<qué y por qué>" [--max-files N] --data sin-cambio|cambian --file <ruta> [--file <ruta> …] --terminal --for-session <id>');
        process.exit(2);
      }
      payload = p.payload;
    } else {
      try { payload = JSON.parse(payloadJson || ''); } catch (err) {
        console.error('marker.js adhoc set: payload JSON inválido —', err.message);
        console.error('  Uso: marker.js adhoc set \'{"reason":"<qué y por qué>","maxFiles":<N>}\'');
        process.exit(2);
      }
    }
    const reason = String((payload && payload.reason) || '').trim();
    if (reason.length < 8) {
      console.error('marker.js adhoc set: "reason" requerido (≥8 caracteres): qué se arregla y por qué, para que la persona lo lea en la ventana.');
      process.exit(2);
    }
    // la ventana y la terminal muestran el motivo hasta 200 caracteres y el cupo: lo que se guarda es lo que el dueño ve
    if (reason.length > ADHOC_MOTIVO_MAX) {
      console.error(`marker.js adhoc set: "reason" de hasta ${ADHOC_MOTIVO_MAX} caracteres: la ventana no muestra más, y la persona firmaría un recorte.`);
      process.exit(2);
    }
    // el motivo en un renglón, firme quien firme: antes de `exigir`, así también lo mira el chequeo previo de la ventana
    const LISTA = require('./adhoc-list.js');
    // los rechazos de la lista en los dos perfiles: en un producto hablan de vos; sin poder leer el repo, el del arnés
    // se lee recién al rechazar: leerlo avisa cuando el arnés no está instalado, y un pedido que pasa no lo necesita
    let perfilDelArnes;
    const enElArnes = () => {
      if (perfilDelArnes === undefined) { try { perfilDelArnes = io.isHarnessRepo(path.join(process.cwd(), '.')) !== false; } catch (_) { perfilDelArnes = true; } }
      return perfilDelArnes;
    };
    const malMotivo = /[\r\n]/.test(reason) ? LISTA.problemaDelMotivo(reason, { harness: enElArnes() }) : null;
    if (malMotivo) {
      console.error(`marker.js adhoc set: ${malMotivo}.`);
      process.exit(2);
    }
    if (payload.maxFiles !== undefined && !(Number.isInteger(payload.maxFiles) && payload.maxFiles >= 1 && payload.maxFiles <= ADHOC_CUPO_MAX)) {
      console.error(`marker.js adhoc set: "maxFiles" es un número entero de 1 a ${ADHOC_CUPO_MAX}.`);
      process.exit(2);
    }
    // la maqueta y quién la aprobó van juntas, y la firma de este comando las cubre: la ventana muestra las dos
    let maqueta = null;
    if (payload.mockup !== undefined || payload.mockupApproved !== undefined) {
      const approval = String(payload.mockupApproved || '').trim();
      if (!String(payload.mockup || '').trim() || !approval) {
        console.error('marker.js adhoc set: "mockup" y "mockupApproved" van juntos: la ruta de la maqueta y quién la aprobó y por qué vía.');
        process.exit(2);
      }
      if (approval.length > ADHOC_MOTIVO_MAX) {
        console.error(`marker.js adhoc set: "mockupApproved" de hasta ${ADHOC_MOTIVO_MAX} caracteres: la ventana no muestra más.`);
        process.exit(2);
      }
      const file = path.resolve(String(payload.mockup));
      const m = require('./adhoc-screen.js').problemaDeLaMaqueta(file);
      if (m.problema) { console.error(`marker.js adhoc set: ${m.problema}`); process.exit(2); }
      maqueta = { file, sha256: m.sha256, approval };
    }
    // la sesión destino: la de --for-session (la designada declara por otra pestaña, o el dueño desde su terminal), o la propia
    const k = process.argv.indexOf('--for-session');
    const pedida = k >= 0 ? process.argv[k + 1] : null;
    if (k >= 0 && !/^[\w-]+$/.test(String(pedida || ''))) {
      console.error('marker.js adhoc set: --for-session necesita el id de la sesión destino.');
      process.exit(2);
    }
    const destino = pedida || estado.SID;
    if (destino === '_nosession') {
      console.error('marker.js adhoc set: sin sesión no sé a qué pestaña abrirle el arreglo rápido: --terminal --for-session <id de la sesión>.');
      process.exit(2);
    }
    // un tope menor que los archivos ya tocados deja el arreglo trabado: se frena antes de pedir la firma (también en el
    // chequeo previo de la ventana), con el número de archivos tocados
    const actual = io.readAdhoc(STATE_DIR, destino);
    // ¿cambia de dónde salen los datos o quién los ve? Lo responde la sesión al abrir; un carril abierto conserva lo que
    // tenía, y uno de antes sigue sin la respuesta. «cambian» no es camino corto: no abre, y no cambia uno abierto
    if (payload.datos !== undefined && !DATOS_VALORES.includes(payload.datos)) {
      console.error(`marker.js adhoc set: "datos" es ${DATOS_VALORES.map((v) => `"${v}"`).join(' o ')}: si el cambio cambia de dónde sale un dato o quién lo puede ver (permisos, roles, la seguridad de un proceso).`);
      process.exit(2);
    }
    if (payload.datos === undefined && !actual) {
      console.error('marker.js adhoc set: falta "datos": ¿el cambio cambia de dónde sale un dato o quién lo puede ver (permisos, roles, la seguridad de un proceso)?');
      console.error(`  "datos": "sin-cambio" si no; "datos": "cambian" si sí, y entonces va por historia. Con banderas: --data ${DATOS_VALORES.join('|')}.`);
      process.exit(2);
    }
    if (payload.datos === 'cambian') {
      console.error('🔒 marker.js adhoc set: esto va por historia, aunque sea corta: un cambio que cambia de dónde sale un dato o quién lo puede ver no es camino corto. Ante la duda, historia.');
      if (actual) console.error(`  No cambié el arreglo rápido abierto: cerralo con node ${citar(MARKER_JS)} adhoc clear (lo tocado queda en la copia de trabajo, sin guardar) y escribí la historia.`);
      console.error('  La historia se escribe con la skill tycon-create-story.');
      process.exit(3);
    }
    // suman los de implementación: la lista cruda trae también pruebas y sondas de la consola
    const tocados = actual ? io.archivosQueSuman(actual.files || [], actual).length : 0;
    if (actual && payload.maxFiles !== undefined && payload.maxFiles < tocados) {
      console.error(`marker.js adhoc set: el arreglo rápido de la sesión ${destino} ya tocó ${tocados} archivos: un tope de ${payload.maxFiles} lo dejaría trabado. Pedí ${tocados} o más, o cerralo con \`adhoc clear\` y abrí uno nuevo.`);
      process.exit(2);
    }
    const ow = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
    // los topes del camino corto de la organización, leídos una vez: la firma, el cupo y los textos dicen el mismo número
    const topes = io.topesDelCaminoCorto({ stateDir: STATE_DIR, sessionId: destino });
    // la lista de archivos: todo camino corto la lleva, cerrada, y se valida antes de pedir la firma
    // pedida para otra sesión (la coordinadora desde su carpeta, o la terminal de una persona con --for-session), la
    // lista va relativa a la carpeta de trabajo de la sesión destino, nunca a la del proceso; la propia sesión, a la suya
    const deOtraSesion = !!pedida && pedida !== PROPIA;
    // `--repo <carpeta>`: la carpeta de la lista dicha, para que la terminal de la persona pueda estar en cualquier otra
    // (@story-8.319, AC 8)
    const repoPedido = (() => { const i = process.argv.indexOf('--repo'); return i >= 0 ? process.argv[i + 1] : null; })();
    if (repoPedido !== null) {
      let esCarpeta = false;
      try { esCarpeta = !!repoPedido && fs.statSync(path.resolve(repoPedido)).isDirectory(); } catch (_) { esCarpeta = false; }
      if (!esCarpeta) {
        console.error(`marker.js adhoc set: --repo «${String(repoPedido).slice(0, 200)}» no es una carpeta: no declaré nada.`);
        process.exit(2);
      }
    }
    // la carpeta de la sesión destino, si todavía es una carpeta: una borrada no se reemplaza por la del proceso
    // (la que ya no se puede abrir se nombra en el mensaje, para que se sepa por qué frena)
    let carpetaQueNoEs = null;
    const deLaSesion = () => {
      const c = LISTA.carpetaDeLaSesion({ casa: os.homedir(), sesion: pedida });
      if (!c) return null;
      let es = false;
      try { es = fs.statSync(c).isDirectory(); } catch (_) { es = false; }
      if (!es) carpetaQueNoEs = c;
      return es ? c : null;
    };
    const base = repoPedido ? path.resolve(repoPedido) : deOtraSesion ? deLaSesion() : process.cwd();
    const conRelativas = Array.isArray(payload.allowedFiles) && payload.allowedFiles.some((f) => typeof f === 'string' && f.trim() && !path.isAbsolute(f.trim()) && !/^[A-Za-z]:[\\/]/.test(f.trim()));
    if (!base && conRelativas) {
      const porque = carpetaQueNoEs ? ` (la última que usó, ${String(carpetaQueNoEs).slice(0, 200)}, ya no es una carpeta que se pueda abrir)` : '';
      console.error(`marker.js adhoc set: no sé la carpeta de la sesión ${pedida}${porque}: que lo pida esa sesión, o pedilo con --repo <carpeta> (la carpeta de trabajo de esa sesión).`);
      process.exit(2);
    }
    const carpetaDeLaLista = base || process.cwd();
    const pedidaLista = LISTA.normalizar(payload.allowedFiles, { cwd: carpetaDeLaLista });
    if (pedidaLista.problema) {
      console.error(`marker.js adhoc set: ${LISTA.rechazoDeLaLista(pedidaLista.problema, { harness: enElArnes() })}`);
      process.exit(2);
    }
    const allowedFiles = pedidaLista.lista;
    // una lista fuera de todo repo casi siempre es un pedido desde otra carpeta: cada edición real va a frenar
    if (pedidaLista.sinRepo && pedidaLista.sinRepo.length) {
      console.error(`⚠️  marker.js adhoc set: ${pedidaLista.sinRepo.length} archivo(s) de la lista no caen dentro de ningún repo desde ${carpetaDeLaLista}: ${pedidaLista.sinRepo.slice(0, 5).join(', ')}. Si no es lo que querías, pedila de nuevo desde la carpeta del repo.`);
    }
    const deCodigo = LISTA.contar(allowedFiles).codigo;
    if (payload.maxFiles !== undefined && deCodigo > payload.maxFiles) {
      console.error(`marker.js adhoc set: la lista nombra ${deCodigo} archivos de código y pedís un cupo de ${payload.maxFiles}: achicá la lista o pedí un cupo mayor.`);
      process.exit(2);
    }
    if (deCodigo > ADHOC_CUPO_MAX) {
      console.error(`marker.js adhoc set: la lista nombra ${deCodigo} archivos de código; el camino corto llega hasta ${ADHOC_CUPO_MAX}: esto va por historia.`);
      process.exit(2);
    }
    // una lista con más código que el tope de la organización es pasar el tope: el cupo sube a lo que nombra la lista
    if (payload.maxFiles === undefined && deCodigo > topes.maximo) payload.maxFiles = deCodigo;
    const cupoDeLaLista = payload.maxFiles !== undefined ? payload.maxFiles : (actual ? actual.maxFiles : topes.maximo);
    const malosTopes = LISTA.problemaDeTopes(allowedFiles, cupoDeLaLista);
    if (malosTopes) {
      console.error(`marker.js adhoc set: ${LISTA.rechazoDeLaLista(malosTopes, { harness: enElArnes() })}`);
      process.exit(2);
    }
    // cada entrada como se pide: la de un repo hermano con su nombre adelante (`B/src/a.cs`), nunca con «..»
    const relLista = allowedFiles.map((f) => LISTA.relDeLaLista(f, carpetaDeLaLista, pedidaLista.hermanos));
    // los repos de la lista y cuántos archivos de cada uno, para el resumen que lee quien firma. Varios repos se aprueban
    // como uno: los hermanos salen del grupo declarado (repo_group, en los dos sentidos) y la sesión no pregunta
    const RG = require('./repo-group.js');
    const reposDeLaLista = LISTA.reposDeLaLista(allowedFiles);
    const variosRepos = reposDeLaLista.length > 1;
    const nombreDelRepo = (raiz) => pedidaLista.hermanos.get(raiz) || path.basename(RG.checkoutPrincipal(raiz) || raiz);
    const enRepos = variosRepos ? ` en ${reposDeLaLista.length} repos: ${reposDeLaLista.map((r) => `${nombreDelRepo(r)} (${allowedFiles.filter((f) => f.startsWith(r + path.sep)).length})`).join(', ')}` : '';
    // otra sesión viva en el checkout de un hermano: dos sesiones no editan el mismo archivo sin saberlo
    for (const raiz of pedidaLista.hermanos.keys()) {
      let vivas = [];
      try { vivas = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'live-sessions.js')).others({ root: raiz, selfSessionId: destino, home: os.homedir() }).sessions; } catch (_) { vivas = []; }
      if (vivas.length) {
        const v = vivas[0];
        console.error(`marker.js adhoc set: la sesión ${v.id} está viva en ${nombreDelRepo(raiz)} (${raiz})${v.min != null ? `, anduvo hace ${v.min} min` : ''}${v.why ? ` (${v.why})` : ''}: cerrala o esperá a que termine, y pedí el arreglo de nuevo.`);
        process.exit(2);
      }
    }
    // una ruta de riesgo alto en la lista: la firma de una persona lo dice, y sin una persona no se abre
    const riesgoDeLaLista = LISTA.riesgoDeLaLista(allowedFiles);
    // adelante en el resumen: se corta a los 200 caracteres, y el riesgo alto es lo primero que tiene que leer quien firma
    const conRiesgo = riesgoDeLaLista ? `${LISTA.textoDelRiesgo(riesgoDeLaLista)} · ` : '';
    const renglon = require('./adhoc-screen.js').enUnRenglon;
    console.error(`marker.js adhoc set: la lista (${allowedFiles.length} archivos): ${relLista.map(renglon).join(', ')}`);
    // en la terminal el dueño ve este resumen: el motivo y el cupo, como en la ventana
    const cupoPedido = payload.maxFiles !== undefined ? `hasta ${payload.maxFiles} archivos de implementación, sin pruebas ni guías` : `el cupo de la organización (${topes.maximo} archivos de implementación, o el que ya tenía)`;
    // el arreglo de un rojo de CI (lib/ci-red-lane.js): se valida más abajo, con la firma que pide el comando
    let ciRojo = null;
    // por delegación, el dueño se entera antes de la constancia, por los canales del perfil: sin entrega, no hay arreglo
    const antes = (viaPedida, registro) => {
      // «hecho y avisado» (pestaña sin permisos) cuenta como delegado: tampoco lo leyó una persona
      if (viaPedida !== 'delegacion' && viaPedida !== 'avisado' && !(registro && registro.via === 'avisado')) return null;
      // lo que no abre nadie más que una persona, antes del aviso: una ruta de riesgo alto, varios temas o un motivo vago
      if (riesgoDeLaLista) {
        const quien = enElArnes() ? 'no lo abre la coordinadora por delegación: lo abre una persona' : 'lo abrís vos, en tu ventana';
        return { codigo: 1, motivo: `la lista nombra una ruta de ${LISTA.textoDelRiesgo(riesgoDeLaLista)}: un camino corto de riesgo alto ${quien}` };
      }
      const sinPersona = LISTA.sinUnaPersona({ reason }) ? LISTA.sinUnaPersona({ reason, harness: enElArnes() }) : null;
      if (sinPersona) return { codigo: 1, motivo: sinPersona };
      // ampliar por delegación: la lista nueva contiene entera la firmada (una firmada con `d:` la contiene `D:`)
      const faltan = actual && Array.isArray(actual.allowedFiles) ? LISTA.faltanEnLaNueva(actual.allowedFiles, allowedFiles) : [];
      if (faltan.length) return { codigo: 1, motivo: LISTA.textoDeAmpliar(faltan.map((f) => LISTA.relDeLaLista(f, carpetaDeLaLista, pedidaLista.hermanos)), { harness: enElArnes() }) };
      // un solo carril delegado por repo: dos a la vez se pisan las cuentas
      const mios = new Set(allowedFiles.map(LISTA.raizDe).filter(Boolean));
      let otros = [];
      try { otros = fs.readdirSync(path.join(STATE_DIR, 'adhoc')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch (e) {
        // sin la carpeta no hay otros carriles; una que no se lee no deja saber si ya hay uno delegado en el repo
        if (!e || e.code !== 'ENOENT') return { codigo: 1, motivo: `no pude leer los otros caminos cortos de la máquina (${String(e && e.message || e).split('\n')[0]}): sin saber si ya hay uno delegado en este repo, no se abre por delegación` };
      }
      for (const sid of otros) {
        if (sid === destino) continue;
        const o = io.readAdhoc(STATE_DIR, sid);
        if (!o || (o.via !== 'delegacion' && o.via !== 'avisado') || !Array.isArray(o.allowedFiles)) continue;
        const comun = o.allowedFiles.map(LISTA.raizDe).find((r) => r && mios.has(r));
        if (comun) return { codigo: 1, motivo: LISTA.textoOtroCarril(sid, comun, { harness: enElArnes() }) };
      }
      const so = require('./save-ok.js');
      const notify = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'notify.js'));
      const cupo = cupoAlDeclarar({ pedido: payload.maxFiles, existing: actual, via: viaPedida, topes, sobreCupo: firmas.firmaDelPedidoAdhoc(process.argv.slice(4), topes.maximo, { cwd: carpetaDeLaLista }) === firmas.SOBRE_CUPO && viaPedida === 'delegacion' });
      // el de una pestaña sin permisos lo abrió la propia sesión, sin firma: «hecho y avisado»
      const quien = registro && registro.via === 'avisado' ? `la sesión ${registro.sesion} abrió sin firma (pestaña sin permisos)` : 'la coordinadora abrió';
      const delRojo = ciRojo ? ` Es el arreglo del rojo de CI del pedido #${ciRojo.pedido} (${ciRojo.nombre}), control «${ciRojo.control}», sin plan ni revisores: ${relLista.join(', ')}.` : '';
      const a = so.avisar({ texto: `Arreglo rápido: ${quien} el de la sesión ${destino}: «${reason}» · hasta ${ciRojo ? firmas.TOPE_CI_ROJO : cupo} archivos, sin tocar lo sensible.${delRojo}`,
        canales: () => notify.canalesDeLaSesion(), mandar: (o) => notify.avisar(o) });
      return a.ok ? null : { codigo: 1, motivo: `sin aviso a la persona, la coordinadora no abre el arreglo rápido (${a.motivo})` };
    };
    // la maqueta va antes del motivo: el resumen se corta a los 200 caracteres, y lo que se aprueba de nuevo es ella. Entero
    // queda en la terminal, antes de la firma, y en adhoc.log
    const datosDelCarril = payload.datos || (actual && actual.datos) || null;
    const conMaqueta = `${maqueta ? `, maqueta ${maqueta.file} aprobada por «${maqueta.approval}»` : ''}${DATOS_TEXTO[datosDelCarril] ? `, ${DATOS_TEXTO[datosDelCarril]}` : ''}`;
    // lo lee quien firma: sin saltos de línea ni escapes que armen renglones falsos
    const { enUnRenglon } = require('./adhoc-screen.js');
    if (maqueta) console.error(`marker.js adhoc set: anota la maqueta ${enUnRenglon(maqueta.file)}, aprobada por «${enUnRenglon(maqueta.approval)}», con el motivo «${enUnRenglon(reason)}».`);
    const firmas = require(path.join(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'signatures.js'));
    // la misma regla que mira el freno: pasar el tope es otra firma
    const firmaDelPedido = firmas.firmaDelPedidoAdhoc(process.argv.slice(4), topes.maximo, { cwd: carpetaDeLaLista });
    // el arreglo de un rojo de CI: sólo sobre el pedido en rojo de esta sesión, dentro de su repo y su tope, sin lo sensible
    if (payload.ciRojo !== undefined) {
      // sobre un arreglo común abierto heredaría su lista y su tope: se cierra uno y se abre el otro
      // la firma del rojo se calcula de las banderas: en JSON siempre sería otra, y el tope no diría por qué
      if (!String(process.argv[4] || '').startsWith('--')) {
        console.error('marker.js adhoc set: el arreglo de un rojo de CI se pide con banderas (--ci-red <pedido> --check "<control>" --reason … --data … --file …), no en JSON.');
        process.exit(2);
      }
      if (actual && !actual.ciRojo) {
        console.error('marker.js adhoc set: esta sesión tiene abierto un arreglo rápido común; el arreglo de un rojo de CI no se abre encima. Cerralo (marker.js adhoc clear) y pedí el del rojo.');
        process.exit(2);
      }
      if (firmaDelPedido !== firmas.CI_ROJO) {
        console.error(`marker.js adhoc set: la lista nombra más de ${firmas.TOPE_CI_ROJO} archivos, pruebas incluidas: el arreglo de un rojo de CI llega hasta ahí; lo demás va por el camino corto de siempre o por una historia.`);
        process.exit(2);
      }
      const v = require('./ci-red-lane.js').validarApertura({ stateDir: STATE_DIR, sesion: destino, pedido: payload.ciRojo, control: payload.control, allowedFiles, tope: firmas.TOPE_CI_ROJO });
      if (v.problema) { console.error(`marker.js adhoc set: ${v.problema}.`); process.exit(2); }
      ciRojo = v.ciRojo;
    } else if (actual && actual.ciRojo) {
      // agrandar el arreglo de un rojo con un pedido común le sacaría los revisores con otra firma: no se mezcla
      console.error(`marker.js adhoc set: esta sesión tiene abierto el arreglo del rojo de CI del pedido #${actual.ciRojo.pedido}, sin revisores; un arreglo común no se le suma. Cerralo (marker.js adhoc clear) y abrí el que necesites.`);
      process.exit(2);
    }
    const enLaLista = `${allowedFiles.length} archivo${allowedFiles.length === 1 ? '' : 's'} (${relLista.slice(0, 2).join(', ')}${relLista.length > 2 ? ', …' : ''})`;
    const delRojo = ciRojo ? `arreglo del rojo de CI del pedido #${ciRojo.pedido} (${ciRojo.nombre}${ciRojo.etapa ? `, falló «${ciRojo.etapa}»` : ''}), control «${ciRojo.control}», sin plan ni revisores, de la sesión ${destino}` : null;
    const r = ow.exigir({ firma: firmaDelPedido, argv: process.argv.slice(1), resumen: enUnRenglon(delRojo ? `${conRiesgo}${delRojo}: «${reason}» · ${enLaLista} · hasta ${firmas.TOPE_CI_ROJO} archivos, pruebas incluidas`
      : `${conRiesgo}arreglo rápido de la sesión ${destino}${enRepos}${conMaqueta}: «${reason}» · ${enLaLista} · ${cupoPedido}`),
      propia: PROPIA, anotar: anotarFirma, antes });
    if (r.codigo !== 0) {
      // la forma con JSON sólo si hace falta: la maqueta no entra en la otra, y hay motivos que no se pueden citar en ella
      const screen = require('./adhoc-screen.js');
      const sinJson = screen.motivoSeCita(reason) && (porBanderas || (!maqueta && require('./runtime-waiver.js').esWindows()));
      const pedidoEnJson = porBanderas ? JSON.stringify(payload) : String(payloadJson);
      const conLista = relLista.map((f) => ` --file ${/^[\w./-]+$/.test(f) ? f : `"${f}"`}`).join('');
      // el arreglo de un rojo de CI va sólo con banderas: su pedido y su control, siempre
      const delRojoEnTerminal = ciRojo ? `--ci-red ${ciRojo.pedido} --check "${ciRojo.control.replace(/"/g, '')}" ` : '';
      const pedidoEnTerminal = sinJson || ciRojo ? `${delRojoEnTerminal}--reason "${reason}"${payload.maxFiles !== undefined ? ` --max-files ${payload.maxFiles}` : ''}${payload.datos ? ` --data ${payload.datos}` : ''}${conLista}` : `'${pedidoEnJson.replace(/'/g, "'\\''")}'`;
      console.error(`🔒 marker.js adhoc set: la persona no lo aprobó — ${r.motivo}`);
      console.error('   El arreglo rápido lo aprueba una persona, no el agente: en la ventana de permiso, corriendo este comando solo y en su forma');
      console.error('   exacta (la ventana le muestra el motivo y el cupo), o en su terminal:');
      // con la carpeta en --repo: la lista va relativa a ella, y la terminal de la persona puede estar en otra (o en otro
      // repo). Sin `cd … &&`, que Windows PowerShell 5.1 no tiene, y con la ruta estable de marker.js (@story-8.319, AC 8)
      const repoEnTerminal = /["$`%\r\n]/.test(carpetaDeLaLista) ? citar(carpetaDeLaLista) : `"${carpetaDeLaLista}"`;
      console.error(`     ${require('./open-runs.js').markerEstable(os.homedir())} adhoc set ${pedidoEnTerminal} --terminal --for-session ${destino} --repo ${repoEnTerminal}`);
      console.error('   Si la persona no lo pidió, preguntale en castellano llano si lo quiere como ajuste puntual o con story.');
      process.exit(r.codigo === 2 ? 2 : 1);
    }
    // una vía que este guion no conoce no se cuenta como ventana: no se declara
    if (!['delegacion', 'avisado', 'terminal', 'ventana', 'click', 'mensaje'].includes(r.via)) {
      console.error(`🔒 marker.js adhoc set: la firma volvió por una vía que no conozco (${r.via}); no declaré nada.`);
      process.exit(1);
    }
    // pasar el tope lo elige el dueño, con su click o su terminal: nunca la delegación
    if (firmaDelPedido === firmas.SOBRE_CUPO && !['click', 'terminal'].includes(r.via)) {
      console.error(`🔒 marker.js adhoc set: pasar el tope lo aprueba sólo el click de la persona o su terminal, nunca la delegación, y volvió por ${r.via}; no declaré nada.`);
      process.exit(1);
    }
    const via = r.via;
    const by = r.sesion || estado.SID;
    const existing = io.readAdhoc(STATE_DIR, destino);
    const pedido = payload.maxFiles !== undefined ? payload.maxFiles : (existing ? existing.maxFiles : topes.maximo);
    const maxFiles = ciRojo ? firmas.TOPE_CI_ROJO : cupoAlDeclarar({ pedido: payload.maxFiles, existing, via, topes, sobreCupo: firmaDelPedido === firmas.SOBRE_CUPO });
    // la marca del sobre cupo: la pone la firma nueva y se conserva mientras el cupo siga por encima del tope. Un carril
    // anterior con más que el tope no la tiene: termina con su número, sin pedirla
    const sobreCupo = firmaDelPedido === firmas.SOBRE_CUPO ? { sobreCupo: true, cupoPedido: maxFiles, eligio: via === 'delegacion' ? 'coordinadora' : 'persona' }
      : existing && existing.sobreCupo && maxFiles > topes.maximo ? { sobreCupo: true, cupoPedido: existing.cupoPedido, eligio: existing.eligio } : {};
    const obj = {
      reason, maxFiles,
      // la lista cerrada de archivos: el portón y el freno de guardar no dejan pasar lo que no nombra
      allowedFiles,
      files: existing ? (existing.files || []) : [],
      declaredAt: existing ? existing.declaredAt : nowIso(),
      lastTouch: nowIso(),
      cwd: process.cwd(),
      via, by,
      ...sobreCupo,
      // la hora de la firma: el portón acepta la declaración sólo con el renglón `-signed` de su firma, de esta hora
      firmadaEn: nowIso(),
      // la hora de fin que declaró la sesión con `adhoc until` sigue valiendo al agrandar el carril
      ...(existing && existing.until ? { until: existing.until } : {}),
      // la maqueta aprobada y la captura también: el freno de guardar mide si siguen valiendo
      ...(maqueta ? { mockup: { ...maqueta, at: nowIso() } } : (existing && existing.mockup ? { mockup: existing.mockup } : {})),
      ...(existing && existing.capture ? { capture: existing.capture } : {}),
      // y la base: anotar la maqueta no achica lo que se mide de la rama
      ...(existing && existing.bases ? { bases: existing.bases } : {}),
      // la respuesta sobre los datos, y lo que anotó el freno de los datos y el click del dueño que lo dejó pasar
      ...(payload.datos ? { datos: payload.datos } : existing && existing.datos ? { datos: existing.datos } : {}),
      ...(existing && existing.frenoDatos ? { frenoDatos: existing.frenoDatos } : {}),
      ...(existing && existing.datosPermitido ? { datosPermitido: existing.datosPermitido } : {}),
      ...(existing && existing.untilAt ? { untilAt: existing.untilAt } : {}),
      // el arreglo de un rojo de CI: el pedido, el control que falló y la punta desde la que se mide
      ...(ciRojo ? { ciRojo } : {}),
      // las rutas anotadas, la marca de riesgo y las constancias, con el motivo que sea: valen por su huella, y declarar
      // el carril de nuevo no las vence
      ...(existing ? Object.fromEntries(['rutas', 'riesgoAlto', 'revisoresEsperados', 'revisores', 'pase', 'pruebas', 'pruebasPorRepo']
        .filter((k) => existing[k] !== undefined).map((k) => [k, existing[k]])) : {}),
    };
    // abrir trae la base de cada repo de la lista, como el primer toque: sin red abre igual, con la base «sin traer» y el
    // aviso. Un repo que ya tiene la suya la conserva. La base se anota con la raíz de git, la misma con que la busca la
    // medida al guardar (la de la lista lleva la letra de unidad en mayúscula y git puede devolverla en minúscula)
    const adhocBase = require('./adhoc-base.js');
    for (const repo of [...new Set(allowedFiles.map(adhocBase.raizDe).filter(Boolean))]) {
      const b = adhocBase.conBase(obj, repo);
      if (b.adhoc.bases) obj.bases = b.adhoc.bases;
      if (b.aviso) console.error(`⚠ ${b.aviso}`);
    }
    io.writeAdhoc(STATE_DIR, destino, obj);
    // declarar el carril de nuevo no conserva el pedido ni el permiso de un guardado ajeno
    require('./adhoc-foreign-save.js').borrarPermiso(STATE_DIR, destino);
    syncSessionState(destino);
    avisarOficina(destino);
    // el portón de edición apagado no apaga la firma; queda igual en bypass.log, que la revisión de la noche cuenta
    const gateOn = String(process.env.TYCON_STORY_GATE || '').toLowerCase() !== 'off';
    const maquina = r.registro && r.registro.maquina ? r.registro.maquina : null;
    appendLog('adhoc.log', { kind: existing ? 'ADHOC_UPDATE' : 'ADHOC_SET', reason, maxFiles, prevMaxFiles: existing ? existing.maxFiles : null,
      files: obj.files.length, cwd: process.cwd(), via, by, destino, ...sobreCupo, ...(maquina ? { maquina } : {}), ...(gateOn ? {} : { gate: 'off' }),
      ...(maqueta ? { mockup: maqueta.file, mockupApproved: maqueta.approval } : {}), ...(obj.datos ? { datos: obj.datos } : {}), allowedFiles,
      ...(ciRojo ? { ciRojo: { pedido: ciRojo.pedido, control: ciRojo.control, repo: ciRojo.nombre } } : {}) });
    // el arreglo de un rojo de CI queda también entre las firmas, con su pedido, su control y sus archivos
    if (ciRojo) appendLog('gates.log', { name: 'ci-red-lane', status: 'open', pedido: ciRojo.pedido, control: ciRojo.control, repo: ciRojo.nombre, via, files: relLista });
    if (!gateOn) appendLog('bypass.log', { kind: 'STORY_GATE_OFF_ADHOC', reason, cwd: process.cwd() });
    if (maxFiles < pedido) {
      const antes = Number(payload.maxFiles) > 0 ? `pediste ${pedido}` : `tenía ${pedido}`;
      console.error(`⚠ marker.js adhoc set: por la delegación el cupo queda en hasta ${maxFiles} archivos (${antes}); uno mayor lo aprueba una persona en su ventana.`);
    }
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
    // el aviso de las pruebas, al abrir y no recién al guardar; por la salida de errores: el JSON queda igual (@story-8.319)
    console.error(`Si este camino corto cambia código, guardar pide una corrida en verde: ${require('./open-runs.js').markerEstable(os.homedir())} adhoc test -- <el comando de las pruebas>. Si cambiás código después, se vence.`);
    if (ciRojo) console.error(`Arreglo del rojo de CI del pedido #${ciRojo.pedido}: sin plan ni revisores. Antes de guardar corre el control «${ciRojo.control}»; después de empujar, ${require('./open-runs.js').markerEstable(os.homedir())} adhoc ci-wait espera la compilación y cierra el arreglo con el verde.`);
    process.exit(0);
  }
  console.error('marker.js adhoc: uso — adhoc set \'{"reason":"…","maxFiles":N,"mockup":"<ruta>","mockupApproved":"<quién y por qué vía>"}\' [--for-session <id>] [--terminal] | adhoc capture <imagen> | adhoc allow-data-change --changed "…" --recommends pasar|historia|descartar --why "…" | adhoc allow-foreign-save | adhoc until HH:MM | adhoc get | adhoc clear | adhoc clear-orphan <sessionId>');
  process.exit(2);
}

module.exports = {
  cmdAdhocClearOrphan, cmdAdhocAllowDataChange, cmdAdhocAllowForeignSave, cmdAdhoc,
};
