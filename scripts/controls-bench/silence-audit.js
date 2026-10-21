#!/usr/bin/env node
/**
 * silence-audit — el banco no le grita sus propias alarmas al agente que está midiendo.
 *
 * EL RIESGO QUE CIERRA: si `advisor-runner.js` le pasa `env: process.env` a `codex`, los hooks de arranque del
 * arnés se disparan DENTRO del advisor y le inyectan "🔴 controls-bench EN ROJO — Correr: node .../runner.js". El
 * advisor, obediente, va y corre el banco: bajo sandbox de solo lectura eso es un permiso denegado, y con el tope de
 * tiempo del caso, una interrupción a los ~5 minutos. El banco se auto-envenena. Por eso a cada agente que lanza
 * (`claude` o `codex`) se le pasa TYCON_EVAL_SANDBOX=1, que silencia esos hooks.
 *
 * LA INVARIANTE QUE VIGILA: todo lugar del banco que lanza un agente (claude o codex) tiene que
 * silenciar al arnés. Es mecánica, gratis y no necesita una sola llamada al modelo — por eso vive
 * acá y no como caso del banco.
 *
 * ALCANCE: no sólo el banco. Los lanzamientos de afuera —el observador de instintos (claude y codex) y el demo de
 * advisors— también silencian, y el observador corre en cada arranque. La invariante es del arnés entero, no de una
 * carpeta.
 *
 * Uso: node silence-audit.js            → audita; sale ≠0 si hay un sitio sin silenciar
 *      node silence-audit.js --selftest → se prueba a sí mismo contra fuentes buenas y rotas
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FLAG = 'TYCON_EVAL_SANDBOX';
const SPAWN = /\b(?:spawnP|spawnSync|spawn|execFileSync|execFile)\s*\(\s*(['"`])(claude|codex)\1/g;

/** Texto completo de la llamada, balanceando paréntesis desde el `(` de apertura. */
function callText(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return src.slice(openIdx); // sin cerrar: devolvemos lo que hay y que falle por env ausente
}

/** Valor de `env:` balanceando (), {} y []: cortar en la primera coma parte Object.assign(). */
function valorDeEnv(call) {
  const m = /\benv\s*:\s*/.exec(call);
  // Atajo ES6 `{ ..., env }`: el valor es el identificador `env`. live-fire-stop.js lo usa,
  // y sin esta rama la auditoría lo denunciaba como "no pasa env" — un falso positivo que
  // habría empujado a "arreglar" código correcto (lo cazó su propio selftest).
  if (!m) return /[{,]\s*env\s*[,}]/.test(call) ? 'env' : null;
  let i = m.index + m[0].length, d = 0;
  const ini = i;
  for (; i < call.length; i++) {
    const c = call[i];
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { if (d === 0) break; d--; }
    else if (c === ',' && d === 0) break;
  }
  return call.slice(ini, i).trim();
}

