#!/usr/bin/env node
'use strict';

/**
 * machine-id.js — la huella de esta máquina, para decidir en qué máquinas vale una firma por delegación.
 *
 * La huella sale del id del sistema, que la cuenta del usuario no puede cambiar sin ser administrador:
 *   · Mac: `IOPlatformUUID`, de `/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice`;
 *   · Windows: `MachineGuid` de `HKLM\SOFTWARE\Microsoft\Cryptography`, con `C:\Windows\System32\reg.exe`;
 *   · Linux: `/etc/machine-id` (o `/var/lib/dbus/machine-id`).
 * Los programas se llaman por su ruta fija, nunca por el `PATH`, y corren con el ambiente vacío. La ruta de Windows es
 * fija y no sale de `SystemRoot`, que es una variable. La huella es el resumen, nunca el valor crudo: los primeros 16
 * hex de `sha256("tycon-machine:v1:" + valor)`, con el valor sin espacios y en minúsculas.
 *
 * Límites (escritos en la guía): un administrador cambia el id del sistema; dos máquinas clonadas con el mismo id dan
 * la misma huella; un `NODE_OPTIONS=--require …` o un `DYLD_*` puesto antes de arrancar Node cambia lo que este proceso
 * lee.
 *
 * Uso: `node scripts/lib/machine-id.js` → `{"huella":"…","fuente":"…"}`; sale 1 si la fuente no se lee.
 */

const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PREFIJO = 'tycon-machine:v1:';
const IOREG = '/usr/sbin/ioreg';
const REG = 'C:\\Windows\\System32\\reg.exe';
const LINUX = ['/etc/machine-id', '/var/lib/dbus/machine-id'];

/** Cómo corre el hijo que lee el id: sin ambiente, sin entrada y con un tope de tiempo. */
function opcionesDelHijo() {
  return { env: {}, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
}

function ejecutarSinAmbiente(cmd, args) { return execFileSync(cmd, args, opcionesDelHijo()); }
/** El texto del archivo, o `{ error }` con el código (ausente, sin permiso…): el motivo no se pierde. */
function leerArchivo(ruta) { try { return fs.readFileSync(ruta, 'utf8'); } catch (e) { return { error: (e && e.code) || String(e) }; } }

// la forma de cada id, ya normalizado: un UUID o un id de 32 hex. Un valor sin forma (vacío, `uninitialized` del primer
// arranque de systemd, un archivo truncado, todo ceros) no es un id: daría una huella que parece válida
const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORMA_LINUX = /^[0-9a-f]{32}$/;
function conForma(valor, forma) { return forma.test(valor) && /[1-9a-f]/.test(valor.replace(/-/g, '')); }

function resumen(valor) {
  return crypto.createHash('sha256').update(PREFIJO + valor).digest('hex').slice(0, 16);
}

function normalizar(valor) { return String(valor || '').replace(/\s+/g, '').toLowerCase(); }

/**
 * El id del sistema y de dónde salió: `{ valor, fuente }` o `{ error }`. Las tres fuentes se inyectan sólo en proceso
 * (las pruebas); la línea de comandos usa las reales.
 */
function leerFuente({ platform = process.platform, ejecutar = ejecutarSinAmbiente, leer = leerArchivo, existe = fs.existsSync } = {}) {
  const desdeSalida = (cmd, args, re, fuente) => {
    let salida;
    try { salida = String(ejecutar(cmd, args, opcionesDelHijo())); } catch (e) { return { error: `${fuente}: no se pudo correr (${(e && e.message) || e})` }; }
    const m = re.exec(salida);
    const valor = m ? normalizar(m[1]) : '';
    if (!valor) return { error: `${fuente}: la salida no trae el id` };
    return conForma(valor, FORMA_UUID) ? { valor, fuente } : { error: `${fuente}: el id no tiene la forma de un UUID` };
  };
  if (platform === 'darwin') return desdeSalida(IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice'], /"IOPlatformUUID"\s*=\s*"([^"]+)"/, `${IOREG} IOPlatformUUID`);
  if (platform === 'win32') {
    if (!existe(REG)) return { error: `${REG}: no está (la huella lee esa ruta fija)` };
    return desdeSalida(REG, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], /MachineGuid\s+REG_SZ\s+(\S+)/i, `${REG} MachineGuid`);
  }
  if (platform === 'linux') {
    const motivos = [];
    for (const ruta of LINUX) {
      const texto = leer(ruta);
      if (texto && typeof texto === 'object') { motivos.push(`${ruta}: ${texto.error}`); continue; }
      const valor = normalizar(texto);
      if (conForma(valor, FORMA_LINUX)) return { valor, fuente: ruta };
      motivos.push(`${ruta}: ${valor ? 'el id no tiene la forma de 32 hexadecimales' : 'vacío'}`);
    }
    return { error: `no se pudo leer el id (${motivos.join('; ')})` };
  }
  return { error: `la plataforma ${platform} no tiene una fuente de id conocida` };
}

/** La huella de esta máquina: `{ huella, fuente }` o `{ error }`. Nunca devuelve el valor crudo. */
function huella(opts = {}) {
  const f = leerFuente(opts);
  return f.error ? { error: f.error } : { huella: resumen(f.valor), fuente: f.fuente };
}

module.exports = { huella, resumen, opcionesDelHijo, PREFIJO };

if (require.main === module) {
  const r = huella();
  if (r.error) { process.stderr.write(`machine-id: ${r.error}\n`); process.exit(1); }
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
