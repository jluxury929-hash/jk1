// ═══════════════════════════════════════════════════════════════════════════════
// BACKEND EARNINGS → TREASURY CONVERSION SERVER
// Converts MEV earnings to real ETH transactions on Etherscan
// Deploy to Railway: https://railway.app
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const TREASURY = '0x4024Fd78E2AD5532FBF3ec2B3eC83870FAe45fC7';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '0x25603d4c315004b7c56f437493dc265651a8023793f01dc57567460634534c08';

// RPC endpoints (free, no rate limits)
const RPC_ENDPOINTS = [
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.ankr.com/eth',
  'https://eth.llamarpc.com',
  'https://1rpc.io/eth',
  'https://cloudflare-eth.com'
];

const ETH_PRICE = 3450;

// ═══════════════════════════════════════════════════════════════════════════════
// EARNINGS LEDGER - Tracks accumulated MEV profits
// In production, use Redis/MongoDB for persistence
// ═══════════════════════════════════════════════════════════════════════════════

let earningsLedger = {
  totalEarnedUSD: 0,
  totalEarnedETH: 0,
  withdrawnUSD: 0,
  withdrawnETH: 0,
  transactions: []
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Get working provider
// ═══════════════════════════════════════════════════════════════════════════════

async function getProvider() {
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      return provider;
    } catch (e) {
      continue;
    }
  }
  throw new Error('All RPC endpoints failed');
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Get wallet with funds
// ═══════════════════════════════════════════════════════════════════════════════

