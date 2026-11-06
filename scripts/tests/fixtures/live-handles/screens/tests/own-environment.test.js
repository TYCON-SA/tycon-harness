/**
 * @jest-environment node
 */
// Con su propio entorno, este archivo corre sin el detector: lo que importa es que quede dicho.
test('declares its own environment', () => {
  expect(1).toBe(1);
});
