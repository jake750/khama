import { describe, expect, it } from "vitest";
import type { Settings } from "./api";
import { applyProject, snapshotProject } from "./projects";

const s = {
  outputDir: "D:/قناتي",
  kind: "audio",
  videoFormat: "mov",
  audioFormat: "wav",
  quality: "720",
  editorReady: false,
  filenameTemplate: "{n} {title}",
  siteFolders: true,
  language: "ar",
} as Settings;

describe("المشاريع (T-56)", () => {
  it("الحفظ ثم التطبيق يعيد نفس الخيارات", () => {
    const p = snapshotProject(s, "id-1", "قناتي");
    expect(p).toMatchObject({ id: "id-1", name: "قناتي", outputDir: "D:/قناتي", quality: "720", siteFolders: true });
    expect(p).not.toHaveProperty("language");
    expect(applyProject(p)).toEqual({
      activeProject: "id-1",
      outputDir: "D:/قناتي",
      kind: "audio",
      videoFormat: "mov",
      audioFormat: "wav",
      quality: "720",
      editorReady: false,
      filenameTemplate: "{n} {title}",
      siteFolders: true,
    });
  });
});
