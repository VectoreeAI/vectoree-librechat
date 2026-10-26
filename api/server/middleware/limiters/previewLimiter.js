const rateLimit = require('express-rate-limit');
const { limiterCache, removePorts } = require('@librechat/api');

const windowMs = 5 * 60 * 1000;
const max = 10;

const previewLimiter = rateLimit({
  windowMs,
  max,
  keyGenerator: removePorts,
  store: limiterCache('preview_limiter'),
  handler: (_req, res) => {
    res.status(429).json({ message: 'Too many preview attempts. Try again in a few minutes.' });
  },
});

module.exports = previewLimiter;
