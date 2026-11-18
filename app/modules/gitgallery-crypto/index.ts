import { requireNativeModule } from 'expo-modules-core';

type Native = {
  aesGcmSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plain: Uint8Array): Uint8Array;
  aesGcmOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array;
};

/** AES-256-GCM from the operating system (iOS CryptoKit, Android javax.crypto). */
export default requireNativeModule<Native>('GitGalleryCrypto');
