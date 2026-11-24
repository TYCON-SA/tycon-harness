'use strict';
/**
 * ci-local-checks.js — los controles de la CI de un repo que también corren en local, y su corrida antes de la foto del
 * pull request (save-ok.js `controlesDelCommit`).
 *
 * Un control que la CI corre recién después de la cola y de la compilación (minutos) y que en local tarda segundos no
 * tiene por qué esperar al pedido: un rojo así se ve antes de pedir la aprobación. No se lee el YAML de la CI (cada
 * plataforma y cada plantilla lo escriben distinto): cada control se DECLARA.
 *
 *   · El paquete del stack, en `ciLocalChecks` de su `pack.json`, si la organización lo activa y la lista `packs:` de
 *     `.tycon/advisors.yaml` del repo, commiteada, no lo saca.
 *   · El repo, en `.tycon/ci-local-checks.json`: `{ "checks": [...], "fromPacks": false? }`. Se lee de lo COMMITEADO
 *     (config-source.js `archivoParaFreno`): `fromPacks: false` apaga los del paquete, y apagar un control no puede
 *     alcanzar con escribir un archivo sin commitearlo.
 *
 * Un control: `{ "name", "run": [argv], "whenFile"?: "<nombre de archivo>", "timeoutSeconds"?: 1-600 }`. `run[0]`
 * `node` corre con el node de este proceso. Corre en la raíz del repo, sin consola, con `TYCON_HARNESS_DIR` (la raíz del
 * arnés) y `TYCON_REPO_DIR` en el entorno; escritas así en una palabra de `run`, se reemplazan por la carpeta. `whenFile`: corre sólo si el repo tiene en su raíz, sin ignorar, un archivo con ese
 * nombre.
 *
 * Un control mal escrito, o que no termina en su tope, no es verde: frena con «no medido».
 */
const path = require('path');
const { spawnSync } = require('child_process');

const CAMPOS = ['name', 'run', 'whenFile', 'timeoutSeconds'];
const TOPE_S = 120;
const RAIZ_DEL_ARNES = path.resolve(__dirname, '..', '..', '..', '..');
const ARCHIVO_DEL_REPO = '.tycon/ci-local-checks.json';

/** El motivo por el que `c` no es un control, o null. */
function motivoDe(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'no es un objeto';
  const fuera = Object.keys(c).filter((k) => !CAMPOS.includes(k));
  if (fuera.length) return `trae ${fuera.map((k) => `«${k}»`).join(', ')}, fuera de ${CAMPOS.join(', ')}`;
  if (typeof c.name !== 'string' || !c.name.trim()) return 'le falta «name»';
  if (!Array.isArray(c.run) || !c.run.length || !c.run.every((x) => typeof x === 'string' && x)) return '«run» no es una lista de palabras';
  if (c.whenFile != null && (typeof c.whenFile !== 'string' || !c.whenFile || /[\\/]/.test(c.whenFile))) return '«whenFile» no es un nombre de archivo';
  if (c.timeoutSeconds != null && !(Number.isInteger(c.timeoutSeconds) && c.timeoutSeconds >= 1 && c.timeoutSeconds <= 600)) return '«timeoutSeconds» no es un entero de 1 a 600';
  return null;
}

/** La configuración del repo, de lo commiteado: `{ checks, fromPacks }`, o `{ error }`. Sin archivo, la de por defecto. */
function delRepo(repo) {
  let txt;
  try { txt = require('./config-source.js').archivoParaFreno(repo, ARCHIVO_DEL_REPO); } catch (e) { return { error: `no pude leer ${ARCHIVO_DEL_REPO} (${e.message})` }; }
  if (txt == null) return { checks: [], fromPacks: true };
  let j;
  try { j = JSON.parse(txt); } catch (e) { return { error: `${ARCHIVO_DEL_REPO} no es JSON (${e.message})` }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: `${ARCHIVO_DEL_REPO} no es un objeto` };
  const fuera = Object.keys(j).filter((k) => !['checks', 'fromPacks'].includes(k));
  if (fuera.length) return { error: `${ARCHIVO_DEL_REPO} trae ${fuera.map((k) => `«${k}»`).join(', ')}, fuera de checks y fromPacks` };
  if (j.checks != null && !Array.isArray(j.checks)) return { error: `${ARCHIVO_DEL_REPO}: «checks» no es una lista` };
  if (j.fromPacks != null && typeof j.fromPacks !== 'boolean') return { error: `${ARCHIVO_DEL_REPO}: «fromPacks» no es true ni false` };
  return { checks: j.checks || [], fromPacks: j.fromPacks !== false };
}

/** Los paquetes activos en el repo, con su lista cruda; o `{ error }`. */
function deLosPaquetes(repo) {
  try {
    const packs = require('./packs.js');
    // como source-signals.js: con las banderas de las condiciones, que es como el pipeline valida los paquetes
    const instalados = packs.cargarPaquetes({ banderas: packs.BANDERAS });
    if (!instalados.length) return { paquetes: [] };
    const org = packs.activosDeLaOrganizacion({ instalados, dir: packs.dirPaquetes() });
    // la lista `packs:` del repo, de lo commiteado: achicarla con un archivo sin commitear no apaga estos controles
    const txt = require('./config-source.js').textoParaFreno(repo);
    const declarados = txt ? packs.paquetesDeclarados(txt) : null;
    const activos = declarados === null ? org : org.filter((p) => declarados.map((n) => packs.nombreActual(n)).includes(p.nombre));
    return { paquetes: activos.map((p) => ({ nombre: p.nombre, checks: p.controlesDeCi || [] })) };
  } catch (e) {
    const detalle = Array.isArray(e && e.errores) && e.errores.length ? e.errores.map((x) => x.motivo).join('; ') : String((e && e.message) || e).split('\n')[0];
    return { error: `no pude leer los paquetes activos (${detalle})` };
  }
}

