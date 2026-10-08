import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ciText = readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8');

const job = (name, next) => {
  const start = ciText.indexOf(`\n${name}:\n`);
  assert.notEqual(start, -1, name);
  const end = next ? ciText.indexOf(`\n${next}:\n`, start + 1) : ciText.length;
  assert.notEqual(end, -1, next);
  return ciText.slice(start, end);
};

const pattern = ciText.match(/secret_pattern='([^']*)'/)?.[1];

const matchesSecret = (text) => {
  const result = spawnSync('grep', ['-E', '-q', pattern], { input: text, encoding: 'utf8' });
  assert.notEqual(result.status, 2, result.stderr);
  return result.status === 0;
};

test('pipeline has no deploy path and injects the GitHub token into the publish URL', () => {
  assert.match(ciText, /^stages:\n  - \.pre\n  - check\n  - publish\n/m);
  for (const rule of [
    '$CI_PIPELINE_SOURCE == "merge_request_event"',
    '$CI_COMMIT_BRANCH == "dev"',
    '$CI_COMMIT_BRANCH == "main"',
    '$CI_PIPELINE_SOURCE == "web"',
  ]) {
    assert.ok(ciText.includes(rule), rule);
  }
  for (const forbidden of [
    'deploy_development',
    'deploy_production',
    '.deploy',
    'docker login',
    'docker build',
    'docker push',
    'ssh ',
    'scp ',
    'set -x',
  ]) {
    assert.equal(ciText.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(ciText.match(/:\/\/[^\s/]+@/g), [
    '://x-access-token:${GITHUB_TOKEN}@',
  ]);
  assert.equal(/(?<!\$)\$CI_JOB_TOKEN/.test(ciText), false);
});

test('git auth reads tokens from the environment', () => {
  const auth = job('.git_auth', 'backup_main');
  assert.match(auth, /image: alpine:3\.21/);
  assert.match(auth, /GIT_ASKPASS: \/tmp\/git-askpass/);
  assert.match(auth, /GIT_TERMINAL_PROMPT: "0"/);
  assert.match(auth, /umask 077/);
  assert.match(auth, /chmod 700 \/tmp\/git-askpass/);
  assert.match(auth, /\$\$GITHUB_TOKEN/);
  assert.match(auth, /\$\$CI_JOB_TOKEN/);
  assert.match(auth, /https:\/\/\$\$\{CI_SERVER_HOST\}\/\$\$\{CI_PROJECT_PATH\}\.git/);
  assert.match(auth, /set -eu/);
});

test('backup_main records the previous main without interpolating the message', () => {
  const backup = job('backup_main', 'test');
  assert.match(backup, /stage: \.pre/);
  assert.match(backup, /resource_group: librechat-main-backup/);
  assert.match(backup, /\$CI_COMMIT_BRANCH == "main"/);
  assert.match(backup, /0000000000000000000000000000000000000000/);
  assert.ok(backup.indexOf('exit 0') < backup.indexOf('git merge'));
  assert.match(backup, /-m 'chore: backup main before release'/);
  assert.match(backup, /git push origin HEAD:refs\/heads\/main-backup/);
});

test('test job runs only the pipeline contract test', () => {
  const check = job('test', 'publish_github');
  assert.match(check, /image: node:24\.16\.0-bookworm-slim/);
  assert.match(check, /timeout: 10m/);
  for (const rule of [
    '$CI_PIPELINE_SOURCE == "merge_request_event"',
    '$CI_COMMIT_BRANCH == "dev"',
    '$CI_COMMIT_BRANCH == "main"',
  ]) {
    assert.ok(check.includes(rule), rule);
  }
  assert.match(check, /node --test config\/gitlab-ci\.contract\.test\.mjs/);
  for (const absent of ['npm ci', 'npm run test:all', 'e2e', 'lighthouse']) {
    assert.equal(check.includes(absent), false, absent);
  }
});

test('publish_github refuses secrets and divergent GitHub history', () => {
  const publish = job('publish_github');
  assert.match(publish, /stage: publish/);
  assert.match(publish, /needs:\n {4}- test\n {4}- backup_main/);
  assert.match(publish, /\$CI_COMMIT_BRANCH == "main"/);
  assert.match(
    publish,
    /https:\/\/x-access-token:\$\{GITHUB_TOKEN\}@github\.com\/VectoreeAI\/vectoree-librechat\.git/,
  );
  assert.match(publish, /grep -E -q/);
  assert.ok(
    publish.indexOf('commit message matched a secret pattern') < publish.indexOf('git fetch'),
  );
  assert.match(publish, /GitHub main has diverged from GitLab main\. Refusing to overwrite\./);
  assert.match(publish, /--force-with-lease="refs\/heads\/main:\$\{remote_sha\}"/);
  assert.equal(publish.includes('echo "$body"') || publish.includes("echo '$body'"), false);
  assert.equal(publish.includes('printf \'%s\\n\' "$body" | grep -E -q'), true);
});

test('secret pattern matches key material and ignores ordinary messages', () => {
  assert.equal(typeof pattern, 'string');
  assert.equal(matchesSecret('chore: backup main before release'), false);
  assert.equal(matchesSecret('BEGIN PRIVATE KEY'), true);
  assert.equal(matchesSecret('BEGIN RSA PRIVATE KEY'), true);
  assert.equal(matchesSecret('BEGIN OPENSSH PRIVATE KEY'), true);
  assert.equal(matchesSecret(['gh', 'p_'].join('')), true);
  assert.equal(matchesSecret(['github', '_pat_'].join('')), true);
  assert.equal(matchesSecret(['gl', 'pat-'].join('')), true);
  assert.equal(matchesSecret(`AKIA${'A'.repeat(16)}`), true);
  assert.equal(matchesSecret('AKIA'), false);
  assert.equal(matchesSecret('TOKEN=value'), true);
  assert.equal(matchesSecret('PASSWORD=value'), true);
  assert.equal(matchesSecret('SECRET=value'), true);
  assert.equal(matchesSecret('TOKEN='), false);
  assert.equal(matchesSecret('a token is not an assignment'), false);

  const shas = execFileSync('git', ['log', '--format=%H'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  for (const sha of shas) {
    const body = execFileSync('git', ['log', '-1', '--format=%B', sha], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(matchesSecret(body), false, `${sha} commit message matched a secret pattern`);
  }
});

test('local tool directories are ignored and untracked', () => {
  const ignoreLines = new Set(
    readFileSync(path.join(root, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim()),
  );
  for (const rel of ['.cursor', '.agent', '.agents', 'openspec']) {
    assert.equal(ignoreLines.has(rel), true, rel);
    const result = spawnSync('git', ['check-ignore', '-v', '--', rel], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, rel);
    assert.match(result.stdout, /\S/);
  }
  const tracked = execFileSync(
    'git',
    ['ls-files', '--', '.cursor', '.agent', '.agents', 'openspec'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(tracked, '');
});
