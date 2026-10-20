'use strict';
// read-permissions.js — las reglas de lectura del arnés en `permissions.allow` de ~/.claude/settings.json.
//
// La primera vez que el recorrido de una historia lee una guía o una skill del arnés (fuera de la carpeta del proyecto),
// Claude Code frena con «Read outside the working directories… Allow this read?». Si nadie contesta, la historia queda
// parada; la primera opción del cuadro deja leer toda la máquina sin preguntar. El arnés deja permitida de antemano la
// lectura de SUS carpetas, y nada más: una regla `Read(<carpeta>/**)` por cada una. Sólo lectura: editar sigue
// preguntando (por eso no `additionalDirectories`, que en modo «aceptar ediciones» también deja editar).
//
// Las carpetas: el árbol instalado (por su ruta real), los dos enlaces de ~/.claude que apuntan a él (el lugar del arnés
// y las skills instaladas, los dos de tycon-home.js) y cada skill de ~/.claude/skills cuya ruta real cae en el árbol. Una regla vale si cubre la ruta pedida
// y la real, así que cada enlace lleva la suya (medido con Claude Code 2.1.304: una skill enlazada al árbol preguntaba
// con el árbol permitido, y dejó de preguntar con su propia regla). Las skills propias del dev quedan afuera.
//
// Codex no tiene el problema: su sandbox de fábrica lee todo el disco sin preguntar. No se toca su configuración.
//
// Mismo patrón que plugin-dirs.js: lo propio es un ELEMENTO de una lista del dev. Se suma sólo lo que falta, al final y
// sin reordenar; una regla igual que ya tenía el dev es suya (no se anota y al desinstalar queda); al desinstalar se saca
// sólo lo anotado. Cada regla es una pieza `setting` con id `permissions.allow:<regla>` y la regla en `value`.
//
// Lo usan: shared.js (sumar y anotar), managed.js (¿está en su lugar?), remove.js (desinstalar) y el plan de harness.js.
// Vive en scripts/setup/harness/ porque la desinstalación corre desde la copia fija del programa, que sólo trae esa carpeta.

const fs = require('fs');
const path = require('path');

/** El comienzo del id de cada pieza: `permissions.allow:Read(~/.tycon/harness/**)`. */
const PREFIX = 'permissions.allow:';
/** El interruptor: `=1` no suma ni anota reglas. */
const OFF_ENV = 'TYCON_NO_READ_PERMISSIONS';

/** Los caracteres que una regla de permiso lee como comodín o como su propio cierre. */
const UNSAFE = /[*?[\]{}()]/;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const isRuleId = (id) => typeof id === 'string' && id.startsWith(PREFIX) && id.length > PREFIX.length;
const ruleOf = (id) => (isRuleId(id) ? id.slice(PREFIX.length) : null);
const pieceId = (rule) => `${PREFIX}${rule}`;

/**
 * La regla de una carpeta, en la forma que reconoce Claude Code: `~/…` si cae bajo la carpeta personal; si no, la
 * absoluta con `//` (en Windows la unidad va en minúscula y sin dos puntos: `//d/arnes`). Siempre con barras normales.
 */
