#!/usr/bin/env node
/**
 * sql-compile.js — antes del commit, COMPILA sin ejecutar cada migración SQL nueva o modificada.
 * AVISA, no frena (2026-09-14, decisión del dev: «al principio sólo avisa, y medimos»).
 *
 * 🔴 Caso que lo motiva (el repo del framework, 2026-09-10): `054_CleanupOldPluginVersionsAtomic.sql`
 * llegó al commit con un error de sintaxis —Msg 1046, una subconsulta dentro de un PRINT— y frenó el
 * despliegue entero, que corre todas las migraciones en orden. Esa entrega pasó por decenas de
 * revisores y 2589 tests: ninguno toca un `.sql` suelto. Cualquier ejecución contra una base lo
 * habría mostrado en segundos. (incident-log#migracion-destructiva-en-base-compartida-2026-09-10)
 *
 * Cómo compila SIN ejecutar:
 *   · `SET NOEXEC ON` en el primer lote: SQL Server compila cada lote y no ejecuta ninguno.
 *   · Un `.sql` que MENCIONA NOEXEC no se manda (podría apagarlo y ejecutarse), y uno que usa
 *     comandos de sqlcmd (`!!` corre en la máquina, `:r` trae otro archivo) tampoco: quedan «sin
 *     compilar», con el motivo. No se usa `sqlcmd -X` para eso: medido el 2026-09-14 con el sqlcmd
 *     de Homebrew, `-X` hace que ignore el archivo de entrada y abra el modo interactivo.
 *   · `-x`: las variables `$(…)` de sqlcmd no se sustituyen.
 *   · Se compila lo STAGEADO (`git show :<archivo>`), no el disco: lo que se commitea.
 *
 * La base se declara por ambiente, nunca en el repo:
 *   TYCON_SQL_COMPILE_SERVER · TYCON_SQL_COMPILE_DATABASE · TYCON_SQL_COMPILE_USER
 *   SQLCMDPASSWORD (sqlcmd la lee solo: la contraseña no pasa por argv, la salida ni el registro)
 *   TYCON_SQL_COMPILE_TRUST_CERTIFICATE=1 → -C
 * Apuntala a una base propia o de sólo lectura: compilar no escribe, pero es la costumbre correcta.
 *
 * 🔴 «Sin compilar» NUNCA se lee como «compila»: sin base configurada, sin sqlcmd, sin conexión, o
 * con un archivo que no se puede mandar, el aviso lo dice con el motivo. Y «NO compila» sólo cuando
 * SQL Server devolvió un error de compilación (nivel 15 o más); un login rechazado no es eso.
 *
 * Límite conocido, a medir: compilar sin ejecutar ve la sintaxis y lo que SQL Server valida al
 * compilar (el Msg 1046 del caso), pero NO ejecuta los lotes anteriores: una tabla creada en un lote
 * y usada en el siguiente puede dar un error que al desplegar no existe. Por eso avisa y no frena.
 *
 * Se mide: cada migración deja una línea en ~/.claude/.tycon-pipeline/sql-compile.jsonl
 * (compila · no-compila · sin-compilar). Con eso se decide después si pasa a frenar.
 *
 * Uso:  node sql-compile.js --staged [--repo <dir>]
 * Apagado: TYCON_SQL_COMPILE=0 · binario: TYCON_SQL_CMD (default: sqlcmd del PATH)
 * Sale SIEMPRE 0: es un aviso. Red: scripts/tests/sql-compile.test.sh
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { spawnSync } = require('child_process');
const { readEnv, prepareStateWrite, LegacyNamesError } = require('../lib/legacy-names.js');

const WHERE = 'scripts/ci/sql-compile.js';
const ES_MIGRACION = /(^|\/)(database|bd)\/.*\.sql$/i; // el mismo criterio que dispara al revisor de migraciones

function arg(nombre) {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function registrar(fila) {
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    // El nombre viejo (story 8.9, tanda D2) pasa al nuevo con su historia antes de la primera línea; si la copia falla,
    // no se anota (un registro nuevo sin la historia del viejo la perdería para siempre).
    const registro = prepareStateWrite(path.join(dir, 'sql-compile.jsonl'), { where: 'scripts/ci/sql-compile.js' });
    fs.appendFileSync(registro, JSON.stringify({ ts: new Date().toISOString(), ...fila }) + '\n');
  } catch (e) {
    // medir nunca rompe el commit, pero una medición que no se anota se dice (si no, la serie se corta callada)
    process.stderr.write(`⚠️  sql: no se anotó la medición — ${e instanceof LegacyNamesError ? e.message : (e && e.code) || (e && e.message) || e}\n`);
  }
}

/** ¿Por qué NO se puede mandar este archivo a compilar? null = se puede. */
function motivoParaNoMandar(texto) {
  if (/\bNOEXEC\b/i.test(texto)) return 'menciona NOEXEC: podría apagarlo y ejecutarse, así que no se manda';
  if (/^[ \t]*(:[A-Za-z!]|!!)/m.test(texto)) return 'usa comandos de sqlcmd (:r, !! …) que se apagan por seguridad';
  return null;
}

