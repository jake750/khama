#!/bin/sh
# Builds a fixed set of short test files for the converter and its suggestions (M-66).
# Generated, not downloaded, so they are the same on every machine and need no license.
#   sh scripts/make-samples.sh [output folder]     (default: samples/, which git ignores)
set -e
cd "$(dirname "$0")/.."
out=${1:-samples}
mkdir -p "$out"
ff=src-tauri/binaries/ffmpeg/bin/ffmpeg
[ -x "$ff" ] || [ -x "$ff.exe" ] || ff=ffmpeg
q="-hide_banner -loglevel error -y"
tone="sine=frequency=440:sample_rate=48000"

# 1. Plain 1080p30 H.264 + AAC: the baseline every preset must handle
$ff $q -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=10 -f lavfi -i "$tone:duration=10" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$out/01-cfr-1080p-h264.mp4"

# 2. Variable frame rate like a phone recording: Khama should suggest "H.264 for editing"
$ff $q -f lavfi -i testsrc2=size=1280x720:rate=60:duration=10 -f lavfi -i "$tone:duration=10" \
  -vf "select='not(mod(n\,3))+not(mod(n\,7))'" -fps_mode vfr \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$out/02-vfr-phone.mp4"

# 3. 10-bit HDR (PQ, BT.2020) HEVC: tone mapping and the HDR hint
$ff $q -f lavfi -i testsrc2=size=1920x1080:rate=25:duration=6 \
  -c:v libx265 -pix_fmt yuv420p10le \
  -x265-params "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:hdr10=1" "$out/03-hdr-10bit-hevc.mkv"

# 4. ProRes 4444 with transparency: alpha must survive "ProRes 4444"
$ff $q -f lavfi -i "testsrc2=size=1280x720:rate=25:duration=4,format=yuva444p10le,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(X,W/2),255,0)'" \
  -c:v prores_ks -profile:v 4 "$out/04-prores4444-alpha.mov"

# 5. Scene cuts, black frames and silence: for "Find scene cuts / black frames / silences"
#    Expected: cuts near 3 s and 6 s, black 3–4 s, silence 6–8 s
$ff $q -f lavfi -i testsrc2=size=1280x720:rate=30:duration=3 -f lavfi -i color=black:size=1280x720:rate=30:duration=1 \
  -f lavfi -i smptebars=size=1280x720:rate=30:duration=2 -f lavfi -i mandelbrot=size=1280x720:rate=30 \
  -f lavfi -i "$tone:duration=6" -f lavfi -i anullsrc=r=48000:cl=mono \
  -filter_complex "[3:v]trim=duration=3,setpts=PTS-STARTPTS[m];[0:v][1:v][2:v][m]concat=n=4:v=1:a=0[v];[5:a]atrim=duration=2[s];[4:a][s]concat=n=2:v=0:a=1,apad=whole_dur=9[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac -t 9 "$out/05-cuts-black-silence.mp4"

# 6. Loud and quiet audio: loudness normalisation should bring both near -14 LUFS
$ff $q -f lavfi -i "$tone:duration=5" -af "volume=-30dB" -c:a pcm_s16le "$out/06-quiet.wav"
$ff $q -f lavfi -i "$tone:duration=5" -af "volume=6dB,alimiter" -c:a pcm_s16le "$out/06-loud.wav"

# 7. Phone video stored landscape with a 90° rotation flag: the output must come out upright
$ff $q -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=5 -c:v libx264 -pix_fmt yuv420p "$out/tmp.mp4"
$ff $q -display_rotation 90 -i "$out/tmp.mp4" -c copy "$out/07-rotated-phone.mp4"
rm "$out/tmp.mp4"

# 8. A name Windows and editors struggle with
$ff $q -f lavfi -i testsrc2=size=640x360:rate=30:duration=2 -c:v libx264 -pix_fmt yuv420p \
  "$out/08-اسم عربي طويل جدًا مع رموز 🎬 & (نسخة نهائية) final FINAL v2.mp4"

ls -l "$out"
