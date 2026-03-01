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
    .container { max-width: 360px; width: 100%; text-align: center; }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #fff; }
    .subtitle { font-size: 14px; color: #8888a0; margin-bottom: 32px; line-height: 1.4; }
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
    .wallet-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .wallet-btn .icon {
      width: 32px; height: 32px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 700; color: #fff;
    }
    .wallet-btn .label { flex: 1; text-align: left; }
    .wallet-btn .arrow { color: #666; font-size: 18px; }
    .status {
      margin-top: 20px; padding: 12px 16px; border-radius: 10px;
      font-size: 14px; display: none;
    }
    .status.success { display: block; background: #0a2a1a; border: 1px solid #1a5a3a; color: #4ade80; }
    .status.error { display: block; background: #2a0a0a; border: 1px solid #5a1a1a; color: #f87171; }
    .status.loading { display: block; background: #1a1a2a; border: 1px solid #3a3a5a; color: #a0a0c0; }
    .addr { font-family: monospace; font-size: 13px; word-break: break-all; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Connect Wallet</h1>
    <p class="subtitle">Link your wallet to BUILD4 on Telegram</p>

    <button class="wallet-btn" id="btn-metamask" onclick="connectMetaMask()">
      <div class="icon" style="background:#f6851b;">MM</div>
      <div class="label">MetaMask</div>
      <div class="arrow">></div>
    </button>

    <button class="wallet-btn" id="btn-wc" onclick="connectWalletConnect()">
      <div class="icon" style="background:#3b99fc;">WC</div>
      <div class="label">WalletConnect</div>
      <div class="arrow">></div>
    </button>

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

    function done(address) {
      if (tg && tg.sendData) {
        tg.sendData(JSON.stringify({ wallet: address }));
      }
      setStatus('Connected!<div class="addr">' + address + '</div>', 'success');
      document.getElementById('btn-metamask').disabled = true;
      document.getElementById('btn-wc').disabled = true;
      if (tg) setTimeout(() => tg.close(), 1200);
    }

    async function connectMetaMask() {
      setStatus('Connecting...', 'loading');
      try {
        if (!window.ethereum) {
          setStatus('MetaMask not available. Use WalletConnect.', 'error');
          return;
        }
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        if (accounts && accounts[0]) {
          done(accounts[0].toLowerCase());
        } else {
          setStatus('No account returned.', 'error');
        }
      } catch (e) {
        setStatus('Rejected.', 'error');
      }
    }

    async function connectWalletConnect() {
      setStatus('Opening WalletConnect...', 'loading');
      try {
        const EP = window.EthereumProvider?.default || window.EthereumProvider;
        if (!EP) { setStatus('WalletConnect failed to load.', 'error'); return; }
        const provider = await EP.init({
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
        if (provider.accounts && provider.accounts[0]) {
          done(provider.accounts[0].toLowerCase());
        } else {
          setStatus('No account returned.', 'error');
        }
      } catch (e) {
        setStatus('Cancelled.', 'error');
      }
    }
  </script>
</body>
</html>`;
}
