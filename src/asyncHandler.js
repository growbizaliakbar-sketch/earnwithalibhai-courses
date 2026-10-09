// Async route/middleware wrapper for Express 4: forwards rejected promises to
// the error-handling middleware instead of leaving the request hanging.
//
// Two helpers:
//   ah(fn)            — wrap a single middleware/handler
//   wrapRouter(router)— wrap every handler + middleware on an Express router
//                      (call once, before module.exports)
'use strict';

function ah(fn) {
  return (req, res, next) => {
    let result;
    try {
      result = fn(req, res, next);
    } catch (err) {
      next(err);
      return;
    }
    if (result && typeof result.catch === 'function') result.catch(next);
  };
}

function wrapRouter(router) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      for (const l of layer.route.stack || []) {
        if (typeof l.handle === 'function') l.handle = ah(l.handle);
      }
    } else if (typeof layer.handle === 'function' && layer.name !== 'router') {
      // router.use(...) middleware (e.g. requireAdmin)
      layer.handle = ah(layer.handle);
    }
  }
  return router;
}

module.exports = { ah, wrapRouter };
