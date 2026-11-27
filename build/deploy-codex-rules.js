#!/usr/bin/env node
/**
 * build/deploy-codex-rules.js — las reglas que le prohíben a Codex borrar la raíz del disco o la carpeta personal entera.
 *
 * Claude Code las tiene en `permissions.deny` de settings.json (scripts/setup/harness/deny-permissions.js): frenan antes
 * de cualquier gancho, y ningún gancho las puede dejar pasar. Codex no lee esa lista; lee sus propias reglas en
 * `<CODEX_HOME>/rules/*.rules` (`prefix_rule(pattern=[…], decision="forbidden")`). Este guion escribe las mismas reglas,
 * desde la misma lista (`RULES` de deny-permissions.js), en un archivo propio: `rules/tycon-harness.rules`.
 *
 *   - Archivo propio, nunca `default.rules`: ése lo escribe Codex cuando la persona aprueba un comando.
 *   - El primer renglón dice que es del arnés. Un archivo con ese nombre que no lo dice es de la persona: no se pisa, y
 *     se avisa con un «⚠» (el despliegue de Codex sólo deja pasar las líneas accionables).
 *   - Igual no se reescribe. `TYCON_NO_DENY_RULES=1` no lo escribe y saca el del arnés (el mismo interruptor que las de
 *     Claude Code). Va en los dos perfiles de instalación, como todo el lado Codex (lo de una integración va en los dos:
 *     scripts/setup/install-effects.json).
 *   - Lo corre build/deploy-codex-all.js como un paso más; tools.js lo cuenta como pieza de Codex, y desinstalar lo saca.
 *
 * Cada regla compara palabra por palabra desde el principio del comando: la de «/» frena `rm -rf /` (y lo que siga) pero
 * no un borrado de /tmp/x, igual que la de Claude Code.
 *
 * Uso: node build/deploy-codex-rules.js · Sale 0 siempre que pudo decidir (un aviso no es una falla); 1 si no pudo escribir.
 * Casos: scripts/tests/codex-deny-rules.test.js.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DP = require(path.join(__dirname, '..', 'scripts', 'setup', 'harness', 'deny-permissions.js'));

const FILE = 'tycon-harness.rules';
const HEAD = '# tycon-harness: ';

/** Las reglas en palabras, en el orden de la lista: `[{ pattern: ['rm', '-rf', '/'], justification }]`. */
function patterns(j = DP.RULES) {
  const out = [];
  for (const r of DP.catalog(j)) {
    for (const deny of r.deny) {
      const pattern = deny.replace(/^Bash\(/, '').replace(/\)$/, '').split(' ');
      if (!out.some((p) => p.pattern.join(' ') === pattern.join(' '))) out.push({ pattern, justification: `${r.id}: ${r.que}` });
    }
  }
  return out;
}

/** El texto del archivo: el renglón que dice de quién es y una regla por forma. */
function rulesText(j = DP.RULES) {
  const lines = [
    `${HEAD}lo escribe el arnés desde scripts/setup/harness/deny-permissions.js; se reescribe solo y se saca al desinstalar.`,
    '# No lo edites: tus reglas van en otro archivo de esta carpeta (por ejemplo default.rules).',
    '',
  ];
  for (const p of patterns(j)) {
    lines.push(`prefix_rule(pattern = ${JSON.stringify(p.pattern).replace(/","/g, '", "')}, decision = "forbidden", justification = ${JSON.stringify(p.justification)})`);
  }
  return `${lines.join('\n')}\n`;
}

const isOurs = (text) => typeof text === 'string' && text.startsWith(HEAD);

/** El archivo de las reglas del arnés en esta carpeta de Codex. */
const rulesFile = (codexHome) => path.join(codexHome, 'rules', FILE);

function main(env = process.env) {
  // la misma carpeta que los otros desplegadores y que tools.js: con HOME distinto de la carpeta del usuario (Git Bash en
  // Windows) el archivo caería donde Codex no lo lee
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = rulesFile(codexHome);
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') { console.log(`⚠ tycon/codex: no pude leer ${file} (${e.code}): las reglas que prohíben borrar la raíz o la carpeta personal quedan como estén`); return 1; } }
  if (current !== null && !isOurs(current)) {
    console.log(`⚠ tycon/codex: ${file} existe y no es del arnés: no lo toco. Las reglas que prohíben borrar la raíz o la carpeta personal no se escribieron; renombrá ese archivo para que el arnés las ponga`);
    return 0;
  }
  if (env.TYCON_NO_DENY_RULES === '1') {
    if (current !== null) { fs.rmSync(file, { force: true }); console.log(`tycon/codex: TYCON_NO_DENY_RULES=1: saqué ${file}`); }
    return 0;
  }
  const text = rulesText();
  if (current === text) return 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    console.log(`⚠ tycon/codex: no pude escribir ${file} (${e.code || e.message}): Codex queda sin las reglas que prohíben borrar la raíz o la carpeta personal`);
    return 1;
  }
  console.log(`tycon/codex: escribí ${file} (${patterns().length} reglas que prohíben borrar la raíz o la carpeta personal entera)`);
  return 0;
}

/** ¿Esta máquina tiene que tener el archivo? Sí, salvo apagado con TYCON_NO_DENY_RULES=1. */
const wanted = (env = process.env) => env.TYCON_NO_DENY_RULES !== '1';

module.exports = { patterns, rulesText, isOurs, rulesFile, wanted, FILE, HEAD };
if (require.main === module) process.exit(main());
