'use strict';
// Corrector de la historia de juguete «espera» de la prueba de resta de ledger-visible.
module.exports = require('./toy-pipeline.js').juguete({ archivos: ['src/lector.js', 'src/escritor.js', 'src/cola.js', 'src/reintento.js', 'src/sondeo.js'], viejo: 'ESPERA_MS = 3000' });
