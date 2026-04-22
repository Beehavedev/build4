const fs = require('fs');
const path = require('path');

function checkFile(filePath, patterns) {
  if (!fs.existsSync(filePath)) {
    console.log(`File NOT FOUND: ${filePath}`);
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  console.log(`Checking ${filePath}:`);
  patterns.forEach(p => {
    const match = p.regex.test(content);
    console.log(`  [${match === !p.negate ? 'PASS' : 'FAIL'}] ${p.desc}`);
  });
}

const dashboardPatterns = [
  { regex: /TOTAL PORTFOLIO VALUE/i, desc: '"TOTAL PORTFOLIO VALUE" label' },
  { regex: /data-testid="text-total-value"/, desc: 'data-testid="text-total-value"' },
  { regex: /data-testid="card-aster"/, desc: 'data-testid="card-aster"' },
  { regex: /data-testid="card-predictions"/, desc: 'data-testid="card-predictions"' },
  { regex: /QUICK ACTIONS/i, desc: '"QUICK ACTIONS" label' },
  { regex: /data-testid="button-fund-aster"/, desc: 'Fund/Aster button' },
  { regex: /data-testid="button-trade-predictions"/, desc: 'Trade/42.space button' },
  { regex: /data-testid="button-agents"/, desc: 'Agents button' },
  { regex: /Quests/i, desc: 'NO "Quests" button', negate: true },
  { regex: /Swarm Cost & Speed/i, desc: 'NO "Swarm Cost & Speed"', negate: true },
  { regex: /Swarm Agreement/i, desc: 'NO "Swarm Agreement"', negate: true }
];

const appPatterns = [
  { regex: /id: 'dashboard', label: 'Home'/i, desc: 'Home nav label' },
  { regex: /id: 'agents', label: 'Agents'/i, desc: 'Agents nav label' },
  { regex: /id: 'wallet', label: 'Wallet'/i, desc: 'Wallet nav label' },
  { regex: /id: 'portfolio', label: 'Portfolio'/i, desc: 'Portfolio nav label' },
  { regex: /id: 'predictions', label: 'Predict'/i, desc: 'Predict nav label (NOT Predictions)' },
  { regex: /borderTop: active \? '2px solid var\(--purple\)'/i, desc: 'Purple top-border accent' }
];

const walletPatterns = [
  { regex: /💳 Wallet/i, desc: '"💳 Wallet" header' },
  { regex: /data-testid="card-address-strip"/, desc: 'data-testid="card-address-strip"' },
  { regex: /DEPOSIT ADDRESS · BSC/i, desc: '"DEPOSIT ADDRESS · BSC" label' },
  { regex: /data-testid="button-copy-address-strip"/, desc: 'data-testid="button-copy-address-strip"' }
];

const portfolioPatterns = [
  { regex: /data-testid="card-portfolio-hero"/, desc: 'data-testid="card-portfolio-hero"' },
  { regex: /Total Equity/i, desc: '"Total Equity" card' }
];

const predictionsPatterns = [
  { regex: /scannerOpen, setScannerOpen\] = useState\(true\)/, desc: 'Scanner expanded by default' },
  { regex: /data-testid="button-scanner-filter-ALL"/, desc: 'Filter ALL' },
  { regex: /data-testid="button-scanner-filter-AI"/, desc: 'Filter AI' },
  { regex: /data-testid="button-scanner-filter-CRYPTO"/, desc: 'Filter CRYPTO' },
  { regex: /data-testid="button-scanner-filter-OTHER"/, desc: 'Filter OTHER' },
  { regex: /Trade ▸/i, desc: 'Purple "Trade ▸" pill' }
];

checkFile('src/miniapp/src/pages/Dashboard.tsx', dashboardPatterns);
checkFile('src/miniapp/src/App.tsx', appPatterns);
checkFile('src/miniapp/src/pages/Wallet.tsx', walletPatterns);
checkFile('src/miniapp/src/pages/Portfolio.tsx', portfolioPatterns);
checkFile('src/miniapp/src/pages/Predictions.tsx', predictionsPatterns);
