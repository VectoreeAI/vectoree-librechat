import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvFile } from './envfile';

describe('parseEnvFile', () => {
  test('treats a missing file as empty', () => {
    expect(parseEnvFile(path.join(os.tmpdir(), 'vectoree-missing.env'))).toEqual({});
  });

  test('throws when the file exists but cannot be read', () => {
    const denied = Object.assign(new Error('EACCES: permission denied, open /app/.env'), {
      code: 'EACCES',
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw denied;
    });
    expect(() => parseEnvFile('/app/.env')).toThrow(denied);
  });
});
