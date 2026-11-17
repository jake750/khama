use super::*;

// ======================= تشغيل عملية مع إمكانية الإلغاء =======================

pub(crate) enum RunOutcome {
    Exited { success: bool, stderr: String },
    Canceled,
}

/// على Windows: كل عملية نشغّلها توضع في Job Object، وما تشغّله بعدها (ffmpeg من yt-dlp مثلًا)
/// يدخله تلقائيًا. الإلغاء = TerminateJobObject للشجرة كلها، بلا تشغيل taskkill في كل مرة (T-98).
/// والـ Job معلَّم KILL_ON_JOB_CLOSE: إغلاقه (أو انهيار خامة) لا يترك عمليات يتيمة.
#[cfg(windows)]
mod job {
    use crate::errors::LockExt;
    use std::{collections::HashMap, sync::Mutex};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        },
    };

    /// pid ← مقبض الـ Job (رقمًا، لأن HANDLE مؤشر لا يُرسل بين الخيوط)
    static JOBS: Mutex<Option<HashMap<u32, isize>>> = Mutex::new(None);

    pub fn attach(child: &tokio::process::Child) {
        let (Some(pid), Some(proc_handle)) = (child.id(), child.raw_handle()) else {
            return;
        };
        // SAFETY: كل المؤشرات صالحة أو null حيث يسمح النظام، والمقبض يُغلق في release
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            let ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&raw const info).cast(), size) != 0
                && AssignProcessToJobObject(job, proc_handle as HANDLE) != 0;
            if !ok {
                CloseHandle(job);
                return;
            }
            JOBS.lock_ok().get_or_insert_with(HashMap::new).insert(pid, job as isize);
        }
    }

    /// يقتل الشجرة. false = لا Job لهذه العملية (يُستعمل taskkill بدلًا منه)
    pub fn terminate(pid: u32) -> bool {
        let Some(job) = JOBS.lock_ok().as_mut().and_then(|m| m.remove(&pid)) else {
            return false;
        };
        // SAFETY: المقبض أنشأناه في attach ولم يُغلق بعد (أُزيل من الخريطة للتو)
        unsafe {
            TerminateJobObject(job as HANDLE, 1);
            CloseHandle(job as HANDLE);
        }
        true
    }

    /// العملية انتهت: نغلق المقبض (فيُقتل أي حفيد بقي معلّقًا بعدها)
    pub fn release(pid: u32) {
        if let Some(job) = JOBS.lock_ok().as_mut().and_then(|m| m.remove(&pid)) {
            // SAFETY: كما في terminate
            unsafe { CloseHandle(job as HANDLE) };
        }
    }
}

/// يشغّل الأمر ويضمّه إلى مجموعة يمكن قتلها كاملة (انظر kill_tree)
pub(crate) fn spawn_tree(cmd: &mut Command) -> std::io::Result<TreeChild> {
    let child = cmd.spawn()?;
    #[cfg(windows)]
    job::attach(&child);
    let pid = child.id();
    Ok(TreeChild(child, pid))
}

/// عملية شغّلها spawn_tree، ورقمها (Child::id يصبح None بعد انتهائها). عند إسقاطها يُغلق الـ Job
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct TreeChild(pub Child, Option<u32>);

impl std::ops::Deref for TreeChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.0
    }
}

impl std::ops::DerefMut for TreeChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}

impl Drop for TreeChild {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(pid) = self.1 {
            job::release(pid);
        }
    }
}

/// يوقف العملية وكل ما شغّلته (yt-dlp يشغّل ffmpeg، ونسخة Windows منه تشغّل نفسها مرتين)
pub(crate) async fn kill_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        if !job::terminate(pid) {
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
            if let Ok(pgid) = libc::pid_t::try_from(pid)
                && pgid > 1
            {
                // SAFETY: إشارة لمجموعة عمليات نحن أنشأناها، والرقم أكبر من 1 (لا -1 ولا init)
                unsafe { libc::killpg(pgid, libc::SIGKILL) };
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
    let mut child = spawn_tree(cmd.stdout(Stdio::piped()).stderr(Stdio::piped()))?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // الترميز (T-94): yt-dlp يطبع UTF-8 (PYTHONUTF8=1)، وFFmpeg يطبع المسارات UTF-8 في كل الأنظمة
    // (على Windows يأخذ وسائطه UTF-16 من النظام ويحوّلها). فـ from_utf8_lossy لا يستبدل إلا بايتات
    // تالفة فعلًا. اختبار ffmpeg_output_keeps_arabic_file_names يتحقق بالأداة الحقيقية.
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
