# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# youtubedl-android: extracts Python/FFmpeg zips with commons-compress and parses
# yt-dlp output with Jackson, both reflection-heavy; R8 breaks them in release.
-keep class com.yausername.** { *; }
-keep class org.apache.commons.compress.** { *; }
-keep class com.fasterxml.jackson.** { *; }
-dontwarn org.apache.commons.compress.**
-dontwarn com.fasterxml.jackson.**
-dontwarn com.yausername.**
-keep class com.jake750.khama.** { *; }
