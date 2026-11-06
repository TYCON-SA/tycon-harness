test('leaves a fake timer pending', () => {
  jest.useFakeTimers();
  setTimeout(() => {}, 1000);
});
