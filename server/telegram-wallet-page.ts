export function getTelegramWalletPage(wcProjectId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Connect Wallet — BUILD4</title>
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
    .deeplink-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px; }
    .deeplink-btn {
      padding: 12px 8px;
      border-radius: 10px;
      border: 1px solid #2a2a3a;
      background: #14141f;
      color: #fff;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      text-align: center;
      transition: background 0.2s, border-color 0.2s;
    }
    .deeplink-btn:hover { background: #1a1a2a; border-color: #9333ea; }
    .or-divider {
      display: flex; align-items: center; gap: 12px;
      margin: 20px 0; color: #4a4a6a; font-size: 13px;
    }
    .or-divider::before, .or-divider::after {
      content: ''; flex: 1; height: 1px; background: #1a1a2a;
    }
    .manual-section { margin-top: 0; }
    .manual-input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid #2a2a3a;
      background: #14141f;
      color: #fff;
      font-size: 14px;
      font-family: monospace;
      outline: none;
      margin-bottom: 8px;
    }
    .manual-input:focus { border-color: #9333ea; }
    .manual-input::placeholder { color: #4a4a6a; }
    .submit-btn {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      border: none;
      background: #9333ea;
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }
    .submit-btn:hover { background: #7c28c8; }
    .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .create-section { margin-top: 0; }
    .create-btn {
      width: 100%;
      padding: 16px 20px;
      border-radius: 12px;
      border: 1px solid #1a5a3a;
      background: #0a2a1a;
      color: #4ade80;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: 12px;
      transition: background 0.2s, border-color 0.2s;
    }
    .create-btn:hover { background: #0f3322; border-color: #2a7a5a; }
    .create-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .key-box {
      background: #14141f;
      border: 1px solid #5a1a1a;
      border-radius: 10px;
      padding: 14px;
      margin: 12px 0;
      text-align: left;
    }
    .key-box .key-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .key-box .key-label.warn { color: #f87171; }
    .key-box .key-label.info { color: #4ade80; }
    .key-box .key-value {
      font-family: monospace;
      font-size: 12px;
      word-break: break-all;
      color: #fff;
      line-height: 1.5;
      user-select: all;
    }
    .copy-btn {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid #2a2a3a;
      background: #1a1a2a;
      color: #a0a0c0;
      font-size: 12px;
      cursor: pointer;
      margin-top: 6px;
    }
    .copy-btn:hover { background: #2a2a3a; color: #fff; }
    .warning-text {
      font-size: 12px;
      color: #f87171;
      line-height: 1.4;
      margin: 8px 0;
      padding: 10px;
      background: #1a0a0a;
      border-radius: 8px;
      border: 1px solid #3a1a1a;
    }
    .confirm-save-btn {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      border: none;
      background: #4ade80;
      color: #000;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
    }
    .confirm-save-btn:hover { background: #3cc870; }
    #create-result { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Connect Wallet</h1>
    <p class="subtitle">Link your wallet to BUILD4 on Telegram</p>

    <button class="create-btn" id="btn-create" onclick="createNewWallet()">+ Create New Wallet</button>

    <div id="create-result">
      <div class="warning-text">Save your private key now. It will NOT be shown again. Anyone with this key controls your funds.</div>
      <div class="key-box">
        <div class="key-label warn">Private Key (save this!)</div>
        <div class="key-value" id="new-privkey"></div>
        <button class="copy-btn" onclick="copyKey('new-privkey')">Copy Private Key</button>
      </div>
      <div class="key-box">
        <div class="key-label info">Your Wallet Address</div>
        <div class="key-value" id="new-address"></div>
        <button class="copy-btn" onclick="copyKey('new-address')">Copy Address</button>
      </div>
      <button class="confirm-save-btn" id="btn-confirm-save" onclick="confirmSaved()">I Saved My Key — Connect Wallet</button>
    </div>

    <div class="or-divider" id="divider-existing">or connect existing wallet</div>

    <button class="wallet-btn" id="btn-metamask" onclick="openMetaMask()">
      <div class="icon" style="background:#f6851b;">MM</div>
      <div class="label">MetaMask</div>
      <div class="arrow">></div>
    </button>

    <button class="wallet-btn" id="btn-trust" onclick="openTrustWallet()">
      <div class="icon" style="background:#3375BB;">TW</div>
      <div class="label">Trust Wallet</div>
      <div class="arrow">></div>
    </button>

    <div class="or-divider">or paste address</div>

    <div class="manual-section">
      <input class="manual-input" id="addr-input" type="text" placeholder="0x..." maxlength="42" />
      <button class="submit-btn" id="btn-submit" onclick="submitAddress()">Connect</button>
    </div>

    <div class="status" id="status"></div>
  </div>

  <script>
    var WC_PROJECT_ID = "${wcProjectId}";
    var params = new URLSearchParams(window.location.search);
    var chatId = params.get('chatId');
    var pageUrl = window.location.href;

    function setStatus(msg, type) {
      var el = document.getElementById('status');
      el.className = 'status ' + type;
      el.innerHTML = msg;
    }

    function disableAll() {
      document.getElementById('btn-metamask').disabled = true;
      document.getElementById('btn-trust').disabled = true;
      document.getElementById('btn-submit').disabled = true;
      document.getElementById('btn-create').style.display = 'none';
      var confirmBtn = document.getElementById('btn-confirm-save');
      if (confirmBtn) confirmBtn.disabled = true;
    }

    function linkWallet(address) {
      setStatus('Linking wallet...', 'loading');
      if (chatId) {
        fetch('/api/web4/telegram-wallet/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: chatId, wallet: address })
        }).then(function(resp) {
          if (resp.ok) {
            setStatus('Wallet connected! Return to Telegram.<div class="addr">' + address + '</div>', 'success');
            disableAll();
          } else {
            setStatus('Failed to link. Try again.', 'error');
          }
        }).catch(function() {
          setStatus('Network error. Try again.', 'error');
        });
      } else {
        setStatus('Connected!<div class="addr">' + address + '</div>', 'success');
      }
    }

    function openMetaMask() {
      if (window.ethereum && window.ethereum.isMetaMask) {
        setStatus('Connecting MetaMask...', 'loading');
        window.ethereum.request({ method: 'eth_requestAccounts' }).then(function(accounts) {
          if (accounts && accounts[0]) {
            linkWallet(accounts[0].toLowerCase());
          } else {
            setStatus('No account returned.', 'error');
          }
        }).catch(function() {
          setStatus('Connection rejected.', 'error');
        });
        return;
      }
      var dappUrl = encodeURIComponent(window.location.host + window.location.pathname + window.location.search);
      window.location.href = 'https://metamask.app.link/dapp/' + dappUrl;
    }

    function openTrustWallet() {
      if (window.ethereum && window.ethereum.isTrust) {
        setStatus('Connecting Trust Wallet...', 'loading');
        window.ethereum.request({ method: 'eth_requestAccounts' }).then(function(accounts) {
          if (accounts && accounts[0]) {
            linkWallet(accounts[0].toLowerCase());
          } else {
            setStatus('No account returned.', 'error');
          }
        }).catch(function() {
          setStatus('Connection rejected.', 'error');
        });
        return;
      }
      var url = encodeURIComponent(pageUrl);
      window.location.href = 'trust://open_url?coin_id=60&url=' + url;
    }

    var createdAddress = null;

    async function createNewWallet() {
      try {
        document.getElementById('btn-create').disabled = true;
        setStatus('Generating wallet...', 'loading');

        var privKeyBytes = new Uint8Array(32);
        crypto.getRandomValues(privKeyBytes);
        var privKeyHex = '0x' + Array.from(privKeyBytes).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');

        var scriptEl = document.createElement('script');
        scriptEl.src = 'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js';
        scriptEl.onload = function() {
          try {
            var wallet = new ethers.Wallet(privKeyHex);
            createdAddress = wallet.address.toLowerCase();

            document.getElementById('new-privkey').textContent = privKeyHex;
            document.getElementById('new-address').textContent = wallet.address;
            document.getElementById('create-result').style.display = 'block';
            document.getElementById('btn-create').style.display = 'none';

            setStatus('', '');
          } catch(e) {
            setStatus('Failed to generate wallet: ' + e.message, 'error');
            document.getElementById('btn-create').disabled = false;
          }
        };
        scriptEl.onerror = function() {
          setStatus('Failed to load wallet library. Check your connection.', 'error');
          document.getElementById('btn-create').disabled = false;
        };
        document.head.appendChild(scriptEl);
      } catch(e) {
        setStatus('Error: ' + e.message, 'error');
        document.getElementById('btn-create').disabled = false;
      }
    }

    function copyKey(elementId) {
      var text = document.getElementById(elementId).textContent;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function() {
          var btn = document.querySelector('#' + elementId + ' + .copy-btn');
          if (btn) { btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = elementId === 'new-privkey' ? 'Copy Private Key' : 'Copy Address'; }, 2000); }
        });
      } else {
        var range = document.createRange();
        range.selectNode(document.getElementById(elementId));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
      }
    }

    function confirmSaved() {
      if (!createdAddress) return;
      linkWallet(createdAddress);
    }

    function submitAddress() {
      var addr = document.getElementById('addr-input').value.trim().toLowerCase();
      if (/^0x[a-f0-9]{40}$/.test(addr)) {
        linkWallet(addr);
      } else {
        setStatus('Invalid address. Must start with 0x followed by 40 hex characters.', 'error');
      }
    }

    if (window.ethereum) {
      window.ethereum.on('accountsChanged', function(accounts) {
        if (accounts && accounts[0]) {
          linkWallet(accounts[0].toLowerCase());
        }
      });

      if (window.ethereum.selectedAddress) {
        linkWallet(window.ethereum.selectedAddress.toLowerCase());
      }
    }
  </script>
</body>
</html>`;
}
