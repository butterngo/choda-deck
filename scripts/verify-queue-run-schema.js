#!/usr/bin/env node
'use strict'
const fs = require('fs')

const REQUIRED_FIELDS = [
  'mcp_tokens_per_spawn',
  'tool_schema_tokens_total',
  'mcp_profile_used',
  'cache_read_input_tokens',
  'cache_hit_estimate',
  'spawn_mode',
  'task_outcome_per_mcp_profile',
  'files_touched_count',
  'new_files_created_count'
]

const filePath = process.argv[2]
if (!filePath) {
  process.stderr.write('Usage: node verify-queue-run-schema.js <path-to-queue-run.json>\n')
  process.exit(1)
}

let data
try {
  data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
} catch (err) {
  process.stderr.write(`Failed to parse JSON: ${err.message}\n`)
  process.exit(1)
}

const missing = []
const invalid = []

for (const field of REQUIRED_FIELDS) {
  if (!(field in data)) {
    missing.push(field)
    continue
  }
  const v = data[field]
  switch (field) {
    case 'mcp_tokens_per_spawn':
    case 'tool_schema_tokens_total':
    case 'cache_read_input_tokens':
    case 'files_touched_count':
    case 'new_files_created_count':
      if (typeof v !== 'number') invalid.push(`${field}: expected number, got ${typeof v}`)
      break
    case 'mcp_profile_used':
    case 'spawn_mode':
      if (typeof v !== 'string') invalid.push(`${field}: expected string, got ${typeof v}`)
      break
    case 'cache_hit_estimate':
      if (v !== null && typeof v !== 'number') {
        invalid.push(`${field}: expected number | null, got ${typeof v}`)
      } else if (typeof v === 'number' && (v < 0 || v > 1)) {
        invalid.push(`${field}: value ${v} out of range [0, 1]`)
      }
      break
    case 'task_outcome_per_mcp_profile':
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        invalid.push(`${field}: expected object, got ${Array.isArray(v) ? 'array' : typeof v}`)
      }
      break
  }
}

if (missing.length || invalid.length) {
  if (missing.length) process.stderr.write(`Missing fields: ${missing.join(', ')}\n`)
  invalid.forEach((e) => process.stderr.write(`Invalid: ${e}\n`))
  process.exit(1)
}

process.stdout.write(`OK: ${filePath} passes schema validation (9 metrics fields present)\n`)
