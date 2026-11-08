package com.jake750.khama

import android.app.Activity
import android.content.ContentValues
import android.media.MediaScannerConnection
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
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import java.io.File
import kotlin.concurrent.thread

@InvokeArg
class PublishArgs {
    lateinit var path: String
}

/**
 * جسر صغير بين Rust وأندرويد:
 * - setup: يفكّ Python و yt-dlp و FFmpeg (من مكتبة youtubedl-android) ويعيد مساراتها،
 *   ثم يشغّلها كود Rust نفسه الذي يعمل على الكمبيوتر.
 * - updateYtdlp: يحدّث yt-dlp عند طلب المستخدم فقط.
 * - publish: ينقل الملف المنتهي إلى مجلد Download/Khama العام ليظهر في المعرض ومدير الملفات.
 */
@TauriPlugin
class ToolsPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun setup(invoke: Invoke) {
        thread {
            try {
                val ctx = activity.applicationContext
                YoutubeDL.init(ctx)
                FFmpeg.init(ctx)
                // نفس المسارات التي تستعملها المكتبة داخليًا
                val base = File(ctx.noBackupFilesDir, "youtubedl-android")
                val packages = File(base, "packages")
                val bin = ctx.applicationInfo.nativeLibraryDir
                val python = File(packages, "python").absolutePath
                val ffmpegDir = File(packages, "ffmpeg").absolutePath
                val env = JSObject()
                env.put("LD_LIBRARY_PATH", "$python/usr/lib:$ffmpegDir/usr/lib")
                env.put("SSL_CERT_FILE", "$python/usr/etc/tls/cert.pem")
                env.put("PYTHONHOME", "$python/usr")
                env.put("HOME", "$python/usr")
                env.put("TMPDIR", ctx.cacheDir.absolutePath)
                env.put("PATH", (System.getenv("PATH") ?: "") + ":" + bin)
                val ret = JSObject()
                ret.put("python", "$bin/libpython.so")
                ret.put("ytdlp", File(File(base, "yt-dlp"), "yt-dlp").absolutePath)
                ret.put("ffmpeg", "$bin/libffmpeg.so")
                // محرّك JavaScript صغير يحتاجه yt-dlp ليوتيوب (بديل Deno على الكمبيوتر)
                ret.put("quickjs", "$bin/libqjs.so")
                ret.put("env", env)
                invoke.resolve(ret)
            } catch (e: Throwable) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    @Command
    fun updateYtdlp(invoke: Invoke) {
        thread {
            try {
                val ctx = activity.applicationContext
                val status = YoutubeDL.updateYoutubeDL(ctx, YoutubeDL.UpdateChannel.STABLE)
                val ret = JSObject()
                ret.put("updated", status == YoutubeDL.UpdateStatus.DONE)
                ret.put("version", YoutubeDL.versionName(ctx))
                invoke.resolve(ret)
            } catch (e: Throwable) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    @Command
    fun publish(invoke: Invoke) {
        val args = invoke.parseArgs(PublishArgs::class.java)
        thread {
            try {
                val src = File(args.path)
                val ext = src.extension.lowercase()
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
                val ret = JSObject()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val resolver = activity.contentResolver
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, src.name)
                        put(MediaStore.Downloads.MIME_TYPE, mime)
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Khama")
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: throw IllegalStateException("MediaStore insert failed")
                    resolver.openOutputStream(uri).use { out ->
                        src.inputStream().use { it.copyTo(out!!) }
                    }
                    values.clear()
                    values.put(MediaStore.Downloads.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                    ret.put("uri", uri.toString())
                    ret.put("path", Environment.DIRECTORY_DOWNLOADS + "/Khama/" + src.name)
                } else {
                    @Suppress("DEPRECATION")
                    val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Khama")
                    dir.mkdirs()
                    var dest = File(dir, src.name)
                    var n = 2
                    while (dest.exists()) {
                        dest = File(dir, "${src.nameWithoutExtension} ($n).${src.extension}")
                        n++
                    }
                    src.copyTo(dest)
                    MediaScannerConnection.scanFile(activity, arrayOf(dest.absolutePath), arrayOf(mime), null)
                    ret.put("uri", dest.toURI().toString())
                    ret.put("path", dest.absolutePath)
                }
                src.delete()
                invoke.resolve(ret)
            } catch (e: Throwable) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }
}