function ruleFor(dir, { home, platform = process.platform }) {
  const win = platform === 'win32' || platform === 'windows';
  const P = win ? path.win32 : path.posix;
  const SEP = win ? /[\\/]+/ : /\/+/;
  const clean = (p) => P.normalize(String(p)).replace(win ? /[\\/]+$/ : /\/+$/, '');
  const d = clean(dir); const h = clean(home);
  const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  // la parte de la ruta que va escrita en la regla: lo que sigue a la carpeta personal (forma `~/…`) o la ruta entera
  let body = null; let lead = '~/';
  // bajo la carpeta personal tal cual o bajo su ruta real (una carpeta personal enlazada: la carpeta llega resuelta)
  const under = (base) => { const rel = P.relative(base, d); return rel && !rel.startsWith('..') && !P.isAbsolute(rel) && same(P.join(base, rel), d) ? rel : null; };
  let realHome = h;
  if (!win) { try { realHome = clean(fs.realpathSync(home)); } catch (_) { realHome = h; } }
  const rel = under(h) || (realHome !== h ? under(realHome) : null);
  if (rel) body = rel.split(SEP);
  else if (win) {
    const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(d);
    // una ruta de red (`\\servidor\recurso`) no tiene una forma documentada: sin regla
    if (!m) return null;
    lead = `//${m[1].toLowerCase()}/`; body = m[2].split(SEP);
  } else { lead = '//'; body = d.split(SEP); }
  body = body.filter(Boolean);
  // un carácter que la regla leería como comodín o como su cierre (`*?[]{}()`), o una barra invertida en Mac y Linux
  // (ahí es parte del nombre y la regla la leería como escape), no se escribe: la regla podría quedar más ancha que la
  // carpeta, apuntar a otra o quedar rota. Sin regla, esa lectura sigue preguntando (quien llama lo dice). Sólo se mira
  // lo que va escrito: una carpeta personal con paréntesis no impide la forma `~/…`
  if (body.some((x) => UNSAFE.test(x) || (!win && x.includes('\\')))) return null;
  return `Read(${lead}${body.join('/')}/**)`;
}

/**
 * Las reglas del arnés en esta máquina, sin repetir: el árbol (su ruta real y, si se lo nombra por otra, también ésa),
 * los dos enlaces a él que existan y cada skill de ~/.claude/skills que sea un enlace cuya ruta real cae en el árbol (en
 * orden alfabético). `skipped`, si se pasa, recibe las carpetas que no se pueden escribir como regla (ver `ruleFor`).
 */
function ourRules({ home, tree, platform = process.platform, skipped = null }) {
  const out = [];
  const add = (dir) => {
    const r = ruleFor(dir, { home, platform });
    if (r === null) { if (Array.isArray(skipped) && !skipped.includes(dir)) skipped.push(dir); return; }
    if (!out.includes(r)) out.push(r);
  };
  const treeReal = tree ? real(tree) : null;
  if (!treeReal) return out;
  // la instalación bajada: el árbol real es una carpeta de versions/, que cambia en cada actualización. La regla cubre
  // versions/ entera, así no nombra una versión ni cambia al actualizar (y cubre la ruta real, que Claude Code exige)
  // sólo la versions/ del arnés (~/.tycon/versions): otra carpeta que se llame igual no se ensancha
  const ours = real(path.join(require('./tycon-home.js').ownRootOf(home), 'versions'));
  const parent = path.dirname(treeReal);
  add(ours && parent === ours ? parent : treeReal);
  // nombrado por otra ruta (una carpeta enlazada en el medio): la regla vale para la pedida y para la real
  if (path.resolve(tree) !== treeReal) add(path.resolve(tree));
  // la carpeta de Claude Code y los dos enlaces (el lugar del arnés y las skills instaladas) los da tycon-home.js
  const TH = require('./tycon-home.js');
  const claude = TH.claudeDir(home);
  const inTree = (p) => { const r = real(p); return Boolean(r) && (r === treeReal || r.startsWith(treeReal + path.sep)); };
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };
  for (const p of [TH.placePath(home), TH.installedSkillsDir(home)]) {
    if (isLink(p) && inTree(p)) add(p);
  }
  let skills = [];
  try { skills = fs.readdirSync(path.join(claude, 'skills')).sort(); } catch (_) { skills = []; }
  for (const s of skills) {
    const p = path.join(claude, 'skills', s);
    if (isLink(p) && inTree(p)) add(p);
  }
  return out;
}

/**
 * Las reglas que va a dejar una instalación, para el plan que se muestra ANTES de instalar: las de hoy y la del enlace
 * del lugar del arnés, que `install` crea siempre después del plan. Los demás enlaces (las skills instaladas, cada
 * skill) los hace el aplicador sólo en algunas formas de instalar: se cuentan si ya están.
 */
