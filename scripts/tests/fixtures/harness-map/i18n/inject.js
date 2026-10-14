'use strict';
/* El selector de idioma de JUGUETE para las pruebas del mapa (scripts/tests/mapa-arnes-*.test.sh). El de verdad vive con
 * el sitio, en el repo que tiene el mapa interno (onboarding/mini-class/i18n/inject.js); el generador lo recibe con
 * --i18n. Éste deja una marca con el nombre de la página para que la prueba vea que se incrustó, y en qué página. */
const BLOCK_RE = /<!--i18n:begin[^>]*-->[\s\S]*?<!--i18n:end-->\n?/;
function inject(html, page) {
  const block = `<!--i18n:begin (selector de prueba)--><script>/* idioma de prueba: ${page} */</script><!--i18n:end-->\n`;
  const clean = String(html).replace(BLOCK_RE, '');
  const at = clean.lastIndexOf('</body>');
  return at < 0 ? clean + block : clean.slice(0, at) + block + clean.slice(at);
}
module.exports = { inject };
