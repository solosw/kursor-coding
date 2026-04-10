#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const targets = process.argv.slice(2)

if (targets.length === 0) {
  console.error("Usage: node scripts/rm-paths.js <path> [more-paths...]")
  process.exit(1)
}

for (const target of targets) {
  const resolved = path.resolve(process.cwd(), target)
  fs.rmSync(resolved, { recursive: true, force: true })
  console.log(`removed ${path.relative(process.cwd(), resolved) || "."}`)
}
