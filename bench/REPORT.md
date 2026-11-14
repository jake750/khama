# Khama PFE: raw material for the report

This file collects the material the report draws on: the theory with its equations, the method of
each experiment, and the results. Tables and figures are produced by the scripts in `bench/` and can be
regenerated (see `README.md`). Sections marked *(results)* are filled in from `results/*.csv`.

Suggested report outline: general introduction; study and critique of the existing application;
theoretical background; design of the solution; implementation; experiments and results;
conclusion and future work.

---

## 1. Study of the existing application (what was replaced and why)

Before the PFE, several technical decisions in Khama were fixed constants with no measurement behind them:

| Location | Constant | Problem |
|---|---|---|
| `download.rs` (stills), `convert.rs` (detect scenes) | FFmpeg `select='gt(scene,0.3)'` / `0.32` | One global threshold for every video; gradual transitions (dissolves, fades) give several small peaks, so they are either missed or reported many times; camera flashes are reported as cuts. |
| `convert.rs` `codec_args` | `global_quality = crf + 1` (QSV), `cq = crf + 1` (NVENC), `vq = 100 − 2·crf` (VideoToolbox) | Hardware quality scales are not the x264 CRF scale; "+1" was a guess, so the same preset could give a visibly different quality depending on the encoder. |
| `separate.rs` | chunk margin = n_fft/2, hard joins, `compensate = 1.021`, music = mix − voice | Taken as is from another implementation; never measured on a reference dataset. |

Each of the three axes below measures one of these decisions and replaces the constant with a justified value or algorithm.

---

## 2. Axis C: shot-boundary detection

### 2.1 Background

A *shot* is a continuous take; a *shot boundary* is either a **hard cut** (one frame to the next) or a
**gradual transition** over several frames (cross-dissolve, fade through black, wipe). Classic
detectors compare consecutive frames with a feature that is stable within a shot (colour statistics)
and changes across shots.

**Colour histogram.** Each pixel is converted from RGB to HSV:
$V = \max(R,G,B)$, $S = (V - \min(R,G,B)) / V$, and the hue $H$ is the angle on the colour wheel.
Hue is unstable for dark or grey pixels, so these go into separate "grey" bins indexed by $V$.
Khama uses $8 \times 3 \times 3$ colour bins plus 6 grey bins (78 bins).

**Soft binning.** With hard binning, a pixel whose colour drifts slightly can jump to the next bin, so a
slow change of light produces a large histogram distance. Khama spreads each pixel over the two nearest
bins on every axis with weights proportional to proximity (trilinear interpolation; hue is circular):
$$h_b = \frac{1}{N}\sum_{p} w_b(p), \qquad \sum_b w_b(p) = 1 .$$

**Distance.** For normalised histograms $p, q$:
$$D(p,q) = \tfrac12 \sum_b |p_b - q_b| = 1 - \sum_b \min(p_b, q_b) \in [0,1]$$
(half the L1 distance, equal to one minus the histogram intersection).

Global histograms ignore *where* colours are, so two different shots with the same palette look identical.
Khama also computes histograms on a $3\times3$ grid of blocks and combines both:
$$d(t) = \alpha\, D(H_t, H_{t-1}) + (1-\alpha)\,\frac{1}{9}\sum_{b=1}^{9} D(H^b_t, H^b_{t-1}).$$

### 2.2 Adaptive threshold for cuts

A fixed threshold fails because the level of $d(t)$ depends on the content (fast motion vs. a static
interview). Khama computes the statistics of $d$ on a sliding window around $t$ (excluding $t-1..t+1$, so a
cut does not raise its own threshold) and declares a cut when
$$d(t) \ge \max\big(\tau_{min},\; c(t) + k\, s(t)\big)$$
and $d(t)$ is the maximum over $t\pm2$. Two estimators were compared:
- mean and standard deviation, $c = \mu$, $s = \sigma$;
- the robust pair median and scaled MAD, $c = \operatorname{med}(d)$, $s = 1.4826\,\operatorname{med}|d - \operatorname{med}(d)|$,
  which is not inflated by other cuts in the window.

