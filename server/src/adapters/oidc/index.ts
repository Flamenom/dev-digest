/** OIDC identity-provider adapters (behind the `IdentityProvider` port). */
export {
  GoogleIdentityProvider,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_JWKS_URI,
  GOOGLE_ISSUERS,
  ID_TOKEN_CLOCK_TOLERANCE_S,
  JWKS_COOLDOWN_MS,
  type GoogleIdentityProviderOptions,
  type FetchLike,
} from './google.js';
