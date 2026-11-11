package com.jake750.khama

import android.app.Activity
import android.content.ContentValues
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
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
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

@InvokeArg
class PublishArgs {
    lateinit var path: String
    /** مجلد فرعي داخل Download/Khama (مثل مجلد اللقطات الثابتة) */
    var subdir: String? = null
}

@InvokeArg
class FetchArgs {
    lateinit var url: String
    lateinit var dest: String
}

@InvokeArg
class ImportArgs {
    lateinit var uri: String
    /** المجلد الذي نضع فيه النسخة (داخل التطبيق) */
    lateinit var dir: String
}

/**
 * جسر صغير بين Rust وأندرويد:
 * - setup: يفكّ Python و yt-dlp و FFmpeg (من مكتبة youtubedl-android) ويعيد مساراتها،
 *   ثم يشغّلها كود Rust نفسه الذي يعمل على الكمبيوتر.
 * - updateYtdlp: يحدّث yt-dlp عند طلب المستخدم فقط.
 * - publish: ينقل الملف المنتهي إلى مجلد Download/Khama العام ليظهر في المعرض ومدير الملفات.
 * - importFile: ينسخ ملفًا اختاره المستخدم داخل التطبيق (للمحوّل).
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
                ret.put("ffprobe", "$bin/libffprobe.so")
                // مكتبة ONNX Runtime (لإزالة الموسيقى) مضمّنة هنا
                ret.put("libdir", bin)
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
                val sub = args.subdir?.replace("/", "_")?.trim()?.takeIf { it.isNotEmpty() }
                val rel = Environment.DIRECTORY_DOWNLOADS + "/Khama" + (if (sub != null) "/$sub" else "")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val resolver = activity.contentResolver
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, src.name)
                        put(MediaStore.Downloads.MIME_TYPE, mime)
                        put(MediaStore.Downloads.RELATIVE_PATH, rel)
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
                    // الاسم الفعلي (أندرويد يضيف " (1)" إن وُجد ملف بنفس الاسم)
                    var name = src.name
                    resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { c ->
                        if (c.moveToFirst()) name = c.getString(0) ?: name
                    }
                    ret.put("uri", uri.toString())
                    // مسار كامل: يمكن للتطبيق قراءة ملفاته من جديد (مثلًا لإرسالها للمحوّل)
                    @Suppress("DEPRECATION")
                    ret.put("path", File(File(Environment.getExternalStorageDirectory(), rel), name).absolutePath)
                } else {
                    @Suppress("DEPRECATION")
                    val dir = File(Environment.getExternalStorageDirectory(), rel)
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

    /** ملف اختاره المستخدم (content://...): ننسخه داخل التطبيق باسمه الحقيقي ليقرأه ffmpeg */
    @Command
    fun importFile(invoke: Invoke) {
        val args = invoke.parseArgs(ImportArgs::class.java)
        thread {
            try {
                val uri = Uri.parse(args.uri)
                val resolver = activity.contentResolver
                var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0)?.let { name = it }
                }
                name = name.replace("/", "_")
                val dir = File(args.dir)
                dir.mkdirs()
                val dest = File(dir, name)
                resolver.openInputStream(uri).use { input ->
                    if (input == null) throw IllegalStateException("cannot open $uri")
                    dest.outputStream().use { input.copyTo(it, 1 shl 20) }
                }
                val ret = JSObject()
                ret.put("path", dest.absolutePath)
                invoke.resolve(ret)
            } catch (e: Throwable) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    private val fetchCancel = AtomicBoolean(false)

    /**
     * ينزّل ملفًا كبيرًا (نموذج الذكاء الاصطناعي) بشبكة أندرويد نفسها، ويكتبه في dest أثناء التنزيل
     * (Rust يقيس حجمه لعرض التقدّم). ينتهي عند الاكتمال، أو برفض عند الخطأ أو الإلغاء.
     */
    @Command
    fun fetchFile(invoke: Invoke) {
        val args = invoke.parseArgs(FetchArgs::class.java)
        fetchCancel.set(false)
        thread {
            val dest = File(args.dest)
            try {
                var url = URL(args.url)
                var conn: HttpURLConnection
                var hops = 0
                // نتبع التحويلات يدويًا (GitHub يحوّل من https إلى https على نطاق آخر)
                while (true) {
                    conn = url.openConnection() as HttpURLConnection
                    conn.instanceFollowRedirects = false
                    conn.connectTimeout = 30000
                    conn.readTimeout = 60000
                    conn.setRequestProperty("User-Agent", "Khama")
                    val code = conn.responseCode
                    if (code in 300..399 && hops < 8) {
                        url = URL(url, conn.getHeaderField("Location"))
                        conn.disconnect()
                        hops++
                        continue
                    }
                    if (code !in 200..299) throw IllegalStateException("HTTP $code")
                    break
                }
                dest.parentFile?.mkdirs()
                conn.inputStream.use { input ->
                    dest.outputStream().use { out ->
                        val buf = ByteArray(1 shl 16)
                        while (true) {
                            if (fetchCancel.get()) throw InterruptedException("canceled")
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                        }
                    }
                }
                conn.disconnect()
                invoke.resolve(JSObject())
            } catch (e: Throwable) {
                dest.delete()
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    @Command
    fun cancelFetch(invoke: Invoke) {
        fetchCancel.set(true)
        invoke.resolve(JSObject())
    }
}
