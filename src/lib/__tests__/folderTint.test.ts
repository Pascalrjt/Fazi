import { describe, expect, it } from "vitest";
import { isPlainFolder, isPlainFolderHit } from "../folderTint";

const dir = { kind: "dir" as const, isPackage: false, customIcon: false, path: "/Users/me/Projects" };

describe("isPlainFolder", () => {
  it("tints a plain folder", () => {
    expect(isPlainFolder(dir)).toBe(true);
  });

  it("leaves files, packages, custom icons, and volumes alone", () => {
    expect(isPlainFolder({ ...dir, kind: "file" })).toBe(false);
    expect(isPlainFolder({ ...dir, isPackage: true })).toBe(false);
    expect(isPlainFolder({ ...dir, customIcon: true })).toBe(false);
    expect(isPlainFolder({ ...dir, path: "/Volumes/Backup" })).toBe(false);
    expect(isPlainFolder({ ...dir, path: "/Volumes/Backup/Photos" })).toBe(true);
  });
});

describe("isPlainFolderHit", () => {
  it("tints folders without an extension", () => {
    expect(isPlainFolderHit({ isDir: true, name: "Projects", path: "/Users/me/Projects" })).toBe(true);
    expect(isPlainFolderHit({ isDir: true, name: ".config", path: "/Users/me/.config" })).toBe(true);
  });

  it("skips likely packages, files, and volumes", () => {
    expect(isPlainFolderHit({ isDir: true, name: "Safari.app", path: "/Applications/Safari.app" })).toBe(false);
    expect(isPlainFolderHit({ isDir: false, name: "notes", path: "/Users/me/notes" })).toBe(false);
    expect(isPlainFolderHit({ isDir: true, name: "Backup", path: "/Volumes/Backup" })).toBe(false);
  });
});
