'use strict';
// Corrector de la historia de juguete «renombrar» de la prueba de resta de ledger-visible.
module.exports = require('./toy-pipeline.js').juguete({ archivos: ['src/total.js', 'src/factura.js', 'src/carrito.js', 'src/resumen.js', 'src/envio.js'], viejo: 'calcularTotal' });
