package app.zcode.acp

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app download path for remote fs files. The system DownloadManager used
 * before runs in its own process with its own network stack — on split-tunnel
 * VPNs or proxied Wi-Fi it cannot reach the (often plain-http intranet) hub
 * while the app process can, so every download failed with a generic toast.
 * This plugin downloads on an app-process thread and saves via MediaStore,
 * which needs no storage permission on API 29+ (our floor for this path).
 */
@InvokeArg
class DownloadArgs {
  lateinit var url: String
  lateinit var name: String
}

@TauriPlugin
class DownloadBridge(private val activity: Activity) : Plugin(activity) {
  @Command
  fun download(invoke: Invoke) {
    val args = invoke.parseArgs(DownloadArgs::class.java)
    Thread {
      try {
        invoke.resolve(JSObject().put("name", downloadToDownloads(args.url, args.name)))
      } catch (e: Exception) {
        // Keep the exception class in the message — a bare message like
        // "timeout" or a hostname alone is not diagnosable from a toast.
        val msg = e.message
        invoke.reject(
          if (msg.isNullOrBlank()) e.javaClass.simpleName
          else "${e.javaClass.simpleName}: $msg"
        )
      }
    }.start()
  }

  // Progress goes to the page as plugin events ("download" / "progress" via
  // addPluginListener). Only whole-percent hops are emitted so a large file
  // doesn't flood the bridge. runOnUiThread: trigger touches the WebView.
  private fun emitProgress(received: Long, total: Long) {
    val data = JSObject()
    data.put("received", received)
    data.put("total", total)
    activity.runOnUiThread {
      trigger("progress", data)
    }
  }

  // HttpURLConnection never follows cross-protocol (http<->https)
  // redirects; a hub behind a TLS-terminating proxy answers 301/302, so hop
  // manually (same-protocol hops are covered too). The token rides the
  // query string and survives each hop.
  private fun openFollowingRedirects(url: String): HttpURLConnection {
    var current = url
    repeat(5) {
      val conn = URL(current).openConnection() as HttpURLConnection
      conn.connectTimeout = 10_000
      conn.readTimeout = 30_000
      conn.instanceFollowRedirects = true
      val code = conn.responseCode
      val location = conn.getHeaderField("Location")
      if (code in 300..399 && !location.isNullOrBlank()) {
        current = URL(URL(current), location).toString()
        conn.disconnect()
      } else {
        return conn
      }
    }
    throw IOException("too many redirects")
  }

  private fun downloadToDownloads(url: String, rawName: String): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      // MediaStore.Downloads needs API 29; older devices keep the
      // DownloadManager anchor-click path (see FileViewer.downloadFile).
      throw IOException("DM_FALLBACK")
    }
    // Strip path separators like MainActivity does: a guessed name must never
    // escape DIRECTORY_DOWNLOADS, and MediaStore stores it verbatim.
    val name = rawName.substringAfterLast('/').ifBlank { "download" }
    val ext = name.substringAfterLast('.', "").lowercase()
    val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
      ?: "application/octet-stream"

    val conn = openFollowingRedirects(url)
    try {
      val code = conn.responseCode
      if (code !in 200..299) throw IOException("HTTP $code")

      val resolver = activity.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.MIME_TYPE, mime)
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IOException("MediaStore insert failed")
      try {
        resolver.openOutputStream(uri)?.use { out ->
          conn.inputStream.use { input ->
            val total = conn.contentLengthLong
            val buf = ByteArray(64 * 1024)
            var n = input.read(buf)
            var read = 0L
            var lastPct = -1
            while (n >= 0) {
              out.write(buf, 0, n)
              read += n
              if (total > 0) {
                val pct = ((read * 100) / total).toInt()
                if (pct != lastPct && pct < 100) {
                  lastPct = pct
                  emitProgress(read, total)
                }
              }
              n = input.read(buf)
            }
          }
        } ?: throw IOException("output stream unavailable")
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
      } catch (e: Exception) {
        // Drop the pending record so no 0-byte entry lingers in Downloads.
        resolver.delete(uri, null, null)
        throw e
      }
      return name
    } finally {
      conn.disconnect()
    }
  }
}
