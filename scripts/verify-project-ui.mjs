import fs from 'node:fs/promises';
const { chromium } = await import(process.env.KF_PLAYWRIGHT || 'playwright');
const directory = '.test-output/ui-preview'; await fs.mkdir(directory, { recursive: true });
const css = await fs.readFile('styles.css', 'utf8'), js = await fs.readFile(directory + '/app.js', 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.KF_BROWSER ? { channel: process.env.KF_BROWSER } : {}) });
try {
  for (const [name, width, screen, theme, pane] of [['projects-light', 1440, 'projects', '', ''], ['projects-dark', 1440, 'projects', 'dark', 'week'], ['projects-narrow', 560, 'projects', '', 'week'], ['workbench-narrow', 360, 'import', '', '']]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 }); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px system-ui}.workspace-leaf-content>.view-content{background:#fff}button,input,select,textarea{box-sizing:border-box;font:inherit}button{cursor:pointer}textarea{resize:vertical}.preview-note{padding:8px 24px;font:12px system-ui;background:#eee8f8;color:#57416e}${css}</style><body><div class="preview-note">界面验收 · 合成示例数据，不连接 AI 服务</div><div class="workspace-leaf-content"><main id="app" class="view-content"></main></div></body></html>` }));
    await page.goto(`http://knowledge-flow.test/?screen=${screen}&theme=${theme}&pane=${pane}`); await page.addScriptTag({ content: js }); await page.waitForSelector(screen === 'projects' ? '.kf-project-main' : '.kf-root');
    await page.screenshot({ path: `${directory}/${name}.png` });
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, background: getComputedStyle(document.querySelector('.kf-project-root,.kf-root')).backgroundColor, columns: document.querySelector('.kf-project-layout') ? getComputedStyle(document.querySelector('.kf-project-layout')).gridTemplateColumns : undefined }));
    if (errors.length || layout.overflow || layout.background !== (theme === 'dark' ? 'rgb(33, 30, 43)' : 'rgb(245, 243, 251)')) throw new Error(JSON.stringify({ name, errors, layout }));
    if (name === 'projects-dark') {
      const title = '复盘本周推进与待办', row = page.locator('.kf-project-task').filter({ hasText: title });
      const slot = page.locator('.kf-week-slot').first(), day = (await slot.getAttribute('aria-label')).split(' ')[0];
      await row.dragTo(slot);
      await page.getByRole('button', { name: '任务列表', exact: true }).click();
      await page.locator('.kf-project-task').filter({ hasText: title }).getByText(`执行：${day}`, { exact: false }).waitFor();
    }
    console.log(JSON.stringify({ name, width, ...layout, passed: true })); await page.close();
  }
} finally { await browser.close(); }
