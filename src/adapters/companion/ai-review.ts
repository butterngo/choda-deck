// The review contract: the types every provider answers in, and the one error
// class the route knows how to turn into a status.
//
// This file used to hold an Anthropic implementation as well, written for
// TASK-1843. TASK-1856 pointed the route at Azure AI Foundry and left that code
// uncalled; Butter then asked for it to go, so it is gone rather than kept as
// scenery. Dead code nothing calls is a claim about the future nobody verified,
// and it makes every later reader ask which path is live.
//
// What remains is deliberately provider-agnostic, which is why removing an
// implementation left it intact. `notes` with an optional quote is what a
// reviewer produces whoever answers, and the error kinds are the failures a
// reader acts on differently — a rate limit means wait, a network fault means
// check the network rather than the key. A third provider would import from
// here and implement its own request, exactly as azure-review.ts does.
//
// Two things moved rather than died, and are worth knowing where to find:
//
//   * The key file (ai-key.txt, mode 0600 beside bridge-token.txt) and its
//     minting from CHODA_AI_KEY now live in azure-review.ts. The reasoning
//     TASK-1843 recorded still holds: a process environment is inherited by
//     every child the adapter spawns and is readable by anything that can list
//     the process, so the environment is how a key ARRIVES and the file is
//     where it LIVES.
//   * The system prompt — report only judgements a schema cannot make, never
//     repeat what a deterministic check already answers — is in azure-review.ts
//     alongside the request it belongs to.

/**
 * One kind per failure a caller can act on differently. `no_key` is not an
 * error in the usual sense — it is the normal state of a machine that never
 * configured a model, and the route turns it into a 501 rather than a 5xx.
 */
export type AiErrorKind =
  | 'no_key'
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'refusal'
  // TASK-1856 — a reasoning deployment can answer HTTP 200 with an EMPTY body:
  // it spends the whole token budget thinking and has nothing left to write
  // with. That is not a parse failure, and calling it one sends the reader to
  // debug a prompt when the fix is a number.
  | 'budget'
  | 'parse'
  | 'api'

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    /** Present only for rate limits the provider told us how long to wait for. */
    readonly retryAfter: string | null = null
  ) {
    super(message)
    this.name = 'AiError'
  }
}

export interface ReviewNote {
  checkId: string
  message: string
  /** The span the note is about, quoted from the submitted text, or null. */
  quote: string | null
}

/**
 * The injectable fetch the route threads through to whichever provider it calls.
 * Deliberately looser than the DOM `fetch` type so a test can supply a plain
 * function without reconstructing a Request — every failure path has to be
 * testable without a network, because a test that needs the internet is a test
 * nobody runs.
 */
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<Response>
