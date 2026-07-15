// Public marketing landing page — the first thing a logged-out visitor sees.
//
// The markup and CSS are the hand-authored page kept verbatim in ./src/landing/
// (landing.body.html + landing.css); only the prices were moved to INR. Keeping
// them as real .html/.css assets — rather than retyping 800 lines into JSX —
// means the design can be edited as plain HTML/CSS without touching React.
//
// Scoping: the stylesheet is mounted with the component, so its `body`/`:root`
// rules disappear again the moment we navigate to the login screen. Its custom
// properties (--primary, --bg, …) don't collide with the app's (--c-*).
//
// Branding here ("Axxeler AI") is the page's own and is intentionally left as
// authored — it is not the app's Zen Chat branding.

import { useEffect, useRef } from 'react';
import landingCss from '../landing/landing.css?inline';
import landingHtml from '../landing/landing.body.html?raw';
import { initLanding } from '../landing/landingScript.js';

export default function LandingPage({ onGetStarted, onNavigate }) {
  const rootRef = useRef(null);

  useEffect(() => {
    // Attach behaviour once the markup is in the DOM; tear it all down on
    // unmount so no timer outlives the page.
    const cleanup = initLanding(rootRef.current, { onGetStarted, onNavigate });
    return cleanup;
  }, [onGetStarted, onNavigate]);

  return (
    <>
      <style>{landingCss}</style>
      <div
        ref={rootRef}
        className="axxeler-landing"
        dangerouslySetInnerHTML={{ __html: landingHtml }}
      />
    </>
  );
}
