const React = require('react');
const { render } = require('@testing-library/react');
const { Loader } = require('../src/Loader');

test('a reassigned jest.fn that never answers', () => {
  global.fetch = jest.fn(() => new Promise(() => {}));
  render(React.createElement(Loader));
  expect(global.fetch.mock.calls.length).toBe(1);
});
