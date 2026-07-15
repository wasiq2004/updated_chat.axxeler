// Behaviour for the marketing landing page, ported from the original standalone
// HTML's inline <script> so it can live inside the SPA.
//
// Three things changed vs the original, all required to be a good SPA citizen:
//   1. Everything is scoped to the mounted `root` element instead of `document`,
//      so the landing can never reach into the rest of the app.
//   2. Every timer / observer / listener is tracked and torn down by the returned
//      cleanup. The original re-arms its chat loops forever — left running after
//      unmount they would throw (their nodes are gone) and leak.
//   3. Prices render in INR (the original hardcoded '$').
//
// Returns a cleanup function; call it on unmount.

const INR = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export function initLanding(root, { onGetStarted, onNavigate } = {}) {
  if (!root) return () => {};

  const timers = new Set();
  const cleanups = [];
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => Array.from(root.querySelectorAll(sel));

  // Timer helpers that register for teardown.
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const every = (fn, ms) => { const id = setInterval(fn, ms); timers.add(id); return id; };

  const on = (el, ev, fn) => {
    if (!el) return;
    el.addEventListener(ev, fn);
    cleanups.push(() => el.removeEventListener(ev, fn));
  };

  /* ── Theme toggle ─────────────────────────────────────────────────────────
     Writes the same <html data-theme> + localStorage key the app itself uses, so
     a visitor's choice on the landing carries into the login screen and app. */
  const themeToggle = $('#themeToggle');
  const iconSun = $('#iconSun');
  const iconMoon = $('#iconMoon');
  const syncThemeIcons = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (iconSun) iconSun.style.display = dark ? 'none' : 'block';
    if (iconMoon) iconMoon.style.display = dark ? 'block' : 'none';
  };
  syncThemeIcons();
  on(themeToggle, 'click', () => {
    const html = document.documentElement;
    const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    html.style.colorScheme = next;
    try { localStorage.setItem('zc-theme', next); } catch { /* ignore */ }
    syncThemeIcons();
  });

  /* ── Mobile menu ─────────────────────────────────────────────────────────── */
  const burgerBtn = $('#burgerBtn');
  const mobileMenu = $('#mobileMenu');
  on(burgerBtn, 'click', () => mobileMenu && mobileMenu.classList.toggle('open'));
  if (mobileMenu) {
    mobileMenu.querySelectorAll('a').forEach(a =>
      on(a, 'click', () => mobileMenu.classList.remove('open')));
  }

  /* ── Reveal on scroll ────────────────────────────────────────────────────── */
  const revealEls = $$('.reveal, .feature-card, .t-step, .industry-card, .testi-card, .price-card');
  let io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    revealEls.forEach(el => { el.classList.add('reveal'); io.observe(el); });
    cleanups.push(() => io.disconnect());
  } else {
    revealEls.forEach(el => el.classList.add('visible'));
  }

  /* ── FAQ accordion ───────────────────────────────────────────────────────── */
  $$('.faq-item').forEach(item => {
    const q = item.querySelector('.faq-q');
    on(q, 'click', () => {
      const isOpen = item.classList.contains('open');
      $$('.faq-item').forEach(i => i.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
  });

  /* ── Pricing toggle (monthly / yearly) ───────────────────────────────────── */
  const billingSwitch = $('#billingSwitch');
  const monthlyLabel = $('#monthlyLabel');
  const yearlyLabel = $('#yearlyLabel');
  let yearly = false;
  const paintPrices = () => {
    $$('.price-amt').forEach(el => {
      const raw = yearly ? el.getAttribute('data-y') : el.getAttribute('data-m');
      const n = Number(raw);
      // A zero-price tier is Free, not "₹0".
      el.textContent = !raw || n === 0 ? 'Free' : INR(n);
    });
    $$('.plan-cycle').forEach(el => {
      if (el.textContent.includes('Billed')) el.textContent = yearly ? 'Billed yearly' : 'Billed monthly';
    });
  };
  on(billingSwitch, 'click', () => {
    yearly = !yearly;
    billingSwitch.classList.toggle('on', yearly);
    if (monthlyLabel) monthlyLabel.style.color = yearly ? 'var(--text-dim)' : 'var(--text)';
    if (yearlyLabel) yearlyLabel.style.color = yearly ? 'var(--text)' : 'var(--text-dim)';
    paintPrices();
  });
  paintPrices(); // render from data-* on mount so markup and JS can't drift

  /* ── CTA wiring ──────────────────────────────────────────────────────────────
     One delegated handler. `href="#"` is used all over this page (logo, socials,
     footer placeholders), so intent is matched on the link text, not the href.
     In-page anchors (#pricing, #demo, …) keep their native scroll behaviour. */
  const onClick = (e) => {
    const a = e.target.closest('a');
    if (!a || !root.contains(a)) return;
    const href = a.getAttribute('href') || '';
    const label = (a.textContent || '').trim().toLowerCase();

    // Intent is matched on the LABEL first, deliberately ahead of the href: the
    // primary CTA appears both as href="#" (pricing cards) and href="#pricing"
    // (header + hero). Every "Start Free" / "Log in" must reach the app, so the
    // href it happens to carry must not decide the behaviour.
    //
    // The label also decides WHICH form opens: "Start Free" is a request to
    // create an account, so it must not land on a sign-in form the visitor has
    // no credentials for.
    if (label === 'log in' || label === 'start free') {
      e.preventDefault();
      onGetStarted?.(label === 'log in' ? 'login' : 'signup');
      return;
    }

    if (href !== '#') return; // real in-page anchors (#pricing, #demo…) scroll natively
    e.preventDefault();

    if (label === 'privacy policy') { onNavigate?.('/privacy-policy'); return; }
    if (label === 'terms of service') { onNavigate?.('/terms-and-conditions'); return; }
    if (a.classList.contains('logo')) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    // Remaining href="#" links are placeholders in the source page — swallow the
    // click so they don't jump the reader back to the top.
  };
  root.addEventListener('click', onClick);
  cleanups.push(() => root.removeEventListener('click', onClick));

  /* ── Hero WhatsApp chat animation ────────────────────────────────────────── */
  const chatBody = $('#chatBody');
  const heroScript = [
    { t: 'in', m: "Hi, I'd like to book a consultation for next week." },
    { t: 'out', m: 'Hi there! I can help with that 😊 What day works best for you?' },
    { t: 'in', m: 'Tuesday afternoon if possible.' },
    { t: 'out', m: 'Tuesday 3:00 PM is available. Shall I confirm your booking?' },
    { t: 'in', m: 'Yes please, confirm it.' },
    { t: 'out', m: "✅ Booked! You'll receive a reminder 1 hour before. See you Tuesday!" },
  ];
  if (chatBody) {
    let heroIdx = 0;
    const addBubble = (item) => {
      const b = document.createElement('div');
      b.className = 'bubble ' + item.t;
      b.textContent = item.m;
      chatBody.appendChild(b);
      chatBody.scrollTop = chatBody.scrollHeight;
      heroIdx++;
      later(step, item.t === 'out' ? 1400 : 1100);
    };
    const step = () => {
      if (heroIdx >= heroScript.length) { later(playHero, 2200); return; }
      const item = heroScript[heroIdx];
      if (item.t === 'out') {
        const dots = document.createElement('div');
        dots.className = 'typing-dots';
        dots.innerHTML = '<span></span><span></span><span></span>';
        chatBody.appendChild(dots);
        chatBody.scrollTop = chatBody.scrollHeight;
        later(() => { dots.remove(); addBubble(item); }, 900);
      } else {
        addBubble(item);
      }
    };
    const playHero = () => { chatBody.innerHTML = ''; heroIdx = 0; step(); };
    playHero();
  }

  /* ── Interactive demo chat ───────────────────────────────────────────────── */
  const demoChat = $('#demoChat');
  const demoSteps = $$('#demoControls .step');
  const demoScript = [
    [
      { t: 'in', m: 'Hi! Do you have 2BHK apartments available near downtown?' },
      { t: 'out', m: "Hello! Yes, we have a few great 2BHK options downtown. What's your budget range?" },
    ],
    [
      // Rent quoted in INR — this is an Indian platform.
      { t: 'in', m: "Around ₹45,000/month, and I'd need it by next month." },
      { t: 'out', m: 'Perfect — I found 3 matching listings. Would you like to schedule a viewing this week?' },
    ],
    [
      { t: 'in', m: 'Yes, Thursday works for me.' },
      { t: 'out', m: 'Great, Thursday 4:00 PM is booked at Maple Residences. See you then! 🏠' },
    ],
  ];
  if (demoChat) {
    const renderDemoStep = (idx) => {
      demoSteps.forEach((s, i) => s.classList.toggle('active', i === idx));
      demoChat.innerHTML = '';
      let all = [];
      for (let i = 0; i <= idx; i++) all = all.concat(demoScript[i]);
      let i = 0;
      const pushBubble = (item) => {
        const b = document.createElement('div');
        b.className = 'bubble ' + item.t;
        b.textContent = item.m;
        demoChat.appendChild(b);
      };
      const next = () => {
        if (i >= all.length) return;
        const item = all[i];
        if (item.t === 'out') {
          const dots = document.createElement('div');
          dots.className = 'typing-dots';
          dots.innerHTML = '<span></span><span></span><span></span>';
          demoChat.appendChild(dots);
          later(() => { dots.remove(); pushBubble(item); i++; next(); }, 700);
        } else {
          pushBubble(item); i++; later(next, 500);
        }
      };
      next();
    };
    demoSteps.forEach((s, i) => on(s, 'click', () => renderDemoStep(i)));
    let demoAuto = 0;
    renderDemoStep(0);
    every(() => {
      demoAuto = (demoAuto + 1) % demoScript.length;
      renderDemoStep(demoAuto);
    }, 5500);
  }

  return () => {
    timers.forEach(id => { clearTimeout(id); clearInterval(id); });
    timers.clear();
    cleanups.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  };
}
