'use strict';
/**
 * Una sesión que espera una tarea de fondo colgada: la tarea sigue abierta, pero hace rato que no escribe nada nuevo ni
 * hace nada. Nadie lo ve solo: la sesión no espera al dueño, y no está quieta porque tiene una tarea en curso.
 *
 * Qué se mide, por sesión viva:
 * - sus tareas de fondo abiertas: los archivos de salida que Claude Code escribe por cada comando de fondo
 *   (`<tmp>/claude-<uid>/<carpeta>/<sesión>/tasks/b<id>.output`) y que todavía no tienen el renglón de cierre que les
 *   agrega al terminar («[exited with code N]», «[killed]», «[process exited while detached; …]»). Los enlaces son
 *   los de los agentes internos, y las salidas de un flujo de agentes (`w<id>`) nunca reciben ese renglón: no cuentan;
 * - su salida nueva: la hora de modificación de esos archivos;
 * - su actividad: el tiempo de CPU y los procesos de las consolas que la sesión abrió (sus hijos que son una consola,
 *   o el sandbox que la envuelve, con todo lo que cuelga de ellos). Los demás hijos son sus servidores de herramientas,
 *   que se mueven solos y esconderían a la tarea colgada. Una sesión sin ninguna consola no corre ninguna tarea de fondo:
 *   un archivo abierto suyo es el de una tarea que se cortó sin su renglón de cierre, y no avisa.
 *
 * Lo que no ve, porque sin la línea de comando no se sabe qué proceso es de qué tarea: la actividad se mide por sesión.
 * Si la misma sesión tiene otra tarea de fondo que sí se mueve (un vigilante que consulta algo cada medio minuto), no
 * avisa. Y una tarea quieta a propósito (un servidor ocioso, un `sleep` largo) sale avisada: por eso el aviso es una
 * pregunta a la sesión, no un corte.
 *
 * De cada proceso se lee el número, el padre, el tiempo de CPU y el nombre del programa (`comm`), nunca su línea de
 * comando: la línea de comando puede traer un permiso o una clave. En macOS un programa puede poner argumentos en su
 * nombre: por eso del nombre sólo se guarda si es una consola, y no se guarda ni se imprime nada más. Como el tiempo de
 * CPU es acumulado y sin hora, la firma de la actividad (CPU y procesos) se guarda en el directorio de estado, y se mide
 * cuándo cambió por última vez. La primera vez que se ve una sesión no se la puede acusar: se toma su firma y la cuenta
 * arranca ahí. Para no leer los procesos en cada turno, la firma se toma sólo de las sesiones cuya tarea lleva
 * `SAMPLE_AFTER_MS` sin salida nueva: el aviso sale a los `STALL_MS` del silencio, o a los `STALL_MS` de la primera firma
 * si es más tarde.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Ninguna suite del arnés pasa ni seis minutos sin escribir, sin gastar CPU y sin abrir procesos (la más larga sin
// salida, el instalador de Windows en la CI, pasa los cinco con CPU todo el tiempo). Quince minutos de las tres cosas
// a la vez es una tarea colgada, y avisa media hora antes que la espera de 41 minutos que lo motivó.
const STALL_MS = 15 * 60000;
const SAMPLE_AFTER_MS = 5 * 60000;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'sandbox-exec', 'bwrap']);
const COMANDO = /^b[a-z0-9]+\.output$/;
const CIERRE = /\[(exited with code -?\d+|killed|process exited while detached[^\]]*)\]\s*$/;
const ESTADO = 'background-activity.json';

/** `[dd-][hh:]mm:ss[.cc]` del `ps` a centésimas de segundo; null si no se entiende. */
function centesimas(t) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(String(t || '').trim());
  if (!m) return null;
  const [, d, h, mi, s, c] = m;
  return ((((Number(d || 0) * 24 + Number(h || 0)) * 60 + Number(mi)) * 60 + Number(s)) * 100) + Number(String(c || '0').padEnd(2, '0').slice(0, 2));
}

/**
 * Los procesos de la máquina: `{ list: [{ pid, ppid, cpu, shell }] }`, o `{ problem }` si no se pudieron leer (en
 * Windows no hay `ps`). Se le pide número, padre, CPU y programa, nunca la línea de comando; del programa sólo queda si
 * es una consola.
 */
function processes({ run = spawnSync } = {}) {
  let r;
  try { r = run('ps', ['-A', '-o', 'pid=,ppid=,time=,comm='], { windowsHide: true, encoding: 'utf8', timeout: 3000 }); } catch (e) { return { problem: `los procesos (${e.message})` }; }
  if (!r || r.error || r.status !== 0) return { problem: `los procesos (${(r && r.error && r.error.message) || `ps salió con ${r && r.status}`})` };
  const list = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: centesimas(m[3]), shell: SHELLS.has(path.basename(m[4].split(' ')[0]).replace(/^-/, '')) });
  }
  return list.length ? { list } : { problem: 'los procesos (ps no devolvió ninguno)' };
}

/** Las consolas que la sesión `pid` abrió, con todo lo que cuelga de ellas. */
function consoles(pid, list) {
  const hijos = new Map();
  for (const p of list) { if (!hijos.has(p.ppid)) hijos.set(p.ppid, []); hijos.get(p.ppid).push(p); }
  const vistos = [];
  const pila = (hijos.get(Number(pid)) || []).filter((p) => p.shell);
  while (pila.length) {
    const p = pila.pop();
    vistos.push(p);
    pila.push(...(hijos.get(p.pid) || []));
  }
  return vistos;
}

