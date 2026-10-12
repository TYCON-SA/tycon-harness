#!/usr/bin/env node
/**
 * check-tolerant-steps.js — un paso que DECIDE algo no puede ser tolerante a fallos.
 *
 * 🔴 POR QUÉ EXISTE (2026-09-03). Se midió provocándolo: una corrida que termina
 * `partiallySucceeded` —lo que pasa cuando un paso con `continueOnError: true` falla— **APRUEBA la
 * política de build del pull request**. O sea que marcar un paso como tolerante a fallos no es sólo
 * "no frena el pipeline": es "su fallo deja pasar el cambio a la rama principal".
 *
 * Hoy no hay ninguno mal marcado. Las clases tolerantes que quedan en los 14 pipelines no deciden
 * nada: avisar que una rama quedó atrás, recalcular notas de versión, publicar reportes de pruebas
 * y cobertura, y bajar un artefacto cuyo consumidor corta por su cuenta. Este control nace en verde
 * y existe para el paso siguiente — el que alguien agregue dentro de tres meses sin saber que la
 * marca también decide si el pull request pasa.
 *
 * 🔴 2026-09-03 — BAJAR EL ARNÉS SALIÓ DE LA LISTA BLANCA. Estaba con el motivo "hay copia local de
 * respaldo, y si falta, el paso que la usa corta por su cuenta". Las dos mitades eran falsas: la
 * copia local se borró hace meses, y los pasos que usan los guiones —el que decide a quién
 * versionar, el que despliega, el del humo— fallaban DESPUÉS, con un error que no se parece a la
 * causa. Se sacaron las 15 marcas de los 10 pipelines (un pull request por pipeline — guides/incident-log.md#case-harness-download-tolerant-2026-09-03;
 * el backend de un producto ya era
 * estricto) y la clase sale de acá, para que la marca no vuelva sin que alguien la justifique.
 *
 * CÓMO DECIDE. No adivina qué "decide": va por lista blanca de lo conocido-inofensivo, con la carga
 * de la prueba del lado de quien agrega algo nuevo. Un paso tolerante que no encaje en ninguna clase
 * se marca, y quien lo agregó explica por qué es inofensivo — agregándolo acá, o sacándole la marca.
 * Al revés (adivinar qué es peligroso) el control se vuelve ruido y alguien lo apaga.
 *
 * Salida: 0 sin hallazgos · 1 hay al menos uno · 2 no se pudo leer (ilegible NO es aprobado).
 * Uso: check-tolerant-steps.js <archivo.yml> [...]
 */
const fs = require('fs');

// Clases conocidas-inofensivas. Cada una con el motivo por el que su fallo NO decide nada.
const INOFENSIVOS = [
  { re: /warn\s+if\s+dev|dev\s+fell\s+behind|qued[oó]\s+atr[aá]s/i,
    por: 'es un aviso por definición: informa que una rama quedó atrás, no decide nada' },
  { re: /release\s+notes|notas?\s+de\s+versi[oó]n|recompute|recalcul/i,
    por: 'una nota de versión no puede voltear un build ni un despliegue' },
  { re: /publish[\s_-]*(test|code)?[\s_-]*(results?|coverage)|publicar.*(reporte|cobertura)|PublishTestResults|PublishCodeCoverage/i,
    por: 'publicar el reporte de pruebas o de cobertura: el resultado ya se decidió antes' },
  { re: /download.*(artifact|paquete|deployment packages|plugin artifact)/i,
    por: 'bajar un artefacto cuyo consumidor corta por su cuenta si no llegó' },
  // «Upload to <el host de plugins> …»: el paso que sube el paquete en los pipelines de producto. Se reconoce por su
  // forma —un destino de una palabra que termina en «Extensions»—; el nombre del destino no se escribe acá (story
  // 8.10.3, tanda C). No se estira a cualquier «upload to X production»: eso es un despliegue, y tolerante se marca.
  { re: /commit version update|upload to \w*extensions\b/i,
    por: 'sólo corre en la rama principal, donde no hay política de pull request que aprobar' },
];

function pasos(txt) {
  const L = txt.split('\n'); const out = [];
  for (let i = 0; i < L.length; i++) {
    if (!/^\s*continueOnError:\s*true\s*$/.test(L[i])) continue;
    const sang = L[i].length - L[i].trimStart().length;
    let nombre = null, inicio = i;
    for (let j = i; j >= 0 && j > i - 80; j--) {
      const s = L[j].length - L[j].trimStart().length;
      if (s === sang && /displayName:/.test(L[j])) { nombre = L[j].split('displayName:')[1].trim().replace(/^['"]|['"]$/g, ''); }
      if (s === sang - 2 && L[j].trimStart().startsWith('- ')) { inicio = j; break; }
    }
    // sin displayName propio, el nombre es lo que sea el paso (task o script)
    if (!nombre) nombre = (L[inicio] || '').trim().replace(/^-\s*/, '');
    out.push({ linea: i + 1, nombre });
  }
  return out;
}

let hallazgos = 0, ilegibles = 0, mirados = 0, tolerantes = 0;
const archivos = process.argv.slice(2);
if (!archivos.length) { console.log('uso: check-tolerant-steps.js <archivo.yml> [...]'); process.exit(2); }

for (const f of archivos) {
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); }
  catch (e) { console.log(`🔴 ${f}: no se pudo leer (${e.message}) — ilegible NO es aprobado`); ilegibles++; continue; }
  mirados++;
  for (const p of pasos(txt)) {
    tolerantes++;
    if (INOFENSIVOS.some((c) => c.re.test(p.nombre))) continue;
    console.log(`🔴 ${f}:${p.linea} · paso tolerante a fallos que no está en ninguna clase conocida: "${p.nombre}"`);
    console.log('     Su fallo deja la corrida en "parcialmente exitosa", y eso APRUEBA la política del pull request.');
    console.log('     Si de verdad no decide nada, agregá su clase a INOFENSIVOS con el motivo; si decide, sacale continueOnError.');
    hallazgos++;
  }
}

if (ilegibles) { console.log(`\n🔴 ${ilegibles} archivo(s) ilegible(s)`); process.exit(2); }
if (hallazgos) { console.log(`\n🔴 ${hallazgos} paso(s) tolerante(s) sin justificar, sobre ${tolerantes} en ${mirados} pipeline(s)`); process.exit(1); }
console.log(`✅ pasos tolerantes: ${tolerantes} en ${mirados} pipeline(s), todos de clases que no deciden nada`);
process.exit(0);
