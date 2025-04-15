import "dotenv/config";
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";

const RPC_RISE = process.env.RPC_RISE;      
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const WETH_ADDRESS = process.env.WETH_ADDRESS;
const NETWORK_NAME = "RISE TESTNET";

const ERC20ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const WETH_ABI = [
  "function deposit() public payable",
  "function withdraw(uint256 wad) public",
  "function approve(address guy, uint256 wad) public returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

let walletInfo = {
  address: "",
  balanceNative: "0.00",
  balanceWeth: "0.00",
  network: NETWORK_NAME,
  status: "Initializing"
};

let transactionLogs = [];
let swapRunning = false;
let swapCancelled = false;
let gasPumpSwapRunning = false;
let gasPumpSwapCancelled = false;
let cloberSwapRunning = false;
let cloberSwapCancelled = false;
let globalWallet = null;
let transactionQueue = Promise.resolve();
let transactionQueueList = [];
let transactionIdCounter = 0;
let nextNonce = null;

function getShortAddress(address) {
  return address.slice(0, 6) + "..." + address.slice(-4);
}
function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function addLog(message, type) {
  const timestamp = new Date().toLocaleTimeString();
  let coloredMessage = message;
  if (type === "gaspump") {
    coloredMessage = `{bright-cyan-fg}${message}{/bright-cyan-fg}`;
  } else if (type === "clober"){
    coloredMessage = `{bright-magenta-fg}${message}{/bright-magenta-fg}`;
  } else if (type === "system") {
    coloredMessage = `{bright-white-fg}${message}{/bright-white-fg}`;
  } else if (type === "error") {
    coloredMessage = `{bright-red-fg}${message}{/bright-red-fg}`;
  } else if (type === "success") {
    coloredMessage = `{bright-green-fg}${message}{/bright-green-fg}`;
  } else if (type === "warning") {
    coloredMessage = `{bright-yellow-fg}${message}{/bright-yellow-fg}`;
  }
  transactionLogs.push(`{bright-cyan-fg}[{/bright-cyan-fg} {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} {bright-cyan-fg}]{/bright-cyan-fg} {bold}${coloredMessage}{/bold}`);
  updateLogs();
}

function getRandomDelay() {
  return Math.random() * (60000 - 30000) + 30000;
}
function getRandomNumber(min, max) {
  return Math.random() * (max - min) + min;
}

function updateLogs() {
  logsBox.setContent(transactionLogs.join("\n"));
  logsBox.setScrollPerc(100);
  safeRender();
}
function clearTransactionLogs() {
  transactionLogs = [];
  updateLogs();
  addLog("Transaction logs telah dihapus.", "system");
}

async function waitWithCancel(delay, type) {
  return Promise.race([
    new Promise(resolve => setTimeout(resolve, delay)),
    new Promise(resolve => {
      const interval = setInterval(() => {
        if (type === "swap" && gasPumpSwapCancelled) { clearInterval(interval); resolve(); }
        if (type === "clober" && cloberSwapCancelled) { clearInterval(interval); resolve(); }
      }, 100);
    })
  ]);
}

function addTransactionToQueue(transactionFunction, description = "Transaksi") {
  const transactionId = ++transactionIdCounter;
  transactionQueueList.push({
    id: transactionId,
    description,
    timestamp: new Date().toLocaleTimeString(),
    status: "queued"
  });
  addLog(`Transaksi [${transactionId}] ditambahkan ke antrean: ${description}`, "system");
  updateQueueDisplay();

  transactionQueue = transactionQueue.then(async () => {
    updateTransactionStatus(transactionId, "processing");
    addLog(`Transaksi [${transactionId}] mulai diproses.`, "system");
    try {
      if (nextNonce === null) {
        const provider = new ethers.JsonRpcProvider(RPC_RISE);
        nextNonce = await provider.getTransactionCount(globalWallet.address, "pending");
        addLog(`Nonce awal: ${nextNonce}`, "system");
      }
      const result = await transactionFunction(nextNonce);
      nextNonce++;
      updateTransactionStatus(transactionId, "completed");
      addLog(`Transaksi [${transactionId}] selesai.`, "system");
      return result;
    } catch (error) {
      updateTransactionStatus(transactionId, "error");
      addLog(`Transaksi [${transactionId}] gagal: ${error.message}`, "system");
      if (error.message && error.message.toLowerCase().includes("nonce has already been used")) {
        nextNonce++;
        addLog(`Nonce diincrement karena sudah digunakan. Nilai nonce baru: ${nextNonce}`, "system");
      }
      return;
    } finally {
      removeTransactionFromQueue(transactionId);
      updateQueueDisplay();
    }
  });
  return transactionQueue;
}
function updateTransactionStatus(id, status) {
  transactionQueueList.forEach(tx => {
    if (tx.id === id) tx.status = status;
  });
  updateQueueDisplay();
}
function removeTransactionFromQueue(id) {
  transactionQueueList = transactionQueueList.filter(tx => tx.id !== id);
  updateQueueDisplay();
}
function getTransactionQueueContent() {
  if (transactionQueueList.length === 0) return "Tidak ada transaksi dalam antrean.";
  return transactionQueueList
    .map(tx => `ID: ${tx.id} | ${tx.description} | ${tx.status} | ${tx.timestamp}`)
    .join("\n");
}
let queueMenuBox = null;
let queueUpdateInterval = null;
function showTransactionQueueMenu() {
  const container = blessed.box({
    label: " Antrian Transaksi ",
    top: "10%",
    left: "center",
    width: "80%",
    height: "80%",
    border: { type: "line" },
    style: { border: { fg: "blue" } },
    keys: true,
    mouse: true,
    interactive: true
  });
  const contentBox = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: "90%",
    content: getTransactionQueueContent(),
    scrollable: true,
    keys: true,
    mouse: true,
    alwaysScroll: true,
    scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } }
  });
  const exitButton = blessed.button({
    content: " [Keluar] ",
    bottom: 0,
    left: "center",
    shrink: true,
    padding: { left: 1, right: 1 },
    style: { fg: "white", bg: "red", hover: { bg: "blue" } },
    mouse: true,
    keys: true,
    interactive: true
  });
  exitButton.on("press", () => {
    addLog("Keluar Dari Menu Antrian Transaksi.", "system");
    clearInterval(queueUpdateInterval);
    container.destroy();
    queueMenuBox = null;
    mainMenu.show();
    mainMenu.focus();
    screen.render();
  });
  container.key(["a", "s", "d"], () => {
    addLog("Keluar Dari Menu Antrian Transaksi.", "system");
    clearInterval(queueUpdateInterval);
    container.destroy();
    queueMenuBox = null;
    mainMenu.show();
    mainMenu.focus();
    screen.render();
  });
  container.append(contentBox);
  container.append(exitButton);
  queueUpdateInterval = setInterval(() => {
    contentBox.setContent(getTransactionQueueContent());
    screen.render();
  }, 1000);
  mainMenu.hide();
  screen.append(container);
  container.focus();
  screen.render();
}
function updateQueueDisplay() {
  if (queueMenuBox) {
    queueMenuBox.setContent(getTransactionQueueContent());
    screen.render();
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "GasPump Swap",
  fullUnicode: true,
  mouse: true
});
let renderTimeout;
function safeRender() {
  if (renderTimeout) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => { screen.render(); }, 50);
}
const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  tags: true,
  style: { fg: "white", bg: "default" }
});
figlet.text("NT EXHAUST".toUpperCase(), { font: "Speed", horizontalLayout: "default" }, (err, data) => {
  if (err) headerBox.setContent("{center}{bold}NT Exhaust{/bold}{/center}");
  else headerBox.setContent(`{center}{bold}{bright-cyan-fg}${data}{/bright-cyan-fg}{/bold}{/center}`);
  safeRender();
});
const descriptionBox = blessed.box({
  left: "center",
  width: "100%",
  content: "{center}{bold}{bright-yellow-fg}✦ ✦ RISE AUTO BOT V1 ✦ ✦{/bright-yellow-fg}{/bold}{/center}",
  tags: true,
  style: { fg: "white", bg: "default" }
});
const logsBox = blessed.box({
  label: " Transaction Logs ",
  left: 0,
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } },
  content: "",
  style: { border: { fg: "bright-cyan" }, bg: "default" }
});
const walletBox = blessed.box({
  label: " Informasi Wallet ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "magenta" }, fg: "white", bg: "default", align: "left", valign: "top" },
  content: "Loading data wallet..."
});
const mainMenu = blessed.list({
  label: " Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "green", fg: "black" } },
  items: getMainMenuItems()
});

