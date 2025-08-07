require('dotenv').config();
const { ethers } = require('ethers');

// بررسی متغیرها
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MONITORED_ADDRESS = process.env.MONITORED_ADDRESS?.toLowerCase();
const DESTINATION_ADDRESS = process.env.DESTINATION_ADDRESS;
const INFURA_WSS = process.env.INFURA_WSS;

if (!PRIVATE_KEY || !MONITORED_ADDRESS || !DESTINATION_ADDRESS || !INFURA_WSS) {
    console.error("❌ لطفاً تمام متغیرهای محیطی را تنظیم کنید");
    process.exit(1);
}

// ساخت Provider و Wallet
const provider = new ethers.providers.WebSocketProvider(INFURA_WSS);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// صف‌ها و فلگ‌ها
const pendingQueue = [];
const forwardQueue = [];
let processingPending = false;
let processingForward = false;

// تابع امن دریافت تراکنش با Retry و Backoff
async function safeGetTransaction(provider, txHash, retries = 5, delay = 1500) {
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await provider.getTransaction(txHash);
            if (tx) return tx;
        } catch (err) {
            console.warn(`🔁 تلاش ${i + 1} برای دریافت تراکنش ${txHash} شکست خورد: ${err.message}`);
        }
        await new Promise(res => setTimeout(res, delay * Math.pow(2, i)));
    }
    throw new Error(`⛔ دریافت تراکنش ${txHash} پس از ${retries} تلاش ناموفق بود.`);
}

// پردازش صف تراکنش‌های Pending
async function processPendingQueue() {
    if (processingPending) return;
    processingPending = true;

    while (pendingQueue.length > 0) {
        const txHash = pendingQueue.shift();
        try {
            const tx = await safeGetTransaction(provider, txHash);
            if (tx && tx.to && tx.to.toLowerCase() === MONITORED_ADDRESS) {
                console.log(`🚨 تراکنش جدید به آدرس ما: ${txHash}`);
                forwardQueue.push(txHash);
                processForwardQueue();
            }
        } catch (err) {
            console.warn(`⚠️ خطا در دریافت تراکنش ${txHash}: ${err.message}`);
        }
        // کمی تاخیر برای کاهش فشار روی نود
        await new Promise(res => setTimeout(res, 500));
    }

    processingPending = false;
}

// پردازش صف ارسال ETH
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
                    console.log("⛽ موجودی کافی برای پرداخت گس وجود ندارد.");
                    break;
                }

                const tx = await wallet.sendTransaction({
                    to: DESTINATION_ADDRESS,
                    value: valueToSend,
                    gasLimit,
                    gasPrice
                });

                console.log(`✅ ارسال موفق! هش تراکنش: ${tx.hash}`);

                // میتونی اینجا await tx.wait() هم اضافه کنی اگر بخوای تایید کامل تراکنش رو صبر کنی
            } else {
                console.log("🔍 موجودی کم است، منتظر تراکنش جدید می‌مانیم.");
                break;
            }
        } catch (err) {
            console.error("❌ خطا در انتقال:", err.message);
        }
        forwardQueue.shift();
        // تاخیر کوتاه بین تراکنش‌ها برای کاهش فشار روی نود
        await new Promise(res => setTimeout(res, 1000));
    }

    processingForward = false;
}

// گوش دادن به تراکنش‌های Pending و اضافه کردن به صف
provider.on("pending", (txHash) => {
    pendingQueue.push(txHash);
    console.log(`🆕 تراکنش جدید به صف اضافه شد. طول صف pending: ${pendingQueue.length}`);
    processPendingQueue();
});

// خطای اتصال
provider._websocket.on('error', (err) => {
    console.error('❌ خطای اتصال WebSocket:', err);
});

// بستن اتصال
provider._websocket.on('close', (code, reason) => {
    console.warn(`⚠️ اتصال WebSocket بسته شد: [${code}] ${reason}`);
    console.log('⏳ در حال تلاش برای اتصال مجدد...');
    setTimeout(() => {
        process.exit(1); // می‌تونی کد ریکاوری خودت رو بذاری اینجا
    }, 3000);
});
