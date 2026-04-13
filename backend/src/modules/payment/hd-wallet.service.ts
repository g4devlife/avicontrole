import * as bip39  from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { ethers } from 'ethers';

const bip32 = BIP32Factory(ecc);

// ── Réseau Litecoin ──────────────────────────────────────────
const LITECOIN: bitcoin.networks.Network = {
  messagePrefix:  '\x19Litecoin Signed Message:\n',
  bech32:         'ltc',
  bip32:          { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash:     0x30,
  scriptHash:     0x32,
  wif:            0xb0,
};

// ── Chemins BIP44 ────────────────────────────────────────────
// m/44'/{coin_type}'/0'/0/{index}
const PATHS: Record<string, string> = {
  btc:  "m/44'/0'/0'/0",
  ltc:  "m/44'/2'/0'/0",
  eth:  "m/44'/60'/0'/0",
  usdt: "m/44'/60'/0'/0",  // même adresse qu'ETH
};

export class HdWalletService {
  private root: ReturnType<typeof bip32.fromSeed>;

  constructor(mnemonic: string) {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Mnemonic BIP39 invalide');
    }
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    this.root  = bip32.fromSeed(seed);
  }

  // ── Dériver une adresse à partir d'un index ──────────────
  deriveAddress(coin: string, index: number): string {
    const path = `${PATHS[coin]}/${index}`;
    const child = this.root.derivePath(path);
    const pubkey = Buffer.from(child.publicKey);

    switch (coin) {
      case 'btc': {
        const { address } = bitcoin.payments.p2wpkh({
          pubkey,
          network: bitcoin.networks.bitcoin,
        });
        return address!;
      }

      case 'ltc': {
        const { address } = bitcoin.payments.p2pkh({
          pubkey,
          network: LITECOIN,
        });
        return address!;
      }

      case 'eth':
      case 'usdt': {
        // ethers dérive depuis la clé publique compressée
        const wallet = new ethers.Wallet(
          Buffer.from(child.privateKey!).toString('hex')
        );
        return wallet.address;
      }

      default:
        throw new Error(`Coin non supporté : ${coin}`);
    }
  }
}

// Singleton — initialisé au démarrage depuis .env
let _instance: HdWalletService | null = null;

export function getHdWallet(): HdWalletService {
  if (!_instance) {
    const mnemonic = process.env.HD_WALLET_MNEMONIC;
    if (!mnemonic) throw new Error('HD_WALLET_MNEMONIC manquant dans .env');
    _instance = new HdWalletService(mnemonic);
  }
  return _instance;
}

// Générer une mnemonic de test (à faire UNE FOIS, puis sauvegarder dans .env)
export function generateMnemonic(): string {
  return bip39.generateMnemonic(256); // 24 mots
}