/** ¿Está el binario? Con ruta, por el disco; sin ruta, por el PATH (sin ejecutarlo). */
function existeBinario(bin) {
  if (bin.includes('/')) return fs.existsSync(bin);
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

/** Un error de COMPILACIÓN: SQL Server devolvió `Msg N, Level ≥15`. Un login rechazado es nivel 14. */
function esErrorDeCompilacion(salida) {
  const m = String(salida || '').match(/Msg (\d+), Level (\d+)/);
  return !!m && Number(m[2]) >= 15;
}

/** Primeras líneas útiles del error de SQL Server, en una sola línea. */
function resumenError(salida) {
  const lineas = String(salida || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const i = lineas.findIndex((l) => /^Msg \d+/.test(l));
  const util = i >= 0 ? lineas.slice(i, i + 2) : lineas.slice(0, 2);
  return util.join(' ').slice(0, 300) || 'sqlcmd salió con error y sin mensaje';
}

function main() {
  if (readEnv('TYCON_SQL_COMPILE', { where: WHERE }) === '0') return;
  if (!process.argv.includes('--staged')) {
    console.error('uso: node sql-compile.js --staged [--repo <dir>]');
    return;
  }
  const repo = path.resolve(arg('--repo') || process.cwd());
  const lista = git(repo, ['diff', '--cached', '--name-only', '--diff-filter=AMR', '-z']);
  if (lista === null) return; // sin git no hay nada staged que mirar
  const archivos = lista.split('\0').filter((f) => f && ES_MIGRACION.test(f)).sort();
  if (!archivos.length) return;

  const servidor = readEnv('TYCON_SQL_COMPILE_SERVER', { where: WHERE });
  const base = readEnv('TYCON_SQL_COMPILE_DATABASE', { where: WHERE });
  const usuario = readEnv('TYCON_SQL_COMPILE_USER', { where: WHERE });
  const binario = process.env.TYCON_SQL_CMD || 'sqlcmd';
  const repoNombre = path.basename(repo);

  // Sin base: no se puede compilar ninguna. Una sola línea, con el motivo y los archivos.
  let sinBase = null;
  if (!servidor || !base || !usuario) {
    sinBase = 'no hay base configurada (TYCON_SQL_COMPILE_SERVER, _DATABASE, _USER y SQLCMDPASSWORD)';
  } else if (!existeBinario(binario)) {
    sinBase = `no encontré sqlcmd (${binario})`;
  }
  if (sinBase) {
    console.log(`⚠️  sql: ${archivos.length} migración(es) SIN COMPILAR — ${sinBase}: ${archivos.join(', ')}`);
    console.log('   Sin compilar no quiere decir que compile: cualquier error de sintaxis se va a ver recién al desplegar.');
    for (const a of archivos) registrar({ repo: repoNombre, archivo: a, resultado: 'sin-compilar', motivo: sinBase });
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-compila-'));
  try {
    for (const a of archivos) {
      const texto = git(repo, ['show', `:${a}`]);
      if (texto === null) {
        console.log(`⚠️  sql: ${a} SIN COMPILAR — no pude leer la versión stageada`);
        registrar({ repo: repoNombre, archivo: a, resultado: 'sin-compilar', motivo: 'no pude leer la versión stageada' });
        continue;
      }
      const motivo = motivoParaNoMandar(texto);
      if (motivo) {
        console.log(`⚠️  sql: ${a} SIN COMPILAR — ${motivo}`);
        registrar({ repo: repoNombre, archivo: a, resultado: 'sin-compilar', motivo });
        continue;
      }
      const entrada = path.join(tmp, 'entrada.sql');
      fs.writeFileSync(entrada, `SET NOEXEC ON;\nGO\n${texto}\n`);
      const args = ['-S', servidor, '-d', base, '-U', usuario, '-b', '-x', '-l', '10', '-i', entrada];
      if (readEnv('TYCON_SQL_COMPILE_TRUST_CERTIFICATE', { where: WHERE }) === '1') args.push('-C');
      // Tope corto a propósito: esto corre dentro de un commit. Con la base caída, 10 s de login y 30 s en total por archivo.
      const r = spawnSync(binario, args, { encoding: 'utf8', timeout: 30000, env: process.env });
      if (r.error) {
        const m = r.error.code === 'ETIMEDOUT' ? 'la base no contestó en 30 s' : `sqlcmd no corrió (${r.error.code || r.error.message})`;
        console.log(`⚠️  sql: ${a} SIN COMPILAR — ${m}`);
        registrar({ repo: repoNombre, archivo: a, resultado: 'sin-compilar', motivo: m });
      } else if (r.status === 0) {
        console.log(`✅ sql: ${a} compila (sin ejecutarse, contra ${servidor}/${base})`);
        registrar({ repo: repoNombre, archivo: a, resultado: 'compila' });
      } else {
        const crudo = `${r.stdout || ''}\n${r.stderr || ''}`;
        const error = resumenError(crudo);
        if (esErrorDeCompilacion(crudo)) {
          console.log(`⚠️  sql: ${a} NO compila — ${error}`);
          console.log('   El commit sigue (esto avisa, no frena), pero el despliegue va a fallar en esta migración.');
          registrar({ repo: repoNombre, archivo: a, resultado: 'no-compila', motivo: error });
        } else {
          console.log(`⚠️  sql: ${a} SIN COMPILAR — no pude conectar o entrar a la base: ${error}`);
          registrar({ repo: repoNombre, archivo: a, resultado: 'sin-compilar', motivo: `sin conexión: ${error}` });
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try { main(); } catch (e) {
  console.log(`⚠️  sql: el aviso de compilación falló (${e.message}) — las migraciones de este commit quedan SIN COMPILAR`);
}
process.exit(0);
