// TASK-3156 — the credential-page matcher.
import { describe, it, expect } from 'vitest'
import { credentialPageRule } from './capture-sensitive-pages'

describe('credentialPageRule (TASK-3156)', () => {
  it('matches the repo runner registration page and not its parent', () => {
    expect(credentialPageRule('https://github.com/o/r/settings/actions/runners/new')).not.toBeNull()
    expect(credentialPageRule('https://github.com/o/r/settings/actions')).toBeNull()
  })

  it.each([
    ['org runners/new', 'https://github.com/organizations/acme/settings/actions/runners/new'],
    ['settings/tokens', 'https://github.com/settings/tokens?type=beta'],
    ['settings/keys', 'https://github.com/settings/keys'],
    ['settings/ssh/keys', 'https://github.com/settings/ssh/keys'],
    ['repo settings/keys', 'https://github.com/o/r/settings/keys'],
    ['GCP apis/credentials', 'https://console.cloud.google.com/apis/credentials?project=p'],
    [
      'AWS security_credentials',
      'https://us-east-1.console.aws.amazon.com/iam/home?region=us-east-1#/security_credentials'
    ]
  ])('matches %s', (_label, url) => {
    expect(credentialPageRule(url)).toEqual(expect.any(String))
  })

  it('returns null for an ordinary page', () => {
    expect(credentialPageRule('https://example.com/page')).toBeNull()
    expect(credentialPageRule('https://github.com/o/r/pull/1')).toBeNull()
  })
})
