#!/usr/bin/env node
/**
 * Guard contra la omisión silenciosa de un revisor: si pipeline.js suelta tycon-e2e-realness-checker
 * del selector sin avisar, nada más lo nota. Este test falla si:
 *   (a) un advisor pipeline-selectable del NÚCLEO no aparece en pipeline.js (omisión silenciosa), o
 *   (b) pipeline.js emite un nombre que NO corresponde a un agent .md real (typo), o
 *   (c) un revisor de un PAQUETE (packs/<nombre>/pack.json) no resuelve a un agent .md
 *       real, o pipeline.js lo nombra escrito en el código (tiene que venir del manifiesto).
 *
 * Los revisores de Bizuit y de clientes NO se esperan en pipeline.js: se esperan
 * en los manifiestos de packs/, que esta prueba instala (lee) explícitamente.
 *
 * Correr: node test-pipeline-coverage.js   (exit 0 OK, exit 1 fail).
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pipeline.js'), 'utf8');
// Los agentes de este mismo checkout, como los paquetes: con los del arnés instalado, la prueba mediría otra versión y
// fallaría en una máquina sin arnés.
const AGENTS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'agents');
const PACKS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'packs');

// Advisors del NÚCLEO que el pipeline DEBE poder seleccionar en Step 5 (base + completitud + condicionales).
// Excluidos a propósito: retrospective-capturer (post-merge), signed-scope-audit (on-demand),
// dod-runtime-checker (Step 7c, no Step 5). Los de paquetes se leen de packs/ abajo.
const EXPECTED_SELECTABLE = [
  // base (tests + security; las convenciones por stack vienen del paquete bizuit)
  'tycon-plugin-tests-coverage', 'tycon-plugin-security-basics',
  // completitud
  'tycon-story-validator', 'tycon-spec-first-checker', 'tycon-ac-coverage-checker', 'tycon-deferral-tracker',
  // condicional LLM (los de un stack —.NET, Next.js + Postgres— vienen de su paquete)
  'llm-cost-reviewer',
  // stack-agnostic
  'tycon-e2e-realness-checker', 'tycon-silent-failure-hunter',
];

// Strings tipo nombre-de-advisor que NO son advisors (paths/identificadores del
// propio harness que matchean el patrón). Mantener corta y explícita.
const NOT_ADVISORS = new Set(['tycon-pipeline', 'tycon-claude-guides']);

// Nombres de advisor que pipeline.js emite (string literals tipo nombre-de-advisor).
const emitted = new Set();
for (const m of SRC.matchAll(/'([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g)) {
  const n = m[1];
  if (NOT_ADVISORS.has(n)) continue;
  if (/-(reviewer|conventions|checker|coverage|basics|validator|tracker|analyzer|security)$/.test(n) || n.startsWith('tycon-')) {
    emitted.add(n);
  }
}

let failed = false;

// (a) cada esperado del núcleo debe estar emitido por pipeline.js
const missing = EXPECTED_SELECTABLE.filter((a) => !emitted.has(a));
if (missing.length) {
  failed = true;
  console.error(`✗ FALTAN en pipeline.js (regresión tipo CF-1): ${missing.join(', ')}`);
}

// (b) cada nombre emitido debe ser un agent .md real
const notReal = [...emitted].filter((a) => !fs.existsSync(path.join(AGENTS_DIR, `${a}.md`)));
if (notReal.length) {
  failed = true;
  console.error(`✗ pipeline.js emite nombres sin agent .md (typo?): ${notReal.join(', ')}`);
}

// (c) los paquetes: cada revisor declarado resuelve a un agent real, y NO está escrito en pipeline.js
let dePaquetes = 0;
let paquetes = [];
try {
  paquetes = fs.readdirSync(PACKS_DIR).filter((p) => fs.existsSync(path.join(PACKS_DIR, p, 'pack.json')));
} catch (e) {
  failed = true;
  console.error(`✗ no se pudo leer packs/ (${e.message}) — los paquetes del equipo tienen que estar en ${PACKS_DIR}`);
}
// El núcleo público no trae paquetes (llegan con el perfil de cada equipo). Con el repo del equipo encima
// (la señal: el paquete de clientes) el paquete bizuit tiene que estar: una carpeta vacía ahí no es verde, es «el equipo
// perdió sus revisores sin enterarse», lo que los manifiestos de packs/ existen para impedir.
const DEL_EQUIPO = fs.existsSync(path.join(PACKS_DIR, 'clients', 'pack.json'));
if (DEL_EQUIPO && !paquetes.includes('bizuit')) {
  failed = true;
  console.error(`✗ falta el paquete bizuit en ${PACKS_DIR} (instalados: ${paquetes.join(', ') || 'ninguno'})`);
}
if (!DEL_EQUIPO) console.log(`ℹ NO MEDIDO: los paquetes del equipo (copia pública: llegan con su perfil)`);
for (const p of paquetes) {
  const archivo = path.join(PACKS_DIR, p, 'pack.json');
  let json;
  try { json = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) {
    failed = true;
    console.error(`✗ ${archivo}: JSON inválido (${e.message})`);
    continue;
  }
  for (const r of json.reviewers || []) {
    dePaquetes++;
    // el agente, en la carpeta de su paquete (clave `agents`) o en la de la raíz
    const enPaquete = typeof json.agents === 'string' && fs.existsSync(path.join(PACKS_DIR, p, json.agents, `${r.agent}.md`));
    if (!enPaquete && !fs.existsSync(path.join(AGENTS_DIR, `${r.agent}.md`))) {
      failed = true;
      console.error(`✗ ${archivo} declara "${r.agent}" y no hay agent .md`);
    }
    if (emitted.has(r.agent)) {
      failed = true;
      console.error(`✗ pipeline.js nombra a "${r.agent}" escrito en el código: tiene que venir sólo del manifiesto ${archivo}`);
    }
  }
}

if (failed) process.exit(1);
console.log(`✓ cobertura OK — los ${EXPECTED_SELECTABLE.length} advisors del núcleo están en pipeline.js, ` +
            `los ${dePaquetes} de ${paquetes.length} paquete(s) resuelven a un agent real y ninguno está escrito en el código`);
