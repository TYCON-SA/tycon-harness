test('reads mock.calls and mockResolvedValue', async () => {
  global.fetch = jest.fn().mockResolvedValue({ json: async () => [1, 2] });
  const response = await fetch('https://api.example.test/a');
  expect(await response.json()).toEqual([1, 2]);
  expect(global.fetch.mock.calls).toEqual([['https://api.example.test/a']]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(jest.isMockFunction(global.fetch)).toBe(true);
});
