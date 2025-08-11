require('dotenv').config();
const { ethers } = require('ethers');

// Environment variable checks
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MONITORED_ADDRESS = process.env.MONITORED_ADDRESS?.toLowerCase();
const DESTINATION_ADDRESS = process.env.DESTINATION_ADDRESS;
const INFURA_WSS = process.env.INFURA_WSS;

if (!PRIVATE_KEY || !MONITORED_ADDRESS || !DESTINATION_ADDRESS || !INFURA_WSS) {
  console.error("❌ Please set all environment variables.");
  process.exit(1);
}

// Initialize provider and wallet
const provider = new ethers.providers.WebSocketProvider(INFURA_WSS);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Queues and flags
const pendingQueue = [];
const forwardQueue = [];
let processingPending = false;
let processingForward = false;
let lastPendingProcessTime = 0;

// Safe transaction retrieval with retries and exponential backoff
async function safeGetTransaction(provider, txHash, retries = 5, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    try {
      const tx = await provider.getTransaction(txHash);
      if (tx) return tx;
    } catch (err) {
      console.warn(`🔁 Retry ${i + 1} for fetching transaction ${txHash} failed: ${err.message}`);
    }
    await new Promise(res => setTimeout(res, delay * Math.pow(2, i)));
  }
  throw new Error(`⛔ Failed to fetch transaction ${txHash} after ${retries} retries.`);
}

// Process the pending transactions queue
async function processPendingQueue() {
  if (processingPending) return;

  const now = Date.now();
  if (now - lastPendingProcessTime < 2000) {
    // Wait so that at least 2 seconds have passed since last processing
    await new Promise(res => setTimeout(res, 2000 - (now - lastPendingProcessTime)));
  }

  processingPending = true;
  lastPendingProcessTime = Date.now();

  while (pendingQueue.length > 0) {
    const txHash = pendingQueue.shift();
    try {
      const tx = await safeGetTransaction(provider, txHash);
      if (tx && tx.to && tx.to.toLowerCase() === MONITORED_ADDRESS) {
        console.log(`🚨 New transaction to monitored address: ${txHash}`);
        forwardQueue.push(txHash);
        processForwardQueue();
      }
    } catch (err) {
      console.warn(`⚠️ Error fetching transaction ${txHash}: ${err.message}`);
    }
    // Delay 500ms between processing transactions to reduce node pressure
    await new Promise(res => setTimeout(res, 500));
  }

  processingPending = false;
}

// Process the queue to forward ETH
async function processForwardQueue() {
  if (processingForward) return;
  processingForward = true;

  while (forwardQueue.length > 0) {
    try {
      const balance = await provider.getBalance(MONITORED_ADDRESS);
      if (balance.gt(ethers.utils.parseEther("0.0001"))) {
        const gasPrice = await provider.getGasPrice();
        const gasLimit = 21000;
        const valueToSend = balance.sub(gasPrice.mul(gasLimit));

        if (valueToSend.lte(0)) {
          console.log("⛽ Insufficient balance to cover gas.");
          break;
        }

        const tx = await wallet.sendTransaction({
          to: DESTINATION_ADDRESS,
          value: valueToSend,
          gasLimit,
          gasPrice
        });

        console.log(`✅ Successfully sent! Transaction hash: ${tx.hash}`);

        // Uncomment if you want to wait for transaction confirmation
        // await tx.wait();
      } else {
        console.log("🔍 Balance too low, waiting for new incoming transactions.");
        break;
      }
    } catch (err) {
      console.error("❌ Error during transfer:", err.message);
    }
    forwardQueue.shift();
    // Delay 1 second between forwarding transactions to reduce node pressure
    await new Promise(res => setTimeout(res, 1000));
  }

  processingForward = false;
}

// Listen to pending transactions and add them to the queue
provider.on("pending", (txHash) => {
  if (pendingQueue.length >= 100) {
    // Remove the oldest transaction to make room for the new one
    pendingQueue.shift();
    console.log("⚠️ Pending queue full, oldest transaction removed.");
  }
  pendingQueue.push(txHash);
  console.log(`🆕 New transaction added to queue. Pending queue length: ${pendingQueue.length}`);
  processPendingQueue();
});

// Handle WebSocket errors
provider._websocket.on('error', (err) => {
  console.error('❌ WebSocket connection error:', err);
});

// Handle WebSocket close and attempt reconnect
provider._websocket.on('close', (code, reason) => {
  console.warn(`⚠️ WebSocket connection closed: [${code}] ${reason}`);
  console.log('⏳ Attempting to reconnect...');
  setTimeout(() => {
    process.exit(1); // Replace with your reconnection logic if needed
  }, 3000);
});
