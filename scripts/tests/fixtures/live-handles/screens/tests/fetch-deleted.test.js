afterEach(() => {
  delete global.fetch;
});

test('assigns a fetch that answers', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true }));
  await fetch('https://api.example.test/ok');
});

test('after the delete, a fetch that never answers', () => {
  global.fetch = jest.fn(() => new Promise(() => {}));
  fetch('https://api.example.test/never');
});

test('defineProperty with a fetch that never answers', () => {
  Object.defineProperty(global, 'fetch', { value: jest.fn(() => new Promise(() => {})), writable: true, configurable: true });
  fetch('https://api.example.test/defined');
});
