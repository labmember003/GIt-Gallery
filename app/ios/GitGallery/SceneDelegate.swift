import UIKit

// Apps built with the iOS 27 SDK must adopt the UIScene life cycle or UIKit refuses to
// launch them. AppDelegate still creates the window and starts React Native, because
// Expo's dev launcher looks for that window during launch. This delegate attaches the
// window to the scene and forwards links, which UIKit now delivers to the scene instead.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene, let window = appDelegate?.window else {
      return
    }
    window.windowScene = windowScene
    window.frame = windowScene.coordinateSpace.bounds
    window.makeKeyAndVisible()
    self.window = window

    // Links that cold-start the app arrive here rather than in the launch options.
    self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    connectionOptions.userActivities.forEach { self.scene(scene, continue: $0) }
  }

  // Linking API
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      options[.sourceApplication] = context.options.sourceApplication
      options[.annotation] = context.options.annotation
      _ = appDelegate?.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  // Universal Links
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = appDelegate?.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  private var appDelegate: AppDelegate? {
    UIApplication.shared.delegate as? AppDelegate
  }
}
