#!/usr/bin/env node
'use strict';
/**
 * ¿Los pipelines de los cinco productos hacen LO MISMO?
 *
 * 🔴 POR QUÉ EXISTE (2026-09-01).
 *
 * Ese día se dio FRESNO por alineado con URUTAU —comparando a mano— y faltaban ONCE cosas. Cuatro de
 * ellas estaban repartidas entre productos que YA se habían dado por cerrados: un backend sin
 * reintento cuando el host limita, dos productos sin el aviso de atraso, y —la peor— un pipeline
 * que NO se disparaba cuando el cambio tocaba sólo las pruebas, o sea que la prueba nueva no
 * corría hasta que alguien tocara código.
 *
 * Ninguna la encontró una revisión: las encontró el dev preguntando "¿me lo podés asegurar con
 * evidencia?". Este control existe para que esa pregunta tenga respuesta sin que nadie la haga.
 *
 * 🔴 NO JUZGA CUÁL ES EL COMPORTAMIENTO CORRECTO. Juzga que los cinco hagan lo mismo. Si divergen,
 * decide una persona — y si la diferencia es legítima, se DECLARA en `product-parity.json` con
 * motivo y fecha de revisión. Una diferencia sin motivo no es una decisión: es un descuido.
 *
 * 🔴 Un repo que no está en esta máquina NO se lee como "todo bien": se cuenta aparte y se dice.
 * "No medido" y "medido y coincide" son cosas distintas, y confundirlas es el modo de falla que
 * el arnés persigue en todas sus piezas.
 *
 * 🔴 UN RASGO PUEDE ACOTARSE A UN BLOQUE DEL YAML (`bloque: "trigger"`), 2026-09-02. El primer
 * falso negativo real de este control: `dispara-tests` buscaba `- tests/**` en el archivo ENTERO
 * y lo encontró en FRESNO… dentro del bloque `pr:`, que para Azure Repos es inerte. El `trigger:` de
 * FRESNO no lo tenía, así que un merge sólo de pruebas NO construía en main — y el control decía
 * "los cinco coinciden". Lo mismo con `dispara-pipeline` (`azure-pipelines.yml` estaba en `pr:`).
 * Un rasgo con `bloque` se evalúa SÓLO sobre ese bloque de nivel raíz; si el bloque no existe, el
 * rasgo cuenta como ausente.
 *
 * 🔴 UN GRUPO PUEDE MIRAR OTRO ARCHIVO (`archivo:`), 2026-09-02. Los 4 pipelines de producción
 * viven en `azure-pipelines-prod.yml`; hasta hoy el control sólo leía `azure-pipelines.yml`, así
 * que ningún rasgo de producción podía ponerse rojo. Un grupo declarado como objeto puede decir
 * qué archivo lee y si sólo le aplican los rasgos que lo nombran (`solo_rasgos_que_lo_nombren`):
 * a producción no se le pide el portón ni las pruebas, que son de CI.
 *
 * Uso:  node check-product-parity.js [--root <dir>] [--config <archivo>]
 *       (--root se llamaba en castellano hasta la story 8.9, tanda B3a; el nombre viejo sigue andando hasta el retiro)
 * Sale 0 si todos coinciden (o la diferencia está declarada) · 1 si hay divergencia · 2 si no
 * pudo medir lo suficiente para opinar (o llegó una opción con su nombre viejo y el nuevo a la vez).
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
// El traductor de las opciones viejas vive al lado y viaja con este archivo en el artefacto arnes-ci (story 8.9).
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();

function args(argv) {
  const o = { raiz: null, config: path.join(__dirname, 'product-parity.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') o.raiz = argv[++i];
    else if (argv[i] === '--config') o.config = argv[++i];
  }
  return o;
}

function expandir(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Un grupo puede escribirse como lista de repos (forma original) o como objeto con opciones. */
function normalizarGrupo(g) {
  if (Array.isArray(g)) return { archivo: 'azure-pipelines.yml', soloExplicitos: false, repos: g };
  if (!g || typeof g !== 'object') return null;
  return {
    archivo: g.archivo || 'azure-pipelines.yml',
    soloExplicitos: g.solo_rasgos_que_lo_nombren === true,
    repos: Array.isArray(g.repos) ? g.repos : [],
  };
}

