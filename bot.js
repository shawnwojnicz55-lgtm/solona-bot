// Telegram bot: import a Solana PUBLIC wallet address and view stats.
// SECURITY: This bot never asks for or stores private keys / seed phrases.
// Only public wallet addresses are used — that's all that's needed to read balances,
// tokens, and transaction history on a public blockchain.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey, LAMPORTS_PER_SOL, clusterApiUrl } = require('@solana/web3.js');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta');

if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const connection = new Connection(RPC_URL, 'confirmed');

// --- Simple persistent storage: chatId -> wallet address ---------------
const DB_PATH = path.join(__dirname, 'wallets.json');

function loadWallets() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveWallets(wallets) {
  fs.writeFileSync(DB_PATH, JSON.stringify(wallets, null, 2));
}

let wallets = loadWallets();

// --- Helpers -------------------------------------------------------------

function isValidAddress(address) {
  try {
    // Throws if not a valid base58 public key. This does NOT check that
    // the key is "on curve" (some valid PDAs aren't), which is fine for
    // reading account data.
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

async function getWalletStats(address) {
  const pubkey = new PublicKey(address);

  // 1) SOL balance
  const lamports = await connection.getBalance(pubkey);
  const sol = lamports / LAMPORTS_PER_SOL;

  // 2) SPL token accounts (all owned by this address)
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });

  const tokens = tokenAccounts.value
    .map((acc) => acc.account.data.parsed.info)
    .filter((info) => Number(info.tokenAmount.uiAmount) > 0)
    .map((info) => ({
      mint: info.mint,
      amount: info.tokenAmount.uiAmountString,
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  // 3) Recent transaction signatures (cheap way to gauge activity)
  const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 20 });
  const txCount = signatures.length;
  const lastTx = signatures[0];
  const lastActivity = lastTx?.blockTime
    ? new Date(lastTx.blockTime * 1000).toUTCString()
    : 'No recent activity found';

  return { sol, tokens, txCount, lastActivity };
}

function formatStats(address, stats) {
  const { sol, tokens, txCount, lastActivity } = stats;

  let msg = `📊 *Wallet Stats*\n`;
  msg += `\`${address}\`\n\n`;
  msg += `💰 *SOL Balance:* ${sol.toFixed(4)} SOL\n`;
  msg += `🪙 *SPL Tokens Held:* ${tokens.length}\n`;
  msg += `🔄 *Recent Transactions:* ${txCount}${txCount === 20 ? '+' : ''} (last 20 checked)\n`;
  msg += `🕒 *Last Activity:* ${lastActivity}\n`;

  if (tokens.length > 0) {
    msg += `\n*Top Token Holdings:*\n`;
    tokens.slice(0, 5).forEach((t, i) => {
      msg += `${i + 1}. ${t.amount} — \`${t.mint.slice(0, 4)}...${t.mint.slice(-4)}\`\n`;
    });
  }

  return msg;
}

// --- Bot commands ---------------------------------------------------------

bot.onText(/^\/start$/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `👋 Welcome! This bot shows stats for a *public* Solana wallet address.\n\n` +
      `⚠️ Never share a private key or seed phrase with this or any bot.\n\n` +
      `*Commands:*\n` +
      `/import <address> — save a wallet address to check\n` +
      `/stats — show stats for your saved address\n` +
      `/stats <address> — check any address without saving it\n` +
      `/forget — remove your saved address\n`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/import(?:\s+(.+))?$/, (msg, match) => {
  const chatId = msg.chat.id;
  const address = match[1]?.trim();

  if (!address) {
    return bot.sendMessage(chatId, 'Usage: /import <your public Solana address>');
  }
  if (!isValidAddress(address)) {
    return bot.sendMessage(chatId, '❌ That doesn\'t look like a valid Solana address.');
  }

  wallets[chatId] = address;
  saveWallets(wallets);
  bot.sendMessage(chatId, `✅ Saved address:\n\`${address}\`\n\nRun /stats to see its data.`, {
    parse_mode: 'Markdown',
  });
});

bot.onText(/^\/forget$/, (msg) => {
  const chatId = msg.chat.id;
  delete wallets[chatId];
  saveWallets(wallets);
  bot.sendMessage(chatId, '🗑️ Saved address removed.');
});

bot.onText(/^\/stats(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const address = match[1]?.trim() || wallets[chatId];

  if (!address) {
    return bot.sendMessage(
      chatId,
      'No address saved yet. Use /import <address> first, or run /stats <address>.'
    );
  }
  if (!isValidAddress(address)) {
    return bot.sendMessage(chatId, '❌ That doesn\'t look like a valid Solana address.');
  }

  const loadingMsg = await bot.sendMessage(chatId, '⏳ Fetching wallet stats...');

  try {
    const stats = await getWalletStats(address);
    await bot.editMessageText(formatStats(address, stats), {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.error(err);
    await bot.editMessageText(
      '⚠️ Could not fetch stats. The RPC may be rate-limiting or the address may be malformed. Try again shortly.',
      { chat_id: chatId, message_id: loadingMsg.message_id }
    );
  }
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log('Bot is running (long polling). Press Ctrl+C to stop.');