**Structural signal.** Histograms ignore spatial layout, so a cut between two shots of the same scene
(same palette, different framing) is almost invisible to them. Khama also keeps a $32\times18$ luma
thumbnail $Y_t$ of every frame and measures
$$e(t) = \frac{1}{|\Omega|}\sum_{x\in\Omega} \frac{|Y_t(x) - Y_{t-1}(x)|}{255},$$
which is large when the image *structure* changes even if the colours do not. $e$ has its own adaptive
threshold, $e(t) \ge \max(\epsilon_{min},\; c_e(t) + k_{pix}\, s_e(t))$, computed the same way. A cut is
reported when either signal fires (and is a local maximum of that signal).

**Flash rejection.** A flash changes frame $t$ but the frames after it resemble the frames before it. With
$\delta(i,j) = \max\big(D(f_i,f_j),\, e(i,j)\big)$ the combined change between two frames, a candidate at $t$
with strength $\delta(t-1,t)$ is rejected when
$$\min_{j=1..3} \delta(t-1, t+j) < 0.35\,\delta(t-1,t) \quad\text{(start of a flash)}$$
$$\text{or}\quad \min_{j=1..3} \delta(t-1-j, t) < 0.35\,\delta(t-1,t) \quad\text{(end of a flash: frame } t \text{ resembles the frames before the flash)}.$$
A candidate between two flat frames (a black gap inside a fade) is also rejected.

### 2.3 Gradual transitions: adaptive twin comparison

During a dissolve each $d(t)$ is small but the change accumulates. Khama's version of *twin comparison*
(Zhang, Kankanhalli and Smoliar, 1993):
1. a run starts when $d(t)$ exceeds a **low threshold** $T_{low} = \max(\ell_{min}, c_p + k_{low}\, s_p)$,
   computed on the frames *before* $t$ only (causal window) and kept fixed during the run, because the
   transition frames must not raise their own threshold;
2. the run continues while $d$ stays above $T_{low}$ (one quiet frame tolerated);
3. the run is a transition if it lasts at least $L_{min}$ frames and the accumulated change between its
   first and last frame, $D(f_s, f_e)$, exceeds $G_{min}$ (this rejects slow camera motion, where
   consecutive changes are small and the colours do not change overall).

Fades through black: the fade-out and fade-in are merged into one transition when only flat frames
(luma standard deviation < 6/255) separate them, and a fade at the very start or end of the video is not a boundary.

### 2.4 Evaluation method

- **Synthetic dataset with exact labels** (`scenes/make_dataset.py`), the approach used to train and test
  TransNet and DeepSBD:
  - Real footage is taken from the open Xiph.org clips.
  - It is split into random shots of 1.2–3.4 s and joined by hard cuts (55 %), cross-dissolves (16 %),
    fades through black (14 %) or wipes (15 %).
  - Hard cases are included: 10 % of cuts join two parts of the same clip, and 25 % of shots contain a
    1–2-frame camera flash, which the detector must not report.
  - Each video is encoded with x264, CRF 20.
- **Matching:** a detection matches a labelled transition when their frame spans overlap within ±2 frames,
  one-to-one. $P = \frac{TP}{TP+FP}$, $R = \frac{TP}{TP+FN}$, $F_1 = \frac{2PR}{P+R}$.
- **Protocol:** parameters are tuned on the first half of the videos ("dev") and all reported numbers come
  from the second half ("test"). The search has two stages:
  1. cut settings with gradual detection off: 216 colour-only configurations ($\alpha$, $k$, estimator,
     $\tau_{min}$, window) and 128 with the structural signal ($k_{pix}$, $\epsilon_{min}$);
  2. gradual settings ($k_{low}$, $G_{min}$, $\ell_{min}$; 27 configurations) on top of the best stage-1 setting.
  An ablation study then switches off one component of the final detector at a time.
- **Baseline:** the app's previous detector, FFmpeg `select='gt(scene,T)'` on frames scaled to 320 px,
  with $T$ swept from 0.05 to 0.6.
- **Real editing:** the Sintel trailer (CC-BY), labelled by hand.

### 2.5 Results *(results)*

See `results/scenes_test.csv`, `results/scenes_pr.png`, `results/scenes_speed.csv`.

---

## 3. Axis A: compression study and calibration of hardware encoders

### 3.1 Quality metrics

