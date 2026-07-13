// Facebook JS SDK loader + thin promise wrappers, shared by the login-page
// "Sign in with Facebook" button and the "Connect WhatsApp via Facebook"
// (Embedded Signup) popup.
//
// The app id / config id come from the backend at runtime (GET /api/public-config),
// so nothing is hardcoded and the whole feature is inert until an operator sets
// FB_APP_ID. loadFacebookSdk() is idempotent — the SDK <script> is injected and
// FB.init runs at most once per page.

import { api } from '../api.js';

let sdkPromise = null;
let cachedConfig = null;

// Fetch (and cache) the public Facebook config. Returns { enabled, appId,
// configId, graphVersion }. Never throws — a failure resolves to disabled.
export async function getFacebookConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const r = await api.publicConfig();
    cachedConfig = r?.facebook || { enabled: false };
  } catch {
    cachedConfig = { enabled: false };
  }
  return cachedConfig;
}

// Load + init the SDK. Resolves the config; if Facebook isn't enabled it resolves
// without loading anything (callers check config.enabled).
export async function loadFacebookSdk() {
  const config = await getFacebookConfig();
  if (!config.enabled || !config.appId) return config;
  if (window.FB) return config;
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      window.fbAsyncInit = function () {
        try {
          window.FB.init({
            appId: config.appId,
            cookie: true,
            xfbml: false,
            version: config.graphVersion || 'v21.0',
          });
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      const id = 'facebook-jssdk';
      if (document.getElementById(id)) return; // already injected; fbAsyncInit will fire
      const js = document.createElement('script');
      js.id = id;
      js.src = 'https://connect.facebook.net/en_US/sdk.js';
      js.async = true;
      js.defer = true;
      js.crossOrigin = 'anonymous';
      js.onerror = () => reject(new Error('Could not load the Facebook SDK. Check your connection and try again.'));
      document.body.appendChild(js);
    });
  }
  await sdkPromise;
  return config;
}

// Promise wrapper around FB.login. Resolves the raw FB response.
export function fbLogin(options) {
  return new Promise((resolve) => {
    if (!window.FB) { resolve({ error: 'sdk_not_loaded' }); return; }
    window.FB.login((response) => resolve(response), options);
  });
}

export function isFbEnabled() {
  return !!(cachedConfig && cachedConfig.enabled);
}
