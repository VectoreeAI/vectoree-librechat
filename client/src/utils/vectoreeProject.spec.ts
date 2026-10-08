import { extractProjectId } from './vectoreeProject';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

describe('extractProjectId', () => {
  test('reads a UUID from a console URL or dashboard line', () => {
    expect(extractProjectId(PROJECT_ID)).toBe(PROJECT_ID);
    expect(extractProjectId(`https://vectoree.ai/dashboard/projects/${PROJECT_ID}`)).toBe(PROJECT_ID);
    expect(extractProjectId(`Dashboard project: Demo (${PROJECT_ID})`)).toBe(PROJECT_ID);
    expect(extractProjectId('not a project')).toBeNull();
  });
});
