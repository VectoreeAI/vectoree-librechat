export { createVectoreeAppAuth, linkVectoreeUser, toVectoreeLinkedUser } from './appAuth';
export { VectoreeConfigError } from './errors';
export { createVectoreeLink, readVectoreeAppCredentials } from './link';
export { createVectoreeChatBridge } from './chatBridge';
export { createVectoreeChats } from './chats';
export {
  applyGenerationDefaults,
  prepareVectoreeStartup,
  VECTOREE_IMAGE_MODEL_DEFAULT,
  VECTOREE_SPEECH_MODEL_DEFAULT,
  VECTOREE_SPEECH_VOICE_DEFAULT,
} from './store';
export type {
  AppAuthOutcome,
  AppAuthSubmitInput,
  LinkVectoreeUserDeps,
  VectoreeAppCredentials,
  VectoreeAuthUser,
  VectoreeLinkedUser,
  VectoreeUserCreate,
} from './appAuth';
export type { VectoreeConnectSnapshot, VectoreeLinkOptions, VectoreeLinkStatus } from './link';
