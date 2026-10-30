#!/usr/bin/env node
/**
 * prod-access-guard.js — toda consulta a una base de PRODUCCIÓN pasa por la puerta, y la puerta
 * abre un cuadro de aprobación. Todo otro camino se PROHÍBE (no se pregunta: se frena).
 *
 * EL INCIDENTE QUE LO MOTIVA (2026-09-15, sesión sobre un producto del equipo — guides/maintaining/incident-log.md#produccion-sin-permiso-2026-09-15): se autorizó leer producción para
 * replicar un caso a staging; terminada esa tarea, en el turno siguiente el asistente corrió ~9
 * consultas más contra producción sin pedir permiso y abrió una regla de firewall que quedó viva.
 * La regla («cada sentencia se aprueba») ya existía escrita en la memoria del asistente y no
 * alcanzó: un control que hay que acordarse de invocar es un control que no corre.
 *
 * DÓNDE VIVE: en la configuración administrada (`/Library/Application Support/ClaudeCode/
 * managed-settings.d/tycon-production.json`), de root, con matcher `Bash|Monitor|PowerShell`. Es lo
 * único que la Task 0 vio resistir a la herramienta Monitor, a `disableAllHooks` (por archivo, por
 * bandera y a mitad de sesión) y a otra sesión lanzada con `--setting-sources project`.
 *
 * NO TIENE ESCAPE (AC 13). Ni `TYCON_SAFETY_OFF=1`, ni `TYCON_PROD_GUARD=0`, ni ninguna variable.
 * Se apaga con `sudo`, borrando la configuración administrada: es una acción de una persona.
 *
 * FALLA CERRADO (AC 14): si el texto crudo nombra algo de bases y el hook no puede decidir
 * —excepción, JSON ilegible, su propio reloj vencido—, sale 2 y lo anota. Con cualquier otro
 * comando deja pasar. El reloj propio vence ANTES que el `timeout` del registro, porque un
 * `timeout` vencido DEJA PASAR el comando (medido en la Task 0b: 8 s con `timeout: 3` → corrió).
 *
 * Salida: 2 = frena (motivo por stderr) · 0 y sin salida = deja pasar.
 */
'use strict';

const RELOJ_MS = 5000;                    // el registro lo envuelve en timeout: 10

// 🔴 Las costuras de prueba (TYCON_PROD_ROOT, TYCON_PROD_SESSION_SINCE) existen SÓLO
// donde el freno NO está instalado. En una máquina con /opt/tycon, ninguna variable cambia nada: una
// sesión hija lanzada por el asistente con TYCON_PROD_ROOT=<raíz falsa> apagaba el freno entero, y
// una costura de falla salteaba el análisis (revisores, 2026-09-15). Es la misma regla que ya
// tenían la puerta y el aviso; acá faltaba.
const INSTALADO = (() => { try { return require('fs').statSync('/opt/tycon').isDirectory(); } catch { return false; } })();
const costura = (nombre) => (INSTALADO ? undefined : process.env[nombre]);
const t0 = Date.now();
const vencido = () => Date.now() - t0 > RELOJ_MS;

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => { try { decidir(raw); } catch (e) { emergencia(raw, e); } });
process.stdin.on('error', (e) => emergencia(raw, e));

// Clientes de base y la bandera con la que cada uno nombra el servidor. `sqlpackage` estaba en la
// lista y sólo se le miraba `-S`, que NO es su bandera: la suya es `/TargetServerName:` (pase
// adversarial 2026-09-15). Lo mismo `tsql` (FreeTDS, `-H`) y `mssql` (sql-cli, `-s`).
const CLIENTES = {
  sqlcmd: ['-S', '--server'], bcp: ['-S'], 'mssql-cli': ['-S', '--server'], sqlps: ['-S'], osql: ['-S'],
  tsql: ['-H', '-S'], mssql: ['-s', '--server'], usql: [], 'invoke-sqlcmd': ['-ServerInstance', '-serverinstance'],
  sqlpackage: ['/TargetServerName', '/tsn', '/SourceServerName', '/ssn'],
};
// Variables de entorno que los clientes leen cuando NO viene la bandera: `SQLCMDSERVER=<prod> sqlcmd -Q …`
// conecta a producción sin un solo `-S` (documentado, y reproducido en el pase adversarial).
// Los clientes que distinguen mayúsculas en sus banderas: en `sqlcmd` y compañía `-s` es el separador de columnas
// (`sqlcmd -S localhost -s '|'`) y sólo `-S` nombra el servidor. En los demás, la bandera corta se compara sin mayúsculas.
const BANDERAS_EXACTAS = new Set(['sqlcmd', 'bcp', 'osql', 'mssql-cli', 'tsql']);
const VARIABLES_SERVIDOR = ['SQLCMDSERVER', 'MSSQL_HOST', 'PGHOST', 'DBSERVER'];
// ── el texto crudo nombra algo de bases: eso decide si una falla propia frena o deja pasar ────
// 🔴 Se DERIVA de la misma lista de clientes que usa la detección. Eran dos listas escritas a mano y
// ya se habían separado: `tsql` y `sqlpackage` estaban en una y no en la otra, así que ante una falla
// propia —o con el intérprete de root adulterado— `tsql -S <prod>` pasaba (pase adversarial
// 2026-09-15). El lanzador (`node-shim.sh`) repite este criterio en bash; lo sostiene un caso de la
// suite que prueba CADA cliente de esta lista en los dos lados.
const ES_SHELL = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'eval']);
// ¿El heredoc alimenta a un shell? (`bash <<EOF`) — si alimenta a python, a un YAML o a `cat >`, no.
// Programas que EJECUTAN lo que les llega por el heredoc: los shells, `xargs` (arma comandos con cada
// línea) y `ssh` (un shell remoto). Se buscan como TOKEN ENTERO de la línea del `<<` —programa o
// argumento: `sudo bash`, `ssh host bash`, `docker exec -i c sh`, `cat <<EOF | bash`— y lo decide
// `heredocAlimentaShell`, abajo. `source`, `.` y `eval` cuentan SÓLO en posición de programa: como
// argumento no ejecutan nada (`git add .` en la misma línea no vuelve shell al cuerpo).
// 🔴 Antes era un regex `\b(?:sh|bash|…)\b` sobre los 60 caracteres previos al `<<`, y `\bsh\b`
// matcheaba la EXTENSIÓN `.sh` del archivo destino: `cat > scripts/tests/x.test.sh <<'FIN'` se leía
// como «heredoc que alimenta a un shell», y el cuerpo —el CONTENIDO del archivo, con sus `mkdir`,
// `chmod` y `rm` sobre `$CASA/.claude/.tycon-pipeline` de una prueba— se juzgaba como escrituras de
// este comando. Dos falsos positivos en vivo el 2026-09-16 (y `docs/bash-tips.md` caía igual).
const CONSUME_COMO_SHELL = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'xargs', 'ssh']);
const CONSUME_COMO_SHELL_SI_ES_PROGRAMA = new Set(['source', '.', 'eval']);
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CRUDO = new RegExp('(' + [
  ...Object.keys(CLIENTES).map((c) => `\\b${escRe(c)}\\b`),
  ...VARIABLES_SERVIDOR.map((v) => `\\b${v}\\s*=`),
  // `(?<![A-Za-z0-9_])`: una cadena de conexión dice `;Server=…`, pero `SQL_SERVER=algo make build`
  // es una variable de shell cualquiera y no nombra ninguna base (caso T4h de la suite).
  '(?<![A-Za-z0-9_])Server\\s*=', 'Data\\s+Source\\s*=', '\\bAddr(?:ess)?\\s*=', 'Network\\s+Address\\s*=',
  '\\baz\\s+sql\\b', 'Microsoft\\.Sql\\/servers', '(?:jdbc:)?(?:sqlserver|mssql|tds):\\/\\/',
  // los dos nombres del catálogo, del índice y de la memoria (story 8.9, tanda P: escritura doble hasta que todas las
  // máquinas autorizadas reinstalen)
  'tycon-prod-sql', '\\.tycon\\/production\\.json', 'production-(?:index|memory)\\.json',
  '\\.tycon\\/produccion\\.json', 'produccion-indice\\.json', 'produccion-memoria\\.json',
  'security\\s+(?:-i\\b|find-|dump-keychain|export|[a-z-]*generic-password)',
].join('|') + ')', 'i');

