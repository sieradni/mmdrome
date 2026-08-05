import UIKit
import Capacitor
import BackgroundAudio

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    /// Forces the dynamic-plugin module to be linked. The plugin class is discovered
    /// at runtime via NSClassFromString (packageClassList); without a direct reference
    /// the static library could be dead-stripped.
    static let linkedNativePlugin: AnyClass = BackgroundAudioPlugin.self

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
