test('legacy fake timers and back to the real ones', () => {
  jest.useFakeTimers({ legacyFakeTimers: true });
  jest.useRealTimers();
});

test('a real timer after that', () => {
  setTimeout(() => {}, 60000);
});
