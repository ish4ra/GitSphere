// Backward-compatible entry point. The authoritative resolver lives in
// src/geo/resolver.js and is shared by all GitSphere ranking modes.
export {
  createGlobalLocationResolver,
  loadGlobalLocationResolver,
  loadSharedResolver,
  LOCATION_RESOLVER_VERSION,
} from './geo/resolver.js';
