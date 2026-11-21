// La señal viaja dentro del pedido, como en fetch(new Request(url, { signal })).
test('a request cancelled through its own signal', () => {
  const controller = new AbortController();
  global.fetch = () => new Promise(() => {});
  fetch({ url: 'https://api.example.test/request', signal: controller.signal });
  controller.abort();
});
