'use strict';

/**
 * Node.js implementation of `FileSystemPort` (`src/core/fs-port.js`).
 */

const fs = require('node:fs');
const path = require('node:path');

function createNodeFileSystemPort() {
  return Object.freeze({
    sep: path.sep,
    existsSync(targetPath) {
      return fs.existsSync(targetPath);
    },
    isFileSync(targetPath) {
      try {
        return fs.statSync(targetPath).isFile();
      } catch (_err) {
        return false;
      }
    },
    realpathSync(targetPath) {
      return fs.realpathSync(targetPath);
    },
    resolve(...parts) {
      return path.resolve(...parts);
    },
    normalize(p) {
      return path.normalize(p);
    },
    relative(from, to) {
      return path.relative(from, to);
    },
    isAbsolute(p) {
      return path.isAbsolute(p);
    },
    join(...parts) {
      return path.join(...parts);
    },
  });
}

module.exports = {
  createNodeFileSystemPort,
};
