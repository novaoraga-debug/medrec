// Google Identity Services loader shared by every portal.
// The button only activates when VITE_GOOGLE_CLIENT_ID is configured; otherwise
// portals show a disabled placeholder instead of a broken Google button.

let scriptPromise = null;

export function googleClientId() {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim();
}

export function googleEnabled() {
  return Boolean(googleClientId());
}

export function loadGoogleScript() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google sign-in requires a browser.'));
  }
  if (window.google?.accounts?.id) {
    return Promise.resolve(window.google);
  }
  if (scriptPromise) {
    return scriptPromise;
  }

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google?.accounts?.id) {
        resolve(window.google);
      } else {
        reject(new Error('Google Identity Services failed to initialize.'));
      }
    };
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Failed to load Google Identity Services.'));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

// Renders the official Google button into `element` and resolves `true` once it
// is interactive. `onToken` receives the Google ID token (JWT credential).
export async function renderGoogleButton(element, { onToken, onError } = {}) {
  if (!element) return false;
  if (!googleEnabled()) {
    onError?.(new Error('Google sign-in is not configured. Set VITE_GOOGLE_CLIENT_ID.'));
    return false;
  }

  const google = await loadGoogleScript();
  google.accounts.id.initialize({
    client_id: googleClientId(),
    callback: (response) => {
      if (response?.credential) {
        onToken?.(response.credential);
      } else {
        onError?.(new Error('Google did not return a credential.'));
      }
    },
    auto_select: false,
    cancel_on_tap_outside: true
  });

  try {
    google.accounts.id.renderButton(element, {
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      width: 320,
      logo_alignment: 'left'
    });
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error('Google button render failed.'));
    return false;
  }

  return true;
}