/**
 * El texto de un bloque de nivel raíz del YAML (`trigger:`, `pr:`, `resources:`…): desde su
 * línea hasta la próxima clave de nivel raíz. Sin parser de YAML a propósito: el formato de estos
 * archivos es regular y un parser haría "desaparecer" los comentarios, que a veces son lo que
 * un rasgo busca. Devuelve null si el bloque no existe.
 */
function bloqueRaiz(texto, clave) {
  const lineas = texto.split('\n');
  const rxInicio = new RegExp(`^${clave.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`);
  const ini = lineas.findIndex((l) => rxInicio.test(l));
  if (ini < 0) return null;
  let fin = lineas.length;
  for (let i = ini + 1; i < lineas.length; i++) {
    if (/^[A-Za-z_][A-Za-z0-9_.-]*:/.test(lineas[i])) { fin = i; break; }
  }
  return lineas.slice(ini, fin).join('\n');
}

// story 8.10.3 (AC 3): la copia pública trae un product-parity.json SIN productos, a propósito (los del equipo no viajan).
// Sólo una marca explícita —`sin_productos` con su motivo y sin grupos— da 0 diciendo que no se comparó nada; grupos vacíos
// sin la marca siguen siendo «no se midió nada» (2), y la marca con grupos es una contradicción (2).
function sinProductosAProposito(cfg) {
  if (!Object.prototype.hasOwnProperty.call(cfg || {}, 'sin_productos')) return null;
  const hayGrupos = cfg.grupos && typeof cfg.grupos === 'object' && Object.keys(cfg.grupos).length > 0;
  if (typeof cfg.sin_productos !== 'string' || !cfg.sin_productos.trim()) return { rc: 2, msg: '🔴 "sin_productos" tiene que decir por qué (texto) — no se midió nada' };
  if (hayGrupos) return { rc: 2, msg: '🔴 la configuración dice "sin_productos" y además declara grupos: es una contradicción — no se midió nada' };
  return { rc: 0, msg: `ℹ️ no hay productos declarados (${cfg.sin_productos.trim()}): no se comparó nada` };
}

