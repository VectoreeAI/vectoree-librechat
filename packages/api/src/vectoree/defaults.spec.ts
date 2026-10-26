import { applyGenerationDefaults } from './store';

describe('vectoree generation defaults', () => {
  test('fills the DeerFlow image and speech models when they are unset', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGenerationDefaults(env);
    expect(env.VECTOREE_IMAGE_MODEL).toBe('bytedance-seed/seedream-5-0-pro');
    expect(env.VECTOREE_SPEECH_MODEL).toBe('sesame/csm-1b');
    expect(env.VECTOREE_SPEECH_VOICE).toBe('alloy');
  });

  test('keeps an operator override', () => {
    const env: NodeJS.ProcessEnv = { VECTOREE_IMAGE_MODEL: 'custom/image' };
    applyGenerationDefaults(env);
    expect(env.VECTOREE_IMAGE_MODEL).toBe('custom/image');
    expect(env.VECTOREE_SPEECH_MODEL).toBe('sesame/csm-1b');
  });
});
