require('dotenv').config();

const { bootstrapCredentials } = require('@librechat/api/credentials');
const { prepareVectoreeStartup } = require('@librechat/api');

const credentialState = bootstrapCredentials();
if (typeof prepareVectoreeStartup === 'function') {
  prepareVectoreeStartup({ env: process.env, projectRoot: process.cwd() });
}

module.exports = credentialState;