function main(argv0) {
  let argv;
  try { argv = aliasLegacyOptions(argv0, 'raiz:root', 'scripts/ci/check-product-parity.js'); }
  catch (e) {
    if (!(e instanceof LegacyOptionsError)) throw e;
    console.log(`🔴 ${e.message} — no se midió nada`);
    return 2;
  }
  const o = args(argv);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(o.config, 'utf8')); }
  catch (e) { console.log(`🔴 no pude leer la configuración (${o.config}): ${e.message}`); return 2; }
  const sinProductos = sinProductosAProposito(cfg);
  if (sinProductos) { console.log(sinProductos.msg); return sinProductos.rc; }

  // Sin raíz declarada no se mide nada, y eso se dice (story 8.3): antes había la carpeta de UNA máquina
  // como último recurso, que en cualquier otra medía cero productos en silencio.
  const raizDeclarada = o.raiz || cfg.raiz_por_defecto;
  if (!raizDeclarada) { console.log('🔴 sin raíz de repos: pasá --root <carpeta> o declará raiz_por_defecto en la configuración — no se midió nada, y eso no es «todo bien»'); return 2; }
  const raiz = expandir(raizDeclarada);
  const declaradas = new Map();
  for (const d of cfg.diferencias_declaradas || []) {
    for (const campo of ['grupo', 'rasgo', 'motivo', 'fecha', 'revision']) {
      if (!d[campo]) { console.log(`🔴 una diferencia declarada no dice "${campo}" — sin motivo ni fecha no es una decisión, es un permiso`); return 1; }
    }
    if (d.revision < new Date().toISOString().slice(0, 10)) {
      console.log(`🔴 la diferencia declarada ${d.grupo}/${d.rasgo} venció el ${d.revision} — o se cierra, o se re-declara con fecha nueva`);
      return 1;
    }
    declaradas.set(`${d.grupo}/${d.rasgo}`, d);
  }

  let divergencias = 0, ausentes = 0, comparados = 0;
  const lineas = [];

  const avisos = [];
  for (const [grupo, def] of Object.entries(cfg.grupos || {})) {
    const g = normalizarGrupo(def);
    if (!g) { console.log(`🔴 el grupo "${grupo}" no es ni una lista de repos ni un objeto con "repos"`); return 2; }
    const textos = {};
    for (const r of g.repos) {
      const f = path.join(raiz, r.ruta, g.archivo);
      // 🔴 NO SE PREGUNTA POR EL DISCO ANTES DE MIRAR LO PUBLICADO (2026-09-04). Acá había un
      // `if (!fs.existsSync(f)) { ausentes++; continue; }` JUSTO ANTES de leer `origin/main`, o sea
      // que el arreglo de abajo —"se compara lo publicado, no el disco"— quedaba anulado para el
      // caso más común: el clon parado en `dev`, que es donde trabaja el dev. Si el archivo existe
      // en `origin/main` pero no en el árbol de trabajo, el repo se contaba como "no está en esta
      // máquina" y salía de la comparación ENTERA, en silencio.
      //
      // Medido el 2026-09-04, revisión de cierre: los pipelines de PRODUCCIÓN de dos productos no se
      // compararon con nada —ni siquiera el freno de retroceso, que está marcado `exigido`— porque
      // sus clones estaban en `dev`. El control decía "1 divergencia sobre 55" habiendo dejado dos
      // repos afuera. Un control que se saltea lo que no encuentra en el disco mide menos de lo que
      // dice, y "no medido" se lee como "coincide" — guides/incident-log.md#case-parity-skipped-repos-2026-09-04.
      //
      // Ahora: primero lo publicado; el disco es el plan B; y sólo si FALLAN LOS DOS es ausente.
      //
      // La pregunta que este control contesta es "¿los cinco productos hacen lo mismo?", y eso se
      // decide sobre lo que CORRE, o sea `origin/main`. Leía el árbol de trabajo, así que un
      // checkout parado en otra rama —lo normal: el dev trabaja en `dev`— se reportaba como
      // divergencia del PRODUCTO. Medido el 2026-09-03: el backend de un producto, 29 commits atrás,
      // producía CUATRO divergencias que en `origin/main` no existen. Un control que da falsas
      // alarmas se apaga, y se lleva puestos los casos donde sí importaba — guides/incident-log.md#revision-final-de-los-14-pipelines-2026-09-03.
      //
      // El disco sigue siendo el plan B —para un repo sin remoto, o sin ese ref— pero AVISANDO:
      // "no pude leer lo publicado" y "leí lo publicado" no son lo mismo y no se pueden confundir.
      let leido = null;
      try {
        leido = cp.execFileSync('git', ['-C', path.join(raiz, r.ruta), 'show', `origin/main:${g.archivo}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
      } catch (_) { leido = null; }
      if (leido === null) {
        avisos.push(`  ⚠️ ${r.producto} (${grupo}): no pude leer ${g.archivo} de origin/main — se compara el archivo del disco, que puede estar en otra rama`);
        try { leido = fs.readFileSync(f, 'utf8'); }
        catch (_) { textos[r.producto] = null; ausentes++; continue; }
      }
      textos[r.producto] = leido;
    }
    const presentes = Object.entries(textos).filter(([, t]) => t !== null);
    if (presentes.length < 2) {
      lineas.push(`  ${grupo}: sólo ${presentes.length} repo(s) en esta máquina — no alcanza para comparar`);
      continue;
    }
    for (const rasgo of cfg.rasgos) {
      // Un rasgo sin `id` o sin `patron` NO se saltea en silencio: `new RegExp(undefined)` compila
      // sin quejarse, no matchea nunca, y sumaría una comparación que en realidad no se hizo — o
      // sea, inflaría el "todos coinciden" con una medición fantasma. (Cazado el 2026-09-01 al
      // meter por error un bloque de comentario dentro del array de rasgos.)
      if (!rasgo.id || typeof rasgo.patron !== 'string') {
        console.log(`🔴 hay una entrada en "rasgos" sin id o sin patron: ${JSON.stringify(rasgo).slice(0, 120)}`);
        console.log('   Un rasgo que no se puede evaluar NO es un rasgo que pasa.');
        return 2;
      }
      // ¿Le aplica a este grupo? Con `grupos` explícito, sólo a ésos. Sin `grupos`, a todos los
      // grupos salvo los que pidieron recibir únicamente rasgos que los nombren.
      const aplica = rasgo.grupos ? rasgo.grupos.includes(grupo) : !g.soloExplicitos;
      if (!aplica) continue;
      let rx;
      try { rx = new RegExp(rasgo.patron, 'm'); }
      catch (e) { console.log(`🔴 el rasgo ${rasgo.id} tiene un patrón ilegible: ${e.message}`); return 2; }
      comparados++;
      // Con `bloque`, el patrón se evalúa sólo sobre ese bloque de nivel raíz (ausente = no lo tiene).
      const donde = (t) => (rasgo.bloque ? (bloqueRaiz(t, rasgo.bloque) || '') : t);
      const tiene = presentes.filter(([, t]) => rx.test(donde(t))).map(([n]) => n);
      const noTiene = presentes.filter(([, t]) => !rx.test(donde(t))).map(([n]) => n);
      const clave = `${grupo}/${rasgo.id}`;

      // 🔴 UNANIMIDAD NO ES SIEMPRE ACUERDO (2026-09-01). Este control compara los productos
      // ENTRE SÍ, así que si los cinco dejan de hacer lo mismo a la vez, los cinco coinciden y
      // sale verde. Para los rasgos que tienen un criterio ÚNICO escrito afuera —hoy, el guión
      // `scripts/ci/audit-dependencies.js`— eso no alcanza: un rasgo `exigido` que NADIE
      // cumple es un hallazgo, no un acuerdo. Sin esto, borrar el `dotnet restore` de los cinco
      // backends el mismo día dejaría a los cinco escaneando a ciegas, en verde.
      if (rasgo.exigido && !tiene.length) {
        if (declaradas.has(clave)) {
          lineas.push(`  ⚠️ ${grupo} · ${rasgo.que}: NINGUNO lo hace, DECLARADO (revisar ${declaradas.get(clave).revision})`);
          continue;
        }
        divergencias++;
        lineas.push(`  🔴 ${grupo} · ${rasgo.que}`);
        lineas.push(`       NINGUNO lo hace — y el criterio único (${rasgo.criterio || 'scripts/ci/'}) sí.`);
        lineas.push('       Coincidir en no hacerlo no es estar de acuerdo: es el mismo agujero en los cinco.');
        continue;
      }

      if (!tiene.length || !noTiene.length) continue;       // todos igual: nada que decir
      if (declaradas.has(clave)) {
        lineas.push(`  ⚠️ ${grupo} · ${rasgo.que}: difiere, DECLARADO (revisar ${declaradas.get(clave).revision})`);
        continue;
      }
      divergencias++;
      lineas.push(`  🔴 ${grupo} · ${rasgo.que}`);
      lineas.push(`       lo tienen: ${tiene.join(', ')}`);
      lineas.push(`       NO lo tienen: ${noTiene.join(', ')}`);
    }
  }

  for (const l of lineas) console.log(l);
  if (avisos.length) {
    console.log(`\n⚠️ ${avisos.length} archivo(s) se compararon desde el DISCO y no desde lo publicado:`);
    avisos.forEach(a => console.log(a));
  }
  if (ausentes) console.log(`\n⚠️ ${ausentes} repo(s) no están en esta máquina: NO se compararon. "No medido" no es "coincide".`);
  if (divergencias) {
    console.log(`\n🔴 ${divergencias} divergencia(s) entre productos, sobre ${comparados} comparación(es).`);
    console.log('   Si alguna es legítima, declarala en product-parity.json con motivo y fecha.');
    return 1;
  }
  if (comparados === 0) { console.log('🔴 no se comparó nada — no puedo opinar'); return 2; }
  console.log(`✅ paridad entre productos: ${comparados} comparación(es), todos coinciden`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, bloqueRaiz, normalizarGrupo };
