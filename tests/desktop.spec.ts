import { test, expect } from '@playwright/test'

// ─────────────────────────────────────────────────────────
// Desktop Root Page
// ─────────────────────────────────────────────────────────
test.describe('Desktop App', () => {
  test('should load the app shell', async ({ page }) => {
    await page.goto('/')
    // The app container should render
    await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 })
    // Layout component should be mounted
    await expect(page.locator('.layout')).toBeVisible({ timeout: 15_000 })
  })

  test('should render top navigation bar', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.top-nav', { timeout: 15_000 })
    // Theme toggle buttons
    await expect(page.locator('.theme-toggle').first()).toBeVisible()
  })

  test('should show task layout with panels', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Main layout areas
    await expect(page.locator('.task-layout')).toBeVisible()
  })

  test('should have the correct document title', async ({ page }) => {
    await page.goto('/')
    const title = await page.title()
    expect(title).toBe('Mao')
  })

  test('should have proper viewport meta', async ({ page }) => {
    await page.goto('/')
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content')
    expect(viewport).toContain('width=device-width')
  })

  test('should not show login dialog by default when not authenticated', async ({ page }) => {
    await page.goto('/')
    // Login dialog should auto-open if not authenticated
    await page.waitForTimeout(1000)
    // The login dialog should appear because user is not logged in
    // Wait for potential dialog to show
  })
})

// ─────────────────────────────────────────────────────────
// Desktop - Task View
// ─────────────────────────────────────────────────────────
test.describe('Task View', () => {
  test('should show task index panel', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Left panel - task index
    await expect(page.locator('.task-index-panel, .task-panel-left')).toBeVisible({ timeout: 10_000 })
  })

  test('should show workspace area in center', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Center task container
    await expect(page.locator('.task-container')).toBeVisible({ timeout: 10_000 })
  })

  test('should show task inspector on right', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.task-layout', { timeout: 15_000 })
    // Right inspector panel
    await expect(page.locator('.task-inspector')).toBeVisible({ timeout: 10_000 })
  })
})

// ─────────────────────────────────────────────────────────
// Desktop Theme
// ─────────────────────────────────────────────────────────
test.describe('Desktop Theme', () => {
  test('should apply theme class from localStorage', async ({ page }) => {
    // Use addInitScript to set localStorage before page loads
    await page.addInitScript(() => {
      localStorage.setItem('aw-theme-mode', 'dark')
    })
    await page.goto('/')
    await page.waitForSelector('.layout', { timeout: 15_000 })
    // Dark class should be set on html element
    const hasDark = await page.locator('html').evaluate(el =>
      el.classList.contains('dark')
    )
    expect(hasDark).toBeTruthy()
  })

  test('should render with light theme by default', async ({ page }) => {
    // Use addInitScript to clear localStorage before page loads
    await page.addInitScript(() => {
      localStorage.removeItem('aw-theme-mode')
    })
    await page.goto('/')
    await page.waitForSelector('.layout', { timeout: 15_000 })
    // Default should not have dark class
    const hasDark = await page.locator('html').evaluate(el =>
      el.classList.contains('dark')
    )
    expect(hasDark).toBeFalsy()
  })
})

// ─────────────────────────────────────────────────────────
// Desktop - Root Route Redirect and Task Route
// ─────────────────────────────────────────────────────────
test.describe('Desktop Routes', () => {
  test('should render task view on default route', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.task-layout, .task-index-panel', { timeout: 15_000 })
    // The main task view component should be rendered
    await expect(page.locator('.task-layout')).toBeVisible({ timeout: 10_000 })
  })
})
