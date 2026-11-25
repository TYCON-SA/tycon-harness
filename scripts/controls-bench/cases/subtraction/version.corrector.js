'use strict';
// Corrector de la historia de juguete «version» de la prueba de resta de ledger-visible.
module.exports = require('./toy-pipeline.js').juguete({ archivos: ['src/clientes.js', 'src/pedidos.js', 'src/productos.js', 'src/stock.js', 'src/pagos.js'], viejo: '/api/v1/' });