function getSwapMenuItems() {
  let items = [];
  if (gasPumpSwapRunning) {
    items.push("Stop Transaction");
  }
  items = items.concat(["Auto Swap ETH & WETH","{grey-fg}More Pairs Coming Soon{/grey-fg}", "Clear Transaction Logs", "Back To Main Menu", "Refresh"]);
  return items;
}

function getCloberSwapMenuItems() {
  let items = [];
  if (cloberSwapRunning) {
    items.push("Stop Transaction");
  }
  items = items.concat(["Auto Swap ETH & WETH","{grey-fg}More Pairs Coming Soon{/grey-fg}", "Clear Transaction Logs", "Back To Main Menu", "Refresh"]);
  return items;
}

const swapSubMenu = blessed.list({
  label: " GasPump Swap Sub Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "cyan", fg: "black" } },
  items: getSwapMenuItems()
});
swapSubMenu.hide();

const cloberSwapSubMenu = blessed.list({
  label: " Clober Swap Sub Menu ",
  left: "60%",
  keys: true,
  vi: true,
  tags: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "cyan", fg: "black" } },
  items: getCloberSwapMenuItems()
});
cloberSwapSubMenu.hide();

const promptBox = blessed.prompt({
  parent: screen,
  border: "line",
  height: 5,
  width: "60%",
  top: "center",
  left: "center",
  label: "{bright-blue-fg}Swap Prompt{/bright-blue-fg}",
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  style: { fg: "bright-red", bg: "default", border: { fg: "red" } }
});
screen.append(headerBox);
screen.append(descriptionBox);
screen.append(logsBox);
screen.append(walletBox);
screen.append(mainMenu);
screen.append(swapSubMenu);
screen.append(cloberSwapSubMenu);

