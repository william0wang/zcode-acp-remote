package app.zcode.acp

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Edge-to-edge draws the WebView under the system bars, but Android
    // WebView reports env(safe-area-inset-*) as 0. Forward the real insets
    // into the page as CSS variables (consumed via max() in index.css).
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = resources.displayMetrics.density
      fun px(v: Int) = "${v / density}px"
      val js = buildString {
        append("document.documentElement.style.setProperty('--android-inset-top','").append(px(bars.top)).append("');")
        append("document.documentElement.style.setProperty('--android-inset-bottom','").append(px(bars.bottom)).append("');")
        append("document.documentElement.style.setProperty('--android-inset-left','").append(px(bars.left)).append("');")
        append("document.documentElement.style.setProperty('--android-inset-right','").append(px(bars.right)).append("');")
      }
      findWebView(content)?.evaluateJavascript(js, null)
      insets
    }
  }

  // The Tauri WebView is not exposed directly; it is the only WebView in the
  // hierarchy, so a lazy walk is safe (insets dispatch happens after layout).
  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        findWebView(view.getChildAt(i))?.let { return it }
      }
    }
    return null
  }
}
