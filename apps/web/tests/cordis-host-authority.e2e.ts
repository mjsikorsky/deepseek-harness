// Owner-local human interaction tier: actual built Client and native Host runner.
// The deployment policy is an explicit fixture; no model, identity or billing claim.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CordisHostActivationRequest } from '@deepseek-ai/dsh-cordis-host-runner'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/cordis-host-authority.md', import.meta.url))
const MODE = webSnapshotMode()
const SESSION = SessionId('cordis-host-authority-browser')
const HOST = 'return { name: "browser-authorized-host", apply(ctx) { ctx.provide("browserHostMarker", { value: 42 }) } }'

describe.skipIf(MODE === 'record')('web e2e: human Host activation retains deployment authority', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const revoked = new AbortController()
  const admitted: CordisHostActivationRequest[] = []
  let item: ReturnType<WebScaffold['ctx']['dynamicCordisRunner']['define']>
  let releases = 0
  let modelRequests = 0
  const diagnostics: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    scaffold.ctx.on('session/event', (_session, event) => {
      if (event.type === 'request/header') modelRequests++
    })
    scaffold.ctx.provide('cordisHostActivationPolicy', {
      async authorize(request) {
        admitted.push(request)
        return {
          expiresAt: Date.now() + 60_000,
          signal: revoked.signal,
          check() { revoked.signal.throwIfAborted() },
          release() { releases++ },
        }
      },
    })
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SESSION)
    item = scaffold.ctx.dynamicCordisRunner.define({
      sessionId: SESSION, plugin: { kind: 'new', idPrefix: 'human' },
      name: 'Authorized Host', purpose: 'Human-controlled native Host execution', code: { host: HOST },
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') diagnostics.push(message.text())
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('requires the actual panel gesture, evaluates exact Host source, and retracts on revocation', async () => {
    onTestFailed(async () => {
      console.error('Cordis browser diagnostics', { diagnostics, pageErrors: tripwire.pageErrors })
      console.error('Cordis boot inventory', await page.evaluate(() => {
        const boot = (window as Window & { __DSH_BOOT__?: { entries?: { name?: string; id?: string; inject?: string[] }[] } }).__DSH_BOOT__
        return boot?.entries?.filter(({ id }) => /cordis|api-remotes|client-modules/u.test(id ?? ''))
          .map(({ name, id, inject }) => ({ name, id, inject }))
      }))
      await saveFailureShot(page, 'web-e2e-cordis-host-authority')
    })
    await expect.poll(() => scaffold.ctx.agents.get(SESSION), { timeout: 15_000 }).toBeDefined()

    await page.getByRole('button', { name: 'Cordis plugins', exact: true }).click()
    const run = page.locator('[data-cordis-switch="run"]').first()
    await run.waitFor({ timeout: 15_000 })
    expect(admitted).toHaveLength(0)
    expect(scaffold.ctx.get('browserHostMarker')).toBeUndefined()
    await compareOrRefreshGolden(EXPECTED,
      await captureStableAria(page, '[data-cordis-panel]', scaffold.workspaceCwd), MODE)
    // This is the user's native panel action, not a model's pending request.
    // Pending-request arbitration is covered by native Host and Client tests.
    await run.click()
    await expect.poll((): unknown => scaffold.ctx.get('browserHostMarker')).toEqual({ value: 42 })
    expect(admitted).toHaveLength(1)
    expect(admitted[0]).toMatchObject({ sessionId: SESSION, pluginId: item.pluginId, packageId: item.packageId, hostCode: HOST })
    expect(Object.isFrozen(admitted[0])).toBe(true)
    await page.locator('[data-cordis-switch="stop"]').first().waitFor({ timeout: 15_000 })
    revoked.abort()
    await expect.poll((): unknown => scaffold.ctx.get('browserHostMarker')).toBeUndefined()
    await expect.poll(() => releases).toBe(1)
    expect(scaffold.ctx.dynamicCordisRunner.inventory()[0]?.activeRun).toBeUndefined()
    expect(modelRequests).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
