#!/usr/bin/env node

const os = require("os")
const path = require("path")
const platform = require("../lib/platform")

function resolveCursorProtoExtractDir() {
  const override = platform.expandHomeDir(process.env.CURSOR_PROTO_EXTRACT_DIR)
  return override || path.join(os.tmpdir(), "cursor_proto_extract")
}

function resolveCursorAppRoot() {
  const override = platform.expandHomeDir(process.env.CURSOR_APP_ROOT)
  if (override) return override

  const workbenchPath = platform.cursorWorkbenchPath()
  if (!workbenchPath) return null

  return path.dirname(path.dirname(path.dirname(path.dirname(workbenchPath))))
}

module.exports = {
  resolveCursorAppRoot,
  resolveCursorProtoExtractDir,
}
