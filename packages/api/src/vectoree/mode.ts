export type DeployMode = 'local' | 'cloud';

export function readDeployMode(env: NodeJS.ProcessEnv = process.env): DeployMode {
  const raw = env.DEPLOY_MODE?.trim() ?? '';
  if (raw === '' || raw === 'local') return 'local';
  if (raw === 'cloud') return 'cloud';
  throw new Error('DEPLOY_MODE must be local or cloud');
}

/** Cloud visitors arrive with a preview ticket. The operator link is local only. */
export function usesProjectLink(env: NodeJS.ProcessEnv = process.env): boolean {
  return readDeployMode(env) === 'local';
}
