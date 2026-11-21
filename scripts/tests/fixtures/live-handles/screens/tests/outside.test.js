setInterval(() => {}, 1000);

beforeAll(() => {
  setInterval(() => {}, 1000);
});

test('a healthy test', () => {
  expect(1).toBe(1);
});