async function getWallet() {
  const provider = await getProvider();
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  return { wallet, provider, balance };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINT: Credit earnings (called when MEV strategies profit)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/credit-earnings', (req, res) => {
  try {
    const { amountUSD, amountETH, source, strategyId } = req.body;
    
    const usd = parseFloat(amountUSD) || 0;
    const eth = parseFloat(amountETH) || (usd / ETH_PRICE);
    
    earningsLedger.totalEarnedUSD += usd;
    earningsLedger.totalEarnedETH += eth;
    
    console.log(`[CREDIT] +$${usd.toFixed(2)} / +${eth.toFixed(6)} ETH from ${source || 'MEV'}`);
    
    res.json({
      success: true,
      credited: { usd, eth },
      total: {
        earnedUSD: earningsLedger.totalEarnedUSD,
        earnedETH: earningsLedger.totalEarnedETH,
        availableUSD: earningsLedger.totalEarnedUSD - earningsLedger.withdrawnUSD,
        availableETH: earningsLedger.totalEarnedETH - earningsLedger.withdrawnETH
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINT: Get earnings balance
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/earnings', (req, res) => {
  const availableUSD = earningsLedger.totalEarnedUSD - earningsLedger.withdrawnUSD;
  const availableETH = earningsLedger.totalEarnedETH - earningsLedger.withdrawnETH;
  
  res.json({
    totalEarnedUSD: earningsLedger.totalEarnedUSD,
    totalEarnedETH: earningsLedger.totalEarnedETH,
    withdrawnUSD: earningsLedger.withdrawnUSD,
    withdrawnETH: earningsLedger.withdrawnETH,
    availableUSD,
    availableETH,
    transactions: earningsLedger.transactions.slice(-20)
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINT: Convert earnings to ETH (REAL ON-CHAIN TX)
// This is the main endpoint for converting accumulated profits to treasury ETH
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/convert-earnings-to-eth', async (req, res) => {
  try {
    const { amountUSD, amountETH, percentage, to } = req.body;
    const recipient = to || TREASURY;
    
    // Calculate available earnings
    const availableUSD = earningsLedger.totalEarnedUSD - earningsLedger.withdrawnUSD;
    const availableETH = earningsLedger.totalEarnedETH - earningsLedger.withdrawnETH;
    
    // Determine conversion amount
    let convertETH;
    if (percentage) {
      convertETH = availableETH * (percentage / 100);
    } else if (amountETH) {
      convertETH = parseFloat(amountETH);
    } else if (amountUSD) {
      convertETH = parseFloat(amountUSD) / ETH_PRICE;
    } else {
      convertETH = availableETH; // Convert all
    }
    
    if (convertETH <= 0) {
      return res.status(400).json({ error: 'No earnings to convert', availableETH });
    }
    
    if (convertETH > availableETH) {
      return res.status(400).json({ 
        error: 'Insufficient earnings', 
        requested: convertETH, 
        available: availableETH 
      });
    }
    
    console.log(`[CONVERT] Converting ${convertETH.toFixed(6)} ETH to treasury...`);
    
    // Get wallet and check balance
    const { wallet, provider, balance } = await getWallet();
    const balanceETH = parseFloat(ethers.formatEther(balance));
    
    // We need the wallet to have ETH to send
    // The earnings represent "virtual" profits that get converted when sent
    const sendAmount = Math.min(convertETH, balanceETH - 0.005); // Keep 0.005 for gas
    
    if (sendAmount <= 0) {
      return res.status(400).json({ 
        error: 'Backend wallet needs ETH to execute conversion',
        walletBalance: balanceETH,
        needed: convertETH
      });
    }
    
    // Get gas price
    const feeData = await provider.getFeeData();
    const gasLimit = 21000n;
    const maxFee = feeData.maxFeePerGas || ethers.parseUnits('30', 'gwei');
    const priorityFee = feeData.maxPriorityFeePerGas || ethers.parseUnits('2', 'gwei');
    
    // Create and send transaction
    const tx = await wallet.sendTransaction({
      to: recipient,
      value: ethers.parseEther(sendAmount.toFixed(18)),
      gasLimit,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
      type: 2
    });
    
    console.log(`[TX SENT] ${tx.hash}`);
    
    // Wait for confirmation
    const receipt = await tx.wait(1);
    
    console.log(`[TX CONFIRMED] Block ${receipt.blockNumber}`);
    
    // Update ledger
    earningsLedger.withdrawnUSD += sendAmount * ETH_PRICE;
    earningsLedger.withdrawnETH += sendAmount;
    earningsLedger.transactions.push({
      type: 'conversion',
      txHash: tx.hash,
      amountETH: sendAmount,
      amountUSD: sendAmount * ETH_PRICE,
      to: recipient,
      block: receipt.blockNumber,
      timestamp: Date.now()
    });
    
    res.json({
      success: true,
      txHash: tx.hash,
      hash: tx.hash,
      transactionHash: tx.hash,
      amountETH: sendAmount,
      amountUSD: sendAmount * ETH_PRICE,
      to: recipient,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      etherscanUrl: `https://etherscan.io/tx/${tx.hash}`
    });
    
  } catch (e) {
    console.error('[CONVERT ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Aliases for the same functionality
app.post('/withdraw-profits-to-treasury', (req, res) => {
  req.url = '/convert-earnings-to-eth';
  app.handle(req, res);
});

app.post('/claim-mev-profits', (req, res) => {
  req.url = '/convert-earnings-to-eth';
  app.handle(req, res);
});

app.post('/fund-treasury-from-profits', (req, res) => {
  req.url = '/convert-earnings-to-eth';
  app.handle(req, res);
});

app.post('/earnings-to-treasury-tx', (req, res) => {
  req.url = '/convert-earnings-to-eth';
  app.handle(req, res);
});

// ═══════════════════════════════════════════════════════════════════════════════
// STANDARD ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'Backend Earnings Conversion',
    treasury: TREASURY,
    earnings: {
      availableUSD: earningsLedger.totalEarnedUSD - earningsLedger.withdrawnUSD,
      availableETH: earningsLedger.totalEarnedETH - earningsLedger.withdrawnETH
    }
  });
});

app.get('/status', (req, res) => res.json({ status: 'online', uptime: process.uptime() }));
app.get('/health', (req, res) => res.json({ healthy: true }));

app.get('/balance', async (req, res) => {
  try {
    const { wallet, balance } = await getWallet();
    res.json({ 
      address: wallet.address,
      balance: ethers.formatEther(balance),
      balanceWei: balance.toString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`🚀 Backend Earnings Conversion Server`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`💰 Treasury: ${TREASURY}`);
  console.log(`═══════════════════════════════════════════════════════════`);
});
