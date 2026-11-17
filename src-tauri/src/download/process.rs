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
            // نداء النظام مباشرة لا أمر kill: نسخة procps على Linux تقرأ «-1234» خيارات
            // رقمًا رقمًا فتنفّذ kill(-1) وتقتل كل عمليات المستخدم (وكانت تُسقط مشغّل CI).
            // العملية قائدة مجموعتها (tools::command يضع process_group(0))، فالمجموعة = pid
            if let Ok(pgid) = libc::pid_t::try_from(pid) {
                if pgid > 1 {
                    unsafe { libc::killpg(pgid, libc::SIGKILL) };
                }
            }
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

/// مهلة الصمت: yt-dlp وFFmpeg يطبعان التقدّم عدة مرات في الثانية (--newline، -progress)،
/// فعملية لم تطبع سطرًا واحدًا 15 دقيقة عالقة، تُقتل ويظهر خطأ بدل انتظار بلا نهاية (T-93).
/// مهلة صمت لا حدّ للمدة الكلية، فتحويل طويل يبقى سليمًا ما دام يتقدّم.
const STALL_AFTER: Duration = Duration::from_secs(15 * 60);

/// يشغّل أمرًا، ويمرّر كل سطر من مخرجاته إلى on_line، ويوقفه إن ضغط المستخدم إلغاء
pub(crate) async fn run_streaming(
    mut cmd: Command,
    cancel: &mut watch::Receiver<bool>,
    mut on_line: impl FnMut(&str),
) -> Result<RunOutcome, AppError> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // نجمع stderr في الخلفية؛ نحتفظ بآخر 2 إلى 4 ميغابايت (انظر أسفل) لأن نتائج كشف المشاهد تأتي فيه (T-64)
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
            seg = tokio::time::timeout(STALL_AFTER, lines.next_segment()) => match seg {
                Ok(Ok(Some(l))) => on_line(String::from_utf8_lossy(&l).trim_end_matches('\r')),
                // لا سطر واحد طوال المهلة: العملية عالقة (T-93)
                Err(_) => {
                    kill_tree(&mut child).await;
                    return Err(AppError::with_detail("processStalled", format!("no output for {}s", STALL_AFTER.as_secs())));
                }
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
