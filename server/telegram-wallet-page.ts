export function getTelegramWalletPage(wcProjectId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Connect Wallet — BUILD4</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0f;
      color: #e2e2e8;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      max-width: 360px;
      width: 100%;
      text-align: center;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #fff;
    }
    .subtitle {
      font-size: 14px;
      color: #8888a0;
      margin-bottom: 32px;
      line-height: 1.4;
    }
    .wallet-btn {
      width: 100%;
      padding: 16px 20px;
      border-radius: 12px;
      border: 1px solid #2a2a3a;
      background: #14141f;
      color: #fff;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      transition: background 0.2s, border-color 0.2s;
    }
    .wallet-btn:hover { background: #1a1a2a; border-color: #9333ea; }
    .wallet-btn:active { background: #1f1f30; }
    .wallet-btn .icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .wallet-btn .label { flex: 1; text-align: left; }
    .wallet-btn .arrow { color: #666; font-size: 18px; }
    .or-divider {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 20px 0;
      color: #555;
      font-size: 12px;
    }
    .or-divider::before, .or-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #2a2a3a;
    }
    .paste-input {
      width: 100%;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid #2a2a3a;
      background: #14141f;
      color: #fff;
      font-size: 14px;
      font-family: monospace;
      outline: none;
      transition: border-color 0.2s;
    }
    .paste-input:focus { border-color: #9333ea; }
    .paste-input::placeholder { color: #555; }
    .submit-btn {
      width: 100%;
      padding: 14px;
      border-radius: 12px;
      border: none;
      background: #9333ea;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 12px;
      transition: background 0.2s;
    }
    .submit-btn:hover { background: #7c28c9; }
    .submit-btn:disabled { background: #3a3a4a; cursor: not-allowed; color: #888; }
    .status {
      margin-top: 20px;
      padding: 12px 16px;
      border-radius: 10px;
      font-size: 14px;
      display: none;
    }
    .status.success { display: block; background: #0a2a1a; border: 1px solid #1a5a3a; color: #4ade80; }
    .status.error { display: block; background: #2a0a0a; border: 1px solid #5a1a1a; color: #f87171; }
    .status.loading { display: block; background: #1a1a2a; border: 1px solid #3a3a5a; color: #a0a0c0; }
    .connected-addr {
      font-family: monospace;
      font-size: 13px;
      word-break: break-all;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Connect Wallet</h1>
    <p class="subtitle">Link your wallet to BUILD4 on Telegram</p>

    <button class="wallet-btn" id="btn-metamask" onclick="connectMetaMask()">
      <div class="icon" style="background:#f6851b;color:#fff;font-weight:700;font-size:14px;border-radius:8px;">MM</div>
      <div class="label">MetaMask</div>
      <div class="arrow">></div>
    </button>

    <button class="wallet-btn" id="btn-wc" onclick="connectWalletConnect()">
      <div class="icon" style="background:#3b99fc;color:#fff;font-weight:700;font-size:14px;border-radius:8px;">WC</div>
      <div class="label">WalletConnect</div>
      <div class="arrow">></div>
    </button>

    <div class="or-divider">or paste address</div>

    <input class="paste-input" id="manual-addr" type="text" placeholder="0x..." maxlength="42" oninput="validateManual()">
    <button class="submit-btn" id="btn-manual" disabled onclick="submitManual()">Connect</button>

    <div class="status" id="status"></div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.11.2/dist/index.umd.min.js"></script>
  <script>
    const WC_PROJECT_ID = "${wcProjectId}";
    const tg = window.Telegram?.WebApp;
    if (tg) tg.expand();

    function setStatus(msg, type) {
      const el = document.getElementById('status');
      el.className = 'status ' + type;
      el.innerHTML = msg;
    }

    function sendWalletToBot(address) {
      if (tg && tg.sendData) {
        tg.sendData(JSON.stringify({ wallet: address }));
      }
      setStatus('Connected!<div class="connected-addr">' + address + '</div><br>You can close this window.', 'success');
      if (tg) setTimeout(() => tg.close(), 1500);
    }

    function validateManual() {
      const addr = document.getElementById('manual-addr').value.trim();
      document.getElementById('btn-manual').disabled = !/^0x[a-fA-F0-9]{40}$/.test(addr);
    }

    function submitManual() {
      const addr = document.getElementById('manual-addr').value.trim();
      if (/^0x[a-fA-F0-9]{40}$/.test(addr)) {
        sendWalletToBot(addr.toLowerCase());
      }
    }

    async function connectMetaMask() {
      setStatus('Connecting...', 'loading');
      try {
        if (!window.ethereum) {
          setStatus('MetaMask not found. Use WalletConnect or paste your address.', 'error');
          return;
        }
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        if (accounts && accounts[0]) {
          sendWalletToBot(accounts[0].toLowerCase());
        } else {
          setStatus('No account returned. Try again.', 'error');
        }
      } catch (e) {
        setStatus('Connection rejected: ' + (e.message || e), 'error');
      }
    }

    async function connectWalletConnect() {
      setStatus('Opening WalletConnect...', 'loading');
      try {
        const EthereumProvider = window.EthereumProvider?.default || window.EthereumProvider;
        if (!EthereumProvider) {
          setStatus('WalletConnect failed to load. Paste your address instead.', 'error');
          return;
        }
        const provider = await EthereumProvider.init({
          projectId: WC_PROJECT_ID,
          chains: [56],
          optionalChains: [8453, 196, 1],
          showQrModal: true,
          metadata: {
            name: 'BUILD4',
            description: 'Decentralized AI Agent Infrastructure',
            url: 'https://build4.io',
            icons: ['https://build4.io/logo.png']
          }
        });
        await provider.enable();
        const accounts = provider.accounts;
        if (accounts && accounts[0]) {
          sendWalletToBot(accounts[0].toLowerCase());
        } else {
          setStatus('No account returned.', 'error');
        }
      } catch (e) {
        if (e.message?.includes('User rejected') || e.message?.includes('dismissed')) {
          setStatus('Connection cancelled.', 'error');
        } else {
          setStatus('WalletConnect error: ' + (e.message || e), 'error');
        }
      }
    }
  </script>
</body>
</html>`;
}
