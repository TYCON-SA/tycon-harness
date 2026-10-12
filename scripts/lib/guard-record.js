#!/usr/bin/env node
'use strict';
/*
 * guard-record.js — LA CONSTANCIA DE LOS FRENOS PREVIOS A LA HERRAMIENTA (story 2.6, 2026-09-16)
 *
 * Los frenos que corren ANTES de cada comando no dejaban rastro utilizable: dos anotaban sólo el
 * escape, `safety-guard` sólo los bloqueos —y con el comando EN CLARO, por eso la prueba de fuga le
 * prohíbe al reductor abrir ese archivo—, y tres no anotaban nada. Un freno que funcionó todo el mes
 * se veía igual que uno que nunca se disparó: ausente. Y ése es el número que decide si un freno se
 * queda o se saca por molesto.
 *
 * Acá se anota UNA línea por decisión, en `~/.claude/.tycon-pipeline/frenos.jsonl`:
 *
 *   {"ts":"…","freno":"test-scope-guard","regla":"suite-completa","veredicto":"bloqueo","sha256":"…"}
 *
 * 🔴 LA LÍNEA NO LLEVA EL CONTENIDO. El registro sube al buzón y lo que el reductor publica lo ve
 *    todo el equipo. Del comando va su HUELLA, nunca su texto — el patrón es el de `registrar()` del
 *    freno de producción (story 6.1), que guarda el sha256 de la sentencia y no la sentencia. No van:
 *    `cmd`, `cwd`, `command`, `repoPath`, `story`, ni motivo en prosa. El motivo es un CÓDIGO de una
 *    lista cerrada por freno; uno libre sale `otra` y la línea se escribe igual (perder la decisión
 *    es peor que perder su etiqueta, y así el denominador no miente).
 *
 * 🔴 ES AYUDA, NO EVIDENCIA. Nada de acá puede cambiar lo que un freno decide ni con qué código sale.
 *    Todo va envuelto: si no se puede escribir, el fallo va a `hook-errors.log` y el freno sigue su
 *    camino. Un freno que se rompe por no poder anotar es peor que un freno sin constancia.
 *
 * 🔴 EL COMANDO ENTRA POR STDIN, NUNCA POR ARGV: un comando como argumento lo ve cualquier usuario de
 *    la máquina con un `ps`.
 *
 * QUÉ CUENTA COMO «TUVO ALGO QUE DECIDIR» (el denominador — decisión D1 del plan): cada freno anota
 * sólo cuando el comando le compete. `safety-guard` NO anota los `paso`: corre en CADA comando de
 * bash, así que su denominador es «veces que una regla peligrosa matcheó», no «comandos que
 * corrieron» — anotarlo todo sería medio disco de no-eventos y ~50 ms por comando, y el número
 * («frenó 12 de 40.000») no contestaría si el freno sirve. La ficha del tablero lo dice.
 *
 * Uso desde un hook en node:
 *   require('.../guard-record.js').anotar({ freno, regla, veredicto, cmd });
 * Uso desde un hook en bash (el comando por stdin):
 *   printf '%s' "$CMD" | node .../guard-record.js --guard safety-guard --rule GIT-C1 \
 *                                                 --verdict bloqueo --cmd-stdin
 *
 * Contrato de salida del CLI: SIEMPRE 0. Nunca puede tumbar al freno que lo llama.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Los seis frenos previos a la herramienta (2.6), los tres del cierre (7.2) y el de nombres nuevos (8.10), con su vocabulario cerrado. Agregar uno es una entrada
// acá + su lista de valores en `scripts/nightly/dashboard/sources.json` (si no, el reductor lo publica como `otro`).
const FRENOS = {
  // Sus reglas YA tienen id estable del catálogo de reglas (FS-C1, GIT-C4, SQL-C1, HARNESS-C1…),
  // así que la lista es la FORMA del id: enumerarlas obligaría a tocar este archivo cada vez que
  // alguien agrega una regla al freno, y una lista que se desactualiza sola publica todo como `otra`.
  'safety-guard': { forma: /^[A-Z]{2,8}-[CW][0-9]{1,2}$/, veredictos: ['bloqueo', 'escape'] },
  'test-scope-guard': { reglas: ['suite-completa'], veredictos: ['bloqueo', 'paso', 'escape'] },
  'pr-uno-por-repo': { reglas: ['pr-duplicado'], veredictos: ['bloqueo', 'paso', 'escape'] },
  'pr-sin-auto-complete': { reglas: ['sin-auto-complete'], veredictos: ['bloqueo', 'paso', 'escape'] },
  // Nunca bloquea: todas sus salidas son 0. Que la ficha lo diga es parte de la medición — «avisó N
  // veces y nadie hizo nada» es lo que decide si algún día tiene que pasar a frenar.
  'push-referencia-fantasma': { reglas: ['referencia-fantasma'], veredictos: ['aviso', 'paso'] },
  // `nombre-indecidible` (story 8.14, AC 14): una escritura en alcance protegido con un nombre que el freno no sabe leer
  // como el shell. No es una falla del freno —ésa es `no-pude-mirar`— y por eso tiene su propia regla.
  'prod-access-guard': {
    reglas: ['host-no-declarado', 'produccion', 'no-pude-mirar', 'puerta-no-canonica', 'nombre-indecidible'],
    veredictos: ['bloqueo', 'paso'],
  },
  // Story 7.2 — los tres hooks del CIERRE (viven en agent-skills y llaman acá vía
  // `lib/constancia-cierre.js`). Anotan sólo cuando tuvieron algo que decidir: una transición de una
  // story a `review`/`done` (una línea por story) o una escritura a `.advisors/dod-runtime/*.md`.
  // Su número —cuántas evidencias rechazaron— es el que dice si el cierre recortado alcanza.
  'on-frontmatter-write': {
    reglas: ['evidencia-ausente', 'evidencia-vieja', 'e2e-gate-rojo', 'evidencia-ok', 'sin-superficie-runtime', 'exenta'],
    veredictos: ['bloqueo', 'paso'],
  },
  // `aviso` es la transición interna `review → done`: hoy avisa en vez de frenar (TYCON_REVIEW_A_DONE).
  'on-pre-commit': {
    reglas: [
      'advisors-gate', 'roster', 'evidencia-ausente', 'evidencia-fallida', 'evidencia-incompleta',
      'sin-playwright', 'matriz-roja', 'matriz-estructural', 'self-audit', 'convergencia',
      'evidencia-ok', 'sin-superficie-runtime', 'exenta',
    ],
    veredictos: ['bloqueo', 'paso', 'aviso'],
  },
  // Story 1.6 — el cruce del índice de memoria contra sus archivos, en el commit. Anota `paso` en
  // CADA commit de un repo con memoria (a diferencia de `safety-guard`): el denominador es «commits
  // en repos con engram», que es exactamente la pregunta que decide si este freno vale la pena.
  // `aviso` = deriva heredada o no se pudo medir; `escape` = el interruptor o el prefijo del comando.
  'engram-manifest': {
    reglas: ['entradas-perdidas', 'chunk-sin-entrada', 'deriva-heredada', 'no-pude-medir', 'sano'],
    veredictos: ['bloqueo', 'aviso', 'paso', 'escape'],
  },
  // `aviso` = el flag de un solo uso dejó pasar una escritura manual (queda también en bypass.log).
  'on-dod-evidence-guard': {
    reglas: ['escritura-manual', 'archivo-exento'],
    veredictos: ['bloqueo', 'paso', 'aviso'],
  },
  // Story 8.10 — el freno de nombres reales nuevos en lo que se publica (scripts/publishing/new-names.js). Anota en
  // cada commit que tuvo algo que mirar (un archivo que sale o un disparador), también los `paso`: el denominador es
  // «commits que tocaron lo que se publica», y es el número que dice, dos semanas después, cuánto frena de verdad.
  // `escape` = apagado con TYCON_NEW_NAMES=0. La huella es de las rutas y las líneas, nunca del texto encontrado.
  // En un clon de la forma publicada (story 8.26, tanda H1c) mira con la lista de la máquina: `no-list` = pasó sin
  // mirar, en una máquina del equipo que no declara la lista (lo dijo); `list-from-env` = pasó mirando con la lista
  // que nombra TYCON_PUBLISH_DENYLIST, que también va como `escape` (alguien eligió con qué lista se miró).
  'new-names': {
    reglas: [
      'new-name', 'unclassified-entry', 'ceiling-raised', 'product-without-term', 'term-without-pair',
      'exception-same-commit', 'could-not-look', 'other-repo-missing', 'disabled', 'clean', 'no-list', 'list-from-env',
    ],
    veredictos: ['bloqueo', 'paso', 'escape'],
  },
  // Story 8.9 — el freno de nombres nuevos en castellano en lo que ejecuta la máquina (scripts/publishing/spanish-names.js).
  // Mismo denominador que el de la 8.10: cada commit que tocó un ejecutable, configuración o prueba que sale. `escape` =
  // apagado con TYCON_SPANISH_NAMES=0. La huella es de las rutas, las categorías y las líneas, nunca del nombre encontrado.
  'spanish-names': {
    reglas: ['new-spanish-name', 'ceiling-raised', 'could-not-look', 'other-repo-missing', 'disabled', 'clean'],
    veredictos: ['bloqueo', 'paso', 'escape'],
  },
  // Story 8.26, tanda F1 — el freno antes de publicar (scripts/hooks/public-push-guard.js). Anota cada empuje a un remoto
  // público desde un árbol del arnés y cada `gh` que publica ahí, también los `paso`: el denominador es «veces que algo
  // iba a salir al público». No tiene `escape`: ninguna variable lo apaga. `generic-only` = pasó sin lista (una máquina
  // que no es del equipo). Sin huella del comando: el cuerpo de un pedido viaja en él.
  'public-push-guard': {
    reglas: ['finding', 'could-not-look', 'unreadable-text', 'clean', 'generic-only'],
    veredictos: ['bloqueo', 'paso'],
  },
  // El control de historia interna en la prosa que se publica (scripts/publishing/internal-history.js), desde que frena.
  // Anota cada commit que tocó prosa que sale, también los `paso`: el denominador es «commits que tocaron una guía, una
  // skill, un revisor o un bloque». `aviso` = una forma que sólo avisa, o el control escrito en aviso; `escape` = apagado
  // o bajado a aviso con TYCON_INTERNAL_HISTORY cuando había algo que frenar (bajarlo no «escapa» de una forma que sólo
  // avisa). Apagado anota un `escape` en CADA commit, toque prosa o no: sin mirar
  // no se sabe, y un control apagado tiene que verse. `could-not-look` con `bloqueo` es también el rechazo del pre-commit
  // cuando falta el guion en un clon del equipo. La huella es de las rutas, las líneas y las formas, nunca del texto.
  'internal-history': {
    reglas: ['finding', 'could-not-look', 'disabled', 'clean'],
    veredictos: ['bloqueo', 'aviso', 'paso', 'escape'],
  },
};

const REGLA_DESCONOCIDA = 'otra';

function casaDelPipeline(home) {
  // la carpeta del estado la sabe scripts/setup/harness/tycon-home.js (story 8.23, tanda D): se carga si está al lado
  // (en el repo, y en /opt/tycon/setup/harness/ por el instalador del freno); si no, la de siempre
  try {
    const TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
    if (typeof TH.stateDir === 'function') return TH.stateDir(home || os.homedir());
  } catch (_) { /* la de siempre */ }
  return path.join(home || os.homedir(), '.claude', '.tycon-pipeline');
}

