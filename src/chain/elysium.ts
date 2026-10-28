import type { Address } from '../core/types.ts';
import { selector, topic } from './keccak.ts';

/**
 * Elysium testnet facts, checked against the chain on 2026-10-28:
 *  - chain id 99801 (0x185d9), Arbitrum Nitro L2 settling to HyperEVM testnet, HYPE gas, ~240 ms blocks
 *  - RPC https://testnet-rpc.elysium.kinetiq.xyz (Conduit mirror: https://rpc-elysium-testnet.t.conduit.xyz)
 *  - Blockscout API https://testnet-api.elysium.kinetiq.xyz/api/v2
 */
export const ELYSIUM_TESTNET = {
  chainId: 99801,
  rpc: 'https://testnet-rpc.elysium.kinetiq.xyz',
  explorerApi: 'https://testnet-api.elysium.kinetiq.xyz/api/v2',
  explorer: 'https://elysium.kinetiq.xyz/testnet-explorer',
  /** blocks per second, measured (~240 ms per block) */
  blocksPerSecond: 4,
};

/**
 * AscendLaunchpad deployments on the testnet. Each was created by Ascend's
 * deployer 0x5Fa6…70eB (directly or through the CREATE2 factory), except
 * 0x5490…a888, which runs on a PoolManager that deployer created. Ascend
 * replaces launchpads during testing and publishes no registry yet, so this
 * list is overridable with ASCEND_LAUNCHPADS. Look-alike forks by other
 * builders emit the same `Launched` event and are deliberately not listed.
 */
export const ASCEND_LAUNCHPADS: Address[] = [
  '0xee8dd09d72f5bb2edec87cc6509e015409160440',
  '0x5519368867d0c7e2f6bec853b799731bdf12847c',
  '0xc05193a68ed25df678bb7d6644d081bffdaa01d9',
  '0xed6e0ca8247a697cadfdb0deaaa2d73e061719f4',
  '0xe2f6254508deb93da081837f545e0baf7b00d8e9',
  '0x6d01f6644bbf1b5074472d3e85aa1465b4d2bf3d',
  '0xc3edd1cc4bf4e31a91de009e983191dd13f8a888',
  '0xdba31d548d7c27d379b67558b72d282b2eefe888',
  '0x5490a440dc3b072b0e3417ab67ef2160fecda888',
];

/** Ascend's web app; token pages live at /tokens/<address> (access-gated during testnet). */
export const ASCEND_APP_URL = 'https://app.ascendlaunch.xyz';

export const TOPIC = {
  transfer: topic('Transfer(address,address,uint256)'),
  launched: topic('Launched(bytes32,address,address,address,uint256,uint256)'),
  creatorTransferred: topic('CreatorTransferred(bytes32,address)'),
  creatorClaimed: topic('CreatorClaimed(bytes32,address,uint256,uint256)'),
  listingSetAside: topic('ListingSetAside(bytes32,uint256)'),
  filled: topic('Filled(bytes32,uint256,uint256,uint256,uint256)'),
  /** PancakeSwap Infinity CLPoolManager (the current launchpads) */
  swapInfinity: topic('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24,uint16)'),
  /** Uniswap v4 PoolManager (earlier launchpads) */
  swapV4: topic('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
};

/** Launchpad getters whose results are protocol plumbing, never holders. */
export const LAUNCHPAD_INFRA_GETTERS = [
  'poolManager()',
  'vault()',
  'treasury()',
  'opexTreasury()',
  'ecosystemTreasury()',
  'stakerYieldTreasury()',
  'kntqTreasury()',
  'cohortTreasury()',
  'inventoryTreasury()',
  'listingDesk()',
].map((sig) => ({ sig, data: selector(sig) }));

/** Share of creator quote fees set aside for the HyperCore listing (AscendLaunchpad source, `ListingSetAside`). */
export const LISTING_SET_ASIDE_BPS = 2_000;
export const TOKEN_DECIMALS = 18;
