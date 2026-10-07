// An existing installation can be reused without downloading a browser or package.
export const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
export const launchOptions = {
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
  args: ['--autoplay-policy=no-user-gesture-required'],
};
