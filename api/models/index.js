const mongoose = require('mongoose');
const { createMethods } = require('@librechat/data-schemas');
const {
  createVectoreeChatBridge,
  findMatchingPattern,
  isDeploymentSkillId,
  matchModelName,
  readVectoreeAppCredentials,
} = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');

const methods = createMethods(mongoose, {
  matchModelName,
  findMatchingPattern,
  isExternalSkillId: isDeploymentSkillId,
  getCache: getLogStores,
});

const vectoreeChats = createVectoreeChatBridge({
  methods,
  credentials: () => readVectoreeAppCredentials(process.env, process.cwd()),
  findOwner: async (userId) => {
    const user = await methods.getUserById(userId, 'provider openidId');
    if (!user || user.provider !== 'vectoree' || typeof user.openidId !== 'string' || !user.openidId) {
      return null;
    }
    return user.openidId;
  },
});

const seedDatabase = async () => {
  await methods.initializeRoles();
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();
};

module.exports = {
  ...methods,
  ...vectoreeChats,
  seedDatabase,
};