**PSNR.** For 8-bit video, $\mathrm{MSE} = \frac{1}{N}\sum (x_i - y_i)^2$ and
$$\mathrm{PSNR} = 10 \log_{10}\frac{255^2}{\mathrm{MSE}}\ \text{dB}.$$
For 4:2:0 video the planes are combined with weights 4:1:1, $\mathrm{PSNR}_{YUV} = (4\,\mathrm{PSNR}_Y + \mathrm{PSNR}_U + \mathrm{PSNR}_V)/6$.

**SSIM** (Wang et al., 2004) compares local luminance, contrast and structure:
$$\mathrm{SSIM}(x,y) = \frac{(2\mu_x\mu_y + C_1)(2\sigma_{xy} + C_2)}{(\mu_x^2+\mu_y^2+C_1)(\sigma_x^2+\sigma_y^2+C_2)},$$
averaged over local windows and frames.

**VMAF** (Netflix): a support-vector regression that fuses elementary features into a 0–100 score trained on
subjective opinion scores. The features are Visual Information Fidelity at 4 scales, the Detail Loss Metric,
and a temporal motion feature. Model `vmaf_v0.6.1`, viewing at 1080p-equivalent distance. VMAF ≈ 93–95 is
commonly used as "visually transparent" for streaming. We report the mean and the 5th percentile over frames.

### 3.2 Rate-distortion and BD-rate

Each encoder is run over a grid of its quality parameter (CRF / global_quality), giving points
$(R_i, Q_i)$ (bitrate, quality): its RD curve. To compare two encoders with one number, the
**Bjøntegaard delta rate** averages the horizontal gap between the curves over their common quality range
$[Q_{lo}, Q_{hi}]$:
$$\Delta R = \exp\!\left(\frac{1}{Q_{hi}-Q_{lo}}\int_{Q_{lo}}^{Q_{hi}} \big[\ln R_{test}(Q) - \ln R_{ref}(Q)\big]\,dQ\right) - 1 .$$
$\ln R(Q)$ is interpolated with a monotone piecewise-cubic (PCHIP), as in current practice, instead of
Bjøntegaard's original cubic polynomial, which can oscillate. $\Delta R = -30\%$ means the test encoder
needs 30 % fewer bits for the same quality. BD-rate is computed per clip, then averaged.

### 3.3 Calibration of the hardware quality scale

For each CRF value $c$ used by a Khama preset and each clip $k$:
1. compute the target quality $V^*_k(c) = \mathrm{VMAF}_{x264}(c)$ by interpolation on the software curve;
2. invert the monotone hardware curve $\mathrm{VMAF}_{hw}(q)$ to find $q_k(c)$ with $\mathrm{VMAF}_{hw}(q_k) = V^*_k$;
3. take the median over clips, $q(c) = \operatorname{med}_k q_k(c)$ (robust to one atypical clip), and keep the min–max as the spread.