// El borrado en Azure tiene su propio criterio crudo: no se suma a CRUDO, que está fijado por la T27 de
// prod-access-guard.test.sh porque decide la red de lo opaco y lo que measure-guard cuenta. Éste decide sólo la caída del
// freno y el tope de 32 KB. Su copia en bash es `nombra_borrado()` de node-shim.sh; la T18 de
// prod-guard-azure-delete.test.sh compara los dos. Es una función y no una expresión regular: con dos tramos libres la
// expresión retrocedía sin fin en un texto largo, justo en el camino de más de 32 KB. Corre también sobre el JSON crudo del
// evento, donde un salto de línea es el texto `\n`: por eso `\n` y `\r` escritos cortan el tramo y `\t` separa palabras.
const REMOVE_AZ_RE = /Remove-Az(?:ResourceGroup|ResourceLock|Resource|SqlServer|SqlDatabase)(?![A-Za-z0-9_])/i;
const INVOKE_REST_RE = /Invoke-AzRestMethod\b.*?\s-M[a-z]*[\s:=]*\\?["']?(?:delete\b|\$)|Invoke-AzRestMethod\b[^;|&]*\s@[A-Za-z_]/i;
// `az` como palabra: sola, al final de una ruta (con barras de los dos lados) o pegada a una comilla o un paréntesis de un
// programa que la ejecuta (`system("az …`)
const esPalabraAz = (w) => /(?:^|[\\/:"'`({])az(?:\.cmd|\.exe)?$/i.test(w) || /az\.(?:cmd|exe)$/i.test(w);
function nombraBorradoAzure(texto) {
  for (const tramo of String(texto || '').split(/[;|&\n\r]|\\[nr]/)) {
    if (REMOVE_AZ_RE.test(tramo) || INVOKE_REST_RE.test(tramo)) return true;
    const pal = tramo.split(/(?:\s|\\t)+/).map((x) => x.replace(/^[\\"'`({$]+|[\\"'`)}]+$/g, '').toLowerCase()).filter(Boolean);
    for (let k = 0; k < pal.length; k++) {
      if (/(?:^|[\\/:"'`({])azd(?:\.exe)?$/.test(pal[k]) && pal[k + 1] === 'down') return true;
      if (!esPalabraAz(pal[k])) continue;
      const resto = pal.slice(k + 1);
      for (const g of ['group', 'lock', 'resource']) { const x = resto.indexOf(g); if (x >= 0 && resto.indexOf('delete', x + 1) > x) return true; }
      if (resto.includes('rest') && /(?:^|\s|\\t)(?:--m[a-z]*|-m)(?:\s|\\t|=)*[\\"'$]*delete(?![A-Za-z0-9_-])/i.test(tramo)) return true;
    }
  }
  return false;
}

// 🔴 Tope de tamaño ANTES de parsear. Un comando con decenas de miles de `<<` hacía que el parseo de
// heredocs tardara ~17 s (costo cuadrático): el reloj propio se consultaba DESPUÉS, el `timeout` del
// registro mataba el proceso primero, y un `timeout` vencido DEJA PASAR (pase adversarial 2026-09-15,
// reproducido con un comando de 275 KB que nombraba producción). Un comando real de más de 32 KB que
// no nombra bases pasa sin parsear; si nombra bases, se frena sin parsear.
const MAX_CMD = 32 * 1024;

function emergencia(texto, e) {
  try {
    const os = require('os'); const fs = require('fs'); const path = require('path');
    const dir = (() => { try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); if (typeof TH.stateDir === 'function') return TH.stateDir(os.homedir()); } catch (_) { /* la de siempre */ } return path.join(os.homedir(), '.claude', '.tycon-pipeline'); })();   // la carpeta del estado la sabe tycon-home.js (story 8.23, tanda D: en /opt viaja su copia)
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'),
      `[${new Date().toISOString()}] prod-access-guard FALLÓ: ${(e && e.stack) || e}\n\n`, 'utf8');
  } catch { /* si ni eso se puede, queda el mensaje de abajo */ }
  if (CRUDO.test(String(texto || '')) || nombraBorradoAzure(texto)) {
    process.stderr.write(mensaje('el freno de producción no pudo decidir (falla propia) y este comando nombra una base o un borrado en Azure.',
      ['El motivo quedó en ~/.claude/.tycon-pipeline/hook-errors.log.',
       'Un freno que no pudo mirar NO deja pasar: «no sé» no es «no hay producción acá».']));
    // 🔴 Éste es el OTRO camino de bloqueo, y era el único que no dejaba línea: el freno frenó,
    //    y para la cuenta no existió. `reglaDelMotivo` ya tenía el código para nombrarlo
    //    (pase adversarial, 2026-09-16). `texto` es el comando crudo: de él sale la huella, nunca
    //    el texto — acá NO hay `ctx`, y usarlo tiraría un error que el try/catch se comería en
    //    silencio, que es exactamente el modo de falla que esta story persigue.
    recordDecision({ freno: 'prod-access-guard', regla: 'no-pude-mirar', veredicto: 'bloqueo', cmd: String(texto || '') });
    process.exit(2);
  }
  process.exit(0);
}

// ── la biblioteca de constancias, por su nombre de ahora o por el de antes ────────────────────────────────────────
// La biblioteca se llama `guard-record.js` desde el renombre a inglés (story 8.9, tanda C1). El freno la cargaba SÓLO
// por el nombre de antes, y eso anda donde ese nombre existe: en /opt/tycon (el instalador copia la biblioteca con
// los dos nombres) y en el repo del equipo (ahí es un reemplazo generado). La copia pública no lleva reemplazos: el
// freno frenaba y no dejaba constancia, y la falla caía en un `catch` vacío — para la cuenta ese freno no existía
// (story 8.7, T12 y T13 de guard-record.test.sh).
// Se busca primero el nombre de ahora y, si no carga, el de antes: anda en el repo del equipo (los dos), en la copia
// pública (sólo el de ahora) y en un /opt/tycon de una instalación vieja (sólo el de antes, o los dos).
// 🔴 Que no cargue NINGUNA de las dos no cambia la decisión —frenar no depende de la constancia— pero no queda
// callado: va a hook-errors.log, que es lo que el aviso de arranque cuenta. Una sola vez por proceso.
// Los dos `require` van con la ruta literal a propósito: el control de que todo lo que el freno carga se copie a /opt
// los lee del texto (T25 de legacy-names.test.js).
let guardRecordLib;                       // undefined = todavía no se buscó · null = no se pudo cargar ninguna
function loadGuardRecord() {
  if (guardRecordLib !== undefined) return guardRecordLib;
  const failures = [];
  try { guardRecordLib = require('../lib/guard-record.js'); return guardRecordLib; } catch (e) {
    failures.push(`guard-record.js: ${(e && (e.code || e.message)) || e}`);
  }
  try { guardRecordLib = require('../lib/constancia-freno.js'); return guardRecordLib; } catch (e) {
    failures.push(`el nombre de antes: ${(e && (e.code || e.message)) || e}`);
  }
  guardRecordLib = null;
  try {
    const os = require('os'); const fs = require('fs'); const path = require('path');
    const dir = (() => { try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); if (typeof TH.stateDir === 'function') return TH.stateDir(os.homedir()); } catch (_) { /* la de siempre */ } return path.join(os.homedir(), '.claude', '.tycon-pipeline'); })();   // la carpeta del estado la sabe tycon-home.js (story 8.23, tanda D: en /opt viaja su copia)
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'),
      `[${new Date().toISOString()}] prod-access-guard no pudo cargar la biblioteca de constancias (${failures.join(' · ')}): `
      + 'la decisión se tomó igual, pero no quedó anotada en frenos.jsonl. Reinstalá el freno o actualizá el arnés.\n\n', 'utf8');
  } catch { /* si ni eso se puede escribir, la decisión del freno sigue siendo la misma */ }
  return null;
}
// La línea canónica que lee la cuenta del tablero (story 2.6). Nunca rompe ni cambia la decisión de quien la llama.
function recordDecision(entry) {
  const lib = loadGuardRecord();
  if (!lib) return;
  try { lib.anotar(entry); } catch { /* ayuda, no evidencia */ }
}

function mensaje(motivo, detalle = []) {
  return [
    '🛑 FRENO DE PRODUCCIÓN — es a propósito, no es un error de configuración y no se rodea.',
    '',
    `Motivo: ${motivo}`,
    ...(detalle.length ? [''].concat(detalle.map((d) => `   ${d}`)) : []),
    '',
    '   Para consultar una base de producción hay UNA sola forma, y abre un cuadro de aprobación:',
    "     /opt/tycon/bin/tycon-prod-sql <host> '<sentencia>' [--max-filas N]",
    '   Detalle y cómo declarar un servidor: guides/produccion-con-permiso.md',
    '',
  ].join('\n');
}

// El mensaje de un borrado en Azure: la puerta no borra nada, así que no se la nombra ni se sugiere un rodeo.
function mensajeSinPuerta(motivo, detalle = []) {
  return [
    '🛑 FRENO DE PRODUCCIÓN — es a propósito, no es un error de configuración y no se rodea.',
    '',
    `Motivo: ${motivo}`,
    ...(detalle.length ? [''].concat(detalle.map((d) => `   ${d}`)) : []),
    '',
  ].join('\n');
}

function reglaDelMotivo(motivo) {
  const m = String(motivo || '');
  // story 8.14, AC 14: un nombre que el freno no sabe leer dentro del alcance protegido NO es una falla del freno —
  // tiene su propia regla, y por eso va antes que «no pude mirar» (el motivo cita la palabra del comando)
  if (/^ese comando escribe en una carpeta protegida con un nombre que el freno no sabe leer como el shell/.test(m)) return 'nombre-indecidible';
  if (/no pude|no encontr|sin tiempo|no parece/i.test(m)) return 'no-pude-mirar';
  if (/no est. declarado/i.test(m)) return 'host-no-declarado';
  if (/can.nica|secuestr/i.test(m)) return 'puerta-no-canonica';
  return 'produccion';
}

// `reglaFija`: la regla la dice quien frena cuando el motivo CITA texto del comando (una palabra, un servicio, un host sin
// resolver). Leerla del motivo con `reglaDelMotivo` clasificaba como «no pude mirar» —y mandaba a hook-errors.log como falla
// del freno— una escritura legítima cuyo comando decía «no pude abrir» (pase adversarial de la 8.14 A, #41).
function frenar(motivo, detalle, ctx, reglaFija, { sinPuerta = false } = {}) {
  const regla = reglaFija || reglaDelMotivo(motivo);
  try { registrar(ctx, { bloqueo: true, motivo }); } catch { /* el registro es ayuda, no evidencia */ }
  // la línea canónica que lee la cuenta del tablero (story 2.6): sin host, sin sentencia
  // `causa`: el motivo de un bloqueo de `produccion`, que frena por causas distintas (lista de guard-record.js)
  recordDecision({ freno: 'prod-access-guard', regla, veredicto: 'bloqueo', cmd: ctx && ctx.cmd, motivo: (ctx && ctx.causa) || undefined });
  // lo que se frena por NO PODER MIRAR (snapshot, índice, reloj) va también a hook-errors.log, que es lo
  // que el aviso de arranque cuenta — si no, esas fallas no las veía nadie (revisores)
  if (regla === 'no-pude-mirar' && /no pude|no encontré|sin tiempo|no parece/.test(motivo)) {
    try {
      const os = require('os'); const fs = require('fs'); const path = require('path');
      const dir = (() => { try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); if (typeof TH.stateDir === 'function') return TH.stateDir(os.homedir()); } catch (_) { /* la de siempre */ } return path.join(os.homedir(), '.claude', '.tycon-pipeline'); })();   // la carpeta del estado la sabe tycon-home.js (story 8.23, tanda D: en /opt viaja su copia)
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'hook-errors.log'), `[${new Date().toISOString()}] prod-access-guard NO PUDO MIRAR (frenó): ${motivo}\n\n`, 'utf8');
    } catch { /* noop */ }
  }
  process.stderr.write(sinPuerta ? mensajeSinPuerta(motivo, detalle) : mensaje(motivo, detalle));
  process.exit(2);
}

function registrar(ctx, extra) {
  const os = require('os'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
  const dir = (() => { try { const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); if (typeof TH.stateDir === 'function') return TH.stateDir(os.homedir()); } catch (_) { /* la de siempre */ } return path.join(os.homedir(), '.claude', '.tycon-pipeline'); })();   // la carpeta del estado la sabe tycon-home.js (story 8.23, tanda D: en /opt viaja su copia)
  fs.mkdirSync(dir, { recursive: true });
  const linea = {
    ts: new Date().toISOString(),
    host: (ctx && ctx.host) || null,
    proyecto: (ctx && ctx.repos && ctx.repos[0]) || null,
    // la SENTENCIA no se anota nunca (AC 23): sólo su huella, para poder correlacionar
    sha256: ctx && ctx.cmd ? crypto.createHash('sha256').update(ctx.cmd).digest('hex') : null,
    ...extra,
  };
  // El registro de antes del renombre a inglés (story 8.9, tanda P) pasa al nuevo una vez, sin tocar el viejo. La copia va
  // a un temporal y entra con `link`, que no pisa: otro freno en paralelo nunca ve un registro nuevo a medio copiar. Si
  // la historia no se puede pasar, se sigue anotando en el viejo: un registro nuevo sin su historia la perdería (AC 18).
  const nuevo = path.join(dir, 'production.log');
  const viejo = path.join(dir, 'produccion.log');
  let destino = nuevo;
  if (!fs.existsSync(nuevo) && fs.existsSync(viejo)) {
    const tmp = `${nuevo}.tmp-${process.pid}`;
    try {
      fs.copyFileSync(viejo, tmp);
      try { fs.linkSync(tmp, nuevo); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }   // EEXIST: otro proceso ya lo pasó
    } catch { destino = viejo; }
    try { fs.unlinkSync(tmp); } catch { /* no se llegó a crear */ }
  }
  fs.appendFileSync(destino, JSON.stringify(linea) + '\n', 'utf8');
}

// ── la puerta ─────────────────────────────────────────────────────────────────────────────────
// Programas que sólo LEEN o MENCIONAN: para quien mantiene el arnés, mirar o documentar la puerta es
// rutina, y frenarlo con «se invocó de una forma que no es la canónica» es un mensaje falso además
// de molesto — así muere un control (pase adversarial 2026-09-15, H4).
// 🔴 `git` entró el 2026-09-15, el día de la instalación y en vivo: un
// `git log -- scripts/produccion/tycon-prod-sql` —leer la historia del propio archivo— se frenaba como
// si fuera una invocación no canónica, y le pasa igual con `show`, `diff`, `blame` y `add`. Un freno que
// muerde en comandos de todos los días se apaga en una semana. Ninguno de estos programas EJECUTA lo
// que recibe como ruta, a diferencia de `bash -c`, `eval` o `xargs`, que siguen frenados.
const LECTORES_DE_TEXTO = new Set(['which', 'type', 'whence', 'man', 'echo', 'printf', 'cat', 'bat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'wc', 'stat', 'ls', 'file', 'diff', 'shasum', 'md5', 'open', 'code', 'git', 'cp', 'mv', 'chmod', 'chown', 'sed', 'awk', 'basename', 'dirname', 'realpath', 'readlink', 'find', 'sort', 'uniq']);
const PUERTA = '/opt/tycon/bin/tycon-prod-sql';
const NOMBRE_PUERTA = 'tycon-prod-sql';
// Lista BLANCA: ruta absoluta, nada antes ni después, la sentencia en UN argumento entre comillas
// simples (o dobles sin $, ` ni \). Una lista negra de envoltorios no se puede completar: la Task 0
// encontró cinco que esquivan la regla de preguntar (bash -c, sh -c, eval, ruta relativa, alias).
// El host: charset estricto de nombre de host (con puerto/instancia del cliente). NUNCA `\S+` —
// ahí entraban `;`, `&&`, `|`, `$( )` y `` ` ``, y el shell parte el comando después de que el freno
// ya dijo que sí (pase adversarial 2026-09-15).
const HOST_CANONICO = '[A-Za-z0-9][A-Za-z0-9._:,\\-]*';
// La sentencia: entre comillas simples (con la forma `'\''` del shell para una comilla adentro), o
// entre dobles sin `$`, `` ` `` ni `\`. Sin la primera, una consulta con apóstrofo Y `$` no se podía
// expresar por ninguna vía, y una puerta que no sirve para el trabajo real es una puerta que se rodea.
const SENTENCIA = `(?:'(?:[^']|'\\\\'')*'|"[^"$\`\\\\]*")`;
const RUTA_PUERTA = PUERTA.replace(/\//g, '\\/');
const CANONICA = new RegExp(`^${RUTA_PUERTA} (${HOST_CANONICO}) ${SENTENCIA}(?: --max-filas \\d+)?$`);
const CANONICA_RECLAS = new RegExp(`^${RUTA_PUERTA} --reclasificar (${HOST_CANONICO})$`);
const CANONICA_VERIF = new RegExp(`^${RUTA_PUERTA} --verificar$`);
// `--cargar-clave <host>`: deja en el Escritorio el archivo con el que la PERSONA carga usuario y
// contraseña. No lee nada del Llavero ni consulta ninguna base; el disparador antes era «corré una
// consulta que falle», que es un rodeo (2026-09-15).
const CANONICA_CARGA = new RegExp(`^${RUTA_PUERTA} --cargar-clave (${HOST_CANONICO})$`);
// `--open-firewall <host>` y `--close-firewall <host>`: la regla de firewall de ESTA máquina, con el mismo cuadro. Sólo
// el host: `--session <id>` lo pasa el hook de fin de sesión, que no pasa por acá, y cualquier otro argumento (un
// rango, una IP, un nombre de regla) no es canónico.
const CANONICA_FIREWALL = new RegExp(`^${RUTA_PUERTA} --(?:open|close)-firewall (${HOST_CANONICO})$`);
// `--locks`, sola: dice qué servidores de producción tienen el candado de Azure (sólo lee)
const CANONICA_CANDADOS = new RegExp(`^${RUTA_PUERTA} --locks$`);
// `--delete-group <grupo>`, sólo el nombre: la puerta comprueba que el grupo no es de producción antes de pedir el borrado.
// El corte de `az group delete` directo (paso 3b) no cambia.
// Un nombre con paréntesis (Azure los permite) va entre comillas simples: sin ellas el shell los lee como sintaxis.
const CANONICA_BORRAR_GRUPO = new RegExp(`^${RUTA_PUERTA} --delete-group (?:[A-Za-z0-9._][A-Za-z0-9._-]{0,89}|'[A-Za-z0-9._()][A-Za-z0-9._()-]{0,89}')$`);
// `<host> --file <ruta>`: la consulta desde un archivo no pasa, porque el cuadro de aprobación muestra el comando y no el
// contenido del archivo. Cuando el archivo se puede pasar a una consulta en línea, el freno da ese comando listo. La ruta
// sin comillas, espacios ni nada que el shell expanda, y sin «-» al principio.
const RUTA_ARCHIVO = '[A-Za-z0-9._/~@+][A-Za-z0-9._/~@+-]*';
const FORMA_ARCHIVO = new RegExp(`^${RUTA_PUERTA} (${HOST_CANONICO}) --file (${RUTA_ARCHIVO})(?: --sha256 (\\S*))?(?: --max-filas (\\d+))?$`);
const TOPE_ARCHIVO = 64 * 1024;

// lo que haría ver en el cuadro otra cosa que los bytes que corren: controles C0 (salvo salto de línea y tabulador), DEL
// y C1; invisibles, rellenos y marcas de dirección; selectores de variación y caracteres de etiqueta. La lista es cerrada
// a propósito: lo que no está pasa, y lo cuenta el tope de renglones. La misma lista en la puerta.
const CONTROL_QUE_ENGANA = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u;
const INVISIBLE_QUE_ENGANA = /[\u{ad}\u{34f}\u{61c}\u{115f}\u{1160}\u{17b4}\u{17b5}\u{180b}-\u{180e}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2028}\u{2029}\u{2060}-\u{206f}\u{2800}\u{3164}\u{fe00}-\u{fe0f}\u{feff}\u{ffa0}\u{fff9}-\u{fffc}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
/** El motivo por el que el texto engañaría en el cuadro, o null. Un carácter de reemplazo es lo que llega de bytes que
 * no son UTF-8: la entrada del freno ya viene decodificada. */
function caracterQueEngana(texto) {
  if (!texto.isWellFormed() || texto.includes('\u{fffd}')) return 'no es texto UTF-8 válido';
  if (CONTROL_QUE_ENGANA.test(texto)) return 'tiene caracteres de control (como un retorno de carro o una secuencia de la terminal): en el cuadro se vería otra cosa que lo que corre';
  if (INVISIBLE_QUE_ENGANA.test(texto)) return 'tiene caracteres invisibles o de dirección: en el cuadro se leería otra cosa que lo que corre';
  return null;
}

// el cuadro muestra unos 20 renglones de una terminal de 80 columnas (76 sin su margen) y corta el principio sin aviso
const TOPE_RENGLONES = 20;
const COLUMNAS_CUADRO = 76;
// Todo lo que está desde U+1100 (donde empiezan los anchos) cuenta 2, y un emoji también: así no hace falta la tabla
// entera de anchos de Unicode, y lo que en verdad es angosto se cuenta de más, nunca de menos.
const ANCHO_DOBLE = /[\u{1100}-\u{10ffff}]|\p{Extended_Pictographic}/u;
/** Cuántos renglones de pantalla ocupa el texto: un tabulador avanza a la siguiente columna múltiplo de 8, un carácter
 * ancho o un emoji cuenta 2 y todo lo demás 1 (un combinante también: el conteo nunca queda por debajo de lo que se ve).
 * Lo que no entra en lo que queda del renglón baja entero al siguiente, como lo corta la pantalla. */
function renglonesDePantalla(texto) {
  let total = 0;
  for (const renglon of texto.split('\n')) {
    let filas = 1; let col = 0;
    for (const c of renglon) {
      const ancho = c === '\t' ? 8 - (col % 8) : ANCHO_DOBLE.test(c) ? 2 : 1;
      if (col + ancho > COLUMNAS_CUADRO) { filas++; col = 0; }
      col += c === '\t' ? 8 - (col % 8) : ancho;
    }
    total += filas;
  }
  return total;
}

/** Las reglas de la sentencia de la puerta (`validar_sentencia`), renglón por renglón como su grep: el motivo por el que
 * la rechazaría, o null. */
function sentenciaQueLaPuertaRechaza(texto) {
  const renglones = texto.split('\n');
  if (!texto.trim()) return 'la consulta está vacía';
  if (texto.startsWith('-')) return 'la consulta empieza con «-»: la puerta la tomaría como una opción';
  if (renglones.some((r) => /(?:^|\s)go(?:\s*$|\s*;)/i.test(r))) return 'la consulta tiene un separador de lote (GO)';
  if (renglones.some((r) => /^\s*(?::|!!)/.test(r))) return 'la consulta tiene un renglón que el cliente toma como un comando del cliente («:» o «!!»)';
  return null;
}

/**
 * El archivo de una consulta: común (no un enlace, una carpeta ni un dispositivo), de 64 KB o menos, texto UTF-8, no
 * protegido por el freno, terminado en `.sql` y fuera de una carpeta oculta. Lo que el freno lee le llega al asistente en
 * el mensaje, así que no lee otra cosa que una consulta: una credencial o un `.env` no se vuelven texto de la
 * conversación. Devuelve `{ texto }` o `{ error }`.
 */
function leerArchivoDeConsulta(ruta) {
  const fs = require('fs'); const path = require('path');
  const casa = process.env.HOME || require('os').homedir();
  const abs = ruta.startsWith('~/') ? path.join(casa, ruta.slice(2)) : path.resolve(carpetaDelComando || process.cwd(), ruta);
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { return { error: `no encuentro el archivo ${ruta} (${e.code || e.message})` }; }
  if (st.isSymbolicLink()) return { error: `${ruta} es un enlace: puede apuntar a otra cosa entre el cuadro y la puerta` };
  if (!st.isFile()) return { error: `${ruta} no es un archivo común` };
  if (st.size > TOPE_ARCHIVO) return { error: `${ruta} mide ${st.size} bytes: el tope es ${TOPE_ARCHIVO} (más que eso no se lee entero en pantalla)` };
  const base = path.basename(abs);
  if (NOMBRES_PROTEGIDOS.includes(base) || /^(?:production|produccion)\.log$/.test(base)) {
    return { error: `${ruta} es un archivo protegido por el freno, no una consulta` };
  }
  if (!/\.sql$/i.test(base)) return { error: `${ruta} no termina en .sql: el freno sólo lee consultas` };
  if (abs.split(path.sep).some((p) => p.startsWith('.') && p !== '.' && p !== '..')) {
    return { error: `${ruta} está dentro de una carpeta oculta: el freno sólo lee consultas, no lo que vive ahí` };
  }
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { return { error: `no pude leer ${ruta} (${e.code || e.message})` }; }
  let texto;
  try { texto = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { return { error: `${ruta} no es texto UTF-8` }; }
  const engano = caracterQueEngana(texto);
  if (engano) return { error: `${ruta} ${engano}` };
  return { texto };
}

function decidir(entrada) {
  let payload = {};
  try { payload = JSON.parse(entrada || '{}'); } catch (e) {
    // AC 14: un payload que no se pudo leer no es «no hay base». Si el texto crudo nombra algo de
    // bases, frena; si no, deja pasar (y lo anota).
    return emergencia(entrada, new Error(`payload ilegible: ${e.message}`));
  }
  // El comando se toma de tool_input.command venga con el nombre de herramienta que venga: Monitor
  // corre por el shell igual que Bash, y PowerShell (opt-in en macOS) nunca se probó — exigir
  // `tool_name === "Bash"` es justo el agujero por el que la Task 0 vio pasar a Monitor.
  const cmd = String((payload.tool_input && (payload.tool_input.command || payload.tool_input.script)) || '');
  if (!cmd.trim()) {
    if (CRUDO.test(String(entrada || '')) || nombraBorradoAzure(entrada)) return emergencia(entrada, new Error('payload sin comando reconocible y con nombres de bases o un borrado en Azure'));
    process.exit(0);
  }
  const esCodex = !!payload.turn_id && !payload.session_id_claude;   // precedente: on-skill-invoke.js
  carpetaDelComando = typeof payload.cwd === 'string' && require('path').isAbsolute(payload.cwd) ? payload.cwd : null;

  const nombraBases = CRUDO.test(cmd);
  if (cmd.length > MAX_CMD) {
    if (nombraBases || nombraBorradoAzure(cmd)) frenar(`ese comando mide ${Math.round(cmd.length / 1024)} KB (más de ${MAX_CMD / 1024} KB) y nombra algo de bases o un borrado en Azure: es demasiado largo para analizarlo a tiempo.`, [
      'Partilo en comandos más cortos, o pasá la consulta por la puerta.',
    ], { cmd: cmd.slice(0, 4096) });
    process.exit(0);
  }

  const { segmentos, tokens, PREFIJOS, expandir, variablesDelComando } = require(require('path').join(__dirname, '..', 'lib', 'shell-parse.js'));
  const partes = segmentos(cmd);
  const vars = variablesDelComando(cmd);

  // 🔴 Lo que va ESCONDIDO adentro de otro comando también se analiza: `bash -c '…'`, `eval`,
  // `python3 -c`, un heredoc, o un script que este comando ejecuta. Antes el texto crudo nombraba
  // bases, el parser no encontraba el servidor y el comando PASABA — con `bash -c` se leyó la
  // contraseña de producción del Llavero sin que nada frenara (revisores, 2026-09-15).
  const escondidos = textosEscondidos(cmd, partes, tokens, PREFIJOS, vars, expandir);
  const textos = [{ texto: cmd, partes, shell: true },
    ...escondidos.map((t) => ({ texto: t.texto, partes: segmentos(t.texto), shell: t.shell, contenido: t.contenido, ps: t.ps, codigo: t.codigo }))];
  // lo que se juzga como algo que corre: el contenido de un archivo que el comando no ejecuta queda afuera
  const ejecutados = textos.filter((x) => !x.contenido);

  // ── 1. el Llavero (AC 10) ───────────────────────────────────────────────────────────────────
  // Se busca `security` en CUALQUIER posición del segmento, no sólo como primer token: con
  // `nice -n 5 security …`, `sudo -u x security …` o `\security …` el programa quedaba escondido y
  // la regla no se aplicaba (pase adversarial 2026-09-15).
  for (const { texto } of ejecutados.flatMap((x) => x.partes)) {
    const t = tokensDeSegmento(texto, tokens, PREFIJOS);
    for (const i of dondeEsta(t, new Set(['security']))) {
      const veredicto = juzgarSecurity(t.slice(i));
      if (veredicto) frenar(veredicto, [
        'La contraseña de producción vive en el Llavero y NO pasa por la conversación.',
        'Si necesitás cargarla o cambiarla, la puerta deja un `.command` en el Escritorio y lo abrís vos.',
      ], { cmd, causa: 'llavero' }, 'produccion');      // el motivo cita el servicio tal como lo escribió el comando
    }
  }

  // ── 2. escrituras al catálogo o al índice (AC 9; story 8.14: leídas como las lee el shell) ────
  // Cada palabra se expande como la expandirían zsh y bash (llaves, rangos, formas de zsh, `$'…'`, variables y
  // arreglos del propio comando), se miran TODAS las redirecciones y la carpeta de trabajo, y se siguen los nombres
  // que arman `xargs`, `find` y una sustitución. Lo que no se puede leer dentro del alcance protegido frena.
  // Lo escondido que corre como shell (`bash -c`, `eval`, un heredoc a un shell, el texto que un `echo` le pasa a `sh`) se
  // juzga ADENTRO del recorrido, en el punto en que corre y con la carpeta de ese momento (pase adversarial, #40): ya no
  // como textos sueltos juzgados al final con la carpeta en que terminó el comando.
  const destino = escrituraProtegida(cmd, payload);
  if (destino) {
    frenar(destino.motivo, destino.indecidible ? [
      'El freno no ejecuta el comando: decide sobre el texto. Si esa palabra no nombra el catálogo, el índice ni la',
      'memoria de producción, escribila de forma literal (sin opciones del shell que cambien cómo se leen los nombres).',
    ] : [
      'El catálogo se edita con el editor (y eso abre un cuadro de aprobación); el índice lo regenera el arnés.',
      'Reescribir el catálogo o borrar el índice NO destraba un host de producción: la memoria es pegajosa.',
    ], { cmd, causa: destino.indecidible ? undefined : (/sale de la variable|arma una sustituci/.test(destino.motivo) ? 'nombre-armado' : 'escritura-protegida') },
    destino.indecidible ? 'nombre-indecidible' : 'produccion');
  }

  // ── 3. la puerta, sólo en su forma canónica (AC 11 y 12) ────────────────────────────────────
  // Se entra por POSICIÓN DE PROGRAMA, no por subcadena: `which tycon-prod-sql`, `cat`, `grep` o un
  // comentario que la nombren son rutina para quien mantiene el arnés, y frenarlos es como muere un
  // control (pase adversarial 2026-09-15, H4).
  // Se entra si la puerta está en posición de programa, o si el segmento la nombra y su programa NO
  // es un lector: así `bash -c '…tycon-prod-sql…'`, `eval` y `xargs` siguen frenados (esconden la
  // invocación dentro de un argumento), y `which`/`cat`/`grep`/`man`/`echo` pasan.
  // 🔴 El nombre de la puerta, ENTERO y no como pedazo de otro nombre: `scripts/tests/tycon-prod-sql.test.sh`
  // —la propia suite de la puerta— contiene el nombre adentro, y correrla se frenaba como «invocación no
  // canónica» (2026-09-15, en vivo, el tercer falso positivo de esta familia en un día).
  const NOMBRA_PUERTA = new RegExp(`(?<![\\w-])${NOMBRE_PUERTA}(?![\\w.-])`);
  const invocaLaPuerta = partes.some(({ texto }) => {
    if (!NOMBRA_PUERTA.test(texto) && !NOMBRA_PUERTA.test(sinComillas(texto))) return false;
    const t = tokensDeSegmento(texto, tokens, PREFIJOS);
    if (!t.length) return false;
    const prog = basename(t[0]);
    if (prog === NOMBRE_PUERTA || t[0] === PUERTA) return true;
    return !LECTORES_DE_TEXTO.has(prog);
  });
  if (invocaLaPuerta) {
    const limpio = cmd.trim();
    // 🔴 UN SOLO segmento: el host de la forma canónica era `\S+` y aceptaba `;`, `&&`, `|`, `$(…)`
    // y `` ` `` — el shell parte ahí y la segunda mitad corría SIN pasar por la puerta (ejecución
    // arbitraria aprobada por el freno; pase adversarial 2026-09-15, el hallazgo más grave).
    const unSoloSegmento = partes.length === 1;
    // La consulta desde un archivo no pasa: el cuadro muestra el comando, no lo que trae el archivo. Si el archivo se puede
    // pasar a una consulta en línea, el mensaje trae ese comando listo para pegar. En Codex no: ahí la puerta no se acepta.
    const pideArchivo = partes.some(({ texto }) => tokensDeSegmento(texto, tokens, PREFIJOS).some((x) => x === '--file' || x.startsWith('--file=')));
    if (pideArchivo) {
      const motivo = 'el cuadro de aprobación no muestra el contenido de un archivo: la consulta va en línea.';
      const enLinea = `Escribí la consulta entre comillas simples, en el mismo comando: ${PUERTA} <host> 'select …'`;
      if (esCodex) frenar(motivo, ['Y en Codex la puerta no puede abrir el cuadro: pasale la sentencia al dev para que la corra él por la puerta.'], { cmd }, 'puerta-no-canonica');
      const fa = unSoloSegmento ? FORMA_ARCHIVO.exec(limpio) : null;
      if (!fa) frenar(motivo, [enLinea], { cmd }, 'puerta-no-canonica');
      const v = leerArchivoDeConsulta(fa[2]);
      const listo = v.error ? null : `${PUERTA} ${fa[1]} '${v.texto.replace(/'/g, "'\\''")}'${fa[4] ? ` --max-filas ${fa[4]}` : ''}`;
      const renglones = listo ? renglonesDePantalla(listo) : 0;
      const problema = v.error || sentenciaQueLaPuertaRechaza(v.texto)
        || (renglones > TOPE_RENGLONES ? `la consulta ocupa ${renglones} renglones de pantalla y el cuadro muestra unos ${TOPE_RENGLONES}: partila en consultas más cortas` : null);
      if (problema) frenar(motivo, [`Y ${fa[2]} no se puede pasar a una consulta en línea: ${problema}.`, enLinea], { cmd }, 'puerta-no-canonica');
      frenar(motivo, ['El comando con la consulta del archivo en línea, listo para correr:', listo], { cmd }, 'puerta-no-canonica');
    }
    // lo que engañaría en el cuadro, en cualquier parte del comando: también en las puntas, que trim() recortaría
    const engano = caracterQueEngana(cmd);
    if (engano) frenar(`el comando ${engano}.`, ['Escribí la consulta sin esos caracteres y volvé a intentar.'], { cmd }, 'puerta-no-canonica');
    const canonica = unSoloSegmento && (CANONICA.test(limpio) || CANONICA_RECLAS.test(limpio) || CANONICA_VERIF.test(limpio) || CANONICA_CARGA.test(limpio) || CANONICA_FIREWALL.test(limpio) || CANONICA_CANDADOS.test(limpio) || CANONICA_BORRAR_GRUPO.test(limpio));
    // el cuadro corta sin aviso el principio de un comando largo: la consulta en línea tiene un tope de renglones
    if (canonica && CANONICA.test(limpio)) {
      const n = renglonesDePantalla(cmd);   // el cuadro recibe también lo que el shell ignora al final
      if (n > TOPE_RENGLONES) frenar(`el cuadro muestra unos ${TOPE_RENGLONES} renglones; este comando ocupa ${n}: partí la consulta en consultas más cortas.`, [
        'Lo que no entra se corta por arriba, sin aviso: aprobarías un comando sin haber visto su principio.',
      ], { cmd }, 'puerta-no-canonica');
    }
    if (!canonica) {
      frenar('la puerta se invocó de una forma que no es la canónica.', [
        'Sólo se acepta la ruta absoluta, sin nada antes ni después, y la sentencia en UN argumento',
        "entre comillas simples: /opt/tycon/bin/tycon-prod-sql <host> 'select …'",
        'Sin tuberías, sin redirecciones, sin $( ), sin encadenados, sin bash -c: la puerta ya corta',
        'filas y junta la salida, así que no necesita nada de eso.',
        "Si la sentencia lleva una comilla simple, escapala como en el shell: 'lo de '\\''adentro'\\'' así'.",
      ], { cmd });
    }
    if (esCodex) {
      frenar('en Codex la puerta no puede abrir el cuadro de aprobación de Claude Code.', [
        'Pasale la sentencia al dev para que la corra él por la puerta, o hacelo desde Claude Code.',
      ], { cmd });
    }
    const integridad = verificarPuerta();
    if (integridad) frenar(integridad, ['Reinstalá el freno con `scripts/production/install-guard.command` y volvé a intentar.'], { cmd });
    const secuestro = detectarSecuestro(cmd);
    if (secuestro) frenar(secuestro, [
      'Un alias o una función con ese nombre se queda con la sentencia antes de que llegue a la puerta.',
      'Sacalo de tu configuración del shell (o de este comando) y volvé a intentar.',
    ], { cmd });
    recordDecision({ freno: 'prod-access-guard', regla: 'puerta-no-canonica', veredicto: 'paso', cmd });
    process.exit(0);                                    // forma canónica y limpia: que decida el cuadro
  }

  // ── 3b. el borrado en Azure ────────────────────────────────────────────────────────
  // Borrar un grupo, un candado o un recurso se lleva un servidor con sus bases, y el catálogo declara servidores, no
  // grupos: el freno no puede saber qué contiene un grupo, así que frena todo borrado de grupo, sin mirar el catálogo ni
  // preguntarle a Azure (texto puro, dentro del reloj). `az resource delete` pasa si se lee el tipo de todo lo que borra
  // y nada es de Microsoft.Sql; si nombra un servidor SQL legible, lo decide el paso 4 con el catálogo, como siempre.
  // sólo lo que corre como comandos (de shell o de PowerShell): el cuerpo de un heredoc que va a `git commit -F -` o el
  // código de un intérprete no son comandos, y juzgarlos frenaba un mensaje de commit que nombra un borrado
  const comoComandos = ejecutados.filter((x) => x.shell || x.ps || (x !== textos[0] && !x.codigo && esGuionDeShell(x, escondidos)));
  let borrado = borradoDeAzure(comoComandos.flatMap((x) => x.partes), tokens, PREFIJOS);
  if (!borrado || !borrado.frena) {
    const correGuion = partes.some(({ texto }) => {
      const t = tokensDeSegmento(texto, tokens, PREFIJOS);
      if (!t.length) return false;
      const pr = basename(t[0]).toLowerCase().replace(/\.exe$/, '');
      return (CORRE_ARCHIVO.has(pr) && t.slice(1).some((a) => !a.startsWith('-') && /[./]/.test(a))) || /^\.?\//.test(t[0]);
    });
    // el cuerpo del heredoc queda como contenido de un archivo, o sin marca cuando el mismo comando lo corre
    const escritoYCorrido = correGuion && textos.find((x) => x !== textos[0] && !x.shell && !x.ps && !x.codigo && nombraBorradoAzure(x.texto));
    if (escritoYCorrido) borrado = { frena: true, que: 'desde un guion que este comando escribe y corre algo que puede ser un grupo, un candado o un servidor' };
  }
  if (!borrado || !borrado.frena) {
    const enCodigo = ejecutados.find((x) => x.codigo && nombraBorradoAzure(x.texto));
    if (enCodigo) borrado = { frena: true, que: 'desde el programa de un intérprete (python, node…) algo que puede ser un grupo, un candado o un servidor' };
  }
  if (borrado) {
    if (borrado.frena) {
      frenar(`ese comando borra ${borrado.que} en Azure, y eso puede llevarse un servidor de producción con sus bases: no puedo saber qué contiene.`, [
        'El freno no le pregunta a Azure qué hay adentro: frena todo borrado de grupo, de candado y de recurso del que no',
        'pueda probar que no es una base de datos.',
        'Un grupo de recursos que no es de producción se pide por la puerta, que pide la aprobación del dueño en el cuadro',
        'y comprueba en Azure qué contiene antes de borrar: /opt/tycon/bin/tycon-prod-sql --delete-group <grupo>',
        'Lo demás (un grupo con algo de producción, un candado, otro recurso) lo corre una persona en su propia terminal,',
        'fuera del asistente, después de mirar qué contiene. Detalle: guides/produccion-con-permiso.md',
      ], { cmd }, 'borrado-de-azure', { sinPuerta: true });
    }
  }

  // ── 4. servidores nombrados por cualquiera de los gatillos (AC 6, 7, 8) ─────────────────────
  const candidatos = ejecutados.flatMap((x) => servidoresNombrados(x.partes, tokens, PREFIJOS, vars, expandir));
  let clasificados = false;   // ¿se llegó a clasificar algún servidor? (story 2.6)
  const nombrados = candidatos.filter((c) => !c.benigno);
  if (!nombrados.length) {
    // 🔴 El texto nombra bases y NO se pudo ubicar ni un servidor, ni el Llavero, ni una escritura:
    // eso es «no pude analizarlo», no «no hay nada». Salvo que sea una herramienta de TEXTO (un
    // `grep sqlcmd`, un `cat` de estas notas), se frena (revisores, 2026-09-15).
    // 🔴 Sólo si quedó un pedazo OPACO: un `bash -c "$CMD"` cuyo texto no se puede ver, o un script
    // demasiado grande para leer. «Lo vi entero y no había ningún servidor» —un `az sql server list`,
    // un `command -v sqlcmd`— NO se frena: medido sobre 4.000 comandos reales, esa versión frenaba 4
    // que no tocaban ninguna base, y un freno así se apaga (2026-09-15).
    // 🔴 Ninguna marca de «algo ya se analizó» calla esta red: un tramo inofensivo del MISMO comando (un
    // `sqlcmd -S localhost`) le compraría permiso al tramo opaco de al lado (revisión final, 2026-09-15).
    if (nombraBases && escondidos.opaco && !soloLeeTexto(partes, tokens, PREFIJOS)) {
      frenar('ese comando nombra bases de datos y esconde lo que ejecuta, así que NO pude analizarlo.', [
        'Pasá la consulta por la puerta, o escribí el comando de forma directa (sin bash -c, sin eval,',
        'sin heredoc y sin esconderlo en un script) para que se pueda ver qué servidor toca.',
      ], { cmd });
    }
    process.exit(0);                                    // AC 15: silencio
  }

  if (vencido()) frenar('el freno se quedó sin tiempo para decidir y el comando nombra un servidor de base.', [], { cmd });
  // el reloj se vuelve a mirar después de construir el índice (abajo) y en cada salto de `ps`

  let indice;
  try {
    const mod = require(require('path').join(__dirname, '..', 'production', 'production-index.js'));
    indice = mod.leer({ home: process.env.HOME });
    var clasificar = mod.clasificar;                                              // eslint-disable-line no-var
    if (indice.memoria_alterada) {
      frenar('la memoria de producción fue tocada a mano (su huella no cierra).', [
        'Mientras tanto no se decide nada sobre bases: verificá con `/opt/tycon/bin/tycon-prod-sql --verificar`.',
      ], { cmd });
    }
  } catch (e) {
    frenar(`no pude leer el índice de servidores (${e.message}).`, [], { cmd });
  }
  if (vencido()) frenar('el freno se quedó sin tiempo mientras leía el índice, y el comando nombra un servidor de base.', [], { cmd });

  // El comando directo de Azure para el firewall sigue frenado; el mensaje dice el único camino: la puerta.
  const esFirewall = /\baz\s+sql\s+server\s+firewall-rule\b/.test(cmd);
  const caminoFirewall = (h) => (esFirewall
    ? [`Para habilitar la IP de esta máquina en el firewall, el único camino es la puerta (con su cuadro, y la regla se cierra sola): /opt/tycon/bin/tycon-prod-sql --open-firewall ${h && h.includes('.') ? h : `${h || '<host>'}.database.windows.net`}`]
    : []);
  for (const n of nombrados) {
    if (n.host === null) {
      frenar(`ese comando nombra un servidor de base que no es un literal (${n.crudo}).`, [
        'Un valor que sale de una variable no se puede clasificar: se trata como producción.',
        'Escribí el host tal cual, o declaralo en el .tycon/production.json del repo de ese proyecto.',
      ], { cmd, crudo: n.crudo, causa: 'servidor-no-literal' }, 'produccion');   // el motivo cita el texto del comando
    }
    const c = clasificar(n.host, indice);
    // 🔴 story 2.6 · ESTO es un `paso` y hay que anotarlo: se miró un servidor y NO era producción.
    //    Anotar sólo los bloqueos hacía que la ficha mostrara este freno bloqueando casi siempre,
    //    cuando en realidad deja pasar casi todo — un numerador sin su denominador (revisor de
    //    fallos silenciosos, 2026-09-16).
    if (c.estado === 'no-produccion') { clasificados = true; continue; }
    if (c.estado === 'produccion') {
      frenar(`«${n.host}» está declarado como PRODUCCIÓN${c.repos.length ? ` (en ${c.repos.join(', ')})` : ' (por memoria del propio arnés)'}.`, [
        c.desde === 'memoria'
          ? 'Ese host ya se vio como producción antes; el catálogo de ahora dice otra cosa y no alcanza.'
          : 'Toda consulta a producción pasa por la puerta y la aprobás vos, sentencia por sentencia.',
        `Si de verdad ya no es producción: /opt/tycon/bin/tycon-prod-sql --reclasificar ${n.host}`,
        ...caminoFirewall(n.host),
      ], { cmd, host: n.host, repos: c.repos, causa: 'base-de-produccion' }, 'produccion');
    }
    // desconocido
    frenar(`«${n.host}» no está declarado en ningún proyecto de esta máquina.`, [
      'Lo que no está declarado se trata como producción.',
      ...caminoFirewall(n.host),
      `Si es de un ambiente de prueba, declaralo en <repo>/.tycon/production.json:`,
      `  {"servers":[{"host":"${n.host}","environment":"non-production"}]}`,
      indice.catalogos.length
        ? `  (catálogos que hoy conoce esta máquina: ${indice.catalogos.map((c2) => c2.repo).join(', ')})`
        : '  (esta máquina no tiene NINGÚN catálogo: revisá la raíz de repos con `node scripts/lib/repos-root.js`)',
      ...((indice.errores || []).length
        ? ['', `  ⚠ hay catálogos ILEGIBLES, y sus hosts quedan desconocidos: ${indice.errores.map((e) => `${e.repo} (${e.motivo})`).join(' · ')}`]
        : []),
    ], { cmd, host: n.host }, 'host-no-declarado');
  }
  if (clasificados) recordDecision({ freno: 'prod-access-guard', regla: 'produccion', veredicto: 'paso', cmd });
  process.exit(0);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────
// El shell se come los backslashes de escape: `\security` ejecuta `security` (sin expandir alias).
// Sin des-escapar, el freno miraba un programa llamado «\security» y se salteaba la regla entera
// (pase adversarial 2026-09-15).
const desescapar = (tok) => String(tok).replace(/\\(?=.)/g, '');
const basename = (p) => desescapar(p).split('/').pop();
const sinComillas = (s) => String(s).replace(/['"]/g, '');

/** Tokens del segmento sin los prefijos (variables, sudo/env/nice…) ni sus banderas sueltas. */
function tokensDeSegmento(texto, tokens, PREFIJOS) {
  const t = tokens(texto.replace(PREFIJOS, ''));
  // `nice -n 5 security …` y `sudo -u deva security …`: PREFIJOS come la palabra pero no su bandera
  // con argumento, y el programa quedaba escondido detrás (pase adversarial 2026-09-15).
  let i = 0;
  while (i < t.length && /^-/.test(t[i])) { i += (/^-[a-zA-Z]$/.test(t[i]) && t[i + 1] !== undefined && !/^-/.test(t[i + 1])) ? 2 : 1; }
  return t.slice(i);
}

/** ¿Todos los segmentos son herramientas de TEXTO? (un `grep sqlcmd`, un `cat` de notas: no tocan bases) */
function soloLeeTexto(partes, tokens, PREFIJOS) {
  const SOLO_TEXTO = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'bat', 'less', 'more', 'head', 'tail', 'echo', 'printf', 'man', 'wc', 'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'diff', 'ls', 'find', 'stat', 'file', 'which', 'type', 'whence', 'git', 'sed', 'awk', 'column', 'open', 'code', 'tee']);
  const segs = partes.filter(({ texto }) => texto.trim());
  if (!segs.length) return false;
  return segs.every(({ texto }) => {
    const t = tokensDeSegmento(texto, tokens, PREFIJOS);
    if (!t.length) return true;
    const prog = basename(t[0]);
    if ((prog === 'sed' || prog === 'awk') && t.some((x) => /^-i/.test(x))) return false;   // escriben
    return SOLO_TEXTO.has(prog);
  });
}

// Intérpretes que reciben el programa en un argumento, y la bandera con la que lo reciben.
const INTERPRETES = { bash: ['-c'], sh: ['-c'], zsh: ['-c'], ksh: ['-c'], dash: ['-c'], python: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p', '--print'], perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], pwsh: ['-Command', '-c'], powershell: ['-Command', '-c'], osascript: ['-e'], security: ['-i'] };
const CORRE_ARCHIVO = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'osascript', 'source', '.', 'pwsh', 'powershell']);
const MAX_ESCONDIDO = 64 * 1024;

/**
 * Los textos que este comando va a EJECUTAR y que no están a la vista: el argumento de `-c`/`-e`, el
 * cuerpo de un heredoc, y el contenido de un script que el comando corre.
 * @returns {string[]}
 */
function textosEscondidos(cmd, partes, tokens, PREFIJOS, vars = {}, expandir = null) {
  const fs = require('fs');
  const out = [];
  // `shell`: el texto se ejecuta como comandos de shell (y entonces sus rutas son destinos de
  // escritura de verdad). El cuerpo de un heredoc de python, o un YAML, NO lo es: sus rutas son
  // datos, y tratarlas como escrituras frenaba editar un pipeline que menciona `.tycon/**` en su
  // lista de disparadores — medido sobre 4.000 comandos reales (2026-09-15).
  // El cuerpo de un heredoc REDIRIGIDO a un archivo (`cat > x <<EOF`, `tee x <<EOF`) tampoco: es el
  // contenido del archivo. Lo decide `heredocAlimentaShell` (2026-09-16); el destino de esa
  // redirección lo juzga `escrituraProtegida` sobre la línea del `<<`, que `sinHeredocs` conserva.
  let opaco = false;
  // `contenido`: el texto sólo se guarda en un archivo que este comando no ejecuta (`heredocSoloAArchivo`); no se lee
  // buscando servidores ni el Llavero
  const agregar = (t, shell, contenido = false, ps = false, codigo = false) => {
    if (t === null || t === undefined) { opaco = true; return; }
    const v = String(t);
    if (!v.trim()) return;
    if (v.length > MAX_ESCONDIDO) { opaco = true; return; }
    // el mismo texto que vuelve como shell sube la marca: un heredoc a un archivo con el mismo texto que un `bash -c`
    // posterior dejaba al `bash -c` como «contenido» (pase adversarial de la 8.14 A, #42); por la misma razón, un texto
    // que llega también por otra vía deja de ser contenido
    const previo = out.find((x) => x.texto === v);
    if (previo) { if (shell) previo.shell = true; if (ps) previo.ps = true; if (codigo) previo.codigo = true; if (!contenido) previo.contenido = false; }
    else out.push({ texto: v, shell: !!shell, contenido, ps: !!ps, codigo: !!codigo });
  };

  // (a) cuerpos de heredoc: `bash <<EOF … EOF` — `sinHeredocs` los borra del análisis normal. El cierre es el del shell
  // (`<<\EOF` y `<<E"OF"` cierran en `EOF`): con el delimitador tal como está escrito, lo que sigue al cierre real se
  // ejecutaba y acá se leía como cuerpo
  const { heredocs } = require(require('path').join(__dirname, '..', 'lib', 'shell-parse.js'));
  for (const h of heredocs(cmd)) {
    const shell = heredocAlimentaShell(cmd, h.indice, partes, tokens, PREFIJOS, vars, expandir);
    const linea = cmd.slice(cmd.lastIndexOf('\n', h.indice) + 1, h.indice);
    const tl = tokensDeSegmento(linea.split(/[;&|]/).pop() || '', tokens, PREFIJOS);
    const progH = tl.length ? basename(tl[0]).toLowerCase().replace(/\.exe$/, '') : '';
    agregar(h.cuerpo, shell, !shell && heredocSoloAArchivo(cmd, h.indice, partes, tokens, PREFIJOS, vars, expandir), false,
      !shell && (Boolean(INTERPRETES[progH]) || CORRE_ARCHIVO.has(progH)));
  }

  for (const { texto } of partes) {
    const t = tokensDeSegmento(texto, tokens, PREFIJOS);
    if (!t.length) continue;
    const prog = basename(t[0]);
    // (b) `eval …`: todo lo que sigue es un comando
    if (prog === 'eval') { agregar(t.slice(1).join(' '), true); continue; }
    // (c) el argumento del intérprete (`bash -c '…'`, `python3 -c '…'`, `node -e '…'`)
    // en Windows el intérprete lleva `.exe` (`pwsh.exe`, `powershell.exe`), y PowerShell no distingue mayúsculas en sus
    // banderas (`-command`)
    const progN = prog.toLowerCase().replace(/\.exe$/, '');
    const esPs = progN === 'pwsh' || progN === 'powershell';
    const banderas = INTERPRETES[progN];
    if (banderas) {
      for (let i = 1; i < t.length; i++) {
        if (!(esPs ? banderas.some((b) => b.toLowerCase() === t[i].toLowerCase()) : banderas.includes(t[i]))) continue;
        // un intérprete SIN su texto (`bash -c "$CMD"`, con la variable definida afuera) es opaco:
        // no se puede ver qué corre, y eso NO es lo mismo que «lo vi y no había nada».
        if (t[i + 1] === undefined || NO_LITERAL.test(t[i + 1])) { opaco = true; continue; }
        agregar(t[i + 1], ES_SHELL.has(prog), false, esPs, !ES_SHELL.has(prog) && !esPs);
      }
    }
    // (d) el CONTENIDO del script que este comando ejecuta (el camino fácil: escribirlo y correrlo)
    if (CORRE_ARCHIVO.has(progN) || /^\.?\//.test(t[0])) {
      for (let i = CORRE_ARCHIVO.has(progN) ? 1 : 0; i < t.length; i++) {
        const a = t[i];
        if (!a || a.startsWith('-')) continue;
        if (!/[./]/.test(a)) continue;
        const ruta = a.replace(/^~(?=\/)/, process.env.HOME || '');
        // 🔴 Sólo se mira ADENTRO de un guion RECIÉN FABRICADO: uno en una carpeta temporal, o uno que
        // este mismo comando acaba de escribir. El camino que esto cierra es «escribo un script y lo
        // corro»; mirar adentro de CUALQUIER guion del disco frena el trabajo normal — el día de la
        // instalación, `node scripts/hooks/prod-access-guard.js` (probar el propio hook) se frenaba a
        // sí mismo, porque su código fuente habla del Llavero (2026-09-15, en vivo).
        const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const abs = require('path').resolve(ruta);          // un `bash leer.sh` también cuenta
        // Las piezas del propio freno NO son texto escondido: su código fuente habla del Llavero y de
        // los clientes de base porque ESO es lo que vigilan. Leerlas como si fueran un guion ajeno
        // hace que el freno se frene a sí mismo (2026-09-15).
        // (con el nombre de antes del renombre a inglés también: su reemplazo sigue en la carpeta vieja)
        // Se reconocen por el nombre Y por dónde viven (la instalación en /opt o el arnés de este mismo freno): un guion
        // recién hecho en otra carpeta con el nombre de una pieza se lee igual que cualquiera.
        const raizDelFreno = require('path').resolve(__dirname, '..', '..') + require('path').sep;
        const esDelFreno = /(?:tycon-prod-sql|prod-access-guard\.js|node-shim\.sh|production-index\.js|indice-produccion\.js|production-notice\.js|produccion-notice\.js)$/.test(abs)
          && (abs.startsWith('/opt/tycon/') || abs.startsWith(raizDelFreno));
        const esTemporal = !esDelFreno && (
             /^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)/.test(abs)
          || (process.env.TMPDIR && abs.startsWith(require('path').resolve(process.env.TMPDIR)))
          || /\/scratchpad\//.test(abs));
        const loEscribeEsteComando = new RegExp(`>\\s*['"]?${esc}`).test(cmd)
          || new RegExp(`(?:tee|cp|mv|install)\\b[^\\n]*${esc}`).test(cmd);
        try {
          if (esDelFreno || (!esTemporal && !loEscribeEsteComando)) break;   // ya vivía en el disco: no se mira adentro
          const st = fs.statSync(ruta);
          // `shell: false` a propósito: el CONTENIDO se mira por si nombra un servidor o el Llavero,
          // pero sus escrituras son suyas, no de este comando.
          // el guion lo corre un shell (`bash x.sh`, `./x.sh`) o un intérprete: el paso del borrado en Azure lo lee como
          // comandos en el primer caso y como código en el segundo
          const porShell = ES_SHELL.has(prog) || prog === 'source' || prog === '.' || /^\.?\//.test(t[0]);
          if (st.isFile() && st.size <= MAX_ESCONDIDO) {
            const texto = fs.readFileSync(ruta, 'utf8');
            agregar(texto, false, false, false, !porShell);
            const e = out.find((y) => y.texto === texto);
            if (e && porShell) e.guion = true;
          }
          else if (st.isFile()) opaco = true;
        } catch { /* no existe o no se puede leer: no es un script que vayamos a ver */ }
        break;                                   // sólo el primer argumento no-bandera: el script
      }
    }
  }
  out.opaco = opaco;
  return out;
}

/**
 * ¿El cuerpo del heredoc que empieza en `indice` (posición del `<<`) se EJECUTA como shell?
 *
 * La regla (2026-09-16): el cuerpo es COMANDOS si en la línea del `<<` hay un programa que ejecuta lo
 * que recibe (`bash <<EOF`, `sudo bash <<EOF`, `ssh host bash <<EOF`, `cat <<EOF | bash`, `xargs rm
 * <<EOF`), o si no se puede saber qué lo consume (`$CMD <<EOF`, una línea sin programa). Es CONTENIDO
 * si va a un archivo (`cat > x <<EOF`, `tee x <<EOF`) o a otro intérprete (python, node, sqlcmd, un
 * YAML a kubectl): sus rutas son datos. El destino de la redirección se juzga aparte, en la línea.
 * 🔴 Con UNA excepción, por el lado seguro: si este mismo comando después EJECUTA el archivo al que
 * redirigió el heredoc con un shell (`cat > /tmp/x.sh <<'SH' … SH; bash /tmp/x.sh`, `chmod +x … &&
 * ./x.sh`), el cuerpo sí son comandos de este comando — «escribo un guion y lo corro» es el camino
 * fácil que la regla (d) de `textosEscondidos` cierra, y ahí el archivo todavía no existe para leerlo
 * del disco. Si el destino o lo ejecutado no son literales (`cat > "$F"` … `bash "$F"`), es duda, y
 * la duda frena.
 * @returns {boolean}
 */
function heredocAlimentaShell(cmd, indice, partes, tokens, PREFIJOS, vars, expandir) {
  const path = require('path');
  const { segmentos, parseSimpleCommand, OPERADOR_HEREDOC } = require(path.join(__dirname, '..', 'lib', 'shell-parse.js'));
  const ini = cmd.lastIndexOf('\n', indice) + 1;
  const finLinea = cmd.indexOf('\n', indice);
  const linea = cmd.slice(ini, finLinea < 0 ? cmd.length : finLinea)
    .replace(new RegExp(OPERADOR_HEREDOC.source, 'g'), ' ');     // sin los operadores: queda el comando
  // 🔴 Sin cortar en `$(…)`: `T=$(date …) && cat > "$D/x" <<'EOF'` partido en el `$(` dejaba un segmento `T=` «sin
  // programa», que se leía como duda, y el cuerpo (el CONTENIDO de un archivo) se juzgaba como comandos (medición T30 de la
  // tanda A, segunda corrida: un freno falso con un cuerpo que mencionaba `.tycon/…` en prosa).
  const segs = segmentos(linea, { keepSubst: true });
  if (!segs.length) return true;                                  // `<<EOF` solo: no sé quién lo consume
  const destinos = [];                                            // a qué archivos se redirige la línea
  let destinoOpaco = false;
  for (const { texto } of segs) {
    // una asignación sola (`T=$(date)`, `D="…"`) no lee la entrada estándar: no consume el heredoc
    const ppL = parseSimpleCommand(texto);
    if (!ppL.words.length && ppL.assignments.length && !ppL.redirections.length) continue;
    const t = tokensDeSegmento(texto, tokens, PREFIJOS);
    if (!t.length) return true;                                   // un segmento sin programa: duda
    if (NO_LITERAL.test(t[0])) return true;                       // `$CMD <<EOF`: no sé qué corre
    if (CONSUME_COMO_SHELL_SI_ES_PROGRAMA.has(basename(t[0]))) return true;
    if (t.some((x) => CONSUME_COMO_SHELL.has(basename(x).toLowerCase()))) return true;
    // `> destino`, `>> destino`, `&> destino`, `>| destino` (no `2>&1`), y los argumentos de `tee`
    const red = /(?:^|\s)(?:\d?>>?\|?|&>>?)\s*(?!&)("[^"]+"|'[^']+'|\S+)/g;
    let m; while ((m = red.exec(texto))) destinos.push(sinComillas(m[1]));
    if (basename(t[0]) === 'tee') for (const a of t.slice(1)) if (!a.startsWith('-')) destinos.push(a);
  }
  if (!destinos.length) return false;                             // va a python, a un YAML, a la pantalla
  const resolver = (x) => {
    if (!expandir) return NO_LITERAL.test(x) ? null : path.resolve(x.replace(/^~(?=\/|$)/, process.env.HOME || ''));
    const r = NO_LITERAL.test(x) ? expandir(x, vars) : x;
    return r === null || NO_LITERAL.test(r) ? null : path.resolve(r.replace(/^~(?=\/|$)/, process.env.HOME || ''));
  };
  const rutasDestino = destinos.map(resolver);
  if (rutasDestino.some((r) => r === null)) destinoOpaco = true;
  // ¿este comando ejecuta alguno de esos archivos? (con un shell, o directo — intérprete desconocido)
  const SHELL_DE_ARCHIVO = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'source', '.']);
  let ejecutaOpaco = false;
  for (const { texto } of partes) {
    // una asignación sola (`D="…/x-$T"`) no ejecuta nada: leída como programa sin resolver, volvía «duda» al cuerpo
    if (!parseSimpleCommand(texto).words.length) continue;
    const t = tokensDeSegmento(texto, tokens, PREFIJOS);
    if (!t.length) continue;
    const prog = basename(t[0]);
    let candidatos = [];
    if (SHELL_DE_ARCHIVO.has(prog)) candidatos = t.slice(1).filter((a) => a && !a.startsWith('-'));
    else if (/^\.?\//.test(t[0]) || NO_LITERAL.test(t[0])) candidatos = [t[0]];
    else if (CORRE_ARCHIVO.has(prog)) continue;                   // python/node corren el archivo: es contenido suyo, no shell
    for (const a of candidatos) {
      const r = resolver(a);
      if (r === null) { ejecutaOpaco = true; continue; }
      if (rutasDestino.includes(r)) return true;                  // lo escribe y lo corre: son comandos de este comando
    }
  }
  return (destinoOpaco && ejecutaOpaco) || (destinoOpaco && partes.some(({ texto }) => {
    const t = tokensDeSegmento(texto, tokens, PREFIJOS);
    return t.length > 0 && (SHELL_DE_ARCHIVO.has(basename(t[0])) || /^\.?\//.test(t[0]));
  })) || (ejecutaOpaco && rutasDestino.some((r) => r !== null));  // un lado sin resolver y el otro con algo: duda
}

/**
 * ¿El cuerpo del heredoc que empieza en `indice` es SÓLO el contenido de un archivo que este comando no ejecuta?
 *
 * Se decide por LISTA CERRADA, no por «nadie lo corre»: verdadero sólo si
 *   - TODOS los tramos del comando corren un programa inofensivo (`INOFENSIVOS`), sin prefijos (`sudo`, `env`) ni
 *     asignaciones (`PATH=…` cambia qué corre después), y sin `$(…)`, comillas invertidas, `<(…)`/`>(…)`, paréntesis
 *     ni llaves fuera de los cuerpos (un `python3 > out <<EOF` queda afuera: python no está en la lista);
 *   - cada destino que escribe cualquier tramo (`>`, `>|`, `&>` y los argumentos de `tee`, leídos por el parser del
 *     shell) es un archivo con nombre literal, sin comodines, sin anexar, bajo la carpeta personal o una temporal por su
 *     ruta real, fuera de `~/Library` y sin carpetas ocultas (`~/.zshrc`, `.git/hooks/`); no se llama como un guion que
 *     otro corre (`Makefile`, `package.json`, `*.sh`…, exista o no) y, si ya existe, no es un enlace ni tiene permiso de
 *     ejecución. Un error del sistema de archivos que no sea «no existe», o un destino relativo sin la carpeta del
 *     evento, cuenta como duda.
 * Medido con la primera versión, que liberaba el cuerpo si «ningún tramo corre el archivo»: 68 caminos de ejecución
 * pasaban (`bash -c 'bash x'`, `sh < x`, `cat x | sh`, `xargs`, `tee >(sh)`, `PATH=.:$PATH x`, `cat >> ~/.bashrc`,
 * un `node -e` que carga el archivo, `make`…). Con la lista, cualquier otro programa vuelve a juzgar el cuerpo como siempre.
 * Ese contenido no se lee buscando servidores ni el Llavero: `const server = …` en un archivo de código cumplía la cadena
 * de conexión `Server=` y frenaba. Ante cualquier duda, falso.
 * @returns {boolean}
 */
// la carpeta en que corre el comando (la del evento): contra ella se resuelve un destino relativo
let carpetaDelComando = null;
// sin `chmod`: volvería ejecutable lo que se acaba de escribir
const INOFENSIVOS = new Set(['cat', 'tee', 'mkdir', 'touch', 'echo', 'printf', 'ls', 'true']);
function heredocSoloAArchivo(cmd, indice, partes, tokens, PREFIJOS, vars, expandir) {
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const { parseSimpleCommand, sinHeredocs, heredocs } = require(path.join(__dirname, '..', 'lib', 'shell-parse.js'));
  if (/\$\(|`|[<>]\(|[(){}]/.test(sinHeredocs(cmd))) return false;
  // Con el delimitador sin comillas (`<<EOF`) el shell expande el cuerpo: un `$(…)` o una comilla invertida adentro SE
  // EJECUTA. Sólo se libera un cuerpo con delimitador entre comillas, o sin `$` ni comillas invertidas.
  // El cierre es el del shell (`<<\EOF` y `<<E"OF"` cierran en `EOF`); el delimitador, de letras, números, `_`, `.` y `-`
  const h = heredocs(cmd).find((x) => x.indice === indice);
  if (!h || !/^[A-Za-z0-9_.-]+$/.test(h.delim) || (!h.comillas && /[$`]/.test(h.cuerpo))) return false;
  // Todos los tramos, no sólo la línea del `<<`: un `echo … > ~/.zshrc` al lado también escribe. Las redirecciones las
  // lee el parser del shell (`>&archivo` y `a>archivo` también escriben; una regex con espacio delante no las veía).
  const destinos = [];
  for (const { texto } of partes) {
    const pp = parseSimpleCommand(texto);
    // una asignación sola cambia qué corre después (`PATH=/tmp/b:$PATH; ls` con `/tmp/b/ls` recién escrito): afuera
    if (!pp.words.length || pp.assignments.length) return false;
    const t = tokens(texto.trim());
    if (!t.length || !INOFENSIVOS.has(t[0])) return false;        // sin ruta ni prefijo: `cat`, no `/x/cat` ni `sudo cat`
    for (const r of pp.redirections) {
      if (r.dup && /^\d+$/.test(String(r.target))) continue;       // `2>&1`: no es un archivo
      if (!r.write) continue;                                      // `< x`: lee, no escribe
      if (r.dup || !['>', '>|', '&>'].includes(r.op)) return false; // anexar (`>>`) u otra forma que no leo
      destinos.push(sinComillas(String(r.target)));
    }
    if (t[0] === 'tee') {
      const args = pp.words.slice(1).filter((w) => w !== '__HEREDOC__');
      if (args.some((a) => /^-/.test(a))) return false;            // `tee -a` y banderas que no sé leer
      destinos.push(...args.map(sinComillas));
    }
  }
  const casa = os.homedir();
  const raices = [casa, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  // Cada error que no sea «no existe» vuelve null (= se juzga el cuerpo): un permiso negado o un enlace en bucle no son
  // «una ruta normal». Una carpeta que todavía no existe se juzga por su antecesor más cercano que sí, por su ruta real.
  const real = (p) => {
    const resto = [];
    for (let actual = p; ; actual = path.dirname(actual)) {
      try { return path.join(fs.realpathSync(actual), ...resto.reverse()); } catch (e) {
        if (e.code !== 'ENOENT' || actual === path.dirname(actual)) return null;
        try { fs.lstatSync(actual); return null; } catch { /* no existe ni como enlace: se sube */ }   // un enlace roto
        resto.push(path.basename(actual));
      }
    }
  };
  const resolver = (x) => {
    const r = NO_LITERAL.test(x) ? (expandir ? expandir(x, vars) : null) : x;
    if (r === null || NO_LITERAL.test(r) || /[*?[\]{}\\]/.test(r)) return null;
    if (/^~(?!\/|$)/.test(r)) return null;                           // `~otro/x`: la carpeta de otro usuario
    if (!path.isAbsolute(r) && !/^~/.test(r) && !carpetaDelComando) return null;   // relativa sin la carpeta del evento
    const abs = path.resolve(carpetaDelComando || '/', r.replace(/^~(?=\/|$)/, casa));
    if (abs === '/dev/null') return abs;
    // un guion que otro corre (`make`, `npm`, `bash x.sh`, en este comando o en el siguiente) no es contenido, exista o no
    // sin mayúsculas: el disco de la Mac no las distingue, y `make` encuentra un `MAKEFILE`
    if (/^(?:makefile|gnumakefile|package\.json|dockerfile|.*\.(?:sh|bash|zsh|command))$/i.test(path.basename(abs))) return null;
    // el archivo, si ya existe, no puede ser un enlace ni tener permiso de ejecución
    let st = null;
    try { st = fs.lstatSync(abs); } catch (e) { if (e.code !== 'ENOENT') return null; }
    if (st && (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o111))) return null;
    // la carpeta, por su ruta real: un enlace a `~/.git/hooks` no cuenta como `/tmp`
    const dir = real(path.dirname(abs));
    return dir === null ? null : path.join(dir, path.basename(abs));
  };
  const casaReal = real(casa) || casa;
  // `/dev/null` no es un destino: sin otro, el cuerpo no va a ningún archivo y no hay nada que liberar
  const rutas = destinos.map(resolver).filter((r) => r !== '/dev/null');
  if (!rutas.length) return false;
  // comparado en minúsculas: `~/library/LaunchAgents` es `~/Library/LaunchAgents` en el disco de la Mac
  const bajo = (r, raiz) => r.toLowerCase().startsWith(raiz.toLowerCase() + path.sep);
  return rutas.every((r) => r !== null
    && [...raices, casaReal].some((raiz) => bajo(r, raiz))
    && !bajo(r, path.join(casa, 'Library')) && !bajo(r, path.join(casaReal, 'Library'))
    && !r.split(path.sep).some((parte) => parte.startsWith('.')));
}

/** Índices de los tokens cuyo basename (des-escapado) es alguno de `nombres`, en CUALQUIER posición. */
// 🔴 Sin mayúsculas/minúsculas: PowerShell no las distingue, y `Invoke-Sqlcmd` (la forma real, que
// es como la escribe todo el mundo) no coincidía con la lista, que está en minúscula. El freno
// escucha el matcher PowerShell desde el primer día, así que el agujero era de parseo, no de alcance
// (revisores, 2026-09-15).
function dondeEsta(t, nombres) {
  const out = [];
  for (let i = 0; i < t.length; i++) if (nombres.has(basename(t[i]).toLowerCase())) out.push(i);
  return out;
}

/** @returns {string|null} el motivo del freno, o null si ese `security` es legítimo */
function juzgarSecurity(t0) {
  // `security -q find-generic-password …`: las opciones globales van ANTES del subcomando, y el
  // freno tomaba `-q` como subcomando y dejaba pasar (revisores, 2026-09-15). Se saltean
  // las opciones globales (menos -i, que es la peligrosa y se juzga abajo).
  let k = 1;
  while (k < t0.length && /^-[a-zA-Z]+$/.test(t0[k]) && t0[k] !== '-i') k++;
  const t = [t0[0], ...t0.slice(k)];
  const sub = t[1] || '';
  // `security -i` lee los subcomandos de la ENTRADA ESTÁNDAR: el que importa no está en el texto que
  // el freno puede ver (pase adversarial 2026-09-15). No se puede juzgar → no pasa.
  if (sub === '-i' || sub === '--interactive') return 'ese comando abre `security` en modo interactivo: los subcomandos viajan por la entrada estándar y el freno no puede verlos.';
  const SIEMPRE = new Set(['dump-keychain', 'export']);
  if (SIEMPRE.has(sub)) return `ese comando vuelca secretos del Llavero (\`security ${sub}\`).`;
  const CAMBIA = new Set(['add-generic-password', 'set-generic-password-partition-list', 'delete-generic-password']);
  const LEE = new Set(['find-generic-password', 'find-internet-password']);
  if (!CAMBIA.has(sub) && !LEE.has(sub)) return null;                       // `security help`, `man security`…

  // El servicio: `-s <valor>`. 🔴 La ÚLTIMA ocurrencia, como getopt: con `-s inocente -s tycon-prod-x`
  // el binario usa la última y el freno miraba la primera (pase adversarial 2026-09-15).
  let servicio = null; let servicioLiteral = false;
  for (let i = 2; i < t.length; i++) {
    // «literal» = sin variables Y sin comodines ni llaves: `-s {tycon-prod-acme,}` o `-s tycon-pro?-acme`
    // los resuelve el shell después del freno (revisores, 2026-09-15)
    if (t[i] === '-s' && t[i + 1] !== undefined) { servicio = t[i + 1]; servicioLiteral = !/[$*?[\]{}`]/.test(servicio); }
    const pegado = /^-s(.+)$/.exec(t[i]);
    if (pegado) { servicio = pegado[1]; servicioLiteral = !/[$*?[\]{}`]/.test(servicio); }
  }
  if (CAMBIA.has(sub)) {
    if (servicio === null || !servicioLiteral) return `ese comando cambia una entrada del Llavero y no puedo ver cuál (\`security ${sub}\`).`;
    return servicio.startsWith('tycon-prod-') ? `ese comando cambia la entrada de producción «${servicio}» del Llavero.` : null;
  }
  // LEE: la excepción es un filtro de servicio LITERAL que no empiece con tycon-prod-.
  // (a) se compara des-entrecomillado — `-s "Claude Code-credentials"` es literal;
  // (b) un `-a` no literal NO invalida la excepción (el uso canónico del equipo es `-a "$USER" -s azure-devops-pat -w`);
  // (c) la excepción vale también cuando no hay -w/-g.
  if (servicio !== null && servicioLiteral && !servicio.startsWith('tycon-prod-')) return null;
  return servicio === null
    ? 'ese comando lee el Llavero sin decir de qué servicio (podría sacar la contraseña de producción).'
    : `ese comando lee la entrada «${servicio}» del Llavero.`;
}

// Lo que el freno protege de escrituras: el catálogo de cada repo, el índice y la memoria de producción,
// y las carpetas que los contienen. Se reconoce POR COMPONENTE, no por el texto literal: con
// `cd repo/.tycon && printf … > production.json`, un comodín `production-*` o `rm -rf
// ~/.claude/.tycon-pipeline` el texto literal no aparecía y la escritura pasaba (revisores,
// 2026-09-15). OJO: NO se protege toda `.tycon-pipeline/` contra escrituras puntuales —el botón de
// pánico del arnés es `touch ~/.claude/.tycon-pipeline/STOP_AUTONOMY`—, sólo estos archivos y el
// borrado o movido de la carpeta entera.
// 🔴 LOS DOS NOMBRES de cada uno (story 8.9, tanda P): el renombre a inglés deja convivir, hasta que todas las máquinas
// autorizadas reinstalen, el catálogo con su nombre viejo en los repos de producto y el índice y la memoria escritos con
// los dos nombres (la copia vieja de /opt lee los viejos). Proteger sólo los nuevos dejaría editar a mano lo que la copia
// vieja usa para decidir. Los viejos salen de acá en el commit que apaga la escritura doble (AC 49).
const CATALOGOS = ['production.json', 'produccion.json'];
// `production-firewall.json`: las reglas de firewall que abrió la puerta. Borrarlo a mano escondería una regla viva.
const ESTADOS = ['production-index.json', 'production-memory.json', 'production-firewall.json', 'produccion-indice.json', 'produccion-memoria.json'];
const NOMBRES_PROTEGIDOS = [...CATALOGOS, ...ESTADOS];
const CARPETAS_PROTEGIDAS = ['.tycon', '.tycon-pipeline'];
// la carpeta del estado dentro de `.tycon`: cuenta como protegida sólo ahí, no cualquier `state`
const CARPETA_DE_ESTADO = 'state';
// los dos nombres (`production…`, `produccion…`) y nada más: `product*` es un comodín cualquiera, y frenarlo en un
// freno sin escape es cómo muere un control (pase adversarial de la tanda P, 2026-09-30)
const NOMBRA_PRODUCCION = /^(?:production|produccion)/i;
// La mención ENTERA de un nombre protegido dentro de un argumento que no es una ruta: el programa de `python3 -c`,
// `node -e`, `perl -e` (`os.remove('…/production-memory.json')`). Era la red del texto crudo sobre el segmento entero;
// ahora es por palabra y con borde de nombre: `production-index.json0` (L3) es OTRO archivo y no se frena.
const MENCION_PROTEGIDA = /(?<![\w-])(?:\.tycon\/(?:production|produccion)\.json|production-(?:index|memory|firewall)\.json|produccion-(?:indice|memoria)\.json)(?![\w.-])/i;

// 🔴 Lista blanca de LECTORES, no lista negra de escritores (pase adversarial 2026-09-15). Y sin
// `sort` (`-o` escribe), `uniq` (`uniq a b` escribe en b) ni `find` (`-delete`, `-exec`): esos tres
// estaban en la lista y escribían (revisores).
// `echo`, `printf` y `print` (story 8.14, AC 16): nombrar un archivo no lo escribe (FP1). Entraron DESPUÉS de que
// `echo … | xargs rm` (X3) frenara por `xargs` y `rm "$(echo …)"` (X8) por la sustitución: antes frenaban por casualidad,
// porque el `echo` se juzgaba como escritura. Lo que el `echo` redirige a un archivo protegido sigue frenando (AC 11).
// `basename` y `dirname` (revisión de la tanda A, T30): ni abren el archivo, sólo recortan el texto del nombre.
// `[`, `[[` y `test` sólo PREGUNTAN; `gzcat`, `zcat`, `bzcat`, `xzcat` y `zless` sólo leen (medición T30 de la tanda A,
// segunda corrida: 7 frenos falsos nuevos, uno en measure-guard con `[ -n "$f" ]`). Lo que redirigen sigue juzgándose.
const LECTORES = new Set(['cat', 'bat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'jq', 'wc', 'stat', 'ls', 'file', 'diff', 'cmp', 'md5', 'shasum', 'awk', 'cut', 'column', 'open', 'code', 'man', 'echo', 'printf', 'print', 'basename', 'dirname',
  '[', '[[', 'test', 'gzcat', 'zcat', 'bzcat', 'xzcat', 'zless']);
// Intérpretes que corren un PROGRAMA: lo que reciben como argumento es dato del programa (ver `juzgarPalabra`). Los
// shells no entran: lo que corren se lee como shell y se juzga entero.
const INTERPRETE_DE_PROGRAMA = /^(?:python(?:\d+(?:\.\d+)*)?|node|perl|ruby|php)$/;
// `sed` sin `-i`/`-I`/`--in-place` sólo LEE sus archivos; su programa (`-e`, `--expression`, o el primer argumento) sí se
// juzga: `sed -n 'w <archivo>'` escribe (revisión de la tanda A, T30: freno falso con `sed` sobre una variable del `for`).
const SED_EN_SITIO = /^(?:-[^-]*[iI]|--in-place(?:=|$))/;
const GIT_LEE = new Set(['diff', 'show', 'status', 'log', 'ls-files', 'blame', 'grep', 'add']);
// la carpeta entera cuenta sólo para quien la BORRA o la MUEVE; crearla o listarla es trabajo normal — medido:
// `mkdir -p .tycon` estaba entre los falsos positivos reales
const BORRAN_O_MUEVEN = new Set(['rm', 'rmdir', 'mv', 'cp', 'ln', 'rsync', 'trash', 'unlink', 'shred', 'chmod', 'chown', 'chflags']);
// la carpeta del estado se pierde si se la borra o se la mueve; copiarla (`cp -r ~/.tycon/state /tmp/x`) sólo la lee
const QUITAN_LA_CARPETA = new Set(['rm', 'rmdir', 'mv', 'trash', 'unlink', 'shred']);
const CAMBIAN_CARPETA = new Set(['cd', 'pushd', 'chdir', 'popd']);
// Lo que va antes del programa de verdad, con las banderas que llevan argumento (`sudo -u x`, `nice -n 5`).
// `stdbuf`, `caffeinate`, `arch`, `ionice`, `setsid` y `unbuffer` escondían a `xargs` y a `find` (pase adversarial de la
// 8.14 A, #21): `ls … | stdbuf -oL xargs rm` no se leía como xargs.
const PREFIJOS_DE_PROGRAMA = {
  sudo: /^-[ugChpDrtUT]$/, doas: /^-[uC]$/, nice: /^-n$/, env: /^-[uSCP]$/, timeout: /^-[sk]$/, exec: /^-a$/,
  nohup: null, time: null, command: null, builtin: null, noglob: null, nocorrect: null,
  stdbuf: /^-[ioe]$/, caffeinate: /^-[tw]$/, arch: /^-(?:arch|d|e)$/, ionice: /^-[cnp]$/, setsid: null, unbuffer: null,
};
// Los shells: lo que corren con `-c` (sola o junta: `-lc`, `-euo pipefail -c`), un `<(…)` como guion o su entrada
// estándar se lee como shell, en el punto en que corre (pase adversarial de la 8.14 A, #1, #8, #9, #40).
const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash']);
const HEREDOC_MARK = '__HEREDOC__';                 // lo que deja `sinHeredocs` en la línea del `<<`
const FIND_PATRON = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-lname', '-ilname']);
const FIND_ESCRIBE_ARCHIVO = new Set(['-fprint', '-fprint0', '-fprintf', '-fls']);
// cuántas subcarpetas revisa `find` buscando un repo (una con `.tycon/`) en la carpeta de arranque; con más, es indecidible.
// Era 300 y con más se daba por «fuera de alcance» en silencio; 300 no alcanza ni para el /tmp de una Mac en uso (~1.600
// subcarpetas medidas el 2026-10-03), y 5.000 `stat` cuestan decenas de milisegundos con el reloj mirado cada 256.
const MAX_HIJOS_FIND = 5000;
const XARGS_CON_ARGUMENTO =/^-(?:[LnPsEeRSda]|-(?:max-args|max-procs|max-lines|delimiter|arg-file|eof|max-chars))$/;
const escPatron = (s) => String(s).replace(/[\\*?[\]~]/g, '\\$&');

/**
 * ¿Este comando (y lo que lleva escondido) ESCRIBE sobre el catálogo, el índice o la memoria de producción?
 *
 * STORY 8.14 (2026-10-03) — EL FRENO LEE LOS NOMBRES COMO EL SHELL. Antes se miraban los tokens tal cual, cortados por
 * un partidor que partía en llaves: `rm -f …/production-{index,memory}.json` llegaba en pedazos y pasaba, y de 119
 * formas medidas del shell 65 no hacían lo que tenían que hacer. Ahora:
 *  - cada palabra se EXPANDE (`expandWord`: llaves, rangos, zsh, `$'…'`, variables y arreglos del propio comando, `~`)
 *    y se juzga cada nombre que sale, sin distinguir mayúsculas (AC 3-9);
 *  - se juzgan TODAS las redirecciones de escritura, leídas del tokenizador (AC 11);
 *  - la carpeta de trabajo arranca en la del payload y la cambian `cd`/`pushd`/`chdir`; `git -C`/`make -C` la fijan
 *    para su segmento; `cd -`, `popd` o un destino sin resolver la dejan desconocida (AC 12);
 *  - `xargs` con un escritor cuenta como escritura sobre lo que nombra cualquier segmento anterior de su tubería;
 *    `find` que borra o ejecuta un escritor baja a las subcarpetas; una sustitución que nombra el alcance, como
 *    argumento de un escritor, cuenta como protegida (AC 13);
 *  - lo que no se puede leer DENTRO del alcance protegido (AC 2) frena con su propio motivo y regla (AC 14, 15);
 *    afuera, «no sé» no frena: es lo que mantiene los 4.000 comandos reales de measure-guard en 0.
 * Lo que no se intenta: ejecutar nada, ni leer un nombre que un programa calcula sin que su texto esté a la vista.
 * Los comodines siguen la regla medida de 2026-09-18 (313 frenos falsos → 0): un comodín cuenta sólo en la RAÍZ de
 * `.tycon-pipeline/` o de `.tycon/`, o si el nombre empieza con `production`/`produccion`.
 * Lo que corre como shell adentro del comando (`eval`, `bash -c` con cualquier forma de banderas, un `<(…)` como guion, el
 * texto que `echo`/`printf` le pasan a un shell, un `<<<` o un heredoc a un shell, una sustitución como palabra de comando)
 * se lee como shell EN EL PUNTO EN QUE CORRE, con la carpeta de ese momento y las variables del comando (pase adversarial
 * de la 8.14 A: #1, #8, #9, #14, #40).
 * @param {string} cmd el comando entero
 * @returns {{motivo:string, indecidible:boolean}|null}
 */
function escrituraProtegida(cmd, payload) {
  const path = require('path'); const os = require('os'); const fs = require('fs');
  const sp = require(path.join(__dirname, '..', 'lib', 'shell-parse.js'));
  const home = path.resolve(process.env.HOME || os.homedir());
  const raizPipeline = path.join(home, '.claude', '.tycon-pipeline');
  // el presupuesto es GLOBAL: todas las palabras de todos los textos del comando (AC 15)
  // `substitutionsOf`: el texto de las sustituciones de las que salió el valor de cada variable (`F=$(…)`): el AC 13c vale también
  // cuando la sustitución llega por una variable (pase adversarial de la 8.14 A, #5)
  const ctx = { vars: {}, arrays: {}, env: { HOME: home }, home, budget: new sp.ExpansionBudget(), expired: vencido, substitutionsOf: {}, readonlyVars: new Set() };

  const pal = (raw) => desescapar(sp.tokens(String(raw)).join(' '));
  const progDe = (raw) => (raw === undefined ? '' : basename(pal(raw)).toLowerCase());
  const conHome = (p) => (p === '~' || p.startsWith('~/') ? escPatron(home) + p.slice(1) : p);
  const mostrar = (p) => {
    let s = sp.patternToLiteral(p);
    if (s === home || s.startsWith(home + '/')) s = '~' + s.slice(home.length);
    return s;
  };
  const corto = (s) => { const t = String(s).replace(/\s+/g, ' '); return t.length > 160 ? `${t.slice(0, 157)}…` : t; };
  const expandir = (raw, opts) => {
    // el reloj se mira dentro del bucle: vencido, lo que queda se lee grueso y sólo frena si está en alcance (AC 15)
    if (vencido()) { ctx.budget.limit = ctx.budget.used; ctx.budget.exhausted = true; }
    return sp.expandWord(raw, ctx, opts);
  };
  const existeCarpeta = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

  /**
   * ¿Este patrón puede casar con un nombre que empieza con punto? En el shell (sin dotglob/globdots) el punto del
   * principio se escribe: `*-*`, `?tycon` o `[.]tycon` NO casan con `.tycon-pipeline` (revisión de la tanda A, T30: dos
   * frenos falsos sobre `…/*-*` y `$A-$B`). Con esas opciones prendidas el comando ya es indecidible (AC 6).
   */
  const puedeSerOculto = (p) => p[0] === '.' || (p[0] === '\\' && p[1] === '.');
  /** ¿Este componente de carpeta (un patrón) es `nombre`? Un comodín cuenta sólo si trae texto escrito (`.tyc*`, AC 10). */
  const componenteEs = (comp, nombre) => {
    if (sp.patternIsLiteral(comp)) return sp.patternToLiteral(comp).toLowerCase() === nombre;
    // `*` solo —lo que deja una variable sin resolver— no es la raíz de una carpeta protegida (AC 2): `rm -rf "$TMP"/*`
    if (!/[^*?]/.test(sp.patternToLiteral(comp).replace(/\[[^\]]*\]/g, 'x'))) return false;
    if (nombre.startsWith('.') && !puedeSerOculto(comp)) return false;
    // en una carpeta, `?` cuenta como «puede faltar o ser cualquiera»: `.tycon?/` se trata como `.tycon/` (AC 10, T18)
    let flojo = '';
    for (let i = 0; i < comp.length; i++) { if (comp[i] === '\\') { flojo += comp.slice(i, i + 2); i++; } else flojo += comp[i] === '?' ? '*' : comp[i]; }
    try { return sp.patternToRegExp(flojo, { nocase: true }).test(nombre); } catch { return false; }
  };
  const unir = (cwd, p) => {
    if (p.startsWith('/')) return path.posix.normalize(p);
    if (cwd === null) return null;
    return path.posix.normalize(`${cwd.replace(/\/+$/, '')}/${p}`);
  };
  /** Un nombre (patrón) en su carpeta: la carpeta sale de la ruta o de la carpeta de trabajo (AC 2, 12). */
  const partir = (p, cwd) => {
    let s = String(p); let dirDesconocida = false;
    if (!s.startsWith('/')) {
      if (cwd !== null) s = `${cwd.replace(/\/+$/, '')}/${s}`;
      else if (!s.replace(/\/+$/, '').includes('/')) dirDesconocida = true;
    }
    s = path.posix.normalize(s);
    if (s.length > 1) s = s.replace(/\/+$/, '');
    const k = s.lastIndexOf('/');
    const base = k >= 0 ? s.slice(k + 1) : s;
    const dir = k > 0 ? s.slice(0, k) : (k === 0 ? '/' : '');
    const comps = dir.split('/').filter(Boolean);
    const ultima = comps.length ? comps[comps.length - 1] : null;
    return {
      ruta: s, base, dir, dirDesconocida,
      enRaizTycon: ultima !== null && componenteEs(ultima, '.tycon'),
      enRaizPipeline: ultima !== null && componenteEs(ultima, '.tycon-pipeline'),
      enEstado: comps.length >= 2 && componenteEs(ultima, CARPETA_DE_ESTADO) && componenteEs(comps[comps.length - 2], '.tycon'),
    };
  };
  /**
   * El veredicto sobre UN nombre expandido: `archivo` (el catálogo, el índice o la memoria), `carpeta` (una de las dos
   * carpetas protegidas: cuenta para quien borra o mueve), `indecidible` (no se pudo leer y está en alcance), o nada;
   * `alcance` dice si está en alcance protegido (AC 2) y `literal` si no tiene comodines.
   */
  const veredicto = (p, cwd, indecidible) => {
    const i = partir(conHome(p), cwd);
    const baseTxt = sp.patternToLiteral(i.base);
    // ningún nombre protegido tiene blancos: un argumento con blancos es un programa o un mensaje, no un nombre
    // (registro real 2026-09-16: «ESCRIBE sobre \nconst fs=require…» sobre un `node -e` que sólo leía)
    if (/\s/.test(baseTxt)) return null;
    const literal = sp.patternIsLiteral(i.base);
    const n = baseTxt.toLowerCase();
    const alcance = i.enRaizTycon || i.enRaizPipeline || NOMBRA_PRODUCCION.test(baseTxt)
      || (literal && i.dirDesconocida && CATALOGOS.includes(n));
    const ruta = mostrar(i.ruta);
    // una de las dos carpetas protegidas, si el comodín pudiera casar con ella (sin mirar el punto del principio:
    // con dotglob/globdots/GLOBIGNORE sí casa). Sólo cuenta para quien borra o mueve, como la carpeta literal.
    const carpetaConOpciones = () => {
      if (literal || !/[^*?]/.test(baseTxt)) return false;
      try { const re0 = sp.patternToRegExp(i.base, { nocase: true }); return CARPETAS_PROTEGIDAS.some((c) => re0.test(c)); } catch { return true; }
    };
    if (indecidible) {
      if (alcance) return { tipo: 'indecidible', ruta, alcance, literal };
      return carpetaConOpciones() ? { tipo: 'carpeta-indecidible', ruta, alcance, literal } : null;
    }
    if (literal) {
      if (CARPETAS_PROTEGIDAS.includes(n)) return { tipo: 'carpeta', ruta, alcance, literal };
      // la carpeta del estado (`~/.tycon/state`) guarda los marcadores de todas las corridas: borrarla o moverla es
      // perderlas, igual que con las dos carpetas protegidas
      if (n === CARPETA_DE_ESTADO && i.enRaizTycon) return { tipo: 'carpeta', ruta, alcance, literal, estado: true };
      if (ESTADOS.includes(n)) return { tipo: 'archivo', ruta, alcance, literal };
      // con la carpeta desconocida (`cd -`, `cd "$X"`), el nombre pelado del catálogo cuenta (AC 12)
      if (CATALOGOS.includes(n) && (i.enRaizTycon || i.dirDesconocida)) return { tipo: 'archivo', ruta, alcance, literal };
      return { tipo: null, ruta, alcance, literal };
    }
    // `~/.tycon/state/*` vacía la carpeta entera de una vez: para quien borra, es lo mismo que borrarla
    if (i.enEstado && i.base === '*') return { tipo: 'carpeta', ruta, alcance, literal, estado: true };
    let re; try { re = sp.patternToRegExp(i.base, { nocase: true }); } catch { return alcance ? { tipo: 'archivo', ruta, alcance, literal } : null; }
    const candidatos = new Set([
      ...(i.enRaizTycon ? CATALOGOS : []), ...(i.enRaizPipeline ? ESTADOS : []),
      ...(NOMBRA_PRODUCCION.test(baseTxt) ? NOMBRES_PROTEGIDOS : []),
    ]);
    const hit = [...candidatos].find((c) => re.test(c));
    if (hit) return { tipo: 'archivo', ruta: mostrar(i.dir ? `${i.dir === '/' ? '' : i.dir}/${escPatron(hit)}` : escPatron(hit)), alcance, literal, desde: ruta };
    if (i.enRaizTycon && re.test(CARPETA_DE_ESTADO)) return { tipo: 'carpeta', ruta, alcance, literal, estado: true };
    // sin dotglob, sólo un comodín que empieza con punto puede ser `.tycon`/`.tycon-pipeline` (`.tyc*` sí, `*-*` no)
    if (/[^*?]/.test(baseTxt) && puedeSerOculto(i.base) && CARPETAS_PROTEGIDAS.some((c) => re.test(c))) return { tipo: 'carpeta', ruta, alcance, literal };
    return { tipo: null, ruta, alcance, literal };
  };

  const motivoEscribe = (ruta, raw) => {
    const crudo = corto(raw);
    return crudo === ruta ? `ese comando ESCRIBE sobre ${ruta}.` : `ese comando ESCRIBE sobre ${ruta} (el shell arma ese nombre desde «${crudo}»).`;
  };
  const motivoIndecidible = (raw, razon) => ({
    indecidible: true,
    // 🔴 sin las palabras que `reglaDelMotivo` y `frenar` leen como falla del freno: esto no es una falla (AC 14)
    motivo: `ese comando escribe en una carpeta protegida con un nombre que el freno no sabe leer como el shell: «${corto(raw)}» (${razon || 'una forma que no conoce'}).`,
  });

  // lo que pasa al tope de anidamiento de lo que corre adentro (eval, sh -c, `$(…)`, heredoc a un shell)
  const MAX_NESTING = 6;
  const NESTING_REASON = `más de ${MAX_NESTING} niveles de comandos uno dentro de otro`;
  /**
   * Un texto que el freno NO lee como shell —pasó el tope de anidamiento, o es una subshell que el partidor no cortó y quedó
   * como palabra (`time -p ( … )`, `coproc p ( … )`)—: si alguna de sus palabras está en alcance protegido es indecidible
   * (AC 14) y frena con su regla; si no, pasa. Antes, al tope se devolvía «nada» y pasaba siempre (repaso de fallos
   * silenciosos). Las palabras se sacan gruesas (se corta en blancos, comillas y operadores), por el lado seguro.
   */
  const unreadTextVerdict = (txt, cwd, razon) => {
    for (const frag of String(txt).split(/[\s'"\\;|&()<>`]+/)) {
      if (!frag) continue;
      const v = veredicto(frag, cwd, true);
      const base = frag.replace(/\/+$/, '').split('/').pop().toLowerCase();
      if ((v && v.tipo === 'indecidible') || CARPETAS_PROTEGIDAS.includes(base)) return motivoIndecidible(txt, razon);
    }
    return null;
  };
  /** ¿Esta palabra cruda es una subshell que el partidor no cortó? (`( rm -f … )`: empieza con `(` y tiene blancos adentro) */
  const isUncutSubshell = (raw) => /^\([\s\S]*\s[\s\S]*\)$/.test(String(raw));

  /**
   * Una palabra que un ESCRITOR recibe como argumento, o el destino de una redirección.
   * `deXargs`: la palabra lleva la marca de `xargs -I` (vale `*`): el nombre llega por la tubería, no de una variable.
   */
  const juzgarPalabra = (raw, cwd, prog, opts, deXargs, sinAlternativas) => {
    // el valor por defecto de `${X:-…}` es uno de los valores posibles (#3): cada lectura se juzga como la palabra misma
    if (!sinAlternativas) {
      for (const alt of parameterDefaultReadings(raw)) { const v = juzgarPalabra(alt, cwd, prog, opts, deXargs, true); if (v) return v; }
    }
    // una subshell que el partidor no cortó, como argumento (`coproc p ( … )`): no es un nombre, es texto sin leer
    if (isUncutSubshell(raw)) return unreadTextVerdict(raw, cwd, 'una subshell que el freno no supo separar del comando');
    const r = expandir(raw, opts);
    // (AC 13c) una sustitución como argumento: si su texto nombra el alcance, el argumento cuenta como protegido
    for (const t of r.substitutions) {
      const v = nombraAlcance(t, cwd, 1);
      if (v && typeof v !== 'string') return v;                                  // pasó el tope de anidamiento, en alcance
      if (v) return { motivo: `ese comando ESCRIBE sobre un nombre que arma una sustitución, y esa sustitución nombra ${v} («${corto(raw)}»).` };
    }
    // …también cuando la sustitución llega por una variable (`F=$(…); rm "$F"`, #5)
    for (const n of variablesUsedIn(raw)) {
      for (const t of (ctx.substitutionsOf[n] || [])) {
        const v = nombraAlcance(t, cwd, 1);
        if (v && typeof v !== 'string') return v;
        if (v) return { motivo: `ese comando ESCRIBE sobre un nombre que sale de la variable ${n}, y la sustitución que le dio su valor nombra ${v} («${corto(raw)}»).` };
      }
    }
    // Lo que un intérprete recibe de una variable o una sustitución sin resolver es un DATO de su programa, que decide qué
    // abre: el freno no ve más que si el programa lo calculara solo (el límite del AC 17). Sigue frenando un nombre
    // protegido a la vista (literal o comodín que el shell expande), la sustitución que nombra el alcance (arriba) y la
    // mención dentro del programa (abajo). Medido en T30: 5 frenos falsos de 8 eran `python3 - "$F"` en la raíz del pipeline.
    // Sólo la palabra ENTERA sin resolver (`"$F"`, `"$(…)"`): `…/.tycon-pipeline/$X.json` nombra la carpeta y se juzga.
    // (`unknownIsData`: lo mismo para el valor de una asignación de adelante, `TMP=$(mktemp) make`: no es un nombre)
    const datoDeUnPrograma = (INTERPRETE_DE_PROGRAMA.test(prog) || !!(opts && opts.unknownIsData)) && r.unknown && r.patterns.every((p) => p === '*');
    for (const p of (datoDeUnPrograma ? [] : r.patterns)) {
      if (p === '') continue;                              // `rm -f ""` no nombra la carpeta de trabajo (#30)
      const v = veredicto(p, cwd, r.undecidable);
      if (!v || !v.tipo) continue;
      if (v.tipo === 'indecidible') return motivoIndecidible(raw, r.reason);
      // un nombre que sale de una variable o una sustitución sin resolver (`rm "$X"` en la raíz del pipeline): el shell NO
      // arma «production-index.json» desde «"$X"»; es lo que no se puede leer dentro del alcance (AC 14), y se dice así
      if (v.tipo === 'archivo' && r.unknown && !v.literal && !deXargs) return motivoIndecidible(raw, r.reason || 'una variable o una sustitución que el freno no puede resolver');
      if (v.tipo === 'archivo') return { motivo: motivoEscribe(v.ruta, raw) };
      if (v.tipo === 'carpeta' && (v.estado ? QUITAN_LA_CARPETA : BORRAN_O_MUEVEN).has(prog)) return { motivo: `ese comando ESCRIBE sobre ${v.ruta}.` };
      if (v.tipo === 'carpeta-indecidible' && BORRAN_O_MUEVEN.has(prog)) return motivoIndecidible(raw, r.reason);
    }
    for (const p of r.patterns) {
      const m = MENCION_PROTEGIDA.exec(sp.patternToLiteral(p));
      if (m) return { motivo: `ese comando ESCRIBE sobre ${m[0]} (lo nombra dentro de «${corto(raw)}»).` };
    }
    return null;
  };
  /**
   * ¿Esta palabra NOMBRA el alcance (para lo que alimenta a un `xargs` o arma una sustitución)? → la ruta, o null; o el
   * veredicto indecidible (un objeto) si una sustitución adentro pasó el tope de anidamiento en alcance.
   */
  const alimenta = (raw, cwd, prof, opts, sinAlternativas) => {
    if (isUncutSubshell(raw)) return unreadTextVerdict(raw, cwd, 'una subshell que el freno no supo separar del comando');
    if (!sinAlternativas) for (const alt of parameterDefaultReadings(raw)) { const v = alimenta(alt, cwd, prof, opts, true); if (v) return v; }
    const r = expandir(raw, opts);
    for (const t of r.substitutions) { const v = nombraAlcance(t, cwd, prof + 1); if (v) return v; }
    for (const n of variablesUsedIn(raw)) for (const t of (ctx.substitutionsOf[n] || [])) { const v = nombraAlcance(t, cwd, prof + 1); if (v) return v; }
    for (const p of r.patterns) {
      if (p === '') continue;
      const v = veredicto(p, cwd, false);
      if (!v) continue;
      if (v.tipo === 'archivo' || v.tipo === 'carpeta') return v.ruta;
      // un comodín o algo sin resolver en alcance; un nombre literal que sólo EMPIEZA con production, no (X7)
      if (v.alcance && (!v.literal || r.undecidable || r.unknown)) return v.ruta;
    }
    return null;
  };
  /** ¿El texto (de una sustitución) nombra el alcance protegido en alguna de sus palabras? (la ruta, o un veredicto al tope) */
  const nombraAlcance = (texto, cwd0, prof) => {
    if (prof > MAX_NESTING) return unreadTextVerdict(texto, cwd0, NESTING_REASON);
    let cwd = cwd0;
    const segsT = sp.segmentos(texto, { keepSubst: true });
    for (let k = 0; k < segsT.length; k++) {
      const pp = sp.parseSimpleCommand(segsT[k].texto);
      const i0 = programa(pp.words); const prog = progDe(pp.words[i0]);
      if (CAMBIAN_CARPETA.has(prog)) { cwd = nuevaCarpeta(prog, pp.words.slice(i0 + 1), cwd); continue; }
      for (const raw of pp.words.slice(i0 + 1)) { const v = alimenta(raw, cwd, prof); if (v) return v; }
      for (const red of pp.redirections) {
        if (red.target === null || red.dup) continue;
        const v = alimenta(red.target, cwd, prof, red.op === '<<<' ? { hereString: true } : undefined);
        if (v) return v;
      }
      sp.applyAssignments(ctx, pp, { previousSep: k ? segsT[k - 1].sep : '' });   // reasignación seguida: reemplaza (#28)
    }
    return null;
  };

  /** El índice del programa de verdad en las palabras (saltea `sudo -u x`, `env A=b`, `timeout 5`, `nice -n 5`…). */
  function programa(words) {
    let i = 0;
    while (i < words.length) {
      const b = pal(words[i]).split('/').pop();
      if (!Object.prototype.hasOwnProperty.call(PREFIJOS_DE_PROGRAMA, b)) break;
      const conArg = PREFIJOS_DE_PROGRAMA[b];
      i++;
      while (i < words.length) {
        const a = pal(words[i]);
        if (a === '--') { i++; break; }
        if (b === 'env' && /^[A-Za-z_]\w*=/.test(a)) { i++; continue; }
        if (!/^-./.test(a)) break;
        i += conArg && conArg.test(a) ? 2 : 1;
      }
      if (b === 'timeout' && i < words.length) i++;                     // la duración
    }
    return i;
  }
  /** La carpeta después de `cd`/`pushd`/`chdir`/`popd` (null = desconocida). */
  function nuevaCarpeta(prog, args, cwd) {
    if (prog === 'popd') return null;
    let k = 0;
    while (k < args.length) {
      const a = pal(args[k]);
      if (a === '--') { k++; break; }
      if (/^-[PLeqs@]+$/.test(a)) { k++; continue; }
      break;
    }
    if (k >= args.length) return prog === 'pushd' ? null : escPatron(home);   // `cd` solo va al HOME; `pushd` solo intercambia
    const a0 = pal(args[k]);
    if (a0 === '-' || /^[+-]\d+$/.test(a0)) return null;                   // `cd -`, `pushd +1`: no se sabe adónde
    const r = expandir(args[k]);
    if (r.undecidable || r.unknown || r.patterns.length !== 1) return null; // una variable sin resolver: desconocida
    return unir(cwd, r.patterns[0]);                                          // un comodín queda como patrón (`.tyc*`)
  }
  /** `git -C <dir>` y `make -C <dir>` fijan la carpeta de SU segmento (AC 12). */
  const carpetaDeSegmento = (prog, args, cwd) => {
    if (prog !== 'git' && prog !== 'make') return cwd;
    let c = cwd;
    for (let k = 0; k < args.length; k++) {
      const a = pal(args[k]);
      let d = null;
      if (a === '-C' && args[k + 1] !== undefined) d = args[++k];
      else if (prog === 'make' && /^-C./.test(a)) d = args[k].slice(2);
      else if (prog === 'make' && /^--directory=/.test(a)) d = args[k].slice(args[k].indexOf('=') + 1);
      else if (prog === 'git' && a === '-c') { k++; continue; }
      else if (prog === 'git' && !/^-/.test(a)) break;                     // el subcomando
      if (d !== null) { const r = expandir(d); c = r.undecidable || r.unknown || r.patterns.length !== 1 ? null : unir(c, r.patterns[0]); }
    }
    return c;
  };
  /** ¿Este programa, con estos argumentos, sólo lee? (lectores condicionales: `awk -i`, `sort -o`, git según el subcomando) */
  const esLector = (prog, args) => {
    const t = args.map(pal);
    if (prog === 'awk' || prog === 'gawk') return !t.some((x) => /^-i/.test(x));
    if (prog === 'sort') return !t.some((x) => /^-o|^--output/.test(x));
    if (prog === 'git') {
      // `git -C <dir> restore …`: el argumento de -C/-c NO es el subcomando (revisores)
      let j = 0;
      while (j < t.length) {
        if (t[j] === '-C' || t[j] === '-c') { j += 2; continue; }
        if (t[j].startsWith('-')) { j += 1; continue; }
        break;
      }
      return GIT_LEE.has(t[j]);
    }
    return LECTORES.has(prog);
  };

  /** El programa de un `sed` (las palabras crudas): lo de `-e`/`--expression`, o el primer argumento si no hay `-e`/`-f`. */
  const programaDeSed = (args) => {
    const t = args.map(pal);
    const conBandera = t.some((x) => /^(?:-e|-f|--expression|--file)(?:=|$)|^-[^-]*[ef]/.test(x));
    const out = [];
    for (let k = 0; k < args.length; k++) {
      const a = t[k];
      if (a === '--') { if (!conBandera && args[k + 1] !== undefined) out.push(args[k + 1]); break; }
      // `-e <programa>`, también al final de un grupo (`-ne <programa>`)
      if (/^-[^-]*e$/.test(a) || a === '--expression') { if (args[k + 1] !== undefined) out.push(args[k + 1]); k++; continue; }
      if (/^--expression=/.test(a)) { out.push(args[k].slice(args[k].indexOf('=') + 1)); continue; }
      if (/^-[^-]*[fl]$/.test(a) || a === '--file') { k++; continue; }              // el guion de -f se LEE; -l lleva número
      if (/^-[^-]*e./.test(a)) { out.push(args[k]); continue; }                     // `-e<programa>` pegado: la palabra entera
      if (/^-/.test(a)) continue;
      if (!conBandera) { out.push(args[k]); break; }                                // el programa; lo que sigue son archivos
    }
    return out;
  };

  /**
   * `find` que borra o ejecuta un escritor: baja a las subcarpetas (AC 13b), y su PUNTO DE PARTIDA también es un destino
   * (`find <archivo> -delete` lo borra, #10). `fuente`: este `find` alimenta a un `xargs` escritor (`{ prog }`), así que lo
   * que encuentra se escribe igual que con `-delete` (#6, #17).
   * Los patrones se juntan como los junta find: con Y, salvo que la expresión tenga `-o` (#25). Un patrón negado no amplía
   * lo que se toma con Y; con `-o` vale `*`, y un grupo negado (`! \( … \)`) también.
   */
  const juzgarFind = (args, cwd, prof, fuente) => {
    let j = 0;
    while (j < args.length && /^-[HLPEXdsx]$/.test(pal(args[j]))) j++;          // -L, -H, -P no son la carpeta
    const inicios = [];
    while (j < args.length && !/^[-(!]/.test(pal(args[j])) && pal(args[j]) !== ')') inicios.push(args[j++]);
    const expr = args.slice(j);
    let borra = !!fuente; let profundidadCero = false; let conO = false; let grupoNegado = false;
    const patrones = []; const escritores = [];
    for (let k = 0; k < expr.length; k++) {
      const a = pal(expr[k]);
      const negado = k > 0 && (pal(expr[k - 1]) === '!' || pal(expr[k - 1]) === '-not');
      if (a === '-o' || a === '-or' || a === ',') conO = true;
      else if (a === '(' && negado) grupoNegado = true;
      else if (a === '-delete') borra = true;
      else if (a === '-maxdepth' && expr[k + 1] !== undefined) { if (pal(expr[k + 1]) === '0') profundidadCero = true; k++; }
      else if (FIND_PATRON.has(a) && expr[k + 1] !== undefined) {
        const v = pal(expr[++k]);
        // `-path`: sólo el último componente (la carpeta del patrón se ignora, por el lado seguro)
        patrones.push({ glob: /path|wholename/.test(a) ? (v.split('/').pop() || '*') : v, ci: a.startsWith('-i'), negado });
      } else if ((a === '-regex' || a === '-iregex') && expr[k + 1] !== undefined) { k++; patrones.push({ glob: '*', ci: true, negado }); }
      else if (FIND_ESCRIBE_ARCHIVO.has(a) && expr[k + 1] !== undefined) {
        const v = juzgarPalabra(expr[++k], cwd, 'find');
        if (v) return v;
        if (a === '-fprintf') k++;
      } else if (/^-(?:exec|execdir|ok|okdir)$/.test(a)) {
        const sub = [];
        for (k += 1; k < expr.length; k++) { const b = pal(expr[k]); if (b === ';' || b === '+') break; sub.push(expr[k]); }
        const i1 = programa(sub); const p = progDe(sub[i1]);
        if (p && !esLector(p, sub.slice(i1 + 1))) escritores.push({ prog: p, args: sub.slice(i1 + 1) });
      }
    }
    if (!borra && !escritores.length) return null;                                // sin -delete ni escritor: lee
    const casa = (pt, nombre) => globDeFind(pt.glob, pt.ci).test(nombre);
    const tomaElNombre = (nombre) => {
      if (grupoNegado) return true;
      const positivos = patrones.filter((x) => !x.negado);
      if (conO) return !patrones.length || positivos.some((pt) => casa(pt, nombre)) || positivos.length < patrones.length;
      return positivos.every((pt) => casa(pt, nombre));
    };
    const conQue = () => {
      const positivos = patrones.filter((x) => !x.negado).map((x) => x.glob);
      return positivos.length && !conO && !grupoNegado ? ` con «${corto(positivos.join(' y '))}»` : '';
    };
    const que = fuente ? `xargs le pasa a «${fuente.prog}» lo que find encuentra` : 'find borra o reescribe lo que encuentra';
    // `{}` dentro de una palabra del escritor (`-exec cp {} <P>/{}`) es el nombre que find encontró: vale `*`, como la marca
    // de `xargs -I` (#12). `{}` solo es el mismo nombre que encontró find: lo cubre la bajada de abajo.
    const conMarca = (raw) => (pal(raw) !== '{}' && pal(raw).includes('{}') ? raw.split('{}').join('${__XARGS_MARCA__}') : raw);
    for (const e of escritores) {
      const argsM = e.args.map(conMarca);
      // `-exec sh -c '…'`: el texto corre como shell (#8)
      const vEj = judgeShellText(e.prog, argsM, cwd, prof, {}); if (vEj) return vEj;
      for (let x = 0; x < e.args.length; x++) {
        if (pal(e.args[x]) === '{}') continue;
        const v = juzgarPalabra(argsM[x], cwd, e.prog, undefined, argsM[x] !== e.args[x]); if (v) return v;
      }
    }
    // el punto de partida mismo (#10): también con `-maxdepth 0`
    const borraCarpeta = fuente ? BORRAN_O_MUEVEN.has(fuente.prog) : escritores.some((e) => BORRAN_O_MUEVEN.has(e.prog));
    for (const raw of inicios) {
      const r = expandir(raw);
      for (const p of r.patterns) {
        if (p === '') continue;
        const v = veredicto(p, cwd, r.undecidable);
        if (!v || !v.tipo) continue;
        const nombre = v.ruta.split('/').pop();
        if (v.tipo === 'indecidible') return motivoIndecidible(raw, r.reason);
        // `find ~/.tycon/state -delete` sin filtro la vacía y la borra; con un filtro (`-name 'active*'`) borra sólo eso
        const vaciaElEstado = v.estado && borra && !fuente && !escritores.length && !patrones.length;
        if ((v.tipo === 'archivo' || (v.tipo === 'carpeta' && (borraCarpeta || vaciaElEstado))) && tomaElNombre(nombre)) {
          return { motivo: `ese comando ESCRIBE sobre ${v.ruta} (${fuente ? `xargs le pasa a «${fuente.prog}»` : 'find borra o reescribe'} su punto de partida «${corto(pal(raw))}»).` };
        }
      }
    }
    if (profundidadCero) return null;                                              // `-maxdepth 0`: no baja
    for (const raw of (inicios.length ? inicios : ['.'])) {
      const r = expandir(raw);
      for (const p of r.patterns) {
        const k2 = alcanceDeFind(conHome(p), cwd, r.unknown || r.undecidable);
        const nombres = [...(k2.catalogo ? CATALOGOS : []), ...(k2.estados ? ESTADOS : [])];
        const hit = nombres.find(tomaElNombre);
        if (hit && k2.indecidible) return motivoIndecidible(raw, k2.indecidible);
        if (hit) return { motivo: `ese comando ESCRIBE sobre ${hit} (${que} debajo de «${corto(pal(raw))}»${conQue()}).` };
      }
    }
    return null;
  };
  /** Desde esta carpeta, ¿`find` alcanza el catálogo (un repo, `.tycon/`) o el índice y la memoria (la carpeta del pipeline o un ancestro)? */
  const alcanceDeFind = (p, cwd, desconocida) => {
    const todo = { catalogo: true, estados: true };
    if (desconocida) return todo;
    const abs = unir(cwd, p);
    if (abs === null || !abs.startsWith('/')) return todo;                       // carpeta desconocida
    const comps = abs.split('/').filter(Boolean);
    const ultima = comps.length ? comps[comps.length - 1] : '';
    if (componenteEs(ultima, '.tycon-pipeline')) return { catalogo: false, estados: true };
    if (componenteEs(ultima, '.tycon')) return { catalogo: true, estados: false };
    const raiz = raizPipeline.toLowerCase();
    const ancestros = raiz.split('/').map((_, k, a) => a.slice(0, k + 1).join('/') || '/');
    if (!sp.patternIsLiteral(abs)) {
      let re; try { re = sp.patternToRegExp(abs, { nocase: true }); } catch { return todo; }
      return ancestros.some((x) => re.test(x)) ? todo : { catalogo: false, estados: false };
    }
    const lit = sp.patternToLiteral(abs);
    if (ancestros.includes(lit.toLowerCase())) return todo;                     // `~`, `~/.claude`, `/`: un ancestro
    if (existeCarpeta(path.join(lit, '.tycon'))) return { catalogo: true, estados: false };   // un repo
    // una carpeta de repos (un hijo con `.tycon/`). 🔴 Lo que NO se pudo mirar no es «fuera de alcance»: con más de
    // MAX_HIJOS_FIND hijos, o sin permiso para leerla, el catálogo de un hijo puede estar ahí — es indecidible y frena con
    // su motivo (AC 14). Antes las dos cosas caían en «no hay nada» en silencio (revisión de la tanda A, punto 1).
    let hijos;
    try { hijos = fs.readdirSync(lit, { withFileTypes: true }); } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { catalogo: false, estados: false };   // no existe: nada que borrar
      // sin «no pude» en el texto: no es una falla del freno, y esas palabras la mandarían a hook-errors.log (AC 14)
      return { catalogo: true, estados: false, indecidible: `la carpeta no se deja leer para saber si adentro hay un repo (${(e && e.code) || 'error'})` };
    }
    // sólo una carpeta (o un enlace, por si `find -L` lo sigue) puede ser un repo; un archivo no
    const carpetas = hijos.filter((h) => h.isDirectory() || h.isSymbolicLink());
    if (carpetas.length > MAX_HIJOS_FIND) return { catalogo: true, estados: false, indecidible: `una carpeta con ${carpetas.length} subcarpetas: más de las ${MAX_HIJOS_FIND} que el freno revisa buscando un repo` };
    for (let k = 0; k < carpetas.length; k++) {
      if (k % 256 === 255 && vencido()) return { catalogo: true, estados: false, indecidible: 'se acabó el tiempo revisando la carpeta en busca de un repo' };
      if (existeCarpeta(path.join(lit, carpetas[k].name, '.tycon'))) return { catalogo: true, estados: false };
    }
    return { catalogo: false, estados: false };
  };

  /**
   * Lo que un segmento le pasa a la tubería, para `xargs` y para un shell que lee su entrada: sus palabras, y además lo que
   * lista sin nombrarlo (`ls` sin operandos lista la carpeta de trabajo, #16) y lo que encuentra `find` (#6, #17).
   */
  const pipeEntry = (pp, cwd) => {
    const i0 = programa(pp.words);
    const prog = progDe(pp.words[i0]); const args = pp.words.slice(i0 + 1);
    const crudos = [...pp.words.map((raw) => ({ raw })),
      ...pp.redirections.filter((x) => x.target !== null && !x.dup).map((x) => ({ raw: x.target, opts: x.op === '<<<' ? { hereString: true } : undefined }))];
    if (prog === 'ls' && !args.some((a) => !/^-/.test(pal(a)))) crudos.push({ raw: '*' });
    return { crudos, cwd, prog, args };
  };
  /** Las entradas de tubo de un texto entero (el de un `<(…)`), con su carpeta de trabajo. */
  const pipeEntriesOf = (txt, cwd0) => {
    let cwd = cwd0; const out = [];
    for (const seg of sp.segmentos(txt, { keepSubst: true })) {
      const pp = sp.parseSimpleCommand(seg.texto);
      const i0 = programa(pp.words); const prog = progDe(pp.words[i0]);
      if (CAMBIAN_CARPETA.has(prog)) { cwd = nuevaCarpeta(prog, pp.words.slice(i0 + 1), cwd); continue; }
      out.push(pipeEntry(pp, cwd));
    }
    return out;
  };
  /** El texto de un `<(…)` (una palabra o el destino de un `<`), o null. */
  const processSubstitutionText = (raw) => { const m = /^<\(([\s\S]*)\)$/.exec(String(raw)); return m ? m[1] : null; };

  /** `xargs`/`parallel` con un escritor: escribe sobre lo que nombra cualquier segmento anterior de su tubería (AC 13a). */
  const juzgarXargs = (args, cwd, previos, pp, prof) => {
    let k = 0; let marca = null;
    while (k < args.length) {
      const a = pal(args[k]);
      if (a === '--') { k++; break; }
      if (!/^-/.test(a)) break;
      let m;
      if (a === '-I' || a === '-J' || a === '--replace') { marca = pal(args[k + 1] || ''); k += 2; continue; }
      if ((m = /^-([IJ])(.+)$/.exec(a))) { marca = m[2]; k++; continue; }
      if (/^--replace=/.test(a)) { marca = a.slice(10) || '{}'; k++; continue; }
      if (a === '-i') { marca = '{}'; k++; continue; }
      k += XARGS_CON_ARGUMENTO.test(a) ? 2 : 1;
    }
    const sub = args.slice(k);
    const i1 = programa(sub); const p = progDe(sub[i1]); const subArgs = sub.slice(i1 + 1);
    if (!p || esLector(p, subArgs)) return null;                                  // sin programa es `echo`
    // la marca de -I/-J vale `*` en los argumentos del escritor
    const subArgsM = subArgs.map((raw) => (marca && raw.includes(marca) ? raw.split(marca).join('${__XARGS_MARCA__}') : raw));
    // `xargs sh -c '…'`: el texto corre como shell (#8)
    const vEj = judgeShellText(p, subArgsM, cwd, prof, {}); if (vEj) return vEj;
    for (let x = 0; x < subArgs.length; x++) {
      const v = juzgarPalabra(subArgsM[x], cwd, p, undefined, subArgsM[x] !== subArgs[x]);
      if (v) return v;
    }
    // las fuentes: los segmentos anteriores de la tubería, un `<<<`, y un `< <(…)` (#16)
    const entradas = [...previos];
    for (const red of pp.redirections) {
      if (red.target === null || red.dup) continue;
      if (red.op === '<<<') entradas.push({ crudos: [{ raw: red.target, opts: { hereString: true } }], cwd });
      else if (red.op === '<') { const t = processSubstitutionText(red.target); if (t !== null) entradas.push(...pipeEntriesOf(t, cwd)); }
    }
    for (const e of entradas) {
      // lo que imprime un `find` lo deciden sus reglas (punto de partida, bajada, patrones), no sus palabras sueltas: el
      // `.` de `cd <P> && find . -name 'timing-*' | xargs rm` no es la carpeta que se borra
      if (e.prog === 'find') { const v = juzgarFind(e.args, e.cwd, prof, { prog: p }); if (v) return v; continue; }
      for (const c of e.crudos) {
        const v = alimenta(c.raw, e.cwd, 0, c.opts);
        if (v && typeof v !== 'string') return v;                                // indecidible en alcance
        if (v) return { motivo: `ese comando ESCRIBE sobre ${v} (xargs arma los argumentos de «${p}» con lo que le llega de «${corto(c.raw)}»).` };
      }
    }
    return null;
  };

  /** Las lecturas de una palabra como TEXTO que se va a volver a leer como shell (el guion de `bash -c`, lo de `eval`). */
  const scriptReadings = (raw, opts) => {
    const r = expandir(raw, opts);
    if (!r.unknown && !r.undecidable) return r.patterns.slice(0, 16).map(sp.patternToLiteral);
    // con algo sin resolver, la lectura de adentro: `bash -c "rm -f $X"` se lee como `rm -f $X` (X sigue desconocida, y
    // en alcance es indecidible), no como `rm -f *` (un comodín de verdad)
    const m = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(String(raw));
    if (m) return [m[1].replace(/\\([$`"\\])/g, '$1')];
    return r.patterns.filter((p) => p !== '*').slice(0, 16).map(sp.patternToLiteral);    // `$CMD` solo: no hay nada que ver
  };
  /** Lo que imprime un `echo`/`print`/`printf` (las lecturas posibles), o null si el programa no es uno de ésos. */
  const printedText = (prog, args) => {
    const textos = (raw) => expandir(raw).patterns.map(sp.patternToLiteral);
    if (prog === 'echo' || prog === 'print') {
      let k = 0;
      while (k < args.length && /^-[A-Za-z]+$/.test(pal(args[k]))) k++;
      if (args[k] !== undefined && pal(args[k]) === '--') k++;
      const t = args.slice(k).flatMap(textos).join(' ');
      const decodificado = t.replace(/\\([ntr\\])/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\' }[c]));
      return [...new Set([t, decodificado])];
    }
    if (prog === 'printf') {
      let k = 0;
      if (args[0] !== undefined && pal(args[0]) === '-v') return null;            // asigna una variable: no imprime
      if (args[0] !== undefined && pal(args[0]) === '--') k = 1;
      if (args[k] === undefined) return null;
      const resto = args.slice(k + 1).flatMap(textos);
      return [...new Set(textos(args[k]).map((f) => printfOutput(f, resto)))];
    }
    return null;
  };
  /** Lo que imprime un texto entero (el de un `<(…)` o un `$(…)`), si son `echo`/`printf`; null si no se puede saber. */
  const printedTextOf = (txt) => {
    const partes = [];
    for (const seg of sp.segmentos(txt, { keepSubst: true })) {
      const pp = sp.parseSimpleCommand(seg.texto);
      const i0 = programa(pp.words);
      const s = printedText(progDe(pp.words[i0]), pp.words.slice(i0 + 1));
      if (s) partes.push(s);
    }
    if (!partes.length) return null;
    return [...new Set([partes.map((s) => s[0]).join('\n'), partes.map((s) => s[s.length - 1]).join('\n')])];
  };
  /** Las opciones de un shell: si trae `-c` (sola o junta: `-lc`, `-euo pipefail -c`), si lee la entrada (`-s`) y su operando. */
  const shellOptions = (args) => {
    let k = 0; let c = false; let s = false;
    while (k < args.length) {
      const a = pal(args[k]);
      if (a === '--' || a === '-') { k++; break; }
      if (a === '--rcfile' || a === '--init-file') { k += 2; continue; }
      if (/^--/.test(a)) { k++; continue; }
      if (/^[-+][A-Za-z]+$/.test(a)) {
        if (a[0] === '-' && a.includes('c')) c = true;
        if (a[0] === '-' && a.includes('s')) s = true;
        k += 1 + (a.slice(1).match(/[oO]/g) || []).length;                      // `-o <opción>`, `-euo pipefail`, `-O <shopt>`
        continue;
      }
      break;
    }
    return { c, s, k };
  };
  /**
   * El texto que este programa corre como SHELL, juzgado en la carpeta de este momento: `eval …`, `sh -c '…'` (cualquier
   * forma de banderas), `sh <(…)` / `source <(…)`, y lo que un shell lee de su entrada (`echo … | sh`, `sh <<< …`,
   * `sh < <(…)`). Un guion del disco (`bash x.sh`) no: es el límite dicho del AC 22b.
   * @param {object} ent `{ pp, tuberia }` del segmento, para la entrada estándar
   */
  function judgeShellText(prog, args, cwd, prof, ent) {
    // al tope de anidamiento el texto no se lee: indecidible si nombra el alcance, nada si no
    const correr = (txt) => {
      if (!String(txt).trim()) return null;
      return prof >= MAX_NESTING ? unreadTextVerdict(txt, cwd, NESTING_REASON) : texto(txt, cwd, prof + 1).veredicto;
    };
    if (prog === 'eval') return correr(args.map((raw) => scriptReadings(raw).join(' ')).join(' '));
    const esShell = SHELLS.has(prog); const esSource = prog === 'source' || prog === '.';
    if (!esShell && !esSource) return null;
    let k = 0; let leeEntrada = false;
    if (esShell) {
      const o = shellOptions(args);
      if (o.c) {
        if (args[o.k] === undefined) return null;
        for (const t of scriptReadings(args[o.k])) { const v = correr(t); if (v) return v; }
        return null;
      }
      k = o.k; leeEntrada = o.s;
    } else if (args[0] !== undefined && pal(args[0]) === '--') k = 1;
    const operando = args[k];
    if (operando !== undefined && !leeEntrada) {
      const t = processSubstitutionText(operando);
      if (t !== null) {
        for (const s of (printedTextOf(t) || [])) { const v = correr(s); if (v) return v; }
        return null;
      }
      if (!/^(?:\/dev\/stdin|-)$/.test(pal(operando))) return null;              // un guion del disco (AC 22b)
    }
    if (esSource && operando === undefined) return null;
    const textos = [];
    for (const e of ((ent && ent.tuberia) || [])) { const s = printedText(e.prog, e.args); if (s) textos.push(...s); }
    for (const red of ((ent && ent.pp && ent.pp.redirections) || [])) {
      if (red.target === null || red.dup) continue;
      if (red.op === '<<<') textos.push(...scriptReadings(red.target, { hereString: true }));
      else if (red.op === '<') { const t = processSubstitutionText(red.target); if (t !== null) textos.push(...(printedTextOf(t) || [])); }
    }
    for (const t of textos) { const v = correr(t); if (v) return v; }
    return null;
  }

  /** `git diff|log|show … --output=<archivo>` escribe ese archivo (#22): los destinos, o [] si no hay. */
  const gitOutputTargets = (args) => {
    const out = [];
    for (let k = 0; k < args.length; k++) {
      const a = pal(args[k]);
      if (a === '--') break;
      if (a === '--output' && args[k + 1] !== undefined) out.push(args[++k]);
      else if (/^--output=/.test(a)) out.push(args[k].slice(args[k].indexOf('=') + 1));
    }
    return out;
  };

  /** Un comando simple. */
  const segmento = (pp, i0, prog, args, cwd, tuberia, prof) => {
    const cwdSeg = carpetaDeSegmento(prog, args, cwd);
    // TODAS las redirecciones de escritura, la haga quien la haga (AC 11; en zsh cada una es un destino real)
    for (const red of pp.redirections) {
      if (!red.write || red.target === null) continue;
      const v = juzgarPalabra(red.target, cwdSeg, ''); if (v) return v;
    }
    // Una asignación sola NO escribe (FP2, AC 16): su valor se juzga donde se USA (`rm "$F"`, V1). Lo que ejecuta una
    // sustitución dentro del valor ya se juzgó arriba, como cualquier comando.
    if (!prog) return null;
    const palabra = pp.words[i0];
    // una sustitución como PALABRA DE COMANDO (`$(echo rm -f …)`): lo que corre es su salida, con el resto de las palabras (#1)
    const sust = /^\$\(([\s\S]*)\)$/.exec(palabra) || /^`([\s\S]*)`$/.exec(palabra);
    if (sust) {
      const salidas = printedTextOf(sust[1]);
      if (salidas) {
        for (const s of salidas) {
          const t = `${s} ${args.join(' ')}`;
          const v = prof < MAX_NESTING ? texto(t, cwdSeg, prof + 1).veredicto : unreadTextVerdict(t, cwdSeg, NESTING_REASON);
          if (v) return v;
        }
        return null;
      }
    }
    // la palabra de comando que no se pudo leer (una subshell que el partidor no cortó, `time -p ( … )`, o una palabra
    // indecidible): si nombra el alcance, indecidible (repaso de seguridad: sólo se miraban los argumentos)
    if (isUncutSubshell(palabra)) {
      const v = unreadTextVerdict(palabra, cwdSeg, 'una subshell que el freno no supo separar del comando'); if (v) return v;
    }
    // el programa mismo, si ES un archivo protegido: el cuerpo de `xargs rm <<EOF` llega como comando
    const rProg = expandir(palabra);
    for (const p of rProg.patterns) {
      if (rProg.unknown && p === '*') continue;                                    // `$X` solo no es un nombre
      const v = veredicto(p, cwdSeg, false); if (v && v.tipo === 'archivo') return { motivo: motivoEscribe(v.ruta, palabra) };
    }
    if (rProg.undecidable) {
      for (const p of rProg.patterns) { const v = veredicto(p, cwdSeg, true); if (v && v.tipo === 'indecidible') return motivoIndecidible(palabra, rProg.reason); }
    }
    // el nombre del programa sale de una variable del comando (`F=rm; $F -rf …`, #21): se juzga con cada valor posible
    if (/\$/.test(palabra) && !rProg.unknown && !rProg.undecidable && rProg.patterns.every((p) => sp.patternIsLiteral(p))) {
      const progs = [...new Set(rProg.patterns.map((p) => sp.patternToLiteral(p).split('/').pop().toLowerCase()))].slice(0, 8);
      if (progs.length && !(progs.length === 1 && progs[0] === prog)) {
        for (const p2 of progs) { const v = judgeProgram(pp, i0, p2, args, cwdSeg, tuberia, prof); if (v) return v; }
        return null;
      }
    }
    return judgeProgram(pp, i0, prog, args, cwdSeg, tuberia, prof);
  };

  /** Lo que hace el programa de un comando simple (ya juzgadas las redirecciones y la palabra de comando). */
  function judgeProgram(pp, i0, prog, args, cwdSeg, tuberia, prof) {
    // `for x in <palabras>` no escribe sus palabras: se las da a la variable del bucle, y se juzgan donde se usan
    // (`rm "$x"`). Por eso la variable se lleva sus valores y las sustituciones que los arman; lo que no se resuelve ya
    // queda desconocido (shell-parse, al aplicar las asignaciones)
    if ((prog === 'for' || prog === 'select') && /^[A-Za-z_]\w*$/.test(pal(args[0] || '')) && pal(args[1] || '') === 'in') {
      const nombre = pal(args[0]);
      const valores = [];
      const subs = [];
      for (const raw of args.slice(2)) {
        const r = expandir(raw);
        valores.push(...r.patterns.filter((p) => !(r.unknown && p === '*')));
        subs.push(...sp.substitutions(raw), ...variablesUsedIn(raw).flatMap((n) => ctx.substitutionsOf[n] || []));
      }
      ctx.vars[nombre] = [...new Set([...[].concat(ctx.vars[nombre] || []), ...valores])];
      if (subs.length) ctx.substitutionsOf[nombre] = [...new Set([...(ctx.substitutionsOf[nombre] || []), ...subs])].slice(0, 16);
      return null;
    }
    // lo que corre como shell: `eval`, `sh -c`, `sh <(…)`, `echo … | sh` (#1, #8, #9, #14)
    const vEj = judgeShellText(prog, args, cwdSeg, prof, { pp, tuberia }); if (vEj) return vEj;
    if (prog === 'git') for (const raw of gitOutputTargets(args)) { const v = juzgarPalabra(raw, cwdSeg, prog); if (v) return v; }
    // las asignaciones de adelante (`OUT=… node gen.js`, `env OUT=… node gen.js`) de un programa que NO es lector: el
    // programa las lee del entorno y puede escribir ahí (#18). Delante de un lector, o solas, no escriben (FP2).
    if (!esLector(prog, args)) {
      const delEnv = pp.words.slice(0, i0).filter((w, x, arr) => /^[A-Za-z_]\w*=/.test(pal(w)) && arr.slice(0, x).some((y) => progDe(y) === 'env'));
      for (const raw of [...pp.assignments.map((a) => a.raw), ...delEnv.map((w) => w.slice(w.indexOf('=') + 1))]) {
        const v = juzgarPalabra(raw, cwdSeg, prog, { assignment: true, unknownIsData: true }); if (v) return v;
      }
    }
    if (prog === 'xargs' || prog === 'parallel') return juzgarXargs(args, cwdSeg, tuberia, pp, prof);
    if (prog === 'find') return juzgarFind(args, cwdSeg, prof, null);
    if ((prog === 'sed' || prog === 'gsed') && !args.some((a) => SED_EN_SITIO.test(pal(a)))) {
      for (const raw of programaDeSed(args)) { const v = juzgarPalabra(raw, cwdSeg, prog); if (v) return v; }
      return null;                                                                  // sus archivos sólo se leen
    }
    if (esLector(prog, args)) return null;
    for (const raw of args) {
      const v = juzgarPalabra(raw, cwdSeg, prog); if (v) return v;
      const m = /^--?[A-Za-z][\w-]*=([\s\S]+)$/.exec(raw);                           // `--out=<ruta>`
      if (m) { const v2 = juzgarPalabra(m[1], cwdSeg, prog); if (v2) return v2; }
    }
    return null;
  }

  /**
   * Los heredocs de un texto, en orden, con si su cuerpo corre como shell (`heredocAlimentaShell`). `sinHeredocs` deja una
   * marca por cada uno en la línea del `<<`: el recorrido juzga cada cuerpo de shell al llegar a su marca, con la carpeta
   * de ese momento (#40); `sig` es el próximo por consumir.
   */
  const heredocsOf = (doc) => {
    const lista = [];
    let partesDoc = null; let varsDoc = null;
    for (const h of sp.heredocs(doc)) {
      if (partesDoc === null) { partesDoc = sp.segmentos(doc); varsDoc = sp.variablesDelComando(doc); }
      lista.push({ cuerpo: h.cuerpo, shell: heredocAlimentaShell(doc, h.indice, partesDoc, sp.tokens, sp.PREFIJOS, varsDoc, sp.expandir) });
    }
    return { lista, sig: 0 };
  };

  /**
   * Un texto de shell entero: segmento por segmento, con la carpeta, las variables y la tubería. `doc`: los heredocs del
   * texto de shell al que pertenece (el mismo para sus sustituciones; uno nuevo para un guion que corre otro shell).
   */
  const texto = (txt, cwd0, prof, doc) => {
    const propio = !doc;
    if (propio) doc = heredocsOf(txt);
    let cwd = cwd0;
    const segs = sp.segmentos(txt, { keepSubst: true });
    const parsed = segs.map((s) => sp.parseSimpleCommand(s.texto));
    // un comando que cambia cómo el shell lee las palabras vuelve indecidible todo lo que está en alcance (AC 6)
    if (parsed.some((x) => sp.changesShellOptions(x))) ctx.shellOptionsChanged = true;
    let tuberia = [];
    for (let k = 0; k < segs.length; k++) {
      const pp = parsed[k];
      // las marcas de heredoc no son palabras del comando: cada una es el cuerpo de un heredoc de este texto
      const marcas = pp.words.filter((w) => w === HEREDOC_MARK).length;
      if (marcas) pp.words = pp.words.filter((w) => w !== HEREDOC_MARK);
      const i0 = programa(pp.words); const prog = progDe(pp.words[i0]);
      const args = pp.words.slice(i0 + 1);
      // lo que corre adentro de una sustitución también es un comando, y sus escrituras se juzgan
      // (al tope de anidamiento no se lee: indecidible si nombra el alcance)
      const adentro = (t, c, d) => (prof < MAX_NESTING ? texto(t, c, prof + 1, d).veredicto : unreadTextVerdict(t, c, NESTING_REASON));
      for (const sub of sp.substitutions(segs[k].texto)) { const v = adentro(sub, cwd, doc); if (v) return { veredicto: v }; }
      // el cuerpo de un heredoc que corre un shell, acá y con esta carpeta
      for (let x = 0; x < marcas; x++) {
        const h = doc.lista[doc.sig++];
        if (h && h.shell) { const v = adentro(h.cuerpo, carpetaDeSegmento(prog, args, cwd)); if (v) return { veredicto: v }; }
      }
      if (CAMBIAN_CARPETA.has(prog)) cwd = nuevaCarpeta(prog, args, cwd);
      else { const v = segmento(pp, i0, prog, args, cwd, tuberia, prof); if (v) return { veredicto: v }; }
      // de qué sustituciones sale cada variable (#5): las suyas y las de las variables que copia, leídas antes de asignar
      const subsDe = pp.assignments.map((a) => [...sp.substitutions(a.raw), ...variablesUsedIn(a.raw).flatMap((n) => ctx.substitutionsOf[n] || [])]);
      // una variable de sólo lectura no se reasigna: la asignación falla y el comando sigue
      if (prog === 'readonly' || (/^(declare|typeset|local|export)$/.test(prog) && args.some((a) => /^-[A-Za-z]*r/.test(pal(a))))) {
        for (const a of args) if (!/^[-+]/.test(pal(a))) ctx.readonlyVars.add(pal(a).split(/\+?=/)[0]);
      }
      // la asignación pisa el valor entero sólo si es el comando entero, en el shell de arriba y sin redirecciones (una que
      // falla, en zsh, no asigna); no detrás de `|` ni de `&` (subshell), ni sobre un arreglo (bash pisa el primero)
      const pisaSeguro = prof === 0 && !pp.words.length && !pp.redirections.length && !/^(\||&)/.test(segs[k].sep || '');
      const eraArreglo = new Set(pp.assignments.filter((a) => Object.prototype.hasOwnProperty.call(ctx.arrays || {}, a.name)).map((a) => a.name));
      // las asignaciones, DESPUÉS de las palabras: `X=a cmd $X` usa la X de antes. Detrás de `;` (o al principio) y fuera
      // de ramas, una reasignación REEMPLAZA el valor, como el shell; detrás de `&&`, `|`… la unión (#28, contrato del carril G)
      sp.applyAssignments(ctx, pp, { previousSep: k ? segs[k - 1].sep : '' });
      // lo que el shell pisó seguro olvida también de qué sustitución salía (`F=$(…); F=/tmp/a; rm $F`); si no, la unión
      pp.assignments.forEach((a, j) => {
        const olvida = pisaSeguro && ctx.replaced.has(a.name) && a.op !== '+=' && !a.element && !a.array
          && !eraArreglo.has(a.name) && !ctx.readonlyVars.has(a.name);
        const subs = olvida ? subsDe[j] : [...(ctx.substitutionsOf[a.name] || []), ...subsDe[j]];
        if (subs.length) ctx.substitutionsOf[a.name] = [...new Set(subs)].slice(0, 16);
        else if (olvida) delete ctx.substitutionsOf[a.name];
      });
      tuberia = segs[k].sep === '|' ? [...tuberia, pipeEntry(pp, cwd)] : [];
    }
    // un heredoc de shell cuya marca no apareció (una forma rara del partidor): se juzga igual, con la carpeta del final
    if (propio) {
      for (; doc.sig < doc.lista.length; doc.sig++) {
        const h = doc.lista[doc.sig];
        if (!h.shell) continue;
        const v = prof < MAX_NESTING ? texto(h.cuerpo, cwd, prof + 1).veredicto : unreadTextVerdict(h.cuerpo, cwd, NESTING_REASON);
        if (v) return { veredicto: v };
      }
    }
    return { veredicto: null, cwd };
  };

  const r0 = texto(cmd, escPatron(path.resolve(String((payload && payload.cwd) || process.cwd()))), 0);
  return r0.veredicto || programaPorHeredoc(cmd, sp) || null;
}

/**
 * El programa de un intérprete (python, node…) que llega por su entrada —un heredoc o un here-string— se juzga como el
 * de `python3 -c`: si nombra el catálogo, el índice o la memoria, frena. Cuenta el intérprete del comando que recibe el
 * texto y el de las etapas que le siguen en la tubería (`cat <<EOF | python3`); lo que va a un archivo
 * (`cat > x.py <<EOF`) o a un programa que vive en un archivo (`node tool.js <<EOF`) es dato. Un `bash -c "…"` se mira
 * por dentro.
 */
function programaPorHeredoc(cmd, sp, prof = 0) {
  if (!cmd.includes('<<')) return null;
  for (const p of sp.programasPorEntrada(cmd)) {
    const m = MENCION_PROTEGIDA.exec(String(p.cuerpo || ''));
    if (m) return { motivo: `ese comando ESCRIBE sobre ${m[0]} (lo nombra el programa que el intérprete recibe por su entrada).` };
  }
  if (prof >= 6) return null;                                               // el mismo tope de anidamiento de `texto`
  for (const interno of sp.tokens(cmd).filter((t, i, ts) => i > 0 && ts[i - 1] === '-c' && t.includes('<<'))) {
    const v = programaPorHeredoc(interno, sp, prof + 1);
    if (v) return v;
  }
  return null;
}

/** El patrón de `find -name` como RegExp (find no expande llaves: `production-{index,memory}.json` es literal, X10). */
function globDeFind(g, ci) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '\\' && i + 1 < g.length) { re += g[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); continue; }
    if (c === '*') { re += '.*'; continue; }
    if (c === '?') { re += '.'; continue; }
    if (c === '[') {
      const k = g.indexOf(']', i + 2);
      if (k > 0) { let cl = g.slice(i + 1, k); if (/^[!^]/.test(cl)) cl = `^${cl.slice(1)}`; re += `[${cl.replace(/\\/g, '\\\\')}]`; i = k; continue; }
    }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  // Un patrón que no se puede leer coincide con todo: el freno frena (por el lado seguro).
  try { return new RegExp(`^${re}$`, ci ? 'i' : ''); } catch { return { test: () => true }; }
}

/** Los nombres de las variables que una palabra cruda usa (`$F`, `${F}`, `${F:-…}`). Por el lado seguro: no mira comillas. */
function variablesUsedIn(raw) {
  const out = new Set(); const re = /\$\{?([A-Za-z_]\w*)/g; let m;
  while ((m = re.exec(String(raw)))) out.add(m[1]);
  return [...out];
}

/**
 * La palabra con cada `${X:-texto}` (también `-`, `:=`, `=`, `:+`, `+`) cambiado por su `texto`: el valor por defecto es
 * uno de los valores posibles de la palabra, y el expansor sólo ve «desconocido» (pase adversarial de la 8.14 A, #3).
 * `${X:?…}` no entra: si X falta, el shell corta con un error. A lo sumo 8 lecturas.
 */
function parameterDefaultReadings(raw) {
  const s = String(raw); const out = [];
  let simples = false; let dobles = false;
  for (let i = 0; i < s.length && out.length < 8; i++) {
    const c = s[i];
    if (simples) { if (c === "'") simples = false; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" && !dobles) { simples = true; continue; }
    if (c === '"') { dobles = !dobles; continue; }
    if (c !== '$' || s[i + 1] !== '{') continue;
    let prof = 0; let j = i + 1;
    for (; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '{') prof++;
      else if (s[j] === '}' && --prof === 0) break;
    }
    if (j >= s.length) break;
    const m = /^(?:[A-Za-z_]\w*|\d+|[@*#?$!-])(:?[-=+])([\s\S]*)$/.exec(s.slice(i + 2, j));
    if (m) {
      const alt = s.slice(0, i) + m[2] + s.slice(j + 1);
      out.push(alt);
      for (const a2 of parameterDefaultReadings(alt)) if (out.length < 8) out.push(a2);
    }
  }
  return [...new Set(out)];
}

/** Lo que imprime `printf <formato> <args…>`: `%s` y compañía toman el argumento siguiente, y el formato se repite. */
function printfOutput(fmt, args) {
  const ESC = { n: '\n', t: '\t', r: '\r', '\\': '\\', a: '', b: '', f: '', v: '', e: '' };
  let out = ''; let k = 0; let usados;
  do {
    usados = false;
    for (let i = 0; i < fmt.length; i++) {
      const c = fmt[i];
      if (c === '\\' && i + 1 < fmt.length) { const d = fmt[++i]; out += d in ESC ? ESC[d] : `\\${d}`; continue; }
      if (c === '%' && fmt[i + 1] === '%') { out += '%'; i++; continue; }
      const m = c === '%' ? /^[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[a-zA-Z]/.exec(fmt.slice(i + 1)) : null;
      if (m) { if (args[k] !== undefined) { out += args[k]; usados = true; } k++; i += m[0].length; continue; }
      out += c;
    }
  } while (usados && k < args.length && out.length < MAX_ESCONDIDO);
  return out;
}

const TEXTUALES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'less', 'cat', 'head', 'tail', 'man', 'echo', 'printf']);
// Claves de cadena de conexión: `Addr`, `Address` y `Network Address` son sinónimos documentados de
// SqlClient y no estaban.
// Un valor que es una llamada de código (`const server = http.createServer(…)` en un `node -e`) no es un servidor:
// una cadena de conexión no lleva paréntesis después de un nombre.
const LLAMADA_DE_CODIGO = /^[A-Za-z_][\w$]*(?:\.[\w$]+)*\(/;            // `$(` no: es una sustitución del shell
const CONEXION = /(^|[;"'\s(])(server|data source|addr|address|network address)\s*=\s*("[^"]*"|'[^']*'|[^;"'\s)]+)/gi;
// Sólo un id de recurso (`…/providers/Microsoft.Sql/servers/<nombre>`) nombra un servidor: el tipo
// `microsoft.sql/servers/databases` de una consulta de `az graph` no nombra ninguno, y leído como servidor
// frenaba la consulta por un host «databases» que no existe.
const RECURSO_SQL = /providers\/Microsoft\.Sql\/servers\/([A-Za-z0-9-]+)/i;
const URL_SQL = /(?:jdbc:)?(?:sqlserver|mssql|tds|azuresql|ms|odbc\+sqlserver):\/\/(?:[^@/\s]*@)?([A-Za-z0-9._*?{},-]+)/i;
// Un archivo NO es un servidor: `Data Source=app.db` es SQLite, y frenar un `dotnet ef` rutinario es
// cómo muere un control (pase adversarial 2026-09-15, F1).
const PARECE_ARCHIVO = /[\\/]|\.(db|db3|sqlite|sqlite3|mdf|sdf|accdb|mdb|csv|json|xml|udl)$/i;
// Lo que el shell resuelve y el freno no puede: `-S "$(cat host.txt)"` no es literal ni es variable
// conocida — caía en una grieta y se descartaba en silencio.
const NO_LITERAL = /\$\(|`|\$\{?[A-Za-z_]/;

const esAz = (tok) => /^az(?:\.cmd|\.exe)?$/i.test(basename(tok)) || esPalabraAz(String(tok));
// Los programas que sólo leen o muestran texto: un borrado nombrado ahí no corre. Sin `sed` ni `awk`, que ejecutan con
// `system()`.
const SOLO_MUESTRAN = new Set([...TEXTUALES].filter((p) => p !== 'sed' && p !== 'awk'));
// Los espacios de nombres de Azure cuyo recurso puede llevarse un servidor o su protección: el grupo (y la suscripción) y
// el candado. Borrarlos por `az resource delete` es lo mismo que `az group delete` y `az lock delete`.
const CONTENEDORES = new Set(['microsoft.resources', 'microsoft.authorization']);

/**
 * Lo que borra un `az resource delete` (los tokens desde `az`): `{ ilegible, servidores, sinServidor }`. `ilegible`: un
 * tipo o un id que no se puede leer (una variable, una sustitución, un comodín, un `-n` sin tipo). `servidores`: los
 * servidores SQL que nombra, para que los clasifique el catálogo. `sinServidor`: un tipo de Microsoft.Sql del que no se
 * sabe el servidor.
 */
// ¿`tok` es la bandera `completa`? az (argparse) acepta una bandera larga abreviada mientras no sea ambigua: `--meth`.
function esBandera(tok, completa, conocidas = []) {
  const x = String(tok || '');
  if (x === completa) return true;
  if (!completa.startsWith('--') || !x.startsWith('--') || x.length < 3 || !completa.startsWith(x)) return false;
  // la abreviatura vale si ninguna otra bandera conocida empieza igual (argparse la rechaza por ambigua)
  return !conocidas.some((c) => c !== completa && c.startsWith(x));
}
// Las banderas largas de `az resource delete` y de `az rest`, para decidir si una abreviatura es ambigua.
const BANDERAS_RESOURCE = ['--ids', '--name', '--namespace', '--resource-type', '--parent', '--resource-group', '--api-version', '--subscription'];
const BANDERAS_REST = ['--method', '--uri', '--url', '--body', '--headers', '--output-file', '--resource', '--skip-authorization-header', '--uri-parameters', '--url-parameters'];

function recursosDeAzResource(t) {
  const out = { ilegible: false, servidores: [], sinServidor: false, contenedor: false };
  const raro = (v) => v === null || v === undefined || v === '' || NO_LITERAL.test(v) || /[*?[\]{}]/.test(v);
  // como az (argparse): gana la última aparición de una bandera repetida
  const valor = (banderas) => {
    let v = null;
    for (let i = 0; i < t.length; i++) {
      if (banderas.some((b) => esBandera(t[i], b, BANDERAS_RESOURCE))) v = t[i + 1] === undefined ? '' : t[i + 1];
      const m = /^(--?[A-Za-z-]+)=(.*)$/.exec(t[i]);
      if (m && banderas.some((b) => esBandera(m[1], b, BANDERAS_RESOURCE))) v = m[2];
    }
    return v;
  };
  const ids = [];
  for (let i = 0; i < t.length; i++) {
    const m = /^(--[A-Za-z-]+)=(.*)$/.exec(t[i]);
    if (m && esBandera(m[1], '--ids', BANDERAS_RESOURCE)) ids.push(m[2]);
    if (!esBandera(t[i], '--ids', BANDERAS_RESOURCE)) continue;
    for (let j = i + 1; j < t.length && !t[j].startsWith('-'); j++) ids.push(t[j]);
  }
  for (const id of ids) {
    const p = /\/providers\/([^/]+)\/[^/]+/i.exec(id);
    if (raro(id) || !p) { out.ilegible = true; continue; }
    if (CONTENEDORES.has(p[1].toLowerCase())) { out.contenedor = true; continue; }
    if (p[1].toLowerCase() !== 'microsoft.sql') continue;
    const s = RECURSO_SQL.exec(id);
    if (s) out.servidores.push(s[1]); else out.sinServidor = true;
  }
  if (ids.length) return out;
  const tipo = valor(['--resource-type']);
  const ns = valor(['--namespace']);
  const nombre = valor(['-n', '--name']);
  const padre = valor(['--parent']);
  if (raro(tipo) || (ns !== null && raro(ns))) { out.ilegible = true; return out; }
  const completo = (ns ? `${ns}/${tipo}` : tipo).toLowerCase();
  if (!/^[a-z0-9.]+\/[a-z0-9/]+$/.test(completo)) { out.ilegible = true; return out; }
  if (CONTENEDORES.has(completo.split('/')[0])) { out.contenedor = true; return out; }
  if (!completo.startsWith('microsoft.sql/')) return out;
  const sub = completo.slice('microsoft.sql/'.length);
  if (sub === 'servers') {
    if (raro(nombre)) out.sinServidor = true; else out.servidores.push(nombre);
  } else {
    const s = padre && /^servers\/([^/]+)/i.exec(padre);
    if (!s || raro(s[1])) out.sinServidor = true; else out.servidores.push(s[1]);
  }
  return out;
}

/** Las palabras de un segmento sin sus redirecciones: el operador suelto se lleva su destino; pegado (`>f`, `2>&1`), sólo él. */
function sinRedirecciones(t) {
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (/^\d*(?:>>?|<|&>>?|>&|<&|>\|)$/.test(t[i])) { i++; continue; }
    if (/^\d*(?:>>?|<|&>>?|>&|<&|>\|)\S/.test(t[i])) continue;
    out.push(t[i]);
  }
  return out;
}

/**
 * ¿Las palabras escritas de lo que sigue a un programa variable forman un borrado en Azure? `group`, `lock` o `resource`
 * seguidos de `delete`; un subcomando que no se lee seguido de `delete` (`$A $B delete`); o `rest` con el método delete.
 */
function formaBorrado(resto) {
  const b = resto.map((x) => (NO_LITERAL.test(x) ? null : desescapar(x).toLowerCase()));
  if (b.includes('rest') && b.some((x) => x === 'delete' || (x && /^(?:--m[a-z]*|-m)=?delete$/.test(x)))) return true;
  const k = b.indexOf('delete');
  if (k < 0) return false;
  return b.slice(0, k).some((x) => x === null || x === 'group' || x === 'lock' || x === 'resource');
}

// El contenido de un guion que corre un shell (regla d de textosEscondidos, sin la marca de código): sus palabras son
// comandos. Un heredoc que no va a un shell ni a un intérprete (el mensaje de `git commit -F -`) no lo es.
function esGuionDeShell(x, escondidos) {
  const e = escondidos.find((y) => y.texto === x.texto);
  return Boolean(e && e.guion);
}

/**
 * El borrado en Azure que corre el comando, leído de cada segmento: `{ frena: true, que }` si se frena; `{ frena: false }`
 * si borra recursos legibles (los de SQL los decide el paso 4); null si no borra nada en Azure. Texto puro: no lee disco
 * ni ejecuta `az`.
 */
function borradoDeAzure(partes, tokens, PREFIJOS) {
  let visto = null;
  for (let p = 0; p < partes.length; p++) {
    const { texto } = partes[p];
    // el cortador saca `$( … )` de su lugar: lo que sigue a su cierre (`$(command -v az) group delete`) puede llevar
    // adelante un programa que sale de esa sustitución
    const trasSustitucion = p > 0 && /^[)`]$/.test(partes[p - 1].sep);
    const t = tokensDeSegmento(texto, tokens, PREFIJOS);
    if (!t.length || SOLO_MUESTRAN.has(basename(t[0]).toLowerCase())) continue;
    // sobre el texto del segmento, no por palabra: dentro de un bloque (`%{Remove-AzResourceGroup …}`) o con el módulo
    // adelante (`Az.Resources\Remove-AzResourceGroup`) el cmdlet no queda como palabra suelta
    const cmdlet = (x, re) => re.test(String(x).replace(/^[%{(@$]+/, '').replace(/^[\w.\\]*?(?=(?:Remove|Invoke)-Az)/i, ''));
    if (t.some((x) => cmdlet(x, /^Remove-Az(?:ResourceGroup|ResourceLock|Resource|SqlServer|SqlDatabase)(?![A-Za-z0-9_])/i))) {
      return { frena: true, que: 'con PowerShell (Remove-Az…) un grupo, un recurso, un servidor, una base o un candado' };
    }
    const iInvoke = t.findIndex((x) => cmdlet(x, /^Invoke-AzRestMethod(?![A-Za-z0-9_])/i));
    if (iInvoke >= 0) {
      let m = null;
      for (let j = iInvoke + 1; j < t.length; j++) {
        const pm = /^-m(?:e(?:t(?:h(?:o(?:d)?)?)?)?)?(?::(.*))?$/i.exec(t[j]);
        if (pm) m = pm[1] !== undefined && pm[1] !== '' ? pm[1] : (t[j + 1] === undefined ? '' : t[j + 1]);
      }
      const splat = t.slice(iInvoke + 1).some((x) => /^@[A-Za-z_]/.test(x));
      if ((m === null && splat) || (m !== null && (NO_LITERAL.test(m) || /^delete$/i.test(desescapar(m))))) {
        return { frena: true, que: 'por la API de Azure (Invoke-AzRestMethod con delete) algo que puede ser un grupo o un servidor' };
      }
    }
    // `ssh host '…'`: el comando corre en otra máquina, pero un `az` ahí borra igual en Azure
    if (basename(t[0]).toLowerCase() === 'ssh' && nombraBorradoAzure(texto)) {
      return { frena: true, que: 'por ssh, en otra máquina, algo que puede ser un grupo, un candado o un servidor' };
    }
    // `Invoke-Expression` (`iex`) es el `eval` de PowerShell: su texto se mira con el criterio crudo
    if (/^(?:invoke-expression|iex)$/.test(basename(t[0]).toLowerCase()) && nombraBorradoAzure(texto)) {
      return { frena: true, que: 'con Invoke-Expression algo que puede ser un grupo, un candado o un servidor' };
    }
    const iAzd = t.findIndex((x) => /^azd(?:\.cmd|\.exe)?$/i.test(basename(x)));
    if (iAzd >= 0 && t.slice(iAzd + 1).some((x) => x.toLowerCase() === 'down')) return { frena: true, que: 'con `azd down` los recursos de un entorno, que pueden incluir un servidor' };
    // `awk` y `sed` ejecutan comandos desde su programa (`system()`, `e`): el borrado viaja adentro de un argumento, y se
    // mira el texto del segmento con el criterio crudo
    if (/^(?:g|n|m)?awk$|^g?sed$/.test(basename(t[0]).toLowerCase()) && nombraBorradoAzure(texto)) {
      return { frena: true, que: 'desde un programa de awk o sed algo que puede ser un grupo, un candado o un servidor' };
    }
    // lo que va a una redirección (`> "$OUT"`, `2>&1`) no es un argumento del programa
    const args = sinRedirecciones(t);
    let iAz = args.findIndex(esAz);
    // el programa sale de una variable o de una sustitución (`$A`, `"$X"`, `${X}`, `$(…)`): puede ser cualquier programa, y
    // se juzga como `az` sólo si las palabras escritas forman un borrado (`$A group delete`). Con `az` escrito, lo que no
    // se lee frena.
    const programaVariable = iAz < 0 && args.length > 0 && (NO_LITERAL.test(args[0]) || trasSustitucion);
    if (programaVariable) iAz = NO_LITERAL.test(args[0]) ? 0 : -1;
    else if (iAz < 0) continue;
    const resto = args.slice(iAz + 1);
    if (programaVariable && !formaBorrado(resto)) continue;
    // desescapadas, como las corre el shell: `del\ete` es `delete`
    const bajo = resto.map((x) => desescapar(x).toLowerCase());
    // el subcomando que no se puede leer (sale de una variable o de una sustitución), o el que `xargs` agrega desde la
    // entrada: no se puede probar que no sea un borrado
    const subcomando = [];
    for (const x of resto) { if (x.startsWith('-')) break; subcomando.push(x); }
    if (subcomando.some((x) => NO_LITERAL.test(x))) return { frena: true, que: 'algo que no se puede leer (el subcomando de az sale de una variable)' };
    const agrega = /^(?:xargs|parallel|find)$/.test(basename(t[0]).toLowerCase());
    const conMarcador = subcomando.some((x) => /\{\}|^%$|\{[0-9.]*\}/.test(x));
    // sólo el grupo sin verbo (`xargs az group`): el verbo lo agrega la entrada; `az group show -n {}` sí se lee
    const sinVerbo = subcomando.length === 1 && ['group', 'lock', 'resource'].includes(subcomando[0].toLowerCase());
    if (agrega && (!subcomando.length || conMarcador || sinVerbo)) return { frena: true, que: 'algo que no se puede leer (xargs, parallel o find le agregan a az palabras desde la entrada)' };
    const despues = (palabra) => { const k = bajo.indexOf(palabra); return k >= 0 && bajo.indexOf('delete', k + 1) > k; };
    if (despues('group')) return { frena: true, que: 'un grupo de recursos' };
    if (despues('lock')) return { frena: true, que: 'un candado (la protección contra el borrado)' };
    if (bajo.includes('rest')) {
      // el método, en cualquier forma que acepta az: `--method X`, `-m X`, `--method=X`, `-m=X` o `-mX`; uno que sale de
      // una variable no se puede leer y frena
      let metodo = null;
      for (let k = 0; k < resto.length; k++) {
        if ((esBandera(bajo[k], '--method', BANDERAS_REST) || bajo[k] === '-m') && resto[k + 1] !== undefined) metodo = desescapar(resto[k + 1]);
        const largo = /^(--[a-z-]+)=(.+)$/i.exec(resto[k]);
        if (largo && esBandera(largo[1].toLowerCase(), '--method', BANDERAS_REST)) metodo = largo[2];
        const corto = /^-m=?(.+)$/i.exec(resto[k]);
        if (corto && bajo[k] !== '-m' && !/^-m[a-z]+-/.test(bajo[k])) metodo = corto[1];
      }
      if (metodo !== null && (NO_LITERAL.test(metodo) || metodo.toLowerCase() === 'delete')) return { frena: true, que: 'por la API de Azure (az rest con el método delete) algo que puede ser un grupo o un servidor' };
    }
    if (despues('resource')) {
      const r = recursosDeAzResource(resto);
      if (r.contenedor) return { frena: true, que: 'por az resource delete un grupo, una suscripción o un candado' };
      if (r.ilegible || r.sinServidor) return { frena: true, que: 'un recurso del que no se puede leer el tipo o el servidor' };
      visto = { frena: false };
    }
  }
  return visto;
}

/** @returns {{host:string|null, crudo:string, via:string}[]} los servidores que el comando nombra */
function servidoresNombrados(partes, tokens, PREFIJOS, vars, expandir) {
  const out = [];
  const { normalizar, esLocal } = require(require('path').join(__dirname, '..', 'production', 'production-index.js'));
  const agregar = (crudo, via) => {
    if (crudo === undefined || crudo === null || crudo === '') return;
    const texto = String(crudo);
    if (NO_LITERAL.test(texto)) {
      const resuelto = expandir(texto, vars);        // puede resolverse si el propio comando la define
      if (resuelto === null || NO_LITERAL.test(resuelto)) { out.push({ host: null, crudo: texto, via }); return; }
      const h0 = normalizar(resuelto);
      if (h0 && !esLocal(h0)) out.push({ host: h0, crudo: texto, via });
      else out.push({ host: h0 || null, crudo: texto, via, benigno: true });
      return;
    }
    // 🔴 «Lo miré y no es un servidor» se anota igual (benigno): si no, el comando quedaba como
    // «no pude analizar nada» y la red de seguridad de abajo frenaba un `dotnet ef --connection
    // "Data Source=app.db"` o un `sqlcmd -S localhost` (revisores, 2026-09-15).
    if (PARECE_ARCHIVO.test(texto)) { out.push({ host: null, crudo: texto, via, benigno: true }); return; }
    // Comodines y llaves del shell (`{acme-sql,}`, `acme-s*`) y prefijos de protocolo del
    // cliente (`admin:host`, `np:\\host`, `tcp:host`) se resuelven DESPUÉS del freno: no es un literal.
    if (/[*?[\]{}]/.test(texto)) { out.push({ host: null, crudo: texto, via }); return; }
    const sinProto = texto.replace(/^(?:tcp|np|lpc|admin):/i, '');
    const h = normalizar(sinProto);
    // 🔴 Antes: `if (!h) return` — un servidor que no se podía leer como nombre de host se DESCARTABA
    // en silencio y el comando pasaba (`-S admin:<prod>`, `usql azuresql://<prod>`, revisores).
    // Ahora es desconocido, y lo desconocido se trata como producción.
    if (!h) { out.push({ host: null, crudo: texto, via }); return; }
    if (esLocal(h)) { out.push({ host: h, crudo: texto, via, benigno: true }); return; }   // localhost y compañía no se juzgan (AC 8)
    out.push({ host: h, crudo: texto, via });
  };

  for (const { texto } of partes) {
    const sinPrefijo = texto.replace(PREFIJOS, '');
    const t = tokensDeSegmento(texto, tokens, PREFIJOS);
    if (!t.length) continue;
    const prog = basename(t[0]);

    // 1. clientes de base, en cualquier posición del segmento (sudo/nice/env por delante, etc.)
    const clientes = dondeEsta(t, new Set(Object.keys(CLIENTES)));
    for (const i of clientes) {
      const antesNombrados = out.length;
      const cliente = basename(t[i]).toLowerCase();
      const banderas = CLIENTES[cliente];
      for (let j = i + 1; j < t.length; j++) {
        for (const b of banderas) {
          const igualBandera = t[j] === b
            || (!BANDERAS_EXACTAS.has(cliente) && b.startsWith('-') && !b.startsWith('--') && t[j].toLowerCase() === b.toLowerCase());
          if (igualBandera && t[j + 1] !== undefined) agregar(crudoDe(texto, t[j + 1]), 'cliente');
          const pegado = new RegExp(`^${b.replace(/[/\\-]/g, '\\$&')}[:=]?(.+)$`).exec(t[j]);
          if (pegado && pegado[1]) agregar(crudoDe(texto, pegado[1]), 'cliente');
        }
        const url = URL_SQL.exec(t[j]);
        if (url) agregar(url[1], 'url');
      }
      // 2. el servidor por variable de entorno, cuando no vino ninguna bandera
      const antesDelEntorno = out.length;
      for (const v of VARIABLES_SERVIDOR) {
        if (v in vars) agregar(vars[v], 'variable-de-entorno');
        const asignado = new RegExp(`(?:^|[;&\\s])(?:export\\s+)?${v}=("[^"]*"|'[^']*'|[^\\s;&|)]+)`).exec(texto);
        if (asignado) agregar(sinComillas(asignado[1]), 'variable-de-entorno');
      }
      // 2b. 🔴 Un cliente que CONSULTA y no nombró servidor por ningún lado (ni bandera, ni cadena de
      // conexión, ni variable de este comando) lo toma del entorno de la sesión o del servidor local:
      // no se puede saber cuál, así que es desconocido y se frena. Se evalúa DESPUÉS del entorno para
      // no pisar el caso en que sí se nombra (revisores, 2026-09-15).
      // 🔴 En POSICIÓN DE PROGRAMA (el cliente es lo que se ejecuta, no una palabra suelta): así
      // `command -v sqlcmd mssql-cli bcp` —preguntar si están instalados— no se frena, y medido
      // sobre 4.000 comandos reales ése aparece de verdad (2026-09-15).
      if (i === 0 && out.length === antesDelEntorno && antesNombrados === out.length) {
        out.push({ host: null, crudo: `${basename(t[i]).toLowerCase()} sin servidor explícito`, via: 'sin-servidor' });
      }
    }

    if (prog === 'az' || t.some(esAz)) {
      // el subcomando de `az sql`, hasta la primera bandera: `az sql server firewall-rule create -s …` → server, firewall-rule, create
      const iSql = t.findIndex((x, k) => x === 'sql' && k > 0 && esAz(t[k - 1]));
      const ruta = [];
      for (let k = iSql + 1; iSql >= 0 && k < t.length && !t[k].startsWith('-'); k++) ruta.push(t[k]);
      // `-s` es el servidor en `az sql db|dw|elastic-pool …` y en los grupos de `az sql server` (firewall-rule, ad-admin…),
      // pero `az sql server <verbo>` no lo tiene: ahí el servidor es `-n`, y lo que sigue a `-s` (en la práctica, el id
      // de una suscripción) leído como servidor frenaba una consulta de configuración
      const sinFlagS = ruta.length === 2 && ruta[0] === 'server';
      for (let i = 1; i < t.length; i++) {
        // `az sql server update|show|delete -n <nombre>`: ahí el servidor es el recurso mismo
        const esSqlServer = t.includes('sql') && t.includes('server');
        const esFlagServidor = (t[i] === '--server' || (t[i] === '-s' && t.includes('sql') && !sinFlagS) ||
                                (esSqlServer && (t[i] === '-n' || t[i] === '--name')));
        if (esFlagServidor && t[i + 1] !== undefined) agregar(crudoDe(texto, t[i + 1]), 'az');
        const igual = /^--server[=:](.+)$/.exec(t[i]);
        if (igual) agregar(crudoDe(texto, igual[1]), 'az');
        const rec = RECURSO_SQL.exec(t[i]);
        if (rec) agregar(rec[1], 'recurso');
      }
      // `az resource delete -n <s> --resource-type Microsoft.Sql/servers` y `--parent servers/<s>`: el servidor sale del
      // nombre y del tipo (los `--ids` ya los lee la línea de arriba)
      const iAz = t.findIndex(esAz);
      if (iAz >= 0 && t.slice(iAz + 1).some((x) => x.toLowerCase() === 'resource') && !t.includes('--ids')) {
        for (const srv of recursosDeAzResource(t.slice(iAz + 1)).servidores) agregar(crudoDe(texto, srv), 'recurso');
      }
    }

    // 3. cadenas de conexión y URLs, en cualquier comando que no sea una herramienta de texto
    if (!TEXTUALES.has(prog)) {
      let m; CONEXION.lastIndex = 0;
      while ((m = CONEXION.exec(sinPrefijo))) {
        const valor = sinComillas(m[3]).trim();
        if (!valor || LLAMADA_DE_CODIGO.test(valor)) continue;
        agregar(valor.replace(/^tcp:/i, ''), 'cadena');
      }
      const url = URL_SQL.exec(sinPrefijo);
      if (url) agregar(url[1], 'url');
    }
    const rec = RECURSO_SQL.exec(sinPrefijo);
    if (rec && prog !== 'az') agregar(rec[1], 'recurso');
  }
  // el mismo host nombrado dos veces se decide una sola
  const vistos = new Set();
  return out.filter((n) => { const k = `${n.host}|${n.crudo}`; if (vistos.has(k)) return false; vistos.add(k); return true; });
}

/** Devuelve el token TAL CUAL aparecía en el texto (con `$VAR` sin resolver) si se puede ubicar. */
function crudoDe(texto, tokenDesEntrecomillado) {
  const esc = tokenDesEntrecomillado.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?)|(${esc})`).exec(texto);
  return m && m[1] ? m[1] : tokenDesEntrecomillado;
}

// ── integridad de la puerta (AC 11) y secuestro del shell (AC 12) ─────────────────────────────
function verificarPuerta() {
  const fs = require('fs'); const crypto = require('crypto'); const path = require('path');
  const raiz = costura('TYCON_PROD_ROOT') || '';
  const puerta = path.join(raiz, PUERTA);
  const referencia = path.join(raiz, '/opt/tycon/huellas.json');
  let hayPuerta = false;
  try { hayPuerta = fs.statSync(puerta).isFile(); } catch { hayPuerta = false; }
  let ref = null;
  try { ref = JSON.parse(fs.readFileSync(referencia, 'utf8')); } catch { ref = null; }
  // Máquina sin el freno instalado (no hay puerta ni huellas): la forma canónica no se frena — el
  // comando va a fallar solo, y frenarlo no agrega nada. Este hook sólo corre instalado.
  if (!hayPuerta && !ref) return null;
  if (!ref || !ref[PUERTA]) return 'la puerta existe pero no hay huella de referencia para verificarla.';
  if (!hayPuerta) return 'hay una huella de referencia pero la puerta no está donde debería.';
  const sha = crypto.createHash('sha256').update(fs.readFileSync(puerta)).digest('hex');
  if (sha !== ref[PUERTA]) return 'la puerta NO coincide con la huella que dejó el instalador (alguien la cambió).';
  return null;
}

const CORTE_SHIMS = '# Check for rg availability';
const NOMBRES_SECUESTRABLES = [NOMBRE_PUERTA, PUERTA, 'command'];
function defineNombre(texto) {
  for (const n of NOMBRES_SECUESTRABLES) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 🔴 zsh vuelca los alias como `alias -- nombre=valor` (verificado en un snapshot real): sin
    // aceptar las opciones, esta mitad de la detección NUNCA disparaba sobre datos reales — y el
    // caso que la «verificaba» sembraba un formato que zsh no emite (pase adversarial 2026-09-15).
    const re = new RegExp(`^\\s*(?:function\\s+)?${esc}\\s*\\(\\s*\\)|^\\s*function\\s+${esc}\\s|^\\s*alias(?:\\s+-[A-Za-z-]+)*\\s+${esc}=`, 'm');
    if (re.test(texto)) return n;
  }
  return null;
}

/** @returns {string|null} motivo del freno si algo puede quedarse con la sentencia antes que la puerta */
function detectarSecuestro(cmd) {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  // (c) el propio comando: una función definida en el mismo comando no está en ningún snapshot
  const propio = defineNombre(cmd);
  if (propio) return `el propio comando define «${propio}» antes de invocar la puerta.`;

  // (b) los archivos de arranque del shell
  const home = process.env.HOME || os.homedir();
  for (const f of ['.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile']) {
    let texto;
    try { texto = fs.readFileSync(path.join(home, f), 'utf8'); } catch { continue; }
    const n = defineNombre(texto);
    if (n) return `tu ${f} define «${n}»: secuestraría la puerta.`;
  }

  // (a) el snapshot de shell de ESTA sesión — o, si la herramienta no dejó ninguno, el shell de login en vivo
  const dir = path.join(home, '.claude', 'shell-snapshots');
  let archivos = [];
  try { archivos = fs.readdirSync(dir).filter((f) => /^snapshot-(zsh|bash)-\d+-/.test(f)); } catch { archivos = []; }
  const desde = arranqueDeLaSesion();
  if (desde === null) return 'no pude saber cuándo arrancó esta sesión para elegir su snapshot de shell (y sin eso no puedo descartar un secuestro).';
  const candidatos = archivos.filter((f) => Number((/-(\d+)-/.exec(f) || [])[1] || 0) >= desde);
  // 🔴 Sin snapshot NO es «no pude mirar»: Claude Code 2.1.272 (extensión de VS Code, medido en esta
  // Mac el 2026-09-16 con `ps` sobre el propio comando) ya no escribe ninguno y corre cada comando
  // como `zsh -c -l …`, sin sourcear nada. Frenar por la ausencia dejaba la puerta CERRADA para
  // siempre en esas sesiones (14:21Z, 3 intentos, y el dev sin poder trabajar) — y no la hacía más
  // segura: lo que ahí secuestra son los archivos de arranque del login, que se le preguntan al
  // mismo shell, arrancado igual. Con snapshot, se sigue mirando el snapshot (es lo que se sourcea).
  if (!candidatos.length) return secuestroEnShellDeLogin();
  for (const f of candidatos) {                      // más de uno → se revisan TODOS (lado seguro)
    let texto;
    try { texto = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return `no pude leer el snapshot de shell ${f}.`; }
    const corte = texto.indexOf(CORTE_SHIMS);
    if (!/^# Snapshot file/.test(texto)) return `el archivo ${f} no parece un snapshot de shell (formato desconocido).`;
    // los shims de Claude Code (rg, find, grep, pkill) viven al final: sin cortar, el hook acusaría
    // a la herramienta de secuestrar la puerta en todas las máquinas
    const util = corte >= 0 ? texto.slice(0, corte) : texto;
    if (corte < 0 && !/# Aliases/.test(texto)) return `el archivo ${f} no parece un snapshot de shell (formato desconocido).`;
    const n = defineNombre(util);
    if (n) return `el shell de esta sesión define «${n}»: secuestraría la puerta.`;
  }
  return null;
}

/**
 * Le pregunta al shell de login —arrancado como la herramienta arranca cada comando cuando no hay
 * snapshot: `<shell> -l -c …`— qué es cada nombre secuestrable. Medido (2026-09-16, zsh 5.9): un alias
 * cuyo nombre es la RUTA ABSOLUTA de la puerta se queda con la invocación canónica, una función con el
 * nombre corto también, `whence -w` delata a los dos, y con la config real tarda ~90 ms. Lo que ese
 * shell lee (.zshenv, .zprofile, .zlogin y lo que ellos sourceen) es justo lo que el barrido estático
 * de (b) no alcanza: ni .zlogin ni un archivo sourceado desde otro.
 * @returns {string|null} motivo del freno, o null si el shell no define ninguno
 */
function secuestroEnShellDeLogin() {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const shell = process.env.SHELL || '';
  const base = path.basename(shell);
  // los nombres de la puerta sólo pueden ser «nada» o un archivo; los que hacen la pregunta (command,
  // builtin y el propio whence/type) tienen que seguir siendo builtins, o la respuesta miente
  let script, sanos, preguntan;
  if (base === 'zsh') {
    script = 'for n; do \\builtin whence -w -- "$n"; done';
    sanos = new Set(['none', 'command']); preguntan = ['command', 'builtin', 'whence'];
  } else if (base === 'bash') {
    script = 'for n; do t=$(\\builtin type -t -- "$n") || t=none; printf "%s: %s\\n" "$n" "$t"; done';
    sanos = new Set(['none', 'file']); preguntan = ['command', 'builtin', 'type'];
  } else {
    return `sin snapshot de shell, y no sé preguntarle a tu shell (${shell || 'SHELL vacío'}) qué define: sólo zsh y bash.`;
  }
  const puerta = [NOMBRE_PUERTA, PUERTA];
  const nombres = [...puerta, ...preguntan];
  const restante = RELOJ_MS - (Date.now() - t0) - 300;   // y que quede reloj para lo que sigue
  if (restante < 500) return 'sin tiempo para preguntarle al shell de login qué define.';
  const r = spawnSync(shell, ['-l', '-c', script, 'tycon-prod-guard', ...nombres], {
    encoding: 'utf8', timeout: Math.min(restante, 3000), stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  if (r.error || r.status === null) return `no pude preguntarle al shell de login (${shell}) qué define: ${r.error ? r.error.message : 'no contestó a tiempo'}.`;
  const lineas = String(r.stdout || '').split('\n');
  for (const n of nombres) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${esc}: ([a-z]+)$`);
    const hits = lineas.map((l) => re.exec(l)).filter(Boolean);
    if (hits.length !== 1) return `el shell de login (${shell}) no contestó qué es «${n}» (y sin eso no puedo descartar un secuestro).`;
    const tipo = hits[0][1];
    const sano = puerta.includes(n) ? sanos.has(tipo) : tipo === 'builtin';
    if (!sano) return `el shell de login de esta sesión define «${n}» (${tipo}): secuestraría la puerta.`;
  }
  return null;
}

/** Arranque de la sesión (ms). Sube por la ascendencia hasta el `claude` que invocó el hook. */
function arranqueDeLaSesion() {
  // La costura va PRIMERO a propósito: los casos del banco y las suites corren DENTRO de una sesión
  // de Claude Code, así que la ascendencia encontraría el `claude` de verdad y el resultado
  // dependería de la máquina. Y no abre nada: un valor chico (0) hace candidatos a TODOS los
  // snapshots —se revisan todos, frena de más— y uno futuro deja cero candidatos, que también frena.
  const inyectado = costura('TYCON_PROD_SESSION_SINCE');
  if (inyectado !== undefined && inyectado !== '' && !Number.isNaN(Number(inyectado))) return Number(inyectado);

  const { spawnSync } = require('child_process');
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid && pid > 1; i++) {
    if (vencido()) return null;                       // «no pude mirar» → el llamador frena
    const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1500 });
    if (r.status !== 0 || !r.stdout) break;
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.trim());
    if (!m) break;
    const comando = m[2];
    if (/(^|\/)claude(\s|$)/.test(comando) || comando.includes('native-binary/claude')) {
      const l = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1500 });
      const t = l.status === 0 ? Date.parse(l.stdout.trim()) : NaN;
      if (!Number.isNaN(t)) return t;
      break;
    }
    pid = Number(m[1]);
  }
  return null;   // sin ascendencia ni costura: «no pude mirar» → el llamador frena
}
