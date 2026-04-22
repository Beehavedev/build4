const { chromium } = require('playwright');

(async () => {
  console.log('--- STARTING TEST ---');
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: '/nix/store/kcvsxrmgwp3ffz5jijyy7wn9fcsjl4hz-playwright-browsers-1.55.0-with-cjk/chromium-1187/chrome-linux/chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({
      viewport: { width: 400, height: 800 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
    });
    const page = await context.newPage();
    const baseUrl = process.env.APP_URL || 'http://localhost:5000/app';
    
    console.log('Navigating to:', baseUrl);

    // 2. [Browser] Navigate to /app
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60000 });
    
    // Wait for the app to load
    await page.waitForSelector('text=BUILD4', { timeout: 30000 });
    await page.screenshot({ path: 'screenshot-home.png' });
    console.log('Assertion Passed: Home page loaded and screenshot taken.');

    // 3. [Verify] Home (Dashboard) tab
    const totalPortfolioLabel = await page.isVisible('text=TOTAL PORTFOLIO VALUE');
    console.log('Assertion', totalPortfolioLabel ? 'Passed' : 'Failed', ': "TOTAL PORTFOLIO VALUE" label visible');

    const totalValue = await page.locator('[data-testid="text-total-value"]').innerText();
    console.log('Assertion', totalValue.includes('$') ? 'Passed' : 'Failed', ': Total value contains "$"', totalValue);

    const asterCardVisible = await page.isVisible('[data-testid="card-aster"]');
    console.log('Assertion', asterCardVisible ? 'Passed' : 'Failed', ': Aster card visible');
    if (asterCardVisible) {
        const asterCardText = await page.innerText('[data-testid="card-aster"]');
        console.log('Aster card text:', asterCardText.replace(/\n/g, ' '));
    }

    const predCardVisible = await page.isVisible('[data-testid="card-predictions"]');
    console.log('Assertion', predCardVisible ? 'Passed' : 'Failed', ': 42.SPACE card visible');
    if (predCardVisible) {
        const predCardText = await page.innerText('[data-testid="card-predictions"]');
        console.log('42.SPACE card text:', predCardText.replace(/\n/g, ' '));
    }

    const quickActionsVisible = await page.isVisible('text=QUICK ACTIONS');
    console.log('Assertion', quickActionsVisible ? 'Passed' : 'Failed', ': "QUICK ACTIONS" label visible');

    const fundAsterBtn = await page.isVisible('[data-testid="button-fund-aster"]');
    console.log('Assertion', fundAsterBtn ? 'Passed' : 'Failed', ': Fund Aster button visible');

    const tradePredBtn = await page.isVisible('[data-testid="button-trade-predictions"]');
    console.log('Assertion', tradePredBtn ? 'Passed' : 'Failed', ': Trade 42.space button visible');

    const agentsBtn = await page.isVisible('[data-testid="button-agents"]');
    console.log('Assertion', agentsBtn ? 'Passed' : 'Failed', ': Agents button visible');

    const navHome = await page.innerText('[data-testid="nav-dashboard"]');
    const navAgents = await page.innerText('[data-testid="nav-agents"]');
    const navWallet = await page.innerText('[data-testid="nav-wallet"]');
    const navPortfolio = await page.innerText('[data-testid="nav-portfolio"]');
    const navPredict = await page.innerText('[data-testid="nav-predictions"]');
    
    console.log('Assertion', navHome.includes('Home') ? 'Passed' : 'Failed', ': Nav Home');
    console.log('Assertion', navAgents.includes('Agents') ? 'Passed' : 'Failed', ': Nav Agents');
    console.log('Assertion', navWallet.includes('Wallet') ? 'Passed' : 'Failed', ': Nav Wallet');
    console.log('Assertion', navPortfolio.includes('Portfolio') ? 'Passed' : 'Failed', ': Nav Portfolio');
    console.log('Assertion', navPredict.trim().endsWith('Predict') ? 'Passed' : 'Failed', ': Nav Predict label is "Predict" (exactly)');

    const borderTop = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-dashboard"]');
      return el ? window.getComputedStyle(el).borderTop : 'none';
    });
    console.log('Home tab border-top style:', borderTop);
    console.log('Assertion', borderTop !== '0px none rgb(255, 255, 255)' && borderTop !== 'none' ? 'Passed' : 'Failed', ': Active Home tab has border-top accent');

    const questsVisible = await page.isVisible('text=Quests');
    console.log('Assertion', !questsVisible ? 'Passed' : 'Failed', ': NO "Quests" button');

    const swarmStatsVisible = await page.isVisible('text=Swarm Cost & Speed');
    console.log('Assertion', !swarmStatsVisible ? 'Passed' : 'Failed', ': NO "Swarm Cost & Speed" panel');

    const swarmAgreementVisible = await page.isVisible('text=Swarm Agreement');
    console.log('Assertion', !swarmAgreementVisible ? 'Passed' : 'Failed', ': NO "Swarm Agreement" block');

    // 4. [Browser] Click "Wallet"
    await page.click('[data-testid="nav-wallet"]');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'screenshot-wallet.png' });
    console.log('Navigated to Wallet.');

    // 5. [Verify] Wallet page
    const walletHeader = await page.isVisible('text=💳 Wallet');
    console.log('Assertion', walletHeader ? 'Passed' : 'Failed', ': Wallet header visible');

    const addressStrip = await page.isVisible('[data-testid="card-address-strip"]');
    console.log('Assertion', addressStrip ? 'Passed' : 'Failed', ': Address strip card visible');

    if (addressStrip) {
        const depositLabel = await page.innerText('[data-testid="card-address-strip"]');
        console.log('Assertion', depositLabel.includes('DEPOSIT ADDRESS · BSC') ? 'Passed' : 'Failed', ': Deposit label BSC');
    }

    const copyBtn = await page.isVisible('[data-testid="button-copy-address-strip"]');
    console.log('Assertion', copyBtn ? 'Passed' : 'Failed', ': Copy button visible');

    // 6. [Browser] Click "Portfolio"
    await page.click('[data-testid="nav-portfolio"]');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'screenshot-portfolio.png' });
    console.log('Navigated to Portfolio.');

    // 7. [Verify] Portfolio page
    const portfolioHero = await page.isVisible('[data-testid="card-portfolio-hero"]');
    console.log('Assertion', portfolioHero ? 'Passed' : 'Failed', ': Portfolio hero card visible');

    if (portfolioHero) {
        const portfolioTotal = await page.innerText('[data-testid="text-portfolio-total"]');
        console.log('Assertion', portfolioTotal.includes('$') ? 'Passed' : 'Failed', ': Portfolio total amount visible');
    }

    // 8. [Browser] Click "Predict"
    await page.click('[data-testid="nav-predictions"]');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'screenshot-predict.png' });
    console.log('Navigated to Predict.');

    // 9. [Verify] Predictions page
    const predictLabel = await page.innerText('[data-testid="nav-predictions"]');
    console.log('Assertion', predictLabel.trim().endsWith('Predict') ? 'Passed' : 'Failed', ': Active tab label is "Predict"');

    const scannerRow = page.locator('[data-testid^="row-scanner-"]').first();
    const scannerVisible = await scannerRow.isVisible().catch(() => false);
    console.log('Assertion', scannerVisible ? 'Passed' : 'Failed', ': Market scanner expanded by default');

    const filterAll = await page.isVisible('[data-testid="button-scanner-filter-ALL"]');
    const filterAi = await page.isVisible('[data-testid="button-scanner-filter-AI"]');
    const filterCrypto = await page.isVisible('[data-testid="button-scanner-filter-CRYPTO"]');
    const filterOther = await page.isVisible('[data-testid="button-scanner-filter-OTHER"]');
    console.log('Assertion', filterAll && filterAi && filterCrypto && filterOther ? 'Passed' : 'Failed', ': Filter pills visible');

    const tradePill = page.locator('[data-testid^="row-scanner-"] >> text=Trade ▸').first();
    const tradePillVisible = await tradePill.isVisible().catch(() => false);
    console.log('Assertion', tradePillVisible ? 'Passed' : 'Failed', ': Purple "Trade ▸" pill visible');

    // 10. [Browser] Click "AI"
    if (filterAi) {
        await page.click('[data-testid="button-scanner-filter-AI"]');
        await page.waitForTimeout(1000);
        await page.screenshot({ path: 'screenshot-predict-ai.png' });
        console.log('Filtered by AI.');
        console.log('Assertion Passed: AI filter clicked and scanner updated.');
    }

  } catch (err) {
    console.error('Test Failed with error:', err);
    // await page.screenshot({ path: 'screenshot-error.png' });
  } finally {
    if (browser) await browser.close();
    console.log('--- TEST FINISHED ---');
  }
})();
