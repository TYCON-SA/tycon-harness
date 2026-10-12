'use strict';

/**
 * config-lint-real-configs.test.js — las configuraciones REALES de los proyectos de esta máquina no disparan nada.
 *
 * Vivía en `config-lint.test.js`. La primera versión del catálogo se escribió de memoria y 8 de los 10 hallazgos de
 * su primera corrida eran falsos positivos (el bloque `i18n:` entero y `visual_plan`, que sí los lee el arnés): un
 * lint que pone en rojo config legítima se apaga en una semana. Este caso mide el catálogo contra lo que los repos
 * declaran de verdad.
 *
 * 🔴 NO va en la suite rápida del arranque (2026-10-05, story 8.18). Depende del disco del dev, no del arnés: en una
 * notebook con un proyecto viejo (una llave `advisors:` en la raíz) fallaba siempre, y la actualización automática
 * —que rechaza toda versión cuya suite rápida diga «FALLÓ»— dejó esa máquina tres versiones atrás sin que el arnés
 * tuviera nada roto. Acá sigue corriendo con las suites diarias y a mano; su rojo nombra el proyecto, y el arreglo va
 * en ese proyecto (o en el catálogo, si la llave sí la lee el arnés). Red: scripts/tests/quick-suite-machine-independent.test.js.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/config-lint-real-configs.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cl = require('../lib/config-lint.js');

test('los 13 configs reales del equipo no disparan NADA', () => {
  const raiz = path.join(os.homedir(), 'SourceCode');
  if (!fs.existsSync(raiz)) return;   // otra máquina del equipo
  const encontrados = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of es) {
      if (!e.isDirectory() || e.name === 'node_modules') continue;
      if (e.name === '.tycon') {
        for (const n of ['advisors.yaml', 'advisors.yml']) {
          const f = path.join(dir, '.tycon', n);
          if (fs.existsSync(f)) encontrados.push(f);
        }
        continue;
      }
      if (e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(raiz, 0);
  if (!encontrados.length) return;
  for (const f of encontrados) {
    const h = cl.lintEsquema(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(h.map((x) => x.llave), [],
      `${f} dispara falsos positivos: el catálogo de ESQUEMA está incompleto`);
  }
});
