test('fake timers without anything pending', () => {
  jest.useFakeTimers();
  setTimeout(() => {}, 1000);
  jest.runAllTimers();
});

test('goes back to real timers at the end', () => {
  jest.useFakeTimers();
  setTimeout(() => {}, 1000);
  jest.useRealTimers();
});

describe('clears them in its own afterEach', () => {
  afterEach(() => jest.clearAllTimers());
  test('leaves one for its afterEach', () => {
    jest.useFakeTimers();
    setTimeout(() => {}, 1000);
  });
});

test('the next one starts without pending timers', () => {
  jest.useRealTimers();
  expect(1).toBe(1);
});
