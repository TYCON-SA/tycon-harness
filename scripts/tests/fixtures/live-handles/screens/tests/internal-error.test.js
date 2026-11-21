// Rompe el registro del detector a propósito: el detector no puede tumbar la prueba en modo aviso.
test('the detector breaks inside', () => {
  setInterval(() => {}, 1000);
  globalThis.__tyconLiveHandles.timers = null;
});
