package app.zcode.acp

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.URLUtil
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  // DownloadManager ids → display names: the completion broadcast carries
  // only the id, but the webview toast needs the filename too.
  private val downloadNames = HashMap<Long, String>()
  private var appWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // The WebView hands downloads to the system DownloadManager and never
    // hears the outcome; forward the completion broadcast so the page can
    // toast success/failure (see the zcode:download listener in ChatScreen).
    ContextCompat.registerReceiver(
      applicationContext,
      object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
          val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
          val name = downloadNames.remove(id) ?: return
          emitDownloadEvent(name, if (downloadSucceeded(id)) "done" else "failed")
        }
      },
      IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )

    // Edge-to-edge draws the WebView under the system bars, but Android
    // WebView reports env(safe-area-inset-*) as 0. Forward the real insets
    // into the page as CSS variables (consumed via max() in index.css). The
    // IME height rides along as --android-inset-ime so the page can pad the
    // composer above the keyboard instead of letting the WebView pan the
    // whole document (which scrolls the header away).
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val density = resources.displayMetrics.density
      fun px(v: Int) = "${v / density}px"
      val js = buildString {
        append("document.documentElement.style.setProperty('--android-inset-top','").append(px(bars.top)).append("');")
        append("document.documentElement.style.setProperty('--android-inset-bottom','").append(px(bars.bottom)).append("');")
        append("document.documentElement.style.setProperty('--android-inset-left','").append(px(bars.left)).append("');")
        append("document.documentElement.style.setProperty('--android-inset-right','").append(px(bars.right)).append("');")
        append("document.documentElement.style.setProperty('--android-inset-ime','").append(px(ime.bottom)).append("');")
      }
      findWebView(content)?.evaluateJavascript(js, null)
      insets
    }
  }

  // wry registers no DownloadListener: without one the WebView silently
  // drops every download (fs file URLs with ?dl=1 answer with
  // Content-Disposition: attachment). Route those into the system
  // DownloadManager — native notification, lands in public Downloads.
  // WryActivity.setWebView calls this the moment the runtime's WebView
  // exists — the only hook that doesn't race the async webview creation
  // (tree-walking from onCreate loses that race: 3 frames is far too
  // early, the Rust runtime boots much later).
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    webView.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
      // Strip path separators: DownloadManager throws on them, and a
      // guessed name must never escape DIRECTORY_DOWNLOADS.
      val name = fileNameFrom(url, contentDisposition, mimeType).replace("/", "_")
      try {
        val request = DownloadManager.Request(Uri.parse(url))
          .setTitle(name)
          .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
          .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        val id = (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
        downloadNames[id] = name
        emitDownloadEvent(name, "started")
      } catch (e: Exception) {
        Log.w("MainActivity", "download enqueue failed: ${e.message}")
        emitDownloadEvent(name, "failed")
      }
    }
  }

  private fun downloadSucceeded(id: Long): Boolean = try {
    val cursor = (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager)
      .query(DownloadManager.Query().setFilterById(id))
    cursor.use { c ->
      c.moveToFirst() &&
        c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) ==
        DownloadManager.STATUS_SUCCESSFUL
    }
  } catch (e: Exception) {
    false
  }

  // The payload is a JSON object literal spliced into JS source, so any
  // filename survives the crossing escaped.
  private fun emitDownloadEvent(name: String, state: String) {
    val payload = JSONObject().put("name", name).put("state", state).toString()
    appWebView?.post {
      appWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('zcode:download',{detail:$payload}))",
        null
      )
    }
  }

  // Prefer the RFC 5987 filename* form (Android's URLUtil only reads the
  // ASCII fallback), so non-ASCII filenames survive the download.
  private fun fileNameFrom(url: String, contentDisposition: String?, mimeType: String?): String {
    if (contentDisposition != null) {
      val star = Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE)
        .find(contentDisposition)?.groupValues?.getOrNull(1)
      if (!star.isNullOrBlank()) return Uri.decode(star)
      val plain = Regex("filename=\"?([^\";]+)\"?", RegexOption.IGNORE_CASE)
        .find(contentDisposition)?.groupValues?.getOrNull(1)
      if (!plain.isNullOrBlank()) return plain
    }
    return URLUtil.guessFileName(url, contentDisposition, mimeType)
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