/** El motivo es un código de la lista del freno; cualquier otra cosa (prosa, ruta, vacío) → `otra`. */
function reglaNormalizada(freno, regla) {
  const def = FRENOS[freno];
  if (!def) return REGLA_DESCONOCIDA;
  if (typeof regla !== 'string' || !regla) return REGLA_DESCONOCIDA;
  if (def.forma) return def.forma.test(regla) ? regla : REGLA_DESCONOCIDA;
  return def.reglas.includes(regla) ? regla : REGLA_DESCONOCIDA;
}

function veredictoValido(freno, veredicto) {
  const def = FRENOS[freno];
  return !!def && typeof veredicto === 'string' && def.veredictos.includes(veredicto);
}

function anotarFallo(home, motivo) {
  try {
    const dir = casaDelPipeline(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'hook-errors.log'),
      `[${new Date().toISOString()}] constancia-freno NO PUDO ANOTAR: ${motivo}\n`,
      'utf8'
    );
  } catch (_) {
    /* si ni el registro de fallos se puede escribir, el freno sigue igual: es ayuda, no evidencia */
  }
}

/**
 * Anota una decisión. Devuelve `{ escrito, motivo? }` para los tests; NUNCA tira y nunca cambia el
 * comportamiento de quien la llama.
 */
function anotar({ freno, regla, veredicto, cmd, home } = {}) {
  try {
    if (!FRENOS[freno]) {
      anotarFallo(home, `freno desconocido: ${String(freno).slice(0, 40)}`);
      return { escrito: false, motivo: 'freno-desconocido' };
    }
    if (!veredictoValido(freno, veredicto)) {
      anotarFallo(home, `veredicto inválido para ${freno}: ${String(veredicto).slice(0, 40)}`);
      return { escrito: false, motivo: 'veredicto-invalido' };
    }
    const linea = {
      ts: new Date().toISOString(),
      freno,
      regla: reglaNormalizada(freno, regla),
      veredicto,
      // la huella permite correlacionar dos decisiones sobre el MISMO comando sin guardar el comando
      sha256: typeof cmd === 'string' && cmd ? crypto.createHash('sha256').update(cmd).digest('hex') : null,
    };
    const dir = casaDelPipeline(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'frenos.jsonl'), JSON.stringify(linea) + '\n', 'utf8');
    return { escrito: true };
  } catch (e) {
    anotarFallo(home, (e && e.code) || (e && e.message) || 'error desconocido');
    return { escrito: false, motivo: 'no-se-pudo-escribir' };
  }
}

function leerStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function main(argv) {
  const val = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const cmd = argv.includes('--cmd-stdin') ? leerStdin() : undefined;
  anotar({ freno: val('--guard'), regla: val('--rule'), veredicto: val('--verdict'), cmd });
  return 0; // SIEMPRE 0: el freno que nos llamó decide su propio código de salida
}

if (require.main === module) {
  // Los nombres viejos de las opciones siguen andando (story 8.9, tanda B3a). Ni un error de la biblioteca ni su falta
  // (una copia suelta de este archivo) cambian el contrato: la salida es SIEMPRE 0.
  try { require('./legacy-names.js').aliasArgv('scripts/lib/guard-record.js', { exitCode: 0 }); } catch (_) { /* paso directo */ }
  process.exit(main(process.argv.slice(2)));
}

module.exports = { anotar, reglaNormalizada, veredictoValido, FRENOS, REGLA_DESCONOCIDA };
