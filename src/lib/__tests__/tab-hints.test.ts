import { describe, expect, it } from "vitest";
import { tabHints } from "../format";

describe("tabHints", () => {
  it("returns null for unique basenames", () => {
    expect(tabHints(["/a/Week 5", "/a/Week 6", "/b/Notes"])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("disambiguates colliding basenames by parent", () => {
    expect(
      tabHints([
        "/Masters/Semester 1/INFS7410 Information Retrieval/Week 5",
        "/Masters/Semester 1/REIT6811 Research Methods/Week 5",
        "/Masters/100RICOH",
      ]),
    ).toEqual([
      "INFS7410 Information Retrieval",
      "REIT6811 Research Methods",
      null,
    ]);
  });

  it("walks up past identical parents", () => {
    expect(tabHints(["/S1/Course/Week 5", "/S2/Course/Week 5"])).toEqual([
      "S1/Course",
      "S2/Course",
    ]);
  });

  it("uses the shortest suffix per tab in mixed groups", () => {
    expect(
      tabHints(["/p/a/Week 5", "/q/a/Week 5", "/x/b/Week 5"]),
    ).toEqual(["p/a", "q/a", "b"]);
  });

  it("falls back to the shared parent for duplicate paths", () => {
    expect(tabHints(["/a/Week 5", "/a/Week 5"])).toEqual(["a", "a"]);
  });

  it("handles root and shallow paths", () => {
    expect(tabHints(["/", "/"])).toEqual([null, null]);
    expect(tabHints(["/tmp", "/Users/me/tmp"])).toEqual([null, "me"]);
  });
});
