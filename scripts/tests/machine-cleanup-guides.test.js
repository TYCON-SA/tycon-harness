'use strict';
/**
 * machine-cleanup-guides.test.js — los textos que le muestran al agente cómo abrir un pedido dicen las tres banderas
 * (@story-8.164).
 *
 * Una rama que no se borra al entrar queda viva para siempre y las ramas remotas ya entradas a main se acumulan. En Azure DevOps el pedido dice si borra la rama con `--delete-source-branch`; en GitHub lo hace una opción del
 * repo que prende una persona. Si el comando que el agente copia no trae la bandera, el freno lo para recién cuando ya
 * lo armó.
 *
 *   T2 · 8.164-GuiasMuestranLasTres: los tres textos del freno de pedidos que muestran `--auto-complete true --squash
 *        false` (el aviso del borrador, la forma de publicar un borrador y el comando de ejemplo) llevan
 *        `--delete-source-branch` al lado; el paso de cierre lo lleva en `true`. El paso de merge, sólo si escribe el
 *        comando.
 *   T3 · 8.164-GuiaGitHub_TareaHumana: la guía de commits trae la tarea humana de GitHub con su ruta.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const FRENO = path.join(RAIZ, 'scripts', 'hooks', 'pr-auto-complete-guard.js');
const CIERRE = path.join(RAIZ, 'skills', 'tycon-pipeline', 'steps', 'close-work-item.md');
const MERGE = path.join(RAIZ, 'skills', 'tycon-merge-to-main', 'steps', 'step-09b-create-change-request.md');
const GUIA = path.join(RAIZ, 'guides', 'git-commit-conventions.md');

// stable-data: only reads guide text; it never creates commits.
const PAR = '--auto-complete true --squash false';

/** Los renglones que muestran el par, y si cada uno trae la tercera bandera. */
function renglonesConElPar(texto) {
  return texto.split('\n').filter((l) => l.includes(PAR))
    .map((l) => ({ renglon: l.trim(), conBandera: /--delete-source-branch\b/.test(l), enTrue: /--delete-source-branch true\b/.test(l) }));
}

test('T2 8.164-GuiasMuestranLasTres @story-8.164 @ac-2', () => {
  const freno = renglonesConElPar(fs.readFileSync(FRENO, 'utf8'));
  // Los tres textos del mensaje (el aviso del borrador, la publicación de un borrador y el ejemplo). Los comentarios de
  // la cabecera no son texto que el agente vea: se cuentan sólo los renglones que no empiezan con `*` ni `//`.
  const mensajes = freno.filter((r) => !/^(\*|\/\/)/.test(r.renglon));
  assert.ok(mensajes.length >= 3, `el freno muestra el par en ${mensajes.length} texto(s); se esperaban los tres`);
  for (const r of mensajes) assert.ok(r.conBandera, `el freno muestra el par sin --delete-source-branch: ${r.renglon}`);

  const cierre = renglonesConElPar(fs.readFileSync(CIERRE, 'utf8'));
  assert.ok(cierre.length >= 1, 'el paso de cierre ya no nombra el par: no puedo mirar si trae la tercera bandera');
  for (const r of cierre) assert.ok(r.enTrue, `el paso de cierre nombra el par sin --delete-source-branch true: ${r.renglon}`);

  // El paso de merge abre el pedido con `platform.js change-request open`, que ya manda la bandera. Si algún día
  // escribe el comando de az, lo escribe con ella.
  const merge = fs.readFileSync(MERGE, 'utf8');
  for (const l of merge.split('\n').filter((x) => /az repos pr (create|update)/.test(x) && x.includes('--auto-complete'))) {
    assert.match(l, /--delete-source-branch\b/, `el paso de merge escribe el comando sin la tercera bandera: ${l.trim()}`);
  }
});

test('T3 8.164-GuiaGitHub_TareaHumana @story-8.164 @ac-3', () => {
  const guia = fs.readFileSync(GUIA, 'utf8');
  assert.match(guia, /Automatically delete head branches/, 'la guía de commits no nombra la opción de GitHub');
  assert.match(guia, /Settings\s*→\s*General\s*→\s*Pull Requests/, 'la guía no dice dónde está la opción en el repo');
});
