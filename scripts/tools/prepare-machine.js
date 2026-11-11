#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * prepare-machine.js — el paso guiado para trabajar con una coordinadora (guides/working-with-a-coordinator.md
 * §«Cómo se arranca»). Dice, de a una, qué le falta a esta máquina, cada cosa con el comando exacto para esa persona:
 *
 *   · el freno de producción, sólo en una máquina de producción, con el juicio del aviso de arranque
 *     (scripts/hooks/production-notice.js) y el comando según `guard.update` del perfil del equipo;
 *   · la confirmación de la coordinadora, sólo si el perfil trae `approvals.relay_session` (sin esa clave la
 *     coordinadora no firma);
 *   · la advertencia del modo sin permisos de Claude Code;
 *   · cada carpeta principal de `--repo` sin aprobar en Claude Code, o con imports externos del CLAUDE.md sin aceptar.
 *     Una copia de un repo aprobado no pregunta: basta la carpeta principal.
 *
 * SÓLO LEE Y DICE: no escribe en ningún lado, no acepta nada por la persona y no llama a `sudo`. Lo que no pudo mirar
 * lo dice en su línea y nunca dice «lista».
 *
 * Uso:  node prepare-machine.js --repo <carpeta> [--repo <otra>]
 * Sale: 0 lista · 1 falta algo · 2 algo no se pudo mirar.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ARNES = path.resolve(__dirname, '..', '..');

// Una ruta entre comillas para la terminal de esa persona: simples en Mac y Linux, y las de PowerShell en Windows.
function quote(p, platform) {
  const s = String(p);
  return platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
}
const openIn = (dir, platform) => (platform === 'win32' ? `Set-Location -LiteralPath ${quote(dir, platform)}; claude` : `cd ${quote(dir, platform)} && claude`);

function readJson(file) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, value: null };
    return { ok: false, problem: e.code || 'no es JSON' };
  }
}

// La carpeta principal de un repo (la de `.git`), o el motivo por el que no se pudo saber.
function mainFolder(dir) {
  if (!fs.existsSync(dir)) return { problem: 'no existe' };
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return { problem: 'no es un repo de git' };
  const common = r.stdout.trim();
  if (path.basename(common) !== '.git') return { problem: 'es un repo sin carpeta de trabajo' };
  return { main: fs.realpathSync(path.dirname(common)) };
}

// Los comentarios HTML, de izquierda a derecha y una sola vez, como los quita Claude Code: lo que queda al quitar uno
// no se vuelve a recorrer, y uno sin cerrar queda como texto.
function sinComentarios(text) {
  let fuera = '';
  let desde = 0;
  for (let abre = text.indexOf('<!--'); abre >= 0; abre = text.indexOf('<!--', desde)) {
    const cierra = text.indexOf('-->', abre + 4);
    if (cierra < 0) break;
    fuera += text.slice(desde, abre);
    desde = cierra + 3;
  }
  return fuera + text.slice(desde);
}

