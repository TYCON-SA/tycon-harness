const React = require('react');
const { render } = require('@testing-library/react');
const { Loader } = require('../src/Loader');

global.fetch = async () => 'real';

test('a spied fetch that never answers', () => {
  const spy = jest.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}));
  render(React.createElement(Loader));
  expect(spy).toHaveBeenCalledWith(expect.stringContaining('api.example.test'), expect.anything());
  spy.mockRestore();
});

test('mockRestore brings back the original', async () => {
  expect(await fetch('https://api.example.test/x')).toBe('real');
});
