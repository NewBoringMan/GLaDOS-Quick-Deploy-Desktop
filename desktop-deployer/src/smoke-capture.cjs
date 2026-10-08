'use strict';

// DOM assertions can finish before Chromium presents the changed page. This
// helper is only for the isolated smoke window, whose background throttling is
// disabled at creation. It never shows or focuses the native window.
async function captureSmokePage(window, { label = 'smoke screenshot', timeoutMs = 5000 } = {}) {
  if (!process.argv.includes('--smoke-test')) throw new Error('Smoke capture requires isolated smoke mode');
  if (window.isDestroyed()) throw new Error(label + ': window was destroyed before capture');
  const deadline = Date.now() + timeoutMs;
  async function bounded(operation, stage) {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(label + ': timed out while ' + stage)), Math.max(1, deadline - Date.now()));
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  const viewport = await bounded(window.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))));
    return { x: 0, y: 0, width: innerWidth, height: innerHeight };
  })()`), 'waiting for fonts and rendered frames');
  if (!Number.isInteger(viewport?.width) || !Number.isInteger(viewport?.height) || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error(label + ': invalid rendered viewport');
  }
  // stayAwake only covers capture's system wake lock. The fonts/RAF barrier
  // above and smoke-only backgroundThrottling=false provide the paint wait.
  const image = await bounded(window.webContents.capturePage(viewport, { stayAwake: true }), 'capturing the rendered frame');
  if (image.isEmpty()) throw new Error(label + ': capture returned an empty image');
  return image;
}

module.exports = { captureSmokePage };
