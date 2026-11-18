package expo.modules.gitgallerycrypto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * AES-256-GCM for shared albums, done by Android's own crypto provider, so the
 * cipher lives in the operating system rather than in app code.
 */
class GitGalleryCryptoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GitGalleryCrypto")

    // Returns ciphertext followed by the 16-byte tag.
    Function("aesGcmSeal") { key: ByteArray, nonce: ByteArray, aad: ByteArray, plain: ByteArray ->
      run(Cipher.ENCRYPT_MODE, key, nonce, aad, plain)
    }

    // Takes ciphertext followed by the tag; throws if anything was altered.
    Function("aesGcmOpen") { key: ByteArray, nonce: ByteArray, aad: ByteArray, sealed: ByteArray ->
      run(Cipher.DECRYPT_MODE, key, nonce, aad, sealed)
    }
  }

  private fun run(mode: Int, key: ByteArray, nonce: ByteArray, aad: ByteArray, input: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    cipher.updateAAD(aad)
    return cipher.doFinal(input)
  }
}
