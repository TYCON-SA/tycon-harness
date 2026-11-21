// third_party/node_modules/toy-lib lo arma la prueba copiando vendor/toy-lib (una carpeta node_modules no viaja).
test('a library leaves its own timer', () => {
  require('../third_party/node_modules/toy-lib').start();
});