function adjustLayout() {
  const screenHeight = screen.height;
  const screenWidth = screen.width;
  const headerHeight = Math.max(8, Math.floor(screenHeight * 0.15));
  headerBox.top = 0;
  headerBox.height = headerHeight;
  headerBox.width = "100%";
  descriptionBox.top = "25%";
  descriptionBox.height = Math.floor(screenHeight * 0.05);
  logsBox.top = headerHeight + descriptionBox.height;
  logsBox.left = 0;
  logsBox.width = Math.floor(screenWidth * 0.6);
  logsBox.height = screenHeight - (headerHeight + descriptionBox.height);
  walletBox.top = headerHeight + descriptionBox.height;
  walletBox.left = Math.floor(screenWidth * 0.6);
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  mainMenu.top = headerHeight + descriptionBox.height + walletBox.height;
  mainMenu.left = Math.floor(screenWidth * 0.6);
  mainMenu.width = Math.floor(screenWidth * 0.4);
  mainMenu.height = screenHeight - (headerHeight + descriptionBox.height + walletBox.height);
  swapSubMenu.top = mainMenu.top;
  swapSubMenu.left = mainMenu.left;
  swapSubMenu.width = mainMenu.width;
  swapSubMenu.height = mainMenu.height;
  cloberSwapSubMenu.top = mainMenu.top;
  cloberSwapSubMenu.left = mainMenu.left;
  cloberSwapSubMenu.width = mainMenu.width;
  cloberSwapSubMenu.height = mainMenu.height;
  safeRender();
}
screen.on("resize", adjustLayout);
adjustLayout();

