#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const { resolveCursorProtoExtractDir } = require("./paths")

const sourceDir = path.join(resolveCursorProtoExtractDir(), "proto")
const destDir = path.resolve(process.cwd(), process.argv[2] || "proto")

if (!fs.existsSync(sourceDir)) {
  console.error(`Error: Extracted proto directory not found: ${sourceDir}`)
  process.exit(1)
}

fs.rmSync(destDir, { recursive: true, force: true })
fs.cpSync(sourceDir, destDir, { recursive: true })

console.log(
  `Copied extracted proto to ${path.relative(process.cwd(), destDir)}`
)
