'use strict';
/**
 * machine-cleanup-guides.test.js — los textos que le muestran al agente cómo abrir un pedido dicen las tres banderas
 * (@story-8.164).
 *
 * Una rama que no se borra al entrar queda viva para siempre y las ramas remotas ya entradas a main se acumulan. En Azure DevOps el pedido dice si borra la rama con `--delete-source-branch`; en GitHub lo hace una opción del
 * repo que prende una persona. Si el comando que el agente copia no trae la bandera, o la trae con el valor que el
 * freno frena, el agente choca con el freno recién cuando ya lo armó.
 *
 *   T2 · 8.164-GuiasMuestranLasTres: los tres textos del freno de pedidos que muestran `--auto-complete true --squash
 *        false` llevan `--delete-source-branch` con su valor: `true` en el comando de ejemplo, `false` en la forma de
 *        publicar un borrador (un `update` con `true` frena) y `<true|false>` en el aviso del borrador, que dice la
 *        regla. El paso de cierre lo lleva en `true`. El paso de merge, sólo si escribe el comando. Las dos
 *        descripciones del freno que ve el dev nombran la tercera bandera.
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
const GANCHOS = path.join(RAIZ, 'scripts', 'setup', 'hooks-list.json');
const EFECTOS = path.join(RAIZ, 'scripts', 'setup', 'install-effects.json');

// stable-data: only reads guide text; it never creates commits.
const PAR = '--auto-complete true --squash false';

/**
 * El texto como lo ve quien lo lee: las cadenas partidas en el código (`'…' +` y el salto) se unen, y los espacios y
 * saltos se achican a uno. Así un texto partido en dos renglones se sigue encontrando.
 */
function textoContinuo(fuente) {
  return fuente.replace(/(['"`])\s*\+\s*\r?\n\s*\1/g, '').replace(/\s+/g, ' ');
}

/** El valor que sigue a `--delete-source-branch` dentro del fragmento del par que empieza en `desde`, o null. */
function valorTrasElPar(texto, desde) {
  const i = texto.indexOf(PAR, desde);
  if (i === -1) return null;
  const m = texto.slice(i + PAR.length).match(/^\s+--delete-source-branch\s+([^\s`'".,)]+)/);
  return m ? m[1] : null;
}

/** Los tres textos del freno, cada uno por la frase que lo abre, con el valor de la tercera bandera en su fragmento. */
const TEXTOS_DEL_FRENO = [
  { nombre: 'el aviso del borrador', frase: 'Al publicarlo (--draft false) van a hacer falta', valor: '<true|false>' },
  { nombre: 'la forma de publicar un borrador', frase: 'publicalo con `--draft false', valor: 'false' },
  { nombre: 'el comando de ejemplo', frase: 'az repos pr create ... --source-branch <rama>', valor: 'true' },
];

function valoresDelFreno(fuente) {
  const texto = textoContinuo(fuente);
  return TEXTOS_DEL_FRENO.map((t) => {
    const donde = texto.indexOf(t.frase);
    return { ...t, encontrado: donde !== -1, leido: donde === -1 ? null : valorTrasElPar(texto, donde) };
  });
}

test('T2 8.164-GuiasMuestranLasTres @story-8.164 @ac-2', () => {
  for (const t of valoresDelFreno(fs.readFileSync(FRENO, 'utf8'))) {
    assert.ok(t.encontrado, `no encuentro ${t.nombre} en el freno («${t.frase}»)`);
    assert.strictEqual(t.leido, t.valor, `${t.nombre}: después del par va --delete-source-branch ${t.valor}, y dice ${t.leido}`);
  }

  const cierre = textoContinuo(fs.readFileSync(CIERRE, 'utf8'));
  assert.ok(cierre.includes(PAR), 'el paso de cierre ya no nombra el par: no puedo mirar si trae la tercera bandera');
  for (let i = cierre.indexOf(PAR); i !== -1; i = cierre.indexOf(PAR, i + 1)) {
    assert.strictEqual(valorTrasElPar(cierre, i), 'true', `el paso de cierre nombra el par sin --delete-source-branch true: ${cierre.slice(i, i + 90)}`);
  }

  // El paso de merge abre el pedido con `platform.js change-request open`, que ya manda la bandera. Si algún día
  // escribe el comando de az, lo escribe con ella.
  const merge = fs.readFileSync(MERGE, 'utf8');
  for (const l of merge.split('\n').filter((x) => /az repos pr (create|update)/.test(x) && x.includes('--auto-complete'))) {
    assert.match(l, /--delete-source-branch\b/, `el paso de merge escribe el comando sin la tercera bandera: ${l.trim()}`);
  }

  // Las descripciones del freno que ve el dev, en la lista de ganchos y en lo que la instalación dice que suma.
  const gancho = JSON.parse(fs.readFileSync(GANCHOS, 'utf8')).hooks.find((h) => /pr-auto-complete-guard\.js$/.test(h.spec));
  assert.ok(gancho, 'hooks-list.json no lista el freno de pedidos');
  assert.match(gancho.label, /--delete-source-branch/, 'la descripción del freno en hooks-list.json no nombra la tercera bandera');
  const efecto = JSON.parse(fs.readFileSync(EFECTOS, 'utf8')).effects.find((e) => /pr-auto-complete-guard\.js$/.test(e.id));
  assert.ok(efecto, 'install-effects.json no tiene el freno de pedidos');
  assert.match(efecto.does, /borrar la rama|--delete-source-branch/, 'el `does` del freno no nombra la tercera bandera');
  assert.match(efecto.en.does, /delete the source branch|--delete-source-branch/, 'el `does` en inglés no nombra la tercera bandera');
});

test('T2 8.164-GuiasMuestranLasTres: la búsqueda ve un valor cambiado y un texto partido @story-8.164 @ac-2', () => {
  const fuente = fs.readFileSync(FRENO, 'utf8');
  const ejemplo = TEXTOS_DEL_FRENO[2];
  // Con el ejemplo en `false`, la búsqueda lo lee: la prueba de arriba pasaría a rojo.
  const cambiada = fuente.replace(`${PAR} --delete-source-branch true\n`, `${PAR} --delete-source-branch false\n`);
  assert.notStrictEqual(cambiada, fuente, 'no encontré el comando de ejemplo para cambiarlo');
  assert.strictEqual(valoresDelFreno(cambiada).find((t) => t.nombre === ejemplo.nombre).leido, 'false');
  // Partido en dos cadenas y dos renglones, se sigue encontrando con su valor.
  const partida = fuente.replace(`publicalo con \`--draft false ${PAR}`, `publicalo con \`--draft false --auto-complete true ' +\n    '--squash false`);
  assert.notStrictEqual(partida, fuente, 'no encontré la forma de publicar para partirla');
  assert.strictEqual(valoresDelFreno(partida).find((t) => t.nombre === 'la forma de publicar un borrador').leido, 'false');
});

test('T3 8.164-GuiaGitHub_TareaHumana @story-8.164 @ac-3', () => {
  const guia = fs.readFileSync(GUIA, 'utf8');
  assert.match(guia, /Automatically delete head branches/, 'la guía de commits no nombra la opción de GitHub');
  assert.match(guia, /Settings\s*→\s*General\s*→\s*Pull Requests/, 'la guía no dice dónde está la opción en el repo');
});
