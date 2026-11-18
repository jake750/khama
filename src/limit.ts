/**
 * يحدّ عدد المهام المتزامنة: إضافة 200 ملف لا تشغّل 200 ffprobe معًا (U-93).
 * run(fn) يُرجع وعد fn، ويبدأها حين يفرغ مكان.
 */
export function limiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    running--;
    waiting.shift()?.();
  };
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const go = () => {
        running++;
        fn().then(resolve, reject).finally(next);
      };
      if (running < max) go();
      else waiting.push(go);
    });
  };
}
