import axios from 'axios';
import { ethers } from 'ethers';

// ── Adresse contrat USDT (ERC-20, Ethereum mainnet) ─────────
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDT_ABI      = ['function balanceOf(address) view returns (uint256)'];

// ── RPC / APIs publics gratuits ──────────────────────────────
const ETH_RPC  = 'https://eth.llamarpc.com';
const BTC_API  = 'https://blockstream.info/api';
const LTC_API  = 'https://litecoinspace.org/api';

// ── Prix via CoinGecko (gratuit, sans clé) ───────────────────
interface Prices { btc: number; eth: number; ltc: number; }
let cachedPrices: Prices | null  = null;
let pricesFetchedAt              = 0;

export async function getUsdPrices(): Promise<Prices> {
  if (cachedPrices && Date.now() - pricesFetchedAt < 5 * 60_000) {
    return cachedPrices;
  }
  const res = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price',
    { params: { ids: 'bitcoin,ethereum,litecoin', vs_currencies: 'usd' }, timeout: 8000 }
  );
  cachedPrices = {
    btc: res.data.bitcoin.usd,
    eth: res.data.ethereum.usd,
    ltc: res.data.litecoin.usd,
  };
  pricesFetchedAt = Date.now();
  return cachedPrices;
}

// Convertit un montant USD en crypto (avec 2% de marge pour la volatilité)
export async function usdToCrypto(usd: number, coin: string): Promise<number> {
  const prices = await getUsdPrices();
  switch (coin) {
    case 'btc':  return parseFloat((usd / prices.btc).toFixed(8));
    case 'eth':  return parseFloat((usd / prices.eth).toFixed(6));
    case 'ltc':  return parseFloat((usd / prices.ltc).toFixed(6));
    case 'usdt': return parseFloat(usd.toFixed(2));
    default: throw new Error(`Coin inconnu : ${coin}`);
  }
}

// ── Vérification du solde reçu sur l'adresse ────────────────

export async function checkBtcReceived(
  address: string,
  expectedSat: number,   // montant attendu en satoshis
): Promise<{ received: boolean; txHash?: string }> {
  try {
    const res = await axios.get(`${BTC_API}/address/${address}/utxo`, { timeout: 10000 });
    const utxos: any[] = res.data;
    for (const utxo of utxos) {
      // Accepte ±1% de tolérance
      if (utxo.value >= expectedSat * 0.99) {
        return { received: true, txHash: utxo.txid };
      }
    }
  } catch { /* réseau indisponible */ }
  return { received: false };
}

export async function checkLtcReceived(
  address: string,
  expectedLitoshi: number,
): Promise<{ received: boolean; txHash?: string }> {
  try {
    const res = await axios.get(`${LTC_API}/address/${address}/utxo`, { timeout: 10000 });
    const utxos: any[] = res.data;
    for (const utxo of utxos) {
      if (utxo.value >= expectedLitoshi * 0.99) {
        return { received: true, txHash: utxo.txid };
      }
    }
  } catch {}
  return { received: false };
}

export async function checkEthReceived(
  address: string,
  expectedWei: bigint,
): Promise<{ received: boolean; txHash?: string }> {
  try {
    const provider = new ethers.JsonRpcProvider(ETH_RPC);
    const balance  = await provider.getBalance(address);
    if (balance >= expectedWei * 99n / 100n) {
      return { received: true };
    }
  } catch {}
  return { received: false };
}

export async function checkUsdtReceived(
  address: string,
  expectedUsdt: number,   // en USDT (6 décimales)
): Promise<{ received: boolean; txHash?: string }> {
  try {
    const provider = new ethers.JsonRpcProvider(ETH_RPC);
    const contract = new ethers.Contract(USDT_CONTRACT, USDT_ABI, provider);
    const balance: bigint = await contract.balanceOf(address);
    const expectedRaw     = BigInt(Math.floor(expectedUsdt * 1_000_000));
    if (balance >= expectedRaw * 99n / 100n) {
      return { received: true };
    }
  } catch {}
  return { received: false };
}

// ── Dispatcher universel ─────────────────────────────────────
export async function checkPaymentReceived(
  coin:           string,
  address:        string,
  expectedAmount: number,   // en unité de la crypto (BTC, ETH, LTC, USDT)
): Promise<{ received: boolean; txHash?: string }> {
  switch (coin) {
    case 'btc': {
      const sat = Math.floor(expectedAmount * 1e8);
      return checkBtcReceived(address, sat);
    }
    case 'ltc': {
      const litoshi = Math.floor(expectedAmount * 1e8);
      return checkLtcReceived(address, litoshi);
    }
    case 'eth': {
      const wei = ethers.parseEther(expectedAmount.toString());
      return checkEthReceived(address, wei);
    }
    case 'usdt':
      return checkUsdtReceived(address, expectedAmount);
    default:
      return { received: false };
  }
}
