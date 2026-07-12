import { describe, expect, it } from "vitest";
import { isExtractableArchive, previewModeFor } from "../fileTypes";

describe("previewModeFor", () => {
  it("routes pdf files to the pdf renderer", () => {
    expect(previewModeFor("pdf", "file")).toBe("pdf");
    // dirs never hit the pdf path even with a weird extension
    expect(previewModeFor("pdf", "dir")).toBe("thumbnail");
  });

  it("keeps the existing routes", () => {
    expect(previewModeFor("png", "file")).toBe("image");
    expect(previewModeFor("mp4", "file")).toBe("video");
    expect(previewModeFor("mp3", "file")).toBe("audio");
    expect(previewModeFor("ts", "file")).toBe("text");
    expect(previewModeFor("sketch", "file")).toBe("thumbnail");
  });
});

describe("isExtractableArchive", () => {
  it("accepts zip and the tar family", () => {
    expect(isExtractableArchive("a.zip", "zip")).toBe(true);
    expect(isExtractableArchive("a.tar", "tar")).toBe(true);
    expect(isExtractableArchive("a.tgz", "tgz")).toBe(true);
    // entry.ext for "x.tar.gz" is "gz" — the name-suffix check must carry it.
    expect(isExtractableArchive("x.tar.gz", "gz")).toBe(true);
    expect(isExtractableArchive("x.tar.bz2", "bz2")).toBe(true);
    expect(isExtractableArchive("x.tar.xz", "xz")).toBe(true);
  });

  it("is case-insensitive on compound suffixes", () => {
    expect(isExtractableArchive("X.TAR.GZ", "gz")).toBe(true);
    expect(isExtractableArchive("X.Tar.Bz2", "bz2")).toBe(true);
  });

  it("rejects lone .gz and unsupported archive types", () => {
    expect(isExtractableArchive("data.gz", "gz")).toBe(false);
    expect(isExtractableArchive("a.7z", "7z")).toBe(false);
    expect(isExtractableArchive("a.rar", "rar")).toBe(false);
    expect(isExtractableArchive("a.dmg", "dmg")).toBe(false);
    expect(isExtractableArchive("plain.txt", "txt")).toBe(false);
    expect(isExtractableArchive("noext", "")).toBe(false);
  });
});
