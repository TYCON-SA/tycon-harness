'use strict';
// platform-texts.test.js — los textos del núcleo hablan de la plataforma del equipo, no de Azure DevOps, y la guía de
// conectores dice todo lo que un conector nuevo tiene que cumplir.
//
// Lo que no se puede perder:
//   · los textos de la lista (la lista cerrada de la medición: guías, pasos, skills y comandos que traían comandos o
//     direcciones de Azure DevOps) no traen ninguna señal dura de Azure DevOps; el caso de cada plataforma vive en su
//     guía de integración;
//   · mudar esos renglones no pierde ningún comando: la foto de comandos az sigue igual (los mudados a
//     guides/integrations/ siguen contados);
//   · la guía de conectores nombra cada operación y cada motivo del contrato, leídos del contrato, sin número fijo.
//
// stable-data: sólo lee textos del árbol (la lista nombra la guía de commits, no crea ninguno) y no lee el reloj.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const G = require(path.join(ROOT, 'scripts', 'tests', 'lib', 'record-platform-golden.js'));
const { OPERATIONS, REASONS } = require(path.join(ROOT, 'scripts', 'lib', 'platform', 'contract.js'));

// La lista cerrada: la medición de la señal dura en los textos del núcleo, sin el bloque que se retiró y sin el README
// de las definiciones de Azure Pipelines (se muda con lo sólo de Azure DevOps).
const TEXTOS = [
  'README.md', 'README.es.md', 'INDEX.md', 'story-format.md', 'getting-started/reference.md', 'getting-started/reference.es.md',
  'agents/tycon-retrospective-capturer.md', 'commands/tycon-dashboard.md', 'commands/tycon-vigilante.md',
  'skills/tycon-story-work-item/SKILL.md', 'skills/tycon-pipeline/steps/step-01-start.md', 'skills/tycon-pipeline/steps/close-work-item.md',
  'skills/tycon-merge-to-main/steps/step-09b-create-change-request.md', 'guides/ci-gate.md', 'guides/git-commit-conventions.md',
  'guides/advisor-rules-catalog.md', 'guides/workflow-orchestration.md', 'guides/safety-guard.md', 'guides/produccion-con-permiso.md',
  'guides/piezas-del-arnes.md', 'guides/organization-site.md', 'guides/organization-site.en.md',
  'guides/maintaining/mecanismo-de-instalacion.md', 'guides/maintaining/piezas-en-detalle.md', 'guides/maintaining/publicacion-espejo.md',
];
// Los renglones que se quedan, cada uno con su motivo: no son la plataforma del equipo (Azure en la nube), son lo que un
// freno o el detector de publicación reconocen para frenar, o describen una pieza sólo de Azure DevOps que la mudanza
// de lo sólo-ADO lleva a su conector, con su texto. Cada uno se reconoce por un pedazo del renglón y un archivo.
const SE_QUEDAN = [
  { file: 'guides/produccion-con-permiso.md', has: '`az rest` con el método delete', why: 'Azure en la nube (el freno de producción), no la plataforma del equipo' },
  { file: 'guides/maintaining/piezas-en-detalle.md', has: '**Producción con permiso**', why: 'Azure en la nube (el freno de producción), no la plataforma del equipo' },
  { file: 'guides/safety-guard.md', has: '| **GIT-C5** |', why: 'el freno reconoce las formas de cada plataforma: es lo que frena' },
  { file: 'guides/maintaining/publicacion-espejo.md', has: '| La organización de Azure DevOps |', why: 'el detector de publicación reconoce las direcciones de Azure DevOps: es lo que frena' },
  { file: 'guides/maintaining/publicacion-espejo.md', has: '`azure-pipelines@dev.azure.com`', why: 'el detector de publicación reconoce esa identidad: es lo que frena' },
  { file: 'guides/maintaining/publicacion-espejo.md', has: 'az pipelines run --id <id> --branch main', why: 'el proceso del espejo corre en Azure Pipelines: se muda con lo sólo de Azure DevOps' },
  { file: 'guides/maintaining/piezas-en-detalle.md', has: '**El pedido de trabajo del líder**', why: 'describe work-items.js, sólo de Azure DevOps: se muda con su pieza' },
  { file: 'guides/maintaining/piezas-en-detalle.md', has: '**El cruce «pedido cerrado, vulnerabilidad viva»**', why: 'describe work-items.js, sólo de Azure DevOps: se muda con su pieza' },
  { file: 'guides/maintaining/piezas-en-detalle.md', has: '«No lo veo» no es «no hay»', why: 'el aviso de consultas fallidas reconoce los comandos de Azure DevOps: es lo que avisa' },
  { file: 'guides/maintaining/piezas-en-detalle.md', has: 'armado sobre el lector de `az-pr.js`', why: 'describe az-pr.js, sólo de Azure DevOps: se muda con su pieza' },
];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Texts_NeutralInCore @story-8.85 @ac-22', () => {
  assert.strictEqual(TEXTOS.length, 25, 'la lista cerrada tiene 25 textos');
  const sucios = [];
  const usadas = new Set();
  for (const rel of TEXTOS) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} sigue en el árbol`);
    read(rel).split('\n').forEach((l, i) => {
      if (!G.DURA.test(l)) return;
      const se = SE_QUEDAN.find((e) => e.file === rel && l.includes(e.has));
      if (se) usadas.add(se); else sucios.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
  }
  assert.deepStrictEqual(sucios, [], `señales duras de Azure DevOps en el núcleo:\n${sucios.join('\n')}`);
  // cada excepción tiene su motivo y todavía hace falta (una que no se usa es una puerta abierta)
  for (const e of SE_QUEDAN) {
    assert.ok(e.why && e.why.length > 20, `${e.file}: la excepción lleva su motivo`);
    assert.ok(usadas.has(e), `${e.file} («${e.has}»): la excepción ya no hace falta, sacala`);
  }
  // el caso de cada plataforma existe donde se dijo
  const ado = fs.readdirSync(path.join(ROOT, 'guides', 'integrations')).filter((f) => /^ado-.*\.md$/.test(f));
  assert.ok(ado.length > 0, 'guides/integrations/ado-*');
  assert.ok(fs.existsSync(path.join(ROOT, 'guides', 'integrations', 'github-platform.md')), 'guides/integrations/github-platform.md');
  // mudar no perdió ni inventó comandos: la foto de comandos sigue igual
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tests', 'lib', 'record-platform-golden.js'), 'compare', '--without-suites'], { encoding: 'utf8', cwd: ROOT });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('Guide_ListsEveryOperation @story-8.85 @ac-23', () => {
  const guia = read('guides/integrations/platform-connectors.md');
  const faltan = [...OPERATIONS.filter((op) => !guia.includes(`\`${op}\``)), ...REASONS.filter((m) => !guia.includes(`\`${m}\``))];
  assert.deepStrictEqual(faltan, [], 'cada operación y cada motivo del contrato, en la guía');
  // y cómo pasar la prueba de conformidad con el conector de mentira como ejemplo
  assert.match(guia, /conformance/);
  assert.match(guia, /fake-platform/);
  assert.match(guia, /integration\.json/);
  assert.match(guia, /capabilities/);
  assert.match(guia, /rawCommands/);
});
