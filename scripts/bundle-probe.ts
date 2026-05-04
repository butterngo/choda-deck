// Measures bundle cost of sqlite-vec + @huggingface/transformers when wired
// into the MCP server bundle. Probe file only; not loaded by runtime.

import * as sqliteVec from 'sqlite-vec'
import { pipeline } from '@huggingface/transformers'

export const probe = { sqliteVec, pipeline }