/** La firma de la actividad de las consolas de `pid`: CPU sumada y los procesos que cuelgan de ellas. */
function signature(pid, list) {
  const vistos = consoles(pid, list);
  const cpu = vistos.reduce((a, p) => a + (p.cpu || 0), 0);
  return `${cpu}|${vistos.map((p) => p.pid).sort((a, b) => a - b).join(',')}`;
}

/**
 * Las carpetas de tareas de la sesión `sid`. Claude Code las nombra por la carpeta donde arrancó la sesión, con todo lo
 * que no es letra ni número cambiado por `-`. Esa carpeta es la que dice su archivo, o el repo del que sale su carpeta
 * de trabajo aislada (`worktrees/<nombre>` en la carpeta de Claude Code del repo) si entró después. No se recorre la
 * carpeta entera: puede tener miles, y esto corre en cada turno de la coordinadora.
 */
// la carpeta de Claude Code de un repo se llama como la de la persona: el nombre lo dice tycon-home.js
const CLAUDE = path.basename(require('../setup/harness/tycon-home.js').claudeDir(require('os').homedir())).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
function taskDirs(sid, root, cwd) {
  if (!cwd) return [];
  const slug = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');
  const raices = new Set([slug(cwd)]);
  const aislada = new RegExp(`^(.*?)[/\\\\]${CLAUDE}[/\\\\]worktrees[/\\\\]`).exec(String(cwd));
  if (aislada) raices.add(slug(aislada[1]));
  return [...raices].map((s) => path.join(root, s, sid, 'tasks')).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
}

/** Los comandos de fondo abiertos de la sesión: `[{ id, mtimeMs }]`. */
function openTasks(sid, root, cwd) {
  const out = [];
  for (const d of taskDirs(sid, root, cwd)) {
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => COMANDO.test(n)); } catch (_) { continue; }
    for (const n of names) {
      const p = path.join(d, n);
      let st;
      try { st = fs.lstatSync(p); } catch (_) { continue; }
      if (!st.isFile()) continue;
      const largo = Math.min(st.size, 400);
      let cola = '';
      if (largo) {
        try {
          const fd = fs.openSync(p, 'r');
          try { const b = Buffer.alloc(largo); fs.readSync(fd, b, 0, largo, st.size - largo); cola = b.toString('utf8'); } finally { fs.closeSync(fd); }
        } catch (_) { continue; }
      }
      if (!CIERRE.test(cola)) out.push({ id: n.replace(/\.output$/, ''), mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

const defaultRoot = () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid == null ? null : path.join('/tmp', `claude-${uid}`);
};

// escrito de una vez (a un temporal y renombrado): otra llamada nunca lee un JSON a medias
function guardar(archivo, datos, problems) {
  const tmp = `${archivo}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(datos)}\n`);
    fs.renameSync(tmp, archivo);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* nada que limpiar */ }
    problems.push(`la actividad de las tareas de fondo (${e.message})`);
  }
}

/**
 * Las sesiones que esperan una tarea de fondo sin actividad hace `STALL_MS` o más: `[{ sid, minutes, tasks }]`.
 * `sessions`: `[{ sid, pid, cwd }]` de las vivas. Guarda la firma de cada una en `<stateDir>/background-activity.json` y
 * borra la de las que ya no están. Lo que no se pudo leer va a `problems` y esa sesión no se acusa.
 */
function stalled({ sessions, stateDir, now = Date.now(), tasksRoot = defaultRoot(), readProcesses = processes, problems = [] }) {
  if (!tasksRoot) { problems.push('las tareas de fondo: no medido (sin carpeta temporal de Claude Code en esta plataforma)'); return []; }
  // sólo las que llevan un rato sin salida nueva: las que escriben están trabajando, y no hace falta leer los procesos
  const conTareas = sessions.map((s) => ({ ...s, tasks: openTasks(String(s.sid), tasksRoot, s.cwd) }))
    .filter((s) => s.tasks.length && now - Math.max(...s.tasks.map((t) => t.mtimeMs)) >= SAMPLE_AFTER_MS);
  const archivo = path.join(stateDir, ESTADO);
  let previo = {};
  try { previo = JSON.parse(fs.readFileSync(archivo, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT') problems.push(`la actividad de las tareas de fondo (${e.message})`); }
  if (!conTareas.length) {
    if (Object.keys(previo).length) guardar(archivo, {}, problems);
    return [];
  }
  const ps = readProcesses();
  if (ps.problem) { problems.push(ps.problem); return []; }
  const nuevo = {};
  const out = [];
  for (const s of conTareas) {
    // cada comando de fondo corre en una consola de la sesión: sin ninguna, no corre ninguno, y lo que sigue abierto es
    // el archivo de una tarea que se cortó sin su renglón de cierre
    if (!consoles(s.pid, ps.list).length) continue;
    const sig = signature(s.pid, ps.list);
    const antes = previo[s.sid];
    const desde = antes && antes.sig === sig && Number.isFinite(antes.at) ? antes.at : now;
    nuevo[s.sid] = { sig, at: desde };
    const salida = Math.max(...s.tasks.map((t) => t.mtimeMs));
    const quieta = now - Math.max(desde, salida);
    if (quieta >= STALL_MS) out.push({ sid: s.sid, minutes: Math.floor(quieta / 60000), tasks: s.tasks.length });
  }
  guardar(archivo, nuevo, problems);
  return out;
}

module.exports = { stalled, signature, consoles, openTasks, processes, centesimas, STALL_MS, SAMPLE_AFTER_MS };