The table $c \mapsto q(c)$ replaces `crf + 1` in `codec_args`. H.264 hardware is matched to libx264,
HEVC hardware to libx265 (the reference that Khama's HEVC preset uses).

### 3.4 Test material and machine

The test material is 12 open Xiph.org sequences, 4 s each, stored losslessly at 720p. They cover fast motion,
camera pans, fine detail and printed text, water texture, low motion, talking heads, and screen content
(game UI).

The test machine is an i5-1135G7 with Iris Xe. Only Quick Sync H.264 and HEVC can be measured:
- NVENC is unavailable (driver API 13.0 < required 13.1; the MX350 has no NVENC block).
- Tiger Lake cannot encode AV1 in hardware.

### 3.5 Results *(results)*

See `results/codecs_bdrate.csv`, `results/codecs_calibration.csv`, `results/codecs_rd_vmaf.png`, `results/codecs_calibration.png`.

---

## 4. Axis B: evaluation of the voice/music separation

### 4.1 Short-time Fourier transform

Khama implements the STFT and its inverse itself (Rust, `rustfft`), to match the model's training front-end
(PyTorch `torch.stft`, `center=True`, periodic Hann window). With window $w$ of length $N = 7680$ and hop $H = 1024$:
$$X(m, k) = \sum_{n=0}^{N-1} x(n + mH)\, w(n)\, e^{-j 2\pi k n / N}, \qquad w(n) = \tfrac12 - \tfrac12 \cos\frac{2\pi n}{N}.$$
The signal is reflect-padded by $N/2$ on both sides. Only the first 3072 bins are given to the model
(up to $3072 \cdot 44100 / 7680 \approx 17.6$ kHz). The inverse uses weighted overlap-add:
$$\hat x(n) = \frac{\sum_m w(n - mH)\, \mathrm{IDFT}\{Y(m,\cdot)\}(n - mH)}{\sum_m w^2(n - mH)},$$
which reconstructs $x$ exactly when $Y = X$ (test `stft_roundtrip`, error < $10^{-3}$).

### 4.2 Model and chunking

UVR-MDX-NET-Voc_FT (ONNX) maps the complex spectrogram of a 256-frame chunk (5.92 s) to the spectrogram of
the vocals. Long signals are cut into chunks:
- Each chunk keeps its centre and discards a **margin** at both edges, where the model lacks context.
- Successive kept regions can share an **overlap**, cross-faded with complementary raised-cosine weights
  $w_{in}(i) = \sin^2\!\big(\frac{\pi}{2}\frac{i + 1/2}{O}\big)$, $w_{out} = 1 - w_{in}$, so that $w_{in} + w_{out} = 1$.

**Deriving the accompaniment:**
- *Subtraction:* $\hat m = x - \hat v$.
- *Soft mask (Wiener-like):* $M = \frac{|\hat V|^2}{|\hat V|^2 + |X - \hat V|^2}$, then $\hat V' = M X$ and
  $\hat M = (1 - M) X$. This guarantees $\hat v' + \hat m = x$ and keeps the phase of the mixture.

### 4.3 Metrics: BSS Eval v4

The estimate is decomposed as $\hat s = s_{target} + e_{interf} + e_{artif}$, using time-invariant
512-tap distortion filters on 1 s windows (museval), and
$$\mathrm{SDR} = 10\log_{10}\frac{\|s_{target}\|^2}{\|e_{interf} + e_{artif}\|^2},\quad
\mathrm{SIR} = 10\log_{10}\frac{\|s_{target}\|^2}{\|e_{interf}\|^2},\quad
\mathrm{SAR} = 10\log_{10}\frac{\|s_{target} + e_{interf}\|^2}{\|e_{artif}\|^2}.$$
Following SiSEC 2018, each track is summarised by the median over windows, and the dataset by the median
over tracks.

We also report a **join SNR**: the SNR of the vocal estimate within ±0.1 s of each point where two chunks
meet, where the margin and overlap settings act.

### 4.4 Dataset and protocol

The dataset is the MUSDB18 test subset (50 tracks), 7-second previews, 44.1 kHz stereo; it is for academic
use only. Every configuration is run by the app's own Rust code through `khama-bench separate`, which
produces both stems in a single model pass. Processing time is reported as the real-time factor
(RTF = processing time / audio duration), with the peak memory of the process.

### 4.5 Results *(results)*

See `results/separation.csv`, `results/separation.png`.

---

## 5. References

- H. Zhang, A. Kankanhalli, S. Smoliar, "Automatic partitioning of full-motion video", *Multimedia Systems*, 1993 (twin comparison).
- A. Hanjalic, "Shot-boundary detection: unraveled and resolved?", *IEEE TCSVT*, 2002.
- T. Souček, J. Lokoč, "TransNet V2: an effective deep network architecture for fast shot transition detection", 2020.
- M. Gygli, "Ridiculously fast shot boundary detection with fully convolutional neural networks", 2018.
- Z. Wang, A. Bovik, H. Sheikh, E. Simoncelli, "Image quality assessment: from error visibility to structural similarity", *IEEE TIP*, 2004.
- Z. Li et al., "Toward a practical perceptual video quality metric", Netflix Tech Blog, 2016 (VMAF).
- G. Bjøntegaard, "Calculation of average PSNR differences between RD-curves", VCEG-M33, 2001.
- E. Vincent, R. Gribonval, C. Févotte, "Performance measurement in blind audio source separation", *IEEE TASLP*, 2006.
- F.-R. Stöter, A. Liutkus, N. Ito, "The 2018 signal separation evaluation campaign", LVA/ICA 2018 (BSS Eval v4, museval).
- Z. Rafii et al., "MUSDB18 — a corpus for music separation", 2017.
- Y. Mitsufuji et al., "Music Demixing Challenge 2021" (MDX-Net); D. Kim, "KUIELab-MDX-Net", 2021.