// Lo que Claude Code no lee como import: los bloques de código, el código en línea y los comentarios HTML.
const sinCodigo = (text) => sinComentarios(text
  .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
  .replace(/`[^`\n]*`/g, ''));

const PROFUNDIDAD_DE_IMPORTS = 5;

/**
 * ¿El repo importa algo de afuera de su carpeta, como lo ve Claude Code? Sólo en ese caso pregunta por los imports: un
 * repo sin imports externos deja la marca de aceptados en falso para siempre, y eso no es pendiente. Mira el CLAUDE.md
 * de la raíz, el de la carpeta de Claude Code del repo, el local y las reglas de esa carpeta, y sigue los imports de
 * adentro del repo hasta 5 niveles. No cuenta lo que está en código o en un comentario, ni un archivo que no existe
 * (Claude Code no lo carga). Devuelve true, false, o null si un archivo no se pudo leer (no es «sin imports»).
 */
function hasExternalImports(main, home = os.homedir()) {
  const delProyecto = path.join('.claude', 'CLAUDE.md');
  // las reglas viven al lado del CLAUDE.md de la carpeta de Claude Code del repo
  const reglas = path.join(path.dirname(delProyecto), 'rules');
  const raices = ['CLAUDE.md', delProyecto, 'CLAUDE.local.md'];
  try {
    for (const f of fs.readdirSync(path.join(main, reglas))) if (f.endsWith('.md')) raices.push(path.join(reglas, f));
  } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return null; }
  const vistos = new Set();
  const cola = raices.map((rel) => ({ file: path.join(main, rel), nivel: 0 }));
  while (cola.length) {
    const { file, nivel } = cola.shift();
    if (vistos.has(file)) continue;
    vistos.add(file);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') continue;
      return null;
    }
    for (const m of sinCodigo(text).matchAll(/(?:^|\s)@((?:~|\.{1,2}|\/|[A-Za-z]:[\\/])[^\s]*|[^\s@]+\/[^\s]*)/gm)) {
      const ref = m[1];
      const target = ref.startsWith('~') ? path.join(home, ref.slice(1))
        : (path.isAbsolute(ref) || /^[A-Za-z]:[\\/]/.test(ref)) ? path.resolve(ref)
          : path.resolve(path.dirname(file), ref);
      if (!fs.existsSync(target)) continue;
      const back = path.relative(main, target);
      if (back.startsWith('..') || path.isAbsolute(back)) return true;
      if (nivel + 1 < PROFUNDIDAD_DE_IMPORTS) cola.push({ file: target, nivel: nivel + 1 });
    }
  }
  return false;
}

// Lo que eligió la organización para actualizar el freno: «auto» o «password», con el aviso si no se pudo leer bien.
function guardUpdate(cfg) {
  const rota = (cfg.errores || []).find((e) => e.clave === 'guard.update');
  if (rota) return { value: 'password', note: `guard.update está roto en el perfil del equipo (${rota.motivo}): lo tomo como «con la contraseña»` };
  return { value: cfg.valores && cfg.valores.guard && cfg.valores.guard.update === 'auto' ? 'auto' : 'password' };
}

function guardItems({ judge, cfg, prodRoot, arnes, platform, home }) {
  const items = [];
  let j;
  try { j = judge(); } catch (e) { return [{ ok: null, text: `no pude saber si el freno de producción está al día (${e.message})` }]; }
  if (!j || !j.autorizada) {
    // una máquina que no es de producción no ve nada del freno, salvo lo que no se pudo consultar
    if (j && j.llaveroIlegible) items.push({ ok: null, text: 'no pude consultar el llavero propio para saber si esta máquina es de producción' });
    return items;
  }
  const installer = path.join(arnes, 'scripts', 'production', 'install-guard.sh');
  const permission = fs.existsSync(path.join(prodRoot, 'opt', 'tycon', 'production', 'auto-update.json'));
  const gu = guardUpdate(cfg);
  if (gu.note) items.push({ ok: null, text: gu.note });
  // los avisos del freno tal cual, salvo el de «quedó viejo», que va con el comando de este caso. Un renglón que empieza
  // con espacios sigue al aviso de arriba; uno 🟠 dice que el aviso no pudo mirar algo
  const delViejo = new Set(j.viejoLineas || []);
  let anterior = null;
  for (const a of j.avisos || []) {
    if (j.viejo && (delViejo.has(a) || /quedó viejo|Actualizalo \(pide tu contraseña/.test(a))) { anterior = null; continue; }
    if (/^\s*(→|Este aviso sale)/.test(a)) continue;
    if (/^\s/.test(a)) {
      if (anterior) anterior.text += ` ${a.trim()}`;
      continue;
    }
    const t = a.trim();
    anterior = { ok: /^🟠/.test(t) ? null : /^🔴/.test(t) ? false : null, text: `freno de producción: ${t}` };
    items.push(anterior);
  }
  if (gu.value === 'auto' && !permission) {
    items.push({ ok: false, text: 'freno de producción: la organización eligió que se actualice solo y esta máquina no tiene el permiso. Instalalo una vez (pide tu contraseña):', command: `sudo bash ${quote(installer, platform)} --allow-auto-update` });
  }
  if (j.viejo) {
    // con el permiso, por qué quedó viejo (el mismo juicio del aviso de arranque): algunos casos piden la contraseña
    let a = null;
    if (gu.value === 'auto' && permission) {
      try {
        const gun = require(path.join(__dirname, '..', 'hooks', 'guard-update-notice.js'));
        let logDir;
        try { logDir = require(path.join(__dirname, '..', 'hooks', 'guard-auto-update.js')).logDirDe(home); } catch { /* sin registro del gancho */ }
        a = gun.atraso({ prod: path.join(prodRoot, 'opt', 'tycon', 'production'), arnes, logDir });
      } catch (e) {
        items.push({ ok: null, text: `no pude saber por qué el freno quedó viejo (${e.message})` });
      }
    }
    if (a && a.pideContrasena) {
      items.push({ ok: false, text: `freno de producción: quedó viejo; ${a.texto.replace(/:?\s*`[^`]*`\s*$/, '')}:`, command: `sudo bash ${quote(installer, platform)}` });
    } else if (gu.value === 'auto' && permission) {
      items.push({ ok: false, text: 'freno de producción: quedó viejo; se pone al día solo al abrir una sesión, o ahora mismo con:', command: 'sudo -n /opt/tycon/setup/update-guard.sh' });
    } else {
      items.push({ ok: false, text: 'freno de producción: quedó viejo. Actualizalo con tu contraseña (la organización puede elegir que se actualice solo: guard.update: auto en el perfil del equipo):', command: `sudo bash ${quote(installer, platform)}` });
    }
  }
  return items;
}

