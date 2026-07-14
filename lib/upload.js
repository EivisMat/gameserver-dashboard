'use strict';

/**
 * Shared multer instance for file uploads. Uses disk-backed temp storage so
 * multi-GB world uploads stream through to disk instead of being buffered whole
 * in memory (which would also hit Node's ~4 GB Buffer ceiling). Handlers are
 * responsible for unlinking req.file(s).path once done.
 */

const os = require('os');
const multer = require('multer');

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

module.exports = { upload };
