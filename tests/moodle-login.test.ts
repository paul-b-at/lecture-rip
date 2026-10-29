import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { MoodleSession } from '../src/moodle'

test('JKU Access login uses current controls and registers the return wait before clicking', async () => {
  const originalUser = process.env.JKU_USER, originalPass = process.env.JKU_PASS
  process.env.JKU_USER = 'fixture-user'; process.env.JKU_PASS = 'fixture-password'
  let authenticated = false, waiting = false, resolveReturn: () => void = () => {}
  const calls: string[] = []
  const page = {
    goto: async () => {},
    url: () => 'https://moodle.jku.at/my/',
    evaluate: async () => ({ hasSessionKey: true, userId: authenticated ? 200 : 1, hasLoginLink: !authenticated }),
    close: async () => { throw new Error('Successful login must keep the page open') },
    locator: (selector: string) => {
      assert.ok(['#Ecom_User_ID', '#Ecom_Password', '#donotcache', '#loginButton2'].includes(selector))
      return {
        waitFor: async (options: any) => { assert.equal(selector, '#Ecom_User_ID'); assert.deepEqual(options, { state: 'visible', timeout: 60_000 }); calls.push('visible') },
        fill: async (value: string) => { assert.equal(value, selector === '#Ecom_User_ID' ? 'fixture-user' : 'fixture-password'); calls.push(selector) },
        isVisible: async () => false,
        click: async () => { assert.equal(selector, '#loginButton2'); assert.equal(waiting, true); authenticated = true; calls.push('click'); resolveReturn() },
      }
    },
    waitForURL: (predicate: (url: URL) => boolean, options: any) => {
      assert.equal(predicate(new URL('https://moodle.jku.at/my/')), true)
      assert.equal(predicate(new URL('https://access.jku.at/nidp/saml2/sso')), false)
      assert.equal(predicate(new URL('https://moodle.jku.at.attacker.invalid/')), false)
      assert.deepEqual(options, { timeout: 60_000, waitUntil: 'domcontentloaded' })
      waiting = true
      return new Promise<void>(resolve => { resolveReturn = resolve })
    },
  }
  try {
    const session = await MoodleSession.open({ newPage: async () => page } as any)
    assert.equal(session.page, page)
    assert.deepEqual(calls, ['visible', '#Ecom_User_ID', '#Ecom_Password', 'click'])
  } finally {
    if (originalUser === undefined) delete process.env.JKU_USER; else process.env.JKU_USER = originalUser
    if (originalPass === undefined) delete process.env.JKU_PASS; else process.env.JKU_PASS = originalPass
  }
})

test('an existing authenticated Moodle session skips login', async () => {
  const page = {
    goto: async () => {}, url: () => 'https://moodle.jku.at/my/',
    evaluate: async () => ({ hasSessionKey: true, userId: 200, hasLoginLink: false }),
    locator: () => { throw new Error('Login form should not be accessed') },
  }
  assert.equal((await MoodleSession.open({ newPage: async () => page } as any)).page, page)
})