function coordinatorItems({ cfg, home, arnes, platform }) {
  const relay = cfg.valores && cfg.valores.approvals && cfg.valores.approvals.relay_session;
  // sin approvals.relay_session la coordinadora no firma y confirm-designation se niega: no hay nada que confirmar
  if (!(typeof relay === 'string' && relay.trim())) return [];
  const ds = require(path.join(__dirname, '..', 'lib', 'delegated-signing.js'));
  let r;
  try { r = ds.confirmedDesignation(ds.accountPaths(home), { clave: relay }); } catch (e) {
    return [{ ok: null, text: `no pude saber si la coordinadora está confirmada (${e.message})` }];
  }
  if (r.ok) return [];
  const script = path.join(arnes, 'scripts', 'lib', 'delegated-signing.js');
  if (/ninguna sesión de esta máquina está designada/.test(r.reason)) {
    return [{ ok: false, text: 'la coordinadora: ninguna sesión está designada. En la pestaña de la que va a coordinar, corré /coordinate y después confirmala con:', command: `node ${quote(script, platform)} confirm-designation` }];
  }
  return [{ ok: false, text: 'la coordinadora: la designación no está confirmada. En su pestaña, corré y aprobá con un click:', command: `node ${quote(script, platform)} confirm-designation` }];
}

function bypassItems({ home }) {
  const s = readJson(path.join(home, '.claude', 'settings.json'));
  if (!s.ok) return [{ ok: null, text: `no pude leer ~/.claude/settings.json (${s.problem}): no sé si aceptaste la advertencia del modo sin permisos` }];
  if (s.value && s.value.skipDangerousModePermissionPrompt === true) return [];
  return [{ ok: false, text: 'la advertencia del modo sin permisos de Claude Code: abrí Claude así una vez, aceptala y salí con /exit:', command: 'claude --permission-mode bypassPermissions' }];
}

function repoItems({ repos, home, env, platform }) {
  const items = [];
  const file = env && env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
  const cfg = readJson(file);
  const projects = cfg.ok ? ((cfg.value || {}).projects || {}) : null;
  for (const dir of repos) {
    let m;
    try { m = mainFolder(dir); } catch (e) { m = { problem: `no pude saber su carpeta principal (${e.code || e.message})` }; }
    if (m.problem) { items.push({ ok: null, text: `${dir}: ${m.problem}` }); continue; }
    if (!projects) { items.push({ ok: null, text: `${m.main}: no pude saber si está aprobada (no pude leer ${file}: ${cfg.problem})` }); continue; }
    const p = projects[m.main] || {};
    if (!p.hasTrustDialogAccepted) {
      items.push({ ok: false, text: `${m.main}: sin aprobar en Claude Code. Abrila una vez y aceptá la carpeta (y los imports del CLAUDE.md, si pregunta):`, command: openIn(m.main, platform) });
      continue;
    }
    if (p.hasClaudeMdExternalIncludesApproved) continue;
    const ext = hasExternalImports(m.main, home);
    if (ext === null) {
      items.push({ ok: null, text: `${m.main}: no pude leer sus CLAUDE.md para saber si importan archivos de afuera` });
    } else if (ext && p.hasClaudeMdExternalIncludesWarningShown) {
      // ya se preguntó y se rechazó: Claude Code no vuelve a preguntar, y la sesión trabaja sin esos imports
      items.push({ ok: 'nota', text: `${m.main}: su CLAUDE.md importa archivos de afuera y los rechazaste una vez; Claude Code no vuelve a preguntar y las sesiones trabajan sin ellos` });
    } else if (ext) {
      items.push({ ok: false, text: `${m.main}: su CLAUDE.md importa archivos de afuera y los imports no están aceptados. Abrila una vez y aceptalos:`, command: openIn(m.main, platform) });
    }
  }
  return items;
}

