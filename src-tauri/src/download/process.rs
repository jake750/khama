use super::*;

// ======================= تشغيل عملية مع إمكانية الإلغاء =======================

pub(crate) enum RunOutcome {
    Exited { success: bool, stderr: String },
    Canceled,
}

/// يوقف العملية وكل ما شغّلته (yt-dlp يشغّل ffmpeg، ونسخة Windows منه تشغّل نفسها مرتين)
pub(crate) async fn kill_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            let _ = tools::command(Path::new("taskkill"))
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output()
                .await;
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status().await;
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// ينتهي عندما يضغط المستخدم "إلغاء".
/// (دالة مستقلة حتى لا نُبقي قفل القناة محجوزًا أثناء انتظار أشياء أخرى)
pub(crate) async fn canceled(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|c| *c).await;
}

/// يشغّل أمرًا، ويمرّر كل سطر من مخرجاته إلى on_line، ويوقفه إن ضغط المستخدم إلغاء
pub(crate) async fn run_streaming(
    mut cmd: Command,
    cancel: &mut watch::Receiver<bool>,
    mut on_line: impl FnMut(&str),
) -> Result<RunOutcome, AppError> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // نجمع stderr في الخلفية (نحتفظ بآخر ~32KB فقط)
    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut r = BufReader::new(stderr).split(b'\n');
        while let Ok(Some(l)) = r.next_segment().await {
            buf.push_str(String::from_utf8_lossy(&l).trim_end_matches('\r'));
            buf.push('\n');
            // نحتفظ بآخر 2MB (نتائج الكشف عن المشاهد قد تكون طويلة)
            if buf.len() > 4_194_304 {
                let mut cut = buf.len() - 2_097_152;
                while !buf.is_char_boundary(cut) {
                    cut += 1;
                }
                buf.drain(..cut);
            }
        }
        buf
    });

    let mut lines = BufReader::new(stdout).split(b'\n');
    loop {
        tokio::select! {
            seg = lines.next_segment() => match seg {
                Ok(Some(l)) => on_line(String::from_utf8_lossy(&l).trim_end_matches('\r')),
                _ => break,
            },
            _ = canceled(cancel) => {
                kill_tree(&mut child).await;
                return Ok(RunOutcome::Canceled);
            }
        }
    }
    let status = tokio::select! {
        s = child.wait() => s?,
        _ = canceled(cancel) => {
            kill_tree(&mut child).await;
            return Ok(RunOutcome::Canceled);
        }
    };
    let stderr = err_task.await.unwrap_or_default();
    Ok(RunOutcome::Exited {
        success: status.success(),
        stderr,
    })
}
