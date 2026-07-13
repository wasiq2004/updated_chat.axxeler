// Public, unauthenticated runtime config the browser needs BEFORE login — e.g.
// the Facebook JS SDK app id + Embedded Signup config id so the "Login with
// Facebook" / "Sign in with Facebook" buttons can initialise. Only non-secret
// values are exposed here (never FB_APP_SECRET). Mounted before authMiddleware.

const { Router } = require('express');
const facebookAuth = require('../services/facebookAuth');

const router = Router();

router.get('/public-config', (req, res) => {
  res.json({
    facebook: facebookAuth.getPublicConfig(),
  });
});

module.exports = { router };