/**
 * Los controles que corren en el repo: `{ controles: [{ nombre, origen, argv, topeS, whenFile }], avisos, errores }`.
 * `errores` no vacío: no se puede saber qué correr, y eso frena. `avisos`: lo que se dice sin frenar (los del paquete
 * apagados por el repo). `leerPaquetes` se inyecta en las pruebas.
 */
function controlesDe(repo, { leerPaquetes = deLosPaquetes } = {}) {
  const controles = [];
  const avisos = [];
  const errores = [];
  const sumar = (lista, origen) => {
    if (!Array.isArray(lista)) { errores.push(`${origen}: «ciLocalChecks» no es una lista`); return; }
    for (const c of lista) {
      const m = motivoDe(c);
      if (m) { errores.push(`${origen}: un control ${m}`); continue; }
      controles.push({ nombre: c.name, origen, argv: c.run.slice(), topeS: c.timeoutSeconds || TOPE_S, whenFile: c.whenFile || null });
    }
  };
  const r = delRepo(repo);
  if (r.error) return { controles: [], avisos, errores: [r.error] };
  if (r.fromPacks) {
    const p = leerPaquetes(repo);
    if (p.error) errores.push(p.error);
    else for (const x of p.paquetes) sumar(x.checks, `el paquete ${x.nombre}`);
  } else {
    avisos.push(`${path.basename(repo)}: el repo apaga los controles de CI de los paquetes (${ARCHIVO_DEL_REPO}, fromPacks: false)`);
  }
  sumar(r.checks, ARCHIVO_DEL_REPO);
  return { controles, avisos, errores };
}

/** ¿El repo tiene en su raíz, sin ignorar, un archivo con ese nombre? Lo responde git: lo seguido y lo nuevo sin ignorar. */
function tieneArchivo(repo, nombre) {
  const r = spawnSync('git', ['-C', repo, 'ls-files', '-co', '--exclude-standard', '--', nombre], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').some((l) => l.trim() === nombre);
}

// lo que dijo el control, en un renglón: sus últimas 8 líneas con texto, hasta 600 letras
const loQueDijo = (r) => {
  const s = String(`${r.stdout || ''}\n${r.stderr || ''}`).split('\n').map((x) => x.trim()).filter(Boolean).slice(-8).join(' · ');
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
};

/**
 * Corre los controles del repo. `{ codigo: 0, corridos: [nombres], avisos }` o `{ codigo: 2, motivo }`. `limite`: la hora
 * en ms después de la cual no se lanza ninguno más (el plazo de todos los controles del cierre). `soloNombre`: sólo ése.
 */
function correr(repo, { limite = Infinity, leerPaquetes, soloNombre = null } = {}) {
  const nombre = path.basename(repo);
  const { controles, avisos, errores } = controlesDe(repo, { leerPaquetes });
  if (errores.length) return { codigo: 2, motivo: `${nombre}: no medido, los controles de CI en local: ${errores.join('; ')}` };
  const corridos = [];
  // `soloNombre`: uno solo, el que falló en la compilación (el arreglo de un rojo de CI, lib/ci-red-lane.js)
  for (const c of controles.filter((x) => soloNombre === null || x.nombre === soloNombre)) {
    if (c.whenFile) {
      const tiene = tieneArchivo(repo, c.whenFile);
      if (tiene === null) return { codigo: 2, motivo: `${nombre}: no medido «${c.nombre}»: git no dijo si el repo tiene ${c.whenFile}` };
      if (!tiene) continue;
    }
    const queda = limite - Date.now();
    if (queda <= 0) return { codigo: 2, motivo: `${nombre}: no medido «${c.nombre}»: se terminó el plazo de los controles` };
    // las dos carpetas van también escritas en el comando: sin consola en el medio, que Windows no siempre tiene
    const [cmd, ...args] = c.argv.map((a) => a.split('$TYCON_HARNESS_DIR').join(RAIZ_DEL_ARNES).split('$TYCON_REPO_DIR').join(repo));
    const r = spawnSync(cmd === 'node' ? process.execPath : cmd, args, {
      cwd: repo, encoding: 'utf8', windowsHide: true, timeout: Math.min(c.topeS * 1000, queda), maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, TYCON_HARNESS_DIR: RAIZ_DEL_ARNES, TYCON_REPO_DIR: repo },
    });
    if (r.error || r.status === null) {
      return { codigo: 2, motivo: `${nombre}: no medido «${c.nombre}» (${c.origen}): no terminó (${r.error ? r.error.code || r.error.message : r.signal}). Un control que no termina no es verde` };
    }
    if (r.status !== 0) {
      return { codigo: 2, motivo: `${nombre}: el control de CI «${c.nombre}» (${c.origen}) sale ${r.status} en local, y la compilación del pull request daría rojo. Lo que dijo: ${loQueDijo(r)}` };
    }
    corridos.push(c.nombre);
  }
  return { codigo: 0, corridos, avisos };
}

module.exports = { controlesDe, correr, motivoDe, delRepo, ARCHIVO_DEL_REPO, RAIZ_DEL_ARNES };