/**
 * Lo que le falta a la máquina: `{ code, items }`, cada ítem `{ ok: false|null, text, command? }` (false: falta;
 * null: no se pudo mirar). `judgeGuard` y `prodRoot` reemplazan el juicio del freno y la raíz del sistema en las pruebas.
 */
function check(opts = {}) {
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const arnes = opts.arnes || ARNES;
  const platform = opts.platform || process.platform;
  // la raíz del sistema: la de prueba sólo donde el freno no está instalado, como en el aviso y el freno
  const prodRoot = opts.prodRoot || ((!fs.existsSync('/opt/tycon') && env.TYCON_PROD_ROOT) ? env.TYCON_PROD_ROOT : path.parse(process.cwd()).root);
  const judge = opts.judgeGuard || (() => require(path.join(__dirname, '..', 'hooks', 'production-notice.js')).juzgar({ soloLeer: true }));
  const items = [];
  let cfg;
  try { cfg = require(path.join(__dirname, '..', 'lib', 'tycon-config.js')).cargar({ env, home, arnes }); } catch (e) {
    cfg = { valores: {}, errores: [] };
    items.push({ ok: null, text: `no pude leer la configuración del arnés (${e.message})` });
  }
  // cada parte por separado: una que se cae se dice como «no pude mirar» y no tira abajo las demás
  const parte = (que, fn) => {
    try { items.push(...fn()); } catch (e) { items.push({ ok: null, text: `no pude mirar ${que} (${e.message})` }); }
  };
  parte('el freno de producción', () => guardItems({ judge, cfg, prodRoot, arnes, platform, home }));
  parte('la coordinadora', () => coordinatorItems({ cfg, home, arnes, platform }));
  parte('la advertencia del modo sin permisos', () => bypassItems({ home }));
  parte('las carpetas de los repos', () => repoItems({ repos: opts.repos || [], home, env, platform }));
  const pending = items.filter((i) => i.ok !== 'nota');
  const code = pending.some((i) => i.ok === null) ? 2 : pending.length ? 1 : 0;
  return { code, items };
}

function render(r) {
  const notas = r.items.filter((i) => i.ok === 'nota').map((i) => `ℹ️ ${i.text}`);
  const pending = r.items.filter((i) => i.ok !== 'nota');
  if (!pending.length) return ['✅ lista: esta máquina tiene todo para trabajar con una coordinadora.', ...notas].join('\n');
  const lines = [];
  pending.forEach((i, n) => {
    lines.push(`${n + 1}. ${i.ok === null ? '🟠' : '🔴'} ${i.text}`);
    if (i.command) lines.push(`     ${i.command}`);
  });
  lines.push(...notas);
  const missing = r.items.filter((i) => i.ok === false).length;
  const unknown = r.items.filter((i) => i.ok === null).length;
  lines.push(unknown
    ? `Todavía falta: ${missing} cosa(s) por hacer y ${unknown} que no pude mirar. Cuando lo hagas, volvé a correr esto.`
    : `Todavía falta: ${missing} cosa(s) por hacer. Cuando lo hagas, volvé a correr esto.`);
  return lines.join('\n');
}

function main(argv) {
  const repos = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo' && argv[i + 1]) { repos.push(path.resolve(argv[i + 1])); i += 1; }
    else if (argv[i] === '--help' || argv[i] === '-h') { process.stdout.write('uso: prepare-machine.js --repo <carpeta> [--repo <otra>]   (sólo lee y dice qué falta)\n'); return 0; }
    else { process.stderr.write(`prepare-machine.js: no entiendo «${argv[i]}» (uso: --repo <carpeta>)\n`); return 2; }
  }
  const r = check({ repos });
  process.stdout.write(`${render(r)}\n`);
  return r.code;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { check, render, hasExternalImports, quote };