/** ¿El `env:` de esta llamada termina conteniendo el flag? Resuelve identificadores. */
function silencia(src, call) {
  const valor = valorDeEnv(call);
  if (valor === null) return { ok: false, motivo: 'la llamada no pasa `env` — hereda el del padre sin silenciar' };
  if (valor.includes(FLAG)) return { ok: true };
  if (/^[A-Za-z_$][\w$]*$/.test(valor)) {
    // identificador: buscar su definición en el archivo
    const def = new RegExp(`\\b(?:const|let|var)\\s+${valor}\\s*=([\\s\\S]{0,400}?);`).exec(src);
    if (def && def[1].includes(FLAG)) return { ok: true };
    return { ok: false, motivo: `pasa \`env: ${valor}\` y esa variable no incorpora ${FLAG}` };
  }
  // LLAMADA a un helper — `env: envDeCorrida(corral)`. Sin esta rama la auditoría denunciaría un refactor CORRECTO (el
  // que centraliza el entorno de las corridas del banco): el silenciador está puesto, sólo que un nivel adentro. Un
  // control que castiga la buena práctica que él mismo empuja es un control que se termina apagando.
  const llamada = /^([A-Za-z_$][\w$]*)\s*\(/.exec(valor);
  if (llamada) {
    const fn = new RegExp(`\\bfunction\\s+${llamada[1]}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]{0,600}?)\\n\\}`).exec(src);
    if (fn && fn[1].includes(FLAG)) return { ok: true };
    return { ok: false, motivo: `pasa \`env: ${valor.slice(0, 40)}\` y esa función no incorpora ${FLAG}` };
  }
  return { ok: false, motivo: `pasa \`env: ${valor.slice(0, 60)}\` sin ${FLAG}` };
}

function auditarFuente(src, file) {
  const fallas = [];
  SPAWN.lastIndex = 0;
  let m;
  while ((m = SPAWN.exec(src))) {
    // 🔴 Prosa no es código. Si la coincidencia está en una línea de comentario —de bloque (` * …`), de línea
    // (`// …`) o detrás de un `//` en la misma línea— no es un lanzamiento: la cabecera de tools-path.js cuenta el
    // problema del PATH con la frase literal, que no es una llamada. Un control que acusa a la prosa que explica
    // el defecto se termina apagando. Se mira SÓLO la línea de la coincidencia:
    // un comentario arriba no exime al código de abajo (eso lo hace la escotilla declarada, con motivo).
    const iniLinea = src.lastIndexOf('\n', m.index) + 1;
    const antes = src.slice(iniLinea, m.index);
    if (/^\s*(\/\/|\*|\/\*)/.test(antes) || /\/\/[^'"`]*$/.test(antes)) continue;
    const open = src.indexOf('(', m.index);
    const call = callText(src, open);
    const v = silencia(src, call);
    // Escotilla DECLARADA: `// silence-audit: exento — <motivo>` en alguna de las 3 líneas previas.
    // Existe para que una excepción legítima se escriba, en vez de que alguien apague la auditoría.
    const previas = src.slice(0, m.index).split('\n').slice(-4).join('\n');
    if (!v.ok && /silence-audit:\s*exento\s*—\s*\S/.test(previas)) continue;
    if (!v.ok) {
      fallas.push({ file, line: src.slice(0, m.index).split('\n').length, tool: m[2], motivo: v.motivo });
    }
  }
  return fallas;
}

/** Los .js del arnés que pueden lanzar un agente: el banco y los scripts sueltos. */
function fuentes() {
  const roots = [__dirname, path.join(__dirname, '..')]; // controls-bench/ y scripts/
  const out = [];
  for (const r of roots) {
    for (const f of fs.readdirSync(r)) {
      if (!f.endsWith('.js') || f === 'silence-audit.js') continue;
      const abs = path.join(r, f);
      if (fs.statSync(abs).isFile()) out.push([abs, path.relative(path.join(__dirname, '..', '..'), abs)]);
    }
  }
  return out;
}

function auditarTodo() {
  return fuentes().flatMap(([abs, rel]) => auditarFuente(fs.readFileSync(abs, 'utf8'), rel));
}

// ---------------------------------------------------------------- selftest
const CASOS = [
  { nombre: 'inline con el flag', rojo: false,
    src: `spawnP('codex', ['exec'], { cwd: f, env: Object.assign({}, process.env, { ${FLAG}: '1' }), timeout_s: 9 });` },
  { nombre: 'env por identificador que sí lo tiene', rojo: false,
    src: `const env = Object.assign({}, process.env, { ${FLAG}: '1' });\ndelete env.X;\nspawnSync('codex', ['exec'], { cwd: f, env });` },
  { nombre: 'EL BUG REAL: env: process.env pelado', rojo: true,
    src: `spawnP('codex', ['exec'], { cwd: fixture, env: process.env, timeout_s: 9 });` },
  { nombre: 'env por identificador SIN el flag', rojo: true,
    src: `const env = Object.assign({}, process.env);\nspawnSync('claude', ['-p'], { cwd: f, env });` },
  { nombre: 'llamada sin env — hereda todo', rojo: true,
    src: `spawnSync('codex', ['exec', PROMPT], { cwd: fixture, encoding: 'utf8' });` },
  { nombre: 'spawn de otra cosa: no es asunto de esta auditoría', rojo: false,
    src: `spawnSync('git', ['status'], { cwd: f, env: process.env });` },
  { nombre: 'escotilla declarada con motivo: pasa', rojo: false,
    src: `// silence-audit: exento — sesión interactiva del dev, los avisos son para él\nspawnSync('claude', ['-p'], { cwd: f, env: process.env });` },
  { nombre: 'helper que sí silencia: pasa', rojo: false,
    src: `function envDeCorrida(c) {\n  return Object.assign({}, process.env, { ${FLAG}: '1', X: c });\n}\nspawnP('codex', ['exec'], { cwd: f, env: envDeCorrida(corral), timeout_s: 9 });` },
  { nombre: 'helper que NO silencia: no vale', rojo: true,
    src: `function envDeCorrida(c) {\n  return Object.assign({}, process.env, { X: c });\n}\nspawnP('codex', ['exec'], { cwd: f, env: envDeCorrida(corral), timeout_s: 9 });` },
  { nombre: 'escotilla SIN motivo: no vale', rojo: true,
    src: `// silence-audit: exento\nspawnSync('claude', ['-p'], { cwd: f, env: process.env });` },
  // 🔴 La cabecera de tools-path.js cuenta el problema del PATH con la frase literal `spawnSync('claude', …)` y la
  // auditoría no debe denunciarla como "llamada sin env". El arreglo no puede ser "no menciones eso en los
  // comentarios": es la auditoría la que tiene que distinguir prosa de código.
  { nombre: 'un COMENTARIO de bloque que menciona la llamada no es un lanzamiento (caso real 2026-09-05)', rojo: false,
    src: `/**\n * el examen lanzaba por NOMBRE PELADO: \`spawnSync('claude', …)\` → ENOENT\n */\nconst x = 1;` },
  { nombre: 'un comentario de línea tampoco', rojo: false,
    src: `// antes: spawnSync('codex', ['exec'])\nconst x = 1;` },
  { nombre: 'un comentario al FINAL de una línea de código tampoco', rojo: false,
    src: `const r = spawnSync(ruta, ['--version']); // antes: spawnSync('claude', ['--version'])` },
  { nombre: 'pero el código debajo de un comentario SÍ se audita (el comentario no exime la línea siguiente)', rojo: true,
    src: `// lanza codex\nspawnSync('codex', ['exec'], { cwd: f });` },
];

if (process.argv.includes('--selftest')) {
  let malos = 0;
  for (const c of CASOS) {
    const f = auditarFuente(c.src, 'selftest.js');
    const detecto = f.length > 0;
    const ok = detecto === c.rojo;
    if (!ok) malos++;
    console.log(`${ok ? '✅' : '❌'} ${c.nombre}${ok ? '' : ` — esperaba ${c.rojo ? 'ROJO' : 'verde'}, dio ${detecto ? 'ROJO' : 'verde'}`}`);
  }
  console.log(malos ? `\n❌ selftest: ${malos}/${CASOS.length} mal` : `\n✅ selftest: ${CASOS.length}/${CASOS.length}`);
  process.exit(malos ? 1 : 0);
}

const fallas = auditarTodo();
if (!fallas.length) {
  console.log('✅ silence-audit: todo lanzamiento de agente del arnés lo silencia (banco + scripts sueltos)');
  process.exit(0);
}
console.error('🔴 silence-audit: el arnés le grita sus alarmas de arranque al agente que lanza\n');
for (const f of fallas) console.error(`   ${f.file}:${f.line} → ${f.tool}: ${f.motivo}`);
console.error(`\n   Arreglo: env: Object.assign({}, process.env, { ${FLAG}: '1' })`);
console.error('   Por qué importa: los hooks de arranque le inyectan al agente "controls-bench EN ROJO —');
console.error('   Correr: node .../runner.js", el agente lo corre, y el caso muere por permisos o por tiempo.');
process.exit(1);
