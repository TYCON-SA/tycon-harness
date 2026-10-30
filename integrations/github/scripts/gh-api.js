'use strict';
// gh-api.js — la llamada a la API de GitHub que comparten las operaciones del conector: `gh api` con el método, la ruta
// y el cuerpo (por archivo), y su resultado en el vocabulario de la capa. TYCON_GH_CMD reemplaza a gh: un ejecutable, o
// un `.js` que corre con node.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const no = (reason, detail) => ({ ok: false, reason, detail });

// `dueño/nombre` de un repo de GitHub, que va pegado en la ruta de la API: el dueño no lleva puntos y ninguno de los
// dos empieza con «-»; el nombre puede empezar con punto (`.github`) pero no ser «.» ni «..», que armarían otra ruta.
const esRepoGithub = (id) => /^\w[\w-]*\/(?!\.\.?$)[\w.][\w.-]*$/.test(String(id));

/** `{value}` con la respuesta en JSON, o `{problem}` con el «no» de la capa. */
function gh(ctx, method, ruta, body) {
  const cmd = ctx.env.TYCON_GH_CMD || 'gh';
  const [bin, pre] = /\.js$/.test(cmd) ? [process.execPath, [cmd]] : [cmd, []];
  const args = [...pre, 'api', '--method', method, '-H', 'Accept: application/vnd.github+json', ruta];
  let dir = null;
  if (body) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-cuerpo-'));
    fs.writeFileSync(path.join(dir, 'cuerpo.json'), JSON.stringify(body));
    args.push('--input', path.join(dir, 'cuerpo.json'));
  }
  let r;
  try { r = spawnSync(bin, args, { env: ctx.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 }); } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (r.error) return { problem: no('no_medido', `${cmd} no se pudo ejecutar (${r.error.code || r.error.message})`) };
  if (r.status !== 0) {
    // el texto de gh, recortado: el detalle llega a la salida (la capa lo limpia de credenciales y direcciones)
    const t = `${r.stderr || ''} ${r.stdout || ''}`.trim().replace(/\s+/g, ' ').slice(0, 500);
    // un 403 por el tope de pedidos no es una credencial que falta: se dice como lo que es
    if (/rate limit/i.test(t)) return { problem: no('rechazado', `GitHub frenó por el tope de pedidos; reintentar más tarde: ${t}`) };
    if (/HTTP 401|gh auth login|Bad credentials|HTTP 403.*(SAML|SSO|Resource not accessible)/i.test(t)) return { problem: no('sin_credencial', `GitHub no aceptó la sesión de gh de esta máquina (gh auth login, o GH_TOKEN): ${t}`) };
    if (/HTTP (404|410)/.test(t)) return { problem: no('no_encontrado', t) };
    if (/HTTP (403|422)/.test(t)) return { problem: no('rechazado', t) };
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|could not resolve|error connecting to/i.test(t)) return { problem: no('red', t) };
    return { problem: no('rechazado', t || `gh salió ${r.status}`) };
  }
  // una escritura que salió 0 se hizo aunque la respuesta no se entienda (tomarla por fallada invitaría a repetirla)
  try { return { value: JSON.parse(r.stdout) }; } catch (_) { return method === 'GET' ? { problem: no('no_medido', 'gh contestó algo que no es JSON') } : { value: null }; }
}

module.exports = { gh, no, esRepoGithub };
