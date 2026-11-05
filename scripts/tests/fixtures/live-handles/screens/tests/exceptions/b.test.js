// El mismo nombre que una prueba amparada de a.test.js: la excepción no la alcanza.
test('current', () => {
  setInterval(() => {}, 1000);
});
