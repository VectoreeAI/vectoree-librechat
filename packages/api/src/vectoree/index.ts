export { createVectoreeAppAuth, linkVectoreeUser, toVectoreeLinkedUser } from './appAuth';
export { VectoreeConfigError } from './errors';
export { createVectoreeLink } from './link';
export { prepareVectoreeStartup } from './store';
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
