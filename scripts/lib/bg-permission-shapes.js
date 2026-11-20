'use strict';
/**
 * Las formas de comando que hacen que Claude Code pida permiso aun en modo sin permisos: su chequeo de borrados
 * peligrosos frena un `rm` cuyo destino no puede resolver antes de correr el comando, y sólo una persona lo aprueba. En
 * una sesión de fondo nadie contesta ese pedido: la sesión queda trabada y no lee mensajes mientras tanto.
 *
 * Medido en sesiones de fondo reales (claude --bg, sin permisos, sin ganchos) y en lo que el chequeo frenó en las
 * transcripciones de la máquina. Frena:
 *   · sustitucion: el destino es la salida de un `$(...)` o de comillas invertidas, o una variable armada con una
 *   · variable-con-comodin: el destino tiene una variable y un comodín (`$S/*.log`)
 *   · bash-c-armado: un `bash -c` (o `sh -c`, `zsh -c`) con un guion que no es literal, en un comando que borra
 *   · comodin-fuera-de-temporal: un comodín en una ruta literal que no es una carpeta temporal del sistema
 * Pasan sin pedir y no se tocan: una variable armada con un valor literal (`H=/x; rm -rf $H`), una ruta literal, una
 * relativa, un `for` sobre rutas literales, un comodín dentro del TMPDIR del sistema y un `bash -c` con un guion literal.
 */
const os = require('os');
const path = require('path');
const SP = require('./shell-parse.js');

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const COMODIN = /[*?[]/;

const FORMAS = {
  sustitucion: 'el destino de un `rm` sale de un `$(...)` (o de una variable armada con uno): Claude Code no lo puede revisar antes de correrlo',
  'variable-con-comodin': 'el destino de un `rm` tiene una variable y un comodín: Claude Code no sabe qué borra si la variable queda vacía',
  'bash-c-armado': 'un `bash -c` con un guion armado en un comando que borra: Claude Code no puede revisar qué borra el guion',
  'comodin-fuera-de-temporal': 'un `rm` con comodín fuera de una carpeta temporal del sistema',
};

/** El programa y sus palabras de un segmento, sin lo que puede ir delante (variables, `do`, `then`, `env`, `sudo`…). */
function programaDe(texto) {
  const t = SP.tokens(String(texto).replace(SP.PREFIJOS, ''));
  return { prog: t.length ? path.basename(t[0]) : '', args: t.slice(1) };
}

/** Las carpetas temporales del sistema, con y sin `/private` delante (en Mac son la misma). */
function temporales(tmpdir) {
  const base = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  if (tmpdir) base.push(path.resolve(tmpdir));
  return base;
}
const dentroDe = (p, dirs) => dirs.some((d) => p === d || p.startsWith(`${d.replace(/\/+$/, '')}/`));

/**
 * La forma que hará pedir permiso, o null: `{ forma, que }`. Sólo mira los `rm` del comando y los `bash -c`; un comando
 * que no borra nunca da una forma. Nunca lanza: un comando que no se puede leer da null (no se frena lo que no se sabe).
 */
function formaQuePidePermiso(cmd, { tmpdir = os.tmpdir() } = {}) {
  try {
    const texto = String(cmd || '');
    if (!/\brm\b/.test(texto)) return null;
    const segs = SP.segmentos(texto).map((s) => s.texto);
    // las variables armadas con una sustitución: su valor no se conoce antes de correr
    const deSustitucion = new Set();
    const re = /(?:^|[;&|\n(]\s*|\s)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=["']?(\$\(|`)/g;
    let m;
    while ((m = re.exec(texto))) deSustitucion.add(m[1]);
    const usaDeSustitucion = (a) => [...a.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].some((x) => deSustitucion.has(x[1]));
    let hayRm = false;
    let bashArmado = false;
    const vars = SP.variablesDelComando(texto);
    for (const seg of segs) {
      const { prog, args } = programaDe(seg);
      if (SHELLS.has(prog)) {
        const i = args.indexOf('-c');
        const guion = i >= 0 ? args[i + 1] : undefined;
        if (guion !== undefined && /[$`]/.test(guion)) bashArmado = true;
        if (guion !== undefined && /\brm\b/.test(guion)) hayRm = true;
        continue;
      }
      if (prog !== 'rm') continue;
      hayRm = true;
      let opciones = true;
      for (const a of args) {
        if (opciones && a === '--') { opciones = false; continue; }
        if (opciones && a.startsWith('-')) continue;
        if (a.includes('$(') || a.includes('`') || usaDeSustitucion(a)) return { forma: 'sustitucion', que: FORMAS.sustitucion };
        if (a.includes('$') && COMODIN.test(a)) return { forma: 'variable-con-comodin', que: FORMAS['variable-con-comodin'] };
        if (!a.includes('$') && COMODIN.test(a)) {
          const ruta = path.resolve(SP.expandir(a, vars) || a);
          if (!dentroDe(ruta, temporales(tmpdir))) return { forma: 'comodin-fuera-de-temporal', que: FORMAS['comodin-fuera-de-temporal'] };
        }
      }
    }
    if (hayRm && bashArmado) return { forma: 'bash-c-armado', que: FORMAS['bash-c-armado'] };
    return null;
  } catch (_) {
    return null;
  }
}

/** El texto de la negativa: qué lo frenaría y cómo reescribirlo para que pase solo. */
function textoDeLaNegativa(f) {
  return `Esta sesión corre de fondo y este comando haría que Claude Code pida permiso a una persona: ${f.que}. `
    + 'Nadie lo contesta en una sesión de fondo, y mientras espera la sesión no lee mensajes. Reescribilo antes de '
    + 'correrlo: un `rm` por llamada, con la ruta literal y absoluta de lo que borrás (sin `$(...)`, sin variables con '
    + 'comodines y fuera de un `bash -c`), o no borres: lo que dejaste en el TMPDIR del sistema lo limpia la máquina. '
    + 'Las salidas, en el TMPDIR del sistema. El resto del comando, en llamadas aparte.';
}

module.exports = { FORMAS, formaQuePidePermiso, textoDeLaNegativa };
