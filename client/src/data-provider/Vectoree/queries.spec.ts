import { nextVectoreeGate } from './queries';

describe('nextVectoreeGate', () => {
  test('cloud mode opens the app from a preview and never the link page', () => {
    expect(nextVectoreeGate({ linked: false, deployMode: 'cloud', previewed: true }, false, false)).toBe('app');
    expect(nextVectoreeGate({ linked: true, deployMode: 'cloud', previewed: false }, false, false)).toBe('expired');
    expect(nextVectoreeGate({ linked: false, deployMode: 'cloud', previewed: false }, true, false)).toBe('loading');
  });

  test('local mode still requires a project link', () => {
    expect(nextVectoreeGate({ linked: false, deployMode: 'local' }, false, false)).toBe('link');
    expect(nextVectoreeGate({ linked: true, deployMode: 'local' }, false, false)).toBe('app');
    expect(nextVectoreeGate(undefined, false, true)).toBe('link');
    expect(nextVectoreeGate(undefined, false, false)).toBe('loading');
  });
});