function plannedRules({ home, tree, platform = process.platform }) {
  const out = ourRules({ home, tree, platform });
  if (!tree || !real(tree)) return out;
  const r = ruleFor(require('./tycon-home.js').placePath(home), { home, platform });
  if (r && !out.includes(r)) out.splice(Math.min(1, out.length), 0, r);
  return out;
}

/**
 * Suma a `settings` (el objeto ya leído) las reglas que faltan y saca las que el arnés anotó antes y ya no son suyas
 * (`previous`: las piezas del registro). Cambia el objeto en memoria. Devuelve `{ ok, reason, added, dropped, ours }`:
 * `ours` son las reglas que quedan y son del arnés (las que sumó ahora y las que ya había anotado); con `ok: false`
 * (`permissions` o `permissions.allow` con otra forma) no tocó nada.
 */
function apply(settings, rules, { previous = [] } = {}) {
  const out = { ok: true, reason: null, added: [], dropped: [], ours: [] };
  if ('permissions' in settings && !isObject(settings.permissions)) return Object.assign(out, { ok: false, reason: '«permissions» no es un objeto' });
  const perms = isObject(settings.permissions) ? settings.permissions : null;
  if (perms && 'allow' in perms && !Array.isArray(perms.allow)) return Object.assign(out, { ok: false, reason: '«permissions.allow» no es una lista' });
  const before = perms && Array.isArray(perms.allow) ? perms.allow.slice() : [];
  const noted = new Set((Array.isArray(previous) ? previous : []).filter((p) => isObject(p) && p.kind === 'setting').map((p) => ruleOf(p.id)).filter(Boolean));
  // las anotadas que ya no son del arnés (una skill que dejó de estar enlazada): se sacan
  out.dropped = [...noted].filter((r) => !rules.includes(r) && before.includes(r));
  const kept = before.filter((r) => !out.dropped.includes(r));
  out.added = rules.filter((r) => !kept.includes(r));
  out.ours = rules.filter((r) => out.added.includes(r) || noted.has(r));
  if (out.added.length || out.dropped.length) {
    const allow = [...kept, ...out.added];
    if (!perms) settings.permissions = {};
    if (allow.length) settings.permissions.allow = allow;
    else {
      delete settings.permissions.allow;
      if (!Object.keys(settings.permissions).length) delete settings.permissions;
    }
  }
  return out;
}

/** ¿`settings` tiene la regla en `permissions.allow`? */
function hasRule(settings, rule) {
  return isObject(settings) && isObject(settings.permissions) && Array.isArray(settings.permissions.allow) && settings.permissions.allow.includes(rule);
}

/**
 * Saca la regla de `settings` (en memoria). Sin nada más en `allow`, se saca la clave; sin nada en `permissions`, también.
 * Devuelve `true` si estaba.
 */
function removeRule(settings, rule) {
  if (!hasRule(settings, rule)) return false;
  const perms = settings.permissions;
  perms.allow = perms.allow.filter((r) => r !== rule);
  if (!perms.allow.length) delete perms.allow;
  if (!Object.keys(perms).length) delete settings.permissions;
  return true;
}

/** La nota en llano de lo que se sumó y se sacó (vacía si nada). */
function notes({ added, dropped }, file) {
  const out = [];
  if (added.length) out.push(`permití leer sin preguntar las carpetas del arnés en ${file}, sólo leer, no escribir: ${added.join(', ')}`);
  if (dropped.length) out.push(`saqué de ${file} el permiso de lectura que ya no es del arnés: ${dropped.join(', ')}`);
  return out;
}

module.exports = { PREFIX, OFF_ENV, ruleFor, ourRules, plannedRules, apply, hasRule, removeRule, notes, isRuleId, ruleOf, pieceId };
