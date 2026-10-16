const { validationResult } = require('express-validator');

/**
 * Put after a route's express-validator rules: answers 400 with the first
 * problem instead of letting invalid input reach the handler (where it would
 * surface as a 500 or be saved as-is).
 *
 *   router.post('/', protect, [body('name').notEmpty()], validate, handler)
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const list = errors.array();
  return res.status(400).json({
    status: 'error',
    message: list[0].msg === 'Invalid value' ? `Invalid ${list[0].path || list[0].param || 'value'}` : list[0].msg,
    errors: list
  });
};

module.exports = { validate };
