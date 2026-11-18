import CryptoKit
import ExpoModulesCore

/**
 AES-256-GCM for shared albums, done by Apple's CryptoKit. Keeping the cipher
 in the operating system (rather than in app code) is what lets the app keep
 declaring no non-exempt encryption to App Store Connect.
 */
public class GitGalleryCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("GitGalleryCrypto")

    // Returns ciphertext followed by the 16-byte tag.
    Function("aesGcmSeal") { (key: Data, nonce: Data, aad: Data, plain: Data) -> Data in
      let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: nonce), authenticating: aad)
      return box.ciphertext + box.tag
    }

    // Takes ciphertext followed by the tag; throws if anything was altered.
    Function("aesGcmOpen") { (key: Data, nonce: Data, aad: Data, sealed: Data) -> Data in
      guard sealed.count >= 16 else { throw SealedTooShortException() }
      let box = try AES.GCM.SealedBox(
        nonce: try AES.GCM.Nonce(data: nonce),
        ciphertext: sealed.prefix(sealed.count - 16),
        tag: sealed.suffix(16)
      )
      return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    }
  }
}

internal final class SealedTooShortException: Exception {
  override var reason: String { "Encrypted data is too short" }
}