async function updateWalletData() {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_RISE);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    globalWallet = wallet;
    walletInfo.address = wallet.address;
    const nativeBalance = await provider.getBalance(wallet.address);
    walletInfo.balanceNative = ethers.formatEther(nativeBalance);
    const tokenContract = (address) => new ethers.Contract(address, ERC20ABI, provider);
    const wethBalance = await tokenContract(WETH_ADDRESS).balanceOf(wallet.address);
    walletInfo.balanceWeth = ethers.formatEther(wethBalance);
    updateWallet();
    addLog("Saldo & Wallet Updated !!", "system");
  } catch (error) {
    addLog("Gagal mengambil data wallet: " + error.message, "system");
  }
}
function updateWallet() {
  const shortAddress = walletInfo.address ? getShortAddress(walletInfo.address) : "N/A";
  const native = walletInfo.balanceNative ? Number(walletInfo.balanceNative).toFixed(4) : "0.0000";
  const weth = walletInfo.balanceWeth ? Number(walletInfo.balanceWeth).toFixed(4) : "0.0000";
  const content = `┌── Address   : {bright-yellow-fg}${shortAddress}{/bright-yellow-fg}
│   ├── ETH        : {bright-green-fg}${native}{/bright-green-fg}
│   └── WETH       : {bright-green-fg}${weth}{/bright-green-fg}
└── Network        : {bright-cyan-fg}${NETWORK_NAME}{/bright-cyan-fg}`;
  walletBox.setContent(content);
  safeRender();
}

function stopAllTransactions() {
  if (gasPumpSwapRunning || cloberSwapRunning) {
    gasPumpSwapCancelled = true;
    cloberSwapCancelled = true;
    addLog("Stop All Transactions: Semua transaksi akan dihentikan.", "system");
  }
}

async function runAutoSwapETHWETH() {
  promptBox.setFront();
  promptBox.readInput("Masukkan jumlah swap ETH & WETH", "", async (err, value) => {
    promptBox.hide();
    safeRender();
    if (err || !value) {
      addLog("GasPump Swap: Input tidak valid atau dibatalkan.", "gaspump");
      return;
    }
    const loopCount = parseInt(value);
    if (isNaN(loopCount)) {
      addLog("GasPump Swap: Input harus berupa angka.", "gaspump");
      return;
    }
    addLog(`GasPump Swap: Mulai ${loopCount} iterasi.`, "gaspump");

    gasPumpSwapRunning = true;
    gasPumpSwapCancelled = false;
    mainMenu.setItems(getMainMenuItems());
    swapSubMenu.setItems(getSwapMenuItems());
    swapSubMenu.show();
    safeRender();

    const provider = new ethers.JsonRpcProvider(RPC_RISE);
    const wallet = globalWallet || new ethers.Wallet(PRIVATE_KEY, provider);
    const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);

    let currentState = "ETH"; 

    for (let i = 1; i <= loopCount; i++) {
      if (gasPumpSwapCancelled) {
        addLog(`GasPump: Auto Swap ETH & WETH Dihentikan pada Cycle ${i}.`, "gaspump");
        break;
      }
      const randomAmount = getRandomNumber(0.0001, 0.001);
      const amount = ethers.parseEther(randomAmount.toFixed(6));

      await addTransactionToQueue(async (nonce) => {
        let tx;
        if (currentState === "ETH") {
          try {
            addLog(`GasPump: Melakukan Swap ${randomAmount.toFixed(6)} ETH ➯  WETH.`, "gaspump");
            tx = await wethContract.deposit({ value: amount, gasLimit: 100000, nonce: nonce });
            addLog(`GasPump: Sending Transaction ... Hash: ${getShortHash(tx.hash)}`, "gaspump");
            await tx.wait();
            addLog(`GasPump: Transaction Successfully!! Hash: ${getShortHash(tx.hash)}`, "success");
            currentState = "WETH";
          } catch (error) {
            addLog(`GasPump: Eroor ${error.message}`, "error");
          }
        } else {
          try {
            addLog(`GasPump: Melakukan Swap ${randomAmount.toFixed(6)} WETH ➯  ETH.`, "gaspump");
            const currentAllowance = await wethContract.allowance(wallet.address, WETH_ADDRESS);
            if (currentAllowance < amount) {
              addLog("GasPump: Transaction Need To Approve.", "GasPump");
              const approveTx = await wethContract.approve(WETH_ADDRESS, ethers.MaxUint256, { gasLimit: 100000, nonce: nonce });
              addLog(`GasPump: Approve Sent.. Hash: ${getShortHash(approveTx.hash)}`, "gaspump");
              await approveTx.wait();
              addLog("GasPump: Approval Successfully.", "success");
            }
            tx = await wethContract.withdraw(amount, { gasLimit: 100000, nonce: nonce });
            addLog(`GasPump: Sending Transaction... Hash: ${getShortHash(tx.hash)}`, "gaspump");
            await tx.wait();
            addLog(`GasPump: Transaction Successfully!! Hash: ${getShortHash(tx.hash)}`, "success");
            await updateWalletData();
            currentState = "ETH";
          } catch (error) {
            addLog(`Error Swap: ${error.message}`, "error");
          }
        }
      }, `GasPump Swap - Cycle Ke ${i}`);

      if (i < loopCount) {
        const delayTime = getRandomDelay();
        const minutes = Math.floor(delayTime / 60000);
        const seconds = Math.floor((delayTime % 60000) / 1000);
        addLog(`Swap ke ${i} selesai. Menunggu ${minutes} menit ${seconds} detik.`, "gaspump");
        await waitWithCancel(delayTime, "swap");
        if (gasPumpSwapCancelled) {
          addLog("GasPump Swap: Dihentikan saat periode tunggu.", "gaspump");
          break;
        }
      }
    }
    gasPumpSwapRunning = false;
    mainMenu.setItems(getMainMenuItems());
    swapSubMenu.setItems(getSwapMenuItems());
    safeRender();
    addLog("GasPump Swap: Auto Swap ETH & WETH selesai.", "gaspump");
  });
}

