'use strict';
/**
 * file-zones.js — una lista de archivos dicha en palabras: cuántos y de qué zonas, sin rutas. Es lo que muestra el cuadro
 * de una firma (owner-approvals.js `cuadroDe`): una lista de rutas no se lee en un teléfono, y la cantidad y las zonas
 * alcanzan para decidir. La lista entera sigue atada a la firma por la fuente que lleva la huella.
 *
 *   · `zonasDe(rutas)` → «11 archivos: 6 de código (lib y tools), 4 pruebas, 1 historia», o null sin archivos.
 *
 * La regla sale de la ruta, no de un vocabulario escrito a mano: hasta 3 archivos de código se nombran por su nombre sin
 * carpeta ni extensión; más, por su carpeta (hasta 3, y «y N carpetas más»). Lo demás se cuenta por clase.
 */
const path = require('path');

const CODIGO = /\.(?:[cm]?[jt]sx?|cs|csproj|py|sh|bash|ps1|psm1|go|java|kt|rb|php|rs|swift|c|h|cpp|hpp|sql|vue|svelte|css|scss|html?)$/i;
// en este orden se nombran las clases; cada una con su singular y su plural
const CLASES = [
  ['código', (n) => `${n} de código`],
  ['pruebas', (n) => (n === 1 ? '1 prueba' : `${n} pruebas`)],
  ['historias', (n) => (n === 1 ? '1 historia' : `${n} historias`)],
  ['guías', (n) => (n === 1 ? '1 guía' : `${n} guías`)],
  ['configuración', (n) => `${n} de configuración`],
  ['otros', (n) => (n === 1 ? '1 otro' : `${n} otros`)],
];
// con un solo archivo, la zona sin el número: «1 archivo: una prueba»
const SOLO = { código: 'de código', pruebas: 'una prueba', historias: 'una historia', guías: 'una guía', configuración: 'de configuración', otros: 'otro' };
const NOMBRADOS = 3;
const LARGO_DEL_NOMBRE = 40;

function claseDe(ruta) {
  const base = path.posix.basename(ruta);
  if (/(^|\/)(?:tests?|__tests__)\//.test(ruta) || /\.(?:test|spec)\.[^.]+$/i.test(base)) return 'pruebas';
  if (/(^|\/)specs\//.test(ruta) || /^story-.*\.md$/i.test(base)) return 'historias';
  if (/\.md$/i.test(base)) return 'guías';
  if (/\.(?:json|ya?ml|toml)$/i.test(base)) return 'configuración';
  return CODIGO.test(base) ? 'código' : 'otros';
}

const enLista = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}` : xs[0]);
const sinExtension = (r) => path.posix.basename(r).replace(/\.[^.]+$/, '') || path.posix.basename(r);
const carpetaDe = (r) => { const d = path.posix.dirname(r); return d === '.' || d === '/' ? 'raíz' : path.posix.basename(d); };
// la ruta sin la anotación que le pone el plan («a.js (nuevo)») y con los «..» resueltos: la zona sale del archivo
const limpia = (r) => path.posix.normalize(String(r == null ? '' : r).trim().replace(/\\/g, '/').replace(/\s+\([^)]*\)$/, ''));

/**
 * Los archivos de código, por su nombre si son hasta 3; si no, por sus carpetas. Un nombre de más de 40 letras no se
 * nombra (no entra en un renglón del teléfono): se cuenta en «y N carpetas más».
 */
function nombresDelCodigo(rutas) {
  const nombres = rutas.map(sinExtension);
  if (rutas.length <= NOMBRADOS && nombres.every((n) => n.length <= LARGO_DEL_NOMBRE)) return enLista(nombres);
  const carpetas = [...new Set(rutas.map(carpetaDe))];
  const vistas = carpetas.filter((c) => c.length <= LARGO_DEL_NOMBRE).slice(0, NOMBRADOS);
  const resto = carpetas.length - vistas.length;
  if (!vistas.length) return `${carpetas.length} ${carpetas.length === 1 ? 'carpeta' : 'carpetas'}`;
  return resto ? `${vistas.join(', ')} y ${resto} ${resto === 1 ? 'carpeta' : 'carpetas'} más` : enLista(vistas);
}

function zonasDe(rutas) {
  const unicas = [...new Set((Array.isArray(rutas) ? rutas : []).filter((r) => String(r == null ? '' : r).trim()).map(limpia))];
  if (!unicas.length) return null;
  const porClase = new Map(CLASES.map(([c]) => [c, []]));
  for (const r of unicas) porClase.get(claseDe(r)).push(r);
  const conNombres = (clase, texto) => (clase === 'código' ? `${texto} (${nombresDelCodigo(porClase.get(clase))})` : texto);
  if (unicas.length === 1) {
    const clase = claseDe(unicas[0]);
    return `1 archivo: ${conNombres(clase, SOLO[clase])}`;
  }
  const partes = CLASES.filter(([c]) => porClase.get(c).length).map(([c, decir]) => conNombres(c, decir(porClase.get(c).length)));
  return `${unicas.length} archivos: ${partes.join(', ')}`;
}

module.exports = { zonasDe };
