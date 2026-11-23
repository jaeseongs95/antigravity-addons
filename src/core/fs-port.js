'use strict';

/**
 * Runtime-neutral FileSystem & Path Port (SOLID DIP / ISP).
 *
 * Allows `src/core/manifest-validator.js` to enforce directory & symlink confinement
 * without directly importing `node:fs` or `node:path`.
 */

const FILE_SYSTEM_PORT_METHODS = Object.freeze([
  'existsSync',
  'isFileSync',
  'realpathSync',
  'resolve',
  'normalize',
  'relative',
  'isAbsolute',
  'join',
]);

function assertFileSystemPort(port) {
  if (!port || typeof port !== 'object') {
    throw new Error('ERR_FS_PORT:INVALID_PORT');
  }
  for (const method of FILE_SYSTEM_PORT_METHODS) {
    if (typeof port[method] !== 'function') {
      throw new Error(`ERR_FS_PORT:MISSING_METHOD:${method}`);
    }
  }
  if (typeof port.sep !== 'string' || !port.sep) {
    throw new Error('ERR_FS_PORT:MISSING_PROP:sep');
  }
  return port;
}

module.exports = {
  FILE_SYSTEM_PORT_METHODS,
  assertFileSystemPort,
};