async function runCloberSwapETHWETH() {
  promptBox.setFront();
  promptBox.readInput("Masukkan jumlah swap ETH & WETH :", "", async (err, value) => {
    promptBox.hide();
    safeRender();
    if (err || !value) {
      addLog("Clober Swap: Input tidak valid atau dibatalkan.", "clober");
      return;
    }
    const loopCount = parseInt(value);
    if (isNaN(loopCount)) {
      addLog("Clober Swap: Input harus berupa angka.", "clober");
      return;
    }
    addLog(`Clober Swap: Mulai ${loopCount} iterasi.`, "clober");

    const provider = new ethers.JsonRpcProvider(RPC_RISE);
    const wallet = globalWallet || new ethers.Wallet(PRIVATE_KEY, provider);
    const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);

    let currentState = "ETH";
    cloberSwapRunning  = true;
    cloberSwapCancelled = false;
    mainMenu.setItems(getMainMenuItems());
    cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
    cloberSwapSubMenu.show();
    safeRender();

    for (let i = 1; i <= loopCount; i++) {
      if (cloberSwapCancelled) {
        addLog(`Clober Swap: Dihentikan pada Cycle Ke ${i}.`, "clober");
        break;
      }
      const randomAmount = getRandomNumber(0.0001, 0.001);
      const amount = ethers.parseEther(randomAmount.toFixed(6));

      await addTransactionToQueue(async (nonce) => {
        let tx;
        if (currentState === "ETH") {
          try {
            addLog(`Clober: Melakukan Swap ${randomAmount.toFixed(6)} ETH ➯  WETH`, "clober");
            tx = await wethContract.deposit({ value: amount, gasLimit: 100000, nonce: nonce });
            addLog(`Clober: Sending Transaction... Hash:${getShortHash(tx.hash)}`, "clober");
            await tx.wait();
            addLog("Clober: Transactio Successfully", "success");
            currentState = "WETH";
          } catch (error) {
            addLog(`Clober: Error ${error.message}`, "error");
          }
        } else {
          try {
            addLog(`Clober: Melakukan Swap ${randomAmount.toFixed(6)} WETH ➯  ETH.`, "clober");
            const currentAllowance = await wethContract.allowance(wallet.address, WETH_ADDRESS);
            if (currentAllowance < amount) {
              addLog("Clober: Transaction Need To Approve", "clober");
              const approveTx = await wethContract.approve(WETH_ADDRESS, ethers.MaxUint256, { gasLimit: 100000, nonce: nonce });
              addLog(`Clober: Approve Sent... Hash: ${getShortHash(approveTx.hash)}`, "clober");
              await approveTx.wait();
              addLog("Clober: Approve Succesfully", "success");
            }
            tx = await wethContract.withdraw(amount, { gasLimit: 100000, nonce: nonce });
            addLog(`Clober: Sending Transaction... Hash: ${getShortHash(tx.hash)}`, "clober");
            await tx.wait();
            addLog("Clober: Transaction Succesfully", "success");
            await updateWalletData();
            currentState = "ETH";
          } catch (error) {
            addLog(`Error withdraw (Clober): ${error.message}`, "error");
          }
        }
      }, `Clober Swap - Iterasi ${i}`);

      if (i < loopCount) {
        const delayTime = getRandomDelay();
        const minutes = Math.floor(delayTime / 60000);
        const seconds = Math.floor((delayTime % 60000) / 1000);
        addLog(`Clober Swap: Cycle Ke ${i} selesai. Menunggu ${minutes} menit ${seconds} detik`, "clober");
        await waitWithCancel(delayTime, "swap");
        if (cloberSwapCancelled) {
          addLog("Clober Swap: Dihentikan saat periode tunggu.", "clober");
          break;
        }
      }
    }
    cloberSwapRunning = false;
    mainMenu.setItems(getMainMenuItems());
    cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
    safeRender();
    addLog("Clober Swap: Proses selesai.", "clober");
  });
}

function getMainMenuItems() {
  let items = [];
  if (gasPumpSwapRunning || cloberSwapRunning) {
    items.push("Stop All Transactions");
  }
  items = items.concat(["GasPump Swap", "Clober Swap", "Antrian Transaksi", "Clear Transaction Logs", "Refresh", "Exit"]);
  return items;
}

mainMenu.on("select", (item) => {
  const selected = item.getText();
 if (selected === "GasPump Swap") {
    swapSubMenu.show();
    swapSubMenu.focus();
    safeRender();
  } else if (selected === "Clober Swap") {
    cloberSwapSubMenu.show();
    cloberSwapSubMenu.focus();
    safeRender();
  } else if (selected === "Antrian Transaksi") {
    showTransactionQueueMenu();
  } else if (selected === "Stop All Transactions") {
    stopAllTransactions();
    mainMenu.setItems(getMainMenuItems());
    mainMenu.focus();
    safeRender();
  } else if (selected === "Clear Transaction Logs") {
    clearTransactionLogs();
  } else if (selected === "Refresh") {
    updateWalletData();
    updateLogs();
    safeRender();
    addLog("Refreshed", "system");
  } else if (selected === "Exit") {
    process.exit(0);
  }
});
swapSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Auto Swap ETH & WETH") {
    if (gasPumpSwapRunning) {
      addLog("Transaksi GasPump Swap sedang berjalan. Hentikan transaksi terlebih dahulu.", "warning");
    } else {
      runAutoSwapETHWETH();
    }
  } else if (selected === "Stop Transaction") {
    if (gasPumpSwapRunning) {
      gasPumpSwapCancelled = true;
      addLog("GasPump Swap: Perintah Stop Transaction diterima.", "swap");
    } else {
      addLog("GasPump Swap: Tidak ada transaksi yang berjalan.", "swap");
    }
  } else if (selected === "Clear Transaction Logs") {
    clearTransactionLogs();
  } else if (selected === "Back To Main Menu") {
    swapSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    safeRender();
  } else if (selected === "Refresh") {
    updateWalletData();
    updateLogs();
    safeRender();
    addLog("Refreshed", "system");
  }
});

cloberSwapSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Auto Swap ETH & WETH") {
    if (cloberSwapRunning) {
      addLog("Transaksi Clober Swap sedang berjalan. Hentikan transaksi terlebih dahulu.", "warning");
    } else {
      runCloberSwapETHWETH();
    }
  } else if (selected === "Stop Transaction") {
    if (cloberSwapRunning) {
      cloberSwapCancelled = true;
      addLog("Clober Swap: Perintah Stop Transaction diterima.", "swap");
    } else {
      addLog("Clober Swap: Tidak ada transaksi yang berjalan.", "swap");
    }
  } else if (selected === "Clear Transaction Logs") {
    clearTransactionLogs();
  } else if (selected === "Back To Main Menu") {
    cloberSwapSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    safeRender();
  } else if (selected === "Refresh") {
    updateWalletData();
    updateLogs();
    safeRender();
    addLog("Refreshed", "system");
  }
});

screen.key(["escape", "q", "C-c"], () => process.exit(0));
screen.key(["C-up"], () => { logsBox.scroll(-1); safeRender(); });
screen.key(["C-down"], () => { logsBox.scroll(1); safeRender(); });

safeRender();
mainMenu.focus();
addLog("Dont Forget To Subscribe YT And Telegram @NTExhaust!!", "system");
updateLogs();
updateWalletData();
